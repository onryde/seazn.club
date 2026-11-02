// W3 Task 17 (RB3-19, X-SW-25) — "a correction after the bracket started: the bracket stands, the desk warns."
//
// Pure and client-safe (no `server-only`): the usecase (`server/usecases/swiss-cut-drift.ts`) judges WHO the Swiss cut
// moved and the stages panel says it, and `apps/web` vitest has no DOM, so what the warning decides and says lives here,
// where a test can read it.
//
// The rule (spec §12, orchestrator decision M4): once the knockout has begun, a corrected Swiss result never moves a
// seat — the bracket stands. What the organiser is owed is the fact that today's table would have cut differently, with
// the names, so the decision to leave the bracket alone (or to fix it by hand) is an informed one.

/** Who the cut moved: `out` held a seat in the frozen cut and would not make today's; `in` would make it and holds no seat. */
export interface SwissCutDrift {
  out: string[];
  in: string[];
}

/**
 * The drift between the cut the bracket was seeded from (`qualified`, the frozen cut) and today's top q (`currentTop`).
 * Null — no warning — when:
 *  - `qualified` is empty (EMPTY CASE FIRST: there is no cut to drift from, and the empty set differs from every
 *    non-empty top q, so it must not read as "everyone is in, nobody is out");
 *  - the knockout has not begun (before that a corrected table is simply the table: nothing stands yet);
 *  - the two sets are the same people (order inside the cut is no drift: the bracket is seeded by rank, and a re-order
 *    inside the cut moves no one across the line);
 *  - nobody would come in (`currentTop` shorter than the cut: there is no one to name as taking the place).
 * Both lists keep the order they were handed in.
 */
export function swissCutDrift(
  qualified: readonly string[],
  currentTop: readonly string[],
  knockoutStarted: boolean,
): SwissCutDrift | null {
  if (qualified.length === 0) return null;
  if (!knockoutStarted) return null;
  const frozen = new Set(qualified);
  const today = new Set(currentTop);
  const out = [...frozen].filter((id) => !today.has(id));
  const incoming = [...today].filter((id) => !frozen.has(id));
  if (incoming.length === 0) return null;
  return { out, in: incoming };
}

/** The plural base (`.one` / `.other` in every locale) the warning is said with. The count is the number who come in:
 *  the verb agrees with them. */
export const SWISS_CUT_DRIFT_PLURAL_KEY = "swiss.cutDrift.warning" as const;

/** The i18n surface the sentence needs; `useMsgPlural` satisfies it. */
export type SwissCutDriftI18n = (key: string, count: number, vars?: Record<string, string | number>) => string;

/**
 * The warning, in the reader's language: both lists are entrant DISPLAY NAMES (never ids — an id missing from `names`
 * reads "?", as every other desk line does) joined with the locale's own conjunction (`Intl.ListFormat`), so two people
 * moving read "Ana and Bo" in English and "Ana et Bo" in French.
 */
export function swissCutDriftText(
  drift: SwissCutDrift,
  names: Readonly<Record<string, string>>,
  locale: string,
  plural: SwissCutDriftI18n,
): string {
  const list = (ids: readonly string[]): string =>
    new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(ids.map((id) => names[id] ?? "?"));
  return plural(SWISS_CUT_DRIFT_PLURAL_KEY, drift.in.length, { in: list(drift.in), out: list(drift.out) });
}
