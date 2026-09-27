// Arrays through the app's REAL `sql` client — the trap behind lib/db.ts's
// "fetch_types must stay on" line.
//
// postgres.js 3.4.9 ships no built-in array parsers or serializers. Its
// `fetch_types` connect step (the `select b.oid, b.typarray from pg_type …`
// query) is what registers them — for EVERY array type, text[] and uuid[]
// included, not only custom ones. With it off, measured 2026-09-24:
//   select array['a','b']::text[]   → the STRING "{a,b}", not ["a","b"]
//   … where v = any(${["x","y"]})   → throws `malformed array literal: "x,y"`
// The app reads text[]/uuid[] columns (courts.tags, required_court_tags,
// division_ids) and passes JS arrays to `any(${ids})` in dozens of places, so
// turning it off to save the per-connection type query is an outage.
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("array types through the app's sql client", () => {
  it("reads text[] and uuid[] columns back as JS arrays", async () => {
    const [row] = await sql<{ tags: unknown; ids: unknown }[]>`
      select array['indoor','show court']::text[] as tags,
             array['11111111-1111-4111-8111-111111111111']::uuid[] as ids`;
    expect(row.tags).toEqual(["indoor", "show court"]);
    expect(row.ids).toEqual(["11111111-1111-4111-8111-111111111111"]);
  });

  it("serialises a JS array parameter for any(${…}) — text and uuid", async () => {
    const texts = await sql<{ v: string }[]>`
      select v from unnest(array['a','b','c']::text[]) v
      where v = any(${["a", "c", "z"]}) order by v`;
    expect(texts.map((r) => r.v)).toEqual(["a", "c"]);

    const a = "11111111-1111-4111-8111-111111111111";
    const b = "22222222-2222-4222-8222-222222222222";
    const uuids = await sql<{ v: string }[]>`
      select v from unnest(array[${a}::uuid, ${b}::uuid]) v
      where v = any(${[b, "33333333-3333-4333-8333-333333333333"]})`;
    expect(uuids.map((r) => r.v)).toEqual([b]);
  });
});
