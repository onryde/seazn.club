import { v1, parseBody, reply } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { CreateClaimInvite } from "@/server/api-v1/schemas";
import { inviteOfficial } from "@/server/usecases/officials";
import { routes } from "@/lib/routes";
import { baseUrl } from "@/lib/oauth";
import { dispatchNow } from "@/server/email-outbox";

type Ctx = { params: Promise<{ id: string }> };

/** Invite the official to claim their profile (PROMPT-57). The SHARED
 *  person-claim rail does the work — this route only points it at the
 *  official's person (created on demand) and sends officiating copy.
 *  Session editors only (enforced in the claim usecase); the claim_url
 *  embeds the one-time CONSOLE secret. The invite email carries the separate
 *  `emailSecret`, which signs the official in with one tap and never appears
 *  in this response. The mail is queued on the email outbox in the claim's
 *  own transaction (kind `official_invite`, ref = the official), and the
 *  first attempt is made here after commit; `email_sent` is its outcome, and
 *  the console keeps the copyable link as the fallback. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const { email } = await parseBody(req, CreateClaimInvite);
    const auth = await requireResourceAuth(req, "official", id, "write");
    const { claim, secret, outboxId } = await inviteOfficial(auth, id, email, baseUrl(req));
    const claim_url = `${baseUrl(req)}${routes.claim(secret)}`;
    const email_sent = outboxId !== null && (await dispatchNow([outboxId])).get(outboxId) === "sent";
    return reply(201, { ...claim, claim_url, email_sent });
  });
}
