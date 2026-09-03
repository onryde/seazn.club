// W1 / Task 4 (entitlements v18) — the Recording Chip is a PICKER now.
//
// Tasks 1-3 deleted the `fidelityTiers` paywall model outright: a fidelity
// band is a UX filter the scorer chooses, never a price boundary. Everything
// this file used to cover — `buildRecording`'s entitled/locked split, the
// `{band} — available on {plan}` sentence, the two `featurePlan()` lookups —
// describes a model that no longer exists. What replaces it is the owner-
// approved Option B (`docs/superpowers/specs/mockups/2026-09-02-entitlements
// -v18/chip-option-b.html`): a 44px pill (meter + "Recording" + the active
// band + chevron) raising a bottom sheet of four full-width rows.
//
// apps/web vitest is `environment: "node"` — there is no DOM — so this file
// drives the component through `_hook-harness`'s `renderIsland`, which runs
// the real `useState`/`useEffect`/`useCallback` and lets a handler be invoked
// the way a thumb would. Real tap area, CSS cascade and focus are NOT
// provable here and are proven by `e2e/scoring-free.spec.ts` instead.
import { describe, it, expect } from "vitest";
import { RecordingChip, type RecordingChipProps } from "../recording-chip";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import type { FidelityBand } from "@seazn/engine/sport";
import type { MsgFn } from "../ribbon";
import type { ReactElement } from "react";

// A DISCRIMINATING oracle: every lookup returns its own key (and vars), so an
// assertion depends on the key the component actually asked for rather than
// on a constant a wrong branch could also produce.
const t: MsgFn = (key, vars) => (vars ? `${key}(${JSON.stringify(vars)})` : String(key));
const plural = (key: string, count: number) => `${key}#${count}`;

// Deliberately all different, so an assertion on the caption cannot pass by
// reading the wrong band's number.
const COUNTS: Readonly<Record<FidelityBand, number>> = { 0: 4, 1: 8, 2: 14, 3: 20 };

function mount(over: Partial<RecordingChipProps> = {}) {
  const picks: FidelityBand[] = [];
  const island = renderIsland<RecordingChipProps>(RecordingChip, {
    activeBand: 3,
    onBandChange: (b) => picks.push(b),
    actionCounts: COUNTS,
    t,
    plural,
    ...over,
  });
  const chip = () => island.tree().find((el) => propsOf(el)["data-role"] === "v3-recording-chip")!;
  const rows = () => island.tree().filter((el) => propsOf(el)["data-band"] !== undefined);
  const open = () => (propsOf(chip()).onClick as () => void)();
  const click = (el: ReactElement) => (propsOf(el).onClick as () => void)();
  return { island, picks, chip, rows, open, click };
}

describe("RecordingChip — collapsed", () => {
  it("is a disclosure for a dialog, closed, naming the active band in words", () => {
    const { chip, island } = mount({ activeBand: 2 });
    expect(propsOf(chip())["aria-haspopup"]).toBe("dialog");
    expect(propsOf(chip())["aria-expanded"]).toBe(false);
    // The lead word the owner approved, and the ACTIVE band's own label —
    // band 2, not the 3 a hardcoded default would produce.
    expect(textOf(island.tree()[0]!)).toContain("pad.recording.lead");
    expect(textOf(island.tree()[0]!)).toContain("pad.recording.band.2");
    expect(textOf(island.tree()[0]!)).not.toContain("pad.recording.band.3");
  });

  it("captions the pad's action count for the ACTIVE band, not for the top one", () => {
    const { island } = mount({ activeBand: 1 });
    // 8 is band 1's count; 20 is band 3's. A component that indexes a
    // constant band reads 20 here and this reds.
    expect(textOf(island.tree()[0]!)).toContain("pad.recording.actions#8");
    expect(textOf(island.tree()[0]!)).not.toContain("pad.recording.actions#20");
  });

  it("draws the meter as a LADDER — one rung filled per band reached, fill not hue", () => {
    for (const band of [0, 1, 2, 3] as const) {
      const { island } = mount({ activeBand: band });
      const rungs = island.tree().filter((el) => propsOf(el)["data-rung"] !== undefined);
      expect(rungs, `band ${band} must draw four rungs`).toHaveLength(4);
      const filled = rungs.filter((el) => propsOf(el)["data-filled"] === true);
      expect(filled.map((el) => propsOf(el)["data-rung"])).toEqual(
        [0, 1, 2, 3].slice(0, band + 1),
      );
    }
  });

  it("shows no sheet until it is opened", () => {
    const { rows } = mount();
    expect(rows()).toHaveLength(0);
  });
});

describe("RecordingChip — the sheet", () => {
  it("opens a radiogroup of all four bands and marks the active one", () => {
    const { open, rows, chip } = mount({ activeBand: 2 });
    open();
    expect(propsOf(chip())["aria-expanded"]).toBe(true);
    expect(rows().map((el) => propsOf(el)["data-band"])).toEqual([0, 1, 2, 3]);
    expect(rows().map((el) => propsOf(el).role)).toEqual(["radio", "radio", "radio", "radio"]);
    expect(rows().map((el) => propsOf(el)["aria-checked"])).toEqual([false, false, true, false]);
  });

  it("gives every row its OWN band label and action count — never the active band's", () => {
    const { open, rows } = mount({ activeBand: 3 });
    open();
    for (const row of rows()) {
      const band = propsOf(row)["data-band"] as FidelityBand;
      expect(textOf(row)).toContain(`pad.recording.band.${band}`);
      expect(textOf(row)).toContain(`pad.recording.actions#${COUNTS[band]}`);
    }
  });

  it("reports the pick and closes — one tap changes what the pad shows", () => {
    const { open, rows, picks, chip } = mount({ activeBand: 3 });
    open();
    (propsOf(rows()[1]!).onClick as () => void)();
    expect(picks).toEqual([1]);
    expect(propsOf(chip())["aria-expanded"]).toBe(false);
  });

  it("dismisses without a pick when the scrim is tapped", () => {
    const { open, picks, chip, island } = mount();
    open();
    const scrim = island.tree().find((el) => propsOf(el)["data-role"] === "v3-recording-scrim")!;
    (propsOf(scrim).onClick as () => void)();
    expect(picks).toEqual([]);
    expect(propsOf(chip())["aria-expanded"]).toBe(false);
  });
});

describe("RecordingChip — nothing here is for sale", () => {
  it("never renders a lock, an upsell or a plan name, open or closed, at any band", () => {
    for (const band of [0, 1, 2, 3] as const) {
      const { island, open } = mount({ activeBand: band });
      open();
      const text = island.tree().map((el) => textOf(el)).join(" ");
      expect(text, `band ${band}`).not.toMatch(/available on|locked|upsell|🔒|Pro|Plus/i);
    }
  });

  it("asks for no dictionary key that ever named a plan", () => {
    const asked: string[] = [];
    const spy: MsgFn = (key, vars) => {
      asked.push(String(key));
      return t(key, vars);
    };
    const { open } = mount({ t: spy });
    open();
    expect(asked).not.toContain("pad.recording.locked");
    expect(asked.every((k) => k.startsWith("pad.recording."))).toBe(true);
  });
});
