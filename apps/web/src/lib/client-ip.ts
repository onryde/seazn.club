// lib/client-ip.ts - the ONE client-IP reader the per-IP limiters key on (R4 final review S10 M1, S14 m10; re-review N1).
// Every bucket keyed on a client's IP is only as strong as the header it trusts. On this deployment:
//   - seazn.club and stg are served THROUGH Cloudflare to Fly (`server: cloudflare`, `cf-ray`, `via: 1.1 fly.io`). Fly's
//     proxy writes `Fly-Client-IP` (a client cannot set it), and behind Cloudflare that peer is a Cloudflare EDGE, shared by
//     many visitors; the visitor is Cloudflare's `CF-Connecting-IP`.
//   - the `*.fly.dev` origins answer directly, so a client can reach Fly without Cloudflare and write `CF-Connecting-IP` (and
//     the first X-Forwarded-For hop - Fly appends to XFF, it never replaces it) itself.
// So `CF-Connecting-IP` is believed only when Fly's peer is inside Cloudflare's published ranges; any other Fly peer is the
// client. With no Fly header at all (local dev, CI) the first X-Forwarded-For hop, then X-Real-IP, else "unknown". A CF header
// with no Fly peer to vouch for it is ignored.
//
// A forged value can only ever move the forger's OWN requests to another bucket; it can never refuse someone else's.
import { BlockList, isIP } from "node:net";

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

/** The client IP a per-IP limiter keys on (see the header for the order and why). */
export function clientIp(headers: Headers): string {
  const fly = first(headers.get("fly-client-ip"));
  if (fly !== undefined) {
    const cf = first(headers.get("cf-connecting-ip"));
    return cf !== undefined && isCloudflarePeer(fly) ? cf : fly;
  }
  return first(headers.get("x-forwarded-for")?.split(",")[0]) ?? first(headers.get("x-real-ip")) ?? "unknown";
}
