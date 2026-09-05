// Spectator surface W1, Task 13 — CommentaryTab static-markup tests.
// `environment: "node"`, so this is real React SSR through
// `renderToStaticMarkup`; assertions anchor on `="`, and every negative ships
// with its positive pair (Task 10's conventions).
//
// ---------------------------------------------------------------------------
// Mutants killed (Task 13) — Commentary
// ---------------------------------------------------------------------------
//  (l) SORT OVERS ASCENDING — `[...all].reverse()` removed, so the oldest over
//      renders first.
//      → RED: "over groups render NEWEST first".
//
//  (m) SHOW EVERY OVER — the `slice(-visible)` window dropped.
//      → RED: "only the last five of seven overs render, with the button".
//
// Both compile and collect (`numTotalTests` unchanged), so neither is the
// collection-break shape that reads as a survivor.
import { beforeAll, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { MatchCentreDoc, type MatchCentreDocT } from "@/server/public-site/match-centre-schema";
import type { LiveFixtureData } from "../../live-score-data";
import { CommentaryTab } from "../commentary-tab";
import { makeDoc, over } from "./fixtures";

const dict = en as Dict;
const data = {} as LiveFixtureData;

const SEVEN = makeDoc({
  overs: [1, 2, 3, 4, 5, 6, 7].map((n) => over(n, ["1", "4", "·", "W", "wd", "2"], `Bowler${n}`)),
});
const THREE = makeDoc({ overs: [1, 2, 3].map((n) => over(n, ["1", "·"], `Bowler${n}`)) });
const NO_OVERS = makeDoc({ overs: [] });
const NO_CRICKET = makeDoc();
const NO_BOWLER = makeDoc({ overs: [over(1, ["1", "6"], null)] });

const render = (d: MatchCentreDocT): string =>
  renderToStaticMarkup(<CommentaryTab doc={d} dict={dict} data={data} />);

beforeAll(() => {
  for (const d of [SEVEN, THREE, NO_OVERS, NO_CRICKET, NO_BOWLER]) {
    expect(MatchCentreDoc.safeParse(d).success).toBe(true);
  }
});

describe("CommentaryTab", () => {
  it("EMPTY: no overs renders the panel container, no over group and no button", () => {
    for (const d of [NO_OVERS, NO_CRICKET]) {
      const html = render(d);
      expect(html).toContain('data-testid="mc-tab-panel-commentary"');
      expect(html).not.toContain('data-testid="mc-over-');
      expect(html).not.toContain('data-testid="mc-load-earlier"');
    }
    // Positive pair: the same probes fire on a populated document.
    const populated = render(SEVEN);
    expect(populated).toContain('data-testid="mc-over-');
    expect(populated).toContain('data-testid="mc-load-earlier"');
  });

  it("the root IS the tab panel — role, id and the label the rail points at", () => {
    const html = render(SEVEN);
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain('id="mc-tab-panel-commentary"');
    expect(html).toContain('aria-labelledby="mc-tab-commentary"');
  });

  it("over groups render NEWEST first", () => {
    const html = render(THREE);
    const at = (n: number) => html.indexOf(`data-testid="mc-over-${n}"`);
    expect(at(3)).toBeGreaterThanOrEqual(0);
    expect(at(1)).toBeGreaterThanOrEqual(0);
    expect(at(3)).toBeLessThan(at(2));
    expect(at(2)).toBeLessThan(at(1));
  });

  it("only the last five of seven overs render, with the button", () => {
    const html = render(SEVEN);
    for (const n of [7, 6, 5, 4, 3]) expect(html, `over ${n}`).toContain(`data-testid="mc-over-${n}"`);
    // …and the two oldest are withheld — the negative half of the same rule.
    for (const n of [2, 1]) expect(html, `over ${n}`).not.toContain(`data-testid="mc-over-${n}"`);
    expect(html).toContain('data-testid="mc-load-earlier"');
    expect(html).toContain("<button");
    expect(html).toContain(en["matchCentre.loadEarlier"]);
  });

  it("a document with five overs or fewer has no button", () => {
    expect(render(THREE)).not.toContain('data-testid="mc-load-earlier"');
    // Positive pair above: SEVEN does have it.
    expect(render(SEVEN)).toContain('data-testid="mc-load-earlier"');
  });

  it("ball lines carry mc-ball-<over>.<ball>, one per line, numbered from 1", () => {
    const html = render(THREE);
    for (let ball = 1; ball <= 2; ball++) {
      expect(html, `3.${ball}`).toContain(`data-testid="mc-ball-3.${ball}"`);
    }
    // Numbered from 1, never 0 — an off-by-one here reads as a real ball.
    expect(html).not.toContain('data-testid="mc-ball-3.0"');
    // The glyph rides beside the text.
    expect(html).toContain('data-testid="mc-glyph-3.1"');
  });

  it("the over header names the bowler, and drops the clause when there is none", () => {
    const withBowler = render(THREE);
    expect(withBowler).toContain("Bowler3");
    // "Over {over} · {runs} runs · {score} · {bowler}" resolved, not the key.
    expect(withBowler).toContain("Over 3 ·");
    expect(withBowler).not.toContain("{bowler}");

    const without = render(NO_BOWLER);
    expect(without).toContain("Over 1 ·");
    // The no-bowler variant is a DIFFERENT template, so no dangling separator
    // and no literal placeholder.
    expect(without).not.toContain("{bowler}");
    expect(without).not.toContain("· ·");
  });

  it("no dictionary key leaks into the markup unresolved", () => {
    for (const d of [SEVEN, THREE, NO_OVERS, NO_CRICKET, NO_BOWLER]) {
      const html = render(d);
      expect(html).not.toContain("matchCentre.");
      expect(html).not.toContain("public.matchCentre");
    }
  });
});
