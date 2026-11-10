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
//                                     the model reads it and cuts it to `BADGE_MAX_CHARS`, as it does any producer's —
//                                     the widest four drive the Result ladder's last rung, gallery check 4c)
//   ?clock=<period>.<seconds>         FOOTBALL's live sample holds this match-time reading, paused (S2-5 ruling 110):
//                                     `ET_H2.1800` is `120+15:00`, the widest the bug's clock cell must hold. Read
//                                     under 2 × 45 with 2 × 15 of extra time (`STRESS_MATCH_TIME`)
import type { OverlaySideInput } from "@/lib/overlay-model";
import type { DecidedOutcomeTemplates } from "@/lib/scoring-vocab";
import type { OverlayLiveData } from "@/components/public-site/live-score-data";
import { clockPeriodsOf, type MatchTimeCfg } from "@/components/v2/scorepad/v3/skins/football-match-time";

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

/** The football cfg a stressed clock is read under: the engine's default halves, with extra time on so every period a
 *  football match can reach is a reading. */
export const STRESS_MATCH_TIME: MatchTimeCfg = { halves: 2, halfMinutes: 45, extraTime: { enabled: true, halfMinutes: 15 } };
/** An hour into one period: well past any added time a referee plays, and still a bounded string. */
const CLOCK_SECONDS_MAX = 3_600;

export interface StressClock {
  period: string;
  seconds: number;
}

/** `?clock=<period>.<seconds>`: a period `STRESS_MATCH_TIME` reaches and whole seconds within the bound, or nothing. */
export function parseStressClock(raw: string | undefined): StressClock | null {
  const m = /^([A-Z0-9_]+)\.(\d{1,4})$/.exec(raw?.trim() ?? "");
  if (m === null) return null;
  const [, period, digits] = m;
  const seconds = Number(digits);
  return clockPeriodsOf(STRESS_MATCH_TIME).includes(period!) && seconds <= CLOCK_SECONDS_MAX ? { period: period!, seconds } : null;
}

/** The snapshots with football's LIVE sample holding `clock`, paused (so the reading is the same at every frame and on
 *  every reload). Every other sport and state is the same object it was. */
export function stressFootballClock<T extends Record<string, Record<string, OverlayLiveData>>>(
  snapshots: T,
  clock: StressClock | null,
  now: number,
): T {
  const football = snapshots.football;
  if (clock === null || football?.live === undefined) return snapshots;
  const live: OverlayLiveData = {
    ...football.live,
    clock: { phase: clock.period, anchorSeconds: clock.seconds, anchorAtWallMs: now, running: false, matchTime: STRESS_MATCH_TIME },
  };
  return { ...snapshots, football: { ...football, live } };
}

