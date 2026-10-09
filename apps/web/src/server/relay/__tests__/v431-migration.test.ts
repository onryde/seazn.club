// Capture QR v2 PR-2 T1 (spec §8.2, plan R-1 and FP16): V431's text, read through the stream-migration fold. No database:
// the DB-backed half (the backfill executed against a V430-shaped row, the resolver) lives in
// usecases/__tests__/stream-codes.test.ts. The refusal CHECK list is compared with the DOMAIN's declaration, never a
// list typed here, so a code added on one side reds the other.
import { describe, expect, it } from "vitest";
import { STREAM_DELTA_FILES, deltaText, lastCheckList, stripSqlComments } from "./_stream-migration";
import { AUTO_START_REFUSALS } from "../domain/auto-stream";

const V431 = stripSqlComments(deltaText(431));

/** The `add column <name>` names of every `alter table <table> …;` statement in V431, per table. */
function addedColumns(table: string): string[] {
  const out: string[] = [];
  for (const m of V431.matchAll(/alter table (\w+)\b([^;]*);/g)) {
    if (m[1] !== table) continue;
    out.push(...[...m[2]!.matchAll(/add column (\w+)/g)].map((c) => c[1]!));
  }
  return out;
}

describe("V431 (spec §8.2, plan R-1, FP16)", () => {
  it("the fold reads V431 by name, after V430 (anti-vacuity)", () => {
    expect(STREAM_DELTA_FILES).toContain("V431__auto_stream.sql");
    expect(STREAM_DELTA_FILES.indexOf("V430__capture_stream_codes.sql")).toBeLessThan(STREAM_DELTA_FILES.indexOf("V431__auto_stream.sql"));
    expect(V431.length).toBeGreaterThan(0);
  });

  it("adds exactly the spec's six settings columns, plus target_chosen and not_ready_since", () => {
    const cols = [...V431.matchAll(/add column (\w+)/g)].map((m) => m[1]).sort();
    expect(cols).toEqual(["auto_start_attempted_at", "auto_start_blocked_at", "auto_start_refusal", "auto_start_session_id",
      "auto_started_at", "auto_stream", "not_ready_since", "target_chosen"].sort());
  });

  it("the columns land on the right tables: seven on the settings row (the spec's six and R-1's flag), not_ready_since on the pairing (FP16)", () => {
    expect(addedColumns("fixture_stream_settings").sort()).toEqual(["auto_start_attempted_at", "auto_start_blocked_at", "auto_start_refusal",
      "auto_start_session_id", "auto_started_at", "auto_stream", "target_chosen"].sort());
    expect(addedColumns("fixture_stream_pairings")).toEqual(["not_ready_since"]);
  });

  it("the refusal CHECK list equals the domain's AUTO_START_REFUSALS (declared, not typed here)", () => {
    const list = lastCheckList("fixture_stream_settings", "auto_start_refusal");
    expect(list.length).toBeGreaterThan(0);
    expect([...list].sort()).toEqual([...AUTO_START_REFUSALS].sort());
  });

  it("auto_stream defaults false; the backfill marks every existing row target_chosen", () => {
    expect(V431).toMatch(/auto_stream\s+boolean not null default false/);
    expect(V431).toMatch(/update fixture_stream_settings set target_chosen = true/);
  });

  it("target_chosen is not null default false (a row the switch creates has chosen nothing), and the backfill runs AFTER the column exists, with no WHERE (every V430 row was written by a destination write)", () => {
    expect(V431).toMatch(/target_chosen\s+boolean not null default false/);
    const addedAt = V431.search(/add column target_chosen/);
    const backfill = /update fixture_stream_settings set target_chosen = true\s*;/.exec(V431);
    expect(addedAt).toBeGreaterThanOrEqual(0);
    expect(backfill, "an unconditional backfill statement").not.toBeNull();
    expect(backfill!.index).toBeGreaterThan(addedAt);
  });

  it("a session delete leaves the settings row: auto_start_session_id is a nullable FK with ON DELETE SET NULL, and the FK has an index to walk (V430 m-2)", () => {
    expect(V431).toMatch(/auto_start_session_id\s+uuid null references fixture_stream_sessions\(id\) on delete set null/);
    expect(V431).toMatch(/create index on fixture_stream_settings \(auto_start_session_id\)/);
  });

  it("fixture_stream_sessions gets a plain (fixture_id) index: maybeAutoStart's per-beat 'any session ever received ingest' read must not seq-scan the table", () => {
    expect(V431).toMatch(/create index on fixture_stream_sessions \(fixture_id\)\s*;/);
  });

  it("the stamps are timestamptz and nullable (null = never), so 'once per match' and 'never after a Stop' read as IS NULL", () => {
    for (const col of ["auto_started_at", "auto_start_blocked_at", "auto_start_attempted_at"]) {
      expect(V431, col).toMatch(new RegExp(`${col}\\s+timestamptz null`));
    }
    expect(V431).toMatch(/not_ready_since\s+timestamptz null/);
  });
});
