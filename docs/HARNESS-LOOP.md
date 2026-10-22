# Harness loop

The harness is everything around the model that Mars controls: the system guide
(`packages/pi-host/HOST-GUIDE.md`), the tool descriptions and any context notes. The
harness loop proposes changes to that text, scores them with a local model and keeps a
change only when it helps on tasks the proposer never saw. It never changes model
weights. A "better" harness is better text for the same frozen model.

This is the Meta-Harness side of `docs/research/harness-squared.md`: an offline batch
loop at `k = 1` with a dev set for proposing and a frozen held-out set for promotion.
Harness² ideas it keeps are content-hashed versions, scoped proposers, "keep the parent"
as the default and proposals that cite evidence.

## Config versions

A version is `{ id, parent, systemGuide, toolOverrides, contextNotes }`
(`packages/pi-host/harness/config.mjs`).

- `systemGuide` is the full system message text. The base version is `HOST-GUIDE.md`
  as committed.
- `toolOverrides` maps a tool name to a replacement description. Overrides for unknown
  tools are refused.
- `contextNotes` is appended to the system message.
- `id` is the first 12 hex characters of the SHA-256 of the other four fields as
  canonical JSON. Same content gives the same id; a one-character edit gives a new one.
  The parent is part of the content, so the same text reached by two routes has two ids.

Versions are saved as `packages/pi-host/harness/configs/<id>.json`, written once. Loading
a file whose content does not hash to its id fails, so a hand-edited version is refused.

## Task sets

Each task is a request, the tool that should handle it, and `wants(args)`, which says
whether the arguments mean what was asked. Only tools installed on main are used.

- Dev, `harness/tasks-dev.mjs`, 23 tasks. The proposer sees these requests and their
  misses.
- Held-out, `harness/tasks-heldout.mjs`, 15 tasks. Different requests, mostly
  different wording for the same tools plus tools dev does not cover
  (`workflow_stop`, `discord_list_channels`, `ui_patch_promote`). Frozen once rounds
  have used it.

Held-out isolation has three parts. The proposer, round and runner modules never import
`tasks-heldout.mjs`. The round reduces held-out results to counts before anything else
sees them. The TSV log records held-out counts only. `check-harness-loop.mjs` proves all
three, including a round where every held-out miss carries its request text and none of
it reaches the proposer or the log.

## Runner

`scoreConfig` (`harness/runner.mjs`) takes a config and a task set. It dumps the real
tools with `MARS_DUMP_TOOLS` as `scripts/eval-tools-small-model.mjs` does, drops the
upstream tools, applies the config's overrides and sends each request `runs` times
(default 3, temperature 0.7) to Ollama `qwen2.5:1.5b` at `http://127.0.0.1:11434`, with
the config's system message.

Each run counts as right (expected tool), valid (arguments pass the tool's schema) and
fully correct (valid and `wants(args)` holds). A miss is `no-call` (the model answered
in text), `wrong-tool` or `bad-args`. The result is
`{ configId, set, model, toolsHash, runs, right, valid, fullyCorrect, total, misses }`.
`toolsHash` is a hash of the dumped tools, so a score is bound to the config, the tool
text it ran against and the model.

## Proposer

`harness/proposer.mjs` makes at most one candidate per round from the parent's dev
misses. It has two scopes.

- General. When at least half of the dev misses are plain-text answers with no tool
  call, it adds a fixed "Answering" paragraph to the top of the guide.
- Tool. Otherwise it takes the tool with the most dev misses that has no override yet and
  asks the local model to rewrite that tool's description from the failing requests.
  The rewrite must pass the `tool-quality.mjs` rules and keep the `Example:` line. A
  failing rewrite gets one retry with the problems listed, then falls back to a
  rule-based sentence naming the requests and the wrong pick.

For a tool rewrite the local model writes only the middle guidance sentences. The code
keeps the summary line and the `Example:` line. Asked for the whole description, the 1.5B
model dropped both in all six tries of the first run.

A target rejected from a parent is not proposed again from that parent. No paid or
external model is used. A stronger proposer through OpenCode Go was not added: the 1Password
CLI had no signed-in session, so the key could not be read at runtime.

## Promotion

`harness/promotion.mjs` decides. Keeping the parent is the default. The candidate is
promoted only when both hold:

- dev fully correct is at least the parent's plus the margin (default 2 runs), and
- held-out fully correct is at least the parent's.

Scores must name the config and set they are offered for, and both sides of a comparison
must share model, tools hash, runs and total. Otherwise the decision throws.

Promotion moves the loop's parent to the candidate. It does not change Mars. Adopting a
promoted guide or description in `HOST-GUIDE.md` or a tool file is a separate,
owner-reviewed change.

## Running it

```sh
ollama serve &   # qwen2.5:1.5b pulled
cd packages/pi-host
node harness/loop.mjs --rounds 2 --runs 3 [--margin 2] [--from <config id>] [--rule-only]
```

Each round scores the parent on dev and held-out, proposes, scores the candidate on both
and decides. The parent is rescored every round, which shows run-to-run noise. Every
score and decision is appended to `.agents/goals/harness-rounds.tsv` with the config id,
parent id, model and tools hash. A round takes about 3 minutes on an M4 Pro.

`node check-harness-loop.mjs` runs in `run-checks.mjs` with a fake scorer and no network.
It covers the promotion rule, a mutation run without the held-out guard, content-hash
binding and tamper refusal, and held-out isolation.

## Limits

- The scorer is a 1.5B model offered every tool with one user message. It measures
  whether text steers a small model to the right first call, not whether the full agent
  finishes a task.
- With 3 runs at temperature 0.7, scores move by a few runs between identical calls. A
  2-run margin on 69 dev runs is a low bar. In the first rounds the same config scored
  45 to 50 on dev and 21 to 28 on held-out across four rescoring passes. Only a gain far
  above that spread, such as the first round's +15, is clearly real.
- The held-out set is small and gets reused. Each promotion learns a little about it
  through the yes or no. Rotate in new held-out tasks over time.
- Tasks are synthetic requests, not replays of past Mars tasks.

## Adopting a config

A promotion from the loop is a candidate, not a change. Before copying a promoted config
into HOST-GUIDE.md or a tool, run `node harness/confirm.mjs <parent> <candidate>`, which
scores both on held-out several times, interleaved, and adopt only when the ranges do not
overlap. Adopted so far:

| Config | What | Held-out, 4 repeats x 3 runs, fully correct of 45 | Adopted |
| --- | --- | --- | --- |
| c8b8ffde0ff1 | "Answering" paragraph at the top of the guide | parent f7877a555c76: 15, 14, 11, 9 (mean 12.25); candidate: 26, 27, 27, 21 (mean 25.25) | Yes, 22 October 2026, into HOST-GUIDE.md |
| 75c07ae17503 | worker_stop description override (round 4) | Not confirmed: its gain was inside the noise band | No |
