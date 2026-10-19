// Claim a player profile (PROMPT-53): the emailed/QR link lands here. Logged
// in → one-tap confirm. Logged out → depends on WHICH link this is (a claim has
// two secrets, V464):
//   - the one that went into the invite EMAIL proves the inbox, so the page
//     offers "Claim and sign in" (one tap; never on load — mail scanners open
//     links);
//   - the organiser's console link proves nothing about its holder, so it
//     shows the auth card (magic-link) with next back to this page.
// Each dead-end token state gets its own copy — never a vague shared error.
import { getCurrentUser } from "@/lib/auth";
import { HttpError } from "@/lib/errors";
import { maskEmail } from "@/lib/mask-email";
import { resolveClaimToken, type ResolvedTokenClaim } from "@/server/usecases/person-claims";
import { AuthForm } from "@/components/auth-form";
import { NightStage } from "@/components/night-stage";
import { ClaimAccept } from "@/components/claim-accept";
import { ClaimSignIn } from "@/components/claim-sign-in";
import { DictProvider } from "@/components/i18n/dict-provider";
import { getDictionary } from "@/lib/i18n";
import { resolveLocale } from "@/lib/resolve-locale";

const DEAD_ENDS: Record<string, { title: string; body: string }> = {
  CLAIM_INVALID: {
    title: "Link not recognised",
    body: "This claim link is not valid. Check you copied the whole link, or ask the organiser to send a fresh invite.",
  },
  CLAIM_EXPIRED: {
    title: "Invite expired",
    body: "Claim invites work for 14 days. Ask the organiser to send a new one — your profile is still there waiting.",
  },
  CLAIM_REVOKED: {
    title: "Invite withdrawn",
    body: "The organiser withdrew this invite. If that's unexpected, ask them to send a new one.",
  },
  CLAIM_CLAIMED: {
    title: "Already claimed",
    body: "This profile is already linked to an account. If that was you, just log in. If not, contact the organiser.",
  },
};

export default async function ClaimPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const user = await getCurrentUser();

  let claim: ResolvedTokenClaim | null = null;
  let deadEnd: { title: string; body: string } | null = null;
  try {
    claim = await resolveClaimToken(token);
  } catch (err) {
    const code = err instanceof HttpError ? err.code : undefined;
    deadEnd = DEAD_ENDS[code ?? "CLAIM_INVALID"] ?? DEAD_ENDS.CLAIM_INVALID;
  }

  // Only the emailed-link card below is localised (the rest of this page is the
  // long-standing English copy); its provider is scoped to that card alone, so
  // the console-link path renders exactly as it did.
  const locale = await resolveLocale();
  const ui = await getDictionary(locale, "ui");

  return (
    <NightStage maxW="max-w-md">
      {deadEnd || !claim ? (
        <div className="card p-6 text-center">
          <h1 className="text-xl font-bold text-purple-900">{deadEnd?.title}</h1>
          <p className="mt-2 text-sm text-slate-500">{deadEnd?.body}</p>
        </div>
      ) : (
        <>
          <div className="mb-6 text-center">
            <h1 className="app-display text-3xl font-bold tracking-tight text-cream">
              {claim.is_official ? "Claim your officiating profile" : "Claim your profile"}
            </h1>
            {/* Officiating variant (PROMPT-57): same rail, different promise —
                the recipient is a referee, not a player. */}
            {claim.is_official ? (
              <p className="mt-2 text-sm text-cream/70">
                <span className="font-medium text-lime-400">{claim.org_name}</span> set up an
                officiating profile for <span className="font-medium text-lime-400">{claim.person_name}</span>.
                Claiming it shows the matches you&apos;re assigned to, lets you accept or decline,
                set the dates you can&apos;t make, and score from your phone.
              </p>
            ) : (
              <p className="mt-2 text-sm text-cream/70">
                <span className="font-medium text-lime-400">{claim.org_name}</span> set up a
                player profile for <span className="font-medium text-lime-400">{claim.person_name}</span>.
                Claiming it shows your matches in one place, lets you RSVP availability, and puts
                your public visibility in your hands.
              </p>
            )}
          </div>
          {user ? (
            user.email.toLowerCase() === claim.email.toLowerCase() ? (
              <div className="card p-6">
                <p className="mb-3 text-sm text-slate-600">
                  Signed in as <span className="font-medium text-purple-700">{user.display_name}</span>{" "}
                  <span className="text-slate-400">({user.email})</span>
                </p>
                <ClaimAccept token={token} personName={claim.person_name} />
              </div>
            ) : (
              // Strict match (owner decision 2026-07-13): the invited address
              // is the identity check — a forwarded link alone must not move
              // the profile to a different account.
              <div className="card p-6">
                <h2 className="text-base font-bold text-purple-900">Wrong account for this invite</h2>
                <p className="mt-2 text-sm text-slate-600">
                  This invite was sent to{" "}
                  <span className="font-medium text-purple-700">{maskEmail(claim.email)}</span>, but
                  you&apos;re signed in as <span className="font-medium">{maskEmail(user.email)}</span>.
                  Sign out, then sign in with the invited address to claim it. Wrong address
                  on the invite? Ask the organiser to re-send it.
                </p>
              </div>
            )
          ) : claim.via === "email" ? (
            // The link that was emailed to the invited address: opening it IS
            // the proof, so one tap signs in and claims. The island's copy
            // comes from the visitor's locale (this page carries no provider
            // of its own).
            <DictProvider dict={ui} locale={locale}>
              <ClaimSignIn token={token} email={maskEmail(claim.email)} />
            </DictProvider>
          ) : (
            <>
              <p className="mb-4 text-center text-sm text-cream/70">
                Sign in or create an account to claim it — no password needed.
              </p>
              <AuthForm next={`/claim/${token}`} />
            </>
          )}
        </>
      )}
    </NightStage>
  );
}
