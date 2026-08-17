// Task 11 fix batch (deferred from Task 9's review): recording-chip.tsx
// computed `current.locked` but never read it in render. buildRecording's
// pure output is already fully covered by recording.test.ts — this file
// covers the RENDERER's own defensive branch, which no other test reaches
// (apps/web vitest is environment:"node", so RecordingChip's JSX has no
// coverage anywhere else — see component_ui_i18n.md's renderToStaticMarkup
// convention, used the same way here: render the stateful container once
// to pin what it chose for its initial/collapsed state, no interaction
// needed).
//
// R2/A2 (2026-08-16): RecordingChipProps gained `fidelityEntitlements`
// (verbatim `PadSpec["fidelityEntitlements"]`, the same prop
// fidelity-switcher.tsx's FidelitySwitcher already takes) so buildRecording
// can name the REAL plan a locked band needs instead of a hardcoded "pro" —
// recording.test.ts covers buildRecording's own resolution; this file's own
// new job is extracting the right per-band feature key and threading it
// through TWO separate buildRecording calls (current + next), which the
// two new describe blocks below each pin with a DIFFERENT feature key so a
// mutant that swaps which band's key feeds which call is actually caught.
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RecordingChip } from "../recording-chip";
import { propsOf, renderIsland, walk } from "@/components/__tests__/_hook-harness";
import type { MsgFn } from "../ribbon";
import type { FidelityBand, PadSpec } from "@seazn/engine/sport";

// Same discriminating oracle shape as recording.test.ts, so the assertion
// depends on the ACTUAL vars padLabel/buildRecording hands back, not a
// constant string a broken branch could coincidentally also produce.
const t: MsgFn = (key, vars) =>
  key === "pad.recording.locked" ? `${vars!.band} — available on ${vars!.plan}` : key;

const CRICKET_FIDELITY_ENTITLEMENTS: PadSpec["fidelityEntitlements"] = {
  2: "stats.player",
  3: "scoring.ball_by_ball",
};

describe("RecordingChip — defensive branch when the ACTIVE band itself is unentitled", () => {
  it("renders the collapsed pill with no lock treatment for the normal (entitled-active-band) case", () => {
    const html = renderToStaticMarkup(
      <RecordingChip
        activeBand={1 as FidelityBand}
        entitledBands={new Set<FidelityBand>([0, 1, 2])}
        fidelityEntitlements={CRICKET_FIDELITY_ENTITLEMENTS}
        t={t}
      />,
    );
    expect(html).toContain("bg-violet-600");
    expect(html).not.toContain("bg-amber-500");
    expect(html).not.toContain("available on");
  });

  it("words the lock even when the invariant is violated (active band not in entitledBands)", () => {
    // buildRecording's own doc says this should never happen ("an org
    // cannot be actively using a band it does not hold") — this is
    // exactly the state that invariant rules out, exercised anyway to
    // prove the render does not go silent if it ever does. Band 1 has no
    // entry in fidelityEntitlements (bands 0/1 are never keyed — same as
    // cricket's real module), which exercises RecordingChip's own `?? ""`
    // call-site fallback down to buildRecording's "" -> featurePlan("")
    // -> "pro" path.
    const html = renderToStaticMarkup(
      <RecordingChip
        activeBand={1 as FidelityBand}
        entitledBands={new Set<FidelityBand>([0])}
        fidelityEntitlements={CRICKET_FIDELITY_ENTITLEMENTS}
        t={t}
      />,
    );
    expect(html).toContain("bg-amber-500");
    expect(html).not.toContain("bg-violet-600");
    expect(html).toContain("pad.recording.band.1 — available on Pro");
  });

  it("names Pro Plus for the CURRENT band (defensive branch) when ITS OWN feature key is Pro-Plus-only", () => {
    // activeBand=2 is deliberately absent from entitledBands, forcing the
    // same invariant-violated shape as the test above, but band 2's own
    // gate here is "officials.auto" (feature-copy.ts PLUS_FEATURES) while
    // band 3's is the ordinary "stats.player" — the two keys are swapped
    // relative to the "next band" test below, so a mutant that reads
    // fidelityEntitlements[nextBand] for the CURRENT call (or vice versa)
    // produces the WRONG plan word here and is caught.
    const html = renderToStaticMarkup(
      <RecordingChip
        activeBand={2 as FidelityBand}
        entitledBands={new Set<FidelityBand>([0, 1])}
        fidelityEntitlements={{ 2: "officials.auto", 3: "stats.player" }}
        t={t}
      />,
    );
    expect(html).toContain("pad.recording.band.2 — available on Pro Plus");
  });
});

function buttonsOf(tree: ReturnType<typeof walk>) {
  return tree.filter((el) => el.type === "button");
}

/** Same cast-and-invoke idiom every other `_hook-harness` suite in this
 *  repo uses (e.g. context-swap.test.ts) — `propsOf()` types every prop as
 *  `unknown`, which has no call signature for a bare `?.()` under tsc. */
function click(el: ReturnType<typeof buttonsOf>[number]): void {
  (propsOf(el).onClick as () => void)();
}

describe("RecordingChip — tapping the disclosure reveals the NEXT band's OWN threaded-through plan", () => {
  it("names Pro Plus for the next tier when ITS feature key is Pro-Plus-only, never a flat 'Pro'", () => {
    const island = renderIsland(RecordingChip, {
      activeBand: 2 as FidelityBand,
      entitledBands: new Set<FidelityBand>([0, 1, 2]),
      // band 2 (current, entitled — never renders an upsell) intentionally
      // carries the ORDINARY "stats.player" key while band 3 (next,
      // locked) carries the Plus-only one, mirroring the previous
      // describe block's swap-detection setup from the other side.
      fidelityEntitlements: { 2: "stats.player", 3: "officials.auto" },
      t,
    });
    expect(island.text()).not.toContain("available on");

    const [chipButton] = buttonsOf(island.tree());
    click(chipButton!);

    expect(island.text()).toContain("pad.recording.band.3 — available on Pro Plus");
  });
});
