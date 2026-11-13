# Registration redesign — design

**Status:** design of record for the "registration redesign" wave, 2026-11-13.
**Branch:** `feat/registration-redesign`, cut from `origin/feat/player-payment-page`
(PR #1197). It is rebased onto `main` once #1197 merges.
**Plan:** `docs/superpowers/plans/2026-11-13-registration-redesign.md`.

**Owner decisions** are binding and are not reopened here. Their source is the
`OWNER` lines dated 2026-11-12 and 2026-11-13 in
`.superpowers/sdd/2026-11-11-player-payment-page/progress.md` (main checkout).
**Layout reference:** the mocks page `rfm12a01`, sections A (filter bar A3), B
(register polish, stepper S1) and D (division tabs). The mocks set layout only.
The build uses the house tokens and components (`feedback_mocks_are_layout_only`).
**Today's screens** are on sign-off page `rps12a01`.

Every file:line below was re-read on this branch at `366c7e045b`. Line numbers
drift, so re-pin them before editing.

---

## 0. False premises and corrections found while writing this

| # | Premise (brief or mock) | What the tree says | What this spec does |
|---|---|---|---|
| FP1 | "What happens next" uses the competition's **venue** | `competitions` has no venue column. `V207__competitions.sql:10` has `starts_on` and `ends_on` only. `V109__venue.sql` adds `venue` to the legacy `tournaments` table. Venues exist only as `venues`, reached through `fixtures.venue_id` (V367). | A venue line is shown only when every fixture with a venue in the competition points to one venue (§5.2). Otherwise there is no venue line. **Owner question Q2.** |
| FP2 | Entries card state "full **and no waitlist**" → disabled | There is no waitlist on/off setting. `publicRegistrationInfo` (`server/usecases/registrations/settings.ts:422`) sets `closed_reason = "full"` on a division that is open, capped and full, and that division **still takes entries** onto the waitlist (submit, `registration-submit.ts:806-809`). The only disabled states are the closed reasons: `window`, `payments_unavailable`, `entry_kind_unavailable`. | The card has four states (§4.1). "Full, no waitlist" cannot happen and gets no UI. A solo sign-up into a full **solo pool** is the one refused-when-full case (`soloPoolIsFull`, :789-791). Its card keeps today's refusal. |
| FP3 | "N places left" from the public loader is true | The loader computes `remaining = capacity - active` (settings.ts:392). Submit caps at `min(capacity, planLimit)`, with `planLimit = getLimit(org, "entrants.per_division.max", comp)` (registration-submit.ts:677, :776-779). A division under its capacity but at the plan limit shows "places left", then waitlists the entry. | B3 computes `remaining` from the same `hardCap` that submit uses (§4.1). |
| FP4 | Waitlist position "#N" can reuse the organiser list's `waitlist_position` | The organiser list (`registrations/list.ts:328-331`) orders by `(created_at, id)`. The promotion queue (`registrations/waitlist.ts:98`) orders by `coalesce(waitlisted_at, created_at), id`. They disagree for any entry demoted back onto the waitlist. | One SQL helper ordered like the promotion queue, used by both the status page and the organiser list (§4.2). |
| FP5 | Organiser search "matches either" ref (implies it matches the cart ref today) | Search (`registrations/list.ts:375-377`) matches `display_name`, `contact_name` and `contact_email`. It does **not** match `ref_code` at all. | B5 adds matching on the cart ref and on the per-entry ref (§6.4). |
| FP6 | Per-entry position is "derivable stably" with no new column | It is derivable as `row_number() over (partition by group_id order by created_at, id)`. Entries are inserted only at submit, stamped `clock_timestamp()` in cart order (registration-submit.ts:768-771, :859, :877), and never deleted by app code. **But** `deleteDivision` (`usecases/divisions.ts:591`) runs `delete from divisions`, and `registrations.division_id` is `on delete cascade` (V223:25). Deleting one division in a 3-entry cart would renumber the other entries, so an offline transfer marked `…-3` would then point at nothing, or at the wrong entry. | Store the position: `registrations.cart_position` (§6.1). |
| FP7 | "Step 2 of 5" | `buildStepOrder` (`components/public-site/register/steps.ts:48`) drops the Entries step when there is one open division and the kind does not need it, which leaves **4** steps. | The stepper reads `{n} of {total}` from the step order. It never hard-codes 5. |
| FP8 | Turnstile handles token expiry | `lib/turnstile-client.ts:106-111`: the expired and timeout callbacks only null the token. `token()` then waits up to `TOKEN_WAIT_MS = 20_000` (:39) for Cloudflare's own auto-refresh, and sends no token at all if the wait times out. With the widget mounted at form open, a token is up to 300 s old by Review, so this path becomes the common one. | B1 handles expiry explicitly (§3.3). |
| FP9 | Mock: status page "We'll email you" about the draw, and "check in from 08:30" | No draw date or check-in time columns exist (owner, 2026-11-12). | Copy uses only real data (§5.2). The roster's check-in wording is not changed this wave. |
| FP11 | "Paid £X" can be summed from entry status | A fee waiver confirms an entry and keeps its `amount_cents` (organiser-actions.ts:162-196). | Paid is derived from settlement events, not status (§5.3). |
| FP10 | Mock: page title "Registration closes 30 Nov, 23:59" | Closing time is per division (`registration_settings.closes_at`). The competition has no closing time. | The H1 is the competition name. A closing line shows only when every open division has the same `closes_at`. Otherwise each card carries its own closing time, as today. |

---

## 1. Scope

In the wave, in build order:

| Batch | What | Owner decision |
|---|---|---|
| B0 | Measure submit latency per stage | 10 |
| B1 | Latency fixes and staged button text | 10 |
| B2 | Register form polish: stepper S1, sticky bar, header scroll-away, each step | 2 |
| B3 | Entries capacity and waitlist states; waitlist position | 3, 4 |
| B4 | Status page: headline, reference, what happens next, paid/still due, invite restyle | 2 (status), 5, 6, 9 |
| B5 | Per-entry reference suffix | 7 |
| B6 | Organiser filter bar A3 with a phone sheet | 1 |
| B7 | Division settings as closable hub tabs | 8 |

Not in the wave: organiser "note to entrants" (later feature), A2 status counts,
check-in wording on the roster, a competition venue field (Q2), and a change to
the five-step order or fields.

---

## 2. House rules that bind every task

- Every new or changed user-facing string goes in all 4 dictionaries
  (`apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`). Then run
  `npm run i18n:gen-keys`, which regenerates `apps/web/src/lib/i18n-keys.ts`, and
  `npm run i18n:check`.
- Screenshots at 1280, 768 and 320, with no horizontal page scroll. The organiser
  hub is under `/o/…`, not `/admin`, so the full bar applies.
- Every change ships a test that fails without it. Mutate each guard you add
  once. Test the sequence: second call, empty input, after withdraw/void.
  "Another sport" is answered "not applicable — registration is
  sport-agnostic" unless the task touches online-chess seat gates.
- Run scoped vitest and specific e2e specs only (`cd apps/web && npx vitest run
  <paths> --reporter=json --outputFile=…`). Never run the full suite.
- Before editing any file under `apps/web/src/server`, read
  `apps/web/src/server/MODULARIZATION.md`. `registration-submit.ts` is 1577
  lines, over the 1500 threshold. The doc says "split when you next touch it
  for a feature". **This wave does not split it.** B1 touches it for
  performance, not behaviour, and a split would collide with the rebase onto
  main. Record that as a deliberate deferral in the B1 PR text.
- Sweep e2e by behaviour (testid, string, route), not by filename. Each plan
  batch lists its greps.

---

## 3. Submit latency (B0, B1)

### 3.1 Today's path (re-derived)

Client (`components/public-site/register/register-stepper.tsx`):

1. `useTurnstile("register")` (:186). `<TurnstileWidget>` mounts **only on the
   review step** (:531), so the invisible challenge starts when Review opens.
2. `handleSubmit` (:422-446) runs `withTurnstile` (`lib/turnstile-client.ts:170`).
   That awaits `token()` (up to 20 s), POSTs, and on success calls
   `window.location.assign(nav.url)`.
3. While the request runs, the button is only `disabled` (:606-609). Its label
   does not change.

Server (`app/api/v1/public/orgs/[orgSlug]/competitions/[slug]/register/route.ts`):

| Stage | Where | Shape |
|---|---|---|
| rate limit ×2 | route :35, :53 | 2 calls |
| Turnstile siteverify | route :38 → `server/turnstile.ts:133` | 1 HTTP round trip, 10 s timeout |
| current user | route :71 | 1 read |
| division context | `registration-submit.ts:485` (`loadEntryDivisionCtx` :335) | **loop**, 1 query per division |
| submit settings | :508 (`loadSubmitSettings` :285) | **loop**, 1 query per division |
| online chess offered + Lichess check | :618, :626 | loop per entry, online divisions only |
| paid feature | :667 `requireFeature("registration.paid")` | **loop**, same arguments for every paid card division |
| plan limit | :677 `getLimit` | once |
| seat gate | :685 `openRegistrationSeatGate` | loop per online division |
| cart transaction | :692-1015 | settings `for update` per division, group insert, per-entry count + insert + players + materialise, group update |
| checkout mint | route :103-110 → `checkout.ts:457 mintGroupCheckout` | re-reads the group's `payment_method` (:463), pending entries (:466) and `divisionCtx` (:471), then `createRegistrationCheckout` reads entries again (:244), the org account (:275) and the fee percent (:295), then Stripe `checkout.sessions.create` (:306), then `stampGroup` (:388) |
| cart mail | route :126 `await notifySubmitted` → `mail.ts:295` | `buildCartMail`: group, entries, divisionCtx, 2× invites, recipient locale, (+1 offline) reads, then `enqueueEmail` insert. **Awaited before `reply(201)`.** The first send runs after the response via `deferred()`. The mail carries no `checkout_url` (route :117-123). |

No `Server-Timing` header and no timing helper exist anywhere in `apps/` or
`packages/`.

### 3.2 Measure first (B0)

- A small server timing helper, `apps/web/src/server/timing.ts`:
  `createStageTimer()` returns `{ stage(name, fn), mark(name), header(), summary() }`.
  It uses `performance.now()` and has no dependencies.
- The register route records these stages: `rate_limit`, `turnstile`, `user`,
  `pre_tx` (with sub-stages `division_ctx`, `settings`, `entitlements`,
  `seat_gate`, `online`), `tx`, `mint` (sub-stages `mint_reads`, `stripe`),
  `mail` and `total`.
- Output is twofold:
  - one structured log line per submit: `log.info({ timing, group_id, divisions,
    entries, paid }, "register.submit.timing")`. It always runs.
  - a `Server-Timing` response header, only when `REGISTER_SERVER_TIMING=1` is
    set (stg). Stage names are internal detail, so prod does not send them by
    default.
- The usecase takes an optional timer parameter. Without one it behaves exactly
  as today, so non-route callers (smoke, tests) are untouched.
- Client wall time, measured by the probe and not shipped in the product: click
  → `token()` resolved → response → `location.assign`.
- **Measurement protocol on stg:** 10 submits each of (a) a 1-entry free cart,
  (b) a 1-entry card cart, (c) a 3-division card cart. Record the median and
  p90 per stage plus client wall time. Do it once before B1 and once after.
  Both tables go on the B1 sign-off page and in the spec appendix (§10).
- **Blocker:** `.github/workflows/stg.yml` deploys only on `push` to `main`, so
  instrumentation on this branch never reaches stg. See Q1.

### 3.3 Fixes (B1)

1. **Turnstile at form open.** Mount `<TurnstileWidget>` once, at the stepper
   root, outside the step switch, inside an invisible but laid-out container.
   An invisible widget still needs a container, so use `aria-hidden` on a 0×0
   box, not `display:none`. Expiry:
   - Pass `"refresh-expired": "auto"` explicitly.
   - Record `issuedAt` when a token arrives.
   - `token()` treats a token older than `TOKEN_MAX_AGE_MS = 270_000` (300 s
     validity minus a 30 s margin) as absent. It calls `reset()` and waits for a
     new one.
   - The expired-callback calls `reset()`, not only nulling the token.
   - Every submit consumes its token, success or failure. `withTurnstile`
     already resets in `finally` (:170-180); keep that. A retry after an error
     gets a fresh token.
2. **Parallel pre-transaction reads.**
   - `loadEntryDivisionCtx` and `loadSubmitSettings` run as one `Promise.all`
     over distinct divisions.
   - `requireFeature("registration.paid", comp)` runs **once** per submit when
     any paid card division is in the cart, not once per division.
   - Seat gates for distinct online divisions run concurrently.
   - **Error precedence is unchanged:** when several divisions would fail, the
     error reported is the one the serial loop reported first, in cart order.
     To keep that, use `Promise.allSettled` and then scan in cart order. Do not
     race.
3. **Cart mail after the response.** The route wraps `notifySubmitted(...)` in
   `deferred(() => …)` (`lib/deferred.ts`), so the build and the enqueue run in
   Next's `after()` window. The mail has no `checkout_url`, so it does not
   depend on the mint. `notifySubmitted` already never throws.
   - Consequence: under vitest, outside a request scope, `deferred` is
     fire-and-forget. A test that reads the outbox straight after the usecase
     must await the queue (see plan B1 T5).
4. **Pass the just-written cart into the mint.** `mintGroupCheckout` gains an
   optional fifth argument, `known?: KnownCart`, where `KnownCart =
   { paymentMethod: "stripe" | "offline" | null; payableIds: string[]; ctx:
   DivisionCtx }`. When the argument is given, the three reads at
   checkout.ts:463-471 are skipped. The other callers (resume checkout,
   waitlist promotion) pass nothing and keep re-reading.
   - `payableIds` comes from the submit result: entries with status `pending`
     and `amount_cents > 0`, in cart order.
   - The `ctx` already loaded at registration-submit.ts:485 is returned on the
     result for the first division.
5. **Staged button text.** Phase `idle` → `saving` ("Saving your place…") →
   `opening_payment` ("Opening secure payment…", only when the response has a
   `checkout_url`) → navigation. A free cart goes `saving` → navigation. On an
   error the phase returns to `idle` and the button label returns to its
   ready-state text.

**Acceptance:** after-measurement medians reported per stage. Expected
reductions: the client token wait to ~0 for a typical Review dwell; `pre_tx`
from N serial round trips to ~1 round trip per class; mail removed from the
response path; mint reads −3. No numeric SLO is promised. The owner judges the
tables.

---

## 4. Entries capacity and waitlist (B3)

### 4.1 Card states

`PublicDivisionInfo` already computes `waitlisted` (settings.ts:471). The Zod
wire schema (`server/api-v1/schemas/registration.ts:298`) and `DivisionLike`
(`components/public-site/register/types.ts:59`) drop it. B3 carries it through.

`remaining` becomes `hardCap - active`, where `hardCap = min(capacity ??
∞, planLimit ?? ∞)`, the same rule as submit. The plan limit is fetched once per
competition with `getLimit(org, "entrants.per_division.max", comp)`. When both
are null, `remaining` stays null and the card shows nothing.

Card state is a pure function, `capacityState(d: DivisionLike, inCart: number):
CapacityState`, in `components/public-site/register/capacity.ts`. It checks the
**closed case first**:

| State | Condition | Card line | CTA |
|---|---|---|---|
| `closed` | `!open` (`closed_reason` ∈ window / payments_unavailable / entry_kind_unavailable) | today's closed copy | disabled |
| `waitlist` | `open && remaining === 0` (closed_reason `full`) | "Full · join the waiting list ({n} waiting)". The "({n} waiting)" part is dropped when `waitlisted === 0`. | "Join waiting list" |
| `few` | `open && remaining !== null && 1 ≤ remaining ≤ 3` | "{n} places left", emphasised (house warning token, bold) | "Add entry" |
| `places` | `open && remaining > 3` | "{n} places left" | "Add entry" |
| `uncapped` | `open && remaining === null` | nothing | "Add entry" |

**Cart arithmetic:** the cart knows only the page-load counts. Entries the person
adds to one division take its remaining places in cart order. Entry k (1-based)
into a division with `remaining = r` is labelled "Waiting list — not charged
now" when `k > r`. This matches what submit does: earlier entries of the same
cart are counted inside the lock (registration-submit.ts:796-799). Waitlisted
entries are excluded from the cart and review total, and the button amount
follows the total.

A solo (free-agent) entry is never waitlisted (FP2). Its card state is computed
from the solo pool exactly as today, and `capacityState` is not applied to it.

**The server stays the authority.** If counts moved since page load, the status
page shows the real outcome. No client-side refusal is added.

### 4.2 Waitlist position on the status page

A new helper, `waitlistPositionSql(tx, alias)` in
`server/usecases/registrations/waitlist.ts`, returns a SQL fragment:

```
(select count(*)::int from registrations w
  where w.division_id = r.division_id and w.status = 'waitlisted'
    and (coalesce(w.waitlisted_at, w.created_at), w.id)
      < (coalesce(r.waitlisted_at, r.created_at), r.id)) + 1
```

The fragment is used when `r.status = 'waitlisted'`, otherwise null. It has the
same order as `promoteNext` (waitlist.ts:98). Two places use it:
- `buildGroupStatusView` (`group-status.ts`), which adds `waitlist_position:
  number | null` to `GroupEntryView`;
- the organiser list (`list.ts:328-331`), replacing the `(created_at, id)`
  ordering (FP4).

On the waitlisted entry card, "You're #{n} on the waiting list" replaces the bare
waitlisted note.

---

## 5. Status page (B4)

Route: `/live/:org/:comp/register/status?rid&token`. The page is
`app/(public)/live/[orgSlug]/[competitionSlug]/register/status/page.tsx`, with the
view model in `view-model.ts` and cards in `entry-card.tsx`.

### 5.1 Layout, top to bottom

Same width and type scale as the register steps.

1. **Headline** from `cartHeadline(entries)`, a pure function in `view-model.ts`.
   It checks the empty case first, and the first matching rule wins:
   - no entries → `closed` ("This registration is closed")
   - any entry whose `resolveMoneyState` is `stripe_due` or `offline_due` →
     `pay` ("Pay to finish entering")
   - any `confirmed` entry and no `pending`/`paid` entry → `in` ("You're in")
   - any `pending` or `paid` entry → `received` ("Entry received, awaiting
     approval")
   - any `waitlisted` entry → `waitlist` ("You're on the waiting list")
   - otherwise (only withdrawn/expired/rejected) → `closed`
   - Below the headline: "Confirmation sent to {email}." This states a fact:
     the mail is queued at submit.
2. **Reference hero.** The cart ref in the largest type on the page, with a Copy
   button (`components/copy-link.tsx` pattern; label "Copy reference", then
   "Copied"). Test id `reg-status-ref`.
3. **Entries** (existing `EntryCard`s). Each card in a 2+ entry cart shows its
   per-entry ref (B5). A waitlisted card shows its position (B3).
4. **Money line** (§5.3).
5. **What happens next** (§5.2).
6. **Invite block** (`invite-teammates.tsx`), restyled (§5.4).
7. **Quiet footer**: "Resend confirmation email" and "Cancel this entry" as text
   links, `text-ink-muted`, 44 px tap height. Per-entry Cancel stays reachable
   from each card's own footer link. The cancel confirmation flow is unchanged.

### 5.2 What happens next: real data only

`buildGroupStatusView` gains:
- `competition_starts_on: string | null` (already selected at group-status.ts:230)
- `competition_ends_on: string | null`
- `venue_name: string | null`, from
  `select distinct v.name from fixtures f join divisions d on d.id =
  f.division_id join venues v on v.id = f.venue_id where d.competition_id = $1
  limit 2`. Fixtures carry no `competition_id` (V214), hence the join through
  divisions. It is non-null only when exactly one row comes back (FP1).

The pure function `whatHappensNext(view, now): NextItem[]` in `view-model.ts`
returns at most 3 items, in this order:

| Item | When | Copy (en) |
|---|---|---|
| `dates` | `starts_on` set | "{name} starts on {date}." When `ends_on` is set and differs: "{name} runs {start} to {end}." |
| `venue` | `venue_name` set | "Played at {venue}." |
| `step` | by headline kind: `pay` → "Pay by {deadline} to keep your place." (no deadline → "Pay to keep your place."); `received` → "The organiser reviews your entry. This page shows their decision."; `waitlist` → "If a place opens, your entry moves up and this page shows it."; `in` with unclaimed teammate slots → "Send each teammate their invite link below."; `in` otherwise → "Nothing else to do. Keep this page — it's your entry."; `closed` → no step item |

- No item promises an email. No item invents a time.
- The empty case: no `starts_on`, no venue and the `closed` kind gives zero
  items, and the section is not rendered.

### 5.3 Money line

`cartMoneySummary(entries)` replaces the `cartSubtotal` display. `cartSubtotal`
stays exported until no caller remains. All amounts are in cents.
- `paidCents` = Σ over entries whose new `settled_by` is `card` or `offline`,
  of `amount_cents − refunded_cents`, floored at 0.
  - **Why not status:** `confirmRegistrationWaived` (`organiser-actions.ts:162`)
    confirms without touching `amount_cents`. Counting by status would show a
    comped entry as "Paid £15.00".
  - `buildGroupStatusView` derives `settled_by: "card" | "offline" | "waived" |
    null` per entry from the same competition-event family that the pay page
    already treats as settled (`pay-page.ts:97-102` `PAID_EVENT_TYPES`):
    - `registration.fee_waived` → `waived`
    - `registration.offline_paid` → `offline`
    - `registration.confirmed` or `registration.paid_awaiting_approval` with a
      payment → `card`
    - The implementer pins the exact payload predicate against the tree, with
      one test per path, including a cart paid through one group checkout.
- `dueCents` = Σ over entries whose `resolveMoneyState` kind is `stripe_due`,
  `offline_due` or `window_closed` of `amount_cents`. `window_closed` is still
  owed; it shows as due with no Pay button.
- Rendering:

| Condition | Shows |
|---|---|
| `paidCents > 0 && dueCents > 0` | "Paid £X · £Y still due" (owner 6) |
| `paidCents > 0` only | "Paid £X" |
| `dueCents > 0` only | "£Y due" |
| neither, and some waitlisted | today's waitlisted subtotal ("£Z if a place opens — not due now") |
| otherwise | "Nothing to pay" |

- **Guard:** a waived entry counts as neither paid nor due. The plan pins this
  with a test that drives the real `confirmRegistrationWaived`, not a fixture.
- Money formats to 2 decimals (owner 2026-11-12, "£15.00").

### 5.4 Invite block at 320

Rows are name + status chip + Copy/Share (the shape signed off in #1197). At 320
the chip moves under the name instead of squeezing it: a `flex-wrap` row, with
`min-w-0` on the whole ancestor chain and `truncate` on the name. The block uses
the status page's card style.

---

## 6. Per-entry reference (B5)

### 6.1 Storage

- Migration `V515__registration_cart_position.sql`. **Re-check the highest V
  number after the rebase onto main.** This branch tops at V514; main tops at
  V509.
  - `alter table registrations add column cart_position smallint;`
  - Backfill: `update registrations r set cart_position = x.n from (select id,
    row_number() over (partition by group_id order by created_at, id) n from
    registrations) x where x.id = r.id;`
  - `alter table registrations alter column cart_position set not null;`
  - `create unique index registrations_group_position_uq on
    registrations(group_id, cart_position);`
- The backfill is safe and loud: prod has 0 registrations (owner, 2026-11-12),
  and stg data is test-only. The migration header says so.
- Submit sets `cart_position` from the `prepared` index + 1 at both insert
  sites (registration-submit.ts:853, :873). Nothing else ever writes it.

### 6.2 Format

`entryReference(refCode: string, position: number, cartSize: number): string` in
`apps/web/src/lib/ref-code.ts`:
- returns `refCode` when `cartSize < 2`
- otherwise returns `` `${refCode}-${position}` ``
- `cartSize` counts **every** entry of the cart, whatever its status, so a
  withdrawal never changes another entry's reference.

`parseEntryReference(input: string): { refCode: string; position: number |
null } | null` accepts `SZ-XXXX-XXXX` or `SZ-XXXX-XXXX-<n>`. It is
case-insensitive, trims whitespace, and uses the alphabet from `ref-code.ts:13`.

### 6.3 Where each reference shows

| Surface | Reference |
|---|---|
| Status page hero, cart mail, `/r/[ref]` ticket, mails about the whole cart | cart ref (unchanged) |
| Status page entry card (2+ cart) | entry ref, small, under the division name |
| Per-entry pay page `/r/pay/<token>` (`pay-page.ts:172`, `pay-page-view.tsx:121`) | entry ref |
| Offline instructions on the pay page (`pay-page.ts:174` `fillPaymentInstructions`) | entry ref as `{{reference}}` |
| Payment reminder mail (`mail.ts:444`, `email-templates/payment-reminder.ts`) | entry ref |
| Promoted-from-waitlist mail (`email-templates/registration-promoted.ts:49`) | entry ref (it is always about one entry) |
| Status page offline instructions block (cart level, page.tsx:126) | cart ref when the instructions cover the whole cart's due amount; entry ref when exactly one entry is due |
| Organiser registrant detail (`registration-hub-registrant-detail.tsx:165`) | entry ref, plus "Cart SZ-…" when the cart has 2+ entries |
| Registrants CSV (`exports.ts`) | new trailing column "Entry reference". Existing columns are unchanged. |

### 6.4 Organiser search

In `list.ts`, the `text` filter adds:
- `or g.ref_code ilike <pattern>`
- when `parseEntryReference(text)` gives a position: `or (upper(g.ref_code) =
  <refCode> and r.cart_position = <position>)`

A search for the cart ref finds every entry in the cart. A search for a suffixed
ref finds that one entry. The placeholder becomes "Search name, email or
reference" (B6).

---

## 7. Register form polish (B2)

Steps keep their ids, order and fields: `who` (Contact), `entries`, `details`,
`consent`, `review`.

### 7.1 Stepper S1

- **Below `md`**: one header block. Line 1 is "Step {n} of {total}" on the left
  and "Next: {nextName}" on the right. On the last step the right side reads
  "Last step". Line 2 is the current step's name in large type. Under that is a
  progress bar at `n/total`.
  - `role="progressbar"`, `aria-valuenow={n}`, `aria-valuemin=1`,
    `aria-valuemax={total}`, `aria-valuetext="Step n of total, Name"`.
- **`md` and up**: today's `<ol>` bar (`step-nav.tsx:31`) is unchanged, except
  that completed steps become buttons that go back to that step. Today they are
  not tappable.
- One DOM. The phone block is `md:hidden` and the desktop `<ol>` is
  `max-md:hidden`.
- **Page heading:** H1 is the competition name. A closing line shows only per
  FP10. The breadcrumb stays.

### 7.2 Action bar

- **Below `md`**: a sticky bottom bar, `sticky bottom-0`, pinned inside the
  register column, with `pb-[env(safe-area-inset-bottom)]`.
  - Left: Back. It is **absent** on step 1, not disabled.
  - Middle: running total, "{k} entries · £X". Hidden when the cart is empty or
    free.
  - Right: the primary button.
- **`md` and up**: the actions sit in the step card's footer, with Back on the
  left and the primary button on the right.
- **Labels:** "Continue to {nextStep}" (`register.nav.continueTo`). On review,
  the submit label is:
  - "Pay £X and enter" for a card cart with a total over 0
  - "Enter the competition" when free
  - "Enter — £X" for an offline fee (today's `register.submit.fee`)
  - The old `register.submit.card` "Continue to payment — {fee}" is retired.
- Keep the testids `reg-back`, `reg-next` and `reg-submit` on the one DOM node
  of each.
- **Public header scroll-away** (phones, register steps only): the org layout
  header (`app/(public)/live/[orgSlug]/layout.tsx:75`, `sticky top-0 z-40`) gets
  `max-md:group-has-[[data-register-flow]]/site:static`. The layout root gets
  `group/site`, and the stepper root gets `data-register-flow`.
  - The status page does **not** carry `data-register-flow`, so its header stays
    sticky.
  - Verify in a browser at 320 that the header scrolls away. The `has-`
    selector cannot be unit-tested.

### 7.3 Per step (mock section B)

- **Contact** (`step-who.tsx`):
  - An error summary at the top: "{n} things to fix before you continue: {list}".
    It has `role="alert"` and is focused on a failed Continue.
  - Each invalid field gets `aria-invalid` and the danger border token.
  - The email error says "Enter an email address, like name@example.com".
  - "I'm registering myself" becomes a choice card: a full-width label wrapping
    the checkbox, title "I'm one of the players", body "We'll put you in as
    player 1 on every entry, so your results stay together." Keep the testid
    `reg-who-playing` on the input.
- **Entries** (`step-entries.tsx`, `division-card.tsx`, `entry-cart.tsx`):
  - The card shows capacity (§4.1), the age rule, and "{n} in your entries" with
    "Add another" when it is already in the cart.
  - "Open" is no longer rendered as a chip.
  - Cart Remove becomes an icon button with a 44 px target and an `aria-label`
    "Remove {division} entry {n}".
  - On phones the cart total lives in the sticky bar.
- **Details** (`step-details.tsx`, `entry-details.tsx`):
  - One card per entry, not an intro card plus an entry card.
  - When "I'm one of the players" is on, player 1 is shown read-only as the
    contact name, with the note "That's you. Change it on the Contact step."
  - Organiser questions sit under the heading "Questions from {org}". Optional
    fields carry an "Optional" tag; required ones carry none.
- **Consent** (`step-consent.tsx`):
  - "Required" and "Optional" tags lead each consent.
  - The "other players confirm their own consent" note becomes one info line
    (icon + text), not a third box.
  - The legal sentence moves to small print under the required consent.
  - Keep the testids `reg-consent-privacy` and `reg-consent-grant`.
- **Review** (`step-review.tsx`):
  - Sections You / Entries / Answers / Consent, each with an "Edit" link that
    jumps to its step. Going back loses nothing: the stepper state persists via
    `storage.ts`.
  - Waitlisted entries are labelled "Waiting list — not charged now".
  - The total is in large type, with "You'll pay by card on a secure Stripe
    page, then come straight back here." for card carts.
  - At ≥ md the footer adds "Confirmation goes to {email}".

---

## 8. Organiser filter bar A3 (B6)

`components/registration-hub-registrant-filters.tsx` (360 lines).

- **URL is the state** (owner 1), as today. The GET form plus `router.push(
  buildFilteredHref)` (:180-191) stays.
  - Refresh, back and share therefore already work. Keep it that way.
  - "Clear all" links to `?tab=registrants`, with no filter params. A bare
    `/registration` would land on the Settings tab (`resolveRegistrationHubTab`
    falls back to settings). So "bare" means no filter params.
- **≥ md, two rows:**
  - Row 1: search, placeholder "Search name, email or reference", with Sort
    beside it.
  - Row 2: one pill per filter. Status, Division and Kind are native `<select>`
    elements styled as pills, each showing "Label: Value" when set and the bare
    label when not. Solo sign-ups and Consent pending are checkbox pills with
    `aria-pressed` styling. Then "Clear all" when any filter is set.
  - A set pill gets the house accent fill and a "×" that clears only that
    filter (a link to the href without that param).
  - Export CSV moves into the hub tab-strip row, right-aligned. It keeps
    `reg.exportCsv`, and its href already carries the filters.
  - Every control is 40 px tall. No stacked labels: each select has an
    `aria-label`.
- **Below `md`:**
  - Search, then a "Filters" button with a count badge of set filters, then a
    row of the set filters as removable chips plus Clear all.
  - The button opens `Modal` in sheet mode (`components/modal.tsx`) holding
    every filter plus Sort.
  - Inside the sheet, edits are staged. "Show registrants" applies them with one
    push; "Clear all" resets.
  - The sheet's open state is local `useState`, never put in the URL.
- **Result line:** "{n} registrants". The mock's "2 of 14" needs an unfiltered
  count query and is not built.
- **Selectors:** keep `[data-registration-hub-registrant-filters]`,
  `select[name=status|division_id|kind|sort]`, `input[name=q]` and the checkbox
  names, so the specs that select by name keep working. The phone sheet's
  selects carry the same names but sit inside the dialog. Specs at phone width
  must open the sheet first (AGENTS.md class 22: open the fold, never weaken the
  assertion).

---

## 9. Division settings as tabs (B7)

### 9.1 URL model

- The `tab` param takes `settings | registrants | division:<uuid>`.
- The `open` param is a comma list of up to 2 division ids, in **least recently
  used first** order.
- A pure module, `components/registration-hub-tabs-state.ts`, owns the parsing
  and every transition:

```
type HubTabsState = { active: "settings" | "registrants" | { division: string }; open: string[] }
parseHubTabs(params: { tab?: string; open?: string }, openable: ReadonlySet<string>): HubTabsState
hubTabsQuery(s: HubTabsState): Record<string, string>
openDivision(s, id): { state: HubTabsState; evicted: string | null }
activate(s, tab): HubTabsState   // moves an activated division to the end of `open`
closeDivision(s, id): HubTabsState   // active falls back to "settings" if it was the closed one
```

- **Normalisation in `parseHubTabs`:**
  - Ids not in `openable` are dropped. `openable` is the divisions with
    registration settings in this competition when `canEdit` is true, and empty
    when it is false.
  - Duplicates are dropped.
  - Only the last 2 ids are kept.
  - A `tab=division:X` whose X is not in `open` is appended, then the list is
    re-capped to 2.
  - An active division that does not survive becomes `settings`.
- `resolveRegistrationHubTab` (`components/registration-hub-tab.ts`) keeps its
  signature for settings and registrants. The page calls `parseHubTabs` in its
  place.

### 9.2 Behaviour (mock D table, built as written)

| Action | Result | History |
|---|---|---|
| "Open settings" on a division row | Adds or activates its tab | push |
| Opening an already-open division | Activates it, no duplicate | push |
| Opening a 3rd division | Evicts `open[0]` (LRU). If the evicted tab is dirty: dialog "{name} has unsaved changes" with Save and open / Discard and open / Cancel. If clean: swap, then a toast "Closed {name} to make room." with **Reopen**, which runs `openDivision` again and so evicts the next LRU. | push |
| × on a clean tab | Closes it; active returns to Settings at the saved scroll position | replace |
| × on a dirty tab | Dialog "Close {name}? You have {n} unsaved changes in {sections}." with Save and close / Discard / Keep editing. At 320 the buttons stack with the primary first. | replace on close |
| Switching tabs | Unsaved edits are kept in memory; a dirty tab shows a dot | push |
| Browser Back that drops a dirty tab from `open` | The host `router.replace`s the tab back in and shows the × dialog | — |
| Reload or close with any dirty tab | `beforeunload` prompt | — |
| Save changes | Saves and stays; toast "Saved"; the dot clears | — |
| Cancel | Resets to the last saved values; the tab stays open | — |

**Keeping edits across a tab switch.** Today the page renders one panel per
`?tab=` on the server, and the config panel unmounts on navigation. B7 adds a
client host, `RegistrationHubTabsHost`. It is always rendered by `page.tsx` at a
stable tree position. It mounts one `RegistrationHubDivisionTab` per id in
`open`, keyed by division id, and hides the inactive ones with `hidden`. The
Settings and Registrants server panels render as its children.

`page.tsx` loads the config rows for the ≤ 2 open divisions on **every** tab, so
the host can mount them. Soft navigation keeps a client component's state when
its type and key are unchanged at the same position. **This is the property the
e2e must prove:** edit, switch to Registrants, come back, the value is still
there. Do not assume it.

### 9.3 Division tab page

- `RegistrationHubConfigPanel` (`registration-hub-config-panel.tsx`, 1343 lines)
  gains a `layout: "modal" | "page"` prop. During the wave the modal path stays
  for one task, then is deleted in T24 once nothing opens it.
- In `"page"` layout at `md` and up:
  - every section's `<details>` is `open`, and its summary is non-interactive;
  - a sticky section index on the left (links to `#section-<id>`, ids from
    `SECTION_IDS`) sits beside the stacked sections;
  - a Save bar is pinned to the bottom of the viewport, reading "All changes
    saved" or "{n} unsaved changes", with Cancel and Save changes.
- Below `md`, sections stay accordions and the Save bar stays pinned.
- **Dirty tracking:** `useConfigDirty(saved, draft): { dirty: boolean; count:
  number; sections: SectionId[] }`. It compares field by field per section with
  the same normalisation that save uses (`use-registration-hub-config.ts`). A
  field edited back to its saved value is clean. A "Changed" tag shows on each
  dirty section header.
- The partial-save outcomes (`put-failed`, `patch-failed`) keep today's banner,
  and the tab stays dirty after either.

### 9.4 Tab strip

- Extract it from page.tsx :223-236 into `RegistrationHubTabStrip`:
  - `role="tablist"` with `aria-label="Registration sections"`;
  - `tabindex="0"` on the scroll container (AGENTS.md class 23: a scrolling
    region owes focusability and a name);
  - `overflow-x-auto`, scrolling inside itself, never the page;
  - the active tab scrolled into view (`ScrollActiveTabIntoView`).
- A division tab has `role="tab"`:
  - its name truncates with an ellipsis at `max-w-[12rem]`, with `min-w-0` up
    the chain;
  - a dirty dot (`aria-label="Unsaved changes"`);
  - a sibling × `<button aria-label="Close {name}">` with a 44 × 44 hit area.
- Testids: `reg-hub-tab-settings`, `reg-hub-tab-registrants`,
  `reg-hub-tab-division` (with `data-division-id`), `reg-hub-tab-close`.
- The division row's configure button (`registration-hub-division-row.tsx:238`)
  becomes a labelled "Open settings" button and keeps
  `data-registration-hub-row-configure`.

---

## 10. Appendix — latency measurements

Filled by B0 (before) and B1 (after). One row per stage, in ms, as median / p90,
for each of the three cart shapes in §3.2.

| Stage | free 1-entry | card 1-entry | card 3-division |
|---|---|---|---|
| (see Before below) | | | |

### Before (stg, 2026-11-13, 778d6d57aa)

stg.seazn.club, comp stream-matrix-test-club/reg-smoke-2026-11-13, headed Chrome, Server-Timing stages confirmed on the POST. Median / p90 in ms.
Shapes: card1 = Open Singles (card), card3 = Open + Masters + Junior (card cart), offline1 = Offline Singles. **n=5 per shape, not 10**: the run
was cut short by the owner, and the route's per-IP rate limit (5 per 300 s per competition) forced 65 s spacing. Earlier runs lost their
samples to a crash (stderr totals only, same range). pre_tx.seat_gate / pre_tx.online stages were not emitted by this build.

**card1** (n=5, HTTP [201])

| metric (ms) | median | p90 |
|---|---|---|
| server rate_limit | 8.6 | 14.1 |
| server turnstile | 48.1 | 59.0 |
| server user | 0.1 | 0.2 |
| server pre_tx | 38.0 | 97.8 |
| server pre_tx.division_ctx | 8.7 | 10.6 |
| server pre_tx.settings | 5.6 | 6.0 |
| server pre_tx.entitlements | 22.9 | 82.2 |
| server tx | 61.3 | 94.3 |
| server mint | 544.7 | 570.9 |
| server mint.mint_reads | 33.4 | 45.1 |
| server mint.stripe | 503.4 | 512.0 |
| server mail | 44.6 | 117.9 |
| server total | 720.9 | 934.9 |
| client click->request (token) | 36 | 100 |
| client request->response | 848 | 1050 |
| client response->navigation | 389 | 652 |
| client click->navigation (wall) | 1234 | 1730 |

**card3** (n=5, HTTP [201])

| metric (ms) | median | p90 |
|---|---|---|
| server rate_limit | 8.3 | 8.7 |
| server turnstile | 39.0 | 44.1 |
| server user | 0.1 | 0.1 |
| server pre_tx | 66.8 | 111.0 |
| server pre_tx.division_ctx | 16.7 | 29.8 |
| server pre_tx.settings | 13.2 | 42.1 |
| server pre_tx.entitlements | 23.1 | 68.1 |
| server tx | 108.5 | 141.9 |
| server mint | 595.2 | 709.7 |
| server mint.mint_reads | 39.5 | 40.9 |
| server mint.stripe | 555.1 | 660.4 |
| server mail | 57.3 | 73.1 |
| server total | 869.6 | 1055.0 |
| client click->request (token) | 23 | 34 |
| client request->response | 1010 | 1137 |
| client response->navigation | 188 | 543 |
| client click->navigation (wall) | 1225 | 1576 |

**offline1** (n=5, HTTP [201])

| metric (ms) | median | p90 |
|---|---|---|
| server rate_limit | 8.1 | 10.8 |
| server turnstile | 38.7 | 50.3 |
| server user | 0.1 | 0.1 |
| server pre_tx | 51.1 | 72.7 |
| server pre_tx.division_ctx | 16.3 | 22.6 |
| server pre_tx.settings | 5.7 | 14.4 |
| server pre_tx.entitlements | 22.6 | 43.8 |
| server tx | 96.9 | 129.7 |
| server mint | 11.3 | 25.8 |
| server mint.mint_reads | 11.2 | 25.8 |
| server mail | 90.2 | 159.3 |
| server total | 314.9 | 409.0 |
| client click->request (token) | 26 | 31 |
| client request->response | 453 | 500 |
| client response->navigation | 201 | 276 |
| client click->navigation (wall) | 668 | 782 |

---

## 11. Owner questions

- **Q1 — Where to measure.** stg deploys only on push to `main` (`stg.yml`), so
  B0's instrumentation cannot reach stg from this branch.
  - **Recommendation:** ship B0 alone as a small, behaviour-neutral PR to
    `main`. It adds the timing log and an env-gated `Server-Timing` header, plus
    `REGISTER_SERVER_TIMING=1` on the stg app.
  - Measure on stg, then build B1 on the wave branch and re-measure after the
    wave merges.
  - This is the one exception to "one PR per wave".
  - The alternative, a local prod build against the local DB, does not measure
    stg's network round trips, which the trace says dominate.
- **Q2 — Venue.** Competitions have no venue (FP1).
  - **Recommendation for this wave:** show a venue only when every fixture with
    a venue shares one. Otherwise show none.
  - A real "competition venue" field would be a separate small feature.
