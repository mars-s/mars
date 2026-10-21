# Harness config versions

Each file is one immutable version, named by its content hash (docs/HARNESS-LOOP.md).
Do not edit a file; `loadConfig` refuses any file whose content does not hash to its name.

- `f7877a555c76`: `HOST-GUIDE.md` as committed, no overrides. The base.
- `c8b8ffde0ff1`: base plus the "Answering" paragraph at the top of the guide. Promoted in round 1.
- `75c07ae17503`: `c8b8ffde0ff1` plus a `worker_stop` description override. Promoted in round 4, within noise.
- Others are rejected candidates, kept so every row in `.agents/goals/harness-rounds.tsv` resolves to its text.

Promotion here changes only the loop's parent. Adopting any of this text in `HOST-GUIDE.md`
or a tool's description is a separate decision for the main thread.
