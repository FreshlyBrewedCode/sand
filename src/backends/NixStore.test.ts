import { describe, expect, test } from "bun:test"
import { BunContext } from "@effect/platform-bun"
import { Effect, Ref } from "effect"
import { NixError } from "../Errors.js"
import * as Bwrap from "./Bubblewrap.js"
import * as Nix from "./NixStore.js"

const runNix = <A, E>(effect: Effect.Effect<A, E, Nix.NixStore>) =>
  Effect.runPromise(
    Effect.scoped(effect.pipe(Effect.provide(Nix.NixStore.Default), Effect.provide(BunContext.layer))),
  )

const runNixAndBwrap = <A, E>(effect: Effect.Effect<A, E, Nix.NixStore | Bwrap.Bubblewrap>) =>
  Effect.runPromise(
    Effect.scoped(
      effect.pipe(
        Effect.provide(Nix.NixStore.Default),
        Effect.provide(Bwrap.Bubblewrap.Default),
        Effect.provide(BunContext.layer),
      ),
    ),
  )

describe("NixStore (integration, real nix store on this machine)", () => {
  test("resolveBin finds gh under /nix/store", async () => {
    const { bin, storePath } = await runNix(Nix.NixStore.resolveBin("gh"))
    expect(bin).toMatch(/\/bin\/gh$/)
    expect(storePath).toMatch(/^\/nix\/store\/[^/]+-gh-/)
  })

  test("resolveBin fails with NixError for a command that doesn't exist", async () => {
    const failure = runNix(Nix.NixStore.resolveBin("definitely-not-a-real-command-xyz").pipe(Effect.flip))
    const error = await failure
    expect(error).toBeInstanceOf(NixError)
    expect((error as NixError).reason).toBe("NotFound")
  })

  test("closureOf returns the transitive store paths including the input", async () => {
    const { storePath } = await runNix(Nix.NixStore.resolveBin("gh"))
    const closure = await runNix(Nix.NixStore.closureOf(storePath))
    expect(closure).toContain(storePath)
    expect(closure.length).toBeGreaterThan(1)
  })

  test("realpath resolves to an absolute path with no symlink components", async () => {
    const resolved = await runNix(Nix.NixStore.realpath("/etc/resolv.conf"))
    expect(resolved.startsWith("/")).toBe(true)
  })

  test("bindClosure ro-binds every closure member and returns the bin path", async () => {
    const result = await runNixAndBwrap(
      Effect.gen(function* () {
        const bin = yield* Nix.NixStore.bindClosure("gh")
        const bw = yield* Bwrap.Bubblewrap
        const config = yield* Ref.get(bw.ref)
        return { bin, config }
      }),
    )
    expect(result.bin).toMatch(/\/bin\/gh$/)
    expect(result.config.binds.length).toBe(9)
    expect(result.config.binds.every(b => b.mode === "ro")).toBe(true)
  })

  test("bindClosure twice for the same tool is idempotent (no BwrapConflict)", async () => {
    await runNixAndBwrap(
      Effect.gen(function* () {
        yield* Nix.NixStore.bindClosure("gh")
        yield* Nix.NixStore.bindClosure("gh")
      }),
    )
  })
})
