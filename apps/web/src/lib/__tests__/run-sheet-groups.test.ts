// run-sheet-groups.test.ts — the division-wide grouping builder. Pure: no DB,
// no DOM. Fed in production by the division page's own `listDivisionFixtures`
// rows; run-sheet.spec.ts drives the same seam through the browser so the
// builder is proven by its REAL producer and consumer, not by a fixture on
// both ends (_RULES.md, "the inert seam").
import { restByeExtKey } from "@/lib/fixture-bye";
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

  // Since #850 this is true of every bye EXCEPT a round-robin rest bye, which
  // rides inside its round — and a fresh league's rounds are all untimed, so
  // that bye does sit in the "Not yet scheduled" block (pinned below, and never
  // counted or offered a time: run-sheet-filters / run-sheet-row). The case is
  // therefore stated on a Swiss sit-out, where it still holds literally.
  it("an untimed Swiss bye NEVER reaches the unscheduled group — no 'Set time' on a match nobody plays", () => {
    const SWISS = { id: "sw", seq: 1, kind: "swiss" };
    const out = buildRunSheet(
      input({
        stages: [SWISS],
        fixtures: [
          bye({ stage_id: "sw", home_entrant_id: "h1", outcome: { kind: "award", winner: "h1" }, status: "forfeited" }),
          fx({ id: "real", stage_id: "sw", scheduled_at: null }),
        ],
      }),
    );
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

  // #850 (owner rulings 2026-09-23) RETIRE R7(c) for league/group. The first
  // build of this sent every league bye to the settled tail, and these cases
  // ASSERTED that wrong placement (review 2026-09-23, O1 / finding 1). The
  // owner's ruling is "inside its round (and pool)", so every case below pins
  // the ROUND a bye sits in positively: the exact row order of the block, bye
  // after its round's last match — never just "which block".
  // A rest bye carries the generator's MARKER (`restByeExtKey`, owner ruling
  // 2026-09-24, fourth round) — the same function the generator spells it with.
  const restBye = (id: string, holder: string, over: Partial<RunSheetInput["fixtures"][number]> = {}) =>
    bye({
      id,
      status: "forfeited",
      home_entrant_id: holder,
      away_entrant_id: null,
      outcome: { kind: "award", winner: holder },
      ext_key: restByeExtKey(over.pool_id ? `${over.pool_id}-` : "", over.round_no ?? 1),
      ...over,
    });

  it("#850: a league bye sits inside its round — after the round's last match, in whichever block the round is", () => {
    const out = buildRunSheet(
      input({
        stages: [LEAGUE],
        fixtures: [
          // Round 1 is timed on Sat; round 2 is not timed yet; round 3 was
          // played without ever being timed.
          restBye("bye-r1", "e5", { round_no: 1, seq_in_round: 3 }),
          restBye("bye-r2", "e4", { round_no: 2, seq_in_round: 3 }),
          restBye("bye-r3", "e3", { round_no: 3, seq_in_round: 3 }),
          fx({ id: "r1-a", round_no: 1, seq_in_round: 1, scheduled_at: "2026-09-05T09:00:00.000Z" }),
          fx({ id: "r1-b", round_no: 1, seq_in_round: 2, scheduled_at: "2026-09-05T10:00:00.000Z" }),
          fx({ id: "r2-a", round_no: 2, seq_in_round: 1, scheduled_at: null }),
          fx({ id: "r2-b", round_no: 2, seq_in_round: 2, scheduled_at: null }),
          fx({ id: "r3-a", round_no: 3, seq_in_round: 1, scheduled_at: null, status: "decided" }),
          fx({ id: "r3-b", round_no: 3, seq_in_round: 2, scheduled_at: null, status: "decided" }),
        ],
      }),
    );
    expect(out.map((b) => b.kind)).toEqual(["day", "unscheduled", "settled"]);
    const ids = (k: string) => {
      const b = out.find((x) => x.kind === k);
      return b && b.kind !== "bracket" ? b.fixtures.map((f) => f.id) : null;
    };
    expect(ids("day")).toEqual(["r1-a", "r1-b", "bye-r1"]);
    expect(ids("unscheduled")).toEqual(["r2-a", "r2-b", "bye-r2"]);
    expect(ids("settled")).toEqual(["r3-a", "r3-b", "bye-r3"]);
  });

  it("#850: a fresh, untimed odd league reads round by round — every bye closes its own round", () => {
    const rounds = [1, 2, 3];
    const out = buildRunSheet(
      input({
        stages: [LEAGUE],
        // Arrival order scrambled: the generator writes every match before any bye.
        fixtures: [
          ...rounds.map((r) => restBye(`bye-r${r}`, "e1", { round_no: r, seq_in_round: 3 })),
          ...rounds.flatMap((r) => [
            fx({ id: `r${r}-b`, round_no: r, seq_in_round: 2, scheduled_at: null }),
            fx({ id: `r${r}-a`, round_no: r, seq_in_round: 1, scheduled_at: null }),
          ]),
        ],
      }),
    );
    expect(out.map((b) => b.kind)).toEqual(["unscheduled"]);
    expect(out[0]!.kind === "unscheduled" && out[0]!.fixtures.map((f) => f.id)).toEqual([
      "r1-a", "r1-b", "bye-r1", "r2-a", "r2-b", "bye-r2", "r3-a", "r3-b", "bye-r3",
    ]);
  });

  it("#850: a group stage's bye sits inside its own POOL's round, not the other pool's", () => {
    const GROUPS = { id: "g", seq: 1, kind: "group" };
    const out = buildRunSheet(
      input({
        stages: [GROUPS],
        fixtures: [
          // Pool A's round 1 runs 09:00 and 11:00; pool B's at 10:00. Both
          // pools are odd, so both rest someone in round 1.
          restBye("A-bye", "a3", { stage_id: "g", pool_id: "pA", round_no: 1, seq_in_round: 2 }),
          restBye("B-bye", "b3", { stage_id: "g", pool_id: "pB", round_no: 1, seq_in_round: 2 }),
          fx({ id: "A-09", stage_id: "g", pool_id: "pA", round_no: 1, seq_in_round: 1, scheduled_at: "2026-09-05T09:00:00.000Z" }),
          fx({ id: "B-10", stage_id: "g", pool_id: "pB", round_no: 1, seq_in_round: 1, scheduled_at: "2026-09-05T10:00:00.000Z" }),
          fx({ id: "A-11", stage_id: "g", pool_id: "pA", round_no: 1, seq_in_round: 3, scheduled_at: "2026-09-05T11:00:00.000Z" }),
        ],
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.kind === "day" && out[0]!.fixtures.map((f) => f.id)).toEqual(["A-09", "B-10", "B-bye", "A-11", "A-bye"]);
  });

  it("#850: a round split across two days closes with its bye on the day it finishes", () => {
    const out = buildRunSheet(
      input({
        stages: [LEAGUE],
        fixtures: [
          restBye("bye-r1", "e5", { round_no: 1, seq_in_round: 3 }),
          fx({ id: "sat", round_no: 1, seq_in_round: 1, scheduled_at: "2026-09-05T09:00:00.000Z" }),
          fx({ id: "sun", round_no: 1, seq_in_round: 2, scheduled_at: "2026-09-06T09:00:00.000Z" }),
        ],
      }),
    );
    expect(out.map((b) => (b.kind === "day" ? [b.dayKey, b.fixtures.map((f) => f.id)] : b.kind))).toEqual([
      ["2026-09-05", ["sat"]],
      ["2026-09-06", ["sun", "bye-r1"]],
    ]);
  });

  it("#850: the NOW rule skips an untimed bye — it rides with its round, never 'after now'", () => {
    // NOW is 14:00 London (13:00Z) on Thu 3 Sep.
    const out = buildRunSheet(
      input({
        stages: [LEAGUE],
        fixtures: [
          restBye("bye-r1", "e5", { round_no: 1, seq_in_round: 2 }),
          fx({ id: "r1", round_no: 1, seq_in_round: 1, scheduled_at: "2026-09-03T09:00:00.000Z" }),
          fx({ id: "r2", round_no: 2, seq_in_round: 1, scheduled_at: "2026-09-03T15:00:00.000Z" }),
        ],
      }),
    );
    const day = out[0]!;
    expect(day.kind === "day" && day.fixtures.map((f) => f.id)).toEqual(["r1", "bye-r1", "r2"]);
    expect(day.kind === "day" && day.nowIndex).toBe(2);
  });

  it("#850: a rest bye whose round has no match on the sheet falls back to the settled tail, never dropped", () => {
    const out = buildRunSheet(
      input({
        stages: [LEAGUE],
        fixtures: [
          restBye("orphan", "e5", { round_no: 4, seq_in_round: 3 }),
          fx({ id: "r1", round_no: 1, seq_in_round: 1, scheduled_at: null }),
        ],
      }),
    );
    expect(out.map((b) => (b.kind === "bracket" ? b.kind : [b.kind, b.fixtures.map((f) => f.id)]))).toEqual([
      ["unscheduled", ["r1"]],
      ["settled", ["orphan"]],
    ]);
  });

  // Review round 2, R2-5: a rest bye must never sit in a different block from
  // an UNPLAYED match of its own round. "After the round's last match" put it
  // under "Played, not scheduled" (the settled tail sorts after "Not yet
  // scheduled") while a match of its round still waited for a time. The rule:
  // the block of the round's first not-yet-settled match; else its last.
  it("#850 R2-5: a partly played UNTIMED round — the bye waits with its unplayed match, not under 'Played, not scheduled'", () => {
    const out = buildRunSheet(
      input({
        stages: [LEAGUE],
        fixtures: [
          restBye("bye-r1", "e5", { round_no: 1, seq_in_round: 3 }),
          fx({ id: "r1-a", round_no: 1, seq_in_round: 1, scheduled_at: null, status: "decided" }),
          fx({ id: "r1-b", round_no: 1, seq_in_round: 2, scheduled_at: null }),
        ],
      }),
    );
    expect(out.map((b) => (b.kind === "bracket" ? b.kind : [b.kind, b.fixtures.map((f) => f.id)]))).toEqual([
      ["unscheduled", ["r1-b", "bye-r1"]],
      ["settled", ["r1-a"]],
    ]);
  });

  it("#850 R2-5: a TIMED unplayed match pulls the bye onto its day, away from the round's played-untimed match", () => {
    const out = buildRunSheet(
      input({
        stages: [LEAGUE],
        fixtures: [
          restBye("bye-r1", "e5", { round_no: 1, seq_in_round: 3 }),
          fx({ id: "r1-a", round_no: 1, seq_in_round: 1, scheduled_at: null, status: "decided" }),
          fx({ id: "r1-b", round_no: 1, seq_in_round: 2, scheduled_at: "2026-09-05T09:00:00.000Z" }),
        ],
      }),
    );
    expect(out.map((b) => (b.kind === "bracket" ? b.kind : [b.kind, b.fixtures.map((f) => f.id)]))).toEqual([
      ["day", ["r1-b", "bye-r1"]],
      ["settled", ["r1-a"]],
    ]);
  });

  it("#850 R2-5, the other direction: once EVERY match of the round is played, the bye goes to the round's last block", () => {
    const out = buildRunSheet(
      input({
        stages: [LEAGUE],
        fixtures: [
          restBye("bye-r1", "e5", { round_no: 1, seq_in_round: 3 }),
          fx({ id: "r1-a", round_no: 1, seq_in_round: 1, scheduled_at: "2026-09-05T09:00:00.000Z", status: "decided" }),
          fx({ id: "r1-b", round_no: 1, seq_in_round: 2, scheduled_at: null, status: "decided" }),
          fx({ id: "r2-a", round_no: 2, seq_in_round: 1, scheduled_at: null }),
        ],
      }),
    );
    expect(out.map((b) => (b.kind === "bracket" ? b.kind : [b.kind, b.fixtures.map((f) => f.id)]))).toEqual([
      ["day", ["r1-a"]],
      ["unscheduled", ["r2-a"]],
      ["settled", ["r1-b", "bye-r1"]],
    ]);
  });

  // Owner ruling 2026-09-24 (fourth round): a fed league's WALKOVER (a
  // qualifier left before the draw; `awardSeededByes` settled the line) has a
  // rest bye's shape in the same league but its MATCH key. It keeps its
  // pre-#850 display, and on the run sheet that is R7(c): a non-bracket,
  // non-Swiss one-sided award is not on the sheet at all — neither a rest-bye
  // ghost inside its round nor a row in the settled tail.
  it("#850: a fed league's walkover (bye shape, match key) keeps R7(c) — off the sheet, unlike the marked rest bye beside it", () => {
    const out = buildRunSheet(
      input({
        stages: [LEAGUE],
        fixtures: [
          restBye("wo", "e5", { round_no: 1, seq_in_round: 2, ext_key: "rr-r1-c2" }),
          restBye("bye-r2", "e4", { round_no: 2, seq_in_round: 2 }),
          fx({ id: "r1-a", round_no: 1, seq_in_round: 1, scheduled_at: null }),
          fx({ id: "r2-a", round_no: 2, seq_in_round: 1, scheduled_at: null }),
        ],
      }),
    );
    expect(out.map((b) => (b.kind === "bracket" ? b.kind : [b.kind, b.fixtures.map((f) => f.id)]))).toEqual([
      ["unscheduled", ["r1-a", "r2-a", "bye-r2"]],
    ]);
  });

  it("#850: Swiss placement is unchanged — its sit-out stays in the settled tail even beside an untimed round", () => {
    const SWISS = { id: "sw", seq: 1, kind: "swiss" };
    const out = buildRunSheet(
      input({
        stages: [SWISS],
        fixtures: [
          restBye("swbye", "gus", { stage_id: "sw", round_no: 1, seq_in_round: 2 }),
          fx({ id: "swboard", stage_id: "sw", round_no: 1, seq_in_round: 1, scheduled_at: null }),
        ],
      }),
    );
    expect(out.map((b) => (b.kind === "bracket" ? b.kind : [b.kind, b.fixtures.map((f) => f.id)]))).toEqual([
      ["unscheduled", ["swboard"]],
      ["settled", ["swbye"]],
    ]);
  });
});
