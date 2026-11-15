# Review: Revshare affiliate tracking (feat/revshare-tracking, uncommitted)

Reviewer pass, 2026-11-15. Read-only. Files read in full: `lib/revshare.ts`, `components/revshare-capture.tsx`,
`app/layout.tsx`, `lib/auth.ts` (createOrgForUser + ensureActiveOrg), `billing-events/invoices.ts`, the V523 delta,
and all three test files. I also read these callers and neighbours: `app/api/orgs/route.ts`, `lib/funnel.ts`
createFromDraft, `billing-events/ledger.ts` runEvent, `billing-groups.ts` attach/detach (L977, L1263), `proxy.ts` cspHeader,
and Next 16.3.6 docs `03-api-reference/04-functions/cookies.md` and `02-guides/scripts.md`.

**Verification (scoped, as briefed):** vitest JSON reporter gives `numPassedTests 33 / numTotalTests 33`, 0 failed and
0 pending. All three `.testResults[].name` paths are inside `/Users/ashokhein/github/seazn.club-revshare/apps/web/...`
(revshare.test.ts 18, revshare-org-seam.test.ts 8, revshare-sale-seam.test.ts 7). The DB suites ran and were not skipped.

**Counts:** High 2 · Medium 7 · Low 7

---

## High

### H1. An existing customer can attribute an already-paying, never-referred subscription to an affiliate, including themselves
`lib/auth.ts:331-332`, `billing-events/invoices.ts:72-77`, `billing-groups.ts:977`

`createOrgForUser` stamps the `rs_ref` cookie on every org creation, with no check of who the user is. The report then
takes the oldest *attributed* org in the group, `where ... revshare_ref_code is not null order by o.created_at`.

Failure scenario: user U has paid for org A on group G since 2025, and A has no ref. U signs up as a Revshare affiliate
(or a friend does), clicks the affiliate link, and creates org B through `POST /api/orgs` with
`attachToGroupId = G`. This works because `route.ts` calls `createOrgForUser` and then `attachOrgToGroup` moves B onto
G at L977. B is now the only attributed org in G. Every renewal of G from then on is reported under that ref_code,
which is commission on revenue the affiliate never brought in. Without the attach the leak is smaller but still there:
B's own new group is attributed, and so is any later upgrade of it.

Revshare's self-referral detection cannot catch this, because we send no email, only the Stripe customer id.

The codebase already holds the opposite rule for the legacy loop: `api/orgs/route.ts:23-26` and `funnel.ts:118-120`
both say "an existing user can't be a fresh referral".

Fix:
- Stamp only when the creating user has no existing org membership and no `subscriptions` row with a
  `stripe_customer_id` (a first-org rule). Make it a guard plus a test with a negative pair: an existing user with a
  cookie gets null.
- Move attribution to the payer level. Freeze `subscriptions.revshare_ref_code` once, at the first paid invoice
  (`billing_reason = 'subscription_create'`), copied from the group's founding org. Report from that column, so
  attaching or detaching an org can never change who gets the commission.

### H2. Group moves silently change or drop attribution on renewals (`billing-group-move`)
`billing-events/invoices.ts:72-77` together with `billing-groups.ts:977` (attach) and `:1263` (detach)

The lookup is live and runs on every invoice: it joins on `organizations.subscription_id` at the moment the invoice
arrives. So:

- **Detach.** If the referred org is moved out of the paying group into a fresh one (L1263), group G's next renewal
  finds no ref and reports nothing. The affiliate loses recurring revenue they are owed.
- **Attach of an older attributed org.** "Oldest" means the oldest org by `created_at`, not the earliest attribution.
  So attaching an org that is older and carries affiliate Y into a group already reporting for affiliate X flips the
  `ref_code` mid-subscription, for the same `customer_id`. Revshare then credits one customer's recurring revenue to
  two affiliates.

Renewals after a group change find the ref only by accident of membership.

Fix: the same as H1. Freeze attribution on the `subscriptions` row and report from it. Add a seam test that attaches
an attributed org to an unattributed paying group and asserts that the group's renewal is NOT reported (or that it
is, if the owner rules otherwise).

---

## Medium

### M1. The third-party script carries no nonce and conflicts with the app's nonce + `'strict-dynamic'` CSP
`app/layout.tsx:68-74`; `proxy.ts:74`, `:87`

A raw `<script async src>` in the root layout `<head>` is valid in App Router: React 19 hoists and dedupes async src
scripts, and the scripts guide forwards `data-*` attributes. But `proxy.ts` builds
`script-src 'self' 'nonce-…' 'strict-dynamic' https://js.stripe.com`. Under `'strict-dynamic'` host allowlists are
ignored. Next stamps the nonce only on its own framework scripts and on `next/script`. This layout is deliberately
static and reads no `headers()`, so it can never carry a nonce. `connect-src` also has no `https://www.revshare.so`.

Today `CSP_MODE=report-only` (`apps/web/.env.example:253`), so the cost is violation-report noise on every page. The
day `CSP_MODE=enforce` flips (planned in `design/v1/DEFERRED.md:39`), tracking stops entirely. Nothing goes red: the
cookie is simply never written, which is failure class 6.

Fix: use `next/script` with `strategy="afterInteractive"`, which gets the nonce. Add `https://www.revshare.so` to
`connect-src` and `script-src`, with a `proxy-csp` test like `proxy-csp-realtimekit.test.ts`.

### M2. The script loads before consent, on every page, including embeds and the stream overlay
`app/layout.tsx:68`, `:92`

PostHog stays opted out until `<CookieConsent>` Accept. The Revshare script sets a 30-day tracking cookie on
`.seazn.club`, and `RevshareCapture` writes `rs_ref` unconditionally. Because this is the root layout, both also run
on `/embed` iframes on third-party sites, on `/live`, on the compositor `/overlay`, and on `games.*`. That is an
ePrivacy/GDPR consent question (we ship four locales, EU audience). It also adds a third-party network dependency to
embed and overlay pages.

Fix: scope the script and the capture to the marketing and signup trees, gate them behind the consent state, or get an
explicit owner ruling that affiliate cookies are "strictly necessary".

### M3. Tax-inclusive `amount_paid` overpays commission
`billing-events/invoices.ts:82`

`automatic_tax` is live (`billing-manage.ts:225`, `api/billing/address`), so `amount_paid` includes VAT or GST.
Revshare commissions a percentage of `spent_amount`. A GBP 49 + 20% VAT invoice reports 5880 and should report 4900.

Fix: report `amount_paid` minus the invoice's taxes (`total_excluding_tax`, clamped to `amount_paid`, or subtract
`total_taxes[].amount`). Test it with a seeded invoice that carries tax, where the wrong answer (5880) differs from
the right one.

### M4. Proration and add-on invoices are reported, but the decided scope is "first charge + renewals"
`billing-events/invoices.ts:59`, `:68-86`

`trueUpQuantityPaid` in the same file filters on `billing_reason` because a proration invoice is also
`invoice.payment_succeeded`. `reportRevshareSale` has no filter, so seat attaches (`subscription_update`), extra-org
rider purchases and manual invoices on the subscription are all reported. That may be wanted, but it is not what was
decided.

Fix: either restrict to `subscription_create` and `subscription_cycle` and add a test that a `subscription_update`
invoice is NOT reported, or get the owner to widen the scope explicitly. Today no test covers any `billing_reason`
except `subscription_cycle`.

### M5. Refunds, disputes and voids are never reversed
There is no reversal path. `charge.refunded` and `charge.dispute.*` are handled in `dispatch.ts:113-156`, but nothing
touches Revshare. A refunded or charged-back first invoice keeps its commission.

Fix: at minimum, when a refund or dispute hits a subscription invoice whose group is attributed, raise a staff alert
(`staff-alerts.ts`) or a log line naming the `transaction_id`, so it can be reversed by hand in Revshare. If Revshare
exposes a refund or adjust endpoint, call it from the same place. Get an owner ruling on a clawback window.

### M6. A transient Revshare outage loses the sale permanently
`lib/revshare.ts:75-90`, `billing-events/ledger.ts:99-101`

`reportSale` swallows a failure or a non-2xx response, then `runEvent` marks the event `processed_at`. Neither Stripe
nor `sweepStuckEvents` will retry, so the commission is silently lost. Because `transaction_id` is the invoice id and
Revshare ignores duplicates, retries are safe, so nothing is gained by dropping it.

The 5 s `fetch` is also synchronous inside the Stripe webhook response. It is well inside the 10-minute claim lease
and normally inside Stripe's timeout, so it is not a correctness risk. It does add up to 5 s of latency to every
attributed invoice delivery.

Fix: write a durable outbox row (there is an email outbox pattern to copy) and send it with retries, or at least
`after()` with a retry and a Sentry event on final failure.

### M7. Resolved at rebase: renumbered V500 -> V523 (main already owned V500)
`db/migration/deltas/V500__org_revshare_ref.sql`

The highest version on main is V495. Other comments in this tree (V465, V477, V489) note that flyway.toml sets no
outOfOrder. `feat/swiss-auto-advance` holds an unmerged V497 (plan `2026-11-05-w4-knockout-app-b.md:82`). Once a
database is at V500, it refuses V496-V499 when they arrive later.

Fix: renumber to the next free version at merge time, checking open branches as well as main.

---

## Low

- **L1. "Consumed once" is true only in the mock.** Covers `revshare-org-seam.test.ts:78-84` and `lib/revshare.ts:34-40`.
  In production there are two ways the cookie comes back:
  1. On the `ensureActiveOrg` RSC path, `jar.delete` throws `ReadonlyRequestCookiesError`. I checked
     `request-cookies.js:51`, and the docs say `.delete` is allowed only in a Server Function or Route Handler. The
     throw is correctly swallowed, but the cookie survives for 30 days.
  2. `RevshareCapture` re-writes `rs_ref` on every page load where `window.revshare_metadata.ref_code` is present.
     This is likely, because the script keeps its own 30-day cookie. Confirm it in a browser.

  So every later org creation, including by a different user on a shared browser, is stamped again. The test name
  claims more than it proves (failure class 4). With H1's first-org guard this becomes harmless. Without it, it widens
  H1.
- **L2. The cookie is consumed before the quota check.** `auth.ts:331-332` runs before `assertMayOwnAnotherOrg`
  (L350). A `PaymentRequiredError` at the cap still deletes the cookie, so after the user buys the add-on and retries,
  the attribution is gone. This is moot once H1 is fixed.
- **L3. Soft-deleted orgs keep attribution.** The select at `invoices.ts:72-77` does not filter
  `o.deleted_at is null`. This is arguably right, since attribution is per customer, but it is undecided. Put it in
  the ruling with H1 and H2.
- **L4. Silent no-op without the key.** `revshare.ts:74`: with `REVSHARE_API_KEY` unset in production, every sale is
  dropped without a log. Warn once when `NODE_ENV === "production"`.
- **L5. The DB lookup sits outside any try.** `invoices.ts:72` runs after the subscription update. A DB error there
  500s the webhook. The retry is idempotent (Revshare dedupes, and the true-up is locked), so this is acceptable. Note
  that it contradicts the "best-effort" docstring.
- **L6. Two copies of the regex can drift.** `revshare-capture.tsx:19` duplicates `/^[A-Za-z0-9_-]{1,64}$/` from
  `revshare.ts:21`. The server trims and the client does not, so they are equivalent today, but nothing ties them
  together. Fix: move `REF_CODE_RE` and `REVSHARE_COOKIE` into a non-`server-only` module (for example
  `lib/revshare-shared.ts`) that both files import. The client also hard-codes `"rs_ref"`.
- **L7. Redundant and missing tests.** `revshare.test.ts:91-94` "skips zero-value sales" duplicates the `0` row of the
  `it.each` at L77. No test covers multi-currency (EUR/USD orgs). Confirm the Revshare program accepts per-sale
  currency rather than one program currency.

---

## Specific checks

**(a) Next 16.3.6.**
- A raw `<script async>` inside an explicit root-layout `<head>` is valid in App Router. Metadata is still merged, and
  React 19 hoists async src scripts. The blocker is CSP (M1), not Next.
- `cookies().delete()` per `cookies.md:71-74` "can only be called in a Server Function or Route Handler". In an RSC it
  throws `ReadonlyRequestCookiesError` (`next/dist/server/web/spec-extension/adapters/request-cookies.js:51`).
  `consumeRevshareCookie` catches it at L34-40 and still returns the code, so `ensureActiveOrg` during render does not
  break.
- `cookies()` itself outside request scope is also caught (L27-31).
- The consequence is that the cookie stays alive (L1). The other callers, `POST /api/orgs` and the funnel claim route,
  are Route Handlers, where the delete works. The delete targets a host-only cookie, which matches how the client
  wrote it (no Domain attribute).

**(b) Which orgs get attribution.** Every org creation, through every caller (`api/orgs`, `funnel.createFromDraft`,
`ensureActiveOrg`), whatever the user's history. Existing customers can mint attribution (H1). Oldest-attributed-org
wins is the wrong unit: it is mutable under attach and detach and ordered by org age rather than attribution time (H2).
Attribution belongs, frozen, on the subscription (payer).

**(c) Secrets in the client bundle.**
- None. `REVSHARE_API_KEY` is read only in `lib/revshare.ts`, which imports `"server-only"`.
- `revshare-capture.tsx` does not import it (it duplicates the regex instead, L6).
- The env var is not `NEXT_PUBLIC_`.
- The program id is public by design.

**(d) Webhook timing.** See M6. Up to 5 s of synchronous latency per attributed invoice, which is safe against the
10-minute lease. The real risk is the opposite one: a failure is never retried, so the sale is lost.

**(e) Invoice kinds.**
- **Non-subscription and one-time invoices** (passes, stream packs): `invoiceSubId` is null, so the handler returns at
  L51. Never reported. Correct.
- **Proration invoices:** reported (M4).
- **Trialing:** the trial-start invoice has `amount_paid` 0, which the `!(amountCents > 0)` check skips. The
  first post-trial charge (`subscription_cycle`) is reported. Correct.
- **100%-coupon invoices:** 0, skipped.
- **Group move:** renewals find the ref only while the attributed org is still a member, and may switch affiliates
  (H2).

**(f) Test quality.**
- **Seams.** The two seam suites drive the real producers and consumers: real `createOrgForUser` against Postgres, and
  `runEvent` -> dispatch -> handler -> SQL -> `reportSale` with only `fetch` stubbed. Expected bodies are typed from the
  Revshare contract. Good.
- **Guards, reasoned through mutations (not executed, read-only).** Each of these mutations is killed by the named test:

  | Guard (location) | Mutation | Killing test |
  |---|---|---|
  | `is not null` filter | removed | "unattributed group" |
  | `order by o.created_at` | dropped or flipped to `desc` (young is inserted first) | "oldest ref_code" |
  | `if (!jar.get(...))` | removed | "no cookie" |
  | `!== undefined` override | changed | "explicit null" |
  | amount guard | removed | it.each |
  | `.trim()` | removed | "padded" |

- **Gaps.** No test covers `billing_reason` (M4), tax (M3), an existing user with a cookie (H1), or a group move (H2).
  L1 is a test whose name claims more than it proves. L7 is a duplicate. No test is outright vacuous.
- **`RevshareCapture` is never exercised.** That is the producer half of an inert seam (failure class 1): the org-seam
  test's hand-set `jar.set("rs_ref", …)` proves the fixture, not the browser contract. For a 15-line effect this is
  acceptable only with a minimal pin:
  - Extract a pure `revshareCookieString(code, protocol): string | null` and unit-test it.
  - Then parse its output with Next's own `RequestCookies`, from `next/dist/compiled/@edge-runtime/cookies`, feeding it
    a `Headers` whose `cookie` is the name=value pair.
  - Assert that `sanitizeRefCode(parsed.get("rs_ref").value) === code` for valid codes, and null output for a hostile
    code.

  That proves the client and the server agree on the name and the alphabet. The full proof is one Playwright step:
  `addInitScript` sets `window.revshare_metadata = { ref_code: "aff_e2e" }`, the test signs up, and reads the new
  org's `revshare_ref_code`.

---

## The four questions

1. **Second call.**
   - `reportSale` for the same invoice: the replayed Stripe event is absorbed by the `billing_events` claim (tested).
     A sweep or manual replay of an unprocessed event re-POSTs, and Revshare ignores the duplicate `transaction_id`.
     Safe.
   - Renewal: a new invoice id, the same `customer_id`. Correct, and tested.
   - A second `createOrgForUser`: in a route handler the cookie is gone. In the RSC path, or after
     `RevshareCapture` rewrites it, the second org is stamped again (L1), and for an existing customer that is H1.
2. **Empty input.**
   - Missing, empty or hostile cookie: null, and nothing is stored (tested).
   - Missing customer or invoice id: return early.
   - `amount_paid` of 0, NaN or null: skipped (tested).
   - Missing API key: a silent no-op (L4).
   - A group with no attributed org: nothing reported (tested).
3. **After a withdrawal or void.**
   - Refunded or disputed invoices keep the commission. Nothing reverses it (M5).
   - Voided or uncollectible invoices never fire `payment_succeeded`, so they are never reported. Correct.
   - A canceled subscription stops producing invoices, and its final credit or zero invoice is skipped by the amount
     guard. Correct.
   - A soft-deleted attributed org keeps attributing for the rest of its group (L3, undecided).
   - A detached org takes its attribution with it (H2).
4. **Another sport.** Not applicable, for a stated reason. Attribution and invoice reporting are org and subscription
   level, with no sport branch anywhere in the changed code. The only surface variance is host and tree: `games.*`,
   `/embed`, `/live` and `/overlay` all load the script through the root layout, which is covered by M2.

---

## Disposition (author, 2026-11-15)

Fixed inline, each with a test that fails without it (hand mutants run per guard, clean 61/61 baseline first):

| Finding | Resolution |
|---|---|
| **H1** existing customer mints attribution | `createOrgForUser` stamps only a user's FIRST org: no `org_members` row and no Stripe-paying `subscriptions` row. Tests: existing member -> null, existing payer -> null (each guard mutated alone). |
| **H2** group moves change/drop attribution | Attribution frozen on the payer: `subscriptions.revshare_ref_code` (V523 now alters `subscriptions`, not `organizations`). Reported from that column by `stripe_subscription_id`. Tests: founding org moved out -> still reported; attributed org moved into an unattributed group -> not attributed. |
| **M3** tax inflates commission | Reports `min(amount_paid, total_excluding_tax)`; falls back to `amount_paid`. Tests: 5880 paid / 4900 ex-tax -> 4900 (wrong answer differs), null fallback, never above paid. |
| **M4** proration/add-on reported | Only `subscription_create` and `subscription_cycle`. Tests: `subscription_update`, `manual`, `subscription_threshold`, null -> not reported. |
| **L1** "consumed once" proves only the mock | Test renamed to say what it proves (a route-handler jar); with H1's first-org rule a surviving cookie can no longer double-stamp. |
| **L2** cookie consumed before quota check | Moot: stamping now happens inside the quota-checked transaction; an unstamped second attempt is harmless. |
| **L3** soft-deleted orgs keep attribution | Moot: attribution is on the subscription, not an org. |
| **L4** silent no-op without key | One `log.warn` in production when enabled but the key is missing. Test: warns exactly once. |
| **L6** regex/cookie name duplicated | New non-server module `lib/revshare-shared.ts` (`REF_CODE_RE`, `REVSHARE_COOKIE`, `revshareCookieString`). Test: a 14-code sweep proves client-writes == server-accepts (anti-vacuity count asserted). |
| **L7** duplicate test / no multi-currency | Duplicate removed; GBP/EUR/USD `it.each`. (Whether Revshare accepts per-sale currency is still to confirm with Revshare.) |
| **(f)** `RevshareCapture` producer half untested | Cookie string is now a pure function pinned against the server reader; the browser step is the e2e spec. |
| *(owner request)* disable in stg/local | `NEXT_PUBLIC_REVSHARE_ENABLED` master switch: only the literal `"1"` is on. Gates the script, the capture, the cookie consume and `reportSale` (single owner — a second copy of the check in `invoices.ts` shadowed its tests and was removed). `fly.toml` = `"1"`, `fly.stg.toml` = `"0"`, Dockerfile ARG/ENV added. |

Not changed — needs an owner decision (none is mine to make):

- **M1** CSP: the raw `<script>` has no nonce and `connect-src` omits revshare.so. Harmless while `CSP_MODE=report-only`; tracking stops silently the day it flips to enforce. Switching to `next/script` may force the static root layout dynamic, so it is a product/perf call.
- **M2** consent: script and cookie load before the cookie banner is accepted, on every tree incl. `/embed` and `/overlay`.
- **M5** refunds/disputes are never reversed in Revshare; needs a clawback ruling and, ideally, a Revshare reversal endpoint.
- **M6** a failed Revshare call is lost for good (the event is marked processed). A durable outbox is the fix; making the webhook 500 instead was rejected because sustained 5xx can get the Stripe endpoint disabled.
- **M7** renumbered V500 -> V523 at rebase onto main (V500 was taken by drop_org_referral).
