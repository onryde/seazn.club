// Owner ruling 2026-10-09 (Option 1) — the organiser's Go live tells "no phone" from "a phone that stopped answering".
// W5 (capture QR v2 §6.7.1) refused both `409 phone_not_paired`; now a CURRENT pairing that is silent (§6.9: no beat
// within max(floor, answered cadence + slack)) answers `409 phone_not_responding`, and only a code with no current pairing
// keeps `phone_not_paired`.
//
// DB-backed through the REAL code (`ensureStreamCode`, via captureRig), the REAL claim and beats (`postBeat`), the REAL
// organiser start (`createSession` — no re-pairing wrapper) and the REAL stops, on FAKE drivers and a tickable clock.
// The window edge is computed from §6.9's own constants (config.ts), never from pairing.ts's `silentAfterMs`.
//
// The sequence (TEST-STRATEGY rule 1): the EMPTY case (a code no phone ever claimed), a fresh phone, the same phone gone
// quiet, a SECOND phone taking the slot over, and both ways a session can end under the phone — the organiser's Stop
// (the pairing stays) and the phone's own Stop (T21: the pairing ends with it). Single-sport (generic) by design: the
// phone gate reads no sport — admission is org- and fixture-level (the capture-start precedent covers cricket).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomInt } from "node:crypto";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { ApiV1Error, apiV1 } from "@/lib/client-v1";
import { createErrorCode } from "@/lib/stream-session-view";
import { v1 } from "@/server/api-v1/http";
import { CaptureBeat } from "@/server/api-v1/capture-schemas";
import { PHONE_SILENT_FLOOR_SECONDS, PHONE_SILENT_SLACK_SECONDS, POLL_FAR_SECONDS, POLL_STARTING_SECONDS } from "@/server/relay/config";
import { postBeat } from "../capture-phone";
import { createSession, stopSession } from "../stream-sessions";
import { captureRig, phoneId, type CaptureRig } from "./_capture-rig";

const HAS_DB = !!process.env.DATABASE_URL;

// PHONE_SILENT_FLOOR_SECONDS and ENV_NAME are cleared so the floor is §6.9's DEFAULT (tunable() honours an override only
// under ENV_NAME local/ci) — the window below is computed from that default.
const ENV_KEYS = ["RELAY_KEK", "AUTH_SECRET", "OAUTH_BASE_URL", "NEXT_PUBLIC_BASE_URL", "STREAM_INGEST_HOST", "STREAM_PLAYBACK_HOST", "STREAM_SRT_ENABLED", "RELAY_DRIVERS", "PHONE_SILENT_FLOOR_SECONDS", "ENV_NAME"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const KEK = randomBytes(32).toString("hex");
function baseEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.RELAY_KEK = KEK;
  process.env.AUTH_SECRET = "go-live-phone-test-secret";
}
beforeAll(baseEnv);
beforeEach(baseEnv);
afterAll(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

/** §6.9, the rule's own arithmetic from config.ts: silent once quiet for max(floor, answered cadence + slack). */
const windowMs = (cadenceS: number): number => Math.max(PHONE_SILENT_FLOOR_SECONDS, cadenceS + PHONE_SILENT_SLACK_SECONDS) * 1_000;

/** One beat from `phone` on the rig's ACTIVE code, at the rig's clock — `claim: "new"` is a scan. */
function beat(r: CaptureRig, phone: string, over: Partial<Record<string, unknown>> = {}) {
  return postBeat(r.code, r.tok, CaptureBeat.parse({
    code: r.code, slot: 0, phone, claim: null, device: null, sid: null, at: r.now().toISOString(), state: "paired",
    cause: null, notReady: null, startFailed: null, stopped: null, mode: "operator", transport: null, bitrateKbps: null,
    delivery: "unknown", deliveredLagS: null, audioOk: null, battery: null, thermal: null, dataUsedMB: null,
    appVersion: "go-live-phone-test/1", ...over,
  }), r.deps, r.now());
}
const scan = (r: CaptureRig, phone: string) => beat(r, phone, { claim: "new", device: { model: "Pixel 8" } });

const goLive = (r: CaptureRig) => createSession(r.auth, r.fixtureId, { mode: "passthrough", targetId: r.target.id }, r.deps);
/** The organiser's Go live, refused: the HttpError's (status, code). Anything else — an admit, a non-HttpError — reds. */
async function refusal(r: CaptureRig): Promise<[number, string | undefined]> {
  const got = await goLive(r).then((ok) => ok, (e: unknown) => e);
  expect(got, "the Go live was refused with an HttpError").toBeInstanceOf(HttpError);
  return [(got as HttpError).status, (got as HttpError).code];
}

const sessionsOf = async (r: CaptureRig) => sql<{ id: string; state: string; pairing_id: string | null }[]>`
  select id, state, pairing_id from fixture_stream_sessions where fixture_id = ${r.fixtureId} order by created_at`;
const pairingsOf = async (r: CaptureRig) => sql<{ id: string; phone: string; ended_at: Date | null; end_cause: string | null }[]>`
  select p.id, p.phone, p.ended_at, p.end_cause from fixture_stream_pairings p join fixture_stream_codes c on c.id = p.code_id
   where c.fixture_id = ${r.fixtureId} order by p.claimed_at, p.id`;
const currentOf = async (r: CaptureRig, phone: string) => (await pairingsOf(r)).find((p) => p.phone === phone && p.ended_at === null) ?? null;
const setCadence = (pairingId: string, cadenceS: number) => sql`update fixture_stream_pairings set answered_poll_seconds = ${cadenceS} where id = ${pairingId}`;
/** A stopped session's `ending` is the runner's to finish; on fake drivers nothing does, so it is completed here (the
 *  capture-beat T20 precedent) — only the NEXT Go live is under test. */
async function settle(sid: string): Promise<void> {
  const [row] = await sql<{ state: string }[]>`select state from fixture_stream_sessions where id = ${sid}`;
  if (row!.state === "ending") await sql`update fixture_stream_sessions set state = 'completed', end_reason = 'stopped', ended_at = now() where id = ${sid}`;
  const [after] = await sql<{ state: string }[]>`select state from fixture_stream_sessions where id = ${sid}`;
  expect(["completed", "failed"], `PREMISE: session ${sid} is over before the next Go live`).toContain(after!.state);
}

describe.skipIf(!HAS_DB)("the organiser's Go live — no phone vs a phone that stopped answering (owner ruling 2026-10-09)", () => {
  it("EMPTY first: a code no phone ever claimed → 409 phone_not_paired, no row; the phone scans → the SAME Go live is admitted on its pairing", async () => {
    const r = await captureRig({ credits: 1 });
    expect(await pairingsOf(r), "PREMISE: nothing ever claimed this code").toEqual([]);
    expect(await refusal(r)).toEqual([409, "phone_not_paired"]);
    // The message names only what this code means since the split — no CURRENT pairing — and no longer claims "answering",
    // which is phone_not_responding's half (the route's OpenAPI summary says the same).
    const message = await goLive(r).then(() => null, (e: unknown) => (e instanceof HttpError ? e.message : String(e)));
    expect(message).toBe("no phone is paired on this match's stream code");
    expect(await sessionsOf(r), "a refused Go live writes no row").toEqual([]);
    const A = phoneId("a");
    await scan(r, A);
    const { sessionId } = await goLive(r);
    expect((await sessionsOf(r)).map((s) => [s.id, s.pairing_id])).toEqual([[sessionId, (await currentOf(r, A))!.id]]);
  });

  it("the window edge, from §6.9's constants, at a cadence where the FLOOR decides and one where cadence + SLACK does: just past it and exactly at it → 409 phone_not_responding (never phone_not_paired), no row; 1 ms inside it → admitted", async () => {
    const CADENCES = [POLL_STARTING_SECONDS, POLL_FAR_SECONDS] as const;
    // The sweep reaches both arms of max(): otherwise one constant could drift and nothing here would see it.
    const decidedBy = CADENCES.map((c) => (PHONE_SILENT_FLOOR_SECONDS >= c + PHONE_SILENT_SLACK_SECONDS ? "floor" : "cadence+slack"));
    expect(new Set(decidedBy), "PREMISE: the cadences exercise both terms of max(floor, cadence + slack)").toEqual(new Set(["floor", "cadence+slack"]));
    let checked = 0;
    for (const cadence of CADENCES) {
      const r = await captureRig({ credits: 1 });
      const A = phoneId(`edge-${cadence}`);
      await scan(r, A);
      const pairing = (await currentOf(r, A))!;
      await setCadence(pairing.id, cadence);
      const edge = windowMs(cadence);
      r.tick(edge + 1);
      expect(await refusal(r), `cadence ${cadence}s: 1 ms past ${edge} ms`).toEqual([409, "phone_not_responding"]);
      r.tick(-1);
      expect(await refusal(r), `cadence ${cadence}s: exactly ${edge} ms (§6.9's ≥)`).toEqual([409, "phone_not_responding"]);
      expect(await sessionsOf(r), `cadence ${cadence}s: refusals write no row`).toEqual([]);
      expect(await currentOf(r, A), `cadence ${cadence}s: a refused Go live leaves the pairing current`).toMatchObject({ id: pairing.id });
      r.tick(-1);
      const { sessionId } = await goLive(r);
      expect((await sessionsOf(r)).map((s) => [s.id, s.pairing_id]), `cadence ${cadence}s: 1 ms inside → admitted on A`).toEqual([[sessionId, pairing.id]]);
      checked += 3;
    }
    expect(checked, "three instants × two cadences").toBe(6);
  });

  it("the refusal reaches the Phone tab: through the v1 envelope and apiV1, createErrorCode reads phone_not_responding (not unknown, not phone_not_paired)", async () => {
    const r = await captureRig({ credits: 1 });
    await scan(r, phoneId("wire"));
    r.tick(10 * 60_000);   // ten minutes: past max(floor, cadence + slack) for every cadence V430 admits (5..300 s)
    const err = await goLive(r).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    const res = await v1(async () => { throw err; });
    expect(res.status).toBe(409);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(res);
    const wired = await apiV1(`/api/v1/fixtures/${r.fixtureId}/stream-sessions`, { method: "POST", json: { mode: "passthrough", targetId: r.target.id } })
      .catch((e: unknown) => e)
      .finally(() => fetchSpy.mockRestore());
    expect(wired).toBeInstanceOf(ApiV1Error);
    expect(createErrorCode(wired)).toBe("phone_not_responding");
  });

  it("a silent phone is refused BEFORE the storage read (the W5 ruling, B4 fix round): no storageUsage call, no admission snapshot; its next beat makes the same Go live read storage exactly once", async () => {
    const r = await captureRig({ credits: 1 });
    const marker = randomInt(10_000, 1_000_000);
    r.ingest.storage = { ...r.ingest.storage, totalStorageMinutes: marker };
    const snapshots = async () => (await sql<{ n: number }[]>`
      select count(*)::int as n from stream_storage_snapshots where source = 'admission' and used_minutes = ${marker}`)[0]!.n;
    const reads = vi.spyOn(r.ingest, "storageUsage");
    const A = phoneId("storage");
    await scan(r, A);
    r.tick(10 * 60_000);
    expect(await refusal(r)).toEqual([409, "phone_not_responding"]);
    expect(reads, "a refused silent phone asked Cloudflare nothing").toHaveBeenCalledTimes(0);
    expect(await snapshots(), "nothing was measured, so nothing is recorded").toBe(0);
    await beat(r, A);
    await goLive(r);
    expect(reads, "the positive pair: the admitted start reads storage once").toHaveBeenCalledTimes(1);
    expect(await snapshots()).toBe(1);
  });

  it("after a TAKEOVER: phone A silent → phone_not_responding; phone B scans and takes the slot (T2, A ended replaced) → at the SAME instant the Go live is admitted on B's pairing", async () => {
    const r = await captureRig({ credits: 1 });
    const A = phoneId("a");
    const B = phoneId("b");
    await scan(r, A);
    r.tick(10 * 60_000);
    expect(await refusal(r), "A is paired and silent").toEqual([409, "phone_not_responding"]);
    const answer = await scan(r, B);
    expect(answer.state, "B's scan is a takeover, never taken or replaced").not.toMatch(/^(taken|replaced)$/);
    const rows = await pairingsOf(r);
    expect(rows.map((p) => [p.phone, p.ended_at !== null, p.end_cause]), "T2: A replaced, B current").toEqual([[A, true, "replaced"], [B, false, null]]);
    const { sessionId } = await goLive(r);
    expect((await sessionsOf(r)).map((s) => [s.id, s.pairing_id])).toEqual([[sessionId, (await currentOf(r, B))!.id]]);
  });

  it("after the ORGANISER's Stop the pairing stays (T20): the same phone gone quiet → phone_not_responding; its next beat → admitted again", async () => {
    const r = await captureRig({ credits: 2 });
    const A = phoneId("a");
    await scan(r, A);
    const first = (await goLive(r)).sessionId;
    await stopSession(r.auth, r.fixtureId, first, r.deps);
    await settle(first);
    expect(await currentOf(r, A), "T20: the organiser's Stop never ends the pairing").not.toBeNull();
    r.tick(10 * 60_000);
    expect(await refusal(r), "paired, the session over, the phone silent").toEqual([409, "phone_not_responding"]);
    await beat(r, A);
    const { sessionId } = await goLive(r);
    expect(sessionId).not.toBe(first);
    expect((await sessionsOf(r)).at(-1), "the second session rides A's pairing").toMatchObject({ id: sessionId, pairing_id: (await currentOf(r, A))!.id });
  });

  it("after the PHONE's own Stop (T21: an ended beat) the pairing ends with the session: Go live at that very instant — the freshest beat there is — → phone_not_paired (a rescan is owed), never phone_not_responding; a rescan → admitted", async () => {
    const r = await captureRig({ credits: 2 });
    const A = phoneId("a");
    await scan(r, A);
    const held = (await goLive(r)).sessionId;
    await beat(r, A, { state: "ended", sid: held, endReason: "operator-stopped" });
    await settle(held);
    expect(await currentOf(r, A), "T21: the pairing ended with the phone's Stop").toBeNull();
    expect((await pairingsOf(r)).map((p) => p.end_cause)).toEqual(["operator_stopped"]);
    expect(await refusal(r)).toEqual([409, "phone_not_paired"]);
    await scan(r, A);
    const { sessionId } = await goLive(r);
    expect(sessionId).not.toBe(held);
  });
});
