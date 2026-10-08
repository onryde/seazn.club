#!/usr/bin/env python3
"""gen-rules.py: writes tools/matrix/catalogue/triage-rules.json (W1d Task 19, ruling 63).

    python3 tools/matrix/catalogue/scripts/gen-rules.py [out.json]      (default: the committed file, in place)

The rules are keyed by cell + scenario + the reason text of the failing check (never by a check id alone), and each carries
a CLOSED set of the checks it may see failing (`failing`, review m1): a red that fails any other check is untriaged, so a
second unrelated failure cannot ride inside a keyed red. `also` names a failing check that belongs to ANOTHER gap (the
organiser-ui-path reds of an L2 case whose cell no builder control builds, D7): the row stays keyed to the product gap and
the triage lists the case under the other gap too. `was` is the W1-driving P-rule the rule re-keys, or null with `wasWhy`.

FAILING is the union of the failing checks of every red a rule keys over the three baseline dispatches (L1, L2, L3), taken
from their results.json; this script cannot recompute it from the repo (the dispatch results are committed by Task 21).
The committed file is rebuilt byte-identical from this script by tools/matrix/__tests__/catalogue-scripts.test.ts, so a
hand edit of triage-rules.json without an edit here fails that test. Every rule is re-judged by `pnpm matrix:triage`
against the real runs.
"""
import json, sys
from pathlib import Path

CATALOGUE = Path(__file__).resolve().parents[1]
out = sys.argv[1] if len(sys.argv) > 1 else str(CATALOGUE / "triage-rules.json")
rules = []
UNSET = object()
FAILING = {
    "americano-withdrawn-keeps-playing": ["r4-not-seated-later", "r4-policy-reported"],
    "bg-draw-final-group-stepladder": ["I2-bracket-one-champion-ranks-permutation"],
    "bg-draw-final-groups-ko": ["I2-bracket-one-champion-ranks-permutation", "ui-champion-shown"],
    "bg-draw-final-league-ko": ["I2-bracket-one-champion-ranks-permutation"],
    "bg-draw-final-swiss-knockout": ["I2-bracket-one-champion-ranks-permutation"],
    "bg-draw-stall-double-elim": ["I4-nothing-ends-stuck", "life-loop-bounded"],
    "bg-draw-stall-group-group-ko": ["I4-nothing-ends-stuck", "life-loop-bounded"],
    "bg-draw-stall-group-playoffs": ["I4-nothing-ends-stuck", "life-loop-bounded"],
    "bg-draw-stall-group-stepladder": ["I4-nothing-ends-stuck", "life-loop-bounded"],
    "bg-draw-stall-groups-ko": ["I4-nothing-ends-stuck", "life-loop-bounded"],
    "bg-draw-stall-knockout": ["I4-nothing-ends-stuck", "life-loop-bounded"],
    "bg-draw-stall-knockout-third-place": ["I4-nothing-ends-stuck", "life-loop-bounded"],
    "bg-draw-stall-ko-plate": ["I4-nothing-ends-stuck", "life-loop-bounded"],
    "bg-draw-stall-league-ko": ["I4-nothing-ends-stuck", "life-loop-bounded"],
    "bg-draw-stall-page-playoff-only-lifecycle": ["I4-nothing-ends-stuck", "life-loop-bounded"],
    "bg-draw-stall-page-playoff-only-m1": ["I4-nothing-ends-stuck", "life-loop-bounded"],
    "bg-draw-stall-qualifying-main": ["I4-nothing-ends-stuck", "life-loop-bounded"],
    "bg-draw-stall-stepladder-only": ["I4-nothing-ends-stuck", "life-loop-bounded", "m1-walkover-recorded", "m1-winner-progresses"],
    "bg-draw-stall-swiss-knockout": ["I4-nothing-ends-stuck", "life-loop-bounded"],
    "bg-draw-stall-swiss-playoff": ["I4-nothing-ends-stuck", "life-loop-bounded"],
    "gn-draw-final-page-playoff-only-m1": ["I2-bracket-one-champion-ranks-permutation"],
    "gn-draw-stall-group-playoffs": ["I4-nothing-ends-stuck", "life-loop-bounded"],
    "gn-draw-stall-page-playoff-only-lifecycle": ["I4-nothing-ends-stuck", "life-loop-bounded"],
    "gn-draw-stall-swiss-playoff": ["I4-nothing-ends-stuck", "life-loop-bounded"],
    "group-pool-membership-from-results": ["I1-rr-pair-once-per-leg", "I4-nothing-ends-stuck", "advance-seeded-as-declared", "f1-everyone-drawn", "life-built-as-posted", "life-loop-bounded", "organiser-ui-path", "ui-standings-match"],
    "ko-plate-seeding-failed": ["I4-nothing-ends-stuck", "advance-seeded-as-declared", "life-loop-bounded"],
    "mexicano-pair-entrants-f1": ["I10-americano-seats-each-person-once", "I4-nothing-ends-stuck", "I8-generate-named", "f1-everyone-drawn", "f1-round-size", "life-built-as-posted", "life-loop-bounded"],
    "mexicano-pair-entrants-lifecycle": ["I10-americano-seats-each-person-once", "I4-nothing-ends-stuck", "I8-generate-named", "life-draw-path-exercised", "life-loop-bounded"],
    "mexicano-pair-entrants-r4-reseated": ["I10-americano-seats-each-person-once", "r4-not-seated-later"],
    "mexicano-pair-entrants-r4-self-pair": ["I10-americano-seats-each-person-once", "I4-nothing-ends-stuck", "I8-generate-named", "life-loop-bounded"],
    "mexicano-stalled-on-forfeit": ["life-loop-bounded"],
    "no-builder-group-group-ko-m1": ["organiser-ui-path"],
    "no-builder-group-group-ko-r4": ["organiser-ui-path"],
    "no-builder-group-only": ["organiser-ui-path"],
    "no-builder-knockout-third-place": ["organiser-ui-path"],
    "no-builder-page-playoff-only-m1": ["organiser-ui-path"],
    "no-builder-stepladder-only-f1": ["organiser-ui-path"],
    "no-builder-stepladder-only-m1": ["organiser-ui-path"],
    "page-playoff-withdraw-voids": ["I4-nothing-ends-stuck", "life-loop-bounded", "organiser-ui-path"],
    "stepladder-withdraw-wrong-phase": ["organiser-ui-path"],
    "swiss-round-paired-nobody-swiss-knockout": ["I4-nothing-ends-stuck", "life-loop-bounded"],
    "swiss-round-paired-nobody-swiss-playoff": ["I4-nothing-ends-stuck", "life-loop-bounded"],
}
used = set()
UI_ALSO_W4 = {"check": "organiser-ui-path", "gap": "NEW-W1d-4", "wave": "W4"}  # an L2 case of a cell no builder control builds (D7)
UI_ALSO_W5 = {"check": "organiser-ui-path", "gap": "NEW-W1d-5", "wave": "W5"}
NB_WHY = "W1-driving (L3, and the L1 HTTP slice) had no organiser UI path: this by-design L2 red (D7) has no P-rule to re-key"


def rule(id, gap, wave, note, cell=None, scenario=None, layer=None, check=None, reason=None, was=UNSET, wasWhy=None, also=None):
    assert was is not UNSET, f"{id}: say the P-rule it re-keys, or was=None with wasWhy"
    assert (was is None) == (wasWhy is not None), f"{id}: wasWhy goes with a null was and only then"
    assert id in FAILING and id not in used, id
    used.add(id)
    m = {k: v for k, v in (("cell", cell), ("scenario", scenario), ("layer", layer), ("check", check), ("reason", reason)) if v is not None}
    m["failing"] = FAILING[id]
    r = {"id": id, "match": m, "gap": gap, "wave": wave, "was": was}
    if wasWhy is not None: r["wasWhy"] = wasWhy
    if also is not None:
        r["also"] = also
        for a in also: assert a["check"] in FAILING[id], (id, a)
    r["note"] = note
    rules.append(r)

STALL = "and named no reason"
# --- SC-O1 / SC-O2 (W2): a drawn bracket fixture never advances -------------------------------------------------------------------
BG_NOTE = "boardgame's supportsDraws is true on every bracket kind, so a drawn bracket game is accepted and the next round is never seated: the stage never completes. The stall shape: I4 'did not complete ... and named no reason'."
for row in ["double_elim", "group_group_ko", "group_playoffs", "group_stepladder", "groups_ko", "knockout", "knockout_third_place", "ko_plate", "league_ko", "qualifying_main", "stepladder_only", "swiss_knockout", "swiss_playoff"]:
    rule(f"bg-draw-stall-{row.replace('_', '-')}", "SC-O1", "W2", BG_NOTE, cell=f"{row}|boardgame", reason=STALL, was="P1")
for scen in ("LIFECYCLE", "M1"):
    rule(f"bg-draw-stall-page-playoff-only-{scen.lower()}", "SC-O1", "W2", BG_NOTE + " page_playoff_only R4 is another defect (FX-G7), so the rule names the scenarios.", cell="page_playoff_only|boardgame", scenario=scen, reason=STALL, was="P1")
FIN = "The stage completed over a drawn final: I2 fails, I4 and the loop pass."
for row in ["league_ko", "groups_ko", "swiss_knockout"]:
    rule(f"bg-draw-final-{row.replace('_', '-')}", "SC-O1", "W2", "boardgame: " + FIN + " 'bracket fixture ended draw'.", cell=f"{row}|boardgame", reason="ended draw", was="P1")
rule("bg-draw-final-group-stepladder", "SC-O1", "W2", "boardgame: " + FIN + " 'no decided fixture carries a terminal final key (sl-g2)': the drawn game is the final.", cell="group_stepladder|boardgame", reason="carries a terminal final key", was="P1")
GN_NOTE = "generic's supportsDraws is a deny-list that omits page_playoff (generic.ts:650-653), so a drawn page-playoff game is accepted and the final is never seated."
for row in ["group_playoffs", "swiss_playoff"]:
    rule(f"gn-draw-stall-{row.replace('_', '-')}", "SC-O2", "W2", GN_NOTE + " The stall shape.", cell=f"{row}|generic", reason=STALL, was="P1")
rule("gn-draw-stall-page-playoff-only-lifecycle", "SC-O2", "W2", GN_NOTE + " The stall shape.", cell="page_playoff_only|generic", scenario="LIFECYCLE", reason=STALL, was="P1")
rule("gn-draw-final-page-playoff-only-m1", "SC-O2", "W2", GN_NOTE + " Here the stage completed with pp-final the drawn game: I2 'no decided fixture carries a terminal final key (pp-final)'.", cell="page_playoff_only|generic", scenario="M1", reason="carries a terminal final key", was="P1")
# --- FX-G7 (W4): withdrawal voids a page playoff ------------------------------------------------------------------------------------
rule("page-playoff-withdraw-voids", "FX-G7", "W4", "R4 withdraws seed 3 from a page playoff: withdrawal.ts sends page_playoff down the open-format void branch, pp-q2 ends abandoned and pp-final stays scheduled with a TBD side, so the stage never completes (the audit inferred the cascade hands walkovers onward; the live run shows the final never seated).", cell="page_playoff_only|*", scenario="R4", reason=STALL, was="P4", also=[UI_ALSO_W4])
# --- FX-G14 (W4): ko_plate F1 ---------------------------------------------------------------------------------------------------------
rule("ko-plate-seeding-failed", "FX-G14", "W4", "The run shows the wrapper code only: 409 STAGE_COMPLETED_SEEDING_FAILED after stage 1 committed, stage 2 never seeded (wrapper code seen: apps/web/src/server/usecases/stages.ts:4239-4253 wraps any computeSeedProposal error). The inner cause is derived from the code, not observed: the plate takes roundLosers(round 1, q) (apps/web/src/lib/format-templates.ts:270-283); with 7 entrants round 1 has a bye, so fewer losers than q, and loserAt throws QUALIFICATION_INVALID (packages/engine/src/competition/progression.ts:577-596).", cell="ko_plate|*", scenario="F1", reason="STAGE_COMPLETED_SEEDING_FAILED", was="P2")
# --- SW-H1 (W3): swiss round paired nobody (the owner's ruling 70 lots cells included) ------------------------------------------------
SW_NOTE = "A swiss round's Generate answers success and pairs nobody (SW-H1: pairRound has no look-ahead and dead-ends, swissGen seats zero boards and raises no error). Intermittent per run: the three cells owner ruling 70 names (swiss_knockout football, carrom, generic R4) flip red/green between dispatches because the product's lots tie-break hashes per-run entrant ids; they are SW-H1 whenever red."
for row in ["swiss_knockout", "swiss_playoff"]:
    rule(f"swiss-round-paired-nobody-{row.replace('_', '-')}", "SW-H1", "W3", SW_NOTE, cell=f"{row}|*", scenario="R4", reason="paired nobody (SW-H1)", was="P6")
# --- FX-G11 (W7): mexicano stalls on a non-decided fixture ----------------------------------------------------------------------------
rule("mexicano-stalled-on-forfeit", "FX-G11", "W7", "M1 records a walkover: the next mexicano round is generated only when EVERY fixture is decided, so the forfeited one blocks it and the loop exits stalled_rounds.", cell="mexicano|*", scenario="M1", reason="stalled_rounds", was="CT:mexicano-stalled-on-non-decided")
# --- NEW-W1d-1 (W7): mexicano counts pair entrants as players -------------------------------------------------------------------------
MX = "Mexicano counts the pair entrants it made as players: round 2+ sizes over them, the Generate pairs a pair entrant with itself (500 INTERNAL) or seats one person twice."
rule("mexicano-pair-entrants-lifecycle", "NEW-W1d-1", "W7", MX, cell="mexicano|*", scenario="LIFECYCLE", reason="generate answered 500 INTERNAL", was="CT:mexicano-pair-entrants-counted-as-players")
rule("mexicano-pair-entrants-f1", "NEW-W1d-1", "W7", MX + " F1: the consequences (round size, everyone drawn, built as posted) beside the self-pair 500.", cell="mexicano|*", scenario="F1", reason="generate answered 500 INTERNAL", was="P7")
rule("mexicano-pair-entrants-r4-self-pair", "NEW-W1d-1", "W7", MX + " R4, the self-pair 500 shape. Which round it fires in differs per run (the failing set moves), so the rule keys the 500, not the set.", cell="mexicano|*", scenario="R4", reason="generate answered 500 INTERNAL", was="CT:mexicano-pair-entrants-counted-as-players")
rule("mexicano-pair-entrants-r4-reseated", "NEW-W1d-1", "W7", MX + " R4, the shape where the withdrawn person is seated again through another pair entrant (r4-not-seated-later) with no 500.", cell="mexicano|*", scenario="R4", reason="r4-not-seated-later:", was=None,
     wasWhy="its three W1-driving cases carry two labels in the map (CT:mexicano-pair-entrants-counted-as-players x2, P7 x1), and a rule has one `was`")
# --- NEW-W1d-2 (W7): americano R4, the withdrawn player keeps playing -------------------------------------------------------------------
rule("americano-withdrawn-keeps-playing", "NEW-W1d-2", "W7", "R4 withdraws seed 3 from an americano: the product does nothing with the pending games (policy none, none voided or walked over) and the withdrawn person is seated again in later rounds.", cell="americano|*", scenario="R4", reason="policy none, expected walkover", was="CT:r4-withdrawn-player-kept-playing")
# --- NEW-W1d-3 (W4): stepladder R4 withdraw refused ---------------------------------------------------------------------------------
rule("stepladder-withdraw-wrong-phase", "NEW-W1d-3", "W4", "R4 withdraws seed 3 from a stepladder: POST /entrants/:id/withdraw answers 422 WRONG_PHASE 'fixture has an unassigned entrant (bye/TBD)' (every stepladder game but the first has a TBD side) and the scenario never reaches its checks.", cell="stepladder_only|*", scenario="R4", reason="WRONG_PHASE", was="P5", also=[UI_ALSO_W4])
# --- ST-G5 (W5): a pool's members are the entrants with a result, so a pool of one is empty ------------------------------------------
rule("group-pool-membership-from-results", "ST-G5", "W5", "ST-G5's mechanism in its worst shape: a pool's members are the entrants with a result or award (entrantsOfPool, stage.ts), so 7 entrants snaked into 4 pools leave pool A holding seed 1 alone, with no fixture and so no member. Its table is empty, seed 1 stands in no pool (I1 'in no pool', f1-everyone-drawn, life-built-as-posted), and stage 1's /complete answers 409 STAGE_COMPLETED_SEEDING_FAILED. The audit's own shape is the day-one table (a seated member who has not played is missing).", cell="group_group_ko|*", scenario="F1", reason="in no pool", was="P3", also=[UI_ALSO_W5])
# --- the organiser-ui-path reds of L2 (D7: by design, owed by the wave that owns the control) -------------------------------------
UI4 = "D7: no division-builder control builds this API-only row, so L2 reds organiser-ui-path by design; the wave that owns the row owes the control."
UI = lambda row, scen: dict(cell=f"{row}|football", layer="L2", scenario=scen, reason=f"no organiser control builds {row}")
rule("no-builder-knockout-third-place", "NEW-W1d-4", "W4", UI4, **{**UI("knockout_third_place", None), "scenario": None}, was=None, wasWhy=NB_WHY)
for scen in ("F1", "M1"):
    rule(f"no-builder-stepladder-only-{scen.lower()}", "NEW-W1d-4", "W4", UI4 + " R4 is the stepladder withdraw refusal (NEW-W1d-3) and keys there.", **UI("stepladder_only", scen), was=None, wasWhy=NB_WHY)
rule("no-builder-page-playoff-only-m1", "NEW-W1d-4", "W4", UI4 + " R4 is the page-playoff withdrawal (FX-G7) and keys there.", **UI("page_playoff_only", "M1"), was=None, wasWhy=NB_WHY)
rule("no-builder-group-only", "NEW-W1d-5", "W5", UI4, **{**UI("group_only", None), "scenario": None}, was=None, wasWhy=NB_WHY)
for scen in ("M1", "R4"):
    rule(f"no-builder-group-group-ko-{scen.lower()}", "NEW-W1d-5", "W5", UI4 + " F1 is the pool membership defect (ST-G5) and keys there.", **UI("group_group_ko", scen), was=None, wasWhy=NB_WHY)
assert used == set(FAILING), sorted(set(FAILING) ^ used)
json.dump({"rules": rules}, open(out, "w"), indent=2, ensure_ascii=False)
open(out, "a").write("\n")
print(len(rules), "rules")
