import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { checkRuntime } from './check-runtime.mjs';
import { bootstrap, childEnvironment, configuration, loadEnvironment } from './setup.mjs';
import { createUpdater } from './update.mjs';

// Own each descendant group so Ctrl+C, systemd stop and one failed service stop the whole launch.
export async function supervise(commands, { env = process.env, graceMs = 5000, onSpawn } = {}) {
  const children = [];
  let stopping = false, exitCode = 0, timer;
  const kill = signal => {
    for (const child of children) {
      if (!Number.isInteger(child.pid)) continue;
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  };
  const stop = code => {
    if (stopping) return;
    stopping = true; exitCode = code;
    kill('SIGTERM');
    timer = setTimeout(() => kill('SIGKILL'), graceMs);
  };
  const onTerm = () => stop(0);
  process.on('SIGINT', onTerm); process.on('SIGTERM', onTerm);
  try {
    const finished = commands.map(command => {
      const child = spawn(command.file, command.args || [], { cwd: command.cwd, env, detached: process.platform !== 'win32', stdio: 'inherit' });
      children.push(child); onSpawn?.(child);
      return new Promise(resolve => {
        child.once('error', error => { console.error(`Could not start ${command.label}: ${error.message}`); stop(1); resolve(); });
        child.once('close', code => {
          if (code === 73 && command.lockPath) console.error(`Another Pi host already owns ${command.lockPath}. Stop it before starting a second host for this data root.`);
          stop(code ?? 1); resolve();
        });
      });
    });
    await Promise.all(finished);
    // A child leader may exit while one of its descendants ignores TERM. Finish escalation.
    if (timer) { clearTimeout(timer); kill('SIGKILL'); }
    return exitCode;
  } finally {
    clearTimeout(timer); process.off('SIGINT', onTerm); process.off('SIGTERM', onTerm);
  }
}
export function commands(config, mode, role = 'all') {
  if (!['development', 'production'].includes(mode)) throw Error('Use development or production mode');
  if (!['all', 'host', 'ui'].includes(role)) throw Error('Use all, host or ui role');
  if (role !== 'ui' && !config.flock) throw Error('Resolve flock through bootstrap before starting the Pi host');
  const require = createRequire(config.ui + '/package.json');
  const lockPath = config.root + '/data/host.lock';
  const runtime = config.runtime || config.root + '/app';
  return [
    ...(role !== 'ui' ? [{ label: 'Pi host', file: config.flock, args: ['--no-fork', '--nonblock', '--conflict-exit-code', '73', lockPath, process.execPath, runtime + '/server.mjs'], cwd: runtime, lockPath }] : []),
    ...(role !== 'host' ? [{ label: 'Mars UI', file: process.execPath, args: [require.resolve('next/dist/bin/next'), mode === 'development' ? 'dev' : 'start', ...(mode === 'development' ? ['--turbopack'] : []), '--hostname', '127.0.0.1', '--port', config.uiPort], cwd: config.ui }] : []),
  ];
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  checkRuntime(); loadEnvironment();
  const mode = process.argv[2] || 'development', role = process.argv[3] || 'all';
  const config = await bootstrap(configuration());
  // An update killed while switching over is undone before anything starts (docs/UPDATES.md).
  const recovered = await createUpdater(config).recover();
  if (recovered) console.log(`Mars update ${recovered.id}: ${recovered.outcome}. ${recovered.detail}`);
  if (role === 'all') console.log(`Mars ${mode}. Sign in: ${config.signInUrl}`);
  process.exitCode = await supervise(commands(config, mode, role), {
    env: { ...childEnvironment(config), MARS_BUILD_CHECK: mode === 'production' ? '1' : '0' },
  });
}
