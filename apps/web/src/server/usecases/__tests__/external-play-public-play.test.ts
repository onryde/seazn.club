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
import { publicPlayOf, watchLinkOf, type PublicFixtureRow, type WatchLinkRow } from "../external-play-read";

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

  it("the empty case first: no bridge row, or a game with no move, offers nothing once the round is open", () => {
    let checked = 0;
    for (const fixtureStatus of FIXTURE_STATUSES) {
      expect(watchLinkOf(link({ status: null, challenge_id: null, move_count: 0, fixture_status: fixtureStatus })), fixtureStatus).toBeNull();
      expect(watchLinkOf(link({ status: "ready", move_count: 0, fixture_status: fixtureStatus })), fixtureStatus).toBeNull();
      checked += 1;
    }
    expect(checked).toBe(FIXTURE_STATUSES.length);
  });

  it("every fixture status × bridge state × round opened or not", () => {
    // [label, bridge, round opened?, expected for an OPEN fixture, expected for one OUT of play]
    type Want = ReturnType<typeof watchLinkOf>;
    const FINAL: Want = { kind: "final", score: "" };
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
    for (const fixtureStatus of FIXTURE_STATUSES) {
      for (const [label, bridge, opened, wantOpen, wantOut] of cells) {
        const got = watchLinkOf(link({ ...bridge, round_opened: opened, fixture_status: fixtureStatus }));
        expect(got, `${fixtureStatus} / ${label}`).toEqual(OPEN.has(fixtureStatus) ? wantOpen : wantOut);
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity").toBe(FIXTURE_STATUSES.length * cells.length);
  });

  it("the final position carries the result's score, White first — the away entrant plays White here", () => {
    const decided = link({
      status: "finished",
      fixture_status: "decided",
      white_side: "away",
      outcome: { kind: "win", winner: HOME },
      summary: { perSide: [{ entrantId: HOME, line: "1" }, { entrantId: AWAY, line: "0" }] },
    });
    expect(watchLinkOf(decided)).toEqual({ kind: "final", score: "0–1" });
    expect(watchLinkOf({ ...decided, white_side: "home" })).toEqual({ kind: "final", score: "1–0" });
  });
});

