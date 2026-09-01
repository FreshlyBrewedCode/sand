import { Data } from "effect"
import type { ConfigError } from "effect/ConfigError"

/**
 * Raised when two grains disagree about a bind destination or an env var
 * name. v0 resolved this with `Object.assign`, silently keeping the last
 * writer; in a security tool a silent merge is a vulnerability, so this
 * fails loud instead.
 */
export class BwrapConflict extends Data.TaggedError("BwrapConflict")<{
  readonly kind: "bind" | "env"
  readonly key: string
  readonly existing: string
  readonly incoming: string
}> {}

export class NixError extends Data.TaggedError("NixError")<{
  readonly reason: "NotFound" | "CommandFailed"
  readonly detail: string
}> {}

export type GhError = BwrapConflict | NixError | ConfigError
