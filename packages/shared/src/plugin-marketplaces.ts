export interface DefaultPluginMarketplace {
  id: string;
  source: string;
  name: string;
  description: string;
  pluginCount: number;
  lastUpdated?: string;
}

export const ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID = "zcode-plugins-official";

/** Settings 三类资源发现共用；Bootstrap 单测与官方 definition 的 defaultEnabled 机械对照。 */
export const DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS: ReadonlySet<string> = new Set([
  "browser-use@zcode-plugins-official",
  "image-search@zcode-plugins-official",
  "documents@zcode-plugins-official",
  "pdf@zcode-plugins-official",
  "presentations@zcode-plugins-official",
  "spreadsheets@zcode-plugins-official",
  // node_repl 宿主：不进市场、不对用户露出，也不贡献任何 skill/command/subagent，但必须
  // 始终可用 —— node_repl 的注册门禁是「Browser Use 或 Computer Use 任一启用」，宿主自己
  // 不参与那个判断。Browser Use 默认开着，宿主若默认关就等于它上来就没有宿主。
  "node-repl-host@zcode-plugins-official",
  "skill-creator@zcode-plugins-official",
  "plugin-creator@zcode-plugins-official",
  "zcode-guide@zcode-plugins-official",
  // 电脑控制回退为默认关闭，故 computer-use 不在此名单内。
  // 该集合必须与 official-plugin-definitions.ts 里标了 defaultEnabled 的插件逐一对应，
  // bootstrap 的「Settings 默认启用集合与 CLI 的官方插件声明一致」单测机械对照两者。
]);

/**
 * The official marketplace catalog is not fetched from any vendor host. Point
 * `ZCODE_OFFICIAL_MARKETPLACE_SOURCE` at a self-hosted `marketplace.json` (or an
 * `owner/repo` git shorthand) to restore the remote catalog. With nothing
 * configured the official marketplace is not registered as a remote source at
 * all, so startup never reaches out to a third party and the official store
 * only exposes the built-in plugins seeded locally. Users can always add their
 * own local or git marketplaces through the personal sources UI.
 */
function readOfficialMarketplaceSource(): string {
  if (typeof process === "undefined" || !process.env) return "";
  return process.env.ZCODE_OFFICIAL_MARKETPLACE_SOURCE?.trim() ?? "";
}

function buildDefaultPluginMarketplaces(
  officialMarketplaceSource: string,
): DefaultPluginMarketplace[] {
  if (!officialMarketplaceSource) return [];
  return [
    {
      // The official marketplace stays a single id: the locally seeded partition
      // and the fetched one are merged inside Agent storage.
      id: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
      source: officialMarketplaceSource,
      name: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
      description: "Official ZCode plugins marketplace: built-in and community plugins for ZCode.",
      pluginCount: 0,
    },
  ];
}

export const DEFAULT_PLUGIN_MARKETPLACES: DefaultPluginMarketplace[] =
  buildDefaultPluginMarketplaces(readOfficialMarketplaceSource());

/**
 * Whether a remote official marketplace catalog origin is configured. Callers use
 * this to skip refreshes that could only fail: without a registered source the
 * official marketplace holds just the locally seeded built-in plugins.
 */
export function hasOfficialPluginMarketplaceSource(): boolean {
  return DEFAULT_PLUGIN_MARKETPLACES.some(
    (marketplace) => marketplace.id === ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
  );
}

// 商店「公开」分段只有一个 ZCode 官方市场 id，内置与 CDN 不再拆分身份。
export const PUBLIC_STORE_MARKETPLACE_IDS = [ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID] as const;

export function isPublicStoreMarketplaceId(id: string): boolean {
  return (PUBLIC_STORE_MARKETPLACE_IDS as readonly string[]).includes(id);
}
