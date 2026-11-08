// lib/client-ip.ts - the ONE client-IP reader the per-IP limiters key on (R4 final review S10 M1, S14 m10; re-review N1).
// Every bucket keyed on a client's IP is only as strong as the header it trusts. On this deployment:
//   - seazn.club and stg are served THROUGH Cloudflare to Fly (`server: cloudflare`, `cf-ray`, `via: 1.1 fly.io`). Fly's
//     proxy writes `Fly-Client-IP` (a client cannot set it), and behind Cloudflare that peer is a Cloudflare EDGE, shared by
//     many visitors; the visitor is Cloudflare's `CF-Connecting-IP`.
//   - the `*.fly.dev` origins answer directly, so a client can reach Fly without Cloudflare and write `CF-Connecting-IP` (and
//     the first X-Forwarded-For hop - Fly appends to XFF, it never replaces it) itself.
// So `CF-Connecting-IP` is believed only when Fly's peer is inside Cloudflare's published ranges, the request is not a Worker
// subrequest, and the value is an address; otherwise Fly's peer is the client. With no Fly header at all (local dev, CI) the
// first X-Forwarded-For hop, then X-Real-IP, else "unknown". A CF header with no Fly peer to vouch for it is ignored.
//
// The range check alone is a PARTIAL guard. A Cloudflare Worker's fetch() to the fly.dev origin leaves from Cloudflare's own
// ranges and may set `CF-Connecting-IP` to anything (developers.cloudflare.com/fundamentals/reference/http-headers);
// Cloudflare marks every Worker subrequest with `cf-worker`, which is detected here. And anyone with a Cloudflare zone of
// their own can proxy to the fly.dev origin through Cloudflare's network, so the peer is a genuine edge with no `cf-worker`.
// The close is the ORIGIN STAMP (owner OK 2026-11-07): OUR zone's Transform Rule sets `x-seazn-origin-secret` to a secret that
// web holds as `CF_ORIGIN_SECRET`; with the secret set, `CF-Connecting-IP` is believed only on a request carrying that exact
// stamp, and a missing or wrong one falls back to Fly's peer (never a refusal) and is reported. Unset, nothing changes. The
// ops order - the web release carrying the Sentry scrub live FIRST, then the Cloudflare rule, then the secret - is in the
// README's "Deploy step - client IP behind Cloudflare". Even so, a per-IP limit is a brake, never an authorisation.
import { timingSafeEqual } from "node:crypto";
import { BlockList, isIP } from "node:net";
import * as Sentry from "@sentry/nextjs";
import { log } from "@/server/logger";

/** Cloudflare's published edge ranges: https://www.cloudflare.com/ips-v4 and https://www.cloudflare.com/ips-v6, fetched
 *  2026-11-01. Cloudflare changes them rarely and announces it; refresh both lists together from those two URLs. */
export const CLOUDFLARE_IPV4_RANGES = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18",
  "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
  "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
] as const;
export const CLOUDFLARE_IPV6_RANGES = [
  "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32",
] as const;

// Node's own CIDR matcher (both families; an IPv4-mapped IPv6 address is matched as its IPv4 address).
const CLOUDFLARE = new BlockList();
for (const [ranges, family] of [[CLOUDFLARE_IPV4_RANGES, "ipv4"], [CLOUDFLARE_IPV6_RANGES, "ipv6"]] as const) {
  for (const cidr of ranges) {
    const [net, len] = cidr.split("/");
    CLOUDFLARE.addSubnet(net!, Number(len), family);
  }
}

/** Whether `ip` (an exact address, no spaces or prefix) is one of Cloudflare's edges. Anything that is not an address is not. */
export function isCloudflarePeer(ip: string): boolean {
  const family = isIP(ip);
  return family !== 0 && CLOUDFLARE.check(ip, family === 6 ? "ipv6" : "ipv4");
}

const first = (v: string | null | undefined): string | undefined => v?.trim() || undefined;

/** The header OUR Cloudflare zone's Transform Rule stamps on every request it forwards. Its value is a secret: never logged,
 *  echoed, or put into an error. The name carries `secret` so Sentry's own deny list masks it in the root span's
 *  `http.request.header.*` attributes, and `lib/scrub-score-url.ts` redacts every `x-seazn-origin*` header there and in
 *  `request.headers` as well. Not exported: the reader exports no header name (client-ip-readers.test.ts); the scrub spells
 *  its prefix itself, and client-ip.test.ts drives one name through both. */
const ORIGIN_STAMP_HEADER = "x-seazn-origin-secret";

/** Whether the request came through OUR zone. With `CF_ORIGIN_SECRET` set (read per request), its stamp must equal the secret,
 *  compared in constant time; a stamp of another length is "wrong", never a throw. Unset or empty: not required ("ok"). */
function originStamp(headers: Headers): "ok" | StampMismatch {
  const secret = process.env.CF_ORIGIN_SECRET;
  if (!secret) return "ok";
  const stamp = headers.get(ORIGIN_STAMP_HEADER);
  if (stamp === null) return "absent";
  const sent = Buffer.from(stamp, "utf8");
  const want = Buffer.from(secret, "utf8");
  // timingSafeEqual throws on unequal lengths; the length of a 32+ byte random secret is not worth hiding.
  return sent.length === want.length && timingSafeEqual(sent, want) ? "ok" : "wrong";
}

/** A host name (and port) as a report may carry it; anything else is not echoed. */
const REPORTABLE_HOST = /^[a-z0-9.-]{1,253}(?::\d{1,5})?$/;
/** The request's `Host`, for a report: lower-cased, "none" when missing, "invalid" when it is not a host name. */
function reportedHost(headers: Headers): string {
  const host = headers.get("host")?.trim().toLowerCase();
  if (!host) return "none";
  return REPORTABLE_HOST.test(host) ? host : "invalid";
}

/** The reason code a stamp mismatch is reported under, beside its two non-secret discriminators (the stamp's kind, the host). */
const STAMP_MISMATCH = "origin_stamp_mismatch";
type StampMismatch = "absent" | "wrong";
/** Per KIND: at most one `log.warn` this often, and one Sentry message, per process. Kept apart so a flood of forged
 *  `absent` stamps (another zone's requests, expected noise) never uses up what a real `wrong` (a misconfiguration) needs. */
const STAMP_MISMATCH_WARN_EVERY_MS = 60_000;
const stampMismatchWarnedAt: Partial<Record<StampMismatch, number>> = {};
const stampMismatchSent = new Set<StampMismatch>();

/**
 * A Cloudflare peer named a visitor but did not carry our stamp while the secret is set: the request keys on the EDGE, so a
 * misconfigured rule (another host, a typo, a rotation half done) puts every visitor of that colo in one bucket - sign-in
 * first. Never silent: per kind, a throttled warn and one Sentry warning per process. Neither carries a header value
 * (beyond a sanitised host) or the secret.
 */
function reportStampMismatch(stamp: StampMismatch, headers: Headers): void {
  const now = Date.now();
  const last = stampMismatchWarnedAt[stamp];
  const warnDue = last === undefined || now - last >= STAMP_MISMATCH_WARN_EVERY_MS;
  const sendDue = !stampMismatchSent.has(stamp);
  if (!warnDue && !sendDue) return;
  const host = reportedHost(headers);
  if (warnDue) {
    stampMismatchWarnedAt[stamp] = now;
    log.warn(
      { reason: STAMP_MISMATCH, stamp, host },
      "CF-Connecting-IP not believed: a Cloudflare peer without our zone's origin stamp while CF_ORIGIN_SECRET is set - " +
        "keyed on the Cloudflare edge (README: Deploy step - client IP behind Cloudflare)",
    );
  }
  if (sendDue) {
    stampMismatchSent.add(stamp);
    Sentry.captureMessage(STAMP_MISMATCH, { level: "warning", tags: { stamp, host } });
  }
}

/** Tests only: a fresh process's report state. */
export function __resetOriginStampReportForTests(): void {
  delete stampMismatchWarnedAt.absent;
  delete stampMismatchWarnedAt.wrong;
  stampMismatchSent.clear();
}

/** The client IP a per-IP limiter keys on (see the header for the order and why). */
export function clientIp(headers: Headers): string {
  const fly = first(headers.get("fly-client-ip"));
  if (fly !== undefined) {
    const cf = first(headers.get("cf-connecting-ip"));
    const fromCloudflare = cf !== undefined && isIP(cf) !== 0 && !headers.has("cf-worker") && isCloudflarePeer(fly);
    if (!fromCloudflare) return fly;
    const stamp = originStamp(headers);
    if (stamp === "ok") return cf;
    reportStampMismatch(stamp, headers);
    return fly;
  }
  return first(headers.get("x-forwarded-for")?.split(",")[0]) ?? first(headers.get("x-real-ip")) ?? "unknown";
}
