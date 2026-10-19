// The two internal routes a Fly Machine calls (design §6.3, §6.4), driven as REAL route handlers with Request objects —
// Next route handlers are plain functions, and `handler()` needs no request scope beyond its own ALS. What this file
// proves is the WIRING the usecase suite cannot see (stream-sessions.test.ts hands `heartbeat` a parsed body and a bare
// token; it never runs a route, a bearer parse or a body parse):
//   - the 401 gate: no bearer, a malformed one, and every token the verifier refuses (tampered, expired, another
//     session's, the page scope) answer ONE 401 on BOTH routes — and write nothing — beside the job token's 200;
//   - the heartbeat's body parse: malformed, non-JSON, empty and exit-carrying bodies are 400 and write nothing;
//   - ruling 13 through the route: the POSTED fps/bitrate land in the sample row;
//   - A5 through the routes: exit facts the facts route's reconcile persisted survive the beat route;
//   - the sequence: a replayed beat and a replayed read, the `ending` reply after a stop, 410 once terminal.
//
// ONE SPORT, on purpose (TEST-STRATEGY rule 6): relay is sport-agnostic — nothing on these two routes reads the sport,
// so every rig rides `_rig`'s `generic` division. The two MODES are what varies here, and both appear below.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The sample writer, passed through untouched — one test makes it fail ONCE, to prove a telemetry failure can never
// cost a beat its lifecycle half (Task 11 review I1b). Every other test runs the real writer.
vi.mock("@/server/relay/telemetry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/relay/telemetry")>();
  return { ...actual, recordSample: vi.fn(actual.recordSample), recordEvent: vi.fn(actual.recordEvent) };
});

// The house Sentry helper, spied: the forced-destroy capture is for PROVIDER failures only (re-review N3).
const sentry = vi.hoisted(() => ({ captureError: vi.fn() }));
vi.mock("@/lib/sentry", () => ({ captureError: sentry.captureError }));

import { sql } from "@/lib/db";
import { RelayHeartbeatReply, RelayJobSession, type RelayHeartbeat } from "@/server/api-v1/schemas";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { STREAM_PLATFORM_PRESETS } from "@/lib/stream-destinations";
import { PHASE_CHANNELS, PROGRAMME_PHASES } from "@/lib/relay-phase";
import {
  MAX_DURATION_MINUTES, RELAY_EXIT_REFUSED, RELAY_HEARTBEAT_INTERVAL_MS, RELAY_OVERLAY_DELAY_DEFAULT_MS, RUNNER_CRASH_CAP, RUNNER_INPLACE_RESTARTS, RUNNER_MAX_ATTEMPTS, RUNNER_OBSERVE_SLACK_SECONDS,
  RUNNER_RESTART_STUCK_SECONDS, RUNNER_STOP_GRACE_SECONDS, STALE_HEARTBEAT_SECONDS, STALE_HEARTBEAT_SECONDS_COMPOSED, WARMING_TIMEOUT_MINUTES,
} from "@/server/relay/config";
import { BEAT_EXIT_REASONS, failReasonFromExit, type BeatExitReason, type ExitInfo } from "@/server/relay/domain/runner";
import { setRelayDriversForTest } from "@/server/relay/drivers";
import { FakeIngest, FakeRunner } from "@/server/relay/fakes";
import type { IngestCredentials } from "@/server/relay/ports";
import { pairPresentPhone, rigUser } from "@/server/relay/__tests__/_session-rig";
import { recordEvent, recordSample } from "@/server/relay/telemetry";
import { mintRelayToken, verifyRelayToken } from "@/server/relay/tokens";
import { log } from "@/server/logger";
import { GET as facts } from "@/app/api/internal/relay/sessions/[sid]/route";
import { POST as beat } from "@/app/api/internal/relay/sessions/[sid]/heartbeat/route";
import { makeCommunityRig, seedOrg, startedDivisionWithFixture } from "./_rig";
import { grantCredits } from "../stream-credits";
import { createStreamTarget } from "../stream-targets";
import { createSession, defaultDeps, heartbeat, sessionFactsForJob, stopSession } from "../stream-sessions";

const HAS_DB = !!process.env.DATABASE_URL;

// A KEK of this file's own (secret-columns.test.ts precedent): CI supplies no RELAY_KEK, and every sealed destination
// and input would otherwise throw "RELAY_KEK is not set". The developer's is put back afterwards, or removed when there
// was none — never assigned `undefined`, which Node stores as the string "undefined". It is never printed.
const savedKek = process.env.RELAY_KEK;
beforeAll(() => { process.env.RELAY_KEK = randomBytes(32).toString("hex"); });
afterAll(() => {
  if (savedKek === undefined) delete process.env.RELAY_KEK;
  else process.env.RELAY_KEK = savedKek;
});

// R2001: a composed start is refused 503 composed_unavailable while RELAY_IMAGE is unset (drivers.ts `composedUnavailable`).
// This file's composed sessions run on the fake runner, which needs no image, so the file names one of its own — put
// back afterwards the KEK's way.
const savedImage = process.env.RELAY_IMAGE;
beforeAll(() => { process.env.RELAY_IMAGE = "registry.fly.io/seazn-relay:internal-routes-test"; });
afterAll(() => {
  if (savedImage === undefined) delete process.env.RELAY_IMAGE;
  else process.env.RELAY_IMAGE = savedImage;
});


/** The exit an OOM-killed Machine reports (Fly's event shape). Its fail reason is DERIVED from the domain's table. */
const OOM_EXIT: ExitInfo = { exitCode: 137, oomKilled: true, requestedStop: false };
/** A storage pool no plausible number of foreign reservations can exhaust — the pool is ONE account across the whole
 *  test database (Task 10 deviation 4), and these tests are not about it. */
const ROOMY_STORAGE_MINUTES = 100_000_000;

type Mode = "composed" | "passthrough";

/** R2004: what a session is created WITH — a sport other than the rig's generic one (a real community division of that
 *  sport), the fixture's stream settings as the organiser left them before the Go live, and the body's own theme. */
type SessionOpts = { sport?: string; settings?: { overlay_delay_ms?: number | null; overlay_template?: string | null }; themeId?: string };

async function session(mode: Mode = "composed", opts: SessionOpts = {}) {
  let auth: Awaited<ReturnType<typeof seedOrg>>["auth"];
  let fixtureId: string;
  // A8: the organiser who starts a stream is a REAL users row (the actor guard refuses a null userId with 403).
  if (opts.sport) {
    const c = await makeCommunityRig(opts.sport);
    auth = { ...c.auth, userId: await rigUser() };
    fixtureId = c.fixtureId;
  } else {
    const seeded = await seedOrg();
    auth = { ...seeded.auth, userId: await rigUser() };
    ({ fixtureId } = await startedDivisionWithFixture(auth));
  }
  for (const key of ["streaming.overlay", "streaming.relay"]) {
    await sql`insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason) values (${auth.orgId}, ${key}, true, 'r1 unit')
              on conflict (org_id, feature_key) do update set bool_value = true`;
  }
  await invalidateOrgEntitlements(auth.orgId);
  await grantCredits({ orgId: auth.orgId, delta: 1, createdBy: await rigUser(), note: "unit", idempotencyKey: randomUUID() });
  const streamKey = `k-${randomUUID().slice(0, 8)}`;
  const target = await createStreamTarget(auth, auth.orgId, { kind: "youtube", label: "T", streamKey });
  // The fake ingest never connects inside a test: a passthrough session stays `warming` until the test moves it.
  const ingest = new FakeIngest({ connectAfterMs: 10 * 60_000 });
  ingest.storage = { totalStorageMinutes: 0, totalStorageMinutesLimit: ROOMY_STORAGE_MINUTES, videoCount: 0 };
  // R2004: the provider's OWN answers, by role — the expected credentials of the facts come from here, never from the
  // route under test or the rows it reads.
  const inputs: { role: string; creds: IngestCredentials }[] = [];
  const createInput = ingest.createLiveInput.bind(ingest);
  ingest.createLiveInput = async (spec) => {
    const creds = await createInput(spec);
    inputs.push({ role: spec.role ?? "camera", creds });
    return creds;
  };
  const runner = new FakeRunner();
  setRelayDriversForTest({ ingest, runner });
  if (opts.settings) {
    await sql`insert into fixture_stream_settings (fixture_id, org_id, overlay_delay_ms, overlay_template)
              values (${fixtureId}, ${auth.orgId}, ${opts.settings.overlay_delay_ms ?? null}, ${opts.settings.overlay_template ?? null})`;
  }
  await pairPresentPhone(fixtureId);   // A7 (capture QR v2 T6): W5 refuses a Go live with no present phone
  const { sessionId } = await createSession(auth, fixtureId, { mode, targetId: target.id, ...(opts.themeId ? { themeId: opts.themeId } : {}) }, defaultDeps("http://app.test"));
  // A passthrough session has no Machine, so no runner ever mints its job token; the 410 case mints one the same way.
  const jobToken = mode === "composed"
    ? runner.created[0]!.jobToken
    : await mintRelayToken({ sid: sessionId, scope: "relay-job", expiresAt: new Date(Date.now() + 60 * 60_000) });
  return { auth, fixtureId, sessionId, jobToken, streamKey, ingest, runner, inputs };
}

const ctx = (sid: string) => ({ params: Promise.resolve({ sid }) });
const url = (sid: string, tail = "") => `http://app.test/api/internal/relay/sessions/${sid}${tail}`;
function req(u: string, init: { method?: string; token?: string; authorization?: string; body?: string } = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.authorization !== undefined) headers.authorization = init.authorization;
  else if (init.token !== undefined) headers.authorization = `Bearer ${init.token}`;
  return new Request(u, { method: init.method ?? "GET", headers, ...(init.body !== undefined ? { body: init.body } : {}) });
}
const getFacts = (sid: string, init: Parameters<typeof req>[1] = {}) => facts(req(url(sid), init), ctx(sid));
const postBeat = (sid: string, body: unknown, init: Parameters<typeof req>[1] = {}) =>
  beat(req(url(sid, "/heartbeat"), { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), ...init }), ctx(sid));

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}
async function samples(sid: string) {
  return sql<{ fps: number | null; bitrate_kbps: number | null; source: string }[]>`
    select fps, bitrate_kbps, source from fixture_stream_samples where session_id = ${sid} order by id`;
}
/** Every typed column of the session's one sample (the numeric ones and the state word). */
async function sampleRow(sid: string) {
  const rows = await sql<{ ingest_state: string | null; bitrate_kbps: number | null; fps: number | null; dropped_frames: number | null;
    runner_cpu_pct: number | null; runner_mem_mb: number | null; encoder_speed: number | null }[]>`
    select ingest_state, bitrate_kbps, fps, dropped_frames, runner_cpu_pct, runner_mem_mb, encoder_speed
      from fixture_stream_samples where session_id = ${sid} order by id`;
  expect(rows, "exactly one sample").toHaveLength(1);
  return rows[0]!;
}
async function egressOf(sid: string): Promise<number> {
  const [r] = await sql<{ n: string }[]>`select egress_bytes::text as n from fixture_stream_sessions where id = ${sid}`;
  return Number(r!.n);
}
/** The two headers a secret-bearing GET owes on EVERY status (Task 11 review I2; the 2026-09-22 edge review's F-CF1). */
function expectNoStore(res: Response, label: string) {
  expect(res.headers.get("cache-control"), `${label}: Cache-Control`).toMatch(/(^|,\s*)no-store(\s*,|$)/);
  expect(res.headers.get("vary") ?? "", `${label}: Vary`).toMatch(/(^|,\s*)authorization(\s*,|$)/i);
}

async function row(sid: string) {
  const [r] = await sql<{
    state: string; fail_reason: string | null; end_reason: string | null; desired_state: string; heartbeat_at: string | null;
    runner_state: string; machine_id: string | null;
    runner_exit_code: number | null; runner_oom_killed: boolean | null; runner_requested_stop: boolean | null;
    runner_crash_count: number; runner_crash_beats: number; runner_crash_exits: number;
  }[]>`select state, fail_reason, end_reason, desired_state, heartbeat_at, runner_state, machine_id,
              runner_exit_code, runner_oom_killed, runner_requested_stop, runner_crash_count, runner_crash_beats, runner_crash_exits
         from fixture_stream_sessions where id = ${sid}`;
  return r!;
}

afterEach(() => setRelayDriversForTest(null));
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("internal relay routes", () => {
  it("GET facts: 401 without a bearer, 401 with a page token, 200 with the job token — and the page token it hands out is a PAGE token for this session", async () => {
    const s = await session();
    expect((await getFacts(s.sessionId)).status).toBe(401);
    const page = await mintRelayToken({ sid: s.sessionId, scope: "relay-page", expiresAt: new Date(Date.now() + 60_000) });
    expect((await getFacts(s.sessionId, { token: page })).status).toBe(401);
    const ok = await getFacts(s.sessionId, { token: s.jobToken });
    expect(ok.status).toBe(200);
    const body = (await json(ok)) as { ok: boolean; data: { sessionId: string; fixtureId: string; mode: string; maxDurationMinutes: number; target: { url: string; streamKey: string }; pageToken: string } };
    expect(body.ok).toBe(true);
    expect(body.data).toMatchObject({ sessionId: s.sessionId, fixtureId: s.fixtureId, mode: "composed", maxDurationMinutes: MAX_DURATION_MINUTES });
    // R2004: a composed Machine publishes to the session's PROGRAMME input — the provider's own answer for it, decrypted —
    // and never sees the destination, which is a Cloudflare output on that input.
    const programme = s.inputs.find((i) => i.role === "programme")!.creds;
    expect(body.data.target).toEqual({ url: programme.rtmps.url, streamKey: programme.rtmps.streamKey });
    expect(JSON.stringify(body), "the destination key is nowhere in a composed body").not.toContain(s.streamKey);
    // Passthrough keeps today's shape: the DECRYPTED destination, compared with what the organiser saved (the key) and
    // the platform's preset url (D6: the server fills it) — not with anything the route computed.
    const p = await session("passthrough");
    const pt = (await json(await getFacts(p.sessionId, { token: p.jobToken }))) as { data: { target: { url: string; streamKey: string } } };
    expect(pt.data.target.streamKey).toBe(p.streamKey);
    expect(pt.data.target.url).toBe(STREAM_PLATFORM_PRESETS.youtube);
    // The page token is judged by the REAL verifier: a page credential for this sid, and never a job one.
    await expect(verifyRelayToken(body.data.pageToken, { sid: s.sessionId, scope: "relay-page" })).resolves.toMatchObject({ sid: s.sessionId });
    await expect(verifyRelayToken(body.data.pageToken, { sid: s.sessionId, scope: "relay-job" })).rejects.toMatchObject({ status: 401 });
  });

  it("the 401 gate: every refused credential is ONE 401 (same code, same sentence) on BOTH routes, writes nothing, and sits beside the job token's 200", async () => {
    const s = await session();
    const other = await session();   // a REAL other session's job token — the wrong-session case is a genuine credential
    setRelayDriversForTest({ ingest: s.ingest, runner: s.runner });   // `session()` installed OTHER's drivers; s's Machine lives in s.runner
    const [h, p, sig] = s.jobToken.split(".");
    const forgedClaims = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p!, "base64url").toString()), sid: other.sessionId })).toString("base64url");
    const mid = Math.floor(sig!.length / 2);
    const cases: [string, { token?: string; authorization?: string }][] = [
      ["no Authorization header", {}],
      ["a non-Bearer scheme", { authorization: `Basic ${s.jobToken}` }],
      ["an empty Bearer", { authorization: "Bearer " }],
      ["a signature altered mid-string", { token: `${h}.${p}.${sig!.slice(0, mid)}${sig![mid] === "A" ? "B" : "A"}${sig!.slice(mid + 1)}` }],
      ["claims swapped under the original signature", { token: `${h}.${forgedClaims}.${sig}` }],
      ["an expired job token", { token: await mintRelayToken({ sid: s.sessionId, scope: "relay-job", expiresAt: new Date(Date.now() - 1000) }) }],
      ["another session's job token", { token: other.jobToken }],
      ["this session's PAGE token", { token: await mintRelayToken({ sid: s.sessionId, scope: "relay-page", expiresAt: new Date(Date.now() + 60_000) }) }],
    ];
    const bodies = new Set<string>();
    let checked = 0;
    for (const [label, auth] of cases) {
      for (const [route, call] of [
        ["facts", () => getFacts(s.sessionId, auth)],
        ["heartbeat", () => postBeat(s.sessionId, { state: "playing", fps: 30 }, auth)],
      ] as const) {
        const res = await call();
        expect(res.status, `${route}: ${label}`).toBe(401);
        const b = await json(res);
        expect(b, `${route}: ${label}`).toMatchObject({ ok: false, code: "RELAY_TOKEN_INVALID" });
        bodies.add(JSON.stringify(b));
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: every case on both routes").toBe(cases.length * 2);
    // The gate runs BEFORE the body is read: a caller with no credential is 401 whatever it posted, never a 400 that
    // describes the schema to someone who was never allowed to send it.
    const unauthenticatedGarbage = await postBeat(s.sessionId, { state: "dancing" }, {});
    expect(unauthenticatedGarbage.status).toBe(401);
    bodies.add(JSON.stringify(await json(unauthenticatedGarbage)));
    // ONE refusal — a verifier (or a gate in front of it) that words its reasons differently is an oracle.
    expect([...bodies]).toHaveLength(1);
    // Nothing a refused caller sent was recorded: no beat, no sample.
    expect(await samples(s.sessionId)).toEqual([]);
    expect((await row(s.sessionId)).heartbeat_at).toBeNull();
    // The positive pair, same session, same routes: the job token is admitted by both.
    expect((await getFacts(s.sessionId, { token: s.jobToken })).status).toBe(200);
    expect((await postBeat(s.sessionId, { state: "starting" }, { token: s.jobToken })).status).toBe(200);
    // The bearer scheme is case-insensitive (RFC 9110 §11.1) — a Machine's HTTP client may lower-case it.
    expect((await getFacts(s.sessionId, { authorization: `bearer ${s.jobToken}` })).status).toBe(200);
  });

  it("POST heartbeat: malformed, non-JSON, empty and exit-carrying bodies are 400 and write nothing; a good one is 200 { desiredState }", async () => {
    const s = await session();
    const bad: [string, unknown][] = [
      ["an out-of-enum state", { state: "dancing" }],
      ["not JSON", "not json"],
      ["an empty body", ""],
      ["an empty object (state is required)", {}],
      // A5: the beat is NOT a carrier of exit facts — RelayHeartbeat is strict, so a Machine cannot post one.
      ["exit facts on a beat", { state: "stopped", lastExit: OOM_EXIT }],
      ["a negative fps", { state: "playing", fps: -1 }],
    ];
    let checked = 0;
    for (const [label, body] of bad) {
      const res = await postBeat(s.sessionId, body, { token: s.jobToken });
      expect(res.status, label).toBe(400);
      expect((await json(res)).ok, label).toBe(false);
      checked += 1;
    }
    expect(checked).toBe(bad.length);
    expect(await samples(s.sessionId), "a refused body is not a sample").toEqual([]);
    expect((await row(s.sessionId)).runner_exit_code).toBeNull();
    const good = await postBeat(s.sessionId, { state: "starting", fps: 0 }, { token: s.jobToken });
    expect(good.status).toBe(200);
    expect(((await json(good)) as { data: unknown }).data).toEqual({ desiredState: "live" });
    expect(await samples(s.sessionId)).toHaveLength(1);
  });

  it("ruling 13: a heartbeat through the ROUTE writes one sample row carrying the POSTED fps and bitrate", async () => {
    const s = await session();
    // Distinctive values: a route that drops a field, or substitutes a default, cannot land on 47/3100 by accident.
    const res = await postBeat(s.sessionId, { state: "playing", fps: 47, bitrateKbps: 3100 }, { token: s.jobToken });
    expect(res.status).toBe(200);
    const rows = await samples(s.sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ source: "heartbeat", fps: 47, bitrate_kbps: 3100 });
  });

  // Task 11 review I1a. ffmpeg reports bitrate=2998.7kbits/s; a Machine's memory and a dropped-frame counter are whatever
  // its supervisor reads. RelayHeartbeat accepts them (finite, non-negative), and the beat must too — the lifecycle half
  // included. Expected stored values are Postgres's own: its numeric→integer cast, int4's largest, float32's largest.
  it("real ffmpeg numbers through the ROUTE: a fractional bitrate and memory, a 29.97 fps and a counter past int4 are 200 with the lifecycle applied, and land fitted to their columns", async () => {
    const s = await session();
    const sent = { state: "playing", fps: 29.97, bitrateKbps: 2998.7, memMb: 511.7, droppedFrames: 3e9, cpuPct: 1e39, encoderSpeed: 1e-50 };
    const res = await postBeat(s.sessionId, sent, { token: s.jobToken });
    expect(res.status).toBe(200);
    expect(((await json(res)) as { data: unknown }).data).toEqual({ desiredState: "live" });
    expect(await row(s.sessionId), "callback_playing ran: the beat's lifecycle half was not skipped").toMatchObject({ state: "live", runner_state: "playing" });
    const [cast] = await sql<{ bitrate: number; mem: number }[]>`select 2998.7::numeric::integer as bitrate, 511.7::numeric::integer as mem`;
    const stored = await sampleRow(s.sessionId);
    expect(stored).toMatchObject({ ingest_state: "playing", bitrate_kbps: cast!.bitrate, runner_mem_mb: cast!.mem, dropped_frames: 2147483647, encoder_speed: 0 });
    expect(Math.fround(stored.fps!)).toBe(Math.fround(29.97));
    expect(Math.fround(stored.runner_cpu_pct!)).toBe(Math.fround(3.4028234663852886e38));
    // The raw body keeps what the Machine actually said — only the TYPED columns are fitted.
    const [{ raw }] = await sql<{ raw: Record<string, unknown> }[]>`select raw from fixture_stream_samples where session_id = ${s.sessionId}`;
    expect(raw).toMatchObject({ bitrateKbps: 2998.7, memMb: 511.7, droppedFrames: 3e9 });
  });

  // Task 11 review I1b. A sample is telemetry; the beat is the control channel. A failing sample write is logged and the
  // beat still answers — callback_playing included — and the beat itself (heartbeat_at) is still recorded.
  it("a sample write that FAILS never costs the beat its lifecycle: 200 { desiredState }, callback_playing applied, the beat recorded, no sample", async () => {
    const s = await session();
    expect(await row(s.sessionId)).toMatchObject({ state: "warming", runner_state: "booting" });
    vi.mocked(recordSample).mockRejectedValueOnce(Object.assign(new Error("invalid input syntax for type integer"), { code: "22P02" }));
    const res = await postBeat(s.sessionId, { state: "playing", fps: 30 }, { token: s.jobToken });
    expect(res.status).toBe(200);
    expect(((await json(res)) as { data: unknown }).data).toEqual({ desiredState: "live" });
    const after = await row(s.sessionId);
    expect(after).toMatchObject({ state: "live", runner_state: "playing" });
    expect(after.heartbeat_at, "the beat itself is recorded").not.toBeNull();
    expect(await samples(s.sessionId), "the failed write left no row").toEqual([]);
    expect(vi.mocked(recordSample)).toHaveBeenCalled();
    // The positive pair: the next beat samples normally.
    expect((await postBeat(s.sessionId, { state: "playing", fps: 31 }, { token: s.jobToken })).status).toBe(200);
    expect((await samples(s.sessionId)).map((r) => r.fps)).toEqual([31]);
  });

  // Task 11 review G5: `egressBytes` is optional, and an omitted field is NOT a measured zero.
  // Owed 37 (compositor PR #27): within ONE attempt the stored count never goes backwards — a lower count is a beat that
  // was overtaken (the final beat rides its own lane), so the GREATEST is kept. A NEW attempt's measured zero still
  // stores 0: "Owed 37 … a NEW attempt after an old one stopped writes normally" below is that half of G5.
  it("egressBytes: a beat that reports it stores it; a beat that OMITS it leaves the stored value alone; within one attempt a LOWER count (a 0 included) never moves it backwards", async () => {
    const s = await session();
    expect(await egressOf(s.sessionId), "the column's default before any beat").toBe(0);
    const steps: [Record<string, unknown>, number][] = [
      [{ state: "playing", egressBytes: 5_000_000 }, 5_000_000],
      [{ state: "playing" }, 5_000_000],
      [{ state: "playing", fps: 30 }, 5_000_000],
      [{ state: "playing", egressBytes: 3_000_000 }, 5_000_000],     // overtaken: never backwards
      [{ state: "playing", egressBytes: 7_250_000 }, 7_250_000],
      [{ state: "playing", egressBytes: 0 }, 7_250_000],             // a zero on the SAME attempt is not a decrease either
    ];
    let checked = 0;
    for (const [body, expected] of steps) {
      expect((await postBeat(s.sessionId, body, { token: s.jobToken })).status, JSON.stringify(body)).toBe(200);
      expect(await egressOf(s.sessionId), JSON.stringify(body)).toBe(expected);
      checked += 1;
    }
    expect(checked).toBe(steps.length);
  });

  // Task 11 review I2: the facts GET carries the DECRYPTED stream key and a page token, gated only by the bearer. An edge
  // that cached one 200 would serve it to the next caller whatever they sent — so no-store + Vary: Authorization, on
  // every status the route answers.
  it("GET facts is no-store + Vary: Authorization on the 200 (the decrypted key), the 401 and the 410", async () => {
    const s = await session();
    const ok = await getFacts(s.sessionId, { token: s.jobToken });
    expect(ok.status).toBe(200);
    // R2004: composed facts carry the programme input's decrypted key (a secret all the same), never the destination's.
    expect(((await json(ok)) as { data: { target: { streamKey: string } } }).data.target.streamKey).toBe(s.inputs.find((i) => i.role === "programme")!.creds.rtmps.streamKey);
    expectNoStore(ok, "200");
    const refused = await getFacts(s.sessionId);
    expect(refused.status).toBe(401);
    expectNoStore(refused, "401");
    const p = await session("passthrough");
    await stopSession(p.auth, p.fixtureId, p.sessionId, defaultDeps("http://app.test"));
    const gone = await getFacts(p.sessionId, { token: p.jobToken });
    expect(gone.status).toBe(410);
    expectNoStore(gone, "410");
  });

  // Re-review N3: the forced-destroy catch is narrowed to the PROVIDER call. Only the Fly DELETE failing is "recorded,
  // alarmed, not the reader's error"; if the LEDGER write that records it fails too, nothing recorded it — that is a
  // database fault, and it is thrown on (the wrapper's own Sentry call reports it), never swallowed. Driven through the
  // Machine's own read (the facts usecase) at the grace-expired completion, where the forced destroy runs.
  it("N3: a forced destroy whose provider call fails AND whose ledger write fails is thrown — the ledger error, not the provider's, which rides as its cause (r2-m1) — and is not treated as a provider failure", async () => {
    const providerFailure = Object.assign(new Error("fake destroy failed"), { status: 503 });
    /** A live composed session one look away from its grace-expired completion, on a runner whose DELETE fails. */
    const atTheBrink = async () => {
      const x = await session();
      expect((await postBeat(x.sessionId, { state: "playing" }, { token: x.jobToken })).status).toBe(200);
      await sql`update fixture_stream_sessions set state = 'ending', desired_state = 'ending', end_reason = 'stopped', ending_at = now(), runner_state = 'stopping',
                    runner_stop_requested_at = now() - make_interval(secs => ${RUNNER_STOP_GRACE_SECONDS + RUNNER_OBSERVE_SLACK_SECONDS + 1}) where id = ${x.sessionId}`;
      setRelayDriversForTest({ ingest: x.ingest, runner: Object.assign(Object.create(x.runner) as FakeRunner, { async destroy() { throw providerFailure; } }) });
      return x;
    };
    const s = await atTheBrink();
    const ledgerFailure = Object.assign(new Error("could not write the effect row"), { code: "57P01" });
    const real = vi.mocked(recordEvent).getMockImplementation()!;
    let refused = 0;
    vi.mocked(recordEvent).mockImplementation(async (tx, e) => {
      if (e.type === "force_destroy" && e.result === "failed") { refused += 1; throw ledgerFailure; }
      return real(tx, e);
    });
    sentry.captureError.mockClear();
    try {
      const err = await sessionFactsForJob(s.sessionId, s.jobToken, defaultDeps("http://app.test")).catch((e: unknown) => e);
      expect(err, "the LEDGER failure reaches the caller").toBe(ledgerFailure);
      // r2-m1: …carrying the PROVIDER's failure as its cause, so the wrapper's one report still says a DELETE failed and
      // a Machine may be running — the alarm forceDestroy would have raised is not lost with the ledger row.
      expect((err as Error).cause, "the provider failure rides as cause").toBe(providerFailure);
    } finally {
      vi.mocked(recordEvent).mockImplementation(real);
    }
    expect(refused, "the failed-destroy ledger write was attempted").toBe(1);
    expect(sentry.captureError, "not reported as a provider failure — the wrapper reports what is thrown").not.toHaveBeenCalled();
    // The positive pair, a second session at the same brink with the ledger working: the same failed DELETE is recorded,
    // alarmed once and answered — the completed session's credential is refused 410, never a 500.
    const t = await atTheBrink();
    const answered = await getFacts(t.sessionId, { token: t.jobToken });
    expect(answered.status).toBe(410);
    expect(sentry.captureError).toHaveBeenCalledTimes(1);
    expect(sentry.captureError.mock.calls[0]![0]).toBe(providerFailure);
    const [{ result }] = await sql<{ result: string }[]>`
      select result from fixture_stream_events where session_id = ${t.sessionId} and kind = 'effect' and type = 'force_destroy'`;
    expect(result).toBe("failed");
  });

  it("second call: a replayed beat is answered the same and recorded twice (every beat is a sample); a replayed read serves the same facts", async () => {
    const s = await session();
    const a = await postBeat(s.sessionId, { state: "starting", fps: 12 }, { token: s.jobToken });
    const b = await postBeat(s.sessionId, { state: "starting", fps: 12 }, { token: s.jobToken });
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await json(b)).toEqual(await json(a));
    expect((await samples(s.sessionId)).map((r) => r.fps)).toEqual([12, 12]);
    const f1 = ((await json(await getFacts(s.sessionId, { token: s.jobToken }))) as { data: Record<string, unknown> }).data;
    const f2 = ((await json(await getFacts(s.sessionId, { token: s.jobToken }))) as { data: Record<string, unknown> }).data;
    // The page token is minted per read (its iat moves with the clock's second), and a composed overlayUrl carries it as
    // `st` — so both are compared as "the read's own token", and everything else must be identical.
    const minted = (f: Record<string, unknown>) => {
      const u = new URL(String(f.overlayUrl));
      expect(u.searchParams.get("st"), "the URL's st is this read's page token").toBe(f.pageToken);
      u.searchParams.set("st", "<page token>");
      return { ...f, pageToken: null, overlayUrl: u.toString() };
    };
    expect(minted(f2)).toEqual(minted(f1));
    expect(Object.keys(f1).length).toBeGreaterThan(1);
  });

  // A5 (lane-b carry 4), end to end through the two routes. The exit is PERSISTED by the facts route's own reconcile
  // (jobSession → reconcileSession → the domain's lastExit → persist's three runner_exit_* columns); the beat route then
  // lands a beat; the exit must still be there for failReasonFromExit when the teardown is finally confirmed.
  it("A5 through the routes: an exit the facts route recorded survives a beat through the heartbeat route, and the session fails with the EXIT's reason", async () => {
    const s = await session();
    expect((await postBeat(s.sessionId, { state: "playing" }, { token: s.jobToken })).status).toBe(200);
    expect((await row(s.sessionId)).state).toBe("live");
    // Attempt 1 dies uncleanly; the Machine's own facts read notices, and the ONE retry boots.
    s.runner.setObserved((await row(s.sessionId)).machine_id!, "failed", { exitCode: 1, oomKilled: false, requestedStop: false });
    expect((await getFacts(s.sessionId, { token: s.jobToken })).status).toBe(200);
    expect(s.runner.created).toHaveLength(RUNNER_MAX_ATTEMPTS);
    const second = (await row(s.sessionId)).machine_id!;
    // The last attempt is OOM-killed and its teardown fails once: the exit is persisted, the runner is lost.
    s.runner.setObserved(second, "failed", OOM_EXIT);
    const failing = Object.assign(Object.create(s.runner) as FakeRunner, {
      async destroy() { throw Object.assign(new Error("fake destroy failed"), { status: 503 }); },
    });
    setRelayDriversForTest({ ingest: s.ingest, runner: failing });
    // Task 11 review m5: the failed teardown is recorded on the ledger and retried by the table (a stale beat re-issues a
    // lost runner's destroy) — it is not the READER's error. The Machine's read answers its facts.
    expect((await getFacts(s.sessionId, { token: s.jobToken })).status).toBe(200);
    const [{ result }] = await sql<{ result: string }[]>`
      select result from fixture_stream_events where session_id = ${s.sessionId} and kind = 'effect' and type = 'force_destroy' order by seq desc limit 1`;
    expect(result, "the failed destroy is on the ledger").toBe("failed");
    expect(await row(s.sessionId)).toMatchObject({
      state: "live", runner_state: "lost",
      runner_exit_code: OOM_EXIT.exitCode, runner_oom_killed: OOM_EXIT.oomKilled, runner_requested_stop: OOM_EXIT.requestedStop,
    });
    // The lost Machine is still up and still beating — through the ROUTE this time.
    setRelayDriversForTest({ ingest: s.ingest, runner: s.runner });
    const late = await postBeat(s.sessionId, { state: "playing", fps: 30 }, { token: s.jobToken });
    expect(late.status).toBe(200);
    expect(await row(s.sessionId), "the beat route never writes the exit columns").toMatchObject({
      runner_exit_code: OOM_EXIT.exitCode, runner_oom_killed: OOM_EXIT.oomKilled, runner_requested_stop: OOM_EXIT.requestedStop,
    });
    // The teardown is re-issued the way production re-issues it — the beat window runs out (age BOTH anchors, G1) —
    // and the Machine's next read confirms it: the session fails on the EXIT, and the read is 410 from then on.
    await sql`update fixture_stream_sessions set heartbeat_at = now() - make_interval(secs => ${STALE_HEARTBEAT_SECONDS + 30}),
                  beat_window_at = now() - make_interval(secs => ${STALE_HEARTBEAT_SECONDS + 30}) where id = ${s.sessionId}`;
    const ended = await getFacts(s.sessionId, { token: s.jobToken });
    expect(ended.status).toBe(410);
    expect(await json(ended)).toMatchObject({ ok: false, code: "SESSION_ENDED" });
    expect(s.runner.destroyed).toContain(second);
    const final = await row(s.sessionId);
    expect(final).toMatchObject({ state: "failed", fail_reason: failReasonFromExit(OOM_EXIT) });
    expect(final.fail_reason, "the differential: a lost exit reads as the default").not.toBe(failReasonFromExit(null));
  });

  it("after a stop: the beat's reply turns to `ending` (the control channel), and a terminal session answers 410 SESSION_ENDED on both routes", async () => {
    // Composed: the stop is a DESIRED state the Machine learns from its next beat.
    const c = await session("composed");
    expect((await postBeat(c.sessionId, { state: "playing" }, { token: c.jobToken })).status).toBe(200);
    await stopSession(c.auth, c.fixtureId, c.sessionId, defaultDeps("http://app.test"));
    const told = await postBeat(c.sessionId, { state: "playing" }, { token: c.jobToken });
    expect(told.status).toBe(200);
    expect(((await json(told)) as { data: unknown }).data).toEqual({ desiredState: "ending" });
    expect((await row(c.sessionId)).desired_state).toBe("ending");
    // The Machine obeys: it reports `stopped`, and its Machine is gone by the next look (the fake auto-destroys a clean
    // SIGINT exit, as both R0 soaks did). The session completes as STOPPED — never a failure — and the credential is
    // refused 410 from then on. (Completing it here also keeps this suite from leaving an `ending` row with a stop
    // mark behind: the expiry policy counts such a row as a storage reservation at ANY later instant, which moves the
    // measured baseline of a concurrently running pool test — stream-sessions.test.ts's C3 + B.)
    expect((await postBeat(c.sessionId, { state: "stopped" }, { token: c.jobToken })).status).toBe(200);
    const gone = await getFacts(c.sessionId, { token: c.jobToken });
    expect(gone.status).toBe(410);
    expect(await row(c.sessionId)).toMatchObject({ state: "completed", end_reason: "stopped", fail_reason: null });
    // Passthrough: a stop completes at once (design §6.3), so the SAME credential is refused 410 from then on.
    const p = await session("passthrough");
    expect((await getFacts(p.sessionId, { token: p.jobToken })).status).toBe(200);
    await stopSession(p.auth, p.fixtureId, p.sessionId, defaultDeps("http://app.test"));
    expect((await row(p.sessionId)).state).toBe("completed");
    let checked = 0;
    for (const res of [await getFacts(p.sessionId, { token: p.jobToken }), await postBeat(p.sessionId, { state: "playing" }, { token: p.jobToken })]) {
      expect(res.status).toBe(410);
      expect(await json(res)).toMatchObject({ ok: false, code: "SESSION_ENDED" });
      checked += 1;
    }
    expect(checked).toBe(2);
    expect(await samples(p.sessionId), "a beat on an ended session is not recorded").toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// R2002: the relay-job.v1 contract through the REAL routes. The bodies are the contract's own hand-written vectors
// (docs/contracts/fixtures/relay-job.v1), so what is posted here is exactly what the compositor vendors and sends.
// ---------------------------------------------------------------------------------------------------------------
const CONTRACT_FIXTURES = resolve(import.meta.dirname, "../../../../../../docs/contracts/fixtures/relay-job.v1");
const vector = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(resolve(CONTRACT_FIXTURES, `${name}.json`), "utf8")) as Record<string, unknown>;
/** The fields R2 adds to the beat, typed from compositor spec 2026-10-14 §5.3 / C06 `HealthReport` / C07 `heartbeat_wire`. */
const R2_HEALTH_FIELDS = ["programmePhase", "input", "output", "graphics", "inputKicks", "inputKickAlert", "pipelineRebuilds", "sinkSwaps", "rung", "scoreStale",
  // R2007 PR B (overlay templates spec 2026-10-15 §4.3): which channel the overlay page reads its phase from.
  "phaseChannel"];
/** The final beat's (owner scope addition 2026-10-15; C06 `ExitReason`) — only ever with `state: "stopped"` (review M6). */
const EXIT_FIELDS = ["exitReason", "exitDetail"];
const R2_BEAT_FIELDS = [...R2_HEALTH_FIELDS, ...EXIT_FIELDS];
/** Spec §5.3: the keys only a composed session carries (R2004 serves them). */
const COMPOSED_ONLY = ["input", "output", "heartbeatIntervalMs", "overlayUrl"];

/** Store 1: the whole latest body (`fixture_stream_sessions.last_heartbeat`). */
async function lastHeartbeat(sid: string): Promise<Record<string, unknown> | null> {
  const [r] = await sql<{ last_heartbeat: Record<string, unknown> | null }[]>`select last_heartbeat from fixture_stream_sessions where id = ${sid}`;
  return r!.last_heartbeat;
}
/** Store 2: the NEWEST sample's raw (`fixture_stream_samples.raw`, the sanitised body), and how many samples exist. */
async function newestRaw(sid: string): Promise<{ raw: Record<string, unknown>; fps: number | null; n: number }> {
  const rows = await sql<{ raw: Record<string, unknown>; fps: number | null }[]>`
    select raw, fps from fixture_stream_samples where session_id = ${sid} and source = 'heartbeat' order by id desc`;
  expect(rows.length, "a sample exists").toBeGreaterThan(0);
  return { raw: rows[0]!.raw, fps: rows[0]!.fps, n: rows.length };
}

describe.skipIf(!HAS_DB)("R2002: the relay-job.v1 contract through the internal routes", () => {
  it("heartbeat-full through the ROUTE is 200 { desiredState }, and each R2 field round-trips in BOTH stores — last_heartbeat and the newest sample's raw", async () => {
    const s = await session();
    const full = vector("heartbeat-full");
    for (const k of R2_HEALTH_FIELDS) expect(full, `premise: the vector carries ${k}`).toHaveProperty(k);
    const res = await postBeat(s.sessionId, full, { token: s.jobToken });
    expect(res.status).toBe(200);
    expect(((await json(res)) as { data: unknown }).data).toEqual({ desiredState: "live" });
    const stored = await lastHeartbeat(s.sessionId);
    const { raw } = await newestRaw(s.sessionId);
    let checked = 0;
    for (const k of R2_HEALTH_FIELDS) {
      expect(stored, `last_heartbeat.${k}`).toHaveProperty(k, full[k]);
      expect(raw, `samples.raw.${k}`).toHaveProperty(k, full[k]);
      checked += 2;
    }
    expect(checked, "anti-vacuity: eleven fields, two stores (the exit fields are the final beat's test below)").toBe(22);
    // The whole body, both stores — the R1 facts beside the R2 ones (ruling 13: the whole body in raw).
    expect(stored).toEqual(full);
    expect(raw).toEqual(full);
  });

  it("heartbeat-minimal: every R2 field is an ABSENT key in both stores — never null, never 0 — on a fresh session AND after a full beat (the latest body is replaced, never merged; the history keeps the earlier beat)", async () => {
    const minimal = vector("heartbeat-minimal");
    expect(Object.keys(minimal), "premise: state alone").toEqual(["state"]);
    const expectAbsent = (row: Record<string, unknown> | null, label: string): number => {
      expect(row, label).not.toBeNull();
      let n = 0;
      for (const k of R2_BEAT_FIELDS) {
        expect(row, `${label}: ${k} is not a key`).not.toHaveProperty(k);
        n++;
      }
      expect(Object.keys(row!), `${label}: state alone`).toEqual(["state"]);
      return n;
    };
    // A fresh session: the first beat it ever stores is the minimal one.
    const fresh = await session();
    expect((await postBeat(fresh.sessionId, minimal, { token: fresh.jobToken })).status).toBe(200);
    let checked = expectAbsent(await lastHeartbeat(fresh.sessionId), "fresh last_heartbeat");
    checked += expectAbsent((await newestRaw(fresh.sessionId)).raw, "fresh samples.raw");
    // The sequence: a full beat, then the minimal one. A stale carry-over (a merge into last_heartbeat) would show here.
    const s = await session();
    expect((await postBeat(s.sessionId, vector("heartbeat-full"), { token: s.jobToken })).status).toBe(200);
    expect((await postBeat(s.sessionId, minimal, { token: s.jobToken })).status).toBe(200);
    checked += expectAbsent(await lastHeartbeat(s.sessionId), "after full, last_heartbeat");
    const newest = await newestRaw(s.sessionId);
    checked += expectAbsent(newest.raw, "after full, the newest samples.raw");
    expect(checked, "anti-vacuity: thirteen fields, four reads").toBe(52);
    // The positive pair: the earlier sample still carries the full beat's fields — absence above is not a lost write.
    expect(newest.n).toBe(2);
    const [{ raw: first }] = await sql<{ raw: Record<string, unknown> }[]>`
      select raw from fixture_stream_samples where session_id = ${s.sessionId} and source = 'heartbeat' order by id asc limit 1`;
    for (const k of R2_HEALTH_FIELDS) expect(first, `the earlier sample keeps ${k}`).toHaveProperty(k);
  });

  it("a present 0 is a measurement: heartbeat-zero-is-a-measurement stores fps 0 (typed column too), and zero counters store 0 — the differential to the absent case above", async () => {
    const s = await session();
    expect((await postBeat(s.sessionId, vector("heartbeat-zero-is-a-measurement"), { token: s.jobToken })).status).toBe(200);
    expect(await lastHeartbeat(s.sessionId)).toHaveProperty("fps", 0);
    const zero = await newestRaw(s.sessionId);
    expect(zero.raw).toHaveProperty("fps", 0);
    expect(zero.fps, "the typed column is 0, not NULL").toBe(0);
    const counters = { state: "playing", inputKicks: 0, pipelineRebuilds: 0, sinkSwaps: 0, inputKickAlert: false, scoreStale: false };
    expect((await postBeat(s.sessionId, counters, { token: s.jobToken })).status).toBe(200);
    const stored = await lastHeartbeat(s.sessionId);
    const { raw } = await newestRaw(s.sessionId);
    let checked = 0;
    for (const [k, v] of Object.entries(counters)) {
      expect(stored, `last_heartbeat.${k}`).toHaveProperty(k, v);
      expect(raw, `samples.raw.${k}`).toHaveProperty(k, v);
      checked++;
    }
    expect(checked).toBe(6);
  });

  it("heartbeat-invalid-unknown-field is a 400 and writes nothing; the minimal beat beside it is 200 { desiredState } (strict, not stripping)", async () => {
    const s = await session();
    const bad = await postBeat(s.sessionId, vector("heartbeat-invalid-unknown-field"), { token: s.jobToken });
    expect(bad.status).toBe(400);
    expect((await json(bad)).ok).toBe(false);
    expect(await samples(s.sessionId), "a refused body is not a sample").toEqual([]);
    expect(await lastHeartbeat(s.sessionId), "a refused body is not the latest beat").toBeNull();
    const good = await postBeat(s.sessionId, vector("heartbeat-minimal"), { token: s.jobToken });
    expect(good.status).toBe(200);
    expect(((await json(good)) as { data: unknown }).data).toEqual({ desiredState: "live" });
    expect(await samples(s.sessionId)).toHaveLength(1);
  });

  // R2007 PR B (overlay templates spec 2026-10-15 §6, R2002 row): before it, the strict beat refused `final` AND the
  // unknown phaseChannel key, so the whole hold — and the final exit beat after it — was a 400 and recorded nothing.
  it("R2007 PR B: heartbeat-final-hold through the ROUTE is 200 { desiredState }; programmePhase `final` and phaseChannel `loopback` round-trip in BOTH stores — then the final EXIT beat, still in `final`, keeps its reason in both", async () => {
    const s = await session();
    const hold = vector("heartbeat-final-hold");
    expect(hold, "premise: the hold, on the primary channel").toEqual({ state: "playing", programmePhase: "final", phaseChannel: "loopback" });
    const res = await postBeat(s.sessionId, hold, { token: s.jobToken });
    expect(res.status).toBe(200);
    expect(((await json(res)) as { data: unknown }).data).toEqual({ desiredState: "live" });
    const stored = await lastHeartbeat(s.sessionId);
    const { raw } = await newestRaw(s.sessionId);
    let checked = 0;
    for (const k of ["programmePhase", "phaseChannel"]) {
      expect(stored, `last_heartbeat.${k}`).toHaveProperty(k, hold[k]);
      expect(raw, `samples.raw.${k}`).toHaveProperty(k, hold[k]);
      checked += 2;
    }
    expect(checked, "anti-vacuity: two fields, two stores").toBe(4);
    expect(stored).toEqual(hold);
    expect(raw).toEqual(hold);
    // The sequence the owner ruled on: the hold, then the Machine's last beat — stopped, still `final`, with its reason.
    const exitBeat = { state: "stopped", programmePhase: "final", phaseChannel: "loopback", exitReason: "ended" };
    expect((await postBeat(s.sessionId, exitBeat, { token: s.jobToken })).status, "the final exit beat").toBe(200);
    expect(await lastHeartbeat(s.sessionId), "last_heartbeat is the exit beat, whole").toEqual(exitBeat);
    const newest = await newestRaw(s.sessionId);
    expect(newest.raw, "the newest sample is the exit beat, whole").toEqual(exitBeat);
    expect(newest.n, "both beats are samples").toBe(2);
  });

  it("R2007 PR B: an unknown phase is still a 400, and so is a phaseChannel outside its two words (heartbeat-invalid-phase-channel) — each writes nothing; the hold beside them is 200", async () => {
    const s = await session();
    let refused = 0;
    for (const bad of [{ state: "playing", programmePhase: "paused" }, vector("heartbeat-invalid-phase-channel")]) {
      const res = await postBeat(s.sessionId, bad, { token: s.jobToken });
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect((await json(res)).ok).toBe(false);
      refused++;
    }
    expect(refused).toBe(2);
    expect(await samples(s.sessionId), "a refused body is not a sample").toEqual([]);
    expect(await lastHeartbeat(s.sessionId), "a refused body is not the latest beat").toBeNull();
    // The positive pair: the hold heartbeat-invalid-phase-channel was cut from (one field) is admitted and recorded.
    expect((await postBeat(s.sessionId, vector("heartbeat-final-hold"), { token: s.jobToken })).status).toBe(200);
    expect(await samples(s.sessionId)).toHaveLength(1);
  });

  // Owner scope addition (2026-10-15): the final beat carries the exit reason, recorded in both beat stores. The runner's
  // own exit columns are written from the OBSERVED exit (A5), never from a beat. What web DOES with each reason is R2003's
  // (the describe block "R2003: the final beat's exit reason" below); this test keeps the record and the one reaction
  // that inverted when R2003 landed — a fatal run is no longer a stop.
  it("heartbeat-final-fatal through the ROUTE: exitReason and exitDetail land in BOTH stores; the runner's exit columns are not the beat's to write", async () => {
    const s = await session();
    const fatal = vector("heartbeat-final-fatal");
    expect(fatal, "premise").toMatchObject({ state: "stopped", exitReason: "fatal" });
    const res = await postBeat(s.sessionId, fatal, { token: s.jobToken });
    expect(res.status).toBe(200);
    // The reply is a reply (its value after a stopped beat is R2003's to decide, not this test's).
    const reply = ((await json(res)) as { data: unknown }).data;
    expect(RelayHeartbeatReply.safeParse(reply).success, JSON.stringify(reply)).toBe(true);
    const stored = await lastHeartbeat(s.sessionId);
    const { raw } = await newestRaw(s.sessionId);
    let checked = 0;
    for (const k of ["exitReason", "exitDetail"]) {
      expect(stored, `last_heartbeat.${k}`).toHaveProperty(k, fatal[k]);
      expect(raw, `samples.raw.${k}`).toHaveProperty(k, fatal[k]);
      checked += 2;
    }
    expect(checked).toBe(4);
    expect(raw).toEqual(fatal);
    // R2003 INVERTED this half (it read "the reason is recorded, never acted on" before). A stopped beat with NO reason is
    // still today's stop — its Machine is torn down and the ONE retry boots. A FATAL one is record only: Fly restarts the
    // compositor in place on the same attempt, so the Machine is left alone and nothing is created. The twin is the
    // positive pair: the same beat without the two fields.
    const twin = await session();
    const before = await row(s.sessionId);
    expect((await postBeat(twin.sessionId, { state: "stopped" }, { token: twin.jobToken })).status).toBe(200);
    expect(s.runner.created, "fatal: no replacement").toHaveLength(1);
    expect(s.runner.destroyed, "fatal: the restarting Machine is not torn down").toEqual([]);
    expect(await row(s.sessionId), "fatal: the runner is exactly as it was").toMatchObject({ state: before.state, runner_state: before.runner_state, machine_id: before.machine_id });
    expect(twin.runner.created, "no reason: the ONE retry").toHaveLength(RUNNER_MAX_ATTEMPTS);
    expect(twin.runner.destroyed, "no reason: the first Machine is torn down").toHaveLength(1);
    // the exit columns stay the observed exit's in both (A5) — fatal's 70 is the Machine's word, not an observed exit
    for (const r of [await row(s.sessionId), await row(twin.sessionId)]) {
      expect({ code: r.runner_exit_code, oom: r.runner_oom_killed, requested: r.runner_requested_stop }).toEqual({ code: null, oom: null, requested: null });
    }
    // The two refusals the addition owes, through the same route: an exit reason outside C06's vocabulary, and a
    // detail one character past its bound. Each is a 400 that writes nothing.
    const t = await session();
    for (const [label, body] of [
      ["exitReason \"crashed\"", vector("heartbeat-invalid-exit-reason")],
      ["exitDetail of 201 characters", { ...fatal, exitDetail: "x".repeat(201) }],
      ["an exit reason on a playing beat (review M6)", vector("heartbeat-invalid-exit-while-playing")],
    ] as const) {
      expect((await postBeat(t.sessionId, body, { token: t.jobToken })).status, label).toBe(400);
    }
    expect(await samples(t.sessionId)).toEqual([]);
    expect(await lastHeartbeat(t.sessionId)).toBeNull();
    // The positive pair at the bound: exactly 200 characters is admitted and stored whole.
    const at200 = { ...fatal, exitDetail: "y".repeat(200) };
    expect((await postBeat(t.sessionId, at200, { token: t.jobToken })).status).toBe(200);
    expect(await lastHeartbeat(t.sessionId)).toHaveProperty("exitDetail", at200.exitDetail);
    expect((await newestRaw(t.sessionId)).raw).toHaveProperty("exitDetail", at200.exitDetail);
  });

  // Review Q3 (defence in depth): the compositor redacts exitDetail, and the server scrubs it again before EITHER store
  // keeps it. A whole job token (~240 characters) cannot fit the detail's 200, so what can ride is a FRAGMENT of one —
  // JWT-shaped, which is what the scrub catches — and a query string.
  it("review Q3: the server scrubs exitDetail before either store keeps it — a fragment of the session's own job token and a query are gone, and both stores hold the same text", async () => {
    const s = await session();
    expect(s.jobToken.length, "premise: a whole job token is longer than the detail's bound").toBeGreaterThan(200);
    const detail = `auth refused for ${s.jobToken.slice(0, 80)} at https://relay.example.test/v1/sessions?st=abc&host=compositor`;
    expect(detail.length, "premise: the detail is within its bound").toBeLessThanOrEqual(200);
    const res = await postBeat(s.sessionId, { state: "stopped", exitReason: "refused", exitDetail: detail }, { token: s.jobToken });
    expect(res.status).toBe(200);
    const want = "auth refused for [redacted] at https://relay.example.test/v1/sessions";
    const stored = await lastHeartbeat(s.sessionId);
    const { raw } = await newestRaw(s.sessionId);
    expect(stored, "last_heartbeat").toHaveProperty("exitDetail", want);
    expect(raw, "samples.raw").toHaveProperty("exitDetail", want);
    expect(JSON.stringify([stored, raw]), "no piece of the token in either store").not.toContain(s.jobToken.slice(0, 40));
    // Only the detail is rewritten: the rest of the beat is stored as sent.
    expect(stored).toMatchObject({ state: "stopped", exitReason: "refused" });
    // Confirm pass, minor 2: a SIGNATURE-only fragment is not JWT-shaped (no `eyJ`), so only the token's own parts,
    // redacted as named secrets, catch it.
    const t = await session();
    const signature = t.jobToken.split(".")[2]!;
    expect(signature, "premise: the signature alone is not JWT-shaped").not.toMatch(/^eyJ/);
    expect((await postBeat(t.sessionId, { state: "stopped", exitReason: "refused", exitDetail: `signature ${signature} rejected` }, { token: t.jobToken })).status).toBe(200);
    expect(await lastHeartbeat(t.sessionId), "last_heartbeat").toHaveProperty("exitDetail", "signature [redacted] rejected");
    expect((await newestRaw(t.sessionId)).raw, "samples.raw").toHaveProperty("exitDetail", "signature [redacted] rejected");
  });

  // R2004 review m1: through the ROUTE, a composed Machine's exit detail that echoes the credentials it HOLDS — the
  // programme input's stream key, the camera's SRT passphrase and stream id — or an RTMPS key path is scrubbed in both
  // stores. The expected secrets are the PROVIDER's own answers (the rig's `inputs`), never the rows the handler reads.
  it("R2004 m1: a composed final beat's exitDetail loses the programme key, the camera's SRT passphrase and stream id, and everything after /live/ — in both stores", async () => {
    // One fresh session per credential, so each beat is that session's FIRST final beat.
    const picks = [
      ["programme key", (i: Awaited<ReturnType<typeof session>>["inputs"]) => i.find((x) => x.role === "programme")!.creds.rtmps.streamKey],
      ["SRT passphrase", (i: Awaited<ReturnType<typeof session>>["inputs"]) => i.find((x) => x.role === "camera")!.creds.srtPlayback!.passphrase],
      ["SRT stream id", (i: Awaited<ReturnType<typeof session>>["inputs"]) => i.find((x) => x.role === "camera")!.creds.srtPlayback!.streamId],
    ] as const;
    let checked = 0;
    for (const [name, pick] of picks) {
      const t = await session("composed");
      const value = pick(t.inputs);
      expect(value.length, `${name}: premise — long enough to be a pattern`).toBeGreaterThanOrEqual(10);
      const detail = `sink failed (${value}) twice`;
      expect((await postBeat(t.sessionId, { state: "stopped", exitReason: "refused", exitDetail: detail }, { token: t.jobToken })).status, name).toBe(200);
      expect(await lastHeartbeat(t.sessionId), `${name}: last_heartbeat`).toHaveProperty("exitDetail", "sink failed ([redacted]) twice");
      expect((await newestRaw(t.sessionId)).raw, `${name}: samples.raw`).toHaveProperty("exitDetail", "sink failed ([redacted]) twice");
      checked++;
    }
    expect(checked, "anti-vacuity: all three credentials").toBe(3);
    const u = await session("composed");
    const { url } = u.inputs.find((i) => i.role === "programme")!.creds.rtmps;
    expect(url, "premise: the provider's RTMPS url ends at its key path").toMatch(/\/live\/$/);
    expect((await postBeat(u.sessionId, { state: "stopped", exitReason: "refused", exitDetail: `publish ${url}someotherkey123 EOF` }, { token: u.jobToken })).status).toBe(200);
    expect(await lastHeartbeat(u.sessionId), "the key path is cut").toHaveProperty("exitDetail", `publish ${url}`);
  });

  // Review M4: Session.fixtureId is `string | null` — V410 `on delete set null`, the session outlives its fixture. The
  // runtime witness: the Machine's own GET after the fixture is gone. PASSTHROUGH answers fixtureId null, a strict
  // RelayJobSession. COMPOSED is refused (#981 follow-up, C07 review; coordinator decision): its facts carry the overlay
  // page `/overlay/fixtures/<fixtureId>`, and a null there reached the compositor as `/overlay/fixtures/null`, which C07
  // accepted. Refused 404 FIXTURE_GONE: C07's GET table (seazn.club.compositor crates/adapters/src/control_http.rs, branch
  // feat/c07-control-plane) maps 401/404/410 to `Refused`, which exits 78 — fatal config, never restarted.
  it("review M4 + #981 follow-up: delete the fixture mid-session — passthrough's GET facts answers fixtureId null (strict); composed's is refused 404 FIXTURE_GONE, and no URL it ever served names null", async () => {
    let checked = 0;
    for (const mode of ["composed", "passthrough"] as const) {
      const x = await session(mode);
      const before = ((await json(await getFacts(x.sessionId, { token: x.jobToken }))) as { data: Record<string, unknown> }).data;
      expect(before.fixtureId, `${mode}: the positive pair — before, the fixture's id`).toBe(x.fixtureId);
      if (mode === "composed") {
        const overlay = new URL(String(before.overlayUrl));
        expect(overlay.pathname, "the overlay page names the session's fixture").toBe(`/overlay/fixtures/${x.fixtureId}`);
        expect(String(before.overlayUrl), "never a null or undefined in the URL").not.toMatch(/null|undefined/);
      }
      await sql`delete from fixtures where id = ${x.fixtureId}`;
      const [{ fixture_id }] = await sql<{ fixture_id: string | null }[]>`select fixture_id from fixture_stream_sessions where id = ${x.sessionId}`;
      expect(fixture_id, `${mode}: premise — the session row survives with a null fixture`).toBeNull();
      const res = await getFacts(x.sessionId, { token: x.jobToken });
      const body = (await json(res)) as { ok: boolean; code?: string; data?: Record<string, unknown> };
      if (mode === "composed") {
        expect(res.status, "composed: refused with a status C07 maps to Refused (exit 78)").toBe(404);
        expect(body).toMatchObject({ ok: false, code: "FIXTURE_GONE" });
        expect(JSON.stringify(body), "no overlay URL, no credential, no null path").not.toMatch(/overlay\/fixtures|streamKey|passphrase/);
        expect(res.headers.get("cache-control"), "the refusal is private too").toBe("private, no-store");
        // The second call: still refused (the fixture does not come back), never a 200 on a retry.
        expect((await getFacts(x.sessionId, { token: x.jobToken })).status, "the second GET").toBe(404);
      } else {
        expect(res.status, mode).toBe(200);
        expect(body.data, mode).toHaveProperty("fixtureId", null);
        expect(RelayJobSession.parse(body.data), `${mode}: parse keeps every key`).toEqual(body.data);
      }
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("GET facts is a STRICT RelayJobSession: passthrough carries no composed-only key; composed carries EVERY one (R2004 turned that half around)", async () => {
    let checked = 0;
    for (const mode of ["passthrough", "composed"] as const) {
      const x = await session(mode);
      const res = await getFacts(x.sessionId, { token: x.jobToken });
      expect(res.status, mode).toBe(200);
      const body = (await json(res)) as { ok: boolean; data: Record<string, unknown> };
      expect(body.ok).toBe(true);
      const parsed = RelayJobSession.parse(body.data);
      expect(parsed, `${mode}: parse keeps every key`).toEqual(body.data);
      expect(parsed).toMatchObject({ sessionId: x.sessionId, fixtureId: x.fixtureId, mode });
      for (const k of COMPOSED_ONLY) {
        if (mode === "composed") expect(body.data, `${mode}: ${k}`).toHaveProperty(k);
        else expect(body.data, `${mode}: ${k}`).not.toHaveProperty(k);
      }
      checked++;
    }
    expect(checked).toBe(2);
    // The guard is live on this shape: one key more and the strict session refuses it.
    const p = await session("passthrough");
    const data = ((await json(await getFacts(p.sessionId, { token: p.jobToken }))) as { data: Record<string, unknown> }).data;
    expect(RelayJobSession.safeParse({ ...data, lastExit: { exitCode: 1 } }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// R2002: the named consumer of the R2 fields — C17's post-match health review. The query lives in
// docs/runbooks/relay-health-review.sql (psql `:'sid'`), and it is run here against the real storage the routes wrote.
// Every expected value is counted off the beats THIS test posts, never off the query.
// ---------------------------------------------------------------------------------------------------------------
const HEALTH_REVIEW = resolve(import.meta.dirname, "../../../../../../docs/runbooks/relay-health-review.sql");
async function healthReview(sid: string): Promise<Record<string, unknown>[]> {
  const text = readFileSync(HEALTH_REVIEW, "utf8");
  expect(text, "the runbook takes the session as psql's :'sid'").toContain(":'sid'");
  return sql.unsafe(text.replaceAll(":'sid'", "$1"), [sid]) as unknown as Promise<Record<string, unknown>[]>;
}

describe.skipIf(!HAS_DB)("R2002: docs/runbooks/relay-health-review.sql reads the R2 fields off the real storage", () => {
  it("one session's beats: phase, link, graphics, ladder and score counts, the counters' maxima, the kick alert and the longest camera backoff — and an unmeasured beat counts as unmeasured, never as 0 or false", async () => {
    // A second session's beats must never be counted in the first one's review. Each session beats on its own drivers
    // (`session()` installs the newest one's), so the other one beats first.
    const other = await session();
    expect((await postBeat(other.sessionId, vector("heartbeat-full"), { token: other.jobToken })).status).toBe(200);
    const s = await session();
    const beats: Record<string, unknown>[] = [
      { state: "starting", programmePhase: "waiting", input: "connecting", output: "connecting", graphics: "starting", rung: "full", inputKicks: 0, inputKickAlert: false, pipelineRebuilds: 0, sinkSwaps: 0 },
      { state: "playing", programmePhase: "live", input: "connected", output: "connected", graphics: "ready", rung: "full", inputKicks: 1, inputKickAlert: false, pipelineRebuilds: 0, sinkSwaps: 0, scoreStale: false },
      vector("heartbeat-full"),   // frozen, input backoff, graphics restarting, 4 kicks + alert, 2 rebuilds, 1 swap, overlay_half_rate, score stale
      vector("heartbeat-minimal"),   // unmeasured: counted as a beat, never as a measured anything — and it does not end the run
      { state: "playing", programmePhase: "reconnecting", input: "backoff", output: "connected", graphics: "failed", rung: "overlay_half_rate", inputKicks: 4, inputKickAlert: true, pipelineRebuilds: 3, sinkSwaps: 1, scoreStale: true },
      { state: "playing", programmePhase: "live", input: "connected", output: "backoff", graphics: "ready", rung: "full", inputKicks: 2, inputKickAlert: false, pipelineRebuilds: 3, sinkSwaps: 2, scoreStale: false },
      { state: "playing", programmePhase: "live", input: "backoff", output: "connected", graphics: "ready", rung: "full", inputKicks: 2, inputKickAlert: false, pipelineRebuilds: 3, sinkSwaps: 2 },
      // The first Machine's final beat (it was signalled), then the retry's (fatal) — R2003's one retry, as beats.
      { state: "stopped", exitReason: "signalled", exitDetail: "SIGTERM: draining before exit" },
      vector("heartbeat-final-fatal"),
      // R2007 PR B: Fly restarts the fatal one in place, the organiser ends the stream, and the compositor holds the Final
      // scene (C06) — two hold beats on the loopback channel — then sends its exit beat, still in `final`.
      vector("heartbeat-final-hold"),
      vector("heartbeat-final-hold"),
      { state: "stopped", programmePhase: "final", phaseChannel: "loopback", exitReason: "ended", exitDetail: "drained after the final hold" },
    ];
    for (const b of beats) expect((await postBeat(s.sessionId, b, { token: s.jobToken })).status, JSON.stringify(b)).toBe(200);
    // The beats landed milliseconds apart; space them 5 s apart in posting order, as a Machine beats.
    await sql`update fixture_stream_samples x set sampled_at = '2026-10-15T12:00:00Z'::timestamptz + make_interval(secs => 5 * (o.n - 1))
                from (select id, row_number() over (order by id) as n from fixture_stream_samples where session_id = ${s.sessionId}) o
               where x.id = o.id`;

    const rows = await healthReview(s.sessionId);
    expect(rows, "one row for one session").toHaveLength(1);
    const r = rows[0]!;
    const has = (b: Record<string, unknown>, k: string, v: unknown) => b[k] === v;
    const count = (k: string, v: unknown) => beats.filter((b) => has(b, k, v)).length;
    const maxOf = (k: string) => Math.max(...beats.filter((b) => typeof b[k] === "number").map((b) => b[k] as number));
    expect(r).toMatchObject({
      session_id: s.sessionId, mode: "composed",
      beats: beats.length,
      reported_beats: beats.filter((b) => "programmePhase" in b).length,
      phase_waiting: count("programmePhase", "waiting"), phase_live: count("programmePhase", "live"),
      phase_frozen: count("programmePhase", "frozen"), phase_reconnecting: count("programmePhase", "reconnecting"),
      phase_final: count("programmePhase", "final"),
      channel_loopback_beats: count("phaseChannel", "loopback"), channel_web_beats: count("phaseChannel", "web"),
      input_backoff_beats: count("input", "backoff"), output_backoff_beats: count("output", "backoff"),
      graphics_restarting_beats: count("graphics", "restarting"), graphics_failed_beats: count("graphics", "failed"),
      kick_alert_beats: count("inputKickAlert", true),
      rung_stepped_beats: beats.filter((b) => typeof b.rung === "string" && b.rung !== "full").length,
      score_stale_beats: count("scoreStale", true),
      max_input_kicks: maxOf("inputKicks"), max_pipeline_rebuilds: maxOf("pipelineRebuilds"), max_sink_swaps: maxOf("sinkSwaps"),
    });
    // The camera's first backoff run starts at beat 3 (t=10 s). Beat 4 (t=15 s) measured nothing, so it neither extends
    // nor ends the run; beat 5 (t=20 s) is still backoff, and beat 6 (t=25 s) is the first REPORTED beat out of it: 15 s.
    // A query that read the unmeasured beat as "not backoff" would split it into two 5 s runs. Beat 7 (t=30 s) starts a
    // second run that never ended (the final beat reports no link): 0 s. The longest is the first.
    expect(Number(r.longest_input_backoff_s)).toBe(15);
    expect(new Date(r.first_kick_alert_at as string).toISOString()).toBe("2026-10-15T12:00:10.000Z");
    expect(new Date(r.first_beat_at as string).toISOString()).toBe("2026-10-15T12:00:00.000Z");
    expect(new Date(r.last_beat_at as string).toISOString()).toBe(new Date(Date.parse("2026-10-15T12:00:00Z") + 5_000 * (beats.length - 1)).toISOString());
    // The exit reason is the LATEST one reported (the final beat's), never an earlier one (the signalled, the fatal).
    expect(r).toMatchObject({ exit_reason: "ended", exit_detail: "drained after the final hold" });
    // R2007 PR B: every phase the compositor declares has its own column, and the columns PARTITION the reported beats —
    // a phase added to lib/relay-phase.ts without a runbook column reds here, never in a post-match review. The same for
    // the two phase channels, over the beats that reported one.
    let phases = 0;
    for (const p of PROGRAMME_PHASES) {
      expect(r, `phase_${p}: a column`).toHaveProperty(`phase_${p}`);
      expect(r[`phase_${p}`], `phase_${p}`).toBe(count("programmePhase", p));
      phases++;
    }
    console.log(`runbook phases checked: ${phases}`);
    expect(phases, "anti-vacuity: zero phases checked is a failure").toBeGreaterThan(0);
    expect(Object.keys(r).filter((k) => k.startsWith("phase_")).sort(), "no phase column the declaration lacks").toEqual(PROGRAMME_PHASES.map((p) => `phase_${p}`).sort());
    expect(PROGRAMME_PHASES.reduce((n, p) => n + (r[`phase_${p}`] as number), 0), "Σ phase_* == reported_beats").toBe(r.reported_beats);
    expect(r.phase_final, "premise: the hold and the exit beat are in the sweep").toBe(3);
    let channels = 0;
    for (const c of PHASE_CHANNELS) {
      expect(r, `channel_${c}_beats: a column`).toHaveProperty(`channel_${c}_beats`);
      channels++;
    }
    expect(channels, "anti-vacuity").toBe(2);
    expect(Object.keys(r).filter((k) => k.startsWith("channel_")).sort()).toEqual(PHASE_CHANNELS.map((c) => `channel_${c}_beats`).sort());
    expect(PHASE_CHANNELS.reduce((n, c) => n + (r[`channel_${c}_beats`] as number), 0), "Σ channel_* == the beats that reported a channel")
      .toBe(beats.filter((b) => typeof b.phaseChannel === "string").length);
    expect([r.channel_loopback_beats, r.channel_web_beats], "both channels witnessed").toEqual([3, 1]);
    // The latest beat, whole, is the session row's — the review shows it beside the history.
    expect(r.last_heartbeat).toEqual(beats.at(-1));
    // The differential to a query that counts the minimal beat's absent fields as measured: it is a beat, not a report.
    expect(r.beats).not.toBe(r.reported_beats);
  });

  it("the empty case: a session with no beats is one row of zeros and nulls (never another session's numbers); an unknown session is no row", async () => {
    const quiet = await session();
    const busy = await session();   // the newest session: its drivers are the installed ones
    expect((await postBeat(busy.sessionId, vector("heartbeat-full"), { token: busy.jobToken })).status).toBe(200);
    const rows = await healthReview(quiet.sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      session_id: quiet.sessionId, beats: 0, reported_beats: 0, phase_final: 0, channel_loopback_beats: 0, channel_web_beats: 0, kick_alert_beats: 0, input_backoff_beats: 0,
      max_input_kicks: null, longest_input_backoff_s: null, first_beat_at: null, last_heartbeat: null, exit_reason: null, exit_detail: null,
    });
    // The positive pair: the busy session's own review sees its one beat.
    expect((await healthReview(busy.sessionId))[0]).toMatchObject({ beats: 1, reported_beats: 1, channel_web_beats: 1, kick_alert_beats: 1, max_input_kicks: 4 });
    expect(await healthReview(randomUUID())).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// R2003 through the REAL routes: the final beat's exit reason (controller ruling 2026-10-15), the composed stale window
// with its boot allowance (owner ruling 2026-10-15, option A), and the refusal exit (78). Every beat here is a STOPPED
// beat where it carries an exit reason (R2002 review M6: the schema refuses one on any other state). The clock is moved
// the way production's is — the beat window runs out (age BOTH anchors, G1) — and the Machine's own facts read ticks it.
// ---------------------------------------------------------------------------------------------------------------
const BEAT_S = RELAY_HEARTBEAT_INTERVAL_MS / 1000;
/** Age the beat window: the last beat RECEIVED and the window anchor, both `secs` ago. */
async function ageBeat(sid: string, secs: number): Promise<void> {
  await sql`update fixture_stream_sessions set heartbeat_at = now() - make_interval(secs => ${secs}),
                beat_window_at = now() - make_interval(secs => ${secs}) where id = ${sid}`;
}
/** Move the clock FORWARD by `secs`: every beat-window anchor the row holds gets that much older, and nothing else. Unlike
 *  `ageBeat` (which says "the last beat was `secs` ago"), a beat written between two advances keeps its own instant — so
 *  a test built on this one fails if a beat stops moving the window. */
async function advance(sid: string, secs: number): Promise<void> {
  await sql`update fixture_stream_sessions set heartbeat_at = heartbeat_at - make_interval(secs => ${secs}),
                beat_window_at = beat_window_at - make_interval(secs => ${secs}) where id = ${sid}`;
}
/** A composed session whose runner has PLAYED: one playing beat through the route. */
async function playingSession() {
  const s = await session();
  expect((await postBeat(s.sessionId, { state: "playing" }, { token: s.jobToken })).status).toBe(200);
  expect(await row(s.sessionId), "premise: live and playing").toMatchObject({ state: "live", runner_state: "playing" });
  return s;
}
const stoppedBeat = (reason: BeatExitReason | "absent" | "null") =>
  reason === "absent" ? { state: "stopped" } : { state: "stopped", exitReason: reason === "null" ? null : reason };

describe.skipIf(!HAS_DB)("R2003: the final beat's exit reason through the heartbeat route", () => {
  // The oracle is the ruling, typed — never read off stoppedBeatTrigger. The empty case (no reason, and null) first.
  // I2 (orchestrator decision, PR #967 review): `ended` and `deadline` END the session — a deadline retry is pointless,
  // and an unsolicited `ended` is the compositor's to make. Only a stopped beat that gives NO reason keeps today's retry.
  type Routed = "retry" | "ends:stopped" | "ends:max_duration" | "record" | "refused";
  const RULED: Record<BeatExitReason | "absent" | "null", Routed> = {
    absent: "retry", null: "retry",
    ended: "ends:stopped", deadline: "ends:max_duration",
    fatal: "record", signalled: "record", session_gone: "record",
    refused: "refused",
  };

  it("every reason, from a PLAYING runner and from a BOOTING one: no reason tears the Machine down and boots the ONE retry; ended / deadline END the session (stopped / max_duration, no retry); fatal / signalled / session_gone leave it exactly as it was; refused FAILS it machine_refused with no retry (count reported)", async () => {
    expect(Object.keys(RULED).sort()).toEqual([...BEAT_EXIT_REASONS, "absent", "null"].sort());
    let checked = 0;
    for (const from of ["playing", "booting"] as const) {
      for (const [reason, routed] of Object.entries(RULED) as [keyof typeof RULED, Routed][]) {
        const s = from === "playing" ? await playingSession() : await session();
        const label = `${from} × ${reason}`;
        const before = await row(s.sessionId);
        expect(before.runner_state, `${label}: premise`).toBe(from);
        const res = await postBeat(s.sessionId, stoppedBeat(reason), { token: s.jobToken });
        expect(res.status, label).toBe(200);
        const after = await row(s.sessionId);
        expect(await lastHeartbeat(s.sessionId), `${label}: recorded whatever the route`).toMatchObject({ state: "stopped" });
        if (routed === "ends:stopped" || routed === "ends:max_duration") {
          const endReason = routed === "ends:stopped" ? "stopped" : "max_duration";
          expect(after, label).toMatchObject({ state: "completed", end_reason: endReason, fail_reason: null, desired_state: "ending", runner_state: "destroyed" });
          expect(s.runner.created, `${label}: never a retry`).toHaveLength(1);
          expect(s.runner.destroyed, `${label}: its Machine is torn down`).toEqual([before.machine_id]);
          expect((await getFacts(s.sessionId, { token: s.jobToken })).status, `${label}: over`).toBe(410);
          expect(s.runner.created, `${label}: still no retry after the next read`).toHaveLength(1);
        } else if (routed === "retry") {
          expect(s.runner.created, `${label}: the ONE retry`).toHaveLength(RUNNER_MAX_ATTEMPTS);
          expect(s.runner.destroyed, label).toEqual([before.machine_id]);
          expect(after, label).toMatchObject({ state: before.state, runner_state: "booting", fail_reason: null });
          expect(after.machine_id, label).not.toBe(before.machine_id);
        } else if (routed === "record") {
          expect(s.runner.created, label).toHaveLength(1);
          expect(s.runner.destroyed, label).toEqual([]);
          expect(after, label).toMatchObject({ state: before.state, runner_state: before.runner_state, machine_id: before.machine_id, fail_reason: null, desired_state: before.desired_state });
          // R2003b: the runner is untouched either way, but a fatal run is ONE crash on the row; signalled / session_gone none
          expect(after.runner_crash_count, `${label}: crashes counted`).toBe(reason === "fatal" ? 1 : 0);
        } else {
          expect(after, label).toMatchObject({ state: "failed", fail_reason: "machine_refused" });
          expect(s.runner.created, `${label}: never a retry`).toHaveLength(1);
          expect(s.runner.destroyed, `${label}: the Machine Fly would restart into the same refusal is torn down`).toEqual([before.machine_id]);
          const gone = await getFacts(s.sessionId, { token: s.jobToken });
          expect(gone.status, label).toBe(410);
          expect(s.runner.created, `${label}: still no retry after the next read`).toHaveLength(1);
        }
        // a beat never writes the runner exit columns (A5)
        expect(after.runner_exit_code, label).toBeNull();
        checked++;
      }
    }
    expect(checked).toBe(2 * (BEAT_EXIT_REASONS.length + 2));
  });

  it("STOPPING (our own stop is ending it): an `ended` final beat and a `signalled` one both finish as COMPLETED stopped — never a retry, never a failure; the differential is only how far the beat itself moves the runner", async () => {
    let checked = 0;
    for (const [reason, runnerAfterBeat] of [["ended", "exited"], ["signalled", "stopping"]] as const) {
      const s = await playingSession();
      const machine = (await row(s.sessionId)).machine_id!;
      // A real Machine takes its flush to exit after the SIGINT (≤ RUNNER_STOP_GRACE_SECONDS); the fake would report it
      // stopped at once, so this one's stop is ACCEPTED and nothing more — the final beat then lands while `stopping`.
      const slowStop = Object.assign(Object.create(s.runner) as FakeRunner, { async stop() { /* signalled; still flushing */ } });
      setRelayDriversForTest({ ingest: s.ingest, runner: slowStop });
      await stopSession(s.auth, s.fixtureId, s.sessionId, defaultDeps("http://app.test"));
      expect((await row(s.sessionId)).runner_state, `${reason}: premise`).toBe("stopping");
      expect((await postBeat(s.sessionId, stoppedBeat(reason), { token: s.jobToken })).status, reason).toBe(200);
      expect((await row(s.sessionId)).runner_state, reason).toBe(runnerAfterBeat);
      // the Machine exits 0 on our SIGINT and auto_destroy takes it
      s.runner.setObserved(machine, "destroyed", { exitCode: 0, oomKilled: false, requestedStop: true });
      let reads = 0;
      while (!["completed", "failed"].includes((await row(s.sessionId)).state) && reads < 4) { await getFacts(s.sessionId, { token: s.jobToken }); reads++; }
      expect(await row(s.sessionId), reason).toMatchObject({ state: "completed", end_reason: "stopped", fail_reason: null });
      expect(s.runner.created, reason).toHaveLength(1);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("the SEQUENCE (owner ruling, option A): fatal → Fly restarting (pending) → not lost one beat short of the window → lost AT it → ONE create → the replacement boots 30 s unbeaten and is still alive → it plays → a second fatal → lost at the window → failed machine_crash, 410, and no third Machine", async () => {
    const s = await playingSession();
    const m1 = (await row(s.sessionId)).machine_id!;
    const read = async () => getFacts(s.sessionId, { token: s.jobToken });
    // attempt 1 crashes: its final beat says fatal, and Fly is restarting it in place
    expect((await postBeat(s.sessionId, stoppedBeat("fatal"), { token: s.jobToken })).status).toBe(200);
    s.runner.setObserved(m1, "pending");
    await ageBeat(s.sessionId, STALE_HEARTBEAT_SECONDS_COMPOSED - BEAT_S);
    expect((await read()).status).toBe(200);
    expect(await row(s.sessionId), "one beat short of the window: still the same Machine").toMatchObject({ state: "live", runner_state: "playing", machine_id: m1 });
    expect(s.runner.created).toHaveLength(1);
    // the restart did not come back: the window runs out
    await ageBeat(s.sessionId, STALE_HEARTBEAT_SECONDS_COMPOSED);
    expect((await read()).status).toBe(200);
    expect(s.runner.destroyed, "torn down before any replacement").toEqual([m1]);
    expect(s.runner.created, "exactly ONE create").toHaveLength(RUNNER_MAX_ATTEMPTS);
    const r2 = await row(s.sessionId);
    expect(r2).toMatchObject({ state: "live", runner_state: "booting" });
    // the replacement cold-starts: 30 s without a beat is inside its boot allowance
    const coldStart = 2 * STALE_HEARTBEAT_SECONDS_COMPOSED;
    expect(coldStart, "premise").toBeLessThan(STALE_HEARTBEAT_SECONDS);
    await ageBeat(s.sessionId, coldStart);
    expect((await read()).status).toBe(200);
    expect(await row(s.sessionId), "booting, unbeaten for 30 s: alive").toMatchObject({ state: "live", runner_state: "booting", machine_id: r2.machine_id });
    expect(s.runner.created).toHaveLength(RUNNER_MAX_ATTEMPTS);
    // it plays, then crashes too, and never comes back
    expect((await postBeat(s.sessionId, { state: "playing" }, { token: s.jobToken })).status).toBe(200);
    expect((await row(s.sessionId)).runner_state).toBe("playing");
    expect((await postBeat(s.sessionId, stoppedBeat("fatal"), { token: s.jobToken })).status).toBe(200);
    expect((await row(s.sessionId)).runner_state, "the second fatal is record only too").toBe("playing");
    await ageBeat(s.sessionId, STALE_HEARTBEAT_SECONDS_COMPOSED);
    const ended = await read();
    expect(ended.status).toBe(410);
    // no exit was observed for attempt 2 (its beats never write one, A5): the plan's failure path for a runner that
    // vanished without an exit is machine_crash (T10-c) — pinned as the literal, never read off the code under test
    expect(await row(s.sessionId)).toMatchObject({ state: "failed", fail_reason: "machine_crash" });
    expect(s.runner.created, "no third Machine, ever").toHaveLength(RUNNER_MAX_ATTEMPTS);
    expect(s.runner.destroyed).toEqual([m1, r2.machine_id]);
  });

  // M2 (PR #967 review): the in-place restart through the ROUTE. Every beat the route receives writes heartbeat_at (the
  // window's anchor), so the restarted process's `starting` beats are what hold the window off — never the fatal beat.
  // The clock moves the way production's does: each step ages the anchors by the time since the last beat.
  it("M2: after a fatal final beat, the restarted process's `starting` beats — each one less than the composed window after the last — keep the SAME Machine past T + STALE_HEARTBEAT_SECONDS_COMPOSED, and its playing beat finds it playing; no create, no destroy", async () => {
    const s = await playingSession();
    const m1 = (await row(s.sessionId)).machine_id!;
    const gap = STALE_HEARTBEAT_SECONDS_COMPOSED - BEAT_S;   // inside the window, every time
    expect((await postBeat(s.sessionId, stoppedBeat("fatal"), { token: s.jobToken })).status).toBe(200);
    s.runner.setObserved(m1, "pending");                      // Fly: restarting
    let elapsed = 0, held = 0;
    for (let i = 0; i < 3; i++) {
      await advance(s.sessionId, gap);
      elapsed += gap;
      expect((await postBeat(s.sessionId, { state: "starting" }, { token: s.jobToken })).status, `starting beat ${i}`).toBe(200);
      expect((await getFacts(s.sessionId, { token: s.jobToken })).status, `read after beat ${i}`).toBe(200);
      expect(await row(s.sessionId), `T+${elapsed}`).toMatchObject({ state: "live", runner_state: "playing", machine_id: m1 });
      held++;
    }
    expect(elapsed, "premise: held off PAST the window measured from the fatal beat").toBeGreaterThan(STALE_HEARTBEAT_SECONDS_COMPOSED);
    expect(held).toBe(3);
    s.runner.setObserved(m1, "running");
    expect((await postBeat(s.sessionId, { state: "playing" }, { token: s.jobToken })).status).toBe(200);
    expect(await row(s.sessionId)).toMatchObject({ state: "live", runner_state: "playing", machine_id: m1 });
    expect(s.runner.created, "the restart was the same attempt").toHaveLength(1);
    expect(s.runner.destroyed).toEqual([]);
  });

  it("M2, its pair: after the fatal beat the restart sends NOTHING — alive one second short of the composed window, lost AT it (torn down, then the ONE retry)", async () => {
    const s = await playingSession();
    const m1 = (await row(s.sessionId)).machine_id!;
    expect((await postBeat(s.sessionId, stoppedBeat("fatal"), { token: s.jobToken })).status).toBe(200);
    s.runner.setObserved(m1, "pending");
    await advance(s.sessionId, STALE_HEARTBEAT_SECONDS_COMPOSED - 1);
    expect((await getFacts(s.sessionId, { token: s.jobToken })).status).toBe(200);
    expect(await row(s.sessionId), "one second short").toMatchObject({ state: "live", runner_state: "playing", machine_id: m1 });
    expect(s.runner.destroyed).toEqual([]);
    await advance(s.sessionId, 1);
    expect((await getFacts(s.sessionId, { token: s.jobToken })).status).toBe(200);
    expect(s.runner.destroyed, "lost at the window: torn down").toEqual([m1]);
    expect(s.runner.created, "then the ONE retry").toHaveLength(RUNNER_MAX_ATTEMPTS);
    expect(await row(s.sessionId)).toMatchObject({ state: "live", runner_state: "booting" });
  });

  // F-007 (live Fly probe): an in-place restart reads stopped (~110 ms) → starting (~1.3 s) → started, and only the latest
  // exit's `restarting` flag tells it from a loss. Through the facts route — the Machine's own read ticks the observation.
  it("F-007: the probe's restart sequence through the facts route — stopped+restarting, starting, started — keeps the SAME Machine playing: no destroy, no create, no retry spent", async () => {
    const s = await playingSession();
    const m1 = (await row(s.sessionId)).machine_id!;
    const crash = { exitCode: 1, oomKilled: false, requestedStop: false };
    const exitAt = new Date();
    let checked = 0;
    for (const [state, restart] of [["stopped", { since: exitAt, count: 1 }], ["pending", { since: exitAt, count: 1 }], ["running", null]] as const) {
      s.runner.setObserved(m1, state, state === "running" ? null : crash, restart ?? undefined);
      expect((await getFacts(s.sessionId, { token: s.jobToken })).status, state).toBe(200);
      expect(await row(s.sessionId), state).toMatchObject({ state: "live", runner_state: "playing", machine_id: m1 });
      checked++;
    }
    expect(checked).toBe(3);
    expect(s.runner.destroyed).toEqual([]);
    expect(s.runner.created).toHaveLength(1);
  });

  it("F-007, its pairs: Fly's FINAL exit (restarting false) is lost → torn down → the ONE retry; a restart still starting past RUNNER_RESTART_STUCK_SECONDS is lost the same way", async () => {
    const crash = { exitCode: 1, oomKilled: false, requestedStop: false };
    let checked = 0;
    for (const [label, state, restart] of [
      ["final exit", "stopped", undefined],
      ["stuck starting", "pending", { since: new Date(Date.now() - (RUNNER_RESTART_STUCK_SECONDS + 1) * 1000), count: 1 }],
    ] as const) {
      const s = await playingSession();
      const m1 = (await row(s.sessionId)).machine_id!;
      s.runner.setObserved(m1, state, crash, restart);
      expect((await getFacts(s.sessionId, { token: s.jobToken })).status, label).toBe(200);
      expect(s.runner.destroyed, `${label}: torn down`).toEqual([m1]);
      expect(s.runner.created, `${label}: the ONE retry`).toHaveLength(RUNNER_MAX_ATTEMPTS);
      expect(await row(s.sessionId), label).toMatchObject({ state: "live", runner_state: "booting" });
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("F-007 race through the facts route: the Machine read as stopped before its exit is recorded (appendix M2, 90/320 ms) keeps the SAME Machine playing — and with no beat it is lost AT the composed window (torn down, the ONE retry)", async () => {
    const s = await playingSession();
    const m1 = (await row(s.sessionId)).machine_id!;
    s.runner.setObserved(m1, "stopped", null, "unrecorded");
    expect((await getFacts(s.sessionId, { token: s.jobToken })).status).toBe(200);
    expect(await row(s.sessionId), "no claim").toMatchObject({ state: "live", runner_state: "playing", machine_id: m1 });
    await advance(s.sessionId, STALE_HEARTBEAT_SECONDS_COMPOSED - 1);
    expect((await getFacts(s.sessionId, { token: s.jobToken })).status).toBe(200);
    expect(await row(s.sessionId), "one second short").toMatchObject({ state: "live", runner_state: "playing", machine_id: m1 });
    expect(s.runner.destroyed).toEqual([]);
    await advance(s.sessionId, 1);
    expect((await getFacts(s.sessionId, { token: s.jobToken })).status).toBe(200);
    expect(s.runner.destroyed, "lost at the window: torn down").toEqual([m1]);
    expect(s.runner.created, "then the ONE retry").toHaveLength(RUNNER_MAX_ATTEMPTS);
  });

  it("pass-3 regression through the facts route: a FAILED launch (no exit, not restarting) is lost on the read that sees it — torn down and the ONE retry with no clock moved, never held to the warming timeout", async () => {
    const s = await playingSession();
    const m1 = (await row(s.sessionId)).machine_id!;
    s.runner.setObserved(m1, "failed", null);
    expect((await getFacts(s.sessionId, { token: s.jobToken })).status).toBe(200);
    expect(s.runner.destroyed, "torn down at once").toEqual([m1]);
    expect(s.runner.created, "the ONE retry at once").toHaveLength(RUNNER_MAX_ATTEMPTS);
    expect(await row(s.sessionId)).toMatchObject({ state: "live", runner_state: "booting" });
  });

  it("the reviewer's trace through the facts route: first seen mid-restart of a refusal (starting, restarting, exit 78) — failed machine_refused at once, torn down, no retry", async () => {
    const s = await playingSession();
    const m1 = (await row(s.sessionId)).machine_id!;
    s.runner.setObserved(m1, "pending", { exitCode: RELAY_EXIT_REFUSED, oomKilled: false, requestedStop: false }, { since: new Date(), count: 1 });
    expect((await getFacts(s.sessionId, { token: s.jobToken })).status, "the read that failed it answers gone").toBe(410);
    expect(await row(s.sessionId)).toMatchObject({ state: "failed", fail_reason: "machine_refused" });
    expect(s.runner.destroyed).toEqual([m1]);
    expect(s.runner.created).toHaveLength(1);
  });

  it("F-007 result 2 (Fly restarts exit 78 too): a refused final beat FAILS the session and issues the teardown ONCE; while the DELETE is still out and Fly keeps restarting the refusal, every later read leaves it failed — no create, no retry, no second destroy", async () => {
    const s = await playingSession();
    const m1 = (await row(s.sessionId)).machine_id!;
    let destroys = 0;
    // the DELETE is accepted by nobody yet: the Machine stays up and Fly restarts it into the same refusal
    const lagging = Object.assign(Object.create(s.runner) as FakeRunner, { async destroy() { destroys++; throw Object.assign(new Error("fake destroy pending"), { status: 503 }); } });
    setRelayDriversForTest({ ingest: s.ingest, runner: lagging });
    expect((await postBeat(s.sessionId, stoppedBeat("refused"), { token: s.jobToken })).status).toBe(200);
    expect(await row(s.sessionId)).toMatchObject({ state: "failed", fail_reason: "machine_refused", runner_state: "lost" });
    expect(destroys, "the teardown, once").toBe(1);
    const refusedExit = { exitCode: RELAY_EXIT_REFUSED, oomKilled: false, requestedStop: false };
    let checked = 0;
    for (const [state, exit, restart] of [["stopped", refusedExit, { since: new Date(), count: 1 }], ["pending", refusedExit, { since: new Date(), count: 1 }], ["running", null, undefined]] as const) {
      s.runner.setObserved(m1, state, exit, restart);
      expect((await getFacts(s.sessionId, { token: s.jobToken })).status, state).toBe(410);
      expect(await row(s.sessionId), state).toMatchObject({ state: "failed", fail_reason: "machine_refused" });
      checked++;
    }
    expect(checked).toBe(3);
    expect(s.runner.created, "never a retry").toHaveLength(1);
    expect(destroys, "an observation never re-issues it").toBe(1);
  });

  it("exit 78 observed through the facts route fails the session machine_refused with NO retry; its positive pair (exit 1) takes the ONE retry", async () => {
    const refused = await playingSession();
    refused.runner.setObserved((await row(refused.sessionId)).machine_id!, "destroyed", { exitCode: RELAY_EXIT_REFUSED, oomKilled: false, requestedStop: false });
    expect((await getFacts(refused.sessionId, { token: refused.jobToken })).status).toBe(410);
    expect(await row(refused.sessionId)).toMatchObject({ state: "failed", fail_reason: "machine_refused", runner_exit_code: RELAY_EXIT_REFUSED });
    expect(refused.runner.created).toHaveLength(1);
    const crashed = await playingSession();
    crashed.runner.setObserved((await row(crashed.sessionId)).machine_id!, "destroyed", { exitCode: 1, oomKilled: false, requestedStop: false });
    expect((await getFacts(crashed.sessionId, { token: crashed.jobToken })).status).toBe(200);
    expect(await row(crashed.sessionId)).toMatchObject({ state: "live", fail_reason: null });
    expect(crashed.runner.created).toHaveLength(RUNNER_MAX_ATTEMPTS);
  });

  it("PASSTHROUGH: a stopped beat with ANY reason (or none) changes nothing — no Machine, no stale rule, no reaction (count reported)", async () => {
    const p = await session("passthrough");
    const pick = (r: Awaited<ReturnType<typeof row>>) => ({ state: r.state, runner_state: r.runner_state, fail_reason: r.fail_reason, end_reason: r.end_reason, desired_state: r.desired_state, machine_id: r.machine_id });
    const before = pick(await row(p.sessionId));
    let checked = 0;
    for (const reason of Object.keys(RULED) as (keyof typeof RULED)[]) {
      expect((await postBeat(p.sessionId, stoppedBeat(reason), { token: p.jobToken })).status, reason).toBe(200);
      expect(pick(await row(p.sessionId)), reason).toEqual(before);
      checked++;
    }
    // and a beat window far past both composed windows is not a stale beat on a passthrough row
    await ageBeat(p.sessionId, STALE_HEARTBEAT_SECONDS * 2);
    expect((await getFacts(p.sessionId, { token: p.jobToken })).status).toBe(200);
    expect(pick(await row(p.sessionId))).toEqual(before);
    expect(checked).toBe(BEAT_EXIT_REASONS.length + 2);
    expect(p.runner.created).toEqual([]);
  });

  // Brief test 7 (slate_on_air): the compositor's slate is ON AIR before the camera connects — `state: playing` with
  // `programmePhase: waiting`. Going live is the runner's `playing`, never the programme phase: the session goes live and
  // consumes ONE credit on the first playing beat, and a later reconnecting phase neither ends it nor consumes again.
  it("slate_on_air: a warming composed session goes LIVE on a playing beat whose programme is still `waiting` (camera connecting) and consumes ONE credit; a later `reconnecting` beat keeps it live with no second consume; a stalled beat (the pair) never goes live", async () => {
    const consumes = async (sid: string) =>
      (await sql<{ n: number }[]>`select count(*)::int as n from org_stream_credits where session_id = ${sid} and reason = 'consume'`)[0]!.n;
    const s = await session();
    expect((await row(s.sessionId)).state, "premise").toBe("warming");
    expect((await postBeat(s.sessionId, { state: "playing", programmePhase: "waiting", input: "connecting" }, { token: s.jobToken })).status).toBe(200);
    expect(await row(s.sessionId)).toMatchObject({ state: "live", runner_state: "playing" });
    expect(await consumes(s.sessionId)).toBe(1);
    expect((await postBeat(s.sessionId, { state: "playing", programmePhase: "reconnecting", input: "backoff" }, { token: s.jobToken })).status).toBe(200);
    expect((await row(s.sessionId)).state).toBe("live");
    expect(await consumes(s.sessionId), "never a second consume").toBe(1);
    const stalled = await session();
    expect((await postBeat(stalled.sessionId, { state: "stalled", programmePhase: "waiting", input: "connecting" }, { token: stalled.jobToken })).status).toBe(200);
    expect(await row(stalled.sessionId)).toMatchObject({ state: "warming", runner_state: "booting" });
    expect(await consumes(stalled.sessionId)).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// R2003b through the REAL routes (owner approval 2026-10-16): a session whose runner has crashed RUNNER_CRASH_CAP times
// fails machine_crash — torn down, no retry. Each crash's evidence arrives the way production's does: its final beat on
// the heartbeat route, and its exit on the next read of the Machine (the facts route's reconcile → the fake provider's
// observation). Every request loads the row and persists it, so the count surviving request to request IS the witness
// that V450's columns round-trip (cols → toSession → persist). Expected counts are the crashes each test makes.
// ---------------------------------------------------------------------------------------------------------------
const CRASH_EXIT: ExitInfo = { exitCode: 70, oomKilled: false, requestedStop: false };   // C06: the compositor's Fatal exit
/** The ledger's crash counts, in order: the `crashCount` each runner_transition carried (session.ts eventRowsOf). */
async function crashCounts(sid: string): Promise<number[]> {
  const rows = await sql<{ n: number }[]>`
    select (payload->>'crashCount')::int as n from fixture_stream_events
     where session_id = ${sid} and kind = 'runner_transition' and payload ? 'crashCount' order by seq`;
  return rows.map((r) => r.n);
}

describe.skipIf(!HAS_DB)("R2003b: the crash-loop cap through the heartbeat and facts routes", () => {
  it("the SEQUENCE: crash 1 → restarted → crash 2 → restarted → crash 3 FAILS machine_crash — each crash seen by its fatal beat AND its exit counts once; the Machine is torn down at the cap, no retry is spent, the next read is 410", async () => {
    expect(RUNNER_CRASH_CAP, "owner approval 2026-10-16").toBe(3);
    const s = await playingSession();
    const m1 = (await row(s.sessionId)).machine_id!;
    const read = async () => getFacts(s.sessionId, { token: s.jobToken });
    const t0 = Date.now();
    for (let k = 1; k < RUNNER_CRASH_CAP; k++) {
      expect((await postBeat(s.sessionId, stoppedBeat("fatal"), { token: s.jobToken })).status, `crash ${k}: its beat`).toBe(200);
      // F-007: Fly is restarting it in place — the exit carries its instant (distinct per crash, well inside
      // RUNNER_RESTART_STUCK_SECONDS of now) and the window's restart count k
      s.runner.setObserved(m1, "pending", CRASH_EXIT, { since: new Date(t0 + k * 10), count: k });
      expect((await read()).status, `crash ${k}: its exit`).toBe(200);
      expect((await read()).status, `crash ${k}: its exit, read again`).toBe(200);
      s.runner.setObserved(m1, "running");
      expect((await postBeat(s.sessionId, { state: "playing" }, { token: s.jobToken })).status).toBe(200);
      expect(await row(s.sessionId), `after crash ${k}`).toMatchObject({ state: "live", runner_state: "playing", machine_id: m1, fail_reason: null, runner_crash_count: k });
      expect(s.runner.destroyed, `after crash ${k}`).toEqual([]);
    }
    expect((await postBeat(s.sessionId, stoppedBeat("fatal"), { token: s.jobToken })).status, "crash RUNNER_CRASH_CAP: its beat").toBe(200);
    // the teardown ran after commit and the fake confirmed the DELETE (destroy_ok): destroyed, and still failed — no retry
    expect(await row(s.sessionId)).toMatchObject({ state: "failed", fail_reason: "machine_crash", runner_state: "destroyed", runner_crash_count: RUNNER_CRASH_CAP });
    expect(s.runner.destroyed, "torn down at the cap").toEqual([m1]);
    expect((await read()).status, "over").toBe(410);
    expect(s.runner.created, "no retry, though attempt 1 had one").toHaveLength(1);
    expect(RUNNER_MAX_ATTEMPTS, "premise").toBeGreaterThan(1);
    expect(await crashCounts(s.sessionId), "the ledger: one row per counted crash, never the re-reads").toEqual([1, 2, RUNNER_CRASH_CAP]);
  });

  // R2003b review m2: this used to model attempt 1's crash as "Fly gave up and destroyed the Machine" with NO restart
  // count, a shape Fly never sends (its final exit carries restart_count 2, F-007). That shape is the cap at once: see the
  // final-exit test below. The retry here comes from the road that does spend it: a crash read mid-restart whose
  // restarted process never beats.
  it("per SESSION: a crash seen only by its exit (no beat; read while Fly restarts it, restart_count 1) whose restarted process never beats is lost at the composed window and spends the ONE retry with the count carried; two fatal crashes of the replacement then reach the cap — machine_crash, and no third Machine", async () => {
    const s = await playingSession();
    const m1 = (await row(s.sessionId)).machine_id!;
    s.runner.setObserved(m1, "pending", CRASH_EXIT, { since: new Date(), count: 1 });
    expect((await getFacts(s.sessionId, { token: s.jobToken })).status).toBe(200);
    expect(await row(s.sessionId), "counted; still the same Machine, mid-restart").toMatchObject({ state: "live", runner_state: "playing", machine_id: m1, runner_crash_count: 1 });
    await advance(s.sessionId, STALE_HEARTBEAT_SECONDS_COMPOSED);
    expect((await getFacts(s.sessionId, { token: s.jobToken })).status).toBe(200);
    expect(s.runner.destroyed, "lost at the window: torn down").toEqual([m1]);
    expect(s.runner.created, "the ONE retry").toHaveLength(RUNNER_MAX_ATTEMPTS);
    expect(await row(s.sessionId), "the replacement carries the session's crash, not the attempt's evidence").toMatchObject({ state: "live", runner_state: "booting", runner_crash_count: 1, runner_crash_beats: 0, runner_crash_exits: 0 });
    expect((await postBeat(s.sessionId, { state: "playing" }, { token: s.jobToken })).status).toBe(200);
    for (let k = 2; k <= RUNNER_CRASH_CAP; k++) {
      expect((await postBeat(s.sessionId, stoppedBeat("fatal"), { token: s.jobToken })).status, `crash ${k}`).toBe(200);
      if (k < RUNNER_CRASH_CAP) {
        expect(await row(s.sessionId), `crash ${k}`).toMatchObject({ state: "live", runner_crash_count: k });
        expect((await postBeat(s.sessionId, { state: "playing" }, { token: s.jobToken })).status).toBe(200);
      }
    }
    expect(await row(s.sessionId)).toMatchObject({ state: "failed", fail_reason: "machine_crash", runner_crash_count: RUNNER_CRASH_CAP });
    expect(s.runner.created, "no third Machine").toHaveLength(RUNNER_MAX_ATTEMPTS);
    expect((await getFacts(s.sessionId, { token: s.jobToken })).status).toBe(410);
  });

  it("a platform stop is never a crash: RUNNER_CRASH_CAP + 1 `signalled` final beats leave the session live with nothing counted, and the exit-0 Machine it leaves behind is lost → the ONE retry, still counting nothing", async () => {
    const s = await playingSession();
    const m1 = (await row(s.sessionId)).machine_id!;
    for (let i = 0; i <= RUNNER_CRASH_CAP; i++) {
      expect((await postBeat(s.sessionId, stoppedBeat("signalled"), { token: s.jobToken })).status, `signalled ${i}`).toBe(200);
    }
    expect(await row(s.sessionId)).toMatchObject({ state: "live", runner_state: "playing", machine_id: m1, runner_crash_count: 0 });
    // C06: SIGTERM drains and exits 0, which Fly does not restart; the Machine stops and auto-destroys
    s.runner.setObserved(m1, "destroyed", { exitCode: 0, oomKilled: false, requestedStop: false }, undefined, new Date(Date.now() - 1_000));
    expect((await getFacts(s.sessionId, { token: s.jobToken })).status).toBe(200);
    expect(await row(s.sessionId)).toMatchObject({ state: "live", runner_state: "booting", runner_crash_count: 0 });
    expect(s.runner.created).toHaveLength(RUNNER_MAX_ATTEMPTS);
  });

  it("the refusal keeps its own path: one crash short of the cap, an observed exit 78 fails machine_refused — never machine_crash — and adds no crash", async () => {
    const s = await playingSession();
    const m1 = (await row(s.sessionId)).machine_id!;
    for (let k = 1; k < RUNNER_CRASH_CAP; k++) {
      expect((await postBeat(s.sessionId, stoppedBeat("fatal"), { token: s.jobToken })).status).toBe(200);
      expect((await postBeat(s.sessionId, { state: "playing" }, { token: s.jobToken })).status).toBe(200);
    }
    expect((await row(s.sessionId)).runner_crash_count, "premise: one short").toBe(RUNNER_CRASH_CAP - 1);
    s.runner.setObserved(m1, "pending", { exitCode: RELAY_EXIT_REFUSED, oomKilled: false, requestedStop: false }, { since: new Date(), count: RUNNER_INPLACE_RESTARTS });
    expect((await getFacts(s.sessionId, { token: s.jobToken })).status).toBe(410);
    expect(await row(s.sessionId)).toMatchObject({ state: "failed", fail_reason: "machine_refused", runner_crash_count: RUNNER_CRASH_CAP - 1 });
    expect(s.runner.created).toHaveLength(1);
  });

  // R2003b review m1/m2. F-007 measured (M1, M3): crashes #1 and #2 restarted in place, #3 Fly's final exit with
  // restart_count 2, then the Machine stays down (auto_destroy here). Expected values are the measurement's.
  it("Fly gave up: its FINAL exit read on the destroyed Machine (restart_count 2, not restarted) is the 3 crashes F-007 measured — failed machine_crash on that read, torn down by Fly already, no retry spent", async () => {
    const F007 = { finalRestartCount: 2, crashes: 3 };
    const s = await playingSession();
    const m1 = (await row(s.sessionId)).machine_id!;
    s.runner.setObserved(m1, "destroyed", CRASH_EXIT, { final: F007.finalRestartCount }, new Date(Date.now() - 1_000));
    expect((await getFacts(s.sessionId, { token: s.jobToken })).status).toBe(410);
    expect(await row(s.sessionId)).toMatchObject({ state: "failed", fail_reason: "machine_crash", runner_crash_count: F007.crashes });
    expect(s.runner.created, "no retry").toHaveLength(1);
  });

  // R2003b review I2 through the REAL routes. F-007's slow loop: past the ~330 s refill Fly restarts every crash in place
  // with restart_count 1 (M2), and a runtime crash (panic, OOM kill) sends no final beat. The restarted process's own job
  // GET (the facts route) is the read that follows each restart, and Fly then says `started`.
  it("R2003b I2: a SLOW beat-less crash loop through the facts route — each crash read only by the restarted process's own job GET, after Fly finished the restart (running) — counts once per crash, re-reads nothing; the 3rd fails the session with the CAPPING crash's reason (an OOM kill: machine_oom), no retry", async () => {
    const s = await playingSession();
    const m1 = (await row(s.sessionId)).machine_id!;
    const PANIC: ExitInfo = { exitCode: 101, oomKilled: false, requestedStop: false };
    const OOM: ExitInfo = { exitCode: 137, oomKilled: true, requestedStop: false };
    const t0 = Date.now() - 60 * 60_000;
    let checked = 0;
    for (let k = 1; k <= RUNNER_CRASH_CAP; k++) {
      s.runner.setObserved(m1, "running", k < RUNNER_CRASH_CAP ? PANIC : OOM, { restarted: 1 }, new Date(t0 + k * 331_000));
      if (k < RUNNER_CRASH_CAP) {
        expect((await getFacts(s.sessionId, { token: s.jobToken })).status, `crash ${k}: the restarted process's job GET`).toBe(200);
        expect((await getFacts(s.sessionId, { token: s.jobToken })).status, `crash ${k}: read again`).toBe(200);
        expect(await row(s.sessionId), `crash ${k}`).toMatchObject({ state: "live", runner_state: "playing", machine_id: m1, fail_reason: null, runner_crash_count: k });
        expect(s.runner.destroyed, `crash ${k}`).toEqual([]);
      } else {
        expect((await getFacts(s.sessionId, { token: s.jobToken })).status, "the cap").toBe(410);
      }
      checked++;
    }
    expect(checked).toBe(RUNNER_CRASH_CAP);
    expect(await row(s.sessionId)).toMatchObject({ state: "failed", fail_reason: "machine_oom", runner_crash_count: RUNNER_CRASH_CAP });
    expect(s.runner.destroyed, "torn down at the cap").toEqual([m1]);
    expect(s.runner.created, "no retry").toHaveLength(1);
    expect(await crashCounts(s.sessionId), "one ledger row per crash, never the re-reads").toEqual([1, 2, RUNNER_CRASH_CAP]);
  });

  // R2003b review I3: the heartbeat route hands `callback_crashed` to a still-running session only. In ONE request the
  // beat runs the expiry first, and the expiry can end the session while the runner is still stopping (a warming
  // timeout: failed machine_boot_timeout, the runner sent its stop). The domain refuses a crash beat on a terminal
  // session (C27), so without the route's own guard the Machine's beat is a 500.
  it("a fatal final beat that meets a session the SAME request's expiry just failed (warming past its deadline: failed machine_boot_timeout, the runner stopping) is recorded and answered 200 — never a 500 on the Machine's beat — and counts no crash", async () => {
    const s = await session();
    expect(await row(s.sessionId), "premise: warming, booting").toMatchObject({ state: "warming", runner_state: "booting" });
    await sql`update fixture_stream_sessions set warming_at = now() - make_interval(mins => ${WARMING_TIMEOUT_MINUTES + 1}) where id = ${s.sessionId}`;
    expect((await postBeat(s.sessionId, stoppedBeat("fatal"), { token: s.jobToken })).status).toBe(200);
    expect(await row(s.sessionId)).toMatchObject({ state: "failed", fail_reason: "machine_boot_timeout", runner_crash_count: 0 });
    expect(await lastHeartbeat(s.sessionId), "the beat is recorded").toMatchObject({ state: "stopped", exitReason: "fatal" });
    expect(await crashCounts(s.sessionId)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Owner 2026-10-18 (compositor `docs/_INDEX.md` Owed 20): any production step-down is a SIZING alarm. The compositor's
// ladder is `full → overlay_half_rate` and the bottom holds (the score is never taken off air), so a beat whose rung is
// not `full` says the Machine is short of CPU, and ops raise its size (compositor C17 runbook). The web side, which
// receives the beats, raises it: a structured warning in the log AND the house alerting path (Sentry, route
// `relay.sizing_alarm`) — ONCE per step down, never on every 5 s beat. Driven through the REAL route, with the
// contract's own vectors where one fits.
// ---------------------------------------------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("owner 2026-10-18: a ladder step-down on a composed beat raises the sizing alarm", () => {
  const ROUTE = "relay.sizing_alarm";
  /** The house alerting path's sizing reports for one session. */
  const reportsFor = (sid: string) => sentry.captureError.mock.calls.filter(([, c]) =>
    (c as { route?: string } | undefined)?.route === ROUTE && (c as { extra?: { sessionId?: string } }).extra?.sessionId === sid);
  /** The structured warnings for one session (pino's `(object, message)` form). */
  const warningsFor = (spy: { mock: { calls: unknown[][] } }, sid: string) => spy.mock.calls.filter(([o]) =>
    typeof o === "object" && o !== null && (o as { sid?: string; alarm?: string }).sid === sid && (o as { alarm?: string }).alarm === "sizing");

  it("the sequence a match produces: full, a step, the bottom held, a climb, a second step, an unreported beat, a third — one alarm per step, each in the log AND the alerting path, naming the session, the org, the attempt and the rung", async () => {
    const warn = vi.spyOn(log, "warn");
    try {
      const s = await session();
      const full = vector("heartbeat-full");
      expect(full.rung, "premise: the contract's full vector is on the bottom rung").toBe("overlay_half_rate");
      const beats: [body: Record<string, unknown>, alarms: number][] = [
        [{ state: "starting", rung: "full" }, 0],
        [{ state: "playing", rung: "full" }, 0],                         // a second call on the top rung
        [{ state: "playing", rung: "overlay_half_rate" }, 1],            // THE step down
        [{ state: "playing", rung: "overlay_half_rate" }, 1],            // the bottom holds: no second alarm
        [full, 1],                                                       // the contract's vector, still the bottom
        [{ state: "playing", rung: "full" }, 1],                         // a climb is no alarm
        [{ state: "playing", rung: "overlay_half_rate" }, 2],            // a second step is a second alarm
        [vector("heartbeat-minimal"), 2],                                // an unreported rung alarms nothing…
        [{ state: "playing", rung: "overlay_half_rate" }, 3],            // …and after it the rung is unknown: alarm again
      ];
      let posted = 0;
      for (const [body, alarms] of beats) {
        expect((await postBeat(s.sessionId, body, { token: s.jobToken })).status, JSON.stringify(body)).toBe(200);
        expect(reportsFor(s.sessionId), `after beat ${posted + 1}: alerting path`).toHaveLength(alarms);
        expect(warningsFor(warn, s.sessionId), `after beat ${posted + 1}: log`).toHaveLength(alarms);
        posted++;
      }
      expect(posted, "anti-vacuity: every beat posted").toBe(beats.length);
      const machine = (await row(s.sessionId)).machine_id;
      expect(machine, "premise: the composed session has its Machine").not.toBeNull();
      for (const [err, c] of reportsFor(s.sessionId)) {
        // One message for every alarm, so the alerting path groups them as ONE issue; the facts ride beside it.
        expect((err as Error).message).toMatch(/^relay sizing alarm: /);
        expect(c).toMatchObject({ orgId: s.auth.orgId, route: ROUTE, extra: { sessionId: s.sessionId, rung: "overlay_half_rate", attempt: 1, machineId: machine } });
      }
      for (const [o, message] of warningsFor(warn, s.sessionId)) {
        expect(o).toMatchObject({ sid: s.sessionId, orgId: s.auth.orgId, alarm: "sizing", rung: "overlay_half_rate", attempt: 1, machineId: machine });
        expect(String(message), "the log line tells ops what to do").toMatch(/raise the Machine size/);
      }
      // The second step's warning names the rung it stepped FROM; the third's previous rung was unreported.
      expect(warningsFor(warn, s.sessionId).map(([o]) => (o as { previousRung: unknown }).previousRung)).toEqual(["full", "full", null]);
    } finally {
      warn.mockRestore();
    }
  });

  it("the first beat already stepped alarms at once; a passthrough session (no compositor, no Machine) never alarms; a refused beat (the retired fast_preset, 400) writes nothing and alarms nothing; another session's step is its own", async () => {
    const warn = vi.spyOn(log, "warn");
    try {
      const a = await session();
      expect((await postBeat(a.sessionId, { state: "starting", rung: "overlay_half_rate" }, { token: a.jobToken })).status).toBe(200);
      expect(reportsFor(a.sessionId), "a first beat on the bottom rung").toHaveLength(1);
      // The retired rung: 400, nothing written, nothing alarmed — the stored beat is still the previous one.
      const before = await lastHeartbeat(a.sessionId);
      expect((await postBeat(a.sessionId, { state: "playing", rung: "fast_preset" }, { token: a.jobToken })).status, "fast_preset is refused").toBe(400);
      expect(await lastHeartbeat(a.sessionId), "a refused beat writes nothing").toEqual(before);
      expect(reportsFor(a.sessionId)).toHaveLength(1);
      // A second session's step alarms for THAT session, and leaves the first's count alone.
      const b = await session();
      expect((await postBeat(b.sessionId, { state: "playing", rung: "full" }, { token: b.jobToken })).status).toBe(200);
      expect((await postBeat(b.sessionId, { state: "playing", rung: "overlay_half_rate" }, { token: b.jobToken })).status).toBe(200);
      expect(reportsFor(b.sessionId)).toHaveLength(1);
      expect(reportsFor(a.sessionId)).toHaveLength(1);
      // Passthrough: the beat is recorded (200, stored whole) and never alarms — there is no Machine to resize.
      const p = await session("passthrough");
      expect((await postBeat(p.sessionId, { state: "playing", rung: "full" }, { token: p.jobToken })).status).toBe(200);
      expect((await postBeat(p.sessionId, { state: "playing", rung: "overlay_half_rate" }, { token: p.jobToken })).status).toBe(200);
      expect(await lastHeartbeat(p.sessionId), "premise: the beat landed").toMatchObject({ rung: "overlay_half_rate" });
      expect(reportsFor(p.sessionId), "passthrough: no alerting").toHaveLength(0);
      expect(warningsFor(warn, p.sessionId), "passthrough: no warning").toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  it("#980 review M2: a retry's Machine is a new process on a NEW attempt — its first beat already stepped alarms again, naming attempt 2 and the new Machine, then holds", async () => {
    const warn = vi.spyOn(log, "warn");
    try {
      const s = await session();
      expect((await postBeat(s.sessionId, { state: "playing", rung: "full" }, { token: s.jobToken })).status).toBe(200);
      expect((await postBeat(s.sessionId, { state: "playing", rung: "overlay_half_rate" }, { token: s.jobToken })).status).toBe(200);
      expect(reportsFor(s.sessionId), "attempt 1 steps down: one alarm").toHaveLength(1);
      const first = (await row(s.sessionId)).machine_id!;
      // Attempt 1 dies uncleanly; the Machine's own facts read notices, and the ONE retry boots (the A5 test's path).
      s.runner.setObserved(first, "failed", { exitCode: 1, oomKilled: false, requestedStop: false });
      expect((await getFacts(s.sessionId, { token: s.jobToken })).status).toBe(200);
      expect(s.runner.created, "premise: the retry created a second Machine").toHaveLength(RUNNER_MAX_ATTEMPTS);
      const second = (await row(s.sessionId)).machine_id!;
      expect(second, "premise: a new Machine").not.toBe(first);
      // The replacement's FIRST beat is already on the bottom rung — the very word attempt 1's last beat stored. Compared
      // against that stored beat it reads as "held", and a short Machine on its new attempt would never alarm.
      expect((await postBeat(s.sessionId, { state: "starting", rung: "overlay_half_rate" }, { token: s.jobToken })).status).toBe(200);
      const reports = reportsFor(s.sessionId);
      expect(reports, "attempt 2's step is its own alarm").toHaveLength(2);
      expect(reports[1]![1]).toMatchObject({ route: ROUTE, extra: { sessionId: s.sessionId, rung: "overlay_half_rate", previousRung: null, attempt: 2, machineId: second } });
      // …and attempt 2 then holds its bottom: no third alarm.
      expect((await postBeat(s.sessionId, { state: "playing", rung: "overlay_half_rate" }, { token: s.jobToken })).status).toBe(200);
      expect(reportsFor(s.sessionId), "the new attempt's bottom holds").toHaveLength(2);
      expect(warningsFor(warn, s.sessionId), "the log agrees").toHaveLength(2);
    } finally {
      warn.mockRestore();
    }
  });

  // #980 review, carried into R2004: Fly restarts a crashed compositor IN PLACE — the same Machine, the same attempt
  // (runner-fly.ts on-failure). The crashed process's FINAL beat is `stopped` and reports no rung, so a dedupe that read
  // only the stored beat would take the restarted process's first beat — on the very rung its predecessor held — as a
  // fresh step, and alarm a Machine ops were already told about. The size did not change; neither did the rung.
  it("#980 carried: an IN-PLACE crash restart (same attempt, same Machine) whose restarted process beats the rung its predecessor held does NOT re-alarm; a real step after it still alarms", async () => {
    const warn = vi.spyOn(log, "warn");
    try {
      const s = await playingSession();
      const m1 = (await row(s.sessionId)).machine_id!;
      expect((await postBeat(s.sessionId, { state: "playing", rung: "full" }, { token: s.jobToken })).status).toBe(200);
      expect((await postBeat(s.sessionId, { state: "playing", rung: "overlay_half_rate" }, { token: s.jobToken })).status).toBe(200);
      expect(reportsFor(s.sessionId), "the step: one alarm").toHaveLength(1);
      // The crash: its final beat, then Fly's in-place restart of the SAME Machine (the R2003b crash-loop test's path).
      expect((await postBeat(s.sessionId, stoppedBeat("fatal"), { token: s.jobToken })).status).toBe(200);
      expect(await lastHeartbeat(s.sessionId), "premise: the stored beat is the final one, with no rung").not.toHaveProperty("rung");
      s.runner.setObserved(m1, "pending", CRASH_EXIT, { since: new Date(), count: 1 });
      expect((await getFacts(s.sessionId, { token: s.jobToken })).status).toBe(200);
      s.runner.setObserved(m1, "running");
      expect(await row(s.sessionId), "premise: still attempt 1's Machine, one crash counted").toMatchObject({ state: "live", machine_id: m1, runner_crash_count: 1 });
      expect(s.runner.created, "premise: no retry — an in-place restart").toHaveLength(1);
      // The restarted process's beats on the rung the attempt already alarmed: nothing new.
      expect((await postBeat(s.sessionId, { state: "starting", rung: "overlay_half_rate" }, { token: s.jobToken })).status).toBe(200);
      expect((await postBeat(s.sessionId, { state: "playing", rung: "overlay_half_rate" }, { token: s.jobToken })).status).toBe(200);
      expect(reportsFor(s.sessionId), "an in-place restart on the same rung is no new step").toHaveLength(1);
      expect(warningsFor(warn, s.sessionId), "the log agrees").toHaveLength(1);
      // The positive pair: the restarted process climbs, then steps again — a real step, a second alarm.
      expect((await postBeat(s.sessionId, { state: "playing", rung: "full" }, { token: s.jobToken })).status).toBe(200);
      expect((await postBeat(s.sessionId, { state: "playing", rung: "overlay_half_rate" }, { token: s.jobToken })).status).toBe(200);
      expect(reportsFor(s.sessionId), "a step after the restart alarms").toHaveLength(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("#980 carried, the other order: a restarted process whose first beat is `full` and whose next steps down alarms — the final beat is read THROUGH, never as the bottom rung", async () => {
    const s = await playingSession();
    const m1 = (await row(s.sessionId)).machine_id!;
    expect((await postBeat(s.sessionId, { state: "playing", rung: "overlay_half_rate" }, { token: s.jobToken })).status).toBe(200);
    expect(reportsFor(s.sessionId)).toHaveLength(1);
    expect((await postBeat(s.sessionId, stoppedBeat("fatal"), { token: s.jobToken })).status).toBe(200);
    s.runner.setObserved(m1, "pending", CRASH_EXIT, { since: new Date(), count: 1 });
    expect((await getFacts(s.sessionId, { token: s.jobToken })).status).toBe(200);
    s.runner.setObserved(m1, "running");
    expect((await postBeat(s.sessionId, { state: "starting", rung: "full" }, { token: s.jobToken })).status).toBe(200);
    expect(reportsFor(s.sessionId), "a restarted process on full: no alarm").toHaveLength(1);
    expect((await postBeat(s.sessionId, { state: "playing", rung: "overlay_half_rate" }, { token: s.jobToken })).status).toBe(200);
    expect(reportsFor(s.sessionId), "its step is a step").toHaveLength(2);
  });

  it("#980 review M1: the dedupe reads the STORED beat, so it survives a web restart — a bottom rung stored by SQL (no beat through this process), then the same rung, alarms nothing; the next ENTRY still alarms", async () => {
    const s = await session();
    // A previous web process stored this attempt's stepped beat (and alarmed it); this process has never seen the session.
    await sql`update fixture_stream_sessions set last_heartbeat = ${sql.json({ state: "playing", rung: "overlay_half_rate" } as never)} where id = ${s.sessionId}`;
    expect(await lastHeartbeat(s.sessionId), "premise: the stored rung").toMatchObject({ rung: "overlay_half_rate" });
    expect((await postBeat(s.sessionId, { state: "playing", rung: "overlay_half_rate" }, { token: s.jobToken })).status).toBe(200);
    expect(reportsFor(s.sessionId), "the stored step was alarmed by the process that stored it").toHaveLength(0);
    // The positive pair: a climb, then a real entry to the bottom, alarms once.
    expect((await postBeat(s.sessionId, { state: "playing", rung: "full" }, { token: s.jobToken })).status).toBe(200);
    expect((await postBeat(s.sessionId, { state: "playing", rung: "overlay_half_rate" }, { token: s.jobToken })).status).toBe(200);
    expect(reportsFor(s.sessionId), "a fresh step after the restart").toHaveLength(1);
  });

  it("#980 review M4: an alerting path that throws never fails the beat — 200, the beat is stored, and the failure is logged as an error once", async () => {
    const error = vi.spyOn(log, "error");
    let thrown = 0;
    sentry.captureError.mockImplementation((_e: unknown, c: unknown) => {
      if ((c as { route?: string } | undefined)?.route === ROUTE && thrown === 0) { thrown++; throw new Error("sentry transport down"); }
    });
    try {
      const s = await session();
      expect((await postBeat(s.sessionId, { state: "playing", rung: "full" }, { token: s.jobToken })).status).toBe(200);
      const res = await postBeat(s.sessionId, { state: "playing", rung: "overlay_half_rate" }, { token: s.jobToken });
      expect(thrown, "anti-vacuity: the alerting path DID throw").toBe(1);
      expect(res.status, "the beat is answered").toBe(200);
      expect(await lastHeartbeat(s.sessionId), "the beat is stored").toMatchObject({ rung: "overlay_half_rate" });
      const failures = error.mock.calls.filter(([o, m]) => typeof o === "object" && o !== null
        && (o as { sid?: string }).sid === s.sessionId && /sizing alarm was not raised/.test(String(m)));
      expect(failures, "the swallowed failure is logged").toHaveLength(1);
      // The NEXT beat still answers, and the bottom holds (the throw consumed no state).
      expect((await postBeat(s.sessionId, { state: "playing", rung: "overlay_half_rate" }, { token: s.jobToken })).status).toBe(200);
    } finally {
      sentry.captureError.mockImplementation(() => undefined);
      error.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// R2004 (compositor plan task R2004; overlay templates spec 2026-10-15 §4.4 and §6): a composed Machine READS the
// camera (Input A) over SRT playback and PUBLISHES to its own programme input (Input B); the destination is a
// Cloudflare output on B. The facts the Machine GETs say so, through the REAL route. Expected credentials are the
// provider's own create answers (`session().inputs`), expected profile values the contract's fixtures, expected
// template ids spec §3's default rule — never the route's own output.
// ---------------------------------------------------------------------------------------------------------------
const contractSession = (name: string) => JSON.parse(readFileSync(resolve(CONTRACT_FIXTURES, `${name}.json`), "utf8")) as Record<string, unknown>;
type Facts = { overlayDelayMs: number; overlayUrl: string; themeId: string | null; pageToken: string; target: { url: string; streamKey: string };
  input: { protocol: string; url: string; streamId: string; passphrase: string }; output: Record<string, number>; heartbeatIntervalMs: number };
async function factsOf(s: { sessionId: string; jobToken: string }): Promise<Facts> {
  const res = await getFacts(s.sessionId, { token: s.jobToken });
  expect(res.status).toBe(200);
  return ((await json(res)) as { data: Facts }).data;
}
const templateOf = (f: Facts) => new URL(f.overlayUrl).searchParams.get("template");
async function columnsOf(sid: string) {
  const [r] = await sql<{ overlay_delay_ms: number; theme_id: string | null }[]>`select overlay_delay_ms, theme_id from fixture_stream_sessions where id = ${sid}`;
  return r!;
}

describe.skipIf(!HAS_DB)("R2004: a composed session's facts — Input A to read, Input B to publish to, the overlay page to render", () => {
  it("test 3: the INPUT is camera A's SRT PLAYBACK and the TARGET is programme B's RTMPS — the destination key appears nowhere in the body", async () => {
    const s = await session();
    expect(s.inputs.map((i) => i.role), "premise: the camera, then the programme").toEqual(["camera", "programme"]);
    const camera = s.inputs[0]!.creds;
    const programme = s.inputs[1]!.creds;
    const res = await getFacts(s.sessionId, { token: s.jobToken });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text, "the destination key never reaches the Machine").not.toContain(s.streamKey);
    const data = (JSON.parse(text) as { data: Facts }).data;
    expect(data.input).toEqual({ protocol: "srt", url: camera.srtPlayback!.url, streamId: camera.srtPlayback!.streamId, passphrase: camera.srtPlayback!.passphrase });
    expect(data.input.streamId, "PLAYBACK, not the phone's ingest stream id").not.toBe(camera.srt.streamId);
    expect(data.target).toEqual({ url: programme.rtmps.url, streamKey: programme.rtmps.streamKey });
    expect(data.target.streamKey, "B's key, not the camera's").not.toBe(camera.rtmps.streamKey);
    const fixture = contractSession("session-composed-720p");
    expect(data.output, "the default profile is the contract's 720p session").toEqual(fixture.output);
    expect(data.heartbeatIntervalMs).toBe(fixture.heartbeatIntervalMs);
    expect(RelayJobSession.parse(data), "a strict contract session").toEqual(data);
  });

  it("test 4: the EFFECTIVE delay is copied at create — no setting → RELAY_OVERLAY_DELAY_DEFAULT_MS; 0 is a real 0, in the body and the URL; 2500 stays 2500 after the setting moves to 4000; a passthrough create stores 0", async () => {
    expect(RELAY_OVERLAY_DELAY_DEFAULT_MS, "premise: the provisional default the C00 owner session measured (2026-10-15)").toBe(3100);
    const delayIn = (f: Facts) => new URL(f.overlayUrl).searchParams.get("delay");
    const unset = await session();
    expect((await factsOf(unset)).overlayDelayMs).toBe(RELAY_OVERLAY_DELAY_DEFAULT_MS);
    expect((await columnsOf(unset.sessionId)).overlay_delay_ms).toBe(RELAY_OVERLAY_DELAY_DEFAULT_MS);
    const noRow = await session("composed", { settings: { overlay_delay_ms: null } });
    expect((await factsOf(noRow)).overlayDelayMs, "a settings row with a null delay is the default too").toBe(RELAY_OVERLAY_DELAY_DEFAULT_MS);
    const zero = await session("composed", { settings: { overlay_delay_ms: 0 } });
    const z = await factsOf(zero);
    expect(z.overlayDelayMs, "0 is an override, never 'unset'").toBe(0);
    expect(delayIn(z)).toBe("0");
    const kept = await session("composed", { settings: { overlay_delay_ms: 2500 } });
    await sql`update fixture_stream_settings set overlay_delay_ms = 4000 where fixture_id = ${kept.fixtureId}`;
    const k = await factsOf(kept);
    expect(k.overlayDelayMs, "a running session never moves").toBe(2500);
    expect(delayIn(k)).toBe("2500");
    expect((await columnsOf(kept.sessionId)).overlay_delay_ms).toBe(2500);
    const pass = await session("passthrough", { settings: { overlay_delay_ms: 2500 } });
    expect((await columnsOf(pass.sessionId)).overlay_delay_ms, "passthrough has no compositor to delay").toBe(0);
    expect((await factsOf(pass)).overlayDelayMs).toBe(0);
  });

  it("test 8: the overlay URL is the app's overlay page with exactly FIVE params — sid, st, host=compositor, delay, template — and `st` verifies as THIS session's relay-page token", async () => {
    const s = await session();
    const f = await factsOf(s);
    const u = new URL(f.overlayUrl);
    expect(`${u.origin}${u.pathname}`).toBe(`http://app.test/overlay/fixtures/${s.fixtureId}`);
    const keys = [...u.searchParams.keys()];
    expect([...keys].sort()).toEqual(["delay", "host", "sid", "st", "template"]);
    expect(keys, "each exactly once").toHaveLength(5);
    expect(u.searchParams.get("sid")).toBe(s.sessionId);
    expect(u.searchParams.get("host")).toBe("compositor");
    expect(u.searchParams.get("delay")).toBe(String(f.overlayDelayMs));
    expect(u.searchParams.get("template"), "a generic fixture opens on spec §3's non-cricket default").toBe("bug");
    const st = u.searchParams.get("st")!;
    await expect(verifyRelayToken(st, { sid: s.sessionId, scope: "relay-page" })).resolves.toMatchObject({ sid: s.sessionId });
    await expect(verifyRelayToken(st, { sid: s.sessionId, scope: "relay-job" }), "never a job credential").rejects.toMatchObject({ status: 401 });
    const other = await session();
    await expect(verifyRelayToken(st, { sid: other.sessionId, scope: "relay-page" }), "never another session's").rejects.toMatchObject({ status: 401 });
  });

  it("test 9: the overlay URL's template follows the STORED choice, resolved — null + cricket → bar, null + badminton → bug, 'bar' + football → bar, a retired 'gone' + football → bug (and the create does not throw)", async () => {
    // Spec §3's default rule, typed: cricket opens on the bar, every other sport on the bug.
    const cases: [sport: string, stored: string | null, want: string][] = [
      ["cricket", null, "bar"], ["badminton", null, "bug"], ["football", "bar", "bar"], ["football", "gone", "bug"],
    ];
    let checked = 0;
    for (const [sport, stored, want] of cases) {
      const s = await session("composed", { sport, settings: { overlay_template: stored } });
      expect(templateOf(await factsOf(s)), `${sport} + ${String(stored)}`).toBe(want);
      checked++;
    }
    expect(checked, "anti-vacuity: every case ran").toBe(cases.length);
  });

  it("test 10: the template choice is COPIED at create — 'bar' stays 'bar' after the setting moves to 'bug' (facts and theme_id); a passthrough create copies it too; the body's themeId wins over the setting", async () => {
    const s = await session("composed", { settings: { overlay_template: "bar" } });
    await sql`update fixture_stream_settings set overlay_template = 'bug' where fixture_id = ${s.fixtureId}`;
    const f = await factsOf(s);
    expect(templateOf(f), "a running session never moves").toBe("bar");
    expect(f.themeId).toBe("bar");
    expect((await columnsOf(s.sessionId)).theme_id).toBe("bar");
    const pass = await session("passthrough", { settings: { overlay_template: "bar" } });
    expect((await columnsOf(pass.sessionId)).theme_id, "passthrough copies the choice too").toBe("bar");
    const body = await session("composed", { settings: { overlay_template: "bar" }, themeId: "bug" });
    expect((await columnsOf(body.sessionId)).theme_id, "the body's themeId wins").toBe("bug");
    expect(templateOf(await factsOf(body))).toBe("bug");
    const none = await session();
    expect((await columnsOf(none.sessionId)).theme_id, "no choice anywhere: null, resolved at the URL").toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Owed 37 (compositor PR onryde/seazn.club.compositor#27): the compositor sends its FINAL beat on a lane of its own, so a
// periodic beat it sent BEFORE the final can be received — and committed — AFTER it. A late beat must never overwrite
// the stored final: not `last_heartbeat` (the exit's record), not `heartbeat_at` (it anchors the stale window, so a
// late beat delays `lost`), not the egress count (it would move backwards). The late beat is still a SAMPLE. What
// follows a final beat is the R2003 / R2003b rulings', typed here — never read off the code under test.
// ---------------------------------------------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("Owed 37: a late beat never overwrites the final stopped beat", () => {
  /** The three facts the guard protects, as the row holds them (heartbeat_at as text: exact to the microsecond). */
  async function beatFacts(sid: string) {
    const [r] = await sql<{ last_heartbeat: Record<string, unknown> | null; heartbeat_at: string | null; egress: string }[]>`
      select last_heartbeat, heartbeat_at::text as heartbeat_at, egress_bytes::text as egress from fixture_stream_sessions where id = ${sid}`;
    return { lastHeartbeat: r!.last_heartbeat, heartbeatAt: r!.heartbeat_at, egress: Number(r!.egress) };
  }
  /** How many backends wait, directly or down a chain, on the one `pid` holds — a lock queue on the session row. */
  async function queuedBehind(pid: number, want: number): Promise<number> {
    let n = 0;
    for (let i = 0; i < 150 && n < want; i++) {
      await new Promise((res) => setTimeout(res, 20));
      [{ n }] = await sql<{ n: number }[]>`
        with recursive chain(pid) as (
          select ${pid}::int
          union
          select a.pid from pg_stat_activity a join chain c on c.pid = any(pg_blocking_pids(a.pid))
        ) select (count(*) - 1)::int as n from chain`;
    }
    return n;
  }
  // The counts a run of this attempt reports: the final carries the most (it is sent LAST), and the late periodic beat
  // carries one between the previous beat's and the final's (it was sent before the final). Distinct on purpose: a
  // late beat that wrote its count would land on LATE_EGRESS, and one that kept the larger would land on FINAL_EGRESS.
  const PREV_EGRESS = 4_000_000, FINAL_EGRESS = 5_000_000, LATE_EGRESS = 4_500_000;
  const LATE: RelayHeartbeat = { state: "playing", fps: 23, egressBytes: LATE_EGRESS };

  // What a late periodic beat meets after each final, from the rulings: R2003 (no reason → lost → the ONE retry, a NEW
  // attempt; ended / deadline complete the session; refused fails it), R2003b (fatal → Fly restarts the compositor IN
  // PLACE on the SAME attempt, and the restarted process beats again — AGENTS.md class 13: a guard must not skip that
  // legitimate arrival), and stoppedBeatTrigger's own record (signalled is exit 0, which Fly never restarts; session_gone
  // is a run whose session is already over) — after those two no live process of this attempt is left to beat.
  type AfterFinal = "late_dropped" | "over_410" | "same_attempt_restart" | "new_attempt";
  const AFTER_FINAL: Record<BeatExitReason | "absent" | "null", AfterFinal> = {
    absent: "new_attempt", null: "new_attempt",
    ended: "over_410", deadline: "over_410", refused: "over_410",
    fatal: "same_attempt_restart",
    signalled: "late_dropped", session_gone: "late_dropped",
  };

  it("final, then a late periodic beat — every exit reason from a PLAYING runner, and ended / signalled while our own stop is STOPPING it: the stored final stays whole (last_heartbeat, heartbeat_at, egress) wherever no live process of the attempt is left; a terminal session answers 410 and writes nothing; a restart in place and a new attempt still write (count reported)", async () => {
    expect(Object.keys(AFTER_FINAL).sort(), "every exit reason is decided").toEqual([...BEAT_EXIT_REASONS, "absent", "null"].sort());
    const cases: (readonly [label: string, reason: keyof typeof AFTER_FINAL, from: "playing" | "stopping", want: AfterFinal])[] = [
      // Our own Stop: the SIGINT holds the Final scene and the compositor's final beat lands while the runner is stopping —
      // the production shape of Owed 37 (the session is `ending`, not terminal, so the late beat reaches the guard).
      ["stopping × ended", "ended", "stopping", "late_dropped"],
      ["stopping × signalled", "signalled", "stopping", "late_dropped"],
      ...(Object.entries(AFTER_FINAL) as [keyof typeof AFTER_FINAL, AfterFinal][]).map(([reason, want]) => [`playing × ${reason}`, reason, "playing", want] as const),
    ];
    const seen = new Set<AfterFinal>();
    let checked = 0;
    for (const [label, reason, from, want] of cases) {
      const s = await playingSession();
      expect((await postBeat(s.sessionId, { state: "playing", egressBytes: PREV_EGRESS }, { token: s.jobToken })).status, `${label}: premise beat`).toBe(200);
      if (from === "stopping") {
        // A real Machine takes its flush to exit after the SIGINT; the fake would report it stopped at once (the R2003 STOPPING test's runner).
        const slowStop = Object.assign(Object.create(s.runner) as FakeRunner, { async stop() { /* signalled; still flushing */ } });
        setRelayDriversForTest({ ingest: s.ingest, runner: slowStop });
        await stopSession(s.auth, s.fixtureId, s.sessionId, defaultDeps("http://app.test"));
        expect(await row(s.sessionId), `${label}: premise`).toMatchObject({ state: "ending", runner_state: "stopping" });
      }
      const final = { ...stoppedBeat(reason), egressBytes: FINAL_EGRESS };
      expect((await postBeat(s.sessionId, final, { token: s.jobToken })).status, `${label}: the final`).toBe(200);
      // One beat interval passes (inside the composed window), so a late beat that wrote heartbeat_at would MOVE it.
      await advance(s.sessionId, BEAT_S);
      const stored = await beatFacts(s.sessionId);
      expect(stored.lastHeartbeat, `${label}: premise — the final is stored`).toEqual(final);
      const samplesBefore = (await samples(s.sessionId)).length;
      const res = await postBeat(s.sessionId, LATE, { token: s.jobToken });
      const after = await beatFacts(s.sessionId);
      const late = (await samples(s.sessionId)).slice(samplesBefore);
      if (want === "late_dropped") {
        expect(res.status, label).toBe(200);
        expect(after, `${label}: the final survives whole`).toEqual(stored);
        expect(late, `${label}: the late beat is still a sample`).toEqual([{ source: "heartbeat", fps: LATE.fps, bitrate_kbps: null }]);
        // The guard drops a NON-final beat only: the final itself, replayed (its lane retried the POST), is the same
        // fact and still writes — heartbeat_at moves to the replay.
        expect((await postBeat(s.sessionId, final, { token: s.jobToken })).status, `${label}: the replayed final`).toBe(200);
        const replayed = await beatFacts(s.sessionId);
        expect(replayed.lastHeartbeat, `${label}: the replayed final`).toEqual(final);
        expect(replayed.heartbeatAt, `${label}: the replayed final is written`).not.toBe(stored.heartbeatAt);
      } else if (want === "over_410") {
        expect(res.status, label).toBe(410);
        expect(after, `${label}: a terminal session writes nothing`).toEqual(stored);
        expect(late, `${label}: …not even a sample`).toEqual([]);
      } else {
        expect(res.status, label).toBe(200);
        expect(after.lastHeartbeat, `${label}: the next process's beat is written`).toEqual(LATE);
        expect(after.heartbeatAt, `${label}: and it holds the stale window off`).not.toBe(stored.heartbeatAt);
        if (want === "same_attempt_restart") {
          expect(s.runner.created, `${label}: premise — no retry, the same attempt`).toHaveLength(1);
          expect(after.egress, `${label}: the SAME attempt's count never goes backwards`).toBe(Math.max(FINAL_EGRESS, LATE_EGRESS));
        } else {
          expect(s.runner.created, `${label}: premise — the ONE retry booted attempt 2`).toHaveLength(RUNNER_MAX_ATTEMPTS);
          expect(after.egress, `${label}: a new attempt's count is its own, lower or not`).toBe(LATE_EGRESS);
        }
      }
      seen.add(want);
      checked++;
    }
    expect(checked, "anti-vacuity: every case ran").toBe(cases.length);
    expect([...seen].sort(), "every outcome was reached").toEqual(["late_dropped", "new_attempt", "over_410", "same_attempt_restart"]);
  });

  it("the RACE, on two connections: the late periodic beat is in flight before the final commits and commits after it — the final survives (last_heartbeat, heartbeat_at, egress), and the late beat is a sample", async () => {
    const s = await playingSession();
    expect((await postBeat(s.sessionId, { state: "playing", egressBytes: PREV_EGRESS }, { token: s.jobToken })).status).toBe(200);
    // Each beat on its own clock, so the stored heartbeat_at says WHICH beat wrote it.
    const FINAL_AT = new Date(Date.now() + 1_000), LATE_AT = new Date(Date.now() + 2_000);
    const depsAt = (at: Date) => ({ ...defaultDeps("http://app.test"), now: () => at });
    const final: RelayHeartbeat = { state: "stopped", exitReason: "ended", egressBytes: FINAL_EGRESS };
    // A third connection holds the session row, so both beats queue on it in the order they arrive: the final first (on
    // its own lane), then the periodic one. Released, the final commits first and the periodic one second — the order
    // Owed 37 describes. Without a locked decision the periodic beat read the row BEFORE the final committed.
    let release!: () => void;
    const mayCommit = new Promise<void>((res) => (release = res));
    let signalHeld!: (pid: number) => void;
    const held = new Promise<number>((res) => (signalHeld = res));
    const holder = sql.begin(async (tx) => {
      const [{ pid }] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
      await tx`select id from fixture_stream_sessions where id = ${s.sessionId} for update`;
      signalHeld(pid);
      await mayCommit;
    });
    const holderPid = await held;
    const settle = <T,>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));
    const finalBeat = settle(heartbeat(s.sessionId, s.jobToken, final, depsAt(FINAL_AT)));
    expect(await queuedBehind(holderPid, 1), "the race was not staged: the final never queued on the row").toBeGreaterThanOrEqual(1);
    const lateBeat = settle(heartbeat(s.sessionId, s.jobToken, LATE, depsAt(LATE_AT)));
    expect(await queuedBehind(holderPid, 2), "the race was not staged: the periodic beat never queued behind the final").toBeGreaterThanOrEqual(2);
    release();
    await holder;
    const [f, l] = await Promise.all([finalBeat, lateBeat]);
    expect(f.ok ? "resolved" : String((f as { e: unknown }).e), "the final is answered").toBe("resolved");
    expect(l.ok ? "resolved" : String((l as { e: unknown }).e), "the late beat is answered, never a 500").toBe("resolved");
    const after = await beatFacts(s.sessionId);
    expect(after.lastHeartbeat, "the stored beat is the FINAL").toEqual(final);
    expect(after.heartbeatAt === null ? null : new Date(after.heartbeatAt).getTime(), "heartbeat_at is the final's").toBe(FINAL_AT.getTime());
    expect(after.egress, "egress is the final's").toBe(FINAL_EGRESS);
    const fps = (await samples(s.sessionId)).map((r) => r.fps);
    expect(fps, "the late beat is still a sample").toContain(LATE.fps);
  });

  it("a NEW attempt after an old one stopped writes normally — its measured zero included (G5's other half) — then holds its own count and drops its own late beat (both directions, AGENTS.md class 13)", async () => {
    const s = await playingSession();
    expect((await postBeat(s.sessionId, { state: "playing", egressBytes: 9_000_000 }, { token: s.jobToken })).status).toBe(200);
    // Attempt 1's final gives no reason: lost → torn down → the ONE retry (R2003), which restarts the beat window.
    expect((await postBeat(s.sessionId, { ...stoppedBeat("absent"), egressBytes: 9_500_000 }, { token: s.jobToken })).status).toBe(200);
    expect(s.runner.created, "premise: attempt 2 booted").toHaveLength(RUNNER_MAX_ATTEMPTS);
    expect(await row(s.sessionId), "premise: live, the replacement booting").toMatchObject({ state: "live", runner_state: "booting" });
    expect(await lastHeartbeat(s.sessionId), "premise: attempt 1's final is stored").toMatchObject({ state: "stopped" });
    await advance(s.sessionId, BEAT_S);
    const token2 = s.runner.created[1]!.jobToken;
    const steps: [body: Record<string, unknown>, egress: number, stored: "this" | "kept"][] = [
      [{ state: "starting", egressBytes: 0 }, 0, "this"],            // the replacement's first beat: written, and its 0 is a measured 0
      [{ state: "playing", egressBytes: 1_000 }, 1_000, "this"],
      [{ state: "playing" }, 1_000, "this"],                         // omitted: unchanged
      [{ state: "playing", egressBytes: 500 }, 1_000, "this"],       // attempt 2's own count never goes backwards
      [{ state: "stopped", exitReason: "signalled", egressBytes: 2_000 }, 2_000, "this"],   // attempt 2's final
      [{ state: "playing", egressBytes: 1_500 }, 2_000, "kept"],     // …and attempt 2's own late beat is dropped
    ];
    let checked = 0, last: Record<string, unknown> | null = null;
    for (const [body, egress, stored] of steps) {
      expect((await postBeat(s.sessionId, body, { token: token2 })).status, JSON.stringify(body)).toBe(200);
      const after = await beatFacts(s.sessionId);
      if (stored === "this") last = body;
      expect(after.lastHeartbeat, JSON.stringify(body)).toEqual(last);
      expect(after.egress, JSON.stringify(body)).toBe(egress);
      checked++;
    }
    expect(checked).toBe(steps.length);
    expect(s.runner.created, "no third Machine").toHaveLength(RUNNER_MAX_ATTEMPTS);
  });
});
