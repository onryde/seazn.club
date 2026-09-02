import { describe, expect, it } from "vitest";
import {
  resolvePhase,
  resolveAttention,
  localDateKey,
  type PhaseInput,
  type PhaseFixture,
  type PhaseStage,
} from "@/lib/division-phase";

const NOW = "2026-09-05T09:42:00Z"; // Sat 10:42 Europe/London (BST)
const TZ = "Europe/London";

const stage = (o: Partial<PhaseStage> = {}): PhaseStage => ({
  id: "st1", name: "League", seq: 1, status: "active", hasFixtures: true, needsProposal: false, ...o,
});
const fx = (o: Partial<PhaseFixture> = {}): PhaseFixture => ({
  id: "f1", status: "scheduled", scheduledAt: "2026-09-12T09:00:00Z", eventCount: 0, matchMinutes: 90,
  hasScorer: false, ...o,
});
const input = (o: Partial<PhaseInput> = {}): PhaseInput => ({
  divisionStatus: "active", stages: [stage()], fixtures: [fx()], now: NOW, tz: TZ, awaitingRegistrations: 0, ...o,
});

describe("localDateKey", () => {
  it("buckets by the governing zone, not UTC", () => {
    // 23:30 UTC on the 4th is 00:30 on the 5th in London (BST, +1)
    expect(localDateKey("2026-09-04T23:30:00Z", TZ)).toBe("2026-09-05");
    expect(localDateKey("2026-09-04T23:30:00Z", "UTC")).toBe("2026-09-04");
  });
  it("returns an empty key for a malformed instant instead of throwing", () => {
    expect(localDateKey("not-a-date", TZ)).toBe("");
    expect(resolvePhase(input({ fixtures: [fx({ scheduledAt: "not-a-date" })] }))).toBe("scheduled");
  });
});

describe("resolvePhase — rule order", () => {
  it("1 setting_up: an empty division is setting up, not vacuously finished", () => {
    // The ONE shape that distinguishes the rule order: with no stages and no
    // fixtures, `noOpenStage && noLiveFixture` is vacuously true, so a
    // finished-first order would call a brand-new division "finished".
    expect(resolvePhase(input({ divisionStatus: "setup", stages: [], fixtures: [] }))).toBe("setting_up");
  });
  it("1 finished: every stage complete", () => {
    expect(resolvePhase(input({ stages: [stage({ status: "complete" })], fixtures: [fx({ status: "decided" })] }))).toBe("finished");
  });
  // 1b (final review, "the open question" — a 4th vacuous "Finished"): with
  // ONLY `stages: []` and no divisionStatus === "setup" guard to save it,
  // rule 2's "no pending/active stage AND no live fixture" is vacuously true
  // of an empty stage array exactly the way rule 1's own comment describes —
  // this used to read "finished" here. Reachable in production: deleteStage
  // (stages.ts) lets an organiser remove the sole, last, UNPLAYED stage of
  // an already-`active` division; fixtures.stage_id cascades, so the fixture
  // list empties with it, but divisionStatus stays whatever it was.
  // Confirmed reachable against a live "active" division with 6 unplayed
  // fixtures and one stage (fix-round-b-report.md). Replaces the old test
  // of this exact name, which pinned the bug as intended — the fixture list
  // it fed in (a synthetic "decided" fixture with NO stage at all) is
  // impossible in production anyway, since fixtures cannot outlive the stage
  // that cascades their deletion; the stage graph, not any fixture, is what
  // this rule must key off.
  it("1b setting_up: an empty stage graph never reads finished, whatever divisionStatus or the fixture list say", () => {
    expect(resolvePhase(input({ divisionStatus: "active", stages: [], fixtures: [] }))).toBe("setting_up");
    expect(
      resolvePhase(input({ divisionStatus: "active", stages: [], fixtures: [fx({ status: "decided" })] })),
    ).toBe("setting_up");
  });
  it("1 finished: every stage complete wins even with a fixture still scheduled", () => {
    // isolates the everyStageComplete arm: noLiveFixture is false here
    const stages = [stage({ status: "complete" })];
    expect(resolvePhase(input({ stages, fixtures: [fx({ scheduledAt: "2026-09-05T18:00:00Z" })] }))).toBe("finished");
  });
  it("2 finished: all fixtures played even though the stage is still active (V1 fix)", () => {
    // The organiser never clicked "Complete stage" on the League — with every
    // fixture decided/finalized and no later stage owing work, the phase
    // must not lag behind and read "scheduled".
    const stages = [stage({ status: "active" })];
    const fixtures = [fx({ id: "a", status: "decided" }), fx({ id: "b", status: "finalized" })];
    expect(resolvePhase(input({ stages, fixtures }))).toBe("finished");
  });
  it("2 NOT finished: all fixtures played but a later stage still needs its draw", () => {
    // The U16 Cup shape — the guard (`openStageOwesWork`) must win over the
    // new all-played arm, or a fully-played league with an undrawn finals
    // stage would wrongly read "finished".
    const stages = [
      stage({ id: "lg", seq: 1, status: "complete" }),
      stage({ id: "fin", name: "Finals", seq: 2, status: "pending", hasFixtures: false, needsProposal: true }),
    ];
    const fixtures = [fx({ id: "a", status: "decided" }), fx({ id: "b", status: "finalized" })];
    expect(resolvePhase(input({ stages, fixtures }))).toBe("setting_up");
  });
  it("2 setting_up: division status setup wins over a fixture dated today", () => {
    expect(resolvePhase(input({ divisionStatus: "setup", fixtures: [fx({ scheduledAt: "2026-09-05T11:00:00Z" })] }))).toBe("setting_up");
  });
  it("3 match_day: a fixture in play", () => {
    expect(resolvePhase(input({ fixtures: [fx({ status: "in_play", scheduledAt: null })] }))).toBe("match_day");
  });
  it("3 match_day: a scheduled fixture today in the org zone", () => {
    expect(resolvePhase(input({ fixtures: [fx({ scheduledAt: "2026-09-05T18:00:00Z" })] }))).toBe("match_day");
  });
  it("3 match_day: 00:30 local today counts as today, 23:30 UTC yesterday does not in UTC", () => {
    expect(resolvePhase(input({ fixtures: [fx({ scheduledAt: "2026-09-04T23:30:00Z" })] }))).toBe("match_day");
    expect(resolvePhase(input({ tz: "UTC", fixtures: [fx({ scheduledAt: "2026-09-04T23:30:00Z" })] }))).toBe("scheduled");
  });
  it("4 setting_up: lowest non-complete stage has no fixtures", () => {
    expect(resolvePhase(input({ stages: [stage({ hasFixtures: false })], fixtures: [] }))).toBe("setting_up");
  });
  it("4 setting_up: U16 shape — league complete, finals pending needs proposal", () => {
    const stages = [
      stage({ id: "lg", seq: 1, status: "complete" }),
      stage({ id: "fin", name: "Finals", seq: 2, status: "pending", hasFixtures: false, needsProposal: true }),
    ];
    expect(resolvePhase(input({ stages, fixtures: [fx({ status: "decided" })] }))).toBe("setting_up");
  });
  it("4 setting_up: a pending stage with fixtures generated but its draw still owed", () => {
    // isolates needsProposal from hasFixtures: the other OR operand is false here
    const stages = [stage({ id: "fin", name: "Finals", seq: 1, status: "pending", hasFixtures: true, needsProposal: true })];
    expect(resolvePhase(input({ stages, fixtures: [fx({ scheduledAt: "2026-09-12T09:00:00Z" })] }))).toBe("setting_up");
  });
  it("5 scheduled: fixtures exist, none today, none in play", () => {
    expect(resolvePhase(input())).toBe("scheduled");
  });
  it("5 NOT scheduled: fixtures exist but none carry a time — setting_up, never scheduled (F1 fix)", () => {
    // The exact live defect: a started division whose fixtures were all
    // generated with no time read "Scheduled" next to a status line that
    // said "nothing scheduled" — three contradicting facts in one row. No
    // non-terminal fixture carries a scheduledAt, so this reads setting_up,
    // which already carries the `unscheduled` attention that says so.
    const fixtures = [fx({ id: "a", scheduledAt: null }), fx({ id: "b", scheduledAt: null })];
    expect(resolvePhase(input({ fixtures }))).toBe("setting_up");
  });
  it("5 scheduled: one dated non-terminal fixture among several undated ones is enough", () => {
    const fixtures = [fx({ id: "a", scheduledAt: null }), fx({ id: "b", scheduledAt: "2026-09-12T09:00:00Z" })];
    expect(resolvePhase(input({ fixtures }))).toBe("scheduled");
  });
  it("5 NOT scheduled: a decided fixture's own past time does not count — it is terminal, not live", () => {
    // Isolates the `status === "scheduled"` half of the F1 guard from the
    // `scheduledAt !== null` half: without the status check, a division
    // with only played fixtures (each of which once had a real kickoff
    // time) would wrongly read "scheduled" here.
    const fixtures = [fx({ id: "a", status: "decided", scheduledAt: "2026-09-01T09:00:00Z" }), fx({ id: "b", scheduledAt: null })];
    expect(resolvePhase(input({ fixtures }))).toBe("setting_up");
  });
  it("a decided fixture today does not make a match day", () => {
    // A second, still-unplayed fixture keeps this case out of the V1
    // all-played "finished" arm added above, so it still isolates rule 3.
    const fixtures = [
      fx({ id: "d", status: "decided", scheduledAt: "2026-09-05T08:00:00Z" }),
      fx({ id: "s" }),
    ];
    expect(resolvePhase(input({ fixtures }))).toBe("scheduled");
  });
});

describe("resolveAttention", () => {
  it("needs_draw for a pending stage awaiting its proposal", () => {
    const stages = [stage({ id: "fin", name: "Finals", seq: 2, status: "pending", hasFixtures: false, needsProposal: true })];
    expect(resolveAttention(input({ stages }))).toContainEqual({ kind: "needs_draw", stageId: "fin", stageName: "Finals" });
  });
  it("unscheduled counts only scheduled-status rows without a time", () => {
    const fixtures = [fx({ id: "a", scheduledAt: null }), fx({ id: "b", scheduledAt: null, status: "decided" }), fx({ id: "c" })];
    expect(resolveAttention(input({ fixtures }))).toContainEqual({ kind: "unscheduled", count: 1 });
  });
  it("no_scorer: in play with zero events, minutes since kickoff from scheduledAt", () => {
    const fixtures = [fx({ id: "p", status: "in_play", scheduledAt: "2026-09-05T09:30:00Z", eventCount: 0 })];
    expect(resolveAttention(input({ fixtures }))).toContainEqual({
      kind: "no_scorer", count: 1, fixtureIds: ["p"], minutesSinceKickoff: 12,
    });
  });
  it("no_scorer is not raised once an event exists", () => {
    const fixtures = [fx({ id: "p", status: "in_play", eventCount: 3 })];
    expect(resolveAttention(input({ fixtures })).some((a) => a.kind === "no_scorer")).toBe(false);
  });
  // F4 fix (final review, Important): the old test was bare `eventCount ===
  // 0` — a division- or fixture-scoped scorer sitting on a 0-0 read as
  // "missing", and assigning one never cleared the row.
  it("F4: no_scorer is not raised when a scorer is assigned to the fixture, even at zero events", () => {
    const fixtures = [fx({ id: "p", status: "in_play", eventCount: 0, hasScorer: true })];
    expect(resolveAttention(input({ fixtures })).some((a) => a.kind === "no_scorer")).toBe(false);
  });
  it("F4: no_scorer still fires when nobody is assigned AND nothing has been scored", () => {
    const fixtures = [fx({ id: "p", status: "in_play", eventCount: 0, hasScorer: false })];
    expect(resolveAttention(input({ fixtures })).some((a) => a.kind === "no_scorer")).toBe(true);
  });
  // F3 fix (final review, Important): used to be one row PER FIXTURE.
  it("F3: no_scorer aggregates per division — one row, not one per fixture, worst minutesSinceKickoff wins", () => {
    const fixtures = [
      fx({ id: "p1", status: "in_play", scheduledAt: "2026-09-05T09:30:00Z", eventCount: 0 }), // 12 min
      fx({ id: "p2", status: "in_play", scheduledAt: "2026-09-05T09:00:00Z", eventCount: 0 }), // 42 min
    ];
    const out = resolveAttention(input({ fixtures }));
    expect(out.filter((a) => a.kind === "no_scorer")).toHaveLength(1);
    expect(out).toContainEqual({
      kind: "no_scorer", count: 2, fixtureIds: ["p1", "p2"], minutesSinceKickoff: 42,
    });
  });
  // division-phase.ts:134 minor fix: a null scheduledAt must never render a
  // permanent "0 min ago" — `minutesSinceKickoff` is `null` instead.
  it("no_scorer: minutesSinceKickoff is null, not 0, when the fixture never carried a scheduledAt", () => {
    const fixtures = [fx({ id: "p", status: "in_play", scheduledAt: null, eventCount: 0 })];
    expect(resolveAttention(input({ fixtures }))).toContainEqual({
      kind: "no_scorer", count: 1, fixtureIds: ["p"], minutesSinceKickoff: null,
    });
  });
  it("no_scorer: minutesSinceKickoff picks the worst KNOWN value when only some fixtures carry a scheduledAt", () => {
    const fixtures = [
      fx({ id: "p1", status: "in_play", scheduledAt: null, eventCount: 0 }),
      fx({ id: "p2", status: "in_play", scheduledAt: "2026-09-05T09:00:00Z", eventCount: 0 }), // 42 min
    ];
    expect(resolveAttention(input({ fixtures }))).toContainEqual(
      expect.objectContaining({ kind: "no_scorer", minutesSinceKickoff: 42 }),
    );
  });
  it("result_missing: scheduled, kickoff + matchMinutes already passed", () => {
    const fixtures = [fx({ id: "r", scheduledAt: "2026-09-05T07:00:00Z", matchMinutes: 90 })];
    expect(resolveAttention(input({ fixtures }))).toContainEqual({ kind: "result_missing", count: 1, fixtureIds: ["r"] });
  });
  it("result_missing is not raised while the match window is still open", () => {
    const fixtures = [fx({ id: "r", scheduledAt: "2026-09-05T09:00:00Z", matchMinutes: 90 })];
    expect(resolveAttention(input({ fixtures })).some((a) => a.kind === "result_missing")).toBe(false);
  });
  it("F3: result_missing aggregates per division — one row naming both fixtures, not two rows", () => {
    const fixtures = [
      fx({ id: "r1", scheduledAt: "2026-09-05T07:00:00Z", matchMinutes: 90 }),
      fx({ id: "r2", scheduledAt: "2026-09-05T06:00:00Z", matchMinutes: 90 }),
    ];
    const out = resolveAttention(input({ fixtures }));
    expect(out.filter((a) => a.kind === "result_missing")).toHaveLength(1);
    expect(out).toContainEqual({ kind: "result_missing", count: 2, fixtureIds: ["r1", "r2"] });
  });
  it("registrations_waiting from the count", () => {
    expect(resolveAttention(input({ awaitingRegistrations: 2 }))).toContainEqual({ kind: "registrations_waiting", count: 2 });
    expect(resolveAttention(input({ awaitingRegistrations: 0 })).some((a) => a.kind === "registrations_waiting")).toBe(false);
  });
  it("orders red before amber before slate", () => {
    const stages = [stage({ id: "fin", name: "Finals", seq: 2, status: "pending", hasFixtures: false, needsProposal: true })];
    const fixtures = [fx({ id: "u", scheduledAt: null })];
    const kinds = resolveAttention(input({ stages, fixtures, awaitingRegistrations: 1 })).map((a) => a.kind);
    expect(kinds).toEqual(["needs_draw", "unscheduled", "registrations_waiting"]);
  });
});
