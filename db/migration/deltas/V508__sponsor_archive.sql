-- V508 — archive a sponsor: hidden everywhere, every record kept (renumbered at merge: rename the file AND this line).
-- Spec: docs/superpowers/specs/2026-11-11-sponsor-archive-design.md §6.1.
alter table sponsors add column archived_at timestamptz null;
