-- Media consent (RS006 step 4, design §4): mirrors the existing
-- privacy_consent_at/privacy_consent_version pair exactly — a timestamp +
-- version, not a boolean, so a stamp names the text that was shown
-- (V279/V363 precedent). Null = consent not given; media consent is
-- OPTIONAL and never blocks submit, unlike privacy consent.
alter table registration_groups
  add column if not exists media_consent_at      timestamptz,
  add column if not exists media_consent_version text;
