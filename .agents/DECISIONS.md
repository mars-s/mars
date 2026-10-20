# Decisions

## 20 October 2026: replace the earlier ZCode direction

The owner explicitly requested retiring ZCode, old Mars trusted-core/workbench and
DeepSeek, keeping Pi Durable plus Mars UI in one installable public mars repo.
This supersedes historical ZCode/provider/layer rules and model pins. Public Mars source history remains in Git. Full private UI and local-only
history is in the private backup bundle, not the public migration ancestry.
No legacy application code is part of the active workspace.

## Native state stays native

Keep upstream Pi Durable1.3.0 pinned as a dependency. Custom host adapters own
HTTP, immutable plugin installation, image files and deployment. Native Pi owns
conversations, tasks, checkpoints and usage. Do not vendor or fork the SDK as an
unnecessary third workspace. The UI stays on assistant-ui with its real runtime.

## One checkout and one dependency lock

Use npm workspaces for apps/ui and packages/pi-host, one pinned root lockfile,
portable root commands, and optional generated Linux user services. New installs
start with empty private XDG data. Existing installations use explicit MARS_PI_ROOT
and preserve original secrets/state. Hot reload is for development; production
start uses a tested build. Host self-deployment keeps staged checks and rollback.
