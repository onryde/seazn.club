// V392 pin test — pins the LIVE `plan_entitlements` matrix against the
// design doc's own §2 markdown table, never a table typed into this file:
//
//   docs/superpowers/specs/2026-09-02-entitlements-v18-three-tier-design.md
//
// A typed table drifts from the migration silently; parsing the doc means a
// spec edit moves this test with it. Sibling precedent for a test reading a
// repo doc as its own oracle: src/lib/__tests__/help-copy-truth.test.ts
// against content/help/**.
//
// Resolver semantics this test is written against (see
// docs/superpowers/plans/2026-09-03-entitlements-w2-matrix-plumbing.md and
// AGENTS.md): for an int key only `int_value` is read (`getLimit`,
// entitlements.ts:613 — `const base = row ? row.int_value : 0`), so
// `int_value = NULL` means unlimited and NO ROW resolves to 0 (deny). A
// bool key requires `bool_value === true` exactly (`hasFeature`,
// entitlements.ts:459-460); NULL or no row denies. This test therefore
// checks int_value for int keys and bool_value for bool keys, and leaves
// any stray opposite-type value on the same row alone (the migration does
// too — see V392's header comment).
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "@/lib/db";
import { betterInt } from "@/lib/pass-vs-plan";

const HAS_DB = !!process.env.DATABASE_URL;

/**
 * The repository root, found by climbing from cwd until a directory
 * contains both `apps/web` and `package.json` — never by counting `..`
 * segments, which breaks depending on whether vitest is invoked from the
 * repo root or from `apps/web` (see the identical rationale in
 * `src/lib/__tests__/_help-copy.ts`, `repoRoot()`). Duplicated here rather
 * than imported because that helper is unexported and this task's brief is
 * scoped to a single new test file.
 */
function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, "apps", "web")) && existsSync(join(dir, "package.json"))) return dir;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `cannot locate the repo root from ${process.cwd()} — run tests from apps/web (or via \`npm test --workspace apps/web\`)`,
  );
}

const DESIGN_DOC_RELATIVE = "docs/superpowers/specs/2026-09-02-entitlements-v18-three-tier-design.md";

function designDocText(): string {
  const path = join(repoRoot(), DESIGN_DOC_RELATIVE);
  if (!existsSync(path)) {
    throw new Error(`design doc not found at ${path} — the pin test has nothing to parse`);
  }
  return readFileSync(path, "utf8");
}

// Doc column order -> plan_entitlements.plan_key.
const COLUMN_PLAN_KEYS = ["community", "pro", "event_pass", "event_pass_l", "enterprise"] as const;
type PlanKey = (typeof COLUMN_PLAN_KEYS)[number];

type Cell =
  | { kind: "bool"; value: boolean }
  | { kind: "int"; value: number | null }
  | { kind: "no_row" };

type MatrixRow =
  | { key: string; deleted: true }
  | { key: string; deleted: false; cells: Record<PlanKey, Cell> };

const EN_DASH = "–"; // "–" — no row for this plan (falls through)
const EM_DASH = "—"; // "—" — every cell em-dash together means "delete key"
const INFINITY = "∞"; // "∞" — int null (unlimited)

/** Strips `**bold**` markers and surrounding whitespace from one table cell. */
function stripCell(raw: string): string {
  return raw.trim().replace(/\*\*/g, "").trim();
}

/**
 * Parses one already-stripped table cell into a typed value. `+1` is the
 * `competitions.max_active` pass-column annotation — per the migration
 * brief (V392 header, and
 * docs/superpowers/plans/2026-09-03-entitlements-w2-matrix-plumbing.md) it
 * is deliberately backed by NO row (the effect is an exclusion in
 * `assertActiveQuota`, not an additive int), so it parses the same as a
 * bare no-row dash. The one genuinely irregular value cell in the whole
 * table — `ai.credits.monthly`'s Ent cell, `**500** (staff override per
 * deal)` — is handled by the general "extract the leading integer" rule
 * below, so no per-cell special case is needed for it.
 */
function parseCell(stripped: string): Cell {
  if (stripped === EN_DASH || stripped === "+1") return { kind: "no_row" };
  if (stripped === "T") return { kind: "bool", value: true };
  if (stripped === "F") return { kind: "bool", value: false };
  if (stripped === INFINITY) return { kind: "int", value: null };
  const m = /^-?\d+/.exec(stripped);
  if (m) return { kind: "int", value: Number(m[0]) };
  throw new Error(`unparseable §2 cell: ${JSON.stringify(stripped)}`);
}

/**
 * Parses every feature-key row out of design doc §2 ("The full matrix —
 * every key, reviewed"), across all of its subsection tables (### Scale,
 * ### Money, ### Formats & standings, ...), stopping at the next `## `
 * (level-2) heading. Skips the header/separator rows of each markdown
 * table and the one non-key row at the end of §2 ("pass credit grant
 * (constant, not a key)", which carries no leading backtick-quoted key and
 * is explicitly not a feature key per the design doc's own parenthetical).
 */
function parseMatrixSection(doc: string): MatrixRow[] {
  const startMatch = /^## 2\..*$/m.exec(doc);
  if (!startMatch) {
    throw new Error(
      "design doc §2 heading ('## 2. ...') not found — the pin test cannot locate the matrix to parse",
    );
  }
  const rest = doc.slice(startMatch.index + startMatch[0].length);
  const endMatch = /^## \d+\./m.exec(rest);
  const section = endMatch ? rest.slice(0, endMatch.index) : rest;

  const rows: MatrixRow[] = [];
  for (const raw of section.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("|") || !line.endsWith("|")) continue;
    const cells = line
      .slice(1, -1)
      .split("|")
      .map((c) => c.trim());
    if (cells.length < 7) continue; // key + 5 plan columns + why
    const firstStripped = stripCell(cells[0]!);
    if (firstStripped.toLowerCase() === "key") continue; // header row
    if (/^:?-+:?$/.test(firstStripped)) continue; // separator row
    const keyMatch = /^`([^`]+)`/.exec(cells[0]!.trim());
    if (!keyMatch) continue; // the "pass credit grant (constant, not a key)" row
    const key = keyMatch[1]!;

    const rawPlanCells = cells.slice(1, 6).map(stripCell);
    if (rawPlanCells.every((c) => c === EM_DASH)) {
      rows.push({ key, deleted: true });
      continue;
    }
    const parsed = rawPlanCells.map(parseCell);
    const cellsByPlan = Object.fromEntries(
      COLUMN_PLAN_KEYS.map((plan, i) => [plan, parsed[i]!]),
    ) as Record<PlanKey, Cell>;
    rows.push({ key, deleted: false, cells: cellsByPlan });
  }
  return rows;
}

const PARSED = parseMatrixSection(designDocText());

// Anti-vacuity floors: a parser that silently matches nothing (a header
// regex that stops matching after a doc edit, a table syntax change) must
// not pass. §2 carries 60 feature-key rows at the time this test was
// written (61 table rows minus the one non-key "pass credit grant" row);
// 45 is a floor with real slack, not a pin of the exact count.
describe.skipIf(!HAS_DB)("V392 entitlements v18 matrix — pinned against design doc §2", () => {
  it("parsed a non-trivial matrix out of the design doc (anti-vacuity floor)", () => {
    expect(PARSED.length).toBeGreaterThanOrEqual(45);
  });

  it("parsed rows for every one of the five plan columns", () => {
    const live = PARSED.filter((r): r is Extract<MatrixRow, { deleted: false }> => !r.deleted);
    expect(live.length).toBeGreaterThan(0);
    for (const plan of COLUMN_PLAN_KEYS) {
      const withRow = live.filter((r) => r.cells[plan].kind !== "no_row");
      // Every plan column carries at least one determinate (non-dash)
      // value somewhere in the matrix — if a column parsed as entirely
      // "no row" the column index mapping itself would be silently wrong.
      expect(withRow.length, `no determinate cell parsed for plan column "${plan}"`).toBeGreaterThan(0);
    }
  });

  it("every live matrix cell matches the seeded plan_entitlements row", async () => {
    const liveRows = PARSED.filter((r): r is Extract<MatrixRow, { deleted: false }> => !r.deleted);
    // The whole table, not a WHERE ... = ANY(${array}) filter: this repo has
    // no precedent for binding a JS array through postgres.js's tagged
    // template into an `any()` filter, and the table is small (~260 rows
    // total across five plans) — fetching it all and matching in JS avoids
    // betting the test's correctness on an unverified binding shape.
    const dbRows = await sql<{ plan_key: string; feature_key: string; bool_value: boolean | null; int_value: number | null }[]>`
      select plan_key, feature_key, bool_value, int_value from plan_entitlements`;
    const byKey = new Map<string, Map<string, { bool_value: boolean | null; int_value: number | null }>>();
    for (const row of dbRows) {
      if (!byKey.has(row.feature_key)) byKey.set(row.feature_key, new Map());
      byKey.get(row.feature_key)!.set(row.plan_key, row);
    }

    const PASS_PLANS = new Set(["event_pass", "event_pass_l"]);
    const failures: string[] = [];
    for (const { key, cells } of liveRows) {
      const communityRow = byKey.get(key)?.get("community");
      for (const plan of COLUMN_PLAN_KEYS) {
        const cell = cells[plan];
        const dbRow = byKey.get(key)?.get(plan);

        if (cell.kind === "no_row") {
          // "–" is a claim about the RAW row (an org-level int a pass can
          // never lift, per the design doc's own background section) —
          // pin literally on every plan, pass columns included.
          if (dbRow) failures.push(`${key}/${plan}: expected NO ROW, found ${JSON.stringify(dbRow)}`);
          continue;
        }

        if (PASS_PLANS.has(plan)) {
          // resolveFromDb (entitlements.ts) never reads a pass plan's row
          // in isolation: "keys missing from the pass matrix fall through
          // to the plan row" (entitlements.ts:344-348), and where a pass
          // row DOES exist, a bool can only GRANT on top of the org's own
          // plan and an int is `betterInt` of the two. So §2's Pass M /
          // Pass L columns pin the org's EFFECTIVE resolved value for a
          // community-plan org holding that pass — never raw pass-row
          // existence, which several already-true-on-Free keys correctly
          // have no row for at all (verified against the live matrix: e.g.
          // `discovery.listed` has never carried an event_pass row and
          // still reads T for a pass holder, because community already
          // does).
          if (cell.kind === "bool") {
            const effective = dbRow?.bool_value === true || communityRow?.bool_value === true;
            const expected = cell.value;
            if (effective !== expected) {
              failures.push(
                `${key}/${plan}: expected EFFECTIVE bool=${expected} (pass row ?? community fallthrough), got ${effective} — pass row=${JSON.stringify(dbRow ?? null)}, community row=${JSON.stringify(communityRow ?? null)}`,
              );
            }
            continue;
          }
          const effective = dbRow
            ? communityRow
              ? betterInt(key, dbRow.int_value, communityRow.int_value)
              : dbRow.int_value
            : (communityRow?.int_value ?? null);
          if (effective !== cell.value) {
            failures.push(
              `${key}/${plan}: expected EFFECTIVE int=${cell.value} (betterInt(pass, community) fallthrough), got ${effective} — pass row=${JSON.stringify(dbRow ?? null)}, community row=${JSON.stringify(communityRow ?? null)}`,
            );
          }
          continue;
        }

        // community / pro / enterprise resolve directly from their OWN
        // row — no overlay, no fallthrough.
        if (!dbRow) {
          failures.push(`${key}/${plan}: expected ${JSON.stringify(cell)}, found NO ROW`);
          continue;
        }
        if (cell.kind === "bool" && dbRow.bool_value !== cell.value) {
          failures.push(`${key}/${plan}: expected bool_value=${cell.value}, found ${dbRow.bool_value}`);
        }
        if (cell.kind === "int" && dbRow.int_value !== cell.value) {
          failures.push(`${key}/${plan}: expected int_value=${cell.value}, found ${dbRow.int_value}`);
        }
      }
    }
    expect(failures, `mismatches against §2 (asserted ${liveRows.length} keys × 5 plans):\n${failures.join("\n")}`).toEqual([]);
  });

  it("deleted keys are absent from plan_entitlements on every plan, including enterprise", async () => {
    const deletedRows = PARSED.filter((r): r is Extract<MatrixRow, { deleted: true }> => r.deleted);
    expect(deletedRows.length).toBeGreaterThanOrEqual(4);
    const deletedKeys = new Set(deletedRows.map((r) => r.key));
    const rows = await sql<{ plan_key: string; feature_key: string }[]>`
      select plan_key, feature_key from plan_entitlements`;
    const survivors = rows.filter((r) => deletedKeys.has(r.feature_key));
    expect(survivors, `these §2 "delete key" rows still have plan_entitlements rows: ${JSON.stringify(survivors)}`).toEqual([]);
  });

  it("pro_plus is gone from plan_entitlements and from plans", async () => {
    const [entitlementRows, planRows] = await Promise.all([
      sql<{ n: number }[]>`select count(*)::int as n from plan_entitlements where plan_key = 'pro_plus'`,
      sql<{ n: number }[]>`select count(*)::int as n from plans where key = 'pro_plus'`,
    ]);
    expect(entitlementRows[0]!.n).toBe(0);
    expect(planRows[0]!.n).toBe(0);
  });

  it("the enterprise plan exists and is non-public", async () => {
    const rows = await sql<{ key: string; is_public: boolean }[]>`
      select key, is_public from plans where key = 'enterprise'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.is_public).toBe(false);
  });
});
