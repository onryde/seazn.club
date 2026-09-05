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

/** A football match that went to extra time: the engine's own phase tokens ride
 *  in `columnLabels`, and they must WIN over the ordinal. "Period 4" is not what
 *  extra time is called. */
const EXTRA_TIME: SetsViewT = {
  kind: "periods",
  unit: "period",
  columns: ["1", "2", "3", "4"],
  columnLabels: ["H1", "H2", "ET_H1", "ET_H2"],
  rows: [
    ["1", "0", "1", "0"],
    ["0", "1", "1", "0"],
  ],
  closedMask: [true, true, true, true],
};

/** An overtime label the dictionary does NOT carry — `OT3` is reachable by
 *  construction (`otLabels` builds `OT1..OTk`), so the fallback has to hold. */
const DEEP_OVERTIME: SetsViewT = {
  kind: "periods",
  unit: "period",
  columns: ["1", "2"],
  columnLabels: ["P1", "OT9"],
  rows: [
    ["1", "0"],
    ["1", "1"],
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

const DOCS: MatchCentreDocT[] = [
  TENNIS,
  BADMINTON,
  FOOTBALL,
  EXTRA_TIME,
  DEEP_OVERTIME,
  LEGACY,
  null,
].map((s) =>
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

  it("period headers use SHORT notation; the prose rides in title and sr-only", () => {
    const et = render(EXTRA_TIME);
    // The VISIBLE header is notation. A period column is 32px of a fixed-layout
    // table and the prose form is "Extra time — first half"; a fixed table never
    // grows to fit, so the header would have spilled over its neighbour.
    expect(et).toContain(`<span aria-hidden="true">${en["term.short.ET_H1"]}</span>`);
    expect(et).toContain(`<span aria-hidden="true">${en["term.short.H1"]}</span>`);
    expect(en["term.short.ET_H1"]).toBe("ET1");
    // The FULL name is still reachable — hover and screen reader both.
    expect(et).toContain(`title="${en["term.ET_H1"]}"`);
    expect(et).toContain(`<span class="sr-only">${en["term.ET_H1"]}</span>`);
    // …and specifically NOT the ordinal fallback. This is the differential:
    // "Period 3"/"Period 4" is what the ordinal path would print.
    expect(et).not.toContain("Period 3");
    expect(et).not.toContain("Period 4");

    // Nothing longer than four characters renders in a period header — the
    // budget the column was sized for.
    const visible = [...et.matchAll(/<span aria-hidden="true">([^<]*)<\/span>/g)].map((m) => m[1]);
    expect(visible.length).toBeGreaterThanOrEqual(4);
    for (const label of visible) expect(label.length, label).toBeLessThanOrEqual(4);

    // An unbounded label the dictionary cannot carry falls through to the
    // ordinal rather than printing the key — `lookup`, not `t`, is what makes
    // that possible.
    const deep = render(DEEP_OVERTIME);
    expect(deep).toContain(`<span aria-hidden="true">${en["term.short.P1"]}</span>`);
    expect(deep).toContain("Period 2");
    expect(deep).not.toContain("term.short.OT9");
    expect(deep).not.toContain("OT9");
  });

  it("sets are still numbered — `columnLabels` is a period-sport concern", () => {
    const html = render(TENNIS);
    expect(html).toContain("Set 1");
    expect(html).toContain("Set 3");
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

  it("the table is fixed-layout with sized columns, and a reachable region", () => {
    // Same ruled shape as the Scorecard's tables: `min-w-0` on a <th> is inert
    // and an auto-layout table grows to its longest entrant name, so the name
    // span needs a bounded column rather than a `min-w-0` that does nothing.
    const html = render(TENNIS);
    expect(html).toContain("table-fixed");
    expect(html).not.toContain("min-w-0 px-1 py-1.5");
    expect(html).toContain('<span class="block truncate">');
    // Both attributes on the SAME tag, in whichever order React serialises
    // them — pinning the order would be pinning React, not the contract.
    expect(html).toMatch(/<th[^>]*data-testid="mc-sets-col-0"[^>]*\bw-10\b[^>]*>/);

    // The region trio — an overflow whose content is REACHABLE is a feature;
    // without these axe reds `scrollable-region-focusable` at SERIOUS impact.
    expect(html).toContain("overflow-x-auto");
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('role="region"');
    expect(html).toMatch(/aria-label="[^"]+"/);

    // A caption and real scopes, and the empty leading header carries an
    // sr-only label (axe `empty-table-header`).
    expect(html).toContain("<caption");
    expect(html).toContain('scope="col"');
    expect(html).toContain('scope="row"');
    expect(html).toContain(`<span class="sr-only">${en["matchCentre.col.side"]}</span>`);
  });

  it("no dictionary key leaks into the markup unresolved", () => {
    for (const s of [TENNIS, BADMINTON, FOOTBALL, LEGACY, null]) {
      expect(render(s)).not.toContain("matchCentre.");
    }
  });
});
