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
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { HttpError, PaymentRequiredError } from "@/lib/errors";
import { YOUTUBE_REFUSAL_CODES, type YoutubeRefusalCode } from "@/lib/youtube";
import { CaptureRefusalError, captureRefusal } from "@/server/api-v1/capture-http";
import { CaptureBeat, CaptureRefusal, CaptureStartOk } from "@/server/api-v1/capture-schemas";
import { spendMonthlyStreamGrant } from "@/server/relay/__tests__/_session-rig";
import { connect as connectChannel } from "@/server/youtube/__tests__/_connect-rig";
import { connectionViews } from "@/server/youtube/connections";
import { FakeYouTube } from "@/server/youtube/fake";
import { youtubeRefusal } from "@/server/youtube/prepare";
import { markReconnectNeeded } from "@/server/youtube/token-store";
import { phoneStartRefusal, postBeat, postStart } from "../capture-phone";
import { reissueStreamCode, saveStreamSettings } from "../stream-codes";
import { createSession } from "../stream-sessions";
import { DestinationNotAllowedError, TargetUnreadableError } from "../stream-targets";
import { captureRig, override, phoneId, type CaptureRig } from "./_capture-rig";
import { startedDivisionWithFixture } from "./_rig";

const HAS_DB = !!process.env.DATABASE_URL;

const ENV_KEYS = ["RELAY_KEK", "AUTH_SECRET", "OAUTH_BASE_URL", "NEXT_PUBLIC_BASE_URL", "STREAM_PLAYBACK_HOST", "STREAM_SRT_ENABLED", "RELAY_DRIVERS"] as const;
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

  it("an assumption made a guard: neither W5 answer — phone_not_paired, nor phone_not_responding (owner ruling 2026-10-09) — can reach a phone start (it passes phone: \"present\") — each refused by name, never mapped to an answer the phone would act on", () => {
    let checked = 0;
    for (const code of ["phone_not_paired", "phone_not_responding"]) {
      expect(() => phoneStartRefusal(new HttpError(409, "x", code)), code).toThrow(new RegExp(`answered ${code} to a phone start`));
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("R2001, an assumption made a guard: composed_unavailable cannot reach a phone start (R2006: its mode is resolved against the same composedUnavailable()) — refused by name, never mapped to an answer the phone would act on", () => {
    const err = new HttpError(503, "composed streaming is not available on this deployment", "composed_unavailable");
    expect(() => phoneStartRefusal(err)).toThrow(/answered composed_unavailable to a phone start/);
    // The positive pair: the ingest's own 503 on the same status IS mapped — the guard is on the code, not the status.
    expect(phoneStartRefusal(new HttpError(503, "x", "ingest_unavailable"))).toMatchObject({ status: 503, code: "unavailable" });
  });

  it("YouTube Connect T11 fix round 1 (I-2): EVERY refusal an API-backed Go live can meet (YOUTUBE_REFUSAL_CODES) is a mapped phone answer — the organiser fixes the destination (409 no_destination) or the phone tries again (503 unavailable); never null (an unmapped 503 logged to Sentry), never Seazn's own 429 rate_limited; checked === the declaration's length", () => {
    // §6.7.2's vocabulary has two words that fit. Typed from the spec, and exhaustive over the declaration at compile time.
    const WANT: Record<YoutubeRefusalCode, { status: number; code: string }> = {
      youtube_reconnect_needed: { status: 409, code: "no_destination" },   // the club reconnects its channel
      youtube_live_not_enabled: { status: 409, code: "no_destination" },   // the club enables live streaming on the channel
      youtube_live_blocked: { status: 409, code: "no_destination" },       // YouTube blocked the channel from streaming
      youtube_limit_reached: { status: 503, code: "unavailable" },         // YouTube's quota: nothing the club changes
      youtube_channel_busy: { status: 503, code: "unavailable" },          // the channel's ten live streams are in use
      youtube_unavailable: { status: 503, code: "unavailable" },           // YouTube is not answering
    };
    expect(Object.keys(WANT).sort(), "the table names exactly the declared codes").toEqual([...YOUTUBE_REFUSAL_CODES].sort());
    let checked = 0;
    for (const code of YOUTUBE_REFUSAL_CODES) {
      const got = phoneStartRefusal(youtubeRefusal(code, randomUUID()));   // built by prepare's own producer: youtube_limit_reached carries status 429
      expect(got, `${code}: mapped, not null`).toBeInstanceOf(CaptureRefusalError);
      expect({ status: (got as CaptureRefusalError).status, code: (got as CaptureRefusalError).code }, code).toEqual(WANT[code]);
      expect((got as CaptureRefusalError).extras, code).toBeUndefined();
      checked++;
    }
    expect(checked).toBe(YOUTUBE_REFUSAL_CODES.length);
    expect(checked, "anti-vacuity").toBeGreaterThan(0);
    expect(new Set(Object.values(WANT).map((w) => w.code)).size, "the table has both answers, so a constant mapping cannot pass").toBe(2);
    // The positive pair: a 429 that is NOT a YouTube refusal is still not a phone refusal (the route's own rate_limited answers it).
    expect(phoneStartRefusal(new HttpError(429, "slow down"))).toBeNull();
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

  // B6 review M-2: the pick's `archived_at is null` is NOT an equivalent filter — without it the answer is the same, but
  // the refused start reaches the one start path, which reads the provider's storage and writes a snapshot row.
  // B8 review I-1: with NOTHING saved the start opens on the org's oldest destination (as the panel shows it) — every row
  // of that rule is in stream-target-agreement.test.ts. A choice CLEARED or ARCHIVED is none: never another in its place.
  it("a CLEARED pick, an ARCHIVED pick → 409 no_destination; nothing written — and the provider is asked NOTHING (no storage read, no snapshot row); the same pick un-archived does both", async () => {
    const r = await captureRig();
    const limit = 100_000_000 + Math.floor(Math.random() * 1_000_000);   // marks THIS rig's snapshot rows (the table has no org)
    r.ingest.storage = { totalStorageMinutes: 0, totalStorageMinutesLimit: limit, videoCount: 0 };
    const reads = vi.spyOn(r.ingest, "storageUsage");
    const snapshots = async () => (await sql<{ n: number }[]>`select count(*)::int as n from stream_storage_snapshots where limit_minutes = ${limit}`)[0]!.n;
    const A = phoneId("a");
    await claim(r, A);
    await saveStreamSettings(r.auth, r.fixtureId, { targetId: null });
    expect(await refused(start(r, A))).toEqual({ status: 409, body: { code: "no_destination", message: expect.any(String) } });
    await saveStreamSettings(r.auth, r.fixtureId, { targetId: r.target.id });
    await sql`update org_stream_targets set archived_at = now() where id = ${r.target.id}`;
    expect((await refused(start(r, A))).body.code).toBe("no_destination");
    expect(await sessionsOf(r.fixtureId)).toEqual([]);
    expect({ storageReads: reads.mock.calls.length, snapshotRows: await snapshots() }, "a refused pick reaches no provider").toEqual({ storageReads: 0, snapshotRows: 0 });
    // The positive pair: the probe can see both — the same pick, un-archived, starts and does each.
    await sql`update org_stream_targets set archived_at = null where id = ${r.target.id}`;
    await start(r, A);
    expect(reads.mock.calls.length, "PREMISE: a start reads storage").toBeGreaterThan(0);
    expect(await snapshots(), "PREMISE: a start writes a snapshot with this rig's limit").toBeGreaterThan(0);
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

  // Found by the rule-10 sequence (capture-sequence.test.ts, seed 424242): T12's "current" is §5.5's C — while a session
  // is open, the phone that HOLDS it, WHEREVER its code (C-2). After a reissue the session's phone scans the new QR: its
  // claim there is T1 (nothing moves — its pairing stays on the old code), and its start on the new code is T13, never
  // T12's replaced. The stranger on the new code is still replaced.
  it("C-2: across a reissue the open session's phone is still current — its start on the NEW code is already_live, not replaced", async () => {
    const { r, A } = await ready();
    const { sid } = await start(r, A);
    const shown = await reissueStreamCode(r.auth, r.fixtureId);
    const fresh = { code: shown.qr.code, tok: shown.qr.tok };
    const answer = await claim(r, A, fresh);
    expect(["taken", "replaced"], "T1: the holder re-claiming is accepted").not.toContain(answer.state);
    expect(await refused(start(r, A, fresh))).toMatchObject({ status: 409, body: { code: "already_live", sid, startedBy: "operator" } });
    expect(await refused(start(r, phoneId("x"), fresh))).toMatchObject({ status: 409, body: { code: "replaced" } });
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

// ---------------------------------------------------------------------------------------------------------------------
// YouTube Connect T11 fix round 1 (I-2): the phone's own start reaches startBroadcast, so the refusals an API-backed destination
// can meet (prepare.ts, through the real producer — a FakeYouTube and the real connect save) must come out as the phone's own
// answers. Before the fix they were unmapped: 503 `unavailable` logged to Sentry, and youtube_limit_reached (status 429)
// became Seazn's own `rate_limited`.
describe.skipIf(!HAS_DB)("postStart on an API-backed pre-pick — a YouTube refusal is the phone's own refusal (T11 fix round 1, I-2)", () => {
  const prevKek = process.env.YOUTUBE_TOKEN_KEK;
  beforeAll(() => { process.env.YOUTUBE_TOKEN_KEK = randomBytes(32).toString("hex"); });
  afterAll(() => { if (prevKek === undefined) delete process.env.YOUTUBE_TOKEN_KEK; else process.env.YOUTUBE_TOKEN_KEK = prevKek; });

  /** A ready rig whose pre-pick is a connected channel's API destination, streaming through its own FakeYouTube. */
  async function apiReady() {
    const { r, A } = await ready({ credits: 1 });
    await spendMonthlyStreamGrant(r.auth.orgId);
    const yt = await connectChannel({ auth: r.auth, orgId: r.auth.orgId, userId: r.auth.userId! });
    await saveStreamSettings(r.auth, r.fixtureId, { targetId: yt.targetId });
    const fake = new FakeYouTube({ now: r.now });
    r.deps.youtube = fake;
    return { r, A, yt, fake };
  }

  it("a dead grant (connection reconnect_needed) → 409 no_destination, nothing written, YouTube asked nothing; positive pair: a healthy channel's start is admitted on its broadcast", async () => {
    const dead = await apiReady();
    await markReconnectNeeded(sql, dead.r.auth.orgId, dead.yt.connectionId);
    const out = await refused(start(dead.r, dead.A));
    expect(out).toEqual({ status: 409, body: { code: "no_destination", message: expect.any(String) } });
    expect(await sessionsOf(dead.r.fixtureId)).toEqual([]);
    expect(dead.fake.calls, "YouTube was asked nothing").toEqual([]);

    const ok = await apiReady();
    const { sid } = await start(ok.r, ok.A);
    const [s] = await sql<{ api_backed: boolean; youtube_broadcast_id: string | null }[]>`
      select api_backed, youtube_broadcast_id from fixture_stream_sessions where id = ${sid}`;
    expect(s!.api_backed).toBe(true);
    expect(s!.youtube_broadcast_id, "the session names its broadcast").not.toBeNull();
  });

  it("YouTube's quota (youtube_limit_reached, status 429) → 503 unavailable, NEVER rate_limited; nothing written or left at YouTube; the phone's retry is admitted", async () => {
    const { r, A, fake } = await apiReady();
    fake.failNext("bind", "youtube_limit_reached");
    const out = await refused(start(r, A));
    expect(out).toEqual({ status: 503, body: { code: "unavailable", message: expect.any(String) } });
    expect(await sessionsOf(r.fixtureId)).toEqual([]);
    expect(fake.broadcastsCount(), "the refused attempt left nothing at YouTube").toBe(0);
    const { sid } = await start(r, A);
    expect((await sessionsOf(r.fixtureId)).map((s) => s.id)).toEqual([sid]);
  });

  // B4 fix round 2, F2: the record of a refused channel is for the AUTOMATIC start's retries; the operator's Start is a person's tap.
  it("F2 — the operator's Start is a human tap: after a not-enabled refusal the next Start (inside the window) asks YouTube again, is admitted on its broadcast, and the channel reads enabled", async () => {
    const { r, A, yt, fake } = await apiReady();
    fake.failNext("bind", "youtube_live_not_enabled");
    expect(await refused(start(r, A)), "premise: refused for the channel's live state").toEqual({ status: 409, body: { code: "no_destination", message: expect.any(String) } });
    expect((await connectionViews(r.auth.orgId)).get(yt.connectionId)!.liveState, "premise: the refusal is on record").toBe("not_enabled");
    const binds = fake.calls.filter((c) => c.method === "bind").length;

    const { sid } = await start(r, A);
    expect(fake.calls.filter((c) => c.method === "bind").length - binds, "YouTube was asked").toBe(1);
    const [s] = await sql<{ api_backed: boolean; start_cause: string }[]>`select api_backed, start_cause from fixture_stream_sessions where id = ${sid}`;
    expect(s).toMatchObject({ api_backed: true, start_cause: "operator" });
    expect((await connectionViews(r.auth.orgId)).get(yt.connectionId)!.liveState, "a success clears the record").toBe("enabled");
  });
});
