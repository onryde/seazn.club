import { sql } from "@/lib/db";
import { requireStaff, logStaffAction } from "@/lib/admin";
import { handler, HttpError } from "@/lib/http";
import { verificationEmail } from "@/lib/email";
import { deferred } from "@/lib/deferred";
import { baseUrl } from "@/lib/oauth";
import { VERIFICATION_TTL_MS, createVerificationToken } from "@/lib/verification";
import { dispatchNow, enqueueEmail, expiryWithin, recipientLocale } from "@/server/email-outbox";

/** Resend email verification link on behalf of a user. Support or superadmin. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handler(async () => {
    const { id } = await params;
    const staff = await requireStaff();

    const [user] = await sql<{ id: string; email: string; email_verified: boolean }[]>`
      select id, email, email_verified from users where id = ${id} and deleted_at is null`;
    if (!user) throw new HttpError(404, "User not found");
    if (user.email_verified) throw new HttpError(400, "Email already verified");

    // Invalidate old tokens, issue a fresh one through the shared minter (24h, single use), and queue the email that carries it: one
    // transaction on the pool (account mail has no organisation), so the token and its row are committed together or not at all, and a
    // refused row fails the press with no new token left behind. The row's ref is the account: a second press restates the same
    // document, so its row supersedes the first through the outbox's replace rule, as its token replaced the first token.
    const rowId = await sql.begin(async (tx) => {
      await tx`delete from email_verifications where user_id = ${id}`;
      const token = await createVerificationToken(id, tx);
      // The /verify-email PAGE, which mounts the island that POSTs the token to the API route beside it. That route is
      // POST-only, so a link straight at it would answer a click with a 405. This staff action is the only thing that
      // emails a verify link now (the password sign-up that used to is gone).
      const link = `${baseUrl(req)}/verify-email?token=${token}`;
      return enqueueEmail(tx, {
        kind: "email_verification",
        refType: "user",
        refId: id,
        orgId: null,
        to: user.email,
        transactional: true,
        expiresAt: expiryWithin(new Date(Date.now() + VERIFICATION_TTL_MS)),
        // D4: the account's own language (there is no pick, and no organisation).
        ...(await verificationEmail(link, await recipientLocale(tx, { pick: null, userId: id, orgDefault: null }))),
      });
    });
    await logStaffAction(staff.id, "resend_verification", "user", id);
    // After commit. Deferred: a staff action, and nobody reads the outcome; a failed attempt is the retry worker's to finish.
    deferred(() => dispatchNow([rowId]));

    return { ok: true };
  });
}
