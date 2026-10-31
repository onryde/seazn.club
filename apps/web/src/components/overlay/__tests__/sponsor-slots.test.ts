// R4 sponsors on stream, S7 — the sponsor slots every scorebug template declares (spec 2026-10-27 §3.5:
// "`OverlayTemplateDef.sponsorSlots: { lower_third; banner }`, both clear of the scorebug; `bar` and `bug` declare both
// ... A test asserts every slot box is disjoint from its template's scorebug box, for every registry entry").
//
// Where the expected values come from — never from the slot numbers under test:
//   - the canvas: 1920 × 1080 (overlay templates spec 2026-10-15 §4.1, "authored at a fixed 1920×1080 canvas");
//   - the floor lift: 150 px (spec 2026-10-15 §4.5, D9 "bar bottom ≥ 150 px"; spec 2026-10-27 §3.5 extends it to
//     sponsor cards);
//   - the clearance and the card minimum: `CARD_CLEARANCE_PX`, `CARD_MIN_W`, `CARD_MIN_H` (the registry's declared
//     card rules, which every card on the canvas already keeps);
//   - the two slot names: `SponsorStyle` (spec §3.2: minor → lower third, major → banner).
import { describe, expect, it } from "vitest";
import { SPONSOR_STYLE_BY_SIZE, type SponsorStyle } from "@/lib/sponsor-plan";
import {
  CARD_CLEARANCE_PX,
  CARD_MIN_H,
  CARD_MIN_W,
  OVERLAY_TEMPLATES,
  cardRegionBeside,
  cardRegionFor,
  type CanvasBox,
  type OverlayTemplateDef,
} from "../template-registry";

const CANVAS_W = 1920;
const CANVAS_H = 1080;
const FLOOR_LIFT_PX = 150;
/** Spec §3.2's two looks, read off the planner's own declaration (every size names one). */
const STYLES: readonly SponsorStyle[] = [...new Set(Object.values(SPONSOR_STYLE_BY_SIZE).map((s) => s.style))];

const ENTRIES = Object.values(OVERLAY_TEMPLATES) as OverlayTemplateDef[];

/** True when the two boxes are at least `gap` apart on some axis (touching counts as apart at gap 0). */
const apart = (a: CanvasBox, b: CanvasBox, gap = 0): boolean =>
  a.x + a.width + gap <= b.x || b.x + b.width + gap <= a.x || a.y + a.height + gap <= b.y || b.y + b.height + gap <= a.y;
const inside = (b: CanvasBox, area: CanvasBox): boolean =>
  b.x >= area.x && b.y >= area.y && b.x + b.width <= area.x + area.width && b.y + b.height <= area.y + area.height;
const fmt = (b: CanvasBox | null) => (b === null ? "none" : `{${b.x},${b.y},${b.width}×${b.height}}`);

describe("sponsorSlots — every registry entry", () => {
  it("premise: the spec's two looks, lower third and banner", () => {
    expect([...STYLES].sort()).toEqual(["banner", "lower_third"]);
    expect(ENTRIES.length, "anti-vacuity: the registry has entries").toBeGreaterThan(0);
  });

  it("every registry entry declares both slots, each disjoint from its sceneCardSafeArea (count reported, 0 ⇒ fail)", () => {
    let checked = 0;
    const meeting: string[] = [];
    for (const def of ENTRIES) {
      expect(Object.keys(def.sponsorSlots).sort(), `${def.id}: exactly the spec's two slots`).toEqual([...STYLES].sort());
      for (const style of STYLES) {
        const slot = def.sponsorSlots[style];
        checked++;
        // Clear by the gap every card keeps from the template's box, not merely not overlapping it.
        if (!apart(slot, def.sceneCardSafeArea, CARD_CLEARANCE_PX)) {
          meeting.push(`${def.id}.${style} ${fmt(slot)} within ${CARD_CLEARANCE_PX}px of ${fmt(def.sceneCardSafeArea)}`);
        }
      }
    }
    console.log(`slots checked against their scorebug box: ${checked}`);
    expect(checked, "anti-vacuity").toBe(ENTRIES.length * STYLES.length);
    expect(checked).toBeGreaterThan(0);
    expect(meeting).toEqual([]);
  });

  it("every slot box lies inside the 1920×1080 canvas, its bottom at least 150 px off the floor", () => {
    const canvas: CanvasBox = { x: 0, y: 0, width: CANVAS_W, height: CANVAS_H };
    let checked = 0;
    const off: string[] = [];
    for (const def of ENTRIES) {
      for (const style of STYLES) {
        const slot = def.sponsorSlots[style];
        checked++;
        if (!inside(slot, canvas)) off.push(`${def.id}.${style} ${fmt(slot)} leaves the canvas`);
        if (CANVAS_H - (slot.y + slot.height) < FLOOR_LIFT_PX) off.push(`${def.id}.${style} ${fmt(slot)} sits under the floor lift`);
        if (!(slot.width > 0 && slot.height > 0)) off.push(`${def.id}.${style} ${fmt(slot)} is empty`);
      }
    }
    console.log(`slots checked against the canvas and the floor lift: ${checked}`);
    expect(checked, "anti-vacuity").toBeGreaterThan(0);
    expect(off).toEqual([]);
  });

  it("a banner is the bigger look: on every entry its slot covers more canvas than the lower third's (spec §3.2: major)", () => {
    let checked = 0;
    for (const def of ENTRIES) {
      const area = (b: CanvasBox) => b.width * b.height;
      expect(area(def.sponsorSlots.banner), def.id).toBeGreaterThan(area(def.sponsorSlots.lower_third));
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(ENTRIES.length);
  });

  it("the scene carousel's banner leaves the match card a region: clear of the slot, and at least CARD_MIN (count reported)", () => {
    let checked = 0;
    const bad: string[] = [];
    for (const def of ENTRIES) {
      const region = cardRegionFor(def.sceneCardSafeArea);
      expect(region, `${def.id}: premise, the template has a card region`).not.toBeNull();
      const beside = cardRegionBeside(region!, def.sponsorSlots.banner);
      checked++;
      if (beside === null) {
        bad.push(`${def.id}: no region beside the banner ${fmt(def.sponsorSlots.banner)}`);
        continue;
      }
      if (!apart(beside, def.sponsorSlots.banner, CARD_CLEARANCE_PX)) bad.push(`${def.id}: ${fmt(beside)} meets the banner`);
      if (!inside(beside, region!)) bad.push(`${def.id}: ${fmt(beside)} leaves its region ${fmt(region)}`);
      if (beside.width < CARD_MIN_W || beside.height < CARD_MIN_H) bad.push(`${def.id}: ${fmt(beside)} under CARD_MIN`);
    }
    console.log(`carousel regions checked: ${checked}`);
    expect(checked, "anti-vacuity").toBe(ENTRIES.length);
    expect(bad).toEqual([]);
  });
});

describe("cardRegionBeside — the card region, trimmed clear of a slot", () => {
  // Rule (its doc): the largest by area of the four strips of `region` beside `slot` (left, above, right, below — ties in
  // that order), each kept CARD_CLEARANCE_PX clear of it; a slot already clear of the region leaves it untouched; null
  // when no strip is at least CARD_MIN_W × CARD_MIN_H. The expected boxes below are worked by hand from that rule.
  const REGION: CanvasBox = { x: 100, y: 100, width: 1600, height: 800 };

  it("the empty case: a slot clear of the region (by the clearance) returns the region itself", () => {
    const clear: CanvasBox = { x: REGION.x + REGION.width + CARD_CLEARANCE_PX, y: 100, width: 50, height: 50 };
    expect(cardRegionBeside(REGION, clear)).toEqual(REGION);
    const below: CanvasBox = { x: 100, y: REGION.y + REGION.height + CARD_CLEARANCE_PX, width: 50, height: 50 };
    expect(cardRegionBeside(REGION, below)).toEqual(REGION);
  });

  it("a slot inside the clearance (but outside the region) still trims it", () => {
    const near: CanvasBox = { x: REGION.x + REGION.width + CARD_CLEARANCE_PX - 1, y: 100, width: 50, height: 800 };
    const got = cardRegionBeside(REGION, near);
    expect(got).toEqual({ x: 100, y: 100, width: near.x - CARD_CLEARANCE_PX - 100, height: 800 });
  });

  it("a slot at the right: the left strip, CARD_CLEARANCE_PX short of the slot", () => {
    const slot: CanvasBox = { x: 1300, y: 300, width: 300, height: 200 };
    // left: x 100..1276 (1176 × 800); above: y 100..276 (176 tall, under CARD_MIN_H); right: 1624..1700 (76 wide);
    // below: y 524..900 (1600 × 376 = 601 600 < 940 800). Left wins.
    expect(cardRegionBeside(REGION, slot)).toEqual({ x: 100, y: 100, width: 1300 - CARD_CLEARANCE_PX - 100, height: 800 });
  });

  it("a slot along the bottom: the strip above it", () => {
    const slot: CanvasBox = { x: 100, y: 700, width: 1600, height: 200 };
    expect(cardRegionBeside(REGION, slot)).toEqual({ x: 100, y: 100, width: 1600, height: 700 - CARD_CLEARANCE_PX - 100 });
  });

  it("a slot covering the region leaves no card region at all", () => {
    expect(cardRegionBeside(REGION, { x: 0, y: 0, width: 1920, height: 1080 })).toBeNull();
  });

  it("strips under CARD_MIN are not regions, however much is left", () => {
    // A slot in the middle that leaves four strips each narrower than CARD_MIN_W or shorter than CARD_MIN_H.
    const small: CanvasBox = { x: 0, y: 0, width: 1000, height: 600 };
    const slot: CanvasBox = { x: 300, y: 200, width: 400, height: 200 };
    expect(cardRegionBeside(small, slot)).toBeNull();
  });
});
