import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRuntime } from './check-runtime.mjs';
import { bootstrap, configuration, loadEnvironment, resolveFlock } from './setup.mjs';

function singleLine(value) {
  if (/[\r\n\0]/.test(value)) throw Error('Service paths and values must be single lines');
  return value;
}
export function systemdArgument(value, variables = true) {
  const escaped = singleLine(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%');
  return '"' + (variables ? escaped.replaceAll('$', () => '$$') : escaped) + '"';
}
export function environmentValue(value) {
  return '"' + singleLine(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
}
function serviceName(value) {
  if (!/^[a-zA-Z0-9_.@-]+\.service$/.test(value)) throw Error('Invalid user service name');
  return value;
}
export function servicePlan(config, { mode = 'production', configDir = join(process.env.XDG_CONFIG_HOME || join(process.env.HOME || homedir(), '.config'), 'systemd/user'), node = process.execPath } = {}) {
  if (!['development', 'production'].includes(mode)) throw Error('Use production or development service mode');
  const environmentFile = join(config.root, 'service.env');
  const environment = {
    MARS_REPO_ROOT: config.repo, MARS_PI_ROOT: config.root, MARS_UI_DIR: config.ui,
    MARS_PI_PORT: config.hostPort, MARS_UI_PORT: config.uiPort,
    MARS_PUBLIC_ORIGIN: config.publicOrigin, MARS_ALLOWED_ORIGINS: config.allowedOrigins,
    MARS_HOST_SERVICE: config.hostService, MARS_UI_SERVICE: config.uiService,
    MARS_FLOCK_PATH: config.flock || config.flockPath,
    PATH: `${dirname(node)}:/usr/local/bin:/usr/bin:/bin`,
  };
  // WorkingDirectory consumes a literal path, while ExecStart parses quoted arguments.
  const unit = (description, role) => `[Unit]\nDescription=${description}\nAfter=network.target\n\n[Service]\nType=simple\nWorkingDirectory=${singleLine(config.repo).replaceAll('%', '%%')}\nEnvironmentFile=${singleLine(environmentFile).replaceAll('%', '%%')}\nExecStart=${[node, join(config.repo, 'scripts/run.mjs'), mode, role].map(value => systemdArgument(value)).join(' ')}\nRestart=on-failure\nRestartSec=2\nKillMode=control-group\nTimeoutStopSec=15\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
  return {
    environmentFile, environment,
    units: [
      { name: serviceName(config.hostService), path: join(resolve(configDir), serviceName(config.hostService)), content: unit('Mars Pi Durable host', 'host') },
      { name: serviceName(config.uiService), path: join(resolve(configDir), serviceName(config.uiService)), content: unit('Mars UI', 'ui') },
    ],
  };
}
async function systemctl(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('systemctl', ['--user', ...args], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(Error(`systemctl --user ${args[0]} failed (${code})`)));
  });
}
export async function installService(config, options = {}) {
  config = { ...config, flock: await resolveFlock(config) };
  const plan = servicePlan(config, options);
  if (options.dryRun) return plan;
  await bootstrap(config);
  let previous = '';
  try { previous = await readFile(plan.environmentFile, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Preserve owner additions, including secrets, without printing them or copying them into Git.
  const managed = new Set(Object.keys(plan.environment));
  const extra = previous.split('\n').filter(line => line.trim() && !managed.has(line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/)?.[1]));
  const content = [...extra, ...Object.entries(plan.environment).map(([key, value]) => `${key}=${environmentValue(value)}`)].join('\n') + '\n';
  await writeFile(plan.environmentFile, content, { mode: 0o600 });
  await chmod(plan.environmentFile, 0o600);
  for (const unit of plan.units) {
    await mkdir(dirname(unit.path), { recursive: true });
    await writeFile(unit.path, unit.content, { mode: 0o644 });
  }
  if (options.systemd !== false) {
    await systemctl(['daemon-reload']);
    if (options.enable) await systemctl(['enable', '--now', ...plan.units.map(unit => unit.name)]);
  }
  return plan;
}
export function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--no-systemd') options.systemd = false;
    else if (arg === '--enable') options.enable = true;
    else if (arg === '--mode' || arg === '--config-dir') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw Error(`${arg} requires a value`);
      options[arg === '--mode' ? 'mode' : 'configDir'] = value;
    } else throw Error(`Unknown option: ${arg}`);
  }
  return options;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  checkRuntime(); loadEnvironment();
  const options = parseArguments(process.argv.slice(2));
  if (process.platform !== 'linux' && !options.dryRun && options.systemd !== false) throw Error('User services require Linux. Use npm run dev on other systems.');
  const plan = await installService(configuration(), options);
  if (options.dryRun) console.log(JSON.stringify(plan, null, 2));
  else console.log(`Installed ${plan.units.map(unit => unit.name).join(' and ')}.\n${options.enable ? 'Services enabled and started.' : 'Start with systemctl --user enable --now ' + plan.units.map(unit => unit.name).join(' ')}\nRun npm run setup for the private sign-in link.`);
}
