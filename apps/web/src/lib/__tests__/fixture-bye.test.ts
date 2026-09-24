// #850 — "does this bye SCORE?" asked once, of `lib/fixture-bye.ts`.
//
// OWNER RULING (#850): a round-robin (league/group) stage persists a REAL bye
// row per round, but that bye awards no points and is not a played match —
// unlike a Swiss sit-out or a bracket bye, which count as a win. Every reader
// (standings fold, qualification view, player stats, public player matches,
// desk card stats, withdrawal policy) asks `isScoringBye` / `isRestBye` rather
// than restating a stage-kind check.
//
// The kind table is DERIVED from the engine's own `StageKind` enum, never typed
// out here, so a kind added to the engine is swept by these tests the day it
// lands (it scores by default — the pre-#850 behaviour — unless the owner
// rules otherwise and adds it to REST_BYE_STAGE_KINDS).
import { describe, expect, it } from "vitest";
import { StageKind } from "@seazn/engine/core";
import {
  DRAW_BYE_SLOT_LABEL,
  hasRestByeKey,
  isDrawBye,
  isOneSidedAwardBye,
  isRestBye,
  isScoringBye,
  placeRestByesInRounds,
  REST_BYE_EXT_KEY_PATTERN,
  REST_BYE_STAGE_KINDS,
  restByeExtKey,
} from "@/lib/fixture-bye";

// A rest bye is MARKED at creation (#850, owner ruling 2026-09-24, fourth
// round): the generator's bye key, `restByeExtKey`, is the marker. Every
// fixture below that stands for a rest bye carries it, written by the SAME
// function the generator and the reconciler use.
const BYE = { outcome: { kind: "award", winner: "e1" }, home_entrant_id: "e1", away_entrant_id: null, ext_key: restByeExtKey("", 1) };
const AWAY_BYE = { outcome: { kind: "award", winner: "e2" }, home_entrant_id: null, away_entrant_id: "e2", ext_key: restByeExtKey("pA-", 2) };
/** The SAME row shape as `BYE` — one seat, an award to it — with a MATCH key:
 *  what `awardSeededByes` leaves on a fed league's line when a qualifier
 *  departed before the draw. A walkover, not a rest. */
const WALKOVER = { outcome: { kind: "award", winner: "e1" }, home_entrant_id: "e1", away_entrant_id: null, ext_key: "rr-r1-c2" };

/** Shapes that are NOT a system bye in any stage kind — each must be neither
 *  a scoring bye nor a rest bye, whatever the kind. */
const NOT_BYES = {
  "two-sided forfeit": { outcome: { kind: "award", winner: "b" }, home_entrant_id: "a", away_entrant_id: "b" },
  "one seat, winner not seated": { outcome: { kind: "award", winner: "ghost" }, home_entrant_id: "e1", away_entrant_id: null },
  "played win": { outcome: { kind: "win", winner: "a", loser: "b" }, home_entrant_id: "a", away_entrant_id: "b" },
  "unseated shell": { outcome: null, home_entrant_id: null, away_entrant_id: null },
  "orphaned award (both seats gone)": { outcome: { kind: "award", winner: "e1" }, home_entrant_id: null, away_entrant_id: null },
} as const;

describe("REST_BYE_STAGE_KINDS (owner ruling #850)", () => {
  it("is exactly the round-robin kinds: league and group", () => {
    expect([...REST_BYE_STAGE_KINDS].sort()).toEqual(["group", "league"]);
  });
  it("names only real engine stage kinds", () => {
    for (const k of REST_BYE_STAGE_KINDS) expect(StageKind.options).toContain(k);
  });
});

describe("the rest-bye MARKER (owner ruling 2026-09-24, fourth round)", () => {
  it("restByeExtKey spells the generator's key, pool-prefixed in a group stage", () => {
    expect(restByeExtKey("", 3)).toBe("rr-r3-bye");
    expect(restByeExtKey("pB-", 12)).toBe("pB-rr-r12-bye");
  });

  it("hasRestByeKey: exactly the bye keys — never a match key, a Swiss bye key, an ad-hoc key, or none", () => {
    for (const k of ["rr-r1-bye", "rr-r10-bye", "pA-rr-r2-bye", "p12-rr-r7-bye"]) expect(hasRestByeKey(k), k).toBe(true);
    for (const k of ["rr-r1-c1", "pA-rr-r2-c3", "sw-r1-bye", "adhoc-6", "xrr-r1-bye", "rr-r1-bye-2", "rr-rX-bye", "r1-m1", "", null, undefined]) {
      expect(hasRestByeKey(k), String(k)).toBe(false);
    }
  });

  it("the pattern is ONE string both JavaScript and Postgres read the same way (no escapes, no lookarounds)", () => {
    expect(REST_BYE_EXT_KEY_PATTERN).not.toMatch(/\\|\(\?/);
  });

  // The differential the fourth ruling exists for: the SAME row shape in the
  // SAME league answers differently by its marker. A predicate that still read
  // shape alone would call both rest byes (and stop the walkover scoring).
  it("a fed league's walkover is a SCORING bye, not a rest bye; the marked row beside it is a rest bye", () => {
    expect(isOneSidedAwardBye(WALKOVER)).toBe(true);
    for (const kind of ["league", "group"]) {
      expect(isRestBye(WALKOVER, kind), kind).toBe(false);
      expect(isScoringBye(WALKOVER, kind), kind).toBe(true);
      expect(isRestBye(BYE, kind), kind).toBe(true);
      expect(isScoringBye(BYE, kind), kind).toBe(false);
    }
  });

  it("the marker alone is not enough: a marked row that is not a one-sided award bye is neither", () => {
    for (const [label, f] of Object.entries(NOT_BYES)) {
      const marked = { ...f, ext_key: restByeExtKey("", 1) };
      expect(isRestBye(marked, "league"), label).toBe(false);
      expect(isScoringBye(marked, "league"), label).toBe(false);
    }
  });

  it("a row read without its ext_key is never a rest bye (it keeps the pre-#850 answer: it scores)", () => {
    const bare = { outcome: BYE.outcome, home_entrant_id: BYE.home_entrant_id, away_entrant_id: BYE.away_entrant_id };
    expect(isRestBye(bare, "league")).toBe(false);
    expect(isScoringBye(bare, "league")).toBe(true);
  });
});

describe("isScoringBye / isRestBye", () => {
  // The differential the ruling exists for: the SAME row answers differently
  // by stage kind. A test that only ever asked Swiss could not tell a gate
  // that does nothing from one that works.
  it("the same bye row scores in a Swiss stage and does NOT score in a league", () => {
    expect(isScoringBye(BYE, "swiss")).toBe(true);
    expect(isScoringBye(BYE, "league")).toBe(false);
    expect(isRestBye(BYE, "swiss")).toBe(false);
    expect(isRestBye(BYE, "league")).toBe(true);
  });

  it("a group-stage bye is a rest bye too (away-seated shape included)", () => {
    expect(isRestBye(AWAY_BYE, "group")).toBe(true);
    expect(isScoringBye(AWAY_BYE, "group")).toBe(false);
  });

  // Enumerate the table rather than trust two samples (failure class 7).
  it.each(StageKind.options)("kind %s: a bye is exactly one of scoring / rest, split by REST_BYE_STAGE_KINDS", (kind) => {
    const rest = REST_BYE_STAGE_KINDS.has(kind);
    for (const bye of [BYE, AWAY_BYE]) {
      expect(isOneSidedAwardBye(bye)).toBe(true);
      expect(isRestBye(bye, kind)).toBe(rest);
      expect(isScoringBye(bye, kind)).toBe(!rest);
    }
  });

  it.each(StageKind.options)("kind %s: a row that is not a bye is neither", (kind) => {
    for (const [, f] of Object.entries(NOT_BYES)) {
      expect(isRestBye(f, kind)).toBe(false);
      expect(isScoringBye(f, kind)).toBe(false);
    }
  });

  it("an unknown kind string keeps the pre-#850 behaviour (the bye scores)", () => {
    expect(isScoringBye(BYE, "not-a-kind")).toBe(true);
    expect(isRestBye(BYE, "not-a-kind")).toBe(false);
  });
});

// #850 review round 3: the DRAW's bye by its marker, the ONE question the
// bracket cascade (`resolveBracketSeats`) asks of a dead loser feeder and
// `isSitOutBye` asks for a bracket kind. Same row, both labels: only the
// draw's marker answers yes.
describe("isDrawBye", () => {
  const plain = { key: DRAW_BYE_SLOT_LABEL.key, params: {} };
  const byeOn = (label: unknown, seat: "home" | "away") =>
    seat === "away"
      ? { outcome: { kind: "award", winner: "e1" }, home_entrant_id: "e1", away_entrant_id: null, home_slot_label: null, away_slot_label: label }
      : { outcome: { kind: "award", winner: "e1" }, home_entrant_id: null, away_entrant_id: "e1", home_slot_label: label, away_slot_label: null };

  it.each(["home", "away"] as const)("the draw's marker on the empty %s seat is a draw bye; the plain bye label is not", (seat) => {
    expect(isDrawBye(byeOn(DRAW_BYE_SLOT_LABEL, seat))).toBe(true);
    expect(isDrawBye(byeOn(plain, seat))).toBe(false);
    expect(isDrawBye(byeOn(null, seat))).toBe(false);
  });

  it("the marker on the SEATED side does not count — the empty seat is the one read", () => {
    const f = { ...byeOn(plain, "away"), home_slot_label: DRAW_BYE_SLOT_LABEL };
    expect(isDrawBye(f)).toBe(false);
  });

  it("a row that is not a one-sided award bye is never a draw bye, whatever its labels", () => {
    for (const [, f] of Object.entries(NOT_BYES)) {
      expect(isDrawBye({ ...f, home_slot_label: DRAW_BYE_SLOT_LABEL, away_slot_label: DRAW_BYE_SLOT_LABEL })).toBe(false);
    }
  });
});

// #850 — where a rest bye sits on a list-shaped surface: INSIDE ITS ROUND (and
// pool), after the round's last row in render order. Shared by the organiser
// run sheet and the public schedule, so the two cannot place it differently.
describe("placeRestByesInRounds", () => {
  type R = { id: string; stage_id: string; pool_id?: string | null; round_no: number; bye?: boolean };
  const m = (id: string, round: number, pool: string | null = null, stage = "s"): R => ({ id, stage_id: stage, pool_id: pool, round_no: round });
  const b = (id: string, round: number, pool: string | null = null, stage = "s"): R => ({ ...m(id, round, pool, stage), bye: true });
  const ids = (lists: R[][]) => lists.map((l) => l.map((r) => r.id));
  const isMate = (r: R) => !r.bye;

  it("the empty case: no byes changes nothing and places nothing", () => {
    const lists = [[m("a", 1)]];
    expect(placeRestByesInRounds(lists, [], isMate)).toEqual([]);
    expect(ids(lists)).toEqual([["a"]]);
  });

  it("after the LAST row of its round, across groups — not the first, not the end of the list", () => {
    const lists = [[m("r1a", 1), m("r2a", 2)], [m("r1b", 1), m("r3a", 3)]];
    expect(placeRestByesInRounds(lists, [b("bye1", 1)], isMate)).toEqual([]);
    expect(ids(lists)).toEqual([["r1a", "r2a"], ["r1b", "bye1", "r3a"]]);
  });

  it("inside its own POOL's round: a pool B bye ignores pool A's later rows", () => {
    const lists = [[m("A1", 1, "A"), m("B1", 1, "B"), m("A2", 1, "A")]];
    placeRestByesInRounds(lists, [b("Bbye", 1, "B"), b("Abye", 1, "A")], isMate);
    expect(ids(lists)).toEqual([["A1", "B1", "Bbye", "A2", "Abye"]]);
  });

  it("another bye is never a round-mate; a different stage's same round is not either", () => {
    const lists = [[m("s1", 1), b("other", 1), m("t1", 1, null, "t")]];
    placeRestByesInRounds(lists, [b("bye", 1)], isMate);
    expect(ids(lists)).toEqual([["s1", "bye", "other", "t1"]]);
  });

  // Review round 2, R2-5 — `open`: never in a different block from a round-mate
  // still to play. Both directions: with an open mate the bye leaves the LAST
  // block for the open mate's; with none it keeps the plain "after the last".
  it("open: follows the round's last OPEN mate's block; with no open mate, the plain last-row rule", () => {
    type O = R & { open?: boolean };
    const isOpen = (r: O) => r.open === true;
    const played = (id: string, round: number): O => ({ ...m(id, round), open: false });
    const waiting = (id: string, round: number): O => ({ ...m(id, round), open: true });
    const withOpen: O[][] = [[waiting("w1", 1), m("x2", 2)], [played("p1", 1)]];
    placeRestByesInRounds(withOpen, [b("bye", 1)], isMate, { open: isOpen });
    expect(ids(withOpen)).toEqual([["w1", "bye", "x2"], ["p1"]]);
    const allPlayed: O[][] = [[played("q1", 1), m("x2", 2)], [played("p1", 1)]];
    placeRestByesInRounds(allPlayed, [b("bye", 1)], isMate, { open: isOpen });
    expect(ids(allPlayed)).toEqual([["q1", "x2"], ["p1", "bye"]]);
    // Without the option, the plain rule — the last row — even beside an open mate.
    const plain: O[][] = [[waiting("w1", 1)], [played("p1", 1)]];
    placeRestByesInRounds(plain, [b("bye", 1)], isMate);
    expect(ids(plain)).toEqual([["w1"], ["p1", "bye"]]);
  });

  it("no round-mate: returned unplaced (the caller's fallback), the lists untouched", () => {
    const lists = [[m("r1", 1)]];
    const bye = b("bye4", 4);
    expect(placeRestByesInRounds(lists, [bye], isMate)).toEqual([bye]);
    expect(ids(lists)).toEqual([["r1"]]);
  });

  it("`nearest` (one entrant's filtered list): after the previous round's row, else before the next round's", () => {
    const lists = [[m("r1", 1), m("r2", 2), m("r4", 4)]];
    placeRestByesInRounds(lists, [b("bye3", 3)], isMate, { nearest: true });
    expect(ids(lists)).toEqual([["r1", "r2", "bye3", "r4"]]);
    const first = [[m("r2", 2), m("r3", 3)]];
    placeRestByesInRounds(first, [b("bye1", 1)], isMate, { nearest: true });
    expect(ids(first)).toEqual([["bye1", "r2", "r3"]]);
    // Without `nearest` the same byes are left to the caller.
    expect(placeRestByesInRounds([[m("r2", 2)]], [b("bye1", 1)], isMate)).toHaveLength(1);
  });
});
