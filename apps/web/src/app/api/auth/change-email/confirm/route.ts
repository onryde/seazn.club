import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { invalidateUser } from "@/lib/auth";

/**
 * Every outcome leaves through here, and the Location is deliberately
 * RELATIVE — `/settings?…`, never an absolute URL.
 *
 * `NextResponse.redirect(new URL(path, req.url))` is the obvious spelling and
 * it is wrong in every deployment whose public origin is not its bind address.
 * `req.url` is the INTERNAL BINDING, not the address the browser is on —
 * `lib/oauth.ts:25-26` already says so ("Behind a reverse proxy (Fly.io),
 * req.url is the internal binding (http://0.0.0.0:3000)"), which is why the
 * OAuth routes go through `baseUrl(req)` instead of `req.url`.
 *
 * The damage is not cosmetic. A standalone server started without HOSTNAME
 * binds 0.0.0.0, so the Location read `http://0.0.0.0:3000/settings?…` while
 * the user was on `http://localhost:3000` — a DIFFERENT ORIGIN. The browser
 * withholds the session cookie across it, `/settings` sees no session, and the
 * confirmation lands on `/login` instead of the account tab. The address change
 * has already committed at that point, so the user is bounced to a login screen
 * by the very link that succeeded.
 *
 * `baseUrl(req)` is NOT the fix here: with no proxy there is no
 * `x-forwarded-host`, so it falls back to `new URL(req.url).origin` and
 * reproduces the same internal binding. A relative Location has no origin to
 * get wrong — the browser resolves it against the URL IT requested — so this
 * is correct behind a proxy, in a container, and on a laptop alike.
 */
function redirectTo(path: string): NextResponse {
  return new NextResponse(null, { status: 307, headers: { location: path } });
}

/**
 * Confirm an email-address change via the token link sent to the new address.
 * Redirects to /settings?tab=account on success or failure.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? "";

  try {
    const [row] = await sql<{
      id: string;
      user_id: string;
      new_email: string;
      expires_at: string;
      confirmed: boolean;
    }[]>`
      select id, user_id, new_email, expires_at, confirmed
      from email_change_requests where token = ${token} limit 1`;

    if (!row) {
      return redirectTo("/settings?tab=account&email_change=invalid");
    }
    if (row.confirmed || new Date(row.expires_at) < new Date()) {
      return redirectTo("/settings?tab=account&email_change=expired");
    }

    // Check the new address is still unclaimed (race protection)
    const [taken] = await sql<{ id: string }[]>`
      select id from users where lower(email) = lower(${row.new_email})
      and id <> ${row.user_id} limit 1`;
    if (taken) {
      await sql`delete from email_change_requests where id = ${row.id}`;
      return redirectTo("/settings?tab=account&email_change=taken");
    }

    await sql.begin(async (tx) => {
      await tx`update users set email = ${row.new_email} where id = ${row.user_id}`;
      await tx`update email_change_requests set confirmed = true where id = ${row.id}`;
    });
    await invalidateUser(row.user_id);

    return redirectTo("/settings?tab=account&email_change=success");
  } catch {
    return redirectTo("/settings?tab=account&email_change=error");
  }
}
