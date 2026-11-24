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
  /** The heights, in pixels, of the encoded renditions a viewer can play, in no promised order and with no ceiling (the library
   *  encodes up to the source's own height, 1080 included). A caller that wants the best rendition takes the maximum, never the
   *  last item. Empty until encoded. This is NOT the set of files a download can take: `openDownload` finds its own. */
  heights: number[];
}

export interface ReplayDownload {
  body: ReadableStream<Uint8Array>;
  /** The size when the host says it, else null. */
  bytes: number | null;
  fileName: string;
}

/** The host's refusal to hand a video's file over: the video is not playable there (still processing, failed, absent), or it has no
 *  downloadable file yet (an empty file list, or the file's address answering "not found"). A caller that believes the video playable answers "not ready, try again" rather than an error (Task 22 review
 *  m6: a row can read playable while the host is still finishing). Every other failure — a timeout, a refused request — is NOT this. */
export class ReplayNotDownloadable extends Error {
  override readonly name = "ReplayNotDownloadable";
  constructor(readonly videoId: string, readonly why: string) {
    super(`video ${videoId} cannot be downloaded: ${why}`);
  }
}

/** The host did not answer: no response in time, a network fault, a body cut off, or a 429 / 5xx. Retryable: the same call may
 *  work in a moment (Task 27, carrying T26 re-review m1 a). The message is the adapter's own, already redacted. */
export class ReplayHostUnavailable extends Error {
  override readonly name = "ReplayHostUnavailable";
}

/** The host refused OUR credentials (401 / 403): a wrong key or token key, or an address the library does not allow us to fetch
 *  from (its allowed referrers). A configuration fault on our side, not the host's mood: retrying changes nothing, so it is never
 *  answered as "try again" (Task 27, carrying T26 re-review m1 a). */
export class ReplayHostRefused extends Error {
  override readonly name = "ReplayHostRefused";
  /** `credential`: which of ours was refused — the host's API key, or the token (and address) its file delivery checks — so the
   *  line can name the one setting to fix (Task 27 review m3). */
  constructor(readonly status: number, readonly credential: ReplayCredential, message: string) {
    super(message);
  }
}
export type ReplayCredential = "api_key" | "delivery_token";

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
  /** Minutes of the video watched between `from` and `to` (Phase 3). A window `assertWatchWindow` refuses is refused before any
   *  call, by every host. Null: the host holds no such video — never stored, or removed — so nothing about it can be read any more
   *  (Task 31: the host forgets a removed video's watch time with it). Never 0 in its place: a caller adds a number as minutes. */
  watchMinutes(videoId: string, from: Date, to: Date): Promise<number | null>;
}

/** The window a `watchMinutes` read may ask about: two real instants, `from` no later than `to` (Task 30). Every host checks it
 *  first and makes no call for anything else — a backwards window has no honest answer, and the real host reads a date it cannot
 *  parse as "the last 30 days" instead of refusing it, so an invalid date would come back as someone else's month. Equal instants
 *  are a window. A RangeError in our own words, naming the two instants and nothing else. (The parameters are not named after
 *  `watchMinutes`' own: port-boundary.test.ts reads an `export` line that holds the word for the start as an import.) */
export function assertWatchWindow(start: Date, end: Date): void {
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    throw new RangeError("watchMinutes: the window's start or end is not a date");
  }
  if (start.getTime() > end.getTime()) {
    throw new RangeError(`watchMinutes: the window ends (${end.toISOString()}) before it starts (${start.toISOString()})`);
  }
}
