// YouTube Connect T10 (spec §6.2 with plan P2, P3, P4, P7; rulings R2, R3, R4, T10-R1; the post-T3 key-reuse amendment): the
// Go live PREPARE step — reuse the fixture's open broadcast inside its grace or make a new one, keep the per-channel stream-key
// pool, insert the broadcast and bind it at YouTube through the port. T11 wires it into admission; until then a "Go live" here is
// prepare + a raw session row + attachPrepared, the three pieces admission will call in that order.
//
// Expected values are the spec's and Google's literals, typed here and never imported from prepare.ts:
//   - the reservation lapses 2 minutes after it is taken (spec §6.2 "~2 min", plan P6);
//   - grace is 5 minutes after Stop (D4) — so a Stop 4 minutes ago is inside it and 6 minutes ago is not (6 ≠ 5: the right
//     answer differs from an off-by-one);
//   - "10 active streams allowed per channel" (support.google.com/youtube/answer/2474026, spec §3.1);
//   - refusal statuses: 409, except youtube_limit_reached 429 and youtube_unavailable 503 (plan T10 interface, R3);
//   - a liveStream title is 1–128 characters (liveStreams snippet.title, re-read 2026-10-28);
//   - a broadcast's scheduledStartTime "must be in the future" (liveBroadcasts.insert), so it is never a stale value.
//
// The facts are driven through their REAL producers where one exists: the connection and its API destination through the
// connect save, its visibility through updateConnectionSettings, the fixtures through the division rig, the pooled keys and the
// broadcast rows through prepare itself. The end step (T14) and admission (T11) are not built yet, so their two writes here —
// a claim / a completion, and a session row — are raw SQL, each named where it happens.
//
// Sport: not applicable — preparing a YouTube broadcast reads a fixture's names and a connection, never a sport rule.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({
  captureError: vi.fn<(err: unknown, ctx?: { orgId?: string; route?: string; extra?: Record<string, unknown> }) => void>(),
}));
vi.mock("@/lib/sentry", () => ({ captureError: sentry.captureError }));

import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { sql, type Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { insertStreamTarget } from "@/server/relay/secret-columns";
import { divisionRig } from "@/server/usecases/__tests__/_rig";
import { updateConnectionSettings } from "@/server/youtube/connections";
import { EndRuleInvariantError, readEndFacts } from "@/server/youtube/end-rule";
import { FAKE_YOUTUBE_METHODS, FakeYouTube } from "@/server/youtube/fake";
import type { YoutubeErrorCode, YouTubePort } from "@/server/youtube/port";
import { abandonPrepared, attachPrepared, prepareYoutubeBroadcast, type Prepared } from "@/server/youtube/prepare";
import { connect, org, type Org } from "./_connect-rig";

const HAS_DB = !!process.env.DATABASE_URL;

// ---- spec and Google literals -------------------------------------------------------------------------------------------
const RESERVATION_MINUTES = 2;
const CHANNEL_STREAM_CAP = 10;
const LIVE_STREAM_TITLE_MAX = 128;
const STATUS_OF: Record<string, number> = {
  youtube_reconnect_needed: 409, youtube_live_not_enabled: 409, youtube_live_blocked: 409,
  youtube_limit_reached: 429, youtube_channel_busy: 409, youtube_unavailable: 503,
};
/** What YouTube itself can refuse with (the port's codes less youtube_not_found, which is not a refusal of its own). */
const YOUTUBE_CODES: YoutubeErrorCode[] = [
  "youtube_reconnect_needed", "youtube_live_not_enabled", "youtube_live_blocked", "youtube_limit_reached", "youtube_unavailable",
];
const OPEN = ["created", "bound", "reserved", "live"];

const MIN = 60_000;
const minutesAfter = (d: Date, n: number) => new Date(d.getTime() + n * MIN);

// ---- KEKs: a sealed refresh token (YOUTUBE_TOKEN_KEK) and a pooled key (RELAY_KEK) ----------------------------------------
const KEKS = ["YOUTUBE_TOKEN_KEK", "RELAY_KEK"] as const;
const savedKeks = Object.fromEntries(KEKS.map((k) => [k, process.env[k]]));
beforeAll(() => { for (const k of KEKS) process.env[k] = randomBytes(32).toString("hex"); });
afterAll(() => {
  for (const k of KEKS) {
    if (savedKeks[k] === undefined) delete process.env[k];
    else process.env[k] = savedKeks[k];
  }
});
beforeEach(() => sentry.captureError.mockClear());

// ---- the world ----------------------------------------------------------------------------------------------------------
interface World {
  o: Org; orgId: string; userId: string; connectionId: string; targetId: string; token: string; fixtures: string[]; fake: FakeYouTube;
}
/** An org with a channel connected through the real save (its connection and API destination) and `n` fixtures in one division
 *  (a round robin of k entrants makes k(k-1)/2). Each world has its own fake, so call counts are this test's alone. */
async function world(n = 1): Promise<World> {
  const o = await org();
  const c = await connect(o);
  let entrants = 2;
  while ((entrants * (entrants - 1)) / 2 < n) entrants++;
  const d = await divisionRig(o.auth, { entrants });
  if (d.fixtureIds.length < n) throw new Error(`rig made ${d.fixtureIds.length} fixtures, the test needs ${n}`);
  return {
    o, orgId: o.orgId, userId: o.userId, connectionId: c.connectionId, targetId: c.targetId, token: c.token,
    fixtures: d.fixtureIds.slice(0, n), fake: new FakeYouTube(),
  };
}

const prep = (w: World, fixtureId: string, o: { now?: Date; port?: YouTubePort; targetId?: string; orgId?: string } = {}) =>
  prepareYoutubeBroadcast(
    { orgId: o.orgId ?? w.orgId, fixtureId, targetId: o.targetId ?? w.targetId, now: o.now ?? new Date() }, o.port ?? w.fake,
  );
const must = async (p: Promise<Prepared | null>): Promise<Prepared> => {
  const r = await p;
  if (r === null) throw new Error("prepare answered null for an API destination");
  return r;
};
/** The refusal a promise rejects with, or a failure when it resolves. */
async function refusal(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof HttpError) return err;
    throw err;
  }
  throw new Error("expected a refusal, got an answer");
}

interface BroadcastRow {
  id: string; state: string; key_id: string | null; yt_broadcast_id: string | null; reserved_until: Date | null; claimed_at: Date | null;
  last_session_id: string | null; last_error_code: string | null; connection_id: string; title: string; privacy: string;
}
const row = async (id: string): Promise<BroadcastRow> =>
  (await sql<BroadcastRow[]>`
    select id, state, key_id, yt_broadcast_id, reserved_until, claimed_at, last_session_id, last_error_code, connection_id, title, privacy
      from youtube_broadcasts where id = ${id}`)[0]!;
const rowsOf = (fixtureId: string) =>
  sql<BroadcastRow[]>`
    select id, state, key_id, yt_broadcast_id, reserved_until, claimed_at, last_session_id, last_error_code, connection_id, title, privacy
      from youtube_broadcasts where fixture_id = ${fixtureId} order by created_at, id`;
const openCount = async (fixtureId: string) => (await rowsOf(fixtureId)).filter((r) => OPEN.includes(r.state)).length;
const keyOf = async (keyId: string) =>
  (await sql<{ slot: number; live_stream_id: string }[]>`select slot, live_stream_id from youtube_stream_keys where id = ${keyId}`)[0]!;
const callsOf = (f: FakeYouTube, method: string) => f.calls.filter((c) => c.method === method).length;

/** A session row, raw: admission (T11) is its producer and is not built yet. Its NOT NULL snapshot facts come from the fixture's
 *  division. It names the broadcast, so it is api_backed (V479's check). */
async function insertSession(
  exec: Tx | typeof sql, w: World,
  o: { fixture: string; broadcast: string; state: string; endedAt?: Date | null; targetId?: string },
): Promise<string> {
  const [r] = await exec<{ id: string }[]>`
    insert into fixture_stream_sessions (fixture_id, org_id, mode, state, target_id, created_by, started_at, ended_at,
                                         sport_key, competition_id, division_id, entitlement_via_override, youtube_broadcast_id, api_backed)
    select ${o.fixture}, ${w.orgId}, 'passthrough', ${o.state}, ${o.targetId ?? w.targetId}, ${w.userId}, ${new Date(Date.now() - 60 * MIN)},
           ${o.endedAt ?? null}, d.sport_key, d.competition_id, f.division_id, true, ${o.broadcast}, true
      from fixtures f join divisions d on d.id = f.division_id where f.id = ${o.fixture}
    returning id`;
  return r!.id;
}
/** Go live as T11 will: prepare, then — in admission's transaction — the session row and attachPrepared. */
async function goLive(w: World, fixtureId: string, o: { now?: Date; targetId?: string } = {}): Promise<{ p: Prepared; sessionId: string }> {
  const p = await must(prep(w, fixtureId, o));
  const sessionId = await sql.begin(async (tx) => {
    const sid = await insertSession(tx, w, { fixture: fixtureId, broadcast: p.broadcastId, state: "live", targetId: o.targetId });
    await attachPrepared(tx, p, sid);
    return sid;
  });
  return { p, sessionId };
}
/** Stop: every terminal entry writes ended_at (spec §6.3). */
const stop = (sessionId: string, endedAt: Date) =>
  sql`update fixture_stream_sessions set state = 'completed', ended_at = ${endedAt} where id = ${sessionId}`;
/** The end step's two writes (T14, not built): claim, and complete. */
const claim = (broadcastId: string, at: Date) =>
  sql`update youtube_broadcasts set state = 'ending', claimed_at = ${at}, reserved_until = null where id = ${broadcastId}`;
const complete = (broadcastId: string) =>
  sql`update youtube_broadcasts set state = 'complete', completed_at = now(), reserved_until = null where id = ${broadcastId}`;

/** A one-shot gate: `wait` resolves once `open` is called, and REJECTS (naming why) if it never is within 10 s. */
function gate(why: string): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  let fail!: (e: Error) => void;
  const wait = new Promise<void>((res, rej) => { open = res; fail = rej; });
  const timer = setTimeout(() => fail(new Error(why)), 10_000);
  return { wait, open: () => { clearTimeout(timer); open(); } };
}
/** The fake, with `then` run on each insertStream's answer before it is returned. */
function withInsertStream(
  fake: FakeYouTube, then: (out: Awaited<ReturnType<FakeYouTube["insertStream"]>>) => Promise<Awaited<ReturnType<FakeYouTube["insertStream"]>>>,
): YouTubePort {
  return new Proxy(fake, {
    get(t, p) {
      const v = Reflect.get(t, p, t) as unknown;
      if (p === "insertStream") return async (at: string, a: { title: string }) => then(await t.insertStream(at, a));
      return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(t) : v;
    },
  });
}
/** A port that records the liveStream titles it is asked for, and otherwise IS the fake. */
function recordingStreams(fake: FakeYouTube, titles: string[]): YouTubePort {
  return new Proxy(fake, {
    get(t, p) {
      const v = Reflect.get(t, p, t) as unknown;
      if (p === "insertStream") return (at: string, a: { title: string }) => { titles.push(a.title); return t.insertStream(at, a); };
      return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(t) : v;
    },
  });
}

describe.skipIf(!HAS_DB)("prepareYoutubeBroadcast — a new broadcast (spec §6.2 steps 3–4, P3, P4)", () => {
  it("EMPTY CASE FIRST: a fresh channel (no broadcast, no key) → one key in slot 1, one broadcast bound to it, as the connection says", async () => {
    const w = await world();
    const f = w.fixtures[0]!;
    // The visibility and made-for-kids are the connection's, set through their real producer (not the defaults, so a default
    // cannot pass for them).
    await updateConnectionSettings(w.o.auth, w.orgId, w.connectionId, { privacy: "public", madeForKids: true });
    const titles: string[] = [];
    const before = Date.now();
    // A STALE `now` (a minute old): scheduledStartTime "must be in the future", so it is never this value.
    const p = await must(prep(w, f, { now: new Date(before - MIN), port: recordingStreams(w.fake, titles) }));

    expect(p.reused).toBe(false);
    const r = await row(p.broadcastId);
    expect(r).toMatchObject({ state: "bound", key_id: p.keyId, privacy: "public", connection_id: w.connectionId, reserved_until: null });
    expect((await keyOf(p.keyId)).slot).toBe(1);
    expect(w.fake.streamsCount()).toBe(1);
    expect(w.fake.broadcastsCount()).toBe(1);
    const yt = w.fake.inspectBroadcast(r.yt_broadcast_id!);
    expect(yt).not.toBeNull();
    expect(yt!.streamId).toBe((await keyOf(p.keyId)).live_stream_id);
    expect(yt!.life).toBe("ready");
    expect(yt!.privacy).toBe("public");
    expect(yt!.madeForKids).toBe(true);
    expect(yt!.title).toBe(r.title);
    expect(yt!.scheduledStart.getTime()).toBeGreaterThanOrEqual(before);
    expect(yt!.description).not.toMatch(/[<>]/);
    expect(yt!.description).toContain(`/fixtures/${f}`);
    // The liveStream's own title is within YouTube's 1–128.
    expect(titles).toHaveLength(1);
    expect(titles[0]!.length).toBeGreaterThanOrEqual(1);
    expect(Array.from(titles[0]!).length).toBeLessThanOrEqual(LIVE_STREAM_TITLE_MAX);

    // SECOND CALL, same fixture, before any session used it: R2's null (never due before a session) → reused, nothing new at YouTube.
    const again = await must(prep(w, f));
    expect(again).toEqual({ broadcastId: p.broadcastId, reused: true, keyId: p.keyId });
    expect(callsOf(w.fake, "insertBroadcast")).toBe(1);
    expect(callsOf(w.fake, "insertStream")).toBe(1);
  });

  it("RF4 (R4): the title and description are in the org's default_locale — es (and every locale, checked === 4); the en words are ABSENT", async () => {
    const w = await world(4);
    const dicts = { en, es, fr, nl } as Record<string, Record<string, string>>;
    const [{ comp }] = await sql<{ comp: string }[]>`
      select c.name as comp from fixtures f join divisions d on d.id = f.division_id join competitions c on c.id = d.competition_id
       where f.id = ${w.fixtures[0]!}`;
    let checked = 0;
    let witnessed = 0;   // locale words that differ from English, so their absence is a real witness
    // es first (the brief's case); fr's schedule.vs ("contre") is the one locale whose vs differs from en's "vs".
    for (const [i, locale] of (["es", "fr", "nl", "en"] as const).entries()) {
      const f = w.fixtures[i]!;
      await sql`update organizations set default_locale = ${locale} where id = ${w.orgId}`;
      await sql`update fixtures set away_entrant_id = null where id = ${f}`;   // a TBD side
      const [{ home }] = await sql<{ home: string }[]>`
        select e.display_name as home from fixtures f join entrants e on e.id = f.home_entrant_id where f.id = ${f}`;
      const p = await must(prep(w, f));
      const yt = w.fake.inspectBroadcast((await row(p.broadcastId)).yt_broadcast_id!)!;
      const d = dicts[locale]!;
      expect(yt.title, locale).toBe(`${home} ${d["schedule.vs"]} ${d["schedule.tbd"]} · Open · ${comp}`);
      expect(yt.description.startsWith(`${d["streaming.youtube.broadcast.descriptionLine"]} `), locale).toBe(true);
      if (locale !== "en") {
        for (const key of ["schedule.vs", "schedule.tbd"]) {
          if (d[key] === en[key as keyof typeof en]) continue;
          expect(yt.title, `${locale} ${key}`).not.toContain(` ${en[key as keyof typeof en]}`);
          witnessed++;
        }
        const line = d["streaming.youtube.broadcast.descriptionLine"]!;
        expect(line).not.toBe(en["streaming.youtube.broadcast.descriptionLine"]);
        expect(yt.description, locale).not.toContain(en["streaming.youtube.broadcast.descriptionLine"]);
        witnessed++;
      }
      checked++;
    }
    expect(checked).toBe(4);
    // es: tbd + line; fr: vs + tbd + line; nl: tbd + line.
    expect(witnessed).toBe(7);
  });

  it("two fixtures prepared at once on one channel → two keys; when the first completes, a third fixture reuses its key (no insertStream)", async () => {
    const w = await world(3);
    const [f1, f2, f3] = w.fixtures as [string, string, string];
    const [p1, p2] = await Promise.all([must(prep(w, f1)), must(prep(w, f2))]);
    expect(p1.keyId).not.toBe(p2.keyId);
    expect(new Set([(await keyOf(p1.keyId)).slot, (await keyOf(p2.keyId)).slot])).toEqual(new Set([1, 2]));
    expect(callsOf(w.fake, "insertStream")).toBe(2);
    // While both are open, a third fixture takes a third key.
    await complete(p1.broadcastId);   // the end step's write (T14)
    const p3 = await must(prep(w, f3));
    expect(p3.keyId).toBe(p1.keyId);
    expect(callsOf(w.fake, "insertStream")).toBe(2);
    expect((await row(p3.broadcastId)).state).toBe("bound");
  });

  it("key-busy: 10 open broadcasts on 10 keys → the 11th throws youtube_channel_busy; no row, no insertStream, no insertBroadcast", async () => {
    const w = await world(CHANNEL_STREAM_CAP + 1);
    const prepared: Prepared[] = [];
    for (const f of w.fixtures.slice(0, CHANNEL_STREAM_CAP)) prepared.push(await must(prep(w, f)));
    const slots = await Promise.all(prepared.map(async (p) => (await keyOf(p.keyId)).slot));
    expect([...slots].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(callsOf(w.fake, "insertStream")).toBe(CHANNEL_STREAM_CAP);

    const eleventh = w.fixtures[CHANNEL_STREAM_CAP]!;
    const err = await refusal(prep(w, eleventh));
    expect(err).toMatchObject({ status: 409, code: "youtube_channel_busy", extra: { connectionId: w.connectionId } });
    expect(await rowsOf(eleventh)).toHaveLength(0);
    expect(callsOf(w.fake, "insertStream")).toBe(CHANNEL_STREAM_CAP);
    expect(callsOf(w.fake, "insertBroadcast")).toBe(CHANNEL_STREAM_CAP);

    // Positive pair: one of the ten completes → the 11th goes ahead on ITS key, still with no new stream.
    await complete(prepared[3]!.broadcastId);
    const p = await must(prep(w, eleventh));
    expect(p.keyId).toBe(prepared[3]!.keyId);
    expect(callsOf(w.fake, "insertStream")).toBe(CHANNEL_STREAM_CAP);
  });

  it("P3: a lost slot race deletes the extra liveStream and retries the pick once (9 busy, two at once → one goes, one is busy)", async () => {
    const w = await world(CHANNEL_STREAM_CAP + 1);
    for (const f of w.fixtures.slice(0, CHANNEL_STREAM_CAP - 1)) await must(prep(w, f));
    expect(w.fake.streamsCount()).toBe(CHANNEL_STREAM_CAP - 1);
    // Both admissions pass the pick (9 live, none free) before either pools its new stream: insertStream holds each until both
    // have one, so the race is the same every run.
    let arrived = 0;
    const both = gate("the second admission never reached insertStream");
    const gated = withInsertStream(w.fake, async (out) => {
      if (++arrived === 2) both.open();
      await both.wait;
      return out;
    });
    const [a, b] = w.fixtures.slice(CHANNEL_STREAM_CAP - 1) as [string, string];
    const settled = await Promise.allSettled([prep(w, a, { port: gated }), prep(w, b, { port: gated })]);
    const won = settled.filter((s) => s.status === "fulfilled");
    const lost = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]!.reason).toMatchObject({ status: 409, code: "youtube_channel_busy" });
    // Two streams were inserted; the loser's was deleted again, so the channel holds exactly its 10.
    expect(callsOf(w.fake, "insertStream")).toBe(CHANNEL_STREAM_CAP + 1);
    expect(callsOf(w.fake, "deleteStream")).toBe(1);
    expect(w.fake.streamsCount()).toBe(CHANNEL_STREAM_CAP);
    // The loser's row is failed with the code, never left open; no broadcast was made for it.
    const loser = settled[0]!.status === "rejected" ? a : b;
    expect((await rowsOf(loser)).map((r) => [r.state, r.last_error_code])).toEqual([["failed", "youtube_channel_busy"]]);
    expect(w.fake.broadcastsCount()).toBe(CHANNEL_STREAM_CAP);
  });
});

describe.skipIf(!HAS_DB)("prepareYoutubeBroadcast — reuse and claim (spec §6.2 step 2, R2, P7)", () => {
  it("reuse inside grace: an open 'live' broadcast stopped 4 min ago → same broadcastId, same key, reserved, reserved_until = now + 2 min; ZERO insertBroadcast calls", async () => {
    const w = await world();
    const f = w.fixtures[0]!;
    const { p, sessionId } = await goLive(w, f);
    expect((await row(p.broadcastId)).state).toBe("live");
    const now = new Date();
    await stop(sessionId, minutesAfter(now, -4));
    const inserts = callsOf(w.fake, "insertBroadcast");
    const streams = callsOf(w.fake, "insertStream");

    const again = await must(prep(w, f, { now }));
    expect(again).toEqual({ broadcastId: p.broadcastId, reused: true, keyId: p.keyId });
    const r = await row(p.broadcastId);
    expect(r.state).toBe("reserved");
    expect(r.reserved_until).toEqual(minutesAfter(now, RESERVATION_MINUTES));
    expect(callsOf(w.fake, "insertBroadcast")).toBe(inserts);
    expect(callsOf(w.fake, "insertStream")).toBe(streams);
  });

  it("…stopped 6 min ago → claimed 'ending', a NEW broadcast on a DIFFERENT key", async () => {
    const w = await world();
    const f = w.fixtures[0]!;
    const { p, sessionId } = await goLive(w, f);
    const now = new Date();
    await stop(sessionId, minutesAfter(now, -6));

    const next = await must(prep(w, f, { now }));
    expect(next.reused).toBe(false);
    expect(next.broadcastId).not.toBe(p.broadcastId);
    // The claimed broadcast still holds its key (the end step is about to complete it), so the new one takes another.
    expect(next.keyId).not.toBe(p.keyId);
    const old = await row(p.broadcastId);
    expect(old.state).toBe("ending");
    expect(old.claimed_at).toEqual(now);
    expect((await row(next.broadcastId)).state).toBe("bound");
    expect(callsOf(w.fake, "insertBroadcast")).toBe(2);
  });

  it("a claimed (ending) broadcast is never reused — even inside its grace", async () => {
    const w = await world();
    const f = w.fixtures[0]!;
    const { p, sessionId } = await goLive(w, f);
    const now = new Date();
    await stop(sessionId, minutesAfter(now, -1));   // inside the grace: reusable, were it not claimed
    const claimedAt = minutesAfter(now, -1);
    await claim(p.broadcastId, claimedAt);   // the end step's claim (T14)

    const next = await must(prep(w, f, { now }));
    expect(next.reused).toBe(false);
    expect(next.broadcastId).not.toBe(p.broadcastId);
    expect(await row(p.broadcastId)).toMatchObject({ state: "ending", claimed_at: claimedAt });
  });

  it("R2: a broadcast whose session is still ACTIVE (dueAt null) is selected for reuse, not claimed; a reserved-unlapsed row → the existing active_session 409", async () => {
    const w = await world();
    const f = w.fixtures[0]!;
    const { p } = await goLive(w, f);   // the session stays live
    const now = new Date();
    const reused = await must(prep(w, f, { now }));
    expect(reused).toEqual({ broadcastId: p.broadcastId, reused: true, keyId: p.keyId });
    expect((await row(p.broadcastId)).state).toBe("reserved");

    // Another Go live while that reservation is unlapsed: it is mid-admission — the existing refusal, no new code.
    const before = await row(p.broadcastId);
    const err = await refusal(prep(w, f, { now: minutesAfter(now, 1) }));
    expect(err).toMatchObject({ status: 409, code: "active_session", extra: { sessionId: null } });
    expect(await row(p.broadcastId)).toEqual(before);

    // Positive pair: once the reservation has lapsed, the next Go live takes it over.
    const later = minutesAfter(now, RESERVATION_MINUTES + 1);
    const taken = await must(prep(w, f, { now: later }));
    expect(taken.broadcastId).toBe(p.broadcastId);
    expect((await row(p.broadcastId)).reserved_until).toEqual(minutesAfter(later, RESERVATION_MINUTES));
  });

  it("T10-R1: a broadcast whose facts break the end rule's invariant is claimed 'ending' and reported; Go live makes a new one, never refuses", async () => {
    const w = await world();
    const f = w.fixtures[0]!;
    const { p, sessionId } = await goLive(w, f);
    // A terminal session with no ended_at: every terminal entry writes it (§6.3), so the end rule cannot answer.
    await sql`update fixture_stream_sessions set state = 'completed', ended_at = null where id = ${sessionId}`;
    const now = new Date();

    const next = await must(prep(w, f, { now }));
    expect(next.reused).toBe(false);
    expect(next.broadcastId).not.toBe(p.broadcastId);
    expect(await row(p.broadcastId)).toMatchObject({ state: "ending", claimed_at: now });
    const reports = sentry.captureError.mock.calls.filter(([e]) => e instanceof EndRuleInvariantError);
    expect(reports).toHaveLength(1);
    expect(reports[0]![1]).toMatchObject({ orgId: w.orgId, extra: { broadcastId: p.broadcastId } });
  });

  it("an open broadcast on ANOTHER of the org's channels is not reused: in grace it is claimed and a new one made here; with a live session on it → active_session", async () => {
    const w = await world(2);
    const second = await connect(w.o);   // a second channel in the same org, its own destination
    const [f1, f2] = w.fixtures as [string, string];
    const { p, sessionId } = await goLive(w, f1);
    const now = new Date();
    await stop(sessionId, minutesAfter(now, -1));   // inside its grace

    const moved = await must(prep(w, f1, { now, targetId: second.targetId }));
    expect(moved.reused).toBe(false);
    expect((await row(moved.broadcastId)).connection_id).toBe(second.connectionId);
    expect(await row(p.broadcastId)).toMatchObject({ state: "ending", claimed_at: now });

    // With a session LIVE on the first channel's broadcast, the switch is refused: nothing is claimed under a running camera.
    const live = await goLive(w, f2);
    const err = await refusal(prep(w, f2, { now, targetId: second.targetId }));
    expect(err).toMatchObject({ status: 409, code: "active_session" });
    expect((await row(live.p.broadcastId)).state).toBe("live");
    // Positive pair: on its own channel the same fixture is reused.
    expect((await must(prep(w, f2, { now }))).broadcastId).toBe(live.p.broadcastId);
  });

  it("R3: a concurrent admission's 'created' row on the same fixture (23505 on one_open_per_fixture) → re-read → reused; one broadcast at YouTube", async () => {
    const w = await world(2);
    const [x, y] = w.fixtures as [string, string];
    // A free key in the pool, so the first admission's row carries its key from the insert.
    const px = await must(prep(w, x));
    await abandonPrepared(px, w.fake);
    expect((await row(px.broadcastId)).state).toBe("failed");
    expect(w.fake.broadcastsCount()).toBe(0);

    const settled = await bothPastStepTwo(w, () => [prep(w, y), prep(w, y)]);
    const answers = settled.map((s) => {
      if (s.status === "rejected") throw s.reason;
      return s.value!;
    });
    expect(answers.map((a) => a.reused).sort()).toEqual([false, true]);
    expect(answers[0]!.broadcastId).toBe(answers[1]!.broadcastId);
    expect(answers[0]!.keyId).toBe(px.keyId);
    expect(answers[1]!.keyId).toBe(px.keyId);
    expect(w.fake.broadcastsCount()).toBe(1);
    expect(await openCount(y)).toBe(1);
  });

  it("R3, empty pool: the concurrent row has no key yet (half-built) → 503 youtube_unavailable, the row left to its admission", async () => {
    const w = await world();
    const f = w.fixtures[0]!;
    // The winner pools its new key only after insertStream; holding insertStream until the loser has answered keeps the row
    // keyless while the loser re-reads it, every run.
    const loserAnswered = gate("neither admission answered");
    const port = withInsertStream(w.fake, async (out) => {
      await loserAnswered.wait;
      return out;
    });
    const settled = await bothPastStepTwo(w, () => [prep(w, f, { port }), prep(w, f, { port })].map((p) => {
      p.then(loserAnswered.open, loserAnswered.open);
      return p;
    }));
    const won = settled.filter((s) => s.status === "fulfilled");
    const lost = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]!.reason).toMatchObject({ status: 503, code: "youtube_unavailable", extra: { connectionId: w.connectionId } });
    const rows = await rowsOf(f);
    expect(rows.map((r) => r.state)).toEqual(["bound"]);
    expect(w.fake.broadcastsCount()).toBe(1);
    expect(w.fake.streamsCount()).toBe(1);
  });
});

/** Run two admissions so BOTH have passed step 2 (no open row) before either inserts: the test holds the connection row's lock
 *  (step 3 takes it first) until both are queued on it, then lets them go. */
async function bothPastStepTwo<T>(w: World, start: () => Promise<T>[]): Promise<PromiseSettledResult<T>[]> {
  let started: Promise<T>[] = [];
  await sql.begin(async (tx) => {
    await tx`select id from org_youtube_connections where id = ${w.connectionId} for update`;
    started = start();
    const deadline = Date.now() + 10_000;
    for (;;) {
      const [{ n }] = await sql<{ n: number }[]>`
        select count(*)::int as n from pg_stat_activity
         where datname = current_database() and wait_event_type = 'Lock' and query ilike '%from org_youtube_connections%for update%'`;
      if (n >= 2) break;
      if (Date.now() > deadline) throw new Error(`only ${n} admission(s) queued on the connection lock`);
      await new Promise((r) => setTimeout(r, 20));
    }
  });
  return Promise.allSettled(started);
}

describe.skipIf(!HAS_DB)("the key pool's reuse guard (post-T3 amendment): a key whose last session may still publish is not free", () => {
  it("A's release fails at Stop, A's broadcast ends, B's pick takes a DIFFERENT key; positive pair: released ⇒ same key reused (checked === 2 hazards)", async () => {
    const hazards: { name: string; hold: (sid: string) => Promise<unknown>; clear: (sid: string) => Promise<unknown> }[] = [
      {
        name: "an output recorded and not released",
        hold: (sid) => sql`update fixture_stream_sessions set output_uid = ${`out-${sid}`}, output_released_at = null where id = ${sid}`,
        clear: (sid) => sql`update fixture_stream_sessions set output_released_at = now() where id = ${sid}`,
      },
      {
        name: "a composed runner not confirmed gone",
        hold: (sid) => sql`update fixture_stream_sessions set mode = 'composed', runner_state = 'destroyed', runner_gone_confirmed_at = null where id = ${sid}`,
        clear: (sid) => sql`update fixture_stream_sessions set runner_gone_confirmed_at = now() where id = ${sid}`,
      },
    ];
    let checked = 0;
    for (const h of hazards) {
      const w = await world(3);
      const [a, b, c] = w.fixtures as [string, string, string];
      const A = await goLive(w, a);
      await stop(A.sessionId, minutesAfter(new Date(), -10));
      await h.hold(A.sessionId);
      await complete(A.p.broadcastId);   // A's broadcast ends (T14's write)

      const B = await must(prep(w, b));
      expect(B.keyId, h.name).not.toBe(A.p.keyId);

      await h.clear(A.sessionId);
      const C = await must(prep(w, c));
      expect(C.keyId, h.name).toBe(A.p.keyId);
      checked++;
    }
    expect(checked).toBe(2);
  });
});

describe.skipIf(!HAS_DB)("prepareYoutubeBroadcast — refusals (spec §6.2 D6 table, R3)", () => {
  it("each port refusal at each step leaves no 'created'/'bound' row and deletes what YouTube got (checked === 20)", async () => {
    const w = await world();
    const f = w.fixtures[0]!;
    // Ordered so each step is REACHED: insertStream runs only while the pool is empty, so its cases come before the first
    // insertBroadcast case pools a key; insertBroadcast and bind then use that free key.
    const steps = ["accessToken", "insertStream", "insertBroadcast", "bind"] as const;
    let checked = 0;
    for (const step of steps) {
      for (const code of YOUTUBE_CODES) {
        const calledBefore = callsOf(w.fake, step);
        const rowsBefore = (await rowsOf(f)).length;
        w.fake.failNext(step, code);
        const err = await refusal(prep(w, f));
        const label = `${step} × ${code}`;
        expect(callsOf(w.fake, step), label).toBe(calledBefore + 1);   // the failure fired at THIS step
        expect(err.code, label).toBe(code);
        expect(err.status, label).toBe(STATUS_OF[code]);
        expect(err.extra, label).toEqual({ connectionId: w.connectionId });
        expect(await openCount(f), label).toBe(0);
        const rows = await rowsOf(f);
        if (step === "accessToken") {
          expect(rows.length, label).toBe(rowsBefore);   // refused before any row
        } else {
          expect(rows.length, label).toBe(rowsBefore + 1);
          expect([rows.at(-1)!.state, rows.at(-1)!.last_error_code], label).toEqual(["failed", code]);
        }
        expect(w.fake.liveBroadcastCount(), label).toBe(0);
        expect(w.fake.broadcastsCount(), label).toBe(0);   // no orphan 'upcoming' left at YouTube
        checked++;
      }
    }
    expect(checked).toBe(20);
    // The bind cases deleted what insertBroadcast made: 5 inserted, 5 deleted.
    expect(callsOf(w.fake, "deleteBroadcast")).toBe(5);
    // Positive pair: with no failure queued the same fixture goes ahead.
    expect((await must(prep(w, f))).reused).toBe(false);
    expect(w.fake.broadcastsCount()).toBe(1);
  });

  it("a connection in reconnect_needed → youtube_reconnect_needed before any port call; positive pair: connected → goes ahead", async () => {
    const w = await world();
    const f = w.fixtures[0]!;
    await sql`update org_youtube_connections set status = 'reconnect_needed', status_since = now() where id = ${w.connectionId}`;
    const err = await refusal(prep(w, f));
    expect(err).toMatchObject({ status: 409, code: "youtube_reconnect_needed", extra: { connectionId: w.connectionId } });
    expect(w.fake.calls).toHaveLength(0);
    expect(await rowsOf(f)).toHaveLength(0);
    await sql`update org_youtube_connections set status = 'connected', status_since = now() where id = ${w.connectionId}`;
    expect((await must(prep(w, f))).reused).toBe(false);
  });

  it("org B's fixture cannot be prepared on org A's API target → 404, zero port calls (both ways round); a pasted destination → null", async () => {
    const A = await world();
    const B = await world();
    const crossFixture = await refusal(prep(A, B.fixtures[0]!));   // A's org and target, B's fixture
    expect(crossFixture.status).toBe(404);
    const crossTarget = await refusal(prep(B, B.fixtures[0]!, { targetId: A.targetId }));   // B's org and fixture, A's target
    expect(crossTarget.status).toBe(404);
    expect(A.fake.calls).toHaveLength(0);
    expect(B.fake.calls).toHaveLength(0);
    expect(await rowsOf(B.fixtures[0]!)).toHaveLength(0);

    const pasted = await sql.begin((tx) => insertStreamTarget(tx, {
      orgId: A.orgId, kind: "youtube", label: "Pasted key", watchUrl: null,
      rtmp: { url: "rtmps://a.rtmps.youtube.com/live2", streamKey: `key-${randomUUID()}` },
    }));
    expect(await prep(A, A.fixtures[0]!, { targetId: pasted.id })).toBeNull();
    expect(A.fake.calls).toHaveLength(0);
    // Positive pair: A's own fixture on A's own destination goes ahead.
    expect((await must(prep(A, A.fixtures[0]!))).reused).toBe(false);
  });
});

describe.skipIf(!HAS_DB)("abandonPrepared and attachPrepared", () => {
  it("abandonPrepared: created-new → deleteBroadcast called, row 'failed' (admission_refused); reused → back to 'live', reserved_until null", async () => {
    const w = await world(2);
    const [f1, f2] = w.fixtures as [string, string];
    const created = await must(prep(w, f1));
    await abandonPrepared(created, w.fake);
    expect(await row(created.broadcastId)).toMatchObject({ state: "failed", last_error_code: "admission_refused" });
    expect(callsOf(w.fake, "deleteBroadcast")).toBe(1);
    expect(w.fake.broadcastsCount()).toBe(0);

    const { p, sessionId } = await goLive(w, f2);
    await stop(sessionId, minutesAfter(new Date(), -1));
    const reused = await must(prep(w, f2));
    expect(reused.reused).toBe(true);
    await abandonPrepared(reused, w.fake);
    expect(await row(p.broadcastId)).toMatchObject({ state: "live", reserved_until: null, last_session_id: sessionId });
    expect(callsOf(w.fake, "deleteBroadcast")).toBe(1);   // a reused broadcast is never deleted
  });

  it("abandonPrepared: a reused broadcast no session ever used goes back to 'bound'; a second abandon changes nothing", async () => {
    const w = await world();
    const f = w.fixtures[0]!;
    const first = await must(prep(w, f));
    const reused = await must(prep(w, f));
    expect(reused.reused).toBe(true);
    await abandonPrepared(reused, w.fake);
    const after = await row(first.broadcastId);
    expect(after).toMatchObject({ state: "bound", reserved_until: null, last_session_id: null });
    await abandonPrepared(reused, w.fake);
    expect(await row(first.broadcastId)).toEqual(after);
  });

  it("abandonPrepared leaves a row another admission reserved meanwhile, and never throws when YouTube cannot be reached (reports)", async () => {
    const w = await world(2);
    const [f1, f2] = w.fixtures as [string, string];
    const created = await must(prep(w, f1));
    const other = await must(prep(w, f1));   // another admission reserves it (no session yet: reusable)
    expect(other.reused).toBe(true);
    await abandonPrepared(created, w.fake);
    expect((await row(created.broadcastId)).state).toBe("reserved");
    expect(callsOf(w.fake, "deleteBroadcast")).toBe(0);

    const doomed = await must(prep(w, f2));
    w.fake.killToken(w.token);   // the grant died: the delete cannot be made
    await expect(abandonPrepared(doomed, w.fake)).resolves.toBeUndefined();
    expect((await row(doomed.broadcastId)).state).toBe("failed");
    expect(sentry.captureError.mock.calls.some(([, ctx]) => ctx?.route === "youtube.abandon")).toBe(true);
  });

  it("attachPrepared after the reservation lapsed and the end step claimed it → 503 youtube_unavailable; the claimed row stays 'ending'", async () => {
    const w = await world();
    const f = w.fixtures[0]!;
    const { sessionId } = await goLive(w, f);
    await stop(sessionId, minutesAfter(new Date(), -1));
    const reused = await must(prep(w, f));
    await claim(reused.broadcastId, new Date());   // lapsed, and the end step claimed it (T14)

    const err = await refusal(sql.begin(async (tx) => {
      const sid = await insertSession(tx, w, { fixture: f, broadcast: reused.broadcastId, state: "requested" });
      await attachPrepared(tx, reused, sid);
    }));
    expect(err).toMatchObject({ status: 503, code: "youtube_unavailable", extra: { connectionId: w.connectionId } });
    expect((await row(reused.broadcastId)).state).toBe("ending");
  });

  it("attachPrepared refuses 503 a reservation on a half-built row (no YouTube id yet) and a Prepared whose key is not the row's", async () => {
    const w = await world(2);
    const [f1, f2] = w.fixtures as [string, string];
    // A row whose admission is still between its insert and liveBroadcasts.insert: keyed, no YouTube id (the crash P4 names).
    const first = await must(prep(w, f1));
    await sql`update youtube_broadcasts set yt_broadcast_id = null where id = ${first.broadcastId}`;
    const reused = await must(prep(w, f1));
    expect(reused.reused).toBe(true);
    const attach = (p: Prepared, fixture: string) => sql.begin(async (tx) => {
      const sid = await insertSession(tx, w, { fixture, broadcast: p.broadcastId, state: "requested" });
      await attachPrepared(tx, p, sid);
    });
    expect(await refusal(attach(reused, f1))).toMatchObject({ status: 503, code: "youtube_unavailable" });
    expect((await row(first.broadcastId)).state).toBe("reserved");

    // A Prepared naming another key than its row's (stale): refused, row untouched.
    const other = await must(prep(w, f2));
    expect(await refusal(attach({ ...other, keyId: first.keyId }, f2))).toMatchObject({ status: 503, code: "youtube_unavailable" });
    expect((await row(other.broadcastId)).state).toBe("bound");
    // Positive pair: the same Prepared, as prepared, attaches.
    await attach(other, f2);
    expect((await row(other.broadcastId)).state).toBe("live");
  });

  it("attachPrepared on a live reservation: reserved → live, reserved_until null, last_session_id = the session (through a real Tx)", async () => {
    const w = await world();
    const f = w.fixtures[0]!;
    const { sessionId } = await goLive(w, f);
    await stop(sessionId, minutesAfter(new Date(), -1));
    const reused = await must(prep(w, f));
    const sid = await sql.begin(async (tx) => {
      const s = await insertSession(tx, w, { fixture: f, broadcast: reused.broadcastId, state: "requested" });
      await attachPrepared(tx, reused, s);
      return s;
    });
    expect(await row(reused.broadcastId)).toMatchObject({ state: "live", reserved_until: null, last_session_id: sid });
  });
});

describe.skipIf(!HAS_DB)("locks and transactions", () => {
  it("readEndFacts with a Tx reads the transaction's own view (its uncommitted session), not the pool's", async () => {
    const w = await world();
    const f = w.fixtures[0]!;
    const p = await must(prep(w, f));
    const ROLLBACK = new Error("rollback");
    await expect(sql.begin(async (tx) => {
      await insertSession(tx, w, { fixture: f, broadcast: p.broadcastId, state: "live" });
      expect((await readEndFacts(tx, p.broadcastId)).activeSessionOnBroadcast).toBe(true);
      expect((await readEndFacts(sql, p.broadcastId)).activeSessionOnBroadcast).toBe(false);
      throw ROLLBACK;
    })).rejects.toBe(ROLLBACK);
  });

  it("no row lock is held across a port call: each call finds the connection, the fixture's broadcasts and the keys lockable (nowait)", async () => {
    const w = await world();
    const f = w.fixtures[0]!;
    const held: string[] = [];
    let probes = 0;
    const methods = new Set<string>(FAKE_YOUTUBE_METHODS);
    const probing: YouTubePort = new Proxy(w.fake, {
      get(t, p) {
        const v = Reflect.get(t, p, t) as unknown;
        if (typeof v !== "function") return v;
        const fn = (v as (...x: unknown[]) => unknown).bind(t);
        if (typeof p !== "string" || !methods.has(p)) return fn;
        return async (...args: unknown[]) => {
          for (const probe of [
            (tx: Tx) => tx`select id from org_youtube_connections where id = ${w.connectionId} for update nowait`,
            (tx: Tx) => tx`select id from youtube_broadcasts where fixture_id = ${f} for update nowait`,
            (tx: Tx) => tx`select id from youtube_stream_keys where connection_id = ${w.connectionId} for update nowait`,
          ]) {
            try {
              await sql.begin((tx) => probe(tx));
            } catch (err) {
              held.push(`${p}: ${(err as { code?: string }).code ?? String(err)}`);
            }
            probes++;
          }
          return fn(...args);
        };
      },
    });
    const created = await must(prep(w, f, { port: probing }));           // accessToken, insertStream, insertBroadcast, bind
    const reused = await must(prep(w, f, { port: probing }));            // accessToken
    await abandonPrepared(reused, probing);                               // no call
    await abandonPrepared(created, probing);                              // accessToken, deleteBroadcast
    const fresh = await must(prep(w, f, { port: probing }));             // accessToken, insertBroadcast, bind (a free key)
    expect(fresh.keyId).toBe(created.keyId);
    expect(held).toEqual([]);
    expect(probes).toBe(3 * (4 + 1 + 2 + 3));
  });
});
