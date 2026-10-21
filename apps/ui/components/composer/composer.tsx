"use client";

import { ComposerPrimitive, useAuiState } from "@assistant-ui/react";
import { ArrowUp, Plus } from "lucide-react";
import { ContextMeter } from "@/components/ai/context-meter";
import { ModelPicker, ProviderMark } from "@/components/ai/model-picker";
import { LiveImageAttachment } from "@/components/composer/live-image-attachment";
import { useWorkspace } from "@/components/workspace-context";
import "./composer.css";

/*
 * The Kokonut AI Prompt layout (MIT, kokonutui.com/docs/ai/ai-prompt): a soft outer
 * shell carrying a header strip with the model's provider mark, an inner rounded
 * input surface, attachment tray, round attach button, model and effort selector,
 * and a round send button whose two faces crossfade into Stop. Behaviour stays on
 * the assistant-ui composer runtime: drafts, uploads, Enter, IME and cancel are its.
 */
function SendOrStop({ running, blocked }: { running: boolean; blocked: boolean }) {
  const hasContent = useAuiState(
    (state) => state.composer.text.trim().length > 0 || state.composer.attachments.length > 0,
  );
  const faces = (
    <>
      <span aria-hidden="true" className="live-send-face" data-shown={running ? undefined : ""}>
        <ArrowUp size={16} strokeWidth={2.25} />
      </span>
      <span aria-hidden="true" className="live-send-face" data-shown={running ? "" : undefined}>
        <span className="live-send-stop" />
      </span>
    </>
  );
  return running ? (
    <ComposerPrimitive.Cancel className="live-send" data-ready="" aria-label="Stop response">
      {faces}
    </ComposerPrimitive.Cancel>
  ) : (
    <ComposerPrimitive.Send
      className="live-send"
      data-ready={hasContent && !blocked ? "" : undefined}
      aria-label="Send message"
      disabled={blocked}
    >
      {faces}
    </ComposerPrimitive.Send>
  );
}

export function Composer() {
  const { snapshot, pending, connectionError, canChat, hasMessages, action, safely, openSettings } =
    useWorkspace();
  const blocked = !snapshot || !canChat || pending || !!connectionError;
  const current = snapshot?.models.find((model) => model.id === snapshot.model);
  const running = !!snapshot?.running;
  return (
    <>
      <div className="live-prompt-shell">
        <div className="live-prompt-header">
          {current ? <ProviderMark provider={current.provider} /> : null}
          <p>
            {!snapshot
              ? "Connecting to Pi…"
              : !canChat
                ? "No model connected"
                : running
                  ? `${current?.name ?? "Pi"} is working. Press Stop to end this reply.`
                  : `${current?.name ?? snapshot.model} on Pi`}
          </p>
          {snapshot && !canChat && (
            <button type="button" onClick={() => openSettings()}>
              Connect
            </button>
          )}
        </div>
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
                !canChat
                  ? "Connect a model to start a conversation"
                  : running
                    ? "Replying… keep typing, or press Stop"
                    : "How can I help you today?"
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
                title="Attach images, or drop or paste them"
                disabled={!snapshot || !canChat || pending}
              >
                <Plus size={16} aria-hidden="true" />
              </ComposerPrimitive.AddAttachment>
              <ModelPicker
                models={snapshot?.models ?? []}
                value={snapshot?.model ?? ""}
                effort={snapshot?.thinkingLevel ?? ""}
                disabled={!snapshot || pending}
                onChange={(model) => safely(action("/api/model", { model }))}
                onEffortChange={(effort) => safely(action("/api/effort", { effort }))}
              />
              <span className="live-composer-spacer" />
              {snapshot && (
                <ContextMeter
                  context={snapshot.context}
                  canCompact={hasMessages && !running && !blocked}
                  onCompact={() => safely(action("/api/compact"))}
                />
              )}
              <SendOrStop running={running} blocked={blocked} />
            </div>
            <span aria-hidden="true" className="live-composer-drop-hint">
              Drop images to attach
            </span>
          </ComposerPrimitive.Root>
        </ComposerPrimitive.AttachmentDropzone>
      </div>
      <p className="live-composer-footnote">
        {snapshot ? "Saved in this workspace" : "Connecting to Pi…"}
      </p>
    </>
  );
}
