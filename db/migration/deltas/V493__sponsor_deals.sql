-- sponsor_deals — Sponsor deals (plan docs/superpowers/plans/2026-11-07-sponsor-deals.md, spec §5): a deal is how a
-- sponsor gets on the page and the stream: a package, a way to pay, and a rule for when it goes live.
--
-- One row per deal, in the table that already holds the orders (D1). `sponsor_orders` keeps its name: V299's RESTRICT
-- keys and V300's policies, the dispute recovery's `sponsor_order_id` reversal metadata, the outbox refs
-- `sponsor_order/<id>` and the competition-delete guard all key on it, and a rename buys the user nothing. The money
-- column `status` keeps its meaning (the API calls it `payment_status`).
--
-- Two axes (D2). The new `deal_status` is the lifecycle: draft, awaiting_payment, awaiting_approval, scheduled (every
-- condition of the rule is met, but the sponsor already has a live deal), live, ended. Money stays in `status`: pending,
-- paid, failed, refunded, plus the new `none` for a complimentary deal. "Live, awaiting payment" is both at once, so one
-- column cannot hold it. A sponsor has at most one live deal (D3), held by a partial unique index, not a comment.
--
-- What each deal records:
--   * its rule: payment_method (online | offline | complimentary) and go_live (on_payment | immediate | on_approval). A
--     complimentary deal never waits on a payment, its money status is `none` exactly when it is complimentary, and an
--     online deal always has a billing address (sponsor_email is otherwise nullable now);
--   * its snapshot, taken when the deal is made, so a later package edit never moves it (D4): tier, includes_on_stream,
--     package_name, competition_id (the deal's scope; null is the whole org), plus the existing amount_cents and currency.
--     ends_at is the optional end of an org-wide deal (D5);
--   * its step stamps and their actors: created_by, invoice_sent_at, marked_paid_by, approved_at, approved_by, live_at,
--     ended_at with its ended_reason, parked_at. Every actor key is ON DELETE SET NULL (the house convention), so deleting
--     a user is never blocked by a deal;
--   * its Checkout: checkout_session_id, checkout_url, checkout_expires_at, and invoice_send_count.
-- A deal is history, so its sponsor can no longer be deleted from under it: sponsor_id moves from SET NULL to RESTRICT,
-- and the deal's competition_id is RESTRICT too. The deal columns carry NO default, so a writer that forgets one fails
-- loudly (23502) instead of silently writing a draft.
--
-- The tenant's delete fence widens (product ruling 2026-11-09). V300's sponsor_orders_prune let app_user delete only a
-- pending, intent-less, undisputed order: an abandoned checkout. A sponsor is now deleted WITH its deals unless one of them
-- carries money or document history, so the policy admits every deal EXCEPT money paid or refunded, a stored Checkout
-- session (still a payable link) and a legacy order (history, D6). A draft, an unpaid or failed deal, and a complimentary
-- one (money `none`), live or ended, are deletable by their own org; paid and refunded rows stay undeletable for tenants,
-- as V300 meant. The app answers 409 for the rest (deleteSponsor), so this fence is never what a user meets. The invoice
-- numbering adds `and invoice_number is null` (a numbered invoice is a document).
-- One legacy row stays deletable: V300's own admission, an abandoned checkout (pending, no payment intent, never disputed).
-- deleteCompetition sweeps those through the package join before its packages go (V299 made package_id RESTRICT), so
-- fencing them would turn that delete into a 23503. They never collide with deleteSponsor's legacy refusal: before deals
-- an order got its sponsor only when it was paid (`set status = 'paid', …, sponsor_id = …`), so an abandoned one has none.
--
-- sponsor_packages gains includes_on_stream (default false). sponsor_packages.competition_id IS NULL now means "any
-- competition (the deal picks)", where it used to mean "org-wide". That is a superset of the old meaning: no package row
-- moves, and an org-wide deal is still one the deal picks.
--
-- !! DATA CHANGE (LOUD, by the house rule "data moves: loud + migration, no compat") !!
-- Every existing sponsor_orders row becomes an explicit ENDED deal (D6), in the block between the legacy markers below:
--   deal_status = 'ended', ended_reason = 'legacy', ended_at = coalesce(paid_at, created_at),
--   payment_method = 'online', go_live = 'on_payment' (the only way an order could be made before deals),
--   tier, package_name and competition_id copied from its package, includes_on_stream = false.
-- Its money is untouched: status, amount_cents, currency, payment_intent_id, paid_at, disputed_at and dispute_id keep their
-- values, so the dispute and refund history stays answerable. A legacy row may have no sponsor (V283's SET NULL took the
-- placement it bought); it is the only kind of deal allowed none. The deal logic ignores legacy rows, and nothing is
-- backfilled into a live deal (spec §8a). The migration raises a notice with the number of rows rewritten.
-- Why explicit values instead of a compatibility branch: the owner's loud-migration rule. A reader of any deal column
-- never has to ask "what does null mean on an old row".
--
-- The tests find this file by its SUFFIX (`__sponsor_deals.sql`), never its number: a renumber before merge is a pure
-- `git mv`. server/sponsors/__tests__/deals-migration.test.ts runs the legacy block; keep its markers.

alter table sponsor_packages add column includes_on_stream boolean not null default false;

-- Nullable first: the legacy block fills every existing row, then the NOT NULLs go on.
alter table sponsor_orders
  add column deal_status         text,
  add column payment_method      text,
  add column go_live             text,
  add column tier                text,
  add column includes_on_stream  boolean,
  add column package_name        text,
  add column competition_id      uuid null,
  add column ends_at             timestamptz null,
  add column created_by          uuid null,
  add column invoice_sent_at     timestamptz null,
  add column marked_paid_by      uuid null,
  add column approved_at         timestamptz null,
  add column approved_by         uuid null,
  add column live_at             timestamptz null,
  add column ended_at            timestamptz null,
  add column ended_reason        text null,
  add column parked_at           timestamptz null,
  add column checkout_session_id text null,
  add column checkout_url        text null,
  add column checkout_expires_at timestamptz null,
  add column invoice_send_count  int not null default 0;

-- The header's DATA CHANGE. Only rows with no deal yet (every row, when this runs; the test plants one), so the block is
-- safe to re-run. package_id is NOT NULL and RESTRICT, so every row finds its package.
-- legacy:begin
update sponsor_orders o
   set deal_status        = 'ended',
       ended_reason       = 'legacy',
       ended_at           = coalesce(o.paid_at, o.created_at),
       payment_method     = 'online',
       go_live            = 'on_payment',
       tier               = p.tier,
       package_name       = p.name,
       competition_id     = p.competition_id,
       includes_on_stream = false
  from sponsor_packages p
 where p.id = o.package_id
   and o.deal_status is null;
-- legacy:end

do $$
begin
  raise notice 'sponsor_deals: % existing sponsor_orders rows are now ended legacy deals',
    (select count(*) from sponsor_orders where ended_reason = 'legacy');
end $$;

alter table sponsor_orders
  alter column deal_status        set not null,
  alter column payment_method     set not null,
  alter column go_live            set not null,
  alter column tier               set not null,
  alter column includes_on_stream set not null,
  alter column package_name       set not null,
  alter column sponsor_email      drop not null;

-- V283's status CHECK was unnamed; it goes by its generated name, and its successor is named for what the API calls it.
alter table sponsor_orders
  drop constraint sponsor_orders_status_check,
  add constraint sponsor_orders_payment_status_check
    check (status in ('pending', 'paid', 'failed', 'refunded', 'none'));

alter table sponsor_orders
  add constraint sponsor_orders_deal_status_check
    check (deal_status in ('draft', 'awaiting_payment', 'awaiting_approval', 'scheduled', 'live', 'ended')),
  add constraint sponsor_orders_payment_method_check
    check (payment_method in ('online', 'offline', 'complimentary')),
  add constraint sponsor_orders_go_live_check
    check (go_live in ('on_payment', 'immediate', 'on_approval')),
  -- The tier authority is lib/sponsor-tiers.ts (SPONSOR_TIERS); server/sponsors/__tests__/migration.test.ts compares.
  add constraint sponsor_orders_tier_check
    check (tier in ('title', 'gold', 'silver', 'partner')),
  -- duplicate_payment: a second, different payment on an already-paid deal is recorded as its own ended, paid row.
  add constraint sponsor_orders_ended_reason_check
    check (ended_reason in ('refunded', 'dispute_lost', 'ended_now', 'expired', 'competition_finished', 'legacy',
                            'duplicate_payment')),
  add constraint sponsor_orders_comp_needs_no_payment
    check (go_live <> 'on_payment' or payment_method <> 'complimentary'),
  add constraint sponsor_orders_none_iff_complimentary
    check ((payment_method = 'complimentary') = (status = 'none')),
  add constraint sponsor_orders_online_has_email
    check (payment_method <> 'online' or sponsor_email is not null),
  -- Only an ENDED legacy row may lack a sponsor. Not `or ended_reason = 'legacy'`: that is NULL when ended_reason is null,
  -- and a CHECK passes on NULL, so every open or live deal could then have no sponsor.
  add constraint sponsor_orders_sponsor_or_legacy
    check (sponsor_id is not null or (deal_status = 'ended' and ended_reason is not distinct from 'legacy')),
  -- A deal is ended IFF it has BOTH its end time and its reason. Two equalities, so every mixed shape (a reason without a
  -- time, or a time without a reason, on any state) is refused; one equality against the pair let a live deal carry a
  -- reason and no time. deal_status is NOT NULL and `is not null` is never null, so this never evaluates to NULL.
  add constraint sponsor_orders_ended_shape
    check (((deal_status = 'ended') = (ended_at is not null)) and ((deal_status = 'ended') = (ended_reason is not null)));

-- A deal is history: its sponsor and its competition cannot be deleted from under it. Its actors can.
alter table sponsor_orders
  drop constraint sponsor_orders_sponsor_id_fkey,
  add constraint sponsor_orders_sponsor_id_fkey
    foreign key (sponsor_id) references sponsors(id) on delete restrict,
  add constraint sponsor_orders_competition_id_fkey
    foreign key (competition_id) references competitions(id) on delete restrict,
  add constraint sponsor_orders_created_by_fkey
    foreign key (created_by) references users(id) on delete set null,
  add constraint sponsor_orders_marked_paid_by_fkey
    foreign key (marked_paid_by) references users(id) on delete set null,
  add constraint sponsor_orders_approved_by_fkey
    foreign key (approved_by) references users(id) on delete set null;

-- The widened delete fence (header). `is distinct from`, not `<>`: an open or live deal's ended_reason is NULL, and a
-- policy expression that is NULL refuses the row. A legacy row passes only as V300 admitted it: an abandoned checkout.
drop policy sponsor_orders_prune on sponsor_orders;
create policy sponsor_orders_prune on sponsor_orders for delete to app_user
  using (org_id = current_org_id()
         and status not in ('paid', 'refunded')
         and checkout_session_id is null
         and (ended_reason is distinct from 'legacy'
              or (status = 'pending' and payment_intent_id is null and disputed_at is null)));

-- D3: at most one live deal per sponsor.
create unique index sponsor_orders_one_live_per_sponsor on sponsor_orders (sponsor_id) where deal_status = 'live';
-- The sponsor and competition deletes walk these keys (and the deal reads go by sponsor). The user keys carry no index:
-- a user delete is rare and scans the table once (the V492 convention).
create index sponsor_orders_sponsor_idx on sponsor_orders (sponsor_id);
create index sponsor_orders_competition_idx on sponsor_orders (competition_id) where competition_id is not null;
