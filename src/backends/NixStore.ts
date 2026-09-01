import { Command, CommandExecutor } from "@effect/platform"
import { Effect } from "effect"
import { BwrapConflict, NixError } from "../Errors.js"
import * as Bwrap from "./Bubblewrap.js"

export class NixStore extends Effect.Service<NixStore>()("NixStore", {
  accessors: true,
  effect: Effect.gen(function* () {
    const executor = yield* CommandExecutor.CommandExecutor

    const run = (cmd: Command.Command): Effect.Effect<string, NixError> =>
      Command.string(cmd).pipe(
        Effect.provideService(CommandExecutor.CommandExecutor, executor),
        Effect.map(out => out.trim()),
        Effect.mapError(cause => new NixError({ reason: "CommandFailed", detail: String(cause) })),
      )

    const realpath = (path: string): Effect.Effect<string, NixError> =>
      run(Command.make("readlink", "-f", path)).pipe(
        Effect.flatMap(out =>
          out.length === 0
            ? Effect.fail(new NixError({ reason: "NotFound", detail: path }))
            : Effect.succeed(out),
        ),
      )

    const resolveBin = (
      name: string,
    ): Effect.Effect<{ readonly bin: string; readonly storePath: string }, NixError> =>
      Effect.gen(function* () {
        const which = yield* run(Command.make("which", name))
        if (which.length === 0) {
          return yield* Effect.fail(new NixError({ reason: "NotFound", detail: name }))
        }
        const bin = yield* realpath(which)
        const match = bin.match(/^(\/nix\/store\/[^/]+)/)
        if (match === null || match[1] === undefined) {
          return yield* Effect.fail(new NixError({ reason: "NotFound", detail: bin }))
        }
        return { bin, storePath: match[1] }
      })

    const closureOf = (storePath: string): Effect.Effect<ReadonlyArray<string>, NixError> =>
      run(Command.make("nix", "path-info", "-r", storePath)).pipe(
        Effect.map(out => out.split("\n").filter(line => line.length > 0)),
      )

    const bindClosure = (name: string): Effect.Effect<string, NixError | BwrapConflict, Bwrap.Bubblewrap> =>
      Effect.gen(function* () {
        const { bin, storePath } = yield* resolveBin(name)
        const closure = yield* closureOf(storePath)
        for (const path of closure) {
          yield* Bwrap.roBind(path)
        }
        return bin
      })

    return { realpath, resolveBin, closureOf, bindClosure } as const
  }),
}) {}
