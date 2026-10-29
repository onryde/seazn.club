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
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { HttpError } from "@/lib/errors";
import { siteOrigin } from "@/lib/site-origin";
import { youtubeRefusalIsStale } from "@/components/v2/fixture-stream-panel";
import { insertStreamTarget } from "@/server/relay/secret-columns";
import { listStreamTargets } from "@/server/usecases/stream-targets";
import { divisionRig } from "@/server/usecases/__tests__/_rig";
import { connectionViews, updateConnectionSettings } from "@/server/youtube/connections";
import { EndRuleInvariantError, readEndFacts } from "@/server/youtube/end-rule";
import { FAKE_YOUTUBE_METHODS, FakeYouTube } from "@/server/youtube/fake";
import type { YoutubeErrorCode, YouTubePort } from "@/server/youtube/port";
import type { StartCause } from "@/server/relay/domain/session";
import { abandonPrepared, attachPrepared, prepareYoutubeBroadcast, type Prepared } from "@/server/youtube/prepare";
import { markReconnectNeeded, replaceConnectionToken } from "@/server/youtube/token-store";
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
/** The Streaming page's own words for the two channel-state refusals (spec §6.9, the T8 dictionary: "Not enabled for live" / "Live blocked"). */
const LIVE_STATE_OF: Record<string, string> = { youtube_live_not_enabled: "not_enabled", youtube_live_blocked: "blocked" };
/** Controller ruling (B4 fix round 1, I-2): a recorded not-enabled / blocked reading is believed for 10 minutes. */
const LIVE_STATE_FRESH_MINUTES = 10;

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

/** `startCause` defaults to the organiser's own tap — the case almost every test here is about; the ones about the AUTOMATIC start's
 *  retries (the channel-state short-circuit) pass it, and the F2 test sweeps all three causes. */
const prep = (w: World, fixtureId: string, o: { now?: Date; port?: YouTubePort; targetId?: string; orgId?: string; startCause?: StartCause } = {}) =>
  prepareYoutubeBroadcast(
    { orgId: o.orgId ?? w.orgId, fixtureId, targetId: o.targetId ?? w.targetId, now: o.now ?? new Date(), startCause: o.startCause ?? "organiser" },
    o.port ?? w.fake,
  );
/** The automatic start's retry: the one cause that believes a recorded channel state without asking YouTube. */
const prepAuto = (w: World, fixtureId: string, o: { now?: Date; port?: YouTubePort } = {}) => prep(w, fixtureId, { ...o, startCause: "automatic" });
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
    // The site link under the description is the same origin the match URL uses (stg links stg, prod links prod), read through
    // the same function the app reads it with: this proves the link is WIRED (a locale, a trailing "/"), not what the origin is.
    const origin = siteOrigin();
    expect(origin).toMatch(/^https?:\/\/[^/]+$/);
    const [{ comp }] = await sql<{ comp: string }[]>`
      select c.name as comp from fixtures f join divisions d on d.id = f.division_id join competitions c on c.id = d.competition_id
       where f.id = ${w.fixtures[0]!}`;
    let checked = 0;
    let witnessed = 0;   // locale words that differ from English, so their absence is a real witness
    let poweredChecked = 0;   // locales whose description carries the localised "Powered by Seazn Club · origin/" paragraph
    let poweredWitnessed = 0;   // of those, the non-en ones whose words differ from English (so the English words' absence is a witness)
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
      // Second paragraph (owner request 2026-10-29): "Powered by Seazn Club · <origin>/", in the org's locale, and last.
      const poweredBy = d["streaming.youtube.broadcast.poweredBy"]!;
      expect(poweredBy, `${locale} has the key`).toBeTruthy();
      expect(yt.description.endsWith(`\n\n${poweredBy} · ${origin}/`), locale).toBe(true);
      const paragraphs = yt.description.split("\n\n");
      expect(paragraphs, `${locale} paragraphs`).toHaveLength(2);
      expect(paragraphs[0], `${locale} first paragraph still carries the match URL`).toContain(`${origin}/shared/`);
      poweredChecked++;
      if (locale !== "en") {
        expect(poweredBy, `${locale} words differ from en`).not.toBe(en["streaming.youtube.broadcast.poweredBy"]);
        expect(yt.description, `${locale} has no en powered-by words`).not.toContain(en["streaming.youtube.broadcast.poweredBy"]);
        poweredWitnessed++;
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
    expect(poweredChecked).toBe(4);
    expect(poweredWitnessed).toBe(3);   // es, fr, nl
  });

  it("S2 (PO 2026-10-29): the Powered-by paragraph follows the public footer's rule — an org with dashboard.branding gets the one-line description, an unbranded one still gets both; the same org flips with its plan (checked === 4)", async () => {
    const a = await world(3);   // the org whose plan changes
    const b = await world(1);   // an unbranded org beside it, in the same run
    const [f1, f2, f3] = a.fixtures as [string, string, string];
    // The predicate the public tree reads (`loadOrg`'s `branded`), through SQL — and the resolver beside it.
    const branded = async (orgId: string) =>
      (await sql<{ branded: boolean }[]>`select org_has_feature(${orgId}, 'dashboard.branding') as branded`)[0]!.branded;
    const origin = siteOrigin();
    const line = en["streaming.youtube.broadcast.descriptionLine"];
    const powered = `\n\n${en["streaming.youtube.broadcast.poweredBy"]} · ${origin}/`;
    let checked = 0;
    const descriptionOf = async (w: World, f: string, wantBranded: boolean, why: string): Promise<string> => {
      expect(await branded(w.orgId), `${why}: the premise (dashboard.branding)`).toBe(wantBranded);
      const p = await must(prep(w, f));
      return w.fake.inspectBroadcast((await row(p.broadcastId)).yt_broadcast_id!)!.description;
    };
    const expectBoth = (d: string, why: string) => {
      expect(d.startsWith(`${line} ${origin}/shared/`), why).toBe(true);
      expect(d.endsWith(powered), why).toBe(true);
      expect(d.split("\n\n"), why).toHaveLength(2);
      checked++;
    };
    const expectOneLine = (d: string, f: string, why: string) => {
      // exactly the old shape: `${line} ${matchUrl}` — nothing after the match URL, no second paragraph, no site link.
      expect(d.startsWith(`${line} ${origin}/shared/`), why).toBe(true);
      expect(d.endsWith(`/fixtures/${f}`), why).toBe(true);
      expect(d, why).not.toContain("\n");
      expect(d, why).not.toContain(en["streaming.youtube.broadcast.poweredBy"]);
      checked++;
    };

    expectBoth(await descriptionOf(a, f1, false, "community org"), "unbranded org");
    // Enterprise buys the attribution's removal (V396). Through the real plan + the cache the resolver reads.
    await setOrgPlan(a.orgId, "enterprise");
    await invalidateOrgEntitlements(a.orgId);
    expectOneLine(await descriptionOf(a, f2, true, "enterprise org"), f2, "branded org");
    // The other org, same run, never had it removed.
    expectBoth(await descriptionOf(b, b.fixtures[0]!, false, "other community org"), "unbranded org beside the branded one");
    // Downgrade: the next broadcast carries the paragraph again — the rule is read per broadcast, not remembered on the org.
    await setOrgPlan(a.orgId, "community");
    await invalidateOrgEntitlements(a.orgId);
    expectBoth(await descriptionOf(a, f3, false, "community again"), "unbranded again");
    expect(checked).toBe(4);
  });

  it("S1 (owner 2026-10-29): a pooled liveStream is named by its POOL SLOT, never by the match — slot 1 → 1, a second concurrent match's new key → 2, existing names untouched, a retired slot 1 is named 1 again", async () => {
    const w = await world(3);
    const [f1, f2, f3] = w.fixtures as [string, string, string];
    const nameOf = async (keyId: string) => w.fake.inspectStream((await keyOf(keyId)).live_stream_id)?.title;
    // The match's own words: a pooled key is REUSED by later matches, so none of them may be in its name.
    const [{ home, away }] = await sql<{ home: string; away: string }[]>`
      select he.display_name as home, ae.display_name as away from fixtures f
        join entrants he on he.id = f.home_entrant_id join entrants ae on ae.id = f.away_entrant_id where f.id = ${f1}`;
    expect(home.length).toBeGreaterThan(0);
    let named = 0;
    const expectNamed = async (keyId: string, slot: number, why: string) => {
      expect((await keyOf(keyId)).slot, `${why}: the slot`).toBe(slot);
      const t = await nameOf(keyId);
      expect(t, why).toBe(`Seazn Club · stream key ${slot}`);
      expect(t, `${why}: not the match`).not.toContain(home);
      expect(t, `${why}: not the match`).not.toContain(away);
      expect(Array.from(t!).length, `${why}: YouTube's 1–128`).toBeLessThanOrEqual(LIVE_STREAM_TITLE_MAX);
      named++;
    };

    // EMPTY: the first key on the channel is slot 1.
    const A = await must(prep(w, f1));
    await expectNamed(A.keyId, 1, "first key");
    // A SECOND match while the first still holds key 1 → a NEW key, slot 2, named 2. (Sequential: two Go lives racing may share a
    // pre-read and so a number — the accepted mislabel — so the concurrent case is not asserted here.)
    const B = await must(prep(w, f2));
    await expectNamed(B.keyId, 2, "second concurrent match's key");
    await expectNamed(A.keyId, 1, "the first key is not renamed");   // existing pooled keys keep their names

    // Slot 1 leaves the pool (the club deletes its stream key in Studio → bind's liveStreamNotFound retires it, as F2): the next
    // key grown is slot 1 AGAIN, so it is named 1 again — the number is the slot, not a count of keys ever made.
    await complete(A.broadcastId);
    const at = await w.fake.accessToken(w.token);
    await w.fake.deleteBroadcast(at, (await row(A.broadcastId)).yt_broadcast_id!);
    const K = await keyOf(A.keyId);
    await w.fake.deleteStream(at, K.live_stream_id);
    await refusal(prep(w, f3));   // retires the dead key
    const C = await must(prep(w, f3));
    expect(C.keyId).not.toBe(A.keyId);
    await expectNamed(C.keyId, 1, "a new key in the retired slot 1");
    expect((await keyOf(C.keyId)).live_stream_id).not.toBe(K.live_stream_id);
    await expectNamed(B.keyId, 2, "slot 2 still named 2");
    expect(named).toBe(5);
  });

  it("S1 (locales): the stream key's name is in the org's default_locale — es, fr, nl, en take slots 1–4 (checked === 4); non-en names do not contain the English words; every name at slot 1–10 fits YouTube's 128", async () => {
    const w = await world(4);
    // The owner's strings (2026-10-29), typed here — not read back from the dictionary under test.
    const WANT: Record<"es" | "fr" | "nl" | "en", string> = {
      es: "Seazn Club · clave de emisión {n}", fr: "Seazn Club · clé de diffusión {n}",
      nl: "Seazn Club · streamsleutel {n}", en: "Seazn Club · stream key {n}",
    };
    const dicts = { en, es, fr, nl } as Record<string, Record<string, string>>;
    let checked = 0;
    let witnessed = 0;
    for (const [i, locale] of (["es", "fr", "nl", "en"] as const).entries()) {
      const f = w.fixtures[i]!;
      await sql`update organizations set default_locale = ${locale} where id = ${w.orgId}`;
      const p = await must(prep(w, f));   // each broadcast stays open → each Go live grows the next slot
      const k = await keyOf(p.keyId);
      expect(k.slot, locale).toBe(i + 1);
      const t = w.fake.inspectStream(k.live_stream_id)?.title;
      expect(t, locale).toBe(WANT[locale].replace("{n}", String(i + 1)));
      expect(dicts[locale]!["streaming.youtube.streamKeyTitle"], `${locale}: the dictionary carries the owner's string`).toBe(WANT[locale]);
      if (locale !== "en") {
        expect(t, `${locale}: no English words`).not.toContain("stream key");
        witnessed++;
      }
      checked++;
    }
    expect(checked).toBe(4);
    expect(witnessed).toBe(3);
    // The longest name any slot can get, per locale, from the shipped strings: "10 active streams per channel" is the top slot.
    let fitted = 0;
    for (const d of Object.values(dicts)) {
      const template = d["streaming.youtube.streamKeyTitle"]!;
      expect(template.split("{n}")).toHaveLength(2);   // exactly one placeholder
      for (let n = 1; n <= CHANNEL_STREAM_CAP; n++) {
        const t = template.replace("{n}", String(n));
        expect(Array.from(t).length).toBeGreaterThanOrEqual(1);
        expect(Array.from(t).length).toBeLessThanOrEqual(LIVE_STREAM_TITLE_MAX);
        expect(t).not.toMatch(/[<>]/);
        fitted++;
      }
    }
    expect(fitted).toBe(4 * CHANNEL_STREAM_CAP);
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
        // F1 (controller ruling, fix round 1): the runner never holds the YouTube key itself — the Cloudflare output does, and
        // the case above covers it in both modes. A runner still UP is held as defence in depth; one torn down ('destroyed')
        // frees the key at once, its gone-confirmation (relay-sweep's daily 04 UTC) NOT awaited.
        name: "a composed runner still up",
        hold: (sid) => sql`update fixture_stream_sessions set mode = 'composed', runner_state = 'playing', runner_gone_confirmed_at = null where id = ${sid}`,
        clear: (sid) => sql`update fixture_stream_sessions set runner_state = 'destroyed', runner_gone_confirmed_at = null where id = ${sid}`,
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

  it("F1: a composed session's runner holds its key in every runner state but the torn-down two (none, destroyed — gone-confirmation NOT awaited); swept from the schema's own check (checked === every state)", async () => {
    // The states: V410's check on fixture_stream_sessions.runner_state, read from the database, so a new state joins the sweep.
    const [{ def }] = await sql<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'fixture_stream_sessions'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%runner_state%'`;
    const states = [...def!.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]!);
    // The ruling's torn-down set (task-10-fix-1 F1): free. Every other state is a runner not torn down: held.
    const FREE = new Set(["none", "destroyed"]);
    expect(states).toEqual(expect.arrayContaining([...FREE]));
    expect(states.length).toBeGreaterThan(FREE.size);   // both directions are reachable
    const w = await world(states.length * 2);
    let checked = 0;
    let held = 0;
    for (const [i, state] of states.entries()) {
      const A = await goLive(w, w.fixtures[2 * i]!);
      await stop(A.sessionId, minutesAfter(new Date(), -10));
      await sql`update fixture_stream_sessions set mode = 'composed', runner_state = ${state}, runner_gone_confirmed_at = null where id = ${A.sessionId}`;
      await complete(A.p.broadcastId);
      const B = await must(prep(w, w.fixtures[2 * i + 1]!));
      expect(B.keyId === A.p.keyId, `runner_state ${state}`).toBe(FREE.has(state));
      if (!FREE.has(state)) held++;
      // Leave the pool as it was: B's broadcast ends, A's runner is gone, and both are gone at YouTube too (the fake allows a
      // key three open broadcasts; T14's end step is not built).
      await complete(B.broadcastId);
      await sql`update fixture_stream_sessions set runner_state = 'none' where id = ${A.sessionId}`;
      const at = await w.fake.accessToken(w.token);
      for (const id of [A.p.broadcastId, B.broadcastId]) await w.fake.deleteBroadcast(at, (await row(id)).yt_broadcast_id!);
      checked++;
    }
    expect(checked).toBe(states.length);
    expect(held).toBe(states.length - FREE.size);
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
    let flipped = 0;
    let liveRecorded = 0;
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
        // F5 (spec §6.2 D6, plan T14's same rule): a reconnect refusal at ANY step moves the connection to reconnect_needed, so
        // the Streaming page shows Reconnect; every other refusal leaves it connected. Put back, so the next case reaches its step.
        const [c] = await sql<{ status: string; last_health_at: Date | null }[]>`select status, last_health_at from org_youtube_connections where id = ${w.connectionId}`;
        expect(c!.status, label).toBe(code === "youtube_reconnect_needed" ? "reconnect_needed" : "connected");
        // I-2: a channel-state refusal from the broadcast calls is RECORDED on the connection (and short-circuits the next Go live, so it
        // is put back below like the status); the access-token exchange is not where YouTube speaks of the channel's live state, and
        // every other code says nothing about it.
        const recorded = step !== "accessToken" && code in LIVE_STATE_OF;
        expect(c!.last_health_at !== null, label).toBe(recorded);
        if (recorded) {
          liveRecorded++;
          await sql`update org_youtube_connections set last_error_code = null, last_health_at = null where id = ${w.connectionId}`;
        }
        if (c!.status !== "connected") {
          flipped++;
          await sql`update org_youtube_connections set status = 'connected', status_since = now(), last_error_code = null where id = ${w.connectionId}`;
        }
        checked++;
      }
    }
    expect(checked).toBe(20);
    expect(flipped).toBe(steps.length);   // one reconnect case per step, each one flipped
    expect(liveRecorded, "two channel-state codes at the three broadcast-call steps").toBe(6);
    // The bind cases deleted what insertBroadcast made: 5 inserted, 5 deleted.
    expect(callsOf(w.fake, "deleteBroadcast")).toBe(5);
    // Positive pair: with no failure queued the same fixture goes ahead.
    expect((await must(prep(w, f))).reused).toBe(false);
    expect(w.fake.broadcastsCount()).toBe(1);
  });

  it("F2: a pooled liveStream deleted at YouTube → bind's liveStreamNotFound RETIRES that key (503 this once); the next Go live grows a new key in the freed slot and binds; positive pair: other bind refusals retire nothing", async () => {
    const w = await world(2);
    const [f1, f2] = w.fixtures as [string, string];
    const retiredAt = async (keyId: string) =>
      (await sql<{ retired_at: Date | null }[]>`select retired_at from youtube_stream_keys where id = ${keyId}`)[0]!.retired_at;
    // A key in the pool, free again: f1's broadcast made and ended (gone at YouTube too).
    const A = await must(prep(w, f1));
    await complete(A.broadcastId);
    const at = await w.fake.accessToken(w.token);
    await w.fake.deleteBroadcast(at, (await row(A.broadcastId)).yt_broadcast_id!);
    const K = await keyOf(A.keyId);
    // Positive pair first: a bind refusal that does not say the STREAM is gone leaves the key pooled (checked === 2).
    const others: [YoutubeErrorCode, string][] = [["youtube_unavailable", "backendError"], ["youtube_not_found", "liveBroadcastNotFound"]];
    let checked = 0;
    for (const [code, reason] of others) {
      w.fake.failNext("bind", code, reason);
      expect((await refusal(prep(w, f2))).code, reason).toBe("youtube_unavailable");
      expect(await retiredAt(A.keyId), reason).toBeNull();
      checked++;
    }
    expect(checked).toBe(2);

    // The club deletes the stream key in YouTube Studio.
    await w.fake.deleteStream(at, K.live_stream_id);
    const grown = callsOf(w.fake, "insertStream");
    const err = await refusal(prep(w, f2));
    expect(err).toMatchObject({ status: 503, code: "youtube_unavailable", extra: { connectionId: w.connectionId } });
    expect(await retiredAt(A.keyId)).not.toBeNull();
    expect(callsOf(w.fake, "insertStream")).toBe(grown);   // the refused prepare grew nothing
    expect(await openCount(f2)).toBe(0);

    // The next Go live: no free key (the only one is retired) → a new liveStream, pooled in the retired key's slot, bound.
    const B = await must(prep(w, f2));
    expect(B.keyId).not.toBe(A.keyId);
    expect(callsOf(w.fake, "insertStream")).toBe(grown + 1);
    const KB = await keyOf(B.keyId);
    expect(KB.slot).toBe(K.slot);
    expect(KB.live_stream_id).not.toBe(K.live_stream_id);
    expect((await row(B.broadcastId)).state).toBe("bound");
    expect(w.fake.inspectBroadcast((await row(B.broadcastId)).yt_broadcast_id!)?.streamId).toBe(KB.live_stream_id);
    // The retired key stays out of the pool: one live key on the channel.
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from youtube_stream_keys where connection_id = ${w.connectionId} and retired_at is null`;
    expect(n).toBe(1);
  });

  it("F5: a DEAD GRANT at Go live (the refresh token refused, invalidGrant) marks the connection reconnect_needed before refusing; the next Go live refuses before any port call; negative pair: a transient refusal leaves it connected", async () => {
    const w = await world();
    const f = w.fixtures[0]!;
    const conn = async () =>
      (await sql<{ status: string; status_since: Date; last_error_code: string | null }[]>`
        select status, status_since, last_error_code from org_youtube_connections where id = ${w.connectionId}`)[0]!;
    // Negative pair first: YouTube's limit and YouTube not answering are not the club's grant (checked === 2).
    const transient: YoutubeErrorCode[] = ["youtube_limit_reached", "youtube_unavailable"];
    let checked = 0;
    for (const code of transient) {
      w.fake.failNext("accessToken", code);
      expect((await refusal(prep(w, f))).code, code).toBe(code);
      expect((await conn()).status, code).toBe("connected");
      checked++;
    }
    expect(checked).toBe(2);
    await sql`update org_youtube_connections set status_since = now() - interval '2 days' where id = ${w.connectionId}`;
    const before = await conn();

    // The club revoked Seazn's access at Google: the refresh token is dead (the fake answers invalidGrant, as Google does).
    w.fake.killToken(w.token);
    const err = await refusal(prep(w, f));
    expect(err).toMatchObject({ status: 409, code: "youtube_reconnect_needed", extra: { connectionId: w.connectionId } });
    const after = await conn();
    expect(after.status).toBe("reconnect_needed");
    expect(after.last_error_code).toBe("youtube_reconnect_needed");
    expect(after.status_since.getTime(), "status_since is now, not two days ago").toBeGreaterThan(before.status_since.getTime() + 24 * 3600 * 1000);
    expect(await rowsOf(f)).toHaveLength(0);

    // SEQUENCE: the next Go live meets the status, before any port call.
    const calls = w.fake.calls.length;
    expect((await refusal(prep(w, f))).code).toBe("youtube_reconnect_needed");
    expect(w.fake.calls.length).toBe(calls);
  });

  it("T17 carry g: 'not authorized to <live>' (insufficientLivePermissions) at a broadcast call is the CHANNEL's live permission, not a dead grant: the connection STAYS connected with status_since unchanged, the refusal is youtube_live_blocked and is recorded on it; positive pair: the same step refused as a plain dead grant still flips (checked === 3 steps x 2 refusals)", async () => {
    const w = await world();
    const f = w.fixtures[0]!;
    const conn = async () =>
      (await sql<{ status: string; status_since: Date; last_error_code: string | null; last_health_at: Date | null }[]>`
        select status, status_since, last_error_code, last_health_at from org_youtube_connections where id = ${w.connectionId}`)[0]!;
    // Ordered so each step is REACHED (insertStream runs only while the pool is empty; see the table test above).
    const steps = ["insertStream", "insertBroadcast", "bind"] as const;
    let checked = 0;
    for (const step of steps) {
      await sql`update org_youtube_connections set status_since = now() - interval '2 days' where id = ${w.connectionId}`;
      const before = await conn();
      const rowsBefore = (await rowsOf(f)).length;

      w.fake.failNext(step, "youtube_reconnect_needed", "insufficientLivePermissions");
      const err = await refusal(prep(w, f));
      expect(err, step).toMatchObject({ status: 409, code: "youtube_live_blocked", extra: { connectionId: w.connectionId } });
      const after = await conn();
      expect(after.status, `${step}: still connected - no Reconnect prompt, no purge clock`).toBe("connected");
      expect(after.status_since.getTime(), `${step}: status_since untouched`).toBe(before.status_since.getTime());
      expect(after.last_error_code, `${step}: recorded where the Streaming page reads it`).toBe("youtube_live_blocked");
      expect(after.last_health_at, step).toBeInstanceOf(Date);
      const rows = await rowsOf(f);
      expect([rows.length, rows.at(-1)!.state, rows.at(-1)!.last_error_code], step).toEqual([rowsBefore + 1, "failed", "youtube_live_blocked"]);
      expect(await openCount(f), step).toBe(0);
      await sql`update org_youtube_connections set last_error_code = null, last_health_at = null where id = ${w.connectionId}`;

      // The positive pair: the SAME step refused as a plain dead grant (no reason) is the club's grant - it flips.
      w.fake.failNext(step, "youtube_reconnect_needed");
      expect((await refusal(prep(w, f))).code, `${step}: plain`).toBe("youtube_reconnect_needed");
      expect((await conn()).status, `${step}: a dead grant flips`).toBe("reconnect_needed");
      await sql`update org_youtube_connections set status = 'connected', status_since = now(), last_error_code = null, last_health_at = null where id = ${w.connectionId}`;
      checked++;
    }
    expect(checked).toBe(3);
    // Sequence: the channel is still usable for the next Go live (nothing short-circuited it).
    expect((await must(prep(w, f))).reused).toBe(false);
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

// =====================================================================================================================================
// B4 fix round 1, I-2: what Go live learns about the CHANNEL is written where the Streaming page reads it (`liveStateOf`), so the page,
// the panel's stale-refusal rule and an automatic start's retries all see it — instead of `unknown` for ever and a YouTube call (and a
// failed row) every 60 s for the whole match.
describe.skipIf(!HAS_DB)("prepareYoutubeBroadcast — the channel's live state (B4 fix round 1, I-2)", () => {
  interface ConnFacts { status: string; last_error_code: string | null; last_health_at: Date | null }
  const facts = async (w: World): Promise<ConnFacts> =>
    (await sql<ConnFacts[]>`select status, last_error_code, last_health_at from org_youtube_connections where id = ${w.connectionId}`)[0]!;
  /** What the Streaming page / the panel's list reads for the channel — through the page's own projection. */
  const liveOf = async (w: World) => (await connectionViews(w.orgId)).get(w.connectionId)!.liveState;
  /** A clock `minutes` after the moment the refusal was recorded (the database's stamp, read back — never this process's clock). */
  const afterRecorded = async (w: World, minutes: number) => minutesAfter((await facts(w)).last_health_at!, minutes);
  const STEPS = ["insertStream", "insertBroadcast", "bind"] as const;

  it("EMPTY CASE FIRST: a never-checked channel reads unknown and has no recorded time; a first SUCCESSFUL Go live reads enabled (the page's \"Not checked yet\" does not last for ever)", async () => {
    const w = await world();
    expect(await liveOf(w)).toBe("unknown");
    expect((await facts(w)).last_health_at).toBeNull();
    await must(prep(w, w.fixtures[0]!));
    expect(await liveOf(w)).toBe("enabled");
    expect(await facts(w)).toMatchObject({ status: "connected", last_error_code: null });
  });

  it("not enabled for live / restricted, answered by YouTube at the stream, the broadcast or the bind → the connection READS not_enabled / blocked (6 rows); the retry-class codes and a dead grant at the same steps leave it unknown and unstamped (9 rows)", async () => {
    let recorded = 0;
    for (const code of Object.keys(LIVE_STATE_OF)) {
      for (const step of STEPS) {
        const w = await world();
        w.fake.failNext(step, code as YoutubeErrorCode);
        expect((await refusal(prep(w, w.fixtures[0]!))).code, `${code} @ ${step}`).toBe(code);
        expect(await liveOf(w), `${code} @ ${step}`).toBe(LIVE_STATE_OF[code]);
        expect(await facts(w), `${code} @ ${step}`).toMatchObject({ status: "connected", last_error_code: code });
        expect((await facts(w)).last_health_at, `${code} @ ${step}: stamped`).not.toBeNull();
        recorded++;
      }
    }
    expect(recorded, "two codes x three steps").toBe(6);

    let silent = 0;
    for (const code of ["youtube_unavailable", "youtube_limit_reached", "youtube_reconnect_needed"] as const) {
      for (const step of STEPS) {
        const w = await world();
        w.fake.failNext(step, code);
        expect((await refusal(prep(w, w.fixtures[0]!))).code, `${code} @ ${step}`).toBe(code);
        expect(await liveOf(w), `${code} @ ${step}: nothing was learnt about the channel's live state`).toBe("unknown");
        expect((await facts(w)).last_health_at, `${code} @ ${step}: no check is claimed`).toBeNull();
        silent++;
      }
    }
    expect(silent, "three codes x three steps").toBe(9);
  });

  it("SEQUENCE (the automatic start's retries): refused (not enabled) → the next AUTOMATIC start inside the window is refused with the SAME code and ZERO port calls and writes nothing (not even a refreshed stamp) → after the window YouTube is asked again → a clean bind reads enabled", async () => {
    let swept = 0;
    for (const code of Object.keys(LIVE_STATE_OF)) {
      const w = await world(1);
      const f = w.fixtures[0]!;
      w.fake.failNext("bind", code as YoutubeErrorCode);
      await refusal(prep(w, f));
      const first = await facts(w);
      const rows = (await rowsOf(f)).length;
      const calls = w.fake.calls.length;

      // Inside the window: 9 minutes (not 5, not 15: the ruling's ten).
      const inside = await refusal(prepAuto(w, f, { now: await afterRecorded(w, LIVE_STATE_FRESH_MINUTES - 1) }));
      expect(inside, code).toMatchObject({ status: 409, code, extra: { connectionId: w.connectionId } });
      expect(w.fake.calls.length, `${code}: YouTube was asked nothing`).toBe(calls);
      expect((await rowsOf(f)).length, `${code}: no failed row either`).toBe(rows);
      expect((await facts(w)).last_health_at?.getTime(), `${code}: the refusal does not renew its own window`).toBe(first.last_health_at!.getTime());
      // The very edge: ten minutes is no longer "fresher than ten minutes".
      const justInside = await refusal(prepAuto(w, f, { now: minutesAfter(first.last_health_at!, LIVE_STATE_FRESH_MINUTES - 1 / 60) }));
      expect(justInside.code, `${code}: 9 min 59 s is still inside`).toBe(code);
      expect(w.fake.calls.length).toBe(calls);

      // The window has lapsed: YouTube is asked (the call count moves), and its answer stands — here the same refusal, renewing the stamp.
      w.fake.failNext("bind", code as YoutubeErrorCode);
      const edge = await refusal(prep(w, f, { now: await afterRecorded(w, LIVE_STATE_FRESH_MINUTES) }));
      expect(edge.code, `${code}: asked again at exactly ten minutes`).toBe(code);
      expect(w.fake.calls.length, `${code}: the port was called`).toBeGreaterThan(calls);
      const second = await facts(w);
      expect(second.last_health_at!.getTime(), `${code}: a fresh refusal renews the window`).toBeGreaterThan(first.last_health_at!.getTime());

      // And when YouTube then says yes, the channel is `enabled` and the recorded code is gone.
      const ok = await must(prep(w, f, { now: await afterRecorded(w, LIVE_STATE_FRESH_MINUTES + 1) }));
      expect(ok.reused, code).toBe(false);
      expect(await liveOf(w), `${code}: a clean bind clears the live-state code`).toBe("enabled");
      expect(await facts(w), code).toMatchObject({ status: "connected", last_error_code: null });
      expect((await facts(w)).last_health_at!.getTime(), `${code}: …and is itself a check`).toBeGreaterThan(second.last_health_at!.getTime());
      swept++;
    }
    expect(swept, "anti-vacuity: both codes").toBe(2);
  });

  // B4 fix round 2, F2: the record exists to stop an AUTOMATIC start's every-minute retries costing a YouTube call each. A human tap is
  // different: an organiser who has just enabled live at YouTube and taps Go live again within the window must get YouTube's answer,
  // not a ten-minute-old "up to 24 hours" — so the organiser's tap and the phone operator's tap always ask.
  it("F2 — the record is believed by the AUTOMATIC start alone: inside the window the organiser's and the operator's Go live each ask YouTube (one bind) and a clean answer clears the record; the automatic start asks nothing and leaves the record as it was (2 codes x 3 causes)", async () => {
    const CAUSES: readonly StartCause[] = ["organiser", "operator", "automatic"];
    const bindsOf = (w: World) => w.fake.calls.filter((c) => c.method === "bind").length;
    let asked = 0;
    let believed = 0;
    for (const code of Object.keys(LIVE_STATE_OF)) {
      for (const cause of CAUSES) {
        const w = await world(1);
        const f = w.fixtures[0]!;
        w.fake.failNext("bind", code as YoutubeErrorCode);
        await refusal(prep(w, f));   // the record: YouTube refused for the channel's live state
        const recorded = await facts(w);
        expect(recorded, `${code}/${cause}: premise — the record is there`).toMatchObject({ last_error_code: code });
        const inside = await afterRecorded(w, LIVE_STATE_FRESH_MINUTES - 1);
        const binds = bindsOf(w);
        const calls = w.fake.calls.length;

        if (cause === "automatic") {
          expect((await refusal(prep(w, f, { now: inside, startCause: cause }))).code, `${code}/${cause}`).toBe(code);
          expect(w.fake.calls.length, `${code}/${cause}: YouTube was asked nothing`).toBe(calls);
          expect(await facts(w), `${code}/${cause}: the record is untouched`).toEqual(recorded);
          believed++;
          continue;
        }
        // YouTube now says yes (the club enabled live a minute ago): the tap is answered by YouTube, and the record clears.
        const ok = await must(prep(w, f, { now: inside, startCause: cause }));
        expect(ok.reused, `${code}/${cause}`).toBe(false);
        expect(bindsOf(w) - binds, `${code}/${cause}: YouTube was asked once`).toBe(1);
        expect(await liveOf(w), `${code}/${cause}: a success clears the recorded state`).toBe("enabled");
        const after = await facts(w);
        expect(after, `${code}/${cause}`).toMatchObject({ status: "connected", last_error_code: null });
        expect(after.last_health_at!.getTime(), `${code}/${cause}: …and is itself a check`).toBeGreaterThan(recorded.last_health_at!.getTime());
        asked++;
      }
    }
    expect(asked, "anti-vacuity: 2 codes x the 2 human causes").toBe(4);
    expect(believed, "anti-vacuity: 2 codes x the automatic cause").toBe(2);
  });

  it("F2 — a human tap inside the window that YouTube STILL refuses is YouTube's own answer, asked once, and it renews the record (a stale record is never replayed to a person)", async () => {
    let swept = 0;
    for (const code of Object.keys(LIVE_STATE_OF)) {
      const w = await world(1);
      const f = w.fixtures[0]!;
      w.fake.failNext("bind", code as YoutubeErrorCode);
      await refusal(prep(w, f));
      const recorded = await facts(w);
      const binds = w.fake.calls.filter((c) => c.method === "bind").length;
      w.fake.failNext("bind", code as YoutubeErrorCode);
      const again = await refusal(prep(w, f, { now: await afterRecorded(w, LIVE_STATE_FRESH_MINUTES - 1), startCause: "organiser" }));
      expect(again.code, code).toBe(code);
      expect(w.fake.calls.filter((c) => c.method === "bind").length - binds, `${code}: asked once`).toBe(1);
      expect((await facts(w)).last_health_at!.getTime(), `${code}: a fresh refusal renews the record`).toBeGreaterThan(recorded.last_health_at!.getTime());
      swept++;
    }
    expect(swept, "anti-vacuity: both codes").toBe(2);
  });

  it("the recorded reading is believed only while the page would read it as that state: a check older than the token, a reconnect since, or another code → YouTube is asked (positive pair: the same row, a check since the token, refuses with no call)", async () => {
    const w = await world();
    const f = w.fixtures[0]!;
    const calls = () => w.fake.calls.length;
    await sql`update org_youtube_connections set status_since = now() - interval '1 hour' where id = ${w.connectionId}`;

    // Positive pair first: a fresh `blocked` since the token → refused, no call.
    await sql`update org_youtube_connections set last_error_code = 'youtube_live_blocked', last_health_at = now() where id = ${w.connectionId}`;
    expect((await refusal(prepAuto(w, f))).code).toBe("youtube_live_blocked");
    expect(calls()).toBe(0);

    // The reading predates the token (the token was replaced after it, without the code being cleared): liveStateOf says unknown, so
    // Go live does not believe it.
    await sql`update org_youtube_connections set status_since = now() + interval '1 minute' where id = ${w.connectionId}`;
    expect(await liveOf(w), "premise: the page reads unknown").toBe("unknown");
    const before = calls();
    const ok = await must(prepAuto(w, f));
    expect(calls(), "YouTube was asked").toBeGreaterThan(before);
    expect(ok.reused).toBe(false);
    await sql`update youtube_broadcasts set state = 'failed' where id = ${ok.broadcastId}`;

    // A reconnect (the real writer) clears the code: the next Go live asks YouTube although the reading was minutes old.
    await sql`update org_youtube_connections set last_error_code = 'youtube_live_not_enabled', last_health_at = now(), status_since = now() - interval '1 hour' where id = ${w.connectionId}`;
    expect((await refusal(prepAuto(w, f))).code, "premise: believed again").toBe("youtube_live_not_enabled");
    // The grant the fake knows (a reconnect re-seals the token Google issued; an invented one would not exchange).
    expect(await replaceConnectionToken(sql, w.orgId, w.connectionId, w.token)).toBe(true);
    const beforeReconnect = calls();
    await must(prepAuto(w, f));
    expect(calls(), "after a reconnect YouTube is asked").toBeGreaterThan(beforeReconnect);

    // Any other recorded code is not a live state.
    await sql`update youtube_broadcasts set state = 'failed' where fixture_id = ${f}`;
    await sql`update org_youtube_connections set last_error_code = 'youtube_unavailable', last_health_at = now(), status_since = now() - interval '1 hour' where id = ${w.connectionId}`;
    const beforeOther = calls();
    await must(prepAuto(w, f));
    expect(calls(), "an unrecognised code is not believed").toBeGreaterThan(beforeOther);
  });

  it("SEAM, producer to consumer: the code prepare just wrote reaches the panel's destination list as the channel's live state, and the panel's stale-refusal rule KEEPS the refusal on it; a later clean bind (enabled) is what clears it (2 codes)", async () => {
    // The panel's re-read of its list is `listStreamTargets`; whether a refusal outlives that read is `youtubeRefusalIsStale`. Both real.
    const channelOf = async (w: World) => (await listStreamTargets(w.o.auth, w.orgId)).find((t) => t.id === w.targetId)!.youtube!;
    let checked = 0;
    for (const code of Object.keys(LIVE_STATE_OF)) {
      const w = await world();
      const f = w.fixtures[0]!;
      w.fake.failNext("bind", code as YoutubeErrorCode);
      await refusal(prep(w, f));
      const y = await channelOf(w);
      expect(y.liveState, `${code}: the list carries what prepare wrote`).toBe(LIVE_STATE_OF[code]);
      expect(youtubeRefusalIsStale(code as "youtube_live_not_enabled", y), `${code}: the refusal is still true — kept`).toBe(false);
      // The other channel-state refusal is not mended by this one either (not_enabled does not excuse blocked, and back).
      const other = Object.keys(LIVE_STATE_OF).find((c) => c !== code)!;
      expect(youtubeRefusalIsStale(other as "youtube_live_not_enabled", y), `${code} vs a ${other} refusal`).toBe(false);
      // YouTube then says yes: the list carries `enabled`, and only now is the old refusal stale.
      await must(prep(w, f, { now: await afterRecorded(w, LIVE_STATE_FRESH_MINUTES + 1) }));
      const ok = await channelOf(w);
      expect(ok.liveState, code).toBe("enabled");
      expect(youtubeRefusalIsStale(code as "youtube_live_not_enabled", ok), `${code}: a clean check clears it`).toBe(true);
      checked++;
    }
    expect(checked, "anti-vacuity: both codes").toBe(2);
  });

  it("the record is written only to a CONNECTED row: a grant that died while the bind was in flight keeps its own code and gets no live-state stamp", async () => {
    const w = await world();
    // The fake, with its bind killing the grant first (the club revoked access between the token and the bind) and then refusing live.
    const port = new Proxy(w.fake, {
      get(t, p) {
        const v = Reflect.get(t, p, t) as unknown;
        if (p === "bind") {
          return async (at: string, broadcastId: string, streamId: string) => {
            await markReconnectNeeded(sql, w.orgId, w.connectionId);
            t.failNext("bind", "youtube_live_not_enabled");
            return t.bind(at, broadcastId, streamId);
          };
        }
        return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(t) : v;
      },
    }) as YouTubePort;
    const err = await refusal(prep(w, w.fixtures[0]!, { port }));
    expect(err.code, "the refusal itself is the YouTube answer").toBe("youtube_live_not_enabled");
    expect(await facts(w)).toMatchObject({ status: "reconnect_needed", last_error_code: "youtube_reconnect_needed", last_health_at: null });
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

  it("abandonPrepared (T11 fix round 1, I-1): a NEW broadcast left 'live' with no session — admission committed, then provisioning deleted the session and the FK nulled last_session_id — is failed and deleted at YouTube; the same row WITH its session is left alone, a REUSED prepare never deletes it, and a second abandon changes nothing", async () => {
    const w = await world();
    const f = w.fixtures[0]!;
    const { p, sessionId } = await goLive(w, f);
    expect(p.reused, "premise: a new broadcast").toBe(false);

    // Negative pair: a live broadcast whose session still exists is that session's, not an orphan.
    await abandonPrepared(p, w.fake);
    expect(await row(p.broadcastId)).toMatchObject({ state: "live", last_session_id: sessionId });
    expect(callsOf(w.fake, "deleteBroadcast")).toBe(0);

    // provisionSession's catch: the session row goes (V479's FK is on delete set null).
    await sql`delete from fixture_stream_sessions where id = ${sessionId}`;
    expect(await row(p.broadcastId), "premise: live, no session").toMatchObject({ state: "live", last_session_id: null });

    // A reused prepare is the other half of the split: it releases a reservation and never deletes.
    await abandonPrepared({ ...p, reused: true }, w.fake);
    expect(await row(p.broadcastId)).toMatchObject({ state: "live", last_session_id: null });
    expect(callsOf(w.fake, "deleteBroadcast")).toBe(0);

    await abandonPrepared(p, w.fake);
    expect(await row(p.broadcastId)).toMatchObject({ state: "failed", last_error_code: "admission_refused" });
    expect(callsOf(w.fake, "deleteBroadcast")).toBe(1);
    expect(w.fake.broadcastsCount()).toBe(0);
    const after = await row(p.broadcastId);
    await abandonPrepared(p, w.fake);
    expect(await row(p.broadcastId)).toEqual(after);
    expect(callsOf(w.fake, "deleteBroadcast"), "a second abandon deletes nothing more").toBe(1);
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
