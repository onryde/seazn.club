-- V472 — email outbox phase 3, wave 1: five player emails join the outbox. Spec:
-- docs/superpowers/specs/2026-10-25-email-outbox-phase3-design.md (§5 the once-key, §6 the replace rule, §7 the void).
-- Plan: docs/superpowers/plans/2026-10-25-email-outbox-phase3-wave1.md (P1, P2).
--
-- WHAT THIS ADDS.
--   1. Five kinds: registration_confirmation, payment_reminder, registration_promoted, refund_issued, solo_signup_assigned.
--   2. `recipient_user_id`: the account a row is for, when it is for one. The replace rule and the account-deletion
--      sweep read it, so a changed address finds its older mail by the account, not by the address it no longer has.
--      `on delete set null`: the row outlives the account (the deletion sweep scrubs the recipient itself).
--   3. `dedupe_key`: a once-key. Two rows of one kind cannot carry the same key, so a sweep that runs twice, a webhook
--      that is redelivered or a double press enqueues the email once.
--   4. The replace trigger moves from BEFORE to AFTER INSERT and learns the user rule.
--   5. `email_outbox_cancel`: the void's way to end a tenant's own queued rows, which `app_user` cannot UPDATE.
--
-- WHY THE ONCE-KEY IS A PLAIN UNIQUE INDEX AND THE WRITER'S ON CONFLICT HAS NO TARGET (plan P1). The spec wrote
-- `on conflict (kind, dedupe_key) where dedupe_key is not null do nothing`. As `app_user` that fails 42501: inferring a
-- conflict target needs SELECT on the columns, and `app_user` holds INSERT only (V470). A target-less
-- `on conflict do nothing` needs no SELECT and works. The price is that it swallows EVERY unique violation, so the
-- table may carry exactly the unique indexes it is meant to swallow: the primary key, `email_outbox_provider_idx` and
-- `email_outbox_once_idx`. outbox-once-key.test.ts reads the catalogue and fails if a fourth appears.
--
-- WHY THE SUPERSEDE RUNS AFTER THE INSERT (plan P2). A BEFORE trigger supersedes older rows, THEN the insert meets the
-- once-key and does nothing. A replay of a once-key (the first send, then a person's resend, then the replay) would
-- mark the resend `replaced` and write nothing: no live email left. Concurrently it is worse: each trigger statement
-- takes a fresh snapshot, so a loser could supersede the winner's row. A row `on conflict` skipped fires no AFTER
-- trigger, so a duplicate supersedes nothing, in sequence or concurrently.
--
-- THE REPLACE RULE. A new row supersedes older non-terminal rows of the same kind, ref and organisation, matched by
-- `recipient_user_id` when BOTH rows carry one and by `lower(recipient)` otherwise. So an account that changes its
-- address supersedes its own older mail, two accounts that share a mailbox do not supersede each other, and a row with
-- no account keeps the address rule it always had. The organisation fence is unchanged: the trigger is a definer and
-- bypasses RLS, so it matches `org_id` itself.

alter table email_outbox
  add column recipient_user_id uuid references users(id) on delete set null,
  add column dedupe_key text,
  add constraint email_outbox_dedupe_key_nonempty check (dedupe_key is null or dedupe_key <> '');

-- "Every email for this account". It serves the account-deletion sweep (plan T5: `recipient_user_id = <the deleted user>`) and
-- the foreign key's own lookup when a `users` row is deleted (`on delete set null` must find the rows that point at it). It does
-- NOT serve the replace trigger's `case`: that arm is not indexable, and the trigger is served by email_outbox_replace_idx on
-- (kind, ref_type, ref_id).
create index email_outbox_recipient_user_idx on email_outbox (recipient_user_id) where recipient_user_id is not null;
-- The once-key. Partial: a row with no key is free to repeat.
create unique index email_outbox_once_idx on email_outbox (kind, dedupe_key) where dedupe_key is not null;

-- Closed set: outbox-schema.test.ts reads this back and requires it to equal constants.ts.
alter table email_outbox drop constraint email_outbox_kind_valid,
  add constraint email_outbox_kind_valid check (kind in ('magic_link', 'chess_invite', 'registration_confirmation',
    'payment_reminder', 'registration_promoted', 'refund_issued', 'solo_signup_assigned'));

drop trigger email_outbox_replace_older on email_outbox;
create or replace function email_outbox_replace_older() returns trigger
  language plpgsql security definer set search_path = ${flyway:defaultSchema}, pg_temp as $$
begin
  update email_outbox
     set status = 'replaced', body_sealed = null, lease_until = null, status_at = now()
   where kind = new.kind and ref_type = new.ref_type and ref_id = new.ref_id and id <> new.id
     and case when new.recipient_user_id is not null and recipient_user_id is not null
              then recipient_user_id = new.recipient_user_id
              else lower(recipient) = lower(new.recipient) end
     and org_id is not distinct from new.org_id
     and status in ('queued', 'sending', 'sent', 'delayed');
  return null;
end $$;
-- AFTER, not BEFORE (plan P2): a row `on conflict do nothing` skipped fires no AFTER trigger, so a duplicate supersedes nothing.
create trigger email_outbox_replace_older after insert on email_outbox
  for each row execute function email_outbox_replace_older();

-- THE VOID (spec §7). Ending a tenant's queued rows because the thing they were about is gone (a round unpaired, a board
-- settled). `app_user` holds no UPDATE, so this is the definer way in. It touches only `queued` rows (a `sending` or
-- `sent` row may already be on the wire) and only the caller's own organisation: the function bypasses RLS as a definer,
-- so it fences on `current_org_id()` itself. Called with no tenant (the pool), `current_org_id()` is null and the fence
-- matches the org-less rows only, never an organisation's. The reason is the row's `last_error`, a snake_case word the
-- readers match on; the shape check keeps a free-text message (an address, a token) out of that column.
-- It also clears `dedupe_key` on the rows it ends. A cancelled email is dead for good, and a once-key that outlived it would
-- refuse the same key's re-enqueue for the 90-day retention (wave 3's email change cancels the old invite and sends a new one).
-- Only a `queued` row is ever cancelled, so a row that may have been mailed (`sending`, `sent`) keeps its key.
create function email_outbox_cancel(p_kind text, p_ref_type text, p_ref_ids text[], p_reason text)
  returns table (outbox_id uuid, outbox_kind text, outbox_ref_type text, outbox_ref_id text, outbox_meta jsonb)
  language plpgsql security definer set search_path = ${flyway:defaultSchema}, pg_temp as $$
begin
  if p_reason is null or p_reason !~ '^[a-z][a-z_]*$' then
    raise exception 'email_outbox_cancel: the reason must be a snake_case word' using errcode = '22023';
  end if;
  return query
    update email_outbox o
       set status = 'expired', last_error = p_reason, body_sealed = null, lease_until = null, dedupe_key = null, status_at = now()
     where o.kind = p_kind and o.ref_type = p_ref_type and o.ref_id = any(p_ref_ids) and o.status = 'queued'
       and o.org_id is not distinct from current_org_id()
    returning o.id, o.kind, o.ref_type, o.ref_id, o.meta;
end $$;
-- A new function is executable by PUBLIC until revoked.
revoke all on function email_outbox_cancel(text, text, text[], text) from public;
grant execute on function email_outbox_cancel(text, text, text[], text) to app_user;
