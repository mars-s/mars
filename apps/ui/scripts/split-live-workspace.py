"""One-off lever: split components/live-workspace.tsx into lane-owned modules.

Line ranges come from the pre-split file at commit f82d5d0. The script refuses
to run if the anchors moved, so a rerun on a changed file fails loudly.
"""
import re
from pathlib import Path

root = Path(__file__).resolve().parent.parent
source = (root / "components/live-workspace.tsx").read_text().split("\n")


def lines(start, end):
    return "\n".join(source[start - 1 : end])


anchors = {
    81: "function convertMessage",
    153: "function ExtensionPanel",
    192: "function ConversationRuntime",
    231: "export function LiveWorkspace",
    488: '<aside className="live-sidebar"',
    568: '<main className="live-main">',
    600: "{connectionError && (",
    616: "{extensionsOpen ? (",
    633: ") : (",
    686: "<ThreadPrimitive.ViewportFooter",
    787: "</ThreadPrimitive.ViewportFooter>",
    793: "<Dialog open={sidebarOpen}",
    854: "<Dialog open={settingsOpen}",
    1036: "</Dialog>",
}
for number, text in anchors.items():
    assert text in source[number - 1], (number, source[number - 1])

IMPORTS = """\
import {
  ActionBarPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import {
  ArrowUp,
  Check,
  ChevronDown,
  Clipboard,
  Menu,
  MessageSquare,
  PanelLeft,
  Plus,
  Settings,
  Square,
  Wrench,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import remarkGfm from "remark-gfm";
import { record, type LiveMessage, type LiveSnapshot } from "@/lib/pi/live-state";
import { MarsMark } from "@/components/mars-mark";
import StatusMark from "@/components/react-bits/StatusMark";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConnectionSettings } from "@/components/settings/connection-settings";
import { ThemeSettings } from "@/components/settings/theme-settings";
import { PluginManager } from "@/components/settings/plugin-manager";
import { LiveImageAttachment } from "@/components/composer/live-image-attachment";
import { ActivityTimeline, AgentActivity } from "@/components/activity/activity-timeline";
import { LiveWorkers } from "@/components/activity/live-workers";
import { useWorkspace } from "@/components/workspace-context";
"""

CONTEXT_NAMES = [
    "snapshot", "conversations", "selectedId", "pending", "connectionError", "actionError",
    "setActionError", "canChat", "connected", "hasMessages", "rootId", "extensionsOpen",
    "setExtensionsOpen", "sidebarOpen", "setSidebarOpen", "settingsOpen", "setSettingsOpen",
    "settingsTab", "setSettingsTab", "refresh", "action", "safely", "newConversation",
    "selectConversation", "openSettings",
]


def prune(header, body):
    """Drop imported names the body never mentions; drop empty import statements."""
    out = []
    for statement in re.findall(r"import[^;]*;", header, re.S):
        names = re.search(r"\{([^}]*)\}", statement)
        default = re.match(r"import\s+(\w+)\s+from", statement)
        if names:
            kept = [n.strip() for n in names.group(1).split(",") if n.strip()]
            kept = [n for n in kept if re.search(r"\b" + n.replace("type ", "").strip() + r"\b", body)]
            if kept:
                out.append(re.sub(r"\{[^}]*\}", "{ " + ", ".join(kept) + " }", statement))
        elif default and re.search(r"\b" + default.group(1) + r"\b", body):
            out.append(statement)
    return "\n".join(out)


def context_line(body):
    used = [n for n in CONTEXT_NAMES if re.search(r"\b" + n + r"\b", body)]
    return f"  const {{ {', '.join(used)} }} = useWorkspace();\n" if used else ""


def component(path, name, jsx, extra_top="", extra_locals="", css=None):
    body = jsx + extra_top + extra_locals
    header = prune(IMPORTS, body + "useWorkspace" if context_line(jsx + extra_locals) else body)
    css_line = f'import "./{css}";\n' if css else ""
    text = (
        '"use client";\n\n' + header + "\n" + css_line + "\n" + extra_top
        + f"export function {name}() {{\n" + context_line(jsx + extra_locals) + extra_locals
        + "  return (\n" + jsx + "\n  );\n}\n"
    )
    (root / path).write_text(text)


messages_body = lines(81, 152)
(root / "components/thread/messages.tsx").write_text(
    '"use client";\n\n' + prune(IMPORTS, messages_body) + '\nimport "./thread.css";\n\n'
    + messages_body.replace("function convertMessage", "export function convertMessage")
    .replace("function UserMessage", "export function UserMessage")
    .replace("function AssistantMessage", "export function AssistantMessage") + "\n"
)

component("components/shell/sidebar.tsx", "Sidebar", lines(488, 567),
          extra_locals="  const childNavigation = useChildNavigation();\n", css="shell.css")
component("components/shell/mobile-nav.tsx", "MobileNav", lines(793, 853),
          extra_locals="  const childNavigation = useChildNavigation();\n")
component("components/shell/header.tsx", "WorkspaceHeader", lines(569, 615).replace("\n            ", "\n"))

extension_panel = lines(153, 191)
component("components/settings/extensions-page.tsx", "ExtensionsPage", lines(617, 632),
          extra_top=extension_panel + "\n", css="settings.css")
component("components/settings/settings-dialog.tsx", "SettingsDialog", lines(854, 1036),
          extra_locals='  const [callback, setCallback] = useState("");\n  const [claudeCode, setClaudeCode] = useState("");\n')
component("components/composer/composer.tsx", "Composer", lines(687, 786), css="composer.css")

thread = lines(634, 685) + "\n                    <Composer />\n" + lines(787, 789)
component("components/thread/conversation-view.tsx", "ConversationView", thread)
view = (root / "components/thread/conversation-view.tsx").read_text()
view = view.replace('import { useWorkspace }', 'import { Composer } from "@/components/composer/composer";\nimport { UserMessage, AssistantMessage } from "./messages";\nimport { useWorkspace }')
(root / "components/thread/conversation-view.tsx").write_text(view)

controller = (
    "\n".join(source[:80]) + "\n" + lines(192, 475) + "\n  return (\n"
    + lines(477, 487) + "\n          <Sidebar />\n" + lines(568, 568)
    + "\n            <WorkspaceHeader />\n            {extensionsOpen ? <ExtensionsPage /> : <ConversationView />}\n"
    + lines(791, 792) + "\n        <MobileNav />\n        <SettingsDialog />\n" + lines(1037, 1040) + "\n"
)
(root / "components/live-workspace.tsx").write_text(controller)
print("split complete")
