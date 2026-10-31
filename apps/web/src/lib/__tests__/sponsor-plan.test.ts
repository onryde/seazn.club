// R4 sponsors on stream, S4: the pure sponsor planner (spec 2026-10-27 §3.2; plan decisions P2, P7; rulings R2, R3, R4).
//
// Where the expected values come from — never from the planner's own output:
//   - the dial: spec §3.2 "Light = every major; Normal = every major + every 3rd minor; Busy = every major + every minor",
//     P2 "every 3rd minor counts every minor break of the fixture, hidden ones included";
//   - the rotation: SPONSOR_TIER_WEIGHTS (S3, pinned to the owner's D9 table by sponsor-tiers.test.ts) folded through
//     `p7Oracle` below, which restates P7 from its text and is itself pinned to hand-worked traces;
//   - the constants: the spec's own numbers (90 s, 8 s / 15 s, 20 s, 10 s).
//
// The sport-shaped break patterns here are SYNTHETIC (`{ kind, size }` only): engine 1.1.0, which declares the real
// `naturalBreaks.kinds`, is not installable in web yet (controller ruling for S4). The sweep over every real module's
// declared kinds is owed by S5.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { momentIdOf } from "@/components/overlay/moment-queue";
import type { OverlayMoment } from "@/lib/overlay-moments";
import {
  NORMAL_MINOR_EVERY,
  SCENE_CAROUSEL_MS,
  SPONSOR_COOLDOWN_MS,
  SPONSOR_STALE_MS,
  SPONSOR_STYLE_BY_SIZE,
  SponsorPlanInputError,
  eligibleBreaks,
  graphicsHiddenAt,
  planSponsors,
  playNextChoiceAt,
  sponsorMomentId,
  weightedCycle,
  type BreakDecl,
  type BreakOpened,
  type OperatorLogEntry,
  type OperatorLogField,
  type PlanInput,
  type SponsorAssignment,
  type SponsorCard,
  type SponsorFrequency,
  type SponsorPlanResult,
} from "@/lib/sponsor-plan";
import { SPONSOR_TIERS, SPONSOR_TIER_WEIGHTS, type SponsorTier } from "@/lib/sponsor-tiers";

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────────────────────

const T0 = Date.parse("2026-10-31T10:00:00.000Z");
const SEC = 1_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const brk = (seq: number, atMs: number, d: BreakDecl): BreakOpened => ({ seq, at: iso(atMs), kind: d.kind, size: d.size });

// Card ids differ from sponsor ids on purpose: an airing names a CARD, an assignment names a SPONSOR.
const card = (key: string, tier: SponsorTier): SponsorCard => ({
  id: `card-${key}`,
  sponsorId: `sponsor-${key}`,
  name: `${key} sponsor`,
  logoUrl: null,
  tier,
});
const TITLE = card("title", "title");
const GOLD = card("gold", "gold");
const SILVER = card("silver", "silver");
const PARTNER = card("partner", "partner");
const GOLD_B = card("gold-b", "gold");
const ALL = [TITLE, GOLD, SILVER, PARTNER, GOLD_B];
const cardOfSponsor = (sponsorId: string | null): SponsorCard | undefined => ALL.find((c) => c.sponsorId === sponsorId);

const on = (frequency: SponsorFrequency): PlanInput["settings"] => ({ enabled: true, frequency });

// Synthetic declarations (shape only — see the header).
const OVER_END: BreakDecl = { kind: "over_end", size: "minor" };
const INNINGS_BREAK: BreakDecl = { kind: "innings_break", size: "major" };
const CHANGEOVER: BreakDecl = { kind: "changeover", size: "minor" };
const SET_END: BreakDecl = { kind: "set_end", size: "major" };
const AFTER_GOAL: BreakDecl = { kind: "after_goal", size: "minor" };
const HALF_TIME: BreakDecl = { kind: "half_time", size: "major" };

function input(over: Partial<PlanInput> = {}): PlanInput {
  return {
    breaks: [],
    windowSeqs: [],
    settings: on("busy"),
    cards: [TITLE, GOLD, SILVER],
    assigned: [],
    operatorLog: [],
    nextPosition: 0,
    now: T0,
    complete: true,
    ...over,
  };
}

const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, k) => from + k);
const entry = (atMs: number, field: OperatorLogField, value: OperatorLogEntry["value"]): OperatorLogEntry => ({
  at: iso(atMs),
  field,
  value,
});
const seqsOf = (xs: readonly { seq: number }[]): number[] => xs.map((x) => x.seq);

/** Minors `spacingMs` apart from T0, seq 1..n. */
const minors = (n: number, spacingMs: number, d: BreakDecl = OVER_END): BreakOpened[] =>
  range(1, n).map((seq) => brk(seq, T0 + (seq - 1) * spacingMs, d));

/** P7, restated from its text (global-constraints.md) and written apart from the planner: each step adds every card's
 *  weight to its score, picks the highest score — a tie goes to the earliest card — and subtracts the total from the
 *  pick. Returns card indices for one full cycle. */
function p7Oracle(weights: readonly number[]): number[] {
  const total = weights.reduce((s, w) => s + w, 0);
  let scores = weights.map(() => 0);
  const picks: number[] = [];
  for (let n = 0; n < total; n++) {
    scores = scores.map((s, k) => s + weights[k]!);
    const pick = scores.indexOf(Math.max(...scores)); // indexOf ⇒ the earliest card wins a tie
    scores[pick] = scores[pick]! - total;
    picks.push(pick);
  }
  return picks;
}
const oracleSponsors = (cards: readonly SponsorCard[]): string[] =>
  p7Oracle(cards.map((c) => SPONSOR_TIER_WEIGHTS[c.tier])).map((k) => cards[k]!.sponsorId);

/**
 * A live match polled the way the overlay polls it: once just after each break opens (`lagMs` later). Each poll sees
 * the breaks so far, a `recent` window of the last `window` seqs, the assignments persisted so far, and the org's next
 * position (F9: max + 1). At EVERY poll it also asserts the planner's sequence invariants:
 *  - a second call with identical inputs answers identically (determinism);
 *  - re-polling with this poll's newAssignments persisted returns the same plan and no newAssignments;
 *  - no new assignment re-targets an assigned moment (frozen);
 *  - every airing's card belongs to the sponsor its assignment names.
 */
function liveMatch(o: {
  breaks: readonly BreakOpened[];
  cards: (seq: number) => readonly SponsorCard[];
  settings?: (seq: number) => PlanInput["settings"];
  operatorLog?: readonly OperatorLogEntry[];
  window?: number;
  lagMs?: number;
  startPosition?: number;
}): { assigned: SponsorAssignment[]; polls: number; airingsChecked: number; last: SponsorPlanResult | null } {
  const assigned: SponsorAssignment[] = [];
  let polls = 0;
  let airingsChecked = 0;
  let last: SponsorPlanResult | null = null;
  for (const b of o.breaks) {
    const inp: PlanInput = {
      breaks: o.breaks.filter((x) => x.seq <= b.seq),
      windowSeqs: range(Math.max(1, b.seq - (o.window ?? 50) + 1), b.seq),
      settings: (o.settings ?? (() => on("busy")))(b.seq),
      cards: o.cards(b.seq),
      assigned: [...assigned],
      operatorLog: o.operatorLog ?? [],
      nextPosition: nextPositionOf(assigned, o.startPosition),
      now: Date.parse(b.at) + (o.lagMs ?? SEC),
      complete: true,
    };
    const r = planSponsors(inp);
    expect(planSponsors(inp), `seq ${b.seq}: a second identical call`).toEqual(r);
    const known = new Set(assigned.map((a) => a.momentId));
    for (const a of r.newAssignments) expect(known.has(a.momentId), `seq ${b.seq}: re-targets ${a.momentId}`).toBe(false);
    const persisted = [...assigned, ...r.newAssignments];
    const again = planSponsors({ ...inp, assigned: persisted, nextPosition: nextPositionOf(persisted, o.startPosition) });
    expect(again.newAssignments, `seq ${b.seq}: re-poll assigns nothing`).toEqual([]);
    expect(again.plan, `seq ${b.seq}: re-poll keeps the plan`).toEqual(r.plan);
    for (const air of r.plan?.airings ?? []) {
      const a = persisted.find((x) => x.momentId === air.momentId);
      expect(a, `seq ${b.seq}: airing ${air.momentId} has an assignment`).toBeDefined();
      expect(r.plan!.cards.find((c) => c.id === air.cardId)?.sponsorId).toBe(a!.sponsorId);
      airingsChecked++;
    }
    assigned.push(...r.newAssignments);
    polls++;
    last = r;
  }
  return { assigned, polls, airingsChecked, last };
}
/** F9: the org's next free rotation position is max(position) + 1 (gaps allowed); `start` stands in for earlier matches. */
function nextPositionOf(assigned: readonly SponsorAssignment[], start = 0): number {
  return Math.max(start, ...assigned.map((a) => (a.position === null ? -1 : a.position + 1)));
}

// ── empty cases first (TEST-STRATEGY: a rule set states its empty case first) ───────────────────────────────────────

describe("planSponsors — the empty cases", () => {
  const freshMajor = [brk(1, T0, INNINGS_BREAK)];
  const frozen: SponsorAssignment = {
    momentId: sponsorMomentId(1, INNINGS_BREAK.kind),
    seq: 1,
    sponsorId: TITLE.sponsorId,
    sponsorName: TITLE.name,
    position: 0,
    source: "rotation",
    breakKind: INNINGS_BREAK.kind,
    style: SPONSOR_STYLE_BY_SIZE.major.style,
    holdMs: SPONSOR_STYLE_BY_SIZE.major.holdMs,
    operatorChoiceAt: null,
  };

  it("empty: settings null ⇒ null; no ticked card ⇒ null; enabled + ticked + no breaks ⇒ airings []", () => {
    // A fresh, in-window major and a frozen assignment are present in every case, so a null answers "rotation off",
    // not "nothing to plan".
    const loaded = { breaks: freshMajor, windowSeqs: [1], assigned: [frozen] };
    expect(planSponsors(input({ ...loaded, settings: null }))).toEqual({ plan: null, newAssignments: [], undone: [] });
    expect(planSponsors(input({ ...loaded, settings: { enabled: false, frequency: "busy" } }))).toEqual({
      plan: null,
      newAssignments: [],
      undone: [],
    });
    expect(planSponsors(input({ ...loaded, cards: [] }))).toEqual({ plan: null, newAssignments: [], undone: [] });

    const none = planSponsors(input({ breaks: [], windowSeqs: range(1, 12) }));
    expect(none.plan).toEqual({ cards: [TITLE, GOLD, SILVER], airings: [] });
    expect(none.newAssignments).toEqual([]);
  });

  it("the helpers' empty inputs: no cards ⇒ no cycle, no breaks ⇒ nothing eligible on any dial, an empty log ⇒ shown and no choice", () => {
    expect(weightedCycle([])).toEqual([]);
    const dials: SponsorFrequency[] = ["light", "normal", "busy"];
    for (const f of dials) expect(eligibleBreaks([], f), f).toEqual([]);
    expect(graphicsHiddenAt([], iso(T0))).toBe(false);
    expect(playNextChoiceAt([], iso(T0))).toBeNull();
  });

  it("a break-less sport (generic) plans airings: [] and plan non-null when enabled", () => {
    // Generic declares no natural breaks (spec §3.1), so its fold hands the planner no breaks while its events still
    // move the `recent` window. 40 polls, one per event (count reported).
    let polls = 0;
    for (let seq = 1; seq <= 40; seq++) {
      const r = planSponsors(input({ breaks: [], windowSeqs: range(Math.max(1, seq - 11), seq), now: T0 + seq * SEC }));
      expect(r.plan, `poll ${seq}`).toEqual({ cards: [TITLE, GOLD, SILVER], airings: [] });
      expect(r.newAssignments).toEqual([]);
      polls++;
    }
    expect(polls).toBe(40);
  });
});

// ── the spec's numbers ───────────────────────────────────────────────────────────────────────────────────────────

describe("the spec's constants and the moment id", () => {
  it("constants are the spec's values (§3.2: 90 s cooldown, every 3rd minor, minor → lower third 8 s, major → banner 15 s; §3.4: 20 s stale, 10 s carousel)", () => {
    expect(SPONSOR_COOLDOWN_MS).toBe(90 * SEC);
    expect(NORMAL_MINOR_EVERY).toBe(3);
    expect(SPONSOR_STYLE_BY_SIZE).toEqual({
      minor: { style: "lower_third", holdMs: 8 * SEC },
      major: { style: "banner", holdMs: 15 * SEC },
    });
    expect(SPONSOR_STALE_MS).toBe(20 * SEC);
    expect(SCENE_CAROUSEL_MS).toBe(10 * SEC);
  });

  it("sponsorMomentId is `${seq}:sponsor.${kind}`, the queue's own momentIdOf for a sponsor moment of that kind", () => {
    expect(sponsorMomentId(12, "over_end")).toBe("12:sponsor.over_end");
    // The queue keys on `${seq}:${kind}`; S6's sponsor moment carries kind `sponsor.${breakKind}`.
    const asMoment = { seq: 12, kind: "sponsor.over_end" } as unknown as OverlayMoment;
    expect(momentIdOf(asMoment)).toBe(sponsorMomentId(12, "over_end"));
  });
});

// ── P7 ──────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("weightedCycle — P7 smooth weighted round robin", () => {
  it("the test's P7 oracle reproduces traces worked by hand from the rule", () => {
    // weights 3,2,1 (title, gold, silver): scores 3,2,1→T | 0,4,2→G | 3,0,3 tie→T | 0,2,4→S | 3,4,-1→G | 6,0,0→T
    expect(p7Oracle([3, 2, 1])).toEqual([0, 1, 0, 2, 1, 0]);
    // weights 3,1: 3,1→0 | 2,2 tie→0 | 1,3→1 | 4,0→0
    expect(p7Oracle([3, 1])).toEqual([0, 0, 1, 0]);
    // weights 2,2: tie→0 | 0,4→1 | tie→0 | 0,4→1
    expect(p7Oracle([2, 2])).toEqual([0, 1, 0, 1]);
    // weights 3,2 (spec D14's title + gold): 3,2→0 | 1,4→1 | 4,1→0 | 2,3→1 | 5,0→0
    expect(p7Oracle([3, 2])).toEqual([0, 1, 0, 1, 0]);
  });

  it("weightedCycle(title, gold, silver) is one cycle of length Σ weights, and each card appears weight times (every ordered tier selection; count reported)", () => {
    const selections: SponsorCard[][] = [];
    const pick = (chosen: SponsorTier[]): void => {
      if (chosen.length > 0) selections.push(chosen.map((t) => card(t, t)));
      for (const t of SPONSOR_TIERS) if (!chosen.includes(t)) pick([...chosen, t]);
    };
    pick([]);
    let checked = 0;
    for (const cards of selections) {
      const cycle = weightedCycle(cards);
      const total = cards.reduce((s, c) => s + SPONSOR_TIER_WEIGHTS[c.tier], 0);
      expect(cycle.length, cards.map((c) => c.tier).join(",")).toBe(total);
      for (const c of cards) expect(cycle.filter((id) => id === c.id).length).toBe(SPONSOR_TIER_WEIGHTS[c.tier]);
      expect(cycle).toEqual(p7Oracle(cards.map((c) => SPONSOR_TIER_WEIGHTS[c.tier])).map((k) => cards[k]!.id));
      checked++;
    }
    // Ordered selections of 1..4 of the 4 tiers: 4 + 12 + 24 + 24.
    expect(checked).toBe(64);
    // The headline case, spelt out: title, gold, title, silver, gold, title.
    expect(weightedCycle([TITLE, GOLD, SILVER])).toEqual([TITLE.id, GOLD.id, TITLE.id, SILVER.id, GOLD.id, TITLE.id]);
  });

  it("ties go to the earlier card in resolveSponsors order: two golds alternate starting with whichever comes first", () => {
    expect(weightedCycle([GOLD, GOLD_B])).toEqual([GOLD.id, GOLD_B.id, GOLD.id, GOLD_B.id]);
    expect(weightedCycle([GOLD_B, GOLD])).toEqual([GOLD_B.id, GOLD.id, GOLD_B.id, GOLD.id]);
  });

  it("a card whose tier carries no weight is refused (a silent zero would drop it from the cycle)", () => {
    expect(() => weightedCycle([TITLE, { ...GOLD, tier: "bronze" as SponsorTier }])).toThrow(SponsorPlanInputError);
  });
});

// ── P2 ──────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("eligibleBreaks — the dial (P2)", () => {
  // A set-shaped fixture: three sets with 5, 4 and 4 short breaks, a long break closing each of the first two
  // (m m m m m M m m m m M m m m m). Seqs 1..15 in that order.
  const SET_SHAPE: BreakOpened[] = [
    ...[CHANGEOVER, CHANGEOVER, CHANGEOVER, CHANGEOVER, CHANGEOVER, SET_END],
    ...[CHANGEOVER, CHANGEOVER, CHANGEOVER, CHANGEOVER, SET_END],
    ...[CHANGEOVER, CHANGEOVER, CHANGEOVER, CHANGEOVER],
  ].map((d, k) => brk(k + 1, T0 + k * 120 * SEC, d));
  // Worked by hand from the rule. Minors are seqs 1-5, 7-10, 12-15 (13 of them); the 3rd, 6th, 9th and 12th minor
  // are seqs 3, 7, 10 and 14 — the count runs across the whole fixture, through the long breaks, never restarting.
  const SET_SHAPE_EXPECTED: Record<SponsorFrequency, number[]> = {
    light: [6, 11],
    normal: [3, 6, 7, 10, 11, 14],
    busy: range(1, 15),
  };

  // An over-shaped fixture (a T20): 19 short breaks, one long break at the 20th over (P1: one event, major only),
  // then 19 more short breaks.
  const OVER_SHAPE: BreakOpened[] = [
    ...range(1, 19).map(() => OVER_END),
    INNINGS_BREAK,
    ...range(1, 19).map(() => OVER_END),
  ].map((d, k) => brk((k + 1) * 6, T0 + k * 240 * SEC, d));

  it("each dial × a set-shaped and an over-shaped pattern: eligible count matches the size-derived rule (counts reported, 0 ⇒ fail)", () => {
    let checked = 0;
    const dials: SponsorFrequency[] = ["light", "normal", "busy"];
    for (const f of dials) {
      const got = eligibleBreaks(SET_SHAPE, f);
      expect(seqsOf(got), `set-shaped ${f}`).toEqual(SET_SHAPE_EXPECTED[f]);
      checked++;
    }
    const majorsOf = (bs: readonly BreakOpened[]) => bs.filter((b) => b.size === "major").length;
    const minorsOf = (bs: readonly BreakOpened[]) => bs.filter((b) => b.size === "minor").length;
    const rule: Record<SponsorFrequency, (bs: readonly BreakOpened[]) => number> = {
      light: (bs) => majorsOf(bs),
      normal: (bs) => majorsOf(bs) + Math.floor(minorsOf(bs) / 3),
      busy: (bs) => bs.length,
    };
    for (const f of dials) {
      const n = eligibleBreaks(OVER_SHAPE, f).length;
      expect(n, `over-shaped ${f}`).toBe(rule[f](OVER_SHAPE));
      expect(n, `over-shaped ${f} checked nothing`).toBeGreaterThan(0);
      checked++;
    }
    expect(checked).toBe(6);
    // The T20 by hand: 1 major, 38 minors ⇒ light 1, normal 1 + 12 = 13, busy 39.
    expect([1, 13, 39]).toEqual(dials.map((f) => eligibleBreaks(OVER_SHAPE, f).length));
  });

  it("an unknown dial is refused", () => {
    expect(() => eligibleBreaks(SET_SHAPE, "sometimes" as SponsorFrequency)).toThrow(SponsorPlanInputError);
  });
});

// ── the operator log readers ─────────────────────────────────────────────────────────────────────────────────────

describe("the operator log readers", () => {
  it("graphicsHiddenAt is the switch in force at the break: the latest entry at or before it (a tie goes to the later log row)", () => {
    const log = [
      entry(T0 + 10 * SEC, "graphics_hidden", true),
      entry(T0 + 5 * SEC, "scene", "break"), // other fields never move the switch
      entry(T0 + 30 * SEC, "graphics_hidden", false),
      entry(T0 + 40 * SEC, "graphics_hidden", true),
      entry(T0 + 40 * SEC, "graphics_hidden", false),
    ];
    expect(graphicsHiddenAt(log, iso(T0 + 9 * SEC))).toBe(false);
    expect(graphicsHiddenAt(log, iso(T0 + 10 * SEC))).toBe(true);
    expect(graphicsHiddenAt(log, iso(T0 + 29 * SEC))).toBe(true);
    expect(graphicsHiddenAt(log, iso(T0 + 30 * SEC))).toBe(false);
    expect(graphicsHiddenAt(log, iso(T0 + 41 * SEC))).toBe(false);
    // The log is read by time, not by row order; only a tie at one instant falls to row order — reversed, the later
    // row at 40 s is now the `true`.
    const reversed = [...log].reverse();
    expect(graphicsHiddenAt(reversed, iso(T0 + 20 * SEC))).toBe(true);
    expect(graphicsHiddenAt(reversed, iso(T0 + 35 * SEC))).toBe(false);
    expect(graphicsHiddenAt(reversed, iso(T0 + 41 * SEC))).toBe(true);
  });

  it("playNextChoiceAt: a choice set strictly before the break; a later choice replaces it; null clears it", () => {
    const log = [
      entry(T0, "next_sponsor_id", GOLD.sponsorId),
      entry(T0 + 10 * SEC, "next_sponsor_id", SILVER.sponsorId),
      entry(T0 + 20 * SEC, "next_sponsor_id", null),
    ];
    expect(playNextChoiceAt(log, iso(T0))).toBeNull(); // set AT the break, not before it
    expect(playNextChoiceAt(log, iso(T0 + 1))).toEqual({ sponsorId: GOLD.sponsorId, setAt: iso(T0) });
    expect(playNextChoiceAt(log, iso(T0 + 11 * SEC))).toEqual({ sponsorId: SILVER.sponsorId, setAt: iso(T0 + 10 * SEC) });
    expect(playNextChoiceAt(log, iso(T0 + 21 * SEC))).toBeNull();
  });

  it("a log value of the wrong type is refused", () => {
    expect(() => graphicsHiddenAt([entry(T0, "graphics_hidden", "yes")], iso(T0 + SEC))).toThrow(SponsorPlanInputError);
    expect(() => playNextChoiceAt([entry(T0, "next_sponsor_id", true)], iso(T0 + SEC))).toThrow(SponsorPlanInputError);
    expect(() => playNextChoiceAt([entry(T0, "next_sponsor_id", "")], iso(T0 + SEC))).toThrow(SponsorPlanInputError);
  });
});

// ── R4 ──────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("planSponsors — the 90 s cooldown (R4)", () => {
  const assignedSeqs = (breaks: BreakOpened[]): number[] =>
    seqsOf(liveMatch({ breaks, cards: () => [TITLE, GOLD, SILVER] }).assigned);

  it("cooldown: two minors 60 s apart on Busy assign only the first; 91 s apart assign both", () => {
    expect(assignedSeqs(minors(2, 60 * SEC))).toEqual([1]);
    expect(assignedSeqs(minors(2, 91 * SEC))).toEqual([1, 2]);
    // The edge: 90 s apart is no longer inside a 90 s cooldown; 1 ms short of it is.
    expect(assignedSeqs(minors(2, SPONSOR_COOLDOWN_MS))).toEqual([1, 2]);
    expect(assignedSeqs(minors(2, SPONSOR_COOLDOWN_MS - 1))).toEqual([1]);
  });

  it("the cooldown runs from the last CARD, not the last break: a minor 100 s after a card and 40 s after a thinned minor gets a card", () => {
    const breaks = [brk(1, T0, OVER_END), brk(2, T0 + 60 * SEC, OVER_END), brk(3, T0 + 100 * SEC, OVER_END)];
    expect(assignedSeqs(breaks)).toEqual([1, 3]);
  });

  it("a major is never thinned: after_goal at 44:30 then half_time at 45:00 both get a card; a minor 30 s after a major is thinned", () => {
    const min = (m: number, s: number): number => T0 + (m * 60 + s) * SEC;
    const breaks = [brk(10, min(44, 30), AFTER_GOAL), brk(11, min(45, 0), HALF_TIME), brk(12, min(45, 30), AFTER_GOAL)];
    expect(assignedSeqs(breaks)).toEqual([10, 11]);
  });
});

// ── R2 ──────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("planSponsors — which breaks get a NEW assignment (R2)", () => {
  it("a first poll mid-match assigns only the fresh break in the window, not every past eligible break", () => {
    // 25 overs, 4 minutes apart: on Busy every one is eligible and none is inside another's cooldown.
    const breaks = minors(25, 240 * SEC);
    const last = breaks.at(-1)!;
    const r = planSponsors(input({ breaks, windowSeqs: range(14, 25), now: Date.parse(last.at) + 2 * SEC }));
    expect(eligibleBreaks(breaks, "busy").length, "past eligible breaks").toBe(25);
    expect(seqsOf(r.newAssignments)).toEqual([25]);
    expect(seqsOf(r.plan!.airings)).toEqual([25]);
  });

  it("the dial counts every minor of the fixture, not the window's: on Normal a window of minors 8-10 assigns minor 9", () => {
    // Minors 1-7 every 200 s, then 8, 9, 10 five seconds apart, polled 2 s after the 10th. Counted across the fixture,
    // minor 9 is the 3rd/6th/9th (eligible) and 10 is not; counted inside the window, the 3rd would be minor 10.
    const early = range(1, 7).map((seq) => brk(seq, T0 + (seq - 1) * 200 * SEC, OVER_END));
    const t = T0 + 7 * 200 * SEC;
    const breaks = [...early, brk(8, t, OVER_END), brk(9, t + 5 * SEC, OVER_END), brk(10, t + 10 * SEC, OVER_END)];
    const r = planSponsors(input({ breaks, windowSeqs: [8, 9, 10], settings: on("normal"), now: t + 12 * SEC }));
    expect(seqsOf(r.newAssignments)).toEqual([9]);
  });

  it("freshness: a break exactly SPONSOR_STALE_MS old is assigned, 1 ms older is not; a fresh break outside the window is not", () => {
    const breaks = [brk(1, T0, INNINGS_BREAK)];
    expect(planSponsors(input({ breaks, windowSeqs: [1], now: T0 + SPONSOR_STALE_MS })).newAssignments).toHaveLength(1);
    expect(planSponsors(input({ breaks, windowSeqs: [1], now: T0 + SPONSOR_STALE_MS + 1 })).newAssignments).toEqual([]);
    expect(planSponsors(input({ breaks, windowSeqs: [2, 3], now: T0 + SEC })).newAssignments).toEqual([]);
  });
});

// ── the rotation ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("planSponsors — the rotation (D9, D14, P7)", () => {
  it("tier weights over 30 breaks with title+gold+silver ticked: 15 / 10 / 5 (derived from SPONSOR_TIER_WEIGHTS)", () => {
    const cards = [TITLE, GOLD, SILVER];
    const total = cards.reduce((s, c) => s + SPONSOR_TIER_WEIGHTS[c.tier], 0);
    // From the org's first position, and from mid-cycle (D14: the cursor is the org's, so a match can start anywhere).
    for (const startPosition of [0, 7]) {
      const { assigned, polls } = liveMatch({ breaks: minors(30, 100 * SEC), cards: () => cards, startPosition });
      expect(polls).toBe(30);
      expect(assigned).toHaveLength(30);
      for (const c of cards) {
        const expected = (SPONSOR_TIER_WEIGHTS[c.tier] * 30) / total;
        expect(assigned.filter((a) => a.sponsorId === c.sponsorId).length, `${c.tier} from ${startPosition}`).toBe(expected);
      }
      expect(cards.map((c) => (SPONSOR_TIER_WEIGHTS[c.tier] * 30) / total)).toEqual([15, 10, 5]);
      expect(assigned.map((a) => a.position)).toEqual(range(startPosition, startPosition + 29));
    }
  });

  it("positions continue from nextPosition (D14, F9); each pick is the P7 cycle at position mod length, carrying the card's sponsor and name", () => {
    // Three majors in one poll (majors are never thinned), the org's cursor at 4.
    const breaks = [brk(3, T0, SET_END), brk(4, T0 + 2 * SEC, SET_END), brk(5, T0 + 4 * SEC, SET_END)];
    const cards = [TITLE, GOLD, SILVER];
    const r = planSponsors(input({ breaks, windowSeqs: [3, 4, 5], cards, nextPosition: 4, now: T0 + 5 * SEC }));
    const cycle = oracleSponsors(cards);
    expect(r.newAssignments.map((a) => a.position)).toEqual([4, 5, 6]);
    expect(r.newAssignments.map((a) => a.sponsorId)).toEqual([4, 5, 6].map((p) => cycle[p % cycle.length]));
    for (const a of r.newAssignments) {
      expect(a.source).toBe("rotation");
      expect(a.operatorChoiceAt).toBeNull();
      expect(a.sponsorName).toBe(cardOfSponsor(a.sponsorId)!.name);
      expect(a.style).toBe(SPONSOR_STYLE_BY_SIZE.major.style);
      expect(a.holdMs).toBe(SPONSOR_STYLE_BY_SIZE.major.holdMs);
      expect(a.momentId).toBe(sponsorMomentId(a.seq, SET_END.kind));
    }
    expect(r.plan!.airings).toEqual(
      r.newAssignments.map((a) => ({
        momentId: a.momentId,
        seq: a.seq,
        cardId: cardOfSponsor(a.sponsorId)!.id,
        style: "banner",
        holdMs: 15 * SEC,
        breakKind: SET_END.kind,
      })),
    );
    // A minor's card is the lower third (spec: minor → lower third 8 s).
    const m = planSponsors(input({ breaks: [brk(1, T0, CHANGEOVER)], windowSeqs: [1], now: T0 + SEC }));
    expect(m.plan!.airings[0]).toMatchObject({ style: "lower_third", holdMs: 8 * SEC, breakKind: CHANGEOVER.kind });
  });
});

// ── the sequence ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("planSponsors — the sequence", () => {
  it("a re-plan with the same inputs plus its own newAssignments returns the same plan and no newAssignments", () => {
    // liveMatch asserts it at every poll; here over both break patterns, a hidden spell and a play-next choice, then once
    // more a minute after the last break (time moving on assigns nothing new).
    const setShape = [CHANGEOVER, CHANGEOVER, SET_END, CHANGEOVER, CHANGEOVER, CHANGEOVER, SET_END, CHANGEOVER].map(
      (d, k) => brk(k + 1, T0 + k * 100 * SEC, d),
    );
    const overShape = [...range(1, 9).map(() => OVER_END), INNINGS_BREAK, ...range(1, 9).map(() => OVER_END)].map(
      (d, k) => brk(k + 1, T0 + k * 100 * SEC, d),
    );
    const log = [
      entry(T0 + 150 * SEC, "graphics_hidden", true),
      entry(T0 + 250 * SEC, "graphics_hidden", false),
      entry(T0 + 450 * SEC, "next_sponsor_id", SILVER.sponsorId),
    ];
    let polls = 0;
    let assignedChecked = 0;
    let airingsChecked = 0;
    let operatorChecked = 0;
    for (const breaks of [setShape, overShape]) {
      for (const f of ["light", "normal", "busy"] as const) {
        const run = liveMatch({ breaks, cards: () => [TITLE, GOLD, SILVER], settings: () => on(f), operatorLog: log, window: 6 });
        polls += run.polls;
        expect(run.assigned.length, `${f}: assigned something to re-plan`).toBeGreaterThan(0);
        assignedChecked += run.assigned.length;
        airingsChecked += run.airingsChecked;
        operatorChecked += run.assigned.filter((a) => a.source === "operator").length;
        const later = planSponsors(
          input({
            breaks,
            windowSeqs: range(breaks.length - 5, breaks.length),
            settings: on(f),
            assigned: run.assigned,
            operatorLog: log,
            nextPosition: nextPositionOf(run.assigned),
            now: Date.parse(breaks.at(-1)!.at) + 60 * SEC,
          }),
        );
        expect(later.newAssignments).toEqual([]);
        expect(later.plan).toEqual(run.last!.plan);
      }
    }
    expect(polls).toBe(3 * (8 + 19));
    expect(assignedChecked).toBeGreaterThan(0);
    expect(airingsChecked).toBeGreaterThan(0);
    // The choice takes exactly one break in each of the six runs (every dial has a major after it in both patterns).
    expect(operatorChecked).toBe(6);
  });

  it("an undone break event is absent from breaks ⇒ its unaired moment leaves plan.airings; `undone` names it only on a complete replay (R3)", () => {
    const first = planSponsors(input({ breaks: [brk(5, T0, SET_END)], windowSeqs: [5], now: T0 + SEC }));
    const a = first.newAssignments[0]!;
    expect(seqsOf(first.plan!.airings)).toEqual([5]);
    // The break event is undone: the replay no longer opens it.
    const after = { breaks: [], windowSeqs: [5, 6], assigned: [a], now: T0 + 3 * SEC };
    const complete = planSponsors(input({ ...after, complete: true }));
    expect(complete.plan!.airings).toEqual([]);
    expect(complete.newAssignments).toEqual([]);
    expect(complete.undone).toEqual([a]);
    // A partial replay (the module refused part-way) proves nothing about the missing breaks: no deletion candidate.
    const partial = planSponsors(input({ ...after, complete: false }));
    expect(partial.plan!.airings).toEqual([]);
    expect(partial.undone).toEqual([]);
    // Rotation off does not stop S5 tidying the undone row.
    expect(planSponsors(input({ ...after, settings: null })).undone).toEqual([a]);
    // A live assignment is never a candidate.
    expect(planSponsors(input({ breaks: [brk(5, T0, SET_END)], windowSeqs: [5], assigned: [a], now: T0 + 2 * SEC })).undone).toEqual([]);
  });

  it("a sponsor unticked mid-match: frozen breaks keep it; later breaks never pick it", () => {
    // Title + gold cycle title, gold, title, gold, title. Majors 30 s apart, polled 1 s after each, the window wide
    // enough to hold every break.
    const breaks = range(1, 6).map((seq) => brk(seq, T0 + (seq - 1) * 30 * SEC, SET_END));
    const window = range(1, 6);
    const assigned: SponsorAssignment[] = [];
    const poll = (seq: number, cards: SponsorCard[]): SponsorPlanResult => {
      const r = planSponsors(
        input({
          breaks: breaks.slice(0, seq),
          windowSeqs: window,
          cards,
          assigned: [...assigned],
          nextPosition: nextPositionOf(assigned),
          now: Date.parse(breaks[seq - 1]!.at) + SEC,
        }),
      );
      assigned.push(...r.newAssignments);
      return r;
    };
    poll(1, [TITLE, GOLD]);
    poll(2, [TITLE, GOLD]);
    const goldMoment = assigned.find((a) => a.sponsorId === GOLD.sponsorId)!;
    expect(goldMoment.seq, "the cycle's second turn is gold's").toBe(2);
    // Gold is unticked.
    for (const seq of [3, 4, 5]) {
      const r = poll(seq, [TITLE]);
      expect(r.newAssignments.map((a) => a.momentId)).not.toContain(goldMoment.momentId);
      expect(r.newAssignments.every((a) => a.sponsorId === TITLE.sponsorId)).toBe(true);
      // Gold's frozen break is not handed to anyone else.
      expect(r.plan!.airings.find((x) => x.momentId === goldMoment.momentId)).toBeUndefined();
    }
    expect(assigned.filter((a) => a.momentId === goldMoment.momentId)).toEqual([goldMoment]);
    // Gold is ticked again: its frozen break still names gold.
    const back = poll(6, [TITLE, GOLD]);
    expect(back.plan!.airings.find((x) => x.momentId === goldMoment.momentId)?.cardId).toBe(GOLD.id);
  });

  it("a deleted sponsor (its assignment's sponsorId goes null) drops from airings; nothing is re-handed and later positions do not move", () => {
    const deleted: SponsorAssignment = {
      momentId: sponsorMomentId(1, SET_END.kind),
      seq: 1,
      sponsorId: null,
      sponsorName: GOLD.name,
      position: 3,
      source: "rotation",
      breakKind: SET_END.kind,
      style: "banner",
      holdMs: 15 * SEC,
      operatorChoiceAt: null,
    };
    const r = planSponsors(
      input({
        breaks: [brk(1, T0, SET_END), brk(2, T0 + 5 * SEC, SET_END)],
        windowSeqs: [1, 2],
        cards: [TITLE, SILVER],
        assigned: [deleted],
        nextPosition: 4,
        now: T0 + 6 * SEC,
      }),
    );
    expect(seqsOf(r.newAssignments)).toEqual([2]);
    expect(r.newAssignments[0]!.position).toBe(4);
    expect(seqsOf(r.plan!.airings)).toEqual([2]);
  });

  it("frozen sequence: dial change, then tick/untick and a tier change — every earlier assignment keeps its sponsor; only later breaks move", () => {
    // 48 minors 100 s apart (never inside a cooldown). Phase 1 (seqs 1-12) Busy with title, gold, silver; phase 2
    // (13-24) the dial goes to Normal; phase 3 (25-36) silver is unticked and partner ticked; phase 4 (37-48) gold
    // becomes a title sponsor.
    const breaks = minors(48, 100 * SEC);
    const GOLD_AS_TITLE: SponsorCard = { ...GOLD, tier: "title" };
    const cardsAt = (seq: number): SponsorCard[] =>
      seq <= 24 ? [TITLE, GOLD, SILVER] : seq <= 36 ? [TITLE, GOLD, PARTNER] : [TITLE, GOLD_AS_TITLE, PARTNER];
    const run = liveMatch({ breaks, cards: cardsAt, settings: (seq) => on(seq <= 12 ? "busy" : "normal"), window: 48 });
    expect(run.polls).toBe(48);
    expect(run.airingsChecked).toBeGreaterThan(0);
    // Which breaks got a card: all of phase 1; afterwards every 3rd minor of the FIXTURE (15, 18, … 48).
    expect(seqsOf(run.assigned)).toEqual([...range(1, 12), 15, 18, 21, 24, 27, 30, 33, 36, 39, 42, 45, 48]);
    // Who: each break by the P7 cycle of the cards ticked when it was assigned, at its own position.
    const expected = run.assigned.map((a) => {
      const cycle = oracleSponsors(cardsAt(a.seq));
      return cycle[a.position! % cycle.length];
    });
    expect(run.assigned.map((a) => a.sponsorId)).toEqual(expected);
    expect(run.assigned.map((a) => a.position)).toEqual(range(0, 23));
    // Silver is never picked once unticked; the final plan still shows every earlier break whose sponsor is ticked,
    // with the sponsor it was given.
    expect(run.assigned.filter((a) => a.seq > 24 && a.sponsorId === SILVER.sponsorId)).toEqual([]);
    const final = run.last!.plan!;
    const shown = new Map(final.airings.map((x) => [x.momentId, x.cardId]));
    let earlierChecked = 0;
    for (const a of run.assigned.filter((x) => x.seq <= 36)) {
      const c = cardOfSponsor(a.sponsorId)!;
      if (c.sponsorId === SILVER.sponsorId) expect(shown.has(a.momentId)).toBe(false);
      else expect(shown.get(a.momentId), `seq ${a.seq}`).toBe(c.id);
      earlierChecked++;
    }
    expect(earlierChecked).toBe(20);
  });

  it("a frozen assignment wins over the dial, hidden graphics and the cooldown, airs as stored, and anchors the next cooldown", () => {
    const frozenAt = (seq: number, sponsor: SponsorCard): SponsorAssignment => ({
      momentId: sponsorMomentId(seq, OVER_END.kind),
      seq,
      sponsorId: sponsor.sponsorId,
      sponsorName: sponsor.name,
      position: seq,
      source: "rotation",
      breakKind: OVER_END.kind,
      style: "lower_third",
      holdMs: 6 * SEC, // a hold the size no longer gives (written under an older constant): the stored row wins
      operatorChoiceAt: null,
    });
    expect(SPONSOR_STYLE_BY_SIZE.minor.holdMs).not.toBe(6 * SEC);
    // Minor 2 opened 30 s after minor 1's card, while graphics were hidden, and the dial is now Light (majors only).
    const breaks = [brk(1, T0, OVER_END), brk(2, T0 + 30 * SEC, OVER_END), brk(3, T0 + 100 * SEC, OVER_END)];
    const r = planSponsors(
      input({
        breaks,
        windowSeqs: [1, 2, 3],
        settings: on("light"),
        assigned: [frozenAt(1, TITLE), frozenAt(2, GOLD)],
        operatorLog: [entry(T0 + 20 * SEC, "graphics_hidden", true)],
        nextPosition: 3,
        now: T0 + 101 * SEC,
      }),
    );
    expect(r.plan!.airings).toEqual([
      { momentId: "1:sponsor.over_end", seq: 1, cardId: TITLE.id, style: "lower_third", holdMs: 6 * SEC, breakKind: "over_end" },
      { momentId: "2:sponsor.over_end", seq: 2, cardId: GOLD.id, style: "lower_third", holdMs: 6 * SEC, breakKind: "over_end" },
    ]);
    expect(r.newAssignments).toEqual([]);
    // On Busy and shown, minor 3 (70 s after frozen minor 2) is thinned; 100 s after minor 1 it would not be.
    const busy = planSponsors(
      input({ breaks, windowSeqs: [1, 2, 3], assigned: [frozenAt(1, TITLE), frozenAt(2, GOLD)], nextPosition: 3, now: T0 + 101 * SEC }),
    );
    expect(busy.newAssignments).toEqual([]);
  });

  it("plan.airings holds the window's assigned breaks only", () => {
    const breaks = minors(10, 100 * SEC);
    const run = liveMatch({ breaks, cards: () => [TITLE, GOLD, SILVER] });
    expect(run.assigned).toHaveLength(10);
    const r = planSponsors(
      input({ breaks, windowSeqs: range(6, 10), assigned: run.assigned, nextPosition: 10, now: Date.parse(breaks[9]!.at) + 5 * SEC }),
    );
    expect(seqsOf(r.plan!.airings)).toEqual([6, 7, 8, 9, 10]);
  });
});

// ── hidden graphics ──────────────────────────────────────────────────────────────────────────────────────────────

describe("planSponsors — hidden graphics", () => {
  const twoMajors = [brk(1, T0, SET_END), brk(2, T0 + 5 * SEC, SET_END)];
  const at = { breaks: twoMajors, windowSeqs: [1, 2], now: T0 + 6 * SEC };

  it("a break opened while graphicsHiddenAt is true is not assigned and nextPosition is not consumed (the sponsor keeps its turn)", () => {
    const cycle = oracleSponsors([TITLE, GOLD, SILVER]);
    const shown = planSponsors(input(at));
    expect(shown.newAssignments.map((a) => [a.seq, a.position, a.sponsorId])).toEqual([
      [1, 0, cycle[0]],
      [2, 1, cycle[1]],
    ]);
    const hiddenLog = [entry(T0 - SEC, "graphics_hidden", true), entry(T0 + 2 * SEC, "graphics_hidden", false)];
    const hidden = planSponsors(input({ ...at, operatorLog: hiddenLog }));
    // Break 2 takes break 1's turn: position 0, the cycle's first sponsor — not its second.
    expect(hidden.newAssignments.map((a) => [a.seq, a.position, a.sponsorId])).toEqual([[2, 0, cycle[0]]]);
    expect(cycle[0]).not.toBe(cycle[1]);
    expect(seqsOf(hidden.plan!.airings)).toEqual([2]);
  });

  it("Normal counts a hidden minor toward every 3rd (P2): hiding minor 3 skips it, and minor 6 is the next with a card", () => {
    const breaks = minors(6, 100 * SEC);
    const hide = [entry(T0 + 199 * SEC, "graphics_hidden", true), entry(T0 + 201 * SEC, "graphics_hidden", false)];
    const run = liveMatch({ breaks, cards: () => [TITLE, GOLD, SILVER], settings: () => on("normal"), operatorLog: hide });
    // Not counting the hidden minor would make minor 4 the "3rd".
    expect(seqsOf(run.assigned)).toEqual([6]);
    expect(run.assigned[0]!.position).toBe(0);
  });
});

// ── play next ────────────────────────────────────────────────────────────────────────────────────────────────────

describe("planSponsors — play next", () => {
  const majors = (n: number): BreakOpened[] => range(1, n).map((seq) => brk(seq, T0 + seq * 30 * SEC, SET_END));
  const cards = [TITLE, GOLD, SILVER];
  const cycle = oracleSponsors(cards);
  const summary = (as: SponsorAssignment[]) => as.map((a) => [a.seq, a.source, a.position, a.sponsorId]);

  it("play next takes exactly one eligible break as operator, position null; the rotation's next sponsor is next after it", () => {
    const choiceAt = T0 + 10 * SEC;
    const run = liveMatch({ breaks: majors(3), cards: () => cards, operatorLog: [entry(choiceAt, "next_sponsor_id", SILVER.sponsorId)] });
    expect(summary(run.assigned)).toEqual([
      [1, "operator", null, SILVER.sponsorId],
      [2, "rotation", 0, cycle[0]],
      [3, "rotation", 1, cycle[1]],
    ]);
    expect(run.assigned[0]!.operatorChoiceAt).toBe(iso(choiceAt));
    expect(run.assigned[0]!.sponsorName).toBe(SILVER.name);
    // Without the choice, break 1 is the rotation's: silver is not the cycle's first.
    expect(cycle[0]).not.toBe(SILVER.sponsorId);
    // Both breaks new in ONE poll (the overlay was not polled in between): the operator break still takes no position.
    const twoFresh = [brk(1, T0 + 50 * SEC, SET_END), brk(2, T0 + 55 * SEC, SET_END)];
    const onePoll = planSponsors(
      input({ breaks: twoFresh, windowSeqs: [1, 2], operatorLog: [entry(choiceAt, "next_sponsor_id", SILVER.sponsorId)], nextPosition: 4, now: T0 + 56 * SEC }),
    );
    expect(summary(onePoll.newAssignments)).toEqual([
      [1, "operator", null, SILVER.sponsorId],
      [2, "rotation", 4, cycle[4 % cycle.length]],
    ]);
    expect(cycle[4 % cycle.length]).not.toBe(cycle[5 % cycle.length]);
  });

  it("play next chosen again before the break replaces the first choice", () => {
    const log = [entry(T0 + 5 * SEC, "next_sponsor_id", GOLD.sponsorId), entry(T0 + 10 * SEC, "next_sponsor_id", SILVER.sponsorId)];
    const run = liveMatch({ breaks: majors(3), cards: () => cards, operatorLog: log });
    expect(run.assigned.filter((a) => a.source === "operator").map((a) => [a.seq, a.sponsorId])).toEqual([[1, SILVER.sponsorId]]);
    // And a cleared choice leaves the break to the rotation.
    const cleared = liveMatch({
      breaks: majors(1),
      cards: () => cards,
      operatorLog: [entry(T0 + 5 * SEC, "next_sponsor_id", GOLD.sponsorId), entry(T0 + 10 * SEC, "next_sponsor_id", null)],
    });
    expect(summary(cleared.assigned)).toEqual([[1, "rotation", 0, cycle[0]]]);
  });

  it("play next → the break is undone → the choice is pending again and takes the next eligible break", () => {
    const log = [entry(T0 + 10 * SEC, "next_sponsor_id", SILVER.sponsorId)];
    const b1 = brk(1, T0 + 30 * SEC, SET_END);
    const first = planSponsors(input({ breaks: [b1], windowSeqs: [1], operatorLog: log, now: T0 + 31 * SEC }));
    const op = first.newAssignments[0]!;
    expect([op.source, op.sponsorId]).toEqual(["operator", SILVER.sponsorId]);
    // Break 1's event is undone; break 2 opens. With the undone row still stored (a partial replay kept it) and with
    // it deleted, the choice is unconsumed and break 2 takes it.
    const b2 = brk(2, T0 + 60 * SEC, SET_END);
    for (const assigned of [[op], []]) {
      const r = planSponsors(input({ breaks: [b2], windowSeqs: [1, 2], operatorLog: log, assigned, now: T0 + 61 * SEC }));
      expect(summary(r.newAssignments)).toEqual([[2, "operator", null, SILVER.sponsorId]]);
      expect(r.newAssignments[0]!.operatorChoiceAt).toBe(op.operatorChoiceAt);
    }
  });

  it("a stored operator assignment consumes its choice even when the stored time is spelt differently (timestamptz text)", () => {
    const choiceAt = T0 + 10 * SEC;
    const log = [entry(choiceAt, "next_sponsor_id", SILVER.sponsorId)];
    const stored: SponsorAssignment = {
      momentId: sponsorMomentId(1, SET_END.kind),
      seq: 1,
      sponsorId: SILVER.sponsorId,
      sponsorName: SILVER.name,
      position: null,
      source: "operator",
      breakKind: SET_END.kind,
      style: "banner",
      holdMs: 15 * SEC,
      operatorChoiceAt: "2026-10-31T10:00:10+00:00", // the same instant as iso(choiceAt), as postgres spells it
    };
    expect(Date.parse(stored.operatorChoiceAt!)).toBe(choiceAt);
    const r = planSponsors(
      input({ breaks: majors(2), windowSeqs: [1, 2], operatorLog: log, assigned: [stored], now: T0 + 61 * SEC }),
    );
    expect(summary(r.newAssignments)).toEqual([[2, "rotation", 0, cycle[0]]]);
  });

  it("play next for a sponsor no longer ticked falls back to the rotation", () => {
    const run = liveMatch({ breaks: majors(1), cards: () => cards, operatorLog: [entry(T0, "next_sponsor_id", PARTNER.sponsorId)] });
    expect(summary(run.assigned)).toEqual([[1, "rotation", 0, cycle[0]]]);
  });

  it("play next waits out a hidden break and a thinned minor: it takes the next break that gets a card", () => {
    const breaks = [
      brk(1, T0, OVER_END), // the rotation's card; the choice comes after it
      brk(2, T0 + 30 * SEC, OVER_END), // thinned: 30 s after a card
      brk(3, T0 + 60 * SEC, SET_END), // a major, but graphics are hidden
      brk(4, T0 + 200 * SEC, OVER_END), // the next break with a card
    ];
    const log = [
      entry(T0 + 5 * SEC, "next_sponsor_id", SILVER.sponsorId),
      entry(T0 + 50 * SEC, "graphics_hidden", true),
      entry(T0 + 70 * SEC, "graphics_hidden", false),
    ];
    const run = liveMatch({ breaks, cards: () => cards, operatorLog: log });
    expect(summary(run.assigned)).toEqual([
      [1, "rotation", 0, cycle[0]],
      [4, "operator", null, SILVER.sponsorId],
    ]);
  });
});

// ── guards ───────────────────────────────────────────────────────────────────────────────────────────────────────

describe("planSponsors — refused input (assumptions are guards)", () => {
  const ok = [brk(1, T0, OVER_END), brk(2, T0 + 100 * SEC, OVER_END)];

  it("refuses breaks out of seq order, a repeated moment, an unparsable time, a bad cursor or clock, two cards for one sponsor, an unknown dial", () => {
    const refused: [string, Partial<PlanInput>][] = [
      ["breaks out of seq order", { breaks: [ok[1]!, ok[0]!] }],
      ["a repeated moment", { breaks: [ok[0]!, { ...ok[0]! }] }],
      ["an unparsable break time", { breaks: [{ ...ok[0]!, at: "half past ten" }] }],
      ["an unparsable log time", { breaks: ok, operatorLog: [{ at: "soon", field: "graphics_hidden", value: true }] }],
      ["a negative cursor", { nextPosition: -1 }],
      ["a fractional cursor", { nextPosition: 1.5 }],
      ["no clock", { now: Number.NaN }],
      ["two cards for one sponsor", { cards: [GOLD, { ...GOLD, id: "card-gold-2" }] }],
      ["an unknown dial", { breaks: ok, settings: { enabled: true, frequency: "often" as SponsorFrequency } }],
    ];
    let checked = 0;
    for (const [what, over] of refused) {
      expect(() => planSponsors(input({ windowSeqs: [1, 2], now: T0 + 101 * SEC, ...over })), what).toThrow(SponsorPlanInputError);
      checked++;
    }
    expect(checked).toBe(refused.length);
    // The well-formed control passes, and one event may open two distinct kinds at one seq.
    expect(() => planSponsors(input({ breaks: ok, windowSeqs: [1, 2], now: T0 + 101 * SEC }))).not.toThrow();
    const twoKinds = [brk(5, T0, SET_END), brk(5, T0, { kind: "match_point", size: "major" })];
    expect(planSponsors(input({ breaks: twoKinds, windowSeqs: [5], now: T0 + SEC })).newAssignments).toHaveLength(2);
  });
});

// ── client-safe ──────────────────────────────────────────────────────────────────────────────────────────────────

describe("lib/sponsor-plan is client-safe", () => {
  it("imports only the client-safe tier authority (the console page and the hub preview read it too)", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "sponsor-plan.ts"), "utf8");
    const specifiers = [...src.matchAll(/\bfrom\s+["']([^"']+)["']|\bimport\s+["']([^"']+)["']|\brequire\(\s*["']([^"']+)["']/g)].map(
      (m) => m[1] ?? m[2] ?? m[3],
    );
    expect(specifiers.length, "found the imports").toBeGreaterThan(0);
    expect(new Set(specifiers)).toEqual(new Set(["@/lib/sponsor-tiers"]));
  });
});

