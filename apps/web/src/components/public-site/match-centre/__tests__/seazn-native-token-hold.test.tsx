// Seazn-hosted video, native-HLS stall (owner report 2026-11-26, stg, desktop Chrome: the live player "stops every min or so").
//
// Chrome answers `canPlayType("application/vnd.apple.mpegurl")` with "maybe", so the controller takes its NATIVE path, where a changed
// address is a re-point of `video.src` (seazn-playback.ts `loadNative`): the playlist reloads and the picture stops. The island re-reads
// the route every 30 s while live (seazn-video-schedule.ts). The route signs from a PER-PROCESS token cache (cf-playback.ts), reused
// while more than SEAZN_TOKEN_REFRESH_BEFORE_SECONDS of its life is left, so ONE process hands every read the same address; but the app
// runs on more than one machine (a cold cache each: a restart, a second Fly machine behind the proxy), and a read that lands on a
// machine that has not minted yet carries a different token for the SAME video. The player must not be re-pointed for that.
//
// What is driven for real: the island (renderIsland, its own poll on fake timers), the route's signer (`signLivePlayback` with the
// fake ingest, so the expiry is the signer's own), the stage's markup (which player, under which key, with which `src`), and the real
// controller (`createPlayback`) on a scripted native element that counts every `src` assignment. The browser's React effects are
// mirrored in `Viewer` (one controller per player key; `setSource` when the address changes), exactly SeaznPlayer's two effects.
// Expected counts come from the constants (TTL, refresh window, poll floor) and from the answers handed in, never from the code under test.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

// hls.js: a recording fake, reached through the controller's own dynamic import. Only what a load before the first play touches.
const hls = vi.hoisted(() => ({
  instances: [] as { loaded: string[]; xhrSetup: ((xhr: { open: (m: string, u: string, a: boolean) => void }, url: string) => void) | undefined }[],
}));
vi.mock("hls.js", () => {
  class FakeHls {
    static Events = { ERROR: "hlsError", MANIFEST_PARSED: "hlsManifestParsed" };
    static isSupported() {
      return true;
    }
    loaded: string[] = [];
    xhrSetup: ((xhr: { open: (m: string, u: string, a: boolean) => void }, url: string) => void) | undefined;
    constructor(config: { xhrSetup?: FakeHls["xhrSetup"] }) {
      this.xhrSetup = config.xhrSetup;
      hls.instances.push(this);
    }
    attachMedia() {}
    loadSource(src: string) {
      this.loaded.push(src);
    }
    on() {}
    destroy() {}
  }
  return { default: FakeHls };
});

import publicEn from "@/dictionaries/en/public.json";
import type { PublicFixtureVideo } from "@/server/api-v1/schemas";
import { SEAZN_LIVE_TOKEN_TTL_SECONDS, SEAZN_TOKEN_REFRESH_BEFORE_SECONDS } from "@/server/relay/config";
import { FakeIngest } from "@/server/relay/fakes";
import { createPlaybackTokenCache, signLivePlayback, signRecordingPlayback, type PlaybackTokenCache } from "@/server/video/cf-playback";
import { renderIsland, walk } from "@/components/__tests__/_hook-harness";
import { ReplayParts, SeaznVideoIsland, SeaznVideoStage } from "../seazn-video-island";
import { SeaznPlayer } from "../seazn-player";
import { seaznVideoLabels } from "../seazn-video-labels";
import { createPlayback, type Playback, type PlaybackFailure } from "../seazn-playback";
import { SEAZN_VIDEO_POLL_FLOOR_MS } from "../seazn-video-schedule";
import type { PlayerFatal } from "../seazn-video-report";

const NOW = Date.parse("2026-11-26T12:00:00.000Z");
const labels = seaznVideoLabels(publicEn);
const HLS_MIME = "application/vnd.apple.mpegurl";
const FLOOR = SEAZN_VIDEO_POLL_FLOOR_MS;
/** When a token minted at t=0 is refresh-due, in ms: its life minus the refresh window (derived from the constants, not typed). */
const DUE_MS = (SEAZN_LIVE_TOKEN_TTL_SECONDS - SEAZN_TOKEN_REFRESH_BEFORE_SECONDS) * 1000;

/** A native-HLS element (Chrome 157): counts every `src` assignment and keeps the viewer's place. */
class FakeNativeVideo {
  assigned: string[] = [];
  currentTime = 0;
  duration = Infinity;
  paused = false;
  ended = false;
  error = null;
  private _src = "";
  get src() {
    return this._src;
  }
  set src(v: string) {
    this._src = v;
    this.assigned.push(v);
  }
  canPlayType: (mime: string) => string = (mime) => (mime === HLS_MIME ? "maybe" : "");
  addEventListener() {}
  removeEventListener() {}
  play = async () => {};
}

/** What the route's page draws for one answer: the player element (its key and `src`), or null where there is none. */
function playerOf(stage: ReactElement): { key: string; src: string } | null {
  const props = stage.props as Parameters<typeof SeaznVideoStage>[0];
  const root = SeaznVideoStage(props);
  let player = walk(root).find((e) => e.type === SeaznPlayer);
  if (!player) {
    const parts = walk(root).find((e) => e.type === ReplayParts);
    if (parts) player = renderIsland(ReplayParts, parts.props as Parameters<typeof ReplayParts>[0]).tree().find((e) => e.type === SeaznPlayer);
  }
  return player ? { key: String(player.key), src: (player.props as { src: string }).src } : null;
}

/** Moves the clock by `ms` one poll floor at a time, running the browser's effects after each step: a page's effects run on EVERY
 *  render, so an answer that came and went inside one big jump would never reach the controller, and the count would be vacuous. */
async function advanceSyncing(ms: number, sync: () => void): Promise<void> {
  let left = ms;
  do {
    const step = Math.min(left, FLOOR);
    await vi.advanceTimersByTimeAsync(step);
    sync();
    left -= step;
  } while (left > 0);
}

/** The browser around the island: one controller per player key (SeaznPlayer's mount effect), a new address handed to it when the
 *  `src` prop changes (its `[src]` effect), and the element going away with its player. */
class Viewer {
  players: { key: string; video: FakeNativeVideo; playback: Playback; failures: PlaybackFailure[] }[] = [];
  private current: { key: string; src: string } | null = null;
  constructor(private island: ReturnType<typeof renderIsland<Parameters<typeof SeaznVideoIsland>[0]>>) {}
  stage = () => this.island.tree()[0]!;
  sync(): void {
    const next = playerOf(this.stage());
    if (next === null) {
      this.current = null;
      return;
    }
    if (this.current === null || this.current.key !== next.key) {
      const video = new FakeNativeVideo();
      const failures: PlaybackFailure[] = [];
      const playback = createPlayback(video as unknown as HTMLVideoElement, { onFatal: (f) => failures.push(f) });
      this.players.push({ key: next.key, video, playback, failures });
      playback.setSource(next.src);
    } else if (this.current.src !== next.src) {
      this.players[this.players.length - 1]!.playback.setSource(next.src);
    }
    this.current = next;
  }
  get last() {
    return this.players[this.players.length - 1]!;
  }
  /** The player gives up on the address it holds: its `onFatal` prop, as the stage wired it. */
  giveUp(): void {
    const props = this.stage().props as { onFatal: (f: PlayerFatal) => void };
    props.onFatal({ address: this.current!.src, source: "live", partNo: null, player: "hls", failure: { reason: "element", hlsType: null, hlsDetails: null, httpStatus: null, mediaCode: 3 } });
  }
  advance = (ms: number): Promise<void> => advanceSyncing(ms, () => this.sync());
}

type Route = { live: boolean; parts?: number[]; uid?: string };
/** The route, as a fetch stub. Every read signs through the REAL signer; `cache` picks the process: one shared (a single machine) or a
 *  new one per read (every read lands on a machine that has not minted: the divergence under test). */
function routeStub(opts: { cache: "shared" | "per-read"; next: () => Route; omitId?: boolean }) {
  const shared = createPlaybackTokenCache();
  const reads: PublicFixtureVideo[] = [];
  const fetchMock = vi.fn(async () => {
    const r = opts.next();
    const deps = { ingest: new FakeIngest(), tokenCache: (opts.cache === "shared" ? shared : createPlaybackTokenCache()) as PlaybackTokenCache };
    const now = new Date();
    const live = r.live ? await signLivePlayback(deps, r.uid ?? "in-1", now) : null;
    if (opts.omitId && live) delete (live as { id?: string }).id;
    const replay = await Promise.all((r.parts ?? []).map(async (n) => ({ partNo: n, player: "hls" as const, ...(await signRecordingPlayback(deps, `rec-${n}`, now)) })));
    const data = { live, replay, session: null } as unknown as PublicFixtureVideo;
    reads.push(data);
    return new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, reads };
}

function mount(props: Partial<Parameters<typeof SeaznVideoIsland>[0]> = {}) {
  const island = renderIsland(SeaznVideoIsland, { fixtureId: "f1", labels, ...props });
  return { island, viewer: new Viewer(island) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("RELAY_DRIVERS", "");
  vi.stubEnv("STREAM_PLAYBACK_HOST", "");
  hls.instances.length = 0;
  // A player's failure report goes out as a beacon (seazn-video-report.ts); without one it would fall back to `fetch` and count as a read.
  vi.stubGlobal("navigator", { sendBeacon: () => true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("native HLS: a read that carries a different token for the same live video does not re-point the element", () => {
  it("PREMISE: the constants leave a token a long life to hold (the refresh point is after many polls), and a poll is shorter than the window", () => {
    expect(Math.floor(DUE_MS / FLOOR), "polls inside one token's life before it is refresh-due").toBeGreaterThanOrEqual(4);
    expect(DUE_MS % FLOOR, "a read lands exactly on the refresh point (the boundary tests below rely on it)").toBe(0);
    expect(FLOOR, "a poll always lands inside the refresh window, so a due token is replaced before it lapses").toBeLessThan(SEAZN_TOKEN_REFRESH_BEFORE_SECONDS * 1000);
  });

  it("EMPTY CASE FIRST: before the first answer no player and no controller exist, and no address was assigned", async () => {
    routeStub({ cache: "per-read", next: () => ({ live: false }) });
    const { island, viewer } = mount();
    viewer.sync();
    expect(viewer.players, "nothing drawn, nothing mounted").toHaveLength(0);
    island.unmount();
  });

  it("FOUR polls inside one token's life, each answered by a machine that minted its own token: ONE assignment (it was four)", async () => {
    const { reads } = routeStub({ cache: "per-read", next: () => ({ live: true }) });
    const { island, viewer } = mount();
    await viewer.advance(0);
    for (let i = 0; i < 3; i++) await viewer.advance(FLOOR);
    expect(reads, "four reads happened").toHaveLength(4);
    expect(new Set(reads.map((r) => r.live!.src)).size, "PREMISE: every answer carried a different address, or the test proves nothing").toBe(4);
    expect(viewer.players, "one player, never rebuilt").toHaveLength(1);
    expect(viewer.last.video.assigned, "the element was pointed once, at the first answer's address").toEqual([reads[0]!.live!.src]);
    expect(viewer.last.failures).toEqual([]);
    island.unmount();
  });

  it("the whole of one token's life up to its refresh point: every poll answers, the element is pointed ONCE", async () => {
    const { reads } = routeStub({ cache: "per-read", next: () => ({ live: true }) });
    const { island, viewer } = mount();
    await viewer.advance(0);
    await viewer.advance(DUE_MS - 1);
    // Reads at 0, FLOOR, 2*FLOOR ... while the clock is before DUE_MS.
    const expectedReads = Math.floor((DUE_MS - 1) / FLOOR) + 1;
    expect(reads, "the polls inside the token's life").toHaveLength(expectedReads);
    expect(viewer.last.video.assigned).toEqual([reads[0]!.live!.src]);
    island.unmount();
  });

  it("at the refresh point the element is re-pointed EXACTLY ONCE, at the answer that arrives then, and not again by the polls after it", async () => {
    const { reads } = routeStub({ cache: "per-read", next: () => ({ live: true }) });
    const { island, viewer } = mount();
    await viewer.advance(0);
    await viewer.advance(DUE_MS - 1);
    const before = reads.length;
    await viewer.advance(1);   // the clock reaches the refresh point: the next read is the first that is due
    expect(reads, "the read at the refresh point").toHaveLength(before + 1);
    expect(viewer.last.video.assigned).toEqual([reads[0]!.live!.src, reads[before]!.live!.src]);
    for (let i = 0; i < 5; i++) await viewer.advance(FLOOR);
    expect(reads, "more polls were answered").toHaveLength(before + 6);
    expect(viewer.last.video.assigned, "the new token is held for ITS life: no further re-point").toEqual([reads[0]!.live!.src, reads[before]!.live!.src]);
    expect(viewer.players, "still one player").toHaveLength(1);
    island.unmount();
  });

  it("CONTRAST: one process (a shared cache) already handed the same address, so a single machine never re-pointed (the report needs a second machine)", async () => {
    const { reads } = routeStub({ cache: "shared", next: () => ({ live: true }) });
    const { island, viewer } = mount();
    await viewer.advance(0);
    for (let i = 0; i < 3; i++) await viewer.advance(FLOOR);
    expect(new Set(reads.map((r) => r.live!.src)).size, "one cache, one token").toBe(1);
    expect(viewer.last.video.assigned).toHaveLength(1);
    island.unmount();
  });

  it("a different video swaps: the live ends and a recording part plays (a new player, pointed at its own address), and a new live after it is a new player too", async () => {
    let step: Route = { live: true };
    const { reads } = routeStub({ cache: "per-read", next: () => step });
    const { island, viewer } = mount();
    await viewer.advance(0);
    await viewer.advance(FLOOR);
    step = { live: false, parts: [1] };
    await viewer.advance(FLOOR);
    step = { live: true, parts: [1] };
    await viewer.advance(FLOOR);
    expect(viewer.players.map((p) => p.key), "live, then the part, then a live again: three players").toEqual([
      `live:${reads[0]!.live!.id}:0`, `1:${reads[2]!.replay[0]!.id}:0`, `live:${reads[3]!.live!.id}:0`,
    ]);
    expect(viewer.players[0]!.video.assigned, "the first live: one address across its two polls").toEqual([reads[0]!.live!.src]);
    expect(viewer.players[1]!.video.assigned).toEqual([reads[2]!.replay[0]!.src]);
    expect(viewer.players[2]!.video.assigned, "the second live is a NEW video: its own address, not the first live's held one").toEqual([reads[3]!.live!.src]);
    island.unmount();
  });

  it("TWO UIDS, NO GAP: a new live session (another input) with no answer between is a different video and re-points on the very next answer", async () => {
    // The token carries the video's identity (cf-playback.ts), so host and path are the same for every live: only the route's own id can tell.
    let uid = "in-1";
    const { reads } = routeStub({ cache: "per-read", next: () => ({ live: true, uid }) });
    const { island, viewer } = mount();
    await viewer.advance(0);
    await viewer.advance(FLOOR);
    uid = "in-2";
    await viewer.advance(FLOOR);
    expect(reads).toHaveLength(3);
    expect(new Set(reads.map((r) => r.live!.id)).size, "PREMISE: two inputs, two identities").toBe(2);
    expect(viewer.players.map((p) => p.key), "the same `live` slot, a different video: a fresh player").toEqual([`live:${reads[0]!.live!.id}:0`, `live:${reads[2]!.live!.id}:0`]);
    expect(viewer.players[0]!.video.assigned, "the first live was held across its second poll").toEqual([reads[0]!.live!.src]);
    expect(viewer.players[1]!.video.assigned, "the new input's own address, at once").toEqual([reads[2]!.live!.src]);
    await viewer.advance(FLOOR);
    expect(viewer.players[1]!.video.assigned, "and the new input is held in its turn").toHaveLength(1);
    island.unmount();
  });

  it("an answer that names no identity is never held (an older route): every changed address is taken", async () => {
    routeStub({ cache: "per-read", omitId: true, next: () => ({ live: true }) });
    const { island, viewer } = mount();
    await viewer.advance(0);
    await viewer.advance(FLOOR);
    expect(viewer.last.video.assigned, "no identity, no hold: both addresses assigned").toHaveLength(2);
    island.unmount();
  });

  it("a recording part is held the same way: four polls, one assignment (the replay of a fixture not yet settled reads at the floor)", async () => {
    const { reads } = routeStub({ cache: "per-read", next: () => ({ live: false, parts: [1] }) });
    const { island, viewer } = mount();
    await viewer.advance(0);
    for (let i = 0; i < 3; i++) await viewer.advance(FLOOR);
    expect(reads).toHaveLength(4);
    expect(new Set(reads.map((r) => r.replay[0]!.src)).size, "PREMISE: four addresses").toBe(4);
    expect(viewer.last.video.assigned).toEqual([reads[0]!.replay[0]!.src]);
    island.unmount();
  });

  it("a rebuild (the player gave up) takes the NEXT answer's address, not the held one: a new player, its first assignment is that answer's", async () => {
    const { reads } = routeStub({ cache: "per-read", next: () => ({ live: true }) });
    const { island, viewer } = mount();
    await viewer.advance(0);
    await viewer.advance(FLOOR);
    const heldAddress = reads[0]!.live!.src;
    viewer.giveUp();
    await viewer.advance(FLOOR);   // the read the player's ask brings forward (never sooner than a floor after the last)
    expect(reads, "the rebuild's read").toHaveLength(3);
    expect(viewer.players.map((p) => p.key), "an epoch later: a fresh player").toEqual([`live:${reads[0]!.live!.id}:0`, `live:${reads[0]!.live!.id}:1`]);
    expect(viewer.players[1]!.video.assigned).toEqual([reads[2]!.live!.src]);
    expect(viewer.players[1]!.video.assigned[0]).not.toBe(heldAddress);
    island.unmount();
  });
});

describe("hls.js path: unchanged (one load, the token swapped per request, only when the island hands a newer one)", () => {
  /** A browser that does not play HLS itself: hls.js loads. */
  class FakeHlsVideo extends FakeNativeVideo {
    override canPlayType = () => "";
  }
  it("polls inside one token's life load the manifest ONCE and keep the first token; at the refresh point the token the requests carry changes, with no second load", async () => {
    const { reads } = routeStub({ cache: "per-read", next: () => ({ live: true }) });
    const island = renderIsland(SeaznVideoIsland, { fixtureId: "f1", labels });
    const video = new FakeHlsVideo();
    let current: string | null = null;
    let playback: Playback | null = null;
    const sync = () => {
      const p = playerOf(island.tree()[0]!);
      if (p === null) return;
      if (playback === null) playback = createPlayback(video as unknown as HTMLVideoElement, { onFatal: () => {} });
      if (current !== p.src) playback.setSource(p.src);
      current = p.src;
    };
    const advance = async (ms: number) => {
      await advanceSyncing(ms, sync);
      await vi.advanceTimersByTimeAsync(0);   // the controller's dynamic import of hls.js settles
    };
    const requestTokenFor = (): string => {
      const opened: string[] = [];
      hls.instances[0]!.xhrSetup!({ open: (_m, u) => void opened.push(u) }, "https://playback.fake.invalid/ignored/video.m3u8");
      return opened[0]!;
    };
    const tokenOf = (src: string) => /^https:\/\/[^/]+\/([^/]+)\//.exec(src)![1]!;
    await advance(0);
    for (let i = 0; i < 3; i++) await advance(FLOOR);
    expect(reads).toHaveLength(4);
    expect(hls.instances, "one hls.js instance").toHaveLength(1);
    expect(hls.instances[0]!.loaded, "one load, of the first answer's manifest").toEqual([reads[0]!.live!.src]);
    expect(tokenOf(requestTokenFor()), "requests still carry the first token").toBe(tokenOf(reads[0]!.live!.src));
    await advance(DUE_MS - 3 * FLOOR);
    const refreshRead = reads[reads.length - 1]!;
    expect(hls.instances[0]!.loaded, "a refresh is never a second load").toHaveLength(1);
    expect(tokenOf(requestTokenFor()), "after the refresh point, requests carry the newer token").toBe(tokenOf(refreshRead.live!.src));
    expect(tokenOf(refreshRead.live!.src)).not.toBe(tokenOf(reads[0]!.live!.src));
    island.unmount();
  });

  it("TWO IDS, NO GAP: a new live is a FRESH player (a new controller and hls.js instance, one load of the new address), never a token swap onto the old video's manifest", async () => {
    let uid = "in-1";
    const { reads } = routeStub({ cache: "per-read", next: () => ({ live: true, uid }) });
    const island = renderIsland(SeaznVideoIsland, { fixtureId: "f1", labels });
    // The browser around the island, for a browser that does not play HLS itself: one controller per player key.
    let key: string | null = null;
    let playback: Playback | null = null;
    let src: string | null = null;
    const sync = () => {
      const p = playerOf(island.tree()[0]!);
      if (p === null) return;
      if (key !== p.key) {
        playback?.dispose();
        playback = createPlayback(new FakeHlsVideo() as unknown as HTMLVideoElement, { onFatal: () => {} });
        key = p.key;
        src = null;
      }
      if (src !== p.src) playback!.setSource(p.src);
      src = p.src;
    };
    const advance = async (ms: number) => {
      await advanceSyncing(ms, sync);
      await vi.advanceTimersByTimeAsync(0);
    };
    await advance(0);
    await advance(FLOOR);
    expect(hls.instances, "one video so far: one instance, one load").toHaveLength(1);
    uid = "in-2";
    await advance(FLOOR);
    expect(reads).toHaveLength(3);
    expect(hls.instances, "the new live is a new instance").toHaveLength(2);
    expect(hls.instances[0]!.loaded, "the old instance loaded its own manifest once and was not pointed at the new video").toEqual([reads[0]!.live!.src]);
    expect(hls.instances[1]!.loaded, "the new instance loads the new address, once").toEqual([reads[2]!.live!.src]);
    island.unmount();
  });
});
