# Email outbox: queued sending with retry and delivery status

Owner-approved direction 2026-10-19 ("follow order"). This document is the
design of record for phase 1. Phases 2 and 3 are named here only so phase 1
does not paint them into a corner.

## Why

Every email the app sends today goes out inline from the request that caused
it (`send()` in `apps/web/src/lib/email.ts`). When Resend has a hiccup — a
timeout, its 2-requests-per-second rate limit, a 5xx, a short outage — the
email is logged and lost. Nothing retries, and nobody can later answer "did
this player get the email?". The sign-in route always answers "Check your
email" whatever happened (`app/api/auth/magic-link/route.ts:41-53`).

Online chess makes the gap visible: a round's check-in window is 10 minutes
(`DEADLINE_AFTER_MS`, `server/external-play/window.ts:7`), and the arbiter
needs to see, per player, whether the invite reached them. The next piece of
work (the Arbiter Panel's phase-adaptive round column, "variant C") shows
**Sent / Delivered / Delayed / Bounced / Not delivered** beside each player,
and reads it from this outbox.

## The order (owner ruling)

1. **Phase 1, this document:** the outbox core, with two email kinds on it —
   the sign-in (magic) link and the online-chess round invite.
2. **Phase 2:** the Arbiter Panel column C, reading invite status from the
   outbox. Separate design (the C spike), built after phase 1 merges.
3. **Phase 3:** move the remaining ~49 send functions onto the outbox in
   batches. Out of scope here.

## Goals

- An email is queued **in the same database transaction** as the thing that
  caused it. Committed ⇔ queued; a rollback queues nothing.
- It is attempted **immediately after commit**, inside the request, so a
  sign-in link is no slower than today.
- A failed attempt **retries with backoff**: 1 min, 5 min, 15 min, 1 h, 6 h
  after the previous attempt (6 attempts in all). After the last, the row is
  **dead** (dead-letter) and shows as Not delivered.
- **Never twice.** The outbox row id is Resend's `Idempotency-Key`
  (`email-outbox/<id>`), so an overlapping retry and a slow first attempt
  produce one email.
- **Never late.** Each row carries `expires_at`; a row past it is **expired**
  and never sent. Sign-in link: 15 min (`TTL_MINUTES`, `lib/login-link.ts:6`).
  Chess invite: the board's check-in deadline.
- **Delivery status on the row.** Resend's message id is stored; the Resend
  webhook moves the row through delivered / delayed / bounced / complained /
  failed / suppressed.
- One read function for "what is the latest status of the email(s) for this
  reference" that phase 2 can call.

## Non-goals

- Moving any email other than the two above (phase 3).
- Opened / clicked tracking. Rejected by the owner: Apple Mail Privacy
  Protection and Gmail's image proxy make "opened" false, and it needs a
  tracking pixel plus a privacy-page change.
- An admin or support UI for the outbox.
- Multiple recipients, attachments, scheduled sends, batch sends.
- An external queue (Redis, Cloudflare Queues, SQS). Rejected: it cannot share
  the database transaction, loses messages when no consumer is connected
  (pub/sub), and adds a service we do not run. Volume is a few hundred emails
  a day.

## Anti-goals (a failure even if it "works")

- Any email delivered twice.
- A sign-in link or chess invite delivered after it has stopped working.
- A user waiting longer for a sign-in link than today.
- Live credentials readable at rest: magic-link and match-room URLs in a
  plaintext column anyone with a DB read can harvest.
- An arbiter shown "invited" for a player whose email never left.
- Dev and e2e losing their ability to read sign-in links locally
  (`dev-links.ts` and the e2e helpers that read them).

## Constraints

- Postgres only, the existing `sql` / `withTenant` patterns
  (`lib/db.ts:224,273`). `withTenant` must not nest a pooled call inside its
  transaction (see #996). The outbox insert must run on the caller's own
  transaction handle (`Tx`) when there is one.
- Migrations: greenfield schema stance. `email_queue` already exists
  (`db/migration/deltas/V104__email_deliverability.sql:21-36`) and nothing
  reads or writes it. Take the next free `V<n>` at PR time — **no Flyway
  outOfOrder** — and ping the W2c and r2 sessions when it merges.
- Resend's idempotency key lives 24 h. The whole retry span (about 7.4 h)
  must stay well under that; pin it with a test derived from the schedule
  constant.
- Cron: `apps/cron-worker` (Cloudflare Worker, `seazn-cron-stg` /
  `seazn-cron-prod`) calls `app/api/cron/*` with `x-cron-secret`. It runs at
  `17 * * * *` and `*/5 * * * *` today (`schedule.ts:37,41`); there is no
  1-minute trigger. The retry worker needs one.
- House test rules (`docs/superpowers/TEST-STRATEGY.md`): every guard
  mutated once, sequence tests (retry then success, success then a late
  webhook, resend after dead), anti-vacuity counts, expected values derived
  from the constants not typed in.
- No new user-facing strings in phase 1 except any error copy that already
  exists; status words are phase 2.

## Decided: how it works

### The row

One table, `email_outbox`, replacing the unused `email_queue` (dropped in the
same migration). It holds at least:

- identity: `id` (uuid; also the idempotency key), `kind` (`magic_link`,
  `chess_invite`), `ref_type` + `ref_id` (what it is about — for a chess
  invite, the board and seat), `org_id` (nullable);
- what to send: recipient, subject, body (html + text), `transactional`;
- lifecycle: `status`, `attempts`, `next_attempt_at`, `expires_at`,
  `last_error`, `provider_id` (Resend message id), `created_at`, `sent_at`,
  `status_at`.

**Statuses:** `queued` → `sending` → `sent` → `delivered`, with `delayed`
between `sent` and `delivered`. Terminal: `delivered`, `bounced`,
`complained`, `failed` (Resend's `email.failed`), `suppressed` (our list or
Resend's), `expired`, `dead`, `replaced`. A row in `sending` carries a lease
so a crashed attempt becomes due again.

*My call:* **`replaced`.** Writing a new row for the same `kind` +
`ref` + recipient marks every older non-terminal row `replaced` (body
nulled) in the same transaction. A new sign-in link deletes the older unused
link (`login-link.ts:13`) and a Resend re-mints the room token, so retrying
the older row would deliver a dead link.

### Credentials at rest

The body of these two kinds contains a live credential (a sign-in token; a
match-room token valid 24 h). So:

- the body columns are **encrypted** with the existing application KEK (the
  one Lichess tokens use; it is on stg and prod);
- the body is **nulled** as soon as the row reaches any terminal state;
- the table is **not readable by `app_user`**. *My call:* `app_user` gets
  INSERT only (no SELECT, UPDATE or DELETE), so phase-3 callers inside
  `withTenant` can enqueue on their own transaction. The id is generated by
  the client and the insert uses no `RETURNING`. Everything else (the
  dispatcher, worker, webhook and status read) runs as the privileged role;
- metadata rows are deleted after 90 days.

### Sending

- `enqueueEmail(db, message)` inserts a row on the handle it is given and
  returns its id. It never calls Resend.
- After the caller commits, `dispatchNow(ids)` attempts those rows at once,
  in the request.
- `send()` gains an `Idempotency-Key` header and returns Resend's message id
  as well as success; existing callers of `send()` that are not on the outbox
  keep working unchanged.
- **Result handling:** 2xx → `sent` with `provider_id`. 429, 5xx, timeout,
  network error → back to `queued` with `next_attempt_at` from the schedule.
  400 / 403 / 422 → `dead` at once (retrying cannot help). 409 splits on
  Resend's error name: `concurrent_idempotent_requests` (the same key still in
  flight) → retry like a 429; `invalid_idempotent_request` (the same key with
  a different payload) → `dead` and logged as an error, because it means a
  bug.
- **Suppression** (non-transactional kinds only) is checked at attempt time;
  a suppressed address goes straight to `suppressed`. Both phase-1 kinds are
  transactional, so this path exists for phase 3.
- **No API key** (dev, CI): keep today's behaviour — log "would send", leave
  dev-link capture working — and mark the row terminal so nothing retries
  forever.

### The retry worker

- A new route `app/api/cron/email-outbox`, authenticated like the other cron
  routes, claims due rows with `for update skip locked` (pattern:
  `registrations.ts:1182`), expires the ones past `expires_at`, and attempts
  the rest.
- **Cadence (owner ruling 2026-10-20):** prod runs it **every minute** (prod
  keeps one machine running, `min_machines_running = 1`, so it costs nothing
  extra). Stg runs it on the **existing 5-minute tick** and adds no new wake-up
  (stg is `min_machines_running = 0`, `auto_stop = "stop"`, and a 1-minute
  call would keep it awake all day). Retries on stg are therefore coarser;
  the schedule constants are unchanged.
- The worker processes a bounded batch per tick and respects Resend's rate
  limit.

### The webhook

`app/api/webhooks/resend/route.ts` keeps its suppression behaviour and also
moves outbox rows matched by `provider_id`:

- `email.delivered`, `email.delivery_delayed`, `email.bounced`,
  `email.complained`, `email.failed`, `email.suppressed`;
- **monotonic:** a late `delivered` after `delayed` wins; a late `delayed`
  after `delivered` is ignored; bounced, complained, failed and suppressed
  are final;
- an unknown `provider_id` is a no-op 200 (emails not on the outbox).

**Signature:** when `RESEND_WEBHOOK_SECRET` is unset, the route refuses
(401) unless it is a non-production environment. Today it accepts unsigned
calls in that case (`route.ts:9-11`). Stg and prod both have the secret set
(checked 2026-10-19).

Resend configuration (owner-approved): the prod webhook gains
`email.delivered`, `email.delivery_delayed` and `email.suppressed` when the
build is ready to test. The owner creates the stg webhook and sets its secret
on the stg server.

### The two kinds

**Sign-in link** (`magic-link/route.ts` only): the token row and the outbox
row are written together, then `dispatchNow`. The response to the user is
unchanged. *My call:* the funnel claim email (`funnel/start/route.ts`,
`sendFunnelClaimEmail`, a 7-day `funnel_drafts` token) is a different email
and moves in phase 3, not here.

**Chess round invite** (`server/usecases/external-play/open-round.ts` and
`invite.ts`): today the seat is stamped (`white_emailed_at` /
`black_emailed_at`) inside the transaction, the email is sent after commit,
and the stamp is released if the send fails (`invite.ts:194-231`). With the
outbox, the outbox row is written in the same transaction as the stamp, and
`dispatchNow` runs after commit. `expires_at` = that board's check-in
deadline. Resend (`resendExternalPlayNotice`) writes a fresh row each time.

*My calls on the chess invite:*

- **One row per recipient.** A seat can have several recipients (one per
  entrant member with an email, `guard.ts:412`), so a team board writes one
  row per person. Status is per person; phase 2 shows it per person.
- **The seat stays stamped while any of its rows can still deliver**
  (`queued`, `sending`, `sent`, `delayed`, `delivered`). When every row for
  the seat has ended badly (`bounced`, `complained`, `failed`, `suppressed`,
  `expired`, `dead`), the stamp is released as today, so the board shows
  "still to invite" and Resend / Reinvite work. The release is done by the
  worker or the webhook, whichever moves the last row.
- **Response contract:** `openRound` and `resendExternalPlayNotice` keep
  `invited` / `emailed`, counting seats whose first attempt was accepted by
  Resend, and add `retrying`, counting seats whose first attempt failed
  retryably and are queued. A permanent first failure stays the existing
  `send_failed` skip. Phase 1 adds no copy for `retrying`; the existing
  control keeps showing what it shows today. Phase 2 replaces that view.
  Cost if wrong: between phase 1 and phase 2, a retrying seat reads as
  invited. Acceptable because phase 2 follows directly and nothing goes to
  prod before end of October.

### What phase 2 reads

`latestEmailStatus(refType, refIds)`: for each reference and recipient, the
newest non-`replaced` row's status and time. Phase 2 maps it to the arbiter's
words.

## Left to the builder

- Exact column types and names, indexes, the lease length, the batch size per
  tick, the encryption helper's shape (reuse the Lichess-token one).
- Whether the funnel-start route and the magic-link route share one helper.
- How the e2e and dev link-capture keeps working (the constraint is that it
  does).
- The precise handling of the chess seat stamp when an invite ends badly —
  within the anti-goal: the arbiter is never shown "invited" for a player
  whose email never left, and the board stays re-invitable by Resend.
- How the cron worker expresses a per-environment schedule (prod `* * * * *`,
  stg on the 5-minute tick).
