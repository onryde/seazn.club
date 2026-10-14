import { z } from "zod";
import { sql } from "@/lib/db";
import { createSession, postAuthLanding } from "@/lib/auth";
import { handler } from "@/lib/http";
import { consumeVerificationToken } from "@/lib/verification";
import { rateLimit, AUTH_LIMIT } from "@/lib/rate-limit";
import { headers } from "next/headers";

// `next` is the post-verify redirect the emailed link carries (invite and
// claim signups); postAuthLanding re-validates it via safeNextPath, so an
// unsafe value is ignored rather than refused. Without this key `.strict()`
// 400s every link that carries one. The bound matches signupSchema's, which
// is what put `next` into the link.
const schema = z
  .object({
    token: z.string().min(10),
    next: z.string().max(500).optional(),
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
