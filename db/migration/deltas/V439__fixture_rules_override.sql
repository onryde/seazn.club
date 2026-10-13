-- W2c (spec §4.3): a fixture's own match-format override — engine ruleKeys of
-- scope "match" only, written by writeFixtureRulesOverride alone. Null = the
-- fixture plays its stage's rules. Greenfield (spec §11): nullable, no default,
-- no backfill.
alter table fixtures add column if not exists rules_override jsonb;
-- W2c P-1 (spec §4.5 item 2): bumped ONLY by a Q11 correction or a staff re-freeze
-- (refreezeFixture). A scoring pad sends it with each event; append-event refuses a
-- stale one FIXTURE_RULES_CHANGED. Senders that omit it are never checked.
alter table fixtures add column if not exists rules_version int not null default 0;
comment on column fixtures.rules_override is
  'W2c: match-scoped rule override (engine ruleKeys scope "match"). Resolved as '
  'snapshot ?? (division ⊕ stage.rules ⊕ bracketDeciders ⊕ rules_override); frozen '
  'into config_snapshot with everything else at the first event.';
comment on column fixtures.rules_version is
  'W2c: incremented by a rules correction or staff re-freeze only; checked at append time when the sender includes it.';
