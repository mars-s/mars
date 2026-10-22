// The promotion rule (docs/HARNESS-LOOP.md). Keeping the parent is the default. A
// candidate is promoted only when it beats the parent on the dev set by at least
// `margin` fully correct runs and scores no lower than the parent on the held-out set.
// Every score must come from the config it claims, on the same tools, model and runs.
// This file has no imports so check-harness-loop.mjs can load a mutated copy of it.

export const DEFAULT_MARGIN = 2;

const SAME = ['model', 'toolsHash', 'runs', 'total'];

function bound(result, configId, set) {
  if (!result || result.configId !== configId) throw Error(`A ${set} score for ${result?.configId} was offered as the score for ${configId}`);
  if (result.set !== set) throw Error(`A ${result.set} score was offered as the ${set} score for ${configId}`);
  return result;
}

function comparable(a, b) {
  for (const key of SAME) if (a[key] !== b[key]) throw Error(`${a.set} scores differ in ${key} (${a[key]} vs ${b[key]}), so they cannot be compared`);
}

/** @returns {{ promote: boolean, devGain: number, heldOutDelta: number, reason: string }} */
export function decide({ parentId, candidateId, parentDev, candidateDev, parentHeldOut, candidateHeldOut, margin = DEFAULT_MARGIN }) {
  if (!(Number.isInteger(margin) && margin >= 1)) throw Error('margin must be a whole number of at least 1');
  if (parentId === candidateId) throw Error('candidate is the parent config');
  bound(parentDev, parentId, 'dev');
  bound(candidateDev, candidateId, 'dev');
  bound(parentHeldOut, parentId, 'held-out');
  bound(candidateHeldOut, candidateId, 'held-out');
  comparable(parentDev, candidateDev);
  comparable(parentHeldOut, candidateHeldOut);
  const devGain = candidateDev.fullyCorrect - parentDev.fullyCorrect;
  const heldOutDelta = candidateHeldOut.fullyCorrect - parentHeldOut.fullyCorrect;
  if (devGain < margin) return { promote: false, devGain, heldOutDelta, reason: `keep parent: dev gain ${devGain} is below the margin of ${margin}` };
  if (heldOutDelta < 0) return { promote: false, devGain, heldOutDelta, reason: `keep parent: held-out fell by ${-heldOutDelta}` };
  return { promote: true, devGain, heldOutDelta, reason: `promote: dev +${devGain} (margin ${margin}), held-out ${heldOutDelta >= 0 ? '+' : ''}${heldOutDelta}` };
}
