// The files that judge a change to Mars (docs/SELF-EDIT.md "Trust boundary"). The agent may
// not change them through self_edit_* or host_deploy; only the owner does, outside those
// tools (for example `npm run host:deploy`). Used by self-edit.mjs and dev-tools.mjs.
export const PROTECTED = [
  [/^packages\/pi-host\/run-checks\.mjs$/, 'runs the checks and decides pass or fail'],
  [/^packages\/pi-host\/deploy-watchdog\.sh$/, 'applies a deploy and rolls back an unhealthy host'],
  [/^packages\/pi-host\/dev-tools\.mjs$/, 'is the deploy gate (staging, checks and the test boot)'],
  [/^packages\/pi-host\/self-edit\.mjs$/, 'is the self-edit guard'],
  [/^packages\/pi-host\/protected-files\.mjs$/, 'is this list'],
  [/^packages\/pi-host\/harness\/(promotion|runner|round|config|tasks-dev|tasks-heldout)\.mjs$/, 'scores and promotes harness changes'],
  [/^packages\/pi-host\/scripts\/eval-tools-small-model\.mjs$/, 'measures tool changes'],
  [/^\.agents\/goals\/[^/]*\.tsv$/, 'is a decision or evaluation record'],
  [/^packages\/pi-host\/tool-quality\.mjs$/, 'holds the tool-quality rules'],
  [/^packages\/pi-host\/security\.mjs$/, 'holds owner authentication, origins and data roots'],
  [/^packages\/pi-host\/extension-store\.mjs$/, 'decides which extensions and tool names may be installed'],
  [/^packages\/pi-host\/ui-patches\.mjs$/, 'is the UI patch validation gate'],
  [/^packages\/pi-host\/workbench\/test-host\.mjs$/, 'is the test host many checks share'],
  [/^packages\/pi-host\/tsconfig\.json$/, 'holds the names and imports check settings'],
  [/^scripts\/(check-[^/]*|test-[^/]*|run-script-tests)\.mjs$/, 'is a root gate or its test'],
  [/^architecture-policy\.json$/, 'holds the workspace boundary rules'],
  [/^(AGENTS\.md|\.agents\/DECISIONS\.md|\.agents\/verification\.md|docs\/SELF-EDIT\.md)$/, 'holds the rules for changing Mars'],
  [/^(\.gitignore|\.github\/.*)$/, 'decides what may be committed, or runs CI'],
];
export const NEVER = [
  [/(^|\/)node_modules(\/|$)/, 'is installed dependencies, never committed'],
  [/(^|\/)\.env(\.[^/]+)?$/, 'may hold secrets, never committed'],
  [/\.(sqlite|db)(-wal|-shm)?$/, 'is a database, never committed'],
];
export const EXISTING_CHECK = /^packages\/pi-host\/check-[^/]*\.mjs$/;

/** Why each change may not be part of a self-edit. `changes` are git name-status rows. */
export function guardChanges(changes) {
  const refused = [];
  for (const { status, path } of changes) {
    if (path.endsWith('.env.example')) continue;
    const never = NEVER.find(([pattern]) => pattern.test(path));
    const rule = PROTECTED.find(([pattern]) => pattern.test(path));
    if (never) refused.push({ path, reason: path + ' ' + never[1] + '.' });
    else if (rule) refused.push({ path, reason: path + ' ' + rule[1] + '; only the owner changes it.' });
    else if (EXISTING_CHECK.test(path) && status !== 'A') refused.push({ path, reason: path + ' is an existing check; a self-edit may add a check but not change or delete one.' });
  }
  return refused;
}

