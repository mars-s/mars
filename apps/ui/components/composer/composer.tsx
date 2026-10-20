"use client";

import { ComposerPrimitive } from "@assistant-ui/react";
import { ArrowUp, ChevronDown, PanelLeft, Plus, Settings, Square } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { LiveImageAttachment } from "@/components/composer/live-image-attachment";
import { useWorkspace } from "@/components/workspace-context";
import "./composer.css";

export function Composer() {
  const { snapshot, pending, connectionError, canChat, action, safely, openSettings } = useWorkspace();
  return (
    <>
                    <ComposerPrimitive.AttachmentDropzone disabled={!canChat || !snapshot}>
                      <ComposerPrimitive.Root className="live-composer">
                        <div className="live-image-drafts">
                          <ComposerPrimitive.Attachments
                            components={{ Attachment: LiveImageAttachment }}
                          />
                        </div>
                        <ComposerPrimitive.Input
                          aria-label="Message Mars"
                          placeholder={
                            canChat
                              ? "How can I help you today?"
                              : "Connect a model to start a conversation"
                          }
                          className="live-composer-input"
                          disabled={!snapshot || !canChat || pending || !!connectionError}
                          rows={2}
                          minRows={2}
                          maxRows={9}
                          submitMode="enter"
                          addAttachmentOnPaste={true}
                          onKeyDown={(event) => {
                            if (event.nativeEvent.isComposing && event.key === "Enter")
                              event.stopPropagation();
                          }}
                        />
                        <div className="live-composer-toolbar">
                          <ComposerPrimitive.AddAttachment
                            className="live-icon"
                            aria-label="Attach images"
                            disabled={!snapshot || !canChat || pending}
                          >
                            <Plus size={17} />
                          </ComposerPrimitive.AddAttachment>
                          <button
                            type="button"
                            className="live-mode"
                            onClick={() => openSettings("connection")}
                          >
                            <PanelLeft size={14} />
                            Pi Durable
                          </button>
                          <div className="live-composer-right">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <button
                                  type="button"
                                  className="live-model"
                                  disabled={!snapshot || pending}
                                  aria-label="Choose model"
                                >
                                  {snapshot?.model || "Model"}
                                  <ChevronDown size={12} />
                                </button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent side="top" align="end">
                                <DropdownMenuRadioGroup
                                  value={snapshot?.model || ""}
                                  onValueChange={(model) => safely(action("/api/model", { model }))}
                                >
                                  {snapshot?.models.map((model) => (
                                    <DropdownMenuRadioItem key={model.id} value={model.id}>
                                      {model.name}
                                    </DropdownMenuRadioItem>
                                  ))}
                                </DropdownMenuRadioGroup>
                              </DropdownMenuContent>
                            </DropdownMenu>
                            {snapshot?.running ? (
                              <ComposerPrimitive.Cancel
                                className="live-send"
                                aria-label="Stop response"
                              >
                                <Square size={15} fill="currentColor" />
                              </ComposerPrimitive.Cancel>
                            ) : (
                              <ComposerPrimitive.Send
                                className="live-send"
                                aria-label="Send message"
                                disabled={!snapshot || !canChat || pending || !!connectionError}
                              >
                                <ArrowUp size={18} />
                              </ComposerPrimitive.Send>
                            )}
                          </div>
                        </div>
                      </ComposerPrimitive.Root>
                    </ComposerPrimitive.AttachmentDropzone>
                    {!canChat && snapshot ? (
                      <p className="live-composer-footnote">
                        <button type="button" onClick={() => openSettings()}>
                          Connect a model in Settings
                        </button>{" "}
                        to start. Conversations stay in this workspace.
                      </p>
                    ) : (
                      <p className="live-composer-footnote">
                        {snapshot ? "Saved in this workspace" : "Connecting to Pi…"}
                      </p>
                    )}
    </>
  );
}
