// No DB: the migration FILES say enable + force for every table they create and
// create no policy. migration-shape.test.ts proves the same against a live
// schema; this one runs in every process, so a new stream table without its two
// alter lines reds the unit gate before anything is applied anywhere.
//
// Capture QR v2 (T3, ruling R1, spec §17.1): the four V430 tables take V410's
// pattern — enable + force, NO policy, NO trg_set_org, NO grant to app_user —
// so the scan reads the FOLD (V410 and every later stream/capture delta), not
// V410 alone.
import { describe, expect, it } from "vitest";
import { STREAM_DELTA_FILES, STREAM_DELTAS, STREAM_TABLES, stripSqlComments } from "./_stream-migration";

// SQL, not prose: `--` comments are stripped before either claim reads the files. V410's
// own header says "A future `grant … to app_user` lands on a table that is already sealed"
// — a sentence, not a grant — and a commented-out `-- alter table … force row level
// security;` must not satisfy claim 1 either. (No folded file has `--` inside a string
// literal, so the strip cannot eat SQL.)
const SQL_ONLY = stripSqlComments(STREAM_DELTAS);

/** V430's four tables (spec §8.1), by name — the fold must find each of them. */
const V430_TABLES = ["fixture_stream_codes", "fixture_stream_settings", "fixture_stream_pairings", "fixture_stream_phone_beats"];

describe("the stream deltas — RLS is static text, not a runtime hope", () => {
  it("every created table has `enable row level security` AND `force row level security`", () => {
    // V410's eight, plus V430's four (R1).
    expect(STREAM_TABLES.length).toBeGreaterThanOrEqual(8 + V430_TABLES.length);
    let checked = 0;
    for (const t of STREAM_TABLES) {
      expect(SQL_ONLY, t).toMatch(new RegExp(`alter table ${t}\\s+enable\\s+row level security;`));
      expect(SQL_ONLY, t).toMatch(new RegExp(`alter table ${t}\\s+force\\s+row level security;`));
      checked++;
    }
    expect(checked, "tables checked").toBe(STREAM_TABLES.length);
  });

  it("V430's four tables are in the fold, each enabled AND forced (R1)", () => {
    expect(STREAM_DELTA_FILES.some((f) => /^V430__/.test(f)), "the fold reads V430").toBe(true);
    let checked = 0;
    for (const t of V430_TABLES) {
      expect(STREAM_TABLES, t).toContain(t);
      expect(SQL_ONLY, t).toMatch(new RegExp(`alter table ${t}\\s+enable\\s+row level security;`));
      expect(SQL_ONLY, t).toMatch(new RegExp(`alter table ${t}\\s+force\\s+row level security;`));
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("creates no policy and no grant to app_user — across the whole fold, V430 included", () => {
    expect(STREAM_DELTA_FILES.length, "the fold read no file").toBeGreaterThan(0);
    expect(SQL_ONLY).not.toMatch(/create policy/i);
    expect(SQL_ONLY).not.toMatch(/grant .* to app_user/i);
    // R1: the V117 tenant pattern is NOT copied — no trg_set_org on any stream table.
    expect(SQL_ONLY).not.toMatch(/create trigger trg_set_org/i);
  });
});
