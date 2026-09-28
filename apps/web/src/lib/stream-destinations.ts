// The ONE streaming-destination validator (Streaming R1, A18 — G2, OWNER
// 2026-09-28). A stream target's `rtmpUrl` is the address the relay's ffmpeg
// DIALS OUT to, so whatever host it names, the relay connects to: an unchecked
// value reaches localhost, the Fly private network (`*.internal`,
// `*.flycast`) and cloud metadata (169.254.169.254). The rule: the scheme is
// rtmp/rtmps, the host is on the list below, and the port is the scheme's
// default unless the provider documents another.
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

/** Which rule refused — the `reason` on the 422. Never the URL itself: an
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
  /** Ports the provider DOCUMENTS beyond the scheme default (rtmp 1935, rtmps 443). */
  readonly ports?: readonly number[];
};

/**
 * THE allowlist — the owner's eight providers (A18). Each entry cites where
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
  // LinkedIn — "Live Events APIs", learn.microsoft.com/linkedin/consumer/integrations/live-video
  // (updated 2023-12-20): ingestUrls rtmp://<id>.channel.media.azure.net:1935|1936/live/<id>
  // and rtmps://<id>.channel.media.azure.net:2935|2936/live/<id> — so 1936, 2935
  // and 2936 are documented beyond the scheme defaults.
  { provider: "linkedin", match: "suffix", host: ".channel.media.azure.net", ports: [1936, 2935, 2936] },
  // Restream — Restream's public server list, api.restream.io/v2/server/all
  // (developers.restream.io/public-api/servers): 19 servers, every one
  // rtmp://<name>.restream.io/live (live = autodetect, london, frankfurt, …).
  { provider: "restream", match: "suffix", host: ".restream.io" },
  // Cloudflare Stream — "Start a live stream",
  // developers.cloudflare.com/stream/stream-live/start-stream-live: rtmps://live.cloudflare.com:443/live/.
  { provider: "cloudflare_stream", match: "exact", host: "live.cloudflare.com" },
];

const DEFAULT_PORT = { rtmp: 1935, rtmps: 443 } as const;

// One LDH label: letters/digits/hyphen, no leading/trailing hyphen, 1–63.
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function hostMatches(entry: DestinationHost, host: string): boolean {
  return entry.match === "exact" ? host === entry.host : host.endsWith(entry.host);
}

/**
 * `null` when `url` is an ingest URL the relay may dial; otherwise the rule
 * that refused it. Pure and total — any string in, one verdict out.
 */
export function destinationRefusal(url: string): DestinationRefusal | null {
  const scheme = /^(rtmps?):\/\//.exec(url);
  if (!scheme) return "scheme";
  const rest = url.slice(scheme[0].length);
  const slash = rest.indexOf("/");
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? "" : rest.slice(slash);

  if (authority.includes("@")) return "userinfo";
  if (authority.startsWith("[")) return "ip_literal";

  const colons = authority.split(":").length - 1;
  if (colons > 1) return "host";
  let port: number = DEFAULT_PORT[scheme[1] as "rtmp" | "rtmps"];
  let host = authority;
  if (colons === 1) {
    const at = authority.indexOf(":");
    const digits = authority.slice(at + 1);
    host = authority.slice(0, at);
    if (!/^[1-9][0-9]{0,4}$/.test(digits) || Number(digits) > 65535) return "port";
    port = Number(digits);
  }

  host = host.toLowerCase();
  const labels = host.split(".");
  if (host.length === 0 || host.length > 253 || !labels.every((l) => LABEL.test(l))) return "host";
  // A numeric (or hex) final label is an IPv4 literal in one of getaddrinfo's
  // spellings — no public suffix is all-digit.
  const last = labels[labels.length - 1]!;
  if (/^[0-9]+$/.test(last) || /^0x[0-9a-f]*$/.test(last)) return "ip_literal";

  const entry = STREAM_DESTINATION_HOSTS.find((e) => hostMatches(e, host));
  if (!entry) return "host";
  if (port !== DEFAULT_PORT[scheme[1] as "rtmp" | "rtmps"] && !(entry.ports ?? []).includes(port)) return "port";

  if (!/^\/[\x21-\x7e]+$/.test(path)) return "path";
  return null;
}
