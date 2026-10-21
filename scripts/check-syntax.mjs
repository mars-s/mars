import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
// Host modules live in subdirectories too (packages/pi-host/workbench); skip dependencies.
async function check(directory) {
  for (const entry of await readdir(root + directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (directory !== 'scripts' && !['node_modules', 'public'].includes(entry.name) && !entry.name.startsWith('.')) await check(directory + '/' + entry.name);
      continue;
    }
    if (!entry.name.endsWith('.mjs')) continue;
    const result = spawnSync(process.execPath, ['--check', root + directory + '/' + entry.name], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
for (const directory of ['scripts', 'packages/pi-host']) await check(directory);
console.log('JavaScript syntax checks passed');
