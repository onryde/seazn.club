// The refusals POST /api/funnel/claim names with a machine `code`, shared by the route that throws them and the
// claim card that words them (a client component, so this module imports nothing server-side). The card never prints
// the route's English `error`; it reads one of these and words the answer in the visitor's language.

/** The token names no live draft: never minted, expired, or already claimed. Nothing happened and nobody was signed in. */
export const FUNNEL_CLAIM_INVALID = "FUNNEL_CLAIM_INVALID";

/** The visitor IS signed in (the session cookie was set) but building the drafted event failed part-way: the event may
 *  be partly built and the token is spent, so the way forward is their dashboard, not a fresh start or a sign-in. */
export const FUNNEL_CLAIM_SIGNED_IN = "FUNNEL_CLAIM_SIGNED_IN";

/** The visitor IS signed in, and their plan refused the competition itself (the active-competition quota, checked before
 *  its insert): NOTHING of the event was written. The 402's `feature_key` rides beside it. A plan refusal after the
 *  competition exists is FUNNEL_CLAIM_SIGNED_IN (part-built), not this. */
export const FUNNEL_CLAIM_PLAN_LIMIT = "FUNNEL_CLAIM_PLAN_LIMIT";

/** The visitor IS signed in, and the draft's first day has passed (before the UTC day less one — lib/funnel-days.ts):
 *  createFromDraft refuses it before its first write, so NOTHING of the event exists. The way on is a fresh start on
 *  /start, not the dashboard (a "may be partly set up" card would be untrue). */
export const FUNNEL_CLAIM_DATE_PAST = "FUNNEL_CLAIM_DATE_PAST";

/** The token names a draft a newer start REPLACED (V518: the same address resubmitted the wizard, or the visitor moved the
 *  draft to another address with its reference and replace key). Nothing happened and nobody was signed in: the newest email's
 *  link is the one that works. The claim page names the draft's reference (`funnelDraftCard`) so the visitor knows which
 *  email to look for. */
export const FUNNEL_CLAIM_REPLACED = "FUNNEL_CLAIM_REPLACED";
