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
import { RelayHeartbeatReply, RelayJobSession } from "@/server/api-v1/schemas";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { STREAM_PLATFORM_PRESETS } from "@/lib/stream-destinations";
import { MAX_DURATION_MINUTES, RUNNER_MAX_ATTEMPTS, RUNNER_OBSERVE_SLACK_SECONDS, RUNNER_STOP_GRACE_SECONDS, STALE_HEARTBEAT_SECONDS } from "@/server/relay/config";
import { failReasonFromExit, type ExitInfo } from "@/server/relay/domain/runner";
import { setRelayDriversForTest } from "@/server/relay/drivers";
import { FakeIngest, FakeRunner } from "@/server/relay/fakes";
import { pairPresentPhone, rigUser } from "@/server/relay/__tests__/_session-rig";
import { recordEvent, recordSample } from "@/server/relay/telemetry";
import { mintRelayToken, verifyRelayToken } from "@/server/relay/tokens";
import { GET as facts } from "@/app/api/internal/relay/sessions/[sid]/route";
import { POST as beat } from "@/app/api/internal/relay/sessions/[sid]/heartbeat/route";
import { seedOrg, startedDivisionWithFixture } from "./_rig";
import { grantCredits } from "../stream-credits";
import { createStreamTarget } from "../stream-targets";
import { createSession, defaultDeps, sessionFactsForJob, stopSession } from "../stream-sessions";

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

async function session(mode: Mode = "composed") {
  const seeded = await seedOrg();
  // A8: the organiser who starts a stream is a REAL users row (the actor guard refuses a null userId with 403).
  const auth = { ...seeded.auth, userId: await rigUser() };
  const { fixtureId } = await startedDivisionWithFixture(auth);
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
  const runner = new FakeRunner();
  setRelayDriversForTest({ ingest, runner });
  await pairPresentPhone(fixtureId);   // A7 (capture QR v2 T6): W5 refuses a Go live with no present phone
  const { sessionId } = await createSession(auth, fixtureId, { mode, targetId: target.id }, defaultDeps("http://app.test"));
  // A passthrough session has no Machine, so no runner ever mints its job token; the 410 case mints one the same way.
  const jobToken = mode === "composed"
    ? runner.created[0]!.jobToken
    : await mintRelayToken({ sid: sessionId, scope: "relay-job", expiresAt: new Date(Date.now() + 60 * 60_000) });
  return { auth, fixtureId, sessionId, jobToken, streamKey, ingest, runner };
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
  }[]>`select state, fail_reason, end_reason, desired_state, heartbeat_at, runner_state, machine_id,
              runner_exit_code, runner_oom_killed, runner_requested_stop
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
    // The DECRYPTED destination, compared with what the organiser saved (the key) and the platform's preset url (D6:
    // the server fills it) — not with anything the route computed.
    expect(body.data.target.streamKey).toBe(s.streamKey);
    expect(body.data.target.url).toBe(STREAM_PLATFORM_PRESETS.youtube);
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
  it("egressBytes: a beat that reports it stores it; a beat that OMITS it leaves the stored value alone; a beat that reports 0 stores 0", async () => {
    const s = await session();
    expect(await egressOf(s.sessionId), "the column's default before any beat").toBe(0);
    const steps: [Record<string, unknown>, number][] = [
      [{ state: "playing", egressBytes: 5_000_000 }, 5_000_000],
      [{ state: "playing" }, 5_000_000],
      [{ state: "playing", fps: 30 }, 5_000_000],
      [{ state: "playing", egressBytes: 7_250_000 }, 7_250_000],
      [{ state: "playing", egressBytes: 0 }, 0],
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
    expect(((await json(ok)) as { data: { target: { streamKey: string } } }).data.target.streamKey).toBe(s.streamKey);
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
    expect({ ...f2, pageToken: null }).toEqual({ ...f1, pageToken: null });
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
const R2_HEALTH_FIELDS = ["programmePhase", "input", "output", "graphics", "inputKicks", "inputKickAlert", "pipelineRebuilds", "sinkSwaps", "rung", "scoreStale"];
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
    expect(checked, "anti-vacuity: ten fields, two stores (the exit fields are the final beat's test below)").toBe(20);
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
    expect(checked, "anti-vacuity: twelve fields, four reads").toBe(48);
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

  // Owner scope addition (2026-10-15): the final beat carries the exit reason. Recorded in both beat stores — and ONLY
  // there: what web does with a stopped beat is R2003's, so this asserts the record, never a reaction. The runner's own
  // exit columns are written from the OBSERVED exit (A5), never from a beat.
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
    // A stopped beat moves the runner today (callback_stopped — unchanged here; R2003 owns it). The exit REASON adds
    // nothing to that: a twin session sent the same stopped beat WITHOUT the two fields ends with the same runner facts.
    const twin = await session();
    expect((await postBeat(twin.sessionId, { state: "stopped" }, { token: twin.jobToken })).status).toBe(200);
    const pick = (r: Awaited<ReturnType<typeof row>>) => ({ state: r.state, runner_state: r.runner_state, desired_state: r.desired_state,
      runner_exit_code: r.runner_exit_code, runner_oom_killed: r.runner_oom_killed, runner_requested_stop: r.runner_requested_stop });
    expect(pick(await row(s.sessionId)), "the reason is recorded, never acted on").toEqual(pick(await row(twin.sessionId)));
    expect((await row(s.sessionId)).runner_exit_code, "fatal's 70 is the Machine's word, not an observed exit").not.toBe(70);
    // The two refusals the addition owes, through the same route: an exit reason outside C06's vocabulary, and a
    // detail one character past its bound. Each is a 400 that writes nothing.
    const t = await session();
    for (const [label, body] of [
      ["exitReason \"crashed\"", vector("heartbeat-invalid-exit-reason")],
      ["exitDetail of 201 characters", { ...fatal, exitDetail: "x".repeat(201) }],
      ["an exit reason on a playing beat (review M6)", vector("heartbeat-refused-exit-while-playing")],
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
  });

  // Review M4: Session.fixtureId is `string | null` — V410 `on delete set null`, the session outlives its fixture. The
  // runtime witness: the Machine's own GET after the fixture is gone, in both modes.
  it("review M4: delete the fixture mid-session and GET facts answers fixtureId null — still a strict RelayJobSession", async () => {
    let checked = 0;
    for (const mode of ["composed", "passthrough"] as const) {
      const x = await session(mode);
      const before = ((await json(await getFacts(x.sessionId, { token: x.jobToken }))) as { data: Record<string, unknown> }).data;
      expect(before.fixtureId, `${mode}: the positive pair — before, the fixture's id`).toBe(x.fixtureId);
      await sql`delete from fixtures where id = ${x.fixtureId}`;
      const [{ fixture_id }] = await sql<{ fixture_id: string | null }[]>`select fixture_id from fixture_stream_sessions where id = ${x.sessionId}`;
      expect(fixture_id, `${mode}: premise — the session row survives with a null fixture`).toBeNull();
      const res = await getFacts(x.sessionId, { token: x.jobToken });
      expect(res.status, mode).toBe(200);
      const data = ((await json(res)) as { data: Record<string, unknown> }).data;
      expect(data, mode).toHaveProperty("fixtureId", null);
      expect(RelayJobSession.parse(data), `${mode}: parse keeps every key`).toEqual(data);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("GET facts is a STRICT RelayJobSession: passthrough carries no composed-only key; composed carries none either until R2004 serves them (R2004 turns that half around)", async () => {
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
      for (const k of COMPOSED_ONLY) expect(body.data, `${mode}: ${k}`).not.toHaveProperty(k);
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
      { state: "playing", programmePhase: "reconnecting", input: "backoff", output: "connected", graphics: "failed", rung: "fast_preset", inputKicks: 4, inputKickAlert: true, pipelineRebuilds: 3, sinkSwaps: 1, scoreStale: true },
      { state: "playing", programmePhase: "live", input: "connected", output: "backoff", graphics: "ready", rung: "full", inputKicks: 2, inputKickAlert: false, pipelineRebuilds: 3, sinkSwaps: 2, scoreStale: false },
      { state: "playing", programmePhase: "live", input: "backoff", output: "connected", graphics: "ready", rung: "full", inputKicks: 2, inputKickAlert: false, pipelineRebuilds: 3, sinkSwaps: 2 },
      // The first Machine's final beat (it was signalled), then the retry's (fatal) — R2003's one retry, as beats.
      { state: "stopped", exitReason: "signalled", exitDetail: "SIGTERM: draining before exit" },
      vector("heartbeat-final-fatal"),
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
    expect(new Date(r.last_beat_at as string).toISOString()).toBe("2026-10-15T12:00:40.000Z");
    // The exit reason is the LATEST one reported (the final beat's), never the first (the signalled one before it).
    expect(r).toMatchObject({ exit_reason: "fatal", exit_detail: "programme start failed: cefsrc not found" });
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
      session_id: quiet.sessionId, beats: 0, reported_beats: 0, kick_alert_beats: 0, input_backoff_beats: 0,
      max_input_kicks: null, longest_input_backoff_s: null, first_beat_at: null, last_heartbeat: null, exit_reason: null, exit_detail: null,
    });
    // The positive pair: the busy session's own review sees its one beat.
    expect((await healthReview(busy.sessionId))[0]).toMatchObject({ beats: 1, reported_beats: 1, kick_alert_beats: 1, max_input_kicks: 4 });
    expect(await healthReview(randomUUID())).toEqual([]);
  });
});
