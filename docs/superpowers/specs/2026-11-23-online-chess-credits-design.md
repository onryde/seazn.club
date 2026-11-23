# Online Chess: paid by size, with Seazn credits

**Status:** APPROVED by the owner 2026-11-23, revised after an independent review (2026-11-23; `.superpowers/sdd/2026-11-17-chess-external-play/online-chess-credits-design-review.md`, with a response table at its end). Every owner decision of 2026-11-23 is recorded in §3, including the UI flow. No owner question is open; the two the review raised are closed by decisions 15 and 16. §4 holds the controller's remaining calls, which the builder may plan on. No code, price or limit has changed.

**Mockups (layout only):** `~/seazn-artifacts/2026-11-23_online-chess-cost-layout-v2_oc23a002/index.html`. Where a mock and this document differ, this document wins. Three known differences: the mocks show a "Create · spend" button on Review, but Review is price-only and spends nothing (decision 12); the round-1 receipt preselects the size the organiser chose, not the smallest that fits (decision 15); and the paid chip's link is "Change size", which goes down as well as up (decision 16).

**Lineage:**
- [camera costing paper](2026-11-21-chess-online-camera-costing.md) (uncommitted)
- [plan-limits re-cut](2026-11-21-plan-limits-recut-design.md) (another session, unmerged)
- the pricing re-cut of 2026-11-16 (PR #1239, V526)
- the 256 online cap (PR #1289, unmerged)

**Where the code was read.** Every `file:line` below is in the worktree `seazn.club-worktrees/chess-combo` (main plus PR #1289), under `apps/web/src/` unless the path starts with `db/` or `apps/web/content/`. On `origin/main` without #1289 the online cap is 128, not 256. Re-pin every line before building on it.

## 1. Intent

Online Chess costs Seazn real money when cameras run, and it is the one feature whose cost grows with the size of the event. The owner wants it paid for in a way an organiser can understand before the event: pick a size, pay once, run the event. The price must not depend on rounds, time control or how many games are played, and it must never surface during play or to a player.

The payment uses the credits the club already has. The streaming credit becomes one general currency, the **Seazn credit**, which buys a streamed match or a share of an online chess event.

## 2. Goals, non-goals, anti-goals

**Goals**
- One purchase per online division, made before play, sized by players: 16, 32, 64, 128 or 256.
- The bought size is the division's entrant limit. An organiser who outgrows it before play upgrades and pays only the difference.
- One currency. Streaming and Online Chess draw on the same balance and the same packs.
- The plan's included monthly credits are the only free allowance.
- A feature page that sells Online Chess from real product screens.

**Non-goals**
- A per-round, per-game or per-minute price.
- A time-control multiplier (owner decision 6).
- New pack sizes or new pack prices.
- Any change to over-the-board chess, or to any other sport.
- Any change to the 256 capacity cap or to the plan's own entrant cap.
- A second ledger.

**Anti-goals** (the work has failed if any of these happen, even if it ships)
- A player sees a price, a paywall, an upgrade prompt, or the words "credit", "plan" or "size".
- A running event is stopped, paused or refused a round for a payment reason.
- Scoring, pairing, results or standings are gated. All scoring stays free.
- A credit is taken twice for one purchase, or an expired included credit comes back as a new one.
- The words "External Play" reach a user.

## 3. Owner decisions (2026-11-23, binding)

1. **Names.** The feature is "Online Chess". Camera supervision is "Fair-play camera". "External Play" is internal only.
2. **Whole-event package, bought before the event, sized by players.** Sizes are 16, 32, 64, 128 and 256. 256 is the online cap. The organiser "need not care" about Swiss rounds: each size includes the standard rounds for that size. Knockout, play-off and tie-break games are always included. More rounds means the next size.
3. **No free size.** Every size costs credits on every plan. The plan's free allowance is only the Seazn credits the plan already includes. (This replaces the earlier "Community 16 / Pro 32 free" rule, and removes the question of how often a free size is free.)
4. **Pay with the existing stream credits, renamed "Seazn credits" everywhere.** Packs stay as they are.
5. **Price.** One size unit is 16 players. One unit costs 1 credit without cameras and 2 with.

   | Size | Without cameras | With Fair-play camera |
   |---|---|---|
   | 16 | 1 | 2 |
   | 32 | 2 | 4 |
   | 64 | 4 | 8 |
   | 128 | 8 | 16 |
   | 256 | 16 | 32 |

6. **No time-control multiplier.** Classical costs the same credits as rapid. The owner chose to absorb the classical camera cost. It is recorded as a cost risk in §12.
7. **The size is the registration limit.** The organiser buys a size, and that size becomes the division's limit. If sign-ups outgrow it before the start, they upgrade to the next size and pay only the difference. Nothing is ever blocked or stopped mid-event, and nothing changes after the first round starts.
8. **Included monthly credits expire at the end of the month.** They do not roll over. Purchased packs keep their own behaviour.
9. **Online Chess covers only Swiss and knockout,** including play-offs and tie-breaks. League, group and all-play-all formats cannot turn online play on. (This replaces an earlier ruling the same day that league and group rounds would count like Swiss rounds.)
10. **Accepted from the controller proposals:** no refund for unused size; expired included credits never return; rounds added mid-event stay free, and are measured.
11. **Community keeps 1 included credit a month,** shared between Online Chess and streams.
12. **The UI flow** (owner-confirmed; detail in §8):
    - The division builder is information only. Nothing is spent there.
    - The size is one new select, "Players, up to", in the shared Division rules strip, shown only when online play is Lichess. A price line sits under it. The Review step shows the same price as a line.
    - Payment is asked for on the division page, by an amber line in the Fixtures tab's rules strip, and at "Open round 1".
    - Round 1 cannot open until the division is paid.
    - Once paid, the size can still be changed until round 1 (the difference is charged, or returned: decision 16). After that the size is locked.
    - Players never see any of this.
13. **Optional cameras cost the camera price:** 2 credits per 16, the same as required cameras.
14. **A paid division that is deleted, or switched off online play, before round 1 is refunded automatically:** bought credits in full, and included credits only while their month has not ended.
15. **"Open round 1" on an unpaid division preselects the size the organiser CHOSE,** not the smallest that fits. They can change it in the receipt.
16. **A paid size can move DOWN before round 1.** The difference is refunded under the standard refund rule: bought credits in full, included credits only within their month. (So decision 10's "no refund for unused size" applies once round 1 has opened.)

## 4. Controller proposals

P2, P6, P7, P9 and P11 are now owner decisions (decisions 10, 13 and 14) and keep their numbers because the rest of the document cites them. The rest are the controller's calls on gaps the rulings left. None of them needs the owner; the builder may plan on them, and the owner can overrule any of them at approval.

| # | My call | Status | Why |
|---|---|---|---|
| P1 | Included rounds per size are log2(size) + 2: 16→6, 32→7, 64→8, 128→9, 256→10. | My call | Above the product's own Swiss default at every size (§5.6), so an organiser who accepts the default never meets it. |
| P2 | Unused size is not refunded once round 1 has opened. Buying 64 and seating 20 costs 64. Before round 1 the organiser can move down (decision 16). | **Owner accepted** (decisions 10, 16) | A size is a reservation of capacity. |
| P3 | The package is paid at the moment the organiser pays, not when the event runs. This month's included credits can pay for next month's event. | My call | One debit, one moment. See §9.3. |
| P4 | Expiring included credits are spent before purchased ones. | My call | Already the ledger's rule for streams (§5.1). |
| P5 | An upgrade bought in a later month draws on that month's balance. | My call | Follows from P3 and P4. |
| P6 | A refund returns purchased credits always, and included credits only while they are still inside the month they were spent in. | **Owner accepted** | Expired included credits never return. |
| P7 | A paid package is refundable only while no round of the division has been opened, and then automatically. | **Owner accepted** (decision 14) | The first opened round is when money is committed to the vendor. |
| P8 | "The first round starts" means the first time ANY round of the division is opened, whatever its number or stage. The package's `frozen_at` records it and is the ONLY thing the package doors read. | My call (revised after review) | The camera rule locks at the same instant (§5.4) but keeps its own read, `anyRoundOpened`, whose rows vanish with a deleted stage. One authority per fact. |
| P9 | "With cameras" means the EFFECTIVE policy of any stage of the division is `optional` or `required`; for a division with no stages yet, the division's own effective policy. The policy resolves nearest-level-wins (`camera-policy.ts:33-39`), so a competition on `required` with the division set to `off` is "without". | **Owner accepted** (decision 13); wording corrected after review | An optional camera still spends camera minutes. |
| P10 | An online division is refused above 10 Swiss rounds in total before the first round opens. | My call | 256 is the largest size and includes 10. There is no next size. |
| P11 | "Add a round" after the first round has opened stays free and ungated, and is measured. | **Owner accepted** | Never block mid-event. |
| P12 | The chosen size is the entrant limit from the moment it is chosen, paid or not. | My call | The owner's amber line reads "N registered, up to S" on an unpaid division. |
| P13 | Before round 1 the size can be changed up or down, to any size that holds the places held, covers the counted rounds and is allowed by the plan. Unpaid: free. Paid: up charges the difference, down returns it. | **Owner decision 16** | Replaces "once paid, it only goes up". |
| P14 | A new online division opens at 16, or at the smallest size that holds the places already taken. The default is computed ONCE, when the row is written, never at read time. | My call (revised after review) | A default computed on every read grows with the field and is not a cap. Existing divisions get their row from the migration (§7.1). |
| P15 | Counted rounds are the sum of `config.rounds` over the division's Swiss stages. Knockout, play-off and tie-break stages count nothing. | My call | Decision 2, stated as arithmetic. |
| P16 | The stage kinds an online division may hold are `swiss`, `knockout`, `double_elim`, `page_playoff` and `stepladder`. Refused: `league`, `group`, `ladder` (`americano` is already refused for chess). | My call | Decision 9 names Swiss and knockout "including play-offs". Double elimination is a knockout; a ladder is open-ended and has no size. |
| P17 | A plan cap that is not a ladder value (a size pack's 96) may choose the smallest size at or above it. min(plan cap, size, 256) still limits the seats. | My call (from review) | Otherwise a club allowed 96 could only buy 64. |
| P18 | Moving up a size promotes the waitlist into the new room, by the same automatic promotion a freed place triggers. | My call (from review) | An organiser who pays for 64 must not still have 20 people waiting. |
| P19 | Cameras turned OFF after the camera price was paid, before round 1: no partial refund, and they can be turned on again at no charge. A move down in size is priced at the camera rate on both sides when cameras are paid. | My call; stands | Decision 16 rules on size. Returning the camera half as well would need a way to un-pay cameras while the policy can still flip back, for a small sum. The full refund of decision 14 remains the way out. |
| P20 | An unpaid online division can be Started and scored by hand; only opening an online round needs payment. | My call (from review) | It costs Seazn nothing (no invites, no games, no cameras), and scoring is free. |
| P21 | On a move down, bought credits are returned first, then included credits spent in the current month. Included credits from an earlier month are the last to be counted, and return nothing. | My call | Decision 16 fixes WHICH credits can return, not the order when a package was paid from both. This order returns the most the rule allows. |

## 5. What the code does today

### 5.1 The credit ledger

- **One table, rows only.** `org_stream_credits` is append-only, with `delta <> 0`, `balance_after >= 0`, and a `reason` in purchase, consume, refund, grant, revoke, expire (`db/migration/deltas/V410__stream_sessions.sql:250-260`). The balance is `sum(delta)` (`server/usecases/stream-credits.ts:58-62`).
- **The money lock.** Every writer takes a per-org advisory lock first (`stream-credits.ts:96-105`).
- **Two buckets.** `monthly` is the plan's included credits; `pack` is bought packs, Event Pass grants and staff grants (`db/migration/deltas/V426__streaming_every_plan_monthly_credits.sql:75-77`).
- **Included credits already expire.** At the first touch in a new UTC month the leftover `monthly` balance is written off, then the new month is granted (`stream-credits.ts:975-1011`). Pack credits are never swept. Owner decision 8 is already the behaviour.
- **Included credits are already spent first.** A consume draws `monthly` while it is above zero, else `pack` (`stream-credits.ts:238`).
- **Included amounts.** Community 1, Pro 5 and Enterprise 20 a month; the same rows hold `event_pass` and `event_pass_l` (`V426:65-73`). An Event Pass grants 3 once, as never-expiring pack credits (`db/migration/deltas/V526__pricing_recut_fees_credits_stream_cap.sql:28-31`, `stream-credits.ts:1030-1032`). The brief gives 20 for the reworked pass; that is in the unmerged plan-limits work and was not verified in any tree I read.
- **A stream consume is exactly one credit, tied to a stream session.** `consumeForSession` writes `-1` with a `session_id` (`stream-credits.ts:195-246`). Nothing today debits more than one credit, or debits without a session.
- **Purchase is replay-safe** by a table-wide unique `stripe_event_id`, with an org-scoped read-back (`stream-credits.ts:262-300`).
- **Refund rules.** A refund goes back to the bucket its consume was drawn from, and is capped at what that session consumed (`stream-credits.ts:764-778`). A refund that lands after the month has rolled returns to `monthly` and lives until the next rollover (`stream-credits.ts:940-942`). That differs from P6.
- **Card refunds and disputes** on a pack revoke what is left of the pack, capped at the balance; credits already spent are not reversed (`stream-credits.ts:344`, `:441`).
- **Staff adjustments** are 1 to 50 credits, need a note and an idempotency key, and write an audit row (`stream-credits.ts:558-581`).
- **Packs.** 1, 5 and 20 credits at £3, £12, £40; €3.50, €14, €45; $3.99, $15, $49; ₹199, ₹799, ₹2,499 (`lib/stream-credit-packs.ts:85-89`). Checkout sessions carry `kind: "stream_credits"` (`lib/relay-checkout.ts:55-64`), and fulfilment converges on `recordPurchase` from the webhook and the return page (`server/usecases/stream-credits-checkout.ts:52`, `:118`, `:212-215`).
- **Buying packs is gated on streaming, in two places.** The credits tab offers packs only when the relay is up and the org is entitled to phone streaming (`server/usecases/stream-credits-tab.ts:33`, `:55`), and its monthly grant is tied to the same offer (`:64`). The binding gate is the checkout route: `app/api/billing/relay-checkout/route.ts` requires `streaming.overlay` and `streaming.relay` (`:119-120`) and knows two return targets only, a fixture's stream panel or Settings (`:33-38`).
- **The ledger is sealed.** RLS is enabled and forced with no policy (`V410:413-414`). Every ledger writer runs on the privileged connection (`sql.begin`), never as the tenant role: purchase (`stream-credits.ts:270`), the claw-back (`:450`), and the stream spend, which runs inside the stream session's own privileged transaction (`server/usecases/stream-sessions/apply.ts:99`).
- **The claw-back counts consumes only.** It takes min(purchased − pack consumes since the purchase, pack balance), is keyed once per payment intent, and writes no row when it claws nothing (`stream-credits.ts:441-528`). It never reads `refund` rows. That is safe while a consume is final, and unsafe once a package consume can come back (§7.5).

**Answer to "can the same ledger debit an online chess package?"** Yes, with three additions: a debit of more than one credit that may span both buckets, a link from the ledger row to the package instead of a session, and the P6 refund rule. No second ledger is needed.

### 5.2 The entrant cap

- The capacity cap is 256 per online division on every plan (`lib/online-chess-cap.ts:13`).
- The effective cap is min(plan cap, 256) (`server/external-play/online-entrant-cap.ts:73-76`), and which refusal answers depends on which one binds (`:67-69`).
- One count answers every door: live entrants plus sign-ups holding a place (`:94-100`).
- Every door takes the `division:` advisory lock before it counts (`:127-129`).
- The doors: add entrants and Reinstate (`:156-166`, `:146-149`), public sign-up (`server/usecases/registration-submit.ts:943`), promote, confirm and waive, the automatic waitlist promotions (`online-entrant-cap.ts:238-258`), the switch that turns online play on (`server/usecases/divisions.ts:1277-1280`), and the registration capacity and places-left reads (`server/usecases/registrations/settings.ts:198`, `:444`).
- The plan limit is read before the transaction, because an entitlement read cannot run inside one (`online-entrant-cap.ts:207-212`).

A purchased size fits here as a third term: min(plan cap, purchased size, 256).

### 5.3 Turning online play on

Online play is `divisions.config.onlinePlay`, `off` or `lichess` (`server/external-play/online-play.ts:9-17`). It can be set at creation (`server/usecases/divisions.ts:346`) and by a later save. Only the off-to-lichess transition is gated, by the flag and by the cap (`divisions.ts:1268-1280`).

### 5.4 Cameras

The policy is `off`, `optional` or `required` at three levels: stage, then division, then competition. The nearest level that is set wins (`server/external-play/camera-policy.ts:33-39`; columns in `db/migration/deltas/V451__online_chess_board_and_camera.sql:230-237`). Once any round of the division has been opened, the policy can only be relaxed; tightening answers 409 `POLICY_LOCKED` (`camera-policy.ts:47-59`, `divisions.ts:928`). "Any round opened" is `anyRoundOpened`: a `stage_round_opens` row for any stage of the division (`server/external-play/round-open.ts:147-157`, read at `divisions.ts:862`).

So an organiser already cannot add cameras after the first round opens. That is exactly the freeze the price needs.

Two limits of `anyRoundOpened`, found in review: its predicate is `opened_at <= now`, and its rows cascade away with a deleted stage (`V451:84-85`). It can therefore answer false for a division that did open a round. It stays the camera rule's read; the package does not use it (P8).

### 5.5 When a division starts

There are three candidate instants:

| Instant | Where | Meaning |
|---|---|---|
| Start | `divisions.status` leaves `setup`/`scheduled` (`lib/division-phase.ts:8`, `:20-22`; `server/usecases/schedule/publish.ts:261`, `:406-414`) | Scoring opens. |
| First round opened | first `stage_round_opens` row (`round-open.ts:147-157`); written by `openRound` (`server/usecases/external-play/open-round.ts:304`) | Invites go out; check-in and cameras begin. |
| First game created | `server/usecases/external-play/create-game.ts` | A Lichess game exists. |

This design uses **first round opened** (P8). The derived division phase (`lib/division-phase.ts:36-37`) is not used: it is a display value.

**The instants are ordered.** `openRound` refuses a division that has not started: it answers `division_not_started` for `setup` and `scheduled` (`open-round.ts:340-342`). So Start always comes before the first open, and "before round 1" is NOT "before Start". In the window between Start and the first open the fixtures exist and are paired, and the package is still unpaid-or-changeable, upgradable and refundable. Every rule in this document that says "before round 1" includes that window.

`openRound` takes the division lock inside its own privileged transaction (`open-round.ts:375-379`) and writes the open at `:532`. Every refusal it makes today runs before that transaction. It has several ways to answer `opened: false` after its checks (not paired, no fixtures, clock not playable, every board held for a Lichess link).

### 5.6 Swiss rounds

- The round count is `stages.config.rounds` on each Swiss stage (`server/usecases/stages/swiss-gen.ts:119-125`).
- The product's default is a band table: up to 8 players 3 rounds, 16→4, 32→5, 64→6, more→7 (`lib/swiss-rounds.ts:20-28`), capped at half the field (`:77-84`).
- The hard maximum is n−1 for an even field. It is refused at Generate and at Start (`swiss-gen.ts:119-136`, `publish.ts:302`).
- A round can be added mid-event ("Add a round", `lib/swiss-door-refusal.ts:1`). I did not read that door's server code.

P1's included rounds (6, 7, 8, 9, 10) are above the default (4, 5, 6, 7, 7) at every size. An organiser who never touches the Rounds box never meets the rule.

### 5.7 The flag

`online-chess` is a PostHog flag, asked per org, off when PostHog is unreachable, and forced on by `ONLINE_CHESS_ALWAYS=1` for local, CI and e2e (`server/usecases/external-play/online-chess-flag.ts:22`, `:44-58`). It gates what starts play and never what finishes it.

## 6. Approaches considered

### A. A per-division package row, linked from the ledger (recommended)

A new table holds one live package per division: size, cameras, credits paid, and when it froze. Ledger rows that pay for it point at it. The cap doors read the size as a third term.

- **For:** the purchase is a first-class fact with its own history. A size change is "price of the target minus the value of this row". Refund reads the package's own ledger rows, so the bucket and month of each credit are known. Deleting the division keeps the money trail. The two-tab race is settled by state under two locks that both already exist.
- **Against:** one new table and one new ledger column. Every reader of `reason = 'consume'` must be checked, since a consume is no longer always a stream.

### B. An entitlement override per division

Write the size into the entitlement system as a scoped override of `entrants.per_division.max`.

- **For:** the cap doors already call `getLimit`, so little door code changes.
- **Against:** overrides are org-scoped, with an optional competition scope, never a division (`lib/entitlements.ts:536`, `:631`). The purchase would be split across a ledger row and an override row with nothing joining them. Cameras and the freeze have no home. A plan change could re-resolve the limit mid-event. The plan cap and the purchased size are different things and should not share a key.

### C. A pass-like grant

Model the package on Event Pass: a one-off purchase that grants capacity.

- **For:** purchase, refund and grant code exists.
- **Against:** a pass is bought with a card, per competition, and the plan-limits work is reshaping or removing it. A package is bought with credits, per division. Reusing it would tie this work to an unmerged branch, and add a third thing called a pass.

### D. Charge at the first round, not at purchase

Hold the size as an unpaid choice and debit when the first round opens.

- **For:** no refund path at all. Credits are spent in the month the event runs.
- **Against, as the ONLY moment:** the organiser can be out of credits minutes before round 1 with players waiting.

**Recommendation: A, with the owner's flow on top.** The owner's confirmed flow (decision 12) takes the useful half of D. The organiser can pay at any time from the division page, and "Open round 1" offers the same payment as a last chance. The amber line makes the debt visible from the day the division is created, so the door is never a surprise. A's row carries both states: chosen and unpaid, then paid.

## 7. Data model

### 7.1 Migration sketch

Take the next free version at build time (the tree's tail is V543).

```sql
create table division_online_packages (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references organizations(id) on delete cascade,
  -- set null, never cascade: a PAID row is the record of a payment and outlives the division.
  division_id      uuid null references divisions(id) on delete set null,
  division_name    text not null,             -- snapshot, for the credit history after a delete
  size             integer not null check (size in (16, 32, 64, 128, 256)),
  cameras_paid     boolean null,              -- null until paid; true = the camera price was paid
  credits_paid     integer not null default 0 check (credits_paid >= 0),      -- everything ever debited
  credits_refunded integer not null default 0 check (credits_refunded >= 0),  -- everything returned
  credits_forfeited integer not null default 0 check (credits_forfeited >= 0), -- included credits that could not return (P6)
  paid_at          timestamptz null,          -- first payment; null = unpaid
  paid_by          uuid null,                 -- the organiser who paid; shown in the credit history
  frozen_at        timestamptz null,          -- first round opened; null = still changeable
  refunded_at      timestamptz null,          -- set once, with the refund rows
  created_at       timestamptz not null default now(),
  check ((paid_at is null) = (credits_paid = 0)),
  check ((paid_at is null) = (cameras_paid is null)),
  check (credits_refunded + credits_forfeited <= credits_paid),
  check (refunded_at is null or paid_at is not null)
);
-- At most ONE live package per division. A refunded one stays as history.
create unique index division_online_packages_live
  on division_online_packages (division_id) where refunded_at is null and division_id is not null;

alter table division_online_packages enable row level security;
alter table division_online_packages force  row level security;
-- READ by the tenant role, org-scoped (the cap doors and the strip run as app_user). No write grant:
create policy division_online_packages_read on division_online_packages
  for select to app_user using (org_id = current_setting('app.current_org')::uuid);
grant select on division_online_packages to app_user;

alter table org_stream_credits
  add column online_package_id uuid null references division_online_packages(id),
  add constraint org_stream_credits_one_subject
    check (session_id is null or online_package_id is null);
create index on org_stream_credits (online_package_id) where online_package_id is not null;

-- Durable record that a pack's card payment was refunded or disputed (§7.5). One row per intent.
create table stream_pack_reversals (
  stripe_payment_intent_id text primary key,
  org_id     uuid not null references organizations(id) on delete cascade,
  purchased  integer not null check (purchased > 0),
  created_at timestamptz not null default now()
);
-- Money state: sealed exactly as org_stream_credits is (V410:413-414). No policy, no grant to app_user.
alter table stream_pack_reversals enable row level security;
alter table stream_pack_reversals force  row level security;

-- Existing online divisions (census: prod has none). One row each, so "online with no row" cannot exist.
--   no round opened: unpaid, size = smallest ladder size holding the places held (P14, computed once here);
--   a round already opened: size 256, frozen_at = now(), unpaid. Grandfathered: never asked to pay.
```

**The states of a row, and nothing else:**

| State | Columns | Meaning |
|---|---|---|
| Unpaid | `paid_at` null, `frozen_at` null | A size is chosen. It is the entrant limit. Round 1 cannot open. |
| Paid | `paid_at` set, `frozen_at` null | Upgradable, refundable. |
| Frozen | `frozen_at` set | A round has opened. Nothing changes. (A frozen row with `paid_at` null is a grandfathered division from the migration, and only that.) |
| Refunded | `refunded_at` set | History. Not live. |

- **There is no "closed, unpaid" state.** An unpaid row records no money. When online play is switched off, or the division is deleted, an unpaid row is DELETED. Switching online play on again writes a fresh unpaid row at P14's default; the earlier choice is not remembered.
- **What the three counters mean.** `credits_paid` only ever grows: everything debited for this package. `credits_refunded` is everything returned to the balance. `credits_forfeited` is included credits that were given up on a move down or a refund because their month had ended (P6). Two invariants, owned by a test after every step:
  - `credits_paid − credits_refunded` equals the negated sum of the package's ledger rows;
  - on a live paid row, `credits_paid − credits_refunded − credits_forfeited` equals price(`size`, `cameras_paid`). This is the row's VALUE, and it is what an upgrade or a move down is measured against.
  All three are stored; this is not the builder's choice.
- A move down is a partial refund. The row stays live and `refunded_at` stays null; only a full refund sets it.
- No change to the ledger's `reason` CHECK. A package debit is a `consume` row and a package refund is a `refund` row, each with `online_package_id` set and `session_id` null. The ledger's `created_by` is NOT set on these rows: a null `created_by` on a refund is how the stream code recognises a platform refund, and a non-null one means staff (`stream-credits.ts:730`).
- The table name `org_stream_credits` and the `stream` identifiers stay. Only user-facing text changes (§10).
- The RLS policy above is the shape; the builder copies the exact policy idiom from a neighbouring tenant-readable table. Not verified: which role the public places-left read runs as (`registrations/settings.ts:444`); it must be able to read the size.

### 7.2 The price, declared once

One client-safe leaf module, with no imports, in the shape of `lib/online-chess-cap.ts`:

- the five sizes;
- the credits per unit, 1 and 2;
- the included rounds per size (P1);
- `packagePrice(size, cameras)`, `sizeFor(places)`, `sizeForRounds(rounds)`. `sizeFor(0)` is 16.
- the list of doors that read the size (§7.6), as data, so the door sweep in §13 has something to count against. This list does not exist today; the build creates it.

The server, the select, the pricing page, the help tokens and the tests all read it. No number in §3.5 is typed anywhere else.

### 7.3 How a tenant transaction writes a sealed table

The ledger is sealed, and the package table is write-sealed (§7.1). The division save, the division delete and the competition delete all run as the tenant role under `withTenant` (`divisions.ts:864`, `:592`; `competitions.ts:997`). The repo already has the mechanism for this, and this design uses it and nothing new:

- `withTenant` takes a **`privilegedPrelude`**: it runs first, on the same transaction, before the role drops to `app_user`, for reads of sealed tables and for locks (`lib/db.ts:301-308`, `:320`). The division save already uses one to take the division lock and read the sealed `stage_round_opens` (`divisions.ts:860-863`).
- `withTenant` takes a **`privilegedEpilogue`**: it runs last, with the role reset, for a sealed-table row that must commit or roll back with the tenant writes (`lib/db.ts:309-313`, `:324-327`). Its callers are allow-listed by a test (`lib/__tests__/privileged-epilogue-boundary.test.ts`).

So:

| Write | Where it runs |
|---|---|
| Pay, upgrade | Its own usecase on the privileged `sql.begin`, as every ledger writer does. Never inside `withTenant`. |
| Pay and open round 1 | Inside `openRound`'s existing privileged transaction (§7.6). |
| Choose or change an unpaid size; delete an unpaid row | The division save's `privilegedEpilogue`. The checks run in the tenant callback, under the division lock the prelude took. |
| Refund on division delete, competition delete, online switched off | The same transaction's `privilegedEpilogue`, so the refund commits or rolls back with the delete. The prelude reads and locks first (below). |

Each new epilogue caller is added to the allow-list test by name. No grant on the ledger is widened and no `security definer` function is added.

Two consequences, both intended:
- The epilogue's own comment says "keep it to that write", meaning one log row, and it has one caller today (`server/usecases/match-day-code-open.ts:75`). A refund is several ledger rows, a package update and possibly settle rows. That widens the door's stated purpose. The same PR rewrites that comment and the allow-list test's wording, so the next reader does not take the new callers for misuse.
- An epilogue that throws rolls the whole transaction back. So a refund that fails (`ledger_negative`, a CHECK) blocks the division or competition delete. That is intended: money first. The delete answers a 500 that names the refund, and it is reported; it is never swallowed.

**The pre-read at a delete.** A competition delete is one cascading `delete from competitions`. The packages must be read before it, as the existing code reads the invite boards before the same delete (`competitions.ts:990-996`). In the prelude: read EVERY live package of the competition's divisions by its own `id`, paid and unpaid alike; take each `division:` lock in ascending division id order; then take the org money lock. In the epilogue, by those ids: refund the paid, unfrozen ones; delete the unpaid ones; leave the frozen ones. The division delete does the same for its one row. The epilogue runs after the delete, so it always addresses a row by the `id` the prelude read, never by `division_id`. `division_id` is null on those rows by then (`on delete set null`), which is why the list is read first and why `division_name` is a snapshot.

### 7.4 Writers and reads

The two that move money take the `division:` lock, then the org money lock, in that order. The monthly rollover runs under the money lock before the balance is read, as `consumeForSession` does (`stream-credits.ts:211-221`). The plan cap and the monthly rate are read before the transaction; the rate comes from `streamMonthlyRate` (`stream-credits.ts:844`), which reads the plan and does not depend on streaming being offered.

1. **The quote, `onlinePackageQuote(division, size)`.** A read. The SERVER derives everything except the size:
   - cameras, from the effective policy of the division's stages (P9);
   - counted rounds, from the stages (P15);
   - places held, from `countOnlineHeld`;
   - owed = price(size, cameras) − price(current `size`, `cameras_paid`) on a paid row, or the full price on an unpaid one. Positive: to pay. Negative: to return, and the quote then says how many come back and how many are forfeited;
   - the split between this month's included credits (with their expiry date) and bought ones.
   The select's price line, the amber line and the receipt all show this one answer.
2. **`chooseOnlineSize(division, size)`**: no money. Creates the unpaid row, or changes its size.
   - Allowed: any size that holds the places held, is allowed by the plan (P17) and covers the counted rounds.
   - Refused on a paid row. A paid size changes only through `payOnlinePackage`, up or down, because money moves either way.
   - If the stored registration capacity is above the new size, it is lowered to the size in the same transaction, and the response says so. The strip shows "Registration capacity lowered to 32".
   - After a move UP commits, the waitlist is promoted into the new room (P18).
3. **`payOnlinePackage(division, size, expectedOwed)`**: first payment, upgrade, and move down (decision 16).
   - The request carries the size and the total the organiser confirmed. It carries no rounds, and no way to ask for a LOWER price than the policy needs.
   - It may carry one intent, `addCameras: true`: "charge the camera price even though the policy is still off". The server's camera figure is then (derived from the policy) OR (`addCameras`) OR (`cameras_paid` already true). This only ever raises the price, so the server still never trusts the client downward. It exists because a paid package cannot otherwise gain cameras: the policy save is refused until cameras are paid (§7.6), and without the intent nothing would be owed until the policy is on. After it is paid, `cameras_paid` is true and the policy save goes through free (P19).
   - Under the locks the server recomputes the quote. If its owed figure differs from `expectedOwed`, it answers **409 `ONLINE_QUOTE_CHANGED`** with the fresh quote and writes nothing. The receipt redraws and the organiser confirms again.
   - Refused: frozen; size below the places held; size not allowed by the plan; counted rounds above the size's included rounds. A smaller size on a paid row is NOT refused: it is the move down, below.
   - Short balance: **402 `ONLINE_CHESS_NO_CREDITS`**, carrying `owed` and `balance`. Not `no_credits`: that code carries `featureKey: "streaming.relay"` and the stream UI keys on it (`stream-credits.ts:52-56`).
   - Owed 0 with the row already at the target writes nothing and answers `applied: false`. This is the idempotency rule: exactly-once by state under the locks, not by a key.
   - The debit takes `monthly` first, then `pack`. A debit spanning both writes two rows, one per bucket.
   - Sets `cameras_paid` to the derived value (true is never lowered: P19), `paid_at`, `paid_by`.
   - After an upgrade commits, the waitlist is promoted (P18).
   - **Move down** (owed negative, row paid, not frozen). `expectedOwed` is the negative figure the receipt showed, and the same 409 applies if it has moved. The server returns D = −owed credits' worth of value, in P21's order: bought credits first (always return), then included credits debited in the current UTC month (return), then included credits from an earlier month (forfeited: counted, nothing written). It writes `refund` rows to the bucket each credit came from, adds to `credits_refunded` and `credits_forfeited`, lowers `size`, lowers a stored registration capacity that is above the new size, and runs the settle step (§7.5). `cameras_paid` does not change (P19). The row stays live.
   - What can still return is read from the package's own ledger rows: bought = pack consumes − pack refunds; included this month = monthly consumes dated this month − monthly refunds dated this month.
4. **`refundOnlinePackage(package)`**: the full refund of decision 14; only a paid, unfrozen, unrefunded row. It returns whatever a move down has not already returned.
   - Returns each `pack` consume in full.
   - Returns a `monthly` consume only if that row was written in the current UTC month (P6). The rest is forfeited.
   - Then settles any reversed pack (§7.5), in the same transaction.
   - Sets `refunded_at` and `credits_refunded`. A second call writes nothing.
5. **`freezeOnlinePackage(division)`**: sets `frozen_at` inside `openRound`'s transaction, when `frozen_at` is null.

### 7.5 A refunded card payment and a refunded package (review C1)

Without a change, a club can keep credits its card payment no longer covers: buy a 20 pack, pay 16 for a package, refund the card (the claw-back takes the 4 that are left), then delete the division (16 pack credits return).

Two changes close it, in both orders:

1. **The claw-back nets refunds.** Its attribution becomes: spent = pack `consume` rows minus pack `refund` rows since the purchase. A package that was refunded before the card refund no longer counts as spent, so the claw-back takes those credits.
2. **A short claw-back is settled later, by the same attribution.** Every matched claw-back call writes a `stream_pack_reversals` row for its payment intent, even when it claws nothing (today a zero claw-back leaves no trace). The row records only THAT the pack was reversed. It is not a debt: there is no second measure of what is owed.

   `refundOnlinePackage`, after writing its refund rows and under the same money lock, re-runs the netted attribution for each of the org's reversals, oldest first:

   - net spend = pack `consume` rows − pack `refund` rows, since that pack's purchase;
   - outstanding = purchased − net spend − already revoked for that intent;
   - revoke min(outstanding, pack balance), when that is above 0.

   Each settle row is a `revoke` carrying the intent. Credits that were genuinely spent (a stream that ran, a package that froze) stay in net spend for good, so they are never taken back, and a later pack's credits are never taken to pay for an earlier one.

**Worked example 1: the hole (must take everything).** Buy pack A (20). Pay 16 for a package. Card-refund A: net spend 16, outstanding 4, 4 revoked; balance 0. Delete the division: 16 return. Settle: net spend 16 − 16 = 0; outstanding = 20 − 0 − 4 = 16; revoke 16. Balance 0. The club has its money back and no credits.

**Worked example 2: spent credits (must take nothing).** Buy pack A (5). Stream 5 matches. Card-refund A: net spend 5, outstanding 0, nothing revoked; a reversal row is written. Months later buy pack B (20), pay 16 for a package, delete the division: 16 return. Settle for A: net spend since A = (5 + 16) − 16 = 5; outstanding = 5 − 5 − 0 = 0; nothing revoked. The club keeps B's 20, which it paid for.

The existing single-row key (`stream_pack_refund:{intent}`) stays as the guard against a replayed webhook; settle rows carry no key and are bounded by the attribution instead. The staff alert that fires when a claw-back falls short is unchanged.

Not verified: how the webhook caller treats a PARTIAL card refund. The writer is told the intent, not an amount (`stream-credits.ts:441-447`), so this design treats every reversal as covering the whole pack, as the writer does today.

### 7.6 Doors that change

| Door | Today | Change |
|---|---|---|
| `effectiveEntrantCap` and every caller (§5.2) | min(plan, 256) | min(plan, size, 256). The refusal where the SIZE binds is new: 422 `ONLINE_SIZE_FULL`, carrying `size` and `nextSize`. An online division with no live row cannot exist after the migration; if a door meets one it uses today's cap, logs an error and reports it, and a test reaches that branch. |
| Online switch, off→lichess (`divisions.ts:1268-1280`) and create (`divisions.ts:346`) | flag, cap, time control | Also takes a size and writes the unpaid row (epilogue, §7.3). A request with no size gets P14's default. No payment is asked. lichess→off before the freeze: refund a paid row, delete an unpaid one. |
| Swiss Generate and rounds save, while `frozen_at` is null | hard maximum | Also refused when the counted rounds exceed the size's included rounds: 422 `ONLINE_ROUNDS_NEED_SIZE`, carrying `nextSize`; above 10, `ONLINE_ROUNDS_ABOVE_MAX` (P10). While unpaid, the strip's size select simply moves up. |
| Format (decision 9): the online switch and create, AND every door that adds or changes a stage on an online division | chess refuses pair-minting kinds only (`lib/chess-individual-only-rule.ts:35-37`) | A division holding a stage kind outside P16 cannot turn online play on, and an online division cannot gain one: 422 `ONLINE_FORMAT_NOT_SUPPORTED`, carrying the offending kind. Both directions, or one covers for the other. |
| Camera policy save while `frozen_at` is null: division (`divisions.ts:917-928`), stage, and competition | sport check, lock rule | Unpaid divisions: allowed; the quote follows, because the quote derives cameras every time. A paid division with `cameras_paid` false whose effective policy would become on: 422 `ONLINE_CAMERAS_NEED_UPGRADE`. A competition-level save is refused WHOLE and the error lists every such division with its difference; the organiser upgrades them, or sets their own policy to `off`, and saves again. Turning cameras off is never refused (P19). |
| `openRound`, whenever `frozen_at` is null (`open-round.ts:304`) | role, online, started | The payment door. The gate sits INSIDE the transaction, after the division lock (`:379`), not with the refusals that run before it. The row must be paid AND cover the places held, the counted rounds and the cameras; otherwise 402 `ONLINE_CHESS_UNPAID`, carrying the quote. "Paid" alone is not enough: a paid row that no longer covers is refused the same way. Then freeze. Once `frozen_at` is set, no round asks anything. This is "no round of the division has been opened", not "round number 1": a division whose first stage is a knockout meets the same gate. |
| Pay and open (§8.5) | none | `openRound` accepts `pay: { size, expectedOwed }`. The debit is written inside the same transaction, on the path that writes the open, immediately before the stamp at `:532`. Any decision that does not open the round (not paired, no fixtures, clock not playable, boards held for a Lichess link) writes no debit. The payment and the open commit together or not at all. |
| Division delete; competition delete; online switched off | none | Not frozen and paid: refund (§7.3, §7.4). Unpaid: delete the row. Frozen: nothing. |
| Division archive | none | Nothing. An archive is reversible, so a paid package is held and comes back with an un-archive. A purge of an archived division is a delete, and refunds if not frozen. |
| Checkout route (`app/api/billing/relay-checkout/route.ts:119-120`, `:33-38`) | needs both streaming features; returns to a fixture or Settings | Also allowed when Online Chess is offered to the org. A third return target, `returnTo: "division"` with the division id, lands on the division page with the receipt reopened. |
| Credits tab offer and its monthly grant (`stream-credits-tab.ts:55`, `:64`) | streaming only | Also on when Online Chess is offered to the org. |

Player-facing doors never show the new codes. A public sign-up into a full size sees the ordinary "This division is full" or the waitlist, as it does today at the cap.

**Mid-event rule, stated once.** After `frozen_at`, the size stays the entrant limit and can no longer be raised. Late entry and Reinstate work up to it. No door after the freeze asks about credits, rounds or cameras.

**The four readers of a ledger `consume` row** (four files, re-count at build time), and what each does with a package row:
- the claw-back's attribution (`stream-credits.ts:441-528`): counts it as spend, net of its refunds (§7.5);
- the credit history (`server/usecases/stream-credit-history.ts`): maps it to the three new kinds (§8.8);
- the credits tab (`server/usecases/stream-credits-tab.ts`): counts it in "used this month" when it drew included credits, which is true;
- the stream session reads (`server/usecases/stream-sessions/current.ts`): these are keyed by `session_id`, which a package row never has. Not read line by line: the builder confirms no org-wide `consume` count hides there.

## 8. Purchase and upgrade flows (owner-confirmed, decision 12)

All of this is organiser-only. Players never see any of it. The mockups are layout only; the build uses the house theme. Text sketches below are for phone (320) first, then desktop (1280).

### 8.1 Choosing the size: the Division rules strip

The shared `DivisionRulesStrip` gets one new select, **"Players, up to"**, directly under "Camera during online play". It shows only when online play is Lichess. The strip's online control is at `components/v2/rules/division-rules-strip.tsx:483`; the builder's camera select is at `components/v2/division-builder.tsx:1309`. The strip is shared, so the select appears in the builder's step 3 "Division rules" and on the division page from one implementation.

```
Online play                 [ Lichess            v ]
Camera during online play   [ Required           v ]
Players, up to              [ 64 · up to 8 rounds v ]
Online Chess: 8 credits · You have 11 · Buy more
```

- The options are the five sizes, each with its included rounds. A size above the plan's entrant cap is listed, disabled, with the plan name. A size below the places already taken is disabled.
- The price line follows the stream panel's "Uses 1 credit · N credits · Buy more" pattern (`components/v2/fixture-stream-panel.tsx:2005`). It changes as the size or the camera select changes.
- Phone: the three selects stack, full width, and the price line wraps under them. Desktop: the selects sit in the strip's existing grid and the price line spans the row beneath.
- **In the builder nothing is spent.** There is no pay button in step 3.

**Formats that cannot play online (decision 9).** The refusal lives in two places.
- *The strip.* On a division whose format holds a league, group or ladder stage, the Online play select keeps its Lichess option but disabled, with one line under it: "Online Chess runs Swiss and knockout events. Change the format to play online." Disabled with a reason, not hidden, is my call: a hidden control leaves the organiser hunting for it. On an online division, the format picker disables those formats with "Not available for Online Chess".
- *The server.* 422 `ONLINE_FORMAT_NOT_SUPPORTED` at the doors in §7.6, for API callers and for any path the strip misses. The islands map the code to the same sentence, as they do for the cap refusals (`components/v2/online-entrant-cap-refusal.ts:18-19`).
- *Copy.* Three new keys, in en, es, fr and nl: the strip's line, the format picker's note, and the refusal sentence. English: "Online Chess runs Swiss and knockout events." The key names are the builder's.

### 8.2 The Review step: price only

The builder's Review list gains one line beside the existing Lichess and camera lines (`components/v2/division-builder.tsx:852`):

```
Online Chess · up to 64 players · 8 credits, paid before round 1
```

There is no spend on this step. The Create button creates the division with its size chosen and unpaid. (The mockup's "Create · spend" button is superseded.)

### 8.3 Asking for payment: the division page

In the Fixtures tab's rules strip, an unpaid online division shows an amber line in the style of `LockLine` (`components/v2/rules/lock-line.tsx:12`). `LockLine` itself takes a test id and a text only, so this is a NEW component beside it, with the same look plus a tone and two actions. Size the work as a new component:

```
! Online Chess not paid. 41 registered, up to 64.
  Round 1 can't open until it's paid.
  [ Change size ]  [ Pay 8 credits ]
```

- Phone: the two buttons sit under the sentence, full width, Pay first. Desktop: one row, sentence left, buttons right.
- **Change size** focuses the "Players, up to" select in the same strip (P13: free while unpaid).
- **Pay** opens the receipt (§8.4).

### 8.4 The receipt

Pay opens the house confirm (`useConfirm`, `components/ui/confirm-provider.tsx:44`) with a receipt in the `AiQuoteCard` layout (`components/v2/board/ai-quote-card.tsx:140`):

```
Online Chess
Up to 64 players · up to 8 rounds
Fair-play camera                      on

From this month's credits              3   expire 30 Nov
From bought credits                    5
Total                                  8 credits

Knockout, play-off and tie-break games are included.
You can move up a size until round 1 opens.
                          [ Cancel ]  [ Pay 8 credits ]
```

- The two "from" rows come from the quote read (§7.4), so the receipt shows what the debit will actually take. A row with 0 is not shown.
- Confirming sends the size and the total shown. If the server's total has moved (someone changed the cameras or the rounds), it answers `ONLINE_QUOTE_CHANGED`; the receipt redraws with the new figures and a line, "The price changed. Check it and confirm again." Nothing is taken until the organiser confirms the figure they see.
- Phone: the confirm is a bottom sheet, rows full width. Desktop: the centred confirm dialog.
- **Short balance.** The confirm button reads "Buy credits". It opens the existing credits chooser (`creditsCard`, `components/v2/fixture-stream-panel.tsx:1562`; `components/buy-stream-credits.tsx:42`), renamed to Seazn credits, with the shortfall preselected: the smallest pack that covers it. After checkout it returns to the division page with the receipt reopened (the checkout route's new `returnTo: "division"`, §7.6). The size needs no keeping on the client for a first payment, because it is stored on the unpaid row; an upgrade's target size rides in the return address. The camera choice is never kept: the server derives it.

### 8.5 "Open round 1" on an unpaid division

Pressing Open round 1 opens the same receipt inline, with the confirm button **"Pay 8 credits and open round 1"**.

- **Preselect (owner decision 15): the size the organiser chose.** It is the stored size on the unpaid row. That size already holds the places held and covers the counted rounds, because every door that grows either one checks it (§7.6).
- **They can change it in the receipt.** The other sizes are listed, each with its price. A smaller one that still fits shows what it saves and what it costs them:

```
(•) Up to 64 players · 8 credits        <- the size you chose
( ) Up to 32 players · 4 credits        30 have entered. Late entry would stop at 32.
( ) Up to 128 players · 16 credits
```

  A size that does not hold the places held, or does not cover the rounds, is listed disabled with its reason.
- **One confirm pays and opens.** They commit together (§7.6). If the round does not open, for any reason, nothing is paid, and the organiser sees the round's own reason (not paired, a board waiting on a Lichess link, and so on).
- Paying freezes the limit for the whole event, and the receipt says so in one line: "The size is fixed once round 1 opens."

### 8.6 Once paid

The amber line is replaced by a green chip:

```
Online Chess · up to 64 · paid          Change size
```

- **Change size** opens the receipt with every size that fits, larger and smaller, and with "Add Fair-play camera" if it was bought without. A larger size shows the difference to pay. A smaller size shows what comes back, split as the server's quote gives it:

```
Move down to 32 players
Back to bought credits                 3
Back to this month's credits           1   expire 30 Nov
Not returned                           0
                         [ Cancel ]  [ Move down · 4 credits back ]
```

  When some included credits are from an earlier month, the "Not returned" row carries the number and the reason, "included credits from October have expired", before the organiser confirms.
- "Add Fair-play camera": ticking it sends `addCameras` (§7.4); once paid, the receipt's last line is "Fair-play camera is paid. Turn it on in Division rules.", and the camera select then saves. Each option shows the difference, and the total is the difference.
- The "Players, up to" select shows the paid size and offers the others that fit, each labelled with its difference, to pay or to get back. On a paid division, picking one opens the receipt. It never saves through the strip: the strip's save refuses a paid row (§7.4).
- Adding an entrant past the size, or saving more rounds than the size includes, is refused with a message that carries the next size and its difference, and offers Change size.

### 8.7 After round 1 opens

The chip stays, without the Change size link: "Online Chess · up to 64 · paid". The select is read-only. There is no price and no prompt anywhere on Match Day.

### 8.8 Credit history

The credits page (`app/o/[orgSlug]/settings/credits/page.tsx`) gains three row kinds: "Online Chess: {division}, up to {size}", "Online Chess: moved up to {size}", "Online Chess refunded: {division}". The history mapper must learn them, or it logs every such row as unmapped (`server/usecases/stream-credit-history.ts:292`).

## 9. What the included credits buy, and the shared balance

### 9.1 Per plan

| Plan | Included | Buys, with nothing bought |
|---|---|---|
| Community | 1 a month | One 16-player event without cameras. A 16-player event with cameras needs 1 more (£3). |
| Pro | 5 a month | One 64-player event without cameras, 1 spare. Or one 32-player event with cameras, 1 spare. Or a 16 with cameras and a 32 without, 1 spare. Or five 16-player events without cameras. |
| Enterprise | 20 a month (not on public sale; staff-set) | One 256-player event without cameras, 4 spare. Or one 128-player event with cameras, 4 spare. |
| Event Pass | 3 once today; 20 once after the plan-limits rework (unverified) | At 20: one 256-player event without cameras, 4 spare; or one 128-player event with cameras, 4 spare. At 3: one 32 without cameras, 1 spare. |

The largest package, 256 with cameras, is 32 credits. No plan includes it. It costs £70 as packs of 20 + 5 + 5 + 1 + 1, or £80 as two packs of 20 with 8 credits left over.

### 9.2 What it does to streaming

It is one balance. A credit spent on chess is not there to stream with.
- Community's single monthly credit pays for a 16-player event OR one streamed match, not both. The owner has confirmed this (decision 11).
- Pro's five cover a 64-player event and one stream, not five streams as well.

This is the intended meaning of one currency, but the pricing copy today promises something narrower and must change:
- the pricing matrix row is labelled "Free match streams" (`lib/pricing-matrix.ts:250-253`);
- the plan cards say "{count} streaming credits / month" (`app/[lang]/(marketing)/pricing/page.tsx:161`, `:171`, `:173`);
- the streaming page says "One match. One credit." and the buy sheet sells "1 match / 5 matches / 20 matches" at "{price} per match".

**The pricing copy must change, in two steps (§14).** The rename ships first and says only what is already true: a credit streams one match of up to 3 hours. The sentence about Online Chess ships with the feature, not before it, because the pricing page is public and is not behind the flag.

**The end state.** The plan cards should say "{count} Seazn credits / month", and the matrix note should say what a credit buys: one streamed match of up to 3 hours, or 16 players of Online Chess (2 credits with Fair-play camera). The pack names become "1 credit / 5 credits / 20 credits".

### 9.3 The timing rule and its one risk

**Rule (P3): a package is paid when the organiser presses Pay,** whether that is weeks ahead on the division page or at "Open round 1". A club may spend November's included credit on a December event. An upgrade in December draws on December's balance (P5).

The reason against: it lets a club bank expiring credits. A Community club that pays for a 16-player division every month, months ahead, never loses a credit to expiry. I recommend accepting this. It is bounded by one package per division, the credit is still spent on the product, and a refund cannot turn it back into a lasting credit (P6). The alternative, charging only at round 1, is approach D.

## 10. Copy and the rename

### 10.1 A premise to correct first

The product does not call them "stream credits" today. It uses three names: "match credits" (19 English strings), "streaming credits" or "stream credits" (5), and a bare "credit" on streaming surfaces. "Seazn credits" appears nowhere yet. The rename is therefore three names into one, plus the removal of the idea that a credit IS a match.

### 10.2 Count (measured on the tree, 2026-11-23)

| Surface | Count |
|---|---|
| English dictionary keys in the streaming-credit families | 77 (61 in `ui.json`, 14 in `marketing.json`, 2 in `emails.json`) |
| ...of which name "match", "streaming" or "stream" credit outright | 24 |
| ...of which contain "credit" at all | 46 |
| The same keys across 4 locales | 308 values to review |
| Source files with a hardcoded name (not tests) | 33 |
| Test files that assert the old name | 44 unit, 6 e2e |
| Help pages | 6 pages, 18 lines; `billing/match-credits.md` holds 11 |

The 77 keys are every key under `stream.*`, `settings.credits.stream.*`, `settings.credits.kind.stream`, `settings.nav.streamCreditsLeft`, `pricing.streams.*`, `pricing.matrix.streaming.*`, `product.streaming.*`, `product.matchday.*`, `home.flow.stream.*` and `staffDisputeAlert.*` whose key or value mentions a credit. Not every one changes: about 31 are neutral ("Balance", "Close"). Re-run the count at build time; do not trust these numbers.

Hardcoded text that users or staff see:
- the 402 message "This organisation has no match credits" (`stream-credits.ts:54`, `server/usecases/stream-sessions/refusals.ts:26`, `server/usecases/capture-phone.ts:816`);
- ledger notes written into rows, shown in history (`stream-credits.ts:992`, `:1001`, `:1009`, `:1075`);
- the Stripe invoice line "Match credits — N" (`lib/relay-checkout.ts:49`);
- staff emails (`lib/email.ts:864-985`) and the admin panel and labels (`components/admin-stream-credits-panel.tsx:199-269`, `app/admin/orgs/[id]/adjustment-labels.ts:37-39`). These are `/admin`, staff-only, English.
- OpenAPI summaries (`server/api-v1/openapi.ts:231`, `:801`), which the CI drift check will flag.

Not verified: the display names of the three pack products in Stripe. The lookup keys (`seazn_stream_pack_*`) should stay; the names a buyer sees on the Stripe receipt need a look in the dashboard.

### 10.3 Rules for the new copy

- "Seazn credits" everywhere a user reads. "Online Chess" and "Fair-play camera" as proper names. Never "External Play".
- Two existing strings say "Online play" for the control (`divset.onlinePlay.label`, `.summaryOn`). They become "Online Chess".
- The settings page's "Streaming" credit kind (`settings.credits.kind.stream`) becomes "Seazn credits".
- The dispute email says credits "already spent on live streams cannot be reversed". It becomes "already spent".
- All new and changed strings go into en, es, fr and nl, then `i18n:gen-keys`. Help and blog are English only.
- New strings owed: the size select and its price line, the Review line, the amber line, the receipt, the paid chip, the three format strings (§8.1), the refusals, the three history kinds, and the feature page. Estimate 45 to 60 keys; the builder counts.

### 10.4 Help

- `billing/match-credits.md` is renamed and rewritten as the Seazn credits page (no redirect: standing rule for help).
- `billing/plans.md:31` ("Free match credits a month"), `billing/event-pass.md:40`, `billing/add-ons.md:46-49`, `billing/credits.md:12` and `scheduling/match-day-stream.md` are edited.
- `sports/chess.md` gains "Online Chess: sizes and credits", with the price table drawn from the leaf module's tokens, not typed.

## 11. Billing edge cases

| Case | Rule |
|---|---|
| **Pro → Community before round 1** | The package stands. The plan cap still applies to growth, as today, so a 128 package on Community stops taking entrants at the Community cap. No refund for the unusable part (P2). The organiser sees the plan prompt, not a size prompt. |
| **Pro → Community after round 1** | Nothing changes. The existing freeze rules for a lapsed plan govern the competition (`publish.ts:269-276`). No door asks about the package. |
| **Community → Pro** | Larger sizes become selectable. Upgrade by difference, before round 1. |
| **Event Pass** | Pass credits are pack credits: never expire, always refundable. A pass raises the plan cap for its competition only, so sizes above the org's cap are selectable only in that competition. If the plan-limits work removes or reshapes the pass, only the row in §9.1 changes. |
| **Division deleted before round 1** (including after Start) | Paid: refund per P6 and P7, automatically, in the delete's own transaction through its privileged epilogue (§7.3). Unpaid: the row is deleted. |
| **Division or competition deleted after round 1** | No refund. The package row stays, with `division_id` null and the name snapshot. |
| **Division voided or abandoned mid-event** | No refund. Staff can grant goodwill credits with the existing panel. |
| **Online Chess switched off before round 1** | Paid: refund, as a delete. Unpaid: the row is deleted. Switching it on again writes a new unpaid row at the default size. |
| **Paid for 128, wants 64, before round 1** | Move down from the chip (decision 16). The difference returns: bought credits in full, included credits only within their month; the receipt shows any that will not return before the organiser confirms. The registration capacity follows the size down. |
| **Move down, then up again** | Each step is measured against the row's value, price(size, cameras paid). A forfeited credit is not credited back by a later move up. |
| **Move down below the places held, or below what the rounds need** | Refused, with the reason. |
| **Move down after round 1** | Refused: the size is fixed (decision 7). Unused size is then not refunded (decision 10). |
| **Cameras turned off after paying the camera price** | No partial refund. They can be turned on again at no charge until round 1 (P19). |
| **Division archived** | Paid and unopened: held, not refunded. Un-archived: the package is as it was. Purged: a delete. |
| **Organisation deleted** | Both tables cascade from the organisation. Everything goes and nothing is refunded. Nobody plans a refund here. |
| **Organiser never pays** | Registration runs up to the chosen size. The division can be Started and scored by hand (P20). No online round can open. No player sees why. Not verified by driving the product: that no sweep acts on boards of a round that was never opened. |
| **Size chosen at 64, 30 places held, organiser pays at round 1** | The receipt preselects 64, the size they chose (decision 15), and lists 32 with its saving and its consequence (§8.5). |
| **Receipt open while someone changes the cameras or the rounds** | The server's total differs from the one confirmed: 409 `ONLINE_QUOTE_CHANGED`, nothing written, the receipt redraws (§7.4). |
| **Paid, then the rounds are raised or cameras added, then Open round 1** | The gate checks cover, not only payment: 402 `ONLINE_CHESS_UNPAID` with the difference (§7.6). |
| **Pay and open, but the round cannot open** | Nothing is paid. The debit is written only on the path that writes the open (§7.6). |
| **Size lowered below the stored registration capacity** | The capacity is lowered to the size, and the organiser is told (§7.4). |
| **Moving up a size with a waitlist** | The waitlist is promoted into the new room (P18). Where registration needs manual approval, the organiser promotes, as today. |
| **Plan cap of 96 (a size pack)** | 128 can be chosen; the division seats 96 (P17). The select says "seats 96 on your plan". |
| **Package refunded in a later month** | Pack credits return. Included credits spent in an earlier month do not. The confirm dialog says how many will not come back, before the organiser confirms. |
| **Smaller field than the size, once round 1 has opened** | No refund (P2). Before round 1 the organiser can move down. |
| **Card refund or dispute on a pack whose credits paid for a package** | The claw-back takes what is left. If the package is later refunded, the returned credits are taken to settle the reversal in the same transaction; if the package was refunded first, the claw-back sees those credits as unspent and takes them (§7.5). Credits that paid for a package that went on to run are not reversed. |
| **Two tabs pay for the same size** | Both take the division lock, then the money lock. The second finds the package at the target and writes nothing. One debit. |
| **Two tabs pay for different sizes** | Serialised. The second pays the difference from the state the first left. |
| **A size change races the first round opening** | Both take the division lock. Whichever commits first wins; a change after the freeze, up or down, is refused with the read-only message. |
| **Payment races a stream going live on the last credit** | Both take the money lock. The stream's loser gets the existing `no_credits`; the package's loser gets `ONLINE_CHESS_NO_CREDITS`. |
| **Month turns between opening the receipt and paying** | The rollover runs under the lock before the balance is read. The receipt's split may be stale; the server's answer is the truth, and a shortfall opens the pack modal. |
| **Online divisions on a league, group or ladder format at rollout** | Census, prod, 2026-11-23 (read-only): 15 divisions, 0 chess, 0 with online play on. So there are none in production and no migration is owed there. Staging was NOT read: unverified. Staging data is test-only, so any such division there is deleted or switched to over-the-board by hand, not migrated. The rule for one found later: a round already opened plays on untouched (never stop a running event); none opened, the division keeps its stored setting but cannot open round 1 until the format changes, and the strip says why. Re-run the census the day the build ships. |
| **Online divisions that exist at rollout** | The migration writes a row for each (§7.1): unpaid at the smallest size that holds its places if no round has opened, grandfathered (frozen, never asked) if one has. Prod has none. |
| **Flag turned off for a club** | Nothing is refunded automatically, and with the flag off no round can open. The way out for a paid, unopened package is to switch online play off or delete the division, either of which refunds it. Switching off is never gated by the flag (`divisions.ts:1262-1264`). |

**Lock order.** `division:` (ascending id when more than one) then org money. The reviewer found one caller of the money lock outside the ledger file, the stream session apply (`stream-sessions/apply.ts:99`), which takes no `division:` lock. That looks safe; the builder confirms it by test, not by reading.

## 12. Cost risk to watch (owner decision 6)

From the costing paper (§1). One camera board costs about $0.004 a minute. Per board-game:

| Time control | Typical | Worst |
|---|---|---|
| Rapid 10+5 | $0.09 | $0.15 |
| Rapid 15+10 | $0.13 | $0.21 |
| Classical 30+0 | $0.17 | $0.28 |
| Classical 60+30 | $0.41 | $0.68 |

A size with cameras, at its included rounds, against what its credits bring in when bought (20-pack price £2 a credit, single price £3):

| Size (rounds) | Board-games | Credits | Revenue | Rapid 10+5 typical / worst | Classical 60+30 typical / worst |
|---|---|---|---|---|---|
| 32 (7) | 112 | 4 | £8–12 | $10 / $17 | $46 / $76 |
| 64 (8) | 256 | 8 | £16–24 | $23 / $38 | $105 / $174 |
| 128 (9) | 576 | 16 | £32–48 | $52 / $86 | $236 / $392 |
| 256 (10) | 1,280 | 32 | £64–96 | $115 / $192 | $525 / $870 |

(Board-games = size ÷ 2 × rounds. Costs are my arithmetic on the paper's per-board figures, not figures from the paper. Revenue is in pounds and cost in dollars; at an assumed £1 = $1.27 the revenue column is $10–15, $20–30, $41–61 and $81–122. The rate is an assumption, not a quoted figure.)

- **Rapid:** roughly break-even on typical play when the credits are bought, a loss on the worst case.
- **Classical 60+30:** a loss of about four to five times the revenue at every size.
- **Included credits:** bring in nothing. Pro's five a month can be a 32-player camera event every month.
- **Not counted:** arbiter minutes (about $0.02 a board in the paper), knockout and tie-break games, and rounds added mid-event (P11).
- **Offsetting:** the first 10,000 camera minutes a month are free, platform-wide; that is about one 32-board, 7-round rapid event.

The decision can be revisited only with real numbers, so §14 makes camera minutes per time control a launch metric.

## 13. Tests owed

House rules apply (`docs/superpowers/TEST-STRATEGY.md`): every sweep reports how many items it checked and zero is a failure; expected values come from the owner's table in §3.5 and the rulebook, never from the code under test; every guard is mutated once; no entitlement pin tests.

**Unit**
- The price table, enumerated: all 10 cells (5 sizes × 2), with the expected values typed from §3.5. The sweep asserts it checked 10.
- `sizeFor` at each boundary: 16 and 17, 32 and 33, 64 and 65, 128 and 129, 256, and 257 refused.
- Included rounds at each size and each size + 1 round.
- The debit split: monthly only, pack only, and spanning both, including a case where the wrong draw order gives a different answer from the right one.
- The refund: same month, later month, mixed buckets. Expired included credits do not return; assert the forfeited count.
- The invariant: `credits_paid` equals the negated sum of the package's ledger rows, after every step of buy → upgrade → upgrade → refund.
- `creditBalance` equals the breakdown total at every step of the same sequence.

**Integration, real database**
- Each door in §7.6 at the size and at size + 1, through its real usecase. The door sweep reports its count against a list read from the module, so a new door fails the sweep.
- Idempotency: the same purchase twice writes one debit. Two concurrent purchases, held on the lock as the existing concurrency tests do, write one.
- The sequence: choose 16 unpaid → fill → refused at 17 → change to 32 free → open round 1 refused unpaid → pay 2 → add cameras pays 2 → open round 1 → upgrade refused → late entry to 32 allowed → 33 refused → Add a round allowed.
- Unpaid changes: up, down, and down below the places held (refused).
- **Paid move down** (decision 16): paid from bought credits only (all return); from this month's included credits only (all return); from both (bought first, P21); with an included credit from an earlier month (forfeited, the count asserted, no ledger row for it). Each asserts both invariants of §7.1.
- Move down, then up: the upgrade charges the full difference; a forfeited credit does not come back as value.
- Move down refused: below the places held; below what the rounds need; after the freeze.
- Move down then full refund: the two together never return more than was paid, and `refunded_at` is set only by the second.
- Move down runs the settle step: C1's sequence with a move down in place of the delete.
- **Round-1 preselect** (decision 15): the quote the receipt opens on is for the stored size, in a case where the smallest size that fits is different (64 chosen, 30 held), so a wrong default gives a different total.
- Counted rounds (P15) for one Swiss, two Swiss stages, a Swiss into a knockout, and a knockout alone, with expected counts worked by hand.
- Format (decision 9), enumerated over EVERY stage kind in the schema's own list (`stages_kind_check`): each allowed kind turns online on, each refused kind answers `ONLINE_FORMAT_NOT_SUPPORTED`, in both directions (switch on over the stage; add the stage to an online division). The sweep reports the kinds it checked and fails on a kind it has no verdict for.
- Month boundary: buy with an included credit on the last day, refund on the first of the next month, nothing returns.
- Delete before and after round 1.
- The inert-seam check: the package the picker's own request creates is the one the entrant door reads. No fixture on both ends.
- Another sport and over-the-board chess: no door asks for a package. The sweep reports how many sports it checked.
- **Card refund and package refund, both orders** (§7.5): buy 20, pay 16, card refund, delete the division; and buy 20, pay 16, delete the division, card refund. In both the club ends with no credits from that pack. Then a third: the package ran (frozen), card refund: the 16 are not reversed.
- **Settle takes nothing from a different pack** (§7.5, worked example 2): the reversed pack's credits were spent on streams; a later pack pays for a package that is refunded; assert zero revoke rows and the later pack's full balance. Mutation: replace the attribution with `purchased − revoked`.
- **Adding cameras to a paid package:** paid without cameras → policy save refused → pay with `addCameras` (the difference) → policy save allowed and free → open. And `addCameras` on a package already paid with cameras owes 0.
- **Competition delete with unpaid rows:** no package row of the competition survives with a null `division_id` unless it is paid.
- **A refund that fails blocks the delete:** force a ledger error in the epilogue; the division still exists.
- **Quote changed** (§7.4): open a quote, change the camera policy, pay with the old total: 409, and the ledger has no new row. The same with the rounds raised.
- **The server ignores a client's word on cameras:** there is no cameras field to send; a request that adds one is rejected by the strict schema.
- **Pay and open where the open does not happen:** one case per reason `openRound` can decline after its checks. Each asserts no ledger row and an unpaid package.
- **The gate checks cover:** paid without cameras, cameras added at stage level, open refused; paid for 6 rounds, rounds raised to 7, open refused.
- **First open is not round 1:** a division whose first stage is a knockout, and a division whose round 2 is opened first, both meet the gate.
- **Off, then on:** the old unpaid row is gone and the new one is at the default size. Paid, off, on: one refunded row and one new unpaid row.
- **Refund twice; refund after the freeze; delete racing switch-off:** one refund, none, one.
- **Competition delete with three paid divisions:** three refunds, in one transaction; a forced failure after the second rolls back all three and the delete.
- **Archive, un-archive, purge.**
- **Size down below the capacity; size up with a waitlist.**
- **A plan cap of 96:** 128 choosable, the 97th entrant refused by the plan's own refusal.
- **Zero places held:** the default size is 16.
- **The epilogue allow-list:** the boundary test names each new caller, and fails for an unnamed one.

**E2E** (`e2e/mobile/` for the widths; one walkthrough owned by this batch)
- The organiser walkthrough: build a division with Lichess and a size, see the price on Review, create it, see the amber line, register players, press Open round 1 unpaid, get the receipt, run short, buy a pack in the Stripe sandbox, return to the receipt, pay and open, then confirm the chip has no Change size link.
- A second pass: pay early from the amber line, move up from the chip, move down again and see the credits back in the balance, then open round 1 and confirm the chip has no Change size link.
- The builder spends nothing: the balance read from the ledger is unchanged after Create. Paired with the positive: Pay moves it.
- The strip with the new select, the amber line, the receipt and the chip at all seven widths with no horizontal scroll; screenshots at 320, 768 and 1280. Any existing e2e that asserts the strip's controls must still find them.
- **The player sweep:** every public and player page of an online division (registration, the division page, the match room, check-in, emails) is scanned for "credit", "plan", "upgrade", "size" and the price. It scans RENDERED TEXT, not markup (class names contain "size"), and it runs in all four locales, each with that locale's own words taken from the new dictionary keys. It reports pages scanned; zero pages is a failure, and so is any hit. A paired positive test proves the scan can see the words on the organiser's receipt.

**Smoke** (PR-only CI)
- Buy a package through the API, read it back, and add entrants to the limit and one past it. The numbers come from the import-free leaf, as the cap smoke does (`lib/online-chess-cap.ts:1-3`).

**Regression**
- Streaming is unchanged: a go-live still takes exactly one credit, included first; the free-restart and never-live refund rules hold. Run the existing stream-credit suites.
- A stream refund still returns to its own bucket. The P6 rule applies to packages only.
- The credit history maps every row kind. The mapper's "unmapped" count is asserted to be zero over a ledger that contains package rows.
- Copy truth: no English string in the streaming-credit families still says "match credit" or "streaming credit". The sweep reports the keys it checked.

**Mutations, once each:** drop the size from the cap minimum; swap the draw order; return expired included credits on refund; skip the freeze; let the upgrade charge the full price instead of the difference; let round 1 open unpaid; let round 1 open on a paid row that does not cover; let a league division turn online play on; let an online division gain a league stage; charge 1 per unit with cameras on, in the WRITER (the price-table test only guards the leaf); drop the quote comparison; drop the refund netting in the claw-back; drop the settle step; commit the debit before the open's stamp; drop `refunded_at`; drop the `frozen_at` check on refund; return an expired included credit on a move down; reverse P21's order; credit a forfeited credit toward a later move up; preselect the smallest size at round 1.

## 14. Rollout and metrics

**Rollout.** Everything sits behind the existing `online-chess` flag. A club without the flag sees no size select, no amber line and no Online Chess copy.

The rename is not behind the flag. It ships to every club at once, because one balance cannot have two names. Sequence:
1. The rename, alone: copy, help, pricing page, emails. No behaviour change. One PR. It carries ONLY strings that are true without Online Chess: "Seazn credits", and "a credit streams one match of up to 3 hours". No string in this PR mentions chess, sizes or cameras.
2. The package: table, writers, doors, the select, the amber line, the receipt, history. Behind the flag. One PR, after the plan-limits re-cut merges if that is close, because both touch the entrant doors and the pricing page.
3. The feature page (§15), when real screens can be captured. The public "what a credit buys" strings that name Online Chess (the pricing matrix note, the plan cards, the help price table) ship here, or when the flag is on for every club, whichever is first. Until then the public pricing page does not mention chess.

Before step 2 reaches a paying club: set the Cloudflare billing alert the costing paper asks for.

**Metrics.** One PostHog event per package action (`online_chess_package_bought`, `_upgraded`, `_refunded`) with size, cameras, credits, the bucket split and the plan. One event when a division finishes, or a nightly query, with the figures below.

| Metric | Why |
|---|---|
| Camera participant-minutes per board-game, by time control (bullet, blitz, rapid, classical) | The classical decision. Compare with §12. |
| Camera minutes per package, against its credits | Margin per size. |
| Share of packages paid wholly from included credits | How much of the cost is given away. |
| Share of packages paid at "Open round 1" against earlier, and round-1 opens abandoned at the receipt | Whether the last-chance payment door causes late starts. |
| Packages by size, with and without cameras, by plan | Whether the ladder fits real events. |
| Size changes per package, up and down, and how late they come | Whether organisers guess sizes well. |
| Credits returned and forfeited by moves down | What decision 16 costs, and whether the month rule surprises anyone. |
| Seats used ÷ size at round 1 | Whether P2 feels unfair. |
| Rounds added after round 1, on online divisions | The size of the P11 leak. |
| Refunds, and included credits forfeited by P6 | Whether P6 surprises anyone. |
| Credits spent on chess against streams, per org | What the shared balance does to streaming. |
| Purchases abandoned at "Buy credits" | Friction at the pack modal. |

Not verified: which columns of `fixture_external_play` hold the check-in and game-end times needed for camera minutes. The costing paper names the table (§5, item 3); the builder must confirm the columns, or record the minutes from the video webhooks.

## 15. The Online Chess feature page

**Where it sits.** `/product/online-chess`, in the `[lang]/(marketing)/product/` family, beside the seven pages that exist (`lib/marketing/product-nav.ts:13-21`). It adds one entry to `PRODUCT_LINKS`, which feeds the header menu, the phone panel, the footer and the "more of the product" chips, and one line to the sitemap (`app/sitemap.ts:69-75`) at the same priority, 0.8, monthly. There is no chess entry in the Sports menu today, so this is the first chess page on the marketing site.

**Built from real product screens.** Captured from a real division, in the house capture style, at phone and desktop:
1. the "Players, up to" select with its price line (§8.1): "Pick a size. That is the price.";
2. the player's match room at check-in, with the Fair-play camera tile;
3. the board in play;
4. Match Day's round view with the online boards and their states;
5. the arbiter's camera view;
6. the public registration card with its Online Chess note.

**Sections.** Hero with the one-line promise and the board screen. How it works in four steps (pick a size, players link Lichess, open a round, results write themselves). Fair-play camera: what the arbiter sees, and that nothing is recorded. The price table, read from the leaf module. Proof. FAQ. The chips to the other product pages.

**Proof link.** The pages' proof block points at the Seazn Demo Club, but that club does not exist in production yet: `DEMO_CLUB_HREF` is `undefined` and the block draws no button (`components/marketing/product/parts.tsx:40-43`). The page ships the block without a button, like its siblings. When the club is created, a finished online Swiss in it is the proof.

**SEO.** Terms to earn: "online chess tournament software", "run a chess tournament online", "Lichess tournament manager", "Swiss pairing software online", "fair play camera chess", "online chess arbiter", "chess club tournament online". One H1, a meta description under 160 characters, FAQ structured data, measured with Lighthouse (standing rule for marketing pages).

**Truth.** Every claim on the page is one the product keeps. The page says Online Chess runs Swiss and knockout events, and does not show a league (decision 9). The claims not yet proven are in the costing paper (§2): real Lichess at scale, and more than 128 boards in one round. The page says "up to 256 players" only after the 256-board load run that PR #1289 is gated on.

## 16. Left to the builder

- The request shapes and route names. The transaction boundaries in §7.3 and §7.4 are fixed.
- How the receipt body is shared between the confirm and the inline "Open round 1" use, and how the chooser returns to it after checkout.
- How "the shortfall preselected" maps to a pack when no single pack equals it. My call: the smallest pack that covers it.
- Whether the three rows in the credit history show the fixture column empty or a division link.
- Where the "turn it on" link lands when the camera policy is set at competition or stage level, not on the division. The payment itself is the same `addCameras` intent at every level.
- The OpenAPI entries.
- The migration number.
- The helper that reads the monthly rate before the transaction (the pattern is `openOnlineCapGuard`).
- The capture script for the feature page's screens.
- Which existing function promotes the waitlist when a place frees, to call after a move up (P18). I did not locate it by name.
- Minor review points left as the builder's call, each with its reason:
  - the exact RLS policy text for the package table: copy the idiom of a neighbouring tenant-readable table, which the plan can pin faster than this document can;
  - whether the receipt's "paid by" appears in the credit history row or only in its detail: a layout choice inside an existing table.
- Confirming the lock order, the "Add a round" door, the camera-minute columns and the Stripe product names, all marked unverified above, plus the staging census of online divisions on a refused format (§11), and the Event Pass credit amount once plan-limits merges (§9.1).

## 17. Owner questions

All earlier questions were closed on 2026-11-23:

| Question | Ruling |
|---|---|
| How often is a free size free? | There is no free size (decision 3). |
| Do league and group rounds count? | Those formats cannot play online at all (decision 9). |
| Refund for unused size; expired included credits; rounds added mid-event | No; never return; free and measured (decision 10). |
| Community's included credit | Stays at 1 a month, shared (decision 11). |
| Do optional cameras cost the camera price? | Yes (decision 13). |
| Refund before round 1? | Yes, automatically (decision 14). |

The two points the review raised were ruled on the same day:

| Question | Ruling |
|---|---|
| What does "Open round 1" preselect? | The size the organiser chose (decision 15). |
| Can a paid size move down? | Yes, before round 1, with the difference refunded under the standard rule (decision 16). |

**No owner question is open.** What the owner approves by approving this document: the decisions in §3 as written, and the controller's calls in §4.

## 18. Premises that proved false or stale

| Premise | What the tree says |
|---|---|
| "The existing stream credits" have one name. | Three names in the UI; "match credits" is the main one (§10.1). |
| A credit is a general unit. | Today it is sold and described as one match: packs are "1 match / 5 matches / 20 matches". |
| Event Pass grants 20 stream credits. | 3 on main (V526). 20 is unmerged and unverified. |
| The plan-limits design keeps Event Pass. | The design file on disk, in both the main checkout and the plan-limits worktree, still says the pass is removed, as does the plan of 2026-11-22. Only the billing-page design of 2026-11-23 mentions "one Event Pass at $29.99". |
| The feature page has a proof link to the Seazn Demo Club. | The club does not exist in production; the link constant is `undefined`. |
| A "Chess External Play" feature page is the next page. | No chess page, nav entry or sport page exists on the marketing site. |
| Packs can be bought by any club. | Only where phone streaming is offered and entitled. |
| The round count is fixed once the event starts. | "Add a round" exists mid-event. |
| Included credits might roll over. | They already expire, and are already spent first. |
| A refund is simple. | A stream refund after the month turns returns to the included bucket and lives until the next rollover. P6 needs a different rule for packages. |
