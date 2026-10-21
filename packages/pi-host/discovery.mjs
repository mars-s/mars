import { CodemodeSandbox } from '@earendil-works/pi-codemode';
import { createCodemodeExtension } from '@earendil-works/pi-durable/codemode';
import { createToolSearchTool } from '@earendil-works/pi-durable/tool-search';
import { configure, defineExtension, defineTool } from '@earendil-works/pi-durable';
import { Type } from '@earendil-works/pi-ai';

// Keep the initially offered schemas constant as the host catalogue grows.
export function createDiscovery() {
  const sandbox = new CodemodeSandbox({ memoryLimitBytes: 128 * 1024 * 1024 });
  const nativeCode = createCodemodeExtension({
    sandbox,
    inlineBudget: 1800,
    models: false,
    namespaces: [
      // One line each, saying when to reach for the group. Listed by codemode and describeNamespace().
      { name: 'host', prefix: 'host_', description: "Run shell commands, read and write any file, and deploy the Mars host on the owner's machine." },
      { name: 'workers', prefix: 'worker_', description: 'Hand jobs to helper models and wait for their answers (one job, or several at once).' },
      { name: 'workflows', prefix: 'workflow_', description: 'Run steps one after another in the background, each building on the last.' },
      { name: 'plans', prefix: 'plan_', description: 'Show the owner your step-by-step checklist and tick steps off as you work.' },
      { name: 'artefacts', prefix: 'artefact_', description: 'Read or search the rest of a long saved output by its id.' },
      { name: 'web', prefix: 'web_', description: 'Search the web for current information, and read web pages.' },
      { name: 'sideChats', prefix: 'side_chat_', description: 'Open, list and message side chats nested under this conversation.' },
      { name: 'workspaceFiles', prefix: 'workspace_file_', description: 'Give the owner download links for workspace files.' },
      { name: 'uiPatches', prefix: 'ui_patch_', description: 'Change the Mars interface safely: stage, validate, promote or roll back.' },
      { name: 'discord', prefix: 'discord_', description: "Read the owner's connected Discord server (read-only)." },
      { name: 'plugins', prefix: 'plugin_', description: 'See and switch plugins and their tools on or off.' },
      { name: 'github', prefix: 'github_', description: "Push local git commits to GitHub through the owner's Composio GitHub connection." },
      { name: 'skills', prefix: 'skill_', description: "Find, read, write and install the owner's Markdown skills (saved instructions for kinds of work)." },
    ],
  });
  const codemode = nativeCode.tools.find(t => t.name === 'codemode');
  const boundedCode = defineTool({
    ...codemode,
    execute: (args, api, ctx) => codemode.execute({
      ...args,
      code: /^\s*\/\/ @options:/.test(args.code)
        ? args.code
        : '// @options: {"max_output_tokens": 3000}\n' + args.code,
    }, api, ctx),
  });
  const nativeSearch = createToolSearchTool();
  const search = defineTool({
    ...nativeSearch,
    description: nativeSearch.description + '\nDefault limit is 3. Prefer codemode searchTools for repeated discovery without accumulating model schemas.',
    execute: (args, api, ctx) => nativeSearch.execute({ ...args, limit: args.limit ?? 3 }, api, ctx),
  });
  const modelTools = [boundedCode, search];
  const reset = defineTool({
    name: 'discovery_reset',
    description: `Unload the tools that tool_search added, keeping only codemode and tool_search.
Use it after exploring many tools, when the loaded tool list has grown long and slows you down. Nothing is lost: every tool can still be called from codemode as tools.<name>(...), and tool_search can load any of them again.
Example: await tools.discovery_reset({})`,
    parameters: Type.Object({}),
    structuredOutputSchema: Type.Object({
      reset: Type.Boolean({ description: 'True once the extra tools are unloaded.' }),
      note: Type.String({ description: 'What still works.' }),
    }),
    deferred: true,
    replay: 'safe',
    execute: async (_args, api, ctx) => {
      await api.commit(tx => configure(tx, api.conversationId, { modelTools }, ctx), ctx);
      const value = { reset: true, note: 'Every tool is still callable from codemode, and tool_search can load any again.' };
      return { output: [{ type: 'text', text: JSON.stringify(value) }], structuredOutput: value };
    },
  });
  return {
    modelTools,
    extensions: [
      defineExtension({ ...nativeCode, tools: [boundedCode] }),
      defineExtension({ name: 'tool-search', tools: [search, reset] }),
    ],
    sandbox,
  };
}
