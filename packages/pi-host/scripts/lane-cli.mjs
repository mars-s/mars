// Drive lanes from a shell while the running host predates them (docs/LANES.md).
// Usage: node scripts/lane-cli.mjs <start|preview|submit|list|close> '{"json":"args"}'
import { createLanes } from '../lanes.mjs';
import { REPO, ROOT } from '../security.mjs';

const [command, raw = '{}'] = process.argv.slice(2);
const lanes = createLanes({ repo: REPO, root: ROOT });
const args = JSON.parse(raw);
const actions = { start: () => lanes.start(args), preview: () => lanes.preview(args), submit: () => lanes.submit(args), list: () => lanes.list(), close: () => lanes.close(args) };
if (!actions[command]) throw Error('Expected start, preview, submit, list or close');
console.log(JSON.stringify(await actions[command](), null, 2));
