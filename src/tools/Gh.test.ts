import { describe, expect, test } from "bun:test"
import { Command } from "@effect/platform"
import { BunContext } from "@effect/platform-bun"
import { Chunk, Effect, Redacted, Ref, Stream } from "effect"
import * as Bwrap from "../backends/Bubblewrap.js"
import { NixStore } from "../backends/NixStore.js"
import type { BwrapConflict } from "../Errors.js"
import { gh } from "./Gh.js"

const runGh = () =>
  Effect.scoped(
    Effect.gen(function* () {
      const toolBin = yield* gh()
      const bw = yield* Bwrap.Bubblewrap
      const config = yield* Ref.get(bw.ref)
      return { toolBin, config }
    }),
  ).pipe(
    Effect.provide(NixStore.Default),
    Effect.provide(Bwrap.Bubblewrap.Default),
    Effect.provide(BunContext.layer),
    Effect.runPromise,
  )

describe("tools/Gh", () => {
  test("composes only its own requirements: the nix closure, the CA bundle, and resolv.conf", async () => {
    const { toolBin, config } = await runGh()

    expect(toolBin.name).toBe("gh")
    expect(toolBin.bin).toMatch(/\/bin\/gh$/)

    expect(config.binds.some(b => b.dest === "/etc/resolv.conf")).toBe(true)
    expect(config.binds.some(b => b.dest === "/etc/ssl/certs/ca-certificates.crt")).toBe(true)
    expect(config.binds.length).toBeGreaterThanOrEqual(9 + 2)
  })

  test("declares no policy grains of its own — net, clearenv, tmpfs, and env are left for the root", async () => {
    const { config } = await runGh()

    expect(config.net).toBeUndefined()
    expect(config.clearenv).toBeUndefined()
    expect(config.tmpfs).toEqual([])
    expect(config.env.size).toBe(0)
  })
})

const decoder = new TextDecoder()

/** Spawns the composed gh command directly (bypassing Sandbox.sand's exec) so the test can inspect combined stdout+stderr text — proof that flipping root *policy* alone changes gh's observed behavior, without touching Gh.ts. */
const runGhCaptured = (policy: ReadonlyArray<Effect.Effect<void, BwrapConflict, Bwrap.Bubblewrap>>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const toolBin = yield* gh()
      yield* Effect.forEach(policy, p => p)
      const bw = yield* Bwrap.Bubblewrap
      const config = yield* Ref.get(bw.ref)
      const command = Bwrap.toCommand(config, toolBin.bin, ["api", "rate_limit"], "pipe")
      const process = yield* Command.start(command)
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [Stream.runCollect(process.stdout), Stream.runCollect(process.stderr), process.exitCode],
        { concurrency: "unbounded" },
      )
      const text = [...Chunk.toReadonlyArray(stdout), ...Chunk.toReadonlyArray(stderr)]
        .map(bytes => decoder.decode(bytes))
        .join("")
      return { text, exitCode }
    }),
  ).pipe(
    Effect.provide(NixStore.Default),
    Effect.provide(Bwrap.Bubblewrap.Default),
    Effect.provide(BunContext.layer),
    Effect.runPromise,
  )

describe("tools/Gh — root policy controls isolation, not the tool (doc verification item 6)", () => {
  test("net(shared) reaches the network — Bad credentials, not a connection error", async () => {
    const { text } = await runGhCaptured([
      Bwrap.net("shared"),
      Bwrap.tmpfs("/home/sandbox"),
      Bwrap.setenv("HOME", "/home/sandbox"),
      Bwrap.secret("GH_TOKEN", Redacted.make("dummy-token")),
    ])
    expect(text).toContain("Bad credentials")
  })

  test("net(none) blocks the network entirely — a connection error, not an auth error", async () => {
    const { text } = await runGhCaptured([
      Bwrap.net("none"),
      Bwrap.tmpfs("/home/sandbox"),
      Bwrap.setenv("HOME", "/home/sandbox"),
      Bwrap.secret("GH_TOKEN", Redacted.make("dummy-token")),
    ])
    expect(text.toLowerCase()).toContain("error connecting")
    expect(text).not.toContain("Bad credentials")
  })
})
