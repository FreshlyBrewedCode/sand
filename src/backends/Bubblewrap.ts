import { Command } from "@effect/platform"
import { Effect, Redacted, Ref } from "effect"
import { BwrapConflict } from "../Errors.js"

export interface BwrapBind {
  readonly mode: "ro" | "rw"
  readonly src: string
  readonly dest: string
}

export interface BwrapEnvEntry {
  readonly value: Redacted.Redacted<string>
  readonly secret: boolean
}

export interface BwrapConfig {
  readonly binds: ReadonlyArray<BwrapBind>
  readonly tmpfs: ReadonlyArray<string>
  readonly dirs: ReadonlyArray<string>
  readonly env: ReadonlyMap<string, BwrapEnvEntry>
  readonly net: "none" | "shared" | undefined
  readonly proc: boolean
  readonly dev: boolean
  readonly chdir: string | undefined
  readonly clearenv: boolean | undefined
  readonly dieWithParent: boolean
}

export const emptyConfig: BwrapConfig = {
  binds: [],
  tmpfs: [],
  dirs: [],
  env: new Map(),
  net: undefined,
  proc: true,
  dev: true,
  chdir: undefined,
  clearenv: undefined,
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

/** What, if anything, currently claims a mount destination — shared by bind/tmpfs/dir so they conflict-check against each other, not just against their own kind. */
type DestinationClaim =
  | { readonly kind: "bind"; readonly mode: "ro" | "rw"; readonly src: string }
  | { readonly kind: "tmpfs" }
  | { readonly kind: "dir" }

const destinationClaim = (config: BwrapConfig, dest: string): DestinationClaim | undefined => {
  const bound = config.binds.find(b => b.dest === dest)
  if (bound !== undefined) return { kind: "bind", mode: bound.mode, src: bound.src }
  if (config.tmpfs.includes(dest)) return { kind: "tmpfs" }
  if (config.dirs.includes(dest)) return { kind: "dir" }
  return undefined
}

const describeClaim = (claim: DestinationClaim): string =>
  claim.kind === "bind" ? `${claim.mode}:${claim.src}` : claim.kind

const claimDestination = (
  config: BwrapConfig,
  dest: string,
  incoming: DestinationClaim,
  apply: () => BwrapConfig,
): Effect.Effect<BwrapConfig, BwrapConflict> => {
  const existing = destinationClaim(config, dest)
  if (existing === undefined) return Effect.succeed(apply())
  const same =
    existing.kind === incoming.kind &&
    (existing.kind !== "bind" || (incoming.kind === "bind" && existing.mode === incoming.mode && existing.src === incoming.src))
  if (same) return Effect.succeed(config)
  return Effect.fail(
    new BwrapConflict({
      kind: "bind",
      key: dest,
      existing: describeClaim(existing),
      incoming: describeClaim(incoming),
    }),
  )
}

const bind = (mode: "ro" | "rw", src: string, dest: string): Effect.Effect<void, BwrapConflict, Bubblewrap> =>
  withConfig(config =>
    claimDestination(config, dest, { kind: "bind", mode, src }, () => ({
      ...config,
      binds: [...config.binds, { mode, src, dest }],
    })),
  )

export const roBind = (src: string, dest: string = src) => bind("ro", src, dest)
export const rwBind = (src: string, dest: string = src) => bind("rw", src, dest)

export const tmpfs = (dest: string): Effect.Effect<void, BwrapConflict, Bubblewrap> =>
  withConfig(config =>
    claimDestination(config, dest, { kind: "tmpfs" }, () => ({ ...config, tmpfs: [...config.tmpfs, dest] })),
  )

export const dir = (dest: string): Effect.Effect<void, BwrapConflict, Bubblewrap> =>
  withConfig(config =>
    claimDestination(config, dest, { kind: "dir" }, () => ({ ...config, dirs: [...config.dirs, dest] })),
  )

const setEnvRedacted = (
  name: string,
  value: Redacted.Redacted<string>,
  secret: boolean,
): Effect.Effect<void, BwrapConflict, Bubblewrap> =>
  withConfig(config => {
    const existing = config.env.get(name)
    if (existing !== undefined && Redacted.value(existing.value) !== Redacted.value(value)) {
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
    env.set(name, { value, secret: (existing?.secret ?? false) || secret })
    return Effect.succeed({ ...config, env })
  })

export const setenv = (name: string, value: string) => setEnvRedacted(name, Redacted.make(value), false)
export const secret = (name: string, value: Redacted.Redacted<string>) => setEnvRedacted(name, value, true)

export const net = (mode: "none" | "shared"): Effect.Effect<void, BwrapConflict, Bubblewrap> =>
  withConfig(config => {
    if (config.net === undefined) return Effect.succeed({ ...config, net: mode })
    if (config.net === mode) return Effect.succeed(config)
    return Effect.fail(new BwrapConflict({ kind: "net", key: "net", existing: config.net, incoming: mode }))
  })

export const chdir = (dir: string): Effect.Effect<void, BwrapConflict, Bubblewrap> =>
  withConfig(config => {
    if (config.chdir === undefined) return Effect.succeed({ ...config, chdir: dir })
    if (config.chdir === dir) return Effect.succeed(config)
    return Effect.fail(new BwrapConflict({ kind: "chdir", key: "chdir", existing: config.chdir, incoming: dir }))
  })

export const clearenv = (): Effect.Effect<void, BwrapConflict, Bubblewrap> =>
  withConfig(config => {
    if (config.clearenv === undefined) return Effect.succeed({ ...config, clearenv: true })
    if (config.clearenv === true) return Effect.succeed(config)
    return Effect.fail(new BwrapConflict({ kind: "clearenv", key: "clearenv", existing: "false", incoming: "true" }))
  })

/** Composes a host workspace bind with the working directory that makes it useful. */
export const workspace = (hostPath: string): Effect.Effect<void, BwrapConflict, Bubblewrap> =>
  Effect.gen(function* () {
    yield* rwBind(hostPath, "/workspace")
    yield* chdir("/workspace")
  })

/**
 * Renders the bwrap *options* as a NUL-separated argument buffer, meant to
 * be fed to `bwrap --args <fd>` so no flag (including env values) ever
 * appears in `/proc/<pid>/cmdline`. The COMMAND to run and its argv are
 * deliberately not part of this buffer: bwrap only accepts `--args` for
 * options, and expects COMMAND (and its own args) as trailing, literal
 * argv on the `bwrap` invocation itself — verified empirically, since
 * `bwrap --args 0 -- prog arg` fed entirely through the fd fails with a
 * usage error even though every flag in it is individually valid.
 *
 * Isolation is deny-by-default: undeclared `net`/`clearenv` render exactly
 * as if they had been explicitly set to the safe value (`--unshare-all`
 * with no `--share-net`; `--clearenv`), so a tool that forgets to declare
 * a grain fails closed instead of open.
 */
export const render = (config: BwrapConfig): string => {
  const args: string[] = ["--unshare-all"]
  if (config.net === "shared") args.push("--share-net")

  if (config.dieWithParent) args.push("--die-with-parent")
  if (config.clearenv !== false) args.push("--clearenv")

  for (const b of config.binds) {
    args.push(b.mode === "ro" ? "--ro-bind" : "--bind", b.src, b.dest)
  }
  for (const dest of config.tmpfs) args.push("--tmpfs", dest)
  for (const dest of config.dirs) args.push("--dir", dest)
  if (config.proc) args.push("--proc", "/proc")
  if (config.dev) args.push("--dev", "/dev")
  if (config.chdir !== undefined) args.push("--chdir", config.chdir)

  for (const [name, entry] of config.env) {
    args.push("--setenv", name, Redacted.value(entry.value))
  }

  return args.join("\0")
}

/** Human-readable report for `sand plan`. Only values declared via `secret()` are redacted — `setenv()` values print in the clear, matching what `render()` actually feeds bwrap. */
export const describe = (config: BwrapConfig): ReadonlyArray<string> => {
  const lines: string[] = []
  for (const b of config.binds) {
    lines.push(`--${b.mode === "ro" ? "ro-bind" : "bind"} ${b.src} ${b.dest}`)
  }
  for (const dest of config.tmpfs) lines.push(`--tmpfs ${dest}`)
  for (const dest of config.dirs) lines.push(`--dir ${dest}`)

  lines.push(`net=${config.net ?? "none"}`)

  if (config.chdir !== undefined) lines.push(`--chdir ${config.chdir}`)
  if (config.clearenv !== false) lines.push("--clearenv")
  for (const [name, entry] of config.env) {
    lines.push(entry.secret ? `${name}=<redacted>` : `${name}=${Redacted.value(entry.value)}`)
  }
  return lines
}

/** Assembles the actual `bwrap` invocation: the rendered option buffer fed via `--args 0` (never argv, so nothing — including secrets — reaches `/proc/<pid>/cmdline`), followed by the literal COMMAND and its argv. `stdio` defaults to `"inherit"` for real CLI usage; tests pass `"pipe"` to capture output instead of flooding the test log. */
export const toCommand = (
  config: BwrapConfig,
  command: string,
  argv: ReadonlyArray<string>,
  stdio: "inherit" | "pipe" = "inherit",
): Command.Command =>
  Command.make("bwrap", "--args", "0", command, ...argv).pipe(
    Command.feed(render(config)),
    Command.stdout(stdio),
    Command.stderr(stdio),
  )
