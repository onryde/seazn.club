# Sponsor Deals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A club adds a sponsor once (name, logo, link), then gives it a package as a *deal* (paid online, offline, or complimentary) that goes live by the club's chosen rule. From then on the deal decides what the sponsor row shows. The webhook no longer decides it, and no second sponsor row ever appears.

**Architecture:** `sponsor_orders` stays the table, and each row is one deal. It gains the deal's lifecycle, its go-live rule, a snapshot of the package and the scope, and a timestamp for each step. Its money columns stay as they are. A pure, client-safe module (`lib/sponsor-deals.ts`) owns every transition, chip and action rule. ONE server function (`applyDealsToSponsor`) owns every write to a deal-governed sponsor's status, tier, scope and on-stream flag. Every path that moves a deal ends by calling it: the console routes, the Stripe webhook, disputes, refunds and the hourly sweep. Invoices are Seazn's own numbered documents (an HTML page plus a pdfkit PDF), paid through the existing Connect destination-charge Checkout.

**Tech Stack:** Next 16 App Router (read the relevant guide in `node_modules/next/dist/docs/` before any route work), TypeScript 7, postgres.js with Flyway deltas, zod 4, Stripe (Checkout, destination charges), pdfkit, the email outbox, the Cloudflare cron Worker (`apps/cron-worker`), vitest (node env) with fast-check, and Playwright.

**Spec:** `docs/superpowers/specs/2026-11-01-sponsor-deals-design.md`. Read §5 (model), §6 (screens), §8a (rulings) and §10 (open). The mockups are layout only, and the build uses the house theme: `~/seazn-artifacts/2026-11-01_sponsor-deals-mockups_6472cb56/index.html`, served at `http://127.0.0.1:8765/2026-11-01_sponsor-deals-mockups_6472cb56/index.html`.

---

## 0. Before any task runs

- **Execution starts only after R4 PR A (`feat/r4-sponsors`) has merged to main.** Every path here is PR A's tree, checked at `origin/feat/r4-sponsors` @ `2864d57028`. That includes the hub at `/o/:slug/sponsors`, `lib/sponsor-tiers.ts`, `sponsors.on_stream`, `server/sponsors/*` and the report links. Until PR A merges, no task may start: half of the files named below do not exist on main.
- Each PR gets its own worktree off main (`superpowers:using-git-worktrees`). Never check out in the main checkout. Never `git stash`. Rebase, never merge main in.
- **Re-pin every line number on the first read.** The `~Lnnn` cites below are PR A @ `2864d57028`, and PR A will move before it merges. A plan line number is a hypothesis.
- Migration numbers are NEVER hard-coded. Each delta is named `V<n>__<suffix>.sql`, where `<n>` is the next free number above main's max **at merge time** (main's max was V491 on 2026-11-07; PR A holds V483). Tests find a delta by suffix regex only (PR A's pattern: `/^V\d+__sponsor_rotation\.sql$/`). A renumber before merge is then a pure `git mv`.

## 1. Decisions this plan makes

These are the spec's "left to the builder" items (§9), plus the gaps found while planning. Each one is a decision, recorded once. The tasks implement them and never re-decide them.

| # | Decision | Why |
|---|---|---|
| D1 | **Keep the table `sponsor_orders`, with one row per deal.** The money column `status` keeps its meaning (the API exposes it as `payment_status`). | V299/V300 FKs and policies, the dispute recovery's `sponsor_order_id` reversal metadata, the outbox refs `sponsor_order/<id>`, the competition-delete guard and about 15 test files key on the name. A rename buys the user nothing (§9 lets the builder choose). |
| D2 | **Two axes.** A new `deal_status` holds the lifecycle: `draft · awaiting_payment · awaiting_approval · scheduled · live · ended`. Money stays in `status`: `pending · paid · failed · refunded`, plus the new `none` for complimentary. | "Live · awaiting payment" (§5.2) is both at once, so one column cannot hold it. `scheduled` means every condition of the rule is met but the sponsor already has a live deal (§8a queue). The spec's "Paid" chip is derived, not stored. |
| D3 | **At most one live deal per sponsor,** held by a partial unique index (§8a). | A guard in the database, not in a comment. |
| D4 | **Snapshot at creation:** `tier`, `includes_on_stream`, `package_name`, `competition_id` (the deal's scope; null means the whole org), plus the existing `amount_cents` and `currency`. | §5.1: a later package edit never moves a deal. |
| D5 | **`ends_at` is added; `starts_at` is not.** `ends_at`'s producer is the Add deal sheet's optional "Ends on", offered when the scope is the whole org. A competition-scoped deal with no `ends_at` ends when the competition's derived phase is `finished` (§8a). | No screen sets a start date (the mockups have none). The only delayed start is the §8a queue, and `scheduled` carries it. A `starts_at` with no producer would be an inert seam. |
| D6 | **Legacy rows.** The migration rewrites every existing order into an explicit ENDED deal (`ended_reason = 'legacy'`) and leaves its money columns untouched. `applyDealsToSponsor` ignores legacy rows. | §5.1 says keep the dispute and refund history, and §8a says no backfill into deals. Explicit values replace a compatibility branch (the owner's loud-migration rule). |
| D7 | **The one owner is `applyDealsToSponsor(tx, sponsorId, actor)`.** The webhook stops inserting sponsors (§5.3). | Root cause fixed once (TEST-STRATEGY rule 8). |
| D8 | **Visibility, empty case first.** A sponsor with no non-legacy deal: no change (manual control, §8a "1 Ok"). A live deal: the sponsor takes the deal's snapshot, and its status is `active`, or `pending` while the live deal is parked by a dispute. Open deals only: status `inactive` (hidden until live). All deals ended: `inactive`, tier `partner`, scope null, on_stream false (the mockup: "Tier, page and stream switched off"). | §8a visibility ruling. The mockup's "Tier now Partner" after a deal ended. |
| D9 | **What a deal locks (§8a).** While the sponsor has a live deal, a PATCH of `tier`, `competition_id`, `on_stream` or `status` answers 409 `sponsor_locked_by_deal`. While it has an open, non-live deal, a PATCH of `status` answers 409. Name, url and logo are always editable. Once every deal has ended, the sponsor is back under manual control, as a no-deal sponsor is. | The anti-goal "live without the rule met". The all-ended case is flagged to the owner (§11, Q3). |
| D10 | **Invoice mechanism: Seazn's own numbered invoice plus the existing Checkout,** not Stripe Invoicing (§7). | (a) An offline invoice on a community org has no Stripe account to issue it from. Seazn's document is one document and one numbering for both kinds. (b) With destination charges, a Stripe invoice is issued by the PLATFORM account, so it cannot carry a per-club sequence or the club as issuer. (c) Stripe Invoicing adds its own per-paid-invoice fee on top of card fees. (d) The destination charge, application fee, refund and dispute rail already exist and are hardened (`startSponsorCheckout`, `handleSponsorDispute`). Cost: Seazn renders the document. |
| D11 | **Invoice numbers run per org** from a counter table, allocated when an online or offline deal is created, and shown as `SP-0001`. A numbered deal can never be deleted (prune policy fence). | §7: per org, in sequence, never reused. |
| D12 | **The address and bank details for invoices** are new plain-text columns `organizations.sponsor_invoice_address` and `sponsor_invoice_bank_details`, edited on **Settings → Payments** in a "Sponsor invoices" card, on every plan. | §9 leaves the place open. The existing `organizations.payment_instructions` is Markdown written TO REGISTRANTS ("pay cash at the desk"), a different fact that must not print on a formal invoice. No org address column exists today. |
| D13 | **Emails.** Reuse kind `sponsor_invoice` for online and offline invoices (same facts: literal address, not transactional). `sponsor_receipt` and `sponsor_refund` are unchanged. ONE new kind, `sponsor_deal_paid`, goes to the org owner (an account) on an online payment, because it is what tells an "After I approve" club to act. There is no "deal live" email (optional in §9, so cut). There are no "Live · awaiting payment" reminders: the chip plus Resend invoice are the reminder (§9: "keep them minimal"). | Smallest set that serves the approval flow. |
| D14 | **A pay link never dies, and never doubles.** The invoice email links a durable invoice page, and its Pay button mints Checkout on demand. A session is stored on the deal and **reused while it has not expired**, so two payable sessions never coexist. PR 1, which comes before invoice pages exist, applies the same rule to Resend. | Today a Checkout link expires in 24 h. Today's own copy admits "Both payment links stay payable — the sponsor could pay twice" (`sponsors.order.dupConfirm.body`). |
| D15 | **Screens are one DOM and URL-driven.** `?tab=sponsors&sponsor=<id>` opens the sponsor page. On a phone it replaces the list (its own page, with a back link). At ≥md it is a right-hand side sheet over the list. `&deal=<id>` opens the deal page the same way. Add deal is a `Modal`. The phone "⋯" folds the row's own controls. It does not use `CardMenu`, which is link-only by design. | Option B (§6.2), the house "one DOM, branched" rule, and back-button-safe. |
| D16 | **API.** The `/sponsor-orders` routes are replaced by `POST /orgs/{id}/sponsors/{sponsorId}/deals` and `/orgs/{id}/sponsor-deals[/{dealId}[/<action>]]`. It is logged as a breaking change in `app/developers/changelog/page.tsx` and `docs/api-v1-breaking-changes.md` (no client outside the web app uses it yet, which is the repo's stated convention). | The POST body changes meaning (sponsor_id replaces a typed name), so it is breaking either way. |
| D17 | **Plans (§8).** Packages, offline deals, complimentary deals and the approval rule work on every plan. Online needs `sponsors.monetize`, scoped to the deal's competition, plus Connect. **Owner-confirmed 2026-11-07 (§10 Q1, "Ok"):** a tier other than partner, or a competition scope, needs `sponsors.tiers` (today's gate), isolated in Task 3. | Owner-confirmed 2026-11-07. |
| D18 | **Competition delete** answers 409 while any non-legacy deal is scoped to that competition, or while a sponsor scoped to it has any non-legacy deal. | Otherwise the `sponsors.competition_id` cascade deletes a sponsor whose deals RESTRICT the delete, and the user sees a 500 (23503). The spec is silent on this. |
| D19 | **The invoice page lives at `/r/sponsor/invoice/<token>`.** The token is 32 random bytes, and only its hash is stored (PR A's `report-token.ts` pattern, reused by import). It rotates on Resend. | It sits under PR A's `/r/sponsor/` prefix, which the scrubbers and the `/r/<ref>` carve-out already know. Hash-only matches the report links. |
| D20 | **The sweep is an hourly row** on the existing `TRIGGER_CRON`. | An expired deal comes down within the hour, with no new trigger (the Free plan's 5-trigger cap). |
| D21 | **Every deal write is an editor action** (`requireOrgAuth(req, id, "write")`). Viewers read. | Same as packages and refunds today (R19). |
| D22 | **What the Add deal sheet opens at** (rule 19: pin the opening value). Payment opens at `online` when `hasMonetize && chargesEnabled`, else `offline`. Go-live opens at `on_payment`. Picking `complimentary` while go-live is `on_payment` moves go-live to `immediate`. Scope opens at the package's competition when it has one (locked), else the whole org. The billing email opens at this sponsor's most recent deal's `sponsor_email`, else empty. | Mockup notes (screen 3). |

## 2. Premises checked against the tree (PR A @ 2864d57028, main @ 2bd33415f3)

**True:**
- `handleSponsorPaymentSucceeded` inserts a new sponsor row, with name only, from the order (`server/usecases/sponsors.ts` ~L652 on PR A, L617 on main; the spec's "~616" is main).
- `paid_order_id` is the only link back to the order (`listSponsorRows` ~L162).
- The "invoice" is a `sponsor_invoice` outbox email that carries a Checkout URL.
- There is no offline payment, no mark-paid and no approval step.
- The hub tabs are `overview, sponsors, on_stream, packages` (`lib/sponsors-hub.ts` `SPONSORS_TABS`). The Packages tab is labelled "Packages and orders" (`sponsors.hub.tab.packages`).
- `ensureOrgStreamSettings(tx, orgId, userId | null)` exists, and a webhook may call it with null.

**False or incomplete. Plan for the tree, not the spec:**
1. §8 "Sponsors, packages … community: yes". Today a community org **cannot create a package at all**: `createSponsorPackage` calls `requireFeature(…, "sponsors.monetize")`, and smoke pins `"sp free packages gated (402)"`. This programme reverses that row, loudly (Task 4).
2. §8 / §10 "tiers stay governed by `sponsors.tiers` as today". The same gate (`assertTierAllowed`) also gates **competition scoping**. The provisional default therefore makes community deals org-wide as well as Partner-only. The mockup's community example ("Silver Season for Season 2026/27") is unreachable under it. This goes to the owner with §10 (Q1).
3. §5.2 "Dispute opened → hidden … today's park". Today only a FORMAL dispute (or `funds_withdrawn` after an inquiry) parks the placement; an inquiry leaves it live (owner, 2026-10-26). The plan keeps today's rule.
4. §7 "bank details the club enters once in settings". No such setting exists, and there is no org address column. The only offline text is the registrant-facing Markdown `payment_instructions` (D12).
5. §5.1 `starts_at` / `ends_at`. The mockups have no date fields, so neither has a producer as drawn (D5).
6. The mockups' "Competition or season". There are no seasons: scope is the org or one competition (§8a). Their includes list (website board, slideshow) is removed per §8a.
7. §6.1 "⋯ menu". The repo's `CardMenu` is link-only by design ("mutating actions belong on the page they navigate to"), so the plan folds the row's own controls instead (D15).
8. `sponsors.competition_id` is `ON DELETE CASCADE` (V283). A deal-scoped sponsor would be deleted with its competition. The spec is silent; D18 covers it.
9. Today's flow already carries a double-payment risk (two unexpired sessions for one sponsor), and the Checkout link dies after 24 h (D14).
10. The help pages `content/help/sharing/sponsors.md` and `sponsors-hub.md` describe "Packages and orders" and "start an order with the sponsor's name and email". They are owed updates (Tasks 18 and 24).

## 3. Global Constraints

Every task's requirements include this section.

- **Dependency.** Nothing starts before R4 PR A has merged (§0).
- **i18n, 4 locales.** Every new or changed user-facing string goes into `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json` (namespaces `sponsors.deal.*`, `sponsors.dealSheet.*`, `sponsors.invoice.*`, `sponsors.pkg.*`). Then run `npm run i18n:gen-keys` at the root (it regenerates `apps/web/src/lib/i18n-keys.ts`, which is never hand-edited) and `npm run i18n:check` at the root. Never hardcode English, including in the invoice PDF and email bodies. A server refusal shown to a user is mapped to a key by STATUS, never by the server's sentence (`components/org-payment-instructions.tsx` pattern). Help pages (`apps/web/content/help/**`) are English-only.
- **Mobile-first, 320 / 768 / 1280.** No horizontal page scroll at any width. Wide content scrolls inside its own `overflow-x-auto`. One DOM, branched (`max-md:*`, `md:hidden`); never a second phone tree. `truncate` needs `min-w-0` on the whole ancestor chain. Test with a realistic name of 43 or more characters ("Harbourside Building Supplies and Timber Co"). A scrolling rail needs `tabindex="0"`, a role and an accessible name. Compare control SETS across widths, not box sizes. The seven-width `mobile.spec.ts` matrix is the backstop. Screenshots and per-screen verdicts go to the local sign-off server at :8765, never to artifacts. Evidence PNGs are never committed.
- **frontend-design.** Every task that changes markup or styles invokes the `frontend-design` skill (Skill tool) BEFORE touching markup. Match the existing design system: tokens, the `status-chip.tsx` chip vocabulary, the hub's `HubPanel` and card styles, the spacing scale, and no one-off colours or classes. The task report names, for each change, the pattern or token it matched. The mockups are layout only.
- **Loud migration.** Each delta is `db/migration/deltas/V<n>__<suffix>.sql`, with `<n>` the next free number above main's max at merge. Its header must NOT self-name a version (`lib/__tests__/migration-header-truth.test.ts`: "if you name yourself, be right"), so it opens `-- sponsor_deals — …`. The header states what changes, what each legacy row becomes, and why. The migration `raise notice`s its row counts. The PR body carries a "Data changes" section, and the release note repeats it. There is no compatibility branch for old rows (D6).
- **Four test types per task** (RULES.md): unit, e2e (Playwright), smoke (`scripts/smoke/`) and regression. Each is stated in the task. A backend task still owes e2e: trace it forward to the user-facing flow.
- **TEST-STRATEGY.md is binding.**
  - **The four transitions.** Test the second call, the empty input, and the state after a void. Here the voids are a refund, End now and a lost dispute.
  - **"Another sport" is NOT applicable.** Sponsors are sport-agnostic: no sport key is read anywhere in this programme. Its substitute is **another plan**: community, Pro, and an Event Pass on one competition.
  - **Anti-vacuity.** Every sweep and property returns how many items it checked, and zero checked is a failure.
  - **Expected values come from declarations or the spec,** never from the code under test: `SPONSOR_TIERS`, the spec §5.2 table typed into the test, and the D-table literals.
  - **Assumptions are guards.**
  - **Mutation.** Mutate each new guard once, mutate the MONEY path per surface, and report the killer list (a test that dies under every mutant fakes kills). Restore from a `cp` backup, never `git checkout <file>`.
  - **Model-based sequences.** Use fast-check for the ordered deal actions (Task 11).
- **Scoped local verification only** (owner 2026-09-28 and 2026-11-07). Locally, run ONLY the exact test files a task adds or changes, plus a scoped tsc. Never run the full vitest suite, a whole-project tsc, eslint, or e2e. No local web server, ever (it reaches live PostHog). CI covers the rest. The recipes:
  - **VERIFY:** `cd <abs worktree>/apps/web && npx vitest run --reporter=json --outputFile=<scratchpad>/t<N>.json <exact paths>; echo EXIT=$?`, then `jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests,files:[.testResults[].name]}' <scratchpad>/t<N>.json`. It passes only with EXIT=0, failed 0, every listed file present under the worktree, and `total` equal to the count you pinned. Never trust rtk's summary. DB suites need `DATABASE_URL` for a migrated local test DB (the `seazn-local-env` skill). Local DBs lag main's migrations, so apply this PR's delta first.
  - **TSC:** write the throwaway `apps/web/tsconfig.changed.json` (extends `./tsconfig.json`, `noEmit`, `"types":["node","next"]`, `files` = the changed `.ts`/`.tsx`). Run `node ../../node_modules/typescript-native/bin/tsc -p tsconfig.changed.json; echo EXIT=$?`, then delete the file. Never commit it.
  - **OPENAPI:** before a commit that touches a route or `server/api-v1/*`, run `npm run openapi:gen && git status --porcelain`. It must show nothing new beyond the regenerated `openapi/v1.json`, which is committed.
  - **E2E:** `gh workflow run e2e.yml --ref <branch>` (read its `workflow_dispatch` inputs first; it is the only e2e signal before merge). Then hand back. Never poll CI.
  - **SMOKE:** runs in CI on the PR. Never run it locally against a local server.
- **Repo-wide scans a scoped run misses.** Add each to a task's VERIFY when the task trips it:
  - `lib/__tests__/pass-scoping-guard.test.ts` (DB). Every `requireFeature` or `hasFeature` call passes the competition when one is in scope.
  - `lib/__tests__/status-set-sweep.test.ts`, when a status literal set is touched.
  - `lib/__tests__/retired-plan-copy.test.ts` and the dictionary copy-truth test, for new copy.
  - `scrub-path-secrets`, `proxy-matcher` and `routes` tests, for a new `[token]` route.
  - `server/email-outbox/__tests__/{outbox-schema,outbox-kind-sweep,enqueue-once,_kind-senders}`, for a new outbox kind.
  - `lib/__tests__/e2e-ci-wiring.test.ts`, for a new spec.
  - `apps/cron-worker/test/schedule.test.ts`, for a new job.
- **Money.** Stripe is called OUTSIDE any SQL transaction, always with an idempotency key. Billing claims are verified against the Stripe SANDBOX (`sk_test_`), never assumed.
- **Commits.** Use conventional commits, one red→green step each, ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## 4. Review Focus

These are the five inputs the spec implies but no screen draws. Each line names its owning test.

1. **A payment lands on a deal the club already ended,** or arrives after the sponsor was hidden. Expected: the money is recorded (`payment_status = paid`), the deal stays `ended`, the sponsor stays hidden, and the deal offers Refund. *Owner: Task 8, `late payment on an ended deal records money and changes nothing shown`.*
2. **Two editors press Approve, or Mark as paid, at the same moment** (or one double-taps). Expected: exactly one transition. The second call answers 409 (`deal_not_awaiting_approval` / `deal_already_paid`). One `live_at` is written and one public bust fires. *Owner: Task 6, `concurrent approve: one transition, one 409`.*
3. **Deleting a competition** that a deal is scoped to, or that a deal-governed sponsor sits on. Expected: 409 with the archive hint, never a 500. *Owner: Task 10.*
4. **A Pro org downgrades to community while a Gold deal is live.** Expected: the deal stays live, and the public page shows the sponsor un-tiered (`resolveSponsors`' existing collapse). A NEW Gold deal answers 402. *Owner: Task 5, `downgrade keeps a live tiered deal live, public strip un-tiered`.*
5. **Adding a deal to a sponsor that already has a live one.** Expected: the new deal is `scheduled`, never a second live. It goes live the moment the current one ends by ANY exit (End now, expiry, competition finished, refund, lost dispute). "End the current deal now" swaps the two in one transaction. *Owner: Task 5 (promotion) and Task 6 (`end_current`).*

## 5. The PR split, and why each PR is safe alone

| PR | Branch | Tasks | Merges safely because |
|---|---|---|---|
| **PR 1: Deals core** (data model, domain, webhook, API, sweep) | `feat/sponsor-deals-core` | 1–12 (12 tasks) | Today's screens keep working. The Packages tab's Send invoice form gains a sponsor picker (Task 12) instead of a typed name, so online selling never stops. The webhook no longer duplicates sponsors. Offline, complimentary and approval deals are reachable through the API only until PR 2; the e2e drives them over HTTP (Inert seams, below). |
| **PR 2: Screens** (option B) | `feat/sponsor-deals-screens` | 13–19 (7 tasks) | It is UI only, over PR 1's API. Online invoices are still PR 1's Checkout-link email. It removes the transitional picker. |
| **PR 3: Invoices** | `feat/sponsor-deals-invoices` | 20–24 (5 tasks) | It adds numbering, invoice details, the document, pay-on-demand and the emails. Before it, a deal simply has no invoice number. |

Why this cut, and not "UI first": the webhook change and the data model must land together. A webhook that stops inserting sponsors, without a deal that carries `sponsor_id`, would take money and show nothing. Invoices are last because they are additive: they only change what the email links to, plus one new setting.

## 6. Inert seams, named

AGENTS.md class 1. Each seam is proven by driving its REAL producer and its REAL consumer. A fixture on both ends proves only the fixture.

| Seam | Producer → consumer | Proven by |
|---|---|---|
| S1 Payment makes the sponsor live | `runEvent(payment_intent.succeeded)` (the billing-events dispatcher, not the handler) → `resolveSponsors()` (public strip) and `resolveSponsors(…, { onStream: true })` (stream card source) | Task 8 `deals-webhook-seam.test.ts`. It also asserts the org's `sponsors` row count is unchanged (anti-goal 1). |
| S2 Offline mark-paid | `POST /sponsor-deals/{id}/mark-paid` → public page HTML | Task 6 e2e (`sponsor-deals-api.spec.ts`) |
| S3 The sweep ends a deal | `POST /api/cron/sponsor-deals` with the cron secret → `resolveSponsors()` | Task 9 |
| S4 The sheet creates a deal | the browser Add deal sheet → API → deal row → public page | Task 16 / 19 e2e |
| S5 The invoice is paid | invoice email → `/r/sponsor/invoice/<token>` → Pay → Stripe sandbox → webhook → live | Task 24 walkthrough |
| S6 The end date | the sheet's "Ends on" → `ends_at` → the sweep | Task 16 e2e asserts the saved `ends_at`; Task 9 sweeps it with an injected `now`. |

## 7. File map

**Create**
- `db/migration/deltas/V<n>__sponsor_deals.sql`: PR 1 schema (Task 1).
- `db/migration/deltas/V<n>__sponsor_invoices.sql`: PR 3 schema (Task 20).
- `apps/web/src/lib/sponsor-deals.ts`: the pure domain (vocabulary, transitions, actions, chips, labels, timeline). Client-safe; imports only `lib/sponsor-tiers.ts`.
- `apps/web/src/lib/sponsor-deal-policy.ts`: **PROVISIONAL.** The placement predicate (Task 3).
- `apps/web/src/server/sponsors/deal-gates.ts`: **PROVISIONAL.** The server gate over the predicate (Task 3).
- `apps/web/src/server/sponsors/deal-apply.ts`: `applyDealsToSponsor`, plus `bustPublicSponsors` moved here from `usecases/sponsors.ts`.
- `apps/web/src/server/usecases/sponsor-deals.ts`: create, send/resend, mark paid, approve, end, refund, list/get, sweep.
- `apps/web/src/server/sponsors/invoice-number.ts` and `invoice-doc.ts` (the model) and `invoice-pdf.ts` (pdfkit): PR 3.
- API routes under `apps/web/src/app/api/v1/orgs/[id]/`:
  - `sponsors/[sponsorId]/deals/route.ts`
  - `sponsor-deals/route.ts`
  - `sponsor-deals/[dealId]/route.ts`
  - `sponsor-deals/[dealId]/{send-invoice,mark-paid,approve,end,refund}/route.ts`
  - `sponsor-deals/[dealId]/evidence/route.ts`
  - `sponsor-deals/[dealId]/invoice.pdf/route.ts` (PR 3)
- `apps/web/src/app/api/cron/sponsor-deals/route.ts`.
- `apps/web/src/app/(public)/r/sponsor/invoice/[token]/{page.tsx,not-found.tsx}`, plus `pdf/route.ts` and `pay/route.ts` (PR 3).
- Components under `apps/web/src/components/sponsors/`: `deal-chip.tsx`, `sponsor-list.tsx`, `sponsor-row-more.tsx`, `sponsor-sheet.tsx`, `add-deal-sheet.tsx`, `deal-page.tsx`, `package-list.tsx`, `invoice-view.tsx` (PR 3).
- `apps/web/src/components/org-sponsor-invoice-details.tsx` (PR 3).
- Tests are named per task. New e2e specs: `apps/web/e2e/sponsor-deals-api.spec.ts` (PR 1), `apps/web/e2e/sponsor-deals.spec.ts` (PR 2), `apps/web/e2e/walkthrough/sponsor-invoices.spec.ts` (PR 3).
- Smoke: `scripts/smoke/suites/sponsorDeals.ts`, registered in `scripts/smoke/main.ts` after `sponsors`.

**Modify**
- `apps/web/src/server/usecases/sponsors.ts`: webhook handlers, disputes, refund, the patch lock, the delete guard, list fields; `startSponsorCheckout` is removed.
- `apps/web/src/server/usecases/competitions.ts` (the delete guard, ~L905).
- `apps/web/src/app/api/v1/orgs/[id]/sponsor-packages/route.ts`.
- `apps/web/src/server/api-v1/{openapi.ts,schemas.ts,key-scopes.ts}`, and `openapi/v1.json` (generated).
- `apps/web/src/app/o/[orgSlug]/sponsors/page.tsx` and `_components/hub-chrome.tsx`; `apps/web/src/lib/sponsors-hub.ts`.
- `apps/web/src/components/{org-sponsors.tsx,sponsor-packages.tsx}`, `components/sponsors/on-stream-tab.tsx`, `components/modal.tsx` (a `placement` prop).
- `apps/web/src/lib/email.ts` (`sponsorInvoiceEmail`), `apps/web/src/server/email-outbox/{constants.ts,hooks.ts}`.
- `apps/web/src/app/o/[orgSlug]/settings/connect/page.tsx`, `apps/web/src/app/api/orgs/[id]/route.ts`.
- `apps/web/src/lib/scrub-score-url.ts`.
- `apps/cron-worker/src/schedule.ts` and `apps/cron-worker/test/schedule.test.ts`.
- `apps/web/src/app/developers/changelog/page.tsx`, `docs/api-v1-breaking-changes.md`.
- `apps/web/content/help/sharing/{sponsors.md,sponsors-hub.md}`.
- Fixtures and specs that seed orders or pin the old flow (listed per task).

**Delete**
- `apps/web/src/app/api/v1/orgs/[id]/sponsor-orders/**`.

---

# PR 1: Deals core (`feat/sponsor-deals-core`)

### Task 1: The deal schema (loud migration)

**Files:**
- Create: `db/migration/deltas/V<n>__sponsor_deals.sql`
- Test: `apps/web/src/server/sponsors/__tests__/deals-migration.test.ts`

**Interfaces:**
- Produces these columns on `sponsor_orders`:
  - lifecycle and rule: `deal_status text not null`, `payment_method text not null`, `go_live text not null`;
  - snapshot: `tier text not null`, `includes_on_stream boolean not null`, `package_name text not null`, `competition_id uuid null → competitions on delete restrict`, `ends_at timestamptz null`;
  - step stamps and actors: `created_by uuid null → users on delete set null`, `invoice_sent_at`, `marked_paid_by uuid null → users`, `approved_at`, `approved_by uuid null → users`, `live_at`, `ended_at`, `ended_reason text null`, `parked_at`;
  - Checkout: `checkout_session_id text null`, `checkout_url text null`, `checkout_expires_at timestamptz null`, `invoice_send_count int not null default 0`.
- Produces `sponsor_packages.includes_on_stream boolean not null default false`.
- Changes `sponsor_orders.status` CHECK to `pending|paid|failed|refunded|none`, makes `sponsor_email` nullable, and moves the `sponsor_id` FK to `on delete restrict`.
- Named constraints (the tests assert these names):
  - `sponsor_orders_deal_status_check`, `sponsor_orders_payment_method_check`, `sponsor_orders_go_live_check`, `sponsor_orders_tier_check`, `sponsor_orders_ended_reason_check`;
  - `sponsor_orders_comp_needs_no_payment` — `(go_live <> 'on_payment' or payment_method <> 'complimentary')`;
  - `sponsor_orders_none_iff_complimentary` — `((payment_method = 'complimentary') = (status = 'none'))`;
  - `sponsor_orders_online_has_email` — `(payment_method <> 'online' or sponsor_email is not null)`;
  - `sponsor_orders_sponsor_or_legacy` — `(sponsor_id is not null or ended_reason = 'legacy')`;
  - `sponsor_orders_ended_shape` — `((deal_status = 'ended') = (ended_at is not null and ended_reason is not null))`;
  - unique index `sponsor_orders_one_live_per_sponsor on (sponsor_id) where deal_status = 'live'`;
  - indexes on `(sponsor_id)` and `(competition_id)`.

**Acceptance:**
- Legacy rows: every pre-existing row, inside `-- legacy:begin` / `-- legacy:end` markers, becomes `deal_status='ended', ended_reason='legacy', ended_at=coalesce(paid_at, created_at), payment_method='online', go_live='on_payment'`. Its `tier`, `package_name` and `competition_id` are copied from its package, `includes_on_stream=false`, and `status` and every money column are untouched. This all happens BEFORE the NOT NULLs. The new deal columns have **no defaults**, so a seed that forgets them fails loudly (23502) instead of silently becoming a draft.
- The header states D1, D2 and D6 in prose, and says that `sponsor_packages.competition_id IS NULL` now means "any competition (the deal picks)" where it used to mean "org-wide". That is a superset, with no rows moved.
- The migration `raise notice`s the legacy row count.

**Tests:**
- Unit (DB): `deals-migration.test.ts`. It finds the delta by `/^V\d+__sponsor_deals\.sql$/` and fails if the count of matches ≠ 1.
  - For EACH named constraint, an accepted row and a refused row sit in the same `it`. The refusal asserts the constraint NAME, not just the SQLSTATE.
  - The tier CHECK names exactly `SPONSOR_TIERS` (read from `lib/sponsor-tiers.ts`).
  - The value sets equal the spec literals typed in the test (`["draft","awaiting_payment","awaiting_approval","scheduled","live","ended"]`, `["online","offline","complimentary"]`, `["on_payment","immediate","on_approval"]`, `["refunded","dispute_lost","ended_now","expired","competition_finished","legacy"]`).
  - A second live deal for one sponsor is refused by `sponsor_orders_one_live_per_sponsor`, and the twin (one live plus one ended) is accepted.
  - Deleting a sponsor that has a deal is refused (23503), and deleting one with no deal is accepted.
  - **Legacy block:** inside `sql.begin` with `set local lock_timeout = '5s'`, which is rolled back: drop the NOT NULLs, insert a legacy-shaped paid, disputed row with null `sponsor_id`, execute the text between the markers (read from the file), and assert the D6 values and that `status`, `payment_intent_id`, `disputed_at` and `dispute_id` are byte-equal to before. Assert the run touched exactly 1 row (not 0).
- E2E: none new. Task 6's API spec runs on the migrated CI database, and this schema is its precondition.
- Smoke: none new (Task 6 adds the rows).
- Regression: `lib/__tests__/migration-header-truth.test.ts` stays green: the header does not self-name a version.

**Steps:**
- [ ] 1. Write `deals-migration.test.ts` as above. Run VERIFY on it. Expected: FAIL with "the sponsor-deals delta is missing".
- [ ] 2. Write the delta (use the `supabase-postgres-best-practices` skill for the DDL). Apply it to the local test DB.
- [ ] 3. Run VERIFY on `deals-migration.test.ts` and `lib/__tests__/migration-header-truth.test.ts`. Expected: failed 0, both files listed.
- [ ] 4. Mutate: drop the partial unique index, then remove `ended_reason = 'legacy'` from `sponsor_orders_sponsor_or_legacy`. Each must red its named test. Restore from the `cp` backup.
- [ ] 5. Commit `feat(db): sponsor deals schema — deal lifecycle, rule, snapshot and step stamps on sponsor_orders`.

### Task 2: The pure deal domain

**Files:**
- Create: `apps/web/src/lib/sponsor-deals.ts`
- Test: `apps/web/src/lib/__tests__/sponsor-deals.test.ts`

**Interfaces (Produces):**
```ts
export const DEAL_STATUSES = ["draft","awaiting_payment","awaiting_approval","scheduled","live","ended"] as const;
export const PAYMENT_METHODS = ["online","offline","complimentary"] as const;
export const GO_LIVE_RULES = ["on_payment","immediate","on_approval"] as const;
export const PAYMENT_STATUSES = ["pending","paid","failed","refunded","none"] as const;
export const END_REASONS = ["refunded","dispute_lost","ended_now","expired","competition_finished","legacy"] as const;
export const DEAL_ACTIONS = ["send_invoice","resend_invoice","mark_paid","approve","refund","end_now"] as const;
export type DealStatus …; PaymentMethod …; GoLiveRule …; PaymentStatus …; EndReason …; DealAction …;
export interface SponsorDeal { id; sponsor_id: string | null; package_id; deal_status; payment_status; payment_method; go_live;
  package_name; tier: SponsorTier; includes_on_stream; competition_id: string | null; amount_cents; currency; sponsor_name;
  sponsor_email: string | null; ends_at; created_at; created_by; invoice_sent_at; paid_at; marked_paid_by; approved_at;
  approved_by; live_at; ended_at; ended_reason: EndReason | null; parked_at; disputed_at; dispute_id;
  invoice_number: number | null /* always null until PR 3 */ }
export class DealRuleError extends Error { constructor(readonly code: "on_payment_needs_payment" | "illegal_transition", …) }
export function goLiveRulesFor(m: PaymentMethod): readonly GoLiveRule[];           // complimentary → ["immediate","on_approval"]
export function initialPaymentStatus(m: PaymentMethod): PaymentStatus;             // complimentary → "none", else "pending"
export function initialStatus(m: PaymentMethod, r: GoLiveRule, otherLive: boolean): DealStatus;
export function statusAfterInvoiceSent(d: Pick<SponsorDeal,"deal_status">): DealStatus;
export function statusAfterPaid(d: Pick<SponsorDeal,"deal_status"|"go_live">, otherLive: boolean): DealStatus;
export function statusAfterApproved(d: Pick<SponsorDeal,"deal_status">, otherLive: boolean): DealStatus;
export function allowedActions(d: SponsorDeal): DealAction[];                      // in DEAL_ACTIONS order
export function pickRowDeal(deals: readonly SponsorDeal[]): SponsorDeal | null;    // legacy rows excluded
export type RowAction = "add_deal" | "open_deal" | "send_invoice" | "resend_invoice" | "mark_paid" | "approve";
export function rowNextAction(d: SponsorDeal | null): RowAction | null;
export type DealChip = { kind: "draft"|"awaiting_payment"|"paid"|"scheduled"|"awaiting_approval"|"live"|"ended"; awaitingPayment: boolean; onHold: boolean };
export function dealChip(d: SponsorDeal): DealChip;
export function primaryLabel(m: PaymentMethod, r: GoLiveRule, otherLive: boolean): "send_invoice" | "save_deal" | "save_and_go_live";
```

**Acceptance.** These rules are the spec §5.2 table and the mockups, typed into the test; they are never read from the module.
- `initialStatus`:
  - online with `on_payment` or `on_approval` → `draft`;
  - offline with `on_payment` or `on_approval` → `awaiting_payment`;
  - complimentary with `on_approval` → `awaiting_approval`;
  - any method with `immediate` → `live`, or `scheduled` when `otherLive`;
  - complimentary with `on_payment` → throws `on_payment_needs_payment`.
- `statusAfterPaid`:
  - `awaiting_payment` with `on_payment` → `live` or `scheduled`;
  - `awaiting_payment` with `on_approval` → `awaiting_approval`;
  - `live`, `scheduled` and `ended` → unchanged;
  - anything else → `illegal_transition`.
- `allowedActions`:
  - draft → `send_invoice`, `end_now`;
  - awaiting_payment online → `resend_invoice`, `mark_paid`, `end_now`;
  - awaiting_payment offline → `mark_paid`, `end_now`;
  - live or scheduled with payment pending → add `resend_invoice` (online) and `mark_paid`;
  - paid and not disputed → `refund` in every status, including ended, unless `ended_reason` is `refunded` or `dispute_lost`;
  - ended → nothing else;
  - complimentary → never `mark_paid`, `refund` or `*_invoice`.
- `pickRowDeal`: live > awaiting_approval > awaiting_payment > draft > scheduled > latest ended (by `ended_at`). An empty list, or only legacy deals, → `null`.
- `rowNextAction`:
  - `null` or ended → `add_deal`;
  - draft or scheduled → `open_deal`;
  - payment pending (any status) → `resend_invoice` (online) or `mark_paid` (offline);
  - awaiting_approval → `approve`;
  - live, paid or `none` → `null`.
- `dealChip`: a scheduled deal that is paid shows `paid`; one with payment `none` or pending shows `scheduled`; live with payment pending sets `awaitingPayment`; live with `parked_at` sets `onHold`.
- `primaryLabel`: online → `send_invoice`; offline or complimentary with `immediate` and not `otherLive` → `save_and_go_live`; else `save_deal`.

**Tests:**
- Unit: `sponsor-deals.test.ts`.
  - **Empty case first:** `pickRowDeal([])` is null, `rowNextAction(null)` is `"add_deal"`, and `allowedActions` of an ended, refunded deal is `[]`.
  - Every combo of `PAYMENT_METHODS × GO_LIVE_RULES × otherLive` (18 cases): assert the spec path. The test counts the cases it checked and fails unless it is 18.
  - A path walk per allowed combo (8 combos × 2) applies create → send → paid → approve in the order the rule allows, and asserts the spec path `["draft","awaiting_payment","awaiting_approval","live"]` etc.
  - `allowedActions` is enumerated over `DEAL_STATUSES × PAYMENT_STATUSES × PAYMENT_METHODS`, filtered to states reachable by the walk. It asserts the table, and the reachable count is reported and must be > 0.
  - The ordering differential for `pickRowDeal`: [ended newer, live older] → live.
- E2E, smoke: none (pure; exercised by Tasks 6, 16 and 19).
- Regression: none pre-existing.

**Steps:**
- [ ] 1. Write the tests. Run VERIFY. Expected: FAIL, "Cannot find module '@/lib/sponsor-deals'".
- [ ] 2. Implement the module. It may import only `lib/sponsor-tiers.ts`, because it must stay client-safe.
- [ ] 3. Run VERIFY. Expected: failed 0. Run TSC.
- [ ] 4. Mutate:
  - `initialStatus` online+immediate returns `draft`. Killer: the combo sweep.
  - `statusAfterPaid` skips approval. Killer: the on_approval path walk.
  - Drop the `parked_at` → `onHold` rule. Killer: the chip test.
  - Restore after each.
- [ ] 5. Commit `feat(sponsors): the deal domain — statuses, transitions, actions and chips as one pure module`.

### Task 3: PROVISIONAL, awaiting owner (§10): the placement gate for packages and deals

> **Provisional, awaiting the owner.** This is the controller's default: community deals are Partner-only, and tiers stay gated by `sponsors.tiers` as today. Today's gate ALSO gates competition scoping, so community deals are org-wide too (§2 premise 2). Flipping the answer later changes `placementNeedsTiers` and its test, and nothing else in this programme. If the owner answers "yes, community tiers", the public strip's `tiered` flag (`resolveSponsors` callers) must also decide how a community tier SHOWS. That is a rendering question for R4 and the same owner answer, so it is called out in §11 (Q1).

**Files:**
- Create: `apps/web/src/lib/sponsor-deal-policy.ts`, `apps/web/src/server/sponsors/deal-gates.ts`
- Test: `apps/web/src/lib/__tests__/sponsor-deal-policy.test.ts`, `apps/web/src/server/sponsors/__tests__/deal-gates.test.ts`

**Interfaces (Produces):**
```ts
// lib/sponsor-deal-policy.ts (client-safe; the ONE place the §10 answer lives)
export function placementNeedsTiers(tier: SponsorTier, competitionId: string | null): boolean; // tier !== "partner" || competitionId !== null
// server/sponsors/deal-gates.ts
export async function assertPlacementAllowed(orgId: string, tier: SponsorTier, competitionId: string | null): Promise<void>;
//   placementNeedsTiers → requireFeature(orgId, "sponsors.tiers", competitionId ?? undefined); else no-op
export async function assertOnlineAllowed(orgId: string, competitionId: string | null): Promise<void>;
//   requireFeature(orgId, "sponsors.monetize", competitionId ?? undefined) — NOT provisional (§8)
```

**Tests:**
- Unit: `placementNeedsTiers` over `SPONSOR_TIERS × {null, uuid}`. That is 8 cases, counted. Only `("partner", null)` answers false.
- Unit (DB): `deal-gates.test.ts`.
  - Community: partner org-wide passes; gold org-wide → 402; partner on a competition → 402.
  - Pro: all pass.
  - Event Pass on competition C: gold on C passes; gold org-wide → 402; gold on another competition → 402.
  - `assertOnlineAllowed` on community → 402; on an Event Pass for C → passes; on C' → 402.
- E2E and smoke: carried by Tasks 4 and 6 (the gate shows only through package create and deal create).
- Regression: `lib/__tests__/pass-scoping-guard.test.ts` (DB) stays green: both calls pass the competition.

**Steps:**
- [ ] 1. Write both tests. Run VERIFY. Expected: FAIL, module missing.
- [ ] 2. Implement.
- [ ] 3. Run VERIFY on both tests plus `pass-scoping-guard.test.ts`. Expected: failed 0. Run TSC.
- [ ] 4. Mutate: drop `|| competitionId !== null`. Killer: the community "partner on a competition → 402" case. Restore.
- [ ] 5. Commit `feat(sponsors): placement gate for packages and deals (provisional: community deals partner-only)`.

### Task 4: Packages on every plan, with "On stream" included

**Files:**
- Modify: `apps/web/src/server/usecases/sponsors.ts` (`CreateSponsorPackageInput`, `createSponsorPackage` ~L432, `listSponsorPackages`, `SponsorPackageRow`, `PKG_COLS`)
- Modify: `apps/web/src/server/api-v1/{schemas.ts,openapi.ts}`, `openapi/v1.json`
- Test: `apps/web/src/server/usecases/__tests__/sponsor-packages-plans.test.ts` (new); modify `scripts/smoke/suites/sponsors.ts`

**Interfaces:**
- Consumes `assertPlacementAllowed` (Task 3).
- Produces `SponsorPackageRow`, which gains `includes_on_stream: boolean` and `used_by: number`. `used_by` is the count of DISTINCT `sponsor_id`s over non-ended, non-legacy deals on this package. `CreateSponsorPackageInput` gains `includes_on_stream: z.boolean().default(false)`.

**Acceptance:**
- `createSponsorPackage` no longer calls `requireFeature("sponsors.monetize")`. It calls `assertPlacementAllowed(orgId, tier, competition_id)`.
- The OpenAPI summary loses "(Pro `sponsors.monetize`)", and its errors stay `[402]`.

**Tests:**
- Unit (DB): `sponsor-packages-plans.test.ts`.
  - **Empty case first:** a new package has `used_by` 0.
  - Community: a partner package for any competition → created with `includes_on_stream` false by default, and true when sent. A gold package → 402.
  - Pro: gold → created.
  - `used_by` counts 2 for two sponsors with open deals on it, and 1 after one of them ends. This uses Task 5's helpers once they exist; until then the deals are seeded through SQL with every deal column explicit.
- E2E: Task 6's API spec has `community creates a partner package (201) and is refused a gold one (402)`.
- Smoke, in `scripts/smoke/suites/sponsors.ts`: the row `"sp free packages gated (402)"` is REPLACED by `"sp free creates a partner package (201)"` and `"sp free gold package gated (402)"`. The PR body names this as a deliberate flip (§2 premise 1).
- Regression: `server/usecases/__tests__/sponsor-checkout.test.ts`'s package-create cases keep passing on Pro.

**Steps:**
- [ ] 1. Write the tests. Run VERIFY. Expected: FAIL (community partner → 402 today).
- [ ] 2. Implement. Run OPENAPI.
- [ ] 3. Run VERIFY on the new test and `sponsor-checkout.test.ts`. Run TSC.
- [ ] 4. Mutate: restore the monetize `requireFeature`. Killer: the community partner case. Restore.
- [ ] 5. Commit `feat(sponsors): packages on every plan; a package can include On stream`.

### Task 5: `applyDealsToSponsor`, the one owner, plus the sponsor lock and the delete guard

**Files:**
- Create: `apps/web/src/server/sponsors/deal-apply.ts`
- Modify: `apps/web/src/server/usecases/sponsors.ts`:
  - `patchSponsor` ~L211 gains the lock (D9);
  - `deleteSponsor` ~L277 gains the guard;
  - `listSponsorRows` ~L162 gains the deal summary;
  - `bustPublicSponsors` moves to `deal-apply.ts` and is re-imported.
- Test: `apps/web/src/server/sponsors/__tests__/deal-apply.test.ts`, `apps/web/src/server/usecases/__tests__/sponsor-lock.test.ts`

**Interfaces:**
```ts
export type ApplyOutcome = "no_deals" | "live" | "parked" | "hidden_open" | "ended_all";
export async function applyDealsToSponsor(tx: Tx, sponsorId: string, actorUserId: string | null, now?: Date):
  Promise<{ outcome: ApplyOutcome; promotedDealId: string | null }>;
export function bustPublicSponsors(orgId: string): void; // moved, unchanged
// SponsorRow gains:
//   deal: SponsorDeal | null  (pickRowDeal of its non-legacy deals)
//   locked_by_deal: boolean   (a live deal exists)
//   has_open_deal: boolean
//   last_billing_email: string | null
```

**Algorithm** (D8; the order matters):
1. Lock the sponsor row (`for update`), then its non-legacy deals (`for update`, ordered `created_at, id`).
2. With no deals, return `no_deals` and write nothing.
3. If no deal is live, promote the earliest `scheduled` one: set it `live` with `live_at = now`.
4. With a live deal: write `status = parked_at ? 'pending' : 'active'`, plus `tier`, `competition_id` and `on_stream` from its snapshot. If `on_stream`, call `ensureOrgStreamSettings(tx, orgId, actorUserId)`.
5. Else, with any open deal: write `status = 'inactive'` only.
6. Else: write `status='inactive', tier='partner', competition_id=null, on_stream=false`.

The caller fires `bustPublicSponsors` after commit.

**Lock** (`patchSponsor`). In the same transaction, under the existing `for update`:
- a live deal plus any of `tier | competition_id | on_stream | status` in the patch → `HttpError(409, "sponsor_locked_by_deal")`;
- an open non-live deal plus `status` → `HttpError(409, "sponsor_has_open_deal")`;
- the existing dispute-park 409 stays.

**Delete guard** (`deleteSponsor`): 409 `sponsor_has_deal_history` when any deal has `status <> 'pending'`, or a `payment_intent_id`, or `disputed_at`, or is not `draft`/`awaiting_*`. Otherwise it deletes the deals, then the sponsor, in one transaction.

**Tests:**
- Unit (DB): `deal-apply.test.ts`.
  - **Empty case first:** a sponsor with no deals keeps its hand-set gold, competition C, active and on_stream values byte-equal after `apply` (outcome `no_deals`).
  - A sponsor with only legacy deals → `no_deals`.
  - A live deal with gold, C and on stream → the sponsor is active/gold/C/on_stream, the `sponsor_stream_settings` org row exists, and `resolveSponsors(org, C)` lists it. The positive pair: `resolveSponsors(org, otherComp)` does not.
  - A parked live deal → `pending`, and `resolveSponsors` does not list it.
  - Open only → `inactive`, with tier unchanged. **This is the ruling case: a visible no-deal sponsor becomes hidden when an awaiting deal is added.**
  - All ended → inactive/partner/null/false.
  - **Promotion:** live A plus scheduled B; end A → B live, and the sponsor takes B's snapshot.
  - Second call: apply twice → identical row, and `live_at` is not rewritten.
  - **Downgrade (Review Focus 4):** a Pro gold deal goes live, then `setOrgPlan(community)`: apply keeps it active/gold, and `resolveSponsors(org, C, { tiered: false })` returns it as partner.
- Unit (DB): `sponsor-lock.test.ts`.
  - Each locked field with a live deal → 409 `sponsor_locked_by_deal`. Its positive pair: the same PATCH on a no-deal sponsor → 200.
  - `name` / `url` / `logo_path` with a live deal → 200.
  - `status` with an open deal → 409.
  - Delete: no deals → 204; a draft only → deleted with its deal; a paid deal → 409.
- E2E: Task 6's API spec has `a no-deal sponsor shows, an awaiting deal hides it, mark-paid shows it again, same id`.
- Smoke: Task 6.
- Regression: `server/usecases/__tests__/{sponsor-dispute.test.ts,sponsors.test.ts}` (PR A), and `app/api/v1/orgs/[id]/sponsors/__tests__/on-stream.test.ts` (the R4 tick on a no-deal sponsor is unchanged).

**Steps:**
- [ ] 1. Write both tests. Run VERIFY. Expected: FAIL, module missing.
- [ ] 2. Implement.
- [ ] 3. Run VERIFY on the two new tests and the three regression files. Run TSC.
- [ ] 4. Mutate:
  - Apply returns early when no deal is live (no promotion). Killer: `promotion`.
  - Ignore `parked_at`. Killer: the parked case.
  - Drop the `on_stream` lock field. Killer: its 409 case.
  - Restore after each.
- [ ] 5. Commit `feat(sponsors): one owner applies deals to their sponsor; a live deal locks tier, scope and stream`.

### Task 6: Deal usecases and routes (no Stripe): create, mark paid, approve, end now, offline refund, list and get

**Files:**
- Create: `apps/web/src/server/usecases/sponsor-deals.ts`
- Create: `apps/web/src/app/api/v1/orgs/[id]/sponsors/[sponsorId]/deals/route.ts`, `apps/web/src/app/api/v1/orgs/[id]/sponsor-deals/route.ts`, `apps/web/src/app/api/v1/orgs/[id]/sponsor-deals/[dealId]/route.ts`, `apps/web/src/app/api/v1/orgs/[id]/sponsor-deals/[dealId]/{mark-paid,approve,end,refund}/route.ts`
- Modify: `apps/web/src/server/api-v1/{schemas.ts,openapi.ts,key-scopes.ts}`, `openapi/v1.json`
- Test: `apps/web/src/server/usecases/__tests__/sponsor-deals.test.ts`, `apps/web/src/app/api/v1/orgs/[id]/sponsor-deals/__tests__/routes.test.ts`, `apps/web/e2e/sponsor-deals-api.spec.ts` (new), `scripts/smoke/suites/sponsorDeals.ts` (new) plus `scripts/smoke/main.ts`

**Interfaces:**
```ts
export const CreateDealInput = z.object({
  package_id: z.string().uuid(), competition_id: z.string().uuid().nullable(),
  payment_method: z.enum(PAYMENT_METHODS), go_live: z.enum(GO_LIVE_RULES),
  sponsor_email: z.string().email().max(320).nullish(), ends_on: z.iso.date().nullish(),
  end_current: z.boolean().default(false),
}).strict();
export async function createDeal(auth: AuthCtx, sponsorId: string, input: CreateDealInput, origin: string): Promise<SponsorDeal>;
export async function markDealPaid(auth: AuthCtx, dealId: string): Promise<SponsorDeal>;
export async function approveDeal(auth: AuthCtx, dealId: string): Promise<SponsorDeal>;
export async function endDealNow(auth: AuthCtx, dealId: string): Promise<SponsorDeal>;
export async function refundDeal(auth: AuthCtx, dealId: string): Promise<SponsorDeal>; // offline here; online in Task 7
export async function listDeals(auth: AuthCtx, opts?: { sponsorId?: string }): Promise<SponsorDeal[]>;
export async function getDeal(auth: AuthCtx, dealId: string): Promise<SponsorDeal>;
```

**Routes.** Every route is `requireOrgAuth(req, id, "write")`, except GET, which is `"read"`:
- `POST /orgs/{id}/sponsors/{sponsorId}/deals` → 201;
- `GET /orgs/{id}/sponsor-deals?sponsor_id=`;
- `GET /orgs/{id}/sponsor-deals/{dealId}`;
- `POST …/{mark-paid|approve|end|refund}` → 200.

**Acceptance for `createDeal`.** It follows the order of today's `startSponsorCheckout`: refusals before any row.
1. Load the package (404; `!active` → 422 `package_retired`).
2. The scope must be inside the package's: a one-competition package forces `competition_id = pkg.competition_id`, else 422 `scope_outside_package`. The competition must be the org's (404).
3. Call `assertPlacementAllowed(org, pkg.tier, scope)`. For online, call `assertOnlineAllowed(org, scope)` and check Connect (409 `connect_required`, today's wording).
4. Online needs `sponsor_email` (422).
5. `complimentary` + `on_payment` → 422 `on_payment_needs_payment` (`DealRuleError`).
6. `ends_on` must be today or later in the org's timezone (422). It is stored as `ends_at` = the start of the NEXT day in `organizations.timezone`.
7. In one transaction:
   - lock the sponsor;
   - `end_current` ends its live deal (`ended_now`);
   - insert with `initialStatus`, `initialPaymentStatus`, the snapshot from the package, `sponsor_name` from the sponsor, and `created_by` (= `auth.userId`);
   - stamp `live_at` when it is created live;
   - call `applyDealsToSponsor`.
8. Bust after commit.

Online deals are created `draft`; Task 7 sends the invoice.

**Acceptance for the actions:**
- **`markDealPaid`:** offline only here (online in Task 7). `payment_status` must be `pending`, else 409 `deal_already_paid`. Set paid, `paid_at`, `marked_paid_by`, and `deal_status = statusAfterPaid`, then apply.
- **`approveDeal`:** `awaiting_approval` only, else 409 `deal_not_awaiting_approval`. Set `approved_at` / `approved_by` and `statusAfterApproved`, then apply.
- **`endDealNow`:** any non-ended deal. Set `ended_now`, then apply, which may promote a scheduled deal.
- **`refundDeal` (offline):** payment `paid`, not disputed. Set `status='refunded'`, `deal_status='ended'`, `ended_reason='refunded'`, then apply. Nothing is emailed: no money moves (§5.2).
- Every action locks the deal row `for update`, so a concurrent second call sees the new state and answers 409.

**Tests:**
- Unit (DB): `sponsor-deals.test.ts`.
  - **Empty case first:** `listDeals` on a sponsor with no deals → `[]`.
  - For each of the 6 allowed offline and complimentary combos: create → (mark paid) → (approve), and assert `deal_status` after each step against the §5.2 table typed in the test, plus the sponsor's status and the `resolveSponsors` membership after each step (6 combos, counted).
  - **Anti-goal 2:** offline + `on_approval` → mark paid → the sponsor is still NOT listed by `resolveSponsors`, and is listed after approve.
  - **Concurrent approve (Review Focus 2):** `Promise.all([approveDeal, approveDeal])` → exactly one fulfilled, one rejected with 409, and one non-null `live_at`.
  - **Second call:** `endDealNow` twice → the second answers 409 `deal_ended`.
  - Refund offline → ended/refunded; the sponsor is hidden; `allowedActions` is `[]`.
  - **`end_current`:** live A, then create B immediate with `end_current` → A ended, B live, in one transaction (the sponsor's `live_at` is B's).
  - **Queue (Review Focus 5):** live A, then create B immediate → B `scheduled`; `endDealNow(A)` → B live.
  - **Refusals:** each 422 and 409 above has its accepted twin.
  - **Community:** an offline partner org-wide deal is created; an online one → 402; a gold one → 402.
- Unit: `routes.test.ts`. A viewer gets 403 on every POST and 200 on the GETs. A foreign org's deal id → 404. The bodies validate (the strict schema refuses unknown keys).
- E2E: `sponsor-deals-api.spec.ts` (Playwright `request` plus the public page HTML).
  - `community: add sponsor → offline when-paid deal hides it → mark paid → public /live page shows it, sponsor id unchanged, sponsor count unchanged`.
  - `complimentary straight away is live at once`.
  - `after-I-approve stays hidden after mark paid until Approve`.
  - `community creates a partner package (201) and is refused a gold one (402)`.
- Smoke, in `sponsorDeals.ts`:
  - `"sd offline deal created hidden (201)"`;
  - `"sd mark-paid puts the SAME sponsor on the public page"`;
  - `"sd approve required: still hidden after mark-paid"`;
  - `"sd community online deal refused (402)"`;
  - `"sd viewer cannot mark paid (403)"`.
- Regression: `server/usecases/__tests__/sponsor-order-delete-guards.test.ts` (the existing guards still hold).

**Steps:**
- [ ] 1. Write the unit, route and e2e tests and the smoke rows. Run VERIFY on the two vitest files. Expected: FAIL, module missing.
- [ ] 2. Implement the usecases and routes. Run OPENAPI. Add the routes to `key-scopes.ts` beside today's sponsor rows.
- [ ] 3. Run VERIFY on both files and `sponsor-order-delete-guards.test.ts`. Run TSC.
- [ ] 4. Mutate:
  - `approveDeal` without the `for update`. Killer: the concurrent test.
  - Offline `markDealPaid` ignores `go_live`. Killer: anti-goal 2.
  - `createDeal` skips `assertPlacementAllowed`. Killer: the community gold case.
  - Restore after each.
- [ ] 5. Commit `feat(sponsors): create, mark paid, approve, end and offline-refund a deal`.
- [ ] 6. Dispatch E2E for the branch. Hand back.

### Task 7: Online deals: send and resend the invoice, online refund, mark-paid on an online deal; retire `/sponsor-orders`

**Files:**
- Modify: `apps/web/src/server/usecases/sponsor-deals.ts` (add `sendDealInvoice`; online branches of `markDealPaid`, `endDealNow`, `refundDeal`)
- Modify: `apps/web/src/server/usecases/sponsors.ts`: extract `mintDealCheckout` out of `startSponsorCheckout` ~L518, then DELETE `startSponsorCheckout`, `StartSponsorCheckoutInput` and `listSponsorOrders`.
- Create: `apps/web/src/app/api/v1/orgs/[id]/sponsor-deals/[dealId]/send-invoice/route.ts`, and `…/[dealId]/evidence/route.ts` (moved from `sponsor-orders/[orderId]/evidence`)
- Delete: `apps/web/src/app/api/v1/orgs/[id]/sponsor-orders/**`
- Modify: `apps/web/src/server/api-v1/{schemas.ts,openapi.ts,key-scopes.ts}`, `openapi/v1.json`, `apps/web/src/app/developers/changelog/page.tsx`, `docs/api-v1-breaking-changes.md`
- Test: `apps/web/src/server/usecases/__tests__/sponsor-deals-online.test.ts`; modify `apps/web/src/server/usecases/__tests__/{sponsor-checkout.test.ts,sponsor-outbox.test.ts}` and `apps/web/src/server/email-outbox/__tests__/outbox-kind-sweep.test.ts`

**Interfaces:**
```ts
export async function sendDealInvoice(auth: AuthCtx, dealId: string, origin: string): Promise<{ deal: SponsorDeal; checkout_url: string }>;
// in sponsors.ts (Stripe outside any tx; same session shape as today: destination charge, application fee,
// metadata { kind: "sponsor", order_id, org_id }, success/cancel to /shared/<slug>)
export async function mintDealCheckout(deal: SponsorDeal, org: { id; slug; stripe_account_id }, origin: string, attempt: number):
  Promise<{ id: string; url: string; expires_at: number }>;
```

**Acceptance:**
- **`sendDealInvoice`.** Online only, for a deal that is `draft`, `awaiting_payment`, or `live`/`scheduled` with payment pending. Otherwise 409 `deal_not_invoiceable`.
  - If `checkout_expires_at > now + 10 min`, REUSE `checkout_url`.
  - Else mint with the idempotency key `sponsor-deal-<id>-<invoice_send_count + 1>`, and store `checkout_session_id`, `checkout_url` and `checkout_expires_at` (D14).
  - Enqueue `sponsor_invoice` (today's renderer `sponsorInvoiceEmail`) with dedupe key `onceKey("sponsor_invoice", "sponsor_order", id, String(invoice_send_count + 1))`, so a resend is a new row and a retried resend is not.
  - Set `invoice_send_count + 1`, `invoice_sent_at = now`, and `deal_status = statusAfterInvoiceSent`. Call `assertOutboxCanQueue()` BEFORE minting (P-W2-1).
  - `createDeal` online calls it after commit. A Stripe failure leaves a `draft` and answers 502, as today.
- **`markDealPaid` (online).** First call `stripe.checkout.sessions.expire(checkout_session_id)` outside any transaction. If Stripe answers that the session is complete → 409 `deal_paid_online`. Then follow the offline path.
- **`endDealNow` (online).** Expire any open session first.
- **`refundDeal` (online).** Delegates to `refundSponsorOrder`, which keeps its existing Stripe call and disputed refusal. Task 8 makes `handleSponsorChargeRefunded` end the deal.
- The changelog entry is dated on the merge day: "Breaking: sponsor orders become deals". It lists the removed and added paths, and that `sponsor_email` is now the deal's billing email.

**Tests:**
- Unit (DB, Stripe stubbed with `vi.spyOn(getStripe().checkout.sessions, …)`): `sponsor-deals-online.test.ts`.
  - The first send mints with key `…-1`, and a send inside the session's life REUSES the same url with no `create` call (asserted via call count 1).
  - A send after expiry mints `…-2`.
  - Two sends queue 2 `sponsor_invoice` rows; a retried send with the same count queues 1.
  - Stripe throws → the deal stays `draft` and the route answers 502.
  - Online mark-paid on a completed session → 409 and no state change.
  - Online `on_payment` stays hidden after send. Online `immediate` is live after create with payment pending, and `dealChip` reports `awaitingPayment`.
- Modify `sponsor-checkout.test.ts`: every `startSponsorCheckout` case moves to `createDeal` online. Its "pending order before intent" assertion stays.
- Modify `outbox-kind-sweep.test.ts`: the `sponsor_invoice` REAL-PRODUCER scenario now drives `createDeal` online, not `startSponsorCheckout`.
- E2E: `apps/web/e2e/walkthrough/settings-sponsor-monetize.spec.ts` "invoice: Send invoice mints a REAL Stripe Checkout Session". It is updated in Task 12 (its UI path); here only its API calls change.
- Smoke, in `sponsors.ts`: the `"sp checkout …"` rows are rewritten onto `POST /sponsors/{id}/deals` (online):
  - `"sp online deal refused without Connect (409)"`;
  - `"sp online deal starts (draft→awaiting_payment, checkout url)"`, keyless or Connect-less as today's skips;
  - `"sp deal row landed (deal-before-intent)"`.
- Regression: `server/usecases/__tests__/sponsor-outbox.test.ts` (receipt and refund kinds unchanged); `lib/__tests__/scrub-request-body.test.ts`.

**Steps:**
- [ ] 1. Write the online test and rewrite the three modified tests. Run VERIFY. Expected: FAIL (`sendDealInvoice` missing; old imports gone).
- [ ] 2. Implement. Delete the old routes. Run OPENAPI. Add the changelog entry and the breaking-change doc.
- [ ] 3. Run VERIFY on the four files. Run TSC.
- [ ] 4. Mutate. These are **money-path** mutants:
  - Never reuse the session (always mint). Killer: the reuse case.
  - Drop the expire-before-mark-paid. Killer: the completed-session case.
  - Use a constant dedupe key. Killer: the two-sends case.
  - Report the killer list.
- [ ] 5. Commit `feat(sponsors)!: online deals send a reusable Checkout invoice; /sponsor-orders is retired`.

### Task 8: The webhook, refunds and disputes move deals, never sponsors (the inert-seam task)

**Files:**
- Modify: `apps/web/src/server/usecases/sponsors.ts`: `handleSponsorPaymentSucceeded` ~L652, `handleSponsorPaymentFailed`, `handleSponsorChargeRefunded` ~L830, `handleSponsorDispute` ~L1018, and `listSponsorRows`' `dispute_parked` (it now reads a live deal's `parked_at`).
- Modify (fixtures that seed orders; every deal column becomes explicit, a live deal): `apps/web/src/server/usecases/__tests__/_money-fixtures.ts`, `apps/web/e2e/payments-hardening.spec.ts` (`seedSponsorRig` ~L373), `scripts/smoke/suites/p72.ts` (the paid-order seed ~L259).
- Test: `apps/web/src/server/usecases/__tests__/deals-webhook-seam.test.ts` (new); update `apps/web/src/server/usecases/__tests__/{sponsor-dispute.test.ts,sponsor-dispute-outbox.test.ts,sponsor-dispute-clicks.test.ts}` and `apps/web/src/server/email-outbox/__tests__/{outbox-kind-sweep.test.ts,a-kind-body.test.ts}`.

**Interfaces:**
- Consumes `applyDealsToSponsor`, `statusAfterPaid`, `bustPublicSponsors`.
- Produces handler behaviour. The signatures are unchanged, and `billing-events.ts` dispatch is untouched.

**Acceptance:**
- **Payment succeeded.** Lock the deal. If `status` is in (`pending`, `failed`): set paid, `paid_at`, and the intent (`coalesce`), and queue the receipt (unchanged). Then:
  - `ended` (including legacy) → no apply, plus `log.warn({ dealId }, "sponsors: payment on an ended deal")`;
  - otherwise `deal_status = statusAfterPaid(deal, otherLive)` and apply.
  - **There is no `insert into sponsors` anywhere in the file** (enforced by a source test).
  - A second, DIFFERENT intent succeeding on an already-paid deal → `log.error` plus no state change (D14 makes it unreachable; this guard proves the "cannot happen").
- **Payment failed.** `pending` → `failed`. The deal status is unchanged (the sponsor can retry in the same session).
- **Charge refunded.** `paid` → `refunded`, plus `deal_status='ended'`, `ended_reason='refunded'`, `ended_at`, and apply. The notice is unchanged. It **no longer** writes `sponsors.status` directly.
- **Disputes.**
  - `created` (formal, not `warning_*`): set `parked_at = coalesce(parked_at, now())` on the deal, then apply.
  - `funds_withdrawn` while THIS dispute is open on a paid deal: the same.
  - Won or `warning_closed` while still paid: `parked_at = null`, then apply.
  - Lost: `status='refunded'`, `deal_status='ended'`, `ended_reason='dispute_lost'`, then apply, then recovery (unchanged).
  - All sponsor writes go through apply. The alerts, notices, once-keys and recovery are unchanged.
- Fixtures: `seedSponsorOrder` / `seedSponsorRig` / p72's seed insert `deal_status='live', payment_method='online', go_live='on_payment', tier, includes_on_stream=false, package_name, competition_id, live_at=now()`. A legacy-shaped insert would now fail on the no-default columns, which is intended.

**Tests:**
- Unit (DB): `deals-webhook-seam.test.ts`. Every case drives `runEvent(event)` from `server/usecases/billing-events.ts`, never the handler.
  - **S1:** a sponsor with a logo and link, plus an online `on_payment` deal at gold/C/on-stream → `payment_intent.succeeded` → the SAME sponsor id is active/gold/C/on_stream, keeps its logo and link, `resolveSponsors(org, C)` and `resolveSponsors(org, C, { onStream: true })` list it, and `select count(*) from sponsors where org_id` is unchanged.
  - **Second call:** a replay of the same event → no change, and one receipt row.
  - **Anti-goal 2:** online `on_approval` paid → still not listed; approve → listed.
  - **Late payment (Review Focus 1):** `endDealNow` then the payment event → the deal stays `ended`, payment `paid`, the sponsor is not listed, and `allowedActions` includes `refund`.
  - **Refund:** `charge.refunded` on live A while scheduled B exists → A ended/refunded, B live.
  - **Old-deal dispute:** a dispute created on an ENDED old deal while a newer deal is live → the sponsor stays active (D8 reads only the live deal).
  - **Park:** formal created → `pending`; won → `active`. An inquiry (`warning_needs_response`) → stays active.
  - **Lost:** → ended `dispute_lost`, sponsor inactive.
  - **Source guard:** `readFileSync("server/usecases/sponsors.ts")` contains no `/insert\s+into\s+sponsors\b/i`, and its positive pair is that `usecases/sponsors.ts`'s `createSponsor` is matched by the same regex in the SAME file before the handler section is cut out. (The test slices the file at the `Webhook activation` banner and asserts the regex hits the first part and misses the second.)
- Update the three dispute tests: their fixtures are now live deals, and their assertions about the sponsor status are unchanged (the park semantics are preserved).
- E2E: `payments-hardening.spec.ts`'s "created parks the placement", "closed lost writes off", "closed won restores" and "replayed created" run unchanged on the new seed. Add a case to `sponsor-deals-api.spec.ts`: `signed payment_intent.succeeded on an online deal shows the SAME sponsor on the public page`. Reuse `payments-hardening.spec.ts`'s signed-event helper, moved into `apps/web/e2e/_stripe-events.ts` if it is file-local.
- Smoke: `"sd paid webhook never adds a sponsor row"` (count before and after, around a signed event as `payments-hardening` sends it). p72's guards keep passing on the new seed.
- Regression: `dispute-unmatched-retry.test.ts`, `platform-dispute.test.ts`, `competitions-delete-money.test.ts` (their sponsor seeds come from `_money-fixtures.ts`).

**Steps:**
- [ ] 1. Write the seam test and update the fixtures and dispute tests. Run VERIFY on the seam test. Expected: FAIL. S1's count is +1, because today's handler inserts.
- [ ] 2. Implement the handler changes.
- [ ] 3. Run VERIFY on the seam test, the three dispute tests, `outbox-kind-sweep.test.ts`, `a-kind-body.test.ts`, `dispute-unmatched-retry.test.ts`, `platform-dispute.test.ts` and `competitions-delete-money.test.ts`. Run TSC.
- [ ] 4. Mutate. These are **money-path** mutants, one per surface:
  - Re-add the sponsor insert. Killers: S1 count and the source guard.
  - `statusAfterPaid` is bypassed (always live). Killer: anti-goal 2.
  - The refund path skips apply. Killer: the refund case.
  - The won path skips clearing `parked_at`. Killer: the park case.
  - Lost skips ending the deal. Killer: the lost case.
  - Report the killer list.
- [ ] 5. Commit `fix(sponsors): a payment moves its deal, and the deal applies to the sponsor; the webhook never inserts a sponsor`.
- [ ] 6. Dispatch E2E. Hand back.

### Task 9: The sweep: expiry, a finished competition, and promotion

**Files:**
- Modify: `apps/web/src/server/usecases/sponsor-deals.ts` (add `sweepSponsorDeals`)
- Create: `apps/web/src/app/api/cron/sponsor-deals/route.ts`
- Modify: `apps/cron-worker/src/schedule.ts` (one `JOBS` row) and `apps/cron-worker/test/schedule.test.ts` (`HOURLY` gains `"sponsor-deals"`)
- Test: `apps/web/src/server/usecases/__tests__/sponsor-deals-sweep.test.ts`, `apps/web/src/app/api/cron/sponsor-deals/__tests__/route.test.ts`

**Interfaces:**
```ts
export async function sweepSponsorDeals(now?: Date): Promise<{ checked: number; expired: number; finished: number; promoted: number; failed: number }>;
// JOBS row: { id: "sponsor-deals", path: "/api/cron/sponsor-deals", trigger: TRIGGER_CRON, due: { kind: "every" }, retry: true, manual: true, failureCounts: ["data.failed"] }
```

**Acceptance:**
- The sweep runs on the privileged `sql` connection, per deal in its own transaction.
- A live deal with `ends_at <= now` → `ended`/`expired`, then apply.
- A live deal with a competition, no `ends_at`, and `competitionPhase(await getCompetitionDesk(ctx, compId)).kind === "finished"` → `competition_finished`, then apply. The context is `{ orgId, via: "session", userId: null, role: "viewer", keyId: null }`; this repo synthesizes contexts the same way in `lib/funnel.ts`, `stream-sessions.ts` and `youtube/end-step.ts`.
- A deal that throws is counted in `failed` and logged, and the sweep moves on.
- `checked` counts the live deals examined.
- The route follows `api/cron/registrations/route.ts`: `x-cron-secret` against `CRON_SECRET`, 401/503, then `handler`.

**Tests:**
- Unit (DB): `sponsor-deals-sweep.test.ts`.
  - **Empty case first:** no live deals → `{ checked: 0, … }`. That is not a failure here, because the empty case is the subject; the next case is the anti-vacuity one.
  - Two live deals, one with `ends_at = now - 1 min` and one with `now + 1 day` → `checked` 2 and `expired` 1. The expired sponsor is not listed by `resolveSponsors`; the other still is.
  - **Second call:** the sweep twice → `expired` 1, then 0.
  - **Competition finished:** a deal scoped to C with every division finished (seeded with the competition-desk test rig) → `competition_finished`. Its positive pair: C with one division still scheduled → untouched.
  - **Moving dates moves the end** (§8a): C finished with its `ends_on` changed into the future → still ended (phase, not date).
  - Promotion after expiry → the scheduled deal goes live.
- Unit: `route.test.ts`. No secret → 401; the wrong one → 401; the right one → 200 with the counts.
- Unit: `apps/cron-worker/test/schedule.test.ts` with the updated `HOURLY`, run from `apps/cron-worker` with `npx vitest run test/schedule.test.ts test/drift.test.ts`.
- E2E: `sponsor-deals-api.spec.ts`, `an org-wide deal whose end date has passed comes off the public page after the cron route runs`. Seed `ends_at` in the past through SQL (the end-date INPUT is proven in Task 16), then POST the route with `CRON_SECRET`.
- Smoke: `"sd cron route refuses a wrong secret (401)"` and `"sd cron route answers counts (200)"`.
- Regression: `apps/cron-worker/test/drift.test.ts` (no new trigger).

**Steps:**
- [ ] 1. Write the tests. Run VERIFY on the two web tests. Expected: FAIL, missing.
- [ ] 2. Implement.
- [ ] 3. Run VERIFY on the two web tests and the cron-worker pair. Run TSC on the web files and on `apps/cron-worker/src/schedule.ts`.
- [ ] 4. Mutate:
  - `<=` → `<` on `ends_at`. Killer: an `ends_at = now` boundary case, which must be added.
  - Skip the competition branch. Killer: the finished case.
  - Restore after each.
- [ ] 5. Commit `feat(sponsors): an hourly sweep ends expired and finished-competition deals and promotes the next`.

### Task 10: Deleting a competition with deals

**Files:**
- Modify: `apps/web/src/server/usecases/competitions.ts` (beside the `paidSponsor` guard, ~L905)
- Modify: `scripts/smoke/suites/p72.ts`
- Test: `apps/web/src/server/usecases/__tests__/sponsor-order-delete-guards.test.ts` (extend)

**Acceptance.** Before today's sponsor guard: 409 `"competition has sponsor deals — end them or archive it instead"` when `exists (select 1 from sponsor_orders where competition_id = :id and ended_reason is distinct from 'legacy')`, or `exists (select 1 from sponsors s join sponsor_orders o on o.sponsor_id = s.id where s.competition_id = :id and o.ended_reason is distinct from 'legacy')`. Today's legacy-package sweep stays.

**Tests:**
- Unit (DB). **The empty case first:** a competition with no sponsors deletes (204).
  - A complimentary deal scoped to it → 409, not a 500.
  - An org-wide deal whose sponsor was hand-scoped to it → 409.
  - A no-deal sponsor scoped to it → deleted with it (today's cascade).
  - A deal scoped to ANOTHER competition → delete succeeds.
- E2E: `payments-hardening.spec.ts` "all three money guards 409 with their archive hint" stays green. Add a case to `sponsor-deals-api.spec.ts`: `deleting a competition a deal is scoped to answers 409 with the archive hint`.
- Smoke, in p72: `"p72: delete blocked by a sponsor deal (409)"`.
- Regression: today's p72 rows.

**Steps:**
- [ ] 1. Write the tests. Run VERIFY. Expected: FAIL (500, `23503`).
- [ ] 2. Implement.
- [ ] 3. Run VERIFY on `sponsor-order-delete-guards.test.ts` and `competitions-delete-money.test.ts`. Run TSC.
- [ ] 4. Mutate: drop the second `exists` arm. Killer: the hand-scoped case. Restore.
- [ ] 5. Commit `fix(competitions): deleting a competition with sponsor deals is refused, not a 500`.

### Task 11: The model-based sequence test (TEST-STRATEGY rule 10)

**Files:**
- Create: `apps/web/src/server/usecases/__tests__/sponsor-deals-sequence.test.ts`

**Interfaces.** It consumes everything in Tasks 5 to 9, through the real usecases, and `runEvent` for payments, refunds and disputes.

**Acceptance.**
- fast-check generates sequences of 1–14 commands over one org with 2 sponsors and 3 packages (one includes On stream; one is scoped to competition C):
  - `createDeal` (any allowed combo, sponsor 0/1, `end_current` true or false);
  - `sendDealInvoice`, `markDealPaid`, `approveDeal`, `endDealNow`, `refundDeal`;
  - `runEvent(payment_intent.succeeded)`, `runEvent(charge.refunded)`, `runEvent(charge.dispute.created|closed won|closed lost)`;
  - `sweepSponsorDeals(now + k days)`.
- Commands illegal in the current state are expected to throw `HttpError` 409/422, and must leave the DB byte-equal to before.
- `numRuns: 30`. Stripe is stubbed as in Task 7.
- **Invariants after EVERY step:**
  - (I1) at most one live deal per sponsor;
  - (I2) the sponsor is `active` ⇔ it has a live, unparked deal (for sponsors with ≥1 non-legacy deal);
  - (I3) an active sponsor's tier, competition_id and on_stream equal its live deal's snapshot;
  - (I4) the org's sponsor row count never changes;
  - (I5) no live deal has `go_live='on_approval'` and `approved_at` null;
  - (I6) no live deal has `go_live='on_payment'` and payment `pending`;
  - (I7) a deal with payment `refunded` is `ended`.
- The test reports `stepsChecked` and fails if it is < 100 across the run (anti-vacuity).
- A failure is committed as a named regression case with its seed BEFORE any fix.

**Tests:**
- Unit (DB): the file itself.
- E2E, smoke: n/a. This is the model layer under Tasks 6 to 9's e2e and smoke.
- Regression: any shrunk counterexample becomes a named case in this file.

**Steps:**
- [ ] 1. Write the test. Run VERIFY. Expected: PASS. Record `stepsChecked`.
- [ ] 2. Mutation check (a true red is impossible on a property over correct code): break I6's guard by making `statusAfterPaid` always `live`. It must fail and shrink. Restore. Do the same for promotion (Task 5 mutant). Report both killer seeds.
- [ ] 3. Commit `test(sponsors): model-based deal sequences — seven invariants after every step`.

### Task 12: Today's screens keep working (the transitional UI)

**Files:**
- Modify: `apps/web/src/components/sponsor-packages.tsx`:
  - the Send invoice form's "Sponsor name" text input becomes a `<select>` of the org's sponsors, and it POSTs `/sponsors/{id}/deals` with `{ package_id, competition_id: pkg.competition_id, payment_method: "online", go_live: "on_payment", sponsor_email }`;
  - the orders list reads `GET /sponsor-deals`;
  - Refund and Evidence use the new paths.
- Modify: `apps/web/src/components/org-sponsors.tsx` (tier, competition and status controls are disabled with a "Set by the live deal" note when `locked_by_deal`; the delete guard reads `has_open_deal` / `paid_order_id`).
- Modify: `apps/web/src/components/sponsors/on-stream-tab.tsx` (a locked sponsor's tick is disabled, with a "Set by the deal" reason).
- Modify: `apps/web/src/app/o/[orgSlug]/sponsors/page.tsx` (pass `listSponsorRows` to Packages for the picker).
- Dictionaries ×4: `sponsors.deal.lockedNote`, `sponsors.order.sponsorPick`.
- Test: `apps/web/src/components/__tests__/sponsor-packages-picker.test.tsx`; `apps/web/e2e/walkthrough/settings-sponsor-monetize.spec.ts` (updated)

**Acceptance:**
- No new page or pattern: the picker uses the form's existing `<select>` styling.
- The duplicate-invoice confirm (`sponsors.order.dupConfirm.*`) now fires when the chosen sponsor has an open deal on this package.
- **Use frontend-design.** Verify at 320, 768 and 1280: the picker and the disabled controls fit, and nothing scrolls sideways.

**Tests:**
- Unit: `sponsor-packages-picker.test.tsx` (`renderIsland`).
  - The picker opens at the first sponsor by `display_order`.
  - It POSTs `sponsor_id`, not `sponsor_name`.
  - **The empty case:** with no sponsors, the form shows "Add a sponsor first" and no Send button.
- E2E: the walkthrough's "sell" and "invoice" tests now create a sponsor first and pick it. The "REAL Stripe Checkout Session" assertion is unchanged. Add `the On stream tab's tick is disabled for a sponsor with a live deal` to `sponsor-deals-api.spec.ts`, as a page-level test.
- Smoke: `"sp hub Packages tab renders the sell console for an editor"` stays green.
- Regression: `apps/web/e2e/sponsors-hub.spec.ts` (unchanged in PR 1); `components/sponsors/__tests__/on-stream-tab.test.tsx`.

**Steps:**
- [ ] 1. Invoke frontend-design. Write the tests. Run VERIFY on the vitest files. Expected: FAIL.
- [ ] 2. Implement, adding the strings ×4. Run `npm run i18n:gen-keys` and `npm run i18n:check`.
- [ ] 3. Run VERIFY on `sponsor-packages-picker.test.tsx`, `on-stream-tab.test.tsx` and the dictionary copy-truth and retired-plan-copy tests. Run TSC.
- [ ] 4. Mutate: the picker sends `sponsor_name`. Killer: the POST-body case. Restore.
- [ ] 5. Commit `feat(sponsors): today's sell console picks a sponsor; deal-locked controls say why`.
- [ ] 6. Dispatch E2E. Open the PR with a "Data changes" section (D1, D2, D6, premise 1's flip) and a "Breaking API" section. Hand back.

---

# PR 2: Screens, option B (`feat/sponsor-deals-screens`)

Every task in this PR invokes **frontend-design** before markup, follows the mockups for layout only, and is verified at 320 / 768 / 1280. Their e2e tests live in `apps/web/e2e/sponsor-deals.spec.ts`. Each task adds its own `test(...)` block there, and Task 19 adds the widths walkthrough.

### Task 13: Hub URL state, loaders and the timeline model

**Files:**
- Modify: `apps/web/src/lib/sponsors-hub.ts`, `apps/web/src/app/o/[orgSlug]/sponsors/page.tsx`
- Modify: `apps/web/src/lib/sponsor-deals.ts` (add `dealTimeline`)
- Test: `apps/web/src/lib/__tests__/sponsors-hub.test.ts` (extend), `apps/web/src/lib/__tests__/sponsor-deals-timeline.test.ts`, `apps/web/src/app/o/[orgSlug]/sponsors/__tests__/page.test.tsx` (extend)

**Interfaces (Produces):**
```ts
export function resolveSponsorParam(raw: string | string[] | undefined, sponsors: readonly { id: string }[]): string | null; // only THIS org's ids, else null
export function resolveDealParam(raw: string | string[] | undefined, deals: readonly { id: string }[]): string | null;
export function sponsorHref(orgSlug: string, sponsorId: string): string; // /o/<slug>/sponsors?tab=sponsors&sponsor=<id>
export function dealHref(orgSlug: string, sponsorId: string, dealId: string): string; // …&deal=<id>
export type TimelineStep = { key: "created"|"invoice_sent"|"paid"|"approved"|"live"|"ends"|"ended"; at: string | null; state: "done"|"next"|"not_yet"|"skipped"; detail?: Record<string, string> };
export function dealTimeline(d: SponsorDeal, ctx: { competitionEndsOn: string | null }): TimelineStep[];
```

**Acceptance:**
- The page's Sponsors tab loads `listSponsorRows`, `listDeals(auth)` for the org, `listSponsorPackages`, `hasFeatureOnAnyPass(…,"sponsors.tiers")`, `hasFeatureOnAnyPass(…,"sponsors.monetize")`, `organizations.stripe_charges_enabled`, the competitions (with `ends_on`), and the report links when `sponsor` is set.
- A foreign or unknown `sponsor` or `deal` id behaves as if absent (it falls back to the list), never a 404 or a crash.
- `dealTimeline`:
  - complimentary has no `invoice_sent` or `paid` steps (`skipped`);
  - `on_payment` or `immediate` has no `approved` step;
  - live with no `ends_at` and a competition scope → `ends.detail.competitionEndsOn`;
  - ended → `ended` with its reason.

**Tests:**
- Unit:
  - `resolveSponsorParam` / `resolveDealParam`: the empty list → null; an array value → null; a foreign id → null.
  - `dealTimeline` over the 8 combos × {mid-flow, live, ended}, compared against the mockup's screen 5 order (`created, invoice_sent, paid, approved, live, ends`) typed in the test. The count is reported.
- Unit (page): `page.test.tsx`. `?sponsor=<foreign>` renders the list; `?sponsor=<own>` renders `data-testid="sponsor-sheet"`.
- E2E: Task 15 drives the URL.
- Smoke, in `sponsorDeals.ts`: `"sd hub ?sponsor=<id> renders the sponsor page (200, sponsor-sheet)"` and `"sd hub ?sponsor=<foreign> falls back to the list"`.
- Regression: `sponsors-hub.test.ts`'s existing cases.

**Steps:**
- [ ] 1. Write the tests. Run VERIFY (expect FAIL).
- [ ] 2. Implement.
- [ ] 3. Run VERIFY. Run TSC.
- [ ] 4. Mutate: `resolveSponsorParam` accepts any uuid. Killer: the foreign case. Restore.
- [ ] 5. Commit `feat(sponsors): hub URL state for a sponsor and a deal; the deal timeline model`.

### Task 14: The Sponsors tab list

**Files:**
- Create: `apps/web/src/components/sponsors/{sponsor-list.tsx,sponsor-row-more.tsx,deal-chip.tsx}`
- Modify: `apps/web/src/components/org-sponsors.tsx` (it becomes the add form plus `SponsorList`; the tier and competition selects leave the ADD form)
- Dictionaries ×4: `sponsors.deal.chip.*`, `sponsors.deal.action.*`, `sponsors.deal.subline.*`, `sponsors.list.more`
- Test: `apps/web/src/components/sponsors/__tests__/sponsor-list.test.tsx`, `apps/web/src/components/sponsors/__tests__/deal-chip.test.tsx`

**Acceptance (mockup screen 1):**
- "Add a sponsor" has only name, logo and link, with the hint "Name, logo and link. Add a deal afterwards to set their tier and where they show."
- Rows group by `row.deal?.tier ?? row.tier` in `SPONSOR_TIERS` order (only when `hasTiers`, as today).
- Each row shows the logo, the name (`truncate`, with `min-w-0` up the chain), and a sub-line:
  - `package · price · scope` for a live deal;
  - `· Online invoice sent <date>`, `· Bank transfer`, `· Complimentary` or `· Not sent yet` per state;
  - `No deal · <host>` with no deal.
- Each row shows the `DealChip` and at most ONE action button from `rowNextAction`.
- The clicks count and the edit, move and delete controls are inline at ≥md. Below md they fold behind `SponsorRowMore`: a 44 px "⋯" button with `aria-expanded` and the accessible name "More for {name}". The controls exist ONCE in the DOM (`max-md:hidden` unless open).
- The action buttons call the Task 6 and 7 routes. "Open deal" and "Add deal" navigate (`dealHref`, or open Task 16's sheet).
- `DealChip` reuses `status-chip.tsx`'s chip classes and tokens, with no new colours.

**Tests:**
- Unit (`renderIsland`):
  - `rowNextAction` → button mapping for each mockup row (8 rows typed from the mockup: Live/–, Awaiting payment/Resend invoice, Awaiting approval/Approve, Awaiting payment offline/Mark as paid, Live complimentary/–, Draft/Open deal, No deal/Add deal, Ended/Add deal). The count is asserted.
  - **The empty case:** no sponsors → the empty-state copy.
  - Grouping by the deal tier (a pending gold deal on a partner sponsor sits in Gold).
  - `deal-chip.test.tsx`: every `DealChip.kind` maps to a dictionary key present in all 4 locales.
- E2E, in `sponsor-deals.spec.ts`:
  - `list: each row shows one next action and the chip its deal state names` (seeded through the API);
  - `list at 320: the ⋯ fold holds clicks, edit, move and delete; no sideways scroll; a 43-char name truncates`.
- Smoke: `"sd hub Sponsors tab shows the add form without a tier select"`.
- Regression:
  - `apps/web/e2e/sponsors-hub.spec.ts` "a viewer gets the read-only view" (a viewer sees no actions);
  - `components/__tests__/nav-sponsors.test.tsx`.

**Steps:**
- [ ] 1. Invoke frontend-design. Write the tests. Run VERIFY (expect FAIL).
- [ ] 2. Implement, adding the strings ×4. Run i18n gen and check.
- [ ] 3. Run VERIFY with the copy tests. Run TSC.
- [ ] 4. Mutate: render two actions (both `allowedActions[0]` and `[1]`). Killer: the one-action row test. Restore.
- [ ] 5. Commit `feat(sponsors): the Sponsors tab lists each sponsor with its deal's chip and one next action`.

### Task 15: The sponsor page (phone page, desktop side sheet)

**Files:**
- Create: `apps/web/src/components/sponsors/sponsor-sheet.tsx`
- Modify: `apps/web/src/components/modal.tsx` (add `placement?: "center" | "side"`; `side` = a full-height right panel at ≥md, unchanged below md), `apps/web/src/app/o/[orgSlug]/sponsors/page.tsx`
- Dictionaries ×4: `sponsors.sheet.*`
- Test: `apps/web/src/components/sponsors/__tests__/sponsor-sheet.test.tsx`, `apps/web/src/components/__tests__/modal.test.ts` (extend)

**Acceptance (mockup screen 2, option B):**
- With `sponsor` set, the list wrapper gets `max-md:hidden`, and `SponsorSheet` renders as the page body on phones (a back link "← Sponsors" to `sponsorsHref(slug,"sponsors")`) and as `Modal placement="side"` at ≥md. Closing it means navigating to the list URL.
- **Details:** name, logo and link are editable. On stream is a toggle, disabled with the `sponsors.deal.lockedNote` reason when locked. Tier and scope are editable only when there is no live deal; otherwise they read "Tier now X. Y when the deal goes live" (mockup).
- **Deals:** the current deal and the past deals (`listDeals` filtered to the sponsor, newest first), each with its chip, amount, scope line and actions, plus "Add deal".
- **Report link:** PR A's `ShareReport` for this sponsor.

**Tests:**
- Unit:
  - The sheet with a live-deal sponsor → the tier and scope controls are absent and the "Tier now" line is present. The positive pair: a no-deal sponsor → the controls are present.
  - **The empty case:** no deals → "No deals yet" plus Add deal.
  - Modal: `placement="side"` adds the md side classes and leaves the `max-md:` ones unchanged (a class-string test; the anchors avoid `/\bmd:hidden\b/`).
- E2E:
  - `sponsor page: phones get their own page with back; desktop a side sheet over the list` (1280 and 390 in one test via `page.setViewportSize`);
  - `sponsor page: a live deal's tier and stream are read-only; name and link save`.
- Smoke: Task 13's row.
- Regression: `components/__tests__/modal.test.ts`, and `components/sponsors/__tests__/share-report.test.tsx`.

**Steps:**
- [ ] 1. Invoke frontend-design. Write the tests. Run VERIFY (FAIL), then implement, then VERIFY again. Run TSC. Run i18n gen and check.
- [ ] 2. Mutate: render the tier select while locked. Killer: the locked case. Restore.
- [ ] 3. Commit `feat(sponsors): a sponsor's own page — details, deals and report link`.

### Task 16: The Add deal sheet

**Files:**
- Create: `apps/web/src/components/sponsors/add-deal-sheet.tsx`
- Modify: `apps/web/src/lib/sponsor-deals.ts` (add `dealSummary`)
- Dictionaries ×4: `sponsors.dealSheet.*` (package, scope, payment cards, go-live cards, summary templates, button labels, queue note, end-current option, locked-online hint, locked-tier hint)
- Test: `apps/web/src/components/sponsors/__tests__/add-deal-sheet.test.tsx`, `apps/web/src/lib/__tests__/sponsor-deals-summary.test.ts`

**Interfaces:**
```ts
export type SummaryParts = { key: MessageKey; params: Record<string, string> }[];
export function dealSummary(i: { sponsorName; packageName; scopeName: string | null; method: PaymentMethod; rule: GoLiveRule;
  amount: string; email: string | null; otherLive: boolean; currentlyShown: boolean }): SummaryParts;
```

**Acceptance (mockup screen 3):**
- **Package cards:** active packages only. Each card shows the name, price, tier, scope, and "On stream" when included (no website-board or slideshow chips, §8a). A package that `placementNeedsTiers` makes unavailable (community) is shown locked, with an upgrade link to `routes.billing(slug)`.
- **Scope select:** "Whole organisation", then the org's competitions. It is locked to the package's competition when it has one.
- **Payment, three radio cards.**
  - Online is locked, with the hint "Paid plans only. Upgrade to send invoices", when `!hasMonetize`.
  - When monetize is on but Connect is off, it is locked with "Connect Stripe first" → `routes.connect(slug)`.
  - Online shows the billing email field (required).
  - Offline shows an optional email (used in PR 3).
- **Go-live, three radio cards.** "When paid" is hidden for complimentary. Its sub-copy follows the method ("As soon as the invoice is paid" / "When you mark it paid").
- **Ends on:** an optional date, shown only for the whole-org scope. A competition scope shows "Runs <dates>. The deal ends when it finishes."
- **With a live deal:** the note "This deal starts when the current one ends", plus a checkbox "End the current deal now instead" (→ `end_current`).
- **Summary:** `dealSummary`. When `currentlyShown && !goesLiveNow`, it adds "<name> is hidden from your pages until then" (the §8a ruling, said out loud).
- **Primary button:** `primaryLabel`.
- **Opening values exactly as D22.**
- **Double-submit:** the button is disabled while the request is in flight (Review Focus 2's UI half).

**Tests:**
- Unit: `sponsor-deals-summary.test.ts` gives the 3 mockup summaries verbatim in `en` (paid plan online, community offline after-approve, complimentary straight away), each from its inputs, plus the hidden-until clause case and its positive pair.
- Unit (`renderIsland`): `add-deal-sheet.test.tsx` **pins every opening value in D22**:
  - (a) Pro with Connect → online/on_payment;
  - (b) Pro without Connect → offline/on_payment, online locked with the connect hint;
  - (c) community → offline/on_payment, online locked with the upgrade hint, gold card locked;
  - (d) the email opens at `last_billing_email`;
  - (e) a package scoped to C → the scope opens at C and is disabled.
  - Picking complimentary moves go-live from on_payment to immediate, and "When paid" disappears.
  - The button label follows each of the 3 mockup choices.
  - The POST body equals the visible choices (the seam: what is shown is what is sent).
- E2E:
  - `add deal (Pro): online, when paid → Send invoice → row shows Awaiting payment and Resend invoice`;
  - `add deal (community): offline, after I approve → Save deal → Mark as paid → still hidden → Approve → on the public page`;
  - `add deal: complimentary, straight away → Save and go live → on the public page at once`;
  - `add deal: an org-wide Ends on date is saved as the deal's end (read back through GET /sponsor-deals/{id})` (seam S6);
  - `add deal on a live sponsor: queued; "End the current deal now" swaps them`.
- Smoke: none beyond Task 13 (an HTML smoke cannot open a client sheet).
- Regression: `sponsor-packages-picker.test.tsx` is deleted with the transitional UI in Task 18, NOT here.

**Steps:**
- [ ] 1. Invoke frontend-design. Write the tests. Run VERIFY (FAIL), then implement, then VERIFY again. Run TSC. Run i18n gen and check, and the copy-truth and retired-plan-copy tests.
- [ ] 2. Mutate:
  - The opening method ignores `chargesEnabled`. Killer: (b).
  - Do not drop on_payment for complimentary. Killer: the switch case.
  - Restore after each.
- [ ] 3. Commit `feat(sponsors): the Add deal sheet — package, scope, payment, go-live, and a summary that says what will happen`.

### Task 17: The deal page

**Files:**
- Create: `apps/web/src/components/sponsors/deal-page.tsx`
- Dictionaries ×4: `sponsors.deal.timeline.*`, `sponsors.deal.goingLive.*`, `sponsors.deal.confirm.*`
- Test: `apps/web/src/components/sponsors/__tests__/deal-page.test.tsx`

**Acceptance (mockup screen 5):**
- The header shows the package, the price, the sponsor and the chip.
- The action buttons are exactly `allowedActions(deal)`, in `DEAL_ACTIONS` order:
  - Mark as paid, Approve, Refund, End now, Send/Resend invoice;
  - **Evidence pack** (the moved route) when `disputed_at`; it is no longer reachable from anywhere else, so dropping it would be a regression.
- **Timeline:** `dealTimeline`.
- **The "Deal" facts block:** package and tier, scope, payment, the invoice email, the go-live rule.
- **"Going live will":** "Set the tier to X", "Show them on your public pages", and "Put them on stream" or "On stream is not in this package", then "A refund or the end date switches these off again."
- **Confirms:** Refund reuses the `sponsors.order.refundConfirm.*` copy, re-keyed under `sponsors.deal.confirm.refund.*` with "deal". End now confirms "Tier, page and stream switch off now". Mark as paid on an online deal confirms that the pay link will stop working.
- The phone and desktop presentation is the same as Task 15 (`&deal=`).

**Tests:**
- Unit:
  - The action set equals `allowedActions` for 6 seeded states typed from the mockup (Awaiting approval → Approve, Refund, End now; offline Awaiting payment → Mark as paid, End now; …). The count is asserted.
  - Evidence is present only when disputed, with its positive pair.
  - **The empty case:** a legacy deal opened by id → the read-only view with no actions.
- E2E:
  - `deal page: Approve puts them live and the timeline moves from "Not yet" to the live date`;
  - `deal page: End now asks, then takes them off the public page`;
  - `deal page: Refund (offline) records it, no card copy` (the confirm text for offline does not mention a card).
- Smoke: `"sd hub &deal=<id> renders the deal page"`.
- Regression: `payments-hardening.spec.ts` (evidence pack route path change).

**Steps:**
- [ ] 1. Invoke frontend-design. Write the tests. Run VERIFY (FAIL), then implement, then VERIFY again. Run TSC. Run i18n gen and check.
- [ ] 2. Mutate: render Refund for complimentary. Killer: the action-set test. Restore.
- [ ] 3. Commit `feat(sponsors): the deal page — a timeline and only the actions that apply`.

### Task 18: Packages become a price list; the transitional UI goes

**Files:**
- Create: `apps/web/src/components/sponsors/package-list.tsx`
- Delete: `apps/web/src/components/sponsor-packages.tsx` and `apps/web/src/components/__tests__/sponsor-packages-picker.test.tsx`
- Modify: `apps/web/src/app/o/[orgSlug]/sponsors/page.tsx`
- Modify: dictionaries ×4 (`sponsors.hub.tab.packages`: "Packages and orders" → "Packages" in en; es, fr and nl translated; the `sponsors.order.*` keys that are no longer read are removed)
- Modify: `apps/web/content/help/sharing/{sponsors.md,sponsors-hub.md}`
- Test: `apps/web/src/components/sponsors/__tests__/package-list.test.tsx`; update `apps/web/e2e/sponsors-hub.spec.ts` and `scripts/smoke/suites/sponsors.ts`

**Acceptance (mockup screen 4):**
- Each package is a card: name, price, tier, scope ("Any competition" or the competition), "On stream" when included, and "Used by N sponsors" (N = `used_by`; N=0 reads "Not used yet").
- "Create package" opens a `Modal` with today's fields, plus the On stream toggle.
- "Retire" stays (today's confirm copy).
- The orders list is gone: deals live on the Sponsors tab. The Packages tab is offered to editors on every plan (community included).
- The help pages describe sponsor first, then deal, then payment, with the three payment methods and three go-live rules. Remove "start an order with the sponsor's name and email".

**Tests:**
- Unit:
  - The card shows "Used by 2 sponsors" from `used_by: 2`; "Not used yet" at 0 (the empty case first).
  - The create sheet POSTs `includes_on_stream`.
  - A community editor sees Create.
- E2E:
  - `sponsors-hub.spec.ts`'s "the sell console moved to Packages and orders" becomes `Packages is a price list` (label "Packages", testid `sponsor-package-list`);
  - add to `sponsor-deals.spec.ts`: `a package's "used by" count follows its deals`.
- Smoke: `"sp hub Packages tab renders the sell console"` becomes `"sp hub Packages tab renders the price list (sponsor-package-list)"`. The free org's `"Packages tab answers 200"` now asserts the price list too.
- Regression: the help-copy-truth test (if it pins tab names); `retired-plan-copy.test.ts`.

**Steps:**
- [ ] 1. Invoke frontend-design. Write the tests. Run VERIFY (FAIL), then implement, then VERIFY again. Run TSC. Run i18n gen and check.
- [ ] 2. Mutate: `used_by` counts ended deals. Killer: Task 4's count case, re-run here. Restore.
- [ ] 3. Commit `feat(sponsors): Packages is a price list; orders now live on each sponsor as deals`.

### Task 19: The screens walkthrough and the width sweep (this batch owns its walkthrough)

**Files:**
- Modify: `apps/web/e2e/sponsor-deals.spec.ts` (the walkthrough block), `apps/web/e2e/mobile.spec.ts` (the console routes sweep gains `sponsorHref(org, seededSponsor)` and `dealHref(…)`, seeded in its setup)

**Acceptance:**
- **Golden path, once, fresh org, through the UI only:** add sponsor → Add deal (offline, when paid) → Mark as paid → public page → End now → gone.
- **Then break it:** an empty name is refused; double-submit Save deal → one deal; the back button from the deal page lands on the sponsor page, then on the list; a viewer opens the sponsor page read-only.
- **Widths:**
  - at 320, 768 and 1280 the list, the sponsor page, the sheet and the deal page have no sideways scroll;
  - the control SET (membership, order, repeats) of each row at 320 equals 1280's, with the fold opened;
  - a 43-character name truncates and never breaks mid-word.
- Screenshots go to `--output=<scratch dir>`. Per-screen verdicts go on the :8765 sign-off page; no PNG is committed.

**Tests:**
- E2E: the above, plus `mobile.spec.ts` "console routes: no horizontal scroll" at all seven widths.
- Smoke: n/a (Tasks 13 and 17).
- Unit: n/a.
- Regression: `mobile.spec.ts` is serial, so treat its red count as a floor (AGENTS.md class 21).

**Steps:**
- [ ] 1. Invoke frontend-design. Write the walkthrough. Dispatch E2E. Collect the screenshots from the CI artifacts.
- [ ] 2. Publish per-screen verdicts to the :8765 sign-off page and hand back for owner sign-off.
- [ ] 3. Commit `test(sponsors): screens walkthrough and seven-width sweep for sponsor deals`.

---

# PR 3: Invoices (`feat/sponsor-deals-invoices`)

### Task 20: Invoice numbers, invoice details and the token (loud migration)

**Files:**
- Create: `db/migration/deltas/V<n>__sponsor_invoices.sql`, `apps/web/src/server/sponsors/invoice-number.ts`
- Modify: `apps/web/src/server/usecases/sponsor-deals.ts` (`createDeal` allocates a number for online and offline)
- Modify: `apps/web/src/lib/sponsor-deals.ts` (add `formatInvoiceNumber`)
- Test: `apps/web/src/server/sponsors/__tests__/invoice-number.test.ts`, `apps/web/src/server/sponsors/__tests__/invoices-migration.test.ts`

**Interfaces:**
```ts
// schema: sponsor_invoice_counters(org_id uuid pk → organizations on delete restrict, last_number int not null check (last_number >= 0)),
//   RLS enabled+forced, tenant policy, grant select, insert, update to app_user;
//   sponsor_orders.invoice_number int null, unique (org_id, invoice_number);
//   sponsor_orders.invoice_token_hash bytea null, unique;
//   organizations.sponsor_invoice_address text null, organizations.sponsor_invoice_bank_details text null;
//   policy sponsor_orders_prune gains `and invoice_number is null` (a numbered invoice is never deleted).
export async function allocateInvoiceNumber(tx: Tx, orgId: string): Promise<number>; // upsert … last_number + 1 returning
export function formatInvoiceNumber(n: number): string; // "SP-" + padStart(4,"0"); 12345 → "SP-12345"
```

**Acceptance:**
- Numbers are allocated inside `createDeal`'s transaction, so a rolled-back create leaves the counter unmoved.
- Complimentary deals get none.
- Legacy rows get none (the header says so).

**Tests:**
- Unit (DB): `invoice-number.test.ts`.
  - **Empty case first:** the first number for a new org is 1.
  - Interleaving org A and org B → A: 1, 2, 3 and B: 1, 2.
  - 10 concurrent allocations for one org → exactly the set {1..10} (the race).
  - A rolled-back allocation → the next is still the same number.
  - A numbered draft deal cannot be deleted by `app_user`; its twin, an unnumbered draft, can (the prune fence).
  - `formatInvoiceNumber` at 1, 9999 and 12345.
- Unit (DB): `invoices-migration.test.ts` (by suffix): the constraint names, each with an accepted twin. RLS: org A cannot read org B's counter.
- E2E, smoke: Task 24.
- Regression: `deals-migration.test.ts`, `sponsor-order-delete-guards.test.ts`.

**Steps:**
- [ ] 1. Write the tests. Run VERIFY (FAIL), then implement, then VERIFY again. Run TSC.
- [ ] 2. Mutate: allocate outside the transaction. Killer: the rollback case. Restore.
- [ ] 3. Commit `feat(db): per-org sponsor invoice numbers and invoice details`.

### Task 21: "Sponsor invoices" details in Settings → Payments

**Files:**
- Create: `apps/web/src/components/org-sponsor-invoice-details.tsx`
- Modify: `apps/web/src/app/o/[orgSlug]/settings/connect/page.tsx`, `apps/web/src/app/api/orgs/[id]/route.ts` (`orgPatchSchema` gains `{ sponsor_invoice_address: z.string().max(1000).nullable() }` and `{ sponsor_invoice_bank_details: z.string().max(2000).nullable() }`, strict, the same arm shape as `payment_instructions`)
- Dictionaries ×4: `settings.sponsorInvoices.*`
- Test: `apps/web/src/app/api/orgs/[id]/__tests__/route.test.ts` (extend), `apps/web/src/components/__tests__/org-sponsor-invoice-details.test.tsx`

**Acceptance:**
- The card has two plain textareas ("Address on invoices", "Bank details for offline invoices") with the hint "Printed on every sponsor invoice. Online invoices also carry a pay link." Saved with the same guard as `payment_instructions`.
- It renders on every plan.

**Tests:**
- Unit: the PATCH accepts each arm; it refuses an unknown key; null clears.
- Unit (island): it opens at the stored values; saving sends only the changed field.
- E2E: `apps/web/e2e/walkthrough/sponsor-invoices.spec.ts`, `invoice details save on Settings → Payments and appear on the next offline invoice` (Task 24's walkthrough).
- Smoke: `"sd settings Payments renders the Sponsor invoices card"`.
- Regression: `app/api/orgs/[id]/__tests__/route.test.ts`'s existing arms; `settings-org-tabs.spec.ts`.

**Steps:**
- [ ] 1. Invoke frontend-design. Write the tests. Run VERIFY (FAIL), then implement, then VERIFY again. Run TSC. Run i18n gen and check.
- [ ] 2. Mutate: the strict arm is loosened to `.passthrough()`. Killer: the unknown-key case. Restore.
- [ ] 3. Commit `feat(settings): sponsor invoice address and bank details on Payments`.

### Task 22: The invoice document, as a page, a PDF and pay-on-demand

**Files:**
- Create: `apps/web/src/server/sponsors/{invoice-doc.ts,invoice-pdf.ts}`, `apps/web/src/components/sponsors/invoice-view.tsx`, `apps/web/src/app/(public)/r/sponsor/invoice/[token]/{page.tsx,not-found.tsx}`, `apps/web/src/app/(public)/r/sponsor/invoice/[token]/pdf/route.ts`, `apps/web/src/app/(public)/r/sponsor/invoice/[token]/pay/route.ts`, `apps/web/src/app/api/v1/orgs/[id]/sponsor-deals/[dealId]/invoice.pdf/route.ts`
- Modify: `apps/web/src/lib/scrub-score-url.ts` (the token after `/r/sponsor/invoice/`), and the `SECRET_PATH_ROUTES` verdicts in `apps/web/src/lib/__tests__/scrub-path-secrets.test.ts`
- Dictionaries ×4: `sponsors.invoice.*` (document labels: Invoice, Number, Date, Billed to, From, Description, Amount, Paid, Unpaid, Pay by card, Bank details, the expired or invalid link page)
- Test: `apps/web/src/server/sponsors/__tests__/{invoice-doc.test.ts,invoice-pdf.test.ts}`, `apps/web/src/app/(public)/r/sponsor/invoice/[token]/__tests__/{page.test.tsx,route-shape.test.ts}`

**Interfaces:**
```ts
export interface SponsorInvoiceDoc { number: string; issuedOn: string; org: { name: string; address: string | null; logoPath: string | null };
  billedTo: { name: string; email: string | null }; line: { description: string; amountCents: number; currency: string };
  state: "paid" | "unpaid" | "refunded" | "void"; method: PaymentMethod; bankDetails: string | null; payable: boolean; locale: Locale }
export async function invoiceDocByToken(token: string): Promise<SponsorInvoiceDoc | null>;   // hash lookup (hashReportToken), privileged sql
export async function invoiceDocForDeal(auth: AuthCtx, dealId: string): Promise<SponsorInvoiceDoc>;
export async function invoicePdf(doc: SponsorInvoiceDoc): Promise<Buffer>;                   // pdfkit; resolveLogo + MARGIN from server/doc-render.ts
export async function payInvoice(token: string, origin: string): Promise<string>;            // Checkout url: reuse unexpired, else mint (Task 7's rule)
```

**Acceptance:**
- **The state.** `paid` when `payment_status='paid'`; `refunded`; `void` when the deal ended unpaid; else `unpaid`.
- **Payable.** True only for online, unpaid, non-ended deals.
- **Bank details.** Printed for offline. Also printed for online when set (a sponsor may transfer).
- **The line.** "<package name> sponsorship — <scope or 'All competitions'>".
- **Language.** The org's `default_locale`.
- **The page** follows PR A's `/r/sponsor/[token]/page.tsx` contract exactly:
  - `force-dynamic`, noindex, nofollow, no referrer;
  - `publicRateLimit` BEFORE the lookup;
  - an unknown, rotated or malformed token is the same opaque 404;
  - `ph-no-capture` on the painted token.
- **The routes.** The PDF route returns `application/pdf` with `Content-Disposition: attachment; filename="<number>.pdf"`. The pay route is POST only (303 → Checkout); it refuses with 409 a non-payable invoice and never mints.
- **The console route** `GET /sponsor-deals/{id}/invoice.pdf` is "read" auth.

**Tests:**
- Unit (DB): `invoice-doc.test.ts`.
  - **Empty case first:** an unknown token → null.
  - Online unpaid → payable, no bank details unless set.
  - Offline → bank details, not payable.
  - After the webhook pays → `paid`, not payable.
  - After a refund → `refunded`.
  - Ended unpaid → `void`.
  - Complimentary has no token at all.
  - Rotated (Task 23 resend) → the old token → null, the new one → the doc.
- Unit: `invoice-pdf.test.ts` (pdfkit text extraction, as in `scorer-sheet-pdf.test.ts`): the PDF text contains the number, the org name and address, the amount, and "Unpaid", "Paid" or the bank details per state. Each state is asserted, 4 counted.
- Unit: `page.test.tsx` and `route-shape.test.ts`, modelled on PR A's `/r/sponsor/[token]` tests: the throttled screen, the opaque 404, and the metadata robots.
- Unit: the `scrub-path-secrets` verdict for `/r/sponsor/invoice/[token]`, `/pdf` and `/pay`.
- **Money:** the pay route reuses an unexpired session (one `create` call across two POSTs), and refuses when paid.
- E2E: the Task 24 walkthrough.
- Smoke:
  - `"sd invoice page 404 for an unknown token"`;
  - `"sd invoice pdf is application/pdf for a real token"` (the token minted through `POST …/send-invoice` on an offline deal with an email, after Task 23);
  - `"sd pay refuses a paid invoice (409)"`.
- Regression: `proxy-matcher.test.ts`, `routes.test.ts`, `scrub-path-secrets.test.ts`, `sentry-replay-guard.test.ts`.

**Steps:**
- [ ] 1. Invoke frontend-design (for `invoice-view.tsx` and the PDF layout). Write the tests. Run VERIFY (FAIL), then implement, then VERIFY again, including the regression scans. Run TSC. Run i18n gen and check.
- [ ] 2. Mutate:
  - `payable` ignores the paid state. Killer: the pay-refuses case.
  - The 404 leaks "revoked" vs "unknown". Killer: the opaque case.
  - Restore after each.
- [ ] 3. Commit `feat(sponsors): numbered invoice page and PDF; pay by card from the invoice`.

### Task 23: Invoice emails, resend for offline, and the club's "paid" notice

**Files:**
- Modify: `apps/web/src/lib/email.ts` (`sponsorInvoiceEmail` gains the number, the invoice URL, and an optional pay sentence; the offline variant carries the bank details line)
- Modify: `apps/web/src/server/usecases/sponsor-deals.ts` (`sendDealInvoice` handles offline with an email; it mints or rotates the token and stamps `invoice_sent_at`. For offline, `invoice_sent_at` is informational only, and `deal_status` is unchanged)
- Modify: `apps/web/src/server/usecases/sponsors.ts` (`handleSponsorPaymentSucceeded` queues `sponsor_deal_paid` in the same transaction)
- Modify: `apps/web/src/server/email-outbox/{constants.ts,hooks.ts}` (the new kind `sponsor_deal_paid: { to: "account", transactional: false }`)
- Add a delta `db/migration/deltas/V<n>__email_outbox_sponsor_deal_paid.sql`. It redefines `email_outbox_kind_valid` by restating the LAST definer's full list plus the new kind, and is found by suffix.
- Modify: `apps/web/src/components/sponsors/{deal-page.tsx,sponsor-list.tsx}` (Resend invoice is offered for offline deals with an email)
- Test: `apps/web/src/server/usecases/__tests__/sponsor-invoice-email.test.ts`; update `apps/web/src/server/email-outbox/__tests__/{outbox-schema.test.ts,outbox-kind-sweep.test.ts,enqueue-once.test.ts,_kind-senders.ts}`

**Acceptance:**
- The email links `<origin>/r/sponsor/invoice/<token>`, NOT a Checkout URL. Pay happens on the invoice page (D14).
- Resend rotates the token: the new hash is stored, and the old link 404s. The deal page copy says "The new email replaces the earlier link."
- `sponsor_deal_paid` goes to the org owner (`orgOwnerRecipient`) in the owner's locale, once per payment intent (`onceKey("sponsor_deal_paid","sponsor_order",intentId)`). The body names the sponsor and the amount, and says either "They are live now" or "Approve the deal to put them live" (`on_approval`), linking `dealHref`.
- No email for offline mark-paid, offline refund or complimentary (D13).
- **Trap (implementer memory):** `allowlistLengthFor` goes negative for a kind with no `send*` → add it to the exclusion list beside `KINDS_BEFORE_PHASE_3`.

**Tests:**
- Unit (DB): `sponsor-invoice-email.test.ts`.
  - **Empty case:** offline with no email → `sendDealInvoice` answers 422 `no_billing_email`, and no row is queued.
  - Online → the body contains the invoice URL and no `checkout.stripe.com`.
  - Offline → it contains the bank details and no pay sentence.
  - Resend → 2 rows; the first token no longer resolves.
  - The payment webhook through `runEvent` → exactly one `sponsor_deal_paid` to the owner, in the owner's locale (an `fr` owner on an `nl` org gets `fr`). A replay → still one.
- Update the outbox suites: `SPEC_KINDS` and the counts move by one. The `outbox-kind-sweep` REAL-PRODUCER scenario for `sponsor_deal_paid` drives `runEvent`.
- E2E: Task 24.
- Smoke: `"sd offline invoice email queued with the invoice link"` (read back from `email_outbox` through `smokeDb`).
- Regression: `sponsor-outbox.test.ts`, `a-kind-body.test.ts`, `no-second-path.test.ts`.

**Steps:**
- [ ] 1. Write the tests and update the outbox suites. Run VERIFY (FAIL), then implement, then VERIFY again on the new test and the four outbox suites. Run TSC. Run i18n gen and check.
- [ ] 2. Mutate:
  - Resend keeps the old hash. Killer: the rotation case.
  - The paid notice is queued outside the transaction. Killer: a replay double. Restore.
- [ ] 3. Commit `feat(sponsors): invoice emails link the numbered invoice; clubs hear when a sponsor pays`.

### Task 24: The invoices walkthrough (sandbox), smoke and help

**Files:**
- Create: `apps/web/e2e/walkthrough/sponsor-invoices.spec.ts`
- Modify: `scripts/smoke/suites/sponsorDeals.ts`, `apps/web/content/help/sharing/sponsors.md` (an "Invoices" section: numbering, where the details live, pay by card, offline bank transfer)

**Acceptance:**
- **Pro, golden path:** Add deal online (when paid) → the outbox row's invoice URL → open the page → "Pay by card" → Stripe SANDBOX Checkout (test card `4242 4242 4242 4242`, the existing walkthrough's helpers) → a signed webhook → the deal is live → the invoice page shows PAID → the PDF reads "Paid".
- **Community:** Settings → Payments details → an offline deal with an email → the invoice page shows the bank details and no pay button. Then Mark as paid → the page shows PAID.
- **Break it:** a paid invoice's Pay → 409 screen. A rotated link → 404 page. At 320: the invoice page has no sideways scroll.
- The skip conventions follow `settings-sponsor-monetize.spec.ts` (no `sk_test_` key, or no `STRIPE_CONNECT_TEST_ACCOUNT` → a counted, visible skip, never a silent green).

**Tests:**
- E2E: the walkthrough above, with screenshots to `--output` and verdicts on :8765.
- Smoke: Task 22 and 23's rows land in `sponsorDeals.ts`.
- Unit: n/a.
- Regression: the PR 1 and 2 specs stay green on the dispatch.

**Steps:**
- [ ] 1. Write the walkthrough. Update the help page. Dispatch E2E. Hand back with per-screen verdicts.
- [ ] 2. Commit `test(sponsors): invoices walkthrough against the Stripe sandbox`.

---

## 8. Spec coverage

| Spec | Task(s) |
|---|---|
| §2.1 sponsor first, no selling on add | 14 (the add form), 5 (no-deal = manual) |
| §2.2 package as a price list entry, scope, includes | 4, 18 |
| §2.3 a deal = sponsor × package × scope, created from the sponsor | 6, 15, 16 |
| §2.4 payment methods | 6 (offline, complimentary), 7 (online) |
| §2.5 go-live rules | 2, 6, 8 |
| §2.6 apply, switch off, no duplicates | 5, 8, 9, 11 |
| §2.7 one status and a timeline | 2, 13, 14, 17 |
| §4 anti-goals | 8 (S1 count, source guard), 6 and 8 (approval), 11 (I2, I6, I7), 6 (community offline) |
| §5.1 model, loud migration, history kept | 1 (D1, D4, D6) |
| §5.2 status table and exits | 2, 6, 7, 8, 9 |
| §5.3 apply in one transaction; the webhook stops inserting | 5, 8 |
| §6.1–6.5 screens | 14, 15, 16, 17, 18, 19 |
| §7 invoices | 20, 21, 22, 23, 24 (D10, D11, D12) |
| §8 plans | 3 (provisional), 4, 6, 16 |
| §8a rulings | one live (1, 5), locks (5, 12, 15), includes (1, 4, 16), scope (6, 16), ends (9, 16), visibility (5), no backfill (1) |
| §9 builder's calls | D1, D10, D12, D13, D20 |
| §10 open question | Task 3 (provisional), §11 Q1 |

## 9. Execution notes for the controller

- PR 1's tasks are sequential (one file set: `usecases/sponsors.ts` and `sponsor-deals.ts`). Batch Tasks 6 and 7 in one implementer pass only if the reviewer gate is kept per task (RULES.md batching rule: same files, inline).
- Every task runs implementer → reviewer → gap list, until clean. The reviewer answers TEST-STRATEGY's four questions in writing. For "another sport" the answer is "n/a: sponsors read no sport; checked another PLAN instead".
- Keep the SDD ledger in the MAIN checkout's `.superpowers/sdd/`, not in the worktree.

## 10. What this plan does NOT do

- It sends no sponsor self-serve shop, no recurring billing and no VAT (§3).
- It does not change how sponsors render on the strip, the stream or reports (R4). The only R4 touch is disabling a locked tick (Task 12).
- It adds no "deal live" email and no automatic reminders (D13).
- It adds no package editing and no hard delete (Retire stays).
- It does not allow two simultaneous placements for one sponsor (§8a).

## 11. Open questions for the owner

1. **(§10, provisional in Task 3.)** Can a community package carry a tier? Today's gate also blocks community from scoping a sponsor to one competition, so under the provisional default every community deal is **Partner AND org-wide**. If the answer is "tiers yes", say also whether community tiers should SHOW on public pages (today the strip collapses to Partner without `sponsors.tiers`). That is a second switch, in R4's renderer.
2. **(D12.)** Should sponsor invoice bank details be separate from the registrants' "offline payment instructions"? The plan keeps them separate. Recommendation: separate, because the registrant text is written for players ("pay at the desk") and would print on a formal invoice.
3. **(D9.)** Once all of a sponsor's deals have ended, should the club be able to switch the sponsor back on by hand (as with a no-deal sponsor)? The plan says yes. The alternative is "only through a new deal", which would make a refunded sponsor un-showable without a fresh complimentary deal.
