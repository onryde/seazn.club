// YouTube Connect T7: the OAuth route pair (POST /api/youtube/connect -> Google consent -> GET /api/youtube/connect/callback) and the
// fake authorize hop CI uses in Google's place. The shape follows lichess-oauth-routes.test.ts: next/headers is a Map-backed jar, so the
// cookies the start SETS are the ones the callback READS, exactly as a browser carries them between the two hops.
//
// What is real here, on purpose: the three routes, the FakeYouTube behind the port (the whole loop runs start -> hop -> callback, so the
// state the start records is the state the hop mints a code for and the callback redeems — a fixture on both ends would prove the
// fixture), real Postgres for the pending grant, the token store and the role reads, and — since T8 — the REAL
// `saveConnectionFromGrant` (server/youtube/connections.ts). It is wrapped in a spy, not replaced: the spy passes every call through to
// the real usecase, so a test can count the calls, read what the save returned or threw, and inject ONE failure (the "database fell
// over" case), and every other callback case ends in real connection and destination rows. (T7 shipped before T8 with a stand-in that
// followed the plan's text; it is gone, so no test here proves a stand-in.) What is stood in: the signed-in user (`requireUser`).
//
// Expected values are literals typed from the brief and the spec (cookie names, the landing codes, 600 s, consent version 1, the
// scope), never read back from the code under test. Skipped without DATABASE_URL like every DB suite here.
//
// Sport: not applicable — connecting a YouTube channel is sport-agnostic.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

// ---- doubles ------------------------------------------------------------------------------------------------------------------------

const jar = vi.hoisted(() => ({
  values: new Map<string, string>(),
  options: new Map<string, Record<string, unknown>>(),
  /** False lets a test deliver two requests that BOTH still carry the cookies (a double tap), which a real jar's delete would not. */
  deleting: true,
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.values.has(name) ? { name, value: jar.values.get(name) } : undefined),
    set: (name: string, value: string, options?: Record<string, unknown>) => {
      jar.values.set(name, value);
      jar.options.set(name, options ?? {});
    },
    delete: (name: string) => {
      if (jar.deleting) jar.values.delete(name);
    },
  }),
  headers: async () => new Headers(),
}));

const session = vi.hoisted(() => ({ user: null as { id: string } | null }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  const { AuthError } = await import("@/lib/errors");
  return {
    ...actual,
    // getOrgRole and the rest stay REAL: the start's 403 / 404 are decided by real membership rows.
    requireUser: async () => {
      if (!session.user) throw new AuthError("Not authenticated");
      return session.user;
    },
  };
});

import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { YOUTUBE_CONSENT_VERSION } from "@/lib/youtube";
import { pkceChallenge } from "@/server/external-play/pkce";
import { log } from "@/server/logger";
import { fingerprintYoutubeChannel, openWith } from "@/server/relay/crypto";
import { ApiBackedTargetError, readTargetSecret } from "@/server/relay/secret-columns";
import { listStreamTargets } from "@/server/usecases/stream-targets";
import { disabledRelayDrivers, setRelayDriversForTest } from "@/server/relay/drivers";
import { setYoutubeDriverForTest } from "@/server/youtube/driver";
import { FakeYouTube } from "@/server/youtube/fake";
import { GoogleYouTube } from "@/server/youtube/google";
import * as connections from "@/server/youtube/connections";
import { insertConnectionWithToken, openToken } from "@/server/youtube/token-store";
import { seedOrg } from "@/server/usecases/__tests__/_rig";
import { POST as START } from "../route";
import { GET as CALLBACK } from "../callback/route";
import { GET as HOP } from "../fake-authorize/route";

const HAS_DB = !!process.env.DATABASE_URL;

// ---- literals from the brief / spec -------------------------------------------------------------------------------------------------

const STATE_COOKIE = "seazn_youtube_oauth_state";
const VERIFIER_COOKIE = "seazn_youtube_oauth_verifier";
const YOUTUBE_SCOPE = "https://www.googleapis.com/auth/youtube";
const CALLBACK_URL = "http://localhost/api/youtube/connect/callback";
const KEKS = ["YOUTUBE_TOKEN_KEK", "RELAY_KEK"] as const;
const saved = Object.fromEntries(KEKS.map((k) => [k, process.env[k]]));
beforeAll(() => { for (const k of KEKS) process.env[k] = randomBytes(32).toString("hex"); });
afterAll(() => {
  for (const k of KEKS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** The spy on the save the callback calls: every call passes through to the real usecase (`vi.spyOn` keeps the implementation). */
const save = { fn: undefined as unknown as MockInstance<typeof connections.saveConnectionFromGrant> };
/** The real save, taken before any spy replaces it: a test that wraps the save calls THIS. */
const realSave = connections.saveConnectionFromGrant;

let fake: FakeYouTube;
beforeEach(() => {
  jar.values.clear();
  jar.options.clear();
  jar.deleting = true;
  session.user = null;
  vi.stubEnv("YOUTUBE_DRIVER", "fake");
  vi.stubEnv("ENV_NAME", "ci");
  vi.stubEnv("RELAY_DRIVERS", "fake");   // a deployment that can start a stream: the start's relay gate is open unless a test closes it
  // The redirect URI and the Origin comparison derive from the request unless these say otherwise.
  for (const k of ["OAUTH_BASE_URL", "NEXT_PUBLIC_BASE_URL", "YOUTUBE_REDIRECT_URI", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]) vi.stubEnv(k, undefined);
  fake = new FakeYouTube();
  setYoutubeDriverForTest(fake);
  save.fn = vi.spyOn(connections, "saveConnectionFromGrant");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setYoutubeDriverForTest(null);
  setRelayDriversForTest(null);
});

// ---- rows ---------------------------------------------------------------------------------------------------------------------------

const newUser = async (): Promise<string> =>
  (await sql<{ id: string }[]>`insert into users (email, display_name) values (${`yt7-${randomUUID()}@example.test`}, 'Connect Tester') returning id`)[0]!.id;
const channelId = () => `UC${randomUUID().replace(/-/g, "").slice(0, 22)}`;

interface Rig { orgId: string; userId: string }
async function grantFeature(orgId: string, key: string, value: boolean): Promise<void> {
  await sql`insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason) values (${orgId}, ${key}, ${value}, 'youtube connect routes')
            on conflict (org_id, feature_key) do update set bool_value = ${value}`;
  await invalidateOrgEntitlements(orgId);
}
/** An org with `userId` a member of it under `role`. It carries the plan's own streaming entitlements (V426: the stream panel and
 *  the relay are on for every plan), which is what the Directory's Streaming tab — the page that posts the start — requires. */
async function rig(role: "owner" | "admin" | "viewer" = "owner"): Promise<Rig> {
  const { auth } = await seedOrg();
  const userId = await newUser();
  await sql`insert into org_members (org_id, user_id, role) values (${auth.orgId}, ${userId}, ${role})`;
  session.user = { id: userId };
  return { orgId: auth.orgId, userId };
}

interface PendingRow {
  id: string; user_id: string; org_id: string; connection_id: string | null; state_hash: string; default_privacy: string; made_for_kids: boolean;
  consent_version: number; consent_at: Date; expires_at: Date; granted_scope: string | null; google_sub: string | null;
  channels: { id: string; title: string }[] | null; sealed: boolean;
}
const pendingRows = (orgId: string): Promise<PendingRow[]> =>
  sql<PendingRow[]>`
    select id, user_id, org_id, connection_id, state_hash, default_privacy, made_for_kids, consent_version, consent_at, expires_at, granted_scope,
           google_sub, channels, (refresh_token_enc is not null) as sealed
      from youtube_connect_pending where org_id = ${orgId} order by created_at, id`;
const connectionCount = async (orgId: string): Promise<number> =>
  (await sql<{ n: number }[]>`select count(*)::int as n from org_youtube_connections where org_id = ${orgId}`)[0]!.n;
const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

/** A LIVE connection (the fake knows its grant, so a revoke of it is observable). */
async function liveConnection(r: Rig, o: { channel?: string; sub?: string | null; token?: string; consentVersion?: number; consentAt?: Date } = {}) {
  const channel = o.channel ?? channelId();
  const refreshToken = o.token ?? `1//seed-${randomBytes(12).toString("hex")}`;
  fake.seedGrant({ refreshToken, channelId: channel, channelTitle: "Seeded FC", ...(o.sub !== undefined ? { sub: o.sub } : {}) });
  const { connectionId } = await sql.begin((tx) =>
    insertConnectionWithToken(tx, {
      orgId: r.orgId, channelId: channel, channelTitle: "Seeded FC", googleSub: o.sub ?? null, grantedScope: YOUTUBE_SCOPE, defaultPrivacy: "unlisted",
      madeForKids: false, consentBy: r.userId, consentAt: o.consentAt ?? new Date(), consentVersion: o.consentVersion ?? YOUTUBE_CONSENT_VERSION,
      createdBy: r.userId, refreshToken,
    }));
  return { connectionId, channel, refreshToken };
}

// ---- driving the three routes -------------------------------------------------------------------------------------------------------

const form = (r: Rig, over: Record<string, string | undefined> = {}) => {
  const f: Record<string, string> = { orgId: r.orgId, privacy: "unlisted", madeForKids: "0", consent: "1" };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete f[k];
    else f[k] = v;
  }
  return f;
};
const startReq = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/youtube/connect", { method: "POST", body: new URLSearchParams(fields), headers });

interface Flow { state: string; verifier: string; startRes: Response }
/** The start, which must succeed: its Location is the (fake) authorize URL carrying the state. The grant it will mint gets ONE channel
 *  with an id unique to this run, unless the test binds its own to the state afterwards: a FakeYouTube numbers its fresh channels from
 *  1 in every instance, and this suite's database outlives the instance, so a leftover live connection on `UCfake…001` would
 *  otherwise make every later "fresh" channel an other-org channel. */
async function begin(r: Rig, over: Record<string, string | undefined> = {}): Promise<Flow> {
  const res = await START(startReq(form(r, over)));
  expect(res.status, "PREMISE: the start went ahead").toBe(303);
  const state = new URL(res.headers.get("location")!).searchParams.get("state")!;
  fake.setChannels([{ id: channelId(), title: "Fresh FC" }], state);
  return { state, verifier: jar.values.get(VERIFIER_COOKIE)!, startRes: res };
}
/** The fake authorize hop: Google redirecting back. Returns the callback URL it sends the browser to. */
async function hop(state: string, extra = ""): Promise<{ res: Response; url: string }> {
  const res = await HOP(new Request(`http://localhost/api/youtube/connect/fake-authorize?state=${encodeURIComponent(state)}${extra}`));
  return { res, url: res.headers.get("location") ?? "" };
}
const callbackReq = (url: string) => new Request(url);
/** start has run; hop, then the callback. Returns the callback's response and the code the hop minted. */
async function finish(f: Flow): Promise<{ res: Response; code: string }> {
  const { url } = await hop(f.state);
  const code = new URL(url).searchParams.get("code")!;
  return { res: await CALLBACK(callbackReq(url)), code };
}

function landed(res: Response) {
  const u = new URL(res.headers.get("location") ?? "", "http://t");
  return { status: res.status, path: u.pathname, tab: u.searchParams.get("tab"), youtube: u.searchParams.get("youtube"), pending: u.searchParams.get("pending") };
}
const LANDS = (youtube: string, pending: string | null = null) => ({ status: 303, path: "/directory", tab: "streaming", youtube, pending });

const callsOf = (method: string) => fake.calls.filter((c) => c.method === method).length;
/** The refresh token the fake minted for the grant (read from the spy on the port, since the route never returns it). */
function minted(spy: ReturnType<typeof vi.spyOn>): Promise<string> {
  return (spy.mock.results[0]!.value as Promise<{ refreshToken: string }>).then((g) => g.refreshToken);
}
const isDead = async (rt: string) => {
  try {
    await fake.accessToken(rt);
    return false;
  } catch (e) {
    return (e as { code?: string }).code === "youtube_reconnect_needed";
  }
};

// =====================================================================================================================================
describe.skipIf(!HAS_DB)("POST /api/youtube/connect — the start", () => {
  it("consent first: no consent (absent, empty, 0, yes) is 400 with no pending row and no cookie; consent=1 records the consent and 303s to the authorize URL carrying the state", async () => {
    const r = await rig();
    let refused = 0;
    for (const bad of [undefined, "", "0", "yes", "true"]) {
      const res = await START(startReq(form(r, { consent: bad })));
      expect(res.status, `consent=${String(bad)}`).toBe(400);
      expect(await pendingRows(r.orgId), `consent=${String(bad)}: no pending row`).toEqual([]);
      expect(jar.values.size, `consent=${String(bad)}: no cookie`).toBe(0);
      refused++;
    }
    expect(refused, "anti-vacuity: five refusals checked").toBe(5);

    // The positive pair: the same request with consent=1 goes ahead.
    const before = Date.now();
    const res = await START(startReq(form(r, { privacy: "public", madeForKids: "1" })));
    expect(res.status).toBe(303);
    const loc = new URL(res.headers.get("location")!);
    const state = loc.searchParams.get("state")!;
    expect(state.length, "a real random state").toBeGreaterThanOrEqual(32);
    expect(loc.pathname).toBe("/api/youtube/connect/fake-authorize");
    expect(jar.values.get(STATE_COOKIE)).toBe(state);
    const verifier = jar.values.get(VERIFIER_COOKIE)!;
    expect(verifier.length, "RFC 7636: 43+ characters").toBeGreaterThanOrEqual(43);
    expect(loc.searchParams.get("code_challenge"), "the challenge is the S256 of the verifier in the cookie").toBe(pkceChallenge(verifier));
    expect(res.headers.get("location")!.includes(verifier), "the verifier itself is never in the redirect").toBe(false);

    const rows = await pendingRows(r.orgId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.consent_version).toBe(YOUTUBE_CONSENT_VERSION);
    expect(row.user_id, "consent_by = the user who ticked").toBe(r.userId);
    expect(row.default_privacy).toBe("public");
    expect(row.made_for_kids).toBe(true);
    expect(row.connection_id).toBeNull();
    expect(row.state_hash, "keyed by sha256(state), never the state").toBe(sha256Hex(state));
    expect(row.consent_at.getTime()).toBeGreaterThanOrEqual(before - 2000);
    const ttl = (row.expires_at.getTime() - row.consent_at.getTime()) / 1000;
    expect(ttl, "10 minutes").toBe(600);
  });

  it("both cookies are httpOnly, SameSite=Lax, path /, 600 s (the flow's whole life)", async () => {
    const r = await rig();
    await begin(r);
    expect([...jar.options.keys()].sort()).toEqual([STATE_COOKIE, VERIFIER_COOKIE].sort());
    for (const [name, opts] of jar.options) {
      expect(opts, name).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", maxAge: 600 });
    }
  });

  it("who may start: owner and admin may; a viewer is 403; a member of ANOTHER org only is 404; a stranger and a signed-out caller are refused — none leaves a row or a cookie", async () => {
    const cases: [string, "owner" | "admin" | "viewer", number][] = [["owner", "owner", 303], ["admin", "admin", 303], ["viewer", "viewer", 403]];
    for (const [name, role, want] of cases) {
      const r = await rig(role);
      const res = await START(startReq(form(r)));
      expect(res.status, name).toBe(want);
      expect((await pendingRows(r.orgId)).length, `${name}: rows`).toBe(want === 303 ? 1 : 0);
      jar.values.clear();
    }
    // An editor of ANOTHER org: org B's owner asks to connect for org A. The org's existence is no oracle: 404.
    const a = await rig("owner");
    const b = await rig("owner");   // signs in as b's owner
    const res404 = await START(startReq(form(a)));
    expect(res404.status).toBe(404);
    expect(await pendingRows(a.orgId)).toEqual([]);
    expect(jar.values.size).toBe(0);
    // The positive pair: org B's owner asking for org B.
    expect((await START(startReq(form(b)))).status).toBe(303);
    // A signed-out caller.
    session.user = null;
    jar.values.clear();
    const anon = await START(startReq(form(a)));
    expect(anon.status).toBe(401);
    expect(await pendingRows(a.orgId)).toEqual([]);
  });

  it("a malformed form is 400 and writes nothing: bad org id, unknown privacy, bad madeForKids, bad connection id, not a form at all", async () => {
    const r = await rig();
    const bads: Record<string, string>[] = [
      form(r, { orgId: "not-a-uuid" }), form(r, { orgId: undefined }), form(r, { privacy: "everyone" }), form(r, { privacy: undefined }),
      form(r, { madeForKids: "maybe" }), form(r, { connectionId: "nope" }),
    ];
    for (const b of bads) expect((await START(startReq(b))).status, JSON.stringify(b)).toBe(400);
    const notForm = await START(new Request("http://localhost/api/youtube/connect", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }));
    expect(notForm.status).toBe(400);
    expect(await pendingRows(r.orgId)).toEqual([]);
    expect(jar.values.size).toBe(0);
    // Positive pair for the optional fields: madeForKids absent is "No", privacy private is allowed.
    expect((await START(startReq(form(r, { madeForKids: undefined, privacy: "private" })))).status).toBe(303);
    expect((await pendingRows(r.orgId))[0]!.made_for_kids).toBe(false);
  });

  it("a present Origin that is not this site's is 403 (nothing written); an absent Origin and our own pass", async () => {
    const r = await rig();
    for (const origin of ["https://evil.example", "http://localhost:3999", "null", "https://localhost"]) {
      const res = await START(startReq(form(r), { origin }));
      expect(res.status, origin).toBe(403);
    }
    expect(await pendingRows(r.orgId)).toEqual([]);
    expect(jar.values.size).toBe(0);
    expect((await START(startReq(form(r), { origin: "http://localhost" }))).status, "our own origin").toBe(303);
    expect((await START(startReq(form(r)))).status, "no Origin header").toBe(303);
  });

  it("the Origin is judged against the origin the flow RETURNS to: with YOUTUBE_REDIRECT_URI pinned, its origin is the only one accepted", async () => {
    vi.stubEnv("YOUTUBE_REDIRECT_URI", "http://app.example.test:3000/api/youtube/connect/callback");
    const r = await rig();
    expect((await START(startReq(form(r), { origin: "http://localhost" }))).status, "the request's own host is not the pinned one").toBe(403);
    expect((await START(startReq(form(r), { origin: "http://app.example.test:3000" }))).status).toBe(303);
  });

  it("a reconnect names a live connection of THIS org: another org's, a missing one and a revoked one are 404 and write nothing; this org's is recorded on the pending row", async () => {
    const r = await rig();
    const other = await rig();
    session.user = { id: r.userId };
    const mine = await liveConnection(r);
    const theirs = await liveConnection(other);
    for (const [name, id] of [["another org's", theirs.connectionId], ["a missing one", randomUUID()]] as const) {
      expect((await START(startReq(form(r, { connectionId: id })))).status, name).toBe(404);
    }
    await sql`update org_youtube_connections set status = 'revoked', refresh_token_enc = null, revoked_at = now(), channel_id = null, channel_title = null where id = ${theirs.connectionId}`;
    const revoked = await liveConnection(r);
    await sql`update org_youtube_connections set status = 'revoked', refresh_token_enc = null, revoked_at = now(), channel_id = null, channel_title = null where id = ${revoked.connectionId}`;
    expect((await START(startReq(form(r, { connectionId: revoked.connectionId })))).status, "a revoked connection is history").toBe(404);
    expect(await pendingRows(r.orgId)).toEqual([]);
    expect((await START(startReq(form(r, { connectionId: mine.connectionId })))).status).toBe(303);
    expect((await pendingRows(r.orgId))[0]!.connection_id).toBe(mine.connectionId);
  });

  it("the start is for an org the Directory's Streaming tab is offered to: the relay switched off, the stream panel switched off (the relay alone is not enough), both off, or a deployment that cannot stream -> a landing, no pending row, no cookie, nobody sent to Google; otherwise it goes ahead", async () => {
    const refusals: [string, (r: Rig) => Promise<void>, string][] = [
      ["the relay switched off for the org", async (r) => { await grantFeature(r.orgId, "streaming.relay", false); }, "forbidden"],
      ["the stream panel switched off, the relay left on", async (r) => { await grantFeature(r.orgId, "streaming.overlay", false); }, "forbidden"],
      ["both switched off", async (r) => {
        await grantFeature(r.orgId, "streaming.overlay", false);
        await grantFeature(r.orgId, "streaming.relay", false);
      }, "forbidden"],
      ["entitled, on a deployment with no relay", async () => { setRelayDriversForTest(disabledRelayDrivers()); }, "not_configured"],
    ];
    let checked = 0;
    for (const [name, setUp, lands] of refusals) {
      const r = await rig();
      await setUp(r);
      const res = await START(startReq(form(r)));
      expect(landed(res), name).toEqual(LANDS(lands));
      expect(await pendingRows(r.orgId), `${name}: no pending row`).toEqual([]);
      expect(jar.values.size, `${name}: no cookie`).toBe(0);
      expect(callsOf("authorizeUrl"), `${name}: no authorize URL was built`).toBe(0);
      checked++;
    }
    expect(checked, "anti-vacuity: four refusals").toBe(4);

    // The sequence: the same deployment once it can stream, and the same org once its relay is back on, goes ahead.
    setRelayDriversForTest(null);
    const r = await rig();
    await grantFeature(r.orgId, "streaming.relay", false);
    expect(landed(await START(startReq(form(r)))).youtube, "relay off").toBe("forbidden");
    await grantFeature(r.orgId, "streaming.relay", true);
    const ok = await START(startReq(form(r)));
    expect(ok.status).toBe(303);
    expect(new URL(ok.headers.get("location")!).pathname).toBe("/api/youtube/connect/fake-authorize");
    expect(await pendingRows(r.orgId)).toHaveLength(1);
  });

  it("consent is once per CONNECTION (D7): a reconnect of a connection consented to the current text needs no tick and carries that consent forward; older wording, a first connect and a ticked-wrong box still need it", async () => {
    const r = await rig();
    const consentedAt = new Date("2026-09-01T10:00:00.000Z");
    const current = await liveConnection(r, { consentAt: consentedAt });
    const older = await liveConnection(r, { consentVersion: YOUTUBE_CONSENT_VERSION - 1, consentAt: consentedAt });
    const foreign = await liveConnection(await rig());
    session.user = { id: r.userId };

    const start = async (fields: Record<string, string | undefined>) => {
      jar.values.clear();
      const before = (await pendingRows(r.orgId)).length;
      const res = await START(startReq(form(r, fields)));
      const rows = await pendingRows(r.orgId);
      return { res, added: rows.length - before, row: rows[rows.length - 1]! };
    };

    // a) current text, no tick: goes ahead, and the pending row carries the connection's own consent record.
    const carried = await start({ connectionId: current.connectionId, consent: undefined });
    expect(carried.res.status).toBe(303);
    expect(carried.added).toBe(1);
    expect(carried.row.connection_id).toBe(current.connectionId);
    expect(carried.row.consent_version).toBe(YOUTUBE_CONSENT_VERSION);
    expect(carried.row.consent_at.getTime(), "the consent given a month ago, not now").toBe(consentedAt.getTime());

    // b) current text, ticked anyway: the consent is recorded again, now.
    const ticked = await start({ connectionId: current.connectionId });
    expect(ticked.res.status).toBe(303);
    expect(ticked.row.consent_at.getTime()).toBeGreaterThan(consentedAt.getTime() + 24 * 3600 * 1000);

    // c) older wording, no tick: refused, nothing written. d) older wording, ticked: goes ahead on the CURRENT version.
    const stale = await start({ connectionId: older.connectionId, consent: undefined });
    expect(stale.res.status).toBe(400);
    expect(stale.added).toBe(0);
    expect(jar.values.size, "no cookie").toBe(0);
    const reTicked = await start({ connectionId: older.connectionId });
    expect(reTicked.res.status).toBe(303);
    expect(reTicked.row.consent_version, "the text they ticked now, not the one they saw before").toBe(YOUTUBE_CONSENT_VERSION);

    // e) a first connect with no tick: refused. f) a value that is not "1" is malformed even where the tick is not needed.
    const first = await start({ consent: undefined });
    expect([first.res.status, first.added]).toEqual([400, 0]);
    const wrong = await start({ connectionId: current.connectionId, consent: "0" });
    expect([wrong.res.status, wrong.added]).toEqual([400, 0]);

    // g) another org's connection is no carried consent: 404, as ever.
    const theirs = await start({ connectionId: foreign.connectionId, consent: undefined });
    expect([theirs.res.status, theirs.added]).toEqual([404, 0]);
  });

  it("refuses BEFORE sending anyone to Google when a key the callback needs is unusable (YOUTUBE_TOKEN_KEK or RELAY_KEK, unset or malformed): not_configured, no pending row, no cookie, no authorize built", async () => {
    const r = await rig();
    const faults: [string, string, string | undefined][] = [
      ["YOUTUBE_TOKEN_KEK unset", "YOUTUBE_TOKEN_KEK", undefined], ["YOUTUBE_TOKEN_KEK malformed", "YOUTUBE_TOKEN_KEK", "zz".repeat(32)],
      ["RELAY_KEK unset", "RELAY_KEK", undefined], ["RELAY_KEK malformed", "RELAY_KEK", "abcd"],
    ];
    for (const [name, key, value] of faults) {
      vi.stubEnv(key, value);
      const res = await START(startReq(form(r)));
      expect(landed(res), name).toEqual(LANDS("not_configured"));
      expect(await pendingRows(r.orgId), `${name}: no pending row`).toEqual([]);
      expect(jar.values.size, `${name}: no cookie`).toBe(0);
      expect(callsOf("authorizeUrl"), `${name}: no authorize URL was built`).toBe(0);
      vi.unstubAllEnvs();
      vi.stubEnv("YOUTUBE_DRIVER", "fake");
      vi.stubEnv("ENV_NAME", "ci");
      vi.stubEnv("RELAY_DRIVERS", "fake");
    }
    // The positive pair: with both keys usable the same request goes to the authorize URL.
    expect((await START(startReq(form(r)))).status).toBe(303);
    expect(callsOf("authorizeUrl")).toBe(1);
  });

  it("the LIVE driver: without the Google client config it is a clean not_configured (no 500, no row, no cookie); with it the redirect is Google's authorize URL with PKCE S256 and the one scope", async () => {
    vi.stubEnv("YOUTUBE_DRIVER", "live");
    setYoutubeDriverForTest(new GoogleYouTube());
    const r = await rig();
    const res = await START(startReq(form(r)));
    expect(landed(res)).toEqual(LANDS("not_configured"));
    expect(await pendingRows(r.orgId)).toEqual([]);
    expect(jar.values.size).toBe(0);

    vi.stubEnv("GOOGLE_CLIENT_ID", "client-id.apps.example");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "client-secret-value");
    const ok = await START(startReq(form(r)));
    expect(ok.status).toBe(303);
    const loc = new URL(ok.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const p = loc.searchParams;
    expect([p.get("scope"), p.get("access_type"), p.get("prompt"), p.get("code_challenge_method"), p.get("response_type"), p.get("client_id")]).toEqual([
      YOUTUBE_SCOPE, "offline", "consent", "S256", "code", "client-id.apps.example",
    ]);
    expect(p.get("redirect_uri")).toBe(CALLBACK_URL);
    expect(p.get("state")).toBe(jar.values.get(STATE_COOKIE));
    expect(p.get("code_challenge")).toBe(pkceChallenge(jar.values.get(VERIFIER_COOKIE)!));
    expect(ok.headers.get("location")!.includes("client-secret-value"), "the client secret is never in the URL").toBe(false);
    expect(ok.headers.get("location")!.includes(jar.values.get(VERIFIER_COOKIE)!), "nor the verifier").toBe(false);
    expect(await pendingRows(r.orgId)).toHaveLength(1);
  });
});

// =====================================================================================================================================
describe.skipIf(!HAS_DB)("GET /api/youtube/connect/callback — the landing", () => {
  it("connected: ONE channel -> the grant's details and sealed token are on the pending row WHEN save runs, save is told the channel, the cookies are spent, and the grant is not revoked", async () => {
    const r = await rig();
    const f = await begin(r);
    const ch = { id: channelId(), title: "Solo United" };
    fake.setChannels([ch], f.state);
    fake.setGoogleSub("sub-solo", f.state);
    let atSave: PendingRow[] = [];
    save.fn.mockImplementationOnce(async (a, port) => {
      atSave = await pendingRows(r.orgId);
      return realSave(a, port);
    });
    const { res } = await finish(f);

    expect(landed(res)).toEqual(LANDS("connected"));
    expect(save.fn).toHaveBeenCalledTimes(1);
    expect(save.fn.mock.calls[0]![0]).toEqual({ pendingId: atSave[0]!.id, channelId: ch.id, userId: r.userId });
    expect(atSave).toHaveLength(1);
    expect(atSave[0]).toMatchObject({ sealed: true, granted_scope: YOUTUBE_SCOPE, google_sub: "sub-solo", channels: [ch], org_id: r.orgId });
    expect(jar.values.size, "both cookies are spent").toBe(0);
    expect(callsOf("revoke"), "a connection was made: nothing to revoke").toBe(0);
    expect(await connectionCount(r.orgId)).toBe(1);
    expect(await pendingRows(r.orgId), "the save consumed the pending row").toEqual([]);
  });

  it("pick: TWO channels -> pick with the pending id, the token sealed on the PENDING row and on no connection, the channel list stored, save not called", async () => {
    const r = await rig();
    const f = await begin(r);
    const chs = [{ id: channelId(), title: "First FC" }, { id: channelId(), title: "Second FC" }];
    fake.setChannels(chs, f.state);
    const { res } = await finish(f);
    const rows = await pendingRows(r.orgId);
    expect(rows).toHaveLength(1);
    expect(landed(res)).toEqual(LANDS("pick", rows[0]!.id));
    expect(rows[0]).toMatchObject({ sealed: true, channels: chs, granted_scope: YOUTUBE_SCOPE });
    expect(await connectionCount(r.orgId), "no connection until a channel is chosen").toBe(0);
    expect(save.fn).not.toHaveBeenCalled();
    expect(callsOf("revoke"), "the grant is kept for the pick").toBe(0);
    // The sealed token really is the grant's: it opens under YOUTUBE_TOKEN_KEK and the fake accepts it.
    const [enc] = await sql<{ refresh_token_enc: Uint8Array }[]>`select refresh_token_enc from youtube_connect_pending where id = ${rows[0]!.id}`;
    await expect(fake.accessToken(openWith("YOUTUBE_TOKEN_KEK", enc!.refresh_token_enc))).resolves.toEqual(expect.any(String));
  });

  it("no_channel: a Google account with no YouTube channel -> no_channel, the grant revoked, the pending row gone, nothing stored", async () => {
    const r = await rig();
    const f = await begin(r);
    fake.setChannels([], f.state);
    const exchange = vi.spyOn(fake, "exchangeCode");
    const { res } = await finish(f);
    expect(landed(res)).toEqual(LANDS("no_channel"));
    expect(callsOf("revoke")).toBe(1);
    expect(await isDead(await minted(exchange)), "the grant is revoked at Google").toBe(true);
    expect(await pendingRows(r.orgId)).toEqual([]);
    expect(await connectionCount(r.orgId)).toBe(0);
    expect(save.fn).not.toHaveBeenCalled();
  });

  it("scope_missing: scope is a MEMBERSHIP test on the space-separated list — a list without the YouTube scope, or only a longer sibling scope, is refused; the scope among others passes", async () => {
    // [granted scope, lands]
    const table: [string, string, string][] = [
      ["a different scope", "https://www.googleapis.com/auth/userinfo.email", "scope_missing"],
      ["a sibling that merely CONTAINS the scope as a prefix", `${YOUTUBE_SCOPE}.readonly`, "scope_missing"],
      ["a sibling with the scope as a suffix", `https://x.example${YOUTUBE_SCOPE}`, "scope_missing"],
      ["force-ssl alone (the spec dropped it)", "https://www.googleapis.com/auth/youtube.force-ssl", "scope_missing"],
      ["the scope first of two", `${YOUTUBE_SCOPE} https://www.googleapis.com/auth/userinfo.email`, "connected"],
      ["the scope last of three", `openid email ${YOUTUBE_SCOPE}`, "connected"],
    ];
    let checked = 0;
    for (const [name, scope, lands] of table) {
      const r = await rig();
      const f = await begin(r);
      fake.setGrantedScope(scope, f.state);
      const exchange = vi.spyOn(fake, "exchangeCode");
      const revokesBefore = callsOf("revoke");
      const { res } = await finish(f);
      expect(landed(res), name).toEqual(LANDS(lands));
      if (lands === "scope_missing") {
        expect(callsOf("revoke") - revokesBefore, `${name}: revoked once`).toBe(1);
        expect(await isDead(await minted(exchange)), `${name}: the grant is dead`).toBe(true);
        expect(await connectionCount(r.orgId), `${name}: no connection`).toBe(0);
        expect(await pendingRows(r.orgId), `${name}: no pending row`).toEqual([]);
      } else {
        expect(callsOf("revoke") - revokesBefore, `${name}: kept`).toBe(0);
      }
      exchange.mockRestore();
      checked++;
    }
    expect(checked).toBe(6);
  });

  it("state: a cookie that is missing, or differs from the query's, is expired — nothing exchanged, nothing stored, the real pending row untouched", async () => {
    const r = await rig();
    const f = await begin(r);
    const { url } = await hop(f.state);
    const real = new URL(url);

    // a) the query carries a different state than the cookie
    const forged = new URL(real);
    forged.searchParams.set("state", "attacker-chosen-state");
    expect(landed(await CALLBACK(callbackReq(forged.toString())))).toEqual(LANDS("expired"));
    // b) no state cookie at all (cleared, or another browser)
    jar.values.clear();
    jar.values.set(VERIFIER_COOKIE, f.verifier);
    expect(landed(await CALLBACK(callbackReq(url)))).toEqual(LANDS("expired"));
    // c) no verifier
    jar.values.clear();
    jar.values.set(STATE_COOKIE, f.state);
    expect(landed(await CALLBACK(callbackReq(url)))).toEqual(LANDS("expired"));
    // d) no state in the query
    jar.values.set(VERIFIER_COOKIE, f.verifier);
    jar.values.set(STATE_COOKIE, f.state);
    const noState = new URL(real);
    noState.searchParams.delete("state");
    expect(landed(await CALLBACK(callbackReq(noState.toString())))).toEqual(LANDS("expired"));

    // e) the query carries a REAL pending state of this same user, but the cookie holds the state of a later flow (a second tab):
    //    the cookie is what binds the browser to the flow, so the callback is expired and the real row is not spent.
    const other = await begin(r);   // overwrites the cookies with the second flow's
    expect(other.state, "PREMISE: a second, different flow").not.toBe(f.state);
    expect(jar.values.get(STATE_COOKIE), "PREMISE: the cookie now holds the second flow's state").toBe(other.state);
    expect(landed(await CALLBACK(callbackReq(url))), "query = first flow's real state, cookie = second flow's").toEqual(LANDS("expired"));

    expect(callsOf("exchangeCode"), "no code was ever redeemed").toBe(0);
    expect(await connectionCount(r.orgId)).toBe(0);
    expect(save.fn).not.toHaveBeenCalled();
    const rows = await pendingRows(r.orgId);
    expect(rows, "neither real pending row (first flow, second flow) was consumed by any of the forgeries").toHaveLength(2);
    expect(rows.map((x) => x.state_hash).sort()).toEqual([sha256Hex(f.state), sha256Hex(other.state)].sort());

    // The positive pair: the genuine callback with the genuine cookies still works afterwards.
    jar.values.set(STATE_COOKIE, f.state);
    jar.values.set(VERIFIER_COOKIE, f.verifier);
    expect(landed(await CALLBACK(callbackReq(url))).youtube).toBe("connected");
  });

  it("REPLAY (Review Focus 2): the same state a second time is expired — even with the cookies put back — and there is still exactly one connection and one exchange", async () => {
    const r = await rig();
    const f = await begin(r);
    const { url } = await hop(f.state);
    const first = await CALLBACK(callbackReq(url));
    expect(landed(first).youtube).toBe("connected");
    expect(await connectionCount(r.orgId)).toBe(1);

    // The back button / a second tab: the cookies were spent, so this request has none.
    expect(landed(await CALLBACK(callbackReq(url))).youtube, "no cookies").toBe("expired");
    // The strong form: a second tab that STILL carries both cookies. The database alone must refuse it.
    jar.values.set(STATE_COOKIE, f.state);
    jar.values.set(VERIFIER_COOKIE, f.verifier);
    expect(landed(await CALLBACK(callbackReq(url))).youtube, "cookies present, state spent").toBe("expired");

    expect(await connectionCount(r.orgId), "still exactly one connection").toBe(1);
    expect(save.fn).toHaveBeenCalledTimes(1);
    expect(callsOf("exchangeCode"), "the code was redeemed once").toBe(1);
  });

  it("REPLAY on a pending row that SURVIVES (a pick): the second callback is expired before any exchange, and the token sealed on the row is not replaced", async () => {
    const r = await rig();
    const f = await begin(r);
    fake.setChannels([{ id: channelId(), title: "A" }, { id: channelId(), title: "B" }], f.state);
    const { url } = await hop(f.state);
    expect(landed(await CALLBACK(callbackReq(url))).youtube).toBe("pick");
    const [first] = await sql<{ id: string; refresh_token_enc: Uint8Array }[]>`select id, refresh_token_enc from youtube_connect_pending where org_id = ${r.orgId}`;
    expect(first!.refresh_token_enc, "PREMISE: a token is sealed on the surviving row").not.toBeNull();

    jar.values.set(STATE_COOKIE, f.state);
    jar.values.set(VERIFIER_COOKIE, f.verifier);
    expect(landed(await CALLBACK(callbackReq(url))).youtube, "the same state again").toBe("expired");
    expect(callsOf("exchangeCode"), "nothing was exchanged the second time").toBe(1);
    const rows = await sql<{ id: string; refresh_token_enc: Uint8Array; state_hash: string }[]>`select id, refresh_token_enc, state_hash from youtube_connect_pending where org_id = ${r.orgId}`;
    expect(rows, "still the one row").toHaveLength(1);
    expect(Buffer.from(rows[0]!.refresh_token_enc).equals(Buffer.from(first!.refresh_token_enc)), "its sealed token is the same bytes").toBe(true);
    expect(rows[0]!.state_hash, "the state no longer finds the row").not.toBe(sha256Hex(f.state));
  });

  it("two requests at once with the same state (a double tap, both carrying the cookies): exactly one connects, the other is expired, one connection row", async () => {
    const r = await rig();
    const f = await begin(r);
    const { url } = await hop(f.state);
    jar.deleting = false;
    const results = await Promise.all([CALLBACK(callbackReq(url)), CALLBACK(callbackReq(url))]);
    expect(results.map((x) => landed(x).youtube).sort()).toEqual(["connected", "expired"]);
    expect(await connectionCount(r.orgId)).toBe(1);
    expect(save.fn).toHaveBeenCalledTimes(1);
    expect(callsOf("exchangeCode")).toBe(1);
  });

  it("an expired pending row (10 minutes passed) is expired: nothing is exchanged", async () => {
    const r = await rig();
    const f = await begin(r);
    await sql`update youtube_connect_pending set expires_at = now() - interval '1 second' where org_id = ${r.orgId}`;
    expect(landed((await finish(f)).res)).toEqual(LANDS("expired"));
    expect(callsOf("exchangeCode")).toBe(0);
    expect(await connectionCount(r.orgId)).toBe(0);
    // Positive pair: a row that has NOT passed its time connects.
    const r2 = await rig();
    const f2 = await begin(r2);
    expect(landed((await finish(f2)).res).youtube).toBe("connected");
  });

  it("the pending grant belongs to its user: another signed-in user (or nobody) with the same state is expired and does NOT consume it", async () => {
    const r = await rig();
    const f = await begin(r);
    const { url } = await hop(f.state);
    const intruder = await newUser();
    session.user = { id: intruder };
    expect(landed(await CALLBACK(callbackReq(url))).youtube, "another user").toBe("expired");
    session.user = null;
    jar.values.set(STATE_COOKIE, f.state);
    jar.values.set(VERIFIER_COOKIE, f.verifier);
    expect(landed(await CALLBACK(callbackReq(url))).youtube, "signed out").toBe("expired");
    expect(callsOf("exchangeCode")).toBe(0);
    expect(await pendingRows(r.orgId)).toHaveLength(1);
    // The owner of the grant still completes it.
    session.user = { id: r.userId };
    jar.values.set(STATE_COOKIE, f.state);
    jar.values.set(VERIFIER_COOKIE, f.verifier);
    expect(landed(await CALLBACK(callbackReq(url))).youtube).toBe("connected");
  });

  it("forbidden: the user lost the editor role between start and callback (removed, or demoted to viewer) -> forbidden, the grant revoked, nothing stored; still an editor -> connected", async () => {
    const losses: [string, (r: Rig) => Promise<unknown>][] = [
      ["removed from the org", (r) => sql`delete from org_members where org_id = ${r.orgId} and user_id = ${r.userId}`],
      ["demoted to viewer", (r) => sql`update org_members set role = 'viewer' where org_id = ${r.orgId} and user_id = ${r.userId}`],
    ];
    let checked = 0;
    for (const [name, lose] of losses) {
      const r = await rig();
      const f = await begin(r);
      await lose(r);
      const exchange = vi.spyOn(fake, "exchangeCode");
      const revokesBefore = callsOf("revoke");
      const { res } = await finish(f);
      expect(landed(res), name).toEqual(LANDS("forbidden"));
      expect(callsOf("revoke") - revokesBefore, `${name}: revoked once`).toBe(1);
      expect(await isDead(await minted(exchange)), `${name}: dead at Google`).toBe(true);
      expect(await connectionCount(r.orgId), `${name}: nothing stored`).toBe(0);
      expect(await pendingRows(r.orgId), `${name}: pending row gone`).toEqual([]);
      expect(save.fn, name).not.toHaveBeenCalled();
      exchange.mockRestore();
      checked++;
    }
    expect(checked).toBe(2);
    // The positive pair: an admin (an editor role other than the start's) still connects.
    const a = await rig("admin");
    const f = await begin(a);
    expect(landed((await finish(f)).res).youtube).toBe("connected");
  });

  it("denied: Google's access_denied (with the right state) -> denied, the code is never exchanged, the pending row is dropped; the same error with a wrong state is expired", async () => {
    const r = await rig();
    const f = await begin(r);
    const denied = new URL(CALLBACK_URL);
    denied.searchParams.set("error", "access_denied");
    denied.searchParams.set("state", f.state);
    expect(landed(await CALLBACK(callbackReq(denied.toString())))).toEqual(LANDS("denied"));
    expect(callsOf("exchangeCode")).toBe(0);
    expect(callsOf("revoke"), "no grant exists to revoke").toBe(0);
    expect(await pendingRows(r.orgId)).toEqual([]);
    expect(jar.values.size).toBe(0);

    const r2 = await rig();
    await begin(r2);
    const wrong = new URL(CALLBACK_URL);
    wrong.searchParams.set("error", "access_denied");
    wrong.searchParams.set("state", "someone-elses-state");
    expect(landed(await CALLBACK(callbackReq(wrong.toString()))).youtube, "an error under a state that is not ours is not our denial").toBe("expired");
    expect(await pendingRows(r2.orgId)).toHaveLength(1);
  });

  it("a callback with a matching state but no code (and no error) is expired and drops the pending row", async () => {
    const r = await rig();
    const f = await begin(r);
    const url = new URL(CALLBACK_URL);
    url.searchParams.set("state", f.state);
    expect(landed(await CALLBACK(callbackReq(url.toString())))).toEqual(LANDS("expired"));
    expect(callsOf("exchangeCode")).toBe(0);
    expect(await pendingRows(r.orgId)).toEqual([]);
  });

  it("the exchange itself failing: an unconfigured or mismatched redirect is not_configured (Seazn's own); any other refusal is expired; both drop the pending row and revoke nothing", async () => {
    const table: [string, "youtube_unavailable" | "youtube_reconnect_needed", string, string][] = [
      ["no Google client config", "youtube_unavailable", "notConfigured", "not_configured"],
      ["redirect URI not registered", "youtube_unavailable", "redirectUriMismatch", "not_configured"],
      ["code already used / expired", "youtube_reconnect_needed", "invalidGrant", "expired"],
      ["Google unreachable", "youtube_unavailable", "network", "expired"],
    ];
    for (const [name, code, reason, lands] of table) {
      const r = await rig();
      const f = await begin(r);
      fake.failNext("exchangeCode", code, reason);
      expect(landed((await finish(f)).res), name).toEqual(LANDS(lands));
      expect(await pendingRows(r.orgId), `${name}: pending row gone`).toEqual([]);
      expect(await connectionCount(r.orgId), name).toBe(0);
    }
    expect(callsOf("revoke"), "there was no grant to revoke").toBe(0);
  });

  it("an unexpected failure after the grant exists (save blows up): expired, the pending row (and the token sealed on it) dropped, the grant revoked, and nothing secret in the log", async () => {
    const r = await rig();
    const f = await begin(r);
    const logged = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const exchange = vi.spyOn(fake, "exchangeCode");
    save.fn.mockRejectedValueOnce(new Error("the database fell over"));
    const { res, code } = await finish(f);
    expect(landed(res)).toEqual(LANDS("expired"));
    expect(await pendingRows(r.orgId)).toEqual([]);
    const rt = await minted(exchange);
    expect(callsOf("revoke")).toBe(1);
    expect(await isDead(rt)).toBe(true);
    expect(logged).toHaveBeenCalled();
    const everything = JSON.stringify(logged.mock.calls);
    for (const secret of [rt, code, f.verifier]) expect(everything.includes(secret), "the log carries no token, code or verifier").toBe(false);
  });
});

// =====================================================================================================================================
describe.skipIf(!HAS_DB)("reconnect", () => {
  it("the grant's channel differs from the connection's -> different_channel; the new grant is revoked; the old token is byte-for-byte untouched and still works", async () => {
    const r = await rig();
    const old = await liveConnection(r);
    const [before] = await sql<{ refresh_token_enc: Uint8Array; status_since: Date }[]>`select refresh_token_enc, status_since from org_youtube_connections where id = ${old.connectionId}`;
    const f = await begin(r, { connectionId: old.connectionId });
    fake.setChannels([{ id: channelId(), title: "Somebody Else FC" }], f.state);
    const exchange = vi.spyOn(fake, "exchangeCode");
    const { res } = await finish(f);
    expect(landed(res)).toEqual(LANDS("different_channel"));
    expect(save.fn).not.toHaveBeenCalled();
    expect(callsOf("revoke"), "the NEW grant is revoked").toBe(1);
    expect(await isDead(await minted(exchange))).toBe(true);
    const [after] = await sql<{ refresh_token_enc: Uint8Array; status: string; status_since: Date }[]>`select refresh_token_enc, status, status_since from org_youtube_connections where id = ${old.connectionId}`;
    expect(Buffer.from(after!.refresh_token_enc).equals(Buffer.from(before!.refresh_token_enc)), "the sealed envelope is the same bytes").toBe(true);
    expect(after!.status).toBe("connected");
    expect(after!.status_since.getTime()).toBe(before!.status_since.getTime());
    expect(await openToken(sql, r.orgId, old.connectionId)).toBe(old.refreshToken);
    await expect(fake.accessToken(old.refreshToken), "the old grant was not killed by revoking the new one").resolves.toEqual(expect.any(String));
    expect(await pendingRows(r.orgId)).toEqual([]);
  });

  it("the same channel -> save is told the CONNECTION's channel even when it is not the grant's first (the order differs from the right answer), and the token is replaced", async () => {
    const r = await rig();
    const old = await liveConnection(r);
    const f = await begin(r, { connectionId: old.connectionId });
    const other = { id: channelId(), title: "Listed First FC" };
    fake.setChannels([other, { id: old.channel, title: "Seeded FC" }], f.state);   // the connection's channel is SECOND
    const exchange = vi.spyOn(fake, "exchangeCode");
    const { res } = await finish(f);
    expect(landed(res)).toEqual(LANDS("connected"));
    expect(save.fn).toHaveBeenCalledTimes(1);
    expect(save.fn.mock.calls[0]![0]).toMatchObject({ channelId: old.channel, userId: r.userId });
    expect(save.fn.mock.calls[0]![0].channelId).not.toBe(other.id);
    expect(await connectionCount(r.orgId), "a reconnect makes no second connection").toBe(1);
    expect(await openToken(sql, r.orgId, old.connectionId), "the token is the NEW grant's").toBe(await minted(exchange));
    expect(callsOf("revoke")).toBe(0);
  });

  it("the connection was disconnected between start and callback -> expired and the new grant is revoked", async () => {
    const r = await rig();
    const old = await liveConnection(r);
    const f = await begin(r, { connectionId: old.connectionId });
    await sql`update org_youtube_connections set status = 'revoked', refresh_token_enc = null, revoked_at = now(), channel_id = null, channel_title = null where id = ${old.connectionId}`;
    const { res } = await finish(f);
    expect(landed(res)).toEqual(LANDS("expired"));
    expect(save.fn).not.toHaveBeenCalled();
    expect(callsOf("revoke")).toBe(1);
  });
});

// =====================================================================================================================================
describe.skipIf(!HAS_DB)("GET /api/youtube/connect/callback — a failure before any grant exists", () => {
  it("the driver cannot be built (a misspelt YOUTUBE_DRIVER): the house error response (JSON, ok:false, no landing, no secret), not a rejection — and the cookies are spent, nothing exchanged or stored", async () => {
    const r = await rig();
    const f = await begin(r);
    const { url } = await hop(f.state);
    const code = new URL(url).searchParams.get("code")!;
    setYoutubeDriverForTest(null);
    vi.stubEnv("YOUTUBE_DRIVER", "fakee");

    const res = await CALLBACK(callbackReq(url));
    expect(res.status).toBe(500);
    expect(res.headers.get("location"), "not a landing: nothing was decided").toBeNull();
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ ok: false, error: expect.stringContaining("YOUTUBE_DRIVER") });
    for (const secret of [code, f.verifier, f.state]) expect(text.includes(secret), "no secret in the body").toBe(false);
    expect(jar.values.size, "both cookies were spent on arrival").toBe(0);
    expect(callsOf("exchangeCode")).toBe(0);
    expect(await connectionCount(r.orgId)).toBe(0);
    expect(save.fn).not.toHaveBeenCalled();
  });
});

// =====================================================================================================================================
describe.skipIf(!HAS_DB)("a grant is never revoked while a live connection uses it (controller ruling, 2026-10-27)", () => {
  it("other_org: the channel is live in ANOTHER org -> other_org and the new token is NOT revoked, the other org's connection is untouched, our pending row is dropped", async () => {
    const other = await rig();
    const theirs = await liveConnection(other);
    const r = await rig();
    const f = await begin(r);
    fake.setChannels([{ id: theirs.channel, title: "Seeded FC" }], f.state);
    const { res } = await finish(f);
    expect(landed(res)).toEqual(LANDS("other_org"));
    expect(save.fn).toHaveBeenCalledTimes(1);
    expect(callsOf("revoke"), "revoking the grant would kill the other org's live connection").toBe(0);
    expect(await connectionCount(r.orgId)).toBe(0);
    expect(await pendingRows(r.orgId), "the pending row (and its sealed token) is dropped").toEqual([]);
    expect(await openToken(sql, other.orgId, theirs.connectionId)).toBe(theirs.refreshToken);
    await expect(fake.accessToken(theirs.refreshToken)).resolves.toEqual(expect.any(String));
  });

  it("every revoking refusal keeps the grant when a live connection holds the grant's channel or its Google account, and revokes when none does", async () => {
    // [refusal, how it is provoked]
    const refusals: [string, (r: Rig, state: string) => Promise<void>, string][] = [
      ["scope_missing", async (_r, s) => fake.setGrantedScope("https://www.googleapis.com/auth/userinfo.email", s), "scope_missing"],
      ["forbidden", async (r) => { await sql`update org_members set role = 'viewer' where org_id = ${r.orgId} and user_id = ${r.userId}`; }, "forbidden"],
    ];
    // [how a live connection elsewhere holds the grant, applied to the flow's state, returns the seeded connection's token]
    const holders: [string, (state: string, ch: string) => Promise<string | null>][] = [
      ["its channel", async (state, ch) => {
        fake.setChannels([{ id: ch, title: "Held FC" }], state);
        const holder = await liveConnection(await rig(), { channel: ch });
        return holder.refreshToken;
      }],
      ["its Google account (another channel, same sub)", async (state, ch) => {
        fake.setChannels([{ id: ch, title: "Same Account FC" }], state);
        fake.setGoogleSub("shared-account-sub", state);
        const holder = await liveConnection(await rig(), { sub: "shared-account-sub" });
        return holder.refreshToken;
      }],
      ["nothing", async (state, ch) => { fake.setChannels([{ id: ch, title: "Free FC" }], state); return null; }],
    ];
    let checked = 0;
    for (const [refusalName, provoke, lands] of refusals) {
      for (const [holderName, hold] of holders) {
        const r = await rig();
        const f = await begin(r);
        await provoke(r, f.state);
        const heldToken = await hold(f.state, channelId());
        session.user = { id: r.userId };
        jar.values.set(STATE_COOKIE, f.state);
        jar.values.set(VERIFIER_COOKIE, f.verifier);
        const exchange = vi.spyOn(fake, "exchangeCode");
        const revokesBefore = callsOf("revoke");
        const { res } = await finish(f);
        const label = `${refusalName} / held by ${holderName}`;
        expect(landed(res), label).toEqual(LANDS(lands));
        const revoked = callsOf("revoke") - revokesBefore;
        if (heldToken === null) {
          expect(revoked, `${label}: nothing holds it, so it is revoked`).toBe(1);
          expect(await isDead(await minted(exchange)), `${label}: dead`).toBe(true);
        } else {
          expect(revoked, `${label}: a live connection holds it, so it is NOT revoked`).toBe(0);
          await expect(fake.accessToken(heldToken), `${label}: the holder's token still works`).resolves.toEqual(expect.any(String));
        }
        expect(await connectionCount(r.orgId), label).toBe(0);
        expect(await pendingRows(r.orgId), `${label}: pending row gone`).toEqual([]);
        exchange.mockRestore();
        checked++;
      }
    }
    expect(checked, "anti-vacuity: 2 refusals x 3 holders").toBe(6);
  });

  it("the grant's channels cannot be READ (YouTube did not answer): that is not 'no channel' and not a reason to revoke — on the main path (unavailable) and on a refusal that must look (scope_missing), held or not; the holder's token still works", async () => {
    const paths: [string, (state: string) => void, string][] = [
      ["the main path", () => {}, "unavailable"],
      ["a scope_missing refusal", (state) => fake.setGrantedScope("https://www.googleapis.com/auth/userinfo.email", state), "scope_missing"],
    ];
    // A holder connection on the grant's channel, with NO sub: only the channel list could have told the route it is in use.
    const holders: [string, boolean][] = [["its channel is live in another org", true], ["nothing holds it", false]];
    let checked = 0;
    for (const [pathName, shape, lands] of paths) {
      for (const [holderName, held] of holders) {
        const label = `${pathName} / ${holderName}`;
        const r = await rig();
        const f = await begin(r);
        const ch = channelId();
        fake.setChannels([{ id: ch, title: "Held FC" }], f.state);
        shape(f.state);
        const holder = held ? await liveConnection(await rig(), { channel: ch, sub: null }) : null;
        session.user = { id: r.userId };
        jar.values.set(STATE_COOKIE, f.state);
        jar.values.set(VERIFIER_COOKIE, f.verifier);
        const exchange = vi.spyOn(fake, "exchangeCode");
        fake.failNext("listMyChannels", "youtube_unavailable");
        const revokesBefore = callsOf("revoke");
        const { res } = await finish(f);
        expect(landed(res), label).toEqual(LANDS(lands));
        expect(callsOf("revoke") - revokesBefore, `${label}: a grant whose channels are unknown is not revoked`).toBe(0);
        expect(await isDead(await minted(exchange)), `${label}: the grant is still alive`).toBe(false);
        if (holder) await expect(fake.accessToken(holder.refreshToken), `${label}: the holder's token still works`).resolves.toEqual(expect.any(String));
        expect(await connectionCount(r.orgId), `${label}: nothing connected`).toBe(0);
        expect(await pendingRows(r.orgId), `${label}: the pending row (and its sealed token) is dropped`).toEqual([]);
        exchange.mockRestore();
        checked++;
      }
    }
    expect(checked, "anti-vacuity: 2 paths x 2 holders").toBe(4);

    // The positive pair: the same flow with the channels readable and nobody holding the grant IS revoked.
    const r = await rig();
    const f = await begin(r);
    fake.setChannels([], f.state);
    const revokesBefore = callsOf("revoke");
    expect(landed((await finish(f)).res)).toEqual(LANDS("no_channel"));
    expect(callsOf("revoke") - revokesBefore).toBe(1);
  });
});

// =====================================================================================================================================
describe.skipIf(!HAS_DB)("secrets stay out of every URL the routes produce", () => {
  it("no landing, and no start redirect, carries the code, the refresh token or the verifier — across every exit", async () => {
    type Exit = { name: string; lands: string; run: (r: Rig, f: Flow) => Promise<void> };
    const exits: Exit[] = [
      { name: "connected", lands: "connected", run: async (_r, f) => fake.setChannels([{ id: channelId(), title: "A FC" }], f.state) },
      { name: "pick", lands: "pick", run: async (_r, f) => fake.setChannels([{ id: channelId(), title: "A" }, { id: channelId(), title: "B" }], f.state) },
      { name: "no_channel", lands: "no_channel", run: async (_r, f) => fake.setChannels([], f.state) },
      { name: "scope_missing", lands: "scope_missing", run: async (_r, f) => fake.setGrantedScope("openid", f.state) },
      { name: "forbidden", lands: "forbidden", run: async (r) => { await sql`delete from org_members where org_id = ${r.orgId}`; } },
      { name: "other_org", lands: "other_org", run: async (_r, f) => {
        const ch = channelId();
        await liveConnection(await rig(), { channel: ch });
        fake.setChannels([{ id: ch, title: "Taken FC" }], f.state);
      } },
      { name: "expired (exchange refused)", lands: "expired", run: async () => fake.failNext("exchangeCode", "youtube_reconnect_needed", "invalidGrant") },
      { name: "not_configured (exchange)", lands: "not_configured", run: async () => fake.failNext("exchangeCode", "youtube_unavailable", "notConfigured") },
    ];
    let checked = 0;
    for (const e of exits) {
      const r = await rig();
      const f = await begin(r);
      const startLoc = f.startRes.headers.get("location")!;
      const exchange = vi.spyOn(fake, "exchangeCode");
      await e.run(r, f);
      session.user = { id: r.userId };
      jar.values.set(STATE_COOKIE, f.state);
      jar.values.set(VERIFIER_COOKIE, f.verifier);
      const { res, code } = await finish(f);
      expect(landed(res).youtube, e.name).toBe(e.lands);
      const secrets = [code, f.verifier];
      if (exchange.mock.results.length > 0) {
        try {
          secrets.push(await minted(exchange));
        } catch { /* the exchange was refused: no token exists */ }
      }
      for (const secret of secrets) {
        expect(secret.length, `${e.name}: a real secret`).toBeGreaterThan(8);
        expect(res.headers.get("location")!.includes(secret), `${e.name}: the landing carries no secret`).toBe(false);
        expect(startLoc.includes(secret), `${e.name}: nor does the start's redirect`).toBe(false);
      }
      expect(secrets.length, `${e.name}: at least the code and the verifier were checked`).toBeGreaterThanOrEqual(2);
      exchange.mockRestore();
      checked++;
    }
    expect(checked, "anti-vacuity: every exit was driven").toBe(exits.length);
  });
});

// =====================================================================================================================================
describe.skipIf(!HAS_DB)("GET /api/youtube/connect/fake-authorize — the hop CI uses in Google's place", () => {
  const REFUSED: [string, string | undefined, string | undefined, string | undefined][] = [
    ["live mode + ci", "live", "ci", "test"],
    ["live mode + local", "live", "local", "test"],
    ["fake + stg", "fake", "stg", "production"],
    ["fake + prod", "fake", "prod", "production"],
    ["fake + ENV_NAME unset", "fake", undefined, "production"],
    ["production with YOUTUBE_DRIVER unset (= live) + ci", undefined, "ci", "production"],
    ["a typo'd YOUTUBE_DRIVER + ci", "fakee", "ci", "test"],
  ];
  for (const [name, driver, envName, nodeEnv] of REFUSED) {
    it(`404: ${name} — a code is never minted`, async () => {
      const r = await rig();
      const f = await begin(r);   // started under the fake, so the state is known to it
      vi.stubEnv("YOUTUBE_DRIVER", driver);
      vi.stubEnv("ENV_NAME", envName);
      vi.stubEnv("NODE_ENV", nodeEnv);
      const minting = vi.spyOn(fake, "issueCode");
      const res = (await hop(f.state)).res;
      expect(res.status).toBe(404);
      expect(res.headers.get("location")).toBeNull();
      expect(minting).not.toHaveBeenCalled();
    });
  }

  it("in fake mode it 303s to the RECORDED redirect URI with the same state and a fresh code — and never to a redirect_uri in the query", async () => {
    const r = await rig();
    const f = await begin(r);
    const { res, url } = await hop(f.state, "&redirect_uri=https%3A%2F%2Fevil.example%2Fsteal&code_challenge=x");
    expect(res.status).toBe(303);
    const loc = new URL(url);
    expect(loc.origin + loc.pathname, "the URI the start recorded, not the query's").toBe(CALLBACK_URL);
    expect(loc.searchParams.get("state")).toBe(f.state);
    expect(loc.searchParams.get("code")?.length ?? 0).toBeGreaterThan(8);
    expect(url.includes("evil.example")).toBe(false);
    // The code works: the callback redeems it (PKCE verifier from the cookie).
    expect(landed(await CALLBACK(callbackReq(url))).youtube).toBe("connected");
  });

  it("404: the gate env says fake, but this process's driver is NOT the fake — a code is never minted (the driver check stands alone); with the fake back, the same state mints", async () => {
    const r = await rig();
    const f = await begin(r);
    setYoutubeDriverForTest(new GoogleYouTube());   // YOUTUBE_DRIVER=fake and ENV_NAME=ci are still set by beforeEach
    const minting = vi.spyOn(fake, "issueCode");
    const refused = (await hop(f.state)).res;
    expect(refused.status).toBe(404);
    expect(refused.headers.get("location")).toBeNull();
    expect(minting).not.toHaveBeenCalled();
    setYoutubeDriverForTest(fake);
    expect((await hop(f.state)).res.status).toBe(303);
    expect(minting).toHaveBeenCalledTimes(1);
  });

  it("an unknown or missing state is refused (404 / 400) and mints nothing", async () => {
    await rig();
    const minting = vi.spyOn(fake, "issueCode");
    expect((await hop("never-authorized")).res.status).toBe(404);
    const noState = await HOP(new Request("http://localhost/api/youtube/connect/fake-authorize"));
    expect(noState.status).toBe(400);
    expect(minting).not.toHaveBeenCalled();
  });
});

// =====================================================================================================================================
// INERT-SEAM GUARD (T8). The cases above run the real save too (the spy passes through), but each is about the callback's landing. These
// four are about what the save LEAVES: route -> real usecase -> database -> fake port, end to end, asserting the rows — the rows the
// Directory then lists and Go live (T10+) will read. A save that landed `connected` and wrote nothing would pass every landing check.
describe.skipIf(!HAS_DB)("the callback's save is the REAL one: what a landing leaves in the database", () => {
  /** The refresh token the nth exchange minted (one spy is shared: spying again on a spied method returns the same spy). */
  const mintedAt = async (spy: ReturnType<typeof vi.spyOn>, n: number): Promise<string> =>
    ((spy.mock.results[n]!.value as Promise<{ refreshToken: string }>).then((g) => g.refreshToken));
  const savedOf = async (n: number): Promise<{ connectionId: string; targetId: string }> => save.fn.mock.results[n]!.value as Promise<{ connectionId: string; targetId: string }>;
  const connRow = async (id: string) => (await sql<Record<string, unknown>[]>`select * from org_youtube_connections where id = ${id}`)[0]!;
  const targetRows = (orgId: string) =>
    sql<{ id: string; kind: string; label: string; youtube_connection_id: string; dest_fingerprint: string; watch_url: string | null; archived_at: Date | null }[]>`
      select id, kind, label, youtube_connection_id, dest_fingerprint, watch_url, archived_at from org_stream_targets where org_id = ${orgId} order by created_at, id`;
  const ownerCtx = (r: Rig) => ({ orgId: r.orgId, via: "session" as const, userId: r.userId, role: "owner" as const, keyId: null });

  it("(a) connected: the connection holds the start's choices and consent and the grant's token; its destination row is kind youtube, labelled with the channel's title, fingerprinted by the channel, with NO key of its own and NO watch link; the grant is not revoked; the Directory lists it", async () => {
    const r = await rig();
    const f = await begin(r, { privacy: "private", madeForKids: "1" });
    const ch = { id: channelId(), title: "Solo United" };
    fake.setChannels([ch], f.state);
    fake.setGoogleSub("sub-solo", f.state);
    const exchange = vi.spyOn(fake, "exchangeCode");
    const { res } = await finish(f);
    expect(landed(res)).toEqual(LANDS("connected"));

    const { connectionId, targetId } = await savedOf(0);
    expect(await connRow(connectionId)).toMatchObject({
      org_id: r.orgId, channel_id: ch.id, channel_title: "Solo United", google_sub: "sub-solo", granted_scope: YOUTUBE_SCOPE, default_privacy: "private",
      made_for_kids: true, consent_by: r.userId, consent_version: 1, status: "connected", created_by: r.userId, last_error_code: null,
    });
    expect(await openToken(sql, r.orgId, connectionId), "the stored token is the one the grant minted").toBe(await minted(exchange));
    const targets = await targetRows(r.orgId);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      id: targetId, kind: "youtube", label: "Solo United", youtube_connection_id: connectionId, dest_fingerprint: fingerprintYoutubeChannel(ch.id), watch_url: null, archived_at: null,
    });
    await expect(sql.begin((tx) => readTargetSecret(tx, r.orgId, targetId)), "no key of its own").rejects.toBeInstanceOf(ApiBackedTargetError);
    expect(callsOf("revoke"), "a connection was made: nothing to revoke").toBe(0);
    expect(await pendingRows(r.orgId)).toEqual([]);
    expect(await listStreamTargets(ownerCtx(r), r.orgId)).toMatchObject([
      { id: targetId, kind: "youtube", label: "Solo United", keyHint: null, inUse: null, youtube: { connectionId, channelTitle: "Solo United", privacy: "private", madeForKids: true, status: "connected" } },
    ]);
  });

  it("(b) other_org: the channel is live in another org -> the REAL save refused 409 YOUTUBE_OTHER_ORG, nothing was revoked (the holder's token still opens and still works at YouTube), the holder's connection and destination are byte-for-byte untouched, and this org has no connection, destination or pending grant", async () => {
    const holder = await rig();
    const fa = await begin(holder);
    const ch = { id: channelId(), title: "Held FC" };
    fake.setChannels([ch], fa.state);
    const exchangeA = vi.spyOn(fake, "exchangeCode");
    expect(landed((await finish(fa)).res)).toEqual(LANDS("connected"));
    const heldToken = await minted(exchangeA);
    const { connectionId: heldId } = await savedOf(0);
    const heldBefore = await connRow(heldId);
    const heldTargetsBefore = await targetRows(holder.orgId);

    const r = await rig();
    const fb = await begin(r);
    fake.setChannels([ch], fb.state);
    const { res } = await finish(fb);
    expect(landed(res)).toEqual(LANDS("other_org"));
    await expect(save.fn.mock.results[1]!.value, "the refusal is the usecase's own").rejects.toMatchObject({ status: 409, code: "YOUTUBE_OTHER_ORG", message: "This channel is connected to another organisation on Seazn" });
    expect(callsOf("revoke"), "revoking the grant would kill the holder's live connection").toBe(0);
    expect(await connRow(heldId)).toEqual(heldBefore);
    expect(await targetRows(holder.orgId)).toEqual(heldTargetsBefore);
    expect(await openToken(sql, holder.orgId, heldId)).toBe(heldToken);
    await expect(fake.accessToken(heldToken), "the holder's token works at YouTube").resolves.toEqual(expect.any(String));
    expect(await connectionCount(r.orgId)).toBe(0);
    expect(await targetRows(r.orgId)).toEqual([]);
    expect(await pendingRows(r.orgId), "the callback dropped the pending grant").toEqual([]);
  });

  it("(c) reconnect: a connection whose grant died is re-authorised -> the SAME connection and destination, the token replaced by the new grant's, connected again with its error cleared; the old token stays dead and the new one works", async () => {
    const r = await rig();
    const f1 = await begin(r);
    const ch = { id: channelId(), title: "Reconnect FC" };
    fake.setChannels([ch], f1.state);
    const exchange = vi.spyOn(fake, "exchangeCode");
    expect(landed((await finish(f1)).res)).toEqual(LANDS("connected"));
    const oldToken = await mintedAt(exchange, 0);
    const first = await savedOf(0);
    fake.killToken(oldToken);
    await sql`update org_youtube_connections set status = 'reconnect_needed', status_since = now() - interval '2 days', last_error_code = 'youtube_reconnect_needed' where id = ${first.connectionId}`;
    const before = await connRow(first.connectionId);

    const f2 = await begin(r, { connectionId: first.connectionId });
    fake.setChannels([ch], f2.state);
    expect(landed((await finish(f2)).res)).toEqual(LANDS("connected"));
    const newToken = await mintedAt(exchange, 1);
    expect(newToken).not.toBe(oldToken);
    expect(await savedOf(1)).toEqual(first);
    expect(await openToken(sql, r.orgId, first.connectionId), "the token is the NEW grant's").toBe(newToken);
    const after = await connRow(first.connectionId);
    expect(after).toMatchObject({ status: "connected", last_error_code: null });
    expect((after.status_since as Date).getTime()).toBeGreaterThan((before.status_since as Date).getTime());
    expect(await connectionCount(r.orgId)).toBe(1);
    expect(await targetRows(r.orgId)).toHaveLength(1);
    expect(await isDead(oldToken)).toBe(true);
    await expect(fake.accessToken(newToken)).resolves.toEqual(expect.any(String));
    expect(callsOf("revoke"), "a reconnect revokes nothing").toBe(0);
  });

  it("(d) a NEW connect of a channel already live in the SAME org returns the existing ids: one connection, one destination row, the token replaced, nothing revoked", async () => {
    const r = await rig();
    const f1 = await begin(r, { privacy: "public" });
    const ch = { id: channelId(), title: "Twice FC" };
    fake.setChannels([ch], f1.state);
    const exchange = vi.spyOn(fake, "exchangeCode");
    expect(landed((await finish(f1)).res)).toEqual(LANDS("connected"));
    const oldToken = await mintedAt(exchange, 0);
    const first = await savedOf(0);

    const f2 = await begin(r, { privacy: "private" });   // a fresh connect (no connectionId), a different choice
    fake.setChannels([ch], f2.state);
    expect(landed((await finish(f2)).res)).toEqual(LANDS("connected"));
    const newToken = await mintedAt(exchange, 1);
    expect(newToken).not.toBe(oldToken);
    expect(await savedOf(1), "the existing ids, not new ones").toEqual(first);
    expect(await connectionCount(r.orgId)).toBe(1);
    expect(await targetRows(r.orgId)).toHaveLength(1);
    expect(await openToken(sql, r.orgId, first.connectionId)).toBe(newToken);
    expect((await connRow(first.connectionId)).default_privacy, "the first choice stands; a connect does not silently change settings").toBe("public");
    expect(callsOf("revoke")).toBe(0);
    expect(await pendingRows(r.orgId)).toEqual([]);
  });
});
