"use client";

import {
  ArrowUp,
  Check,
  ChevronDown,
  Clipboard,
  FileText,
  MessageSquare,
  PanelLeft,
  Plus,
  RotateCcw,
  Settings,
  Square,
  Terminal,
  Wrench,
} from "lucide-react";
import { useEffect, useState } from "react";
import { MarsMark } from "@/components/mars-mark";
import { marsLogoConcepts } from "@/components/brand/mars-logo-concepts";
import { ComponentGallery } from "./component-gallery";
import "./design-system.css";

const swatches = [
  { group: "Surfaces", items: [
    ["Canvas", "--background"],
    ["Sidebar", "--sidebar"],
    ["Sidebar hover", "--sidebar-accent"],
    ["Composer", "--composer"],
    ["Raised / menus", "--surface-raised"],
    ["Surface", "--surface"],
    ["User bubble", "--user-bubble"],
    ["Border", "--border"],
    ["Input edge", "--input"],
  ] },
  { group: "Text", items: [
    ["Text", "--text"],
    ["Secondary", "--text-muted"],
    ["Quiet", "--text-faint"],
  ] },
  { group: "Accent and status", items: [
    ["Clay", "--clay"],
    ["Primary action", "--primary"],
    ["Focus ring", "--ring"],
    ["Success", "--green"],
    ["Error", "--red"],
    ["Link", "--blue"],
  ] },
] as const;

const typeScale = [
  { name: "Greeting", spec: "Serif · clamp(32–40px) / 1.2", className: "ds-type-greeting", sample: "What shall we work on?" },
  { name: "Page title", spec: "Serif · 28px / 1.25", className: "ds-type-title", sample: "Your extensions" },
  { name: "Assistant message", spec: "Sans · 16px / 1.65", className: "ds-type-assistant", sample: "Found it. A fresh clone has no workspace lock marker, so the script skips the install." },
  { name: "User message", spec: "Sans · 15px / 1.55", className: "ds-type-user", sample: "Can you check why the deploy script fails on a fresh clone?" },
  { name: "Sidebar row", spec: "Sans · 14px / 20px", className: "ds-type-row", sample: "Tidy the Pi host deploy script" },
  { name: "Section label", spec: "Sans · 12px · 500", className: "ds-type-label", sample: "Recents" },
  { name: "Metadata", spec: "Sans · 12px", className: "ds-type-meta", sample: "Saved in this workspace" },
  { name: "Code", spec: "Mono · 13px / 1.6", className: "ds-type-code", sample: "npm run test:install" },
];

const radii = [
  ["Small control", "8px"],
  ["Row / menu item", "10px"],
  ["User bubble", "16px"],
  ["Composer", "20px"],
];

const spacing = [4, 8, 12, 16, 24, 32, 48];

function Swatch({ label, token }: { label: string; token: string }) {
  const [value, setValue] = useState("");
  useEffect(() => {
    const element = document.querySelector(".ds-frame");
    if (element) setValue(getComputedStyle(element).getPropertyValue(token).trim());
  });
  return (
    <div className="ds-swatch">
      <span className="ds-chip" style={{ background: `var(${token})` }} />
      <span className="ds-swatch-label">{label}</span>
      <code>{token}</code>
      <code className="ds-swatch-value">{value}</code>
    </div>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="ds-section">
      <header>
        <h2>{title}</h2>
        {note && <p>{note}</p>}
      </header>
      {children}
    </section>
  );
}

export function DesignSystem() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  return (
    <div className="ds-frame" data-theme={theme}>
      <div className="ds-page">
        <header className="ds-masthead">
          <div>
            <h1>
              <MarsMark width={30} height={30} />
              Mars design system
            </h1>
            <p>
              Live tokens from <code>app/globals.css</code>. Claude desktop direction, Mars identity.
              Edits to the tokens show here immediately.
            </p>
          </div>
          <div className="ds-theme-toggle" role="group" aria-label="Preview theme">
            {(["dark", "light"] as const).map((option) => (
              <button key={option} type="button" aria-pressed={theme === option} onClick={() => setTheme(option)}>
                {option === "dark" ? "Dark" : "Light"}
              </button>
            ))}
          </div>
        </header>

        <Section title="Logo" note="Three new Mars marks. Each is one solid shape in clay, so it holds at favicon size and in both themes. Pick one and it replaces the old ringed planet everywhere.">
          <div className="ds-logos">
            {marsLogoConcepts.map(({ id, name, Mark, note }) => (
              <article key={id} className="ds-logo">
                <div className="ds-logo-hero">
                  <Mark width={72} height={72} />
                </div>
                <div className="ds-logo-lockup">
                  <Mark width={22} height={22} />
                  <span>Mars</span>
                </div>
                <div className="ds-logo-sizes" aria-label={`${name} at 32, 20 and 16 pixels`}>
                  <span className="ds-logo-tile"><Mark width={32} height={32} /></span>
                  <Mark width={20} height={20} />
                  <Mark width={16} height={16} />
                </div>
                <h3>{name}</h3>
                <p>{note}</p>
              </article>
            ))}
            <article className="ds-logo ds-logo-old">
              <div className="ds-logo-hero"><MarsMark width={72} height={72} /></div>
              <h3>Current (old)</h3>
              <p>Ringed planet. Reads as Saturn, thin strokes blur at small sizes.</p>
            </article>
          </div>
        </Section>

        <Section title="Colour" note="Clay is rare: send, the Mars mark and focus only. Status colours always sit beside a label.">
          {swatches.map((group) => (
            <div key={group.group} className="ds-swatch-group">
              <h3>{group.group}</h3>
              <div className="ds-swatch-grid">
                {group.items.map(([label, token]) => (
                  <Swatch key={token} label={label} token={token} />
                ))}
              </div>
            </div>
          ))}
        </Section>

        <Section title="Type" note="Anthropic Sans for interface and reading, Anthropic Serif for greetings and titles, Anthropic Mono for code.">
          <div className="ds-type-list">
            {typeScale.map((row) => (
              <div key={row.name} className="ds-type-row-item">
                <div className="ds-type-meta-col">
                  <strong>{row.name}</strong>
                  <span>{row.spec}</span>
                </div>
                <p className={row.className}>{row.sample}</p>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Shape and spacing">
          <div className="ds-shape-row">
            {radii.map(([label, radius]) => (
              <div key={label} className="ds-radius">
                <span style={{ borderRadius: radius }} />
                <strong>{label}</strong>
                <code>{radius}</code>
              </div>
            ))}
          </div>
          <div className="ds-spacing">
            {spacing.map((size) => (
              <div key={size}>
                <span style={{ width: size, height: size }} />
                <code>{size}</code>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Buttons and controls">
          <div className="ds-controls">
            <button type="button" className="ds-send" aria-label="Send message"><ArrowUp size={17} /></button>
            <button type="button" className="ds-send" aria-label="Stop response"><Square size={13} fill="currentColor" /></button>
            <button type="button" className="ds-send" disabled aria-label="Send disabled"><ArrowUp size={17} /></button>
            <button type="button" className="ds-btn ds-btn-primary">Sign in</button>
            <button type="button" className="ds-btn ds-btn-secondary">Reconnect</button>
            <button type="button" className="ds-btn ds-btn-ghost">Cancel</button>
            <button type="button" className="ds-icon-btn" aria-label="Attach"><Plus size={18} /></button>
            <button type="button" className="ds-icon-btn" aria-label="Settings"><Settings size={17} /></button>
            <button type="button" className="ds-model">GPT-6 Sol <ChevronDown size={14} /></button>
          </div>
          <p className="ds-hint">Press Tab through these to see the focus ring.</p>
        </Section>

        <Section title="Sidebar">
          <div className="ds-sidebar">
            <div className="ds-sidebar-brand">
              <span><MarsMark width={22} height={22} /> Mars</span>
              <button type="button" className="ds-icon-btn" aria-label="Collapse sidebar"><PanelLeft size={17} /></button>
            </div>
            <button type="button" className="ds-row ds-row-new"><span className="ds-new-dot"><Plus size={14} /></span>New chat</button>
            <button type="button" className="ds-row"><MessageSquare size={16} />Chats</button>
            <button type="button" className="ds-row"><Wrench size={16} />Extensions</button>
            <p className="ds-type-label ds-recents">Recents</p>
            <button type="button" className="ds-row ds-row-selected">Tidy the Pi host deploy script</button>
            <button type="button" className="ds-row">Weekly reading list<span className="ds-running" aria-label="Running" /></button>
            <button type="button" className="ds-row ds-row-child">Research subtask</button>
            <div className="ds-account"><span className="ds-avatar">A</span><span>Pi workspace</span><span className="ds-dot" /></div>
          </div>
        </Section>

        <Section title="Composer">
          <div className="ds-composer">
            <p className="ds-placeholder">How can I help you today?</p>
            <div className="ds-composer-bar">
              <div>
                <button type="button" className="ds-icon-btn" aria-label="Attach images"><Plus size={18} /></button>
                <button type="button" className="ds-chip-btn"><Wrench size={14} /> Tools</button>
              </div>
              <div>
                <button type="button" className="ds-model">GPT-6 Sol <ChevronDown size={14} /></button>
                <button type="button" className="ds-send" aria-label="Send"><ArrowUp size={17} /></button>
              </div>
            </div>
          </div>
        </Section>

        <Section title="Messages and tool activity">
          <div className="ds-thread">
            <div className="ds-user"><p>Can you check why the deploy script fails on a fresh clone?</p></div>
            <div className="ds-activity">
              <button type="button" className="ds-activity-head"><Check size={14} /> Ran 2 actions <ChevronDown size={14} /></button>
              <div className="ds-activity-rows">
                <div><Terminal size={14} /><span>Run command</span><code>npm run test:install</code><em className="ds-status-fail">Failed</em></div>
                <div><FileText size={14} /><span>Read file</span><code>scripts/deploy-host.mjs</code><em>Done</em></div>
              </div>
            </div>
            <div className="ds-assistant">
              <p>Found it. A fresh clone has no <strong>workspace lock marker</strong>, so the script skips the dependency install.</p>
              <pre><code>{`if (!existsSync(marker)) await installWorkspace();`}</code></pre>
              <div className="ds-actions">
                <button type="button" className="ds-icon-btn" aria-label="Copy"><Clipboard size={15} /></button>
                <button type="button" className="ds-icon-btn" aria-label="Retry"><RotateCcw size={15} /></button>
              </div>
            </div>
          </div>
        </Section>

        <Section title="AI components" note="The chosen components from the redesign plan, themed to Mars tokens. Priority order: Kokonut UI, then 21st Agent Elements, then assistant-ui, then shadcn AI Elements. All sample data here is illustrative; nothing is connected to Pi.">
          <ComponentGallery />
        </Section>

        <Section title="Notices">
          <div className="ds-notice">Cannot reach Pi. Check the connection and retry. <button type="button">Reconnect</button></div>
          <div className="ds-notice ds-notice-quiet">Response stopped.</div>
        </Section>
      </div>
    </div>
  );
}
