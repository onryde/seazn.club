// No DB: the migration FILE says enable + force for every table it creates and
// creates no policy. migration-shape.test.ts proves the same against a live
// schema; this one runs in every process, so a ninth table without its two
// alter lines reds the unit gate before anything is applied anywhere.
import { describe, expect, it } from "vitest";
import { MIGRATION, STREAM_TABLES } from "./_stream-migration";

// SQL, not prose: `--` comments are stripped before either claim reads the file. The
// migration's own header says "A future `grant … to app_user` lands on a table that is
// already sealed" — a sentence, not a grant — and a commented-out `-- alter table … force
// row level security;` must not satisfy claim 1 either. (V408 has no `--` inside a string
// literal, so the strip cannot eat SQL.)
const SQL_ONLY = MIGRATION.replace(/--.*$/gm, "");

describe("__stream_sessions.sql — RLS is static text, not a runtime hope", () => {
  it("every created table has `enable row level security` AND `force row level security`", () => {
    expect(STREAM_TABLES.length).toBeGreaterThanOrEqual(8);
    for (const t of STREAM_TABLES) {
      expect(SQL_ONLY, t).toMatch(new RegExp(`alter table ${t}\\s+enable\\s+row level security;`));
      expect(SQL_ONLY, t).toMatch(new RegExp(`alter table ${t}\\s+force\\s+row level security;`));
    }
  });
  it("creates no policy and no grant to app_user", () => {
    expect(SQL_ONLY).not.toMatch(/create policy/i);
    expect(SQL_ONLY).not.toMatch(/grant .* to app_user/i);
  });
});
