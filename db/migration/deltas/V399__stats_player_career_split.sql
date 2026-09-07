-- Entitlements v18 W3 / Task 2a (W3-A) — split `stats.player` into the
-- per-division RECORD (free on every plan) and the cross-division CAREER
-- ROLLUP (`stats.player.career`, still Pro + pass).
--
-- `stats.player` was one key gating three readers (usecases/player-stats.ts):
-- `divisionPlayerStats`, `personStats` (both the division-scoped RECORD) and
-- `personCareerStats` (the org-wide rollup across every division a person has
-- played). Denying it on community, combined with V396 making competitions
-- public by default, produced an inversion: `publicDivisionStats` (the public
-- leaderboard) carried NO gate at all, so an anonymous visitor saw a Free
-- org's player stats while the org itself, signed in, got 402. And
-- `recomputePlayerStats` runs regardless of plan either way, so the org was
-- already paying the compute and having the result withheld from itself.
--
-- Ruling (docs/superpowers/plans/2026-09-06-entitlements-w3-surfaces.md,
-- "W3-A"): the record is Free — reach + data value, and it is what the
-- public leaderboard was already showing for nothing. The rollup is the
-- leverage half and stays paid, on its OWN key so the pricing matrix can
-- describe the split honestly rather than a row lying about the free half.
--
-- Two steps. Order does not matter — one INSERTs a new key, the other
-- UPDATEs an existing one — but both are re-runnable, like every statement
-- in this tree.

-- ---------------------------------------------------------------------------
-- Step 1: `stats.player.career` — the rollup, carrying forward EXACTLY the
-- values `stats.player` held before this migration (community F, pro T, both
-- pass rungs T, enterprise T). `PASS_FEATURES` (lib/pass-features.ts) moves
-- to this key in the same commit — the pass still lifts the rollup, it just
-- no longer needs to lift the (now free) record.
insert into plan_entitlements (plan_key, feature_key, bool_value)
values ('community',    'stats.player.career', false),
       ('pro',          'stats.player.career', true),
       ('event_pass',   'stats.player.career', true),
       ('event_pass_l', 'stats.player.career', true),
       ('enterprise',   'stats.player.career', true)
on conflict (plan_key, feature_key) do update set bool_value = excluded.bool_value;

-- ---------------------------------------------------------------------------
-- Step 2: `stats.player` becomes true on every plan, community included —
-- the record is free. The gate CALLS at the enforcement sites are left in
-- place (`divisionPlayerStats`'s `requireFeature`, `personStats`'s
-- `statsReadableDivisions`, and the new gate on `publicDivisionStats`): the
-- only refusal any of them can raise from here on is an explicit
-- `org_entitlement_overrides` deny, the same shape `formats.double_elim` /
-- `cricket.dls` / `standings.custom_points` / `tiebreakers.custom` already
-- use post-V393. Keeping the row (rather than deleting the key outright)
-- is what lets staff still switch the record off for one organisation.
update plan_entitlements set bool_value = true where feature_key = 'stats.player';
