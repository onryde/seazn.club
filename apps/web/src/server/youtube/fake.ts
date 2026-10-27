import "server-only";
// server/youtube/fake.ts — FakeYouTube: a deterministic in-memory YouTube (plan T5, spec §9.1). It implements the whole port,
// refuses the way Google does (the 10 / 3 limits, the live-streaming eligibility errors, an expired or revoked grant), and
// carries a control surface the unit tests and the e2e control route drive (`failNext`, `killToken`, `videoOn`, …). It is the
// driver of every process that is not talking to the real YouTube: unit tests, `next dev`, and the e2e server.
//
// What it models, because a later task's code will lean on it:
//   * A broadcast is `created`, becomes `ready` when bound to a stream, and goes `live` when VIDEO ARRIVES on that stream
//     (`enableAutoStart=true`). Nothing ends it but `complete()` — `enableAutoStop=false`, so `videoOff` leaves it live.
//   * Limits are Google's, typed as their own literals below with the page they come from. The 10 is per CHANNEL.
//   * A token that is killed (or revoked) is dead for good, and so is every access token minted from it; the broadcasts it
//     made keep running, because Google's revoke does not touch a stream already carrying video.
//   * Refresh tokens are whatever string a caller supplies (a connection's sealed token, opened): the fake does not need to
//     have issued it. A string is good until killed.
//   * Errors carry a CODE and at most Google's reason token (port.ts) — never an argument, a token or a key. `calls` records
//     method names and times only.
//
// What it does not model: a daily stream-creation cap (unpublished), access-token expiry (a request mints a fresh one), a
// broadcast belonging to a channel (any valid access token can read any broadcast), and the title's 100-character limit.
import { YOUTUBE_SCOPE, type YoutubePrivacy } from "@/lib/youtube";
import { YOUTUBE_ERROR_CODES, YouTubeError, type BroadcastLife, type YoutubeErrorCode, type YouTubePort } from "./port";

// Google's limits — "10 active streams allowed per channel and 3 active streams per stream key" — are the fake's OWN literals
// (https://support.google.com/youtube/answer/2474026). The tests type them again from the same page rather than import them.
const MAX_LIVE_PER_CHANNEL = 10;
const MAX_OPEN_PER_STREAM_KEY = 3;
/** videos.list takes at most 50 ids per call (https://developers.google.com/youtube/v3/docs/videos/list, `id`). */
const MAX_VIDEO_IDS_PER_CALL = 50;

/** YouTube's real RTMP ingest host, so a pooled key from the fake passes the destination allowlist
 *  (lib/stream-destinations.ts) wherever a later task checks one. The fake never opens a socket to it. */
const FAKE_INGEST_URL = "rtmp://a.rtmp.youtube.com/live2";
/** The fake's one account, constant: nothing in the product keys off a fake's subject, and a constant keeps grants comparable. */
const FAKE_GOOGLE_SUB = "fake-google-sub";
/** `UC` + 22 characters, a real channel id's shape (the public page and the directory validate channel ids by it). */
const DEFAULT_CHANNEL = { id: "UCfakeChannel000000000AA", title: "Fake Channel" } as const;
/** Where the fake authorize hop lives (T7 owns the route); the fake's `authorizeUrl` points at it on the redirect URI's origin. */
const FAKE_AUTHORIZE_PATH = "/api/youtube/connect/fake-authorize";
/** A channel the fake hands a token when none are configured (setChannels([])): a stream still needs an owner for the cap. */
const NO_CHANNEL = "UC-no-channel";

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
interface Stream { id: string; title: string; channelId: string; video: boolean }
interface Broadcast {
  id: string; channelId: string; title: string; description: string; scheduledStart: Date; privacy: YoutubePrivacy;
  madeForKids: boolean; streamId: string | null; life: Exclude<BroadcastLife, "absent">;
}
/** What the inspector shows of a broadcast: everything it was created with, where it is bound and its life. No credential. */
export interface BroadcastView {
  title: string; description: string; scheduledStart: Date; privacy: YoutubePrivacy; madeForKids: boolean; streamId: string | null;
  life: BroadcastLife;
}

/** A broadcast YouTube would still count against a stream key (3 per key) — not finished, not revoked. */
const isOpen = (b: Broadcast): boolean => b.life !== "complete" && b.life !== "revoked";

export class FakeYouTube implements YouTubePort {
  readonly mode = "fake" as const;
  /** Every port call, by NAME and time. Never an argument: a token, a key and a title are all arguments. */
  readonly calls: { method: string; at: Date }[] = [];

  private readonly now: () => Date;
  private channels: Channel[];
  private live: LiveState = "enabled";
  private autoVideo = false;
  private seq = 0;
  private readonly streams = new Map<string, Stream>();
  private readonly broadcasts = new Map<string, Broadcast>();
  /** access token → who it was minted for and on which channel. */
  private readonly access = new Map<string, { refreshToken: string; channelId: string }>();
  private readonly killed = new Set<string>();
  private readonly handleOf = new Map<string, string>();
  private readonly tokenOf = new Map<string, string>();
  private readonly injected = new Map<PortMethod, { code: YoutubeErrorCode; reason?: string }[]>();

  constructor(o: { channels?: Channel[]; now?: () => Date } = {}) {
    this.channels = (o.channels ?? [DEFAULT_CHANNEL]).map((c) => ({ ...c }));
    this.now = o.now ?? (() => new Date());
  }

  // ─── the control surface (tests and the e2e control route) ──────────────────────────────────────────────────────────

  /** The next call of `method` throws `YouTubeError(code, reason)` — once, before it changes anything. Calls queue in order. */
  failNext(method: keyof YouTubePort, code: YoutubeErrorCode, reason?: string): void {
    // A typo'd method or code would otherwise be a failure that never fires, and the test around it would pass vacuously.
    if (typeof method !== "string" || !Object.hasOwn(PORT_METHODS, method)) throw new Error("failNext: not a method of the YouTube port");
    if (!YOUTUBE_ERROR_CODES.includes(code)) throw new Error("failNext: not a YouTube error code");
    const queue = this.injected.get(method as PortMethod) ?? [];
    queue.push({ code, reason });
    this.injected.set(method as PortMethod, queue);
  }

  /** The refresh token is dead for good: the next `accessToken` is `youtube_reconnect_needed`, and so is every access token
   *  already minted from it. Its broadcasts and streams are untouched. */
  killToken(refreshToken: string): void {
    this.killed.add(refreshToken);
  }

  /** An opaque handle for a refresh token (so an e2e test never sees the token). Stable per token. */
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
    const token = this.tokenOf.get(handle);
    if (token === undefined) throw new YouTubeError("youtube_not_found", "unknownHandle");
    this.killToken(token);
  }

  /** `true`: every `bind` leaves its broadcast live at once, as if video had arrived (an e2e server has no ingest to watch). */
  setAutoVideo(on: boolean): void {
    this.autoVideo = on;
  }

  setChannels(c: Channel[]): void {
    this.channels = c.map((x) => ({ ...x }));
  }

  setLive(state: LiveState): void {
    this.live = state;
  }

  /** Video arrives on a stream: every broadcast bound to it that is `ready` goes `live` (auto-start). A channel cannot have
   *  more than 10 live, so if they do not all fit the call is refused `youtube_limit_reached` and NOTHING changes. */
  videoOn(streamId: string): void {
    const stream = this.stream(streamId);
    const ready = [...this.broadcasts.values()].filter((b) => b.streamId === streamId && b.life === "ready");
    if (ready.length > MAX_LIVE_PER_CHANNEL - this.liveOn(stream.channelId)) throw new YouTubeError("youtube_limit_reached", "limitExceeded");
    stream.video = true;
    for (const b of ready) b.life = "live";
  }

  /** Video stops. Auto-stop is OFF, so a live broadcast stays live: only `complete()` ends it. */
  videoOff(streamId: string): void {
    this.stream(streamId).video = false;
  }

  /** The video is deleted on YouTube (Studio, or the 30-day refresh finding it gone): the broadcast is absent from now on. */
  deleteVideo(videoId: string): void {
    if (!this.broadcasts.delete(videoId)) throw new YouTubeError("youtube_not_found", "videoNotFound");
  }

  liveBroadcastCount(): number {
    let n = 0;
    for (const b of this.broadcasts.values()) if (b.life === "live") n++;
    return n;
  }

  streamsCount(): number {
    return this.streams.size;
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
      title: b.title, description: b.description, scheduledStart: b.scheduledStart, privacy: b.privacy, madeForKids: b.madeForKids,
      streamId: b.streamId, life: b.life,
    };
  }

  // ─── the port ───────────────────────────────────────────────────────────────────────────────────────────────────────

  authorizeUrl(a: { state: string; codeChallenge: string; redirectUri: string }): string {
    this.enter("authorizeUrl");
    const url = new URL(FAKE_AUTHORIZE_PATH, new URL(a.redirectUri).origin);
    url.searchParams.set("state", a.state);
    url.searchParams.set("code_challenge", a.codeChallenge);
    url.searchParams.set("redirect_uri", a.redirectUri);
    return url.toString();
  }

  async exchangeCode(a: { code: string; codeVerifier: string; redirectUri: string }): Promise<{ refreshToken: string; scope: string; googleSub: string | null }> {
    this.enter("exchangeCode");
    if (!a.code || !a.codeVerifier) throw new YouTubeError("youtube_reconnect_needed", "invalidGrant");
    return { refreshToken: `fake-rt-${++this.seq}`, scope: YOUTUBE_SCOPE, googleSub: FAKE_GOOGLE_SUB };
  }

  async accessToken(refreshToken: string): Promise<string> {
    this.enter("accessToken");
    if (!refreshToken || this.killed.has(refreshToken)) throw new YouTubeError("youtube_reconnect_needed", "invalidGrant");
    const at = `fake-at-${++this.seq}`;
    this.access.set(at, { refreshToken, channelId: this.channels[0]?.id ?? NO_CHANNEL });
    return at;
  }

  async listMyChannels(at: string): Promise<Channel[]> {
    this.enter("listMyChannels");
    this.who(at);
    return this.channels.map((c) => ({ ...c }));
  }

  async liveEnabled(at: string): Promise<LiveState> {
    this.enter("liveEnabled");
    this.who(at);
    return this.live;
  }

  async insertStream(at: string, a: { title: string }): Promise<{ streamId: string; ingest: { url: string; streamKey: string } }> {
    this.enter("insertStream");
    const who = this.who(at);
    this.requireLiveEnabled();
    const id = `fakestream${this.pad()}`;
    this.streams.set(id, { id, title: a.title, channelId: who.channelId, video: false });
    return { streamId: id, ingest: { url: FAKE_INGEST_URL, streamKey: `fakekey-${this.pad()}` } };
  }

  async deleteStream(at: string, streamId: string): Promise<void> {
    this.enter("deleteStream");
    this.who(at);
    this.streams.delete(streamId);
  }

  async insertBroadcast(
    at: string,
    a: { title: string; description: string; scheduledStart: Date; privacy: YoutubePrivacy; madeForKids: boolean },
  ): Promise<{ broadcastId: string }> {
    this.enter("insertBroadcast");
    const who = this.who(at);
    this.requireLiveEnabled();
    // 11 characters from [A-Za-z0-9_-]: a real video id's shape, so the replay link and the public embed accept it.
    const id = `fakebc${this.pad()}`;
    this.broadcasts.set(id, {
      id, channelId: who.channelId, title: a.title, description: a.description, scheduledStart: a.scheduledStart, privacy: a.privacy,
      madeForKids: a.madeForKids, streamId: null, life: "created",
    });
    return { broadcastId: id };
  }

  async bind(at: string, broadcastId: string, streamId: string): Promise<void> {
    this.enter("bind");
    this.who(at);
    const b = this.broadcasts.get(broadcastId);
    if (!b) throw new YouTubeError("youtube_not_found", "liveBroadcastNotFound");
    const stream = this.streams.get(streamId);
    if (!stream) throw new YouTubeError("youtube_not_found", "liveStreamNotFound");
    if (!isOpen(b)) throw new YouTubeError("youtube_unavailable", "invalidTransition");
    // The 4th open broadcast on a key is refused; a broadcast already on this key is not counted against itself.
    if (b.streamId !== streamId && this.boundOpenCount(streamId) >= MAX_OPEN_PER_STREAM_KEY) throw new YouTubeError("youtube_limit_reached", "limitExceeded");
    b.streamId = streamId;
    if (b.life === "created") b.life = "ready";
    // Auto-start: a key that already carries video (or autoVideo) starts it. A channel at its 10 does not start it — the
    // broadcast stays `ready`, as YouTube would leave it — and the bind itself still succeeds.
    if (b.life === "ready" && (stream.video || this.autoVideo) && this.liveOn(stream.channelId) < MAX_LIVE_PER_CHANNEL) b.life = "live";
  }

  async broadcastLife(at: string, broadcastId: string): Promise<BroadcastLife> {
    this.enter("broadcastLife");
    this.who(at);
    return this.broadcasts.get(broadcastId)?.life ?? "absent";
  }

  async complete(at: string, broadcastId: string): Promise<void> {
    this.enter("complete");
    this.who(at);
    const b = this.broadcasts.get(broadcastId);
    if (!b) throw new YouTubeError("youtube_not_found", "liveBroadcastNotFound");
    if (b.life === "complete") return;   // redundantTransition: already there
    if (b.life !== "live") throw new YouTubeError("youtube_unavailable", "invalidTransition");
    b.life = "complete";
  }

  async deleteBroadcast(at: string, broadcastId: string): Promise<void> {
    this.enter("deleteBroadcast");
    this.who(at);
    this.broadcasts.delete(broadcastId);
  }

  async existingVideos(at: string, ids: readonly string[]): Promise<Set<string>> {
    // Refused BEFORE it counts as a call, like the real driver (which refuses without calling Google).
    if (ids.length > MAX_VIDEO_IDS_PER_CALL) throw new RangeError(`existingVideos takes at most ${MAX_VIDEO_IDS_PER_CALL} ids per call`);
    this.enter("existingVideos");
    this.who(at);
    return new Set(ids.filter((id) => this.broadcasts.has(id)));
  }

  async revoke(refreshToken: string): Promise<void> {
    this.enter("revoke");
    this.killToken(refreshToken);
  }

  // ─── internals ──────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Every port method starts here: the call is logged (name and time), then an injected failure fires, once. */
  private enter(method: PortMethod): void {
    this.calls.push({ method, at: this.now() });
    const next = this.injected.get(method)?.shift();
    if (next) throw new YouTubeError(next.code, next.reason);
  }

  /** The grant behind an access token — or the 401 Google answers a dead or unknown one with. */
  private who(at: string): { refreshToken: string; channelId: string } {
    const grant = this.access.get(at);
    if (!grant || this.killed.has(grant.refreshToken)) throw new YouTubeError("youtube_reconnect_needed", "authError");
    return grant;
  }

  private requireLiveEnabled(): void {
    if (this.live === "not_enabled") throw new YouTubeError("youtube_live_not_enabled", "liveStreamingNotEnabled");
    if (this.live === "blocked") throw new YouTubeError("youtube_live_blocked", "livePermissionBlocked");
  }

  private stream(streamId: string): Stream {
    const s = this.streams.get(streamId);
    if (!s) throw new YouTubeError("youtube_not_found", "liveStreamNotFound");
    return s;
  }

  private liveOn(channelId: string): number {
    let n = 0;
    for (const b of this.broadcasts.values()) if (b.life === "live" && b.channelId === channelId) n++;
    return n;
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
