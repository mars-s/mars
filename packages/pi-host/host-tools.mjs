// Small host tools the agent uses to work with the owner: workspace download links and
// the plugin switches. Written to docs/TOOLS.md; check-tool-quality.mjs enforces it.
import { Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';

const output = (value) => ({ output: [{ type: 'text', text: JSON.stringify(value) }], structuredOutput: value });

/** `workspace_file_link`: a checked download URL for a workspace file. `files` is the workbench Files module. */
export function createWorkspaceFilesExtension({ files }) {
  return defineExtension({
    name: 'mars-workspace-files',
    tools: [
      defineTool({
        name: 'workspace_file_link',
        description: `Get a download link for a workspace file, to give the owner in chat.
Use it when the owner should download something you made or found: a report, an export, an image. Put the url in your reply as a Markdown link, e.g. [report.pdf](url); the owner's browser downloads it as a file. The file's contents are not returned; read files with read or host_read. Files outside the workspace, folders, hard-linked files and files over 20 MiB are refused with a plain reason.
Example: const { url } = await tools.workspace_file_link({ path: "exports/report.csv" })`,
        parameters: Type.Object({
          path: Type.String({ minLength: 1, maxLength: 4096, description: 'File path relative to the workspace folder, e.g. "exports/report.csv".' }),
        }),
        structuredOutputSchema: Type.Object({
          path: Type.String({ description: 'The checked path, relative to the workspace.' }),
          size: Type.Integer({ description: 'File size in bytes.' }),
          url: Type.String({ description: 'Download link, relative to the Mars app, e.g. "/api/workbench/download?path=exports%2Freport.csv".' }),
        }),
        deferred: true,
        replay: 'safe',
        execute: async (args) => output(await files().link(args.path)),
      }),
    ],
  });
}

const PluginTool = Type.Object({
  name: Type.String({ description: 'Tool name.' }),
  description: Type.String({ description: 'What the tool does.' }),
  enabled: Type.Boolean({ description: 'Whether the agent can currently use it.' }),
});
const PluginSummary = {
  name: Type.String({ description: 'Plugin name; pass it to plugin_list or plugin_configure.' }),
  title: Type.String({ description: 'Human title shown in Extensions.' }),
  description: Type.String({ description: 'What the plugin is for.' }),
  kind: Type.String({ description: '"system", "extension" or "mcp".' }),
  enabled: Type.Boolean({ description: 'Whether the plugin is switched on.' }),
  hasUi: Type.Boolean({ description: 'Whether it has an interface the owner can open.' }),
  uiEnabled: Type.Boolean({ description: 'Whether that interface is switched on.' }),
};

/** `plugin_list` and `plugin_configure` over the owner-visible plugin settings. */
export function createPluginControlExtension({ plugins }) {
  return defineExtension({
    name: 'plugin-control',
    tools: [
      defineTool({
        name: 'plugin_list',
        description: `List installed plugins, or the tools inside one plugin.
Use it to see what is switched on before calling plugin_configure, or to find which plugin a tool belongs to. Without name: a page of plugins with tool counts. With name: that plugin and a page of its tools. Pages are 10 by default; use offset to page. Results match the Extensions page the owner sees.
Example: await tools.plugin_list({ name: "web-search" })`,
        parameters: Type.Object({
          name: Type.Optional(Type.String({ description: 'Plugin name, e.g. "web-search". Omit to list all plugins.' })),
          offset: Type.Optional(Type.Integer({ minimum: 0, default: 0, description: 'How many plugins (or tools, with name) to skip, for paging.' })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 25, default: 10, description: 'How many to return, 1 to 25.' })),
        }),
        structuredOutputSchema: Type.Union([
          Type.Object({
            plugins: Type.Array(Type.Object({ ...PluginSummary, totalTools: Type.Integer({ description: 'How many tools it has.' }) })),
            totalPlugins: Type.Integer({ description: 'How many plugins are installed in all.' }),
          }),
          Type.Object({ ...PluginSummary, tools: Type.Array(PluginTool), totalTools: Type.Integer({ description: 'How many tools it has in all.' }) }),
        ]),
        deferred: true,
        replay: 'safe',
        outputLimits: { maxBytes: 16000, maxLines: 200 },
        execute: async (args) => {
          const rows = plugins.list();
          const from = args.offset || 0;
          const to = from + (args.limit || 10);
          if (args.name) {
            const row = rows.find((item) => item.name === args.name);
            if (!row) throw Error(`No plugin is named "${args.name}". Call plugin_list without name to see the names.`);
            return output({ ...row, tools: row.tools.slice(from, to), totalTools: row.tools.length });
          }
          return output({ plugins: rows.slice(from, to).map(({ tools, ...row }) => ({ ...row, totalTools: tools.length })), totalPlugins: rows.length });
        },
      }),
      defineTool({
        name: 'plugin_configure',
        description: `Turn a plugin, its interface or one of its tools on or off.
Use it whenever the owner asks to turn a tool, plugin or capability on, off, enable or disable it (e.g. "turn off web_fetch"). It does not run the tool; it changes what the agent can use, not the owner's permissions on the machine. The change is saved and shows in Extensions straight away. Pass only the switches to change.
Example: await tools.plugin_configure({ name: "web-search", tools: { web_fetch: false } })`,
        parameters: Type.Object({
          name: Type.String({ description: 'Plugin name from plugin_list, e.g. "web-search".' }),
          enabled: Type.Optional(Type.Boolean({ description: 'true switches the whole plugin on, false off.' })),
          uiEnabled: Type.Optional(Type.Boolean({ description: "true or false for the plugin's interface, when it has one." })),
          tools: Type.Optional(Type.Record(Type.String(), Type.Boolean(), { description: 'Per-tool switches by tool name, e.g. { "web_fetch": false }.' })),
        }),
        structuredOutputSchema: Type.Object({
          name: Type.String({ description: 'The plugin changed.' }),
          enabled: Type.Boolean({ description: 'Whether the plugin is now on.' }),
          uiEnabled: Type.Boolean({ description: 'Whether its interface is now on.' }),
          changedTools: Type.Array(PluginTool, { description: 'The tools named in the call, with their new state.' }),
        }),
        deferred: true,
        replay: 'safe',
        execute: async (args) => {
          const row = await plugins.set(args);
          return output({ name: row.name, enabled: row.enabled, uiEnabled: row.uiEnabled, changedTools: Object.keys(args.tools || {}).map((name) => row.tools.find((tool) => tool.name === name)).filter(Boolean) });
        },
      }),
    ],
  });
}
