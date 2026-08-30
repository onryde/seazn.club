-- V386 — #22: the directory fills with duplicate people.
--
-- `findOrCreatePlayerPerson` (registrations.ts) only ever dedupes a
-- captain-entered player on (org, lane='player', dob, lower(trim(full_name))).
-- But `dobRequired` is false unless the registrant ticks "I'm playing", and
-- the details step asks a roster row for a full name only — so a
-- captain-entered row essentially never carries a dob and therefore never
-- dedupes. The same 8-player squad entered into three competitions becomes
-- 24 directory people instead of 8.
--
-- `registration_players` already collects an email (V363) — the one strong
-- identity signal already typed in at submit or claim time — but `persons`
-- has nowhere to put it, so it is discarded the moment the directory record
-- is created. This migration only adds the column; registrations.ts wires
-- the dedupe-on-email (then fall back to dob) rule on top of it.
--
-- Owner ruling (session of 2026-08-29/30, `_INDEX.md` #22): dedupe on EMAIL,
-- exactly, never on name — the existing "does not dedupe on name alone"
-- ruling is untouched. A duplicate is a one-click #404 merge; silently
-- fusing two different humans (same-named juniors, for instance) is not
-- reversible. This column carries no uniqueness constraint of its own for
-- exactly that reason — the app layer's "exactly one match reuses, zero or
-- ambiguous creates" conservatism is enforced in code, not by a DB
-- constraint that would either reject a legitimate shared inbox (a family
-- email for two junior siblings) or force a guess.
--
-- Nullable, no backfill owed — greenfield (RS001 demolition — prod holds
-- zero registration rows, the same standing fact V378/V381/V383/V385 already
-- relied on).
alter table persons add column if not exists email text;

-- Indexed, unlike the existing dob probe (registrations.ts's own comment:
-- "a small per-org query by design; no index added for it"). That ruling
-- assumed the dob path would stay rare — the whole point of this migration
-- is that it it does, because captain-entered rows essentially never carry
-- a dob. Email is the OPPOSITE: every cart contact has one (required,
-- SubmitGroupContact.email) and every claimer gives one, so this lookup
-- runs on close to every roster row, at every submit and every claim, for
-- the lifetime of the org — not a rare fallback. A sequential scan that was
-- acceptable for an occasional dob probe is not acceptable as the PRIMARY
-- per-row lookup.
--
-- Partial + expression, matching the query shape exactly
-- (`where org_id = ? and lane = 'player' and merged_into is null and
-- lower(email) = ?`): scoped to non-tombstoned, non-null emails only, so
-- rows the query can never match (merged-away duplicates, and the
-- teammates-with-no-email majority #22's own "known limit" section
-- describes) never bloat the index.
create index if not exists persons_org_lane_email_idx
  on persons (org_id, lane, lower(email))
  where merged_into is null and email is not null;

-- No new RLS policy: `persons` already has row-level security enabled,
-- forced, and a direct tenant policy scoped to `org_id = current_org_id()`
-- (db/migration/v2-engine/rls-grants/V227__v2_rls.sql, `persons_tenant`,
-- `for all`) — confirmed rather than assumed. RLS is row-scoped, not
-- column-scoped, so a new nullable column on an already-policied table
-- needs nothing further.
