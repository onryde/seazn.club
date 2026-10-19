import { sql } from "@/lib/db";
import { requireStaff, logStaffAction } from "@/lib/admin";
import { handler, HttpError } from "@/lib/http";
import { sendVerificationEmail } from "@/lib/email";
import { baseUrl } from "@/lib/oauth";
import { createVerificationToken } from "@/lib/verification";

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

    // Invalidate old tokens, then issue a fresh one through the shared minter (24h, single use).
    await sql`delete from email_verifications where user_id = ${id}`;
    const token = await createVerificationToken(id);

    // The /verify-email PAGE, which mounts the island that POSTs the token to the API route beside it. That route is
    // POST-only, so a link straight at it would answer a click with a 405. This staff action is the only thing that
    // emails a verify link now (the password sign-up that used to is gone).
    const link = `${baseUrl(req)}/verify-email?token=${token}`;
    await sendVerificationEmail(user.email, link);
    await logStaffAction(staff.id, "resend_verification", "user", id);

    return { ok: true };
  });
}
