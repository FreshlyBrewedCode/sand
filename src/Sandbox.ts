import { Command, CommandExecutor } from "@effect/platform"
import type { PlatformError } from "@effect/platform/Error"
import { Console, Effect, Layer, Ref, Stream } from "effect"
import * as Bwrap from "./backends/Bubblewrap.js"
import { EmptyCommandError, type BwrapConflict } from "./Errors.js"

export interface ToolBin {
  readonly name: string
  readonly bin: string
}

/** A tool: requirements only. It contributes grains (nix closure binds, CA bundles, ...) and resolves to a name + binary path — it does not declare policy (net, clearenv, $HOME, secrets); that's the composition root's job. */
export type Tool<E, R> = Effect.Effect<ToolBin, E, R>

/** A policy grain contributed by the composition root, not a tool. */
export type Policy<E, R> = Effect.Effect<void, E, R>

export interface SandOptions<ET, PT, R> {
  readonly with: ReadonlyArray<Tool<ET, R>>
  readonly policy?: ReadonlyArray<Policy<PT, R>>
}

export interface ExecOptions {
  readonly stdio?: "inherit" | "pipe"
}

export interface Sand<E, R> {
  /**
   * Accumulates every grain every tool and policy entry contributes and
   * returns a human-readable report — every bind, the net mode, and every
   * env var (redacted only for values declared via `secret()`). This does
   * resolve each tool (`which`/`readlink`/`nix path-info` for a nix-backed
   * tool), it just never spawns `bwrap` itself.
   */
  readonly plan: Effect.Effect<ReadonlyArray<string>, E, R>
  /**
   * Plans, then spawns `bwrap` with `argv[0]` as COMMAND and the rest of
   * `argv` as its arguments — resolved exactly like a normal shell would
   * (PATH lookup happening *inside* the sandbox's own mount namespace, or
   * an absolute path to anything bound there). `argv[0]` is not checked
   * against the tools this sandbox was composed `with`: every tool's `bin`
   * is bound onto a canonical PATH directory as a convenience, but
   * anything else reachable inside the sandbox (via `with` or `policy`)
   * execs just as well. Returns the child's exit code — it never fails the
   * Effect on a non-zero exit, so a sandboxed command exiting 1 is not
   * confused with an internal sandbox error.
   */
  readonly exec: (
    argv: ReadonlyArray<string>,
    options?: ExecOptions,
  ) => Effect.Effect<CommandExecutor.ExitCode, E | EmptyCommandError | PlatformError, R | CommandExecutor.CommandExecutor>
}

const PATH_DIR = "/usr/bin"

/**
 * The composition root: given the tools a sandbox runs `with` and the
 * `policy` grains the root itself contributes, builds a `{ plan, exec }`
 * pair. Each call gets its own `Layer.fresh(Bwrap.Bubblewrap.Default)`, so
 * unlike a shared memoized layer, two `sand()` calls (or two invocations of
 * the same instance's `plan`/`exec`) never share a config `Ref`.
 *
 * Every composed tool's resolved `bin` is also bound read-only onto
 * `/usr/bin/<name>` with `PATH=/usr/bin` set, so `exec` can resolve it by
 * bare name the same way a normal shell would — this is what lets `exec`
 * skip validating `argv[0]` against the tool list entirely.
 */
export const sand = <ET, PT, R>(
  options: SandOptions<ET, PT, R>,
): Sand<ET | PT | BwrapConflict, Exclude<R, Bwrap.Bubblewrap>> => {
  const accumulate: Effect.Effect<
    { readonly tools: ReadonlyArray<ToolBin>; readonly config: Bwrap.BwrapConfig },
    ET | PT | BwrapConflict,
    Exclude<R, Bwrap.Bubblewrap>
  > = Effect.gen(function* () {
    const tools = yield* Effect.forEach(options.with, tool => tool)
    // Every tool's bin is also bound onto a canonical PATH dir so `exec`
    // can resolve it by bare name — same conflict-checked grains as
    // anything else, so two same-named tools with different bins still
    // fail loud instead of silently picking one.
    yield* Effect.forEach(tools, t => Bwrap.roBind(t.bin, `${PATH_DIR}/${t.name}`))
    yield* Bwrap.setenv("PATH", PATH_DIR)
    yield* Effect.forEach(options.policy ?? [], policy => policy)
    const bw = yield* Bwrap.Bubblewrap
    const config = yield* Ref.get(bw.ref)
    return { tools, config }
  }).pipe(Effect.provide(Layer.fresh(Bwrap.Bubblewrap.Default)), Effect.scoped)

  const plan: Sand<ET | PT | BwrapConflict, Exclude<R, Bwrap.Bubblewrap>>["plan"] = Effect.gen(function* () {
    const { tools, config } = yield* accumulate
    const lines = [...tools.map(t => `${t.name}=${t.bin}`), ...Bwrap.describe(config)]
    yield* Effect.forEach(lines, line => Console.log(line))
    return lines
  })

  const exec: Sand<ET | PT | BwrapConflict, Exclude<R, Bwrap.Bubblewrap>>["exec"] = (argv, execOptions) =>
    Effect.gen(function* () {
      const command = argv[0]
      if (command === undefined) {
        return yield* Effect.fail(new EmptyCommandError())
      }
      const rest = argv.slice(1)
      const { config } = yield* accumulate
      const stdio = execOptions?.stdio ?? "inherit"
      const bwrapCommand = Bwrap.toCommand(config, command, rest, stdio)
      const process = yield* Effect.acquireRelease(Command.start(bwrapCommand), p => Effect.ignore(p.kill()))
      // "pipe" mode redirects stdout/stderr into in-memory streams rather
      // than the terminal — if nothing reads them, a child that writes more
      // than the OS pipe buffer blocks in write() and never reaches exit,
      // so exitCode has to be awaited alongside draining both streams, not
      // after them.
      if (stdio === "pipe") {
        const [, , exitCode] = yield* Effect.all(
          [Stream.runDrain(process.stdout), Stream.runDrain(process.stderr), process.exitCode],
          { concurrency: "unbounded" },
        )
        return exitCode
      }
      return yield* process.exitCode
    }).pipe(Effect.scoped)

  return { plan, exec }
}

/**
 * Discharges `instance`'s remaining requirement `R` with `layer`. `layer`
 * may itself have requirements (e.g. `NixStore.Default` needs a
 * `CommandExecutor` to run `which`/`nix path-info`) — those flow through
 * to the result's `R2`, so a `.sand.ts` file can resolve its own domain
 * dependencies (nix, bubblewrap) while still leaving platform-level
 * infrastructure (`CommandExecutor`, supplied by `main.ts` via
 * `BunContext.layer`) for the caller.
 */
export const provide = <E, R, R2 = never>(instance: Sand<E, R>, layer: Layer.Layer<R, never, R2>): Sand<E, R2> => ({
  plan: Effect.provide(instance.plan, layer),
  exec: (argv, options) => Effect.provide(instance.exec(argv, options), layer),
})
