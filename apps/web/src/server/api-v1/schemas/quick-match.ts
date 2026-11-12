// /api/v1 contracts — quick match: the guest's one create (CreateQuickMatch).
// One module of the schemas/ folder; ./index.ts is the map and the public surface. Pure zod (loads bare under
// `node --experimental-strip-types`): relative imports carry an explicit `.ts`, types come in through `import type`.
import { z } from "zod";
// The locale set and the create's own bounds. Both files are import-free, so the standalone generator loads them
// like the other modules' lib imports.
import { DEFAULT_LOCALE, LOCALES } from "../../../lib/i18n-constants.ts";
import { QUICK_MATCH_MAX_PLAYS, QUICK_MATCH_MAX_SIDES, QUICK_MATCH_MIN_SIDES } from "../../../lib/quick-match-constants.ts";
import { EntrantKind } from "./common.ts";

// ---------------------------------------------------------------------------
// Quick match (spec docs/superpowers/specs/2026-11-03-quick-match-design.md §5, §7.3; plan 1 Task 5)
// ---------------------------------------------------------------------------

/** The guest's setup screen, as one create (usecases/quick-match-create.ts `createQuickMatch`).
 *
 *  `kind` is its own input (pre-flight D2): the setup's Singles/Doubles switch chooses it, and the create checks it
 *  against the sport's own kinds (`offerFor(...).kinds`). Required, never defaulted: when the switch is hidden the
 *  client sends the sport's only kind, as it sends "league" when the format row is hidden.
 *
 *  A side name is trimmed, so one that is only whitespace is refused, and one over 60 UTF-16 units is REFUSED, never
 *  clipped (E1): a guest who typed it sees why, instead of finding a shorter name on the table. */
export const CreateQuickMatch = z
  .object({
    name: z.string().trim().min(1).max(80),
    sport_key: z.string().min(1),
    variant_key: z.string().min(1),
    kind: EntrantKind,
    format: z.enum(["league", "knockout"]),
    sides: z.array(z.string().trim().min(1).max(60)).min(QUICK_MATCH_MIN_SIDES).max(QUICK_MATCH_MAX_SIDES),
    plays: z.number().int().min(1).max(QUICK_MATCH_MAX_PLAYS).default(1),
    email: z.string().email().max(254).nullable().default(null),
    // Precedent: app/api/funnel/start/route.ts's own `z.enum(LOCALES)`. There is no shared locale schema.
    locale: z.enum(LOCALES).default(DEFAULT_LOCALE),
  })
  .strict();
export type CreateQuickMatch = z.infer<typeof CreateQuickMatch>;
