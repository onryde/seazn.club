// Swiss auto-advance: the pure derivation (spec docs/superpowers/specs/2026-11-08-swiss-auto-advance-design.md
// §4.1-§4.4 and §4.6; plan Task 3). The server arms and fires from it, and the banner renders from it.
//
// `deriveSourceAction` is a LADDER: the first rung that matches wins, so the ORDER is part of the meaning. Each rung
// has its own case, and the empty case comes first. Expected values come from the spec and from declarations, never
// from the code under test:
//  - `decided` is what the SERVER computes from usecases/stages.ts's DECIDED. That module is server-only, so its
//    declaration is read here as TEXT (the swiss-round-state.test.ts pattern), and lib never restates it.
//  - board statuses come from lib/fixture-status.ts's FIXTURE_STATUSES, and stage statuses from the V210 check
//    (pending, active, complete).
//  - a bye is the row Pair writes: one seat, an award outcome, status forfeited.
//
// sport-blind: SourceFacts and ConfirmFacts carry no sport field. The Swiss x {generic, badminton, chess} rows are
// driven through the real DB in Task 5 and the walkthrough in Task 17.
import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AUTO_ACTION_KINDS,
  AUTO_ACTION_STATES,
  AUTO_ADVANCE_DONE_VISIBLE_MS,
  AUTO_ADVANCE_HOLD_MAX_MS,
  AUTO_ADVANCE_LEASE_MS,
  AUTO_ADVANCE_MAX_ATTEMPTS,
  AUTO_ADVANCE_POLL_MS,
  AUTO_ADVANCE_SETTLE_MS,
  LIVE_AUTO_ACTION_STATES,
  autoActionRetryDelayMs,
  autoAdvanceSwitchesFor,
  deriveConfirmAction,
  deriveSourceAction,
  skipKey,
  type BoardRef,
  type ConfirmFacts,
  type DerivedSource,
  type SourceFacts,
  type SourceFixtureFact,
} from "@/lib/auto-advance";
import { FIXTURE_STATUSES, LOCKED_FIXTURE_STATUSES } from "@/lib/fixture-status";
import { isSwissBoardSeated, planSwissShells } from "@/lib/swiss-shell";
import { StageKind } from "@/server/api-v1/schemas";

// ---------------------------------------------------------------------------------------------------------------------
// The server's decided set, read from its one declaration.
// ---------------------------------------------------------------------------------------------------------------------

const DECIDED: ReadonlySet<string> = (() => {
  const source = readFileSync(new URL("../../server/usecases/stages.ts", import.meta.url), "utf8");
  const match = /const DECIDED(?::[^=]*)? = new Set\(\[([^\]]*)\]\)/.exec(source);
  if (!match) throw new Error("usecases/stages.ts no longer declares DECIDED");
  const declared = [...match[1]!.matchAll(/"([a-z_]+)"/g)].map(([, s]) => s!);
  if (declared.length === 0) throw new Error("usecases/stages.ts declares an empty DECIDED");
  return new Set(declared);
})();

// The two statuses the cases below lean on, held to the declaration so a change to DECIDED reds here first.
it("the declared decided set still decides a forfeit and leaves an abandoned or in-play board open", () => {
  expect(DECIDED.has("forfeited")).toBe(true);
  expect(DECIDED.has("decided")).toBe(true);
  expect(DECIDED.has("abandoned")).toBe(false);
  expect(DECIDED.has("in_play")).toBe(false);
  expect(DECIDED.has("scheduled")).toBe(false);
});

// ---------------------------------------------------------------------------------------------------------------------
// Fixture builders: rows exactly as Pair and the shell minter leave them.
// ---------------------------------------------------------------------------------------------------------------------

function fx(round: number, board: number, status: string, over: Partial<SourceFixtureFact> = {}): SourceFixtureFact {
  return {
    id: `fx-r${round}-b${board}`,
    round_no: round,
    seq_in_round: board,
    home_entrant_id: `e-r${round}-b${board}-h`,
    away_entrant_id: `e-r${round}-b${board}-a`,
    outcome: null,
    ext_key: `sw-r${round}-b${board}`,
    status,
    decided: DECIDED.has(status),
    ...over,
  };
}
/** A seated board with the given status. */
const seated = (round: number, board: number, status: string) => fx(round, board, status);
/** An unseated board shell, as `planSwissShells` mints it. */
const shell = (round: number, board: number) =>
  fx(round, board, "scheduled", { home_entrant_id: null, away_entrant_id: null });
/** A seated bye: one seat, an award, forfeited. Its `decided` is the server's (forfeited is in DECIDED). */
const bye = (round: number, seq: number) =>
  fx(round, seq, "forfeited", {
    id: `fx-r${round}-bye`,
    ext_key: `sw-r${round}-bye`,
    away_entrant_id: null,
    outcome: { kind: "award", winner: "home" },
  });
/** An unseated bye shell. */
const byeShell = (round: number, seq: number) =>
  fx(round, seq, "scheduled", { id: `fx-r${round}-bye`, ext_key: `sw-r${round}-bye`, home_entrant_id: null, away_entrant_id: null });

const ref = (f: SourceFixtureFact): BoardRef => ({ fixtureId: f.id, round: f.round_no, board: f.seq_in_round });

function facts(fixtures: SourceFixtureFact[], over: Partial<SourceFacts> = {}): SourceFacts {
  return { stageStatus: "active", fixtures, skipped: new Set(), ...over };
}

// ---------------------------------------------------------------------------------------------------------------------
// deriveSourceAction: one case per rung, empty first.
// ---------------------------------------------------------------------------------------------------------------------

describe("deriveSourceAction: the ladder, rung by rung", () => {
  it("empty stage derives none", () => {
    // Rung 1. No fixtures generated: nothing arms (spec §5 case 12), whatever the stage status or the skip set says.
    for (const stageStatus of ["pending", "active", "complete"]) {
      expect(deriveSourceAction(facts([], { stageStatus }))).toEqual({ state: "none" });
    }
    expect(deriveSourceAction(facts([], { skipped: new Set([skipKey("pair_round", 2)]) }))).toEqual({ state: "none" });
  });

  it("complete stage derives none", () => {
    // Rung 2. Round 1 decided and round 2 still shells: an ACTIVE stage arms round 2, a COMPLETE one never does
    // (a completed stage cannot be reopened, spec §4.6). The positive pair is what makes the none mean something.
    const fixtures = [seated(1, 1, "decided"), seated(1, 2, "finalized"), shell(2, 1), shell(2, 2)];
    expect(deriveSourceAction(facts(fixtures))).toEqual({ state: "pending", kind: "pair_round", round: 2 });
    expect(deriveSourceAction(facts(fixtures, { stageStatus: "complete" }))).toEqual({ state: "none" });
    // Every round settled too: still none, not complete_stage.
    const settled = [seated(1, 1, "decided"), seated(2, 1, "decided")];
    expect(deriveSourceAction(facts(settled, { stageStatus: "complete" }))).toEqual({ state: "none" });
  });

  it("round 1 is never armed", () => {
    // Rung 3 (spec §4.1 [call]): round 1 is the organiser's deliberate start and is always paired by hand.
    // (a) Round-1 shells only, as Start leaves an odd field of 5 over 3 rounds.
    const shellsOnly = planSwissShells(3, 5).map((p) =>
      p.bye ? byeShell(p.roundNo, p.seqInRound) : shell(p.roundNo, p.seqInRound),
    );
    expect(shellsOnly.length).toBeGreaterThan(0);
    expect(deriveSourceAction(facts(shellsOnly))).toEqual({ state: "none" });
    // (b) Round 1 partly seated.
    const partly = [seated(1, 1, "decided"), shell(1, 2), shell(2, 1), shell(2, 2)];
    expect(deriveSourceAction(facts(partly))).toEqual({ state: "none" });
    // (c) The case only this rung decides. The DB does not forbid round_no 0 (V214 has no check on it), and a seated,
    // decided round-0 row would give round 1 a non-empty "previous round". Round 1 stays by hand all the same.
    const roundZero = [seated(0, 1, "decided"), shell(1, 1), shell(1, 2)];
    expect(deriveSourceAction(facts(roundZero))).toEqual({ state: "none" });
  });

  it("an empty previous round derives none (the scope guard)", () => {
    // Rung 5 (spec §4.1: "Arming requires a target round >= 2 whose previous round has at least one seated board").
    // Round 2 is next, and round 1 holds no row at all: an empty scope is vacuously "all decided", and must not arm.
    expect(deriveSourceAction(facts([shell(2, 1), shell(2, 2)]))).toEqual({ state: "none" });
    // A later round with its previous round missing: same.
    const gap = [seated(1, 1, "decided"), shell(3, 1)];
    expect(deriveSourceAction(facts(gap))).toEqual({ state: "none" });
  });

  it("round 2 pending when every seated round-1 board is decided", () => {
    // Rung 9. An odd field of 5: two boards and a bye per round. The bye is `forfeited`, which the SERVER reads as
    // decided (its `decided: true` is supplied, never restated here).
    const r1 = [seated(1, 1, "decided"), seated(1, 2, "finalized"), bye(1, 3)];
    const r2 = [shell(2, 1), shell(2, 2), byeShell(2, 3)];
    expect(r1.every((f) => f.decided)).toBe(true);
    expect(deriveSourceAction(facts([...r1, ...r2]))).toEqual({ state: "pending", kind: "pair_round", round: 2 });
    // Second call, same facts: same answer (the derivation holds no state).
    expect(deriveSourceAction(facts([...r1, ...r2]))).toEqual({ state: "pending", kind: "pair_round", round: 2 });
    // Only the PREVIOUS round is the scope, as generateStageFixtures checks it: a round-1 board reopened by a void
    // after round 2 was paired does not hold round 3. A wrong "every seated board" scope would say waiting here.
    const reopened = [seated(1, 1, "scheduled"), seated(1, 2, "decided"), seated(2, 1, "decided"), seated(2, 2, "forfeited"), shell(3, 1), shell(3, 2)];
    expect(reopened[0]!.decided).toBe(false);
    expect(deriveSourceAction(facts(reopened))).toEqual({ state: "pending", kind: "pair_round", round: 3 });
  });

  it("waiting names the open boards in board order", () => {
    // Rung 8. Round 2 has board 3 in play and board 1 seated but not started; board 2 and the bye are decided.
    // The input lists board 3 BEFORE board 1 (an ordering differential): the answer is sorted by (round, board).
    const r2 = [seated(2, 1, "scheduled"), seated(2, 2, "decided"), seated(2, 3, "in_play"), bye(2, 4)];
    const fixtures = [shell(3, 1), shell(3, 2), byeShell(3, 3), r2[2]!, r2[3]!, r2[1]!, r2[0]!, bye(1, 3), seated(1, 2, "decided"), seated(1, 1, "decided")];
    expect(fixtures.indexOf(r2[2]!)).toBeLessThan(fixtures.indexOf(r2[0]!));
    expect(deriveSourceAction(facts(fixtures))).toEqual({
      state: "waiting",
      kind: "pair_round",
      round: 3,
      openBoards: [ref(r2[0]!), ref(r2[2]!)],
    });
    // A void of a decided board (spec §5 case 3): round 3 goes back to waiting, now naming board 2 as well.
    const voided = fixtures.map((f) => (f.id === "fx-r2-b2" ? seated(2, 2, "scheduled") : f));
    expect(deriveSourceAction(facts(voided))).toEqual({
      state: "waiting",
      kind: "pair_round",
      round: 3,
      openBoards: [ref(r2[0]!), ref(seated(2, 2, "scheduled")), ref(r2[2]!)],
    });
  });

  it("abandoned outranks waiting", () => {
    // Rung 7 before rung 8 (spec §4.4: an abandoned board blocks with STAGE_NOT_READY and is named). Round 2 holds
    // two abandoned boards and one in play: the answer is BLOCKED naming only the abandoned two, in board order.
    // This is the ORDER pin: swapping rungs 7 and 8 answers waiting here.
    // Board 4 is listed before board 2, so the answer's order is the sort's, not the input's.
    const r2 = [seated(2, 4, "abandoned"), seated(2, 1, "in_play"), seated(2, 2, "abandoned"), seated(2, 3, "decided")];
    const fixtures = [seated(1, 1, "decided"), seated(1, 2, "decided"), seated(1, 3, "decided"), seated(1, 4, "decided"), ...r2, shell(3, 1)];
    expect(deriveSourceAction(facts(fixtures))).toEqual({
      state: "blocked",
      kind: "pair_round",
      round: 3,
      code: "STAGE_NOT_READY",
      boards: [ref(r2[2]!), ref(r2[0]!)],
    });
  });

  it("a seated cancelled board blocks like an abandoned one", () => {
    // Rung 7 (spec §3: "abandoned/cancelled block"). A cancelled board is LOCKED (lib/fixture-status.ts: no further
    // append), so it can never become decided: counted as open, it would hold the row in `waiting` for ever. Held to
    // the declarations first, so a change to either reds here before the cases below.
    expect(LOCKED_FIXTURE_STATUSES.has("cancelled")).toBe(true);
    expect(DECIDED.has("cancelled")).toBe(false);
    // Pair: round 2 holds a cancelled board, an in-play one and a decided one. The wrong answer (cancelled read as
    // merely open) is `waiting` naming boards 1 and 2; the right one is blocked naming the cancelled board alone.
    const r2 = [seated(2, 2, "cancelled"), seated(2, 1, "in_play"), seated(2, 3, "decided")];
    const pairFacts = [seated(1, 1, "decided"), seated(1, 2, "decided"), seated(1, 3, "decided"), ...r2, shell(3, 1)];
    expect(deriveSourceAction(facts(pairFacts))).toEqual({
      state: "blocked",
      kind: "pair_round",
      round: 3,
      code: "STAGE_NOT_READY",
      boards: [ref(r2[0]!)],
    });
    // With an abandoned board beside it: both named, in board order (cancelled board 3 listed before abandoned board 1).
    const mixed = [seated(1, 1, "decided"), seated(1, 2, "decided"), seated(1, 3, "decided"), seated(2, 3, "cancelled"), seated(2, 1, "abandoned"), seated(2, 2, "decided"), shell(3, 1)];
    expect(deriveSourceAction(facts(mixed))).toEqual({
      state: "blocked",
      kind: "pair_round",
      round: 3,
      code: "STAGE_NOT_READY",
      boards: [ref(mixed[4]!), ref(mixed[3]!)],
    });
    // Complete: the last round settled except one cancelled board, so completing the stage blocks too.
    const last = [seated(1, 1, "decided"), seated(2, 1, "decided"), seated(2, 2, "cancelled")];
    expect(deriveSourceAction(facts(last))).toEqual({
      state: "blocked",
      kind: "complete_stage",
      round: 2,
      code: "STAGE_NOT_READY",
      boards: [ref(last[2]!)],
    });
  });

  it("skip is sticky for its round only", () => {
    // Rung 6 (spec §4.2 "Skip is sticky for its target"; §5 case 13).
    const keys = [skipKey("pair_round", 3), skipKey("pair_round", 4), skipKey("complete_stage", 3)];
    expect(new Set(keys).size, "a skip key names its kind AND its round").toBe(keys.length);

    const settled12 = [seated(1, 1, "decided"), seated(1, 2, "decided"), seated(2, 1, "decided"), seated(2, 2, "decided")];
    const round3Next = [...settled12, shell(3, 1), shell(3, 2), shell(4, 1), shell(4, 2)];
    expect(deriveSourceAction(facts(round3Next))).toEqual({ state: "pending", kind: "pair_round", round: 3 });
    // Skip round 3: none, and a correction in round 2 (a second call on new facts) does not re-arm it.
    const skip3 = new Set([skipKey("pair_round", 3)]);
    expect(deriveSourceAction(facts(round3Next, { skipped: skip3 }))).toEqual({ state: "none" });
    const corrected = round3Next.map((f) => (f.id === "fx-r2-b1" ? seated(2, 1, "finalized") : f));
    expect(deriveSourceAction(facts(corrected, { skipped: skip3 }))).toEqual({ state: "none" });
    // The NEXT round arms normally: round 3 seated by hand and settled, round 4 next.
    const round4Next = [...settled12, seated(3, 1, "decided"), seated(3, 2, "forfeited"), shell(4, 1), shell(4, 2)];
    expect(deriveSourceAction(facts(round4Next, { skipped: skip3 }))).toEqual({ state: "pending", kind: "pair_round", round: 4 });
    // A skipped PAIR of round 3 does not skip COMPLETING after round 3: the key carries the kind.
    const lastSettled = [...settled12, seated(3, 1, "decided"), seated(3, 2, "decided")];
    expect(deriveSourceAction(facts(lastSettled, { skipped: skip3 }))).toEqual({ state: "pending", kind: "complete_stage", round: 3 });
    expect(deriveSourceAction(facts(lastSettled, { skipped: new Set([skipKey("complete_stage", 3)]) }))).toEqual({ state: "none" });
  });

  it("last round settled derives complete_stage with the last round", () => {
    // Rung 4, t === null (spec §4.1 [call] "Auto-pair also finishes the stage"): `round` is the stage's last round.
    // Shuffled so the last row in the input is NOT from the last round.
    const fixtures = [seated(3, 1, "decided"), bye(3, 2), seated(2, 1, "finalized"), bye(2, 2), seated(1, 1, "decided"), bye(1, 2)];
    expect(fixtures.at(-1)!.round_no).not.toBe(3);
    expect(deriveSourceAction(facts(fixtures))).toEqual({ state: "pending", kind: "complete_stage", round: 3 });
  });

  it("last round open derives waiting complete_stage", () => {
    // Rung 4's scope for complete_stage is EVERY seated board. Round 3 board 1 is in play, and round 2 board 2 was
    // reopened by a void after round 3 was paired. Sorted by round FIRST: the input order and a board-only sort would
    // both put r3b1 ahead.
    const r2b2 = seated(2, 2, "scheduled");
    const r3b1 = seated(3, 1, "in_play");
    const fixtures = [r3b1, seated(3, 2, "decided"), r2b2, seated(2, 1, "decided"), seated(1, 2, "decided"), seated(1, 1, "decided")];
    expect(deriveSourceAction(facts(fixtures))).toEqual({
      state: "waiting",
      kind: "complete_stage",
      round: 3,
      openBoards: [ref(r2b2), ref(r3b1)],
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The property (TEST-STRATEGY rule 10): random Swiss stages, the invariants after each.
// ---------------------------------------------------------------------------------------------------------------------

/** The scope the spec defines for a derived action (§4.1 and the ladder's rung 4), computed here from the seating
 *  predicate rather than read back from the derivation. */
function scopeOf(fixtures: readonly SourceFixtureFact[], d: Exclude<DerivedSource, { state: "none" }>): SourceFixtureFact[] {
  const isSeated = fixtures.filter((f) => isSwissBoardSeated(f));
  return d.kind === "complete_stage" ? isSeated : isSeated.filter((f) => f.round_no === d.round - 1);
}

const stageArb = fc
  .record({
    rounds: fc.integer({ min: 2, max: 5 }),
    entrants: fc.integer({ min: 2, max: 9 }),
    seatedRounds: fc.integer({ min: 0, max: 5 }),
    partialNext: fc.integer({ min: 0, max: 5 }),
    statuses: fc.array(fc.constantFrom(...FIXTURE_STATUSES), { minLength: 60, maxLength: 60 }),
    stageStatus: fc.constantFrom("pending", "active", "complete"),
    skipRounds: fc.array(fc.tuple(fc.constantFrom("pair_round" as const, "complete_stage" as const), fc.integer({ min: 1, max: 5 })), { maxLength: 2 }),
  })
  .map((g) => {
    const seatedRounds = Math.min(g.seatedRounds, g.rounds);
    let s = 0;
    const fixtures = planSwissShells(g.rounds, g.entrants).map((p): SourceFixtureFact => {
      const isSeated = p.roundNo <= seatedRounds || (p.roundNo === seatedRounds + 1 && !p.bye && p.seqInRound <= g.partialNext);
      if (!isSeated) return p.bye ? byeShell(p.roundNo, p.seqInRound) : shell(p.roundNo, p.seqInRound);
      if (p.bye) return bye(p.roundNo, p.seqInRound);
      return seated(p.roundNo, p.seqInRound, g.statuses[s++ % g.statuses.length]!);
    });
    return { fixtures, stageStatus: g.stageStatus, skipped: new Set(g.skipRounds.map(([k, r]) => skipKey(k, r))) };
  });

describe("deriveSourceAction: the property over random Swiss stages", () => {
  it("never arms round 1, never counts down over an open board, and a waiting row always names a board", () => {
    let checked = 0;
    const seen = { none: 0, waiting: 0, pending: 0, blocked: 0, roundOneNext: 0 };
    fc.assert(
      fc.property(stageArb, (f) => {
        const d = deriveSourceAction(f);
        checked++;
        seen[d.state]++;
        if (f.fixtures.some((x) => x.round_no === 1 && !isSwissBoardSeated(x))) seen.roundOneNext++;
        if (d.state === "none") return;
        // Never pair_round 1, in any live state.
        expect(d.kind === "pair_round" && d.round === 1).toBe(false);
        const scope = scopeOf(f.fixtures, d);
        expect(scope.length, "an armed action has a non-empty scope").toBeGreaterThan(0);
        // Never pending while a scope board is undecided.
        if (d.state === "pending") expect(scope.filter((x) => !x.decided)).toEqual([]);
        // A waiting row always names at least one open board, and every named board is an open board of the scope.
        if (d.state === "waiting") {
          expect(d.openBoards.length).toBeGreaterThan(0);
          const open = new Set(scope.filter((x) => !x.decided).map((x) => x.id));
          for (const b of d.openBoards) expect(open.has(b.fixtureId), b.fixtureId).toBe(true);
        }
      }),
      { numRuns: 500 },
    );
    // Anti-vacuity: the run checked stages, and it reached the states its invariants speak about.
    expect(checked).toBe(500);
    expect(seen.pending, JSON.stringify(seen)).toBeGreaterThan(0);
    expect(seen.waiting, JSON.stringify(seen)).toBeGreaterThan(0);
    expect(seen.roundOneNext, JSON.stringify(seen)).toBeGreaterThan(0);
    console.info(`auto-advance property: checked ${checked} stages ${JSON.stringify(seen)}`);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// deriveConfirmAction.
// ---------------------------------------------------------------------------------------------------------------------

describe("deriveConfirmAction", () => {
  const draft = (tieCount = 0): NonNullable<ConfirmFacts["latest"]> => ({ id: "prop-1", status: "draft", tieCount });

  it("no proposal derives none", () => {
    // The empty case first: a target with no proposal yet (its sources are not complete) arms nothing.
    expect(deriveConfirmAction({ latest: null, livePaused: false })).toEqual({ state: "none" });
    expect(deriveConfirmAction({ latest: null, livePaused: true })).toEqual({ state: "none" });
  });

  it("a confirmed or stale proposal derives none", () => {
    for (const status of ["confirmed", "stale"] as const) {
      expect(deriveConfirmAction({ latest: { id: "prop-1", status, tieCount: 0 }, livePaused: false }), status).toEqual({ state: "none" });
      expect(deriveConfirmAction({ latest: { id: "prop-1", status, tieCount: 2 }, livePaused: true }), status).toEqual({ state: "none" });
    }
  });

  it("tie derives blocked", () => {
    // D4: a tie blocks at once, and outranks a person's hold (the banner shows the tie, which is what they must fix).
    for (const livePaused of [false, true]) {
      expect(deriveConfirmAction({ latest: draft(1), livePaused })).toEqual({
        state: "blocked",
        proposalId: "prop-1",
        code: "SEEDING_TIE_UNRESOLVED",
      });
    }
  });

  it("paused keeps paused", () => {
    expect(deriveConfirmAction({ latest: draft(), livePaused: true })).toEqual({ state: "paused", proposalId: "prop-1" });
  });

  it("a draft with no tie derives pending, keyed on its own id", () => {
    expect(deriveConfirmAction({ latest: draft(), livePaused: false })).toEqual({ state: "pending", proposalId: "prop-1" });
    // A fresh draft after a correction (a new id) is a new target (spec §4.2 "A new draft re-arms confirm").
    expect(deriveConfirmAction({ latest: { id: "prop-2", status: "draft", tieCount: 0 }, livePaused: false })).toEqual({
      state: "pending",
      proposalId: "prop-2",
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// autoAdvanceSwitchesFor: where each switch can act (the PUT door refuses an ON elsewhere; the Format tool shows it).
// ---------------------------------------------------------------------------------------------------------------------

describe("autoAdvanceSwitchesFor", () => {
  it("empty case first: a stage with no progression, of a kind that is not Swiss, takes neither switch", () => {
    expect(autoAdvanceSwitchesFor({ kind: "league", progression: null })).toEqual({ autoPair: false, autoConfirmHandoff: false });
  });

  it("every stage kind x every progression shape: auto-pair on a Swiss only, auto-confirm on a setup target only (counted)", () => {
    // Spec §4.1's table, typed here: "Pair the next round automatically" lives on and is shown for "Swiss stages only";
    // "Confirm who moves on automatically" for "any stage whose progression.timing = setup (i.e. it gets a seed
    // proposal)". The kinds are the API's own list (schemas.ts StageKind), the timings ProgressionSchema's enum.
    const progressions: { label: string; progression: unknown; setup: boolean }[] = [
      { label: "none", progression: null, setup: false },
      { label: "absent", progression: undefined, setup: false },
      { label: "setup", progression: { sources: [{ stage: "previous" }], placement: "rank_order", timing: "setup" }, setup: true },
      { label: "on_complete", progression: { sources: [{ stage: "previous" }], placement: "rank_order", timing: "on_complete" }, setup: false },
      { label: "no timing", progression: { sources: [] }, setup: false },
    ];
    let checked = 0;
    const reached = { pair: 0, noPair: 0, confirm: 0, noConfirm: 0 };
    for (const kind of StageKind.options) {
      for (const p of progressions) {
        const got = autoAdvanceSwitchesFor({ kind, progression: p.progression });
        expect(got, `${kind} / ${p.label}`).toEqual({ autoPair: kind === "swiss", autoConfirmHandoff: p.setup });
        reached[got.autoPair ? "pair" : "noPair"]++;
        reached[got.autoConfirmHandoff ? "confirm" : "noConfirm"]++;
        checked++;
      }
    }
    expect(checked).toBe(StageKind.options.length * progressions.length);
    expect(StageKind.options.length, "the kind list is the API's, and it holds a Swiss").toBeGreaterThan(1);
    // Both answers of both switches were reached: a constant answer would leave one at zero.
    for (const [k, n] of Object.entries(reached)) expect(n, k).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Retry backoff and the declared constants.
// ---------------------------------------------------------------------------------------------------------------------

describe("constants and backoff", () => {
  it("retry delays rise and stop at the cap", () => {
    // Plan Task 3: 30 s, 60 s, 120 s, 300 s for attempts 1-4; at AUTO_ADVANCE_MAX_ATTEMPTS the caller blocks
    // (spec §4.3), so there is no fifth delay and asking for one is a caller bug.
    const declared = [30, 60, 120, 300].map((s) => s * 1000);
    const delays: number[] = [];
    for (let attempt = 1; attempt < AUTO_ADVANCE_MAX_ATTEMPTS; attempt++) delays.push(autoActionRetryDelayMs(attempt));
    expect(delays).toEqual(declared);
    for (let i = 1; i < delays.length; i++) expect(delays[i]!).toBeGreaterThan(delays[i - 1]!);
    for (const bad of [AUTO_ADVANCE_MAX_ATTEMPTS, AUTO_ADVANCE_MAX_ATTEMPTS + 1, 0, -1, 1.5, Number.NaN]) {
      expect(() => autoActionRetryDelayMs(bad), String(bad)).toThrow(RangeError);
    }
  });

  it("every constant equals its spec value", () => {
    // The spec's numbers, typed here once as the declaration under test.
    expect(AUTO_ADVANCE_SETTLE_MS).toBe(60 * 1000); // §4.2 "60 s is a constant, not a setting"
    expect(AUTO_ADVANCE_HOLD_MAX_MS).toBe(30 * 60 * 1000); // §4.2 a paused row is released after 30 minutes
    expect(AUTO_ADVANCE_DONE_VISIBLE_MS).toBe(10 * 60 * 1000); // §4.6 the most recent done row for 10 minutes
    expect(AUTO_ADVANCE_POLL_MS).toBe(10 * 1000); // §4.6 the banner polls every 10 s
    expect(AUTO_ADVANCE_MAX_ATTEMPTS).toBe(5); // §4.3 retry with backoff up to 5 attempts
    expect(AUTO_ADVANCE_LEASE_MS).toBe(2 * 60 * 1000); // plan Task 3 (spec §7 leaves the claim shape to the builder)
    // §4.2's live set, widened by plan P4 to hold `paused`: the schema test reads this same tuple.
    expect([...LIVE_AUTO_ACTION_STATES]).toEqual(["waiting", "pending", "paused", "blocked"]);
    // §4.2's kind and state columns (the API schema's enums read these tuples).
    expect([...AUTO_ACTION_KINDS]).toEqual(["pair_round", "complete_stage", "confirm_handoff"]);
    expect([...AUTO_ACTION_STATES]).toEqual(["waiting", "pending", "paused", "blocked", "done", "cancelled"]);
  });

  it("stays client-safe: its only import is lib/swiss-shell", () => {
    // The banner (a client component) imports this module, so it may not reach a server-only one.
    const source = readFileSync(new URL("../auto-advance.ts", import.meta.url), "utf8");
    const specifiers = [...source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/gm)].map(([, s]) => s);
    const bare = [...source.matchAll(/^\s*import\s+["']([^"']+)["']/gm)].map(([, s]) => s);
    expect([...specifiers, ...bare]).toEqual(["./swiss-shell.ts"]);
  });
});
