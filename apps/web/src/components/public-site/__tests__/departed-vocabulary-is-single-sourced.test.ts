// The departed vocabulary — which `entrants.status` values mean "no longer in
// the field" — is spelled in exactly TWO places, and they must agree:
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
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEPARTED_STATUS_CHIPS } from "../standings-table";
import { DEPARTED_STATUSES } from "@/server/usecases/entrants";

const MIGRATIONS = join(process.cwd(), "../../db/migration");
/** `entrants.status`'s only definition site — the table's own check constraint. */
const ENTRANTS_TABLE = join(MIGRATIONS, "v2-engine/tables/V212__entrants.sql");
/** The house "still in the field" predicate, spelled in SQL across the server. */
const LIVE_STATUSES = ["registered", "confirmed"];

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
    const altered = migrationFiles()
      .filter((f) => f !== ENTRANTS_TABLE)
      .filter((f) => /alter\s+table\s+(only\s+)?entrants\b[\s\S]{0,400}?status/i.test(readFileSync(f, "utf8")));
    expect(
      altered.map((f) => f.split("db/migration/")[1]),
      "a migration alters entrants.status — re-point schemaStatuses() at the newest definition",
    ).toEqual([]);
  });
});
