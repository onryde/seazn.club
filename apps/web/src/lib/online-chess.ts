// Client-safe facts about online chess (T20), shared by the server's start gates and the islands that read their
// refusals — the gate module itself is server-only (it asks PostHog), so an island cannot import the code from there.

/** The refusal every server-side start gate answers with while the club is not offered online chess (403). */
export const ONLINE_CHESS_DISABLED_CODE = "ONLINE_CHESS_DISABLED";
