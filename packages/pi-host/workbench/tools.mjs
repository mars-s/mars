import { createFiles } from "./files.mjs";
import { createChanges } from "./changes.mjs";
import { createPages } from "./pages.mjs";
import { createTerminal } from "./terminal.mjs";

// One line per workbench tool. Each lane owns its own module and its own line here.
// A tool is { handle(req, res, url, route, { send, jsonBody }) => Promise<boolean> } plus
// optional helpers the core uses (pages.list(), browser.services()).
export function workbenchTools(options) {
  return {
    files: createFiles(options),
    changes: createChanges(options),
    pages: createPages(options),
    terminal: createTerminal(options),
    browser: undefined, // lane: browser -> ./browser.mjs
  };
}
