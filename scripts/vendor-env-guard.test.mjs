/**
 * Guards against the ambient environment injected by the vendor build of this app at
 * /Applications/ZCode.app.
 *
 * The vendor app exports a block of variables into any shell it launches, including
 * `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` pointing at its own provider catalog and
 * `ZCODE_BASE_URL=https://zcode.z.ai`. The old merge in `load-endpoint-env.mjs` was
 * `{...fileValues, ...env}`, so that catalog silently beat the repository one and the build
 * died at `Invalid Built-in Provider config (test)` with no hint about the real cause.
 *
 * These tests pin three contracts:
 *   1. precedence: a `.env` file value beats a leaked ambient value, and a non-leaked
 *      ambient value still beats a file value (the documented `VAR=1 pnpm build` override).
 *   2. the leak detector: value evidence and the `__CFBundleIdentifier` launch marker, and
 *      the variables it must NOT touch (`ZCODE_ENV` is set deliberately in-tree).
 *   3. the hard guards: a config path outside the repository, and a catalog carrying
 *      vendor account rules, both fail with a message that names the cause in plain terms.
 *
 * Run with: node --test scripts/vendor-env-guard.test.mjs
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  assertCatalogHasNoVendorRules,
  assertConfigPathInsideRepository,
  findVendorProviderRules,
  isPathInsideRepository,
  loadBuiltinProviderConfig,
  DEFAULT_BUILTIN_PROVIDER_CONFIG_PATH,
} from "./builtin-provider-config.mjs";
import {
  BUNDLE_LAUNCH_MARKER_VARIABLE,
  buildVendorEnvScrubCommand,
  inspectEnvForVendorLeak,
  loadEndpointEnv,
  loadEndpointEnvDetailed,
  VENDOR_INJECTED_VARIABLES,
} from "./load-endpoint-env.mjs";

/** A value shaped exactly like the one the vendor app injects. Never a real secret. */
const VENDOR_CONFIG_FILE =
  "/Users/someone/.zcode/v2/runtime/provider/darwin-aarch64/3.14.3/endpoint-78d7c3bef4024722642626fe3669a799/zcode-builtin.json";
const VENDOR_BASE_URL = "https://zcode.z.ai";

/** The full leak block, minus the value of the OAuth client id, which is never written down. */
function vendorLeakEnv(overrides = {}) {
  return {
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: VENDOR_CONFIG_FILE,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "/Users/someone/.zcode/v2/provider_config.json",
    ZCODE_BASE_URL: VENDOR_BASE_URL,
    ZCODE_RUNTIME_ENV: "production",
    ZCODE_CUA_BUNDLED_HELPER_APP_PATH:
      "/Applications/ZCode.app/Contents/Resources/cua-helper/ZCode Computer Use.app",
    ZCODE_CUA_LAUNCHER_PID: "4242",
    ZCODE_PROCESS_LABEL: "local-1",
    ZCODE_BUILD_COMMIT_ID: "ab4d5e6b",
    ZCODE_APP_VERSION: "3.14.3",
    ZAI_OAUTH_ORIGIN: "https://chat.z.ai",
    ZAI_BUSINESS_BASE_URL: "https://api.z.ai",
    __CFBundleIdentifier: "dev.zcode.app",
    ...overrides,
  };
}

/** @param {Record<string, string>} files */
async function makeRoot(files) {
  const root = await mkdtemp(resolve(tmpdir(), "zcode-vendor-env-"));
  for (const [name, content] of Object.entries(files)) {
    const path = resolve(root, name);
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, content, "utf8");
  }
  return root;
}

test("precedence: a .env file value beats a leaked ambient value", async () => {
  const root = await makeRoot({ ".env": "ZCODE_BASE_URL=https://build.internal.example\n" });
  try {
    const merged = await loadEndpointEnv({ root, env: vendorLeakEnv(), warn: () => {} });
    assert.equal(
      merged.ZCODE_BASE_URL,
      "https://build.internal.example",
      "the .env value must survive, the vendor ambient value must be dropped",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("precedence: a non-leaked ambient value still beats the .env file", async () => {
  const root = await makeRoot({ ".env": "ZCODE_BASE_URL=https://build.internal.example\n" });
  try {
    const merged = await loadEndpointEnv({
      root,
      env: { ZCODE_BASE_URL: "https://self-hosted.example" },
      warn: () => {},
    });
    assert.equal(merged.ZCODE_BASE_URL, "https://self-hosted.example");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("precedence: .env.local beats .env", async () => {
  const root = await makeRoot({
    ".env": "ZCODE_BASE_URL=https://from-dot-env.example\n",
    ".env.local": "ZCODE_BASE_URL=https://from-dot-env-local.example\n",
  });
  try {
    const merged = await loadEndpointEnv({ root, env: {}, warn: () => {} });
    assert.equal(merged.ZCODE_BASE_URL, "https://from-dot-env-local.example");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("leak detection: the whole vendor block is dropped, the audit trail is returned", async () => {
  const root = await makeRoot({});
  try {
    const messages = [];
    const audit = await loadEndpointEnvDetailed({
      root,
      env: vendorLeakEnv(),
      warn: (m) => messages.push(m),
    });
    assert.equal(audit.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, undefined);
    assert.equal(audit.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, undefined);
    assert.equal(audit.env.ZCODE_BASE_URL, undefined);
    assert.equal(audit.env.ZCODE_CUA_BUNDLED_HELPER_APP_PATH, undefined);
    assert.equal(audit.env.ZAI_OAUTH_ORIGIN, undefined);
    assert.equal(audit.env.ZAI_BUSINESS_BASE_URL, undefined);
    assert.equal(audit.bundleMarker, "dev.zcode.app");
    const warned = audit.leaked.map((item) => item.name);
    for (const name of [
      "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
      "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE",
      "ZCODE_BASE_URL",
      "ZCODE_CUA_BUNDLED_HELPER_APP_PATH",
      "ZAI_OAUTH_ORIGIN",
      "ZAI_BUSINESS_BASE_URL",
    ]) {
      assert.ok(warned.includes(name), `${name} must be reported as leaked`);
    }
    const joined = messages.join("\n");
    assert.ok(joined.includes(VENDOR_CONFIG_FILE), "the warning must name the resolved value");
    assert.ok(joined.includes("env -u "), "the warning must carry the scrub command");
    assert.ok(joined.includes(".agents/vendor-env-scrub.md"), "the warning must point at the doc");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("leak detection: ZCODE_ENV is warned about but never dropped", async () => {
  const root = await makeRoot({});
  try {
    const messages = [];
    const env = await loadEndpointEnv({
      root,
      env: vendorLeakEnv({ ZCODE_ENV: "production" }),
      warn: (m) => messages.push(m),
    });
    assert.equal(env.ZCODE_ENV, "production", "in-tree scripts set this deliberately");
    assert.ok(
      messages.some((m) => m.includes("ZCODE_ENV=production") && m.includes("NOT dropped")),
      "ZCODE_ENV must still be surfaced",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("leak detection: value evidence alone is enough, no marker needed", () => {
  const found = inspectEnvForVendorLeak({ env: { ZCODE_BASE_URL: VENDOR_BASE_URL } });
  assert.deepEqual(
    found.leaked.map((item) => item.name),
    ["ZCODE_BASE_URL"],
  );
  assert.equal(found.bundleMarker, "");
});

test("leak detection: the launch marker needs the vendor block alongside it", () => {
  const markerOnly = inspectEnvForVendorLeak({
    env: { [BUNDLE_LAUNCH_MARKER_VARIABLE]: "dev.zcode.app" },
  });
  assert.deepEqual(markerOnly.leaked, [], "a bare marker is not enough");

  // A self-hosted URL is not vendor evidence, but with the marker and the vendor block
  // present the whole ambient block is foreign, so it goes too.
  const withBlock = inspectEnvForVendorLeak({
    env: {
      [BUNDLE_LAUNCH_MARKER_VARIABLE]: "dev.zcode.app",
      ZCODE_RUNTIME_ENV: "production",
      ZCODE_BASE_URL: "https://api.mycompany.dev",
    },
  });
  assert.deepEqual(
    withBlock.leaked.map((item) => item.name),
    ["ZCODE_BASE_URL"],
  );
  assert.equal(withBlock.leaked[0].origin, "launch-marker");
  assert.ok(withBlock.leaked[0].reason.includes(BUNDLE_LAUNCH_MARKER_VARIABLE));
});

test("leak detection: a self-hosted URL is not a vendor host", () => {
  const found = inspectEnvForVendorLeak({ env: { ZCODE_BASE_URL: "https://api.mycompany.dev" } });
  assert.deepEqual(found.leaked, []);
});

test("leak detection: a .env file that carries a vendor value is filtered too", async () => {
  const root = await makeRoot({ ".env": `ZCODE_BASE_URL=${VENDOR_BASE_URL}\n` });
  try {
    const messages = [];
    const merged = await loadEndpointEnv({ root, env: {}, warn: (m) => messages.push(m) });
    assert.equal(merged.ZCODE_BASE_URL, undefined);
    assert.ok(messages.some((m) => m.includes("ZCODE_BASE_URL") && m.includes(VENDOR_BASE_URL)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scrub command lists every vendor variable and no value", () => {
  const command = buildVendorEnvScrubCommand("pnpm build");
  for (const name of VENDOR_INJECTED_VARIABLES) {
    assert.ok(command.includes(`-u ${name}`), `scrub command must unset ${name}`);
  }
  assert.ok(command.endsWith("pnpm build"));
  assert.ok(command.includes("-u ZAI_OAUTH_CLIENT_ID"), "the name is listed, never its value");
  assert.ok(!/ZAI_OAUTH_CLIENT_ID=\S/.test(command), "no value may follow the OAuth client id");
});

test("repository containment helper", () => {
  assert.equal(isPathInsideRepository("/repo/config/a.json", "/repo"), true);
  assert.equal(isPathInsideRepository("/repo", "/repo"), true);
  assert.equal(isPathInsideRepository("/repo-other/config/a.json", "/repo"), false);
  assert.equal(isPathInsideRepository("/Users/someone/.zcode/x.json", "/repo"), false);
});

test("guard: a config path outside the repository is a hard error naming the variable", () => {
  assert.throws(
    () =>
      assertConfigPathInsideRepository({
        sourcePath: VENDOR_CONFIG_FILE,
        root: "/repo",
        rawValue: VENDOR_CONFIG_FILE,
        origin: "ambient",
      }),
    (error) => {
      assert.equal(error.name, "VendorEnvError");
      const message = error.message;
      assert.ok(message.includes("ZCODE_BUILTIN_PROVIDER_CONFIG_FILE"));
      assert.ok(message.includes(VENDOR_CONFIG_FILE));
      assert.ok(message.includes("/repo"));
      assert.ok(message.includes("env -u "));
      return true;
    },
  );
});

test("guard: a path inside the repository, and the explicit escape hatch, both pass", () => {
  const inside = resolve("/repo", DEFAULT_BUILTIN_PROVIDER_CONFIG_PATH);
  assert.doesNotThrow(() =>
    assertConfigPathInsideRepository({
      sourcePath: inside,
      root: "/repo",
      rawValue: "",
      origin: "default",
    }),
  );
  assert.doesNotThrow(() =>
    assertConfigPathInsideRepository({
      sourcePath: VENDOR_CONFIG_FILE,
      root: "/repo",
      rawValue: VENDOR_CONFIG_FILE,
      origin: "ambient",
      allowExternal: true,
    }),
  );
});

/** A provider rule shaped like the ones the vendor catalog ships. No credentials in it. */
const VENDOR_PROVIDER_RULE = {
  providerId: "account:bigmodel-offpeak-idle-plan",
  providerName: "BigModel Idle plan",
  config: {
    group: "bigmodel-family",
    logo: { type: "builtin", key: "bigmodel" },
    access: { type: "zhipu-account", accountType: "bigmodel", mode: "off-peak" },
    // The public host the vendor ships, and the same string the repository's own
    // providerSiteRules already recognise. No token, no account, nothing secret.
    api: { type: "anthropic-messages", baseUrl: "https://zcode.z.ai/api/v1/off-peak/anthropic" },
    builtinModelIds: ["GLM-example"],
    visibility: "hidden",
  },
};

const CLEAN_PROVIDER_RULE = {
  providerId: "selfhost:llama",
  providerName: "Self hosted",
  config: {
    access: { type: "api-key" },
    api: { type: "openai-compatible", baseUrl: "https://llm.mycompany.dev/v1" },
  },
};

test("guard: a vendor provider rule is detected by every marker it carries", () => {
  const hits = findVendorProviderRules({
    config: { providerConfigRules: { templateRules: [], providerRules: [VENDOR_PROVIDER_RULE] } },
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, "account:bigmodel-offpeak-idle-plan");
  const markers = hits[0].markers.map((m) => m.marker);
  for (const marker of ["zhipu", "bigmodel", "z.ai", "off-peak"]) {
    assert.ok(markers.includes(marker), `expected marker ${marker}, got ${markers.join(", ")}`);
  }
});

test("guard: a self-hosted provider rule is not flagged", () => {
  const hits = findVendorProviderRules({
    config: { providerConfigRules: { templateRules: [], providerRules: [CLEAN_PROVIDER_RULE] } },
  });
  assert.deepEqual(hits, []);
});

test("guard: the repository's own catalog passes the vendor rule scan", async () => {
  const { readFile } = await import("node:fs/promises");
  const content = await readFile(
    resolve(import.meta.dirname, "..", DEFAULT_BUILTIN_PROVIDER_CONFIG_PATH),
    "utf8",
  );
  const document = JSON.parse(content);
  assert.deepEqual(findVendorProviderRules(document), []);
  // The scan is deliberately scoped to providerConfigRules: modelConfigRules legitimately
  // carries providerSiteRules base URL patterns for bigmodel.cn and zcode.z.ai, which only
  // recognise a site a user typed and never introduce a vendor account.
  assert.ok(
    JSON.stringify(document.config.modelConfigRules).includes("bigmodel"),
    "modelConfigRules still mentions bigmodel, which is why the scan is scoped",
  );
});

test("guard: a vendor catalog is a hard error that says why in plain terms", () => {
  assert.throws(
    () =>
      assertCatalogHasNoVendorRules({
        document: {
          revision: 30,
          config: { providerConfigRules: { providerRules: [VENDOR_PROVIDER_RULE] } },
        },
        sourcePath: VENDOR_CONFIG_FILE,
      }),
    (error) => {
      assert.equal(error.name, "VendorEnvError");
      for (const fragment of [
        "account:bigmodel-offpeak-idle-plan",
        "zhipu-account",
        "bigmodel",
        "off-peak",
        "revision: 30",
        "unset ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
        "env -u ",
      ]) {
        assert.ok(error.message.includes(fragment), `error message must contain ${fragment}`);
      }
      return true;
    },
  );
});

test("end to end: a contaminated shell falls back to the repository catalog", async () => {
  const root = resolve(import.meta.dirname, "..");
  const messages = [];
  const originalWarn = console.warn;
  console.warn = (message) => messages.push(String(message));
  try {
    const config = await loadBuiltinProviderConfig({ root, env: vendorLeakEnv() });
    assert.equal(config.sourcePath, resolve(root, DEFAULT_BUILTIN_PROVIDER_CONFIG_PATH));
    assert.equal(
      config.content,
      await (
        await import("node:fs/promises")
      ).readFile(resolve(root, DEFAULT_BUILTIN_PROVIDER_CONFIG_PATH), "utf8"),
    );
    assert.ok(messages.some((m) => m.includes("ZCODE_BUILTIN_PROVIDER_CONFIG_FILE")));
  } finally {
    console.warn = originalWarn;
  }
});

test("end to end: the vendor catalog on disk fails with the plain-terms error, not a schema error", async () => {
  const vendorCatalog = {
    schemaVersion: 1,
    revision: 30,
    config: {
      providerConfigRules: { templateRules: [], providerRules: [VENDOR_PROVIDER_RULE] },
      modelConfigRules: {},
    },
  };
  const outside = await mkdtemp(resolve(tmpdir(), "zcode-vendor-catalog-"));
  const catalogPath = resolve(outside, "zcode-builtin.json");
  await writeFile(catalogPath, JSON.stringify(vendorCatalog), "utf8");
  const root = await makeRoot({});
  try {
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await assert.rejects(
        () =>
          loadBuiltinProviderConfig({
            root,
            env: {
              ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: catalogPath,
              ZCODE_ALLOW_EXTERNAL_BUILTIN_PROVIDER_CONFIG: "1",
            },
          }),
        (error) => {
          assert.equal(error.name, "VendorEnvError");
          assert.ok(
            !error.message.startsWith("Invalid Built-in Provider config"),
            "the wrapper must not bury the real cause",
          );
          assert.ok(error.message.includes("vendor account rules"));
          return true;
        },
      );
    } finally {
      console.warn = originalWarn;
    }
  } finally {
    await rm(outside, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
