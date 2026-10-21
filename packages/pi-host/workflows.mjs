import {Type} from '@earendil-works/pi-ai';
import {configure,defineExtension,defineTask,defineTool,UsageDoc} from '@earendil-works/pi-durable';
import {forgivingList,nativeTitleDoc,selectWorkerModel} from './orchestration.mjs';
const KIND='mars.linear-workflow.v1';
const nativeId=value=>typeof value==='string'&&/^\d+$/.test(value)?Number(value):value;
const answer=messages=>messages.filter(m=>m.role==='assistant').at(-1)?.content.filter(c=>c.type==='text').map(c=>c.text).join('\n').slice(0,4000)||'';
function viewOf(task,includeResults=false){
 const saved=task.state.outcome?.result||task.state.checkpoint||{};
 const status=task.state.outcome?.status||'running';
 return {id:String(task.id),conversationId:String(task.conversationId),title:task.input.title,status,
 currentStep:saved.index??0,startedAt:task.input.startedAt,...(saved.finishedAt?{finishedAt:saved.finishedAt}:{}),
 ...(task.state.outcome?.error?{error:task.state.outcome.error.message}:{}),
 steps:(saved.steps||task.input.steps.map((step,index)=>({index,title:step.title,status:'pending',...step.selection}))).map(step=>{
  const {result,...metadata}=step;return {...metadata,...(includeResults&&result?{result}:{})};
 })};
}
export function createWorkflowExtension({models,loadImages,abortTask}){
 async function finish(task,runtime,ctx,status,steps,error){
  const result={steps,index:task.state.checkpoint.index??0,finishedAt:runtime.now()};
  await runtime.commit(async tx=>{
   await tx.appendEntry(runtime.conversationId,{kind:'mars.workflow-completed',data:{workflowId:String(runtime.taskId),title:task.input.title,status}});
   return {status:'terminal',outcome:{status,result,...(error?{error:{message:error}}:{})}};
  },ctx);
 }
 const workflow=defineTask({name:KIND,version:1,
  initial:input=>({phase:'launch',index:0,steps:input.steps.map((step,index)=>({index,title:step.title,status:'pending',...step.selection}))}),
  phases:{
   launch:async(task,runtime,ctx)=>{
    const state=task.state.checkpoint;
    await runtime.commit(async tx=>{
     const child=await tx.createConversation({ownership:{kind:'task',taskId:runtime.taskId}});
     await configure(tx,child.id,{model:task.input.steps[state.index].selection});
     const label=await tx.doc(nativeTitleDoc,child.id);label.title=task.input.steps[state.index].title;
     label.task=task.input.steps[state.index].prompt;label.workflowId=String(runtime.taskId);label.taskKind='workflow-step';
     if(task.input.parentEntryId)label.parentEntryId=task.input.parentEntryId;
     const steps=state.steps.map((step,index)=>index===state.index?{...step,status:'running',conversationId:String(child.id),startedAt:runtime.now()}:step);
     return {status:'running',checkpoint:{phase:'run',index:state.index,steps,childId:child.id}};
    },ctx);
   },
   run:async(task,runtime,ctx)=>{
    const state=task.state.checkpoint;const step=task.input.steps[state.index];
    try{
     const previous=state.steps[state.index-1];
     const prompt=`Workflow ${task.input.title}. Step ${state.index+1}/${task.input.steps.length}: ${step.title}.\n${step.prompt}${previous?`\n\nPrevious step (${previous.title}) result:\n${previous.result||''}`:''}`;
     const prepared=step.attachmentIds?.length?await loadImages(step.attachmentIds,prompt):undefined;
     const child=await runtime.conversation(state.childId,ctx);
     const settled=await(await child.submit({type:'input',content:prepared?.content||prompt,
      ...(prepared?{entry:{kind:'mars.user',data:{attachments:prepared.attachments}}}:{}),requestId:`workflow:${runtime.taskId}:${state.index}`},ctx)).wait(ctx);
     const transcript=await runtime.context(state.childId,ctx);const usage=await runtime.snapshot(UsageDoc,state.childId,ctx)||{models:{},tools:{}};
     const status=settled.status==='done'?'completed':settled.reason==='aborted'?'aborted':'failed';
     const steps=state.steps.map((row,index)=>index===state.index?{...row,status,finishedAt:runtime.now(),durationMs:runtime.now()-row.startedAt,usage,result:answer(transcript.messages)}:row);
     if(status!=='completed'){await finish(task,runtime,ctx,status,steps, status==='failed'?(settled.detail||settled.reason||'Step failed'):undefined);return;}
     if(state.index===task.input.steps.length-1){await finish(task,runtime,ctx,'completed',steps);return;}
     await runtime.commit(()=>({status:'running',checkpoint:{phase:'launch',index:state.index+1,steps}}),ctx);
    }catch(error){
     if(runtime.signal.aborted||ctx.abortSignal?.aborted)throw error;
     const steps=state.steps.map((row,index)=>index===state.index?{...row,status:'failed',finishedAt:runtime.now(),durationMs:runtime.now()-row.startedAt}:row);
     await finish(task,runtime,ctx,'failed',steps,String(error.message).slice(0,1000));
    }
   },
  },
  abort:async(task,runtime,ctx)=>{
   const state=task.state.checkpoint;
   const steps=state.steps.map(row=>row.status==='running'?{...row,status:'aborted',finishedAt:runtime.now(),durationMs:runtime.now()-row.startedAt}:row);
   await finish(task,runtime,ctx,'aborted',steps);
  },
 });
 const step=Type.Object({
  title:Type.String({minLength:1,maxLength:160,description:'Short name for this step, e.g. "Draft outline".'}),
  prompt:Type.String({minLength:1,maxLength:16000,description:'Complete brief for this step. It also receives the previous step\'s answer, and nothing else from this chat.'}),
  model:Type.Optional(Type.Union([Type.Literal('luna'),Type.Literal('sol'),Type.Literal('astra'),Type.Literal('opus')],{default:'luna',description:'luna: fast and cheap (default). sol: strong all-rounder. astra: hardest reasoning. opus: Claude, for writing.'})),
  provider:Type.Optional(Type.String({description:'Advanced: exact provider, e.g. "openai". Use with modelId instead of model.'})),
  modelId:Type.Optional(Type.String({description:'Advanced: exact model id, e.g. "gpt-6-sol". Use with provider instead of model.'})),
  attachmentIds:Type.Optional(Type.Array(Type.String({pattern:'^[a-f0-9]{64}$'}),{maxItems:4,description:'Ids of images from this chat to show this step, up to 4.'})),
 });
 const StepView=Type.Object({
  index:Type.Integer({description:'Step number, from 0.'}),
  title:Type.String({description:'Step name.'}),
  status:Type.String({description:'"pending", "running", "completed", "failed" or "aborted".'}),
  result:Type.Optional(Type.Any({description:'The step answer, once finished (workflow_status only).'})),
 },{additionalProperties:true});
 const WorkflowView=Type.Object({
  id:Type.String({description:'Workflow id.'}),
  title:Type.String({description:'Workflow name.'}),
  status:Type.String({description:'"running", "completed", "failed" or "aborted".'}),
  currentStep:Type.Integer({description:'Index of the step running now.'}),
  steps:Type.Array(StepView),
 },{additionalProperties:true});
 const make=(name,description,parameters,result,execute,prepareArguments)=>defineTool({name,description,parameters,deferred:true,replay:'safe',executionMode:'parallel',structuredOutputSchema:result,outputLimits:{maxBytes:10000},...(prepareArguments?{prepareArguments}:{}),execute:async(args,api,ctx)=>{const value=await execute(args,api,ctx);return{output:[{type:'text',text:JSON.stringify(value)}],structuredOutput:value};}});
 const tools=[
  make('workflow_start',`Have helper models run several steps one after another in the background, each using the previous step's answer.
Use it for multi-stage work where each step builds on the last, e.g. research, then outline, then draft: put one entry per stage in steps. Each step gets its own brief plus the previous step's answer. It returns at once with workflowId; check progress and answers with workflow_status. It keeps running after a restart. For independent jobs at the same time, use worker_fanout.
Example: const { workflowId } = await tools.workflow_start({ title: "Blog post", steps: [{ title: "Research", prompt: "List 5 facts about tide pools." }, { title: "Draft", prompt: "Write a 300-word post from these facts." }] })`,Type.Object({
   title:Type.String({minLength:1,maxLength:160,description:'Name of the whole workflow, shown in the chat, e.g. "Blog post".'}),
   steps:Type.Array(step,{minItems:1,maxItems:16,description:'The steps in order, 1 to 16.'}),
  }),Type.Object({
   workflowId:Type.String({description:'Pass it to workflow_status or workflow_stop.'}),
   title:Type.String({description:'Workflow name.'}),
   status:Type.String({description:'"started".'}),
   background:Type.Boolean({description:'True: it runs on its own; this call does not wait.'}),
  }),async(args,api,ctx)=>{
   const steps=args.steps.map(step=>({...step,selection:selectWorkerModel(models,step)}));
   for(const step of steps)if(step.attachmentIds?.length&&!models.getModel(step.selection.provider,step.selection.modelId)?.input?.includes('image'))throw Error('Selected workflow model does not support images');
   const operationId=`workflow-start:${api.taskId}`;
   const id=await api.memo('workflow-id',ctx)||await api.commit(async tx=>{
    let cursor;do{const page=await tx.scanTasks({conversationId:api.conversationId,kind:KIND},100,cursor);const existing=page.items.find(t=>t.input.operationId===operationId);if(existing)return existing.id;cursor=page.next;}while(cursor);
    const caller=await tx.task(api.taskId);
    return tx.createTask(workflow,{title:args.title,steps,startedAt:Date.now(),operationId,...(caller?.input?.assistant?{parentEntryId:String(caller.input.assistant)}:{})},{ownership:{kind:'conversation'},background:true});
   },ctx);
   await api.memo('workflow-id',id,ctx);await api.details({workflowId:String(id)},ctx);return{workflowId:String(id),title:args.title,status:'started',background:true};
  },args=>{
   // A checklist sent here by mistake ({step, status}, no prompt) is the agent's own plan:
   // refuse with the right tool rather than start helper models on it.
   const raw=forgivingList(args?.steps,'prompt');
   if(Array.isArray(raw)&&raw.some(step=>step&&typeof step==='object'&&'status' in step&&!step.prompt))throw Error('These look like checklist steps with a status, not briefs for helper models. To show your own progress, call plan_update with the same steps. To have helper models run steps in order, give each step a prompt.');
   // Forgiving: a JSON string or plain step briefs become {title, prompt} steps.
   const steps=raw;
   return {...args,steps:Array.isArray(steps)?steps.map((step,index)=>step&&typeof step==='object'&&step.prompt&&!step.title?{...step,title:`Step ${index+1}`}:step):steps};
  }),
  make('workflow_status',`Check a workflow's progress and read each finished step's answer.
Use it after workflow_start to see which step is running and to get the answers. The final answer is the result of the last step once status is "completed".
Example: const { status, steps } = await tools.workflow_status({ workflowId: "88" })`,Type.Object({workflowId:Type.String({description:'Id from workflow_start, e.g. "88".'})}),WorkflowView,async(args,api,ctx)=>{
   const task=await api.getTask(nativeId(args.workflowId),ctx);if(task?.kind!==KIND||task.conversationId!==api.conversationId)throw Error('Workflow not found');return viewOf(task,true);
  }),
  make('workflow_stop',`Stop a running workflow, including the step running now.
Use it when the workflow is no longer needed. Finished steps keep their answers; check them with workflow_status.
Example: await tools.workflow_stop({ workflowId: "88" })`,Type.Object({workflowId:Type.String({description:'Id from workflow_start, e.g. "88".'})}),Type.Object({workflowId:Type.String({description:'The workflow stopped.'}),status:Type.String({description:'"stopping".'})}),async(args,api,ctx)=>{
   const task=await api.getTask(nativeId(args.workflowId),ctx);if(task?.kind!==KIND||task.conversationId!==api.conversationId)throw Error('Workflow not found');await abortTask(task.id,ctx);return{workflowId:args.workflowId,status:'stopping'};
  }),
 ];
 return defineExtension({name:'linear-workflows',tools,tasks:[workflow]});
}
export async function listWorkflows({harness,conversationId,context,limit=20}){
 const page=await harness.commit(tx=>tx.scanTasks({conversationId:nativeId(conversationId),kind:KIND,order:'descending'},limit),context);
 return page.items.map(task=>viewOf(task));
}
export async function stopWorkflow({harness,conversationId,workflowId,context}){
 const task=await harness.getTask(nativeId(workflowId),context);
 if(task?.kind!==KIND||task.conversationId!==nativeId(conversationId))throw Error('Workflow not found for conversation');
 await harness.abortTask(task.id,context);return{workflowId:String(task.id),stopped:true};
}
