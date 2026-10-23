"use client";

import { ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { ArrowUp, CornerDownRight, Navigation, Plus, X } from "lucide-react";
import type { QueuedMessage } from "@/lib/pi/live-state";
import { ContextMeter } from "@/components/ai/context-meter";
import { ModelPicker, ProviderMark } from "@/components/ai/model-picker";
import { LiveImageAttachment } from "@/components/composer/live-image-attachment";
import { useSlashMenu } from "@/components/composer/slash-menu";
import { VoiceButton } from "@/components/composer/voice-button";
import { useWorkspace } from "@/components/workspace-context";
import "./composer.css";

/*
 * The Kokonut AI Prompt layout (MIT, kokonutui.com/docs/ai/ai-prompt): a soft outer
 * shell carrying a header strip with the model's provider mark, an inner rounded
 * input surface, attachment tray, round attach button, model and effort selector,
 * and a round send button whose two faces crossfade into Stop. Behaviour stays on
 * the assistant-ui composer runtime: drafts, uploads, Enter, IME and cancel are its.
 */
/**
 * Messages waiting for the running reply (Pi's inbox). Queued ones send when the reply ends;
 * Steer sends one into the running reply at its next step.
 */
function QueuePanel({ queue, model }: { queue: QueuedMessage[]; model: string }) {
  const { action, safely } = useWorkspace();
  return (
    <div className="live-queue" role="region" aria-label="Queued messages">
      <p className="live-queue-label">
        {queue.length === 1 ? "1 message" : `${queue.length} messages`} waiting for {model}
      </p>
      <ul>
        {queue.map((item) => {
          const label = item.text || (item.images === 1 ? "1 image" : `${item.images} images`);
          return (
            <li key={item.id} data-mode={item.mode}>
              {item.mode === "steer" ? (
                <Navigation size={14} aria-hidden="true" className="live-queue-icon" />
              ) : (
                <CornerDownRight size={14} aria-hidden="true" className="live-queue-icon" />
              )}
              <span className="live-queue-text" title={item.text}>
                {label}
                {item.text && item.images > 0 && <small> + {item.images === 1 ? "1 image" : `${item.images} images`}</small>}
              </span>
              {item.mode === "steer" ? (
                <small className="live-queue-state">Steering, after the current step</small>
              ) : (
                <button
                  type="button"
                  className="live-queue-steer"
                  aria-label={`Steer now: ${label}`}
                  title="Send into the running reply at its next step"
                  onClick={() => safely(action("/api/queue/steer", { submissionId: item.id }))}
                >
                  <Navigation size={12} aria-hidden="true" />
                  Steer
                </button>
              )}
              <button
                type="button"
                className="live-queue-remove"
                aria-label={`Remove from queue: ${label}`}
                title="Remove from queue"
                onClick={() => safely(action("/api/queue/remove", { submissionId: item.id }))}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function SendOrStop({ running, blocked }: { running: boolean; blocked: boolean }) {
  const aui = useAui();
  const hasContent = useAuiState(
    (state) => state.composer.text.trim().length > 0 || state.composer.attachments.length > 0,
  );
  if (running)
    return (
      <>
        {hasContent && !blocked && (
          <>
            <button
              type="button"
              className="live-steer"
              title="Send into the running reply at its next step (Ctrl or Cmd + Shift + Enter)"
              onClick={() => aui.composer.send({ steer: true })}
            >
              <Navigation size={13} aria-hidden="true" />
              Steer
            </button>
            <button
              type="button"
              className="live-send live-queue-send"
              data-ready=""
              aria-label="Queue message"
              title="Queue: sends when this reply finishes (Enter)"
              onClick={() => aui.composer.send()}
            >
              <span aria-hidden="true" className="live-send-face" data-shown="">
                <ArrowUp size={16} strokeWidth={2.25} />
              </span>
            </button>
          </>
        )}
        <ComposerPrimitive.Cancel className="live-send" data-ready="" aria-label="Stop response">
          <span aria-hidden="true" className="live-send-face" data-shown="">
            <span className="live-send-stop" />
          </span>
        </ComposerPrimitive.Cancel>
      </>
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
  const queue = snapshot?.queue ?? [];
  const slash = useSlashMenu();
  return (
    <>
      <div className="live-prompt-shell">
        {queue.length > 0 ? (
          <QueuePanel queue={queue} model={current?.name ?? "Pi"} />
        ) : (
          <div className="live-prompt-header">
            {current ? <ProviderMark provider={current.provider} /> : null}
            <p>
              {!snapshot
                ? "Connecting to Pi…"
                : !canChat
                  ? "No model connected"
                  : running
                    ? `${current?.name ?? "Pi"} is working. New messages wait in a queue.`
                    : `${current?.name ?? snapshot.model} on Pi`}
            </p>
            {snapshot && !canChat && (
              <button type="button" onClick={() => openSettings()}>
                Connect
              </button>
            )}
          </div>
        )}
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
                    ? "Queue a follow-up, or Steer to send it now"
                    : "How can I help you today?"
              }
              className="live-composer-input"
              disabled={blocked}
              rows={2}
              minRows={2}
              maxRows={9}
              submitMode="enter"
              addAttachmentOnPaste={true}
              {...slash.inputProps}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing && event.key === "Enter") event.stopPropagation();
                slash.onKeyDown(event);
              }}
            />
            {slash.menu}
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
              <VoiceButton disabled={!snapshot || !canChat} />
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
