# sand POC v1 — Effect + bubblewrap + gh

## Context

`sand.ts` (v0) is a 318-line effect-system + plugin-bus that **does not sandbox anything**: `LocalPart` calls `Bun.which`, `EnvPart` sets env vars. The abstraction was designed before any backend friction was felt, so it is over-abstracted in the DI direction and under-modelled in the domain direction. Its `Grain` plumbing is also abandoned at the boundary (`provision()` throws raw non-`Error` objects), there is no teardown despite the docblock promising finalizers, and `Object.assign` silently clobbers conflicting env vars.

v1 fixes the root cause by going and *getting* the friction: one real isolation backend (bubblewrap), one real tool (`gh`), and Effect instead of a hand-rolled `Grain`. The goal is not a finished framework — it is to find out which abstractions survive contact with a real backend.

### Design direction (from user, supersedes the earlier capability-IR proposal)

> The framework should only expose what is actually configurable. Bubblewrap would expose config grains that e.g. gh could use. Ideally we would build abstractions (like e.g. a general "host policy") but for now we could keep it simple.

So there is **no universal `Capability` union that backends approximate**. Backends expose typed grains for what they can genuinely configure (`bwrap.net("none" | "shared")`, `bwrap.roBind(...)`); tools compose those. Over-granting is impossible by construction because nothing undeliverable can be declared. This matches `sand.concept.ts` (`nix.package(...)`, `nono.profile(...)`) — grains are backend-namespaced config mutations.

**Explicitly deferred:** the cross-backend capability calculus / "host policy" layer. It cannot be designed honestly against one backend. Revisit when a second backend (nix shell, container, or an egress proxy) exists.

## Feasibility — verified on this machine

| Check | Result |
| --- | --- |
| bwrap userns | ✅ `--unshare-all` and `--unshare-user --unshare-pid` both work (bwrap 0.11.2) |
| Closure-scoped bind | ✅ `gh` 2.98.0 needs **9** store paths / 84 MB, not the whole `/nix/store` |
| Deny-by-default FS | ✅ tmpfs `$HOME` hides real `~/.config/gh` credentials |
| Net enforced | ✅ `--unshare-all` → *"error connecting to api.github.com"*; shared → reaches it |
| TLS on NixOS | ⚠️ `/etc/ssl/certs/ca-certificates.crt` is a **double symlink**; must bind `readlink -f` target or TLS fails |
| Secrets via `--args 0` | ✅ `gh api rate_limit` → `Bad credentials`, and sandboxed `/proc/self/cmdline` shows **no** `--setenv` |

Latest deps: `effect@3.22.1`, `@effect/platform@0.97.1`, `@effect/platform-bun@0.91.2`.

## Prerequisite

No bun/node/npm exists on this NixOS host. Add a `flake.nix` devshell (bun + bubblewrap + gh + nix) and a `.envrc`; all commands run under `nix develop`.

## Layout

```
flake.nix .envrc package.json tsconfig.json
src/
  Errors.ts              Data.TaggedError types
  backends/Bubblewrap.ts service + config Ref + grains + render
  backends/NixStore.ts   closureOf / resolveBin / bindClosure
  tools/Gh.ts            gh composed from bwrap + nix grains
  Sandbox.ts             plan + run (Scope-managed)
  main.ts                CLI: `plan` | `run -- <argv>`
  typelevel.test.ts      @ts-expect-error proof that a missing layer is a compile error
docs/prototype-v0/       sand.ts + sand.concept.ts moved here as reference
```

## Implementation

### 1. `backends/Bubblewrap.ts` — the backend owns its own config

`BwrapConfig` is a plain immutable record mirroring only real bwrap flags: `binds: ReadonlyArray<{mode: "ro"|"rw", src, dest}>`, `tmpfs`, `dirs`, `env: ReadonlyMap<string, Redacted<string>>`, `unshare: {user,pid,ipc,uts,net,cgroup}`, `proc`, `dev`, `chdir`, `clearenv`, `dieWithParent`.

`Bubblewrap` is an `Effect.Service` (scoped) holding a `Ref<BwrapConfig>`. Grains are module-level functions returning `Effect<void, BwrapConflict, Bubblewrap>`:

```
roBind(src, dest = src)   rwBind(...)   tmpfs(dest)   dir(dest)
setenv(name, value)       secret(name, Redacted<string>)
net("none" | "shared")    chdir(dir)    clearenv()
```

Fixes v0's silent-clobber bug: `setenv`/`secret` on an existing name with a different value, or two srcs on one bind dest, fail with `BwrapConflict`. In a security tool, merge conflicts must be loud.

`render(config, argv)` produces the NUL-separated arg buffer. All env — not just secrets — goes through `--args 0` so nothing reaches `ps`. `net("shared")` emits `--unshare-user --unshare-pid --unshare-ipc --unshare-uts`; `net("none")` emits `--unshare-all`.

### 2. `backends/NixStore.ts` — the cross-backend grain

`NixStore` service over `CommandExecutor` (`@effect/platform`'s `Command`, already the idiomatic subprocess API — do not hand-roll `Bun.spawn` here):

- `resolveBin(name)` — `which` + `readlink -f` → `{ bin, storePath }`
- `closureOf(storePath)` — `nix path-info -r`
- `bindClosure(name): Effect<string, NixError | BwrapConflict, NixStore | Bubblewrap>`

`bindClosure` is the payoff demo: its `R` channel names **both** services, so "this tool needs nix and bubblewrap" is a compile-time fact. v0's `MissingPart` runtime error stops existing.

### 3. `tools/Gh.ts` — the tool is a value with typed requirements

```ts
export const gh: Effect<string, GhError, Bubblewrap | NixStore> = Effect.gen(function* () {
  const bin = yield* NixStore.bindClosure("gh")
  yield* Bwrap.dir("/home/sandbox")
  yield* Bwrap.setenv("HOME", "/home/sandbox")   // tmpfs home => host gh creds invisible
  yield* Bwrap.roBind(yield* NixStore.realpath("/etc/ssl/certs/ca-certificates.crt"),
                      "/etc/ssl/certs/ca-certificates.crt")
  yield* Bwrap.roBind("/etc/resolv.conf")
  yield* Bwrap.net("shared")
  yield* Bwrap.secret("GH_TOKEN", yield* Config.redacted("GH_TOKEN"))
  return bin
})
```

The CA-bundle `realpath` step is the NixOS friction found during probing — encode it, don't paper over it.

### 4. `Sandbox.ts` — plan vs run

- `plan(tool)` — run grain accumulation (read-only: `which`, `nix path-info`), render, print a report. Secrets print as `GH_TOKEN=<redacted>` via `Redacted`. **Spawns nothing.**
- `run(tool, argv)` — plan, then `Command.make("bwrap", "--args", "0", program, ...argv)` fed the arg buffer via `Command.feed`, under `Effect.acquireRelease` so interrupt kills the child; `--die-with-parent` as backstop. This is the teardown v0 never had.

Known limitation to document, not hide: `--args 0` consumes stdin, so interactive sandboxes need a real extra FD (raw `Bun.spawn` with `stdio[3]`). Fine for `gh`; blocks an interactive `opencode` shell later.

### 5. Scope discipline

`Bubblewrap` is `scoped`; any temp dir uses `Effect.acquireRelease`. Entry point is `BunRuntime.runMain` with `BunContext.layer`.

### 6. Out of scope for v1

`@effect/cli` (a 20-line arg switch keeps the POC about sandboxing), the plain-Promise facade for non-Effect consumers, seccomp, `--json-status-fd`, and a second backend.

## Verification

Under `nix develop`:

1. `bun src/main.ts plan gh` — prints 9 `--ro-bind` store paths, tmpfs home, `net=shared`, `GH_TOKEN=<redacted>`; spawns nothing.
2. `GH_TOKEN=dummy bun src/main.ts run gh -- api rate_limit` → `Bad credentials` (proves DNS + TLS + egress work).
3. `GH_TOKEN=$(gh auth token) bun src/main.ts run gh -- api rate_limit` → real JSON rate limit.
4. **Negative test:** flip `Gh.ts` to `net("none")` → *"error connecting to api.github.com"*. Proves isolation is real, not decorative.
5. **Credential-isolation test:** unset `GH_TOKEN`, run `-- auth status` → gh reports logged out despite host `~/.config/gh/hosts.yml` existing.
6. **Secret-leak test:** while a sandboxed `gh` runs, confirm `--setenv`/token absent from `/proc/<pid>/cmdline`.
7. **Compile-time test:** `bun x tsc --noEmit` — `typelevel.test.ts` asserts via `@ts-expect-error` that providing only `Bubblewrap.Default` without `NixStore.Default` fails to typecheck.
8. `bun x tsc --noEmit` clean overall.

## Success criteria

The POC succeeds if (4), (5) and (7) hold: the sandbox measurably isolates network and credentials, and a missing backend is a type error rather than a runtime one. If after this the Effect machinery still feels like ceremony over a shell script, that is a real signal — reconsider before adding backend #2.
