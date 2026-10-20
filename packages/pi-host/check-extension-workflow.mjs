import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BACKGROUND_CONTEXT as context} from '@earendil-works/chord/context';
import {createModels} from '@earendil-works/pi-ai/models';
import {Harness,createRegistry} from '@earendil-works/pi-durable';
import {openNodeSqliteStorage} from '@earendil-works/pi-durable/storage/sqlite/node';
import {ExtensionStore} from './extension-store.mjs';
const dir=await mkdtemp(join(tmpdir(),'mars-workflow-plugin-'));
let harness;
try {
 const source=join(dir,'plugin');await mkdir(source);
 await writeFile(join(source,'manifest.json'),JSON.stringify({name:'workflow-fixture',version:'1.0.0',title:'Workflow fixture'}));
 await writeFile(join(source,'client.js'),'export function mount(root){root.textContent="Workflow fixture";}');
 await writeFile(join(source,'extension.mjs'),`import {defineTask} from ${JSON.stringify(import.meta.resolve('@earendil-works/pi-durable'))};
export default {name:'workflow-fixture',tasks:[defineTask({name:'fixture.workflow.v1',version:1,initial:()=>({phase:'run'}),phases:{run:(_task,runtime,ctx)=>runtime.commit(()=>({status:'terminal',outcome:{status:'completed',result:'WORKFLOW_INSTALLED'}}),ctx)}})]};`);
 const registry=createRegistry();const store=new ExtensionStore(registry,join(dir,'data'));
 const receipt=await store.install(source);assert.equal(receipt.application,'applied');
 const task=registry.snapshot().task('fixture.workflow.v1');assert.ok(task);
 harness=await Harness.open(await openNodeSqliteStorage(join(dir,'test.sqlite')),{registry,models:createModels()},context);
 const root=await harness.root(context);
 const taskId=await root.commit(tx=>tx.createTask(task,{}, {ownership:{kind:'conversation'}}),context);
 assert.equal((await harness.waitForTask(taskId,context)).state.outcome.result,'WORKFLOW_INSTALLED');
 await harness.close(context);harness=undefined;
 const restored=createRegistry();await new ExtensionStore(restored,join(dir,'data')).boot();
 assert.ok(restored.snapshot().task('fixture.workflow.v1'));
 console.log('PASS native task-only extension installs from arbitrary host path, executes, and reloads by immutable hash');
} finally {if(harness)await harness.close(context);await rm(dir,{recursive:true,force:true});}
