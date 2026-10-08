#!/usr/bin/env python3
"""Derive p-map.json (case id -> W1-driving P-rule) from truth-runs/w1drv-l3/TRIAGE.md's per-case table.

Reads ONLY the table "## Every ❌" rows whose final class is `product` (the 164). A P1..P7 row is keyed by its
P-number; a coverage-table row by CT:<primary signature>. Asserts 164, asserts every key is a case of the keyed
results.json (w1drv-l3), and prints the per-label tally."""
import json, re, sys, collections
from pathlib import Path

# python3 tools/matrix/catalogue/scripts/build-p-map.py [repo] [out.json]    (default: this repo, the committed catalogue/p-map.json)
# The committed p-map.json is rebuilt byte-identical from this script by tools/matrix/__tests__/catalogue-scripts.test.ts.
HERE = Path(__file__).resolve()
REPO = sys.argv[1] if len(sys.argv) > 1 else str(HERE.parents[4])
OUT = sys.argv[2] if len(sys.argv) > 2 else str(HERE.parents[1] / "p-map.json")
TR = f"{REPO}/docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1drv-l3"
text = open(f"{TR}/TRIAGE.md", encoding="utf8").read()
table = text[text.index("## Every ❌"):]
rows = [l for l in table.split("\n") if re.match(r"\| \d+ \|", l)]
assert len(rows) == 194, len(rows)

ROW = re.compile(r"\| (\d+) \| `([^`]+)` \| (.*?) \| (.*?) \| (.*?) \| (.*?) \| (.*?) \| (.*?) \| (.*?) \|$")
CT = [
    ("mexicano-stalled-on-non-decided", "CT:mexicano-stalled-on-non-decided"),
    ("mexicano-pair-entrants-counted-as-players", "CT:mexicano-pair-entrants-counted-as-players"),
    ("r4-withdrawn-player-kept-playing", "CT:r4-withdrawn-player-kept-playing"),
]
pmap = {}
for l in rows:
    m = ROW.match(l)
    assert m, l[:160]
    n, case, failing, was, judged, final, wave, rule, draws = m.groups()
    case = case.replace("\\|", "|")
    if final != "product":
        assert final == "✅ works", (n, final)
        continue
    pm = re.match(r"P(\d) ", rule)
    if pm:
        label = f"P{pm.group(1)}"
    else:
        assert rule.startswith("coverage table (predicted): "), rule[:80]
        sigs = rule[len("coverage table (predicted): "):]
        # the PRIMARY signature is the first one named
        label = next(lab for key, lab in sorted(CT, key=lambda kv: sigs.index(kv[0]) if kv[0] in sigs else 10**9) if key in sigs)
    assert case not in pmap, case
    pmap[case] = label

assert len(pmap) == 164, len(pmap)
results = json.load(open(f"{TR}/results.json"))
state = {c["caseId"]: c["state"] for c in results["cases"]}
for k in pmap:
    assert k in state, f"{k} is not a case of the keyed results"
tally = collections.Counter(pmap.values())
print(dict(sorted(tally.items())))
print("keyed results states of the 164:", dict(collections.Counter(state[k] for k in pmap)))
reds = [c["caseId"] for c in results["cases"] if c["state"] == "red"]
print("keyed results reds:", len(reds), " not in map:", len([r for r in reds if r not in pmap]))
json.dump(dict(sorted(pmap.items())), open(OUT, "w"), indent=2, ensure_ascii=False)
open(OUT, "a").write("\n")
