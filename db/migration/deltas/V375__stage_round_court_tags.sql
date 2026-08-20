-- =============================================================================
-- V375 — round-scoped required court tags (#622).
--
-- V367 gave `divisions` and `stages` a `required_court_tags text[]`. That is
-- enough to say "every knockout match must be indoor" and structurally unable
-- to say "only the final needs the championship court": QF, SF and the final
-- inside one knockout stage share a single `stages` row, so a stage-level tag
-- is inherited by all three. This table is the missing third scope.
--
-- KEYED BY ROLE, NOT BY `fixtures.round_no`. The obvious column would be an
-- int matching `fixtures.round_no`, and `constraints.ts`'s `FixtureSelector`
-- already records why that is wrong for a rule an organiser AUTHORS: "an
-- elimination bracket numbers sparsely (1,2,3 winners / 7-10 losers / 14 grand
-- final) and a USER-FACING RULE keyed on one would silently address the wrong
-- fixtures". Two concrete failures a round_no key would ship with:
--
--   * A double-elim stage numbers WB, LB and GF in ONE space, so round_no 7
--     names a losers-bracket round in an 8-entrant bracket and something else
--     entirely at 16. "The grand final" is not expressible.
--   * Changing a stage's entrant count renumbers every round. A tag written
--     against "round 3" silently moves to a different round the next time the
--     draw is resized, with no error and no visible change.
--
-- `round_role` therefore stores the key of the POSITIONAL role
-- `packages/engine/src/competition/round-role.ts`'s `roundRole()` already
-- computes for display — `final`, `semi_final`, `quarter_final`,
-- `round_of_16`, `losers_round_2`, `grand_final`, `rung_3`, `plain_round_4`,
-- serialised by that module's `roundRoleKey()` and validated on the way in by
-- its `parseRoundRoleKey()`. A role survives a resize: "the final" is `final`
-- at 8 entrants and at 64.
--
-- ROUND-ROBIN-KIND STAGES (#622's second open question) need no second
-- scheme. `roundRole()` now answers for every stage kind, returning
-- `plain_round_N` where a round is an ordinal rather than a bracket position,
-- so a `league`/`group` stage addresses its rounds in the SAME vocabulary
-- through the SAME column.
--
-- TEXT, not an enum type: the role vocabulary is owned by the engine module
-- above and grows with new stage formats (page-playoff's `qualifier1`/
-- `eliminator`/`qualifier2` arrived after `knockout`'s). A pg enum would put a
-- migration between the engine gaining a format and an organiser being able to
-- tag it, and the value is validated at the write path either way.
--
-- NO FK TO A ROUND, because there is no rounds table and deliberately so — a
-- role names a POSITION, and a stage whose rounds have not been generated yet
-- (or were regenerated at a different size) must still be able to carry the
-- rule. A row naming a role no current fixture occupies is inert, not
-- corrupt: nothing resolves it, exactly like a `divisions.required_court_tags`
-- naming a tag no court carries.
--
-- `org_id` denormalised and pinned to the parent by composite FK, the shape
-- V367's own header argues for at length (`scripts/check-rls.ts` enumerates
-- only tables that HAVE an org_id, so a tenant table without one ships as a
-- table the RLS guard skips SILENTLY). `stages` had no `unique (id, org_id)`
-- to hang that FK on, so this migration adds one first — additive, and the
-- same shape `venues`/`courts` already carry.
-- =============================================================================

alter table stages
  drop constraint if exists stages_id_org_key;

alter table stages
  add constraint stages_id_org_key unique (id, org_id);

create table if not exists stage_round_court_tags (
  stage_id            uuid   not null,
  org_id              uuid   not null,
  round_role          text   not null,
  required_court_tags text[] not null default '{}',
  created_at          timestamptz not null default now(),
  primary key (stage_id, round_role),
  foreign key (stage_id, org_id) references stages (id, org_id) on delete cascade
);

create index if not exists stage_round_court_tags_org_idx
  on stage_round_court_tags(org_id);

comment on table stage_round_court_tags is
  'Round-scoped required court tags (#622). One row per (stage, round role); the effective requirement for a fixture is division ∪ stage ∪ THIS row, resolved per fixture by usecases/court-candidates.ts.';
comment on column stage_round_court_tags.round_role is
  'A roundRoleKey() value from packages/engine/src/competition/round-role.ts — final, semi_final, quarter_final, round_of_16, losers_round_2, grand_final, grand_final_reset, third_place, winners_final, losers_final, qualifier1, eliminator, qualifier2, rung_N, plain_round_N. Never a fixtures.round_no: see this migration''s header.';

alter table stage_round_court_tags enable row level security;
alter table stage_round_court_tags force  row level security;
create policy stage_round_court_tags_tenant on stage_round_court_tags for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select, insert, update, delete on stage_round_court_tags to app_user;
