-- VERSION, re-pinned 2026-10-16 at the W2c rebase onto origin/main cf3e64977: written as V443 (main's
-- tail was V438; V439-V442 are chess's, on staging). Main has since merged V450__stream_runner_crash_count.sql,
-- and Flyway runs no out-of-order migrations here, so a V443 reaching a database that has applied V450 is
-- refused. Renumbered (not corrected forward: this delta has never run in production) to V462, past main's
-- V450 and the V451-V461 the chess session has reserved for its own deltas. Chess must still merge first,
-- or this moves again.
--
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
