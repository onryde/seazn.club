# Entitlements v18 — W4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close what W3 left owed — make the Event Pass money path actually
execute, give the enterprise tier and the moved V393 caps a browser proof,
instrument the three distribution quantities nobody has ever counted, meter
device-link refusals, de-flake nine anonymous e2e contexts, and rule on the
division tab rail at 320.

**Architecture:** Six independent lanes over one branch. Five change code or
config; one (N3) is an investigation that produces a verdict and a regression
gate. No lane depends on another's output, but N2 owns `playwright.config.ts`
exclusively — any other lane needing a config change queues behind it rather
than editing in parallel.

**Tech Stack:** Next.js (this repo's fork — read `node_modules/next/dist/docs/`
before writing route code), TypeScript, Playwright, Vitest, Postgres, PostHog
(`posthog-node`), Stripe test mode.

**Spec:** `docs/superpowers/specs/2026-09-07-entitlements-v18-w4-design.md`

## Global Constraints

- **Package manager is `pnpm`, never `npm`.**
- **Branch:** `docs/entitlements-w4-handoff`, worktree
  `/Users/ashokhein/github/seazn.club/.claude/worktrees/entw3`. Never check out
  in the main repo dir. In a worktree session use `/usr/bin/git`, and do not
  use `git stash` — the stash stack is shared with the main checkout.
- **Judge vitest only from `--reporter=json --outputFile`,** reading
  `numPassedTests` / `numTotalTests`. A suite that fails to COLLECT reports
  0 tests and 0 failures and looks clean. Run as `cd apps/web && pnpm vitest`,
  never with `--root apps/web`, and confirm `.testResults[].name` resolves
  inside the worktree before believing a count.
- **`rtk` wrappers lie.** `rtk` vitest summaries print `PASS(0) FAIL(0)` for a
  suite that failed to collect; `rtk` hides lint output; `rtk git diff`
  reformats. Use `rtk proxy` or `/usr/bin/git` for anything you will assert on.
- **`grep` reports source files here as `Binary file … matches`.** Always
  pass `-a`.
- **Every change ships a test that fails without it.** Mutate the guard —
  delete the predicate, `return true`, comment out the call — and confirm red.
  Report the killer list per mutant, not a count.
- **Any new or changed user-facing string → all 4 locale dictionaries**
  (`apps/web/src/dictionaries/{en,es,fr,nl}/`), never hardcoded English, then
  `pnpm i18n:gen-keys` (`apps/web/src/lib/i18n-keys.ts` is GENERATED — never
  hand-edit). Exceptions: `content/help/**` and `apps/web/src/games/**`.
- **UI verified by screenshot at 1280, 768 and 320,** no horizontal page
  scroll at any of them, and the layout holds at non-100% browser zoom.
- **e2e triggers on push to `main` only.** A feature branch gets zero automatic
  e2e. Pre-merge run: `gh workflow run E2E --ref docs/entitlements-w4-handoff`.
  Smoke is PR-only. The two are disjoint.
- **Do not run `stripe:sync`** — it writes to a shared Stripe test account and
  needs the owner's approval. Do not touch the `rk_test_` key in
  `apps/web/.env.local`; it is restricted on purpose.
- **`pro_plus` is retired** (`V393__entitlements_v18.sql:145-146`). It must not
  appear in any new test.

---

### Task 1: N4 — meter device-link refusals

**Files:**
- Modify: `apps/web/src/server/api-v1/auth.ts:238-296` (`requireFixtureActor`)
- Test: `apps/web/src/server/api-v1/__tests__/device-link-refusal-meter.test.ts` (create)

**Interfaces:**
- Consumes: `rateLimit(key: string, cfg: { max: number; windowSeconds: number; failClosed?: boolean }): Promise<void>` from `@/lib/rate-limit` (`apps/web/src/lib/rate-limit.ts:36`); `deviceLinkCoversFixture(link, fixtureId): boolean` and `resolveDeviceLinkToken(token)` from `@/server/usecases/device-links`.
- Produces: nothing other lanes consume.

**Why a unit test and not an e2e.** `rateLimit` is inert without Redis:
`apps/web/src/lib/rate-limit.ts:40-49` returns early when `incrWindow` yields
`null`, which is exactly the local and CI e2e condition ("Redis not configured
(local dev, e2e): limiter is inert → always allow"). A browser test therefore
cannot witness this guard at all. The proof has to be a unit test that asserts
the CALL and its ORDER.

**Current order** (`auth.ts:246-269`): token resolve `:251` → `assertUuid`
`:252` → ownership throw `:255-256` → `rateLimit("dlv1:<id>", {max:10,
windowSeconds:1})` gated on `intent === "score"` `:259-260` → context `:262`.
A cross-fixture 403 never reaches the meter, so refusals are free to probe
while grants are limited.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/server/api-v1/__tests__/device-link-refusal-meter.test.ts`.
Follow the mocking shape already used by
`apps/web/src/app/api/v1/fixtures/[id]/lineups/[entrantId]/__tests__/route.test.ts`
for mocking `@/server/usecases/device-links`.

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";

const rateLimit = vi.fn(async () => {});
vi.mock("@/lib/rate-limit", () => ({ rateLimit }));

const resolveDeviceLinkToken = vi.fn();
const deviceLinkCoversFixture = vi.fn();
vi.mock("@/server/usecases/device-links", () => ({
  resolveDeviceLinkToken,
  deviceLinkCoversFixture,
}));

const LINK = {
  id: "11111111-1111-4111-8111-111111111111",
  org_id: "22222222-2222-4222-8222-222222222222",
  issued_by: "33333333-3333-4333-8333-333333333333",
};
const FIXTURE = "44444444-4444-4444-8444-444444444444";

function req(): Request {
  return new Request("https://example.test/api/v1/fixtures/x/events", {
    headers: { authorization: "Bearer dl_test_token" },
  });
}

describe("device-link refusals are metered", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveDeviceLinkToken.mockResolvedValue(LINK);
  });

  // The defect: a cross-fixture 403 costs the prober nothing, at either intent.
  it.each(["read", "score"] as const)(
    "meters a cross-fixture refusal at %s intent",
    async (intent) => {
      deviceLinkCoversFixture.mockReturnValue(false);
      const { requireFixtureActor } = await import("@/server/api-v1/auth");

      await expect(requireFixtureActor(req(), FIXTURE, intent)).rejects.toThrow(
        /different fixture/,
      );

      // Placement, not just occurrence: the meter must have been reached, and
      // it can only have been reached BEFORE the throw that ended the call.
      expect(rateLimit).toHaveBeenCalledTimes(1);
      expect(rateLimit.mock.calls[0]?.[0]).toBe(`dlv1-refuse:${LINK.id}`);
    },
  );

  // The pre-existing grant meter must be untouched: same key, same budget,
  // still score-only. Without this row, moving or widening the original call
  // would pass unnoticed.
  it("still meters a granted score exactly once, on the original key", async () => {
    deviceLinkCoversFixture.mockReturnValue(true);
    const { requireFixtureActor } = await import("@/server/api-v1/auth");

    await requireFixtureActor(req(), FIXTURE, "score");

    expect(rateLimit.mock.calls.map((c) => c[0])).toEqual([`dlv1:${LINK.id}`]);
    expect(rateLimit.mock.calls[0]?.[1]).toMatchObject({ max: 10, windowSeconds: 1 });
  });

  // Its negative pair: a granted READ still reaches no meter at all, which is
  // what the intent gate at :259 exists to do.
  it("does not meter a granted read", async () => {
    deviceLinkCoversFixture.mockReturnValue(true);
    const { requireFixtureActor } = await import("@/server/api-v1/auth");

    await requireFixtureActor(req(), FIXTURE, "read");

    expect(rateLimit).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails for the right reason**

```bash
cd apps/web && pnpm vitest run src/server/api-v1/__tests__/device-link-refusal-meter.test.ts \
  --reporter=json --outputFile=/tmp/w4-t1.json
```

Expected: the two refusal rows FAIL on `rateLimit` having 0 calls. The two
grant rows PASS already. If a refusal row passes now, stop — the premise is
wrong and that is a finding to record, not a test to adjust.

- [ ] **Step 3: Add the refusal meter**

In `apps/web/src/server/api-v1/auth.ts`, inside the `if (dlToken)` block,
insert immediately BEFORE the ownership check at `:255`:

```ts
    // Refusals are as cheap to probe as grants are, and until W4 only grants
    // were metered — a stranger holding one valid link could sweep every
    // fixture id at no cost, at read intent for free even after this. Its own
    // key, so a prober cannot exhaust a legitimate scorer's 10/s budget (and
    // vice versa), and no intent gate, because a cross-fixture 403 is equally
    // free to probe at either one.
    const covers = deviceLinkCoversFixture(link, fixtureId);
    if (!covers) {
      await rateLimit(`dlv1-refuse:${link.id}`, { max: 10, windowSeconds: 1 });
    }
```

…and change the existing throw at `:255-256` to reuse that result rather than
asking the predicate twice:

```ts
    if (!covers) {
      throw new HttpError(403, "This device link is for a different fixture");
    }
```

Ownership still lives in ONE predicate — this only stops calling it twice per
request. Leave the existing grant meter at `:259-260` exactly as it is. Do not move the grant meter: three score-intent
callers depend on its current position —
`apps/web/src/app/api/v1/fixtures/[id]/lineups/[entrantId]/route.ts:28`,
`.../finalize/route.ts:15`, `.../events/route.ts:15`.

- [ ] **Step 4: Run the test and confirm green**

```bash
cd apps/web && pnpm vitest run src/server/api-v1/__tests__/device-link-refusal-meter.test.ts \
  --reporter=json --outputFile=/tmp/w4-t1.json && node -e "const r=require('/tmp/w4-t1.json');console.log(r.numPassedTests+'/'+r.numTotalTests)"
```

Expected: `4/4`.

- [ ] **Step 5: Mutate, one at a time, and record the killer list**

Run each mutant, note which test names red, then revert it:

1. Delete the whole `await rateLimit(\`dlv1-refuse:…\`)` line → both refusal
   rows must red.
2. Change the refusal key to `` `dlv1:${link.id}` `` → the refusal rows must
   red on the key assertion (this is the mutant that proves the two meters are
   actually separate budgets).
3. Delete the `if (intent === "score")` gate at `:259` → "does not meter a
   granted read" must red.

A mutant that reds every test is not evidence of coverage — say so if you see
it.

- [ ] **Step 6: Run the neighbouring suites that touch this function**

```bash
cd apps/web && pnpm vitest run \
  src/server/usecases/__tests__/device-links.test.ts \
  src/server/usecases/__tests__/scorers.test.ts \
  "src/app/api/v1/fixtures/[id]/lineups/[entrantId]/__tests__/route.test.ts" \
  --reporter=json --outputFile=/tmp/w4-t1-neighbours.json
```

Expected: all pass, no change in totals.

- [ ] **Step 7: Commit**

```bash
/usr/bin/git add apps/web/src/server/api-v1/auth.ts apps/web/src/server/api-v1/__tests__/device-link-refusal-meter.test.ts
/usr/bin/git commit -o apps/web/src/server/api-v1/auth.ts apps/web/src/server/api-v1/__tests__/device-link-refusal-meter.test.ts \
  -m "fix(api-v1): a cross-fixture device-link refusal cost the prober nothing"
```

---

### Task 2: N5 — nine anonymous contexts stop racing the cookie banner

**Files:**
- Modify: `apps/web/e2e/scorepad-offline.spec.ts:210, 266, 301, 365`
- Modify: `apps/web/e2e/scorepad-v3-partial-amend.spec.ts:201, 363, 425, 471`
- Modify: `apps/web/e2e/scorepad-v3-cricket.spec.ts:421`

**Interfaces:**
- Consumes: `consentedAnonymousState(): Promise<{ cookies: []; origins: {...}[] }>` and `expectNoCookieBanner(page: Page, where: string): Promise<void>`, both exported from `apps/web/e2e/scorepad-a11y-kit.ts` (`:346` and `:373`).
- Produces: nothing other lanes consume.

**Note on the spec's own correction.** The W4 brief points at
`device-links.spec.ts` as carrying this fix. It does not — its
`storageState: { cookies: [], origins: [] }` solves session inheritance, a
different problem. The real fix is `consentedAnonymousState()`, which seeds
`CONSENT_KEY` / `CONSENT_VERSION_KEY` so the banner's `useEffect` never sets
`visible`. It has exactly one caller today
(`apps/web/e2e/scorepad-a11y-evidence.spec.ts:463`).

All three target files are scorepad specs, so import from the kit. Do not move
the helper into `helpers.ts` — that widens the blast radius for no gain.

- [ ] **Step 1: Confirm the nine sites before changing them**

```bash
cd apps/web && grep -an "storageState: undefined" \
  e2e/scorepad-offline.spec.ts e2e/scorepad-v3-partial-amend.spec.ts e2e/scorepad-v3-cricket.spec.ts
```

Expected: exactly 9 lines, 4 + 4 + 1. If the count differs, the pins have moved
— re-pin and say so rather than editing blind.

- [ ] **Step 2: Add the import to each of the three files**

In each file, alongside its existing imports:

```ts
import { consentedAnonymousState, expectNoCookieBanner } from "./scorepad-a11y-kit";
```

If a file already imports from `./scorepad-a11y-kit`, extend that import rather
than adding a second one.

- [ ] **Step 3: Replace each of the nine sites**

At every site, change:

```ts
    const ctx = await browser.newContext({ storageState: undefined });
```

to:

```ts
    const ctx = await browser.newContext({ storageState: await consentedAnonymousState() });
```

Keep every surrounding option (viewport, permissions, locale) exactly as it is.
Do not weaken any assertion to accommodate the change: a banner that no longer
intercepts should make existing assertions pass more reliably, not differently.

- [ ] **Step 4: Add the positive check to one site per file**

Seeding consent and changing nothing observable is indistinguishable from a
no-op, so each file needs one assertion that the banner is actually absent.
After the first navigation in the first anonymous context of each file:

```ts
    await expectNoCookieBanner(page, "anonymous scorer context");
```

- [ ] **Step 5: Run the three specs**

```bash
cd apps/web && npx playwright test \
  e2e/scorepad-offline.spec.ts e2e/scorepad-v3-partial-amend.spec.ts e2e/scorepad-v3-cricket.spec.ts \
  --project=parallel --reporter=line
```

Run the WHOLE files, never a `-g` slice — a `-g` sweep is a filename sweep in a
costume and has already missed the tests a change actually broke. Expected: all
green.

- [ ] **Step 6: Re-run twice more**

Same command, twice. These are flaky-shaped gates and one green is not a
verdict. If any run reds, treat the failing count as a floor, not a total.

- [ ] **Step 7: Mutate**

Change one site's `consentedAnonymousState()` back to `undefined` and confirm
the `expectNoCookieBanner` in that file can red under CPU throttling. If it
cannot be made to red, say so — the assertion is decoration and the reviewer
needs to know.

- [ ] **Step 8: Commit**

```bash
/usr/bin/git add apps/web/e2e/scorepad-offline.spec.ts apps/web/e2e/scorepad-v3-partial-amend.spec.ts apps/web/e2e/scorepad-v3-cricket.spec.ts
/usr/bin/git commit -o apps/web/e2e/scorepad-offline.spec.ts apps/web/e2e/scorepad-v3-partial-amend.spec.ts apps/web/e2e/scorepad-v3-cricket.spec.ts \
  -m "test(e2e): nine anonymous contexts raced the consent banner they never answered"
```

---

### Task 3: N2 — the Event Pass money path actually runs

**Files:**
- Move: `apps/web/e2e/event-pass.spec.ts` → `apps/web/e2e/walkthrough/event-pass.spec.ts`
- Modify: `apps/web/e2e/walkthrough/event-pass.spec.ts` (serial pin; import paths)
- Modify: `apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts:155-266` (`WALKTHROUGH_SPECS`)
- Modify: `apps/web/playwright.config.ts:129` (reporter)
- Modify: `.github/workflows/e2e.yml` (new post-run skip check on the walkthrough leg)

**Interfaces:**
- Consumes: the `walkthrough` project's directory matcher `WALKTHROUGH = /[\\/]e2e[\\/]walkthrough[\\/]/` (`apps/web/playwright.config.ts:119`).
- Produces: a JSON report at `playwright-report/results.json` that the CI check and every later lane may read.

**Why this is the highest-value task in the wave.** This is the one flow that
takes money and no gate in the repo has ever run it. `parallel` receives the
literal `sk_test_ci_e2e_dummy` (`.github/workflows/e2e.yml:289`); only
`matrix.project == 'walkthrough'` receives `secrets.STRIPE_SECRET_KEY`. Locally
the server boots from an `rk_test_` restricted key that cannot create a Checkout
Session. So U1, U6, U12, U14, U15 and U16 have never executed anywhere, and W3
changed an assertion in this file (`:678`) without being able to observe the
result.

- [ ] **Step 1: Move the file**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/entw3 && \
  /usr/bin/git mv apps/web/e2e/event-pass.spec.ts apps/web/e2e/walkthrough/event-pass.spec.ts
```

- [ ] **Step 2: Fix the relative imports**

The file now sits one directory deeper. Its imports at `:4-32` reference
`./helpers`, `./price-kit`, `../src/lib/currency`, `../src/lib/entitlements`.
Each needs one more `../`:

```ts
import { TAG, apiJson, expectNoHorizontalScroll, mintLoginPathBySql, orgGroupIdSql } from "../helpers";
import type { PassKey } from "../../src/lib/currency";
import type { PassLockReason } from "../../src/lib/entitlements";
import { HIDDEN_PASS_RUNGS, SELLABLE_PASS_RUNGS, passActiveMarker, passLabel, passMinor } from "../price-kit";
```

Verify with `cd apps/web && npx tsc --noEmit -p tsconfig.json` — or, faster,
`npx playwright test --list e2e/walkthrough/event-pass.spec.ts`, which fails
loudly on an unresolved import.

- [ ] **Step 3: Add the serial pin — this is what makes the move mean anything**

At the top of the file's outermost `describe`, or at module scope beside the
existing configuration:

```ts
// U1 sets `stripeUsable` from a live probe and U6/U12/U14/U15/U16 each
// `test.skip(!stripeUsable, …)` on it. That flag is MODULE-SCOPED, so it is
// per worker, and the walkthrough leg runs --workers=3. Without this pin U1
// lands in one worker while U16 lands in another with the flag still false,
// U16 silently skips, and the leg reports green — which is exactly the failure
// this whole task exists to end.
test.describe.configure({ mode: "serial" });
```

Eight specs already under `e2e/walkthrough/` set this per-file, so it is the
established convention, not a new one.

- [ ] **Step 4: Register it in the inventory**

In `apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts`, add to the `MONEY` group
of `WALKTHROUGH_SPECS` (the list is grouped by programme, NOT alphabetically —
do not re-sort it):

```ts
  "registration-connect.spec.ts",
  "rs007-invite-pay-cancel.spec.ts",
  "rs007-money-matrix.spec.ts",
  "event-pass.spec.ts",
```

- [ ] **Step 5: Run the wiring guard**

```bash
cd apps/web && pnpm vitest run src/lib/__tests__/e2e-ci-wiring.test.ts \
  --reporter=json --outputFile=/tmp/w4-t3-wiring.json
```

Expected: green. Its two guards (`:343`, `:364`) check both directions — a file
on disk absent from the list, and a name in the list absent from disk. Confirm
you did not trip either by omitting Step 4.

- [ ] **Step 6: Add the JSON reporter**

`apps/web/playwright.config.ts:129` currently reads:

```ts
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "list",
```

Change to:

```ts
  // The JSON report is what CI's money-path check reads. A pass count cannot
  // answer "did U1 and U16 RUN?" — only the skip count can, and nothing was
  // emitting one.
  reporter: process.env.CI
    ? [["line"], ["html", { open: "never" }], ["json", { outputFile: "playwright-report/results.json" }]]
    : "list",
```

- [ ] **Step 7: Add the CI check**

In `.github/workflows/e2e.yml`, after the step that runs Playwright on the
walkthrough leg, add a step gated the same way the existing Connect warning at
`:489-492` is gated (`if: matrix.project == 'walkthrough'`). It must run even
when the test step failed, so it reports the real cause:

```yaml
      - name: Event Pass money path must have RUN, not skipped
        if: always() && matrix.project == 'walkthrough'
        run: |
          REPORT=apps/web/playwright-report/results.json
          if [ ! -f "$REPORT" ]; then
            echo "::error::no JSON report at $REPORT — the money-path check cannot run"
            exit 1
          fi
          node -e '
            const r = require(process.env.REPORT);
            const want = ["U1 ·", "U16 ·"];
            const titles = [];
            const walk = (s) => {
              for (const spec of s.specs ?? []) {
                for (const t of spec.tests ?? []) {
                  titles.push([spec.title, t.results?.[0]?.status ?? "unknown"]);
                }
              }
              for (const c of s.suites ?? []) walk(c);
            };
            for (const s of r.suites ?? []) walk(s);
            const bad = want.flatMap((w) =>
              titles.filter(([t]) => t.includes(w))
                    .filter(([, st]) => st === "skipped" || st === "pending")
                    .map(([t]) => t));
            const seen = want.filter((w) => titles.some(([t]) => t.includes(w)));
            if (seen.length !== want.length) {
              console.error("::error::money-path tests not found in the report: " +
                want.filter((w) => !seen.includes(w)).join(", "));
              process.exit(1);
            }
            if (bad.length) {
              console.error("::error::the Event Pass money path SKIPPED: " + bad.join(" | "));
              process.exit(1);
            }
            console.log("money path ran: " + seen.join(", "));
          '
        env:
          REPORT: apps/web/playwright-report/results.json
```

Do NOT extend the existing `:489-492` Connect warning — it keys on
`STRIPE_CONNECT_TEST_ACCOUNT` and is about a different money path.

- [ ] **Step 7b: Re-run the wiring guard AFTER the workflow edit**

```bash
cd apps/web && pnpm vitest run src/lib/__tests__/e2e-ci-wiring.test.ts \
  --reporter=json --outputFile=/tmp/w4-t3-wiring-2.json
```

Step 5 ran this before `e2e.yml` was touched. That file also asserts the
workflow's SHAPE — step ordering around `Start server` (`:477-507`) and an
exact `refs.length` of 3 on the checkout steps (`:536`) — so a guard that only
ran before the edit has not policed the edit. Expected: still green. If the
ref count reds, your new step introduced a `ref:` and the assertion is telling
you so correctly.

- [ ] **Step 8: Confirm the project assignment changed**

```bash
cd apps/web && npx playwright test --list e2e/walkthrough/event-pass.spec.ts | head -5
```

Expected: the project shown is `walkthrough`, not `parallel`. This is the
single fact the whole task turns on — do not skip it.

- [ ] **Step 9: Commit**

```bash
/usr/bin/git add -A apps/web/e2e apps/web/playwright.config.ts apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts .github/workflows/e2e.yml
/usr/bin/git commit -m "test(e2e): the Event Pass money path had never run anywhere"
```

- [ ] **Step 10: Mutate the money path specifically**

Incidental coverage is not coverage for code that takes money. Run each mutant,
record which test names red, then revert:

1. **Delete the pay call.** In the pass-checkout handler, remove the Stripe
   Checkout Session creation and return a success shape. U1 must red — if it
   passes, U1 is asserting the gate lifted without money ever moving.
2. **Break the refund revocation.** Make the refund path leave the pass
   active. U16 must red; nothing else should.
3. **Break the credit.** Make an upgrade to Pro leave the pass billable rather
   than dormant. U14 must red.
4. **Disarm the new CI check itself.** Force `stripeUsable` false so U6–U16
   skip. The Step 7 check must FAIL the leg. A skip check that cannot fail is
   the vacuous gate this task exists to replace.

Report the killer list, not a count — a test that reds under every mutant is
not evidence of anything.

- [ ] **Step 11: Dispatch a real CI run and read the skip count**

```bash
gh workflow run E2E --ref docs/entitlements-w4-handoff
```

Then watch the walkthrough leg. **Acceptance is that U1 and U16 report as RUN.**
A green run in which they skipped is the failure this task exists to name —
read the new check's output, not the pass count. Paste the raw result back;
"done, tests pass" is not accepted.

---

### Task 4: N0 — instrument the three distribution quantities

**Files:**
- Modify: `apps/web/src/app/embed/divisions/[id]/[widget]/page.tsx`
- Modify: `apps/web/src/app/(public)/shared/[orgSlug]/page.tsx`
- Modify: `apps/web/src/server/usecases/org-posts.ts` (auto-draft insert path, around `:665-690`)
- Test: `apps/web/src/lib/__tests__/distribution-instrumentation.test.ts` (create)

**Interfaces:**
- Consumes: `captureServer({ event, distinctId, orgId?, properties? }): Promise<void>` from `@/lib/posthog-server` (`apps/web/src/lib/posthog-server.ts`); `EVENTS` from `@/lib/analytics-events`.
- Produces: `EVENTS.EMBED_RENDERED`, a new `EVENTS.PUBLIC_PROFILE_VIEWED`, and `EVENTS.POST_AUTO_DRAFTED` as live signals.

**What is wrong today.** `EVENTS.EMBED_RENDERED` is defined at
`apps/web/src/lib/analytics-events.ts:41` and has NO application call site —
its only other reference in the tree is its own unit test. The public profile
page records nothing. `POST_PUBLISHED{auto:true}` fires only inside the
`action: "publish"` branch (`org-posts.ts:281`, capture at `:318-324`), while
the auto-draft insert leaves `status: 'draft'` and fires nothing, so the event
counts human publishes of auto-drafts rather than auto-posts.

**Constraint to carry into any report built on these:** `captureServer` no-ops
without a PostHog key and is consent-gated. These are consented-traffic counts,
never absolute volumes.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/__tests__/distribution-instrumentation.test.ts`. This
is a source-scanning guard, deliberately: the defect class is a declared event
with no producer, and only a scan can see that.

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

/** Every distribution event must have a producer that is not a test.
 *
 *  EMBED_RENDERED shipped DECLARED and unit-green with no call site anywhere,
 *  which is why item 0's baseline could never have been taken. A membership
 *  assertion on the constants file cannot see that; only the call site can. */
describe("distribution events have real producers", () => {
  it.each([
    ["EMBED_RENDERED", "app/embed/divisions/[id]/[widget]/page.tsx"],
    ["PUBLIC_PROFILE_VIEWED", "app/(public)/shared/[orgSlug]/page.tsx"],
    ["POST_AUTO_DRAFTED", "server/usecases/org-posts.ts"],
  ])("%s is captured in %s", (event, file) => {
    const src = read(file);
    expect(src, `${file} does not import captureServer`).toContain("captureServer");
    expect(src, `${file} never references EVENTS.${event}`).toContain(`EVENTS.${event}`);
  });

  // The negative pair: the auto-draft signal must NOT be the publish signal.
  // Collapsing them is how the current count came to mean "human published an
  // auto-draft" while being read as "an auto-post happened".
  it("keeps the auto-draft signal distinct from the publish signal", () => {
    const src = read("server/usecases/org-posts.ts");
    expect(src).toContain("EVENTS.POST_PUBLISHED");
    expect(src).toContain("EVENTS.POST_AUTO_DRAFTED");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd apps/web && pnpm vitest run src/lib/__tests__/distribution-instrumentation.test.ts \
  --reporter=json --outputFile=/tmp/w4-t4.json
```

Expected: all four rows FAIL — none of the three call sites exists yet and
`PUBLIC_PROFILE_VIEWED` / `POST_AUTO_DRAFTED` are not declared.

- [ ] **Step 3: Declare the two new events**

In `apps/web/src/lib/analytics-events.ts`, beside `EMBED_RENDERED` in the PLG
distribution block:

```ts
  /** A public org profile was rendered. Distribution baseline (entitlements
   *  v18 item 0) — consent-gated, so a consented-traffic count, not a total. */
  PUBLIC_PROFILE_VIEWED: "public_profile_viewed",
  /** An auto-draft was GENERATED. Distinct from post_published{auto:true},
   *  which only fires once a human publishes that draft. */
  POST_AUTO_DRAFTED: "post_auto_drafted",
```

- [ ] **Step 4: Give `EMBED_RENDERED` its call site**

In `apps/web/src/app/embed/divisions/[id]/[widget]/page.tsx`, after the
`resolved.ok` guard (where `org`, `competition` and `division` are in scope) and
before the render:

```ts
  // Item 0: this event has existed since the PLG loops shipped and has never
  // been fired. No user is in scope on an embed, so the org carries the
  // identity, per CaptureArgs' own note on synthetic ids.
  await captureServer({
    event: EVENTS.EMBED_RENDERED,
    distinctId: `org:${org.id}`,
    orgId: org.id,
    properties: { widget, divisionId: division.id, competitionId: competition.id },
  });
```

Add the imports:

```ts
import { captureServer } from "@/lib/posthog-server";
import { EVENTS } from "@/lib/analytics-events";
```

**Read `node_modules/next/dist/docs/` before assuming this is safe:** the route
sets `export const revalidate = 30`, so it is ISR-cached and the capture fires
on RENDER, not on every viewer request. That is a real limitation — it counts
cache fills, not loads. Record it in the commit message and in the spec's N0
section rather than papering over it; if the owner needs per-load counts, that
is a client-side capture and a separate decision.

- [ ] **Step 5: Add the public-profile capture**

In `apps/web/src/app/(public)/shared/[orgSlug]/page.tsx`, in the page component
after the `getPublicOrg` result is known non-null, with the same imports and the
same ISR caveat:

```ts
  await captureServer({
    event: EVENTS.PUBLIC_PROFILE_VIEWED,
    distinctId: `org:${data.org.id}`,
    orgId: data.org.id,
    properties: { orgSlug },
  });
```

- [ ] **Step 6: Fire the auto-draft signal where the draft is made**

In `apps/web/src/server/usecases/org-posts.ts`, in `insertGeneratedPost` after
the insert returns a row (around `:685`). The insert carries
`on conflict … do nothing` and returns `rows[0] ?? null`, so fire ONLY on a
real insert — a conflict means the draft already existed and counting it again
would inflate the number:

```ts
      const inserted = rows[0] ?? null;
      if (inserted) {
        // Distinct from POST_PUBLISHED{auto:true}, which fires only once a
        // human publishes this draft. Counting the publish as the auto-post is
        // what made item 0's "auto-posted items" unanswerable.
        await captureServer({
          event: EVENTS.POST_AUTO_DRAFTED,
          distinctId: `org:${params.orgId}`,
          orgId: params.orgId,
          properties: { kind: params.kind, trigger: params.autoSource?.trigger ?? null },
        });
      }
      return inserted;
```

Keep the existing `POST_PUBLISHED` capture at `:318-324` exactly as it is.

- [ ] **Step 7: Run the guard and the neighbouring suites**

```bash
cd apps/web && pnpm vitest run \
  src/lib/__tests__/distribution-instrumentation.test.ts \
  src/lib/__tests__/analytics-events.test.ts \
  --reporter=json --outputFile=/tmp/w4-t4.json && \
  node -e "const r=require('/tmp/w4-t4.json');console.log(r.numPassedTests+'/'+r.numTotalTests)"
```

Expected: all green, and `analytics-events.test.ts` still passes with the two
new keys.

- [ ] **Step 8: Prove it through the real producer, not the scan**

A source scan proves a call site exists, not that it fires. Drive each surface
once against a local server with `POSTHOG_KEY` unset (so `captureServer`
no-ops) and confirm no page 500s, then with a temporary `console.log` inside
`captureServer`'s no-key early return to confirm each of the three is reached:
load an embed widget, load a public org profile, and trigger an auto-draft.
Remove the log before committing. A fixture on both ends proves the fixture.

- [ ] **Step 9: Mutate**

Delete each of the three `captureServer` calls in turn; the matching row in
`distribution-instrumentation.test.ts` must red. Then change
`POST_AUTO_DRAFTED` back to `POST_PUBLISHED` in Step 6's block — the
"keeps the auto-draft signal distinct" row must red.

- [ ] **Step 10: Commit**

```bash
/usr/bin/git add apps/web/src/lib/analytics-events.ts apps/web/src/lib/posthog-server.ts \
  "apps/web/src/app/embed/divisions/[id]/[widget]/page.tsx" \
  "apps/web/src/app/(public)/shared/[orgSlug]/page.tsx" \
  apps/web/src/server/usecases/org-posts.ts \
  apps/web/src/lib/__tests__/distribution-instrumentation.test.ts
/usr/bin/git commit -m "feat(analytics): three distribution quantities nobody could count"
```

---

### Task 5: N1 — `enterprise-gate.spec.ts`

**Files:**
- Create: `apps/web/e2e/enterprise-gate.spec.ts`

**Interfaces:**
- Consumes, all from `apps/web/e2e/helpers.ts`: `planCapSql(featureKey, planKey): Promise<number | null | undefined>` (`:1014`), `planFlagSql(featureKey, planKey): Promise<boolean | null | undefined>` (`:1029`), `communityLimit(featureKey): Promise<number>` (`:354`), `grantCompetitionPassSql(orgId, competitionId, passKey, request?): Promise<void>`, `mintLoginPathBySql(email): Promise<string>` (`:153`), `TAG`, `apiJson`.
- Produces: nothing other lanes consume.

**Project:** `parallel`. The file falls through `playwright.config.ts`'s
`testIgnore` list exactly as `event-pass.spec.ts` did, so no config change and
no `SERIAL_SPECS` edit. **Seed your own org and owner per block** — the pattern
`event-pass.spec.ts` uses (`seedRig`, `:148`) and states at `:80-82`: never the
shared Pro or community `storageState` accounts. `AUTH_STATE` is a shared Pro
org and `setOrgPlanBySql` is group-scoped; mutating either contaminates every
concurrent spec.

**Read every number from the live matrix.** The deleted `pro-plus-tier.spec.ts`
hardcoded 2 and 5, and that is precisely why V393 moved pro's save-point cap
from 5 to 10 underneath it in silence.

- [ ] **Step 1: Write case C1 — save points roll a window, they do not 402**

```ts
import { test, expect } from "@playwright/test";
import {
  TAG,
  apiJson,
  planCapSql,
  planFlagSql,
  communityLimit,
  mintLoginPathBySql,
  grantCompetitionPassSql,
} from "./helpers";

const CHECKPOINTS = "schedule.checkpoints.max";

// Caps come from plan_entitlements, never from a literal here. Community 2,
// pro 10, both pass rungs 5, enterprise unlimited — but read them, because
// V393 already moved one of these under a test that had typed it in.
test.describe("save points roll a window rather than refusing", () => {
  // Enumerate the TABLE, not a sample. One lucky plan is not a parity sweep,
  // and the rung that moved in V393 (pro 5 -> 10) sat next to three that did
  // not. `enterprise` is unlimited (null cap) and takes the skip below, which
  // is itself the assertion that it has no ceiling.
  for (const plan of ["community", "pro", "event_pass", "event_pass_l", "enterprise"] as const) {
    test(`${plan}: the cap+1th save point evicts the oldest, and nothing 402s`, async ({ request }) => {
      const cap = await planCapSql(CHECKPOINTS, plan);
      if (cap == null) {
        // Enterprise is unlimited (null cap, V393:33-35). Assert that rather
        // than skipping: a skipped row proves nothing, and "unlimited" is a
        // real claim about the plan that deserves an assertion of its own.
        expect(plan, `${plan} has a null ${CHECKPOINTS} cap — only enterprise may`).toBe("enterprise");
        return;
      }

      const rig = await seedOrgOnPlan(plan); // see Step 2
      for (let i = 0; i < cap + 1; i++) {
        const res = await apiJson(request, "POST", `/api/v1/divisions/${rig.divisionId}/checkpoints`, {
          label: `${TAG}-cp-${i}`,
        });
        expect(res.status, `save point ${i + 1} of ${cap + 1} on ${plan}`).toBeLessThan(400);
      }

      const list = await apiJson(request, "GET", `/api/v1/divisions/${rig.divisionId}/checkpoints`);
      expect(list.body.items).toHaveLength(cap);
      // The ROLL, not merely the count: the first one written is the one gone.
      expect(list.body.items.map((c: { label: string }) => c.label)).not.toContain(`${TAG}-cp-0`);
    });
  }

  // The differential row. Pro's cap is 10 today and was 5 when the deleted
  // spec hardcoded it; community's is 2. If these two ever read equal, the
  // matrix read has collapsed and every row above is asserting nothing.
  test("the plans do not all share one ceiling", async () => {
    const [community, pro] = [await communityLimit(CHECKPOINTS), await planCapSql(CHECKPOINTS, "pro")];
    expect(pro).not.toBe(community);
  });
});
```

**Route confirmed:** `apps/web/src/app/api/v1/divisions/[id]/checkpoints/`
(with `[checkpointId]/` beneath it), so the paths above are real. The cap read
is `apps/web/src/server/usecases/history.ts:477-481` and the evict-oldest
branch `:548-560`, under an advisory lock at `:503`. Open the route file to
confirm the request and response body shapes before asserting on
`body.items` — that field name is the one thing above still unpinned.

- [ ] **Step 2: Write the `seedOrgOnPlan` helper local to this spec**

Model it directly on `event-pass.spec.ts`'s `seedRig` (`:148-200`): insert a
`users` row, an `organizations` row, an `org_members` owner row, a
`subscriptions` row carrying the plan key, then
`update organizations set subscription_id = …`. For the two pass rungs, seed
the subscription at `community` and then call
`grantCompetitionPassSql(orgId, competitionId, passKey)` — the resolver's pass
arm only fires while the resolved plan is `community`.

- [ ] **Step 3: Run C1, confirm it fails or passes for the right reason**

```bash
cd apps/web && npx playwright test e2e/enterprise-gate.spec.ts --project=parallel --reporter=line
```

If a row passes on the first run, mutate before believing it: change the
expected length from `cap` to `cap + 1`. It must red.

- [ ] **Step 4: Write case C2 — `api.write`, both directions**

```ts
test.describe("api.write is the enterprise-only scope", () => {
  test("refuses a write-scoped key on pro, and STILL mints a read-only one", async ({ request }) => {
    const rig = await seedOrgOnPlan("pro");

    const refused = await apiJson(request, "POST", `/api/v1/orgs/${rig.orgId}/api-keys`, {
      name: `${TAG}-write`, scopes: ["read", "write"],
    });
    expect(refused.status, "a write scope on pro must be refused").toBe(402);

    // The positive pair. Without it, a build that refused ALL key minting
    // would pass the row above and look correct.
    const minted = await apiJson(request, "POST", `/api/v1/orgs/${rig.orgId}/api-keys`, {
      name: `${TAG}-read`, scopes: ["read"],
    });
    expect(minted.status, "a read-only key must still mint on pro").toBeLessThan(400);
    expect(minted.body.key).toBeTruthy();
  });

  // api.access is checked FIRST (api-keys.ts:42) and api.write second (:47).
  // Two guards covering for each other are each untested, so one row has to
  // separate them: a plan without api.access must fail differently.
  test("an api.access refusal is not an api.write refusal", async ({ request }) => {
    const rig = await seedOrgOnPlan("community");
    const res = await apiJson(request, "POST", `/api/v1/orgs/${rig.orgId}/api-keys`, {
      name: `${TAG}-none`, scopes: ["read"],
    });
    expect(res.status).toBe(402);
    expect(res.body.feature ?? res.body.message).toContain("api.access");
  });
});
```

Pin the refusal status and body shape against
`apps/web/src/server/usecases/api-keys.ts:42-47` and the route at
`apps/web/src/app/api/v1/orgs/[id]/api-keys/route.ts:18` before asserting 402 —
if `requireFeature` throws something else, use what it actually throws.

- [ ] **Step 5: Write case C3 — `dashboard.branding`'s paywall says the right thing**

**Scope correction found during plan review: do NOT re-assert the enterprise
ceiling here.** `apps/web/src/lib/__tests__/entitlements-v18-enterprise-ceiling.test.ts`
already derives that set from the live matrix and already covers `api.write`
specifically (`:111`, "api.write is the enterprise key, and it is enterprise
because NO self-serve plan carries it"), plus the unlimited-cap regression at
`:87`. Duplicating it in a browser spec buys nothing and costs a slow test.
`ENTERPRISE_FEATURES` is also NOT exported from `feature-copy.ts:363`, and it
should stay that way.

What has no coverage is the SURFACE of the second enterprise key.
`dashboard.branding` joined the set in V396, after item 6 was written, and W3
shipped "every paywall now states the plan its reader already holds" and
"stop answering Go Pro to an organization already on Pro". A key that no
self-serve plan grants must therefore route a Pro org to Contact-us, not to an
upgrade it already owns.

```ts
// dashboard.branding is enterprise-only, so a PRO org hitting it is the exact
// case W3's paywall work exists for: it must not be offered an upgrade it
// already has. The matrix side of this is already unit-tested — this is the
// screen.
test("a Pro org meeting the branding gate is sent to Contact-us, not to Go Pro", async ({ page, request }) => {
  const rig = await seedOrgOnPlan("pro");
  await page.goto(await mintLoginPathBySql(rig.ownerEmail));
  await page.goto(`/o/${rig.orgSlug}/settings?tab=branding`);

  const gate = page.locator('[data-feature="dashboard.branding"]');
  await expect(gate).toBeVisible();
  await expect(gate, "a Pro org must not be sold Pro").not.toContainText(/go pro/i);
  await expect(gate).toContainText(/contact/i);

  // Its positive pair: the gate is actually gating. A community org sees the
  // same refusal, so a build that rendered the panel outright would red here.
  expect(await planFlagSql("dashboard.branding", "pro")).not.toBe(true);
});
```

Pin the real route, the real `data-feature` sentinel and the real copy before
asserting — freeing a key falsifies its sentinel test, so sweep
`data-feature=` for `dashboard.branding` rather than trusting the selector
above.

- [ ] **Step 6: Write case C4 — `officials.auto` is competition-SCOPED**

```ts
// Granted on pro AND both pass rungs since V393. W2 T6's competition-scoped
// resolution is what makes the pass grant safe, and it has never been driven
// in a browser. The case that matters is the SCOPE: a grant that leaked to a
// second competition would satisfy any test that only proved the grant exists.
test("a pass grants officials.auto on ITS competition and not on another", async ({ request }) => {
  const rig = await seedOrgOnPlan("community");
  const other = await seedSecondCompetition(rig.orgId);
  await grantCompetitionPassSql(rig.orgId, rig.competitionId, "event_pass", request);

  const granted = await apiJson(request, "POST", `/api/v1/divisions/${rig.divisionId}/officials/auto`, {});
  expect(granted.status, "the passed competition must allow auto-assign").toBeLessThan(400);

  const denied = await apiJson(request, "POST", `/api/v1/divisions/${other.divisionId}/officials/auto`, {});
  expect(denied.status, "a sibling competition must NOT inherit the pass").toBe(402);
});
```

**Route confirmed:** `apps/web/src/app/api/v1/divisions/[id]/officials/auto/route.ts`
(siblings: `ai-plan/`, `apply/`). Resolver:
`apps/web/src/server/usecases/officials.ts:474-477` (`competitionForDivision`),
used at `:496`, `:535`, `:795`. Confirm the request body the `auto` route
expects before sending `{}`.

- [ ] **Step 7: Write case C5 — `/admin/entitlements` columns and the billing two states**

```ts
test("/admin/entitlements renders a column per plan, enterprise included", async ({ page }) => {
  // Both derived from the source of truth: the KEYS decide how many columns
  // are owed, the LABEL map decides what each is called. Typing either into
  // this test is how the deleted spec came to assert yesterday's plan set.
  const { ADMIN_PLAN_KEYS, ADMIN_PLAN_LABEL } = await import("../src/lib/entitlement-admin");
  await page.goto(await mintLoginPathBySql(process.env.E2E_STAFF_EMAIL!));
  await page.goto("/admin/entitlements");

  const headers = await page.locator("table thead th").allInnerTexts();
  expect(headers.length, "no columns rendered — a set assertion would be vacuous").toBeGreaterThan(0);
  // /pricing deliberately omits enterprise; /admin deliberately does not.
  const expected = ADMIN_PLAN_KEYS.map((k) => ADMIN_PLAN_LABEL[k]);
  for (const label of expected) {
    expect(headers.join("|"), `${label} column`).toContain(label);
  }
  // Set, not subset: an EXTRA column is as wrong as a missing one, and a
  // `toContain` ladder alone cannot see one.
  expect(headers.filter((h) => expected.includes(h)).length).toBe(expected.length);
});
```

`/admin` is staff-only: functional bar, no design polish. `ADMIN_PLAN_KEYS`
(`apps/web/src/lib/entitlement-admin.ts:45`) is an unfiltered alias of
`ALL_PLAN_KEYS` (`apps/web/src/lib/currency.ts:250-252` — `community`,
`event_pass`, `event_pass_l`, `pro`, `enterprise`), and `ADMIN_PLAN_LABEL`
(`:52-58`) reads `Community` / `Event Pass M` / `Event Pass L` / `Pro` /
`Enterprise`. `/admin` is deliberately English-only, so these strings owe no
dictionary work.

For the billing half, assert a community org sees the priced upsell and a paid
org's upgrade grid is HIDDEN, with `enterprise` reaching the Contact-us CTA
rather than a priced card.

- [ ] **Step 8: Run the whole spec**

```bash
cd apps/web && npx playwright test e2e/enterprise-gate.spec.ts --project=parallel --reporter=line
```

Whole file, never a `-g` slice.

- [ ] **Step 9: Mutate each guard, one at a time**

C1: change the evict branch to refuse. C2: delete the `api.write`
`requireFeature` at `api-keys.ts:47`. C3: remove `dashboard.branding` from the
set. C4: drop the competition argument at `officials.ts:496` so the grant
becomes org-wide. C5: filter `enterprise` out of `ADMIN_PLAN_KEYS`. Each must
red its own case and no other. Report the killer list.

- [ ] **Step 10: Commit**

```bash
/usr/bin/git add apps/web/e2e/enterprise-gate.spec.ts apps/web/src/lib/feature-copy.ts
/usr/bin/git commit -m "test(e2e): the enterprise tier and V393's moved caps had no browser proof"
```

---

### Task 6: N3 — rule on the division tab rail at 320

**Files:**
- Read first: `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx:501-533`
- Modify (only if the browser shows a defect): the same file
- Modify: `apps/web/e2e/mobile.spec.ts` (add the classification gate)

**Interfaces:**
- Consumes: `overflowingIn(page, rootSelector, childSelector, absentMessage): Promise<{ clipped: string[]; scrollable: string[]; truncatedByDesign: string[] }>` (`apps/web/e2e/mobile.spec.ts:91`).
- Produces: nothing other lanes consume.

**This task is reproduce, rule, and gate — NOT fix-first.** The rail is
`<nav className="scroll-x scroll-x-fade mb-6 flex gap-1 whitespace-nowrap border-b border-slate-200">`
at `:501`, with tabs `entrants, fixtures, standings, stats` plus `discipline`
(conditional) and `settings` for editors. `.scroll-x` is `overflow-x: auto`
(`globals.css:397`); `.scroll-x-fade` fades to `var(--background)`
(`:400-406`), so it tracks the theme.

**Two premises that would waste the whole task if believed.** First, there is no
accessibility defect: the division page is already in the axe sweep
(`mobile.spec.ts:1465`, tags `["wcag2a","wcag2aa"]` at `:1487`, run in all seven
width projects) and it is green, because axe's `scrollable-region-focusable`
check passes when the region CONTAINS focusable elements — and this is a `<nav>`
of `<Link>`s.

**This is in tension with the standing rule "a scrolling rail needs
`tabindex="0"` + role + accessible name", and the tension is resolved in
opposite directions for its two halves.** The `tabindex` half should NOT be
applied here: a `<nav>` of links is already keyboard-reachable, and adding a
tab stop to the container inserts a redundant stop before every link, which is
worse for the keyboard user the rule exists to protect. The accessible-name
half SHOULD be applied: the `<nav>` is an unlabelled landmark, a page can carry
several, and `aria-label` costs nothing and helps. Treat the label as owed
regardless of what Step 1 finds; treat the `tabindex` as owed only if the
browser shows keyboard reachability actually failing. **Put this to the owner
before shipping either** — the rule is theirs, and this is a recommendation
against part of it, not a licence to ignore it.

Second, the source comment at `:500` cites "v3/02 §3.3: tabs scroll
horizontally with an edge fade — never wrap". **That document does not exist.**
No file under `docs/` contains that section or that phrasing; the comment is
the only source, which makes it a hypothesis rather than a ruling — the same
shape as this programme's "doc 14" citations that point at nothing. So wrapping
below `md` is NOT excluded by an owner decision and remains a legitimate option
if Step 1 finds a defect. Say so when presenting options rather than repeating
the comment as authority.

- [ ] **Step 1: Drive the product and write down what you SEE**

Bring up a local server per the `seazn-local-env` skill. Open a division page
at 320px **as an editor** (six tabs, so the rail actually overflows).
Screenshot it. Write down, in plain words: do the tabs scroll? Is the last tab
reachable by touch? Is the fade visible against the real page background? Does
the active tab start in view?

A claim about what a person SEES is settled only by driving the product. Record
what you saw, never what must be true.

- [ ] **Step 2: Classify the overflow from the live DOM**

```bash
cd apps/web && npx playwright test e2e/mobile.spec.ts --project=mobile-320 --reporter=line
```

Then, in a scratch script or the browser console on the division page at 320:

```js
const nav = document.querySelector("nav.scroll-x");
({ overflowX: getComputedStyle(nav).overflowX, scrollWidth: nav.scrollWidth, clientWidth: nav.clientWidth });
```

`auto` or `scroll` with `scrollWidth > clientWidth` is a reachable rail — a
feature. `hidden` or `visible` is a clip — a defect.

- [ ] **Step 3a: If it is a reachable rail — record the verdict and gate it**

No product change. Add to `apps/web/e2e/mobile.spec.ts`, beside the existing
clipping tests:

```ts
// The division tab rail is a SCROLLING rail, not clipped content — a
// distinction a `scrollWidth > clientWidth` scan cannot make on its own, and
// the page-level no-horizontal-scroll gate cannot see at all because the box
// scrolls inside itself. Nothing classified it until W4: "the tabs are
// reachable at 320" was true by accident.
test("division tab rail overflows reachably, never clipped", async ({ page, request }) => {
  await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
  const { clipped, scrollable } = await overflowingIn(
    page, "nav.scroll-x", "a", "the division tab rail is absent",
  );
  expect(clipped, "the tab rail (or something in it) is clipped, not scrollable").toEqual([]);
  expect(scrollable.length, "the rail did not overflow at all — this gate is vacuous here").toBeGreaterThan(0);
});
```

The second assertion is what stops the test passing vacuously at a width where
nothing overflows. Confirm it runs in `mobile-320`, where six tabs guarantee
overflow — if the seeded division has fewer tabs, seed an editor session or
skip with a stated reason rather than letting the gate pass on an empty set.

- [ ] **Step 3b: If it is clipped, or the tabs are unreachable — STOP and bring options**

Do not fix it unilaterally. Produce at least two options with screenshots at
320, and put them to the owner before building. Wrapping is excluded by the
design of record, so the options are likely to be about scroll affordance, the
fade, or which tab is anchored in view on load.

- [ ] **Step 4: Run the full seven-width matrix**

```bash
cd apps/web && npx playwright test e2e/mobile.spec.ts \
  --project=mobile-320 --project=mobile-360 --project=mobile-se \
  --project=mobile-14 --project=mobile-430 --project=tablet-768 --project=tablet-834 \
  --reporter=line
```

`mobile.spec.ts` neighbours run serially in places — if it goes red, treat the
failure count as a floor, not a total, and re-run after each fix until a full
pass completes.

- [ ] **Step 5: Mutate the new gate**

Change `nav.scroll-x`'s class to drop `scroll-x` in a scratch edit; the new
test must red on `clipped`. Revert. A gate nothing kills is decoration.

- [ ] **Step 6: Screenshots and the per-screen verdict**

Capture 320, 768 and 1280, plus one at non-100% zoom. "CI green" is not a
sign-off — write a verdict per screen.

- [ ] **Step 7: Commit**

```bash
/usr/bin/git add apps/web/e2e/mobile.spec.ts
/usr/bin/git commit -m "test(mobile): nothing classified the division tab rail's overflow"
```

---

## Wave close-out

- [ ] Re-run the full gate yourself at the wave boundary — do not accept a
      subagent's "done, tests pass" without the raw counts pasted back.

```bash
cd apps/web && pnpm vitest run --reporter=json --outputFile=/tmp/w4-final.json
node -e "const r=require('/tmp/w4-final.json');console.log(r.numPassedTests+'/'+r.numTotalTests+' failed='+r.numFailedTests)"
```

- [ ] Confirm `.testResults[].name` paths resolve inside the entw3 worktree,
      not the main checkout.
- [ ] `gh workflow run E2E --ref docs/entitlements-w4-handoff`, and read
      Task 3's skip check specifically. **U1 and U16 must report as RUN.**
- [ ] Walkthrough the product after every task group, not only at the end.
- [ ] Per-screen visual verdicts for N3, phone first.
- [ ] Update `docs/superpowers/specs/2026-09-02-entitlements-v18-prompts/_INDEX.md`:
      items 0, 4 and 5 close; item 6 closes fully; record the seven corrected
      premises so W5 does not re-derive them.
