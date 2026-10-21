"use client";

import { useEffect, useRef, useState } from "react";
import { record, type LiveSnapshot } from "@/lib/pi/live-state";
import { PluginManager } from "@/components/settings/plugin-manager";
import { SkillsSection } from "@/components/settings/skills-section";
import { useWorkspace } from "@/components/workspace-context";
import "./extensions.css";

export function ExtensionPanel({ extension }: { extension: Pick<LiveSnapshot["extensions"][number], "hash" | "title"> }) {
  const target = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const root = target.current;
    if (!root) return;
    let detached = false;
    let cleanup: (() => void) | undefined;
    root.replaceChildren();
    // Native host modules are trusted installed code. Hashes are validated at the snapshot boundary.
    const load = async () => {
      try {
        const module: unknown = await import(
          /* webpackIgnore: true */ `/extensions/${extension.hash}/client.js`
        );
        const mount = record(module).mount;
        if (typeof mount !== "function") throw Error("This extension does not provide a UI.");
        if (detached) return;
        const result: unknown = mount(root);
        if (typeof result === "function") cleanup = () => result();
      } catch (failure) {
        if (!detached)
          setError(failure instanceof Error ? failure.message : "Extension could not load.");
      }
    };
    void load();
    return () => {
      detached = true;
      cleanup?.();
      root.replaceChildren();
    };
  }, [extension.hash]);
  return (
    <section className="live-extension" role="region" aria-label={extension.title}>
      {error && <p role="alert">{error}</p>}
      <div ref={target} />
    </section>
  );
}
export function ExtensionsPage() {
  const { snapshot } = useWorkspace();
  return (
    <div className="live-extensions-page">
      <h1>Your extensions</h1>
      <p>Capabilities installed into this Pi agent, including their own interface.</p>
      <PluginManager
        renderInterface={(name) => {
          const extension = snapshot?.extensions.find((item) => item.name === name);
          return extension && extension.enabled !== false && extension.uiEnabled !== false ? (
            <ExtensionPanel extension={extension} />
          ) : (
            <p role="status">The interface is unavailable. Refresh after installation.</p>
          );
        }}
      />
      <SkillsSection />
    </div>
  );
}
