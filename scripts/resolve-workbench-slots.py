#!/usr/bin/env python3
"""Resolve merge conflicts in the workbench slot files by keeping every lane's additions.

Lanes each fill their own slot in the same files (docs: .agents/lanes/workbench/COMMON.md),
so a merge conflicts on neighbouring lines. For each conflict hunk this keeps the union:
a filled slot beats its `undefined`/comment placeholder, capability flips keep
`available: true`, the package.json test scripts get both test files, and the fixture
keeps both lanes' route blocks. Anything it cannot classify is left conflicted.
"""
import json
import re
import sys
from pathlib import Path

HUNK = re.compile(r"<<<<<<< [^\n]*\n(.*?)=======\n(.*?)>>>>>>> [^\n]*\n", re.S)


def slot_key(line):
    s = line.strip()
    m = re.match(r'"?([a-z-]+)"?\s*:', s)  # tools.mjs entries, capability flips
    if m:
        return m.group(1)
    m = re.match(r"// lane: (\w+)", s)
    if m:
        return {"page": "pages"}.get(m.group(1), m.group(1))
    m = re.match(r'case "([a-z-]+)":', s)
    if m:
        return {"page": "pages"}.get(m.group(1), m.group(1))
    return None


def filled(line):
    return "undefined" not in line and "lane:" not in line and "not built yet" not in line


def merge_lines(ours, theirs):
    """Union of two slot hunks: keep imports from both, and per slot the filled variant."""
    out = []
    seen = set()
    for side in (ours, theirs):
        for line in side:
            if line.startswith("import ") and line not in seen:
                out.append(line)
                seen.add(line)
    if out and all(line.startswith("import ") for line in ours + theirs):
        return out
    # Group non-import lines into slot units (a case plus its return line stays together).
    def units(lines):
        result, current = [], []
        for line in lines:
            if line.startswith("import "):
                continue
            if slot_key(line) and current:
                result.append(current)
                current = []
            current.append(line)
        if current:
            result.append(current)
        return result

    order, best = [], {}
    for unit in units(ours) + units(theirs):
        key = slot_key(unit[0]) or unit[0]
        if key not in best:
            order.append(key)
            best[key] = unit
        elif all(filled(line) for line in unit) and not all(filled(line) for line in best[key]):
            best[key] = unit
    return out + [line for key in order for line in best[key]]


def resolve_text(text):
    def repl(match):
        ours = match.group(1).splitlines(keepends=True)
        theirs = match.group(2).splitlines(keepends=True)
        if any(l.lstrip().startswith("// workbench lane:") for l in ours + theirs):
            # Fixture route blocks: keep both. A block's trailing lines can fall into git's
            # common suffix, so each side must stay a complete block; verify with node --check.
            return "".join(ours + theirs)
        return "".join(merge_lines(ours, theirs))

    return HUNK.sub(repl, text)


def resolve_package(path):
    text = path.read_text()
    ours = HUNK.sub(lambda m: m.group(1), text)
    theirs = HUNK.sub(lambda m: m.group(2), text)
    a, b = json.loads(ours), json.loads(theirs)
    for key in ("test", "test:ui"):
        sep = " " if key == "test" else " && "
        parts_a = a["scripts"][key].split(sep)
        for part in b["scripts"][key].split(sep):
            if part not in parts_a:
                parts_a.append(part)
        a["scripts"][key] = sep.join(parts_a)
    for field in ("dependencies", "devDependencies"):
        a.setdefault(field, {}).update(b.get(field, {}))
        a[field] = dict(sorted(a[field].items()))
    path.write_text(json.dumps(a, indent=2) + "\n")


for name in sys.argv[1:]:
    path = Path(name)
    if path.name == "package.json":
        resolve_package(path)
    else:
        path.write_text(resolve_text(path.read_text()))
    left = "<<<<<<<" in path.read_text()
    print(("UNRESOLVED " if left else "resolved ") + name)
