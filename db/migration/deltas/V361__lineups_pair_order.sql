-- V361 — extend `lineups` with `pair_order` (S12/#421 pass D).
--
-- Mirrors the engine's `LineupSlot.pairOrder` (packages/engine/src/core/
-- types.ts, `z.number().int().positive().optional()`) exactly. It names
-- which of a pair entrant's two bound members was NAMED FIRST — the fixed
-- rotation for tennis (ITF) and table tennis (ITTF 2.8.3) doubles serve
-- order is derivable from the service history only once you know which
-- partner started it, and that is a declaration, not something `order_no`
-- can carry (a five-pair table-tennis tie has five first-named players, so
-- `order_no` alone cannot mean "pair leader" — see
-- packages/engine/src/sports/squad-state.ts's own doc comment).
--
-- Additive, greenfield, nullable, no backfill: every existing lineup row
-- predates this column and singles/team fixtures never set it, so null
-- (no declared order) is the honest default rather than a chosen one.
-- `check (pair_order is null or pair_order > 0)` mirrors the engine's
-- `.positive()` at the DB boundary — no index, since the column is never
-- filtered or joined on (read whole-row by fixture_id/entrant_id, already
-- indexed via the existing lineups primary access path).
--
-- Was V360 before this session started (per S12's own dispatch brief); a
-- concurrent, unrelated merge (#554, P5/D4a stage-progression seeding) took
-- V360 while this pass was running. Re-verified against
-- `db/migration/deltas/` at write time rather than trusting the brief.
alter table lineups
  add column pair_order integer
  check (pair_order is null or pair_order > 0);
