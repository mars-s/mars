#!/usr/bin/env python3
"""Rebuild the preview fixture after merging workbench lanes, without hand edits.

Takes the fixture from the merge base side (`git show <base>:PATH`), then splices in
each lane's complete `// workbench lane: <name>` block from its branch, just above the
/api/plugins route, and sets that lane's tools to available in the capabilities
response. Usage: python3 scripts/merge-fixture-lane-blocks.py <base-ref> files changes ...
"""
import re
import subprocess
import sys

PATH = "apps/ui/scripts/preview-pi-fixture.mjs"
ANCHOR = '  if (url.pathname === "/api/plugins")'
# Which capability keys each lane turns on.
FLIPS = {"files": ["files"], "changes": ["changes"], "pages": ["page"], "terminal": ["terminal"], "browser": ["browser"]}


def show(ref):
    return subprocess.run(["git", "show", f"{ref}:{PATH}"], capture_output=True, text=True, check=True).stdout


def block(text, lane):
    start = text.index(f"  // workbench lane: {lane}")
    ends = [i for i in (text.find("  // workbench lane: ", start + 5), text.find(ANCHOR, start)) if i > 0]
    return text[start:min(ends)]


base_ref, lanes = sys.argv[1], sys.argv[2:]
text = show(base_ref)
for lane in lanes:
    lane_text = show(f"codex/wb-{lane}")
    if f"// workbench lane: {lane}" in text:
        text = text.replace(block(text, lane), "")
    text = text.replace(ANCHOR, block(lane_text, lane) + ANCHOR, 1)
    for key in FLIPS[lane]:
        pattern = re.compile(r'(\n\s*"?' + re.escape(key) + r'"?: )\{ available: false, reason: "[^"]*" \}')
        text = pattern.sub(r"\1{ available: true }", text, count=1)
open(PATH, "w").write(text)
print("fixture rebuilt with lanes:", ", ".join(lanes))
