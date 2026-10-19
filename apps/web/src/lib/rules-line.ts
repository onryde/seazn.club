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

/** The keys a rules line reads from the PUBLIC dictionary: every clause is a `format.rules.*` key. */
export const RULES_LINE_DICT_PREFIX = "format.rules.";

/** The one clause key outside that prefix: the set kernel's head when a best-of config names no points target
 *  (`describeSetKernel`). The describers share it with the hub's division line, hence its `format.sets.*` home. */
export const RULES_LINE_DICT_EXTRA_KEYS: ReadonlySet<string> = new Set(["format.sets.bestOf"]);

/** The slice of the public dictionary a rules line needs (`format.rules.*` and `RULES_LINE_DICT_EXTRA_KEYS`), for a client
 *  island that is not the public site - the stage format row's chips (W2c Task 17) - so the whole 85 KB dictionary does not
 *  cross the RSC boundary. Pinned: every key the describers can emit is inside it (`stage-row-model.test.ts`). */
export function rulesLineDict(dict: Dict): Dict {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(dict)) if (key.startsWith(RULES_LINE_DICT_PREFIX) || RULES_LINE_DICT_EXTRA_KEYS.has(key)) out[key] = dict[key];
  return out;
}

/** One clause as a chip's text: the same words the public line says, its first letter capitalised (a chip stands alone;
 *  a clause is written to sit mid-sentence, so it begins lowercase). */
export function rulesChipText(dict: Dict, clause: RulesClause): string {
  const text = t(dict, clause.key, clause.params);
  return text.charAt(0).toUpperCase() + text.slice(1);
}
