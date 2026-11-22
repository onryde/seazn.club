// Seazn-hosted video, Phase 1 Task 15: the shared rig for tests that need a fixture with REAL Seazn / YouTube sessions behind it
// (seazn-video-plan.test.ts, and the match page's own seam test): the organiser's Go live (`createSession`), the Machine's playing
// beat, Stop, all through the fakes the relay tests use. Each call to `seaznRig()` makes a fresh org, so no two cases share state.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import { sql } from "@/lib/db";
import { setRelayDriversForTest } from "@/server/relay/drivers";
import { FakeIngest, FakeRecorder, FakeRunner } from "@/server/relay/fakes";
import { pairPresentPhone, rigUser } from "@/server/relay/__tests__/_session-rig";
import { grantCredits } from "@/server/usecases/stream-credits";
import { type SessionDeps, createSession, currentSession, heartbeat, stopSession } from "@/server/usecases/stream-sessions";
import { createStreamTarget } from "@/server/usecases/stream-targets";
import { override } from "@/server/usecases/__tests__/_capture-rig";
import { seedOrg, startedDivisionWithFixture } from "@/server/usecases/__tests__/_rig";

const ROOMY_STORAGE_MINUTES = 100_000_000;
const ENV_KEYS = ["RELAY_KEK", "YOUTUBE_TOKEN_KEK", "RELAY_IMAGE", "AUTH_SECRET"] as const;

/** The env every Seazn session test needs, registered as hooks of the file that calls it: the keys the relay seals with, LIVE on, the
 *  Seazn playback origins (Task 12: the fake driver refuses without them), and the fake relay with its own playback host. */
export function installSeaznEnv(tag: string): void {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  beforeAll(() => {
    process.env.RELAY_KEK = randomBytes(32).toString("hex");
    process.env.YOUTUBE_TOKEN_KEK = randomBytes(32).toString("hex");
    process.env.RELAY_IMAGE = `registry.fly.io/seazn-relay:${tag}`;
    process.env.AUTH_SECRET ??= `${tag}-secret`;
  });
  afterAll(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  beforeEach(() => {
    vi.stubEnv("SEAZN_HOSTED_LIVE", "true");
    vi.stubEnv("SEAZN_VIDEO_ORIGINS", "seazn.club");
    vi.stubEnv("RELAY_DRIVERS", "");
    vi.stubEnv("STREAM_PLAYBACK_HOST", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    setRelayDriversForTest(null);
  });
}

const FLAG_KEYS = ["SEAZN_HOSTED_LIVE", "SEAZN_VIDEO_ORIGINS", "RELAY_DRIVERS", "STREAM_PLAYBACK_HOST"] as const;

/** `installSeaznEnv`'s environment for ONE `describe` of a file that has env of its own (Task 17: match-day.test.ts and
 *  match-day-code-view.test.ts stub `OAUTH_BASE_URL` and the device-link KEK at file level, which `installSeaznEnv`'s
 *  `unstubAllEnvs` after every test would drop). Plain `process.env` writes in the describe's `beforeAll`, put back in its `afterAll`;
 *  nothing is stubbed through vitest, so a file-level stub is never touched. Call it INSIDE the describe. */
export function installSeaznEnvForDescribe(tag: string): void {
  const keys = [...ENV_KEYS, ...FLAG_KEYS] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  beforeAll(() => {
    process.env.RELAY_KEK = randomBytes(32).toString("hex");
    process.env.YOUTUBE_TOKEN_KEK = randomBytes(32).toString("hex");
    process.env.RELAY_IMAGE = `registry.fly.io/seazn-relay:${tag}`;
    process.env.AUTH_SECRET ??= `${tag}-secret`;
    process.env.SEAZN_HOSTED_LIVE = "true";
    process.env.SEAZN_VIDEO_ORIGINS = "seazn.club";
    process.env.RELAY_DRIVERS = "";
    process.env.STREAM_PLAYBACK_HOST = "";
  });
  afterAll(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    setRelayDriversForTest(null);
  });
}

/** An org with two started fixtures (status `scheduled`, no session), the relay entitlements, credits, a phone on each fixture, a pasted
 *  YouTube key and its Seazn row (V541's trigger). */
export async function seaznRig() {
  const seeded = await seedOrg();
  const auth = { ...seeded.auth, userId: await rigUser() };
  const { fixtureIds } = await startedDivisionWithFixture(auth, { fixtures: 2 });
  return seaznRigFor(auth, fixtureIds as [string, string]);
}

/** The same rig for an org and fixtures the CALLER made (Match Day's board seeds its own competition, courts and in-play matches;
 *  Task 17): the relay entitlements, credits, a paired phone on each fixture, a pasted YouTube key and the org's Seazn row. */
export async function seaznRigFor<F extends readonly string[]>(auth: Awaited<ReturnType<typeof seedOrg>>["auth"], fixtureIds: F) {
  await override(auth.orgId, "streaming.overlay", true);
  await override(auth.orgId, "streaming.relay", true);
  for (const f of fixtureIds) await pairPresentPhone(f);
  await grantCredits({ orgId: auth.orgId, delta: 8, createdBy: await rigUser(), note: "seazn rig", idempotencyKey: randomUUID() });
  const pasted = await createStreamTarget(auth, auth.orgId, { kind: "youtube", label: "Club", streamKey: `yt-${randomUUID()}` });
  const [seazn] = await sql<{ id: string }[]>`select id from org_stream_targets where org_id = ${auth.orgId} and kind = 'seazn'`;
  expect(seazn, "PREMISE: V541 gave the org its Seazn destination").toBeDefined();
  const clock = { now: Date.now() };
  const ingest = new FakeIngest({ clock: () => clock.now, connectAfterMs: 3000, recorder: new FakeRecorder() });
  ingest.storage = { totalStorageMinutes: 0, totalStorageMinutesLimit: ROOMY_STORAGE_MINUTES, videoCount: 0 };
  const runner = new FakeRunner();
  const deps: SessionDeps = { drivers: { ingest, runner }, now: () => new Date(clock.now), appUrl: "http://app.test" };
  return { auth, fixtureIds, pasted: pasted.id, seazn: seazn!.id, runner, deps };
}
/** What `goLive` / `live` / `stopAndSettle` need of a rig: the org, the Machine fake and the deps (any fixture list). */
export type SeaznRig = Awaited<ReturnType<typeof seaznRigFor<readonly string[]>>>;

export const stateOf = async (sid: string) => (await sql<{ state: string }[]>`select state from fixture_stream_sessions where id = ${sid}`)[0]!.state;
export const kindOf = async (sid: string) =>
  (await sql<{ destination_kind: string | null }[]>`select destination_kind from fixture_stream_sessions where id = ${sid}`)[0]!.destination_kind;

/** Go live on `targetId` (composed) up to the Machine being created: the session waits for its playing beat. */
export async function goLive(r: SeaznRig, fixtureId: string, targetId: string): Promise<string> {
  await pairPresentPhone(fixtureId, { at: r.deps.now() });
  const { sessionId } = await createSession(r.auth, fixtureId, { mode: "composed", targetId }, r.deps);
  return sessionId;
}
/** Go live, then the Machine's playing beat: the session is live. */
export async function live(r: SeaznRig, fixtureId: string, targetId: string): Promise<string> {
  const sid = await goLive(r, fixtureId, targetId);
  const spec = r.runner.created.find((c) => c.sessionId === sid);
  expect(spec, `PREMISE: a Machine was created for ${sid}`).toBeDefined();
  await heartbeat(sid, spec!.jobToken, { state: "playing" }, r.deps);
  expect(await stateOf(sid), "PREMISE: the session is live").toBe("live");
  return sid;
}
/** Stop, then read until the composed session has completed. */
export async function stopAndSettle(r: SeaznRig, fixtureId: string, sid: string): Promise<void> {
  await stopSession(r.auth, fixtureId, sid, r.deps);
  for (let i = 0; i < 3 && (await stateOf(sid)) !== "completed"; i++) await currentSession(r.auth, fixtureId, r.deps);
  expect(await stateOf(sid), "PREMISE: the stopped session completed").toBe("completed");
}
