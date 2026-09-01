import { Effect, Redacted, Ref } from "effect"
import { BwrapConflict } from "../Errors.js"

export interface BwrapBind {
  readonly mode: "ro" | "rw"
  readonly src: string
  readonly dest: string
}

export interface BwrapUnshare {
  readonly user: boolean
  readonly pid: boolean
  readonly ipc: boolean
  readonly uts: boolean
  readonly net: boolean
  readonly cgroup: boolean
}

export interface BwrapConfig {
  readonly binds: ReadonlyArray<BwrapBind>
  readonly tmpfs: ReadonlyArray<string>
  readonly dirs: ReadonlyArray<string>
  readonly env: ReadonlyMap<string, Redacted.Redacted<string>>
  readonly unshare: BwrapUnshare
  readonly proc: boolean
  readonly dev: boolean
  readonly chdir: string | undefined
  readonly clearenv: boolean
  readonly dieWithParent: boolean
}

export const emptyConfig: BwrapConfig = {
  binds: [],
  tmpfs: [],
  dirs: [],
  env: new Map(),
  unshare: { user: false, pid: false, ipc: false, uts: false, net: false, cgroup: false },
  proc: true,
  dev: true,
  chdir: undefined,
  clearenv: false,
  dieWithParent: true,
}

export class Bubblewrap extends Effect.Service<Bubblewrap>()("Bubblewrap", {
  scoped: Effect.map(Ref.make(emptyConfig), ref => ({ ref }) as const),
}) {}

const withConfig = <E>(
  f: (config: BwrapConfig) => Effect.Effect<BwrapConfig, E>,
): Effect.Effect<void, E, Bubblewrap> =>
  Effect.gen(function* () {
    const bw = yield* Bubblewrap
    const config = yield* Ref.get(bw.ref)
    const next = yield* f(config)
    yield* Ref.set(bw.ref, next)
  })

const bind = (mode: "ro" | "rw", src: string, dest: string): Effect.Effect<void, BwrapConflict, Bubblewrap> =>
  withConfig(config => {
    const existing = config.binds.find(b => b.dest === dest)
    if (existing === undefined) {
      return Effect.succeed({ ...config, binds: [...config.binds, { mode, src, dest }] })
    }
    if (existing.src === src && existing.mode === mode) {
      return Effect.succeed(config)
    }
    return Effect.fail(
      new BwrapConflict({
        kind: "bind",
        key: dest,
        existing: `${existing.mode}:${existing.src}`,
        incoming: `${mode}:${src}`,
      }),
    )
  })

export const roBind = (src: string, dest: string = src) => bind("ro", src, dest)
export const rwBind = (src: string, dest: string = src) => bind("rw", src, dest)

export const tmpfs = (dest: string): Effect.Effect<void, never, Bubblewrap> =>
  withConfig(config =>
    Effect.succeed(config.tmpfs.includes(dest) ? config : { ...config, tmpfs: [...config.tmpfs, dest] }),
  )

export const dir = (dest: string): Effect.Effect<void, never, Bubblewrap> =>
  withConfig(config =>
    Effect.succeed(config.dirs.includes(dest) ? config : { ...config, dirs: [...config.dirs, dest] }),
  )

const setEnvRedacted = (name: string, value: Redacted.Redacted<string>): Effect.Effect<void, BwrapConflict, Bubblewrap> =>
  withConfig(config => {
    const existing = config.env.get(name)
    if (existing !== undefined && Redacted.value(existing) !== Redacted.value(value)) {
      return Effect.fail(
        new BwrapConflict({
          kind: "env",
          key: name,
          existing: "<redacted>",
          incoming: "<redacted>",
        }),
      )
    }
    const env = new Map(config.env)
    env.set(name, value)
    return Effect.succeed({ ...config, env })
  })

export const setenv = (name: string, value: string) => setEnvRedacted(name, Redacted.make(value))
export const secret = (name: string, value: Redacted.Redacted<string>) => setEnvRedacted(name, value)

export const net = (mode: "none" | "shared"): Effect.Effect<void, never, Bubblewrap> =>
  withConfig(config =>
    Effect.succeed({
      ...config,
      unshare:
        mode === "none"
          ? { user: true, pid: true, ipc: true, uts: true, net: true, cgroup: true }
          : { user: true, pid: true, ipc: true, uts: true, net: false, cgroup: false },
    }),
  )

export const chdir = (dir: string): Effect.Effect<void, never, Bubblewrap> =>
  withConfig(config => Effect.succeed({ ...config, chdir: dir }))

export const clearenv = (): Effect.Effect<void, never, Bubblewrap> =>
  withConfig(config => Effect.succeed({ ...config, clearenv: true }))

const unshareFlags = (unshare: BwrapUnshare): ReadonlyArray<string> => {
  const allShared = unshare.user && unshare.pid && unshare.ipc && unshare.uts && unshare.net && unshare.cgroup
  if (allShared) return ["--unshare-all"]
  const flags: string[] = []
  if (unshare.user) flags.push("--unshare-user")
  if (unshare.pid) flags.push("--unshare-pid")
  if (unshare.ipc) flags.push("--unshare-ipc")
  if (unshare.uts) flags.push("--unshare-uts")
  if (unshare.net) flags.push("--unshare-net")
  if (unshare.cgroup) flags.push("--unshare-cgroup")
  return flags
}

/**
 * Renders the bwrap *options* as a NUL-separated argument buffer, meant to
 * be fed to `bwrap --args <fd>` so no flag (including env values) ever
 * appears in `/proc/<pid>/cmdline`. The COMMAND to run and its argv are
 * deliberately not part of this buffer: bwrap only accepts `--args` for
 * options, and expects COMMAND (and its own args) as trailing, literal
 * argv on the `bwrap` invocation itself — verified empirically, since
 * `bwrap --args 0 -- prog arg` fed entirely through the fd fails with a
 * usage error even though every flag in it is individually valid.
 */
export const render = (config: BwrapConfig): string => {
  const args: string[] = [...unshareFlags(config.unshare)]

  if (config.dieWithParent) args.push("--die-with-parent")
  if (config.clearenv) args.push("--clearenv")

  for (const b of config.binds) {
    args.push(b.mode === "ro" ? "--ro-bind" : "--bind", b.src, b.dest)
  }
  for (const dest of config.tmpfs) args.push("--tmpfs", dest)
  for (const dest of config.dirs) args.push("--dir", dest)
  if (config.proc) args.push("--proc", "/proc")
  if (config.dev) args.push("--dev", "/dev")
  if (config.chdir !== undefined) args.push("--chdir", config.chdir)

  for (const [name, value] of config.env) {
    args.push("--setenv", name, Redacted.value(value))
  }

  return args.join("\0")
}

/** Human-readable report for `sand plan`. Every env value is redacted, never just the ones added via `secret()`. */
export const describe = (config: BwrapConfig): ReadonlyArray<string> => {
  const lines: string[] = []
  for (const b of config.binds) {
    lines.push(`--${b.mode === "ro" ? "ro-bind" : "bind"} ${b.src} ${b.dest}`)
  }
  for (const dest of config.tmpfs) lines.push(`--tmpfs ${dest}`)
  for (const dest of config.dirs) lines.push(`--dir ${dest}`)

  lines.push(`net=${config.unshare.net ? "none" : "shared"}`)

  if (config.chdir !== undefined) lines.push(`--chdir ${config.chdir}`)
  if (config.clearenv) lines.push("--clearenv")
  for (const name of config.env.keys()) lines.push(`${name}=<redacted>`)
  return lines
}
