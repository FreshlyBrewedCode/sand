
/**
 * A small executable prototype for composing sandbox environments.
 *
 * The central inversion is that an Environment does not know what a Tool is.
 * It only owns a set of Parts, such as a host-command backend, a Nix backend,
 * a container backend, or a policy engine. A tool is a portable declaration of
 * Contributions addressed to those parts. For example, an OpenCode tool might
 * contribute `nix.package("opencode")` and `nono.profile("opencode")` without
 * an environment needing any OpenCode-specific behavior.
 *
 * Grain is the smallest compositional unit. A Grain is lazy, can succeed with
 * a value or fail with a structured SandError, and composes through map,
 * flatMap, recover, and all. Tools are built from grains that produce
 * contributions. During provisioning, the environment evaluates its tools,
 * resolves preferences against the parts that are actually installed, and
 * routes each selected contribution to its target part for application.
 *
 * This intentionally small runtime demonstrates the pattern with two parts:
 * `local` verifies and exposes a command already available on the host, while
 * `env` supplies process environment variables. The runnable example creates
 * a tool that requires Bun and contributes SAND_GREETING, then executes Bun in
 * the resulting active environment. More capable parts can use the identical
 * Part protocol to install packages, start containers, apply policies, and
 * register cleanup finalizers.
 *
 * Run with: bun sand.ts
 */

export type SandError =
  | { tag: "GrainFailed"; message: string; cause?: unknown }
  | { tag: "ToolFailed"; tool: string; cause: SandError }
  | { tag: "MissingPart"; target: string; contribution: string }
  | { tag: "NoPreferredContribution"; candidates: readonly string[] }
  | { tag: "CommandUnavailable"; command: string }
  | { tag: "CommandFailed"; command: readonly string[]; exitCode: number }

type Result<A> =
  | { ok: true; value: A }
  | { ok: false; error: SandError }

const success = <A>(value: A): Result<A> => ({ ok: true, value })
const failure = <A = never>(error: SandError): Result<A> => ({ ok: false, error })

/** A lazy async computation with a typed, structured failure channel. */
export class Grain<A> {
  constructor(readonly run: () => Promise<Result<A>>) {}

  map<B>(map: (value: A) => B): Grain<B> {
    return new Grain(async () => {
      const result = await this.run()
      return result.ok ? success(map(result.value)) : result
    })
  }

  flatMap<B>(map: (value: A) => Grain<B>): Grain<B> {
    return new Grain(async () => {
      const result = await this.run()
      return result.ok ? map(result.value).run() : result
    })
  }

  recover(recover: (error: SandError) => Grain<A>): Grain<A> {
    return new Grain(async () => {
      const result = await this.run()
      return result.ok ? result : recover(result.error).run()
    })
  }
}

export const sand = {
  grain<A>(effect: () => Promise<A> | A): Grain<A> {
    return new Grain(async () => {
      try {
        return success(await effect())
      } catch (cause) {
        return failure({ tag: "GrainFailed", message: "Effect failed", cause })
      }
    })
  },

  succeed<A>(value: A): Grain<A> {
    return new Grain(async () => success(value))
  },

  fail<A = never>(error: SandError): Grain<A> {
    return new Grain(async () => failure(error))
  },

  attempt<A>(effect: () => Promise<A> | A): Grain<A> {
    return this.grain(effect)
  },

  all<A>(grains: readonly Grain<A>[]): Grain<readonly A[]> {
    return new Grain(async () => {
      const values: A[] = []
      for (const grain of grains) {
        const result = await grain.run()
        if (!result.ok) return result
        values.push(result.value)
      }
      return success(values)
    })
  },
}

type DirectContribution = {
  readonly target: string
  readonly kind: string
  readonly payload: unknown
}

type PreferredContribution = {
  readonly target: "sand"
  readonly kind: "sand.prefer"
  readonly candidates: readonly DirectContribution[]
}

type Contribution = DirectContribution | PreferredContribution

export type Tool = {
  readonly id: string
  readonly setup: Grain<readonly Contribution[]>
}

interface ActivePart {
  readonly environment: Readonly<Record<string, string>>
  readonly commands: Readonly<Record<string, string>>
}

export interface Part {
  readonly id: string
  apply(contribution: DirectContribution): Grain<void>
  activate(): ActivePart
}

class LocalPart implements Part {
  readonly id = "local"
  private readonly commands: Record<string, string> = {}

  apply(contribution: DirectContribution): Grain<void> {
    if (contribution.kind !== "local.command") {
      return sand.fail({
        tag: "GrainFailed",
        message: `Local cannot apply ${contribution.kind}`,
      })
    }

    const { command } = contribution.payload as { command: string }
    return sand.attempt(() => {
      const path = Bun.which(command)
      if (!path) throw { tag: "CommandUnavailable", command } satisfies SandError
      this.commands[command] = path
    }).recover(error =>
      sand.fail(error.tag === "GrainFailed" && isSandError(error.cause)
        ? error.cause
        : error),
    )
  }

  activate(): ActivePart {
    return { environment: {}, commands: this.commands }
  }
}

class EnvPart implements Part {
  readonly id = "env"
  private readonly environment: Record<string, string> = {}

  apply(contribution: DirectContribution): Grain<void> {
    if (contribution.kind !== "env.set") {
      return sand.fail({
        tag: "GrainFailed",
        message: `Env cannot apply ${contribution.kind}`,
      })
    }

    const { name, value } = contribution.payload as { name: string; value: string }
    this.environment[name] = value
    return sand.succeed(undefined)
  }

  activate(): ActivePart {
    return { environment: this.environment, commands: {} }
  }
}

function isSandError(value: unknown): value is SandError {
  return typeof value === "object" && value !== null && "tag" in value
}

export const local = {
  part: (): Part => new LocalPart(),
  command: (command: string): Grain<DirectContribution> =>
    sand.succeed({
      target: "local",
      kind: "local.command",
      payload: { command },
    }),
}

export const env = {
  part: (): Part => new EnvPart(),
  set: (name: string, value: string): Grain<DirectContribution> =>
    sand.succeed({
      target: "env",
      kind: "env.set",
      payload: { name, value },
    }),
}

export function tool(id: string, setup: readonly Grain<Contribution>[]): Tool {
  return { id, setup: sand.all(setup) }
}

export function prefer(...candidates: readonly Grain<DirectContribution>[]): Grain<PreferredContribution> {
  return sand.all(candidates).map(resolved => ({
    target: "sand",
    kind: "sand.prefer",
    candidates: resolved,
  }))
}

export class ActiveEnvironment {
  constructor(
    private readonly environment: Readonly<Record<string, string>>,
    private readonly commands: Readonly<Record<string, string>>,
  ) {}

  async exec(command: readonly string[]): Promise<void> {
    const [program, ...args] = command
    if (!program) throw new Error("Cannot execute an empty command")

    const process = Bun.spawn([this.commands[program] ?? program, ...args], {
      env: { ...Bun.env, ...this.environment },
      stdout: "inherit",
      stderr: "inherit",
    })
    const exitCode = await process.exited
    if (exitCode !== 0) {
      throw { tag: "CommandFailed", command, exitCode } satisfies SandError
    }
  }
}

class Environment {
  constructor(
    private readonly parts: readonly Part[],
    private readonly tools: readonly Tool[],
  ) {}

  async provision(): Promise<ActiveEnvironment> {
    const parts = new Map(this.parts.map(part => [part.id, part]))
    const contributions: DirectContribution[] = []

    for (const requestedTool of this.tools) {
      const setup = await requestedTool.setup.run()
      if (!setup.ok) throw { tag: "ToolFailed", tool: requestedTool.id, cause: setup.error } satisfies SandError

      for (const contribution of setup.value) {
        if (contribution.kind === "sand.prefer") {
          const selected = contribution.candidates.find(candidate => parts.has(candidate.target))
          if (!selected) {
            throw {
              tag: "NoPreferredContribution",
              candidates: contribution.candidates.map(candidate => candidate.target),
            } satisfies SandError
          }
          contributions.push(selected)
        } else {
          contributions.push(contribution)
        }
      }
    }

    for (const contribution of contributions) {
      const part = parts.get(contribution.target)
      if (!part) {
        throw {
          tag: "MissingPart",
          target: contribution.target,
          contribution: contribution.kind,
        } satisfies SandError
      }
      const applied = await part.apply(contribution).run()
      if (!applied.ok) throw applied.error
    }

    const active = this.parts.map(part => part.activate())
    return new ActiveEnvironment(
      Object.assign({}, ...active.map(part => part.environment)),
      Object.assign({}, ...active.map(part => part.commands)),
    )
  }
}

export const environment = (config: { parts: readonly Part[]; with: readonly Tool[] }) =>
  new Environment(config.parts, config.with)

if (import.meta.main) {
  // A tool remains independent of Environment. It contributes setup addressed
  // to the local and env parts, and the environment routes those requests.
  const helloAgent = tool("hello-agent", [
    local.command("bun"),
    env.set("SAND_GREETING", "hello from a composed sand environment"),
  ])

  const sandbox = environment({
    parts: [local.part(), env.part()],
    with: [helloAgent],
  })

  const active = await sandbox.provision()
  await active.exec(["bun", "-e", "console.log(process.env.SAND_GREETING)"])

  // `prefer` is resolved against the installed parts during provisioning:
  // const command = prefer(nix.package("opencode"), local.command("opencode"))
}
