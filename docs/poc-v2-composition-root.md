# sand — composition root + safe defaults (pre-backend-2)

## Context

The v1 POC works: `bun test` is 28/0, typecheck clean, and it measurably isolates network and credentials. But review found the composition root missing — all policy is baked into `src/tools/Gh.ts`, which is not cosmetic. Three verified bugs fall out of it:

1. **Config is process-global.** `Bubblewrap.Default` is a memoized layer, so its `Ref` is shared. Running tool A then tool B in one process: B inherited A's binds and flipped A's `net("none")` to shared, with no error.
2. **Isolation defaults to off.** A tool that never calls `net()` renders zero `--unshare-*` flags — forgetting a grain fails *open*.
3. **Policy fields clobber silently.** `bind`/`setenv` raise `BwrapConflict`; `net`/`chdir`/`clearenv`/`tmpfs`/`dir` do not — i.e. the fix landed on the non-security-relevant half.

Plus: `Sandbox.plan`'s docstring claims it spawns nothing (false — it runs `which`/`readlink`/`nix path-info`), `Sandbox.test.ts:30-35` is a tautology asserting that false property, `describe()` redacts non-secrets so `plan` prints `HOME=<redacted>`, and a non-zero child exit is reported as an internal Effect error with a stack trace.

Goal: make the sandbox composable and safe-by-default, so backend #2 can be designed against working code rather than guessed at.

### Decisions taken

- **Policy stays as grains** (user's call, over a separate policy-config object). One uniform mechanism. Reconciliation with the composition root: *tools stop emitting policy grains; the root emits them.* Conflict detection then **enforces** that discipline instead of relying on convention — a tool that sneaks in `net("shared")` against a root `net("none")` fails loud.
- **No `Backend` interface yet.** v0 abstracted against zero backends and produced an unusable bus. Blast radius today is 4 call sites in a 53-line file; extract when backend #2 lands.
- **`plan` gets an honest docstring**, not a declaration/resolution split (that would reintroduce v0's IR against a single backend).

### Verified on hardware during planning

| Design assumption | Evidence |
| --- | --- |
| `--unshare-all` = deny-by-default | `gh api` → *"error connecting to api.github.com"* |
| `--unshare-all --share-net` opens net | `gh api` → `Bad credentials` (TLS + DNS OK) |
| Workspace rw bind round-trips | sandbox wrote `out.txt`; host read `written-by-sandbox` |
| Deny-by-default is real | `cat: command not found` inside — only gh's closure bound |
| `--clearenv` must precede `--setenv` | out-of-order probe wiped `GH_TOKEN`; `render` already orders correctly (`Bubblewrap.ts:155-169`) — needs a regression test |
| `Layer.fresh` exists | `effect@3.22.1` `Layer.d.ts` |

## Work

### 1. `Bubblewrap.ts` — declared-vs-default config

Split "not declared" from "declared as X" so deny-by-default doesn't manufacture false conflicts. Policy fields become `| undefined` (matches the existing `chdir: string | undefined`; `exactOptionalPropertyTypes` is on):

```ts
net: "none" | "shared" | undefined      // undeclared → renders as none
clearenv: boolean | undefined           // undeclared → renders as true
chdir: string | undefined
```

**Delete `BwrapUnshare` entirely.** `net()` is currently a god-grain setting user/pid/ipc/uts/cgroup as a side effect. Replace with bwrap's own idiom: `render` always emits `--unshare-all`, and adds `--share-net` only when `net === "shared"`. `net()` then controls only the network, as its name claims.

Extend conflict detection to `net`, `chdir`, `clearenv`, and to **tmpfs/dir vs bind on the same destination** (currently `tmpfs("/home/sandbox")` and a bind to the same path silently coexist). Keep the existing rule from `Bubblewrap.ts:65-67`: re-declaring an *identical* value is a no-op, only disagreement is an error.

Track secret provenance so `describe()` stops flattening it: store `{ value: Redacted, secret: boolean }` per env entry, redact only `secret()` values, print `setenv` values plainly.

Add `toCommand(config, bin, argv)` here — moves the literal `"bwrap"`, `"--args"`, `"0"` and `Command.feed(render(...))` out of `Sandbox.ts:45-50`. Cohesion, not abstraction; it also makes `Sandbox.run` backend-agnostic incidentally.

Add a `workspace(hostPath)` grain = `rwBind(hostPath, "/workspace")` + `chdir("/workspace")`, reusing the existing `rwBind`/`chdir`.

### 2. `Sandbox.ts` — the composition root

```ts
export interface ToolBin { readonly name: string; readonly bin: string }
export type Tool<E, R> = Effect.Effect<ToolBin, E, R>

sand({
  with:   [gh()],                                        // tools: requirements only
  policy: [Bwrap.net("shared"), Bwrap.workspace(cwd)],   // policy grains, one writer
})
```

Returns `{ plan, run }`. Internally provides `Layer.fresh(Bubblewrap.Default)` so **each sandbox gets its own `Ref`** — fixes the cross-contamination directly.

Tools return `{ name, bin }` rather than a bare `string`, so the sandbox builds a name→bin map and `run(["gh", "api", ...])` resolves `argv[0]`. This removes `main.ts`'s hardcoded `const tools = { gh }` and makes multi-tool sandboxes work.

`run` returns the child's exit code instead of failing the Effect on non-zero.

### 3. `tools/Gh.ts` — requirements only

Drop `net()`, `clearenv()`, `tmpfs("/home/sandbox")`, and the ambient `Config.redacted("GH_TOKEN")` read. Keep `bindClosure`, the CA-bundle `realpath` bind, and `/etc/resolv.conf`. `$HOME` and the token move to the root's policy. Update the docstring — its current explanation of why `clearenv` lives here becomes wrong.

### 4. Correctness fixes

- `Sandbox.ts:16-21` — docstring states plainly that `plan` resolves (spawning `which`/`readlink`/`nix path-info`) but never spawns bwrap.
- Delete `Sandbox.test.ts:30-35` (tautology asserting the false property).
- `main.ts` — `Data.TaggedError` instead of `new Error` (`:16`, `:30`, `:35`); `process.exit(code)` for child exit codes.
- Integration tests capture stdout instead of `inherit`, so gh's help text stops flooding test output.

## Verification

Under `nix develop`:

1. `bun test` + `bun run typecheck` clean.
2. **Regression test for the two bugs that motivated this**, both currently failing:
   - two sandboxes in one process have independent configs (no bind/policy bleed)
   - a tool declaring `net("shared")` against a root `net("none")` raises `BwrapConflict` rather than silently winning
3. **Deny-by-default unit test:** a config with no policy grains renders `--unshare-all` and `--clearenv`.
4. **Ordering regression test:** `render` emits `--clearenv` before any `--setenv`.
5. `sand plan gh` prints the 9 closure paths, `net=none` when unset, and `HOME=/home/sandbox` in the clear while `GH_TOKEN` stays `<redacted>`.
6. `GH_TOKEN=dummy … run gh -- api rate_limit` → `Bad credentials`; with root policy `net("none")` → *"error connecting"*; both without editing `Gh.ts`.
7. Credential isolation still holds: no token → *"not logged into any GitHub hosts"*, exiting 1 cleanly with no Effect stack trace.
8. Workspace: `run` with `workspace(tmpdir)` writes a file the host can read.

## Deferred

`Backend` interface and backend #2 (extract when a second implementation exists — a no-isolation `host` backend is the cheap probe). Interactive stdin: `bun.d.ts:7128-7138` confirms `stdio` accepts fds ≥ 3, so `--args 3` via `Bun.spawn` is viable and would free stdin for interactive agents — deferred because it trades Effect's `Command` for raw `Bun.spawn` on the bwrap path.
