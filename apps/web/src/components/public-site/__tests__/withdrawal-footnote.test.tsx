// W5 app PR A, Task 8 (RB5-W7, X-WDT-5; owner R24 pick 11 A): the footnote under a league or group table that names the rule
// a departure applied. One line per departed entrant of THAT table, under it, on the division page (StandingsTable) and the
// hub (StandingsTableView, fed by buildTableView).
//
// Expected English is the owner's own R24 example wording ("Riverside Rovers (withdrawn): left after 2 of 5, so their results
// are removed and their other matches are void." / "Cliffside United (disqualified): left after 3 of 5, so their results
// stand and their other 2 matches are walkovers."), never read back from the dictionary under test. The three other locales
// are checked for shape (every placeholder filled, the name and the counts present, a value that is not English).
//
// `environment: "node"`: real React SSR via renderToStaticMarkup; assertions anchor on `="` (AGENTS.md).
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { StandingsRow } from "@seazn/engine/competition";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { t, type TKey } from "@/lib/i18n-runtime";
import {
  TABLE_WITHDRAWAL_ROW,
  TABLE_WITHDRAWAL_VOIDED_ROW,
  activeTableWithdrawals,
  withdrawalNoteText,
  withdrawalNotesFor,
  type WithdrawalNote,
} from "@/lib/table-withdrawal-note";
import { buildTableView } from "@/server/public-site/standings-view";
import { StandingsTable } from "../standings-table";
import { StandingsTableView } from "../standings-table-view";

const LOCALES: Record<string, Dict> = { en: en as Dict, es: es as Dict, fr: fr as Dict, nl: nl as Dict };
const msgOf = (dict: Dict) => (key: TKey, vars?: Record<string, string | number>) => t(dict, key, vars);
const enMsg = msgOf(en as Dict);
/** A realistic long entrant name (43 characters) — the 320px wrap case. */
const LONG = "Riverside Rovers Community Football Club 2nd";

const note = (over: Partial<WithdrawalNote>): WithdrawalNote => ({
  entrantId: "rr",
  name: "Riverside Rovers",
  status: "withdrawn",
  policy: "expunge",
  played: 2,
  scheduled: 5,
  ...over,
});
const line = (n: WithdrawalNote, msg = enMsg) => {
  const x = withdrawalNoteText(n, msg);
  return `${x.lead} ${x.body}`;
};

describe("the footnote's sentence (R24 pick 11 A)", () => {
  it("names the expunge in the owner's example words", () => {
    expect(line(note({}))).toBe(
      "Riverside Rovers (withdrawn): left after 2 of 5, so their results are removed and their other matches are void.",
    );
  });
  it("names the walkovers in the owner's example words, the count of the rest included", () => {
    expect(line(note({ entrantId: "cu", name: "Cliffside United", status: "disqualified", policy: "walkover", played: 3 }))).toBe(
      "Cliffside United (disqualified): left after 3 of 5, so their results stand and their other 2 matches are walkovers.",
    );
  });
  it("one remaining match is singular; none remaining says only that the results stand", () => {
    expect(line(note({ policy: "walkover", played: 4 }))).toBe(
      "Riverside Rovers (withdrawn): left after 4 of 5, so their results stand and their other match is a walkover.",
    );
    expect(line(note({ policy: "walkover", played: 5 }))).toBe("Riverside Rovers (withdrawn): left after 5 of 5, so their results stand.");
  });
  it("an expunge with nothing played removes no result: it says only that the matches are void", () => {
    expect(line(note({ played: 0 }))).toBe("Riverside Rovers (withdrawn): left after 0 of 5, so their matches are void.");
  });
  it("never 'left after 0 of 0' (R24 item 11): nothing scheduled has its own line, under either policy", () => {
    for (const policy of ["expunge", "walkover"] as const) {
      const s = line(note({ policy, played: 0, scheduled: 0 }));
      expect(s).toBe("Riverside Rovers (withdrawn): left before any match was scheduled.");
      expect(s).not.toContain("0 of 0");
    }
  });
  it("every locale fills every placeholder and names the entrant and the counts (5 cases × 4 locales)", () => {
    const cases = [note({}), note({ played: 0 }), note({ policy: "walkover", played: 3 }), note({ policy: "walkover", played: 4 }), note({ policy: "walkover", played: 5 }), note({ scheduled: 0, played: 0 }), note({ status: "disqualified" })];
    let checked = 0;
    for (const [loc, dict] of Object.entries(LOCALES)) {
      for (const c of cases) {
        const s = line(c, msgOf(dict));
        expect(s, `${loc}: a placeholder left unfilled`).not.toMatch(/[{}]/);
        expect(s, `${loc}: a bare key printed`).not.toContain("table.withdrawalNote");
        expect(s).toContain("Riverside Rovers");
        if (c.scheduled > 0) expect(s, `${loc}: the scheduled count`).toContain(String(c.scheduled));
        if (loc !== "en") expect(s, `${loc}: still English`).not.toBe(line(c));
        checked++;
      }
    }
    expect(checked).toBe(4 * cases.length);
  });
});

describe("the ledger fold (activeTableWithdrawals)", () => {
  const row = (seq: number, payload: Record<string, unknown>) => ({ seq, type: TABLE_WITHDRAWAL_ROW, payload });
  const ok = { entrant_id: "a", stage_id: "s", policy: "expunge", played_at_departure: 1, scheduled: 3 };
  it("the empty ledger has no record", () => {
    expect(activeTableWithdrawals([])).toEqual([]);
  });
  it("a row its void names is gone; a row nobody voided stays", () => {
    const ledger = [row(4, ok), { seq: 7, type: TABLE_WITHDRAWAL_VOIDED_ROW, payload: { voids_seq: 4 } }];
    expect(activeTableWithdrawals(ledger)).toEqual([]);
    expect(activeTableWithdrawals([row(4, ok)])).toEqual([{ seq: 4, ...ok }]);
  });
  it("a second withdrawal after a Reinstate is the one that holds", () => {
    const ledger = [row(4, ok), { seq: 7, type: TABLE_WITHDRAWAL_VOIDED_ROW, payload: { voids_seq: 4 } }, row(9, { ...ok, policy: "walkover", played_at_departure: 2 })];
    expect(activeTableWithdrawals(ledger)).toEqual([{ seq: 9, ...ok, policy: "walkover", played_at_departure: 2 }]);
  });
  it("a row the writer never produces is not read (6 malformed shapes)", () => {
    const bad = [
      { ...ok, entrant_id: 3 },
      { ...ok, stage_id: undefined },
      { ...ok, policy: "none" },
      { ...ok, played_at_departure: -1 },
      { ...ok, scheduled: 1.5 },
      { ...ok, played_at_departure: 4, scheduled: 3 },
    ];
    for (const p of bad) expect(activeTableWithdrawals([row(1, p)]), JSON.stringify(p)).toEqual([]);
    expect(bad).toHaveLength(6);
  });
});

describe("one table's notes (withdrawalNotesFor)", () => {
  const rec = (entrant_id: string, stage_id = "s1") => ({ seq: 1, entrant_id, stage_id, policy: "expunge" as const, played_at_departure: 1, scheduled: 3 });
  it("an empty table, or a table nobody left, has none", () => {
    expect(withdrawalNotesFor("s1", [], [rec("a")], { a: "withdrawn" }, {})).toEqual([]);
    expect(withdrawalNotesFor("s1", ["a", "b"], [], { a: "registered", b: "registered" }, {})).toEqual([]);
  });
  it("only a departed entrant of THIS stage, in the table's own order", () => {
    const notes = withdrawalNotesFor(
      "s1",
      ["c", "b", "a", "d"],
      [rec("a"), rec("b"), rec("c"), rec("d", "s2")],
      { a: "withdrawn", b: "registered", c: "disqualified", d: "withdrawn" },
      { a: "Alpha", c: "Cygnus" },
    );
    expect(notes.map((n) => [n.entrantId, n.name, n.status])).toEqual([
      ["c", "Cygnus", "disqualified"],
      ["a", "Alpha", "withdrawn"],
    ]);
  });
});

const ROWS: StandingsRow[] = [
  { entrantId: "p2", played: 2, won: 2, drawn: 0, lost: 0, points: 6, metrics: {}, rank: 1 },
  { entrantId: "p3", played: 2, won: 0, drawn: 0, lost: 2, points: 0, metrics: {}, rank: 2 },
  { entrantId: "rr", played: 0, won: 0, drawn: 0, lost: 0, points: 0, metrics: {}, rank: 3 },
];
const NAMES = { p2: "Harbourside", p3: "Millbrook", rr: LONG };

describe("the division page's table (StandingsTable)", () => {
  const render = (withdrawalNotes?: WithdrawalNote[]) =>
    renderToStaticMarkup(
      createElement(StandingsTable, {
        rows: ROWS,
        metricSpecs: [],
        cascade: ["points"],
        entrantNames: NAMES,
        entrantStatuses: { rr: "withdrawn" },
        dict: en as Dict,
        withdrawalNotes,
      }),
    );
  it("prints the line under the table, the long name in bold, wrapping", () => {
    const html = render([note({ name: LONG })]);
    expect(html).toContain('data-testid="standings-withdrawal-notes"');
    expect(html).toContain('data-testid="standings-withdrawal-note-rr"');
    expect(html).toContain(`<strong class="font-semibold text-ink">${LONG} (withdrawn):</strong> left after 2 of 5, so their results are removed and their other matches are void.`);
    expect(html).toMatch(/data-testid="standings-withdrawal-note-rr" class="[^"]*\bbreak-words\b/);
    // under the table, not inside its sideways scroll
    expect(html.indexOf('data-testid="standings-withdrawal-notes"')).toBeGreaterThan(html.lastIndexOf("</table>"));
  });
  it("a table nobody left prints no footnote (absent and empty alike)", () => {
    expect(render()).not.toContain("standings-withdrawal-notes");
    expect(render([])).not.toContain("standings-withdrawal-notes");
  });
});

describe("the hub's table (buildTableView → StandingsTableView)", () => {
  const view = (withdrawalNotes?: WithdrawalNote[]) =>
    buildTableView({
      id: "t1",
      division: { id: "d1", slug: "div", name: "Div" },
      caption: "League",
      rules: null,
      dateOf: () => null,
      fullHref: "/live/o/c/div?tab=standings",
      rows: ROWS,
      metricSpecs: [],
      cascade: ["points"],
      entrantNames: NAMES,
      entrantLogos: {},
      entrantColours: {},
      championIds: [],
      updatedAt: "2026-11-17T00:00:00.000Z",
      msg: enMsg,
      withdrawalNotes,
    });
  it("the builder resolves the line in the org's language and the full table prints it", () => {
    const v = view([note({ name: LONG, policy: "walkover", played: 3 })]);
    expect(v.withdrawalNotes).toEqual([
      { entrantId: "rr", lead: `${LONG} (withdrawn):`, body: "left after 3 of 5, so their results stand and their other 2 matches are walkovers." },
    ]);
    const html = renderToStaticMarkup(createElement(StandingsTableView, { view: v, dict: en as Dict, testid: "mh-table-t1" }));
    expect(html).toContain('data-testid="standings-withdrawal-note-rr"');
    expect(html).toContain("their other 2 matches are walkovers.");
  });
  it("the Overview's preview leaves it out, as it leaves out the legend", () => {
    const v = view([note({})]);
    const html = renderToStaticMarkup(createElement(StandingsTableView, { view: v, dict: en as Dict, testid: "mh-table-t1", preview: 3 }));
    expect(html).not.toContain("standings-withdrawal-notes");
  });
  it("a table nobody left carries no key at all (a cached document reads the same)", () => {
    expect("withdrawalNotes" in view()).toBe(false);
    expect("withdrawalNotes" in view([])).toBe(false);
    const html = renderToStaticMarkup(createElement(StandingsTableView, { view: view(), dict: en as Dict, testid: "mh-table-t1" }));
    expect(html).not.toContain("standings-withdrawal-notes");
  });
});
