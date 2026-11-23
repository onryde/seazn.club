// server/video/replay-ports.ts — the seam a replay is stored, played and downloaded through. The application layer (the mover,
// the playback reader, the download route) works against ReplayHost; a vendor adapter and the in-memory fake implement it.
// Nothing here may name a vendor: no adapter import, no vendor field names, no vendor URL. relay/__tests__/port-boundary.test.ts
// reads this file and fails on any of them, so a vendor's vocabulary cannot leak in through a comment either.

/** What a stored video is, in this app's words — never the vendor's own status number.
 *  `processing`: stored, not yet playable. `playable`: a viewer can play it. `failed`: the vendor gave up on it, and it will
 *  never become playable. `absent`: the vendor holds no such video (never stored, or deleted). */
export type ReplayState = "processing" | "playable" | "failed" | "absent";

export interface ReplayVideo {
  state: ReplayState;
  /** Null until the host has read it, and always null when `absent`. */
  lengthSeconds: number | null;
  /** The title the video was stored under. Read only when a webhook names an id no row holds; the host is never searched by it. */
  title: string | null;
  /** The heights, in pixels, of the encoded renditions, in no promised order, never above 720: the host is set to cap its
   *  encodes there. A caller that wants the best rendition takes the maximum, never the last item. Empty until encoded. */
  heights: number[];
}

export interface ReplayDownload {
  body: ReadableStream<Uint8Array>;
  /** The size when the host says it, else null. */
  bytes: number | null;
  fileName: string;
}

/** The host's refusal to hand a video's file over: the video is not playable there (still processing, failed, absent), or it has no
 *  rendition to give. A caller that believes the video playable answers "not ready, try again" rather than an error (Task 22 review
 *  m6: a row can read playable while the host is still finishing). Every other failure — a timeout, a refused request — is NOT this. */
export class ReplayNotDownloadable extends Error {
  override readonly name = "ReplayNotDownloadable";
  constructor(readonly videoId: string, readonly why: string) {
    super(`video ${videoId} cannot be downloaded: ${why}`);
  }
}

export interface ReplayHost {
  /** Make a collection named `org:<orgId>` and answer its id. A second call makes a second collection: the caller stores the
   *  id it was given, and nothing looks a collection up by name. */
  createCollection(orgId: string): Promise<string>;
  /** Have the host fetch `url` into the collection and answer the new video's id, which the host's own answer carries. */
  fetchFromUrl(a: { collectionId: string; title: string; url: string }): Promise<string>;
  video(videoId: string): Promise<ReplayVideo>;
  /** `deleted` when the video was there, `absent` when it was not. After either, `video()` reads `absent`. */
  remove(videoId: string): Promise<"deleted" | "absent">;
  /** A short-lived player URL for the video. Pure: it makes no call and does not check that the video exists. */
  signedEmbed(videoId: string, now: Date, ttlSeconds: number): { src: string; expiresAt: string };
  /** The video's file as a stream, for the server to pass on. Never a URL a browser could keep. A video the host will not hand
   *  over yet throws ReplayNotDownloadable. `signal` is the caller's cancel (the download route's request.signal): when it fires,
   *  before the file starts or while it streams, the host stops sending (Task 26 review m1). */
  openDownload(videoId: string, signal?: AbortSignal): Promise<ReplayDownload>;
  /** Minutes of the video watched between `from` and `to` (Phase 3). */
  watchMinutes(videoId: string, from: Date, to: Date): Promise<number>;
}
