# pstack model configuration

Per-role model overrides for pstack skills. Each pstack SKILL.md names its
defaults in a Models section. The values here override those defaults. Delete a
line to fall back to the skill default. A value of `inherit-parent` or `auto`
runs that role on the parent session's model.

This sheet is written for the **ZCode runtime**, not Claude Code. Model IDs are
the slugs this runtime actually exposes. Do not write a `claude-*` slug here,
this runtime has none.

## Current pin

Every role is pinned to `space-bunny-free`. This is deliberate and global.

**`space-bunny-free` is a limited-time free model. It will be removed.** When it
goes, every role below breaks at once. Plan the replacement before it happens
and update this file in one commit. See `.agents/CONTEXT.md` for the standing
rule.

## Roles

```text
feature, refactoring: opencode-go-chat/space-bunny-free
bug-fix: opencode-go-chat/space-bunny-free
perf-issue: opencode-go-chat/space-bunny-free
hillclimb: opencode-go-chat/space-bunny-free
judgment and prose: opencode-go-chat/space-bunny-free
strongest judgment: opencode-go-chat/space-bunny-free
how explorer: opencode-go-chat/space-bunny-free
how explainer: opencode-go-chat/space-bunny-free
why investigators: opencode-go-chat/space-bunny-free
why synthesizer: opencode-go-chat/space-bunny-free
reflect tooling: opencode-go-chat/space-bunny-free
reflect judgment, divergent, synthesizer: opencode-go-chat/space-bunny-free
arena runners: opencode-go-chat/space-bunny-free
arena cross-judge pool: opencode-go-chat/space-bunny-free
swarm workers: opencode-go-chat/space-bunny-free
architect runners: opencode-go-chat/space-bunny-free
interrogate reviewers: opencode-go-chat/space-bunny-free
```

## Why one model for every role

Multi-model panels exist to get disagreement between roles. They are not useful
here. This project has exactly one implementer plus a second agent working out
of band, and the second agent may be running a different model entirely. A panel
of identical models produces cost without signal.

If a decision needs genuine disagreement, the second agent is the
counterweight. Reach for that rather than a panel.

## Other models available on this runtime

Use these only if the pin is deliberately lifted.

| Model | Notes |
| --- | --- |
| `opencode-go-responses/gpt-5.6-luna` | Strong. Costs money. |
| `opencode-go-responses/grok-4.6` | Strong. Costs money. |
| `opencode-go-chat/glm-5.3-flash` | Fast. |
| `opencode-go-chat/deepseek-v4.1-flash` | Fast. |
| `opencode-go-chat/mimo-v2.5` | Reasoning levels disabled. |
| `opencode-go-chat/nemotron-3-ultra-free` | Free, currently disabled. |
| `opencode-go-chat/nemotron-3.5-lightning-free` | Free, currently disabled. |
