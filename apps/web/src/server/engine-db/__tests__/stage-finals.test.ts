// W4 T21 (AN-1, X-CH-8): "this bracket has nothing left to play and only waits for Complete stage" — the read the
// desk's red `final_decided` row and the settings warning both ask, of plain fixture rows. "Settled" is the engine's
// (`SETTLED_FIXTURE_STATUSES` over the completion readers' `completionEngineStatus`), and "nothing else owed" is what
// auto-advance waits for, so the row never asks for a completion auto-advance would not have made. Pure: no database.
import { describe, expect, it } from "vitest";
import { BRACKET_KINDS } from "@/server/engine-db/competition";
import {
  bracketAwaitsCompletion, openStageState, unsettledCount, type OpenStageFixtureRow, type StageFinalsRow,
} from "@/server/engine-db/stage-finals";
import { OPEN_STAGE_STATES } from "@/lib/open-stages";

const row = (o: Partial<StageFinalsRow> = {}): StageFinalsRow => ({
  status: "scheduled", outcome: null, has_active_abandon: false, expunged: false, no_result: false, ...o,
});
const won = (o: Partial<StageFinalsRow> = {}) => row({ status: "decided", outcome: { kind: "win", winner: "a", loser: "b" }, ...o });
/** A knockout of four: two decided semis and the final. */
const four = (final: Partial<StageFinalsRow>, extra: StageFinalsRow[] = []) => [won(), won(), row(final), ...extra];

describe("bracketAwaitsCompletion (W4 T21)", () => {
  it("empty case first: no rows, and a table stage however played, never await a bracket completion", () => {
    expect(bracketAwaitsCompletion("knockout", [])).toBe(false);
    expect(bracketAwaitsCompletion("league", [won(), won()])).toBe(false);
    expect(bracketAwaitsCompletion("swiss", [won()])).toBe(false);
  });

  it("a knockout whose final is decided and nothing else is owed: true; the final unplayed or in play: false", () => {
    expect(bracketAwaitsCompletion("knockout", four({ status: "decided", outcome: { kind: "win", winner: "a", loser: "c" } }))).toBe(true);
    expect(bracketAwaitsCompletion("knockout", four({ status: "scheduled" })), "semis decided, final unplayed").toBe(false);
    expect(bracketAwaitsCompletion("knockout", four({ status: "in_play" }))).toBe(false);
  });

  it("the final walked over (forfeited) or locked (finalized) is settled too", () => {
    expect(bracketAwaitsCompletion("knockout", four({ status: "forfeited", outcome: { kind: "award", winner: "a", loser: "c", reason: "walkover" } }))).toBe(true);
    expect(bracketAwaitsCompletion("knockout", four({ status: "finalized", outcome: { kind: "win", winner: "a", loser: "c" } }))).toBe(true);
  });

  it("a third-place playoff still to play holds it back (auto-advance waits for it too); played, it is released", () => {
    const decidedFinal = { status: "decided", outcome: { kind: "win", winner: "a", loser: "c" } } as const;
    expect(bracketAwaitsCompletion("knockout", four(decidedFinal, [row()]))).toBe(false);
    expect(bracketAwaitsCompletion("knockout", four(decidedFinal, [won()]))).toBe(true);
  });

  it("a held final (a level result, or a recorded abandon owed its settle) is not decided; the generator's void is settled", () => {
    expect(bracketAwaitsCompletion("knockout", four({ status: "needs_decision", outcome: { kind: "draw" } }))).toBe(false);
    expect(bracketAwaitsCompletion("knockout", four({ status: "abandoned", has_active_abandon: true }))).toBe(false);
    expect(bracketAwaitsCompletion("knockout", four({ status: "abandoned", has_active_abandon: false }))).toBe(true);
  });

  it("SWEEP: every bracket kind the app declares reads a lone decided final as awaiting completion (count reported; zero fails)", () => {
    let checked = 0;
    for (const kind of BRACKET_KINDS) {
      expect(bracketAwaitsCompletion(kind, [won()]), kind).toBe(true);
      expect(bracketAwaitsCompletion(kind, [row()]), `${kind}: unplayed`).toBe(false);
      checked++;
    }
    console.info(`[stage-finals] bracket kinds checked: ${checked}`);
    expect(checked).toBeGreaterThan(0);
    expect(checked).toBe(BRACKET_KINDS.length);
  });
});

describe("unsettledCount (W4 T21)", () => {
  it("empty case first: no rows owe nothing", () => {
    expect(unsettledCount("league", [])).toBe(0);
  });
  it("counts what is still to play, never a result, a walkover or a void", () => {
    const rows = [
      won(),
      row({ status: "forfeited", outcome: { kind: "award", winner: "a", loser: "b", reason: "walkover" } }),
      row({ status: "cancelled" }),
      row(),
      row({ status: "in_play" }),
    ];
    expect(unsettledCount("league", rows)).toBe(2);
  });
  it("a bracket's recorded abandon that decided nobody is owed its settle, so it is counted; the generator's void is not", () => {
    expect(unsettledCount("knockout", [row({ status: "abandoned", has_active_abandon: true })])).toBe(1);
    expect(unsettledCount("knockout", [row({ status: "abandoned", has_active_abandon: false })])).toBe(0);
  });
});

describe("openStageState (W4 T21) — what the Complete-competition warning says of an open stage", () => {
  const fx = (o: Partial<OpenStageFixtureRow> = {}): OpenStageFixtureRow => ({
    ...row(), ext_key: null, home_entrant_id: "h", away_entrant_id: "a", ...o,
  });
  const wonFx = (o: Partial<OpenStageFixtureRow> = {}) => fx({ status: "decided", outcome: { kind: "win", winner: "h", loser: "a" }, ...o });

  it("empty case first: a stage with no fixtures has no matches, whatever its kind", () => {
    expect(openStageState("knockout", [])).toEqual({ state: "no_matches", matchesLeft: 0 });
    expect(openStageState("league", [])).toEqual({ state: "no_matches", matchesLeft: 0 });
  });

  it("a bracket is worded by its final; any other stage by its matches left", () => {
    expect(openStageState("knockout", [wonFx(), wonFx(), wonFx()])).toEqual({ state: "final_decided", matchesLeft: 0 });
    expect(openStageState("knockout", [wonFx(), wonFx(), fx()])).toEqual({ state: "final_pending", matchesLeft: 1 });
    expect(openStageState("league", [wonFx(), fx(), fx({ status: "in_play" })])).toEqual({ state: "matches_left", matchesLeft: 2 });
    expect(openStageState("league", [wonFx(), wonFx()])).toEqual({ state: "all_played", matchesLeft: 0 });
  });

  it("an unseated Swiss bye shell is never a match: not left to play, and alone it is no matches; seated, it is an ordinary row", () => {
    const byeShell = fx({ ext_key: "sw-r2-bye", home_entrant_id: null, away_entrant_id: null });
    const board = (o: Partial<OpenStageFixtureRow> = {}) => fx({ ext_key: "sw-r2-b1", ...o });
    // Round 1 played; round 2's board still to play, its bye shell not yet seated.
    expect(openStageState("swiss", [wonFx({ ext_key: "sw-r1-b1" }), board(), byeShell])).toEqual({ state: "matches_left", matchesLeft: 1 });
    expect(openStageState("swiss", [wonFx({ ext_key: "sw-r1-b1" }), byeShell])).toEqual({ state: "all_played", matchesLeft: 0 });
    expect(openStageState("swiss", [byeShell])).toEqual({ state: "no_matches", matchesLeft: 0 });
    // The positive pair: a seated bye (Pair filled a side) is a row like any other — here still scheduled, so owed.
    expect(openStageState("swiss", [fx({ ext_key: "sw-r2-bye", away_entrant_id: null })])).toEqual({ state: "matches_left", matchesLeft: 1 });
  });

  it("SWEEP: the cases above reach every state the warning declares (count reported; zero fails)", () => {
    const reached = new Set([
      openStageState("knockout", []).state,
      openStageState("knockout", [wonFx()]).state,
      openStageState("knockout", [fx()]).state,
      openStageState("league", [fx()]).state,
      openStageState("league", [wonFx()]).state,
    ]);
    let checked = 0;
    for (const s of OPEN_STAGE_STATES) {
      expect(reached.has(s), s).toBe(true);
      checked++;
    }
    console.info(`[stage-finals] open-stage states reached: ${checked}`);
    expect(checked).toBeGreaterThan(0);
    expect(checked).toBe(OPEN_STAGE_STATES.length);
  });
});
