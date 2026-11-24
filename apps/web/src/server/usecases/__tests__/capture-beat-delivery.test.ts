// Task 46 (owner 2026-11-24, apply-rec) — the beat answer's `delivery`, through the REAL beat (`postBeat` → `runBeat`) on a
// real database: sessions started by the REAL organiser path (`createSession`) and the REAL court start, the relay's facts
// stored by the REAL Machine beat (`heartbeat`), Cloudflare's by the REAL webhook recorder (`recordLiveNotification`). Fake
// relay and YouTube ports on the rig's tickable clock.
//
// The rules under test, typed from the brief (task-46-brief.md) and the contract (capture-beat.v1.json), never from the code:
//   - present only on the answers that tell the slot's CURRENT phone to publish (go-live, live), for ANY session that has a
//     stored fact (review ruling 2026-11-24, widened from Seazn-hosted only): a composed session's relay and both its inputs, a
//     passthrough's camera input only; absent on waiting, over, replaced and taken, and when nothing is stored yet;
//   - relay members from the Machine's stored beat while it is at most 3 relay beats old (config's cadence × 3), CF members
//     from the latest recorded live-input notification of that input; unknown → omitted, never null; none → no object;
//   - at most one extra read per beat, on the pool after the beat's transaction; a failed read → no `delivery`, the beat is
//     stored and answered (200), the failure reported without secrets;
//   - pollSeconds and the stored answered cadence are what they would be without it.
//
// ONE SPORT, on purpose (TEST-STRATEGY rule 6): delivery reads no sport rule; every rig rides `generic` (the court rig, the
// Match Day seed's own sport).
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/sentry", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/sentry")>()), captureError: vi.fn() }));
// The read's own witness: a PASS-THROUGH spy (how many reads a beat made), which a test may make throw once.
vi.mock("../capture-delivery", async (importOriginal) => {
  const real = await importOriginal<typeof import("../capture-delivery")>();
  return { ...real, readDeliveryFacts: vi.fn(real.readDeliveryFacts) };
});

import { sql } from "@/lib/db";
import { captureError } from "@/lib/sentry";
import { CaptureBeat, CaptureBeatAnswer, CaptureDelivery } from "@/server/api-v1/capture-schemas";
import type { RelayHeartbeat } from "@/server/api-v1/schemas";
import { DELIVERY_RELAY_FRESH_MS, RELAY_HEARTBEAT_INTERVAL_MS } from "@/server/relay/config";
import { FakeIngest, FakeRunner } from "@/server/relay/fakes";
import { log } from "@/server/logger";
import { pairPresentPhone, rigUser } from "@/server/relay/__tests__/_session-rig";
import { connect } from "@/server/youtube/__tests__/_connect-rig";
import { FakeYouTube } from "@/server/youtube/fake";
import { readDeliveryFacts } from "../capture-delivery";
import { postBeat, postStart } from "../capture-phone";
import { linkCourtStream, setCourtStream } from "../court-streams";
import { grantCredits } from "../stream-credits";
import { createSession, heartbeat, recordLiveNotification, stopSession, tickSession, type SessionDeps } from "../stream-sessions";
import { captureRig, override, phoneId, type CaptureRig } from "./_capture-rig";
import { at, place, seedDay, setStatus } from "./_match-day-seed";

const HAS_DB = !!process.env.DATABASE_URL;
const SEC = 1000;

const ENV_KEYS = ["RELAY_KEK", "YOUTUBE_TOKEN_KEK", "RELAY_IMAGE", "AUTH_SECRET", "COURT_MIN_APP_VERSION", "STREAM_PLAYBACK_HOST", "OAUTH_BASE_URL", "NEXT_PUBLIC_BASE_URL", "RELAY_DRIVERS"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
beforeAll(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.RELAY_KEK = randomBytes(32).toString("hex");
  process.env.YOUTUBE_TOKEN_KEK = randomBytes(32).toString("hex");
  process.env.RELAY_IMAGE = "registry.fly.io/seazn-relay:delivery-test";
  process.env.AUTH_SECRET = "capture-delivery-test-secret";
  process.env.COURT_MIN_APP_VERSION = "1.0.14-1200";
});
beforeEach(() => {
  vi.stubEnv("SEAZN_HOSTED_LIVE", "true");
  vi.stubEnv("SEAZN_VIDEO_ORIGINS", "seazn.club");
  vi.mocked(readDeliveryFacts).mockClear();
  vi.mocked(captureError).mockClear();
});
afterEach(() => { vi.unstubAllEnvs(); });
afterAll(async () => {
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

type Beat = CaptureBeat;
type Answer = CaptureBeatAnswer;
const PUBLISHING: ReadonlySet<Answer["state"]> = new Set(["go-live", "live"]);

let answersChecked = 0;
/** Every answer: parses with the real union; `delivery`, when present, is a valid non-empty object on a publishing answer. */
function checked(a: Answer): Answer {
  expect(CaptureBeatAnswer.parse(a)).toEqual(a);
  if ("delivery" in a) {
    expect(PUBLISHING.has(a.state), `delivery rode on ${a.state}`).toBe(true);
    expect(a.delivery, "omitted, never null").not.toBeNull();
    expect(CaptureDelivery.parse(a.delivery)).toEqual(a.delivery);
    expect(Object.keys(a.delivery!).length, "omitted, never {}").toBeGreaterThan(0);
  }
  answersChecked++;
  return a;
}

function body(r: CaptureRig, phone: string, over: Partial<Beat> = {}): Beat {
  return CaptureBeat.parse({
    code: r.code, slot: 0, phone, claim: null, device: null, sid: null, at: r.now().toISOString(), state: "paired",
    cause: null, notReady: null, startFailed: null, stopped: null, mode: "operator", transport: null, bitrateKbps: null,
    delivery: "unknown", deliveredLagS: null, audioOk: null, battery: null, thermal: null, dataUsedMB: null,
    appVersion: "capture-test/1", ...over,
  });
}
const beat = async (r: CaptureRig, phone: string, over: Partial<Beat> = {}) => checked(await postBeat(r.code, r.tok, body(r, phone, over), r.deps, r.now()));
/** The answer's delivery, on any branch (replaced and taken have no such key in the contract). */
const dlv = (a: Answer): CaptureDelivery | undefined => ("delivery" in a ? a.delivery : undefined);

/** The org's Seazn destination (V541's trigger made it; read, never inserted). */
async function seaznOf(orgId: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`select id from org_stream_targets where org_id = ${orgId} and kind = 'seazn'`;
  expect(row, "PREMISE: V541 gave the org its Seazn destination").toBeDefined();
  return row!.id;
}
/** The organiser's Go live on `targetId`, with `phone` paired first: it is the session's phone. */
async function goLive(r: CaptureRig, phone: string, body: { mode: "passthrough" | "composed"; targetId: string }): Promise<string> {
  await pairPresentPhone(r.fixtureId, { phone, at: r.now() });
  return (await createSession(r.auth, r.fixtureId, body, r.deps)).sessionId;
}
/** The session's Machine beats (its job token is the one the fake runner was given). */
async function machineBeats(r: CaptureRig, sid: string, b: RelayHeartbeat): Promise<void> {
  const spec = r.runner.created.findLast((c) => c.sessionId === sid);
  expect(spec, `PREMISE: a Machine was created for ${sid}`).toBeDefined();
  await heartbeat(sid, spec!.jobToken, b, r.deps);
}
const inputUid = async (sid: string, role: "camera" | "programme"): Promise<string> => {
  const [row] = await sql<{ uid: string | null }[]>`select ingest_input_id as uid from fixture_stream_inputs where session_id = ${sid} and role = ${role}`;
  expect(row?.uid, `PREMISE: the session has a ${role} input`).toBeTruthy();
  return row!.uid!;
};
const WORD = { "live_input.connected": "connected", "live_input.disconnected": "disconnected", "live_input.errored": "unknown" } as const;
/** Cloudflare's notification for the session's `role` input, through the webhook's recorder. */
async function cfSays(r: CaptureRig, sid: string, role: "camera" | "programme", event: keyof typeof WORD, when: Date | null = null) {
  const out = await recordLiveNotification({ inputUid: await inputUid(sid, role), event, word: WORD[event], reason: null, at: when }, r.now());
  expect(out.outcome, "PREMISE: the notification was recorded").toBe("recorded");
}
const sessionRow = async (sid: string) => (await sql<{ state: string; mode: string; destination_kind: string | null; last_heartbeat: unknown; heartbeat_at: Date | null }[]>`
  select state, mode, destination_kind, last_heartbeat, heartbeat_at from fixture_stream_sessions where id = ${sid}`)[0]!;
const pairingOf = async (r: CaptureRig, phone: string) => (await sql<{ last_beat_at: Date; answered_poll_seconds: number }[]>`
  select p.last_beat_at, p.answered_poll_seconds from fixture_stream_pairings p join fixture_stream_codes c on c.id = p.code_id
   where c.fixture_id = ${r.fixtureId} and p.phone = ${phone} and p.ended_at is null`)[0]!;

const PLAYING: RelayHeartbeat = { state: "playing", output: "connected", programmePhase: "live", fps: 29.97, bitrateKbps: 4500.4, input: "connected" };
/** PLAYING as the wire tells it: the stored words verbatim, fps and bitrate rounded (the contract's prose). */
const PLAYING_TOLD = { relayOutput: "connected", programmePhase: "live", fps: 30, kbps: 4500 } as const;

/** A Seazn session, its Machine playing, both inputs connected at Cloudflare: the phone's next beat is live. */
async function liveSeazn(r: CaptureRig, phone: string): Promise<string> {
  const sid = await goLive(r, phone, { mode: "composed", targetId: await seaznOf(r.auth.orgId) });
  expect(await sessionRow(sid), "PREMISE: a Seazn-hosted composed session").toMatchObject({ mode: "composed", destination_kind: "seazn" });
  await cfSays(r, sid, "camera", "live_input.connected");
  await cfSays(r, sid, "programme", "live_input.connected");
  await machineBeats(r, sid, PLAYING);
  expect((await sessionRow(sid)).state, "PREMISE: the Machine's playing beat took it live").toBe("live");
  return sid;
}

describe.skipIf(!HAS_DB)("Task 46 — the beat answer's delivery, through the real beat", () => {
  it("a Seazn session: go-live carries what the relay has said so far, then live carries the full object — one read per beat", async () => {
    const r = await captureRig();
    const phone = phoneId("dlv-full");
    const sid = await goLive(r, phone, { mode: "composed", targetId: await seaznOf(r.auth.orgId) });
    // The Machine is booting: its first beat, before any picture (RelayHeartbeat's own words).
    await machineBeats(r, sid, { state: "starting", output: "connecting", programmePhase: "waiting" });
    expect((await sessionRow(sid)).state, "PREMISE: not live yet").not.toBe("live");
    const armed = await beat(r, phone);
    expect(armed.state, "the slot is armed: go-live").toBe("go-live");
    expect(dlv(armed), "the relay's words verbatim; no fps/kbps reported, no notification yet").toEqual({ relayOutput: "connecting", programmePhase: "waiting" });
    expect(readDeliveryFacts).toHaveBeenCalledTimes(1);

    await cfSays(r, sid, "camera", "live_input.connected");
    await cfSays(r, sid, "programme", "live_input.connected");
    r.tick(RELAY_HEARTBEAT_INTERVAL_MS);
    await machineBeats(r, sid, PLAYING);
    const live = await beat(r, phone, { sid, state: "publishing" });
    expect(live).toMatchObject({ state: "live", sid });
    expect(dlv(live)).toEqual({ ...PLAYING_TOLD, cameraIngest: "connected", programmeIngest: "connected" });
    expect(readDeliveryFacts, "one read per publishing beat").toHaveBeenCalledTimes(2);
    expect(vi.mocked(readDeliveryFacts).mock.calls.map((c) => c[0])).toEqual([sid, sid]);
  });

  it("freshness, 3 relay beats: a relay beat exactly that old is told, a millisecond older is not — the Cloudflare members stay", async () => {
    const r = await captureRig();
    const phone = phoneId("dlv-stale");
    const sid = await liveSeazn(r, phone);
    expect(DELIVERY_RELAY_FRESH_MS, "the brief's window, from the served cadence").toBe(3 * RELAY_HEARTBEAT_INTERVAL_MS);
    // sid null: the phone's beat does not tick the session here, so the Machine's own lost rule (R2003) cannot move the state
    // under the read; only the answer's read of the stored beat is under test.
    r.tick(DELIVERY_RELAY_FRESH_MS);
    expect(dlv(await beat(r, phone)), "at the edge: still told").toEqual({ ...PLAYING_TOLD, cameraIngest: "connected", programmeIngest: "connected" });
    r.tick(1);
    const stale = await beat(r, phone);
    expect(stale.state).toBe("live");
    expect(dlv(stale), "relay members omitted, never reported stale-as-fresh").toEqual({ cameraIngest: "connected", programmeIngest: "connected" });
    // The Machine beats again: told again.
    await machineBeats(r, sid, PLAYING);
    expect(dlv(await beat(r, phone))).toEqual({ ...PLAYING_TOLD, cameraIngest: "connected", programmeIngest: "connected" });
  });

  it("no relay beat stored yet → only the Cloudflare members; nothing known at all → no delivery key", async () => {
    const r = await captureRig();
    const phone = phoneId("dlv-norelay");
    const sid = await goLive(r, phone, { mode: "composed", targetId: await seaznOf(r.auth.orgId) });
    expect((await sessionRow(sid)).last_heartbeat, "PREMISE: the Machine has not beaten").toBeNull();
    const nothing = await beat(r, phone);
    expect(nothing.state).toBe("go-live");
    expect(nothing, "every member unknown → the key is omitted").not.toHaveProperty("delivery");
    await cfSays(r, sid, "camera", "live_input.connected");
    const cfOnly = await beat(r, phone);
    expect(dlv(cfOnly)).toEqual({ cameraIngest: "connected" });
    expect(readDeliveryFacts).toHaveBeenCalledTimes(2);
  });

  it("a second beat after the relay reports its output down shows the change; Cloudflare's latest notification per input, by its moment", async () => {
    const r = await captureRig();
    const phone = phoneId("dlv-down");
    const sid = await liveSeazn(r, phone);
    expect(dlv(await beat(r, phone, { sid, state: "publishing" }))).toEqual({ ...PLAYING_TOLD, cameraIngest: "connected", programmeIngest: "connected" });
    r.tick(RELAY_HEARTBEAT_INTERVAL_MS);
    await machineBeats(r, sid, { state: "stalled", output: "backoff", programmePhase: "reconnecting", fps: 0, bitrateKbps: 0 });
    await cfSays(r, sid, "programme", "live_input.disconnected");
    const down = await beat(r, phone, { sid, state: "publishing" });
    // The case the phone could not tell on stg: its camera reaches Cloudflare, the programme does not.
    expect(dlv(down)).toEqual({ relayOutput: "backoff", programmePhase: "reconnecting", fps: 0, kbps: 0, cameraIngest: "connected", programmeIngest: "disconnected" });
    // A notification delivered late, about a moment BEFORE the latest one (Cloudflare documents no order), never reads as now…
    await cfSays(r, sid, "programme", "live_input.errored", new Date(r.now().getTime() - 2 * SEC));
    expect(dlv(await beat(r, phone))?.programmeIngest).toBe("disconnected");
    // …while a newer one does; `errored` is told as itself, not folded into the port's `unknown`.
    r.tick(SEC);
    await cfSays(r, sid, "programme", "live_input.errored");
    expect(dlv(await beat(r, phone))?.programmeIngest).toBe("errored");
  });

  it("a read that throws: no delivery, the beat stored and answered, reported without secrets; the next beat carries it again", async () => {
    const r = await captureRig();
    const phone = phoneId("dlv-throw");
    const sid = await liveSeazn(r, phone);
    const errSpy = vi.spyOn(log, "error");
    vi.mocked(readDeliveryFacts).mockRejectedValueOnce(new Error("delivery read failed (test)"));
    r.tick(SEC);
    const a = await beat(r, phone, { sid, state: "publishing" });
    expect(a).toMatchObject({ state: "live", sid });
    expect(a).not.toHaveProperty("delivery");
    const stored = await pairingOf(r, phone);
    expect(stored.last_beat_at.getTime(), "the beat was stored").toBe(r.now().getTime());
    expect(stored.answered_poll_seconds, "and its answer's cadence").toBe(a.pollSeconds);
    expect(captureError).toHaveBeenCalledTimes(1);
    expect(vi.mocked(captureError).mock.calls[0]![1]).toEqual({ orgId: r.auth.orgId, route: "capture.beat.delivery_read", extra: { sid } });
    const logged = errSpy.mock.calls.filter((c) => typeof c[1] === "string" && c[1].includes("delivery"));
    expect(logged, "one log line").toHaveLength(1);
    expect(Object.keys(logged[0]![0] as object).sort(), "ids and the error only — no beat, no input uid, no key").toEqual(["err", "orgId", "sid"]);
    const uids = [await inputUid(sid, "camera"), await inputUid(sid, "programme")];
    for (const uid of uids) expect(JSON.stringify(logged[0]), "no input uid in the log").not.toContain(uid);
    // Sequence: the next beat reads again and tells.
    expect(dlv(await beat(r, phone, { sid, state: "publishing" }))).toEqual({ ...PLAYING_TOLD, cameraIngest: "connected", programmeIngest: "connected" });
    errSpy.mockRestore();
  });

  it("pollSeconds and the stored answered cadence are the same with and without delivery", async () => {
    const r = await captureRig();
    const phone = phoneId("dlv-poll");
    await liveSeazn(r, phone);
    const withIt = await beat(r, phone);
    expect(withIt).toHaveProperty("delivery");
    const cadenceWith = (await pairingOf(r, phone)).answered_poll_seconds;
    vi.mocked(readDeliveryFacts).mockResolvedValueOnce(null);
    const without = await beat(r, phone);
    expect(without).not.toHaveProperty("delivery");
    const rest: Record<string, unknown> = { ...withIt };
    delete rest.delivery;
    expect(without, "the same answer, less the key").toEqual(rest);
    expect((await pairingOf(r, phone)).answered_poll_seconds).toBe(cadenceWith);
  });

  it("after Stop (ending): the phone naming its session hears `over`; once it has completed, `waiting` — neither carries delivery or reads", async () => {
    const r = await captureRig();
    const phone = phoneId("dlv-stop");
    const sid = await liveSeazn(r, phone);
    // A composed session's camera is never polled (the poll reads passthrough inputs only — stream-sessions/live-notification.ts
    // head), so it never records first_ingest_at: §5.4 reads its ENDING session as `starting` (waiting), never `live` — so no
    // beat after a Stop can be a publishing answer on a composed (Seazn or pasted-key) session.
    r.tick(3 * SEC);
    await tickSession(sid, r.deps, "beat");
    await machineBeats(r, sid, PLAYING);
    const [{ first_ingest_at: ingestedAt }] = await sql<{ first_ingest_at: Date | null }[]>`select first_ingest_at from fixture_stream_sessions where id = ${sid}`;
    expect(ingestedAt, "PREMISE: a composed session records no first ingest").toBeNull();
    await stopSession(r.auth, r.fixtureId, sid, r.deps);
    expect((await sessionRow(sid)).state, "PREMISE: the Stop moved it to ending").toBe("ending");
    vi.mocked(readDeliveryFacts).mockClear();
    // §6.3.3 row 3: the phone names its session, which is ending → over.
    const over = await beat(r, phone, { sid, state: "publishing" });
    expect(over).toMatchObject({ state: "over", sid });
    expect(over).not.toHaveProperty("delivery");
    // The named beat ticked the ending session, and the fake's stopped Machine is gone, so it completed (the
    // stream-sessions.seazn.test.ts stopAndSettle precedent). The next beat reads a slot with nothing open: waiting (row 4).
    expect((await sessionRow(sid)).state, "PREMISE: the stopped session completed").toBe("completed");
    const unnamed = await beat(r, phone);
    expect(unnamed.state).toBe("waiting");
    expect(unnamed).not.toHaveProperty("delivery");
    expect(readDeliveryFacts, "no publishing answer, no read").not.toHaveBeenCalled();
  });

  it("the Machine's FINAL beat (an in-place restart) is no relay fact while the session plays on; the next Machine's beat is told", async () => {
    const r = await captureRig();
    const phone = phoneId("dlv-final");
    const sid = await liveSeazn(r, phone);
    // The compositor's in-place restart (exit 75): its final beat is stored, the session plays on.
    await machineBeats(r, sid, { state: "stopped", output: "connected", programmePhase: "final", exitReason: "restart" });
    expect((await sessionRow(sid)).state, "PREMISE: the session plays on through an in-place restart").toBe("live");
    const restarting = await beat(r, phone);
    expect(restarting.state).toBe("live");
    expect(dlv(restarting), "a fresh but final beat: no relay member").toEqual({ cameraIngest: "connected", programmeIngest: "connected" });
    // The restarted process beats on the same attempt (heartbeat.ts closesAttempt): told again.
    r.tick(RELAY_HEARTBEAT_INTERVAL_MS);
    await machineBeats(r, sid, PLAYING);
    expect(dlv(await beat(r, phone))).toEqual({ ...PLAYING_TOLD, cameraIngest: "connected", programmeIngest: "connected" });
  });

  it("not current: a stranger's beat (replaced) and a claim on the live slot (taken) carry no delivery and make no read", async () => {
    const r = await captureRig();
    const phone = phoneId("dlv-holder");
    await liveSeazn(r, phone);
    vi.mocked(readDeliveryFacts).mockClear();
    const taken = await beat(r, phoneId("dlv-claimer"), { claim: "new" });
    expect(taken.state).toBe("taken");
    expect(taken).not.toHaveProperty("delivery");
    const replaced = await beat(r, phoneId("dlv-stranger"));
    expect(replaced.state).toBe("replaced");
    expect(replaced).not.toHaveProperty("delivery");
    expect(readDeliveryFacts).not.toHaveBeenCalled();
    // The holder's own beat still reads and tells.
    expect(dlv(await beat(r, phone))).toEqual({ ...PLAYING_TOLD, cameraIngest: "connected", programmeIngest: "connected" });
  });

  it("no session in flight: waiting carries no delivery and makes no read", async () => {
    const r = await captureRig();
    const phone = phoneId("dlv-idle");
    await r.pair(phone);
    const idle = await beat(r, phone);
    expect(idle.state).toBe("waiting");
    expect(idle).not.toHaveProperty("delivery");
    expect(readDeliveryFacts).not.toHaveBeenCalled();
  });

  it("every kind of session tells what is stored: a passthrough at most its camera, a composed session on a pasted key its relay and inputs; nothing stored → no key", async () => {
    // Passthrough (phone → Cloudflare → YouTube, no relay): live once the camera connects.
    const p = await captureRig();
    const pPhone = phoneId("dlv-pass");
    const pSid = await p.start(pPhone);
    p.tick(3 * SEC);
    await tickSession(pSid, p.deps, "beat");
    expect(await sessionRow(pSid), "PREMISE: a live passthrough on a pasted key, no relay beat").toMatchObject({ state: "live", mode: "passthrough", destination_kind: "youtube", last_heartbeat: null });
    // The empty case: nothing stored yet — the read answers a row, every member is unknown, so no key at all.
    const nothing = await beat(p, pPhone, { sid: pSid, state: "publishing" });
    expect(nothing.state).toBe("live");
    expect(nothing, "nothing stored: no delivery key").not.toHaveProperty("delivery");
    await cfSays(p, pSid, "camera", "live_input.connected");
    const pass = await beat(p, pPhone, { sid: pSid, state: "publishing" });
    expect(pass.state).toBe("live");
    expect(dlv(pass), "a passthrough has a camera input and nothing else").toEqual({ cameraIngest: "connected" });
    // Composed on the pasted key: a relay and a programme, on YouTube.
    const c = await captureRig();
    const cPhone = phoneId("dlv-pasted-composed");
    const cSid = await goLive(c, cPhone, { mode: "composed", targetId: c.target.id });
    await machineBeats(c, cSid, PLAYING);
    await cfSays(c, cSid, "programme", "live_input.connected");
    expect(await sessionRow(cSid), "PREMISE: a live composed session on a pasted key").toMatchObject({ state: "live", mode: "composed", destination_kind: "youtube" });
    const composed = await beat(c, cPhone, { sid: cSid, state: "publishing" });
    expect(composed.state).toBe("live");
    expect(dlv(composed), "its relay, and the one input Cloudflare has spoken of").toEqual({ ...PLAYING_TOLD, programmeIngest: "connected" });
    // Each publishing beat made its one read, of its own session.
    expect(vi.mocked(readDeliveryFacts).mock.calls.map((x) => x[0])).toEqual([pSid, pSid, cSid]);
  });

  it("another surface: a court code's beat on its live (composed) session runs the same read and tells its relay", async () => {
    const day = await seedDay();
    const [A] = day.comp.fixtures.map((f) => f.id) as [string];
    await override(day.orgId, "streaming.relay", true);
    await override(day.orgId, "streaming.overlay", true);
    await grantCredits({ orgId: day.orgId, delta: 5, createdBy: await rigUser(), note: "court delivery", idempotencyKey: randomUUID() });
    const yt = await connect({ auth: day.auth, orgId: day.orgId, userId: day.auth.userId! });
    const now = at(0).getTime();
    const ingest = new FakeIngest({ clock: () => now, connectAfterMs: 3000 });
    ingest.storage = { totalStorageMinutes: 0, totalStorageMinutesLimit: 100_000_000, videoCount: 0 };
    const runner = new FakeRunner();
    const deps: SessionDeps = { drivers: { ingest, runner }, now: () => new Date(now), appUrl: "http://app.test", youtube: new FakeYouTube({ now: () => new Date(now) }) };
    const shown = await linkCourtStream(day.auth, day.comp.id, { courtId: day.courts.c2, targetId: yt.targetId, day: "2026-11-07" }, at(0));
    const qr = { code: shown.qr!.code, tok: shown.qr!.tok };
    await place(day, A, 180, day.courts.c2);
    await setCourtStream(day.auth, A, true, at(0));
    await setStatus(A, "in_play");
    const phone = phoneId("dlv-court");
    const courtBeat = async (over: Partial<Beat>) => checked(await postBeat(qr.code, qr.tok, CaptureBeat.parse({
      code: qr.code, slot: 0, phone, claim: null, device: null, sid: null, at: new Date(now).toISOString(), state: "paired",
      cause: null, notReady: null, startFailed: null, stopped: null, mode: "operator", transport: null, bitrateKbps: null,
      delivery: "unknown", deliveredLagS: null, audioOk: null, battery: null, thermal: null, dataUsedMB: null,
      appVersion: "1.0.14-1200", ...over,
    }), deps, new Date(now)));
    await courtBeat({ claim: "new" });
    const sid = (await postStart(qr.code, qr.tok, { phone }, deps, new Date(now))).sid;
    // RELAY_IMAGE is set in this file, so the court's start runs composed (stream-codes startModeFor): a relay and a programme,
    // on the link's YouTube destination. Its Machine plays: live.
    const spec = runner.created.find((c) => c.sessionId === sid);
    expect(spec, "PREMISE: the court's session is composed (a Machine was created)").toBeDefined();
    await heartbeat(sid, spec!.jobToken, PLAYING, deps);
    expect((await sql<{ state: string; mode: string; destination_kind: string | null; court_link_id: string | null }[]>`
      select state, mode, destination_kind, court_link_id from fixture_stream_sessions where id = ${sid}`)[0],
      "PREMISE: the court's composed session is live, on the link's YouTube destination").toMatchObject({ state: "live", mode: "composed", destination_kind: "youtube", court_link_id: shown.id });
    vi.mocked(readDeliveryFacts).mockClear();
    const a = await courtBeat({ sid, state: "publishing" });
    expect(a).toMatchObject({ state: "live", sid });
    // The Machine's beat is stored; Cloudflare has sent no notification for either input.
    expect(dlv(a)).toEqual(PLAYING_TOLD);
    // The court's beat is runBeat's: the same one read, of the court's session.
    expect(readDeliveryFacts).toHaveBeenCalledTimes(1);
    expect(readDeliveryFacts).toHaveBeenCalledWith(sid);
  });

  it("anti-vacuity: answers were checked", () => {
    expect(answersChecked).toBeGreaterThan(25);
  });
});
