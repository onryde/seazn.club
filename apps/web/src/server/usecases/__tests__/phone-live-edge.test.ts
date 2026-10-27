// Owed 108 fix (b), web half — the phone-live EDGE, end to end through the REAL producer and the REAL consumer.
//
// Producer: the phone's own beat (`postBeat`, capture-phone.ts), pairing and session started through the real paths
// (`pairPresentPhone`, `createSession` — a COMPOSED session, the only mode with a relay). Consumer: the relay's heartbeat
// (`heartbeat`, stream-sessions.ts, and the real route handler once) whose reply carries `phoneLiveEdge`. A fixture on both
// ends would prove the fixture (AGENTS.md class 1): nothing here writes the counter by hand, and every value read back is
// read from the reply the relay would receive or from the row the producer wrote.
//
// The transitions (TEST-STRATEGY rule 1) and where each is pinned:
//   first live → no increment ......................... "the first live" (null → 0)
//   live → lost → live → 1, second outage → 2 ........ "the sequence"
//   a flap / a duplicate live beat → no change ........ "a flap", "duplicate and late"
//   a late or duplicate DELIVERY ...................... "duplicate and late" (the same `at`, an older `at`)
//   an outage the phone's beats never reported ........ "silence" (both sides of the window)
//   a beat after the session ended / ends mid-flight .. "after the session ends", "ends while the beat is in flight"
//   two copies of one beat in flight after a silence .. "RACE" (one edge: the silence is judged on the locked pairing row)
//   a superseded Machine's reply ...................... "a superseded Machine's reply" (exactly `ending`, no counter)
//   a beat that is not the session's phone ............ "only the session's phone"
//   empty: no phone has been live .................... "no phone history" (the reply omits the field)
//   persisted, not remembered ......................... "a fresh module graph"
//   the wire .......................................... "through the route"
//
// ONE SPORT, on purpose (TEST-STRATEGY rule 6): neither the phone's beat nor the relay's heartbeat reads a sport.
// Expected values come from the rulebook — the owner's stated rule, config.ts's NOT_RESPONDING_BEATS, the contract's zod
// twins — never from capture-phone.ts.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import type { z } from "zod";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { CaptureBeat } from "@/server/api-v1/capture-schemas";
import { RelayHeartbeatReply } from "@/server/api-v1/schemas";
import { NOT_RESPONDING_BEATS } from "@/server/relay/config";
import { setRelayDriversForTest } from "@/server/relay/drivers";
import { POST as beatRoute } from "@/app/api/internal/relay/sessions/[sid]/heartbeat/route";
import { postBeat } from "../capture-phone";
import { createSession, heartbeat, stopSession } from "../stream-sessions";
import { captureRig, phoneId, type CaptureRig } from "./_capture-rig";
import { pairPresentPhone } from "@/server/relay/__tests__/_session-rig";

const HAS_DB = !!process.env.DATABASE_URL;

const ENV_KEYS = ["RELAY_KEK", "AUTH_SECRET", "OAUTH_BASE_URL", "NEXT_PUBLIC_BASE_URL", "STREAM_PLAYBACK_HOST", "STREAM_SRT_ENABLED", "RELAY_DRIVERS", "RELAY_IMAGE"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const KEK = randomBytes(32).toString("hex");
function baseEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.RELAY_KEK = KEK;
  process.env.AUTH_SECRET = "phone-live-edge-test-secret";
  // A composed start is refused 503 composed_unavailable while RELAY_IMAGE is unset; the fake runner needs no real image.
  process.env.RELAY_IMAGE = "registry.fly.io/seazn-relay:phone-live-edge-test";
}
beforeAll(baseEnv);
beforeEach(baseEnv);
afterEach(() => setRelayDriversForTest(null));
afterAll(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

type Beat = z.infer<typeof CaptureBeat>;
type PhoneState = Beat["state"];
const SEC = 1000;
const NEVER = 3_600_000;
/** The relay beats about every 5 s (compositor spec §5.3; RELAY_HEARTBEAT_INTERVAL_MS). */
const RELAY_BEAT_S = 5;

/** A valid phone beat at the rig's clock, parsed by the contract's own zod twin. */
function body(r: CaptureRig, phone: string, over: Partial<Beat> = {}): Beat {
  return CaptureBeat.parse({
    code: r.code, slot: 0, phone, claim: null, device: null, sid: null, at: r.now().toISOString(), state: "paired",
    cause: null, notReady: null, startFailed: null, stopped: null, mode: "operator", transport: null, bitrateKbps: null,
    delivery: "unknown", deliveredLagS: null, audioOk: null, battery: null, thermal: null, dataUsedMB: null,
    appVersion: "phone-live-edge-test/1", ...over,
  });
}

/** A composed session with its phone paired through the real claim; the fake ingest never connects, so nothing but the
 *  tests below moves the session. Credits: a composed start spends one. */
async function composedRig() {
  const r = await captureRig({ credits: 1, connectAfterMs: NEVER });
  const phone = phoneId("a");
  await pairPresentPhone(r.fixtureId, { phone, at: r.now() });
  const { sessionId } = await createSession(r.auth, r.fixtureId, { mode: "composed", targetId: r.target.id }, r.deps);
  const jobToken = r.runner.created[0]!.jobToken;
  const S = sessionId;
  const self = {
    r, S, phone, jobToken,
    /** The session's phone beats, naming the session. */
    async phoneBeat(state: PhoneState, over: Partial<Beat> = {}) {
      return postBeat(r.code, r.tok, body(r, phone, { sid: S, state, ...over }), r.deps, r.now());
    },
    /** The relay's heartbeat: the reply's `phoneLiveEdge`, `undefined` when the reply omits it. */
    async relayBeat(): Promise<number | null | undefined> {
      const reply = await heartbeat(S, jobToken, { state: "playing" }, r.deps);
      expect(RelayHeartbeatReply.safeParse(reply).success, JSON.stringify(reply)).toBe(true);
      return (reply as { phoneLiveEdge?: number | null }).phoneLiveEdge;
    },
    /** Time passes with the relay still beating every 5 s and the phone silent (the phone's own network is the thing that
     *  is down). Returns the replies — the value must not move while the phone says nothing. */
    async silentFor(seconds: number): Promise<(number | null | undefined)[]> {
      const seen: (number | null | undefined)[] = [];
      for (let waited = 0; waited < seconds; waited += RELAY_BEAT_S) {
        r.tick(Math.min(RELAY_BEAT_S, seconds - waited) * SEC);
        seen.push(await self.relayBeat());
      }
      return seen;
    },
  };
  return self;
}

type Cols = { phone_live_edge: number | null; phone_live: boolean | null; phone_live_beat_at: Date | null };
async function cols(sid: string): Promise<Cols> {
  const [c] = await sql<Cols[]>`select phone_live_edge, phone_live, phone_live_beat_at from fixture_stream_sessions where id = ${sid}`;
  return c!;
}
const edgeOf = async (sid: string) => (await cols(sid)).phone_live_edge;
/** The silence window, from the rulebook: no beat for NOT_RESPONDING_BEATS answered cadences (§6.9 W8), the cadence being
 *  the one the server ANSWERED this pairing, read from the pairing row. */
async function notRespondingAfterS(sid: string): Promise<number> {
  const [p] = await sql<{ answered_poll_seconds: number }[]>`
    select p.answered_poll_seconds from fixture_stream_sessions s join fixture_stream_pairings p on p.id = s.pairing_id where s.id = ${sid}`;
  return NOT_RESPONDING_BEATS * p!.answered_poll_seconds;
}

/** Wait until some OTHER backend is blocked on a row lock in a statement matching `pattern` (an ILIKE). A race test that
 *  does not reach this point would pass without ever exercising the lock, so the premise is asserted, not assumed. */
async function lockWaiter(pattern: string): Promise<void> {
  let waiting = 0;
  for (let i = 0; i < 100 && waiting === 0; i++) {
    [{ n: waiting }] = await sql<{ n: number }[]>`
      select count(*)::int as n from pg_stat_activity
       where wait_event_type = 'Lock' and query ilike ${pattern} and pid <> pg_backend_pid()` as { n: number }[];
    if (waiting === 0) await new Promise((res) => setTimeout(res, 50));
  }
  expect(waiting, `PREMISE: a statement matching ${pattern} is waiting on a row lock`).toBeGreaterThan(0);
}

describe.skipIf(!HAS_DB)("the phone-live edge — phone beat in, relay reply out", () => {
  it("no phone history (EMPTY CASE): a session whose phone has not published yet has no counter — the reply omits the field, the row is null throughout", async () => {
    const s = await composedRig();
    expect(await s.relayBeat(), "a fresh composed session").toBeUndefined();
    expect(await edgeOf(s.S)).toBeNull();
    for (const state of ["armed", "connecting"] as const) {
      s.r.tick(5 * SEC);
      await s.phoneBeat(state);
      expect(await s.relayBeat(), `after a ${state} beat`).toBeUndefined();
    }
    expect(await cols(s.S)).toMatchObject({ phone_live_edge: null, phone_live: false });
  });

  it("the first live does NOT count: null → 0 (the field appears at 0), and a repeat of it stays 0", async () => {
    const s = await composedRig();
    s.r.tick(5 * SEC);
    await s.phoneBeat("connecting");
    s.r.tick(5 * SEC);
    await s.phoneBeat("publishing", { transport: "srt" });
    expect(await edgeOf(s.S)).toBe(0);
    expect(await s.relayBeat(), "the reply serves 0, a number — not omitted").toBe(0);
    s.r.tick(5 * SEC);
    await s.phoneBeat("publishing", { transport: "srt" });
    expect(await s.relayBeat()).toBe(0);
  });

  it("the sequence: live → lost → live is 1; a second outage is 2; a third (via connecting) is 3 — and the reply serves the current value on EVERY relay beat", async () => {
    const s = await composedRig();
    const log: { step: string; reply: number | null | undefined }[] = [];
    async function step(name: string, state: PhoneState) {
      s.r.tick(5 * SEC);
      await s.phoneBeat(state);
      // Two relay beats per phone beat: the value must be the same on both (the relay dedupes on it).
      const a = await s.relayBeat();
      s.r.tick(RELAY_BEAT_S * SEC);
      const b = await s.relayBeat();
      expect(b, `${name}: the second relay beat serves the same value`).toBe(a);
      log.push({ step: name, reply: a });
    }
    await step("live", "publishing");
    await step("lost", "reconnecting");
    await step("lost again", "reconnecting");
    await step("back", "publishing");
    await step("steady", "publishing");
    await step("lost 2", "reconnecting");
    await step("back 2", "publishing");
    await step("lost 3", "reconnecting");
    await step("connecting", "connecting");
    await step("back 3", "publishing");
    expect(log.map((l) => l.reply)).toEqual([0, 0, 0, 1, 1, 1, 2, 2, 2, 3]);
    expect(await edgeOf(s.S)).toBe(3);
  });

  it("a flap live → live does not count: publishing, degraded, publishing, degraded is a weak connection, not an outage", async () => {
    const s = await composedRig();
    for (const state of ["publishing", "degraded", "publishing", "degraded", "degraded", "publishing"] as const) {
      s.r.tick(5 * SEC);
      await s.phoneBeat(state);
    }
    expect(await s.relayBeat()).toBe(0);
  });

  it("duplicate and late deliveries are not edges: the same beat sent twice, and a `reconnecting` that arrives AFTER the `publishing` that followed it", async () => {
    const s = await composedRig();
    s.r.tick(5 * SEC);
    await s.phoneBeat("publishing");
    s.r.tick(5 * SEC);
    const lost = body(s.r, s.phone, { sid: s.S, state: "reconnecting" });
    await postBeat(s.r.code, s.r.tok, lost, s.r.deps, s.r.now());
    s.r.tick(5 * SEC);
    const back = body(s.r, s.phone, { sid: s.S, state: "publishing" });
    await postBeat(s.r.code, s.r.tok, back, s.r.deps, s.r.now());
    expect(await s.relayBeat(), "PREMISE: one outage, one edge").toBe(1);
    // The same beat delivered again (a retry after a lost response).
    s.r.tick(1 * SEC);
    await postBeat(s.r.code, s.r.tok, back, s.r.deps, s.r.now());
    expect(await s.relayBeat(), "a duplicate of the live beat").toBe(1);
    // The old `reconnecting` delivered late: it is not applied, so it does not make the next live beat an edge.
    s.r.tick(1 * SEC);
    await postBeat(s.r.code, s.r.tok, lost, s.r.deps, s.r.now());
    expect((await cols(s.S)).phone_live, "a late beat is not applied: the tracker still says live").toBe(true);
    s.r.tick(5 * SEC);
    await s.phoneBeat("publishing");
    expect(await s.relayBeat(), "no phantom edge after a late lost beat").toBe(1);
  });

  it("silence is an outage — and the window is the rulebook's: one second SHORT of NOT_RESPONDING_BEATS cadences is no edge, AT the window is one", async () => {
    const s = await composedRig();
    s.r.tick(5 * SEC);
    await s.phoneBeat("publishing");
    const window = await notRespondingAfterS(s.S);
    expect(window, "PREMISE: a real window (3 cadences of the answered poll)").toBeGreaterThan(NOT_RESPONDING_BEATS);

    // Short of the window: the phone was quiet, then live again — not an outage.
    const quiet = await s.silentFor(window - 1);
    expect(quiet.every((v) => v === 0), `no movement while the phone is quiet: ${JSON.stringify(quiet)}`).toBe(true);
    s.r.tick(1 * SEC - 1);   // the window is >=, so one millisecond short is still short
    await s.phoneBeat("publishing");
    expect(await s.relayBeat(), "short of the window").toBe(0);

    // At the window: the beats it could not send were the outage.
    await s.silentFor(window - 1);
    s.r.tick(1 * SEC);
    await s.phoneBeat("publishing");
    expect(await s.relayBeat(), "at the window").toBe(1);
  });

  it("silence then a lost beat then a live one is ONE edge, not two", async () => {
    const s = await composedRig();
    s.r.tick(5 * SEC);
    await s.phoneBeat("publishing");
    await s.silentFor((await notRespondingAfterS(s.S)) + 5);
    s.r.tick(1 * SEC);
    await s.phoneBeat("reconnecting");
    expect(await s.relayBeat(), "the lost beat after the silence is not itself an edge").toBe(0);
    s.r.tick(5 * SEC);
    await s.phoneBeat("publishing");
    expect(await s.relayBeat()).toBe(1);
  });

  it("only the session's phone moves it: another phone's beat naming the session, and the session's phone beating with no sid, change nothing", async () => {
    const s = await composedRig();
    s.r.tick(5 * SEC);
    await s.phoneBeat("publishing");
    s.r.tick(5 * SEC);
    await s.phoneBeat("reconnecting");
    const before = await cols(s.S);
    s.r.tick(5 * SEC);
    await postBeat(s.r.code, s.r.tok, body(s.r, phoneId("stranger"), { sid: s.S, state: "publishing" }), s.r.deps, s.r.now());
    expect(await cols(s.S), "another phone's beat").toEqual(before);
    s.r.tick(5 * SEC);
    await postBeat(s.r.code, s.r.tok, body(s.r, s.phone, { sid: null, state: "publishing" }), s.r.deps, s.r.now());
    expect(await cols(s.S), "the session's phone, naming no session").toEqual(before);
    s.r.tick(5 * SEC);
    await s.phoneBeat("publishing");
    expect(await edgeOf(s.S), "and its own beat still moves it").toBe(1);
  });

  it("once the session is ending or over nothing moves: a live beat after a Stop, and after completion, leaves the row exactly as it was; the relay's beat is 410 once over", async () => {
    const s = await composedRig();
    s.r.tick(5 * SEC);
    await s.phoneBeat("publishing");
    s.r.tick(5 * SEC);
    await s.phoneBeat("reconnecting");
    const before = await cols(s.S);
    expect(before.phone_live_edge, "PREMISE: a counter exists to be disturbed").toBe(0);
    await stopSession(s.r.auth, s.r.fixtureId, s.S, s.r.deps);
    const [stopped] = await sql<{ state: string }[]>`select state from fixture_stream_sessions where id = ${s.S}`;
    expect(stopped!.state, "PREMISE: the Stop moved it to ending").toBe("ending");
    s.r.tick(5 * SEC);
    await s.phoneBeat("publishing");   // would be edge 1 on a session that is carrying on
    expect(await cols(s.S), "ending").toEqual(before);
    // Over: the phone-facing read no longer finds an open session, so the beat is not the session's at all.
    await sql`update fixture_stream_sessions set state = 'completed', end_reason = 'stopped' where id = ${s.S}`;
    s.r.tick(5 * SEC);
    await s.phoneBeat("publishing");
    s.r.tick(5 * SEC);
    await s.phoneBeat("publishing");
    expect(await cols(s.S), "completed").toEqual(before);
    await expect(heartbeat(s.S, s.jobToken, { state: "playing" }, s.r.deps)).rejects.toSatisfy((e) => e instanceof HttpError && e.status === 410);
  });

  it("the session ends while the beat is in flight: the beat that would have been an edge, held at the row lock until the session completes, moves nothing", async () => {
    const s = await composedRig();
    s.r.tick(5 * SEC);
    await s.phoneBeat("publishing");
    s.r.tick(5 * SEC);
    await s.phoneBeat("reconnecting");
    const before = await cols(s.S);
    expect(before).toMatchObject({ phone_live_edge: 0, phone_live: false });

    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    let locked!: () => void;
    const holding = new Promise<void>((res) => { locked = res; });
    // The session row is held; the beat reads the session as OPEN (a plain read), then waits for the lock.
    const ender = sql.begin(async (tx) => {
      await tx`select id from fixture_stream_sessions where id = ${s.S} for update`;
      locked();
      await gate;
      await tx`update fixture_stream_sessions set state = 'completed', end_reason = 'stopped' where id = ${s.S}`;
    });
    await holding;
    s.r.tick(5 * SEC);
    const inFlight = s.phoneBeat("publishing");
    // Wait until the beat is genuinely blocked on the row lock — otherwise this test would pass without reaching the guard.
    let blocked = 0;
    for (let i = 0; i < 100 && blocked === 0; i++) {
      [{ n: blocked }] = await sql<{ n: number }[]>`
        select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query ilike '%phone_live_edge%' and pid <> pg_backend_pid()` as { n: number }[];
      if (blocked === 0) await new Promise((res) => setTimeout(res, 50));
    }
    expect(blocked, "PREMISE: the beat is waiting on the session's row lock").toBeGreaterThan(0);
    release();
    await ender;
    await inFlight;
    expect(await cols(s.S), "the ended session's tracker is untouched").toEqual(before);
  });

  it("RACE: two copies of one beat in flight after a silence give ONE edge, not two — the silence is judged once, on the pairing row under its lock", async () => {
    const s = await composedRig();
    s.r.tick(5 * SEC);
    await s.phoneBeat("publishing");
    // The phone goes quiet for the whole window while the relay keeps beating; then one beat is sent twice (the phone abandons a
    // beat after 10 s and sends the next, so the stuck one and its successor can land together).
    await s.silentFor(await notRespondingAfterS(s.S));
    expect(await s.relayBeat(), "PREMISE: the first live is 0, the silence not yet judged").toBe(0);
    const pairingId = (await sql<{ pairing_id: string }[]>`select pairing_id from fixture_stream_sessions where id = ${s.S}`)[0]!.pairing_id;
    const lastFlags = async () => (await sql<{ flags: string[] }[]>`
      select flags from fixture_stream_phone_beats where pairing_id = ${pairingId} order by id desc limit 1`)[0]!.flags;

    const dup = body(s.r, s.phone, { sid: s.S, state: "publishing" });
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    let locked!: () => void;
    const holding = new Promise<void>((res) => { locked = res; });
    // A third writer holds the SESSION row, so copy A stops after it took the pairing row and before it commits.
    const holder = sql.begin(async (tx) => {
      await tx`select id from fixture_stream_sessions where id = ${s.S} for update`;
      locked();
      await gate;
    });
    await holding;
    const a = postBeat(s.r.code, s.r.tok, dup, s.r.deps, s.r.now());
    await lockWaiter("%phone_live_edge%");   // A is blocked on the session row, holding the pairing row
    const b = postBeat(s.r.code, s.r.tok, dup, s.r.deps, s.r.now());
    await lockWaiter("%fixture_stream_pairings%");   // B is queued behind A on the pairing row: it read the same stale silence
    release();
    await holder;
    await Promise.all([a, b]);

    expect(await edgeOf(s.S), "one silence, one edge — however many copies of the beat that ended it").toBe(1);
    expect(await s.relayBeat(), "and that is what the relay is told").toBe(1);
    expect(await lastFlags(), "the second copy found the pairing already beaten: the history no longer says the phone is not responding").not.toContain("not_responding");
    // The positive pair: a later, separate outage is still an edge (the silence is judged afresh from the beat that just moved).
    await s.silentFor(await notRespondingAfterS(s.S));
    s.r.tick(1 * SEC);
    await s.phoneBeat("publishing");
    expect(await s.relayBeat(), "a second silence is a second edge").toBe(2);
  });

  it("a superseded Machine's reply carries no counter: attempt 1's late beat is answered exactly `ending`, while the current attempt is served the count", async () => {
    const s = await composedRig();
    s.r.tick(5 * SEC);
    await s.phoneBeat("publishing");
    s.r.tick(5 * SEC);
    await s.phoneBeat("reconnecting");
    s.r.tick(5 * SEC);
    await s.phoneBeat("publishing");
    expect(await s.relayBeat(), "PREMISE: attempt 1 is served the count (one outage)").toBe(1);
    // Attempt 1's final, with no reason: lost → torn down → the ONE retry boots attempt 2 on its own token.
    await heartbeat(s.S, s.jobToken, { state: "stopped" }, s.r.deps);
    expect(s.r.runner.created, "PREMISE: attempt 2 booted").toHaveLength(2);
    const attempt2 = s.r.runner.created[1]!.jobToken;
    expect(attempt2, "PREMISE: its own token").not.toBe(s.jobToken);

    const late = await heartbeat(s.S, s.jobToken, { state: "playing" }, s.r.deps);
    expect(late, "the stray is told to drain and nothing else: no counter to nudge it with").toEqual({ desiredState: "ending" });
    expect(RelayHeartbeatReply.safeParse(late).success).toBe(true);
    const own = await heartbeat(s.S, attempt2, { state: "playing" }, s.r.deps);
    expect(own, "the current attempt is served the count (the positive pair)").toEqual({ desiredState: "live", phoneLiveEdge: 1 });
  });

  it("through the route: the relay's POST gets the counter inside the house envelope, parsed by the contract's reply twin", async () => {
    const s = await composedRig();
    setRelayDriversForTest({ ingest: s.r.ingest, runner: s.r.runner });
    const post = async () => {
      const res = await beatRoute(
        new Request(`http://app.test/api/internal/relay/sessions/${s.S}/heartbeat`, {
          method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${s.jobToken}` }, body: JSON.stringify({ state: "playing" }),
        }),
        { params: Promise.resolve({ sid: s.S }) },
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok: boolean; data: unknown };
      expect(json.ok).toBe(true);
      return RelayHeartbeatReply.parse(json.data);
    };
    expect(await post(), "no phone history: the field is absent").not.toHaveProperty("phoneLiveEdge");
    await s.phoneBeat("publishing");
    await s.phoneBeat("reconnecting", { at: new Date(s.r.now().getTime() + 1000).toISOString() });
    await s.phoneBeat("publishing", { at: new Date(s.r.now().getTime() + 2000).toISOString() });
    const reply = await post();
    expect(reply.phoneLiveEdge).toBe(1);
    expect(Number.isInteger(reply.phoneLiveEdge) && reply.phoneLiveEdge! >= 0).toBe(true);
  });

  it("it is stored, not remembered: a fresh module graph reads the value back and carries on from it", async () => {
    const s = await composedRig();
    for (const state of ["publishing", "reconnecting", "publishing", "reconnecting", "publishing"] as const) {
      s.r.tick(5 * SEC);
      await s.phoneBeat(state);
    }
    expect(await s.relayBeat(), "PREMISE: two edges in the first graph").toBe(2);

    vi.resetModules();   // every module-level variable is gone; the pool lives on globalThis
    const freshHeartbeat = (await import("../stream-sessions")).heartbeat;
    const freshPostBeat = (await import("../capture-phone")).postBeat;
    expect(freshHeartbeat, "PREMISE: a different module instance").not.toBe(heartbeat);
    const reply = await freshHeartbeat(s.S, s.jobToken, { state: "playing" }, s.r.deps);
    expect((reply as { phoneLiveEdge?: number }).phoneLiveEdge, "read back from the row").toBe(2);

    s.r.tick(5 * SEC);
    await freshPostBeat(s.r.code, s.r.tok, body(s.r, s.phone, { sid: s.S, state: "reconnecting" }), s.r.deps, s.r.now());
    s.r.tick(5 * SEC);
    await freshPostBeat(s.r.code, s.r.tok, body(s.r, s.phone, { sid: s.S, state: "publishing" }), s.r.deps, s.r.now());
    const next = await freshHeartbeat(s.S, s.jobToken, { state: "playing" }, s.r.deps);
    expect((next as { phoneLiveEdge?: number }).phoneLiveEdge, "the fresh graph's edge continues the stored count").toBe(3);
  });
});

// The sessions of ONE fixture never share a counter: a new session starts with no history.
describe.skipIf(!HAS_DB)("the phone-live edge — per session", () => {
  it("a session that finished with a counter of 1 leaves the NEXT session of the same fixture with none, and the old one's count stands", async () => {
    const r = await captureRig({ credits: 2, connectAfterMs: NEVER });
    const phone = phoneId("a");
    await pairPresentPhone(r.fixtureId, { phone, at: r.now() });
    const first = (await createSession(r.auth, r.fixtureId, { mode: "composed", targetId: r.target.id }, r.deps)).sessionId;
    for (const state of ["publishing", "reconnecting", "publishing"] as const) {
      r.tick(5 * SEC);
      await postBeat(r.code, r.tok, body(r, phone, { sid: first, state }), r.deps, r.now());
    }
    expect(await edgeOf(first), "PREMISE: the first session has a counter").toBe(1);
    // The first session is over (a raw move, the rig header's way: only the READ is under test, never `decide`).
    await sql`update fixture_stream_sessions set state = 'completed', end_reason = 'stopped' where id = ${first}`;
    r.tick(5 * SEC);
    await pairPresentPhone(r.fixtureId, { at: r.now() });
    const second = (await createSession(r.auth, r.fixtureId, { mode: "composed", targetId: r.target.id }, r.deps)).sessionId;
    expect(second).not.toBe(first);
    expect(await cols(second), "a new session starts with no history").toEqual({ phone_live_edge: null, phone_live: null, phone_live_beat_at: null });
    r.tick(5 * SEC);
    await postBeat(r.code, r.tok, body(r, phone, { sid: second, state: "publishing" }), r.deps, r.now());
    expect(await edgeOf(second), "its first live is 0, not 2").toBe(0);
    expect(await edgeOf(first), "the old one's count stands").toBe(1);
  });
});
