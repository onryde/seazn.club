-- V497 — stage_auto_actions: one row per thing the clock will do to a stage. Spec:
-- docs/superpowers/specs/2026-11-08-swiss-auto-advance-design.md §4.2 (plan
-- docs/superpowers/plans/2026-11-08-swiss-auto-advance.md, Task 1, decisions D9/D10).
--
-- WHY. Swiss auto-advance pairs the next round, completes the stage and confirms the hand-off 60 s after the last
-- relevant result. Arming (rearmAutoActions), firing (the cron sweep and the optional QStash alarm) and the fixtures
-- banner all read and write ONE row per (stage, kind), so there is one authority for "what will happen next, and
-- when". A row is the fact; nothing is derived on read.
--
-- SHAPE.
--   kind              pair_round | complete_stage | confirm_handoff. For confirm_handoff `stage_id` is the TARGET
--                     stage (the one the hand-off fills).
--   target_round      the round to pair (pair_round) or the source stage's last round (complete_stage).
--   target_proposal_id the stage_seed_proposals draft to confirm (confirm_handoff). Exactly one of the two targets is
--                     set, by kind (the target_shape CHECK). Two typed columns rather than one text `target` (D9).
--   state             waiting (a board is still open) | pending (counting down to due_at) | paused (a person is
--                     reviewing the proposal; due_at is hold time + 30 min so the sweep releases it with the same
--                     "due" query, D9) | blocked (a typed refusal; blocked_code + detail say why) | done | cancelled.
--   detail            the refusal's params for a blocked row, or a waiting row's open boards (spec `blocked_detail`,
--                     widened, D9).
--   lease_until, attempts   claim and retry, the email outbox's shape (V470).
--   done_at, result   what was done, and by whom.
--
-- ONE LIVE ROW PER (stage, kind). Live = waiting, pending, paused, blocked. The spec's §4.2 sentence lists three;
-- `paused` is live too (a confirm row under review must still block a second confirm row for the same stage, or the
-- sweep could fire a fresh draft while the organiser edits the old one). Finished rows (done, cancelled) are history
-- and accumulate. The key is (stage, kind), not the target: a new target retires the old row first (D1).
--
-- TENANCY. RLS as V360's stage_seed_proposals: ENABLE + FORCE, one policy for app_user scoped to current_org_id(),
-- full DML grant. The cross-org sweep claims rows with the pooled privileged role, as the email outbox worker does.
--
-- Additive: a new table, no existing row touched.
create table if not exists stage_auto_actions (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references organizations(id) on delete cascade,
  division_id        uuid not null references divisions(id) on delete cascade,
  stage_id           uuid not null references stages(id) on delete cascade,
  kind               text not null,
  target_round       int,
  target_proposal_id uuid references stage_seed_proposals(id) on delete cascade,
  state              text not null,
  due_at             timestamptz,
  blocked_code       text,
  detail             jsonb,
  lease_until        timestamptz,
  attempts           int not null default 0,
  done_at            timestamptz,
  result             jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  -- Closed sets. A fourth kind or a seventh state is a code change AND a migration.
  constraint stage_auto_actions_kind_valid check (kind in ('pair_round', 'complete_stage', 'confirm_handoff')),
  constraint stage_auto_actions_state_valid check (state in (
    'waiting', 'pending', 'paused', 'blocked', 'done', 'cancelled'
  )),
  -- A confirm targets a proposal and no round; the two round kinds target a round and no proposal.
  constraint stage_auto_actions_target_shape check (
    case when kind = 'confirm_handoff'
      then target_proposal_id is not null and target_round is null
      else target_proposal_id is null and target_round is not null
    end
  ),
  -- A counting row (pending) and a held row (paused, due = hold + 30 min) are both found by the sweep's due scan;
  -- one with no due_at would never fire and never release, so the stage would stall with a live row in the way.
  constraint stage_auto_actions_due_at_when_timed check (state not in ('pending', 'paused') or due_at is not null),
  -- A blocked row is shown to a person as "what needs you"; without its code the banner has nothing to say.
  constraint stage_auto_actions_blocked_code_when_blocked check (state <> 'blocked' or blocked_code is not null),
  constraint stage_auto_actions_attempts_nonneg check (attempts >= 0)
);

-- At most one live row per (stage, kind) — the arming upsert's real constraint, not a fast path.
create unique index if not exists stage_auto_actions_one_live
  on stage_auto_actions (stage_id, kind) where state in ('waiting', 'pending', 'paused', 'blocked');

-- The sweep's due scan: pending rows to fire, paused rows whose hold has lapsed.
create index if not exists stage_auto_actions_due
  on stage_auto_actions (due_at) where state in ('pending', 'paused');

-- The banner and history: a division's rows, newest first.
create index if not exists stage_auto_actions_division_recent
  on stage_auto_actions (division_id, updated_at desc);

-- Skip is sticky for its target: rearm looks up a cancelled (stage, kind, round) before it arms that round again.
-- Deliberately NOT partial: it is also the stage_id-leading index the stages FK cascade needs (the partial
-- one_live index covers only live rows, so without this a stage delete would scan the table).
create index if not exists stage_auto_actions_stage_target
  on stage_auto_actions (stage_id, kind, target_round);

-- The stage_seed_proposals FK cascade: deleting a proposal finds its confirm row(s). Only confirm rows carry one.
create index if not exists stage_auto_actions_proposal
  on stage_auto_actions (target_proposal_id) where target_proposal_id is not null;

alter table stage_auto_actions enable row level security;
alter table stage_auto_actions force row level security;
drop policy if exists stage_auto_actions_tenant on stage_auto_actions;
create policy stage_auto_actions_tenant on stage_auto_actions for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select, insert, update, delete on stage_auto_actions to app_user;

comment on table stage_auto_actions is
  'Swiss auto-advance (spec 2026-11-08 §4.2): one live row per (stage, kind) for what the clock will do next — '
  'pair_round | complete_stage | confirm_handoff — and its finished history (done | cancelled).';
