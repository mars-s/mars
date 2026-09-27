import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Packaging half of the phone remote control contract. The runtime resolver is
// owned elsewhere; these tests only pin the packaging side so the two halves
// cannot drift apart silently.
//
// electron-builder.config.js has top level side effects (it reads build metadata
// and the builtin provider config), so it is probed in a child process with the
// vendor build's ambient ZCODE_* env scrubbed out rather than imported here.
const testDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(testDir, "..");
const workspaceRoot = resolve(desktopRoot, "../..");
const webClientDistDir = resolve(workspaceRoot, "packages/web/dist");

const PROBE_MARKER = "__ZCODE_WEB_PACKAGING_PROBE__";
const VENDOR_ENV_KEYS = [
  "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
  "ZCODE_BASE_URL",
  "ZCODE_RUNTIME_ENV",
  "ZCODE_CUA_BUNDLED_HELPER_APP_PATH",
  "ZCODE_CUA_LAUNCHER_PID",
  "ZCODE_PROCESS_LABEL",
  "ZCODE_BUILD_COMMIT_ID",
  "ZCODE_APP_VERSION",
  "ZAI_OAUTH_ORIGIN",
  "ZAI_BUSINESS_BASE_URL",
  "ZAI_OAUTH_CLIENT_ID",
  "__CFBundleIdentifier",
] as const;

const PROBE_SCRIPT = `
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const configModule = await import("./electron-builder.config.js");
const entries = configModule.default.extraResources ?? [];
const webEntry = entries.find((entry) => entry && entry.to === "web") ?? null;

let missingDirMessage = null;
try {
  configModule.assertWebClientBuildOutput(resolve("packages/web", "definitely-not-built"));
} catch (error) {
  missingDirMessage = error instanceof Error ? error.message : String(error);
}

// Stand in for a real vite build output so the success branch is asserted without
// depending on packages/web/dist, which is gitignored and absent in a fresh clone.
const stagedDir = mkdtempSync(join(tmpdir(), "zcode-web-probe-"));
writeFileSync(join(stagedDir, "index.html"), "<!doctype html>");
let stagedMessage = null;
try {
  configModule.assertWebClientBuildOutput(stagedDir);
} catch (error) {
  stagedMessage = error instanceof Error ? error.message : String(error);
}

console.log(${JSON.stringify(PROBE_MARKER)} + JSON.stringify({ webEntry, missingDirMessage, stagedMessage }));
`;

type ProbeResult = {
  webEntry: { from?: string; to?: string } | null;
  missingDirMessage: string | null;
  stagedMessage: string | null;
};

let cachedProbe: ProbeResult | null = null;

function probePackagingConfig(): ProbeResult {
  if (cachedProbe) {
    return cachedProbe;
  }

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !(VENDOR_ENV_KEYS as readonly string[]).includes(key)) {
      env[key] = value;
    }
  }

  const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", PROBE_SCRIPT], {
    cwd: desktopRoot,
    encoding: "utf8",
    env,
  });

  const line = stdout.split("\n").find((candidate) => candidate.startsWith(PROBE_MARKER));
  assert.ok(line, `probe output did not contain ${PROBE_MARKER}: ${stdout}`);
  cachedProbe = JSON.parse(line.slice(PROBE_MARKER.length)) as ProbeResult;
  return cachedProbe;
}

test("stages the built web client into the bundle as resources/web", () => {
  const { webEntry } = probePackagingConfig();

  assert.ok(webEntry, 'electron-builder.config.js has no extraResources entry with to: "web"');
  assert.equal(webEntry.to, "web");
  assert.equal(
    webEntry.from,
    webClientDistDir,
    "the extraResources `from` must resolve to packages/web/dist",
  );
});

test("fails loudly when the web client build output is missing", () => {
  const { missingDirMessage } = probePackagingConfig();

  assert.ok(
    missingDirMessage,
    "assertWebClientBuildOutput must throw when packages/web/dist is absent",
  );
  assert.match(missingDirMessage, /packages[/\\]web[/\\]definitely-not-built[/\\]index\.html/);
  assert.match(
    missingDirMessage,
    /pnpm --filter @zcode\/web build/,
    "the failure must name the command that produces the missing input",
  );
});

test("passes when the web client build output is present, so the preflight never blocks a good build", () => {
  const { stagedMessage } = probePackagingConfig();

  assert.equal(stagedMessage, null);
});
