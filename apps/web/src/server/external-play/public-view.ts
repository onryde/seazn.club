/** Public-safe external-play bridge snapshot: the status, and nothing else.
 *  No play URL (D3 deleted the lichess.org mode, so a public page links to no
 *  Lichess game), and never `last_error` (operator text). */
export type PublicExternalPlay = {
  status: "pending" | "ready" | "live" | "finished" | "needs_organiser";
};
