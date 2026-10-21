import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const postcss = require("postcss");

// One-off lever that moved the monolithic live-workspace.css into lane-owned files.
const buckets = [
  ["shell", /^\.live-(workspace|sidebar|brand|nav|count|settings-button|connection-dot|main|header|menu|mobile-close|scrim|notice|mobile-nav|conversation-running|subthread)/],
  ["activity", /^\.live-(tool|detail-label|workers?|usage|workflow|activity|agent-activity)/],
  ["composer", /^(\.live-(welcome|composer|mode|model|send|image-draft)|\[data-dragging)/],
  ["thread", /^\.live-(thread|viewport|transcript|message|user|assistant|actions|outcome|working)/],
  ["settings", /^\.live-(settings|account-state|auth-flow|callback|theme-options|connection-details|extensions-page|empty-extensions|extension|plugin|system-plugins)/],
  ["shared", /^\.live-(icon|text-button)/],
];
const targets = {
  shell: "components/shell/shell.css",
  activity: "components/activity/activity.css",
  composer: "components/composer/composer.css",
  thread: "components/thread/thread.css",
  settings: "components/settings/settings.css",
  shared: "components/shared.css",
};
const bucketOf = (selector) => {
  const found = buckets.find(([, pattern]) => pattern.test(selector.trim()));
  if (!found) throw Error(`Unassigned selector: ${selector}`);
  return found[0];
};
const roots = Object.fromEntries(Object.keys(targets).map((name) => [name, postcss.root()]));
function place(rule, wrap) {
  const groups = new Map();
  for (const selector of rule.selectors) {
    const name = bucketOf(selector);
    groups.set(name, [...(groups.get(name) ?? []), selector]);
  }
  for (const [name, selectors] of groups) {
    const copy = rule.clone({ selectors });
    if (!wrap) roots[name].append(copy);
    else {
      let at = roots[name].nodes.find(
        (node) => node.type === "atrule" && node.params === wrap.params && node.name === wrap.name,
      );
      if (!at) roots[name].append((at = wrap.clone({ nodes: [] })));
      at.append(copy);
    }
  }
}
const source = postcss.parse(readFileSync("components/live-workspace.css", "utf8"));
source.each((node) => {
  if (node.type === "rule") place(node);
  else if (node.type === "atrule")
    node.each((child) => {
      if (child.type === "rule") place(child, node);
      else throw Error(`Unexpected nested ${child.type}`);
    });
});
for (const [name, root] of Object.entries(roots)) {
  mkdirSync(dirname(targets[name]), { recursive: true });
  writeFileSync(targets[name], root.toString().trim() + "\n");
}
