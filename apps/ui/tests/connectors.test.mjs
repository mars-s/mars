import assert from "node:assert/strict";
import test from "node:test";
import { describeConnector, parseConnectors } from "../lib/pi/connectors.ts";

test("connectors keep only known fields and safe states", () => {
  const parsed = parseConnectors({
    connectors: [
      { id: "linear", name: "Linear", kind: "mcp", transport: "http", url: "https://mcp.linear.app/mcp", auth: { type: "oauth", clientId: "abc" }, status: "exploded", lastError: "x".repeat(900), toolCount: 12, hasKey: false, signedIn: true, accessToken: "at-secret" },
      { id: "files", name: "Files", kind: "mcp", transport: "stdio", command: "npx", args: ["-y", "server"], auth: { type: "key" }, status: "connected", toolCount: 1, hasKey: true },
      { name: "no id" },
    ],
    builtIn: [{ id: "discord", name: "Discord", status: "connected", detail: "Reads the server", token: "secret" }],
    redirectUri: "http://127.0.0.1:3081/api/connectors/oauth/callback",
  });
  assert.equal(parsed.connectors.length, 2);
  assert.equal(parsed.connectors[0].status, "error");
  assert.equal(parsed.connectors[0].lastError.length, 300);
  assert.equal(parsed.connectors[1].address, "npx -y server");
  assert.ok(!JSON.stringify(parsed).includes("secret"));
  assert.equal(describeConnector(parsed.connectors[1]), "Local MCP command, 1 tool, key saved");
  assert.equal(describeConnector(parsed.connectors[0]), "MCP server, OAuth");
  assert.throws(() => parseConnectors({}), /unavailable/);
});
