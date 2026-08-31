-- RS009 — organiser assignment of solo sign-ups onto team entries.
--
-- Two additive changes. Neither rewrites a row, and both leave every
-- existing division behaving exactly as it does today.
--
-- The product word for these entries is "solo sign-up", not "free agent"
-- (RS005 ruled the two vocabularies confusing when they sat three keys
-- apart in the same panel). `free_agent` / `allow_free_agents` stay as the
-- column and API names — only the user-facing copy uses the other word.

-- 1. `organiser_assigned` — the third way a roster row can come to exist.
--
-- Until now a `registration_players` row was either typed by the captain at
-- submit (`captain_entered`) or created by the player themselves following a
-- join link (`self_joined`). An organiser placing a pooled solo sign-up onto
-- a team is neither: nobody typed the name into that team's roster, and the
-- player did not choose that team. It needs its own value so the roster can
-- say truthfully how each player got there — the status page, the CSV export
-- and any future audit all read `source`.
--
-- There is no zod enum for this column anywhere in the codebase, so THIS
-- constraint and the `RegistrationPlayerRow["source"]` union in
-- `apps/web/src/server/usecases/registrations.ts` are the whole truth. They
-- are the two sites a change has to touch, and nothing catches updating only
-- one of them — `tsc` cannot see a CHECK constraint, and Postgres cannot see
-- a TypeScript union. A test pins both.
alter table registration_players
  drop constraint registration_players_source_check;

alter table registration_players
  add constraint registration_players_source_check
    check (source in ('captain_entered', 'self_joined', 'organiser_assigned'));

-- 2. `free_agent_fee_cents` — what ONE person pays to enter a team division
-- on their own.
--
-- The defect this closes, found before any RS009 code was written:
-- `registration-submit.ts` computes `const feeCents = waitlisted ? 0 :
-- live.fee_cents` with no solo-sign-up branch at all. `fee_cents` on a team
-- division is a price PER TEAM, so a lone player entering a £60-per-team
-- division was charged £60. Once an organiser then assigns them onto a team
-- that also paid £60, the organiser has collected £120 for a single roster
-- of eight. Nobody chose that; it fell out of RS002/RS006 and no test could
-- see it, because charging the documented `fee_cents` looks correct.
--
-- NULL is meaningful and is the default: it means "no separate price — fall
-- back to `fee_cents`", i.e. exactly today's behaviour. So this column
-- changes nothing until an organiser sets it, and no backfill is owed. A
-- sentinel of 0 could not express this: 0 is a legitimate price (a free
-- solo sign-up in a paid division), and conflating "free" with "unset" is
-- how a division that means to charge nothing ends up charging the full
-- team fee.
--
-- Guarded, not merely typed: a negative price is not a discount, it is a
-- refund the checkout has no way to honour.
alter table registration_settings
  add column free_agent_fee_cents integer;

alter table registration_settings
  add constraint registration_settings_free_agent_fee_check
    check (free_agent_fee_cents is null or free_agent_fee_cents >= 0);

comment on column registration_settings.free_agent_fee_cents is
  'What one person pays to enter this team division alone. NULL = no separate price, charge fee_cents (the per-team price). 0 is a real price, not "unset".';

-- 3. The assignment link itself.
--
-- A solo sign-up keeps its OWN `registrations` row after being placed: that
-- row holds their money, their consent and their answers, and none of that
-- becomes the team's. What assignment creates is a roster membership — a
-- `registration_players` row on the TARGET team's registration — so the link
-- belongs on that row, pointing back at where the player came from.
--
-- One column, deliberately, not two. The tempting alternative is a matching
-- `registrations.assigned_to_registration_id` on the source side, which
-- would make "is this entry still in the pool?" a single-column read. It
-- would also be a second copy of one fact, and this programme's index
-- already records several defects that are exactly two paths drifting apart.
-- The pool is therefore DERIVED — `free_agent` and no row pointing back —
-- and cannot disagree with the roster it is derived from.
--
-- `on delete cascade`: if the solo sign-up's own registration is deleted,
-- their membership of someone else's roster must go with it. Leaving an
-- orphaned roster row would silently overstate that team's fill.
alter table registration_players
  add column assigned_from_registration_id uuid
    references registrations (id) on delete cascade;

-- One person, one team. Enforced here rather than in the usecase, because a
-- usecase check is a read followed by a write and two organisers pressing
-- Assign on the same pooled player at the same moment both pass it.
create unique index registration_players_assigned_from_uniq
  on registration_players (assigned_from_registration_id)
  where assigned_from_registration_id is not null;

-- The source value and the link are two halves of one fact, so neither is
-- allowed to appear without the other. Without this, a row could claim
-- `organiser_assigned` while pointing nowhere (unassign would never find it)
-- or carry a link while claiming the captain typed it (the roster would lie
-- about how the player got there).
alter table registration_players
  add constraint registration_players_assigned_from_matches_source
    check (
      (source = 'organiser_assigned') = (assigned_from_registration_id is not null)
    );

create index registration_players_assigned_from_idx
  on registration_players (assigned_from_registration_id);

comment on column registration_players.assigned_from_registration_id is
  'The solo sign-up registration this roster row was placed from (RS009). Non-null exactly when source = organiser_assigned. The pool is derived: a free_agent registration with no row pointing back at it is still unassigned.';
