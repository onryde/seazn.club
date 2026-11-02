// run-sheet-groups.test.ts — the division-wide grouping builder. Pure: no DB,
// no DOM. Fed in production by the division page's own `listDivisionFixtures`
// rows; run-sheet.spec.ts drives the same seam through the browser so the
// builder is proven by its REAL producer and consumer, not by a fixture on
// both ends (_RULES.md, "the inert seam").
import { describe, expect, it } from "vitest";
import { StageKind } from "@seazn/engine/core";
import { FIXTURE_STATUSES, LOCKED_FIXTURE_STATUSES, SETTLED_FIXTURE_STATUSES } from "../fixture-status";
import { stageCounts } from "../stage-card/summaries";
import {
  BRACKET_STAGE_KINDS,
  ROUND_SEQUENCE_STAGE_KINDS,
  buildRunSheet,
  isBye,
  roundDone,
  roundWhen,
  stageFlatSection,
  stageRoundSections,
  type RunSheetInput,
} from "../run-sheet-groups";

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
    // Required since review finding 10 widened the `Pick` — `court_id` was
    // always being READ (courtDisplayName's venue-qualifying branch) and only
    // ever arrived because `toRunSheetFixture` spreads the wire row. An
    // explicitly-constructed fixture like this one dropped it silently.
    court_id: null,
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

  // F2 (W2 walkthrough gate 1): an untimed OPEN bracket fixture (status
  // scheduled/in_play, no scheduled_at yet — an entirely ordinary shape for a
  // round that has not been slotted onto a court) was tested against
  // `OPEN.has(status)` BEFORE the bracket-membership check, so it fell into
  // the unscheduled pile — exactly like a non-bracket fixture — instead of
  // staying in its stage's round section. The bracket's own header then
  // derived `lastRoundInLane` from a truncated fixture list and reported the
  // wrong round.
  it("an untimed bracket fixture with an OPEN status stays in its round section, not the unscheduled pile (F2)", () => {
    const out = buildRunSheet(
      input({
        stages: [CUP],
        fixtures: [
          fx({ id: "qf1", stage_id: "s2", round_no: 1, status: "scheduled", scheduled_at: null }),
          fx({ id: "final", stage_id: "s2", round_no: 2, status: "scheduled", scheduled_at: null }),
        ],
      }),
    );
    expect(out.some((b) => b.kind === "unscheduled")).toBe(false);
    const bracket = out.find((b) => b.kind === "bracket");
    expect(bracket?.kind === "bracket" && bracket.rounds.map((r) => r.round)).toEqual([1, 2]);
    expect(
      bracket?.kind === "bracket" && bracket.rounds.flatMap((r) => r.fixtures.map((f) => f.id)),
    ).toEqual(["qf1", "final"]);
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

  // F2 fix flips this test's own premise: an untimed OPEN bracket fixture no
  // longer reaches the unscheduled pile at all — it stays in its stage's
  // round section (see "buildRunSheet — bracket stages keep round sections"
  // above). This collects unscheduled rows from every NON-bracket stage.
  it("collects unscheduled rows from every NON-bracket stage into one group; a bracket's untimed row goes to its own block instead", () => {
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
    expect(tail[0].kind === "unscheduled" && tail[0].fixtures.map((f) => f.id)).toEqual(["lg"]);
    const bracket = out.find((b) => b.kind === "bracket");
    expect(bracket?.kind === "bracket" && bracket.rounds.flatMap((r) => r.fixtures.map((f) => f.id))).toEqual([
      "cup",
    ]);
  });

  it("orders by stage seq, then round, then seq_in_round", () => {
    const out = buildRunSheet(
      input({
        stages: [LEAGUE, { id: "s3", seq: 2, kind: "league" }],
        fixtures: [
          fx({ id: "d", stage_id: "s3", round_no: 1, seq_in_round: 1, scheduled_at: null }),
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

  it("a Swiss awarded bye appears in settled-untimed (organiser must see who sat out)", () => {
    const SWISS = { id: "sw", seq: 1, kind: "swiss" };
    const out = buildRunSheet(
      input({
        stages: [SWISS],
        fixtures: [
          bye({
            id: "swbye",
            stage_id: "sw",
            round_no: 1,
            home_entrant_id: "gus",
            away_entrant_id: null,
            status: "forfeited",
            outcome: { kind: "award", winner: "gus" },
          }),
          fx({
            id: "swboard",
            stage_id: "sw",
            round_no: 1,
            seq_in_round: 1,
            scheduled_at: null,
            status: "scheduled",
          }),
        ],
      }),
    );
    const settled = out.find((b) => b.kind === "settled");
    expect(settled?.kind === "settled" && settled.fixtures.map((f) => f.id)).toEqual(["swbye"]);
    const unscheduled = out.find((b) => b.kind === "unscheduled");
    expect(unscheduled?.kind === "unscheduled" && unscheduled.fixtures.map((f) => f.id)).toEqual([
      "swboard",
    ]);
  });

  it("X-SW-29 an unseated Swiss bye shell is not scheduling work: it leaves the sheet, the round's board stays", () => {
    // W3 T3 (RB3-23): a Swiss stage mints each round's bye row (`sw-r{N}-bye`) as a `scheduled` shell with no seat and
    // no award until Pair. It takes no court and no time (the server refuses one: SWISS_BYE_NOT_PLACEABLE), so it must
    // not reach the unscheduled pile and be offered a "Set time" that can only refuse (R7: byes are never actionable).
    const SWISS = { id: "sw", seq: 1, kind: "swiss" };
    const shell = fx({
      id: "r2bye",
      stage_id: "sw",
      round_no: 2,
      seq_in_round: 3,
      scheduled_at: null,
      status: "scheduled",
      home_entrant_id: null,
      away_entrant_id: null,
      ext_key: "sw-r2-bye",
    });
    const board = fx({
      id: "r2b1",
      stage_id: "sw",
      round_no: 2,
      seq_in_round: 1,
      scheduled_at: null,
      status: "scheduled",
      home_entrant_id: null,
      away_entrant_id: null,
      ext_key: "sw-r2-b1",
    });
    expect(isBye(shell), "the bye shell is structural, like a seated bye").toBe(true);
    expect(isBye(board), "positive pair: the round's board shell is not").toBe(false);
    const out = buildRunSheet(input({ stages: [SWISS], fixtures: [shell, board] }));
    const ids = out.flatMap((b) => ("fixtures" in b ? b.fixtures.map((f) => f.id) : []));
    expect(ids, "the shell is nowhere on the sheet; the board shell is still work to schedule").toEqual(["r2b1"]);
    expect(out.map((b) => b.kind)).toEqual(["unscheduled"]);
  });

  it("X-SW-29 a seated Swiss bye is still the settled award row (the shell rule does not hide it)", () => {
    const SWISS = { id: "sw", seq: 1, kind: "swiss" };
    const seated = bye({
      id: "r1bye",
      stage_id: "sw",
      round_no: 1,
      home_entrant_id: "gus",
      away_entrant_id: null,
      status: "forfeited",
      outcome: { kind: "award", winner: "gus", loser: null, reason: "bye" },
      ext_key: "sw-r1-bye",
    });
    const out = buildRunSheet(input({ stages: [SWISS], fixtures: [seated] }));
    const settled = out.find((b) => b.kind === "settled");
    expect(settled?.kind === "settled" && settled.fixtures.map((f) => f.id)).toEqual(["r1bye"]);
  });

  it("a league awarded bye still leaves the sheet (R7c unchanged)", () => {
    const out = buildRunSheet(
      input({
        stages: [LEAGUE],
        fixtures: [bye({ id: "lgbye", stage_id: "s1", status: "forfeited" })],
      }),
    );
    expect(out).toEqual([]);
  });
});

// R116-3 (owner ruling 116): `isBye` is the run sheet's one bye test — the row it draws, the filters that drop it, the
// stage counts that skip it. A withdrawn winner's dead seat walked over by the side that arrived names a LOSER, so it is
// a walkover like any other, not a bye. Empty case first.
describe("isBye — ruling 116's walkover is no bye", () => {
  const BYE_LABEL = { key: "bracket.slot.bye", params: {} };
  const ROWS: { what: string; over: Partial<RunSheetInput["fixtures"][number]>; bye: boolean }[] = [
    { what: "empty case: no outcome", over: { away_entrant_id: null }, bye: false },
    { what: "an odd draw's bye", over: { away_entrant_id: null, status: "forfeited", outcome: { kind: "award", winner: "h1", loser: null, reason: "bye" } }, bye: true },
    { what: "a stamped dead seat with no loser (DW-dead, a DQ'd winner's)", over: { away_entrant_id: null, away_slot_label: BYE_LABEL, status: "forfeited", outcome: { kind: "award", winner: "h1", loser: null, reason: "bye" } }, bye: true },
    { what: "a legacy award with no reason", over: { away_entrant_id: null, status: "forfeited", outcome: { kind: "award", winner: "h1" } }, bye: true },
    { what: "ruling 116: her away seat dead", over: { away_entrant_id: null, away_slot_label: BYE_LABEL, status: "forfeited", outcome: { kind: "award", winner: "h1", loser: "x9", reason: "withdrew" } }, bye: false },
    { what: "ruling 116: her home seat dead", over: { home_entrant_id: null, home_slot_label: BYE_LABEL, status: "forfeited", outcome: { kind: "award", winner: "a1", loser: "x9", reason: "withdrew" } }, bye: false },
    { what: "an ordinary walkover, both seated", over: { status: "forfeited", outcome: { kind: "award", winner: "h1", loser: "a1", reason: "withdrew" } }, bye: false },
  ];
  it("each row (counted)", () => {
    let checked = 0;
    for (const r of ROWS) {
      expect(isBye(fx(r.over) as never), r.what).toBe(r.bye);
      checked++;
    }
    expect(checked).toBe(ROWS.length);
    expect(ROWS.filter((r) => r.bye).length, "both answers are reached").toBeGreaterThan(0);
  });
});

// Match Day E1 item 1 (owner 2026-11-01): a stage card groups its rows under a bar per ROUND. The pure pieces, over the blocks
// `buildRunSheet` hands the card - the empty case first, then the order inside a round, then the numbers on the bar.
describe("stageRoundSections - one non-bracket stage's rows by round", () => {
  const sections = (fixtures: ReturnType<typeof fx>[], stageId = "s1", stages: RunSheetInput["stages"] = [LEAGUE, CUP]) =>
    stageRoundSections(buildRunSheet(input({ fixtures, stages })), stageId);

  it("the empty case: no rows, no blocks, a stage with no rows of its own - none, never an empty round", () => {
    expect(stageRoundSections([], "s1")).toEqual([]);
    expect(sections([fx({ id: "other", stage_id: "s9" })]), "another stage's row is not this stage's").toEqual([]);
  });

  it("rounds read in the order they are PLAYED: a round that kicks off earlier comes first whatever its number (design/fix-ui/03), the untimed rounds after, by number", () => {
    const out = sections([
      fx({ id: "t1", round_no: 1, scheduled_at: "2026-07-21T19:28:00.000Z", fixture_no: 1 }),
      fx({ id: "t2", round_no: 2, scheduled_at: "2026-07-22T19:28:00.000Z", fixture_no: 2 }),
      fx({ id: "t3", round_no: 3, scheduled_at: "2026-07-20T21:28:00.000Z", fixture_no: 3 }),
      fx({ id: "u5", round_no: 5, scheduled_at: null, fixture_no: 5 }),
      fx({ id: "u4", round_no: 4, scheduled_at: null, fixture_no: 4 }),
    ]);
    expect(out.map((r) => r.round)).toEqual([3, 1, 2, 4, 5]);
    expect(sections([fx({ id: "a", round_no: 2, scheduled_at: null, fixture_no: 1 }), fx({ id: "b", round_no: 1, scheduled_at: null, fixture_no: 2 })]).map((r) => r.round), "nothing timed: round number").toEqual([1, 2]);
  });

  it("rounds come in round order, whatever order the rows arrived in, and one round holds both timed and untimed rows", () => {
    const out = sections([
      fx({ id: "r2", round_no: 2, scheduled_at: null, seq_in_round: 1, fixture_no: 3 }),
      fx({ id: "r1a", round_no: 1, scheduled_at: "2026-09-05T10:00:00.000Z", fixture_no: 1 }),
      fx({ id: "r1b", round_no: 1, scheduled_at: null, seq_in_round: 2, fixture_no: 2 }),
    ]);
    expect(out.map((r) => r.round)).toEqual([1, 2]);
    expect(out[0]!.fixtures.map((f) => f.id), "the untimed row of round 1 stays IN round 1 - the 'Not yet scheduled' group is gone").toEqual(["r1a", "r1b"]);
    expect(out[1]!.fixtures.map((f) => f.id)).toEqual(["r2"]);
  });

  it("inside a round: time order, untimed LAST, ties and untimed rows in draw order - and an in-play row with no time is in its round, not in a group", () => {
    const out = sections([
      fx({ id: "untimed-1", scheduled_at: null, seq_in_round: 1, fixture_no: 1 }),
      fx({ id: "late", scheduled_at: "2026-09-05T11:00:00.000Z", seq_in_round: 2, fixture_no: 2 }),
      fx({ id: "inplay-untimed", scheduled_at: null, status: "in_play", seq_in_round: 3, fixture_no: 3 }),
      fx({ id: "early", scheduled_at: "2026-09-05T09:00:00.000Z", seq_in_round: 4, fixture_no: 4 }),
      fx({ id: "tie-b", scheduled_at: "2026-09-05T09:00:00.000Z", seq_in_round: 5, fixture_no: 5 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.fixtures.map((f) => f.id)).toEqual(["early", "tie-b", "late", "untimed-1", "inplay-untimed"]);
  });

  it("a bracket stage's rows are not regrouped here (the knockout keeps its named rounds), and a stage's rows never carry another stage's", () => {
    const out = stageRoundSections(
      buildRunSheet(input({ stages: [LEAGUE, CUP], fixtures: [fx({ id: "league", stage_id: "s1" }), fx({ id: "ko", stage_id: "s2", fixture_no: 2 })] })),
      "s2",
    );
    expect(out, "a bracket stage asked for rounds gets none: its block is the bracket's").toEqual([]);
    expect(sections([fx({ id: "league", stage_id: "s1" }), fx({ id: "ko", stage_id: "s2", fixture_no: 2 })]).flatMap((r) => r.fixtures.map((f) => f.id))).toEqual(["league"]);
  });

  it("a Swiss sit-out the grouping keeps rides in its round as an untimed row; an untimed league bye is not on the sheet at all", () => {
    const swiss = { id: "sw", seq: 1, kind: "swiss" };
    const award = { kind: "award", winner: "h1", loser: null, reason: "bye" };
    const swissOut = stageRoundSections(
      buildRunSheet(input({ stages: [swiss], fixtures: [fx({ id: "bye", stage_id: "sw", away_entrant_id: null, scheduled_at: null, status: "forfeited", outcome: award }), fx({ id: "m", stage_id: "sw", fixture_no: 2, seq_in_round: 2 })] })),
      "sw",
    );
    expect(swissOut[0]!.fixtures.map((f) => f.id)).toEqual(["m", "bye"]);
    expect(sections([fx({ id: "bye", away_entrant_id: null, scheduled_at: null, status: "forfeited", outcome: award })])).toEqual([]);
  });
});

// Match Day E1 fix round 3 (supersedes fix round 1's m2 and fix round 2's section order): pools play at the same time on separate courts, so
// no ORDER of per-pool sections is also time order. A group stage's round is ONE section holding every pool's matches of that round, in time
// order; a tie in time reads by the page's pool order, then by the draw. The row's `pool_id` says which pool it is.
describe("stageRoundSections - pools: one section per ROUND across the pools, rows in time order", () => {
  const GROUP = { id: "g1", seq: 1, kind: "group" };
  const pooled = (fixtures: ReturnType<typeof fx>[], order?: ReadonlyMap<string, number>) =>
    stageRoundSections(buildRunSheet(input({ stages: [GROUP], fixtures })), "g1", order);
  const row = (id: string, pool: string | null, round: number, extra: Partial<ReturnType<typeof fx>> = {}) =>
    fx({ id, stage_id: "g1", pool_id: pool, round_no: round, fixture_no: Number(id.replace(/\D/g, "")) || 1, scheduled_at: null, ...extra } as never);
  const ORDER = new Map([["pA", 0], ["pB", 1]]);
  const REVERSED = new Map([["pB", 0], ["pA", 1]]);
  const at = (hhmm: string) => `2026-09-05T${hhmm}:00.000Z`;
  const ids = (s: { fixtures: { id: string }[] }) => s.fixtures.map((f) => f.id);

  it("the empty case: no rows is no section", () => {
    expect(pooled([], ORDER)).toEqual([]);
  });

  it("a round holds BOTH pools' matches: one section per round number, never one per pool, whatever order the rows arrived in", () => {
    const out = pooled(
      [row("b2", "pB", 2), row("a2", "pA", 2), row("b1", "pB", 1), row("a1", "pA", 1), row("a1b", "pA", 1, { seq_in_round: 2, fixture_no: 7 })],
      ORDER,
    );
    expect(out.map((s) => s.round), "two rounds, not four").toEqual([1, 2]);
    expect(out.map(ids), "nothing timed: pool A reads first inside a round, then the draw").toEqual([["a1", "a1b", "b1"], ["a2", "b2"]]);
    expect(out.length, "anti-vacuity: both rounds are there").toBe(2);
    expect(out.flatMap((s) => s.fixtures).length, "anti-vacuity: no row was lost").toBe(5);
  });

  // THE CASE THE RULING IS FOR: pools of four on separate courts, kicking off together. Group A and Group B each play two matches in Round 1,
  // at 09:00 and 09:35. A per-pool section order cannot read this in time order; one round in time order does.
  it("pools on separate courts at the same time: Round 1 reads A 09:00, B 09:00, A 09:35, B 09:35 - the page's first pool takes each tie", () => {
    const rows = [
      row("a1", "pA", 1, { scheduled_at: at("09:00"), court_name: "Court 1" }),
      row("a2", "pA", 1, { scheduled_at: at("09:35"), court_name: "Court 1", seq_in_round: 2 }),
      row("b1", "pB", 1, { scheduled_at: at("09:00"), court_name: "Court 2" }),
      row("b2", "pB", 1, { scheduled_at: at("09:35"), court_name: "Court 2", seq_in_round: 2 }),
    ];
    const out = pooled(rows, ORDER);
    expect(out).toHaveLength(1);
    expect(ids(out[0]!)).toEqual(["a1", "b1", "a2", "b2"]);
    expect(ids(pooled(rows, REVERSED)[0]!), "listed the other way round, B takes each tie - and the times still lead").toEqual(["b1", "a1", "b2", "a2"]);
    // The expected order is the clock's, read off the rows' own times: every row is no earlier than the one above it.
    const times = out[0]!.fixtures.map((f) => Date.parse(f.scheduled_at!));
    expect([...times].sort((x, y) => x - y)).toEqual(times);
    expect(times.length, "anti-vacuity: four rows read").toBe(4);
  });

  it("inside a round time leads and the pool only breaks a tie: B at 09:00 reads before A at 09:35", () => {
    const out = pooled([row("a1", "pA", 1, { scheduled_at: at("09:35") }), row("b1", "pB", 1, { scheduled_at: at("09:00") })], ORDER);
    expect(ids(out[0]!)).toEqual(["b1", "a1"]);
  });

  it("untimed rows sit last inside a round, among themselves by pool and then the draw; a round's timed rows are never interrupted by them", () => {
    const out = pooled(
      [
        row("b0", "pB", 1), // untimed
        row("a0", "pA", 1), // untimed
        row("b1", "pB", 1, { scheduled_at: at("10:00") }),
        row("a1", "pA", 1, { scheduled_at: at("11:00") }),
        row("a0b", "pA", 1, { seq_in_round: 2, fixture_no: 9 }), // untimed, later in the draw
      ],
      ORDER,
    );
    expect(ids(out[0]!)).toEqual(["b1", "a1", "a0", "a0b", "b0"]);
  });

  it("a pool the order does not list reads after every listed one on a tie; rows of no pool read before them", () => {
    const out = pooled(
      [row("x1", "pX", 1, { scheduled_at: at("09:00") }), row("a1", "pA", 1, { scheduled_at: at("09:00") }), row("n1", null, 1, { scheduled_at: at("09:00") })],
      ORDER,
    );
    expect(ids(out[0]!)).toEqual(["n1", "a1", "x1"]);
  });

  it("a pool is not required: with no order handed over, equal times fall to a stable id order, then the draw", () => {
    const out = pooled([row("b1", "pB", 1, { scheduled_at: at("09:00") }), row("a1", "pA", 1, { scheduled_at: at("09:00") })]);
    expect(ids(out[0]!)).toEqual(["a1", "b1"]);
  });

  describe("the sections themselves (E1 item 1's play order, unchanged)", () => {
    it("sections read by earliest kickoff, the sections with nothing timed after them, the round number breaking every tie", () => {
      const out = pooled(
        [
          row("a3", "pA", 3, { scheduled_at: at("08:00") }), // round 3 kicks off first
          row("a1", "pA", 1, { scheduled_at: at("09:00") }),
          row("b1", "pB", 1, { scheduled_at: at("09:00") }),
          row("a2", "pA", 2, { scheduled_at: at("09:00") }), // ties R1 at 09:00: the round number
          row("a4", "pA", 4), // untimed only
          row("b5", "pB", 5), // untimed only
        ],
        ORDER,
      );
      expect(out.map((s) => s.round)).toEqual([3, 1, 2, 4, 5]);
    });

    // Mixed timed and untimed rows in one round, against another section: the untimed rows of a round do not hold the round back, and a
    // round with nothing timed is last. (Round 1 is both the earlier number and the earlier kickoff here, so every reading of "the round's
    // position" agrees; the next case is the one where they part.)
    it("a round mixing timed and untimed rows: its timed rows first, the round placed by its timed rows, ahead of a round with nothing timed", () => {
      const out = pooled(
        [
          row("a1u", "pA", 1, { seq_in_round: 1 }), // untimed, first in the draw
          row("a1t", "pA", 1, { seq_in_round: 2, fixture_no: 8, scheduled_at: at("10:00") }),
          row("b1t", "pB", 1, { seq_in_round: 3, fixture_no: 9, scheduled_at: at("09:00") }),
          row("a2u", "pA", 2),
          row("b2u", "pB", 2),
        ],
        ORDER,
      );
      expect(out.map((s) => s.round)).toEqual([1, 2]);
      expect(ids(out[0]!), "timed rows in time order, the untimed one LAST though it came first in the draw").toEqual(["b1t", "a1t", "a1u"]);
      expect(ids(out[1]!)).toEqual(["a2u", "b2u"]);
    });

    it("the same mixed round against an EARLIER-kicking later round: the order is the play order (E1 item 1), so the later round leads - an untimed row does not move that", () => {
      const out = pooled(
        [row("a1u", "pA", 1), row("a1t", "pA", 1, { scheduled_at: at("15:00"), fixture_no: 8 }), row("b2t", "pB", 2, { scheduled_at: at("09:00") })],
        ORDER,
      );
      expect(out.map((s) => s.round), "Round 2 kicks off at 09:00, Round 1's first timed row at 15:00").toEqual([2, 1]);
    });

    it("the kinds with no pools read exactly as before: a league and a Swiss event by earliest kickoff, the untimed after, by round", () => {
      let checked = 0;
      for (const kind of ["league", "swiss", "americano"] as const) {
        const stages = [{ id: "g1", seq: 1, kind }];
        const out = stageRoundSections(
          buildRunSheet(input({ stages, fixtures: [row("r1", null, 1, { scheduled_at: at("15:00") }), row("r2", null, 2, { scheduled_at: at("09:00") }), row("r3", null, 3), row("r4", null, 4)] })),
          "g1",
          ORDER,
        );
        expect(out.map((s) => s.round), kind).toEqual([2, 1, 3, 4]);
        checked++;
      }
      expect(checked, "every pool-less kind swept").toBe(3);
    });
  });
});

// Match Day E1 fix round 1 (I1): the bar's number is the SHARED count. The stage card's Complete button reads `stageCounts`; a bar that
// counts "played" differently can say "1 of 2 played" on a stage that can already be completed (a walkover, an abandonment and a cancellation
// are settled to the stage). So the bar asks `stageCounts` itself, over the round's real matches.
describe("roundDone - the 'N of M done' on a round bar (the stage card's own count)", () => {
  const AWARD = { kind: "award", winner: "h1", loser: "a1", reason: "walkover" };
  const BYE = fx({ id: "bye", fixture_no: 99, away_entrant_id: null, status: "forfeited", outcome: { kind: "award", winner: "h1", loser: null, reason: "bye" } });

  it("the empty case: no rows is 0 of 0", () => {
    expect(roundDone([], new Set())).toEqual({ done: 0, total: 0 });
  });

  it("every status the schema has, counted: done is exactly the settled + locked statuses the app already declares; a bye is no match", () => {
    const rows = FIXTURE_STATUSES.map((status, i) => fx({ id: `f${i}`, status, fixture_no: i + 1 }));
    // The expected number comes from the two declarations `stageCounts` documents itself against, not from a list typed here.
    const settled = FIXTURE_STATUSES.filter((s) => SETTLED_FIXTURE_STATUSES.has(s) || LOCKED_FIXTURE_STATUSES.has(s));
    expect(roundDone(rows, new Set())).toEqual({ done: settled.length, total: FIXTURE_STATUSES.length });
    expect(roundDone([...rows, BYE], new Set()), "a bye adds to neither").toEqual({ done: settled.length, total: FIXTURE_STATUSES.length });
    expect(rows.length, "anti-vacuity: every status was in the sweep").toBe(FIXTURE_STATUSES.length);
    expect(settled.length, "anti-vacuity: both answers are reached").toBeGreaterThan(0);
    expect(settled.length).toBeLessThan(FIXTURE_STATUSES.length);
  });

  it("a walkover and a cancellation are done (the stage card says so), though neither has a result", () => {
    const rows = [
      fx({ id: "w", fixture_no: 1, status: "forfeited", outcome: AWARD }),
      fx({ id: "c", fixture_no: 2, status: "cancelled" }),
      fx({ id: "open", fixture_no: 3 }),
    ];
    expect(roundDone(rows, new Set())).toEqual({ done: 2, total: 3 });
  });

  it("an abandonment awaiting its settle is NOT done, and is done once settled (it leaves the held set)", () => {
    const rows = [fx({ id: "ab", fixture_no: 1, status: "abandoned" }), fx({ id: "ok", fixture_no: 2, status: "decided", outcome: { kind: "win", winner: "h1" } })];
    expect(roundDone(rows, new Set(["ab"])), "held: the stage still owes its verdict").toEqual({ done: 1, total: 2 });
    expect(roundDone(rows, new Set()), "settled: nothing is owed").toEqual({ done: 2, total: 2 });
  });

  it("parity with the stage card: the round counts add up to stageCounts over the stage's real matches, and open = total - done", () => {
    const held = new Set(["ab"]);
    const rows = [
      fx({ id: "a1", round_no: 1, fixture_no: 1, status: "decided", outcome: { kind: "win", winner: "h1" } }),
      fx({ id: "ab", round_no: 1, fixture_no: 2, status: "abandoned" }),
      fx({ id: "w", round_no: 2, fixture_no: 3, status: "forfeited", outcome: AWARD }),
      fx({ id: "n", round_no: 2, fixture_no: 4, status: "needs_decision" }),
      fx({ id: "s", round_no: 3, fixture_no: 5 }),
      fx({ id: "p", round_no: 3, fixture_no: 6, status: "in_play" }),
    ];
    const real = rows.filter((r) => !isBye(r));
    const sections = stageRoundSections(buildRunSheet(input({ fixtures: [...rows, BYE] })), "s1");
    expect(sections.length, "anti-vacuity: three rounds").toBe(3);
    const sum = sections.reduce((acc, sec) => {
      const r = roundDone(sec.fixtures, held);
      return { done: acc.done + r.done, total: acc.total + r.total };
    }, { done: 0, total: 0 });
    const counts = stageCounts(real, held);
    expect(sum.done).toBe(counts.played);
    expect(sum.total).toBe(real.length);
    expect(sum.total - sum.done, "what the bars leave open is what blocks Complete").toBe(counts.inPlay + counts.unplayed);
  });
});

// Match Day E1 fix round 1 (I2): round bars belong to the kinds whose fixtures run in numbered rounds. The set is a partition of the
// engine's StageKind: a kind added to the engine is in no set until someone decides, and this test says so.
describe("ROUND_SEQUENCE_STAGE_KINDS - which kinds get round bars", () => {
  it("partitions StageKind with the bracket kinds and the ladder: every kind in exactly one, none missing", () => {
    const FLAT = new Set(["ladder"]);
    let checked = 0;
    for (const kind of StageKind.options) {
      const homes = [ROUND_SEQUENCE_STAGE_KINDS.has(kind), BRACKET_STAGE_KINDS.has(kind), FLAT.has(kind)].filter(Boolean).length;
      expect(homes, `${kind}: exactly one home`).toBe(1);
      checked++;
    }
    expect(checked).toBe(StageKind.options.length);
    expect(checked, "anti-vacuity").toBeGreaterThan(0);
    for (const kind of ROUND_SEQUENCE_STAGE_KINDS) expect(StageKind.options as readonly string[], `${kind} is a real kind`).toContain(kind);
    expect([...ROUND_SEQUENCE_STAGE_KINDS].sort()).toEqual(["americano", "group", "league", "swiss"]);
    expect(ROUND_SEQUENCE_STAGE_KINDS.has("ladder"), "a ladder stores each challenge as its own round: no bars").toBe(false);
  });
});

describe("stageFlatSection - a stage that has no rounds worth a bar: one list, time order, untimed last", () => {
  const ladder = { id: "ld", seq: 1, kind: "ladder" };
  const flat = (fixtures: ReturnType<typeof fx>[]) => stageFlatSection(buildRunSheet(input({ stages: [ladder], fixtures })), "ld");

  it("the empty case: no rows is no section, never an empty one", () => {
    expect(stageFlatSection([], "ld")).toEqual([]);
    expect(flat([fx({ id: "other", stage_id: "s9" })])).toEqual([]);
  });

  it("every challenge is its own round, yet the rows run as ONE list: by time, the untimed ones last in draw order", () => {
    const out = flat([
      fx({ id: "c1", stage_id: "ld", round_no: 1, fixture_no: 1, seq_in_round: 1, scheduled_at: null }),
      fx({ id: "c2", stage_id: "ld", round_no: 2, fixture_no: 2, seq_in_round: 1, scheduled_at: "2026-09-05T16:00:00.000Z" }),
      fx({ id: "c3", stage_id: "ld", round_no: 3, fixture_no: 3, seq_in_round: 1, scheduled_at: "2026-09-05T09:00:00.000Z" }),
      fx({ id: "c4", stage_id: "ld", round_no: 4, fixture_no: 4, seq_in_round: 1, scheduled_at: null }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.fixtures.map((f) => f.id)).toEqual(["c3", "c2", "c1", "c4"]);
  });
});

describe("roundWhen - the 'when' on a round bar, in the VENUE zone", () => {
  it("the empty case: no row with a time says nothing", () => {
    expect(roundWhen([], TZ)).toBeNull();
    expect(roundWhen([fx({ scheduled_at: null })], TZ)).toBeNull();
  });

  it("one day: the clock span of the timed rows (the untimed one adds nothing); one timed row: the span is that time twice", () => {
    const span = roundWhen([fx({ scheduled_at: "2026-09-05T20:10:00.000Z" }), fx({ scheduled_at: null }), fx({ scheduled_at: "2026-09-05T20:50:00.000Z" })], TZ);
    expect(span).toEqual({ firstDay: "2026-09-05", lastDay: "2026-09-05", from: "21:10", to: "21:50" });
    expect(roundWhen([fx({ scheduled_at: "2026-09-05T20:10:00.000Z" })], TZ)).toMatchObject({ from: "21:10", to: "21:10" });
  });

  it("two days: the first and last day differ, so there is no one clock span to print", () => {
    const span = roundWhen([fx({ scheduled_at: "2026-09-05T20:10:00.000Z" }), fx({ scheduled_at: "2026-09-06T09:00:00.000Z" })], TZ);
    expect(span?.firstDay).toBe("2026-09-05");
    expect(span?.lastDay).toBe("2026-09-06");
  });

  it("the venue zone decides the day: 23:30 UTC in London summer time is already the next day", () => {
    expect(roundWhen([fx({ scheduled_at: "2026-09-05T23:30:00.000Z" })], TZ)).toMatchObject({ firstDay: "2026-09-06", from: "00:30" });
  });
});
