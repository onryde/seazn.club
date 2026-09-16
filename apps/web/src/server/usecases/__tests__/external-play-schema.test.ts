// apps/web/src/server/usecases/__tests__/external-play-schema.test.ts
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";

describe.skipIf(!process.env.DATABASE_URL)("external play schema (V405/V407)", () => {
  afterAll(async () => {
    await sql.end();
  });

  async function columns(table: string): Promise<string[]> {
    const rows = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_name = ${table} order by column_name`;
    return rows.map((r) => r.column_name);
  }

  it("user_external_accounts stores identity only — no token columns", async () => {
    expect(await columns("user_external_accounts")).toEqual(
      ["created_at", "external_user_id", "id", "provider", "updated_at", "user_id", "username"],
    );
  });

  it("fixture_external_play has exactly the spec §7.2 columns", async () => {
    expect(await columns("fixture_external_play")).toEqual([
      "black_emailed_at", "black_lichess_id", "challenge_id", "created_at", "expires_at",
      "finished_at", "fixture_id", "last_error", "last_polled_at", "mint_claimed_at",
      "needs_reason", "org_id", "provider", "scheduled_at_basis", "started_at", "status",
      "updated_at", "url_black", "url_white", "white_emailed_at", "white_lichess_id", "white_side",
    ]);
  });

  it("rejects a needs_reason outside the vocabulary", async () => {
    // Two CHECKs reference needs_reason: this vocabulary one and the table-level
    // `(status = 'needs_organiser') = (needs_reason is not null)` coupling. An
    // unordered `[c]` picks whichever the catalog returns first (the coupling,
    // on PG17), so pin the column constraint by its generated name.
    const rows = await sql<{ check_clause: string }[]>`
      select cc.check_clause from information_schema.check_constraints cc
        join information_schema.constraint_column_usage u using (constraint_name)
       where u.table_name = 'fixture_external_play' and u.column_name = 'needs_reason'
         and u.constraint_name = 'fixture_external_play_needs_reason_check'`;
    expect(rows).toHaveLength(1);
    const [c] = rows;
    for (const r of ["no_show_white", "no_show_black", "no_show_both", "not_started", "aborted", "mismatch", "provider_error"]) {
      expect(c.check_clause).toContain(`'${r}'`);
    }
    expect(c.check_clause).not.toContain("no_show_grace_elapsed");
  });
});
