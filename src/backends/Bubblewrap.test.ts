import { describe, expect, test } from "bun:test"
import { Effect, Redacted, Ref } from "effect"
import { BwrapConflict } from "../Errors.js"
import * as Bwrap from "./Bubblewrap.js"

const run = <A, E>(effect: Effect.Effect<A, E, Bwrap.Bubblewrap>) =>
  Effect.runPromise(Effect.scoped(Effect.provide(effect, Bwrap.Bubblewrap.Default)))

const configOf = <E>(effect: Effect.Effect<void, E, Bwrap.Bubblewrap>) =>
  run(
    Effect.gen(function* () {
      yield* effect
      const bw = yield* Bwrap.Bubblewrap
      return yield* Ref.get(bw.ref)
    }),
  )

describe("Bubblewrap grains", () => {
  test("roBind adds a read-only bind and renders --ro-bind", async () => {
    const config = await configOf(Bwrap.roBind("/nix/store/foo", "/nix/store/foo"))
    const buf = Bwrap.render(config)
    expect(buf.split("\0")).toContain("--ro-bind")
    const parts = buf.split("\0")
    const i = parts.indexOf("--ro-bind")
    expect(parts[i + 1]).toBe("/nix/store/foo")
    expect(parts[i + 2]).toBe("/nix/store/foo")
  })

  test("roBind defaults dest to src", async () => {
    const config = await configOf(Bwrap.roBind("/etc/resolv.conf"))
    expect(config.binds).toEqual([{ mode: "ro", src: "/etc/resolv.conf", dest: "/etc/resolv.conf" }])
  })

  test("rwBind renders --bind", async () => {
    const config = await configOf(Bwrap.rwBind("/tmp/x", "/tmp/x"))
    const buf = Bwrap.render(config)
    expect(buf.split("\0")).toContain("--bind")
    expect(buf.split("\0")).not.toContain("--ro-bind")
  })

  test("binding the same src+dest twice is idempotent", async () => {
    const config = await configOf(
      Effect.gen(function* () {
        yield* Bwrap.roBind("/a", "/b")
        yield* Bwrap.roBind("/a", "/b")
      }),
    )
    expect(config.binds).toHaveLength(1)
  })

  test("two different srcs to the same bind dest fail with BwrapConflict", async () => {
    const failure = run(
      Effect.gen(function* () {
        yield* Bwrap.roBind("/a", "/dest")
        yield* Bwrap.roBind("/other", "/dest")
      }).pipe(Effect.flip),
    )
    const error = await failure
    expect(error).toBeInstanceOf(BwrapConflict)
    expect((error as BwrapConflict).kind).toBe("bind")
    expect((error as BwrapConflict).key).toBe("/dest")
  })

  test("tmpfs on a destination already bound fails with BwrapConflict", async () => {
    const failure = run(
      Effect.gen(function* () {
        yield* Bwrap.roBind("/a", "/dest")
        yield* Bwrap.tmpfs("/dest")
      }).pipe(Effect.flip),
    )
    const error = await failure
    expect(error).toBeInstanceOf(BwrapConflict)
    expect((error as BwrapConflict).kind).toBe("bind")
    expect((error as BwrapConflict).key).toBe("/dest")
  })

  test("bind on a destination already tmpfs fails with BwrapConflict", async () => {
    const failure = run(
      Effect.gen(function* () {
        yield* Bwrap.tmpfs("/dest")
        yield* Bwrap.roBind("/a", "/dest")
      }).pipe(Effect.flip),
    )
    const error = await failure
    expect(error).toBeInstanceOf(BwrapConflict)
    expect((error as BwrapConflict).kind).toBe("bind")
  })

  test("dir on a destination already bound fails with BwrapConflict", async () => {
    const failure = run(
      Effect.gen(function* () {
        yield* Bwrap.roBind("/a", "/dest")
        yield* Bwrap.dir("/dest")
      }).pipe(Effect.flip),
    )
    const error = await failure
    expect(error).toBeInstanceOf(BwrapConflict)
    expect((error as BwrapConflict).kind).toBe("bind")
  })

  test("setenv twice with the same value is idempotent", async () => {
    const config = await configOf(
      Effect.gen(function* () {
        yield* Bwrap.setenv("HOME", "/home/sandbox")
        yield* Bwrap.setenv("HOME", "/home/sandbox")
      }),
    )
    expect(config.env.size).toBe(1)
  })

  test("setenv twice with different values fails with BwrapConflict and does not leak the values", async () => {
    const failure = run(
      Effect.gen(function* () {
        yield* Bwrap.setenv("HOME", "/home/sandbox")
        yield* Bwrap.setenv("HOME", "/home/other")
      }).pipe(Effect.flip),
    )
    const error = await failure
    expect(error).toBeInstanceOf(BwrapConflict)
    const conflict = error as BwrapConflict
    expect(conflict.kind).toBe("env")
    expect(conflict.key).toBe("HOME")
    expect(conflict.existing).toBe("<redacted>")
    expect(conflict.incoming).toBe("<redacted>")
  })

  test("secret conflicting with setenv on the same name fails loud", async () => {
    const failure = run(
      Effect.gen(function* () {
        yield* Bwrap.setenv("GH_TOKEN", "one")
        yield* Bwrap.secret("GH_TOKEN", Redacted.make("two"))
      }).pipe(Effect.flip),
    )
    const error = await failure
    expect(error).toBeInstanceOf(BwrapConflict)
  })

  test("render puts the real secret value in the arg buffer for bwrap to consume", async () => {
    const config = await configOf(Bwrap.secret("GH_TOKEN", Redacted.make("s3cr3t")))
    const buf = Bwrap.render(config)
    const parts = buf.split("\0")
    const i = parts.indexOf("--setenv")
    expect(parts[i + 1]).toBe("GH_TOKEN")
    expect(parts[i + 2]).toBe("s3cr3t")
  })

  test("describe() prints setenv values in the clear but redacts secret() values", async () => {
    const config = await configOf(
      Effect.gen(function* () {
        yield* Bwrap.setenv("HOME", "/home/sandbox")
        yield* Bwrap.secret("GH_TOKEN", Redacted.make("s3cr3t"))
      }),
    )
    const lines = Bwrap.describe(config)
    expect(lines).toContain("HOME=/home/sandbox")
    expect(lines).toContain("GH_TOKEN=<redacted>")
    expect(lines.join("\n")).not.toContain("s3cr3t")
  })

  test("net is undeclared by default and renders as deny-by-default (--unshare-all, no --share-net)", async () => {
    const config = await configOf(Bwrap.roBind("/a"))
    expect(config.net).toBeUndefined()
    const buf = Bwrap.render(config)
    const parts = buf.split("\0")
    expect(parts).toContain("--unshare-all")
    expect(parts).not.toContain("--share-net")
  })

  test('net("none") renders --unshare-all with no --share-net', async () => {
    const config = await configOf(Bwrap.net("none"))
    const buf = Bwrap.render(config)
    const parts = buf.split("\0")
    expect(parts).toContain("--unshare-all")
    expect(parts).not.toContain("--share-net")
  })

  test('net("shared") renders --unshare-all plus --share-net', async () => {
    const config = await configOf(Bwrap.net("shared"))
    const buf = Bwrap.render(config)
    const parts = buf.split("\0")
    expect(parts).toContain("--unshare-all")
    expect(parts).toContain("--share-net")
  })

  test('net("shared") then net("shared") again is idempotent', async () => {
    const config = await configOf(
      Effect.gen(function* () {
        yield* Bwrap.net("shared")
        yield* Bwrap.net("shared")
      }),
    )
    expect(config.net).toBe("shared")
  })

  test('net("shared") then net("none") fails with BwrapConflict', async () => {
    const failure = run(
      Effect.gen(function* () {
        yield* Bwrap.net("shared")
        yield* Bwrap.net("none")
      }).pipe(Effect.flip),
    )
    const error = await failure
    expect(error).toBeInstanceOf(BwrapConflict)
    expect((error as BwrapConflict).kind).toBe("net")
  })

  test("describe() reports net=none when undeclared", async () => {
    const config = await configOf(Bwrap.roBind("/a"))
    expect(Bwrap.describe(config)).toContain("net=none")
  })

  test("tmpfs and dir grains are idempotent", async () => {
    const config = await configOf(
      Effect.gen(function* () {
        yield* Bwrap.tmpfs("/home/sandbox")
        yield* Bwrap.tmpfs("/home/sandbox")
        yield* Bwrap.dir("/home/sandbox/x")
        yield* Bwrap.dir("/home/sandbox/x")
      }),
    )
    expect(config.tmpfs).toEqual(["/home/sandbox"])
    expect(config.dirs).toEqual(["/home/sandbox/x"])
  })

  test("chdir is undeclared by default", async () => {
    const config = await configOf(Bwrap.roBind("/a"))
    expect(config.chdir).toBeUndefined()
  })

  test("chdir twice with the same value is idempotent", async () => {
    const config = await configOf(
      Effect.gen(function* () {
        yield* Bwrap.chdir("/home/sandbox")
        yield* Bwrap.chdir("/home/sandbox")
      }),
    )
    expect(config.chdir).toBe("/home/sandbox")
  })

  test("chdir twice with different values fails with BwrapConflict", async () => {
    const failure = run(
      Effect.gen(function* () {
        yield* Bwrap.chdir("/home/sandbox")
        yield* Bwrap.chdir("/workspace")
      }).pipe(Effect.flip),
    )
    const error = await failure
    expect(error).toBeInstanceOf(BwrapConflict)
    expect((error as BwrapConflict).kind).toBe("chdir")
  })

  test("clearenv is undeclared by default but renders --clearenv (deny-by-default)", async () => {
    const config = await configOf(Bwrap.roBind("/a"))
    expect(config.clearenv).toBeUndefined()
    const buf = Bwrap.render(config)
    expect(buf.split("\0")).toContain("--clearenv")
  })

  test("clearenv() declared explicitly also renders --clearenv", async () => {
    const config = await configOf(Bwrap.clearenv())
    expect(config.clearenv).toBe(true)
    const buf = Bwrap.render(config)
    expect(buf.split("\0")).toContain("--clearenv")
  })

  test("clearenv() twice is idempotent", async () => {
    const config = await configOf(
      Effect.gen(function* () {
        yield* Bwrap.clearenv()
        yield* Bwrap.clearenv()
      }),
    )
    expect(config.clearenv).toBe(true)
  })

  test("render emits --clearenv before any --setenv (ordering regression)", async () => {
    const config = await configOf(
      Effect.gen(function* () {
        yield* Bwrap.setenv("HOME", "/home/sandbox")
        yield* Bwrap.clearenv()
      }),
    )
    const parts = Bwrap.render(config).split("\0")
    const clearenvIndex = parts.indexOf("--clearenv")
    const setenvIndex = parts.indexOf("--setenv")
    expect(clearenvIndex).toBeGreaterThanOrEqual(0)
    expect(setenvIndex).toBeGreaterThanOrEqual(0)
    expect(clearenvIndex).toBeLessThan(setenvIndex)
  })

  test("render encodes options only — no COMMAND or -- terminator", async () => {
    // bwrap rejects a `--args`-fed buffer that also contains the COMMAND
    // (verified empirically: `bwrap --args 0` with `-- prog arg` inside the
    // fd buffer fails with a usage error even though every flag in it is
    // individually valid). COMMAND must be literal trailing argv on the
    // `bwrap` invocation itself, so render() only ever emits options.
    const config = await configOf(Bwrap.roBind("/a"))
    const buf = Bwrap.render(config)
    const parts = buf.split("\0")
    expect(parts).not.toContain("--")
  })

  test("die-with-parent is on by default", async () => {
    const config = await configOf(Bwrap.roBind("/a"))
    const buf = Bwrap.render(config)
    expect(buf.split("\0")).toContain("--die-with-parent")
  })

  test("workspace() rw-binds the host path to /workspace and chdirs into it", async () => {
    const config = await configOf(Bwrap.workspace("/host/project"))
    expect(config.binds).toContainEqual({ mode: "rw", src: "/host/project", dest: "/workspace" })
    expect(config.chdir).toBe("/workspace")
  })

  test("workspace() applied twice with the same host path is idempotent", async () => {
    const config = await configOf(
      Effect.gen(function* () {
        yield* Bwrap.workspace("/host/project")
        yield* Bwrap.workspace("/host/project")
      }),
    )
    expect(config.binds).toHaveLength(1)
  })
})
