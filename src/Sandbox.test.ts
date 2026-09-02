import { describe, expect, test } from "bun:test"
import { BunContext } from "@effect/platform-bun"
import { Effect, Redacted } from "effect"
import * as Bwrap from "./backends/Bubblewrap.js"
import { NixStore } from "./backends/NixStore.js"
import { BwrapConflict, EmptyCommandError } from "./Errors.js"
import * as Sandbox from "./Sandbox.js"
import { gh } from "./tools/Gh.js"

const fakeTool: Sandbox.Tool<BwrapConflict, Bwrap.Bubblewrap> = Effect.gen(function* () {
  yield* Bwrap.roBind("/etc/resolv.conf")
  yield* Bwrap.secret("TOKEN", Redacted.make("shh-do-not-print-me"))
  return { name: "fake-tool", bin: "/bin/fake-tool" }
})

describe("Sandbox.sand — plan", () => {
  test("reports each tool's bin, binds, net mode, and its PATH wiring, and never prints secret values", async () => {
    const instance = Sandbox.sand({ with: [fakeTool] })
    // No CommandExecutor (or anything besides Bubblewrap, provided
    // internally) is supplied here — if plan's R channel ever regressed to
    // require one, this would fail at runtime with a missing-service
    // defect, not silently pass. That's the real proof `plan` spawns
    // nothing, not a `expect(true).toBe(true)` tautology.
    const lines = await Effect.runPromise(instance.plan)
    const report = lines.join("\n")
    expect(report).toContain("fake-tool=/bin/fake-tool")
    expect(report).toContain("--ro-bind /etc/resolv.conf /etc/resolv.conf")
    expect(report).toContain("--ro-bind /bin/fake-tool /usr/bin/fake-tool")
    expect(report).toContain("PATH=/usr/bin")
    expect(report).toContain("net=none")
    expect(report).toContain("TOKEN=<redacted>")
    expect(report).not.toContain("shh-do-not-print-me")
  })

  test("deny-by-default: a sandbox with no policy renders --unshare-all and --clearenv", async () => {
    const instance = Sandbox.sand({ with: [fakeTool] })
    const lines = await Effect.runPromise(instance.plan)
    expect(lines).toContain("net=none")
    expect(lines).toContain("--clearenv")
  })
})

describe("Sandbox.sand — cross-contamination regression", () => {
  test("two sand() instances in one process have independent configs", async () => {
    const a: Sandbox.Tool<BwrapConflict, Bwrap.Bubblewrap> = Effect.gen(function* () {
      yield* Bwrap.roBind("/etc/only-a")
      yield* Bwrap.net("shared")
      return { name: "a", bin: "/bin/a" }
    })
    const b: Sandbox.Tool<BwrapConflict, Bwrap.Bubblewrap> = Effect.gen(function* () {
      yield* Bwrap.roBind("/etc/only-b")
      return { name: "b", bin: "/bin/b" }
    })

    const instanceA = Sandbox.sand({ with: [a] })
    const instanceB = Sandbox.sand({ with: [b] })

    const linesA = await Effect.runPromise(instanceA.plan)
    const linesB = await Effect.runPromise(instanceB.plan)

    expect(linesA.join("\n")).toContain("/etc/only-a")
    expect(linesA.join("\n")).toContain("net=shared")
    expect(linesB.join("\n")).not.toContain("/etc/only-a")
    expect(linesB.join("\n")).not.toContain("net=shared")
    expect(linesB.join("\n")).toContain("/etc/only-b")
    expect(linesB.join("\n")).toContain("net=none")
  })
})

describe("Sandbox.sand — multi-tool composition", () => {
  test("with: [a, b] resolves both tools' names to their bins, merges their grains, and PATH-binds both", async () => {
    const a: Sandbox.Tool<BwrapConflict, Bwrap.Bubblewrap> = Effect.gen(function* () {
      yield* Bwrap.roBind("/etc/only-a")
      return { name: "a", bin: "/bin/a" }
    })
    const b: Sandbox.Tool<BwrapConflict, Bwrap.Bubblewrap> = Effect.gen(function* () {
      yield* Bwrap.roBind("/etc/only-b")
      return { name: "b", bin: "/bin/b" }
    })

    const instance = Sandbox.sand({ with: [a, b] })
    const report = (await Effect.runPromise(instance.plan)).join("\n")

    expect(report).toContain("a=/bin/a")
    expect(report).toContain("b=/bin/b")
    expect(report).toContain("/etc/only-a")
    expect(report).toContain("/etc/only-b")
    expect(report).toContain("--ro-bind /bin/a /usr/bin/a")
    expect(report).toContain("--ro-bind /bin/b /usr/bin/b")
    expect(report).toContain("PATH=/usr/bin")
  })
})

describe("Sandbox.sand — conflict enforcement", () => {
  test("a tool declaring net(shared) against root policy net(none) raises BwrapConflict", async () => {
    const sneakyTool: Sandbox.Tool<BwrapConflict, Bwrap.Bubblewrap> = Effect.gen(function* () {
      yield* Bwrap.net("shared")
      return { name: "sneaky", bin: "/bin/sneaky" }
    })
    const instance = Sandbox.sand({ with: [sneakyTool], policy: [Bwrap.net("none")] })
    const failure = Effect.runPromise(instance.plan.pipe(Effect.flip))
    const error = await failure
    expect(error).toBeInstanceOf(BwrapConflict)
    expect((error as BwrapConflict).kind).toBe("net")
  })

  test("two tools with the same name but different bins raise BwrapConflict on their PATH bind, not a silent pick", async () => {
    const a: Sandbox.Tool<BwrapConflict, Bwrap.Bubblewrap> = Effect.gen(function* () {
      return { name: "dup", bin: "/bin/a" }
    })
    const b: Sandbox.Tool<BwrapConflict, Bwrap.Bubblewrap> = Effect.gen(function* () {
      return { name: "dup", bin: "/bin/b" }
    })
    const instance = Sandbox.sand({ with: [a, b] })
    const failure = Effect.runPromise(instance.plan.pipe(Effect.flip))
    const error = await failure
    expect(error).toBeInstanceOf(BwrapConflict)
    expect((error as BwrapConflict).kind).toBe("bind")
    expect((error as BwrapConflict).key).toBe("/usr/bin/dup")
  })
})

describe("Sandbox.sand — exec requires a non-empty command", () => {
  test("exec([]) fails with EmptyCommandError instead of spawning bwrap with an empty COMMAND", async () => {
    const instance = Sandbox.sand({ with: [fakeTool] })
    const failure = Effect.runPromise(
      instance.exec([]).pipe(Effect.provide(BunContext.layer), Effect.flip),
    )
    const error = await failure
    expect(error).toBeInstanceOf(EmptyCommandError)
  })
})

describe("Sandbox.sand — exec is not checked against known tools", () => {
  test("an absolute path bound only via policy (never declared `with`) still execs", async () => {
    const bashBin = await Effect.runPromise(
      NixStore.resolveBin("bash").pipe(Effect.provide(NixStore.Default), Effect.provide(BunContext.layer)),
    )
    const instance = Sandbox.sand({ with: [], policy: [NixStore.bindClosure("bash")] })
    const exitCode = await Effect.runPromise(
      instance.exec([bashBin.bin, "--version"], { stdio: "pipe" }).pipe(
        Effect.provide(NixStore.Default),
        Effect.provide(BunContext.layer),
      ),
    )
    expect(Number(exitCode)).toBe(0)
  })
})

describe("Sandbox.sand — exec (integration, spawns real bwrap via gh)", () => {
  const runGh = (argv: ReadonlyArray<string>) =>
    Effect.runPromise(
      Sandbox.sand({
        with: [gh()],
        policy: [Bwrap.net("shared"), Bwrap.tmpfs("/home/sandbox"), Bwrap.setenv("HOME", "/home/sandbox")],
      })
        .exec(argv, { stdio: "pipe" })
        .pipe(Effect.provide(NixStore.Default), Effect.provide(BunContext.layer)),
    )

  test("bare 'gh' resolves via PATH alone (argv[0] is not looked up against declared tool names) and exits 0", async () => {
    const exitCode = await runGh(["gh", "--version"])
    expect(Number(exitCode)).toBe(0)
  })

  test("an invalid gh subcommand exits non-zero inside the sandbox without failing the Effect", async () => {
    const exitCode = await runGh(["gh", "not-a-real-subcommand"])
    expect(Number(exitCode)).not.toBe(0)
  })
})
