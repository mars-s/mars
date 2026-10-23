"use client";

import { useEffect, useRef, useState, type ComponentProps } from "react";
import { ActionBarPrimitive, MessagePrimitive, useAuiState, type ThreadMessageLike } from "@assistant-ui/react";
import { MarkdownTextPrimitive, type CodeHeaderProps } from "@assistant-ui/react-markdown";
import { AlertCircle, Check, Copy } from "lucide-react";
import remarkGfm from "remark-gfm";
import { record, type LiveMessage } from "@/lib/pi/live-state";
import { userParts } from "@/lib/pi/image-chips";
import { ActivityTimeline } from "@/components/activity/activity-timeline";
import "./thread.css";

export function convertMessage(message: LiveMessage): ThreadMessageLike {
  // A sent message reads in order, each image where it was placed (docs/IMAGE-CHIPS.md).
  const parts = message.role === "user" ? userParts(message.text, message.images ?? []) : null;
  return {
    id: message.id,
    role: message.role,
    content: parts
      ? parts.map((part) =>
          part.type === "text"
            ? { type: "text" as const, text: part.text }
            : { type: "image" as const, image: part.image.url, filename: part.image.name },
        )
      : [{ type: "text", text: message.text }],
    metadata: {
      custom: {
        tools: message.tools,
        summary: message.summary,
        outcome: message.outcome,
        imageLabels: parts ? Object.fromEntries(parts.flatMap((part) => (part.type === "image" && part.label ? [[part.image.url, part.label]] : []))) : {},
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
/** An image inside a sent message, where it was placed, with its label ("Image 1") if it had one. */
function InlineImage({ image, filename }: { image: string; filename?: string }) {
  const labels = useAuiState((state) => state.message.metadata.custom?.imageLabels);
  const label = typeof record(labels)[image] === "string" ? String(record(labels)[image]) : "";
  return (
    <figure className="live-inline-image">
      <a href={image} target="_blank" rel="noreferrer">
        <img src={image} alt={label ? `${label}: ${filename ?? "image"}` : (filename ?? "Image")} />
      </a>
      {label && <figcaption>{label}</figcaption>}
    </figure>
  );
}
const userComponents = { Image: InlineImage };
export function UserMessage() {
  const hasContent = useAuiState((state) =>
    state.message.content.some((part) => part.type === "image" || (part.type === "text" && part.text.trim().length > 0)),
  );
  return (
    <MessagePrimitive.Root className="live-message live-user">
      {hasContent && (
        <div className="live-user-bubble">
          <MessagePrimitive.Parts components={userComponents} />
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
  const summary = useAuiState((state) => state.message.metadata.custom?.summary);
  const tools = Array.isArray(raw) ? raw.map(record) : [];
  return (
    <MessagePrimitive.Root className={`live-message live-assistant${isLast ? " is-last" : ""}`}>
      <ActivityTimeline tools={tools} summary={typeof summary === "string" ? summary : undefined} />
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
