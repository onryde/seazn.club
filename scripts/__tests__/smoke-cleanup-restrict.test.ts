// Seazn-hosted video Task 24 (the Task 23 carry): the two smoke teardowns end in `delete from organizations`, and that delete
// cascades through each org's stream sessions and their inputs. A table whose foreign key to one of those three is
// ON DELETE RESTRICT aborts the whole statement the moment a smoke run left one of its rows behind — harness.ts's own check
// then reds the run ("cleanup completes …"), and smoke-sports leaks every org of the run. So each such table must be emptied
// of the run's rows BEFORE the organizations delete, in both teardowns.
//
// The tables are read from the migrations (every `create table` whose column `references <parent>(id) on delete restrict`),
// never typed here, so a new RESTRICT table reds this until both teardowns handle it. Only inline column references are
// visible to this parse — a RESTRICT added by `alter table … add constraint` is not, which is why the count is pinned from
// below rather than claimed complete. COUNTED: zero tables or zero teardowns checked is a failure.
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const DELTAS = join(ROOT, "db/migration/deltas");
/** The rows `delete from organizations` takes with it: the org, its stream sessions, their inputs. */
const PARENTS = ["organizations", "fixture_stream_sessions", "fixture_stream_inputs"];
const TEARDOWNS = ["scripts/smoke/harness.ts", "scripts/smoke-sports.ts"] as const;
/** A RESTRICT table a teardown may skip, with the reason its run can never leave a row in it. */
const EXEMPT: Record<(typeof TEARDOWNS)[number], Record<string, string>> = {
  "scripts/smoke/harness.ts": {},
  "scripts/smoke-sports.ts": {
    // V502: an org's sponsor-invoice number sequence, written only by a sponsor deal's invoice — smoke-sports sells none.
    sponsor_invoice_counters: "smoke-sports never sells a sponsor deal",
  },
};

function restrictTables(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const file of readdirSync(DELTAS).filter((f) => /^V\d+__.*\.sql$/.test(f))) {
    const sql = readFileSync(join(DELTAS, file), "utf8");
    for (const m of sql.matchAll(/create table (?:if not exists )?(\w+)\s*\(([\s\S]*?)\n\);/gi)) {
      for (const line of m[2]!.split("\n")) {
        const ref = /references\s+(\w+)\s*\(\s*id\s*\)\s+on delete restrict/i.exec(line);
        if (ref && PARENTS.includes(ref[1]!)) out.set(m[1]!, (out.get(m[1]!) ?? new Set()).add(ref[1]!));
      }
    }
  }
  return out;
}

describe("smoke teardowns empty every ON DELETE RESTRICT child of an org before deleting the orgs", () => {
  const tables = restrictTables();

  it("the migrations name the RESTRICT tables (anti-vacuity: the Seazn ones at least)", () => {
    for (const t of ["seazn_held_alerts", "seazn_locked_videos", "fixture_video_replays", "org_video_collections"]) {
      expect(tables.has(t), `${t} is read from the migrations`).toBe(true);
    }
    expect(tables.size).toBeGreaterThanOrEqual(4);
  });

  it.each(TEARDOWNS)("%s deletes each one before `delete from organizations`", (path) => {
    const text = readFileSync(join(ROOT, path), "utf8");
    const orgsAt = text.search(/delete from organizations\b/);
    expect(orgsAt, "PREMISE: the teardown deletes the orgs").toBeGreaterThan(0);
    let checked = 0;
    const missing: string[] = [];
    for (const table of tables.keys()) {
      if (EXEMPT[path][table] !== undefined) continue;
      const at = text.search(new RegExp(`delete from\\s+${table}\\b`));
      if (at < 0 || at > orgsAt) missing.push(table);
      checked++;
    }
    expect(missing, "deleted after the orgs, or never").toEqual([]);
    expect(checked, "tables checked").toBeGreaterThanOrEqual(4);
    for (const table of Object.keys(EXEMPT[path])) expect(tables.has(table), `exemption ${table} still names a RESTRICT table`).toBe(true);
  });
});
