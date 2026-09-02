import { Data } from "effect"

/**
 * Raised when two grains disagree about a bind destination or an env var
 * name. v0 resolved this with `Object.assign`, silently keeping the last
 * writer; in a security tool a silent merge is a vulnerability, so this
 * fails loud instead.
 */
export class BwrapConflict extends Data.TaggedError("BwrapConflict")<{
  readonly kind: "bind" | "env" | "net" | "chdir" | "clearenv"
  readonly key: string
  readonly existing: string
  readonly incoming: string
}> {}

export class NixError extends Data.TaggedError("NixError")<{
  readonly reason: "NotFound" | "CommandFailed"
  readonly detail: string
}> {}

/** Raised when `Sandbox.sand().exec` is called with an empty `argv` — there's no COMMAND to hand bwrap, so this fails before ever spawning it rather than letting bwrap's own execvp report a cryptic error on an empty string. */
export class EmptyCommandError extends Data.TaggedError("EmptyCommandError")<{}> {}

export type GhError = BwrapConflict | NixError
