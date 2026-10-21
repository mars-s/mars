#!/usr/bin/env python3
"""Prove each merged lane's fixture route block equals the block on its lane branch.

Usage: python3 scripts/check-fixture-lane-blocks.py files changes ...
Exit 1 on any difference, so a merge cannot silently drop or mangle a lane's routes.
"""
import subprocess
import sys

PATH = "apps/ui/scripts/preview-pi-fixture.mjs"


def block(text, lane):
    start = text.index(f"// workbench lane: {lane}")
    ends = [i for i in (text.find("// workbench lane: ", start + 5), text.find('if (url.pathname === "/api/plugins")', start)) if i > 0]
    return text[start:min(ends)].rstrip()


merged = open(PATH).read()
failed = False
for lane in sys.argv[1:]:
    original = subprocess.run(["git", "show", f"codex/wb-{lane}:{PATH}"], capture_output=True, text=True, check=True).stdout
    same = block(original, lane) == block(merged, lane)
    failed |= not same
    print(f"{lane}: {'identical' if same else 'DIFFERS'}")
sys.exit(1 if failed else 0)
