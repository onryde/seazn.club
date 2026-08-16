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
import { describe, it, expect } from "vitest";
import { buildRecording } from "../recording-chip";
import type { MsgFn } from "../ribbon";
import type { FidelityBand } from "@seazn/engine/sport";

const t: MsgFn = (key, vars) =>
  key === "pad.recording.locked" ? `${vars!.band} — available on ${vars!.plan}` : key;

describe("buildRecording", () => {
  it("returns unlocked for a band the org is entitled to", () => {
    const entitled = new Set<FidelityBand>([0, 1, 2]);
    expect(buildRecording(2, 2, entitled, t)).toEqual({
      label: "pad.recording.band.2",
      locked: false,
    });
  });

  it("returns a WORDED lock for activeBand+1 when it is not entitled", () => {
    const entitled = new Set<FidelityBand>([0, 1, 2]);
    expect(buildRecording(3, 2, entitled, t)).toEqual({
      label: "pad.recording.band.3",
      locked: true,
      upsell: "pad.recording.band.3 — available on Pro",
    });
  });

  it("words the lock for ANY unentitled band, not only activeBand+1 (generalises the same formula)", () => {
    const entitled = new Set<FidelityBand>([0]);
    expect(buildRecording(2, 0, entitled, t)).toEqual({
      label: "pad.recording.band.2",
      locked: true,
      upsell: "pad.recording.band.2 — available on Pro",
    });
  });

  it("throws for a fidelity band outside the closed 0-3 scale", () => {
    const entitled = new Set<FidelityBand>([0, 1, 2, 3]);
    expect(() => buildRecording(4 as unknown as FidelityBand, 3, entitled, t)).toThrow();
  });

  it("throws for an activeBand outside the closed 0-3 scale", () => {
    const entitled = new Set<FidelityBand>([0, 1, 2, 3]);
    expect(() => buildRecording(1, 4 as unknown as FidelityBand, entitled, t)).toThrow();
  });
});
