-- D1a (P4): stamp a competition created via POST /competitions/from-template
-- with which curated catalog template + version built it. Provenance/
-- analytics only — no runtime lookup joins on these, so no index.
--
-- No FK to a `templates` table: the catalog is curated in code
-- (apps/web/src/server/templates/catalog/*.json), not a DB table, and a
-- competition must keep its provenance even after a template is pruned from
-- the catalog (catalog governance: "old versions stay in git history only").
-- A CHECK against the current catalog's keys would break that on every
-- catalog edit, so this stays a bare nullable text/int pair.
alter table competitions add column if not exists template_key text;
alter table competitions add column if not exists template_version int check (template_version > 0);
