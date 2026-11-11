-- V503 — Title sponsor poster: an optional 4:5 poster per sponsor (renumbered at merge: rename the file AND this line).
--
-- Spec: docs/superpowers/specs/2026-11-11-title-sponsor-hero-poster-design.md §6.1 (plan Task 1). A Title sponsor shows
-- its poster in the public competition hero (a panel from 768 up, a band below); a sponsor with no poster shows its logo
-- card instead, so the column is nullable with no default and needs no backfill (greenfield schema).
--
-- `poster_path` holds the PUBLIC CDN URL, the same way `logo_path` does despite its name (D13). Unlike `logo_path` it is
-- guarded here as well as at both zod write schemas: next/image throws on a relative src that is not `/`-rooted, so a
-- value that is not an absolute http(s) URL of at most 500 characters must never be stored. The zod schemas are the
-- first guard (a 400 with a message); this CHECK is the second, for any writer that skips them.
--
-- RLS and grants on `sponsors` are table-level, so a new column needs no new grant or policy.
-- =============================================================================

alter table sponsors add column poster_path text null;
alter table sponsors add constraint sponsors_poster_path_check
  check (poster_path is null or (poster_path ~* '^https?://' and char_length(poster_path) <= 500));
