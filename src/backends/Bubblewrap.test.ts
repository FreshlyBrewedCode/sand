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

  test("describe() redacts every env value", async () => {
    const config = await configOf(
      Effect.gen(function* () {
        yield* Bwrap.setenv("HOME", "/home/sandbox")
        yield* Bwrap.secret("GH_TOKEN", Redacted.make("s3cr3t"))
      }),
    )
    const lines = Bwrap.describe(config)
    expect(lines).toContain("HOME=<redacted>")
    expect(lines).toContain("GH_TOKEN=<redacted>")
    expect(lines.join("\n")).not.toContain("s3cr3t")
    expect(lines.join("\n")).not.toContain("/home/sandbox")
  })

  test('net("none") collapses to a single --unshare-all', async () => {
    const config = await configOf(Bwrap.net("none"))
    const buf = Bwrap.render(config)
    const parts = buf.split("\0")
    expect(parts).toContain("--unshare-all")
    expect(parts).not.toContain("--unshare-net")
  })

  test('net("shared") unshares user/pid/ipc/uts but keeps networking', async () => {
    const config = await configOf(Bwrap.net("shared"))
    const buf = Bwrap.render(config)
    const parts = buf.split("\0")
    expect(parts).not.toContain("--unshare-all")
    expect(parts).toContain("--unshare-user")
    expect(parts).toContain("--unshare-pid")
    expect(parts).toContain("--unshare-ipc")
    expect(parts).toContain("--unshare-uts")
    expect(parts).not.toContain("--unshare-net")
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

  test("chdir and clearenv update config", async () => {
    const config = await configOf(
      Effect.gen(function* () {
        yield* Bwrap.chdir("/home/sandbox")
        yield* Bwrap.clearenv()
      }),
    )
    expect(config.chdir).toBe("/home/sandbox")
    expect(config.clearenv).toBe(true)
    const buf = Bwrap.render(config)
    expect(buf.split("\0")).toContain("--clearenv")
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
})
