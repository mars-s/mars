import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,copyFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);
test('native check runner executes from a checkout path containing spaces',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mars check space '));
 try{
  await copyFile(new URL('../packages/pi-host/run-checks.mjs',import.meta.url),join(root,'run-checks.mjs'));
  await writeFile(join(root,'check-proof.mjs'),"console.log('fixture proof')");
  const {stdout}=await run(process.execPath,[join(root,'run-checks.mjs'),'--json']);
  const result=JSON.parse(stdout.trim());assert.equal(result.ok,true);assert.deepEqual(result.passed,['check-proof.mjs']);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('workspace boundary check rejects direct UI imports of native host source',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mars boundary '));
 try{
  await mkdir(join(root,'scripts'),{recursive:true});await mkdir(join(root,'apps/ui'),{recursive:true});await mkdir(join(root,'packages/pi-host'),{recursive:true});
  await copyFile(new URL('./check-boundaries.mjs',import.meta.url),join(root,'scripts/check-boundaries.mjs'));
  await copyFile(new URL('../architecture-policy.json',import.meta.url),join(root,'architecture-policy.json'));
  await writeFile(join(root,'apps/ui/feature.mjs'),"import {record} from './state.mjs';");
  await writeFile(join(root,'packages/pi-host/server.mjs'),"import {Harness} from '@earendil-works/pi-durable';");
  await run(process.execPath,[join(root,'scripts/check-boundaries.mjs')]);
  await writeFile(join(root,'apps/ui/feature.mjs'),"import {privateState} from '../../packages/pi-host/server.mjs';");
  await assert.rejects(run(process.execPath,[join(root,'scripts/check-boundaries.mjs')]),error=>error.code===1&&error.stderr.includes('apps/ui/feature.mjs imports'));
 }finally{await rm(root,{recursive:true,force:true});}
});
