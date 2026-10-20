import { record } from "./live-state";
export type Plugin = {
  name: string;
  title: string;
  description: string;
  version: string;
  kind: "extension" | "system" | "mcp";
  enabled: boolean;
  uiEnabled: boolean;
  hasUi: boolean;
  tools: { name: string; description: string; enabled: boolean }[];
};
export function parsePlugins(value: unknown): Plugin[] {
  return (Array.isArray(value) ? value : []).map(record).flatMap((row) => {
    if (typeof row.name !== "string" || !row.name || typeof row.enabled !== "boolean") return [];
    return [
      {
        name: row.name,
        title: typeof row.title === "string" ? row.title : row.name,
        description: typeof row.description === "string" ? row.description : "",
        version: typeof row.version === "string" ? row.version : "",
        kind: row.kind === "extension" || row.kind === "mcp" ? row.kind : "system",
        enabled: row.enabled,
        uiEnabled: row.uiEnabled === true,
        hasUi: row.hasUi === true,
        tools: (Array.isArray(row.tools) ? row.tools : []).map(record).flatMap((tool) =>
          typeof tool.name === "string" && typeof tool.enabled === "boolean"
            ? [
                {
                  name: tool.name,
                  description: typeof tool.description === "string" ? tool.description : "",
                  enabled: tool.enabled,
                },
              ]
            : [],
        ),
      } satisfies Plugin,
    ];
  });
}
