// One improvement round (docs/HARNESS-LOOP.md): score the parent, propose a candidate from
// dev evidence only, score the candidate, decide. Scoring, proposing and logging are passed
// in, so check-harness-loop.mjs runs the same round with a fake scorer and no model.
import { decide } from './promotion.mjs';
import { buildEvidence } from './proposer.mjs';
import { counts } from './runner.mjs';

/**
 * @param {object} o
 * @param {object} o.parent harness config
 * @param {(config, set: 'dev'|'held-out') => Promise<object>} o.score full result with misses
 * @param {({ parent, evidence, rows, complete }) => Promise<{ config, scope, target, source, rationale }|null>} o.propose
 * @param {object[]} o.devTasks dev requests, the only task text the proposer sees
 * @param {(row: object) => Promise<void>} o.log one row per score and one per decision
 */
export async function runRound({ round, parent, score, propose, devTasks, rows, complete, exclude, margin, log }) {
  const heldOut = async (config) => counts(await score(config, 'held-out'));
  const parentDev = await score(parent, 'dev');
  await log({ round, kind: 'score', role: 'parent', parentId: parent.parent, result: parentDev });
  const parentHeldOut = await heldOut(parent);
  await log({ round, kind: 'score', role: 'parent', parentId: parent.parent, result: parentHeldOut });
  const evidence = buildEvidence(parentDev, devTasks);
  const proposal = await propose({ parent, evidence, rows, complete, exclude });
  if (!proposal) {
    const decision = { promote: false, reason: 'keep parent: proposer had nothing to change' };
    await log({ round, kind: 'decision', parentId: parent.id, candidateId: '', decision, scores: { parentDev, parentHeldOut } });
    return { parent, next: parent, proposal: null, decision, scores: { parentDev, parentHeldOut } };
  }
  const candidate = proposal.config;
  if (candidate.parent !== parent.id) throw Error(`Candidate ${candidate.id} names parent ${candidate.parent}, not ${parent.id}`);
  const candidateDev = await score(candidate, 'dev');
  await log({ round, kind: 'score', role: 'candidate', parentId: parent.id, result: candidateDev });
  const candidateHeldOut = await heldOut(candidate);
  await log({ round, kind: 'score', role: 'candidate', parentId: parent.id, result: candidateHeldOut });
  const scores = { parentDev, parentHeldOut, candidateDev, candidateHeldOut };
  const decision = decide({ parentId: parent.id, candidateId: candidate.id, ...scores, margin });
  await log({ round, kind: 'decision', parentId: parent.id, candidateId: candidate.id, decision, proposal, scores });
  return { parent, next: decision.promote ? candidate : parent, proposal, decision, scores };
}
