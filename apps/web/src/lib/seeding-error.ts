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
// computeSeedProposal / confirmSeedProposal (server/usecases/stages.ts) and
// resolveQualifiers (server/usecases/stage-seeding.ts) — ALL_CAPS_SNAKE wire
// codes by repo convention (schemas.ts:3024-3029's comment), never i18n keys
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
 *  (usecases/stages.ts) — the day-one/setup fixture-generation path, not just
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
 *  every kind outside REAL_TABLE_KINDS (usecases/stages.ts), whose comment
 *  carries the per-kind detail. It needed a code of its own rather than
 *  SEEDING_RULES_MISSING's: that copy tells the organiser to add rules or
 *  regenerate fixtures, and neither would fix this. */
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
] as const;
export type SeedingErrorCode = (typeof SEEDING_ERROR_CODES)[number];

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
  return t(dict, `seeding.${code}`, vars);
}
