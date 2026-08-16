// Task 11 fix batch (deferred from Task 9's review): recording-chip.tsx
// computed `current.locked` but never read it in render. buildRecording's
// pure output is already fully covered by recording.test.ts — this file
// covers the RENDERER's own defensive branch, which no other test reaches
// (apps/web vitest is environment:"node", so RecordingChip's JSX has no
// coverage anywhere else — see component_ui_i18n.md's renderToStaticMarkup
// convention, used the same way here: render the stateful container once
// to pin what it chose for its initial/collapsed state, no interaction
// needed).
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RecordingChip } from "../recording-chip";
import type { MsgFn } from "../ribbon";
import type { FidelityBand } from "@seazn/engine/sport";

// Same discriminating oracle shape as recording.test.ts, so the assertion
// depends on the ACTUAL vars padLabel/buildRecording hands back, not a
// constant string a broken branch could coincidentally also produce.
const t: MsgFn = (key, vars) =>
  key === "pad.recording.locked" ? `${vars!.band} — available on ${vars!.plan}` : key;

describe("RecordingChip — defensive branch when the ACTIVE band itself is unentitled", () => {
  it("renders the collapsed pill with no lock treatment for the normal (entitled-active-band) case", () => {
    const html = renderToStaticMarkup(
      <RecordingChip activeBand={1 as FidelityBand} entitledBands={new Set<FidelityBand>([0, 1, 2])} t={t} />,
    );
    expect(html).toContain("bg-violet-600");
    expect(html).not.toContain("bg-amber-500");
    expect(html).not.toContain("available on");
  });

  it("words the lock even when the invariant is violated (active band not in entitledBands)", () => {
    // buildRecording's own doc says this should never happen ("an org
    // cannot be actively using a band it does not hold") — this is
    // exactly the state that invariant rules out, exercised anyway to
    // prove the render does not go silent if it ever does.
    const html = renderToStaticMarkup(
      <RecordingChip activeBand={1 as FidelityBand} entitledBands={new Set<FidelityBand>([0])} t={t} />,
    );
    expect(html).toContain("bg-amber-500");
    expect(html).not.toContain("bg-violet-600");
    expect(html).toContain("pad.recording.band.1 — available on Pro");
  });
});
