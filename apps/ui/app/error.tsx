"use client";

export default function ErrorView({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <div style={{ height: "100dvh", display: "grid", placeContent: "center", gap: 16, padding: 32, textAlign: "center" }}><h1 style={{ fontSize: 20 }}>Let’s reload this view.</h1><p style={{ color: "var(--text-muted)" }}>Your saved workspace is still in this browser.</p><button onClick={reset} style={{ padding: "9px 16px", borderRadius: 6, border: "1px solid var(--border)" }}>Try again</button></div>;
}
