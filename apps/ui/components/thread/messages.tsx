"use client";

import { ActionBarPrimitive, MessagePrimitive, useAuiState, type ThreadMessageLike } from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { Clipboard } from "lucide-react";
import remarkGfm from "remark-gfm";
import { record, type LiveMessage } from "@/lib/pi/live-state";
import { ActivityTimeline } from "@/components/activity/activity-timeline";
import "./thread.css";

export function convertMessage(message: LiveMessage): ThreadMessageLike {
  return {
    id: message.id,
    role: message.role,
    content: [{ type: "text", text: message.text }],
    metadata: {
      custom: {
        tools: message.tools,
        outcome: message.outcome,
        images: message.images,
      },
    },
    ...(message.role === "assistant"
      ? {
          status: message.running
            ? { type: "running" }
            : message.outcome
              ? { type: "incomplete", reason: message.outcome }
              : { type: "complete", reason: "stop" },
        }
      : {}),
  };
}
function MarkdownText() {
  return <MarkdownTextPrimitive remarkPlugins={[remarkGfm]} className="mars-markdown" />;
}
export function UserMessage() {
  const images = useAuiState((state) => state.message.metadata.custom?.images);
  return (
    <MessagePrimitive.Root className="live-message live-user">
      <div className="live-user-bubble">
        {Array.isArray(images) && (
          <div className="live-message-images">
            {images.map(record).map((image) => (
              <a key={String(image.id)} href={String(image.url)} target="_blank" rel="noreferrer">
                <img src={String(image.url)} alt={String(image.name)} />
              </a>
            ))}
          </div>
        )}
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  );
}
export function AssistantMessage() {
  const hasText = useAuiState((state) =>
    state.message.content.some((part) => part.type === "text" && part.text.trim().length > 0),
  );
  const raw = useAuiState((state) => state.message.metadata.custom?.tools);
  const outcome = useAuiState((state) => state.message.metadata.custom?.outcome);
  const tools = Array.isArray(raw) ? raw.map(record) : [];
  return (
    <MessagePrimitive.Root className="live-message live-assistant">
      <ActivityTimeline tools={tools} />
      <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
      {outcome === "error" && (
        <p className="live-outcome" role="status">
          The provider could not complete this response. Try a new message.
        </p>
      )}
      {outcome === "cancelled" && <p className="live-outcome">Response stopped.</p>}
      {hasText && (
        <ActionBarPrimitive.Root className="live-actions" autohide="never" hideWhenRunning>
          <ActionBarPrimitive.Copy className="live-icon" aria-label="Copy response">
            <Clipboard size={14} />
          </ActionBarPrimitive.Copy>
        </ActionBarPrimitive.Root>
      )}
    </MessagePrimitive.Root>
  );
}
