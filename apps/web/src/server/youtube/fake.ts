import "server-only";
import { createHash } from "node:crypto";
// server/youtube/fake.ts — FakeYouTube: a deterministic in-memory YouTube (plan T5, spec §9.1). It implements the whole port,
// refuses the way Google does (the 10 / 3 limits, the live-streaming eligibility errors, an expired or revoked grant, a bad
// OAuth exchange), and carries a control surface the unit tests and the e2e control route drive (`failNext`, `killToken`,
// `videoOn`, `issueCode`, `reset`, …). It is the driver of every process that is not talking to the real YouTube: unit tests,
// `next dev`, and the e2e server.
//
// What it models, because a later task's code will lean on it:
//   * A broadcast is `created`, becomes `ready` when bound to a stream, and goes `live` when VIDEO ARRIVES on that stream
//     (`enableAutoStart=true`). Nothing ends it but `complete()` — `enableAutoStop=false`, so `videoOff` leaves it live.
//   * Limits are Google's, typed as their own literals below with the page they come from. The 10 is per CHANNEL.
//   * CHANNELS belong to GRANTS. A refresh token is pinned to a channel when its grant is made (a code exchange) — or, for a
//     token a test seeds from its own database, the first time it is used: only a token shaped like Google's (`1//…`) is
//     accepted unseen, any other unknown refresh token is `invalid_grant`. Every access token minted from it inherits the
//     channel. Streams and broadcasts belong to a channel: another channel's resource is `youtube_not_found` to a token
//     (`broadcastLife` says `absent`; a delete of it resolves and removes nothing). Every grant gets its OWN fresh channel, so
//     parallel e2e orgs never share one channel's 10-live cap. A test shares a channel or builds a multi-channel picker with
//     `setChannels` / `pinChannelsTo` / `setGrantedScope`, which are bound to ONE OAuth STATE: they ride that state's code and
//     are spent by the one grant it mints, so the next connect is fresh again. (The constructor's `channels` is a unit-test
//     fixture that every grant sees; the e2e fake is built without it.) An account with NO channel (`channels: []`) cannot
//     create a stream or a broadcast: `youtube_unavailable` / `youtubeSignupRequired`.
//   * SERIAL-ONLY CONTROLS: `reset`, and `failNext` / `setLive` / `setAutoVideo` called WITHOUT a channel scope, act on the
//     whole fake — they are for a serial setup step (T20 calls them from serial setup only). Parallel specs name a grant
//     (`tokenHandle` -> `{channelId}` scope) or an OAuth state, and so touch nothing of another org's.
//   * A token that is killed (or revoked) is dead for good, and so is every access token minted from it; the broadcasts it
//     made keep running, because Google's revoke does not touch a stream already carrying video. A mint lasts 3600 s by the
//     injected clock; an expired access token is the same 401 a dead one is.
//   * The OAuth exchange is PKCE: `authorizeUrl` records the state's challenge and redirect URI, `issueCode(state)` (the fake
//     authorize hop's job) mints a single-use code bound to them, and `exchangeCode` refuses a verifier whose S256 is not the
//     challenge, another redirect URI, an unknown code and a replayed one — all `invalid_grant`, i.e. `youtube_reconnect_needed`.
//     A refresh token that came from none of those (a made-up string, a sealed blob, a uuid) is `invalid_grant` too.
//   * Errors carry a CODE and at most Google's reason token (port.ts) — never an argument, a token or a key. `calls` records
//     method names and times only.
//
// What it does not model: a daily stream-creation cap (unpublished) and a stream's own title rules.
import { YOUTUBE_SCOPE, type YoutubePrivacy } from "@/lib/youtube";
import { YOUTUBE_ERROR_CODES, YouTubeError, type BroadcastLife, type BroadcastLifeInfo, type YoutubeErrorCode, type YouTubePort } from "./port";

// Google's limits — "10 active streams allowed per channel and 3 active streams per stream key" — are the fake's OWN literals
// (https://support.google.com/youtube/answer/2474026). The tests type them again from the same page rather than import them.
const MAX_LIVE_PER_CHANNEL = 10;
const MAX_OPEN_PER_STREAM_KEY = 3;
/** videos.list takes at most 50 ids per call (https://developers.google.com/youtube/v3/docs/videos/list, `id`). */
const MAX_VIDEO_IDS_PER_CALL = 50;
/** A broadcast title: at most 100 characters, and neither `<` nor `>` (liveBroadcasts `snippet.title`, plan P11). Counted in
 *  code points, so a title Seazn trimmed to 100 code points is never refused for an emoji's two UTF-16 units. */
const BROADCAST_TITLE_MAX_CHARS = 100;
/** An OAuth access token lasts `expires_in` = 3600 seconds (https://developers.google.com/identity/protocols/oauth2/web-server). */
const ACCESS_TOKEN_LIFETIME_MS = 3600 * 1000;

/** YouTube's real RTMP ingest host, so a pooled key from the fake passes the destination allowlist
 *  (lib/stream-destinations.ts) wherever a later task checks one. The fake never opens a socket to it. */
const FAKE_INGEST_URL = "rtmp://a.rtmp.youtube.com/live2";
/** Google's refresh tokens begin `1//`. The fake accepts an UNSEEN refresh token only in that shape (a test seeding its own
 *  database writes one), pinning it to a fresh channel; any other string was never issued and is `invalid_grant`. */
const GOOGLE_REFRESH_TOKEN_PREFIX = "1//";
/** The subject a fake grant reports unless `setGoogleSub` says otherwise (a state-bound control; null = no `sub`): DISTINCT per
 *  grant, derived from the grant's channel — so two connections are two Google accounts, a reconnect pinned to the same channel
 *  (`pinChannelsTo`) is the same account, and a test gives two connections ONE account only on purpose (`setGoogleSub`). */
const fakeSubOf = (channelId: string): string => `fake-sub-${channelId}`;
/** A Date handed out is a copy, so a caller mutating one cannot move the fake's record. */
const copyOf = (d: Date | null): Date | null => (d === null ? null : new Date(d.getTime()));
/** Where the fake authorize hop lives (T7 owns the route); the fake's `authorizeUrl` points at it on the redirect URI's origin. */
const FAKE_AUTHORIZE_PATH = "/api/youtube/connect/fake-authorize";

type PortMethod = Exclude<keyof YouTubePort, "mode">;
// A Record, not an array: tsc refuses a port method added to the interface and forgotten here.
const PORT_METHODS: Record<PortMethod, true> = {
  authorizeUrl: true, exchangeCode: true, accessToken: true, listMyChannels: true, liveEnabled: true, insertStream: true,
  deleteStream: true, insertBroadcast: true, bind: true, broadcastLife: true, complete: true, deleteBroadcast: true,
  existingVideos: true, revoke: true,
};
/** Every method of the port (not `mode`), in one place for the control route's schema and for sweeps. */
export const FAKE_YOUTUBE_METHODS = Object.keys(PORT_METHODS) as PortMethod[];

type Channel = { id: string; title: string };
type LiveState = "enabled" | "not_enabled" | "blocked";
/** Scope a control to one channel: only calls made with that channel's tokens see it. Absent: every channel. */
export type FakeScope = { channelId: string };
interface Stream { id: string; title: string; channelId: string; video: boolean }
interface Broadcast {
  id: string; channelId: string; title: string; description: string; scheduledStart: Date; privacy: YoutubePrivacy;
  madeForKids: boolean; streamId: string | null; life: Exclude<BroadcastLife, "absent">;
  /** When it went live / was completed, by the injected clock — what YouTube's `snippet.actualStartTime` / `actualEndTime` say. */
  actualStart: Date | null; actualEnd: Date | null;
}
/** A refresh token's pinned identity: the channels its grant can see, the one its API calls act on (the first), and the Google
 *  account subject it reports (null: the account has none, as a youtube-only token may). */
interface Grant { channels: Channel[]; channelId: string; sub: string | null }
interface Injection { code: YoutubeErrorCode; reason?: string; channelId?: string }
/** What `authorizeUrl` recorded for an OAuth state, plus what a test bound to THAT state: the channels the grant it mints gets
 *  and the scope its code carries. Both ride the first code `issueCode` mints for the state and are spent there. */
/** `sub` is a test's override (`setGoogleSub`, null allowed); `accountSub` is the subject of the grant a `pinChannelsTo` reconnect
 *  joins. Neither set: the new grant derives its own. The override wins over the pin, whichever was called first. */
interface Pending { challenge: string; redirectUri: string; channels?: Channel[]; scope?: string; sub?: string | null; accountSub?: string | null }
/** What the inspector shows of a broadcast: everything it was created with, where it is bound and its life. No credential. */
export interface BroadcastView {
  channelId: string; title: string; description: string; scheduledStart: Date; privacy: YoutubePrivacy; madeForKids: boolean;
  streamId: string | null; life: BroadcastLife; actualStartAt: Date | null; actualEndAt: Date | null;
}

/** A broadcast YouTube would still count against a stream key (3 per key) — not finished, not revoked. */
const isOpen = (b: Broadcast): boolean => b.life !== "complete" && b.life !== "revoked";

/** RFC 7636 §4.2: the S256 challenge of a verifier. */
const s256 = (verifier: string): string => createHash("sha256").update(verifier).digest("base64url");

const badTitle = (t: unknown): boolean =>
  typeof t !== "string" || t.trim() === "" || Array.from(t).length > BROADCAST_TITLE_MAX_CHARS || /[<>]/.test(t);

export class FakeYouTube implements YouTubePort {
  readonly mode = "fake" as const;
  /** Every port call, by NAME and time. Never an argument: a token, a key and a title are all arguments. */
  readonly calls: { method: string; at: Date }[] = [];

  private readonly now: () => Date;
  /** The constructor's `channels` (a unit-test fixture every grant sees), or `null`: a fresh channel per grant. Never changes. */
  private readonly fixedChannels: Channel[] | null;
  private live: LiveState = "enabled";
  private liveByChannel = new Map<string, LiveState>();
  private auto = false;
  private autoByChannel = new Map<string, boolean>();
  private seq = 0;
  private streams = new Map<string, Stream>();
  private broadcasts = new Map<string, Broadcast>();
  private grants = new Map<string, Grant>();
  /** access token → who it was minted for, on which channel, and when it dies. */
  private access = new Map<string, { refreshToken: string; channelId: string; expiresAt: number }>();
  private killed = new Set<string>();
  private handleOf = new Map<string, string>();
  private tokenOf = new Map<string, string>();
  private injected = new Map<PortMethod, Injection[]>();
  /** OAuth state → what `authorizeUrl` was asked for. */
  private pending = new Map<string, Pending>();
  private codes = new Map<string, { challenge: string; redirectUri: string; scope: string; channels: Channel[] | null; sub: string | null | undefined; used: boolean }>();

  constructor(o: { channels?: Channel[]; now?: () => Date } = {}) {
    this.fixedChannels = o.channels ? o.channels.map((c) => ({ ...c })) : null;
    this.now = o.now ?? (() => new Date());
  }

  // ─── the control surface (tests and the e2e control route) ──────────────────────────────────────────────────────────

  /** The next call of `method` throws `YouTubeError(code, reason)` — once, before it changes anything. Calls queue in order.
   *  With `scope`, only a call made with that channel's tokens takes it. */
  failNext(method: keyof YouTubePort, code: YoutubeErrorCode, reason?: string, scope?: FakeScope): void {
    // A typo'd method or code would otherwise be a failure that never fires, and the test around it would pass vacuously.
    if (typeof method !== "string" || !Object.hasOwn(PORT_METHODS, method)) throw new Error("failNext: not a method of the YouTube port");
    if (!YOUTUBE_ERROR_CODES.includes(code)) throw new Error("failNext: not a YouTube error code");
    const queue = this.injected.get(method as PortMethod) ?? [];
    queue.push({ code, reason, channelId: scope?.channelId });
    this.injected.set(method as PortMethod, queue);
  }

  /** The refresh token is dead for good: the next `accessToken` is `youtube_reconnect_needed`, and so is every access token
   *  already minted from it. Its broadcasts and streams are untouched. This is also how a test makes a token REVOKED (T14's
   *  end step finding a dead grant); `revoke(refreshToken)` is the same effect through the port. */
  killToken(refreshToken: string): void {
    this.killed.add(refreshToken);
  }

  /** An opaque handle for a refresh token (so an e2e test never sees the token). Stable per token. A handle is only a name: it
   *  makes no grant, so `channelOfHandle` of a token the fake never issued is `invalid_grant`. */
  tokenHandle(refreshToken: string): string {
    let handle = this.handleOf.get(refreshToken);
    if (handle === undefined) {
      handle = `fake-th-${++this.seq}`;
      this.handleOf.set(refreshToken, handle);
      this.tokenOf.set(handle, refreshToken);
    }
    return handle;
  }

  killHandle(handle: string): void {
    this.killToken(this.tokenForHandle(handle));
  }

  /** The channel a handle's token acts on — how a control scopes `failNext`, `setLive` and `setAutoVideo` to one org's channel. */
  channelOfHandle(handle: string): string {
    return this.grantOf(this.tokenForHandle(handle)).channelId;
  }

  /** The channel a refresh token acts on (pinning the token the first time it is seen). */
  channelOf(refreshToken: string): string {
    return this.grantOf(refreshToken).channelId;
  }

  /** Seeds the grant behind a refresh token a test minted ITSELF (it writes the sealed token into its own database, then needs
   *  the fake to know which channel and which Google account it is). The token must have Google's `1//` shape and no grant yet
   *  (an existing grant is never silently replaced). `sub` omitted: the grant derives its own distinct subject; `null`: the
   *  account has none. Several tokens may name the same channel (a reconnect) or the same `sub` (one account, two clubs).
   *  For the health / refresh sweeps (T17): pair it with `renameChannel` and `removeChannel`. */
  seedGrant(a: { refreshToken: string; channelId: string; channelTitle: string; sub?: string | null }): void {
    if (typeof a.refreshToken !== "string" || !a.refreshToken.startsWith(GOOGLE_REFRESH_TOKEN_PREFIX) || a.refreshToken.length <= GOOGLE_REFRESH_TOKEN_PREFIX.length) {
      throw new Error("seedGrant: a refresh token has Google's `1//` shape");
    }
    if (!a.channelId || !a.channelTitle) throw new Error("seedGrant: a channel has an id and a title");
    if (this.grants.has(a.refreshToken)) throw new Error("seedGrant: that refresh token already has a grant");
    this.grants.set(a.refreshToken, this.newGrant([{ id: a.channelId, title: a.channelTitle }], a.sub));
  }

  /** The channel is renamed on YouTube: every grant that lists it sees the new title (`listMyChannels`). An id no grant lists is
   *  refused (`youtube_not_found`), so a typo'd control is not a rename that never happens. */
  renameChannel(channelId: string, title: string): void {
    let found = 0;
    for (const g of this.grants.values()) for (const c of g.channels) if (c.id === channelId) { c.title = title; found++; }
    if (found === 0) throw new YouTubeError("youtube_not_found", "unknownChannel");
  }

  /** The channel is gone from the account (deleted, or the account no longer manages it): it leaves every grant's channel list.
   *  What it already made (streams, broadcasts) is untouched, and a grant left with no channel is the no-channel account
   *  (`youtubeSignupRequired` on its next insert). An id no grant lists is refused (`youtube_not_found`). */
  removeChannel(channelId: string): void {
    let found = 0;
    for (const g of this.grants.values()) {
      const kept = g.channels.filter((c) => c.id !== channelId);
      if (kept.length !== g.channels.length) { g.channels = kept; found++; }
    }
    if (found === 0) throw new YouTubeError("youtube_not_found", "unknownChannel");
  }

  /** `true`: every `bind` leaves its broadcast live at once, as if video had arrived (an e2e server has no ingest to watch).
   *  Without a scope it is the default for every channel; a scoped value wins for that channel. */
  setAutoVideo(on: boolean, scope?: FakeScope): void {
    if (scope) this.autoByChannel.set(scope.channelId, on);
    else this.auto = on;
  }

  /** The channels the ONE grant that OAuth `state` mints will see (the first is the channel its API calls act on). An empty
   *  list is a real answer: a Google account with no channel. Spent by that grant: the next connect gets a fresh channel. The
   *  state must have been through `authorizeUrl` (unknown state: `youtube_not_found`). */
  setChannels(c: Channel[], state: string): void {
    this.pendingOf(state).channels = c.map((x) => ({ ...x }));
  }

  /** The ONE grant that OAuth `state` mints gets the channels AND the Google account (subject) that handle's grant has: how an e2e
   *  RECONNECT lands on the SAME channel (a fresh grant otherwise gets a channel of its own, and the reconnect would be refused
   *  as a different channel) and is the same account. `setGoogleSub` on the same state overrides the subject, in either order. */
  pinChannelsTo(handle: string, state: string): void {
    const p = this.pendingOf(state);
    const source = this.grantOf(this.tokenForHandle(handle));
    p.channels = source.channels.map((c) => ({ ...c }));
    p.accountSub = source.sub;   // the same channel is the same Google account: a reconnect reports the subject the first grant did
  }

  /** Whether live streaming is enabled: the default for every channel, or (with `scope`) for one. */
  setLive(state: LiveState, scope?: FakeScope): void {
    if (scope) this.liveByChannel.set(scope.channelId, state);
    else this.live = state;
  }

  /** The scope the code `issueCode(state)` mints carries (null: exactly the YouTube scope). How a test drives `scope_missing`.
   *  Bound to that state and spent by its first code. */
  setGrantedScope(scope: string | null, state: string): void {
    const p = this.pendingOf(state);
    if (scope === null) delete p.scope;
    else p.scope = scope;
  }

  /** The Google account subject (`googleSub`) the ONE grant that OAuth `state` mints reports: `null` is the real driver's likely
   *  answer for a youtube-only token (tokeninfo may carry no `sub`; google.ts returns null then), so T18's no-sub branch is
   *  reachable here; a string lets a test give two connections the SAME account (an admin of two clubs). Bound to that state and
   *  spent by its first code, like `setChannels` and `setGrantedScope`. A grant nobody set derives its own, distinct from every
   *  other grant's (or, pinned to a handle's channel, shares that grant's). */
  setGoogleSub(sub: string | null, state: string): void {
    this.pendingOf(state).sub = sub;
  }

  /** The redirect URI `authorizeUrl` recorded for OAuth `state` — where the fake authorize hop (T7) sends the browser back, the way
   *  Google sends it to the `redirect_uri` the authorize request carried and to no other. A read: it is no port call, and it spends
   *  nothing. Unknown state (never authorized, or gone with a `reset`): `youtube_not_found` / `unknownState`. */
  redirectUriOf(state: string): string {
    return this.pendingOf(state).redirectUri;
  }

  /** The fake authorize hop's job: Google redirecting back with a code. A single-use code bound to the challenge and redirect
   *  URI the state's `authorizeUrl` recorded. Unknown state -> `youtube_not_found`. `o.scope` beats `setGrantedScope`. The
   *  channels and scope a test bound to the state ride this code and are SPENT: a second code for the state carries none. */
  issueCode(state: string, o: { scope?: string } = {}): string {
    const p = this.pendingOf(state);
    const code = `fake-code-${++this.seq}`;
    this.codes.set(code, {
      challenge: p.challenge, redirectUri: p.redirectUri, scope: o.scope ?? p.scope ?? YOUTUBE_SCOPE, channels: p.channels ?? null,
      sub: p.sub !== undefined ? p.sub : p.accountSub, used: false,
    });
    delete p.channels;
    delete p.scope;
    delete p.sub;
    delete p.accountSub;
    return code;
  }

  /** Back to the state `new FakeYouTube(sameOptions)` has: no streams, broadcasts, grants, handles, codes, injections or call
   *  log; every switch (live, autoVideo) at its default. SERIAL-ONLY (see the header). The id counter is NOT rewound, so an id
   *  from before the reset never names something new. */
  reset(): void {
    this.live = "enabled";
    this.liveByChannel = new Map();
    this.auto = false;
    this.autoByChannel = new Map();
    this.streams = new Map();
    this.broadcasts = new Map();
    this.grants = new Map();
    this.access = new Map();
    this.killed = new Set();
    this.handleOf = new Map();
    this.tokenOf = new Map();
    this.injected = new Map();
    this.pending = new Map();
    this.codes = new Map();
    this.calls.length = 0;
  }

  /** Video arrives on a stream: every broadcast bound to it that is `ready` goes `live` (auto-start). A channel cannot have
   *  more than 10 live, so if they do not all fit the call is refused `youtube_limit_reached` and NOTHING changes. */
  videoOn(streamId: string): void {
    const stream = this.stream(streamId);
    const ready = [...this.broadcasts.values()].filter((b) => b.streamId === streamId && b.life === "ready");
    if (ready.length > MAX_LIVE_PER_CHANNEL - this.liveOn(stream.channelId)) throw new YouTubeError("youtube_limit_reached", "limitExceeded");
    stream.video = true;
    for (const b of ready) this.goLive(b);
  }

  /** Video stops. Auto-stop is OFF, so a live broadcast stays live: only `complete()` ends it. */
  videoOff(streamId: string): void {
    this.stream(streamId).video = false;
  }

  /** The video is deleted on YouTube (Studio, or the 30-day refresh finding it gone): the broadcast is absent from now on. */
  deleteVideo(videoId: string): void {
    if (!this.broadcasts.delete(videoId)) throw new YouTubeError("youtube_not_found", "videoNotFound");
  }

  /** YouTube revoked the broadcast (a policy takedown): life `revoked`, which frees its key and its live slot. T14's end step
   *  maps this life; nothing else in the fake produces it. */
  revokeBroadcast(broadcastId: string): void {
    const b = this.broadcasts.get(broadcastId);
    if (!b) throw new YouTubeError("youtube_not_found", "videoNotFound");
    b.life = "revoked";
  }

  // Counts need no ids (a refused Go live leaves no id to look up). Each takes an optional channel; without one it counts all.
  liveBroadcastCount(channelId?: string): number {
    return this.countBroadcasts(channelId, (b) => b.life === "live");
  }

  /** Broadcasts that exist on YouTube, whatever their life. */
  broadcastsCount(channelId?: string): number {
    return this.countBroadcasts(channelId, () => true);
  }

  /** Broadcasts that exist and are NOT live (created, ready, testing, complete, revoked): after a refused Go live, none of
   *  these may be left behind that the product did not mean to keep. */
  nonLiveBroadcastCount(channelId?: string): number {
    return this.countBroadcasts(channelId, (b) => b.life !== "live");
  }

  streamsCount(channelId?: string): number {
    let n = 0;
    for (const s of this.streams.values()) if (channelId === undefined || s.channelId === channelId) n++;
    return n;
  }

  /** Open broadcasts bound to this stream key — the figure Google's "3 per stream key" counts. */
  boundOpenCount(streamId: string): number {
    let n = 0;
    for (const b of this.broadcasts.values()) if (b.streamId === streamId && isOpen(b)) n++;
    return n;
  }

  /** A broadcast as the fake holds it, with no token needed (a dead token cannot read, and a test still must). `null` when absent. */
  inspectBroadcast(broadcastId: string): BroadcastView | null {
    const b = this.broadcasts.get(broadcastId);
    if (!b) return null;
    return {
      channelId: b.channelId, title: b.title, description: b.description, scheduledStart: b.scheduledStart, privacy: b.privacy,
      madeForKids: b.madeForKids, streamId: b.streamId, life: b.life, actualStartAt: copyOf(b.actualStart), actualEndAt: copyOf(b.actualEnd),
    };
  }

  // ─── the port ───────────────────────────────────────────────────────────────────────────────────────────────────────

  authorizeUrl(a: { state: string; codeChallenge: string; redirectUri: string }): string {
    this.enter("authorizeUrl");
    const url = new URL(FAKE_AUTHORIZE_PATH, new URL(a.redirectUri).origin);
    url.searchParams.set("state", a.state);
    url.searchParams.set("code_challenge", a.codeChallenge);
    url.searchParams.set("redirect_uri", a.redirectUri);
    this.pending.set(a.state, { challenge: a.codeChallenge, redirectUri: a.redirectUri });   // a second authorize of a state starts it over
    return url.toString();
  }

  async exchangeCode(a: { code: string; codeVerifier: string; redirectUri: string }): Promise<{ refreshToken: string; scope: string; googleSub: string | null }> {
    this.enter("exchangeCode");
    // Refusals follow the live driver (google.ts maps Google's token-endpoint errors): an unknown or replayed code, an empty
    // verifier and a verifier whose S256 is not the challenge are `invalid_grant` (reconnect_needed); another redirect URI than the
    // one the code was issued for is `redirect_uri_mismatch`, which is Seazn's own configuration, not the club's to fix
    // (youtube_unavailable / redirectUriMismatch). A refused attempt does not spend the code.
    const issued = this.codes.get(a.code);
    if (!issued || issued.used) throw new YouTubeError("youtube_reconnect_needed", "invalidGrant");
    if (issued.redirectUri !== a.redirectUri) throw new YouTubeError("youtube_unavailable", "redirectUriMismatch");
    if (!a.codeVerifier || s256(a.codeVerifier) !== issued.challenge) throw new YouTubeError("youtube_reconnect_needed", "invalidGrant");
    issued.used = true;
    const refreshToken = `fake-rt-${++this.seq}`;
    const grant = this.newGrant(issued.channels, issued.sub);
    this.grants.set(refreshToken, grant);
    return { refreshToken, scope: issued.scope, googleSub: grant.sub };
  }

  async accessToken(refreshToken: string): Promise<string> {
    this.enter("accessToken", this.grants.get(refreshToken)?.channelId ?? null);
    if (!refreshToken || this.killed.has(refreshToken)) throw new YouTubeError("youtube_reconnect_needed", "invalidGrant");
    const at = `fake-at-${++this.seq}`;   // grantOf below refuses a refresh token the fake never issued, before any access token exists
    this.access.set(at, { refreshToken, channelId: this.grantOf(refreshToken).channelId, expiresAt: this.now().getTime() + ACCESS_TOKEN_LIFETIME_MS });
    return at;
  }

  async listMyChannels(at: string): Promise<Channel[]> {
    this.enter("listMyChannels", this.channelOfAccess(at));
    const who = this.who(at);
    return this.grantOf(who.refreshToken).channels.map((c) => ({ ...c }));
  }

  async liveEnabled(at: string): Promise<LiveState> {
    this.enter("liveEnabled", this.channelOfAccess(at));
    return this.liveStateOf(this.who(at).channelId);
  }

  async insertStream(at: string, a: { title: string }): Promise<{ streamId: string; ingest: { url: string; streamKey: string } }> {
    this.enter("insertStream", this.channelOfAccess(at));
    const who = this.who(at);
    this.requireChannel(who.refreshToken);
    this.requireLiveEnabled(who.channelId);
    const id = `fakestream${this.pad()}`;
    this.streams.set(id, { id, title: a.title, channelId: who.channelId, video: false });
    return { streamId: id, ingest: { url: FAKE_INGEST_URL, streamKey: `fakekey-${this.pad()}` } };
  }

  async deleteStream(at: string, streamId: string): Promise<void> {
    this.enter("deleteStream", this.channelOfAccess(at));
    const who = this.who(at);
    // Another channel's stream is absent to this token: the delete resolves and removes nothing.
    if (this.streams.get(streamId)?.channelId === who.channelId) this.streams.delete(streamId);
  }

  async insertBroadcast(
    at: string,
    a: { title: string; description: string; scheduledStart: Date; privacy: YoutubePrivacy; madeForKids: boolean },
  ): Promise<{ broadcastId: string }> {
    this.enter("insertBroadcast", this.channelOfAccess(at));
    const who = this.who(at);
    // Google answers an invalid title with a 400 that is none of the closed codes, so it is `youtube_unavailable` with its
    // reason token (the same code `mapGoogleError` gives an unrecognised 4xx). Nothing is created. CHECKED BEFORE ELIGIBILITY,
    // as the live driver does (google.ts refuses a bad title before it calls Google at all): a channel-less account or a channel
    // not enabled for live, given a bad title, is told about the title.
    if (badTitle(a.title)) throw new YouTubeError("youtube_unavailable", "invalidTitle");
    this.requireChannel(who.refreshToken);
    this.requireLiveEnabled(who.channelId);
    // 11 characters from [A-Za-z0-9_-]: a real video id's shape, so the replay link and the public embed accept it.
    const id = `fakebc${this.pad()}`;
    this.broadcasts.set(id, {
      id, channelId: who.channelId, title: a.title, description: a.description, scheduledStart: a.scheduledStart, privacy: a.privacy,
      madeForKids: a.madeForKids, streamId: null, life: "created", actualStart: null, actualEnd: null,
    });
    return { broadcastId: id };
  }

  async bind(at: string, broadcastId: string, streamId: string): Promise<void> {
    this.enter("bind", this.channelOfAccess(at));
    const who = this.who(at);
    const b = this.ownBroadcast(who.channelId, broadcastId);
    if (!b) throw new YouTubeError("youtube_not_found", "liveBroadcastNotFound");
    const stream = this.streams.get(streamId);
    if (!stream || stream.channelId !== who.channelId) throw new YouTubeError("youtube_not_found", "liveStreamNotFound");
    if (!isOpen(b)) throw new YouTubeError("youtube_unavailable", "invalidTransition");
    // The 4th open broadcast on a key is refused; a broadcast already on this key is not counted against itself. FAKE-ONLY: Google
    // documents the "3 per stream key" limit on liveBroadcasts.TRANSITION (`sharedIngestionBroadcastsExceedLimit`), not on bind,
    // which has no limit reason (bind page). Plan P2 (at most ONE open broadcast per key, enforced by the per-key uniqueness
    // index) makes this refusal unreachable in the product; it stays as a tripwire for a pool bug that would put a 4th on a key. The live
    // driver has no counterpart, so no driver-vs-fake parity test may claim one.
    if (b.streamId !== streamId && this.boundOpenCount(streamId) >= MAX_OPEN_PER_STREAM_KEY) throw new YouTubeError("youtube_limit_reached", "limitExceeded");
    b.streamId = streamId;
    if (b.life === "created") b.life = "ready";
    // Auto-start: a key that already carries video (or autoVideo) starts it. A channel at its 10 does not start it — the
    // broadcast stays `ready`, as YouTube would leave it — and the bind itself still succeeds.
    if (b.life === "ready" && (stream.video || this.autoOn(stream.channelId)) && this.liveOn(stream.channelId) < MAX_LIVE_PER_CHANNEL) this.goLive(b);
  }

  async broadcastLife(at: string, broadcastId: string): Promise<BroadcastLifeInfo> {
    this.enter("broadcastLife", this.channelOfAccess(at));
    const who = this.who(at);
    const b = this.ownBroadcast(who.channelId, broadcastId);
    // YouTube's `status.madeForKids` is, unless it decides otherwise, what the broadcast was created with (selfDeclaredMadeForKids).
    return b
      ? { life: b.life, actualStartAt: copyOf(b.actualStart), actualEndAt: copyOf(b.actualEnd), madeForKids: b.madeForKids }
      : { life: "absent", actualStartAt: null, actualEndAt: null, madeForKids: null };
  }

  async complete(at: string, broadcastId: string): Promise<void> {
    this.enter("complete", this.channelOfAccess(at));
    const who = this.who(at);
    const b = this.ownBroadcast(who.channelId, broadcastId);
    if (!b) throw new YouTubeError("youtube_not_found", "liveBroadcastNotFound");
    if (b.life === "complete") return;   // redundantTransition: already there
    if (b.life !== "live") throw new YouTubeError("youtube_unavailable", "invalidTransition");
    b.life = "complete";
    b.actualEnd = this.now();
  }

  async deleteBroadcast(at: string, broadcastId: string): Promise<void> {
    this.enter("deleteBroadcast", this.channelOfAccess(at));
    const who = this.who(at);
    // Another channel's broadcast is absent to this token: the delete resolves and removes nothing.
    if (this.ownBroadcast(who.channelId, broadcastId)) this.broadcasts.delete(broadcastId);
  }

  async existingVideos(at: string, ids: readonly string[]): Promise<Set<string>> {
    // Refused or answered BEFORE it counts as a call, like the real driver (which refuses > 50 without calling Google, and answers
    // an empty list with an empty set without calling it either: Google answers an empty `id` with a 400). So `[]` needs no valid
    // token, takes no injected failure and is not logged.
    if (ids.length > MAX_VIDEO_IDS_PER_CALL) throw new RangeError(`existingVideos takes at most ${MAX_VIDEO_IDS_PER_CALL} ids per call`);
    if (ids.length === 0) return new Set();
    this.enter("existingVideos", this.channelOfAccess(at));
    const who = this.who(at);
    return new Set(ids.filter((id) => this.ownBroadcast(who.channelId, id) !== undefined));
  }

  /** Google's revoke kills the user's whole grant to the client, not the one token (…/oauth2/web-server, "Token revocation"): so
   *  here every refresh token of the SAME ACCOUNT dies with it — a grant on the same channel (a reconnect), or one reporting the
   *  same non-null subject (the admin of two clubs). A grant with no subject on another channel is another account and lives.
   *  A reconnect AFTER the revoke is a new grant and works. `killToken` stays per-token. */
  async revoke(refreshToken: string): Promise<void> {
    const grant = this.grants.get(refreshToken);
    this.enter("revoke", grant?.channelId ?? null);
    this.killToken(refreshToken);
    if (!grant) return;
    for (const [other, g] of this.grants) {
      if (g.channelId === grant.channelId || (grant.sub !== null && g.sub === grant.sub)) this.killToken(other);
    }
  }

  // ─── internals ──────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Every port method starts here: the call is logged (name and time), then an injected failure fires, once. A failure scoped
   *  to a channel is taken only by a call made with that channel's tokens (`channelId`; null when the call carries none). */
  private enter(method: PortMethod, channelId: string | null = null): void {
    this.calls.push({ method, at: this.now() });
    const queue = this.injected.get(method);
    if (!queue) return;
    const i = queue.findIndex((e) => e.channelId === undefined || e.channelId === channelId);
    if (i === -1) return;
    const [next] = queue.splice(i, 1);
    throw new YouTubeError(next!.code, next!.reason);
  }

  /** A broadcast goes live (video arrived on its stream): the instant is YouTube's `actualStartTime`. */
  private goLive(b: Broadcast): void {
    b.life = "live";
    b.actualStart = this.now();
  }

  private channelOfAccess(at: string): string | null {
    return this.access.get(at)?.channelId ?? null;
  }

  /** A new grant: the channels its OAuth state pinned, else the constructor's fixture, else ONE fresh channel nobody else shares. */
  private newGrant(pinned: Channel[] | null, sub?: string | null): Grant {
    const given = pinned ?? this.fixedChannels;
    const channels = given ? given.map((c) => ({ ...c })) : [this.freshChannel()];
    // An account with no channel still owns streams while a test drives it: give it a private owner so the cap is its own.
    const channelId = channels[0]?.id ?? `UCnone${this.pad()}`;
    return { channels, channelId, sub: sub === undefined ? fakeSubOf(channelId) : sub };
  }

  /** `UC` + 22 characters, a real channel id's shape. */
  private freshChannel(): Channel {
    const n = ++this.seq;
    return { id: `UCfake${String(n).padStart(18, "0")}`, title: `Fake Channel ${n}` };
  }

  /** The grant behind a refresh token. A token the fake issued has one; a token it never saw is `invalid_grant` unless it has
   *  Google's `1//` shape (a test's own seeded token), which gets a grant on a fresh channel the first time it is used. */
  private grantOf(refreshToken: string): Grant {
    let g = this.grants.get(refreshToken);
    if (!g) {
      if (!refreshToken.startsWith(GOOGLE_REFRESH_TOKEN_PREFIX)) throw new YouTubeError("youtube_reconnect_needed", "invalidGrant");
      g = this.newGrant(null);
      this.grants.set(refreshToken, g);
    }
    return g;
  }

  /** The state `authorizeUrl` recorded, or `youtube_not_found` for one it never saw. */
  private pendingOf(state: string): Pending {
    const p = this.pending.get(state);
    if (!p) throw new YouTubeError("youtube_not_found", "unknownState");
    return p;
  }

  /** A Google account with no YouTube channel cannot create a stream or a broadcast. Google answers an HTTP 401
   *  `youtubeSignupRequired` (errors page: "an unlinked Google Account"); `mapGoogleError` (google.ts) decides that reason BEFORE
   *  its generic 401 -> reconnect rule and answers `youtube_unavailable`, the code this throws (reconnecting cannot help). */
  private requireChannel(refreshToken: string): void {
    if (this.grantOf(refreshToken).channels.length === 0) throw new YouTubeError("youtube_unavailable", "youtubeSignupRequired");
  }

  private tokenForHandle(handle: string): string {
    const token = this.tokenOf.get(handle);
    if (token === undefined) throw new YouTubeError("youtube_not_found", "unknownHandle");
    return token;
  }

  /** The grant behind an access token — or the 401 Google answers a dead, expired or unknown one with. */
  private who(at: string): { refreshToken: string; channelId: string } {
    const a = this.access.get(at);
    if (!a || this.killed.has(a.refreshToken) || this.now().getTime() >= a.expiresAt) throw new YouTubeError("youtube_reconnect_needed", "authError");
    return a;
  }

  private ownBroadcast(channelId: string, broadcastId: string): Broadcast | undefined {
    const b = this.broadcasts.get(broadcastId);
    return b && b.channelId === channelId ? b : undefined;
  }

  private liveStateOf(channelId: string): LiveState {
    return this.liveByChannel.get(channelId) ?? this.live;
  }

  private autoOn(channelId: string): boolean {
    return this.autoByChannel.get(channelId) ?? this.auto;
  }

  private requireLiveEnabled(channelId: string): void {
    const state = this.liveStateOf(channelId);
    if (state === "not_enabled") throw new YouTubeError("youtube_live_not_enabled", "liveStreamingNotEnabled");
    if (state === "blocked") throw new YouTubeError("youtube_live_blocked", "livePermissionBlocked");
  }

  private stream(streamId: string): Stream {
    const s = this.streams.get(streamId);
    if (!s) throw new YouTubeError("youtube_not_found", "liveStreamNotFound");
    return s;
  }

  private countBroadcasts(channelId: string | undefined, pick: (b: Broadcast) => boolean): number {
    let n = 0;
    for (const b of this.broadcasts.values()) if ((channelId === undefined || b.channelId === channelId) && pick(b)) n++;
    return n;
  }

  private liveOn(channelId: string): number {
    return this.countBroadcasts(channelId, (b) => b.life === "live");
  }

  private pad(): string {
    return String(++this.seq).padStart(5, "0");
  }
}

/** Is this the fake? Duck-typed on purpose: Next can bundle this module twice (a route and an instrumentation hook), and the
 *  fake is one instance on globalThis (driver.ts) — so an `instanceof` against one copy of the class could refuse the other
 *  copy's instance, and a control route that refuses its own fake looks exactly like the route being disabled. */
export function isFakeYouTube(p: unknown): p is FakeYouTube {
  return typeof p === "object" && p !== null && (p as { mode?: unknown }).mode === "fake"
    && typeof (p as { killHandle?: unknown }).killHandle === "function" && typeof (p as { videoOn?: unknown }).videoOn === "function";
}
