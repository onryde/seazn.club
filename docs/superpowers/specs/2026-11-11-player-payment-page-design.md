# Player payment page — design

Status: brainstormed with the owner 2026-11-11. Mockups (layout only; the build uses the house theme):
http://127.0.0.1:8765/2026-11-11_player-payment-page-mockups_ppm11a01/index.html

## Intent

A player who registered but has not paid is chased by email. Every chase email links to **our own payment page**, which shows
what they are paying for and lets them pay. It does not link to a raw Stripe Checkout URL.

Why (owner): a raw payment link in a mail is less trustworthy than a page on our domain that shows the details first. It also
dies within 24 h, because a Checkout session expires, so a reminder opened a day later is a dead end. This is the same reasoning
and the same pattern as the sponsor invoice page (sponsor-deals plan, Task 22, `docs/superpowers/plans/2026-11-07-sponsor-deals.md`).

## Today (verified against origin/main 2026-11-11)

- In-app registration already lands on our page before Checkout. **Unchanged.**
- The T-24h reminder sweep (`server/usecases/registrations/sweep.ts`, passes 1a and 1b, ~:160 and ~:239) mints a Checkout
  session at send time and mails its raw URL (`lib/email-templates/payment-reminder.ts`, `checkoutUrl`).
- The waitlist promotion (`registrations/waitlist.ts` ~:350) mints a session and mails its raw URL (`payUrl`).
- The organiser reminder `sendPaymentReminder` (`registrations/organiser-actions.ts`, `POST /api/v1/registrations/[id]/remind`)
  sends offline instructions only, with no card link. **No UI calls it.** `reg.action.remind` and `reg.action.remindTitle` exist
  in all 4 `ui.json` files, but `registration-hub-registrant-actions.tsx` renders no such button.
- `/r/[ref]` is the registrant's ticket/status page, not a payment page.

## Goals

1. **One payment page per registration entry**, reached by a secret link: `/r/pay/[token]` (the route name is the builder's
   call; it must not collide with `/r/[ref]`).
2. **Every email that today carries a pay link carries the page link instead**: the T-24h reminder (both passes), the waitlist
   promotion, and the organiser reminder. The builder sweeps every producer of `checkoutUrl`/`payUrl` in mail and replaces all of
   them; none may be left mailing a raw Checkout URL.
3. **A "Send payment reminder" button in the registration panel** (owner: panel Option A). It goes in the registrant detail
   actions, one registrant at a time. No bulk "remind all".
4. **Card and offline entries both get the page** (owner: apply rec). A card entry sees Pay. An offline (bank/cash) entry sees the
   organiser's payment instructions and its reference where Pay would be.

## The page (owner: Option B, details-first)

It shows only facts we already store. **No "what your entry includes" block** (owner: dropped, since no such data exists):
- competition name, division name, competition dates (and venue, if stored);
- the entrant: the player, or the team/pair with its members;
- the fee, plus a processing-fee line **only when the organiser passes the Stripe fee on**. Both amounts come from the same
  computation that builds the Checkout line items, never a restatement of it;
- the payment deadline (`expires_at`) and the reference (`ref_code`);
- the organiser's name and contact;
- then **Pay** (card), or the payment instructions + reference (offline).

States (builder check Q4/Q5; my calls where not the owner's):
- **Pending, card, unpaid, before deadline** → Pay.
- **Pending, offline** → payment instructions + reference, no Pay (owner).
- **Paid/confirmed** → no Pay; "Paid" with the date. If refunded, "Refunded" with the amount instead (my call).
- **Deadline passed** (`expires_at` set and past) → no Pay; "Payment deadline passed — contact the organiser" (owner: apply rec).
  When `expires_at` is null, no deadline line is shown and nothing expires on time alone (my call).
- **Waitlisted (not promoted)** → "You're on the waitlist — we'll email you if a place opens", no Pay (my call). No mail links
  the page in this state today, but a token minted earlier can still reach it.
- **Withdrawn (by player or organiser), unknown or malformed token** → the same opaque "link not valid" 404 (owner: apply rec).
- A free division never gets a token, since no mail links it (the reminder already refuses a fee of 0).

Public-page contract, exactly as the sponsor invoice page and PR A's `/r/sponsor/[token]/page.tsx`:
- `force-dynamic`; noindex, nofollow; no referrer;
- `publicRateLimit` BEFORE the lookup;
- `ph-no-capture` on anything that paints the token;
- the token scrubbed from analytics/Sentry URLs (`lib/scrub-score-url.ts` `SECRET_PATH_ROUTES` + its test, ordered so no shorter
  `/r/` prefix matches first).

It is mobile-first and verified at 320, 768 and 1280. **Locale (builder check Q7; my call):** the page uses the same locale
resolution as the mail that linked it (today's reminder mail resolution, re-pinned by the builder), so mail and page never
disagree. All strings are in all 4 locales. If the organiser has no contact stored, the expired state omits the contact line
and still renders.

## Token

- 32 random bytes, **stored hashed only**. Reuse the sponsor token helpers (`server/sponsors/report-token.ts`
  `mintReportToken`/`hashReportToken`) or a shared extraction of them, not a third copy.
- **A fresh token per email (builder check Q3; my call).** A hashed-only token cannot be put into a second email, so each mail
  that links the page mints its own token. Hashes live in a small table (`registration_pay_tokens(token_hash pk,
  registration_id, created_at)`, name the builder's call), and **every token for an entry stays valid** until the entry is paid,
  withdrawn or expired. So "one link per entry" means one page per entry, reachable from any of its mails. Nothing is rotated or
  revoked individually in this scope.
- The raw token leaves only through the mint's return value, into the mail being built. Tests capture it by wrapping the mint,
  never by inserting a hash by hand.

## Pay (money path)

- Pay is POST-only and answers 303 → Checkout. It refuses with 409 when the entry is not payable (paid, expired, withdrawn,
  offline), and never mints in that case.
- **Reuse-or-expire, one payable session (owner: apply rec).** Pay reuses the entry's open session if it has enough life left;
  otherwise it expires the old session and mints a new one. Two Pay presses never leave two payable sessions. Mirror the sponsor
  `ensureDealCheckout` rule (one function, not restated per caller).
- **Pays for this entry only (owner: apply rec)**, as the reminder already does today (`createRegistrationCheckout(group_id,
  [reg.id], …)`), even when the entry was registered in a cart with others.
- **Session plumbing is existing behaviour, not new design (builder check Q1/Q2, answered from the code).** Pay calls the
  same `createRegistrationCheckout(group_id, [reg.id], ctx, origin, prior)` that today's reminder sweep calls (it only moves from
  send time to press time). That function already handles a cart-shared `registration_groups.checkout_session_id`:
  - session metadata carries the explicit `registration_ids`, which is what fulfilment reads;
  - a prior open session is expired only when the new mint covers ALL of its ids (`expireSupersededCheckoutSession`,
    subsumption);
  - the pointer stamp is conditional (no lost update).
  Pay adds reuse-before-mint (an open session for exactly `[reg.id]` with enough life left is reused) on top. The builder
  re-verifies these three properties against the tree before building on them, and adds the sequence tests below. A still-open
  CART session that covers this entry plus siblings is NOT expired by a per-entry mint (it is not subsumed). That is today's
  behaviour too; the webhook's handling of an entry paid twice is pinned by a test, not changed here.
- **Return URLs (owner, 2026-11-11).** A session minted from the page sets BOTH `success_url` and `cancel_url` to the payment
  page (today's `checkout.ts:273-274` return to the registration page; the page's mint must not). Cancel, Back or a closed tab
  leaves the session open: pressing Pay again reuses it (the reuse rule); under 10 min left → expire, then re-mint.
- **Paid, not yet recorded (owner, 2026-11-11).** When the page sees `checkout=success&session_id=…`, or an entry whose session
  is `complete` before the webhook has fulfilled it, it shows "Payment received — confirming…" with NO Pay button and refreshes.
  It reconciles via the existing return-and-confirm path, never by trusting the query string alone (mirror the sponsor invoice
  page's payment-being-recorded notice). Test: success return before the webhook → no Pay; webhook lands → Paid.
- Because the sweep no longer mints at send time, a reminder costs no Stripe call. The sweep's lease/claim stays as is
  (idempotent sends).

## Send payment reminder (organiser)

- **Rename (owner):** the `reg.action.remind` label becomes **"Send payment reminder"** in all 4 locales. The tooltip
  `reg.action.remindTitle` stays.
- It is shown in the registrant detail actions for a **pending** entry in a division with a fee. It is hidden otherwise; the
  server already refuses with 422.
- The mail now carries the page link, for card and offline alike. Offline instructions stay in the mail body as well as on the
  page.
- **Limits (owner: apply rec; mechanics my call, builder check Q6):** counted from `registration.payment_reminded` audit rows,
  i.e. organiser presses only; the T-24h sweep and the waitlist mail do not count. The 1 h confirmation is client-side, from the
  "last reminded" time the panel already reads; the server cap is the guard. Detail: the panel shows "Last reminded <time> ago" (from the existing `registration.payment_reminded`
  audit rows). A press within 1 h of the last reminder asks for confirmation first. The server refuses a 6th reminder for the
  same entry within 24 h (429-style refusal, translated copy).
- On success it shows `reg.remind.sent`; when the outbox did not send at once, `reg.remind.notSent` (both exist).

## Non-goals

- No change to the in-app registration → Checkout flow.
- No "what's included" field; it can be added later as an optional organiser text box if asked.
- No bulk remind.
- No change to refunds, the webhook's fulfilment rules or the T-24h timing.
- No PDF for the player page (sponsors have one; players don't need it now).

## Anti-goals (a failure even if it works)

- Any mail still carrying a raw Checkout URL.
- Two payable sessions for one entry, or a paid entry that does not confirm on return.
- A page that tells a guesser whether a token or a registration exists.
- A token visible in analytics, Sentry, referrers or logs.

## Tests owed (house rules: `docs/superpowers/TEST-STRATEGY.md`)

- Unit (DB): page doc by token, **empty case first** (unknown → null), then unpaid card, offline, paid, expired and withdrawn.
  Each state is counted. Tokens come from the REAL email producer, never a hand-inserted hash.
- Money: two Pay presses → one Stripe `create`; a near-expiry session is expired then re-minted; paid → 409, no mint; the cart
  sibling sequence in both orders through the webhook and the return path.
- Every mail producer: the rendered mail contains the page URL and **no** `checkout.stripe.com`. Sweep the producers by
  behaviour (grep `checkoutUrl`/`payUrl`), not by filename.
- Organiser reminder: the 6th within 24 h refused; confirmation within 1 h (e2e); "last reminded" shown.
- Scrub: the scrubbed URL no longer contains the token itself.
- E2E: register (card) → do not pay → organiser presses Send payment reminder → open the mailed link → page details → Pay →
  Stripe test card → back → Paid state. Plus offline: the page shows the instructions and no Pay.
- Smoke: unknown token 404; Pay on a paid entry 409.
- Mutate each new guard once.

## Left to the builder

The route name, the token column's table, where the per-entry session pointer lives (see Pay), the copy wording within the
owner's decisions, and the panel's exact placement within the existing actions list.
