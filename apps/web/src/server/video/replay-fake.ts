// server/video/replay-fake.ts — FakeReplayHost: a deterministic, in-memory ReplayHost (Task 21). It is the replay driver of every
// process that is not talking to a real host: unit tests, `next dev`, and the e2e server. Nothing here touches the network.
//
// What it models, because a later task's code will lean on it:
//   * A fetched video is `processing`. A test moves it with `advance` (-> playable) or `fail` (-> failed), the only two moves
//     the real host makes; any other move throws, so a test cannot drive the fake somewhere the host never goes.
//   * `heights` never exceed 720 and are NOT in order, as the real list is not: the best rendition is the maximum.
//   * `remove` reads the fake's own state, never a status: after it the video reads `absent`, and a second remove says so.
//   * Ids are a counter under a prefix of the fake's own (`fake-video-<8 hex>-1`, …). The prefix is per INSTANCE because a copy's id
//     is unique across the whole replay table (V545's unique index, Task 27b), as Bunny's guids are across the library: every test
//     in a shared database, and a `next dev` restarted against one, makes its own fake, and a bare counter would name the same
//     copy twice. A test that wants a readable id names its own prefix (`{ idPrefix }`).
import { createHash, randomUUID } from "node:crypto";
import { FAKE_REPLAY_EMBED_HOST } from "@/server/relay/config";
import { assertWatchWindow, type ReplayDownload, type ReplayHost, ReplayNotDownloadable, type ReplayVideo } from "./replay-ports";

/** The host the fake's embed URLs sit on (`.invalid` never resolves, so no fake URL can be followed by accident): config.ts's
 *  FAKE_REPLAY_EMBED_HOST, which Task 25's CSP adds to `frame-src` under the fake driver. Re-exported for the fake's callers. */
export { FAKE_REPLAY_EMBED_HOST };
/** The library segment of an embed URL: digits, as the real one is. */
export const FAKE_REPLAY_LIBRARY_ID = "1";
export const FAKE_REPLAY_LENGTH_SECONDS = 120;
/** Unordered on purpose (the real host lists them unordered), and never above the 720 ceiling. */
export const FAKE_REPLAY_HEIGHTS: readonly number[] = [360, 480, 720, 240];
/** The bytes every playable fake video's file holds (`openDownload`). */
export const FAKE_REPLAY_FILE = new TextEncoder().encode("fake replay: not a real mp4");

type Held = "processing" | "playable" | "failed";
interface Stored { collectionId: string; title: string; url: string; state: Held }
/** The transition table: what each test-driven move does from each state. A state a move has no entry for refuses it. */
const MOVES: Record<"advance" | "fail", Partial<Record<Held, Held>>> = {
  advance: { processing: "playable", playable: "playable" },
  fail: { processing: "failed", failed: "failed" },
};

export class FakeReplayHost implements ReplayHost {
  private nextId = 1;
  /** `fake-video-<8 hex>` (this instance's own) unless a test names its own (`{ idPrefix }`): the ids are `<prefix>-1`, `<prefix>-2`, … */
  private readonly idPrefix: string;
  constructor(o: { idPrefix?: string } = {}) {
    this.idPrefix = o.idPrefix ?? `fake-video-${randomUUID().slice(0, 8)}`;
  }
  private readonly collections = new Map<string, string>(); // id -> name
  private readonly videos = new Map<string, Stored>();
  private readonly watched = new Map<string, number>();
  private readonly watchReads: { videoId: string; from: Date; to: Date }[] = [];

  async createCollection(orgId: string): Promise<string> {
    const id = `fake-collection-${this.nextId++}`;
    this.collections.set(id, `org:${orgId}`);
    return id;
  }

  async fetchFromUrl(a: { collectionId: string; title: string; url: string }): Promise<string> {
    const id = `${this.idPrefix}-${this.nextId++}`;
    this.videos.set(id, { collectionId: a.collectionId, title: a.title, url: a.url, state: "processing" });
    return id;
  }

  async video(videoId: string): Promise<ReplayVideo> {
    const v = this.videos.get(videoId);
    if (!v) return { state: "absent", lengthSeconds: null, title: null, heights: [] };
    const playable = v.state === "playable";
    return {
      state: v.state,
      lengthSeconds: playable ? FAKE_REPLAY_LENGTH_SECONDS : null,
      title: v.title,
      heights: playable ? [...FAKE_REPLAY_HEIGHTS] : [],
    };
  }

  async remove(videoId: string): Promise<"deleted" | "absent"> {
    return this.videos.delete(videoId) ? "deleted" : "absent";
  }

  signedEmbed(videoId: string, now: Date, ttlSeconds: number): { src: string; expiresAt: string } {
    const expires = new Date(now.getTime() + ttlSeconds * 1000);
    const epoch = Math.floor(expires.getTime() / 1000);
    // The shape of the real URL: `/embed/<library>/<video>?token=<64 hex>&expires=<epoch seconds>`. The token is a stand-in digest.
    const token = createHash("sha256").update(`${videoId}:${epoch}`).digest("hex");
    return {
      src: `https://${FAKE_REPLAY_EMBED_HOST}/embed/${FAKE_REPLAY_LIBRARY_ID}/${encodeURIComponent(videoId)}?token=${token}&expires=${epoch}`,
      expiresAt: expires.toISOString(),
    };
  }

  async openDownload(videoId: string): Promise<ReplayDownload> {
    const state = this.videos.get(videoId)?.state ?? "absent";
    if (state !== "playable") throw new ReplayNotDownloadable(videoId, `not playable (${state})`);
    return {
      body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(FAKE_REPLAY_FILE.slice()); controller.close(); } }),
      bytes: FAKE_REPLAY_FILE.length,
      fileName: `${videoId}.mp4`,
    };
  }

  // The number a test sets is the answer for any window and any video, removed or not, and every read is logged (`watchWindows`).
  // A window the port refuses (backwards, or not a date) is refused here as the real adapter refuses it (Task 30), and is not
  // logged: no read was made. What the real host answers for a DELETED video is still unmeasured, so the fake does not model it.
  async watchMinutes(videoId: string, from: Date, to: Date): Promise<number> {
    assertWatchWindow(from, to);
    this.watchReads.push({ videoId, from, to });
    return this.watched.get(videoId) ?? 0;
  }

  // ---- the control surface: tests only ------------------------------------------------------------------------------

  /** processing -> playable (a repeat is harmless). Throws on a failed video or an id the fake does not hold. */
  advance(videoId: string): void { this.move(videoId, "advance"); }
  /** processing -> failed (a repeat is harmless). Throws on a playable video or an id the fake does not hold. */
  fail(videoId: string): void { this.move(videoId, "fail"); }
  setWatchMinutes(videoId: string, minutes: number): void { this.watched.set(videoId, minutes); }
  /** The windows `watchMinutes` was asked about for a video, in call order. */
  watchWindows(videoId: string): { from: Date; to: Date }[] {
    return this.watchReads.filter((r) => r.videoId === videoId).map(({ from, to }) => ({ from, to }));
  }
  /** The ids of the videos it holds, sorted. */
  videoIds(): string[] { return [...this.videos.keys()].sort(); }
  collectionName(collectionId: string): string | null { return this.collections.get(collectionId) ?? null; }
  /** The collection a video was fetched into, null for an id it does not hold. */
  collectionOf(videoId: string): string | null { return this.videos.get(videoId)?.collectionId ?? null; }
  /** The source URL a video was fetched from, null for an id it does not hold. */
  sourceOf(videoId: string): string | null { return this.videos.get(videoId)?.url ?? null; }

  private move(videoId: string, move: keyof typeof MOVES): void {
    const v = this.videos.get(videoId);
    if (!v) throw new Error(`the fake holds no video ${videoId}`);
    const next = MOVES[move][v.state];
    if (!next) throw new Error(`a ${v.state} video cannot ${move} (${videoId})`);
    v.state = next;
  }
}
