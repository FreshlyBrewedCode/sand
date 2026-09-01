import { Config, Effect, Option } from "effect"
import * as Bwrap from "../backends/Bubblewrap.js"
import { NixStore } from "../backends/NixStore.js"
import type { GhError } from "../Errors.js"

/**
 * `gh` composed entirely from grains: the nix closure needed to run the
 * binary, a tmpfs $HOME so the host's real `~/.config/gh` credentials never
 * become visible, the CA bundle (NixOS ships it as a double symlink, so the
 * realpath target has to be bound explicitly or TLS fails), and the token
 * (when present) fed through `--args 0` instead of `--setenv` on argv.
 *
 * `clearenv()` matters here: bwrap does *not* clear the environment by
 * default, so without it every host env var — including anything sitting
 * in the invoking shell that has nothing to do with gh — passes straight
 * through into the sandbox (verified: an unrelated host env var showed up
 * inside a bwrap sandbox with no `--clearenv`). Only HOME and GH_TOKEN are
 * allow-listed back in below.
 *
 * GH_TOKEN is optional, not required: `gh auth status` inside the sandbox
 * is itself a credential-isolation proof (it must report logged-out even
 * though the host's `~/.config/gh/hosts.yml` exists, precisely because
 * $HOME is a bare tmpfs and no token was forwarded), so composing this
 * tool can't hard-fail when the caller hasn't supplied one.
 */
export const gh: Effect.Effect<string, GhError, Bwrap.Bubblewrap | NixStore> = Effect.gen(function* () {
  const bin = yield* NixStore.bindClosure("gh")

  yield* Bwrap.clearenv()
  yield* Bwrap.tmpfs("/home/sandbox")
  yield* Bwrap.setenv("HOME", "/home/sandbox")

  const caBundle = yield* NixStore.realpath("/etc/ssl/certs/ca-certificates.crt")
  yield* Bwrap.roBind(caBundle, "/etc/ssl/certs/ca-certificates.crt")
  yield* Bwrap.roBind("/etc/resolv.conf")

  yield* Bwrap.net("shared")

  const token = yield* Config.option(Config.redacted("GH_TOKEN"))
  if (Option.isSome(token)) {
    yield* Bwrap.secret("GH_TOKEN", token.value)
  }

  return bin
})
