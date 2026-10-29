"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  Ellipsis,
  FolderMinus,
  FolderPlus,
  Folder,
  MessageSquareDashed,
  Pencil,
  Pin,
  PinOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { useWorkspace } from "@/components/workspace-context";
import { piRequest, type ConversationSummary, type SideChatSummary } from "@/lib/pi/live-state";
import { ChannelMark } from "./channel-mark";
import { knownArchive, mergeArchive, parseArchive, type ArchiveItem } from "@/lib/pi/archive";
import { ChildNavigation } from "./child-navigation";

/** Must match GROUP_MAX in packages/pi-host/conversations.mjs. */
const GROUP_MAX = 60;
const FOLDED_KEY = "mars-sidebar-folded";
const ARCHIVED = "\u0000archived";

/** What the name dialog is for: renaming any chat, or naming a new group for a top-level chat. */
type Naming = { kind: "rename" | "group"; id: string; title: string } | null;

/** Which sections are folded is a browser preference, like the theme. Archived starts folded. */
function useFolded() {
  const [folded, setFolded] = useState<Set<string>>(() => new Set([ARCHIVED]));
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(FOLDED_KEY) ?? "null");
      if (Array.isArray(saved))
        setFolded(new Set(saved.filter((key) => typeof key === "string")));
    } catch {
      /* Browser storage is optional. */
    }
  }, []);
  const toggle = (key: string) =>
    setFolded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        localStorage.setItem(FOLDED_KEY, JSON.stringify([...next]));
      } catch {
        /* Browser storage is optional. */
      }
      return next;
    });
  return [folded, toggle] as const;
}

/**
 * Recents, filed by the owner: named groups first, then ungrouped chats (the default list),
 * then Archived. Groups and the archived flag are native Pi documents on each chat.
 */
export function ConversationList() {
  const { conversations, selectedId, extensionsOpen } = useWorkspace();
  const [folded, toggle] = useFolded();
  const [naming, setNaming] = useState<Naming>(null);
  const { pinned, groups, recents } = useMemo(() => {
    const live = conversations.filter((row) => !row.archived && !row.pinned);
    const byGroup = new Map<string, ConversationSummary[]>();
    for (const row of live)
      if (row.group)
        byGroup.set(row.group, [...(byGroup.get(row.group) ?? []), row]);
    return {
      pinned: conversations.filter((row) => row.pinned && !row.archived),
      groups: [...byGroup.entries()].sort(([a], [b]) =>
        a.localeCompare(b, undefined, { sensitivity: "base" }),
      ),
      recents: live.filter((row) => !row.group),
    };
  }, [conversations]);
  const groupNames = groups.map(([name]) => name);
  const rows = (list: ConversationSummary[]) =>
    list.map((conversation) => (
      <ConversationRow
        key={conversation.id}
        conversation={conversation}
        groupNames={groupNames}
        onName={setNaming}
      />
    ));
  const holdsSelection = (list: ConversationSummary[]) =>
    !extensionsOpen && list.some((row) => row.id === selectedId);
  return (
    <>
      {pinned.length > 0 && <p className="live-section-label">Pinned</p>}
      {rows(pinned)}
      {groups.map(([name, list]) => (
        <section key={name} className="live-group" aria-label={`Group ${name}`}>
          <SectionToggle
            label={name}
            count={list.length}
            open={!folded.has(name)}
            icon={<Folder size={14} aria-hidden="true" />}
            current={folded.has(name) && holdsSelection(list)}
            onToggle={() => toggle(name)}
          />
          {!folded.has(name) && (
            <div className="live-group-rows">{rows(list)}</div>
          )}
        </section>
      ))}
      {recents.length > 0 && <p className="live-section-label">Recents</p>}
      {rows(recents)}
      <ArchiveSection
        open={!folded.has(ARCHIVED)}
        onToggle={() => toggle(ARCHIVED)}
        groupNames={groupNames}
        onName={setNaming}
      />
      <NameDialog
        naming={naming}
        groupNames={groupNames}
        onClose={() => setNaming(null)}
      />
    </>
  );
}

function SectionToggle({
  label,
  count,
  open,
  icon,
  current,
  onToggle,
}: {
  label: string;
  count: number;
  open: boolean;
  icon: ReactNode;
  current: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="live-group-toggle"
      aria-expanded={open}
      onClick={onToggle}
    >
      <ChevronRight
        size={13}
        aria-hidden="true"
        className="live-group-chevron"
      />
      {icon}
      <span className="live-nav-label">{label}</span>
      {current && (
        <span
          className="live-group-current"
          aria-label="Contains the open chat"
        />
      )}
      <span className="live-count">{count}</span>
    </button>
  );
}

function ConversationRow({
  conversation,
  groupNames,
  onName,
}: {
  conversation: ConversationSummary;
  groupNames: string[];
  onName: (naming: Naming) => void;
}) {
  const {
    selectedId,
    extensionsOpen,
    rootId,
    selectConversation,
    organiseConversation,
    safely,
  } = useWorkspace();
  const organise = (change: Parameters<typeof organiseConversation>[1]) =>
    safely(organiseConversation(conversation.id, change));
  const others = groupNames.filter((name) => name !== conversation.group);
  const [menuOpen, setMenuOpen] = useState(false);
  const rename = () => onName({ kind: "rename", id: conversation.id, title: conversation.title });
  const togglePin = () => organise({ pinned: !conversation.pinned });
  const toggleArchive = () => organise({ archived: !conversation.archived });
  /** Single-letter shortcuts while the menu is open: R rename, P pin, A archive. */
  const menuHotkeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const run = { r: rename, p: togglePin, a: toggleArchive }[event.key.toLowerCase()];
    if (!run) return;
    event.preventDefault();
    setMenuOpen(false);
    run();
  };
  return (
    <div>
      <div className="live-conversation-row">
        <button
          type="button"
          className="live-nav live-conversation"
          aria-current={
            !extensionsOpen && selectedId === conversation.id
              ? "page"
              : undefined
          }
          onClick={() => selectConversation(conversation.id)}
        >
          <span className="live-nav-label">{conversation.title}</span>
          {conversation.channel && <ChannelMark channel={conversation.channel} label />}
          {conversation.running && (
            <>
              <span className="live-running-dot" aria-hidden="true" />
              <span className="sr-only">Running</span>
            </>
          )}
        </button>
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="live-conversation-menu"
              aria-label={`Options for ${conversation.title}`}
            >
              <Ellipsis size={15} aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            side="bottom"
            className="live-conversation-menu-content"
            onKeyDown={menuHotkeys}
          >
            <DropdownMenuItem onSelect={rename}>
              <Pencil aria-hidden="true" />
              Rename
              <DropdownMenuShortcut>R</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={togglePin}>
              {conversation.pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
              {conversation.pinned ? "Unpin" : "Pin"}
              <DropdownMenuShortcut>P</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Folder aria-hidden="true" />
                {conversation.group ? "Move to group" : "Add to group"}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="live-conversation-menu-content">
                {others.map((name) => (
                  <DropdownMenuItem
                    key={name}
                    onSelect={() => organise({ group: name })}
                  >
                    <Folder aria-hidden="true" />
                    <span className="live-menu-text">{name}</span>
                  </DropdownMenuItem>
                ))}
                {others.length > 0 && <DropdownMenuSeparator />}
                <DropdownMenuItem
                  onSelect={() => onName({ kind: "group", id: conversation.id, title: conversation.title })}
                >
                  <FolderPlus aria-hidden="true" />
                  New group…
                </DropdownMenuItem>
                {conversation.group && (
                  <DropdownMenuItem onSelect={() => organise({ group: "" })}>
                    <FolderMinus aria-hidden="true" />
                    Remove from{" "}
                    {conversation.group.length > 24
                      ? "group"
                      : `“${conversation.group}”`}
                  </DropdownMenuItem>
                )}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={toggleArchive}
            >
              {conversation.archived ? (
                <ArchiveRestore aria-hidden="true" />
              ) : (
                <Archive aria-hidden="true" />
              )}
              {conversation.archived ? "Unarchive" : "Archive"}
              <DropdownMenuShortcut>A</DropdownMenuShortcut>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {conversation.id === rootId && <ChildNavigation />}
      <SideChats
        parentId={conversation.id}
        sideChats={conversation.sideChats}
        onName={onName}
      />
    </div>
  );
}

/** Rename a chat, or name a new group and move the chat into it. */
function NameDialog({
  naming,
  groupNames,
  onClose,
}: {
  naming: Naming;
  groupNames: string[];
  onClose: () => void;
}) {
  const { organiseConversation, safely } = useWorkspace();
  const [value, setValue] = useState("");
  useEffect(() => {
    if (naming)
      setValue(naming.kind === "rename" ? naming.title : "");
  }, [naming]);
  const rename = naming?.kind === "rename";
  const max = rename ? 160 : GROUP_MAX;
  const trimmed = value.trim();
  const existing =
    !rename &&
    groupNames.some((name) => name.toLowerCase() === trimmed.toLowerCase());
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!naming || !trimmed) return;
    const name = existing
      ? groupNames.find(
          (group) => group.toLowerCase() === trimmed.toLowerCase(),
        )!
      : trimmed;
    safely(
      organiseConversation(
        naming.id,
        rename ? { title: trimmed } : { group: name },
      ),
    );
    onClose();
  };
  return (
    <Dialog open={!!naming} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="live-name-dialog sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{rename ? "Rename chat" : "New group"}</DialogTitle>
            <DialogDescription>
              {rename
                ? "Give this chat a name you will recognise in Recents."
                : `Name a group for “${naming?.title ?? ""}”. Other chats can join it from their menu.`}
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            aria-label={rename ? "Chat name" : "Group name"}
            placeholder={rename ? "Chat name" : "For example, Mars host"}
            value={value}
            maxLength={max}
            onChange={(event) => setValue(event.target.value)}
          />
          {existing && (
            <p className="text-sm text-muted-foreground">
              That group already exists. The chat will join it.
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!trimmed}>
              {rename ? "Rename" : existing ? "Move" : "Create group"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Side chats nested under the conversation they were opened from (docs/WORKBENCH.md), while they
 * run or are open. Finished ones move to the one Archived list at the bottom of the sidebar.
 */
function SideChats({
  parentId,
  sideChats,
  onName,
}: {
  parentId: string;
  sideChats: SideChatSummary[];
  onName: (naming: Naming) => void;
}) {
  const { snapshot } = useWorkspace();
  const rows = [...sideChats];
  if (snapshot?.sideChatOf === parentId && !rows.some((row) => row.id === snapshot.conversationId))
    rows.unshift({ id: snapshot.conversationId, title: snapshot.conversationTitle || "Side chat", running: snapshot.running });
  return (
    <NestedList
      label="Side chats"
      rows={rows.map((row) => ({ ...row, side: true, active: row.running }))}
      onName={onName}
    />
  );
}

export type NestedRowData = {
  id: string;
  title: string;
  running?: boolean;
  archived?: boolean;
  status?: string;
  side?: boolean;
  /** Still working: listed under its parent. Finished rows are in the Archived list. */
  active?: boolean;
};

/**
 * Rows nested under a chat (side chats and sub-threads) that are still working, plus the open one.
 * Finished rows archive themselves: they are listed in the sidebar's one Archived list.
 */
export function NestedList({
  label,
  rows,
  onName,
}: {
  label: string;
  rows: NestedRowData[];
  onName?: (naming: Naming) => void;
}) {
  const { selectedId, extensionsOpen } = useWorkspace();
  const live = rows.filter((row) => row.active || (!extensionsOpen && row.id === selectedId));
  if (!live.length) return null;
  return (
    <ul className="live-side-chats" aria-label={label}>
      {live.map((row) => (
        <NestedRow key={row.id} row={row} onName={onName} />
      ))}
    </ul>
  );
}

const ARCHIVE_PAGE = 50;

/**
 * The one Archived list (docs/LIVE-INTEGRATION.md "Archive"): archived chats and finished side
 * chats and sub-threads, newest activity first, from GET /api/conversations/archive. What the
 * last poll knows decides for the rows it lists, so a row that is archived or finishes shows on
 * top at once.
 */
function ArchiveSection({
  open,
  onToggle,
  groupNames,
  onName,
}: {
  open: boolean;
  onToggle: () => void;
  groupNames: string[];
  onName: (naming: Naming) => void;
}) {
  const { conversations, snapshot, selectedId, extensionsOpen, selectConversation } = useWorkspace();
  const openId = extensionsOpen ? "" : selectedId;
  const subthreads = snapshot?.subthreads;
  const known = useMemo(
    () => knownArchive({ conversations, subthreads: subthreads ?? [], openId }),
    [conversations, subthreads, openId],
  );
  const signature = [...known].map(([id, row]) => (row ? id : "")).join(",");
  const [host, setHost] = useState<{ items: ArchiveItem[]; total: number } | null>(null);
  const [limit, setLimit] = useState(ARCHIVE_PAGE);
  const [recent, setRecent] = useState<string[]>([]);
  const previous = useRef<Map<string, ArchiveItem | null> | null>(null);
  useEffect(() => {
    const before = previous.current;
    previous.current = known;
    if (!before) return;
    // Only rows the last poll listed as live: on first load every archived row is new to the page.
    const moved = [...known].filter(([id, row]) => row && before.get(id) === null).map(([id]) => id);
    if (moved.length) setRecent((current) => [...moved, ...current.filter((id) => !moved.includes(id))]);
  }, [known]);
  useEffect(() => {
    let live = true;
    const timer = setTimeout(async () => {
      try {
        const items: ArchiveItem[] = [];
        let total = 0;
        for (let offset = 0; offset < limit; offset += 100) {
          const page = parseArchive(
            await piRequest(`/api/conversations/archive?offset=${offset}&limit=${Math.min(100, limit - offset)}`),
          );
          items.push(...page.items);
          total = Math.max(page.total, items.length);
          if (items.length >= total) break;
        }
        if (!live) return;
        setHost({ items, total });
        // A row stays on top until the host lists it: its list may have been read before the
        // archive was saved.
        setRecent((current) => current.filter((id) => !items.some((row) => row.id === id)));
      } catch {
        /* An older host has no archive list; the rows the page knows still show. */
      }
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [signature, limit]);
  const rows = mergeArchive({ host: host?.items ?? null, known, openId, recent });
  const more = host ? Math.max(0, host.total - host.items.length) : 0;
  const count = rows.length + more;
  if (!count) return null;
  return (
    <section className="live-group live-archived" aria-label="Archived chats">
      <SectionToggle
        label="Archived"
        count={count}
        open={open}
        icon={<Archive size={14} aria-hidden="true" />}
        current={!open && rows.some((row) => row.id === openId)}
        onToggle={onToggle}
      />
      {open && (
        <div className="live-group-rows">
          {rows.map((row) =>
            row.kind === "chat" ? (
              <ConversationRow
                key={row.id}
                conversation={conversations.find((item) => item.id === row.id) ?? archivedSummary(row)}
                groupNames={groupNames}
                onName={onName}
              />
            ) : (
              <div key={row.id} className="live-conversation-row live-archive-row">
                <button
                  type="button"
                  className="live-nav live-conversation"
                  aria-current={row.id === openId ? "page" : undefined}
                  title={row.parentTitle ? `${row.title}, from ${row.parentTitle}` : row.title}
                  onClick={() => selectConversation(row.id)}
                >
                  <MessageSquareDashed size={13} aria-hidden="true" className="live-side-chat-icon" />
                  <span className="live-nav-label">{row.title}</span>
                  {row.parentTitle && <small className="live-archive-parent">{row.parentTitle}</small>}
                </button>
              </div>
            ),
          )}
          {more > 0 && (
            <button
              type="button"
              className="live-nested-archived live-archive-more"
              onClick={() => setLimit((current) => current + ARCHIVE_PAGE)}
            >
              Show {Math.min(more, ARCHIVE_PAGE)} more
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/** A chat the host lists as archived that is older than the sidebar's page of chats. */
const archivedSummary = (row: ArchiveItem): ConversationSummary => ({
  id: row.id,
  title: row.title,
  modelId: "",
  provider: "",
  running: false,
  sideChats: [],
  sideChatTotal: 0,
  group: "",
  archived: true,
  pinned: false,
  channel: "",
});

function NestedRow({ row, onName }: { row: NestedRowData; onName?: (naming: Naming) => void }) {
  const { selectedId, extensionsOpen, selectConversation, organiseConversation, safely } = useWorkspace();
  return (
    <li className="live-conversation-row" data-archived={row.archived ? "" : undefined}>
      <button
        type="button"
        className={`live-nav live-subthread${row.side ? " live-side-chat" : ""}`}
        aria-current={!extensionsOpen && selectedId === row.id ? "page" : undefined}
        onClick={() => selectConversation(row.id)}
      >
        {row.side && <MessageSquareDashed size={13} aria-hidden="true" className="live-side-chat-icon" />}
        <span className="live-nav-label">{row.title}</span>
        {row.status && <small>{row.status}</small>}
        {row.running && (
          <>
            <span className="live-running-dot" aria-hidden="true" />
            <span className="sr-only">Running</span>
          </>
        )}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className="live-conversation-menu" aria-label={`Options for ${row.title}`}>
            <Ellipsis size={15} aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="bottom" className="live-conversation-menu-content">
          {onName && (
            <DropdownMenuItem onSelect={() => onName({ kind: "rename", id: row.id, title: row.title })}>
              <Pencil aria-hidden="true" />
              Rename
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => safely(organiseConversation(row.id, { archived: !row.archived }))}>
            {row.archived ? <ArchiveRestore aria-hidden="true" /> : <Archive aria-hidden="true" />}
            {row.archived ? "Unarchive" : "Archive"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}
