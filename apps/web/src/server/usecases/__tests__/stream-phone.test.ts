// Capture QR v2 §9 / §6.9 / §6.12 (T9) — `streamPhone`, the organiser panel's phone read model, DB-backed through the
// REAL producers: the code is minted and reissued by the REAL `ensureStreamCode` / `reissueStreamCode`, every phone fact
// is written by the REAL beat (`postBeat`), sessions start through the REAL organiser Go live (`createSession`, W5
// included), and `cred` comes from the REAL descriptor (`getCode`). Fake drivers, the rig's tickable clock.
//
// Expected values come from the rulebook, never from stream-phone.ts: §6.9's thresholds from config.ts's declarations
// (with the cadence the beat ANSWERED, read off the pairing the beat wrote); the beat's own fields from the beat body this
// file sent; `issuedAt` from the ensure/reissue answer; and "present" is cross-checked against the OTHER reader of the same
// fact — W5's gate inside `createSession` — so the panel can never offer a Go live the server refuses, or hide one it admits.
//
// Sequences (TEST-STRATEGY rule 1): the empty case; a second read; after a takeover, a reissue, the operator's Stop, a
// rescan, an archive, an expiry; the legacy session with no phone (controller ruling C-1).
//
// ONE SPORT, on purpose (rule 6): the read model reads no sport — no sport key, no module, no theme.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { z } from "zod";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { CaptureBeat, CaptureNotReady } from "@/server/api-v1/capture-schemas";
import { StreamPhone } from "@/server/api-v1/schemas";
import {
  AUTO_START_RETRY_SECONDS, CODE_GRACE_AFTER_FINISH_MINUTES, HOT_THERMAL_STATUS, LOW_BATTERY_PERCENT, NOT_RESPONDING_BEATS,
  PHONE_NOT_READY_SHOW_AFTER_SECONDS, PHONE_SILENT_FLOOR_SECONDS, PHONE_SILENT_SLACK_SECONDS, POLL_FAR_SECONDS,
} from "@/server/relay/config";
import { AUTO_START_CONJUNCTS, AUTO_START_REFUSALS, type AutoStartRefusal } from "@/server/relay/domain/auto-stream";
import { HEALTH_REASONS, type HealthReason } from "@/server/relay/domain/phone-health";
import { readFirstInput } from "@/server/relay/secret-columns";
import { pairPresentPhone, rigUser, sessionOnTarget, spendMonthlyStreamGrant } from "@/server/relay/__tests__/_session-rig";
import { getCode, postBeat, postStart } from "../capture-phone";
import { reissueStreamCode, saveStreamSettings } from "../stream-codes";
import { grantCredits } from "../stream-credits";
import { createSession, stopSession } from "../stream-sessions";
import { createStreamTarget } from "../stream-targets";
import { streamPhone } from "../stream-phone";
import { captureRig, override, phoneId, type CaptureRig } from "./_capture-rig";
import { seedOrg, startedDivisionWithFixture } from "./_rig";

const HAS_DB = !!process.env.DATABASE_URL;

const ENV_KEYS = ["RELAY_KEK", "AUTH_SECRET", "OAUTH_BASE_URL", "NEXT_PUBLIC_BASE_URL", "STREAM_INGEST_HOST", "STREAM_PLAYBACK_HOST", "STREAM_SRT_ENABLED", "RELAY_DRIVERS"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const KEK = randomBytes(32).toString("hex");
function baseEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.RELAY_KEK = KEK;
  process.env.AUTH_SECRET = "stream-phone-test-secret";
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

type Beat = z.infer<typeof CaptureBeat>;
const MIN = 60_000;

/** A valid beat at the rig's clock — the contract's every field, parsed by the zod twin itself. */
function body(r: CaptureRig, phone: string, over: Partial<Beat> = {}): Beat {
  return CaptureBeat.parse({
    code: r.code, slot: 0, phone, claim: null, device: null, sid: null, at: r.now().toISOString(), state: "paired",
    cause: null, notReady: null, startFailed: null, stopped: null, mode: "operator", transport: null, bitrateKbps: null,
    delivery: "unknown", deliveredLagS: null, audioOk: null, battery: null, thermal: null, dataUsedMB: null,
    appVersion: "capture-test/1", ...over,
  });
}
const beat = (r: CaptureRig, phone: string, over: Partial<Beat> = {}, via: { code: string; tok: string } = r) =>
  postBeat(via.code, via.tok, body(r, phone, { ...over, code: via.code }), r.deps, r.now());

let reads = 0;
/** Every read in this file goes through here: the answer must parse through the STRICT schema unchanged — no key the
 *  schema does not declare (so no secret can ride along under a new name). */
async function read(auth: AuthCtx, fixtureId: string, now: () => Date): Promise<StreamPhone> {
  const v = await streamPhone(auth, fixtureId, { now });
  expect(StreamPhone.parse(v)).toEqual(v);
  reads++;
  return v;
}
const readRig = (r: CaptureRig) => read(r.auth, r.fixtureId, r.now);

/** The pairing row the REAL beat wrote for `phone` (its latest), for the cadence it answered. */
async function pairingOf(r: CaptureRig, phone: string) {
  const [p] = await sql<{ id: string; answered_poll_seconds: number; ended_at: Date | null; end_cause: string | null }[]>`
    select p.id, p.answered_poll_seconds, p.ended_at, p.end_cause from fixture_stream_pairings p
      join fixture_stream_codes c on c.id = p.code_id
     where c.fixture_id = ${r.fixtureId} and p.phone = ${phone} order by p.claimed_at desc, p.id desc limit 1`;
  expect(p, `PREMISE: ${phone} has a pairing`).toBeDefined();
  return p!;
}
/** §6.9: silent at max(PHONE_SILENT_FLOOR_SECONDS, the answered cadence + PHONE_SILENT_SLACK_SECONDS). */
const silentMs = (answered: number) => Math.max(PHONE_SILENT_FLOOR_SECONDS, answered + PHONE_SILENT_SLACK_SECONDS) * 1000;

/** W5's own answer (the other reader of "present"): the organiser's Go live, refused `phone_not_paired` or not. */
async function goLiveRefusedNoPhone(r: CaptureRig): Promise<boolean> {
  try {
    await createSession(r.auth, r.fixtureId, { mode: "passthrough", targetId: r.target.id }, r.deps);
    return false;
  } catch (e) {
    if (e instanceof HttpError && e.code === "phone_not_paired") return true;
    if (e instanceof HttpError) return false;   // another admission refusal: W5 itself admitted the phone
    throw e;
  }
}

describe.skipIf(!HAS_DB)("streamPhone — the panel's read model (§9)", () => {
  it("EMPTY: a fixture with no code, no phone, no session and no pick reads all null and `auto: null`; a SECOND read is the same and writes nothing", async () => {
    const { auth: seeded } = await seedOrg();
    const auth: AuthCtx = { ...seeded, userId: await rigUser() };
    const { fixtureId } = await startedDivisionWithFixture(auth);
    const now = () => new Date();
    const empty = { code: null, phone: null, destination: null, lastTakeover: null, auto: null, legacy: false, finished: false, session: null };
    expect(await read(auth, fixtureId, now)).toEqual(empty);
    expect(await read(auth, fixtureId, now)).toEqual(empty);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_codes where fixture_id = ${fixtureId}`;
    expect(n, "a read mints nothing").toBe(0);
  });

  it("code: ACTIVE with the minted code's issuedAt; after a REISSUE the next read follows the NEW code; the fixture finished → finishing", async () => {
    const r = await captureRig();
    const [minted] = await sql<{ created_at: Date }[]>`select created_at from fixture_stream_codes where fixture_id = ${r.fixtureId} and ended_at is null`;
    expect((await readRig(r)).code).toEqual({ issuedAt: minted!.created_at.toISOString(), state: "active", endCause: null });
    const shown = await reissueStreamCode(r.auth, r.fixtureId);
    expect((await readRig(r)).code, "the reissue's own answer names the code the read follows").toEqual({ issuedAt: shown.issuedAt, state: "active", endCause: null });
    await sql`update fixtures set status = 'cancelled' where id = ${r.fixtureId}`;
    expect((await readRig(r)).code).toEqual({ issuedAt: shown.issuedAt, state: "finishing", endCause: null });
  });

  it("C2: finished CODE_GRACE_AFTER_FINISH_MINUTES ago with no open session → ENDED expired, and the expiry is WRITTEN (the first evaluation); 1 ms inside the grace → finishing, nothing written", async () => {
    const r = await captureRig();
    await sql`update fixtures set status = 'cancelled' where id = ${r.fixtureId}`;
    const graceMs = CODE_GRACE_AFTER_FINISH_MINUTES * MIN;
    await sql`update fixtures set finished_at = ${new Date(r.now().getTime() - graceMs + 1)} where id = ${r.fixtureId}`;
    expect((await readRig(r)).code?.state, "1 ms inside the grace").toBe("finishing");
    const ended = async () => (await sql<{ ended_at: Date | null; end_cause: string | null }[]>`
      select ended_at, end_cause from fixture_stream_codes where fixture_id = ${r.fixtureId}`)[0]!;
    expect((await ended()).ended_at, "a read inside the grace writes nothing").toBeNull();
    r.tick(1);
    const at = await readRig(r);
    expect(at.code).toMatchObject({ state: "ended", endCause: "expired" });
    expect(await ended(), "C2: the first evaluation that finds it expired WRITES it").toMatchObject({ end_cause: "expired" });
    expect((await ended()).ended_at).not.toBeNull();
    expect((await readRig(r)).code, "a second read of the ended code").toEqual(at.code);
  });

  it("C2's deferral: an OPEN session keeps a code past its grace finishing (W2) — nothing is written", async () => {
    const r = await captureRig();
    await r.start(phoneId("a"));
    await sql`update fixtures set status = 'cancelled' where id = ${r.fixtureId}`;
    await sql`update fixtures set finished_at = ${new Date(r.now().getTime() - CODE_GRACE_AFTER_FINISH_MINUTES * MIN - MIN)} where id = ${r.fixtureId}`;
    expect((await readRig(r)).code?.state).toBe("finishing");
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_codes where fixture_id = ${r.fixtureId} and ended_at is null`;
    expect(n).toBe(1);
  });

  it("the phone's facts are the stored beat's, each field the beat sent; lastBeatAt and elapsedMs on the SERVER's clock", async () => {
    const r = await captureRig();
    const a = phoneId("a");
    await beat(r, a, {
      claim: "new", device: { model: "Pixel 8" }, state: "armed", mode: "automatic", notReady: "camera", startFailed: "config",
      battery: { percent: 15, charging: false, drainPctPerHour: 4.5 }, bitrateKbps: 2400, delivery: "stalled", thermal: 3,
      dataUsedMB: 12.5, appVersion: "capture/2.1",
    });
    const beatAt = r.now();
    r.tick(7_000);
    const v = await readRig(r);
    expect(v.phone).toEqual({
      present: true, silent: false, notResponding: false, model: "Pixel 8", appVersion: "capture/2.1", mode: "automatic",
      state: "armed", notReady: "camera", startFailed: "config", lastBeatAt: beatAt.toISOString(), elapsedMs: 7_000,
      beat: { battery: { percent: 15, charging: false, drainPctPerHour: 4.5 }, bitrateKbps: 2400, delivery: "stalled", thermal: 3, dataUsedMB: 12.5 },
      farPoll: (await pairingOf(r, a)).answered_poll_seconds === POLL_FAR_SECONDS,
      // PR-2 T6: this beat has THREE problems at once (stalled, hot at HOT_THERMAL_STATUS, battery 15 on no charger); W9's
      // priority serves the first — stalled. The camera reason is 7 s old, inside PHONE_NOT_READY_SHOW_AFTER_SECONDS.
      health: "stalled", notReadyShown: false,
    });
    expect((await nrOf(r)).forMs, "the camera reason's clock (its column) is 7 s old").toBe(7_000);
    expect(HOT_THERMAL_STATUS, "PREMISE: the beat's thermal 3 is a hot reading").toBeLessThanOrEqual(3);
    expect(15, "PREMISE: the beat's battery is low").toBeLessThan(LOW_BATTERY_PERCENT);
    expect(7, "PREMISE: 7 s is inside the debounce").toBeLessThan(PHONE_NOT_READY_SHOW_AFTER_SECONDS);
    expect(v.lastTakeover, "one phone, no takeover").toBeNull();
  });

  it("§6.9 present → silent at max(floor, the ANSWERED cadence + slack) — not 1 ms before; and W5's gate agrees with `present` both ways", async () => {
    const r = await captureRig({ credits: 2 });
    const a = phoneId("a");
    await beat(r, a, { claim: "new" });
    const threshold = silentMs((await pairingOf(r, a)).answered_poll_seconds);
    r.tick(threshold - 1);
    const before = await readRig(r);
    expect([before.phone?.present, before.phone?.silent, before.phone?.elapsedMs]).toEqual([true, false, threshold - 1]);
    r.tick(1);
    const at = await readRig(r);
    expect([at.phone?.present, at.phone?.silent, at.phone?.elapsedMs]).toEqual([false, true, threshold]);
    expect(at.phone?.notResponding, "not held: never not-responding (§6.9, W8)").toBe(false);
    // The other reader of the same fact: W5 refuses Go live on the silent phone the read calls not present ...
    expect(await goLiveRefusedNoPhone(r), "W5 on the silent phone").toBe(true);
    // ... and admits it once the phone beats again, which the read calls present.
    await beat(r, a);
    expect((await readRig(r)).phone?.present).toBe(true);
    expect(await goLiveRefusedNoPhone(r), "W5 on the present phone").toBe(false);
  });

  it("W8: a HELD phone (the open session's) is not responding at NOT_RESPONDING_BEATS × its answered cadence — not 1 ms before", async () => {
    const r = await captureRig();
    const a = phoneId("a");
    const sid = await r.start(a);
    await beat(r, a, { sid, state: "connecting" });   // the session's phone, naming it: answered at an open session's cadence
    const nrMs = NOT_RESPONDING_BEATS * (await pairingOf(r, a)).answered_poll_seconds * 1000;
    expect(nrMs, "PREMISE: not-responding comes before silence here, so the two are told apart").toBeLessThan(silentMs((await pairingOf(r, a)).answered_poll_seconds));
    r.tick(nrMs - 1);
    expect((await readRig(r)).phone?.notResponding).toBe(false);
    r.tick(1);
    const v = await readRig(r);
    expect([v.phone?.notResponding, v.phone?.present, v.phone?.silent]).toEqual([true, true, false]);
  });

  it("T2: a REPLACED pairing is not present — the read is the new phone's, and lastTakeover names it with the time it took the slot", async () => {
    const r = await captureRig();
    const a = phoneId("a");
    const b = phoneId("b");
    await beat(r, a, { claim: "new", device: { model: "Phone A" } });
    r.tick(2_000);
    await beat(r, b, { claim: "new", device: { model: "Phone B" } });
    const tookAt = r.now();
    expect((await pairingOf(r, a)).end_cause, "PREMISE: A was replaced").toBe("replaced");
    r.tick(1_000);
    const v = await readRig(r);
    expect([v.phone?.model, v.phone?.present, v.phone?.lastBeatAt]).toEqual(["Phone B", true, tookAt.toISOString()]);
    // PR-2 T12: `elapsedMs` is the server clock's age of the takeover — the rig ticked 1 000 ms since B took the slot.
    expect(v.lastTakeover).toEqual({ at: tookAt.toISOString(), model: "Phone B", elapsedMs: 1_000 });
  });

  it("B7 review I-2: a takeover on a code the organiser has since REISSUED is not served — Revoke & reissue is the answer to it; a takeover on the NEW code is (the sequence: take, reissue, take again)", async () => {
    const r = await captureRig();
    await beat(r, phoneId("a"), { claim: "new", device: { model: "Phone A" } });
    r.tick(2_000);
    await beat(r, phoneId("b"), { claim: "new", device: { model: "Phone B" } });
    expect((await readRig(r)).lastTakeover?.model, "PREMISE: B's takeover is served").toBe("Phone B");

    const fresh = await reissueStreamCode(r.auth, r.fixtureId);
    r.tick(1_000);
    expect((await readRig(r)).lastTakeover, "the reissued code's takeover is answered — not served").toBeNull();

    // The positive pair: the NEW code's own takeover is served, at its own instant.
    const via = { code: fresh.qr.code, tok: fresh.qr.tok };
    await beat(r, phoneId("c"), { claim: "new", device: { model: "Phone C" } }, via);
    r.tick(2_000);
    await beat(r, phoneId("d"), { claim: "new", device: { model: "Phone D" } }, via);
    const tookAt = r.now();
    r.tick(500);
    expect((await readRig(r)).lastTakeover).toEqual({ at: tookAt.toISOString(), model: "Phone D", elapsedMs: 500 });
  });

  it("T21: the operator's Stop ENDS the phone's pairing — with no other phone the read has none (and no takeover)", async () => {
    const r = await captureRig();
    const a = phoneId("a");
    const sid = await r.start(a);
    expect((await readRig(r)).phone?.present, "PREMISE: the session's phone reads present").toBe(true);
    await beat(r, a, { sid, state: "ended", endReason: "operator-stopped" });
    expect((await pairingOf(r, a)).end_cause, "PREMISE: T21 ended the pairing").toBe("operator_stopped");
    const v = await readRig(r);
    expect(v.phone).toBeNull();
    expect(v.lastTakeover).toBeNull();
  });

  it("C1b/C3: after a reissue under an OPEN session, the session's phone is still the phone (present); with NO open session the old code's phone is none — and W5 agrees", async () => {
    const live = await captureRig();
    const a = phoneId("a");
    await live.start(a);
    await reissueStreamCode(live.auth, live.fixtureId);
    const held = await readRig(live);
    expect([held.phone?.present, held.code?.state], "the reissued code's phone still streaming is the current phone").toEqual([true, "active"]);

    const idle = await captureRig({ credits: 2 });
    await beat(idle, phoneId("b"), { claim: "new" });
    expect((await readRig(idle)).phone?.present, "PREMISE: paired and present before the reissue").toBe(true);
    await reissueStreamCode(idle.auth, idle.fixtureId);
    expect((await readRig(idle)).phone, "only a claim on the NEW code pairs a phone for the next Go live").toBeNull();
    expect(await goLiveRefusedNoPhone(idle), "W5: the same answer").toBe(true);
  });

  it("I-2: the session's phone RESCANNING the new code is the same phone moving — never a takeover", async () => {
    const r = await captureRig();
    const a = phoneId("a");
    await r.start(a);
    const fresh = await reissueStreamCode(r.auth, r.fixtureId);
    r.tick(1_000);   // the moved pairing is claimed after the old one, so "its latest" is unambiguous
    await beat(r, a, { claim: "new" }, { code: fresh.qr.code, tok: fresh.qr.tok });
    expect((await pairingOf(r, a)).ended_at, "PREMISE: its pairing moved onto the new code").toBeNull();
    const v = await readRig(r);
    expect(v.phone?.present).toBe(true);
    expect(v.lastTakeover).toBeNull();
  });

  it("an OPEN session whose own pairing has ENDED has no phone — the ended pairing is not read", async () => {
    const r = await captureRig();
    const a = phoneId("a");
    const sid = await r.start(a);
    await sql`update fixture_stream_pairings set ended_at = ${r.now()}, end_cause = 'code_ended'
               where id = (select pairing_id from fixture_stream_sessions where id = ${sid})`;
    const v = await readRig(r);
    expect(v.phone).toBeNull();
    // T11: no phone is NOT the same as legacy — this session HAS a pairing (ended), so the panel keeps the v2 rules.
    expect(v.legacy, "a session with an ended pairing is not a legacy session").toBe(false);
  });

  it("C-1: an open LEGACY session (pairing_id null) shows NO phone facts and no takeover — the code and the pick still read; the same session WITH its phone shows them (the positive pair)", async () => {
    const r = await captureRig();
    await saveStreamSettings(r.auth, r.fixtureId, { targetId: r.target.id });
    const a = phoneId("a");
    await beat(r, a, { claim: "new" });
    const b = phoneId("b");
    await beat(r, b, { claim: "new" });   // a takeover on the record, and B current on the active code
    const sid = await r.start(b);
    const withPhone = await readRig(r);
    expect([withPhone.phone?.present, withPhone.lastTakeover === null]).toEqual([true, false]);
    expect(withPhone.legacy, "T11: a session WITH its phone is not legacy").toBe(false);
    await sql`update fixture_stream_sessions set pairing_id = null where id = ${sid}`;
    const legacy = await readRig(r);
    expect(legacy.legacy, "T11: the panel is told the open session has no phone (C-1), so it renders today's panel").toBe(true);
    expect(legacy.phone, "no phone facts").toBeNull();
    expect(legacy.lastTakeover, "no takeover").toBeNull();
    expect(legacy.code?.state).toBe("active");
    expect(legacy.destination).toEqual({ id: r.target.id, label: r.target.label, source: "saved" });
  });

  // B8 review I-1: the destination is what the phone's start would open on (`fixtureStreamTarget`) — every row of the
  // rule's table is in stream-target-agreement.test.ts; this is the read model's own walk through one fixture's life.
  it("T36 / I-1: nothing saved → the org's oldest (`default`); the pick → itself (`saved`); ARCHIVED in Directory → none, never another; cleared → none", async () => {
    const r = await captureRig({ targetLabel: "Court 1 YouTube" });
    expect((await readRig(r)).destination, "no pick yet: the only (so oldest) destination").toEqual({ id: r.target.id, label: "Court 1 YouTube", source: "default" });
    expect(await sql`select 1 from fixture_stream_settings where fixture_id = ${r.fixtureId}`, "the read saved nothing").toHaveLength(0);
    await saveStreamSettings(r.auth, r.fixtureId, { targetId: r.target.id });
    expect((await readRig(r)).destination).toEqual({ id: r.target.id, label: "Court 1 YouTube", source: "saved" });
    const newer = await createStreamTarget(r.auth, r.auth.orgId, { kind: "twitch", label: "Court 1 Twitch", streamKey: `tw-${randomUUID()}` });
    await sql`update org_stream_targets set archived_at = now() where id = ${r.target.id}`;
    expect((await readRig(r)).destination, "archived reads as none — the newer one is NOT put in its place").toBeNull();
    await saveStreamSettings(r.auth, r.fixtureId, { targetId: newer.id });
    expect((await readRig(r)).destination?.id).toBe(newer.id);
    await saveStreamSettings(r.auth, r.fixtureId, { targetId: null });
    expect((await readRig(r)).destination, "cleared reads as none").toBeNull();
  });

  it("NO SECRET: the answer carries neither the tok nor its hash, no `cred` value the descriptor serves, and no destination stream key", async () => {
    const r = await captureRig();
    const key = `yt-secret-${randomUUID()}`;
    const target = await createStreamTarget(r.auth, r.auth.orgId, { kind: "youtube", label: "Keyed", streamKey: key });
    await saveStreamSettings(r.auth, r.fixtureId, { targetId: target.id, autoStream: true });   // PR-2: `auto` is an object the scan covers
    const a = phoneId("a");
    await r.pair(a);
    const { sessionId: sid } = await createSession(r.auth, r.fixtureId, { mode: "passthrough", targetId: target.id }, r.deps);
    await beat(r, a, { sid, state: "publishing", bitrateKbps: 2000 });
    const descriptor = await getCode(r.code, r.tok, { slot: 0, phone: a }, r.deps, r.now());
    expect("cred" in descriptor && descriptor.cred, "PREMISE: the descriptor served cred to the session's phone").toBeTruthy();
    const stored = await sql.begin((tx) => readFirstInput(tx, sid));
    const secrets = [
      r.tok, createHash("sha256").update(r.tok, "utf8").digest("hex"), key,
      stored!.srt!.passphrase, stored!.rtmps!.streamKey,
    ];
    const v = await readRig(r);
    expect(v.phone?.present, "PREMISE: the read is not empty").toBe(true);
    expect(v.auto, "PREMISE: PR-2's `auto` object is part of what is scanned").toMatchObject({ enabled: true });
    const text = JSON.stringify(v);
    let checked = 0;
    for (const s of secrets) {
      expect(s.length, "PREMISE: a real secret").toBeGreaterThan(8);
      expect(text.includes(s), "a secret in the read model").toBe(false);
      checked++;
    }
    expect(checked).toBe(5);
  });

  it("org scope: another club's organiser reads club A's fixture as 404 — the same as an unknown fixture — and nothing is written; a non-session caller is 403", async () => {
    const a = await captureRig();
    await beat(a, phoneId("a"), { claim: "new" });
    expect((await readRig(a)).phone?.present, "the positive pair: its own organiser reads it").toBe(true);
    const b = await captureRig();
    // A's code is made DUE for C2's lazy expiry, so a read that reached it WOULD write (the positive pair, last).
    await sql`update fixtures set finished_at = ${new Date(a.now().getTime() - CODE_GRACE_AFTER_FINISH_MINUTES * MIN - MIN)} where id = ${a.fixtureId}`;
    const rows = async () => ({
      codes: await sql`select id, ended_at, end_cause, tok_hash from fixture_stream_codes where fixture_id = ${a.fixtureId} order by id`,
      pairings: await sql`select p.id, p.ended_at, p.end_cause, p.last_beat_at from fixture_stream_pairings p
                            join fixture_stream_codes c on c.id = p.code_id where c.fixture_id = ${a.fixtureId} order by p.id`,
    });
    const before = await rows();
    expect([before.codes.length, before.pairings.length], "PREMISE: a code and its pairing to write to").toEqual([1, 1]);
    const refusal = async (auth: AuthCtx, fixtureId: string) => {
      try {
        await streamPhone(auth, fixtureId, { now: a.now });
        return null;
      } catch (e) {
        return e instanceof HttpError ? [e.status, e.message] : e;
      }
    };
    const foreign = await refusal(b.auth, a.fixtureId);
    expect(foreign).toEqual([404, "fixture not found"]);
    expect(await refusal(b.auth, randomUUID()), "an unknown fixture reads the same").toEqual(foreign);
    const key: AuthCtx = { ...a.auth, via: "api_key", userId: null, keyId: randomUUID() };
    expect((await refusal(key, a.fixtureId) as [number, string])[0], "session only (§9)").toBe(403);
    expect(await rows(), "the three refused reads wrote nothing").toEqual(before);
    expect((await readRig(a)).code, "the positive pair: A's own read reaches the code and writes C2's expiry").toEqual({ issuedAt: expect.any(String), state: "ended", endCause: "expired" });
    expect((await rows()).codes[0]!.ended_at, "written").not.toBeNull();
  });

  it("T11 (§6.6's waiting line): farPoll is true exactly while the phone was last ANSWERED the far cadence — a claim with no session far from the start, then false once a beat under an open session is answered faster; a second read agrees", async () => {
    const r = await captureRig();
    const a = phoneId("a");
    await beat(r, a, { claim: "new" });
    const claimed = (await pairingOf(r, a)).answered_poll_seconds;
    expect(claimed, "PREMISE (§6.6): no session and no scheduled start near → the far cadence").toBe(POLL_FAR_SECONDS);
    expect((await readRig(r)).phone?.farPoll).toBe(true);
    expect((await readRig(r)).phone?.farPoll, "a second read").toBe(true);
    const sid = await r.start(a);
    // Go live does not beat for the phone: the stored cadence is still the far one until the phone's next beat.
    expect((await readRig(r)).phone?.farPoll, "the phone has not checked in since Go live").toBe(true);
    await beat(r, a, { sid, state: "connecting" });
    const answered = (await pairingOf(r, a)).answered_poll_seconds;
    expect(answered, "PREMISE: an open session answers a faster cadence than the far one").toBeLessThan(POLL_FAR_SECONDS);
    expect((await readRig(r)).phone?.farPoll, "it has heard the Go live").toBe(false);
  });

  it("T11 (C5): `finished` follows the FIXTURE — false while in play, true once finished, and false again after a reverted result while the expired code STAYS ended (the match-over row must not key on the code alone)", async () => {
    const r = await captureRig();
    expect((await readRig(r)).finished, "in play").toBe(false);
    await sql`update fixtures set status = 'cancelled' where id = ${r.fixtureId}`;
    expect((await readRig(r)).finished, "finished").toBe(true);
    await sql`update fixtures set finished_at = ${new Date(r.now().getTime() - CODE_GRACE_AFTER_FINISH_MINUTES * MIN - MIN)} where id = ${r.fixtureId}`;
    const expired = await readRig(r);
    expect([expired.finished, expired.code?.state, expired.code?.endCause]).toEqual([true, "ended", "expired"]);
    await sql`update fixtures set status = 'in_play' where id = ${r.fixtureId}`;   // the result reverted (§8.1 trigger clears finished_at)
    const reverted = await readRig(r);
    expect([reverted.finished, reverted.code?.state, reverted.code?.endCause], "C5: the code stays ended; the fixture is not finished").toEqual([false, "ended", "expired"]);
  });

  // B8 review I-2: the panel's `current` rests at Ready, so the read model is what tells it a session opened — including
  // one the PHONE started (T8). The id of the OPEN session, whoever started it; none once it is over.
  it("I-2: `session` names the fixture's OPEN session — the phone's own start and the organiser's Go live alike — and is null with none, and again once it ended", async () => {
    const r = await captureRig();
    expect((await readRig(r)).session, "no session ever").toBeNull();
    const a = phoneId("a");
    await beat(r, a, { claim: "new" });
    await saveStreamSettings(r.auth, r.fixtureId, { targetId: r.target.id });
    const { sid: phoneSid } = await postStart(r.code, r.tok, { phone: a }, r.deps, r.now());
    const [row] = await sql<{ start_cause: string }[]>`select start_cause from fixture_stream_sessions where id = ${phoneSid}`;
    expect(row!.start_cause, "PREMISE: the PHONE started it").toBe("operator");
    expect((await readRig(r)).session).toEqual({ id: phoneSid });
    expect((await readRig(r)).session, "a second read is the same").toEqual({ id: phoneSid });
    await sql`update fixture_stream_sessions set state = 'completed', end_reason = 'stopped', ended_at = now(), ending_at = now() where id = ${phoneSid}`;
    expect((await readRig(r)).session, "over: none").toBeNull();
    // The organiser's Go live, after it: the NEW session's id, never the ended one's.
    const sid = await r.start(phoneId("b"));
    expect(sid).not.toBe(phoneSid);
    expect((await readRig(r)).session).toEqual({ id: sid });
  });

  it("anti-vacuity: this file read the model and parsed every answer through the strict schema", () => {
    expect(reads).toBeGreaterThan(20);
  });
});

// =====================================================================================================================
// PR-2 T6 — the organiser read gains `auto`, `phone.health`, the debounced not-ready and the device model's survival.
//
// Expected values come from declarations — HEALTH_REASONS / config.ts's thresholds, AUTO_START_CONJUNCTS /
// AUTO_START_REFUSALS, PHONE_NOT_READY_SHOW_AFTER_SECONDS, the contract's CaptureNotReady — and from the rig's own clock and
// the beat bodies this file sends; never from stream-phone.ts. W9's priority (not responding, stalled, hot, battery low) is
// pinned LITERALLY in the ladder below: HEALTH_REASONS is the unit under test there, so an order derived from it could not
// notice a swap. Every table counts its rows and fails at zero.
// =====================================================================================================================
const SEC = 1000;
const NEVER = 3_600_000;
const C_MS = PHONE_NOT_READY_SHOW_AFTER_SECONDS * SEC;
/** The FP16 witness: the served reason and verdict, and the stretch's clock read from its COLUMN — `not_ready_since` on the
 *  slot's current pairing, aged on the rig's clock (final review I-1 dropped the served `notReadyForMs`, which no product code
 *  read). Null while no reason is served, or with no clock; unclamped, so a clock ahead of the rig reads negative. */
const nrOf = async (r: CaptureRig) => {
  const v = await readRig(r);
  const rows = await sql<{ not_ready_since: Date | null }[]>`
    select p.not_ready_since from fixture_stream_pairings p join fixture_stream_codes c on c.id = p.code_id
     where c.fixture_id = ${r.fixtureId} and c.ended_at is null and p.ended_at is null and p.slot = 0`;
  expect(rows.length, "PREMISE: at most one current pairing on the slot").toBeLessThanOrEqual(1);
  const since = rows[0]?.not_ready_since ?? null;
  const notReady = v.phone!.notReady;
  return { notReady, forMs: notReady === null || since === null ? null : r.now().getTime() - new Date(since).getTime(), shown: v.phone!.notReadyShown };
};
const lowBattery = (over: Partial<NonNullable<Beat["battery"]>> = {}) => ({ percent: LOW_BATTERY_PERCENT - 1, charging: false, drainPctPerHour: 6, ...over });
/** The cadence-derived not-responding point: NOT_RESPONDING_BEATS × the cadence the phone was last ANSWERED. */
const notRespondingMs = async (r: CaptureRig, phone: string) => NOT_RESPONDING_BEATS * (await pairingOf(r, phone)).answered_poll_seconds * SEC;

type SettingsRow = {
  auto_stream: boolean; auto_started_at: Date | null; auto_start_blocked_at: Date | null; auto_start_attempted_at: Date | null;
  auto_start_refusal: string | null;
};
const settingsOf = async (r: CaptureRig): Promise<SettingsRow> => {
  const [row] = await sql<SettingsRow[]>`
    select auto_stream, auto_started_at, auto_start_blocked_at, auto_start_attempted_at, auto_start_refusal
      from fixture_stream_settings where fixture_id = ${r.fixtureId}`;
  expect(row, "PREMISE: the fixture has a settings row").toBeDefined();
  return row!;
};

/** The T4 rig: credits, a paired phone on its operator-mode claim, the switch ON, the match in play. Nothing falsified. */
async function autoRig(opts: Parameters<typeof captureRig>[0] = {}) {
  const r = await captureRig({ credits: 3, connectAfterMs: NEVER, ...opts });
  const phone = phoneId("a");
  await beat(r, phone, { claim: "new", mode: "operator" });
  await saveStreamSettings(r.auth, r.fixtureId, { autoStream: true });
  await sql`update fixtures set status = 'in_play' where id = ${r.fixtureId}`;
  return { r, phone };
}
/** An automatic phone whose start was REFUSED for want of a credit: the refusal and the attempt are stored by the REAL beat. */
async function refusedRig() {
  const { r, phone } = await autoRig({ credits: 0 });
  await spendMonthlyStreamGrant(r.auth.orgId);
  await beat(r, phone, { mode: "automatic" });
  expect((await settingsOf(r)).auto_start_refusal, "PREMISE: the beat's start was refused no_credit").toBe("no_credit");
  return { r, phone };
}

describe.skipIf(!HAS_DB)("streamPhone — `auto` (PR-2 T6, §7.1)", () => {
  it("EMPTY then the sequence: no settings row → null (a code, a paired phone and a beat do not make one); a pick-only row → the switch OFF; the switch → on; a second read agrees each time", async () => {
    const r = await captureRig();
    await beat(r, phoneId("a"), { claim: "new", mode: "automatic" });
    expect((await readRig(r)).auto, "no settings row").toBeNull();
    expect((await readRig(r)).auto, "a second read").toBeNull();
    expect(await sql`select 1 from fixture_stream_settings where fixture_id = ${r.fixtureId}`, "the reads wrote no row").toHaveLength(0);
    await saveStreamSettings(r.auth, r.fixtureId, { targetId: r.target.id });
    // `stopApplies` is null throughout: no session is open (B7 review M-3).
    // Final review I-1: a fresh match latches nothing — `wontStart` null, the switch off and on alike.
    const off = { enabled: false, refusal: null, wontStart: null, stopApplies: null };
    expect((await readRig(r)).auto, "a row made by a destination pick has the switch off").toEqual(off);
    await saveStreamSettings(r.auth, r.fixtureId, { autoStream: true });
    const on = { ...off, enabled: true };
    expect((await readRig(r)).auto).toEqual(on);
    expect((await readRig(r)).auto, "a second read").toEqual(on);
  });

  it("wontStart names the latch from the real producers: an automatic start reads already_started (and refusal null although the attempt IS stamped); the organiser's Stop of it reads stopped — outranking the start (A12); a second read agrees", async () => {
    const { r, phone } = await autoRig();
    const answer = await beat(r, phone, { mode: "automatic" });
    expect(answer, "PREMISE: the beat started the broadcast").toMatchObject({ state: "go-live", startedBy: "automatic" });
    expect((await settingsOf(r)).auto_start_attempted_at, "PREMISE: the attempt is stamped, so a refusal read that ignored the stored code would see one").not.toBeNull();
    // B7 review M-3: the automatic start's own session — switch on, phone automatic, no result yet — will be stopped by §7.3.
    const started = { enabled: true, refusal: null, wontStart: "already_started", stopApplies: true };
    expect((await readRig(r)).auto).toEqual(started);
    expect((await readRig(r)).auto, "a second read").toEqual(started);
    expect((await settingsOf(r)).auto_started_at?.getTime(), "PREMISE: the latch is the column the start stamped").toBe(r.now().getTime());
    const sid = (answer as { sid: string }).sid;
    await stopSession(r.auth, r.fixtureId, sid, r.deps);
    const stopped = (await readRig(r)).auto!;
    expect(stopped.wontStart, "A12: the organiser's Stop turns auto START off for the match, and says so over the start").toBe("stopped");
    expect(stopped.enabled, "the switch stays as it was").toBe(true);
    expect((await settingsOf(r)).auto_started_at, "PREMISE: the start's latch still holds under the Stop's").not.toBeNull();
  });

  it("A12 with the switch NEVER touched: the organiser's Stop creates the row — blocked, switch off — and `auto` reads it (the row that chose nothing is still a row)", async () => {
    const r = await captureRig();
    const sid = await r.start(phoneId("a"));
    // The organiser's Go live writes the destination pick (a row); the Stop must be the ONLY thing that makes one here.
    await sql`delete from fixture_stream_settings where fixture_id = ${r.fixtureId}`;
    expect((await readRig(r)).auto, "PREMISE: no row before the Stop").toBeNull();
    await stopSession(r.auth, r.fixtureId, sid, r.deps);
    const after = await readRig(r);
    // B7 review M-3: the Stop closed the session (the fake ends it at once), so nothing is open for a stop to apply to.
    expect(after.session, "PREMISE: the stopped session is closed").toBeNull();
    expect(after.auto).toEqual({ enabled: false, refusal: null, wontStart: "stopped", stopApplies: null });
  });

  // B7 review M-3: `stopApplies` — the panel's "stops about N minutes after the result" is a promise about the session on air,
  // so it is the tick's own answer (same facts, same predicate), in each direction.
  it("stopApplies, the sequence: null with no open session; TRUE for the automatic start's session (switch on, phone automatic), still true once the result stands AFTER it; false with the phone switched to Operator, true back in Automatic; false with the switch off", async () => {
    const { r, phone } = await autoRig();
    expect((await readRig(r)).auto?.stopApplies, "no open session").toBeNull();
    const answer = await beat(r, phone, { mode: "automatic" });
    expect(answer, "PREMISE: the beat started the broadcast").toMatchObject({ state: "go-live", startedBy: "automatic" });
    expect((await readRig(r)).auto?.stopApplies, "the automatic start's session").toBe(true);
    await sql`update fixtures set status = 'decided' where id = ${r.fixtureId}`;
    const [{ predates }] = await sql<{ predates: boolean }[]>`
      select s.created_at < f.finished_at as predates from fixture_stream_sessions s join fixtures f on f.id = s.fixture_id
       where s.id = ${(answer as { sid: string }).sid}`;
    expect(predates, "PREMISE: the result stands, after the session began").toBe(true);
    expect((await readRig(r)).auto?.stopApplies, "a result after the session: the stop is coming").toBe(true);
    await beat(r, phone, { mode: "operator", sid: (answer as { sid: string }).sid, state: "publishing", transport: "srt" });
    expect((await readRig(r)).auto?.stopApplies, "the session's phone in Operator: no automatic stop (A4)").toBe(false);
    await beat(r, phone, { mode: "automatic", sid: (answer as { sid: string }).sid, state: "publishing", transport: "srt" });
    expect((await readRig(r)).auto?.stopApplies, "back in Automatic").toBe(true);
    await saveStreamSettings(r.auth, r.fixtureId, { autoStream: false });
    expect((await readRig(r)).auto?.stopApplies, "the switch off").toBe(false);
  });

  it("stopApplies is FALSE for A15's post-result broadcast — the switch on and the phone automatic, but the session was created after the result, so the tick never stops it", async () => {
    const { r, phone } = await autoRig();
    await sql`update fixtures set status = 'decided' where id = ${r.fixtureId}`;
    await beat(r, phone, { mode: "automatic" });   // no automatic start: the match is not in play
    expect((await readRig(r)).session, "PREMISE: the beat started nothing").toBeNull();
    const { sessionId } = await createSession(r.auth, r.fixtureId, { mode: "passthrough", targetId: r.target.id }, r.deps);
    const [{ predates }] = await sql<{ predates: boolean }[]>`
      select s.created_at < f.finished_at as predates from fixture_stream_sessions s join fixtures f on f.id = s.fixture_id where s.id = ${sessionId}`;
    expect(predates, "PREMISE: the session began after the result").toBe(false);
    const v = await readRig(r);
    expect([v.auto?.enabled, v.phone?.mode, v.session?.id], "PREMISE: the switch on, the phone automatic, the session open").toEqual([true, "automatic", sessionId]);
    expect(v.auto?.stopApplies).toBe(false);
  });

  // One scenario per code AUTO_START_REFUSALS declares — the T4 test's own arrangements, through the REAL beat.
  const scenarios: Record<AutoStartRefusal, { credits?: number; arrange: (r: CaptureRig) => Promise<void> }> = {
    no_credit: { credits: 0, arrange: async (r) => { await spendMonthlyStreamGrant(r.auth.orgId); } },
    not_entitled: { arrange: async (r) => { await override(r.auth.orgId, "streaming.relay", false); } },
    no_destination: { arrange: async (r) => { await sql`update org_stream_targets set archived_at = now() where id = ${r.target.id}`; } },
    destination_in_use: {
      arrange: async (r) => {
        const other = (await startedDivisionWithFixture(r.auth)).fixtureId;
        await pairPresentPhone(other, { at: r.now() });
        await createSession(r.auth, other, { mode: "passthrough", targetId: r.target.id }, r.deps);
      },
    },
    unavailable: { arrange: async (r) => { r.ingest.storage = { totalStorageMinutes: 1000, totalStorageMinutesLimit: 1000, videoCount: 0 }; } },
  };
  it("after a REFUSED automatic start the read serves the refusal's code — each code AUTO_START_REFUSALS declares; a refusal latches nothing (wontStart null); a second read agrees", async () => {
    let reached = 0;
    for (const code of AUTO_START_REFUSALS) {
      const sc = scenarios[code];
      const { r, phone } = await autoRig({ credits: sc.credits ?? 3 });
      await sc.arrange(r);
      await beat(r, phone, { mode: "automatic" });
      const want = { enabled: true, refusal: code, wontStart: null, stopApplies: null };
      expect((await readRig(r)).auto, code).toEqual(want);
      expect((await readRig(r)).auto, `${code}: a second read`).toEqual(want);
      reached++;
    }
    expect(reached).toBe(AUTO_START_REFUSALS.length);
    expect(reached).toBe(5);
  });

  // The B3 review: `auto_start_refusal` is not cleared by every path (an `already_running` start and an unmapped error leave the
  // earlier code in place), so the column alone can be STALE. The read serves it only while `autoStartVerdict` could still
  // pass — the predicate's own conjuncts, with the two a refusal is MEANT to outlast neutralised: the retry spacing (it is
  // inside that very window right after the refusal) and the phone's presence (a silent phone returns and the retry fires).
  const NEUTRALISED = ["phone_present", "retry_spacing"];
  /** Final review I-1, the owner's ruling (2026-10-08), LITERALLY: the three conjuncts that latch for the match, and the reason
   *  each serves — A12's Stop, A16's broadcast that ran, the once-per-match start. Never read from AUTO_START_LATCHES. */
  const LATCH_OF: Record<string, "stopped" | "already_streamed" | "already_started"> = {
    not_blocked: "stopped", no_broadcast_ran: "already_streamed", not_yet_started: "already_started",
  };
  type Ctx = { r: CaptureRig; phone: string; held: { sid?: string } };
  const falsifiers: Record<string, { falsify: (c: Ctx) => Promise<void>; restore: (c: Ctx) => Promise<void> }> = {
    switch_on: {
      falsify: async ({ r }) => { await sql`update fixture_stream_settings set auto_stream = false where fixture_id = ${r.fixtureId}`; },
      restore: async ({ r }) => { await sql`update fixture_stream_settings set auto_stream = true where fixture_id = ${r.fixtureId}`; },
    },
    phone_automatic: {   // the REAL producer: the phone's Settings flip rides its next beat (the stored mode lags one interval)
      falsify: async ({ r, phone }) => { await beat(r, phone, { mode: "operator" }); },
      restore: async ({ r, phone }) => { await beat(r, phone, { mode: "automatic" }); },
    },
    in_play: {
      falsify: async ({ r }) => { await sql`update fixtures set status = 'cancelled' where id = ${r.fixtureId}`; },
      restore: async ({ r }) => { await sql`update fixtures set status = 'in_play' where id = ${r.fixtureId}`; },
    },
    no_open_session: {
      falsify: async (c) => { c.held.sid = await sessionOnTarget(c.r.auth.orgId, c.r.fixtureId, c.r.target.id, "warming"); },
      restore: async (c) => { await sql`update fixture_stream_sessions set state = 'completed', end_reason = 'stopped', ended_at = now(), ending_at = now() where id = ${c.held.sid!}`; },
    },
    not_yet_started: {
      falsify: async ({ r }) => { await sql`update fixture_stream_settings set auto_started_at = now() where fixture_id = ${r.fixtureId}`; },
      restore: async ({ r }) => { await sql`update fixture_stream_settings set auto_started_at = null where fixture_id = ${r.fixtureId}`; },
    },
    not_blocked: {
      falsify: async ({ r }) => { await sql`update fixture_stream_settings set auto_start_blocked_at = now() where fixture_id = ${r.fixtureId}`; },
      restore: async ({ r }) => { await sql`update fixture_stream_settings set auto_start_blocked_at = null where fixture_id = ${r.fixtureId}`; },
    },
    no_broadcast_ran: {
      falsify: async (c) => {
        c.held.sid = await sessionOnTarget(c.r.auth.orgId, c.r.fixtureId, c.r.target.id, "completed");
        await sql`update fixture_stream_sessions set first_ingest_at = now() where id = ${c.held.sid}`;
      },
      restore: async (c) => { await sql`update fixture_stream_sessions set first_ingest_at = null where id = ${c.held.sid!}`; },
    },
  };
  it("a STALE refusal is never served: the column still says no_credit, yet with each predicate conjunct falsified alone the read serves none — wontStart names the latch exactly when that conjunct is one — and with it undone, the same rig serves it again", async () => {
    // The table is keyed to the predicate's own declaration: a conjunct added to AUTO_START_CONJUNCTS reds this until it has a row.
    expect(Object.keys(falsifiers).sort()).toEqual(AUTO_START_CONJUNCTS.map((c) => c.name).filter((n) => !NEUTRALISED.includes(n)).sort());
    let checked = 0;
    let latches = 0;
    for (const [conjunct, row] of Object.entries(falsifiers)) {
      const { r, phone } = await refusedRig();
      const c: Ctx = { r, phone, held: {} };
      const refused = (await readRig(r)).auto!;
      expect(refused, `${conjunct}: PREMISE — fresh, the refusal is served and nothing latches`).toMatchObject({ refusal: "no_credit", wontStart: null });
      await row.falsify(c);
      expect((await settingsOf(r)).auto_start_refusal, `${conjunct}: PREMISE — the column is still set, so only the read can hide it`).toBe("no_credit");
      const stale = (await readRig(r)).auto!;
      expect(stale.refusal, `${conjunct} falsified: a stale refusal is not served`).toBeNull();
      expect([stale.enabled, stale.wontStart], `${conjunct}: the switch reads its column; wontStart names the conjunct only if it latches`).toEqual([
        conjunct !== "switch_on", LATCH_OF[conjunct] ?? null,
      ]);
      if (LATCH_OF[conjunct] !== undefined) latches++;
      await row.restore(c);
      const back = (await readRig(r)).auto!;
      expect(back.refusal, `${conjunct} undone: the same rig serves the refusal again (the positive pair)`).toBe("no_credit");
      expect(back.wontStart, `${conjunct} undone: and nothing latches`).toBeNull();
      checked++;
    }
    expect(checked).toBe(AUTO_START_CONJUNCTS.length - NEUTRALISED.length);
    expect(checked).toBe(7);
    expect(latches, "each of the owner's three latches was falsified alone").toBe(3);
  });

  it("final review I-1, the PRECEDENCE: every combination of the three latches — stopped > already_streamed > already_started, null with none — served the same with the switch on and off", async () => {
    const { r } = await autoRig();
    const sid = await sessionOnTarget(r.auth.orgId, r.fixtureId, r.target.id, "completed");
    // The owner's precedence, written as the ruling reads (never from AUTO_START_LATCHES).
    const ruling = (l: { blocked: boolean; streamed: boolean; started: boolean }) =>
      l.blocked ? "stopped" : l.streamed ? "already_streamed" : l.started ? "already_started" : null;
    let checked = 0;
    const seen = new Set<string | null>();
    for (const blocked of [false, true]) {
      for (const streamed of [false, true]) {
        for (const started of [false, true]) {
          await sql`update fixture_stream_settings set auto_start_blocked_at = ${blocked ? r.now() : null},
                      auto_started_at = ${started ? r.now() : null} where fixture_id = ${r.fixtureId}`;
          await sql`update fixture_stream_sessions set first_ingest_at = ${streamed ? r.now() : null} where id = ${sid}`;
          const want = ruling({ blocked, streamed, started });
          for (const on of [true, false]) {
            await sql`update fixture_stream_settings set auto_stream = ${on} where fixture_id = ${r.fixtureId}`;
            const auto = (await readRig(r)).auto!;
            expect([auto.enabled, auto.wontStart], `blocked ${blocked}, streamed ${streamed}, started ${started}, switch ${on ? "on" : "off"}`).toEqual([on, want]);
            checked++;
          }
          seen.add(want);
        }
      }
    }
    expect(checked, "8 combinations × the switch on and off").toBe(16);
    expect([...seen].sort(), "anti-vacuity: every answer, and null, was reached").toEqual(["already_started", "already_streamed", "stopped", null].sort());
  });

  it("what a refusal is MEANT to outlast: a SILENT phone and a retry that is DUE both still serve it (the phone returns and the retry fires) — and the success that follows clears it", async () => {
    const { r, phone } = await refusedRig();
    const answered = (await pairingOf(r, phone)).answered_poll_seconds;
    r.tick(silentMs(answered) + SEC);
    const silent = await readRig(r);
    expect([silent.phone?.present, silent.phone?.silent], "PREMISE: the phone is silent now").toEqual([false, true]);
    expect(silent.auto, "silence and an elapsed retry spacing do not hide it").toMatchObject({ refusal: "no_credit" });
    expect(silentMs(answered) + SEC, "PREMISE: past the retry spacing too").toBeGreaterThanOrEqual(AUTO_START_RETRY_SECONDS * SEC);
    // The phone returns, a credit is bought, the retry is due: it starts, and the success clears the refusal.
    await grantCredits({ orgId: r.auth.orgId, delta: 1, createdBy: await rigUser(), note: "retry", idempotencyKey: randomUUID() });
    await beat(r, phone, { mode: "automatic" });
    const done = await readRig(r);
    expect(done.auto, "started: no refusal, and the start latches (once per match)").toEqual({
      enabled: true, refusal: null, wontStart: "already_started", stopApplies: true,
    });
    expect((await settingsOf(r)).auto_started_at?.getTime(), "at the retry's instant").toBe(r.now().getTime());
    expect(done.session, "PREMISE: a session opened").not.toBeNull();
  });

  it("the sequence a real organiser takes: refused no_credit → credit bought → manual Go live → manual Stop: no stale strip at the Go live (a session is open) and none after the Stop (A12 blocked it)", async () => {
    const { r } = await refusedRig();
    await grantCredits({ orgId: r.auth.orgId, delta: 1, createdBy: await rigUser(), note: "manual", idempotencyKey: randomUUID() });
    const { sessionId } = await createSession(r.auth, r.fixtureId, { mode: "passthrough", targetId: r.target.id }, r.deps);
    const live = await readRig(r);
    expect([live.session?.id, live.auto?.refusal], "a session is open").toEqual([sessionId, null]);
    await stopSession(r.auth, r.fixtureId, sessionId, r.deps);
    const after = (await readRig(r)).auto!;
    expect([after.wontStart, after.refusal], "A12 blocked it, and the read says so").toEqual(["stopped", null]);
  });

  it("NO PAIRING (after a reissue, or an ended pairing) hides a stored refusal — there is no automatic phone to start for; the column is untouched, and the phone's claim on the new code brings the strip back", async () => {
    const { r, phone } = await refusedRig();
    expect((await readRig(r)).auto?.refusal, "PREMISE: served while the phone is paired").toBe("no_credit");
    const fresh = await reissueStreamCode(r.auth, r.fixtureId);
    const reissued = await readRig(r);
    expect(reissued.phone, "PREMISE: only a claim on the NEW code pairs a phone").toBeNull();
    expect(reissued.auto?.refusal, "no phone, no automatic phone: hidden").toBeNull();
    expect([reissued.auto?.enabled, (await settingsOf(r)).auto_start_refusal], "the switch is still on and the column still set: only the read hides it").toEqual([true, "no_credit"]);
    r.tick(SEC);
    await beat(r, phone, { claim: "new", mode: "automatic" }, { code: fresh.qr.code, tok: fresh.qr.tok });
    expect((await readRig(r)).auto?.refusal, "the positive pair: the phone is back").toBe("no_credit");
    // The same by an ended pairing (no reissue): the code is the phone's but its pairing is over.
    await sql`update fixture_stream_pairings set ended_at = ${r.now()}, end_cause = 'code_ended' where id = ${(await pairingOf(r, phone)).id}`;
    const ended = await readRig(r);
    expect([ended.phone, ended.auto?.refusal], "an ended pairing is no phone").toEqual([null, null]);
  });

  it("another sport (cricket): the read is the same — a refusal is served", async () => {
    const { r, phone } = await autoRig({ sport: "cricket", credits: 0 });
    await spendMonthlyStreamGrant(r.auth.orgId);
    await beat(r, phone, { mode: "automatic" });
    expect((await readRig(r)).auto).toMatchObject({ enabled: true, refusal: "no_credit" });
  });
});

describe.skipIf(!HAS_DB)("streamPhone — `phone.health` (PR-2 T6, §7.4: ONE derivation, phone-health.ts)", () => {
  type Ctx = { r: CaptureRig; a: string; sid: string };
  type Drive = { cause: (c: Ctx) => Promise<void>; defuse: (c: Ctx) => Promise<void> };
  const drives: Record<HealthReason, Drive> = {
    stalled: {
      cause: async ({ r, a }) => { await beat(r, a, { claim: "new", state: "armed", delivery: "stalled" }); },
      defuse: async ({ r, a }) => { r.tick(SEC); await beat(r, a, { state: "armed", delivery: "ok" }); },
    },
    hot: {
      cause: async ({ r, a }) => { await beat(r, a, { claim: "new", state: "armed", thermal: HOT_THERMAL_STATUS }); },
      defuse: async ({ r, a }) => { r.tick(SEC); await beat(r, a, { state: "armed", thermal: HOT_THERMAL_STATUS - 1 }); },
    },
    battery_low: {
      cause: async ({ r, a }) => { await beat(r, a, { claim: "new", state: "armed", battery: lowBattery() }); },
      defuse: async ({ r, a }) => { r.tick(SEC); await beat(r, a, { state: "armed", battery: lowBattery({ percent: LOW_BATTERY_PERCENT }) }); },
    },
    not_responding: {
      cause: async (c) => {
        c.sid = await c.r.start(c.a);
        await beat(c.r, c.a, { sid: c.sid, state: "connecting" });   // the session's phone, naming it: answered at an open session's cadence
        c.r.tick(await notRespondingMs(c.r, c.a));
      },
      defuse: async (c) => { await beat(c.r, c.a, { sid: c.sid, state: "connecting" }); },
    },
  };
  it("each reason HEALTH_REASONS declares, driven by the beat (or the silence) that causes it: served; a second read agrees; defused (the boundary neighbour, a clear beat) → null", async () => {
    let checked = 0;
    for (const reason of HEALTH_REASONS) {
      const r = await captureRig({ connectAfterMs: NEVER });
      const c: Ctx = { r, a: phoneId("a"), sid: "" };
      await drives[reason].cause(c);
      expect((await readRig(r)).phone?.health, reason).toBe(reason);
      expect((await readRig(r)).phone?.health, `${reason}: a second read`).toBe(reason);
      await drives[reason].defuse(c);
      expect((await readRig(r)).phone?.health, `${reason} defused`).toBeNull();
      checked++;
    }
    expect(checked).toBe(HEALTH_REASONS.length);
    expect(checked).toBe(4);
  });

  it("W9's PRIORITY (not responding, stalled, hot, battery low), pinned literally: each rung wins while every rung below it also holds, and removing it reveals the next", async () => {
    const r = await captureRig({ connectAfterMs: NEVER });
    const a = phoneId("a");
    const sid = await r.start(a);
    const allWrong = { sid, state: "connecting", delivery: "stalled", thermal: HOT_THERMAL_STATUS, battery: lowBattery() } as const;
    const healthNow = async () => (await readRig(r)).phone?.health;
    const ladder: [string, Partial<Beat>, HealthReason | null][] = [
      ["stalled + hot + battery low", allWrong, "stalled"],
      ["hot + battery low", { ...allWrong, delivery: "ok" }, "hot"],
      ["battery low alone", { ...allWrong, delivery: "ok", thermal: HOT_THERMAL_STATUS - 1 }, "battery_low"],
      ["nothing wrong", { ...allWrong, delivery: "ok", thermal: HOT_THERMAL_STATUS - 1, battery: lowBattery({ percent: LOW_BATTERY_PERCENT }) }, null],
    ];
    let checked = 0;
    for (const [what, over, want] of ladder) {
      r.tick(SEC);
      await beat(r, a, over);
      expect(await healthNow(), what).toBe(want);
      checked++;
    }
    // The top rung: the same three problems on the last beat, then silence for NOT_RESPONDING_BEATS cadences.
    r.tick(SEC);
    await beat(r, a, allWrong);
    const nr = await notRespondingMs(r, a);
    r.tick(nr - 1);
    expect(await healthNow(), "1 ms before not-responding the beat's own worst problem wins").toBe("stalled");
    r.tick(1);
    expect(await healthNow(), "not responding outranks stalled, hot and battery low at once").toBe("not_responding");
    checked += 2;
    expect(checked).toBe(6);
  });

  it("FP14: a Paired-phase beat (battery, thermal, bitrate all null) is health null with nothing invented — null stays null, never 0 — and a beat with no stored shape reads all-null too", async () => {
    const r = await captureRig();
    const a = phoneId("a");
    await beat(r, a, { claim: "new", state: "paired", battery: null, thermal: null, bitrateKbps: null, delivery: "unknown" });
    const paired = await readRig(r);
    expect(paired.phone?.health).toBeNull();
    expect(paired.phone?.beat).toEqual({ battery: null, bitrateKbps: null, delivery: "unknown", thermal: null, dataUsedMB: null });
    expect((await readRig(r)).phone?.health, "a second read").toBeNull();
    // From Armed the readings arrive — healthy ones are still health null (the positive pair for the readings).
    r.tick(SEC);
    await beat(r, a, { state: "armed", battery: { percent: 80, charging: false, drainPctPerHour: 3 }, thermal: 1, delivery: "ok" });
    const armed = await readRig(r);
    expect([armed.phone?.health, armed.phone?.beat.battery?.percent, armed.phone?.beat.thermal]).toEqual([null, 80, 1]);
    // A pairing whose stored beat is gone (an older shape, or none yet): all-null, health null.
    await sql`update fixture_stream_pairings set last_beat = null where id = ${(await pairingOf(r, a)).id}`;
    const none = await readRig(r);
    expect([none.phone?.health, none.phone?.beat.battery, none.phone?.beat.thermal, none.phone?.beat.bitrateKbps]).toEqual([null, null, null, null]);
  });

  it("I1 (P1): a SILENT phone that is not held serves no stale verdict — health null and notReadyShown false — while the beat's own readings, notReady and elapsedMs stay served; one tick before silence the same phone still shows them (the positive pair)", async () => {
    const r = await captureRig();
    const a = phoneId("a");
    const wrong = { state: "armed", thermal: HOT_THERMAL_STATUS, battery: lowBattery({ percent: 10 }), notReady: "sound" } as const;
    await beat(r, a, { claim: "new", ...wrong });
    r.tick(C_MS);
    await beat(r, a, wrong);   // a second beat a constant later: the reason is confirmed
    const answered = (await pairingOf(r, a)).answered_poll_seconds;
    const before = await readRig(r);
    expect([before.phone?.silent, before.phone?.health, before.phone?.notReadyShown], "PREMISE: fresh, it shows both").toEqual([false, "hot", true]);
    r.tick(silentMs(answered) - 1);
    const edge = await readRig(r);
    expect([edge.phone?.silent, edge.phone?.health, edge.phone?.notReadyShown], "1 ms before silence").toEqual([false, "hot", true]);
    r.tick(1);
    const silent = await readRig(r);
    expect([silent.phone?.silent, silent.phone?.present, silent.phone?.notResponding], "PREMISE: silent now, not held").toEqual([true, false, false]);
    expect([silent.phone?.health, silent.phone?.notReadyShown], "no stale verdict from a phone that stopped talking").toEqual([null, false]);
    r.tick(600 * SEC);
    const later = await readRig(r);
    expect([later.phone?.health, later.phone?.notReadyShown], "and at +600 s").toEqual([null, false]);
    expect(later.phone?.beat, "the raw readings are still served").toMatchObject({ thermal: HOT_THERMAL_STATUS, battery: { percent: 10, charging: false } });
    expect([later.phone?.notReady, later.phone?.elapsedMs, (await nrOf(r)).forMs !== null], "and the reason, how long ago it spoke, and the clock").toEqual([
      "sound", silentMs(answered) + 600 * SEC, true,
    ]);
    await beat(r, a, wrong);   // the phone speaks again: the readings are fresh, the stretch is still the old one
    const back = await readRig(r);
    expect([back.phone?.silent, back.phone?.health, back.phone?.notReadyShown], "a beat makes them fresh again").toEqual([false, "hot", true]);
  });

  it("I1, each reading alone: stalled, hot and a low battery each name the phone while it is fresh and name nothing once it is silent — the three readings are each withheld, not just the loudest", async () => {
    const alone: Record<Exclude<HealthReason, "not_responding">, Partial<Beat>> = {
      stalled: { delivery: "stalled" },
      hot: { thermal: HOT_THERMAL_STATUS },
      battery_low: { battery: lowBattery() },
    };
    let checked = 0;
    for (const [reason, reading] of Object.entries(alone) as [keyof typeof alone, Partial<Beat>][]) {
      const r = await captureRig();
      const a = phoneId("a");
      await beat(r, a, { claim: "new", state: "armed", ...reading });
      const answered = (await pairingOf(r, a)).answered_poll_seconds;
      r.tick(silentMs(answered) - 1);
      expect((await readRig(r)).phone?.health, `${reason}: 1 ms before silence`).toBe(reason);
      r.tick(1);
      const silent = await readRig(r);
      expect([silent.phone?.silent, silent.phone?.health], `${reason}: silent`).toEqual([true, null]);
      checked++;
    }
    expect(checked).toBe(HEALTH_REASONS.length - 1);
    expect(checked).toBe(3);
  });

  it("I1 control: a HELD phone that goes silent still serves not_responding (W8 is a silence verdict, not a stale reading) — and still no stale hot, stalled or battery", async () => {
    const r = await captureRig({ connectAfterMs: NEVER });
    const a = phoneId("a");
    const sid = await r.start(a);
    await beat(r, a, { sid, state: "connecting", delivery: "stalled", thermal: HOT_THERMAL_STATUS, battery: lowBattery() });
    expect((await readRig(r)).phone?.health, "PREMISE: fresh, the worst reading wins").toBe("stalled");
    r.tick(600 * SEC);
    const v = await readRig(r);
    expect([v.phone?.silent, v.phone?.notResponding], "PREMISE: held, silent, not responding").toEqual([true, true]);
    expect(v.phone?.health).toBe("not_responding");
  });

  it("another sport (cricket): a hot phone reads hot", async () => {
    const r = await captureRig({ sport: "cricket" });
    await beat(r, phoneId("a"), { claim: "new", state: "armed", thermal: HOT_THERMAL_STATUS });
    expect((await readRig(r)).phone?.health).toBe("hot");
  });
});

describe.skipIf(!HAS_DB)("streamPhone — the debounced not-ready (PR-2 T6, FP16, owner ruling R-2)", () => {
  it("PREMISE: the constant is the owner's 20 s and the arithmetic below has room", () => {
    expect(PHONE_NOT_READY_SHOW_AFTER_SECONDS).toBe(20);
    expect(C_MS).toBeGreaterThan(4 * SEC);
  });

  it("(a) a FLAP shorter than the constant never shows: every non-null stretch is constant − 1 s, each declared reason in turn, twice round — read just before the clearing beat and just after it", async () => {
    const r = await captureRig();
    const a = phoneId("a");
    await beat(r, a, { claim: "new" });
    const reasons = CaptureNotReady.options;
    let checked = 0;
    for (let i = 0; i < reasons.length * 2; i++) {
      const reason = reasons[i % reasons.length]!;
      await beat(r, a, { notReady: reason });
      r.tick(C_MS - SEC);
      expect((await nrOf(r)), `${reason}: C − 1 s into the stretch`).toEqual({ notReady: reason, forMs: C_MS - SEC, shown: false });
      await beat(r, a, { notReady: null });
      expect((await nrOf(r)), `${reason}: cleared`).toEqual({ notReady: null, forMs: null, shown: false });
      r.tick(SEC);
      checked += 2;
    }
    expect(checked).toBe(reasons.length * 2 * 2);
  });

  // A scripted 40-beat trace in the SHAPE staging showed (27 sound / 11 held / 3 camera flips in ten minutes): the same mix,
  // beats every half-constant, a run of two not-ready beats then a clear, then one then a clear. R-2's "about 2 beats": the
  // line is BEAT-CONFIRMED, shown only once a beat at least the constant after the stretch began still says not ready — so
  // two beats half a constant apart never confirm it, and nor does any amount of waiting between beats.
  const MIX: (typeof CaptureNotReady.options)[number][] = [
    "sound", "sound", "held", "sound", "camera", "sound", "held", "sound", "sound", "held", "sound", "sound",
    "held", "sound", "sound", "camera", "held", "sound", "sound", "held", "sound", "sound", "sound", "sound",
  ];
  it("(a) a scripted 40-beat staging-shaped trace never shows — 79 reads, every one false — and its positive twin on the same rig (a third beat a constant after the first) shows", async () => {
    const r = await captureRig();
    const a = phoneId("a");
    const GAP = C_MS / 2;
    expect([...new Set(MIX)].sort(), "PREMISE: the three reasons staging showed").toEqual(["camera", "held", "sound"]);
    for (const reason of new Set(MIX)) expect(CaptureNotReady.options, `PREMISE: ${reason} is a declared reason`).toContain(reason);
    let mix = 0;
    let beats = 0;
    let checked = 0;
    let sinceAt: number | null = null;
    let longestRun = 0;   // first not-ready beat to the last one of its run
    for (let idx = 0; idx < 40; idx++) {
      const unit = idx % 5;
      const reason = unit === 2 || unit === 4 ? null : MIX[mix++]!;
      if (idx > 0) {
        r.tick(GAP - 1);
        const before = (await nrOf(r));
        expect(before.shown, `beat ${idx}: just before it`).toBe(false);
        expect(before.forMs, `beat ${idx}: just before it`).toBe(sinceAt === null ? null : r.now().getTime() - sinceAt);
        checked++;
        r.tick(1);
      }
      await beat(r, a, idx === 0 ? { claim: "new", notReady: reason } : { notReady: reason });
      beats++;
      sinceAt = reason === null ? null : sinceAt ?? r.now().getTime();
      if (sinceAt !== null) longestRun = Math.max(longestRun, r.now().getTime() - sinceAt);
      const after = (await nrOf(r));
      expect(after.shown, `beat ${idx}: just after it`).toBe(false);
      expect(after.forMs, `beat ${idx}: just after it`).toBe(sinceAt === null ? null : r.now().getTime() - sinceAt);
      checked++;
    }
    expect([beats, mix, checked]).toEqual([40, MIX.length, 79]);
    expect(longestRun, "the longest run the script held: two beats, half a constant apart").toBe(GAP);
    expect(longestRun, "PREMISE: short of the constant, so no beat could confirm it").toBeLessThan(C_MS);
    // The twin: the run reaches a beat a constant after its first and it shows (the trace's machinery is not vacuous).
    await beat(r, a, { notReady: "sound" });
    r.tick(GAP);
    await beat(r, a, { notReady: "held" });
    expect((await nrOf(r)), "two beats, half a constant apart").toEqual({ notReady: "held", forMs: GAP, shown: false });
    r.tick(GAP);
    await beat(r, a, { notReady: "held" });
    expect((await nrOf(r)), "a third, a constant after the first").toEqual({ notReady: "held", forMs: C_MS, shown: true });
  });

  it("I2 (far cadence): ONE beat saying not ready is a single sighting — it is not shown at +the constant, nor at the cadence's last instant; the second beat, a cadence later, confirms it", async () => {
    const r = await captureRig();
    const a = phoneId("a");
    await beat(r, a, { claim: "new", notReady: "sound" });
    const answered = (await pairingOf(r, a)).answered_poll_seconds;
    expect(answered, "PREMISE (§6.6): no session, no scheduled start near — the far cadence").toBe(POLL_FAR_SECONDS);
    expect(answered * SEC, "PREMISE: the next beat is more than a constant away").toBeGreaterThan(C_MS);
    expect(answered * SEC, "PREMISE: and the phone is not yet silent at its next beat").toBeLessThan(silentMs(answered));
    r.tick(C_MS);
    expect((await nrOf(r)), "+ the constant, one sighting").toEqual({ notReady: "sound", forMs: C_MS, shown: false });
    r.tick(answered * SEC - C_MS - 1);
    expect((await nrOf(r)), "the cadence's last instant: the wall clock is far past the constant").toEqual({ notReady: "sound", forMs: answered * SEC - 1, shown: false });
    r.tick(1);
    await beat(r, a, { notReady: "held" });
    expect((await nrOf(r)), "the second beat, a cadence later, still not ready").toEqual({ notReady: "held", forMs: answered * SEC, shown: true });
  });

  it("(b) a hold is confirmed by the first beat at least the constant after it began — one ms short is not enough, exactly the constant is; a change of reason keeps the clock; nothing ages between beats; (c) a clear hides at once and the next reason is a FRESH clock", async () => {
    const r = await captureRig();
    const a = phoneId("a");
    await beat(r, a, { claim: "new", notReady: "camera" });   // FP16: it reads "camera" before the first reading
    expect((await nrOf(r)), "the instant it begins").toEqual({ notReady: "camera", forMs: 0, shown: false });
    r.tick(C_MS / 4);
    await beat(r, a, { notReady: "sound" });   // the reason changes inside the hold
    expect((await nrOf(r)), "a change of reason keeps the clock").toEqual({ notReady: "sound", forMs: C_MS / 4, shown: false });
    r.tick(C_MS - C_MS / 4 - 1);
    await beat(r, a, { notReady: "sound" });
    expect((await nrOf(r)), "a beat one ms short of the constant").toEqual({ notReady: "sound", forMs: C_MS - 1, shown: false });
    r.tick(C_MS / 4);
    const aged = (await nrOf(r));
    expect(aged.forMs, "PREMISE: the wall clock is now past the constant").toBeGreaterThan(C_MS);
    expect(aged.shown, "…and no beat confirmed it, so a read between beats does not age into shown").toBe(false);
    // The next beat finds it still not ready, more than the constant after it began: now it is confirmed.
    await beat(r, a, { notReady: "sound" });
    expect((await nrOf(r)), "a beat that finds it still not ready, a constant+ after it began").toEqual({ notReady: "sound", forMs: C_MS - 1 + C_MS / 4, shown: true });
    expect((await nrOf(r)), "a second read").toEqual({ notReady: "sound", forMs: C_MS - 1 + C_MS / 4, shown: true });
    r.tick(SEC);
    expect((await nrOf(r)).shown, "and it stays shown while the phone keeps talking").toBe(true);
    // (c) the clear.
    await beat(r, a, { notReady: null });
    expect((await nrOf(r)), "the very next read").toEqual({ notReady: null, forMs: null, shown: false });
    r.tick(SEC);
    await beat(r, a, { notReady: "held" });
    expect((await nrOf(r)), "a fresh clock, not the old one").toEqual({ notReady: "held", forMs: 0, shown: false });
    r.tick(C_MS - 1);
    await beat(r, a, { notReady: "held" });
    expect((await nrOf(r)), "the old clock would have confirmed it long ago").toEqual({ notReady: "held", forMs: C_MS - 1, shown: false });
    r.tick(1);
    await beat(r, a, { notReady: "held" });
    expect((await nrOf(r)), "a beat exactly the constant after the fresh stretch began").toEqual({ notReady: "held", forMs: C_MS, shown: true });
  });

  it("guards on the stored facts: a row from before V431 (not-ready but no clock) hides the line; a clock in the future is never shown; a clock with no reason reads nothing — and the next beat repairs the first", async () => {
    const r = await captureRig();
    const a = phoneId("a");
    await beat(r, a, { claim: "new", notReady: "network" });
    const id = (await pairingOf(r, a)).id;
    await sql`update fixture_stream_pairings set not_ready_since = null where id = ${id}`;
    expect((await nrOf(r)), "legacy: no clock, no line").toEqual({ notReady: "network", forMs: null, shown: false });
    r.tick(SEC);
    await beat(r, a, { notReady: "network" });
    expect((await nrOf(r)), "the next beat starts the clock").toEqual({ notReady: "network", forMs: 0, shown: false });
    await sql`update fixture_stream_pairings set not_ready_since = now() + interval '1 hour' where id = ${id}`;
    expect((await nrOf(r)), "skew: a clock ahead of the beats is never shown").toMatchObject({ notReady: "network", shown: false });
    await sql`update fixture_stream_pairings set not_ready = null, not_ready_since = ${new Date(r.now().getTime() - 5 * C_MS)} where id = ${id}`;
    expect((await nrOf(r)), "a clock with no reason is not a hold").toEqual({ notReady: null, forMs: null, shown: false });
  });

  it("`notReady` never gates an automatic start: the T4 start case with notReady \"camera\" on the arriving beat still starts, and the answer is go-live", async () => {
    const { r, phone } = await autoRig();
    const answer = await beat(r, phone, { mode: "automatic", notReady: "camera" });
    expect(answer).toMatchObject({ state: "go-live", startedBy: "automatic" });
    const v = await readRig(r);
    expect(v.auto?.wontStart, "started: once per match").toBe("already_started");
    expect(v.phone?.notReady, "PREMISE: and the phone is reporting not ready").toBe("camera");
  });
});

describe.skipIf(!HAS_DB)("streamPhone — the device model survives the beats that carry none (PR-2 T6, FP15)", () => {
  it("claim with a model, then three beats with device null, a `resume` with none, and a SAME-phone `new` claim with a new model: the model is kept, kept, kept, then replaced", async () => {
    const r = await captureRig();
    const a = phoneId("a");
    const model = async () => (await readRig(r)).phone?.model;
    await beat(r, a, { claim: "new", device: { model: "Pixel 8" } });
    expect(await model()).toBe("Pixel 8");
    for (let i = 1; i <= 3; i++) {
      r.tick(SEC);
      await beat(r, a, { device: null });
      expect(await model(), `beat ${i} carries device null`).toBe("Pixel 8");
    }
    r.tick(SEC);
    await beat(r, a, { claim: "resume", device: null });
    expect(await model(), "a resume claim with no device keeps it").toBe("Pixel 8");
    r.tick(SEC);
    await beat(r, a, { claim: "new", device: { model: "Pixel 9" } });
    expect(await model(), "a new claim with a model replaces it").toBe("Pixel 9");
    r.tick(SEC);
    await beat(r, a, { device: null });
    expect(await model(), "and that one is kept in turn").toBe("Pixel 9");
  });

  it("a takeover: lastTakeover.model is the TAKING phone's and stays so through its null-device beats and its own `ended` beat (the final beat sends none); the stored column agrees", async () => {
    const r = await captureRig();
    const a = phoneId("a");
    const b = phoneId("b");
    await beat(r, a, { claim: "new", device: { model: "Phone A" } });
    r.tick(SEC);
    await beat(r, b, { claim: "new", device: { model: "Galaxy S24" } });   // T2: B takes the paired slot
    for (let i = 1; i <= 3; i++) {
      r.tick(SEC);
      await beat(r, b, { device: null });
      const v = await readRig(r);
      expect([v.phone?.model, v.lastTakeover?.model], `B's beat ${i} carries device null`).toEqual(["Galaxy S24", "Galaxy S24"]);
    }
    const sid = await r.start(b);
    await beat(r, b, { sid, state: "ended", endReason: "operator-stopped", device: null });
    expect((await pairingOf(r, b)).end_cause, "PREMISE: the final beat ended B's pairing").toBe("operator_stopped");
    const [{ device_model }] = await sql<{ device_model: string | null }[]>`select device_model from fixture_stream_pairings where id = ${(await pairingOf(r, b)).id}`;
    expect(device_model, "the column survived the final beat").toBe("Galaxy S24");
    const after = await readRig(r);
    expect(after.phone, "PREMISE: the Stop left no phone").toBeNull();
    expect(after.lastTakeover?.model, "and the takeover notice still names B's model").toBe("Galaxy S24");
  });

  it("startFailed (FP17, PR-1's): set by a beat, cleared by the next beat that sends null", async () => {
    const r = await captureRig();
    const a = phoneId("a");
    await beat(r, a, { claim: "new", startFailed: "config" });
    expect((await readRig(r)).phone?.startFailed).toBe("config");
    r.tick(SEC);
    await beat(r, a, { startFailed: null });
    expect((await readRig(r)).phone?.startFailed).toBeNull();
  });
});

// PR-2 T12 (§7.5): the takeover notice shows for 30 min after the takeover, judged on the SERVER's clock (the D3 M6 rule) —
// the read model serves the takeover's age, `now − at`, so the panel never compares its own clock with a server stamp.
// Expected values are the rig's own ticks (the declared clock), never read back from stream-phone.ts.
describe.skipIf(!HAS_DB)("streamPhone — lastTakeover.elapsedMs on the server's clock (PR-2 T12)", () => {
  const NOTICE_MS = 30 * MIN; // §7.5's "for 30 min"
  it("EMPTY: one phone, no takeover → null; then a takeover → elapsedMs 0 at once, 29:59 at 30 min − 1 s, 30:00 at 30 min, a second read the same", async () => {
    const r = await captureRig();
    const a = phoneId("a");
    const b = phoneId("b");
    await beat(r, a, { claim: "new", device: { model: "Phone A" } });
    expect((await readRig(r)).lastTakeover, "the empty case: no takeover yet").toBeNull();
    r.tick(SEC);
    await beat(r, b, { claim: "new", device: { model: "Phone B" } });
    expect((await pairingOf(r, a)).end_cause, "PREMISE: A was replaced").toBe("replaced");
    expect((await readRig(r)).lastTakeover?.elapsedMs, "the read at the takeover's own instant").toBe(0);
    const checks: [number, number][] = [[NOTICE_MS - SEC, NOTICE_MS - SEC], [SEC, NOTICE_MS], [0, NOTICE_MS], [5 * MIN, NOTICE_MS + 5 * MIN]];
    let checked = 0;
    for (const [step, want] of checks) {
      r.tick(step);
      // B keeps beating (fresh) — the age is the TAKEOVER's, not the last beat's.
      if (step > 0) await beat(r, b, { device: null });
      const v = await readRig(r);
      expect(v.lastTakeover?.elapsedMs, `${want} ms after the takeover`).toBe(want);
      expect(v.phone?.elapsedMs, "and the beat's own age is its own").toBe(0);
      checked++;
    }
    expect(checked).toBe(checks.length);
  });

  it("a SECOND takeover restarts the age (the latest one is served); a takeover stamped in the future (skew) reads 0, never negative", async () => {
    const r = await captureRig();
    const [a, b, c] = [phoneId("a"), phoneId("b"), phoneId("c")];
    await beat(r, a, { claim: "new", device: { model: "Phone A" } });
    r.tick(SEC);
    await beat(r, b, { claim: "new", device: { model: "Phone B" } });
    r.tick(10 * MIN);
    expect((await readRig(r)).lastTakeover?.elapsedMs).toBe(10 * MIN);
    await beat(r, c, { claim: "new", device: { model: "Phone C" } });
    r.tick(2 * SEC);
    const second = await readRig(r);
    expect([second.lastTakeover?.model, second.lastTakeover?.elapsedMs], "the newest takeover, aged from ITS instant").toEqual(["Phone C", 2 * SEC]);
    // Skew: the stored instant moved past the server's clock (a clock that stepped back). The age clamps at 0.
    await sql`update fixture_stream_pairings set ended_at = ${new Date(r.now().getTime() + MIN)}
               where id = ${(await pairingOf(r, b)).id}`;
    expect((await readRig(r)).lastTakeover?.elapsedMs, "a future instant reads 0").toBe(0);
  });
});

describe.skipIf(!HAS_DB)("anti-vacuity (PR-2 T6)", () => {
  it("the T6 blocks read the model and parsed every answer through the strict schema", () => {
    expect(reads, "239 reads when written: the file's PR-1 blocks make ~60, the T6 blocks the rest").toBeGreaterThan(200);
  });
});
