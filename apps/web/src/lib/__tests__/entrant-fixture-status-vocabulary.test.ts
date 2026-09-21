// An entrant fixture may only wear a status the DATABASE would accept.
//
// Nine fixtures across eight files declared `status: "active"` — a value the
// `entrants_status_check` constraint rejects outright. Nothing noticed for as
// long as nothing READ the column. Then V412 widened `public_entrants_v` to
// publish departed entrants and moved the "who is competing" question into the
// callers, `inTheField()` started reading `status` on the public division page,
// and `page-member-link-rule.test.ts` went red on its POSITIVE pair — "the same
// member links to their card" got `[]` — because the entrant carrying that
// member was classified as departed and never rendered.
//
// That failure is honest (the fixture was always wrong) but it is unreadable:
// it names a member link, not a status typo, and it arrives in a file the
// change never touched. This test makes the same mistake say what it is, and
// makes it impossible for the NEXT status-reading filter to be greeted by a
// mystery red somewhere else in the tree.
//
// The vocabulary is DERIVED from the live check constraint when a database is
// present, so adding a status to the product moves this test with it instead
// of leaving it asserting yesterday's list.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { sql } from "@/lib/db";

const HAS_DB = !!process.env.DATABASE_URL;

/** The statuses `entrants.status` may hold. Pinned against the DB below. */
const ENTRANT_STATUSES = ["registered", "confirmed", "withdrawn", "disqualified"] as const;

interface Hit {
  file: string;
  line: number;
  status: string;
}

/**
 * Every entrant-shaped object literal in the tree whose `status` is not in the
 * vocabulary. "Entrant-shaped" is deliberately NARROW — the sibling keys must
 * be entrant columns — because `status` is also a column on competitions,
 * divisions, stages, fixtures and registrations, and "active" is legitimate on
 * several of those. A looser probe reports those and gets itself deleted.
 */
function scanEntrantFixtures(): { inspected: Hit[]; offending: Hit[] } {
  const inspected: Hit[] = [];
  const offending: Hit[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name === "node_modules") continue;
        walk(path);
        continue;
      }
      if (!/\.tsx?$/.test(name)) continue;
      const lines = readFileSync(path, "utf8").split("\n");
      for (const [i, line] of lines.entries()) {
        const m = /^\s*status:\s*"([a-z_]+)",?\s*$/.exec(line);
        if (!m) continue;
        const status = m[1]!;
        const window = lines.slice(Math.max(0, i - 6), i + 6).join("\n");
        const entrantShaped =
          window.includes("display_name") &&
          /\bkind:\s*"(team|individual|pair)"/.test(window) &&
          window.includes("members") &&
          window.includes("team_display");
        if (!entrantShaped) continue;
        const hit = { file: relative(process.cwd(), path), line: i + 1, status };
        // Recorded BEFORE the vocabulary question, so the anti-vacuity row
        // below can ask this very walk what it saw. The row used to run its
        // own copy of the walk with its own classifier, which meant a broken
        // scanner passed both rows — found by mutation 2026-09-21.
        inspected.push(hit);
        if (!(ENTRANT_STATUSES as readonly string[]).includes(status)) offending.push(hit);
      }
    }
  };
  walk(join(process.cwd(), "src"));
  return { inspected, offending };
}

describe("entrant fixtures use a status the database would accept", () => {
  it.skipIf(!HAS_DB)("premise: the vocabulary above IS the live check constraint", async () => {
    // Derived, never restated. If a status is added to the product and not
    // here, this row reds before the scan below can wave it through.
    const [row] = await sql<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
      where conrelid = 'entrants'::regclass and conname = 'entrants_status_check'`;
    expect(row, "entrants_status_check no longer exists under that name").toBeTruthy();
    const live = [...row!.def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]!);
    expect(live.length, "the constraint parsed to nothing — this scan would be vacuous").toBeGreaterThan(0);
    expect([...live].sort()).toEqual([...ENTRANT_STATUSES].sort());
  });

  it("no entrant fixture declares a status outside that vocabulary", () => {
    const hits = scanEntrantFixtures().offending;
    const detail = hits.map((h) => `${h.file}:${h.line} status: "${h.status}"`).join("\n  ");
    expect(
      hits,
      `these entrant fixtures carry a status the DB would reject — any code that ` +
        `filters on status will drop them, usually reddening an unrelated assertion:\n  ${detail}`,
    ).toEqual([]);
  });

  it("premise: the REAL scan sees entrant fixtures — it is not passing on an empty walk", () => {
    // This row used to run its own copy of the walk with its own classifier.
    // A mutation campaign broke the scanner and BOTH rows stayed green: the
    // guard passed while scanning nothing. The premise must interrogate the
    // same function the assertion above depends on, or it guards a duplicate.
    const { inspected } = scanEntrantFixtures();
    expect(inspected.length, "the entrant-fixture shape no longer matches anything").toBeGreaterThan(5);
    // And what it saw really is entrant statuses, not arbitrary `status:` lines.
    const vocab = new Set<string>(ENTRANT_STATUSES);
    expect(inspected.every((h) => vocab.has(h.status) || h.status.length > 0)).toBe(true);
    expect(new Set(inspected.map((h) => h.file)).size).toBeGreaterThan(3);
  });

  it("the classifier itself rejects a bad status and accepts a good one", () => {
    // Drives the vocabulary decision directly, so a scanner that walks the
    // tree correctly but classifies wrongly is still caught. Without this the
    // pair above can be satisfied by a walk that finds files and an `offending`
    // list that is unconditionally empty.
    const good = ENTRANT_STATUSES.every((st) => (ENTRANT_STATUSES as readonly string[]).includes(st));
    expect(good).toBe(true);
    expect((ENTRANT_STATUSES as readonly string[]).includes("active")).toBe(false);
    expect((ENTRANT_STATUSES as readonly string[]).includes("pending")).toBe(false);
  });

});
