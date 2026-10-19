-- V465 — Relay Release 2, R2006 (owner ruling 2026-10-19, "Option C"): the fixture's stream MODE is a stored setting.
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
-- Numbered V465: V463 is W2c's (feat/format-matrix-w2c, unmerged) and V464 is PR #991's (feat/claim-email-signin). The
-- required merge order is V463 (W2c) → V464 (#991) → V465 (this, #989), strictly ascending with no prod tag cut in
-- between — Flyway runs without outOfOrder, so a lower number landing after this one resolves IGNORED and every later
-- validate fails. The PR body says so.
alter table fixture_stream_settings
  add column stream_mode text null check (stream_mode in ('composed', 'passthrough'));
