-- sponsor_invoices — numbered sponsor invoices (plan docs/superpowers/plans/2026-11-07-sponsor-deals.md, Task 20, D11, F10;
-- spec §7: "Invoice numbers run per org, in sequence, and are never reused").
--
-- What it adds:
--   * sponsor_invoice_counters: one row per org holding the last number it handed out. createDeal takes the next one with a
--     single upsert (`insert … on conflict (org_id) do update set last_number = last_number + 1 returning last_number`,
--     server/sponsors/invoice-number.ts) INSIDE its own transaction, so a create that rolls back hands its number back, and
--     two concurrent creates queue on the org's row instead of reading the same number. No row means the org has numbered
--     nothing: its first number is 1. Tenancy is V283's pattern: RLS enabled AND forced, one org-scoped policy for app_user.
--     The grant is select, insert and update — never delete, because a deleted counter would restart at 1 and reuse numbers.
--     org_id is RESTRICT, as V299 made the orders themselves: no app surface hard-deletes an org, and a script that does must
--     drop this row consciously, after the deals it numbered.
--   * sponsor_orders.invoice_number: the deal's number, shown as SP-0001 (lib/sponsor-deals.ts formatInvoiceNumber). An online
--     or offline deal gets one when it is created; a complimentary deal has no invoice and never does. Unique per org. Fixed once
--     set (trigger sponsor_orders_invoice_number_fixed): null may become a number, a number never changes or clears. A number
--     is 1 or more (sponsor_orders_invoice_number_check): the counter hands out nothing lower, and formatInvoiceNumber refuses
--     anything lower, so a hand-written 0 would break the invoice page and its PDF instead of being refused here.
--   * sponsor_orders.invoice_token_hash: sha256 of the token in the invoice page's link (Task 22 mints it, Task 23 rotates it),
--     stored as a hash only, like sponsor_report_links.token_hash. Unique across every org: a token names one invoice.
--   * organizations.sponsor_invoice_address and sponsor_invoice_bank_details: printed on every sponsor invoice; the bank
--     details are what an offline invoice carries instead of a pay link (spec §10 answer 2: a setting of its own, separate from
--     the registrant payment instructions). Written in Settings → Connect (Task 21).
--
-- Nothing is backfilled. A legacy order (D6) is never given a number: it predates invoices and keeps the history it had. A deal
-- made before this delta keeps none either (only staging has any: sponsor deals reach production with PR 3, owner 2026-11-10).
-- Every new column is nullable with no default, so every existing row reads null.
--
-- The tenant's delete fence narrows (F10). V495's sponsor_orders_prune admits every deal except money paid or refunded, a
-- stored Checkout session and a legacy order beyond V300's abandoned checkout; it now also refuses a NUMBERED deal, since a
-- numbered invoice is a document and its number is never reused. deleteSponsor answers 409 `sponsor_has_deal_history` for a
-- numbered deal before it deletes anything (usecases/sponsors.ts dealHoldsHistory), so this fence is never what a user meets.
-- deleteCompetition's sweep is untouched by it: it deletes legacy abandoned checkouts only (D18 refuses first while any other
-- deal is in scope), and those are never numbered.
--
-- The tests find this file by its SUFFIX (`__sponsor_invoices.sql`), never its number: a renumber at merge is a pure `git mv`
-- (server/sponsors/__tests__/invoices-migration.test.ts).

create table sponsor_invoice_counters (
  org_id      uuid primary key
              constraint sponsor_invoice_counters_org_id_fkey references organizations(id) on delete restrict,
  last_number int  not null,
  constraint sponsor_invoice_counters_last_number_check check (last_number >= 0)
);

alter table sponsor_invoice_counters enable row level security;
alter table sponsor_invoice_counters force  row level security;
create policy sponsor_invoice_counters_tenant on sponsor_invoice_counters for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select, insert, update on sponsor_invoice_counters to app_user;

-- Each unique constraint carries its own index; the token lookup (Task 22's public page) reads by the hash alone.
alter table sponsor_orders
  add column invoice_number     int   null,
  add column invoice_token_hash bytea null,
  -- NULL passes a CHECK: an unnumbered deal (complimentary, legacy, pre-numbering) stays allowed.
  add constraint sponsor_orders_invoice_number_check check (invoice_number >= 1),
  add constraint sponsor_orders_org_invoice_number_key unique (org_id, invoice_number),
  add constraint sponsor_orders_invoice_token_hash_key unique (invoice_token_hash);

-- A number, once set, is fixed. app_user may UPDATE its own deals (V300's sponsor_orders_write), and a number cleared back to null
-- would reopen the prune fence below for that row; a changed one would break "never reused". Setting it from null stays allowed
-- (createDeal sets it in its insert; nothing else writes it). The trigger fires only when the column is written and its value
-- moves, for every role: a privileged script that must rewrite a number turns triggers off for its own transaction, consciously.
create function sponsor_orders_invoice_number_fixed() returns trigger language plpgsql as $$
begin
  raise exception 'sponsor_orders.invoice_number is fixed once set: deal % is number %', old.id, old.invoice_number
    using errcode = '23001', constraint = 'sponsor_orders_invoice_number_fixed';
end $$;
create trigger sponsor_orders_invoice_number_fixed
  before update of invoice_number on sponsor_orders
  for each row when (old.invoice_number is not null and new.invoice_number is distinct from old.invoice_number)
  execute function sponsor_orders_invoice_number_fixed();

alter table organizations
  add column sponsor_invoice_address      text null,
  add column sponsor_invoice_bank_details text null;

-- V495's fence, restated whole with the number arm (`invoice_number is null`: a numbered invoice is never deleted).
drop policy sponsor_orders_prune on sponsor_orders;
create policy sponsor_orders_prune on sponsor_orders for delete to app_user
  using (org_id = current_org_id()
         and status not in ('paid', 'refunded')
         and checkout_session_id is null
         and invoice_number is null
         and (ended_reason is distinct from 'legacy'
              or (status = 'pending' and payment_intent_id is null and disputed_at is null)));
