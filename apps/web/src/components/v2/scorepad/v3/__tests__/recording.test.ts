// Task 9 (R1 chassis): the Recording Chip's pure wording builder.
// apps/web vitest is environment:"node" (no jsdom) — same split as
// ribbon.test.ts/tiles.test.ts/dock.test.ts in this wave — so
// buildRecording, never RecordingChip's own JSX, carries this file's
// tests. See task-9-brief.md + pins.md §5 (fidelity-switcher.tsx's
// active band / entitlements arrive as plain PROPS, not a hook — this
// function takes the equivalent, already-resolved values as plain
// parameters, same posture as ribbon.ts's buildRibbon).
//
// The defect this whole task exists to kill: "a locked level must
// always be WORDED, never a silent lock icon" — every locked-branch
// assertion below therefore pins the ACTUAL SENTENCE buildRecording
// hands back (via a discriminating `t` oracle — ribbon.test.ts's own
// "the oracle MUST discriminate by its input" lesson: it echoes the
// raw key back as the label, so a branch bug that resolves the wrong
// key cannot coincidentally read as green), not just a `locked: true`
// boolean a bare-padlock implementation could satisfy too.
// R2/A2 (2026-08-16): buildRecording's 4th parameter used not to exist — the
// upsell always named a hardcoded "pro" (`planLabel("pro")` baked into the
// builder, safe only because the chip had zero callers). Cricket's real
// module now declares `fidelityEntitlements: {2: "stats.player", 3:
// "scoring.ball_by_ball"}` (packages/engine/src/sports/cricket/cricket.ts) —
// the R1-era "no module populates this yet" premise is stale — and the
// literal was wrong on its face regardless: `@/lib/feature-copy`'s
// `PLUS_FEATURES` lists several Pro-Plus-only keys, so a fixed "pro" would
// tell an org already on Pro Plus "available on Pro" for any band gated
// behind one of those. `requiredFeature` (the caller's own
// `fidelityEntitlements[fidelity]` lookup — see recording-chip.tsx's doc)
// replaces the literal; buildRecording derives the plan via `featurePlan()`,
// the SAME cheapest-plan-per-key table `<UpgradeGate>` already uses — never
// a second, parallel mapping invented here.
import { describe, it, expect } from "vitest";
import { buildRecording } from "../recording-chip";
import type { MsgFn } from "../ribbon";
import type { FidelityBand } from "@seazn/engine/sport";

const t: MsgFn = (key, vars) =>
  key === "pad.recording.locked" ? `${vars!.band} — available on ${vars!.plan}` : key;

describe("buildRecording", () => {
  it("returns unlocked for a band the org is entitled to", () => {
    const entitled = new Set<FidelityBand>([0, 1, 2]);
    expect(buildRecording(2, 2, entitled, "stats.player", t)).toEqual({
      label: "pad.recording.band.2",
      locked: false,
    });
  });

  it("returns a WORDED lock for activeBand+1 when it is not entitled, naming the plan its OWN feature key actually requires", () => {
    const entitled = new Set<FidelityBand>([0, 1, 2]);
    // cricket's real band-3 gate — "scoring.ball_by_ball" resolves to "pro"
    // via featurePlan() (not in feature-copy.ts's PLUS_FEATURES set).
    expect(buildRecording(3, 2, entitled, "scoring.ball_by_ball", t)).toEqual({
      label: "pad.recording.band.3",
      locked: true,
      upsell: "pad.recording.band.3 — available on Pro",
    });
  });

  it("words the lock for ANY unentitled band, not only activeBand+1 (generalises the same formula)", () => {
    const entitled = new Set<FidelityBand>([0]);
    expect(buildRecording(2, 0, entitled, "stats.player", t)).toEqual({
      label: "pad.recording.band.2",
      locked: true,
      upsell: "pad.recording.band.2 — available on Pro",
    });
  });

  it("names Pro Plus, never Pro, when the locked band's OWN feature key is Pro-Plus-only — the exact defect the R1 \"pro\" literal shipped", () => {
    const entitled = new Set<FidelityBand>([0, 1, 2]);
    // "officials.auto" is one of feature-copy.ts's PLUS_FEATURES. An org
    // already ON Pro Plus and still missing this entitlement must never be
    // told "available on Pro" — they already hold more than that and it
    // still would not unlock it.
    const result = buildRecording(3, 2, entitled, "officials.auto", t);
    expect(result.upsell).toBe("pad.recording.band.3 — available on Pro Plus");
    expect(result.upsell).not.toBe("pad.recording.band.3 — available on Pro");
  });

  it("resolves an unrecognised/absent feature key to Pro — featurePlan's own documented fallback, not a value this builder invents", () => {
    const entitled = new Set<FidelityBand>([0]);
    expect(buildRecording(1, 0, entitled, "", t)).toEqual({
      label: "pad.recording.band.1",
      locked: true,
      upsell: "pad.recording.band.1 — available on Pro",
    });
  });

  it("throws for a fidelity band outside the closed 0-3 scale", () => {
    const entitled = new Set<FidelityBand>([0, 1, 2, 3]);
    expect(() => buildRecording(4 as unknown as FidelityBand, 3, entitled, "stats.player", t)).toThrow();
  });

  it("throws for an activeBand outside the closed 0-3 scale", () => {
    const entitled = new Set<FidelityBand>([0, 1, 2, 3]);
    expect(() => buildRecording(1, 4 as unknown as FidelityBand, entitled, "stats.player", t)).toThrow();
  });
});
