// Regression + drift guard for scripts/sync-sports.ts's prune step (#431
// ruling 3). Before this fix, dropping an engine-declared variant (e.g.
// cricket's `pairs-6-a-side`) left its `sport_variants` row in the DB
// forever — `syncSports` only ever upserted, never deleted a row the engine
// stopped declaring. Real Postgres; skipped without DATABASE_URL (same
// convention as apps/web's DB-backed suites, e.g. division-settings.test.ts).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { cricket } from "@seazn/engine/sports/cricket";
import { builtinModules } from "@seazn/engine/sports";
import { syncSports } from "../sync-sports.ts";

const url = process.env.DATABASE_URL;
const HAS_DB = !!url;
const isLocal = url ? /@(localhost|127\.0\.0\.1)[:/]/.test(url) : false;
const sql = HAS_DB
  ? postgres(url as string, {
      connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
      ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
      max: 1,
    })
  : null;

describe.skipIf(!HAS_DB)("syncSports — prune step (#431 ruling 3)", () => {
  it("removes a system variant the engine no longer declares, leaves current ones alone", async () => {
    const s = sql!;
    await syncSports(s); // establish the current catalog (sports.cricket + its live variants)

    // Simulate the world BEFORE #431 ruling 3: a stale system row for the
    // preset the engine has since dropped. sync-sports.ts used to have no
    // prune step, so a row exactly like this survived every run forever.
    expect(cricket.variants).not.toHaveProperty("pairs-6-a-side");
    await s`
      insert into sport_variants (sport_key, key, name, config, is_system, org_id)
      values ('cricket', 'pairs-6-a-side', 'Pairs 6 A Side',
              ${s.json({ playersPerSide: 6, ballsPerInnings: 60, maxOversPerBowler: 2 })},
              true, null)
      on conflict on constraint sport_variants_pkey do update set is_system = true, org_id = null
    `;
    const [before] = await s`
      select 1 from sport_variants where sport_key = 'cricket' and key = 'pairs-6-a-side'`;
    expect(before).toBeDefined();

    const result = await syncSports(s);
    expect(result.prunedCount).toBeGreaterThanOrEqual(1);

    const [after] = await s`
      select 1 from sport_variants where sport_key = 'cricket' and key = 'pairs-6-a-side'`;
    expect(after).toBeUndefined();

    // A real, still-declared variant is untouched by the same run.
    const [t20] = await s`
      select 1 from sport_variants where sport_key = 'cricket' and key = 't20'`;
    expect(t20).toBeDefined();
  });

  it("never prunes an org-authored variant, even one the engine has no matching key for", async () => {
    const s = sql!;
    await syncSports(s);
    const suffix = randomUUID().slice(0, 8);
    const [{ id: userId }] = await s<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${`sync-sports-${suffix}@test.local`}, 'Sync Sports', true)
      returning id`;
    const [{ id: orgId }] = await s<{ id: string }[]>`
      insert into organizations (name, slug, created_by)
      values (${"Sync Sports Org " + suffix}, ${"sync-sports-" + suffix}, ${userId})
      returning id`;
    const orgKey = `org-only-${suffix}`;
    await s`
      insert into sport_variants (sport_key, key, name, config, is_system, org_id)
      values ('cricket', ${orgKey}, 'Org Only', ${s.json({})}, false, ${orgId})
    `;

    await syncSports(s);

    const [row] = await s`
      select 1 from sport_variants where sport_key = 'cricket' and key = ${orgKey}`;
    expect(row).toBeDefined();
  });

  it("every sport's catalog name is the en dictionary's word for it (case aside) — chess is 'Chess' in both", async () => {
    // Two sources spell the same English word: `sports.name` (this script's SPORT_NAMES, what the API and the catalog
    // read) and `sport.<key>` in ui.json (what every page renders). The 2026-10-19 rename of chess from "Board game"
    // touched both on purpose; this keeps a later one from touching only one. Case aside because the catalog title-cases
    // "Table Tennis" where the UI sentence-cases "Table tennis".
    const s = sql!;
    await syncSports(s);
    const dict = JSON.parse(
      readFileSync(new URL("../../apps/web/src/dictionaries/en/ui.json", import.meta.url), "utf8"),
    ) as Record<string, string>;
    const rows = await s<{ key: string; name: string }[]>`select key, name from sports order by key`;
    let compared = 0;
    for (const m of builtinModules) {
      const row = rows.find((r) => r.key === m.key);
      expect(row, `${m.key}: synced into sports`).toBeDefined();
      const word = dict[`sport.${m.key}`];
      expect(word, `${m.key}: the dictionary names it`).toBeTypeOf("string");
      expect(row!.name.toLowerCase(), m.key).toBe(word!.toLowerCase());
      compared++;
    }
    expect(compared, "swept every shipped module, and there are some").toBe(builtinModules.length);
    expect(compared).toBeGreaterThan(0);
    expect(rows.find((r) => r.key === "boardgame")!.name, "the sport the owner renamed").toBe(dict["sport.boardgame"]);
  });

  it("is idempotent — a second consecutive run prunes nothing further and reports the same live counts", async () => {
    const s = sql!;
    const first = await syncSports(s);
    const second = await syncSports(s);
    expect(second.prunedCount).toBe(0);
    expect(second.sportCount).toBe(first.sportCount);
    expect(second.variantCount).toBe(first.variantCount);
  });
});

afterAll(async () => {
  if (sql) await sql.end();
});
