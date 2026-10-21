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
      { name: 'host', prefix: 'host_', description: 'Owner-authorised shell, files and OS control.' },
      { name: 'workers', prefix: 'worker_', description: 'Selected-model native child agents and workflows.' },
      { name: 'artefacts', prefix: 'artefact_', description: 'Read/search saved results without loading whole files.' },
      { name: 'sideChats', prefix: 'side_chat_', description: 'Open, list and message side chats nested under this conversation.' },
      { name: 'workspaceFiles', prefix: 'workspace_file_', description: 'Download links for workspace files, to hand to the owner.' },
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
    description: 'Reset this conversation to codemode and tool_search schemas after exploring many tools. Capability access stays available through scripts.',
    parameters: Type.Object({}),
    deferred: true,
    replay: 'safe',
    execute: async (_args, api, ctx) => {
      await api.commit(tx => configure(tx, api.conversationId, { modelTools }, ctx), ctx);
      return { output: [{ type: 'text', text: 'Discovery reset. Host tools remain callable through codemode.' }] };
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
