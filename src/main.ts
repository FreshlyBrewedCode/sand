import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Effect } from "effect"
import { Bubblewrap } from "./backends/Bubblewrap.js"
import { NixStore } from "./backends/NixStore.js"
import * as Sandbox from "./Sandbox.js"
import { gh } from "./tools/Gh.js"

const tools = { gh }

const usage = `Usage: sand plan <tool> | sand run <tool> -- <argv...>\nKnown tools: ${Object.keys(tools).join(", ")}`

const main = Effect.gen(function* () {
  const [cmd, toolName, ...rest] = process.argv.slice(2)

  if (toolName === undefined || !(toolName in tools)) {
    return yield* Effect.fail(new Error(`Unknown tool: ${toolName ?? "(none)"}\n${usage}`))
  }
  const tool = tools[toolName as keyof typeof tools]

  switch (cmd) {
    case "plan": {
      yield* Sandbox.plan(tool)
      return
    }
    case "run": {
      const dashDash = rest.indexOf("--")
      const argv = dashDash === -1 ? rest : rest.slice(dashDash + 1)
      const exitCode = yield* Sandbox.run(tool, argv)
      if (Number(exitCode) !== 0) {
        return yield* Effect.fail(new Error(`sandboxed process exited with code ${exitCode}`))
      }
      return
    }
    default: {
      return yield* Effect.fail(new Error(`Unknown command: ${cmd ?? "(none)"}\n${usage}`))
    }
  }
}).pipe(Effect.scoped, Effect.provide(Bubblewrap.Default), Effect.provide(NixStore.Default))

BunRuntime.runMain(main.pipe(Effect.provide(BunContext.layer)))
