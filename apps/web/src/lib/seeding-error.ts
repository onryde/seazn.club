// SEEDING_* error-code -> organiser copy (P6/D4b task B, owner ruling: "wire
// copy for the 13 SEEDING_* codes only... plus the resolver that renders a
// code into it" — docs/superpowers/plans/2026-08-13-p6-progression-ui-plan.md
// "Owner ruling — SEEDING_* error copy is P6's, scoped"). Before this, all
// four dictionaries/*/errors.json were `{}` and a failed confirm showed an
// organiser a raw wire code like SEEDING_TIE_UNRESOLVED — this is the first
// consumer of the `errors` namespace (lib/i18n-constants.ts's NAMESPACES
// already listed it; nothing read it).
//
// The codes in SEEDING_ERROR_CODES below are HttpError codes thrown by
// computeSeedProposal / confirmSeedProposal (server/usecases/stages/seed-proposal.ts) and
// resolveQualifiers (server/usecases/stage-seeding.ts) — ALL_CAPS_SNAKE wire
// codes by repo convention (api-v1/schemas/ folder's comment), never i18n keys
// themselves. Read the count off that array, never off this comment: the "13"
// in the ruling quoted above is the ruling's own figure and has been stale
// since F3 added a 14th.
//
// Bundles all 4 locale errors.json files directly, unlike lib/messages.ts's
// useMsg()/msgFor() split for the (much larger) `ui` catalog — errors.json is a
// short flat map, every code fires from a client-side POST response (the
// panel's own fetch), and there is no DictProvider carrying `errors` to ride.
// Not `server-only`: this must work from the client panel's catch block.
import en from "@/dictionaries/en/errors.json";
import es from "@/dictionaries/es/errors.json";
import fr from "@/dictionaries/fr/errors.json";
import nl from "@/dictionaries/nl/errors.json";
import { DEFAULT_LOCALE, type Dict, type Locale } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";

const BY_LOCALE: Record<Locale, Dict> = { en, es, fr, nl };

/** The 13 codes this pass wires — verbatim list from the brief — plus ONE
 *  more (F3 review item 4, 2026-08-18 dispatch ruling): SEEDING_MAP_SOURCE_
 *  AMBIGUOUS is a `.seeding`-rule-validation HttpError exactly like the three
 *  MAP_SLOT_INVALID/MAP_SOURCE_INVALID/BESTNTH_UNEQUAL_POOLS entries below it
 *  (thrown by validateStageProgression's EngineError->HttpError conversion,
 *  stage-seeding.ts) — it shipped with locale copy under `ui.json`'s
 *  `engineError.*` namespace (scoring-vocab.ts's ENGINE_ERROR_KEY, forced by
 *  that map's exhaustiveness check) but NO reader on this path, so an
 *  organiser saw raw English regardless of locale. Do NOT add more here
 *  without a fresh owner ruling (P6/D4b task B's scope note: "Do NOT audit or
 *  wire other unwired codes — that is a separate session's scope"). Three of
 *  these (MAP_SLOT_INVALID, MAP_SOURCE_INVALID, BESTNTH_UNEQUAL_POOLS) are
 *  save-time `.seeding` rule-validation errors — there is no seeding-rules
 *  editor UI yet to surface them from, so the copy exists and is tested but
 *  currently has no call site; a future rules editor (P7) gets it for free.
 *  MAP_SOURCE_AMBIGUOUS is no longer one of them (F3 round-3 review,
 *  2026-08-18): `placeDescriptors` (packages/engine/src/competition/
 *  progression.ts) now throws it directly from generateProgressionSetupFixtures
 *  (usecases/stages/setup-fixtures.ts) — the day-one/setup fixture-generation path, not just
 *  validateStageProgression's save-time check — so it has a real call site
 *  today, independent of any rules-editor UI.
 *
 *  SEEDING_ENTRANT_WITHDRAWN is the 16th. confirmSeedProposal throws it when
 *  an entrant about to be FILLED into the bracket has left the field
 *  (`status in ('withdrawn','disqualified')`) — reachable from the computed
 *  slate, an `edits[]` override or a `tiePicks[]` order alike, and most
 *  commonly from a draft computed BEFORE the withdrawal (a withdrawal leaves
 *  the frozen standings snapshot untouched, so it does not stale the draft).
 *  It needed a code of its own rather than SEEDING_ENTRANT_FOREIGN's: she
 *  does still belong to the division — that copy would send an organiser
 *  looking for a roster mistake that isn't there — and the action that fixes
 *  it is a recompute, not a correction.
 *
 *  SEEDING_CARRY_SOURCE_INVALID is the 15th, added by F6 (#625) under the
 *  design of record's own authorisation to "reuse or add beside seeding-error
 *  helpers" (docs/superpowers/specs/2026-09-15-standings-carry-over-f6-design.md,
 *  owner-approved 2026-09-15) — NOT a re-opening of the scope note above.
 *  computeSeedProposal throws it when `progression.carry` names a source that
 *  offers a downstream stage a finishing order rather than a points table —
 *  every kind outside REAL_TABLE_KINDS (usecases/stages/types.ts), whose comment
 *  carries the per-kind detail. It needed a code of its own rather than
 *  SEEDING_RULES_MISSING's: that copy tells the organiser to add rules or
 *  regenerate fixtures, and neither would fix this.
 *
 *  SEEDING_NOTHING_TO_FILL is the 17th (review finding F1, 2026-09-21).
 *  confirmSeedProposal throws it when the proposal has no slot left to fill
 *  at all — every qualifier has left the field. Before the departed-qualifier
 *  filter that could not happen; now it can, and confirming an empty draw
 *  used to SUCCEED with `filled: 0` and burn the terminal `confirmed` status,
 *  after which nothing in the product could recompute the stage. Its own code
 *  rather than SEEDING_SOURCE_INCOMPLETE's: the source stage IS complete, and
 *  the remedy is to wait for the field to settle and recompute, not to go
 *  finish something.
 *
 *  SEEDING_ROUNDLOSERS_DE_SOURCE (W4 app PR B, review M4): a `roundLosers` take whose source is a double-elimination stage.
 *  The engine numbers rounds from 0 PER LANE (winners', losers', grand final) and its round-loser read does not tell the lanes
 *  apart, so the take would silently mix lanes' losers. Refused by name at propose/resolve time rather than guessed.
 *
 *  SEEDING_FIRSTLOSSES_DE_SOURCE (W4 app PR B, Task 8): the same refusal for a `firstLosses` take. "First real loss" is defined over a
 *  single-elimination bracket's rounds; a double-elimination loser drops into a second lane and may lose again, so there is no one
 *  "first loss" round to wait on. Refused by name rather than guessed.
 *
 *  SEEDING_BESTNTH_UNEQUAL_POOLS is DEPRECATED (W5 app PR B T4; ruling 286, RB5-U8; preflight C2): engine 10 never throws it -
 *  best-Nth across unequal pools is always compared on the smallest pool's matches - but the code stays in the engine's union and
 *  a stored seeding-failure notice or a cached API client can still carry it, so its copy is kept and still renders.
 *
 *  SEEDING_BESTNTH_NO_SUPPLIER and SEEDING_POOL_RESULTS_MISSING (W5 app PR B T4, K19): see BEST_NTH_REFUSAL_CODES below.
 *
 *  SEEDING_POOL_SEPARATION_IMPOSSIBLE, SEEDING_PAGE_PLAYOFF_NEEDS_FOUR and SEEDING_CROSS_POOL_DRAW_INVALID (W5 app PR B T5, K22):
 *  see CROSS_POOL_REFUSAL_CODES below. */
export const SEEDING_ERROR_CODES = [
  "SEEDING_MAP_SLOT_INVALID",
  "SEEDING_MAP_SOURCE_INVALID",
  "SEEDING_MAP_SOURCE_AMBIGUOUS",
  "SEEDING_RULES_MISSING",
  "SEEDING_SOURCE_INCOMPLETE",
  "SEEDING_BESTNTH_UNEQUAL_POOLS",
  "SEEDING_ALREADY_CONFIRMED",
  "SEEDING_PROPOSAL_STALE",
  "SEEDING_EDIT_UNKNOWN_SLOT",
  "SEEDING_TIE_UNRESOLVED",
  "SEEDING_SLOT_DOUBLE_ASSIGNED",
  "SEEDING_ENTRANT_FOREIGN",
  "SEEDING_ENTRANT_WITHDRAWN",
  "SEEDING_SLOT_FOREIGN_FIXTURE",
  "SEEDING_FIXTURES_ALREADY_FILLED",
  "SEEDING_CARRY_SOURCE_INVALID",
  "SEEDING_NOTHING_TO_FILL",
  "SEEDING_ROUNDLOSERS_DE_SOURCE",
  "SEEDING_FIRSTLOSSES_DE_SOURCE",
  "SEEDING_BESTNTH_NO_SUPPLIER",
  "SEEDING_POOL_RESULTS_MISSING",
  "SEEDING_POOL_SEPARATION_IMPOSSIBLE",
  "SEEDING_PAGE_PLAYOFF_NEEDS_FOUR",
  "SEEDING_CROSS_POOL_DRAW_INVALID",
  "SEEDING_CROSS_POOL_DRAW_TOO_LARGE",
] as const;
export type SeedingErrorCode = (typeof SEEDING_ERROR_CODES)[number];

/** W5 app PR B T4 (K19; RB5-U7, ruling 286): engine 10's two best-Nth STAGE_NOT_READY reasons, named at the one resolve boundary
 *  (`bestNthRefusal`, server/usecases/stored-progression.ts) so neither is read as "another source is not ready yet" and swallowed.
 *  SEEDING_BESTNTH_NO_SUPPLIER: no pool has a rank-N finisher (expunged leavers count in no size) - the format or the field is what
 *  to mend. SEEDING_POOL_RESULTS_MISSING: a larger pool handed best-Nth no results - no app path reaches it (both seeding builders
 *  attach every pool's results; the sweep in pool-results-seam.test.ts pins that), mapped by name so a regression is named. A
 *  completion that trips either carries the code as `cause` inside STAGE_COMPLETED_SEEDING_FAILED (completed-seeding-failed.ts). */
export const BEST_NTH_REFUSAL_CODES: ReadonlySet<string> = new Set(["SEEDING_BESTNTH_NO_SUPPLIER", "SEEDING_POOL_RESULTS_MISSING"]);

/** W5 app PR B T5 (K22; ruling 281, RB5-D4): the cross-pool draw's refusals (`crossPoolRefusal`, usecases/stages/cross-pool-draw.ts).
 *  SEEDING_POOL_SEPARATION_IMPOSSIBLE: no ordering of the rank tiers keeps pool-mates apart in round one ({pool} the largest supplier,
 *  {count} of {entrants}). SEEDING_PAGE_PLAYOFF_NEEDS_FOUR: a page playoff fed {entrants}. SEEDING_CROSS_POOL_DRAW_INVALID: the draw's
 *  own input refusals ({reason}: tier_invalid, duplicate_entrant, ...) - the app builds that input, so these name a wiring fault.
 *  SEEDING_CROSS_POOL_DRAW_TOO_LARGE (D-B2-2): a field of {pools} pools / {entrants} qualifiers past the builder's bounds
 *  ({maxPools}, {maxEntrants}) - the draw's search was measured over that space only, and past it can run for minutes. A
 *  completion that trips one carries the code as `cause` inside STAGE_COMPLETED_SEEDING_FAILED, as the best-Nth ones do. */
export const CROSS_POOL_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "SEEDING_POOL_SEPARATION_IMPOSSIBLE",
  "SEEDING_PAGE_PLAYOFF_NEEDS_FOUR",
  "SEEDING_CROSS_POOL_DRAW_INVALID",
  "SEEDING_CROSS_POOL_DRAW_TOO_LARGE",
]);

/** W5 stress fix F5: SEEDING_PROPOSAL_STALE's `reason` when a NEWER draft replaced the one being confirmed (a Recompute / POST
 *  /seed-proposal), not a standings change; the reply also names it (`newer`). The code stays SEEDING_PROPOSAL_STALE, so every
 *  reader that takes it as "look again" (the progression panel's refresh, plate-field, quick-match advance, match-day MD_STALE)
 *  still does; only the copy differs (`seeding.proposalSuperseded`). */
export const PROPOSAL_STALE_SUPERSEDED = "superseded";

function isSeedingErrorCode(code: string): code is SeedingErrorCode {
  return (SEEDING_ERROR_CODES as readonly string[]).includes(code);
}

/** ApiV1Error.code -> localized organiser-facing copy. Any code outside the
 *  13 above (a non-seeding error, or a future SEEDING_* this pass didn't
 *  wire) returns `fallback` verbatim — never a raw wire code shown to an
 *  organiser, and never a silent guess at copy this pass didn't author. */
export function seedingErrorMessage(
  locale: Locale,
  code: string,
  fallback: string,
  vars?: Record<string, string | number>,
): string {
  if (!isSeedingErrorCode(code)) return fallback;
  const dict = BY_LOCALE[locale] ?? BY_LOCALE[DEFAULT_LOCALE];
  if (code === "SEEDING_PROPOSAL_STALE" && vars?.reason === PROPOSAL_STALE_SUPERSEDED) return t(dict, "seeding.proposalSuperseded", vars);
  return t(dict, `seeding.${code}`, vars);
}
