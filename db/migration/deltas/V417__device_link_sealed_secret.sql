-- =============================================================================
-- Scorer sheets §4.1 (design 2026-09-23): a device link can be re-shown.
--
-- `secret_enc` is the plaintext dl_ secret sealed under DEVICE_LINK_KEK
-- (server/relay/crypto.ts sealWith). `token_hash` stays the ONLY lookup path —
-- nothing ever searches by the sealed value. A reprinted sheet and a console
-- hand-over open this column and hand back the SAME secret, so printing never
-- kills a sheet already on a court.
--
-- `expires_at` becomes nullable: a sealed link lives until its fixture is over
-- (the scoring path refuses it once the result is carried forward, and the
-- fixture's finalized/cancelled locks stand). Legacy hash-only rows keep their
-- end-of-day expiry and are replaced the first time ensureDeviceLink meets them.
-- =============================================================================
alter table device_links add column if not exists secret_enc bytea null;
alter table device_links alter column expires_at drop not null;
