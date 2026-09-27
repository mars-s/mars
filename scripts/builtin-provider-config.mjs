import {
  buildVendorEnvScrubCommand,
  containsVendorUrl,
  formatVendorEnvError,
  loadEndpointEnvDetailed,
  VendorEnvError,
  VENDOR_ENV_SCRUB_DOC,
} from "./load-endpoint-env.mjs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { parseEnv } from "node:util";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";

const repositoryRoot = resolve(import.meta.dirname, "..");

/** The only catalog path this fork builds from when nothing overrides it. */
export const DEFAULT_BUILTIN_PROVIDER_CONFIG_PATH = "config/provider/zcode-builtin.json";

/** Escape hatch for a deliberate external catalog. Never set by accident. */
export const ALLOW_EXTERNAL_CONFIG_VARIABLE = "ZCODE_ALLOW_EXTERNAL_BUILTIN_PROVIDER_CONFIG";

/**
 * Markers that identify a provider or template rule belonging to the vendor build.
 *
 * Scoped deliberately to `config.providerConfigRules` (templateRules + providerRules) and
 * not to the whole document: this repository's own catalog legitimately carries
 * `providerSiteRules` base URL patterns such as `https://open.bigmodel.cn/api/anthropic/`
 * inside `modelConfigRules`, because those rules only recognise a site a user typed, they
 * never introduce a vendor account. A whole-document scan would reject the repo's own
 * checked-in catalog, so it is not used.
 */
export const VENDOR_PROVIDER_RULE_MARKERS = [
  { marker: "zhipu-account", pattern: /zhipu-account/i, what: "a Zhipu account access type" },
  { marker: "zhipu", pattern: /zhipu/i, what: "a Zhipu reference" },
  {
    marker: "bigmodel",
    pattern: /bigmodel/i,
    what: "a BigModel account, plan or logo",
  },
  {
    marker: "z.ai",
    matches: (text) => containsVendorUrl(text),
    what: "a z.ai endpoint",
  },
  {
    marker: "off-peak",
    pattern: /off-peak/i,
    what: "a vendor off-peak plan",
  },
];

/** @param {{root?: string, env?: Record<string, string | undefined>}} options */
export async function resolveBuiltinProviderBuildEnvironment({
  root = repositoryRoot,
  env = process.env,
} = {}) {
  let value = env.ZCODE_ENV;
  if (!value?.trim()) {
    const files = [
      ".env",
      ...(env.NODE_ENV === "production"
        ? [".env.production"]
        : [".env.development", ".env.development.local"]),
    ];
    for (const file of files) {
      let content;
      try {
        content = await readFile(resolve(root, file), "utf8");
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      const parsed = parseEnv(content);
      if (parsed.ZCODE_ENV !== undefined) value = parsed.ZCODE_ENV;
    }
  }
  const normalized = value?.trim().toLowerCase() || "test";
  if (normalized !== "test" && normalized !== "production") {
    throw new Error(`Invalid ZCODE_ENV for Built-in Provider build: ${normalized}`);
  }
  return normalized;
}

/** @param {string} child @param {string} parent */
export function isPathInsideRepository(child, parent) {
  const relativePath = relative(parent, child);
  return (
    relativePath === "" ||
    (!relativePath.startsWith(`..${sep}`) &&
      relativePath !== ".." &&
      !/^[A-Za-z]:/.test(relativePath))
  );
}

/**
 * Hard error when the resolved catalog lives outside the repository root.
 *
 * Why a hard error and not a warning: after the leak filter in `load-endpoint-env.mjs` runs,
 * a surviving value is one the developer can actually see and change, in `.env` or in their
 * own shell. Silently building someone else's catalog, or silently building from a
 * gitignored scratch file that a colleague does not have, produces an artifact nobody
 * reviewed. The build stops, names the variable and the path, and prints the scrub command.
 *
 * @param {{sourcePath: string, root: string, rawValue: string, origin: "default" | "env", allowExternal?: boolean}} options
 */
export function assertConfigPathInsideRepository({
  sourcePath,
  root,
  rawValue,
  origin,
  allowExternal = false,
}) {
  if (allowExternal || isPathInsideRepository(sourcePath, root)) return;
  throw new VendorEnvError(
    formatVendorEnvError([
      "ERROR: the Built-in Provider config path points outside this repository.",
      `variable: ZCODE_BUILTIN_PROVIDER_CONFIG_FILE (${origin === "default" ? "default" : "from the environment"})`,
      `value:    ${rawValue}`,
      `resolved: ${sourcePath}`,
      `root:     ${root}`,
      "reason:   this fork builds only from a catalog inside the repository. An external path",
      "          means the build would package a catalog nobody here checked in, and if it",
      "          points at the vendor app at /Applications/ZCode.app it would be rejected",
      '          later with a confusing "Invalid Built-in Provider config" message that names',
      "          no cause.",
      `fix:      delete ZCODE_BUILTIN_PROVIDER_CONFIG_FILE to use ${DEFAULT_BUILTIN_PROVIDER_CONFIG_PATH},`,
      `          or point it at a path under ${root}.`,
      `override: set ${ALLOW_EXTERNAL_CONFIG_VARIABLE}=1 if you truly mean to load a catalog from outside the repo.`,
      `scrub:    ${buildVendorEnvScrubCommand("<command>")}`,
      `details:  ${VENDOR_ENV_SCRUB_DOC}`,
    ]),
  );
}

/**
 * @param {unknown} document a parsed release JSON document
 * @returns {Array<{kind: "templateRule" | "providerRule", id: string, name: string, markers: Array<{marker: string, what: string}>}>}
 */
export function findVendorProviderRules(document) {
  const providerConfigRules = /** @type {any} */ (document)?.config?.providerConfigRules;
  if (!providerConfigRules || typeof providerConfigRules !== "object") return [];
  /** @type {Array<{kind: "templateRule" | "providerRule", id: string, name: string, markers: Array<{marker: string, what: string}>}>} */
  const hits = [];
  const groups = [
    {
      kind: /** @type {const} */ ("templateRule"),
      key: "templateRules",
      idKey: "templateId",
      nameKey: "templateName",
    },
    {
      kind: /** @type {const} */ ("providerRule"),
      key: "providerRules",
      idKey: "providerId",
      nameKey: "providerName",
    },
  ];
  for (const group of groups) {
    const rules = providerConfigRules[group.key];
    if (!Array.isArray(rules)) continue;
    for (const rule of rules) {
      if (!rule || typeof rule !== "object") continue;
      const id = String(rule[group.idKey] ?? "<no id>");
      const name = String(rule[group.nameKey] ?? "");
      const serialized = JSON.stringify(rule);
      const markers = VENDOR_PROVIDER_RULE_MARKERS.filter((entry) =>
        entry.pattern ? entry.pattern.test(serialized) : entry.matches(serialized),
      ).map((entry) => ({ marker: entry.marker, what: entry.what }));
      if (markers.length > 0) hits.push({ kind: group.kind, id, name, markers });
    }
  }
  return hits;
}

/**
 * Hard error when the catalog this build is about to package carries vendor account plans.
 *
 * Why a hard error: the vendor catalog would otherwise put the vendor's accounts, logos,
 * plans and pricing into this fork's shipped build. That is the one failure mode in this
 * area that is not self-announcing, so it must not be a warning.
 *
 * @param {{document: unknown, sourcePath: string}} options
 */
export function assertCatalogHasNoVendorRules({ document, sourcePath }) {
  const hits = findVendorProviderRules(document);
  if (hits.length === 0) return;
  const revision = /** @type {any} */ (document)?.revision;
  const lines = [
    "ERROR: refusing a Built-in Provider catalog that contains vendor account rules.",
    `file:     ${sourcePath}`,
    `revision: ${typeof revision === "number" ? revision : "<unknown>"}`,
    ...hits.map(
      (hit) =>
        `rule:     ${hit.kind} ${hit.id}${hit.name ? ` ("${hit.name}")` : ""}` +
        ` carries ${hit.markers.map((entry) => `"${entry.marker}" (${entry.what})`).join(", ")}`,
    ),
    "reason:   The vendor build of this app ships account plans for z.ai and BigModel,",
    `          including the ${'"zhipu-account"'} access type with accountType "bigmodel" and`,
    '          mode "off-peak". This fork removed those vendors, and the repository catalog',
    `          ${DEFAULT_BUILTIN_PROVIDER_CONFIG_PATH} never contains them. Loading this file`,
    "          would put the vendor's accounts, logos and pricing into this build.",
    "fix:      unset ZCODE_BUILTIN_PROVIDER_CONFIG_FILE and rebuild, so the repository catalog is used.",
    `scrub:    ${buildVendorEnvScrubCommand("<command>")}`,
    `details:  ${VENDOR_ENV_SCRUB_DOC}`,
  ];
  throw new VendorEnvError(formatVendorEnvError(lines));
}

/** @param {{root?: string, env?: Record<string, string | undefined>, warn?: (message: string) => void}} options */
export async function loadBuiltinProviderConfig({ root = repositoryRoot, env = process.env } = {}) {
  const audit = await loadEndpointEnvDetailed({ root, env });
  env = audit.env;
  const environment = await resolveBuiltinProviderBuildEnvironment({ root, env });
  const rawValue = env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE?.trim() || "";
  const sourcePath = resolve(root, rawValue || DEFAULT_BUILTIN_PROVIDER_CONFIG_PATH);
  assertConfigPathInsideRepository({
    sourcePath,
    root,
    rawValue: rawValue || `(unset, defaulted to ${DEFAULT_BUILTIN_PROVIDER_CONFIG_PATH})`,
    origin: rawValue
      ? audit.ambientValues.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE
        ? "ambient"
        : "file"
      : "default",
    allowExternal: env[ALLOW_EXTERNAL_CONFIG_VARIABLE]?.trim() === "1",
  });
  try {
    const content = await readFile(sourcePath, "utf8");
    const document = JSON.parse(content);
    // 厂商目录的拒绝对开发者的可读性远高于 schema 报错：先说清楚"这是别人的目录"，再说字段。
    assertCatalogHasNoVendorRules({ document, sourcePath });
    // 构建期复用运行时的完整 Release 校验，避免打包成功后才发现 Schema 不兼容。
    // tsx 仅供构建工具加载仓库 TS，不进入产品 bundle，也不复制一份校验规则。
    // Windows 绝对路径的盘符会被 ESM 当作协议，转为 file URL 后各平台共用同一加载入口。
    const { decodeZCodeBuiltinRelease } = await tsImport(
      pathToFileURL(resolve(repositoryRoot, "packages/provider-node/src/zcode-builtin-release.ts"))
        .href,
      import.meta.url,
    );
    decodeZCodeBuiltinRelease(document);
    return { environment, sourcePath, content };
  } catch (error) {
    if (error instanceof VendorEnvError) throw error;
    throw new Error(`Invalid Built-in Provider config (${environment}): ${sourcePath}`, {
      cause: error,
    });
  }
}

/** @param {{directory: string, root?: string, env?: Record<string, string | undefined>}} options */
export async function stageBuiltinProviderConfig({ directory, ...options }) {
  const config = await loadBuiltinProviderConfig(options);
  await mkdir(directory, { recursive: true });
  // bootstrap 可以复用 JS，但不能连带复用上一环境／上一版本的独立配置资源。
  await writeFile(resolve(directory, "zcode-builtin.json"), config.content, "utf8");
  return config;
}
