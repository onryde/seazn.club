/*
 * R8/WS-H — THE list of v3 pad skins an e2e sweep has to cover, and the
 * minimum fixture each one needs to render a live pad.
 *
 * WHY IT IS A DATA MODULE AND NOT A LITERAL INSIDE THE SPEC. R7/A3 closed the
 * conversion programme: `v3/registry.ts`'s `V3_SKINS` now owns all eleven
 * engine sports and `LEGACY_SPORTS` is empty. A twelfth sport will therefore
 * arrive as one more `V3_SKINS` entry — and the accessibility sweep that is
 * supposed to cover "every skin" has no way to notice it was not added here.
 * That is the exact shape of gap R8 exists to close: five skins (badminton,
 * tabletennis, boardgame, carrom, hockey) had ZERO axe or hit-target coverage
 * for months because every a11y assertion in this suite named its sport by
 * hand.
 *
 * So the list lives here, with NO imports of its own (deliberately: it has to
 * be importable both by a Playwright spec and by a plain node vitest, and
 * anything that reaches into `@playwright/test` or into React would break one
 * of the two), and
 * `src/components/v2/scorepad/v3/__tests__/a11y-sweep-totality.test.ts` pins
 * its key set against `V3_SKINS` itself. Adding a sport to the registry and
 * not to this array is a RED unit test, not a silently thinner sweep.
 *
 * ORDER IS ALPHABETICAL BY KEY, matching `V3_SKINS`'s own working agreement
 * (registry.ts's header: a sorted list gives each new key exactly one correct
 * slot, so two concurrent waves inserting a sport do not collide on the same
 * last line). It is NOT wave order and must not be re-sorted into it.
 *
 * The rosters are the MINIMUM each sport's server-side fold accepts, not a
 * realistic team sheet — every entry was taken from the spec that already
 * drives that sport for real (`scorepad-v3-badminton`, `scorepad-v3-
 * tabletennis`, `scorepad-skins`, `walkthrough/scorepad-v3-carrom-match`,
 * `walkthrough/scorepad-v3-boardgame-result`, `walkthrough/scorepad-v3-
 * period-pair`) rather than guessed, so a 422 here means the pad changed, not
 * that this table was invented.
 */

export interface V3SkinRosterSlot {
  /** Football's fold rejects a goal from someone who is not on the pitch, and
   *  the seeder needs a position to place them. Omit for every sport whose
   *  events attribute to a SIDE. */
  readonly positionKey?: string;
}

export interface V3SkinCase {
  /** The engine sport key — must be a key of `V3_SKINS`. */
  readonly key: string;
  /** A REAL variant key for that sport (`sync:sports`'s system variants). */
  readonly variantKey: string;
  readonly entrantKind: "individual" | "team" | "pair";
  readonly home: readonly V3SkinRosterSlot[];
  readonly away: readonly V3SkinRosterSlot[];
  /** One line on what this skin is, so a failure names a product surface
   *  rather than a string. */
  readonly note: string;
}

const SOLO: readonly V3SkinRosterSlot[] = [{}];

export const V3_SKIN_CASES: readonly V3SkinCase[] = [
  {
    key: "badminton",
    variantKey: "bwf",
    entrantKind: "individual",
    home: SOLO,
    away: SOLO,
    note: "R5/C1 — tapModel S, sports/setbased kernel; serve context strip.",
  },
  {
    key: "boardgame",
    variantKey: "classical",
    entrantKind: "individual",
    home: SOLO,
    away: SOLO,
    note: "R7/A2 — terminal-result sport; the halves commit a RESULT, not a tally.",
  },
  {
    key: "carrom",
    variantKey: "icf",
    entrantKind: "individual",
    home: SOLO,
    away: SOLO,
    note: "R7/A3 — tapModel T, board/game structure; the last conversion.",
  },
  {
    key: "cricket",
    variantKey: "t20",
    entrantKind: "team",
    // Striker + non-striker one side, bowler the other: `resolvePeople`
    // (v3/skins/cricket.tsx) derives the context strip's defaults from the
    // fold, and a one-player home side leaves the non-striker slot unfilled.
    home: [{}, {}],
    away: SOLO,
    note: "R2 — the first conversion; densest tile grid and a 3-slot context strip.",
  },
  {
    key: "football",
    variantKey: "11-a-side",
    entrantKind: "team",
    home: [{ positionKey: "FW" }, { positionKey: "GK" }],
    away: [{ positionKey: "GK" }],
    note: "R3/B2 — per-side goal/card/sub tiles and a two-step penalty sheet.",
  },
  {
    key: "generic",
    variantKey: "score",
    entrantKind: "individual",
    home: SOLO,
    away: SOLO,
    note: "R7/A1 — the catalog's Generic sport; the pad every unmodelled sport gets.",
  },
  {
    key: "hockey",
    variantKey: "fih-outdoor",
    entrantKind: "team",
    home: SOLO,
    away: SOLO,
    note: "R6 — period-shared.ts, quarters; the FIRST skin to declare clock().",
  },
  {
    key: "icehockey",
    variantKey: "iihf",
    entrantKind: "team",
    home: SOLO,
    away: SOLO,
    note: "R6 — period-shared.ts's other half; periods, suspensions, a clock bar.",
  },
  {
    key: "tabletennis",
    variantKey: "bo5",
    entrantKind: "individual",
    home: SOLO,
    away: SOLO,
    note: "R5 — tapModel S, setbased kernel; expedite + serve anchor.",
  },
  {
    key: "tennis",
    variantKey: "tour",
    entrantKind: "individual",
    home: SOLO,
    away: SOLO,
    note: "R4 — tapModel S; the halves ARE the point buttons.",
  },
  {
    key: "volleyball",
    variantKey: "indoor",
    entrantKind: "team",
    home: SOLO,
    away: SOLO,
    note: "R5/C3 — tapModel S plus a guided set-score sheet; closes the racquet family.",
  },
];

/** Just the keys, for the totality pin. */
export const V3_SKIN_CASE_KEYS: readonly string[] = V3_SKIN_CASES.map((c) => c.key);
