"""A second reading of the triage written from W1-driving TRIAGE.md's mechanisms rather than from triage-rules.json: case fields ->
(gap, wave). Review m7 (Task 19): it is a CROSS-CHECK, not independent mechanism evidence. It keys `sport == boardgame` to SC-O1 as the
rules do, so "no disagreement" shows the rules are self-consistent; the mechanism evidence for the L3 SC-O1/O2 reds is W1-driving's
committed truth-runs/w1drv-l3-fr1/draw-counts.json (62 of 62 reds drove at least one drawn bracket fixture).

    W1D_DISPATCH=<dir> W1D_TRIAGE_OUT=<dir of out1..out3> python3 classify.py     (compares every red of the three dispatches)
"""
import json, os, sys, re, collections
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dump import reds
OUT = os.environ.get("W1D_TRIAGE_OUT")
if OUT is None:
    raise SystemExit("set W1D_TRIAGE_OUT to the directory holding out1/, out2/, out3/ (the triage.json of each dispatch)")
def classify(c):
    row, sport, scen, layer, r = c["row"], c["sport"], c["scenario"], c["layer"], c["reason"]
    fail = set(c["failing"])
    # L2: the organiser-ui-path reds by design (D7) when nothing else failed
    api_only = {"knockout_third_place": "W4", "page_playoff_only": "W4", "stepladder_only": "W4", "group_only": "W5", "group_group_ko": "W5"}
    if "SW-H1" in r and row.startswith("swiss_"): return ("SW-H1", "W3")
    if row == "mexicano":
        if scen == "M1": return ("FX-G11", "W7")
        return ("NEW-W1d-1", "W7")
    if row == "americano": return ("NEW-W1d-2", "W7")
    if row == "stepladder_only" and "WRONG_PHASE" in r: return ("NEW-W1d-3", "W4")
    if row == "page_playoff_only" and scen == "R4": return ("FX-G7", "W4")
    if row == "ko_plate" and "STAGE_COMPLETED_SEEDING_FAILED" in r: return ("FX-G14", "W4")
    if row == "group_group_ko" and scen == "F1" and "in no pool" in r: return ("ST-G5", "W5")
    if sport == "boardgame": return ("SC-O1", "W2")
    if sport == "generic" and row in ("group_playoffs", "swiss_playoff", "page_playoff_only"): return ("SC-O2", "W2")
    if layer == "L2" and "no organiser control builds" in r and row in api_only:
        return ("NEW-W1d-4" if api_only[row] == "W4" else "NEW-W1d-5", api_only[row])
    return None
bad = 0; total = 0
for n in (1, 2, 3):
    for layer in ("L1", "L2", "L3"):
        tri = {r["caseId"]: r for r in json.load(open(f"{OUT}/out{n}/triage.json"))["rows"]}
        for c in reds(n, layer):
            total += 1
            want = classify(c)
            got = tri.get(c["caseId"])
            if want is None or got is None or (got["gap"], got["wave"]) != want:
                bad += 1; print("DISAGREE", n, layer, c["caseId"], want, got and (got["gap"], got["wave"]), c["reason"][:100])
print("reds compared:", total, "disagreements:", bad)
