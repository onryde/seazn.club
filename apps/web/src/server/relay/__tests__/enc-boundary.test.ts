// design §6.2: every *_enc column is named only by its owner — server/relay/**
// for the stream columns, device-links.ts for the device-link secret (scorer
// sheets §4.1). Claims, because an enumerating grep is only as good as its list:
//  1. every *_enc column ANY delta declares is owned (ENC_COLUMNS is derived
//     from the migration files, never typed here — an encrypted column added
//     later cannot walk past this test with the list still green);
//  2. no stream column appears in any .ts/.tsx under apps/web/src outside
//     server/relay/**. Mutant r3: reference `ingest_srt_key_enc` in a usecase
//     → red.
//  3. outside __tests__, device-links.ts is the ONLY file naming secret_enc —
//     and it does (the positive half: an owner that stopped naming it would
//     leave the column written by nobody, which an empty scan cannot see).
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

// Every *_enc column ANY delta declares — `create table` column lines and
// `alter table … add column` alike. Deriving from one migration file (the old
// form) could not see a column added anywhere else.
const DELTA_FILES = readdirSync(DELTAS).filter((f) => /^V\d+__.+\.sql$/.test(f));
const ENC_COLUMNS = [
  ...new Set(
    DELTA_FILES.flatMap((f) =>
      [...readFileSync(join(DELTAS, f), "utf8").matchAll(/\b([a-z_]+_enc)\s+bytea\b/g)].map((m) => m[1]!),
    ),
  ),
].sort();

/** The relay's three stream columns: only server/relay/** may name them. */
const STREAM_COLUMNS = ["ingest_rtmps_key_enc", "ingest_srt_key_enc", "rtmp_enc"];
/** Scorer sheets §4.1: the sealed device-link secret, named by exactly one file. */
const DEVICE_LINK_COLUMNS = ["secret_enc"];
const DEVICE_LINK_OWNER = "server/usecases/device-links.ts";

describe("*_enc columns never leave their owners", () => {
  it("every declared *_enc column is owned — a new one cannot walk past this test", () => {
    expect(ENC_COLUMNS).toEqual([...STREAM_COLUMNS, ...DEVICE_LINK_COLUMNS].sort());
  });

  it("no file outside server/relay/** names a stream column (r3)", () => {
    const pattern = new RegExp(`\\b(${STREAM_COLUMNS.join("|")})\\b`);
    const offenders = walk(SRC)
      .filter((f) => !relative(SRC, f).startsWith("server/relay/"))
      .filter((f) => pattern.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  it("inside the boundary, only secret-columns.ts issues SQL over the stream columns", () => {
    const inside = walk(join(SRC, "server/relay"))
      .filter((f) => !f.includes("__tests__"))
      .filter((f) => new RegExp(`\\b(${STREAM_COLUMNS.join("|")})\\b`).test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(inside).toEqual(["server/relay/secret-columns.ts"]);
  });

  it("outside __tests__, only device-links.ts names secret_enc — and it does", () => {
    const pattern = new RegExp(`\\b(${DEVICE_LINK_COLUMNS.join("|")})\\b`);
    const naming = walk(SRC)
      .map((f) => relative(SRC, f))
      .filter((f) => !f.split("/").includes("__tests__"))
      .filter((f) => pattern.test(readFileSync(join(SRC, f), "utf8")));
    expect(naming).toEqual([DEVICE_LINK_OWNER]);
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
