import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { handler } from "@/lib/http";
import { log } from "@/server/logger";
import { safeNextPath } from "@/lib/auth";
import { resolveOrCreateUser } from "@/lib/users";
import { stampTermsAcceptance } from "@/lib/legal";
import { magicLinkEmail } from "@/lib/email";
import { issueLoginLink } from "@/lib/login-link";
import { sql } from "@/lib/db";
import {
  OutboxExpiryTooLongError,
  OutboxKeyUnavailableError,
  dispatchNow,
  enqueueEmail,
  outboxKeyProblem,
  recipientLocale,
} from "@/server/email-outbox";
import { baseUrl } from "@/lib/oauth";
import { mayExposeDevLink } from "@/lib/dev-links";
import { z } from "zod";
import { NEXT_PATH_MAX_LENGTH } from "@/lib/types";
import { rateLimit, EMAIL_LIMIT } from "@/lib/rate-limit";
import { headers } from "next/headers";

/** The body of any unexpected failure, exactly as `handler()` words it when the thrown value is not an Error
 *  (lib/http.ts). The route builds the same response itself for the two outbox refusals, whose own messages name an
 *  environment variable; the generic-500 cases in route-outbox.test.ts check the two stay equal. */
const GENERIC_SERVER_ERROR = "Server error";

/** The answer to a request the outbox refused. The operator gets the real cause, in the log and in Sentry; the caller, anonymous,
 *  gets the generic answer and never a variable name or a bound. A returned `Response` passes through `handler()` untouched.
 *
 *  What is NOT kept is the token and the email row. A refusal on the catch path comes after the account was resolved and its terms
 *  acceptance stamped (both idempotent, and both would be written by the next successful request anyway), so those persist. */
function refused(err: Error) {
  log.error({ err }, "magic-link: the sign-in email could not be queued; the request was refused and no sign-in token or email row was kept");
  Sentry.captureException(err);
  return NextResponse.json({ ok: false, error: GENERIC_SERVER_ERROR }, { status: 500 });
}

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

    // Is this box able to queue the email at all? Asked BEFORE the account is looked at, so that a box that cannot (no usable
    // outbox key) answers every address the same way. Asked after, a live address would get the generic 500 and an address held
    // by a deleted account the usual 200, and that difference would tell an anonymous caller which addresses have an account.
    // It is also the same rule `enqueueEmail` applies, so nothing is written for a request that is going to be refused.
    const keyProblem = outboxKeyProblem();
    if (keyProblem) return refused(new OutboxKeyUnavailableError(keyProblem));

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
      let queued: { id: string; link: string };
      try {
        queued = await sql.begin(async (tx) => {
          const { token, expiresAt } = await issueLoginLink(userId, tx);
          const link = `${baseUrl(req)}/magic-link?token=${token}${nextQuery}`;
          const id = await enqueueEmail(tx, {
            kind: "magic_link",
            refType: "user",
            refId: userId,
            orgId: null,
            to: email,
            // D4: the account's own language (a brand-new account has none, so it is `en`).
            ...(await magicLinkEmail(email, link, await recipientLocale(tx, { pick: null, userId, orgDefault: null }))),
            transactional: true,
            expiresAt,
          });
          return { id, link };
        });
      } catch (err) {
        // The outbox refused the row (see enqueueEmail): the expiry bound, or a key refusal the pre-check above did not foresee.
        if (err instanceof OutboxKeyUnavailableError || err instanceof OutboxExpiryTooLongError) return refused(err);
        throw err;
      }
      const { id, link } = queued;
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
