# Mars contributor instructions

Mars is Pi Durable plus apps/ui. The user explicitly retired the former ZCode and
DeepSeek implementation. Historical provider pins and desktop architecture rules
are superseded by docs/MONOREPO.md. Read that spec before changing behaviour.

Preserve existing changes and never commit native data, credentials, .env files or
user attachments. Read .agents/CONTEXT.md, DECISIONS.md and verification.md when
present. Append .agents/CHANGELOG.md in the same commit. Use disjoint file ownership
and worktrees for parallel edits. Pi owns conversations/tasks/usage; browser owns
selection and drafts; one host registry owns plugin exposure. Write specs before
behaviour, test actual paths, report failures honestly.

Use pinned Node24.14.0 and npm workspaces. Run npm run typecheck, npm run lint,
npm test and relevant browser/native checks, then npm run build. No ZCode test or
architecture command remains applicable to the retired source. Local syntax and
module boundaries are checked through the current package scripts.

Keep full owner-authorised VM control, owner HTTP authentication, deferred tool
discovery, bounded context and idempotent recovery. Installed user plugins retain
their code and task definitions through migration. No new external account actions
or messages without the owner's instructions.

Use plain Australian English. No em dashes.
