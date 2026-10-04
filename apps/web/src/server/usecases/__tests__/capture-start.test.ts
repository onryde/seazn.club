// Capture QR v2 §6.3.4 / §6.7 (T8c) — the phone's own start, `postStart`, DB-backed through the REAL code
// (ensureStreamCode), the REAL claim (postBeat), the REAL pre-pick writer (saveStreamSettings), the REAL reissue and the
// ONE start path (startBroadcast) on FAKE drivers.
//
// One case per row: T12 (not current → replaced), T13 (an open session → already_live {sid, startedBy}, the lost-200
// retry included), T14 (each gate → its phone code: §6.7.2's table), T15 (all pass → 200 {sid}, startCause operator,
// created_by = the code's issuer, the claim's pairing), C1b (an ENDED code starts nothing, even for its open session's
// phone), and the money (the operator start consumes once, at live). Every refusal is asserted on its RAW wire body
// (`captureRefusal`): only already_live carries extras.
//
// Expected values come from the spec's tables (§6.7.2, the contract's refusal union), never from capture-phone.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { HttpError, PaymentRequiredError } from "@/lib/errors";
import { CaptureRefusalError, captureRefusal } from "@/server/api-v1/capture-http";
import { CaptureBeat, CaptureRefusal, CaptureStartOk } from "@/server/api-v1/capture-schemas";
import { spendMonthlyStreamGrant } from "@/server/relay/__tests__/_session-rig";
import { phoneStartRefusal, postBeat, postStart } from "../capture-phone";
import { reissueStreamCode, saveStreamSettings } from "../stream-codes";
import { createSession } from "../stream-sessions";
import { DestinationNotAllowedError, TargetUnreadableError } from "../stream-targets";
import { captureRig, override, phoneId, type CaptureRig } from "./_capture-rig";
import { startedDivisionWithFixture } from "./_rig";

const HAS_DB = !!process.env.DATABASE_URL;

const ENV_KEYS = ["RELAY_KEK", "AUTH_SECRET", "OAUTH_BASE_URL", "NEXT_PUBLIC_BASE_URL", "STREAM_INGEST_HOST", "STREAM_PLAYBACK_HOST", "STREAM_SRT_ENABLED", "RELAY_DRIVERS"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const KEK = randomBytes(32).toString("hex");
function baseEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.RELAY_KEK = KEK;
  process.env.AUTH_SECRET = "capture-start-test-secret";
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

const CONNECT_MS = 3000;

async function claim(r: CaptureRig, phone: string, via: { code: string; tok: string } = r) {
  return postBeat(via.code, via.tok, CaptureBeat.parse({
    code: via.code, slot: 0, phone, claim: "new", device: null, sid: null, at: r.now().toISOString(), state: "paired",
    cause: null, notReady: null, startFailed: null, stopped: null, mode: "operator", transport: null, bitrateKbps: null,
    delivery: "unknown", deliveredLagS: null, audioOk: null, battery: null, thermal: null, dataUsedMB: null,
    appVersion: "capture-test/1",
  }), r.deps, r.now());
}
const start = (r: CaptureRig, phone: string, via: { code: string; tok: string } = r) => postStart(via.code, via.tok, { phone }, r.deps, r.now());
/** A rig whose phone A is current and whose pre-pick is the rig's destination — the T15 premise. */
async function ready(opts: Parameters<typeof captureRig>[0] = {}) {
  const r = await captureRig(opts);
  const A = phoneId("a");
  await claim(r, A);
  await saveStreamSettings(r.auth, r.fixtureId, { targetId: r.target.id });
  return { r, A };
}

let refusalsChecked = 0;
/** The refusal's RAW wire body, parsed by the contract's union; only already_live carries extras. */
async function refused(p: Promise<unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, "the start was refused with a capture refusal").toBeInstanceOf(CaptureRefusalError);
  const res = captureRefusal(err as CaptureRefusalError);
  const body = (await res.json()) as Record<string, unknown>;
  expect(CaptureRefusal.parse(body)).toEqual(body);
  expect(Object.keys(body).sort()).toEqual(body.code === "already_live" ? ["code", "message", "sid", "startedBy"] : ["code", "message"]);
  refusalsChecked++;
  return { status: res.status, body };
}
const sessionsOf = async (fixtureId: string) =>
  sql<{ id: string; state: string; start_cause: string; created_by: string; pairing_id: string | null; target_id: string }[]>`
    select id, state, start_cause, created_by, pairing_id, target_id from fixture_stream_sessions where fixture_id = ${fixtureId} order by created_at`;
const currentPairing = async (r: CaptureRig, phone: string) => (await sql<{ id: string }[]>`
  select p.id from fixture_stream_pairings p join fixture_stream_codes c on c.id = p.code_id
   where c.fixture_id = ${r.fixtureId} and p.phone = ${phone} and p.ended_at is null`)[0]!.id;
const issuerOf = async (r: CaptureRig) => (await sql<{ issued_by: string }[]>`
  select issued_by from fixture_stream_codes where fixture_id = ${r.fixtureId} and ended_at is null`)[0]!.issued_by;
const netSpend = async (sid: string) =>
  (await sql<{ net: number }[]>`select coalesce(sum(delta), 0)::int as net from org_stream_credits where session_id = ${sid} and reason in ('consume','refund')`)[0]!.net;

describe("phoneStartRefusal — §6.7.2's table, every internal refusal (pure)", () => {
  // The table as the spec writes it. Each row's internal error is built the way stream-sessions.ts throws it.
  const rows: [string, unknown, { status: number; code: string } | "already_live"][] = [
    ["plan_lacks_overlay", new PaymentRequiredError("streaming.overlay"), { status: 403, code: "not_entitled" }],
    ["plan_lacks_relay", new PaymentRequiredError("streaming.relay"), { status: 403, code: "not_entitled" }],
    ["overlay_required", new HttpError(409, "x", "overlay_required"), { status: 403, code: "not_entitled" }],
    ["active_session", new HttpError(409, "x", "active_session", { sessionId: randomUUID() }), "already_live"],
    ["no_credits", new HttpError(402, "x", "no_credits", { featureKey: "streaming.relay" }), { status: 402, code: "no_credit" }],
    ["target_not_found (archived, gone)", new HttpError(404, "stream target not found"), { status: 409, code: "no_destination" }],
    ["target_in_use", new HttpError(409, "x", "target_in_use", { holder: null }), { status: 409, code: "no_destination" }],
    ["storage_exhausted", new HttpError(503, "x", "storage_exhausted", { headroomMinutes: 0 }), { status: 503, code: "unavailable" }],
    ["ingest_unavailable / relay disabled", new HttpError(503, "x", "ingest_unavailable"), { status: 503, code: "unavailable" }],
    ["DestinationNotAllowedError", new DestinationNotAllowedError("host"), { status: 409, code: "no_destination" }],
    ["unreadable key (replace)", new TargetUnreadableError("replace_key"), { status: 409, code: "no_destination" }],
    ["unreadable key (remove)", new TargetUnreadableError("remove"), { status: 409, code: "no_destination" }],
  ];
  it.each(rows)("%s → its phone answer", (_name, err, want) => {
    const got = phoneStartRefusal(err);
    if (want === "already_live") {
      expect(got).toEqual({ alreadyLive: ((err as HttpError).extra as { sessionId: string }).sessionId });
    } else {
      expect(got).toBeInstanceOf(CaptureRefusalError);
      expect({ status: (got as CaptureRefusalError).status, code: (got as CaptureRefusalError).code }).toEqual(want);
      expect((got as CaptureRefusalError).extras).toBeUndefined();
    }
  });

  it("an assumption made a guard: phone_not_paired cannot reach a phone start (it passes phonePresent: true) — refused by name, never mapped", () => {
    expect(() => phoneStartRefusal(new HttpError(409, "x", "phone_not_paired"))).toThrow(/phone_not_paired/);
  });

  it("anything else is NOT a phone refusal (null: the caller rethrows it, a logged 500)", () => {
    let checked = 0;
    for (const err of [new Error("boom"), new HttpError(500, "x"), new HttpError(409, "x", "something_new"), new HttpError(404, "fixture not found"), "a string"]) {
      expect(phoneStartRefusal(err)).toBeNull();
      checked++;
    }
    expect(checked).toBe(5);
  });
});

describe.skipIf(!HAS_DB)("postStart — the phone's own start (§6.3.4, T12–T15)", () => {
  it("T15: the CURRENT phone with a pre-pick starts — 200 {sid}; startCause operator; created_by = the code's issuer; the claim's pairing; the pre-picked destination; a `create` event from source phone", async () => {
    const { r, A } = await ready();
    const ok = await start(r, A);
    expect(CaptureStartOk.parse(ok)).toEqual(ok);
    expect(Object.keys(ok)).toEqual(["sid"]);
    const [s] = await sessionsOf(r.fixtureId);
    expect(s).toMatchObject({ id: ok.sid, start_cause: "operator", created_by: await issuerOf(r), pairing_id: await currentPairing(r, A), target_id: r.target.id });
    const [ev] = await sql<{ source: string; payload: Record<string, unknown> }[]>`
      select source, payload from fixture_stream_events where session_id = ${ok.sid} and type = 'create'`;
    expect(ev).toMatchObject({ source: "phone", payload: { startCause: "operator", pairingId: await currentPairing(r, A) } });
  });

  it("T13 + the lost 200: a second start from the same phone meets 409 already_live naming the SAME sid, startedBy operator; nothing new is written", async () => {
    const { r, A } = await ready();
    const { sid } = await start(r, A);
    const again = await refused(start(r, A));
    expect(again).toEqual({ status: 409, body: { code: "already_live", message: expect.any(String), sid, startedBy: "operator" } });
    expect((await sessionsOf(r.fixtureId)).map((s) => s.id)).toEqual([sid]);
  });

  it("T13: a session the ORGANISER started answers already_live with startedBy organiser — and it outranks a missing pre-pick (F-A5)", async () => {
    const r = await captureRig();
    const A = phoneId("a");
    const sid = await r.start(A);
    await saveStreamSettings(r.auth, r.fixtureId, { targetId: null });
    expect(await refused(start(r, A))).toEqual({ status: 409, body: { code: "already_live", message: expect.any(String), sid, startedBy: "organiser" } });
  });

  it("T12: a phone that is NOT current → 409 replaced, no extras, nothing written — a never-paired phone and a replaced one alike", async () => {
    const { r, A } = await ready();
    expect(await refused(start(r, phoneId("stranger")))).toEqual({ status: 409, body: { code: "replaced", message: expect.any(String) } });
    // B takes the (non-live) slot over: A is no longer current.
    const B = phoneId("b");
    await claim(r, B);
    expect((await refused(start(r, A))).body.code).toBe("replaced");
    expect(await sessionsOf(r.fixtureId)).toEqual([]);
    // The positive pair: B, now current, starts.
    expect(CaptureStartOk.parse(await start(r, B)).sid).toBeTruthy();
  });

  it("T12 outranks T13: a NON-current phone asking while a session runs is `replaced`, never told the sid", async () => {
    const { r, A } = await ready();
    await start(r, A);
    const stranger = await refused(start(r, phoneId("stranger")));
    expect(stranger.body.code).toBe("replaced");
    expect(stranger.body).not.toHaveProperty("sid");
  });

  it("no pre-pick, an ARCHIVED pre-pick → 409 no_destination; nothing written", async () => {
    const r = await captureRig();
    const A = phoneId("a");
    await claim(r, A);
    expect(await refused(start(r, A))).toEqual({ status: 409, body: { code: "no_destination", message: expect.any(String) } });
    await saveStreamSettings(r.auth, r.fixtureId, { targetId: r.target.id });
    await sql`update org_stream_targets set archived_at = now() where id = ${r.target.id}`;
    expect((await refused(start(r, A))).body.code).toBe("no_destination");
    expect(await sessionsOf(r.fixtureId)).toEqual([]);
  });

  it("target_in_use (the pre-pick is held by ANOTHER match) → 409 no_destination; nothing written here", async () => {
    const { r, A } = await ready();
    // Another fixture of the same org streams to the same destination through the organiser's path.
    const other = (await startedDivisionWithFixture(r.auth)).fixtureId;
    const { pairPresentPhone } = await import("@/server/relay/__tests__/_session-rig");
    await pairPresentPhone(other, { at: r.now() });
    await createSession(r.auth, other, { mode: "passthrough", targetId: r.target.id }, r.deps);
    expect(await refused(start(r, A))).toEqual({ status: 409, body: { code: "no_destination", message: expect.any(String) } });
    expect(await sessionsOf(r.fixtureId)).toEqual([]);
  });

  it("the gates (T14): no credit → 402 no_credit; no relay → 403 not_entitled; no overlay → 403 not_entitled; storage exhausted and the relay disabled → 503 unavailable — each with no extras and no row", async () => {
    let checked = 0;
    const broke = await ready();
    await spendMonthlyStreamGrant(broke.r.auth.orgId);
    expect(await refused(start(broke.r, broke.A))).toEqual({ status: 402, body: { code: "no_credit", message: expect.any(String) } });
    checked++;
    const noRelay = await ready({ credits: 1 });
    await override(noRelay.r.auth.orgId, "streaming.relay", false);
    expect(await refused(start(noRelay.r, noRelay.A))).toEqual({ status: 403, body: { code: "not_entitled", message: expect.any(String) } });
    checked++;
    const noOverlay = await ready({ credits: 1 });
    await override(noOverlay.r.auth.orgId, "streaming.overlay", false);
    expect((await refused(start(noOverlay.r, noOverlay.A))).body.code).toBe("not_entitled");
    checked++;
    const full = await ready({ credits: 1 });
    full.r.ingest.storage = { totalStorageMinutes: 1000, totalStorageMinutesLimit: 1000, videoCount: 0 };
    expect(await refused(start(full.r, full.A))).toEqual({ status: 503, body: { code: "unavailable", message: expect.any(String) } });
    checked++;
    const off = await ready({ credits: 1 });
    const disabled = { ...off.r.deps, drivers: { ...off.r.deps.drivers, disabled: true as const } };
    const err = await postStart(off.r.code, off.r.tok, { phone: off.A }, disabled, off.r.now()).then(() => null, (e: unknown) => e);
    expect(err).toMatchObject({ status: 503, code: "unavailable" });
    checked++;
    for (const x of [broke, noRelay, noOverlay, full, off]) expect(await sessionsOf(x.r.fixtureId)).toEqual([]);
    expect(checked).toBe(5);
  });

  it("C1b: an ENDED (reissued) code starts NOTHING — 401 even for its open session's phone; the new code's current phone starts (the positive pair)", async () => {
    const { r, A } = await ready();
    const { sid } = await start(r, A);
    const shown = await reissueStreamCode(r.auth, r.fixtureId);
    const err = await start(r, A).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(CaptureRefusalError);
    expect(err).toMatchObject({ status: 401, code: "code_ended" });
    // The open session still answers on the NEW code once a phone is current there (already_live, the same sid).
    const fresh = { code: shown.qr.code, tok: shown.qr.tok };
    const B = phoneId("b");
    await claim(r, B, fresh);
    expect(await refused(start(r, B, fresh))).toMatchObject({ status: 409, body: { code: "already_live", sid } });
  });

  it("a wrong tok → 401 code_ended; nothing written", async () => {
    const { r, A } = await ready();
    const err = await start(r, A, { code: r.code, tok: "not-the-tok" }).then(() => null, (e: unknown) => e);
    expect(err).toMatchObject({ status: 401, code: "code_ended" });
    expect(await sessionsOf(r.fixtureId)).toEqual([]);
  });

  it("MONEY: the operator start consumes ONCE, at live — nothing at the start, one credit when the ingest connects, nothing on later ticks", async () => {
    const { r, A } = await ready({ credits: 1 });
    await spendMonthlyStreamGrant(r.auth.orgId);
    const { sid } = await start(r, A);
    expect(await netSpend(sid), "warming spends nothing").toBe(0);
    r.tick(CONNECT_MS);
    const { tickSession } = await import("../stream-sessions");
    await tickSession(sid, r.deps, "beat");
    expect((await sessionsOf(r.fixtureId))[0]!.state).toBe("live");
    expect(await netSpend(sid), "one credit at live").toBe(-1);
    r.tick(CONNECT_MS);
    await tickSession(sid, r.deps, "beat");
    expect(await netSpend(sid), "a later tick spends nothing more").toBe(-1);
  });

  it("another sport (cricket): the phone's start reads no sport — the same T15 answer and row", async () => {
    const { r, A } = await ready({ sport: "cricket" });
    const { sid } = await start(r, A);
    expect((await sessionsOf(r.fixtureId))[0]).toMatchObject({ id: sid, start_cause: "operator" });
  });

  it("anti-vacuity: this file asserted raw refusal bodies", () => {
    expect(refusalsChecked).toBeGreaterThan(10);
  });
});
