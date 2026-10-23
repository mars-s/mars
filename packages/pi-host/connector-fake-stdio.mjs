// A stdio MCP server for check-connectors.mjs: newline-delimited JSON-RPC on stdin/stdout.
// Prints a plain log line first, to prove the client skips non-JSON output.
import { createInterface } from "node:readline";

process.stdout.write("fake stdio server starting\n");
process.stderr.write("fake stdio server log\n");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const tools = [
  { name: "env-names", description: "List the environment variable names this server received.", inputSchema: { type: "object", properties: {} } },
  { name: "echo", description: "Echo the text back.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
];
createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-stdio", version: "1.0.0" } } });
  if (message.method === "tools/list") return send({ jsonrpc: "2.0", id: message.id, result: { tools } });
  if (message.method === "tools/call") {
    const { name, arguments: args = {} } = message.params;
    if (name === "env-names") return send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify(Object.keys(process.env).sort()) }] } });
    if (name === "echo") return send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "stdio echo: " + args.text }] } });
  }
  send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
});
