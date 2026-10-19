import { z } from "zod";
import { NEXT_PATH_MAX_LENGTH } from "@/lib/types";
import { sql } from "@/lib/db";
import { createSession, postAuthLanding } from "@/lib/auth";
import { handler } from "@/lib/http";
import { consumeVerificationToken } from "@/lib/verification";
import { rateLimit, AUTH_LIMIT } from "@/lib/rate-limit";
import { headers } from "next/headers";

// `next` is the post-verify redirect the emailed link carries (a signup from
// the invite, claim, check-in or login page). Without this key `.strict()`
// 400s every link that carries one. Two outcomes, on purpose:
//  - a STRING of up to NEXT_PATH_MAX_LENGTH characters passes here and is re-validated by
//    postAuthLanding's safeNextPath. An unsafe string (an absolute or
//    protocol-relative URL, a backslash authority, `javascript:`) is IGNORED,
//    and the user gets the default landing;
//  - anything else, i.e. a string over that length or a non-string (null,
//    a number, an array, an object), fails this schema with a 400 before the
//    token is read, so the link itself stays usable.
// That bound is NEXT_PATH_MAX_LENGTH, the same constant the sign-in schemas use. Nothing the app sends today puts a
// `next` into a verify link (the password sign-up that did was removed 2026-10-19), but a verification email sent
// before then stays valid for 24 hours and may still carry one, so the key is kept.
const schema = z
  .object({
    token: z.string().min(10),
    next: z.string().max(NEXT_PATH_MAX_LENGTH).optional(),
  })
  .strict();

/** Verify an email token, mark the account verified, and sign the user in. */
export async function POST(req: Request) {
  return handler(async () => {
    const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    await rateLimit(`verify-email:${ip}`, AUTH_LIMIT);

    const { token, next } = schema.parse(await req.json());

    const userId = await consumeVerificationToken(token);
    if (!userId) {
      throw new Error("This verification link is invalid or has expired");
    }

    await sql`update users set email_verified = true where id = ${userId}`;
    await createSession(userId);

    const landing = await postAuthLanding(userId, next);
    return {
      has_org: landing.hasOrg,
      org_id: landing.orgId,
      redirect: landing.redirect,
    };
  });
}
