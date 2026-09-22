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
  /** Matches the CURRENT active field requires per round, or `null` once the
   *  stage is COMPLETE — see `SWISS_LEGEND_COMPLETE_STATUSES`. Nullable rather
   *  than a separate flag so `swissLegendText` cannot forget the branch: the
   *  live clause needs a `number` for its plural, and tsc refuses the union. */
  matches: number | null;
  /** Whether that field is odd, i.e. one entrant sits out each round. Always
   *  `false` when `matches` is null — there is no per-round clause to qualify. */
  bye: boolean;
  /** Fixture rows the stage holds TODAY. May disagree with the two above. */
  fixtures: number;
};

/**
 * Stage statuses that mean the stage is FINISHED, so its per-round match
 * clause is history rather than a live claim about who is still in the field.
 *
 * WHY THE GATE EXISTS. The middle figure tracks the CURRENT field on purpose
 * (that is the whole feature). On a finished stage that turns against it: a
 * single post-event disqualification shrinks the field, and a stage that was
 * played entirely correctly — right rounds, right boards, every result in —
 * starts reading as mis-sized, accusing the organiser of a defect that is not
 * there. `rounds` and `fixtures` do not decay that way, so they stay; only the
 * clause that went stale is withheld (owner's steer, 2026-09-22).
 *
 * THE VOCABULARY IS THE STAGE'S OWN: `pending | active | complete` — the check
 * constraint on `stages.status` (db/migration/v2-engine/tables/V210__stages.sql)
 * and `Stage.status` in `server/api-v1/schemas.ts`. It is NOT the DIVISION's
 * `active | completed` (`DIVISION_STARTED_STATUSES`, `usecases/stages.ts`):
 * different column, different spelling, and copying that set here would have
 * matched nothing at all, leaving this gate inert and green.
 * `swiss-legend-complete-status-set` pins the set against the schema enum in
 * both directions, so a fourth stage status reds there rather than landing in
 * the live arm unexamined.
 *
 * Spelled here rather than imported from `api-v1/schemas.ts` for the same
 * reason the rest of this module is: the desk panel is a client component, and
 * that module is 5,000 lines of Zod nobody wants in the browser bundle for one
 * string.
 */
export const SWISS_LEGEND_COMPLETE_STATUSES: ReadonlySet<string> = new Set(["complete"]);

/**
 * The smallest field that has a swiss shape worth stating. Below it every
 * clause is vacuous — 0 entrants pair 0 matches; 1 entrant pairs 0 matches and
 * sits itself out, which is not more meaningful for having a bye in it — and
 * the noise lands at the worst moment: a stage is created BEFORE any entrant
 * exists, so "0 matches per round" was the FIRST thing an organiser saw on a
 * brand-new stage (owner's decision, 2026-09-22: suppress until there is a
 * field).
 *
 * The cut is on the stage's OWN field — the `config.qualified` intersection
 * where there is one — not on the division roster, so a later swiss stage
 * whose qualifiers have all withdrawn is suppressed even in a full division.
 */
export const SWISS_LEGEND_MIN_FIELD = 2;

/** The ONE non-plural key this module looks up. Spelled as a literal rather
 *  than `string` so `useMsg` — whose parameter is the closed `MessageKey`
 *  union, not a widened string — satisfies `SwissLegendI18n` under
 *  `strictFunctionTypes`. It also keeps the module's whole key surface
 *  visible in one place. The plural keys below take their `.one`/`.other`
 *  suffix inside the runtime, so their BASE is not itself a `MessageKey` and
 *  `plural` is typed on `string` accordingly. */
type SwissLegendMessageKey = "stage.swissLegend.line" | "stage.swissLegend.lineComplete";

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
 * The figures, or `null` when there is nothing honest to print:
 * a non-swiss stage, a stage with no usable declared round count (it cannot
 * generate either — `swissGen` throws `CONFIG_INVALID`), an unknown field
 * (a caller that did not supply the roster gets NO legend rather than a match
 * count of zero dressed up as a fact), or a field too small to pair at all.
 *
 * THE ORDER OF THE LAST TWO GATES IS DELIBERATE. The field threshold is
 * applied BEFORE the completed check, so an absent roster and an empty roster
 * behave identically at every status. The alternative — letting a finished
 * stage print `3 rounds · 18 fixtures` with no field, since neither figure
 * depends on the roster — would have made `activeEntrantIds: undefined` (no
 * legend) and `activeEntrantIds: []` (a legend) disagree on exactly the same
 * screen, which is the confusion this ordering exists to avoid. The cost is a
 * finished stage whose field was later emptied below two, which loses its
 * line; that is a stage on which the roster no longer describes anyone who
 * played, and it is pinned by
 * `the suppression holds at EVERY stage status, and absent and empty never diverge`.
 */
export function swissStageLegend(args: {
  kind: string;
  /** The stage's OWN status (`pending | active | complete`), not the
   *  division's. See `SWISS_LEGEND_COMPLETE_STATUSES`. */
  status: string;
  config: Record<string, unknown>;
  activeEntrantIds: readonly string[] | undefined;
  fixtureCount: number;
}): SwissLegend | null {
  const { kind, status, config, activeEntrantIds, fixtureCount } = args;
  if (kind !== "swiss") return null;
  if (activeEntrantIds === undefined) return null;
  const rounds = config.rounds;
  // Same admission test `swissGen` applies before it will mint anything.
  if (typeof rounds !== "number" || !Number.isInteger(rounds) || rounds < 1) return null;
  const field = swissActiveFieldSize(config, activeEntrantIds);
  if (field < SWISS_LEGEND_MIN_FIELD) return null;
  // A finished stage keeps the two figures that are true forever and withholds
  // the one that decays with the roster.
  if (SWISS_LEGEND_COMPLETE_STATUSES.has(status)) {
    return { rounds, matches: null, bye: false, fixtures: fixtureCount };
  }
  const { boards, bye } = swissBoardsForField(field);
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
 *
 * A COMPLETE stage takes a SECOND whole-sentence template
 * (`stage.swissLegend.lineComplete`, two clauses) rather than the three-clause
 * one with a blank in it. A locale re-punctuates or re-orders either without
 * code, and nothing here glues a separator on by hand — which is also why the
 * two-clause arrangement is a dictionary change in all four locales rather
 * than string surgery in the component.
 */
export function swissLegendText(legend: SwissLegend, i18n: SwissLegendI18n): string {
  const rounds = i18n.plural("stage.swissLegend.rounds", legend.rounds);
  const fixtures = i18n.plural("stage.swissLegend.fixtures", legend.fixtures);
  if (legend.matches === null) {
    return i18n.t("stage.swissLegend.lineComplete", { rounds, fixtures });
  }
  return i18n.t("stage.swissLegend.line", {
    rounds,
    matches: i18n.plural(
      legend.bye ? "stage.swissLegend.matchesWithBye" : "stage.swissLegend.matches",
      legend.matches,
    ),
    fixtures,
  });
}
