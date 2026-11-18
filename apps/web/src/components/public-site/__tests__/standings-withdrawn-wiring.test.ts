// A prop nothing sends is an inert seam. `entrantStatuses` is optional —
// by design, because most callers have no entrant statuses to hand — which
// means a page that silently stopped passing it would keep type-checking and
// keep rendering, with the defect back and no test red anywhere.
//
// All THREE `StandingsTable` call sites carry it. (Until 2026-09-21 the prop
// was `withdrawnEntrantIds`, a pre-filtered id list; it was replaced by the
// status map so that WHICH statuses count as departed is decided once, in the
// table, instead of three times at the call sites — see C1 in the layer test.) They did not always: until
// V412 `public_entrants_v` filtered `status in ('registered','confirmed')`, so
// on the public division page and the embed a withdrawn entrant never reached
// the page at all — the chip could not render, and `entrantNames` had no entry
// for her either, so the public table printed a RAW UUID in her name cell
// (F10, driven on the live page 2026-09-21). V412 widened the view; these two
// pages then became ordinary wiring, and the last row below pins the SQL fact
// they now depend on. Widen-then-forget is the failure this file exists for.
//
// `StandingsTableView` (the competition hub's own table, `matches-hub/{table,overview}-tab.tsx`) renders from a server-built
// `TableViewT` rather than raw rows, so the rows above cannot see it; the "X-SF-1" block at the foot of this file covers it
// (W5 T20). The premise row below counts only bare `<StandingsTable` mounts, so adding a new one of those still reds.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { StandingsRow } from "@seazn/engine/competition";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { t, type TKey } from "@/lib/i18n-runtime";
import { buildTableView } from "@/server/public-site/standings-view";
import { DEPARTED_STATUS_CHIPS } from "../standings-table";
import { StandingsTableView } from "../standings-table-view";

const MARKED = {
  "organiser console division page":
    "src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx",
  "public division page":
    "src/app/(public)/live/[orgSlug]/[competitionSlug]/[divisionSlug]/page.tsx",
  "embed widget": "src/app/embed/divisions/[id]/[widget]/page.tsx",
} as const;

/** Every .tsx under src/ that mounts `<StandingsTable`. */
function callSites(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name === "__tests__" || name === "node_modules") continue;
        walk(path);
        continue;
      }
      if (!name.endsWith(".tsx")) continue;
      if (path.endsWith("standings-table.tsx")) continue;
      // `<StandingsTable` is a PREFIX of `<StandingsTableView` — a bare
      // `includes` picks up the hub's two tabs and this premise fails for the
      // wrong reason. Anchor on what can follow a component name in JSX.
      if (/<StandingsTable[\s/>]/.test(readFileSync(path, "utf8"))) {
        out.push(relative(process.cwd(), path));
      }
    }
  };
  walk(join(process.cwd(), "src"));
  return out.sort();
}

const DELTAS = join(process.cwd(), "../../db/migration/deltas");

/**
 * The migrations that define `public_entrants_v`, newest last. Derived from
 * the directory rather than listed, so a future redefinition is read by this
 * test instead of slipping past a hardcoded filename.
 */
function viewDefinitions(): { file: string; sql: string }[] {
  return readdirSync(DELTAS)
    .filter((f) => f.endsWith(".sql"))
    .sort((a, b) => Number(/^V(\d+)/.exec(a)![1]) - Number(/^V(\d+)/.exec(b)![1]))
    .map((file) => ({ file, sql: readFileSync(join(DELTAS, file), "utf8") }))
    .filter(({ sql }) => /view public_entrants_v/.test(sql));
}

describe("the withdrawn marker reaches every standings surface that can carry it", () => {
  it("premise: these are ALL the StandingsTable call sites", () => {
    // Without this row a new page could mount an unmarked table and the rows
    // below would still pass — they only check the pages they already name.
    expect(callSites().map((p) => p.replace(/\\/g, "/")).sort()).toEqual(
      Object.values(MARKED).map((p) => p.replace(/\\/g, "/")).sort(),
    );
  });

  for (const [label, rel] of Object.entries(MARKED)) {
    it(`${label} hands the table every entrant status, unfiltered`, () => {
      const src = readFileSync(join(process.cwd(), rel), "utf8");
      // The derivation: hand the table each entrant's OWN status, per entrant.
      // What this replaced was `entrants.filter((e) => e.status === "withdrawn")`
      // — and that literal WAS the C1 defect: three pages each spelled out the
      // departed vocabulary and each got half of it, so a disqualified entrant
      // sat in the public standings marked as nothing at all. The vocabulary
      // now lives once, in the table (DEPARTED_STATUS_CHIPS).
      expect(src, `${label} never derives entrantStatuses`).toMatch(
        /entrantStatuses\s*=\s*Object\.fromEntries\([\s\S]{0,160}e\.status/,
      );
      // And the old shape has not crept back beside the new one: a page that
      // still filters to one status is a page that will miss the next one.
      expect(
        src,
        `${label} still filters entrants by a status literal — the vocabulary belongs to the table`,
      ).not.toMatch(/withdrawnEntrantIds|status === "withdrawn"/);
      // And it is actually handed to the table, in the JSX.
      expect(src, `${label} derives the statuses but does not pass them`).toContain(
        "entrantStatuses={entrantStatuses}",
      );
    });
  }

  it("premise: the CURRENT public_entrants_v publishes departed entrants", () => {
    // The two public surfaces above can only mark a withdrawal because the
    // view hands them one. If anybody ever restores the status filter, those
    // two pages go back to printing a UUID and every row above stays green —
    // this is the row that reds instead.
    const defs = viewDefinitions();
    expect(defs.length, "public_entrants_v is no longer defined in db/migration/deltas").toBeGreaterThanOrEqual(2);
    const newest = defs.at(-1)!;
    // Anchor on the whole statement, not on `view ...` — the latter drops the
    // `create or replace` the positive pair below asserts, and this test then
    // fails on its own extraction rather than on the thing it guards.
    const view = /create or replace view public_entrants_v[\s\S]*?;\s*$/m.exec(newest.sql)?.[0] ?? newest.sql;
    expect(view, `${newest.file} filters entrant status again — F10 is back`).not.toMatch(
      /status in \('registered','confirmed'\)/,
    );
    // Positive pair: it is a real definition of the view, not an empty match
    // that would satisfy the negative above by saying nothing at all.
    expect(view).toMatch(/create or replace view public_entrants_v/);
    expect(view).toMatch(/e\.status/);
    // And the visibility gate is untouched: widening status must not have
    // widened WHO is published.
    expect(view, "V412 dropped the visibility gate").toMatch(
      /c\.visibility in \('public','unlisted'\)/,
    );
  });

  it("premise: an older definition really did carry the filter", () => {
    // Guards the row above from going vacuous. If `viewDefinitions()` ever
    // stopped matching real definitions it would return whatever it liked and
    // the negative assertion would pass on an empty string; this pins that the
    // scan sees the pre-V412 world it is supposed to be describing.
    const defs = viewDefinitions();
    const older = defs.filter((d) => /status in \('registered','confirmed'\)/.test(d.sql));
    expect(older.length, "no migration in the history filtered entrant status").toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// W5 app PR A, Task 20 (X-SF-1 <- RB5-T10; ST-G20): the HUB's table (`buildTableView` -> `StandingsTableView`) carries the same
// departed chip as the division page. The header of this file records the gap: the hub "renders from a server-built
// `TableViewT` rather than raw rows" and was not covered. It is now, in three ways: the builder resolves a row's status, the
// client prints the chip, and every `buildTableView(` call site hands the builder its `statuses` (an optional input nothing
// sends is the inert seam this file exists for).
//
// Expected values: the chip's words are the owner-visible per-locale vocabulary typed here from the product copy, never read
// back from the dictionary under test; who is departed is the engine's status vocabulary (`withdrawn` / `disqualified`).
// differential: today (b6f93160a8) `buildTableView` takes no status and the hub row has no chip - every "carries the chip"
// assertion below is red on it.
// ---------------------------------------------------------------------------------------------------------------------

const HUB_LOCALES: Record<string, { dict: Dict; withdrawn: string; disqualified: string }> = {
  en: { dict: en as Dict, withdrawn: "Withdrawn", disqualified: "Disqualified" },
  es: { dict: es as Dict, withdrawn: "Retirado", disqualified: "Descalificado" },
  fr: { dict: fr as Dict, withdrawn: "Forfait", disqualified: "Disqualifié" },
  nl: { dict: nl as Dict, withdrawn: "Teruggetrokken", disqualified: "Gediskwalificeerd" },
};
const LONG_NAME = "Riverside Rovers Community Football Club 2nd";
const HUB_ROWS: StandingsRow[] = [
  { entrantId: "a", played: 2, won: 2, drawn: 0, lost: 0, points: 6, metrics: {}, rank: 1 },
  { entrantId: "b", played: 2, won: 1, drawn: 0, lost: 1, points: 3, metrics: {}, rank: 2 },
  { entrantId: "w", played: 1, won: 0, drawn: 0, lost: 1, points: 0, metrics: {}, rank: 3 },
  { entrantId: "q", played: 1, won: 0, drawn: 0, lost: 1, points: 0, metrics: {}, rank: 4 },
];
const HUB_NAMES = { a: "Harbourside", b: "Millbrook", w: LONG_NAME, q: "Cliffside United" };

function hubView(dict: Dict, statuses?: Readonly<Record<string, string>>) {
  const msg = (key: TKey, vars?: Record<string, string | number>) => t(dict, key, vars);
  return buildTableView({
    id: "t1",
    division: { id: "d1", slug: "div", name: "Div" },
    caption: "League",
    rules: null,
    dateOf: () => null,
    fullHref: "/live/o/c/div?tab=standings",
    rows: HUB_ROWS,
    metricSpecs: [],
    cascade: ["points"],
    entrantNames: HUB_NAMES,
    entrantLogos: {},
    entrantColours: {},
    championIds: [],
    updatedAt: "2026-11-18T00:00:00.000Z",
    msg,
    ...(statuses === undefined ? {} : { statuses }),
  });
}
const hubHtml = (dict: Dict, statuses?: Readonly<Record<string, string>>) =>
  renderToStaticMarkup(createElement(StandingsTableView, { view: hubView(dict, statuses), dict, testid: "mh-table-t1" }));
/** Every departed-chip element in the markup, by its per-status testid prefix (anchored on `="`). */
const chips = (html: string, status: string) => [...html.matchAll(new RegExp(`data-testid="mh-table-t1-${status}-([a-z]+)"`, "g"))].map((m) => m[1]);

describe("X-SF-1: the hub's table carries the withdrawn and disqualified chip (ST-G20)", () => {
  it("X-SF-1 a withdrawn row on the hub carries the chip (4 locales)", () => {
    // differential: today no chip
    let checked = 0;
    for (const [loc, v] of Object.entries(HUB_LOCALES)) {
      // the map is EVERY entrant's status, as the division page's `entrantStatuses` is: competing ones must not be branded
      const html = hubHtml(v.dict, { a: "confirmed", b: "registered", w: "withdrawn", q: "confirmed" });
      expect(chips(html, "withdrawn"), `${loc}: exactly the withdrawn row carries a chip`).toEqual(["w"]);
      expect(chips(html, "disqualified"), `${loc}: nobody was disqualified`).toEqual([]);
      const chip = new RegExp(`data-testid="mh-table-t1-withdrawn-w"[^>]*>[^<]*${v.withdrawn}[^<]*</span>`).exec(html)?.[0];
      expect(chip, `${loc}: the chip says ${v.withdrawn}`).toBeDefined();
      expect(chip, `${loc}: the chip wears the table's one withdrawn look`).toContain(DEPARTED_STATUS_CHIPS.withdrawn.className);
      expect(html, `${loc}: no bare dictionary key printed`).not.toContain("table.withdrawn");
      // it sits in the withdrawn entrant's own row, not another's
      const row = html.slice(html.indexOf('data-testid="mh-table-t1-row-w"'), html.indexOf('data-testid="mh-table-t1-row-q"'));
      expect(row).toContain('data-testid="mh-table-t1-withdrawn-w"');
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("X-SF-1 a disqualified row carries its own chip, never the withdrawn one (4 locales)", () => {
    // differential: today no chip
    let checked = 0;
    for (const [loc, v] of Object.entries(HUB_LOCALES)) {
      const html = hubHtml(v.dict, { w: "withdrawn", q: "disqualified" });
      expect(chips(html, "disqualified"), `${loc}: exactly the disqualified row`).toEqual(["q"]);
      expect(chips(html, "withdrawn"), `${loc}: the withdrawn one is its own`).toEqual(["w"]);
      const dq = new RegExp(`data-testid="mh-table-t1-disqualified-q"[^>]*>[^<]*${v.disqualified}[^<]*</span>`).exec(html)?.[0];
      expect(dq, `${loc}: the DQ chip says ${v.disqualified}`).toBeDefined();
      expect(dq).toContain(DEPARTED_STATUS_CHIPS.disqualified.className);
      // two different facts, two different looks (the product's own distinction: grey leaver, red removed)
      expect(DEPARTED_STATUS_CHIPS.disqualified.className).not.toBe(DEPARTED_STATUS_CHIPS.withdrawn.className);
      // the withdrawn word is never printed on the DQ row
      const row = html.slice(html.indexOf('data-testid="mh-table-t1-row-q"'));
      expect(row).not.toContain(`>${v.withdrawn}<`);
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("X-SF-1 the empty case and the absent key: no statuses, an empty map, and an all-competing map print no chip and carry no key", () => {
    const d = en as Dict;
    const none = [undefined, {}, { a: "confirmed", b: "registered", w: "confirmed", q: "checked_in" }] as const;
    for (const s of none) {
      const view = hubView(d, s);
      expect(view.rows.some((r) => "status" in r), `statuses ${JSON.stringify(s)}: a competing row carries a status key`).toBe(false);
      const html = hubHtml(d, s);
      expect(chips(html, "withdrawn")).toEqual([]);
      expect(chips(html, "disqualified")).toEqual([]);
    }
    expect(none).toHaveLength(3);
  });

  it("X-SF-1 the builder carries the status by entrant id, whatever the row order, and a status for nobody in the table is ignored", () => {
    const view = hubView(en as Dict, { q: "disqualified", w: "withdrawn", ghost: "withdrawn" });
    expect(view.rows.map((r) => [r.entrantId, (r as { status?: string }).status ?? null])).toEqual([
      ["a", null],
      ["b", null],
      ["w", "withdrawn"],
      ["q", "disqualified"],
    ]);
  });

  it("X-SF-1 a long name keeps its chip on a line of its own under the name (the 320px wrap case)", () => {
    const html = hubHtml(en as Dict, { w: "withdrawn" });
    const from = html.indexOf('data-testid="mh-table-t1-row-w"');
    const row = html.slice(from, html.indexOf("</tr>", from));
    expect(row).toContain(LONG_NAME);
    // the chip follows the name, inside the markers line (a flex-wrap row under it), not beside it in the name's own flex row
    expect(row.indexOf(LONG_NAME)).toBeLessThan(row.indexOf("mh-table-t1-withdrawn-w"));
    expect(row).toMatch(/<span class="mt-1 flex flex-wrap[^"]*"[^>]*>(?:(?!<\/th>)[\s\S])*mh-table-t1-withdrawn-w/);
  });
});

describe("X-SF-1: every buildTableView call site passes statuses (the inert-seam guard)", () => {
  /** The argument text of every `buildTableView(` CALL under src/, outside tests; the declaration is not a call. */
  function calls(): { file: string; args: string }[] {
    const out: { file: string; args: string }[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name === "__tests__" || name === "node_modules") continue;
          walk(path);
          continue;
        }
        if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) continue;
        // comments stripped: prose that names the builder is not a call
        const src = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
        for (const m of src.matchAll(/\bbuildTableView\s*\(/g)) {
          if (/function\s+$/.test(src.slice(0, m.index))) continue;
          let depth = 1;
          let i = m.index! + m[0].length;
          const start = i;
          for (; i < src.length && depth > 0; i++) {
            if (src[i] === "(") depth++;
            else if (src[i] === ")") depth--;
          }
          out.push({ file: relative(process.cwd(), path).replace(/\\/g, "/"), args: src.slice(start, i - 1) });
        }
      }
    };
    walk(join(process.cwd(), "src"));
    return out;
  }

  it("X-SF-1 every buildTableView call site passes statuses", () => {
    const sites = calls();
    // anti-vacuity: the scan sees the real call (the hub's), and a count of zero is a failure, not a pass
    expect(sites.length, "no buildTableView( call found: the scan is blind").toBeGreaterThan(0);
    expect(sites.map((s) => s.file)).toContain("src/server/public-site/competition-hub.ts");
    for (const s of sites) {
      expect(s.args, `${s.file}: buildTableView( is called without statuses - the chip would never reach this table`).toMatch(/\bstatuses\b/);
    }
  });
});
