/*
 * R8/WS-M fix round 1, item 3 — WHICH v3 pad skins `mobile.spec.ts` actually
 * exercises at the seven width projects (320/360/375/390/430/768/834), and
 * which one does not.
 *
 * WHY THIS EXISTS. `mobile.spec.ts` names every sport it covers by hand,
 * inside test bodies, and nothing tied that set to the real skin registry. A
 * twelfth sport would therefore arrive in `V3_SKINS`, be forced into
 * `v3-skin-catalog.ts` by `a11y-sweep-totality.test.ts` — and still get ZERO
 * width coverage, with nothing anywhere failing. That is the same gap WS-H
 * closed for the a11y sweep, one file over, and the same way five skins went
 * uncovered for months.
 *
 * WHY A DATA MODULE AND NOT A REGEX. `a11y-sweep-totality.test.ts`'s own
 * header rules out scanning a spec's source text, and it is right: comment
 * prose in this repo has already poisoned a naive code-literal scan, and a
 * scan that silently matches nothing is the same green as one that matched
 * everything. But a vitest cannot import `mobile.spec.ts` either — that would
 * execute `@playwright/test`'s `test()` at module load. So the declaration
 * lives here, in a module with NO imports of its own, importable by the
 * Playwright spec and by a plain node vitest alike — the identical shape, and
 * for the identical reason, as `v3-skin-catalog.ts` beside it.
 *
 * WHAT IT CANNOT CATCH, stated plainly: these are DECLARATIONS. They fail when
 * a sport is added to the registry and to neither list here, which is the
 * failure this exists for. They cannot notice that a sport listed below had
 * its width test deleted afterwards. `WIDTH_MATRIX_CLOCK_SPORTS` is the one
 * part `mobile.spec.ts` genuinely reads back, so at least that pair cannot
 * drift.
 *
 * Keys are alphabetical, matching `V3_SKINS` and `V3_SKIN_CASES`. NOT wave
 * order, and not to be re-sorted into it.
 */

/** Sports with a DEDICATED width test in `mobile.spec.ts` — one that drives the
 *  real pad and measures its controls against the 44px floor at every width. */
export const WIDTH_MATRIX_PAD_SWEEPS: readonly string[] = [
  "badminton",
  "boardgame",
  "carrom",
  "cricket",
  "hockey",
  "icehockey",
  "tabletennis",
  "tennis",
  "volleyball",
];

/** Sports whose pad is proved to RENDER at every width, but whose controls are
 *  not swept for hit-target size here. Weaker than the list above, and
 *  deliberately a separate list so "covered" never quietly means two things. */
export const WIDTH_MATRIX_PAD_RENDER_ONLY: readonly { key: string; where: string }[] = [
  {
    key: "football",
    where:
      "the 'decider consoles' test — `auditRoute(..., { requireScorePad: true })` on a shootout " +
      "console, so the pad is proved present and the page proved free of horizontal scroll, but no " +
      "tile is measured.",
  },
];

/** Sports with NO width coverage at all. Every entry is a known gap owed to a
 *  later wave, never a sport someone forgot: adding a skin without listing it
 *  somewhere in this file reds `width-matrix-totality.test.ts`. */
export const WIDTH_MATRIX_PAD_UNCOVERED: readonly { key: string; why: string }[] = [
  {
    key: "generic",
    why:
      "no width test drives the generic pad. `sport_key: \"generic\"` appears throughout " +
      "mobile.spec.ts, but always as a DIVISION fixture for schedule/publish/registration surfaces " +
      "— never a scoring console. Recorded as a gap rather than papered over.",
  },
];

/** The two skins that declare `SkinDefV3.clock()`, driven as one parameterised
 *  width test. Read back by `mobile.spec.ts` itself, so this pair is the part
 *  of this module that cannot drift from the spec. */
export const WIDTH_MATRIX_CLOCK_SPORTS: readonly (readonly [key: string, short: string])[] = [
  ["hockey", "HK"],
  ["icehockey", "IH"],
];

/** Every sport this file accounts for, in any tier. */
export const WIDTH_MATRIX_ACCOUNTED_KEYS: readonly string[] = [
  ...WIDTH_MATRIX_PAD_SWEEPS,
  ...WIDTH_MATRIX_PAD_RENDER_ONLY.map((c) => c.key),
  ...WIDTH_MATRIX_PAD_UNCOVERED.map((c) => c.key),
];
