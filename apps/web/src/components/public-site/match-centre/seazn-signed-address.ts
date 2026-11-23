// Seazn-hosted video (Phase 1 Task 15, fix round 1): the shape of a Cloudflare Stream signed address, and the one rewrite the hls.js
// path needs. `cf-playback.ts` builds `https://<host>/<token>/manifest/video.m3u8`: the token is the FIRST path segment, and every
// playlist and segment hls.js asks for afterwards sits under the same host with the token of the manifest it was resolved from. A
// token lapses and the island hands over a fresh one before then; the player must take it without reloading (a `loadSource` of a
// different address detaches and re-attaches the media, which empties the buffer and leaves the element paused), so the controller
// keeps the loaded manifest and swaps the token in at REQUEST time (seazn-playback.ts, hls.js `xhrSetup`). Pure: strings in, strings
// out, and no module import, so it is as safe in a client chunk as the schedule.

/** A signed address split at its token: `origin` is `https://<host>`, `tail` is everything after the token (`/manifest/...`, a query,
 *  a fragment; empty when the address ends at the token). */
export interface SignedAddress {
  origin: string;
  token: string;
  tail: string;
}

const SIGNED = /^(https:\/\/[^/?#]+)\/([^/?#]+)([/?#][\s\S]*)?$/;

/** The address split at its token, or null for anything that is not `https://<host>/<token>...` (an unsigned address, a relative
 *  one, another scheme). */
export function parseSignedAddress(address: string): SignedAddress | null {
  const m = SIGNED.exec(address);
  return m === null ? null : { origin: m[1]!, token: m[2]!, tail: m[3] ?? "" };
}

/** `url` with its token segment replaced by `held.token`: the request hls.js is about to make, under the newest token. A URL that is
 *  not on `held`'s host (or not shaped `https://<host>/<token>...`) comes back unchanged, so nothing but the playback host is touched,
 *  and a URL already under the newest token is returned as it is. Only the FIRST path segment is replaced: the same text further
 *  along (a rendition, a segment name, a query) is left alone. */
export function withToken(url: string, held: Pick<SignedAddress, "origin" | "token">): string {
  const u = parseSignedAddress(url);
  if (u === null || u.origin !== held.origin) return url;
  return `${u.origin}/${held.token}${u.tail}`;
}
