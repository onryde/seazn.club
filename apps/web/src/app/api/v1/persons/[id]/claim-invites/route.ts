import { v1, parseBody, reply } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { CreateClaimInvite } from "@/server/api-v1/schemas";
import {
  createClaimInvite,
  getOpenClaim,
  revokeClaimInvite,
} from "@/server/usecases/person-claims";
import { routes } from "@/lib/routes";
import { baseUrl } from "@/lib/oauth";
import { omit } from "@/lib/omit";
import { dispatchNow } from "@/server/email-outbox";

type Ctx = { params: Promise<{ id: string }> };

/** Invite the person to claim their profile (PROMPT-53). Session editors
 *  only (enforced in the usecase); the claim_url embeds the one-time CONSOLE
 *  secret. The invite EMAIL carries a different secret (`emailSecret`) that
 *  signs the invitee in with one tap — it goes into the mail and nowhere else:
 *  never into this response, never into a log. The mail is queued on the email
 *  outbox in the claim's own transaction (kind `claim_invite`, ref = the
 *  person, to the address as typed), and the first attempt is made here after
 *  commit; the console keeps the copyable link + QR as the fallback. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const { email } = await parseBody(req, CreateClaimInvite);
    const auth = await requireResourceAuth(req, "person", id, "write");
    const invite = await createClaimInvite(
      auth,
      id,
      email.trim().toLowerCase(), // as the officials invite does: accounts are matched case-insensitively later
      { kind: "claim_invite", refType: "person", refId: id, origin: baseUrl(req), to: email },
    );
    // Every field the console must not see is taken out: both secrets (the console one goes out only inside claim_url), the names the
    // mail is written with, and the outbox row.
    const claim = omit(invite, "secret", "emailSecret", "person_name", "org_name", "outboxId");
    const { outboxId } = invite;
    const claim_url = `${baseUrl(req)}${routes.claim(invite.secret)}`;
    // Email is the primary channel (owner decision 2026-07-13); the console
    // shows the first attempt's outcome honestly (the outbox keeps retrying a
    // mail that did not go straight away) and keeps the copyable link.
    const email_sent = outboxId !== null && (await dispatchNow([outboxId])).get(outboxId) === "sent";
    return reply(201, { ...claim, claim_url, email_sent });
  });
}

/** The person's open invite, if any (no secret — it showed once). */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "person", id, "read");
    return getOpenClaim(auth, id);
  });
}

/** Withdraw the open invite (idempotent). */
export async function DELETE(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "person", id, "write");
    return revokeClaimInvite(auth, id);
  });
}
