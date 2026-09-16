// design §6.2: server/relay/** is the only place a *_enc column is named.
// Two claims, because an enumerating grep is only as good as its list:
//  1. every *_enc column the migration declares is in ENC_COLUMNS (derived
//     from the migration file, never typed here — a fifth encrypted column
//     added later cannot walk past this test with the list still green);
//  2. none of them appears in any .ts/.tsx under apps/web/src outside
//     server/relay/**. Mutant r3: reference `ingest_srt_key_enc` in a usecase
//     → red.
// Pure (no DB); runs in every CI job. Same glob discipline as
// redirect-origin.test.ts (a narrow glob was that review's finding).
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const SRC = resolve(import.meta.dirname, "../../..");            // apps/web/src
const DELTAS = resolve(import.meta.dirname, "../../../../../../db/migration/deltas");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === ".next") continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const migration = readdirSync(DELTAS).find((f) => /^V\d+__stream_sessions\.sql$/.test(f));
const ENC_COLUMNS = migration
  ? [...readFileSync(join(DELTAS, migration), "utf8").matchAll(/^\s*([a-z_]+_enc)\s+bytea/gm)].map((m) => m[1]!)
  : [];

describe("*_enc columns never leave server/relay/**", () => {
  it("the migration exists and declares exactly the three encrypted columns the design names", () => {
    expect(migration, "V<n>__stream_sessions.sql is missing").toBeDefined();
    expect([...ENC_COLUMNS].sort()).toEqual(["ingest_rtmps_key_enc", "ingest_srt_key_enc", "rtmp_enc"]);
  });

  it("no file outside server/relay/** names any of them (r3)", () => {
    const pattern = new RegExp(`\\b(${ENC_COLUMNS.join("|")})\\b`);
    const offenders = walk(SRC)
      .filter((f) => !relative(SRC, f).startsWith("server/relay/"))
      .filter((f) => pattern.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  it("inside the boundary, only secret-columns.ts issues SQL over them", () => {
    const inside = walk(join(SRC, "server/relay"))
      .filter((f) => !f.includes("__tests__"))
      .filter((f) => new RegExp(`\\b(${ENC_COLUMNS.join("|")})\\b`).test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(inside).toEqual(["server/relay/secret-columns.ts"]);
  });
});

// Claim 4 (ruling 13, C14): only the named writers name a capture table. Comments are
// stripped first — config.ts's sample-cap note names fixture_stream_samples in prose, and
// prose is not SQL. (Claims 1–3 do NOT strip: a comment naming an *_enc column is still a leak.)
const CAPTURE_TABLES = /\b(fixture_stream_events|fixture_stream_samples|stream_provider_calls|stream_storage_snapshots)\b/;
const CAPTURE_WRITERS = ["server/relay/telemetry.ts", "server/usecases/relay-sweep.ts", "server/usecases/stream-sessions.ts"];
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

describe("capture tables are named only by their writers (claim 4)", () => {
  it("outside __tests__, only telemetry.ts, relay-sweep.ts and stream-sessions.ts name a capture table — and telemetry.ts does (C14)", () => {
    const naming = walk(SRC)
      .map((f) => relative(SRC, f))
      .filter((f) => !f.split("/").includes("__tests__"))
      .filter((f) => CAPTURE_TABLES.test(stripComments(readFileSync(join(SRC, f), "utf8"))));
    // The positive pair: the scan sees the one writer that must match (an empty scan would pass the next line).
    expect(naming).toContain("server/relay/telemetry.ts");
    expect(naming.filter((f) => !CAPTURE_WRITERS.includes(f))).toEqual([]);
  });
});
