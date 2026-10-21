// Dev set: the proposer sees these requests and their misses (docs/HARNESS-LOOP.md).
// Each task is one request, the tool that should handle it, and `wants(args)`, which says
// whether the arguments mean what was asked. Only tools installed on main are used.
const ID = '3f2b9c1e-8a4d-4f6e-9b1a-2c7d5e8f0a13';

export const DEV_TASKS = [
  { request: 'Run `npm run lint` inside the apps/ui folder and show me the result.', tool: 'host_exec', wants: (a) => /npm run lint/.test(a.command) },
  { request: 'Read the first 4000 bytes of /var/log/system.log.', tool: 'host_read', wants: (a) => a.path === '/var/log/system.log' },
  { request: 'Append the line "backup done" to /var/tmp/mars-notes.txt.', tool: 'host_write', wants: (a) => a.path === '/var/tmp/mars-notes.txt' && a.append === true && /backup done/.test(a.content) },
  { request: `The last command printed a lot of output with saved id ${ID}. Read the next part of it starting at byte 4096.`, tool: 'artefact_read', wants: (a) => a.id === ID && a.offset === 4096 },
  { request: `Find every line containing 'Error' in saved output ${ID}.`, tool: 'artefact_search', wants: (a) => a.id === ID && a.query === 'Error' },
  { request: 'What is the latest stable version of Node.js? Look it up online.', tool: 'web_search', wants: (a) => /node/i.test(a.query) },
  { request: 'Read the full page at https://nodejs.org/en/about/previous-releases.', tool: 'web_fetch', wants: (a) => a.url === 'https://nodejs.org/en/about/previous-releases' },
  { request: 'Ask a cheap fast helper model to summarise notes/README.md in three bullet points, and wait for its answer.', tool: 'worker_run', wants: (a) => /README/i.test(a.task) && (!a.model || a.model === 'luna') },
  { request: 'Review three files at the same time: review a.ts, b.ts and c.ts for bugs, each by its own helper.', tool: 'worker_fanout', wants: (a) => a.jobs.length === 3 },
  { request: 'Stop worker w-7f3a, it is taking too long.', tool: 'worker_stop', wants: (a) => a.workerId === 'w-7f3a' },
  { request: 'Have helper models do this in the background, in order: first research tide pools, then write a post from that research.', tool: 'workflow_start', wants: (a) => a.steps.length >= 2 },
  { request: 'How far along is workflow wf-91c2? Show me the steps that have finished.', tool: 'workflow_status', wants: (a) => a.workflowId === 'wf-91c2' },
  { request: "Open a side chat called 'Release names' that starts working on suggesting three release names. The owner wants to follow it separately.", tool: 'side_chat_open', wants: (a) => /release/i.test(a.title ?? '') && typeof a.task === 'string' },
  { request: "Send 'Make them shorter' to side chat 42.", tool: 'side_chat_send', wants: (a) => a.sideChatId === '42' && /shorter/i.test(a.text) },
  { request: 'Give the owner a link to download the file exports/report.csv.', tool: 'workspace_file_link', wants: (a) => a.path === 'exports/report.csv' },
  { request: 'Turn off the web_fetch tool of the web-search plugin.', tool: 'plugin_configure', wants: (a) => a.name === 'web-search' && a.tools?.web_fetch === false },
  { request: 'I am about to do these myself, one by one: find the video in the PR, work out a CDN URL, add the player, check it plays. Show the owner my checklist with the first step in progress.', tool: 'plan_update', wants: (a) => a.steps.length === 4 && a.steps[0].status === 'in_progress' },
  { request: 'Read the last 20 messages from Discord channel 1122334455.', tool: 'discord_read_messages', wants: (a) => a.channelId === '1122334455' && a.limit === 20 },
  { request: 'Read the interface source file components/shell/header.tsx before changing it.', tool: 'ui_source_read', wants: (a) => a.path === 'components/shell/header.tsx' },
  { request: 'Run the typecheck, lint and build on staged interface change p-3301.', tool: 'ui_patch_validate', wants: (a) => a.id === 'p-3301' },
  { request: 'Show me the extensions I built and installed into Mars.', tool: 'list_extensions', wants: () => true },
  { request: 'Check whether deploying commit 4be1c2d to the host would work, without restarting anything.', tool: 'host_deploy', wants: (a) => a.ref === '4be1c2d' && a.dryRun === true },
  { request: 'Check whether the latest host deploy finished or rolled back.', tool: 'host_deploy_status', wants: () => true },
];
