import {readFile,readdir} from 'node:fs/promises';
import {resolve,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const policy=JSON.parse(await readFile(resolve(root,'architecture-policy.json'),'utf8'));
const extensions=/\.(?:[cm]?[jt]sx?)$/;
async function scan(dir){const out=[];for(const item of await readdir(dir,{withFileTypes:true})){if(['node_modules','.next','.next-build','test-results','.git'].includes(item.name))continue;const path=resolve(dir,item.name);if(item.isDirectory())out.push(...await scan(path));else if(extensions.test(item.name))out.push(path);}return out;}
const violations=[];
for(const module of Object.values(policy.modules))for(const file of await scan(resolve(root,module.root))){
 const source=await readFile(file,'utf8');
 const imports=source.matchAll(/(?:\b(?:import|export)\s+(?:[^;\n]*?\s+from\s*)?|\b(?:import|require)\s*\()\s*['"]([^'"]+)['"]/g);
 for(const [,specifier] of imports){
  const target=specifier.startsWith('.')?relative(root,resolve(dirname(file),specifier)).split('\\').join('/'):specifier;
  for(const forbidden of module.cannotImport)if(target===forbidden||target.startsWith(forbidden+'/')||target==='@mars/'+(forbidden==='packages/pi-host'?'pi-host':'ui'))violations.push(`${relative(root,file)} imports ${specifier}`);
 }
}
if(violations.length){process.stderr.write(violations.join('\n')+'\n');process.exitCode=1;}else console.log('PASS workspace boundaries: UI and Pi communicate through HTTP, no cross-workspace implementation imports');
