// run-sheet-groups.test.ts — the division-wide grouping builder. Pure: no DB,
// no DOM. Fed in production by the division page's own `listDivisionFixtures`
// rows; run-sheet.spec.ts drives the same seam through the browser so the
// builder is proven by its REAL producer and consumer, not by a fixture on
// both ends (_RULES.md, "the inert seam").
import { describe, expect, it } from "vitest";
import { buildRunSheet, type RunSheetInput } from "../run-sheet-groups";

const TZ = "Europe/London";
const NOW = Date.UTC(2026, 8, 3, 13, 0); // 14:00 London, Thu 3 Sep

const LEAGUE = { id: "s1", seq: 1, kind: "league" };
const CUP = { id: "s2", seq: 2, kind: "knockout" };

function fx(over: Partial<RunSheetInput["fixtures"][number]> = {}) {
  return {
    id: "f1",
    stage_id: "s1",
    fixture_no: 1,
    round_no: 1,
    seq_in_round: 1,
    scheduled_at: "2026-09-03T14:00:00.000Z",
    status: "scheduled",
    court_name: null,
    venue_name: null,
    officials: [],
    outcome: null,
    home_entrant_id: "h1",
    away_entrant_id: "a1",
    home_slot_label: null,
    away_slot_label: null,
    ...over,
  };
}

function input(over: Partial<RunSheetInput> = {}): RunSheetInput {
  return { fixtures: [fx()], stages: [LEAGUE], tz: TZ, nowMs: NOW, ...over };
}

// THE EMPTY CASE, STATED FIRST. _RULES.md: "a rule set whose tests are all
// 'does the set contain X' needs an explicit empty case, stated FIRST — the
// empty set answers no to every question and lands on whatever the default
// is." Four vacuous-truth defects shipped in W1 from exactly this shape.
describe("buildRunSheet — the empty case", () => {
  it("no fixtures at all produces NO blocks — not an empty day, not a header", () => {
    expect(buildRunSheet(input({ fixtures: [] }))).toEqual([]);
  });

  it("no fixtures and no stages either still produces no blocks", () => {
    expect(buildRunSheet(input({ fixtures: [], stages: [] }))).toEqual([]);
  });

  it("a bracket stage with zero fixtures produces no bracket block", () => {
    const out = buildRunSheet(input({ fixtures: [], stages: [LEAGUE, CUP] }));
    expect(out).toEqual([]);
  });
});

describe("buildRunSheet — day groups merge across non-bracket stages", () => {
  it("two stages' fixtures on one day land in ONE day block", () => {
    const out = buildRunSheet(
      input({
        stages: [LEAGUE, { id: "s3", seq: 2, kind: "league" }],
        fixtures: [
          fx({ id: "a", stage_id: "s1", scheduled_at: "2026-09-05T09:00:00.000Z" }),
          fx({ id: "b", stage_id: "s3", scheduled_at: "2026-09-05T11:00:00.000Z" }),
        ],
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("day");
    expect(out[0].kind === "day" && out[0].fixtures.map((f) => f.id)).toEqual(["a", "b"]);
  });

  it("separate days are separate blocks, ascending", () => {
    const out = buildRunSheet(
      input({
        fixtures: [
          fx({ id: "late", scheduled_at: "2026-09-06T09:00:00.000Z" }),
          fx({ id: "early", scheduled_at: "2026-09-05T09:00:00.000Z" }),
        ],
      }),
    );
    expect(out.map((b) => b.kind === "day" && b.dayKey)).toEqual(["2026-09-05", "2026-09-06"]);
  });

  it("rows inside a day sort by time, then stage seq, then round, then seq_in_round", () => {
    const out = buildRunSheet(
      input({
        stages: [LEAGUE, { id: "s3", seq: 2, kind: "league" }],
        fixtures: [
          fx({ id: "d", stage_id: "s3", scheduled_at: "2026-09-05T09:00:00.000Z", round_no: 1, seq_in_round: 1 }),
          fx({ id: "c", stage_id: "s1", scheduled_at: "2026-09-05T09:00:00.000Z", round_no: 2, seq_in_round: 1 }),
          fx({ id: "b", stage_id: "s1", scheduled_at: "2026-09-05T09:00:00.000Z", round_no: 1, seq_in_round: 2 }),
          fx({ id: "a", stage_id: "s1", scheduled_at: "2026-09-05T09:00:00.000Z", round_no: 1, seq_in_round: 1 }),
        ],
      }),
    );
    expect(out[0].kind === "day" && out[0].fixtures.map((f) => f.id)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("buildRunSheet — the venue zone decides the day", () => {
  it("23:30 and 00:30 either side of local midnight are DIFFERENT days", () => {
    const out = buildRunSheet(
      input({
        fixtures: [
          fx({ id: "before", scheduled_at: "2026-09-02T22:30:00.000Z" }), // 23:30 on the 2nd
          fx({ id: "after", scheduled_at: "2026-09-02T23:30:00.000Z" }), // 00:30 on the 3rd
        ],
      }),
    );
    expect(out.map((b) => b.kind === "day" && b.dayKey)).toEqual(["2026-09-02", "2026-09-03"]);
  });

  it("the SAME instants in a different venue zone land on ONE day", () => {
    // Pacific/Auckland (+12): both are the 3rd there. This is the case that
    // fails if the builder ever reaches for the org zone instead.
    const out = buildRunSheet(
      input({
        tz: "Pacific/Auckland",
        fixtures: [
          fx({ id: "before", scheduled_at: "2026-09-02T22:30:00.000Z" }),
          fx({ id: "after", scheduled_at: "2026-09-02T23:30:00.000Z" }),
        ],
      }),
    );
    expect(out.filter((b) => b.kind === "day")).toHaveLength(1);
  });
});

describe("buildRunSheet — the NOW rule", () => {
  it("sits between the last row at or before now and the first after it", () => {
    const out = buildRunSheet(
      input({
        fixtures: [
          fx({ id: "past", scheduled_at: "2026-09-03T12:00:00.000Z" }),
          fx({ id: "future", scheduled_at: "2026-09-03T15:00:00.000Z" }),
        ],
      }),
    );
    expect(out[0].kind === "day" && out[0].nowIndex).toBe(1);
  });

  it("is absent from a day that is not today", () => {
    const out = buildRunSheet(input({ fixtures: [fx({ scheduled_at: "2026-09-05T09:00:00.000Z" })] }));
    expect(out[0].kind === "day" && out[0].nowIndex).toBeNull();
  });

  it("sits at the top when every row today is still to come", () => {
    const out = buildRunSheet(input({ fixtures: [fx({ scheduled_at: "2026-09-03T15:00:00.000Z" })] }));
    expect(out[0].kind === "day" && out[0].nowIndex).toBe(0);
  });

  it("sits at the end when every row today has been and gone", () => {
    const out = buildRunSheet(input({ fixtures: [fx({ scheduled_at: "2026-09-03T09:00:00.000Z" })] }));
    expect(out[0].kind === "day" && out[0].nowIndex).toBe(1);
  });

  it("appears on exactly ONE block, even when today has fixtures in two stages", () => {
    const out = buildRunSheet(
      input({
        stages: [LEAGUE, { id: "s3", seq: 2, kind: "league" }],
        fixtures: [
          fx({ id: "a", stage_id: "s1", scheduled_at: "2026-09-03T12:00:00.000Z" }),
          fx({ id: "b", stage_id: "s3", scheduled_at: "2026-09-03T15:00:00.000Z" }),
          fx({ id: "c", scheduled_at: "2026-09-05T09:00:00.000Z" }),
        ],
      }),
    );
    expect(out.filter((b) => b.kind === "day" && b.nowIndex !== null)).toHaveLength(1);
  });
});

describe("buildRunSheet — bracket stages keep round sections (owner ruling A2)", () => {
  it("a knockout stage becomes its own block, NOT day-grouped", () => {
    const out = buildRunSheet(
      input({
        stages: [LEAGUE, CUP],
        fixtures: [
          fx({ id: "lg", stage_id: "s1", scheduled_at: "2026-09-05T09:00:00.000Z" }),
          fx({ id: "qf", stage_id: "s2", round_no: 1, scheduled_at: "2026-09-06T09:00:00.000Z" }),
        ],
      }),
    );
    const bracket = out.find((b) => b.kind === "bracket");
    expect(bracket).toBeDefined();
    expect(bracket?.kind === "bracket" && bracket.stageId).toBe("s2");
    // and the knockout fixture is NOT also in a day block
    const inDays = out.flatMap((b) => (b.kind === "day" ? b.fixtures.map((f) => f.id) : []));
    expect(inDays).toEqual(["lg"]);
  });

  it("its rounds are sections in round order, each carrying its own rows", () => {
    const out = buildRunSheet(
      input({
        stages: [CUP],
        fixtures: [
          fx({ id: "sf", stage_id: "s2", round_no: 2, scheduled_at: "2026-09-06T11:00:00.000Z" }),
          fx({ id: "qf2", stage_id: "s2", round_no: 1, seq_in_round: 2, scheduled_at: "2026-09-06T09:00:00.000Z" }),
          fx({ id: "qf1", stage_id: "s2", round_no: 1, seq_in_round: 1, scheduled_at: "2026-09-06T09:00:00.000Z" }),
        ],
      }),
    );
    const bracket = out.find((b) => b.kind === "bracket");
    expect(bracket?.kind === "bracket" && bracket.rounds.map((r) => r.round)).toEqual([1, 2]);
    expect(bracket?.kind === "bracket" && bracket.rounds[0].fixtures.map((f) => f.id)).toEqual(["qf1", "qf2"]);
  });

  it("two bracket stages produce two blocks, in stage seq order", () => {
    const out = buildRunSheet(
      input({
        stages: [CUP, { id: "s9", seq: 3, kind: "knockout" }],
        fixtures: [
          fx({ id: "b", stage_id: "s9", scheduled_at: "2026-09-06T09:00:00.000Z" }),
          fx({ id: "a", stage_id: "s2", scheduled_at: "2026-09-06T09:00:00.000Z" }),
        ],
      }),
    );
    expect(out.filter((b) => b.kind === "bracket").map((b) => b.kind === "bracket" && b.stageId))
      .toEqual(["s2", "s9"]);
  });

  // Task 4 fix, found driving this seam through a real knockout e2e
  // (`knockout.spec.ts`): nothing in this product requires a knockout round
  // to carry an explicit kickoff time before it can be played — the ORIGINAL
  // finding-3 fix dropped a settled, untimed fixture unconditionally, which
  // for a bracket stage meant a PLAYED, DECIDED match vanished from its own
  // bracket entirely, not merely lost a stale "Unscheduled" label. This is a
  // strictly worse defect than the one finding 3 fixed, and the case above
  // ("a DECIDED fixture with no time is a result, not unscheduled") never
  // exercised a bracket stage, so nothing caught it until a real browser did.
  it("a decided bracket fixture with no recorded time stays in its round section — it is not dropped (Task 4 fix)", () => {
    const out = buildRunSheet(
      input({
        stages: [CUP],
        fixtures: [fx({ id: "sf", stage_id: "s2", round_no: 1, status: "decided", scheduled_at: null })],
      }),
    );
    expect(out.some((b) => b.kind === "unscheduled")).toBe(false);
    const bracket = out.find((b) => b.kind === "bracket");
    expect(bracket?.kind === "bracket" && bracket.rounds.flatMap((r) => r.fixtures.map((f) => f.id))).toEqual([
      "sf",
    ]);
  });

  // Fix round 1 (controller ruling): the SAME decided-and-untimed fixture on
  // a NON-bracket stage used to be dropped outright — the exact regression
  // finding 3 itself was meant to fix, one level up. W1's round list kept
  // these rows (its filter's third clause was `f.status !== "scheduled"`),
  // so a fully-played, never-timed league showed every result; W2 showed
  // nothing at all. Now kept in its own terminal "settled" block instead.
  it("the SAME decided-and-untimed fixture on a NON-bracket stage lands in a terminal 'settled' block, not dropped", () => {
    const out = buildRunSheet(
      input({ fixtures: [fx({ id: "lg", stage_id: "s1", status: "decided", scheduled_at: null })] }),
    );
    expect(out.some((b) => b.kind === "unscheduled")).toBe(false);
    const settled = out.find((b) => b.kind === "settled");
    expect(settled?.kind === "settled" && settled.fixtures.map((f) => f.id)).toEqual(["lg"]);
  });

  it("the settled block sorts AFTER the unscheduled block when both are present", () => {
    const out = buildRunSheet(
      input({
        fixtures: [
          fx({ id: "open", stage_id: "s1", status: "scheduled", scheduled_at: null }),
          fx({ id: "done", stage_id: "s1", status: "decided", scheduled_at: null }),
        ],
      }),
    );
    expect(out.map((b) => b.kind)).toEqual(["unscheduled", "settled"]);
  });

  it("a settled-untimed row is still absent from the unscheduled group's own fixture list", () => {
    const out = buildRunSheet(
      input({
        fixtures: [
          fx({ id: "open", stage_id: "s1", status: "scheduled", scheduled_at: null }),
          fx({ id: "done", stage_id: "s1", status: "decided", scheduled_at: null }),
        ],
      }),
    );
    const unscheduled = out.find((b) => b.kind === "unscheduled");
    expect(unscheduled?.kind === "unscheduled" && unscheduled.fixtures.map((f) => f.id)).toEqual(["open"]);
  });
});

describe("buildRunSheet — block ORDER (kills a reorder mutant)", () => {
  // A case whose expected value differs between two candidate orderings:
  // chronological (this plan's decision) vs "brackets first". The cup here is
  // EARLIER than the league day, so only chronological puts it first.
  it("an earlier bracket block sorts above a later day block", () => {
    const out = buildRunSheet(
      input({
        stages: [LEAGUE, CUP],
        fixtures: [
          fx({ id: "lg", stage_id: "s1", scheduled_at: "2026-09-10T09:00:00.000Z" }),
          fx({ id: "qf", stage_id: "s2", scheduled_at: "2026-09-06T09:00:00.000Z" }),
        ],
      }),
    );
    expect(out.map((b) => b.kind)).toEqual(["bracket", "day", "unscheduled"].slice(0, 2));
  });

  it("a LATER bracket block sorts below an earlier day block — the mirror case", () => {
    const out = buildRunSheet(
      input({
        stages: [LEAGUE, CUP],
        fixtures: [
          fx({ id: "lg", stage_id: "s1", scheduled_at: "2026-09-05T09:00:00.000Z" }),
          fx({ id: "qf", stage_id: "s2", scheduled_at: "2026-09-06T09:00:00.000Z" }),
        ],
      }),
    );
    expect(out.map((b) => b.kind)).toEqual(["day", "bracket"]);
  });
});

describe("buildRunSheet — the unscheduled group", () => {
  it("is ALWAYS last, even when its stage sorts first", () => {
    const out = buildRunSheet(
      input({
        fixtures: [
          fx({ id: "timed", scheduled_at: "2026-09-05T09:00:00.000Z" }),
          fx({ id: "untimed", scheduled_at: null }),
        ],
      }),
    );
    expect(out[out.length - 1].kind).toBe("unscheduled");
  });

  it("collects unscheduled rows from EVERY stage, brackets included, into one group", () => {
    const out = buildRunSheet(
      input({
        stages: [LEAGUE, CUP],
        fixtures: [
          fx({ id: "lg", stage_id: "s1", scheduled_at: null }),
          fx({ id: "cup", stage_id: "s2", scheduled_at: null }),
        ],
      }),
    );
    const tail = out.filter((b) => b.kind === "unscheduled");
    expect(tail).toHaveLength(1);
    expect(tail[0].kind === "unscheduled" && tail[0].fixtures.map((f) => f.id)).toEqual(["lg", "cup"]);
  });

  it("orders by stage seq, then round, then seq_in_round", () => {
    const out = buildRunSheet(
      input({
        stages: [LEAGUE, CUP],
        fixtures: [
          fx({ id: "d", stage_id: "s2", round_no: 1, seq_in_round: 1, scheduled_at: null }),
          fx({ id: "c", stage_id: "s1", round_no: 2, seq_in_round: 1, scheduled_at: null }),
          fx({ id: "b", stage_id: "s1", round_no: 1, seq_in_round: 2, scheduled_at: null }),
          fx({ id: "a", stage_id: "s1", round_no: 1, seq_in_round: 1, scheduled_at: null }),
        ],
      }),
    );
    const tail = out[out.length - 1];
    expect(tail.kind === "unscheduled" && tail.fixtures.map((f) => f.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("a DECIDED fixture with no time is a result, not unscheduled (finding 3)", () => {
    // The current row prints "Unscheduled" on a decided match. A decided
    // fixture belongs to the day it was played on where one is known, and to
    // no group at all rather than the unscheduled pile where none is.
    const out = buildRunSheet(
      input({ fixtures: [fx({ id: "done", status: "decided", scheduled_at: null })] }),
    );
    const tail = out.find((b) => b.kind === "unscheduled");
    expect(tail?.kind === "unscheduled" && tail.fixtures.map((f) => f.id)).not.toContain("done");
  });
});

// Supplement C3/C5 — the brief never mentions byes at all, and the omission
// is a defect: without a rule an untimed bye lands in "Not yet scheduled" and
// is offered "Set time" for a match nobody plays.
describe("buildRunSheet — byes are structural, never schedulable (R7)", () => {
  const bye = (over: Partial<RunSheetInput["fixtures"][number]> = {}) =>
    fx({
      id: "bye1",
      scheduled_at: null,
      away_entrant_id: null,
      outcome: { kind: "award" },
      ...over,
    });

  it("an untimed bye NEVER reaches the unscheduled group — no 'Set time' on a match nobody plays", () => {
    const out = buildRunSheet(input({ fixtures: [bye(), fx({ id: "real", scheduled_at: null })] }));
    const tail = out.find((b) => b.kind === "unscheduled");
    expect(tail?.kind === "unscheduled" && tail.fixtures.map((f) => f.id)).toEqual(["real"]);
  });

  it("a bracket stage keeps its byes as rows in their round", () => {
    const out = buildRunSheet(
      input({
        stages: [CUP],
        fixtures: [
          bye({ id: "cupbye", stage_id: "s2", round_no: 1 }),
          fx({ id: "qf", stage_id: "s2", round_no: 1, seq_in_round: 2, scheduled_at: "2026-09-06T09:00:00.000Z" }),
        ],
      }),
    );
    const bracket = out.find((b) => b.kind === "bracket");
    expect(bracket?.kind === "bracket" && bracket.rounds[0].fixtures.map((f) => f.id))
      .toEqual(["cupbye", "qf"]);
  });

  it("a bracket block of ONLY untimed byes still sorts before the unscheduled group, and does not NaN", () => {
    // Regression for the Math.min-over-nulls trap: NaN in the block sort
    // silently scrambles the whole sheet's order rather than throwing.
    const out = buildRunSheet(
      input({
        stages: [LEAGUE, CUP],
        fixtures: [
          bye({ id: "cupbye", stage_id: "s2" }),
          fx({ id: "lg", scheduled_at: "2026-09-05T09:00:00.000Z" }),
          fx({ id: "untimed", scheduled_at: null }),
        ],
      }),
    );
    expect(out.map((b) => b.kind)).toEqual(["day", "bracket", "unscheduled"]);
  });
});
