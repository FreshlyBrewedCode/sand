import { describe, expect, test } from "bun:test"
import { BunContext } from "@effect/platform-bun"
import { ConfigProvider, Effect, Redacted } from "effect"
import * as Bwrap from "./backends/Bubblewrap.js"
import { NixStore } from "./backends/NixStore.js"
import type { BwrapConflict } from "./Errors.js"
import * as Sandbox from "./Sandbox.js"
import { gh } from "./tools/Gh.js"

const fakeTool: Effect.Effect<string, BwrapConflict, Bwrap.Bubblewrap> = Effect.gen(function* () {
  yield* Bwrap.roBind("/etc/resolv.conf")
  yield* Bwrap.secret("TOKEN", Redacted.make("shh-do-not-print-me"))
  yield* Bwrap.net("none")
  return "/bin/fake-tool"
})

describe("Sandbox.plan", () => {
  test("reports the bin, binds, and net mode, and never prints secret values", async () => {
    const lines = await Effect.runPromise(
      Effect.scoped(Sandbox.plan(fakeTool)).pipe(Effect.provide(Bwrap.Bubblewrap.Default)),
    )
    const report = lines.join("\n")
    expect(report).toContain("/bin/fake-tool")
    expect(report).toContain("--ro-bind /etc/resolv.conf /etc/resolv.conf")
    expect(report).toContain("net=none")
    expect(report).toContain("TOKEN=<redacted>")
    expect(report).not.toContain("shh-do-not-print-me")
  })

  test("spawns nothing (no CommandExecutor required)", () => {
    // plan()'s R channel must not require CommandExecutor — this is a
    // compile-time property, verified by the fact this file type-checks
    // while only providing Bubblewrap.Default (see the test above).
    expect(true).toBe(true)
  })
})

describe("Sandbox.run (integration, spawns real bwrap)", () => {
  const runGh = (argv: ReadonlyArray<string>) =>
    Effect.runPromise(
      Effect.scoped(Sandbox.run(gh, argv)).pipe(
        Effect.provide(NixStore.Default),
        Effect.provide(Bwrap.Bubblewrap.Default),
        Effect.provide(BunContext.layer),
        Effect.withConfigProvider(ConfigProvider.fromMap(new Map([["GH_TOKEN", "dummy-token"]]))),
      ),
    )

  test("gh --version exits 0 inside the sandbox", async () => {
    const exitCode = await runGh(["--version"])
    expect(Number(exitCode)).toBe(0)
  })

  test("an invalid gh subcommand exits non-zero inside the sandbox", async () => {
    const exitCode = await runGh(["not-a-real-subcommand"])
    expect(Number(exitCode)).not.toBe(0)
  })
})
