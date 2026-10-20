# Mars

A Pi Durable agent with a Next.js UI, installed from one repository.

Mars uses native Pi conversations, durable background workflows and selected-model
subagents. The UI provides Markdown chat, image paste, nested threads, real tool
activity and managed plugin cards. Agents can add tools and interfaces and stage
host changes with a health check and rollback watchdog. Provider tools and large
outputs are discovered on demand rather than copied into every prompt.

```sh
git clone https://github.com/mars-s/mars.git
cd mars
# Node24.14.0 with npm11.9.0, or use the pinned mise toolchain.
npm ci
npm run setup
npm run dev
```

Open the owner sign-in URL printed by setup. Connect ChatGPT or Claude in Settings.
Data and credentials stay outside Git. The app runs as your local OS user and its
tools have that user's file and shell permissions.

[Installation, production and Linux startup](docs/INSTALL.md) ·
[Architecture](docs/ARCHITECTURE.md) ·
[Migration and verification](docs/MIGRATION-RESULTS.md)

| Directory | Contents |
| --- | --- |
| apps/ui | Next.js, TypeScript, assistant-ui, shadcn controls and local fonts |
| packages/pi-host | Custom HTTP host, pinned upstream Pi Durable1.3.0 and native tools |
| scripts | Setup, process supervision, service installation and checks |

This replaces the earlier ZCode and DeepSeek experiments. They are not build or
runtime dependencies. Historical source remains in Git. Third-party component
notices and the supplied font provenance remain alongside their files.
