# Registration Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make public registration faster to submit and clearer at every step. Show real capacity, waitlist position and money on the status page. Give each entry in a multi-entry cart its own payable reference. Give organisers a compact filter bar and tabbed division settings.

**Architecture:** Eight batches on one branch, opened as one PR:

- **Server work** (latency, capacity authority, waitlist position, cart position, search) stays behind the existing usecases, plus one new migration.
- **UI work** stays one DOM branched with `max-md:` / `md:hidden`.
- **New behaviour lives in pure functions:**
  - `capacityState`, `cartHeadline`, `whatHappensNext`, `cartMoneySummary`, `entryReference` and `parseEntryReference`, each tested on its own;
  - the hub-tabs state module, tested on its own.

  Components only render what these functions return.

**Tech Stack:** Next 16 app router, React 19, Tailwind 4, postgres.js, Flyway migrations, vitest (node env), Playwright, Cloudflare Turnstile, Stripe Checkout.

**Spec:** `docs/superpowers/specs/2026-11-13-registration-redesign-design.md`. Read it first. Its §0 lists 11 false premises. Every task below builds on the corrected facts.

## Global Constraints

- **Locales:** every new or changed user-facing string goes into `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`. Then run `npm run i18n:gen-keys` and `npm run i18n:check`. Never hardcode English.
- **Screenshots:** UI tasks capture 1280, 768 and 320 with no horizontal page scroll. Each batch's sign-off page is served from the local server on :8765 (not an artifact), with a copy kept in `~/seazn-artifacts/`.
- **Tests:** every change ships a test that fails without it. Mutate each guard you add once and record the killer test. Sequence tests: second call, empty input, after withdraw/void. "Another sport: N/A — registration is sport-agnostic" unless online chess seat gates are touched.
- **Scoped runs only.** Never run the full suite.
  - Vitest: `cd apps/web && npx vitest run <paths> --reporter=json --outputFile=/tmp/<task>.json`, then judge `numPassedTests`/`numTotalTests` and confirm `.testResults[].name`.
  - Playwright: run the whole named spec file, never a `-g` slice.
- **Server edits:** read `apps/web/src/server/MODULARIZATION.md` first. Do **not** split `registration-submit.ts` (1577 lines) in this wave. Record the deferral in the PR body.
- **Money:** always formats to 2 decimals (`£15.00`).
- **Testids:** keep `reg-back`, `reg-next`, `reg-submit`, `reg-who-playing`, `reg-consent-privacy`, `reg-consent-grant`, `[data-registration-hub-registrant-filters]`, the `select[name=…]` names and `data-registration-hub-row-configure`.
- **Model per task** (owner policy 2026-11-10): `[Opus]` for money, DB, submit or state-heavy tasks; `[Sonnet]` for UI-only tasks. Every batch ends with one Opus reviewer pass over the batch diff.
- **Batch flow:** implementer → reviewer → fix → screenshots for owner sign-off → next batch. One PR for the wave (B0 is the possible exception; see Q1 in spec §11). One e2e dispatch at the end.

## Review Focus

1. **Turnstile token aged past 300 s.** A person who opens the form, leaves for 6 minutes and then submits must still get through. That means a fresh token, not a 20 s wait followed by a tokenless POST. → T3, test `token() re-arms when the held token is older than TOKEN_MAX_AGE_MS`.
2. **Two entries into a division with 1 place left.** The second is labelled "Waiting list — not charged now", and the total excludes it, matching what submit does. → T12, test `second entry beyond remaining is waitlisted in the cart and excluded from total`.
3. **Division deleted after a 3-entry cart.** The surviving entries keep `-1` and `-3`, so an offline transfer still matches. → T17, test `cart_position survives deleting a sibling's division`.
4. **Browser Back off a dirty division tab.** The edits are not silently lost. → T24, e2e `back off a dirty tab re-opens it with the close dialog`.
5. **Phone keyboard open on Contact with the sticky bar.** Continue stays reachable and does not cover the focused field. → T9, manual 320 screenshot with the email input focused (iOS-sized viewport 375×667) on the sign-off page.

---

## Batch B0 — Measure submit latency `[Opus]`

**Owner sign-off:** the before-table (spec §10).
**E2E greps:** none. This batch changes no testids or strings.
**Smoke:** `scripts/smoke/suites/registrationOpenFlow.ts` and `registrationPaidLoop.ts` must stay green. The timer is optional, so they call unchanged.

### Task 1: Stage timer and register-route instrumentation

**Files:**
- Create: `apps/web/src/server/timing.ts`
- Modify: `apps/web/src/app/api/v1/public/orgs/[orgSlug]/competitions/[slug]/register/route.ts` (stages around :35, :38, :53, :71, the usecase call, :103-110, :126)
- Modify: `apps/web/src/server/usecases/registration-submit.ts`. Add an optional last parameter `timer?: StageTimer` and wrap the pre-tx blocks (:485, :508, :618-626, :667-677, :685) and the tx (:692).
- Modify: `apps/web/src/server/usecases/registrations/checkout.ts`. Add an optional `timer` to `mintGroupCheckout` (:457), with sub-stages `mint_reads` and `stripe` (around :306).
- Test: `apps/web/src/server/__tests__/timing.test.ts` and `apps/web/src/server/usecases/__tests__/registration-submit.test.ts` (one added case)

**Interfaces:**
- Produces:

  ```ts
  export type StageTimer = {
    stage<T>(name: string, fn: () => Promise<T>): Promise<T>;
    header(): string;            // "rate_limit;dur=3.1, turnstile;dur=210.4, …"
    summary(): Record<string, number>; // ms, rounded to 0.1
  };
  export function createStageTimer(now?: () => number): StageTimer;
  ```

  Nested `stage()` calls produce dotted names (`pre_tx.settings`). A stage entered twice sums its durations.

- [ ] **Step 1: Write the failing tests**

  ```ts
  it("sums repeated stages and nests names", async () => {
    let t = 0; const timer = createStageTimer(() => t);
    await timer.stage("pre_tx", async () => { await timer.stage("settings", async () => { t += 5; }); await timer.stage("settings", async () => { t += 3; }); });
    expect(timer.summary()).toEqual({ pre_tx: 8, "pre_tx.settings": 8 });
  });
  it("records a stage whose fn throws, then rethrows", async () => { /* duration present, error propagates */ });
  it("header() is a valid Server-Timing list", () => { /* matches /^[a-z_.]+;dur=\d+(\.\d)?(, [a-z_.]+;dur=\d+(\.\d)?)*$/ */ });
  it("header() of an untouched timer is empty string", () => { /* empty case first */ });
  ```

  Route test, added to the submit route's tests:
  - `Server-Timing` is present only when `process.env.REGISTER_SERVER_TIMING === "1"`;
  - the `register.submit.timing` log line is emitted in both cases;
  - assert on the log spy's payload keys `total`, `tx` and `pre_tx`.

- [ ] **Step 2: Run them and confirm they fail.** `cd apps/web && npx vitest run src/server/__tests__/timing.test.ts --reporter=json --outputFile=/tmp/t1.json`. Expected: collect error, since the module does not exist.
- [ ] **Step 3: Implement `createStageTimer`, then thread `timer?` through the route, `submitRegistrationGroup` (re-pin its exported name) and `mintGroupCheckout`.** When `timer` is undefined, each call site calls `fn()` directly. Do not allocate a no-op timer per call.
- [ ] **Step 4: Run the timing test and `registration-submit.test.ts` until both pass.** Confirm the existing submit cases' counts are unchanged.
- [ ] **Step 5: Mutate.** Make `header()` always return `""`. Confirm the env-gated route test fails. Revert.
- [ ] **Step 6: Commit** `feat(register): per-stage submit timing (log + env-gated Server-Timing)`.

### Task 2: Before-measurement on stg

Depends on the owner's answer to Q1. If B0 ships as its own PR, that PR is T1 only. Set `REGISTER_SERVER_TIMING=1` on the stg Fly app (`fly secrets set` — owner action).

**Files:**
- Create: `apps/web/e2e/probes/register-submit-timing.probe.ts`. Kept, not run by CI: the filename does not match the Playwright `testMatch`. Confirm in `playwright.config.ts`.
- Modify: spec §10 table.

- [ ] **Step 1:** Write the probe. It takes `E2E_TARGET`, an org/comp slug and `N` from env. It drives the public form for the three cart shapes in spec §3.2, reads `Server-Timing` off the register POST (`page.waitForResponse`), and records client marks for click, token, response and navigation. It prints a median/p90 table as markdown.
- [ ] **Step 2:** Run it against stg with N=10 per shape. stg data is test-only (standing rule). Delete the test competition's registrations afterwards.
- [ ] **Step 3:** Paste the table into spec §10 as "Before (stg, <date>, <sha>)" and onto the B0 sign-off page.
- [ ] **Step 4: Commit** `docs(register): submit latency baseline on stg`.

---

## Batch B1 — Latency fixes `[Opus]` (T6 `[Sonnet]`)

**Owner sign-off:** the after-table beside the before-table. Staged button text at 320 and 1280, in each phase. To screenshot a phase, hold it with a delayed route in the e2e harness.

**E2E greps:**
- `grep -a -rnE 'Continue to payment|Enter the competition|Enter —|reg-submit|register\.submit' apps/web/e2e`
- Known hits: `walkthrough/registration-connect.spec.ts:277`, `walkthrough/rs007-invite-pay-cancel.spec.ts:307`, `walkthrough/rs007-money-matrix.spec.ts:314`, `online-chess-desk.spec.ts:1736`, `helpers.ts`, `stripe-checkout-kit.ts`, `mobile.spec.ts`.
- The submit-button regexes there must also accept the T6 phase labels, or must wait for the navigation instead of the label.

**Smoke:** `registrationOpenFlow`, `registrationPaidLoop`, `registrationPayPage`, `registrationWaitlistPromote`. They cover mint and mail.

### Task 3: Turnstile from form open, with explicit expiry `[Opus]`

**Files:**
- Modify: `apps/web/src/lib/turnstile-client.ts`
  - `TOKEN_WAIT_MS` at :39;
  - the callbacks at :106-111;
  - `token()` at :137-150.
- Modify: `apps/web/src/components/turnstile-widget.tsx` (:32-37)
- Modify: `apps/web/src/components/public-site/register/register-stepper.tsx`. Move `<TurnstileWidget>` out of the review branch (:531) to the stepper root.
- Test: `apps/web/src/lib/__tests__/turnstile-client.test.ts`, `apps/web/src/components/public-site/register/__tests__/register-stepper-interaction.test.tsx`

**Interfaces:**
- Produces: `export const TOKEN_MAX_AGE_MS = 270_000;` The controller tracks `issuedAt`. `token()` signature unchanged: `() => Promise<string | null>`.

- [ ] **Step 1: Failing tests** (fake `window.turnstile`, as the existing tests do):
  - `token() re-arms when the held token is older than TOKEN_MAX_AGE_MS`: a token is issued at t=0, then `now` is advanced to 271 000. `token()` calls `reset` once and resolves with the next issued token, not the stale one.
  - `expired-callback resets the widget`: firing `expired-callback` calls `reset` exactly once.
  - `render passes refresh-expired auto`.
  - `a token is never reused across two submits`: two `withTurnstile` calls in a row send two different tokens.
  - `the widget mounts on the first step`: rendering the stepper at step `who` renders the Turnstile container. Today it is absent until review.
- [ ] **Step 2: Run them and confirm the 5 new cases fail.**
- [ ] **Step 3: Implement.**
  - In the expired callback: `issuedAt = null; token = null; widget.reset()`.
  - In `token()`: when a token is held and `now() - issuedAt > TOKEN_MAX_AGE_MS`, treat it as absent and call `reset()` before waiting.
  - The widget container at the stepper root gets `aria-hidden` and a 0×0 box, not `display:none`, because Turnstile needs a laid-out node.
- [ ] **Step 4: Run them and confirm they pass.** `turnstile-ci-wiring.test.ts` must also stay green.
- [ ] **Step 5: Mutate.** Delete the age check. Confirm "re-arms when older" fails. Revert.
- [ ] **Step 6: Commit** `perf(register): arm Turnstile at form open and re-arm stale tokens`.

### Task 4: Parallel pre-transaction reads `[Opus]`

**Files:**
- Modify: `apps/web/src/server/usecases/registration-submit.ts` (:485, :508, :618-626, :667, :685)
- Test: `apps/web/src/server/usecases/__tests__/registration-submit.test.ts`

**Interfaces:**
- Consumes: T1's `timer`.
- Produces: no signature change.

- [ ] **Step 1: Failing tests.**
  - `requireFeature(registration.paid) runs once for a cart with two paid card divisions`. Spy on the entitlements module and assert the call count is 1. Today it is 2.
  - `pre-tx statements for a 3-division cart do not exceed the 1-division count + 0 serial round trips`. Use `statementCount()` from `lib/db.ts` around the pre-tx section. Assert the **total** is unchanged or lower; it must not rise. This is not a concurrency proof. Concurrency is proven by the next test.
  - `pre-tx division reads overlap`. Wrap the `sql` used by `loadEntryDivisionCtx` with a delay of 50 ms per query. Assert that a 3-division submit's pre-tx stage (from T1's timer summary) is under 2× 50 ms, not 3× 50 ms.
  - `error precedence is cart order`. Use a cart [A closed-window, B payments-unavailable] and assert the 422 message is A's. Then swap the order and assert it is B's.
  - Sequence: `a second identical submit` still behaves as today (no dedupe added). `an empty cart` is refused by the existing guard before any read. Assert no division read is issued.
- [ ] **Step 2: Run them and confirm they fail** (the count and overlap tests).
- [ ] **Step 3: Implement.**
  - `Promise.allSettled` over distinct division ids for ctx and settings.
  - Then iterate results in cart order and throw the first rejection.
  - Hoist `requireFeature` out of the loop: call it once when any paid card division is present.
  - Seat gates: `Promise.allSettled` over online divisions, with the same ordered rethrow.
- [ ] **Step 4: Run them and confirm they pass**, along with every existing `registration-submit.test.ts` and `registration-concurrency.test.ts` case.
- [ ] **Step 5: Mutate.** Replace the ordered rethrow with a "first settled" rethrow. Confirm "error precedence" fails. Revert.
- [ ] **Step 6: Commit** `perf(register): parallelise pre-transaction reads, entitlement once`.

### Task 5: Cart mail after the response; known cart into the mint `[Opus]`

**Files:**
- Modify: `.../register/route.ts` (:103-110, :126)
- Modify: `apps/web/src/server/usecases/registrations/checkout.ts` (`mintGroupCheckout` :457-475)
- Modify: `registration-submit.ts`. The return gains `known_cart`.
- Test: `apps/web/src/server/usecases/__tests__/registration-pay-page-checkout.test.ts`, `registration-confirmation-outbox.test.ts` and the route test

**Interfaces:**
- Produces:

  ```ts
  export type KnownCart = { paymentMethod: "stripe" | "offline" | null; payableIds: string[]; ctx: DivisionCtx };
  export async function mintGroupCheckout(groupId: string, divisionId: string, origin: string, token: string, known?: KnownCart, timer?: StageTimer): Promise<string | null>;
  ```

  The submit result gains `known_cart: KnownCart`, built from the in-tx values:
  - the group's final `payment_method` (written at :1001);
  - entries with `status === "pending" && amount_cents > 0` in cart order;
  - the ctx loaded at :485 for `entries[0].division_id`.

- [ ] **Step 1: Failing tests.**
  - `mint with known cart issues 3 fewer statements than without`, via `statementCount()` deltas, same cart.
  - `mint with known cart creates the same Stripe session params`. Spy on `checkout.sessions.create` and deep-equal the params of both calls, except the idempotency key if any.
  - `known.payableIds empty returns null without a Stripe call`. This is the empty case.
  - `known.paymentMethod offline returns null`.
  - `route replies before the cart mail is enqueued`. Stub `notifySubmitted` with a never-resolving promise. The route still returns 201. Assert the response arrives, and that `deferred` was handed the task (spy on `lib/deferred`).
  - `cart mail still enqueued exactly once after a submit`. Await the deferred queue, then assert one outbox row. This is a second-call check: two submits give two rows, one each.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
  - When `known` is present, skip the reads at :463, :466 and :471, and use `known.payableIds` / `known.ctx`.
  - Keep the `charges_enabled` 503 guard on `known.ctx`.
  - In the route, pass `result.known_cart`, and replace `await notifySubmitted(...)` with `deferred(() => notifySubmitted(...))`.
- [ ] **Step 4: Run them and confirm they pass.** Then grep for tests that read the outbox straight after a route-level submit:

  `grep -a -rln "notifySubmitted\|email_outbox" apps/web/src/server/usecases/__tests__ apps/web/src/app/api`

  Make each of them await the deferred work. Use the existing deferred test helper if one exists. Otherwise add `flushDeferred()` to `lib/deferred.ts`, exported for tests only, guarded by `process.env.VITEST`.
- [ ] **Step 5: Mutate.**
  - Make `mintGroupCheckout` ignore `known.payableIds` and re-read anyway. Confirm the statement-count test fails. Revert.
  - Put the `await` back on `notifySubmitted`. Confirm "route replies before" fails. Revert.
- [ ] **Step 6: Commit** `perf(register): cart mail after response, mint reuses the written cart`.

### Task 6: Staged submit button text `[Sonnet]`

**Files:**
- Modify: `register-stepper.tsx` (`handleSubmit` :422-446, button :602-609, `submitLabel` :353-358)
- Modify: 4× `ui.json`. Add `register.submit.saving` = "Saving your place…" and `register.submit.openingPayment` = "Opening secure payment…".
- Test: `register-stepper-interaction.test.tsx`

**Interfaces:**
- Produces: `type SubmitPhase = "idle" | "saving" | "opening_payment"`, local to the stepper.

- [ ] **Step 1: Failing tests.**
  - `submit shows Saving your place while the POST is in flight`.
  - `card cart shows Opening secure payment after a 201 with checkout_url and before location.assign`. Stub `location.assign` and assert the label at the moment of the call.
  - `free cart never shows Opening secure payment`.
  - `an error returns the label to the ready text and re-enables the button`.
  - `the button stays disabled across both phases`. This guards against a double submit.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement the phase state and wire the labels.**
- [ ] **Step 4: Run them and confirm they pass.** Run `npm run i18n:gen-keys && npm run i18n:check`.
- [ ] **Step 5: Update the e2e regexes** found by the B1 grep so they accept the phase labels or wait on navigation. Run `walkthrough/registration-connect.spec.ts` locally against a prod build (seazn-local-env skill).
- [ ] **Step 6: Commit** `feat(register): staged submit button text`.

**Batch gate:**
- Re-run the T2 probe on stg after merge, or per the Q1 answer.
- Put the after-table in spec §10.
- Opus reviewer over the B1 diff, answering the four TEST-STRATEGY questions in writing.

---

## Batch B2 — Register form polish `[Sonnet]`

**Owner sign-off:** each of the 5 steps at 320, 768 and 1280. Also:
- header scrolled at 320;
- the sticky bar with a cart;
- the Contact error summary;
- the Review step with Edit links;
- the 4-step variant (one division, collapsed).

**E2E greps:**
- `grep -a -rnE '"Next"|name: "Next"|Back|reg-back|reg-next|reg-who-playing|reg-consent|Step [0-9] of|register\.nav' apps/web/e2e`
- Known hits:
  - `mobile.spec.ts:4930-4977` (`name: "Next", exact: true`)
  - `walkthrough/registration-connect.spec.ts:206,225,258,266`
  - `walkthrough/rs007-registration-journey.spec.ts`
  - `walkthrough/rs007-invite-pay-cancel.spec.ts`
  - `walkthrough/rs007-money-matrix.spec.ts`
  - `walkthrough/rs010-registration-cross-flow.spec.ts`
  - `walkthrough/rs012-solo-signup-pool.spec.ts`
  - `online-chess-desk.spec.ts`
  - kits `rs007-money-kit.ts`, `helpers.ts`, `stripe-checkout-kit.ts`
- Selectors move from the name "Next" to `getByTestId("reg-next")`, because the label becomes "Continue to …". Do not loosen them to a regex.
- `mobile.spec.ts` is serial (AGENTS.md class 21). Run the whole file, and treat its first red as a floor.

### Task 7: Stepper S1 and page heading `[Sonnet]`

**Files:**
- Modify: `apps/web/src/components/public-site/register/step-nav.tsx`
- Modify: `register-stepper.tsx` (mount point :458)
- Modify: `apps/web/src/app/(public)/live/[orgSlug]/[competitionSlug]/register/page.tsx` (heading)
- Modify: 4× `ui.json`. Add `register.nav.nextLabel` "Next: {name}", `register.nav.lastStep` "Last step" and `register.nav.contact` "Contact". The visible label for step `who` becomes "Contact"; keep the key `register.nav.who` if specs read it. `register.heading.closes` is "Registration closes {when}".
- Test: `apps/web/src/components/public-site/register/__tests__/step-nav.test.tsx` (new), `steps.test.ts`

**Interfaces:**
- Produces: `StepNav({ order, currentIndex, onJump?: (index: number) => void })`. `onJump` is only invoked for done steps at md+.
- Produces: `sharedClosesAt(divisions: DivisionLike[]): string | null`. Defined in `steps.ts`. It returns the common `closes_at` of the open divisions, or null when they differ or there are none (spec FP10). Empty case first.

- [ ] **Step 1: Failing tests.**
  - `phone header reads Step 2 of 5 and Next: Details on entries`.
  - `the 4-step order reads Step 2 of 4 on details`. Build the order with `buildStepOrder(1, "individual")` so the expected value comes from the real builder.
  - `last step reads Last step`.
  - `progressbar aria-valuenow/max follow order`.
  - `done steps at md are buttons that call onJump; upcoming steps are not buttons`.
  - `sharedClosesAt returns null for [] and for differing values`.
  - Class scan: the phone block carries `md:hidden` and the `<ol>` carries `max-md:hidden`. Anchor the regex on `\s…hidden"` (AGENTS.md: `/\bmd:hidden\b/` matches inside `max-md:hidden`).
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement** (spec §7.1).
- [ ] **Step 4: Run them and confirm they pass.** Then run gen-keys and check.
- [ ] **Step 5: Mutate.** Hard-code `total = 5`. Confirm the 4-step test fails. Revert.
- [ ] **Step 6: Commit** `feat(register): S1 phone stepper and competition heading`.

### Task 8: Action bar, Continue-to labels, header scroll-away `[Sonnet]`

**Files:**
- Modify: `register-stepper.tsx` (row :591-612). Phone: `sticky bottom-0` bar. md+: card footer.
- Modify: `apps/web/src/app/(public)/live/[orgSlug]/layout.tsx` (:75 header; root wrapper gets `group/site`)
- Modify: 4× `ui.json`. Add `register.nav.continueTo` "Continue to {step}", `register.bar.summary` "{count, plural, one {# entry} other {# entries}} · {total}" and `register.submit.pay` "Pay {fee} and enter". Retire `register.submit.card` from the UI. Delete the key only if `grep -a -rn "register.submit.card" apps/web` finds no other reader.
- Test: `register-stepper-interaction.test.tsx`, `apps/web/src/app/(public)/live/[orgSlug]/__tests__/layout-header.test.tsx` (new, class scan)

- [ ] **Step 1: Failing tests.**
  - `Back is absent on step 1` (`queryByTestId("reg-back")` is null), and present on step 2.
  - `primary reads Continue to Entries on Contact`, and `Continue to Details on Entries`.
  - `review primary reads Pay £15.00 and enter for a card cart, Enter the competition when free, Enter — £15.00 for offline`.
  - `bar summary hidden for an empty or free cart, shows 1 entry · £15.00 otherwise`.
  - `exactly one reg-next in the DOM` (one DOM, no phone twin).
  - Layout class scan: the header carries `max-md:group-has-[[data-register-flow]]/site:static`, and the root carries `group/site`. The stepper root has `data-register-flow`. The status page has no `data-register-flow` (render the status page and assert the attribute is absent).
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement** (spec §7.2). Give the register column bottom padding equal to the bar height, so the last field is never under the bar.
- [ ] **Step 4: Run them and confirm they pass**, then gen-keys and check.
- [ ] **Step 5: Browser check at 320, 768 and 1280** (prod build, local env):
  - At 320 the header scrolls away and the bar stays.
  - With the email field focused at 375×667, the field is visible above the bar (Review Focus 5).
  - No horizontal scroll at 320.
  - Capture for sign-off.
- [ ] **Step 6: Update the B2 e2e selectors** to use `reg-next`, and run `walkthrough/registration-connect.spec.ts` and the whole of `mobile.spec.ts`.
- [ ] **Step 7: Commit** `feat(register): sticky action bar, named Continue, header scrolls away on phones`.

### Task 9: Contact and Details polish `[Sonnet]`

**Files:**
- Modify: `step-who.tsx` (errors at :69, :96, :140, :172; checkbox at :111)
- Modify: `step-details.tsx`, `entry-details.tsx`, `form-fields.tsx`
- Modify: 4× `ui.json`. Add `register.errors.summary` "{count, plural, one {# thing} other {# things}} to fix before you continue: {list}", `register.who.email.invalid` "Enter an email address, like name@example.com", `register.who.playing.title` "I'm one of the players", `register.who.playing.body`, `register.details.you` "That's you. Change it on the Contact step.", `register.details.questionsFrom` "Questions from {org}" and `register.field.optional` "Optional".
- Test: `register-stepper-interaction.test.tsx`, `entry-details.test.tsx`

- [ ] **Step 1: Failing tests.**
  - `a failed Continue on Contact focuses an alert naming both missing fields`.
  - `invalid fields carry aria-invalid`.
  - `the playing card's label wraps the reg-who-playing input` (clicking the card text toggles it).
  - `with imPlaying, details shows player 1 read-only as the contact name`.
  - `without imPlaying, player 1 is an editable input` (both directions).
  - `optional organiser fields carry Optional, required ones do not` (derived from each field's `required` flag in the fixture's `form_fields`).
  - `zero organiser questions renders no Questions heading` (empty case).
- [ ] **Steps 2–4: Run them and confirm they fail, implement, run them and confirm they pass, then gen-keys and check.**
- [ ] **Step 5: Mutate.** Drop the `imPlaying` branch. Confirm the read-only test fails. Revert.
- [ ] **Step 6: Commit** `feat(register): contact error summary, playing card, single details card`.

### Task 10: Consent and Review polish `[Sonnet]`

**Files:**
- Modify: `step-consent.tsx` (:80, :101, :111, :142, :154)
- Modify: `step-review.tsx`, `cart.ts` (`summarizeCart` :538, only if the summary lacks contact, answers or consent; extend the `CartSummary` type at :496)
- Modify: 4× `ui.json`. Add `register.consent.required` "Required", `register.consent.optional` "Optional", `register.review.title` "Review and pay", `register.review.edit` "Edit", the section titles You, Entries, Answers and Consent, `register.review.cardNote` and `register.review.sentTo` "Confirmation goes to {email}".
- Test: `register-stepper-interaction.test.tsx`, `cart.test.ts`

**Interfaces:**
- Produces: `CartSummary` gains `contact: { name: string; email: string }`, `answers: { label: string; value: string }[]` and `consents: { media: boolean | null }`.

- [ ] **Step 1: Failing tests.**
  - `each consent shows Required or Optional`.
  - `review lists contact, every entry with players, answers, consent`.
  - `each Edit jumps to its step and the field values survive the round trip` (go to Entries via Edit, return, the values are unchanged).
  - `review with no organiser questions omits Answers` (empty case).
- [ ] **Steps 2–5: Run them and confirm they fail, implement, run them and confirm they pass, then gen-keys and check. Mutate:** make Edit always jump to step 0, and confirm the jump test fails.
- [ ] **Step 6: Commit** `feat(register): consent tags and a full review with edit links`.

**Batch gate:**
- Sign-off page with every step at 3 widths.
- Opus review of B2.

---

## Batch B3 — Capacity and waitlist `[Opus]` (T12's card UI part may go `[Sonnet]` after the data lands)

**Owner sign-off:**
- the Entries cards in all 5 states at 320 and 1280;
- the cart with a waitlisted entry;
- the status card "You're #2 on the waiting list".

**E2E greps:**
- `grep -a -rnE 'waitlist|Waitlist|waiting list|places left|reg-division' apps/web/e2e`
- Known hits: `helpers.ts`, `payments-hardening.spec.ts`, `registration-hub.spec.ts`, `registration-public-api.spec.ts`, `walkthrough/rs007-invite-pay-cancel.spec.ts`, `walkthrough/rs010-registration-cross-flow.spec.ts`.
- `registration-public-api.spec.ts` asserts the public wire shape, so add `waitlisted` there.

**Smoke:** `registrationWaitlistPromote.ts` gains a status-page position assertion.

### Task 11: Capacity on the wire, plan-limit aware `[Opus]`

**Files:**
- Modify: `apps/web/src/server/usecases/registrations/settings.ts` (`publicRegistrationInfo` :321; `remaining` :392)
- Modify: `apps/web/src/server/api-v1/schemas/registration.ts:298` (add `waitlisted: z.number().int().nonnegative()`)
- Modify: `apps/web/src/components/public-site/register/types.ts:59` (`DivisionLike.waitlisted: number`)
- Test: `apps/web/src/server/usecases/__tests__/registration-public-info.test.ts`

- [ ] **Step 1: Failing tests.**
  - `remaining honours the plan limit when it is tighter than capacity`. Use capacity 32, plan limit 4 and 4 active, and expect `remaining 0, closed_reason "full"`. Derive the limit from `getLimit` on the fixture org, not a literal.
  - `remaining is null when both capacity and plan limit are null`.
  - `waitlisted count reaches the wire` (parse through the Zod schema).
  - `a solo sign-up does not reduce remaining` (existing RS012 rule; it must hold after the change).
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** Fetch `getLimit(org, "entrants.per_division.max", comp.id)` once, then compute `hardCap = min(capacity ?? ∞, planLimit ?? ∞)` and `remaining = hardCap === ∞ ? null : max(0, hardCap - active)`.
- [ ] **Step 4: Run them and confirm they pass**, along with `registrations-intake-gate.test.ts` and `registration-submit.test.ts`.
- [ ] **Step 5: Mutate.** Drop `planLimit` from the min. Confirm the first test fails. Revert.
- [ ] **Step 6: Commit** `fix(register): public places-left uses the same cap as submit`.

### Task 12: Card states and cart waitlist arithmetic `[Sonnet]`

**Files:**
- Create: `apps/web/src/components/public-site/register/capacity.ts`
- Modify: `division-card.tsx` (badges :162-177), `entry-cart.tsx`, `cart.ts` (`summarizeCart`), `step-review.tsx`
- Modify: 4× `ui.json`. Add `register.capacity.left` "{count, plural, one {# place left} other {# places left}}", `register.capacity.fullWaitlist` "Full · join the waiting list", `register.capacity.fullWaitlistCount` "Full · join the waiting list ({count} waiting)", `register.capacity.joinWaitlist` "Join waiting list" and `register.cart.waitlistLine` "Waiting list — not charged now".
- Test: `apps/web/src/components/public-site/register/__tests__/capacity.test.ts` (new), `division-card.test.tsx`, `cart.test.ts`

**Interfaces:**
- Produces:

  ```ts
  export type CapacityState =
    | { kind: "closed" } | { kind: "waitlist"; waiting: number }
    | { kind: "few"; left: number } | { kind: "places"; left: number } | { kind: "uncapped" };
  export function capacityState(d: Pick<DivisionLike, "open" | "remaining" | "waitlisted">, inCart: number): CapacityState;
  export function cartWaitlisted(entries: { division_id: string }[], remainingById: ReadonlyMap<string, number | null>): boolean[]; // per entry, cart order
  ```

  `inCart` reduces `left`: a division with 3 left and 1 already in the cart shows 2.

- [ ] **Step 1: Failing tests.**
  - The `capacityState` table, with rows from spec §4.1 and the closed case first. `remaining 3` gives `few`, `remaining 4` gives `places`, and `remaining 0` with open gives `waitlist`.
  - `waitlist with 0 waiting omits the count`.
  - `second entry beyond remaining is waitlisted in the cart and excluded from total` (Review Focus 2): one place left and 2 entries gives `[false, true]`, and the total equals one fee.
  - `remaining null never waitlists`.
  - `closed card's CTA is disabled; waitlist card's CTA reads Join waiting list`.
  - `a free-agent entry is never marked waitlisted by cartWaitlisted` (spec FP2).
- [ ] **Steps 2–4: Run them and confirm they fail, implement, run them and confirm they pass, then gen-keys and check.**
- [ ] **Step 5: Mutate.** Change `≤ 3` to `< 3`. Confirm the `remaining 3` row fails. Revert.
- [ ] **Step 6: Commit** `feat(register): capacity states and waitlist-aware cart`.

### Task 13: Waitlist position, one order everywhere `[Opus]`

**Files:**
- Modify: `apps/web/src/server/usecases/registrations/waitlist.ts`. Add `waitlistPositionSql` next to `promoteNext` (:98).
- Modify: `group-status.ts` (`GroupEntryView` :31 gains `waitlist_position: number | null`; the select near :262)
- Modify: `list.ts:328-331` (use the helper)
- Modify: `apps/web/src/app/(public)/live/[orgSlug]/[competitionSlug]/register/status/entry-card.tsx` (waiting note :335)
- Modify: 4× `ui.json`. Add `register.status.waitlistPosition` "You're #{n} on the waiting list".
- Test: `registration-status-read.test.ts`, `registration-list-read.test.ts`, `status/__tests__/entry-card.test.tsx`

**Interfaces:**
- Produces: `export function waitlistPositionSql(tx: Sql, alias: string): Fragment`. Its order is identical to `promoteNext`'s `order by coalesce(waitlisted_at, created_at), id`.

- [ ] **Step 1: Failing tests.**
  - `position matches the promotion order after a demotion`:
    - Create waitlisted A at t1 and B at t2.
    - Promote A, then demote A back to waitlisted. This sets `waitlisted_at = t3`. Use the real usecases, not raw SQL updates.
    - Expect B=#1 and A=#2 on both the status view and the organiser list.
    - Then call `promoteNext` and assert it picks the #1 entry. The expected value comes from the engine's own queue.
  - `non-waitlisted entries have null position`.
  - `a withdrawn waitlisted entry no longer counts` (sequence: after withdraw, B moves to #1).
  - `entry card shows You're #2 on the waiting list`.
- [ ] **Steps 2–4: Run them and confirm they fail, implement, run them and confirm they pass, then gen-keys and check.**
- [ ] **Step 5: Mutate.** Swap the helper's order back to `(created_at, id)`. Confirm the demotion test fails. Revert.
- [ ] **Step 6: Commit** `feat(register): waitlist position on the status page, same order as promotion`.

**Batch gate:**
- Run the smoke suite `registrationWaitlistPromote`.
- Opus review.
- Sign-off screenshots.

---

## Batch B4 — Status page `[Opus]` (T16 `[Sonnet]`)

**Owner sign-off:** the status page at 320, 768 and 1280 for each headline kind (`pay`, `in`, `received`, `waitlist`, `closed`), for a partially paid cart, and for the invite block at 320.

**E2E greps:**
- `grep -a -rnE 'register/status|Your registration|Subtotal|subtotal|reg-status-|reg-invite|Resend|Cancel this entry' apps/web/e2e`
- Known hits: `mobile.spec.ts`, `rs007-money-kit.ts`, `walkthrough/live-public-path.spec.ts`, `walkthrough/rs007-invite-pay-cancel.spec.ts`, `walkthrough/rs007-registration-journey.spec.ts`, `walkthrough/rs012-solo-signup-pool.spec.ts`, `walkthrough/registration-connect.spec.ts`, `walkthrough/rs007-money-matrix.spec.ts`, `walkthrough/rs010-registration-cross-flow.spec.ts`.

**Smoke:** `registrationPaidLoop.ts` asserts "Paid £X" after the paid loop.

### Task 14: Status data — dates, venue, settlement `[Opus]`

**Files:**
- Modify: `apps/web/src/server/usecases/registrations/group-status.ts`
  - `GroupStatusView` :119 gains `competition_name`, `competition_starts_on`, `competition_ends_on` and `venue_name`.
  - `GroupEntryView` gains `settled_by`.
  - `starts_on` is already selected at :230.
- Test: `apps/web/src/server/usecases/__tests__/registration-status-read.test.ts`

**Interfaces:**
- Produces:
  - `GroupStatusView.competition_starts_on: string | null` (ISO date)
  - `GroupStatusView.competition_ends_on: string | null`
  - `GroupStatusView.venue_name: string | null`
  - `GroupEntryView.settled_by: "card" | "offline" | "waived" | null`

- [ ] **Step 1: Failing tests.**
  - `venue_name is the single venue all scheduled fixtures share`.
  - `venue_name is null with two venues`.
  - `venue_name is null with no fixtures`.
  - `settled_by is waived after the real confirmRegistrationWaived`.
  - `settled_by is offline after markRegistrationPaidOffline`.
  - `settled_by is card after a webhook-fulfilled group checkout for both entries of a 2-entry cart`. Drive the existing webhook-fulfilment helper from `registration-webhook-fulfilment.test.ts`.
  - `settled_by is null for a pending entry`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
  - Get the venue with the `limit 2` query in spec §5.2.
  - Get `settled_by` from the latest event per registration among pay-page.ts `PAID_EVENT_TYPES`. Before writing the predicate, read which event and payload each settle path writes, and pin it.
- [ ] **Step 4: Run them and confirm they pass**, along with `registration-status-truth-read.test.ts`.
- [ ] **Step 5: Mutate.** Map `fee_waived` to `card`. Confirm the waived test fails. Revert.
- [ ] **Step 6: Commit** `feat(register): status view carries dates, venue and how each entry settled`.

### Task 15: Headline, reference hero, next steps, money line `[Opus]`

**Files:**
- Modify: `status/view-model.ts` (next to `cartSubtotal` :153)
- Modify: `status/page.tsx` (h1 :171, ref :173-174, subtotal :199-213, resend :180)
- Modify: `entry-card.tsx` (cancel :438 becomes a quiet link)
- Modify: 4× `ui.json`. Add `register.status.headline.{pay,in,received,waitlist,closed}`, `register.status.sentTo`, `register.status.refLabel` "Your reference", `register.status.copyRef` "Copy reference", `register.status.copied` "Copied", `register.status.next.title` "What happens next", `register.status.next.{starts,runs,venue,payBy,pay,received,waitlist,invite,done}`, `register.status.money.{paidDue,paid,due,nothing}` (paidDue = "Paid {paid} · {due} still due") and `register.status.cancelEntry` "Cancel this entry".
- Test: `status/__tests__/view-model.test.ts`, `status/__tests__/status-page.test.tsx`

**Interfaces:**
- Produces:

  ```ts
  export type HeadlineKind = "pay" | "in" | "received" | "waitlist" | "closed";
  export function cartHeadline(entries: StatusEntry[], cart: { expires_at: string | null; charges_enabled: boolean }): HeadlineKind;
  export type NextItem = { kind: "dates" | "venue" | "step"; key: string; vars: Record<string, string> };
  export function whatHappensNext(view: GroupStatusView, headline: HeadlineKind): NextItem[];
  export type MoneySummary = { paidCents: number; dueCents: number; waitlistedCents: number };
  export function cartMoneySummary(entries: StatusEntry[], cart: { expires_at: string | null; charges_enabled: boolean }): MoneySummary;
  ```

- [ ] **Step 1: Failing tests.**
  - `cartHeadline([]) is closed`. This is the empty case, first.
  - One row per spec §5.1 rule, plus the precedence pairs:
    - pending-due + confirmed → `pay`
    - confirmed + waitlisted → `in`
    - paid + waitlisted → `received`
    - only withdrawn → `closed`
  - `whatHappensNext` returns `[]` for no dates, no venue and `closed`.
  - `whatHappensNext` returns `dates` with `runs` when `ends_on` differs and `starts` when they are equal.
  - `whatHappensNext` never contains the words "email" or "check in" in any locale. Sweep all 4 dictionaries' `register.status.next.*` values. The sweep must report a count > 0 checked.
  - `cartMoneySummary`, partial: 2 entries, one `settled_by card` £15 and one pending stripe-due £24, gives paid 1500 and due 2400.
  - `cartMoneySummary`, waived entry: paid 0 and due 0.
  - `cartMoneySummary`, refunded: £15 paid with £5 refunded gives paid 1000.
  - `cartMoneySummary`, `window_closed`: counted in due.
  - Page render: "Paid £15.00 · £24.00 still due".
  - Page render: `reg-status-ref` holds the cart ref and a Copy button.
  - Page render: Cancel renders as a link-styled button inside the card footer, not a filled button.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement** (spec §5.1–5.3).
- [ ] **Step 4: Run them and confirm they pass**, along with `entry-card-status-truth.test.tsx` and `cancel-entry.test.tsx`. Then gen-keys and check.
- [ ] **Step 5: Mutate.**
  - Move the `pay` rule below `in`. Confirm "pending-due + confirmed → pay" fails.
  - Count `waived` as paid. Confirm the waived test fails.
  - Revert both.
- [ ] **Step 6: Update the B4 e2e hits**, then run `walkthrough/rs007-invite-pay-cancel.spec.ts` and `walkthrough/rs007-registration-journey.spec.ts`.
- [ ] **Step 7: Commit** `feat(register): status page leads with outcome, reference and real next steps`.

### Task 16: Invite block restyle at 320 `[Sonnet]`

**Files:**
- Modify: `status/invite-teammates.tsx` (rows :156-186; chips :31-32)
- Test: `status/__tests__/invite-teammates.test.tsx`

- [ ] **Step 1: Failing test.** Class scan: each row wrapper has `flex-wrap`, the name has `truncate`, and every ancestor from the row up to the card has `min-w-0`. Walk the rendered tree and report the count of ancestors checked, which must be > 0.
- [ ] **Steps 2–4: Run it and confirm it fails, implement, run it and confirm it passes.**
- [ ] **Step 5: Browser check at 320** with a 43-character teammate name: no horizontal scroll, and the chip sits under the name. Capture it.
- [ ] **Step 6: Commit** `fix(register): invite rows wrap their status at 320`.

**Batch gate:** Opus review, then sign-off.

---

## Batch B5 — Per-entry reference `[Opus]`

**Owner sign-off:**
- the status page of a 3-entry cart, with suffixes on the cards;
- the pay page for entry 2 showing `…-2` in the offline instructions;
- the reminder mail render;
- the organiser search for `SZ-…-2` finding one row;
- a 1-entry cart with no suffix.

**E2E greps:**
- `grep -a -rnE 'ref_code|refCode|SZ-|regPay\.reference|Reference' apps/web/e2e`
- Known hits: `pay-page-kit.ts`, `registration-pay-page.spec.ts`, `registration-public-api.spec.ts`, `walkthrough/registration-pay-page-card.spec.ts`, `outbox-body-open.ts`.
- `board-round-codes.spec.ts` matches "SZ-" by accident. Confirm it is unrelated and leave it.

**Smoke:** `registrationPayPage.ts` asserts the suffixed ref on a 2-entry cart's per-entry pay page.

### Task 17: `cart_position` column and reference helpers `[Opus]`

**Files:**
- Create: `db/migration/deltas/V519__registration_cart_position.sql` (planned as V515, shipped as V517, renumbered to V518 then V519 at the two pre-PR rebases). Re-check the highest V after the rebase: `ls db/migration/deltas | tail -1`.
- Modify: `apps/web/src/server/usecases/registration-submit.ts` (inserts at :853 and :873 set `cart_position`)
- Modify: `apps/web/src/lib/ref-code.ts` (helpers next to `formatRefCode` :31)
- Test: `apps/web/src/lib/__tests__/ref-code.test.ts`, `apps/web/src/server/usecases/__tests__/registration-cart-entry-order.test.ts`

**Interfaces:**
- Produces:

  ```ts
  export function entryReference(refCode: string, position: number, cartSize: number): string;
  export function parseEntryReference(input: string): { refCode: string; position: number | null } | null;
  ```

- Produces: `registrations.cart_position smallint not null`, unique `(group_id, cart_position)`.

- [ ] **Step 1: Failing tests.**
  - `entryReference(ref, 1, 1)` is `ref`, and `entryReference(ref, 2, 3)` is `` `${ref}-2` ``.
  - `parseEntryReference(" sz-abcd-efgh-2 ")` gives `{ refCode: "SZ-ABCD-EFGH", position: 2 }`. Use letters from the real alphabet at `ref-code.ts:13`; if A, E or I are excluded there, build the input from `generateRefCode()`.
  - `parseEntryReference("hello")` is null.
  - `parseEntryReference(ref + "-0")` is null (positions start at 1).
  - `submit stamps cart_position 1..N in cart order`.
  - `cart_position survives deleting a sibling's division` (Review Focus 3):
    - Submit a 3-entry cart over 3 divisions.
    - Delete division 2 through the real `deleteDivision`.
    - The remaining entries keep positions 1 and 3.
  - `cart_position never changes on withdraw`.
- [ ] **Step 2: Run them and confirm they fail.** Apply the migration to the local test DB per the seazn-local-env skill (`db:apply` **and** `sync:sports`).
- [ ] **Step 3: Implement the migration** (spec §6.1, with a loud header noting the backfill and that prod has 0 rows), **the submit stamping and the helpers.**
- [ ] **Step 4: Run them and confirm they pass**, along with `registration-submit.test.ts` and `registration-concurrency.test.ts`.
- [ ] **Step 5: Mutate.** Stamp position 1 for every entry. Confirm the unique index fails the 2-entry submit, and that the "1..N" test fails. Revert.
- [ ] **Step 6: Commit** `feat(register): store each entry's cart position (V515)`.

### Task 18: Suffixed reference on the pay page, instructions, mails and status cards `[Opus]`

**Files:**
- Modify: `apps/web/src/server/usecases/registrations/lookups.ts:26`. `regGroupCols` gains `r.cart_position` and `(select count(*) from registrations s where s.group_id = g.id)::int as cart_size`.
- Modify: `pay-page.ts:172-174` (`refCode` and `fillPaymentInstructions` take `entryReference(...)`)
- Modify: `components/registrations/pay-page-view.tsx:116-121,186`
- Modify: `mail.ts:444,485` (`paymentReminderMessage`)
- Modify: `email-templates/registration-promoted.ts:49` and its caller
- Modify: `group-status.ts`. `GroupEntryView` gains `entry_ref: string`.
- Modify: `status/entry-card.tsx`
- Modify: `status/page.tsx:126`. Offline instructions use the entry ref when exactly one entry is due.
- Test: `registration-pay-page-doc.test.ts`, `registration-lifecycle-mail.test.ts`, `registration-promoted-outbox.test.ts`, `registration-status-read.test.ts`, `status/__tests__/status-page.test.tsx`

- [ ] **Step 1: Failing tests.**
  - `pay page for entry 2 of a 2-entry cart shows ref-2 and fills {{reference}} with ref-2`.
  - `pay page for a 1-entry cart shows the bare ref`.
  - `payment reminder for entry 2 carries ref-2 in html and text`.
  - `promoted mail carries the entry ref`.
  - `cart mail still carries the bare cart ref` (unchanged).
  - `status card shows entry_ref only when cart_size ≥ 2`.
  - `status offline block uses entry ref when one entry is due and cart ref when several are`.
  - Sequence: `after withdrawing entry 1 of 2, entry 2 still shows ref-2` (cart size counts every status).
- [ ] **Steps 2–4: Run them and confirm they fail, implement, run them and confirm they pass.**
- [ ] **Step 5: Mutate.** Compute `cart_size` over live statuses only. Confirm the withdrawal test fails. Revert.
- [ ] **Step 6: Run** `registration-pay-page.spec.ts` and `walkthrough/registration-pay-page-card.spec.ts` after updating their ref assertions.
- [ ] **Step 7: Commit** `feat(register): per-entry reference on the pay page, instructions and reminder mails`.

### Task 19: Organiser search, detail and CSV `[Opus]`

**Files:**
- Modify: `apps/web/src/server/usecases/registrations/list.ts:375-377`
- Modify: `components/registration-hub-registrant-detail.tsx:165`
- Modify: `apps/web/src/server/usecases/exports.ts:986` (trailing column)
- Modify: 4× `ui.json`. Add `reg.detail.entryRef` "Entry reference", `reg.detail.cartRef` "Cart {ref}" and the CSV header `reg.csv.entryRef`. Check whether CSV headers are localised today; if they are English-only, follow that.
- Test: `registration-list-read.test.ts`, `registration-hub-registrant-detail.test.tsx`, the exports test (find it with `grep -a -rln "registrantsCsv\|ref_code" apps/web/src/server/usecases/__tests__`)

- [ ] **Step 1: Failing tests.**
  - `search by cart ref finds every entry of the cart`.
  - `search by ref-2 finds only entry 2`.
  - `search by a lowercase, spaced ref-2 finds entry 2`.
  - `search by ref-9 in a 2-entry cart finds nothing`.
  - `name search unchanged`.
  - `detail shows entry ref and Cart line for a 2-entry cart, only the ref for 1`.
  - `CSV gains a trailing Entry reference column; earlier columns unchanged`. Compare the header row to the previous header plus one.
- [ ] **Steps 2–4: Run them and confirm they fail, implement, run them and confirm they pass.**
- [ ] **Step 5: Mutate.** Drop the `cart_position` predicate. Confirm "finds only entry 2" fails. Revert.
- [ ] **Step 6: Commit** `feat(registration-hub): find, show and export the per-entry reference`.

**Batch gate:** smoke `registrationPayPage`, Opus review, sign-off (including the mail renders from the outbox body).

---

## Batch B6 — Filter bar A3 `[Sonnet]`

**Owner sign-off:** at 1280 and 768, nothing filtered and three filters set; at 320, the bar, the set chips and the open sheet. Show the URL bar in each capture.

**E2E greps:**
- `grep -a -rnE 'registration-hub-registrant-filters|select\[name=|name=\\"?(status|sort|kind|division_id|q)|Clear filters|Clear all|exportCsv|Export CSV' apps/web/e2e`
- Known hits: `registration-hub.spec.ts:824,1485-1531,1623-1663`, `mobile.spec.ts:4658-4783`, `walkthrough/rs010-registration-cross-flow.spec.ts:419`.
- At phone widths, these specs must open the Filters sheet before touching a select (AGENTS.md class 22). Wait on `toBeAttached` and gate the open on the button being visible.

### Task 20: A3 pill bar at md and up `[Sonnet]`

**Files:**
- Modify: `apps/web/src/components/registration-hub-registrant-filters.tsx` (form :225-360)
- Modify: `registration-hub-registrants-panel.tsx` (Export :141 moves; see T22's tab strip slot. Until B7 lands, keep it right-aligned on the tabs row via a prop.)
- Modify: 4× `ui.json`. Add `reg.filters.searchPlaceholder` "Search name, email or reference", `reg.filters.clearAll` "Clear all", `reg.filters.pill` "{label}: {value}", `reg.filters.clearOne` "Clear {label}" and `reg.filters.count` "{count, plural, one {# registrant} other {# registrants}}".
- Test: `apps/web/src/components/__tests__/registration-hub-registrant-filters.test.tsx`

**Interfaces:**
- Produces: `clearOneHref(current: URLSearchParams, name: FilterName): string`. It keeps `tab=registrants` and every other param.
- Produces: `clearAllHref(): string`, which returns `?tab=registrants`.

- [ ] **Step 1: Failing tests.**
  - `a set status pill reads Status: Confirmed`.
  - `an unset pill reads its bare label`.
  - `clearOneHref drops only that param and keeps tab`.
  - `clearAllHref is ?tab=registrants` (owner 1: bare URL, still on the tab).
  - `Clear all hidden when nothing is set`.
  - `every select keeps its name attribute`.
  - `no control has a stacked visible label` (each select has an `aria-label`).
  - `refresh round-trip`: render with `searchParams` `status=confirmed&consent_pending=1` and assert both pills show set. The URL is the state.
- [ ] **Steps 2–4: Run them and confirm they fail, implement, run them and confirm they pass, then gen-keys and check.**
- [ ] **Step 5: Mutate.** Make `clearOneHref` drop `tab`. Confirm the test fails. Revert.
- [ ] **Step 6: Commit** `feat(registration-hub): A3 filter pills`.

### Task 21: Phone Filters sheet `[Sonnet]`

**Files:**
- Modify: `registration-hub-registrant-filters.tsx`
- Use: `components/modal.tsx` in sheet mode (:43-152)
- Modify: 4× `ui.json`. Add `reg.filters.open` "Filters", `reg.filters.show` "Show registrants" and `reg.filters.sheetTitle` "Filters".
- Test: `registration-hub-registrant-filters.test.tsx`
- E2E: `mobile.spec.ts` (filter bar block :4658-4783)

- [ ] **Step 1: Failing tests.**
  - `Filters button shows the count of set filters, none when zero`.
  - `edits in the sheet do not navigate until Show registrants`. Assert the `router.push` spy is not called on a select change in the sheet, then called once on Show.
  - `sheet open state is not written to the URL`.
  - `the sheet holds status, division, kind, solo, consent and sort`.
  - Class scan: the pill row carries `max-md:hidden` and the Filters button carries `md:hidden`, anchored on `\s…hidden"`.
- [ ] **Steps 2–4: Run them and confirm they fail, implement, run them and confirm they pass, then gen-keys and check.**
- [ ] **Step 5: Update `mobile.spec.ts` and `registration-hub.spec.ts`** per the B6 grep. Run both whole files (mobile is serial; re-run until a full pass).
- [ ] **Step 6: Commit** `feat(registration-hub): Filters sheet on phones`.

**Batch gate:** Opus review, then sign-off.

---

## Batch B7 — Division settings as tabs `[Opus]`

**Owner sign-off:** the mock D frames rebuilt live at 1280 and 320:
- D1a, one tab open;
- D1b, two tabs with a dirty dot;
- D1c, both third-tab paths;
- D1d, × on a dirty tab;
- D1e, the phone strip scrolled.

Show the URL in each capture.

**E2E greps:**
- `grep -a -rnE 'row-configure|config-panel|accordion-section|data-save-outcome|data-action="(save|cancel)"|tab=settings|tab=registrants' apps/web/e2e`
- Known hits:
  - `registration-hub.spec.ts:102-112,140,211,259`
  - `mobile.spec.ts:740-741,2141-2142,4609-4637`
  - `fixture-config-snapshot.spec.ts`
  - `walkthrough/settings-registration-client-guards.spec.ts:184-202,360`
  - `walkthrough/registration-entrant-kinds.spec.ts:54-55,243`
  - `walkthrough/rs007-money-matrix.spec.ts:547,559`
  - `walkthrough/rs010-registration-cross-flow.spec.ts:148-150,333`
  - `walkthrough/settings-registration-bounds.spec.ts`
- The config panel is no longer a dialog. Specs that wait for `role=dialog` or close the modal must wait for `reg-hub-tab-division` plus the panel instead.

### Task 22: Hub tabs state module `[Opus]`

**Files:**
- Create: `apps/web/src/components/registration-hub-tabs-state.ts`
- Modify: `apps/web/src/lib/routes.ts:74`. `routes.competitionRegistration` gains an optional `open?: string[]` and accepts `tab: "settings" | "registrants" | \`division:${string}\``.
- Test: `apps/web/src/components/__tests__/registration-hub-tabs-state.test.ts` (new; fast-check is already a dependency)

**Interfaces:**
- Produces: exactly the signatures in spec §9.1. `parseHubTabs`, `hubTabsQuery`, `openDivision`, `activate` and `closeDivision` are all pure.

- [ ] **Step 1: Failing tests.**
  - `parseHubTabs({}, ∅)` is `{ active: "settings", open: [] }` (empty case first).
  - Unknown ids dropped; duplicates dropped; `open=a,b,c` keeps `[b,c]`.
  - `tab=division:x` with x not in open appends x and recaps.
  - `openable` empty (no canEdit) gives no division tabs and `settings`.
  - `openDivision` with 2 open evicts `open[0]` and reports it.
  - Opening an already-open id is a no-op on `open`, apart from moving it to the end.
  - `closeDivision` of the active tab gives active `settings`.
  - **Model test (fast-check).** Generate sequences of open, activate and close over 4 ids. After **every** step assert:
    - `open.length ≤ 2`;
    - there are no duplicates;
    - an active division is in `open`;
    - `parseHubTabs(hubTabsQuery(s), all)` deep-equals `s` (round trip).

    The property reports how many steps it checked, and a count of 0 fails. Commit any shrunk failure as a named case with its seed before fixing.
- [ ] **Steps 2–4: Run them and confirm they fail, implement, run them and confirm they pass.**
- [ ] **Step 5: Mutate.** Evict `open[1]` instead of `open[0]`. Confirm the LRU test fails. Revert.
- [ ] **Step 6: Commit** `feat(registration-hub): tab state for open division settings`.

### Task 23: Config panel as a page, with dirty tracking `[Opus]`

**Files:**
- Modify: `apps/web/src/components/registration-hub-config-panel.tsx`
  - signature :298 gains `layout: "modal" | "page"`;
  - Modal :445-469;
  - `Disclosure` :167-186;
  - section bodies :604, :827, :992, :1021, :1324.
- Create: `apps/web/src/components/use-config-dirty.ts`
- Modify: `use-registration-hub-config.ts` (expose the saved snapshot and `reset()`)
- Modify: 4× `ui.json`. Add `reg.config.allSaved` "All changes saved", `reg.config.unsaved` "{count, plural, one {# unsaved change} other {# unsaved changes}}", `reg.config.changed` "Changed" and `reg.config.sectionIndex` "Sections".
- Test: `apps/web/src/components/__tests__/registration-hub-config-panel.test.tsx`, `use-config-dirty.test.ts` (new)

**Interfaces:**
- Produces: `useConfigDirty(saved: ConfigDraft, draft: ConfigDraft): { dirty: boolean; count: number; sections: SectionId[] }`. It uses the same normalisers as save (re-pin them in `use-registration-hub-config.ts`).
- Produces: `RegistrationHubConfigPanel` props gain `layout` and `onDirtyChange?: (d: { dirty: boolean; count: number; sections: SectionId[] }) => void`.

- [ ] **Step 1: Failing tests.**
  - `editing capacity then restoring it is clean`.
  - `editing capacity and fee gives count 2, sections [capacity, money]`.
  - `Cancel resets to the last saved values and reports clean`.
  - `after a successful save the dirty state clears`.
  - `after put-failed the tab stays dirty` (sequence).
  - `page layout at md renders every details open with a section index linking each SECTION_IDS entry`.
  - `page layout renders no role=dialog`.
- [ ] **Steps 2–4: Run them and confirm they fail, implement, run them and confirm they pass, then gen-keys and check.**
- [ ] **Step 5: Mutate.** Compare raw values instead of normalised ones. Confirm "edit then restore is clean" fails, or record why the normaliser is the identity for that field and pick a field where it is not. Revert.
- [ ] **Step 6: Commit** `feat(registration-hub): division settings render as a page with dirty tracking`.

### Task 24: Tab strip, host, dialogs and history `[Opus]`

**Files:**
- Create: `apps/web/src/components/registration-hub-tab-strip.tsx` and `apps/web/src/components/registration-hub-tabs-host.tsx`
- Modify: `apps/web/src/app/o/[orgSlug]/c/[compSlug]/registration/page.tsx`
  - :51-78 `parseHubTabs` replaces `resolveRegistrationHubTab`;
  - :223-236 the strip;
  - load config rows for the ≤ 2 open divisions on every tab;
  - Export CSV goes in the strip's trailing slot (from T20).
- Modify: `registration-hub-settings-panel.tsx` (:64-90; `onOpen` navigates and the modal mount is deleted)
- Modify: `registration-hub-division-row.tsx:238-241` (labelled "Open settings")
- Modify: `registration-hub-config-panel.tsx` (delete `layout: "modal"` once nothing uses it)
- Modify: 4× `ui.json`. Add `reg.hub.row.openSettings` "Open settings", `reg.hub.tabs.label` "Registration sections", `reg.hub.tabs.close` "Close {name}", `reg.hub.tabs.unsaved` "Unsaved changes", `reg.hub.evict.title` "{name} has unsaved changes", `reg.hub.evict.body`, `reg.hub.evict.{save,discard,cancel}`, `reg.hub.close.title` "Close {name}?", `reg.hub.close.body` "You have {count} unsaved changes in {sections}.", `reg.hub.close.{save,discard,keep}`, `reg.hub.evicted` "Closed {name} to make room." and `reg.hub.reopen` "Reopen".
- Test: `apps/web/src/components/__tests__/registration-hub-tab-strip.test.tsx`, `registration-hub-settings-panel.test.tsx`, `registration-hub-tab.test.ts`
- E2E: new `apps/web/e2e/registration-hub-division-tabs.spec.ts`. Also update every B7 grep hit.

**Interfaces:**
- Consumes: T22 (state module) and T23 (`layout: "page"`, `onDirtyChange`).
- Produces: `RegistrationHubTabsHost({ state: HubTabsState; divisions: OpenDivisionConfig[]; children: { settings: ReactNode; registrants: ReactNode } })`.

- [ ] **Step 1: Failing unit tests.**
  - The strip has `role="tablist"` with an `aria-label` and `tabindex="0"` on the scroller.
  - Each division tab has `role="tab"`, a separate × button named "Close {name}", and a dirty dot only when dirty.
  - The name has `truncate` with `min-w-0` up to the strip.
  - Settings rows render the visible text "Open settings" and keep `data-registration-hub-row-configure`.
- [ ] **Step 2: Failing e2e** (`registration-hub-division-tabs.spec.ts`, at 1280 and 320 projects):
  - `open, edit capacity, switch to Registrants and back keeps the edit and shows the dot`. This proves spec §9.2's mount-persistence claim in a browser.
  - `reload restores both open tabs and the active one`.
  - `opening a third clean tab evicts the LRU, shows Closed X to make room, Reopen brings it back`.
  - `opening a third with a dirty LRU asks; Cancel keeps all; Discard and open swaps; Save and open saves then swaps` (the saved value is read back via the API).
  - `× on a dirty tab: Keep editing keeps it; Discard closes it; Save and close persists`.
  - `back off a dirty tab re-opens it with the close dialog` (Review Focus 4).
  - `320: the strip scrolls inside itself, no page horizontal scroll, × hit area is 44×44`. Use `elementFromPoint` at the × box edges, not `boundingBox` alone (AGENTS.md class 2).
  - axe on the hub with two tabs open has no serious issues (`scrollable-region-focusable`).
- [ ] **Step 3: Run them and confirm they fail.**
- [ ] **Step 4: Implement** (spec §9.2–9.4).
  - Use `beforeunload` while any tab is dirty.
  - In the Back handling, a `useEffect` on `open` compares the new `open` with the dirty set and `router.replace`s a dropped dirty id back in before showing the dialog.
- [ ] **Step 5: Run them and confirm they pass.** Run the new spec and every B7 grep hit, as whole files. Run `mobile.spec.ts` until a full pass.
- [ ] **Step 6: Mutate.**
  - Remove the dirty check from the evict path. Confirm the "dirty LRU asks" e2e fails.
  - Remove `beforeunload`, then the Back re-add, one at a time. Confirm each one's killer.
  - Revert all of them.
- [ ] **Step 7: Commit** `feat(registration-hub): division settings open as closable tabs`.

**Batch gate:** Opus review, then sign-off on the D frames.

---

## Wave close

- [ ] Rebase onto `main` once #1197 has merged.
  - Re-check the migration number (T17).
  - Re-run every scoped vitest path touched in the wave (union of the Test lines above), with the JSON reporter.
- [ ] Run the smoke suites named per batch, locally against a fresh DB (seazn-local-env), or via the PR's smoke CI.
- [ ] Open one PR. The body lists:
  - each batch;
  - the false premises (spec §0);
  - the `registration-submit.ts` split deferral;
  - the latency before and after tables.
- [ ] Dispatch e2e once on the branch (`gh workflow run e2e.yml --ref feat/registration-redesign -f pr=<n>`; always pass `--ref`).
  - Read every red.
  - Treat a serial file's count as a floor.
- [ ] Final whole-branch Opus review. It answers the four TEST-STRATEGY questions for each batch.
- [ ] Owner sign-off page on :8765, with per-screen verdicts and the timing tables. Merge when green after sign-off.
