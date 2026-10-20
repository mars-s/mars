import { fileURLToPath } from 'node:url';

export function checkRuntime(version = process.versions.node) {
  if (version !== '24.14.0') throw Error(`Mars requires Node 24.14.0. Current version: ${version}. Run mise install and mise exec -- npm ci.`);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) checkRuntime();
