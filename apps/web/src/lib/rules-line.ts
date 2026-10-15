// A match-rules format line (`server/public-site/describe-rules.ts`) as the
// words a spectator reads: each clause resolved against the PUBLIC dictionary,
// joined with ", ".
//
// ONE joiner for every surface that prints the line — the match page's Info
// row and header (resolved server-side in the org's locale), the hub's Info
// tab (resolved client-side from the hub dictionary slice) and the division
// page's stage chips — so the three cannot punctuate one format three ways.
// Never " · ": that is the match header's own joiner between facts, and a line
// using it read as several separate facts ("1 game · 15 points · Court 2").
//
// Client-safe on purpose (no `server-only`, no server imports): the hub's Info
// tab renders under a client boundary.
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";

/** One clause: a dictionary key and its params (`Msg`'s shape). */
export interface RulesClause {
  key: string;
  params?: Record<string, string | number>;
}

export const RULES_LINE_JOINER = ", ";

/**
 * The line as one sentence. Clauses are written to sit ANYWHERE in a line ("walkover 2–0", "penalties (5 each)",
 * "level matches wait for the organiser"), so they begin lowercase; the joiner capitalises the sentence's first
 * letter, once. A clause that leads with a digit or a capital ("2 halves of 45 min", "Best of 3") is left as it is, and
 * nothing past the first letter is touched.
 */
export function rulesLineText(dict: Dict, line: readonly RulesClause[]): string {
  const text = line.map((clause) => t(dict, clause.key, clause.params)).join(RULES_LINE_JOINER);
  return text.charAt(0).toUpperCase() + text.slice(1);
}
