// Court stream, the per-match Stream switch (spec 2026-11-14 §5.2; plan Task 4). Real Postgres required; skipped without
// DATABASE_URL. Rules under test are the brief's, typed here: the switch is OFF by default and turning it on spends no
// credit; it is refused by name when the match has its own ACTIVE code (has_own_stream_code) or its court has no live link
// now (court_not_streaming); turning off is never refused; ensure/reissue refuse a court-streamed match (court_streamed);
// and a mint racing a switch-on has exactly one winner, the loser refused by name.
//
// Web G (controller's rulings on the owner's "Ok", 2026-11-18), typed here, never imported from the code under test: the own
// code refuses ON while it COMPETES — it has never had a session (unscanned, perhaps printed: never withdrawn silently), a
// phone holds it (a current pairing whose last beat is within §6.9's present window, max(60 s floor, cadence + 30 s)), or a
// session of the match is requested/provisioning/warming/live/ending. A USED, now idle code does not compete: ON succeeds
// and, in the same transaction, ends the own code (`withdrawn`, by the organiser, tok wiped; never deleted, its
// ended sessions stay); the phone that comes back to it is refused `401 code_ended`; the desk's `own_stream_code` reads the
// same predicate. A refused ON (either reason) retires nothing.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

// Pass-through wrapper on the fixture code's sealed insert, so a test can hold a mint open between its reads and its write.
const hold = vi.hoisted(() => ({ gate: null as null | (() => Promise<void>) }));
vi.mock("@/server/relay/secret-columns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/relay/secret-columns")>();
  return {
    ...actual,
    insertStreamCode: ((...a: Parameters<typeof actual.insertStreamCode>) =>
      (hold.gate ? hold.gate() : Promise.resolve()).then(() => actual.insertStreamCode(...a))) as typeof actual.insertStreamCode,
  };
});

import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { pairPresentPhone, resealTargetDestination, rigApiTarget, rigTarget, sessionOnTarget } from "@/server/relay/__tests__/_session-rig";
import { FakeIngest, FakeRunner } from "@/server/relay/fakes";
import { startBroadcast } from "../stream-sessions";
import type { AuthCtx } from "@/server/api-v1/auth";
import { CaptureRefusalError } from "@/server/api-v1/capture-http";
import type { SessionDeps } from "../stream-sessions/deps";
import { postBeat } from "../capture-phone";
import { courtStreamsForDay, linkCourtStream, setCourtStream, withdrawCourtStream } from "../court-streams";
import { ensureStreamCode, lockFixtureCode, reissueStreamCode } from "../stream-codes";
import { openStreamCodeTok, wipeStreamCodeTok } from "@/server/relay/secret-columns";
import { streamPhone } from "../stream-phone";
import { place, seedDay, type Day } from "./_match-day-seed";

const HAS_DB = !!process.env.DATABASE_URL;
const savedKek = process.env.RELAY_KEK;
const savedMin = process.env.COURT_MIN_APP_VERSION;
beforeAll(() => { process.env.RELAY_KEK = randomBytes(32).toString("hex"); });
beforeEach(() => { process.env.COURT_MIN_APP_VERSION = "1.0.14-1200"; });
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => {
  if (savedKek === undefined) delete process.env.RELAY_KEK; else process.env.RELAY_KEK = savedKek;
  if (savedMin === undefined) delete process.env.COURT_MIN_APP_VERSION; else process.env.COURT_MIN_APP_VERSION = savedMin;
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

async function failure(p: Promise<unknown>): Promise<{ status: number; code?: string }> {
  try { await p; } catch (e) {
    if (e instanceof HttpError) return { status: e.status, code: e.code };
    throw e;
  }
  throw new Error("expected a refusal");
}
const settingsOf = async (fixtureId: string) => {
  const [r] = await sql<{ court_stream: boolean; revision: number; target_id: string | null; target_chosen: boolean }[]>`
    select court_stream, revision::int as revision, target_id, target_chosen from fixture_stream_settings where fixture_id = ${fixtureId}`;
  return r ?? null;
};
const activeCodes = async (fixtureId: string) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_codes where fixture_id = ${fixtureId} and ended_at is null`)[0]!.n;
/** Each code of the match, `sealed` read through the relay's own opener (r3: no stream column is named outside server/relay). */
const codesOf = async (fixtureId: string) => {
  const rows = await sql<{ id: string; ended_at: Date | null; end_cause: string | null; ended_by: string | null }[]>`
    select id, ended_at, end_cause, ended_by from fixture_stream_codes where fixture_id = ${fixtureId} order by created_at`;
  return Promise.all(rows.map(async (r) => ({ ...r, sealed: (await sql.begin((tx) => openStreamCodeTok(tx, r.id))) !== null })));
};
/** §6.9's present window is at most max(60 s, 60 s far cadence + 30 s) = 90 s: ten minutes is silent at any cadence. */
const SILENT_AGO_MS = 10 * 60_000;
const NO_DRIVERS = new Proxy({}, { get: () => { throw new Error("no driver is reachable from a beat on an ended code"); } }) as SessionDeps["drivers"];
const beatOn = (qr: { code: string; tok: string }, phone: string, at: Date, claim: "new" | null = null) => postBeat(qr.code, qr.tok, {
  code: qr.code, slot: 0, phone, claim, device: null, sid: null, at: at.toISOString(), state: "paired", cause: null,
  notReady: null, startFailed: null, stopped: null, mode: "operator", transport: null, bitrateKbps: null, delivery: "unknown",
  deliveredLagS: null, audioOk: null, battery: null, thermal: null, dataUsedMB: null, appVersion: "session-rig",
}, { drivers: NO_DRIVERS, now: () => at, appUrl: "http://rig.test" }, at);
const captureRefusal = async (p: Promise<unknown>): Promise<string> => {
  try { await p; } catch (e) {
    if (e instanceof CaptureRefusalError) return `${e.status}:${e.code}`;
    throw e;
  }
  throw new Error("expected a capture refusal");
};

describe.skipIf(!HAS_DB)("court stream switch", () => {
  let day: Day;
  let fx: string;
  let other: string;
  // The links are for REAL today (the guards read the clock themselves, like the rest of the stream code), the fixture on Court 2.
  const linkCourt2 = async () => {
    const api = await rigApiTarget(day.orgId, "Club channel");
    return linkCourtStream(day.auth, day.comp.id, { courtId: day.courts.c2, targetId: api.targetId });
  };
  beforeEach(async () => {
    day = await seedDay();
    fx = day.comp.fixtures[0]!.id;
    other = day.comp.fixtures[1]!.id;
    await place(day, fx, 0, day.courts.c2);
    await place(day, other, 30, day.courts.c1);
  });

  it("is off by default and spends nothing when turned on", async () => {
    expect(await settingsOf(fx)).toBeNull();
    await linkCourt2();
    expect(await setCourtStream(day.auth, fx, true)).toEqual({ on: true });
    expect(await settingsOf(fx)).toMatchObject({ court_stream: true, revision: 1, target_id: null, target_chosen: false });
    const [c] = await sql<{ n: number }[]>`select count(*)::int as n from org_stream_credits where org_id = ${day.orgId}`;
    expect(c!.n).toBe(0);
    expect(await settingsOf(other)).toBeNull();
    expect(await setCourtStream(day.auth, fx, false)).toEqual({ on: false });
    expect(await settingsOf(fx)).toMatchObject({ court_stream: false, revision: 2 });
  });

  it("final review I-1: the panel's read model names the court AND the link's channel label once the switch is on, and nothing before", async () => {
    await linkCourt2();
    expect((await streamPhone(day.auth, fx, { now: () => new Date() })).court, "switch off").toBeNull();
    await setCourtStream(day.auth, fx, true);
    const read = await streamPhone(day.auth, fx, { now: () => new Date() });
    expect(read.court).toEqual({ name: "Court 2", targetLabel: "Club channel" });
    expect(JSON.stringify(read), "a label only: no link or target id on the panel read").not.toMatch(/court_link|target_id|tok/);
  });

  /** Web G: the code has been used — one session ON the active own code (`code_id`), ended ("Ended before going live"). */
  const endedSession = async (fixtureId: string) => {
    const sid = await sessionOnTarget(day.orgId, fixtureId, (await rigApiTarget(day.orgId, "Own phone channel")).targetId, "failed");
    await sql`update fixture_stream_sessions set code_id = (select id from fixture_stream_codes where fixture_id = ${fixtureId} and ended_at is null) where id = ${sid}`;
    return sid;
  };
  /** The desk's `own_stream_code` for `fixtureId` (Match Day's switch lock), read through the desk's own read. */
  const deskOwnCode = async (fixtureId: string) =>
    (await courtStreamsForDay(day.orgId, [day.courts.c2], [fixtureId], new Date())).switches.get(fixtureId)?.ownCode;

  it("Web G: a phone holding the match's own code (beat within the present window) is 409 has_own_stream_code; desk locked", async () => {
    await linkCourt2();
    await ensureStreamCode(day.auth, fx);
    await endedSession(fx); // used: only the phone can make it compete
    await pairPresentPhone(fx, { at: new Date(Date.now() - 20_000) }); // 20 s ago: present at any cadence
    expect(await deskOwnCode(fx), "desk switch locked own_code").toBe(true);
    const f = await failure(setCourtStream(day.auth, fx, true));
    expect([f.status, f.code]).toEqual([409, "has_own_stream_code"]);
    expect(await settingsOf(fx)).toBeNull();
    expect(await activeCodes(fx), "a refused ON retires nothing").toBe(1);
  });

  it("Web G: a beat 75 s ago at a 60 s cadence is still present (window max(60, 60 + 30) = 90 s): ON refused, desk locked", async () => {
    await linkCourt2();
    await ensureStreamCode(day.auth, fx);
    await endedSession(fx);
    const { pairingId } = await pairPresentPhone(fx);
    await sql`update fixture_stream_pairings set last_beat_at = now() - interval '75 seconds', answered_poll_seconds = 60 where id = ${pairingId}`;
    expect(await deskOwnCode(fx)).toBe(true);
    expect((await failure(setCourtStream(day.auth, fx, true))).code).toBe("has_own_stream_code");
    await sql`update fixture_stream_pairings set last_beat_at = now() - interval '95 seconds' where id = ${pairingId}`;
    expect(await deskOwnCode(fx), "past 90 s it is silent").toBe(false);
  });

  it("Web G: an active session of the match (no phone beating) is 409 has_own_stream_code; desk locked", async () => {
    const shown = await linkCourt2();
    await ensureStreamCode(day.auth, fx);
    const [t] = await sql<{ target_id: string }[]>`select target_id from court_stream_links where id = ${shown.id}`;
    for (const state of ["requested", "provisioning", "warming", "live", "ending"]) {
      const sid = await sessionOnTarget(day.orgId, fx, t!.target_id, state);
      expect(await deskOwnCode(fx), `desk locked while ${state}`).toBe(true);
      const f = await failure(setCourtStream(day.auth, fx, true));
      expect([f.status, f.code], state).toEqual([409, "has_own_stream_code"]);
      await sql`update fixture_stream_sessions set state = 'failed', ended_at = now() where id = ${sid}`;
    }
    expect(await settingsOf(fx)).toBeNull();
    expect(await activeCodes(fx)).toBe(1);
  });

  it("Web G: an ended-only session and a phone gone silent — ON succeeds, the own code is retired (not deleted), the desk unlocks, the phone is refused", async () => {
    await linkCourt2();
    const qr = (await ensureStreamCode(day.auth, fx)).qr;
    const { phone } = await pairPresentPhone(fx, { at: new Date(Date.now() - SILENT_AGO_MS) });
    const sid = await endedSession(fx); // "Ended before going live"
    expect(await deskOwnCode(fx), "desk switch enabled: the code competes with nothing").toBe(false);

    expect(await setCourtStream(day.auth, fx, true)).toEqual({ on: true });
    expect(await settingsOf(fx)).toMatchObject({ court_stream: true });
    const codes = await codesOf(fx);
    expect(codes, "retired, never deleted").toHaveLength(1);
    expect(codes[0]).toMatchObject({ end_cause: "withdrawn", ended_by: day.auth.userId, sealed: false });
    expect(codes[0]!.ended_at).not.toBeNull();
    expect((await sql`select 1 from fixture_stream_sessions where id = ${sid}`).length, "its ended session stays").toBe(1);
    expect(await deskOwnCode(fx)).toBe(false);

    expect(await captureRefusal(beatOn(qr, phone, new Date())), "the phone that held it is refused").toBe("401:code_ended");
    expect((await failure(ensureStreamCode(day.auth, fx))).code, "and the match mints no new code").toBe("court_streamed");
    const panel = await streamPhone(day.auth, fx, { now: () => new Date() });
    expect(panel.code).toMatchObject({ state: "ended", endCause: "withdrawn" });
    expect(panel.court).toEqual({ name: "Court 2", targetLabel: "Club channel" });
  });

  it("Web G: a code no phone ever claimed and with no session (printed, unscanned) is 409 has_own_stream_code; desk locked", async () => {
    await linkCourt2();
    await ensureStreamCode(day.auth, fx);
    expect(await deskOwnCode(fx), "desk switch locked own_code").toBe(true);
    const f = await failure(setCourtStream(day.auth, fx, true));
    expect([f.status, f.code]).toEqual([409, "has_own_stream_code"]);
    expect(await settingsOf(fx)).toBeNull();
    expect((await codesOf(fx))[0], "never withdrawn silently").toMatchObject({ ended_at: null, sealed: true });
  });

  it("Web G: a session of ANOTHER code (before a reissue) does not make the new, unscanned code used", async () => {
    await linkCourt2();
    await ensureStreamCode(day.auth, fx);
    await endedSession(fx);
    await reissueStreamCode(day.auth, fx);
    expect(await deskOwnCode(fx)).toBe(true);
    expect((await failure(setCourtStream(day.auth, fx, true))).code).toBe("has_own_stream_code");
  });

  it("Web G: a second ON after retiring a used code is idempotent", async () => {
    await linkCourt2();
    await ensureStreamCode(day.auth, fx);
    await endedSession(fx);
    expect(await setCourtStream(day.auth, fx, true)).toEqual({ on: true });
    expect(await setCourtStream(day.auth, fx, true)).toEqual({ on: true });
    expect((await codesOf(fx)).map((c) => c.end_cause)).toEqual(["withdrawn"]);
    expect(await activeCodes(fx)).toBe(0);
    expect(await settingsOf(fx)).toMatchObject({ court_stream: true, revision: 2 });
  });

  it("Web G: an ON refused court_not_streaming retires nothing", async () => {
    await ensureStreamCode(day.auth, fx); // Court 2 never linked
    await endedSession(fx); // used and idle: only the court refuses
    expect((await failure(setCourtStream(day.auth, fx, true))).code).toBe("court_not_streaming");
    expect(await activeCodes(fx)).toBe(1);
    expect((await codesOf(fx))[0]).toMatchObject({ ended_at: null, sealed: true });
  });

  it("turning on a match whose court is not streaming is 409 court_not_streaming", async () => {
    const f = await failure(setCourtStream(day.auth, fx, true)); // never linked
    expect([f.status, f.code]).toEqual([409, "court_not_streaming"]);
    await linkCourt2();
    const g = await failure(setCourtStream(day.auth, other, true)); // Court 1 is not linked
    expect([g.status, g.code]).toEqual([409, "court_not_streaming"]);
    await place(day, other, 30, null); // no court at all
    expect((await failure(setCourtStream(day.auth, other, true))).code).toBe("court_not_streaming");
    expect(await settingsOf(fx)).toBeNull();
    expect(await settingsOf(other)).toBeNull();
  });

  it("a withdrawn link, or one whose day is over or not yet open, is not streaming", async () => {
    const shown = await linkCourt2();
    await withdrawCourtStream(day.auth, shown.id);
    expect((await failure(setCourtStream(day.auth, fx, true))).code).toBe("court_not_streaming");
    await linkCourt2();
    const tomorrow = new Date(Date.now() + 36 * 3600_000);
    expect((await failure(setCourtStream(day.auth, fx, true, tomorrow))).code).toBe("court_not_streaming");
    const yesterday = new Date(Date.now() - 36 * 3600_000);
    expect((await failure(setCourtStream(day.auth, fx, true, yesterday))).code).toBe("court_not_streaming");
  });

  it("turning off always succeeds, also on an unlinked court", async () => {
    expect(await setCourtStream(day.auth, other, false)).toEqual({ on: false });
    expect(await settingsOf(other)).toMatchObject({ court_stream: false, revision: 1 });
    await linkCourt2();
    await setCourtStream(day.auth, fx, true);
    const links = await sql<{ id: string }[]>`select id from court_stream_links where org_id = ${day.orgId}`;
    await withdrawCourtStream(day.auth, links[0]!.id);
    expect(await setCourtStream(day.auth, fx, false)).toEqual({ on: false });
    expect(await settingsOf(fx)).toMatchObject({ court_stream: false });
  });

  it("ensureStreamCode and reissueStreamCode on a court-streamed match are 409 court_streamed; turning the switch off lets it mint", async () => {
    await linkCourt2();
    await setCourtStream(day.auth, fx, true);
    for (const call of [ensureStreamCode, reissueStreamCode]) {
      const f = await failure(call(day.auth, fx));
      expect([f.status, f.code]).toEqual([409, "court_streamed"]);
    }
    expect(await activeCodes(fx)).toBe(0);
    await setCourtStream(day.auth, fx, false);
    expect((await ensureStreamCode(day.auth, fx)).qr.code).toMatch(/\S/);
    expect(await activeCodes(fx)).toBe(1);
  });

  it("a switch left on after its link ended does not stop the match minting its own code", async () => {
    const shown = await linkCourt2();
    await setCourtStream(day.auth, fx, true);
    await withdrawCourtStream(day.auth, shown.id);
    expect((await ensureStreamCode(day.auth, fx)).qr.code).toMatch(/\S/);
  });

  it("racing a mint and a switch-on: exactly one wins, the other is refused by name", async () => {
    await linkCourt2();
    const [a, b] = await Promise.allSettled([ensureStreamCode(day.auth, fx), setCourtStream(day.auth, fx, true)]);
    const fulfilled = [a, b].filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    const lost = (a.status === "rejected" ? a : b) as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(HttpError);
    expect((lost.reason as HttpError).code).toBe(a.status === "rejected" ? "court_streamed" : "has_own_stream_code");
    const s = await settingsOf(fx);
    expect((await activeCodes(fx) === 1) !== (s?.court_stream === true)).toBe(true);
  });

  it("a mint held open between its reads and its write still blocks a switch-on: the switch waits on the lock and is refused", async () => {
    await linkCourt2();
    let reached!: () => void;
    const atInsert = new Promise<void>((r) => { reached = r; });
    hold.gate = async () => { reached(); await new Promise((r) => setTimeout(r, 400)); };
    try {
      const mint = ensureStreamCode(day.auth, fx);
      await atInsert; // the mint has read "no code, switch off" and holds the fixture's lock
      const sw = failure(setCourtStream(day.auth, fx, true));
      expect(await mint).toHaveProperty("qr");
      expect((await sw).code).toBe("has_own_stream_code");
    } finally { hold.gate = null; }
    expect(await settingsOf(fx)).toBeNull();
    expect(await activeCodes(fx)).toBe(1);
  });

  it("Web G: a silent phone that beats BEFORE the switch-on is present again: ON refused, the code stays", async () => {
    await linkCourt2();
    await ensureStreamCode(day.auth, fx);
    await endedSession(fx);
    await pairPresentPhone(fx, { at: new Date(Date.now() - SILENT_AGO_MS) });
    await pairPresentPhone(fx); // its beat, now
    expect((await failure(setCourtStream(day.auth, fx, true))).code).toBe("has_own_stream_code");
    expect(await activeCodes(fx)).toBe(1);
    expect(await settingsOf(fx)).toBeNull();
  });

  it("Web G: a silent phone that beats AFTER the switch-on is refused code_ended; a new phone's claim on the withdrawn code too", async () => {
    await linkCourt2();
    const qr = (await ensureStreamCode(day.auth, fx)).qr;
    await endedSession(fx);
    const { phone } = await pairPresentPhone(fx, { at: new Date(Date.now() - SILENT_AGO_MS) });
    expect(await setCourtStream(day.auth, fx, true)).toEqual({ on: true });
    expect(await captureRefusal(beatOn(qr, phone, new Date()))).toBe("401:code_ended");
    const fresh = `phone-new-${fx}`;
    expect(await captureRefusal(beatOn(qr, fresh, new Date(), "new")), "pair on a withdrawn code").toBe("401:code_ended");
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_pairings where phone = ${fresh}`;
    expect(n!.n, "the refused claim paired nothing").toBe(0);
  });

  it("Web G review: a start on the own code that an ON retired after it was read is refused, and writes no session", async () => {
    await linkCourt2();
    await ensureStreamCode(day.auth, fx);
    await endedSession(fx);
    const { pairingId } = await pairPresentPhone(fx, { at: new Date(Date.now() - SILENT_AGO_MS) });
    expect(await setCourtStream(day.auth, fx, true)).toEqual({ on: true }); // retires the code under the fixture lock
    const targetId = await rigTarget(day.orgId);
    await resealTargetDestination(targetId, { url: "rtmps://a.rtmps.youtube.com/live2", streamKey: "yt-key" }); // a key that opens
    const now = new Date();
    const deps: SessionDeps = {
      drivers: { ingest: new FakeIngest({ clock: () => now.getTime() }), runner: new FakeRunner() }, now: () => now, appUrl: "http://rig.test",
    };
    const sessions = async () => (await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_sessions where fixture_id = ${fx}`)[0]!.n;
    const before = await sessions();
    const opts = { targetId, phone: "present" as const, mode: "passthrough" as const };
    const phoneStart = startBroadcast({ userId: day.auth.userId!, orgId: day.orgId, source: "phone", pairingId }, fx, { ...opts, startCause: "operator" }, deps);
    expect(await captureRefusal(phoneStart)).toBe("401:code_ended");
    const desk = await failure(startBroadcast({ userId: day.auth.userId!, orgId: day.orgId, source: "organiser", pairingId }, fx, { ...opts, startCause: "organiser" }, deps));
    expect([desk.status, desk.code]).toEqual([409, "phone_not_paired"]);
    expect(await sessions(), "no session row").toBe(before);
  });

  it("Web G review: a start racing an ON's retire waits on the fixture's code lock, then is refused code_ended", async () => {
    await linkCourt2();
    await ensureStreamCode(day.auth, fx);
    const { pairingId, codeId } = await pairPresentPhone(fx);
    const targetId = await rigTarget(day.orgId);
    await resealTargetDestination(targetId, { url: "rtmps://a.rtmps.youtube.com/live2", streamKey: "yt-key" });
    const now = new Date();
    const deps: SessionDeps = {
      drivers: { ingest: new FakeIngest({ clock: () => now.getTime() }), runner: new FakeRunner() }, now: () => now, appUrl: "http://rig.test",
    };
    // The ON's transaction, as setCourtStream writes it: the fixture's code lock, the retire, then (held open) the commit. The
    // start reads the code as ACTIVE before its transaction; only the lock makes it see the retire.
    let locked!: () => void;
    const holding = new Promise<void>((r) => { locked = r; });
    const on = sql.begin(async (tx) => {
      await lockFixtureCode(tx, fx);
      await wipeStreamCodeTok(tx, codeId, "withdrawn", day.auth.userId);
      locked();
      await new Promise((r) => setTimeout(r, 1500));
    });
    await holding;
    const start = captureRefusal(startBroadcast({ userId: day.auth.userId!, orgId: day.orgId, source: "phone", pairingId }, fx,
      { targetId, phone: "present", mode: "passthrough", startCause: "operator" }, deps));
    await on;
    expect(await start).toBe("401:code_ended");
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_sessions where fixture_id = ${fx}`;
    expect(n!.n, "no session stranded on the withdrawn code").toBe(0);
  });

  it("an API key or a device link cannot set it (403)", async () => {
    await linkCourt2();
    for (const via of ["api_key", "device_link"] as const) {
      expect((await failure(setCourtStream({ ...day.auth, via } as AuthCtx, fx, true))).status).toBe(403);
    }
    expect(await settingsOf(fx)).toBeNull();
  });

  it("another organisation's match is a 404", async () => {
    const stranger = await seedDay();
    expect((await failure(setCourtStream(stranger.auth, fx, true))).status).toBe(404);
  });
});
