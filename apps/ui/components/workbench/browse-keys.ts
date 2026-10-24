/**
 * The browser pane's browse keys, one per port (docs/WORKBENCH.md "Services and
 * browser"). The host holds keys in memory only and drops one after 15 idle minutes or a
 * restart, so a held key can be dead without the pane knowing: the sandboxed frame shows
 * no status. Reload and a typed address therefore drop the held key and mint a new one.
 */
export type BrowseKeys = {
  /** The key held for `port`, if any. */
  held(port: number): string | undefined;
  /** Forget the key held for `port` and revoke it on the host. */
  drop(port: number): void;
  /** Mint a key for `port` and hold it, revoking any key it replaces. */
  fresh(port: number): Promise<string>;
  /** Revoke every held key (the tab is closing). */
  revokeAll(): void;
};

export function browseKeys(mint: (port: number) => Promise<string>, revoke: (key: string) => void): BrowseKeys {
  const keys = new Map<number, string>();
  return {
    held: (port) => keys.get(port),
    drop(port) {
      const key = keys.get(port);
      keys.delete(port);
      if (key) revoke(key);
    },
    async fresh(port) {
      const key = await mint(port);
      const replaced = keys.get(port);
      keys.set(port, key);
      if (replaced && replaced !== key) revoke(replaced);
      return key;
    },
    revokeAll() {
      for (const key of keys.values()) revoke(key);
      keys.clear();
    },
  };
}
