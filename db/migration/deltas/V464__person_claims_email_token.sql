-- V464 — a second secret per player-account claim, for the INVITE EMAIL only.
--
-- A claim row used to carry one secret (token_hash), and the SAME link was both
-- emailed and shown to the organiser as a copyable link + QR. Whoever holds the
-- organiser's console link must still sign in before claiming (the person the
-- link was shown to is not necessarily the person the profile is for), but the
-- link that went to the invited INBOX is proof of that inbox — the same basis a
-- magic link relies on — so opening it can sign the invitee in and claim in one
-- tap. Two audiences, two secrets: token_hash is the console secret (unchanged),
-- email_token_hash is the emailed one.
--
-- Like token_hash it is sha256 at rest and never leaves the server: it is not in
-- the claim row's returned columns, and the plaintext exists only in the email.
-- It lives on the SAME row, so a re-invite (which revokes the open row and
-- inserts a new one) and a revoke / unlink / merge-revoke kill BOTH secrets at
-- once, and expiry, claimed_at and revoked_at mean the same thing for either.
--
-- Nullable and additive: rows minted before this migration have no email secret
-- and keep working as console links. Partial unique so a hash resolves to one
-- claim and the lookup is indexed; the table-level grant to app_user and the
-- tenant RLS policy from V276 already cover the new column.
alter table person_claims add column email_token_hash text;

create unique index person_claims_email_token_hash_uq
  on person_claims (email_token_hash)
  where email_token_hash is not null;

-- Binding the emailed claim to an ACCOUNT looks the invited address up case-insensitively
-- (`lower(email) = lower($1)`, users.email being unique but case-sensitive), and that lookup runs
-- while the person and claim rows are locked. Without this it is a sequential scan of users under
-- those locks. Partial on the same `deleted_at is null` the query carries, so the planner can use it.
create index users_email_lower_idx
  on users (lower(email))
  where deleted_at is null;
