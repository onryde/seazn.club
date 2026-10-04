// Capture QR v2 §6.3.2 / §6.3.3 / §6.5 / §6.8.2 / §6.10 (T8b) — the phone's beat, `postBeat`, DB-backed through the REAL
// code (ensureStreamCode), the REAL organiser start, the REAL reissue and FAKE drivers on the rig's tickable clock.
//
// One case per transition row: the claims T1–T8 (T4 with each A14 conjunct alone), the concurrency of two claims, the
// stops T21–T24a (and T24a's positive branch, built directly), G0-g, C1b in both directions through the REAL reissue,
// the answer matrix (R5) on EVERY answer this file sees, the storage rules (§6.10: the server clock, the minute throttle,
// one change row per flag, `at` normalised, the purge, a failing history write), and the allowlisted `raw`.
//
// Every expected value comes from a rulebook: the transition tables (§5.5, §6.3.3), config.ts's declarations, the
// contract's zod twin (the answer branches' keys) — never from capture-phone.ts.
//
// "Another sport": a beat reads a sport in ONE place, the overlay theme inside the common fields, which the descriptor's
// builder owns (captureCommon). The cricket case proves the beat answers the descriptor's own common fields there too.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { z } from "zod";
import { sql } from "@/lib/db";
import { CaptureRefusalError } from "@/server/api-v1/capture-http";
import { CaptureBeat, CaptureBeatAnswer } from "@/server/api-v1/capture-schemas";
import {
  DEAD_PHONE_TAKEOVER_SECONDS, HOT_THERMAL_STATUS, LOW_BATTERY_PERCENT, NOT_RESPONDING_BEATS, PHONE_BEAT_RETENTION_HOURS,
  POLL_NEAR_SECONDS, POLL_STARTING_SECONDS,
} from "@/server/relay/config";
import { getCode, postBeat } from "../capture-phone";
import { reissueStreamCode } from "../stream-codes";
import { captureRig, phoneId, type CaptureRig } from "./_capture-rig";

const HAS_DB = !!process.env.DATABASE_URL;

const ENV_KEYS = ["RELAY_KEK", "AUTH_SECRET", "OAUTH_BASE_URL", "NEXT_PUBLIC_BASE_URL", "STREAM_INGEST_HOST", "STREAM_PLAYBACK_HOST", "STREAM_SRT_ENABLED", "RELAY_DRIVERS"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const KEK = randomBytes(32).toString("hex");
function baseEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.RELAY_KEK = KEK;
  process.env.AUTH_SECRET = "capture-beat-test-secret";
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
type Answer = z.infer<typeof CaptureBeatAnswer>;
const SEC = 1000;
/** The fake's connect delay for a rig that must reach live; the "armed" rigs never connect on their own. */
const CONNECT_MS = 3000;
const NEVER = 3_600_000;

/** A valid beat at the rig's clock — the contract's every field, parsed by the zod twin itself. */
function body(r: CaptureRig, phone: string, over: Partial<Beat> = {}): Beat {
  return CaptureBeat.parse({
    code: r.code, slot: 0, phone, claim: null, device: null, sid: null, at: r.now().toISOString(), state: "paired",
    cause: null, notReady: null, startFailed: null, stopped: null, mode: "operator", transport: null, bitrateKbps: null,
    delivery: "unknown", deliveredLagS: null, audioOk: null, battery: null, thermal: null, dataUsedMB: null,
    appVersion: "capture-test/1", ...over,
  });
}

/** R5 (§17.5), from the CONTRACT's zod twin: each branch's own keys. The server sends the common fields on every 2xx (ask
 *  1), replaced and taken included, and never `device` (PR-1) — so the keys sent are exactly the branch's, less `device`. */
const BRANCHES = CaptureBeatAnswer.options;
const keysOf = (state: Answer["state"]): string[] => {
  const branch = BRANCHES.find((o) => o.shape.state.value === state);
  if (!branch) throw new Error(`no contract branch for ${state}`);
  return Object.keys(branch.shape).filter((k) => k !== "device").sort();
};
let answersChecked = 0;
const statesSeen = new Set<string>();
/** Every answer in this file goes through here: parsed with its own branch, exactly the branch's keys, no `device`. */
function checked(a: Answer): Answer {
  expect(CaptureBeatAnswer.parse(a)).toEqual(a);
  expect(Object.keys(a).sort(), a.state).toEqual(keysOf(a.state));
  expect(a).not.toHaveProperty("device");
  for (const v of Object.values(a)) expect(v, "an absent field is omitted, never undefined").not.toBeUndefined();
  answersChecked++;
  statesSeen.add(a.state);
  return a;
}
async function beat(r: CaptureRig, phone: string, over: Partial<Beat> = {}, via: { code: string; tok: string } = r): Promise<Answer> {
  return checked(await postBeat(via.code, via.tok, body(r, phone, over), r.deps, r.now()));
}
const claimNew = (r: CaptureRig, phone: string, over: Partial<Beat> = {}) => beat(r, phone, { claim: "new", ...over });

type PRow = {
  id: string; code_id: string; phone: string; claim_kind: string; device_model: string | null; app_version: string | null; mode: string | null;
  phone_state: string | null; not_ready: string | null; start_failed: string | null; ended_at: Date | null; end_cause: string | null;
  replaced_by: string | null; last_beat_at: Date; answered_poll_seconds: number; last_beat: Record<string, unknown> | null;
};
async function pairings(r: CaptureRig): Promise<PRow[]> {
  return sql<PRow[]>`
    select p.id, p.code_id, p.phone, p.claim_kind, p.device_model, p.app_version, p.mode, p.phone_state, p.not_ready, p.start_failed,
           p.ended_at, p.end_cause, p.replaced_by, p.last_beat_at, p.answered_poll_seconds, p.last_beat
      from fixture_stream_pairings p join fixture_stream_codes c on c.id = p.code_id
     where c.fixture_id = ${r.fixtureId} order by p.claimed_at, p.id`;
}
const current = (rows: PRow[]) => rows.filter((p) => p.ended_at === null);
async function pairingOf(r: CaptureRig, phone: string): Promise<PRow> {
  const rows = (await pairings(r)).filter((p) => p.phone === phone);
  expect(rows.length, `PREMISE: ${phone} has a pairing`).toBeGreaterThan(0);
  return rows[rows.length - 1]!;
}
async function session(sid: string) {
  const [s] = await sql<{ state: string; end_reason: string | null; pairing_id: string | null; phone_beat: Record<string, unknown> | null; phone_beat_at: Date | null; first_ingest_at: Date | null }[]>`
    select state, end_reason, pairing_id, phone_beat, phone_beat_at, first_ingest_at from fixture_stream_sessions where id = ${sid}`;
  return s!;
}
async function eventsOf(sid: string, type: string) {
  return sql<{ source: string; kind: string; payload: Record<string, unknown> }[]>`
    select source, kind, payload from fixture_stream_events where session_id = ${sid} and type = ${type} order by seq`;
}
async function historyOf(pairingId: string) {
  return sql<{ id: string; kind: string; phone_state: string | null; flags: string[]; recorded_at: Date; session_id: string | null; raw: Record<string, unknown> }[]>`
    select id, kind, phone_state, flags, recorded_at, session_id, raw from fixture_stream_phone_beats where pairing_id = ${pairingId} order by id`;
}
async function inputOf(sid: string): Promise<string> {
  const [i] = await sql<{ ingest_input_id: string }[]>`select ingest_input_id from fixture_stream_inputs where session_id = ${sid} order by slot limit 1`;
  return i!.ingest_input_id;
}
const netSpend = async (sid: string) =>
  (await sql<{ net: number }[]>`select coalesce(sum(delta), 0)::int as net from org_stream_credits where session_id = ${sid} and reason in ('consume','refund')`)[0]!.net;
const isOver = (state: string) => state === "ending" || state === "completed";

/** The session's phone beats its sid after the fake's connect delay: that beat's tick takes the session live (§6.11). */
async function goLive(r: CaptureRig, phone: string, sid: string): Promise<void> {
  r.tick(CONNECT_MS);
  const a = await beat(r, phone, { sid, state: "publishing", transport: "srt" });
  expect(a, "PREMISE: the beat's own tick took the session live").toMatchObject({ state: "live", sid });
  expect((await session(sid)).state).toBe("live");
}

describe.skipIf(!HAS_DB)("postBeat — the claims (§5.5 T1–T8)", () => {
  it("T1 → T8: a `new` claim on an EMPTY slot makes the caller current — one row, the SERVER's clock, its device; later beats keep that ONE row; the same phone re-claiming `new` (process death) is still that row", async () => {
    const r = await captureRig();
    const A = phoneId("a");
    const first = await claimNew(r, A, { device: { model: "Pixel 9" }, state: "paired", mode: "automatic" });
    expect(first.state).toBe("waiting");
    let rows = await pairings(r);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ phone: A, claim_kind: "new", device_model: "Pixel 9", ended_at: null, phone_state: "paired", mode: "automatic", app_version: "capture-test/1", answered_poll_seconds: first.pollSeconds });
    expect(rows[0]!.last_beat_at.getTime()).toBe(r.now().getTime());
    r.tick(10 * SEC);
    expect((await beat(r, A, { state: "arming", notReady: "camera" })).state).toBe("waiting");
    r.tick(10 * SEC);
    expect((await claimNew(r, A)).state).toBe("waiting");
    rows = await pairings(r);
    expect(rows, "the same phone's re-claim is process death, never a second row").toHaveLength(1);
    expect(rows[0]!.last_beat_at.getTime()).toBe(r.now().getTime());
    expect(rows[0]).toMatchObject({ phone_state: "paired", not_ready: null });
  });

  it("T2 (paired): B's `new` claim takes the slot — A ENDED(replaced) naming B, B current; A's next beat (no claim) is `replaced` and writes nothing (T7)", async () => {
    const r = await captureRig();
    const [A, B] = [phoneId("a"), phoneId("b")];
    await claimNew(r, A);
    r.tick(5 * SEC);
    expect((await claimNew(r, B)).state).toBe("waiting");
    const rows = await pairings(r);
    const a = rows.find((p) => p.phone === A)!;
    const b = rows.find((p) => p.phone === B)!;
    expect(current(rows).map((p) => p.phone)).toEqual([B]);
    expect(a).toMatchObject({ end_cause: "replaced", replaced_by: b.id });
    expect(a.ended_at!.getTime()).toBe(r.now().getTime());
    const before = a.last_beat_at.getTime();
    r.tick(5 * SEC);
    expect((await beat(r, A)).state).toBe("replaced");
    expect((await pairingOf(r, A)).last_beat_at.getTime(), "a non-current phone's beat writes nothing").toBe(before);
  });

  it("T2 (armed): B's `new` claim takes the slot AND the session — the session's pairing moves to B, event phone_takeover {dead: false}; B hears go-live S (startedBy organiser), A's next beat naming S hears `replaced`", async () => {
    const r = await captureRig({ connectAfterMs: NEVER });
    const [A, B] = [phoneId("a"), phoneId("b")];
    await claimNew(r, A);
    const S = await r.start(A);
    expect((await session(S)).state, "PREMISE: armed (warming, no ingest)").toBe("warming");
    r.tick(SEC);
    expect(await claimNew(r, B)).toMatchObject({ state: "go-live", sid: S, startedBy: "organiser" });
    const b = await pairingOf(r, B);
    expect((await session(S)).pairing_id).toBe(b.id);
    expect(await pairingOf(r, A)).toMatchObject({ end_cause: "replaced", replaced_by: b.id });
    const ev = await eventsOf(S, "phone_takeover");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ source: "phone", payload: { dead: false, pairingId: b.id } });
    expect((await beat(r, A, { sid: S, state: "armed" })).state).toBe("replaced");
  });

  it("T3: a LIVE slot whose phone is beating refuses B's `new` claim — `taken`, NO row written, A still current; event claim_refused", async () => {
    const r = await captureRig({ credits: 1, connectAfterMs: CONNECT_MS });
    const [A, B] = [phoneId("a"), phoneId("b")];
    await claimNew(r, A);
    const S = await r.start(A);
    await goLive(r, A, S);
    r.tick(5 * SEC);
    expect((await claimNew(r, B)).state).toBe("taken");
    const rows = await pairings(r);
    expect(rows.some((p) => p.phone === B), "a refused claim writes no row").toBe(false);
    expect(current(rows).map((p) => p.phone)).toEqual([A]);
    expect(await eventsOf(S, "claim_refused")).toHaveLength(1);
    expect(await eventsOf(S, "phone_takeover")).toHaveLength(0);
  });

  /** A live session held by A, which last beat at `liveAt`; the fake input disconnected unless `connected`. */
  async function liveHeldBy(o: { connected?: boolean } = {}) {
    const r = await captureRig({ credits: 1, connectAfterMs: CONNECT_MS });
    const [A, B] = [phoneId("a"), phoneId("b")];
    await claimNew(r, A);
    const S = await r.start(A);
    await goLive(r, A, S);
    const inputId = await inputOf(S);
    if (!o.connected) r.ingest.setState(inputId, "disconnected");
    return { r, A, B, S, inputId };
  }
  const WINDOW_MS = DEAD_PHONE_TAKEOVER_SECONDS * SEC;

  it("T4: live·dead — no beat for the window, a FRESH read not connected, no connected sample for the window → B takes over: `live S`, the SAME sid, A ENDED(replaced), the session's pairing is B's, phone_takeover {dead: true}, ONE consume", async () => {
    const { r, A, B, S } = await liveHeldBy();
    expect(await netSpend(S), "PREMISE: the go-live consumed one credit").toBe(-1);
    r.tick(WINDOW_MS);
    expect(await claimNew(r, B)).toMatchObject({ state: "live", sid: S });
    const b = await pairingOf(r, B);
    expect((await session(S))).toMatchObject({ state: "live", pairing_id: b.id });
    expect(await pairingOf(r, A)).toMatchObject({ end_cause: "replaced", replaced_by: b.id });
    expect((await eventsOf(S, "phone_takeover"))[0]).toMatchObject({ payload: { dead: true, pairingId: b.id } });
    expect(await netSpend(S), "the same sid, the same credit: no second consume").toBe(-1);
    // The new phone publishes on: its own beats are the session's phone's beats.
    r.tick(5 * SEC);
    expect(await beat(r, B, { sid: S, state: "publishing" })).toMatchObject({ state: "live", sid: S });
  });

  it("T4's conjuncts ONE AT A TIME (§6.5): each alone keeps the slot `taken` — (1) A beat inside the window, (2) the fresh read connected, (3) a connected sample inside the window", async () => {
    let refused = 0;
    {   // (1) A beat inside the window; the other two hold (the last connected sample is the go-live's, a window old).
      const { r, A, B, S } = await liveHeldBy();
      r.tick(WINDOW_MS);
      await beat(r, A, { sid: S, state: "reconnecting" });
      r.tick(SEC);
      expect((await claimNew(r, B)).state).toBe("taken");
      refused++;
    }
    {   // (2) The fresh read is connected; no beat and no connected SAMPLE for the window (the read is this claim's own).
      const { r, B, S } = await liveHeldBy({ connected: true });
      await sql`delete from fixture_stream_samples where session_id = ${S}`;   // the go-live's samples: no connected sample at all
      await sql`update fixture_stream_sessions set first_ingest_at = ${new Date(r.now().getTime() - WINDOW_MS)} where id = ${S}`;
      r.tick(WINDOW_MS);
      expect((await claimNew(r, B)).state).toBe("taken");
      refused++;
    }
    {   // (3) A connected poll sample one second inside the window; no beat for the window and the fresh read disconnected.
      const { r, B, S } = await liveHeldBy();
      r.tick(WINDOW_MS);
      await sql`insert into fixture_stream_samples (session_id, source, ingest_state, output_state, sampled_at)
                values (${S}, 'poll', 'connected', 'ok', ${new Date(r.now().getTime() - WINDOW_MS + SEC)})`;
      expect((await claimNew(r, B)).state).toBe("taken");
      refused++;
    }
    expect(refused).toBe(3);
  });

  it("T5 / T6 / T7: `resume` from the current phone keeps it; `resume` on a slot with NO current pairing is T1 (a row, claim_kind resume); another phone's `resume` is `replaced` and changes nothing; no claim from a non-current phone is `replaced`", async () => {
    const r = await captureRig();
    const [A, B, C] = [phoneId("a"), phoneId("b"), phoneId("c")];
    expect((await beat(r, A, { claim: "resume" })).state, "T5: resume on an empty slot").toBe("waiting");
    expect(await pairingOf(r, A)).toMatchObject({ claim_kind: "resume", ended_at: null });
    r.tick(5 * SEC);
    expect((await beat(r, A, { claim: "resume" })).state, "T5: the current phone resumes").toBe("waiting");
    expect(await pairingOf(r, A)).toMatchObject({ ended_at: null });
    expect((await beat(r, B, { claim: "resume" })).state, "T6: resume never steals").toBe("replaced");
    expect((await beat(r, C)).state, "T7").toBe("replaced");
    const rows = await pairings(r);
    expect(rows.map((p) => p.phone)).toEqual([A]);
    expect(current(rows)).toHaveLength(1);
  });

  it("two `new` claims AT ONCE on an empty slot: exactly ONE current pairing — the code row's lock decides them one after the other (the second is T2 over the first)", async () => {
    let runs = 0;
    for (let i = 0; i < 3; i++) {
      const r = await captureRig();
      const [A, B] = [phoneId("a"), phoneId("b")];
      const answers = await Promise.all([claimNew(r, A), claimNew(r, B)]);
      expect(answers.map((a) => a.state)).toEqual(["waiting", "waiting"]);
      const rows = await pairings(r);
      expect(rows).toHaveLength(2);
      expect(current(rows)).toHaveLength(1);
      const ended = rows.find((p) => p.ended_at !== null)!;
      expect(ended).toMatchObject({ end_cause: "replaced", replaced_by: current(rows)[0]!.id });
      runs++;
    }
    expect(runs).toBe(3);
  });

  it("C1b / C3 / T30 through the REAL reissue: the ENDED code still serves its open session's phone a beat; a `new` claim on it is 401 (from any phone, the session's own included); B's claim on the NEW code takes the armed session, after which the old code refuses A", async () => {
    const r = await captureRig({ connectAfterMs: NEVER });
    const [A, B] = [phoneId("a"), phoneId("b")];
    await claimNew(r, A);
    const S = await r.start(A);
    const old = { code: r.code, tok: r.tok };
    const fresh = await reissueStreamCode(r.auth, r.fixtureId);
    r.tick(SEC);
    const oldBody = (phone: string, over: Partial<Beat> = {}) => body(r, phone, { code: old.code, ...over });
    expect(checked(await postBeat(old.code, old.tok, oldBody(A, { sid: S, state: "armed" }), r.deps, r.now())))
      .toMatchObject({ state: "go-live", sid: S });
    let refusals = 0;
    for (const phone of [B, A]) {
      const err = await postBeat(old.code, old.tok, oldBody(phone, { claim: "new" }), r.deps, r.now()).then(() => null, (e: unknown) => e);
      expect(err, phone).toBeInstanceOf(CaptureRefusalError);
      expect(err).toMatchObject({ status: 401, code: "code_ended" });
      refusals++;
    }
    expect(refusals).toBe(2);
    // B scans the NEW QR: the slot is armed and A holds S (its pairing is on the OLD code — the code's state is not read).
    const viaNew = { code: fresh.qr.code, tok: fresh.qr.tok };
    expect(checked(await postBeat(viaNew.code, viaNew.tok, body(r, B, { code: viaNew.code, claim: "new" }), r.deps, r.now())))
      .toMatchObject({ state: "go-live", sid: S });
    const b = await pairingOf(r, B);
    const [{ id: newCodeId }] = await sql<{ id: string }[]>`select id from fixture_stream_codes where code = ${viaNew.code}`;
    expect(b.code_id).toBe(newCodeId);
    expect((await session(S)).pairing_id).toBe(b.id);
    await expect(postBeat(old.code, old.tok, oldBody(A, { sid: S, state: "armed" }), r.deps, r.now())).rejects.toMatchObject({ status: 401, code: "code_ended" });
  });

  it("the beat's own refusals: a wrong tok 401, a slot other than 0 422 invalid, a body naming another code 422 invalid", async () => {
    const r = await captureRig();
    const A = phoneId("a");
    await expect(postBeat(r.code, "not-the-tok", body(r, A, { claim: "new" }), r.deps, r.now())).rejects.toMatchObject({ status: 401, code: "code_ended" });
    await expect(postBeat(r.code, r.tok, body(r, A, { claim: "new", slot: 1 }), r.deps, r.now())).rejects.toMatchObject({ status: 422, code: "invalid" });
    await expect(postBeat(r.code, r.tok, body(r, A, { claim: "new", code: "0123456789ab" }), r.deps, r.now())).rejects.toMatchObject({ status: 422, code: "invalid" });
    expect(await pairings(r), "a refused beat writes nothing").toHaveLength(0);
  });
});

describe.skipIf(!HAS_DB)("postBeat — the stops (§6.8.2, T21–T24a, G0-g)", () => {
  it("T21: the session's phone's `ended` beat is the operator's Stop — stop(operator_stopped), its pairing ENDED(operator_stopped), event phone_stop; it hears `over S stopped`; its next beat is `replaced` (a rescan is owed)", async () => {
    const r = await captureRig({ connectAfterMs: NEVER });
    const A = phoneId("a");
    await claimNew(r, A);
    const S = await r.start(A);
    expect(await beat(r, A, { sid: S, state: "ended", endReason: "operator-stopped" })).toMatchObject({ state: "over", sid: S, endReason: "stopped" });
    const s = await session(S);
    expect(isOver(s.state), s.state).toBe(true);
    expect(s.end_reason).toBe("operator_stopped");
    expect(await pairingOf(r, A)).toMatchObject({ end_cause: "operator_stopped" });
    expect(await eventsOf(S, "phone_stop")).toHaveLength(1);
    expect((await eventsOf(S, "stop")).map((e) => e.source), "the stop is the phone's recorded action").toContain("phone");
    r.tick(5 * SEC);
    expect((await beat(r, A, { sid: S, state: "ended", endReason: "operator-stopped" })).state).toBe("replaced");
  });

  it("T22: an `ended` beat from a phone that is NOT current → `replaced`, and the session runs on", async () => {
    const r = await captureRig({ connectAfterMs: NEVER });
    const [A, B] = [phoneId("a"), phoneId("b")];
    await claimNew(r, A);
    const S = await r.start(A);
    expect((await beat(r, B, { sid: S, state: "ended", endReason: "operator-stopped" })).state).toBe("replaced");
    expect(await session(S)).toMatchObject({ state: "warming", end_reason: null });
    expect(await pairingOf(r, A)).toMatchObject({ ended_at: null });
  });

  it("T23: `stopped: X` on the current phone's paired beat closes X (operator_stopped) and answers `over X stopped`; the pairing STAYS (only `ended` ends it)", async () => {
    const r = await captureRig({ connectAfterMs: NEVER });
    const A = phoneId("a");
    await claimNew(r, A);
    const X = await r.start(A);
    expect(await beat(r, A, { stopped: X })).toMatchObject({ state: "over", sid: X, endReason: "stopped" });
    const s = await session(X);
    expect(isOver(s.state), s.state).toBe(true);
    expect(s.end_reason).toBe("operator_stopped");
    expect(await pairingOf(r, A)).toMatchObject({ ended_at: null });
  });

  it("T24: `stopped: X` for an X that has ENDED → `over X` with X's own endReason; the newer Y stays open (it never touches another sid)", async () => {
    const r = await captureRig({ connectAfterMs: NEVER });
    const A = phoneId("a");
    await claimNew(r, A);
    const X = await r.start(A);
    await sql`update fixture_stream_sessions set state = 'completed', end_reason = 'max_duration', ended_at = now() where id = ${X}`;
    r.tick(SEC);
    const Y = await r.start(A);
    expect(await beat(r, A, { stopped: X })).toMatchObject({ state: "over", sid: X, endReason: "max_duration" });
    expect(await session(Y)).toMatchObject({ state: "warming", end_reason: null });
  });

  it("T24a: a NON-current phone's late `stopped: X` while the current phone holds X is IGNORED — `replaced` (no claim) or `taken` (a refused claim); X stays open; event stop_ignored {held: true}", async () => {
    const r = await captureRig({ credits: 1, connectAfterMs: CONNECT_MS });
    const [A, B] = [phoneId("a"), phoneId("b")];
    await claimNew(r, A);
    const X = await r.start(A);
    r.ingest.setState(await inputOf(X), "disconnected");   // armed: B's claim is T2, not a live refusal
    expect((await claimNew(r, B)).state, "PREMISE: B took the armed X").toBe("go-live");
    expect((await beat(r, A, { stopped: X })).state).toBe("replaced");
    expect((await session(X)).state).toBe("warming");
    r.ingest.setState(await inputOf(X), "connected");
    await goLive(r, B, X);
    r.tick(SEC);
    expect((await claimNew(r, A, { stopped: X })).state, "G0-g: a refused claim answers taken").toBe("taken");
    expect((await session(X)).state).toBe("live");
    const ignored = await eventsOf(X, "stop_ignored");
    expect(ignored).toHaveLength(2);
    for (const e of ignored) expect(e.payload).toMatchObject({ held: true });
  });

  it("T24a's POSITIVE branch, built directly: no current pairing holds X (its phone's pairing has ended and nobody replaced it) — the late stop APPLIES, though the caller is not current (`replaced`)", async () => {
    const r = await captureRig({ connectAfterMs: NEVER });
    const A = phoneId("a");
    await claimNew(r, A);
    const X = await r.start(A);
    await sql`update fixture_stream_pairings set ended_at = now(), end_cause = 'replaced' where phone = ${A}`;
    expect((await beat(r, A, { stopped: X })).state).toBe("replaced");
    const s = await session(X);
    expect(isOver(s.state), s.state).toBe(true);
    expect(s.end_reason).toBe("operator_stopped");
  });

  it("G0-g: a refused `new` claim carrying `stopped: X` for an ENDED X is `taken` — never `over X`", async () => {
    const r = await captureRig({ credits: 1, connectAfterMs: CONNECT_MS });
    const [A, B] = [phoneId("a"), phoneId("b")];
    await claimNew(r, A);
    const X = await r.start(A);
    await sql`update fixture_stream_sessions set state = 'completed', end_reason = 'stopped', ended_at = now() where id = ${X}`;
    expect((await claimNew(r, B)).state, "PREMISE: B takes the paired slot (T2)").toBe("waiting");
    const Y = await r.start(B);
    await goLive(r, B, Y);
    r.tick(SEC);
    expect((await claimNew(r, A, { stopped: X })).state).toBe("taken");
    // The positive pair: the CURRENT phone naming the ended X hears `over X`.
    expect(await beat(r, B, { stopped: X })).toMatchObject({ state: "over", sid: X, endReason: "stopped" });
  });
});

describe.skipIf(!HAS_DB)("postBeat — the answer (§6.3.3, R5)", () => {
  it("a STARTING slot answers `waiting` at POLL_STARTING_SECONDS, an open session's other states at POLL_NEAR_SECONDS — and the cadence answered is the one stored on the pairing", async () => {
    const r = await captureRig({ connectAfterMs: NEVER });
    const A = phoneId("a");
    await claimNew(r, A);
    const S = await r.start(A);
    await sql`update fixture_stream_sessions set state = 'requested' where id = ${S}`;
    const starting = await beat(r, A);
    expect(starting).toMatchObject({ state: "waiting", pollSeconds: POLL_STARTING_SECONDS });
    expect((await pairingOf(r, A)).answered_poll_seconds).toBe(POLL_STARTING_SECONDS);
    await sql`update fixture_stream_sessions set state = 'warming' where id = ${S}`;
    const armed = await beat(r, A);
    expect(armed).toMatchObject({ state: "go-live", sid: S, pollSeconds: POLL_NEAR_SECONDS });
    expect((await pairingOf(r, A)).answered_poll_seconds).toBe(POLL_NEAR_SECONDS);
  });

  it("another sport (cricket) — and the generic one: the beat's common fields are the DESCRIPTOR's own waiting fields (one builder, R7)", async () => {
    let compared = 0;
    for (const sport of ["generic", "cricket"] as const) {
      const r = await captureRig({ sport });
      const A = phoneId("a");
      const a = await claimNew(r, A);
      const d = await getCode(r.code, r.tok, { slot: 0, phone: null }, r.deps, r.now());
      expect(d.state).toBe("waiting");
      for (const k of ["label", "autoAllowed", "destinationName", "overlayUrl", "pollSeconds"] as const) {
        expect(a[k as keyof Answer], `${sport}.${k}`).toEqual((d as Record<string, unknown>)[k]);
        compared++;
      }
      expect(a.scheduledStart ?? null, `${sport}.scheduledStart`).toEqual((d as { scheduledStart?: number }).scheduledStart ?? null);
    }
    expect(compared).toBe(10);
  });
});

describe.skipIf(!HAS_DB)("postBeat — storage (§6.10)", () => {
  it("the minute throttle runs on the SERVER clock: no row at 59 s, a `minute` row at 60 s — and an `at` five hours ahead moves neither the throttle nor last_beat_at", async () => {
    const r = await captureRig();
    const A = phoneId("a");
    await claimNew(r, A);
    const p = await pairingOf(r, A);
    expect((await historyOf(p.id)).map((h) => h.kind), "the first beat is a change (no previous state)").toEqual(["change"]);
    const t0 = r.now().getTime();
    r.tick(30 * SEC);
    await beat(r, A, { at: new Date(r.now().getTime() + 5 * 3600 * SEC).toISOString() });
    expect((await pairingOf(r, A)).last_beat_at.getTime(), "last_beat_at is the server's").toBe(r.now().getTime());
    r.tick(29 * SEC - 1);
    await beat(r, A);
    expect(await historyOf(p.id)).toHaveLength(1);
    r.tick(1);
    expect(r.now().getTime() - t0).toBe(59 * SEC);
    await beat(r, A);
    expect(await historyOf(p.id), "59 s: still inside the minute").toHaveLength(1);
    r.tick(SEC);
    await beat(r, A);
    const h = await historyOf(p.id);
    expect(h.map((x) => x.kind)).toEqual(["change", "minute"]);
    expect(h[1]!.recorded_at.getTime()).toBe(r.now().getTime());
    // A row-writing beat whose `at` is five hours ahead: the row is stamped on the server's clock, the phone's `at` rides
    // in `raw` only — so the throttle above can never be steered by a phone clock.
    r.tick(SEC);
    const ahead = new Date(r.now().getTime() + 5 * 3600 * SEC).toISOString();
    await beat(r, A, { state: "arming", at: ahead });
    const last = (await historyOf(p.id)).at(-1)!;
    expect(last).toMatchObject({ kind: "change", phone_state: "arming" });
    expect(last.recorded_at.getTime(), "recorded_at is the server's clock, never the phone's `at`").toBe(r.now().getTime());
    expect(last.raw.at).toBe(ahead);
  });

  it("a `change` row per flag (battery_low, hot, stalled, not_ready, not_responding) and per state — each flag's own threshold from config.ts, each with its positive pair", async () => {
    const r = await captureRig({ connectAfterMs: NEVER });
    const A = phoneId("a");
    await claimNew(r, A);
    const p = await pairingOf(r, A);
    const lastFlags = async () => { const h = await historyOf(p.id); return { kind: h.at(-1)!.kind, flags: [...h.at(-1)!.flags].sort(), n: h.length }; };
    const step = async (over: Partial<Beat>, flags: string[]) => {
      r.tick(SEC);
      const before = (await historyOf(p.id)).length;
      await beat(r, A, over);
      const last = await lastFlags();
      expect(last.n, JSON.stringify(over)).toBe(before + 1);
      expect(last).toMatchObject({ kind: "change", flags: [...flags].sort() });
    };
    let cases = 0;
    await step({ battery: { percent: LOW_BATTERY_PERCENT - 1, charging: false, drainPctPerHour: null } }, ["battery_low"]); cases++;
    await step({ battery: { percent: LOW_BATTERY_PERCENT - 1, charging: true, drainPctPerHour: null } }, []); cases++;
    await step({ battery: { percent: LOW_BATTERY_PERCENT - 1, charging: false, drainPctPerHour: null } }, ["battery_low"]); cases++;
    await step({ battery: { percent: LOW_BATTERY_PERCENT, charging: false, drainPctPerHour: null } }, []); cases++;
    await step({ thermal: HOT_THERMAL_STATUS }, ["hot"]); cases++;
    await step({ thermal: HOT_THERMAL_STATUS - 1 }, []); cases++;
    await step({ delivery: "stalled" }, ["stalled"]); cases++;
    await step({ delivery: "ok" }, []); cases++;
    await step({ notReady: "camera" }, ["not_ready"]); cases++;
    await step({ notReady: null }, []); cases++;
    await step({ state: "arming" }, []); cases++;
    // not_responding (§6.9): HELD (the open session's phone) and quiet for NOT_RESPONDING_BEATS answered cadences.
    const S = await r.start(A);
    r.tick(SEC);
    await beat(r, A, { sid: S, state: "armed" });
    const cadence = (await pairingOf(r, A)).answered_poll_seconds;
    r.tick(NOT_RESPONDING_BEATS * cadence * SEC - SEC);
    await beat(r, A, { sid: S, state: "armed" });
    expect((await lastFlags()).flags, "one second short of the threshold").not.toContain("not_responding");
    r.tick(NOT_RESPONDING_BEATS * cadence * SEC);
    const before = (await historyOf(p.id)).length;
    await beat(r, A, { sid: S, state: "armed" });
    expect(await lastFlags()).toMatchObject({ kind: "change", flags: ["not_responding"], n: before + 1 });
    cases++;
    expect(cases).toBe(12);
  });

  it("`at` with an offset is stored as UTC: \"2026-10-01T15:30:00+05:30\" → \"2026-10-01T10:00:00.000Z\" in the pairing's last beat, the history row and the session's phone_beat", async () => {
    const r = await captureRig({ connectAfterMs: NEVER });
    const A = phoneId("a");
    await claimNew(r, A);
    const S = await r.start(A);
    r.tick(SEC);
    await beat(r, A, { sid: S, state: "armed", at: "2026-10-01T15:30:00+05:30" });
    const p = await pairingOf(r, A);
    expect(p.last_beat!.at).toBe("2026-10-01T10:00:00.000Z");
    expect((await historyOf(p.id)).at(-1)!.raw.at).toBe("2026-10-01T10:00:00.000Z");
    const s = await session(S);
    expect(s.phone_beat!.at).toBe("2026-10-01T10:00:00.000Z");
    expect(s.phone_beat_at!.getTime()).toBe(r.now().getTime());
  });

  it("the session's phone_beat moves only for a beat from its phone NAMING its sid — not for that phone's sid-less beat, not for another phone's", async () => {
    const r = await captureRig({ connectAfterMs: NEVER });
    const [A, B] = [phoneId("a"), phoneId("b")];
    await claimNew(r, A);
    const S = await r.start(A);
    r.tick(SEC);
    await beat(r, A);
    expect((await session(S)).phone_beat_at, "a sid-less beat").toBeNull();
    await beat(r, B, { sid: S, state: "armed" });
    expect((await session(S)).phone_beat_at, "another phone's").toBeNull();
    await beat(r, A, { sid: S, state: "armed" });
    expect((await session(S)).phone_beat_at!.getTime(), "its phone, naming S").toBe(r.now().getTime());
  });

  it("raw is an ALLOWLIST: a field the contract does not declare never reaches storage, and `device` is read only on a claim beat", async () => {
    const r = await captureRig();
    const A = phoneId("a");
    await claimNew(r, A, { device: { model: "Pixel 9" } });
    r.tick(SEC);
    // A state change, so this beat writes its own history row too.
    const sneaky = { ...body(r, A, { state: "arming", device: { model: "Not On A Claim" } }), injected: "x", tok: "secret" } as unknown as Beat;
    checked(await postBeat(r.code, r.tok, sneaky, r.deps, r.now()));
    const p = await pairingOf(r, A);
    expect(p.device_model, "device on a non-claim beat is ignored").toBe("Pixel 9");
    const declared = Object.keys(CaptureBeat.shape).filter((k) => k !== "device" && k !== "endReason").sort();
    expect(Object.keys(p.last_beat!).sort()).toEqual(declared);
    const h = (await historyOf(p.id)).at(-1)!;
    expect(h).toMatchObject({ kind: "change", phone_state: "arming" });
    expect(Object.keys(h.raw).sort()).toEqual(declared);
    expect(JSON.stringify([p.last_beat, h.raw])).not.toMatch(/secret|injected|Not On A Claim/);
  });

  it("the purge on a minute insert deletes the pairing's history older than PHONE_BEAT_RETENTION_HOURS, keeps the newer, and never touches the pairing's or the session's latest beat", async () => {
    const r = await captureRig({ connectAfterMs: NEVER });
    const A = phoneId("a");
    await claimNew(r, A);
    const S = await r.start(A);
    await beat(r, A, { sid: S, state: "armed" });
    const p = await pairingOf(r, A);
    const ret = PHONE_BEAT_RETENTION_HOURS * 3600 * SEC;
    const ins = (ageMs: number) => sql`insert into fixture_stream_phone_beats (org_id, pairing_id, recorded_at, kind, raw)
      values (${r.auth.orgId}, ${p.id}, ${new Date(r.now().getTime() - ageMs)}, 'minute', '{}'::jsonb)`;
    await ins(ret + SEC);
    await ins(ret - 3600 * SEC);
    r.tick(60 * SEC);
    await beat(r, A, { sid: S, state: "armed" });
    const ages = (await historyOf(p.id)).map((h) => r.now().getTime() - h.recorded_at.getTime());
    expect(ages.some((a) => a > ret), "the row past retention is gone").toBe(false);
    expect(ages.some((a) => a > ret - 3600 * SEC - 61 * SEC && a < ret), "the row inside retention is kept").toBe(true);
    expect((await pairingOf(r, A)).last_beat).not.toBeNull();
    expect((await session(S)).phone_beat).not.toBeNull();
  });

  it("a FAILED history write never fails the beat (the sampleBeat isolation rule): the answer goes out, the pairing's latest beat is stored, no history row", async () => {
    const r = await captureRig();
    const A = phoneId("a");
    // A constraint scoped to THIS org's rows, so no other suite running in parallel is touched.
    const name = `capture_beat_test_${r.auth.orgId.replace(/-/g, "")}`;
    await sql.unsafe(`alter table fixture_stream_phone_beats add constraint ${name} check (org_id <> '${r.auth.orgId}') not valid`);
    try {
      expect((await claimNew(r, A)).state).toBe("waiting");
      const p = await pairingOf(r, A);
      expect(p.last_beat_at.getTime()).toBe(r.now().getTime());
      expect(await historyOf(p.id)).toHaveLength(0);
    } finally {
      await sql.unsafe(`alter table fixture_stream_phone_beats drop constraint ${name}`);
    }
  });
});

describe.skipIf(!HAS_DB)("anti-vacuity", () => {
  it("every answer above was checked against its contract branch — and every branch was seen", () => {
    expect(answersChecked).toBeGreaterThan(60);
    expect([...statesSeen].sort()).toEqual(BRANCHES.map((o) => o.shape.state.value).sort());
  });
});
