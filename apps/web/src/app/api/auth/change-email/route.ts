import crypto from "node:crypto";
import { sql } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { handler, HttpError } from "@/lib/http";
import { changeEmailSchema } from "@/lib/types";
import { emailChangeConfirmationEmail, sendEmailChangeNotice } from "@/lib/email";
import { baseUrl } from "@/lib/oauth";
import {
  EMAIL_CHANGE_SUPERSEDED_REASON,
  cancelQueuedEmails,
  dispatchNow,
  enqueueEmail,
  expiryWithin,
  recipientLocale,
} from "@/server/email-outbox";

/** Request an email-address change. Sends a confirmation link to the new address. */
export async function POST(req: Request) {
  return handler(async () => {
    const user = await requireUser();
    const { new_email } = changeEmailSchema.parse(await req.json());

    if (new_email.toLowerCase() === user.email.toLowerCase()) {
      throw new HttpError(400, "New email is the same as your current email");
    }

    // Reject if new address is already taken by another account
    const [existing] = await sql<{ id: string }[]>`
      select id from users where lower(email) = lower(${new_email}) limit 1`;
    if (existing) throw new HttpError(409, "That email address is already in use");

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 h

    const link = `${baseUrl(req)}/api/auth/change-email/confirm?token=${token}`;

    // One transaction on the pool (account mail has no organisation): the request and the confirmation that carries its token are
    // committed together or not at all, and a refused row fails the request.
    const { confirmId, locale } = await sql.begin(async (tx) => {
      // Invalidate any prior pending requests for this user
      await tx`delete from email_change_requests where user_id = ${user.id} and not confirmed`;

      await tx`
        insert into email_change_requests (user_id, old_email, new_email, token, expires_at)
        values (${user.id}, ${user.email}, ${new_email}, ${token}, ${expiresAt.toISOString()})`;

      // D4: the account's own language (its stored pick, then the account; there is no organisation).
      const locale = await recipientLocale(tx, { pick: user.locale, userId: user.id, orgDefault: null });
      // An older request's confirmation still queued for a retry would reach an address the person has moved on from, carrying a
      // token that no longer exists (phase-3 spec §5). End it BEFORE the new one is queued: the cancel matches by kind and ref, so
      // after the enqueue it would end the new row too. (The replace rule cannot: it pairs rows by recipient, and the address differs.)
      await cancelQueuedEmails(tx, {
        kind: "email_change_confirmation",
        refType: "user",
        refIds: [user.id],
        reason: EMAIL_CHANGE_SUPERSEDED_REASON,
      });
      const confirmId = await enqueueEmail(tx, {
        kind: "email_change_confirmation",
        refType: "user",
        refId: user.id,
        orgId: null,
        to: new_email,
        transactional: true,
        expiresAt: expiryWithin(expiresAt),
        ...(await emailChangeConfirmationEmail(link, locale)),
      });
      return { confirmId, locale };
    });
    // After commit, in the request: the person is waiting for the link. A failed attempt is the retry worker's to finish.
    await dispatchNow([confirmId]);
    await sendEmailChangeNotice(user.email, new_email, locale);

    return { message: "A confirmation link has been sent to your new email address." };
  });
}
