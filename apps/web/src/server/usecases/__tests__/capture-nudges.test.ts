// Push nudges (spec 2026-11-24 §2.3, plan Task 6 / T1.4) — the capture-side PUBLISHER: when a session's state changes, a pairing is
// replaced or a stream code ends, the server sends ONE private `nudge` on `capture:{pairingId}` after the commit, so the phone
// re-beats at once instead of waiting out its poll. Driven through the REAL code (`apply` via the organiser's Stop, `postBeat`'s
// claim, `reissueStreamCode`, `withdrawCourtStream`) on the capture rig, with a recording publish port on the deps — and, for the
// wire shape and the kill switch, through the DEFAULT publish (`broadcast`) with `fetch` stubbed.
//
// The rules, typed from the spec's table (§2.3) and the plan's pin 12, never from the code under test:
//   - entry into provisioning or warming -> go-live; into ending -> stop (every end reason); into completed or failed -> over;
//     no move (from === to) -> nothing. The table below is over EVERY (from, to) of the seven states, and every reason is hit;
//   - the target is the session's pairing when that pairing is still open, else the open slot-0 pairing on the session's code;
//     with neither, nothing is sent and nothing throws;
//   - a claim that ends a pairing `replaced` (takeover; the holder's rescan) pings THAT pairing, never its successor;
//   - a code ended by reissue or withdraw pings `over` to every open pairing it has, in ONE request; EXPIRY (lazy) pings nothing;
//   - best-effort: a publish that throws or never answers never fails or slows the apply; a blank id sends nothing and throws
//     nothing (Task 3 review m-b); the message carries {v, reason, at} and nothing else; REALTIME_PUBLISH=off sends nothing;
//   - after the commit: the state a publisher can read at send time is the NEW one.
//
// Applies to another sport: N/A (no sport rules) — a nudge reads no sport; the court link is the other surface.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";

vi.mock("@/lib/sentry", async (orig) => ({ ...(await orig<typeof import("@/lib/sentry")>()), captureError: vi.fn() }));

import { nestingViolations, sql } from "@/lib/db";
import { CAPTURE_NUDGE_REASONS, type CaptureNudgeReason, type RealtimeMessage } from "@/lib/realtime";
import { CaptureBeat, CaptureBeatAnswer } from "@/server/api-v1/capture-schemas";
import { log } from "@/server/logger";
import { ACTIVE_STATES, TERMINAL_STATES, type SessionState } from "@/server/relay/domain/session";
import { FakeIngest, FakeRunner } from "@/server/relay/fakes";
import { connect } from "@/server/youtube/__tests__/_connect-rig";
import { FakeYouTube } from "@/server/youtube/fake";
import { postBeat } from "../capture-phone";
import { linkCourtStream, setCourtStream, withdrawCourtStream } from "../court-streams";
import { ensureStreamCode, reissueStreamCode } from "../stream-codes";
import { apply, stopSession, type SessionDeps } from "../stream-sessions";
import { nudgePairings, nudgeReasonFor, nudgesSettled } from "../stream-sessions/nudge";
import { pairPresentPhone, rigApiTarget, sessionOnTarget } from "@/server/relay/__tests__/_session-rig";
import { captureRig, override, phoneId, type CaptureRig } from "./_capture-rig";
import { at, place, seedDay } from "./_match-day-seed";

const HAS_DB = !!process.env.DATABASE_URL;

const ENV_KEYS = [
  "RELAY_KEK", "AUTH_SECRET", "OAUTH_BASE_URL", "NEXT_PUBLIC_BASE_URL", "STREAM_PLAYBACK_HOST", "STREAM_SRT_ENABLED", "RELAY_DRIVERS",
  "YOUTUBE_TOKEN_KEK", "COURT_MIN_APP_VERSION", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "REALTIME_PUBLISH",
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const KEK = randomBytes(32).toString("hex");
const YT_KEK = randomBytes(32).toString("hex");
const COURT_BUILD = "1.0.14-1200";
function baseEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.RELAY_KEK = KEK;
  process.env.AUTH_SECRET = "capture-nudges-test-secret";
  process.env.YOUTUBE_TOKEN_KEK = YT_KEK;
  process.env.COURT_MIN_APP_VERSION = COURT_BUILD;
  // No Supabase: the DEFAULT publish is a no-op here, so a rig that carries no recorder never reaches a real project.
}
beforeAll(baseEnv);
beforeEach(baseEnv);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
afterAll(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

// ---------------------------------------------------------------------------
// The rulebook, typed here (spec §2.3 + plan pin 12), not read off the code.
// ---------------------------------------------------------------------------
const STATES: readonly SessionState[] = [...ACTIVE_STATES, ...TERMINAL_STATES];
function expectedReason(from: SessionState, to: SessionState): CaptureNudgeReason | null {
  if (from === to) return null;
  if (to === "provisioning" || to === "warming") return "go-live";
  if (to === "ending") return "stop";
  if (to === "completed" || to === "failed") return "over";
  return null;   // requested, live: no nudge
}

describe("nudgeReasonFor — every (from, to) of the seven states", () => {
  it("answers the spec's table for all 49 pairs, hits every reason, and the same state is null", () => {
    expect(STATES, "PREMISE: seven states").toHaveLength(7);
    let checked = 0;
    const hit = new Set<CaptureNudgeReason | null>();
    for (const from of STATES) {
      for (const to of STATES) {
        const want = expectedReason(from, to);
        expect(nudgeReasonFor(from, to), `${from} -> ${to}`).toBe(want);
        hit.add(want);
        checked++;
      }
    }
    expect(checked, "anti-vacuity: every pair was checked").toBe(49);
    // The empty case first: staying put is never a nudge, for every state.
    for (const s of STATES) expect(nudgeReasonFor(s, s), `${s} -> ${s}`).toBeNull();
    // Every declared capture reason EXCEPT the two other publishers' (replaced: the claim; next-match: Task 7) is reachable here,
    // and "no nudge" is exercised too.
    expect([...hit].filter((x) => x !== null).sort()).toEqual(["go-live", "over", "stop"]);
    expect(hit.has(null)).toBe(true);
    for (const r of ["go-live", "stop", "over"] as const) expect(CAPTURE_NUDGE_REASONS).toContain(r);
  });
});

// ---------------------------------------------------------------------------
// The publish port the rig's deps carry: records each request, and what the database said at send time.
// ---------------------------------------------------------------------------
type Sent = { label: string; messages: RealtimeMessage[]; stateAtSend: string | null };
function recorder() {
  const calls: Sent[] = [];
  const watch: { sid: string | null } = { sid: null };
  const publish: NonNullable<SessionDeps["publish"]> = async (messages, label) => {
    let stateAtSend: string | null = null;
    if (watch.sid !== null) {
      const [row] = await sql<{ state: string }[]>`select state from fixture_stream_sessions where id = ${watch.sid}`;
      stateAtSend = row?.state ?? null;
    }
    calls.push({ label, messages: [...messages], stateAtSend });
  };
  return { calls, watch, publish, messages: () => calls.flatMap((c) => c.messages), reset: () => { calls.length = 0; } };
}
type Rec = ReturnType<typeof recorder>;

const reasonOf = (m: RealtimeMessage): string => (m.payload as { reason: string }).reason;
const topicsOf = (ms: readonly RealtimeMessage[]): string[] => ms.map((m) => m.topic).sort();
const SEC = 1000;
const NEVER = 3_600_000;
const CONNECT_MS = 3000;

async function rig(o: Parameters<typeof captureRig>[0] = {}): Promise<{ r: CaptureRig; rec: Rec }> {
  const r = await captureRig(o);
  const rec = recorder();
  r.deps.publish = rec.publish;
  return { r, rec };
}
function body(r: CaptureRig, phone: string, over: Partial<CaptureBeat> = {}, code: string = r.code): CaptureBeat {
  return CaptureBeat.parse({
    code, slot: 0, phone, claim: null, device: null, sid: null, at: r.now().toISOString(), state: "paired",
    cause: null, notReady: null, startFailed: null, stopped: null, mode: "operator", transport: null, bitrateKbps: null,
    delivery: "unknown", deliveredLagS: null, audioOk: null, battery: null, thermal: null, dataUsedMB: null,
    appVersion: "capture-test/1", ...over,
  });
}
async function post(r: CaptureRig, phone: string, over: Partial<CaptureBeat> = {}, via: { code: string; tok: string } = { code: r.code, tok: r.tok }) {
  const a = await postBeat(via.code, via.tok, body(r, phone, over, via.code), r.deps, r.now());
  expect(CaptureBeatAnswer.parse(a)).toEqual(a);
  return a;
}
/** The pairing a phone holds now (open), on any code of the fixture. */
async function openPairingOf(r: CaptureRig, phone: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    select p.id from fixture_stream_pairings p join fixture_stream_codes c on c.id = p.code_id
     where c.fixture_id = ${r.fixtureId} and p.phone = ${phone} and p.ended_at is null`;
  expect(rows, `PREMISE: ${phone} holds one open pairing`).toHaveLength(1);
  return rows[0]!.id;
}
async function stateOf(sid: string): Promise<SessionState> {
  const [row] = await sql<{ state: SessionState }[]>`select state from fixture_stream_sessions where id = ${sid}`;
  return row!.state;
}
/** The session's recorded transitions (from != to), the ledger the apply wrote — the oracle for "which moves happened". */
async function movesOf(sid: string): Promise<{ from: SessionState; to: SessionState }[]> {
  const rows = await sql<{ from_state: SessionState; to_state: SessionState }[]>`
    select from_state, to_state from fixture_stream_events
     where session_id = ${sid} and from_state is not null and to_state is not null and from_state <> to_state order by seq`;
  return rows.map((x) => ({ from: x.from_state, to: x.to_state }));
}
/** Wait out every nudge the code under test fired and forgot. */
const settle = () => nudgesSettled();

/** The process's own publish on the wire: `broadcast` with `fetch` stubbed and a Supabase project configured. Used wherever the
 *  code under test takes no deps (the code-end sites) and for the kill switch. */
function wire() {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
  vi.stubGlobal("fetch", fetchMock);
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://nudge-rig.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-rig";
  const requests = () => fetchMock.mock.calls.map(([, init]) => (JSON.parse((init as RequestInit).body as string) as { messages: RealtimeMessage[] }).messages);
  const sent = () => requests().flat();
  return { fetchMock, sent, requests };
}

describe.skipIf(!HAS_DB)("the apply hook — a session's state change nudges its pairing", () => {
  it("the organiser's Stop: every move the ledger recorded sends the reason the table gives, once each, to the session's pairing — and the publisher sees the COMMITTED state", async () => {
    const { r, rec } = await rig({ credits: 1, connectAfterMs: CONNECT_MS });
    const A = phoneId("a");
    await r.pair(A);
    const pid = await openPairingOf(r, A);
    const nesting = nestingViolations().length;
    const S = await r.start(A);
    rec.watch.sid = S;
    await settle();
    const startMoves = await movesOf(S);
    expect(startMoves.length, "PREMISE: the start moved the session").toBeGreaterThan(0);
    // Go live: entry into provisioning / warming.
    const goLives = startMoves.filter((m) => expectedReason(m.from, m.to) === "go-live");
    expect(goLives.length, "PREMISE: the start entered provisioning or warming").toBeGreaterThan(0);
    expect(rec.messages().map(reasonOf).sort(), "one go-live per entry, nothing else").toEqual(goLives.map(() => "go-live"));
    expect(topicsOf(rec.messages()), "all on the session's pairing").toEqual(goLives.map(() => `capture:${pid}`));
    rec.reset();

    r.tick(CONNECT_MS + 5 * SEC);
    await stopSession(r.auth, r.fixtureId, S, r.deps);
    await settle();
    const stopMoves = (await movesOf(S)).slice(startMoves.length);
    expect(stopMoves.map((m) => m.to), "PREMISE: the Stop moved the session to ending").toContain("ending");
    const want = stopMoves.map((m) => expectedReason(m.from, m.to)).filter((x): x is CaptureNudgeReason => x !== null).sort();
    expect(want, "PREMISE: a stop reason is owed").toContain("stop");
    expect(rec.messages().map(reasonOf).sort()).toEqual(want);
    expect(rec.messages().filter((m) => reasonOf(m) === "stop"), "exactly one stop").toHaveLength(1);
    // After commit: what the database said when each request left was the state the move ended in (never the one before it).
    const finalState = await stateOf(S);
    for (const c of rec.calls) expect(["ending", "completed"], "sent after the commit").toContain(c.stateAtSend);
    expect(rec.calls.at(-1)!.stateAtSend).toBe(finalState);
    expect(nestingViolations().length, "the hook never read the pool inside a transaction").toBe(nesting);
    expect(rec.calls.map((c) => c.label)).toEqual(rec.calls.map(() => "capture nudge"));
  });

  it("the wire shape: a private `nudge` on capture:{pairing} whose payload is {v, reason, at} and nothing else", async () => {
    const { r, rec } = await rig({ credits: 1, connectAfterMs: NEVER });
    const A = phoneId("a");
    await r.pair(A);
    const pid = await openPairingOf(r, A);
    const S = await r.start(A);
    await settle();
    rec.reset();
    const before = Date.now();
    await stopSession(r.auth, r.fixtureId, S, r.deps);
    await settle();
    const stop = rec.messages().find((m) => reasonOf(m) === "stop");
    expect(stop, "a stop nudge was sent").toBeDefined();
    expect(stop).toMatchObject({ topic: `capture:${pid}`, event: "nudge", private: true });
    const payload = stop!.payload as { v: number; reason: string; at: string };
    expect(Object.keys(payload).sort(), "no ids, state, scores or URLs ride a nudge").toEqual(["at", "reason", "v"]);
    expect(payload.v).toBeGreaterThanOrEqual(before);
    expect(new Date(payload.at).toISOString()).toBe(payload.at);
    expect(Object.keys(stop!).sort()).toEqual(["event", "payload", "private", "topic"]);
  });

  it("a second identical apply moves nothing and nudges nothing — in a state that WOULD nudge (warming), and after the stop", async () => {
    const { r, rec } = await rig({ credits: 1, connectAfterMs: NEVER });
    const A = phoneId("a");
    await r.pair(A);
    const S = await r.start(A);
    await settle();
    const live = await stateOf(S);
    expect(["provisioning", "warming"], "PREMISE: the session rests in a state whose ENTRY nudges (go-live)").toContain(live);
    rec.reset();
    const moves = (await movesOf(S)).length;
    expect(await apply(S, () => null, r.deps), "a command function that decides nothing").toMatchObject({ id: S, state: live });
    await settle();
    expect(rec.calls, "an apply that moved nothing sent nothing").toEqual([]);
    expect((await movesOf(S)).length, "PREMISE: nothing moved").toBe(moves);
    await stopSession(r.auth, r.fixtureId, S, r.deps);
    await settle();
    expect(rec.calls.length, "PREMISE: the stop nudged").toBeGreaterThan(0);
    rec.reset();
    await stopSession(r.auth, r.fixtureId, S, r.deps).catch(() => undefined);   // a second Stop: already over / ending
    await apply(S, () => null, r.deps);
    await settle();
    expect(rec.calls, "the second Stop and a null apply nudge nothing").toEqual([]);
  });

  it("a session with no open pairing sends nothing and throws nothing: the phone's own `ended` closed it, and a pairing ended by SQL leaves no target", async () => {
    const { r, rec } = await rig({ credits: 1, connectAfterMs: NEVER });
    const A = phoneId("a");
    await post(r, A, { claim: "new" });
    const S = await r.start(A);
    await settle();
    rec.reset();
    // T21: the phone's own Stop ends its pairing (operator_stopped) and then the session. The hook still runs — to an ended pairing.
    const over = await post(r, A, { sid: S, state: "ended", endReason: "operator-stopped" });
    expect(over).toMatchObject({ state: "over", sid: S });
    await settle();
    expect(await sql`select 1 from fixture_stream_pairings p join fixture_stream_codes c on c.id = p.code_id where c.fixture_id = ${r.fixtureId} and p.ended_at is null`,
      "PREMISE: nothing is open any more").toHaveLength(0);
    expect((await movesOf(S)).some((m) => m.to === "ending" || m.to === "completed"), "PREMISE: the stop moved the session").toBe(true);
    expect(rec.calls, "0 targets: nothing sent").toEqual([]);
  });

  it("the target is the session's pairing only while it is OPEN: a closed one falls back to the open slot-0 pairing on the session's code", async () => {
    const { r, rec } = await rig({ credits: 1, connectAfterMs: NEVER });
    const [A, B] = [phoneId("a"), phoneId("b")];
    await post(r, A, { claim: "new" });
    const S = await r.start(A);
    await settle();
    rec.reset();
    const aPid = await openPairingOf(r, A);
    const [{ code_id }] = await sql<{ code_id: string }[]>`select code_id from fixture_stream_sessions where id = ${S}`;
    // The session's pairing closes (a code_ended on a lazy 401, say) and ANOTHER phone's pairing is open on the same code.
    await sql`update fixture_stream_pairings set ended_at = now(), end_cause = 'code_ended' where id = ${aPid}`;
    const [{ id: bPid }] = await sql<{ id: string }[]>`
      insert into fixture_stream_pairings (org_id, code_id, slot, phone, claim_kind, claimed_at, last_beat_at, answered_poll_seconds)
      values (${r.auth.orgId}, ${code_id}, 0, ${B}, 'new', now(), now(), 30) returning id`;
    await stopSession(r.auth, r.fixtureId, S, r.deps);
    await settle();
    const sent = rec.messages();
    expect(sent.length, "PREMISE: the stop nudged somebody").toBeGreaterThan(0);
    expect(topicsOf(sent), "never the closed pairing; the open one on the code").toEqual(sent.map(() => `capture:${bPid}`));
  });

  it("I-2: the holder's rescan on the reissued code moves its pairing AND the session — the stop pings the NEW pairing, the old one is pinged `replaced`", async () => {
    const { r, rec } = await rig({ credits: 1, connectAfterMs: NEVER });
    const A = phoneId("a");
    await post(r, A, { claim: "new" });
    const oldPid = await openPairingOf(r, A);
    const S = await r.start(A);
    await settle();
    const fresh = await reissueStreamCode(r.auth, r.fixtureId);
    await settle();
    rec.reset();
    r.tick(SEC);
    await post(r, A, { claim: "new" }, { code: fresh.qr.code, tok: fresh.qr.tok });
    await settle();
    const newPid = await openPairingOf(r, A);
    expect(newPid, "PREMISE: the pairing moved").not.toBe(oldPid);
    const [{ pairing_id }] = await sql<{ pairing_id: string }[]>`select pairing_id from fixture_stream_sessions where id = ${S}`;
    expect(pairing_id, "PREMISE: the session followed the phone").toBe(newPid);
    expect(rec.messages().map((m) => [m.topic, reasonOf(m)]), "the claim pinged the OLD pairing, `replaced`").toEqual([[`capture:${oldPid}`, "replaced"]]);
    rec.reset();
    await stopSession(r.auth, r.fixtureId, S, r.deps);
    await settle();
    const sent = rec.messages();
    expect(sent.map(reasonOf)).toContain("stop");
    expect(topicsOf(sent), "the stop goes to the pairing the phone holds now").toEqual(sent.map(() => `capture:${newPid}`));
  });
});

describe.skipIf(!HAS_DB)("the claim — `replaced` goes to the OLD pairing, once, after the commit", () => {
  it("a takeover of an ARMED session: the old pairing hears `replaced`, the new one nothing; the loser's next beats and the winner's beats send nothing more", async () => {
    const { r, rec } = await rig({ credits: 1, connectAfterMs: NEVER });
    const [A, B] = [phoneId("a"), phoneId("b")];
    await post(r, A, { claim: "new" });
    const aPid = await openPairingOf(r, A);
    const S = await r.start(A);
    await settle();
    rec.reset();
    r.tick(5 * SEC);
    const b = await post(r, B, { claim: "new" });
    expect(b, "PREMISE: B took the armed session").toMatchObject({ state: "go-live", sid: S });
    await settle();
    const bPid = await openPairingOf(r, B);
    expect(bPid).not.toBe(aPid);
    expect(rec.messages().map((m) => [m.topic, reasonOf(m)])).toEqual([[`capture:${aPid}`, "replaced"]]);
    rec.reset();
    for (let i = 0; i < 2; i++) {
      r.tick(5 * SEC);
      expect((await post(r, A)).state, "the loser").toBe("replaced");
      await post(r, B, { sid: S, state: "armed" });
    }
    await settle();
    expect(rec.calls, "a later beat of either phone ends nothing and nudges nothing").toEqual([]);
  });

  it("a takeover of a PAIRED slot (no session) pings the old pairing too; a refused claim (taken) and the holder's own beats ping nobody", async () => {
    const { r, rec } = await rig({ credits: 1, connectAfterMs: CONNECT_MS });
    const [A, B, C] = [phoneId("a"), phoneId("b"), phoneId("c")];
    await post(r, A, { claim: "new" });
    const aPid = await openPairingOf(r, A);
    await settle();
    expect(rec.calls, "the first claim ends nobody").toEqual([]);
    r.tick(5 * SEC);
    await post(r, B, { claim: "new" });
    await settle();
    expect(rec.messages().map((m) => [m.topic, reasonOf(m)])).toEqual([[`capture:${aPid}`, "replaced"]]);
    rec.reset();
    // A LIVE, beating slot refuses a claim (T3): `taken`, nothing ended.
    const S = await r.start(B);
    r.tick(CONNECT_MS);
    await post(r, B, { sid: S, state: "publishing", transport: "srt" });
    await settle();
    rec.reset();
    r.tick(5 * SEC);
    expect((await post(r, C, { claim: "new" })).state).toBe("taken");
    await post(r, B, { sid: S, state: "publishing", transport: "srt" });
    await settle();
    expect(rec.calls).toEqual([]);
  });
});

describe.skipIf(!HAS_DB)("a code ended by the organiser — `over` to every open pairing, in one request", () => {
  it("reissue with TWO open pairings sends two `over` in ONE request; a reissue of the next code (no pairing) sends nothing", async () => {
    const { r } = await rig({ credits: 1, connectAfterMs: NEVER });
    const A = phoneId("a");
    await post(r, A, { claim: "new" });
    const aPid = await openPairingOf(r, A);
    const [{ id: codeId }] = await sql<{ id: string }[]>`select id from fixture_stream_codes where fixture_id = ${r.fixtureId} and ended_at is null`;
    const [{ id: second }] = await sql<{ id: string }[]>`
      insert into fixture_stream_pairings (org_id, code_id, slot, phone, claim_kind, claimed_at, last_beat_at, answered_poll_seconds)
      values (${r.auth.orgId}, ${codeId}, 1, ${phoneId("slot1")}, 'new', now(), now(), 30) returning id`;
    await settle();
    const { fetchMock, requests } = wire();
    await reissueStreamCode(r.auth, r.fixtureId);
    await settle();
    expect(fetchMock, "one request").toHaveBeenCalledTimes(1);
    expect(requests()[0]!.map(reasonOf)).toEqual(["over", "over"]);
    expect(topicsOf(requests()[0]!)).toEqual([`capture:${aPid}`, `capture:${second}`].sort());
    fetchMock.mockClear();
    await reissueStreamCode(r.auth, r.fixtureId);   // the new code has no pairing yet
    await settle();
    expect(fetchMock, "0 open pairings: nothing sent, nothing thrown").not.toHaveBeenCalled();
  });

  it("ensureStreamCode's reissue (a sealed tok that will not open) ends the code and pings it; a plain re-show pings nobody", async () => {
    const { r } = await rig({ credits: 1, connectAfterMs: NEVER });
    const A = phoneId("a");
    await post(r, A, { claim: "new" });
    const aPid = await openPairingOf(r, A);
    await settle();
    const { fetchMock, sent } = wire();
    await ensureStreamCode(r.auth, r.fixtureId);   // re-show of the active code
    await settle();
    expect(fetchMock, "a re-show ends nothing").not.toHaveBeenCalled();
    // Break the envelope: the ensure ends this code and mints a fresh one.
    await sql`update fixture_stream_codes set tok_enc = decode('00', 'hex') where fixture_id = ${r.fixtureId} and ended_at is null`;
    const shown = await ensureStreamCode(r.auth, r.fixtureId);
    expect(shown.qr.code, "PREMISE: a NEW code was minted").not.toBe(r.code);
    const [{ end_cause }] = await sql<{ end_cause: string }[]>`select end_cause from fixture_stream_codes where code = ${r.code}`;
    expect(end_cause, "PREMISE: the old code ENDED by reissue").toBe("reissued");
    await settle();
    expect(sent().map((m) => [m.topic, reasonOf(m)])).toEqual([[`capture:${aPid}`, "over"]]);
  });

  it("EXPIRY is lazy: a code that expires past its grace pings nobody (the phone's next call answers 401)", async () => {
    const { r } = await rig({ credits: 1, connectAfterMs: NEVER });
    const A = phoneId("a");
    await post(r, A, { claim: "new" });
    expect(await openPairingOf(r, A), "PREMISE: a pairing is open on the code, so a nudge WOULD have a target").toBeTruthy();
    await settle();
    const { fetchMock } = wire();
    await sql`update fixtures set status = 'cancelled' where id = ${r.fixtureId}`;
    await sql`update fixtures set finished_at = now() - interval '30 days' where id = ${r.fixtureId}`;
    const err = await ensureStreamCode(r.auth, r.fixtureId).then(() => null, (e: unknown) => e);
    expect(err, "PREMISE: the ensure found the code due and refused").toMatchObject({ status: 422 });
    const [{ end_cause }] = await sql<{ end_cause: string }[]>`select end_cause from fixture_stream_codes where fixture_id = ${r.fixtureId}`;
    expect(end_cause, "PREMISE: the code ENDED by expiry").toBe("expired");
    await settle();
    expect(fetchMock, "no expiry nudge").not.toHaveBeenCalled();
  });
});

// The default publish on the wire: through `broadcast`, with fetch stubbed — what a deployment sends.
describe.skipIf(!HAS_DB)("the default publish — the wire, and the kill switch", () => {
  it("a desk Stop with NO publish port on the deps posts the nudge to /realtime/v1/api/broadcast; REALTIME_PUBLISH=off (any case, padded) posts nothing", async () => {
    const r = await captureRig({ credits: 1, connectAfterMs: NEVER });   // deps carry no publish: the process's own
    const A = phoneId("a");
    await r.pair(A);
    const pid = await openPairingOf(r, A);
    const S = await r.start(A);
    await settle();
    const { fetchMock, sent } = wire();
    await stopSession(r.auth, r.fixtureId, S, r.deps);
    await settle();
    expect(fetchMock.mock.calls.length, "PREMISE: the Stop reached the wire").toBeGreaterThan(0);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://nudge-rig.supabase.co/realtime/v1/api/broadcast");
    expect(sent().map((m) => [m.topic, m.event, m.private, reasonOf(m)])).toContainEqual([`capture:${pid}`, "nudge", true, "stop"]);

    for (const off of ["off", "OFF", "Off", " off "]) {
      process.env.REALTIME_PUBLISH = off;
      const r2 = await captureRig({ credits: 1, connectAfterMs: NEVER });
      await r2.pair(phoneId("k"));
      const S2 = await r2.start(phoneId("k"));
      await settle();
      fetchMock.mockClear();
      await stopSession(r2.auth, r2.fixtureId, S2, r2.deps);
      await settle();
      expect(fetchMock, `REALTIME_PUBLISH=${JSON.stringify(off)}`).not.toHaveBeenCalled();
      expect(await stateOf(S2), "PREMISE: the stop still happened").not.toBe("warming");
    }
  });

  it("withdrawing a court link pings `over` to the court code's pairing on the wire; a second withdraw sends nothing", async () => {
    const day = await seedDay();
    await override(day.orgId, "streaming.relay", true);
    await override(day.orgId, "streaming.overlay", true);
    const c = await connect({ auth: day.auth, orgId: day.orgId, userId: day.auth.userId! });
    const now = at(0).getTime();
    const ingest = new FakeIngest({ clock: () => now, connectAfterMs: NEVER });
    ingest.storage = { totalStorageMinutes: 0, totalStorageMinutesLimit: 100_000_000, videoCount: 0 };
    const deps: SessionDeps = {
      drivers: { ingest, runner: new FakeRunner() }, now: () => new Date(now), appUrl: "http://app.test",
      youtube: new FakeYouTube({ now: () => new Date(now) }),
    };
    const shown = await linkCourtStream(day.auth, day.comp.id, { courtId: day.courts.c2, targetId: c.targetId, day: "2026-11-07" }, at(0));
    const qr = { code: shown.qr!.code, tok: shown.qr!.tok };
    const phone = phoneId("court");
    const a = await postBeat(qr.code, qr.tok, CaptureBeat.parse({
      code: qr.code, slot: 0, phone, claim: "new", device: null, sid: null, at: new Date(now).toISOString(), state: "paired",
      cause: null, notReady: null, startFailed: null, stopped: null, mode: "operator", transport: null, bitrateKbps: null,
      delivery: "unknown", deliveredLagS: null, audioOk: null, battery: null, thermal: null, dataUsedMB: null, appVersion: COURT_BUILD,
    }), deps, new Date(now));
    expect(a.state, "PREMISE: the court phone is paired").toBe("waiting");
    const [{ id: pid }] = await sql<{ id: string }[]>`
      select p.id from fixture_stream_pairings p join fixture_stream_codes c on c.id = p.code_id
       where c.court_link_id = ${shown.id} and p.ended_at is null`;
    await settle();
    const { fetchMock, sent } = wire();
    await withdrawCourtStream(day.auth, shown.id);
    await settle();
    expect(sent().map((m) => [m.topic, m.event, m.private, reasonOf(m)])).toEqual([[`capture:${pid}`, "nudge", true, "over"]]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockClear();
    await withdrawCourtStream(day.auth, shown.id);   // idempotent: nothing ended, nothing sent
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a court link whose code's envelope will not open is reissued by the next link call: the old code ends and its court phone is pinged `over`; a plain re-link pings nobody", async () => {
    const day = await seedDay();
    await override(day.orgId, "streaming.relay", true);
    await override(day.orgId, "streaming.overlay", true);
    const c = await connect({ auth: day.auth, orgId: day.orgId, userId: day.auth.userId! });
    const now = at(0).getTime();
    const ingest = new FakeIngest({ clock: () => now, connectAfterMs: NEVER });
    ingest.storage = { totalStorageMinutes: 0, totalStorageMinutesLimit: 100_000_000, videoCount: 0 };
    const deps: SessionDeps = {
      drivers: { ingest, runner: new FakeRunner() }, now: () => new Date(now), appUrl: "http://app.test",
      youtube: new FakeYouTube({ now: () => new Date(now) }),
    };
    const input = { courtId: day.courts.c2, targetId: c.targetId, day: "2026-11-07" };
    const shown = await linkCourtStream(day.auth, day.comp.id, input, at(0));
    const phone = phoneId("court");
    await postBeat(shown.qr!.code, shown.qr!.tok, CaptureBeat.parse({
      code: shown.qr!.code, slot: 0, phone, claim: "new", device: null, sid: null, at: new Date(now).toISOString(), state: "paired",
      cause: null, notReady: null, startFailed: null, stopped: null, mode: "operator", transport: null, bitrateKbps: null,
      delivery: "unknown", deliveredLagS: null, audioOk: null, battery: null, thermal: null, dataUsedMB: null, appVersion: COURT_BUILD,
    }), deps, new Date(now));
    const [{ id: pid }] = await sql<{ id: string }[]>`
      select p.id from fixture_stream_pairings p join fixture_stream_codes c on c.id = p.code_id
       where c.court_link_id = ${shown.id} and p.ended_at is null`;
    await settle();
    const { fetchMock, sent } = wire();
    expect((await linkCourtStream(day.auth, day.comp.id, input, at(0))).qr?.code, "a plain re-link shows the same code").toBe(shown.qr!.code);
    await settle();
    expect(fetchMock, "a re-show ends nothing").not.toHaveBeenCalled();
    await sql`update fixture_stream_codes set tok_enc = decode('00', 'hex') where court_link_id = ${shown.id} and ended_at is null`;
    const again = await linkCourtStream(day.auth, day.comp.id, input, at(0));
    expect(again.qr!.code, "PREMISE: a NEW code was minted").not.toBe(shown.qr!.code);
    const [{ end_cause }] = await sql<{ end_cause: string }[]>`select end_cause from fixture_stream_codes where code = ${shown.qr!.code}`;
    expect(end_cause, "PREMISE: the old court code ended by reissue").toBe("reissued");
    await settle();
    expect(sent().map((m) => [m.topic, m.event, m.private, reasonOf(m)])).toEqual([[`capture:${pid}`, "nudge", true, "over"]]);
  });

  it("switching a match's court Stream ON retires its used, idle own code: the silent phone's pairing on it is pinged `over`; a refused ON retires and pings nothing", async () => {
    const day = await seedDay();
    const fx = day.comp.fixtures[0]!.id;
    await place(day, fx, 0, day.courts.c2);
    const api = await rigApiTarget(day.orgId, "Club channel");
    await linkCourtStream(day.auth, day.comp.id, { courtId: day.courts.c2, targetId: api.targetId });
    await ensureStreamCode(day.auth, fx);
    const { pairingId } = await pairPresentPhone(fx, { at: new Date(Date.now() - 10 * 60_000) });   // silent at any cadence
    const sid = await sessionOnTarget(day.orgId, fx, (await rigApiTarget(day.orgId, "Own phone channel")).targetId, "failed");
    await sql`update fixture_stream_sessions set code_id = (select id from fixture_stream_codes where fixture_id = ${fx} and ended_at is null) where id = ${sid}`;
    await settle();
    const { fetchMock, sent } = wire();
    await setCourtStream(day.auth, fx, false);   // OFF retires nothing
    await settle();
    expect(fetchMock, "OFF ends nothing").not.toHaveBeenCalled();
    expect(await setCourtStream(day.auth, fx, true)).toEqual({ on: true });
    const [{ end_cause }] = await sql<{ end_cause: string }[]>`select end_cause from fixture_stream_codes where fixture_id = ${fx}`;
    expect(end_cause, "PREMISE: ON retired the own code").toBe("withdrawn");
    await settle();
    expect(sent().map((m) => [m.topic, reasonOf(m)])).toEqual([[`capture:${pairingId}`, "over"]]);
  });
});

describe.skipIf(!HAS_DB)("best-effort — a nudge never fails or slows the change that triggered it", () => {
  it("a publish port that THROWS: the Stop still returns and commits, the failure is warned by ids and error name only, nothing is unhandled", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const { r } = await rig({ credits: 1, connectAfterMs: NEVER });
      r.deps.publish = async () => { throw new Error("https://secret.example/realtime?apikey=SECRET-KEY boom"); };
      const warn = vi.spyOn(log, "warn");
      const A = phoneId("a");
      await r.pair(A);
      const pid = await openPairingOf(r, A);
      const S = await r.start(A);
      await settle();
      warn.mockClear();
      const out = await stopSession(r.auth, r.fixtureId, S, r.deps);
      await settle();
      expect(out, "the Stop returned").toBeTruthy();
      expect(["ending", "completed"], "and committed").toContain(await stateOf(S));
      const lines = warn.mock.calls.filter(([, msg]) => String(msg).startsWith("capture nudge"));
      expect(lines.length, "the failure is logged").toBeGreaterThan(0);
      const text = JSON.stringify(lines);
      expect(text, "ids only").toContain(pid);
      expect(text, "never the error's message, a url or a key").not.toMatch(/secret\.example|SECRET-KEY|apikey|https?:/i);
      await new Promise((res) => setTimeout(res, 20));
      expect(unhandled, "no unhandled rejection").toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("a publish that NEVER answers does not hold the apply", async () => {
    const { r } = await rig({ credits: 1, connectAfterMs: NEVER });
    r.deps.publish = () => new Promise<void>(() => undefined);
    const A = phoneId("a");
    await r.pair(A);
    const S = await r.start(A);   // would hang here if the apply awaited its nudge
    const out = await stopSession(r.auth, r.fixtureId, S, r.deps);
    expect(out).toBeTruthy();
    expect(["ending", "completed"]).toContain(await stateOf(S));
  });
});

describe("a blank id is refused before a topic is built (Task 3 review m-b)", () => {
  it("nudgePairings([blank]) resolves, publishes nothing and warns once with ids only; a blank beside a real id sends the real one", async () => {
    const calls: RealtimeMessage[][] = [];
    const deps = { publish: async (m: readonly RealtimeMessage[]) => { calls.push([...m]); } };
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    for (const blank of ["", " ", "\t\n"]) {
      await expect(nudgePairings([blank], "stop", deps)).resolves.toBeUndefined();
    }
    expect(calls, "no broadcast for a blank id").toEqual([]);
    expect(warn).toHaveBeenCalledTimes(3);
    await expect(nudgePairings([" ", "pairing-1"], "over", deps)).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.map((m) => m.topic)).toEqual(["capture:pairing-1"]);
    expect(await nudgePairings([], "stop", deps), "the empty case").toBeUndefined();
    expect(calls, "an empty list sends nothing").toHaveLength(1);
  });
});
