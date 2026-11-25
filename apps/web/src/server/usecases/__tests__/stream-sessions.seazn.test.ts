// Seazn-hosted video, Phase 1 Task 11: ADMISSION of a session whose destination is the org's `seazn` row (V541). It runs
// composed whatever mode the caller named, has no external destination (no output, no broadcast, no key read), and two
// refusals of its own: 422 seazn_unavailable (SEAZN_HOSTED_LIVE off) and 503 seazn_video_unconfigured (any relay driver with no
// SEAZN_VIDEO_ORIGINS — Task 12 review I1: the fake signs too), both before any provider call. Real Postgres, fake relay and YouTube ports on an injected clock.
//
// Every start goes through a REAL producer: the organiser's Go live (`createSession`), the phone's start (`postStart`) and the
// automatic start (a beat through `postBeat` → `maybeAutoStart`). Expectations come from the plan and the spec (one credit at
// live; a passthrough start makes one camera input and one output; composed adds a programme input and a Machine), never from
// the code under test.
//
// Task 12 adds what a Seazn session IS once admitted: no output (G1), and a programme input created signed (G5), its settings
// stored on fixture_stream_inputs.access in the statement that stores the input's credentials and never updated after.
//
// ONE SPORT, on purpose (TEST-STRATEGY rule 6): the destination layer never reads a sport rule; every rig rides `generic`.
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));
// The security pins: which start re-reads a saved key, the allowlist re-check, and the pooled key — PASS-THROUGH spies.
vi.mock("@/server/relay/secret-columns", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/relay/secret-columns")>();
  return { ...real, readTargetSecret: vi.fn(real.readTargetSecret), readPooledKey: vi.fn(real.readPooledKey) };
});
vi.mock("@/lib/stream-destinations", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/stream-destinations")>();
  return { ...real, checkDestination: vi.fn(real.checkDestination) };
});
// The backoff control's own witness (Task 11 review m6): what the automatic start's window answered — a PASS-THROUGH spy.
vi.mock("@/server/youtube/auto-backoff", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/youtube/auto-backoff")>();
  return { ...real, autoBackoffRefusalCode: vi.fn(real.autoBackoffRefusalCode) };
});

import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { checkDestination, SEAZN_UNAVAILABLE, SEAZN_VIDEO_UNCONFIGURED } from "@/lib/stream-destinations";
import { CaptureBeat } from "@/server/api-v1/capture-schemas";
import { AUTO_START_RETRY_SECONDS } from "@/server/relay/config";
import { setRelayDriversForTest } from "@/server/relay/drivers";
import { FakeIngest, FakeRunner } from "@/server/relay/fakes";
import type { RelayDrivers } from "@/server/relay/drivers";
import type { ProviderCallRecorder } from "@/server/relay/ports";
import { readPooledKey, readTargetSecret } from "@/server/relay/secret-columns";
import { recordProviderCall } from "@/server/relay/telemetry";
import { pairPresentPhone, rigUser } from "@/server/relay/__tests__/_session-rig";
import { log } from "@/server/logger";
import { autoBackoffRefusalCode } from "@/server/youtube/auto-backoff";
import { FakeYouTube } from "@/server/youtube/fake";
import { prepareYoutubeBroadcast } from "@/server/youtube/prepare";
import { connect } from "@/server/youtube/__tests__/_connect-rig";
import { CaptureRefusalError } from "@/server/api-v1/capture-http";
import { postBeat, postStart } from "../capture-phone";
import { saveStreamSettings } from "../stream-codes";
import { grantCredits } from "../stream-credits";
import {
  ACTIVE_STATES, type SessionDeps, createSession as organiserStart, currentSession, heartbeat, stopSession, tickSession,
} from "../stream-sessions";
import { programmeAccess, seaznAccess } from "../stream-sessions/destination";
import { createStreamTarget } from "../stream-targets";
import { captureRig, override, phoneId } from "./_capture-rig";
import { seedOrg, startedDivisionWithFixture } from "./_rig";

const HAS_DB = !!process.env.DATABASE_URL;
const SEC = 1000;
const ROOMY_STORAGE_MINUTES = 100_000_000;

// The keys and the compositor image this file runs on (the stream-sessions.test.ts precedent), put back afterwards — never
// assigned `undefined`, which Node stores as the string "undefined". No key is ever printed.
const ENV_KEYS = ["RELAY_KEK", "YOUTUBE_TOKEN_KEK", "RELAY_IMAGE", "AUTH_SECRET"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
beforeAll(() => {
  process.env.RELAY_KEK = randomBytes(32).toString("hex");
  process.env.YOUTUBE_TOKEN_KEK = randomBytes(32).toString("hex");
  process.env.RELAY_IMAGE = "registry.fly.io/seazn-relay:seazn-admission-test";
  process.env.AUTH_SECRET ??= "seazn-admission-test-secret";
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});
beforeEach(() => {
  vi.stubEnv("SEAZN_HOSTED_LIVE", "true");
  // Task 12: provisioning signs a Seazn programme input for these hosts (seaznAccess), and admission asks for them on EVERY relay
  // driver (review I1), so every Seazn start needs them; a test that wants them absent says so itself.
  vi.stubEnv("SEAZN_VIDEO_ORIGINS", "seazn.club");
  vi.mocked(readTargetSecret).mockClear();
  vi.mocked(readPooledKey).mockClear();
  vi.mocked(checkDestination).mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  setRelayDriversForTest(null);
});

/** Every relay port call in ORDER, as `ingest.<method>` / `runner.<method>` — the provider-call sequence a start makes. */
function traced(ingest: FakeIngest, runner: FakeRunner): { drivers: RelayDrivers; calls: string[] } {
  const calls: string[] = [];
  const wrap = <T extends object>(port: T, name: string): T => new Proxy(port, {
    get(t, p) {
      const v = Reflect.get(t, p, t) as unknown;
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => { calls.push(`${name}.${String(p)}`); return (v as (...a: unknown[]) => unknown).apply(t, args); };
    },
  });
  return { drivers: { ingest: wrap(ingest, "ingest"), runner: wrap(runner, "runner") }, calls };
}

/** An org with two started fixtures, the relay and overlay entitlements, `credits` bought credits, a phone paired on each
 *  fixture, a pasted YouTube key, and its Seazn row (made by V541's trigger, read here, never inserted). */
async function rig(opts: { credits?: number; recorder?: ProviderCallRecorder } = {}) {
  const seeded = await seedOrg();
  const auth = { ...seeded.auth, userId: await rigUser() };
  const { fixtureIds } = await startedDivisionWithFixture(auth, { fixtures: 2 });
  await override(auth.orgId, "streaming.overlay", true);
  await override(auth.orgId, "streaming.relay", true);
  for (const f of fixtureIds) await pairPresentPhone(f);
  await grantCredits({ orgId: auth.orgId, delta: opts.credits ?? 5, createdBy: await rigUser(), note: "seazn admission", idempotencyKey: randomUUID() });
  const pasted = await createStreamTarget(auth, auth.orgId, { kind: "youtube", label: "Club", streamKey: `yt-${randomUUID()}` });
  const [seazn] = await sql<{ id: string }[]>`select id from org_stream_targets where org_id = ${auth.orgId} and kind = 'seazn'`;
  expect(seazn, "PREMISE: V541 gave the org its Seazn destination").toBeDefined();
  let now = Date.now();
  const ingest = new FakeIngest({ clock: () => now, connectAfterMs: 3000, ...(opts.recorder ? { recorder: opts.recorder } : {}) });
  ingest.storage = { totalStorageMinutes: 0, totalStorageMinutesLimit: ROOMY_STORAGE_MINUTES, videoCount: 0 };
  const runner = new FakeRunner();
  const t = traced(ingest, runner);
  const deps: SessionDeps = { drivers: t.drivers, now: () => new Date(now), appUrl: "http://app.test" };
  // The rig's own save re-checked the pasted url: the spies count from here.
  vi.mocked(readTargetSecret).mockClear();
  vi.mocked(readPooledKey).mockClear();
  vi.mocked(checkDestination).mockClear();
  return {
    auth, fixtureIds: fixtureIds as [string, string], pasted: pasted.id, seazn: seazn!.id, ingest, runner, deps, calls: t.calls,
    tick: (ms: number) => { now += ms; },
  };
}
type Rig = Awaited<ReturnType<typeof rig>>;

/** The organiser's Go live, its phone re-beaten on the start's own clock (stream-sessions.test.ts's `createSession`). */
async function goLive(r: Rig, fixtureId: string, body: { mode: "passthrough" | "composed"; targetId: string }, deps: SessionDeps = r.deps) {
  await pairPresentPhone(fixtureId, { at: deps.now() });
  return organiserStart(r.auth, fixtureId, body, deps);
}
const refusalOf = (p: Promise<unknown>): Promise<unknown> => p.then(() => null, (e: unknown) => e);
const sessionRow = async (sid: string) => (await sql<{ mode: string; state: string; destination_kind: string | null; api_backed: boolean; youtube_broadcast_id: string | null; output_uid: string | null }[]>`
  select mode, state, destination_kind, api_backed, youtube_broadcast_id, output_uid from fixture_stream_sessions where id = ${sid}`)[0]!;
const sessionsOn = async (fixtureId: string) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_sessions where fixture_id = ${fixtureId}`)[0]!.n;
const broadcastsOf = async (orgId: string) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from youtube_broadcasts where org_id = ${orgId}`)[0]!.n;
/** Net credits a session moved: -1 is one consumed (the consume/refund ledger rows that name it). */
const netSpend = async (sid: string) =>
  (await sql<{ net: number }[]>`select coalesce(sum(delta), 0)::int as net from org_stream_credits where session_id = ${sid} and reason in ('consume','refund')`)[0]!.net;
/** The Machine's beat that takes a composed session live (its job token is the one the fake runner was given). */
async function machinePlays(r: { runner: FakeRunner; deps: SessionDeps }, sid: string) {
  const spec = r.runner.created.find((c) => c.sessionId === sid);
  expect(spec, `PREMISE: a Machine was created for ${sid}`).toBeDefined();
  await heartbeat(sid, spec!.jobToken, { state: "playing" }, r.deps);
}
/** Stop, then read until the composed session has completed (the fake's stopped Machine is gone by the next look). */
async function stopAndSettle(r: Rig, fixtureId: string, sid: string) {
  await stopSession(r.auth, fixtureId, sid, r.deps);
  for (let i = 0; i < 3 && (await sessionRow(sid)).state !== "completed"; i++) await currentSession(r.auth, fixtureId, r.deps);
  expect((await sessionRow(sid)).state, "the stopped session completed").toBe("completed");
}

describe.skipIf(!HAS_DB)("Seazn destination — admission", () => {
  it("a PASSTHROUGH Go live on Seazn is admitted as composed, destination_kind seazn: no broadcast row, no key read, no allowlist re-check, no output — and its provider calls are the composed set (camera + programme input, one Machine)", async () => {
    const r = await rig();
    const [f1] = r.fixtureIds;
    const broadcastsBefore = await broadcastsOf(r.auth.orgId);
    const { sessionId } = await goLive(r, f1, { mode: "passthrough", targetId: r.seazn });
    expect(await sessionRow(sessionId)).toMatchObject({ mode: "composed", destination_kind: "seazn", api_backed: false, youtube_broadcast_id: null, output_uid: null });
    expect(await broadcastsOf(r.auth.orgId), "no youtube_broadcasts row").toBe(broadcastsBefore);
    expect(readTargetSecret, "no saved key is read for Seazn").not.toHaveBeenCalled();
    expect(readPooledKey, "no pooled key either").not.toHaveBeenCalled();
    expect(checkDestination, "no stored url to re-check").not.toHaveBeenCalled();
    // Spec (R2004): composed = the admission's storage read, the camera input, the programme input and one Machine. G1: no output.
    expect(r.calls).toEqual(["ingest.storageUsage", "ingest.createLiveInput", "ingest.createLiveInput", "runner.create"]);
    expect(r.calls.filter((c) => c === "ingest.addOutput")).toHaveLength(0);
  });

  it("one credit is consumed when the Seazn session goes live — the same count a composed session on a pasted key consumes", async () => {
    const r = await rig({ credits: 5 });
    const [f1, f2] = r.fixtureIds;
    const seazn = (await goLive(r, f1, { mode: "composed", targetId: r.seazn })).sessionId;
    await machinePlays(r, seazn);
    expect((await sessionRow(seazn)).state).toBe("live");
    const pasted = (await goLive(r, f2, { mode: "composed", targetId: r.pasted })).sessionId;
    await machinePlays(r, pasted);
    expect((await sessionRow(pasted)).state).toBe("live");
    // The rule (openapi: "one match credit is consumed when it goes live"), and the pasted twin as the control.
    expect(await netSpend(seazn)).toBe(-1);
    expect(await netSpend(pasted)).toBe(-1);
  });

  it("Review Focus 1: a SECOND fixture of the org starts on Seazn while the first is live — both are admitted and both are active", async () => {
    const r = await rig();
    const [f1, f2] = r.fixtureIds;
    const first = (await goLive(r, f1, { mode: "composed", targetId: r.seazn })).sessionId;
    await machinePlays(r, first);
    const second = (await goLive(r, f2, { mode: "passthrough", targetId: r.seazn })).sessionId;
    const active = await sql<{ id: string }[]>`
      select id from fixture_stream_sessions where target_id = ${r.seazn} and state in ${sql([...ACTIVE_STATES])} order by id`;
    expect(active.map((a) => a.id).sort()).toEqual([first, second].sort());
    expect((await sessionRow(first)).state, "the first match is still live").toBe("live");
  });

  it("Task 36d: TWO fixtures start on Seazn at the SAME moment — the target row lock queues them, nothing deadlocks, both are admitted (the one_active_target index carves Seazn out)", async () => {
    const r = await rig();
    const [f1, f2] = r.fixtureIds;
    const settled = await Promise.allSettled([
      goLive(r, f1!, { mode: "composed", targetId: r.seazn }),
      goLive(r, f2!, { mode: "composed", targetId: r.seazn }),
    ]);
    const refused = settled.flatMap((s) => (s.status === "rejected" ? [s.reason as { code?: string; message?: string }] : []));
    expect(refused.map((e) => `${e.code ?? "no code"}: ${e.message ?? ""}`), "neither start is refused").toEqual([]);
    const ids = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value.sessionId] : []));
    const active = await sql<{ id: string }[]>`
      select id from fixture_stream_sessions where target_id = ${r.seazn} and state in ${sql([...ACTIVE_STATES])} order by id`;
    expect(active.map((a) => a.id).sort()).toEqual([...ids].sort());
    expect(ids).toHaveLength(2);
  });

  it("LIVE off: a Go live naming the Seazn row is 422 seazn_unavailable — zero provider calls, no row, no pre-pick, no key read; the same org's pasted key still starts", async () => {
    const r = await rig();
    const [f1, f2] = r.fixtureIds;
    vi.stubEnv("SEAZN_HOSTED_LIVE", "false");
    for (const mode of ["passthrough", "composed"] as const) {
      const err = await refusalOf(goLive(r, f1, { mode, targetId: r.seazn }));
      expect(err, mode).toBeInstanceOf(HttpError);
      expect({ status: (err as HttpError).status, code: (err as HttpError).code }, mode).toEqual({ status: 422, code: SEAZN_UNAVAILABLE });
    }
    expect(r.calls, "no provider call").toEqual([]);
    expect(await sessionsOn(f1), "no session row").toBe(0);
    expect(await sql`select 1 from fixture_stream_settings where fixture_id = ${f1}`, "no pre-pick").toHaveLength(0);
    expect(readTargetSecret).not.toHaveBeenCalled();
    // The positive pair: the flag refuses the Seazn row only.
    await goLive(r, f2, { mode: "passthrough", targetId: r.pasted });
    expect(r.calls.length, "the pasted start called the provider").toBeGreaterThan(0);
  });

  it("LIVE on, a LIVE relay with no SEAZN_VIDEO_ORIGINS: 503 seazn_video_unconfigured with zero provider calls and no row; with the origins set the same start is admitted", async () => {
    const r = await rig();
    const [f1] = r.fixtureIds;
    vi.stubEnv("RELAY_DRIVERS", "live");
    vi.stubEnv("SEAZN_VIDEO_ORIGINS", "");
    // The test override answers the relay half of `composedUnavailable()` (drivers.ts), so the composed gate passes and only the
    // Seazn configuration can refuse.
    setRelayDriversForTest({ ingest: r.ingest, runner: r.runner });
    const err = await refusalOf(goLive(r, f1, { mode: "composed", targetId: r.seazn }));
    expect(err).toBeInstanceOf(HttpError);
    expect({ status: (err as HttpError).status, code: (err as HttpError).code }).toEqual({ status: 503, code: SEAZN_VIDEO_UNCONFIGURED });
    expect(r.calls, "no provider call").toEqual([]);
    expect(await sessionsOn(f1)).toBe(0);
    vi.stubEnv("SEAZN_VIDEO_ORIGINS", "seazn.club");
    const { sessionId } = await goLive(r, f1, { mode: "composed", targetId: r.seazn });
    expect((await sessionRow(sessionId)).destination_kind).toBe("seazn");
  });

  it("review m1 (+ Task 12 review m2): a MALFORMED SEAZN_VIDEO_ORIGINS (a scheme on an entry) is the same 503 seazn_video_unconfigured on the LIVE and the FAKE relay — never an unmapped 500 — with zero provider calls, no row, and the value never logged", async () => {
    const r = await rig();
    const [f1] = r.fixtureIds;
    const malformed = "https://seazn-malformed-origin.example";
    vi.stubEnv("SEAZN_VIDEO_ORIGINS", malformed);
    const logged: unknown[] = [];
    const spies = (["error", "warn", "info"] as const).map((lvl) => vi.spyOn(log, lvl).mockImplementation(((...a: unknown[]) => { logged.push(a); }) as never));
    let checked = 0;
    try {
      for (const driver of ["live", "fake"] as const) {
        vi.stubEnv("RELAY_DRIVERS", driver);
        setRelayDriversForTest({ ingest: r.ingest, runner: r.runner });
        const before = logged.length;
        const err = await refusalOf(goLive(r, f1, { mode: "composed", targetId: r.seazn }));
        expect(err, driver).toBeInstanceOf(HttpError);
        expect({ status: (err as HttpError).status, code: (err as HttpError).code }, driver).toEqual({ status: 503, code: SEAZN_VIDEO_UNCONFIGURED });
        expect(r.calls, `${driver}: no provider call`).toEqual([]);
        expect(await sessionsOn(f1), `${driver}: no session row`).toBe(0);
        expect(logged.length, `${driver}: PREMISE: the config fault was logged`).toBeGreaterThan(before);
        checked++;
      }
      expect(JSON.stringify(logged), "the env value is never echoed").not.toContain("seazn-malformed-origin");
    } finally {
      for (const sp of spies) sp.mockRestore();
    }
    expect(checked).toBe(2);
  });

  it("a Seazn restart: this fixture's previous composed session left its Machine up — admission destroys it; ANOTHER fixture's ended Seazn session's Machine (still publishing to its own programme input) is left alone", async () => {
    const r = await rig();
    const [f1, f2] = r.fixtureIds;
    const old1 = (await goLive(r, f1, { mode: "composed", targetId: r.seazn })).sessionId;
    const old2 = (await goLive(r, f2, { mode: "composed", targetId: r.seazn })).sessionId;
    const m1 = (await sql<{ m: string }[]>`select machine_id as m from fixture_stream_sessions where id = ${old1}`)[0]!.m;
    const m2 = (await sql<{ m: string }[]>`select machine_id as m from fixture_stream_sessions where id = ${old2}`)[0]!.m;
    // Both sessions ended with their Machine still listed (a destroy that never landed): only the read side is under test.
    await sql`update fixture_stream_sessions set state = 'completed', ended_at = now(), end_reason = 'stopped' where id in ${sql([old1, old2])}`;
    const listed = (await r.runner.list()).map((m) => m.runnerId);
    expect(listed, "PREMISE: both Machines are still listed").toEqual(expect.arrayContaining([m1, m2]));
    const restarted = (await goLive(r, f1, { mode: "composed", targetId: r.seazn })).sessionId;
    expect(r.runner.destroyed, "this fixture's leftover Machine is destroyed, the other fixture's is not").toEqual([m1]);
    const destroys = await sql<{ session_id: string }[]>`
      select session_id from fixture_stream_events where kind = 'effect' and type = 'force_destroy' and session_id in ${sql([old1, old2])}`;
    expect(destroys.map((d) => d.session_id)).toEqual([old1]);
    expect((await sessionRow(restarted)).destination_kind).toBe("seazn");
  });

  it("regression (G1): a pasted-key start and a YouTube start make the provider calls they always made, and each still re-reads its key (pasted: readTargetSecret + the allowlist; YouTube: the pooled key)", async () => {
    const r = await rig();
    const [f1, f2] = r.fixtureIds;
    // Pasted passthrough — spec C9: the admission's storage read, one camera input, exactly one output on it.
    await goLive(r, f1, { mode: "passthrough", targetId: r.pasted });
    expect(r.calls).toEqual(["ingest.storageUsage", "ingest.createLiveInput", "ingest.addOutput"]);
    expect(vi.mocked(readTargetSecret).mock.calls.length, "the saved key is read (probe + admission + the output)").toBeGreaterThan(0);
    expect(vi.mocked(readTargetSecret).mock.calls.every(([, , target]) => target === r.pasted)).toBe(true);
    expect(checkDestination, "the stored url is re-checked").toHaveBeenCalledTimes(1);
    expect(readPooledKey).not.toHaveBeenCalled();
    // YouTube Connect: the same relay calls, the broadcast prepared at YouTube, and the POOLED key opened instead of a saved one.
    r.calls.length = 0;
    vi.mocked(readTargetSecret).mockClear();
    vi.mocked(checkDestination).mockClear();
    const yt = await connect({ auth: r.auth, orgId: r.auth.orgId, userId: r.auth.userId });
    const fake = new FakeYouTube();
    const { sessionId } = await goLive(r, f2, { mode: "passthrough", targetId: yt.targetId }, { ...r.deps, youtube: fake });
    expect(r.calls).toEqual(["ingest.storageUsage", "ingest.createLiveInput", "ingest.addOutput"]);
    expect(fake.calls.filter((c) => c.method === "insertBroadcast"), "one broadcast prepared at YouTube").toHaveLength(1);
    expect((await sessionRow(sessionId))).toMatchObject({ api_backed: true, destination_kind: "youtube" });
    expect(readPooledKey, "the broadcast's pooled key is opened").toHaveBeenCalled();
    expect(readTargetSecret).not.toHaveBeenCalled();
  });

  it("review m6: ANOTHER org's Seazn target id answers the plain 404 on create — LIVE on or off (no 422 oracle), nothing created at the provider, no row", async () => {
    const r = await rig();
    const other = await rig();
    const [f1] = r.fixtureIds;
    for (const live of ["true", "false"]) {
      vi.stubEnv("SEAZN_HOSTED_LIVE", live);
      const err = await refusalOf(goLive(r, f1, { mode: "passthrough", targetId: other.seazn }));
      expect(err, `LIVE ${live}`).toBeInstanceOf(HttpError);
      expect((err as HttpError).status, `LIVE ${live}`).toBe(404);
    }
    // As for any target that is not the org's: admission's storage READ runs before `admit` answers 404 — nothing is created.
    expect(r.calls.length, "PREMISE: the two starts reached admission").toBeGreaterThan(0);
    expect(r.calls.filter((c) => c !== "ingest.storageUsage"), "no input, output or Machine").toEqual([]);
    expect(await sessionsOn(f1), "no session row").toBe(0);
  });

  it("Phase 0 ceiling never reaches Seazn: a fixture with 10 broadcasts this hour is refused youtube_limit_reached on its YouTube target (the control), and admitted on Seazn — an 11th and, after a Stop, a 12th — with no new youtube_broadcasts row", async () => {
    const r = await rig();
    const [f1] = r.fixtureIds;
    const yt = await connect({ auth: r.auth, orgId: r.auth.orgId, userId: r.auth.userId });
    const fake = new FakeYouTube();
    const deps = { ...r.deps, youtube: fake };
    // Ten broadcasts this hour through the REAL prepare (the ceiling's own producer), each stopped as the ceiling test does.
    for (let i = 0; i < 10; i++) {
      expect(await prepareYoutubeBroadcast({ orgId: r.auth.orgId, fixtureId: f1, targetId: yt.targetId, now: r.deps.now(), startCause: "organiser" }, fake)).not.toBeNull();
      const ended = await sql<{ yt: string | null }[]>`
        update youtube_broadcasts set state = 'failed' where org_id = ${r.auth.orgId} and fixture_id = ${f1} and state in ('created', 'bound', 'reserved', 'live')
        returning yt_broadcast_id as yt`;
      // YouTube's side of the Stop (fixture-ceiling.test.ts's `stop`): the broadcast leaves the key.
      const at = await fake.accessToken(yt.token);
      for (const e of ended) if (e.yt) await fake.deleteBroadcast(at, e.yt);
      r.tick(SEC);
    }
    const rows = await broadcastsOf(r.auth.orgId);
    expect(rows, "PREMISE: ten broadcast rows").toBe(10);
    const control = await refusalOf(goLive(r, f1, { mode: "passthrough", targetId: yt.targetId }, deps));
    expect((control as HttpError).code, "the control: the YouTube target is at the ceiling").toBe("youtube_limit_reached");
    const insertsBefore = fake.calls.filter((c) => c.method === "insertBroadcast").length;
    const eleventh = (await goLive(r, f1, { mode: "passthrough", targetId: r.seazn }, deps)).sessionId;
    await stopAndSettle(r, f1, eleventh);
    const twelfth = (await goLive(r, f1, { mode: "passthrough", targetId: r.seazn }, deps)).sessionId;
    expect((await sessionRow(twelfth)).destination_kind).toBe("seazn");
    expect(await broadcastsOf(r.auth.orgId), "no new youtube_broadcasts row").toBe(rows);
    expect(fake.calls.filter((c) => c.method === "insertBroadcast").length, "no YouTube call").toBe(insertsBefore);
  });

  it("ten Stop/Go live cycles of one fixture on Seazn inside the hour, then an 11th: admitted and LIVE; and the org's connected YouTube target, whose per-fixture ceiling would bite had Seazn counted, still starts on that fixture", async () => {
    const r = await rig();
    const [f1] = r.fixtureIds;
    // Review m5: a real YouTube connection on the org, so the Phase 0 ceiling is armed for this fixture.
    const yt = await connect({ auth: r.auth, orgId: r.auth.orgId, userId: r.auth.userId });
    const fake = new FakeYouTube();
    const deps = { ...r.deps, youtube: fake };
    let cycles = 0;
    for (let i = 0; i < 10; i++) {
      const { sessionId } = await goLive(r, f1, { mode: "composed", targetId: r.seazn }, deps);
      await stopAndSettle(r, f1, sessionId);
      r.tick(60 * SEC);
      cycles++;
    }
    expect(cycles).toBe(10);
    const eleventh = (await goLive(r, f1, { mode: "composed", targetId: r.seazn }, deps)).sessionId;
    await machinePlays(r, eleventh);
    expect(await sessionRow(eleventh)).toMatchObject({ state: "live", destination_kind: "seazn", youtube_broadcast_id: null });
    expect(await sessionsOn(f1)).toBe(11);
    expect(await broadcastsOf(r.auth.orgId), "no Seazn start made a youtube_broadcasts row").toBe(0);
    expect(fake.calls, "YouTube was never asked during the Seazn cycles").toEqual([]);
    // The ceiling's teeth: eleven sessions on this fixture inside the hour, and its YouTube target still starts (not youtube_limit_reached).
    await stopAndSettle(r, f1, eleventh);
    const ytStart = (await goLive(r, f1, { mode: "passthrough", targetId: yt.targetId }, deps)).sessionId;
    expect(await sessionRow(ytStart)).toMatchObject({ api_backed: true, destination_kind: "youtube" });
    expect(fake.calls.filter((c) => c.method === "insertBroadcast"), "one broadcast prepared at YouTube").toHaveLength(1);
  });
});

// ── Task 12: no output, a signed programme input ─────────────────────────────────────────────────────────────────────────────
/** A provider-call recorder that writes through the REAL telemetry insert and keeps each insert's promise, so a test awaits every
 *  stream_provider_calls row instead of guessing at a timer (the fake records on a microtask). */
function dbRecording() {
  const pending: Promise<void>[] = [];
  const recorder: ProviderCallRecorder = { record: (c) => { const p = recordProviderCall(sql, c); pending.push(p); return p; } };
  return { recorder, settle: async () => { await new Promise((res) => setImmediate(res)); await Promise.all(pending); } };
}
const inputsOf = (sid: string) => sql<{ role: string; ingest_input_id: string; access: unknown }[]>`
  select role, ingest_input_id, access from fixture_stream_inputs where session_id = ${sid} order by role`;
const providerOps = async (sid: string) =>
  sql<{ operation: string; subject_id: string | null }[]>`select operation, subject_id from stream_provider_calls where session_id = ${sid}`;
const failReasonOf = async (sid: string) =>
  (await sql<{ fail_reason: string | null }[]>`select fail_reason from fixture_stream_sessions where id = ${sid}`)[0]!.fail_reason;
/** G5: the signed settings for the hosts this file's beforeEach configures (SEAZN_VIDEO_ORIGINS=seazn.club). */
const SIGNED_FOR_SEAZN_CLUB = { signed: true, allowedOrigins: ["seazn.club"] };

describe.skipIf(!HAS_DB)("Seazn destination — no output, a signed programme input (Task 12)", () => {
  it("a Seazn session reaches live with output_uid null and NO addOutput provider call; its programme input was CREATED signed — fixture_stream_inputs.access set on the programme row, null on the camera — and the provider holds the same", async () => {
    const rec = dbRecording();
    const r = await rig({ recorder: rec.recorder });
    const [f1] = r.fixtureIds;
    const { sessionId } = await goLive(r, f1, { mode: "composed", targetId: r.seazn });
    await machinePlays(r, sessionId);
    expect(await sessionRow(sessionId)).toMatchObject({ state: "live", destination_kind: "seazn", output_uid: null });
    await rec.settle();
    const ops = (await providerOps(sessionId)).map((o) => o.operation);
    expect(ops.filter((o) => o === "createLiveInput"), "PREMISE: the session's provider calls were recorded (camera + programme)").toHaveLength(2);
    expect(ops.filter((o) => o === "addOutput"), "G1: no output, ever").toEqual([]);
    const [camera, programme] = await inputsOf(sessionId);
    expect([camera!.role, camera!.access], "the camera stays unsigned: the phone plays it").toEqual(["camera", null]);
    expect([programme!.role, programme!.access]).toEqual(["programme", SIGNED_FOR_SEAZN_CLUB]);
    // The seam through its real producer: what the row says is what the create SENT the provider.
    expect(r.ingest.inputAccess(programme!.ingest_input_id)).toEqual(SIGNED_FOR_SEAZN_CLUB);
    expect(r.ingest.inputAccess(camera!.ingest_input_id)).toBeNull();
    expect([r.ingest.outputsFor(camera!.ingest_input_id), r.ingest.outputsFor(programme!.ingest_input_id)]).toEqual([[], []]);
  });

  it("ten ticks of a live Seazn session never fail it target_rejected — even with every output read answering `rejected` — while a pasted passthrough session under the same reads fails target_rejected on its first tick (the control)", async () => {
    const r = await rig();
    const [f1, f2] = r.fixtureIds;
    const seazn = (await goLive(r, f1, { mode: "composed", targetId: r.seazn })).sessionId;
    await machinePlays(r, seazn);
    const spy = vi.spyOn(r.ingest, "outputState").mockResolvedValue("rejected");
    try {
      let ticks = 0;
      for (let i = 0; i < 10; i++) {
        r.tick(SEC);   // ten seconds in all: inside the composed beat window, so only the output could end it
        await tickSession(seazn, r.deps, "sweep");
        expect((await sessionRow(seazn)).state, `after tick ${i + 1}`).toBe("live");
        ticks++;
      }
      expect(ticks, "anti-vacuity: ten ticks ran").toBe(10);
      expect(await failReasonOf(seazn)).toBeNull();
      // The control: the same reads DO end a session that has a destination output.
      const pasted = (await goLive(r, f2, { mode: "passthrough", targetId: r.pasted })).sessionId;
      await tickSession(pasted, r.deps, "sweep");
      expect(await failReasonOf(pasted), "the rejected read has teeth").toBe("target_rejected");
    } finally {
      spy.mockRestore();
    }
  });

  it("regression (G1): an EXTERNAL composed session still adds exactly one output — on its programme input, none on the camera — and neither of its inputs is signed", async () => {
    const rec = dbRecording();
    const r = await rig({ recorder: rec.recorder });
    const [f1] = r.fixtureIds;
    const { sessionId } = await goLive(r, f1, { mode: "composed", targetId: r.pasted });
    await machinePlays(r, sessionId);
    const row = await sessionRow(sessionId);
    expect(row).toMatchObject({ state: "live", destination_kind: "youtube" });
    expect(row.output_uid, "the output this session added").not.toBeNull();
    const [camera, programme] = await inputsOf(sessionId);
    expect([r.ingest.outputsFor(camera!.ingest_input_id).length, r.ingest.outputsFor(programme!.ingest_input_id).length]).toEqual([0, 1]);
    await rec.settle();
    const adds = (await providerOps(sessionId)).filter((o) => o.operation === "addOutput");
    expect(adds.map((a) => a.subject_id), "one addOutput, about the programme input (R2004)").toEqual([programme!.ingest_input_id]);
    expect([camera!.access, programme!.access]).toEqual([null, null]);
    expect(r.ingest.inputAccess(programme!.ingest_input_id)).toBeNull();
  });

  it("review I1: on the FAKE relay (which signs the programme input too) a Seazn start with no origins is 503 seazn_video_unconfigured BY NAME at admission — zero provider calls, no row; with the origins set the same start goes through signed", async () => {
    const r = await rig();
    const [f1] = r.fixtureIds;
    vi.stubEnv("RELAY_DRIVERS", "fake");
    vi.stubEnv("SEAZN_VIDEO_ORIGINS", "");
    const err = await refusalOf(goLive(r, f1, { mode: "composed", targetId: r.seazn }));
    expect(err).toBeInstanceOf(HttpError);
    expect({ status: (err as HttpError).status, code: (err as HttpError).code }, "named, never the misnamed ingest_unavailable")
      .toEqual({ status: 503, code: SEAZN_VIDEO_UNCONFIGURED });
    expect(r.calls, "refused before any provider call — the storage read included").toEqual([]);
    expect(await sessionsOn(f1), "no session row").toBe(0);
    vi.stubEnv("SEAZN_VIDEO_ORIGINS", "seazn.club");
    const { sessionId } = await goLive(r, f1, { mode: "composed", targetId: r.seazn });
    expect((await inputsOf(sessionId)).map((i) => i.access)).toEqual([null, SIGNED_FOR_SEAZN_CLUB]);
  });
});

describe("Task 12: seaznAccess() and the write-once access column", () => {
  it("seaznAccess() is the signed settings for the configured Seazn hosts, and throws — naming the variable, never a value — when none are configured", () => {
    vi.stubEnv("SEAZN_VIDEO_ORIGINS", "seazn.club, stg.seazn.club");
    expect(seaznAccess()).toEqual({ signed: true, allowedOrigins: ["seazn.club", "stg.seazn.club"] });
    vi.stubEnv("SEAZN_VIDEO_ORIGINS", "");
    expect(() => seaznAccess()).toThrow(/SEAZN_VIDEO_ORIGINS/);
    // Task 12 review m2: a malformed value throws by name too, and the message never quotes it (provisioning logs what it catches).
    vi.stubEnv("SEAZN_VIDEO_ORIGINS", "https://seazn-malformed-origin.example");
    let message = "";
    try { seaznAccess(); } catch (e) { message = String(e); }
    expect(message, "PREMISE: a malformed value throws").toMatch(/SEAZN_VIDEO_ORIGINS/);
    expect(message).not.toContain("seazn-malformed-origin");
  });

  // The assumption "a Seazn session is composed" is start.ts's coercion, and no database rule backs it — so it is a guard, not a
  // comment: a Seazn PASSTHROUGH session would have no programme input to sign and its camera would be what viewers play.
  it("programmeAccess(): signed only for a Seazn COMPOSED session, nothing for an external one, and a Seazn passthrough session is refused by name", () => {
    vi.stubEnv("SEAZN_VIDEO_ORIGINS", "seazn.club");
    const cases = [
      { mode: "composed", destination: "seazn", want: { signed: true, allowedOrigins: ["seazn.club"] } },
      { mode: "composed", destination: "external", want: undefined },
      { mode: "passthrough", destination: "external", want: undefined },
    ] as const;
    let checked = 0;
    for (const c of cases) {
      expect(programmeAccess({ mode: c.mode, destination: c.destination }), `${c.mode}/${c.destination}`).toEqual(c.want);
      checked++;
    }
    expect(() => programmeAccess({ mode: "passthrough", destination: "seazn" })).toThrow(/Seazn session .* passthrough/);
    checked++;
    expect(checked).toBe(4);
  });

  // `access` is written once, by the statement that stores the input's credentials, and never updated (V541's trigger refuses a
  // change at the database; this pins the code). Production code only: tests may seat rows however they like.
  it("no statement under src/server writes fixture_stream_inputs.access except the one that stores the input's credentials", () => {
    const SERVER = resolve(import.meta.dirname, "../..");
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return e.name === "__tests__" ? [] : walk(p);
      return e.isFile() && e.name.endsWith(".ts") ? [p] : [];
    });
    const files = walk(SERVER);
    let updates = 0;
    const writers: { file: string; statement: string }[] = [];
    for (const f of files) {
      for (const m of readFileSync(f, "utf8").matchAll(/update\s+fixture_stream_inputs\b[^`]*/g)) {
        updates++;
        if (/\baccess\s*=/.test(m[0])) writers.push({ file: relative(SERVER, f), statement: m[0] });
      }
    }
    expect(files.length, "anti-vacuity: the walk read the server tree").toBeGreaterThan(100);
    expect(updates, "anti-vacuity: the scan found fixture_stream_inputs updates to judge").toBeGreaterThan(1);
    expect(writers.map((w) => w.file)).toEqual(["relay/secret-columns.ts"]);
    expect(writers[0]!.statement, "the same statement stores the input's credentials").toMatch(/ingest_input_id\s*=/);
  });
});

// ── the phone's start and the automatic start (their real callers) ────────────────────────────────────────────────────────────
/** One org, one started fixture, its stream code minted through the real `ensureStreamCode` (the capture rig), plus its Seazn row. */
async function phoneRig() {
  const r = await captureRig({ credits: 3 });
  const [seazn] = await sql<{ id: string }[]>`select id from org_stream_targets where org_id = ${r.auth.orgId} and kind = 'seazn'`;
  const t = traced(r.ingest, r.runner);
  r.deps.drivers = t.drivers;
  await sql`update fixtures set status = 'in_play' where id = ${r.fixtureId}`;
  return { ...r, seazn: seazn!.id, calls: t.calls };
}
type PhoneRig = Awaited<ReturnType<typeof phoneRig>>;
async function beat(r: PhoneRig, phone: string, over: Record<string, unknown> = {}) {
  return postBeat(r.code, r.tok, CaptureBeat.parse({
    code: r.code, slot: 0, phone, claim: null, device: null, sid: null, at: r.now().toISOString(), state: "paired",
    cause: null, notReady: null, startFailed: null, stopped: null, mode: "automatic", transport: null, bitrateKbps: null,
    delivery: "unknown", deliveredLagS: null, audioOk: null, battery: null, thermal: null, dataUsedMB: null,
    appVersion: "seazn-admission/1", ...over,
  }), r.deps, r.now());
}

describe.skipIf(!HAS_DB)("Seazn destination — the phone's and the automatic start", () => {
  it("no compositor runner: a PHONE start on a Seazn pre-pick (stored mode passthrough) is refused composed_unavailable before any provider call, answered 503 unavailable — never a thrown caller bug", async () => {
    const r = await phoneRig();
    const phone = phoneId("p");
    await beat(r, phone, { claim: "new", mode: "operator" });
    await saveStreamSettings(r.auth, r.fixtureId, { targetId: r.seazn, streamMode: "passthrough" });
    delete process.env.RELAY_IMAGE;
    try {
      const err = await refusalOf(postStart(r.code, r.tok, { phone }, r.deps, r.now()));
      expect(err).toBeInstanceOf(CaptureRefusalError);
      expect({ status: (err as CaptureRefusalError).status, code: (err as CaptureRefusalError).code }).toEqual({ status: 503, code: "unavailable" });
      expect(r.calls, "no provider call").toEqual([]);
      expect(await sql`select 1 from fixture_stream_sessions where fixture_id = ${r.fixtureId}`).toHaveLength(0);
    } finally {
      process.env.RELAY_IMAGE = "registry.fly.io/seazn-relay:seazn-admission-test";
    }
  });

  it("Phase 0 backoff never reaches Seazn: with the org's channel backed off, the AUTOMATIC start on its YouTube target is refused from the window (the control), and on Seazn it is admitted and goes live — zero YouTube calls, the backoff unchanged", async () => {
    const r = await phoneRig();
    const yt = await connect({ auth: r.auth, orgId: r.auth.orgId, userId: r.auth.userId! });
    const fake = new FakeYouTube();
    r.deps.youtube = fake;
    const retryAfter = new Date(r.now().getTime() + 3600 * SEC);
    await sql`update org_youtube_connections set auto_backoff_count = 3, auto_retry_after = ${retryAfter}, auto_backoff_code = 'youtube_limit_reached' where id = ${yt.connectionId}`;
    const backoff = async () => (await sql<{ auto_backoff_count: number; auto_retry_after: Date | null }[]>`
      select auto_backoff_count, auto_retry_after from org_youtube_connections where id = ${yt.connectionId}`)[0]!;
    const sessions = () => sql<{ id: string }[]>`select id from fixture_stream_sessions where fixture_id = ${r.fixtureId}`;
    const phone = phoneId("a");
    await beat(r, phone, { claim: "new", mode: "operator" });

    // The control: the same automatic start on the YouTube target is refused by the window, asking YouTube nothing.
    await saveStreamSettings(r.auth, r.fixtureId, { autoStream: true, targetId: yt.targetId });
    vi.mocked(autoBackoffRefusalCode).mockClear();
    await beat(r, phone);
    // Review m6: the refusal is the BACKOFF window's own — it answered the code the channel was backed off with.
    expect(vi.mocked(autoBackoffRefusalCode).mock.results.map((x) => x.value), "the window refused with its stored code").toContain("youtube_limit_reached");
    const [refused] = await sql<{ auto_start_refusal: string | null }[]>`select auto_start_refusal from fixture_stream_settings where fixture_id = ${r.fixtureId}`;
    expect(refused!.auto_start_refusal, "the automatic start ran and was refused").toBe("unavailable");
    expect(await sessions()).toHaveLength(0);

    // Seazn: the next automatic attempt is admitted and goes live.
    await saveStreamSettings(r.auth, r.fixtureId, { targetId: r.seazn });
    r.tick(AUTO_START_RETRY_SECONDS * SEC);
    await beat(r, phone);
    const made = await sessions();
    expect(made, "the automatic start on Seazn made a session").toHaveLength(1);
    expect(await sessionRow(made[0]!.id)).toMatchObject({ destination_kind: "seazn", mode: "composed" });
    await machinePlays(r, made[0]!.id);
    expect((await sessionRow(made[0]!.id)).state).toBe("live");
    expect(fake.calls, "YouTube was never asked").toEqual([]);
    expect(await backoff(), "the channel's backoff is untouched").toEqual({ auto_backoff_count: 3, auto_retry_after: retryAfter });
  });
});
