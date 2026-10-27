// `servingVerdict` — the ONE copy of the serving rule (SPEC-1, as fixed 2026-10-27), which the counter reads for
// "served" and the "which matches does this ban cover" projection (owner-approved 4A) reads for "upcoming". A pure
// table: every row's expected verdict is the rule stated in the discipline.ts header (a match serves a ban only if it is
// the suspended entrant's, is not the ban's own trigger fixture, STARTED after the ban began, and ended decided /
// finalized / forfeited-by-them / double walkover), never the function's own output. The DB-backed suites
// (discipline-serving, discipline-covered) drive the same rule through the real doors.
import { describe, expect, it } from "vitest";
import { servingVerdict, type LedgerFacts, type ServingFixture } from "../discipline";

const SINCE = new Date("2030-11-01T12:00:00Z");
const BEFORE = new Date("2030-11-01T11:00:00Z");
const AFTER = new Date("2030-11-01T13:00:00Z");
const BAN = { entrantId: "A", fixtureId: "trigger", since: SINCE };

type Row = {
  why: string;
  f: Partial<ServingFixture> & { id: string };
  started?: Date;
  forfeitBy?: string;
  expected: "served" | "upcoming" | "never";
};

const ROWS: Row[] = [
  // Who and which.
  { why: "another team's match", f: { id: "o", home_entrant_id: "B", away_entrant_id: "C", status: "scheduled" }, expected: "never" },
  { why: "the ban's own trigger fixture, not started", f: { id: "trigger", status: "scheduled" }, expected: "never" },
  { why: "the ban's own trigger fixture, played after", f: { id: "trigger", status: "decided" }, started: AFTER, expected: "never" },
  // Not yet played.
  { why: "scheduled, not started (home)", f: { id: "s1", status: "scheduled" }, expected: "upcoming" },
  { why: "scheduled, not started (away)", f: { id: "s2", home_entrant_id: "B", away_entrant_id: "A", status: "scheduled" }, expected: "upcoming" },
  { why: "in play, kicked off after the ban", f: { id: "p1", status: "in_play" }, started: AFTER, expected: "upcoming" },
  { why: "held level, kicked off after the ban", f: { id: "h1", status: "needs_decision" }, started: AFTER, expected: "upcoming" },
  { why: "in play, kicked off BEFORE the ban", f: { id: "p2", status: "in_play" }, started: BEFORE, expected: "never" },
  { why: "in play, kicked off AT the ban's instant", f: { id: "p3", status: "in_play" }, started: SINCE, expected: "never" },
  // Played.
  { why: "decided, kicked off after", f: { id: "d1", status: "decided" }, started: AFTER, expected: "served" },
  { why: "finalized, kicked off after", f: { id: "d2", status: "finalized" }, started: AFTER, expected: "served" },
  { why: "decided, kicked off before", f: { id: "d3", status: "decided" }, started: BEFORE, expected: "never" },
  { why: "decided with nothing recorded (never started)", f: { id: "d4", status: "decided" }, expected: "never" },
  { why: "forfeited BY the suspended team", f: { id: "w1", status: "forfeited" }, started: AFTER, forfeitBy: "A", expected: "served" },
  { why: "forfeited by the other team", f: { id: "w2", status: "forfeited" }, started: AFTER, forfeitBy: "B", expected: "never" },
  { why: "double walkover", f: { id: "w3", status: "forfeited", outcome: { kind: "double_walkover" } }, started: AFTER, expected: "served" },
  { why: "abandoned after kick-off", f: { id: "x1", status: "abandoned" }, started: AFTER, expected: "never" },
  { why: "abandoned before a ball was kicked", f: { id: "x2", status: "abandoned" }, expected: "never" },
  { why: "cancelled", f: { id: "x3", status: "cancelled" }, expected: "never" },
];

describe("servingVerdict — the serving rule, one row per case", () => {
  it.each(ROWS.map((r) => [r.why, r] as const))("%s", (_why, r) => {
    const f: ServingFixture = { home_entrant_id: "A", away_entrant_id: "B", outcome: null, status: "scheduled", ...r.f };
    const facts: LedgerFacts = {
      startedAt: new Map(r.started ? [[f.id, r.started]] : []),
      forfeitBy: new Map(r.forfeitBy ? [[f.id, r.forfeitBy]] : []),
    };
    expect(servingVerdict(f, BAN, facts)).toBe(r.expected);
  });

  it("the table reaches every verdict (anti-vacuity)", () => {
    const counts = { served: 0, upcoming: 0, never: 0 };
    for (const r of ROWS) counts[r.expected]++;
    expect(ROWS.length).toBe(19);
    expect(counts.served).toBeGreaterThan(0);
    expect(counts.upcoming).toBeGreaterThan(0);
    expect(counts.never).toBeGreaterThan(0);
  });

  it("a ban with no trigger fixture (manual) covers a match it would otherwise skip as the trigger", () => {
    const f: ServingFixture = { id: "trigger", status: "scheduled", home_entrant_id: "A", away_entrant_id: "B", outcome: null };
    const facts: LedgerFacts = { startedAt: new Map(), forfeitBy: new Map() };
    expect(servingVerdict(f, { ...BAN, fixtureId: null }, facts)).toBe("upcoming");
    expect(servingVerdict(f, BAN, facts)).toBe("never");
  });
});
