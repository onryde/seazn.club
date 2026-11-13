-- V516 — Match Day codes that can call matches to courts (capture S4 Match Day, Task 8e; owner 2026-11-13: "Don't we have
-- option to call to Court to the match in Mobile App?" → "yes need in this session"). Supersedes the design's §1/§3 "a code
-- never calls a match to a court" for codes minted with the new power; a code minted without it still never calls.
--
-- 1. `match_day_codes.can_call`: the "Call matches to courts" tick, separate from "can approve draws". Every code minted before
--    this version is false: the power is new, and a printed QR never gains a power it was not minted with.
alter table match_day_codes add column can_call boolean not null default false;

-- 2. `fixture_calls.called_by_code`: the Match Day code that made a call, beside `called_by` (the organiser who made one on the
--    desk). A call made through a code writes `called_by_code` and leaves `called_by` null — never the code's issuer, who did not
--    make it. At most one of the two is set. Not "exactly one": both FKs are ON DELETE SET NULL (a user deleted, a code gone with
--    its competition), and a desk call whose organiser was deleted already has neither; exactly-one would make those
--    deletes fail. A code goes only with its competition or its org, and the call row goes with them.
--    The FK points into a sealed table (V509: FORCE RLS, no policy, no grant to app_user). Referential checks bypass row
--    security and run as the referenced table's owner, so the tenant write (app_user, withTenant) can still name the code.
alter table fixture_calls add column called_by_code uuid null references match_day_codes (id) on delete set null;
alter table fixture_calls add constraint fixture_calls_one_caller check (called_by is null or called_by_code is null);

-- 3. `match_day_code_uses`: a call and an Undo call made through a code are logged against it, as an open and an approval are
--    (§3 "Every link opened and every approval is logged"). Both name the match, as an open does.
alter table match_day_code_uses drop constraint match_day_code_uses_kind_check;
alter table match_day_code_uses add constraint match_day_code_uses_kind_check
  check (kind in ('open', 'approve', 'call', 'undo_call'));
alter table match_day_code_uses drop constraint match_day_code_uses_check;
alter table match_day_code_uses add constraint match_day_code_uses_check
  check ((kind in ('open', 'call', 'undo_call')) = (fixture_id is not null));
