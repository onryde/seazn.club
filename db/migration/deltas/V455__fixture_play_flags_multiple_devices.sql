-- V455 — fixture_play_flags learns `multiple_devices` (T17B fix 2, D9).
--
-- Renumber at merge if main has moved past. V443 is skipped on purpose: the
-- W2c wave claimed it (controller ruling 2026-10-14), and flyway accepts the
-- gap on this branch.
--
-- Measured live on staging (game JTcfKXow): a player played White to mate
-- from a tab whose camera was DENIED while a second White tab of theirs had
-- its camera on for the whole match. The sweep's job-5 camera report unions
-- every connection of a player, so it rightly saw no camera off — and so
-- said nothing. The ruling: flag it, never block it. When one player had MORE
-- THAN ONE connection at the same time inside the match, job 5 writes a
-- `multiple_devices` flag naming when and how many (sweep.ts; the pure
-- reading is match-camera-off.ts's concurrentConnections). Like every flag it
-- is evidence for the organiser (design D10): closing it changes no result.
--
-- Expand-only: the CHECK widens by one value under its own name, so every
-- existing row still passes and `fixture_play_flags_kind_check` stays the name
-- a refusal reports.
alter table fixture_play_flags drop constraint fixture_play_flags_kind_check;
alter table fixture_play_flags add constraint fixture_play_flags_kind_check
  check (kind in ('camera_lost', 'out_of_band_play', 'camera_connection_problems', 'multiple_devices'));
