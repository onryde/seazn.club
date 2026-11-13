# Player Payment Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every mail that chases an unpaid registration links to our own per-entry payment page (`/r/pay/[token]`) instead of a raw Stripe Checkout URL, and organisers get a "Send payment reminder" button in the registrant panel.

**Architecture:** A hashed-only bearer token per mail (`registration_pay_tokens`) opens a details-first public page built from one server reader (`payPageDocByToken`). Pay is a POST route that reuses or expires the entry's own session (a new per-entry pointer, `registrations.pay_session_id`) and mints through the existing `createRegistrationCheckout`, with return URLs pointing back at the page. Mail producers stop minting at send time; they mint a page token instead.

**Tech Stack:** Next.js (repo version — read `node_modules/next/dist/docs/` before writing route/page code), postgres.js, Stripe Checkout (Connect destination charges), vitest (node env), Playwright, `scripts/smoke`.

**Spec:** `docs/superpowers/specs/2026-11-11-player-payment-page-design.md` (owner-approved 2026-11-11). Prior art to MIRROR, not import: sponsor invoice page, Task 22 of `docs/superpowers/plans/2026-11-07-sponsor-deals.md`, code on branch `feat/sponsor-deals-invoices-t22` (worktree `/Users/ashokhein/github/seazn.club-worktrees/sponsor-deals-invoices-t22`, NOT merged): `app/(public)/r/sponsor/invoice/[token]/{page.tsx,pay/route.ts,not-found.tsx}`, `lib/sponsor-invoice.ts`, `server/sponsors/invoice-doc.ts`. On main and importable: `server/sponsors/report-token.ts` (`mintReportToken`, `hashReportToken`), `ensureDealCheckout` in `server/usecases/sponsors.ts:767` (pattern only), `app/(public)/r/sponsor/[token]/page.tsx` (public-page contract).

All paths below are relative to `/Users/ashokhein/github/seazn.club-worktrees/player-payment-page` unless absolute; `src/` means `apps/web/src/`.

## Re-pinned facts (verified against the tree at `de335fafa0`, = origin/main + the spec commit)

Raw-Checkout mail producers (grep `checkoutUrl\|payUrl\|createRegistrationCheckout`, by behaviour):

| # | Producer | Mint | Mail field |
|---|---|---|---|
| P1 | T-24h sweep pass 1a, `src/server/usecases/registrations/sweep.ts` | `:151` `createRegistrationCheckout(reg.group_id,[reg.id],ctx,origin,null)` | `:160` `checkoutUrl: url` |
| P2 | T-24h sweep pass 1b (promoted), same file | `:232` | `:239` `checkoutUrl: url` |
| P3 | `notifyPromoted`, `src/server/usecases/registrations/waitlist.ts:329` | `:353` | `:366` `payUrl` |
| P4 | `sendPaymentReminder`, `src/server/usecases/registrations/organiser-actions.ts:170` | none (offline text only) | — (`paymentReminderMessage` at `mail.ts:337`) |
| **P5** | **cart confirmation `notifySubmitted`, `src/server/usecases/registrations/mail.ts:202`** — fed by the register route `src/app/api/v1/public/orgs/[orgSlug]/competitions/[slug]/register/route.ts:101` (`mintGroupCheckout`) and `:121` | via `mintGroupCheckout` (`checkout.ts:338`) | `mail.ts:149` `payUrl` → `lib/email-templates/registration.ts:163` |

Templates carrying the raw link: `src/lib/email-templates/payment-reminder.ts:18` (`checkoutUrl`), `registration-promoted.ts:17` (`payUrl`), `registration.ts:39` (`payUrl`). Out of scope: `sponsor-invoice.ts` / `sponsor-deals.ts:375` (sponsor programme, its own Task 23).

Checkout (`src/server/usecases/registrations/checkout.ts`):
- `createRegistrationCheckout(groupId: string, registrationIds: string[], ctx: DivisionCtx, origin: string, token: string | null): Promise<string>` at `:159`. The fifth argument is the cart's status **access token**, not a "prior" session.
- `returnBase` at `:203-206`: token → `/live/<org>/<comp>/register/status?rid=…&token=…`; null → `/r/<ref_code>?src=email`. `success_url`/`cancel_url` at `:273-274` append `&checkout=…`.
- `expireSupersededCheckoutSession` at `:72` — subsumption (expire prior only when open AND its `registration_ids` ⊆ new ids). Conditional stamp at `:300-305` (`checkout_session_id is not distinct from` the value read) → loser expires its own session and throws 409 `REGISTRATION_CHECKOUT_CONFLICT`. Both verified.
- Line items: `entries.map(reg => ({ unit_amount: reg.amount_cents, … }))` at `:253-260`. No processing-fee line exists anywhere.
- `resumeRegistrationCheckout` (`:384`) is the payability rule to mirror: status `pending`; effective method = division `loadSettings(...).payment_method ?? reg.payment_method`; `amount_cents > 0`; deadline = `promotion_expires_at ?? expires_at`; `ctx.charges_enabled` else 503.

Return-and-confirm (`src/server/usecases/registrations/checkout-completion.ts`): `handleRegistrationCheckoutCompleted(session)` `:150` is the shared core; the three entry points (`reconcileRegistration` `:568`, `reconcileRegistrationBySession` `:612`, `reconcileRegistrationGroupBySession` `:671`) each compare the caller's `session_id` to a STORED pointer before any Stripe call; the group one is rate-limited (`rateLimit("reg-reconcile:<id>", {max:5, windowSeconds:60})`).

Locale: every reminder producer calls `recipientLocale(sql, { pick: reg.locale, userId: reg.user_id, orgDefault: ctx.default_locale })` (`src/server/email-outbox/locale.ts:20`; used at `mail.ts:349`, `waitlist.ts:358`). The page uses exactly this.

Organiser panel: `src/components/registration-hub-registrant-actions.tsx` (buttons; `resend` at `:385/:500`), `registration-hub-registrant-detail.tsx:265-275` mounts it, legality from `deriveRegistrantActionFlags` (`registration-hub-registrant-derive.ts:356`). Route `src/app/api/v1/registrations/[id]/remind/route.ts` exists; `openapi.ts:345` (`errors: [422]`, summary says "offline pay"), `key-scopes.ts:300` (`manage`, pin `registration`). The list row is `RegistrationListRow` (`registrations/list.ts:134`, query `:300`), wire schema `S.RegistrationListEntry` (`api-v1/schemas/registration.ts:187`), served by `GET /competitions/{id}/registrations` (`openapi.ts:330`). Audit rows go to `competition_events(competition_id, org_id, type, payload, actor_id, created_at)` (`usecases/audit.ts:26`); index `(competition_id, created_at)`.

Migrations: highest on origin/main is `V500__drop_org_referral.sql`. In flight elsewhere: `V500__sponsor_invoices.sql` (t21/t22 branches), `V501–V503` (`feat/sponsor-deals-invoices`), `V501__sponsor_poster.sql` (`feat/title-sponsor-poster`, which memory says will renumber to V503). **This plan takes `V505`**, above every known in-flight number with one spare; re-list `db/migration/deltas/` on origin/main at rebase time and bump if taken.

## False premises found (record; do not build on the spec's wording)

1. **A fifth raw-link producer exists**: the cart confirmation mail (P5). The spec lists only P1–P4.
2. **No "processing fee passed on" setting exists**; Checkout's only line items are `amount_cents`. The page shows no processing line (the spec's condition is never true).
3. **No organiser contact is stored** (`organizations` has no contact/email column) and **competitions have no venue column**. The page shows the org name only; contact and venue lines are absent.
4. **Nothing reads `registration.payment_reminded`** today; the panel shows no "last reminded". This plan adds the read.
5. **The deadline is `promotion_expires_at ?? expires_at`**, not `expires_at` alone (a promoted entry has its own window).
6. `createRegistrationCheckout`'s fifth parameter is the access `token`, not `prior`; and token-less mints (P1–P3) already return to `/r/<ref>?src=email`, not "the registration page".
7. **No per-entry paid timestamp exists** (`offline_marked_paid_at` is the cart's, offline only). "Paid with the date" is read from the first `competition_events` row of type `registration.confirmed | registration.paid_awaiting_approval | registration.offline_paid | registration.fee_waived` whose `payload->>'registration_id'` is the entry; none → "Paid" without a date.
8. The group's single `checkout_session_id` cannot serve as the per-entry reuse pointer (a sibling's mint overwrites it, after which a second Pay press would mint a second payable session for this entry). Hence the new `registrations.pay_session_id`.

## Global Constraints

- One PR for the whole feature; each task is one commit on `feat/player-payment-page`, green on its own. Do not push until the whole-branch review.
- Route: `/r/pay/[token]` (page) and `/r/pay/[token]/pay` (POST). Static `pay` outranks `/r/[ref]`; ref codes are 6 chars so `pay` is never a ref.
- Token: 32 random bytes base64url via `mintReportToken`, stored only as `hashReportToken(token)` (sha256 bytea). A fresh token per mail; every token for an entry stays valid; state, not token revocation, closes the page.
- Public-page contract, copied from `app/(public)/r/sponsor/[token]/page.tsx`: `export const dynamic = "force-dynamic"`; metadata `robots: {index:false, follow:false}`, `referrer: "no-referrer"`; `publicRateLimit` BEFORE the lookup (throttled screen, no row touched); one opaque `notFound()` for unknown, malformed, withdrawn and rejected; `ph-no-capture` on every element that paints the token (the Pay form); token scrubbed via `SECRET_PATH_ROUTES` in `src/lib/scrub-score-url.ts`.
- Pay is POST-only, never GET; never mints when not payable. Reuse margin: **10 minutes** (`PAY_SESSION_REUSE_MARGIN_MS = 10 * 60_000`, same value as `sponsors.ts:626`).
- Pays for this entry only: `createRegistrationCheckout(reg.group_id, [reg.id], ctx, origin, null, { returnBase })`.
- In-app registration flow return URLs unchanged: the new `opts` argument is optional and every existing caller omits it.
- Reminder limits: cap **5 organiser reminders per entry per rolling 24 h** (6th → 429 `PAYMENT_REMINDER_LIMIT`), confirm when the last one was **< 1 hour** ago; counted from `registration.payment_reminded` audit rows only.
- Copy: `reg.action.remind` becomes "Send payment reminder" (es/fr/nl translated); `reg.action.remindTitle` unchanged. Every new string in `src/dictionaries/{en,es,fr,nl}/{ui,emails}.json`, then `node --experimental-strip-types scripts/i18n/gen-keys.ts`. No hardcoded English.
- UI verified by screenshot at 320, 768, 1280 with no horizontal page scroll; screenshots go to the local sign-off server (:8765), never committed.
- Tests: `docs/superpowers/TEST-STRATEGY.md` binds — empty case first, counted sweeps (zero checked fails), expected values from the source of truth (Stripe line items, dictionaries, the engine of record), each new guard mutated once with the killer test named in the task's commit body. Tokens in DB tests come from the REAL producer (spy on `mintPayToken`), never a hand-inserted hash. Every task owes unit, E2E, smoke and regression tests (RULES.md); tasks with no reachable surface name the T7 test that traces them forward.
- Verify only the scoped files (never the full suite). Vitest: `cd /Users/ashokhein/github/seazn.club-worktrees/player-payment-page/apps/web && rtk proxy npx vitest run <paths> --reporter=json --outputFile=<scratch>/vt.json; echo EXIT=$?` — green only when `EXIT=0` and `numPassedTests == numTotalTests > 0` with your files in `.testResults[].name`. DB/e2e environment: follow the `seazn-local-env` skill (fresh DB needs `db:apply` + `sync:sports`).
- Before each commit: `npm run openapi:gen && git status --porcelain openapi/` empty (only T6 changes the API).

## Review Focus

1. **Cart sibling with an open cart session.** Cart {A,B} has open session S{A,B}; A's page mints S{A}; S{A,B} stays open (not subsumed). A pays S{A}, then B pays S{A,B}: A is charged twice and must be auto-refunded by the existing `kind:"duplicate"` path, B confirmed. Test in T3 (both orders).
2. **Page opened after the deadline but before the hourly sweep expires the row.** Status is still `pending`; the page must show "deadline passed" and Pay must 409 without minting. Test in T2 and T3 (deadline = `promotion_expires_at` for a promoted entry, the case where it differs from `expires_at`).
3. **Organiser switches the division card → offline (or waives / marks paid) after the mail went out.** The page reads the division's method at view time; a stale tab's Pay press gets 409. Test in T2 (method switch) and T3 (marked paid offline → 409, zero `create`).
4. **Return with a `session_id` that is not the entry's current `pay_session_id`** (an old tab, a forged query). No confirming spinner, no Stripe call; the page renders its normal state. Test in T4.
5. **Connect disabled (`charges_enabled = false`) after the mail.** Pay answers 503 copy in the entry's language, not a 500, and mints nothing. Test in T3/T4.

---

### Task 1: Pay-token table, per-entry session pointer, token helpers

**Files:**
- Create: `db/migration/deltas/V510__registration_pay_tokens.sql` (authored as V505; renumbered at the rebase onto main)
- Create: `src/server/usecases/registrations/pay-token.ts`
- Create: `src/lib/registration-pay.ts` (client-safe: paths, notice flag, headers)
- Modify: `src/server/usecases/registrations/index.ts` (barrel exports)
- Test: `src/server/usecases/__tests__/registration-pay-token.test.ts`

**Interfaces:**
- Produces (SQL): `registration_pay_tokens(token_hash bytea primary key, registration_id uuid not null references registrations(id) on delete cascade, org_id uuid not null references organizations(id) on delete cascade, created_at timestamptz not null default now())`, index on `registration_id`, RLS enabled + forced, policy `registration_pay_tokens_tenant for all to app_user using (org_id = current_org_id()) with check (same)`, `grant select, insert to app_user` (mirror `sponsor_report_links`, `V492__sponsor_rotation.sql:248-270`). `alter table registrations add column pay_session_id text null`.
- Produces (TS, `pay-token.ts`):
  - `mintPayToken(): { token: string; tokenHash: Buffer }` — `mintReportToken()` + `hashReportToken()` from `@/server/sponsors/report-token`.
  - `recordPayToken(db: Tx | typeof sql, a: { tokenHash: Buffer; registrationId: string; orgId: string }): Promise<void>`
  - `issuePayLink(origin: string): { url: string; tokenHash: Buffer }` — calls `mintPayToken()`, returns `${origin}${registrationPayPath(token)}`. The raw token leaves only inside `url`.
  - `registrationIdByPayToken(token: string): Promise<string | null>` — one lookup by hash on the pool, never logs or shape-checks the token.
- Produces (`lib/registration-pay.ts`): `registrationPayPath(token: string): string` → `/r/pay/${token}`; `PAY_NOTICE_PARAM = "notice"`; `PAY_RECORDING_NOTICE = "recording"`; `registrationPayRecordingPath(token)`; `REG_PAY_PRIVATE_HEADERS` (same three headers as `INVOICE_PRIVATE_HEADERS` on t22).

- [ ] **Step 1: Write the failing tests** in `registration-pay-token.test.ts`:
  - `unknown token resolves to null (empty case first)`: `registrationIdByPayToken("x".repeat(43))` and `registrationIdByPayToken("")` → `null`.
  - `a recorded token resolves to its entry, and only its hash is stored`: `const { url, tokenHash } = issuePayLink("https://h")`; record for a seeded pending entry (`_registration-fixtures.ts`); token = last path segment of `url`; expect `registrationIdByPayToken(token)` = entry id; expect `select token_hash from registration_pay_tokens` equals `createHash("sha256").update(token).digest()` and no column holds `token`.
  - `two links for one entry both resolve`: issue+record twice → 2 rows, both resolve to the same id; tokens differ; count asserted = 2.
  - `token is 43 base64url chars`: `/^[A-Za-z0-9_-]{43}$/`.
  - `app_user under another org cannot read the row`: insert under org A, read via `withTenant(orgB)` → 0 rows; via `withTenant(orgA)` → 1 (positive pair).
  - `pay_session_id exists and defaults null` on a fresh entry.
- [ ] **Step 2: Run to verify failure** — the vitest command from Global Constraints on the test file. Expected: FAIL (module/table missing).
- [ ] **Step 3: Write the migration and the two modules** with the signatures above. Apply locally (`db:apply` per `seazn-local-env`).
- [ ] **Step 4: Run to verify pass.** Expected `EXIT=0`, 6/6.
- [ ] **Step 5: Mutate once**: drop `force row level security` → the cross-org test must fail; restore. Record the killer in the commit body.
- [ ] **Step 6: E2E / smoke** — no surface yet; traced forward by T7 `registration-pay-page.spec.ts` "card golden path" and smoke `registrationPayPage`.
- [ ] **Step 7: Commit** `feat(registration): pay-page tokens and per-entry session pointer (V505)`. (Renumbered to V510 at the rebase onto main.)

### Task 2: The page document — `payPageDocByToken`

**Files:**
- Create: `src/server/usecases/registrations/pay-page.ts`
- Modify: `src/server/usecases/registrations/checkout.ts` (extract `registrationLineItems`, used by the mint unchanged)
- Modify: `src/server/usecases/registrations/index.ts`
- Test: `src/server/usecases/__tests__/registration-pay-page-doc.test.ts`

**Interfaces:**
- Consumes: `registrationIdByPayToken`, `recipientLocale`, `divisionCtx`, `loadSettings`, `regGroupCols`, `fillPaymentInstructions` (`@/lib/payment-instructions`).
- Produces:
  - `registrationLineItems(entries: Pick<RegistrationWithGroupRow, "amount_cents" | "currency" | "display_name">[], compName: string): Stripe.Checkout.SessionCreateParams.LineItem[]` (exported from `checkout.ts`; `createRegistrationCheckout` now calls it — byte-identical params).
  - `type PayPageState = "pay" | "offline" | "paid" | "refunded" | "deadline_passed" | "waitlisted"`; `PAY_PAGE_STATES` const array.
  - `interface PayPageDoc { registrationId; groupId; orgId; locale: Locale; state: PayPageState; competitionName; divisionName; startsOn: string | null; endsOn: string | null; entrantName: string; members: string[]; currency: string; lines: { label: string; amountCents: number }[]; totalCents: number; refundedCents: number; deadline: Date | null; refCode: string | null; orgName: string; paymentInstructions: string | null; paidAt: Date | null; paySessionId: string | null }`
  - `payPageDocByToken(token: string, now: Date): Promise<PayPageDoc | null>`
- State rules (first match wins; write them as this ordered table in the module):
  1. no token row, or status `withdrawn` / `rejected` → `null` (owner 2026-11-11: same as withdrawn);
  2. `waitlisted` → `waitlisted`;
  3. `paid` / `confirmed` → `refunded` when `refunded_cents > 0`, else `paid` (with `paidAt` from the audit rows in false premise 7);
  4. `expired`, or `pending` with `deadline = promotion_expires_at ?? expires_at` set and `<= now` → `deadline_passed`;
  5. `pending` and effective method (`loadSettings(division).payment_method ?? group.payment_method`) is `offline` → `offline`, `paymentInstructions` = division instructions ?? org instructions, filled with `ref_code`;
  6. `pending` card → `pay`.
- `lines`/`totalCents` come from `registrationLineItems([reg], ctx.comp_name)` (`unit_amount × quantity`), never from `amount_cents` read separately. `members` from `registration_players` display names in roster order (empty for an individual).

- [ ] **Step 1: Write the failing tests** (tokens via `issuePayLink` + `recordPayToken` exactly as the producers will; seeds from `_registration-fixtures.ts`). Each `it` is one state; a final sweep counts them:
  - `unknown token → null` (FIRST).
  - `unpaid card entry → pay`, `totalCents` equals the sum of `unit_amount` that a captured `getStripe().checkout.sessions.create` mock receives when `createRegistrationCheckout` is called for the same entry (source of truth = the Checkout params, not `amount_cents`).
  - `offline entry → offline`, instructions contain the `ref_code`, no `pay`.
  - `division switched card→offline after the token was minted → offline` (Review Focus 3).
  - `confirmed card entry → paid`, `paidAt` = the `registration.confirmed` row's `created_at`; `confirmed with no audit row → paid, paidAt null`.
  - `refunded_cents 500 → refunded`, `refundedCents === 500`.
  - `pending, expires_at in the past → deadline_passed`; `promoted entry whose promotion_expires_at passed while the group expires_at is in the future → deadline_passed` (the case where the wrong column gives `pay`); `expires_at null → pay, deadline null`.
  - `status expired → deadline_passed`.
  - `waitlisted → waitlisted`.
  - `withdrawn → null`, `rejected → null`.
  - `locale follows the mail`: entry `locale = "nl"` → `"nl"`; `locale null, linked user "fr"` → `"fr"`; neither, org default `"es"` → `"es"` (each case differs from the default `en`).
  - `team entry lists members` (2 members in order) and `individual lists none`.
  - Sweep: `every PayPageState is reached`: collect states from the cases above into a Set; `expect(set.size).toBe(PAY_PAGE_STATES.length)` and `> 0`.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** `registrationLineItems` (extract only) and `payPageDocByToken`.
- [ ] **Step 4: Run the new file plus the existing checkout suites** `registration-checkout-guards.test.ts`, `registration-checkout-supersede.test.ts` (regression for the extraction). Expected all green with counts.
- [ ] **Step 5: Mutate once each**: swap `promotion_expires_at ?? expires_at` to `expires_at` (killer: promoted-deadline case); move rule 3 below rule 4 (killer: a confirmed entry with a past `expires_at` must stay `paid` — add that case if nothing kills it).
- [ ] **Step 6: E2E / smoke** traced forward to T4's page spec and T7.
- [ ] **Step 7: Commit** `feat(registration): payment page document by token`.

### Task 3: Pay — reuse-or-expire on the entry's own session, return to the page, confirm on return

**Files:**
- Modify: `src/server/usecases/registrations/checkout.ts` (`createRegistrationCheckout` sixth arg)
- Create: `src/server/usecases/registrations/pay-page-checkout.ts`
- Modify: `src/server/usecases/registrations/checkout-completion.ts` (new reconcile entry point)
- Modify: `src/server/usecases/registrations/index.ts`
- Test: `src/server/usecases/__tests__/registration-pay-page-checkout.test.ts`

**Interfaces:**
- Consumes: `payPageDocByToken`, `registrationPayPath`, `divisionCtx`, `handleRegistrationCheckoutCompleted`, `checkoutRegistrationIds`, `rateLimit`.
- Produces:
  - `createRegistrationCheckout(groupId, registrationIds, ctx, origin, token, opts: { returnBase?: string } = {}): Promise<string>` — when `opts.returnBase` is set it replaces the computed `returnBase` (it must already contain `?`; `&checkout=…` is appended as today). Every existing caller unchanged.
  - `PAY_SESSION_REUSE_MARGIN_MS = 10 * 60_000`
  - `payFromPayPage(token: string, origin: string, now?: Date): Promise<string>` → Checkout URL. Order: doc (`null` → 404 `HttpError(404)`); `state !== "pay"` → 409 `REGISTRATION_NOT_PAYABLE`; if `pay_session_id`: `sessions.retrieve` → `complete` → 409 `REGISTRATION_PAID_ONLINE`; `open` AND `checkoutRegistrationIds(s)` equals exactly `[reg.id]` AND `s.expires_at*1000 > now + margin` → return `s.url` (no create); `open` otherwise → `sessions.expire`; then `ctx.charges_enabled` else 503; mint with `{ returnBase: `${origin}${registrationPayPath(token)}?src=pay` }`; stamp `update registrations set pay_session_id = <new> where id = <reg> and pay_session_id is not distinct from <read>`; lost → expire new, 409 `REGISTRATION_CHECKOUT_CONFLICT`. Outside any transaction (as `ensureDealCheckout`).
  - `reconcileRegistrationByPaySession(registrationId: string, sessionId: string): Promise<boolean>` — rate-limited `reg-pay-reconcile:<id>` (5/60 s); compares `sessionId` to `registrations.pay_session_id` BEFORE any Stripe call; then `payment_status === "paid"` and ids include the entry → `handleRegistrationCheckoutCompleted(session)`. Never throws.
- Session plumbing re-verified (premise check, keep in the test file header): subsumption expire, conditional group stamp and explicit `registration_ids` metadata hold as described in "Re-pinned facts".

- [ ] **Step 1: Write the failing tests** (Stripe mocked the way `registration-checkout-supersede.test.ts` does; tokens from `issuePayLink`):
  - `unknown token → 404, zero sessions.create` (FIRST).
  - `two Pay presses → one sessions.create, same URL` (the second retrieves the stored open session with 23 h left).
  - `stored session with 9 minutes left → expired, then a new one minted` (assert `expire` called with the old id, `create` once, `pay_session_id` = new id); `with 11 minutes left → reused` (boundary pair).
  - `stored session covering [A,B] is not reused for A` → a new `create` for `[A]` only.
  - `paid / confirmed / offline / deadline passed / waitlisted → 409 REGISTRATION_NOT_PAYABLE, zero create` — one `it.each` over the non-`pay` states; assert the row count checked equals `PAY_PAGE_STATES.length - 1`.
  - `marked paid offline after the page loaded → 409, zero create` (Review Focus 3).
  - `stored session complete (webhook not landed) → 409 REGISTRATION_PAID_ONLINE, zero create`.
  - `charges_enabled false → 503, zero create` (Review Focus 5).
  - `return URLs point at the page`: captured `create` params have `success_url` starting with `${origin}/r/pay/${token}?src=pay&checkout=success&session_id=` and `cancel_url` with `&checkout=cancelled`.
  - Regression: `in-app mint keeps its return URLs`: `mintGroupCheckout(..., token)` → `success_url` contains `/register/status?rid=`; `createRegistrationCheckout(..., null)` (no opts) → `/r/<ref>?src=email`.
  - `concurrent Pay presses leave one payable session`: `Promise.all` two `payFromPayPage`; exactly one resolves, the other 409 conflict; every `create`d session except the stamped one was `expire`d.
  - Cart sibling sequence (Review Focus 1), both orders, through `handleRegistrationCheckoutCompleted`: cart {A,B} session S1 open; A pays S_A from the page; then S1 completes → A gets the `duplicate` refund path, B confirmed. Reverse order: S1 completes first (A and B confirmed), then A's page shows `paid` and Pay 409s.
  - `reconcileRegistrationByPaySession`: foreign session id → `false` and zero `retrieve`; matching paid session → entry confirmed; unpaid → `false`; 6th call within 60 s → `false` with zero `retrieve`.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** the three signatures.
- [ ] **Step 4: Run** the new file + `registration-checkout-guards.test.ts`, `registration-checkout-supersede.test.ts`, `registration-webhook-fulfilment.test.ts`. All green, counts pasted.
- [ ] **Step 5: Mutate once each, one at a time** (money path): remove the reuse branch (killer: two presses → one create); change margin comparison `>` to `>=0` i.e. ignore expiry (killer: 9-minute case); drop the exact-ids check (killer: [A,B] case); delete the `state !== "pay"` guard (killer: the `it.each`); remove the pointer compare in reconcile (killer: foreign id → zero retrieve).
- [ ] **Step 6: E2E / smoke** traced forward: T7 card golden path (Pay → Stripe → back → Paid) and smoke "Pay on a paid entry 409".
- [ ] **Step 7: Commit** `feat(registration): pay from the payment page with reuse-or-expire`.

### Task 4: The public page, the Pay route and the scrub

**Files:**
- Create: `src/app/(public)/r/pay/[token]/page.tsx`, `not-found.tsx`, `pay/route.ts`
- Create: `src/components/registrations/pay-page-view.tsx` (server view) and `pay-page-confirming.tsx` (client island: `router.refresh()` every 4 s, at most 15 times, then a "taking longer" line)
- Modify: `src/lib/scrub-score-url.ts` (`SECRET_PATH_ROUTES` gains `"/r/pay/"` and its doc comment), `src/lib/__tests__/_route-scan.ts` (`VERDICTS["(public)/r/pay/[token]"] = true`)
- Modify: `src/dictionaries/{en,es,fr,nl}/ui.json`, then regenerate `src/lib/i18n-keys.ts`
- Test: `src/app/(public)/r/pay/[token]/__tests__/page.test.tsx`, `route-shape.test.ts`, `routes.test.ts`; `src/lib/__tests__/scrub-path-secrets.test.ts`, `scrub-secret-painters.test.ts`
- E2E: `apps/web/e2e/registration-pay-page.spec.ts` (created here; T6/T7 extend it)
- Smoke: `scripts/smoke/suites/registrationPayPage.ts` + register in `scripts/smoke/index.ts` `SELECTABLE_SUITES`

**Interfaces:**
- Consumes: `payPageDocByToken`, `payFromPayPage`, `reconcileRegistrationByPaySession`, `lib/registration-pay.ts`, `publicRateLimit`, `baseUrl` (`@/lib/oauth`), `getDictionary(doc.locale, "ui")`.
- Produces: `isPayConfirming(doc: PayPageDoc, q: { checkout?: string; session_id?: string; notice?: string }): boolean` (in `lib/registration-pay.ts`, pure) — true only when `doc.state === "pay"` and either `q.notice === PAY_RECORDING_NOTICE`, or `q.checkout === "success"` and `q.session_id === doc.paySessionId`.
- Page flow: throttled → notice screen; `checkout=success` with a `session_id` → `reconcileRegistrationByPaySession` then re-read; `doc === null` → `notFound()`; render in `doc.locale`; head/404/throttle in the reader's `resolveLocale()` (as the sponsor pages).
- Pay route (mirror t22 `pay/route.ts`): `publicRateLimit(req)` first; success → 303 to Checkout with `REG_PAY_PRIVATE_HEADERS`; 409 `REGISTRATION_PAID_ONLINE` → 303 to `registrationPayRecordingPath(token)`; other 409 → **409** short text (spec) in the entry's locale when resolvable, else the reader's; 404/429/503/502 → that status, short translated text. Never a 500 for an `HttpError`.
- Copy keys (ui.json, `regPay.*`): `meta.title`, `meta.description`, `notFound.title`, `notFound.body`, `throttled.title`, `throttled.body`, `heading`, `competition`, `division`, `dates`, `entrant`, `members`, `fee`, `total`, `deadline`, `reference`, `organiser`, `pay` (`Pay {amount}`), `payHint`, `offline.title`, `state.paid`, `state.paidOn` (`Paid on {date}`), `state.refunded` (`Refunded {amount}`), `state.deadlinePassed` ("Payment deadline passed — contact the organiser"), `state.waitlisted` ("You're on the waitlist — we'll email you if a place opens"), `confirming.title` ("Payment received — confirming…"), `confirming.slow`, `refused.notPayable`, `refused.unavailable`, `refused.failed`. Exact wording within the owner's decisions is the builder's.

- [ ] **Step 1: Write the failing tests:**
  - `page.test.tsx` (static render, the t22 `page.test.tsx` shape): one case per `PayPageState` plus `confirming`, asserting the PRESENCE of the state's copy (read from `en/ui.json`) and of a Pay form (`form[action$="/pay"][method="post"]`) only in `pay`; count of states rendered = `PAY_PAGE_STATES.length + 1`. `offline` shows the instructions and the ref and no form. `confirming` shows `confirming.title` and no form. Every element carrying the token has class `ph-no-capture`. `nl` doc renders `nl` copy.
  - `isPayConfirming` table: `session_id` ≠ `paySessionId` → false (Review Focus 4); equal → true; `notice=recording` → true; any of those on a `paid` doc → false.
  - `route-shape.test.ts`: page exports `dynamic = "force-dynamic"`; metadata robots/referrer; Pay route exports POST only (no GET).
  - `routes.test.ts`: Pay POST unknown → 404 text and zero `create`; paid → 409; pay state → 303 to the mocked Checkout URL with `Referrer-Policy: no-referrer`; complete session → 303 to `?notice=recording`; throttled → 429 and zero DB reads; `charges_enabled` false → 503 translated.
  - Scrub: `/r/pay/<real token from mintPayToken>` and `/r/pay/<token>/pay?x=1`, plain and URL-encoded at depth 2, after an origin and after a locale prefix → token absent from the output; `/r/ABC123` and `/r/sponsor/<t>` unchanged in behaviour (regression); the route-scan sweep's checked count rises by exactly the new route.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** the page, view, island, route, scrub entry and route-scan verdict; add the copy to all 4 locales; run `node --experimental-strip-types scripts/i18n/gen-keys.ts`.
- [ ] **Step 4: Run** the files above plus `scrub-score-url-wiring.test.ts`, `scrub-request-body.test.ts`. All green with counts.
- [ ] **Step 5: Mutate once**: remove `"/r/pay/"` from `SECRET_PATH_ROUTES` (killer: scrub test); drop `ph-no-capture` from the Pay form (killer: painter test); make `isPayConfirming` ignore the session compare (killer: Review Focus 4 case).
- [ ] **Step 6: E2E** `registration-pay-page.spec.ts` › `offline entry shows instructions and no Pay`, and `unknown token is the opaque 404` — seed via SQL fixtures, obtain the token through the organiser reminder API (`POST /api/v1/registrations/:id/remind`) and the outbox opener from T7 Step 1 — **if T7's opener is not built yet, build it here** (move T7 Step 1 into this task). Run at 320/768/1280 projects; assert `document.documentElement.scrollWidth <= innerWidth`.
- [ ] **Step 7: Smoke** `registrationPayPage`: `GET /r/pay/<43 random chars>` → 404 body contains `regPay.notFound.body` (en); POST Pay on an entry marked paid → 409, `registration_groups.checkout_session_id` unchanged. Run `SMOKE_ONLY=registrationPayPage npm run test:smoke`.
- [ ] **Step 8: Screenshots** of each state at 320/768/1280 to :8765; `frontend-design` skill applied, house theme, mockups are layout only.
- [ ] **Step 9: Commit** `feat(registration): public payment page and pay route`.

### Task 5: Every mail links the page — sweep, waitlist, organiser reminder, cart confirmation

**Files:**
- Modify: `src/lib/email-templates/payment-reminder.ts`, `registration-promoted.ts`, `registration.ts` (rename the link field to `payPageUrl`; add `method: "card" | "offline"` to the reminder/promoted args)
- Modify: `src/server/usecases/registrations/mail.ts` (`paymentReminderMessage` takes `payPageUrl`; `buildCartMail`/`notifySubmitted` drop the `payUrl` parameter — see P5 decision)
- Modify: `src/server/usecases/registrations/sweep.ts` (passes 1a/1b), `waitlist.ts` (`notifyPromoted`), `organiser-actions.ts` (`sendPaymentReminder`)
- Modify: `src/app/api/v1/public/orgs/[orgSlug]/competitions/[slug]/register/route.ts:121` (stop passing `checkout_url` to the mail; the API response's `checkout_url` is unchanged)
- Modify: `src/server/usecases/registrations/disputes.ts:279` (call-site arity only)
- Modify: `src/dictionaries/{en,es,fr,nl}/emails.json` (`paymentReminder.viewDetails`, `paymentReminder.textViewDetails`, `registrationPromoted.viewDetails`, `registrationPromoted.textViewDetails`), regenerate keys
- Test: `src/server/usecases/__tests__/pay-link-mail-producers.test.ts` (new sweep), update `payment-reminder-outbox.test.ts`, `registration-promoted-outbox.test.ts`, `src/lib/__tests__/email-builders.test.ts`

**Interfaces:**
- Consumes: `issuePayLink`, `recordPayToken`.
- Produces: `paymentReminderMessage(reg, ctx, o: { feeCents; paymentInstructions; method: "card" | "offline"; payPageUrl: string; payDeadline?; refCode? })`.
- Producer rules:
  - P1/P2: after the lease claim, `issuePayLink(origin)`, render, then ONE transaction: `recordPayToken` + `enqueueEmailOnce` + the `*_reminded_at` mark. No Stripe call. The `minted` flag and its log branch go; any throw before commit releases the lease (nothing external happened). `charges_enabled` skip stays.
  - P3: card (`method === "stripe" && amount_cents > 0`) or offline with a fee → `issuePayLink`; `recordPayToken` + `enqueueEmailOnce` in one `sql.begin`. Free promotion → no link, no token.
  - P4: `issuePayLink`; `recordPayToken` inside the existing `withTenant` tx beside `enqueueEmail` + audit. Card and offline alike; offline keeps instructions in the body.
  - **P5 (decision, flagged to owner):** the cart confirmation's Pay button points at the cart's existing token-bearing status page (`statusUrl`, `/live/<org>/<comp>/register/status?rid=&token=`) when the cart is `stripe` with a payable total and a token is present, else no button. Reason: it is our own details-first page, pays the whole cart (the per-entry page would split a cart into separate charges), never expires, and mints no token. No Checkout URL reaches any mail.

- [ ] **Step 1: Write the failing producer sweep** `pay-link-mail-producers.test.ts`: a table of producers `[sweep1a, sweep1b, notifyPromoted(card), notifyPromoted(offline), sendPaymentReminder(card), sendPaymentReminder(offline), notifySubmitted(card cart)]`; for each, drive the REAL producer with `mintPayToken` spied (capturing tokens) and Stripe mocked; open the queued body (`openBody` from `src/server/email-outbox/seal.ts`); assert html AND text contain no `checkout.stripe.com` and no `cs_test_`; for P1–P4 assert they contain `${origin}/r/pay/${capturedToken}` and that `registrationIdByPayToken(capturedToken)` = the entry; for P5 assert it contains the `statusUrl`. Assert `sessions.create` was called **0** times across P1–P4. Final: `expect(checked).toBe(7)`.
  - Plus: `the mail's grep source has no raw-link field left`: read the three template files and `mail.ts` as text; `checkoutUrl` and `payUrl` occur 0 times (guards a future producer re-adding the field).
  - Plus regression: sweep 1a twice → one mail, one token (once-key holds); a throw inside the queue tx → lease released, zero tokens, zero mails.
  - Plus locale: a `nl` entry's reminder body uses `nl` copy for `paymentReminder.viewDetails` (offline) — expected text read from `nl/emails.json`.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** templates, `paymentReminderMessage`, the five producers; copy in 4 locales; gen-keys.
- [ ] **Step 4: Run** the new sweep + the three updated suites + `outbox-kind-sweep.test.ts`. Green with counts.
- [ ] **Step 5: Mutate once**: in sweep 1a pass `checkoutUrl`-style raw URL back (re-add a `createRegistrationCheckout` call and feed its URL) → killer: the producer sweep; skip `recordPayToken` in P4 → killer: `registrationIdByPayToken` assertion.
- [ ] **Step 6: E2E** traced forward to T7 golden path (reminder → mailed link → page). **Smoke**: extend `registrationPayPage` — organiser reminder via API, opened body contains `/r/pay/` and no `checkout.stripe.com`.
- [ ] **Step 7: Commit** `feat(registration): reminder, promotion and confirmation mails link our pages, not Checkout`.

### Task 6: Organiser "Send payment reminder" — button, last reminded, limits

**Files:**
- Modify: `src/server/usecases/registrations/organiser-actions.ts` (`sendPaymentReminder` cap)
- Modify: `src/server/usecases/registrations/list.ts` (`last_reminded_at` on `RegistrationListRow` and the query)
- Modify: `src/server/api-v1/schemas/registration.ts` (`RegistrationListEntry.last_reminded_at: z.string().datetime().nullable()` or the file's date convention), `src/server/api-v1/openapi.ts:345` (summary drops "(offline pay)", says it links the payment page and caps at 5 per 24 h; `errors: [422, 429]`), regenerate `openapi/v1.json`. `key-scopes.ts:300` needs no change (route exists) — confirm the drift check stays clean.
- Modify: `src/components/registration-hub-registrant-derive.ts` (`canRemind`), `registration-hub-registrant-actions.tsx` (button + confirm + error mapping), `registration-hub-registrant-detail.tsx` (pass `lastRemindedAt`; "Last reminded {ago}" line)
- Modify: `src/dictionaries/{en,es,fr,nl}/ui.json`: `reg.action.remind` → "Send payment reminder" (+ translations); new `reg.remind.lastReminded` ("Last reminded {ago}"), `reg.remind.confirmRecent.title`, `reg.remind.confirmRecent.body`, `reg.remind.limit` ("This entry has had 5 reminders in the last 24 hours. Try again later."); gen-keys
- Test: `src/server/usecases/__tests__/payment-reminder-outbox.test.ts` (extend), `src/components/__tests__/registration-hub-registrant-derive.test.ts`, `registration-hub-registrant-actions.test.tsx`, `src/server/usecases/__tests__/` list test that covers `listRegistrations` (find by grep `listRegistrations(`)
- E2E: extend `apps/web/e2e/registration-pay-page.spec.ts`; check `e2e/registration-hub.spec.ts` for an action control-set assertion that must now include `remind`

**Interfaces:**
- Produces: `REMINDER_CAP_PER_DAY = 5`, `REMINDER_CONFIRM_WITHIN_MS = 60 * 60_000`; `HttpError(429, "...", "PAYMENT_REMINDER_LIMIT")`; `RegistrationListRow.last_reminded_at: Date | null` = latest `competition_events.created_at` with `type = 'registration.payment_reminded'` and `payload->>'registration_id' = r.id::text` (scoped by `competition_id = c.id` to use the index); `RegistrantActionFlags.canRemind = status === "pending" && division_fee_cents > 0`; `RegistrationHubRegistrantActionsProps.lastRemindedAt: string | null`.
- Cap mechanics: inside the existing `withTenant` tx, `select … from registrations where id = $1 for update` first, then count the audit rows in the last 24 h; `>= 5` → 429 before enqueue. The lock serialises two concurrent presses.
- Client: the button sits after "resend"; when `lastRemindedAt` is within 1 h, `useConfirm` with the `confirmRecent` copy first; success → `reg.remind.sent`, `{ sent: false }` → `reg.remind.notSent`; `ApiV1Error.code === "PAYMENT_REMINDER_LIMIT"` → `reg.remind.limit` (translated, not the server's English); then `router.refresh()`.

- [ ] **Step 1: Write the failing tests:**
  - Server: `no prior reminders → sent` (empty case first); `5 reminders inside 24 h → 6th is 429 PAYMENT_REMINDER_LIMIT, no outbox row, no audit row`; `5 reminders of which one is 24 h + 1 min old → 6th sent` (boundary pair); `sweep and waitlist mails do not count` (seed 5 sweep reminders → organiser press sent); `two concurrent presses at count 4 → exactly one sent`; `pending entry in a free division → 422 (unchanged)`.
  - List: `last_reminded_at` null with no rows; equals the newest row's `created_at` with three rows; another entry's row does not leak (count of rows checked = 3).
  - Derive: `canRemind` true only for `pending` with fee > 0; the completeness test's flag list includes it; a `paid` / `waitlisted` / free-division row → false.
  - Actions (static render): `remind` button present iff `canRemind`, label = `en` `reg.action.remind` = "Send payment reminder" read from the dictionary.
  - i18n: the four locales' `reg.action.remind` values all differ from their previous value (the rename landed everywhere).
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement**; copy in 4 locales; gen-keys; `npm run openapi:gen`.
- [ ] **Step 4: Run** the files above; `git status --porcelain openapi/` shows only the intended `v1.json` change, committed with this task.
- [ ] **Step 5: Mutate once**: change `>= 5` to `> 5` (killer: 6th refused); remove `for update` (killer: concurrent presses); drop the `type` filter in `last_reminded_at` (killer: list test with a non-reminder audit row — add one).
- [ ] **Step 6: E2E** in `registration-pay-page.spec.ts` › `organiser reminds from the panel`: open the registrant detail, button visible, press → "Payment reminder sent." and "Last reminded" appears; press again → the confirm dialog shows; confirm → sent. Run at 320/768/1280; existing `registration-hub.spec.ts` whole file re-run (not a `-g` slice) if it enumerates actions.
- [ ] **Step 7: Smoke**: `registrationPayPage` posts remind 6 times → 6th status 429 with code `PAYMENT_REMINDER_LIMIT`.
- [ ] **Step 8: Screenshots** of the detail panel at 320/768/1280.
- [ ] **Step 9: Commit** `feat(registration): send payment reminder from the registrant panel, capped and confirmed`.

### Task 7: End-to-end walkthrough (card golden path) and the outbox opener

**Files:**
- Create: `apps/web/e2e/outbox-body-open.ts` (mirrors `openBody` from `src/server/email-outbox/seal.ts` with the same env key, as `e2e/lichess-token-seal.ts` mirrors its reader) — skip if already built in T4
- Modify: `src/server/external-play/__tests__/e2e-seams.test.ts` (or a sibling seam test): a body sealed by the product's `sealBody` opens with the e2e opener
- Modify: `apps/web/e2e/registration-pay-page.spec.ts`

**Interfaces:**
- Produces: `openOutboxBody(sealed: Uint8Array): { html: string; text: string }`, `latestOutboxBody(kind: string, refType: string, refId: string): Promise<{ html: string; text: string }>`, `payLinkFrom(html: string): string` (extracts the one `/r/pay/<token>` href; throws when zero or several).
- Consumes: `fillHostedCheckout` from `e2e/stripe-checkout-kit.ts`; a Connect-ready org from `e2e/rs007-money-kit.ts`.

- [ ] **Step 1: Write the seam test** (`sealBody` → `openOutboxBody` round-trips; tampered byte → throws) and run it; it must fail before the opener exists.
- [ ] **Step 2: Write the walkthrough** `card golden path`: public register (card) → do not pay → organiser opens the registrant panel → Send payment reminder → `latestOutboxBody("payment_reminder","registration",regId)` → `payLinkFrom` → open it; assert competition, division, entrant, fee (equal to the Checkout line item total the hosted page shows), deadline, reference, org name → Pay → `fillHostedCheckout` → back on `/r/pay/<token>`; within the poll either "Payment received — confirming…" then "Paid", or "Paid" directly; Pay form absent; `registrations.status` in (`paid`,`confirmed`); body html has no `checkout.stripe.com`. Second `Back` from Stripe case: press Pay, return via cancel → page with Pay; press Pay again → the same Checkout session id in the URL (reuse).
- [ ] **Step 3: Run** the whole spec file (no `-g`), all width projects it declares, against a prod build per `seazn-local-env` (`E2E_PROD_TARGET`, base `localhost`). Budget the test timeout from the Stripe page waits, not a flat literal.
- [ ] **Step 4: Run the smoke suite** `SMOKE_ONLY=registrationPayPage npm run test:smoke` once more, end to end.
- [ ] **Step 5: Commit** `test(registration): payment page walkthrough from the organiser reminder to Paid`.
- [ ] **Step 6: Whole-branch review** (Opus `reviewer`) answering the four TEST-STRATEGY questions per task (second call, empty input, after withdrawal/void, another sport — for sport: "not applicable, payment is sport-agnostic; one `generic` division is the reason"), then the owner's per-screen sign-off at 320/768/1280 before the PR.

---

## Self-review (done)

- Spec coverage: page + states (T2/T4), token (T1), Pay + reuse + return URLs + confirming (T3/T4), every producer (T5, including the unlisted P5), organiser button + limits + rename (T6), scrub/contract (T4), tests owed incl. e2e/smoke (T4–T7). Non-goals respected: no webhook rule change (T3 only adds a reconcile entry point over the existing core), no bulk remind, no PDF.
- Names checked across tasks: `issuePayLink`, `recordPayToken`, `mintPayToken`, `registrationIdByPayToken`, `payPageDocByToken`, `PAY_PAGE_STATES`, `payFromPayPage`, `reconcileRegistrationByPaySession`, `isPayConfirming`, `registrationPayPath`, `registrationPayRecordingPath`, `REG_PAY_PRIVATE_HEADERS`, `PAYMENT_REMINDER_LIMIT`, `last_reminded_at`, `canRemind`.
- **Owner decisions (2026-11-11):** P5 → the cart's existing status page (option A; pays the whole cart, returns there on success and cancel). `rejected` → the same opaque 404 as withdrawn. **The organiser reminder mail quotes the entry's charged amount** (`amount_cents`, the figure the page and Checkout charge), not the division's live `settings.fee_cents` (`organiser-actions.ts:176`). This is Task 6, extra step: a test where the fee is edited after sign-up, so the mail quotes the old (charged) amount, and that amount ≠ the new fee (differential case).
