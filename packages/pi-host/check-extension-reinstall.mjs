// Installing an earlier version of an extension again (a rollback, or undoing an edit back to
// bytes installed before) works: its read-only frozen files are the same bytes and are kept.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRegistry } from '@earendil-works/pi-durable';
import { ExtensionStore } from './extension-store.mjs';

const dir = await mkdtemp(join(tmpdir(), 'mars-extension-reinstall-'));
const write = async (version) => {
  const source = join(dir, 'plugin-' + version);
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'manifest.json'), JSON.stringify({ name: 'reinstall-fixture', version, title: 'Reinstall fixture' }));
  await writeFile(join(source, 'client.js'), 'export function mount(root){root.textContent="v' + version + '";}');
  await writeFile(join(source, 'extension.mjs'), `import {defineTask} from ${JSON.stringify(import.meta.resolve('@earendil-works/pi-durable'))};\nexport default {name:'reinstall-fixture',tasks:[defineTask({name:'fixture.reinstall.v1',version:1,initial:()=>({phase:'run'}),phases:{run:(_t,runtime,ctx)=>runtime.commit(()=>({status:'terminal',outcome:{status:'completed',result:'${version}'}}),ctx)}})]};`);
  return source;
};
try {
  const store = new ExtensionStore(createRegistry(), join(dir, 'data'));
  const one = await write('1.0.0'), two = await write('2.0.0');
  assert.equal((await store.install(one)).version, '1.0.0');
  assert.equal((await store.install(two)).version, '2.0.0');
  const back = await store.install(one);
  assert.equal(back.application, 'applied');
  assert.equal(back.version, '1.0.0', 'rolled back to 1.0.0');
  console.log('PASS extension reinstall: an earlier version installs again over its read-only frozen files');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await rm(dir, { recursive: true, force: true });
}
