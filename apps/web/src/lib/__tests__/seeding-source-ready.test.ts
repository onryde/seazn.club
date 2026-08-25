// Pure parity tests against resolveProgressionSource's own semantics
// (server/usecases/stage-seeding.ts:73-111) — see seeding-source-ready.ts's
// docstring for the field-for-field mapping. No RSC render, no mocks: this
// is what the division page's `seedingSourcesReady` derivation actually
// runs, in isolation.
import { describe, expect, it } from "vitest";
import { resolveSeedingSourceStage, seedingSourceReady, type SeedingSourceStage } from "../seeding-source-ready";

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
