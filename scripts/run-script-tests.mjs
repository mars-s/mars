import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

async function tests(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await tests(path));
    else if (/^(test-.+|.+\.test)\.mjs$/.test(entry.name)) found.push(path);
  }
  return found.sort();
}
const files = await tests(fileURLToPath(new URL('.', import.meta.url)));
if (!files.length) throw Error('No script tests found');
const child = spawn(process.execPath, ['--test', ...files], { stdio: 'inherit' });
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('close', code => { process.exitCode = code ?? 1; });
