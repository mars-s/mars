// Held-out set: frozen, scored only for the promotion decision (docs/HARNESS-LOOP.md).
// The proposer never imports this file and never receives its requests or misses; only
// counts leave the runner. Requests here differ from every dev request. Do not tune
// tool or guide text against these, and do not edit a task once rounds have used it.
export const HELDOUT_TASKS = [
  { request: 'Show the current git branch and status for the repo in projects/site.', tool: 'host_exec', wants: (a) => /\bgit\b/.test(a.command) },
  { request: 'Open /etc/hosts and show me what is in it.', tool: 'host_read', wants: (a) => a.path === '/etc/hosts' },
  { request: "Search saved output 9d8e7f60-1a2b-4c3d-8e9f-0a1b2c3d4e5f for the word 'timeout'.", tool: 'artefact_search', wants: (a) => a.id === '9d8e7f60-1a2b-4c3d-8e9f-0a1b2c3d4e5f' && /timeout/i.test(a.query) },
  { request: 'Look up on the internet when the Melbourne Cup is run this year.', tool: 'web_search', wants: (a) => /melbourne cup/i.test(a.query) },
  { request: 'Get me the text of the page https://example.com/changelog.', tool: 'web_fetch', wants: (a) => a.url === 'https://example.com/changelog' },
  { request: "Have a helper model translate 'good morning' into French and tell me what it says.", tool: 'worker_run', wants: (a) => /good morning/i.test(a.task) },
  { request: 'At the same time, have separate helpers write a haiku about rain and a haiku about sun.', tool: 'worker_fanout', wants: (a) => a.jobs.length === 2 },
  { request: 'Cancel workflow wf-5521 right now, including the step it is on.', tool: 'workflow_stop', wants: (a) => a.workflowId === 'wf-5521' },
  { request: "Start a separate side chat titled 'Trip plan' to plan a weekend in Ballarat, so I can follow it on its own.", tool: 'side_chat_open', wants: (a) => /trip/i.test(a.title ?? '') },
  { request: 'I want to download charts/sales.png from the workspace. Give me a link to it.', tool: 'workspace_file_link', wants: (a) => a.path === 'charts/sales.png' },
  { request: 'Switch the web-search plugin off completely.', tool: 'plugin_configure', wants: (a) => a.name === 'web-search' && a.enabled === false },
  { request: 'I will do three things myself: read the logs, find the crash, write a fix. Show the owner that checklist with nothing started yet.', tool: 'plan_update', wants: (a) => a.steps.length === 3 && a.steps.every((s) => s.status === 'pending') },
  { request: 'What channels are there in my Discord server?', tool: 'discord_list_channels', wants: () => true },
  { request: 'Interface change p-8812 passed validation. Make it live in the Mars interface.', tool: 'ui_patch_promote', wants: (a) => a.id === 'p-8812' },
  { request: 'Check on host deploy d-204. Did it go through?', tool: 'host_deploy_status', wants: (a) => a.id === 'd-204' },
];
