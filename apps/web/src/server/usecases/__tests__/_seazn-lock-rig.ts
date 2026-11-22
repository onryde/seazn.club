// The lock pass's test rig (Seazn Task 13), shared by the pass's own suite (seazn-recordings.test.ts) and the suite that drives
// it through the REAL Cloudflare adapter (relay/__tests__/seazn-recordings-cf.test.ts — outside server/usecases, whose files may
// not import an adapter: port-boundary.test.ts). Moved verbatim from seazn-recordings.test.ts (Task 24 re-review, 2026-11-22).
// Every session comes from a REAL producer: the organiser's Go live (`createSession`), the Machine's playing beat, and Stop.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from "vitest";

import { sql } from "@/lib/db";
import { setRelayDriversForTest } from "@/server/relay/drivers";
import { FakeIngest, FakeRecorder, FakeRunner } from "@/server/relay/fakes";
import { pairPresentPhone, rigUser } from "@/server/relay/__tests__/_session-rig";
import { grantCredits } from "../stream-credits";
import { type SessionDeps, createSession, currentSession, heartbeat, stopSession } from "../stream-sessions";
import { createStreamTarget } from "../stream-targets";
import { lockSeaznRecordings } from "../seazn-recordings";
import { override } from "./_capture-rig";
import { seedOrg, startedDivisionWithFixture } from "./_rig";

export const HAS_DB = !!process.env.DATABASE_URL;
export const SEC = 1000;
const ROOMY_STORAGE_MINUTES = 100_000_000;
/** The tick's slice for this pass (plan: SEAZN_PASS_BUDGET_MS = 8 000), typed here. */
export const BUDGET = 8_000;

/** The env every lock-pass suite runs under: relay keys for the session rig, Seazn live on, the drivers reset after each test.
 *  Call once at the top of a test file. */
export function installSeaznLockEnv(): void {
  const ENV_KEYS = ["RELAY_KEK", "YOUTUBE_TOKEN_KEK", "RELAY_IMAGE", "AUTH_SECRET"] as const;
  const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  beforeAll(() => {
    process.env.RELAY_KEK = randomBytes(32).toString("hex");
    process.env.YOUTUBE_TOKEN_KEK = randomBytes(32).toString("hex");
    process.env.RELAY_IMAGE = "registry.fly.io/seazn-relay:seazn-lock-test";
    process.env.AUTH_SECRET ??= "seazn-lock-test-secret";
  });
  afterAll(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });
  beforeEach(() => {
    vi.stubEnv("SEAZN_HOSTED_LIVE", "true");
    vi.stubEnv("SEAZN_VIDEO_ORIGINS", "seazn.club");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    setRelayDriversForTest(null);
  });
}

export type Clock = { now: number };
/** An org with two started fixtures, the relay entitlements, credits, a phone on each fixture, a pasted YouTube key and its
 *  Seazn row (V541's trigger). `shared` puts a second org on the FIRST org's fake and clock, so one listing can answer both. */
export async function rig(shared?: { ingest: FakeIngest; clock: Clock; runner: FakeRunner }) {
  const seeded = await seedOrg();
  const auth = { ...seeded.auth, userId: await rigUser() };
  const { fixtureIds } = await startedDivisionWithFixture(auth, { fixtures: 2 });
  await override(auth.orgId, "streaming.overlay", true);
  await override(auth.orgId, "streaming.relay", true);
  for (const f of fixtureIds) await pairPresentPhone(f);
  await grantCredits({ orgId: auth.orgId, delta: 5, createdBy: await rigUser(), note: "seazn lock", idempotencyKey: randomUUID() });
  const pasted = await createStreamTarget(auth, auth.orgId, { kind: "youtube", label: "Club", streamKey: `yt-${randomUUID()}` });
  const [seazn] = await sql<{ id: string }[]>`select id from org_stream_targets where org_id = ${auth.orgId} and kind = 'seazn'`;
  expect(seazn, "PREMISE: V541 gave the org its Seazn destination").toBeDefined();
  const clock: Clock = shared?.clock ?? { now: Date.now() };
  const recorder = new FakeRecorder();
  const ingest = shared?.ingest ?? new FakeIngest({ clock: () => clock.now, connectAfterMs: 3000, recorder });
  ingest.storage = { totalStorageMinutes: 0, totalStorageMinutesLimit: ROOMY_STORAGE_MINUTES, videoCount: 0 };
  const runner = shared?.runner ?? new FakeRunner();
  const deps: SessionDeps = { drivers: { ingest, runner }, now: () => new Date(clock.now), appUrl: "http://app.test" };
  return { auth, fixtureIds: fixtureIds as [string, string], pasted: pasted.id, seazn: seazn!.id, ingest, runner, clock, deps, recorder };
}
export type Rig = Awaited<ReturnType<typeof rig>>;

/** Go live on `targetId` (composed), and the Machine's playing beat that takes it live. */
export async function live(r: Rig, fixtureId: string, targetId: string): Promise<string> {
  await pairPresentPhone(fixtureId, { at: r.deps.now() });
  const { sessionId } = await createSession(r.auth, fixtureId, { mode: "composed", targetId }, r.deps);
  const spec = r.runner.created.find((c) => c.sessionId === sessionId);
  expect(spec, `PREMISE: a Machine was created for ${sessionId}`).toBeDefined();
  await heartbeat(sessionId, spec!.jobToken, { state: "playing" }, r.deps);
  expect(await stateOf(sessionId), "PREMISE: the session is live").toBe("live");
  return sessionId;
}
/** Stop, then read until the composed session has completed; answers its `ended_at`. */
export async function stopAndSettle(r: Rig, fixtureId: string, sid: string): Promise<number> {
  await stopSession(r.auth, fixtureId, sid, r.deps);
  for (let i = 0; i < 3 && (await stateOf(sid)) !== "completed"; i++) await currentSession(r.auth, fixtureId, r.deps);
  expect(await stateOf(sid), "PREMISE: the stopped session completed").toBe("completed");
  const [{ ended_at }] = await sql<{ ended_at: Date }[]>`select ended_at from fixture_stream_sessions where id = ${sid}`;
  return ended_at.getTime();
}
export const stateOf = async (sid: string) => (await sql<{ state: string }[]>`select state from fixture_stream_sessions where id = ${sid}`)[0]!.state;
/** A session's input of `role`: its row id, its Cloudflare uid and its finished mark. */
export async function inputOf(sid: string, role: "programme" | "camera") {
  const [row] = await sql<{ id: string; uid: string; locked_at: Date | null }[]>`
    select id, ingest_input_id as uid, recordings_locked_at as locked_at from fixture_stream_inputs where session_id = ${sid} and role = ${role}`;
  expect(row?.uid, `PREMISE: the ${role} input of ${sid} has a uid`).toBeTruthy();
  return row!;
}
export const lockRows = async (inputRowId: string) =>
  (await sql<{ cf_video_id: string }[]>`select cf_video_id from seazn_locked_videos where input_row_id = ${inputRowId} order by cf_video_id`).map((r) => r.cf_video_id);
export const vid = (tag: string) => `v-${tag}-${randomUUID()}`;
/** One pass, as the tick runs it, scoped to these orgs. */
export const pass = (r: Rig, orgIds: string[], o: { now?: number; budgetMs?: number; wallClock?: () => number; deps?: SessionDeps } = {}) =>
  lockSeaznRecordings(o.deps ?? r.deps, { now: new Date(o.now ?? r.clock.now), budgetMs: o.budgetMs ?? BUDGET, orgIds, ...(o.wallClock ? { wallClock: o.wallClock } : {}) });
export const ZERO = { locked: 0, relocked: 0, refused: 0, failed: 0, deferred: 0 };
