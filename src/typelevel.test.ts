/**
 * Not a runtime test — a compile-time proof, checked by `tsc --noEmit`.
 * Every line here is a `type`/`import type` construct that erases to
 * nothing at runtime, so `bun test` picking this file up (it matches
 * `*.test.ts`) is harmless: zero tests, zero side effects.
 *
 * `gh()`'s requirement channel is `Bubblewrap | NixStore`. Providing only
 * `Bubblewrap.Default` must leave `NixStore` unsatisfied. If a future
 * refactor accidentally lets `Gh.ts` compose without really needing
 * `NixStore`, this file stops typechecking (an unused `@ts-expect-error`
 * is itself a type error), catching the regression here instead of at
 * runtime with v0's `MissingPart`.
 */
import type { Effect } from "effect"
import type { Bubblewrap } from "./backends/Bubblewrap.js"
import type { gh } from "./tools/Gh.js"

type GhRequirements = ReturnType<typeof gh> extends Effect.Effect<infer _A, infer _E, infer R> ? R : never
type RemainingAfterProvidingOnlyBubblewrap = Exclude<GhRequirements, Bubblewrap>

type RequireNever<R extends never> = R

// @ts-expect-error — NixStore is still in the requirement channel after
// providing only Bubblewrap.Default, so this constraint is violated.
type _MissingNixStoreIsACompileError = RequireNever<RemainingAfterProvidingOnlyBubblewrap>

export {}
