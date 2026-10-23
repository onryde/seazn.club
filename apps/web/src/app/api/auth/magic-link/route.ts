import { handler } from "@/lib/http";
import { safeNextPath } from "@/lib/auth";
import { resolveOrCreateUser } from "@/lib/users";
import { stampTermsAcceptance } from "@/lib/legal";
import { magicLinkEmail } from "@/lib/email";
import { issueLoginLink } from "@/lib/login-link";
import { sql } from "@/lib/db";
import { dispatchNow, enqueueEmail } from "@/server/email-outbox";
import { baseUrl } from "@/lib/oauth";
import { mayExposeDevLink } from "@/lib/dev-links";
import { z } from "zod";
import { NEXT_PATH_MAX_LENGTH } from "@/lib/types";
import { rateLimit, EMAIL_LIMIT } from "@/lib/rate-limit";
import { headers } from "next/headers";

// `next` is the post-login redirect (e.g. /join/{token} invite pages send it);
// it is re-validated by safeNextPath before use.
const schema = z
  .object({
    email: z.string().email().max(120),
    next: z.string().max(NEXT_PATH_MAX_LENGTH).optional(),
  })
  .strict();

/** Email a passwordless sign-in link, creating the account if it's new. The
 *  response is identical whether or not the account already existed. */
export async function POST(req: Request) {
  return handler(async () => {
    const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    await rateLimit(`magic-link:${ip}`, EMAIL_LIMIT);

    const body = schema.parse(await req.json());
    const { email } = body;
    const next = safeNextPath(body.next);

    const userId = await resolveOrCreateUser(email);

    let devLink: string | undefined;
    if (userId) {
      // The submit sat under the "By continuing, you agree…" notice (GDPR
      // spec 2026-07-14) — record acceptance; no-op if already stamped.
      await stampTermsAcceptance(userId);
      const nextQuery = next ? `&next=${encodeURIComponent(next)}` : "";
      // The token and the outbox row that carries it are ONE transaction: committed together or not at all. A request
      // that cannot be queued (no key to seal the body with, an expiry past the bound) leaves no new token behind, and
      // keeps the earlier link the person was already mailed. The row expires with the link, never later.
      const { id, link } = await sql.begin(async (tx) => {
        const { token, expiresAt } = await issueLoginLink(userId, tx);
        const link = `${baseUrl(req)}/magic-link?token=${token}${nextQuery}`;
        const id = await enqueueEmail(tx, {
          kind: "magic_link",
          refType: "user",
          refId: userId,
          orgId: null,
          to: email,
          ...(await magicLinkEmail(email, link)),
          transactional: true,
          expiresAt,
        });
        return { id, link };
      });
      // After commit, in the request, so the link is no slower to arrive than it was: the first attempt is made here,
      // and a failure is the retry worker's to finish. It never throws (a failed attempt leaves the row queued).
      //
      // The send outcome deliberately does NOT decide exposure any more. It used to (`!sent || NODE_ENV !== "production"`),
      // which meant a Resend failure in production returned a live sign-in link for whatever address was posted. See
      // `lib/dev-links.ts` for the whole story.
      await dispatchNow([id]);
      if (mayExposeDevLink()) devLink = link;
    }

    return {
      message: "Check your email — a sign-in link is on its way.",
      ...(devLink ? { login_url: devLink } : {}),
    };
  });
}
