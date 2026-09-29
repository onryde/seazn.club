// The four writers, the redaction scan, the sample cap. Real Postgres. Every
// write path here is the one production uses (telemetry.ts is the only SQL
// that names a capture table — enc-boundary.test.ts's sibling claim below).
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import { seedOrg, startedDivisionWithFixture } from "@/server/usecases/__tests__/_rig";
import { APP_BUILD_SHA, SAMPLES_PER_SESSION_CAP } from "../config";
import { PG_NUMERIC_RANGE, SAMPLE_NUMERIC_COLUMNS, recordEvent, recordProviderCall, recordSample, recordStorageSnapshot } from "../telemetry";
import { MIGRATION, STREAM_TABLES } from "./_stream-migration";

// Da: FLY_IMAGE_REF must be set BEFORE config.ts loads (APP_BUILD_SHA is read once, at import).
// vi.hoisted runs above every import; without it APP_BUILD_SHA is null and the build-sha test is vacuous.
const BUILD = vi.hoisted(() => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const saved = process.env.FLY_IMAGE_REF;
  process.env.FLY_IMAGE_REF = `registry.fly.io/seazn-club:${sha}`;
  return { sha, saved };
});
afterAll(() => {
  if (BUILD.saved === undefined) delete process.env.FLY_IMAGE_REF;
  else process.env.FLY_IMAGE_REF = BUILD.saved;
});

const HAS_DB = !!process.env.DATABASE_URL;

async function session() {
  const { auth } = await seedOrg();
  const { fixtureId } = await startedDivisionWithFixture(auth);
  // seedOrg's AuthCtx carries `userId: null` (_rig.ts) and created_by is NOT NULL with no FK — a fresh uuid is a creator.
  const userId = randomUUID();
  const [t] = await sql<{ id: string }[]>`insert into org_stream_targets (org_id, kind, label, rtmp_enc) values (${auth.orgId}, 'youtube', 'x', ${Buffer.from("e")}) returning id`;
  // The Task 0 snapshot's NOT NULL columns, read from the fixture's own rows (Task 1's DDL has no default for them).
  const [s] = await sql<{ id: string }[]>`
    insert into fixture_stream_sessions (fixture_id, org_id, mode, state, target_id, created_by, sport_key, competition_id, division_id, entitlement_via_override)
    select f.id, ${auth.orgId}, 'passthrough', 'requested', ${t!.id}, ${userId}, d.sport_key, d.competition_id, f.division_id, true
      from fixtures f join divisions d on d.id = f.division_id
     where f.id = ${fixtureId}
    returning id`;
  return { orgId: auth.orgId, sid: s!.id, userId };
}

describe.skipIf(!HAS_DB)("telemetry — the writers", () => {
  it("recordEvent assigns seq 1, 2, 3 per session under the caller's transaction and returns it", async () => {
    const { orgId, sid, userId } = await session();
    const seqs = await sql.begin(async (tx) => [
      await recordEvent(tx, { sessionId: sid, orgId, source: "domain", kind: "transition", type: "admit", from: "requested", to: "provisioning" }),
      await recordEvent(tx, { sessionId: sid, orgId, source: "runner", kind: "effect", type: "create_machine", result: "ok", httpStatus: 200, latencyMs: 412, attempt: 1, providerRequestId: "fly-req-1" }),
      await recordEvent(tx, { sessionId: sid, orgId, source: "client", kind: "action", type: "stop", actorUserId: userId }),
    ]);
    expect(seqs).toEqual([1, 2, 3]);
    const rows = await sql<{ seq: number; type: string }[]>`select seq, type from fixture_stream_events where session_id = ${sid} order by seq`;
    expect(rows.map((r) => r.type)).toEqual(["admit", "create_machine", "stop"]);
  });

  it("a known secret pushed through EVERY writer is absent from EVERY row of EVERY relay table (the redaction scan)", async () => {
    const { orgId, sid } = await session();
    const SECRET = "sekrit-" + randomUUID().replace(/-/g, "");
    const dirty = { passphrase: SECRET, url: `srt://live.cloudflare.com:778?passphrase=${SECRET}&streamid=s`, exit: { env: { RELAY_KEK: SECRET } }, reason: `ok?${SECRET}` };
    await sql.begin(async (tx) => {
      await recordEvent(tx, { sessionId: sid, orgId, source: "ingest", kind: "observed", type: "connected", payload: dirty });
    });
    await recordSample(sql, { sessionId: sid, source: "heartbeat", ingestState: "connected", raw: dirty });
    await recordProviderCall(sql, { sessionId: sid, provider: "cloudflare", operation: "createLiveInput", method: "POST",
      url: `https://api.cloudflare.com/client/v4/accounts/acc1/stream/live_inputs?key=${SECRET}`, ids: ["acc1"], status: 200, latencyMs: 90, attempt: 1, requestId: "cf-ray-1" });
    await recordStorageSnapshot(sql, { source: "admission", sessionId: sid, usedMinutes: 1, limitMinutes: 10, reservedMinutes: 2, headroomMinutes: 7 });
    for (const table of STREAM_TABLES) {
      const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from ${sql(table)} t where t::text like ${"%" + SECRET + "%"}`;
      expect(n, table).toBe(0);
    }
    // The positive pair: the non-secret facts DID land.
    const [call] = await sql<{ path_template: string }[]>`select path_template from stream_provider_calls where session_id = ${sid}`;
    expect(call!.path_template).toBe("/client/v4/accounts/{id}/stream/live_inputs");
    const [ev] = await sql<{ payload: { url?: string } }[]>`select payload from fixture_stream_events where session_id = ${sid}`;
    expect(ev!.payload.url).toBe("srt://live.cloudflare.com:778");
  });

  it("recordSample writes up to SAMPLES_PER_SESSION_CAP and returns 'capped' at cap + 1 without a row", async () => {
    const { sid } = await session();
    // Seed cap - 1 rows directly (the writer is O(1) per call; 8,000 calls is a slow test for no extra proof).
    await sql`insert into fixture_stream_samples (session_id, source) select ${sid}, 'poll' from generate_series(1, ${SAMPLES_PER_SESSION_CAP - 1})`;
    expect(await recordSample(sql, { sessionId: sid, source: "heartbeat" })).toBe("written");
    expect(await recordSample(sql, { sessionId: sid, source: "heartbeat" })).toBe("capped");
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_samples where session_id = ${sid}`;
    expect(n).toBe(SAMPLES_PER_SESSION_CAP);
  });

  it("recordProviderCall without a session (a sweep's list call) lands with session_id null", async () => {
    await recordProviderCall(sql, { provider: "fly", operation: "listMachines", method: "GET", url: "https://api.machines.dev/v1/apps/relay/machines", ids: [], status: 200, latencyMs: 30, attempt: 1 });
    const [row] = await sql<{ session_id: string | null }[]>`select session_id from stream_provider_calls where operation = 'listMachines' order by id desc limit 1`;
    expect(row!.session_id).toBeNull();
  });

  it("Da + Dh: recordEvent and recordSample stamp app_build_sha from config.ts; recordSample writes ingest_reason verbatim", async () => {
    // The env reached config.ts before its import — a null here would make both column assertions vacuous.
    expect(APP_BUILD_SHA).toBe(BUILD.sha);
    const { orgId, sid } = await session();
    await sql.begin(async (tx) => {
      await recordEvent(tx, { sessionId: sid, orgId, source: "domain", kind: "transition", type: "admit", from: "requested", to: "provisioning" });
    });
    await recordSample(sql, { sessionId: sid, source: "poll", ingestState: "connected", ingestReason: "x" });
    const [ev] = await sql<{ app_build_sha: string | null }[]>`select app_build_sha from fixture_stream_events where session_id = ${sid}`;
    const [sm] = await sql<{ app_build_sha: string | null; ingest_reason: string | null }[]>`
      select app_build_sha, ingest_reason from fixture_stream_samples where session_id = ${sid}`;
    expect(ev!.app_build_sha).toBe(BUILD.sha);
    expect(sm).toEqual({ app_build_sha: BUILD.sha, ingest_reason: "x" });
  });
});

// Task 11 review I1: a beat carrying ffmpeg's own numbers (bitrate=2998.7kbits/s) 500-ed the heartbeat, because the
// sample's integer columns refuse a fraction (22P02) and every numeric column refuses a value outside its type (22003).
// recordSample fits each number to its column in ONE place. The column TYPES come from V410's text; the RANGES are
// proven against Postgres itself; the stored values are compared with what Postgres's own casts give — never with
// anything telemetry.ts computes.

/** A table's numeric columns as V410 DECLARES them — read off the file. The identity key is not a written value. */
function declaredNumericColumns(table: string): Record<string, string> {
  const start = MIGRATION.indexOf(`create table ${table} (`);
  const body = start === -1 ? "" : MIGRATION.slice(start, MIGRATION.indexOf("\n);", start));
  return Object.fromEntries([...body.matchAll(/^\s+(\w+)\s+(integer|real|bigint|smallint|double precision|numeric)\b(?![^\n]*generated always)/gm)]
    .map((m) => [m[1]!, m[2]!]));
}

describe("telemetry — every sample number fits its column (Task 11 review I1)", () => {
  it("SAMPLE_NUMERIC_COLUMNS is exactly fixture_stream_samples' numeric columns, each with the type V410 declares", () => {
    const declared = declaredNumericColumns("fixture_stream_samples");
    expect(Object.keys(declared).length, "anti-vacuity: V410 declares numeric sample columns").toBeGreaterThanOrEqual(6);
    expect(SAMPLE_NUMERIC_COLUMNS).toEqual(declared);
  });
});

describe.skipIf(!HAS_DB)("telemetry — every sample number fits its column, against Postgres", () => {
  it("each PG_NUMERIC_RANGE bound is ACCEPTED by Postgres as its type, and the next value outward is REFUSED 22003", async () => {
    let checked = 0;
    for (const [type, r] of Object.entries(PG_NUMERIC_RANGE)) {
      // The bound goes in as a quoted literal — text, the way postgres.js sends a number (and so `-2147483648` is not
      // parsed as the negation of an out-of-range 2147483648).
      for (const bound of [r.max, r.min]) {
        await expect(sql.unsafe(`select '${String(bound)}'::${type} as v`), `${type} ${bound}`).resolves.toBeDefined();
        // One step outward: the next integer, or for a float the bound grown by one part in 10^6 — past float32's precision.
        const beyond = r.integral ? bound + Math.sign(bound) : bound * (1 + 1e-6);
        await expect(sql.unsafe(`select '${String(beyond)}'::${type} as v`), `${type} ${beyond}`).rejects.toMatchObject({ code: "22003" });
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: every type, both ends").toBe(Object.keys(PG_NUMERIC_RANGE).length * 2);
  });

  it("recordSample writes ffmpeg's fractions, an overflowing count and an out-of-range float instead of throwing — each stored as Postgres's own cast of it, clamped to the type", async () => {
    const { sid } = await session();
    const sent = { bitrateKbps: 2998.7, runnerMemMb: 511.5, droppedFrames: 3e9, fps: 29.97, runnerCpuPct: 1e39, encoderSpeed: 1e-50 };
    await expect(recordSample(sql, { sessionId: sid, source: "poll", ...sent })).resolves.toBe("written");
    const [row] = await sql<{ bitrate_kbps: number; runner_mem_mb: number; dropped_frames: number; fps: number; runner_cpu_pct: number; encoder_speed: number }[]>`
      select bitrate_kbps, runner_mem_mb, dropped_frames, fps, runner_cpu_pct, encoder_speed from fixture_stream_samples where session_id = ${sid}`;
    // In range: exactly what Postgres's own numeric → integer cast gives (it rounds; it never truncates).
    const [cast] = await sql<{ bitrate: number; mem: number }[]>`select 2998.7::numeric::integer as bitrate, 511.5::numeric::integer as mem`;
    expect(row!.bitrate_kbps).toBe(cast!.bitrate);
    expect(row!.runner_mem_mb).toBe(cast!.mem);
    expect(cast).not.toEqual({ bitrate: 2998, mem: 511 });   // the differential: a truncating writer lands on these
    // Out of range: the type's own edge — int4's largest (Postgres manual §8.1.1), float32's largest finite (IEEE-754).
    expect(row!.dropped_frames).toBe(2147483647);
    expect(Math.fround(row!.runner_cpu_pct)).toBe(Math.fround(3.4028234663852886e38));
    // Below float32's smallest normal magnitude, the value is flushed to zero (Postgres refuses 1e-50 as real outright).
    expect(row!.encoder_speed).toBe(0);
    // A real in range is stored as the float32 it is.
    expect(Math.fround(row!.fps)).toBe(Math.fround(29.97));
  });

  it("recordSample: an absent number stays NULL (never a measured zero), and a non-finite one is NULL too — it measured nothing", async () => {
    const { sid } = await session();
    await expect(recordSample(sql, { sessionId: sid, source: "poll", bitrateKbps: Number.NaN, fps: Number.POSITIVE_INFINITY })).resolves.toBe("written");
    const [row] = await sql<Record<string, number | null>[]>`
      select bitrate_kbps, fps, dropped_frames, runner_cpu_pct, runner_mem_mb, encoder_speed from fixture_stream_samples where session_id = ${sid}`;
    expect(Object.keys(row!).length).toBe(Object.keys(SAMPLE_NUMERIC_COLUMNS).length);
    expect(row).toEqual(Object.fromEntries(Object.keys(SAMPLE_NUMERIC_COLUMNS).map((c) => [c, null])));
  });
});
