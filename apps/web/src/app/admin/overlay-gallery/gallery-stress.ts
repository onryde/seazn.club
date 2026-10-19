// The staff gallery's stress mode — owner ruling (1), 2026-10-19 (PR #982): gallery check 4c drives every Result card
// through the REAL result producer and the REAL headline ladder, in every locale, with every decided sentence and a
// long winner. Staff-only by the page's own `requireStaff`, and inert without its parameters.
//
//   ?decided=<fixture.decidedBy key>  every winner-bearing decided template becomes that key's sentence
//   ?name=<text>                      the HOME side's display name
//   ?away=<text>                      the AWAY side's display name; absent, the away side keeps the gallery's own
//                                     43-character club name — so `?name=` alone still airs two DIFFERENT long names
//                                     (a real fixture: the codes, the tiles and the winner token all tell them apart),
//                                     never one name on both sides
//   ?code=<text>                      both sides' explicit short name (`OverlaySideInput.short`, the producer's code;
//                                     the model reads it, and a long one is the Result ladder's last rung)
import type { OverlaySideInput } from "@/lib/overlay-model";
import type { DecidedOutcomeTemplates } from "@/lib/scoring-vocab";

/** The `{score}` a forced sentence shows — every cell, whatever its outcome carries. */
export const STRESS_SCORE = "4–3";
const NAME_MAX = 120;
const CODE_MAX = 40;

export interface GalleryStress {
  decided: string | null;
  /** The home side's name. */
  name: string | null;
  /** The away side's name. */
  away: string | null;
  code: string | null;
}

const bounded = (v: string | undefined, max: number): string | null => {
  const t = v?.trim();
  return t !== undefined && t.length > 0 && t.length <= max ? t : null;
};

/** A parameter that is not exactly what the mode takes is ignored, never guessed at: the key must be a
 *  `fixture.decidedBy.*` key the locale's dictionary declares; the names and code are trimmed and bounded. */
export function parseGalleryStress(
  query: { decided?: string | undefined; name?: string | undefined; away?: string | undefined; code?: string | undefined },
  ui: Record<string, string>,
): GalleryStress {
  const key = query.decided;
  const decided = key !== undefined && key.startsWith("fixture.decidedBy.") && Object.hasOwn(ui, key) ? key : null;
  return {
    decided,
    name: bounded(query.name, NAME_MAX),
    away: bounded(query.away, NAME_MAX),
    code: bounded(query.code, CODE_MAX),
  };
}

export function stressSides(
  sides: readonly [OverlaySideInput, OverlaySideInput],
  stress: GalleryStress,
): [OverlaySideInput, OverlaySideInput] {
  // Each side its OWN name (fix/overlay-team-code-disambiguation): one `?name=` on both sides drew a fixture between two
  // identically named teams, which no real fixture is, and hid which side's code the Result card's short rung named.
  const one = (s: OverlaySideInput, name: string | null): OverlaySideInput => ({
    ...s,
    ...(name === null ? {} : { name }),
    ...(stress.code === null ? {} : { short: stress.code }),
  });
  return [one(sides[0], stress.name), one(sides[1], stress.away)];
}

/** Every template that names a winner becomes `sentence` (its `{score}` filled with `STRESS_SCORE`); the tie keeps its
 *  own — it names no winner. The renderer is untouched: it still picks a template by the outcome and interpolates the
 *  winner's name, exactly as on a broadcast. */
export function stressTemplates(base: DecidedOutcomeTemplates, sentence: string): DecidedOutcomeTemplates {
  const forced = sentence.replaceAll("{score}", STRESS_SCORE);
  const every = (r: Record<string, string>) => Object.fromEntries(Object.keys(r).map((k) => [k, forced]));
  return {
    ...base,
    plain: forced,
    shootoutPlain: forced,
    byMethod: every(base.byMethod),
    ...(base.tiebreakScored === undefined ? {} : { tiebreakScored: every(base.tiebreakScored) }),
  };
}
