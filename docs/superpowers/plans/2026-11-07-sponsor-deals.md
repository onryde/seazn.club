# Sponsor Deals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A club adds a sponsor once (name, logo, link), then gives it a package as a *deal* (paid online, offline, or complimentary) that goes live by the club's chosen rule. From then on the deal decides what the sponsor row shows. The webhook no longer decides it, and no second sponsor row ever appears.

**Architecture:** `sponsor_orders` stays the table, and each row is one deal. It gains the deal's lifecycle, its go-live rule, a snapshot of the package and the scope, and a timestamp for each step. Its money columns stay as they are. A pure, client-safe module (`lib/sponsor-deals.ts`) owns every transition, chip and action rule. ONE server function (`applyDealsToSponsor`) owns every write to a deal-governed sponsor's status, tier, scope and on-stream flag. Every path that moves a deal ends by calling it: the console routes, the Stripe webhook, disputes, refunds and the hourly sweep. Invoices are Seazn's own numbered documents (an HTML page plus a pdfkit PDF), paid through the existing Connect destination-charge Checkout.

**Tech Stack:** Next 16 App Router (read the relevant guide in `node_modules/next/dist/docs/` before any route work), TypeScript 7, postgres.js with Flyway deltas, zod 4, Stripe (Checkout, destination charges), pdfkit, the email outbox, the Cloudflare cron Worker (`apps/cron-worker`), vitest (node env) with fast-check, and Playwright.

**Spec:** `docs/superpowers/specs/2026-11-01-sponsor-deals-design.md`. Read §5 (model), §6 (screens), §8a (rulings) and §10 (open). The mockups are layout only, and the build uses the house theme: `~/seazn-artifacts/2026-11-01_sponsor-deals-mockups_6472cb56/index.html`, served at `http://127.0.0.1:8765/2026-11-01_sponsor-deals-mockups_6472cb56/index.html`.

---

## 0. Before any task runs

- **R4 PR A (`feat/r4-sponsors`) has merged to main.** Every path here is main's tree, re-pinned by the pre-flight at main @ `3177614179` (PR A merged; §1a). That includes the hub at `/o/:slug/sponsors`, `lib/sponsor-tiers.ts`, `sponsors.on_stream`, `server/sponsors/*` and the report links.
- Each PR gets its own worktree off main (`superpowers:using-git-worktrees`). Never check out in the main checkout. Never `git stash`. Rebase, never merge main in.
- **Re-pin every line number on the first read.** The line cites below (`:nnn`, and the few `~Lnnn` left) are main @ `3177614179` (PR A merged), taken from the pre-flight's re-pin on 2026-11-09. Main keeps moving, so a plan line number is still a hypothesis.
- Migration numbers are NEVER hard-coded. Each delta is named `V<n>__<suffix>.sql`, where `<n>` is the next free number above main's max **at merge time**. Tests find a delta by suffix regex only (PR A's pattern: `/^V\d+__sponsor_rotation\.sql$/`). A renumber before merge is then a pure `git mv`. **Numbering at merge (F26):** main's max is V492 at `3177614179`, and open branches already hold V493 (`feat/quick-match-surfaces`) and V497 (`feat/swiss-auto-advance`). Flyway runs without outOfOrder, so if this PR takes V498+ and merges before V497 lands, V497 is stranded. Pick the number at merge time and coordinate with those branches then.

## 1. Decisions this plan makes

These are the spec's "left to the builder" items (§9), plus the gaps found while planning. Each one is a decision, recorded once. The tasks implement them and never re-decide them.

| # | Decision | Why |
|---|---|---|
| D1 | **Keep the table `sponsor_orders`, with one row per deal.** The money column `status` keeps its meaning (the API exposes it as `payment_status`). | V299/V300 FKs and policies, the dispute recovery's `sponsor_order_id` reversal metadata, the outbox refs `sponsor_order/<id>`, the competition-delete guard and about 15 test files key on the name. A rename buys the user nothing (§9 lets the builder choose). |
| D2 | **Two axes.** A new `deal_status` holds the lifecycle: `draft · awaiting_payment · awaiting_approval · scheduled · live · ended`. Money stays in `status`: `pending · paid · failed · refunded`, plus the new `none` for complimentary. | "Live · awaiting payment" (§5.2) is both at once, so one column cannot hold it. `scheduled` means every condition of the rule is met but the sponsor already has a live deal (§8a queue). The spec's "Paid" chip is derived, not stored. |
| D3 | **At most one live deal per sponsor,** held by a partial unique index (§8a). | A guard in the database, not in a comment. |
| D4 | **Snapshot at creation:** `tier`, `includes_on_stream`, `package_name`, `competition_id` (the deal's scope; null means the whole org), plus the existing `amount_cents` and `currency`. | §5.1: a later package edit never moves a deal. |
| D5 | **`ends_at` is added; `starts_at` is not.** `ends_at`'s producer is the Add deal sheet's optional "Ends on", offered when the scope is the whole org. A competition-scoped deal with no `ends_at` ends when the competition's derived phase is `finished` (§8a). Dropping `starts_at`, which spec §5.1 lists, is a sanctioned deviation: PR 1's body records it under "Deviations" (F34, Task 12). | No screen sets a start date (the mockups have none). The only delayed start is the §8a queue, and `scheduled` carries it. A `starts_at` with no producer would be an inert seam. |
| D6 | **Legacy rows.** The migration rewrites every existing order into an explicit ENDED deal (`ended_reason = 'legacy'`) and leaves its money columns untouched. `applyDealsToSponsor` ignores legacy rows. | §5.1 says keep the dispute and refund history, and §8a says no backfill into deals. Explicit values replace a compatibility branch (the owner's loud-migration rule). |
| D7 | **The one owner is `applyDealsToSponsor(tx, sponsorId, actor)`.** The webhook stops inserting sponsors (§5.3). | Root cause fixed once (TEST-STRATEGY rule 8). |
| D8 | **Visibility, empty case first.** A sponsor with no non-legacy deal: no change (manual control, §8a "1 Ok"). A live deal: the sponsor takes the deal's snapshot, and its status is `active`, or `pending` while the live deal is parked by a dispute. Open deals only: status `inactive` (hidden until live). All deals ended: `inactive`, tier `partner`, scope null, on_stream false (the mockup: "Tier, page and stream switched off"), written **only on the transition** into all-ended, that is, when this apply's caller ended the last live or open deal. An apply that finds every deal already ended writes nothing (`no_deals` semantics), so a late event on an old deal (a dispute created or closed, a refund of an ended deal) never clobbers the club's hand switch-back-on (F7). | §8a visibility ruling. The mockup's "Tier now Partner" after a deal ended. Spec §10 Q3 grants the hand switch-back-on. |
| D9 | **What a deal locks (§8a).** While the sponsor has a live deal, a PATCH of `tier`, `competition_id`, `on_stream` or `status` answers 409 `sponsor_locked_by_deal`. While it has an open, non-live deal, a PATCH of `status` answers 409. Name, url and logo are always editable. Once every deal has ended, the sponsor is back under manual control, as a no-deal sponsor is. `patchSponsor` takes its own unconditional sponsor lock to enforce this (F16). | The anti-goal "live without the rule met". The all-ended case is owner-confirmed 2026-11-07 (spec §10 Q3; §11). |
| D10 | **Invoice mechanism: Seazn's own numbered invoice plus the existing Checkout,** not Stripe Invoicing (§7). | (a) An offline invoice on a community org has no Stripe account to issue it from. Seazn's document is one document and one numbering for both kinds. (b) With destination charges, a Stripe invoice is issued by the PLATFORM account, so it cannot carry a per-club sequence or the club as issuer. (c) Stripe Invoicing adds its own per-paid-invoice fee on top of card fees. (d) The destination charge, application fee, refund and dispute rail already exist and are hardened (`startSponsorCheckout`, `handleSponsorDispute`). Cost: Seazn renders the document. |
| D11 | **Invoice numbers run per org** from a counter table, allocated when an online or offline deal is created, and shown as `SP-0001`. A numbered deal can never be deleted (prune policy fence), so deleting a sponsor that has one answers 409, never a 500 (F10, Task 20). | §7: per org, in sequence, never reused. A numbered deal is history. |
| D12 | **The address and bank details for invoices** are new plain-text columns `organizations.sponsor_invoice_address` and `sponsor_invoice_bank_details`, edited on **Settings → Payments** in a "Sponsor invoices" card, on every plan. Owner-confirmed 2026-11-07 (spec §10 Q2: a separate setting). | §9 leaves the place open. The existing `organizations.payment_instructions` is Markdown written TO REGISTRANTS ("pay cash at the desk"), a different fact that must not print on a formal invoice. No org address column exists today. |
| D13 | **Emails.** Reuse kind `sponsor_invoice` for online and offline invoices (same facts: literal address, not transactional). `sponsor_receipt` and `sponsor_refund` are unchanged. ONE new kind, `sponsor_deal_paid`, goes to the org owner (an account) on an online payment, because it is what tells an "After I approve" club to act. There is no "deal live" email (optional in §9, so cut). There are no "Live · awaiting payment" reminders: the chip plus Resend invoice are the reminder (§9: "keep them minimal"). | Smallest set that serves the approval flow. |
| D14 | **A pay link never dies, and never doubles.** The invoice email links a durable invoice page, and its Pay button mints Checkout on demand. A session is stored on the deal and **reused while it has more than 10 minutes left**. **Before any re-mint, and before an online deal is deleted or ended, the stored session is retrieved and expired if it is still open**, outside any transaction (F3). An open session that cannot be expired stops the action: no mint, and `deleteSponsor` answers 409. So two payable sessions never coexist. One function, `ensureDealCheckout` (Task 7), holds the reuse-or-expire-and-mint rule; PR 1's Resend and PR 3's Pay both call it (F32). If a second, different intent still succeeds on an already-paid deal, the webhook raises an owner alert and records a refundable row, never just a log line (Task 8). | Today a Checkout link expires in 24 h. Today's own copy admits "Both payment links stay payable — the sponsor could pay twice" (`sponsors.order.dupConfirm.body`). Without the expire step, a re-mint leaves two payable sessions for up to 10 minutes, and a deleted deal's open session takes money that lands nowhere (`if (!order) return`, `server/usecases/sponsors.ts:644`). |
| D15 | **Screens are one DOM and URL-driven.** `?tab=sponsors&sponsor=<id>` opens the sponsor page. On a phone it replaces the list (its own page, with a back link). At ≥md it is a right-hand side sheet over the list. `&deal=<id>` opens the deal page the same way. Add deal is a `Modal`. The phone "⋯" folds the row's own controls. It does not use `CardMenu`, which is link-only by design. | Option B (§6.2), the house "one DOM, branched" rule, and back-button-safe. |
| D16 | **API.** The `/sponsor-orders` routes are replaced by `POST /orgs/{id}/sponsors/{sponsorId}/deals` and `/orgs/{id}/sponsor-deals[/{dealId}[/<action>]]`. It is logged as a breaking change in `app/developers/changelog/page.tsx` and `docs/api-v1-breaking-changes.md` (no client outside the web app uses it yet, which is the repo's stated convention). | The POST body changes meaning (sponsor_id replaces a typed name), so it is breaking either way. |
| D17 | **Plans (§8).** Packages, offline deals, complimentary deals and the approval rule work on every plan. Online needs `sponsors.monetize`, scoped to the deal's competition, plus Connect. **Owner-confirmed 2026-11-07 (§10 Q1, "Ok"):** a tier other than partner, or a competition scope, needs `sponsors.tiers` (today's gate), isolated in Task 3. One predicate, `placementNeedsTiers`, serves sponsors, packages and deals: today's `assertTierAllowed` calls it (F14). | Owner-confirmed 2026-11-07. The owner's answers in spec §10 are binding. |
| D18 | **Competition delete** answers 409 while any non-legacy deal is scoped to that competition, or while a sponsor scoped to it has any non-legacy deal. | Otherwise the `sponsors.competition_id` cascade deletes a sponsor whose deals RESTRICT the delete, and the user sees a 500 (23503). The spec is silent on this. |
| D19 | **The invoice page lives at `/r/sponsor/invoice/<token>`.** The token is 32 random bytes, and only its hash is stored (PR A's `report-token.ts` pattern, reused by import). It is minted when a numbered deal is created and on an online send (Task 22, F9), and it rotates on Resend (Task 23). | It sits under PR A's `/r/sponsor/` prefix, which the scrubbers and the `/r/<ref>` carve-out already know. Hash-only matches the report links. |
| D20 | **The sweep is an hourly row** on the existing `TRIGGER_CRON`, inserted right after `funnel-remind` (F20). | An expired deal comes down within the hour, with no new trigger (the Free plan's 5-trigger cap). |
| D21 | **Every deal write is an editor action** (`requireOrgAuth(req, id, "write")`). Viewers read. | Same as packages and refunds today (R19). |
| D22 | **What the Add deal sheet opens at** (rule 19: pin the opening value). Payment opens at `online` when `hasMonetize && chargesEnabled`, else `offline`. Go-live opens at `on_payment`. Picking `complimentary` while go-live is `on_payment` moves go-live to `immediate`. Scope opens at the package's competition when it has one (locked), else the whole org. The billing email opens at this sponsor's most recent deal's `sponsor_email`, else empty. | Mockup notes (screen 3). |

## 1a. Pre-flight rulings (2026-11-09)

A reviewer pre-flight checked this plan against main @ `3177614179` (PR A merged). Its findings and rulings are in the main checkout at `.superpowers/sdd/2026-11-07-sponsor-deals/preflight.md` (§3 premise re-pin, §5 rulings). The controller accepted every ruling verbatim, so they are binding, and each one is folded into the task text named below. A task's text is complete on its own: an implementer never needs this list to find a ruling.

- **F1** (I). Every console deal write (create, send, mark-paid, approve, end, refund) awaits `expirePublicSponsors` after commit. `bustPublicSponsors` stays private in `usecases/sponsors.ts` for webhooks and disputes, and is not moved. Webhook and sweep paths keep `deferred`. `sponsors-public-expiry.test.ts` gains one case per console action. Landed in: §4, §7, Tasks 5, 6, 7, 8, 9.
- **F2** (I). One lock order everywhere: read the deal's `sponsor_id` without a lock, lock the sponsor, lock that sponsor's deals by `(created_at, id)`, then re-check. Plus a two-deals-one-sponsor concurrency test (no 40P01). Landed in: Tasks 5, 6, 7, 8, 9.
- **F3** (C, money). D14 "never doubles" made true: expire an open session before any re-mint, delete or end; `deleteSponsor` answers 409 while an open session cannot be expired; a second intent on a paid deal raises an owner alert and records a refundable row. Landed in: D14, Tasks 5, 7, 8, 9.
- **F4** (I). Task 1 makes all six `sponsor_orders` insert sites deal-shaped and names the files that stay red until Task 7. Tasks 4–6 VERIFY by `-t` and report that list instead of "failed 0". Landed in: §3, Tasks 1, 4, 5, 6, 7, 8, 10.
- **F5** (I). `seedSponsorOrder`: `paid` is a live online `on_payment` deal with its sponsor; `pending` is a sponsor plus an `awaiting_payment` online deal. Its two `pending` consumers are named. Landed in: Tasks 1, 8.
- **F6** (I). Five `sponsor-dispute-outbox.test.ts` cases that contradict D8/D9 are rewritten case by case. Landed in: Task 8.
- **F7** (I). Apply's all-ended write runs only on the transition into all-ended, so a hand switch-back-on survives late events. `patchSponsor` joins the model test and I2 is restated. Landed in: D8, Tasks 5, 8, 11.
- **F8** (I). Unnamed consumers that go red are added to their owning task's Files and VERIFY. Landed in: Tasks 4, 7, 8, 12, 18, 22.
- **F9** (I). Invoice-token minting moves into Task 22 (from `createDeal` and the online send). Task 23 keeps rotation on Resend and the offline email. Landed in: D19, §6, Tasks 22, 23.
- **F10** (I). A sponsor with a numbered deal answers 409 on delete, not a 500. Landed in: D11, Tasks 5, 20.
- **F11** (I). `createDeal` answers `{ deal, checkout_url }`; `SponsorDeal` stays URL-free. The picker and the smoke read it. Landed in: Tasks 6, 7, 12.
- **F12** (I). `DealRuleError` maps to `HttpError` at the usecase boundary (`illegal_transition` 409, `on_payment_needs_payment` 422). Every action refuses an action `allowedActions` does not offer, with 409, before any write. Landed in: Tasks 2, 6, 8, 11.
- **F13** (m). Task 23 owns the domain change that offers `resend_invoice` on offline deals with an email; `rowNextAction` keeps `mark_paid` for offline. Landed in: Task 23.
- **F14** (m). The owner's answers in spec §10 are binding: the "awaiting the owner" label is dropped from Task 3, the file map and the commit message, and §11 records the answers as given 2026-11-07. `assertTierAllowed` calls `placementNeedsTiers`. Landed in: D17, §2, §7, §8, §11, Task 3.
- **F15** (I). Task 2 types the full action table and the reachable set, with exact counts; the `rowNextAction` precedence is fixed; the unused `send_invoice` RowAction goes. Landed in: Task 2.
- **F16** (m). `patchSponsor` takes its own unconditional sponsor lock; the lock test runs on Pro plus one community 402-before-409 case; the delete guard counts legacy rows. Landed in: D9, Task 5.
- **F17** (m). Task 8's source guard reads "no insert into sponsors below the Webhook activation banner". Landed in: Task 8.
- **F18** (m). Legacy rows' refund, lost and dispute paths flip money columns only; PR 1's "Data changes" says a legacy-activated sponsor is no longer taken down by its legacy order's refund. Landed in: Tasks 8, 12.
- **F19** (m). The sweep also ends open deals past `ends_at` (expiring any open session) and never promotes a scheduled deal past its `ends_at`. Landed in: Task 9.
- **F20** (m). The cron JOBS row goes right after `funnel-remind`. Landed in: D20, Task 9.
- **F21** (m). `"/r/sponsor/invoice/"` precedes `"/r/sponsor/"` in `SECRET_PATH_ROUTES`; the scrub test asserts the token is gone. Landed in: Task 22.
- **F22** (m). `marked_paid_by` and `approved_by` are `on delete set null`. Landed in: Task 1.
- **F23** (m). The `sponsor-sheet` page assertion and its smoke row move from Task 13 to Task 15. Landed in: Tasks 13, 15.
- **F24** (m). `locked_by_deal` reaches the On stream tab through the page's field map and `OnStreamSponsor`. Landed in: Task 12.
- **F25** (m). Checkout success/cancel go to `routes.publicHub(slug)` (`/live/<slug>`), not `/shared/<slug>`. Landed in: Task 7.
- **F26** (m, process). Each delta is numbered at merge; V493 and V497 are held by open branches. Landed in: §0, §3, Tasks 1, 12 (PR body), 20, 23.
- **F27** (m). The deal page renders `allowedActions` in `DEAL_ACTIONS` order, then Evidence when disputed. Landed in: Task 17.
- **F28** (m). A live deal shows tier and scope read-only with `lockedNote`; "Tier now X. Y when the deal goes live" is for an open deal. Landed in: Task 15.
- **F29** (m). On community, the Add deal scope select disables the competitions, with the tier upgrade hint, via `placementNeedsTiers`. Landed in: Task 16.
- **F30** (m). Saving both invoice fields takes two sequential PATCHes; the unknown-key killer sends a valid arm plus `foo`. Landed in: Task 21.
- **F31** (m). The tier-CHECK sweep covers `sponsor_orders`, `lib/sponsor-tiers.ts` says three CHECKs, and a DB test pins the DB value sets to the TS constants. Landed in: Tasks 1, 2.
- **F32** (m). Task 7 extracts `ensureDealCheckout`; Task 22's `payInvoice` calls it. Landed in: D14, Tasks 7, 22.
- **F33** (m). Smoke deal rows create their own sponsor, never `goldId`. Landed in: Tasks 6, 7.
- **F34** (m, sanctioned). `starts_at` is dropped; PR 1's body records the deviation. Landed in: D5, Task 12.
- **F35** (m). The dispute audit reads the deal's `competition_id` snapshot, not the package's. Landed in: Task 8.
- **F36** (m). Task 11 adds an invariant (snapshot = package at creation) and scopes byte-equality to the sponsor tables. Landed in: Task 11.
- **F37** (m). Online mark-paid and End now retrieve the session first: complete → 409, expired → proceed, open → expire; never parse `expire` errors. Landed in: Task 7.

## 2. Premises checked against the tree (main @ 3177614179, PR A merged; re-pinned by the pre-flight 2026-11-09)

**True:**
- `handleSponsorPaymentSucceeded` inserts a new sponsor row, with name only, from the order (`server/usecases/sponsors.ts:633`, insert :654-662).
- `paid_order_id` is the only link back to the order (`listSponsorRows` :168, `paid_order_id` :171-173). It stays on `SponsorRow` (:64); its consumers are `server/api-v1/schemas.ts:5154` and `components/org-sponsors.tsx:37,372,508`.
- The "invoice" is a `sponsor_invoice` outbox email that carries a Checkout URL.
- There is no offline payment, no mark-paid and no approval step.
- The hub tabs are `overview, sponsors, on_stream, packages` (`lib/sponsors-hub.ts` `SPONSORS_TABS`). The Packages tab is labelled "Packages and orders" (`sponsors.hub.tab.packages`).
- `ensureOrgStreamSettings(tx, orgId, userId | null)` exists, and a webhook may call it with null.

**False or incomplete. Plan for the tree, not the spec:**
1. §8 "Sponsors, packages … community: yes". Today a community org **cannot create a package at all**: `createSponsorPackage` calls `requireFeature(…, "sponsors.monetize")`, and smoke pins `"sp free packages gated (402)"`. This programme reverses that row, loudly (Task 4).
2. §8 / §10 "tiers stay governed by `sponsors.tiers` as today". The same gate (`assertTierAllowed`, `server/usecases/sponsors.ts:123-131`, private, called at :194 and :246) also gates **competition scoping**. The owner's answer (spec §10 Q1, 2026-11-07) therefore makes community deals org-wide as well as Partner-only. The mockup's community example ("Silver Season for Season 2026/27") is unreachable under it. Task 3 makes `assertTierAllowed` call the one predicate (F14).
3. §5.2 "Dispute opened → hidden … today's park". Today only a FORMAL dispute (or `funds_withdrawn` after an inquiry) parks the placement; an inquiry leaves it live (owner, 2026-10-26). The plan keeps today's rule.
4. §7 "bank details the club enters once in settings". No such setting exists, and there is no org address column. The only offline text is the registrant-facing Markdown `payment_instructions` (D12).
5. §5.1 `starts_at` / `ends_at`. The mockups have no date fields, so neither has a producer as drawn (D5).
6. The mockups' "Competition or season". There are no seasons: scope is the org or one competition (§8a). Their includes list (website board, slideshow) is removed per §8a.
7. §6.1 "⋯ menu". The repo's `CardMenu` is link-only by design ("mutating actions belong on the page they navigate to"), so the plan folds the row's own controls instead (D15).
8. `sponsors.competition_id` is `ON DELETE CASCADE` (V283). A deal-scoped sponsor would be deleted with its competition. The spec is silent; D18 covers it.
9. Today's flow already carries a double-payment risk (two unexpired sessions for one sponsor), and the Checkout link dies after 24 h (D14).
10. The help pages `content/help/sharing/sponsors.md` and `sponsors-hub.md` describe "Packages and orders" and "start an order with the sponsor's name and email". They are owed updates (Tasks 18 and 24).
11. **PR A's late fix changed the console bust (F1).** `bustPublicSponsors` (:157) is private and `deferred` (= Next's `after()`, `lib/deferred.ts`); its only callers are `handleSponsorDispute`'s four branches. Organiser writes instead AWAIT `expirePublicSponsors` (:150-152 → `expireCompetitionShell`, `server/public-site/revalidate.ts:322`), used by create :212, patch :278, delete :288, reorder :309 and refund :793. The webhooks defer `fireOrgRevalidate` inline (:674-676, :846-848).
12. **`organizations.timezone` is NULLABLE** (`V305__org_timezone.sql`). The repo's fallback is `'UTC'` (`coalesce(…, o.timezone, 'UTC')`).
13. **`patchSponsor` (:217) locks the sponsor only for a `status` patch** (:256-262), and `assertTierAllowed` runs BEFORE its transaction (:240-246) (F16).
14. **Moved paths:** `components/ui/status-chip.tsx` (not `components/status-chip.tsx`); `apps/web/src/__tests__/proxy-matcher.test.ts` (not `lib/__tests__`); `apps/web/e2e/walkthrough/settings-org-tabs.spec.ts`. `routes.publicHub(slug)` builds `/live/<slug>` (`lib/routes.ts:98`); `/shared/<slug>` is gone.
15. **Six SQL insert sites seed `sponsor_orders` directly** (F4): `server/usecases/__tests__/_money-fixtures.ts:113`, `apps/web/e2e/payments-hardening.spec.ts:391`, `scripts/smoke/suites/p72.ts:277`, `server/usecases/__tests__/competitions-delete-money.test.ts:109`, `server/usecases/__tests__/dispute-unmatched-retry.test.ts:52`, `server/usecases/__tests__/sponsor-order-delete-guards.test.ts:69`.

## 3. Global Constraints

Every task's requirements include this section.

- **Dependency.** R4 PR A has merged (main @ `3177614179`, §0). Line cites are main's, re-pinned 2026-11-09.
- **i18n, 4 locales.** Every new or changed user-facing string goes into `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json` (namespaces `sponsors.deal.*`, `sponsors.dealSheet.*`, `sponsors.invoice.*`, `sponsors.pkg.*`). Then run `npm run i18n:gen-keys` at the root (it regenerates `apps/web/src/lib/i18n-keys.ts`, which is never hand-edited) and `npm run i18n:check` at the root. Never hardcode English, including in the invoice PDF and email bodies. A server refusal shown to a user is mapped to a key by STATUS, never by the server's sentence (`components/org-payment-instructions.tsx` pattern). Help pages (`apps/web/content/help/**`) are English-only.
- **Mobile-first, 320 / 768 / 1280.** No horizontal page scroll at any width. Wide content scrolls inside its own `overflow-x-auto`. One DOM, branched (`max-md:*`, `md:hidden`); never a second phone tree. `truncate` needs `min-w-0` on the whole ancestor chain. Test with a realistic name of 43 or more characters ("Harbourside Building Supplies and Timber Co"). A scrolling rail needs `tabindex="0"`, a role and an accessible name. Compare control SETS across widths, not box sizes. The seven-width `mobile.spec.ts` matrix is the backstop. Screenshots and per-screen verdicts go to the local sign-off server at :8765, never to artifacts. Evidence PNGs are never committed.
- **frontend-design.** Every task that changes markup or styles invokes the `frontend-design` skill (Skill tool) BEFORE touching markup. Match the existing design system: tokens, the `components/ui/status-chip.tsx` chip vocabulary, the hub's `HubPanel` and card styles, the spacing scale, and no one-off colours or classes. The task report names, for each change, the pattern or token it matched. The mockups are layout only.
- **Loud migration.** Each delta is `db/migration/deltas/V<n>__<suffix>.sql`, with `<n>` the next free number above main's max at merge (main's max is V492; open branches hold V493 and V497, so coordinate at merge, F26, §0). Its header must NOT self-name a version (`lib/__tests__/migration-header-truth.test.ts`: "if you name yourself, be right"), so it opens `-- sponsor_deals — …`. The header states what changes, what each legacy row becomes, and why. The migration `raise notice`s its row counts. The PR body carries a "Data changes" section, and the release note repeats it. There is no compatibility branch for old rows (D6).
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
  - **VERIFY:** `cd <abs worktree>/apps/web && npx vitest run --reporter=json --outputFile=<scratchpad>/t<N>.json <exact paths>; echo EXIT=$?`, then `jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests,files:[.testResults[].name]}' <scratchpad>/t<N>.json`. It passes only with EXIT=0, failed 0, every listed file present under the worktree, and `total` equal to the count you pinned. **The one exception is Tasks 4–6 (F4):** a regression file on Task 1's named known-red list runs only its named cases (`-t "<name>"`), and the task reports that known-red list instead of "failed 0". A red outside that list is a defect. From Task 7 on, the list is empty. Never trust rtk's summary. DB suites need `DATABASE_URL` for a migrated local test DB (the `seazn-local-env` skill). Local DBs lag main's migrations, so apply this PR's delta first.
  - **TSC:** write the throwaway `apps/web/tsconfig.changed.json` (extends `./tsconfig.json`, `noEmit`, `"types":["node","next"]`, `files` = the changed `.ts`/`.tsx`). Run `node ../../node_modules/typescript-native/bin/tsc -p tsconfig.changed.json; echo EXIT=$?`, then delete the file. Never commit it.
  - **OPENAPI:** before a commit that touches a route or `server/api-v1/*`, run `npm run openapi:gen && git status --porcelain`. It must show nothing new beyond the regenerated `openapi/v1.json`, which is committed.
  - **E2E:** `gh workflow run e2e.yml --ref <branch>` (read its `workflow_dispatch` inputs first; it is the only e2e signal before merge). Then hand back. Never poll CI.
  - **SMOKE:** runs in CI on the PR. Never run it locally against a local server.
- **Repo-wide scans a scoped run misses.** Add each to a task's VERIFY when the task trips it:
  - `lib/__tests__/pass-scoping-guard.test.ts` (DB). Every `requireFeature` or `hasFeature` call passes the competition when one is in scope.
  - `lib/__tests__/status-set-sweep.test.ts`, when a status literal set is touched.
  - `lib/__tests__/retired-plan-copy.test.ts` and the dictionary copy-truth test, for new copy.
  - `scrub-path-secrets`, `proxy-matcher` (`apps/web/src/__tests__/proxy-matcher.test.ts`) and `routes` tests, for a new `[token]` route.
  - `server/api-v1/__tests__/key-scopes.test.ts` (:228 requires every v1 route file to be classified), for a new v1 route. Sponsor routes go in `NEVER_KEY_ROUTES` (`server/api-v1/key-scopes.ts:341-357`).
  - `server/email-outbox/__tests__/{outbox-schema,outbox-kind-sweep,enqueue-once,_kind-senders}`, for a new outbox kind.
  - `lib/__tests__/e2e-ci-wiring.test.ts`, for a new spec.
  - `apps/cron-worker/test/schedule.test.ts`, for a new job.
- **Money.** Stripe is called OUTSIDE any SQL transaction, always with an idempotency key. Billing claims are verified against the Stripe SANDBOX (`sk_test_`), never assumed. Two payable Checkout sessions for one deal must never coexist: an open session is expired before any re-mint, delete or end (D14, F3).
- **Public-page expiry (F1).** A console (organiser) write awaits `expirePublicSponsors` after commit, never `deferred`. Webhooks, disputes and the sweep keep `deferred`. `bustPublicSponsors` stays private in `usecases/sponsors.ts`.
- **Lock order (F2).** Every deal writer reads the deal's `sponsor_id` without a lock, locks the sponsor `for update`, then that sponsor's deals `for update` ordered `(created_at, id)`, then re-checks the target deal's state.
- **Commits.** Use conventional commits, one red→green step each, ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## 4. Review Focus

These are the five inputs the spec implies but no screen draws. Each line names its owning test.

1. **A payment lands on a deal the club already ended,** or arrives after the sponsor was hidden. Expected: the money is recorded (`payment_status = paid`), the deal stays `ended`, the sponsor stays hidden, and the deal offers Refund. *Owner: Task 8, `late payment on an ended deal records money and changes nothing shown`.*
2. **Two editors press Approve, or Mark as paid, at the same moment** (or one double-taps). Expected: exactly one transition. The second call answers 409 (`deal_not_awaiting_approval` / `deal_already_paid`). One `live_at` is written, and the winning call awaits one in-request public expiry (`expirePublicSponsors`, F1). *Owner: Task 6, `concurrent approve: one transition, one 409`.*
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
| S7 The invoice token | `createDeal` (numbered deal) and the online send mint it → `invoiceDocByToken` | Task 22 drives the real `createDeal` and resolves the token it minted (F9); Task 23 adds rotation and the email that carries it. |

## 7. File map

**Create**
- `db/migration/deltas/V<n>__sponsor_deals.sql`: PR 1 schema (Task 1).
- `db/migration/deltas/V<n>__sponsor_invoices.sql`: PR 3 schema (Task 20).
- `apps/web/src/lib/sponsor-deals.ts`: the pure domain (vocabulary, transitions, actions, chips, labels, timeline). Client-safe; imports only `lib/sponsor-tiers.ts`.
- `apps/web/src/lib/sponsor-deal-policy.ts`: the placement predicate, owner-confirmed (spec §10 Q1) (Task 3).
- `apps/web/src/server/sponsors/deal-gates.ts`: the server gate over the predicate (Task 3).
- `apps/web/src/server/sponsors/deal-apply.ts`: `applyDealsToSponsor` only. It exports nothing bust-shaped: `bustPublicSponsors` stays private in `usecases/sponsors.ts` (F1).
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
- `apps/web/src/server/usecases/sponsors.ts`: webhook handlers, disputes, refund, the patch lock, the delete guard, list fields, `assertTierAllowed` (calls `placementNeedsTiers`, F14), `expirePublicSponsors` (exported, F1); `startSponsorCheckout` is removed.
- `apps/web/src/server/usecases/competitions.ts` (the delete guard, :905-918).
- `apps/web/src/app/api/v1/orgs/[id]/sponsor-packages/route.ts`.
- `apps/web/src/server/api-v1/{openapi.ts,schemas.ts,key-scopes.ts}`, and `openapi/v1.json` (generated).
- `apps/web/src/app/o/[orgSlug]/sponsors/page.tsx` and `_components/hub-chrome.tsx`; `apps/web/src/lib/sponsors-hub.ts`.
- `apps/web/src/components/{org-sponsors.tsx,sponsor-packages.tsx}`, `components/sponsors/on-stream-tab.tsx`, `components/modal.tsx` (a `placement` prop).
- `apps/web/src/lib/email.ts` (`sponsorInvoiceEmail`), `apps/web/src/server/email-outbox/{constants.ts,hooks.ts}`.
- `apps/web/src/app/o/[orgSlug]/settings/connect/page.tsx`, `apps/web/src/app/api/orgs/[id]/route.ts`.
- `apps/web/src/lib/scrub-score-url.ts`.
- `apps/web/src/lib/sponsor-tiers.ts` (header only: three tier CHECKs, F31).
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
- Create: `db/migration/deltas/V<n>__sponsor_deals.sql` (`<n>` picked at merge: main's max is V492, and open branches hold V493 and V497; coordinate then, F26)
- Test: `apps/web/src/server/sponsors/__tests__/deals-migration.test.ts`
- Modify (F4: this task owns every SQL insert into `sponsor_orders`; each becomes deal-shaped, with every deal column explicit):
  - `apps/web/src/server/usecases/__tests__/_money-fixtures.ts` (`seedSponsorOrder`, insert :113; the F5 shape below);
  - `apps/web/e2e/payments-hardening.spec.ts` (`seedSponsorRig` :374, insert :391);
  - `scripts/smoke/suites/p72.ts` (the paid-order seed, :277);
  - `apps/web/src/server/usecases/__tests__/competitions-delete-money.test.ts` (direct insert :109);
  - `apps/web/src/server/usecases/__tests__/dispute-unmatched-retry.test.ts` (direct insert :52);
  - `apps/web/src/server/usecases/__tests__/sponsor-order-delete-guards.test.ts` (direct insert :69).
- Modify (F31): `apps/web/src/server/sponsors/__tests__/migration.test.ts` (the tier-CHECK sweep, :206-221; the table list at :212-216 gains `sponsor_orders`), and the header of `apps/web/src/lib/sponsor-tiers.ts` ("two tier CHECKs" → three).

**Interfaces:**
- Produces these columns on `sponsor_orders`:
  - lifecycle and rule: `deal_status text not null`, `payment_method text not null`, `go_live text not null`;
  - snapshot: `tier text not null`, `includes_on_stream boolean not null`, `package_name text not null`, `competition_id uuid null → competitions on delete restrict`, `ends_at timestamptz null`;
  - step stamps and actors: `created_by uuid null → users on delete set null`, `invoice_sent_at`, `marked_paid_by uuid null → users on delete set null`, `approved_at`, `approved_by uuid null → users on delete set null`, `live_at`, `ended_at`, `ended_reason text null`, `parked_at`. Every actor FK is `on delete set null` (F22), the house convention (`db/migration/deltas/V492__sponsor_rotation.sql:67,256`, `V484:24`), so deleting a user is never blocked by a deal;
  - Checkout: `checkout_session_id text null`, `checkout_url text null`, `checkout_expires_at timestamptz null`, `invoice_send_count int not null default 0`.
- Produces `sponsor_packages.includes_on_stream boolean not null default false`.
- Changes `sponsor_orders.status` CHECK to `pending|paid|failed|refunded|none`, makes `sponsor_email` nullable, and moves the `sponsor_id` FK to `on delete restrict`. The existing status CHECK is UNNAMED (V283:70-71): drop it by its auto name `sponsor_orders_status_check`, and assert in the test that it is gone. The current columns are V283:61-75 plus V291 (`disputed_at`, `dispute_id`); the FKs are V299 (org and package RESTRICT) and V283:72 (`sponsor_id … on delete set null`, which this delta changes).
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
- **Every insert site is deal-shaped in THIS task (F4).** The six sites in Files stop working the moment this delta lands (the no-default NOT NULLs, and `sponsor_or_legacy`), so they change here, not in Task 8.
- **The `seedSponsorOrder` shape (F5).** Never a live deal without a sponsor: `sponsor_or_legacy` refuses it, and a pending live `on_payment` deal is a state no product path writes.
  - `status: "paid"` → a sponsor plus a live, online, `on_payment` deal with paid money (`deal_status='live'`, `payment_method='online'`, `go_live='on_payment'`, `live_at=now()`, the package's `tier`, `includes_on_stream=false`, `package_name`, `competition_id`).
  - `status: "pending"` → a sponsor PLUS an `awaiting_payment` online deal (`sponsor_id` set, `deal_status='awaiting_payment'`, `payment_method='online'`, `go_live='on_payment'`).
  - The `pending` branch's consumers are `apps/web/src/server/email-outbox/__tests__/outbox-kind-sweep.test.ts:952` and `apps/web/src/server/usecases/__tests__/billing-events-outbox-replay.test.ts:133`. Both stay green.
  - `seedSponsorRig`, p72's seed and the three direct inserts follow the same shapes.
- **Known red until Task 7 (F4), by name.** These files go red here because `startSponsorCheckout`'s insert (`server/usecases/sponsors.ts:534-542`) lacks the no-default columns, and Task 7 deletes that function:
  - `apps/web/src/server/usecases/__tests__/sponsor-checkout.test.ts` (its checkout cases, :113-470);
  - `apps/web/src/server/usecases/__tests__/sponsor-outbox.test.ts`;
  - `apps/web/src/server/usecases/__tests__/sponsors-public-expiry.test.ts` (its checkout case);
  - the `sponsor_invoice` scenario of `apps/web/src/server/email-outbox/__tests__/outbox-kind-sweep.test.ts`.
  This list is the ONLY red Tasks 1–6 may report. A red outside it is a defect, owned by the task that caused it.

**Tests:**
- Unit (DB): `deals-migration.test.ts`. It finds the delta by `/^V\d+__sponsor_deals\.sql$/` and fails if the count of matches ≠ 1.
  - For EACH named constraint, an accepted row and a refused row sit in the same `it`. The refusal asserts the constraint NAME, not just the SQLSTATE.
  - The tier CHECK names exactly `SPONSOR_TIERS` (read from `lib/sponsor-tiers.ts`).
  - The value sets equal the spec literals typed in the test (`["draft","awaiting_payment","awaiting_approval","scheduled","live","ended"]`, `["online","offline","complimentary"]`, `["on_payment","immediate","on_approval"]`, `["refunded","dispute_lost","ended_now","expired","competition_finished","legacy"]`).
  - A second live deal for one sponsor is refused by `sponsor_orders_one_live_per_sponsor`, and the twin (one live plus one ended) is accepted.
  - Deleting a sponsor that has a deal is refused (23503), and deleting one with no deal is accepted.
  - **Actor FKs (F22):** deleting a user who marked a deal paid, and one who approved a deal, is accepted, and the deal's `marked_paid_by` / `approved_by` then read null.
  - The old unnamed `sponsor_orders_status_check` no longer exists; the new status CHECK accepts `none`.
  - **Legacy block:** inside `sql.begin` with `set local lock_timeout = '5s'`, which is rolled back: drop the NOT NULLs, insert a legacy-shaped paid, disputed row with null `sponsor_id`, execute the text between the markers (read from the file), and assert the D6 values and that `status`, `payment_intent_id`, `disputed_at` and `dispute_id` are byte-equal to before. Assert the run touched exactly 1 row (not 0).
- Unit (DB, F31): `server/sponsors/__tests__/migration.test.ts`'s tier-CHECK sweep now covers `sponsors`, `sponsor_packages` AND `sponsor_orders`, and reports 3 tables checked.
- E2E: none new. Task 6's API spec runs on the migrated CI database, and this schema is its precondition. `payments-hardening.spec.ts` runs on its deal-shaped `seedSponsorRig` in CI.
- Smoke: none new (Task 6 adds the rows). p72's guards keep passing on the deal-shaped seed in CI.
- Regression:
  - `lib/__tests__/migration-header-truth.test.ts` stays green: the header does not self-name a version.
  - The DB files whose inserts changed stay green (F4): `competitions-delete-money.test.ts`, `dispute-unmatched-retry.test.ts`, `sponsor-order-delete-guards.test.ts`, plus the `seedSponsorOrder` consumers `billing-events-outbox-replay.test.ts` and `outbox-kind-sweep.test.ts` (except its `sponsor_invoice` scenario, which is on the known-red list) (F5).

**Steps:**
- [ ] 1. Write `deals-migration.test.ts` as above, and widen `migration.test.ts`'s tier sweep. Run VERIFY on them. Expected: FAIL with "the sponsor-deals delta is missing".
- [ ] 2. Write the delta (use the `supabase-postgres-best-practices` skill for the DDL). Apply it to the local test DB. Make the six insert sites deal-shaped (F4, F5). Update the `lib/sponsor-tiers.ts` header (F31).
- [ ] 3. Run VERIFY on `deals-migration.test.ts`, `server/sponsors/__tests__/migration.test.ts`, `lib/__tests__/migration-header-truth.test.ts`, `competitions-delete-money.test.ts`, `dispute-unmatched-retry.test.ts`, `sponsor-order-delete-guards.test.ts`, `billing-events-outbox-replay.test.ts` and `outbox-kind-sweep.test.ts`. Expected: every file listed; failed 0 except the `sponsor_invoice` scenario on the known-red list, which the report names. Run the known-red files once and record which cases are red, so Tasks 4–6 can tell a known red from a new one.
- [ ] 4. Mutate: drop the partial unique index, then remove `ended_reason = 'legacy'` from `sponsor_orders_sponsor_or_legacy`, then drop `on delete set null` from `approved_by`. Each must red its named test. Restore from the `cp` backup.
- [ ] 5. Commit `feat(db): sponsor deals schema — deal lifecycle, rule, snapshot and step stamps on sponsor_orders`.

### Task 2: The pure deal domain

**Files:**
- Create: `apps/web/src/lib/sponsor-deals.ts`
- Test: `apps/web/src/lib/__tests__/sponsor-deals.test.ts`, `apps/web/src/server/sponsors/__tests__/deal-values-db.test.ts` (DB, F31)

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
export class DealRuleError extends Error { constructor(readonly code: "on_payment_needs_payment" | "illegal_transition", …) } // domain-only: Task 6 maps it to HttpError at the usecase boundary (F12)
export function goLiveRulesFor(m: PaymentMethod): readonly GoLiveRule[];           // complimentary → ["immediate","on_approval"]
export function initialPaymentStatus(m: PaymentMethod): PaymentStatus;             // complimentary → "none", else "pending"
export function initialStatus(m: PaymentMethod, r: GoLiveRule, otherLive: boolean): DealStatus;
export function statusAfterInvoiceSent(d: Pick<SponsorDeal,"deal_status">): DealStatus;
export function statusAfterPaid(d: Pick<SponsorDeal,"deal_status"|"go_live">, otherLive: boolean): DealStatus;
export function statusAfterApproved(d: Pick<SponsorDeal,"deal_status">, otherLive: boolean): DealStatus;
export function allowedActions(d: SponsorDeal): DealAction[];                      // in DEAL_ACTIONS order
export function pickRowDeal(deals: readonly SponsorDeal[]): SponsorDeal | null;    // legacy rows excluded
export type RowAction = "add_deal" | "open_deal" | "resend_invoice" | "mark_paid" | "approve"; // no "send_invoice": a draft row opens the deal (F15)
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
- `allowedActions` is TOTAL (F15): every (deal_status × payment_status × method) answers, in `DEAL_ACTIONS` order:
  - draft → `send_invoice`, `end_now`;
  - awaiting_payment online → `resend_invoice`, `mark_paid`, `end_now`;
  - awaiting_payment offline → `mark_paid`, `end_now`;
  - awaiting_approval → `approve`, `end_now` (plus `refund` when paid, below);
  - live or scheduled → `end_now`; with payment unpaid, add `resend_invoice` (online) and `mark_paid`;
  - paid and not disputed → `refund` in every status, including ended, unless `ended_reason` is `refunded` or `dispute_lost`;
  - ended → nothing else;
  - complimentary → never `mark_paid`, `refund` or `*_invoice`.
  - "Unpaid" is payment `pending` or `failed`: Task 8 keeps a failed deal payable in the same session, so `failed` offers what `pending` offers.
  - Combinations no product path can write (for example a draft with payment `paid`) are typed in the test as unreachable, with their answer still pinned.
  - Task 6 refuses with 409, before any write, every action this function does not offer (F12). Task 23 later adds `resend_invoice` for offline deals with an email (F13).
- `pickRowDeal`: live > awaiting_approval > awaiting_payment > draft > scheduled > latest ended (by `ended_at`). An empty list, or only legacy deals, → `null`.
- `rowNextAction`, by this precedence (F15), first match wins:
  1. `null` or ended → `add_deal`;
  2. `awaiting_approval` → `approve`;
  3. payment unpaid and status not draft or scheduled → `resend_invoice` (online) or `mark_paid` (offline);
  4. draft or scheduled → `open_deal`;
  5. otherwise (live with payment `paid` or `none`) → `null`.
- `dealChip`: a scheduled deal that is paid shows `paid`; one with payment `none` or pending shows `scheduled`; live with payment pending sets `awaitingPayment`; live with `parked_at` sets `onHold`.
- `primaryLabel`: online → `send_invoice`; offline or complimentary with `immediate` and not `otherLive` → `save_and_go_live`; else `save_deal`.

**Tests:**
- Unit: `sponsor-deals.test.ts`.
  - **Empty case first:** `pickRowDeal([])` is null, `rowNextAction(null)` is `"add_deal"`, and `allowedActions` of an ended, refunded deal is `[]`.
  - Every combo of `PAYMENT_METHODS × GO_LIVE_RULES × otherLive` (18 cases): assert the spec path. The test counts the cases it checked and fails unless it is 18.
  - A path walk per allowed combo (8 combos × 2) applies create → send → paid → approve in the order the rule allows, and asserts the spec path `["draft","awaiting_payment","awaiting_approval","live"]` etc.
  - **The full action table (F15).** The test types, from spec §5.2 and the mockups, one row per (deal_status × payment_status × method): 6 × 5 × 3 = 90 rows, each with its expected `allowedActions` list and a `reachable` flag. The reachable set is a typed literal list, never computed by walking this module's own transitions (that would make the implementation its own oracle). The test asserts `rows.length === 90`, pins the reachable count as a literal, and counts the rows it checked (the counter must equal 90). Add the `refunded` / `dispute_lost` × paid rows explicitly.
  - **`rowNextAction` precedence (F15):** one case per rule, plus the overlaps the old wording left open: a draft with payment pending → `open_deal`; a scheduled deal with payment pending → `open_deal`; `awaiting_approval` with payment pending → `approve`; live online pending → `resend_invoice`; live offline pending → `mark_paid`. No input returns `send_invoice`.
  - The ordering differential for `pickRowDeal`: [ended newer, live older] → live.
- Unit (DB, F31): `deal-values-db.test.ts` reads Task 1's CHECK definitions from `pg_constraint` and asserts each DB value set equals its constant: `DEAL_STATUSES`, `PAYMENT_METHODS`, `GO_LIVE_RULES`, `PAYMENT_STATUSES`, `END_REASONS` (5 sets, counted).
- E2E, smoke: none (pure; exercised by Tasks 6, 16 and 19).
- Regression: none pre-existing.

**Steps:**
- [ ] 1. Write the tests. Run VERIFY. Expected: FAIL, "Cannot find module '@/lib/sponsor-deals'".
- [ ] 2. Implement the module. It may import only `lib/sponsor-tiers.ts`, because it must stay client-safe.
- [ ] 3. Run VERIFY on `sponsor-deals.test.ts` and `deal-values-db.test.ts`. Expected: failed 0. Run TSC.
- [ ] 4. Mutate:
  - `initialStatus` online+immediate returns `draft`. Killer: the combo sweep.
  - `statusAfterPaid` skips approval. Killer: the on_approval path walk.
  - Drop the `parked_at` → `onHold` rule. Killer: the chip test.
  - Drop `end_now` from `awaiting_approval`. Killer: the action table (F15).
  - Swap `rowNextAction` rules 3 and 4. Killer: the scheduled-pending precedence case.
  - Restore after each.
- [ ] 5. Commit `feat(sponsors): the deal domain — statuses, transitions, actions and chips as one pure module`.

### Task 3: The placement gate for sponsors, packages and deals (owner-confirmed, spec §10 Q1)

> **Owner-confirmed 2026-11-07 (spec §10 Q1, "Ok"; F14).** The owner's answers in spec §10 are binding, and nothing in this task waits on the owner. Community deals are Partner-only, and tiers stay gated by `sponsors.tiers` as today. Today's gate ALSO gates competition scoping, so community deals are org-wide too (§2 premise 2). `placementNeedsTiers` is the ONE predicate for this answer: today's private `assertTierAllowed` (`server/usecases/sponsors.ts:123-131`, called at :194 in `createSponsor` and :246 in `patchSponsor`) is rewritten to call it, so sponsors, packages and deals share one answer. A later change of the answer then changes `placementNeedsTiers` and its test, and nothing else in this programme.

**Files:**
- Create: `apps/web/src/lib/sponsor-deal-policy.ts`, `apps/web/src/server/sponsors/deal-gates.ts`
- Modify: `apps/web/src/server/usecases/sponsors.ts` (`assertTierAllowed` :123-131 decides by `placementNeedsTiers`; its `requireFeature` call and 402 stay) (F14)
- Test: `apps/web/src/lib/__tests__/sponsor-deal-policy.test.ts`, `apps/web/src/server/sponsors/__tests__/deal-gates.test.ts`

**Interfaces (Produces):**
```ts
// lib/sponsor-deal-policy.ts (client-safe; the ONE place the §10 answer lives — sponsors, packages and deals all read it)
export function placementNeedsTiers(tier: SponsorTier, competitionId: string | null): boolean; // tier !== "partner" || competitionId !== null
// server/sponsors/deal-gates.ts
export async function assertPlacementAllowed(orgId: string, tier: SponsorTier, competitionId: string | null): Promise<void>;
//   placementNeedsTiers → requireFeature(orgId, "sponsors.tiers", competitionId ?? undefined); else no-op
export async function assertOnlineAllowed(orgId: string, competitionId: string | null): Promise<void>;
//   requireFeature(orgId, "sponsors.monetize", competitionId ?? undefined) (§8)
// server/usecases/sponsors.ts — assertTierAllowed (private) keeps its signature and calls placementNeedsTiers (F14)
```

**Tests:**
- Unit: `placementNeedsTiers` over `SPONSOR_TIERS × {null, uuid}`. That is 8 cases, counted. Only `("partner", null)` answers false.
- Unit (DB): `deal-gates.test.ts`.
  - Community: partner org-wide passes; gold org-wide → 402; partner on a competition → 402.
  - Pro: all pass.
  - Event Pass on competition C: gold on C passes; gold org-wide → 402; gold on another competition → 402.
  - `assertOnlineAllowed` on community → 402; on an Event Pass for C → passes; on C' → 402.
  - **One predicate (F14):** on community, `createSponsor` with gold → 402, and with partner on a competition → 402; partner org-wide → created. These go through `assertTierAllowed`, so they die with the predicate.
- E2E and smoke: carried by Tasks 4 and 6 (the gate shows only through package create and deal create).
- Regression: `lib/__tests__/pass-scoping-guard.test.ts` (DB) stays green: both calls pass the competition. `server/usecases/__tests__/sponsors.test.ts` (sponsor create and patch tier gating unchanged).

**Steps:**
- [ ] 1. Write both tests. Run VERIFY. Expected: FAIL, module missing.
- [ ] 2. Implement. Rewrite `assertTierAllowed` to call `placementNeedsTiers` (F14).
- [ ] 3. Run VERIFY on both tests plus `pass-scoping-guard.test.ts` and `sponsors.test.ts`. Expected: failed 0. Run TSC.
- [ ] 4. Mutate: drop `|| competitionId !== null`. Killers: the community "partner on a competition → 402" case AND the `createSponsor` partner-on-a-competition case (both must die: one predicate). Restore.
- [ ] 5. Commit `feat(sponsors): one placement gate for sponsors, packages and deals (community deals are partner-only and org-wide)`.

### Task 4: Packages on every plan, with "On stream" included

**Files:**
- Modify: `apps/web/src/server/usecases/sponsors.ts` (`CreateSponsorPackageInput` :396, `createSponsorPackage` :413 (its `requireFeature("sponsors.monetize")` is :417), `listSponsorPackages` :434, `SponsorPackageRow` :379, `PKG_COLS` :391)
- Modify: `apps/web/src/server/api-v1/{schemas.ts,openapi.ts}`, `openapi/v1.json`
- Test: `apps/web/src/server/usecases/__tests__/sponsor-packages-plans.test.ts` (new); modify `scripts/smoke/suites/sponsors.ts` (the gated row is :439) and `scripts/smoke/suites/passGrants.ts` (:371-373, F8)

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
- Smoke, in `scripts/smoke/suites/passGrants.ts` (F8): the row at :371-373 pins `featureKey === "sponsors.monetize"` on a package create. After this task that create no longer reads `sponsors.monetize`: a gold package 402s on `sponsors.tiers`, and a partner one is 201. Rewrite the expectation to what the row's package now hits, and keep the row's plan-scoping intent.
- Regression: `server/usecases/__tests__/sponsor-checkout.test.ts`'s package-create cases keep passing on Pro. That file is on Task 1's known-red list until Task 7 (its checkout cases), so run only the package-create cases by name (F4).

**Steps:**
- [ ] 1. Write the tests. Run VERIFY. Expected: FAIL (community partner → 402 today).
- [ ] 2. Implement. Run OPENAPI.
- [ ] 3. Run VERIFY on the new test, and on `sponsor-checkout.test.ts` with `-t "<each package-create case name>"`. Report Task 1's known-red list instead of "failed 0" for that file (F4). Run TSC.
- [ ] 4. Mutate: restore the monetize `requireFeature`. Killer: the community partner case. Restore.
- [ ] 5. Commit `feat(sponsors): packages on every plan; a package can include On stream`.

### Task 5: `applyDealsToSponsor`, the one owner, plus the sponsor lock and the delete guard

**Files:**
- Create: `apps/web/src/server/sponsors/deal-apply.ts`
- Modify: `apps/web/src/server/usecases/sponsors.ts`:
  - `patchSponsor` :217 gains the lock (D9), under its own unconditional sponsor lock (F16);
  - `deleteSponsor` :283 (today a plain delete with no guard) gains the guard;
  - `listSponsorRows` :168 gains the deal summary (`paid_order_id` :171-173 stays);
  - `bustPublicSponsors` (:157) is NOT moved and NOT exported: it stays private here, for webhooks and disputes only (F1).
- Test: `apps/web/src/server/sponsors/__tests__/deal-apply.test.ts`, `apps/web/src/server/usecases/__tests__/sponsor-lock.test.ts`

**Interfaces:**
```ts
export type ApplyOutcome = "no_deals" | "live" | "parked" | "hidden_open" | "ended_all";
export async function applyDealsToSponsor(tx: Tx, sponsorId: string, actorUserId: string | null,
  opts?: { now?: Date; endedDealId?: string | null }):  // endedDealId: the deal THIS call moved from live/open to ended (F7)
  Promise<{ outcome: ApplyOutcome; promotedDealId: string | null }>;
// deal-apply.ts exports nothing bust-shaped (F1).
// SponsorRow gains:
//   deal: SponsorDeal | null  (pickRowDeal of its non-legacy deals, computed in TS — never a SQL copy of the selection)
//   locked_by_deal: boolean   (a live deal exists)
//   has_open_deal: boolean
//   last_billing_email: string | null
```

**Algorithm** (D8; the order matters):
1. **One lock order, everywhere (F2).** Lock the sponsor row (`for update`), then that sponsor's deals (`for update`, ordered `created_at, id`). Every deal writer in this programme takes the same order: a caller that starts from a deal reads its `sponsor_id` WITHOUT a lock, locks the sponsor, then the sponsor's deals in this order, then re-checks the target deal's state. Never lock a deal before its sponsor: two writes on two deals of one sponsor would deadlock (40P01).
2. With no non-legacy deals, return `no_deals` and write nothing.
3. If no deal is live, promote the earliest `scheduled` one: set it `live` with `live_at = now`.
4. With a live deal: write `status = parked_at ? 'pending' : 'active'`, plus `tier`, `competition_id` and `on_stream` from its snapshot. If `on_stream`, call `ensureOrgStreamSettings(tx, orgId, actorUserId)` (`server/sponsors/stream-settings.ts:96`).
5. Else, with any open deal: write `status = 'inactive'` only.
6. Else (every deal is ended): **only on the transition (F7)**, that is, when `opts.endedDealId` is the deal this call just moved from live or open to ended and no other deal is live or open, write `status='inactive', tier='partner', competition_id=null, on_stream=false` and return `ended_all`. Otherwise write nothing and return `no_deals`. A late event on an old deal (a dispute created or closed, a refund of an already-ended deal) re-runs apply with no transition, so it never clobbers the club's hand switch-back-on (spec §10 Q3).

`applyDealsToSponsor` fires no bust itself. Its console callers await `expirePublicSponsors` (`server/usecases/sponsors.ts:150-152`) after commit; webhook and sweep callers keep `deferred` (F1). `patchSponsor` and `deleteSponsor` already await it (:278, :288): keep that.

**Lock** (`patchSponsor`). Today the `for update` exists only for a `status` patch (:256-262), and `assertTierAllowed` runs BEFORE the transaction (:240-246). So (F16):
- inside `patchSponsor`'s transaction, take an unconditional `select … from sponsors where id = … for update` first, for every patch;
- a live deal plus any of `tier | competition_id | on_stream | status` in the patch → `HttpError(409, "sponsor_locked_by_deal")`;
- an open non-live deal plus `status` → `HttpError(409, "sponsor_has_open_deal")`;
- the existing dispute-park 409 stays;
- the plan gate (`assertTierAllowed`) still runs first, so on a community org a tier PATCH answers 402 before any 409.

**Delete guard** (`deleteSponsor`): 409 `sponsor_has_deal_history` when any deal has `status <> 'pending'`, or a `payment_intent_id`, or `disputed_at`, or is not `draft`/`awaiting_*`. **"Any deal" includes legacy rows (F16):** the `sponsor_id` FK is RESTRICT now and covers them, so a sponsor whose only rows are legacy answers 409, never a 23503. Otherwise it deletes the deals, then the sponsor, in one transaction. Two later tasks extend this guard: Task 7 expires an online deal's open Checkout session before deleting it, and answers 409 when it cannot (F3); Task 20 answers 409 for any deal with an invoice number (F10). No deal has a session or a number before those tasks.

**Tests:**
- Unit (DB): `deal-apply.test.ts`.
  - **Empty case first:** a sponsor with no deals keeps its hand-set gold, competition C, active and on_stream values byte-equal after `apply` (outcome `no_deals`).
  - A sponsor with only legacy deals → `no_deals`.
  - A live deal with gold, C and on stream → the sponsor is active/gold/C/on_stream, the `sponsor_stream_settings` org row exists, and `resolveSponsors(org, C)` lists it. The positive pair: `resolveSponsors(org, otherComp)` does not.
  - A parked live deal → `pending`, and `resolveSponsors` does not list it.
  - Open only → `inactive`, with tier unchanged. **This is the ruling case: a visible no-deal sponsor becomes hidden when an awaiting deal is added.**
  - All ended, on the transition (`endedDealId` = the last live deal) → inactive/partner/null/false, outcome `ended_all`.
  - **Hand switch-back-on survives (F7):** end all deals (transition writes inactive/partner) → switch the sponsor on by hand (`patchSponsor` status active: allowed, every deal has ended) → apply again with no `endedDealId`, as a late dispute close or a refund of the ended deal does (Task 8 drives the real event) → the sponsor row is byte-equal, outcome `no_deals`.
  - **Promotion:** live A plus scheduled B; end A → B live, and the sponsor takes B's snapshot.
  - Second call: apply twice → identical row, and `live_at` is not rewritten.
  - **Downgrade (Review Focus 4):** a Pro gold deal goes live, then `setOrgPlan(community)`: apply keeps it active/gold, and `resolveSponsors(org, C, { tiered: false })` returns it as partner.
- Unit (DB): `sponsor-lock.test.ts`. It runs on a **Pro** org (F16), because on community `assertTierAllowed` answers a tier PATCH with 402 before the transaction.
  - Each locked field with a live deal → 409 `sponsor_locked_by_deal`. Its positive pair: the same PATCH on a no-deal sponsor → 200.
  - `name` / `url` / `logo_path` with a live deal → 200.
  - `status` with an open deal → 409.
  - **Community, once (F16):** a gold tier PATCH on a live-deal sponsor in a community org → 402, which pins that the plan gate precedes the deal lock.
  - **The lock is unconditional (F16):** a `tier` PATCH waits on a sponsor lock held by another transaction (lock witness: a holder transaction plus a `pg_blocking_pids` poll, released in `finally`).
  - Delete: no deals → 204; a draft only → deleted with its deal; a paid deal → 409; a sponsor with only legacy rows → 409, not 23503 (F16).
- E2E: Task 6's API spec has `a no-deal sponsor shows, an awaiting deal hides it, mark-paid shows it again, same id`.
- Smoke: Task 6.
- Regression: `server/usecases/__tests__/{sponsor-dispute.test.ts,sponsors.test.ts}` (PR A), and `app/api/v1/orgs/[id]/sponsors/__tests__/on-stream.test.ts` (the R4 tick on a no-deal sponsor is unchanged).

**Steps:**
- [ ] 1. Write both tests. Run VERIFY. Expected: FAIL, module missing.
- [ ] 2. Implement.
- [ ] 3. Run VERIFY on the two new tests and the three regression files. A red regression case must be on Task 1's known-red list; report that list instead of "failed 0" (F4). Any other red is this task's defect. Run TSC.
- [ ] 4. Mutate:
  - Apply returns early when no deal is live (no promotion). Killer: `promotion`.
  - Ignore `parked_at`. Killer: the parked case.
  - Drop the `on_stream` lock field. Killer: its 409 case.
  - Step 6 writes on every all-ended apply, not only on the transition. Killer: the switch-back-on case (F7).
  - `patchSponsor` locks the sponsor only for a `status` patch (today's shape). Killer: the lock witness (F16).
  - Restore after each.
- [ ] 5. Commit `feat(sponsors): one owner applies deals to their sponsor; a live deal locks tier, scope and stream`.

### Task 6: Deal usecases and routes (no Stripe): create, mark paid, approve, end now, offline refund, list and get

**Files:**
- Create: `apps/web/src/server/usecases/sponsor-deals.ts`
- Create: `apps/web/src/app/api/v1/orgs/[id]/sponsors/[sponsorId]/deals/route.ts`, `apps/web/src/app/api/v1/orgs/[id]/sponsor-deals/route.ts`, `apps/web/src/app/api/v1/orgs/[id]/sponsor-deals/[dealId]/route.ts`, `apps/web/src/app/api/v1/orgs/[id]/sponsor-deals/[dealId]/{mark-paid,approve,end,refund}/route.ts`
- Modify: `apps/web/src/server/api-v1/{schemas.ts,openapi.ts,key-scopes.ts}` (the new routes go in `NEVER_KEY_ROUTES`, `key-scopes.ts:341-357`, beside today's sponsor rows), `openapi/v1.json`
- Modify: `apps/web/src/server/usecases/sponsors.ts`: export `expirePublicSponsors` (:150-152, private today), so the deal usecases await the same in-request expiry (F1). `bustPublicSponsors` stays private.
- Test: `apps/web/src/server/usecases/__tests__/sponsor-deals.test.ts`, `apps/web/src/app/api/v1/orgs/[id]/sponsor-deals/__tests__/routes.test.ts`, `apps/web/e2e/sponsor-deals-api.spec.ts` (new), `scripts/smoke/suites/sponsorDeals.ts` (new) plus `scripts/smoke/main.ts` (register after `sponsors`, :81 and :741); extend `apps/web/src/server/usecases/__tests__/sponsors-public-expiry.test.ts` (F1)

**Interfaces:**
```ts
export const CreateDealInput = z.object({
  package_id: z.string().uuid(), competition_id: z.string().uuid().nullable(),
  payment_method: z.enum(PAYMENT_METHODS), go_live: z.enum(GO_LIVE_RULES),
  sponsor_email: z.string().email().max(320).nullish(), ends_on: z.iso.date().nullish(),
  end_current: z.boolean().default(false),
}).strict();
export async function createDeal(auth: AuthCtx, sponsorId: string, input: CreateDealInput, origin: string):
  Promise<{ deal: SponsorDeal; checkout_url: string | null }>; // F11: checkout_url is null here; Task 7 fills it for online deals. SponsorDeal stays URL-free.
export async function markDealPaid(auth: AuthCtx, dealId: string): Promise<SponsorDeal>;
export async function approveDeal(auth: AuthCtx, dealId: string): Promise<SponsorDeal>;
export async function endDealNow(auth: AuthCtx, dealId: string): Promise<SponsorDeal>;
export async function refundDeal(auth: AuthCtx, dealId: string): Promise<SponsorDeal>; // offline here; online in Task 7
export async function listDeals(auth: AuthCtx, opts?: { sponsorId?: string }): Promise<SponsorDeal[]>;
export async function getDeal(auth: AuthCtx, dealId: string): Promise<SponsorDeal>;
```

**Routes.** Every route is `requireOrgAuth(req, id, "write")`, except GET, which is `"read"`:
- `POST /orgs/{id}/sponsors/{sponsorId}/deals` → 201, body `{ deal, checkout_url }` (F11);
- `GET /orgs/{id}/sponsor-deals?sponsor_id=`;
- `GET /orgs/{id}/sponsor-deals/{dealId}`;
- `POST …/{mark-paid|approve|end|refund}` → 200.

**Acceptance for `createDeal`.** It follows the order of today's `startSponsorCheckout`: refusals before any row.
1. Load the package (404; `!active` → 422 `package_retired`).
2. The scope must be inside the package's: a one-competition package forces `competition_id = pkg.competition_id`, else 422 `scope_outside_package`. The competition must be the org's (404).
3. Call `assertPlacementAllowed(org, pkg.tier, scope)`. For online, call `assertOnlineAllowed(org, scope)` and check Connect (409 `connect_required`, today's wording).
4. Online needs `sponsor_email` (422).
5. `complimentary` + `on_payment` → 422 `on_payment_needs_payment` (`initialStatus` throws `DealRuleError`; the usecase maps it to `HttpError(422)`, F12).
6. `ends_on` must be today or later in the org's timezone (422). It is stored as `ends_at` = the start of the NEXT day in `organizations.timezone`. That column is NULLABLE (`V305__org_timezone.sql`): fall back to `'UTC'`, the repo's `coalesce(…, o.timezone, 'UTC')` convention.
7. In one transaction:
   - lock the sponsor `for update`, then its deals `for update` ordered `(created_at, id)` (F2, Task 5's lock order);
   - `end_current` ends its live deal (`ended_now`);
   - insert with `initialStatus`, `initialPaymentStatus`, the snapshot from the package, `sponsor_name` from the sponsor, and `created_by` (= `auth.userId`);
   - stamp `live_at` when it is created live;
   - call `applyDealsToSponsor` (with `endedDealId` when `end_current` ended a deal).
8. **After commit, await `expirePublicSponsors(orgId, op)` (F1).** Never `bustPublicSponsors` or `deferred` on a console write: PR A's smoke read the public page 3 ms after a 201 and got the cached page (`server/usecases/sponsors.ts:144-152`). The e2e and smoke rows below ("mark-paid puts the SAME sponsor on the public page") depend on it.

Online deals are created `draft`; Task 7 sends the invoice and fills `checkout_url` (F11).

**Acceptance for the actions:**
- **Before any write, every action (F2, F12):**
  - reads the deal's `sponsor_id` WITHOUT a lock, locks the sponsor `for update`, then that sponsor's deals `for update` ordered `(created_at, id)`, then re-checks the target deal's state (Task 5's lock order). A concurrent second call therefore sees the new state and answers 409;
  - refuses with 409 any action that `allowedActions(deal)` does not offer;
  - never lets a `DealRuleError` escape: the usecase boundary maps `illegal_transition` → `HttpError(409)` and `on_payment_needs_payment` → `HttpError(422)`. Example: `markDealPaid` on an online draft passes a bare "payment pending" check, and `statusAfterPaid(draft)` throws; that must be a 409, never a 500.
- **`markDealPaid`:** offline only here (online in Task 7). Payment must be unpaid (`pending`, or `failed`, which Task 2 treats as unpaid), else 409 `deal_already_paid`. Set paid, `paid_at`, `marked_paid_by`, and `deal_status = statusAfterPaid`, then apply.
- **`approveDeal`:** `awaiting_approval` only, else 409 `deal_not_awaiting_approval`. Set `approved_at` / `approved_by` and `statusAfterApproved`, then apply.
- **`endDealNow`:** any non-ended deal. Set `ended_now`, then apply (with `endedDealId`), which may promote a scheduled deal.
- **`refundDeal` (offline):** payment `paid`, not disputed. Set `status='refunded'`, `deal_status='ended'`, `ended_reason='refunded'`, then apply (with `endedDealId` when the deal was not already ended). Nothing is emailed: no money moves (§5.2).
- **After commit, every action awaits `expirePublicSponsors` (F1).**

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
  - **`DealRuleError` never escapes (F12):** `markDealPaid` on an online draft → `HttpError` 409, not a 500; complimentary + `on_payment` → `HttpError` 422; an action `allowedActions` does not offer (Approve on a live deal) → 409, with the deal row byte-equal to before.
  - **Two deals, one sponsor, concurrently (F2):** live A plus offline awaiting_payment B on the same sponsor; `Promise.all([endDealNow(A), markDealPaid(B)])` → both fulfil in some order, no 40P01, and the sponsor ends in the state the second commit implies. (Task 8 adds the webhook version.)
  - **No timezone:** an org with `timezone` null stores `ends_on` as the next UTC midnight.
  - **Community:** an offline partner org-wide deal is created; an online one → 402; a gold one → 402.
- Unit (DB, F1): extend `sponsors-public-expiry.test.ts` (its harness never runs `after`, :16-27) with one case per console action in this task: create, mark-paid, approve, end and offline refund. Each asserts the org tag is expired before the usecase resolves, with `h.tails` holding no sponsor bust.
- Unit: `routes.test.ts`. A viewer gets 403 on every POST and 200 on the GETs. A foreign org's deal id → 404. The bodies validate (the strict schema refuses unknown keys). The create route answers `{ deal, checkout_url: null }` for offline and complimentary (F11).
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
  - **Every smoke deal row creates its own sponsor (F33).** Never attach a deal to `goldId`: D8 would hide it, and `org2` is shared with later suites (`scripts/smoke/main.ts:741,839`).
- Regression: `server/usecases/__tests__/sponsor-order-delete-guards.test.ts` (the existing guards still hold; Task 1 made its insert at :69 deal-shaped, F4). `server/api-v1/__tests__/key-scopes.test.ts` (:228: every v1 route file is classified).

**Steps:**
- [ ] 1. Write the unit, route and e2e tests and the smoke rows. Run VERIFY on the two vitest files. Expected: FAIL, module missing.
- [ ] 2. Implement the usecases and routes. Run OPENAPI. Add the routes to `key-scopes.ts`'s `NEVER_KEY_ROUTES` beside today's sponsor rows.
- [ ] 3. Run VERIFY on both files, `sponsor-order-delete-guards.test.ts` and `key-scopes.test.ts`, and on this task's new cases in `sponsors-public-expiry.test.ts` with `-t "<each case name>"` (its checkout case is on Task 1's known-red list until Task 7). Report the known-red list instead of "failed 0" (F4). Run TSC.
- [ ] 4. Mutate:
  - `approveDeal` without the sponsor lock. Killer: the concurrent test.
  - Offline `markDealPaid` ignores `go_live`. Killer: anti-goal 2.
  - `createDeal` skips `assertPlacementAllowed`. Killer: the community gold case.
  - Let `DealRuleError` escape (remove the mapping). Killer: the online-draft mark-paid 409 case (F12).
  - Replace the awaited `expirePublicSponsors` with `deferred`. Killer: the public-expiry cases (F1).
  - Lock the target deal before its sponsor. Killer: the two-deals concurrency case (40P01) (F2).
  - Restore after each.
- [ ] 5. Commit `feat(sponsors): create, mark paid, approve, end and offline-refund a deal`.
- [ ] 6. Dispatch E2E for the branch. Hand back.

### Task 7: Online deals: send and resend the invoice, online refund, mark-paid on an online deal; retire `/sponsor-orders`

**Files:**
- Modify: `apps/web/src/server/usecases/sponsor-deals.ts` (add `sendDealInvoice`; online branches of `createDeal`, `markDealPaid`, `endDealNow`, `refundDeal`)
- Modify: `apps/web/src/server/usecases/sponsors.ts`:
  - extract `mintDealCheckout` out of `startSponsorCheckout` (:499; order insert :534-542, mint :545-577, invoice :583-611), then DELETE `startSponsorCheckout`, `StartSponsorCheckoutInput` (:406) and `listSponsorOrders` (:476);
  - add `ensureDealCheckout`, the ONE reuse-or-expire-and-mint rule (F32; Task 22's `payInvoice` calls it);
  - `deleteSponsor` (:283) expires an online deal's open session before deleting it (F3).
- Create: `apps/web/src/app/api/v1/orgs/[id]/sponsor-deals/[dealId]/send-invoice/route.ts`, and `…/[dealId]/evidence/route.ts` (moved from `sponsor-orders/[orderId]/evidence`)
- Delete: `apps/web/src/app/api/v1/orgs/[id]/sponsor-orders/**` (`route.ts`, `[orderId]/refund/route.ts`, `[orderId]/evidence/route.ts`)
- Modify: `apps/web/src/server/api-v1/{schemas.ts,openapi.ts,key-scopes.ts}` (the sponsor rows: `openapi.ts:257-263`; `key-scopes.ts:341-357` and the evidence row :442), `openapi/v1.json`, `apps/web/src/app/developers/changelog/page.tsx`, `docs/api-v1-breaking-changes.md`
- Test: `apps/web/src/server/usecases/__tests__/sponsor-deals-online.test.ts`; modify `apps/web/src/server/usecases/__tests__/{sponsor-checkout.test.ts,sponsor-outbox.test.ts,sponsors-public-expiry.test.ts}` and `apps/web/src/server/email-outbox/__tests__/outbox-kind-sweep.test.ts`
- Modify (F8): `apps/web/src/server/usecases/__tests__/sponsors-public-expiry.test.ts` imports `startSponsorCheckout` at :109; move that case onto `createDeal` online. `apps/web/e2e/walkthrough/settings-sponsor-monetize.spec.ts`: the "paid" leg (:609) and the "refund" leg (:746) read `/sponsor-orders` (:706, :777, :788); repoint those API reads to `/sponsor-deals`. `scripts/smoke/suites/sponsors.ts` checkout rows :329-366, including the keyless row :342.

**Interfaces:**
```ts
export async function sendDealInvoice(auth: AuthCtx, dealId: string, origin: string): Promise<{ deal: SponsorDeal; checkout_url: string }>;
// createDeal (Task 6) now answers { deal, checkout_url } with checkout_url set for an online deal (F11). SponsorDeal stays URL-free.
// in sponsors.ts (Stripe outside any tx; same session shape as today: destination charge, application fee,
// metadata { kind: "sponsor", order_id, org_id }, success/cancel to routes.publicHub(slug) = /live/<slug>, lib/routes.ts:98 — never /shared/<slug>, F25)
export async function mintDealCheckout(deal: SponsorDeal, org: { id; slug; stripe_account_id }, origin: string, attempt: number):
  Promise<{ id: string; url: string; expires_at: number }>;
export async function ensureDealCheckout(deal: SponsorDeal, org: { id; slug; stripe_account_id }, origin: string):
  Promise<{ id: string; url: string; expires_at: number; minted: boolean }>;
//   F32 + F3: reuse while checkout_expires_at > now + 10 min; else retrieve the stored session, expire it if it is
//   still open, then mint with attempt = invoice_send_count + 1. Outside any transaction.
```

**The session rule (D14, F3, F37).** Two payable sessions for one deal must never coexist. Every path that replaces, abandons or deletes a stored session first calls `stripe.checkout.sessions.retrieve(checkout_session_id)`, outside any transaction, and decides on `retrieve().status` only:
- `open` → `expire` it, then proceed;
- `expired` → proceed (no `expire` call);
- `complete` → the money is in flight: no re-mint, and mark-paid answers 409 `deal_paid_online`.
- If `expire` throws, write nothing and answer 502 (for delete: 409, below). **Never parse `expire` errors** (F37): decide only on the status that `retrieve` reports.
- Reuse the retrieve → `status === "open"` → expire shape of `server/usecases/registrations.ts:2524-2549`, but NOT its best-effort fallthrough: here a failed expire stops the action, because carrying on would leave two payable sessions.

**Acceptance:**
- **`sendDealInvoice`.** Online only, for a deal that is `draft`, `awaiting_payment`, or `live`/`scheduled` with payment unpaid. Otherwise 409 `deal_not_invoiceable` (Task 6's `allowedActions` check, F12).
  - Get the session from `ensureDealCheckout` (F32): it REUSES `checkout_url` while `checkout_expires_at > now + 10 min`; else it retrieves the stored session, expires it if open (F3), and mints with the idempotency key `sponsor-deal-<id>-<invoice_send_count + 1>`. Store `checkout_session_id`, `checkout_url` and `checkout_expires_at` (D14).
  - Enqueue `sponsor_invoice` (today's renderer `sponsorInvoiceEmail`) with dedupe key `onceKey("sponsor_invoice", "sponsor_order", id, String(invoice_send_count + 1))`, so a resend is a new row and a retried resend is not.
  - Set `invoice_send_count + 1`, `invoice_sent_at = now`, and `deal_status = statusAfterInvoiceSent`. Call `assertOutboxCanQueue()` BEFORE minting (P-W2-1). The DB write takes Task 5's lock order (F2).
  - After commit, await `expirePublicSponsors` (F1).
- **`createDeal` online** calls `sendDealInvoice` after commit and answers `{ deal, checkout_url }` (F11). A Stripe failure answers 502 and leaves the deal as committed: `draft` for `on_payment` / `on_approval`, and live (or `scheduled`) with payment pending for `immediate`, which is created live. Resend invoice retries.
- **`markDealPaid` (online).** Apply the session rule first (F37): `complete` → 409 `deal_paid_online` with no state change; `expired` → proceed; `open` → expire, then proceed. Then follow the offline path.
- **`endDealNow` (online).** Apply the session rule first (F3, F37), so an ended deal leaves no payable session behind. `complete` → end anyway (the late payment lands on an ended deal: Review Focus 1).
- **`refundDeal` (online).** Delegates to `refundSponsorOrder` (:756), which keeps its existing Stripe call (:778-785), its disputed refusal and its awaited expiry (:793, F1). Task 8 makes `handleSponsorChargeRefunded` end the deal.
- **`deleteSponsor` (F3).** Before deleting an online `draft` / `awaiting_payment` deal that has a stored session, apply the session rule outside any transaction. While any such session is still open and cannot be expired, answer 409 `sponsor_has_open_checkout`. Reason: a later payment on a deleted deal hits `if (!order) return` (`server/usecases/sponsors.ts:644`), so money is taken and nothing is recorded.
- The changelog entry is dated on the merge day: "Breaking: sponsor orders become deals". It lists the removed and added paths, and that `sponsor_email` is now the deal's billing email.

**Tests:**
- Unit (DB, Stripe stubbed with `vi.spyOn(getStripe().checkout.sessions, …)` for `create`, `retrieve` and `expire`): `sponsor-deals-online.test.ts`.
  - The first send mints with key `…-1`, and a send inside the session's life REUSES the same url with no `create` call (asserted via call count 1).
  - **Re-mint expires the old session (F3):** a send with under 10 minutes left retrieves the old session (`open`), expires it (1 `expire` call), then mints `…-2`. A send after the old session reports `expired` mints `…-2` with no `expire` call.
  - **An open session that cannot be expired stops the mint (F3):** `expire` throws and `retrieve` still says `open` → 502, no `create` call, the deal row byte-equal.
  - Two sends queue 2 `sponsor_invoice` rows; a retried send with the same count queues 1.
  - Stripe throws on an `on_payment` create → the deal stays `draft` and the route answers 502. On an `immediate` create → the deal stays live with payment pending, 502, and Resend invoice is offered.
  - **`createDeal` online answers `{ deal, checkout_url }`** with the minted url; `deal` has no url field (F11).
  - **Mark-paid (F37):** `retrieve` says `complete` → 409 `deal_paid_online` and no state change; `expired` → paid, with no `expire` call; `open` → 1 `expire` call, then paid.
  - **End now (F3, F37):** an online deal with an open session → the session is expired, then the deal ends.
  - **Delete (F3):** a sponsor with an online awaiting_payment deal and an open session → the session is expired, then the sponsor and deal are deleted; `expire` throws and the session stays open → 409 `sponsor_has_open_checkout`, nothing deleted.
  - Online `on_payment` stays hidden after send. Online `immediate` is live after create with payment pending, and `dealChip` reports `awaitingPayment`.
  - Success and cancel urls point at `routes.publicHub(slug)` (`/live/<slug>`), never `/shared/` (F25).
- Modify `sponsor-checkout.test.ts`: every `startSponsorCheckout` case moves to `createDeal` online. Its "pending order before intent" assertion stays.
- Modify `outbox-kind-sweep.test.ts`: the `sponsor_invoice` REAL-PRODUCER scenario now drives `createDeal` online, not `startSponsorCheckout`.
- Modify `sponsors-public-expiry.test.ts` (F1, F8): its checkout case moves from `startSponsorCheckout` (:109) to `createDeal` online, and it gains one case each for `sendDealInvoice` and online `refundDeal` (the org tag expires before the usecase resolves). Its webhook-INSERT expectation is Task 8's to change.
- E2E: `apps/web/e2e/walkthrough/settings-sponsor-monetize.spec.ts` "invoice: Send invoice mints a REAL Stripe Checkout Session". It is updated in Task 12 (its UI path); here only its API calls change. Its "paid" (:609) and "refund" (:746) legs read `/sponsor-orders` (:706, :777, :788): repoint them to `/sponsor-deals` here (F8); Task 12 changes their UI path and Task 18 their Packages-panel reads.
- Smoke, in `sponsors.ts` (rows :329-366): the `"sp checkout …"` rows are rewritten onto `POST /sponsors/{id}/deals` (online), reading `checkout_url` from the create response (F11):
  - `"sp online deal refused without Connect (409)"`;
  - `"sp online deal starts (draft→awaiting_payment, checkout url)"`, keyless or Connect-less as today's skips;
  - `"sp deal row landed (deal-before-intent)"`;
  - the keyless row at :342 is mapped onto the new create (a counted, visible skip when there is no `sk_test_` key) (F8).
  - Each row creates its own sponsor; never `goldId` (F33).
- Regression: `server/usecases/__tests__/sponsor-outbox.test.ts` (receipt and refund kinds unchanged); `lib/__tests__/scrub-request-body.test.ts`; `server/api-v1/__tests__/key-scopes.test.ts`.

**Steps:**
- [ ] 1. Write the online test and rewrite the four modified tests. Run VERIFY. Expected: FAIL (`sendDealInvoice` missing; old imports gone).
- [ ] 2. Implement. Delete the old routes. Run OPENAPI. Add the changelog entry and the breaking-change doc.
- [ ] 3. Run VERIFY on `sponsor-deals-online.test.ts`, `sponsor-checkout.test.ts`, `sponsor-outbox.test.ts`, `sponsors-public-expiry.test.ts`, `outbox-kind-sweep.test.ts` and `key-scopes.test.ts`. Task 1's known-red list ends here: every file on it must now be green, failed 0 (F4). Run TSC.
- [ ] 4. Mutate. These are **money-path** mutants:
  - Never reuse the session (always mint). Killer: the reuse case.
  - Re-mint without expiring the old open session. Killer: the under-10-minutes case (F3).
  - Mint even when `expire` threw. Killer: the cannot-expire case (F3).
  - Drop the session check before mark-paid. Killer: the completed-session case.
  - Treat `expired` like `complete` on mark-paid. Killer: the expired-proceeds case (F37).
  - `deleteSponsor` skips the session step. Killer: the delete case (F3).
  - Use a constant dedupe key. Killer: the two-sends case.
  - Report the killer list.
- [ ] 5. Commit `feat(sponsors)!: online deals send a reusable Checkout invoice; /sponsor-orders is retired`.

### Task 8: The webhook, refunds and disputes move deals, never sponsors (the inert-seam task)

**Files:**
- Modify: `apps/web/src/server/usecases/sponsors.ts`: `handleSponsorPaymentSucceeded` :633 (today's sponsor insert :654-662), `handleSponsorPaymentFailed` :736, `handleSponsorChargeRefunded` :814 (its direct `sponsors.status` write :840-842), `handleSponsorDispute` :1002 (competition read from the PACKAGE :1021; park :1078-1080; withdraw :1101-1103; won :1148-1151; lost :1160-1163), and `listSponsorRows`' `dispute_parked` (:174-177; it now reads a live deal's `parked_at`).
- Fixtures: none to reshape here. Task 1 already made every `sponsor_orders` insert deal-shaped (F4, F5): `_money-fixtures.ts` (`seedSponsorOrder`), `payments-hardening.spec.ts` (`seedSponsorRig` :374), `p72.ts` (:277), and the direct inserts in `competitions-delete-money.test.ts` (:109) and `dispute-unmatched-retry.test.ts` (:52). If a seed here needs a new shape, add it to `_money-fixtures.ts` under F5's rules (paid = live online `on_payment` deal with its sponsor; pending = sponsor plus `awaiting_payment` online deal).
- Test: `apps/web/src/server/usecases/__tests__/deals-webhook-seam.test.ts` (new); update `apps/web/src/server/usecases/__tests__/{sponsor-dispute.test.ts,sponsor-dispute-outbox.test.ts,sponsor-dispute-clicks.test.ts,sponsors-public-expiry.test.ts}` and `apps/web/src/server/email-outbox/__tests__/{outbox-kind-sweep.test.ts,a-kind-body.test.ts}`.
- Modify (F6), `apps/web/src/server/usecases/__tests__/sponsor-dispute-outbox.test.ts`, case by case (D9 and D8 win, because spec §8a "what a live deal locks" and §5.3 come first):
  - :339 (hand-patches `status`) moves to a no-deal sponsor;
  - :347 becomes "status PATCH on a live-deal sponsor → 409 `sponsor_locked_by_deal`";
  - :501 (expects an organiser "off" to survive a close) is DELETED: it is unreachable now;
  - :516 stages the park through the deal's `parked_at`, not `sponsors.status`;
  - :553 (patches pending after a refund) runs under manual control, since every deal has ended.
- Modify (F8): `sponsors-public-expiry.test.ts` relies on the webhook INSERTING a sponsor; its webhook case now asserts that the deal's EXISTING sponsor goes live (same id) and that the webhook path still busts through `deferred`.

**Interfaces:**
- Consumes `applyDealsToSponsor`, `statusAfterPaid`, and the private `bustPublicSponsors` (same file; F1).
- Produces handler behaviour. The signatures are unchanged, and `billing-events.ts` dispatch (`runEvent` :2991; sponsor dispatch :2852-2898) is untouched.

**Acceptance:**
- **Lock order (F2).** Every handler reads the deal's `sponsor_id` WITHOUT a lock, locks the sponsor `for update`, then that sponsor's deals `for update` ordered `(created_at, id)`, then re-checks the deal's state (Task 5's order). Never "lock the deal" first: a payment on deal B racing End now on deal A of the same sponsor would deadlock (40P01). A legacy row with a null `sponsor_id` locks only itself.
- **Payment succeeded.** If `status` is in (`pending`, `failed`): set paid, `paid_at`, and the intent (`coalesce`), and queue the receipt (unchanged). Then:
  - `ended` (including legacy) → no apply, plus `log.warn({ dealId }, "sponsors: payment on an ended deal")`. A legacy row changes its money columns only (F18);
  - otherwise `deal_status = statusAfterPaid(deal, otherLive)` and apply.
  - **There is no `insert into sponsors` below the `Webhook activation` banner** (:616-618; `createSponsor`'s own insert at :201 sits above it and stays) (F17). A source test enforces it.
  - **A second, DIFFERENT intent succeeding on an already-paid deal (F3)** raises an owner alert AND records a refundable row, never just a log line: the money must stay visible and refundable to the club. D14 makes this rare (the open session is expired before any re-mint), but a race can still land it. The row's shape is a schema call: it must satisfy Task 1's CHECKs, carry the second `payment_intent_id`, and make `allowedActions` offer `refund` on it. Propose the shape to the controller before writing it. The alert is account-addressed, as `sponsor_dispute_alert` is; a new outbox kind needs the `email_outbox_kind_valid` delta that Task 23 describes.
  - **A `DealRuleError` never escapes a handler (F12).** If `statusAfterPaid` refuses the deal's state, record the money columns, leave `deal_status` unchanged, and `log.error` with the deal id. A throw would 500 the webhook and Stripe would retry forever.
- **Payment failed.** `pending` → `failed`. The deal status is unchanged (the sponsor can retry in the same session).
- **Charge refunded.** `paid` → `refunded`, plus `deal_status='ended'`, `ended_reason='refunded'`, `ended_at`, and apply (with `endedDealId` only when the deal was live or open, F7: a refund of an already-ended deal is not a transition, so a hand switch-back-on survives it). The notice is unchanged. It **no longer** writes `sponsors.status` directly (:840-842 goes).
- **Legacy rows (F18).** A legacy row's refund, lost and dispute paths flip its money columns only (`status`, `disputed_at`, `dispute_id`, the refund fields). They never rewrite `deal_status` or `ended_reason`, and never call apply: a legacy row may have a null `sponsor_id`, and rewriting it would violate `sponsor_or_legacy`, so the webhook would 500 forever. Consequence for PR 1's "Data changes": a legacy-activated sponsor is no longer taken down by its legacy order's refund (stg only; prod has none).
- **Disputes.**
  - `created` (formal, not `warning_*`): set `parked_at = coalesce(parked_at, now())` on the deal, then apply.
  - `funds_withdrawn` while THIS dispute is open on a paid deal: the same.
  - Won or `warning_closed` while still paid: `parked_at = null`, then apply.
  - Lost: `status='refunded'`, `deal_status='ended'`, `ended_reason='dispute_lost'`, then apply (with `endedDealId` when it was live or open, F7), then recovery (unchanged).
  - **The dispute audit reads the deal's snapshot `competition_id` (F35),** not the package's (today :1021). Otherwise a deal scoped to C on an "any competition" package audits nothing.
  - All sponsor writes go through apply. The alerts, notices, once-keys and recovery are unchanged.
- **Busting (F1).** Webhooks and disputes keep `deferred`: the inline `deferred(fireOrgRevalidate)` (:674-676, :846-848) and the private `bustPublicSponsors` for disputes. Nobody reads a webhook's result back at once.

**Tests:**
- Unit (DB): `deals-webhook-seam.test.ts`. Every case drives `runEvent(event)` from `server/usecases/billing-events.ts`, never the handler.
  - **S1:** a sponsor with a logo and link, plus an online `on_payment` deal at gold/C/on-stream → `payment_intent.succeeded` → the SAME sponsor id is active/gold/C/on_stream, keeps its logo and link, `resolveSponsors(org, C)` and `resolveSponsors(org, C, { onStream: true })` list it, and `select count(*) from sponsors where org_id` is unchanged.
  - **Second call:** a replay of the same event → no change, and one receipt row.
  - **Anti-goal 2:** online `on_approval` paid → still not listed; approve → listed.
  - **Late payment (Review Focus 1):** `endDealNow` then the payment event → the deal stays `ended`, payment `paid`, the sponsor is not listed, and `allowedActions` includes `refund`.
  - **Refund:** `charge.refunded` on live A while scheduled B exists → A ended/refunded, B live.
  - **Old-deal dispute:** a dispute created on an ENDED old deal while a newer deal is live → the sponsor stays active (D8 reads only the live deal).
  - **Hand switch-back-on survives a late event (F7):** end every deal → switch the sponsor on by hand → `charge.dispute.closed` on the old deal through `runEvent` → the sponsor row is byte-equal.
  - **Park:** formal created → `pending`; won → `active`. An inquiry (`warning_needs_response`) → stays active.
  - **Lost:** → ended `dispute_lost`, sponsor inactive.
  - **Two deals, one sponsor, concurrently (F2):** End now on deal A and a `payment_intent.succeeded` on deal B through `runEvent`, in `Promise.all` → both succeed in some order, no 40P01.
  - **Second intent (F3):** a different intent succeeds on an already-paid deal → one owner alert row and one refundable row, `allowedActions` offers `refund` on it, and the original deal is unchanged. A replay of that event → still one of each.
  - **`DealRuleError` contained (F12):** a payment event on a deal whose state `statusAfterPaid` refuses → the handler resolves (no throw), the money is recorded, `deal_status` is unchanged.
  - **Legacy (F18):** a legacy row with a null `sponsor_id` gets `charge.refunded`, then a lost dispute → only money columns change, `deal_status` / `ended_reason` are byte-equal, and no 500.
  - **Dispute audit scope (F35):** a deal scoped to C on an "any competition" package → the dispute audit names C.
  - **Source guard (F17):** the test slices `server/usecases/sponsors.ts` at the `Webhook activation` banner and asserts `/insert\s+into\s+sponsors\b/i` hits the part above (its positive pair: `createSponsor`'s insert at :201) and misses the part below.
- Update the three dispute tests: their fixtures are already live deals (Task 1). `sponsor-dispute-outbox.test.ts`'s sponsor-status assertions CHANGE where F6 lists them (:339, :347, :501, :516, :553); the park semantics are otherwise preserved.
- E2E: `payments-hardening.spec.ts`'s "created parks the placement", "closed lost writes off", "closed won restores" and "replayed created" run unchanged on the deal-shaped seed. Add a case to `sponsor-deals-api.spec.ts`: `signed payment_intent.succeeded on an online deal shows the SAME sponsor on the public page`. Reuse `payments-hardening.spec.ts`'s signed-event helper `postSignedEvent` (:74, file-local today), moved into `apps/web/e2e/_stripe-events.ts`.
- Smoke: `"sd paid webhook never adds a sponsor row"` (count before and after, around a signed event as `payments-hardening` sends it), on its own sponsor (never `goldId`). p72's guards keep passing on the deal-shaped seed.
- Regression: `dispute-unmatched-retry.test.ts`, `platform-dispute.test.ts`, `competitions-delete-money.test.ts` (the first and last seed by direct insert, made deal-shaped in Task 1, F4); the `seedSponsorOrder` `pending` consumers `billing-events-outbox-replay.test.ts` (:133) and `outbox-kind-sweep.test.ts` (:952) (F5); `sponsors-public-expiry.test.ts` (F8).

**Steps:**
- [ ] 1. Write the seam test and update the dispute tests (F6) and `sponsors-public-expiry.test.ts` (F8). Run VERIFY on the seam test. Expected: FAIL. S1's count is +1, because today's handler inserts.
- [ ] 2. Implement the handler changes. Settle the second-intent row shape with the controller first (F3).
- [ ] 3. Run VERIFY on the seam test, the three dispute tests, `sponsors-public-expiry.test.ts`, `outbox-kind-sweep.test.ts`, `a-kind-body.test.ts`, `billing-events-outbox-replay.test.ts`, `dispute-unmatched-retry.test.ts`, `platform-dispute.test.ts` and `competitions-delete-money.test.ts`. Expected: failed 0. Run TSC.
- [ ] 4. Mutate. These are **money-path** mutants, one per surface:
  - Re-add the sponsor insert. Killers: S1 count and the source guard.
  - `statusAfterPaid` is bypassed (always live). Killer: anti-goal 2.
  - The refund path skips apply. Killer: the refund case.
  - The won path skips clearing `parked_at`. Killer: the park case.
  - Lost skips ending the deal. Killer: the lost case.
  - The payment handler locks the deal before its sponsor. Killer: the two-deals concurrency case (F2).
  - The second-intent guard only logs. Killer: the second-intent case (F3).
  - The legacy refund rewrites `ended_reason`. Killer: the legacy case (F18).
  - The audit reads the package's competition. Killer: the audit-scope case (F35).
  - Report the killer list.
- [ ] 5. Commit `fix(sponsors): a payment moves its deal, and the deal applies to the sponsor; the webhook never inserts a sponsor`.
- [ ] 6. Dispatch E2E. Hand back.

### Task 9: The sweep: expiry, a finished competition, and promotion

**Files:**
- Modify: `apps/web/src/server/usecases/sponsor-deals.ts` (add `sweepSponsorDeals`)
- Create: `apps/web/src/app/api/cron/sponsor-deals/route.ts`
- Modify: `apps/cron-worker/src/schedule.ts` (one `JOBS` row, inserted right after the `funnel-remind` row at :75; `TRIGGER_CRON` :42, rows :65-75) and `apps/cron-worker/test/schedule.test.ts` (:24; `HOURLY` gains `"sponsor-deals"` in that position, F20)
- Test: `apps/web/src/server/usecases/__tests__/sponsor-deals-sweep.test.ts`, `apps/web/src/app/api/cron/sponsor-deals/__tests__/route.test.ts`

**Interfaces:**
```ts
export async function sweepSponsorDeals(now?: Date): Promise<{ checked: number; expired: number; finished: number; promoted: number; failed: number }>;
// JOBS row: { id: "sponsor-deals", path: "/api/cron/sponsor-deals", trigger: TRIGGER_CRON, due: { kind: "every" }, retry: true, manual: true, failureCounts: ["data.failed"] }
```

**Acceptance:**
- The sweep runs on the privileged `sql` connection, per deal in its own transaction. Each transaction takes Task 5's lock order: sponsor first, then its deals ordered `(created_at, id)`, then re-check (F2).
- A live deal with `ends_at <= now` → `ended`/`expired`, then apply (with `endedDealId`).
- **An OPEN deal (draft, awaiting payment or approval, scheduled) with `ends_at <= now` is ended too (F19),** as `expired`. For an online deal, first expire any open Checkout session outside the transaction, with Task 7's session rule (F3): `retrieve`, then `expire` only when `open`; if it cannot be expired, count the deal in `failed` and leave it for the next run.
- **A scheduled deal whose `ends_at` has passed is never promoted (F19):** it is ended as `expired` instead, and the next scheduled deal (if any) is considered.
- A live deal with a competition, no `ends_at`, and `competitionPhase(desk).kind === "finished"` → `competition_finished`, then apply. Call `getCompetitionDesk(ctx, compId)` (`server/usecases/competition-desk.ts:314`; `competitionPhase` :781) BEFORE opening the per-deal transaction: it calls `withTenant` on its own connection. The context is `{ orgId, via: "session", userId: null, role: "viewer", keyId: null }`; this repo synthesizes contexts the same way in `lib/funnel.ts`, `stream-sessions.ts` and `youtube/end-step.ts`.
- A competition with 0 divisions is `setting_up` forever (`competition-desk.ts:787`), so its deal never ends by phase. That is accepted (End now still works) and pinned by a test, so a change is a decision, not an accident.
- A deal that throws is counted in `failed` and logged, and the sweep moves on.
- `checked` counts the live AND open deals examined.
- **Busting (F1):** the sweep keeps `deferred` (nobody reads its result back at once). It does not import `bustPublicSponsors`, which stays private in `usecases/sponsors.ts`: defer `fireOrgRevalidate` inline after its own slug read, as the webhooks do (`usecases/sponsors.ts:674-676`).
- The route follows `api/cron/registrations/route.ts`: `x-cron-secret` against `CRON_SECRET`, 401/503, then `handler`. `CRON_SECRET` is set in CI for e2e (`.github/workflows/e2e.yml:623`, the e2e-parallel job) and smoke (`ci.yml:1388`).

**Tests:**
- Unit (DB): `sponsor-deals-sweep.test.ts`.
  - **Empty case first:** no live or open deals → `{ checked: 0, … }`. That is not a failure here, because the empty case is the subject; the next case is the anti-vacuity one.
  - Two live deals, one with `ends_at = now - 1 min` and one with `now + 1 day` → `checked` 2 and `expired` 1. The expired sponsor is not listed by `resolveSponsors`; the other still is.
  - **The boundary (added here: it is the `<=` mutant's killer):** `ends_at = now` exactly → expired.
  - **Second call:** the sweep twice → `expired` 1, then 0.
  - **Open past its end (F19):** an online awaiting_payment deal with `ends_at` passed and an open session → the session is expired (1 `expire` call, Stripe stubbed as in Task 7), the deal ends `expired`.
  - **Scheduled past its end (F19):** live A ends by expiry while scheduled B's own `ends_at` has also passed → B ends `expired` and is never live (its `live_at` stays null).
  - **Competition finished:** a deal scoped to C with every division finished (seeded with the competition-desk test rig) → `competition_finished`. Its positive pair: C with one division still scheduled → untouched.
  - **Zero divisions:** a deal scoped to a competition with no divisions → untouched (pinned).
  - **Moving dates moves the end** (§8a): C finished with its `ends_on` changed into the future → still ended (phase, not date).
  - Promotion after expiry → the scheduled deal goes live.
- Unit: `route.test.ts`. No secret → 401; the wrong one → 401; the right one → 200 with the counts.
- Unit: `apps/cron-worker/test/schedule.test.ts` with the updated `HOURLY` (the row sits right after `funnel-remind`, so the `[...HOURLY, "ai-previews"]` expectations at :49-51 hold, F20), run from `apps/cron-worker` with `npx vitest run test/schedule.test.ts test/drift.test.ts`.
- E2E: `sponsor-deals-api.spec.ts`, `an org-wide deal whose end date has passed comes off the public page after the cron route runs`. Seed `ends_at` in the past through SQL (the end-date INPUT is proven in Task 16), then POST the route with `CRON_SECRET`.
- Smoke: `"sd cron route refuses a wrong secret (401)"` and `"sd cron route answers counts (200)"`.
- Regression: `apps/cron-worker/test/drift.test.ts` (no new trigger).

**Steps:**
- [ ] 1. Write the tests. Run VERIFY on the two web tests. Expected: FAIL, missing.
- [ ] 2. Implement.
- [ ] 3. Run VERIFY on the two web tests and the cron-worker pair. Run TSC on the web files and on `apps/cron-worker/src/schedule.ts`.
- [ ] 4. Mutate:
  - `<=` → `<` on `ends_at`. Killer: the `ends_at = now` boundary case.
  - Skip the competition branch. Killer: the finished case.
  - Promote a scheduled deal without checking its `ends_at`. Killer: the scheduled-past-its-end case (F19).
  - Sweep live deals only. Killer: the open-past-its-end case (F19).
  - Restore after each.
- [ ] 5. Commit `feat(sponsors): an hourly sweep ends expired and finished-competition deals and promotes the next`.

### Task 10: Deleting a competition with deals

**Files:**
- Modify: `apps/web/src/server/usecases/competitions.ts` (beside the `paidSponsor` guard, :905-918)
- Modify: `scripts/smoke/suites/p72.ts`
- Test: `apps/web/src/server/usecases/__tests__/sponsor-order-delete-guards.test.ts` (extend)

**Acceptance.** Before today's sponsor guard: 409 `"competition has sponsor deals — end them or archive it instead"` when `exists (select 1 from sponsor_orders where competition_id = :id and ended_reason is distinct from 'legacy')`, or `exists (select 1 from sponsors s join sponsor_orders o on o.sponsor_id = s.id where s.competition_id = :id and o.ended_reason is distinct from 'legacy')`. Today's legacy-package sweep (:923-926) stays: legacy pending rows are still swept through the package join, and paid legacy rows still 409 at :905-918.

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
- [ ] 3. Run VERIFY on `sponsor-order-delete-guards.test.ts` and `competitions-delete-money.test.ts`. Expected: failed 0. Both seed by direct insert (:69 and :109), which Task 1 made deal-shaped (F4); a red from a legacy-shaped insert means Task 1's fixture work is incomplete, so fix it there, not here. Run TSC.
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
  - `patchSponsor` (status on/off, tier, on_stream) (F7): it is legal under manual control and 409 while a deal locks it, so the model sees the hand switch-back-on;
  - `runEvent(payment_intent.succeeded)`, `runEvent(charge.refunded)`, `runEvent(charge.dispute.created|closed won|closed lost)`;
  - `sweepSponsorDeals(now + k days)`.
- Commands illegal in the current state are expected to throw `HttpError` 409/422, and must leave the SPONSOR tables byte-equal to before: `sponsors`, `sponsor_orders`, `sponsor_packages` and `sponsor_stream_settings`. Byte-equality is scoped to those tables because `runEvent` writes the billing-events ledger (F36). Task 6 maps every `DealRuleError` to `HttpError` (F12), so a `DealRuleError` reaching this test is a failure.
- `numRuns: 30`. Stripe is stubbed as in Task 7.
- **The model records, at each `createDeal`, the package's `tier` and `includes_on_stream` at that moment** (F36), so I8 compares the deal against a value the code under test did not produce.
- **Invariants after EVERY step:**
  - (I1) at most one live deal per sponsor;
  - (I2) restated (F7): for a sponsor with at least one live or open non-legacy deal, the sponsor is `active` ⇔ it has a live, unparked deal. A sponsor whose deals have ALL ended is under manual control (spec §10 Q3), so I2 does not bind it; instead, a step that is not that sponsor's transition into all-ended leaves its row byte-equal unless the step was a `patchSponsor` on it;
  - (I3) an active sponsor's tier, competition_id and on_stream equal its live deal's snapshot;
  - (I4) the org's sponsor row count never changes;
  - (I5) no live deal has `go_live='on_approval'` and `approved_at` null;
  - (I6) no live deal has `go_live='on_payment'` and payment `pending`;
  - (I7) a deal with payment `refunded` is `ended`;
  - (I8) every deal's snapshot `tier` and `includes_on_stream` equal the values the model recorded from its package at creation (F36). Without it, I3 only compares two outputs of the code under test.
- The test reports `stepsChecked` and fails if it is < 100 across the run (anti-vacuity).
- A failure is committed as a named regression case with its seed BEFORE any fix.

**Tests:**
- Unit (DB): the file itself.
- E2E, smoke: n/a. This is the model layer under Tasks 6 to 9's e2e and smoke.
- Regression: any shrunk counterexample becomes a named case in this file.

**Steps:**
- [ ] 1. Write the test. Run VERIFY. Expected: PASS. Record `stepsChecked`.
- [ ] 2. Mutation check (a true red is impossible on a property over correct code): break I6's guard by making `statusAfterPaid` always `live`. It must fail and shrink. Restore. Do the same for promotion (Task 5 mutant), for apply's step 6 writing on every all-ended apply (F7; killer: I2), and for `createDeal` snapshotting a constant tier (F36; killer: I8). Report the four killer seeds.
- [ ] 3. Commit `test(sponsors): model-based deal sequences — eight invariants after every step`.

### Task 12: Today's screens keep working (the transitional UI)

**Files:**
- Modify: `apps/web/src/components/sponsor-packages.tsx`:
  - the Send invoice form's "Sponsor name" text input becomes a `<select>` of the org's sponsors, and it POSTs `/sponsors/{id}/deals` with `{ package_id, competition_id: pkg.competition_id, payment_method: "online", go_live: "on_payment", sponsor_email }`;
  - it reads the pay link from the create response `{ deal, checkout_url }` (F11). Today it reads `result.checkout_url` (:243-244) from the old order response; `SponsorDeal` itself carries no url;
  - the orders list reads `GET /sponsor-deals`;
  - Refund and Evidence use the new paths.
- Modify: `apps/web/src/components/org-sponsors.tsx` (tier, competition and status controls are disabled with a "Set by the live deal" note when `locked_by_deal`; the status control is ALSO disabled when `has_open_deal`, because that PATCH answers 409 `sponsor_has_open_deal`; the delete guard reads `has_open_deal` / `paid_order_id` (:37, :372, :508)).
- Modify: `apps/web/src/components/sponsors/on-stream-tab.tsx` (a locked sponsor's tick is disabled, with a "Set by the deal" reason). Its `OnStreamSponsor` type gains `locked_by_deal` (F24).
- Modify: `apps/web/src/app/o/[orgSlug]/sponsors/page.tsx` (pass `listSponsorRows` to Packages for the picker). The page maps the OnStreamTab fields one by one (:114-121): add `locked_by_deal` to that map (F24), or the tick never learns it is locked.
- Modify (F8): `apps/web/src/components/__tests__/superseded-mount-fetch.test.tsx` mounts `SponsorPackages` (:44) and answers `/sponsor-orders` (:157-169); it now answers `GET /sponsor-deals`.
- Dictionaries ×4: `sponsors.deal.lockedNote`, `sponsors.order.sponsorPick`.
- Test: `apps/web/src/components/__tests__/sponsor-packages-picker.test.tsx`; `apps/web/e2e/walkthrough/settings-sponsor-monetize.spec.ts` (updated: the "sell" and "invoice" legs, and the UI path of the "paid" (:609) and "refund" (:746) legs, F8)

**Acceptance:**
- No new page or pattern: the picker uses the form's existing `<select>` styling.
- The duplicate-invoice confirm (`sponsors.order.dupConfirm.*`) now fires when the chosen sponsor has an open deal on this package.
- **Use frontend-design.** Verify at 320, 768 and 1280: the picker and the disabled controls fit, and nothing scrolls sideways.

**Tests:**
- Unit: `sponsor-packages-picker.test.tsx` (`renderIsland`).
  - The picker opens at the first sponsor by `display_order`.
  - It POSTs `sponsor_id`, not `sponsor_name`.
  - It opens the pay link from the create response's `checkout_url` (F11).
  - **The empty case:** with no sponsors, the form shows "Add a sponsor first" and no Send button.
- E2E: the walkthrough's "sell" and "invoice" tests now create a sponsor first and pick it. The "REAL Stripe Checkout Session" assertion is unchanged. Its "paid" (:609) and "refund" (:746) legs drive the new picker too (F8). Add `the On stream tab's tick is disabled for a sponsor with a live deal` to `sponsor-deals-api.spec.ts`, as a page-level test: it is the real proof that `locked_by_deal` crosses the page map (F24).
- Smoke: `"sp hub Packages tab renders the sell console for an editor"` stays green.
- Regression: `apps/web/e2e/sponsors-hub.spec.ts` (unchanged in PR 1); `components/sponsors/__tests__/on-stream-tab.test.tsx`; `components/__tests__/superseded-mount-fetch.test.tsx` (F8).

**Steps:**
- [ ] 1. Invoke frontend-design. Write the tests. Run VERIFY on the vitest files. Expected: FAIL.
- [ ] 2. Implement, adding the strings ×4. Run `npm run i18n:gen-keys` and `npm run i18n:check`.
- [ ] 3. Run VERIFY on `sponsor-packages-picker.test.tsx`, `on-stream-tab.test.tsx`, `superseded-mount-fetch.test.tsx` and the dictionary copy-truth and retired-plan-copy tests. Run TSC.
- [ ] 4. Mutate: the picker sends `sponsor_name`. Killer: the POST-body case. Restore.
- [ ] 5. Commit `feat(sponsors): today's sell console picks a sponsor; deal-locked controls say why`.
- [ ] 6. Dispatch E2E. Open the PR with these sections, then hand back:
  - "Data changes": D1, D2, D6, premise 1's flip, and F18's consequence (a legacy-activated sponsor is no longer taken down by its legacy order's refund; stg only, prod has none).
  - "Breaking API".
  - "Deviations": D5 drops `starts_at`, which spec §5.1 lists (F34, sanctioned: it has no producer, and the §8a queue covers delayed starts).
  - "Migration number": the delta's `<n>` is picked at merge; V493 and V497 are held by open branches, so coordinate before merging (F26).

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
- The page's Sponsors tab loads `listSponsorRows`, `listDeals(auth)` for the org (`requireOrgPage` returns `auth`, `server/page-auth.ts:136-137`), `listSponsorPackages`, `hasFeatureOnAnyPass(…,"sponsors.tiers")`, `hasFeatureOnAnyPass(…,"sponsors.monetize")`, `organizations.stripe_charges_enabled`, the competitions (with `ends_on`), and the report links when `sponsor` is set. The page's loaders are at `page.tsx:65-121`; `orgCompetitions` (:37) returns id and name only today, so it gains `ends_on`.
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
- Unit (page): `page.test.tsx`. `?sponsor=<foreign>` renders the list. The `?sponsor=<own>` → `data-testid="sponsor-sheet"` assertion is NOT here: that testid belongs to Task 15's `sponsor-sheet.tsx`, so the assertion moves to Task 15 (F23). This task asserts that `?sponsor=<own>` resolves (`resolveSponsorParam` returns the id the page passes on).
- E2E: Task 15 drives the URL.
- Smoke, in `sponsorDeals.ts`: `"sd hub ?sponsor=<foreign> falls back to the list"`. The `"sd hub ?sponsor=<id> renders the sponsor page (200, sponsor-sheet)"` row moves to Task 15 (F23).
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
- The action buttons call the Task 6 and 7 routes. "Open deal" and "Add deal" navigate (`dealHref`, or open Task 16's sheet). Until Task 16 lands, "Add deal" navigates to `sponsorHref(slug, id)` as its stub target; Task 16 swaps in the sheet.
- The row's one action follows `rowNextAction`'s precedence (Task 2, F15): a draft or scheduled row shows "Open deal", never "Send invoice".
- `DealChip` reuses `components/ui/status-chip.tsx`'s chip classes and tokens, with no new colours.

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
- Test: `apps/web/src/components/sponsors/__tests__/sponsor-sheet.test.tsx`, `apps/web/src/components/__tests__/modal.test.ts` (extend), `apps/web/src/app/o/[orgSlug]/sponsors/__tests__/page.test.tsx` (extend: the `sponsor-sheet` assertion moved from Task 13, F23); modify `scripts/smoke/suites/sponsorDeals.ts` (the row moved from Task 13, F23)

**Acceptance (mockup screen 2, option B):**
- With `sponsor` set, the list wrapper gets `max-md:hidden`, and `SponsorSheet` renders as the page body on phones (a back link "← Sponsors" to `sponsorsHref(slug,"sponsors")`) and as `Modal placement="side"` at ≥md. Closing it means navigating to the list URL.
- **Details:** name, logo and link are editable. On stream is a toggle, disabled with the `sponsors.deal.lockedNote` reason when locked. Tier and scope follow D9 (F28):
  - **live deal:** the deal's tier and scope are shown read-only, with `sponsors.deal.lockedNote`;
  - **open (non-live) deal:** tier and scope stay editable, with the line "Tier now X. Y when the deal goes live" (mockup), because that copy describes what an OPEN deal will change;
  - **no deal, or every deal ended:** tier and scope are editable, with no note.
- **Deals:** the current deal and the past deals (`listDeals` filtered to the sponsor, newest first), each with its chip, amount, scope line and actions, plus "Add deal".
- **Report link:** PR A's `ShareReport` for this sponsor.

**Tests:**
- Unit:
  - The sheet with a live-deal sponsor → the tier and scope controls are absent, the deal's tier and scope read-only with `lockedNote`, and NO "Tier now" line (F28). With an open deal → the controls are present AND the "Tier now X. Y when the deal goes live" line. The positive pair: a no-deal sponsor → the controls are present with no note.
  - **The empty case:** no deals → "No deals yet" plus Add deal.
  - Modal: `placement="side"` adds the md side classes and leaves the `max-md:` ones unchanged (a class-string test; the anchors avoid `/\bmd:hidden\b/`).
- Unit (page, moved from Task 13, F23): `apps/web/src/app/o/[orgSlug]/sponsors/__tests__/page.test.tsx`: `?sponsor=<own>` renders `data-testid="sponsor-sheet"`.
- E2E:
  - `sponsor page: phones get their own page with back; desktop a side sheet over the list` (1280 and 390 in one test via `page.setViewportSize`);
  - `sponsor page: a live deal's tier and stream are read-only; name and link save`.
- Smoke, in `sponsorDeals.ts` (moved from Task 13, F23): `"sd hub ?sponsor=<id> renders the sponsor page (200, sponsor-sheet)"`.
- Regression: `components/__tests__/modal.test.ts`, and `components/sponsors/__tests__/share-report.test.tsx`.

**Steps:**
- [ ] 1. Invoke frontend-design. Write the tests. Run VERIFY (FAIL), then implement, then VERIFY again. Run TSC. Run i18n gen and check.
- [ ] 2. Mutate: render the tier select while locked. Killer: the locked case. Then show the "Tier now" line for a live deal. Killer: the live-deal case (F28). Restore after each.
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
- **Scope select:** "Whole organisation", then the org's competitions. It is locked to the package's competition when it has one. **On community (F29),** each competition option for which `placementNeedsTiers(pkg.tier, scope)` is true is disabled, with the tier upgrade hint (`routes.billing(slug)`), so a community user cannot pick a competition and meet a 402. Gating only the package card is not enough: the predicate takes the scope.
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
  - (c) community → offline/on_payment, online locked with the upgrade hint, gold card locked, and every competition option in the scope select disabled with the tier upgrade hint (F29); its positive pair: on Pro the competition options are enabled;
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
  - The scope select ignores `placementNeedsTiers`. Killer: (c)'s disabled competition options (F29).
  - Restore after each.
- [ ] 3. Commit `feat(sponsors): the Add deal sheet — package, scope, payment, go-live, and a summary that says what will happen`.

### Task 17: The deal page

**Files:**
- Create: `apps/web/src/components/sponsors/deal-page.tsx`
- Dictionaries ×4: `sponsors.deal.timeline.*`, `sponsors.deal.goingLive.*`, `sponsors.deal.confirm.*`
- Test: `apps/web/src/components/sponsors/__tests__/deal-page.test.tsx`

**Acceptance (mockup screen 5):**
- The header shows the package, the price, the sponsor and the chip.
- The action buttons are exactly `allowedActions(deal)`, in `DEAL_ACTIONS` order (F27): Send invoice, Resend invoice, Mark as paid, Approve, Refund, End now, each only when offered.
- **The one exception: Evidence pack** (the moved route) is rendered AFTER them, when `disputed_at` is set. It is not a `DealAction`; it is no longer reachable from anywhere else, so dropping it would be a regression.
- **Timeline:** `dealTimeline`.
- **The "Deal" facts block:** package and tier, scope, payment, the invoice email, the go-live rule.
- **"Going live will":** "Set the tier to X", "Show them on your public pages", and "Put them on stream" or "On stream is not in this package", then "A refund or the end date switches these off again."
- **Confirms:** Refund reuses the `sponsors.order.refundConfirm.*` copy, re-keyed under `sponsors.deal.confirm.refund.*` with "deal". End now confirms "Tier, page and stream switch off now". Mark as paid on an online deal confirms that the pay link will stop working.
- The phone and desktop presentation is the same as Task 15 (`&deal=`).

**Tests:**
- Unit:
  - The action set equals `allowedActions` for 6 seeded states typed from the mockup (paid Awaiting approval → Approve, Refund, End now; offline Awaiting payment → Mark as paid, End now; …), in that rendered ORDER, which is `DEAL_ACTIONS` order (F27). The count is asserted.
  - Evidence is present only when disputed, and always last, with its positive pair.
  - **The empty case:** a legacy deal opened by id → the read-only view with no actions.
- E2E:
  - `deal page: Approve puts them live and the timeline moves from "Not yet" to the live date`;
  - `deal page: End now asks, then takes them off the public page`;
  - `deal page: Refund (offline) records it, no card copy` (the confirm text for offline does not mention a card).
- Smoke: `"sd hub &deal=<id> renders the deal page"`.
- Regression: `payments-hardening.spec.ts` (evidence pack route path change).

**Steps:**
- [ ] 1. Invoke frontend-design. Write the tests. Run VERIFY (FAIL), then implement, then VERIFY again. Run TSC. Run i18n gen and check.
- [ ] 2. Mutate: render Refund for complimentary. Killer: the action-set test. Then render the actions in a hand-written order. Killer: the order assertion (F27). Restore after each.
- [ ] 3. Commit `feat(sponsors): the deal page — a timeline and only the actions that apply`.

### Task 18: Packages become a price list; the transitional UI goes

**Files:**
- Create: `apps/web/src/components/sponsors/package-list.tsx`
- Delete: `apps/web/src/components/sponsor-packages.tsx` and `apps/web/src/components/__tests__/sponsor-packages-picker.test.tsx`
- Modify: `apps/web/src/app/o/[orgSlug]/sponsors/page.tsx`
- Modify: dictionaries ×4 (`sponsors.hub.tab.packages`: "Packages and orders" → "Packages" in en; es, fr and nl translated; the `sponsors.order.*` keys that are no longer read are removed)
- Modify: `apps/web/content/help/sharing/{sponsors.md,sponsors-hub.md}`
- Test: `apps/web/src/components/sponsors/__tests__/package-list.test.tsx`; update `apps/web/e2e/sponsors-hub.spec.ts` and `scripts/smoke/suites/sponsors.ts` (the hub Packages rows :383-386 and :442-445)
- Modify (F8: each goes red when `sponsor-packages.tsx` and the "Packages and orders" label go):
  - `apps/web/src/app/o/[orgSlug]/sponsors/__tests__/page.test.tsx` (the mock props at :117-119 and the "Packages and orders" heading at :293-297);
  - `apps/web/src/app/o/[orgSlug]/sponsors/__tests__/pass-scope-sponsors.test.tsx` (:47, :159-167);
  - `apps/web/src/components/__tests__/superseded-mount-fetch.test.tsx` (:44: it mounts `SponsorPackages`; mount `PackageList` or drop that case, keeping the file's superseded-fetch intent);
  - `apps/web/src/lib/__tests__/_approved-copy.ts` (:400 cites the deleted `components/sponsor-packages.tsx`; the path-citation check at `lib/__tests__/help-copy-truth.test.ts:1592-1598` reds on it);
  - `apps/web/e2e/walkthrough/sponsors-capture.spec.ts` (:194: check whether its testid is one this task removes; repoint it if so);
  - `apps/web/e2e/walkthrough/settings-sponsor-monetize.spec.ts`: the "paid" (:609) and "refund" (:746) legs read the Packages panel's orders list, which goes; they read the deal from the Sponsors tab or the deal page instead.

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
- Regression: the help-copy-truth test (if it pins tab names); `retired-plan-copy.test.ts`; and the F8 files above: `page.test.tsx`, `pass-scope-sponsors.test.tsx`, `superseded-mount-fetch.test.tsx`, `help-copy-truth.test.ts` (via `_approved-copy.ts`). The two e2e specs run in the dispatched E2E.

**Steps:**
- [ ] 1. Invoke frontend-design. Write the tests. Run VERIFY (FAIL), then implement, then VERIFY again on `package-list.test.tsx` and the four F8 vitest files. Run TSC. Run i18n gen and check.
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
- Create: `db/migration/deltas/V<n>__sponsor_invoices.sql` (`<n>` picked at merge, above whatever PR 1 and the open branches holding V493 and V497 took; F26), `apps/web/src/server/sponsors/invoice-number.ts`
- Modify: `apps/web/src/server/usecases/sponsor-deals.ts` (`createDeal` allocates a number for online and offline)
- Modify: `apps/web/src/server/usecases/sponsors.ts` (`deleteSponsor` :283: a numbered deal blocks the delete, F10)
- Modify: `apps/web/src/lib/sponsor-deals.ts` (add `formatInvoiceNumber`)
- Test: `apps/web/src/server/sponsors/__tests__/invoice-number.test.ts`, `apps/web/src/server/sponsors/__tests__/invoices-migration.test.ts`; extend `apps/web/src/server/usecases/__tests__/sponsor-lock.test.ts` (F10)

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
- **A numbered deal blocks sponsor delete (F10).** The prune fence makes a numbered deal undeletable by `app_user`, but Task 5's `deleteSponsor` deletes draft and awaiting deals before the sponsor. After this task, that RLS delete would silently remove 0 numbered rows, and the sponsor delete would then hit the RESTRICT FK: a 23503, which is a 500. So `deleteSponsor`'s guard also answers 409 `sponsor_has_deal_history` when any of the sponsor's deals has `invoice_number is not null`. Spec §7: numbers are never reused, so a numbered deal is history. (The club can End the deal and keep the sponsor.)

**Tests:**
- Unit (DB): `invoice-number.test.ts`.
  - **Empty case first:** the first number for a new org is 1.
  - Interleaving org A and org B → A: 1, 2, 3 and B: 1, 2.
  - 10 concurrent allocations for one org → exactly the set {1..10} (the race).
  - A rolled-back allocation → the next is still the same number.
  - A numbered draft deal cannot be deleted by `app_user`; its twin, an unnumbered draft, can (the prune fence).
  - `formatInvoiceNumber` at 1, 9999 and 12345.
- Unit (DB): `sponsor-lock.test.ts` (F10): a sponsor whose only deal is a NUMBERED draft → `deleteSponsor` answers 409, not a 500, and the sponsor and deal still exist. Its twin: an unnumbered open deal (complimentary after-approval, `awaiting_approval`, which never gets a number) → deleted with its deal.
- Unit (DB): `invoices-migration.test.ts` (by suffix): the constraint names, each with an accepted twin. RLS: org A cannot read org B's counter.
- E2E, smoke: Task 24.
- Regression: `deals-migration.test.ts`, `sponsor-order-delete-guards.test.ts`.

**Steps:**
- [ ] 1. Write the tests. Run VERIFY (FAIL), then implement, then VERIFY again on `invoice-number.test.ts`, `invoices-migration.test.ts`, `sponsor-lock.test.ts` and the two regression files. Run TSC.
- [ ] 2. Mutate: allocate outside the transaction. Killer: the rollback case. Then drop the `invoice_number is not null` arm from the delete guard. Killer: the numbered-draft 409 case (F10). Restore after each.
- [ ] 3. Commit `feat(db): per-org sponsor invoice numbers and invoice details`.

### Task 21: "Sponsor invoices" details in Settings → Payments

**Files:**
- Create: `apps/web/src/components/org-sponsor-invoice-details.tsx`
- Modify: `apps/web/src/app/o/[orgSlug]/settings/connect/page.tsx`, `apps/web/src/app/api/orgs/[id]/route.ts` (`orgPatchSchema`, a union of single-key strict arms at :23-67, gains `{ sponsor_invoice_address: z.string().max(1000).nullable() }` and `{ sponsor_invoice_bank_details: z.string().max(2000).nullable() }`, each its own strict arm, the same shape as `payment_instructions`)
- Dictionaries ×4: `settings.sponsorInvoices.*`
- Test: `apps/web/src/app/api/orgs/[id]/__tests__/route.test.ts` (extend), `apps/web/src/components/__tests__/org-sponsor-invoice-details.test.tsx`

**Acceptance:**
- The card has two plain textareas ("Address on invoices", "Bank details for offline invoices") with the hint "Printed on every sponsor invoice. Online invoices also carry a pay link." Saved with the same guard as `payment_instructions`.
- **Saving both fields takes two sequential PATCHes (F30):** the arms are single-key, so the island sends one PATCH per changed field, in order, and reports success only when both answer 200. No combined arm is added.
- It renders on every plan.

**Tests:**
- Unit: the PATCH accepts each arm; null clears. **It refuses an unknown key sent beside a VALID arm (F30):** the body `{ sponsor_invoice_address: "…", foo: 1 }` → 400. A body of `{ foo: 1 }` alone does not kill the passthrough mutant, because no arm matches it anyway.
- Unit (island): it opens at the stored values; saving sends only the changed field; changing both sends two PATCHes in sequence (F30).
- E2E: `apps/web/e2e/walkthrough/sponsor-invoices.spec.ts`, `invoice details save on Settings → Payments and appear on the next offline invoice` (Task 24's walkthrough).
- Smoke: `"sd settings Payments renders the Sponsor invoices card"`.
- Regression: `app/api/orgs/[id]/__tests__/route.test.ts`'s existing arms; `apps/web/e2e/walkthrough/settings-org-tabs.spec.ts`.

**Steps:**
- [ ] 1. Invoke frontend-design. Write the tests. Run VERIFY (FAIL), then implement, then VERIFY again. Run TSC. Run i18n gen and check.
- [ ] 2. Mutate: the strict arm is loosened to `.passthrough()`. Killer: the valid-arm-plus-unknown-key case (F30). Restore.
- [ ] 3. Commit `feat(settings): sponsor invoice address and bank details on Payments`.

### Task 22: The invoice document, as a page, a PDF and pay-on-demand

**Files:**
- Create: `apps/web/src/server/sponsors/{invoice-doc.ts,invoice-pdf.ts}`, `apps/web/src/components/sponsors/invoice-view.tsx`, `apps/web/src/app/(public)/r/sponsor/invoice/[token]/{page.tsx,not-found.tsx}`, `apps/web/src/app/(public)/r/sponsor/invoice/[token]/pdf/route.ts`, `apps/web/src/app/(public)/r/sponsor/invoice/[token]/pay/route.ts`, `apps/web/src/app/api/v1/orgs/[id]/sponsor-deals/[dealId]/invoice.pdf/route.ts`
- Modify: `apps/web/src/lib/scrub-score-url.ts` (the token after `/r/sponsor/invoice/`; today's `/r/sponsor/` handling is :168-177, `SECRET_PATH` :199), and the `SECRET_PATH_ROUTES` verdicts in `apps/web/src/lib/__tests__/scrub-path-secrets.test.ts`
- Modify: `apps/web/src/server/usecases/sponsor-deals.ts` (`createDeal` mints the invoice token for a numbered online or offline deal; `sendDealInvoice` mints it for an online deal that has none) (F9)
- Modify (F8): `apps/web/src/server/api-v1/key-scopes.ts` (the console `sponsor-deals/[dealId]/invoice.pdf` route goes in `NEVER_KEY_ROUTES`, :341-357) and `apps/web/src/server/api-v1/openapi.ts` (its entry beside the sponsor rows, :257-263), then `openapi/v1.json` (OPENAPI)
- Dictionaries ×4: `sponsors.invoice.*` (document labels: Invoice, Number, Date, Billed to, From, Description, Amount, Paid, Unpaid, Pay by card, Bank details, the expired or invalid link page)
- Test: `apps/web/src/server/sponsors/__tests__/{invoice-doc.test.ts,invoice-pdf.test.ts}`, `apps/web/src/app/(public)/r/sponsor/invoice/[token]/__tests__/{page.test.tsx,route-shape.test.ts}`; `apps/web/src/server/api-v1/__tests__/key-scopes.test.ts` (:228 requires every v1 route file to be classified, F8)

**Interfaces:**
```ts
export interface SponsorInvoiceDoc { number: string; issuedOn: string; org: { name: string; address: string | null; logoPath: string | null };
  billedTo: { name: string; email: string | null }; line: { description: string; amountCents: number; currency: string };
  state: "paid" | "unpaid" | "refunded" | "void"; method: PaymentMethod; bankDetails: string | null; payable: boolean; locale: Locale }
export async function mintInvoiceToken(tx: Tx, dealId: string): Promise<string>;              // F9: 32 random bytes (mintReportToken, server/sponsors/report-token.ts:9);
                                                                                              //   stores hashReportToken (:14) in invoice_token_hash; returns the raw token
export async function invoiceDocByToken(token: string): Promise<SponsorInvoiceDoc | null>;   // hash lookup (hashReportToken), privileged sql
export async function invoiceDocForDeal(auth: AuthCtx, dealId: string): Promise<SponsorInvoiceDoc>;
export async function invoicePdf(doc: SponsorInvoiceDoc): Promise<Buffer>;                   // pdfkit; resolveLogo (:33) + MARGIN (:19) from server/doc-render.ts
export async function payInvoice(token: string, origin: string): Promise<string>;            // Checkout url from ensureDealCheckout (Task 7, F32): reuse, else expire-and-mint
```

**The token's producer (F9).** This task mints the token, so the page has a real producer the day it ships:
- `createDeal` calls `mintInvoiceToken` in its transaction for every numbered (online or offline) deal;
- `sendDealInvoice` calls it for an online deal that has no token yet;
- complimentary deals get none;
- the raw token leaves only through `mintInvoiceToken`'s return value. Task 23 puts it in the email and rotates it on Resend. Tests here capture it by wrapping `mintInvoiceToken` (`vi.mock` with `importOriginal`), so the REAL `createDeal` feeds the REAL `invoiceDocByToken`.

**Acceptance:**
- **The state.** `paid` when `payment_status='paid'`; `refunded`; `void` when the deal ended unpaid; else `unpaid`.
- **Payable.** True only for online, unpaid, non-ended deals.
- **Bank details.** Printed for offline. Also printed for online when set (a sponsor may transfer).
- **The line.** "<package name> sponsorship — <scope or 'All competitions'>".
- **Language.** The org's `default_locale`.
- **Pay (F32).** `payInvoice` gets its session from Task 7's `ensureDealCheckout`, the one reuse-or-expire-and-mint rule. It never restates that rule.
- **Scrubbing (F21).** In `SECRET_PATH_ROUTES`, `"/r/sponsor/invoice/"` must come BEFORE `"/r/sponsor/"`. JS alternation takes the leftmost match, so the shorter prefix first would scrub the segment "invoice" and leave the token in the URL.
- **The page** follows PR A's `/r/sponsor/[token]/page.tsx` contract exactly (`app/(public)/r/sponsor/[token]/page.tsx:13,32-33,41`):
  - `force-dynamic`, noindex, nofollow, no referrer;
  - `publicRateLimit` BEFORE the lookup;
  - an unknown, rotated or malformed token is the same opaque 404;
  - `ph-no-capture` on the painted token.
- **The routes.** The PDF route returns `application/pdf` with `Content-Disposition: attachment; filename="<number>.pdf"`. The pay route is POST only (303 → Checkout); it refuses with 409 a non-payable invoice and never mints.
- **The console route** `GET /sponsor-deals/{id}/invoice.pdf` is "read" auth. It is classified in `key-scopes.ts` (`NEVER_KEY_ROUTES`) and has an `openapi.ts` entry (F8).

**Tests:**
- Unit (DB): `invoice-doc.test.ts`. Every token comes from the REAL `createDeal` / `sendDealInvoice` through the wrapped `mintInvoiceToken` (F9); no test inserts a hash by hand.
  - **Empty case first:** an unknown token → null.
  - Online unpaid → payable, no bank details unless set.
  - Offline → bank details, not payable.
  - After the webhook pays → `paid`, not payable.
  - After a refund → `refunded`.
  - Ended unpaid → `void`.
  - Complimentary has no token at all (`mintInvoiceToken` is never called for it).
  - An online deal with no token (as a deal made before PR 3 has) gets one on its next `sendDealInvoice`, and that token resolves; a deal that already has one keeps it (rotation is Task 23's).
  - (Rotation on Resend is Task 23's case, not this task's.)
- Unit: `invoice-pdf.test.ts` (pdfkit text extraction, as in `scorer-sheet-pdf.test.ts`): the PDF text contains the number, the org name and address, the amount, and "Unpaid", "Paid" or the bank details per state. Each state is asserted, 4 counted.
- Unit: `page.test.tsx` and `route-shape.test.ts`, modelled on PR A's `/r/sponsor/[token]` tests: the throttled screen, the opaque 404, and the metadata robots.
- Unit (F21): the `scrub-path-secrets` verdict for `/r/sponsor/invoice/[token]`, `/pdf` and `/pay`. Each case asserts the scrubbed URL no longer contains the TOKEN itself, not only that something was scrubbed.
- **Money:** the pay route reuses an unexpired session (one `create` call across two POSTs), expires an open session before re-minting one that has under 10 minutes left (through `ensureDealCheckout`, F32), and refuses when paid.
- Unit: `key-scopes.test.ts` classifies the new console route (F8).
- E2E: the Task 24 walkthrough.
- Smoke:
  - `"sd invoice page 404 for an unknown token"`;
  - `"sd console invoice.pdf is application/pdf (read auth)"` (the console route for a numbered offline deal the row creates on its own sponsor);
  - `"sd pay refuses a paid invoice (409)"`.
  - The smoke row that opens the PUBLIC pdf through a real emailed token belongs to Task 23, where the email first carries the link (F9).
- Regression: `apps/web/src/__tests__/proxy-matcher.test.ts`, `routes.test.ts`, `scrub-path-secrets.test.ts`, `sentry-replay-guard.test.ts`, `key-scopes.test.ts`.

**Steps:**
- [ ] 1. Invoke frontend-design (for `invoice-view.tsx` and the PDF layout). Write the tests. Run VERIFY (FAIL), then implement, then VERIFY again, including the regression scans. Run OPENAPI. Run TSC. Run i18n gen and check.
- [ ] 2. Mutate:
  - `payable` ignores the paid state. Killer: the pay-refuses case.
  - The 404 leaks "revoked" vs "unknown". Killer: the opaque case.
  - `createDeal` skips `mintInvoiceToken`. Killer: the offline-doc case (F9).
  - Put `"/r/sponsor/"` before `"/r/sponsor/invoice/"`. Killer: the token-gone scrub case (F21).
  - Restore after each.
- [ ] 3. Commit `feat(sponsors): numbered invoice page and PDF; pay by card from the invoice`.

### Task 23: Invoice emails, resend for offline, and the club's "paid" notice

**Files:**
- Modify: `apps/web/src/lib/email.ts` (`sponsorInvoiceEmail` gains the number, the invoice URL, and an optional pay sentence; the offline variant carries the bank details line)
- Modify: `apps/web/src/server/usecases/sponsor-deals.ts` (`sendDealInvoice` handles offline with an email; it ROTATES the token on every resend (Task 22 already mints the first one at create, F9) and stamps `invoice_sent_at`. For offline, `invoice_sent_at` is informational only, and `deal_status` is unchanged)
- Modify: `apps/web/src/server/usecases/sponsors.ts` (`handleSponsorPaymentSucceeded` queues `sponsor_deal_paid` in the same transaction)
- Modify: `apps/web/src/server/email-outbox/{constants.ts,hooks.ts}` (the new kind `sponsor_deal_paid: { to: "account", transactional: false }`)
- Add a delta `db/migration/deltas/V<n>__email_outbox_sponsor_deal_paid.sql` (`<n>` picked at merge, F26). It redefines `email_outbox_kind_valid` by restating the LAST definer's full list (today `db/migration/deltas/V478__email_outbox_phase3_wave5.sql`; re-check at merge) plus the new kind, and is found by suffix.
- Modify (F13): `apps/web/src/lib/sponsor-deals.ts` and `apps/web/src/lib/__tests__/sponsor-deals.test.ts`. This task owns the domain change: `allowedActions` now offers `resend_invoice` for an offline deal that has an email; `rowNextAction` keeps `mark_paid` for offline, the one row action the mockup draws. Task 2's typed action table gains those rows.
- Modify: `apps/web/src/components/sponsors/{deal-page.tsx,sponsor-list.tsx}` (Resend invoice is offered for offline deals with an email, through `allowedActions`, so Task 17's "exactly `allowedActions`" and Task 14's one-action row stay true)
- Test: `apps/web/src/server/usecases/__tests__/sponsor-invoice-email.test.ts`; update `apps/web/src/server/email-outbox/__tests__/{outbox-schema.test.ts,outbox-kind-sweep.test.ts,enqueue-once.test.ts,_kind-senders.ts}` and `apps/web/src/lib/__tests__/sponsor-deals.test.ts` (F13); modify `scripts/smoke/suites/sponsorDeals.ts`

**Acceptance:**
- The email links `<origin>/r/sponsor/invoice/<token>`, NOT a Checkout URL. Pay happens on the invoice page (D14).
- Resend rotates the token: the new hash is stored, and the old link 404s. The deal page copy says "The new email replaces the earlier link."
- **Offline resend (F13):** `allowedActions` offers `resend_invoice` for an offline deal with an email (and not for one without); `rowNextAction` still answers `mark_paid` for an offline unpaid row.
- `sponsor_deal_paid` goes to the org owner (`orgOwnerRecipient`) in the owner's locale, once per payment intent (`onceKey("sponsor_deal_paid","sponsor_order",intentId)`). The body names the sponsor and the amount, and says either "They are live now" or "Approve the deal to put them live" (`on_approval`), linking `dealHref`.
- No email for offline mark-paid, offline refund or complimentary (D13).
- **Trap (implementer memory):** `allowlistLengthFor` (`server/email-outbox/__tests__/_kind-senders.ts:111`) goes negative for a kind with no `send*`. `KINDS_BEFORE_PHASE_3` (:33) exists, but `sponsor_deal_paid` is NOT a pre-phase-3 kind: add a SEPARATE, named exclusion beside it, with a one-line reason, rather than appending to that list.

**Tests:**
- Unit (DB): `sponsor-invoice-email.test.ts`.
  - **Empty case:** offline with no email → `sendDealInvoice` answers 422 `no_billing_email`, and no row is queued.
  - Online → the body contains the invoice URL and no `checkout.stripe.com`.
  - Offline → it contains the bank details and no pay sentence.
  - **Rotation (moved here from Task 22, F9):** Resend → 2 rows; the first token no longer resolves (`invoiceDocByToken` → null) and the new one resolves to the doc.
  - The payment webhook through `runEvent` → exactly one `sponsor_deal_paid` to the owner, in the owner's locale (an `fr` owner on an `nl` org gets `fr`). A replay → still one.
- Unit: `sponsor-deals.test.ts` (F13): the typed action table's offline rows now carry `resend_invoice` when the deal has an email; the table's exact count and reachable count are re-pinned.
- Update the outbox suites: `SPEC_KINDS` and the counts move by one. The `outbox-kind-sweep` REAL-PRODUCER scenario for `sponsor_deal_paid` drives `runEvent`.
- E2E: Task 24.
- Smoke, in `sponsorDeals.ts`:
  - `"sd offline invoice email queued with the invoice link"` (read back from `email_outbox` through `smokeDb`);
  - `"sd invoice pdf is application/pdf for a real token"` (moved here from Task 22, F9): the token is read from that queued email's invoice link, on an offline deal with an email on the row's own sponsor.
- Regression: `sponsor-outbox.test.ts`, `a-kind-body.test.ts`, `no-second-path.test.ts`.

**Steps:**
- [ ] 1. Write the tests and update the outbox suites and the domain test. Run VERIFY (FAIL), then implement, then VERIFY again on the new test, `sponsor-deals.test.ts` and the four outbox suites. Run TSC. Run i18n gen and check.
- [ ] 2. Mutate:
  - Resend keeps the old hash. Killer: the rotation case.
  - The paid notice is queued outside the transaction. Killer: a replay double.
  - `allowedActions` drops offline `resend_invoice`. Killer: the F13 row in the action table.
  - Restore after each.
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
| §8 plans | 3, 4, 6, 16 |
| §8a rulings | one live (1, 5), locks (5, 12, 15), includes (1, 4, 16), scope (6, 16), ends (9, 16), visibility (5), no backfill (1) |
| §9 builder's calls | D1, D10, D12, D13, D20 |
| §10 owner answers (2026-11-07) | Q1: Task 3 (and 16's locked cards and scopes); Q2: D12, Task 21; Q3: D8/D9, Task 5 (the F7 switch-back-on case), Task 11 (I2). See §11. |

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

## 11. Owner questions, answered 2026-11-07

The owner answered all three on 2026-11-07 ("Ok" to the controller's recommendations; spec §10). The answers are binding (F14). None is open.

1. **(§10 Q1, Task 3.) Can a community package carry a tier? Answer: no.** On community every deal is Partner until the club upgrades, and tiers stay gated by `sponsors.tiers` as today. Today's gate also gates competition scoping, so every community deal is **Partner AND org-wide**. One predicate, `placementNeedsTiers`, carries this answer for sponsors, packages and deals (`assertTierAllowed` calls it). The follow-on question of how community tiers would SHOW on public pages does not arise.
2. **(§10 Q2, D12, Task 21.) Are sponsor invoice bank details separate from the registrants' "offline payment instructions"? Answer: yes, a separate setting.** The registrant text is written for players ("pay at the desk") and must not print on a formal invoice.
3. **(§10 Q3, D8/D9, Task 5.) Once all of a sponsor's deals have ended, may the club switch the sponsor back on by hand, as for a no-deal sponsor? Answer: yes.** Apply therefore writes the all-ended state only on the transition into it, so a late event on an old deal never undoes the club's switch (F7).
