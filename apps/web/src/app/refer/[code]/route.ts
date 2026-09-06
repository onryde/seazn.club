import { REFERRAL_COOKIE, resolveReferralCode } from "@/lib/referral";
import { redirectLocal } from "@/lib/http";

/**
 * Land a shared referral link (SPEC-5 §2). Always redirects to `/start` — a
 * bad/expired code just starts signup with no cookie, never a 404/throw — but
 * a code that resolves also drops the `ref` cookie, which `consumeReferralCookie`
 * reads + consumes at org creation (`createOrgForUser` via its three callers)
 * to stamp `referred_by_org_id`.
 */
export async function GET(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  // RELATIVE, so there is no host to get right. This comment used to say
  // "redirect against the external base URL, not req.url" and it had the
  // diagnosis exactly right — req.url is the internal binding
  // (http://0.0.0.0:3000), which would send a real browser to an unreachable
  // address — but `baseUrl(req)` only escapes that when a proxy actually sets
  // x-forwarded-host or an env override is present. Everywhere else it falls
  // through to `new URL(req.url).origin` and lands back on the binding. This
  // is the one externally-clicked URL in the referral feature, so it is
  // exactly the one that must not depend on that. See redirectLocal.
  const res = redirectLocal("/start");

  const ref = await resolveReferralCode(code);
  if (!ref) return res;

  res.cookies.set(REFERRAL_COOKIE, code, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });
  return res;
}
