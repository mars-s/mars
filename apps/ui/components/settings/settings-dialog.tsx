"use client";

import { ArrowDownToLine, CalendarClock, Check, Cpu, GitMerge, LayoutGrid, MessagesSquare, Palette, Plug, Server, UserRound, type LucideIcon } from "lucide-react";
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConnectionSettings } from "@/components/settings/connection-settings";
import { ConnectorSettings } from "@/components/settings/connector-settings";
import { ModelSettingsPanel } from "@/components/settings/model-settings";
import { HostVersionDetails, useHostVersion } from "@/components/settings/host-version";
import { GatewaySettings } from "@/components/settings/gateway-settings";
import { ThemeSettings } from "@/components/settings/theme-settings";
import { ScheduleSettings } from "@/components/settings/schedule-settings";
import { LaneSettings } from "@/components/settings/lane-settings";
import { UpdateSettings } from "@/components/settings/update-settings";
import { useWorkspace } from "@/components/workspace-context";
import type { LoginState } from "@/lib/pi/live-state";
import "./settings.css";

const sections: { id: string; label: string; icon: LucideIcon; summary: string }[] = [
  { id: "account", label: "Account", icon: UserRound, summary: "Model accounts Pi signs in to on the host." },
  { id: "models", label: "Models", icon: Cpu, summary: "Which models new chats and background work use." },
  { id: "appearance", label: "Appearance", icon: Palette, summary: "How Mars looks on this device." },
  { id: "connection", label: "Connection", icon: Server, summary: "The Pi host this workspace talks to." },
  { id: "apps", label: "Apps", icon: LayoutGrid, summary: "Private connections Pi can use." },
  { id: "connectors", label: "Connectors", icon: Plug, summary: "Outside services the agent can use: MCP servers and HTTP APIs." },
  { id: "gateway", label: "Gateway", icon: MessagesSquare, summary: "Chat with Mars from Telegram, Discord and scripts." },
  { id: "schedules", label: "Schedules", icon: CalendarClock, summary: "Prompts Mars runs at set times." },
  { id: "lanes", label: "Lanes", icon: GitMerge, summary: "Chats changing Mars in parallel, and the order their work merges in." },
  { id: "updates", label: "Updates", icon: ArrowDownToLine, summary: "New versions of Mars from GitHub main." },
];

type Provider = {
  name: "ChatGPT" | "Claude";
  /** Extra body for /api/login and /api/login-answer; ChatGPT is the host default. */
  body: { provider?: "anthropic" };
  idle: string;
  waiting: string;
  answer: { id: string; label: string; help: string; type: "text" | "password"; submit: string };
  connectedNote?: string;
};

const providers: Provider[] = [
  {
    name: "ChatGPT",
    body: {},
    idle: "Connect your account to chat with Pi.",
    waiting: "Waiting for sign-in",
    answer: {
      id: "chatgpt-callback",
      label: "Final callback URL",
      help: "If sign-in ends at a localhost address on your Mac, paste that full address here. It goes directly to Pi and is not saved in this browser.",
      type: "text",
      submit: "Complete sign-in",
    },
  },
  {
    name: "Claude",
    body: { provider: "anthropic" },
    idle: "Connect your Claude account through Pi to use Anthropic models.",
    waiting: "Waiting for Claude sign-in",
    answer: {
      id: "claude-code",
      label: "Claude authorisation code",
      help: "After signing in, paste the code Claude gives you here. Pi stores the account credentials on the host.",
      type: "password",
      submit: "Complete Claude sign-in",
    },
    connectedNote: "Choose Claude Opus 5.5 from the conversation model menu to work on the UI.",
  },
];

const narrowQuery = "(max-width: 640px)";
function subscribeNarrow(change: () => void) {
  const media = matchMedia(narrowQuery);
  media.addEventListener("change", change);
  return () => media.removeEventListener("change", change);
}

function ProviderAccount({ provider, auth }: { provider: Provider; auth: LoginState | undefined }) {
  const { pending, action, safely } = useWorkspace();
  const [answer, setAnswer] = useState("");
  const waiting = auth?.state === "pending";
  return (
    <section className="live-settings-account" aria-label={`${provider.name} account`}>
      <div className="live-settings-row">
        <div>
          <h3>{provider.name}</h3>
          <p className="live-account-state">
            {auth?.connected ? (
              <>
                <Check size={14} aria-hidden="true" />
                Connected
              </>
            ) : waiting ? (
              provider.waiting
            ) : (
              provider.idle
            )}
          </p>
        </div>
        <Button
          variant={auth?.connected ? "outline" : "default"}
          disabled={pending || !auth || waiting}
          onClick={() => safely(action("/api/login", provider.body))}
        >
          {auth?.connected ? `Reconnect ${provider.name}` : `Sign in with ${provider.name}`}
        </Button>
      </div>
      {auth?.error && (
        <p className="live-settings-error" role="alert">
          {auth.error}
        </p>
      )}
      {auth?.url && waiting && (
        <div className="live-auth-flow">
          <a href={auth.url} target="_blank" rel="noopener noreferrer">
            Continue to {provider.name} sign-in
          </a>
          {auth.code && (
            <p>
              Pairing code: <code>{auth.code}</code>
            </p>
          )}
        </div>
      )}
      {auth?.prompt && (
        <form
          className="live-callback"
          onSubmit={(event) => {
            event.preventDefault();
            const value = answer;
            setAnswer("");
            safely(action("/api/login-answer", { ...provider.body, answer: value }));
          }}
        >
          <label htmlFor={provider.answer.id}>{provider.answer.label}</label>
          <p id={`${provider.answer.id}-help`}>{provider.answer.help}</p>
          <Input
            id={provider.answer.id}
            type={provider.answer.type}
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder={auth.prompt}
            aria-describedby={`${provider.answer.id}-help`}
            required
          />
          <Button type="submit" disabled={pending || !answer.trim()}>
            {provider.answer.submit}
          </Button>
        </form>
      )}
      {auth?.connected && provider.connectedNote && (
        <p className="live-account-note">{provider.connectedNote}</p>
      )}
    </section>
  );
}

function Section({ id, children }: { id: string; children: ReactNode }) {
  const section = sections.find((item) => item.id === id)!;
  return (
    <TabsContent value={id} className="live-settings-section">
      <header>
        <h2>{section.label}</h2>
        <p>{section.summary}</p>
      </header>
      {children}
    </TabsContent>
  );
}

export function SettingsDialog() {
  const { snapshot, connectionError, settingsOpen, setSettingsOpen, settingsTab, setSettingsTab, selectConversation } =
    useWorkspace();
  const narrow = useSyncExternalStore(subscribeNarrow, () => matchMedia(narrowQuery).matches, () => false);
  const hostVersion = useHostVersion();
  return (
    <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
      <DialogContent className="live-settings">
        <Tabs
          value={settingsTab}
          onValueChange={setSettingsTab}
          orientation={narrow ? "horizontal" : "vertical"}
          className="live-settings-layout"
        >
          <div className="live-settings-nav">
            <DialogTitle>Settings</DialogTitle>
            <DialogDescription className="sr-only">
              Your account and workspace preferences.
            </DialogDescription>
            <TabsList aria-label="Settings sections">
              {sections.map(({ id, label, icon: Icon }) => (
                <TabsTrigger key={id} value={id}>
                  <Icon aria-hidden="true" />
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          <div className="live-settings-panel">
            <Section id="account">
              {providers.map((provider) => (
                <ProviderAccount
                  key={provider.name}
                  provider={provider}
                  auth={provider.name === "Claude" ? snapshot?.anthropicAuth : snapshot?.auth}
                />
              ))}
            </Section>
            <Section id="models">
              <ModelSettingsPanel />
            </Section>
            <Section id="appearance">
              <ThemeSettings />
            </Section>
            <Section id="connection">
              <dl className="live-connection-details">
                <div>
                  <dt>Runtime</dt>
                  <dd>{snapshot?.runtime || "Connecting…"}</dd>
                </div>
                <div>
                  <dt>Conversation</dt>
                  <dd>{snapshot?.conversationId || "Unavailable"}</dd>
                </div>
                <div>
                  <dt>Connection</dt>
                  <dd>{connectionError ? "Disconnected" : snapshot ? "Connected" : "Connecting"}</dd>
                </div>
              </dl>
              <HostVersionDetails version={hostVersion} />
              <p className="live-settings-footnote">
                Closing this page leaves durable work running. Stop a response explicitly in the
                conversation.
              </p>
            </Section>
            <Section id="apps">
              <ConnectionSettings />
            </Section>
            <Section id="connectors">
              <ConnectorSettings />
            </Section>
            <Section id="gateway">
              <GatewaySettings
                onOpenConversation={(id) => {
                  setSettingsOpen(false);
                  selectConversation(id);
                }}
              />
            </Section>
            <Section id="schedules">
              <ScheduleSettings
                onOpenConversation={(id) => {
                  setSettingsOpen(false);
                  selectConversation(id);
                }}
              />
            </Section>
            <Section id="lanes">
              <LaneSettings
                onOpenConversation={(id) => {
                  setSettingsOpen(false);
                  selectConversation(id);
                }}
              />
            </Section>
            <Section id="updates">
              <UpdateSettings />
            </Section>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
