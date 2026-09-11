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
