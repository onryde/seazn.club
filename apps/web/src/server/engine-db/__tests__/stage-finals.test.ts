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
import { BYE_LINE_SHAPES, rowOf } from "@/lib/__tests__/bye-line-shapes";

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
    ...row(), ext_key: null, winner_to_fixture: null, home_entrant_id: "h", away_entrant_id: "a", home_slot_label: null, away_slot_label: null, ...o,
  });
  const wonFx = (o: Partial<OpenStageFixtureRow> = {}) => fx({ status: "decided", outcome: { kind: "win", winner: "h", loser: "a" }, ...o });
  /** A knockout of four as the generator writes it: two semis feeding the final (`winner_to_fixture`), and — with a
   *  third-place playoff — the bronze (`ko-3p`), which feeds nothing and is no final (`parseExtKey`). */
  const semis = () => [wonFx({ winner_to_fixture: "fin" }), wonFx({ winner_to_fixture: "fin" })];
  const bronze = (o: Partial<OpenStageFixtureRow> = {}) => fx({ ext_key: "ko-3p", ...o });

  it("empty case first: a stage with no fixtures has no matches, whatever its kind", () => {
    expect(openStageState("knockout", [])).toEqual({ state: "no_matches", matchesLeft: 0 });
    expect(openStageState("league", [])).toEqual({ state: "no_matches", matchesLeft: 0 });
  });

  it("a bracket is worded by its final: decided with nothing left, still to play, or held for a decision", () => {
    expect(openStageState("knockout", [...semis(), wonFx()])).toEqual({ state: "final_decided", matchesLeft: 0 });
    expect(openStageState("knockout", [...semis(), fx()])).toEqual({ state: "final_pending", matchesLeft: 1 });
    expect(openStageState("knockout", [wonFx({ winner_to_fixture: "fin" }), fx({ winner_to_fixture: "fin" }), fx()]))
      .toEqual({ state: "final_pending", matchesLeft: 2 });
    // Held: played and level, or a recorded abandon owed its settle — never "not played yet".
    expect(openStageState("knockout", [...semis(), fx({ status: "needs_decision", outcome: { kind: "draw" } })]))
      .toEqual({ state: "final_held", matchesLeft: 1 });
    expect(openStageState("knockout", [...semis(), fx({ status: "abandoned", has_active_abandon: true })]))
      .toEqual({ state: "final_held", matchesLeft: 1 });
  });

  it("AN-2: the final decided with the bronze still to play reads its matches left, never 'final not played'", () => {
    expect(openStageState("knockout", [...semis(), wonFx(), bronze()])).toEqual({ state: "matches_left", matchesLeft: 1 });
    // The positive pair: the bronze played too, the bracket waits only for Complete stage.
    expect(openStageState("knockout", [...semis(), wonFx(), bronze({ status: "decided", outcome: { kind: "win", winner: "h", loser: "a" } })]))
      .toEqual({ state: "final_decided", matchesLeft: 0 });
    // And the bronze decided while the final is not: the final is what is pending.
    expect(openStageState("knockout", [...semis(), fx(), bronze({ status: "decided", outcome: { kind: "win", winner: "h", loser: "a" } })]))
      .toEqual({ state: "final_pending", matchesLeft: 1 });
  });

  it("guard: rows that name no final (every one feeding onward — a read missing the final's columns) never claim it settled", () => {
    // Cannot happen with the generator's rows (a bracket always has a deciding game); if a read ever drops
    // `winner_to_fixture`/`ext_key`, the warning must fall back to "final not played", never print "matches left" as if
    // the final were decided.
    expect(openStageState("knockout", [...semis(), wonFx({ winner_to_fixture: "elsewhere" }), fx({ winner_to_fixture: "elsewhere" })]))
      .toEqual({ state: "final_pending", matchesLeft: 1 });
  });

  it("a table stage is worded by its matches left", () => {
    expect(openStageState("league", [wonFx(), fx(), fx({ status: "in_play" })])).toEqual({ state: "matches_left", matchesLeft: 2 });
    expect(openStageState("league", [wonFx(), wonFx()])).toEqual({ state: "all_played", matchesLeft: 0 });
  });

  it("Swiss: a later round's unseated bye shell is never a match left; once seated and awarded it is an ordinary settled row", () => {
    // The generator mints every declared round's boards and its bye shell up front (usecases/stages/swiss-gen.ts swissGen). After round 1
    // of a five-entrant, two-round Swiss: round 1 played (its bye seated and awarded), round 2's two TBD boards still to
    // play, and its bye shell not yet seated by Pair.
    const award = { status: "decided", outcome: { kind: "award", winner: "h", reason: "bye" }, away_entrant_id: null } as const;
    const r1 = [wonFx({ ext_key: "sw-r1-b1" }), wonFx({ ext_key: "sw-r1-b2" }), fx({ ext_key: "sw-r1-bye", ...award })];
    const r2Shells = [
      fx({ ext_key: "sw-r2-b1", home_entrant_id: null, away_entrant_id: null }),
      fx({ ext_key: "sw-r2-b2", home_entrant_id: null, away_entrant_id: null }),
      fx({ ext_key: "sw-r2-bye", home_entrant_id: null, away_entrant_id: null }),
    ];
    expect(openStageState("swiss", [...r1, ...r2Shells])).toEqual({ state: "matches_left", matchesLeft: 2 });
    // Round 2 paired and played, its bye seated and awarded: every match settled.
    const r2 = [wonFx({ ext_key: "sw-r2-b1" }), wonFx({ ext_key: "sw-r2-b2" }), fx({ ext_key: "sw-r2-bye", ...award })];
    expect(openStageState("swiss", [...r1, ...r2])).toEqual({ state: "all_played", matchesLeft: 0 });
    // A seated bye not yet awarded is still a bye line that waits — the desk counts it as nothing owed
    // (`isWaitingByeLine`, lib/bye-line.ts), so the warning does too (merge-lanes-1, B-desk review merge note).
    expect(openStageState("swiss", [...r1, fx({ ext_key: "sw-r2-bye", away_entrant_id: null })])).toEqual({ state: "all_played", matchesLeft: 0 });
    // The positive pair: a seated BOARD still to play is owed.
    expect(openStageState("swiss", [...r1, fx({ ext_key: "sw-r2-b1" })])).toEqual({ state: "matches_left", matchesLeft: 1 });
  });

  it("a knockout's pre-award bye line is no match left either — the desk's reading, not the Swiss shell's alone", () => {
    // A `timing: "setup"` bracket of three drawn on day one: seed 1's line against the bye (the away side the phantom,
    // carrying the bye slot label), the real first-round line, and the final it all feeds. Two matches are owed.
    const BYE = { key: "bracket.slot.bye", params: {} };
    const preAward = fx({ home_entrant_id: null, away_entrant_id: null, home_slot_label: { key: "bracket.slot.seed", params: { seed: 1 } }, away_slot_label: BYE, winner_to_fixture: "fin" });
    const realLine = fx({ home_entrant_id: null, away_entrant_id: null, winner_to_fixture: "fin" });
    const final = fx({ home_entrant_id: null, away_entrant_id: null });
    expect(openStageState("knockout", [preAward, realLine, final])).toEqual({ state: "final_pending", matchesLeft: 2 });
    // The positive pair: the bye label over a SEATED side is no phantom — a real match, owed.
    expect(openStageState("knockout", [fx({ away_slot_label: BYE, winner_to_fixture: "fin" }), realLine, final]))
      .toEqual({ state: "final_pending", matchesLeft: 3 });
  });

  it("SWEEP: every bye-line shape the rules table declares — a waiting bye line is no match left, any other row counts as the engine settles it (count reported; zero fails)", () => {
    // Which shapes are bye lines comes from the shared rules table (lib/__tests__/bye-line-shapes.ts), never from the
    // predicate under test: one that IS a bye line and is still `scheduled` waits, and a bye is not played (X-SD-5,
    // X-SW-29). Every other row is owed exactly when the engine's settled reading says so (`unsettledCount`).
    let checked = 0;
    let waiting = 0;
    for (const s of BYE_LINE_SHAPES) {
      const shape: OpenStageFixtureRow = { ...fx(), ...rowOf(s, { H: "h", A: "a" }) };
      const waits = s.expected && s.status === "scheduled";
      // The non-waiting rows' expected value uses `unsettledCount`, which has its own tests (above); only the waiting / not-waiting split is derived independently here, from the rules table.
      const owed = waits ? 0 : unsettledCount("league", [shape]);
      expect(openStageState("league", [wonFx(), shape]).matchesLeft, s.name).toBe(owed);
      if (waits) waiting++;
      checked++;
    }
    console.info(`[stage-finals] bye-line shapes checked: ${checked} (waiting bye lines: ${waiting})`);
    expect(checked).toBe(BYE_LINE_SHAPES.length);
    expect(waiting, "the table reaches a waiting bye line").toBeGreaterThan(0);
    expect(checked - waiting, "and a row that is not one").toBeGreaterThan(0);
  });

  it("SWEEP: the cases above reach every state the warning declares (count reported; zero fails)", () => {
    const reached = new Set([
      openStageState("knockout", []).state,
      openStageState("knockout", [...semis(), wonFx()]).state,
      openStageState("knockout", [...semis(), fx()]).state,
      openStageState("knockout", [...semis(), fx({ status: "needs_decision", outcome: { kind: "draw" } })]).state,
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
