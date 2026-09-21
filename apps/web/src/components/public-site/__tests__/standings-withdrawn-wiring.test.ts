// A prop nothing sends is an inert seam. `withdrawnEntrantIds` is optional —
// by design, because most callers have no entrant statuses to hand — which
// means a page that silently stopped passing it would keep type-checking and
// keep rendering, with the defect back and no test red anywhere.
//
// Exactly ONE of the three `StandingsTable` call sites can carry it today, and
// this file pins which, because the other two look like oversights and are
// not. `public_entrants_v` filters `status in ('registered','confirmed')`, so
// on the public division page and the embed a withdrawn entrant never reaches
// the page at all: the chip could not render there, and — driven on the live
// page 2026-09-21 — `entrantNames` has no entry for her either, so the public
// table prints a RAW UUID in her name cell. That is F10 in the walkthrough
// findings doc, and its fix is the view, not a line in a page.
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
} as const;

/** The call sites that CANNOT mark a withdrawal yet, and why. */
const BLOCKED_BY_THE_PUBLIC_VIEW = [
  "src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/page.tsx",
  "src/app/embed/divisions/[id]/[widget]/page.tsx",
] as const;

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

describe("the withdrawn marker reaches every standings surface that can carry it", () => {
  it("premise: these are ALL the StandingsTable call sites", () => {
    // Without this row a new page could mount an unmarked table and the rows
    // below would still pass — they only check the pages they already name.
    expect(callSites().map((p) => p.replace(/\\/g, "/")).sort()).toEqual(
      [...Object.values(MARKED), ...BLOCKED_BY_THE_PUBLIC_VIEW].map((p) => p.replace(/\\/g, "/")).sort(),
    );
  });

  for (const [label, rel] of Object.entries(MARKED)) {
    it(`${label} derives the withdrawn ids and passes them to the table`, () => {
      const src = readFileSync(join(process.cwd(), rel), "utf8");
      // The derivation: read off the entrant's own status, not a hardcoded list.
      expect(src, `${label} never derives withdrawnEntrantIds`).toMatch(
        /withdrawnEntrantIds\s*=\s*entrants[\s\S]{0,160}status === "withdrawn"/,
      );
      // And it is actually handed to the table, in the JSX.
      expect(src, `${label} derives the ids but does not pass them`).toContain(
        "withdrawnEntrantIds={withdrawnEntrantIds}",
      );
    });
  }

  it("premise for the two that are blocked: the public view really does filter them out", () => {
    // The reason the public page and the embed pass nothing is a SQL fact, not
    // a preference. If the view is ever widened, this row reds and the two
    // pages above become ordinary wiring work — which is exactly the reminder
    // the next reader needs. The newest definition wins; older migrations
    // carry the same clause.
    const migrations = [
      "../../db/migration/deltas/V350__person_tombstone_views.sql",
      "../../db/migration/deltas/V306__entitlement_resolver_parity.sql",
    ].map((rel) => readFileSync(join(process.cwd(), rel), "utf8"));
    const definesView = migrations.filter((sql) => /view public_entrants_v/.test(sql));
    expect(definesView.length, "public_entrants_v is no longer defined where this test looks").toBe(2);
    for (const sql of definesView) {
      const view = /view public_entrants_v[\s\S]*?;/.exec(sql)![0];
      expect(view, "public_entrants_v no longer filters entrant status").toMatch(
        /status in \('registered','confirmed'\)/,
      );
    }
  });
});
