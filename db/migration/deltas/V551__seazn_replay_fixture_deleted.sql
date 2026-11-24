-- V551 — a third reason a Seazn replay is deleted: its fixture was (Seazn-hosted video, Phase 3, Task 31b; T23 review G1).
-- Numbered after the claims of 2026-11-23: V544/V547 billing, V548 plan-limits, V549/V550 online chess (all unmerged). This
-- branch's delivered-minutes table is V552 (renumbered from V546 at the 2026-11-24 rebase); the two do not depend on each other.
--
-- fixture_video_replays.fixture_id is ON DELETE SET NULL (V542): a fixture deleted by a format change, a stage rebuild or a
-- division delete leaves its replay rows with no fixture. The public view inner-joins fixtures, so such a replay plays nowhere,
-- while its copy on the replay host stays stored and billed. The daily sweep (relay-sweep.ts 7e, seazn-cost.ts
-- `purgeFixturelessReplays`) now deletes every such row as the organiser's delete does, and records why: `fixture_deleted`.
--
-- The CHECK is re-declared under its own name (V542 declared it inline, so Postgres named it
-- fixture_video_replays_deleted_reason_check), so a refusal still names the column. Every existing row holds organiser,
-- org_deleted or null, which the wider list admits: the re-validation cannot fail.
alter table fixture_video_replays
  drop constraint fixture_video_replays_deleted_reason_check,
  add constraint fixture_video_replays_deleted_reason_check
    check (deleted_reason in ('organiser','org_deleted','fixture_deleted'));
