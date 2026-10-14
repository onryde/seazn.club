// T16 fix round 1, I1 + I4 — the public reading of an online board under its
// fixture, swept over EVERY fixtures.status (FIXTURE_STATUSES, the column's own
// declaration) and every bridge state a spectator can meet.
//
// The rule, from the rulebook rather than the code: fixture-status.ts and W2a
// (spec §5.4.6) — `scheduled`/`in_play` are still to be played (T8's Q2);
// `needs_decision` is a level result in a bracket, "played, not finished,
// closed by the organiser's settle"; every other status is settled. So:
//  - settled ⇒ decided, no hold, the board over (never "needs the organiser");
//  - needs_decision ⇒ not decided, the board over, the FIXTURE's hold — a
//    draw's winner to be decided, any other level result to be confirmed;
//  - open ⇒ the bridge's hold (its public reading, PUBLIC_HOLD), if held.
//
// Pure: no DB. Single-sport by construction — online play is boardgame only.
import { describe, expect, it } from "vitest";
import { FIXTURE_STATUSES } from "@/lib/fixture-status";
import { publicPlayOf, publicResultOf, watchLinkOf, type PublicFixtureRow, type WatchLinkRow } from "../external-play-read";
import { NEEDS_REASONS } from "@/server/external-play/types";

const OPEN = new Set(["scheduled", "in_play"]);
const AWAITING_DECISION = "needs_decision";
const HOME = "11111111-1111-4111-8111-111111111111";
const AWAY = "22222222-2222-4222-8222-222222222222";

const row = (o: Partial<PublicFixtureRow>): PublicFixtureRow => ({
  status: "live",
  challenge_id: "gm-abc",
  white_side: "home",
  moves_uci: ["e2e4", "e7e5", "g1f3"],
  move_count: 3,
  white_ms: 500_000,
  black_ms: 500_000,
  last_move_at: new Date("2026-10-13T10:00:00Z"),
  needs_reason: null,
  fixture_status: "in_play",
  home_entrant_id: HOME,
  away_entrant_id: AWAY,
  outcome: null,
  summary: null,
  finished_at: null,
  ...o,
});

// Each bridge state a spectator meets: [label, bridge columns, the bridge's own public hold while the fixture is open].
const BRIDGES: [string, Partial<PublicFixtureRow>, "tiebreak" | "confirm" | null][] = [
  ["live", { status: "live" }, null],
  ["finished", { status: "finished" }, null],
  ["held for fair play", { status: "needs_organiser", needs_reason: "fair_play" }, "confirm"],
  ["held for a knockout draw", { status: "needs_organiser", needs_reason: "tiebreak_owed" }, "tiebreak"],
  ["held: a seat's token revoked (the game goes on)", { status: "needs_organiser", needs_reason: "token_revoked", }, null],
];
const OUTCOMES: [string, PublicFixtureRow["outcome"], "tiebreak" | "confirm"][] = [
  ["a draw", { kind: "draw" }, "tiebreak"],
  ["a tie", { kind: "tie" }, "tiebreak"],
  ["no result", { kind: "no_result" }, "confirm"],
];

describe("publicPlayOf — every fixture status × every bridge state", () => {
  it("the fixture decides first; under an open fixture the bridge's hold is the one shown", () => {
    let checked = 0;
    const seen = { open: 0, awaiting: 0, settled: 0 };
    for (const fixtureStatus of FIXTURE_STATUSES) {
      for (const [label, bridge, bridgeHold] of BRIDGES) {
        for (const [oLabel, outcome, levelHold] of OUTCOMES) {
          const at = `${fixtureStatus} / ${label} / ${oLabel}`;
          const p = publicPlayOf(row({ ...bridge, fixture_status: fixtureStatus, outcome }));
          if (OPEN.has(fixtureStatus)) {
            expect([p.decided, p.hold], at).toEqual([false, bridgeHold]);
            expect(p.watch?.over, at).toBe(bridge.status === "finished");
            seen.open += 1;
          } else if (fixtureStatus === AWAITING_DECISION) {
            expect([p.decided, p.hold], at).toEqual([false, levelHold]);
            expect(p.watch, at).toMatchObject({ over: true, clockRunning: false });
            seen.awaiting += 1;
          } else {
            expect([p.decided, p.hold], at).toEqual([true, null]);
            expect(p.watch, at).toMatchObject({ over: true, clockRunning: false });
            seen.settled += 1;
          }
          expect(p.status, `${at}: the bridge's status is passed on as it is`).toBe(bridge.status);
          checked += 1;
        }
      }
    }
    expect(checked, "anti-vacuity").toBe(FIXTURE_STATUSES.length * BRIDGES.length * OUTCOMES.length);
    expect(seen.open && seen.awaiting && seen.settled, "every class of status reached").toBeGreaterThan(0);
  });

  it("the move list is the ledger's, in the rules' notation; no game on file is no board", () => {
    expect(publicPlayOf(row({})).watch?.moves).toEqual(["e4", "e5", "Nf3"]);
    expect(publicPlayOf(row({ challenge_id: null })).watch).toBeNull();
  });

  it("a hold reason nobody declared is refused, never shown as some other hold", () => {
    expect(() => publicPlayOf(row({ status: "needs_organiser", needs_reason: "made_up" }))).toThrow(/unknown hold reason/);
  });
});

// I4 — the division Fixtures list's link (canvas WatchStatesDesktop A): "Watch live" while a game is being played,
// "Final position" (with the score, White first) once it is over, "Round not opened yet" before the organiser opens
// the round. Nothing for a board with no game to show (a bye, a no-show, a game not begun) — the row says the rest.
describe("watchLinkOf — what the Fixtures list offers for an online board", () => {
  const link = (o: Partial<WatchLinkRow>): WatchLinkRow => ({ ...row({}), round_opened: true, ...o });

  it("the empty case first: no bridge row, or a game with no move, once the round is open — Starting under a scheduled fixture (owner, 2026-10-13), nothing under any other", () => {
    let checked = 0;
    let starting = 0;
    for (const fixtureStatus of FIXTURE_STATUSES) {
      const want = fixtureStatus === "scheduled" ? { kind: "starting" } : null;
      expect(watchLinkOf(link({ status: null, challenge_id: null, move_count: 0, fixture_status: fixtureStatus })), fixtureStatus).toEqual(want);
      expect(watchLinkOf(link({ status: "ready", move_count: 0, fixture_status: fixtureStatus })), fixtureStatus).toEqual(want);
      if (want !== null) starting += 1;
      checked += 1;
    }
    expect(checked).toBe(FIXTURE_STATUSES.length);
    expect(starting, "the case the ruling exists for was reached").toBe(1);
  });

  // T17 owner change (2026-10-13): from the round's open until the first move the board reads STARTING — the watch
  // panel's "not started" (the start position, the waiting line). Only for a board a game can still start on: a
  // scheduled fixture, both players paired, no hold for the organiser, the bridge not closed.
  it("STARTING: the round open, both paired, no move on file, nothing held — every bridge state and hold reason", () => {
    const STARTING = { kind: "starting" } as const;
    const before = (o: Partial<WatchLinkRow>) => link({ fixture_status: "scheduled", move_count: 0, ...o });
    const cells: [string, WatchLinkRow, ReturnType<typeof watchLinkOf>][] = [
      ["no bridge row yet", before({ status: null, challenge_id: null }), STARTING],
      ["a bridge pending its challenge", before({ status: "pending", challenge_id: null }), STARTING],
      ["a challenge made, no move", before({ status: "ready" }), STARTING],
      ["the game begun at Lichess, no move", before({ status: "live" }), STARTING],
      ["a seat's token revoked before a move (the game goes on)", before({ status: "needs_organiser", needs_reason: "token_revoked" }), STARTING],
      ["the bridge closed with no move", before({ status: "finished" }), null],
      ["a bye: no away entrant", before({ status: null, challenge_id: null, away_entrant_id: null }), null],
      ["a bye: no home entrant", before({ status: null, challenge_id: null, home_entrant_id: null }), null],
      ["the round not opened", before({ status: null, challenge_id: null, round_opened: false }), { kind: "not_opened" }],
      ["the first move: live from here", before({ status: "live", move_count: 1 }), { kind: "live" }],
    ];
    // Every hold the organiser owes an answer to, before a move: the fixture page says why, so the row offers nothing.
    const HELD = ["no_show_white", "no_show_black", "no_show_both", "not_started", "aborted", "mismatch", "provider_error",
      "double_walkover_blocked", "create_outcome_unknown", "tiebreak_owed", "fair_play", "account_changed"] as const;
    for (const reason of HELD) cells.push([`held: ${reason}`, before({ status: "needs_organiser", needs_reason: reason }), null]);
    expect([...HELD, "token_revoked"].sort(), "every hold reason is a cell").toEqual([...NEEDS_REASONS].sort());
    let checked = 0;
    let starting = 0;
    for (const [label, r, want] of cells) {
      expect(watchLinkOf(r), label).toEqual(want);
      if (want?.kind === "starting") starting += 1;
      checked += 1;
    }
    expect(checked, "anti-vacuity").toBe(10 + HELD.length);
    expect(starting, "anti-vacuity: the starting cells").toBe(5);
  });

  it("every fixture status × bridge state × round opened or not", () => {
    // [label, bridge, round opened?, expected for an OPEN fixture, expected for one OUT of play]
    type Want = ReturnType<typeof watchLinkOf>;
    const FINAL: Want = { kind: "final", score: "", noResult: false };
    const cells: [string, Partial<WatchLinkRow>, boolean, Want, Want][] = [
      ["round not opened, no bridge", { status: null, challenge_id: null, move_count: 0 }, false, { kind: "not_opened" }, null],
      ["round not opened, a bridge pending", { status: "pending", challenge_id: null, move_count: 0 }, false, { kind: "not_opened" }, null],
      ["a game being played", { status: "live" }, true, { kind: "live" }, FINAL],
      ["a seat's token revoked (the game goes on)", { status: "needs_organiser", needs_reason: "token_revoked" }, true, { kind: "live" }, FINAL],
      ["held for fair play", { status: "needs_organiser", needs_reason: "fair_play" }, true, null, FINAL],
      ["held: a knockout draw (the game is over)", { status: "needs_organiser", needs_reason: "tiebreak_owed" }, true, FINAL, FINAL],
      ["the bridge closed", { status: "finished" }, true, FINAL, FINAL],
    ];
    let checked = 0;
    let voided = 0;
    for (const fixtureStatus of FIXTURE_STATUSES) {
      for (const [label, bridge, opened, wantOpen, wantOut] of cells) {
        const got = watchLinkOf(link({ ...bridge, round_opened: opened, fixture_status: fixtureStatus }));
        // I-3: an abandoned board is VOID — its final position says No result, never a score.
        const want = OPEN.has(fixtureStatus) ? wantOpen : fixtureStatus === "abandoned" && wantOut !== null ? { ...wantOut, noResult: true } : wantOut;
        expect(got, `${fixtureStatus} / ${label}`).toEqual(want);
        if (fixtureStatus === "abandoned" && wantOut !== null) voided += 1;
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity").toBe(FIXTURE_STATUSES.length * cells.length);
    expect(voided, "anti-vacuity: the abandoned cells").toBeGreaterThan(0);
  });

  it("the final position carries the result's score, White first — the away entrant plays White here", () => {
    const decided = link({
      status: "finished",
      fixture_status: "decided",
      white_side: "away",
      outcome: { kind: "win", winner: HOME },
      summary: { perSide: [{ entrantId: HOME, line: "1" }, { entrantId: AWAY, line: "0" }] },
    });
    expect(watchLinkOf(decided)).toEqual({ kind: "final", score: "0–1", noResult: false });
    expect(watchLinkOf({ ...decided, white_side: "home" })).toEqual({ kind: "final", score: "1–0", noResult: false });
  });

  it("I-3: an ABANDONED board (VOID) reads No result — the header with no method or score, the link with no score — whatever outcome or summary the row carries; a decided board beside it keeps its result", () => {
    const rows: [string, Partial<WatchLinkRow>][] = [
      ["no outcome (an abandon decides nobody)", { outcome: null, summary: null }],
      ["a level outcome left by a bracket draw before the abandon", { outcome: { kind: "draw" }, summary: { perSide: [{ entrantId: HOME, line: "½" }, { entrantId: AWAY, line: "½" }] } }],
    ];
    let checked = 0;
    for (const [label, over] of rows) {
      const r = link({ status: "finished", fixture_status: "abandoned", finished_at: new Date("2026-10-13T10:00:00.000Z"), ...over });
      expect(publicResultOf(r), label).toEqual({ kind: "no_result", winner: null, method: null, score: "", recordedAt: "2026-10-13T10:00:00.000Z" });
      expect(watchLinkOf(r), label).toEqual({ kind: "final", score: "", noResult: true });
      // The pair: the same row decided reads its result.
      const decided = { ...r, fixture_status: "decided", outcome: { kind: "win", winner: HOME }, summary: { perSide: [{ entrantId: HOME, line: "1" }, { entrantId: AWAY, line: "0" }] } };
      expect(publicResultOf(decided)?.kind, label).toBe("win");
      expect(watchLinkOf(decided), label).toEqual({ kind: "final", score: "1–0", noResult: false });
      checked += 1;
    }
    expect(checked).toBe(2);
  });
});

