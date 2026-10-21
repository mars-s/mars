"use client";

import { useId, useState } from "react";
import { useWorkspace } from "@/components/workspace-context";
import type { ModelSettings } from "@/lib/pi/live-state";
import "./model-settings.css";

const EFFORT_NAMES: Record<string, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/**
 * The owner's default model and effort for new chats, and the optional cheap background model
 * that names chats and summarises long runs of steps (docs/MODELS.md). Saved on the host.
 */
export function ModelSettingsPanel() {
  const { snapshot, action, safely } = useWorkspace();
  const ids = { model: useId(), effort: useId(), background: useId() };
  const [saving, setSaving] = useState(false);
  const models = snapshot?.models ?? [];
  const value: ModelSettings = snapshot?.modelSettings ?? { defaultModel: "", defaultEffort: "", backgroundModel: "" };
  const efforts = models.find((model) => model.id === value.defaultModel)?.efforts ?? [];
  const save = (change: Partial<ModelSettings>) => {
    setSaving(true);
    safely(action("/api/settings/models", change).finally(() => setSaving(false)));
  };
  const options = models.map((model) => (
    <option key={model.id} value={model.id}>
      {model.name}
    </option>
  ));
  return (
    <div className="live-model-settings" aria-busy={saving || undefined}>
      <div className="live-model-setting">
        <label htmlFor={ids.model}>Default model</label>
        <p>Every new chat starts on this model. You can still change it in any chat.</p>
        <select
          id={ids.model}
          value={value.defaultModel}
          disabled={!snapshot || saving}
          onChange={(event) => save({ defaultModel: event.target.value })}
        >
          <option value="">Same as the chat you are in</option>
          {options}
        </select>
      </div>
      {value.defaultModel && efforts.length > 0 && (
        <div className="live-model-setting">
          <label htmlFor={ids.effort}>Default effort</label>
          <p>How long the default model thinks before answering.</p>
          <select
            id={ids.effort}
            value={efforts.includes(value.defaultEffort) ? value.defaultEffort : ""}
            disabled={saving}
            onChange={(event) => save({ defaultEffort: event.target.value })}
          >
            <option value="">Model default</option>
            {efforts.map((effort) => (
              <option key={effort} value={effort}>
                {EFFORT_NAMES[effort] ?? effort}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="live-model-setting">
        <label htmlFor={ids.background}>Background model</label>
        <p>
          A cheap model that names new chats and writes a one-line summary of long runs of steps. It only sees your
          first message and the names of the tools used, never their output. OpenCode Go models appear here once its
          key is saved in Apps.
        </p>
        <select
          id={ids.background}
          value={value.backgroundModel}
          disabled={!snapshot || saving}
          onChange={(event) => save({ backgroundModel: event.target.value })}
        >
          <option value="">Off</option>
          {options}
        </select>
      </div>
    </div>
  );
}
