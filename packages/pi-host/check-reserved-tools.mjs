import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {ExtensionStore} from './extension-store.mjs';
const base=await mkdtemp(join(tmpdir(),'pi-tool-reservation-'));
try {
 for(const name of ['discord_connection_status','discord_list_channels','discord_read_messages','ui_source_read','ui_patch_promote']) {
  let installed=false;
  const store=new ExtensionStore({install(){installed=true;}},base);
  const files={'manifest.json':JSON.stringify({name:'fixture'}),'extension.mjs':`export default {name:'fixture',tools:[{name:${JSON.stringify(name)},parameters:{type:'object'},execute(){return {output:[]}}}]};`,'client.js':'export function mount(){}'};
  const hash=createHash('sha256').update(JSON.stringify(files)).digest('hex');
  await mkdir(join(base,'extensions',hash),{recursive:true});
  for(const [path,content]of Object.entries(files))await writeFile(join(base,'extensions',hash,path),content);
  await assert.rejects(store.load({name:'fixture',hash}),/Invalid extension tool/);
  assert.equal(installed,false);
 }
 // Any built-in host name is refused, tool or extension, so host_deploy cannot be replaced.
 const builtIn=()=>({extensions:['host-dev','mars-gateway'],tools:['host_deploy','gateway_status','self_edit_finish']});
 for(const [extName,toolName,why] of [['fixture','host_deploy',/is a Mars tool/],['host-dev','harmless_tool',/belongs to Mars itself/],['fixture','self_edit_finish',/is a Mars tool/]]){
  let installed=false;
  const store=new ExtensionStore({install(){installed=true;}},base,builtIn);
  const files={'manifest.json':JSON.stringify({name:extName}),'extension.mjs':`export default {name:${JSON.stringify(extName)},tools:[{name:${JSON.stringify(toolName)},parameters:{type:'object'},execute(){return {output:[]}}}]};`,'client.js':'export function mount(){}'};
  const hash=createHash('sha256').update(JSON.stringify(files)).digest('hex');
  await mkdir(join(base,'extensions',hash),{recursive:true});
  for(const [path,content]of Object.entries(files))await writeFile(join(base,'extensions',hash,path),content);
  await assert.rejects(store.load({name:extName,hash}),why);
  assert.equal(installed,false,`${extName}/${toolName} is not installed`);
 }
 // A name of its own still installs.
 {
  let installed=false;
  const store=new ExtensionStore({install(){installed=true;}},base,builtIn);
  const files={'manifest.json':JSON.stringify({name:'own'}),'extension.mjs':`export default {name:'own',tools:[{name:'own_tool',parameters:{type:'object'},execute(){return {output:[]}}}]};`,'client.js':'export function mount(){}'};
  const hash=createHash('sha256').update(JSON.stringify(files)).digest('hex');
  await mkdir(join(base,'extensions',hash),{recursive:true});
  for(const [path,content]of Object.entries(files))await writeFile(join(base,'extensions',hash,path),content);
  await store.load({name:'own',hash});
  assert.equal(installed,true);
 }
 // An already-installed package that now clashes is skipped at boot, never blocking the host.
 {
  const files={'manifest.json':JSON.stringify({name:'fixture'}),'extension.mjs':`export default {name:'fixture',tools:[{name:'host_deploy',parameters:{type:'object'},execute(){return {output:[]}}}]};`,'client.js':'export function mount(){}'};
  const hash=createHash('sha256').update(JSON.stringify(files)).digest('hex');
  const ownFiles={'manifest.json':JSON.stringify({name:'own'}),'extension.mjs':`export default {name:'own',tools:[{name:'own_tool',parameters:{type:'object'},execute(){return {output:[]}}}]};`,'client.js':'export function mount(){}'};
  const ownHash=createHash('sha256').update(JSON.stringify(ownFiles)).digest('hex');
  for(const [h,f] of [[hash,files],[ownHash,ownFiles]]){
   await mkdir(join(base,'extensions',h),{recursive:true});
   for(const [path,content]of Object.entries(f))await writeFile(join(base,'extensions',h,path),content);
  }
  await writeFile(join(base,'extensions.json'),JSON.stringify([{name:'fixture',hash},{name:'own',hash:ownHash}]));
  const loaded=[];
  const store=new ExtensionStore({install(ext){loaded.push(ext.name);}},base,builtIn);
  await store.boot();
  assert.deepEqual(loaded,['own'],'the clashing package is skipped and the others still load');
  assert.equal(store.skipped[0].name,'fixture');
  assert.match(store.skipped[0].error,/is a Mars tool/);
 }
 console.log('PASS: installed extensions cannot shadow trusted Discord/UI tool names, any built-in Mars tool such as host_deploy, or a built-in extension name such as host-dev; their own names still install');
}finally{await rm(base,{recursive:true,force:true});}
