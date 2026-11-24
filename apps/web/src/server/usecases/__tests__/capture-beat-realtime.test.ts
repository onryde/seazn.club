// Push nudges (spec 2026-11-24 §2.1, plan Task 5 / T1.3) — the beat answer's `realtime`, minted for the code's CURRENT
// pairing inside `runBeat` (so a fixture code's beat and a court code's, `postCourtBeat` delegating to it, both carry it).
// DB-backed through the REAL code (`postBeat`, the real claim, start, desk Stop, takeover and the phone's own Stop) on the
// capture rig, with a stub realtime port — and through the PROCESS's own port too (the real mint, HS256, verified with jose),
// so the default the production deps resolve is driven, not only the stub (AGENTS class 1).
//
// The rules, typed from the brief and the PUBLISHED contract (docs/contracts/capture-beat.v1.json, read by _capture-realtime),
// never from the code under test:
//   - present on waiting, go-live, live, and on over while the caller is still the current pairing (after a DESK Stop);
//   - absent on taken, on replaced (B took over, then A's beat), and on over after the caller's OWN `ended` (T21 ended its
//     pairing) — and nothing is minted for those beats;
//   - a mint that throws → the beat is answered and stored, without the key; logged {err, codeId}; Sentry route
//     capture.beat.realtime_mint; the next beat is answered too;
//   - the configured url is served only when its RAW string matches the contract file's url pattern and its host is the
//     one NEXT_PUBLIC_SUPABASE_URL names: http, a foreign host, a padded value and a ?query are each absent and mint
//     nothing; no Supabase configured at all is absent and SILENT;
//   - pollSeconds, and the answered_poll_seconds stored, are the same with and without the port;
//   - each current-pairing beat carries a FRESH token (the clock advanced 1 s: a new iat and exp, the same life);
//   - the token's life is the contract prose's ("Each token lives 30 minutes");
//   - another surface: a court code's beat carries capture:{its court pairing};
//   - the token is never in a log line, a console line, a Sentry capture or a stored record.
//
// Applies to another sport: N/A (no sport rules) — the realtime object reads no sport; the court code is the other surface.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { jwtVerify } from "jose";

vi.mock("@/lib/sentry", async (orig) => ({ ...(await orig<typeof import("@/lib/sentry")>()), captureError: vi.fn() }));

import { sql } from "@/lib/db";
import { captureError } from "@/lib/sentry";
import { CAPTURE_REALTIME_URL_RE, CaptureBeat, CaptureBeatAnswer } from "@/server/api-v1/capture-schemas";
import { log } from "@/server/logger";
import { CAPTURE_REALTIME_TTL_SECONDS } from "@/server/relay/config";
import { FakeIngest, FakeRunner } from "@/server/relay/fakes";
import { connect } from "@/server/youtube/__tests__/_connect-rig";
import { FakeYouTube } from "@/server/youtube/fake";
import { postBeat } from "../capture-phone";
import { realtimePairingOf } from "../capture-realtime";
import { linkCourtStream } from "../court-streams";
import { stopSession, type SessionDeps } from "../stream-sessions";
import { captureRig, override, phoneId, type CaptureRig } from "./_capture-rig";
import {
  RIG_ANON_KEY, RIG_SUPABASE_URL, contractAnswerBranches, contractRealtimeNodes, contractTokenSeconds, contractUrlPatterns,
  stubRealtime, type StubRealtime,
} from "./_capture-realtime";
import { at, seedDay } from "./_match-day-seed";

const HAS_DB = !!process.env.DATABASE_URL;

const SUPABASE_KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_JWT_SECRET", "SUPABASE_JWT_PRIVATE_KEY",
  "SUPABASE_JWT_SIGNING_KEY_B64", "SUPABASE_JWT_ALG", "SUPABASE_JWT_KID",
] as const;
const ENV_KEYS = [
  "RELAY_KEK", "AUTH_SECRET", "OAUTH_BASE_URL", "NEXT_PUBLIC_BASE_URL", "STREAM_PLAYBACK_HOST", "STREAM_SRT_ENABLED", "RELAY_DRIVERS",
  "YOUTUBE_TOKEN_KEK", "COURT_MIN_APP_VERSION", ...SUPABASE_KEYS,
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const KEK = randomBytes(32).toString("hex");
const YT_KEK = randomBytes(32).toString("hex");
const COURT_BUILD = "1.0.14-1200";
/** The HS256 secret the process port signs with here (a long random string, never uuid-shaped). */
const JWT_SECRET = `realtime-beat-test-${randomBytes(24).toString("hex")}`;
function baseEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.RELAY_KEK = KEK;
  process.env.AUTH_SECRET = "capture-beat-realtime-test-secret";
  process.env.YOUTUBE_TOKEN_KEK = YT_KEK;
  process.env.COURT_MIN_APP_VERSION = COURT_BUILD;
  // The project the stub port names: the guard compares the configured url's host with this one.
  process.env.NEXT_PUBLIC_SUPABASE_URL = RIG_SUPABASE_URL;
}
/** The PROCESS's own port is configured: its project, its public key, an HS256 signing secret. */
function processPortEnv(url: string = RIG_SUPABASE_URL) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = url;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = RIG_ANON_KEY;
  process.env.SUPABASE_JWT_SECRET = JWT_SECRET;
  process.env.SUPABASE_JWT_ALG = "HS256";
}
beforeAll(baseEnv);
beforeEach(() => { baseEnv(); vi.mocked(captureError).mockClear(); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
afterAll(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

type Beat = CaptureBeat;
type Answer = CaptureBeatAnswer;
type Realtime = NonNullable<Extract<Answer, { state: "waiting" }>["realtime"]>;
const SEC = 1000;
const CONNECT_MS = 3000;
const NEVER = 3_600_000;
/** After an armed beat has already polled the input, the next poll must fall outside the coalesced window to see it connect. */
const PAST_CONNECT_MS = 15_000;
const TOKEN_S = contractTokenSeconds();
/** The realtime object's keys, as the published file declares them. */
const REALTIME_KEYS = Object.keys(contractRealtimeNodes()[0]!.properties).sort();
const MINT_ROUTE = "capture.beat.realtime_mint";

function body(r: CaptureRig, phone: string, over: Partial<Beat> = {}): Beat {
  return CaptureBeat.parse({
    code: r.code, slot: 0, phone, claim: null, device: null, sid: null, at: r.now().toISOString(), state: "paired",
    cause: null, notReady: null, startFailed: null, stopped: null, mode: "operator", transport: null, bitrateKbps: null,
    delivery: "unknown", deliveredLagS: null, audioOk: null, battery: null, thermal: null, dataUsedMB: null,
    appVersion: "capture-test/1", ...over,
  });
}
/** A beat through the REAL `postBeat`; the answer is parsed by the contract's zod twin and kept exactly. */
async function post(r: CaptureRig, phone: string, over: Partial<Beat> = {}, deps: SessionDeps = r.deps): Promise<Answer> {
  const a = await postBeat(r.code, r.tok, body(r, phone, over), deps, r.now());
  expect(CaptureBeatAnswer.parse(a)).toEqual(a);
  return a;
}
const rtOf = (a: Answer): Realtime | undefined => (a as { realtime?: Realtime }).realtime;
/** A capture rig whose deps carry `port` (default: a recording stub on the rig's project). */
async function rig(o: Parameters<typeof captureRig>[0] = {}, port: StubRealtime = stubRealtime()) {
  const r = await captureRig(o);
  r.deps.realtime = port;
  return { r, port };
}
/** The phone's latest pairing on the rig's fixture (any code). */
async function pairingOf(r: CaptureRig, phone: string) {
  const rows = await sql<{ id: string; ended_at: Date | null; end_cause: string | null; last_beat_at: Date; answered_poll_seconds: number }[]>`
    select p.id, p.ended_at, p.end_cause, p.last_beat_at, p.answered_poll_seconds
      from fixture_stream_pairings p join fixture_stream_codes c on c.id = p.code_id
     where c.fixture_id = ${r.fixtureId} and p.phone = ${phone} order by p.claimed_at desc, p.id desc limit 1`;
  expect(rows, `PREMISE: ${phone} has a pairing`).toHaveLength(1);
  return rows[0]!;
}
const mintFailures = () =>
  vi.mocked(captureError).mock.calls.filter(([, ctx]) => (ctx as { route?: string } | undefined)?.route === MINT_ROUTE);

/** Served: the five keys, the rig's project, the pairing's own topic, the token the port's LAST mint made for that pairing
 *  at this beat's clock, and an expiry the contract's token life after it. */
function expectServed(a: Answer, o: { pairingId: string; now: Date; port: StubRealtime }): Realtime {
  const rt = rtOf(a);
  expect(rt, `${a.state}: realtime served to the current pairing`).toBeDefined();
  expect(Object.keys(rt!).sort()).toEqual(REALTIME_KEYS);
  expect(rt).toMatchObject({ url: RIG_SUPABASE_URL, apikey: RIG_ANON_KEY, topic: `capture:${o.pairingId}` });
  expect(rt!.expiresAt, "the contract's token life after the beat's server clock").toBe(Math.floor(o.now.getTime() / SEC) + TOKEN_S);
  const last = o.port.mints.at(-1);
  expect(last, "the port minted for this beat").toMatchObject({ pairingId: o.pairingId, token: rt!.token });
  expect(last!.expiresAt.getTime()).toBe(o.now.getTime() + TOKEN_S * SEC);
  return rt!;
}

describe("the contract's realtime facts are the server's (pins read from the published file)", () => {
  it("CAPTURE_REALTIME_TTL_SECONDS is the prose's \"Each token lives N minutes\", on every realtime node", () => {
    expect(contractRealtimeNodes().length, "realtime nodes read").toBe(4);
    expect(CAPTURE_REALTIME_TTL_SECONDS).toBe(contractTokenSeconds());
  });

  it("the url guard's pattern IS the file's, on every realtime node — the twin's z.url() trims, so the raw string is tested against this", () => {
    const patterns = contractUrlPatterns();
    expect(patterns.length, "url patterns read").toBe(4);
    for (const p of patterns) expect(CAPTURE_REALTIME_URL_RE.source).toBe(p);
  });

  it("realtimePairingOf: the caller's pairing, only when it is the post-commit holder, only on the branches the FILE admits realtime on", () => {
    const branches = contractAnswerBranches();
    expect(branches.map((b) => b.state).sort(), "every answer branch read").toEqual(["go-live", "live", "over", "replaced", "taken", "waiting"]);
    const P = randomUUID();
    const Q = randomUUID();
    const pairs: [mine: string | null, holder: string | null][] = [[P, P], [P, Q], [null, Q], [P, null], [null, null]];
    let rows = 0;
    let served = 0;
    for (const b of branches) {
      for (const [mineId, holderId] of pairs) {
        const want = b.realtime && mineId !== null && mineId === holderId ? mineId : null;
        expect(realtimePairingOf({ mineId, holderId, state: b.state as Answer["state"] }), `${b.state} mine=${mineId === P ? "P" : mineId} holder=${holderId === P ? "P" : holderId === Q ? "Q" : holderId}`).toBe(want);
        rows++;
        if (want !== null) served++;
      }
    }
    expect(rows).toBe(30);
    expect(served, "one served row per branch that admits realtime").toBe(4);
  });
});

describe.skipIf(!HAS_DB)("the beat answer's realtime — the current pairing only", () => {
  it("present on waiting, go-live and live — and on over after a DESK Stop, the caller still the current pairing; every mint is its pairing's", async () => {
    const { r, port } = await rig({ credits: 1, connectAfterMs: CONNECT_MS });
    const A = phoneId("a");
    const waiting = await post(r, A, { claim: "new" });
    expect(waiting.state).toBe("waiting");
    const pid = (await pairingOf(r, A)).id;
    expectServed(waiting, { pairingId: pid, now: r.now(), port });
    const S = await r.start(A);
    expect((await pairingOf(r, A)).id, "PREMISE: the start keeps A's pairing").toBe(pid);
    r.tick(SEC);
    const goLive = await post(r, A, { sid: S, state: "armed" });
    expect(goLive).toMatchObject({ state: "go-live", sid: S });
    expectServed(goLive, { pairingId: pid, now: r.now(), port });
    r.tick(PAST_CONNECT_MS);
    const live = await post(r, A, { sid: S, state: "publishing", transport: "srt" });
    expect(live).toMatchObject({ state: "live", sid: S });
    expectServed(live, { pairingId: pid, now: r.now(), port });
    await stopSession(r.auth, r.fixtureId, S, r.deps);
    r.tick(SEC);
    const over = await post(r, A, { sid: S, state: "publishing", transport: "srt" });
    expect(over).toMatchObject({ state: "over", sid: S });
    expect(await pairingOf(r, A), "PREMISE: a desk Stop leaves the pairing standing").toMatchObject({ id: pid, ended_at: null });
    expectServed(over, { pairingId: pid, now: r.now(), port });
    expect(port.mints.map((m) => m.pairingId)).toEqual([pid, pid, pid, pid]);
    expect(mintFailures()).toEqual([]);
  });

  it("absent on taken: B's refused claim on A's live, beating slot mints nothing — and A's next beat is still served", async () => {
    const { r, port } = await rig({ credits: 1, connectAfterMs: CONNECT_MS });
    const [A, B] = [phoneId("a"), phoneId("b")];
    await post(r, A, { claim: "new" });
    const S = await r.start(A);
    r.tick(CONNECT_MS);
    expect(await post(r, A, { sid: S, state: "publishing", transport: "srt" }), "PREMISE: live").toMatchObject({ state: "live" });
    r.tick(5 * SEC);
    const before = port.mints.length;
    const taken = await post(r, B, { claim: "new" });
    expect(taken.state).toBe("taken");
    expect(taken).not.toHaveProperty("realtime");
    expect(port.mints.length, "nothing minted for a refused claim").toBe(before);
    r.tick(5 * SEC);
    const again = await post(r, A, { sid: S, state: "publishing", transport: "srt" });
    expect(again.state).toBe("live");
    expectServed(again, { pairingId: (await pairingOf(r, A)).id, now: r.now(), port });
    expect(mintFailures()).toEqual([]);
  });

  it("absent on replaced: B's claim takes A's paired slot (B is served ITS pairing), then A's beats — twice — are replaced and mint nothing", async () => {
    const { r, port } = await rig();
    const [A, B] = [phoneId("a"), phoneId("b")];
    const a0 = await post(r, A, { claim: "new" });
    const aPid = (await pairingOf(r, A)).id;
    expectServed(a0, { pairingId: aPid, now: r.now(), port });
    r.tick(5 * SEC);
    const b0 = await post(r, B, { claim: "new" });
    expect(b0.state).toBe("waiting");
    const bPid = (await pairingOf(r, B)).id;
    expect(bPid, "PREMISE: B holds its own pairing").not.toBe(aPid);
    expectServed(b0, { pairingId: bPid, now: r.now(), port });
    const before = port.mints.length;
    for (let i = 0; i < 2; i++) {
      r.tick(5 * SEC);
      const a = await post(r, A);
      expect(a.state).toBe("replaced");
      expect(a).not.toHaveProperty("realtime");
    }
    expect(port.mints.length, "nothing minted for a replaced caller").toBe(before);
    expect(mintFailures()).toEqual([]);
  });

  it("absent on over after the caller's OWN `ended` (T21 ends its pairing): nothing minted for it, and its next beat is replaced", async () => {
    const { r, port } = await rig({ connectAfterMs: NEVER });
    const A = phoneId("a");
    await post(r, A, { claim: "new" });
    const S = await r.start(A);
    const before = port.mints.length;
    expect(before, "PREMISE: the claim was served").toBe(1);
    const over = await post(r, A, { sid: S, state: "ended", endReason: "operator-stopped" });
    expect(over).toMatchObject({ state: "over", sid: S, endReason: "stopped" });
    expect(await pairingOf(r, A), "PREMISE: T21 ended the pairing").toMatchObject({ end_cause: "operator_stopped" });
    expect(over).not.toHaveProperty("realtime");
    expect(port.mints.length, "nothing minted for a pairing its own Stop ended").toBe(before);
    r.tick(5 * SEC);
    const next = await post(r, A, { sid: S, state: "ended", endReason: "operator-stopped" });
    expect(next.state).toBe("replaced");
    expect(next).not.toHaveProperty("realtime");
    expect(port.mints.length).toBe(before);
    expect(mintFailures()).toEqual([]);
  });

  it("a mint that THROWS never fails the beat: answered without the key, the beat stored, logged {err, codeId} with Sentry route capture.beat.realtime_mint — on the next beat too", async () => {
    const port = stubRealtime({ mint: async () => { throw new Error("signing key unavailable"); } });
    const errors = vi.spyOn(log, "error");
    const { r } = await rig({}, port);
    const A = phoneId("a");
    const [{ id: codeId }] = await sql<{ id: string }[]>`select id from fixture_stream_codes where fixture_id = ${r.fixtureId} and ended_at is null`;
    let answered = 0;
    for (const over of [{ claim: "new" as const }, {}]) {
      const a = await post(r, A, over);
      expect(a.state).toBe("waiting");
      expect(a).not.toHaveProperty("realtime");
      const p = await pairingOf(r, A);
      expect(p.last_beat_at.getTime(), "the beat is stored on the server's clock").toBe(r.now().getTime());
      expect(p.answered_poll_seconds, "and its answered cadence").toBe(a.pollSeconds);
      answered++;
      r.tick(10 * SEC);
    }
    expect(answered).toBe(2);
    const mintLogs = errors.mock.calls.filter(([o]) => (o as { codeId?: string } | undefined)?.codeId === codeId);
    expect(mintLogs).toHaveLength(2);
    for (const [o, msg] of mintLogs) {
      expect(o).toEqual({ err: "Error: signing key unavailable", codeId });
      expect(String(msg)).toMatch(/realtime/);
    }
    const sentry = mintFailures();
    expect(sentry).toHaveLength(2);
    for (const [err] of sentry) expect(String(err)).toBe("Error: signing key unavailable");
    expect(port.mints, "a throwing mint made no token").toEqual([]);
  });
});

describe.skipIf(!HAS_DB)("the beat answer's realtime — the configured project", () => {
  it("served only when the configured url's RAW string matches the contract file's pattern and its host is NEXT_PUBLIC_SUPABASE_URL's: http, a foreign host, padded and ?query are absent and mint nothing; the clean url is served", async () => {
    const { r } = await rig();
    const A = phoneId("a");
    await post(r, A, { claim: "new" });
    const pid = (await pairingOf(r, A)).id;
    const warns = vi.spyOn(log, "warn");
    const host = new URL(RIG_SUPABASE_URL).host;
    const refusedUrls = [
      `http://${host}`,                       // not https
      "https://evil.example.org",             // a foreign host
      `https://${host}.evil.example.org`,     // a foreign host that starts with the project's
      ` ${RIG_SUPABASE_URL}`,                 // padded (z.url() alone would trim it)
      `${RIG_SUPABASE_URL}\n`,                // a trailing newline, as an env file copy leaves it
      `${RIG_SUPABASE_URL}/?apikey=x`,        // a query: a token or key never rides a URL
      `${RIG_SUPABASE_URL}#frag`,             // a fragment
      `https://user@${host}`,                 // userinfo
    ];
    let refused = 0;
    for (const url of refusedUrls) {
      const port = stubRealtime({ config: { url, apikey: RIG_ANON_KEY } });
      r.tick(5 * SEC);
      const a = await post(r, A, {}, { ...r.deps, realtime: port });
      expect(a.state).toBe("waiting");
      expect(a, JSON.stringify(url)).not.toHaveProperty("realtime");
      expect(port.mints, `${JSON.stringify(url)}: nothing minted`).toEqual([]);
      refused++;
    }
    expect(refused).toBe(refusedUrls.length);
    expect(warns.mock.calls.length, "each refusal is logged").toBe(refusedUrls.length);
    for (const call of warns.mock.calls) {
      for (const url of refusedUrls) expect(JSON.stringify(call), "a refusal never logs the configured url").not.toContain(JSON.stringify(url).slice(1, -1));
    }
    // An empty apikey is not the contract's (1..512): refused too.
    const noKey = stubRealtime({ config: { url: RIG_SUPABASE_URL, apikey: "" } });
    r.tick(5 * SEC);
    expect(await post(r, A, {}, { ...r.deps, realtime: noKey })).not.toHaveProperty("realtime");
    expect(noKey.mints).toEqual([]);
    // Its positive pair: the clean project url on the same rig.
    const clean = stubRealtime();
    r.tick(5 * SEC);
    expectServed(await post(r, A, {}, { ...r.deps, realtime: clean }), { pairingId: pid, now: r.now(), port: clean });
    // The env's project is the yardstick: the same clean url with NEXT_PUBLIC_SUPABASE_URL naming another project is refused.
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://otherproject.supabase.co";
    const elsewhere = stubRealtime();
    r.tick(5 * SEC);
    expect(await post(r, A, {}, { ...r.deps, realtime: elsewhere })).not.toHaveProperty("realtime");
    expect(elsewhere.mints).toEqual([]);
  });

  it("the PROCESS's own port (no port in the deps): the env's padded value, a ?query and an http url are absent; nothing configured is absent and SILENT; the clean env is served a real token", async () => {
    const r = await captureRig();
    expect(r.deps.realtime, "PREMISE: the rig names no port").toBeUndefined();
    const A = phoneId("a");
    await post(r, A, { claim: "new" });
    const pid = (await pairingOf(r, A)).id;
    const warns = vi.spyOn(log, "warn");
    const errors = vi.spyOn(log, "error");
    const refused = [` ${RIG_SUPABASE_URL}`, `${RIG_SUPABASE_URL}?apikey=x`, "http://127.0.0.1:54321"];
    let n = 0;
    for (const url of refused) {
      processPortEnv(url);
      r.tick(5 * SEC);
      const a = await post(r, A);
      expect(a, JSON.stringify(url)).not.toHaveProperty("realtime");
      n++;
    }
    expect(n).toBe(3);
    expect(warns.mock.calls.length, "each configured-but-refused url is logged").toBe(3);
    // EMPTY: no Supabase configured (CI's smoke server, a bare dev box) — absent, and nothing logged.
    for (const k of SUPABASE_KEYS) delete process.env[k];
    r.tick(5 * SEC);
    expect(await post(r, A)).not.toHaveProperty("realtime");
    expect(warns.mock.calls.length, "nothing configured is not a refusal").toBe(3);
    // The positive pair: the clean env is served, through the real mint.
    processPortEnv();
    r.tick(5 * SEC);
    const a = await post(r, A);
    const rt = rtOf(a);
    expect(rt).toMatchObject({ url: RIG_SUPABASE_URL, apikey: RIG_ANON_KEY, topic: `capture:${pid}` });
    const { payload } = await jwtVerify(rt!.token, new TextEncoder().encode(JWT_SECRET), { audience: "authenticated", currentDate: r.now() });
    expect(payload).toMatchObject({ role: "authenticated", sub: `capture:${pid}`, capture_pairing_id: pid, exp: rt!.expiresAt });
    expect(errors.mock.calls.filter(([o]) => typeof (o as { err?: unknown })?.err === "string")).toEqual([]);
  });
});

describe.skipIf(!HAS_DB)("the beat answer's realtime — sequences", () => {
  it("REGRESSION: pollSeconds and the stored answered_poll_seconds are the same with and without the port, on waiting, go-live, live and over", async () => {
    const { r, port } = await rig({ credits: 1, connectAfterMs: CONNECT_MS });
    const A = phoneId("a");
    // Without: the process's own port, which serves nothing here (baseEnv sets no NEXT_PUBLIC_SUPABASE_ANON_KEY).
    const without: SessionDeps = { ...r.deps, realtime: undefined };
    const pair = async (over: Partial<Beat>, state: Answer["state"]) => {
      const withRt = await post(r, A, over);
      expect(withRt.state).toBe(state);
      expect(rtOf(withRt), `${state}: served with the port`).toBeDefined();
      const storedWith = (await pairingOf(r, A)).answered_poll_seconds;
      r.tick(SEC);
      const withoutRt = await post(r, A, { ...over, claim: null }, without);
      expect(withoutRt.state).toBe(state);
      expect(withoutRt, `${state}: absent without the port`).not.toHaveProperty("realtime");
      const storedWithout = (await pairingOf(r, A)).answered_poll_seconds;
      expect(withoutRt.pollSeconds, `${state}: the same cadence`).toBe(withRt.pollSeconds);
      expect(storedWith, `${state}: the stored cadence is the one answered`).toBe(withRt.pollSeconds);
      expect(storedWithout).toBe(storedWith);
      r.tick(SEC);
    };
    await pair({ claim: "new" }, "waiting");
    const S = await r.start(A);
    await pair({ sid: S, state: "armed" }, "go-live");
    r.tick(PAST_CONNECT_MS);
    await pair({ sid: S, state: "publishing", transport: "srt" }, "live");
    await stopSession(r.auth, r.fixtureId, S, r.deps);
    await pair({ sid: S, state: "publishing", transport: "srt" }, "over");
    expect(port.mints.length, "four states compared, each served once").toBe(4);
  });

  it("SECOND beat → a FRESH token: the clock advanced 1 s gives a new iat and exp, the same life, the same pairing (the real mint)", async () => {
    processPortEnv();
    vi.useFakeTimers({ toFake: ["Date"] });
    const r = await captureRig();
    const A = phoneId("a");
    vi.setSystemTime(r.now());
    const first = rtOf(await post(r, A, { claim: "new" }));
    r.tick(SEC);
    vi.setSystemTime(r.now());
    const second = rtOf(await post(r, A));
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    const pid = (await pairingOf(r, A)).id;
    const key = new TextEncoder().encode(JWT_SECRET);
    const p1 = (await jwtVerify(first!.token, key, { audience: "authenticated", currentDate: r.now() })).payload;
    const p2 = (await jwtVerify(second!.token, key, { audience: "authenticated", currentDate: r.now() })).payload;
    expect(second!.token).not.toBe(first!.token);
    expect(p2.iat! - p1.iat!, "a new iat").toBe(1);
    expect(p2.exp! - p1.exp!, "a new exp").toBe(1);
    for (const [p, rt] of [[p1, first!], [p2, second!]] as const) {
      expect(p.exp! - p.iat!, "the contract's token life").toBe(TOKEN_S);
      expect(p.exp).toBe(rt.expiresAt);
      expect(p).toMatchObject({ capture_pairing_id: pid, sub: `capture:${pid}` });
      expect(rt.topic).toBe(`capture:${pid}`);
    }
  });

  it("ANOTHER SURFACE: a court code's beat (postCourtBeat → runBeat) carries capture:{its court pairing}", async () => {
    const day = await seedDay();
    await override(day.orgId, "streaming.relay", true);
    await override(day.orgId, "streaming.overlay", true);
    const c = await connect({ auth: day.auth, orgId: day.orgId, userId: day.auth.userId! });
    let now = at(0).getTime();
    const ingest = new FakeIngest({ clock: () => now, connectAfterMs: CONNECT_MS });
    ingest.storage = { totalStorageMinutes: 0, totalStorageMinutesLimit: 100_000_000, videoCount: 0 };
    const port = stubRealtime();
    const deps: SessionDeps = {
      drivers: { ingest, runner: new FakeRunner() }, now: () => new Date(now), appUrl: "http://app.test",
      youtube: new FakeYouTube({ now: () => new Date(now) }), realtime: port,
    };
    const shown = await linkCourtStream(day.auth, day.comp.id, { courtId: day.courts.c2, targetId: c.targetId, day: "2026-11-07" }, at(0));
    const qr = { code: shown.qr!.code, tok: shown.qr!.tok };
    const [{ id: codeId }] = await sql<{ id: string }[]>`select id from fixture_stream_codes where court_link_id = ${shown.id}`;
    const phone = phoneId("court");
    const courtBody = (over: Partial<Beat> = {}): Beat => CaptureBeat.parse({
      code: qr.code, slot: 0, phone, claim: null, device: null, sid: null, at: new Date(now).toISOString(), state: "paired",
      cause: null, notReady: null, startFailed: null, stopped: null, mode: "operator", transport: null, bitrateKbps: null,
      delivery: "unknown", deliveredLagS: null, audioOk: null, battery: null, thermal: null, dataUsedMB: null, appVersion: COURT_BUILD, ...over,
    });
    let served = 0;
    for (const over of [{ claim: "new" as const }, {}]) {
      const a = await postBeat(qr.code, qr.tok, courtBody(over), deps, new Date(now));
      expect(CaptureBeatAnswer.parse(a)).toEqual(a);
      const [p] = await sql<{ id: string }[]>`select id from fixture_stream_pairings where code_id = ${codeId} and phone = ${phone} and ended_at is null`;
      expect(p, "PREMISE: the court phone holds a pairing on the court's code").toBeDefined();
      expect(rtOf(a), `${a.state}: the court pairing is served`).toMatchObject({ topic: `capture:${p!.id}`, url: RIG_SUPABASE_URL });
      expect(port.mints.at(-1)).toMatchObject({ pairingId: p!.id, token: rtOf(a)!.token });
      served++;
      now += 10 * SEC;
    }
    expect(served).toBe(2);
  });
});

describe.skipIf(!HAS_DB)("the token is a secret", () => {
  it("never in a log line, a console line, a Sentry capture or a stored record — across a served sequence, a refusal and a failed mint", async () => {
    const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
    const CONSOLE = ["log", "info", "warn", "error", "debug"] as const;
    const spies = [
      ...LEVELS.map((l) => vi.spyOn(log, l)),
      ...CONSOLE.map((m) => vi.spyOn(console, m)),
      vi.mocked(captureError),
    ];
    processPortEnv();
    const r = await captureRig({ credits: 1, connectAfterMs: CONNECT_MS });   // the PROCESS port: real JWTs
    const [A, B] = [phoneId("a"), phoneId("b")];
    const tokens: string[] = [];
    const keep = (a: Answer) => { const rt = rtOf(a); if (rt) tokens.push(rt.token); return a; };
    keep(await post(r, A, { claim: "new" }));
    const S = await r.start(A);
    r.tick(SEC);
    keep(await post(r, A, { sid: S, state: "armed" }));
    r.tick(PAST_CONNECT_MS);
    keep(await post(r, A, { sid: S, state: "publishing", transport: "srt" }));
    r.tick(5 * SEC);
    keep(await post(r, B, { claim: "new" }));   // taken
    await stopSession(r.auth, r.fixtureId, S, r.deps);
    r.tick(SEC);
    keep(await post(r, A, { sid: S, state: "publishing", transport: "srt" }));   // over, still current
    // A refusal (warn) and a failed mint (error + Sentry) on the same pairing, so our own lines are among those scanned.
    r.tick(SEC);
    keep(await post(r, A, {}, { ...r.deps, realtime: stubRealtime({ config: { url: "http://rigproject.supabase.co", apikey: RIG_ANON_KEY } }) }));
    r.tick(SEC);
    keep(await post(r, A, {}, { ...r.deps, realtime: stubRealtime({ mint: async () => { throw new Error("mint down"); } }) }));
    expect(tokens.length, "real tokens minted across the sequence").toBe(4);
    expect(new Set(tokens).size, "each beat's own").toBe(4);

    const text = (v: unknown): string => {
      if (typeof v === "string") return v;
      if (v instanceof Error) return `${v.name}: ${v.message}\n${v.stack ?? ""}\n${JSON.stringify(v, Object.getOwnPropertyNames(v))}`;
      try {
        return JSON.stringify(v, (_k, x: unknown) => (x instanceof Error ? `${x.name}: ${x.message} ${x.stack ?? ""}` : typeof x === "bigint" ? String(x) : x)) ?? String(v);
      } catch {
        return String(v);
      }
    };
    let scanned = 0;
    for (const spy of spies) {
      for (const args of spy.mock.calls as unknown[][]) {
        const line = args.map(text).join(" ");
        for (const t of tokens) expect(line.includes(t), `a ${spy.getMockName()} call carries a token`).toBe(false);
        scanned++;
      }
    }
    expect(scanned, "log/console/Sentry calls scanned").toBeGreaterThan(0);
    expect(vi.mocked(log.warn).mock.calls.length, "PREMISE: the refusal was logged (and scanned)").toBeGreaterThan(0);
    expect(mintFailures().length, "PREMISE: the failed mint was captured (and scanned)").toBe(1);

    // Records: every row this fixture's capture wrote, whole.
    const rows = await sql<{ t: string }[]>`
      select row_to_json(p)::text as t from fixture_stream_pairings p join fixture_stream_codes c on c.id = p.code_id where c.fixture_id = ${r.fixtureId}
      union all select row_to_json(c)::text from fixture_stream_codes c where c.fixture_id = ${r.fixtureId}
      union all select row_to_json(s)::text from fixture_stream_sessions s where s.fixture_id = ${r.fixtureId}
      union all select row_to_json(e)::text from fixture_stream_events e join fixture_stream_sessions s on s.id = e.session_id where s.fixture_id = ${r.fixtureId}
      union all select row_to_json(b)::text from fixture_stream_phone_beats b join fixture_stream_pairings p on p.id = b.pairing_id
        join fixture_stream_codes c on c.id = p.code_id where c.fixture_id = ${r.fixtureId}`;
    expect(rows.length, "records scanned").toBeGreaterThan(5);
    for (const { t } of rows) for (const tok of tokens) expect(t.includes(tok), "a stored record carries a token").toBe(false);
  });
});
