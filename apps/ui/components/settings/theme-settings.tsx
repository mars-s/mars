"use client";

import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import "./theme-settings.css";

const themes = [
  { id: "dark", name: "Dark", detail: "Warm charcoal with ivory text." },
  { id: "light", name: "Light", detail: "Warm paper with dark ink." },
  { id: "oled", name: "OLED", detail: "True black with ivory text." },
] as const;

export function ThemeSettings() {
  const [theme, setTheme] = useState("dark");
  const [feedback, setFeedback] = useState("");
  useEffect(() => {
    const current = document.documentElement.dataset.theme;
    if (themes.some((option) => option.id === current)) setTheme(current!);
  }, []);
  return (
    <section className="mars-theme-section" aria-labelledby="mars-theme-heading">
      <h3 id="mars-theme-heading">Colour mode</h3>
      <p>Motion follows your device preference.</p>
      <div className="mars-theme-grid" role="group" aria-label="Workspace theme">
        {themes.map((option) => (
          <Button
            key={option.id}
            variant="ghost"
            className="mars-theme-card"
            aria-pressed={theme === option.id}
            onClick={() => {
              setTheme(option.id);
              document.documentElement.dataset.theme = option.id;
              try {
                localStorage.setItem("mars-live-theme", option.id);
                setFeedback(`${option.name} theme selected and saved.`);
              } catch {
                setFeedback(
                  `${option.name} theme applied. Browser storage is unavailable; this choice may not persist.`,
                );
              }
            }}
          >
            {/* Each preview sets its own data-theme, so it paints with that theme's tokens. */}
            <span className="mars-theme-preview" data-theme={option.id} aria-hidden="true">
              <span className="mars-theme-preview-sidebar">
                <span />
                <span />
              </span>
              <span className="mars-theme-preview-content">
                <span className="mars-theme-preview-bubble" />
                <span className="mars-theme-preview-line" />
                <span className="mars-theme-preview-line" />
                <span className="mars-theme-preview-composer">
                  <span />
                </span>
              </span>
            </span>
            <span className="mars-theme-name">
              {option.name}
              {theme === option.id && <Check size={14} aria-hidden="true" />}
            </span>
            <span className="mars-theme-description">{option.detail}</span>
          </Button>
        ))}
      </div>
      <p className="mars-theme-feedback" role="status" aria-live="polite">
        {feedback}
      </p>
    </section>
  );
}
