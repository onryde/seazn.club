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
import { CaptureBeat } from "@/server/api-v1/capture-schemas";
import { StreamPhone } from "@/server/api-v1/schemas";
import {
  CODE_GRACE_AFTER_FINISH_MINUTES, NOT_RESPONDING_BEATS, PHONE_SILENT_FLOOR_SECONDS, PHONE_SILENT_SLACK_SECONDS,
} from "@/server/relay/config";
import { readFirstInput } from "@/server/relay/secret-columns";
import { rigUser } from "@/server/relay/__tests__/_session-rig";
import { getCode, postBeat } from "../capture-phone";
import { reissueStreamCode, saveStreamSettings } from "../stream-codes";
import { createSession } from "../stream-sessions";
import { createStreamTarget } from "../stream-targets";
import { streamPhone } from "../stream-phone";
import { captureRig, phoneId, type CaptureRig } from "./_capture-rig";
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
    const empty = { code: null, phone: null, destination: null, lastTakeover: null, auto: null };
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
    });
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
    expect(v.lastTakeover).toEqual({ at: tookAt.toISOString(), model: "Phone B" });
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
    expect((await readRig(r)).phone).toBeNull();
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
    await sql`update fixture_stream_sessions set pairing_id = null where id = ${sid}`;
    const legacy = await readRig(r);
    expect(legacy.phone, "no phone facts").toBeNull();
    expect(legacy.lastTakeover, "no takeover").toBeNull();
    expect(legacy.code?.state).toBe("active");
    expect(legacy.destination).toEqual({ id: r.target.id, label: r.target.label });
  });

  it("T36: the pre-pick reads {id, label}; ARCHIVED in Directory it reads as none; cleared, none", async () => {
    const r = await captureRig({ targetLabel: "Court 1 YouTube" });
    expect((await readRig(r)).destination, "no pick yet").toBeNull();
    await saveStreamSettings(r.auth, r.fixtureId, { targetId: r.target.id });
    expect((await readRig(r)).destination).toEqual({ id: r.target.id, label: "Court 1 YouTube" });
    await sql`update org_stream_targets set archived_at = now() where id = ${r.target.id}`;
    expect((await readRig(r)).destination, "archived reads as none").toBeNull();
  });

  it("NO SECRET: the answer carries neither the tok nor its hash, no `cred` value the descriptor serves, and no destination stream key", async () => {
    const r = await captureRig();
    const key = `yt-secret-${randomUUID()}`;
    const target = await createStreamTarget(r.auth, r.auth.orgId, { kind: "youtube", label: "Keyed", streamKey: key });
    await saveStreamSettings(r.auth, r.fixtureId, { targetId: target.id });
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
    const b = await captureRig();
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
    expect((await readRig(a)).phone?.present, "the positive pair: its own organiser reads it").toBe(true);
  });

  it("anti-vacuity: this file read the model and parsed every answer through the strict schema", () => {
    expect(reads).toBeGreaterThan(20);
  });
});
