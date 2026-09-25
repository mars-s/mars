# Mars

Mars is a local-first, headless AI agent harness with an Electron control surface. The current cut is intentionally small: the UI is a remote for a standalone gateway process, Strands owns the agent loop, and OpenCode Go is the first model provider.

## Current architecture

```text
Electron desktop (presentation only)
        │ HTTP + WebSocket
        ▼
Mars Gateway (headless Node.js)
        │
        ├─ Effect runtime/config boundary
        ├─ Strands Agent
        ├─ OpenCode Go (OpenAI-compatible)
        └─ workspace tools
           ├─ read_file
           ├─ write_file
           ├─ list_files
           └─ run_command
```

Local and future remote deployments use the same gateway protocol. Remote setup is shown in the UI but deliberately disabled until the local path is solid.

## Run it

Requirements: Node.js 24+ and pnpm 10.33.2.

```bash
pnpm install
pnpm dev:desktop
```

The desktop starts alongside the local headless gateway. On first launch, paste your OpenCode Go API key. The default model is `gpt-5.6-luna`; you can enter another OpenCode Go model ID in setup.

OpenCode Go endpoint: `https://opencode.ai/zen/go/v1`

You can also preconfigure the gateway with environment variables from `.env.example`.

## Why the old ZCode source is still here

Mars started as a fork of ZCode because its Electron workbench contains useful browser, terminal, file, review, plugin, MCP, skill, command, hook, memory, and subagent UI/implementation work. The new default build does not launch the Z.ai runtime or provider onboarding. Those legacy packages remain temporarily as an extraction source while equivalent Mars capabilities are moved behind the gateway, after which they can be deleted aggressively.

Default development and build commands now target only `@mars/gateway` and `@mars/desktop`. Legacy ZCode launch commands are explicitly namespaced under `legacy:zcode:*`.

## Near-term extraction order

1. Wire Terminal and Files panes to the gateway host.
2. Move MCP, hooks, skills, commands, plugins, and subagents behind Mars gateway contracts.
3. Add browser/computer-use as a gateway capability with a live remote viewport.
4. Add persisted sessions and source-backed memory/context injection.
5. Enable remote gateway profiles for the Linux server.
6. Delete remaining ZCode runtime/provider/account packages and rename surviving reusable modules.
