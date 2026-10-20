# Email Outbox (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Queue the sign-in link and the online-chess round invite in a Postgres outbox written in the caller's transaction, attempt each at once after commit, retry with backoff from a cron worker, and record Resend delivery status per row.

**Architecture:** One table `email_outbox` (V468, replacing the unused `email_queue`), sealed bodies under the existing `LICHESS_TOKEN_KEK` envelope, and a server module `apps/web/src/server/email-outbox/` with four entry points: `enqueueEmail` (on the caller's `Tx`), `dispatchNow` (first attempt, after commit), `runOutboxTick` (retry worker behind `/api/cron/email-outbox`) and `applyProviderEvent` (the Resend webhook). Per-kind side effects (the chess seat stamp) hang off a lookup table of kind hooks, so the core never imports a usecase.

**Tech Stack:** Next.js route handlers, postgres.js (`sql`, `Tx`, `tx.savepoint`), Flyway SQL migrations, AES-256-GCM envelope (`server/relay/crypto.ts`), Resend REST API, Cloudflare cron Worker (`apps/cron-worker`), vitest (node env), Playwright (CI dispatch only), `scripts/smoke.ts`.

**Spec:** `docs/superpowers/specs/2026-10-19-email-outbox-design.md` (binding). Executors read both.

## Global Constraints

- **Worktree:** `/Users/ashokhein/github/seazn.club/.claude/worktrees/email-outbox`, branch `feat/email-outbox`. Every shell command starts `cd <that path>[/apps/web] &&` in the SAME call; use `/usr/bin/git`. Never `git stash` (stack shared with the main checkout).
- **Migration number:** `V468__email_outbox.sql` (origin/main max was V467 on 2026-10-20). Re-check at PR time: `/usr/bin/git fetch -q origin main && /usr/bin/git ls-tree --name-only origin/main db/migration/deltas/ | sort -V | tail -1`; if it moved, renumber (an unmerged migration is amended, never corrected forward). **No Flyway `outOfOrder`.** When it merges, tell the W2c and r2 sessions the number taken (send the fact, not an approval).
- **Retry schedule (spec):** 1 min, 5 min, 15 min, 1 h, 6 h after the previous attempt; 6 attempts in all; then `dead`.
- **Idempotency key (spec):** `email-outbox/<id>`; Resend keeps it 24 h; the whole retry span must stay well under that, pinned by a test derived from the schedule constant.
- **Expiry (spec):** sign-in link 15 min (`TTL_MINUTES`, `lib/login-link.ts:6`); chess invite = that board's check-in deadline (`windowFor(anchor).deadline`, `server/external-play/window.ts:67`).
- **Statuses (spec), exactly 12:** `queued sending sent delayed delivered bounced complained failed suppressed expired dead replaced`.
- **Result handling (spec):** 2xx → `sent`; 429 / 5xx / timeout / network → retry; 400 / 403 / 422 → `dead`; 409 `concurrent_idempotent_requests` → retry; 409 `invalid_idempotent_request` → `dead` + `log.error`.
- **Credentials at rest (spec):** body sealed with the Lichess-token KEK; `app_user` gets INSERT only; no `RETURNING` on the insert; metadata rows deleted after 90 days. This plan nulls the body as soon as a row leaves `queued`/`sending` (stricter than "terminal": nothing re-sends a `sent` row), enforced by a CHECK.
- **Cadence (owner ruling 2026-10-20):** prod `* * * * *`; stg on the existing `*/5 * * * *` tick, no new stg trigger. This uses the 5th of the Free plan's 5 cron triggers (stg 2 + prod 3).
- **Webhook signature (spec):** `RESEND_WEBHOOK_SECRET` unset ⇒ 401 unless `NODE_ENV !== "production"` (stg and every harness server run `NODE_ENV=production`, so they refuse too).
- **Copy:** no new user-facing strings and no dictionary keys. `retrying` is a count in a JSON response only; the UI keeps showing what it shows today.
- **Do not move** the funnel claim email (`funnel/start/route.ts`) or any other `send*Email` caller (phase 3). `send()`'s existing callers must behave exactly as today.
- **Pool nesting:** `dispatchNow` and every outbox read/write run on the pooled `sql` AFTER the caller's transaction closes; never inside `withTenant` (see `lib/db.ts:216-250`, #996). Only `enqueueEmail` / `extendEmailExpiry` take the caller's `Tx`.
- **Tests (TEST-STRATEGY.md, binding):** anti-vacuity (every sweep asserts its checked count; zero is a failure); expected values derived from the spec's rulebook or from the constants, never from the code under test; every guard added is mutated once (record the mutation and that a test went red in the commit body); sequence tests owed: retry-then-success, success-then-late-webhook, replaced-then-retry, expiry, a second send/second call, empty input.
- **DB tests** use `describe.skipIf(!HAS_DB)` with `const HAS_DB = !!process.env.DATABASE_URL;` (CI unit shards have none). Stand up the DB with the `seazn-local-env` skill (`db:apply` AND `sync:sports`; confirm `show data_directory` is yours).
- **Scoped tests only, never the full suite.** Verify recipe (`$OUT` = your own subdirectory of the session scratchpad, never shared):
  `cd <WT>/apps/web && rtk proxy npx vitest run <exact paths> --reporter=json --outputFile=$OUT/<task>.json; echo EXIT=$?` then `jq '{p:.numPassedTests,f:.numFailedTests,t:.numTotalTests,files:[.testResults[].name]}' $OUT/<task>.json`. Green = `f == 0`, `t` equals the number of `it(` in the listed files, and every listed path appears in `files` under THIS worktree. Never trust the `rtk` PASS/FAIL summary.
- **Typecheck** (owed by every task): `cd <WT>/apps/web && rtk proxy node ../../node_modules/typescript-native/bin/tsc --noEmit; echo EXIT=$?` (and `cd <WT>/apps/cron-worker && rtk proxy npm run typecheck` in Task 4).
- **Four test types per task** (RULES.md): unit, E2E, smoke, regression. E2E runs only by CI dispatch (`gh workflow run e2e.yml --ref feat/email-outbox`), never locally; the E2E legs for Tasks 1-5 and 8 are the Task 6/7 specs, which drive their code through the real routes.
- Every change ships a test that fails without it. No PNGs or evidence files in the repo. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push.

## Review Focus

1. **A deadline extension after the invite was queued.** The arbiter adds time (`checkin-extend.ts:127-133`); a retry that falls after the old deadline but before the new one must still go out. Test in Task 8 (`extendEmailExpiry`).
2. **Resend accepted, but our request timed out (or the process died before the update).** The row returns to `queued`; the retry must reuse the same key (one email) and a webhook that arrives for it must still land. Tests in Task 3 (same key on retry) and Task 5 (outbox-tag fallback on a `queued` row whose `provider_id` is null).
3. **A bounce on a board where a game now exists.** Releasing the seat stamp there would unbind a live board. The chess hook must leave a board that no longer takes invites alone. Test in Task 7.
4. **A sealed body that will not open** (KEK rotated or a damaged byte). The row must go `dead` with `last_error = 'body_unreadable'`, and the tick must move on. Without that, it re-claims the row forever. Tests in Task 3 (dispatch) and Task 4 (tick).
5. **Two members of a team seat sharing one address, or differing only in case.** One email reaches that address, and the seat still counts as invited. Test in Task 7.

---

## File Structure

| Path | Responsibility |
|---|---|
| `db/migration/deltas/V468__email_outbox.sql` | drop `email_queue`; table, CHECKs, indexes, replace trigger, RLS + INSERT-only grant |
| `apps/web/src/server/email-outbox/constants.ts` | kinds, statuses, status groups, schedule, lease, batch, pacing, retention, key format |
| `apps/web/src/server/email-outbox/seal.ts` | seal/open `{html,text}` under `LICHESS_TOKEN_KEK` |
| `apps/web/src/server/email-outbox/classify.ts` | pure: `SendResult` → `sent/retry/dead/suppressed`; `nextAttemptAt` |
| `apps/web/src/server/email-outbox/transport.ts` | the one test seam: `deliver()` → `sendWithResult()` |
| `apps/web/src/server/email-outbox/enqueue.ts` | `enqueueEmail`, `extendEmailExpiry` (caller's `Tx`) |
| `apps/web/src/server/email-outbox/attempt.ts` | `attemptClaimed` (one row), `dispatchNow` |
| `apps/web/src/server/email-outbox/hooks.ts` | `KIND_HOOKS` lookup table + `afterEndedBadly` |
| `apps/web/src/server/email-outbox/worker.ts` | `runOutboxTick`, `OutboxTickReport` |
| `apps/web/src/server/email-outbox/provider-events.ts` | `applyProviderEvent` (webhook → row) |
| `apps/web/src/server/email-outbox/status.ts` | `latestEmailStatus`, `purgeOldEmails` |
| `apps/web/src/server/email-outbox/index.ts` | barrel (no logic) |
| `apps/web/src/app/api/cron/email-outbox/route.ts` | cron route |
| `apps/web/src/server/usecases/external-play/seat-stamp.ts` | leaf: `STAMP_COLUMN`, `claimSeat`, `releaseSeat`, `chessSeatRef`, `CHESS_SEAT_REF_TYPE` (moved from `invite.ts`, re-exported there) |
| `apps/web/src/server/usecases/external-play/invite-outbox-hook.ts` | chess `onEndedBadly`: release the seat when every row for its stamp ended badly |
| `apps/web/src/server/usecases/__tests__/_invite-mail.ts` | shared test harness: render-capture + transport mock for chess invites |

---

### Task 1: Migration V468 — `email_outbox`, replace trigger, INSERT-only grant

**Files:**
- Create: `db/migration/deltas/V468__email_outbox.sql`
- Create: `apps/web/src/server/email-outbox/constants.ts`
- Test: `apps/web/src/server/email-outbox/__tests__/outbox-schema.test.ts`

**Interfaces:**
- Produces (constants.ts):
  - `OUTBOX_KINDS = ["magic_link", "chess_invite"] as const`; `type OutboxKind`
  - `OUTBOX_STATUSES` (the 12, spec order); `type OutboxStatus`
  - `RETRYABLE_STATUSES = ["queued", "sending"]` (the only statuses that may hold a body)
  - `REPLACEABLE_STATUSES = ["queued", "sending", "sent", "delayed"]` (non-terminal)
  - `LIVE_STATUSES = ["queued", "sending", "sent", "delayed", "delivered"]` (can still deliver)
  - `ENDED_BADLY_STATUSES = ["bounced", "complained", "failed", "suppressed", "expired", "dead"]`
- Produces (table `email_outbox`): `id uuid pk` (client-generated), `kind`, `ref_type text`, `ref_id text`, `org_id uuid null → organizations(id) on delete cascade`, `meta jsonb not null default '{}'` (non-secret kind data), `recipient text`, `subject text`, `body_sealed bytea null`, `transactional boolean`, `status text default 'queued'`, `attempts int default 0`, `next_attempt_at timestamptz default now()`, `lease_until timestamptz null`, `expires_at timestamptz not null`, `last_error text`, `provider_id text`, `created_at`, `sent_at`, `status_at timestamptz default now()`.

- [ ] **Step 1: Write the failing tests** (`describe.skipIf(!HAS_DB)`; seed one org + rows through privileged `sql`; helper `row(over)` inserts with sensible defaults and `expires_at = now() + interval '1 hour'`)

```ts
it("accepts every declared status and refuses an undeclared one", async () => {
  let accepted = 0;
  for (const s of OUTBOX_STATUSES) { await row({ status: s, body: RETRYABLE_STATUSES.includes(s) ? BODY : null, lease: s === "sending" }); accepted++; }
  expect(accepted).toBe(OUTBOX_STATUSES.length);
  expect(OUTBOX_STATUSES.length).toBe(12); // spec §Statuses
  await expect(row({ status: "opened" })).rejects.toMatchObject({ code: "23514" });
});
it("refuses a body on any status outside RETRYABLE_STATUSES (checked count = 10)", …);   // constraint email_outbox_body_only_while_retryable
it("refuses lease_until unless status = 'sending', and 'sending' without a lease", …);   // email_outbox_lease_only_while_sending
it("a new row for the same kind+ref+recipient replaces every older REPLACEABLE row, nulls its body and lease, and leaves terminal rows, other recipients and other kinds alone", async () => {
  // seed one row per OUTBOX_STATUSES for ref R / "Ann@x.test", plus: same ref other recipient (queued), same ref other kind (queued)
  await row({ ref: R, to: "ann@X.test" });                       // differs only in case
  const replaced = await idsWithStatus("replaced", R);
  expect(replaced.length).toBe(REPLACEABLE_STATUSES.length + 1); // +1: the seeded 'replaced' row stays replaced
  // every originally-REPLACEABLE row now has body_sealed null and lease_until null; the delivered/dead/... rows are byte-identical; other recipient + other kind still 'queued'
});
it("app_user may INSERT inside withTenant without RETURNING, and the replace trigger still runs", …);
it("app_user cannot SELECT, UPDATE or DELETE email_outbox (42501 each), nor insert for another org", …);
it("email_queue is gone", async () => {
  expect((await sql`select to_regclass('email_queue') as t`)[0].t).toBeNull();
});
```

- [ ] **Step 2: Run to verify they fail** — verify recipe on the test path. Expected: FAIL (`relation "email_outbox" does not exist`).

- [ ] **Step 3: Write `V468__email_outbox.sql`**
  - Header comment: why (spec link), what replaces `email_queue` (created by both `v1-baseline/V028` and `deltas/V104`, read and written nowhere — `git grep -n email_queue` shows only those two files), and the INSERT-only stance.
  - `drop table if exists email_queue;` then the table above with CHECKs: `kind in (…2)`, `status in (…12)`, `attempts >= 0`, `ref_type <> ''`, `ref_id <> ''`, `recipient <> ''`, the two named constraints from Step 1.
  - Indexes: `email_outbox_due_idx (next_attempt_at) where status = 'queued'`; `email_outbox_lease_idx (lease_until) where status = 'sending'`; unique `email_outbox_provider_idx (provider_id) where provider_id is not null`; `email_outbox_ref_idx (ref_type, ref_id, created_at desc)`; `email_outbox_created_idx (created_at)`; `email_outbox_replace_idx (kind, ref_type, ref_id, lower(recipient)) where status in ('queued','sending','sent','delayed')`.
  - Replace trigger, `security definer` + pinned search_path (the V451 shape, `V451__online_chess_board_and_camera.sql:161-170`), because an `app_user` caller holds no UPDATE:

```sql
create function email_outbox_replace_older() returns trigger
  language plpgsql security definer
  set search_path = ${flyway:defaultSchema}, pg_temp as $$
begin
  update email_outbox
     set status = 'replaced', body_sealed = null, lease_until = null, status_at = now()
   where kind = new.kind and ref_type = new.ref_type and ref_id = new.ref_id
     and lower(recipient) = lower(new.recipient) and id <> new.id
     and status in ('queued', 'sending', 'sent', 'delayed');
  return new;
end $$;
create trigger email_outbox_replace_older before insert on email_outbox
  for each row execute function email_outbox_replace_older();
```
  - `enable` + `force row level security`; `create policy email_outbox_enqueue on email_outbox for insert to app_user with check (org_id = current_org_id());` `grant insert on email_outbox to app_user;` (no select/update/delete).

- [ ] **Step 4: Apply and run** — `db:apply` against your DB (skill §), then the verify recipe. Expected: all pass; `t` = 6.
- [ ] **Step 5: Mutate once each** — (a) drop `lower()` from the trigger; (b) remove `'delayed'` from the trigger's status list; (c) drop the body CHECK. Each must red a named test; restore.
- [ ] **Step 6: Commit** — `feat(db): V468 email_outbox replaces the unused email_queue`.

---

### Task 2: `sendWithResult` — idempotency key, message id, timeout; `send()` unchanged

**Files:**
- Modify: `apps/web/src/lib/email.ts:107-157` (`SendOptions`, `send`)
- Test: `apps/web/src/lib/__tests__/email-send-result.test.ts` (no DB: `vi.stubGlobal("fetch", …)`; `vi.mock("@/lib/db")` so `isSuppressed` reads a stubbed row)

**Interfaces:**
- Produces:
```ts
export type SendResult =
  | { ok: true; providerId: string | null }
  | { ok: false; reason: "no_api_key" | "suppressed" }
  | { ok: false; reason: "http"; status: number; errorName: string | null; detail: string }
  | { ok: false; reason: "network"; detail: string };          // includes "timeout"
export interface SendOptions { to: string; subject: string; html: string; text: string; transactional?: boolean;
  idempotencyKey?: string; tags?: Readonly<Record<string, string>>; timeoutMs?: number }
export async function sendWithResult(opts: SendOptions): Promise<SendResult>;
// send(opts): Promise<boolean> stays private and becomes `(await sendWithResult(opts)).ok`
```

- [ ] **Step 1: Write the failing tests**
```ts
it("sends Idempotency-Key exactly when given, and no such header for today's callers", …);  // header name "Idempotency-Key"
it("2xx returns the provider id from the JSON body's `id`", …);                               // { ok: true, providerId: "re_123" }
it("2xx without an id is still ok, providerId null", …);
it("non-2xx returns status + Resend's error `name` (JSON body {statusCode,name,message}); a non-JSON body gives errorName null", …);
it("a fetch that rejects is network; one past timeoutMs is network with detail 'timeout'", …);   // AbortSignal.timeout
it("tags go out as Resend's [{ name, value }] array", …);
it("no RESEND_API_KEY: no_api_key, fetch never called, the 'would send' warning kept", …);
it("non-transactional to a suppressed address: suppressed, fetch never called", …);
it("regression: an existing sender (sendVerificationEmail) still resolves true on 2xx and false on 500 and on no key", …);
```
- [ ] **Step 2: Run, verify FAIL** (`sendWithResult is not exported`).
- [ ] **Step 3: Implement** in `email.ts`. Read the 2xx body with `res.json().catch(() => null)`. Read the error body as text, then try a JSON parse for `name`. Pass `signal: AbortSignal.timeout(opts.timeoutMs)` only when `timeoutMs` is given, so today's callers are unchanged. Keep today's `console.error` lines and never log the body.
- [ ] **Step 4: Run, verify PASS** (`t` = 9) + typecheck.
- [ ] **Step 5: Mutate** — drop the `idempotencyKey` header line → test 1 reds; restore.
- [ ] **Step 6: Commit** — `feat(email): sendWithResult carries an idempotency key and returns the message id`.

---

### Task 3: Outbox core — seal, enqueue, classify, dispatchNow, kind hooks

**Files:**
- Modify: `apps/web/src/server/email-outbox/constants.ts` (add schedule constants)
- Create: `seal.ts`, `classify.ts`, `transport.ts`, `enqueue.ts`, `attempt.ts`, `hooks.ts`, `index.ts` under `apps/web/src/server/email-outbox/`
- Modify: `apps/web/src/server/external-play/secrets.ts:1-9` (comment: it is no longer the only module naming `LICHESS_TOKEN_KEK`; the outbox seals under it per spec)
- Test: `__tests__/classify.test.ts`, `__tests__/seal.test.ts` (pure), `__tests__/dispatch.test.ts` (DB; `vi.mock("@/server/email-outbox/transport")`; `vi.stubEnv` `LICHESS_TOKEN_KEK = "ab".repeat(32)`, `RESEND_API_KEY = "re_test"`)

**Interfaces:**
- Consumes: Task 1 table + constants; Task 2 `sendWithResult`, `SendResult`.
- Produces:
```ts
// constants.ts
export const RETRY_DELAYS_MS: readonly number[];          // [1, 5, 15, 60, 360] minutes
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;     // 6
export const SEND_TIMEOUT_MS = 15_000;
export const LEASE_MS = 2 * 60_000;
export const RESEND_IDEMPOTENCY_TTL_MS = 24 * 3_600_000;
export const STG_TICK_MS = 5 * 60_000;                      // the slowest worker cadence (stg)
export const idempotencyKey = (id: string) => `email-outbox/${id}`;
// seal.ts
export type EmailBody = { html: string; text: string };
export function sealBody(b: EmailBody): Buffer | null;     // null ONLY when KEK unusable AND no RESEND_API_KEY
export function openBody(sealed: Uint8Array): EmailBody;    // throws on a bad key / damaged bytes
export class OutboxKeyUnavailableError extends Error { code = "EMAIL_OUTBOX_KEK_MISSING" }
// classify.ts
export type Verdict = "sent" | "retry" | "dead" | "suppressed";
export function classifyResult(r: SendResult): Verdict;
export function nextAttemptAt(attemptsMade: number, from: Date): Date | null;   // null ⇒ no attempt left
// transport.ts — the ONLY seam tests mock
export type DeliverMessage = { to: string; subject: string; html: string; text: string; transactional: boolean; idempotencyKey: string; tags: Record<string, string> };
export async function deliver(m: DeliverMessage): Promise<SendResult>;          // sendWithResult({...m, timeoutMs: SEND_TIMEOUT_MS})
// enqueue.ts
export type OutboxMessage = { kind: OutboxKind; refType: string; refId: string; orgId: string | null; to: string;
  subject: string; html: string; text: string; transactional: boolean; expiresAt: Date; meta?: Record<string, string> };
export async function enqueueEmail(db: Tx | typeof sql, m: OutboxMessage): Promise<string>;   // client uuid; insert WITHOUT returning
// hooks.ts
export type EndedRow = { id: string; kind: OutboxKind; refType: string; refId: string; status: OutboxStatus; meta: Record<string, string> };
export const KIND_HOOKS: Record<OutboxKind, { onEndedBadly?: (row: EndedRow) => Promise<void> }>;   // both empty in this task
export async function afterEndedBadly(rows: readonly EndedRow[]): Promise<void>;   // per row; a throwing hook is logged, never rethrown
// attempt.ts
export type AttemptOutcome = "sent" | "retrying" | "dead" | "suppressed" | "expired" | "deferred";
export async function attemptClaimed(row: ClaimedRow): Promise<{ outcome: AttemptOutcome; verdict: Verdict | null; rateLimited: boolean }>;
export async function dispatchNow(ids: readonly string[], opts?: { now?: Date }): Promise<Map<string, AttemptOutcome>>;
```
- Behaviour decided here, not left open:
  - `dispatchNow` makes **first attempts only**. It claims `status = 'queued' and attempts = 0 and expires_at > $now`, setting `sending`, `attempts = 1` and `lease_until = now() + LEASE_MS`. It never reads `next_attempt_at`. Any id it cannot claim is `deferred`: already taken, replaced, or a second call. `opts.now` (default `new Date()`) is the caller's clock, used only for the expiry test. Callers with a `deps.now` pass it. This is why the caller's clock is used: the chess suites open rounds on clocks up to 30 min in the past (`open-round.test.ts:503`, `invite.test.ts:315`), and judging expiry on the DB clock would expire every invite they write. The worker, which has no caller, uses the DB's `now()`.
  - Before claiming, `dispatchNow` marks its ids that are `queued` with `expires_at <= $now` as `expired` (body null), then runs the hooks.
  - When `RESEND_API_KEY` is unset, the row goes `dead` with `last_error = 'no_api_key'`, and `deliver` is never called. Keep today's `"[email] RESEND_API_KEY not set — would send …"` warning. A `body_sealed` that is null (or fails to open) while a key IS set goes `dead`, with `last_error` set to `'body_missing'` (or `'body_unreadable'`).
  - `deliver` is called with `idempotencyKey(id)` and `tags: { outbox: id }`. A `deliver` that throws counts as `{ reason: "network" }`.
  - Every post-attempt update is conditional on `status = 'sending' and id = $id`, so a row replaced mid-attempt stays `replaced`. The updates are: `sent` (provider_id, sent_at, body null, lease null); `retry` → `queued` with `next_attempt_at = nextAttemptAt(attempts)`, or `dead` when that is null; `dead`; `suppressed`. `last_error` is `"http <status> <errorName>"` or `"network <detail>"`, at most 200 chars, never body text. A 409 `invalid_idempotent_request` also calls `log.error`.
  - After the first 429 in one `dispatchNow` call, the remaining ids are not attempted. They stay `queued` with `attempts = 0`, their outcome is `deferred`, and the worker picks them up next.
  - `retry` maps to the outcome `retrying`.
  - `afterEndedBadly` runs for every row that reached an `ENDED_BADLY_STATUSES` status in the call.
  - `dispatchNow([])` returns an empty Map and issues no statement (check with `statementCount()`).

- [ ] **Step 1: Write the failing pure tests**
```ts
it("RETRY_DELAYS_MS is the spec's schedule", () =>
  expect(RETRY_DELAYS_MS).toEqual([1, 5, 15, 60, 360].map((m) => m * 60_000)));   // spec §Goals — the one typed-in table
it("MAX_ATTEMPTS is 6 (spec)", () => expect(MAX_ATTEMPTS).toBe(6));
it("nextAttemptAt: after attempt n waits RETRY_DELAYS_MS[n-1]; after MAX_ATTEMPTS, null", () => {
  let checked = 0;
  for (let n = 1; n < MAX_ATTEMPTS; n++) { expect(nextAttemptAt(n, T).getTime()).toBe(T.getTime() + RETRY_DELAYS_MS[n - 1]!); checked++; }
  expect(nextAttemptAt(MAX_ATTEMPTS, T)).toBeNull();
  expect(checked).toBe(MAX_ATTEMPTS - 1);
});
it("the whole retry span stays under half Resend's 24 h key life, worst case", () => {
  const worst = RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) + MAX_ATTEMPTS * (SEND_TIMEOUT_MS + LEASE_MS + STG_TICK_MS);
  expect(worst).toBeLessThan(RESEND_IDEMPOTENCY_TTL_MS / 2);
});
it("classifyResult follows the spec's result table", () => {
  const table: [SendResult, Verdict][] = [ /* 200→sent; 429, 500, 502, 503, 504, network, timeout → retry;
     400, 403, 422 → dead; 409 concurrent_idempotent_requests → retry; 409 invalid_idempotent_request → dead;
     no_api_key → dead; suppressed → suppressed; 401 → dead (other 4xx); 409 unknown name → retry */ ];
  for (const [r, v] of table) expect(classifyResult(r), JSON.stringify(r)).toBe(v);
  expect(table.length).toBe(17);
});
// seal.test.ts
it("seal/open round-trips and the sealed bytes do not contain the link", …);
it("KEK unusable + RESEND_API_KEY set → OutboxKeyUnavailableError; KEK unusable + no key → null", …);
```
- [ ] **Step 2: Write the failing DB tests** (`dispatch.test.ts`; `deliver` is a `vi.fn` per case)
```ts
it("committed ⇔ queued: enqueue on a transaction that rolls back leaves no row", …);
it("enqueue stores a sealed body (no plaintext link in body_sealed), status queued, attempts 0, the given expires_at and meta", …);
it("2xx → sent: provider_id, sent_at, body null, attempts 1; deliver got idempotencyKey(id) and tags {outbox:id}", …);
it("500 → retrying: queued, attempts 1, next_attempt_at = status_at + RETRY_DELAYS_MS[0] (±2 s), body kept, last_error 'http 500 …'", …);
it("422 → dead, body null, afterEndedBadly called once with that row", …);
it("409 invalid_idempotent_request → dead + log.error; 409 concurrent_idempotent_requests → retrying", …);
it("a deliver that throws → retrying", …);
it("expired before the first attempt → expired, deliver never called, hook called", …);   // expiry (sequence)
it("no RESEND_API_KEY → dead 'no_api_key', deliver never called, would-send warning", …);
it("a body that will not open → dead 'body_unreadable', deliver never called", …);      // Review Focus 4
it("a second dispatchNow on the same id → deferred, deliver called once in total", …);   // second send
it("replaced-then-retry: row A retrying, enqueue B for the same ref+recipient → dispatchNow([A]) deferred, A stays replaced", …);
it("a row replaced while its attempt is in flight stays replaced after the 2xx", …);   // replace from inside deliver
it("first 429 stops the call: 3 ids, deliver called once, the other two deferred with attempts 0", …);
it("non-transactional to a suppressed address → suppressed, deliver never called", …);
it("dispatchNow([]) → empty map and zero statements", …);
```
- [ ] **Step 3: Run, verify FAIL** (modules missing).
- [ ] **Step 4: Implement** the modules to the interfaces and behaviour above. `seal.ts` calls `sealWith`/`openWith("LICHESS_TOKEN_KEK", …)` from `server/relay/crypto.ts:64-79` on `JSON.stringify(body)`. `enqueue.ts` generates the id with `randomUUID()` and inserts with no `returning`. `hooks.ts` imports nothing from `server/usecases`.
- [ ] **Step 5: Run, verify PASS** (`t` = 5 + 2 + 16) + typecheck.
- [ ] **Step 6: Mutate once each** — (a) drop `and status = 'sending'` from the `sent` update (the in-flight replace test must red); (b) drop the `attempts = 0` claim predicate (second-send test reds); (c) drop the 429 break (the 429 test reds); (d) make `nextAttemptAt` return a date at `MAX_ATTEMPTS`. Restore each.
- [ ] **Step 7: Commit** — `feat(email-outbox): enqueue in the caller's transaction, first attempt after commit`.

---

### Task 4: Retry worker, cron route, per-environment schedule

**Files:**
- Create: `apps/web/src/server/email-outbox/worker.ts`, `apps/web/src/app/api/cron/email-outbox/route.ts`
- Modify: `apps/cron-worker/src/schedule.ts`, `apps/cron-worker/src/run.ts:90-111`, `apps/cron-worker/wrangler.json` (prod crons only), `scripts/smoke.ts`
- Test: `apps/web/src/server/email-outbox/__tests__/worker.test.ts` (DB), `apps/web/src/app/api/cron/email-outbox/__tests__/route.test.ts`, `apps/cron-worker/test/schedule.test.ts`, `apps/cron-worker/test/drift.test.ts`, `apps/cron-worker/test/run.test.ts`

**Interfaces:**
- Consumes: `attemptClaimed`, `afterEndedBadly`, constants (Task 3).
- Produces:
```ts
// constants.ts additions
export const WORKER_BATCH_SIZE = 20;
export const MIN_SEND_INTERVAL_MS = 500;      // Resend's 2 requests/second
export const TICK_BUDGET_MS = 40_000;         // under the 60 s prod cadence
// worker.ts — the route imports this TYPE from worker.ts directly (drift.test.ts reads the route's imports for `failed: number`)
export type OutboxTickReport = { claimed: number; sent: number; retried: number; dead: number; suppressed: number;
  expired: number; failed: number; deferred: number };
export async function runOutboxTick(opts?: { sleep?: (ms: number) => Promise<void>; budgetMs?: number }): Promise<OutboxTickReport>;
// cron-worker schedule.ts
export type EnvName = "stg" | "prod";
export const MINUTE_CRON = "* * * * *";
// Job.trigger: string | Readonly<Record<EnvName, string>>
export function triggerFor(job: Job, env: string): string;                    // throws `triggerFor: no trigger for env "<x>" on job <id>`
export function triggersOf(env: string, jobs?: readonly Job[]): string[];
export function dueJobs(scheduledTime: Date, cron: string, env: string, jobs?: readonly Job[]): Job[];
```
- `runOutboxTick` runs in this order:
  1. In one statement, set `expired` (body null, lease null) on rows that are `queued`, or `sending` with an expired lease, and whose `expires_at <= now()`.
  2. In one statement, set `dead` with `'attempts_exhausted'` on `sending` rows with an expired lease and `attempts >= MAX_ATTEMPTS`.
  3. Claim one row at a time, up to `WORKER_BATCH_SIZE`. The claim is a CTE that picks `(status = 'queued' and next_attempt_at <= now()) or (status = 'sending' and lease_until < now())`, with `attempts < MAX_ATTEMPTS and expires_at > now()`, `order by next_attempt_at, id`, `limit 1 for update skip locked`. It sets `sending`, `attempts + 1` and a lease. This is the `registrations.ts:1177-1182` pattern.
  4. Before each claim, wait out `MIN_SEND_INTERVAL_MS` since the last `deliver`, and stop if the budget is spent.
  5. Stop at the first 429. Rows left unclaimed count toward `deferred`, read as a count of rows due now.
  6. Run `afterEndedBadly` for every row ended in steps 1-3.
  7. `failed` counts rows whose attempt threw inside our own code, which is caught per row.
- Job row: `{ id: "email-outbox", path: "/api/cron/email-outbox", trigger: { prod: MINUTE_CRON, stg: STREAM_TICK_CRON }, due: { kind: "every" }, retry: false, manual: true, failureCounts: ["data.failed"] }`. It is never retried, because the next firing is the retry and skip-locked plus the lease make an overlap safe. `firstSlotOfHour` learns `* * * * *` (true only at minute 0). `runDue` passes `env.ENV_NAME`. Prod's `wrangler.json` crons become `["17 * * * *", "*/5 * * * *", "* * * * *"]`, and stg is unchanged. Update the comment at `schedule.ts:39-40` to read "5 of the Free plan's 5".

- [ ] **Step 1: Write the failing web tests**
```ts
// worker.test.ts — rows made due by `update … set next_attempt_at = now() - interval '1 second'`; deliver mocked; sleep stubbed to record waits
it("retry-then-success: 500 on dispatch, then a tick sends it — attempts 2, the SAME idempotency key both times", …);
it("MAX_ATTEMPTS retryable failures end dead: deliver called exactly MAX_ATTEMPTS times across dispatch + ticks", …);
it("a stale lease is reclaimed; a stale lease with attempts = MAX_ATTEMPTS goes dead 'attempts_exhausted'", …);
it("a row past expires_at is expired by the tick and never delivered; the hook runs", …);
it("claims at most WORKER_BATCH_SIZE per tick and paces at MIN_SEND_INTERVAL_MS (recorded waits = claimed - 1, each ≥ the constant)", …);
it("stops at the first 429; the rest stay queued and count in deferred", …);
it("an unreadable body goes dead and the tick moves on to the next row", …);   // Review Focus 4
it("two ticks in parallel never deliver one row twice (skip locked)", …);
it("an empty table: every count 0, deliver never called", …);
// route.test.ts (runOutboxTick mocked)
it("503 when CRON_SECRET is unset, 401 on a wrong secret, 200 with the report under data on the right one", …);
```
- [ ] **Step 2: Write the failing cron-worker tests**
```ts
it("email-outbox runs every minute on prod and on the 5-minute tick on stg", () => {
  const job = JOBS.find((j) => j.id === "email-outbox")!;
  expect(triggerFor(job, "prod")).toBe(MINUTE_CRON);
  expect(triggerFor(job, "stg")).toBe(STREAM_TICK_CRON);
});
it("prod's */5 firing does not also run email-outbox (no double run at :05)", …);
it("triggerFor refuses an unknown env by name", …);
it("firstSlotOfHour('* * * * *') is true at minute 0 only", …);
it("the account's distinct triggers across both envs stay within the Free plan's 5", () => {
  const total = triggersOf("stg").length + triggersOf("prod").length;
  expect(total).toBeGreaterThan(0);
  expect(total).toBeLessThanOrEqual(5);
});
// drift.test.ts: the wrangler check compares each env with triggersOf(env); the counters total becomes 10
```
- [ ] **Step 3: Run both suites, verify FAIL.**
- [ ] **Step 4: Implement** `worker.ts` and the route. The route copies the auth block of `app/api/cron/external-play/route.ts:28-33` and returns `runOutboxTick()`. Then make the cron-worker changes. In `run.ts`, existing callers of `triggersOf()` / `dueJobs()` gain the env argument. Update `run.test.ts` and `index.test.ts` call sites to match, and change no assertion other than that.
- [ ] **Step 5: Smoke** — add `emailOutboxCronSmoke()` to `scripts/smoke.ts`, beside `externalPlayOtBSmoke` (`scripts/smoke.ts:21598`): a wrong secret answers 401 or 503; with `CRON_SECRET` set, the right secret answers 200 with `data.failed === 0` and a number for every report key. Wire it into the run list the way `externalPlayOtBSmoke` is.
- [ ] **Step 6: Run, verify PASS** — web paths (`t` = 10). Cron worker: `cd <WT>/apps/cron-worker && rtk proxy npx vitest run test/schedule.test.ts test/drift.test.ts test/run.test.ts test/index.test.ts --reporter=json --outputFile=$OUT/t4-cron.json`. Typecheck both packages.
- [ ] **Step 7: Mutate** — (a) remove `skip locked` (the parallel test reds); (b) map stg to `MINUTE_CRON` (the cadence test reds). Restore both.
- [ ] **Step 8: Commit** — `feat(email-outbox): retry worker on prod's minute and stg's 5-minute tick`.

---

### Task 5: Webhook — delivery statuses on the row, fail-closed signature

**Files:**
- Create: `apps/web/src/server/email-outbox/provider-events.ts`
- Modify: `apps/web/src/app/api/webhooks/resend/route.ts` (whole file; keep the suppression branches), `scripts/smoke.ts`
- Test: `apps/web/src/server/email-outbox/__tests__/provider-events.test.ts` (DB), `apps/web/src/app/api/webhooks/resend/__tests__/route.test.ts` (no DB; `applyProviderEvent` and `suppress` mocked)

**Interfaces:**
- Consumes: `afterEndedBadly`, statuses (Tasks 1, 3).
- Produces:
```ts
export const PROVIDER_EVENT_STATUS = { "email.delivered": "delivered", "email.delivery_delayed": "delayed",
  "email.bounced": "bounced", "email.complained": "complained", "email.failed": "failed", "email.suppressed": "suppressed" } as const;
export async function applyProviderEvent(type: string, data: Record<string, unknown>): Promise<"moved" | "ignored" | "unknown" | "not_tracked">;
```
- Matching: by `data.email_id = provider_id`. When no row matches, fall back to the outbox tag `data.tags`, accepting both an object map (`{ outbox: id }`) and an array (`[{ name: "outbox", value: id }]`); a tag match also writes `provider_id`. If neither matches, the answer is `unknown`. A type not in the map is `not_tracked`.
- Monotonic rule. Rank: `queued`/`sending` 0, `sent` 1, `delayed` 2, `delivered` 3, `bounced`/`complained`/`failed`/`suppressed` 4. A row moves only when the target's rank is strictly greater than its current rank and its current status is one of the ranked ones. `replaced`, `expired` and `dead` never move.
  - This follows the spec: a late `delivered` wins over `delayed`, a late `delayed` after `delivered` is ignored, and the final four never move. It deliberately also lets `complained`/`bounced` move a `delivered` row, because a complaint arrives after delivery by nature.
  - Every move sets `status_at` and nulls the body and lease. Run `afterEndedBadly` on a move into an `ENDED_BADLY_STATUSES` status. The update is one statement with the rule in its `where`, so two racing events cannot regress a row.
- Route: if `RESEND_WEBHOOK_SECRET` is unset and `NODE_ENV === "production"`, answer 401 and log an error. If it is unset elsewhere, accept and log a warning, as today. Bounce and complaint keep calling `suppress()` (`route.ts:54-73`), and then every event calls `applyProviderEvent`. The route answers 200 for `unknown` and `not_tracked`. A thrown `applyProviderEvent` answers 500, so Resend retries it.

- [ ] **Step 1: Write the failing tests**
```ts
it("each tracked event moves a sent row to its mapped status (checked = 6 = keys of PROVIDER_EVENT_STATUS), body null, status_at set", …);
it("the spec's monotonic cases", async () => {
  const cases: [from: OutboxStatus, event: string, to: OutboxStatus][] = [
    ["delayed", "email.delivered", "delivered"], ["delivered", "email.delivery_delayed", "delivered"],
    ["bounced", "email.delivered", "bounced"], ["failed", "email.bounced", "failed"], ["suppressed", "email.complained", "suppressed"],
    ["delivered", "email.complained", "complained"], ["sent", "email.delivery_delayed", "delayed"],
    ["replaced", "email.delivered", "replaced"], ["expired", "email.delivered", "expired"], ["dead", "email.delivered", "dead"],
  ];
  for (const [from, ev, to] of cases) expect(await statusAfter(from, ev), `${from} + ${ev}`).toBe(to);
  expect(cases.length).toBe(10);
});
it("success-then-late-webhook: dispatch → sent, delivered → delivered, a late delayed → still delivered", …);
it("an unknown email_id → 'unknown', no row changed", …);
it("timeout-then-accepted: a queued row with no provider_id is matched by its outbox tag (object and array shapes), moves to delivered, gets provider_id", …);   // Review Focus 2
it("a move into bounced runs afterEndedBadly once; a move into delivered does not", …);
// route.test.ts
it("no secret + NODE_ENV production → 401 and applyProviderEvent never called", …);
it("no secret + NODE_ENV development → accepted with a warning", …);
it("a bad Svix signature → 401; a good one → 200", …);   // sign in the test from Svix's rule: base64 HMAC-SHA256 of `${id}.${ts}.${body}`, key = base64-decoded secret minus `whsec_`
it("email.bounced still suppresses the address AND calls applyProviderEvent", …);
it("applyProviderEvent throwing → 500", …);
```
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** `provider-events.ts` and the route changes.
- [ ] **Step 4: Smoke** — `resendWebhookSmoke()` in `scripts/smoke.ts`: an unsigned POST to `/api/webhooks/resend` answers 401, since the smoke server is production-mode either with no secret or with a secret and no signature.
- [ ] **Step 5: Run, verify PASS** (`t` = 6 + 5) + typecheck.
- [ ] **Step 6: Mutate** — (a) change the rank comparison to `>=` (a final-to-final case reds); (b) delete the production refusal (the first route test reds). Restore both.
- [ ] **Step 7: Commit** — `feat(email-outbox): Resend webhook moves rows monotonically and fails closed without a secret`.

---

### Task 6: Move the sign-in link onto the outbox

**Files:**
- Modify: `apps/web/src/lib/login-link.ts:5-17`, `apps/web/src/lib/email.ts:177-184` (replace `sendMagicLinkEmail`), `apps/web/src/app/api/auth/magic-link/route.ts:36-54`, `apps/web/src/lib/dev-links.ts:12` (comment names the new path)
- Modify (consumers of the removed sender): `apps/web/src/lib/__tests__/scrub-login-token.test.ts:61-68`, `apps/web/src/lib/__tests__/_fake-sql.ts` (add `begin`), `apps/web/src/app/api/auth/__tests__/lichess-link-login-round-trip.test.ts:61-67`
- Modify: `apps/web/e2e/passwordless-login.spec.ts`, `scripts/smoke.ts`
- Test: `apps/web/src/app/api/auth/magic-link/__tests__/route-outbox.test.ts` (DB; transport mocked; `next/headers` mocked as the round-trip test does)

**Interfaces:**
- Consumes: `enqueueEmail`, `dispatchNow` (Task 3).
- Produces:
```ts
// login-link.ts
export async function issueLoginLink(userId: string, db: Tx | typeof sql): Promise<{ token: string; expiresAt: Date }>;  // same delete + insert as today, on `db`
export async function createLoginLink(userId: string): Promise<string>;   // unchanged signature: (await issueLoginLink(userId, sql)).token
// email.ts
export type EmailContent = { subject: string; html: string; text: string };
export async function magicLinkEmail(to: string, link: string, locale?: Locale): Promise<EmailContent>;   // render only; `sendMagicLinkEmail` is deleted
```
- Route: the code from `stampTermsAcceptance` onward is unchanged. Then `const id = await sql.begin(async (tx) => { const { token, expiresAt } = await issueLoginLink(userId, tx); … return enqueueEmail(tx, { kind: "magic_link", refType: "user", refId: userId, orgId: null, to: email, ...(await magicLinkEmail(email, link)), transactional: true, expiresAt }); })`, then `await dispatchNow([id])` before responding. The response body and the `mayExposeDevLink()` decision stay byte-for-byte as today. Dev and e2e capture keeps working because it reads `login_url` from this response (`e2e/helpers.ts:517-520`, `e2e/auth.setup.ts:31-32`), not from mail.

- [ ] **Step 1: Write the failing tests**
```ts
it("POST writes one magic_link row: ref user/<userId>, transactional, expires_at = the login_links row's expires_at", …);
it("the link the transport received is the login_url the route exposed (real producer → consumer)", …);
it("dispatch happens inside the request: deliver was called before the response resolved", …);
it("a second POST: the first (retrying after a 500) row is replaced, its login_links row deleted, and only the new link is delivered", …);
it("a 500 from Resend in production mode: 200, the unchanged message, no login_url", …);   // stub NODE_ENV production, AUTH_DEV_LINKS unset
it("committed ⇔ queued: enqueue refusing (KEK unusable, key set) leaves no new login_links row", …);
it("the response message is still 'Check your email — a sign-in link is on its way.'", …);
```
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** the interfaces and the route. In the two consumer tests, rename the mocked `sendMagicLinkEmail` to `magicLinkEmail`; the mock records `{ to, link }` as before and returns `{ subject: "s", html: "", text: "" }`. In `scrub-login-token.test.ts` also mock `@/server/email-outbox` (`enqueueEmail` returns `randomUUID()`, `dispatchNow` resolves `new Map()`): that suite runs on `_fake-sql`, which gains `begin = (fn) => fn(fakeSql)`.
- [ ] **Step 4: E2E** — in `passwordless-login.spec.ts`'s first test, after the dev link signs in, read with `withDb` (`e2e/helpers.ts:539`): `select status, body_sealed is null as cleared from email_outbox where kind = 'magic_link' and lower(recipient) = lower(${email})`. Expect exactly 1 row, with `cleared === true` and status `dead` (CI e2e servers have no Resend key). Dispatch only through CI.
- [ ] **Step 5: Smoke** — in `scripts/smoke.ts`, after a `signIn` that has `DATABASE_URL`, assert one `magic_link` row for that address with a null body.
- [ ] **Step 6: Run, verify PASS.** Paths: the new test, `scrub-login-token.test.ts`, `lichess-link-login-round-trip.test.ts`, `login-link.test.ts`, `dev-links.test.ts`. Typecheck.
- [ ] **Step 7: Mutate** — move `dispatchNow` inside `sql.begin` (the producer → consumer test must red or hang: the row is not committed yet). Restore.
- [ ] **Step 8: Commit** — `feat(auth): the sign-in link is queued with its token and sent after commit`.

---

### Task 7: Move the chess round invite onto the outbox

**Files:**
- Create: `apps/web/src/server/usecases/external-play/seat-stamp.ts` (move `STAMP_COLUMN`, `claimSeat`, `releaseSeat` from `invite.ts:194-231`; re-export them from `invite.ts`)
- Create: `apps/web/src/server/usecases/external-play/invite-outbox-hook.ts`
- Create: `apps/web/src/server/usecases/__tests__/_invite-mail.ts`
- Modify: `invite.ts:128-192` (`sendFixtureInvite` → `queueFixtureInvite`), `invite.ts:251-346` (resend), `open-round.ts:478-580`, `apps/web/src/lib/email.ts:246-257` (`sendExternalPlayInviteEmail` → `externalPlayInviteEmail`, render only), `apps/web/src/server/email-outbox/hooks.ts` (register the chess hook), `apps/web/src/lib/open-round.ts:24-32` and `apps/web/src/server/api-v1/schemas.ts:2393-2399` (`retrying`), `apps/web/src/server/api-v1/openapi.ts:209` (resend response `{ emailed, retrying }`), `openapi/v1.json` (regenerate: `npm run openapi:gen`)
- Modify (every test that mocks the removed sender; 14 files): `app/api/v1/fixtures/[id]/external-play/extend-checkin/__tests__/route.test.ts`, `app/api/v1/stages/[id]/extend-checkin/__tests__/route.test.ts`, `app/api/v1/stages/[id]/open-round/__tests__/route.test.ts`, `components/v2/desk/__tests__/open-round-batches-reachability.test.tsx`, `server/usecases/__tests__/{external-play-batch-gap,external-play-batches,external-play-checkin-extend-create,external-play-checkin-extend,external-play-sweep,online-chess-flag-gates}.test.ts`, `server/usecases/external-play/__tests__/{invite,open-round-property,open-round-view,open-round}.test.ts`
- Modify: `apps/web/e2e/online-chess-desk.spec.ts` (the "every send fails here" test, ~line 353)
- Test: `apps/web/src/server/usecases/external-play/__tests__/invite-outbox.test.ts` (DB)

**Interfaces:**
- Consumes: `enqueueEmail`, `dispatchNow`, `AttemptOutcome`, `KIND_HOOKS`, `EndedRow`, `LIVE_STATUSES` (Tasks 1, 3).
- Produces:
```ts
// seat-stamp.ts (leaf: imports only postgres types)
export const CHESS_SEAT_REF_TYPE = "fixture_seat";
export function chessSeatRef(fixtureId: string, colour: Colour): string;          // `${fixtureId}:${colour}`
// claimSeat / releaseSeat: signatures unchanged
// email.ts
export async function externalPlayInviteEmail(to: string, args: ExternalPlayInviteArgs, locale?: Locale): Promise<EmailContent>;
// invite.ts
export async function queueFixtureInvite(tx: Tx, a: /* sendFixtureInvite's argument */ & { stampedAt: Date }): Promise<string[]>;  // one row per recipient
export function seatOutcome(outcomes: readonly AttemptOutcome[]): "invited" | "retrying" | "failed";
export async function resendExternalPlayNotice(…): Promise<{ emailed: number; retrying: number }>;
// lib/open-round.ts
| { opened: true; invited: number; retrying: number; skipped: OpenRoundSkip[] }
// invite-outbox-hook.ts
export async function chessInviteEndedBadly(row: EndedRow): Promise<void>;
```
- Rows: `kind: "chess_invite"`, `refType: CHESS_SEAT_REF_TYPE`, `refId: chessSeatRef(fixtureId, colour)`, `orgId: f.orgId`, `expiresAt: windowFor(a.anchor).deadline`, `meta: { fixtureId, colour, stampedAt: a.stampedAt.toISOString() }`, `transactional: true`. Rendering and token minting are the same as today: `mintMatchRoomToken` is a pure JWT, safe inside the transaction.
- `seatOutcome` (the spec's response contract): any `sent` → `invited`; otherwise any `retrying` or `deferred` → `retrying`; otherwise (including no rows at all) → `failed`, which reports as `send_failed`.
- `openRound`: claiming and queueing now happen inside the existing transaction, one `tx.savepoint` per seat (`claimSeat` then `queueFixtureInvite` with `stampedAt = now`). A throw inside one seat's savepoint rolls back only that seat; it is logged and the seat reports `send_failed`, which keeps the review-M1 guarantee. After commit, the meetings are retired as today and then `dispatchNow(allIds, { now })` runs. A claimed seat with zero rows (no recipients) is released at once with `releaseSeat`, as today. The audit payload gains `retrying`. The send loop and the post-send `releaseSeat` at `open-round.ts:524-553` are deleted: the hook now does the release.
- `resendExternalPlayNotice`: inside the existing transaction, the `for update` read also selects `white_emailed_at, black_emailed_at`. Every seat (both, as today) is queued with `stampedAt` = this call's stamp when claimed, otherwise the stamp already there. After commit it runs `dispatchNow` and counts with `seatOutcome`.
- `chessInviteEndedBadly` runs in one `sql.begin`:
  1. Lock the bridge row `for update`. If there is none, or `!bridgeTakesInvites(row)`, return. A game exists, so leave it alone (Review Focus 3).
  2. If any row with the same `ref_type`/`ref_id` and `meta->>'stampedAt'` has a status in `LIVE_STATUSES`, return.
  3. Otherwise call `releaseSeat(tx, fixtureId, colour, new Date(meta.stampedAt))`. It is conditional on that exact stamp, so a later open's stamp is never cleared. A throw is logged by `afterEndedBadly`.
- Harness `_invite-mail.ts`. Each test file keeps its own `vi.hoisted` `mail` object, shaped `{ sent, fail, throws, retry, holdFirst }` as today plus `retry`, and mocks two modules whose factories `await import("…/_invite-mail")`:
  - `@/lib/email`: `externalPlayInviteEmail` is replaced by `renderInviteForTest`, which returns `text = JSON.stringify({ to, args, locale })`.
  - `@/server/email-outbox/transport`: `deliver` is replaced by `deliverForTest(mail, msg)`. It parses `msg.text`, honours `holdFirst`, and maps the mail sets to results:
    - `fail` → `{ ok: false, reason: "http", status: 422, … }` (permanent, as `false` was);
    - `retry` → status 503;
    - `throws` → it throws;
    - otherwise it pushes `{ to, fixtureUrl, deadlineLabel, opensLabel, locale }` onto `mail.sent` and returns `{ ok: true, providerId }`.
  - `stubOutboxEnv()` (`beforeEach`) stubs `LICHESS_TOKEN_KEK` and `RESEND_API_KEY`.
  - Staged hooks that targeted `../invite` `sendFixtureInvite` / `releaseSeat` now target `queueFixtureInvite` and `../seat-stamp` `releaseSeat`.
  - Expected behaviour changes, each made by name in the diff:
    - `{ opened: true, invited, skipped }` gains `retrying: 0`;
    - a `mail.throws` address now reads as `retrying` with its stamp kept (previously `send_failed`);
    - `{ emailed }` gains `retrying`.
  - No other assertion may change.

- [ ] **Step 1: Write the failing tests** (`invite-outbox.test.ts`)
```ts
it("openRound writes one chess_invite row per recipient per claimed seat, ref fixture_seat/<id>:<colour>, expires_at = windowFor(anchor).deadline", …);
it("a team seat: one row per member address; status is per person", …);
it("two members sharing one address (or differing in case) → one email delivered, the seat invited", …);   // Review Focus 5
it("open rolls back ⇒ no outbox rows (a seat's savepoint throw rolls back only that seat's stamp and rows)", …);
it("first attempt 2xx → invited; 503 → retrying with the stamp kept; 422 → send_failed with the stamp released", …);
it("no recipients → send_failed and released, zero rows", …);
it("a retrying seat whose rows later all end badly (tick → dead) is released by the hook; one live row keeps it stamped", …);
it("a webhook bounce on the last live row releases the seat; on a board with a game on file it does not", …);   // Review Focus 3
it("Resend writes a fresh row each time and replaces the older non-terminal one; a delivered older row keeps the seat stamped when the new one dies", …);
it("a release after a re-open never clears the newer stamp (meta.stampedAt mismatch)", …);
it("no Resend key (dev, CI, e2e): every row dead 'no_api_key', invited 0, every seat send_failed and released — today's behaviour", …);
```
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** in this order: the `seat-stamp.ts` move, `externalPlayInviteEmail`, `queueFixtureInvite`, `openRound`, the resend, the hook plus its registration in `KIND_HOOKS.chess_invite`, then the schema, `openapi.ts` and the regen. Then migrate the 14 test files to the harness. Run `no-import-cycle.test.ts` too: `email-outbox/hooks.ts → invite-outbox-hook.ts → seat-stamp.ts` must not close a loop through `invite.ts`.
- [ ] **Step 4: E2E** — in `online-chess-desk.spec.ts`'s "every send fails here" test, read `email_outbox` for the round's fixtures via `withDb`. Expect one row per recipient per seat (count > 0), all `dead` with `last_error = 'no_api_key'` and null bodies. This proves that the real open writes the rows the arbiter's phase-2 column will read. Dispatch through CI only.
- [ ] **Step 5: Run, verify PASS.** Paths: the new test, the 14 migrated files, `no-import-cycle.test.ts`, and `lib/email-templates/__tests__/external-play-invite.test.ts`. Typecheck; `npm run openapi:gen && /usr/bin/git diff --exit-code openapi/` after committing the regen.
- [ ] **Step 6: Mutate once each** — (a) drop the `bridgeTakesInvites` check in the hook; (b) drop the `stampedAt` match from the live-sibling query; (c) make `seatOutcome` treat `deferred` as `failed`. Each must red a named test; restore.
- [ ] **Step 7: Commit** — `feat(chess): round invites go through the outbox; a seat is released only when every row for its stamp ended badly`.

---

### Task 8: `latestEmailStatus`, 90-day purge, expiry follows a check-in extension

**Files:**
- Create: `apps/web/src/server/email-outbox/status.ts`
- Modify: `apps/web/src/server/email-outbox/enqueue.ts` (add `extendEmailExpiry`), `worker.ts` (purge step + `purged` count), `index.ts`, `apps/web/src/server/usecases/external-play/checkin-extend.ts:127-140`
- Test: `apps/web/src/server/email-outbox/__tests__/status.test.ts` (DB), extend `worker.test.ts`, extend `server/usecases/__tests__/external-play-checkin-extend.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 3, 4, 7 (`CHESS_SEAT_REF_TYPE`, `chessSeatRef`).
- Produces:
```ts
export const RETENTION_DAYS = 90;          // constants.ts
export const PURGE_BATCH = 500;            // constants.ts
export type EmailStatusRow = { refId: string; recipient: string; kind: OutboxKind; status: OutboxStatus; at: Date };
export async function latestEmailStatus(refType: string, refIds: readonly string[]): Promise<EmailStatusRow[]>;
export async function purgeOldEmails(): Promise<number>;                 // rows deleted, at most PURGE_BATCH
export async function extendEmailExpiry(db: Tx, refType: string, refIds: readonly string[], expiresAt: Date): Promise<number>;
// OutboxTickReport gains `purged: number`
```
- `latestEmailStatus` returns one row per (ref_id, lower(recipient)): `distinct on (ref_id, lower(recipient))` over rows that are not `replaced`, `order by ref_id, lower(recipient), created_at desc, id desc`, with `at = status_at`. Empty `refIds` returns `[]` and issues no statement.
- `purgeOldEmails` deletes rows whose `created_at < now() - RETENTION_DAYS days`, in one bounded `delete … where id in (select id … limit PURGE_BATCH)`. `runOutboxTick` calls it last.
- `extendEmailExpiry` sets `expires_at = greatest(expires_at, $expiresAt)` on rows with `kind = 'chess_invite'`, the given ref, and status in `RETRYABLE_STATUSES`. `checkin-extend.ts` calls it on its `tx` with both seat refs and the new `deadline`, after the audit insert.

- [ ] **Step 1: Write the failing tests**
```ts
it("newest non-replaced row per ref + recipient, case-folded; replaced rows are skipped", …);
it("ordering perturbs the key: the newer row has the SMALLER id and still wins", …);   // explicit created_at
it("resend after dead: a dead row then a fresh queued row reads queued", …);
it("two recipients on one ref → two rows; an unknown ref → none; empty refIds → [] and zero statements", …);
it("purge removes rows older than RETENTION_DAYS and keeps a row one day younger; never more than PURGE_BATCH per call", …);
it("a tick reports purged", …);
it("an extension moves a queued invite's expires_at to the new deadline, so a retry between the old and new deadline is delivered, not expired", …);   // Review Focus 1
it("an extension never shortens expires_at and leaves sent/terminal rows alone", …);
```
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** to the interfaces.
- [ ] **Step 4: Run, verify PASS.** Paths: `status.test.ts`, `worker.test.ts`, `external-play-checkin-extend.test.ts`. Typecheck.
- [ ] **Step 5: Mutate** — (a) drop `status <> 'replaced'`; (b) drop `greatest(…)`. Each reds a named test; restore.
- [ ] **Step 6: Commit** — `feat(email-outbox): latest status per reference for phase 2, 90-day purge, expiry follows an extension`.

---

## Wave boundary (after Task 8)

- [ ] Re-run every task's scoped paths in one JSON-reporter run from `<WT>/apps/web`, plus the cron-worker files. Confirm `.testResults[].name` all sit under the worktree, and paste `p/f/t` into the PR.
- [ ] Re-check the migration number against origin/main (Global Constraints).
- [ ] E2E by CI dispatch only: `gh workflow run e2e.yml --ref feat/email-outbox`, covering `passwordless-login.spec.ts` and `online-chess-desk.spec.ts`. Smoke runs on the PR.
- [ ] Owner-side, not code: add `email.delivered`, `email.delivery_delayed` and `email.suppressed` to the prod Resend webhook; the owner creates the stg webhook and its secret.
