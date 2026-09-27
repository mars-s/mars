import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

/**
 * Endpoint and provider-config environment for the build scripts.
 *
 * ## Why this file exists
 *
 * A different, vendor-built copy of this app is installed at `/Applications/ZCode.app`.
 * When that app launches a shell (its embedded terminal, or any process it spawns) it
 * injects a block of variables into the ambient process environment of everything that
 * shell then starts. That block includes `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`, pointing
 * at the vendor's own provider catalog under `~/.zcode/v2/runtime/provider/...`, and
 * `ZCODE_BASE_URL=https://zcode.z.ai`.
 *
 * The old merge was `{...fileValues, ...env}`, so those ambient values silently beat
 * anything in `.env`. The build then read the vendor catalog, which this fork's release
 * decoder rejects, and the failure surfaced as a bare
 * `Invalid Built-in Provider config (test)` with no hint about the real cause.
 *
 * ## Precedence rule (highest wins)
 *
 *   1. ambient `process.env`, EXCEPT values classified as leaked vendor env
 *   2. `.env.local`
 *   3. `.env`
 *   4. the built-in defaults (empty string, or `config/provider/zcode-builtin.json`)
 *
 * A `.env` file value beats a leaked ambient value. A leaked value never wins at all: it
 * is dropped before the merge. A non-leaked ambient value still beats a file value, so the
 * documented `VAR=1 pnpm build` override keeps working untouched.
 *
 * ## How a value is classified as leaked
 *
 * Two independent signals, either of which is sufficient.
 *
 * **Value evidence (no marker needed).** The value itself is vendor-owned: a host under
 * `z.ai`, `bigmodel.cn`, `bigmodel.com`, `zhipuai.cn` or `zhipu.ai`, or a path inside the
 * vendor runtime cache `~/.zcode/v2/runtime/provider/`, or inside a `ZCode.app` bundle.
 * This fork ships none of these on purpose (see `.env.example`), so a hit is contamination
 * whatever its source.
 *
 * **Launch marker.** `__CFBundleIdentifier` is never read, written or mentioned anywhere
 * in this repository. macOS sets it only for processes launched from inside an app bundle.
 * A build script therefore never has it legitimately, so its presence means the whole
 * ambient `ZCODE_*` / `ZAI_*` block was inherited through a vendor-launched shell. This
 * fork's own packaged app also uses the bundle id `dev.zcode.app`, so the variable's
 * *value* cannot discriminate; only its presence in a build environment can.
 *
 * ## What is deliberately NOT dropped
 *
 * `ZCODE_ENV`, `NODE_ENV` and friends are left alone. The vendor does set `ZCODE_ENV`, but
 * this repo's own dev scripts (`scripts/dev-desktop-env.mjs`) set it explicitly for the
 * build, so dropping it would break a deliberate in-tree setting. It is warned about
 * instead, because a wrong value there only picks the wrong build flavor, which is obvious
 * from the output, unlike a silently wrong provider catalog.
 */

/** Prefix on every diagnostic this module prints, so a grep finds all of them. */
export const VENDOR_ENV_LOG_PREFIX = "[vendor-env]";

/** Doc that holds the copy-pasteable scrub command referenced by every message. */
export const VENDOR_ENV_SCRUB_DOC = ".agents/vendor-env-scrub.md";

/**
 * macOS sets this for any process launched from an app bundle. Nothing in this repository
 * reads or writes it, which is exactly what makes it usable as a leak marker.
 */
export const BUNDLE_LAUNCH_MARKER_VARIABLE = "__CFBundleIdentifier";

/**
 * The full block the vendor build injects. Used for detection and for the scrub command.
 * Names only: the value of `ZAI_OAUTH_CLIENT_ID` is the vendor's real OAuth client id and
 * must never be written down.
 */
export const VENDOR_INJECTED_VARIABLES = [
  "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
  "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE",
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
  BUNDLE_LAUNCH_MARKER_VARIABLE,
];

/**
 * The subset of the vendor block that this repository actually resolves at build time.
 * Only these are removed from the environment, so the blast radius of the filter stays
 * limited to values a stray vendor process could actually change about this build.
 */
export const VENDOR_CONSUMED_VARIABLES = [
  "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
  "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE",
  "ZCODE_BASE_URL",
  "BIGMODEL_API_BASE_URL",
  "ZAI_OAUTH_ORIGIN",
  "ZAI_BUSINESS_BASE_URL",
  "ZCODE_CUA_BUNDLED_HELPER_APP_PATH",
];

/** Build-flavor selector the vendor also sets, warned about but never dropped. */
const ADVISORY_ONLY_VARIABLES = ["ZCODE_ENV"];

const VENDOR_HOST_SUFFIXES = ["z.ai", "bigmodel.cn", "bigmodel.com", "zhipuai.cn", "zhipu.ai"];

const VENDOR_RUNTIME_PATH_PATTERN = /[/\\]\.zcode[/\\]v2[/\\]runtime[/\\]provider[/\\]/i;
const VENDOR_APP_BUNDLE_PATTERN = /[/\\]ZCode\.app[/\\]/i;

/** Matches any absolute URL inside arbitrary text, such as a serialized JSON rule. */
const URL_IN_TEXT_PATTERN = /[a-z][a-z0-9+.-]*:\/\/[^\s"'\\]+/gi;

/** A `env -u A -u B ... <command>` invocation that removes every vendor variable. */
export function buildVendorEnvScrubCommand(command = "<your command here>") {
  return `env ${VENDOR_INJECTED_VARIABLES.map((name) => `-u ${name}`).join(" ")} ${command}`;
}

/** @param {unknown} value */
export function isVendorUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return VENDOR_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/** True when any URL inside the text points at a vendor host. */
export function containsVendorUrl(text) {
  return [...String(text).matchAll(URL_IN_TEXT_PATTERN)].some((match) => isVendorUrl(match[0]));
}

/** @param {string} name @param {string} value */
function describeVendorValue(name, value) {
  if (isVendorUrl(value)) return `it points at a vendor host (${new URL(value).hostname})`;
  if (VENDOR_RUNTIME_PATH_PATTERN.test(value))
    return "it points into the vendor runtime provider cache under ~/.zcode/v2/runtime/provider";
  if (VENDOR_APP_BUNDLE_PATTERN.test(value)) return "it points inside a ZCode.app bundle";
  if (VENDOR_HOST_SUFFIXES.some((suffix) => value.toLowerCase().includes(suffix)))
    return `it names a vendor host (${suffix})`;
  return undefined;
}

/**
 * @param {Record<string, string | undefined>} values
 * @param {{bundleMarker?: string}} [options]
 * @returns {Array<{name: string, value: string, reason: string, origin: "value" | "launch-marker"}>}
 */
function collectVendorEvidence(values, { bundleMarker = "" } = {}) {
  /** @type {Map<string, {name: string, value: string, reason: string, origin: "value" | "launch-marker"}>} */
  const found = new Map();
  for (const name of VENDOR_CONSUMED_VARIABLES) {
    const value = values[name]?.trim();
    if (!value) continue;
    const reason = describeVendorValue(name, value);
    if (reason) found.set(name, { name, value, reason, origin: "value" });
  }
  if (!bundleMarker) return [...found.values()];
  // The marker alone is not enough: a nested build could inherit it from a parent that
  // legitimately set it. Require the vendor block to be present alongside it.
  const signaturePresent = VENDOR_INJECTED_VARIABLES.some(
    (name) => name !== BUNDLE_LAUNCH_MARKER_VARIABLE && Boolean(values[name]?.trim()),
  );
  if (!signaturePresent) return [...found.values()];
  for (const name of VENDOR_CONSUMED_VARIABLES) {
    if (found.has(name)) continue;
    const value = values[name]?.trim();
    if (!value) continue;
    found.set(name, {
      name,
      value,
      reason: `the environment was inherited through an app bundle launch (${BUNDLE_LAUNCH_MARKER_VARIABLE}=${bundleMarker}) together with the vendor variable block`,
      origin: "launch-marker",
    });
  }
  return [...found.values()];
}

/**
 * Classify an ambient environment without reading any file. Exported so the build scripts
 * and the tests can reason about the decision without duplicating it.
 *
 * @param {{env?: Record<string, string | undefined>, values?: Record<string, string | undefined>, includeAdvisory?: boolean}} [options]
 */
export function inspectEnvForVendorLeak({
  env = process.env,
  values,
  includeAdvisory = true,
} = {}) {
  const source = values ?? env;
  const bundleMarker = env[BUNDLE_LAUNCH_MARKER_VARIABLE]?.trim() ?? "";
  const evidence = collectVendorEvidence(source, { bundleMarker });
  const advisory = includeAdvisory
    ? ADVISORY_ONLY_VARIABLES.map((name) => {
        const value = env[name]?.trim();
        return value ? { name, value } : undefined;
      }).filter(Boolean)
    : [];
  return {
    bundleMarker,
    leaked: evidence,
    leakedNames: new Set(evidence.map((item) => item.name)),
    advisory,
  };
}

function formatVendorEnvWarning(item, bundleMarker) {
  const lines = [
    `${VENDOR_ENV_LOG_PREFIX} WARNING: ${item.name} was inherited from another running app, not from this repository.`,
    `${VENDOR_ENV_LOG_PREFIX}   variable: ${item.name}`,
    `${VENDOR_ENV_LOG_PREFIX}   value:    ${item.value}`,
    `${VENDOR_ENV_LOG_PREFIX}   reason:   ${item.reason}`,
  ];
  if (bundleMarker)
    lines.push(
      `${VENDOR_ENV_LOG_PREFIX}   marker:   ${BUNDLE_LAUNCH_MARKER_VARIABLE}=${bundleMarker} (set by macOS for any app-bundle launch, never by this repo)`,
    );
  lines.push(
    `${VENDOR_ENV_LOG_PREFIX}   action:   the value was DROPPED for this build, so the repository default is used instead.`,
    `${VENDOR_ENV_LOG_PREFIX}   scrub:    ${buildVendorEnvScrubCommand("<command>")}`,
    `${VENDOR_ENV_LOG_PREFIX}   details:  ${VENDOR_ENV_SCRUB_DOC}`,
  );
  return lines.join("\n");
}

function formatAdvisoryWarning({ name, value }) {
  return [
    `${VENDOR_ENV_LOG_PREFIX} WARNING: ${name}=${value} came from the ambient environment.`,
    `${VENDOR_ENV_LOG_PREFIX}   It is NOT dropped, because this repo sets it deliberately in scripts/dev-desktop-env.mjs.`,
    `${VENDOR_ENV_LOG_PREFIX}   It only selects the build flavor (test or production). Confirm it is what you want,`,
    `${VENDOR_ENV_LOG_PREFIX}   or run ${buildVendorEnvScrubCommand("<command>")} to clear the whole vendor block.`,
    `${VENDOR_ENV_LOG_PREFIX}   details: ${VENDOR_ENV_SCRUB_DOC}`,
  ].join("\n");
}

/** Raised for conditions the fork refuses to build through, with a plain-terms message. */
export class VendorEnvError extends Error {
  constructor(message) {
    super(message);
    this.name = "VendorEnvError";
  }
}

/** @param {string[]} lines */
function formatVendorEnvError(lines) {
  return [VENDOR_ENV_LOG_PREFIX, ...lines.map((line) => `  ${line}`)].join("\n");
}

async function readEndpointEnvFiles(root) {
  const values = {};
  for (const name of [".env", ".env.local"]) {
    try {
      Object.assign(values, parseEnv(await readFile(resolve(root, name), "utf8")));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return values;
}

/**
 * Merge order is documented at the top of this file. Returns both the merged environment
 * and the audit trail, so `scripts/builtin-provider-config.mjs` can explain, in an error
 * message, exactly where a value came from.
 *
 * @param {{root?: string, env?: Record<string, string | undefined>, warn?: (message: string) => void}} [options]
 */
export async function loadEndpointEnvDetailed({
  root = resolve(import.meta.dirname, ".."),
  env = process.env,
  warn = (message) => console.warn(message),
} = {}) {
  const fileValues = await readEndpointEnvFiles(root);
  const fileLeak = inspectEnvForVendorLeak({ env: fileValues, includeAdvisory: false });
  const ambientLeak = inspectEnvForVendorLeak({ env });
  for (const item of fileLeak.leaked) warn(formatVendorEnvWarning(item, ""));
  for (const item of ambientLeak.leaked)
    warn(formatVendorEnvWarning(item, ambientLeak.bundleMarker));
  for (const item of ambientLeak.advisory) warn(formatAdvisoryWarning(item));

  const fileEnv = { ...fileValues };
  for (const name of fileLeak.leakedNames) delete fileEnv[name];
  const ambientEnv = { ...env };
  for (const name of ambientLeak.leakedNames) delete ambientEnv[name];

  return {
    env: { ...fileEnv, ...ambientEnv },
    fileValues: fileEnv,
    ambientValues: ambientEnv,
    leaked: [...fileLeak.leaked, ...ambientLeak.leaked],
    bundleMarker: ambientLeak.bundleMarker,
  };
}

/**
 * @param {{root?: string, env?: Record<string, string | undefined>, warn?: (message: string) => void}} [options]
 */
export async function loadEndpointEnv({ root, env, warn } = {}) {
  return (await loadEndpointEnvDetailed({ root, env, warn })).env;
}

export { formatVendorEnvError };
