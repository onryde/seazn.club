// §1's ladder reaches the DOM (W2-F45).
//
// `pickNameRung` is arithmetic and `name-ladder.test.ts` owns it; the browser
// owns the measurement. THIS FILE OWNS THE SEAM BETWEEN THEM — that the bar
// actually renders one probe per rung, that the probe for the rung on air
// carries the right text, and that first paint is the FULL name.
//
// Without it the ladder is a pure function with a green suite and no caller,
// which is this repo's most-repeated failure (AGENTS.md class 1): the picker
// would still pass every case in `name-ladder.test.ts` with `<TeamName>` never
// mounted at all.
//
// `environment: "node"`, no jsdom — `renderToStaticMarkup` is this directory's
// precedent for a real, non-mocked render.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { OverlayStage, type OverlayStageProps } from "../overlay-stage";
import { decidedOutcomeTemplates } from "@/lib/scoring-vocab";
import type { OverlayLiveData } from "@/components/public-site/live-score-data";

const HERE = dirname(fileURLToPath(import.meta.url));
const DICT: Record<string, string> = JSON.parse(
  readFileSync(join(HERE, "../../../dictionaries/en/public.json"), "utf8"),
);

const DATA: OverlayLiveData = {
  status: "in_play",
  summary: {
    perSide: [
      { entrantId: "home", line: "1" },
      { entrantId: "away", line: "0" },
    ],
  },
  outcome: null,
  lastSeq: 4,
  venueTz: "UTC",
} as OverlayLiveData;

const render = (sides: OverlayStageProps["sides"]): string =>
  renderToStaticMarkup(
    <OverlayStage
      fixtureId="f1"
      initial={DATA}
      realtime={false}
      sportKey="football"
      style="bar"
      sides={sides}
      startLabel={null}
      dict={DICT}
      decidedTemplates={decidedOutcomeTemplates((k) => k)}
    />,
  );

/** Every hidden probe's text, in document order. The probes ARE the
 *  measurement: one per rung, or the browser is choosing between fewer
 *  candidates than §1 declares. */
const probes = (html: string): string[] =>
  [...html.matchAll(/class="ovl-team-name-probe"[^>]*>([^<]*)</g)].map((m) => m[1]!);

describe("the bar renders §1's ladder", () => {
  it("shows the FULL name on first paint, before anything has measured", () => {
    // The server render and the frame before the layout effect runs are the
    // same markup. W1 showed the full name; a build that shipped the CODE
    // until JS caught up would be a visible downgrade on every short name.
    const html = render([
      { id: "home", name: "Milton Keynes Rovers" },
      { id: "away", name: "Northbridge Athletic" },
    ]);
    expect(html).toContain('data-testid="ovl-team-name">Milton Keynes Rovers<');
    expect(html).toContain('data-testid="ovl-team-name">Northbridge Athletic<');
    expect(html).toContain('data-rung="0"');
  });

  it("carries a probe PER RUNG — two when there is no short name", () => {
    const html = render([
      { id: "home", name: "Milton Keynes Rovers" },
      { id: "away", name: "Northbridge Athletic" },
    ]);
    // Both sides, in order: the ladder is per-side, and a model that derived
    // one and used it twice would show four copies of the home ladder.
    expect(probes(html)).toEqual([
      "Milton Keynes Rovers",
      "MIL",
      "Northbridge Athletic",
      "NOR",
    ]);
  });

  it("carries THREE when the entrant has a short name, with the short name in the middle", () => {
    // The rung `public_entrants_v` cannot feed yet. Driving it here is what
    // keeps the middle of the ladder from being a seam nothing has ever
    // rendered on the day that view grows a `short_name`.
    const html = render([
      { id: "home", name: "Milton Keynes Rovers", short: "Rovers" },
      { id: "away", name: "Northbridge Athletic" },
    ]);
    expect(probes(html)).toEqual([
      "Milton Keynes Rovers",
      "Rovers",
      "MIL",
      "Northbridge Athletic",
      "NOR",
    ]);
  });

  it("the probes are HIDDEN and contribute no width — they measure, they do not paint", () => {
    // A probe that laid out would make the name box as wide as every rung at
    // once, and the ladder would never step: the box would always report
    // enough room for the longest.
    const css = readFileSync(join(HERE, "../../../app/globals.css"), "utf8");
    const rule = css.slice(css.indexOf(".ovl-team-name-probe"));
    const body = rule.slice(rule.indexOf("{"), rule.indexOf("}"));
    expect(body).toContain("position: fixed");
    expect(body).not.toContain("position: absolute");
    expect(body).toContain("visibility: hidden");
    // `display: none` would give them no box at all and `getBoundingClientRect`
    // would read 0 for every rung — the ladder would always pick the first.
    expect(body).not.toContain("display: none");
  });
});
