"use client";

import { useAui, useAuiState } from "@assistant-ui/react";
import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { parseSkills } from "@/components/settings/skills-section";
import { piRequest } from "@/lib/pi/live-state";

type Skill = { name: string; description: string };

/** Skills whose name starts with the query first, then those that contain it anywhere. */
export function rankSkills(skills: readonly Skill[], query: string): Skill[] {
  const q = query.toLowerCase();
  const starts = skills.filter((skill) => skill.name.startsWith(q));
  const contains = skills.filter((skill) => !skill.name.startsWith(q) && (skill.name.includes(q) || skill.description.toLowerCase().includes(q)));
  return [...starts, ...contains].slice(0, 8);
}

/**
 * Typing "/" at the start of a message lists the owner's skills (docs/SKILLS.md); choosing one
 * writes "/name " so the agent uses that skill. Arrow keys move, Enter or Tab choose, Escape closes.
 * Returns the key handler and input attributes for the composer input, and the menu to render.
 */
export function useSlashMenu() {
  const aui = useAui();
  const listId = useId();
  const text = useAuiState((state) => state.composer.text);
  const match = /^\/([\w.-]*)$/.exec(text);
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState("");
  const wanted = !!match;
  useEffect(() => {
    if (!wanted || skills !== null) return;
    let live = true;
    piRequest("/api/skills")
      .then((value) => live && setSkills(parseSkills(value).skills))
      .catch(() => live && setSkills([]));
    return () => {
      live = false;
    };
  }, [wanted, skills]);
  const options = match && dismissed !== text ? rankSkills(skills ?? [], match[1]) : [];
  const open = options.length > 0;
  const current = Math.min(active, Math.max(0, options.length - 1));
  const choose = (skill: Skill) => {
    aui.composer.setText(`/${skill.name} `);
    setActive(0);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (!open || event.nativeEvent.isComposing) return;
    const move = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    if (move) setActive((current + move + options.length) % options.length);
    else if (event.key === "Enter" || event.key === "Tab") choose(options[current]);
    else if (event.key === "Escape") setDismissed(text);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };
  // The input stays a textbox (other code and tests find it by that role); a textbox may own an
  // autocomplete list through aria-controls and aria-activedescendant.
  const inputProps = {
    "aria-controls": open ? listId : undefined,
    "aria-autocomplete": "list" as const,
    "aria-activedescendant": open ? `${listId}-${current}` : undefined,
  };
  const menu = open ? (
    <ul id={listId} role="listbox" aria-label="Skills" className="live-slash-menu">
      {options.map((skill, index) => (
        <li
          key={skill.name}
          id={`${listId}-${index}`}
          role="option"
          aria-selected={index === current}
          onMouseEnter={() => setActive(index)}
          onMouseDown={(event) => {
            // Keep focus in the input.
            event.preventDefault();
            choose(skill);
          }}
        >
          <span className="live-slash-name">/{skill.name}</span>
          {skill.description && <span className="live-slash-description">{skill.description}</span>}
        </li>
      ))}
    </ul>
  ) : null;
  return { onKeyDown, inputProps, menu };
}
