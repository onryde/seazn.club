-- V503 — a sponsor deal's unpaid invoice can be WRITTEN OFF (plan docs/superpowers/plans/2026-11-07-sponsor-deals.md, Task 23,
-- controller carry 4 from the Task 22 re-review).
--
-- The case. An OFFLINE deal that went live and then ended unpaid because its term ran out (`expired`) or its competition finished
-- (`competition_finished`) leaves an invoice that is still due: the sponsor had the placement. When the money arrives, the club marks
-- it paid (Task 23 offers Mark as paid on that deal). When it never will, the club writes it off, and the invoice stops asking:
-- "Nothing due — written off by <club>".
--
-- How it is recorded: `ended_reason = 'written_off'` on that already-ended deal. The money column keeps saying what is true (`status`
-- stays `pending`: nothing was paid), and the reason says why nothing is owed. This follows the house precedent that a money event
-- rewrites an ENDED deal's reason (a refund writes `refunded`, a lost dispute `dispute_lost`), so `ended_at` keeps the day the deal
-- ended. The deal's lifecycle does not move: it was ended and stays ended.
--
-- WHAT THIS CHANGES.
--   * sponsor_orders_ended_reason_check: V495's seven reasons, restated, plus `written_off`. lib/sponsor-deals.ts END_REASONS is the
--     same list (server/sponsors/__tests__/deal-values-db.test.ts reads it back).
--   * sponsor_orders_written_off_unpaid_offline (new): a written-off deal is an OFFLINE deal whose money is still unpaid (`pending`,
--     or `failed`, which an offline deal never reaches but the domain treats as unpaid) and that WENT LIVE (`live_at` set: the
--     sponsor had the placement, which is what made the money owed - lib/sponsor-deals.ts `endedStillDue`; T23 review m9). A card
--     payment is never written off (an online deal ended unpaid claims nothing: its invoice reads "Ended"), a paid or refunded one
--     has nothing to write off, and one that never went live owed nothing.
--     `ended_reason <> 'written_off'` is NULL on an open deal, and a CHECK passes on NULL, which is right: only a written-off row is
--     constrained.
--   * written_off_at, written_off_by (new, nullable, no default): WHEN the club wrote the invoice off and WHO did (final review m3:
--     a write-off waives money owed, and the club will be asked about it later). Write off stamps both, as Mark as paid stamps
--     paid_at and marked_paid_by. written_off_by is an actor like created_by, marked_paid_by and approved_by: set null when the user
--     is deleted (V495's house rule: deleting a user is never blocked by a deal), and no index (a user delete is rare).
--   * sponsor_orders_written_off_stamped (new): a deal has `written_off_at` IFF its end reason is `written_off`, and has
--     `written_off_by` only then. `written_off_by` is not required on a written-off row: the set-null above clears it when its
--     user is deleted, and a CHECK requiring it would refuse that delete. Both sides use `is not distinct from` and `is null`, so
--     the expression is never NULL (an open deal's ended_reason is NULL, and a NULL CHECK would pass anything).
--
-- No row moves: nothing is written off before this delta (sponsor deals reach production with PR 3, owner 2026-11-10), and adding a
-- reason widens the first CHECK. The second and third refuse only a row that names the new reason or carries the new columns,
-- and every existing row has neither.
--
-- The tests find this file by its SUFFIX (`__sponsor_deal_written_off.sql`), never its number: a renumber at merge (F26) is a pure
-- `git mv`.

alter table sponsor_orders
  add column written_off_at timestamptz null,
  add column written_off_by uuid        null,
  add constraint sponsor_orders_written_off_by_fkey
    foreign key (written_off_by) references users(id) on delete set null,
  drop constraint sponsor_orders_ended_reason_check,
  add constraint sponsor_orders_ended_reason_check
    check (ended_reason in ('refunded', 'dispute_lost', 'ended_now', 'expired', 'competition_finished', 'legacy',
                            'duplicate_payment', 'written_off')),
  add constraint sponsor_orders_written_off_unpaid_offline
    check (ended_reason <> 'written_off' or (payment_method = 'offline' and status in ('pending', 'failed') and live_at is not null)),
  add constraint sponsor_orders_written_off_stamped
    check ((ended_reason is not distinct from 'written_off') = (written_off_at is not null)
           and (written_off_by is null or ended_reason is not distinct from 'written_off'));
