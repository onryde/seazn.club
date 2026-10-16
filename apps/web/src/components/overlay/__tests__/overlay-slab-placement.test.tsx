// The moment slot's PLACEMENT against §3's bar (stream overlay W2, final
// review finding 1).
//
// §5 pins the slab's underside to the bar's TOP edge (owner-ruled 2026-09-11,
// "above the bar, tucked behind"). §3 says "an empty detail band is not
// rendered", so that top edge is at 126 px OR 177 px above the bar's own
// bottom inset — and the stylesheet had frozen their SUM at 231. A football
// fixture scoring before its first card, and a cricket fixture before its
// first ball, aired the slab floating 51 px clear of the bar with its
// deliberately-square bottom corners exposed.
//
// The fix is one authority (`hasDetailBand`) read by both the bar's own render
// and the slot's placement attribute. THIS FILE ASSERTS THEY AGREE IN THE SAME
// RENDER, which is the only property that actually holds the geometry: either
// reader can be right alone and still disagree with the other.
//
// `environment: "node"`, no jsdom — `renderToStaticMarkup` is this directory's
// precedent for a real, non-mocked render (see overlay-stage-delay.test.tsx).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { OverlayStage, type OverlayStageProps } from "../overlay-stage";
import { hasDetailBand, overlayModel } from "@/lib/overlay-model";
import { decidedOutcomeTemplates } from "@/lib/scoring-vocab";
import type { OverlayLiveData } from "@/components/public-site/live-score-data";
import type { OverlayMoment } from "@/lib/overlay-moments";
import { OVERLAY_TEMPLATES, cardRegionFor, type TemplateId } from "../template-registry";
import { declaredValue, parseCss, readGlobalsCss } from "@/components/v2/scorepad/v3/__tests__/_globals-css";

const HERE = dirname(fileURLToPath(import.meta.url));
const DICT: Record<string, string> = JSON.parse(
  readFileSync(join(HERE, "../../../dictionaries/en/public.json"), "utf8"),
);

const SIDES: OverlayStageProps["sides"] = [
  { id: "home", name: "Milton Keynes Rovers" },
  { id: "away", name: "Northbridge Athletic" },
];

/** A live football fixture. `discipline` present ⇒ §3's detail band renders. */
function live(discipline: { side: string; classKey: string }[]): OverlayLiveData {
  return {
    status: "in_play",
    summary: {
      perSide: [
        { entrantId: "home", line: "1" },
        { entrantId: "away", line: "0" },
      ],
      ...(discipline.length > 0 ? { detail: { discipline } } : {}),
    },
    outcome: null,
    lastSeq: 4,
    venueTz: "UTC",
  } as OverlayLiveData;
}

const props = (data: OverlayLiveData): OverlayStageProps => ({
  fixtureId: "f1",
  initial: data,
  realtime: false,
  sportKey: "football",
  style: "bar",
  sides: SIDES,
  startLabel: null,
  dict: DICT,
  decidedTemplates: decidedOutcomeTemplates((k) => k),
});

/** Anchored on `="` — React serialises an omitted prop as `"$undefined"`, so a
 *  bare `data-band` probe would pass in BOTH states (AGENTS.md). */
const slotHasBand = (html: string): boolean => /data-testid="ovl-moment-slot"[^>]*data-band="/.test(html);
const barHasBand = (html: string): boolean => html.includes('data-testid="ovl-detail"');

describe("the moment slot follows the bar's real height", () => {
  it("no card yet: the bar renders NO detail band, and the slot is not flagged", () => {
    const html = renderToStaticMarkup(<OverlayStage {...props(live([]))} />);
    expect(barHasBand(html), "premise — a clean football fixture has no band").toBe(false);
    expect(slotHasBand(html)).toBe(false);
  });

  it("a card: the bar renders the band, and the slot IS flagged", () => {
    const html = renderToStaticMarkup(
      <OverlayStage {...props(live([{ side: "home", classKey: "yellow" }]))} />,
    );
    expect(barHasBand(html), "premise — a card puts a chip in the band").toBe(true);
    expect(slotHasBand(html)).toBe(true);
  });

  it("THE INVARIANT: band rendered ⇔ slot flagged, in the SAME render", () => {
    // The pair is the point. Either assertion alone is satisfied by a constant;
    // only the biconditional catches the two readers drifting apart, which is
    // exactly how the defect shipped.
    for (const discipline of [[], [{ side: "away", classKey: "red" }]]) {
      const html = renderToStaticMarkup(<OverlayStage {...props(live(discipline))} />);
      expect(slotHasBand(html), `discipline: ${JSON.stringify(discipline)}`).toBe(barHasBand(html));
    }
  });
});

describe("hasDetailBand is the predicate the bar actually used", () => {
  const model = (over: Partial<ReturnType<typeof overlayModel>>) =>
    ({ detail: [], ...over }) as ReturnType<typeof overlayModel>;

  it("an empty chase string renders NO band — truthiness, not `!== undefined`", () => {
    // The predicate this replaced was `model.chase ||`, so "" meant no band.
    // `!== undefined` would have quietly started rendering an empty one.
    expect(hasDetailBand(model({ chase: "" }))).toBe(false);
    expect(hasDetailBand(model({ chase: "needs 12" }))).toBe(true);
  });

  it("a result alone is enough, and so is one detail line", () => {
    expect(hasDetailBand(model({ result: "Home won by 12 runs" }))).toBe(true);
    expect(hasDetailBand(model({ detail: [{ text: "x" }] as never }))).toBe(true);
    expect(hasDetailBand(model({}))).toBe(false);
  });
});

// R2007 (spec 2026-10-15 §4.7) — the slab attaches where the TEMPLATE says, read off its registry entry. The two shipped
// values are typed from the spec's placement (bar → bar, bug → bug), so a registry edit that swaps them goes red too.
const SPEC_PLACEMENT: Record<TemplateId, "bar" | "bug"> = { bar: "bar", bug: "bug" };
const PINNED: OverlayMoment = { kind: "goal", headline: "GOAL", line: "Milton Keynes Rovers", tone: "led", seq: 9 };

const slotClassOf = (html: string): string | undefined =>
  /data-testid="ovl-moment-slot" class="([^"]*)"/.exec(html)?.[1];

describe("the slot's placement is the template's own `slabPlacement`", () => {
  it("for every registry entry, the slot class is ovl-moment-slot--<def.slabPlacement>, and it holds the slab", () => {
    let checked = 0;
    for (const def of Object.values(OVERLAY_TEMPLATES)) {
      expect(def.slabPlacement, def.id).toBe(SPEC_PLACEMENT[def.id]);
      const html = renderToStaticMarkup(
        <OverlayStage {...props(live([]))} style={def.id} snapshotOnly pinnedMoment={PINNED} />,
      );
      expect(slotClassOf(html)?.split(" "), def.id).toContain(`ovl-moment-slot--${def.slabPlacement}`);
      expect(html, `${def.id}: the pinned slab renders in the slot`).toMatch(
        /data-testid="ovl-moment-slot"[^>]*>(?:(?!<\/div>).)*data-testid="overlay-moment"/s,
      );
      checked++;
    }
    console.log(`templates checked: ${checked}`);
    expect(checked, "anti-vacuity").toBeGreaterThan(0);
    expect(checked).toBe(2);
  });

  it("no pinned moment and nothing new on the ledger: the slot is empty", () => {
    const html = renderToStaticMarkup(<OverlayStage {...props(live([]))} style="bug" snapshotOnly />);
    expect(html).not.toContain('data-testid="overlay-moment"');
  });
});

// R2007 step 4.2b (coordinator decision G2) — the stage hands the card layout its box and its region as inline custom
// properties on `.ovl-canvas`. The expected values are the def's own declared box and `cardRegionFor` of it (whose rule is
// pinned with typed numbers in template-registry.test.ts).
describe("the stage writes --ovl-safe-* and --ovl-card-* from the registry entry", () => {
  const canvasStyleOf = (html: string): string =>
    /data-testid="ovl-root"[^>]*style="([^"]*)"/.exec(html)?.[1] ?? "";

  it("for every registry entry", () => {
    let checked = 0;
    for (const def of Object.values(OVERLAY_TEMPLATES)) {
      const style = canvasStyleOf(renderToStaticMarkup(<OverlayStage {...props(live([]))} style={def.id} />));
      const box = def.sceneCardSafeArea;
      const region = cardRegionFor(box)!;
      const want: Record<string, number> = {
        "--ovl-safe-x": box.x,
        "--ovl-safe-y": box.y,
        "--ovl-safe-w": box.width,
        "--ovl-safe-h": box.height,
        "--ovl-card-x": region.x,
        "--ovl-card-y": region.y,
        "--ovl-card-w": region.width,
        "--ovl-card-h": region.height,
      };
      for (const [prop, px] of Object.entries(want)) expect(style, `${def.id} ${prop}`).toContain(`${prop}:${px}px`);
      checked++;
    }
    console.log(`templates checked: ${checked}`);
    expect(checked).toBe(2);
  });
});

// R2007 steps 7 and 9 (review m1) — each `sceneCardSafeArea` is DECLARED from its template's CSS layout rule, never
// copied from a measurement. This holds the declaration to the stylesheet it was derived from: move a bar band or the
// bug's width and the box must move with it. The expected numbers are the CSS custom properties, never a render.
describe("each template's declared box is the box its CSS lays out", () => {
  const RULES = parseCss(readGlobalsCss());
  const px = (selector: string, prop: string): number => {
    let found: string | undefined;
    for (const r of RULES) if (r.selector === selector && r.conditions.length === 0) found = declaredValue(r, prop) ?? found;
    const m = /^(\d+(?:\.\d+)?)px$/.exec(found ?? "");
    if (!m) throw new Error(`${selector} { ${prop} } is not a px length: ${found}`);
    return Number(m[1]);
  };

  it("the bar: x = .ovl-bar left, width = canvas − left − right, y = 1080 − bottom − main − band", () => {
    const bottom = px(".ovl-canvas", "--ovl-bar-bottom");
    const main = px(".ovl-canvas", "--ovl-bar-main-h");
    const band = px(".ovl-canvas", "--ovl-bar-band-h");
    const left = px(".ovl-bar", "left");
    const right = px(".ovl-bar", "right");
    expect(OVERLAY_TEMPLATES.bar.sceneCardSafeArea).toEqual({
      x: left,
      y: 1080 - bottom - main - band,
      width: 1920 - left - right,
      height: main + band,
    });
  });

  it("the bug: its left, top and width; height = header + two rows + footer (the most any sport shows)", () => {
    const left = px(".ovl-canvas", "--ovl-bug-left");
    const top = px(".ovl-canvas", "--ovl-bug-top");
    const width = px(".ovl-canvas", "--ovl-bug-w");
    const header = px(".ovl-canvas", "--ovl-bug-header-h");
    const row = px(".ovl-canvas", "--ovl-bug-row-h");
    const footer = px(".ovl-canvas", "--ovl-bug-footer-h");
    expect(OVERLAY_TEMPLATES.bug.sceneCardSafeArea).toEqual({ x: left, y: top, width, height: header + 2 * row + footer });
  });

  it("…and the bug's rules READ those properties, so the box and the paint cannot drift apart", () => {
    const decl = (selector: string, prop: string): string | undefined => {
      let found: string | undefined;
      for (const r of RULES) if (r.selector === selector && r.conditions.length === 0) found = declaredValue(r, prop) ?? found;
      return found;
    };
    expect(decl(".ovl-bug", "left")).toBe("var(--ovl-bug-left)");
    expect(decl(".ovl-bug", "top")).toBe("var(--ovl-bug-top)");
    expect(decl(".ovl-bug", "width")).toBe("var(--ovl-bug-w)");
    expect(decl(".ovl-bug-header", "height")).toBe("var(--ovl-bug-header-h)");
    expect(decl(".ovl-bug-row", "height")).toBe("var(--ovl-bug-row-h)");
    expect(decl(".ovl-bug-footer", "height")).toBe("var(--ovl-bug-footer-h)");
    expect(decl(".ovl-bar", "bottom")).toBe("var(--ovl-bar-bottom)");
    expect(decl(".ovl-bar-main", "height")).toBe("var(--ovl-bar-main-h)");
    expect(decl(".ovl-detail-band", "height")).toBe("var(--ovl-bar-band-h)");
  });
});
