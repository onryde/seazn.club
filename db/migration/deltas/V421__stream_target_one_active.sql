-- V421 — Streaming R1: one live session per DESTINATION.
--
-- Two parts, one idea: a destination is ONE row per org, and one
-- row carries at most ONE live session.
--
-- ─── 1. One live session per target row ────────────────────────────────────
-- The gap: org_stream_targets is per ORG with no court or fixture binding and
-- fixture_stream_sessions.target_id is NOT NULL (V410), so two concurrent
-- sessions on two DIFFERENT fixtures could name the SAME target and push one
-- RTMPS key. YouTube accepts one broadcast per key: the second push is refused
-- or fights the first, and the organiser reads "the stream did not start" with
-- nothing in our data explaining why. Found while answering the court-bound
-- device scenario (specs/2026-09-05-stream-overlay-prompts/
-- _SCENARIO-2026-09-27-court-bound-device.md, gap item 2) and directed into
-- Task 10 by the owner on 2026-09-27.
--
-- A FORWARD delta, not an amend: V410 is merged (PR #812, merge b392be909) and
-- Flyway refuses an edited applied migration.
--
-- The predicate is the SAME five states as
-- fixture_stream_sessions_one_active and as the domain's ACTIVE_STATES
-- (server/relay/domain/session.ts) — one authority; a state added there owes an
-- edit here, which stream-sessions.test.ts's G-T5 pins by deriving its
-- expectation from ACTIVE_STATES / TERMINAL_STATES rather than a typed list.
--
-- NULLS DISTINCT carries no weight here: target_id is NOT NULL, unlike
-- one_active's nullable fixture_id (V410 `on delete set null`), where nulls
-- never collide by design. Do not "tidy" a nulls clause onto this index.
--
-- Creating this index FAILS with 23505 if any database already holds two
-- non-terminal sessions on one target. Task 10 is the first writer of these
-- rows, so no environment holds one — and if a real database ever refuses it,
-- that is a live double-booking to resolve by hand. This migration MUST NOT
-- delete or repair rows to get itself applied: fixture_stream_sessions rows are
-- joined by money (org_stream_credits consume rows) and by retained paid
-- Cloudflare inputs.
--
-- The index is only as safe as what drives a stuck session terminal: the
-- domain's expiry policy (expiry.ts `evaluate`), the daily sweep (Task 12), and
-- the lazy expiry the start attempt itself runs over a holder. Without those a
-- transient crash would hold a paid destination forever.
create unique index fixture_stream_sessions_one_active_target
  on fixture_stream_sessions (target_id)
  where state in ('requested','provisioning','warming','live','ending');

-- ─── 2. One target row per destination (owner ruling A19 + A19b, 2026-09-28) ─
-- Statement 1 holds per ROW; without this, one org could save the same url +
-- stream key twice and run two sessions on two rows that are one YouTube
-- broadcast slot. dest_fingerprint is HMAC-SHA256 (64 lower-hex) under a key
-- DERIVED from RELAY_KEK, over the identity form of the url (the scheme-default
-- port dropped — lib/stream-destinations.ts destinationIdentity) and the
-- stream key; server/relay/crypto.ts fingerprintDestination is its only
-- producer and secret-columns.ts insertStreamTarget its only writer, which
-- answers a duplicate with the EXISTING row (`on conflict … do nothing`, then a
-- read), never a second sealed copy.
--
-- KEYED on purpose: the column is plaintext, and a bare hash of (url, key)
-- would let anyone holding the table test stream-key guesses offline.
--
-- Per ORG, not global: the owner ruled a second org holding the same key
-- allowed. And the CHECK means the column can never hold a plaintext url or key.
--
-- LEGACY ROWS stay NULL, and the PARTIAL predicate keeps them out of the index
-- explicitly (rather than leaning on NULLS DISTINCT, which a later "tidy" to
-- NULLS NOT DISTINCT would silently reverse). No backfill, because none is
-- possible here: a fingerprint needs the plaintext, and SQL cannot open an
-- envelope. Production holds ZERO org_stream_targets rows — no code on main
-- wrote one before Task 9's createStreamTarget, which ships in the same PR as
-- this delta — so a NULL row exists only in a dev or test database, where it is
-- a raw-inserted rig row with a fake envelope that could not be opened anyway.
alter table org_stream_targets
  add column dest_fingerprint text
    constraint org_stream_targets_dest_fingerprint_shape
      check (dest_fingerprint ~ '^[0-9a-f]{64}$');

create unique index org_stream_targets_org_dest_fingerprint
  on org_stream_targets (org_id, dest_fingerprint)
  where dest_fingerprint is not null;
