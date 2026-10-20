// Rewrite raw Tailwind palette classes in vendored components to Mars theme tokens.
// Light and dark variants of the same role collapse to one token, because Mars
// tokens already switch per theme. Rerun after scripts/vendor-components.mjs.
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../components/vendor", import.meta.url));

// Shade -> semantic role, read as "how far from the page colour". Light-mode
// classes use the left table, dark-mode (dark:) classes use the right one.
const neutral = {
  light: { white: "bg", 50: "bg", 100: "raised", 200: "border", 300: "input", 400: "faint", 500: "muted", 600: "muted", 700: "fg", 800: "fg", 900: "fg", 950: "fg", black: "fg" },
  dark: { black: "bg", 950: "bg", 900: "raised", 800: "border", 700: "input", 600: "faint", 500: "muted", 400: "muted", 300: "fg", 200: "fg", 100: "fg", 50: "fg", white: "fg" },
};
const roleToken = {
  text: { bg: "background", raised: "muted-foreground", border: "muted-foreground", input: "muted-foreground", faint: "muted-foreground", muted: "muted-foreground", fg: "foreground" },
  surface: { bg: "background", raised: "muted", border: "border", input: "input", faint: "muted-foreground", muted: "muted-foreground", fg: "foreground" },
  line: { bg: "background", raised: "border", border: "border", input: "input", faint: "input", muted: "muted-foreground", fg: "foreground" },
};
const kindOf = { decoration: "line", accent: "text", "ring-offset": "surface", text: "text", placeholder: "text", caret: "text", bg: "surface", from: "surface", via: "surface", to: "surface", fill: "surface", border: "line", ring: "line", divide: "line", outline: "line", stroke: "line", shadow: "line" };
const hues = { red: "destructive", rose: "destructive", emerald: "success", green: "success", lime: "success", teal: "success", blue: "info", sky: "info", cyan: "info", indigo: "info", amber: "warning", yellow: "warning", orange: "clay", violet: "info", purple: "info", fuchsia: "info", pink: "destructive" };

const pattern =
  /(?<![\w-])((?:[a-z-]+:)*)(text|bg|border|ring|ring-offset|fill|stroke|from|to|via|divide|outline|placeholder|caret|shadow|decoration|accent)-(zinc|neutral|gray|slate|stone|white|black|red|rose|emerald|green|lime|teal|blue|sky|cyan|indigo|amber|yellow|orange|violet|purple|fuchsia|pink)(?:-(\d{2,3}))?(\/(?:\[[^\]]+\]|\d+))?(?![\w-])/g;

function replace(_, variants, utility, colour, shade, opacity = "") {
  const isDark = variants.split(":").includes("dark");
  const kind = kindOf[utility];
  let token;
  if (hues[colour]) token = hues[colour];
  else {
    const key = colour === "white" || colour === "black" ? colour : Number(shade);
    const role = neutral[isDark ? "dark" : "light"][key] ?? "muted";
    token = roleToken[kind][role];
  }
  // Accent fills use the readable foreground for their text. A solid primary
  // text on a foreground fill is handled by the inverse rule below.
  return `${variants}${utility}-${token}${opacity}`;
}

let files = 0;
let changes = 0;
function walk(directory) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(tsx|ts)$/.test(name)) {
      const before = readFileSync(path, "utf8");
      let count = 0;
      const after = before.replace(pattern, (...match) => {
        count++;
        return replace(...match);
      });
      if (after !== before) {
        writeFileSync(path, after);
        files++;
        changes += count;
      }
    }
  }
}
walk(root);
console.log(`themed ${changes} classes in ${files} files`);
