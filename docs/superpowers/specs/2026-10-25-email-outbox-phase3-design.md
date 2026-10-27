# Email outbox phase 3: every remaining email on the outbox

**Status:** Approved by owner 2026-10-25 ("Apply rec": every recommendation accepted; see "Owner decisions"). It extends the
phase-1 design of record,
`docs/superpowers/specs/2026-10-19-email-outbox-design.md` (phase 1 merged as #1008, follow-ups FU1 to FU3 as #1009 to #1011).
Building starts on a fresh branch from `main` once phase 2 (the arbiter round column) has merged.

Every citation is to `origin/main` at `a622343cc` (2026-10-25) and was re-read for this document. Paths are under
`apps/web/src/` unless they begin with `apps/`, `db/`, `docs/` or `scripts/`. `email.ts` means `lib/email.ts`. "Inventory #n" is a
row of the phase-3 inventory (51 rows: 49 senders off the outbox, plus the two already on it).

*Controller call (2026-10-25): full paths.* Short file names mean: `registrations.ts`, `registration-assign.ts`,
`registration-approval.ts`, `registration-submit.ts`, `officials.ts`, `schedule.ts`, `sponsors.ts`, `billing-events.ts`,
`discipline.ts` and `withdrawal.ts` are in `server/usecases/`. `stages.ts` is `server/usecases/stages.ts`. `open-round.ts`,
`guard.ts`, `invite.ts` and `invite-outbox-hook.ts` are in `server/usecases/external-play/`. `attempt.ts`, `worker.ts`,
`status.ts`, `hooks.ts`, `transport.ts`, `readiness.ts`, `constants.ts`, `enqueue.ts` and `account-deletion.ts` are in
`server/email-outbox/`.

## Why

49 `send*` functions in `email.ts` still send mail directly from the request, webhook or cron that caused it. Each one goes
through the private `send()` (email.ts:280), then `sendWithResult` (:274), `checkSendable` (:158) and `deliver` (:213). If Resend times
out, rate-limits, returns a 5xx or is down, `send()` returns `false`, the failure is logged, and the email is lost. Nothing
retries, and nobody can later say whether a receipt, a refund notice or a dispute alert went out. Phase 1 fixed this for two kinds:
the sign-in link and the chess round invite. Phase 3 moves the other 49.

## Decided by the owner

1. **All 49 move to the outbox**, the important ones first.
2. **There is one sending path and one retry rule.** The rule is phase 1's: retry after 1, 5, 15, 60 and 360 minutes
   (`RETRY_DELAYS_MS`, `server/email-outbox/constants.ts:57`), six attempts in all (`MAX_ATTEMPTS`, :60), then `dead`.
3. **Two parked fixes ride in phase 3.** (a) Voiding a round cancels that round's chess invites that are still queued.
   (b) The recipient of a queued invite is resolved when it is sent, not when it was queued. This covers account deletion and
   email change.
4. **Each wave is built on a fresh branch from `main`**, after phase 2 merges.

## What main has today

- **Senders.** `email.ts` has 49 `send*` exports, at lines :288 to :1675, with 57 production call sites. None of the 57 runs
  inside a database transaction. Several build their notice inside a transaction and send it once that transaction commits:
  `server/usecases/officials.ts:591-594` and `:640-643` (`.then` after `withTenant`), `server/usecases/schedule.ts:3294-3296`
  ("assembled in-tx, sent after commit"), `server/usecases/registration-assign.ts:378-381`, `server/usecases/sponsors.ts:556`
  then `:589`, and `app/api/users/me/route.ts:167` then `:213`.
- **The outbox API.** `enqueueEmail` (`server/email-outbox/enqueue.ts:55`) inserts a row on whatever handle the caller passes and
  seals the body under `EMAIL_OUTBOX_KEK` (:59). It refuses an expiry further out than `MAX_EXPIRY_MS` (:57; constants.ts:84,
  which is 24 h less a 7-minute margin). `dispatchNow` (`attempt.ts:369`) makes the first attempts after commit, paced, within a
  10 s budget. The worker (`worker.ts`) makes every later attempt. A never-attempted row is left to its request for 30 s
  (`FIRST_ATTEMPT_WINDOW_MS`, constants.ts:149; `worker.ts:108-112`). Both paths end in `attemptClaimed` (`attempt.ts:187`), which
  passes `row.recipient` to the gate and to the send (:194, :219). The transport (`transport.ts:22`) is the only module that
  tests replace.
- **The schema (V470).** The kind CHECK names two kinds (`db/migration/deltas/V470__email_outbox.sql:70`). The same list is
  `OUTBOX_KINDS` (constants.ts:9), and `outbox-schema.test.ts:50` pins it as a literal. The replace trigger supersedes older
  non-terminal rows with the same kind, ref, `lower(recipient)` and org (V470:104-117). `app_user` may only INSERT, under the
  policy `org_id = current_org_id()` (:119-123). A row may hold a body only while it is `queued` or `sending` (:80-82).
  `KIND_HOOKS` is a `Record<OutboxKind, KindHook>` (`hooks.ts:39-42`).
- **Already landed.** FU2 handles account deletion: inside the deletion transaction it deletes `magic_link` rows and anonymises
  chess invites by exact address (`app/api/users/me/route.ts:184-192`; `server/email-outbox/account-deletion.ts:42-52`). FU3 sets
  the re-render rule: a queued email may be re-rendered only when `attempts = 0`, or `attempts = 1` and its last error was a 429
  (`server/email-outbox/status.ts:134`).
- **Cron.** The `email-outbox` job runs every minute on prod and every 5 minutes on stg (`apps/cron-worker/src/schedule.ts:140-155`).
  A tick takes at most 20 rows (`WORKER_BATCH_SIZE`, constants.ts:101).
- **Migrations.** The latest is `db/migration/deltas/V471__all_stages_free.sql`. The outbox table is V470.

## Findings: premises that did not hold

| # | Premise | What the code says |
|---|---|---|
| F1 | "21 of the 49 go to staff." | 16 kinds go to `STAFF_ALERT_EMAIL`: email.ts:755 to :1675, except trial ending at :1643. They have 19 call sites. |
| F2 | The inventory's locale column marks many kinds "English only". | That means the *caller* passes no locale. 34 of the 49 render from the `emails` dictionary, which exists in all four locales (`dictionaries/{en,es,fr,nl}/emails.json`). Only the 15 inline staff alerts are written in English, and that is deliberate (email.ts:772-777). |
| F3 | Parked fix (b) is still to be built for account deletion. | Half of it is built (FU2, #1010). Two gaps remain. The match is `recipient = users.email`, exactly (account-deletion.ts:47, :51), so a row queued under an address the account later changed away from is missed. And email change touches no queued row: confirming the change writes `users.email` at `app/api/auth/change-email/confirm/route.ts:66`, and nothing else. |
| F4 | "The next free migration is V472." | V471 is the latest on `main`, and V472 is free there today. But the W2d build in flight has also planned V472. Phase 1 forbids Flyway outOfOrder, so each wave takes `main`'s max + 1 when its PR is opened. |
| F5 | (new) | The two official notices already mix languages. Their fixture labels use the org's default locale (`officials.ts:693-701`; `schedule.ts:3355-3357`), but the email around them is English, because no locale is passed (`officials.ts:763-767`; `schedule.ts:3358`). |
| F6 | (new) | The funnel reminder has a second defect besides the brief's. Its due select claims nothing (`app/api/funnel/remind/route.ts:25-32`), and two schedulers may fire it at once (:14-15), so a draft can be reminded twice. |
| F7 | (new) | A replayed webhook re-sends its emails today. `runEvent` stamps `processed_at` only after the whole handler has run (`server/usecases/billing-events.ts:2815-2835`). `charge.refunded` runs five handlers in a row (:2704-2715), so a throw in a later handler replays the emails of the earlier ones. The registration dispute alert follows an unconditional update (`registrations.ts:3158-3168`), so every replay mails it again. |
| F8 | (new) | Each retry of a payment reminder creates a new Stripe Checkout session. A failed send releases the lease (`registrations.ts:5041-5044`, `:5123-5126`), and the next sweep claims the row and creates another session (`:5017`, `:5107`), which overwrites the group's session pointer. |
| F9 | The inventory says the claim invite in the use case is fired from three places (`registration-submit.ts:937`, `:1457`, `registration-approval.ts:151`). | It is fired from seven. `inviteUnclaimedMembers` (`registrations.ts:1462`) is also called at `registrations.ts:3036`, `:5910`, `:5967` and `:6008`. All seven need wave 3's in-transaction enqueue. |

## Design

### 1. One outbox kind per email

**Decided: each email gets its own kind,** named in snake_case (see the wave table). With phase 1's two, that makes 51 kinds.

| Concern | One kind per email | One generic kind plus a template id |
|---|---|---|
| Replace trigger (V470:110-113: kind + ref + recipient) | Two different emails about the same ref never supersede each other. | A payment reminder would supersede a confirmation still queued for the same registration and contact, unless the template id were hidden in `ref_type`. |
| Kind CHECK (V470:70) | Stays a closed vocabulary. Each wave's migration adds that wave's kinds, and the database refuses a mistyped kind. | The CHECK means nothing, and nothing checks the template id. |
| RLS (V470:121-122) | No difference: the policy ignores kind. | Same. |
| KEK seal (enqueue.ts:59) | No difference: every body is sealed. | Same. |
| Status reads (`latestEmailStatus` and `EmailStatusRow`, status.ts:29, :38, return `kind`) | A reader filters by kind. | A reader has to parse `meta`. |
| Idempotency key `email-outbox/<id>` (constants.ts:93) | Per row, unaffected. | Same. |
| Hooks (`Record<OutboxKind, KindHook>`, hooks.ts:39) | The type makes every kind be declared, so a missing kind fails to compile. | One entry covers 49 emails. |

**My call:** no phase-3 kind gets an ended-badly hook. A reminder that dies stays dead, and the outbox row records it. Re-sending
it on the next sweep would bring back the retry-forever behaviour that F8 describes. If this is wrong, a dead payment reminder is
not re-sent before the pay deadline. That is the same outcome as today's lost email, except that it is now visible.

### 2. Render at enqueue, in the recipient's locale

**Decided: the email is rendered when it is queued, as in phase 1.** The reasons:

- The worker stays kind-agnostic. The core imports no use case (hooks.ts:4-6), so it never needs a registry of renderers.
- Every attempt sends the same bytes under the same key. Rendering at send time could send a different payload under a key Resend
  has already seen. Resend answers that with `409 invalid_idempotent_request`, which ends the row `dead`. Freezing the render
  after the first request would avoid that, but that is rendering at enqueue with extra steps.
- A receipt states what was true when the event happened.
- The sealed-body machinery already exists.

**Re-rendering:** only FU3's rule applies (status.ts:134, reached through `lockQueuedEmails`, :116), and only the chess invite uses
it. When a fact changes, the result is either a new email with its own ref, or a full restatement that replaces the old one (§5).
No phase-3 kind re-renders.

**Locale:** each recipient row is rendered in that recipient's locale when it is queued, and that locale then stays fixed. For
callers that pass no locale today, *Owner decision (2026-10-25), D4:* the source order is the account's locale (through an
existing link only, as below), then the org's default locale, then English. This also fixes F5's mixed-language official notices.

*Controller call (2026-10-25): locale for L recipients.* An L recipient's account locale is used only through a link that
already exists (`persons.user_id`). It is never found by looking a user up by the address. With no such link, the org's default
locale is used, then English.

**Reads inside a tenant transaction:** every read the render needs goes through `tx`, never the pooled `sql`. Phase 1's
constraint stands: no pooled call nested inside `withTenant` (#996).

**Subjects** stay in plaintext (V470:45). If a subject carries a credential or a contact detail, that is a finding for its wave.

### 3. Where the row is written

- **R1. The row is written on the transaction that commits the fact the email reports.** Where the caller already has that
  transaction (the sites listed in "What main has today"), the enqueue moves into it. Where the fact is a single statement on the
  pool, that statement and the enqueue are wrapped in one `sql.begin` or `withTenant`. Examples: the funnel draft insert, the
  `email_change_requests` insert (`app/api/auth/change-email/route.ts:29-33`), the manual reminder's audit (`registrations.ts:6038-6040`)
  and the funnel reminder stamp (`funnel/remind/route.ts:46`).
- **R2. An email that reports a failure is written on the pooled privileged connection.** Most staff alerts are this kind of
  email. They are never written on the transaction whose failure they report, because that transaction has aborted or rolled back
  and would take the row with it.
- **R3. The handle has to match the org.** Inside `withTenant`, the row's `org_id` must be the tenant's org (policy V470:121-122).
  Kinds with no org (account emails, the funnel, staff alerts) are written on the privileged pool or in a `sql.begin`.
- **R4. Never catch an enqueue error inside a transaction and carry on.** A refused statement aborts the transaction, and the next
  statement fails with 25P02, later and less clearly. A caller that must survive a refused email uses a savepoint. FU3's check-in
  extension is the precedent. *Owner decision (2026-10-25), D1:* outside such a savepoint, a refused enqueue fails the action
  that caused it, everywhere.
- **R5. `dispatchNow` runs only after commit,** never inside `withTenant` (`attempt.ts:347-349`).
- **R6. Enqueue only on the transition.** A path that can run twice for one event (a webhook replay, a second cron run, a double
  press) enqueues only when its own write changed state: `update … where <not yet> … returning`. The once-key (§5) backs this up.

### 4. The first attempt

- **A request someone is waiting on** calls `dispatchNow` after commit. The call is awaited when the response reports the outcome
  (`email_sent`, `{sent}`) or when the person is waiting for a link. Otherwise it runs through `deferred()` (`lib/deferred.ts:14`).
- **Webhooks, crons and read paths leave the first attempt to the worker.** The delay is the 30 s first-attempt window plus one
  tick: about 1.5 minutes on prod and up to 5.5 on stg.
- **Webhooks never call `dispatchNow`,** because a single hung Resend request (`SEND_TIMEOUT_MS`, 15 s, constants.ts:63) would hold
  up Stripe's delivery.

### 5. Refs, replacement and once-keys

**The ref rule.** A kind's ref names the document the email is. A newer row may replace an older one through the V470 trigger
only when the newer row fully restates the older: a resend, or a later move of the same fixture. A notice about a distinct event
uses that event's id as its ref. That way two officials assignments, or two refunds, never supersede each other.

**The once-key.** A new nullable column, `dedupe_key`, allows at most one row per `(kind, dedupe_key)` for as long as rows are
kept. Kinds driven by events set it: to the Stripe object, the cron pass or the suspension transition. User-pressed resends leave
it empty.

- The check runs in the BEFORE INSERT trigger, before the supersede step. A sequential duplicate then inserts nothing and
  supersedes nothing, because the trigger returns NULL. An `on conflict` clause on its own would not be enough here: the supersede
  would run first, and the original row would be lost.
- *Controller call (2026-10-25): the once-key race.* `enqueueEmail` also inserts with
  `on conflict (kind, dedupe_key) where dedupe_key is not null do nothing`. Two concurrent inserts both pass the trigger check,
  because neither can see the other's uncommitted row. The second then waits on the unique index and does nothing. So a duplicate
  never aborts the caller's transaction, whether it arrives in sequence or concurrently. Wave 1 tests two concurrent inserts with
  one once-key: exactly one row, no error in either transaction, and the original row's status untouched.
- `enqueueEmail` reports "duplicate, no row" as its own result, read from the insert's row count of 0.

**Email change.** A new request deletes the earlier one (`change-email/route.ts:29`). But the new confirmation goes to a
different address, and the trigger matches by recipient, so it does not supersede the old confirmation. The request's transaction
therefore ends the user's queued `email_change_confirmation` rows itself, using the cancel primitive in §7.

### 6. Recipient at send time (parked fix b)

**Schema and enqueue.** A new column, `recipient_user_id uuid null references users(id) on delete set null`. Kinds marked A in
the wave table pass the user id. `recipient` keeps the address as it was when the row was queued.

*Controller call (2026-10-25): `chess_invite` is an A kind.* `recipients` (`server/usecases/external-play/guard.ts:28`) gains
`userId`, taken from loadSide's join to `users` (`guard.ts:387`), and `queueFixtureInvite` passes it. `magic_link` stays L: it goes
to the address that was typed.

**Resolution.** It happens in `attemptClaimed` (`attempt.ts:187`), before the gate. Both claim paths end there, so one function
covers both.

| The account now | Earlier attempts on the row | Action |
|---|---|---|
| deleted (`deleted_at` set) | any | End the row `expired` with `last_error = account_deleted` and scrub the recipient. The hook runs, so the chess invite releases its seat. |
| same address | any | Send. |
| changed address | key-clean (FU3's test, status.ts:134, counted as below) | Rewrite `recipient` and send under the same key. Resend never stored that key. |
| changed address | not key-clean | *Owner decision (2026-10-25), D2:* keep the first address, and send to the address the key was first used with. |

*Controller call (2026-10-25): key-clean.* The test runs on the claimed row. By then the claim has already incremented `attempts`
(`attempt.ts:431`, `worker.ts:172`), so the earlier attempts number `attempts - 1`. The row is key-clean when `attempts - 1 = 0`,
or when `attempts - 1 = 1` and `last_error like 'http 429 %'`. A reclaim after a lapsed lease is never key-clean, whatever its
counts: the attempt before it may have reached Resend.

**The replace trigger** matches on `recipient_user_id` when both rows carry one, and on `lower(recipient)` otherwise, as today.

*Controller call (2026-10-25): what replacement can promise.* The trigger supersedes `queued`, `sending`, `sent` and `delayed`
rows alike (V470:113). So "a row queued before an email change and one queued after it, for the same ref, send one email, not
two" holds only while the older row is unsent (`queued`). A `sending` row may already be in flight. If the older row has already
gone (`sent` or `delayed`), the trigger still marks it `replaced`, but it cannot recall the email: the person receives both, and
status reads report the newer row, because they skip `replaced` rows.

**Account deletion.** *Controller call (2026-10-25): the generalised deletion sweep lands in wave 1, with its test.*
`users/me/route.ts:184-192` currently covers two kinds, matched by address. Wave 1 generalises it to the account's rows: A-kind
rows matched by `recipient_user_id`, plus the account's own sign-in and invite mail. *Owner decision (2026-10-25), D5:* only
the account's own rows. An L-kind row queued for a registration, a sponsor contact or the staff address stays, even if its address
matches, because it belongs to another record. Staff alerts are never touched. Queued rows end
`expired` with `account_deleted`. Every one of the account's rows has its address scrubbed to the placeholder, whatever its
status, as FU2 does today (`account-deletion.ts:49-51`). `magic_link` rows are deleted, as they are today. The `account_deletion`
notice itself is queued in the same transaction, after the anonymisation, as a literal address with no user id. Its address is
scrubbed to the placeholder (`users/me/route.ts:165`) when the row ends, so the deleted person's address does not stay in the
outbox for the 90 days rows are kept (`RETENTION_DAYS`, constants.ts:192).

**Email change** needs no write when it is confirmed: resolution at send time covers it.

**Literal kinds (L) are never resolved.** The email-change confirmation goes to the new address on purpose, and the notice goes
to the old one.

**Guard:** no body of an A kind may print the recipient's own address, because resolution would make it stale. A test renders
every A kind and reports how many it checked.

### 7. Voiding a round cancels its queued invites (parked fix a)

**What happens today.** `clearSwissFixtureSeats` (`server/usecases/stages.ts:2245`) deletes the round's bridge rows (:2255) inside two
transactions: unpair (`unpairSwissRound`, :2347, which calls it at :2414) and unseat (`unseatSwissRoundsSeatingEntrant`, :2305,
which calls it at :2340). It leaves those boards' `chess_invite` rows `queued`. The worker would then send an invite to a board
that no longer seats the player, and the room token cannot be revoked (phase-1 spec, "replaced").

**The fix.** In the same transaction, every `queued` `chess_invite` row for the cleared boards' seats ends `expired`, with
`last_error = round_voided` and the body nulled. Rows in `sending` are already in flight and finish under their own key.

- **Mechanism.** `app_user` may only INSERT, so the cancel is a SECURITY DEFINER function in the V451/V470 shape. It is fenced by
  org like the replace trigger (V470:104-117) and granted to `app_user`. §5's email-change supersede uses it too.
- **Call site.** The call is made explicitly in `clearSwissFixtureSeats`, not from a delete trigger. The re-arm delete at
  `open-round.ts:483` queues fresh invites in the same transaction, and a delete trigger would catch them as well.
- **The chess hook** recomputes from the database (hooks.ts:22-24), so it must do nothing when the bridge row is already gone.
  This is tested.
- **No new status.** `expired` with a reason follows FU2's precedent (`ACCOUNT_DELETED_REASON`, account-deletion.ts:31).
- **For the builder:** answer the reviewer's third question for a board-level void as well. `voidAndAbandon` (`server/usecases/withdrawal.ts:177`)
  keeps the bridge row. My recommendation is the same cancel when a board is settled while its invite is still queued.

### 8. Behaviour changes callers absorb

| Today | After |
|---|---|
| `send*` returns `false` and never throws on a provider failure. | `enqueueEmail` returns an id, or throws a refusal: `OutboxKeyUnavailableError`, `OutboxExpiryTooLongError`, or a CHECK or policy violation. Delivery becomes the outbox's job. |
| The `email_sent` / `{sent}` responses (`v1/persons/[id]/claim-invites/route.ts:35`, `v1/officials/[id]/invite/route.ts:27`, `orgs/[id]/invites/route.ts:45-51`, `registrations.ts:1741`, `:6041`). | These become `dispatchNow(...)` outcome `=== "sent"`: Resend accepted the first attempt. `false` can now also mean "retrying", and the three notices that read it are reworded (D3, §11). |
| The two payment-reminder sweep passes release the lease when the send fails and try again next sweep, creating a new Checkout session each time (F8). | Claim, then mint, then one transaction that enqueues with a once-key and stamps `submit_reminded_at` / `promotion_reminded_at`. Nothing is released when a send fails. The lease remains only to cover a crash between the claim and that transaction. |
| The organiser's resend logs a warning when the send fails (`registrations.ts:1680-1687`). | The warning is dropped; the row records the outcome. |
| `void … .catch(() => {})` swallows every outcome. | The enqueue happens inside the transaction, and an error propagates: the action fails (D1, §3). |
| The served-suspension notice re-checks `xmin` so it is sent at most once (`server/usecases/discipline.ts:448-455`). | The notice is enqueued in the transaction that flips the suspension, with a once-key. The `xmin` check is removed only after the new path is proven. |
| The funnel reminder counts `sent` only when `send()` succeeded (`funnel/remind/route.ts:43`). | `sent` counts the rows queued (§9). |
| The readiness log says only sign-in will fail (`readiness.ts:15-19`). | It says every action that sends email will fail. This is log text, so English is fine. |

### 9. The funnel reminder fix (wave 5)

- **Per draft, one transaction.** First `update funnel_drafts set reminded_at = now() where id = … and reminded_at is null
  returning …`, then enqueue a `funnel_reminder` row with the once-key `<draft>:reminder`. If two schedulers run at once, the
  second one's update matches nothing (F6).
- **A malformed payload** is still stamped, with no email (route.ts:45).
- **A reminder that dies stays dead** (§1).
- **Expiry** is the earlier of the draft's `expires_at` and the outbox bound.
- **Regression tests:**
  - With the transport failing, `reminded_at` is set, the row is queued, and the worker retries it to `sent`.
  - Two runs at the same time produce one row.

### 10. Staff alerts: on the outbox, last

**Recommendation: on the outbox**, as the owner's "all" rule says, with no lighter path. The reasons:

- One path is what lets the no-second-path guard (Test strategy) reach zero.
- Several alerts are the only sign that money has already gone wrong: a player not refunded (:1590), a pack paid for but not
  granted (:812, :852, :904), a pass credit that was not reversed (:1073). Losing one of those costs money.
- Each alert costs one insert.

**Rejected:**
- Keeping `send()` for staff. That is a second path, and the scan could never reach zero.
- Sentry only. It would need new alert routing, and staff would get no email.

**What stays the same or is new:**
- They are left to the worker.
- They stay transactional (all 16 already are).
- They are written on the pool with no org (R2).
- The once-key is the id the alert is about.
- *Controller call (2026-10-25).* 15 of the 16 keep their inline English copy (staff only; F2). The 16th,
  `sendStaffDisputeAlertEmail` (email.ts:755), renders from the dictionary with `en`: it defaults to `en` (email.ts:758), and
  its caller passes no locale (`billing-events.ts:2267`).
- They stay gated on `STAFF_ALERT_EMAIL`. When it is unset, no row is written, and that empty case is tested.
- The money alerts go first within the wave.

### 11. Delivery status shown to people

*Owner decision (2026-10-25), D3:* no new status UI in phase 3. Phase 2's chess column stays the only reader. Three existing
notices stop being true once a failed first attempt is retried, so each is reworded in all four locale dictionaries so that it
reads true whether the outbox is still retrying or has given up. For example: "The email didn't go out straight away; share the
link below". Each is reworded in the wave that moves the kind behind it:

| Key | Kind | Wave |
|---|---|---|
| `reg.remind.notSent` (`dictionaries/en/ui.json:2196`) | `payment_reminder` | 1 |
| `officials.inviteEmailFailed` (`dictionaries/en/ui.json:3379`) | `official_invite` | 3 |
| `settings.team.inviteEmail.notSent` (`dictionaries/en/ui.json:3438`) | `org_invite` | 3 |

The `email_sent` / `{sent}` booleans keep their shape. Later candidates for status, all readable through `latestEmailStatus`: the
org invite list and the organiser's registration list.

### 12. Expiry

`expiresAt` is the earlier of two times: when the email stops being useful, and now plus `MAX_EXPIRY_MS`. These kinds have a real
deadline:

- the 24 h email-change link (`change-email/route.ts:26`);
- the verification link;
- the funnel draft;
- the payment reminder (its pay deadline, and the Checkout session's own expiry);
- the promotion window;
- the two official notices (the fixture's start).

Every other kind uses the bound. The whole retry schedule takes 7.35 h, which fits inside the bound.

## Waves

**Legend**
- **To:** A = an account, resolved at send (§6); L = a literal address; S = `STAFF_ALERT_EMAIL`.
- **Tx:** the `transactional` flag. T = it ignores the suppression list; N = the suppression list applies at attempt time.
  *Controller call (2026-10-25): each kind keeps its sender's current flag.* The 19 N kinds are the senders that pass no
  `transactional: true` today; the other 30 pass it.
- **First attempt:** R = `dispatchNow` after the request commits; W = the worker (§4).
- **Ref · once-key:** a proposal. The builder confirms the id at each call site, but the rule in §5 is binding.

The order is important first: registration and player money, then organiser and sponsor money, then accounts and invites, then
officials and notices, then the reminder and staff alerts.

| Inv # | Kind | Sender (email.ts) | W | To | Tx | First | Ref · once-key | Why this wave |
|---|---|---|---|---|---|---|---|---|
| 19 | `registration_confirmation` | `sendRegistrationEmail` :567 | 1 | L | N | R | registration_group · — | The entrant's proof and manage link. Three callers (registrations.ts:1630, :1679, :1741). |
| 20 | `payment_reminder` | :579 | 1 | L | N | W sweep, R manual | registration · `<id>:submit`, `<id>:promotion` | Carries the checkout link; without it an entry lapses unpaid. F8. |
| 21 | `registration_promoted` | :591 | 1 | L | N | R / W | registration · `<id>:<promoted_at>` | A promoted player has a window to pay. |
| 23 | `refund_issued` | :622 | 1 | L | N | R / W | refund · Stripe refund id | Money returned. Five callers, including a webhook and a cron. |
| 22 | `solo_signup_assigned` | :608 | 1 | L | N | R | registration · — | The one message that feature owes the player (registration-assign.ts:378). |
| 24 | `registration_dispute_alert` | :634 | 2 | A | N | W | dispute · `<id>:created` | A chargeback with a response deadline. Re-sent on replay (F7). |
| 25 | `registration_dispute_lost` | :647 | 2 | A | N | W | dispute · `<id>:lost` | Money lost. |
| 26 | `sponsor_invoice` | :659 | 2 | L | N | R | sponsor_order · order id | The sponsor cannot pay without it. |
| 27 | `sponsor_receipt` | :671 | 2 | L | N | W | sponsor_order · payment intent | Proof of payment. |
| 28 | `sponsor_refund` | :683 | 2 | L | N | R / W | sponsor_order · refund id | Money returned. |
| 29 | `sponsor_dispute_alert` | :695 | 2 | A | N | W | dispute · `<id>:created` | As inventory #24. |
| 30 | `sponsor_dispute_won` | :725 | 2 | A | N | W | dispute · `<id>:won` | The money outcome. |
| 31 | `sponsor_dispute_lost` | :710 | 2 | A | N | W | dispute · `<id>:lost` | The money outcome. |
| 32 | `pass_revoked` | :740 | 2 | A | N | W | charge · charge id | Features withdrawn after a refund. |
| 48 | `trial_ending` | :1643 | 2 | A | T | W | subscription · Stripe event id | The only notice before money moves (email.ts:1637-1640). |
| 1 | `email_verification` | :288 | 3 | L | T | R | user · — | Account access. |
| 2 | `funnel_claim` | :316 | 3 | L | T | R | funnel_draft · — | Doubles as sign-in for a new organiser. |
| 11 | `email_change_confirmation` | :461 | 3 | L | T | R | user · —; older rows ended (§5) | A 24 h link the user is waiting for. |
| 12 | `email_change_notice` | :470 | 3 | L | T | R | user · request id | The security notice to the old address. |
| 13 | `account_deletion` | :479 | 3 | L, scrubbed | T | R | user · user id | The person's record of the deletion (§6). |
| 14 | `org_invite` | :491 | 3 | L | N | R | org_invite · — | The response reports `email_sent`. |
| 3 | `claim_invite` | :326 | 3 | L | T | R | person · — | Two send sites; the use-case site is reached from seven places (F9). |
| 4 | `official_invite` | :349 | 3 | L | T | R | official · — | The response reports `email_sent`. |
| 5 | `official_assigned` | :359 | 4 | L | T | R | division_event:official · same | One email per apply, each listing its own fixtures. F5. |
| 6 | `official_assignment_changed` | :387 | 4 | L | T | R | fixture:official · — | A later move restates the time and place. F5. |
| 7 | `suspension_confirmed` | :402 | 4 | A | T | R | suspension · `<id>:confirmed` | The player may not play. |
| 9 | `suspension_served` | :438 | 4 | A | T | W (read path) | suspension · `<id>:served` | Replaces the `xmin` check (§8). |
| 8 | `match_report_submitted` | :418 | 4 | A | T | R | match_report · report id | The organiser has to review it. |
| 15 | `group_transfer_offer` | :504 | 4 | A | N | R | subscription:recipient · — | Billing-group ownership. |
| 16 | `group_transfer_complete` | :519 | 4 | A | N | R | subscription:recipient · transfer | Billing-group ownership. |
| 17 | `group_org_removed` | :533 | 4 | A | N | R | group_org · detach | Billing-group membership. |
| 18 | `group_org_left` | :548 | 4 | A | N | R | group_org · detach | Billing-group membership. |
| 10 | `funnel_reminder` | :452 | 5 | L | T | W | funnel_draft · `<id>:reminder` | A reminder; carries the fix in §9. |
| 47 | `staff_registration_refund_failed` | :1590 | 5 | S | T | W | registration · refund attempt | Money: a player was not refunded. |
| 35 | `staff_credit_pack_grant_failed` | :812 | 5 | S | T | W | checkout session | Money: paid but not granted. |
| 36 | `staff_size_pack_grant_failed` | :852 | 5 | S | T | W | checkout session | Money: paid but not granted. |
| 37 | `staff_stream_credit_grant_failed` | :904 | 5 | S | T | W | checkout session | Money: paid but not granted. |
| 40 | `staff_pass_credit_reversal_incomplete` | :1073 | 5 | S | T | W | charge | Money: not reversed. |
| 41 | `staff_pass_rung_mismatch` | :1168 | 5 | S | T | W | checkout session | Money: mint refused. |
| 42 | `staff_pass_unknown_competition` | :1256 | 5 | S | T | W | checkout session | Money: mint refused. |
| 38 | `staff_stream_credit_clawback` | :967 | 5 | S | T | W | charge or dispute | Money: claw-back. |
| 46 | `staff_extra_org_reprice_failed` | :1523 | 5 | S | T | W | subscription + price | Money: price drift. |
| 33 | `staff_dispute_alert` | :755 | 5 | S | T | W | dispute · `<id>:<phase>` | A platform chargeback. |
| 49 | `staff_connect_bank_changed` | :1675 | 5 | S | T | W | Stripe event id | Payout health. |
| 34 | `staff_stuck_events` | :778 | 5 | S | T | W | Stripe event id | Ops. Today it already fires once per event. |
| 39 | `staff_stream_pack_price_drift` | :1018 | 5 | S | T | W | lookup key + price | Ops. |
| 43 | `staff_ai_run_cost` | :1327 | 5 | S | T | W | AI run id | Cost watch. |
| 44 | `staff_earn_grant_volume` | :1391 | 5 | S | T | W | UTC day | Abuse watch. |
| 45 | `staff_extra_org_allowance` | :1444 | 5 | S | T | W | group + count | Ops. |

**Wave-5 keys as built:** the staff rows above give the pre-ruling once-keys. The code follows the wave-5 plan's
P-W5-4/5/6/11/16 and owner Q2: the reversal is keyed by payment_intent, the reprice and price-drift keys carry the UTC
day, the AI-cost key is a minted id per run, and the allowance key is subscription + count.

**Counts:** wave 1 has 5 kinds, wave 2 has 10, wave 3 has 8, wave 4 has 9 and wave 5 has 17, which makes 49. With
`magic_link` and `chess_invite` that is 51. Wave 1 also carries the shared machinery (§5, §6), both parked fixes, the change that
makes `chess_invite` an A kind, and the generalised deletion sweep (§6, controller call 2026-10-25), because the
recipient column, the once-key and the cancel function are schema all the later waves build on. Wave 5 ends by deleting `send()`
and `sendWithResult`. `deliver` and `checkSendable` stay, imported only by the outbox.

## Schema and migrations

**Numbering.** The latest migration on `main` is V471 (`V471__all_stages_free.sql`). V472 is free on `main` but planned by W2d
(F4). Each wave takes `main`'s max + 1 when its PR is opened. There is no outOfOrder, and the peer sessions are told when one
merges.

**Greenfield stance** (`docs/superpowers/RULES.md:30-34`): the table is altered in place, with no backfill. Rows written before
wave 1 have a null `recipient_user_id` and resolve as literal addresses, which is acceptable.

**Wave 1's migration:**
- Adds `recipient_user_id uuid references users(id) on delete set null`, with a partial index where it is not null. The deletion
  and resolution paths look rows up by it.
- Adds `dedupe_key text`, with `unique (kind, dedupe_key) where dedupe_key is not null`.
- Replaces `email_outbox_replace_older()` with a function that, in order:
  - inserts nothing and supersedes nothing when the once-key already exists;
  - otherwise supersedes older rows by `recipient_user_id` when both rows carry one, and by `lower(recipient)` when not;
  - keeps the org fence and SECURITY DEFINER with a pinned `search_path`.
- Adds `email_outbox_cancel(…)`, SECURITY DEFINER and org-fenced, granted to `app_user` (§7).
- Widens the kind CHECK by the five wave-1 kinds.

**Statuses:** no thirteenth status (§7).

**Waves 2 to 5:** each migration only drops and re-adds `email_outbox_kind_valid`. The same PR updates `OUTBOX_KINDS` and the
`outbox-schema.test.ts:50` literal.

## Test strategy

The house rules are `docs/superpowers/TEST-STRATEGY.md` and the four test types in `docs/superpowers/RULES.md:93-110`. Locally,
only the scoped tests run. e2e is dispatched on CI with `--ref <branch>`, because `e2e.yml` only triggers on a push to `main`.

**Shared harness (built in wave 1)**

1. **`forEachOutboxKind`.** For each member of `OUTBOX_KINDS`, a registered scenario calls the kind's *real* producer (the route
   handler or use case, not the builder) on seeded data, then runs the real `dispatchNow` or `runOutboxTick({ onlyIds })`
   (`worker.ts:79-93`). Only the transport is replaced (`transport.ts:1`). For each kind it asserts:
   - at least one row was written;
   - the transport was called exactly once per row, with `email-outbox/<id>`;
   - the subject equals the *dictionary's* subject for the recipient's locale, never the builder's output. *Controller call
     (2026-10-25):* the 15 inline-English staff kinds have no dictionary entry, so for them the harness asserts a frozen literal
     subject, typed into the test;
   - the row ends `sent` with its body nulled;
   - a second tick sends nothing.

   The harness reports how many kinds it checked. Zero is a failure, and a kind with no scenario fails by name.
2. **Counted against a source outside the code.** Each merged wave's kinds are this document's table, and the final total of 51
   is the inventory's count of senders. `OUTBOX_KINDS.length` is never the expected value.
3. **The no-second-path scan.** No module outside `server/email-outbox` may import `deliver`, `sendWithResult` or `checkSendable`.
   `email.ts` keeps an exact allowlist of the `send*` functions still to migrate. It shrinks each wave and is empty after wave 5,
   so a newly added direct sender fails the scan.
4. **The sequence for every kind** (rule 1):
   - a second call: a replay, a second cron run or a double press still sends one email;
   - an empty input: no recipient gives no row and no throw;
   - after a withdrawal or void: wave 1's void, and a refund after a withdrawal;
   - another sport: not applicable, because the emails do not vary by sport, except the two funnel emails, which name a sport and
     run two.
5. **CI has no Resend key,** so a row ends `dead` (`no_api_key`) at its first attempt (`scripts/smoke.ts:8975-8977`). An R kind's
   e2e asserts the row is no longer waiting and has no body, following `e2e/passwordless-login.spec.ts:43-55`. A W kind's e2e
   asserts the queued row (kind, ref, recipient, subject) and leaves the send to the vitest sweep, because for its first 30 s a
   new row belongs to `dispatchNow`, not the worker.

**Per wave, the four test types**

| Wave | Unit / integration | E2E | Smoke | Regression |
|---|---|---|---|---|
| 1 | Sweep of the 5 kinds plus `chess_invite`; the four resolution cases in §6, including a reclaim after a lapsed lease (not clean); replace by user id; a duplicate once-key leaves the original row untouched; two concurrent inserts with one once-key give one row and no aborted transaction; the void cancel; the chess hook does nothing once the bridge row is gone; *(controller call, 2026-10-25)* the generalised deletion sweep: the account's rows are scrubbed whatever their status, queued ones end `account_deleted`, FU2's case-variant address stays untouched, and rows outside D5's scope stay. | Registration submit leaves one `registration_confirmation` row; unpairing an opened online round ends its queued invites `round_voided` (`e2e/online-chess-desk.spec.ts:368` already reads the outbox). | Registration submit, next to `checkSignInOutbox` (`scripts/smoke.ts:8978`). | F8: a 503 sweep gives one row and one Checkout session, with no lease released. F3: an invite after an email change goes to the new address, and an invite queued under the old address is caught by deletion. A deleted account is never mailed. FU2's case-variant tests stay green. |
| 2 | Sweep of 10; `runEvent` on the same event twice gives one row per kind; `charge.refunded` replayed after a later handler throws gives one refund email. | A Stripe sandbox checkout, refund and dispute. Connect-only events are covered on the owner's stg walk. | A signed sandbox event gives one row. | F7 (the double send on replay). |
| 3 | Sweep of 8; a second request replaces the first (verification, funnel, org invite); older email-change confirmations end; the wave's account kinds fall inside wave 1's deletion sweep; the deletion notice's address is gone once its row ends. | `funnel.spec.ts`, `org-team` invite (`email_sent`), `officials-directory.spec.ts`, `player-accounts.spec.ts`, email change. | Funnel start and org invite rows. | The deletion notice keeps no address after its row ends. |
| 4 | Sweep of 9; a suspension is served exactly once across two concurrent flips; two applies give two emails; two moves of one fixture give one. | `official-marks-reports.spec.ts` and the `walkthrough/scheduling-officials-handoff` walkthrough. | An officials assignment row. | F5: the labels and the email are in one locale. |
| 5 | Sweep of 17; an unset staff address gives no row; an alert written after a rolled-back transaction survives (R2); the no-second-path allowlist is empty. | The funnel reminder through the cron route; one staff-alert path. | The funnel reminder through the cron route. | §9 (stamped despite a failed send) and F6 (two concurrent runs). |

**Mutate each guard once (rule 5)**

| Guard | Mutation | The test that must fail |
|---|---|---|
| The once-key check in the trigger | Delete it. | The replay test: two rows, or the original replaced. |
| *(Controller call, 2026-10-25)* The `on conflict … do nothing` clause | Drop it. | The two-concurrent-inserts test aborts a transaction. |
| Replace by user id | Drop the clause. | The email-change test, which sees two emails. |
| The deleted-account case in resolution | Skip it. | A deleted person is mailed. |
| The key-clean test on a changed address | Make it `true`. | The ambiguous-retry test, which mails a second address. |
| The void cancel | Remove the call. | The void test mails the invite. |
| In-transaction enqueue, per kind | Move it after commit. | The rollback test finds an orphan row. |
| No lease release in the payment-reminder sweep | Restore the release. | The F8 test creates a second Checkout session. |
| The funnel `reminded_at is null` claim | Drop it. | The concurrent test sends two reminders. |
| The no-second-path scan | Add a direct `deliver` import. | The scan. |
| R2 (staff alert on the pool) | Write it on the failing transaction. | The rollback test loses the alert. |

## Rollout

- **One PR per wave, strictly in order.** Every wave edits `email.ts`, `constants.ts`, the kind CHECK and
  `outbox-schema.test.ts`, so the waves cannot run in parallel.
- **Before each merge:** CI, dispatched e2e, a review pass, and the owner's stg walk. Each wave merges on the owner's explicit go.
- **The cutover rule:** a kind's `send*` is deleted in the same commit that adds its enqueue, so no build can mail one event both
  ways. A webhook retried across a rolling deploy is caught by the once-key.
- **Cron is unchanged:** every minute on prod and the 5-minute tick on stg, both already set.
- **Throughput:** at 20 rows a tick, a 200-row sweep (`registrations.ts:5081`, `funnel/remind/route.ts:32`) drains in about 10
  minutes on prod and about 50 on stg. That is acceptable for reminders, so no constant changes.
- **Before wave 1 reaches prod:**
  - The boot readiness log reports no outbox key problem. After phase 3, every action that sends email depends on that key, not
    just sign-in.
  - The prod Resend webhook gains `delivered`, `delivery_delayed` and `suppressed` (approved in phase 1).
- **Rollback:** reverting a wave's code brings back its `send*`. Rows already queued still go out, because the worker ignores
  kind and the CHECK still accepts them. A revert loses no email.

## Anti-goals

- **No double send during the cutover:** the cutover rule, R6, the once-key, and a replay test for each kind.
- **No lost email:** the row is committed exactly when its fact is (R1); a refusal fails the action (D1); nothing catches and
  carries on inside a transaction (R4); staff alerts are written on the pool (R2).
- **No new English-only strings.** The three reworded notices (D3) go into all four locale dictionaries. The staff alerts keep their
  existing inline English, which is staff-only (F2). Log lines are not user copy.
- **No body in plaintext:** every body is sealed under the KEK, and several carry live tokens: the funnel claim, the verification
  link, the email-change link, org, claim and official invites, the registration manage link, and the Checkout URL.
- **No user waits longer than today** (§4).
- **No second sending path** (the scan).

## Owner decisions (2026-10-25)

The owner answered the five open questions with "Apply rec": every recommendation was accepted. No open questions remain. Each
decision is folded into the sections it affects.

- **D1. A refused enqueue fails the action** (no outbox key, a render error, a refused statement), everywhere. This is phase 1's
  rule, and it keeps "committed means queued" true. Callers follow R4: no catch-and-continue inside a transaction, and a savepoint
  only where a caller must survive a refused email (§3, §8). Accepted cost: during a key misconfiguration, registrations and
  webhooks fail, not just sign-in. The boot readiness log shows it first, and Stripe retries its webhooks for three days.
- **D2. A send that may already have reached Resend keeps its first address** when the account's address changes (§6). This
  keeps "never twice". Accepted cost: a rare invite lands in the old inbox. A deleted account is never mailed.
- **D3. The three "email failed" notices are reworded in all four locales, and no status UI is added** (§11).
- **D4. Locale is the account's (through an existing link only), then the org's default, then English** (§2). This fixes F5.
- **D5. Deleting an account ends and scrubs only the account's own rows:** A-kind rows matched by user id, plus its own sign-in
  and invite mail. Other records' L-kind rows and staff alerts are untouched (§6). Accepted cost: such a row can carry the deleted
  person's address for up to 90 days.

## Left to the builder

- Exact column and index names, and the signature and fence of `email_outbox_cancel`.
- How `enqueueEmail` reports a de-duplicated insert.
- How the account-deletion notice's address is scrubbed when its row ends.
- Confirming every ref and once-key id at its call site, within §5's rule.
- Splitting wave 1 into plan tasks: the schema and harness, then the parked fixes, then the five kinds.
- Re-reading phase 2's merged readers of `latestEmailStatus` before wave 1. Resolution rewrites `recipient`, and the void ends
  rows that phase 2 shows.
