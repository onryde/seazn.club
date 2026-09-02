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
  id: "f1", status: "scheduled", scheduledAt: "2026-09-12T09:00:00Z", eventCount: 0, matchMinutes: 90, ...o,
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
  it("1 finished: no pending/active stage and no live fixture", () => {
    expect(resolvePhase(input({ stages: [], fixtures: [fx({ status: "decided" })] }))).toBe("finished");
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
    expect(resolveAttention(input({ fixtures }))).toContainEqual({ kind: "no_scorer", fixtureId: "p", minutesSinceKickoff: 12 });
  });
  it("no_scorer is not raised once an event exists", () => {
    const fixtures = [fx({ id: "p", status: "in_play", eventCount: 3 })];
    expect(resolveAttention(input({ fixtures })).some((a) => a.kind === "no_scorer")).toBe(false);
  });
  it("result_missing: scheduled, kickoff + matchMinutes already passed", () => {
    const fixtures = [fx({ id: "r", scheduledAt: "2026-09-05T07:00:00Z", matchMinutes: 90 })];
    expect(resolveAttention(input({ fixtures }))).toContainEqual({ kind: "result_missing", fixtureId: "r" });
  });
  it("result_missing is not raised while the match window is still open", () => {
    const fixtures = [fx({ id: "r", scheduledAt: "2026-09-05T09:00:00Z", matchMinutes: 90 })];
    expect(resolveAttention(input({ fixtures })).some((a) => a.kind === "result_missing")).toBe(false);
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
