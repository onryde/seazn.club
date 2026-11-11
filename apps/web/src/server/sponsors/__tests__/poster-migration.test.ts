// Title sponsor poster, Task 1: `sponsors.poster_path` and its CHECK are only real if something tries to violate them
// (AGENTS.md class 3). Every refusal names its CONSTRAINT, not just its SQLSTATE, and sits beside its accepted twin in the
// same `it` (TEST-STRATEGY: a negative assertion owes its positive pair), so a test that passes on a schema WITHOUT the
// column cannot exist - the twin fails first with `column "poster_path" does not exist`.
//
// Sport-agnostic: sponsor placement carries no sport, so there is no sport sweep here.
//
// Expected values are the spec's literals (docs/superpowers/specs/2026-11-11-title-sponsor-hero-poster-design.md §6.1:
// nullable text, no default, http(s) only, at most 500 characters), never read back from the migration. The delta is found
// by SUFFIX, never by number: it is authored as V503 and renumbered at merge (a pure `git mv`). Real Postgres required
// (skipped without DATABASE_URL like every DB suite under src/server).
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";

const HAS_DB = !!process.env.DATABASE_URL;

const DELTAS_DIR = resolve(__dirname, "../../../../../../db/migration/deltas");
const DELTA = /^V\d+__sponsor_poster\.sql$/;
const MATCHES = readdirSync(DELTAS_DIR).filter((f) => DELTA.test(f));

const CONSTRAINT = "sponsors_poster_path_check";
/** Spec §6.1: `poster_path is null or (poster_path ~* '^https?://' and char_length(poster_path) <= 500)`. */
const MAX_LENGTH = 500;
const URL_STEM = "https://a.example/";
/** A URL of EXACTLY `n` characters, built from the stem and filler so the boundary is arithmetic, not a literal count. */
const urlOfLength = (n: number): string => URL_STEM + "x".repeat(n - URL_STEM.length);

const ACCEPTED: (string | null)[] = [
  null,
  "https://x.supabase.co/storage/v1/object/public/assets/orgs/o/content/a.png",
  "http://a.example/p.jpg",
  "HTTPS://A.EXAMPLE/P.WEBP", // the regex is case-insensitive (`~*`), like isRedirectableUrl's scheme read
  urlOfLength(MAX_LENGTH), // the boundary: exactly 500 characters is accepted
];
const REFUSED: string[] = [
  "javascript:alert(1)",
  "logos/a.png", // a relative path: next/image throws on a src that is neither absolute nor `/`-rooted
  "/relative.png",
  "data:image/png;base64,AAAA",
  "ftp://a.example/p.png",
  "", // an empty string is not null: it is not a URL
  "   https://a.example/p.png", // leading whitespace defeats the `^https?://` anchor
  urlOfLength(MAX_LENGTH + 1), // 501 characters
];

const uniq = () => randomUUID().slice(0, 8);

async function org(): Promise<string> {
  const s = uniq();
  const [row] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Poster " + s}, ${"poster-" + s}) returning id`;
  return row!.id;
}

async function insertSponsor(orgId: string, poster: string | null): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into sponsors (org_id, name, poster_path) values (${orgId}, ${"Acme " + uniq()}, ${poster}) returning id`;
  return row!.id;
}

afterAll(async () => {
  if (!HAS_DB) return;
  await sql.end();
});

describe("the poster delta is found by suffix", () => {
  it("exactly one sponsor_poster delta exists (no number is assumed; a renumber is a pure git mv)", () => {
    expect(MATCHES.length).toBe(1);
    expect(MATCHES[0]).toMatch(DELTA);
  });
});

describe.skipIf(!HAS_DB)("sponsors.poster_path (the spec's section 6.1)", () => {
  it("poster_path is nullable text with no default", async () => {
    const rows = await sql<{ data_type: string; is_nullable: string; column_default: string | null }[]>`
      select data_type, is_nullable, column_default from information_schema.columns
       where table_schema = current_schema() and table_name = 'sponsors' and column_name = 'poster_path'`;
    expect(rows.length).toBe(1);
    expect(rows[0]).toEqual({ data_type: "text", is_nullable: "YES", column_default: null });
  });

  it("a sponsor inserted without a poster stores null (the empty case)", async () => {
    const orgId = await org();
    const [row] = await sql<{ id: string; poster_path: string | null }[]>`
      insert into sponsors (org_id, name) values (${orgId}, 'No Poster') returning id, poster_path`;
    expect(row!.poster_path).toBeNull();
  });

  it("null and http(s) urls up to 500 characters are stored; every other value is refused BY sponsors_poster_path_check (count reported)", async () => {
    const orgId = await org();
    let checked = 0;

    for (const value of ACCEPTED) {
      const id = await insertSponsor(orgId, value);
      const [row] = await sql<{ poster_path: string | null }[]>`select poster_path from sponsors where id = ${id}`;
      expect(row!.poster_path, `accepted ${JSON.stringify(value)}`).toBe(value);
      checked++;
    }
    for (const value of REFUSED) {
      await expect(insertSponsor(orgId, value), `refused ${JSON.stringify(value)}`).rejects.toMatchObject({
        code: "23514",
        constraint_name: CONSTRAINT,
      });
      checked++;
    }

    // Anti-vacuity: both lists were walked in full, and neither is empty.
    expect(ACCEPTED.length).toBeGreaterThan(0);
    expect(REFUSED.length).toBeGreaterThan(0);
    expect(checked).toBe(ACCEPTED.length + REFUSED.length);
    expect(checked).toBe(13);
  });

  it("an UPDATE is held to the same check (the PATCH path), and a refused update leaves the stored value", async () => {
    const orgId = await org();
    const stored = "https://a.example/p.png";
    const id = await insertSponsor(orgId, stored);
    let checked = 0;

    for (const value of REFUSED) {
      await expect(
        sql`update sponsors set poster_path = ${value} where id = ${id}`,
        `update to ${JSON.stringify(value)}`,
      ).rejects.toMatchObject({ code: "23514", constraint_name: CONSTRAINT });
      checked++;
    }
    const [row] = await sql<{ poster_path: string | null }[]>`select poster_path from sponsors where id = ${id}`;
    expect(row!.poster_path).toBe(stored);

    // The positive twin: replacing, then clearing, is accepted.
    await sql`update sponsors set poster_path = ${"https://b.example/q.png"} where id = ${id}`;
    await sql`update sponsors set poster_path = null where id = ${id}`;
    const [after] = await sql<{ poster_path: string | null }[]>`select poster_path from sponsors where id = ${id}`;
    expect(after!.poster_path).toBeNull();
    expect(checked).toBe(REFUSED.length);
  });
});
