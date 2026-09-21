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
// Also NOT covered: `StandingsTableView` (the competition hub's own table,
// `matches-hub/{table,overview}-tab.tsx`). It renders from a server-built
// `TableViewT` rather than raw rows. The premise row below counts only bare
// `<StandingsTable` mounts, so adding a new one of those still reds.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const MARKED = {
  "organiser console division page":
    "src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx",
  "public division page":
    "src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/page.tsx",
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
