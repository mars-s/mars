import { createPages } from "./pages.mjs";

// One line per workbench tool. Each lane owns its own module and its own line here.
// A tool is { handle(req, res, url, route, { send, jsonBody }) => Promise<boolean> } plus
// optional helpers the core uses (pages.list(), browser.services()).
export function workbenchTools(options) {
  return {
    files: undefined, // lane: files   -> ./files.mjs
    changes: undefined, // lane: changes -> ./changes.mjs
    pages: createPages(options),
    terminal: undefined, // lane: terminal -> ./terminal.mjs
    browser: undefined, // lane: browser -> ./browser.mjs
  };
}
