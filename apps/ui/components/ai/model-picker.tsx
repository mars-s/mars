"use client";

import { Check, ChevronDown } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useId, useRef, useState, type KeyboardEvent } from "react";
import type { ModelChoice } from "@/lib/pi/live-state";
import { ClaudeMark, OpenAIMark } from "./provider-marks";
import "./model-picker.css";

/*
 * The Kokonut AI Model Selector (MIT, kokonutui.com/docs/ai/ai-model-selector):
 * two-line model rows with a check, then an Effort detent track with ← → hints,
 * and a trigger showing name, signal bars and level. Rebuilt on a Radix menu so
 * rows keep menuitemradio semantics, and fed only Pi data: each model's
 * supported thinking levels and the conversation's current level. A model
 * without levels simply has no Effort section.
 */

const EFFORT_COPY: Record<string, { label: string; hint: string }> = {
  off: { label: "Off", hint: "No thinking step. Fastest replies." },
  minimal: { label: "Minimal", hint: "Skips reasoning almost entirely. Lowest latency." },
  low: { label: "Low", hint: "Answers right away. Best for quick edits and lookups." },
  medium: { label: "Medium", hint: "Thinks briefly first. A good default for most work." },
  high: { label: "High", hint: "Thinks longer on hard problems. Slower, uses more tokens." },
  xhigh: { label: "Extra high", hint: "Thinks at length before answering. For tricky tasks." },
  max: { label: "Max", hint: "No limit on thinking. For the hardest tasks only." },
};
const effortLabel = (level: string) => EFFORT_COPY[level]?.label ?? level;

const DESCRIPTIONS: [RegExp, string][] = [
  [/opus/i, "Most capable, for complex work"],
  [/fable/i, "Newest Claude model"],
  [/sonnet/i, "Fast and capable for everyday tasks"],
  [/haiku/i, "Fastest, for quick answers"],
  [/astra/i, "Frontier intelligence for demanding work"],
  [/sol/i, "Workhorse for coding and everyday work"],
  [/luna/i, "Fast and affordable for easier tasks"],
];
const describe = (model: ModelChoice) => DESCRIPTIONS.find(([pattern]) => pattern.test(model.id))?.[1];

export function ProviderMark({ provider, className }: { provider: string; className?: string }) {
  if (provider === "anthropic") return <ClaudeMark className={`mars-provider-mark is-claude ${className ?? ""}`} />;
  if (provider === "openai") return <OpenAIMark className={`mars-provider-mark ${className ?? ""}`} />;
  return null;
}

function EffortBars({ count, level }: { count: number; level: number }) {
  return (
    <span aria-hidden="true" className="mars-effort-bars">
      {Array.from({ length: count }, (_, index) => (
        <span
          key={index}
          data-on={index <= level ? "" : undefined}
          style={{ height: `${((index + 1) / count) * 100}%` }}
        />
      ))}
    </span>
  );
}

function EffortTrack({
  levels,
  value,
  labelId,
  disabled,
  onChange,
}: {
  levels: readonly string[];
  value: number;
  labelId: string;
  disabled: boolean;
  onChange: (index: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const count = levels.length;
  const indexAt = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return value;
    return Math.min(count - 1, Math.max(0, Math.floor(((clientX - rect.left) / rect.width) * count)));
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const moves: Record<string, number> = {
      ArrowLeft: value - 1,
      ArrowDown: value - 1,
      ArrowRight: value + 1,
      ArrowUp: value + 1,
      Home: 0,
      End: count - 1,
    };
    if (!(event.key in moves)) return;
    // Keep arrows on the slider instead of moving the menu highlight.
    event.preventDefault();
    event.stopPropagation();
    const next = Math.min(count - 1, Math.max(0, moves[event.key]));
    if (next !== value) onChange(next);
  };
  return (
    <div
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-labelledby={labelId}
      aria-valuemin={0}
      aria-valuemax={count - 1}
      aria-valuenow={value}
      aria-valuetext={effortLabel(levels[value] ?? "")}
      aria-disabled={disabled || undefined}
      className="mars-effort-track"
      onKeyDown={onKeyDown}
      onPointerDown={(event) => {
        if (disabled) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
        const next = indexAt(event.clientX);
        if (next !== value) onChange(next);
      }}
      onPointerMove={(event) => {
        if (!dragging) return;
        const next = indexAt(event.clientX);
        if (next !== value) onChange(next);
      }}
      onPointerUp={() => setDragging(false)}
      onLostPointerCapture={() => setDragging(false)}
    >
      <div className="mars-effort-stops" ref={trackRef}>
        <span
          aria-hidden="true"
          className="mars-effort-thumb"
          data-dragging={dragging ? "" : undefined}
          style={{ left: `${(value / count) * 100}%`, width: `${100 / count}%` }}
        />
        {levels.map((level, index) => (
          <span key={level} aria-hidden="true" data-active={index === value ? "" : undefined}>
            {effortLabel(level)}
          </span>
        ))}
      </div>
    </div>
  );
}

export function ModelPicker({
  models,
  value,
  effort,
  disabled,
  onChange,
  onEffortChange,
}: {
  models: readonly ModelChoice[];
  value: string;
  effort: string;
  disabled: boolean;
  onChange: (id: string) => void;
  onEffortChange: (effort: string) => void;
}) {
  const effortLabelId = useId();
  const current = models.find((model) => model.id === value);
  const levels = current?.efforts ?? [];
  const level = levels.indexOf(effort);
  const label = current?.name || value || "Model";
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="mars-model-trigger"
          disabled={disabled}
          aria-label="Choose model"
          title={level >= 0 ? `${label}, ${effortLabel(effort)} effort` : label}
        >
          {current && <ProviderMark provider={current.provider} />}
          <span className="mars-model-trigger-name">{label}</span>
          {level >= 0 && (
            <span className="mars-model-trigger-effort">
              <EffortBars count={levels.length} level={level} />
              {effortLabel(effort)}
            </span>
          )}
          <ChevronDown aria-hidden="true" size={14} className="mars-model-chevron" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="mars-model-menu"
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={12}
        >
          {models.length ? (
            <DropdownMenu.RadioGroup value={value} onValueChange={onChange}>
              {models.map((model) => (
                <DropdownMenu.RadioItem
                  key={model.id}
                  value={model.id}
                  aria-label={model.name}
                  className="mars-model-option"
                >
                  <ProviderMark provider={model.provider} className="mars-model-option-mark" />
                  <span className="mars-model-option-text">
                    {model.name}
                    {describe(model) && <small>{describe(model)}</small>}
                  </span>
                  <span className="mars-model-option-check">
                    <DropdownMenu.ItemIndicator>
                      <Check aria-hidden="true" size={16} />
                    </DropdownMenu.ItemIndicator>
                  </span>
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
          ) : (
            <DropdownMenu.Item disabled className="mars-model-option">
              No models available
            </DropdownMenu.Item>
          )}
          {levels.length > 0 && (
            <>
              <DropdownMenu.Separator className="mars-model-separator" />
              <div className="mars-effort">
                <div className="mars-effort-head">
                  <p id={effortLabelId}>Effort</p>
                  <p aria-hidden="true">← → to adjust</p>
                </div>
                <EffortTrack
                  levels={levels}
                  value={Math.max(0, level)}
                  labelId={effortLabelId}
                  disabled={disabled}
                  onChange={(index) => onEffortChange(levels[index])}
                />
                <p className="mars-effort-hint" aria-live="polite">
                  {level >= 0 ? EFFORT_COPY[effort]?.hint : "Choose how long the model thinks."}
                </p>
              </div>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
