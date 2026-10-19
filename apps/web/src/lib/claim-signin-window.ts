/**
 * How long the invite EMAIL's claim link keeps its power to SIGN IN (owner decision 2026-10-19).
 *
 * The emailed link is a bearer credential: opening it signs the invitee in (see claimByEmailLink). Claim
 * invites live for 14 days (CLAIM_DAYS), far longer than a magic link's 15 minutes, so the sign-in power is
 * cut to this window, measured from when the email secret was minted (a re-invite mints a new one, so the
 * clock restarts). After it the same link still resolves the claim until the invite itself expires, but it
 * behaves like the organiser's console link: signed out it asks for a normal sign-in, signed in it does the
 * matching-email accept. The server enforces this (claimByEmailLink); the page is not trusted for it.
 *
 * `CLAIM_EMAIL_SIGNIN_HOURS` is DERIVED from it and is what the invite emails print ("signs you in for
 * {hours} hours"), so the copy can never disagree with the rule.
 */
export const CLAIM_EMAIL_SIGNIN_MS = 72 * 60 * 60 * 1000;

export const CLAIM_EMAIL_SIGNIN_HOURS = CLAIM_EMAIL_SIGNIN_MS / (60 * 60 * 1000);

/** Does an email secret minted at `mintedAt` still sign in at `now` (epoch ms)? Open for the half-open
 *  interval [minted, minted + window): at exactly the window it has already fallen back. */
export function emailSigninOpen(mintedAt: Date | string | number, now: number): boolean {
  return now - new Date(mintedAt).getTime() < CLAIM_EMAIL_SIGNIN_MS;
}
