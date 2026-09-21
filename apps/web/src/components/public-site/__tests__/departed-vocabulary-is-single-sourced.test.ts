// The departed vocabulary — which `entrants.status` values mean "no longer in
// the field" — is spelled in TWO PINNED places, and they must agree:
//
//   - `DEPARTED_STATUSES` (server/usecases/entrants.ts) — the PREDICATE half.
//     Who has left. Used to decide who a ladder <select> must not offer and
//     who a bracket must not seed.
//   - `DEPARTED_STATUS_CHIPS` (components/public-site/standings-table.tsx) —
//     the PRESENTATION half. What word and colour a departed row wears.
//
// Two halves is the right shape: one is a server predicate, the other is a
// localised chip with a className, and collapsing them would drag Tailwind
// classes into a usecase. What is NOT acceptable is the two drifting, because
// that is the C1 defect exactly: the pair was spelled out per-surface, each
// surface got half of it, and a DISQUALIFIED entrant sat in the public
// standings ranked among the competing and marked as nothing at all.
//
// `standings-withdrawn-wiring.test.ts` stops a PAGE restating the vocabulary.
// This file stops the two legitimate homes disagreeing. Neither test can see
// the other's failure, which is why both exist.
//
// Both sides are read from their real modules — never a pair typed into this
// file. A list here would be a third home for the vocabulary and would go
// stale in precisely the way the whole arrangement exists to prevent.
//
// WHAT THIS FILE DOES NOT PIN, said plainly so the next reader is not misled
// by the two paragraphs above. "Two places" is the count of homes this file
// HOLDS TO THE SCHEMA, not the count of places the pair is written down. It is
// still spelled out literally at least here:
//
//   - SQL, as the live complement `status not in ('withdrawn','disqualified')`
//     — `server/usecases/schedule-ai.ts` and `server/usecases/divisions.ts`;
//     and as the departed set itself, `status in ('withdrawn','disqualified')`
//     — `server/usecases/officials.ts`;
//   - TS — `components/v2/entrants-panel.tsx` (the row's own
//     `withdrawn || disqualified`), and both schedule pages:
//     `app/o/[orgSlug]/c/[compSlug]/schedule/page.tsx` and its division
//     sibling `.../d/[divSlug]/schedule/page.tsx`;
//   - a wire enum listing all four statuses — `server/api-v1/schemas.ts`'s
//     `EntrantStatus`, which is a CONTRACT and legitimately its own list.
//
// So the residual risk is real and is named rather than hidden: add a fifth
// status to V212 and this file reds, someone adds it to `DEPARTED_STATUSES`
// and to the chips, and every site above still silently treats it as live.
// Closing that means repointing four usecases, two pages and a component at
// `DEPARTED_STATUSES` — production changes across unrelated modules, each
// owing its own test, which is a different wave from this one. Recorded here
// so choosing it later is a decision rather than a discovery.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEPARTED_STATUS_CHIPS } from "../standings-table";
import { DEPARTED_STATUSES } from "@/server/usecases/entrants";

/** Resolved from THIS FILE, never `process.cwd()`: vitest is normally invoked
 *  from `apps/web`, but a run from the repo root (or from a worktree script
 *  that forgot to `cd`) then threw ENOENT here rather than failing an
 *  assertion. Same idiom as `lib/__tests__/e2e-ci-wiring.test.ts`. */
const WEB = resolve(import.meta.dirname, "../../../.."); // apps/web
const MIGRATIONS = resolve(WEB, "../../db/migration");
/** `entrants.status`'s only definition site — the table's own check constraint. */
const ENTRANTS_TABLE = join(MIGRATIONS, "v2-engine/tables/V212__entrants.sql");
/** `entrants.ts` spells the house live predicate in SQL as well as exporting
 *  `DEPARTED_STATUSES`. The two are complements of each other, so reading the
 *  QUERY TEXT gives this file a second authority without typing a pair into
 *  it — which the header above promises and a literal here would break. It
 *  also cross-checks that module's own two halves: edit the export without
 *  the query, or the query without the export, and the complement below reds.
 */
const ENTRANTS_USECASE = resolve(WEB, "src/server/usecases/entrants.ts");
function liveStatuses(): string[] {
  const src = readFileSync(ENTRANTS_USECASE, "utf8");
  const m = /status\s+in\s*\(([^)]*)\)/i.exec(src);
  if (!m) throw new Error(`no live-status SQL predicate in ${ENTRANTS_USECASE}`);
  const found = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]!);
  if (found.length === 0) throw new Error(`the live-status predicate names nobody`);
  return found;
}
const LIVE_STATUSES = liveStatuses();

/** Every `.sql` under db/migration, at any depth. */
function migrationFiles(dir = MIGRATIONS): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory()
      ? migrationFiles(path)
      : name.endsWith(".sql")
        ? [path]
        : [];
  });
}

/** The statuses `entrants.status` is allowed to hold, read from the constraint. */
function schemaStatuses(): string[] {
  const sql = readFileSync(ENTRANTS_TABLE, "utf8");
  const m = /check\s*\(\s*status\s+in\s*\(([^)]*)\)/i.exec(sql);
  if (!m) throw new Error(`no status check constraint in ${ENTRANTS_TABLE}`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

describe("the departed vocabulary has one meaning on both sides", () => {
  // Stated FIRST, because every membership assertion below is vacuously true
  // of an empty set: if both sides were emptied, "they agree" would still
  // pass and no departed entrant would be marked anywhere.
  it("premise: the vocabulary is not empty on either side", () => {
    expect(DEPARTED_STATUSES.size, "the server predicate names nobody as departed").toBeGreaterThan(
      0,
    );
    expect(
      Object.keys(DEPARTED_STATUS_CHIPS).length,
      "the table has no chip for any departed status",
    ).toBeGreaterThan(0);
  });

  it("every status the server calls departed has a chip to wear", () => {
    const chipped = new Set(Object.keys(DEPARTED_STATUS_CHIPS));
    const unchipped = [...DEPARTED_STATUSES].filter((s) => !chipped.has(s));
    expect(
      unchipped,
      "these statuses are filtered out of pickers and seedings but render unmarked in the standings",
    ).toEqual([]);
  });

  it("every chip the table can print is a status the server calls departed", () => {
    const orphan = Object.keys(DEPARTED_STATUS_CHIPS).filter((s) => !DEPARTED_STATUSES.has(s));
    expect(
      orphan,
      "the table would mark these as departed while the server still offers them as live entrants",
    ).toEqual([]);
  });
});

// The rows above only prove the two halves AGREE. Emptying both, or narrowing
// both to `withdrawn`, satisfies every one of them — and narrowing to
// `withdrawn` is a defect that has actually shipped here: an organiser's PATCH
// to `disqualified` is the OTHER writer of `entrants.status`, and a mutation
// that dropped it from the page's derivation went green across the suite.
//
// So the set is pinned to the SCHEMA, not to a pair typed into this file. A
// status the database permits, that is not one of the two "still competing"
// values, is by definition a departure — there is no third category. Add a
// status to the check constraint and this reds until someone decides which
// side it falls on, which is the decision being forced.
describe("the departed set is the schema's own complement, not a chosen pair", () => {
  it("premise: the constraint still parses and still names the live statuses", () => {
    const all = schemaStatuses();
    expect(all.length, "V212's status check constraint no longer parses").toBeGreaterThan(
      LIVE_STATUSES.length,
    );
    for (const live of LIVE_STATUSES) {
      expect(all, `'${live}' is no longer an allowed entrants.status`).toContain(live);
    }
  });

  it("DEPARTED_STATUSES is exactly the statuses that are not 'still competing'", () => {
    const expected = schemaStatuses().filter((s) => !LIVE_STATUSES.includes(s));
    expect([...DEPARTED_STATUSES].sort(), "the departed set has drifted from the schema").toEqual(
      expected.sort(),
    );
  });

  it("premise: V212 is the ONLY migration that defines entrants.status", () => {
    // Derived, because the assertion above reads one file: if a later delta
    // ever ALTERs this constraint, that file becomes the source of truth and
    // the test above silently pins yesterday's list.
    // Per STATEMENT, not per 400 characters of file, and with no schema
    // qualifier in the anchor: the old scan could see neither
    // `alter table public.entrants`, nor a later `create table entrants`, nor
    // a `status` clause further than 400 chars into a long statement — three
    // ways for a redefinition to slip past the assertion above.
    const definesStatus = (sql: string): boolean =>
      sql
        .split(";")
        .some(
          (stmt) =>
            /\b(alter|create)\s+table\s+(if\s+not\s+exists\s+|only\s+)*(?:"?public"?\.)?"?entrants"?\b/i.test(
              stmt,
            ) && /\bstatus\b/i.test(stmt),
        );
    const altered = migrationFiles()
      .filter((f) => f !== ENTRANTS_TABLE)
      .filter((f) => definesStatus(readFileSync(f, "utf8")));
    expect(
      altered.map((f) => f.split("db/migration/")[1]),
      "a migration alters entrants.status — re-point schemaStatuses() at the newest definition",
    ).toEqual([]);
  });
});
