-- =============================================================================
-- V360 — Stage progression: seeding rules + TBD fixtures + fill engine
-- (D4a / P5, portfolio bench spec §14 item 4).
--
-- `fixtures.home_entrant_id` / `away_entrant_id` are ALREADY nullable since
-- V214 ("null = TBD/bye") — no change needed there. What's new:
--
-- 1) `stages.seeding` — the declarative StageSeeding rule (source stage +
--    take kinds + placement), separate from the existing `stages.qualification`
--    column. `qualification` stays as-is (existing auto-seed-on-complete
--    flow, unification is at the fillSlot call site, not the schema); a stage
--    declaring `.seeding` goes through the NEW propose/confirm flow instead.
-- 2) `fixtures.home_slot_label` / `away_slot_label` — i18n pattern refs
--    ({key, params, seed}) for a not-yet-filled slot ("Winner Group A", "3rd
--    best of A/B/C/D"). Cleared on fill (label text is derivable post-fill —
--    kept for history on the stage_seed_proposals row, per the design's Fill
--    algorithm step 4).
-- 3) `stage_seed_proposals` — one computed proposal per completion event; at
--    most one 'draft' per stage (organiser sees ONE live proposal, never a
--    pile of stale ones), status transitions draft -> confirmed | stale.
--
-- No GIN indexes: none of these jsonb columns are queried by containment
-- (`@>`) — always read whole-row by stage_id/fixture id, already indexed.
-- =============================================================================

alter table stages add column if not exists seeding jsonb;

alter table fixtures add column if not exists home_slot_label jsonb;
alter table fixtures add column if not exists away_slot_label jsonb;

create table if not exists stage_seed_proposals (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id) on delete cascade,
  stage_id     uuid not null references stages(id) on delete cascade,
  -- {qualifiers: [{rank, source, entrantId, destinationSlot}], ties: [...],
  --  standingsHash} — see stage-seeding.ts for the exact shape.
  computed     jsonb not null,
  status       text not null default 'draft' check (status in ('draft', 'confirmed', 'stale')),
  created_at   timestamptz not null default now(),
  confirmed_at timestamptz
);

-- Every read is "the proposals for this stage" (draft lookup, history list).
create index if not exists stage_seed_proposals_stage_idx
  on stage_seed_proposals (stage_id);

-- One live draft per stage (design: "confirm FILLS existing fixtures, never
-- regenerates" — a second concurrent draft would let the organiser confirm
-- stale data). Recompute/override transitions the old draft to 'stale' before
-- inserting a fresh one, never updates a draft in place, so this index is a
-- real constraint, not just a fast-path.
create unique index if not exists stage_seed_proposals_draft_uq
  on stage_seed_proposals (stage_id) where status = 'draft';

alter table stage_seed_proposals enable row level security;
alter table stage_seed_proposals force row level security;
drop policy if exists stage_seed_proposals_tenant on stage_seed_proposals;
create policy stage_seed_proposals_tenant on stage_seed_proposals for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select, insert, update, delete on stage_seed_proposals to app_user;

comment on table stage_seed_proposals is
  'D4a/P5: one computed qualifier proposal per stage completion event for a '
  '.seeding-declared stage. draft -> confirmed (fills TBD fixtures via '
  'fillSlot) | stale (a dependent standings override superseded it).';
