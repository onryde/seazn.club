-- V474 — W2d (format matrix: tables and tie-breaks): the stage table-rules pin, the stored lots draws, the B1 pin of every
-- started stage, and the outcome-keyed stage points rule on the public and console reads.
-- Spec docs/superpowers/specs/2026-10-20-format-matrix-w2d-design.md §5.3, §5.4 "Migration pin (B1)", §5.8, §8; plan
-- docs/superpowers/plans/2026-10-20-format-matrix-w2d.md Tasks 2 and 7 (PF-1, PF-3, PS-1d, PS-8). One unmerged
-- migration, amended by both tasks — never a V473.
--
-- ── What this delta does, in order ──
-- 1. `stages.table_rules_pinned` / `table_rules_pinned_at` (spec §5.4): the rules a started stage is paid and ranked by,
--    frozen. A column, not a `config` key, so no `config` merge or `replaceStages` carry can drop it. Both or neither.
-- 2. `stage_lots_draws` (spec §5.8): a residual tie's drawn order, keyed by the tied class's member set, so a reload
--    draws the same order; a new draw for a changed class supersedes the old row, which stays as history.
-- 3. The B1 helpers, pure and named `w2d_*`: `w2d_legacy_points` (the SQL twin of the engine's `legacyPointsRule`),
--    `w2d_pre_points` (the points each sport paid BEFORE W2d, as an outcome-keyed rule), `w2d_pre_cascade` (each sport's
--    pre-W2d default tie-break list), `w2d_drop_shootout_split` (a division config off the retired shoot-out split).
--    The pre-W2d values are written in as LITERALS, re-read at W2D_BASE (e97823e4d8, main before W2d): the code defaults
--    change in this same release, and the migration must not read them.
-- 4. `w2d_pin_started_stages()` — the B1 pin (spec §5.4, §8).
-- 5. `stage_qualification_meta` (W2d Task 2; PF-3) and `public_stages_v`: `points_rule` stays the stage's OWN rule (the
--    format line prints it as the stage's own points). The rule the TABLE is paid by is not published here: every reader
--    takes it from the one loader (`server/engine-db/table-rules.ts`, W2d Task 9; T9 review m3 retired the
--    `table_points_rule` column this step first added, which disagreed with the loader on a pending stage).
-- 6. The data steps, in ONE block: pin first, then convert the old-shape stage rules, then the division configs and the
--    organisations' own sport variants (W2d Task 9, T7 review m10: a variant's cfg seeds a new division's).
-- 7. The `w2d_*` helpers are DROPPED: after this release the start path is the only pin writer, and a manual call of the
--    pin would pin a stage with PRE-W2d payers.
--
-- ── B1 decisions (W2d Task 7) ──
-- * ORDER. The pin runs BEFORE the division configs lose `shootoutWin/shootoutLoss`: it reads the pre-W2d payer from the
--   division config, split included, so a started stage keeps its split (spec §8: "a started stage of theirs is already
--   pinned with its old W/L payout"). The plan's step order (convert first, pin last) would pin the converted config.
-- * A started stage's points are its OWN `config.points` when it has one (any truthy value, as the loader reads it), an
--   old shape converted through `w2d_legacy_points`; otherwise the sport's pre-W2d payer of the division config. A
--   payer key that equals its fallback is left out (`win.so` absent pays `ot`, then `regulation`, exactly as before),
--   so the public "Points:" line prints no clause the stage never had.
-- * `tie` and `noResult` pay what the sport paid: football, hockey, ice hockey and generic paid the draw for both,
--   carrom paid the draw for a no result, cricket its own `tie`/`noResult` (and a two-innings draw `draw ?? tie`); every
--   other sport paid neither and gets 0. A sport that paid no draw gets no `draw` (the rule covers none).
-- * A shoot-out split that draw-plus-bonus cannot pay (`shootoutLoss` ≠ draw, or a `shootoutWin` below the draw; an ice
--   hockey split ≠ its OT values) is CONVERTED, not refused, and named in a NOTICE: every started stage of that division
--   is already pinned with its exact old payout, and spec §5.4 lets new defaults reach only stages that have not started
--   (greenfield, no alias — no key holds the old split any more). A negative bonus is clamped to 0 (the schema's floor).
-- * A value the pre-W2d code could not have paid (a non-number, a missing required key, an unknown sport, a set map that
--   pays no set score, a stage rule in neither shape — no `base`, and no object `win` and `loss` each with a numeric
--   `regulation`) is REFUSED (22023), naming the row: the migration fails closed rather than pin a guess.
-- * V347 froze each scored fixture's resolved config; the pin reads the LIVE division config. W2c locks a started
--   stage's points fields, so the two agree; a stage whose snapshots pay otherwise — or hold one the pre-W2d payer
--   cannot read — is pinned to the live one and named in a NOTICE. That check is a diagnostic: it never aborts.

-- ═══ 1. The pin columns ═══
alter table stages
  add column table_rules_pinned    jsonb       null,
  add column table_rules_pinned_at timestamptz null,
  add constraint stages_table_rules_pinned_pair
    check ((table_rules_pinned is null) = (table_rules_pinned_at is null)),
  add constraint stages_table_rules_pinned_object
    check (table_rules_pinned is null or jsonb_typeof(table_rules_pinned) = 'object');

comment on column stages.table_rules_pinned is
  'W2d spec §5.4: the table rules the stage is paid and ranked by once started — {points, tiebreakers, crossGroup, sources: {points, tiebreakers, crossGroup}}. Null = not pinned (pending).';
comment on column stages.table_rules_pinned_at is
  'When table_rules_pinned was written; null exactly when it is null.';

-- ═══ 2. Stored lots draws (spec §5.8) ═══
-- Tenant-owned like its sibling stage tables (V375 stage_round_court_tags, V451 stage_round_opens): `org_id` filled from
-- the stage by `set_org_from_parent`, the (stage, org) pair held by the composite FK, RLS forced. `pool_id` carries no
-- FK, as `standings_snapshots.pool_id` (V218) does not: a pool can be rebuilt, and its draw history is the stage's.
create table stage_lots_draws (
  id            uuid        primary key default gen_random_uuid(),
  org_id        uuid        not null,
  stage_id      uuid        not null,
  pool_id       uuid        null,
  members_key   text        not null,
  members       uuid[]      not null,
  drawn_order   uuid[]      not null,
  seed          bigint      not null,
  drawn_at      timestamptz not null default now(),
  superseded_at timestamptz null,
  constraint stage_lots_draws_stage_org_fkey
    foreign key (stage_id, org_id) references stages (id, org_id) on delete cascade,
  -- a residual tie is a class of two or more, and a draw orders exactly that class
  constraint stage_lots_draws_order_is_members
    check (cardinality(members) >= 2
           and cardinality(drawn_order) = cardinality(members)
           and drawn_order @> members and members @> drawn_order)
);

-- one live draw per (stage, pool, member set); the stage-wide table is the nil pool
create unique index stage_lots_draws_live_key
  on stage_lots_draws (stage_id, coalesce(pool_id, '00000000-0000-0000-0000-000000000000'::uuid), members_key)
  where superseded_at is null;
create index stage_lots_draws_org_idx on stage_lots_draws (org_id);

create trigger trg_set_org before insert on stage_lots_draws
  for each row execute function set_org_from_parent('stages', 'stage_id');

alter table stage_lots_draws enable row level security;
alter table stage_lots_draws force  row level security;
create policy stage_lots_draws_tenant on stage_lots_draws for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select, insert, update, delete on stage_lots_draws to app_user;

comment on table stage_lots_draws is
  'W2d spec §5.8: a residual tie''s drawn order, keyed by its member set (members_key: the sorted entrant ids, joined). superseded_at set = history.';

-- ═══ 3. The B1 helpers ═══

-- A table-points value as the pre-W2d schema read it: absent ⇒ `fallback` (the schema's per-key default; null where it
-- had none), absent with no default and `required` ⇒ refused, present and not a number ⇒ refused (a JSON null too).
create or replace function w2d_points_num(v jsonb, fallback jsonb, what text, required boolean)
returns jsonb
  language plpgsql immutable
  set search_path = ${flyway:defaultSchema}, pg_temp as $$
begin
  if v is null then
    if fallback is null and required then
      raise exception 'W2d: % is missing', what using errcode = '22023';
    end if;
    return fallback;
  end if;
  if jsonb_typeof(v) <> 'number' then
    raise exception 'W2d: % is %, not a number', what, v::text using errcode = '22023';
  end if;
  return v;
end $$;

-- The SQL twin of `legacyPointsRule` (packages/engine/src/competition/points.ts), over the W2c shape exactly as W2c's
-- reader took it (`LegacyPointsRule`: non-strict, so stray keys are dropped; `bonuses` absent ⇒ []): `base` becomes
-- `win.regulation` / `draw` / `loss.regulation`; a tie and a no result pay 0 (old `applyPointsRule` paid 0 for both); a
-- shoot-out or overtime win pays as a win (`result`, no split); bonuses and the forfeit row are kept. A value that reader
-- refused is refused here.
create or replace function w2d_legacy_points(old jsonb)
returns jsonb
  language plpgsql immutable
  set search_path = ${flyway:defaultSchema}, pg_temp as $$
declare
  b jsonb;
  f jsonb;
  a jsonb;
  bonuses jsonb := '[]'::jsonb;
  forfeit jsonb;
  rule jsonb;
begin
  if old is null or jsonb_typeof(old) <> 'object' or jsonb_typeof(old -> 'base') is distinct from 'object' then
    raise exception 'W2d: a stage points rule in neither shape: %', coalesce(old::text, 'null') using errcode = '22023';
  end if;
  rule := jsonb_build_object(
    'win',        jsonb_build_object('regulation', w2d_points_num(old #> '{base,win}', null, 'points.base.win', true)),
    'loss',       jsonb_build_object('regulation', w2d_points_num(old #> '{base,loss}', null, 'points.base.loss', true)),
    'draw',       w2d_points_num(old #> '{base,draw}', null, 'points.base.draw', true),
    'tie',        0,
    'noResult',   0,
    'shootoutAs', 'result',
    'unit',       'whole');
  if old ? 'bonuses' then
    if jsonb_typeof(old -> 'bonuses') <> 'array' then
      raise exception 'W2d: points.bonuses is %, not a list', (old -> 'bonuses')::text using errcode = '22023';
    end if;
    for b in select e.value from jsonb_array_elements(old -> 'bonuses') with ordinality as e(value, ord) order by e.ord loop
      if jsonb_typeof(b) <> 'object' or jsonb_typeof(b -> 'when') is distinct from 'string'
         or (b ->> 'when') not in ('loss_margin_lte', 'win_margin_gte', 'score_ratio_gte', 'draw', 'forfeit_win',
                                   'forfeit_loss', 'no_result') then
        raise exception 'W2d: a points bonus W2c refused: %', b::text using errcode = '22023';
      end if;
      bonuses := bonuses || jsonb_build_array(
        jsonb_build_object('when', b -> 'when', 'points', w2d_points_num(b -> 'points', null, 'points.bonuses[].points', true))
        || case when b ? 'param'
                then jsonb_build_object('param', w2d_points_num(b -> 'param', null, 'points.bonuses[].param', true))
                else '{}'::jsonb end);
    end loop;
  end if;
  rule := rule || jsonb_build_object('bonuses', bonuses);
  if old ? 'forfeit' then
    f := old -> 'forfeit';
    if jsonb_typeof(f) <> 'object' then
      raise exception 'W2d: points.forfeit is %, not an object', f::text using errcode = '22023';
    end if;
    forfeit := jsonb_build_object(
      'winnerPoints', w2d_points_num(f -> 'winnerPoints', null, 'points.forfeit.winnerPoints', true),
      'loserPoints',  w2d_points_num(f -> 'loserPoints', null, 'points.forfeit.loserPoints', true));
    if f ? 'awardScore' then
      a := f -> 'awardScore';
      if jsonb_typeof(a) <> 'array' or jsonb_array_length(a) <> 2
         or jsonb_typeof(a -> 0) <> 'number' or jsonb_typeof(a -> 1) <> 'number' then
        raise exception 'W2d: points.forfeit.awardScore is %, not a [number, number] pair', a::text using errcode = '22023';
      end if;
      forfeit := forfeit || jsonb_build_object('awardScore', a);
    end if;
    rule := rule || jsonb_build_object('forfeit', forfeit);
  end if;
  return rule;
end $$;

-- The points `sport` paid before W2d for a division config `cfg`, as an outcome-keyed rule — each module's
-- `standingsDelta` at W2D_BASE, with its schema's defaults (W2D_BASE: football.ts:124-134, 2777-2797; period/kernel.ts
-- 214-224, 1536-1546 and hockey.ts:130 / icehockey.ts:179; cricket.ts:62-70; setbased/kernel.ts:124, 2295-2304, 2577-2581
-- and badminton.ts:28 / tabletennis.ts:30 / volleyball.ts:11; tennis.ts:25 and nested/kernel.ts:193-198;
-- boardgame.ts:61-67; carrom.ts:55-79; generic.ts:44-50):
--   football     win/loss; a shoot-out split only when BOTH shootoutWin and shootoutLoss are set; draw for a draw, a
--                tie and a no result
--   hockey,      win/loss; ot = otWin/otLoss; so = shootoutWin/shootoutLoss (each falls back so → ot → regulation, as
--   icehockey    the kernel's ?? chain did); draw for a draw, a tie and a no result
--   cricket      win/loss, tie, noResult; a draw pays `draw ?? tie`
--   set sports   the pointsMap as `bySetScore` (exact "W-L", else "*"); win/loss = the clean-sweep pair
--   tennis       win/loss
--   boardgame    scoring win/draw/loss, in half-points
--   carrom       win/loss; draw for a draw and a no result
--   generic      w/l; d for a draw, a tie and a no result
create or replace function w2d_pre_points(sport text, cfg jsonb)
returns jsonb
  language plpgsql immutable
  set search_path = ${flyway:defaultSchema}, pg_temp as $$
declare
  k text;
  dflt jsonb;
  p jsonb;
  w jsonb;
  d jsonb;
  l jsonb;
  ow jsonb;
  ol jsonb;
  sw jsonb;
  sl jsonb;
  t jsonb;
  nr jsonb;
  e record;
  sweep jsonb;
  m jsonb := '{}'::jsonb;
  common constant jsonb := '{"shootoutAs": "result", "unit": "whole", "bonuses": []}';
begin
  -- where the sport keeps its table points, and the schema's default when a config holds none
  k := case when sport = 'boardgame' then 'scoring'
            when sport in ('volleyball', 'badminton', 'tabletennis') then 'pointsMap'
            else 'points' end;
  dflt := case sport
    when 'football'    then '{"win": 3, "draw": 1, "loss": 0}'
    when 'hockey'      then '{"win": 3, "draw": 1, "loss": 0}'
    when 'icehockey'   then '{"win": 3, "draw": 1, "loss": 0, "otWin": 2, "otLoss": 1}'
    when 'cricket'     then '{"win": 2, "tie": 1, "noResult": 1, "loss": 0}'
    when 'tennis'      then '{"win": 2, "loss": 0}'
    when 'boardgame'   then '{"win": 2, "draw": 1, "loss": 0}'
    when 'carrom'      then '{"win": 2, "loss": 0, "draw": 1}'
    when 'generic'     then '{"w": 3, "d": 1, "l": 0}'
    when 'volleyball'  then '{"3-2": [2, 1], "*": [3, 0]}'
    when 'badminton'   then '{"*": [2, 0]}'
    when 'tabletennis' then '{"*": [2, 0]}'
  end::jsonb;
  if dflt is null then
    raise exception 'W2d: no pre-W2d points payer for sport %', coalesce(sport, 'null') using errcode = '22023';
  end if;
  if cfg is null or jsonb_typeof(cfg) <> 'object' then
    raise exception 'W2d: a % division config that is no object: %', sport, coalesce(cfg::text, 'null') using errcode = '22023';
  end if;
  p := cfg -> k;
  if p is null then
    p := dflt;
  elsif jsonb_typeof(p) <> 'object' then
    raise exception 'W2d: % % is %, not an object', sport, k, p::text using errcode = '22023';
  end if;

  case sport
  when 'football' then
    w  := w2d_points_num(p -> 'win', '3', 'football points.win', true);
    d  := w2d_points_num(p -> 'draw', '1', 'football points.draw', true);
    l  := w2d_points_num(p -> 'loss', '0', 'football points.loss', true);
    sw := w2d_points_num(p -> 'shootoutWin', null, 'football points.shootoutWin', false);
    sl := w2d_points_num(p -> 'shootoutLoss', null, 'football points.shootoutLoss', false);
    if sw is null or sl is null then
      sw := null;
      sl := null;
    end if;
    return common || jsonb_build_object(
      'win',  jsonb_strip_nulls(jsonb_build_object('regulation', w, 'so', sw)),
      'loss', jsonb_strip_nulls(jsonb_build_object('regulation', l, 'so', sl)),
      'draw', d, 'tie', d, 'noResult', d);
  when 'hockey', 'icehockey' then
    w  := w2d_points_num(p -> 'win', null, sport || ' points.win', true);
    d  := w2d_points_num(p -> 'draw', null, sport || ' points.draw', true);
    l  := w2d_points_num(p -> 'loss', null, sport || ' points.loss', true);
    ow := w2d_points_num(p -> 'otWin', null, sport || ' points.otWin', false);
    ol := w2d_points_num(p -> 'otLoss', null, sport || ' points.otLoss', false);
    sw := w2d_points_num(p -> 'shootoutWin', null, sport || ' points.shootoutWin', false);
    sl := w2d_points_num(p -> 'shootoutLoss', null, sport || ' points.shootoutLoss', false);
    return common || jsonb_build_object(
      'win',  jsonb_strip_nulls(jsonb_build_object('regulation', w, 'ot', ow, 'so', sw)),
      'loss', jsonb_strip_nulls(jsonb_build_object('regulation', l, 'ot', ol, 'so', sl)),
      'draw', d, 'tie', d, 'noResult', d);
  when 'cricket' then
    w  := w2d_points_num(p -> 'win', '2', 'cricket points.win', true);
    t  := w2d_points_num(p -> 'tie', '1', 'cricket points.tie', true);
    nr := w2d_points_num(p -> 'noResult', '1', 'cricket points.noResult', true);
    l  := w2d_points_num(p -> 'loss', '0', 'cricket points.loss', true);
    d  := w2d_points_num(p -> 'draw', null, 'cricket points.draw', false);
    return common || jsonb_build_object(
      'win', jsonb_build_object('regulation', w), 'loss', jsonb_build_object('regulation', l),
      'tie', t, 'noResult', nr, 'draw', coalesce(d, t));
  when 'tennis' then
    w := w2d_points_num(p -> 'win', null, 'tennis points.win', true);
    l := w2d_points_num(p -> 'loss', null, 'tennis points.loss', true);
    return common || jsonb_build_object(
      'win', jsonb_build_object('regulation', w), 'loss', jsonb_build_object('regulation', l), 'tie', 0, 'noResult', 0);
  when 'boardgame' then
    w := w2d_points_num(p -> 'win', '2', 'boardgame scoring.win', true);
    d := w2d_points_num(p -> 'draw', '1', 'boardgame scoring.draw', true);
    l := w2d_points_num(p -> 'loss', '0', 'boardgame scoring.loss', true);
    return common || jsonb_build_object(
      'win', jsonb_build_object('regulation', w), 'loss', jsonb_build_object('regulation', l),
      'draw', d, 'tie', 0, 'noResult', 0, 'unit', 'half');
  when 'carrom' then
    w := w2d_points_num(p -> 'win', '2', 'carrom points.win', true);
    l := w2d_points_num(p -> 'loss', '0', 'carrom points.loss', true);
    d := w2d_points_num(p -> 'draw', '1', 'carrom points.draw', true);
    return common || jsonb_build_object(
      'win', jsonb_build_object('regulation', w), 'loss', jsonb_build_object('regulation', l),
      'draw', d, 'tie', 0, 'noResult', d);
  when 'generic' then
    w := w2d_points_num(p -> 'w', null, 'generic points.w', true);
    d := w2d_points_num(p -> 'd', null, 'generic points.d', true);
    l := w2d_points_num(p -> 'l', null, 'generic points.l', true);
    return common || jsonb_build_object(
      'win', jsonb_build_object('regulation', w), 'loss', jsonb_build_object('regulation', l),
      'draw', d, 'tie', d, 'noResult', d);
  else
    -- volleyball, badminton, tabletennis: every pair a [number, number]; a key that is no set score ("W-L") or "*" was
    -- never matched (the kernel looked up the "won-lost" string), so it is left out; a map with none left paid no win
    for e in select * from jsonb_each(p) loop
      if jsonb_typeof(e.value) <> 'array' or jsonb_array_length(e.value) <> 2
         or jsonb_typeof(e.value -> 0) <> 'number' or jsonb_typeof(e.value -> 1) <> 'number' then
        raise exception 'W2d: % pointsMap["%"] is %, not a [number, number] pair', sport, e.key, e.value::text
          using errcode = '22023';
      end if;
      sweep := coalesce(sweep, e.value);
      if e.key ~ '^([0-9]+-[0-9]+|[*])$' then
        m := m || jsonb_build_object(e.key, e.value);
      end if;
    end loop;
    if m = '{}'::jsonb then
      raise exception 'W2d: % pointsMap pays no set score: %', sport, p::text using errcode = '22023';
    end if;
    -- the clean-sweep pair: "*", else the map's first entry (setbased/kernel.ts:2295-2296)
    sweep := coalesce(p -> '*', sweep);
    return common || jsonb_build_object(
      'win', jsonb_build_object('regulation', sweep -> 0), 'loss', jsonb_build_object('regulation', sweep -> 1),
      'bySetScore', m, 'tie', 0, 'noResult', 0);
  end case;
end $$;

-- Each sport's `defaultTiebreakers` at W2D_BASE, as literals (the code lists change in this release). The cascade the
-- table read used was `division.tiebreakers ?? module.defaultTiebreakers` for EVERY stage kind, Swiss included
-- (W2D_BASE competition.ts:492-494; plan PF-1).
create or replace function w2d_pre_cascade(sport text)
returns jsonb
  language plpgsql immutable
  set search_path = ${flyway:defaultSchema}, pg_temp as $$
declare
  list jsonb;
begin
  list := case sport
    when 'football'    then '["points", "h2h_points", "h2h_diff", "h2h_for", "diff", "for", "fair_play", "lots"]'
    when 'hockey'      then '["points", "diff", "for", "h2h_points", "seed"]'
    when 'icehockey'   then '["points", "h2h_points", "h2h_diff", "h2h_for", "diff", "for", "seed"]'
    when 'cricket'     then '["points", "wins", "nrr", "h2h_points", "seed"]'
    when 'tennis'      then '["points", "set_ratio", "game_ratio", "h2h_points", "seed"]'
    when 'volleyball'  then '["points", "wins", "set_ratio", "point_ratio", "h2h_points"]'
    when 'badminton'   then '["points", "wins", "set_ratio", "point_ratio", "h2h_points"]'
    when 'tabletennis' then '["points", "wins", "set_ratio", "point_ratio", "h2h_points"]'
    when 'boardgame'   then '["points", "buchholz_cut1", "buchholz", "sberger", "direct", "wins", "lots"]'
    when 'carrom'      then '["points", "wins", "set_ratio", "board_ratio", "point_ratio", "h2h_points", "lots"]'
    when 'generic'     then '["points", "diff", "for", "h2h_points", "lots"]'
  end::jsonb;
  if list is null then
    raise exception 'W2d: no pre-W2d tie-break list for sport %', coalesce(sport, 'null') using errcode = '22023';
  end if;
  return list;
end $$;

-- A football or hockey division config off the retired shoot-out split (spec §5.3, PS-1): `soBonus = shootoutWin − draw`
-- (a draw-plus-bonus shoot-out pays draw + soBonus to its winner and the draw to its loser), the old keys dropped. Ice
-- hockey books a shoot-out as a result and its schema has no soBonus: the keys are dropped and a shoot-out pays the OT
-- values (PS-1d). Anything else is returned as it is. A split the new shape cannot pay is converted and named (header).
create or replace function w2d_drop_shootout_split(sport text, cfg jsonb)
returns jsonb
  language plpgsql immutable
  set search_path = ${flyway:defaultSchema}, pg_temp as $$
declare
  p jsonb := cfg -> 'points';
  sw jsonb;
  sl jsonb;
  d jsonb;
  bonus numeric;
begin
  if sport is null or sport not in ('football', 'hockey', 'icehockey') or jsonb_typeof(p) is distinct from 'object'
     or not (p ?| array['shootoutWin', 'shootoutLoss']) then
    return cfg;
  end if;
  sw := w2d_points_num(p -> 'shootoutWin', null, sport || ' points.shootoutWin', false);
  sl := w2d_points_num(p -> 'shootoutLoss', null, sport || ' points.shootoutLoss', false);
  if sport = 'icehockey' then
    if (sw is not null and sw is distinct from coalesce(p -> 'otWin', p -> 'win'))
       or (sl is not null and sl is distinct from coalesce(p -> 'otLoss', p -> 'loss')) then
      raise notice 'W2d shoot-out split (%): a shoot-out now pays the overtime values, which differ from the split: %', sport, p::text;
    end if;
    return jsonb_set(cfg, '{points}', p - 'shootoutWin' - 'shootoutLoss');
  end if;
  d := w2d_points_num(p -> 'draw', '1', sport || ' points.draw', true);
  if sl is not null and sl is distinct from d then
    raise notice 'W2d shoot-out split (%): shootoutLoss differs from the draw, and a draw-plus-bonus shoot-out pays its loser the draw: %', sport, p::text;
  end if;
  if sw is not null and not (p ? 'soBonus') then
    bonus := (sw #>> '{}')::numeric - (d #>> '{}')::numeric;
    if bonus < 0 then
      raise notice 'W2d shoot-out split (%): shootoutWin is below the draw, so the bonus is clamped to 0: %', sport, p::text;
      bonus := 0;
    end if;
    p := p || jsonb_build_object('soBonus', bonus);
  end if;
  return jsonb_set(cfg, '{points}', p - 'shootoutWin' - 'shootoutLoss');
end $$;

-- ═══ 4. The B1 pin (spec §5.4 "Migration pin", §8) ═══
-- Every stage that has started and has no pin gets `{points, tiebreakers, crossGroup, sources}` and `now()`; returns how
-- many. Idempotent (`table_rules_pinned is null`). Runs as its caller (RLS applies): the migration pins every org's.
create or replace function w2d_pin_started_stages()
returns integer
  language plpgsql volatile
  set search_path = ${flyway:defaultSchema}, pg_temp as $$
declare
  r record;
  pts jsonb;
  tbs jsonb;
  n integer := 0;
  drift text[] := '{}';
begin
  for r in
    select s.id, s.config -> 'points' as own, d.id as division_id, d.sport_key, d.config as cfg, d.tiebreakers
    from stages s
    join divisions d on d.id = s.division_id
    where s.status in ('active', 'complete') and s.table_rules_pinned is null
    order by s.id
    for update of s
  loop
    -- the stage's own rule, as the loader tests it (competition.ts `stage.config?.points ?`): a falsy value is none
    if r.own is null or r.own in ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb) then
      pts := w2d_pre_points(r.sport_key, r.cfg);
      -- a diagnostic, never a refusal: a historical snapshot the pre-W2d payer cannot read is named, not fatal
      begin
        if exists (select 1 from fixtures f
                   where f.stage_id = r.id and jsonb_typeof(f.config_snapshot) = 'object'
                     and w2d_pre_points(r.sport_key, f.config_snapshot) is distinct from pts) then
          drift := drift || r.id::text;
        end if;
      exception when sqlstate '22023' then
        drift := drift || r.id::text;
      end;
    elsif jsonb_typeof(r.own) <> 'object' then
      raise exception 'W2d pin: stage % has a points rule that is no object: %', r.id, r.own::text using errcode = '22023';
    elsif r.own ? 'base' then
      pts := w2d_legacy_points(r.own);
    elsif jsonb_typeof(r.own -> 'win') = 'object' and jsonb_typeof(r.own #> '{win,regulation}') = 'number'
          and jsonb_typeof(r.own -> 'loss') = 'object' and jsonb_typeof(r.own #> '{loss,regulation}') = 'number' then
      -- the outcome-keyed shape (W2d PointsRule): its two required payouts are there
      pts := r.own;
    else
      raise exception 'W2d pin: stage % has a points rule in neither shape (no base, no win/loss regulation): %',
        r.id, r.own::text using errcode = '22023';
    end if;
    if r.tiebreakers is null or jsonb_typeof(r.tiebreakers) = 'null' then
      tbs := w2d_pre_cascade(r.sport_key);
    elsif jsonb_typeof(r.tiebreakers) = 'array' then
      tbs := r.tiebreakers;
    else
      raise exception 'W2d pin: division % has a tie-break list that is no list: %', r.division_id, r.tiebreakers::text
        using errcode = '22023';
    end if;
    update stages
       set table_rules_pinned = jsonb_build_object(
             'points',      pts,
             'tiebreakers', tbs,
             -- the cross-group order, hard-coded at W2D_BASE (progression.ts:573-575): its source is the migration too,
             -- never the stage's own, so a later order save re-derives it (T9 re-review N2)
             'crossGroup',  '["points", "diff", "for", "wins"]'::jsonb,
             'sources',     '{"points": "migrated", "tiebreakers": "migrated", "crossGroup": "migrated"}'::jsonb),
           table_rules_pinned_at = now()
     where id = r.id;
    n := n + 1;
  end loop;
  if cardinality(drift) > 0 then
    raise notice 'W2d pin: % started stage(s) scored fixtures under a points config the live division does not pay (or one the pre-W2d payer cannot read); each is pinned to the live one: %',
      cardinality(drift), array_to_string(drift, ', ');
  end if;
  return n;
end $$;


-- ═══ 5. The stage points rules on the public and console reads (W2d Task 2; Task 7 PF-3) ═══
-- `stage_qualification_meta` (V414) rebuilt `points_rule` from the OLD keys only, so a rule saved in the new shape
-- reached both of its readers — `public_stages_v` (division page, hub, embed) and the organiser console
-- (usecases/stage-qualification.ts, which calls the function directly) — as `{bonuses, forfeit}`: no qualification
-- status, no "Points:" clause, no walkover-score clause. The fold was unaffected (it reads `config.points` itself).
--
-- One rule leaves the function, published by `stage_points_rule_published` (below):
-- * `points_rule` — the stage's OWN `config.points`, as V414 published it. The format line prints it as the stage's own
--   points ("a stage that plays the division's format gets nothing"), so a pin must never reach it: a started stage
--   with no rule of its own still prints no points line.
-- The rule the TABLE is paid by (the pin, else the live layers) is the loader's alone (`table-rules.ts`): a second,
-- SQL derivation of it disagreed with the loader on a pending stage with no rule of its own (T9 review m3), so it is not
-- published. The function and the view keep V414's columns in V414's order; both are dropped and re-created here.
--
-- The published shape, for both: every key the outcome-keyed PointsRule reads. The W2c `base` is not published: step 6
-- converts every stored one, and the engine no longer reads the shape (W2d Task 9 retired the two together). The same
-- rule as V414 holds at every level: only the keys PointsRule reads, never an organiser's stray keys (PointsRule is a
-- non-strict z.object, and createStages stores the raw config); a key that is absent stays absent (jsonb_strip_nulls); a
-- `bySetScore` key is kept only when it is a set score ("W-L") or "*", the grammar PointsRule accepts. The values
-- themselves are not sensitive: the table already prints the points they produce.
create or replace function stage_points_rule_published(p jsonb)
returns jsonb
  language sql immutable
  set search_path = ${flyway:defaultSchema}, pg_temp as $$
  select
    case when jsonb_typeof(p) = 'object' then jsonb_strip_nulls(jsonb_build_object(
      -- the W2d outcome-keyed shape (engine competition/points.ts PointsRule, spec §5.3)
      'win', case when jsonb_typeof(p -> 'win') = 'object' then jsonb_build_object(
                'regulation', p #> '{win,regulation}',
                'ot',         p #> '{win,ot}',
                'so',         p #> '{win,so}') end,
      'loss', case when jsonb_typeof(p -> 'loss') = 'object' then jsonb_build_object(
                'regulation', p #> '{loss,regulation}',
                'ot',         p #> '{loss,ot}',
                'so',         p #> '{loss,so}',
                'unplayed',   p #> '{loss,unplayed}') end,
      'draw',       p -> 'draw',
      'soBonus',    p -> 'soBonus',
      'shootoutAs', p -> 'shootoutAs',
      'tie',        p -> 'tie',
      'noResult',   p -> 'noResult',
      'bySetScore', case when jsonb_typeof(p -> 'bySetScore') = 'object' then (
                select jsonb_object_agg(k.key, k.value)
                from jsonb_each(p -> 'bySetScore') as k(key, value)
                where k.key ~ '^([0-9]+-[0-9]+|[*])$') end,
      'unit',       p -> 'unit',
      'bonuses', case when jsonb_typeof(p -> 'bonuses') = 'array' then (
                select coalesce(jsonb_agg(jsonb_build_object(
                         'when',   b.value -> 'when',
                         'param',  b.value -> 'param',
                         'points', b.value -> 'points') order by b.ord), '[]'::jsonb)
                from jsonb_array_elements(p -> 'bonuses') with ordinality as b(value, ord)) end,
      'forfeit', case when jsonb_typeof(p -> 'forfeit') = 'object' then jsonb_build_object(
                'winnerPoints', p #> '{forfeit,winnerPoints}',
                'loserPoints',  p #> '{forfeit,loserPoints}',
                'awardScore',   p #> '{forfeit,awardScore}') end)) end
$$;

revoke all on function stage_points_rule_published(jsonb) from public;
grant execute on function stage_points_rule_published(jsonb) to app_user;

drop view public_stages_v;
drop function stage_qualification_meta(uuid);

-- V414's function verbatim, but for the rule it publishes (`stage_points_rule_published`).
create or replace function stage_qualification_meta(p_stage_id uuid)
returns table (
  qualify_count int,
  qualify_per_group boolean,
  next_stage_name text,
  swiss_rounds int,
  points_rule jsonb,
  has_rank_overrides boolean
)
  language sql stable security definer
  set search_path = ${flyway:defaultSchema}, pg_temp as $$
  with src as (
    select s.id, s.division_id, s.seq, s.kind, s.config,
           s.config -> 'points' as points,
           coalesce(jsonb_typeof(s.config -> 'cross_feeds') = 'array'
                    and s.config -> 'cross_feeds' <> '[]'::jsonb, false) as feeds_by_result
    from stages s where s.id = p_stage_id
  ),
  rules as (
    select d.id as dest_id,
           d.seq as dest_seq,
           d.name as dest_name,
           r.value ->> 'kind' as kind,
           case when jsonb_typeof(r.value -> 'from') = 'number' and (r.value ->> 'from') ~ '^[0-9]{1,6}$'
                then (r.value ->> 'from')::int end as from_n,
           case when jsonb_typeof(r.value -> 'to') = 'number' and (r.value ->> 'to') ~ '^[0-9]{1,6}$'
                then (r.value ->> 'to')::int end as to_n,
           case when jsonb_typeof(r.value -> 'n') = 'number' and (r.value ->> 'n') ~ '^[0-9]{1,6}$'
                then (r.value ->> 'n')::int end as n_n,
           count(*) over (partition by d.id) as dest_rules
    from src
    join stages d on d.division_id = src.division_id and d.progression is not null
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(d.progression -> 'sources') = 'array' then d.progression -> 'sources'
           else '[]'::jsonb end
    ) as so(value)
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(so.value -> 'take') = 'array' then so.value -> 'take'
           else '[null]'::jsonb end
    ) as r(value)
    where (so.value ->> 'stage' = 'previous'
           and src.seq = (select max(p.seq) from stages p
                          where p.division_id = d.division_id and p.seq < d.seq))
       or (so.value -> 'stage' ->> 'stageId') = src.id::text
  ),
  cut as (
    select * from rules
    where (kind = 'rankRange' and from_n = 1) or kind = 'topNPerGroup'
  ),
  forecast as (
    select case when c.kind = 'rankRange' then c.to_n else c.n_n end as qualify_count,
           c.kind = 'topNPerGroup' as qualify_per_group,
           c.dest_name as next_stage_name
    from cut c
    where (select count(*) from cut) = 1
      and c.dest_rules = 1
      and not exists (
        select 1 from rules w
        where not coalesce(
          (w.kind = 'rankRange' and w.from_n >= 1 and w.to_n >= w.from_n)
          or (w.kind = 'topNPerGroup' and w.n_n >= 1),
          false))
      and not exists (
        select 1
        from stages o
        cross join lateral jsonb_array_elements(
          case when jsonb_typeof(o.config -> 'cross_feeds') = 'array' then o.config -> 'cross_feeds'
               else '[]'::jsonb end
        ) as xf(value)
        where o.division_id = (select s.division_id from src s)
          and xf.value -> 'to_stage_seq' = to_jsonb(c.dest_seq))
  )
  select f.qualify_count,
         coalesce(f.qualify_per_group, false),
         f.next_stage_name,
         case when src.kind = 'swiss'
                   and jsonb_typeof(src.config -> 'rounds') = 'number'
                   and (src.config ->> 'rounds') ~ '^[0-9]{1,6}$'
              then (src.config ->> 'rounds')::int end,
         stage_points_rule_published(src.points),
         coalesce(jsonb_typeof(src.config -> 'rank_overrides') = 'array'
                  and src.config -> 'rank_overrides' <> '[]'::jsonb, false)
  from src
  left join forecast f on not src.feeds_by_result
$$;

revoke all on function stage_qualification_meta(uuid) from public;
grant execute on function stage_qualification_meta(uuid) to app_user;

-- V414's columns in V414's order (V233's six, then V414's appended six). The visibility gate is copied verbatim from
-- V233; the grant is V239's.
create view public_stages_v as
  select st.id, st.division_id, st.seq, st.kind, st.name, st.status,
         q.qualify_count, q.qualify_per_group, q.next_stage_name, q.swiss_rounds, q.points_rule,
         q.has_rank_overrides
  from stages st
  join divisions d    on d.id = st.division_id
  join competitions c on c.id = d.competition_id
  cross join lateral stage_qualification_meta(st.id) q
  where c.visibility in ('public','unlisted');

grant select on public_stages_v to app_user;

-- ═══ 6. The data steps (B1), in one block ═══
-- 1. Pin every started stage (before step 3 removes the shoot-out split the pin reads), then hold the invariant the W2d
--    resolver throws on: no stage is active or complete without a pin. 2. Convert every old-shape stage rule, whatever
--    the stage's status (a pending stage keeps it as its own rule; new defaults still reach it). 3. Move the football,
--    hockey and ice hockey division configs off the shoot-out split. 4. The same for an organisation's own sport variant
--    (W2d Task 9, T7 review m10): its cfg is copied into every division created from it, so a split left there would
--    seed a division config the W2d schema no longer reads. The system presets (org_id null) are written by
--    `sync:sports` from the code, which carries no split.
do $$
declare
  pinned integer;
  unpinned integer;
  stage_rules integer;
  division_cfgs integer;
  variant_cfgs integer;
begin
  pinned := w2d_pin_started_stages();
  select count(*) into unpinned from stages where status in ('active', 'complete') and table_rules_pinned is null;
  if unpinned > 0 then
    raise exception 'W2d B1: % started stage(s) left unpinned', unpinned;
  end if;

  update stages
     set config = jsonb_set(config, '{points}', w2d_legacy_points(config -> 'points'))
   where jsonb_typeof(config -> 'points') = 'object' and config -> 'points' ? 'base';
  get diagnostics stage_rules = row_count;

  update divisions
     set config = w2d_drop_shootout_split(sport_key, config)
   where sport_key in ('football', 'hockey', 'icehockey')
     and jsonb_typeof(config -> 'points') = 'object'
     and config -> 'points' ?| array['shootoutWin', 'shootoutLoss'];
  get diagnostics division_cfgs = row_count;

  update sport_variants
     set config = w2d_drop_shootout_split(sport_key, config)
   where org_id is not null
     and sport_key in ('football', 'hockey', 'icehockey')
     and jsonb_typeof(config -> 'points') = 'object'
     and config -> 'points' ?| array['shootoutWin', 'shootoutLoss'];
  get diagnostics variant_cfgs = row_count;

  raise notice 'W2d B1: pinned % started stage(s); converted % old-shape stage rule(s), % division config(s) and % organisation sport variant(s) off the shoot-out split',
    pinned, stage_rules, division_cfgs, variant_cfgs;
end $$;

-- ═══ 7. The B1 helpers go (they exist for the data steps above alone) ═══
-- After this release the start path is the only pin writer; a manual `select w2d_pin_started_stages()` would pin any
-- unpinned started stage with PRE-W2d payers. `stage_points_rule_published` stays: the read functions call it.
drop function w2d_pin_started_stages();
drop function w2d_drop_shootout_split(text, jsonb);
drop function w2d_pre_cascade(text);
drop function w2d_pre_points(text, jsonb);
drop function w2d_legacy_points(jsonb);
drop function w2d_points_num(jsonb, jsonb, text, boolean);
