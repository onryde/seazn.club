-- RS007 review defect #4 (HIGH): the join page renders a CONSENT step and
-- hard-blocks submit on privacy consent, but `registration_players` had
-- nowhere to record either flag PER PLAYER — `joinTeamEntry` could only
-- ever leave a joiner's own privacy/media consent unrecorded, and the
-- ONLY consent columns that existed (registration_groups.privacy_consent_at/
-- .privacy_consent_version, V363; .media_consent_at/.media_consent_version,
-- V377) belong to the CAPTAIN's cart-wide submit — reusing them for a later
-- joiner would silently apply the captain's own choice to every joiner,
-- overriding a deliberate media-consent REFUSAL with whatever the captain
-- picked. Mirrors those two column pairs exactly (timestamp + version, not
-- a boolean, so a stamp names the text that was shown — same reasoning
-- V377's own header gives): null = consent not given/not yet recorded.
--
-- No backfill: every pre-existing row (every captain_entered slot minted
-- before this migration, and every self_joined row inserted before it)
-- stays null on all four columns, exactly like V377's own media-consent
-- pair did for rows that predated it — there is no consent to backfill,
-- only the absence of a record.
alter table registration_players
  add column if not exists privacy_consent_at      timestamptz,
  add column if not exists privacy_consent_version text,
  add column if not exists media_consent_at        timestamptz,
  add column if not exists media_consent_version   text;
