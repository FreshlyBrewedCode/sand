import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Data, Effect } from "effect"
import path from "node:path"
import { pathToFileURL } from "node:url"

// This type is resolved against the repo's own checked-in .sand.ts at
// compile time, but the runtime import below loads whatever .sand.ts
// exists in process.cwd() — normally the same file, but this is decorative
// type safety, not an enforced guarantee: `bun run typecheck` catches a
// bad edit to .sand.ts, running `bun src/main.ts` directly does not.
type ConfiguredSand = (typeof import("../.sand.ts"))["default"]

class UsageError extends Data.TaggedError("UsageError")<{ readonly message: string }> {}
class ConfigLoadError extends Data.TaggedError("ConfigLoadError")<{ readonly path: string; readonly cause: unknown }> {}

const CONFIG_FILE = ".sand.ts"
const usage = `Usage: sand plan | sand exec -- <argv...>\nLooks for a sandbox composition (default export) in ./${CONFIG_FILE}`

/**
 * `main.ts` is pure CLI plumbing now — the composition root moved to
 * `.sand.ts`, which is responsible for resolving all of its own domain
 * requirements (nix, bubblewrap, which tools). All that's left here is
 * argv parsing, loading that file, and platform-level wiring
 * (`BunContext.layer`, `process.exit`).
 */
const loadConfig: Effect.Effect<ConfiguredSand, ConfigLoadError> = Effect.tryPromise({
  try: (): Promise<{ readonly default?: ConfiguredSand }> =>
    import(pathToFileURL(path.join(process.cwd(), CONFIG_FILE)).href),
  catch: cause => new ConfigLoadError({ path: CONFIG_FILE, cause }),
}).pipe(
  Effect.flatMap(module =>
    module.default === undefined
      ? Effect.fail(new ConfigLoadError({ path: CONFIG_FILE, cause: "module has no default export" }))
      : Effect.succeed(module.default),
  ),
)

const main = Effect.gen(function* () {
  const [cmd, ...rest] = process.argv.slice(2)
  const instance = yield* loadConfig

  switch (cmd) {
    case "plan": {
      yield* instance.plan
      return
    }
    case "exec": {
      const dashDash = rest.indexOf("--")
      const argv = dashDash === -1 ? rest : rest.slice(dashDash + 1)
      const exitCode = yield* instance.exec(argv)
      process.exit(Number(exitCode))
      return
    }
    default: {
      return yield* Effect.fail(new UsageError({ message: `Unknown command: ${cmd ?? "(none)"}\n${usage}` }))
    }
  }
})

BunRuntime.runMain(main.pipe(Effect.provide(BunContext.layer)))
