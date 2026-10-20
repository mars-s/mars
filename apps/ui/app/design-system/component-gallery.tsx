"use client";

import { useState, type ReactNode } from "react";
import { FileText, Search, Settings, Sparkles } from "lucide-react";
import AIPrompt from "@/components/vendor/kokonut/ai-prompt";
import AIModelSelector from "@/components/vendor/kokonut/ai-model-selector";
import AIContextMeter from "@/components/vendor/kokonut/ai-context-meter";
import AIToolApproval from "@/components/vendor/kokonut/ai-tool-approval";
import AIDiffReview from "@/components/vendor/kokonut/ai-diff-review";
import AICitations from "@/components/vendor/kokonut/ai-citations";
import AILoadingState from "@/components/vendor/kokonut/ai-loading";
import AITextLoading from "@/components/vendor/kokonut/ai-text-loading";
import AIVoice from "@/components/vendor/kokonut/ai-voice";
import FileUpload from "@/components/vendor/kokonut/file-upload";
import ActionSearchBar from "@/components/vendor/kokonut/action-search-bar";
import { StatusIsland } from "@/components/vendor/kokonut/status-island";
import { EditToolDiffCard } from "@/components/vendor/agent-elements/tools/edit-tool";
import { BashToolTerminalCard } from "@/components/vendor/agent-elements/tools/bash-tool";
import { SearchGroupRich } from "@/components/vendor/agent-elements/tools/search-tool";
import { PlanTool } from "@/components/vendor/agent-elements/tools/plan-tool";
import { TodoTool } from "@/components/vendor/agent-elements/tools/todo-tool";
import { SubagentTool } from "@/components/vendor/agent-elements/tools/subagent-tool";
import { McpTool } from "@/components/vendor/agent-elements/tools/mcp-tool";
import { ThinkingCollapsed } from "@/components/vendor/agent-elements/tools/thinking-tool";
import { GenericToolRow } from "@/components/vendor/agent-elements/tools/generic-tool";
import { QuestionPrompt } from "@/components/vendor/agent-elements/question/question-prompt";
import { BackgroundInbox } from "@/components/vendor/assistant-ui/elements/background-inbox";
import { ArtifactCard } from "@/components/vendor/assistant-ui/elements/artifact-card";
import { CheckpointHistory } from "@/components/vendor/assistant-ui/elements/checkpoint-history";
import { ScheduleCard } from "@/components/vendor/assistant-ui/elements/schedule-card";
import { ConnectionState } from "@/components/vendor/assistant-ui/elements/connection-state";
import { ContextBreakdown } from "@/components/vendor/assistant-ui/elements/context-breakdown";
import { MemoryChips } from "@/components/vendor/assistant-ui/elements/memory-chips";
import { ElicitationForm } from "@/components/vendor/assistant-ui/elements/elicitation-form";
import { CostMeter } from "@/components/vendor/assistant-ui/elements/cost-meter";
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
} from "@/components/vendor/ai-elements/chain-of-thought";
import { Source, Sources, SourcesContent, SourcesTrigger } from "@/components/vendor/ai-elements/sources";
import { Task, TaskContent, TaskItem, TaskItemFile, TaskTrigger } from "@/components/vendor/ai-elements/task";
import "@/components/vendor/agent-elements/agent-ui.css";
import { DiffHighlighterReady } from "@/components/ai/diff-highlighter";

type Library = "Kokonut UI" | "21st Agent Elements" | "assistant-ui" | "shadcn AI Elements";

function Specimen({
  name,
  library,
  use,
  wide,
  children,
}: {
  name: string;
  library: Library;
  use: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <article className={`ds-specimen ${wide ? "ds-specimen-wide" : ""}`}>
      <header>
        <div>
          <h3>{name}</h3>
          <p>{use}</p>
        </div>
        <span className="ds-library" data-library={library}>
          {library}
        </span>
      </header>
      <div className="ds-specimen-stage">{children}</div>
    </article>
  );
}

const noop = () => undefined;
const toolStep = (fields: Record<string, unknown>) =>
  ({ id: String(fields.toolName), type: "tool-call", duration: 0, toolDetail: "", ...fields }) as never;

export function ComponentGallery() {
  const [answer, setAnswer] = useState("");
  const [fields, setFields] = useState([
    { name: "repo", label: "Repository", value: "mars-s/mars", kind: "text" as const, required: true },
    { name: "branch", label: "Base branch", value: "main", kind: "choice" as const, options: ["main", "develop"] },
    { name: "draft", label: "Open as draft", value: "true", kind: "toggle" as const },
  ]);
  return (
    <div className="ds-gallery">
      <h3 className="ds-gallery-group">Composer and model</h3>
      <div className="ds-specimens">
        <Specimen name="AI Prompt" library="Kokonut UI" use="Main composer direction: text, attachments, commands, model" wide>
          <AIPrompt
            models={[
              { name: "GPT-6 Sol", description: "Everyday work", efforts: ["Low", "Medium", "High"], defaultEffort: "Medium" },
              { name: "Claude Opus 5.5", description: "Hard reasoning", efforts: ["Medium", "High"] },
            ]}
            placeholder="How can I help you today?"
            headerText=""
            commands={[
              { id: "plan", label: "Plan", description: "Outline before acting", icon: <Sparkles size={14} /> },
              { id: "search", label: "Search", description: "Look things up", icon: <Search size={14} /> },
            ]}
            onSubmit={noop}
          />
        </Specimen>
        <Specimen name="Model selector" library="Kokonut UI" use="Model plus effort, from the server catalogue">
          <AIModelSelector
            models={[
              { id: "sol", name: "GPT-6 Sol", description: "Fast, everyday", efforts: [{ id: "low", label: "Low" }, { id: "medium", label: "Medium" }, { id: "high", label: "High" }], defaultEffort: "medium" },
              { id: "opus", name: "Claude Opus 5.5", description: "Deep reasoning", efforts: [{ id: "high", label: "High" }] },
            ]}
            defaultValue={{ model: "sol", effort: "medium" }}
          />
        </Specimen>
        <Specimen name="Context meter" library="Kokonut UI" use="Composer footer ring with breakdown and compaction">
          <AIContextMeter
            model="GPT-6 Sol"
            limit={200000}
            segments={[
              { id: "system", label: "Instructions", tokens: 6200 },
              { id: "tools", label: "Tools", tokens: 11800 },
              { id: "files", label: "Files", tokens: 38400 },
              { id: "messages", label: "Messages", tokens: 52100 },
            ]}
            onCompact={noop}
          />
        </Specimen>
        <Specimen name="Voice" library="Kokonut UI" use="Dictation appearance (real capture comes later)">
          <AIVoice />
        </Specimen>
        <Specimen name="File upload" library="Kokonut UI" use="Attachment queue with progress and errors">
          <FileUpload acceptedFileTypes={["image/png", "image/jpeg"]} maxFileSize={10 * 1024 * 1024} uploadDelay={600} />
        </Specimen>
      </div>

      <h3 className="ds-gallery-group">Agent activity in the conversation</h3>
      <div className="ds-specimens">
        <Specimen name="Edit tool" library="21st Agent Elements" use="Inline record of a file edit with expandable diff" wide>
          <DiffHighlighterReady>
          <EditToolDiffCard
            state="complete"
            onComplete={noop}
            input={{
              old_string: "const marker = lockMarker(stage);\nif (existsSync(checkoutLock)) return;\n",
              new_string: 'const marker = lockMarker(stage);\nif (!existsSync(marker)) {\n  await installWorkspace({ filter: "@mars/pi-host" });\n}\n',
            }}
            step={toolStep({
              toolName: "Edit",
              filePath: "scripts/deploy-host.mjs",
              diffStats: "+3 -1",
              diffLines: [
                { type: "context", content: "const marker = lockMarker(stage);" },
                { type: "remove", content: "if (existsSync(checkoutLock)) return;" },
                { type: "add", content: "if (!existsSync(marker)) {" },
                { type: "add", content: '  await installWorkspace({ filter: "@mars/pi-host" });' },
                { type: "add", content: "}" },
              ],
            })}
          />
          </DiffHighlighterReady>
        </Specimen>
        <Specimen name="Bash tool" library="21st Agent Elements" use="Compact command and output, exit status" wide>
          <BashToolTerminalCard
            state="complete"
            onComplete={noop}
            step={toolStep({
              toolName: "Bash",
              bashCommand: "npm run test:install",
              bashOutput: "ok 1 - bootstrap\nok 2 - service units\nnot ok 3 - missing workspace lock marker",
              bashSuccess: false,
            })}
          />
        </Specimen>
        <Specimen name="Search group" library="21st Agent Elements" use="Web and code search results">
          <SearchGroupRich
            defaultOpen
            toolSteps={[toolStep({ toolName: "WebSearch", toolVariant: "search", searchQuery: "Next.js self-hosting streaming", searchSource: "web" })]}
            stepStates={{ WebSearch: "complete" }}
            onStepComplete={noop}
            results={[
              { source: "web", title: "Self-hosting a Next.js application", date: "2026" },
              { source: "github", title: "earendil-works/pi durable README", date: "2026" },
            ]}
          />
        </Specimen>
        <Specimen name="Thinking" library="21st Agent Elements" use="Provider reasoning summary, collapsed">
          <ThinkingCollapsed
            state="complete"
            onComplete={noop}
            defaultOpen
            step={toolStep({ toolName: "Thinking", toolVariant: "thinking", thoughtContent: "The deploy step trusts the checkout lock. A fresh clone has none installed, so check the installed marker instead." })}
          />
        </Specimen>
        <Specimen name="Generic tool" library="21st Agent Elements" use="Fallback for any unknown tool">
          <GenericToolRow state="complete" onComplete={noop} step={toolStep({ toolName: "discovery_reset", toolDetail: "conversation 12" })} />
        </Specimen>
        <Specimen name="Plan" library="21st Agent Elements" use="A versioned plan to approve">
          <PlanTool
            part={{
              type: "tool-ExitPlanMode",
              state: "input-available",
              input: {
                plan: { id: "deploy-fix", title: "Fix fresh-clone deploys", summary: "1. Check the installed marker\n2. Run the filtered install\n3. Rerun the install test" },
                approveLabel: "Approve plan",
                onApprove: noop,
              },
            }}
          />
        </Specimen>
        <Specimen name="To-dos" library="21st Agent Elements" use="Task list with live progress">
          <TodoTool
            part={{
              type: "tool-TodoWrite",
              state: "output-available",
              input: {
                todos: [
                  { content: "Reproduce the failure", status: "completed" },
                  { content: "Patch the lock check", status: "in_progress", activeForm: "Patching the lock check" },
                  { content: "Rerun install tests", status: "pending" },
                ],
              },
            }}
          />
        </Specimen>
        <Specimen name="Subagent" library="21st Agent Elements" use="Delegated child run with its own activity">
          <SubagentTool
            part={{
              type: "tool-Agent",
              state: "output-available",
              input: { description: "Audit the systemd unit generator", subagent_type: "general-purpose" },
              output: { totalDurationMs: 48000 },
            }}
            nestedTools={[
              { type: "tool-Read", state: "output-available", input: { file_path: "scripts/install-service.mjs" } },
              { type: "tool-Bash", state: "output-available", input: { command: "node --test scripts/test-install.mjs" } },
            ]}
          />
        </Specimen>
        <Specimen name="MCP call" library="21st Agent Elements" use="Connector call with structured output">
          <McpTool
            defaultOpen
            mcpInfo={{ serverName: "github", toolName: "list_pull_requests", displayName: "List pull requests", category: "list" }}
            part={{ type: "tool-mcp__github__list_pull_requests", state: "output-available", input: { repo: "mars-s/mars", state: "open" }, output: '[{"number": 18, "title": "Claude-style redesign"}]' }}
          />
        </Specimen>
        <Specimen name="Question" library="21st Agent Elements" use="Clarifying choice from the agent">
          <QuestionPrompt
            questions={[
              {
                kind: "single",
                title: "Where should the fix land?",
                options: [
                  { id: "pr", label: "Open a pull request", description: "Review before merging" },
                  { id: "main", label: "Commit to main", description: "Ship straight away" },
                ],
                allowCustom: true,
              },
            ]}
            onSubmit={(value) => setAnswer(JSON.stringify(value))}
          />
          {answer && <p className="ds-hint">Answer (local only): {answer}</p>}
        </Specimen>
      </div>

      <h3 className="ds-gallery-group">Decisions, review and sources</h3>
      <div className="ds-specimens">
        <Specimen name="Tool approval" library="Kokonut UI" use="Permission gate with exact command and reason" wide>
          <AIToolApproval
            calls={[
              { id: "a1", tool: "shell", title: "Run deploy", input: { command: "npm run host:deploy", cwd: "~/mars" }, reason: "Stage the fixed host build", state: "approval-requested" },
              { id: "a2", tool: "fs", title: "Delete cache", input: { path: ".next-build" }, destructive: true, state: "output-denied" },
            ]}
            onRespond={noop}
          />
        </Specimen>
        <Specimen name="Diff review" library="Kokonut UI" use="Changes workbench for a full change set" wide>
          <AIDiffReview
            files={[
              {
                path: "scripts/deploy-host.mjs",
                hunks: [{ start: 41, lines: [
                  { type: "context", text: "const marker = lockMarker(stage);" },
                  { type: "remove", text: "if (existsSync(checkoutLock)) return;" },
                  { type: "add", text: "if (!existsSync(marker)) await installWorkspace();" },
                ] }],
              },
              { path: "scripts/test-install.mjs", created: true, hunks: [{ start: 1, lines: [{ type: "add", text: 'test("fresh clone installs", async () => {});' }] }] },
            ]}
          />
        </Specimen>
        <Specimen name="Inline citations" library="Kokonut UI" use="Numbered source chips with preview" wide>
          <AICitations
            parts={[
              { text: "Next.js streams when self-hosted, but a reverse proxy must not buffer responses", cite: ["n1"] },
              { text: ". Tailscale Serve can pass identity headers to a localhost service", cite: ["t1"] },
              { text: "." },
            ]}
            sources={[
              { id: "n1", title: "Self-hosting Next.js", url: "https://nextjs.org/docs/app/guides/self-hosting", site: "nextjs.org" },
              { id: "t1", title: "Tailscale Serve", url: "https://tailscale.com/docs/features/tailscale-serve", site: "tailscale.com" },
            ]}
          />
        </Specimen>
        <Specimen name="Sources" library="shadcn AI Elements" use="Collapsible source list under an answer">
          <Sources>
            <SourcesTrigger count={2} />
            <SourcesContent>
              <Source href="https://nextjs.org/docs/app/guides/self-hosting" title="Self-hosting Next.js" />
              <Source href="https://tailscale.com/docs/features/tailscale-serve" title="Tailscale Serve" />
            </SourcesContent>
          </Sources>
        </Specimen>
        <Specimen name="Elicitation form" library="assistant-ui" use="Multi-field question that outgrows a choice prompt">
          <ElicitationForm
            server="github"
            message="Where should I open the pull request?"
            fields={fields}
            state="request"
            onFieldChange={(name, value) => setFields((rows) => rows.map((row) => (row.name === name ? { ...row, value } : row)))}
            onAccept={noop}
            onDecline={noop}
          />
        </Specimen>
      </div>

      <h3 className="ds-gallery-group">Runs, progress and background work</h3>
      <div className="ds-specimens">
        <Specimen name="Run progress" library="Kokonut UI" use="Current-run steps with live log">
          <AILoadingState
            collapseWhenDone={false}
            steps={[
              { id: "1", label: "Read deploy script", status: "done" },
              { id: "2", label: "Patch the lock check", status: "running", detail: ["editing scripts/deploy-host.mjs"] },
              { id: "3", label: "Rerun install tests", status: "pending" },
            ]}
          />
        </Specimen>
        <Specimen name="Text loading" library="Kokonut UI" use="Small active label while a run streams">
          <AITextLoading texts={["Thinking", "Reading files", "Running tests"]} />
        </Specimen>
        <Specimen name="Chain of thought" library="shadcn AI Elements" use="Reasoning steps when a provider exposes them">
          <ChainOfThought defaultOpen>
            <ChainOfThoughtHeader>Reasoning summary</ChainOfThoughtHeader>
            <ChainOfThoughtContent>
              <ChainOfThoughtStep label="Checked the deploy script" status="complete" />
              <ChainOfThoughtStep label="Found the stale lock check" status="complete" />
              <ChainOfThoughtStep label="Writing the fix" status="active" />
            </ChainOfThoughtContent>
          </ChainOfThought>
        </Specimen>
        <Specimen name="Task" library="shadcn AI Elements" use="A collapsible task with touched files">
          <Task defaultOpen>
            <TaskTrigger title="Fix fresh-clone deploys" />
            <TaskContent>
              <TaskItem>Read <TaskItemFile><FileText size={12} /> deploy-host.mjs</TaskItemFile></TaskItem>
              <TaskItem>Patched the lock marker check</TaskItem>
            </TaskContent>
          </Task>
        </Specimen>
        <Specimen name="Background inbox" library="assistant-ui" use="Work running elsewhere, ready to collect">
          <BackgroundInbox
            runs={[
              { id: "r1", title: "Audit service units", state: "running", elapsed: "48s" },
              { id: "r2", title: "Weekly reading list", state: "ready", elapsed: "3m", summary: "12 links, 3 worth reading" },
              { id: "r3", title: "Discord fixture", state: "failed", elapsed: "1m" },
            ]}
            onCollect={noop}
          />
        </Specimen>
        <Specimen name="Status island" library="Kokonut UI" use="Transient background-run notice">
          <div className="ds-island-stage">
            <StatusIsland
              tasks={[
                { id: "s1", label: "Audit service units", detail: "Subagent", status: "running", progress: 0.6 },
                { id: "s2", label: "Install tests", detail: "Passed", status: "done" },
              ]}
              className="ds-island"
            />
          </div>
        </Specimen>
        <Specimen name="Connection state" library="assistant-ui" use="Reconnect banner without cancelling the run">
          <ConnectionState phase="dropped" onRetry={noop} />
          <ConnectionState phase="reconnecting" attempt={2} />
        </Specimen>
        <Specimen name="Schedule card" library="assistant-ui" use="Routine summary with recent runs">
          <ScheduleCard
            name="Check the Mars repo"
            cadence="Weekdays at 9:00 AEDT"
            nextRun="Tomorrow 9:00"
            enabled
            history={[
              { id: "h1", at: "Mon", ok: true },
              { id: "h2", at: "Tue", ok: true },
              { id: "h3", at: "Wed", ok: false },
            ]}
          />
        </Specimen>
      </div>

      <h3 className="ds-gallery-group">Context, memory, artifacts and cost</h3>
      <div className="ds-specimens">
        <Specimen name="Context breakdown" library="assistant-ui" use="Expanded context inspector">
          <ContextBreakdown
            limit={200000}
            segments={[
              { label: "Instructions", tokens: 6200, tint: "bg-clay" },
              { label: "Files", tokens: 38400, tint: "bg-info" },
              { label: "Messages", tokens: 52100, tint: "bg-success" },
            ]}
          />
        </Specimen>
        <Specimen name="Memory chips" library="assistant-ui" use="What the agent remembered this turn">
          <MemoryChips
            chips={[
              { id: "m1", text: "Prefers Australian English", change: "existing" },
              { id: "m2", text: "Uses Helium for browser work", change: "added" },
              { id: "m3", text: "Pi host runs on Bot Box", change: "updated" },
            ]}
            onForget={noop}
          />
        </Specimen>
        <Specimen name="Artifact card" library="assistant-ui" use="A saved output to reopen">
          <ArtifactCard title="Deploy fix report" meta="Document · 2 min ago" />
          <ArtifactCard title="Routine schedule" meta="Generating" generating words={182} />
        </Specimen>
        <Specimen name="Checkpoints" library="assistant-ui" use="Conversation and workspace restore points">
          <CheckpointHistory
            currentId="c2"
            checkpoints={[
              { id: "c1", label: "Before deploy fix", at: "10:02", files: 0 },
              { id: "c2", label: "Patched lock check", at: "10:09", files: 2 },
              { id: "c3", label: "Added install test", at: "10:14", files: 3 },
            ]}
            onRestore={noop}
          />
        </Specimen>
        <Specimen name="Cost meter" library="assistant-ui" use="Spend, only where the provider reports it">
          <CostMeter
            runCost="$0.18"
            sessionCost="$1.42"
            lines={[
              { model: "GPT-6 Sol", inputTokens: 84000, outputTokens: 6100, cost: "$0.12", share: 0.66 },
              { model: "Claude Opus 5.5", inputTokens: 12000, outputTokens: 1900, cost: "$0.06", share: 0.34 },
            ]}
          />
        </Specimen>
        <Specimen name="Command search" library="Kokonut UI" use="Command palette (Cmd K)" wide>
          <ActionSearchBar
            shortcut={false}
            label="Search Mars"
            items={[
              { id: "new", label: "New chat", group: "Actions", shortcut: ["⌘", "N"] },
              { id: "settings", label: "Open settings", group: "Actions", icon: <Settings size={14} /> },
              { id: "c1", label: "Tidy the Pi host deploy script", group: "Recents" },
            ]}
          />
        </Specimen>
      </div>
    </div>
  );
}
