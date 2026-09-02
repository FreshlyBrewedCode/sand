import { Effect } from "effect"
import * as Bwrap from "../backends/Bubblewrap.js"
import { NixStore } from "../backends/NixStore.js"
import type { GhError } from "../Errors.js"
import type * as Sandbox from "../Sandbox.js"

/**
 * `gh`'s own requirements only: the nix closure needed to run the binary,
 * and the CA bundle (NixOS ships it as a double symlink, so the realpath
 * target has to be bound explicitly or TLS fails) plus `/etc/resolv.conf`
 * for DNS. Everything that's *policy* rather than a requirement — network
 * access, `$HOME`, `GH_TOKEN`, whether the environment is cleared — is
 * deliberately left undeclared here; the composition root (`main.ts`)
 * decides it, and `Bubblewrap`'s conflict detection is what stops a future
 * change here from sneaking policy back in unnoticed.
 */
export const gh = (): Sandbox.Tool<GhError, Bwrap.Bubblewrap | NixStore> =>
  Effect.gen(function* () {
    const bin = yield* NixStore.bindClosure("gh")

    const caBundle = yield* NixStore.realpath("/etc/ssl/certs/ca-certificates.crt")
    yield* Bwrap.roBind(caBundle, "/etc/ssl/certs/ca-certificates.crt")
    yield* Bwrap.roBind("/etc/resolv.conf")

    return { name: "gh", bin }
  })
