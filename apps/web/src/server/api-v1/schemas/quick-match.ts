// /api/v1 contracts — quick match: the guest's one create (CreateQuickMatch).
// One module of the schemas/ folder; ./index.ts is the map and the public surface. Pure zod (loads bare under
// `node --experimental-strip-types`): relative imports carry an explicit `.ts`, types come in through `import type`.
import { z } from "zod";
// The locale set and the create's own bounds. Both files are import-free, so the standalone generator loads them
// like the other modules' lib imports.
import { DEFAULT_LOCALE, LOCALES } from "../../../lib/i18n-constants.ts";
import {
  QUICK_MATCH_MAX_PLAYS,
  QUICK_MATCH_MAX_SIDES,
  QUICK_MATCH_MIN_SIDES,
  QUICK_MATCH_NAME_MAX,
  QUICK_MATCH_QUALIFIERS,
  QUICK_MATCH_SIDE_NAME_MAX,
} from "../../../lib/quick-match-constants.ts";
import { EntrantKind } from "./common.ts";

// ---------------------------------------------------------------------------
// Quick match (spec docs/superpowers/specs/2026-11-03-quick-match-design.md §5, §7.3; plan 1 Task 5)
// ---------------------------------------------------------------------------

/** League + Knockout's count, both ways (plan 5 D1): `league_knockout` needs one, and every other format refuses one, so a
 *  count can never ride along on a plain league and be read later as a bracket. The issue names `qualifiers`. */
function checkQualifiers(v: { format: string; qualifiers: number | null }, ctx: z.RefinementCtx): void {
  const wanted = v.format === "league_knockout";
  if (wanted !== (v.qualifiers !== null)) {
    ctx.addIssue({
      code: "custom",
      path: ["qualifiers"],
      message: wanted ? "league_knockout needs qualifiers (2 or 4)" : `${v.format} takes no qualifiers`,
    });
  }
}

/** The guest's setup screen, as one create (usecases/quick-match-create.ts `createQuickMatch`).
 *
 *  `kind` is its own input (pre-flight D2): the setup's Singles/Doubles switch chooses it, and the create checks it
 *  against the sport's own kinds (`offerFor(...).kinds`). Required, never defaulted: when the switch is hidden the
 *  client sends the sport's only kind, as it sends "league" when the format row is hidden.
 *
 *  `format` (plan 5 D1): `league`, or `league_knockout` with `qualifiers` (the top 2 play a final, the top 4 semi-finals and
 *  a final; QUICK_MATCH_QUALIFIERS). `knockout` stays in the enum for the rows that have it; the create refuses a new one
 *  (422 FORMAT_NOT_OFFERED). The count is required with `league_knockout` and refused with any other format.
 *
 *  A side name is trimmed, so one that is only whitespace is refused, and one over QUICK_MATCH_SIDE_NAME_MAX (60) UTF-16
 *  units is REFUSED, never clipped (E1): a guest who typed it sees why, instead of finding a shorter name on the table. */
export const CreateQuickMatch = z
  .object({
    name: z.string().trim().min(1).max(QUICK_MATCH_NAME_MAX),
    sport_key: z.string().min(1),
    variant_key: z.string().min(1),
    kind: EntrantKind,
    format: z.enum(["league", "knockout", "league_knockout"]),
    qualifiers: z.literal(QUICK_MATCH_QUALIFIERS).nullable().default(null),
    sides: z.array(z.string().trim().min(1).max(QUICK_MATCH_SIDE_NAME_MAX)).min(QUICK_MATCH_MIN_SIDES).max(QUICK_MATCH_MAX_SIDES),
    plays: z.number().int().min(1).max(QUICK_MATCH_MAX_PLAYS).default(1),
    email: z.string().email().max(254).nullable().default(null),
    // Precedent: app/api/funnel/start/route.ts's own `z.enum(LOCALES)`. There is no shared locale schema.
    locale: z.enum(LOCALES).default(DEFAULT_LOCALE),
  })
  .strict()
  .superRefine(checkQualifiers);
type ParsedCreateQuickMatch = z.infer<typeof CreateQuickMatch>;
/** What the create takes (usecases/quick-match-create.ts): the parsed body, except that `qualifiers` may be left out. The schema's
 *  `.default(null)` puts it on every PARSED body (the route's), but a caller that builds the input in code, as every test rig does,
 *  has no count to give a league: left out reads as null, and the create checks that the format and the count agree
 *  (`league_knockout` ⇔ a count), as `checkQualifiers` does here. Every other field is the parsed body's, unchanged. */
export type CreateQuickMatch = Omit<ParsedCreateQuickMatch, "qualifiers"> & Partial<Pick<ParsedCreateQuickMatch, "qualifiers">>;
