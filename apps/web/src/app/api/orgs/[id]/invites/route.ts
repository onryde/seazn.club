import { sql } from "@/lib/db";
import { requireOrgRole } from "@/lib/auth";
import { handler } from "@/lib/http";
import { baseUrl } from "@/lib/oauth";
import { orgInviteEmail } from "@/lib/email";
import { createInvite, inviteForEditor, type StoredInvite } from "@/server/usecases/invites";
import { dispatchNow, enqueueEmail, expiryWithin, recipientLocale } from "@/server/email-outbox";
import { EDITOR_ROLES, createInviteSchema } from "@/lib/types";

/** List invite links for an org (editors only). An email-bound invite is listed WITHOUT its token: the token is the
 *  invitee's one-click sign-in and goes into their email only (`inviteForEditor`). */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handler(async () => {
    const { id } = await params;
    await requireOrgRole(id, EDITOR_ROLES);
    const rows = await sql<StoredInvite[]>`
      select id, org_id, role, email, token, expires_at, max_uses,
             used_count, revoked, created_at
      from org_invites
      where org_id = ${id}
      order by created_at desc`;
    return rows.map(inviteForEditor);
  });
}

/** Create an invite (editors only): a shareable link, or — when `email` is
 *  present — a personal invite emailed to that address.
 *
 *  The email invite goes through the email outbox (kind `org_invite`): the
 *  invite and the row that mails its link are one transaction on the pool, so
 *  a committed invite always has its email queued and a failed one queues
 *  nothing. The row's ref is the invite (each invite is its own single-use
 *  link, so a second invite to the same address is a second email, not a
 *  replacement). The language is the org's default: the invitee may have no
 *  account, and none is looked up by address. The first attempt is made here,
 *  after commit, and `email_sent` is its outcome. The answer is `inviteForEditor` of the invite: an email invite's
 *  token is in the email and NOT in this answer. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handler(async () => {
    const { id } = await params;
    const { user } = await requireOrgRole(id, EDITOR_ROLES);
    const input = createInviteSchema.parse(await req.json());
    const { invite, outboxId } = await sql.begin(async (tx) => {
      const invite = await createInvite(id, user.id, input, tx);
      if (!invite.email) return { invite, outboxId: null };
      const [org] = await tx<{ name: string; default_locale: string | null }[]>`
        select name, default_locale from organizations where id = ${id}`;
      const locale = await recipientLocale(tx, { pick: null, userId: null, orgDefault: org!.default_locale });
      const outboxId = await enqueueEmail(tx, {
        kind: "org_invite",
        refType: "org_invite",
        refId: invite.id,
        orgId: id,
        to: invite.email,
        transactional: false,
        expiresAt: expiryWithin(invite.expires_at === null ? null : new Date(invite.expires_at)),
        ...(await orgInviteEmail({ orgName: org!.name, link: `${baseUrl(req)}/join/${invite.token}` }, locale)),
      });
      return { invite, outboxId };
    });
    if (outboxId === null) return inviteForEditor(invite);

    // email_sent=false is not an error: the outbox keeps trying (or has given
    // up). The personal link is NOT offered for manual sharing meanwhile: it
    // would sign a stranger in as the invitee. The UI says the mail may be late
    // and points at revoking it and sharing an invite link instead.
    const email_sent = (await dispatchNow([outboxId])).get(outboxId) === "sent";
    return { ...inviteForEditor(invite), email_sent };
  });
}
