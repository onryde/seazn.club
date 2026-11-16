// The demo island's server render (chase-demo.tsx): what a visitor sees before script runs, or without it. Taps are
// proven in the browser (marketing-product.spec.ts); this suite has no DOM.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChaseDemo, type ChaseTile } from "../chase-demo";
import { chaseDemoLabels } from "../chase-demo-labels";
import { BALLS_PER_OVER, CHASE, ballsLeft, openingChase, oversText } from "@/lib/marketing/cricket-chase";
import { LOCALES, type Dict } from "@/lib/i18n-constants";
import en from "@/dictionaries/en/marketing.json";
import fr from "@/dictionaries/fr/marketing.json";
import es from "@/dictionaries/es/marketing.json";
import nl from "@/dictionaries/nl/marketing.json";

const DICTS = { en, fr, es, nl } as unknown as Record<string, Dict>;
const TEAMS = { batting: "Thorpe Bay Tigers", bowling: "Southend Blue Blazers" };
const ALL: ChaseTile[] = ["pad", "matchCentre", "table", "stream"];
const render = (lang: string, tiles: ChaseTile[], streamControls: boolean) =>
  renderToStaticMarkup(<ChaseDemo tiles={tiles} streamControls={streamControls} labels={chaseDemoLabels(DICTS[lang]!)} teams={TEAMS} />);
const KEYS = ["0", "1", "2", "3", "4", "6", "wide", "out"];

describe("ChaseDemo server render", () => {
  it.each(LOCALES.map((l) => [l]))("%s: shows the opening state in every tile", (lang) => {
    const html = render(lang, ALL, false);
    const o = openingChase();
    const score = `${o.runs}/${o.wkts}`;
    for (const tile of ALL) {
      const at = html.indexOf(`data-testid="chase-tile-${tile}"`);
      expect(at, tile).toBeGreaterThan(-1);
    }
    // pad, match page and stream each print the score; pad, match page and stream each print the overs
    expect(html.split(`>${score}<`).length - 1).toBe(3);
    expect(html.split(`>${oversText(o.balls, BALLS_PER_OVER)}<`).length - 1).toBeGreaterThanOrEqual(3);
    expect(html).toContain(String(CHASE.target - o.runs));
    expect(html).toContain(String(ballsLeft(o)));
    expect(html).not.toMatch(/\{[a-z]+\}/); // no unfilled placeholder
    expect(html).not.toContain("demo."); // no raw dictionary key
  });

  it("streaming configuration renders the pad and the stream only, with the stream's switches", () => {
    const html = render("en", ["pad", "stream"], true);
    expect(html).toContain('data-testid="chase-tile-pad"');
    expect(html).toContain('data-testid="chase-tile-stream"');
    expect(html).not.toContain('data-testid="chase-tile-matchCentre"');
    expect(html).not.toContain('data-testid="chase-tile-table"');
    expect(html.match(/data-testid="chase-seg-style-[a-z]+"/g)).toHaveLength(2);
    expect(html.match(/data-testid="chase-seg-state-[a-z]+"/g)).toHaveLength(4);
    expect(render("en", ALL, false)).not.toContain("chase-seg-");
  });

  it("every key has a button, and undo has one", () => {
    const html = render("en", ALL, false);
    let found = 0;
    for (const k of KEYS) {
      expect(html.split(`data-testid="chase-key-${k}"`), k).toHaveLength(2);
      found++;
    }
    expect(found).toBe(8);
    expect(html.split('data-testid="chase-undo"')).toHaveLength(2);
    expect(html.match(/<button /g)!.length).toBe(9);
  });
});
