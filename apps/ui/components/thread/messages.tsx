"use client";

import { useEffect, useRef, useState, type ComponentProps } from "react";
import { ActionBarPrimitive, MessagePrimitive, useAuiState, type ThreadMessageLike } from "@assistant-ui/react";
import { MarkdownTextPrimitive, type CodeHeaderProps } from "@assistant-ui/react-markdown";
import { AlertCircle, Check, Copy } from "lucide-react";
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

function CodeHeader({ language, code }: CodeHeaderProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      return;
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="mars-code-header">
      <span>{language || "text"}</span>
      <button type="button" onClick={copy} aria-label={copied ? "Code copied" : "Copy code"}>
        {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
type MarkdownProps<Tag extends "table" | "a"> = ComponentProps<Tag> & { node?: unknown };
function MarkdownTable({ node: _node, ...props }: MarkdownProps<"table">) {
  return (
    <div className="mars-table-wrap">
      <table {...props} />
    </div>
  );
}
function MarkdownLink({ node: _node, ...props }: MarkdownProps<"a">) {
  return <a {...props} target="_blank" rel="noreferrer" />;
}
const markdownComponents = { CodeHeader, table: MarkdownTable, a: MarkdownLink };
const remarkPlugins = [remarkGfm];

function MarkdownText() {
  return (
    <MarkdownTextPrimitive
      remarkPlugins={remarkPlugins}
      components={markdownComponents}
      className="mars-markdown"
    />
  );
}
function useHasText() {
  return useAuiState((state) =>
    state.message.content.some((part) => part.type === "text" && part.text.trim().length > 0),
  );
}
export function UserMessage() {
  const images = useAuiState((state) => state.message.metadata.custom?.images);
  const hasText = useHasText();
  return (
    <MessagePrimitive.Root className="live-message live-user">
      {Array.isArray(images) && images.length > 0 && (
        <div className="live-message-images">
          {images.map(record).map((image) => (
            <a key={String(image.id)} href={String(image.url)} target="_blank" rel="noreferrer">
              <img src={String(image.url)} alt={String(image.name)} />
            </a>
          ))}
        </div>
      )}
      {hasText && (
        <div className="live-user-bubble">
          <MessagePrimitive.Parts />
        </div>
      )}
    </MessagePrimitive.Root>
  );
}
export function AssistantMessage() {
  const hasText = useHasText();
  const isLast = useAuiState((state) => state.message.isLast);
  const raw = useAuiState((state) => state.message.metadata.custom?.tools);
  const outcome = useAuiState((state) => state.message.metadata.custom?.outcome);
  const tools = Array.isArray(raw) ? raw.map(record) : [];
  return (
    <MessagePrimitive.Root className={`live-message live-assistant${isLast ? " is-last" : ""}`}>
      <ActivityTimeline tools={tools} />
      <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
      {outcome === "error" && (
        <p className="live-outcome" role="status">
          <AlertCircle size={14} aria-hidden />
          The provider could not complete this response. Try a new message.
        </p>
      )}
      {outcome === "cancelled" && <p className="live-outcome">Response stopped.</p>}
      {hasText && (
        <ActionBarPrimitive.Root className="live-actions" autohide="never" hideWhenRunning>
          <ActionBarPrimitive.Copy className="live-action" aria-label="Copy response">
            <Copy size={15} className="live-action-copy" aria-hidden />
            <Check size={15} className="live-action-done" aria-hidden />
          </ActionBarPrimitive.Copy>
        </ActionBarPrimitive.Root>
      )}
    </MessagePrimitive.Root>
  );
}
