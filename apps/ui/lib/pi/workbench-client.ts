"use client";

import { useCallback, useEffect, useState } from "react";
import { piRequest } from "./live-state";

/** GET a workbench route and parse it; refresh() refetches. Errors are text for the pane. */
export function useHostData<T>(path: string | null, parse: (value: unknown) => T) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const refresh = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try {
      setData(parse(await piRequest(path)));
      setError("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The Pi host did not answer.");
    } finally {
      setLoading(false);
    }
  }, [path, parse]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { data, error, loading, refresh };
}

export const query = (path: string, params: Record<string, string | undefined>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, value);
  const text = search.toString();
  return text ? `${path}?${text}` : path;
};
