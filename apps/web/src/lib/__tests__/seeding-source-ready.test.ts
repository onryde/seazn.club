// Pure parity tests against resolveProgressionSource's own semantics
// (server/usecases/stage-seeding.ts:73-111) — see seeding-source-ready.ts's
// docstring for the field-for-field mapping. No RSC render, no mocks: this
// is what the division page's `seedingSourcesReady` derivation actually
// runs, in isolation.
import { describe, expect, it } from "vitest";
import {
  confirmedDrawReopens,
  resolveSeedingSourceStage,
  seedingSourceReady,
  type SeedingKindStage,
  type SeedingSourceStage,
} from "../seeding-source-ready";

const ROOT: SeedingSourceStage = { id: "root", division_id: "div-1", seq: 1, status: "complete" };
const MID: SeedingSourceStage = { id: "mid", division_id: "div-1", seq: 2, status: "in_progress" };
const KO: SeedingSourceStage = { id: "ko", division_id: "div-1", seq: 3, status: "setup" };
const OTHER_DIVISION: SeedingSourceStage = { id: "foreign", division_id: "div-2", seq: 0, status: "complete" };

describe("resolveSeedingSourceStage — 'previous'", () => {
  it("resolves the same-division stage with the largest seq less than the target's", () => {
    const found = resolveSeedingSourceStage([ROOT, MID, OTHER_DIVISION], KO, "previous");
    expect(found?.id).toBe("mid");
  });

  it("returns undefined for the division's first stage (mirrors the 422 resolveProgressionSource throws)", () => {
    const found = resolveSeedingSourceStage([ROOT], ROOT, "previous");
    expect(found).toBeUndefined();
  });

  it("never crosses divisions", () => {
    const found = resolveSeedingSourceStage([OTHER_DIVISION], { division_id: "div-1", seq: 5 }, "previous");
    expect(found).toBeUndefined();
  });
});

describe("resolveSeedingSourceStage — explicit {stageId} (review finding: was unvalidated)", () => {
  it("resolves the named stage when it's genuinely earlier (by seq) in the same division", () => {
    const found = resolveSeedingSourceStage([ROOT, MID, KO], KO, { stageId: "root" });
    expect(found?.id).toBe("root");
  });

  it("rejects a same-or-later-seq stage — mirrors resolveProgressionSource's `row.seq >= target.seq` 422", () => {
    const laterNamedAsSource = resolveSeedingSourceStage([ROOT, MID, KO], ROOT, { stageId: "ko" });
    expect(laterNamedAsSource).toBeUndefined();
    const sameStageNamedAsItsOwnSource = resolveSeedingSourceStage([ROOT], ROOT, { stageId: "root" });
    expect(sameStageNamedAsItsOwnSource).toBeUndefined();
  });

  it("rejects a stageId from a different division", () => {
    const found = resolveSeedingSourceStage([OTHER_DIVISION], { division_id: "div-1", seq: 5 }, { stageId: "foreign" });
    expect(found).toBeUndefined();
  });

  it("rejects an unknown stageId", () => {
    const found = resolveSeedingSourceStage([ROOT], KO, { stageId: "nope" });
    expect(found).toBeUndefined();
  });
});

describe("seedingSourceReady", () => {
  it("false while the resolved source stage hasn't completed", () => {
    expect(seedingSourceReady([ROOT, MID], KO, { sources: [{ stage: "previous", take: [] }] })).toBe(false);
  });

  it("true once the resolved source stage is complete", () => {
    const midComplete = { ...MID, status: "complete" };
    expect(seedingSourceReady([ROOT, midComplete], KO, { sources: [{ stage: "previous", take: [] }] })).toBe(true);
  });

  it("false when an explicit source names a misconfigured later-seq stage, even if that stage is 'complete'", () => {
    const koComplete = { ...KO, status: "complete" };
    expect(
      seedingSourceReady([ROOT, koComplete], ROOT, { sources: [{ stage: { stageId: "ko" }, take: [] }] }),
    ).toBe(false);
  });

  it("requires EVERY source to be complete, not just one", () => {
    const rootComplete = ROOT;
    const midIncomplete = MID;
    expect(
      seedingSourceReady([rootComplete, midIncomplete], KO, {
        sources: [{ stage: { stageId: "root" }, take: [] }, { stage: { stageId: "mid" }, take: [] }],
      }),
    ).toBe(false);
  });
});

// W4 B6a fix round 1 (review #1): the Confirm warning promises "you can recompute it" only where a confirmed draw CAN be
// reopened. The server's one gate is scoring.ts: a correction inside a COMPLETED stage of kind "knockout" calls
// markDependentSeedProposalsStale({ includeConfirmed: true }); a table source's correction does not (stages.ts
// computeSeedProposal refuses a confirmed stage with SEEDING_ALREADY_CONFIRMED for good). Expected values are that gate's
// verdict per stage kind, typed here - never read back from the predicate.
describe("confirmedDrawReopens - may the Confirm warning promise a recompute?", () => {
  const stage = (id: string, seq: number, kind: string): SeedingKindStage => ({
    id,
    division_id: "div-1",
    seq,
    status: "complete",
    kind,
  });
  const TARGET = stage("target", 9, "knockout");
  const src = (stageId: string) => ({ stage: { stageId }, take: [] });

  it("the empty case first: a progression naming NO source promises nothing (an empty list is not 'every source is a knockout')", () => {
    expect(confirmedDrawReopens([stage("a", 1, "knockout"), TARGET], TARGET, { sources: [] })).toBe(false);
  });

  it("a knockout source reopens a confirmed draw; a table source never does (every table kind the server refuses for good)", () => {
    const cases: [string, boolean][] = [
      ["knockout", true],
      ["group", false],
      ["league", false],
      ["swiss", false],
      ["round_robin", false],
      ["double_elim", false],
      ["stepladder", false],
      ["page_playoff", false],
    ];
    let checked = 0;
    for (const [kind, want] of cases) {
      const s = stage("a", 1, kind);
      expect(confirmedDrawReopens([s, TARGET], TARGET, { sources: [src("a")] }), `${kind} source`).toBe(want);
      checked++;
    }
    expect(checked, "anti-vacuity: every kind checked").toBe(8);
  });

  it("'previous' resolves to the stage just before the target, and that stage's kind decides", () => {
    const ko = stage("ko", 1, "knockout");
    const grp = stage("grp", 2, "group");
    expect(confirmedDrawReopens([ko, TARGET], TARGET, { sources: [{ stage: "previous", take: [] }] })).toBe(true);
    expect(confirmedDrawReopens([ko, grp, TARGET], TARGET, { sources: [{ stage: "previous", take: [] }] })).toBe(false);
  });

  it("EVERY source must be a knockout: one table source among them withholds the promise", () => {
    const ko = stage("ko", 1, "knockout");
    const grp = stage("grp", 2, "group");
    expect(confirmedDrawReopens([ko, grp, TARGET], TARGET, { sources: [src("ko"), src("ko")] })).toBe(true);
    expect(confirmedDrawReopens([ko, grp, TARGET], TARGET, { sources: [src("ko"), src("grp")] })).toBe(false);
    expect(confirmedDrawReopens([ko, grp, TARGET], TARGET, { sources: [src("grp"), src("ko")] })).toBe(false);
  });

  it("a source that resolves to no stage (unknown, later, another division) promises nothing", () => {
    const ko = stage("ko", 1, "knockout");
    expect(confirmedDrawReopens([ko, TARGET], TARGET, { sources: [src("nope")] })).toBe(false);
    expect(confirmedDrawReopens([ko, TARGET], TARGET, { sources: [src("ko"), src("nope")] })).toBe(false);
    expect(confirmedDrawReopens([{ ...ko, division_id: "div-2" }, TARGET], TARGET, { sources: [src("ko")] })).toBe(false);
  });
});
