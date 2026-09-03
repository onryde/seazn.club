-- Entitlements v18 W2 / T10 (owner ruling 2026-09-03): AUD is withdrawn
-- outright. It did two jobs and this takes both — the platform's own plan
-- prices (`config/stripe-plans.json` loses every `aud` point) AND
-- `organizations.currency`, which is the currency an Australian club quoted,
-- charged and settled its own registration entry fees in. The owner chose full
-- removal with that second cost stated.
--
-- `organizations.currency` is the only allowlisted currency column in the
-- schema. `registration_groups.currency` carries NO CHECK on purpose (V365's
-- own comment): a cart's currency is a historical snapshot taken at submit, and
-- delisting a code must never retroactively invalidate a cart that was
-- legitimately quoted in it. So nothing here touches submitted carts.
--
-- The guard that makes this safe is `org-currency.test.ts`, which reads the
-- codes back out of `pg_get_constraintdef` and compares them to
-- `REGISTRATION_CURRENCIES` (derived from `SUPPORTED_CURRENCIES` in
-- `lib/currency.ts`). `tsc` cannot see a SQL CHECK and Postgres cannot see a TS
-- constant, so that test is the only thing joining the two halves of this
-- change — do not weaken it.
--
-- Greenfield: the owner reconfirmed on 2026-09-03 that there is no production
-- data, so no row needs converting. That is an assumption about the environment
-- this file runs in, not a property of the file, so it is CHECKED rather than
-- trusted: a leftover 'aud' row would otherwise surface as a bare 23514 from
-- the constraint creation below, naming a constraint and not the problem.
do $$
declare
  stranded bigint;
begin
  select count(*) into stranded from organizations where currency = 'aud';
  if stranded > 0 then
    raise exception
      'V392 refuses to drop AUD: % organizations still have currency = ''aud''. '
      'Decide what each one charges entry fees in and update it first — this '
      'migration will not silently repoint a club''s settlement currency.',
      stranded;
  end if;
end $$;

alter table organizations drop constraint organizations_currency_check;

alter table organizations add constraint organizations_currency_check
  check (currency in ('usd','eur','gbp','inr'));
