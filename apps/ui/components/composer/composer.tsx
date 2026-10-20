"use client";

import { ComposerPrimitive } from "@assistant-ui/react";
import { ArrowUp, Plus, Square } from "lucide-react";
import { ContextMeter } from "@/components/ai/context-meter";
import { ModelPicker } from "@/components/ai/model-picker";
import { LiveImageAttachment } from "@/components/composer/live-image-attachment";
import { useWorkspace } from "@/components/workspace-context";
import "./composer.css";

export function Composer() {
  const { snapshot, pending, connectionError, canChat, hasMessages, action, safely, openSettings } =
    useWorkspace();
  const blocked = !snapshot || !canChat || pending || !!connectionError;
  return (
    <>
      <ComposerPrimitive.AttachmentDropzone
        className="live-composer-dropzone"
        disabled={!canChat || !snapshot}
      >
        <ComposerPrimitive.Root className="live-composer">
          <div className="live-image-drafts">
            <ComposerPrimitive.Attachments components={{ Attachment: LiveImageAttachment }} />
          </div>
          <ComposerPrimitive.Input
            aria-label="Message Mars"
            placeholder={
              canChat ? "How can I help you today?" : "Connect a model to start a conversation"
            }
            className="live-composer-input"
            disabled={blocked}
            rows={2}
            minRows={2}
            maxRows={9}
            submitMode="enter"
            addAttachmentOnPaste={true}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing && event.key === "Enter") event.stopPropagation();
            }}
          />
          <div className="live-composer-toolbar">
            <ComposerPrimitive.AddAttachment
              className="live-composer-tool"
              aria-label="Attach images"
              disabled={!snapshot || !canChat || pending}
            >
              <Plus size={18} aria-hidden="true" />
            </ComposerPrimitive.AddAttachment>
            <div className="live-composer-right">
              {snapshot && (
                <ContextMeter
                  context={snapshot.context}
                  canCompact={hasMessages && !snapshot.running && !blocked}
                  onCompact={() =>
                    safely(action("/api/compact"))
                  }
                />
              )}
              <ModelPicker
                models={snapshot?.models ?? []}
                value={snapshot?.model ?? ""}
                disabled={!snapshot || pending}
                onChange={(model) => safely(action("/api/model", { model }))}
              />
              {snapshot?.running ? (
                <ComposerPrimitive.Cancel className="live-send" aria-label="Stop response">
                  <Square size={12} fill="currentColor" strokeWidth={0} aria-hidden="true" />
                </ComposerPrimitive.Cancel>
              ) : (
                <ComposerPrimitive.Send
                  className="live-send"
                  aria-label="Send message"
                  disabled={blocked}
                >
                  <ArrowUp size={18} strokeWidth={2.25} aria-hidden="true" />
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
