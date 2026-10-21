import { plugin as shadcn } from "@shadcn/lint";
import parser from "@typescript-eslint/parser";
import hooks from "eslint-plugin-react-hooks";

export default [
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      ".next-build/**",
      "test-results/**",
      "playwright-report/**",
    ],
  },
  {
    files: ["app/**/*.{ts,tsx}", "components/**/*.{ts,tsx}", "lib/**/*.{ts,tsx}"],
    languageOptions: { parser },
    plugins: { shadcn, "react-hooks": hooks },
    settings: { shadcn: { ui: "@/components/ui" } },
    rules: {
      "shadcn/no-arbitrary-values": "error",
      "shadcn/no-raw-colors": "error",
    },
  },
  {
    // Source-owned upstream primitives contain deliberate geometry and motion
    // classes. Product components above still enforce semantic design tokens.
    files: ["components/ui/**/*.{ts,tsx}", "components/react-bits/**/*.{ts,tsx}"],
    rules: { "shadcn/no-arbitrary-values": "off" },
    linterOptions: { reportUnusedDisableDirectives: "off" },
  },
  {
    // Vendored registry source keeps its upstream geometry. scripts/theme-vendor.mjs
    // maps its palette to Mars tokens; agent-elements declares its an-* colours in
    // agent-ui.css, which this rule cannot see.
    files: ["components/vendor/**/*.{ts,tsx}"],
    rules: { "shadcn/no-arbitrary-values": "off", "shadcn/no-raw-colors": "off" },
    linterOptions: { reportUnusedDisableDirectives: "off" },
  },
];
