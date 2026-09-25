# Mars contributor rules

## Product boundary

Mars is a local-first personal agent with a headless gateway and thin clients.

- `packages/mars-gateway` is the authoritative runtime. Agent sessions, tools, model access, memory, MCP, workflows, and future durable background work live here.
- `packages/mars-desktop` is a presentation client. It may own native Electron/window integration, but it must not become the authority for agent state or workspace execution.
- Local and remote operation must use the same gateway protocol. Local mode points the desktop at a loopback gateway; remote mode will point the same client at an authenticated Linux gateway.
- Strands is the first agent runtime, not the permanent product boundary. Keep it behind Mars-owned runtime contracts as the system grows.
- Effect is the preferred foundation for long-lived services, lifecycles, resource ownership, cancellation, retries, and typed failures.

## Legacy ZCode source

The repository still contains the upstream ZCode implementation while useful workbench capabilities are extracted.

- Do not add new dependencies on Z.ai account, billing, OAuth, coding-plan, or built-in provider services.
- New Mars UI must not present Z.ai or BigModel onboarding/providers.
- Extract useful neutral capabilities such as terminal, files, browser/computer-use, MCP, hooks, skills, commands, plugins, review, and workspace UI behind Mars-owned interfaces.
- Delete or rename legacy ZCode modules once no Mars path consumes them.
- New user-facing text, comments, docs, tests, and identifiers must be English unless a localization feature explicitly requires another language.

## Current local development

Use Node 24 and pnpm 10.

```bash
pnpm install
pnpm dev:desktop
```

`dev:desktop` starts the headless local Mars gateway and the Electron desktop client together. The gateway defaults to `127.0.0.1:3037`.

Before committing runtime changes, run what is available:

```bash
pnpm typecheck
pnpm build
```

Never claim a build or test passed unless it was actually executed successfully.

## Security and state ownership

- API keys and credentials belong to the gateway, not the renderer.
- Workspace tools must remain scoped to the configured workspace unless a future explicit capability grants wider access.
- A remote gateway must be authenticated before it is exposed beyond loopback.
- UI state is not evidence that an external action succeeded. Durable/authoritative state belongs on the gateway.
- Keep provider/runtime configuration replaceable. OpenCode Go is the initial provider, not a hardcoded product dependency.
