// design §6.2: every *_enc column is named only by its owner — server/relay/**
// for the stream columns, device-links.ts for the device-link secret (scorer
// sheets §4.1), external-accounts.ts for the Lichess token, server/youtube/token-store.ts
// for the YouTube refresh token. Claims, because an enumerating grep is only as good as its list:
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

/** The relay's stream columns: only server/relay/** may name them. `tok_enc` is the stream
 *  code's sealed tok (capture QR v2 §6.1, V430): RELAY_KEK, opened by crypto.ts, SQL in
 *  secret-columns.ts. `playback_srt_key_enc` (R2004, V462) seals a composed camera's SRT playback `{ passphrase,
 *  streamId }`, the ingest SRT envelope's twin. */
const STREAM_COLUMNS = ["ingest_rtmps_key_enc", "ingest_srt_key_enc", "playback_srt_key_enc", "pool_rtmp_enc", "rtmp_enc", "tok_enc"];   // R2004 (V462): a composed camera's SRT playback credential; YouTube Connect (V479): the key pool's sealed {url, streamKey}, RELAY_KEK
/** Scorer sheets §4.1: the sealed device-link secret, named by exactly one file. */
const DEVICE_LINK_COLUMNS = ["secret_enc"];
const DEVICE_LINK_OWNER = "server/usecases/device-links.ts";
/** Design §3.1 (2026-10-09): the player's Lichess token at rest, sealed under
 *  LICHESS_TOKEN_KEK. SQL over it lives in exactly one file — the positive
 *  "and it does" claim is added with that file (T2). */
const LICHESS_COLUMNS = ["access_token_enc"];
/** Chess design §3.1: the sealed Lichess token. SQL over it lives in exactly
 *  one file. Named, so a second usecase reaching for the column reds. */
const LICHESS_OWNER = "server/usecases/external-accounts.ts";

/** YouTube Connect (V479, spec §5.1): the channel's refresh token at rest, on `org_youtube_connections` and on the
 *  short-lived `youtube_connect_pending`, sealed under YOUTUBE_TOKEN_KEK. SQL over it lives in exactly one file — every
 *  write (the connection insert with its token, the token replace, the ONE-statement revoke, the pending seal and
 *  take) and the one read (openToken) — so V479's `revoked <=> no token` checks hold within a single statement each
 *  (controller ruling R1). */
const YOUTUBE_COLUMNS = ["refresh_token_enc"];
const YOUTUBE_OWNER = "server/youtube/token-store.ts";

/** `token_enc` is named by TWO tables, each sealing its own token under DEVICE_LINK_KEK, so the column is one entry and
 *  its owners are the union (a scan by column name cannot tell the tables apart):
 *  - Quick match (V506, spec 2026-11-03 §7.1, C19): the home-page token's sealed envelope on `quick_matches`. SQL over it
 *    lives in exactly two files: the create that writes it, and the home read that returns it on
 *    `QuickMatchRow.tokenEnc` (plan 1 Task 7) — the one row every later reader rebuilds the link from (the pad's back
 *    link, the saved list), so none of them names the column. A third reader joins these owners or reads the row.
 *  - Match Day codes (V509, capture S4 design §3): the code's token at rest, so the desk can show the same QR again.
 *    Not `tok_enc` — that name is the stream code's, and only server/relay/** may name it. */
const TOKEN_ENC_COLUMNS = ["token_enc"];
const QUICK_MATCH_OWNERS = ["server/usecases/quick-match-create.ts", "server/usecases/quick-match-home.ts"];
const MATCH_DAY_OWNER = "server/usecases/match-day-codes.ts";
const TOKEN_ENC_OWNERS = [...QUICK_MATCH_OWNERS, MATCH_DAY_OWNER];

describe("*_enc columns never leave their owners", () => {
  it("every declared *_enc column is owned — a new one cannot walk past this test", () => {
    expect(ENC_COLUMNS).toEqual(
      [...STREAM_COLUMNS, ...DEVICE_LINK_COLUMNS, ...LICHESS_COLUMNS, ...YOUTUBE_COLUMNS, ...TOKEN_ENC_COLUMNS].sort(),
    );
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

  it("outside __tests__, only external-accounts.ts names access_token_enc — and it does", () => {
    const pattern = new RegExp(`\\b(${LICHESS_COLUMNS.join("|")})\\b`);
    const naming = walk(SRC)
      .map((f) => relative(SRC, f))
      .filter((f) => !f.split("/").includes("__tests__"))
      .filter((f) => pattern.test(readFileSync(join(SRC, f), "utf8")));
    expect(naming).toEqual([LICHESS_OWNER]);
  });

  it("outside __tests__, only token-store.ts names refresh_token_enc — and it does", () => {
    const pattern = new RegExp(`\\b(${YOUTUBE_COLUMNS.join("|")})\\b`);
    const naming = walk(SRC)
      .map((f) => relative(SRC, f))
      .filter((f) => !f.split("/").includes("__tests__"))
      .filter((f) => pattern.test(readFileSync(join(SRC, f), "utf8")));
    // The positive half first: an owner that stopped naming the column would leave it written by nobody, and an
    // offenders-only scan could not see that.
    expect(naming).toContain(YOUTUBE_OWNER);
    const offenders = naming.filter((f) => f !== YOUTUBE_OWNER);
    expect(offenders).toEqual([]);
  });

  it("outside __tests__, only quick-match-create.ts, quick-match-home.ts and match-day-codes.ts name token_enc — and all three do", () => {
    const pattern = new RegExp(`\\b(${TOKEN_ENC_COLUMNS.join("|")})\\b`);
    const naming = walk(SRC)
      .map((f) => relative(SRC, f))
      .filter((f) => !f.split("/").includes("__tests__"))
      .filter((f) => pattern.test(readFileSync(join(SRC, f), "utf8")));
    expect([...naming].sort()).toEqual([...TOKEN_ENC_OWNERS].sort());
  });

  it("each token_enc owner names only its own table: quick_matches for the two quick-match files, match_day_codes for match-day-codes.ts", () => {
    // The scan above is by column name, so it cannot tell the two tables apart; this one can. An owner naming the OTHER
    // table's name is a cross-read of a sealed token.
    const table = { quick: /\bquick_matches\b/, day: /\bmatch_day_codes\b/ };
    const src = (f: string): string => readFileSync(join(SRC, f), "utf8");
    for (const f of QUICK_MATCH_OWNERS) {
      expect(table.quick.test(src(f)), `${f} names quick_matches`).toBe(true);
      expect(table.day.test(src(f)), `${f} must not name match_day_codes`).toBe(false);
    }
    expect(table.day.test(src(MATCH_DAY_OWNER)), `${MATCH_DAY_OWNER} names match_day_codes`).toBe(true);
    expect(table.quick.test(src(MATCH_DAY_OWNER)), `${MATCH_DAY_OWNER} must not name quick_matches`).toBe(false);
  });
});

// Claim 4 (ruling 13, C14): only the named writers name a capture table. Comments are
// stripped first — config.ts's sample-cap note names fixture_stream_samples in prose, and
// prose is not SQL. (Claims 1–3 do NOT strip: a comment naming an *_enc column is still a leak.)
const CAPTURE_TABLES = /\b(fixture_stream_events|fixture_stream_samples|stream_provider_calls|stream_storage_snapshots)\b/;
// stream-sessions is a folder (it was one file, `stream-sessions.ts`): the writers are the modules whose CODE names a capture table.
const STREAM_SESSIONS_WRITERS = [
  "server/usecases/stream-sessions/heartbeat.ts",
  "server/usecases/stream-sessions/ingest-poll.ts",
  "server/usecases/stream-sessions/persist.ts",
  "server/usecases/stream-sessions/phone-lost.ts",
];
const CAPTURE_WRITERS = ["server/relay/telemetry.ts", "server/usecases/relay-sweep.ts", ...STREAM_SESSIONS_WRITERS];
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

describe("capture tables are named only by their writers (claim 4)", () => {
  it("outside __tests__, only telemetry.ts, relay-sweep.ts and the stream-sessions modules name a capture table — and telemetry.ts does (C14)", () => {
    const naming = walk(SRC)
      .map((f) => relative(SRC, f))
      .filter((f) => !f.split("/").includes("__tests__"))
      .filter((f) => CAPTURE_TABLES.test(stripComments(readFileSync(join(SRC, f), "utf8"))));
    // The positive pair: the scan sees the one writer that must match (an empty scan would pass the next line).
    expect(naming).toContain("server/relay/telemetry.ts");
    // …and each stream-sessions module on the list still names one, so a stale entry cannot widen the allowlist unseen.
    for (const w of STREAM_SESSIONS_WRITERS) expect(naming, `${w} names a capture table`).toContain(w);
    expect(naming.filter((f) => !CAPTURE_WRITERS.includes(f))).toEqual([]);
  });
});
