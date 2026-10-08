"""gen-shapes.py: writes tools/matrix/__tests__/fixtures/triage-shapes.json, the real reds the committed triage rules are tested against.

    W1D_DISPATCH=<dir> W1D_TRIAGE_OUT=<dir of out1..out3> python3 gen-shapes.py [out.json]

One real red per committed rule from dispatch 3 (the first it keys, found through that dispatch's own triage.json), the browser
layer's own, and the cases owner ruling 70 names. `expect` is the gap and wave classify.py gives (a cross-check, see its header),
never what the rules say. `pins` (review I1) is what each rule's MECHANISM requires of a red, typed here from the rule's note and
never read off the rule's own match: the twin test perturbs one pinned segment at a time and requires the twin untriaged.
Dispatch 3 is the committed baseline (truth-runs/w1d-baseline/L1, L2, L3); dispatches 1 and 2 reach this script only through the 14 L3 cases
of w1d-baseline/dispatch-cuts.json. tools/matrix/__tests__/w1d-baseline-evidence.test.ts stages that layout (W1D_DISPATCH = <n>/<layer>/results.json,
W1D_TRIAGE_OUT = out3/triage.json from `pnpm matrix:triage` over the committed baseline) and requires the output to equal the committed fixture byte for byte.
"""
import json, os, re, sys
from pathlib import Path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dump import reds
from classify import classify, OUT
WT = str(Path(__file__).resolve().parents[4])
rules = json.load(open(f"{WT}/tools/matrix/catalogue/triage-rules.json"))["rules"]

# Segments a red must carry for the rule's mechanism to be the cause (row, sport, scenario, layer, reason; `failing` = no check
# beyond the mechanism's own fails). Not pinned = the mechanism does not depend on it (a sport-agnostic defect has no sport pin).
def pins_of(rule_id):
    if rule_id.startswith("no-builder-"):
        # D7: the L2 organiser-ui-path red of a cell no builder control builds; the sport is whatever L2 drives (football today).
        scen = [] if rule_id in ("no-builder-knockout-third-place", "no-builder-group-only") else ["scenario"]
        return ["row", "layer", "reason", "failing"] + scen
    if rule_id.startswith(("bg-draw-", "gn-draw-")):
        # boardgame (SC-O1) and generic (SC-O2) draw defects: the sport IS the mechanism. page_playoff_only keeps R4 for FX-G7.
        scen = ["scenario"] if "page-playoff-only" in rule_id else []
        return ["row", "sport", "reason", "failing"] + scen
    return ["row", "scenario", "reason", "failing"]  # a named defect of one format at one scenario, sport-agnostic
shapes = []
seen_ids = set()
def add(n, c, why):
    if c["caseId"] + "@" + c["layer"] in seen_ids: return
    seen_ids.add(c["caseId"] + "@" + c["layer"])
    gap, wave = classify(c)
    rid = re.match(r"rule (\S+)", why).group(1)
    shapes.append({"why": why, "run": n, "layer": c["layer"], "caseId": c["caseId"], "row": c["row"], "sport": c["sport"], "variant": c["variant"], "scenario": c["scenario"],
                   "width": c["width"], "reason": c["reason"], "failing": c["failing"], "pins": pins_of(rid), "expect": {"gap": gap, "wave": wave}})
# one real red per rule, from dispatch 3 (the first it keys), found by the committed triage output
for r in rules:
    for layer in ("L3", "L2", "L1"):
        tri = {x["caseId"]: x for x in json.load(open(f"{OUT}/out3/triage.json"))["rows"]}
        pick = next((c for c in reds(3, layer) if tri.get(c["caseId"], {}).get("rule") == r["id"]), None)
        if pick: add(3, pick, f"rule {r['id']}"); break
    else: raise SystemExit("no case for " + r["id"])
# and the first L1 red each rule keys (the browser layer's own reasons: ui-champion-shown rides beside I2)
tri1 = {x["caseId"]: x for x in json.load(open(f"{OUT}/out3/triage.json"))["rows"]}
done1 = set()
for c in reds(3, "L1"):
    rid = tri1[c["caseId"]]["rule"]
    if rid not in done1: done1.add(rid); add(3, c, f"rule {rid} at L1")
# and the L2 case of each rule that carries an `also`: a hidden D7 failure (organiser-ui-path) rides beside the product mechanism in it
for r in rules:
    if "also" in r:
        pick = next((c for c in reds(3, "L2") if tri1.get(c["caseId"], {}).get("rule") == r["id"]), None)
        assert pick is not None, r["id"]
        add(3, pick, f"rule {r['id']} at L2")
# a case id is one case in a triage, so the SAME case as another dispatch showed it goes in `flips`, triaged by itself
flips = []
want70 = {"swiss_knockout|football|11-a-side|R4", "swiss_knockout|carrom|club-29|R4", "swiss_knockout|generic|score|R4"}
mainids = {(s["caseId"], s["layer"]) for s in shapes}
def flip(n, c, why):
    key = (c["caseId"], c["layer"])
    gap, wave = classify(c)
    flips.append({"why": why, "run": n, "layer": c["layer"], "caseId": c["caseId"], "row": c["row"], "sport": c["sport"], "variant": c["variant"], "scenario": c["scenario"],
                  "width": c["width"], "reason": c["reason"], "failing": c["failing"], "expect": {"gap": gap, "wave": wave}})
for n in (1, 2, 3):
    for c in reds(n, "L3"):
        if c["caseId"] in want70: flip(n, c, "ruling 70")
        elif c["row"] == "swiss_playoff" and c["scenario"] == "R4" and c["sport"] in ("boardgame", "generic"): flip(n, c, "swiss_playoff flips between SW-H1 and the draw stall")
out = sys.argv[1] if len(sys.argv) > 1 else f"{WT}/tools/matrix/__tests__/fixtures/triage-shapes.json"
json.dump({"flips": flips, "note": "Real reds of the third truth-run dispatches (L1, L2, L3), one per committed triage rule, plus the cases owner ruling 70 names and the swiss_playoff cells that flip between two defects across dispatches. `expect` is the gap and wave an independent reading of each case's mechanism gives (W1-driving TRIAGE.md P1-P7 against the audit rows), NOT what the rules say. `pins` (review I1) names the segments a red must carry for its rule's mechanism to be the cause, typed from the mechanism and never read off the rule: the twin test perturbs one pinned segment at a time and requires each twin untriaged. Synthetic ids only.", "shapes": shapes}, open(out, "w"), indent=1, ensure_ascii=False)
open(out, "a").write("\n")
print(len(shapes), "shapes;", len(flips), "flips")
import collections; print(collections.Counter(s['layer'] for s in shapes), collections.Counter((s['expect']['gap']) for s in shapes))
