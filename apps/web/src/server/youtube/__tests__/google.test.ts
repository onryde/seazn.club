// YouTube Connect T6: the live Google driver (google.ts), with `fetch` mocked at the boundary — no network, no credential.
//
// Expected values are typed here from Google's own pages (each block names its page) and from the spec, never read back from
// google.ts: the URLs, the request bodies, the error table. The fake (fake.ts) is the OTHER half of the contract: a few tests
// run the same scenario through both and compare what the caller would see (code + reason).
//
// Step 0 pages (read 2026-10-27; the report lists them in full):
//   developers.google.com/youtube/v3/live/docs/{liveBroadcasts,liveStreams}[/insert|bind|transition|delete|list]
//   developers.google.com/youtube/v3/docs/{videos/list,channels/list,errors}
//   developers.google.com/identity/protocols/oauth2/web-server  (offline access, refresh, revoke)
//   docs.cloud.google.com/docs/authentication/token-types        (tokeninfo)
import { inspect } from "node:util";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOGGER_OPTIONS } from "@/server/logger";
import { FakeYouTube, FAKE_YOUTUBE_METHODS } from "../fake";
import { GoogleYouTube, mapGoogleError } from "../google";
import { YOUTUBE_ERROR_CODES, YouTubeError, type YouTubePort } from "../port";

// ─── fixtures ──────────────────────────────────────────────────────────────────────────────────────────────────────────

// Distinct, recognisable stand-ins for every secret. None is a real credential; each is long enough to be found by a substring.
const AT = "ya29.ACCESS-TOKEN-MARKER-7f3a";
const RT = "1//0gREFRESH-TOKEN-MARKER-9c1d";
const CODE = "4/0AUTH-CODE-MARKER-5b2e";
const VERIFIER = "PKCE-VERIFIER-MARKER-0a8f-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CLIENT_ID = "1234-test.apps.googleusercontent.com";
const CLIENT_SECRET = "GOCSPX-CLIENT-SECRET-MARKER-4d6e";
const REDIRECT = "https://seazn.test/api/youtube/connect/callback";
const SECRETS = [AT, RT, CODE, VERIFIER, CLIENT_SECRET];
const YOUTUBE_SCOPE = "https://www.googleapis.com/auth/youtube";   // the spec's one scope, typed again on purpose

type Sent = { url: string; method: string; headers: Record<string, string>; body: string | undefined; init: RequestInit };
type Reply = Response | Error;

let sent: Sent[] = [];
let handler: (req: Sent) => Reply | Promise<Reply>;

const res = (status: number, body?: unknown, raw?: string): Response =>
  new Response(status === 204 ? null : raw ?? JSON.stringify(body ?? {}), { status, headers: { "content-type": "application/json" } });

/** Google's Data API error envelope. */
const apiError = (status: number, reason: string, message = "boom"): Response =>
  res(status, { error: { code: status, message, errors: [{ message, domain: "youtube.liveBroadcast", reason }] } });

/** Google's OAuth error envelope (the token, revoke and tokeninfo endpoints). */
const oauthError = (status: number, error: string, description = "Bad Request"): Response =>
  res(status, { error, error_description: description });

/** A plausible success for every endpoint the driver touches. */
const ok = (req: Sent): Reply => {
  const u = new URL(req.url);
  const form = new URLSearchParams(req.body ?? "");
  if (u.host === "oauth2.googleapis.com" && u.pathname === "/token") {
    return form.get("grant_type") === "refresh_token"
      ? res(200, { access_token: AT, expires_in: 3599, scope: YOUTUBE_SCOPE, token_type: "Bearer" })
      : res(200, { access_token: AT, refresh_token: RT, expires_in: 3599, scope: YOUTUBE_SCOPE, token_type: "Bearer" });
  }
  if (u.host === "oauth2.googleapis.com" && u.pathname === "/tokeninfo") return res(200, { sub: "1099", scope: YOUTUBE_SCOPE, exp: "1" });
  if (u.host === "oauth2.googleapis.com" && u.pathname === "/revoke") return res(200, {});
  if (u.pathname === "/youtube/v3/channels") return res(200, { items: [{ id: "UCchan", snippet: { title: "Chan" } }] });
  if (u.pathname === "/youtube/v3/videos") return res(200, { items: [{ id: "vid1" }] });
  if (u.pathname === "/youtube/v3/liveStreams") {
    return req.method === "DELETE"
      ? res(204)
      : res(200, { id: "strm1", cdn: { ingestionInfo: { ingestionAddress: "rtmp://a.rtmp.youtube.com/live2", streamName: "key-abcd-1234" } } });
  }
  if (u.pathname === "/youtube/v3/liveBroadcasts/bind") return res(200, { id: "bc1" });
  if (u.pathname === "/youtube/v3/liveBroadcasts/transition") return res(200, { id: "bc1", status: { lifeCycleStatus: "complete" } });
  if (u.pathname === "/youtube/v3/liveBroadcasts") {
    if (req.method === "DELETE") return res(204);
    if (req.method === "POST") return res(200, { id: "bc1" });
    return u.searchParams.has("id")
      ? res(200, { items: [{ id: "bc1", status: { lifeCycleStatus: "live" } }] })
      : res(200, { items: [] });
  }
  return res(404, { error: { code: 404, errors: [{ reason: "unexpectedTestUrl" }] } });
};

beforeEach(() => {
  sent = [];
  handler = ok;
  vi.stubEnv("GOOGLE_CLIENT_ID", CLIENT_ID);
  vi.stubEnv("GOOGLE_CLIENT_SECRET", CLIENT_SECRET);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const req: Sent = {
        url: String(input),
        method: init.method ?? "GET",
        headers: Object.fromEntries(new Headers(init.headers).entries()),
        body: typeof init.body === "string" ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : undefined,
        init,
      };
      sent.push(req);
      const r = await handler(req);
      if (r instanceof Error) throw r;
      return r;
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const driver = (): GoogleYouTube => new GoogleYouTube();
const rejection = (p: Promise<unknown>): Promise<unknown> => p.then(() => null, (e: unknown) => e);
const formOf = (r: Sent): URLSearchParams => new URLSearchParams(r.body ?? "");
const jsonOf = (r: Sent): Record<string, unknown> => JSON.parse(r.body ?? "null") as Record<string, unknown>;
const when = (re: RegExp, reply: (req: Sent) => Reply) => (prev: typeof handler): typeof handler => (req) => (re.test(req.url) ? reply(req) : prev(req));

describe("GoogleYouTube is a live YouTubePort", () => {
  it("mode is 'live' and the driver implements every method the port declares (the fake's list is the declaration)", () => {
    const g: YouTubePort = driver();
    expect(g.mode).toBe("live");
    let checked = 0;
    for (const m of FAKE_YOUTUBE_METHODS) {
      expect(typeof (g as unknown as Record<string, unknown>)[m], m).toBe("function");
      checked++;
    }
    expect(checked, "anti-vacuity: the declared methods").toBe(15);
  });
});

describe("authorizeUrl (developers.google.com/identity/protocols/oauth2/web-server)", () => {
  it("response_type=code, access_type=offline, prompt=consent, scope is EXACTLY the youtube scope, PKCE S256, and no request is made", () => {
    const url = new URL(driver().authorizeUrl({ state: "st-1", codeChallenge: "chal-1", redirectUri: REDIRECT }));
    expect(`${url.origin}${url.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const p = url.searchParams;
    expect(p.get("response_type")).toBe("code");
    expect(p.get("access_type")).toBe("offline");
    expect(p.get("prompt")).toBe("consent");
    expect(p.get("scope")).toBe(YOUTUBE_SCOPE);
    expect(p.get("code_challenge")).toBe("chal-1");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("state")).toBe("st-1");
    expect(p.get("redirect_uri")).toBe(REDIRECT);
    expect(p.get("client_id")).toBe(CLIENT_ID);
    // Not asked for: widening the grant with whatever else the user once granted (sign-in scopes) would break "exactly".
    expect(p.has("include_granted_scopes")).toBe(false);
    expect(url.toString(), "the client secret is never in a URL").not.toContain(CLIENT_SECRET);
    expect(sent, "building a URL is not a request").toHaveLength(0);
  });

  it("without the Google client credentials it refuses by code (unavailable / notConfigured), and with them it does not", () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "");
    const err = (() => {
      try {
        driver().authorizeUrl({ state: "s", codeChallenge: "c", redirectUri: REDIRECT });
        return null;
      } catch (e) {
        return e;
      }
    })() as YouTubeError;
    expect(err).toBeInstanceOf(YouTubeError);
    expect([err.code, err.reason]).toEqual(["youtube_unavailable", "notConfigured"]);
    vi.stubEnv("GOOGLE_CLIENT_ID", CLIENT_ID);
    expect(() => driver().authorizeUrl({ state: "s", codeChallenge: "c", redirectUri: REDIRECT })).not.toThrow();
  });
});

describe("exchangeCode: the token call, then tokeninfo for the subject (F12)", () => {
  it("POSTs the code, verifier, redirect URI and client credentials as a FORM BODY to the token endpoint; returns the refresh token, scope and sub", async () => {
    const out = await driver().exchangeCode({ code: CODE, codeVerifier: VERIFIER, redirectUri: REDIRECT });
    expect(out).toEqual({ refreshToken: RT, scope: YOUTUBE_SCOPE, googleSub: "1099" });
    expect(sent.map((r) => `${r.method} ${r.url}`)).toEqual([
      "POST https://oauth2.googleapis.com/token",
      "POST https://oauth2.googleapis.com/tokeninfo",
    ]);
    const token = sent[0]!;
    expect(token.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    const f = formOf(token);
    expect(Object.fromEntries(f.entries())).toEqual({
      grant_type: "authorization_code", code: CODE, code_verifier: VERIFIER, redirect_uri: REDIRECT, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
    });
    // tokeninfo: the ACCESS token, in the body, never the query string (Google's page shows a GET with the token in the URL).
    const info = sent[1]!;
    expect(info.url, "no query string at all").not.toContain("?");
    expect(formOf(info).get("access_token")).toBe(AT);
  });

  it("the subject is null when tokeninfo omits it (a youtube-only token may carry no `sub`), or fails, or answers a non-string; the connect still succeeds", async () => {
    const cases: [string, (req: Sent) => Reply][] = [
      ["no sub field", () => res(200, { scope: YOUTUBE_SCOPE, exp: "1" })],
      ["empty sub", () => res(200, { sub: "" })],
      ["numeric sub", () => res(200, { sub: 1099 })],
      ["tokeninfo 400", () => oauthError(400, "invalid_token")],
      ["tokeninfo 500", () => res(500, {}, "<html>down</html>")],
      ["tokeninfo network error", () => new Error("connect ECONNRESET")],
      ["tokeninfo body is not JSON", () => res(200, undefined, "not json")],
    ];
    let checked = 0;
    for (const [name, reply] of cases) {
      sent = [];
      handler = when(/\/tokeninfo$/, reply)(ok);
      const out = await driver().exchangeCode({ code: CODE, codeVerifier: VERIFIER, redirectUri: REDIRECT });
      expect(out, name).toEqual({ refreshToken: RT, scope: YOUTUBE_SCOPE, googleSub: null });
      expect(sent, `${name}: both calls were made`).toHaveLength(2);
      checked++;
    }
    expect(checked).toBe(cases.length);
  });

  it("an invalid_grant from the token endpoint (bad, replayed or expired code) is youtube_reconnect_needed / invalidGrant, and tokeninfo is not asked", async () => {
    handler = () => oauthError(400, "invalid_grant", "Bad Request");
    const err = (await rejection(driver().exchangeCode({ code: CODE, codeVerifier: VERIFIER, redirectUri: REDIRECT }))) as YouTubeError;
    expect(err).toBeInstanceOf(YouTubeError);
    expect([err.code, err.reason]).toEqual(["youtube_reconnect_needed", "invalidGrant"]);
    expect(sent).toHaveLength(1);
  });

  it("a grant that comes back with no refresh token is refused (prompt=consent always yields one): reconnect_needed / noRefreshToken", async () => {
    handler = when(/\/token$/, () => res(200, { access_token: AT, scope: YOUTUBE_SCOPE }))(ok);
    const err = (await rejection(driver().exchangeCode({ code: CODE, codeVerifier: VERIFIER, redirectUri: REDIRECT }))) as YouTubeError;
    expect([err.code, err.reason]).toEqual(["youtube_reconnect_needed", "noRefreshToken"]);
  });

  it("a response with no scope field reports scope '' (the callback then refuses it), not undefined", async () => {
    handler = when(/\/token$/, () => res(200, { access_token: AT, refresh_token: RT }))(ok);
    expect((await driver().exchangeCode({ code: CODE, codeVerifier: VERIFIER, redirectUri: REDIRECT })).scope).toBe("");
  });
});

describe("accessToken: the refresh call", () => {
  it("POSTs grant_type=refresh_token with the refresh token and the client credentials as a form body; returns the access token", async () => {
    expect(await driver().accessToken(RT)).toBe(AT);
    expect(sent).toHaveLength(1);
    expect(`${sent[0]!.method} ${sent[0]!.url}`).toBe("POST https://oauth2.googleapis.com/token");
    expect(Object.fromEntries(formOf(sent[0]!).entries())).toEqual({
      grant_type: "refresh_token", refresh_token: RT, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
    });
  });

  it("invalid_grant is reconnect_needed; a 401 invalid_client is NOT (a rotated client secret is Seazn's fault, not the club's: reconnecting cannot help)", async () => {
    handler = () => oauthError(400, "invalid_grant", "Token has been expired or revoked.");
    const a = (await rejection(driver().accessToken(RT))) as YouTubeError;
    expect([a.code, a.reason]).toEqual(["youtube_reconnect_needed", "invalidGrant"]);
    handler = () => oauthError(401, "invalid_client", "The OAuth client was not found.");
    const b = (await rejection(driver().accessToken(RT))) as YouTubeError;
    expect([b.code, b.reason]).toEqual(["youtube_unavailable", "invalidClient"]);
  });

  it("a 200 with no access token is youtube_unavailable / malformedResponse, never an undefined token handed on", async () => {
    handler = () => res(200, { expires_in: 3599 });
    const err = (await rejection(driver().accessToken(RT))) as YouTubeError;
    expect([err.code, err.reason]).toEqual(["youtube_unavailable", "malformedResponse"]);
  });
});

describe("Data API request shapes (developers.google.com/youtube/v3/…)", () => {
  it("listMyChannels: GET channels?part=snippet&mine=true; maps id and title; an account with no channel (no `items` at all) is []", async () => {
    expect(await driver().listMyChannels(AT)).toEqual([{ id: "UCchan", title: "Chan" }]);
    const u = new URL(sent[0]!.url);
    expect([sent[0]!.method, u.origin + u.pathname]).toEqual(["GET", "https://www.googleapis.com/youtube/v3/channels"]);
    expect(u.searchParams.get("part")).toBe("snippet");
    expect(u.searchParams.get("mine")).toBe("true");
    // Google omits `items` entirely when the list is empty.
    handler = () => res(200, { kind: "youtube#channelListResponse", pageInfo: { totalResults: 0, resultsPerPage: 5 } });
    expect(await driver().listMyChannels(AT)).toEqual([]);
  });

  it("liveEnabled: a cheap liveBroadcasts.list(mine); success = enabled, liveStreamingNotEnabled = not_enabled, livePermissionBlocked = blocked", async () => {
    expect(await driver().liveEnabled(AT)).toBe("enabled");
    const u = new URL(sent[0]!.url);
    expect([sent[0]!.method, u.pathname]).toEqual(["GET", "/youtube/v3/liveBroadcasts"]);
    expect(u.searchParams.get("mine")).toBe("true");
    expect(u.searchParams.get("part")).toBe("id");
    handler = () => apiError(403, "liveStreamingNotEnabled");
    expect(await driver().liveEnabled(AT)).toBe("not_enabled");
    handler = () => apiError(403, "livePermissionBlocked");
    expect(await driver().liveEnabled(AT)).toBe("blocked");
  });

  it("liveEnabled answers only for the two eligibility refusals: a dead token or an outage is thrown, not read as an answer", async () => {
    handler = () => apiError(401, "authError");
    expect(((await rejection(driver().liveEnabled(AT))) as YouTubeError).code).toBe("youtube_reconnect_needed");
    handler = () => res(503, {}, "unavailable");
    expect(((await rejection(driver().liveEnabled(AT))) as YouTubeError).code).toBe("youtube_unavailable");
  });

  it("insertStream: part=snippet,cdn,contentDetails; cdn.ingestionType 'rtmp', isReusable true; returns ingestionAddress + streamName as {url, streamKey}", async () => {
    const out = await driver().insertStream(AT, { title: "Seazn · Court 1" });
    expect(out).toEqual({ streamId: "strm1", ingest: { url: "rtmp://a.rtmp.youtube.com/live2", streamKey: "key-abcd-1234" } });
    const r = sent[0]!;
    const u = new URL(r.url);
    expect([r.method, u.origin + u.pathname]).toEqual(["POST", "https://www.googleapis.com/youtube/v3/liveStreams"]);
    expect(u.searchParams.get("part")).toBe("snippet,cdn,contentDetails");
    expect(r.headers["content-type"]).toBe("application/json");
    const b = jsonOf(r) as { snippet: { title: string }; cdn: Record<string, string>; contentDetails: { isReusable: boolean } };
    expect(b.snippet.title).toBe("Seazn · Court 1");
    expect(b.cdn.ingestionType).toBe("rtmp");
    // liveStreams.insert REQUIRES cdn.frameRate and cdn.resolution; "variable" lets YouTube detect them (and must be set together).
    expect(b.cdn.frameRate).toBe("variable");
    expect(b.cdn.resolution).toBe("variable");
    expect(b.contentDetails.isReusable).toBe(true);
  });

  it("insertStream: a response with no ingestion info is youtube_unavailable / malformedResponse (a stream without a key is useless, and nothing is invented)", async () => {
    handler = () => res(200, { id: "strm1", cdn: {} });
    const err = (await rejection(driver().insertStream(AT, { title: "k" }))) as YouTubeError;
    expect([err.code, err.reason]).toEqual(["youtube_unavailable", "malformedResponse"]);
  });

  it("insertBroadcast body: autoStart true, autoStop FALSE, monitor stream FALSE; privacy and made-for-kids exactly as given; part=snippet,status,contentDetails", async () => {
    const when0 = new Date("2026-11-03T14:30:00.000Z");
    // Every privacy, and BOTH made-for-kids values, so no constant can stand in for the argument.
    let checked = 0;
    for (const privacy of ["unlisted", "public", "private"] as const) {
      for (const madeForKids of [false, true]) {
        sent = [];
        const out = await driver().insertBroadcast(AT, { title: "A v B", description: "Round 1", scheduledStart: when0, privacy, madeForKids });
        expect(out).toEqual({ broadcastId: "bc1" });
        const r = sent[0]!;
        const u = new URL(r.url);
        expect([r.method, u.origin + u.pathname]).toEqual(["POST", "https://www.googleapis.com/youtube/v3/liveBroadcasts"]);
        expect(u.searchParams.get("part")).toBe("snippet,status,contentDetails");
        expect(jsonOf(r)).toEqual({
          snippet: { title: "A v B", description: "Round 1", scheduledStartTime: "2026-11-03T14:30:00.000Z" },
          status: { privacyStatus: privacy, selfDeclaredMadeForKids: madeForKids },
          contentDetails: { enableAutoStart: true, enableAutoStop: false, monitorStream: { enableMonitorStream: false } },
        });
        checked++;
      }
    }
    expect(checked, "3 privacies x 2 kids flags").toBe(6);
  });

  it("insertBroadcast refuses a title YouTube would refuse BEFORE calling Google: empty, blank, over 100 characters, `<` or `>` (the fake's rule, same code and reason)", async () => {
    const args = { description: "", scheduledStart: new Date("2026-11-03T14:30:00Z"), privacy: "unlisted" as const, madeForKids: false };
    const bad: [string, string][] = [
      ["empty", ""], ["blank", "   "], ["101 characters", "a".repeat(101)], ["angle open", "A <b> B"], ["angle close", "A > B"],
      ["101 code points that are 2 UTF-16 units each", "😀".repeat(101)],
    ];
    let checked = 0;
    for (const [name, title] of bad) {
      const err = (await rejection(driver().insertBroadcast(AT, { ...args, title }))) as YouTubeError;
      expect([name, err.code, err.reason]).toEqual([name, "youtube_unavailable", "invalidTitle"]);
      checked++;
    }
    expect(sent, "none of them reached Google").toHaveLength(0);
    expect(checked).toBe(bad.length);
    // The positive pair: exactly 100 characters (and 100 emoji) pass and ARE sent.
    for (const title of ["a".repeat(100), "😀".repeat(100)]) await driver().insertBroadcast(AT, { ...args, title });
    expect(sent).toHaveLength(2);
  });

  it("the title rule is the fake's: the same 8 titles are refused or accepted alike by FakeYouTube and by this driver", async () => {
    const titles = ["", "   ", "a".repeat(100), "a".repeat(101), "x<y", "x>y", "😀".repeat(100), "😀".repeat(101)];
    const args = { description: "", scheduledStart: new Date("2026-11-03T14:30:00Z"), privacy: "unlisted" as const, madeForKids: false };
    const fake = new FakeYouTube();
    const fakeAt = await fake.accessToken("1//parity");
    let checked = 0;
    for (const title of titles) {
      const f = await rejection(fake.insertBroadcast(fakeAt, { ...args, title }));
      const g = await rejection(driver().insertBroadcast(AT, { ...args, title }));
      expect(!!g, `refused alike: ${JSON.stringify(title.slice(0, 8))}`).toBe(!!f);
      if (f) expect([(g as YouTubeError).code, (g as YouTubeError).reason]).toEqual([(f as YouTubeError).code, (f as YouTubeError).reason]);
      checked++;
    }
    expect(checked).toBe(titles.length);
    expect(sent.length, "exactly the accepted titles were sent (2 of 8)").toBe(2);
  });

  it("bind: POST liveBroadcasts/bind?id=<broadcast>&streamId=<stream>&part=id; another channel's broadcast or stream (404) is youtube_not_found", async () => {
    await driver().bind(AT, "bc1", "strm1");
    const u = new URL(sent[0]!.url);
    expect([sent[0]!.method, u.origin + u.pathname]).toEqual(["POST", "https://www.googleapis.com/youtube/v3/liveBroadcasts/bind"]);
    expect(u.searchParams.get("id")).toBe("bc1");
    expect(u.searchParams.get("streamId")).toBe("strm1");
    expect(u.searchParams.get("part")).toBe("id");
    for (const reason of ["liveBroadcastNotFound", "liveStreamNotFound"]) {
      handler = () => apiError(404, reason);
      const err = (await rejection(driver().bind(AT, "bc1", "strm1"))) as YouTubeError;
      expect([err.code, err.reason]).toEqual(["youtube_not_found", reason]);
    }
  });

  it("broadcastLife: GET liveBroadcasts?part=status,snippet&id=…; reads status.lifeCycleStatus; no item at all is 'absent'", async () => {
    // Google's lifeCycleStatus values: created, ready, testStarting, testing, liveStarting, live, complete, revoked.
    const rows: [string, string][] = [
      ["created", "created"], ["ready", "ready"], ["testStarting", "testing"], ["testing", "testing"],
      ["liveStarting", "live"], ["live", "live"], ["complete", "complete"], ["revoked", "revoked"],
    ];
    let checked = 0;
    for (const [google, want] of rows) {
      sent = [];
      handler = () => res(200, { items: [{ id: "bc1", status: { lifeCycleStatus: google } }] });
      expect((await driver().broadcastLife(AT, "bc1")).life, google).toBe(want);
      const u = new URL(sent[0]!.url);
      expect([sent[0]!.method, u.pathname, u.searchParams.get("part"), u.searchParams.get("id")]).toEqual(["GET", "/youtube/v3/liveBroadcasts", "status,snippet", "bc1"]);
      checked++;
    }
    expect(checked).toBe(rows.length);
    handler = () => res(200, { items: [] });
    expect((await driver().broadcastLife(AT, "bc1")).life, "empty items").toBe("absent");
    handler = () => res(200, { kind: "youtube#liveBroadcastListResponse" });
    expect((await driver().broadcastLife(AT, "bc1")).life, "no items key").toBe("absent");
  });

  it("broadcastLife: a status Google never documented is refused (youtube_unavailable / unknownLifeCycleStatus), not guessed", async () => {
    for (const item of [{ id: "bc1", status: { lifeCycleStatus: "mystery" } }, { id: "bc1" }, { id: "bc1", status: {} }]) {
      handler = () => res(200, { items: [item] });
      const err = (await rejection(driver().broadcastLife(AT, "bc1"))) as YouTubeError;
      expect([err.code, err.reason]).toEqual(["youtube_unavailable", "unknownLifeCycleStatus"]);
    }
  });

  it("complete: POST liveBroadcasts/transition?broadcastStatus=complete&id=…&part=status", async () => {
    await driver().complete(AT, "bc1");
    const u = new URL(sent[0]!.url);
    expect([sent[0]!.method, u.origin + u.pathname]).toEqual(["POST", "https://www.googleapis.com/youtube/v3/liveBroadcasts/transition"]);
    expect(u.searchParams.get("broadcastStatus")).toBe("complete");
    expect(u.searchParams.get("id")).toBe("bc1");
    expect(u.searchParams.get("part")).toBe("status");
    expect(sent[0]!.body, "transition takes no body").toBeUndefined();
  });

  it("complete: a 'redundantTransition' answer (already complete) resolves; every other 403 does not; an unknown broadcast is not_found", async () => {
    handler = () => apiError(403, "redundantTransition");
    await expect(driver().complete(AT, "bc1")).resolves.toBeUndefined();
    // The negative's positive pair: the neighbouring refusals are thrown.
    const neighbours: [string, string][] = [
      ["invalidTransition", "youtube_unavailable"], ["errorStreamInactive", "youtube_unavailable"],
      ["concurrentBroadcastsExceedLimit", "youtube_limit_reached"], ["forbidden", "youtube_unavailable"],
    ];
    let checked = 0;
    for (const [reason, code] of neighbours) {
      handler = () => apiError(403, reason);
      const err = (await rejection(driver().complete(AT, "bc1"))) as YouTubeError;
      expect([reason, err.code, err.reason]).toEqual([reason, code, reason]);
      checked++;
    }
    expect(checked).toBe(neighbours.length);
    handler = () => apiError(404, "liveBroadcastNotFound");
    expect(((await rejection(driver().complete(AT, "bc1"))) as YouTubeError).code).toBe("youtube_not_found");
  });

  it("deleteBroadcast / deleteStream: DELETE …?id=…; an already-absent resource (404) resolves, and so does a second call; a refusal to delete is thrown", async () => {
    await driver().deleteBroadcast(AT, "bc1");
    await driver().deleteStream(AT, "strm1");
    const [a, b] = sent.map((r) => ({ method: r.method, u: new URL(r.url) }));
    expect([a!.method, a!.u.origin + a!.u.pathname, a!.u.searchParams.get("id")]).toEqual(["DELETE", "https://www.googleapis.com/youtube/v3/liveBroadcasts", "bc1"]);
    expect([b!.method, b!.u.origin + b!.u.pathname, b!.u.searchParams.get("id")]).toEqual(["DELETE", "https://www.googleapis.com/youtube/v3/liveStreams", "strm1"]);

    handler = (req) => apiError(404, req.url.includes("liveStreams") ? "liveStreamNotFound" : "liveBroadcastNotFound");
    await expect(driver().deleteBroadcast(AT, "bc1")).resolves.toBeUndefined();
    await expect(driver().deleteBroadcast(AT, "bc1"), "second call").resolves.toBeUndefined();
    await expect(driver().deleteStream(AT, "strm1")).resolves.toBeUndefined();

    // Only the NOT-FOUND is forgiven. A delete Google refuses, or cannot do, is an error the caller retries.
    handler = () => apiError(403, "liveBroadcastDeletionNotAllowed");
    expect(((await rejection(driver().deleteBroadcast(AT, "bc1"))) as YouTubeError).code).toBe("youtube_unavailable");
    handler = () => apiError(403, "liveStreamDeletionNotAllowed");
    expect(((await rejection(driver().deleteStream(AT, "strm1"))) as YouTubeError).code).toBe("youtube_unavailable");
    handler = () => apiError(401, "authError");
    expect(((await rejection(driver().deleteBroadcast(AT, "bc1"))) as YouTubeError).code).toBe("youtube_reconnect_needed");
    // A 404 whose reason is not "this resource is gone" is not forgiven (a wrong URL would otherwise read as a clean delete).
    handler = () => apiError(404, "somethingNew");
    expect(((await rejection(driver().deleteBroadcast(AT, "bc1"))) as YouTubeError).code).toBe("youtube_unavailable");
  });

  // liveStreams.list (developers.google.com/youtube/v3/live/docs/liveStreams/list): `part` (snippet), `mine=true`, `maxResults` 0-50
  // (default 5), `pageToken`; the response pages with `nextPageToken`; `snippet` carries `channelId` and `title`. The `cdn` part is where
  // `ingestionInfo.streamName` - the stream KEY - lives, so the disconnect's sweep must never ask for it.
  it("listStreams: GET liveStreams?part=snippet&mine=true&maxResults=50 - never the `cdn` part (the stream key) - mapped to id, title and channel id, paged by nextPageToken until Google stops sending one", async () => {
    const pages: Record<string, unknown> = {
      first: { nextPageToken: "PAGE-2", items: [{ id: "s1", snippet: { channelId: "UCchan", title: "Seazn stream key" } }, { id: "s2", snippet: { channelId: "UCchan", title: "TestYouTube" } }] },
      "PAGE-2": { items: [{ id: "s3", snippet: { channelId: "UCchan", title: "Seazn Club · stream key 2" } }] },
    };
    handler = (req) => res(200, pages[new URL(req.url).searchParams.get("pageToken") ?? "first"]);
    expect(await driver().listStreams(AT)).toEqual([
      { id: "s1", title: "Seazn stream key", channelId: "UCchan" },
      { id: "s2", title: "TestYouTube", channelId: "UCchan" },
      { id: "s3", title: "Seazn Club · stream key 2", channelId: "UCchan" },
    ]);
    expect(sent, "two pages, two requests").toHaveLength(2);
    let checked = 0;
    for (const [i, r] of sent.entries()) {
      const u = new URL(r.url);
      expect([r.method, u.origin + u.pathname]).toEqual(["GET", "https://www.googleapis.com/youtube/v3/liveStreams"]);
      expect(u.searchParams.get("part"), "snippet ONLY: the cdn part carries the stream key").toBe("snippet");
      expect(u.searchParams.get("mine")).toBe("true");
      expect(u.searchParams.get("maxResults"), "Google's page maximum").toBe("50");
      expect(u.searchParams.get("pageToken")).toBe(i === 0 ? null : "PAGE-2");
      expect(r.body, "a list takes no body").toBeUndefined();
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("listStreams: an empty channel (no `items` at all) is []; a stream with no snippet has an empty title and no channel; a key Google sends anyway never reaches the answer", async () => {
    handler = () => res(200, { kind: "youtube#liveStreamListResponse", pageInfo: { totalResults: 0, resultsPerPage: 50 } });
    expect(await driver().listStreams(AT)).toEqual([]);
    handler = () => res(200, {
      items: [
        { id: "bare" },
        { id: "keyed", snippet: { channelId: "UCchan", title: "k" }, cdn: { ingestionInfo: { ingestionAddress: "rtmp://a.rtmp.youtube.com/live2", streamName: "LEAKED-KEY-1234" } } },
        { snippet: { title: "no id" } },
      ],
    });
    const out = await driver().listStreams(AT);
    expect(out).toEqual([{ id: "bare", title: "", channelId: null }, { id: "keyed", title: "k", channelId: "UCchan" }]);
    expect(JSON.stringify(out), "the answer is ids and titles: never a key, never an ingest URL").not.toMatch(/LEAKED-KEY|rtmp:/);
  });

  it("listStreams: a refusal is thrown as its code; a page token Google repeats, and more pages than the cap, are refused rather than read as a whole list (the caller would delete from it)", async () => {
    handler = () => apiError(401, "authError");
    expect(((await rejection(driver().listStreams(AT))) as YouTubeError).code).toBe("youtube_reconnect_needed");
    handler = () => res(503, {}, "unavailable");
    expect(((await rejection(driver().listStreams(AT))) as YouTubeError).code).toBe("youtube_unavailable");

    // the same token again would loop forever
    sent = [];
    handler = () => res(200, { nextPageToken: "SAME", items: [{ id: "s1", snippet: { title: "t" } }] });
    const loop = (await rejection(driver().listStreams(AT))) as YouTubeError;
    expect([loop.code, loop.reason]).toEqual(["youtube_unavailable", "malformedResponse"]);
    expect(sent, "the first page, then the page it named, which named itself again").toHaveLength(2);

    // every page names a new one: the driver stops at its cap (10 pages = 500 streams) and refuses
    sent = [];
    let n = 0;
    handler = () => res(200, { nextPageToken: `P${++n}`, items: [] });
    const capped = (await rejection(driver().listStreams(AT))) as YouTubeError;
    expect([capped.code, capped.reason]).toEqual(["youtube_unavailable", "tooManyPages"]);
    expect(sent, "the cap: 10 requests").toHaveLength(10);
    // the positive pair: the 10th page ending the list is an answer
    sent = [];
    n = 0;
    handler = () => res(200, ++n < 10 ? { nextPageToken: `P${n}`, items: [{ id: `s${n}`, snippet: { title: "t" } }] } : { items: [{ id: "last", snippet: { title: "t" } }] });
    expect((await driver().listStreams(AT)).length, "nine pages of one, then the last").toBe(10);
    expect(sent).toHaveLength(10);
  });

  it("existingVideos: GET videos?part=id&id=a,b,c; answers only ids it asked about; ids Google omits (deleted) are absent from the set", async () => {
    handler = () => res(200, { items: [{ id: "aaa" }, { id: "ccc" }, { id: "not-asked-for" }] });
    const out = await driver().existingVideos(AT, ["aaa", "bbb", "ccc"]);
    expect([...out.keys()].sort()).toEqual(["aaa", "ccc"]);
    const u = new URL(sent[0]!.url);
    expect([sent[0]!.method, u.origin + u.pathname]).toEqual(["GET", "https://www.googleapis.com/youtube/v3/videos"]);
    expect(u.searchParams.get("part"), "the same ONE call, with the status part added").toBe("id,status");
    expect(u.searchParams.get("id")).toBe("aaa,bbb,ccc");
    handler = () => res(200, { kind: "youtube#videoListResponse" });
    expect((await driver().existingVideos(AT, ["aaa"])).size, "no items key").toBe(0);
  });

  it("existingVideos answers each present id with YouTube's OWN status.madeForKids: a boolean is an answer, anything else is null (it did not say) - in the SAME one call", async () => {
    handler = () => res(200, { items: [
      { id: "aaa", status: { madeForKids: true } }, { id: "bbb", status: { madeForKids: false } }, { id: "ccc", status: {} },
      { id: "ddd", status: { madeForKids: "true" } }, { id: "eee" }, { id: "fff", status: null },
    ] });
    const out = await driver().existingVideos(AT, ["aaa", "bbb", "ccc", "ddd", "eee", "fff", "ggg"]);
    expect(sent, "still one call: the status is one more part of it, not a second request").toHaveLength(1);
    expect([...out].map(([id, v]) => [id, v.madeForKids]), "true and false are answers; absent, empty, a string and null are not").toEqual([
      ["aaa", true], ["bbb", false], ["ccc", null], ["ddd", null], ["eee", null], ["fff", null],
    ]);
    expect(out.has("ggg"), "an id Google omits is absent, not 'not for kids'").toBe(false);
  });

  it("existingVideos refuses > 50 ids WITHOUT calling; exactly 50 is one call; none is an empty set and no call", async () => {
    const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `v${String(i).padStart(10, "0")}`);
    await expect(driver().existingVideos(AT, ids(51))).rejects.toBeInstanceOf(RangeError);
    expect(sent, "51 ids: not called").toHaveLength(0);
    await driver().existingVideos(AT, ids(50));
    expect(sent, "50 ids: one call").toHaveLength(1);
    sent = [];
    expect((await driver().existingVideos(AT, [])).size).toBe(0);
    expect(sent, "no ids: no call (Google answers an empty id with a 400)").toHaveLength(0);
  });
});

// D15 (youtube_broadcasts.actual_start_at / actual_end_at): liveBroadcasts `snippet.actualStartTime` is set once the broadcast is
// live and `actualEndTime` once it is complete, both ISO 8601 (https://developers.google.com/youtube/v3/live/docs/liveBroadcasts),
// so `broadcastLife` asks for `snippet` as well and reads them. Wire strings are typed here from that page.
describe("broadcastLife reports the actual start and end (B2 fix I4)", () => {
  const item = (lifeCycleStatus: string, snippet?: Record<string, unknown>, madeForKids?: boolean) =>
    ({ id: "bc1", status: { lifeCycleStatus, ...(madeForKids === undefined ? {} : { madeForKids }) }, ...(snippet ? { snippet } : {}) });

  it("reads snippet.actualStartTime and actualEndTime as instants: live has a start and no end; complete has both; created, ready and revoked have neither", async () => {
    const rows: [string, ReturnType<typeof item>, { life: string; start: string | null; end: string | null }][] = [
      ["created", item("created", { title: "t" }), { life: "created", start: null, end: null }],
      ["ready", item("ready", { title: "t", scheduledStartTime: "2026-10-27T12:00:00.000Z" }), { life: "ready", start: null, end: null }],
      ["testing", item("testing", { title: "t" }), { life: "testing", start: null, end: null }],
      ["live", item("live", { actualStartTime: "2026-10-27T12:05:00.000Z" }), { life: "live", start: "2026-10-27T12:05:00.000Z", end: null }],
      ["liveStarting", item("liveStarting", { actualStartTime: "2026-10-27T12:05:00Z" }), { life: "live", start: "2026-10-27T12:05:00.000Z", end: null }],
      ["complete", item("complete", { actualStartTime: "2026-10-27T12:05:00.000Z", actualEndTime: "2026-10-27T12:50:30.250Z" }), { life: "complete", start: "2026-10-27T12:05:00.000Z", end: "2026-10-27T12:50:30.250Z" }],
      ["revoked, never live", item("revoked", {}), { life: "revoked", start: null, end: null }],
      ["no snippet at all", item("live"), { life: "live", start: null, end: null }],
    ];
    let checked = 0;
    for (const [name, wire, want] of rows) {
      handler = () => res(200, { items: [wire] });
      const got = await driver().broadcastLife(AT, "bc1");
      expect([name, got.life, got.actualStartAt?.toISOString() ?? null, got.actualEndAt?.toISOString() ?? null]).toEqual([name, want.life, want.start, want.end]);
      checked++;
    }
    expect(checked, "anti-vacuity: every row read").toBe(rows.length);
    handler = () => res(200, { items: [] });
    expect(await driver().broadcastLife(AT, "bc1"), "absent: no instants").toEqual({ life: "absent", actualStartAt: null, actualEndAt: null, madeForKids: null });
  });

  it("an instant Google sends in a shape it should not (a bad string, a number, null, an empty string) is NULL, and the life is still read — the end step must not stop on it", async () => {
    const bad: unknown[] = ["not-a-date", "", 1_798_000_000_000, null, { iso: "2026-10-27T12:05:00Z" }, "2026-13-45T99:99:99Z", "yesterday"];
    let checked = 0;
    for (const v of bad) {
      handler = () => res(200, { items: [item("complete", { actualStartTime: v, actualEndTime: v })] });
      const got = await driver().broadcastLife(AT, "bc1");
      expect([JSON.stringify(v), got.life, got.actualStartAt, got.actualEndAt]).toEqual([JSON.stringify(v), "complete", null, null]);
      checked++;
    }
    expect(checked).toBe(bad.length);
    // the positive pair: a good instant beside a bad one is kept, so the null above is the parse and not a blanket drop
    handler = () => res(200, { items: [item("complete", { actualStartTime: "2026-10-27T12:05:00.000Z", actualEndTime: "garbage" })] });
    const half = await driver().broadcastLife(AT, "bc1");
    expect([half.actualStartAt?.toISOString(), half.actualEndAt]).toEqual(["2026-10-27T12:05:00.000Z", null]);
  });

  // R2 (made-for-kids follow-up): liveBroadcasts `status.madeForKids` is YouTube's CURRENT made-for-kids status of the broadcast - the same
  // `part=status` read gives it, so it costs no call. Only a real boolean is an answer; the wire strings are typed from the resource page.
  it("reads status.madeForKids from the same read: true and false are answers; absent, null, a string, a number and an object are NULL (YouTube did not say), and the life is still read", async () => {
    const wire = (madeForKids?: unknown) => ({ id: "bc1", status: { lifeCycleStatus: "live", ...(madeForKids === undefined ? {} : { madeForKids }) } });
    const rows: [string, unknown, boolean | null][] = [
      ["true", true, true], ["false", false, false],
      ["absent", undefined, null], ["null", null, null], ["the string true", "true", null], ["1", 1, null], ["0", 0, null], ["an object", { value: true }, null],
    ];
    let checked = 0;
    for (const [name, v, want] of rows) {
      sent = [];
      handler = () => res(200, { items: [wire(v)] });
      const got = await driver().broadcastLife(AT, "bc1");
      expect([name, got.life, got.madeForKids]).toEqual([name, "live", want]);
      expect(sent, `${name}: still ONE call, and it already asks for status (no extra part)`).toHaveLength(1);
      expect(new URL(sent[0]!.url).searchParams.get("part"), name).toBe("status,snippet");
      checked++;
    }
    expect(checked, "anti-vacuity: every wire shape read").toBe(rows.length);
    expect(new Set(rows.map((r) => r[2])), "true, false and null are all exercised").toEqual(new Set([true, false, null]));
  });

  it("a status Google never documented is still refused even when the snippet carries instants", async () => {
    handler = () => res(200, { items: [item("mystery", { actualStartTime: "2026-10-27T12:05:00Z" })] });
    const err = (await rejection(driver().broadcastLife(AT, "bc1"))) as YouTubeError;
    expect([err.code, err.reason]).toEqual(["youtube_unavailable", "unknownLifeCycleStatus"]);
  });

  it("agrees with the fake: the same broadcast, at the same moments, reads as the same {life, actualStartAt, actualEndAt} through both drivers", async () => {
    let t = new Date("2026-10-27T12:00:00Z").getTime();
    const fake = new FakeYouTube({ now: () => new Date(t) });
    const at = await fake.accessToken("1//parity");
    const { streamId } = await fake.insertStream(at, { title: "k" });
    const { broadcastId } = await fake.insertBroadcast(at, { title: "t", description: "", scheduledStart: new Date(t), privacy: "unlisted", madeForKids: false });
    // What YouTube would put on the wire for the fake's own state, written from the docs: the status, and the two instants once they exist.
    const wireOf = (): ReturnType<typeof item> => {
      const v = fake.inspectBroadcast(broadcastId)!;
      // `status.madeForKids` is YouTube's status of the broadcast: unless it decides otherwise, what it was created with.
      return {
        ...item(v.life, {
          ...(v.actualStartAt ? { actualStartTime: v.actualStartAt.toISOString() } : {}),
          ...(v.actualEndAt ? { actualEndTime: v.actualEndAt.toISOString() } : {}),
        }, v.madeForKids),
        id: broadcastId,
      };
    };
    const compare = async (name: string, want: { life: string; start: string | null; end: string | null }) => {
      const viaFake = await fake.broadcastLife(at, broadcastId);
      handler = () => res(200, { items: [wireOf()] });
      const viaGoogle = await driver().broadcastLife(AT, broadcastId);
      expect(viaGoogle, `${name}: driver = fake`).toEqual(viaFake);
      // and both are the TYPED expectation, so two agreeing wrong answers cannot pass
      expect([name, viaFake.life, viaFake.actualStartAt?.toISOString() ?? null, viaFake.actualEndAt?.toISOString() ?? null]).toEqual([name, want.life, want.start, want.end]);
    };
    await compare("created", { life: "created", start: null, end: null });
    await fake.bind(at, broadcastId, streamId);
    await compare("ready", { life: "ready", start: null, end: null });
    t += 5 * 60_000; fake.videoOn(streamId);
    t += 4 * 60_000;
    await compare("live", { life: "live", start: "2026-10-27T12:05:00.000Z", end: null });
    t += 41 * 60_000; await fake.complete(at, broadcastId);
    t += 5 * 60_000;
    await compare("complete", { life: "complete", start: "2026-10-27T12:05:00.000Z", end: "2026-10-27T12:50:00.000Z" });
  });
});

describe("broadcastLife's made-for-kids agrees between the fake and the driver (R2)", () => {
  it("a broadcast created with madeForKids true reads true through both; created with false reads false through both (typed from the argument sent, not read back)", async () => {
    let checked = 0;
    for (const declared of [true, false]) {
      const fake = new FakeYouTube();
      const at = await fake.accessToken("1//parity-kids");
      const { broadcastId } = await fake.insertBroadcast(at, { title: "t", description: "", scheduledStart: new Date(), privacy: "unlisted", madeForKids: declared });
      const viaFake = await fake.broadcastLife(at, broadcastId);
      const v = fake.inspectBroadcast(broadcastId)!;
      handler = () => res(200, { items: [{ id: broadcastId, status: { lifeCycleStatus: v.life, madeForKids: declared } }] });
      const viaGoogle = await driver().broadcastLife(AT, broadcastId);
      expect([declared, viaFake.madeForKids, viaGoogle.madeForKids]).toEqual([declared, declared, declared]);
      checked++;
    }
    expect(checked).toBe(2);
    // An id the fake does not hold: YouTube said nothing, so null (not false).
    const empty = new FakeYouTube();
    expect((await empty.broadcastLife(await empty.accessToken("1//none"), "nope")).madeForKids).toBeNull();
  });
});

describe("existingVideos and Google's 404 videoNotFound (fix round 1, I1)", () => {
  const idOf = (req: Sent): string => new URL(req.url).searchParams.get("id") ?? "";

  it("a 404 videoNotFound on ONE id is that id missing: an empty set, not an error", async () => {
    handler = () => apiError(404, "videoNotFound");
    expect([...(await driver().existingVideos(AT, ["aaa"])).keys()]).toEqual([]);
    expect(sent, "one call: nothing to split").toHaveLength(1);
    // The positive pair: a 404 with some other reason is NOT 'missing'; it is thrown.
    handler = () => apiError(404, "somethingNew");
    expect(((await rejection(driver().existingVideos(AT, ["aaa"]))) as YouTubeError).code).toBe("youtube_unavailable");
  });

  it("only `videoNotFound` is 'missing': a 404 with ANOTHER reason (liveBroadcastNotFound and liveStreamNotFound map to youtube_not_found; channelNotFound is unmapped) is thrown as it maps, on a batch (not split) and on a single id", async () => {
    // The old guard (`code === youtube_not_found`) forgave liveBroadcastNotFound and liveStreamNotFound too, so a wrong-resource 404
    // would have read as "the video was deleted" and purged a live link. Expected codes: the spec's table (§6.2), typed here.
    const others: [string, string][] = [
      ["liveBroadcastNotFound", "youtube_not_found"], ["liveStreamNotFound", "youtube_not_found"], ["channelNotFound", "youtube_unavailable"],
    ];
    let checked = 0;
    for (const [reason, code] of others) {
      sent = [];
      handler = () => apiError(404, reason);
      const batch = (await rejection(driver().existingVideos(AT, ["aaa", "bbb"]))) as YouTubeError;
      expect([reason, batch.code, batch.reason], "thrown with its own mapping").toEqual([reason, code, reason]);
      expect(sent, `${reason}: not re-asked per id`).toHaveLength(1);
      sent = [];
      const single = (await rejection(driver().existingVideos(AT, ["aaa"]))) as YouTubeError;
      expect([reason, single.reason]).toEqual([reason, reason]);
      // during the fallback too: the batch says videoNotFound, then one id's own call says something else
      sent = [];
      handler = (req) => (idOf(req).includes(",") ? apiError(404, "videoNotFound") : idOf(req) === "bbb" ? apiError(404, reason) : res(200, { items: [{ id: idOf(req) }] }));
      const mid = (await rejection(driver().existingVideos(AT, ["aaa", "bbb", "ccc"]))) as YouTubeError;
      expect([reason, mid.code, mid.reason]).toEqual([reason, code, reason]);
      expect(sent.map(idOf), "stops at the id whose call failed").toEqual(["aaa,bbb,ccc", "aaa", "bbb"]);
      checked++;
    }
    expect(checked).toBe(others.length);
    // the positive pair: videoNotFound itself is forgiven (an empty set), so the throw above is the reason and not the 404
    handler = () => apiError(404, "videoNotFound");
    expect([...(await driver().existingVideos(AT, ["aaa"])).keys()]).toEqual([]);
  });

  it("a 404 on a BATCH is never read as 'all missing': it is re-asked one id per call, and only the id whose own call is a 404 is absent", async () => {
    // Google's page does not say whether a batch with SOME ids missing answers 200 or 404. If it 404s, "all missing" would purge
    // the links of live videos, so the driver must find out id by id.
    handler = (req) => {
      const id = idOf(req);
      if (id.includes(",")) return apiError(404, "videoNotFound");
      return id === "bbb" ? apiError(404, "videoNotFound") : res(200, { items: [{ id }] });
    };
    const out = await driver().existingVideos(AT, ["aaa", "bbb", "ccc"]);
    expect([...out.keys()].sort(), "bbb alone is absent").toEqual(["aaa", "ccc"]);
    expect(sent.map(idOf), "the batch, then one call per id, in order").toEqual(["aaa,bbb,ccc", "aaa", "bbb", "ccc"]);
    for (const r of sent) expect(new URL(r.url).searchParams.get("part")).toBe("id,status");
  });

  it("the per-id fallback after a batch 404 carries each id's STATUS too, not only its presence", async () => {
    handler = (req) => {
      const id = idOf(req);
      if (id.includes(",")) return apiError(404, "videoNotFound");
      return id === "bbb" ? apiError(404, "videoNotFound") : res(200, { items: [{ id, status: { madeForKids: id === "aaa" } }] });
    };
    const out = await driver().existingVideos(AT, ["aaa", "bbb", "ccc"]);
    expect([...out].map(([id, v]) => [id, v.madeForKids]), "aaa true, ccc false (differ), bbb absent").toEqual([["aaa", true], ["ccc", false]]);
  });

  it("the fallback's other answers differ from the 'all missing' constant: every id present, every id missing, a duplicate id", async () => {
    // all present singly -> all present (the wrong answer would be the empty set)
    handler = (req) => (idOf(req).includes(",") ? apiError(404, "videoNotFound") : res(200, { items: [{ id: idOf(req) }] }));
    expect([...(await driver().existingVideos(AT, ["aaa", "bbb"])).keys()].sort()).toEqual(["aaa", "bbb"]);
    // all missing singly -> empty
    sent = [];
    handler = () => apiError(404, "videoNotFound");
    expect([...(await driver().existingVideos(AT, ["aaa", "bbb"])).keys()]).toEqual([]);
    expect(sent, "the batch plus one call per id").toHaveLength(3);
    // a duplicate id is asked once, and a batch of one distinct id is not split
    sent = [];
    expect([...(await driver().existingVideos(AT, ["aaa", "aaa"])).keys()]).toEqual([]);
    expect(sent.map(idOf)).toEqual(["aaa"]);
  });

  it("any other failure is thrown and is not split: a batch 500 is one call; a per-id 500 during the fallback is thrown, not read as 'missing'", async () => {
    handler = () => res(500, undefined, "<html>down</html>");
    expect(((await rejection(driver().existingVideos(AT, ["aaa", "bbb"]))) as YouTubeError).code).toBe("youtube_unavailable");
    expect(sent, "a batch 500 is not re-asked per id").toHaveLength(1);
    sent = [];
    handler = (req) => (idOf(req).includes(",") ? apiError(404, "videoNotFound") : idOf(req) === "bbb" ? res(503, {}, "unavailable") : res(200, { items: [{ id: idOf(req) }] }));
    expect(((await rejection(driver().existingVideos(AT, ["aaa", "bbb", "ccc"]))) as YouTubeError).code).toBe("youtube_unavailable");
    expect(sent.map(idOf), "stops at the failing id").toEqual(["aaa,bbb,ccc", "aaa", "bbb"]);
  });

  it("agrees with the fake: for the same videos the fake and the driver (batch 404, per-id answers) report the same set", async () => {
    const fake = new FakeYouTube();
    const fakeAt = await fake.accessToken("1//vids");
    const present = (await fake.insertBroadcast(fakeAt, { title: "t", description: "", scheduledStart: new Date(), privacy: "unlisted", madeForKids: false })).broadcastId;
    const asked = [present, "ghost0000001", "ghost0000002"];
    const viaFake = await fake.existingVideos(fakeAt, asked);
    handler = (req) => {
      const id = idOf(req);
      if (id.includes(",")) return apiError(404, "videoNotFound");
      return id === present ? res(200, { items: [{ id, status: { madeForKids: false } }] }) : apiError(404, "videoNotFound");
    };
    const viaGoogle = await driver().existingVideos(AT, asked);
    expect(viaGoogle.get(present), "the same facts, not only the same ids").toEqual(viaFake.get(present));
    expect([...viaGoogle.keys()].sort()).toEqual([...viaFake.keys()].sort());
    expect([...viaFake.keys()], "anti-vacuity: one present, two missing").toEqual([present]);
  });
});

describe("guards that need their own killing test (fix round 1, Mb)", () => {
  it("broadcastLife answers only for the broadcast it was asked about: an item with another id is 'absent', not that item's life", async () => {
    handler = () => res(200, { items: [{ id: "someone-elses-broadcast", status: { lifeCycleStatus: "live" } }] });
    expect((await driver().broadcastLife(AT, "bc1")).life).toBe("absent");
    // the positive pair: the same body with the asked id IS read
    handler = () => res(200, { items: [{ id: "someone-elses-broadcast", status: { lifeCycleStatus: "complete" } }, { id: "bc1", status: { lifeCycleStatus: "live" } }] });
    expect((await driver().broadcastLife(AT, "bc1")).life, "the matching item among others").toBe("live");
  });

  it("insertStream needs all three of the stream id, the ingestion address and the stream name: each one missing alone is malformedResponse", async () => {
    const full = { id: "strm1", cdn: { ingestionInfo: { ingestionAddress: "rtmp://a.rtmp.youtube.com/live2", streamName: "key-abcd-1234" } } };
    const without: [string, unknown][] = [
      ["id", { ...full, id: undefined }],
      ["ingestionAddress", { ...full, cdn: { ingestionInfo: { streamName: "key-abcd-1234" } } }],
      ["streamName", { ...full, cdn: { ingestionInfo: { ingestionAddress: "rtmp://a.rtmp.youtube.com/live2" } } }],
    ];
    let checked = 0;
    for (const [missing, body] of without) {
      handler = () => res(200, body);
      const err = (await rejection(driver().insertStream(AT, { title: "k" }))) as YouTubeError;
      expect([missing, err instanceof YouTubeError && err.code, err instanceof YouTubeError && err.reason]).toEqual([missing, "youtube_unavailable", "malformedResponse"]);
      checked++;
    }
    expect(checked).toBe(3);
    handler = () => res(200, full);
    await expect(driver().insertStream(AT, { title: "k" }), "the positive pair: all three present").resolves.toMatchObject({ streamId: "strm1" });
  });

  it("tokeninfo's `sub` is kept only as a non-empty string of at most 255 characters: 255 is kept, 256 and empty are null", async () => {
    const subOf = async (sub: unknown): Promise<string | null> => {
      handler = when(/\/tokeninfo$/, () => res(200, { sub }))(ok);
      return (await driver().exchangeCode({ code: CODE, codeVerifier: VERIFIER, redirectUri: REDIRECT })).googleSub;
    };
    expect(await subOf("1".repeat(255))).toBe("1".repeat(255));
    expect(await subOf("1".repeat(256))).toBeNull();
    expect(await subOf("")).toBeNull();
    expect(await subOf("1")).toBe("1");
  });

  it("an OAuth `error` that is not snake_case is read as 'unrecognised' (and is still an OAuth error: a 401 with it is NOT a reconnect)", async () => {
    const weird = "Some Weird Error! refresh_token=abc";
    for (const status of [400, 401]) {
      handler = () => res(status, { error: weird, error_description: "x" });
      const err = (await rejection(driver().accessToken(RT))) as YouTubeError;
      expect([status, err.code, err.reason]).toEqual([status, "youtube_unavailable", "unrecognised"]);
      expect(err.message).not.toContain("refresh_token");
    }
    // the positive pair: a well-formed one keeps its own name, camelCased
    handler = () => oauthError(400, "invalid_request");
    expect(((await rejection(driver().accessToken(RT))) as YouTubeError).reason).toBe("invalidRequest");
  });

  it("exchangeCode refuses a token response with no access token (malformedResponse) before asking tokeninfo for anything", async () => {
    handler = when(/\/token$/, () => res(200, { refresh_token: RT, scope: YOUTUBE_SCOPE }))(ok);
    const err = (await rejection(driver().exchangeCode({ code: CODE, codeVerifier: VERIFIER, redirectUri: REDIRECT }))) as YouTubeError;
    expect([err.code, err.reason]).toEqual(["youtube_unavailable", "malformedResponse"]);
    expect(sent, "no tokeninfo call was made with an empty token").toHaveLength(1);
  });
});

describe("refusal order agrees with the fake (fix round 1, Mc: the fake follows the live driver)", () => {
  const goodBroadcast = { title: "t", description: "", scheduledStart: new Date("2026-11-03T14:30:00Z"), privacy: "unlisted" as const, madeForKids: false };

  it("existingVideos([]) is an empty set with NO call and NO token check, in the fake and in the driver", async () => {
    const fake = new FakeYouTube();
    const before = fake.calls.length;
    // a token the fake never issued: if it were checked, this would be invalid_grant / reconnect_needed
    expect([...(await fake.existingVideos("not-an-access-token", [])).keys()]).toEqual([]);
    expect(fake.calls.length, "the fake did not count it as a call").toBe(before);
    expect([...(await driver().existingVideos("not-an-access-token", [])).keys()]).toEqual([]);
    expect(sent, "nor did the driver").toHaveLength(0);
    // the positive pair: a non-empty list DOES check the token, in the fake
    await expect(fake.existingVideos("not-an-access-token", ["aaa"])).rejects.toBeInstanceOf(YouTubeError);
  });

  it("a redirect URI that is not the one authorized is youtube_unavailable / redirectUriMismatch in BOTH (Seazn's own configuration: reconnecting cannot help); a bad code or verifier stays invalid_grant (reconnect_needed)", async () => {
    const fake = new FakeYouTube();
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";   // RFC 7636 appendix B
    const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    const issue = (state: string) => { fake.authorizeUrl({ state, codeChallenge: challenge, redirectUri: REDIRECT }); return fake.issueCode(state); };
    const viaFake = (await rejection(fake.exchangeCode({ code: issue("st-redirect"), codeVerifier: verifier, redirectUri: `${REDIRECT}/elsewhere` }))) as YouTubeError;
    handler = () => oauthError(400, "redirect_uri_mismatch", "Bad Request");
    const viaGoogle = (await rejection(driver().exchangeCode({ code: CODE, codeVerifier: VERIFIER, redirectUri: `${REDIRECT}/elsewhere` }))) as YouTubeError;
    expect([viaFake.code, viaFake.reason], "typed from the OAuth error table, not from either driver").toEqual(["youtube_unavailable", "redirectUriMismatch"]);
    expect([viaGoogle.code, viaGoogle.reason], "the driver says the same").toEqual([viaFake.code, viaFake.reason]);
    // the positive pair: invalid_grant is the other answer, in both
    const badFake = (await rejection(fake.exchangeCode({ code: issue("st-bad-verifier"), codeVerifier: `${verifier}x`, redirectUri: REDIRECT }))) as YouTubeError;
    handler = () => oauthError(400, "invalid_grant", "Bad Request");
    const badGoogle = (await rejection(driver().exchangeCode({ code: CODE, codeVerifier: VERIFIER, redirectUri: REDIRECT }))) as YouTubeError;
    expect([badFake.code, badFake.reason]).toEqual(["youtube_reconnect_needed", "invalidGrant"]);
    expect([badGoogle.code, badGoogle.reason]).toEqual([badFake.code, badFake.reason]);
  });

  it("a bad title is refused as invalidTitle BEFORE eligibility: on a channel-less account, a not-enabled channel and a blocked channel, alike in the fake and the driver", async () => {
    const mk = async (setup: (f: FakeYouTube) => FakeYouTube): Promise<{ f: FakeYouTube; at: string }> => {
      const f = setup(new FakeYouTube());
      return { f, at: await f.accessToken("1//order") };
    };
    const situations: [string, () => Promise<{ f: FakeYouTube; at: string }>, string][] = [
      ["no channel", async () => { const f = new FakeYouTube({ channels: [] }); return { f, at: await f.accessToken("1//order") }; }, "youtubeSignupRequired"],
      ["live not enabled", () => mk((f) => { f.setLive("not_enabled"); return f; }), "liveStreamingNotEnabled"],
      ["live blocked", () => mk((f) => { f.setLive("blocked"); return f; }), "livePermissionBlocked"],
    ];
    let checked = 0;
    for (const [name, build, eligibilityReason] of situations) {
      const { f, at } = await build();
      const badFake = (await rejection(f.insertBroadcast(at, { ...goodBroadcast, title: "<b>" }))) as YouTubeError;
      expect([name, badFake.code, badFake.reason]).toEqual([name, "youtube_unavailable", "invalidTitle"]);
      // the positive pair, in the fake: a GOOD title on the same situation is told about the eligibility instead
      const goodFake = (await rejection(f.insertBroadcast(at, goodBroadcast))) as YouTubeError;
      expect([name, goodFake.reason]).toEqual([name, eligibilityReason]);
      sent = [];
      const badGoogle = (await rejection(driver().insertBroadcast(AT, { ...goodBroadcast, title: "<b>" }))) as YouTubeError;
      expect([name, badGoogle.code, badGoogle.reason], "the driver says the same").toEqual([name, badFake.code, badFake.reason]);
      expect(sent, `${name}: and never reaches Google`).toHaveLength(0);
      checked++;
    }
    expect(checked).toBe(situations.length);
  });
});

describe("revoke (developers.google.com/identity/protocols/oauth2/web-server, 'Token revocation')", () => {
  it("POSTs the refresh token in a FORM BODY to oauth2.googleapis.com/revoke — never the query string Google's example shows", async () => {
    await driver().revoke(RT);
    expect(sent).toHaveLength(1);
    expect(`${sent[0]!.method} ${sent[0]!.url}`).toBe("POST https://oauth2.googleapis.com/revoke");
    expect(sent[0]!.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(formOf(sent[0]!).entries())).toEqual({ token: RT });
  });

  it("an already-invalid token (Google's 400 invalid_token) resolves — the end state asked for — and so does a second revoke; any other failure is thrown", async () => {
    handler = () => oauthError(400, "invalid_token", "Token expired or revoked");
    await expect(driver().revoke(RT)).resolves.toBeUndefined();
    await expect(driver().revoke(RT), "second call").resolves.toBeUndefined();
    handler = () => oauthError(400, "invalid_request", "Missing required parameter: token");
    expect(((await rejection(driver().revoke(RT))) as YouTubeError).code).toBe("youtube_unavailable");
    handler = () => res(503, {}, "unavailable");
    expect(((await rejection(driver().revoke(RT))) as YouTubeError).code).toBe("youtube_unavailable");
  });
});

// One call of each request-making method, with real-looking arguments.
type RequestMethod = Exclude<keyof YouTubePort, "mode" | "authorizeUrl">;
const CALLS: Record<RequestMethod, (g: YouTubePort) => Promise<unknown>> = {
  exchangeCode: (g) => g.exchangeCode({ code: CODE, codeVerifier: VERIFIER, redirectUri: REDIRECT }),
  accessToken: (g) => g.accessToken(RT),
  listMyChannels: (g) => g.listMyChannels(AT),
  liveEnabled: (g) => g.liveEnabled(AT),
  insertStream: (g) => g.insertStream(AT, { title: "k" }),
  deleteStream: (g) => g.deleteStream(AT, "strm1"),
  listStreams: (g) => g.listStreams(AT),
  insertBroadcast: (g) => g.insertBroadcast(AT, { title: "t", description: "d", scheduledStart: new Date("2026-11-03T14:30:00Z"), privacy: "unlisted", madeForKids: false }),
  bind: (g) => g.bind(AT, "bc1", "strm1"),
  broadcastLife: (g) => g.broadcastLife(AT, "bc1"),
  complete: (g) => g.complete(AT, "bc1"),
  deleteBroadcast: (g) => g.deleteBroadcast(AT, "bc1"),
  existingVideos: (g) => g.existingVideos(AT, ["vid1"]),
  revoke: (g) => g.revoke(RT),
};

describe("secrets stay out of every URL and ride in the Authorization header or a POST body", () => {
  it("every request-making method: no URL holds the access token, refresh token, code, verifier or client secret; Data API calls carry `Authorization: Bearer <at>`", async () => {
    const methods = FAKE_YOUTUBE_METHODS.filter((m): m is RequestMethod => m !== "authorizeUrl");
    expect(methods.length, "the port's 14 methods other than authorizeUrl").toBe(14);
    expect(Object.keys(CALLS).sort(), "the table covers exactly those").toEqual([...methods].sort());
    const g = driver();
    for (const m of methods) await CALLS[m](g);

    // exchangeCode makes TWO requests (token, then tokeninfo): 14 methods, 15 requests.
    expect(sent).toHaveLength(15);
    let checked = 0;
    let bearer = 0;
    let formBodies = 0;
    for (const r of sent) {
      for (const secret of SECRETS) {
        expect(r.url, `${r.method} ${r.url} must not contain a secret`).not.toContain(secret);
        expect(decodeURIComponent(r.url)).not.toContain(secret);
      }
      const u = new URL(r.url);
      expect(["www.googleapis.com", "oauth2.googleapis.com"], r.url).toContain(u.host);
      // Hardening that applies to every call: a redirect is an error (an Authorization header must not follow one), and a
      // GET of live state is never served from a cache.
      expect(r.init.redirect, `redirect on ${r.url}`).toBe("error");
      expect(r.init.cache, `cache on ${r.url}`).toBe("no-store");
      expect(r.init.signal, `signal on ${r.url}`).toBeInstanceOf(AbortSignal);
      if (u.host === "www.googleapis.com") {
        expect(r.headers.authorization, r.url).toBe(`Bearer ${AT}`);
        bearer++;
      } else {
        expect(r.headers.authorization, `${r.url}: tokens and secrets ride in the body, with no header`).toBeUndefined();
        expect(r.method).toBe("POST");
        expect(r.headers["content-type"]).toBe("application/x-www-form-urlencoded");
        expect(r.body ?? "", r.url).not.toBe("");
        formBodies++;
      }
      checked++;
    }
    expect(checked, "anti-vacuity: every captured request was checked").toBe(15);
    expect([bearer, formBodies], "11 Data API calls + 4 OAuth form calls").toEqual([11, 4]);
  });

  it("revoke and tokeninfo send the token in a form POST body, never the query string", async () => {
    await driver().revoke(RT);
    await driver().exchangeCode({ code: CODE, codeVerifier: VERIFIER, redirectUri: REDIRECT });
    const revoke = sent.find((r) => r.url.endsWith("/revoke"))!;
    const info = sent.find((r) => r.url.endsWith("/tokeninfo"))!;
    for (const [name, r, field, value] of [["revoke", revoke, "token", RT], ["tokeninfo", info, "access_token", AT]] as const) {
      expect(r.method, name).toBe("POST");
      expect(new URL(r.url).search, `${name}: no query string`).toBe("");
      expect(formOf(r).get(field), `${name}: the token is in the body`).toBe(value);
    }
  });
});

// Google's error table. The first fourteen rows are the plan's table verbatim; the rest are rows Step 0 added from Google's own
// pages (each names its source) and the ordering traps (a status that would mislead without the reason).
describe("mapGoogleError", () => {
  it("maps Google's error table to the closed code set", () => {
    const rows: [Parameters<typeof mapGoogleError>[0], string][] = [
      [{ status: 400, oauthError: "invalid_grant" }, "youtube_reconnect_needed"],
      [{ status: 401, reason: "authError" }, "youtube_reconnect_needed"],
      [{ status: 403, reason: "insufficientPermissions" }, "youtube_reconnect_needed"],
      [{ status: 403, reason: "liveStreamingNotEnabled" }, "youtube_live_not_enabled"],
      [{ status: 403, reason: "livePermissionBlocked" }, "youtube_live_blocked"],
      [{ status: 403, reason: "limitExceeded" }, "youtube_limit_reached"],
      [{ status: 403, reason: "userBroadcastsExceedLimit" }, "youtube_limit_reached"],
      [{ status: 403, reason: "rateLimitExceeded" }, "youtube_limit_reached"],
      [{ status: 403, reason: "userRequestsExceedRateLimit" }, "youtube_limit_reached"],
      [{ status: 403, reason: "quotaExceeded" }, "youtube_limit_reached"],
      [{ status: 404, reason: "liveBroadcastNotFound" }, "youtube_not_found"],
      [{ status: 500 }, "youtube_unavailable"],
      [{ status: 503 }, "youtube_unavailable"],
      [{ status: 418, reason: "somethingNew" }, "youtube_unavailable"],
      // — added by Step 0 —
      // errors page: youtubeSignupRequired is HTTP 401 ("the user has an unlinked Google Account": no YouTube channel). It must
      // NOT take the generic 401 -> reconnect rule: the token is fine, reconnecting the same account cannot help. The fake
      // answers youtube_unavailable for the same account.
      [{ status: 401, reason: "youtubeSignupRequired" }, "youtube_unavailable"],
      [{ status: 401, reason: "authorizationRequired" }, "youtube_reconnect_needed"],   // errors page: `mine` not properly authorized
      [{ status: 401 }, "youtube_reconnect_needed"],                                     // an unadorned 401 is a dead access token
      [{ status: 403, reason: "insufficientLivePermissions" }, "youtube_reconnect_needed"],   // liveBroadcasts/liveStreams pages: "not authorized"
      [{ status: 403, reason: "concurrentBroadcastsExceedLimit" }, "youtube_limit_reached"],   // transition page: the channel's 10
      [{ status: 403, reason: "sharedIngestionBroadcastsExceedLimit" }, "youtube_limit_reached"],   // transition page: the key's 3
      [{ status: 403, reason: "dailyLimitExceeded" }, "youtube_limit_reached"],
      [{ status: 429 }, "youtube_limit_reached"],
      [{ status: 404, reason: "liveStreamNotFound" }, "youtube_not_found"],              // bind / delete pages
      [{ status: 404, reason: "videoNotFound" }, "youtube_not_found"],                   // videos.list page
      // the neighbours that are NOT gone / NOT a limit:
      [{ status: 403, reason: "invalidTransition" }, "youtube_unavailable"],             // transition page: 403 forbidden
      [{ status: 403, reason: "redundantTransition" }, "youtube_unavailable"],           // (the driver resolves it for `complete`; the mapping itself is not an error code)
      [{ status: 403, reason: "liveBroadcastDeletionNotAllowed" }, "youtube_unavailable"],
      [{ status: 403, reason: "forbidden" }, "youtube_unavailable"],
      [{ status: 403 }, "youtube_unavailable"],
      [{ status: 400, reason: "invalidTitle" }, "youtube_unavailable"],
      [{ status: 404, reason: "somethingNew" }, "youtube_unavailable"],                  // a 404 is "gone" only for a reason that says so
      [{ status: 404 }, "youtube_unavailable"],
      [{ status: 500, reason: "liveBroadcastNotFound" }, "youtube_unavailable"],         // ... and only as a 404
      // the token endpoint: only invalid_grant is the club's to fix.
      [{ status: 401, oauthError: "invalid_client" }, "youtube_unavailable"],            // Seazn's client credentials: reconnecting cannot help
      [{ status: 400, oauthError: "invalid_request" }, "youtube_unavailable"],
      [{ status: 400, oauthError: "redirect_uri_mismatch" }, "youtube_unavailable"],
      [{ status: 400, oauthError: "unsupported_grant_type" }, "youtube_unavailable"],
      [{ status: 400 }, "youtube_unavailable"],
      [{ status: 200, reason: "" }, "youtube_unavailable"],
    ];
    let checked = 0;
    for (const [i, want] of rows) {
      expect(mapGoogleError(i), JSON.stringify(i)).toBe(want);
      checked++;
    }
    expect(checked).toBe(rows.length);
    // Anti-vacuity: every code in the closed set is the answer to at least one row, and nothing answers outside it.
    const answered = new Set(rows.map(([, want]) => want));
    expect([...answered].sort()).toEqual([...YOUTUBE_ERROR_CODES].sort());
  });

  it("agrees with the fake: the same situation gives the same (code, reason) whether FakeYouTube or this driver is behind the port", async () => {
    // Each row drives the FAKE into a refusal through its public API, and answers the same situation from Google.
    const mkFake = async (): Promise<{ f: FakeYouTube; at: string }> => {
      const f = new FakeYouTube();
      return { f, at: await f.accessToken("1//agree") };
    };
    const rows: { name: string; fake: () => Promise<unknown>; google: Reply; call: (g: YouTubePort) => Promise<unknown> }[] = [
      {
        name: "no YouTube channel on the account",
        fake: async () => { const none = new FakeYouTube({ channels: [] }); return none.insertStream(await none.accessToken("1//none"), { title: "k" }); },
        google: apiError(401, "youtubeSignupRequired"),
        call: (g) => g.insertStream(AT, { title: "k" }),
      },
      {
        name: "live streaming not enabled",
        fake: async () => { const { f, at } = await mkFake(); f.setLive("not_enabled"); return f.insertBroadcast(at, { title: "t", description: "", scheduledStart: new Date(), privacy: "unlisted", madeForKids: false }); },
        google: apiError(403, "liveStreamingNotEnabled"),
        call: (g) => g.insertBroadcast(AT, { title: "t", description: "", scheduledStart: new Date(), privacy: "unlisted", madeForKids: false }),
      },
      {
        name: "live streaming blocked",
        fake: async () => { const { f, at } = await mkFake(); f.setLive("blocked"); return f.insertStream(at, { title: "k" }); },
        google: apiError(403, "livePermissionBlocked"),
        call: (g) => g.insertStream(AT, { title: "k" }),
      },
      {
        name: "refresh token revoked or expired",
        fake: async () => { const { f } = await mkFake(); f.killToken("1//agree"); return f.accessToken("1//agree"); },
        google: oauthError(400, "invalid_grant"),
        call: (g) => g.accessToken(RT),
      },
      {
        name: "access token no longer valid",
        fake: async () => { const { f, at } = await mkFake(); f.killToken("1//agree"); return f.listMyChannels(at); },
        google: apiError(401, "authError"),
        call: (g) => g.listMyChannels(AT),
      },
      {
        name: "bind to a stream that is not this channel's",
        fake: async () => {
          const { f, at } = await mkFake();
          const other = new FakeYouTube();   // a second YouTube: its stream does not exist on the first
          const otherStream = await other.insertStream(await other.accessToken("1//other"), { title: "o" });
          const { broadcastId } = await f.insertBroadcast(at, { title: "t", description: "", scheduledStart: new Date(), privacy: "unlisted", madeForKids: false });
          return f.bind(at, broadcastId, otherStream.streamId);
        },
        google: apiError(404, "liveStreamNotFound"),
        call: (g) => g.bind(AT, "bc1", "strm-not-mine"),
      },
      {
        name: "complete a broadcast that is not live",
        fake: async () => {
          const { f, at } = await mkFake();
          const { broadcastId } = await f.insertBroadcast(at, { title: "t", description: "", scheduledStart: new Date(), privacy: "unlisted", madeForKids: false });
          return f.complete(at, broadcastId);
        },
        google: apiError(403, "invalidTransition"),
        call: (g) => g.complete(AT, "bc1"),
      },
      {
        // YouTube refusing to let a stream go (403 liveStreamDeletionNotAllowed: e.g. a broadcast still holds it) - the disconnect's retry
        // and its "keys left" answer are driven by the fake's control for exactly this.
        name: "delete a stream YouTube will not let go of",
        fake: async () => {
          const { f, at } = await mkFake();
          const { streamId } = await f.insertStream(at, { title: "k" });
          f.refuseStreamDelete(streamId);
          return f.deleteStream(at, streamId);
        },
        google: apiError(403, "liveStreamDeletionNotAllowed"),
        call: (g) => g.deleteStream(AT, "strm1"),
      },
    ];
    let checked = 0;
    for (const row of rows) {
      const viaFake = (await rejection(row.fake())) as YouTubeError;
      expect(viaFake, `${row.name}: the fake refuses`).toBeInstanceOf(YouTubeError);
      handler = () => row.google;
      const viaGoogle = (await rejection(row.call(driver()))) as YouTubeError;
      expect(viaGoogle, `${row.name}: the driver refuses`).toBeInstanceOf(YouTubeError);
      expect([row.name, viaGoogle.code, viaGoogle.reason]).toEqual([row.name, viaFake.code, viaFake.reason]);
      checked++;
    }
    expect(checked).toBe(rows.length);
    // NOT compared: the fake's "4th open broadcast on a key" refusal at bind. Google documents the per-key 3 on TRANSITION
    // (`sharedIngestionBroadcastsExceedLimit`, mapped in the table above) and gives bind no limit reason, so the driver has no
    // bind counterpart to agree with; the fake's refusal is fake-only (see fake.ts).
  });
});

describe("failures are codes, whatever Google (or the network) said", () => {
  it("a timeout (10 s, AbortSignal) is youtube_unavailable / timeout: nothing aborts at 9.999 s, the call aborts at 10 s, and the timer is gone after", async () => {
    vi.useFakeTimers();
    let aborted = false;
    handler = (req) =>
      new Promise<Reply>((_, reject) => {
        (req.init.signal as AbortSignal).addEventListener("abort", () => { aborted = true; reject(new DOMException("This operation was aborted", "AbortError")); });
      });
    const settled = rejection(driver().accessToken(RT));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(aborted, "not yet at 9.999 s").toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(aborted, "aborted at 10 s").toBe(true);
    const err = (await settled) as YouTubeError;
    expect(err).toBeInstanceOf(YouTubeError);
    expect([err.code, err.reason]).toEqual(["youtube_unavailable", "timeout"]);
    expect(vi.getTimerCount(), "no timer left behind").toBe(0);
  });

  it("the positive pair: a prompt answer is not aborted and leaves no timer", async () => {
    vi.useFakeTimers();
    expect(await driver().accessToken(RT)).toBe(AT);
    expect((sent[0]!.init.signal as AbortSignal).aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect((sent[0]!.init.signal as AbortSignal).aborted, "the cleared timer does not fire later").toBe(false);
  });

  it("every request-making method turns a network error into youtube_unavailable / network, and a 500 into youtube_unavailable", async () => {
    let checked = 0;
    for (const m of Object.keys(CALLS) as RequestMethod[]) {
      handler = () => new TypeError(`fetch failed: https://www.googleapis.com/x?access_token=${AT}`);
      const a = (await rejection(CALLS[m](driver()))) as YouTubeError;
      expect([m, a instanceof YouTubeError && a.code, a instanceof YouTubeError && a.reason]).toEqual([m, "youtube_unavailable", "network"]);
      handler = () => res(500, undefined, "<html>Internal Server Error</html>");
      const b = (await rejection(CALLS[m](driver()))) as YouTubeError;
      expect([m, b instanceof YouTubeError && b.code]).toEqual([m, "youtube_unavailable"]);
      checked++;
    }
    expect(checked, "14 methods").toBe(14);
  });

  it("a 200 whose body is not JSON is youtube_unavailable / malformedResponse for every method that reads the body", async () => {
    const readers: RequestMethod[] = ["exchangeCode", "accessToken", "listMyChannels", "liveEnabled", "insertStream", "listStreams", "insertBroadcast", "broadcastLife", "existingVideos"];
    let checked = 0;
    for (const m of readers) {
      handler = () => res(200, undefined, `{"id": ${AT}`);
      const err = (await rejection(CALLS[m](driver()))) as YouTubeError;
      expect([m, err instanceof YouTubeError && err.code, err instanceof YouTubeError && err.reason]).toEqual([m, "youtube_unavailable", "malformedResponse"]);
      checked++;
    }
    expect(checked).toBe(readers.length);
  });

  describe("a thrown YouTubeError's message, reason, stack, JSON and logged line never contain the response body, a token or a secret", () => {
    // Every raw fragment a hostile or merely chatty Google could put in a body, an error description or a reason.
    const LEAK = `refresh_token=${RT}&access_token=${AT}&client_secret=${CLIENT_SECRET}&code=${CODE}&code_verifier=${VERIFIER}`;
    const FRAGMENTS = [...SECRETS, "refresh_token", "access_token", "client_secret", "code_verifier", "invalid_grant", "LEAK-MARKER"];

    const scenarios: { name: string; method: RequestMethod; reply: Reply }[] = [
      { name: "token endpoint error with the form in its description", method: "accessToken", reply: oauthError(400, "invalid_grant", `LEAK-MARKER ${LEAK}`) },
      { name: "token endpoint error whose `error` is the form string itself", method: "exchangeCode", reply: res(400, { error: LEAK, error_description: "LEAK-MARKER" }) },
      { name: "Data API error whose REASON is the form string", method: "insertBroadcast", reply: apiError(403, LEAK, `LEAK-MARKER ${LEAK}`) },
      { name: "Data API error with a token-shaped message and extra fields", method: "bind", reply: res(403, { error: { code: 403, message: LEAK, errors: [{ reason: "forbidden", message: LEAK, extendedHelp: LEAK }], details: [LEAK] } }) },
      { name: "an HTML error page that echoes the request", method: "listMyChannels", reply: res(502, undefined, `<html>LEAK-MARKER Bad gateway ${LEAK}</html>`) },
      { name: "a plain-text 500 carrying the form", method: "revoke", reply: res(500, undefined, `LEAK-MARKER ${LEAK}`) },
      { name: "a 200 body that is not JSON (JSON.parse's message quotes the input)", method: "insertStream", reply: res(200, undefined, `{"id": ${LEAK} LEAK-MARKER`) },
      { name: "a network error whose message carries the URL and the form", method: "complete", reply: Object.assign(new TypeError(`fetch failed LEAK-MARKER ${LEAK}`), { cause: new Error(LEAK) }) },
      { name: "an abort error that carries the form", method: "existingVideos", reply: Object.assign(new Error(`LEAK-MARKER ${LEAK}`), { name: "AbortError" }) },
    ];

    it("sweeps 9 failure shapes x 7 surfaces x 11 fragments", async () => {
      const lines: string[] = [];
      const sink = pino({ ...LOGGER_OPTIONS, level: "trace" }, { write: (s: string) => { lines.push(s); } });
      let checked = 0;
      for (const sc of scenarios) {
        handler = () => sc.reply;
        const err = (await rejection(CALLS[sc.method](driver()))) as YouTubeError;
        expect(err, `${sc.name}: the thrown thing is a YouTubeError, not a raw provider error`).toBeInstanceOf(YouTubeError);
        expect(Object.getOwnPropertyNames(err).sort(), `${sc.name}: no cause, no extras`).toEqual(["code", "message", "name", "reason", "stack"]);
        expect(YOUTUBE_ERROR_CODES, sc.name).toContain(err.code);
        expect(err.reason, `${sc.name}: a reason is Google's token or nothing`).toMatch(/^[A-Za-z]{0,64}$/);

        const before = lines.length;
        sink.warn({ err }, "youtube call failed");
        sink.warn({ error: err, extra: { err } }, "youtube call failed, other keys");
        expect(lines.length - before, `${sc.name}: the logger wrote`).toBe(2);
        const surfaces: Record<string, string> = {
          message: err.message, reason: err.reason, stack: err.stack ?? "", toString: String(err), json: JSON.stringify(err),
          inspect: inspect(err, { depth: 8, showHidden: true }), logged: lines.slice(before).join("\n"),
        };
        for (const [surface, text] of Object.entries(surfaces)) {
          for (const part of FRAGMENTS) {
            expect(text, `${sc.name} / ${surface} must not contain ${part}`).not.toContain(part);
            checked++;
          }
        }
        // The positive pair: the closed code IS in the logged line, so it is not empty because the error was dropped.
        expect(surfaces.logged, sc.name).toContain(err.code);
      }
      expect(checked, "scenarios x surfaces x fragments").toBe(scenarios.length * 7 * FRAGMENTS.length);
    });

    it("the pair for the sweep: Google's own reason token DOES survive (so the sweep is not passing because every reason is dropped)", async () => {
      handler = () => apiError(403, "liveStreamingNotEnabled", `LEAK-MARKER ${LEAK}`);
      const err = (await rejection(CALLS.insertStream(driver()))) as YouTubeError;
      expect([err.code, err.reason, err.message]).toEqual(["youtube_live_not_enabled", "liveStreamingNotEnabled", "youtube_live_not_enabled (liveStreamingNotEnabled)"]);
    });
  });
});
