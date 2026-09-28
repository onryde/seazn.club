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
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { MAX_DURATION_MINUTES, RUNNER_MAX_ATTEMPTS, RUNNER_OBSERVE_SLACK_SECONDS, RUNNER_STOP_GRACE_SECONDS, STALE_HEARTBEAT_SECONDS } from "@/server/relay/config";
import { failReasonFromExit, type ExitInfo } from "@/server/relay/domain/runner";
import { setRelayDriversForTest } from "@/server/relay/drivers";
import { FakeIngest, FakeRunner } from "@/server/relay/fakes";
import { rigUser } from "@/server/relay/__tests__/_session-rig";
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


/** The exit an OOM-killed Machine reports (Fly's event shape). Its fail reason is DERIVED from the domain's table. */
const OOM_EXIT: ExitInfo = { exitCode: 137, oomKilled: true, requestedStop: false };
/** A storage pool no plausible number of foreign reservations can exhaust — the pool is ONE account across the whole
 *  test database (Task 10 deviation 4), and these tests are not about it. */
const ROOMY_STORAGE_MINUTES = 100_000_000;
const YT = "rtmps://a.rtmps.youtube.com/live2";

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
  const target = await createStreamTarget(auth, auth.orgId, { kind: "youtube", label: "T", rtmpUrl: YT, streamKey });
  // The fake ingest never connects inside a test: a passthrough session stays `warming` until the test moves it.
  const ingest = new FakeIngest({ connectAfterMs: 10 * 60_000 });
  ingest.storage = { totalStorageMinutes: 0, totalStorageMinutesLimit: ROOMY_STORAGE_MINUTES, videoCount: 0 };
  const runner = new FakeRunner();
  setRelayDriversForTest({ ingest, runner });
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
    // The DECRYPTED destination, compared with what the organiser saved — not with anything the route computed.
    expect(body.data.target.streamKey).toBe(s.streamKey);
    expect(new URL(body.data.target.url).hostname).toBe(new URL(YT).hostname);
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
  it("N3: a forced destroy whose provider call fails AND whose ledger write fails is thrown — the ledger error, not the provider's — and is not treated as a provider failure", async () => {
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
