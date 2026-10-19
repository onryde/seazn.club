-- V466 — Relay Release 2, R2006 (owner ruling 2026-10-19, "Option C"): the fixture's stream MODE is a stored setting.
--
-- The score is the DEFAULT: a stream goes out with the score composited whenever this deployment can run a composed
-- session, and "Camera only" is the organiser's explicit choice. Every start path reads the same stored answer — the
-- organiser's Go live (the panel opens on it), the phone operator's own start and the automatic start (both server-side,
-- through stream-codes.ts `startModeFor`) — so the three can never stream different things for one match.
--
-- `stream_mode` null means "the default" (lib/stream-settings.ts `effectiveStreamMode`: composed when available, else
-- passthrough), `passthrough` is the organiser's "Camera only", and `composed` is "Add the score back". A stored
-- `composed` on a deployment that cannot run one still streams the camera: the setting is a preference, availability is
-- the deployment's (drivers.ts `composedUnavailable()`), and the organiser is never blocked.
--
-- `revision` (PR #989 review) orders every read of the row against every other: the organiser's panel folds a page
-- read or a save's answer in only when its revision is HIGHER than the one it holds, so a stale refresh never puts an
-- older choice back. It is a counter, not a clock: every writer of a column a read returns with it (stream-codes.ts —
-- the pick, the switch, the mode, the style, the timing and the A12 Stop stamp) sets `revision = revision + 1` in its
-- `on conflict do update`, which runs under the row lock, and an insert writes 1 — strictly increasing in commit order,
-- with no tie and nothing a stepped DB clock can reverse. `updated_at` stays an audit stamp. The auto-start bookkeeping
-- updates (stream-auto.ts, stream-sessions.ts) move only `auto_start_*`, which no revisioned read returns, and leave it.
-- 0 covers every row written before this migration: any write lands above it.
--
-- Numbered V466: main's max is V465 (#992, merged). Flyway runs without outOfOrder, so this must stay ABOVE main's max
-- at merge time — a lower number landing after a higher one resolves IGNORED and every later validate fails. If
-- something higher lands first, renumber again. The PR body says so.
alter table fixture_stream_settings
  add column stream_mode text null check (stream_mode in ('composed', 'passthrough')),
  add column revision bigint not null default 0;
