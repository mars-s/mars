"use client";

import { Check, ChevronDown } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import "./model-picker.css";

export type PiModel = { id: string; name: string };

/**
 * The composer's model menu, drawn after the Kokonut AI Model Selector (two-line
 * rows, a check on the current model, a panel that grows out of its trigger) on
 * a Radix menu for keyboard and menuitemradio semantics. Pi exposes no effort
 * levels, so the selector's effort track is left out rather than faked.
 */
export function ModelPicker({
  models,
  value,
  disabled,
  onChange,
}: {
  models: readonly PiModel[];
  value: string;
  disabled: boolean;
  onChange: (id: string) => void;
}) {
  const label = models.find((model) => model.id === value)?.name || value || "Model";
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="mars-model-trigger" disabled={disabled} aria-label="Choose model">
          <span className="mars-model-trigger-name">{label}</span>
          <ChevronDown aria-hidden="true" size={14} />
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
          <DropdownMenu.Label className="mars-model-menu-label">Model</DropdownMenu.Label>
          {models.length ? (
            <DropdownMenu.RadioGroup value={value} onValueChange={onChange}>
              {models.map((model) => (
                <DropdownMenu.RadioItem
                  key={model.id}
                  value={model.id}
                  aria-label={model.name}
                  className="mars-model-option"
                >
                  <span className="mars-model-option-text">
                    {model.name}
                    {model.name !== model.id && <small>{model.id}</small>}
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
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
