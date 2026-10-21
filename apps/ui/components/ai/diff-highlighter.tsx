"use client";

import { getSharedHighlighter } from "@pierre/diffs";
import { useEffect, useState, type ReactNode } from "react";

// @pierre/diffs only paints a diff once its Shiki highlighter is loaded, and a
// first mount does not re-render after the async load finishes. Load it once,
// then mount diff consumers (21st EditTool) so they paint on their first render.
let ready: Promise<unknown> | undefined;
const languages = ["javascript", "typescript", "tsx", "jsx", "json", "css", "html", "markdown", "bash", "python", "yaml"];

export function DiffHighlighterReady({ children, fallback = null }: { children: ReactNode; fallback?: ReactNode }) {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let active = true;
    ready ??= getSharedHighlighter({ themes: ["github-dark", "github-light"], langs: languages });
    ready.then(
      () => active && setLoaded(true),
      () => active && setLoaded(true),
    );
    return () => {
      active = false;
    };
  }, []);
  return loaded ? children : fallback;
}
