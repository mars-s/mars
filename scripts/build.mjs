import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { checkRuntime } from './check-runtime.mjs';
import { configuration, loadEnvironment } from './setup.mjs';

checkRuntime(); loadEnvironment();
const config = configuration();
const require = createRequire(config.ui + '/package.json');
const child = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'build', '--webpack'], {
  cwd: config.ui, stdio: 'inherit', env: { ...process.env, MARS_REPO_ROOT: config.repo, MARS_BUILD_CHECK: '1' },
});
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('close', code => { process.exitCode = code ?? 1; });
