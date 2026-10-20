// Runs every check-*.mjs in parallel. --json prints a one-line summary last; exit 1 on any failure.
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const json = process.argv.includes('--json');
const only = process.argv.slice(2).filter(a => !a.startsWith('--'));
const dir = fileURLToPath(new URL('.', import.meta.url));
const checks = (await readdir(dir)).filter(f => /^check-.*\.mjs$/.test(f) && (!only.length || only.some(o => f.includes(o)))).sort();
const limit = Number(process.env.MARS_CHECK_CONCURRENCY || 4);
const results = [];
let next = 0;
async function worker() {
  while (next < checks.length) {
    const file = checks[next++];
    const started = Date.now();
    const result = await new Promise(resolve => {
      const child = spawn(process.execPath, [file], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
      let log = '';
      child.stdout.on('data', d => { log += d; }); child.stderr.on('data', d => { log += d; });
      const timer = setTimeout(() => child.kill('SIGKILL'), Number(process.env.MARS_CHECK_TIMEOUT_MS || 180000));
      child.on('close', code => { clearTimeout(timer); resolve({ file, code, ms: Date.now() - started, log: log.slice(-1500) }); });
    });
    results.push(result);
    if (!json) console.log((result.code === 0 ? 'ok   ' : 'FAIL ') + file + ' ' + result.ms + 'ms' + (result.code === 0 ? '' : '\n' + result.log));
  }
}
const started = Date.now();
await Promise.all(Array.from({ length: Math.min(limit, checks.length) }, worker));
const failed = results.filter(r => r.code !== 0);
const summary = { ok: failed.length === 0 && checks.length > 0, total: checks.length, ms: Date.now() - started, passed: results.filter(r => r.code === 0).map(r => r.file).sort(), failed: failed.map(({ file, code, log }) => ({ file, code, log })) };
if (json) console.log(JSON.stringify(summary)); else console.log((summary.ok ? 'All ' : failed.length + ' of ') + checks.length + ' checks ' + (summary.ok ? 'passed' : 'failed') + ' in ' + summary.ms + 'ms');
process.exit(summary.ok ? 0 : 1);
