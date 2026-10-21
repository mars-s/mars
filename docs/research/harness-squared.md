# Harness² research note

Researched 2026-10-21. Sources were read directly. Paper text comes from the arXiv PDF (v1, 9 Oct 2026) and repository docs come from the `main` branch on the same day.

## Summary

1. A primary source exists. It is the arXiv paper [Harness^2: Recursive Agent Harnessing for an Open World (arXiv:2610.14224)](https://arxiv.org/abs/2610.14224) by Northwestern University and Google Cloud AI Research, with code at [google-research/harness2](https://github.com/google-research/harness2) and a [project page](https://harness2.github.io).
2. The brief's premise is partly wrong. Harness² does not pick harnesses by scoring them on a held-out set. It edits the harness for each new task by rerunning that task and comparing behaviour, with no grader in the loop ([abstract](https://arxiv.org/abs/2610.14224), [§2.2](https://arxiv.org/pdf/2610.14224)).
3. The offline "search configs, score on a dev split, promote the best" pattern belongs to Meta-Harness, which the paper uses as a baseline ([Appendix C](https://arxiv.org/pdf/2610.14224), [Meta-Harness](https://arxiv.org/abs/2603.28052)).
4. One Harness² step gains up to 11.5 points on WorkBuddy-Bench, 4.5 on JobBench and 11.8 percentage points on LAB, at the price of extra executions per task ([abstract](https://arxiv.org/abs/2610.14224), [Appendix F](https://arxiv.org/pdf/2610.14224)).
5. For Mars, the most useful ideas are a file-per-component harness, scoped proposers, "keep the base" as a valid outcome, grader isolation and an evidence-backed lesson library. Scoring on a held-out set before promotion still needs to come from the Meta-Harness side.

## What the source actually says

All section and appendix references point to the [arXiv PDF](https://arxiv.org/pdf/2610.14224) unless another link is given.

### Who and what

- The authors are Ruiyao Xu (Northwestern, working as an intern at Google Cloud AI Research), Yanfei Chen, Zhongying CuiZhu, Bhavana Dalvi Mishra, Yifei Ming, Han Yu, Rujun Han, Chen-Yu Lee and Tomas Pfister ([arXiv abstract page](https://arxiv.org/abs/2610.14224), PDF title page).
- The code is Apache 2.0. The README says it "is not an officially supported Google product" ([README](https://github.com/google-research/harness2)).
- The paper defines a harness as the system around a frozen model, so Agent = Model + Harness. It calls the process of optimising that layer "harnessing" (§2.1).

### The harness is eight files

The paper adopts the file-level split from Agentic Harness Engineering and adds a plugin, giving K = 8 editable components (§2.1, Table 5):

| Component | File | When it reaches the model |
|---|---|---|
| System prompt | `systemprompt.md` | Every call |
| Guardrails | `guardrails.md` | Every call |
| Memory | `LongTermMEMORY.md` | Every call |
| Tool guidance | `tool_descriptions/tool_guidance.md` | Every call |
| Skills | `skills/<n>/SKILL.md` plus scripts | Only when invoked |
| Scripts | `scripts/<name>.py` | Run via bash |
| Subagents | `sub_agents/<n>/AGENT.md` | Own context, via the task tool |
| Plugin | `plugin/<name>.ts` | Inside the tool loop |

Each component is a file, "so an edit is a diff" (Table 5 caption). The editor prompt tells the model that always-on prose is the expensive option. It should prefer a skill, then a script, and use a plugin when a behaviour must be enforced rather than requested (Appendix H, Prompt 1).

### Task-level recursion: Propose, Probe, Compose

- **Propose.** Run the current harness once as a reference. The reference "reveals how the harness behaves, not whether its deliverable is correct." Two editors then propose candidates. The invariant editor targets general agent failures such as planning, tool use, context management and delegation. The domain editor targets knowledge and procedures for this task's domain (§2.2.1).
- **Probe.** Run each candidate on the same task under the same model and environment. The paper calls the comparison with the reference a "behavioral contrast". It warns that execution randomness and shared model biases limit how much this proves (§2.2.1).
- **Compose.** A composer reads the reference, the candidates, their diffs and the evidence. It may merge, revise, adopt one candidate, or keep the current harness. Each decision must be tied to a concrete observation (§2.2.1). The prompt says "KEEP_BASE is a real answer, not a failure" (Appendix H, Prompt 3).
- **Scaling.** Budget `k` controls width or depth. Parallel mode probes `k` invariant and `k` domain candidates and runs `k` independent compositions. Sequential mode chains `k` steps (§2.2.2, [README](https://github.com/google-research/harness2)).
- **Final pick.** For `k > 1`, a selector compares anonymised deliverables against the task request without seeing which harness made them. The paper marks the result as "adoption rather than verified optimality" (§2.2.2).

### Harnessing-level recursion: the improvement library

- After each task, a reflector reviews the whole improvement record. It keeps lessons only when execution contrasts support them. Selecting an output alone does not count as proof that a lesson transfers (§2.3).
- Each library entry holds the full adopted harness tree plus an `EXPERIENCE.md` with the situation, lessons and evidence. An index lists every entry. When evidence is thin, the reflector adds nothing (§2.3, Appendix D.2).
- The next task starts from the common base harness, not the last adopted one. Earlier components are reused only if the proposer picks them (§2.3). Each benchmark domain has its own library and tasks run in order within a domain (Appendix D.2).

### How evaluation is kept honest

This is the part closest to "held-out evaluation", and it applies to how the paper measures results, not to how the method selects harnesses.

- WorkBuddy-Bench is split in half by category and results come from the test halves. JobBench uses a frozen 31/34 split with results on the 34 test tasks. LAB uses a 24-task dev set and a disjoint 100-task held-out test set taken from an earlier Meta-Harness study (Appendix B).
- Only Meta-Harness touches the train or dev halves. Harness² and the other baselines process the test tasks as one stream from an empty library. Every score is the mean of three streams in shuffled order (Appendix B, §3.1).
- A guard refuses to give an improver session any directory containing a grader verdict, rubric or score. No improver prompt names a rubric, score or grader (Appendix D.2, Appendix H). The JobBench rubric is never shown to the executor, editor or selector (Appendix B).
- The repo warns that JobBench publishes each task's `RUBRICS.json`. In a validation run, a Codex rollout downloaded its task's rubric without being told to. The release does not restrict network access, so users must block those hosts at the network level ([EXPERIMENTS.md, Web access](https://github.com/google-research/harness2/blob/main/docs/EXPERIMENTS.md)).
- Invalid trees, such as a skill with no trigger sentence or a script that does not compile, are retried once with the validator's message. On a second failure the stage falls back to its starting tree and records the fallback (Appendix D.2).

### Results worth knowing

- Executors are Gemini 3.5 Flash and GLM-5 under OpenCode and Codex. The default editor is Claude Opus 4.8 (§3.1).
- One step lifts GLM-5 under OpenCode on WorkBuddy-Bench from 64.2 to 75.7. That beats base Gemini 3.5 Flash at 72.4 (Table 1, §3.2).
- Parallel recursion at `k = 5` adds 2.9 to 3.9 points on WorkBuddy-Bench, 3.0 to 4.2 on JobBench and 2.6 to 6.7 percentage points on LAB over one step (§3.2).
- On LAB with Gemini 3.5 Flash under Codex, Meta-Harness still leads (§3.2, Table 2).
- Ablation on WorkBuddy-Bench and JobBench: removing the library costs 3.1 and 1.8 points, removing scoped editors costs 2.9 and 3.7, and removing composition costs 1.6 and 1.9 (Table 3).
- Editing the base harness directly, without reference runs, probes or library, made WB-code fall from 73.4 to 63.2 and WB-web from 69.9 to 65.0 (§4, Figure 7).
- A library built on JobBench improved one-step refinement on WorkBuddy-Bench by 0.6, 0.5 and 2.9 points across its three domains (§4, Figure 7).
- Using the same model as executor and editor still improved all five models tested on every benchmark (§4, Figure 8).
- On compute, the paper reports both Harness² settings on the empirical Pareto frontier, counting execution and improvement tokens. Meta-Harness used more compute than Harness² at `k = 5` for lower scores (§4, Figure 6). The figure's x-axis is million tokens per task on a log scale.

### Limits the authors state

- Recursion adds executions and editor sessions, so cost grows with the budget. The authors only study a bounded range of budgets (Appendix F).
- Behavioural contrasts and model judgement "do not guarantee correctness or establish that an adopted change will transfer to a different task" (Appendix F).
- The library is a simple index. Consolidating it, retiring stale lessons and stopping early when probes add little are listed as future work (Appendix G).

## Closest related work

Harness² was found, so this section only covers the offline methods the brief seemed to have in mind. These are **closest related, not Harness²**. The paper's own Table 4 classes DSPy, GEPA, ADAS, Meta-Harness and AHE as offline and label-supervised, which Harness² is not ([Table 4](https://arxiv.org/pdf/2610.14224)).

- **Meta-Harness (closest related, not Harness²).** It is an outer loop that searches harness code. Its proposer reads the source, scores and traces of every prior candidate through a filesystem ([arXiv:2603.28052](https://arxiv.org/abs/2603.28052)). In the Harness² baseline setup, each iteration evaluates candidates on the whole search set and accepts the best only if it beats the frontier by a margin. The settings were 10 iterations, 2 candidates, 3 replicates per task and a 0.01 margin ([Harness² Appendix C](https://arxiv.org/pdf/2610.14224)).
- **Agentic Harness Engineering, AHE (closest related, not Harness²).** It gives every component a revertible file, condenses trajectories into drill-down evidence, and pairs each edit with a prediction checked against the next round's results. Ten iterations raised Terminal-Bench 2 pass@1 from 69.7% to 77.0% ([arXiv:2604.25850](https://arxiv.org/abs/2604.25850)).
- **OPRO, Google DeepMind (closest related, not Harness²).** The model sees earlier prompts with their scores and proposes new ones, which are scored and fed back ([arXiv:2309.03409](https://arxiv.org/abs/2309.03409)).
- **GEPA (closest related, not Harness²).** It reflects on trajectories in plain language and combines lessons from a Pareto frontier of its own attempts. It reports beating GRPO with up to 35x fewer rollouts ([arXiv:2507.19457](https://arxiv.org/abs/2507.19457)).
- **ADAS (closest related, not Harness²).** A meta agent writes new agents in code, building on an archive of earlier discoveries ([arXiv:2408.08435](https://arxiv.org/abs/2408.08435)).
- **DSPy (closest related, not Harness²).** It compiles declarative LM pipelines and optimises their prompts ([arXiv:2310.03714](https://arxiv.org/abs/2310.03714)).

## Lessons for Mars

Mars is a single-owner host where Pi owns conversations and tasks, and new external account actions need the owner's instruction ([AGENTS.md](../../AGENTS.md), [MONOREPO.md](../MONOREPO.md)). That shapes which parts transfer.

### 1. Versioned harness configs

Store the harness as a tree of plain files and treat each version as an immutable, content-hashed snapshot. Harness² makes every component a file so that an edit is a diff ([Table 5](https://arxiv.org/pdf/2610.14224)). AHE gives the same reason for revertibility ([arXiv:2604.25850](https://arxiv.org/abs/2604.25850)). Mars should record the active harness version on every task so any score can be traced to the exact files that produced it.

Validate a candidate tree before running it, with one retry and then a fall back to the parent. This copies Harness²'s validator rule ([Appendix D.2](https://arxiv.org/pdf/2610.14224)).

### 2. Dev set vs held-out set

Harness² itself has no held-out set in the loop. Mars should not copy that part. A personal host has no benchmark grader, and the paper admits its self-judged signals do not guarantee correctness ([Appendix F](https://arxiv.org/pdf/2610.14224)).

Use the paper's evaluation discipline instead:

- Keep a small dev set for proposing and a disjoint, frozen held-out set for promotion. LAB's 24 dev and 100 test tasks are a working example of the split ([Appendix B](https://arxiv.org/pdf/2610.14224)).
- Build both from replayable past Mars tasks with fixed inputs. Probing reruns the same task several times ([§2.2.1](https://arxiv.org/pdf/2610.14224)). That is only safe in a sandbox with no live accounts, because Mars must not repeat external actions.
- Keep rubrics and scores out of every directory and network host the agent can reach. The Harness² team saw a rollout fetch its own rubric from the web ([EXPERIMENTS.md](https://github.com/google-research/harness2/blob/main/docs/EXPERIMENTS.md)).

### 3. How variants get proposed

- Split proposers by scope. One proposer fixes general agent behaviour. The other fixes domain knowledge. Removing this split cost 2.9 and 3.7 points ([Table 3](https://arxiv.org/pdf/2610.14224)).
- Feed the proposer real traces. Editing without reference runs dropped WB-code by over 10 points ([Figure 7](https://arxiv.org/pdf/2610.14224)). Meta-Harness's main claim is that richer access to prior experience is what makes automated harness work possible ([arXiv:2603.28052](https://arxiv.org/abs/2603.28052)).
- Require each edit to cite a specific trajectory moment. Treat a failure seen in one of `k` base runs as noise ([Appendix H, Prompt 3](https://arxiv.org/pdf/2610.14224)).
- Prefer on-demand forms. Mars skills and scripts should beat always-on prompt text, and hooks should enforce hard rules ([Appendix H, Prompt 1](https://arxiv.org/pdf/2610.14224)).

### 4. How promotion gets decided

- The default outcome is "keep the current harness" ([Appendix H, Prompt 3](https://arxiv.org/pdf/2610.14224)).
- Promote only when the candidate beats the current version on the held-out set by a fixed margin over several replicates. That is the Meta-Harness acceptance rule as run in the paper ([Appendix C](https://arxiv.org/pdf/2610.14224)). The exact margin for Mars is a choice to tune, not something the sources settle.
- Veto any candidate whose run produced no output. The composer prompt calls such edits unsafe unless the evidence is overwhelming ([Appendix H, Prompt 3](https://arxiv.org/pdf/2610.14224)).
- Have the owner approve promotion. Mars rules already require owner instruction for consequential actions ([AGENTS.md](../../AGENTS.md)).

### 5. Overfitting risks

- Per-task edits can be tailored too tightly. The paper says inheriting a tailored harness causes noisy improvement as tasks shift, which is why each task restarts from the base ([§1, §2.3](https://arxiv.org/pdf/2610.14224)).
- Judges share biases with editors. Behavioural contrasts are sensitive to randomness and shared model bias ([Appendix F](https://arxiv.org/pdf/2610.14224)). Mars should use a deterministic check wherever one exists.
- Leaked grading criteria inflate scores without any real gain ([EXPERIMENTS.md](https://github.com/google-research/harness2/blob/main/docs/EXPERIMENTS.md)).
- A frozen held-out set slowly gets learned by repeated promotion. None of the sources measure this for a personal host. Rotating a few fresh tasks in over time is my inference, not a finding.

### 6. Lesson library

Keep one `EXPERIENCE.md` per adopted version that states the situation, the lesson and its evidence, plus an index. Write nothing when evidence is thin ([§2.3, Appendix D.2](https://arxiv.org/pdf/2610.14224)). The library carried the largest ablation loss on WorkBuddy-Bench ([Table 3](https://arxiv.org/pdf/2610.14224)).

### 7. Cost

- Every probe is a full task run, and cost grows with `k` ([Appendix F](https://arxiv.org/pdf/2610.14224)). The paper's compute chart is in millions of tokens per task ([Figure 6](https://arxiv.org/pdf/2610.14224)), which is a lot for one person's API bill.
- Start at `k = 1`. One step delivered most of the reported gain, and `k = 5` added a few more points ([§3.2](https://arxiv.org/pdf/2610.14224)).
- Run the loop as an offline batch job over replayed tasks with a hard token cap, not on every live request. The paper lists adaptive budgets and early stopping as unsolved ([Appendix G](https://arxiv.org/pdf/2610.14224)).
- A cheaper editor is plausible, since same-model editing still helped every tested model ([Figure 8](https://arxiv.org/pdf/2610.14224)).

## Ranked decisions

| Decision | Adopt/Adapt/Reject | Evidence (link) |
|---|---|---|
| Harness as a file tree, one file per component, versions are content-hashed snapshots | Adopt | [Harness² Table 5](https://arxiv.org/pdf/2610.14224), [AHE](https://arxiv.org/abs/2604.25850) |
| Frozen disjoint dev and held-out sets built from replayable past tasks | Adapt | [Harness² Appendix B](https://arxiv.org/pdf/2610.14224) |
| Grader isolation, so no rubric or score is reachable by the agent's files or network | Adopt | [Appendix D.2](https://arxiv.org/pdf/2610.14224), [EXPERIMENTS.md](https://github.com/google-research/harness2/blob/main/docs/EXPERIMENTS.md) |
| Promote only above a fixed margin over replicates on held-out, with owner approval | Adapt | [Appendix C, Meta-Harness settings](https://arxiv.org/pdf/2610.14224), [AGENTS.md](../../AGENTS.md) |
| "Keep current harness" is the default composer outcome, and an empty run vetoes an edit | Adopt | [Appendix H, Prompt 3](https://arxiv.org/pdf/2610.14224) |
| Two scoped proposers, one for general behaviour and one for domain | Adopt | [Table 3](https://arxiv.org/pdf/2610.14224) |
| Proposers read real traces and cite a specific moment per edit | Adopt | [Figure 7](https://arxiv.org/pdf/2610.14224), [Meta-Harness](https://arxiv.org/abs/2603.28052) |
| Prefer skills, scripts and hooks over always-on prompt text | Adopt | [Appendix H, Prompt 1](https://arxiv.org/pdf/2610.14224) |
| Lesson library with `EXPERIENCE.md` and an index, written only with evidence | Adopt | [§2.3, Table 3](https://arxiv.org/pdf/2610.14224) |
| Validate candidate trees, retry once, then fall back to parent | Adopt | [Appendix D.2](https://arxiv.org/pdf/2610.14224) |
| Offline batch loop at `k = 1` with a hard token cap | Adapt | [§3.2, Appendix F](https://arxiv.org/pdf/2610.14224) |
| Per-live-task Propose, Probe, Compose with reruns of the owner's real task | Reject | [§2.2.1](https://arxiv.org/pdf/2610.14224), [AGENTS.md](../../AGENTS.md) |
| Promote on self-judged behavioural contrast alone, with no held-out score | Reject | [Appendix F](https://arxiv.org/pdf/2610.14224) |
| Carry the last adopted harness forward as the next base automatically | Reject | [§1, §2.3](https://arxiv.org/pdf/2610.14224) |
