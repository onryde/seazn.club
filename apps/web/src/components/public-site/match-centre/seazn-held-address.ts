// Seazn-hosted video: which signed address the island hands the player when a read brings another one for the video already on screen.
//
// WHY. A browser that plays HLS itself (Safari, iOS, and Chrome since it answers `canPlayType` "maybe") has no request hook, so a
// changed address is a re-point of `video.src` (seazn-playback.ts `loadNative`): the playlist loads again and the picture stops and
// rebuffers. The island reads the route every 30 s while a match is live, and the answers do NOT all carry one address for one video:
// the route signs from a per-process token cache (cf-playback.ts), so the app's second machine, or a restarted one, mints a token of
// its own for the same live input. A read that lands on another machine than the last was a re-point of the player, every 30-60 s
// (owner, 2026-11-26: "the live player stops every min or so"; the hls.js path is immune, it swaps the token inside `xhrSetup`).
//
// THE RULE. The address the player already holds stays for as long as its token is not due for a refresh: while more than
// `SEAZN_TOKEN_REFRESH_BEFORE_SECONDS` of its life is left (the window the server itself stops reusing a token in, cf-playback.ts), a
// later answer's address for the SAME video is the held one. "Same video" is the route's own `id` (a hash of the Cloudflare uid,
// cf-playback.ts `videoIdentity`), equal on both answers, and nothing else: the address cannot say it, because Cloudflare puts the video
// in the token, so every live and every recording on the host shares one host and one path and only the token differs, as it does between
// two mints of ONE video. (A new Go live is another input, another id, and re-points on the very next answer even with no answer between
// it and the old one; a hidden tab, a failed read or one quick poll all leave that gap out.) An answer with no id on either side is never
// held. What still changes the address handed over:
//   - the held token is refresh-due (or its expiry is not a date): the newest answer's address, once, and it is then held in its turn.
//     A native player is re-pointed once per token life, about 55 min, which the controller documents and accepts;
//   - a different video: another id, the live gone and a recording on screen, a different part, a new live after an answer without one
//     (an answer is compared with the one before it only), another host or another path;
//   - a rebuild (the island does not call this on an answer that rebuilds the players, seazn-video-island.tsx).
// Only the `hls` kind is held: an `embed` part is the replay host's frame, which loads its address once and ignores later ones.
//
// Pure: answers and a clock in, an answer out. The poll schedules its next read from the answer SHOWN (this one), not from the raw
// one: the schedule's re-read of a settled recording is timed from the expiry of the token the player holds (seazn-video-poll.ts).
import type { PublicFixtureVideo } from "@/server/api-v1/schemas";
import { SEAZN_TOKEN_REFRESH_BEFORE_SECONDS } from "@/server/relay/config";
import { parseSignedAddress } from "./seazn-signed-address";

interface Signed {
  src: string;
  expiresAt: string;
  id?: string | undefined;
}

/** Is a token that expires at `expiresAt` due for a refresh at `nowMs`: no more than the refresh window left, or no date to count from. */
export function isRefreshDue(expiresAt: string, nowMs: number): boolean {
  const expires = Date.parse(expiresAt);
  return !Number.isFinite(expires) || expires - nowMs <= SEAZN_TOKEN_REFRESH_BEFORE_SECONDS * 1000;
}

/** Is `next` the held address's own video under another token: the route names both with the same identity, and both are signed
 *  addresses on the same host with the same path after the token (a belt on the identity, which is the one that tells videos apart). */
function sameVideoNewToken(held: Signed, next: Signed): boolean {
  if (typeof held.id !== "string" || held.id === "" || held.id !== next.id) return false;
  const a = parseSignedAddress(held.src);
  const b = parseSignedAddress(next.src);
  return a !== null && b !== null && a.origin === b.origin && a.tail === b.tail && a.token !== b.token;
}

/** What to hand the player for `next` when it was holding `held`: `held` while it is the same video and not refresh-due, else `next`. */
function keepHeld<T extends Signed>(held: Signed | null | undefined, next: T, nowMs: number): T {
  if (!held || !sameVideoNewToken(held, next) || isRefreshDue(held.expiresAt, nowMs)) return next;
  return { ...next, src: held.src, expiresAt: held.expiresAt, ...(held.id === undefined ? {} : { id: held.id }) };
}

/** The answer to show: `next`, with each address it carries for a video that `shown` (the answer before it) was already playing
 *  replaced by the held one. `next` itself when nothing is held, so a caller can compare by identity. */
export function holdAddresses(shown: PublicFixtureVideo | null, next: PublicFixtureVideo, nowMs: number): PublicFixtureVideo {
  if (shown === null) return next;
  const live = next.live === null ? null : keepHeld(shown.live, next.live, nowMs);
  let changed = live !== next.live;
  const replay = next.replay.map((part) => {
    if (part.player !== "hls") return part;
    const before = shown.replay.find((p) => p.partNo === part.partNo && p.player === "hls");
    const kept = keepHeld(before, part, nowMs);
    if (kept !== part) changed = true;
    return kept;
  });
  return changed ? { ...next, live, replay } : next;
}
