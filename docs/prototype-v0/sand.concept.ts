const nix = sand.shell<NixConfig>("nix", () => ({
  // ...
}))
nix.package = sand.grain((packageName: string) => {
  nix.config().packages.push(packageName)
})

const podman = sand.container("podman", () => ({
  // ...
}))

const nono = sand.shell<NonoConfig>("nono", () => ({
  // ...
}))

const gh = sand.tool("gh", () => ({
  with: [
    nono.policy(...)
  ]
}))

const opencode = sand.agent("opencode", () => ({
  with: [
    either(
      nix.package("opencode"),
      container.image("opencode:latest")
    ),
    nono.profile("opencode"),
  ]
}))

const sandEnv = sand({
  env: [
    podman(),
    nix(),
    nono(),
  ],
  with: [
    gh(),
    opencode()
  ],
})

await sandEnv.run("gh --version");
sandEnv.shell("opencode");
