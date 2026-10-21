// Stand-in for "composio proxy" in check-github-sync.mjs: serves github-fake.mjs over the
// same arguments, stdin body and output shape as the real CLI (Status line on stderr).
import { createFakeGithub } from './github-fake.mjs';

const args = process.argv.slice(2);
const mode = process.env.FAKE_COMPOSIO_MODE;
if (mode === 'logged_out') { console.error('You are not logged in yet. Please run `composio login`.'); process.exit(1); }
if (mode === 'unlinked') { console.error('No active connection found for toolkit "github". Run `composio link github`, then retry.'); process.exit(1); }
const at = (flag) => args[args.indexOf(flag) + 1];
if (args[0] !== 'proxy' || at('--toolkit') !== 'github') process.exit(9);
const url = new URL(args[1]);
let input = '';
for await (const chunk of process.stdin) input += chunk;
const d = args.indexOf('-d');
if (d >= 0 && args[d + 1] !== '-') { console.error('body on the command line'); process.exit(8); }
const body = d >= 0 ? JSON.parse(input) : undefined;
const r = await createFakeGithub({ bare: process.env.FAKE_BARE, remote: 'owner/repo' }).request(at('--method'), url.pathname, body);
if (!process.env.FAKE_NO_STATUS) console.error('Status: ' + r.status);
process.stdout.write(JSON.stringify(r.data, null, 2) + '\n');
