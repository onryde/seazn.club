// Archive a sponsor, Task 1: the `sponsors.archived_at` column (spec docs/superpowers/specs/2026-11-11-sponsor-archive-design.md
// §6.1, D8). Archive is a nullable timestamp beside `status`, never a write to it, so Unarchive is exact by construction.
//
// Sport-agnostic: no sport sweep. Sponsor visibility carries no sport.
//
// Expected values are the spec's literals (§6.1: `archived_at timestamptz null`, no default, no backfill), never read back
// from the migration. The delta is found by SUFFIX, never by number: it is authored as V505 and renumbered at merge (a
// `git mv` plus a line-1 edit), so line 1 must name the file's own version, the rule src/lib/__tests__/migration-header-truth
// enforces repo-wide; it is restated here so a renumber that forgets line 1 reds in this file too. Real Postgres required
// for the column checks (skipped without DATABASE_URL like every DB suite under src/server).
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";

const HAS_DB = !!process.env.DATABASE_URL;

const DELTAS_DIR = resolve(__dirname, "../../../../../../db/migration/deltas");
const DELTA = /^V\d+__sponsor_archive\.sql$/;
const MATCHES = readdirSync(DELTAS_DIR).filter((f) => DELTA.test(f));

/** The repo's self-naming header shape (migration-header-truth.test.ts `selfNamed`): `-- V505 — description`. */
const SELF_NAMED = /^--\s*V(\d+)\s*[—–-]\s/;
/** The version a migration file's NAME declares (migration-header-truth.test.ts `fileVersion`). */
const fileVersion = (name: string): string => /^V(\d+)__/.exec(name)![1]!;

const uniq = () => randomUUID().slice(0, 8);

async function org(): Promise<string> {
  const s = uniq();
  const [row] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Archive " + s}, ${"archive-" + s}) returning id`;
  return row!.id;
}

afterAll(async () => {
  if (!HAS_DB) return;
  await sql.end();
});

describe("the archive delta is found by suffix, and names itself truthfully", () => {
  it("finds exactly one sponsor_archive delta, by suffix (no number is assumed; a renumber is a git mv)", () => {
    expect(MATCHES.length).toBe(1);
    expect(MATCHES[0]).toMatch(DELTA);
  });

  it("its first line names its own version (a renumber that forgets line 1 is caught here)", () => {
    expect(MATCHES.length, "the delta exists").toBe(1);
    const name = MATCHES[0]!;
    const first = readFileSync(resolve(DELTAS_DIR, name), "utf8")
      .split("\n")
      .find((l) => l.trim() !== "");
    const claimed = first ? SELF_NAMED.exec(first.trim())?.[1] ?? null : null;
    // Not merely "if it names itself, be right": this delta MUST self-name (spec §6.1), or the renumber guard has nothing to read.
    expect(claimed, `line 1 of ${name}: ${JSON.stringify(first)}`).not.toBeNull();
    expect(claimed).toBe(fileVersion(name));
  });
});

describe.skipIf(!HAS_DB)("sponsors.archived_at (the spec's section 6.1)", () => {
  it("archived_at is nullable timestamptz with no default", async () => {
    const rows = await sql<{ data_type: string; is_nullable: string; column_default: string | null }[]>`
      select data_type, is_nullable, column_default from information_schema.columns
       where table_schema = current_schema() and table_name = 'sponsors' and column_name = 'archived_at'`;
    expect(rows.length).toBe(1);
    expect(rows[0]).toEqual({ data_type: "timestamp with time zone", is_nullable: "YES", column_default: null });
  });

  it("an existing sponsor reads archived_at null after the delta (the empty case), and the column holds a stamp and clears again", async () => {
    const orgId = await org();
    // Inserted the way every existing writer does: without naming the column. No backfill, no default: it reads null.
    const [row] = await sql<{ id: string; archived_at: Date | null }[]>`
      insert into sponsors (org_id, name) values (${orgId}, ${"Acme " + uniq()}) returning id, archived_at`;
    expect(row!.archived_at).toBeNull();

    // The positive twin: Archive's write is stored as given, and Unarchive's clear reads null again.
    const stamp = new Date("2026-11-12T09:30:00.000Z");
    await sql`update sponsors set archived_at = ${stamp} where id = ${row!.id}`;
    const [archived] = await sql<{ archived_at: Date | null }[]>`select archived_at from sponsors where id = ${row!.id}`;
    expect(archived!.archived_at?.toISOString()).toBe(stamp.toISOString());

    await sql`update sponsors set archived_at = null where id = ${row!.id}`;
    const [cleared] = await sql<{ archived_at: Date | null }[]>`select archived_at from sponsors where id = ${row!.id}`;
    expect(cleared!.archived_at).toBeNull();
  });
});
