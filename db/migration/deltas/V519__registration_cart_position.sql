-- =============================================================================
-- V519 — every entry keeps its place in the cart it was sent in (registration redesign B5 T17, spec §6.1; orchestrator
-- rulings 2026-11-13: the database is the ONLY writer of a position, and a reference never changes after submit).
--
-- An offline bank transfer quotes a reference, and one cart can hold several entries that are each paid on their own, so
-- each entry gets its own: the cart's SZ-XXXX-XXXX plus "-<n>". Neither half of "-<n>" is worked out at read time, because
-- a derived number moves when a sibling's division is deleted (registrations cascade on division delete):
--
--   registrations.cart_position    the entry's 1-based place in its cart. Insert order IS cart order: submit inserts a
--                                  cart's entries one by one in the order the person added them
--                                  (registration-submit.ts, the `for (const p of prepared)` loop).
--   registration_groups.cart_size  the largest position the cart ever handed out = how many entries it was sent with.
--                                  It decides whether references carry a suffix at all (a 1-entry cart is quoted bare,
--                                  lib/ref-code.ts entryReference). It never shrinks, so a lone survivor of a 3-entry cart
--                                  is still "-3", and a deleted entry's number is never handed out again.
--
-- ONE writer: trg_cart_position (BEFORE INSERT on registrations) bumps the group's cart_size — the UPDATE takes the group
-- row lock, so two inserts into one group queue rather than race — and gives the new value to the entry. An insert may not
-- supply a position (refused), an update may not change an entry's position or move it to another cart (refused), a
-- cart's size may not go down (refused), and a new cart starts at size 0 (an insert naming any other size is refused, or
-- its first entry would be numbered past 1 and a one-entry cart quoted with a suffix). Fixtures, e2e seeds and smoke
-- inserts name neither column and need no change.
--
-- !! DATA CHANGE — BACKFILL (marked block below) !!
--   Every existing registration is numbered within its group by (created_at, id): the order the status page and the cart
--   mail already read a cart in. Each group's cart_size becomes the number of entries it holds today (0 for an empty one).
--   Prod holds 0 registrations (owner, 2026-11-12) and stg data is test-only, so no real reference changes.
-- =============================================================================

alter table registration_groups add column cart_size smallint not null default 0;

alter table registrations add column cart_position smallint;

-- BACKFILL BEGIN (server/__tests__/registration-cart-position.test.ts runs this block against temp tables)
update registrations r
   set cart_position = x.n
  from (select id, row_number() over (partition by group_id order by created_at, id) as n from registrations) x
 where x.id = r.id;
update registration_groups g
   set cart_size = x.n
  from (select group_id, max(cart_position) as n from registrations group by group_id) x
 where x.group_id = g.id;
-- BACKFILL END

alter table registrations alter column cart_position set not null;
alter table registrations add constraint registrations_cart_position_positive check (cart_position >= 1);
create unique index registrations_group_position_uq on registrations (group_id, cart_position);

-- SECURITY INVOKER (the default), like set_org_from_parent: under app_user's RLS an entry pointed at another tenant's
-- cart finds no group row and is refused by name.
create or replace function registrations_assign_cart_position() returns trigger
  language plpgsql as $$
begin
  if new.cart_position is not null then
    raise exception 'cart_position: registrations.cart_position is assigned by the database, never by the insert';
  end if;
  update registration_groups set cart_size = cart_size + 1
   where id = new.group_id
  returning cart_size into new.cart_position;
  if new.cart_position is null then
    raise exception 'cart_position: registration group % not found', new.group_id;
  end if;
  return new;
end $$;

create trigger trg_cart_position before insert on registrations
  for each row execute function registrations_assign_cart_position();

create or replace function registrations_freeze_cart_position() returns trigger
  language plpgsql as $$
begin
  if new.cart_position is distinct from old.cart_position or new.group_id is distinct from old.group_id then
    raise exception 'cart_position: an entry''s place in its cart never changes (% #% -> % #%)',
      old.group_id, old.cart_position, new.group_id, new.cart_position;
  end if;
  return new;
end $$;

create trigger trg_cart_position_frozen before update of cart_position, group_id on registrations
  for each row execute function registrations_freeze_cart_position();

create or replace function registration_groups_cart_size_never_shrinks() returns trigger
  language plpgsql as $$
begin
  if new.cart_size < old.cart_size then
    raise exception 'cart_position: a cart''s size never shrinks (% -> %)', old.cart_size, new.cart_size;
  end if;
  return new;
end $$;

create trigger trg_cart_size_never_shrinks before update of cart_size on registration_groups
  for each row execute function registration_groups_cart_size_never_shrinks();

-- B3 review m7: the insert was the one way left to write a cart_size by hand. Only trg_cart_position raises it.
create or replace function registration_groups_cart_size_starts_at_zero() returns trigger
  language plpgsql as $$
begin
  if new.cart_size <> 0 then
    raise exception 'cart_position: a new cart''s size starts at 0 and only its entries raise it (got %)', new.cart_size;
  end if;
  return new;
end $$;

create trigger trg_cart_size_starts_at_zero before insert on registration_groups
  for each row execute function registration_groups_cart_size_starts_at_zero();
