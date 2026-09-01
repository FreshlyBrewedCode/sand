import { describe, expect, test } from "bun:test"
import { BunContext } from "@effect/platform-bun"
import { ConfigProvider, Effect, Ref } from "effect"
import * as Bwrap from "../backends/Bubblewrap.js"
import { NixStore } from "../backends/NixStore.js"
import { gh } from "./Gh.js"

const runGh = (env: ReadonlyArray<readonly [string, string]>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const bin = yield* gh
      const bw = yield* Bwrap.Bubblewrap
      const config = yield* Ref.get(bw.ref)
      return { bin, config }
    }),
  ).pipe(
    Effect.provide(NixStore.Default),
    Effect.provide(Bwrap.Bubblewrap.Default),
    Effect.provide(BunContext.layer),
    Effect.withConfigProvider(ConfigProvider.fromMap(new Map(env))),
    Effect.runPromise,
  )

describe("tools/Gh", () => {
  test("composes a plan that isolates net=shared, a tmpfs $HOME, the CA bundle, and the nix closure", async () => {
    const { bin, config } = await runGh([["GH_TOKEN", "dummy-token"]])

    expect(bin).toMatch(/\/bin\/gh$/)
    expect(config.tmpfs).toContain("/home/sandbox")
    expect(config.unshare.net).toBe(false)
    expect(config.unshare.user).toBe(true)
    expect(config.clearenv).toBe(true)

    expect(config.env.has("HOME")).toBe(true)
    expect(config.env.has("GH_TOKEN")).toBe(true)

    expect(config.binds.some(b => b.dest === "/etc/resolv.conf")).toBe(true)
    expect(config.binds.some(b => b.dest === "/etc/ssl/certs/ca-certificates.crt")).toBe(true)
    expect(config.binds.length).toBeGreaterThanOrEqual(9 + 2)
  })

  test("composes successfully without GH_TOKEN — no secret is set, for credential-isolation testing", async () => {
    const { bin, config } = await runGh([])

    expect(bin).toMatch(/\/bin\/gh$/)
    expect(config.env.has("HOME")).toBe(true)
    expect(config.env.has("GH_TOKEN")).toBe(false)
  })
})
