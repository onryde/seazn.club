// The two refusals POST /api/funnel/claim names with a machine `code`, shared by the route that throws them and the
// claim card that words them (a client component, so this module imports nothing server-side). The card never prints
// the route's English `error`; it reads one of these and words the answer in the visitor's language.

/** The token names no live draft: never minted, expired, or already claimed. Nothing happened and nobody was signed in. */
export const FUNNEL_CLAIM_INVALID = "FUNNEL_CLAIM_INVALID";

/** The visitor IS signed in (the session cookie was set) but building the drafted event failed part-way: the event may
 *  be partly built and the token is spent, so the way forward is their dashboard, not a fresh start or a sign-in. */
export const FUNNEL_CLAIM_SIGNED_IN = "FUNNEL_CLAIM_SIGNED_IN";
