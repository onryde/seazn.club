#!/usr/bin/env python3
"""gen-routing.py: emit tools/matrix/catalogue/gap-routing.json from design section 8 (read by a SECOND implementation of the
shorthand expansion, in python) plus the hand-written table for the 48 gaps the design does not list.

    python3 tools/matrix/catalogue/scripts/gen-routing.py [repo] [out.json]     (default: this repo, the committed file)

The committed test (gap-routing.test.ts) re-derives every wave from the design with its own TypeScript oracle, and
catalogue-scripts.test.ts rebuilds the committed file from this script byte for byte."""
import json, re, sys
from pathlib import Path
HERE = Path(__file__).resolve()
REPO = sys.argv[1] if len(sys.argv) > 1 else str(HERE.parents[4])
OUT = sys.argv[2] if len(sys.argv) > 2 else str(HERE.parents[1] / "gap-routing.json")
design = open(f"{REPO}/docs/superpowers/specs/2026-09-27-format-matrix-design.md", encoding="utf8").read().split("\n")
start = next(i for i, l in enumerate(design) if re.match(r"^## 8\. Waves\s*$", l))
rows = []
for i in range(start + 1, len(design)):
    if design[i].startswith("## "): break
    m = re.match(r"^\| \*\*(W\d+[a-z]?)\b", design[i])
    if m: rows.append((i + 1, m.group(1), [c.strip() for c in design[i].split("|")[1:-1]][2]))

# the universe: the audit ids, read from the audit files' own tables by a plain regex over the table rows of the gap sections
import glob, os
universe = []
for fn in sorted(glob.glob(f"{REPO}/docs/superpowers/specs/2026-09-27-format-matrix-prompts/audit-2026-09-27/??-*.md")):
    pref = os.path.basename(fn)[:2]
    sec = False
    for l in open(fn, encoding="utf8").read().split("\n"):
        h = re.match(r"^(#{1,6})\s+(?:\(\d+\)|\d+\.)?\s*(.*?)\s*$", l)
        if h:
            if re.match(r"(?i)^(gaps?( table)?|cross-cutting gaps)\b", h.group(2)) and len(h.group(1)) >= 2: sec = True
            elif sec: sec = False
            continue
        if sec and l.startswith("|"):
            c0 = [x.strip() for x in l.strip().strip("|").split("|")][0]
            m = re.match(r"^([A-Z]+\d+)(?: \(new\)| \(=[A-Z0-9+]+\))?$", c0)
            if m: universe.append(f"{pref}-{m.group(1)}")
assert len(universe) == 152, len(universe)

TOK = re.compile(r"\b(SC|ST|FX|SW|SH)-([A-Z]?)(?:(\d+)(?:–[A-Z]?(\d+))?|\*)((?:/(?:(?:SC|ST|FX|SW|SH)-)?[A-Z]\d+)*)")
exact_rows, wild_rows = {}, {}
for line, wave, carries in rows:
    for m in TOK.finditer(carries):
        prefix, letter, a, b, tail = m.groups()
        if a is None:
            wild_rows[f"{prefix}-{letter}"] = (wave, line)
        else:
            for n in range(int(a), int(b or a) + 1): exact_rows[f"{prefix}-{letter}{n}"] = (wave, line)
        for t in [x for x in (tail or "").split("/") if x]:
            mm = re.match(r"^(?:(SC|ST|FX|SW|SH)-)?([A-Z])(\d+)$", t)
            exact_rows[f"{mm.group(1) or prefix}-{mm.group(2)}{mm.group(3)}"] = (wave, line)

routes, basis = {}, {}
def add(key, wave, b):
    assert key not in routes, key
    routes[key] = wave; basis[key] = b
# listed ids: exact tokens, then the id-by-id expansion of the partial wildcard SC-S*
by_name = dict(exact_rows)
for p, (wave, line) in wild_rows.items():
    if len(p) > 3:
        for u in universe:
            if u.startswith(p): by_name.setdefault(u, (wave, line))
for k in sorted(by_name, key=lambda k: (["SC", "FX", "ST", "SW", "SH"].index(k[:2]), k[3], int(k[4:]))):
    if k in universe: add(k, by_name[k][0], f"D:{by_name[k][1]}")
for p in sorted(wild_rows):
    if len(p) == 3: add(f"{p}*", wild_rows[p][0], f"D:{wild_rows[p][1]}")

# the 48 the design does not list: wave owning their format/sport, each citing the design line and a word that line says
L = {w: l for l, w, _ in rows}
UNLISTED = [
    # FX
    ("FX-G12", "W7", "americano"), ("FX-G15", "W5", "league"), ("FX-G17", "W4", "knockout"), ("FX-G18", "W4", "knockout"),
    ("FX-G19", "W5", "group"), ("FX-G20", "W10", "unrelated"), ("FX-G21", "W5", "league"), ("FX-G22", "W5", "group"),
    ("FX-G24", "W6", "double_elim"),
    # ST
    ("ST-G8", "W2", "points"), ("ST-G9", "W2", "points"), ("ST-G11", "W2", "tiebreak"), ("ST-G12", "W5", "group"),
    ("ST-G17", "W5", "group"), ("ST-G18", "W4", "knockout"), ("ST-G19", "W7", "ladder"), ("ST-G25", "W10", "unrelated"),
    ("ST-G27", "W10", "unrelated"), ("ST-G28", "W5", "group"), ("ST-G29", "W2", "sport"), ("ST-G30", "W7", "americano"),
    ("ST-G31", "W2", "sport"), ("ST-G32", "W2", "sport"), ("ST-G33", "W6", "double_elim"),
] + [(f"SC-{x}", "W2", "sport scoring") for x in ("P3", "P5", "P6", "P7", "P8", "P9", "P10", "P12", "P13", "C1", "C2", "C4", "C5", "C6", "C7", "C8", "O3", "O4", "O5", "O6", "O9", "O10", "O11", "O12")]
assert len(UNLISTED) == 48, len(UNLISTED)
for k, wave, word in UNLISTED:
    assert k in universe and k not in by_name and f"{k[:3]}" and k not in routes, k
    add(k, wave, f"scope:D:{L[wave]}:{word}")
assert len(routes) == 109, len(routes)

def order(k):
    return (["SC", "FX", "ST", "SW", "SH"].index(k[:2]), 0 if k.endswith("*") is False else 1, k)
keys = sorted(routes, key=lambda k: (["SC", "FX", "ST", "SW", "SH"].index(k[:2]), k.endswith("*"), (k[3:4], int(re.sub(r"\D", "", k[4:]) or 0)) if not k.endswith("*") else ("", 0)))
out = {
    "note": "design 2026-09-27-format-matrix-design.md section 8 (D:446-460), transcribed id by id; `basis` cites the design row (1-based line) that lists each id, or, for a gap section 8 does not list, the row whose wave scope owns its format or sport (\"gaps not listed go to the wave owning their format/sport\") and a word that row says. gap-routing.test.ts re-derives every route from the design's own text. A reviewed change",
    "routes": {k: routes[k] for k in keys},
    "basis": {k: basis[k] for k in keys},
}
json.dump(out, open(OUT, "w"), indent=2, ensure_ascii=False)
open(OUT, "a").write("\n")
from collections import Counter
print(Counter(routes.values()))
