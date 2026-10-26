# Phase 4 (roadmap): the Seazn Email Service

Owner decision, 2026-10-26. Starts after phase 3 wave 5 deletes `send()`, when the outbox is the only way an email leaves.

## SCHEDULED (owner, 2026-10-26, later the same day): un-parked

Phase 4 goes ahead after phase 3 wave 5, no trigger needed. Owner rulings: **Q2 = Upstash QStash** (Pay as you go; QStash publishes to the service and runs the `/sweep` schedule) and **Q3 = the same repo**: a workspace app `apps/email-service` in this monorepo, still its own Fly app (as `apps/cron-worker` is). Plan consequence (Q3): T4 Step 1 creates `apps/email-service`, the T4 fixture copy becomes an import, T6's workflows become jobs in `ci.yml`/`stg.yml`/`prod.yml`, and Part 2's contract (if ever) is a workspace package. Q1 (templates A or B), Q2(b) (prod `min_machines_running`) and Q4 (prod Resend events) are still asked at phase-4 start. The earlier park text follows for the record.

## Superseded: PARKED (owner, 2026-10-26)

Phase 4 is parked after phase 3 wave 5. Start it only when one of these triggers happens: (1) email volume makes sending slow app requests or the minute cron cannot keep up; (2) a security review asks for the Resend key to be held outside the web app; (3) a second product or service needs to send email. Until then the in-app outbox (worker on the Cloudflare minute cron, `dispatchNow` for request emails, the Resend webhook in the app) is the design. The phase-3 obligations stay: no send path bypasses the outbox; dispatch/worker/webhook keep no app-render dependency. The owner questions below stay open until the phase starts.

## Shape

```
Seazn App ──(same tx)──> email_outbox row            source of truth, unchanged
    └─ after commit ──> QStash publish {id}           dedup id = outbox id
QStash ──POST (signed, retried)──> Email Service /dispatch {id}
    → claimQueuedRow(id) → unseal → resolve recipient → Resend → write status
QStash schedule (every minute) ──> /sweep             lost publishes, retries, expiry
Resend webhook ──> Email Service /webhooks/resend
```

- The Email Service has its own repo and its own Fly app, and shares the Postgres database.
- QStash carries only the row id. Addresses and bodies never leave our database; bodies stay sealed with the KEK.
- A publish that is lost costs at most one sweep interval of delay. It never loses an email.
- Secrets that move to the service: EMAIL_OUTBOX_KEK, RESEND_API_KEY, RESEND_WEBHOOK_SECRET, plus the QStash signing keys.

## Rejected
- **Redis pub/sub:** it persists nothing, so a subscriber that is down loses the message. A publish next to a database commit is also a dual write.
- **Postgres LISTEN/NOTIFY:** it needs a connection held open, and that conflicts with Fly suspending the machine.
- **A separate database or queue as the record:** the enqueue would no longer be atomic with the business write.

## Phase 3 obligations (waves 2-5)
- No new send path that bypasses the outbox.
- dispatch/worker/webhook modules keep no dependency on app rendering (bodies are rendered and sealed at enqueue), so they lift out cleanly.

Size: about one wave.

## Templates, data and transactions (owner Q&A, 2026-10-26)

- **Templates live in the service (recommended, option B).** The app enqueues a versioned *facts* snapshot
  (`{kind, v, facts}`), sealed with the KEK at enqueue. The service owns rendering. A contract test in the app pins
  each kind's facts schema against the service's version, so a fact the template needs cannot go missing silently.
  Final confirmation of option B is due at phase 4 start.
- **Facts vs send-time lookups.** The facts are what the email *says* (amounts, names, round, links) and are frozen at
  enqueue. Only three things are resolved at send: the recipient address, the locale, and whether the account is deleted.
- **Multi-statement transactions.** The service shares the Postgres database through a restricted role (outbox tables
  only plus the few lookups above). The app's enqueue is an INSERT inside the caller's own transaction, so a rolled-back
  business write leaves no row, and a committed one always has its row. The QStash publish happens only after commit;
  a publish lost to a crash is picked up by the minute sweep. So "was the email queued?" is answered by the row, never by
  the publish.
- **A value that changes while queued is NOT updated automatically.** The row holds X. If X becomes Y, the code path that
  changes it must re-enqueue (the supersede trigger then replaces the old queued row) or cancel it. Every wave's per-kind
  table carries a "changed-while-queued" entry naming those facts and that path, with a test (wave 2 Global
  Constraints). The service never re-reads business data to "refresh" a body.

## Known split owed by phase 4 (wave 1 final review)
The outbox core still imports `@/lib/email` (`attempt.ts` → `checkSendable`, `transport.ts` → `deliver`, `classify.ts` → a type), and that module also renders (every builder loads the dictionaries). Phase 4 must move `checkSendable` and `deliver` out of it, so the service carries no rendering code. Wave 1 added no new rendering import to the core (`recipient.ts`, `cancel.ts`, `locale.ts`, `account-deletion.ts` are clean); the no-second-path scan pins the two allowed imports.
