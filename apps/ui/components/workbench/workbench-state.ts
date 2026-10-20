// Pure workbench model (docs/WORKBENCH.md). No React or DOM imports: node --test loads it directly.

export type ToolKind =
  | "launcher"
  | "changes"
  | "files"
  | "terminal"
  | "side-chat"
  | "page"
  | "browser"
  | "extension";

export type WorkbenchTab =
  | { id: string; kind: "launcher" }
  | { id: string; kind: "changes"; repo?: string }
  | { id: string; kind: "files"; path?: string }
  | { id: string; kind: "terminal"; sessionId?: string }
  | { id: string; kind: "side-chat"; conversationId?: string }
  | { id: string; kind: "page"; name?: string }
  | { id: string; kind: "browser"; url?: string }
  | { id: string; kind: "extension"; hash: string; title: string };

export type TabTarget = DistributiveOmit<WorkbenchTab, "id">;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type WorkbenchState = {
  open: boolean;
  expanded: boolean;
  /** Preferred width in pixels; the layout clamps it to the space available. */
  width: number;
  tabs: WorkbenchTab[];
  activeId: string;
};

export type WorkbenchAction =
  | { type: "hydrate"; state: WorkbenchState }
  | { type: "open" }
  | { type: "close" }
  | { type: "toggle-expanded" }
  | { type: "resize"; width: number }
  | { type: "new-tab" }
  | { type: "open-tool"; target: TabTarget; replace?: string }
  | { type: "select"; id: string }
  | { type: "close-tab"; id: string }
  | { type: "update"; id: string; patch: Partial<TabTarget> };

export const MIN_WIDTH = 360;
export const DEFAULT_WIDTH = 560;
export const STORAGE_KEY = "mars-workbench-v1";

let counter = 0;
export const newId = () => `tab-${Date.now().toString(36)}-${(counter++).toString(36)}`;

const launcher = (): WorkbenchTab => ({ id: newId(), kind: "launcher" });

export function initialState(): WorkbenchState {
  const first = launcher();
  return { open: false, expanded: false, width: DEFAULT_WIDTH, tabs: [first], activeId: first.id };
}

/** Clamp to the documented range; the layout applies the viewport bound on top. */
export const clampWidth = (width: number, available = Number.POSITIVE_INFINITY) =>
  Math.round(Math.max(MIN_WIDTH, Math.min(width, Math.max(MIN_WIDTH, available))));

const sameTarget = (tab: WorkbenchTab, target: TabTarget) =>
  JSON.stringify({ ...tab, id: undefined }) === JSON.stringify({ ...target, id: undefined });

export function reduce(state: WorkbenchState, action: WorkbenchAction): WorkbenchState {
  switch (action.type) {
    case "hydrate":
      return action.state;
    case "open":
      return state.tabs.length ? { ...state, open: true } : { ...initialState(), width: state.width, open: true };
    case "close":
      return { ...state, open: false, expanded: false };
    case "toggle-expanded":
      return { ...state, expanded: !state.expanded };
    case "resize":
      return { ...state, width: clampWidth(action.width) };
    case "new-tab": {
      const tab = launcher();
      return { ...state, open: true, tabs: [...state.tabs, tab], activeId: tab.id };
    }
    case "open-tool": {
      // Reopening the same target selects its existing tab instead of duplicating it.
      const existing = state.tabs.find((tab) => tab.kind !== "launcher" && sameTarget(tab, action.target));
      if (existing) return { ...state, open: true, activeId: existing.id };
      const tab = { ...action.target, id: newId() } as WorkbenchTab;
      const index = action.replace ? state.tabs.findIndex((item) => item.id === action.replace) : -1;
      const tabs = index >= 0 ? state.tabs.map((item, i) => (i === index ? tab : item)) : [...state.tabs, tab];
      return { ...state, open: true, tabs, activeId: tab.id };
    }
    case "select":
      return state.tabs.some((tab) => tab.id === action.id) ? { ...state, activeId: action.id } : state;
    case "close-tab": {
      const index = state.tabs.findIndex((tab) => tab.id === action.id);
      if (index < 0) return state;
      const tabs = state.tabs.filter((tab) => tab.id !== action.id);
      if (!tabs.length) return { ...initialState(), width: state.width };
      const activeId =
        state.activeId === action.id ? tabs[Math.min(index, tabs.length - 1)].id : state.activeId;
      return { ...state, tabs, activeId };
    }
    case "update":
      return {
        ...state,
        tabs: state.tabs.map((tab) =>
          tab.id === action.id ? ({ ...tab, ...action.patch, id: tab.id, kind: tab.kind } as WorkbenchTab) : tab,
        ),
      };
  }
}

const KINDS: readonly ToolKind[] = ["launcher", "changes", "files", "terminal", "side-chat", "page", "browser", "extension"];
const str = (value: unknown) => (typeof value === "string" ? value : undefined);

function parseTab(value: unknown): WorkbenchTab | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  const id = str(row.id);
  const kind = str(row.kind) as ToolKind | undefined;
  if (!id || !kind || !KINDS.includes(kind)) return undefined;
  switch (kind) {
    case "launcher":
      return { id, kind };
    case "changes":
      return { id, kind, repo: str(row.repo) };
    case "files":
      return { id, kind, path: str(row.path) };
    case "terminal":
      return { id, kind, sessionId: str(row.sessionId) };
    case "side-chat":
      return { id, kind, conversationId: str(row.conversationId) };
    case "page":
      return { id, kind, name: str(row.name) };
    case "browser":
      return { id, kind, url: str(row.url) };
    case "extension": {
      const hash = str(row.hash);
      return hash && /^[a-f0-9]{64}$/.test(hash) ? { id, kind, hash, title: str(row.title) || "Extension" } : undefined;
    }
  }
}

/** Parse persisted state; anything malformed falls back to a fresh closed workbench. */
export function parseState(raw: string | null): WorkbenchState {
  if (!raw) return initialState();
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const tabs = (Array.isArray(value.tabs) ? value.tabs : []).flatMap((tab) => parseTab(tab) ?? []);
    if (!tabs.length) return initialState();
    const activeId = str(value.activeId);
    return {
      open: value.open === true,
      expanded: value.expanded === true,
      width: clampWidth(typeof value.width === "number" && Number.isFinite(value.width) ? value.width : DEFAULT_WIDTH),
      tabs,
      activeId: activeId && tabs.some((tab) => tab.id === activeId) ? activeId : tabs[0].id,
    };
  } catch {
    return initialState();
  }
}

export const serialiseState = (state: WorkbenchState) => JSON.stringify(state);
