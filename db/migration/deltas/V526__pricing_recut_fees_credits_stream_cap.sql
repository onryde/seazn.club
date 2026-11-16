-- Owner rulings 2026-11-16 (pricing re-cut). Four groups of data changes; the code and copy that read them ship in the same PR.
--
-- Resolver semantics (V393's header): for an int key only `int_value` is read, NULL means unlimited, and a key with NO
-- ROW resolves to 0. Every statement below is an UPDATE of a row that exists, so none of them can turn a number into a
-- deny.

-- 1. The entry-fee cut on a card payment. Event Pass 4 -> 3, both rungs. Free stays 5 and Pro stays 2.
--    A competition that already took a paid card entry keeps its locked `competitions.fee_percent`; that column is not
--    touched, so only competitions that have not yet charged see the new rate.
update plan_entitlements
   set int_value = 3
 where plan_key in ('event_pass', 'event_pass_l') and feature_key = 'registration.fee_percent';

-- 2. The monthly AI credit grant. Free 5 -> 3, Pro 25 -> 8. Enterprise (500) is a staff-set pool and is not touched.
--    Pro's one-time TRIAL grant (`ai.credits.trial`) follows it down, 15 -> 8: a trial must not hand out more than a
--    paid month does. A trial already granted keeps what it was given. Enterprise's trial row (20) is per-deal and is
--    not touched. The Event Pass has no monthly row: its one-time grant is PASS_CREDIT_GRANT in lib/pricing-cards.ts, re-cut in the same PR.
--    Credits already granted this month stay granted; the next monthly grant uses the new number.
update plan_entitlements
   set int_value = 3
 where plan_key = 'community' and feature_key = 'ai.credits.monthly';
update plan_entitlements
   set int_value = 8
 where plan_key = 'pro' and feature_key in ('ai.credits.monthly', 'ai.credits.trial');

-- 3. The monthly streaming credit grant (one credit = one match): the ladder is Free 1, Event Pass 3, Pro 5.
--    Only the Event Pass moves (1 -> 3). Free (1), Pro (5), the L rung (5, not on sale) and Enterprise (20) already
--    sit where the ruling puts them and are not touched.
update plan_entitlements
   set int_value = 3
 where plan_key = 'event_pass' and feature_key = 'streaming.credits.monthly';

-- 4. One stream runs for up to 3 hours, not 5 (config.ts MAX_DURATION_MINUTES 300 -> 180).
--    LOUD: every stored booking above 180 is lowered to 180 first, or the tightened CHECK could not be added. For a
--    session still running that moves its hard stop earlier (one already past 3 h ends at the next sweep); for a
--    finished session it only rewrites the booking it was made under, which nothing bills from.
update fixture_stream_sessions
   set max_duration_minutes = 180
 where max_duration_minutes > 180;
alter table fixture_stream_sessions
  alter column max_duration_minutes set default 180,
  drop constraint fixture_stream_sessions_max_duration_minutes_check,
  add constraint fixture_stream_sessions_max_duration_minutes_check
    check (max_duration_minutes > 0 and max_duration_minutes <= 180);
