import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { Type, AssistantMessageEventStream } from '@earendil-works/pi-ai';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Harness,createRegistry} from '@earendil-works/pi-durable';
import {openNodeSqliteStorage} from '@earendil-works/pi-durable/storage/sqlite/node';
import { defineTool } from '@earendil-works/pi-durable';
import { createDiscovery } from './discovery.mjs';

const discovery = createDiscovery();
const offered = discovery.modelTools.map(({ name, description, parameters }) => ({ name, description, parameters }));
assert.deepEqual(offered.map(t => t.name), ['codemode', 'tool_search']);
const sections = discovery.extensions.flatMap(e => e.sections || []);
const results = [];
for (const count of [10, 100, 1000]) {
  const tools = Array.from({length:count}, (_, i) => defineTool({
    name: `catalogue_${i}`, description: `Read catalogue fixture ${i} only when requested.`,
    parameters: Type.Object({ query: Type.String() }), deferred: true,
    execute: async () => ({output:[]}),
  }));
  const times = [];
  let section = '';
  for(let n=0;n<5;n++) {
    const start = performance.now();
    section = (await Promise.all(sections.map(s => s.render({agent:{callable:tools}}, context)))).filter(Boolean).join('\n');
    times.push(performance.now()-start);
  }
  times.sort((a,b)=>a-b);
  const declarationBytes = Buffer.byteLength(section);
  const visibleSection=(await Promise.all(sections.map(s=>s.render({agent:{callable:tools.map(t=>({...t,deferred:undefined}))}},context)))).filter(Boolean).join('\n');
  const nondeferredDeclarationBytes=Buffer.byteLength(visibleSection);
  // inlineBudget 1800 tokens keeps core tools listed; the section stays bounded whatever the catalogue size.
  const sectionLimit = 8800;
  assert.ok(nondeferredDeclarationBytes>0 && nondeferredDeclarationBytes<sectionLimit);
  assert.ok(declarationBytes < sectionLimit, 'native declarations must stay within budget plus headings');
  const allSchemaBytes = Buffer.byteLength(JSON.stringify(tools.map(({name,description,parameters})=>({name,description,parameters}))));
  results.push({catalogue:count,offeredSchemas:offered.length,offeredSchemaBytes:Buffer.byteLength(JSON.stringify(offered)),declarationBytes,nondeferredDeclarationBytes,allSchemaBytes,renderMedianMs:times[2],renderP95Ms:times[4]});
}
// Native search uses local metadata and defaults to three, with explicit accumulation.
const candidates=Array.from({length:80},(_,i)=>({name:`fixture_${i}`,description:`unique${i} fixture discovery`,parameters:Type.Object({})}));
const loaded=new Set();
for(let i=0;i<20;i++) {
  const result=await discovery.modelTools[1].execute({query:`unique${i}`},{agent:async()=>({deferred:candidates.filter(t=>!loaded.has(t.name))})},context);
  assert.ok((result.control?.addTools.length??0)<=3);
  for(const name of result.control?.addTools||[])loaded.add(name);
}
// Exercise native schema loading and script-driven reset without account requests.
const dir=await mkdtemp(join(tmpdir(),'mars-discovery-'));
let harness;
try {
 const registry=createRegistry();for(const extension of discovery.extensions)registry.install(extension);
 const probe=defineTool({name:'probe_fixture',description:'uniqueprobe fixture',parameters:Type.Object({}),deferred:true,replay:'safe',execute:async()=>({output:[]})});
 registry.install({name:'probe',tools:[probe]});
 const model={id:'fixture',provider:'fake',api:'fake',contextWindow:100000,maxTokens:1000};
 const models={getModel:()=>model,streamSimple(_model,input){
  const stream=new AssistantMessageEventStream();
  const last=input.messages.at(-1);
  const text=typeof last?.content==='string'?last.content:last?.content?.find(c=>c.type==='text')?.text;
  const call=last?.role==='user' ? (text==='search'?{name:'tool_search',arguments:{query:'uniqueprobe'}}:{name:'codemode',arguments:{code:'await tools.discovery_reset({}); text("reset");'}}) : undefined;
  const message={role:'assistant',content:call?[{type:'toolCall',id:'c'+Date.now(),...call}]:[{type:'text',text:'done'}],api:'fake',provider:'fake',model:'fixture',stopReason:call?'toolUse':'stop',timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
  queueMicrotask(()=>{stream.push({type:'done',reason:message.stopReason,message});stream.end(message);});return stream;
 }};
 harness=await Harness.open(await openNodeSqliteStorage(join(dir,'test.sqlite')),{models,registry,settings:{retry:{maxRetries:0}}},context);
 const root=await harness.root(context,{agent:{model:{provider:'fake',modelId:'fixture'},modelTools:discovery.modelTools}});
 assert.equal((await(await root.submit({type:'input',content:'search'},context)).wait(context)).status,'done');
 assert.ok((await root.agent(context)).tools.some(t=>t.name==='probe_fixture'));
 assert.equal((await(await root.submit({type:'input',content:'reset'},context)).wait(context)).status,'done');
 assert.deepEqual((await root.agent(context)).tools.map(t=>t.name),['codemode','tool_search']);
 const view=await root.viewState(context);
 try {assert.ok(view.value.entries.filter(e=>e.kind==='pi.tool-result').every(e=>!e.model[0].isError));}finally{view.dispose();}
} finally {if(harness)await harness.close(context);await rm(dir,{recursive:true,force:true});}
console.log(JSON.stringify({status:'PASS',results,repeatedDiscovery:{turns:20,loadedSchemas:loaded.size,resetTool:'discovery_reset',nativeLoadAndResetVerified:true},limits:'Schema bytes and local render timings only. No provider-token or completion-cost saving is inferred.'},null,2));
