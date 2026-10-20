"use client";

// Loaded with import() from terminal-pane.tsx so xterm stays out of the main bundle.
import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

/** Every colour is a Mars token (or a mix of tokens), resolved by the browser. */
const PALETTE: Record<Exclude<keyof ITheme, "extendedAnsi">, string> = {
  background: "var(--sidebar)",
  foreground: "var(--text)",
  cursor: "var(--clay)",
  cursorAccent: "var(--sidebar)",
  selectionBackground: "color-mix(in srgb, var(--clay) 32%, transparent)",
  selectionForeground: "var(--text)",
  selectionInactiveBackground: "color-mix(in srgb, var(--text) 14%, transparent)",
  scrollbarSliderBackground: "color-mix(in srgb, var(--text) 18%, transparent)",
  scrollbarSliderHoverBackground: "color-mix(in srgb, var(--text) 28%, transparent)",
  scrollbarSliderActiveBackground: "color-mix(in srgb, var(--text) 36%, transparent)",
  overviewRulerBorder: "transparent",
  black: "color-mix(in srgb, var(--text) 18%, var(--sidebar))",
  red: "var(--red)",
  green: "var(--green)",
  yellow: "var(--amber)",
  blue: "var(--blue)",
  magenta: "var(--clay)",
  cyan: "color-mix(in srgb, var(--blue) 55%, var(--green))",
  white: "var(--text-muted)",
  brightBlack: "var(--text-faint)",
  brightRed: "color-mix(in srgb, var(--red) 80%, var(--text))",
  brightGreen: "color-mix(in srgb, var(--green) 80%, var(--text))",
  brightYellow: "color-mix(in srgb, var(--amber) 80%, var(--text))",
  brightBlue: "color-mix(in srgb, var(--blue) 80%, var(--text))",
  brightMagenta: "color-mix(in srgb, var(--clay) 80%, var(--text))",
  brightCyan: "color-mix(in srgb, color-mix(in srgb, var(--blue) 55%, var(--green)) 80%, var(--text))",
  brightWhite: "var(--text)",
};

/** Computed colours can be rgb(), rgba() or color(srgb …); xterm wants rgba(). */
function toRgba(computed: string) {
  const srgb = /^color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.e-]+))?\)$/.exec(computed);
  if (srgb) {
    const [r, g, b] = srgb.slice(1, 4).map((part) => Math.round(Number(part) * 255));
    return `rgba(${r}, ${g}, ${b}, ${srgb[4] ?? 1})`;
  }
  return computed;
}

function readTheme(host: HTMLElement): ITheme {
  const probe = document.createElement("span");
  probe.style.display = "none";
  host.appendChild(probe);
  const theme: Record<string, string> = {};
  for (const [key, value] of Object.entries(PALETTE)) {
    probe.style.color = "";
    probe.style.color = value;
    theme[key] = toRgba(getComputedStyle(probe).color);
  }
  probe.remove();
  return theme as ITheme;
}

export type TerminalView = {
  write(bytes: Uint8Array | string): void;
  focus(): void;
  fit(): void;
  readonly cols: number;
  readonly rows: number;
  dispose(): void;
};

export async function mountTerminal(
  host: HTMLElement,
  handlers: { onInput: (bytes: Uint8Array) => void; onResize: (cols: number, rows: number) => void },
): Promise<TerminalView> {
  const fontFamily = getComputedStyle(host).fontFamily;
  // xterm measures glyphs once; measure with the real mono face, not its fallback.
  await document.fonts.load(`13px ${fontFamily}`).catch(() => undefined);
  const term = new Terminal({
    fontFamily,
    fontSize: 13,
    lineHeight: 1.25,
    cursorBlink: true,
    cursorStyle: "bar",
    cursorInactiveStyle: "outline",
    scrollback: 5000,
    allowProposedApi: false,
    macOptionIsMeta: true,
    theme: readTheme(host),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  const encoder = new TextEncoder();
  const subscriptions = [
    term.onData((text) => handlers.onInput(encoder.encode(text))),
    term.onBinary((text) => handlers.onInput(Uint8Array.from(text, (char) => char.charCodeAt(0) & 0xff))),
    term.onResize(({ cols, rows }) => handlers.onResize(cols, rows)),
  ];
  const refit = () => {
    // A hidden tab has no size; fitting it would collapse the terminal to its minimum.
    if (host.offsetWidth > 0 && host.offsetHeight > 0) fit.fit();
  };
  refit();
  const sizes = new ResizeObserver(() => refit());
  sizes.observe(host);
  // Follow theme changes (Settings writes data-theme on <html>).
  const themes = new MutationObserver(() => (term.options.theme = readTheme(host)));
  themes.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return {
    write: (bytes) => term.write(bytes),
    focus: () => term.focus(),
    fit: refit,
    get cols() {
      return term.cols;
    },
    get rows() {
      return term.rows;
    },
    dispose() {
      sizes.disconnect();
      themes.disconnect();
      for (const subscription of subscriptions) subscription.dispose();
      term.dispose();
    },
  };
}
