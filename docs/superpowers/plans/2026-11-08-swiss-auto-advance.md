# Swiss Auto-Advance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An organiser switches auto-advance on, and a Swiss stage pairs its next round, completes itself after its last round, and confirms the hand-off proposal of the next stage, each one 60 s after the facts settle. A correction inside the window restarts the clock, and every stop shows a banner that names its reason.

**Architecture:** One table, `stage_auto_actions`, is the only source of truth. One pure derivation (`lib/auto-advance.ts`) turns DB facts into the stage's single live row. One DB function (`rearmAutoActions`) applies that derivation, and every fact-changing path calls it. One firing function (`fireAutoAction`) calls the SAME usecase the button calls, as a dedicated system actor. Two triggers claim due rows over the one table under a lease: the minute cron sweep is the guarantee, and QStash is an optional low-latency alarm. The UI is a pure banner view-model plus a thin component above each stage card, and two switches in the stage's Format tool.

**Tech Stack:** TypeScript 7 / Node 26. Next.js, the repo's non-standard version: read `node_modules/next/dist/docs/` before adding any route handler. postgres.js, zod, vitest (JSON reporter), Playwright (CI only), Flyway deltas, `jose` (already a dependency, `apps/web/package.json:40`) for QStash JWTs, and the Cloudflare cron worker (`apps/cron-worker`).

**Spec:** `docs/superpowers/specs/2026-11-08-swiss-auto-advance-design.md`. It is the authority, including the §4.6 placement/switch/copy amendment of 2026-11-08 that this commit carries. Its **[call]** items are owner-delegated and are built as written. Mockup (layout and English source copy only, house theme in the build): `~/seazn-artifacts/2026-11-08_swiss-auto-advance-mockups/index.html` (local :8765).

**Pinned at:** worktree `/Users/ashokhein/github/seazn.club-wt/swiss-auto-advance`, branch `feat/swiss-auto-advance`, HEAD `ac7a1a17eb` (base `origin/main` 0df9a4c524; the brief said 79762c2d9, and every line below was re-pinned at ac7a1a17eb).

---

## Premises found false while planning (record in the PR body)

| # | Spec / brief said | The code says | What this plan does |
|---|---|---|---|
| P1 | §4.1: add both keys "to the stage PATCH body" | `PATCH /api/v1/stages/{id}` (`app/api/v1/stages/[id]/route.ts:29`) is Swiss-only and refuses after the stage's first start: `patchSwissStage`, `swiss-rounds-admin.ts:474`, STAGE_NOT_SWISS / SWISS_ROUNDS_LOCKED / SWISS_CHESS_LOCKED. The switches must flip mid-event, and the confirm switch sits on a knockout. | The keys go into `StageConfig` (`schemas.ts:1230`) as the spec rules, and are written through a dedicated `PUT /api/v1/stages/{id}/auto-advance` (Task 4). |
| P2 | §4.2: "Opening the proposal editor calls …/hold; closing … calls …/release" | `ProgressionPanel` (`components/v2/progression-panel.tsx:217`) is always open and has no open or close state. Edits stay local until Confirm (`:276`). | The hold fires on the first local edit (the draft goes dirty). The release fires when the edits are reverted, or on `pagehide` while dirty. The 30-minute sweep is the backstop (Task 11). |
| P3 | §4.7: "actor null → rendered 'Automatically'" | `HistoryRow` (`history-panel.tsx:23`) carries no actor, and `actor_id` is null on EVERY api-key write too (`auth.ts:181`, userId null). | "Automatically" is keyed on the event TYPE: the three new `stage_auto_*` / `stage_handoff_auto_confirmed` types. It is never keyed on a null actor. `stage_auto_advanced` gets its label, but the panel cannot show "that person" until rows carry actors, which is out of scope (Task 16). |
| P4 | §4.2: live = `waiting|pending|blocked` | A `paused` confirm row is also live. Without it, the partial unique index admits a second row under a hold. | The live set and the unique index include `paused` (Task 1). |
| P5 | Mockup: the confirm switch sits in the SWISS stage's Format panel, help text "1 minute after the stage completes" | Spec §4.1 [call]: the switch is stored on, and shown for, the TARGET stage (gold on and silver off needs two switches). | Built on the target's Format tool, per the spec. Help text: "1 minute after the previous stage completes. Ties still need you." **Owner to confirm** (open risk R1). |
| P6 | Mockup: "Reopen stage" on a completed Swiss | No reopen action exists (`stages.ts:681`, only add-a-stage reopens a division). | Not built. Layout only. |
| P7 | Brief: "Format panel holds Rounds / Pairing system" | The Format tool (`StageRulesArea`, `stages-panel.tsx:2891`) holds match rules only. Rounds are a separate dialog (`desk/swiss-rounds-dialog.tsx:297`). | The "Running the stage" group is appended to `StageRulesArea` (Task 15). |

## Plan decisions not in the spec (each one is the builder's latitude under spec §7, or closes a gap the spec is silent on)

- D1. **Retirement.** When `rearmAutoActions` finds a live row whose target is no longer the derived one, it closes the row as `done` with `result = {by:"person"}` if the target's action is observably done: round N has a seated board, the stage is `complete`, or the proposal is `confirmed`. Otherwise it closes the row `cancelled` with `result.reason = "superseded"`. `cancelled` reasons are `skip | switch_off | superseded`, and only `skip` is sticky.
- D2. **Leased rows are the firer's.** `rearmAutoActions` never touches a row with `lease_until > now()`. This is what lets the manual-path wiring live inside the usecases that the fire path also calls.
- D3. **Restart rule.** `rearmAutoActions(tx, stageId, {restartPending = true})` restarts a `pending` row's `due_at` on every call (G3). The sweep's re-derivation of `waiting` rows passes `restartPending: false`, or a sweep would postpone every row forever.
- D4. **Ties block at once.** A draft with `computed.ties.length > 0` derives `blocked SEEDING_TIE_UNRESOLVED` immediately. It does not count down 60 s to a refusal the banner already knows about (same code, same banner, sooner).
- D5. **Unpair and Undo of a Pair record a sticky skip** for that round. Without it, an organiser who unpairs to fix a pairing is re-paired 60 s later by the clock (Review Focus 1).
- D6. **The sweep re-derives `waiting` rows** every tick, as belt and braces for any decide path that does not reach `onDecided` (Review Focus 2).
- D7. **History markers do not bump `divisions.seq`** (the edit watermark), like the `swiss_rounds_changed` barrier. They are not reversible, so Undo walks past them (`history.ts:99-123`). The usecase's own `fixtures_generated` / `stage_completed` rows still record the work itself.
- D8. **Settle window is env-tunable for CI only:** `E2E_AUTO_ADVANCE_SETTLE_MS` takes an integer in [2000, 60000] and falls back to 60 000 otherwise, mirroring `NEXT_PUBLIC_E2E_SETTLED_POLL_MS` (`use-live-fixture.ts`, `settled-poll-override.test.ts`). The value guard pins the DEFAULT (AGENTS.md class 20).
- D9. **Columns:** `target_round int` + `target_proposal_id uuid` (typed, one per kind) instead of one text `target`. `detail jsonb` carries both the blocked params and a waiting row's open boards (spec `blocked_detail`, widened). A `paused` row's `due_at` is hold time + 30 min, so the sweep releases it with the same "due" query.
- D10. **Migration number: V497** (placeholder). V492–V496 are claimed by open branches and plans (`feat/match-day-code`, `feat/r4-sponsors`, W4, W5, check-in). Re-check at Task 1 and take the first number above every claim.
- D11. **System role is `"admin"`** (`EDITOR_ROLES`, `lib/types.ts:24`), not `"owner"`. Owner-only gates such as `stripe-connect.ts:69` must never open for the clock.

---

## Global Constraints

- **Worktree only:** `$WT=/Users/ashokhein/github/seazn.club-wt/swiss-auto-advance`. Never write to `~/github/seazn.club`. **Never `git stash`**: the stack is shared with the main checkout. The shell cwd resets between calls, so prefix every command with `cd $WT/... &&`. Scratch output goes to `$S` (the executor's own scratchpad subdirectory).
- **Re-pin first.** Every task opens its cited lines before it edits (AGENTS.md class 5). A moved line is not a finding. A changed behaviour is: record it in the commit body.
- **Environment:** the `seazn-local-env` skill. Use a fresh DB, `db:apply`, THEN `sync:sports`, and confirm `show data_directory` is yours. A DB suite that reds without this is environmental.
- **Four test types per task (RULES.md "Testing"):** unit, e2e (Playwright), smoke (`scripts/smoke/` pattern), and regression for the exact behaviour changed. Every task's acceptance names all four. A backend-only task still owes e2e: it names the case in `apps/web/e2e/swiss-auto-advance.spec.ts` that traces it forward (added in the task that first makes it observable through the API).
- **Local runs: ONLY the changed or added test files, by exact path.** e2e and smoke specs are WRITTEN in tasks and RUN on CI only (`gh workflow run e2e.yml --ref feat/swiss-auto-advance`, always with `--ref`). Never run the full vitest suite, the full gate, lint, or a whole-project tsc locally.
  - vitest: `cd $WT/apps/web && rtk proxy npx vitest run <exact paths> --reporter=json --outputFile=$S/vt.json; echo EXIT=$?`. Judge green ONLY from `numPassedTests == numTotalTests > 0`, `EXIT=0`, and `.testResults[].name` resolving under `$WT`.
  - tsc, changed files only: write a temp `apps/web/tsconfig.changed.json` (`{"extends":"./tsconfig.json","include":[<changed .ts/.tsx>, "next-env.d.ts"]}`), run `cd $WT/apps/web && rtk proxy npx tsc --noEmit -p tsconfig.changed.json; echo EXIT=$?`, then delete the file. **Never commit it.**
  - Any local `next build`: `SKIP_TYPECHECK=1`.
- **i18n:** every new user-facing string goes into all 4 locales (`apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`), as real translations rather than copied English. Then run `npm run i18n:gen-keys` (root; `lib/i18n-keys.ts` is GENERATED) and `npm run i18n:check`. Counted strings go through `plural()` / `useMsgPlural()`. No verb may agree with an interpolated stage name (desk `_RULES.md` "Copy"). Run the copy-truth guards with any dictionary change: `src/lib/__tests__/retired-plan-copy.test.ts`, `src/lib/__tests__/dictionary-copy-truth.test.ts`.
- **OpenAPI:** every new or changed `/api/v1` route is registered in `server/api-v1/openapi.ts` ROUTES (`:89`; example `:171`), `server/api-v1/key-scopes.ts` (`:286` pattern) and the schemas registry (`schemas.ts:6265` pattern). Run `npm run openapi:gen` and commit `openapi/v1.json` + `v1.public.json`; CI's drift check fails otherwise. `/api/cron/*` and `/api/internal/*` stay OUT of the spec.
- **UI bar:** mobile-first. Verify by screenshot at 1280, 768 and 320 with no horizontal page scroll. Buttons ≥ 44 px and hit-tested with `elementFromPoint`. Reason lines wrap and never truncate. e2e coverage spans the seven-width matrix (`playwright.config.ts:268-331`: mobile-320, mobile-360, mobile-se 375, mobile-14 390, mobile-430, tablet-768, tablet-834). Pass the `frontend-design` skill in every UI dispatch. Build in the house theme; the mockup is layout and copy only.
- **TEST-STRATEGY.md, binding:** anti-vacuity (every sweep or property reports how many items it checked, and zero checked FAILS). State every rule set's empty case FIRST. Derive expected values from declarations (the constants in `lib/auto-advance.ts`, `DECIDED` at `stages.ts:1429`, engine standings, the Upstash JWT spec), never from the code under test. Include a case where the right answer differs from the wrong answer's constant. **Mutate each new guard once** and name the killing test in the commit body. Test the sequence: a second call, an empty input, after a void or withdrawal, another sport. The reviewer answers the four questions in writing.
- **DB tests** use `describe.skipIf(!HAS_DB)`. A DB-gated test outside `src/server|src/lib|src/app` must be added by name to `ci.yml`'s outliers step (`ci.yml:1303-1317`), or `src/lib/__tests__/db-suite-ci-wiring.test.ts` reds in CI. This plan keeps every DB test under `src/server/` or `src/app/`, so no wiring is owed. A task that breaks that keeps both files in its scoped run.
- **Walkthrough:** Task 17 owns the journey walkthrough, and it must be added to `WALKTHROUGH_SPECS` in `src/lib/__tests__/e2e-ci-wiring.test.ts:184`.
- **Commit trailer:** every commit ends `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push from a task. The controller pushes at batch boundaries.
- **Topology:** Opus `implementer` → Opus `reviewer` per task, looped until the review is clean and the scoped tests are green (RULES.md). Never override `model:`.
- **Format × sport rows (TEST-STRATEGY rule 9):** Swiss × {generic, badminton, chess}. Knockout target × {generic}. Declared in the PR body.

## Review Focus

The five inputs the spec implies but never tests, each pinned in its owning task:

1. **An organiser unpairs an auto-paired round, or Undoes it from History, to fix a pairing.** Expected: that round is NOT re-paired automatically 60 s later, and they pair it by hand. Pinned in Task 6 (`unpair records a sticky skip`, `undo of an auto pair records a sticky skip`).
2. **A board is decided by a path that never reaches `onDecided`** (a direct status write, an importer, a future path). Expected: the `waiting` banner still moves to `pending` within one sweep. Pinned in Task 8 (`tick re-derives a waiting row whose round settled without onDecided`).
3. **An organiser starts changing the drafted list during the confirm countdown.** The panel is always open, so there is no "open" event. Expected: auto-confirm pauses at the first edit and never confirms the un-edited draft under them. Pinned in Task 11 (`first local edit holds; revert releases`).
4. **A division with two stages, or a Swiss feeding gold and silver brackets.** Expected: each banner names its stage, and the confirm banner sits above the TARGET card. Pinned in Task 14 (`banner names its stage only when the division has more than one`) and Task 8 (sequence 16).
5. **QStash delivers early, late, twice, or for a row that a correction has since re-armed.** Expected: nothing fires before `due_at`, a duplicate fires once, and a forged signature is 401. Pinned in Task 10.

---

## Sequence tests (spec §5) → owning task

| § | Sequence | Task / test name |
|---|---|---|
| 1 | Round → 60 s → paired, twice; last round → completed → drafted → confirmed | 8 `full chain pairs, completes and confirms` |
| 2 | Correction 30 s in restarts the clock; pairing uses the corrected result | 5 `correction restarts due_at` + 8 `pairing reads the corrected result` |
| 3 | Void in the window → waiting; re-decide re-arms | 5 `void returns the row to waiting; re-decide re-arms` |
| 4 | Manual Pair next inside the window → one pairing, row retired, fire no-op | 6 `manual pair retires the row as done by a person` + 8 `fire after a manual pair is a no-op` |
| 5 | Sweep + QStash at once → one pairing | 8 `two concurrent ticks pair once` + 10 `qstash fire racing the sweep pairs once` |
| 6 | Abandoned board → blocked naming it; deciding re-arms | 3 `abandoned outranks waiting` + 5 `abandoned board blocks, deciding re-arms` |
| 7 | Tie → blocked; manual confirm retires | 5 `tie derives blocked` + 8 `manual confirm retires a tie-blocked row` |
| 8 | Switch on with a round complete → arms immediately | 5 `switch on arms a complete round` |
| 9 | Switch off while pending → cancelled, nothing fires | 5 `switch off cancels` + 8 `cancelled row never fires` |
| 10 | Late withdrawal between rounds; field under two blocks | 8 `withdrawal between rounds pairs the smaller field` / `field under two blocks with the refusal` |
| 11 | Badminton + chess Swiss, odd field with a bye | 8 `chain per sport (generic, badminton, chess), odd field` |
| 12 | Empty first: no fixtures → nothing; round-1 shells → nothing | 3 `empty stage derives none` / `round 1 is never armed` + 5 DB twins |
| 13 | Skip round 3, correct round 2 → round 3 stays skipped; round 4 arms | 6 `skip is sticky for its round only` |
| 14 | Hold → paused; edits + Confirm once; release re-arms; 30-min release | 11 (four named tests) |
| 15 | Two sources: first completes → nothing; second → arms | 5 `two-source target arms only after the last source` |
| 16 | Gold on, silver off | 8 `gold waits, silver confirms` |
| 17 | Division `auto_progress` + `autoPair` → 60 s grace | 12 `auto_progress steps aside for an autoPair stage` |
| 18 | Completion countdown → Add a round → stage open, new round waits | 6 `add a round during the completion countdown` |

---

### Task 1: `stage_auto_actions` table

**Files:**
- Create: `db/migration/deltas/V497__stage_auto_actions.sql` (re-check the number, D10)
- Test: `apps/web/src/server/__tests__/stage-auto-actions-schema.test.ts` (DB)
- Covered automatically: `apps/web/src/server/__tests__/rls-coverage.test.ts:58,66,83` (run it)

**Interfaces:**
- Produces: table `stage_auto_actions(id uuid pk default gen_random_uuid(), org_id uuid not null → organizations, division_id uuid not null → divisions on delete cascade, stage_id uuid not null → stages on delete cascade, kind text check in ('pair_round','complete_stage','confirm_handoff'), target_round int null, target_proposal_id uuid null → stage_seed_proposals on delete cascade, state text check in ('waiting','pending','paused','blocked','done','cancelled'), due_at timestamptz null, blocked_code text null, detail jsonb null, lease_until timestamptz null, attempts int not null default 0, done_at timestamptz null, result jsonb null, created_at/updated_at timestamptz not null default now())`.
  - Check constraint: confirm ⇔ `target_proposal_id is not null and target_round is null`, and the other two kinds the reverse.
  - Partial unique index `stage_auto_actions_one_live` on `(stage_id, kind) where state in ('waiting','pending','paused','blocked')` (P4).
  - Index `stage_auto_actions_due` on `(due_at) where state in ('pending','paused')`.
  - Index `stage_auto_actions_division_recent` on `(division_id, updated_at desc)`.
  - Sticky-skip lookup index on `(stage_id, kind, target_round) where state = 'cancelled'`.
  - RLS as in `V360__stage_progression_seeding.sql:33,55-60`: enable + FORCE, policy `stage_auto_actions_tenant` for all to app_user `using/with check (org_id = current_org_id())`, `grant select, insert, update, delete … to app_user`. The cross-org sweep claims with the pooled privileged role, as the outbox worker does (`email-outbox/worker.ts`, its role check).

- [ ] **Step 1: Write the failing DB test** `stage-auto-actions-schema.test.ts`, which seeds an org/division/swiss stage with the existing seed helpers. Assertions:
  - `second live row for the same (stage, kind) is refused` (23505), for each of the four live states. Each state is its own case, `paused` included.
  - `a done or cancelled row does not block a new live row`.
  - `confirm_handoff without a proposal id is refused` and `pair_round with a proposal id is refused` (23514).
  - `deleting the stage deletes its rows`.
  - `app_user in another org reads zero rows`. This needs a positive pair: the same query in the row's org reads one row.
- [ ] **Step 2: Run it.** Expected: FAIL, `relation "stage_auto_actions" does not exist`.
- [ ] **Step 3: Write the migration.** The house header comment names the spec.
- [ ] **Step 4: `db:apply` on your fresh DB, then run the new test and `rls-coverage.test.ts`.** Expected: PASS, with rls-coverage counting the new table among its non-empty set.
- [ ] **Step 5: Mutate once.** Drop `paused` from the index predicate: the `paused` case must red. Restore.
- [ ] **Step 6: Commit** `feat(db): stage_auto_actions — one live auto-advance row per stage and kind`. e2e/smoke: traced forward to Task 4's `GET auto-advance lists live rows` and Task 4's smoke check. Say so in the body.

---

### Task 2: The system actor

**Files:**
- Modify: `apps/web/src/server/api-v1/auth.ts:19-34` (`AuthCtx.via`), and add `systemAuth` beside it
- Test: `apps/web/src/server/api-v1/__tests__/system-auth.test.ts`

**Interfaces:**
- Produces: `AuthCtx.via: "session" | "api_key" | "device_link" | "system"`, and `export function systemAuth(orgId: string): AuthCtx`. That returns `{ orgId, via: "system", userId: null, role: "admin", keyId: null }` (D11) and passes through `recordAuthContext`.

- [ ] **Step 1: Failing unit test.**
  - `systemAuth carries no person`: `userId === null`, `via === "system"`, `role` ∈ `EDITOR_ROLES` and `!== "owner"`.
  - `systemAuth is refused by every session-only gate`: call the exported usecases whose first check is a `via !== "session"` gate (`stream-codes.ts:57`, `api-keys.ts:26`) and expect a refusal.
- [ ] **Step 2: Run.** FAIL (no export).
- [ ] **Step 3: Implement.** Then audit every `via` site: `rtk proxy grep -rn 'auth\.via\|ctx\.via\|\.via ===\|\.via !==' apps/web/src --include='*.ts' --include='*.tsx' | grep -v __tests__` (25 sites at pin). Record one verdict line per site in the commit body ("treats system as non-session: correct" / "changed because …"). Expected: no change outside auth.ts. The three usecases the clock calls (`generateStageFixtures`, `completeStage`, `confirmSeedProposal`) key on none of them. `captureServer`'s `distinctId: auth.userId ?? \`org:${orgId}\`` (`stages.ts:3399,3439`) already handles a null user.
- [ ] **Step 4: Run the test + changed-files tsc.** PASS. tsc catches any exhaustive `Record<AuthCtx["via"], …>`.
- [ ] **Step 5: Mutate.** Set `role: "owner"`: the test reds. Restore.
- [ ] **Step 6: Commit** `feat(auth): a system actor for work the clock does`. e2e/smoke: traced forward to Task 8 (history shows no person on an automatic pairing; walkthrough Task 17).

---

### Task 3: The pure derivation

**Files:**
- Create: `apps/web/src/lib/auto-advance.ts` (client-safe; imports only `lib/swiss-shell.ts`)
- Test: `apps/web/src/lib/__tests__/auto-advance-derive.test.ts`

**Interfaces:**
- Consumes: `nextUnseatedSwissRound`, `isSwissBoardSeated` (`lib/swiss-shell.ts:171,138`).
- Produces:
  - `AUTO_ADVANCE_SETTLE_MS = 60_000`, `AUTO_ADVANCE_HOLD_MAX_MS = 1_800_000`, `AUTO_ADVANCE_DONE_VISIBLE_MS = 600_000`, `AUTO_ADVANCE_POLL_MS = 10_000`, `AUTO_ADVANCE_MAX_ATTEMPTS = 5`, `AUTO_ADVANCE_LEASE_MS = 120_000`.
  - `type AutoActionKind = "pair_round" | "complete_stage" | "confirm_handoff"`.
  - `type AutoActionState = "waiting" | "pending" | "paused" | "blocked" | "done" | "cancelled"`.
  - `LIVE_AUTO_ACTION_STATES = ["waiting","pending","paused","blocked"] as const`.
  - `type CancelReason = "skip" | "switch_off" | "superseded"`.
  - `interface BoardRef { fixtureId: string; round: number; board: number }`.
  - `interface SourceFixtureFact { id: string; round_no: number; seq_in_round: number; home_entrant_id: string | null; away_entrant_id: string | null; outcome: unknown; ext_key: string | null; status: string; decided: boolean }`. `decided` is computed by the SERVER from `DECIDED` (`stages.ts:1429`), the one authority, so lib never restates it.
  - `interface SourceFacts { stageStatus: string; fixtures: readonly SourceFixtureFact[]; skipped: ReadonlySet<string> }`, plus `skipKey(kind: "pair_round" | "complete_stage", round: number): string`.
  - `type DerivedSource = { state: "none" } | { state: "waiting"; kind; round; openBoards: BoardRef[] } | { state: "pending"; kind; round } | { state: "blocked"; kind; round; code: "STAGE_NOT_READY"; boards: BoardRef[] }`, where `kind` is `"pair_round" | "complete_stage"`. For `complete_stage`, `round` is the stage's last round.
  - `deriveSourceAction(f: SourceFacts): DerivedSource`.
  - `interface ConfirmFacts { latest: { id: string; status: "draft" | "confirmed" | "stale"; tieCount: number } | null; livePaused: boolean }`.
  - `type DerivedConfirm = { state: "none" } | { state: "pending" | "paused"; proposalId: string } | { state: "blocked"; proposalId: string; code: "SEEDING_TIE_UNRESOLVED" }`.
  - `deriveConfirmAction(f: ConfirmFacts): DerivedConfirm`.
  - `autoActionRetryDelayMs(attemptsMade: number): number`: 30 s, 60 s, 120 s, 300 s for attempts 1–4 (the caller blocks at `AUTO_ADVANCE_MAX_ATTEMPTS`).

`deriveSourceAction` is a LADDER. First match wins, and the order is part of the meaning:
1. no fixtures → none (EMPTY FIRST)
2. `stageStatus === "complete"` → none
3. `t = nextUnseatedSwissRound(fixtures)`. `t === 1` → none (round 1 is always by hand)
4. `t === null` → kind `complete_stage`, round = max `round_no`, scope = every seated board. Otherwise kind `pair_round`, round `t`, scope = seated boards of round `t-1`
5. scope empty → none (guard: the spec's "previous round has ≥ 1 seated board")
6. `skipped.has(skipKey(kind, round))` → none
7. any scope board `status === "abandoned"` and not decided → blocked `STAGE_NOT_READY`, boards sorted by (round, board)
8. any scope board not decided → waiting, `openBoards` sorted
9. else → pending

`deriveConfirmAction`: `latest === null` → none. `latest.status !== "draft"` → none. `tieCount > 0` → blocked (D4). `livePaused` → paused. Else → pending.

- [ ] **Step 1: Failing tests.** Fixture builders produce rows; expected values derive from the ladder and the declared constants. One `it` per rung, with the empty case first:
  - `empty stage derives none`
  - `complete stage derives none`
  - `round 1 is never armed` (round-1 shells only, and also round 1 partly seated)
  - `round 2 pending when every seated round-1 board is decided`. This includes a forfeited bye, since `decided: true` is supplied by the caller.
  - `waiting names the open boards in board order` (input order shuffled: an ordering-differential case)
  - `abandoned outranks waiting`: one abandoned plus one in play gives blocked. This is the ORDER pin. Swapping rungs 7 and 8 must red only this test.
  - `skip is sticky for its round only`: skip round 3 gives none; skip round 3 with round 3 seated and round 4 next gives round 4 pending.
  - `last round settled derives complete_stage with the last round`
  - `last round open derives waiting complete_stage`
  - `confirm: none / confirmed / stale / tie derives blocked / paused keeps paused / draft pending`
  - `tie derives blocked`
  - `retry delays rise and stop at the cap`
  - `every constant equals its spec value`: 60 s settle, 30 min hold, 10 min done, 10 s poll. The spec numbers are typed here ONCE as the declaration under test. Spec §4.2, §4.6.
- [ ] **Step 2: Add the property test** (fast-check, TEST-STRATEGY rule 10). Generate random Swiss stages (2–5 rounds, 2–9 entrants, random statuses including abandoned and byes) and assert after each: never `pending pair_round` with round 1. Never `pending` while a scope board is undecided. `waiting.openBoards` non-empty. Report `checked` and assert `checked > 0`.
- [ ] **Step 3: Run.** FAIL (module missing).
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run.** PASS. Paste `numPassedTests/numTotalTests`.
- [ ] **Step 6: Mutate each guard once:** rung 3 (`t === 1`), rung 5 (empty scope), rung 6 (skip), the rung 7/8 order, and D4. Name each one's killer in the commit body.
- [ ] **Step 7: Commit** `feat(auto-advance): pure derivation of a stage's live auto action`. e2e/smoke: traced to Task 5 / Task 17.

---

### Task 4: Switches in stage config, the write route, the read route

**Files:**
- Modify: `apps/web/src/server/api-v1/schemas.ts:1230` (StageConfig gains `autoPair: z.boolean().optional()` and `autoConfirmHandoff: z.boolean().optional()`). Add `StageAutoAdvancePatch`, `AutoActionView`, `StageAutoAdvanceOut` and `DivisionAutoActions` near `PatchSwissStage` (`:3085`), plus the registry entries (`:6265` pattern).
- Modify: `apps/web/src/server/engine-db/competition.ts:857` (`appendDivisionEvent(tx, divisionId, type, payload, actorId: string | null = null)`: the insert writes `actor_id`, and existing callers are unchanged).
- Create: `apps/web/src/server/usecases/auto-advance.ts` (this task: `setStageAutoAdvance`, `listDivisionAutoActions`, `toAutoActionView`)
- Create: `apps/web/src/app/api/v1/stages/[id]/auto-advance/route.ts` (PUT), `apps/web/src/app/api/v1/divisions/[id]/auto-advance/route.ts` (GET)
- Modify: `server/api-v1/openapi.ts:89`, `server/api-v1/key-scopes.ts:286`, then regenerate `openapi/v1.json` and `v1.public.json`
- Test: `apps/web/src/server/usecases/__tests__/auto-advance-switches.test.ts` (DB), `apps/web/src/app/api/v1/stages/[id]/auto-advance/__tests__/route.test.ts`
- Create (e2e, CI-run): `apps/web/e2e/swiss-auto-advance.spec.ts`. Create (smoke): `scripts/smoke/suites/swissAutoAdvance.ts`, registered in `scripts/smoke/main.ts` (`await suite("swissAutoAdvance", …)`, pattern `:1258`) and `scripts/smoke/index.ts` `SELECTABLE_SUITES` (`:61`), with a check-count guard like `w3SwissB.ts:777`.

**Interfaces:**
- Produces:
  - `StageAutoAdvancePatch = z.strictObject({ autoPair: z.boolean(), autoConfirmHandoff: z.boolean() }).partial().refine(non-empty)`.
  - `AutoActionView = { id, stageId, kind: AutoActionKind, state: AutoActionState, targetRound: number | null, proposalId: string | null, dueAt: string | null, doneAt: string | null, blockedCode: string | null, detail: Record<string, unknown> | null, result: Record<string, unknown> | null, updatedAt: string }`.
  - `StageAutoAdvanceOut = { autoPair: boolean; autoConfirmHandoff: boolean; actions: AutoActionView[] }`.
  - `DivisionAutoActions = { actions: AutoActionView[] }`: every live row of the division, plus `done` rows with `done_at > now() - AUTO_ADVANCE_DONE_VISIBLE_MS`.
  - `setStageAutoAdvance(auth: AuthCtx, stageId: string, patch: StageAutoAdvancePatch): Promise<StageAutoAdvanceOut>`.
  - `listDivisionAutoActions(auth: AuthCtx, divisionId: string): Promise<AutoActionView[]>`.
  - Division event `stage_auto_advance_switched { stage_id, key: "autoPair" | "autoConfirmHandoff", on: boolean }` written with `actorId = auth.userId`. It is written only when the value MOVES. Same value again writes nothing.
  - Refusals (422): `AUTO_PAIR_NOT_SWISS` (`autoPair` on a non-Swiss stage) and `AUTO_CONFIRM_NO_HANDOFF` (`autoConfirmHandoff` on a stage without `progression.timing === "setup"`). Turning a switch OFF is never refused.
  - The write merges server-side (`config = config || jsonb`, as `scoring.ts:1110` does), never a spread of a stale read.

- [ ] **Step 1: Failing DB tests.**
  - `defaults are off`: a fresh Swiss stage reads `autoPair: false` and no rows.
  - `turning autoPair on stores it and logs one switched event with the person`.
  - `same value twice logs once` (second-call case).
  - `autoPair on a knockout is refused by name`, with its positive pair: on the Swiss it passes.
  - `autoConfirmHandoff on a stage with no setup progression is refused`, with its positive pair.
  - `switch write does not revert another config key`: set `rank_overrides` between the read and the write, and it survives.
  - `an unknown key is a 400`.
- [ ] **Step 2: Route test.** 401 without auth. 400 on `{}`. 200 shape.
- [ ] **Step 3: Run.** FAIL.
- [ ] **Step 4: Implement** the routes, following the `seed-proposal/confirm` door: `requireResourceAuth(req,"stage",id,"write")`, and for GET `requireResourceAuth(req,"division",id,"read")`, then `parseBody`. Register both routes in openapi, key-scopes and the schema registry, then run `npm run openapi:gen`.
- [ ] **Step 5: Run the tests + changed-files tsc + `openapi:gen` + `git status --porcelain`** (only the expected spec files change).
- [ ] **Step 6: Write the e2e cases** (CI-run): `switch defaults off and turns on through the API`, and `GET auto-advance lists live rows` (empty list until Task 5; assert the shape now and extend in Task 5). Use setup from `e2e/helpers.ts` (`createStageAndGenerate` `:2186`, `apiJson` `:313`), never invented shapes (desk `_RULES.md` "Verification"). **Write the smoke suite**: switch on/off and refusal-by-name checks, with the check count asserted > 0.
- [ ] **Step 7: Mutate** the kind guard (allow any kind): the refusal test reds. Restore. Commit `feat(auto-advance): per-stage switches, write and read routes`.

---

### Task 5: `rearmAutoActions`, and arming from results, drafts and switches

**Files:**
- Create: `apps/web/src/server/auto-advance/settle.ts`. Modify: `apps/web/src/server/usecases/auto-advance.ts`.
- Modify: `apps/web/src/server/usecases/scoring.ts:1136-1150`. After `markDependentSeedProposalsStale`, and for every decided/void context (not only `TABLE_KINDS`), call `await rearmAfterCommit(auth.orgId, context.stage_id)`.
- Modify: `apps/web/src/server/usecases/stages.ts:6330` (`computeSeedProposal`): call `rearmAutoActions(tx, stageId)` INSIDE its transaction, right after the draft insert (`:6505`, the `insert into stage_seed_proposals`), so the draft and its confirm row commit together. Publish alarms after the commit. This one call covers every draft: `completeStage`'s, `markDependentSeedProposalsStale`'s (`:6989`), `markFieldChangeSeedProposalsStale`'s (`:7048`), and a manual Recompute.
- Modify: `setStageAutoAdvance` (Task 4) calls `rearmAfterCommit` after its write.
- Test: `apps/web/src/server/usecases/__tests__/auto-advance-rearm.test.ts` (DB), `apps/web/src/server/auto-advance/__tests__/settle.test.ts`

**Interfaces:**
- Consumes: Task 3's derivation and constants, and Task 1's table.
- Produces:
  - `resolveSettleMs(env: NodeJS.ProcessEnv = process.env): number`. Takes `E2E_AUTO_ADVANCE_SETTLE_MS` when it is an integer in [2000, 60000], else `AUTO_ADVANCE_SETTLE_MS` (D8).
  - `interface ArmedAlarm { rowId: string; stageId: string; dueAt: Date }`.
  - `rearmAutoActions(tx: Tx, stageId: string, opts?: { restartPending?: boolean }): Promise<ArmedAlarm[]>`.
  - `rearmAfterCommit(orgId: string, stageId: string, opts?: { restartPending?: boolean }): Promise<void>`. This runs its own `withTenant`, never throws (logs `auto_advance_rearm_failed`), and hands its alarms to `publishAutoActionAlarms`. That is a no-op stub here, filled in by Task 10.

`rearmAutoActions` body, in order:
1. Take `pg_advisory_xact_lock(hashtext('auto-advance:' || stageId))`.
2. Read the stage: kind, status, config, progression, org, division.
3. **Source half** (kind `swiss`). If `config.autoPair !== true`, close live pair/complete rows `cancelled/switch_off`. Otherwise build `SourceFacts`: fixtures with `decided = DECIDED.has(status)`, and `skipped` from `cancelled` rows whose `result->>'reason' = 'skip'`. Derive, then upsert.
4. **Confirm half** (`progression.timing === "setup"`). Same switch handling on `config.autoConfirmHandoff`. Facts are the latest proposal (`order by created_at desc, id desc limit 1`, as `getSeedProposal` `:6528`), `tieCount = computed.ties.length`, and whether the live confirm row is `paused`. Derive, then upsert.
5. **Upsert rules.** Skip rows under lease (D2). A different target retires the old row (D1). For the same target: `pending` sets `due_at = now + resolveSettleMs()` when `restartPending` or the row was not already pending. `paused` keeps its `due_at`. `blocked` (derived) writes `blocked_code` and `detail.boards`. `waiting` writes `detail.openBoards` and `due_at = null`. A fire-blocked row (`blocked_code` not derived) becomes `pending` again only when `restartPending`. Return the rows now `pending`.

- [ ] **Step 1: Failing settle test.**
  - `default is the spec's 60 s with the var unset` (pinned on the DEFAULT; D8).
  - `in-range override is honoured`.
  - `out-of-range, non-integer or empty falls back to 60 s` (`Number("") === 0` trap).
  - `no deploy config sets the override`: scan `fly*.toml`, `apps/web/.env.example`, `.env.example`, `apps/cron-worker/wrangler.json` for the var name, asserting files-scanned > 0, as `settled-poll-override.test.ts` does.
- [ ] **Step 2: Failing DB tests** (each seeds a real Swiss through the usecases and decides through `scoreEvent`, never by SQL, except where noted):
  - `empty stage arms nothing; round-1 shells arm nothing` (§5.12, empty first)
  - `switch on arms a complete round`: pending, `due_at` within `[now+settle-2s, now+settle+2s]` with settle from `resolveSettleMs()` (§5.8)
  - `last undecided board decided → pending`, and `one board open → waiting naming it`
  - `correction restarts due_at`: decide, advance the clock by moving `due_at` back 30 s with SQL, correct a round-2 result, and `due_at` is again ≈ now+settle (§5.2)
  - `void returns the row to waiting; re-decide re-arms` (§5.3)
  - `abandoned board blocks, deciding re-arms` (§5.6)
  - `switch off cancels` (§5.9): the row is `cancelled`, `result.reason = "switch_off"`
  - `tie derives blocked` (§5.7, D4): a draft with ties gives a confirm row blocked `SEEDING_TIE_UNRESOLVED`
  - `two-source target arms only after the last source` (§5.15): two leagues feeding one setup knockout; nothing after the first, pending after the second
  - `a leased row is left alone` (D2)
  - `second rearm with restartPending false keeps due_at`
  - `a non-swiss stage with no switches pays one read`: no rows written, for a league fixture decide
  - `badminton and chess Swiss arm the same way` (forEachSport-style loop over the two plus generic; count asserted 3)
- [ ] **Step 3: Run.** FAIL.
- [ ] **Step 4: Implement** `settle.ts`, `rearmAutoActions`, `rearmAfterCommit`, and the three call sites.
- [ ] **Step 5: Run** both test files + Task 3's + changed-files tsc. PASS, counts pasted.
- [ ] **Step 6: Extend e2e** (CI): `a decided round arms a pending pairing and a correction restarts it`. This is API-only: switch on, decide round 1 via `scoreFixture` (`helpers.ts:2428`) and read `GET /divisions/:id/auto-advance`. Extend the smoke suite: the `pending` row appears with `dueAt` in the window.
- [ ] **Step 7: Mutate:** (a) drop the `restartPending` restart, which reds the correction test; (b) drop the lease skip, which reds `a leased row is left alone`; (c) remove the onDecided call, which reds the arming tests. Commit `feat(auto-advance): rearm from results, drafts and switches`.

---

### Task 6: Manual actions retire the row; skip; unpair and Undo record a skip

**Files:**
- Modify: `apps/web/src/server/usecases/stages.ts`:
  - `generateStageFixtures` `:2998` (after the write commits), `completeStage` `:5683` (inside its `finally` path once completed), `confirmSeedProposal` `:6558` (after the commit, `:6913` area), `rebuildStageFixtures` `:4200`
  - `unpairSwissRound` `:3222`: in the same tx, insert a `cancelled` row `{reason:"skip", by:"unpair"}` for `pair_round` and the cleared round, then rearm after the commit
- Modify: `apps/web/src/server/usecases/swiss-rounds-admin.ts`: `addSwissRound` `:583` and `finishSwissNow` `:642` call `rearmAfterCommit`.
- Modify: `apps/web/src/server/usecases/history.ts:688` (`stepWrite`, the Swiss Pair undo branch at `:760-779`): record the same skip.
- Modify: `apps/web/src/server/usecases/auto-advance.ts`: add `recordAutoSkip`, `skipAutoAction`.
- Create: `apps/web/src/app/api/v1/stages/[id]/auto-advance/skip/route.ts` (POST), plus openapi/key-scopes/registry and regen.
- Test: `apps/web/src/server/usecases/__tests__/auto-advance-manual.test.ts` (DB)

**Interfaces:**
- Produces:
  - `recordAutoSkip(tx: Tx, stageId: string, kind: "pair_round" | "complete_stage", round: number, by: "person" | "unpair" | "undo"): Promise<void>`. This closes a live row of that kind and target as `cancelled {reason:"skip", by}`, or inserts one if none is live. It is idempotent.
  - `skipAutoAction(auth: AuthCtx, stageId: string, kind: "pair_round" | "complete_stage"): Promise<AutoActionView>`. 409 `AUTO_ADVANCE_NOTHING_TO_SKIP` when no live row of that kind exists. Confirm is never skippable: 422 `AUTO_ADVANCE_CONFIRM_NOT_SKIPPABLE`, since spec §4.2 stops confirm by pausing or the switch.
  - Body `AutoAdvanceSkip = z.strictObject({ kind: z.enum(["pair_round","complete_stage"]) })`.

- [ ] **Step 1: Failing DB tests.**
  - `manual pair retires the row as done by a person` (§5.4): the pending round-3 row becomes `done`, `result.by = "person"`, and a new `waiting` row exists for round 4.
  - `manual complete retires complete_stage`, and `manual confirm retires a pending confirm`.
  - `skip is sticky for its round only` (§5.13): skip round 3, correct a round-2 result, round 3 stays unarmed, pair round 3 by hand, decide it, and round 4 arms.
  - `skip twice: the second is 409 by name`.
  - `skip confirm is refused by name`.
  - `unpair records a sticky skip` (Review Focus 1): auto-pair on, round 2 complete, pair round 3, unpair round 3, and NO pending row for round 3. Its positive pair: pairing round 3 again by hand retires nothing and arms round 4 as waiting.
  - `undo of an auto pair records a sticky skip` (Review Focus 1, through `history.ts` undo).
  - `add a round during the completion countdown` (§5.18): last round settled gives a pending `complete_stage`, then `addSwissRound`. The stage stays `active`, the complete row becomes `cancelled/superseded`, and a `pair_round` row for the new round is pending (its previous round is complete).
  - `finish now retires complete_stage as done by a person`.
- [ ] **Step 2: Run.** FAIL. **Step 3: Implement.** **Step 4: Run** + tsc + openapi regen.
- [ ] **Step 5: e2e** (CI): `Pair next inside the window pairs once and the banner row retires` (API). Smoke: `skip refuses twice by name`.
- [ ] **Step 6: Mutate** the unpair skip insert (delete it): `unpair records a sticky skip` reds. Commit `feat(auto-advance): manual actions retire the clock; skip, unpair and undo are sticky`.

---

### Task 7: F1, the stale mark survives the refusal

**Files:**
- Modify: `apps/web/src/server/usecases/stages.ts:6589-6596` (`confirmSeedProposal`'s freshness branch). Today it runs `update … set status='stale'` and then throws inside the same `withTenant`, so the update rolls back. Add an export `seedProposalIsFresh`.
- Test: `apps/web/src/server/usecases/__tests__/seed-proposal-stale-commit.test.ts` (DB)

**Interfaces:**
- Produces:
  - `seedProposalIsFresh(tx: Tx, stageId: string, proposalId: string): Promise<boolean>`. This is the same hash comparison as `:6592-6593`, extracted so the confirm path and Task 8's fire path share it.
  - `confirmSeedProposal` keeps its 409 `SEEDING_PROPOSAL_STALE`. The stale mark is now written in a SEPARATE `withTenant` after the refusing transaction rolls back (`update … where id = $ and status = 'draft'`), followed by `rearmAfterCommit(orgId, stageId)`.

- [ ] **Step 1: Failing test** `a hash-stale confirm leaves the row stale after the 409`: draft a proposal, then override the source standings so the hash moves WITHOUT calling `markDependentSeedProposalsStale` (write the snapshot directly). Confirm gets 409 `SEEDING_PROPOSAL_STALE`, and re-reading the row gives `stale`. It reads `draft` today, which is the defect. Its positive pair: `a fresh confirm still confirms`.
- [ ] **Step 2: Run.** FAIL (`draft`). **Step 3: Implement.** **Step 4: Run.** PASS.
- [ ] **Step 5: e2e:** traced to Task 17's walkthrough (the confirm banner). Smoke: none new (the existing seed-proposal smoke covers confirm). State so.
- [ ] **Step 6: Mutate.** Move the stale write back inside the transaction: the test reds. Commit `fix(seeding): a stale proposal's mark survives the refusal (F1)`.

---

### Task 8: Firing: `fireAutoAction` and `runAutoAdvanceTick`

**Files:**
- Create: `apps/web/src/server/auto-advance/fire.ts`
- Test: `apps/web/src/server/auto-advance/__tests__/fire.test.ts` (DB), `apps/web/src/server/auto-advance/__tests__/chain.test.ts` (DB)

**Interfaces:**
- Consumes: `systemAuth` (Task 2), `rearmAutoActions` / `rearmAfterCommit` (Task 5), `seedProposalIsFresh` (Task 7), `generateStageFixtures`, `completeStage`, `confirmSeedProposal`, `computeSeedProposal`, `appendDivisionEvent` (Task 4 signature), and `autoActionRetryDelayMs`.
- Produces:
  - `type FireOutcome = "done" | "superseded" | "rearmed" | "blocked" | "retry" | "skipped"`.
  - `fireAutoAction(rowId: string): Promise<FireOutcome>`.
  - `interface AutoAdvanceTickReport { claimed: number; fired: number; blocked: number; retried: number; failed: number; rederived: number; released: number }`. `failed` counts throws in our own code. `released` is filled by Task 11.
  - `runAutoAdvanceTick(opts?: { stageId?: string; batch?: number }): Promise<AutoAdvanceTickReport>`.

Tick, in order, with the pooled privileged role (copy the outbox worker's role check, `email-outbox/worker.ts` header item 0):
- (a) **Re-derive waiting rows** (D6): for each distinct stage with a `waiting` row and no lease, `rearmAfterCommit(org, stage, {restartPending:false})`. Count `rederived`.
- (b) **Claim:** `update … set lease_until = now() + AUTO_ADVANCE_LEASE_MS, attempts = attempts + 1 where id in (select id … where state = 'pending' and due_at <= now() and (lease_until is null or lease_until < now()) [and stage_id = $] order by due_at limit $batch for update skip locked) returning id`.
- (c) **Fire each.**

`fireAutoAction`:
1. Under `withTenant(row.org_id)`, re-read the row. Not `pending`, or `due_at > now()`, or the switch is off: clear the lease and return `skipped`.
2. Re-derive. Changed target or state: clear the lease, `rearmAutoActions` (restartPending), return `rearmed`. For confirm, if `!seedProposalIsFresh` then mark it stale (Task 7's helper path), `computeSeedProposal(systemAuth, stage)` (which re-arms a fresh 60 s), and return `rearmed`.
3. Call the usecase as `systemAuth(row.org_id)`:
   - `pair_round` → `generateStageFixtures`. `created === 0` → `superseded`.
   - `complete_stage` → `completeStage`. `completed === false` → `rearmed`.
   - `confirm_handoff` → `confirmSeedProposal(sys, stageId, { proposalId })` with NO edits or tiePicks.
4. Success: `done`, `done_at`, `result = {by:"system", round | proposalId, filled?}`, lease cleared. `appendDivisionEvent(tx, divisionId, "stage_auto_paired" | "stage_auto_completed" | "stage_handoff_auto_confirmed", {stage_id, round | proposal_id}, null)` with no `divisions.seq` bump (D7). Then `rearmAfterCommit` (the next round's `waiting`).
5. `HttpError` with a `code`, or `EngineError`: `blocked`, `blocked_code = code`, `detail = extra/params`, no retry. Any other throw: below `AUTO_ADVANCE_MAX_ATTEMPTS`, `pending` with `due_at = now + autoActionRetryDelayMs(attempts)` → `retry`; at the cap, `blocked AUTO_ADVANCE_FAILED`. Log with the row id, never a secret.

- [ ] **Step 1: Failing DB tests (fire.test.ts).** Every row is made due by setting `due_at = now() - 1s` with SQL. That is the clock's only stand-in.
  - `tick on an empty table claims 0 and reports it` (empty first)
  - `a not-yet-due row is not claimed`
  - `fire after a manual pair is a no-op` (§5.4): exactly one `fixtures_generated` for round 3
  - `two concurrent ticks pair once` (§5.5): `Promise.all([tick(), tick()])`, one pairing, the claims sum to 1
  - `cancelled row never fires` (§5.9)
  - `manual confirm retires a tie-blocked row` (§5.7)
  - `SWISS_NO_LEGAL_PAIRING blocks with its code and is not retried by the next tick`
  - `field under two blocks with the refusal` (§5.10b)
  - `an unexpected throw retries with backoff, then blocks AUTO_ADVANCE_FAILED at attempt 5`. Inject the throw through a test-only seam such as `opts.__failOnce` on the tick, mirroring the outbox `onlyIds` seam. The delays are asserted from `autoActionRetryDelayMs`.
  - `a stale proposal re-drafts and re-arms instead of confirming`
  - `tick re-derives a waiting row whose round settled without onDecided` (Review Focus 2): decide the last board by direct SQL status write, tick, and the row is `pending`. Report `rederived ≥ 1`.
  - `the automatic pairing is recorded with no person`: the `stage_auto_paired` row has `actor_id` null, and the `fixtures_generated` row's actor is null.
  - `withdrawal between rounds pairs the smaller field` (§5.10a)
- [ ] **Step 2: Failing chain tests (chain.test.ts),** run per sport `generic`, `badminton`, `chess` (count asserted 3; TEST-STRATEGY rule 6, with the reason noted for not sweeping every sport: Swiss is only offered for these at pin. Verify that claim against the sport registry and widen the list if it is false), with an ODD field (5 entrants, a bye):
  - `full chain pairs, completes and confirms` (§5.1): 3 rounds, autoPair on the Swiss, autoConfirmHandoff on the setup knockout. Decide every board by `scoreEvent` and tick after each window. The expected qualifiers come from the engine's own standings for the decided results (`getStandings`), never from the proposal under test.
  - `pairing reads the corrected result` (§5.2): correct a round-1 result inside the window. Round-2 pairings equal those `swissGen` produces from the corrected standings, computed by calling the engine pairing on the corrected table in the test.
  - `gold waits, silver confirms` (§5.16): the Swiss feeds two setup knockouts, with the switch on for silver only.
- [ ] **Step 3: Run.** FAIL. **Step 4: Implement.** **Step 5: Run** (both files, plus Task 5's) and tsc.
- [ ] **Step 6: e2e** (CI; settle shortened by D8 in e2e.yml, Task 17): `the clock pairs round 2 after the window`. Switch on, decide round 1, wait for `dueAt`, then `POST /api/cron/auto-advance` (Task 9). That leaves this case `test.fixme` until Task 9 lands. Task 9 removes the fixme, so the branch stays green. Smoke: none here (Task 9 adds the route check).
- [ ] **Step 7: Mutate:** (a) remove the `for update skip locked` / lease predicate: the concurrency test must red (run it 3×); (b) remove the step-1 switch re-check: the cancelled test reds; (c) treat typed refusals as retryable: the no-retry test reds. Commit `feat(auto-advance): fire due rows through the same usecases as a system actor`.

---

### Task 9: The cron route and the cron-worker job

**Files:**
- Create: `apps/web/src/app/api/cron/auto-advance/route.ts`. Copy `api/cron/email-outbox/route.ts:21-27` exactly: `handler()`, 503 before 401, `x-cron-secret` against `CRON_SECRET`, then `runAutoAdvanceTick()` with production defaults ONLY.
- Modify: `apps/cron-worker/src/schedule.ts` (JOBS row `{ id: "auto-advance", path: "/api/cron/auto-advance", trigger: FAST_TRIGGER, due: every, retry: false, manual: true, failureCounts: ["data.failed"] }`, after the email-outbox row `:167-175`)
- Modify tests: `apps/cron-worker/test/schedule.test.ts:33,39` (FAST_ROWS, EVERY_FIRING_ROWS), `test/index.test.ts:57` (FAST path list), `test/drift.test.ts:74` (failure-counter total `toBe(12)` → 13)
- Test: `apps/web/src/app/api/cron/auto-advance/__tests__/route.test.ts` (mocks the tick, like `email-outbox/__tests__/route.test.ts:24`)

- [ ] **Step 1: Failing tests.**
  - `503 when CRON_SECRET is unset`, `401 on a wrong secret`, and `200 runs the tick once with no options`.
  - The cron-worker tests are updated to name the new row, so they red until the row exists. `drift.test.ts` reds on its own the moment the route exists without a row.
- [ ] **Step 2: Run** (route test + the three cron-worker test files, by path, from `apps/cron-worker`). FAIL.
- [ ] **Step 3: Implement.** **Step 4: Run.** PASS.
- [ ] **Step 5:** Remove Task 8's `test.fixme` in `e2e/swiss-auto-advance.spec.ts`. Smoke: `cron route refuses a wrong secret` (401) and `answers 200 with a report` (CI smoke has `CRON_SECRET`; if it does not, record the check as skipped by name, never silently).
- [ ] **Step 6: Mutate** the 401 compare (`!==` → always pass): the 401 test reds. Commit `feat(cron): auto-advance sweep on the fast trigger`.

---

### Task 10: QStash alarm (env-gated)

**Files:**
- Create: `apps/web/src/server/auto-advance/qstash.ts`
- Create: `apps/web/src/app/api/internal/auto-advance/fire/route.ts`. This file must NOT contain the string `x-cron-secret`; `cron-worker/test/drift.test.ts:18-21` treats any file that does as a cron route.
- Modify: `apps/web/src/server/usecases/auto-advance.ts` (`rearmAfterCommit` hands alarms to `publishAutoActionAlarms`), `.env.example:189` area and `apps/web/.env.example:233` area (commented `QSTASH_TOKEN=`, `QSTASH_CURRENT_SIGNING_KEY=`, `QSTASH_NEXT_SIGNING_KEY=`, `QSTASH_URL=`)
- Test: `apps/web/src/server/auto-advance/__tests__/qstash.test.ts`, `apps/web/src/app/api/internal/auto-advance/fire/__tests__/route.test.ts` (DB for the race case)
- Read first: `node_modules/next/dist/docs/` on route handlers, and whether the request proxy/middleware touches `/api/internal/*` (check `apps/web/src/proxy.ts` or `middleware.ts`)

**Interfaces:**
- Produces:
  - `publishAutoActionAlarms(alarms: ArmedAlarm[], env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): Promise<void>`. A no-op without `QSTASH_TOKEN`. Otherwise one `POST ${QSTASH_URL ?? "https://qstash.upstash.io"}/v2/publish/${siteOrigin()}/api/internal/auto-advance/fire?stage=${stageId}` per alarm, headers `Authorization: Bearer <token>` and `Upstash-Delay: <ceil(secondsUntil dueAt)>s`. It never throws (logs). `siteOrigin` is `lib/site-origin.ts:6`.
  - `verifyQstashRequest(rawBody: string, signature: string | null, expectedUrl: string, env?: NodeJS.ProcessEnv): Promise<boolean>`. Verification is `jose.jwtVerify(signature, key, { algorithms: ["HS256"], issuer: "Upstash", subject: expectedUrl })` with the current signing key, then the next. The claim `body` must equal base64url(sha256(rawBody)), padding stripped on both sides. jose enforces `exp`/`nbf`. The decision is taken from Upstash's published verification spec, not from this code.
  - Route `POST /api/internal/auto-advance/fire?stage=<uuid>`: raw body via `await req.text()` (as `webhooks/resend/route.ts:104`). The expected URL is rebuilt from `siteOrigin()` + path + search, NOT `req.url`, because the host differs behind the proxy. Responses: 503 if no signing keys, 401 if the signature is bad, 400 if the stage is not a uuid, 200 `runAutoAdvanceTick({ stageId })`.

- [ ] **Step 1: Failing unit tests.** Tokens are signed in-test with `jose.SignJWT` using the documented claims:
  - `valid current key passes`, `next key passes after rotation`, `wrong key fails`
  - `body tampered fails`, `subject for another url fails`, `expired fails`, `issuer not Upstash fails`
  - `publish is a no-op without a token` (fetch spy called 0 times) and `publish sends one request per alarm with the delay header` (fetch spy; the delay is derived from `dueAt - now`)
  - `a publish failure never throws`
- [ ] **Step 2: Failing route/DB tests.**
  - `401 forged`, `503 unconfigured`
  - `a message before due fires nothing` (Review Focus 5)
  - `a duplicate message fires once`
  - `qstash fire racing the sweep pairs once` (§5.5): `Promise.all([routeCall, runAutoAdvanceTick()])`
- [ ] **Step 3: Run.** FAIL. **Step 4: Implement.** **Step 5: Run** + tsc.
- [ ] **Step 6:** e2e: none can reach QStash in CI (no credentials). State the trace: this path runs the same `runAutoAdvanceTick` that Task 9's e2e drives, and the route is proven by its route test. Smoke: `internal fire route is 401 without a signature`.
- [ ] **Step 7: Mutate** the `body` hash check (skip it): `body tampered fails` reds. Commit `feat(auto-advance): optional QStash alarm with signed fire route`.

---

### Task 11: Hold and release (pause while a person edits the draft)

**Files:**
- Modify: `apps/web/src/server/usecases/auto-advance.ts` (`holdSeedProposal`, `releaseSeedProposal`) and `fire.ts` (tick step (d): release paused rows that are due)
- Create: `apps/web/src/app/api/v1/stages/[id]/seed-proposal/hold/route.ts`, `.../release/route.ts` (POST), plus openapi/key-scopes/registry and regen
- Modify: `apps/web/src/components/v2/progression-panel.tsx` (`:217`; the edits state around `:276`). Add a `useSeedProposalHold(stageId: string, dirty: boolean)` hook in `apps/web/src/components/v2/use-seed-proposal-hold.ts`.
- Test: `apps/web/src/server/usecases/__tests__/auto-advance-hold.test.ts` (DB), `apps/web/src/components/v2/__tests__/seed-proposal-hold.test.ts` (pure transition function, node env)

**Interfaces:**
- Produces:
  - `holdSeedProposal(auth, stageId): Promise<AutoActionView | null>`. A live confirm row → `paused`, `due_at = now + AUTO_ADVANCE_HOLD_MAX_MS` (D9). With no live row (switch off, no draft) it returns `null`, 200, a no-op. A held row is re-held idempotently and its 30 minutes restart.
  - `releaseSeedProposal(auth, stageId): Promise<AutoActionView | null>`. `paused` → `rearmAutoActions(restartPending:true)` → `pending`, a fresh 60 s.
  - Tick (d): `paused` rows with `due_at <= now()` are released the same way. Count `released`.
  - `holdTransition(prevDirty: boolean, nextDirty: boolean): "hold" | "release" | null` (pure, exported for the node test). The hook calls `hold` on false→true and `release` on true→false. On `pagehide` while dirty it sends `navigator.sendBeacon(".../release")`.
  - `rearmAutoActions` keeps `paused` across a re-draft by retargeting `target_proposal_id` (Task 3 `livePaused`).

- [ ] **Step 1: Failing DB tests (§5.14).**
  - `hold pauses the countdown`: a paused row is not claimed by a tick even with its original `due_at` passed
  - `edits + Confirm confirms once with the edits`: the edited slot holds the edited entrant, the row is `done` by a person, a later tick does nothing, and there is no `SEEDING_ALREADY_CONFIRMED` anywhere
  - `release re-arms a fresh 60 s`
  - `tab closed → released at 30 min`: set `due_at` past with SQL, tick, the row is `pending` with ≈ settle, `released = 1`
  - `hold with the switch off is a 200 no-op`
  - `a correction while paused stays paused and retargets the new draft`
- [ ] **Step 2: Failing pure test** `first local edit holds; revert releases` (Review Focus 3): `holdTransition(false,true) === "hold"`, `(true,false) === "release"`, and `(true,true) === null`. That last one is the second-call case: a second edit sends nothing.
- [ ] **Step 3: Run.** FAIL. **Step 4: Implement** (the panel derives `dirty` from its existing local edits/tie selections ≠ the computed slate). **Step 5: Run** + tsc + openapi regen.
- [ ] **Step 6:** e2e (CI): `editing the drafted list pauses auto-confirm` drives the real `<select>` in `progression-panel.tsx:433-465` at 1280 and asserts the GET shows `paused`. Smoke: `hold then release round-trips`.
- [ ] **Step 7: Mutate** the tick's paused exclusion (claim paused rows too): `hold pauses the countdown` reds. Commit `feat(auto-advance): pause auto-confirm while a person edits the draft`.

---

### Task 12: Legacy division `auto_progress` steps aside

**Files:**
- Modify: `apps/web/src/server/usecases/scoring.ts:1156-1174` (`maybeAutoAdvance`). After the division check, `select kind, status, config from stages`. If `kind = 'swiss'` and `config->>'autoPair' = 'true'`, return `false`.
- Test: `apps/web/src/server/usecases/__tests__/auto-progress-steps-aside.test.ts` (DB)

- [ ] **Step 1: Failing tests.**
  - `auto_progress steps aside for an autoPair stage` (§5.17): division `auto_progress` on, stage `autoPair` on, decide the last board. The stage is still `active`, and a pending `complete_stage` row exists. After the window plus a tick, the stage is `complete` and `stage_auto_completed` was written, not `stage_auto_advanced`.
  - Regression (the positive pair): `auto_progress alone still completes instantly`, with autoPair off. The stage is `complete` right after the decide and `stage_auto_advanced` is written with the scorer.
- [ ] **Step 2: Run.** FAIL (the first one completes instantly). **Step 3: Implement.** **Step 4: Run.** PASS.
- [ ] **Step 5:** e2e: traced to Task 17's walkthrough (division with `auto_progress` is not set there, so add an API-only case `legacy auto_progress waits for the window when auto-pair is on` to `swiss-auto-advance.spec.ts`). Smoke: none (the DB test is the proof; state so).
- [ ] **Step 6: Mutate** (invert the check): the regression test reds. Commit `feat(auto-advance): division auto_progress yields to an auto-pair stage`.

---

### Task 13: Banner view-model and its copy

**Files:**
- Create: `apps/web/src/lib/auto-advance-banner.ts` (pure, client-safe)
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`, then regen `lib/i18n-keys.ts`
- Test: `apps/web/src/lib/__tests__/auto-advance-banner.test.ts`

**Interfaces:**
- Consumes: `AutoActionView` (Task 4), the constants (Task 3).
- Produces:
  - `interface BannerContext { stageName: string; showStageName: boolean; sourceStageName: string | null; targetStageName: string | null; qualifierCount: number | null; now: Date; locale: string }`.
  - `type BannerAction = { kind: "pair_now" | "skip" | "add_round" | "confirm_now" | "open_board" | "pick_tie"; labelKey: MessageKey; params?: Record<string, string | number>; fixtureId?: string }`.
  - `interface BannerModel { tone: "amber" | "green" | "red" | "grey"; titleKey: MessageKey; titleParams; bodyKey: MessageKey | null; bodyParams; bodyCount?: number; actions: BannerAction[]; dismissKey: string; testId: string }`.
  - `autoAdvanceBanner(view: AutoActionView, ctx: BannerContext): BannerModel | null`. It returns null for `cancelled` and for a `done` row older than `AUTO_ADVANCE_DONE_VISIBLE_MS`.
  - `dismissKey = \`autoAdvance:dismissed:${stageId}:${kind}:${state}:${dueAt ?? doneAt ?? ""}\``. That is how "× until the state changes" works: a new state or a new `due_at` is a new key.
  - The time in `done` copy is formatted in the VENUE zone (desk `_RULES.md` "governing clock"). The caller passes it; read `resolveVenueTz` usage in stages-panel.

English source copy (mockup, spec §4.6). Keys go under `autoAdvance.*`:

| state × kind | title | body | actions |
|---|---|---|---|
| waiting · pair | Auto-pairing is waiting. | Round {round}: board {boards} is still being played. Round {next} will be paired 1 minute after it is decided. (plural: "boards {boards} are … after they are decided.") | × |
| pending · pair | Pairing round {next} in about a minute. | Every board in round {round} is decided. Correct a result now to restart the wait. | Pair now · Skip this time |
| blocked · pair | Auto-pairing stopped. | reason line (below) | fix button · × |
| done · pair | Round {round} was paired automatically at {time}. | — | × |
| waiting · complete | Auto-complete is waiting. | Round {round}: board {boards} is still being played. The stage will be completed 1 minute after it is decided. (plural as above) | × |
| pending · complete | Completing the stage in about a minute. | Need another round? Add it now. | Add a round · Skip this time |
| blocked · complete | Auto-complete stopped. | reason line | fix · × |
| done · complete | The stage was completed automatically at {time}. | — | × |
| pending · confirm | Confirming who moves on in about a minute. | The {source} stage is complete and the top {count} are drafted for the {target}. Check the list now if you want to change it. (plural on count) | Confirm now · × |
| paused · confirm | Paused while you review who moves on. | Confirm when ready. | × (closes only) |
| blocked · confirm | Auto-confirm stopped. | A tie decides who moves on. Pick it, then confirm. | Pick the tie · × |
| done · confirm | Who moves on was confirmed automatically at {time}. | — | × |

Reason lines: `STAGE_NOT_READY` with boards → "Round {round}: board {board} was abandoned. Decide or void it." plus "Open board {board}". `SWISS_NO_LEGAL_PAIRING` → "No legal pairing for round {round}. Pair by hand or add a round." `SCHEDULE_LOCKED` → "The division is frozen." `AUTO_ADVANCE_FAILED` → "Auto-advance hit a problem. Use the button." Any other code → "Auto-advance stopped ({code}). Use the button.", which is never silent. With `showStageName`, the title is prefixed "{stage} · ". The mockup shows **Skip this time** on the pending confirm, but spec §4.2 makes confirm unskippable, so the plan follows the spec and leaves it out (R2). Close button aria-label: "Close".

- [ ] **Step 1: Failing tests.** One per row of the table, asserting the keys, tone and action kinds:
  - `no banner for a cancelled row` (empty first)
  - `done expires after the declared window`: the boundary uses `AUTO_ADVANCE_DONE_VISIBLE_MS` ±1 ms
  - `unknown code renders the generic line with the code`
  - `stage name appears only when showStageName`
  - `dismiss key changes when due_at changes` (a correction must re-show the banner)
  - `abandoned-board reason offers Open board with that fixture`
  - Plus a sweep `every BannerModel key exists in all four locales`, which loads the four dictionaries and reports the count checked (> 0)
- [ ] **Step 2: Run.** FAIL. **Step 3: Implement + write all four locales + `npm run i18n:gen-keys` + `npm run i18n:check`.** **Step 4: Run** (+ `retired-plan-copy.test.ts`, `dictionary-copy-truth.test.ts`). PASS.
- [ ] **Step 5:** e2e: traced to Task 14. Smoke: none (pure; state so).
- [ ] **Step 6: Mutate** the done-window boundary (`>` → `>=` the wrong way): the boundary test reds. Commit `feat(auto-advance): banner view-model and copy in four locales`.

---

### Task 14: The banner on the fixtures tab

**Files:**
- Create: `apps/web/src/components/v2/desk/auto-advance-banner.tsx`
- Modify: `apps/web/src/components/v2/stages-panel.tsx`. The stage-card map is at `:1220` and the card `<section className="card" data-stage-id>` at `:1629`. Render one `<AutoAdvanceBanner>` per stage directly ABOVE each stage's card (Option A, spec §4.6 amendment), full width. Pass `autoActions` and venue tz in.
- Modify: `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx` (`:994`, the StagesPanel mount): add `autoActions = await listDivisionAutoActions(auth, divisionId)` and pass it.
- Modify: `apps/web/src/components/v2/desk/band-poll.ts:51`. Add an optional `periodMs?: number` param (default `bandPollMs(live)`), so existing callers are unchanged. Its existing test pins the default.
- Test: extend `apps/web/src/components/v2/desk/__tests__/band-poll*.test.ts` (the existing file; find it), and the e2e spec

**Interfaces:**
- Consumes: `autoAdvanceBanner` (Task 13), `startBandPolling` + `browserBandPollDeps()` (`band-poll.ts:51,89`), `apiV1` (`lib/client-v1.ts:18`).
- Produces: `<AutoAdvanceBanner stage={StageRow} actions={AutoActionView[]} stageCount={number} stages={StageRow[]} venueTz={string} canEdit={boolean} />`.
  - It polls `GET /api/v1/divisions/:id/auto-advance` every `AUTO_ADVANCE_POLL_MS` while any live row exists for the division. When a row it showed as live comes back `done`, it calls `router.refresh()` ONCE.
  - × writes the `dismissKey` to localStorage.
  - Pair now → `POST /stages/:id/generate {}` (as `stages-panel.tsx:877`). Skip → Task 6 route. Add a round → existing `POST /stages/:id/swiss/add-round`. Confirm now → `POST /stages/:id/seed-proposal/confirm {proposalId}`. Open board → the board row's existing link in the run sheet. Pick the tie → scroll to the ProgressionPanel. Each action ends in `router.refresh()`.
  - Refusals show inline via `ApiV1Error`, never as an alert.
  - `canEdit` false → copy only, no buttons.
  - Phones: one column, buttons full-width ≥ 44 px under the text, reason line wraps (`min-w-0` on the whole chain, no `truncate`).

- [ ] **Step 1: Failing band-poll test** `explicit period overrides, default unchanged`. Run (FAIL), implement, run (PASS).
- [ ] **Step 2: Build the component** with the `frontend-design` skill: house theme tones, the mockup is layout only. Mount it above the cards, and the confirm banner above the TARGET card (it keys on the row's `stageId`).
- [ ] **Step 3: e2e (CI) in `swiss-auto-advance.spec.ts`,** set up through the API, rows in each state:
  - `banner shows pending with Pair now and Skip` and `Pair now pairs and the banner turns grey after refresh`
  - `× closes until the state changes`: close, correct a result, and it reappears
  - `blocked banner names the abandoned board and opens it`
  - `banner names its stage only when the division has more than one` (Review Focus 4)
  - `confirm banner sits above the knockout card` (DOM order: banner's next sibling is the target card)
  - In `mobile.spec.ts` (all seven widths): `auto-advance banner: no page scroll, buttons ≥44 and hit-tested, reason not truncated`. Use `:visible` locators and print the banner text beside each width gate (desk `_RULES.md` "Print the asserted CONTENT"). This is a whole-spec change, so the controller dispatches the full `mobile.spec.ts` on CI, never a `-g` slice (AGENTS.md class 21).
- [ ] **Step 4:** Screenshot at 1280, 768 and 320 (prod build with `SKIP_TYPECHECK=1` and the local env skill), zoomed to the banner. Save under `~/seazn-artifacts/2026-11-08_swiss-auto-advance-build/` and serve on :8765, never in the repo. Compare the control SET at 320 vs 1280.
- [ ] **Step 5:** changed-files tsc. Smoke: none (UI; the e2e is the proof). Commit `feat(desk): auto-advance banner above each stage card`.

---

### Task 15: The two switches in the Format tool

**Files:**
- Modify: `apps/web/src/components/v2/stages-panel.tsx:2891` (`StageRulesArea`, the Format panel; the `MatchFormatEditor` mount is at `:3113`). Append a "Running the stage" group.
- Create: `apps/web/src/components/v2/desk/stage-auto-advance-switches.tsx`
- Modify: the 4 locale `ui.json` + regen keys
- Test: e2e in `swiss-auto-advance.spec.ts`. Pure visibility rule `autoAdvanceSwitchesFor(stage: StageRow): { autoPair: boolean; autoConfirmHandoff: boolean }` in `lib/auto-advance-banner.ts` with a unit test in Task 13's file.

**Interfaces:**
- Consumes: `PUT /stages/:id/auto-advance` (Task 4).
- Produces:
  - `<StageAutoAdvanceSwitches stage={StageRow} canEdit={boolean} />`. It uses an inline `role="switch"` with `aria-checked`, the house toggle classes `TOGGLE_ON`/`TOGGLE_OFF` (`rules/division-rules-strip.tsx:108`), and the pattern in `showcase-optin.tsx:41`. It saves on change, then `router.refresh()`.
  - `autoPair` is shown only for `kind === "swiss"`. `autoConfirmHandoff` is shown only when `progression?.timing === "setup"`. A stage that qualifies for neither renders no group.
  - Copy: group "Running the stage". "Pair the next round automatically" / "1 minute after every board in the round is decided. Correcting a result restarts the wait. After the last round it also completes the stage." "Confirm who moves on automatically" / "1 minute after the previous stage completes. Ties still need you." (P5). Footer "Changes save as you switch them."

- [ ] **Step 1: Failing unit tests** `switches for a swiss / a setup knockout / a league (empty first: neither)`.
- [ ] **Step 2:** Implement + locales + regen + check. Run the unit tests. PASS.
- [ ] **Step 3: e2e (CI):**
  - `Format tool shows the auto-pair switch on a Swiss and turning it on arms a complete round`: open the tool through `e2e/helpers/stage-tools-sheet.ts` on phones. The switch opens at OFF: pin the seeded VALUE, AGENTS.md class 19.
  - `confirm switch shows on the knockout, not the Swiss`
  - Phone widths: hit-test the switch.
- [ ] **Step 4:** Screenshots at 1280/768/320 as in Task 14. Commit `feat(desk): auto-advance switches in the stage Format tool`.

---

### Task 16: History labels

**Files:**
- Modify: `apps/web/src/components/v2/history-panel.tsx:61-78` (`TYPE_LABEL_KEYS`), plus an `AUTOMATIC_TYPES` set rendering the "Automatically · " prefix (P3)
- Modify: the 4 locale `ui.json` + regen
- Test: `apps/web/src/components/v2/__tests__/history-auto-labels.test.ts` (node; test the exported label/prefix functions)

**Interfaces:**
- Produces:
  - Keys and labels: `stage_auto_paired` → "Next round paired", `stage_auto_completed` → "Stage completed", `stage_handoff_auto_confirmed` → "Who moves on confirmed", `stage_auto_advanced` → "Stage completed automatically after a result" (F2; no prefix, because it is a person's result), `stage_auto_advance_switched` → "Auto-advance setting changed".
  - If `HistoryRow` carries `payload` at pin, interpolate the round ("Round {round} paired"). Otherwise the static label stands. Check `history-panel.tsx:23` and record which.
  - `export function historyEventPrefixKey(type: string): MessageKey | null`: the "Automatically" key for the three automatic types, null for everything else.

- [ ] **Step 1: Failing tests.**
  - `automatic types get the prefix`
  - `a null-actor api-key event (fixtures_generated) gets none` (P3's positive/negative pair)
  - `every new type has a key in all four locales` (count > 0)
- [ ] **Step 2:** Implement + locales + regen + check. PASS.
- [ ] **Step 3:** e2e: traced to Task 17's walkthrough (History tab reads "Automatically"). Smoke: none (pure; state so).
- [ ] **Step 4: Mutate** (prefix on every type): the api-key case reds. Commit `feat(history): automatic auto-advance entries read "Automatically"`.

---

### Task 17: Walkthrough, CI env, final e2e sweep

**Files:**
- Create: `apps/web/e2e/walkthrough/swiss-auto-advance.spec.ts` (project=walkthrough)
- Modify: `apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts:184` (`WALKTHROUGH_SPECS` += `"swiss-auto-advance.spec.ts"`)
- Modify: `.github/workflows/e2e.yml` (job-level env beside `NEXT_PUBLIC_E2E_SETTLED_POLL_MS` at `:645`): `E2E_AUTO_ADVANCE_SETTLE_MS: "3000"`, with the house-style comment on why and where the default is pinned (D8). Do this in EVERY job that runs Playwright and starts a server. `CRON_SECRET` is already job-level (`:604`).
- Modify: the walkthrough README index (`apps/web/e2e/walkthrough/README.md`) if it lists specs

- [ ] **Step 1: Write the walkthrough.** Setup goes through the API (a chess division, 5 entrants, a 3-round Swiss feeding a setup knockout). Every event under test is TAPPED at 1280:
  - Turn both switches on in the Format tool
  - Pair round 1 by hand (round 1 is never automatic)
  - Score every round-1 board through the UI
  - Read the pending banner text
  - Correct one result, and read that the banner's countdown re-showed (dismiss first, so its reappearance is the witness)
  - Wait out `dueAt` and post the cron tick
  - Read "Round 2 was paired automatically at …" and see round 2's boards
  - Repeat through round 3, then "Completing the stage…", then the confirm banner above the knockout card
  - Edit one slot (the banner reads Paused), revert, and confirm-by-clock
  - The knockout shows the qualifiers drawn from the standings read off the Standings tab
  - Open History: "Automatically · Next round paired" appears twice and no person is named on those rows
  - Each step prints what the screen says beside its assertion.
- [ ] **Step 2:** Run `e2e-ci-wiring.test.ts` locally by path (PASS). Then the controller dispatches `gh workflow run e2e.yml --ref feat/swiss-auto-advance` and reads the job results for `swiss-auto-advance.spec.ts`, `walkthrough/swiss-auto-advance.spec.ts`, and the full `mobile.spec.ts` at all seven widths. If a serial file is red, its count is a floor, not a total: re-run after each fix.
- [ ] **Step 3:** Commit `test(e2e): Swiss auto-advance walkthrough and CI settle override`.

---

## Self-review

- **Spec coverage.**
  - §4.1 switches: T4, T15.
  - Round-1 rule: T3, T5.
  - Legacy `auto_progress`: T12.
  - Auto-complete: T3, T8.
  - §4.2 table: T1. `rearmAutoActions` and its triggers: T5, T6. Skip: T6. Re-draft: T5. Hold/release/30 min: T11. 60 s constant: T3, with the env override T5/T17.
  - §4.3 cron: T8, T9. QStash: T10. Firing steps 1–5: T8.
  - §4.4 blocked table: T3 (derived), T8 (refusals), T13 (copy). F1: T7.
  - §4.5 system actor: T2.
  - §4.6 banner: T13, T14. Placement, the amendment: T14. Switches in Format: T15. Copy: T13.
  - §4.7 history: T16.
  - §5 1–18: the table above.
  - §6: Global Constraints.
  - §8 (QStash provisioning) is an owner action, recorded in R3.
- **Types.** `AutoActionView` (T4) is consumed by T13 and T14. `ArmedAlarm` (T5) is consumed by T10. `rearmAfterCommit` is used in T6, T7, T8 and T11 with one signature. `seedProposalIsFresh` comes from T7 and is used in T8. `systemAuth` comes from T2 and is used in T8. `FireOutcome` and `AutoAdvanceTickReport` stay inside T8–T11.
- **Order keeps the branch green.**
  - T1–T3 are leaves.
  - T4 needs T1.
  - T5 needs T3 and T4.
  - T6 needs T5.
  - T7 is independent.
  - T8 needs T2, T5 and T7. Its one e2e case is `fixme` until T9.
  - T10 needs T8.
  - T11 needs T8.
  - T12 needs T8.
  - T13 needs T4.
  - T14 needs T13.
  - T15 needs T4.
  - T16 is independent.
  - T17 comes last.
- **Proportion.** About 700 lines against a 300-line spec (the copy table, the false-premise table and the §5 map are most of the excess). Code appears only as signatures, the two derivation ladders, and the copy table, which the spec fixes.

## Open risks (owner-visible)

- R1. The confirm switch is placed on the TARGET stage (spec) while the mockup draws it on the Swiss (P5). Owner to confirm before T15 ships its copy.
- R2. The mockup shows "Skip this time" on the pending confirm banner, but spec §4.2 says confirm is not skippable. The plan follows the spec.
- R3. QStash needs owner provisioning (spec §8). Until then prod fires 60–120 s after the last result, and stg up to 5 min.
- R4. V-number contention (D10): five open lines of work claim V492–V496.
- R5. Hold-on-first-edit (P2) is the plan's reading of "opening the editor". An organiser who only LOOKS at the draft does not pause the clock.
- R6. `.github/workflows/e2e.yml` is live CI. T17's env addition takes effect on the next push to main.

---

Plan complete and saved to `docs/superpowers/plans/2026-11-08-swiss-auto-advance.md`. Execution method already supplied: subagent-driven (superpowers:subagent-driven-development), with Opus implementer and reviewer per task. Please review the plan. Does it capture what you want?
