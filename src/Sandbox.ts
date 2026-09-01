import { Command, CommandExecutor } from "@effect/platform"
import type { PlatformError } from "@effect/platform/Error"
import { Console, Effect, Ref } from "effect"
import * as Bwrap from "./backends/Bubblewrap.js"

const accumulate = <E, R>(
  tool: Effect.Effect<string, E, Bwrap.Bubblewrap | R>,
): Effect.Effect<{ readonly bin: string; readonly config: Bwrap.BwrapConfig }, E, Bwrap.Bubblewrap | R> =>
  Effect.gen(function* () {
    const bin = yield* tool
    const bw = yield* Bwrap.Bubblewrap
    const config = yield* Ref.get(bw.ref)
    return { bin, config }
  })

/**
 * Accumulates every grain a tool contributes and prints a human-readable
 * report — every bind, the net mode, and every env var name with its value
 * redacted. Spawns nothing: no `CommandExecutor` is in the requirement
 * channel, so a `plan` call cannot execute a process even by accident.
 */
export const plan = <E, R>(
  tool: Effect.Effect<string, E, Bwrap.Bubblewrap | R>,
): Effect.Effect<ReadonlyArray<string>, E, Bwrap.Bubblewrap | R> =>
  Effect.gen(function* () {
    const { bin, config } = yield* accumulate(tool)
    const lines = [`bin: ${bin}`, ...Bwrap.describe(config)]
    yield* Effect.forEach(lines, line => Console.log(line))
    return lines
  })

/**
 * Plans, then actually spawns `bwrap`. The full option buffer — including
 * every `--setenv` value — is fed through `--args 0` (stdin) rather than
 * argv, so none of it is ever visible in `/proc/<pid>/cmdline`. Known
 * limitation: this consumes stdin, so an interactive sandboxed program
 * (e.g. a shell) cannot use this path.
 */
export const run = <E, R>(
  tool: Effect.Effect<string, E, Bwrap.Bubblewrap | R>,
  argv: ReadonlyArray<string>,
): Effect.Effect<CommandExecutor.ExitCode, E | PlatformError, Bwrap.Bubblewrap | R | CommandExecutor.CommandExecutor> =>
  Effect.gen(function* () {
    const { bin, config } = yield* accumulate(tool)
    const buffer = Bwrap.render(config)
    const command = Command.make("bwrap", "--args", "0", bin, ...argv).pipe(
      Command.feed(buffer),
      Command.stdout("inherit"),
      Command.stderr("inherit"),
    )
    const process = yield* Effect.acquireRelease(Command.start(command), p => Effect.ignore(p.kill()))
    return yield* process.exitCode
  }).pipe(Effect.scoped)
