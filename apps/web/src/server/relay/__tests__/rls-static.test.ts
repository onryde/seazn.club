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
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { STREAM_DELTA_FILES, STREAM_DELTAS, STREAM_TABLES, stripSqlComments } from "./_stream-migration";

// SQL, not prose: `--` comments are stripped before either claim reads the files. V410's
// own header says "A future `grant … to app_user` lands on a table that is already sealed"
// — a sentence, not a grant — and a commented-out `-- alter table … force row level
// security;` must not satisfy claim 1 either. (No folded file has `--` inside a string
// literal, so the strip cannot eat SQL.)
const SQL_ONLY = stripSqlComments(STREAM_DELTAS);

/** V430's four tables (spec §8.1), by name — the fold must find each of them. */
const V430_TABLES = ["fixture_stream_codes", "fixture_stream_settings", "fixture_stream_pairings", "fixture_stream_phone_beats"];
/** V525's court table (court stream), by name — the fold must find it, enabled AND forced. */
const V525_TABLES = ["court_stream_links"];
/** V541's two Seazn mark tables (Seazn-hosted video, Task 9), by name — the V430 pattern. */
const V541_TABLES = ["seazn_held_alerts", "seazn_locked_videos"];
/** V542's three replay tables (Seazn-hosted video, Task 23), by name — the V430 pattern. */
const V542_TABLES = ["org_video_collections", "fixture_video_replays", "bunny_webhook_events"];
/** V552's delivered-minutes table (Seazn-hosted video, Task 29), by name — the V430 pattern. */
const V552_TABLES = ["fixture_video_delivery"];
/** V558's club-defaults table (Seazn-hosted video, Task 38), by name — the V430 pattern. */
const V558_TABLES = ["org_stream_defaults"];

describe("the stream deltas — RLS is static text, not a runtime hope", () => {
  it("every created table has `enable row level security` AND `force row level security`", () => {
    // V410's eight, plus V430's four (R1), plus V525's court table, plus V541's two Seazn marks, plus V542's three replay tables,
    // plus V552's delivered-minutes table, plus V558's club defaults.
    expect(STREAM_TABLES.length).toBeGreaterThanOrEqual(
      8 + V430_TABLES.length + V525_TABLES.length + V541_TABLES.length + V542_TABLES.length + V552_TABLES.length + V558_TABLES.length,
    );
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

  it("V525's court table is in the fold, enabled AND forced (court stream, the V430 pattern)", () => {
    expect(STREAM_DELTA_FILES, "the fold reads V525").toContain("V525__court_stream_links.sql");
    let checked = 0;
    for (const t of V525_TABLES) {
      expect(STREAM_TABLES, t).toContain(t);
      expect(SQL_ONLY, t).toMatch(new RegExp(`alter table ${t}\\s+enable\\s+row level security;`));
      expect(SQL_ONLY, t).toMatch(new RegExp(`alter table ${t}\\s+force\\s+row level security;`));
      checked++;
    }
    expect(checked).toBe(1);
  });

  it("V541's two Seazn mark tables are in the fold, enabled AND forced, and org_stream_targets stays enabled AND forced", () => {
    expect(STREAM_DELTA_FILES, "the fold reads V541").toContain("V541__seazn_destination.sql");
    let checked = 0;
    for (const t of V541_TABLES) {
      expect(STREAM_TABLES, t).toContain(t);
      expect(SQL_ONLY, t).toMatch(new RegExp(`alter table ${t}\\s+enable\\s+row level security;`));
      expect(SQL_ONLY, t).toMatch(new RegExp(`alter table ${t}\\s+force\\s+row level security;`));
      checked++;
    }
    expect(checked).toBe(2);
    // V541 adds a row to org_stream_targets and changes none of its RLS: no disable, no `no force` anywhere in the fold.
    expect(SQL_ONLY).not.toMatch(/alter table org_stream_targets\s+(disable|no force)\s+row level security/);
  });

  it("V542's three replay tables are in the fold, enabled AND forced, and its view is not granted", () => {
    expect(STREAM_DELTA_FILES, "the fold reads V542").toContain("V542__seazn_replays.sql");
    let checked = 0;
    for (const t of V542_TABLES) {
      expect(STREAM_TABLES, t).toContain(t);
      expect(SQL_ONLY, t).toMatch(new RegExp(`alter table ${t}\\s+enable\\s+row level security;`));
      expect(SQL_ONLY, t).toMatch(new RegExp(`alter table ${t}\\s+force\\s+row level security;`));
      checked++;
    }
    expect(checked).toBe(3);
    expect(SQL_ONLY).toMatch(/create view public_fixture_seazn_replays_v\b/);
    expect(SQL_ONLY).not.toMatch(/grant [^;]*public_fixture_seazn_replays_v/i);
  });

  // The delivered-minutes delta only REFERENCES fixture_stream_sessions (an FK target), so the content sweep below does not count it
  // as touching a stream table: only its file name keeps it in the fold. Pinned by NAME, never by number (Phase 3 review m3: a
  // rebase renumbers it), so a rename that drops `seazn` reds here and a renumber is a `git mv`.
  it("the delivered-minutes delta (V552) is in the fold, enabled AND forced", () => {
    expect(STREAM_DELTA_FILES.filter((f) => /^V\d+__seazn_delivery\.sql$/.test(f)), "the fold reads exactly one delivered-minutes delta").toHaveLength(1);
    let checked = 0;
    for (const t of V552_TABLES) {
      expect(STREAM_TABLES, t).toContain(t);
      expect(SQL_ONLY, t).toMatch(new RegExp(`alter table ${t}\\s+enable\\s+row level security;`));
      expect(SQL_ONLY, t).toMatch(new RegExp(`alter table ${t}\\s+force\\s+row level security;`));
      checked++;
    }
    expect(checked).toBe(1);
  });

  // Pinned by NAME, never by number (a rebase renumbers it): the club-defaults delta joins the fold through its `stream` name, and a
  // rename that drops the word would take its table out of every scan here.
  it("the club-defaults delta (V558) is in the fold, its table enabled AND forced, and no policy or grant is made on it", () => {
    expect(STREAM_DELTA_FILES.filter((f) => /^V\d+__org_stream_defaults\.sql$/.test(f)), "the fold reads exactly one club-defaults delta").toHaveLength(1);
    let checked = 0;
    for (const t of V558_TABLES) {
      expect(STREAM_TABLES, t).toContain(t);
      expect(SQL_ONLY, t).toMatch(new RegExp(`alter table ${t}\\s+enable\\s+row level security;`));
      expect(SQL_ONLY, t).toMatch(new RegExp(`alter table ${t}\\s+force\\s+row level security;`));
      expect(SQL_ONLY, t).not.toMatch(new RegExp(`(create policy [^;]* on ${t}\\b|grant [^;]* on ${t}\\b)`, "i"));
      checked++;
    }
    expect(checked).toBe(1);
  });

  // m-2 (B3 review): the fold selects deltas by FILENAME (/stream|capture/), so a later `V4xx__relay_*.sql` that alters
  // a stream table would escape every scan here (AGENTS #16: sweep by behaviour, never by filename). This reads the
  // directory itself — not the fold's list — and checks every delta from V410 on by what its SQL touches.
  //
  // A foreign key that merely POINTS AT a stream table (`references fixture_stream_sessions(id)`) does not touch it: it
  // creates no stream table, alters none, and grants nothing on one. R4's V492 (tenant sponsor tables with an airing →
  // session key) is such a delta, and it must stay OUT of the fold, whose no-policy/no-grant claim would refuse its
  // org-scoped policies. So FK targets are stripped before the content test — and only they: any other mention in the
  // same file still counts (the synthetic pair below pins both directions).
  const touchesStreamTable = (sqlText: string): boolean =>
    /\b(fixture_stream_|org_stream_)\w*/.test(
      stripSqlComments(sqlText).replace(/\breferences\s+(fixture_stream_|org_stream_)\w+/gi, ""),
    );

  it("a delta that only references a stream table as a foreign-key target does not touch it; one that also alters it does", () => {
    expect(touchesStreamTable("create table t (s uuid references fixture_stream_sessions(id) on delete set null);")).toBe(false);
    expect(touchesStreamTable(
      "create table t (s uuid references fixture_stream_sessions(id));\nalter table fixture_stream_sessions add column x int;",
    )).toBe(true);
    expect(touchesStreamTable("grant select on org_stream_targets to app_user;")).toBe(true);
  });

  it("the fold misses no delta that touches a stream table — chosen by name, checked by content", () => {
    const dir = resolve(import.meta.dirname, "../../../../../../db/migration/deltas");
    const version = (f: string): number => Number(/^V(\d+)__/.exec(f)![1]);
    const deltas = readdirSync(dir).filter((f) => /^V\d+__.+\.sql$/.test(f));
    const v410 = deltas.find((f) => /^V\d+__stream_sessions\.sql$/.test(f));
    expect(v410, "V410 is where the stream tables begin").toBeDefined();
    const touching = deltas
      .filter((f) => version(f) >= version(v410!))
      .filter((f) => touchesStreamTable(readFileSync(join(dir, f), "utf8")));
    expect(touching.length, "no delta touches a stream table — the sweep proved nothing").toBeGreaterThan(1);
    for (const f of touching) expect(STREAM_DELTA_FILES, f).toContain(f);
  });

  it("creates no policy and no grant to app_user — across the whole fold, V430 and V525 included", () => {
    expect(STREAM_DELTA_FILES.length, "the fold read no file").toBeGreaterThan(0);
    expect(SQL_ONLY).not.toMatch(/create policy/i);
    expect(SQL_ONLY).not.toMatch(/grant .* to app_user/i);
    // R1: the V117 tenant pattern is NOT copied — no trg_set_org on any stream table.
    expect(SQL_ONLY).not.toMatch(/create trigger trg_set_org/i);
  });
});
