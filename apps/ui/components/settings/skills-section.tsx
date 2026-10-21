"use client";

import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { piRequest, record } from "@/lib/pi/live-state";

type Skill = { name: string; description: string; source: string };
const SOURCES: Record<string, string> = {
  mars: "Mars",
  agents: "~/.agents",
  claude: "~/.claude",
  custom: "Custom",
};

/** Parse GET /api/skills defensively: unknown rows are dropped. */
export function parseSkills(value: unknown): { total: number; skills: Skill[] } {
  const data = record(value);
  const skills = (Array.isArray(data.skills) ? data.skills : []).map(record).flatMap((row) =>
    typeof row.name === "string" && row.name
      ? [{ name: row.name, description: typeof row.description === "string" ? row.description : "", source: typeof row.source === "string" ? row.source : "" }]
      : [],
  );
  return { total: Number.isInteger(data.total) ? Number(data.total) : skills.length, skills };
}

/**
 * The owner's skills (docs/SKILLS.md): read-only here. The agent loads one with skill_read,
 * the owner can ask for one with /name, and new ones arrive through skill_create or skill_install.
 */
export function SkillsSection() {
  const [state, setState] = useState<{ total: number; skills: Skill[] } | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    let live = true;
    piRequest("/api/skills")
      .then((value) => live && setState(parseSkills(value)))
      .catch((failure) => live && setError(failure instanceof Error ? failure.message : "Skills could not load."));
    return () => {
      live = false;
    };
  }, []);
  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return (state?.skills ?? []).filter((skill) =>
      words.every((word) => (skill.name + " " + skill.description).toLowerCase().includes(word)),
    );
  }, [state, query]);
  return (
    <section className="live-skills" aria-labelledby="live-skills-title">
      <div className="live-skills-head">
        <div>
          <h2 id="live-skills-title">Skills</h2>
          <p>
            Saved instructions Mars reads before matching work. Type <code>/name</code> in a message to use one, or ask
            Mars to install or write new ones.
          </p>
        </div>
        {state && <span className="live-count">{state.total}</span>}
      </div>
      {error && <p role="alert">{error}</p>}
      {state && state.total > 0 && (
        <label className="live-skills-search">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            aria-label="Search skills"
            placeholder="Search skills"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      )}
      {state && state.total === 0 && <p role="status">No skills yet. Ask Mars to install some, for example mattpocock/skills.</p>}
      <ul>
        {shown.map((skill) => (
          <li key={skill.name}>
            <span className="live-skill-name">/{skill.name}</span>
            <span className="live-skill-source">{SOURCES[skill.source] ?? skill.source}</span>
            {skill.description && <p>{skill.description}</p>}
          </li>
        ))}
      </ul>
      {state && query && !shown.length && <p role="status">No skills match “{query}”.</p>}
    </section>
  );
}
