// lib/client-ip.ts - the ONE client-IP reader the per-IP limiters key on (R4 final review; S10 M1, S14 m10). Every bucket
// keyed on a client's IP is only as strong as the header it trusts, and on this deployment the origin is reached DIRECTLY
// on Fly: Fly's proxy writes `Fly-Client-IP` (a client cannot set it), while a client CAN write `CF-Connecting-IP` and the
// FIRST X-Forwarded-For hop itself (Fly appends to XFF, it never replaces it). So the order is:
//   Fly-Client-IP, then the first X-Forwarded-For hop, then X-Real-IP, else "unknown";
// and `CF-Connecting-IP` leads only behind the explicit opt-in (TRUST_CF_CONNECTING_IP=1), for an origin that is reachable
// through Cloudflare alone. Default OFF: with the opt-in off, a forged CF header moves no bucket.
//
// A forged value can only ever move the forger's OWN requests to another bucket; it can never refuse someone else's.

/** The opt-in env var: exactly "1" trusts Cloudflare's header first. Set it only once the origin is locked to Cloudflare. */
export const TRUST_CF_CONNECTING_IP_ENV = "TRUST_CF_CONNECTING_IP";

const first = (v: string | null | undefined): string | undefined => v?.trim() || undefined;

/** The client IP a per-IP limiter keys on (see the header for the order and why). */
export function clientIp(headers: Headers): string {
  const cf = process.env[TRUST_CF_CONNECTING_IP_ENV] === "1" ? first(headers.get("cf-connecting-ip")) : undefined;
  return cf
    ?? first(headers.get("fly-client-ip"))
    ?? first(headers.get("x-forwarded-for")?.split(",")[0])
    ?? first(headers.get("x-real-ip"))
    ?? "unknown";
}
