import { headers } from "next/headers";
import { createSession, getCurrentUser } from "@/lib/auth";
import { handler } from "@/lib/http";
import { stampTermsAcceptance } from "@/lib/legal";
import { rateLimit, AUTH_LIMIT } from "@/lib/rate-limit";
import { routes } from "@/lib/routes";
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
export async function POST(_req: Request, { params }: Ctx) {
  return handler(async () => {
    const { token } = await params;
    const user = await getCurrentUser();
    if (user) {
      return answer(await claimPerson(token, user.id, user.email), false);
    }

    const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    await rateLimit(`claim-signin:${ip}`, AUTH_LIMIT);

    const { userId, claim } = await claimByEmailLink(token);
    await createSession(userId);
    // The button sits under the "By continuing, you agree…" notice — record the
    // acceptance, same as the magic-link and email-invite paths (GDPR spec
    // 2026-07-14). First acceptance wins; a later one never moves it.
    await stampTermsAcceptance(userId);
    return answer(claim, true);
  });
}
