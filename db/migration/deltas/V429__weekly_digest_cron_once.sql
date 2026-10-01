-- At most one CRON-originated weekly digest per org per ISO week (UTC).
-- The weekly schedule used to be the only guarantee (P3/D7 made
-- generateWeeklyDigest non-idempotent and V358 exempted weekly_digest from
-- org_posts_auto_once); a scheduler retry or double fire therefore drafted a
-- duplicate per org. Console presses carry no `cron_week` key, so this index
-- never sees them and they stay unlimited, as P3/D7 chose.
-- Spec: docs/superpowers/specs/2026-09-28-cloudflare-cron-triggers-design.md §5, §12.5.
create unique index if not exists org_posts_digest_cron_once
  on org_posts (org_id, (auto_source ->> 'cron_week'))
  where (auto_source ->> 'trigger') = 'weekly_digest'
    and auto_source ? 'cron_week';
