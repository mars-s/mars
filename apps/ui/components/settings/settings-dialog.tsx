"use client";

import { Check, Settings } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConnectionSettings } from "@/components/settings/connection-settings";
import { ThemeSettings } from "@/components/settings/theme-settings";
import { useWorkspace } from "@/components/workspace-context";

export function SettingsDialog() {
  const { snapshot, pending, connectionError, connected, settingsOpen, setSettingsOpen, settingsTab, setSettingsTab, action, safely } = useWorkspace();
  const [callback, setCallback] = useState("");
  const [claudeCode, setClaudeCode] = useState("");
  return (
        <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
          <DialogContent className="live-settings">
            <DialogHeader>
              <DialogTitle>Settings</DialogTitle>
              <DialogDescription>Your account and workspace preferences.</DialogDescription>
            </DialogHeader>
            <Tabs value={settingsTab} onValueChange={setSettingsTab}>
              <TabsList>
                <TabsTrigger value="account">Account</TabsTrigger>
                <TabsTrigger value="appearance">Appearance</TabsTrigger>
                <TabsTrigger value="connection">Connection</TabsTrigger>
                <TabsTrigger value="apps">Apps</TabsTrigger>
              </TabsList>
              <TabsContent value="account">
                <h2>ChatGPT</h2>
                <p className="live-account-state">
                  {connected ? (
                    <>
                      <Check size={15} />
                      Connected
                    </>
                  ) : snapshot?.auth.state === "pending" ? (
                    "Waiting for sign-in"
                  ) : (
                    "Connect your account to chat with Pi."
                  )}
                </p>
                {snapshot?.auth.error && <p role="alert">{snapshot.auth.error}</p>}
                <Button
                  disabled={pending || snapshot?.auth.state === "pending"}
                  onClick={() => safely(action("/api/login"))}
                >
                  {connected ? "Reconnect ChatGPT" : "Sign in with ChatGPT"}
                </Button>
                {snapshot?.auth.url && snapshot.auth.state === "pending" && (
                  <div className="live-auth-flow">
                    <a href={snapshot.auth.url} target="_blank" rel="noopener noreferrer">
                      Continue to ChatGPT sign-in
                    </a>
                    {snapshot.auth.code && (
                      <p>
                        Pairing code: <code>{snapshot.auth.code}</code>
                      </p>
                    )}
                  </div>
                )}
                {snapshot?.auth.prompt && (
                  <form
                    className="live-callback"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const answer = callback;
                      setCallback("");
                      safely(action("/api/login-answer", { answer }));
                    }}
                  >
                    <label htmlFor="chatgpt-callback">Final callback URL</label>
                    <p>
                      If sign-in ends at a localhost address on your Mac, paste that full address
                      here. It goes directly to Pi and is not saved in this browser.
                    </p>
                    <Input
                      id="chatgpt-callback"
                      value={callback}
                      onChange={(event) => setCallback(event.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={snapshot.auth.prompt}
                      required
                    />
                    <Button type="submit" disabled={pending || !callback.trim()}>
                      Complete sign-in
                    </Button>
                  </form>
                )}
                <section aria-label="Claude account" className="mt-8">
                  <h2>Claude</h2>
                  <p className="live-account-state">
                    {snapshot?.anthropicAuth.connected ? (
                      <>
                        <Check size={15} />
                        Connected
                      </>
                    ) : snapshot?.anthropicAuth.state === "pending" ? (
                      "Waiting for Claude sign-in"
                    ) : (
                      "Connect your Claude account through Pi to use Anthropic models."
                    )}
                  </p>
                  {snapshot?.anthropicAuth.error && (
                    <p role="alert">{snapshot.anthropicAuth.error}</p>
                  )}
                  <Button
                    disabled={pending || !snapshot || snapshot.anthropicAuth.state === "pending"}
                    onClick={() => safely(action("/api/login", { provider: "anthropic" }))}
                  >
                    {snapshot?.anthropicAuth.connected ? "Reconnect Claude" : "Sign in with Claude"}
                  </Button>
                  {snapshot?.anthropicAuth.url && snapshot.anthropicAuth.state === "pending" && (
                    <div className="live-auth-flow">
                      <a
                        href={snapshot.anthropicAuth.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Continue to Claude sign-in
                      </a>
                    </div>
                  )}
                  {snapshot?.anthropicAuth.prompt && (
                    <form
                      className="live-callback"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const answer = claudeCode;
                        setClaudeCode("");
                        safely(
                          action("/api/login-answer", {
                            provider: "anthropic",
                            answer,
                          }),
                        );
                      }}
                    >
                      <label htmlFor="claude-code">Claude authorisation code</label>
                      <p>
                        After signing in, paste the code Claude gives you here. Pi stores the
                        account credentials on the host.
                      </p>
                      <Input
                        id="claude-code"
                        type="password"
                        value={claudeCode}
                        onChange={(event) => setClaudeCode(event.target.value)}
                        autoComplete="off"
                        spellCheck={false}
                        placeholder={snapshot.anthropicAuth.prompt}
                        required
                      />
                      <Button type="submit" disabled={pending || !claudeCode.trim()}>
                        Complete Claude sign-in
                      </Button>
                    </form>
                  )}
                  {snapshot?.anthropicAuth.connected && (
                    <p>
                      Choose Claude Opus 5.5 from the conversation model menu to work on the UI.
                    </p>
                  )}
                </section>
              </TabsContent>
              <TabsContent value="apps">
                <ConnectionSettings />
              </TabsContent>
              <TabsContent value="appearance">
                <ThemeSettings />
              </TabsContent>
              <TabsContent value="connection">
                <h2>Pi host</h2>
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
                    <dd>
                      {connectionError ? "Disconnected" : snapshot ? "Connected" : "Connecting"}
                    </dd>
                  </div>
                </dl>
                <p>
                  Closing this page leaves durable work running. Stop a response explicitly in the
                  conversation.
                </p>
              </TabsContent>
            </Tabs>
          </DialogContent>
        </Dialog>
  );
}
