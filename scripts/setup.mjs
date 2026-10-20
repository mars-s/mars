import { randomBytes } from 'node:crypto';
import { access, chmod, copyFile, cp, link, lstat, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRuntime } from './check-runtime.mjs';

export const REPOSITORY = fileURLToPath(new URL('../', import.meta.url));
export function loadEnvironment(repo = REPOSITORY) {
  try { process.loadEnvFile(join(repo, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
function port(value, fallback) {
  const parsed = Number(value || fallback);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw Error('Mars ports must be integers from 1 to 65535');
  return String(parsed);
}
export function configuration(env = process.env, repository = REPOSITORY) {
  const repo = resolve(env.MARS_REPO_ROOT || repository);
  const root = resolve(env.MARS_PI_ROOT || join(env.XDG_DATA_HOME || join(env.HOME || homedir(), '.local/share'), 'mars'));
  const inside = relative(repo, root);
  if (!inside || (!inside.startsWith('..' + '/') && inside !== '..' && !isAbsolute(inside))) throw Error('MARS_PI_ROOT must be outside the checkout so private data stays out of Git');
  const hostPort = port(env.MARS_PI_PORT, 3081), uiPort = port(env.MARS_UI_PORT, 3082);
  if (hostPort === uiPort) throw Error('MARS_PI_PORT and MARS_UI_PORT must differ');
  const publicOrigin = env.MARS_PUBLIC_ORIGIN || '';
  if (publicOrigin) {
    const url = new URL(publicOrigin);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin !== publicOrigin) throw Error('MARS_PUBLIC_ORIGIN must be a bare http or https origin');
  }
  return {
    repo, root, hostPort, uiPort, publicOrigin,
    ui: resolve(env.MARS_UI_DIR || join(repo, 'apps/ui')),
    host: join(repo, 'packages/pi-host'),
    allowedOrigins: env.MARS_ALLOWED_ORIGINS || '',
    flockPath: env.MARS_FLOCK_PATH || 'flock',
    executablePath: env.PATH ?? process.env.PATH ?? '',
    hostService: env.MARS_HOST_SERVICE || env.MARS_PI_SERVICE || 'mars-pi-host.service',
    uiService: env.MARS_UI_SERVICE || 'mars-pi-ui.service',
  };
}
export async function resolveFlock(config) {
  const command = config.flock || config.flockPath || 'flock';
  const candidates = command.includes('/') || command.includes('\\')
    ? [resolve(command)]
    : (config.executablePath ?? process.env.PATH ?? '').split(delimiter).filter(Boolean).map(directory => resolve(directory, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) throw error;
    }
  }
  throw Error('Mars requires a util-linux-compatible flock before opening native storage. Install flock or set MARS_FLOCK_PATH to its executable. No unlocked host was started.');
}
async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}
async function linkIfMissing(target, path) {
  try { await lstat(path); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await symlink(target, path, 'dir').catch(error => { if (error.code !== 'EEXIST') throw error; });
  }
}
async function initialiseRuntime(config) {
  const runtime = join(config.root, 'app');
  try {
    const existing = await lstat(runtime);
    if (!existing.isDirectory()) throw Error('Existing Mars app must be a separate runtime directory. Preserve it and select a private data root.');
    await access(join(runtime, 'server.mjs'));
    return runtime;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // Never fill or replace an existing runtime, even if an owner removed its entry point.
    try { await lstat(runtime); throw Error('Existing Mars runtime has no server.mjs. Restore it or deploy deliberately.'); }
    catch (existingError) { if (existingError.code !== 'ENOENT') throw existingError; }
  }
  const staging = await mkdtemp(join(config.root, 'app-install-'));
  try {
    await cp(config.host, staging, {
      recursive: true,
      filter: path => {
        const name = relative(config.host, path).split('/')[0];
        return !['node_modules', 'package-lock.json', '.workspace-lock.json'].includes(name) && !name.startsWith('node_modules.prev') && !name.startsWith('.backup-');
      },
    });
    await copyFile(join(config.repo, 'package-lock.json'), join(staging, '.workspace-lock.json'));
    await symlink(join(config.repo, 'node_modules'), join(staging, 'node_modules'), 'dir');
    // Concurrent UI and host startup may initialise together. Only the first complete snapshot wins.
    await rename(staging, runtime).catch(error => { if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error; });
  } finally { await rm(staging, { recursive: true, force: true }); }
  return runtime;
}
export async function bootstrap(config = configuration()) {
  const flock = await resolveFlock(config);
  for (const path of [config.root, join(config.root, 'data'), join(config.root, 'workspace'), join(config.root, 'evidence')]) await privateDirectory(path);
  const tokenPath = join(config.root, 'data/web-token');
  try { await access(tokenPath); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // Publish complete bytes atomically when the UI and host services bootstrap together.
    const temporary = tokenPath + '.' + randomBytes(12).toString('hex');
    try {
      await writeFile(temporary, randomBytes(32).toString('base64url'), { flag: 'wx', mode: 0o600 });
      await link(temporary, tokenPath).catch(error => { if (error.code !== 'EEXIST') throw error; });
    } finally { await rm(temporary, { force: true }); }
  }
  await chmod(tokenPath, 0o600);
  const token = (await readFile(tokenPath, 'utf8')).trim();
  if (!token) throw Error('Existing owner token is empty. Restore it before starting Mars.');
  for (const file of ['HOST-GUIDE.md', 'EXTENSION-GUIDE.md']) {
    await copyFile(join(config.host, file), join(config.root, 'workspace', file), constants.COPYFILE_EXCL).catch(error => { if (error.code !== 'EEXIST') throw error; });
  }
  await mkdir(join(config.root, 'workspace/scratch'), { recursive: true, mode: 0o700 });
  for (const directory of [config.root, join(config.root, 'data'), join(config.root, 'workspace/scratch')]) await linkIfMissing(join(config.repo, 'node_modules'), join(directory, 'node_modules'));
  const runtime = await initialiseRuntime(config);
  return { ...config, runtime, flock, token, signInUrl: `${config.publicOrigin || `http://127.0.0.1:${config.hostPort}`}/?token=${encodeURIComponent(token)}` };
}
export function childEnvironment(config, env = process.env) {
  return {
    ...env,
    MARS_REPO_ROOT: config.repo, MARS_PI_ROOT: config.root, MARS_UI_DIR: config.ui,
    MARS_PI_PORT: config.hostPort, MARS_UI_PORT: config.uiPort,
    MARS_PI_ORIGIN: `http://127.0.0.1:${config.hostPort}`, MARS_PI_TOKEN: config.token,
    MARS_PUBLIC_ORIGIN: config.publicOrigin, MARS_ALLOWED_ORIGINS: config.allowedOrigins,
    MARS_HOST_SERVICE: config.hostService, MARS_UI_SERVICE: config.uiService,
    MARS_FLOCK_PATH: config.flock,
    PATH: `${dirname(process.execPath)}${process.platform === 'win32' ? ';' : ':'}${env.PATH || ''}`,
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  checkRuntime(); loadEnvironment();
  const config = await bootstrap();
  console.log(`Mars data: ${config.root}\nSign in locally: ${config.signInUrl}`);
}
