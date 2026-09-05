-- Entitlements v18 W3 (owner ruling 2026-09-04; design of record
-- docs/superpowers/specs/2026-09-02-entitlements-v18-three-tier-design.md §2,
-- amended in the same commit — `entitlements-v18-matrix.test.ts` parses that
-- table and pins every cell below against it).
--
-- THE PLATFORM FEE BECOMES ADDITIVE. Today the platform cut is taken out of a
-- DESTINATION charge, so Stripe's own processing fee (2.9% + $0.30 in the US)
-- comes out of the same slice we do. Our 2% on Pro therefore never covered
-- Stripe's cut: Pro and Enterprise LOSE MONEY on every registration, whatever
-- its size, because the loss is a rate, not a fixed overhead a big entry fee
-- eventually absorbs. Under the additive model the connected account bears
-- Stripe's cost and our percentage is pure margin — so the rates come down.
--
-- It is also how the market quotes: LeagueApps sells "2.5% on top of Stripe",
-- Regystra "1% plus standard Stripe processing". An organiser comparing us
-- against either was reading our all-in number against their margin number.
--
--   plan          before -> after
--   community          8 -> 5
--   pro                2 -> 2   (unchanged; it is already pure margin)
--   event_pass         5 -> 4
--   event_pass_l       5 -> 4
--   enterprise         1 -> 1   (unchanged)
--
-- The CHARGE PATH is a separate task and is deliberately NOT touched here:
-- moving Stripe's cost onto the connected account is an `on_behalf_of` /
-- charge-type change in `server/usecases/registrations.ts`, not a matrix edit.
-- Until it lands, these rates are simply lower rates on the existing charge
-- shape — no organiser is worse off at any point in the sequence, which is why
-- the matrix may move first.
--
-- NOT re-rated, by design: `competitions.fee_percent`. V316 locks a
-- competition's rate at its FIRST PAID ENTRY, and every help article, tip and
-- FAQ in the tree promises that the locked rate never moves — "whatever
-- happens to the plan afterwards". A cheaper rate is still a change to a
-- number the organiser was told was frozen, and the four surfaces that explain
-- the lock would all become false. Competitions that have not yet sold pick up
-- the new rate on their next entry, live, through `feePercentFor`.
--
-- `platform_settings.platform_fee_percent` (V273, admin-set, the fallback for
-- an org whose plan has no row at all) stays at 5 and is out of scope — the
-- staff console that owns it is a separate task.

-- ---------------------------------------------------------------------------
-- The whole ladder in one statement, not just the three rows that move.
--
-- Re-runnable, like every statement in this tree, and readable as the
-- COMPLETE claim: a reader of this file should not have to hold V310, V270,
-- V393 and this delta in their head at once to know what the five rates are.
-- `bool_value` is left alone (these are int keys and every row's bool is
-- already null — see V393's header on leaving the stray opposite-type column
-- untouched).
insert into plan_entitlements (plan_key, feature_key, bool_value, int_value)
values ('community',    'registration.fee_percent', null, 5),
       ('pro',          'registration.fee_percent', null, 2),
       ('event_pass',   'registration.fee_percent', null, 4),
       ('event_pass_l', 'registration.fee_percent', null, 4),
       ('enterprise',   'registration.fee_percent', null, 1)
on conflict (plan_key, feature_key) do update set int_value = excluded.int_value;

-- ---------------------------------------------------------------------------
-- A loud guard, in the house style of V393/V396: a rate this migration did not
-- write means a plan row was added elsewhere and nobody re-read the ladder.
-- Every published fee table in `content/help/**` is checked against these five
-- numbers by `feeLadderFaults`, so a sixth rate is a customer-visible lie.
do $$
declare
  wrong text;
  n int;
begin
  -- THE EMPTY CASE FIRST, because this guard could not see it. `string_agg`
  -- over zero rows returns NULL, and the check below is `wrong is not null` —
  -- so a migration that deleted every fee row, or a typo in `feature_key`,
  -- passed as clean. Count first and state the number this migration
  -- guarantees, so "there is nothing here" fails instead of succeeding.
  select count(*) into n
    from plan_entitlements where feature_key = 'registration.fee_percent';
  if n <> 5 then
    raise exception 'V398: expected 5 registration.fee_percent rows, found %', n;
  end if;

  -- ...and NULL asked separately, because `(plan_key, int_value) not in (...)`
  -- can never catch it: a row comparison against NULL evaluates to NULL, not
  -- TRUE, so the row is simply not selected and the guard reports clean.
  --
  -- That matters for THIS key more than most. NULL means UNLIMITED in this
  -- schema, and an unlimited rate resolves through `getLimit` into
  -- `feePercentFor`'s `pct == null || pct <= 0` branch, which falls back to
  -- `platformFeeDefault()` — 5%. So a null `pro` rate does not charge nothing;
  -- it silently charges a Pro org 5% where it was sold 2%.
  select string_agg(plan_key || '=' || coalesce(int_value::text, 'null'), ', ' order by plan_key)
    into wrong
    from plan_entitlements
   where feature_key = 'registration.fee_percent'
     and (int_value is null
          or (plan_key, int_value) not in (
            ('community', 5), ('pro', 2), ('event_pass', 4), ('event_pass_l', 4), ('enterprise', 1)
          ));
  if wrong is not null then
    raise exception 'V398: registration.fee_percent carries rates this migration does not set: %', wrong;
  end if;
end $$;
