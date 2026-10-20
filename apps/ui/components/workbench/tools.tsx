import {
  AppWindow,
  FilePlus2,
  FolderTree,
  GitCompareArrows,
  Globe,
  MessageSquarePlus,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react";
import type { ToolKind } from "./workbench-state";

export type ToolSpec = {
  kind: Exclude<ToolKind, "launcher" | "extension">;
  title: string;
  Icon: LucideIcon;
  /** Shown in the tile; also bound globally while the workbench is open. */
  shortcut: { label: string; key: string; shift?: boolean; alt?: boolean };
};

export const TOOLS: ToolSpec[] = [
  { kind: "changes", title: "Changes", Icon: GitCompareArrows, shortcut: { label: "⌃⇧G", key: "g", shift: true } },
  { kind: "terminal", title: "Terminal", Icon: SquareTerminal, shortcut: { label: "⌃`", key: "`" } },
  { kind: "files", title: "Files", Icon: FolderTree, shortcut: { label: "⌃⇧P", key: "p", shift: true } },
  { kind: "side-chat", title: "Side chat", Icon: MessageSquarePlus, shortcut: { label: "⌃⌥S", key: "s", alt: true } },
  { kind: "page", title: "New page", Icon: FilePlus2, shortcut: { label: "⌃⇧N", key: "n", shift: true } },
  { kind: "browser", title: "Browser", Icon: Globe, shortcut: { label: "⌃⇧B", key: "b", shift: true } },
];

export const toolTitle = (kind: ToolKind) =>
  kind === "launcher" ? "New tab" : kind === "extension" ? "Extension" : (TOOLS.find((tool) => tool.kind === kind)?.title ?? kind);
export const toolIcon = (kind: ToolKind): LucideIcon =>
  kind === "extension" || kind === "launcher" ? AppWindow : (TOOLS.find((tool) => tool.kind === kind)?.Icon ?? AppWindow);
