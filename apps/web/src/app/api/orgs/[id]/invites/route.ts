import { sql } from "@/lib/db";
import { requireOrgRole } from "@/lib/auth";
import { handler } from "@/lib/http";
import { baseUrl } from "@/lib/oauth";
import { orgInviteEmail } from "@/lib/email";
import { createInvite } from "@/server/usecases/invites";
import { dispatchNow, enqueueEmail, expiryWithin, recipientLocale } from "@/server/email-outbox";
import {
  EDITOR_ROLES,
  createInviteSchema,
  type OrgInvite,
} from "@/lib/types";

/** List invite links for an org (editors only). */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handler(async () => {
    const { id } = await params;
    await requireOrgRole(id, EDITOR_ROLES);
    return sql<OrgInvite[]>`
      select id, org_id, role, email, token, expires_at, max_uses,
             used_count, revoked, created_at
      from org_invites
      where org_id = ${id}
      order by created_at desc`;
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
 *  after commit, and `email_sent` is its outcome. */
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
    if (outboxId === null) return invite;

    // email_sent=false is not an error: the outbox keeps trying (or has given
    // up), and the UI offers the personal link for manual sharing meanwhile.
    const email_sent = (await dispatchNow([outboxId])).get(outboxId) === "sent";
    return { ...invite, email_sent };
  });
}
