// The ONE streaming-destination validator (Streaming R1, A18 — G2, OWNER
// 2026-09-28). A stream target's ingest url is the address the relay's ffmpeg
// DIALS OUT to, so whatever host it names, the relay connects to: an unchecked
// value reaches localhost, the Fly private network (`*.internal`,
// `*.flycast`) and cloud metadata (169.254.169.254). The rule: the scheme is
// rtmp/rtmps, the host is on the list below, and the port is the scheme's
// default (no listed provider publishes another).
//
// Validate what is used: the host's RAW bytes must be ASCII letters, digits,
// dots and hyphens BEFORE anything is case-folded — `toLowerCase()` maps U+212A
// KELVIN SIGN to ASCII "k", so a fold-then-check admitted `faceboo<U+212A>.com`
// while the raw string was what got sealed and dialled (re-review m1). And the
// URL the caller stores is `checkDestination`'s canonical output (host
// lower-cased, every other byte as given), never the raw input — so the bytes
// sealed and dialled are exactly the bytes this file accepted.
//
// Zero imports on purpose: the settings panel (a client component) can call
// it before it sends, and scripts/openapi-gen.ts imports it under bare
// `node --experimental-strip-types` (so: no enums, no `@/` aliases).
//
// Why a hand parser and not `new URL()`: rtmp/rtmps are NOT WHATWG "special"
// schemes, so `new URL("rtmp://…")` yields an opaque host — no lower-casing,
// no IPv4 normalisation — and ffmpeg resolves the host with getaddrinfo, which
// reads `2130706433`, `0x7f.1` and `127.1` as 127.0.0.1. So the authority is
// taken up to the FIRST "/" (ffmpeg stops earlier, at "?" or "#", but any of
// those left inside the authority fails the hostname check below, so the two
// splits can never disagree on an accepted URL) and every piece is checked
// against a strict shape.

/** The stable error code the POST stream-targets route answers 422 with. */
export const DESTINATION_NOT_ALLOWED = "DESTINATION_NOT_ALLOWED";

/** Which rule refused — the `rule` on the 422. Never the URL itself: an
 *  ingest URL can carry the stream key in its path. */
export const DESTINATION_REFUSALS = ["scheme", "userinfo", "ip_literal", "host", "port", "path"] as const;
export type DestinationRefusal = (typeof DESTINATION_REFUSALS)[number];

export type DestinationHost = {
  readonly provider: string;
  /** `exact`: the host equals `host`. `suffix`: `host` starts with a dot and
   *  the host ends with it — dot-anchored, so `evil` + apex never matches, and
   *  the bare apex is refused too. */
  readonly match: "exact" | "suffix";
  readonly host: string;
};

/**
 * THE allowlist — A18's providers, less LinkedIn (see the note at the end of
 * the list). Each entry cites where
 * the provider publishes the host (read 2026-09-28). "OBS services" is OBS
 * Studio's bundled encoder list, plugins/rtmp-services/data/services.json —
 * the entries each platform maintains for the "Service" dropdown. Adding a
 * host is a product decision: the entry, its source, and the pinned count in
 * stream-destinations.test.ts move together.
 */
export const STREAM_DESTINATION_HOSTS: readonly DestinationHost[] = [
  // YouTube — primary + backup, RTMP and RTMPS. OBS services "YouTube - RTMPS":
  // rtmps://a.rtmps.youtube.com:443/live2, rtmps://b.rtmps.youtube.com:443/live2?backup=1,
  // rtmp://a.rtmp.youtube.com/live2, rtmp://b.rtmp.youtube.com/live2?backup=1.
  // RTMPS on port 443: "Delivering Live YouTube Content via RTMPS",
  // developers.google.com/youtube/v3/live/guides/rtmps-ingestion.
  { provider: "youtube", match: "exact", host: "a.rtmp.youtube.com" },
  { provider: "youtube", match: "exact", host: "b.rtmp.youtube.com" },
  { provider: "youtube", match: "exact", host: "a.rtmps.youtube.com" },
  { provider: "youtube", match: "exact", host: "b.rtmps.youtube.com" },
  // Facebook — Live Video API, developers.facebook.com/docs/live-video-api:
  // rtmps://live-api-s.facebook.com:443/rtmp/. OBS services "Facebook Live":
  // rtmps://rtmp-api.facebook.com:443/rtmp/.
  { provider: "facebook", match: "exact", host: "live-api-s.facebook.com" },
  { provider: "facebook", match: "exact", host: "rtmp-api.facebook.com" },
  // Twitch — Twitch's ingest list, ingest.twitch.tv/ingests: regional
  // rtmp(s)://<site>.contribute.live-video.net/app/{stream_key} (e.g. euw30), and
  // the global auto-ingest ingest.global-contribute.live-video.net, which sits
  // under the Amazon IVS global suffix of the Kick entry below. OBS services
  // "Twitch" still ships the older rtmp://live-<site>.twitch.tv/app (46 servers).
  { provider: "twitch", match: "suffix", host: ".contribute.live-video.net" },
  { provider: "twitch", match: "suffix", host: ".twitch.tv" },
  // Kick — Amazon IVS. Kick Help Center "How to stream on KICK.com",
  // help.kick.com/en/articles/7066931: rtmps://fa723fc1b171.global-contribute.live-video.net:443/app
  // (the leftmost label varies per account).
  { provider: "kick", match: "suffix", host: ".global-contribute.live-video.net" },
  // Vimeo — Vimeo Help Center "Recommended network configuration for live
  // events" (help.vimeo.com, article 12426939452817): rtmp-global.cloud.vimeo.com
  // and rtmp.cloud.vimeo.com on 443 (RTMPS) / 1935 (RTMP). OBS services "Vimeo":
  // rtmp://rtmp.cloud.vimeo.com/live.
  { provider: "vimeo", match: "exact", host: "rtmp-global.cloud.vimeo.com" },
  { provider: "vimeo", match: "exact", host: "rtmp.cloud.vimeo.com" },
  // Restream — Restream's public server list, api.restream.io/v2/server/all
  // (developers.restream.io/public-api/servers): 19 servers, every one
  // rtmp://<name>.restream.io/live (live = autodetect, london, frankfurt, …).
  { provider: "restream", match: "suffix", host: ".restream.io" },
  // Cloudflare Stream — "Start a live stream",
  // developers.cloudflare.com/stream/stream-live/start-stream-live: rtmps://live.cloudflare.com:443/live/.
  { provider: "cloudflare_stream", match: "exact", host: "live.cloudflare.com" },
  // LinkedIn — DELIBERATELY ABSENT in R1 (orchestrator ruling, Task 9 fix
  // round 2, 2026-09-28). The only ingest we could source is the one "Live
  // Events APIs" (learn.microsoft.com/linkedin/consumer/integrations/live-video,
  // updated 2023-12-20) hands out: Azure Media Services'
  // <id>.channel.media.azure.net on ports 1935/1936 (rtmp) and 2935/2936 (rtmps).
  // AMS was retired in 2024-06, and `media.azure.net` has been NXDOMAIN since
  // (checked 2026-09-28), so no real LinkedIn host could match that entry.
  // Re-add LinkedIn only from a real, current LinkedIn Live custom-stream URL,
  // with its extra ports bound PER SCHEME (re-review m2).
];

/** D6 (owner 2026-09-30): the platforms a NEW destination may name. Stored rows of other kinds keep listing and
 *  streaming until removed (spec §5.4), so the host allowlist above is NOT narrowed. A tuple, not an enum: this module
 *  is loaded under bare strip-types by openapi-gen. */
export const STREAM_PLATFORMS = ["youtube", "twitch"] as const;
export type StreamPlatform = (typeof STREAM_PLATFORMS)[number];

/** The ingest address the SERVER fills per platform — the organiser never types one (spec §4 "No server field").
 *  YouTube: rtmp://a.rtmp.youtube.com/live2 — delivered to YouTube on staging 2026-09-30 (spec §5.4); also OBS
 *  services' "YouTube - RTMPS" primary RTMP entry (the allowlist's source above).
 *  Twitch: the "Default" entry (priority 0) of Twitch's ingest list, https://ingest.twitch.tv/ingests (read
 *  2026-09-30): url_template_secure `rtmps://ingest.global-contribute.live-video.net/app/{stream_key}` — Twitch's global
 *  auto-ingest; the key is the output's own field, so the url stops at `/app`. Its host is admitted by the
 *  `.global-contribute.live-video.net` entry above. Each passes `checkDestination` (stream-destinations.test.ts). */
export const STREAM_PLATFORM_PRESETS: Readonly<Record<StreamPlatform, string>> = {
  youtube: "rtmp://a.rtmp.youtube.com/live2",
  twitch: "rtmps://ingest.global-contribute.live-video.net/app",
};

/** The only ports admitted: no listed provider publishes a non-default one. */
const DEFAULT_PORT = { rtmp: 1935, rtmps: 443 } as const;

/** A host's raw bytes: ASCII letters, digits, dots, hyphens — checked BEFORE case-folding. */
const RAW_HOST = /^[A-Za-z0-9.-]+$/;

// One LDH label: letters/digits/hyphen, no leading/trailing hyphen, 1–63.
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function hostMatches(entry: DestinationHost, host: string): boolean {
  return entry.match === "exact" ? host === entry.host : host.endsWith(entry.host);
}

export type DestinationCheck =
  | { readonly ok: true; /** The CANONICAL URL — what the caller seals and the relay dials. */ readonly url: string }
  | { readonly ok: false; readonly rule: DestinationRefusal };

/** An accepted destination in pieces: `checkDestination` and
 *  `destinationIdentity` assemble their two strings from ONE parse. */
type ParsedDestination =
  | { readonly ok: true; readonly scheme: "rtmp" | "rtmps"; readonly host: string; readonly port: number; readonly portPart: string; readonly path: string }
  | { readonly ok: false; readonly rule: DestinationRefusal };

/**
 * The verdict on `url`: either the canonical URL to store — the scheme and
 * path exactly as given, the host lower-cased (ASCII-only by then, so the
 * fold is DNS-neutral), an explicit port kept as given — or the rule that
 * refused it. Pure and total: any string in, one verdict out.
 */
export function checkDestination(url: string): DestinationCheck {
  const p = parseDestination(url);
  if (!p.ok) return p;
  return { ok: true, url: `${p.scheme}://${p.host}${p.portPart}${p.path}` };
}

/**
 * The destination's IDENTITY (A19b, Task 9 re-review round 2): the canonical
 * URL with an explicit scheme-default port DROPPED, or `null` when the URL is
 * refused. `checkDestination` keeps `:443` as given — what is sealed and
 * dialled stays byte-for-byte what the organiser typed — so
 * `rtmps://live-api-s.facebook.com:443/rtmp/` and `…facebook.com/rtmp/` are
 * two canonical strings for ONE broadcast slot. This is the ONLY input to the
 * destination fingerprint (server/relay/crypto.ts, V421), so those two cannot
 * become two target rows. A NON-default port would be kept: it names a
 * different listener. Today none is admitted, so every identity is port-less.
 */
export function destinationIdentity(url: string): string | null {
  const p = parseDestination(url);
  if (!p.ok) return null;
  const port = p.port === DEFAULT_PORT[p.scheme] ? "" : p.portPart;
  return `${p.scheme}://${p.host}${port}${p.path}`;
}

function parseDestination(url: string): ParsedDestination {
  const refuse = (rule: DestinationRefusal): ParsedDestination => ({ ok: false, rule });
  const scheme = /^(rtmps?):\/\//.exec(url);
  if (!scheme) return refuse("scheme");
  const rest = url.slice(scheme[0].length);
  const slash = rest.indexOf("/");
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? "" : rest.slice(slash);

  if (authority.includes("@")) return refuse("userinfo");
  if (authority.startsWith("[")) return refuse("ip_literal");

  const colons = authority.split(":").length - 1;
  if (colons > 1) return refuse("host");
  let port: number = DEFAULT_PORT[scheme[1] as "rtmp" | "rtmps"];
  let rawHost = authority;
  let portPart = "";
  if (colons === 1) {
    const at = authority.indexOf(":");
    const digits = authority.slice(at + 1);
    rawHost = authority.slice(0, at);
    if (!/^[1-9][0-9]{0,4}$/.test(digits) || Number(digits) > 65535) return refuse("port");
    port = Number(digits);
    portPart = `:${digits}`;
  }

  // The RAW bytes first: nothing non-ASCII survives to be case-folded into a listed name.
  if (!RAW_HOST.test(rawHost)) return refuse("host");
  const host = rawHost.toLowerCase();
  const labels = host.split(".");
  if (host.length > 253 || !labels.every((l) => LABEL.test(l))) return refuse("host");
  // A numeric (or hex) final label is an IPv4 literal in one of getaddrinfo's
  // spellings — no public suffix is all-digit.
  const last = labels[labels.length - 1]!;
  if (/^[0-9]+$/.test(last) || /^0x[0-9a-f]*$/.test(last)) return refuse("ip_literal");

  if (!STREAM_DESTINATION_HOSTS.some((e) => hostMatches(e, host))) return refuse("host");
  if (port !== DEFAULT_PORT[scheme[1] as "rtmp" | "rtmps"]) return refuse("port");

  if (!/^\/[\x21-\x7e]+$/.test(path)) return refuse("path");
  return { ok: true, scheme: scheme[1] as "rtmp" | "rtmps", host, port, portPart, path };
}

/** `null` when `url` is an ingest URL the relay may dial; otherwise the rule
 *  that refused it. The panel's inline check; the writer uses checkDestination
 *  and stores ITS url. */
export function destinationRefusal(url: string): DestinationRefusal | null {
  const verdict = checkDestination(url);
  return verdict.ok ? null : verdict.rule;
}
