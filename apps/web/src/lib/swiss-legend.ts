// The Swiss shape legend — one line under a swiss stage's title on the
// competition desk (owner-approved 2026-09-22, option B):
//
//   3 rounds · 5 matches + 1 bye per round · 11 fixtures
//
// WHY. A live defect: a Swiss stage's later rounds kept shells minted for an
// OLD field size after entrants were added and one deleted, so rounds 2 and 3
// offered 4 matches when the field needed 5 and the new players had nowhere to
// be seated. Nothing on the screen said so — it surfaced only when the
// organiser opened the fixture list and found a `TBD vs <name>` row. This
// legend puts the number that was silently wrong ON THE SCREEN.
//
// THE MIDDLE FIGURE IS DERIVED FROM THE CURRENT ACTIVE FIELD, NEVER FROM THE
// FIXTURE ROWS. Counting the rows and calling that the match count would print
// the stale number as if it were correct, which defeats the whole feature. The
// fixture total is a SEPARATE, third figure and may legitimately disagree with
// rounds × matches — that disagreement is the signal.
//
// Client-safe on purpose (same stance as `lib/swiss-shell.ts`, whose
// `swissBoardsForField` this reuses rather than restating): the desk panel is
// a client component and cannot import `server/usecases/stages.ts`.
//
// VOCABULARY. `board` is chess heritage and internal code vocabulary; it never
// reaches a screen. On screen it is "matches".
import { swissBoardsForField } from "@/lib/swiss-shell";

export type SwissLegend = {
  /** The round budget the organiser DECLARED (`stage.config.rounds`). Never
   *  derived from field size — `swissGen` is explicit that nothing derives or
   *  persists `rounds` from the field. */
  rounds: number;
  /** Matches the CURRENT active field requires per round. */
  matches: number;
  /** Whether that field is odd, i.e. one entrant sits out each round. */
  bye: boolean;
  /** Fixture rows the stage holds TODAY. May disagree with the two above. */
  fixtures: number;
};

/** The ONE non-plural key this module looks up. Spelled as a literal rather
 *  than `string` so `useMsg` — whose parameter is the closed `MessageKey`
 *  union, not a widened string — satisfies `SwissLegendI18n` under
 *  `strictFunctionTypes`. It also keeps the module's whole key surface
 *  visible in one place. The plural keys below take their `.one`/`.other`
 *  suffix inside the runtime, so their BASE is not itself a `MessageKey` and
 *  `plural` is typed on `string` accordingly. */
type SwissLegendMessageKey = "stage.swissLegend.line";

/** Minimal i18n surface, so the derivation stays testable against the real
 *  catalog without dragging React in. Satisfied by `useMsg`/`useMsgPlural`. */
export type SwissLegendI18n = {
  t: (key: SwissLegendMessageKey, vars?: Record<string, string | number>) => string;
  plural: (key: string, count: number, vars?: Record<string, string | number>) => string;
};

/**
 * The size of the field this swiss stage would actually pair, mirroring
 * `generateStageFixturesWrite`'s own resolution (usecases/stages.ts) exactly:
 * a stage carrying `config.qualified` draws from that list INTERSECTED with
 * the live field (swiss is not a `BRACKET_WALKOVER_KINDS` kind, so the policy
 * is expunge, not walkover); every other swiss stage draws the whole field.
 *
 * `activeEntrantIds` is the caller's answer to "who is in the field" and must
 * already be filtered to `status in ('registered','confirmed')` — the server's
 * own predicate. The page derives it as the complement of `DEPARTED_STATUSES`,
 * which is the one place that vocabulary is spelled; the equivalence of the
 * two is pinned by this module's own test.
 */
export function swissActiveFieldSize(
  config: Record<string, unknown>,
  activeEntrantIds: readonly string[],
): number {
  const qualified = Array.isArray(config.qualified) ? (config.qualified as unknown[]) : null;
  if (!qualified) return activeEntrantIds.length;
  const active = new Set(activeEntrantIds);
  return qualified.filter((id) => typeof id === "string" && active.has(id)).length;
}

/**
 * The three figures, or `null` when there is nothing honest to print:
 * a non-swiss stage, a stage with no usable declared round count (it cannot
 * generate either — `swissGen` throws `CONFIG_INVALID`), or an unknown field
 * (a caller that did not supply the roster gets NO legend rather than a match
 * count of zero dressed up as a fact).
 */
export function swissStageLegend(args: {
  kind: string;
  config: Record<string, unknown>;
  activeEntrantIds: readonly string[] | undefined;
  fixtureCount: number;
}): SwissLegend | null {
  const { kind, config, activeEntrantIds, fixtureCount } = args;
  if (kind !== "swiss") return null;
  if (activeEntrantIds === undefined) return null;
  const rounds = config.rounds;
  // Same admission test `swissGen` applies before it will mint anything.
  if (typeof rounds !== "number" || !Number.isInteger(rounds) || rounds < 1) return null;
  const { boards, bye } = swissBoardsForField(swissActiveFieldSize(config, activeEntrantIds));
  return { rounds, matches: boards, bye, fixtures: fixtureCount };
}

/**
 * The rendered sentence. Each of the three figures is a COMPLETE pluralised
 * clause owned by the translator (`{count} match + 1 bye per round`, not a
 * `"match"` fragment glued to a `"+ 1 bye"` fragment), and the assembly itself
 * is a template key (`stage.swissLegend.line`) so a locale can re-punctuate or
 * re-order without code. This runtime has no nested-plural message format, and
 * the line carries three independent counts, so one key for the whole sentence
 * is not available.
 *
 * The bye clause is a SEPARATE key rather than an appended fragment, so it is
 * wholly absent on an even field in every locale.
 */
export function swissLegendText(legend: SwissLegend, i18n: SwissLegendI18n): string {
  return i18n.t("stage.swissLegend.line", {
    rounds: i18n.plural("stage.swissLegend.rounds", legend.rounds),
    matches: i18n.plural(
      legend.bye ? "stage.swissLegend.matchesWithBye" : "stage.swissLegend.matches",
      legend.matches,
    ),
    fixtures: i18n.plural("stage.swissLegend.fixtures", legend.fixtures),
  });
}
