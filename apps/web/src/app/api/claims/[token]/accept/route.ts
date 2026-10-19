import { headers } from "next/headers";
import { createSession, getCurrentUser } from "@/lib/auth";
import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { rateLimit, AUTH_LIMIT } from "@/lib/rate-limit";
import { routes } from "@/lib/routes";
import { isSameOriginRequest } from "@/lib/same-origin";
import { claimByEmailLink, claimPerson, type ResolvedClaim } from "@/server/usecases/person-claims";

type Ctx = { params: Promise<{ token: string }> };

/** Where a claimed player lands — the same place the signed-in tap sends them. */
const LANDING = `${routes.me()}?claimed=1`;

function answer(claim: ResolvedClaim, signedIn: boolean) {
  return {
    person_id: claim.person_id,
    person_name: claim.person_name,
    org_name: claim.org_name,
    signed_in: signedIn,
    redirect: LANDING,
  };
}

/** Accept a claim (PROMPT-53).
 *
 *  Signed in: link persons.user_id to the caller (strict email match, either
 *  secret). Racing accepts are resolved in the usecase — exactly one wins.
 *
 *  Signed OUT: only the secret that went into the invite EMAIL may do this. The
 *  emailed link proves the inbox — a magic link's basis — so the server finds
 *  or creates the account for the invited address, links the person, consumes
 *  the claim and mints the session, all behind one tap (`Claim and sign in`).
 *  It is POST-only on purpose: the page that shows the button only READS, so a
 *  mail scanner or link prefetch can never consume the link, and proxy.ts's
 *  Origin check covers this mutation like every other. The organiser's console
 *  link is not that proof and is refused here as it always was (401). */
export async function POST(req: Request, { params }: Ctx) {
  return handler(async () => {
    const { token } = await params;
    const user = await getCurrentUser();
    if (user) {
      return answer(await claimPerson(token, user.id, user.email), false);
    }

    // This branch mints a session for a caller who has none, so the request must show it came from our
    // own page (proxy.ts only catches a FOREIGN Origin; a missing one passes). Asked before anything is
    // touched or counted, and only here — the signed-in branch above mints nothing.
    if (!isSameOriginRequest(req.headers)) throw new HttpError(403, "Forbidden");

    const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    await rateLimit(`claim-signin:${ip}`, AUTH_LIMIT);

    // The terms acceptance (the button sits under the clickwrap notice) is stamped inside the claim's own
    // transaction, so the session is only minted once everything has committed.
    const { userId, claim } = await claimByEmailLink(token);
    await createSession(userId);
    return answer(claim, true);
  });
}
