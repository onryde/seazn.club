-- V553 — the organisation's Seazn switch (Seazn-hosted video, Phase 4, Task 33). V547 is billing's, V548 plan-limits', V549 and
-- V550 online chess's (all unmerged); V551 and V552 are this branch's. The tests find this file by name, never by number.
--
-- One switch per organisation, on its Seazn destination row (V541), not on organizations: every reader that decides whether Seazn
-- is offered already reads org_stream_targets alone (usecases/stream-targets.ts seaznWhere), so no reader needs a join.
--
-- Default ON (owner ruling 2026-11-23): the column default fills every row that exists and every row the V541 trigger makes, so no
-- backfill is owed. Off gates only NEW Seazn picks and starts; a live Seazn session, its recordings and its replays never read it
-- (and neither do the measurement and the sweeps). SEAZN_HOSTED_LIVE (relay/config.ts) stays the master: with it off the row is
-- hidden whatever this column says.
--
-- Only the Seazn row may be off: a pasted or connected destination is offered for as long as it is not archived, so `offered` off
-- on any other kind is refused here by a named check rather than left meaning nothing.
--
-- RLS: unchanged. org_stream_targets keeps V410's enable + force with no policy; a new column needs no grant of its own.
alter table org_stream_targets
  add column offered boolean not null default true,
  add constraint org_stream_targets_offered_seazn_only check (kind = 'seazn' or offered);
