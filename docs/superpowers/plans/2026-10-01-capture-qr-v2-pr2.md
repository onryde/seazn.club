# Capture QR v2 — PR-2 (organiser extras) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the organiser stream a match automatically. The broadcast starts when the match starts with a phone
present, and stops about 3 minutes after the result. The organiser also sees the phone's health, mode and readiness,
and is told when the camera moves to another phone.

**Architecture:**

- **Pure predicates.** `autoStartDue` and `autoStopDue` live in `server/relay/domain/auto-stream.ts`.
- **Evaluated at points PR-1 already built, with no new path.**
  - Auto start runs at the beat's step 6 (`capture-phone.ts` `postBeat`).
  - Auto stop runs in `tickSession`, which serves the beat, the organiser poll and the sweep.
- **The scoring path gets no hook.** The predicates read `fixtures.status` and `finished_at`, which every scoring
  surface writes through `appendEvent` and V430's trigger.
- **One migration, V431,** adds the auto columns to `fixture_stream_settings`.
- **The panel.** PR-2 fills the `auto` block and uses `lastTakeover` on PR-1's `stream-phone` read model, and draws the
  health line into `SignalChain`'s reserved `phoneStatus` slot.

**Tech Stack:** the same as PR-1: Next.js 16, zod v4, postgres.js, Flyway deltas, vitest (node), fast-check `^3`,
Playwright and `scripts/smoke.ts`.

**Spec:** `docs/superpowers/specs/2026-10-01-capture-qr-v2-design.md`, approved on 2026-10-01. PR-2 is spec §7, §8.2,
§9's PR-2 rows and §11.2. **PR-1's plan,** `docs/superpowers/plans/2026-10-01-capture-qr-v2-pr1.md`, is a hard
dependency.** PR-2 is cut only after PR-1 has merged. Every interface named under "Consumes" below is PR-1's.

**Worktree.**

- Path: `/Users/ashokhein/github/seazn.club/.claude/worktrees/capture-qr-v2-pr2`.
- Branch: `feat/capture-qr-v2-pr2`, cut from `origin/main` **after** PR-1 merges. PR-1 itself executes only after the
  Cloudflare Cron Triggers plan merges (W22), so PR-2 inherits both dependencies. Its auto stop rides PR-1's 5-minute
  `stream-tick` job (T7b), and the panel poll still ticks while the panel is open.
- `WT` below means that absolute path. Every command starts with `cd $WT…` in the same shell call.

## Execution batches

Seven batches. Each gets one implementer and one review, with one commit per task and the mutations recorded in each
commit body.

| Batch | Tasks | Boundary gate (the orchestrator re-runs it, scoped) |
|---|---|---|
| B1 | T1 | The 2×9 states × 3 widths exist and differ; then **STOP for the owner's sign-off**. B2–B4 do not wait. |
| B2 | T2 + T3 | T2 and T3 scope commands |
| B3 | T4 + T5 | T4 and T5 scope commands, plus PR-1's `capture-beat` and `stream-tick` suites unchanged |
| B4 | T6 + T7 | T6 scope, then T7's model run **three times** (seeds logged) and the mutation table |
| B5 | T8a + T8b | **Gated on B1's sign-off.** T8a and T8b scope, `mobile.spec.ts` whole across seven projects, screenshots |
| B6 | T9 | `capture-auto.spec.ts` whole, then PR-1's two walkthroughs whole, then `SMOKE_ONLY=captureV2 pnpm test:smoke` |
| B7 | T10 | The lane close. It STOPs before any push or PR. |

## Global Constraints

Every PR-1 Global Constraint carries over unchanged. That covers the contract envelope, the W21 ingest hosts, the
house rules, scoped runs only, never `seazn-env gate`, `rtk proxy` for tsc and lint, whole-file Playwright,
`localhost`, `git commit -F`, and never `git stash`. These are the PR-2 additions, copied from the spec:

- **The switch** is off by default and saved per fixture (`fixture_stream_settings.auto_stream`).
  - It sets `autoAllowed` on every phone answer (§7.1).
  - Its API is `PUT …/stream-settings {autoStream}`.
- **Both switches are needed (capture A4).** Auto start and auto stop also need the current phone's latest beat
  `mode = "automatic"`.
- **Auto start fires once per match** (`auto_started_at`).
  - It never fires after an organiser Stop (`auto_start_blocked_at`, A12). The switch is not changed by that Stop, and
    a manual Go live is always allowed.
  - It never fires once any session of the fixture has received ingest (A16).
  - A refusal is recorded (`auto_start_refusal`, `auto_start_attempted_at`) and retried no more than every
    `AUTO_START_RETRY_SECONDS` = **60**. **A refusal never stamps `auto_started_at`.**
- **Auto stop fires** `AUTO_STOP_AFTER_RESULT_SECONDS` = **180** after `finished_at`, and only for a session with
  `created_at < finished_at`. A post-result broadcast is never auto-stopped (A15). A reverted result (T32) cancels a
  pending auto stop.
- **The amber priority** is fixed: not responding > stalled > hot > battery low (§7.4). The thresholds are PR-1's
  `LOW_BATTERY_PERCENT` = 20 and `HOT_THERMAL_STATUS` = 3.
- **The takeover notice** shows for **30 min** after a `phone_takeover` event (§7.5). It names Stop only when the
  session is live, and it is dismissable.
- **Tunables (AGENTS.md #20).** `AUTO_STOP_AFTER_RESULT_SECONDS` and `AUTO_START_RETRY_SECONDS` join PR-1's
  `tunable()` list, overridable only when `ENV_NAME ∈ {local, ci}`. Every guard pins the **default**.
- **Entitlements.** The switch is offered only with `streaming.relay`, and the panel states are verified **granted and
  denied** (owner checklist 2026-09-14).

## Review Focus

1. **A match that is started, voided back to scheduled, and started again.**
   - Expect: auto start fires on the first `in_play` only (`auto_started_at` is never cleared).
   - The second start does not fire, because a session has already received ingest (A16) or the start was stamped.
   - Owner: T4, case "void then restart does not fire twice".
2. **A result recorded, reverted, then re-recorded.**
   - Expect: the 180 s delay restarts from the new `finished_at`. The trigger re-stamps it on re-entry, and the
     pending stop is not fired early off the first stamp.
   - Owner: T5, case "revert then re-record waits the full delay from the second stamp".
3. **The switch is turned off while live.**
   - Expect: the running broadcast is not stopped at once. Auto stop simply no longer fires (`auto_stream` is a
     conjunct), so the organiser stops it by hand.
   - Owner: T5, case "switch off while live → no auto stop at +180 s".
4. **The phone's mode flips to operator mid-match.**
   - Expect: auto start does not fire, and auto stop does not fire for that session.
   - Owner: T4 and T5, the mode-differential cases.
5. **A beat whose battery is low and whose thermal is hot at once, while it is not responding.**
   - Expect: exactly one amber sentence, the highest priority (not responding).
   - Owner: T6, case "one amber sentence, by priority".

## Carried from PR-1 (owner decision 2026-10-05)

- **G-1, from PR-1's final review: a stream code outlives its issuer's membership.** A phone or automatic start is
  attributed to the code's `issued_by`, and member removal never touches `fixture_stream_codes`. **Owner: fix in
  PR-2.** When a membership is removed (every member-removal path; grep them, do not assume one), end that user's
  active codes for the org, so the phone gets the existing `code_ended` answer. No contract change. Owed tests: the
  removal ends the code, then a beat and a phone start are refused `code_ended`; a second member's codes are
  untouched; re-adding the user does not revive the code; and a mutant that skips the revoke goes red. Assign it to
  T2 (it touches the same write path) unless the T2 re-pin shows a better owner, and record the choice.

## Premises re-verified (spec → corrected fact)

These were pinned on 2026-10-01 against `origin/main` 58e8103e3. **Each is re-checked at T2 Step 1 against
post-PR-1 main**, because PR-1 changes the files this plan touches.

1. **`SignalChain` already takes `phoneStatus?: string`** (`components/v2/stream-signal-chain.tsx:149-154`). Today it
   renders nothing; `stream-signal-chain.test.tsx:147` "D9: phoneStatus is accepted and renders NOTHING in this
   branch" pins that.
   - T8b changes that test's expectation **deliberately**.
   - The commit body says so, naming the test and the ruling (spec §7.4 fills fixture-page §3.4's reserved slot).
   - This is not a weakened test. The old assertion described a reservation, and this PR fills it.
2. **A remote scoring pad (device link) exists end to end in e2e:** `e2e/walkthrough/console-device-live-sync.spec.ts`
   and the `device-pad-*.spec.ts` family.
   - T9 drives "any surface" through the same mint-and-open path those specs use.
   - Read `console-device-live-sync.spec.ts` for the helper calls; do not invent new ones.
3. **The organiser Stop route** is `POST …/stream-sessions/{sid}/stop` (`stopSession`, `stream-sessions.ts`). PR-1
   passes `reason: "stopped"`. T4 adds the `auto_start_blocked_at` stamp **in the same transaction** as the stop.
4. **Credit purchase in a use-case test** follows `server/usecases/__tests__/credit-packs.test.ts`. The Stripe sandbox
   is used only in the smoke and walkthrough (memory: Billing = SANDBOX). The use-case test grants credits through
   the same ledger insert those tests use.
5. **V431 is free** on 2026-10-01; T2 Step 1 re-checks it. If PR-1 renumbered V430, V431 moves with it.

## File Structure

**Created:**

| Path | Responsibility | Task |
|---|---|---|
| out of tree (never committed, owner 2026-10-05): `pr2/option-{a,b}.html` + `shots/` | the §7.6 options | T1 |
| `db/migration/deltas/V431__auto_stream.sql` | spec §8.2 | T2 |
| `apps/web/src/server/relay/domain/auto-stream.ts` | `autoStartDue`, `autoStopDue`, `autoRefusalOf` | T3 |
| `apps/web/src/server/relay/domain/phone-health.ts` | `phoneHealthOf` (the line and the amber pick) | T6 |
| `apps/web/e2e/walkthrough/capture-auto.spec.ts` | §11.2 E2E | T9 |

**Modified:**

| Path | What changes | Task |
|---|---|---|
| `apps/web/src/server/usecases/stream-codes.ts` (`saveStreamSettings`) + `stream-settings` route | `{autoStream}` | T2 |
| `apps/web/src/server/usecases/capture-phone.ts` | `autoAllowed` from the switch; step 6 auto start | T2, T4 |
| `apps/web/src/server/usecases/stream-sessions.ts` | `stopSession` stamps `auto_start_blocked_at`; `tickSession` auto stop | T4, T5 |
| `apps/web/src/server/relay/config.ts` | the two constants, joined to `tunable()` | T3 |
| `apps/web/src/server/usecases/stream-phone.ts`, `schemas.ts` (`StreamPhone.auto`) | `auto`, `health`, `lastTakeover` | T6 |
| `apps/web/src/server/usecases/__tests__/capture-model.test.ts` | five new commands and three invariants | T7 |
| `apps/web/src/components/v2/fixture-stream-panel.tsx`, `stream-signal-chain.tsx`, `lib/stream-session-view.ts` | the switch, auto lines, health line, mode, notice | T8a, T8b |
| `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json` + `lib/i18n-keys.ts` (generated) | `stream.auto.*`, `stream.health.*`, `stream.takeover.*` | T8a, T8b |
| `apps/web/e2e/helpers/fake-capture-phone.ts` | `mode`, health fields | T9 |
| `scripts/smoke.ts` | the `captureV2Suite` auto case | T9 |
| `apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts` | registers `capture-auto.spec.ts` | T9 |

---

### Task 1: The PR-2 mockups (owner gate for T8a and T8b)

**Files:** create, **out of tree** (a scratchpad or a private Artifact; never committed, owner 2026-10-05),
`pr2/option-a.html` and `option-b.html`, plus `pr2/shots/{a,b}-{320,768,1280}-{state}.png`.

- [ ] **Step 1: Read** spec §7.4–§7.6, PR-1's signed-off option (spec §6.12 records which), and
  `stream-signal-chain.tsx`.

- [ ] **Step 2: Build two options.** Each covers the nine §7.6 states:
  1. Ready with auto off;
  2. Ready with auto on;
  3. Waiting with the phone not ready;
  4. Live and healthy;
  5. Live and stalled;
  6. Live and hot;
  7. Live with battery low;
  8. Live and not responding;
  9. the takeover notice, plus an auto start refused for no credit, in one frame.

  The copy is §7.1, §7.4 and §7.5 verbatim.
  - **Option A ("Inline line").** The health line is a single line inside the Phone node, and the amber sentence
    replaces it.
  - **Option B ("Status strip").** The health line is a strip under the chain, and the amber sentence is a banner
    above the chain.

- [ ] **Step 3: Capture** both options at 320, 768 and 1280: 2 options × 9 states × 3 widths = 54 PNGs. Check:
  - all 54 exist and their hashes are distinct;
  - `scrollWidth <= innerWidth` at each width, printed per image.

- [ ] **Step 4: Commit** with `docs(capture): PR-2 mockups — health line, auto, takeover notice (T1)`. **STOP.** Send
  the options to the owner. T8a and T8b wait for the owner's pick, which is recorded in spec §7.6 with its date.

Owes: the house "≥2 UI options" gate.

### Task 2: V431, the switch API, and `autoAllowed`

**Files:**

- Create: `db/migration/deltas/V431__auto_stream.sql`
- Modify:
  - `server/usecases/stream-codes.ts` (`saveStreamSettings` accepts `{targetId?, autoStream?}`);
  - `app/api/v1/fixtures/[id]/stream-settings/route.ts`;
  - `server/api-v1/schemas.ts` (`StreamSettingsBody`, `StreamSettings`);
  - `server/usecases/capture-phone.ts` (the `autoAllowed` source).
- Test:
  - `server/relay/__tests__/migration-shape.test.ts`;
  - `server/usecases/__tests__/stream-codes.test.ts`;
  - `server/usecases/__tests__/capture-get.test.ts`;
  - `server/usecases/__tests__/capture-beat.test.ts`.

**Interfaces:**

- Consumes `saveStreamSettings`, `getCode` and `postBeat` (PR-1 T5, T8a and T8b).
- Produces:
  - `saveStreamSettings(auth, fixtureId, body: { targetId?: string | null; autoStream?: boolean }): Promise<{ targetId: string | null; autoStream: boolean }>`
  - the internal `readAutoSettings(tx, fixtureId): Promise<AutoSettings>`, where
    `AutoSettings = { autoStream: boolean; autoStartedAt: Date | null; autoStartSessionId: string | null;
    autoStartBlockedAt: Date | null; autoStartAttemptedAt: Date | null; autoStartRefusal: AutoRefusal | null }`
  - `AutoRefusal = "no_destination" | "no_credit" | "not_entitled" | "destination_in_use" | "unavailable"`

- [ ] **Step 1: Re-pin.** On post-PR-1 main, check:
  - the top migration (`ls db/migration/deltas | sort -V | tail -1`);
  - that PR-1's `capture-phone.ts`, `stream-codes.ts` and `stream-phone.ts` exist;
  - the current `autoAllowed` source (PR-1 hard-codes `false`, spec §6.4; find it with
    `grep -rn -a "autoAllowed" $WT/apps/web/src/server`);
  - Premises 1–5 above.

  Record any drift in the commit body.

- [ ] **Step 2: Write the failing tests.**
  - **`migration-shape`.** The six V431 columns, with defaults and nullability exactly as §8.2. The
    `auto_start_refusal` check list equals `AutoRefusal`'s values, read from the delta (anti-vacuity: 5).
  - **`stream-codes`.**
    - `{autoStream: true}` saves.
    - `{}` changes nothing.
    - `{targetId}` alone leaves `autoStream` as it was. This is the sequence rule: a second call does not clear the
      first call's field.
    - With no `streaming.relay` → 402.
  - **`capture-get` and `capture-beat`.** `autoAllowed` is `true` iff `auto_stream`, on the waiting shape, the session
    shape and the beat answer: three surfaces × two values = six cases.

- [ ] **Step 3: Run** and see the cases fail; implement; run again.

```bash
cd $WT/apps/web && rm -f /tmp/cq2-t2.json && pnpm vitest run src/server/relay/__tests__/migration-shape.test.ts src/server/usecases/__tests__/stream-codes.test.ts src/server/usecases/__tests__/capture-get.test.ts src/server/usecases/__tests__/capture-beat.test.ts src/server/api-v1/__tests__/capture-contract.test.ts --reporter=json --outputFile=/tmp/cq2-t2.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' /tmp/cq2-t2.json
```

- [ ] **Step 4: Mutate.**
  - `autoAllowed: true` constant. Red: the `false` cases.
  - `saveStreamSettings` writes `autoStream ?? false`. Red: the "`{targetId}` alone" case.

- [ ] **Step 5: Commit** with `feat(capture): V431 auto columns; autoStream setting; autoAllowed (PR-2 T2)`, listing
  the mutations in the body.

Owes: unit and use-case.

### Task 3: The pure predicates — `domain/auto-stream.ts`

**Files:**

- Create: `apps/web/src/server/relay/domain/auto-stream.ts`
- Modify: `apps/web/src/server/relay/config.ts`
- Test: `apps/web/src/server/relay/domain/__tests__/auto-stream.test.ts`, `server/relay/__tests__/config.test.ts`

**Interfaces:**

- Produces:

```ts
export const AUTO_START_RETRY_SECONDS = 60;          // config.ts
export const AUTO_STOP_AFTER_RESULT_SECONDS = 180;   // config.ts
export type AutoStartInput = {
  settings: AutoSettings | null;            // null = no settings row
  phone: { present: boolean; mode: "automatic" | "operator" | null } | null;
  fixtureStatus: string;
  hasOpenSession: boolean;
  anySessionEverIngested: boolean;
};
export function autoStartDue(i: AutoStartInput, now: Date, retrySeconds: number): boolean;
export type AutoStopInput = {
  autoStream: boolean;
  sessionPhoneMode: "automatic" | "operator" | null;
  finishedAt: Date | null;
  sessionCreatedAt: Date;
};
export function autoStopDue(i: AutoStopInput, now: Date, afterSeconds: number): boolean;
/** startBroadcast's refusal → the stored word (§7.2). Anything unmapped → "unavailable". */
export function autoRefusalOf(code: string): AutoRefusal;
```

- [ ] **Step 1: Write the failing table.** The empty case comes first: `settings: null` → not due, and `phone: null` →
  not due. Then:
  - one case per `autoStartDue` conjunct failing alone, nine in all. The conjuncts are listed in the test as data, and
    the test asserts `checked === 9`;
  - the retry at 59 s → false and at 60 s → true, from `AUTO_START_RETRY_SECONDS`;
  - one case per `autoStopDue` conjunct failing alone (five);
  - the boundary at `finished_at + 179 s` versus `+ 180 s`;
  - **ordering-differential** cases:
    - a session created 1 s before versus 1 s after `finished_at`;
    - mode `operator` versus `automatic`, with everything else equal;
  - `autoRefusalOf`: each of `no_destination`, `no_credit`, `not_entitled` and `unavailable` maps to itself;
    `target_in_use` → `destination_in_use`; an unknown code → `unavailable`.

  The `AutoRefusal` list is read from V431 through `_stream-migration.ts`'s `lastCheckList` (PR-1 T3).
- `tunable()`: the two new names honour an override only in local and ci, and the guard pins the defaults 60 and 180.

- [ ] **Step 2: Run** and see the cases fail; implement; run again.

```bash
cd $WT/apps/web && rm -f /tmp/cq2-t3.json && pnpm vitest run src/server/relay/domain/__tests__/auto-stream.test.ts src/server/relay/__tests__/config.test.ts --reporter=json --outputFile=/tmp/cq2-t3.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' /tmp/cq2-t3.json
```

  Implement as a conjunct table, so the test and the module share its shape and not its values:

```ts
const START_CONJUNCTS: readonly [name: string, ok: (i: AutoStartInput, now: Date, retry: number) => boolean][] = [
  ["switch on", (i) => i.settings?.autoStream === true],
  ["phone automatic", (i) => i.phone?.mode === "automatic"],
  ["phone present", (i) => i.phone?.present === true],
  ["in play", (i) => i.fixtureStatus === "in_play"],
  ["no open session", (i) => !i.hasOpenSession],
  ["once per match", (i) => i.settings?.autoStartedAt == null],
  ["not after organiser stop", (i) => i.settings?.autoStartBlockedAt == null],
  ["before any broadcast ran", (i) => !i.anySessionEverIngested],
  ["retry spacing", (i, now, retry) => i.settings?.autoStartAttemptedAt == null
     || now.getTime() - i.settings.autoStartAttemptedAt.getTime() >= retry * 1000],
];
export const autoStartDue = (i: AutoStartInput, now: Date, retrySeconds: number) =>
  START_CONJUNCTS.every(([, ok]) => ok(i, now, retrySeconds));
```

- [ ] **Step 3: Mutate.** Remove each conjunct in turn (nine mutants for start, five for stop), and flip `>=` → `>` in
  both. Each one must go red, and the test names go in the commit body.

- [ ] **Step 4: Commit** with `feat(capture): pure auto start and auto stop predicates (PR-2 T3)`.

Owes: unit.

### Task 4: Auto start at beat step 6; organiser Stop blocks it

**Files:**

- Modify: `server/usecases/capture-phone.ts` (`postBeat`, step 6) and `server/usecases/stream-sessions.ts`
  (`stopSession`)
- Test: `server/usecases/__tests__/capture-auto-start.test.ts` (new, DB-backed)

**Interfaces:**

- Consumes `startBroadcast` (PR-1 T6), `autoStartDue` and `autoRefusalOf` (T3), and `readAutoSettings` (T2).
- Step 6 runs **after** the tick, only for a beat from the current phone.
  - When `autoStartDue` holds: `startBroadcast(actor: {source:"auto", pairingId}, fixtureId, {targetId: settings.targetId, startCause:"automatic", phonePresent:true})`.
  - On success, in the same transaction as the session row: `auto_started_at = now` and `auto_start_session_id = sid`.
  - On an `HttpError` refusal: `auto_start_refusal = autoRefusalOf(code)` and `auto_start_attempted_at = now`.
    **`auto_started_at` is untouched.** The beat still answers 200.
  - The answer is then rebuilt, so this same beat hears `go-live` with `startedBy: "automatic"`.
- `stopSession` sets `auto_start_blocked_at = now` when it is null, in the stop's transaction (A12).

- [ ] **Step 1: Write the failing tests.**
  - **Fires once.** Two beats after `in_play` create one session, with `start_cause 'automatic'`, and the second beat
    hears `live`.
  - **"Any surface".** The status is set through `appendEvent` with the **device-link actor** (no console route), and
    the next beat fires.
  - **Late pairing.** `in_play` first, then the claim beat fires it.
  - **A16.** Once a session has received ingest and ended, a new `in_play` beat never fires.
  - **A12.**
    - Fire, then an organiser Stop: `auto_start_blocked_at` is set, and later beats never fire.
    - A manual organiser Go live afterwards succeeds (`start_cause 'organiser'`).
  - **Refusal and retry.**
    - With no credits: `auto_start_refusal = 'no_credit'`, `auto_started_at` stays null, and the beat answers 200
      `waiting`.
    - A beat 30 s later makes no second attempt (spy on `startBroadcast`).
    - Grant credits through the `credit-packs.test.ts` ledger insert; the beat at 60 s fires.
  - **Review Focus 1.** `in_play` → `scheduled` (a void) → `in_play` fires at most once in total.
  - **Review Focus 4.** A beat with mode `operator` and everything else due does not fire.
  - **Concurrency.** Two beats at once from the current phone create exactly one session (the gated-tx pattern, under
    the code row's `for update`).

- [ ] **Step 2: Run** and see them fail; implement; run again. PR-1's beat suite must stay green **without assertion
  edits**.

```bash
cd $WT/apps/web && rm -f /tmp/cq2-t4.json && pnpm vitest run src/server/usecases/__tests__/capture-auto-start.test.ts src/server/usecases/__tests__/capture-beat.test.ts src/server/usecases/__tests__/stream-sessions.test.ts --reporter=json --outputFile=/tmp/cq2-t4.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' /tmp/cq2-t4.json
```

- [ ] **Step 3: Mutate.**
  - Stamp `auto_started_at` on a refusal (§11.2's named mutant). Red: "retries after credits are granted".
  - Drop the `stopSession` stamp. Red: A12.
  - Evaluate step 6 for a non-current phone. Red: add the case "a replaced phone's beat never fires".
  - Run step 6 before the tick. Red: "this beat hears go-live".

- [ ] **Step 4: Commit** with `feat(capture): automatic start on the current phone's beat; Stop blocks it (PR-2 T4)`,
  listing the mutations in the body.

Owes: use-case, money (one consume, at live) and regression (A12).

### Task 5: Auto stop in the tick

**Files:**

- Modify: `server/usecases/stream-sessions.ts` (`tickSession`, after W19)
- Test: `server/usecases/__tests__/capture-auto-stop.test.ts` (new, DB-backed)

**Interfaces:**

- Consumes `tickSession` (PR-1 T7) and `autoStopDue` (T3).
- When due, the tick calls `stop(auto_stopped)`. The session phone's mode is the latest beat of the session's
  `pairing_id`.

- [ ] **Step 1: Write the failing tests.**
  - **The delay.** At `finished_at + AUTO_STOP_AFTER_RESULT_SECONDS`, the session ends `auto_stopped`, and the wire
    shows `auto_stopped`. At 179 s it is still open.
  - **Each tick cause.** Driven by a beat, an organiser poll, the sweep and the `stream-tick` job (`POST
    /api/cron/stream-tick` with the test `x-cron-secret`, PR-1 T7b): four cases. With no panel and no phone, the job
    alone stops the session.
  - **A15.** Stop by hand, restart by hand **before** the result, then the result: auto-stopped.
  - **Post-result broadcast.** A broadcast started after the result is never auto-stopped, even at +1 h.
  - **T32.** A revert at +100 s cancels; at +180 s from the first stamp it is still open.
  - **Review Focus 2.** Re-record at +200 s and stop at the second stamp +180 s, not before.
  - **Review Focus 3.** Switch off at +60 s: still open at +400 s.
  - **Review Focus 4.** The session phone's mode is `operator`: not stopped.

- [ ] **Step 2: Run** and see them fail; implement; run again.

```bash
cd $WT/apps/web && rm -f /tmp/cq2-t5.json && pnpm vitest run src/server/usecases/__tests__/capture-auto-stop.test.ts src/server/usecases/__tests__/stream-tick.test.ts src/app/api/cron/relay-sweep/route.test.ts src/app/api/cron/stream-tick/route.test.ts --reporter=json --outputFile=/tmp/cq2-t5.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' /tmp/cq2-t5.json
```

- [ ] **Step 3: Mutate.**
  - Drop `created_at < finished_at`. Red: the post-result case.
  - Read `finished_at` from a cached first stamp. Red: Review Focus 2.
  - Leave auto stop out of the sweep. Red: the sweep case.
  - Leave auto stop out of `tickOpenSessions`'s path. Red: the stream-tick case.

- [ ] **Step 4: Commit** with `feat(capture): automatic stop after the result, in every tick (PR-2 T5)`, listing the
  mutations in the body.

Owes: use-case and regression (A12 + A15 together are in T9's walkthrough).

### Task 6: The read model — `auto`, `health`, `lastTakeover`

**Files:**

- Create: `server/relay/domain/phone-health.ts`
- Modify: `server/usecases/stream-phone.ts`, `server/api-v1/schemas.ts` (`StreamPhone`)
- Test: `server/relay/domain/__tests__/phone-health.test.ts`, `server/usecases/__tests__/stream-phone.test.ts`

**Interfaces:**

- Produces:

```ts
export type PhoneAmber = "not_responding" | "stalled" | "hot" | "battery_low";
export const AMBER_PRIORITY: readonly PhoneAmber[] = ["not_responding", "stalled", "hot", "battery_low"];
export function phoneHealthOf(p: StreamPhone["phone"], now: Date): {
  amber: PhoneAmber | null;            // the highest-priority one only
  batteryPercent: number | null; charging: boolean | null; bitrateKbps: number | null; heardSecondsAgo: number;
} | null;
```

- `StreamPhone.auto` = `{ on, startedAt, blockedAt, refusal: AutoRefusal | null, stopsAt: string | null }`, where
  `stopsAt` = `finished_at + AUTO_STOP_AFTER_RESULT_SECONDS` when due to apply.
- `StreamPhone.lastTakeover` comes from the newest `phone_takeover` event within 30 min, with `model` from that
  event's new pairing.

- [ ] **Step 1: Write the failing tests.**
  - **`phone-health`.**
    - Every single amber.
    - **Review Focus 5:** all four at once → `not_responding`.
    - The thresholds come from `LOW_BATTERY_PERCENT` and `HOT_THERMAL_STATUS` (at 20 and 21; at 2 and 3).
    - The sweep over `AMBER_PRIORITY` asserts `checked === 4`.
  - **`stream-phone`.**
    - `auto` mirrors the settings row.
    - `lastTakeover` appears at 29 min 59 s and is null at 30 min.
    - The body still carries no secret.

- [ ] **Step 2: Run** and see them fail; implement; run again.

```bash
cd $WT/apps/web && rm -f /tmp/cq2-t6.json && pnpm vitest run src/server/relay/domain/__tests__/phone-health.test.ts src/server/usecases/__tests__/stream-phone.test.ts "src/app/api/v1/fixtures/[id]/stream-phone/__tests__/route.test.ts" --reporter=json --outputFile=/tmp/cq2-t6.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' /tmp/cq2-t6.json
```

- [ ] **Step 3: Mutate.**
  - Reverse `AMBER_PRIORITY`. Red: Review Focus 5.
  - Make the takeover window 31 min. Red: the 30 min case.

- [ ] **Step 4: Commit** with `feat(stream): phone health, auto block and takeover in stream-phone (PR-2 T6)`, listing
  the mutations in the body.

Owes: unit and use-case.

### Task 7: The model test grows; the PR-2 mutation table

**Files:**

- Modify: `server/usecases/__tests__/capture-model.test.ts`
- Create: `docs/superpowers/plans/2026-10-01-capture-qr-v2-pr2-mutations.md`

- [ ] **Step 1: Add the commands** `toggleAuto`, `setPhoneMode`, `matchStart`, `finish` and `revert` (§11.2), with the
  model state extended by `{auto, mode, finishedAt, autoStarted, blocked}`.
  - Add three invariants:
    1. auto start fires at most once per fixture;
    2. it never fires after an organiser Stop;
    3. auto stop never stops a session created after `finished_at`.
  - Add one anti-vacuity counter per new invariant (`autoFired`, `blockedChecked`, `postResultSurvived`), each `> 0`
    at the end. All eleven PR-1 invariants and counters stay.

- [ ] **Step 2: Run it three times,** with each seed logged.

```bash
cd $WT/apps/web && for i in 1 2 3; do rm -f /tmp/cq2-t7-$i.json; CAPTURE_MODEL_SEED=$RANDOM pnpm vitest run src/server/usecases/__tests__/capture-model.test.ts --reporter=json --outputFile=/tmp/cq2-t7-$i.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests}' /tmp/cq2-t7-$i.json; done
```

- [ ] **Step 3: The mutation table.** Sweep every mutant from T2–T6 on the integrated tree: one per predicate conjunct,
  plus "stamp `auto_started_at` on a refusal". Record `mutant | killer test | RED` in the mutations file.

- [ ] **Step 4: Commit** with `test(capture): model gains auto commands and invariants; PR-2 mutation table (T7)`.

Owes: the sequence test and the mutation table.

### Task 8a: The switch and the auto lines (gated on T1)

**Precondition:** the owner has picked a T1 option. If not, STOP.

**Files:**

- Modify: `components/v2/fixture-stream-panel.tsx` and `lib/stream-session-view.ts`
- Modify: the four `ui.json` files, then `pnpm i18n:gen-keys`
- Test: `components/v2/__tests__/fixture-stream-panel.test.tsx` and `lib/__tests__/stream-session-view.test.ts`

The `stream.auto.*` copy comes from §7.1 and §7.4: the switch label, the Live read-only line, "Automatic start couldn't
begin: {reason}" for each `AutoRefusal`, and the remedies, which reuse the existing Buy credits and Manage destinations
keys.

- [ ] **Step 1: Write the failing tests.**
  - The switch renders under the picker in Ready, only with `streaming.relay`. **Granted and denied are both
    asserted.**
  - The Live read-only line appears only when `auto.on`.
  - The refusal line for each `AutoRefusal` value, with a sweep count of 5.
  - The pure view helper `autoLineOf(phone.auto, session)` takes the empty case first.

- [ ] **Step 2: Run, implement, run,** then `pnpm i18n:gen-keys && pnpm i18n:check`, typecheck and lint.

```bash
cd $WT/apps/web && rm -f /tmp/cq2-t8a.json && pnpm vitest run src/components/v2/__tests__/fixture-stream-panel.test.tsx src/lib/__tests__/stream-session-view.test.ts --reporter=json --outputFile=/tmp/cq2-t8a.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' /tmp/cq2-t8a.json
```

- [ ] **Step 3: Mutate.** Render the switch without the entitlement. Red: the denied case.

- [ ] **Step 4: Commit** with `feat(stream): automatic streaming switch and auto lines (PR-2 T8a)`.

Owes: unit.

### Task 8b: The health line, mode and readiness, and the takeover notice (gated on T1)

**Files:**

- Modify: `components/v2/stream-signal-chain.tsx` (fills `phoneStatus`), `fixture-stream-panel.tsx` and
  `lib/stream-session-view.ts`
- Modify: the four `ui.json` files (`stream.health.*`, `stream.takeover.*`), then `pnpm i18n:gen-keys`
- Test: `stream-signal-chain.test.tsx` (the D9 case changes; see Premise 1), `fixture-stream-panel.test.tsx` and
  `stream-session-view.test.ts`

- [ ] **Step 1: Write the failing tests.**
  - The line "Phone · {n}% charging · {kbps} · heard {s} s ago", with each part absent when its field is null.
  - Each amber sentence. Review Focus 5's case renders exactly one.
  - "Automatic" or "Operator" beside the state word.
  - "Phone not ready: {reason}" for each of camera, sound, network and held, with a count of 4.
  - "Couldn't start on the phone" when `startFailed` is set.
  - Data used and the app version are inside the Details disclosure only.
  - "Paired · {model}".
  - The notice names Stop only when live, and is absent when `lastTakeover` is null.
  - **D9's expectation is replaced** by "phoneStatus renders the line", with the reason in the commit body.

- [ ] **Step 2: Run, implement, run,** then i18n, typecheck and lint.

```bash
cd $WT/apps/web && rm -f /tmp/cq2-t8b.json && pnpm vitest run src/components/v2/__tests__/stream-signal-chain.test.tsx src/components/v2/__tests__/fixture-stream-panel.test.tsx src/lib/__tests__/stream-session-view.test.ts --reporter=json --outputFile=/tmp/cq2-t8b.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' /tmp/cq2-t8b.json
```

- [ ] **Step 3: Visual check.**
  1. Prod-build the worktree.
  2. Screenshot every §7.6 state at 1280, 768 and 320, cropped to the panel, with `scrollWidth <= innerWidth` at each.
  3. Write per-screen verdicts against the signed-off option, with the entitlement-gated states **granted and denied**.
  4. Run `mobile.spec.ts` whole on `mobile-320 mobile-360 mobile-se mobile-14 mobile-430 tablet-768 tablet-834`, the
     same loop as PR-1 T11 Step 5. Serial mode means a red is a floor: re-run until a full pass.
  5. Long-name check: a 43-character device model must not overflow at 320 (AGENTS.md: `truncate` needs `min-w-0` up
     the chain).

- [ ] **Step 4: Mutate.** Show the notice's Stop when not live. Red: its case.

- [ ] **Step 5: Commit** with `feat(stream): phone health line, mode, readiness and takeover notice (PR-2 T8b)`, with
  per-screen verdicts and the D9 note in the body.

Owes: unit and visual.

### Task 9: End to end — auto start from the remote pad, auto stop, health, smoke

**Files:**

- Create: `apps/web/e2e/walkthrough/capture-auto.spec.ts`
- Modify:
  - `e2e/helpers/fake-capture-phone.ts` (`mode`, battery, thermal, delivery and `notReady` in `beat()`);
  - `scripts/smoke.ts` (the auto case in `captureV2Suite`);
  - `lib/__tests__/e2e-ci-wiring.test.ts`.

- [ ] **Step 1: Write the walkthrough** for §11.2 E2E. The server runs with `ENV_NAME=local` and
  `AUTO_STOP_AFTER_RESULT_SECONDS=5`; the spec asserts that env at its top. The cases:
  - the switch on and off at the current project width (the width projects cover 320, 768 and 1280);
  - **auto start driven by scoring the first point from the Remote scoring pad (a device link)**, using the
    mint-and-open path from `console-device-live-sync.spec.ts`, with the fake phone beating in automatic mode;
  - auto stop after the tuned delay;
  - each amber state driven by fake beats;
  - the not-ready line;
  - the takeover notice, from a second fake phone after the tuned `DEAD_PHONE_TAKEOVER_SECONDS`;
  - **regression A12 + A15:** auto start → organiser Stop → manual Go live → result → auto stopped.

  Budgets are derived from the constants (AGENTS.md #20).

- [ ] **Step 2: Add the smoke case:** switch on, `in_play`, a beat fires, then finish and the tick stops.

- [ ] **Step 3: Run** against a prod build of this worktree.

```bash
cd $WT/apps/web && PLAYWRIGHT_BASE=http://localhost:3000 pnpm exec playwright test e2e/walkthrough/capture-auto.spec.ts e2e/walkthrough/capture-phone.spec.ts e2e/walkthrough/stream-relay.spec.ts --project=walkthrough --reporter=line; echo EXIT=$?
cd $WT && SMOKE_ONLY=captureV2 pnpm test:smoke; echo EXIT=$?
cd $WT/apps/web && rm -f /tmp/cq2-t9.json && pnpm vitest run src/lib/__tests__/e2e-ci-wiring.test.ts --reporter=json --outputFile=/tmp/cq2-t9.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' /tmp/cq2-t9.json
```

- [ ] **Step 4: Mutate.** Make the fake phone beat in `operator` mode. Red: the auto start case. This proves the mode
  is load-bearing end to end.

- [ ] **Step 5: Commit** with `test(capture): automatic streaming walkthrough from the remote pad; smoke (PR-2 T9)`.

Owes: E2E, smoke and regression.

### Task 10: Lane close — the scoped gate, then STOP

- [ ] **Step 1:** Re-check that V431 is free on `origin/main`.
- [ ] **Step 2:** Run the scoped gate (the union of T2–T9's vitest paths in one JSON run), then typecheck and lint.
  **Never the full suite.**
- [ ] **Step 3:** Write the PR body draft to `docs/superpowers/plans/2026-10-01-capture-qr-v2-pr2-pr-body.md`, with:
  - the mutation table (T7);
  - the per-screen verdicts (T8b);
  - the open items: capture's A4 mode-switch build
    status.
- [ ] **Step 4: STOP.** No push and no PR. Report to the orchestrator.

---

## Self-review (2026-10-01, against the spec)

- **Spec coverage.**
  - §7.1 → T2 and T8a.
  - §7.2 → T3 and T4.
  - §7.3 → T3 and T5.
  - §7.4 → T6 and T8b.
  - §7.5 → T6 and T8b.
  - §7.6 → T1.
  - §8.2 → T2.
  - §9's PR-2 rows → T2, T4 and T6.
  - §11.2:
    - unit → T3 and T6;
    - use-case → T4 and T5;
    - sequence and mutation → T7;
    - E2E, smoke and regression → T9;
    - visual → T8b.
- **Placeholders.** None. Post-PR-1 facts are re-pinned at T2 Step 1, each by a named command.
- **Type consistency.**
  - `AutoSettings` and `AutoRefusal` (T2) are consumed by T3, T4 and T6.
  - `autoStartDue`, `autoStopDue` and `autoRefusalOf` (T3) are consumed by T4 and T5.
  - `PhoneAmber` and `AMBER_PRIORITY` (T6) are consumed by T8b.
- **Review Focus.** All five lines have a test in their owning task (T4, T5 ×2, T4/T5 and T6).
