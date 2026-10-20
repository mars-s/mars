# Claude subscription sign-in

Settings → Account offers Pi's native Anthropic (Claude Pro/Max) OAuth flow alongside ChatGPT. Anthropic credentials belong to the private Pi credential store, never the Next.js bundle, Git repository or patch workspace.

The host registers Pi AI 1.3.0's `anthropicProvider`. The installed model catalogue includes `claude-opus-5-5` (Claude Opus 5.5). Catalogue availability does not establish account entitlement. Only owner-completed sign-in and a successful real request can establish that.

## State and interfaces

`GET /api/state` retains `auth` for OpenAI and adds `anthropicAuth`. Each has `connected`, `state`, `events`, `prompt` and optional sanitised `error`. Independent provider flows cannot accept one another's answers. `POST /api/login` and `/api/login-answer` accept `provider: "anthropic" | "openai"`; omission preserves the OpenAI contract. Invalid providers are rejected.

The native Anthropic `copy_code` method supports a browser on a different computer without a localhost port tunnel. Settings opens the SDK-provided Claude authorisation URL. The owner signs in and pastes the returned code (normally `code#state`) into Settings. Pi validates the state and exchanges the code server-side. Flows expire after 15 minutes. Provider error details and submitted codes are not logged or returned.

Model choices use `anthropic/<id>` (including `anthropic/claude-opus-5-5`), `opencode-go/<id>`, and the existing bare OpenAI IDs. Chat requires credentials for the selected provider. Choosing Claude neither copies ChatGPT credentials nor modifies Discord or OpenCode settings.

## UI modification

Claude uses the same bounded `ui_source_read`, `ui_patch_stage`, `ui_patch_validate`, `ui_patch_promote` and `ui_patch_rollback` tools as other models. Selecting a different model does not widen filesystem or deployment permissions. Local Mac development uses Next.js Fast Refresh; private Bot Box source promotion retains validation and rollback.

## Acceptance

- OpenAI login endpoints remain compatible when no provider is supplied.
- Anthropic uses native Pi OAuth and selects `copy_code` automatically.
- An answer for one provider cannot resolve the other provider's prompt.
- Both provider credential states and all model IDs remain distinct.
- Failed or expired sign-in exposes a generic error without provider payloads.
- A real Claude request remains unverified until the owner completes OAuth.
