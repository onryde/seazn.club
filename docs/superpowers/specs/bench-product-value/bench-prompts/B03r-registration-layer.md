# B03r — registration layer (`--entry`, drivers, Stripe test-mode payer, funnel oracle)

Read `_RULES.md` → `_INDEX.md` → `../designs/2026-08-27-bench-customer-journey-design.md`
(§2 decisions D1–D10 are closed; §3 entry modes; §4 pack contract; §5.2
funnel oracle; §6 pre-flight; §7 report). Depends on B03 **and on RS007,
RS008, RS009, RS011, RS010 merged** — check the registration `_INDEX.md`
status table before starting; if any is open, stop and report.
Worktree; **two PRs** (PR 0 is app-side test hooks, PR 1 is the bench).

## Re-pin first (B00 pattern — every citation below was authored 2026-08-27)

Scout, read-only, before any code: registration public routes
(`apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/register/**`),
hub panels (`apps/web/src/components/v2/registration-hub-*-panel.tsx`),
`registration_settings` columns (V118) + `divisions.category/age_min/age_max`
(V364), RS011's `evaluateEligibility` entry points, RS007's status-page
reconcile, RS008 consent link shape, RS009 assign endpoint, and the pad
selectors in `apps/web/e2e/walkthrough/scorepad-v3-deciders-fullmatch.spec.ts`
(`pad`/`tile`/`sheet`/`tapTile`/`tapThroughSheet`/`startMatch`, `:31-118`).
Paste the re-pinned `file:line`s into the PR body.

## PR 0 — app-side test hooks (tiny, product PR, smoke CI)

The stepper uses `id="reg-*"` + role/text; the hub Settings / Registrants
/ Config panels and the division builder's restriction fields carry **zero**
`data-testid`s. Text selectors violate the UI-text-breaks-e2e rule, so:

1. Add `data-testid` to: hub Settings panel fields (`reg-settings-enabled`,
   `reg-settings-kind`, `reg-settings-fee`, `reg-settings-currency`,
   `reg-settings-approval`, `reg-settings-capacity`, `reg-settings-save`);
   Registrants panel rows + actions (`reg-row-<status>`, `reg-approve`,
   `reg-reject`, `reg-promote`, `reg-assign-free-agent`); division builder
   restriction fields (`division-builder-category`, `division-builder-age-min`,
   `division-builder-age-max`); stepper submit + status page outcome
   (`reg-submit`, `reg-status-outcome`); join + consent confirm buttons
   (`reg-join-submit`, `reg-consent-grant`).
2. Test hooks are not features: no i18n, no behaviour change. One
   regression test per surface asserting the testid renders (RSC-safe:
   anchor on `data-testid="..."` with the `="`, never a bare probe).
3. Existing e2e specs that use text selectors are NOT rewritten here.

## PR 1 — bench

### Scope

`scripts/bench/lib/register.ts` + `scripts/bench/lib/drivers/`:

1. **PackSchema block** (`lib/pack.ts`, B02): `persons[].dob?`,
   `persons[].gender?`, `divisions[].entry` (default `"admin"`),
   `divisions[].registration?` exactly as spec §4; `provenance` enum gains
   `"synthetic"`. Additive; escalate in the PR body (frozen-schema rule).
2. **Stage-0 funnel checks** (`lib/validate.ts`, B02): the five rules in
   spec §4 (offender actually violates; `expect` arithmetic; capacity ⇒
   waitlist; `pay:true` ⇒ `fee_cents>0`; age band/category ⇒ `dob`/`gender`).
   Each is a typed error with the entry `ext_key` in the message.
3. **Driver interface** (`lib/drivers/types.ts`):
   ```ts
   interface Organiser { configureRegistration(divisionExt, block): Promise<void>;
                         act(action: OrganiserAction): Promise<void> }
   interface Captain   { enter(entry, division): Promise<EntryOutcome>;
                         pay(entry): Promise<void> }
   interface Player    { join(entry, joinCode, consent): Promise<void> }
   type EntryOutcome = { status: "pending"|"approved"|"waitlisted"|"rejected_eligibility"; ref: string }
   ```
   `lib/drivers/http.ts`: cookie-jar per person over B01 `request()`;
   `pay()` is unsupported (throws `PaidEntryNeedsBrowser`).
   `lib/drivers/browser.ts`: plain `playwright` (root dep `^1.61.1`), one
   `BrowserContext` per person, session via the same magic-link
   `login_url` the http client already obtains — `page.goto(login_url)`.
   Own `assert()` — `expect` from `@playwright/test` is a test-runner
   export and does not exist in plain `playwright`. No `test()` wrapper.
   `pay()` drives hosted Checkout: wait for `checkout.stripe.com`, fill
   `#cardNumber` `4242 4242 4242 4242`, `#cardExpiry`, `#cardCvc`,
   `#billingName`, `#billingPostalCode`, click `.SubmitButton,
   button[type=submit]`, then poll the entry's status via API until
   `paid` (timeout ⇒ red: wrong *state*, not slow).
4. **Runner** (`lib/register.ts`): per registration division —
   organiser configures → captains enter (parallel across captains) →
   paid entries pay → players join + consent → organiser actions in pack
   order (`promote` re-runs `pay()` for the promoted captain) → funnel
   oracle (spec §5.2) → hand entrants to B04 by `ext_key`. Mode
   resolution per spec §3: `--entry registration` ⇒ `registration-api`
   for suites 1–12, leaves suite 13 on `registration-ui`.
5. **Pre-flight** (`lib/env.ts`): `STRIPE_SECRET_KEY` starts `sk_test_`;
   `STRIPE_CONNECT_TEST_ACCOUNT` set; webhook secret present and a
   `stripe listen` process forwarding to `/api/webhooks/stripe` (probe:
   `stripe listen` status file or `lsof` on its PID from env
   `STRIPE_LISTEN_PID`); Chromium installed (`playwright` `chromium.executablePath()` exists).
   Abort only if a selected division has `pay:true` or
   `entry:registration-ui`; warn otherwise.
6. **Report** (`lib/report.ts`): per-division funnel table (spec §7);
   "Registration at volume" section when `--entry registration` set.
   Failure artefacts: response body / screenshot + trace path.
7. **`_tiny`** gains one `entry:"registration-ui"` free division
   (2 entries, `approval:manual`, 1 approve, no Stripe) — the browser
   driver's daily floor. `_tiny` under `--entry admin` must still run
   Stripe-free and Chromium-free.
8. pino: `funnel_division_done` (division, entries, entrants,
   waitlisted, rejected, paid_cents, ms), `funnel_pay` (entry, ms).

### Task ladder (TDD, one commit each)

| # | Test first (vitest, DB-free) | Then |
|---|---|---|
| 1 | `pack.test`: registration block parses; `entry` defaults `admin`; `synthetic` provenance accepted | schema |
| 2 | `validate.test`: five stage-0 rules, one red fixture each + one green | validator |
| 3 | `validate.test` regression: offender that does NOT violate ⇒ red "pack lies" | — |
| 4 | `drivers/http.test`: `enter()` request shape vs recorded fixture; `pay()` throws `PaidEntryNeedsBrowser` | http driver |
| 5 | `register.test`: mode resolution table (suite 13 stays ui under `--entry registration`; suites 1–12 ⇒ api; `admin` untouched) | resolver |
| 6 | `register.test`: funnel oracle differ — each of the four `expect` outcomes, "offender admitted" red | oracle |
| 7 | `env.test`: pre-flight matrix (pay:true w/o Stripe ⇒ abort; ui w/o Chromium ⇒ abort; admin ⇒ warn only) | pre-flight |
| 8 | `report.test`: funnel table + volume section render | report |
| 9 | (no unit — no jsdom) browser driver; proven by `_tiny` ui division live | browser driver |
| 10 | `_tiny` ui division; run live both `--entry admin` and default | tiny |

### Do NOT touch

Product code beyond PR 0; packs other than `_tiny`; scheduling (B04) /
simulation (B05) code except the `ext_key` hand-off seam; no synthetic
webhooks (D3); no timing gates.

### Acceptance

- [ ] PR 0 merged first; testids asserted with `="` anchors
- [ ] Stage-0 kills each of the five bad packs offline, message names the `ext_key`
- [ ] `_tiny` green: default (ui division, Chromium, no Stripe) AND `--entry admin` (no Chromium)
- [ ] Paid path proven once live against `_tiny` with a temporary `fee_cents:100` division (not committed): `stripe listen` → `paid` → entrant; timing in PR body
- [ ] Funnel oracle reds on a deliberately admitted offender (flip one `expect`, paste the red, flip back)
- [ ] `--entry registration` on `_tiny` resolves to api path; volume section renders
- [ ] Counts pasted (JSON reporter); lint clean; PR body lists schema escalation + re-pins

### Verify (verbatim)

```bash
npx vitest run --reporter=json --outputFile=/tmp/b3r.json scripts/bench
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/b3r.json
rtk proxy npm run lint
npm run bench:scheduler -- --suite _tiny --wipe
npm run bench:scheduler -- --suite _tiny --wipe --entry admin
npm run bench:scheduler -- --suite _tiny --wipe --entry registration
```

### Output cap

Final message under 15 lines — both PR numbers, counts, `_tiny` funnel
timings, schema escalation, deviations.
