import {bootstrap,configuration,loadEnvironment,childEnvironment} from './setup.mjs';
import {checkRuntime} from './check-runtime.mjs';
checkRuntime();loadEnvironment();
const options={};
const args=process.argv.slice(2);
for(let i=0;i<args.length;i++){
 if(args[i]==='--dry-run')options.dryRun=true;
 else if(args[i]==='--ref'){if(!args[++i])throw Error('--ref requires a Git ref');options.ref=args[i];}
 else throw Error('Unknown host deployment option: '+args[i]);
}
const config=await bootstrap(configuration());
Object.assign(process.env,childEnvironment(config));
const {createDevTools}=await import('../packages/pi-host/dev-tools.mjs');
const tools=createDevTools({root:config.root,repo:config.repo,appDir:config.root+'/app',service:config.hostService,livePort:Number(config.hostPort)});
const result=await tools.deploy(options);
console.log(JSON.stringify(result,null,2));
if(!result.ok)process.exitCode=1;
