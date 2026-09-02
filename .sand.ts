import { Config, Effect, Option } from "effect"
import * as Bwrap from "./src/backends/Bubblewrap.js"
import { NixStore } from "./src/backends/NixStore.js"
import * as Sandbox from "./src/Sandbox.js"
import { gh } from "./src/tools/Gh.js"

/**
 * The default sandbox composition `main.ts` loads: `gh`, network-enabled,
 * with an isolated $HOME and `GH_TOKEN` forwarded as a secret when present.
 * Edit this file directly to change what `sand plan`/`sand exec` run
 * against — this is the composition root now, not `main.ts`.
 */
const tokenPolicy = Effect.gen(function* () {
  const token = yield* Config.option(Config.redacted("GH_TOKEN"))
  if (Option.isSome(token)) yield* Bwrap.secret("GH_TOKEN", token.value)
})

export default Sandbox.provide(
  Sandbox.sand({
    with: [gh()],
    policy: [Bwrap.net("shared"), Bwrap.tmpfs("/home/sandbox"), Bwrap.setenv("HOME", "/home/sandbox"), tokenPolicy],
  }),
  NixStore.Default,
)
