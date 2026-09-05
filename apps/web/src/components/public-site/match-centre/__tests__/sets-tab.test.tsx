// Spectator surface W1, Task 13 — SetsTab static-markup tests.
//
// ---------------------------------------------------------------------------
// Mutants killed (Task 13) — Sets
// ---------------------------------------------------------------------------
//  (p) EVERY COLUMN OPEN — `data-open` written as `"true"` unconditionally
//      instead of from `closedMask[i] === false`.
//      → RED: "exactly the open column is marked".
//
//  (q) NULL RENDERS EMPTY — the `?? "–"` on a null cell dropped.
//      → RED: "a null cell reads as an en dash, never as blank".
//
// Both compile and collect (`numTotalTests` unchanged), so neither is the
// collection-break shape that reads as a survivor.
import { beforeAll, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";
import {
  MatchCentreDoc,
  type MatchCentreDocT,
  type SetsViewT,
} from "@/server/public-site/match-centre-schema";
import type { LiveFixtureData } from "../../live-score-data";
import { SetsTab } from "../sets-tab";
import { AWAY, HOME, makeDoc } from "./fixtures";

const dict = en as Dict;
const data = {} as LiveFixtureData;

// Tennis: two sets closed, a third in play. The mixed mask is what makes the
// "exactly the open column" assertion able to fail.
const TENNIS: SetsViewT = {
  kind: "sets",
  unit: "set",
  columns: ["1", "2", "3"],
  rows: [
    ["6", "3", "2"],
    ["4", "6", "1"],
  ],
  closedMask: [true, true, false],
};

const BADMINTON: SetsViewT = {
  kind: "sets",
  unit: "game",
  columns: ["1", "2"],
  rows: [
    ["21", "19"],
    ["15", "21"],
  ],
  closedMask: [true, true],
};

const FOOTBALL: SetsViewT = {
  kind: "periods",
  unit: "period",
  columns: ["1", "2"],
  rows: [
    ["1", "1"],
    ["0", null],
  ],
  closedMask: [true, false],
};

/** A document built before `unit` existed — the field is optional, so the
 *  renderer must still label the columns from the raw `columns` strings. */
const LEGACY: SetsViewT = {
  kind: "periods",
  columns: ["H1", "H2"],
  rows: [
    ["1", "2"],
    ["0", "1"],
  ],
  closedMask: [true, true],
};

const render = (sets: SetsViewT | null): string =>
  renderToStaticMarkup(<SetsTab doc={makeDoc({ sets })} dict={dict} data={data} />);

const DOCS: MatchCentreDocT[] = [TENNIS, BADMINTON, FOOTBALL, LEGACY, null].map((s) =>
  makeDoc({ sets: s }),
);

beforeAll(() => {
  for (const d of DOCS) expect(MatchCentreDoc.safeParse(d).success).toBe(true);
});

describe("SetsTab", () => {
  it("EMPTY: doc.sets === null renders the panel container and no table", () => {
    const html = render(null);
    expect(html).toContain('data-testid="mc-sets"');
    expect(html).not.toContain("<table");
    expect(html).not.toContain('data-testid="mc-sets-col-');
    expect(render(TENNIS)).toContain("<table"); // positive pair
  });

  it("the root does NOT claim the tabpanel role — MatchCentre's wrapper owns it", () => {
    // `MatchCentre` wraps whichever panel is active in ONE element carrying
    // `role="tabpanel"`, `id="mc-tab-panel-sets"` and `aria-labelledby`. A
    // panel that also declared them would nest two tabpanels and put the same
    // id in the document twice — so this asserts their ABSENCE, and the panel
    // keeps only its own testid.
    const html = render(TENNIS);
    expect(html).toContain('data-testid="mc-sets"');
    expect(html).not.toContain('role="tabpanel"');
    expect(html).not.toContain('id="mc-tab-panel-sets"');
    expect(html).not.toContain('aria-labelledby=');
  });

  it("one column per entry, one row per side, values from rows[sideIndex][i]", () => {
    const html = render(TENNIS);
    for (let i = 0; i < TENNIS.columns.length; i++) {
      expect(html, `col ${i}`).toContain(`data-testid="mc-sets-col-${i}"`);
    }
    expect(html).not.toContain('data-testid="mc-sets-col-3"');
    expect(html).toContain('data-testid="mc-sets-row-0"');
    expect(html).toContain('data-testid="mc-sets-row-1"');
    expect(html).toContain(HOME.name);
    expect(html).toContain(AWAY.name);
    expect(html).toContain('data-testid="mc-sets-cell-0-0"');
    expect(html).toContain('data-testid="mc-sets-cell-1-2"');
  });

  it("exactly the open column is marked", () => {
    const html = render(TENNIS);
    // Set 3 is in play; sets 1 and 2 are closed.
    expect(html).toMatch(/data-testid="mc-sets-col-2"[^>]*data-open="true"/);
    expect(html).not.toMatch(/data-testid="mc-sets-col-0"[^>]*data-open="true"/);
    expect(html).not.toMatch(/data-testid="mc-sets-col-1"[^>]*data-open="true"/);
    // Exactly one, counted — "not on column 0" alone would pass if the flag
    // were on two of the three.
    expect((html.match(/data-open="true"/g) ?? []).length).toBe(1);
    // A fully closed table has none at all.
    expect(render(BADMINTON)).not.toContain('data-open="true"');
  });

  it("a null cell reads as an en dash, never as blank", () => {
    const html = render(FOOTBALL);
    // `[^>]*` because `className` is serialised AFTER `data-testid` — pinning
    // the testid as the last attribute would be pinning React's attribute
    // ORDER, which is not the contract.
    expect(html).toMatch(/data-testid="mc-sets-cell-1-1"[^>]*>–</);
    // Positive pair: a present value renders itself, not the dash.
    expect(html).toMatch(/data-testid="mc-sets-cell-0-0"[^>]*>1</);
  });

  it("columns are labelled in the sport's own unit — set, game, period", () => {
    expect(render(TENNIS)).toContain("Set 1");
    expect(render(TENNIS)).toContain("Set 3");
    expect(render(BADMINTON)).toContain("Game 1");
    expect(render(BADMINTON)).not.toContain("Set 1"); // the differential case
    expect(render(FOOTBALL)).toContain("Period 1");
    expect(render(FOOTBALL)).not.toContain("Game 1");
  });

  it("without `unit` the raw column strings are used — a pre-`unit` document still reads", () => {
    const html = render(LEGACY);
    expect(html).toContain("H1");
    expect(html).toContain("H2");
    expect(html).not.toContain("Period 1");
  });

  it("the caption distinguishes sets from periods", () => {
    expect(render(TENNIS)).toContain(en["matchCentre.sets"]);
    expect(render(FOOTBALL)).toContain(en["matchCentre.periods"]);
    expect(en["matchCentre.sets"]).not.toBe(en["matchCentre.periods"]);
    expect(render(FOOTBALL)).not.toContain(`>${en["matchCentre.sets"]}<`);
  });

  it("no dictionary key leaks into the markup unresolved", () => {
    for (const s of [TENNIS, BADMINTON, FOOTBALL, LEGACY, null]) {
      expect(render(s)).not.toContain("matchCentre.");
    }
  });
});
