import { describe, expect, it } from "vitest";
import {
  resolvePhase,
  resolveAttention,
  localDateKey,
  ledgerRank,
  leadingAttention,
  hasPlayedFixture,
  isResultMissing,
  isUnscheduledFixture,
  DEFAULT_MATCH_MINUTES,
  NOT_RECORDING_GRACE_MINUTES,
  type Attention,
  type PhaseInput,
  type PhaseFixture,
  type PhaseStage,
} from "@/lib/division-phase";

const NOW = "2026-09-05T09:42:00Z"; // Sat 10:42 Europe/London (BST)
const TZ = "Europe/London";

const stage = (o: Partial<PhaseStage> = {}): PhaseStage => ({
  id: "st1", name: "League", seq: 1, status: "active", hasFixtures: true,
  timing: null, sourceReady: false, proposal: "none", ...o,
});
const fx = (o: Partial<PhaseFixture> = {}): PhaseFixture => ({
  id: "f1", status: "scheduled", scheduledAt: "2026-09-12T09:00:00Z", startedAt: null, eventCount: 0, matchMinutes: 90,
  hasScorer: false, stageId: "st1", tbd: false, ...o,
});
/**
 * M1 (fix round I): a stage that owes its DRAW — the only shape that raises
 * `needs_draw` now, and every conjunct of it is load-bearing (each one is
 * mutated on its own below). It is deliberately built as a stage PLUS the
 * TBD fixture that belongs to it: "has this bracket been drawn?" is a
 * question about a stage that only its fixtures can answer, so a stage
 * literal on its own can no longer claim it.
 */
const drawable = (o: Partial<PhaseStage> = {}): PhaseStage =>
  // `active`, not `pending`: generating the TBD bracket — the step that
  // makes a draw computable at all — moves the stage to `active`.
  stage({ id: "fin", name: "Finals", seq: 2, status: "active", hasFixtures: true,
          timing: "setup", sourceReady: true, proposal: "none", ...o });
const tbdFx = (stageId: string, o: Partial<PhaseFixture> = {}): PhaseFixture =>
  fx({ id: `${stageId}-tbd`, stageId, tbd: true, status: "scheduled", scheduledAt: null, ...o });
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
  // J2 (fix round F, Critical — the eighth instance of this wave's signature
  // defect, a row contradicting itself). Rule 2 had THREE disjuncts and only
  // two of them checked `noLiveFixture`: `everyStageComplete` alone declared a
  // division finished no matter what its fixtures were still doing. That is
  // the same vacuous shape amendment 2/3 keep catching one level down — a
  // fact about STAGES answering a question about FIXTURES.
  //
  // Reachable in production, and driven end to end through the real API
  // before this fix (fix-round-f-report.md): a knockout carrying a
  // third-place playoff (`config.thirdPlace`, stages.ts:772) completes on its
  // FINAL alone — `isBracketStageComplete` (packages/engine, stage.ts:134)
  // only requires the `isFinal` fixtures — so `POST /stages/{id}/complete`
  // returns 200 with `division_completed: true` while the playoff is still
  // `scheduled` and dated. The desk then rendered "Cup · 3 of 4 played ·
  // complete · Finished" directly beside a red "result missing for Seed4 v
  // Seed2 · The match window has passed with no result · Enter result".
  //
  // Which half was the lie was settled by driving it, not by argument: the
  // "Enter result" prompt is live on a `completed` division (scoring.ts gates
  // only `setup`/`scheduled`), the POST returns 201, and the row then reads
  // "4 of 4 played · complete · Finished" with no Needs-you at all. The
  // attention was right; the pill was wrong.
  it("2 NOT finished: every stage complete but a dated fixture is still unplayed (J2)", () => {
    const stages = [stage({ status: "complete" })];
    const fixtures = [
      fx({ id: "final", status: "decided" }),
      // The third-place playoff: still `scheduled`, and its window has passed.
      fx({ id: "3p", status: "scheduled", scheduledAt: "2026-09-04T09:00:00Z" }),
    ];
    expect(resolvePhase(input({ divisionStatus: "completed", stages, fixtures }))).not.toBe("finished");
    // Pin the RUNG, not just "not finished": with the playoff on a past date
    // rule 3 (match_day) does not match either, so this is rule 5 — and rule
    // 5 is the answer only because rules 3 and 4 were asked first and said no.
    expect(resolvePhase(input({ divisionStatus: "completed", stages, fixtures }))).toBe("scheduled");
    // …and the row states the outstanding work rather than swallowing it.
    expect(resolveAttention(input({ divisionStatus: "completed", stages, fixtures })).map((a) => a.kind))
      .toContain("result_missing");
  });
  it("2 NOT finished: every stage complete but a fixture is dated TODAY — match_day wins (J2, order)", () => {
    // Same shape one rung higher: the unplayed playoff is dated today, so the
    // ladder must reach rule 3. A test that only asserted `!== "finished"`
    // could not tell rule 3 from rule 5, and the two disagree here.
    const stages = [stage({ status: "complete" })];
    const fixtures = [
      fx({ id: "final", status: "decided" }),
      fx({ id: "3p", status: "scheduled", scheduledAt: "2026-09-05T18:00:00Z" }),
    ];
    expect(resolvePhase(input({ divisionStatus: "completed", stages, fixtures }))).toBe("match_day");
  });
  it("2 NOT finished: every stage complete but a fixture is IN PLAY", () => {
    // The worse version of the same row: "Finished" beside "1 in play".
    const stages = [stage({ status: "complete" })];
    const fixtures = [fx({ id: "a", status: "decided" }), fx({ id: "b", status: "in_play" })];
    expect(resolvePhase(input({ divisionStatus: "completed", stages, fixtures }))).toBe("match_day");
  });
  it("2 finished: every stage complete and the remaining fixtures are terminal, not live", () => {
    // The other direction of J2's guard — a fixture that will never be played
    // is TERMINAL (cancelled/abandoned/forfeited/void), not `scheduled`, and
    // must still read finished. Without this, the fix could have been written
    // as "any non-decided fixture blocks finished" and nothing would say so.
    const stages = [stage({ status: "complete" })];
    const fixtures = [
      fx({ id: "a", status: "decided" }),
      fx({ id: "b", status: "cancelled", scheduledAt: "2026-09-04T09:00:00Z" }),
      fx({ id: "c", status: "abandoned" }),
    ];
    expect(resolvePhase(input({ divisionStatus: "completed", stages, fixtures }))).toBe("finished");
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
  // REVERSED by J2 (fix round F, Critical). This test used to assert
  // `"finished"` for exactly this input, under the comment "isolates the
  // everyStageComplete arm: noLiveFixture is false here" — a structural
  // isolation of a disjunct, with no defect, ruling or live observation
  // behind it, which is how it came to freeze a live bug as its expected
  // value. Driven through the real API, this input is a knockout whose
  // third-place playoff is still unplayed, and the desk rendered "3 of 4
  // played · complete · Finished" beside a red "result missing … Enter
  // result" for that fixture. The arm still needs isolating, so the test
  // stays — with the expectation the product actually owes.
  it("2 everyStageComplete does NOT win over a live fixture: it is gated by noLiveFixture too (J2)", () => {
    const stages = [stage({ status: "complete" })];
    // 18:00 on NOW's own day, so this lands on rule 3 and not merely "not
    // finished" — the rung is part of the claim.
    expect(resolvePhase(input({ stages, fixtures: [fx({ scheduledAt: "2026-09-05T18:00:00Z" })] }))).toBe("match_day");
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
      stage({ id: "fin", name: "Finals", seq: 2, status: "pending", hasFixtures: false, timing: "setup", sourceReady: true }),
    ];
    const fixtures = [fx({ id: "a", status: "decided" }), fx({ id: "b", status: "finalized" })];
    expect(resolvePhase(input({ stages, fixtures }))).toBe("setting_up");
  });
  // K1 (fix round G, Critical — instance NINE). `openStageOwesWork` asked
  // `lowestOpenStage`, ONE stage, a question about all of them: a LATER
  // pending stage with zero fixtures was invisible and the `allPlayed` arm
  // won. Driven live through the production API before this fix: masthead
  // "Finished", row pill "Finished", "6 of 6 played · complete", and no
  // Needs-you item, with an entire knockout never seeded.
  //
  // The lowest open stage here is DELIBERATELY fine (active, with fixtures,
  // owing no proposal) — with a single-stage guard this case is
  // indistinguishable from "2 finished: all fixtures played even though the
  // stage is still active" three tests up, which is exactly why nothing
  // caught it.
  it("2 NOT finished: a LATER open stage with zero fixtures blocks it, even when the lowest open stage owes nothing", () => {
    const stages = [
      stage({ id: "lg", seq: 1, status: "active", hasFixtures: true }),
      stage({ id: "fin", name: "Finals", seq: 2, status: "pending", hasFixtures: false }),
    ];
    const fixtures = [fx({ id: "a", status: "decided" }), fx({ id: "b", status: "finalized" })];
    expect(resolvePhase(input({ stages, fixtures }))).toBe("scheduled");
  });
  it("2 NOT finished: the sibling shape — lowest stage COMPLETE, later stage pending with zero fixtures", () => {
    const stages = [
      stage({ id: "lg", seq: 1, status: "complete", hasFixtures: true }),
      stage({ id: "fin", name: "Finals", seq: 2, status: "pending", hasFixtures: false }),
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
  // H1 (final review round 3, Critical) has NO unit test here, deliberately —
  // fix round F, minor 4. There used to be one, titled "one zone per fixture —
  // the SAME instant reads match_day in the venue zone and NOT in the org
  // zone". It was a tautology dressed as the rule: `resolvePhase` has no
  // opinion about org vs venue, it buckets by whatever `tz` it is handed, so
  // the test could only ever restate its own argument. It survived the
  // reviewer's M1 mutant (`tz: displayTz` -> `orgTz` in competition-desk.ts),
  // which is the actual H1 bug, and the case it did pin — two zones disagreeing
  // about one instant — is already pinned one test up ("00:30 local today
  // counts as today, 23:30 UTC yesterday does not in UTC"), which kills the
  // same "ignores its tz argument" mutant.
  //
  // The rule H1 states is a CALLER's rule: pass `resolveVenueTz(divisionTz,
  // orgTz)`, never the bare org zone. No test of a pure resolver can witness
  // which variable its caller passed. The two that do:
  //   - competition-desk.test.ts:501 "H1: match_day is bucketed in the
  //     division's own venue zone, not the org's" — a DB test seeding a
  //     Kolkata division inside a London org; kills M1.
  //   - competition-desk.spec.ts "match day is decided by the venue's calendar
  //     day, not the org's" — the same shape driven through the browser.
  // A green test that pins nothing is worse than an absence with a signpost.
  it("4 setting_up: lowest non-complete stage has no fixtures", () => {
    expect(resolvePhase(input({ stages: [stage({ hasFixtures: false })], fixtures: [] }))).toBe("setting_up");
  });
  it("4 setting_up: U16 shape — league complete, finals pending needs proposal", () => {
    const stages = [
      stage({ id: "lg", seq: 1, status: "complete" }),
      stage({ id: "fin", name: "Finals", seq: 2, status: "pending", hasFixtures: false, timing: "setup", sourceReady: true }),
    ];
    expect(resolvePhase(input({ stages, fixtures: [fx({ status: "decided" })] }))).toBe("setting_up");
  });
  it("4 setting_up: a pending stage with fixtures generated but its draw still owed", () => {
    // Isolates `stageOwesDraw` from `!hasFixtures`: the other operand of
    // `stageOwesWork`'s OR is false here, so only the draw clause can
    // produce this answer.
    const stages = [drawable({ seq: 1 })];
    expect(resolvePhase(input({ stages, fixtures: [tbdFx("fin")] }))).toBe("setting_up");
    // M1 (fix round I): and the SAME stage with its bracket drawn is not
    // setting up — the one fact that separates the two is the fixture.
    expect(resolvePhase(input({ stages, fixtures: [tbdFx("fin", { tbd: false, scheduledAt: "2026-09-12T09:00:00Z" })] })))
      .toBe("scheduled");
  });
  // K1's fix must NOT over-apply to rule 4. Rule 2 asks "is there anything
  // left at all?" of EVERY open stage; rule 4 asks "is the thing that is next
  // up playable?" of the NEXT one only. Answering rule 4 with the same
  // all-stages predicate would print "Setting up" beside "1 of 2 played" for
  // the whole of a league season that has a knockout waiting behind it — the
  // wave's own signature defect, introduced by its own fix. The expected
  // value here differs between the two candidate predicates, which is the
  // point of the case.
  it("4 does NOT fire for a later empty stage while the current stage is still playable", () => {
    const stages = [
      stage({ id: "lg", seq: 1, status: "active", hasFixtures: true }),
      stage({ id: "fin", name: "Finals", seq: 2, status: "pending", hasFixtures: false }),
    ];
    const fixtures = [fx({ id: "a", status: "decided" }), fx({ id: "b", status: "scheduled", scheduledAt: "2026-09-12T09:00:00Z" })];
    expect(resolvePhase(input({ stages, fixtures }))).toBe("scheduled");
  });
  it("5 scheduled: fixtures exist, none today, none in play", () => {
    expect(resolvePhase(input())).toBe("scheduled");
  });
  // fix-round-c, Defect 2 split, case 1/2 (owner ruling 2026-09-02):
  // `played === 0` AND nothing dated. This is F1's own original reported
  // case (0 of 6 played, 6 unscheduled) and MUST stay setting_up — the
  // ruling is explicit that this case "must stay fixed".
  it("5 NOT scheduled: 0 played and fixtures exist but none carry a time — setting_up, never scheduled (F1 fix)", () => {
    // The exact live defect: a started division whose fixtures were all
    // generated with no time read "Scheduled" next to a status line that
    // said "nothing scheduled" — three contradicting facts in one row. No
    // non-terminal fixture carries a scheduledAt AND nothing has been
    // played, so this reads setting_up, which already carries the
    // `unscheduled` attention that says so.
    const fixtures = [fx({ id: "a", scheduledAt: null }), fx({ id: "b", scheduledAt: null })];
    expect(resolvePhase(input({ fixtures }))).toBe("setting_up");
  });
  it("5 scheduled: one dated non-terminal fixture among several undated ones is enough", () => {
    const fixtures = [fx({ id: "a", scheduledAt: null }), fx({ id: "b", scheduledAt: "2026-09-12T09:00:00Z" })];
    expect(resolvePhase(input({ fixtures }))).toBe("scheduled");
  });
  // fix-round-c, Defect 2 split, case 2/2: `played > 0` AND nothing dated.
  // Before this round's fix, F1's own fallback over-applied here — a
  // mid-season division that has played fixtures but not yet dated its next
  // round (the normal way a league runs a round at a time) read "Setting
  // up" beside a part-filled progress bar. Reproduced live: 1 of 6 played,
  // 5 unscheduled, read "Setting up".
  it("5 scheduled (fix-round-c, Defect 2): played > 0 and nothing carries a time — scheduled, never setting_up", () => {
    const fixtures = [fx({ id: "a", status: "decided", scheduledAt: "2026-09-01T09:00:00Z" }), fx({ id: "b", scheduledAt: null })];
    expect(resolvePhase(input({ fixtures }))).toBe("scheduled");
  });
  it("5 NOT scheduled: a terminal-but-unplayed fixture's own past time counts as neither dated-and-live nor played", () => {
    // Isolates BOTH halves that must stay false for `anyPlayed` to matter:
    // "cancelled" is terminal (excluded from hasScheduledFixture's own
    // `status === "scheduled"` check) but is NOT in card-stats.ts's PLAYED
    // set either (only decided/finalized count as "a result exists") — so a
    // division whose only terminal fixture was cancelled, not played, still
    // reads setting_up here, not scheduled.
    const fixtures = [fx({ id: "a", status: "cancelled", scheduledAt: "2026-09-01T09:00:00Z" }), fx({ id: "b", scheduledAt: null })];
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
  // M1 (fix round I, Critical — instance TWELVE). Each condition that decides
  // whether the panel's draw door is BOTH rendered and operable is broken on
  // its own below — the three terms of `stageOwesDraw`, plus the two the
  // CALLER contributes (`openStages`' "not complete", and having any fixtures
  // at all). Break any one and the row must become `needs_fixtures` or
  // nothing, because in that state the draw button is either absent or, as
  // the live click at 11:39Z on 2026-09-03 showed, present and inoperable.
  // The last two are the caller's because a mutation sweep proved they could
  // not die inside the predicate: see `stageOwesDraw`'s own note.
  it("needs_draw ONLY when the panel's draw door is both rendered and operable", () => {
    const stages = [drawable()];
    const fixtures = [tbdFx("fin")];
    expect(resolveAttention(input({ stages, fixtures }))).toContainEqual({
      kind: "needs_draw", stageName: "Finals", door: "compute",
    });
  });
  it.each([
    // conjunct, the shape with it broken, what the row must become instead
    ["no generated fixtures at all (computeSeedProposal 422s SEEDING_RULES_MISSING)",
      { st: { hasFixtures: false }, fx: [] as PhaseFixture[] }, "needs_fixtures"],
    ["the bracket is already drawn (confirming filled every slot)",
      { st: {}, fx: [tbdFx("fin", { tbd: false })] }, undefined],
    ["a source stage is not complete (progression-panel.tsx returns null)",
      { st: { sourceReady: false }, fx: [tbdFx("fin")] }, undefined],
    ["the stage auto-seeds instead (timing on_complete never goes through propose/confirm)",
      { st: { timing: "on_complete" }, fx: [tbdFx("fin")] }, undefined],
    // `openStages` (the caller) owns this one — the predicate itself does not
    // restate it, and this case is what proves the filter is doing the work.
    ["the stage is complete",
      { st: { status: "complete" }, fx: [tbdFx("fin")] }, undefined],
  ])("needs_draw is NOT raised when %s", (_why, shape, becomes) => {
    const out = resolveAttention(input({ stages: [drawable(shape.st)], fixtures: shape.fx }));
    expect(out.some((a) => a.kind === "needs_draw")).toBe(false);
    if (becomes) expect(out.some((a) => a.kind === becomes)).toBe(true);
  });
  // The action LABEL is the panel's own door, not a fixed word: a fixed
  // "Compute proposal" is wrong in two of the three states the panel can be
  // in for exactly this row.
  it.each([
    ["none", "compute"],
    ["draft", "confirm"],
    ["stale", "recompute"],
  ] as const)("a %s proposal makes the action point at the panel's %s door", (proposal, door) => {
    const out = resolveAttention(input({ stages: [drawable({ proposal })], fixtures: [tbdFx("fin")] }));
    expect(out).toContainEqual({ kind: "needs_draw", stageName: "Finals", door });
  });
  it("resolvePhase never reads `proposal` — the field is the action label only", () => {
    const phases = (["none", "draft", "stale", "confirmed"] as const).map((proposal) =>
      resolvePhase(input({ stages: [drawable({ proposal })], fixtures: [tbdFx("fin")] })),
    );
    // All four identical: `d/[divSlug]/page.tsx` hardcodes "none" (it has no
    // organiser-only proposal read), so if the phase ever depended on this
    // field the desk and the division page would disagree about one division.
    expect(new Set(phases).size).toBe(1);
  });
  // K1 (fix round G, Critical — instance NINE), the attention half: the
  // unseeded stage the finding names had NO row of any kind, so nothing on
  // the page asked for the one action that unblocks it.
  it("needs_fixtures names a LATER open stage with nothing to play, once nothing is live", () => {
    const stages = [
      stage({ id: "lg", seq: 1, status: "active", hasFixtures: true }),
      stage({ id: "fin", name: "Finals", seq: 2, status: "pending", hasFixtures: false }),
    ];
    const fixtures = [fx({ id: "a", status: "decided" }), fx({ id: "b", status: "finalized" })];
    expect(resolveAttention(input({ stages, fixtures }))).toContainEqual({
      kind: "needs_fixtures", stageName: "Finals",
    });
  });
  it("needs_fixtures, not needs_draw, for a stage that owes no proposal — the two rows point at different controls", () => {
    const stages = [stage({ id: "fin", name: "Finals", seq: 1, status: "pending", hasFixtures: false })];
    const out = resolveAttention(input({ stages, fixtures: [] }));
    expect(out.map((a) => a.kind)).toEqual(["needs_fixtures"]);
  });
  // The other direction of the same rule: while earlier fixtures are still
  // live, a later stage's emptiness is not yet the organiser's problem and
  // neither of its doors is usable, so a red row there would prompt for an
  // action that cannot be taken.
  it("a later empty stage raises NOTHING while a fixture is still live", () => {
    const stages = [
      stage({ id: "lg", seq: 1, status: "active", hasFixtures: true }),
      stage({ id: "fin", name: "Finals", seq: 2, status: "pending", hasFixtures: false }),
    ];
    const fixtures = [fx({ id: "a", status: "decided" }), fx({ id: "b", status: "scheduled", scheduledAt: "2026-09-12T09:00:00Z" })];
    expect(resolveAttention(input({ stages, fixtures })).some((a) => a.kind === "needs_fixtures")).toBe(false);
  });
  it("needs_fixtures is gated on the division being real — silent while it is still 'setup'", () => {
    // The wizard defines a division's stage graph at CREATE, before a single
    // entrant exists, so an ungated row would put a red "Needs fixtures" on
    // every division the moment it is made, pointing at a Generate button
    // that cannot succeed yet. `needs_draw` stays ungated (H2's ruling, one
    // test below) — the two are deliberately different.
    const stages = [stage({ id: "lg", name: "League", seq: 1, status: "pending", hasFixtures: false })];
    expect(resolveAttention(input({ divisionStatus: "setup", stages, fixtures: [] }))).toEqual([]);
    // And the other direction, or the gate could be "never fires":
    expect(resolveAttention(input({ divisionStatus: "scheduled", stages, fixtures: [] })).map((a) => a.kind)).toEqual(["needs_fixtures"]);
  });
  it("needs_fixtures is red, and sorts with needs_draw ahead of amber and slate", () => {
    const stages = [stage({ id: "fin", name: "Finals", seq: 1, status: "pending", hasFixtures: false })];
    const fixtures = [fx({ id: "u", status: "scheduled", scheduledAt: null })];
    const kinds = resolveAttention(input({ stages, fixtures, awaitingRegistrations: 1 })).map((a) => a.kind);
    expect(kinds).toEqual(["needs_fixtures", "unscheduled", "registrations_waiting"]);
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
  // Minor 1 (fix round G): the `Math.max(0, …)` clamp printed "Kicked off 0
  // min ago" for a kick-off in the FUTURE — the same misleading zero the
  // null case was already fixed for. An elapsed time we cannot state is
  // `null`, which renders the "unknown" sub-line instead of a number.
  it("no_scorer: minutesSinceKickoff is null, not 0, for an in_play fixture dated in the FUTURE", () => {
    const fixtures = [fx({ id: "p", status: "in_play", scheduledAt: "2026-09-05T10:42:00Z", eventCount: 0 })];
    expect(resolveAttention(input({ fixtures }))).toContainEqual({
      kind: "no_scorer", count: 1, fixtureIds: ["p"], minutesSinceKickoff: null,
    });
  });
  it("no_scorer: a malformed scheduledAt gives null, never a NaN that renders as 'NaN min ago'", () => {
    const fixtures = [fx({ id: "p", status: "in_play", scheduledAt: "not-a-date", eventCount: 0 })];
    expect(resolveAttention(input({ fixtures }))).toContainEqual({
      kind: "no_scorer", count: 1, fixtureIds: ["p"], minutesSinceKickoff: null,
    });
  });
  // Review 7, Important 4: `stageOwesDraw`'s `f.stageId === stage.id` had no
  // test at any layer — a mutant dropping it survived 246/246. It is
  // load-bearing, not cosmetic: `tbd` is derived from a missing entrant, and a
  // BYE in an earlier stage is exactly that. Without the scoping, any division
  // whose league contains a bye would raise red "Needs draw · Compute
  // proposal" for an ungenerated Finals — instance TWELVE, regenerated, and
  // pointing at a panel button that cannot be operated.
  it("needs_draw is scoped to its OWN stage: a bye in an earlier stage does not draw the finals", () => {
    const stages = [
      // Complete, and nothing of its own still live — otherwise a LATER stage
      // is deliberately not reported at all and the case proves nothing.
      stage({ id: "lg", name: "League", seq: 1, status: "complete", hasFixtures: true }),
      // Its bracket was never generated, so this stage owes FIXTURES, not a
      // draw — whatever tbd fixtures exist elsewhere in the division.
      drawable({ id: "fin", name: "Finals", hasFixtures: false }),
    ];
    const fixtures = [
      // The bye: a played league fixture that never had a second side.
      fx({ id: "bye", stageId: "lg", status: "decided", tbd: true, scheduledAt: null }),
    ];
    const kinds = resolveAttention(input({ stages, fixtures })).map((a) => a.kind);
    expect(kinds, "a bye in the league must not be read as the finals' bracket").toContain("needs_fixtures");
    expect(kinds).not.toContain("needs_draw");
  });

  // ── F3 (round J): `not_recording` — the assigned-but-silent scorer ──────
  //
  // Every boundary below is DERIVED from NOT_RECORDING_GRACE_MINUTES. A `15`
  // typed in here would keep asserting yesterday's number the moment the
  // constant moves (recurring failure class 19), and the pair of cases either
  // side of the boundary is what makes the constant itself load-bearing:
  // widening or narrowing the grace kills exactly one of them.
  const minutesAgo = (m: number) => new Date(Date.parse(NOW) - m * 60_000).toISOString();
  // The clock is `startedAt` (core.start's own recorded_at), NOT `scheduledAt`
  // — review 7, Minor 8b. `scheduledAt` is deliberately set to something quite
  // different here so any case that silently falls back to it fails loudly
  // rather than agreeing by coincidence.
  const silent = (o: Partial<PhaseFixture> = {}): PhaseFixture =>
    fx({ id: "s", status: "in_play", eventCount: 0, hasScorer: true,
         scheduledAt: minutesAgo(600), startedAt: minutesAgo(NOT_RECORDING_GRACE_MINUTES), ...o });

  it("not_recording: the grace is fifteen minutes — the shipped value, not just whatever the constant says", () => {
    // Every other case here DERIVES its boundary from the constant, which is
    // right (they must not freeze yesterday's number) and is exactly why none
    // of them can witness the constant itself changing: a sweep that set the
    // grace to 0 left all of them green. This is the one guard that pins the
    // VALUE, so widening or removing the grace is a deliberate edit here and
    // not a silent one (recurring failure class 19).
    expect(NOT_RECORDING_GRACE_MINUTES).toBe(15);
  });
  it("not_recording: five minutes into a live match is a slow start, not a row", () => {
    // Stated in absolute terms on purpose — the customer fact is "the desk
    // does not nag five minutes after kick-off", and it must stay true
    // however the constant is expressed.
    const fixtures = [silent({ startedAt: minutesAgo(5) })];
    expect(resolveAttention(input({ fixtures })).map((a) => a.kind)).toEqual([]);
  });
  it("not_recording: raised at exactly the grace, with the elapsed minutes it claims", () => {
    expect(resolveAttention(input({ fixtures: [silent()] }))).toContainEqual({
      kind: "not_recording", count: 1, fixtureIds: ["s"],
      minutesSinceKickoff: NOT_RECORDING_GRACE_MINUTES,
    });
  });
  it("not_recording: NOT raised one minute inside the grace — a slow start is not a defect", () => {
    const fixtures = [silent({ startedAt: minutesAgo(NOT_RECORDING_GRACE_MINUTES - 1) })];
    // And nothing else takes its place: the fixture is silent but excused,
    // so the organiser sees no row at all rather than a differently-worded one.
    expect(resolveAttention(input({ fixtures })).map((a) => a.kind)).toEqual([]);
  });
  it("not_recording: an unknown elapsed time raises NOTHING, never a synthesised zero", () => {
    // Three ways the clock can be unstatable. None of them may produce a row
    // claiming recording is late — the claim needs a number to stand on.
    for (const startedAt of [null, "not-a-date", minutesAgo(-30)]) {
      // `scheduledAt` is nulled too: with a fallback in the derivation, leaving
      // a usable scheduled time here would let the row fire off the PLAN and
      // this case would pass while proving nothing.
      const fixtures = [silent({ startedAt, scheduledAt: null })];
      const kinds = resolveAttention(input({ fixtures })).map((a) => a.kind);
      expect(kinds, `startedAt=${String(startedAt)}`).not.toContain("not_recording");
    }
  });
  it("not_recording: a LATE-STARTING match gets its full grace from the kick-off, not from the plan", () => {
    // Review 7, Minor 8b. `fixtures` has no kick-off column, so this used to
    // measure from `scheduledAt` — and a match that starts 90 minutes late is
    // an ordinary venue event. It would have raised the row the instant it
    // went live, reading "Kicked off 90 min ago", making the grace worth
    // nothing for exactly the matches most likely to be chaotic.
    //
    // The two times disagree on purpose, and the expected answer differs
    // between them: measured from the plan this row fires, measured from the
    // kick-off it does not.
    const fixtures = [silent({ scheduledAt: minutesAgo(90), startedAt: minutesAgo(2) })];
    expect(resolveAttention(input({ fixtures })).map((a) => a.kind)).toEqual([]);
  });
  it("not_recording: cleared by the first recorded event", () => {
    const fixtures = [silent({ eventCount: 1 })];
    expect(resolveAttention(input({ fixtures })).some((a) => a.kind === "not_recording")).toBe(false);
  });
  it("not_recording and no_scorer are complements — no fixture can ever raise both", () => {
    // The pair, on one division: same status, same zero events, `hasScorer`
    // the other way round. Two rows, disjoint fixture sets. If either
    // predicate ever stops consulting `hasScorer`, one of these fixtures
    // appears in both lists and the desk contradicts itself about one match.
    const fixtures = [
      silent({ id: "assigned" }),
      silent({ id: "nobody", hasScorer: false }),
    ];
    const out = resolveAttention(input({ fixtures }));
    const nr = out.find((a) => a.kind === "not_recording");
    const ns = out.find((a) => a.kind === "no_scorer");
    expect(nr).toMatchObject({ fixtureIds: ["assigned"] });
    expect(ns).toMatchObject({ fixtureIds: ["nobody"] });
  });
  it("not_recording aggregates per division — one row, worst silence wins", () => {
    const fixtures = [
      silent({ id: "s1", startedAt: minutesAgo(NOT_RECORDING_GRACE_MINUTES) }),
      silent({ id: "s2", startedAt: minutesAgo(NOT_RECORDING_GRACE_MINUTES + 27) }),
    ];
    const out = resolveAttention(input({ fixtures }));
    expect(out.filter((a) => a.kind === "not_recording")).toHaveLength(1);
    expect(out).toContainEqual({
      kind: "not_recording", count: 2, fixtureIds: ["s1", "s2"],
      minutesSinceKickoff: NOT_RECORDING_GRACE_MINUTES + 27,
    });
  });
  it("not_recording respects the division's own status: a `setup` division raises nothing", () => {
    const kinds = resolveAttention(input({ divisionStatus: "setup", fixtures: [silent()] })).map((a) => a.kind);
    expect(kinds).not.toContain("not_recording");
  });
  it("not_recording sorts directly after no_scorer, ahead of the other ambers", () => {
    // An ORDERING-differential case: severity puts the red first, and inside
    // the amber band KIND_ORDER is the only thing that puts `not_recording`
    // ahead of `unscheduled` and `result_missing`. Move it in that array and
    // this is the test that dies.
    const fixtures = [
      silent({ id: "nobody", hasScorer: false }),                       // no_scorer, red
      silent({ id: "quiet" }),                                          // not_recording, amber
      fx({ id: "u", status: "scheduled", scheduledAt: null }),          // unscheduled, amber
      fx({ id: "r", status: "scheduled", scheduledAt: minutesAgo(300), matchMinutes: 90 }), // result_missing, amber
    ];
    expect(resolveAttention(input({ fixtures })).map((a) => a.kind)).toEqual([
      "no_scorer", "not_recording", "unscheduled", "result_missing",
    ]);
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
    const stages = [drawable()];
    const fixtures = [tbdFx("fin"), fx({ id: "u", scheduledAt: null })];
    const kinds = resolveAttention(input({ stages, fixtures, awaitingRegistrations: 1 })).map((a) => a.kind);
    expect(kinds).toEqual(["needs_draw", "unscheduled", "registrations_waiting"]);
  });

  // G3 fix (fix round D, Important), CORRECTED by H2 (final review round 3,
  // Important): resolveAttention used to never read `divisionStatus` at all
  // — a never-started division whose fixtures were dated in the past raised
  // `result_missing` anyway. Live repro: "Unstarted · result missing for
  // Alpha FC v Delta FC" directly above the SAME division's own "Setting
  // up" row. G3's fix gated on `divisionStatus === "active"`, which ALSO
  // excluded `scheduled` — but `scheduled` is exactly what the ordinary
  // Publish action sets (schedule.ts's `publishSchedule`), not a "not yet
  // real" state. Live: six fixtures dated YESTERDAY on a published,
  // never-started division produced NO "Needs you" section at all — an
  // organiser who published a timetable and never pressed Start got no
  // prompt of any kind. RULING (H2): the gate excludes `setup` only —
  // `setup`, `scheduled`, `active`, `completed` are the full
  // divisions_status_check set, and every one but `setup` genuinely owes a
  // result once its match window has passed.
  describe("G3/H2: no_scorer/result_missing respect the division's own status", () => {
    it("result_missing does NOT fire for a division that has never started (status 'setup'), even with the match window long passed", () => {
      const fixtures = [fx({ id: "r", scheduledAt: "2026-09-01T07:00:00Z", matchMinutes: 90 })];
      const out = resolveAttention(input({ divisionStatus: "setup", fixtures }));
      expect(out.some((a) => a.kind === "result_missing")).toBe(false);
    });
    // H2 fix: this used to assert `false` here — G3's gate wrongly excluded
    // a published-but-unstarted timetable, the desk's headline silence bug.
    it("H2: result_missing DOES fire for a division that is only 'scheduled' (published, not started)", () => {
      const fixtures = [fx({ id: "r", scheduledAt: "2026-09-01T07:00:00Z", matchMinutes: 90 })];
      const out = resolveAttention(input({ divisionStatus: "scheduled", fixtures }));
      expect(out).toContainEqual({ kind: "result_missing", count: 1, fixtureIds: ["r"] });
    });
    it("result_missing DOES fire once the division is 'active'", () => {
      const fixtures = [fx({ id: "r", scheduledAt: "2026-09-01T07:00:00Z", matchMinutes: 90 })];
      const out = resolveAttention(input({ divisionStatus: "active", fixtures }));
      expect(out).toContainEqual({ kind: "result_missing", count: 1, fixtureIds: ["r"] });
    });
    // H2 fix: `completed` is also not `setup`, so it is included too — the
    // gate is a single exclusion, never an allowlist of specific statuses
    // (a reordering/allowlist mutant that special-cased "active" only would
    // survive every test above but die here).
    it("H2: result_missing DOES fire for a 'completed' division too — the gate excludes setup ONLY, not an allowlist of the other three", () => {
      const fixtures = [fx({ id: "r", scheduledAt: "2026-09-01T07:00:00Z", matchMinutes: 90 })];
      const out = resolveAttention(input({ divisionStatus: "completed", fixtures }));
      expect(out).toContainEqual({ kind: "result_missing", count: 1, fixtureIds: ["r"] });
    });
    it("no_scorer does NOT fire for an in_play fixture on a division that has never started (status 'setup')", () => {
      const fixtures = [fx({ id: "p", status: "in_play", eventCount: 0, hasScorer: false })];
      const out = resolveAttention(input({ divisionStatus: "setup", fixtures }));
      expect(out.some((a) => a.kind === "no_scorer")).toBe(false);
    });
    it("needs_draw, unscheduled and registrations_waiting are NOT gated by divisionStatus — every one legitimately applies before Start", () => {
      const stages = [drawable({ seq: 1 })];
      const fixtures = [tbdFx("fin"), fx({ id: "u", status: "scheduled", scheduledAt: null })];
      const out = resolveAttention(input({ divisionStatus: "setup", stages, fixtures, awaitingRegistrations: 2 }));
      expect(out.map((a) => a.kind).sort()).toEqual(["needs_draw", "registrations_waiting", "unscheduled"]);
    });
  });
});

/**
 * Minor 1 (fix round H): `openStages` sorts by `seq`, and that sort is the
 * ONLY ordering authority for two order-dependent readers — rule 4's
 * `open[0]` and `resolveAttention`'s `blocked` (`i === 0`).
 * `competition-desk.ts`'s stage query is `from stages s where s.division_id =
 * any(...)` with no `order by`, and the division page feeds `resolvePhase`
 * from a DIFFERENT query (`listStages`) again, so Postgres may hand either
 * caller its rows in any order. Deleting the sort left 147/147 green.
 *
 * Pinned HERE rather than by adding `order by s.seq` to that one query, on
 * purpose: the sort is the authority, and it has to hold for every caller.
 * Pinning the order in one SQL statement would guard one of the two callers
 * and create a SECOND authority for the same fact — the exact drift class
 * this wave has already paid for three times (two zones, two `needsProposal`
 * expressions, three hand-copies of "which kinds are red").
 *
 * The input is deliberately handed to the module in REVERSE seq order, which
 * is the only shape whose expected value differs with and without the sort.
 */
describe("openStages is the ordering authority — Minor 1 (fix round H)", () => {
  // Stage 1 is playable (fixtures generated, no draw owed); stage 2 owes its
  // fixtures. One LIVE fixture, so `blocked`'s `i === 0 || noLive` cannot
  // rescue the later stage — only the sort decides which stage is index 0.
  const reversed = () =>
    input({
      divisionStatus: "active",
      stages: [
        stage({ id: "s2", name: "Finals", seq: 2, status: "pending", hasFixtures: false }),
        stage({ id: "s1", name: "League", seq: 1, status: "active", hasFixtures: true }),
      ],
      fixtures: [fx({ id: "f1", status: "scheduled", scheduledAt: "2026-09-12T09:00:00Z" })],
    });

  it("rule 4 asks the LOWEST-seq open stage, whatever order the rows arrive in", () => {
    // Without the sort, `open[0]` is Finals — which owes its fixtures — and a
    // mid-season league reads "Setting up".
    expect(resolvePhase(reversed())).toBe("scheduled");
  });

  it("resolveAttention's blocked stage is the LOWEST-seq one, whatever order the rows arrive in", () => {
    // Without the sort, Finals sits at index 0 and raises a red
    // `needs_fixtures` for a stage nobody can act on yet (its own doors stay
    // shut until the league completes).
    expect(resolveAttention(reversed()).some((a) => a.kind === "needs_fixtures")).toBe(false);
  });
});

/**
 * L1 (fix round H, Critical). The progress predicate the fixtures tab's
 * start-locks tip, and rule 6, both ask instead of reading the phase WORD.
 */
describe("hasPlayedFixture", () => {
  it("counts only a recorded RESULT — never a terminal-but-unplayed fixture", () => {
    expect(hasPlayedFixture([])).toBe(false);
    expect(hasPlayedFixture([{ status: "scheduled" }, { status: "in_play" }])).toBe(false);
    // The three terminal statuses that are NOT a played result — the same
    // distinction card-stats.ts's PLAYED set draws.
    expect(hasPlayedFixture([{ status: "abandoned" }, { status: "forfeited" }, { status: "cancelled" }])).toBe(false);
    expect(hasPlayedFixture([{ status: "scheduled" }, { status: "decided" }])).toBe(true);
    expect(hasPlayedFixture([{ status: "finalized" }])).toBe(true);
  });
});

/**
 * L3 (fix round H, Important): the competition page's ledger sorts RED FIRST
 * — a red attention outranks the phase, the same model rule the pill already
 * obeys. It lived inline in an async server component that vitest cannot
 * reach, so deleting the red clause left 147/147 green and no e2e asserted
 * row order. The rank now lives here, beside `ATTENTION_SEVERITY` (its only
 * authority for "which kinds are red"), where it can be mutated and killed
 * without a rebuild; `competition-desk.spec.ts` asserts the rendered ROW
 * ORDER on top of it.
 */
describe("leadingAttention — the one thing the masthead says", () => {
  const RED_DRAW = { kind: "needs_draw", stageName: "Finals", door: "compute" } as const;
  const RED_SCORER: Attention = { kind: "no_scorer", count: 1, fixtureIds: ["f"], minutesSinceKickoff: 9 };
  const AMBER_QUIET: Attention = { kind: "not_recording", count: 1, fixtureIds: ["q"], minutesSinceKickoff: 30 };
  const AMBER_UNSCHED = { kind: "unscheduled", count: 2 } as const;
  const SLATE = { kind: "registrations_waiting", count: 4 } as const;
  const div = (...attention: Attention[]) => ({ attention });

  it("nothing to say when no division has an attention", () => {
    expect(leadingAttention([])).toBeNull();
    expect(leadingAttention([div(), div()])).toBeNull();
  });
  it("a division the ledger renders without desk data contributes nothing", () => {
    // The `null` row is real: `getCompetitionDesk` can fail for one division
    // and the ledger still renders it from card stats. The masthead must not
    // claim to know something about a row it knows nothing about.
    expect(leadingAttention([null, null])).toBeNull();
    expect(leadingAttention([null, div(SLATE)])).toEqual(SLATE);
  });
  it("severity wins across divisions, whatever order they arrive in", () => {
    expect(leadingAttention([div(SLATE), div(AMBER_UNSCHED), div(RED_DRAW)])).toEqual(RED_DRAW);
    expect(leadingAttention([div(RED_DRAW), div(AMBER_UNSCHED), div(SLATE)])).toEqual(RED_DRAW);
  });
  it("KIND_ORDER breaks a tie inside one severity band — the case a reorder kills", () => {
    // Both amber, so severity cannot separate them: only the kind order can,
    // and it puts `not_recording` ahead of `unscheduled`. Swap those two in
    // KIND_ORDER and this is the assertion that dies — without it the
    // tie-break has no test at any layer.
    expect(leadingAttention([div(AMBER_UNSCHED), div(AMBER_QUIET)])).toEqual(AMBER_QUIET);
    expect(leadingAttention([div(AMBER_QUIET), div(AMBER_UNSCHED)])).toEqual(AMBER_QUIET);
    // Same again one band up, so the rule is not an accident of the amber row.
    expect(leadingAttention([div(RED_SCORER), div(RED_DRAW)])).toEqual(RED_DRAW);
  });
  it("picks one, never summarises: the winner is a row the pill can already print", () => {
    // The masthead renders through the same PhasePill the rows use, so
    // whatever comes back must be an Attention exactly as a row carries it —
    // not a synthesised count, not a new kind.
    const out = leadingAttention([div(AMBER_UNSCHED, RED_DRAW), div(SLATE)]);
    expect(out).toBe(RED_DRAW);
  });
});

describe("ledgerRank — red outranks the phase", () => {
  const red = { kind: "needs_draw", stageName: "Finals", door: "compute" } as const;
  const amber = { kind: "unscheduled", count: 2 } as const;

  it("ranks the four phases in ledger order", () => {
    expect(ledgerRank({ phase: "match_day", attention: [] })).toBeLessThan(ledgerRank({ phase: "scheduled", attention: [] }));
    expect(ledgerRank({ phase: "scheduled", attention: [] })).toBeLessThan(ledgerRank({ phase: "setting_up", attention: [] }));
    expect(ledgerRank({ phase: "setting_up", attention: [] })).toBeLessThan(ledgerRank({ phase: "finished", attention: [] }));
  });

  it("a red attention lifts a row above EVERY phase, including match_day", () => {
    // The load-bearing case, and the one that dies without the red clause: a
    // `setting_up` row is the LOWEST-ranked live phase, so if red did not
    // outrank the phase it would sort below a `match_day` row with nothing
    // wrong with it.
    expect(ledgerRank({ phase: "setting_up", attention: [red] }))
      .toBeLessThan(ledgerRank({ phase: "match_day", attention: [] }));
  });

  it("an AMBER attention does not lift a row — only red outranks the phase", () => {
    expect(ledgerRank({ phase: "setting_up", attention: [amber] }))
      .toBe(ledgerRank({ phase: "setting_up", attention: [] }));
  });

  it("a row with no desk data sorts last, below finished", () => {
    expect(ledgerRank(null)).toBeGreaterThan(ledgerRank({ phase: "finished", attention: [] }));
  });
});

// SERVER module, imported here on purpose: `apps/web` vitest is node-env, so a
// unit test can reach it even though the client components that consume the
// copy below cannot (a client component importing `@/server` drags gRPC and
// Node built-ins into the browser bundle — `tsc` and vitest both pass and
// `next build` fails). Same pattern as `fixture-row-action.test.ts`'s
// `TIMETABLE_MOVABLE_STATUS` pin and `bracket-kinds-sync.test.ts`.
describe("DEFAULT_MATCH_MINUTES is the schema's own default", () => {
  it("equals ScheduleConfig.matchMinutes' .default()", async () => {
    const { ScheduleConfig } = await import("@/server/api-v1/schemas");
    expect(DEFAULT_MATCH_MINUTES).toBe(ScheduleConfig.parse({}).matchMinutes);
  });
});

// The two predicates `resolveAttention` raises `unscheduled` and
// `result_missing` from, exported (max-effort review, findings 1 and 2) so
// the run sheet's filter chips ask this module the question instead of
// deriving their own answer from `fixtureRowAction` — which is gated on
// `canEdit` and, for "needs result", on a DISJOINT status.
describe("isUnscheduledFixture", () => {
  it("is true for a real fixture with no time", () => {
    expect(isUnscheduledFixture({ status: "scheduled", scheduledAt: null })).toBe(true);
  });

  it("is false once a time exists", () => {
    expect(isUnscheduledFixture({ status: "scheduled", scheduledAt: "2026-09-05T10:00:00Z" })).toBe(false);
  });

  it("is false for every non-scheduled status — a decided match with no time is a RESULT", () => {
    for (const status of ["in_play", "decided", "finalized", "cancelled", "abandoned", "forfeited"]) {
      expect(isUnscheduledFixture({ status, scheduledAt: null }), status).toBe(false);
    }
  });

  it("agrees with the `unscheduled` attention it was lifted out of", () => {
    const fixtures: PhaseFixture[] = [
      { id: "a", status: "scheduled", scheduledAt: null, startedAt: null, eventCount: 0, matchMinutes: 30, hasScorer: true, stageId: "s", tbd: false },
      { id: "b", status: "scheduled", scheduledAt: "2026-09-05T10:00:00Z", startedAt: null, eventCount: 0, matchMinutes: 30, hasScorer: true, stageId: "s", tbd: false },
      { id: "c", status: "decided", scheduledAt: null, startedAt: null, eventCount: 0, matchMinutes: 30, hasScorer: true, stageId: "s", tbd: false },
    ];
    const row = resolveAttention({
      divisionStatus: "active", stages: [], fixtures,
      now: "2026-09-05T18:00:00Z", tz: "UTC", awaitingRegistrations: 0,
    }).find((a) => a.kind === "unscheduled");
    expect(row?.kind === "unscheduled" ? row.count : 0).toBe(fixtures.filter(isUnscheduledFixture).length);
  });
});

describe("isResultMissing", () => {
  const NOW = Date.UTC(2026, 8, 5, 18, 0);
  const base = { status: "scheduled", matchMinutes: 60 };

  it("is true once kick-off + matchMinutes has passed", () => {
    expect(isResultMissing({ ...base, scheduledAt: "2026-09-05T16:59:00Z" }, NOW)).toBe(true);
  });

  it("is false while the match is still inside its own matchMinutes", () => {
    expect(isResultMissing({ ...base, scheduledAt: "2026-09-05T17:30:00Z" }, NOW)).toBe(false);
  });

  it("reads the fixture's OWN matchMinutes, not a constant", () => {
    const at = "2026-09-05T17:00:00Z";
    expect(isResultMissing({ status: "scheduled", scheduledAt: at, matchMinutes: 30 }, NOW)).toBe(true);
    expect(isResultMissing({ status: "scheduled", scheduledAt: at, matchMinutes: 90 }, NOW)).toBe(false);
  });

  it("is false for a LIVE match, however long ago it started", () => {
    // The exact disagreement finding 2 names: the run sheet used to count
    // `in_play` — which this predicate never does — as "needs result".
    expect(isResultMissing({ status: "in_play", scheduledAt: "2026-09-05T09:00:00Z", matchMinutes: 60 }, NOW)).toBe(false);
  });

  it("is false for an untimed fixture — an unknown kick-off cannot be overdue", () => {
    expect(isResultMissing({ ...base, scheduledAt: null }, NOW)).toBe(false);
  });

  it("agrees with the `result_missing` attention it was lifted out of", () => {
    const fixtures: PhaseFixture[] = [
      { id: "a", status: "scheduled", scheduledAt: "2026-09-05T10:00:00Z", startedAt: null, eventCount: 1, matchMinutes: 60, hasScorer: true, stageId: "s", tbd: false },
      { id: "b", status: "scheduled", scheduledAt: "2026-09-05T17:45:00Z", startedAt: null, eventCount: 1, matchMinutes: 60, hasScorer: true, stageId: "s", tbd: false },
      { id: "c", status: "in_play", scheduledAt: "2026-09-05T09:00:00Z", startedAt: "2026-09-05T09:00:00Z", eventCount: 1, matchMinutes: 60, hasScorer: true, stageId: "s", tbd: false },
    ];
    const nowIso = "2026-09-05T18:00:00Z";
    const row = resolveAttention({
      divisionStatus: "active", stages: [], fixtures,
      now: nowIso, tz: "UTC", awaitingRegistrations: 0,
    }).find((a) => a.kind === "result_missing");
    expect(row?.kind === "result_missing" ? row.fixtureIds : []).toEqual(
      fixtures.filter((f) => isResultMissing(f, Date.parse(nowIso))).map((f) => f.id),
    );
  });
});
