// The spectator walkthrough's SEEDING budget, expressed in the cost it pays.
//
// AGENTS.md #20: "a flat timeout beside a derived cost is a latent red".
// `spectator-public.spec.ts`'s setup carried `test.setTimeout(180_000)`,
// written when it stood up TWO divisions; M1 k2 added a third and left the
// number alone. That file is `test.describe.configure({ mode: "serial" })`, so
// a setup that runs out of clock does not fail alone — it aborts every test
// after it, and Playwright prints whichever `expect`/`apiJson` was in flight
// above the timeout line, so the whole thing arrives looking like a seeding or
// data defect. AGENTS.md #21 then makes the reported failure count a floor
// rather than a total. That is an expensive misdiagnosis to buy with a
// literal, so the budget is derived from the table the setup builds from.
//
// TWO PLACEMENT FACTS, both load-bearing:
//
//   - This lives at `e2e/` ROOT, never in `e2e/walkthrough/`. Playwright's
//     `WALKTHROUGH` pattern (playwright.config.ts) matches every file in that
//     directory, so a helper there is classified as a TEST file and the whole
//     project fails to collect with `test file "x.spec.ts" should not import
//     test file "y.ts"`. `spectator-public-helpers.ts`'s own header records
//     the same trap, found the hard way.
//   - It imports NOTHING. `spectator-public-helpers.ts` — the obvious home,
//     beside `LIVE_UPDATE_BUDGET_MS` — pulls in `@playwright/test`, and the
//     node test that pins this arithmetic
//     (`src/lib/__tests__/spectator-walkthrough-budget.test.ts`) has to be
//     able to import it under vitest. A budget nothing can evaluate outside a
//     Playwright run is a budget nothing can check, and this file is not run
//     in CI against a browser on every change.

/** The clock the setup ran green on when it stood up TWO divisions. Nothing
 *  below this, ever: a future setup that seeds through some other helper (and
 *  so counts fewer divisions than it builds) must not be able to SHRINK the
 *  budget under what the file already needed. */
export const SETUP_FLOOR_MS = 180_000;

/** Everything the setup pays once, whatever it goes on to build: the signed-in
 *  org lookup and the competition create. */
export const SETUP_BASE_MS = 60_000;

/** One division stood up and seeded, sized on the HEAVIEST one the file
 *  builds, not the average — match A is created, given two 8-person teams, has
 *  its stage generated and started, and then has two innings posted ball by
 *  ball (~75 `POST /events` round trips, one per delivery). Match B's five
 *  player lines and match C's single PATCH cost a fraction of that. Sizing on
 *  the worst case is what lets a division of ANY shape be added without
 *  re-deriving this number. */
export const SETUP_PER_DIVISION_MS = 60_000;

/** The wall clock `spectator-public.spec.ts`'s setup may take.
 *
 *  At two divisions this is exactly the `180_000` the file used to carry, so
 *  the derivation starts from an observed-green budget rather than replacing
 *  it with a guess; each further division adds its own worst-case cost. */
export function spectatorSetupBudgetMs(cost: { divisions: number }): number {
  return Math.max(SETUP_FLOOR_MS, SETUP_BASE_MS + cost.divisions * SETUP_PER_DIVISION_MS);
}
