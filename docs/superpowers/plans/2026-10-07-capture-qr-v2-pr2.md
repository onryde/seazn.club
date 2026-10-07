# Capture QR v2 — PR-2 (organiser extras) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Execution note (owner instruction, 2026-10-07).** Subagent-driven. Implementers and the per-task / per-batch reviewers
> run on **Sonnet**; the final whole-branch review runs on **Opus**. This supersedes `docs/superpowers/RULES.md`
> "Agent topology" (which still says "never Sonnet for any of the three"); RULES.md is not edited by this plan. Dispatch
> briefs state the override. Every brief still carries the five things AGENTS.md demands: exact paths, acceptance
> criteria, what NOT to touch, the verify command, an output cap.

> **Pre-flight, 2026-10-07.** Every spec line, file, line number, symbol, table and column below was re-pinned against
> `origin/main` 7e75fd4a7 (PR-1 and its follow-ups #910–#925 are merged). 16 premises were false or stale; they are the
> FP table below, and **this file is the authority** where it differs from the spec. The capture lane's field facts
> (2026-10-07, peer code facts, not owner rulings) are folded in as FP13–FP17.

**Goal:** Add the organiser extras on top of the merged capture-QR-v2 server: a per-fixture "Stream the match
automatically" switch, an automatic start at match start from any scoring surface, an automatic stop about 3 minutes after
the result, and the data the organiser panel needs (phone health, device model, takeover, auto-start refusal). The server
half ships alone; the panel half is built to the owner-approved mockup Option A and comes after it.

**Architecture:**

- **Pure domain tables, no I/O.** `domain/auto-stream.ts` decides `autoStartDue` and `autoStopDue` as a table of named
  conjuncts, each falsifiable alone. `domain/phone-health.ts` is the one authority for the health flags (the beat history
  and the panel read the same function).
- **Thin use-cases on the existing seams.** Auto start is evaluated in `postBeat` step 6 and goes through the ONE start
  path (`startBroadcast`, cause `automatic`, `StartActor.source "auto"` — already in the tree). Auto stop rides
  `tickSession` beside the phone-lost ends, so beats, the organiser poll, the 5-minute `stream-tick` job and the daily
  sweep all reach it.
- **One V431 migration**, additive, on tables V430 created.

**Tech Stack:** Next.js 16 app router + React 19 client islands; Zod v4 (OpenAPI via `z.toJSONSchema`); postgres.js; Flyway
deltas; vitest `environment: "node"`; fast-check `^3`; Playwright (`walkthrough` project); `scripts/smoke.ts`.

**Spec:** `docs/superpowers/specs/2026-10-01-capture-qr-v2-design.md` (owner-approved 2026-10-01): §1 (W7, W9, W10, W12,
W16, A4, A11, A12, A15, A16), §5.5 (T20, T31, T32, T42, T43), §6.3 (beats), §6.7–§6.11, §6.12, §7 in full, §8.2, §9, §11.2.
PR-1 plan (house style, FP numbering continues its habit but restarts at FP1 here):
`docs/superpowers/plans/2026-10-01-capture-qr-v2-pr1.md`.

**Worktree.**

- `WT=/Users/ashokhein/github/seazn.club/.claude/worktrees/capture-pr2`, branch `feat/capture-qr-v2-pr2`, from origin/main
  7e75fd4a7. Every command starts `cd $WT &&` **in the same shell call** (AGENTS.md: cwd resets between calls).
- `SCRATCH` is the executing session's scratchpad, never `/tmp`. `OUT=$SCRATCH/cq2-<task>.json`; delete it before each run.
- Deps are installed and `.env.local` is symlinked; never print it. Local DB: the `seazn-local-env` skill — `db:apply`
  **and** `sync:sports`, and confirm `show data_directory` is yours.
- `pnpm`, not `npm`/`npx` (in a worktree `npx` resolves the main checkout's packages).

## Batches

| Batch | Tasks | Boundary gate (orchestrator re-runs it, scoped) |
|---|---|---|
| B1 | T1 + T2 | T1 and T2 scope commands together, plus `config.test.ts` and `domain-purity.test.ts` |
| B2 | T3 | T3 scope command, plus `key-scopes.test.ts`, `openapi-coverage.test.ts`, `stream-contract.test.ts`, then `pnpm openapi:gen && git status --porcelain` empty |
| B3 | T4 + T5 | T4 and T5 scope commands, plus every caller listed in FP11 (`capture-beat`, `capture-start`, `stream-tick`, `relay-sweep`, `stream-sessions`) |
| B4 | T6 | T6 scope command, plus `stream-phone.test.ts`, `capture-beat.test.ts` |
| B5 | T7 | T7's model run **three times**, each seed logged; mutation table recorded |
| B6 | T8 + T9 | The walkthrough file whole, `e2e-ci-wiring.test.ts`, `SMOKE_ONLY=captureV2 pnpm test:smoke`, then **STOP: server half done, ships alone** |
| B7 | T10 + T11 + T12 | **Build to approved Option A.** T10–T12 scope commands, then `mobile.spec.ts` whole |
| B8 | T13 | Walkthrough whole, visual per-screen verdicts against Option A, final Opus review |

**Re-pin `stream-sessions.ts` and `capture-phone.ts` line anchors at each batch start**: T4 and T5 both move lines in them.

## Owner-gated steps (OG) and rulings owed

| # | What | Status |
|---|---|---|
| OG-M | The §7.6 mockup gate. **SATISFIED, owner ruling 2026-10-07: Option A approved** for the whole PR-2 panel — `/Users/ashokhein/github/seazn.club/.superpowers/sdd/2026-10-07-capture-qr-v2-pr2/mockups/option-a-inline-line.html` (PNGs beside it at 320/768/1280; gitignored, never commit it). The health line is one line in the existing strip under the chain and amber states turn that strip amber; the takeover notice and the auto-start refusal are inline strips; the takeover strip has a dismiss X. | **Done.** |
| OG-E | The `e2e.yml` edit in T8 (the walkthrough tunables go in the workflow, R10 of the PR-1 plan) is live CI. | **Owner OK, 2026-10-07.** |
| R-1 | **Spec §8.2 omits a column** (FP1): a settings row created for any reason other than a destination pick reads as "the organiser cleared the destination". The plan adds `target_chosen` to V431. *Recommendation: accept.* The alternative (freeze the resolved default into `target_id` when the switch is first touched) changes which destination streams after the oldest one is archived. | **Owner ruling, 2026-10-07: accepted** — `target_chosen` in V431. |
| R-2 | The "Phone not ready" debounce (FP16): show only after it has held `PHONE_NOT_READY_SHOW_AFTER_SECONDS` = 20 (about 2 beats). | **Owner ruling, 2026-10-07.** One named constant; not an open question. |
| Q-D | **Details disclosure (FP22).** Data used and app version have no home in Option A outside Live. Plan: put them in the existing Details disclosure, which exists only in Live/Ending. Should the app version also show while merely paired? | **Owner ruling, 2026-10-07: Live/Ending only** — no app version while merely paired. |
| R-3 | Do any other stop paths count as "an organiser Stop" for A12 (FP12)? Plan: only `stopSession` on a non-terminal session. | **Controller ruling, 2026-10-07:** only `stopSession` on a non-terminal session. |

Nothing in this plan is an owner ruling unless its row says so (AGENTS.md #17). Never relay R-1, R-3 and Q-D to a peer session as the
owner's word.

## Global Constraints

**Rulings and spec rows the code must honour (verbatim figures):**

- **W7:** "Automatic mode" is an opt-in switch per fixture, off by default. Auto start fires from **any** scoring surface's
  match start, only with a paired phone, **once**, never after an organiser Stop. Auto stop about **3 min** after the result
  is saved, under the same switch. A manual Go live and a manual Stop are always available.
- **A4:** both the console's switch AND the phone's switch (`mode = "automatic"`) must be on, for start and stop.
- **A12:** an organiser Stop turns auto **start** off for that match. **A15:** auto **stop** still applies to a broadcast
  restarted by hand. **A16:** auto start fires once per match, at match start or on a late pairing, whichever is first.
- `autoStartDue = auto_stream AND phone mode = "automatic" AND phone present AND fixture.status = "in_play" AND no open
  session AND auto_started_at IS NULL AND auto_start_blocked_at IS NULL AND no session of this fixture ever received ingest
  AND (auto_start_attempted_at IS NULL OR now − auto_start_attempted_at ≥ AUTO_START_RETRY_SECONDS (60))`.
- `autoStopDue = auto_stream AND the session's phone mode = "automatic" AND fixture.finished_at IS NOT NULL AND
  now ≥ finished_at + AUTO_STOP_AFTER_RESULT_SECONDS (180) AND session.created_at < finished_at`. Effect `stop(auto_stopped)`.
  A reverted result clears `finished_at` (T32) and cancels a pending stop. A broadcast started after the result is never
  auto-stopped.
- A refused auto start stores its code in `auto_start_refusal` (`no_destination | no_credit | not_entitled |
  destination_in_use | unavailable`) and stamps `auto_start_attempted_at`; it is retried no more than once a minute. A refusal
  never stamps `auto_started_at`.
- **W9 thresholds:** `LOW_BATTERY_PERCENT` 20 (percent < 20 and not charging), `HOT_THERMAL_STATUS` 3. Amber priority:
  not responding, stalled, hot, battery low. **W8:** silence only warns. **W10:** history is deleted after 1 day; the final
  beat is never deleted.
- **Beat contract is untouched.** `docs/contracts/*` is not edited and nothing is republished (FP3): `autoAllowed` is already
  a required boolean on every answer shape.
- The phone's words are kebab-case and the server's snake_case; `x?` means omitted, never `null`.

**House rules (AGENTS.md, RULES.md, TEST-STRATEGY.md) that bind every task:**

- Every change ships a test that fails without it. **Mutate each new guard once** (delete the predicate or `return true`);
  the named test must go red; record each mutant and the red test's name in the commit body.
- **Anti-vacuity:** every table, sweep and property test asserts how many items it checked; zero is a failure.
- **Expected values come from declarations** (the config constants, `ACTIVE_STATES`, the domain tables, the migration text),
  never a table typed into the test; at least one case per guard must have a right answer that differs from the wrong
  answer's constant.
- **Test the sequence:** a second call, an empty input (no settings row), after a withdrawal or void, another sport.
- **Scoped local runs only.** Never the full vitest, e2e or gate; never `seazn-env gate` (owner, 2026-09-28):

  ```bash
  cd $WT/apps/web && rm -f $OUT && pnpm exec vitest run <exact paths> --reporter=json --outputFile=$OUT; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' $OUT
  ```

  Green means `f == 0`, `p == t`, `t > 0`, and every path you passed appears in `.files` under `capture-pr2`. Positionals are
  literal filters; a missing path is silently ignored; a stale `--outputFile` reads as a pass.
- DB-backed tests need a fresh migrated database (V431 applied) — a DB that lags `main` reds unrelated suites.
- `cd $WT/apps/web && rtk proxy pnpm typecheck` exits 0; `rtk proxy pnpm lint` reads `✖ 0 problems` or no problems line.
- Playwright runs **whole files**, never `-g`: `cd $WT/apps/web && PLAYWRIGHT_BASE=http://localhost:3000 pnpm exec playwright
  test <file> --project=<p> --reporter=line; echo EXIT=$?`; `localhost`, never `127.0.0.1`; the server is a prod build of this worktree.
- **Copy:** any new user-facing string goes in all four `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`, then `pnpm
  i18n:gen-keys` and `pnpm i18n:check` (UI wave only).
- **OpenAPI:** `pnpm openapi:gen && git status --porcelain` empty before each commit that touches a schema.
- **UI** (panel wave): 1280, 768, 320; no horizontal page scroll; per-screen verdicts; entitlement-gated states verified
  granted AND denied.
- **Git:** never `git stash`. Commit with `git commit -F <file>` (no heredocs in a worktree), ending with the trailer
  `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01TjQbpEqgvMnChEfQMYTcuV`.
- **All four test types** are owed across the branch (unit, E2E, smoke, regression); each task names which.

## Review Focus

Inputs the spec implies but no task's tests would otherwise exercise, most likely first. Each has its test in the named task.

1. **Turning the switch on for a fixture with no destination row.** Expect: the fixture still resolves to the org's oldest
   live destination, exactly as before the toggle. Owner: T1 (`target_chosen`), T3 (the toggle test).
2. **The phone flips Settings to operator mode right after the result** (or the final beat carries a different `mode`).
   Expect: auto stop reads the session phone's stored mode, which lags at most one poll interval; no crash, and the stop
   either fires or does not on the stored mode alone. Owner: T5.
3. **Two beats in one interval, or a beat racing the organiser's Go live.** Expect: at most one automatic session, ever.
   Owner: T4 (the compare-and-set claim, 2 concurrent beats).
4. **Clock skew.** `finished_at` and `fixture_stream_sessions.created_at` are database clocks; `now` is the app's. Expect:
   the pre/post-result comparison uses only the two DB stamps; the 180 s delay uses `deps.now()`. Owner: T5.
5. **Battery / thermal / bitrate null** (the app sends them only from Armed / OnAir). Expect: no auto-start dependence on
   them; the health line omits a null part; never "0 Mbps" or "null". Owner: T2 (`phoneHealthOf`), T6.

## False premises found by the pre-flight

| # | The spec / brief said | The tree says | Lands in |
|---|---|---|---|
| FP1 | V431 (§8.2) is the whole schema for the switch. | `fixtureStreamTarget` reads `fixture_stream_settings` as `has_row = st.fixture_id is not null` and `resolveStreamTarget(row:true, targetId:null)` answers **none** (`lib/stream-destinations.ts:66-76`, `stream-codes.ts:279-282`). Any row inserted by the switch, or by the A12 Stop stamp, with `target_id` null would silently turn "no choice yet → oldest destination" into "cleared → no destination": auto start would refuse `no_destination` and the phone's start and descriptor would lose their default. §8.2 has no column to tell the two apart. | T1 (R-1), T3, T4 |
| FP2 | "`stream-contract.test.ts` pin of stream operations moves from 7 to 11" (§9, a PR-2 line). | It already reads ELEVEN (PR-1 did it, `stream-contract.test.ts:353,383`). PR-2 adds **no** organiser operation: `PUT …/stream-settings` exists (`app/api/v1/fixtures/[id]/stream-settings/route.ts`); only its body and answer schemas change. | T3 |
| FP3 | The contract "carries `autoAllowed`" and PR-2 wires it (§7.1). | True, and nothing in `docs/contracts/` changes: `autoAllowed` is a required boolean on every shape and `captureCommon` hard-codes `false` (`capture-phone.ts:183`, comment "PR-2 wires the fixture's switch"). The beat contract does carry `mode`, `notReady`, `battery{percent,charging,drainPctPerHour}`, `bitrateKbps`, `thermal`, `device{model}`, `startFailed` at the top level (checked in `capture-beat.v1.json`): `mode` is a required non-null enum; `notReady`, `startFailed`, `thermal`, `bitrateKbps`, `battery` are `anyOf [x, null]`. | T3 |
| FP4 | The panel's `PUT {targetId}` is the only caller. | `routes.test.ts:202` pins `{ targetId: null, autoStream: true }` and `{}` as **rejected** bodies; `PutStreamSettings` is `{targetId: uuid\|null}` strict, required. Both flip, and the panel's `{targetId}` body must keep working. `writeStreamSettings` also always writes `target_id` (it would clear the pick on an `{autoStream}`-only PUT). | T3 |
| FP5 | `domain/auto-stream.ts` is a free file name. | `domain-purity.test.ts` pins **exactly twelve** domain files by name; adding `auto-stream.ts` and `phone-health.ts` reds it until the list moves. | T2 |
| FP6 | `AUTO_START_RETRY_SECONDS` / `AUTO_STOP_AFTER_RESULT_SECONDS` exist as constants. | Neither is in `relay/config.ts`; they appear only in the spec text. `config.test.ts` pins `TUNABLE_NAMES` to a hand-listed `SPEC_DEFAULTS` and reads each constant back out of the spec. The e2e needs the 180 s to be shortened, so both are made tunable (§6.15 / AGENTS.md #20) — a plan decision, not a ruling. | T1, T8 |
| FP7 | Auto stop is "evaluated on beats, on the organiser poll and in the sweep". | The three are one function: `tickSession(sessionId, deps, cause)` (`stream-sessions.ts:1600`), called by the organiser poll (`currentSession`), `postBeat` (for the session's phone naming its sid only), `tickOpenSessions` (the `stream-tick` job) and `relay-sweep.ts:233`. One insertion point after `endIfPhoneLost` covers all four. | T5 |
| FP8 | `appendEvent` writes `fixtures.status` and `finished_at` for every scoring surface. | `status` yes: `append-event.ts:408-414` (`update fixtures set status = …`) on the console, the device-link page (`app/score/[token]/page.tsx:334` passes `deviceLinkId`), `event-import.ts` and `history.ts`. **`finished_at` is not written by `appendEvent`**; it is stamped by V430's `fixtures_track_finished` trigger (BEFORE INSERT OR UPDATE OF status). So an UPDATE that names `finished_at` alone never fires it — a test must set `finished_at` itself (after the status write), and the "revert" test must change `status`. | T4, T5, T7 |
| FP9 | A12 is stamped "by Stop". | The organiser Stop is `stopSession` (`stream-sessions.ts:1950`) with three exits (repeated-stop branch, `relay_disabled`, the normal `apply`). There is no settings row to stamp when the switch was never touched, and inserting one hits FP1. | T4 |
| FP10 | Auto start is "evaluated on every beat from the current phone". | `postBeat` has no "current phone" variable; the decided object carries `mine` (non-null for accept/takeover/none). An operator's `ended` beat (T21) ALSO has `mine` non-null while its pairing is ended in the same transaction; auto start must skip it, and a beat that stops a session. The pairing's code issuer, not `resolved.issuedBy`, must attribute the start (C-2: the holder may sit on a reissued code and `startBroadcast` refuses any actor other than the pairing's code `issued_by`). | T4 |
| FP11 | Only the beat and tick files are affected. | `stopSession`, `tickSession`, `captureCommon` and `fixtureStreamTarget` have callers across `capture-beat`, `capture-get`, `capture-start`, `stream-tick`, `relay-sweep`, `stream-sessions`, `stream-phone` tests; each batch gate lists them. | batches |
| FP12 | (unstated) "the organiser's Stop" is one thing. | Also: the panel's Cancel posts the same stop route; `expireTargetHolders`, the sweep and the tick end sessions without being an organiser's intent and must NOT stamp. | T4, R-3 |
| FP13 | (Capture lane, 2026-10-07) The spec reads `mode` from "the phone's latest beat". | `mode` rides every beat, the final one included; a Settings flip reaches the server on the next beat, so it lags up to one poll interval (5–300 s, 10 s while held). Auto start reads the arriving beat (no lag); auto stop reads the stored pairing mode (lag ≤ one interval) — accepted and tested, not "fixed". | T4, T5 |
| FP14 | (Capture lane) The health line shows battery, thermal and bitrate. | `battery` and `thermal` are NULL through the whole Paired phase and appear from Armed, up to 10 s late; `bitrateKbps` only OnAir (null during a reconnect and on the first reading). Neither auto start nor any pre-live panel state may depend on them; the line omits a null part. | T2, T6, T11 |
| FP15 | (Capture lane) §7.5 "Paired · {model}" can read `device.model` from the beat. | `device.model` rides beats only while a claim is pending, then null, and null on the final beat. **PR-1 already persists it**: `capture-phone.ts` writes `device_model = coalesce(<claim beat's model>, device_model)` (:520-ish), and `stream-phone.ts` serves `phone.model` and `lastTakeover.model` from the pairing rows. No V431 column is needed for the model. Owed: a regression test that the model survives later beats carrying null and the final `ended` beat. | T6 |
| FP16 | (Capture lane) `notReady` is a clean "Phone not ready" signal. | It is null only when camera, sound, network and held all pass, is not phase-gated, reads "camera" before the first reading, and flapped 27 sound / 11 held / 3 camera times in 10 min on staging. PR-1 stores only the latest value (`not_ready` overwritten each beat), so a debounce cannot be done from the row. V431 adds `fixture_stream_pairings.not_ready_since` and the read model serves `notReadyForMs` and `notReadyShown` (held ≥ `PHONE_NOT_READY_SHOW_AFTER_SECONDS` = 20, **owner ruling R-2, 2026-10-07**). `notReady` never gates auto start beyond the spec's predicate. | T1, T6, T11 |
| FP17 | (Capture lane) `startFailed` needs PR-2 storage. | PR-1 already records `start_failed` on the pairing and serves `phone.startFailed`; capture clears it on the next Go live or arm. Nothing owed server-side. | T6 |
| FP18 | The brief's verify command is `npx vitest run`. | In a worktree `npx` resolves the main checkout's packages (PR-1 FP16). This plan uses `pnpm exec vitest run`. | all |
| FP19 | The panel reads `auto` and `phoneStatus` as new props. | `StreamPhone.auto` is `z.null()` today (`schemas.ts`), and `SignalChain` already has the reserved `phoneStatus?: string` prop (`stream-signal-chain.tsx:155-166`, `void phoneStatus`); `stream.phone.ended.reason.auto_stopped` copy and the `auto_stopped` wire reason already shipped in PR-1 (`lib/stream-session-view.ts:127`, `end-reason.ts:25`, `session.ts` `StopEndReason`). | T6, T11 |
| FP20 | The spec's §11.2 says "the PR-1 model gains `toggleAuto`, `setPhoneMode`, …". | `capture-model.test.ts` is 84 KB with twelve money-scoped invariants; extending it collides with its own anti-vacuity counters. The plan adds a sibling file on the same rig (`_capture-rig.ts`). A deviation, not a ruling. | T7 |
| FP21 | The brief says "heartbeat silence" fields are new. | `last_beat`, `last_beat_at`, `answered_poll_seconds`, `phone_beat`, `phone_beat_at` and `isNotResponding` exist (V430, `domain/pairing.ts`); the history `flags` already carry `battery_low | hot | stalled | not_ready | not_responding` via `flagsOf` (`capture-phone.ts:360`). T2 moves that derivation to `domain/phone-health.ts` so the history and the panel cannot disagree. | T2 |
| FP22 | §7.4: data used and the app version go "inside the existing Details disclosure". | A `<details data-testid="stream-details">` exists (`fixture-stream-panel.tsx:2149`) but renders **only in Live/Ending** (inside the `state === "live" \|\| "ending"` block) and holds the *runner's* health chips (`healthChips(p.view, …)`), not the phone's. Option A has no other home. So the data lands there in Live/Ending; nothing shows pre-live. | T11, Q-D |

**Correct premises, kept:** V431 is free on every local and remote branch (`ls db/migration/deltas | sort -V | tail -1` is V430);
`fixture_stream_settings` has the V430 columns `fixture_id` (PK), `org_id`, `target_id`, `updated_by`, `updated_at`;
`stream-tick` exists (`app/api/cron/stream-tick/route.ts`, `tickOpenSessions`); `capture-phone.ts` owns beats at
`postBeat:429`; `stream-sessions.ts` owns `startBroadcast:1251`, `stopSession:1950`, `tickSession:1600`, `endIfPhoneLost:1793`;
`StartActor.source` already admits `"auto"` and `StartCause` `"automatic"`; the `V431__auto_stream.sql` name matches
`_stream-migration.ts`'s fold filter (`/stream|capture/`).

## File Structure

**Create:**

- `db/migration/deltas/V431__auto_stream.sql`
- `apps/web/src/server/relay/domain/auto-stream.ts` (pure)
- `apps/web/src/server/relay/domain/phone-health.ts` (pure)
- `apps/web/src/server/usecases/stream-auto.ts` (auto start use-case + refusal mapper)
- Tests: `domain/__tests__/auto-stream.test.ts`, `domain/__tests__/phone-health.test.ts`,
  `usecases/__tests__/stream-auto.test.ts`, `usecases/__tests__/stream-auto-stop.test.ts`,
  `usecases/__tests__/stream-auto-model.test.ts`, `relay/__tests__/v431-migration.test.ts`,
  `e2e/walkthrough/capture-auto.spec.ts`

**Modify:**

- `server/relay/config.ts` (two constants, two tunables, `PHONE_NOT_READY_SHOW_AFTER_SECONDS`)
- `server/relay/domain/__tests__/domain-purity.test.ts` (twelve → fourteen)
- `server/relay/__tests__/config.test.ts`
- `server/usecases/stream-codes.ts` (settings writers, `fixtureStreamTarget`)
- `server/usecases/capture-phone.ts` (`autoAllowed`, step 6, `flagsOf`, `not_ready_since`)
- `server/usecases/stream-sessions.ts` (`endIfAutoStopDue`, `stopSession` stamp)
- `server/usecases/stream-phone.ts` (`auto`, `health`, `notReady*`)
- `server/api-v1/schemas.ts`, `server/api-v1/openapi.ts`, `openapi/v1.json`, `openapi/v1.public.json`
- `app/api/v1/fixtures/[id]/stream-code/__tests__/routes.test.ts` (flip the rejected bodies)
- `.github/workflows/e2e.yml` and `e2e-ci-wiring.test.ts` (OG-E)
- `scripts/smoke.ts` (`captureV2Suite` gains the auto case)
- Gated UI: `components/v2/fixture-stream-panel.tsx`, `components/v2/stream-signal-chain.tsx`, `lib/stream-chain.ts`,
  `lib/stream-session-view.ts`, the four `dictionaries/*/ui.json`.

---

## Wave S — server (buildable now; ships independently)

### Task 1: V431, the tunables, and the destination-row fix

**Files:**

- Create: `db/migration/deltas/V431__auto_stream.sql`, `apps/web/src/server/relay/__tests__/v431-migration.test.ts`
- Modify: `apps/web/src/server/relay/config.ts`, `apps/web/src/server/relay/__tests__/config.test.ts`,
  `apps/web/src/server/usecases/stream-codes.ts` (`writeStreamSettings`, `fixtureStreamTarget`)
- Test: the two new/changed relay tests plus `apps/web/src/server/usecases/__tests__/stream-codes.test.ts`
  (destination-resolution cases)

**Interfaces:**

- Produces (SQL): the six spec columns on `fixture_stream_settings`, plus `target_chosen boolean not null default false`
  (R-1) and `fixture_stream_pairings.not_ready_since timestamptz null` (FP16).
- Produces (config): `AUTO_STOP_AFTER_RESULT_SECONDS = 180`, `AUTO_START_RETRY_SECONDS = 60`,
  `PHONE_NOT_READY_SHOW_AFTER_SECONDS = 20` (R-2, owner-ruled); `TUNABLE_NAMES` gains the first two.
- Produces (TS): `writeStreamSettings` now also sets `target_chosen = true`; `fixtureStreamTarget`'s `has_row` becomes
  `coalesce(st.target_chosen, false)`.

- [ ] **Step 1: Write the failing tests**

`v431-migration.test.ts` (reads the file through `_stream-migration.ts`; no DB):

```ts
import { describe, expect, it } from "vitest";
import { STREAM_DELTA_FILES, deltaText, lastCheckList, stripSqlComments } from "./_stream-migration";
import { AUTO_START_REFUSALS } from "../domain/auto-stream";

const V431 = stripSqlComments(deltaText(431));
describe("V431 (spec §8.2, plan R-1, FP16)", () => {
  it("the fold reads V431 by name, after V430 (anti-vacuity)", () => {
    expect(STREAM_DELTA_FILES).toContain("V431__auto_stream.sql");
    expect(STREAM_DELTA_FILES.indexOf("V430__capture_stream_codes.sql")).toBeLessThan(STREAM_DELTA_FILES.indexOf("V431__auto_stream.sql"));
    expect(V431.length).toBeGreaterThan(0);
  });
  it("adds exactly the spec's six settings columns, plus target_chosen and not_ready_since", () => {
    const cols = [...V431.matchAll(/add column (\w+)/g)].map((m) => m[1]).sort();
    expect(cols).toEqual(["auto_start_attempted_at", "auto_start_blocked_at", "auto_start_refusal", "auto_start_session_id",
      "auto_started_at", "auto_stream", "not_ready_since", "target_chosen"].sort());
  });
  it("the refusal CHECK list equals the domain's AUTO_START_REFUSALS (declared, not typed here)", () => {
    const list = lastCheckList("fixture_stream_settings", "auto_start_refusal");
    expect(list.length).toBeGreaterThan(0);
    expect([...list].sort()).toEqual([...AUTO_START_REFUSALS].sort());
  });
  it("auto_stream defaults false; the backfill marks every existing row target_chosen", () => {
    expect(V431).toMatch(/auto_stream\s+boolean not null default false/);
    expect(V431).toMatch(/update fixture_stream_settings set target_chosen = true/);
  });
});
```

`config.test.ts`: extend `SPEC_DEFAULTS` with `AUTO_STOP_AFTER_RESULT_SECONDS: 180, AUTO_START_RETRY_SECONDS: 60` and the
`DEFAULTS` object; add both names to the spec read-back `NAMES` list (the spec writes `AUTO_STOP_AFTER_RESULT_SECONDS (180)`
and `AUTO_START_RETRY_SECONDS (60)`); the "every tunable under every environment" case already scales by
`TUNABLE_NAMES.length * 9` (anti-vacuity moves from 36 to 54).

`stream-codes.test.ts` (DB-backed) — the FP1 witnesses:

```ts
it("a settings row that never chose a destination still resolves the org's oldest live destination (R-1)", async () => {
  const r = await captureRig();                     // one destination: r.target
  await sql`insert into fixture_stream_settings (fixture_id, org_id) values (${r.fixtureId}, ${r.auth.orgId})`;   // target_chosen false
  const pick = await fixtureStreamTarget(sql, { orgId: r.auth.orgId, fixtureId: r.fixtureId });
  expect(pick).toMatchObject({ id: r.target.id, source: "default" });
});
it("a chosen null (the organiser cleared it) still resolves none", async () => {
  const r = await captureRig();
  await sql.begin((tx) => writeStreamSettings(tx, { orgId: r.auth.orgId, fixtureId: r.fixtureId, targetId: null, updatedBy: null }));
  expect(await fixtureStreamTarget(sql, { orgId: r.auth.orgId, fixtureId: r.fixtureId })).toBeNull();
});
```

- [ ] **Step 2: Run to verify they fail** (`v431-migration.test.ts` fails on the missing file; the config case on the missing
  constants; the first resolver case returns `null`). Expected: FAIL.

- [ ] **Step 3: Implement.** `V431__auto_stream.sql`:

```sql
-- V431 — Capture QR v2, PR-2 (spec §8.2, plan 2026-10-07 R-1 and FP16).
alter table fixture_stream_settings
  add column auto_stream             boolean not null default false,
  add column auto_started_at         timestamptz null,
  add column auto_start_session_id   uuid null references fixture_stream_sessions(id) on delete set null,
  add column auto_start_blocked_at   timestamptz null,
  add column auto_start_attempted_at timestamptz null,
  add column auto_start_refusal      text null
    check (auto_start_refusal in ('no_destination','no_credit','not_entitled','destination_in_use','unavailable')),
  -- R-1: V430 read "a row exists" as "the organiser chose" (a null target_id = cleared). The switch and the A12 stamp create rows
  -- that chose nothing, so the choice gets its own flag. Every existing row was written by a destination write.
  add column target_chosen           boolean not null default false;
update fixture_stream_settings set target_chosen = true;
create index on fixture_stream_settings (auto_start_session_id);   -- V430 m-2: the FK has an index to walk on a session delete
-- FP16: when the phone has been not-ready continuously, for the panel's debounce.
alter table fixture_stream_pairings add column not_ready_since timestamptz null;
```

`config.ts`: add the three constants with their spec citations and put `"AUTO_STOP_AFTER_RESULT_SECONDS",
"AUTO_START_RETRY_SECONDS"` in `TUNABLE_NAMES`. `stream-codes.ts`: in `writeStreamSettings` the insert lists
`target_chosen` as `true` and `on conflict … set target_chosen = true`; in `fixtureStreamTarget` replace
`st.fixture_id is not null as has_row` with `coalesce(st.target_chosen, false) as has_row`.

- [ ] **Step 4: Run to verify they pass.** Apply V431 to the local DB first (`pnpm db:apply` with the worktree's env).
  Command: the template above on `relay/__tests__/v431-migration.test.ts`, `relay/__tests__/config.test.ts`,
  `usecases/__tests__/stream-codes.test.ts`, `usecases/__tests__/stream-target-agreement.test.ts`. Expected PASS; `t > 0`.
- [ ] **Step 5: Mutation (once).** Revert `has_row` to `st.fixture_id is not null` → the first resolver case must go red.
  Delete the backfill line → a test that pre-seeds a V430-shaped row (insert with `target_id` set, then run the V431 `update`
  text) must go red (add it: execute `V431`'s update statement against a seeded row and assert `fixtureStreamTarget` still
  returns `source: "saved"`). Record both.
- [ ] **Step 6: Commit** `feat(capture): V431 auto-stream columns, tunables, and a destination row that records its choice`.

**Owes:** unit + DB. **Regression:** the existing destination-resolution suite stays green.

---

### Task 2: The pure domain — `auto-stream.ts` and `phone-health.ts`

**Files:**

- Create: `apps/web/src/server/relay/domain/auto-stream.ts`, `apps/web/src/server/relay/domain/phone-health.ts`
- Modify: `apps/web/src/server/relay/domain/__tests__/domain-purity.test.ts` (twelve → fourteen units),
  `apps/web/src/server/usecases/capture-phone.ts` (`flagsOf` delegates)
- Test: `domain/__tests__/auto-stream.test.ts`, `domain/__tests__/phone-health.test.ts`

**Interfaces:**

- Produces (`auto-stream.ts`):

```ts
export const AUTO_START_REFUSALS = ["no_destination", "no_credit", "not_entitled", "destination_in_use", "unavailable"] as const;
export type AutoStartRefusal = (typeof AUTO_START_REFUSALS)[number];
export type PhoneMode = "automatic" | "operator";
export type AutoStartFacts = {
  autoStream: boolean; phoneMode: PhoneMode | null; phonePresent: boolean; fixtureStatus: string; openSession: boolean;
  autoStartedAt: Date | null; autoStartBlockedAt: Date | null; anySessionHadIngest: boolean; autoStartAttemptedAt: Date | null;
};
export const AUTO_START_CONJUNCTS: readonly { name: string; holds: (f: AutoStartFacts, now: Date, retrySeconds: number) => boolean }[];
export function autoStartVerdict(f: AutoStartFacts, now: Date, retrySeconds: number): { due: boolean; failed: string[] };
export type AutoStopFacts = { autoStream: boolean; phoneMode: PhoneMode | null; finishedAt: Date | null; sessionCreatedAt: Date };
export const AUTO_STOP_CONJUNCTS: readonly { name: string; holds: (f: AutoStopFacts, now: Date, delaySeconds: number) => boolean }[];
export function autoStopVerdict(f: AutoStopFacts, now: Date, delaySeconds: number): { due: boolean; failed: string[] };
```

- Produces (`phone-health.ts`):

```ts
export const HEALTH_REASONS = ["not_responding", "stalled", "hot", "battery_low"] as const;   // §7.4 priority order
export type HealthReason = (typeof HEALTH_REASONS)[number];
export type HealthInput = {
  notResponding: boolean; delivery: "ok" | "stalled" | "unknown" | null; thermal: number | null;
  battery: { percent: number; charging: boolean } | null;
};
export function phoneHealthOf(i: HealthInput): HealthReason | null;      // first reason that applies, else null
export function phoneFlagsOf(i: HealthInput & { notReady: boolean }): string[];   // history flags, in flagsOf's order
```

Both files import only `../config`, siblings and types (the purity guard); thresholds are `LOW_BATTERY_PERCENT` and
`HOT_THERMAL_STATUS` from config (not tunable). A null `battery`, `thermal` or `delivery` contributes nothing (FP14).

- [ ] **Step 1: Write the failing tests.**

`auto-stream.test.ts` — the conjunct table, each falsified one at a time:

```ts
const NOW = new Date("2026-10-07T12:00:00Z");
const base: AutoStartFacts = { autoStream: true, phoneMode: "automatic", phonePresent: true, fixtureStatus: "in_play", openSession: false,
  autoStartedAt: null, autoStartBlockedAt: null, anySessionHadIngest: false, autoStartAttemptedAt: null };
// each row falsifies exactly ONE conjunct; `conjunct` is the name that must be the only failure
const FALSIFY: { conjunct: string; patch: Partial<AutoStartFacts> }[] = [
  { conjunct: "switch_on", patch: { autoStream: false } },
  { conjunct: "phone_automatic", patch: { phoneMode: "operator" } },
  { conjunct: "phone_automatic", patch: { phoneMode: null } },
  { conjunct: "phone_present", patch: { phonePresent: false } },
  { conjunct: "in_play", patch: { fixtureStatus: "scheduled" } },
  { conjunct: "in_play", patch: { fixtureStatus: "decided" } },
  { conjunct: "no_open_session", patch: { openSession: true } },
  { conjunct: "not_yet_started", patch: { autoStartedAt: new Date(NOW.getTime() - 1) } },
  { conjunct: "not_blocked", patch: { autoStartBlockedAt: new Date(NOW.getTime() - 1) } },
  { conjunct: "no_broadcast_ran", patch: { anySessionHadIngest: true } },
  { conjunct: "retry_spacing", patch: { autoStartAttemptedAt: new Date(NOW.getTime() - (AUTO_START_RETRY_SECONDS * 1000 - 1000)) } },   // 59 s
];
it("the base facts are due (the positive pair)", () => expect(autoStartVerdict(base, NOW, AUTO_START_RETRY_SECONDS)).toEqual({ due: true, failed: [] }));
it("every conjunct, falsified alone, is the only failure — and the table has no conjunct nobody falsifies", () => {
  let checked = 0;
  for (const row of FALSIFY) {
    const v = autoStartVerdict({ ...base, ...row.patch }, NOW, AUTO_START_RETRY_SECONDS);
    expect(v, row.conjunct + JSON.stringify(row.patch)).toEqual({ due: false, failed: [row.conjunct] });
    checked++;
  }
  expect(checked).toBe(FALSIFY.length);
  expect(new Set(FALSIFY.map((r) => r.conjunct))).toEqual(new Set(AUTO_START_CONJUNCTS.map((c) => c.name)));   // none unfalsified
});
it("empty case first: a fixture with no settings row is never due (autoStream false, mode null)", ...);
it("retry spacing at 59 s is not due and at exactly 60 s is due (boundary, derived from AUTO_START_RETRY_SECONDS)", ...);
```

Same shape for `autoStopVerdict` (`switch_on`, `phone_automatic`, `fixture_finished` — `finishedAt: null`, `delay_elapsed` —
179 s vs 180 s, `session_predates_result` — `sessionCreatedAt` equal to and after `finishedAt`; the **ordering differential**:
the same facts with `sessionCreatedAt` one ms before vs one ms after `finishedAt` flip the verdict while every other
conjunct holds).

`phone-health.test.ts`: priority table (each reason alone; every pair in priority order — `not_responding` beats `stalled`
beats `hot` beats `battery_low`: 6 pairs); battery boundaries derived from `LOW_BATTERY_PERCENT` (19 low, 20 not low, charging
at 5 not low); thermal at `HOT_THERMAL_STATUS − 1` vs `HOT_THERMAL_STATUS`; **null battery/thermal/delivery → `null`**
(FP14); `phoneFlagsOf` equals the old `flagsOf` output on the same inputs for the 2^5 combinations (assert 32 checked).
Domain-purity: the unit list gains `auto-stream.ts` and `phone-health.ts` ("has the fourteen units").

- [ ] **Step 2: Run — fails** (modules missing; purity test lists twelve).
- [ ] **Step 3: Implement.** `auto-stream.ts` as a strategy table: each conjunct is `{ name, holds }`; the verdict is
  `const failed = CONJUNCTS.filter(c => !c.holds(f, now, secs)).map(c => c.name); return { due: failed.length === 0, failed }`.
  `retry_spacing.holds = f.autoStartAttemptedAt === null || now.getTime() - f.autoStartAttemptedAt.getTime() >= secs * 1000`.
  `delay_elapsed.holds = f.finishedAt !== null && now.getTime() >= f.finishedAt.getTime() + secs * 1000`. Export
  `AUTO_START_REFUSALS`. `phone-health.ts` as in Interfaces. In `capture-phone.ts` replace the body of `flagsOf` with a call
  to `phoneFlagsOf({ notResponding, delivery: b.delivery, thermal: b.thermal, battery: b.battery === null ? null : { percent: b.battery.percent, charging: b.battery.charging }, notReady: b.notReady !== null })`
  and drop the now-unused `LOW_BATTERY_PERCENT` / `HOT_THERMAL_STATUS` imports there.
- [ ] **Step 4: Run** `auto-stream.test.ts`, `phone-health.test.ts`, `domain-purity.test.ts`, `capture-beat.test.ts` (the
  history flags still match), `stream-phone.test.ts`. PASS.
- [ ] **Step 5: Mutation (once each):** delete the `no_broadcast_ran` conjunct → its FALSIFY row red; flip `>=` to `>` in
  `retry_spacing` → the 60 s boundary red; swap `<` for `<=` in `session_predates_result` → the ordering differential red;
  swap the first two `HEALTH_REASONS` → the priority pairs red. Record each.
- [ ] **Step 6: Commit** `feat(capture): the pure auto-stream predicates and the one phone-health derivation`.

**Owes:** unit. **Regression:** history flags unchanged (the 32-combination equality).

---

### Task 3: The switch — `PUT …/stream-settings {autoStream}` and `autoAllowed`

**Files:**

- Modify: `apps/web/src/server/api-v1/schemas.ts` (`PutStreamSettings`, `StreamSettings`),
  `apps/web/src/server/api-v1/openapi.ts` (the route's summary), `apps/web/src/server/usecases/stream-codes.ts`
  (`saveStreamSettings`, new `writeAutoStream`), `apps/web/src/server/usecases/capture-phone.ts` (`captureCommon`),
  `openapi/v1.json`, `openapi/v1.public.json` (regenerated)
- Test: `apps/web/src/app/api/v1/fixtures/[id]/stream-code/__tests__/routes.test.ts` (flip the :202 case),
  `usecases/__tests__/stream-codes.test.ts`, `usecases/__tests__/capture-get.test.ts`, `usecases/__tests__/capture-beat.test.ts`

**Interfaces:**

- Consumes: T1's columns; `requireSessionEditor`, `fixtureOf` (`stream-codes.ts`).
- Produces:

```ts
export const PutStreamSettings = z.object({ targetId: z.string().uuid().nullable().optional(), autoStream: z.boolean().optional() })
  .strict().refine((b) => b.targetId !== undefined || b.autoStream !== undefined, { message: "targetId or autoStream is required" });
export const StreamSettings = z.object({ targetId: z.string().uuid().nullable(), autoStream: z.boolean() }).strict();
export async function saveStreamSettings(auth: AuthCtx, fixtureId: string, body: PutStreamSettings): Promise<StreamSettings>;
export async function writeAutoStream(tx: Tx, a: { orgId: string; fixtureId: string; autoStream: boolean; updatedBy: string | null }): Promise<void>;
export async function markAutoStartBlocked(orgId: string, fixtureId: string, at: Date, updatedBy: string | null): Promise<void>;   // T4 uses it
```

`targetId` in the answer is the **saved choice** (`target_chosen ? target_id : null`).

- [ ] **Step 1: Failing tests.**
  - `routes.test.ts`: replace the rejected-bodies list `[{}, { targetId: null, autoStream: true }, { targetId: "not-a-uuid" }]`
    with `[{}, { autoStream: "yes" }, { targetId: "not-a-uuid" }, { autoStream: true, extra: 1 }]`; add accepted bodies
    `{ autoStream: true }`, `{ targetId: null, autoStream: true }`, `{ targetId: <uuid> }` (the panel's PR-1 body — regression).
  - `stream-codes.test.ts`: (a) `{autoStream:true}` on a fixture with no row creates the row, `auto_stream` true,
    `target_chosen` false, and `fixtureStreamTarget` still returns the oldest destination (Review Focus 1); (b) a later
    `{targetId}` PUT leaves `auto_stream` true; (c) `{autoStream:true}` after a pick leaves `target_id` untouched; (d)
    `{autoStream:false}` clears `auto_start_refusal` but not `auto_started_at`/`auto_start_blocked_at` (R-3 note: the blocked
    stamp survives a toggle); (e) another org's fixture → 404, same as a missing one; (f) a viewer-role caller → 403
    (`requireSessionEditor`); (g) the second identical PUT is idempotent (row count 1).
  - `capture-get.test.ts` / `capture-beat.test.ts`: with the switch on, `autoAllowed` is `true` on the waiting descriptor, a
    session descriptor, and each beat-answer state (`waiting`, `go-live`, `live`, `over`); off or no row → `false`. Count the
    states checked (≥ 4).
- [ ] **Step 2: Run — fails.**
- [ ] **Step 3: Implement.** `saveStreamSettings` runs one `sql.begin`: if `body.targetId !== undefined` →
  `writeStreamSettings`; if `body.autoStream !== undefined` → `writeAutoStream` (an upsert that sets only `auto_stream`,
  `updated_by`, `updated_at`, and `auto_start_refusal = null` when turning off — never `target_id`/`target_chosen`); then
  read `{target_id, target_chosen, auto_stream}` and answer. `markAutoStartBlocked` is the same kind of upsert:
  `insert … (fixture_id, org_id, auto_start_blocked_at, updated_by) … on conflict (fixture_id) do update set
  auto_start_blocked_at = coalesce(fixture_stream_settings.auto_start_blocked_at, excluded.auto_start_blocked_at)`. In
  `captureCommon` add `left join fixture_stream_settings st on st.fixture_id = f.id` to the single fixture-facts statement,
  `coalesce(st.auto_stream, false) as auto_stream`, and return `autoAllowed: ctx.auto_stream` (replace the `false` and its comment).
  Update the `openapi.ts` summary; run `pnpm openapi:gen`.
- [ ] **Step 4: Run** the four test files above + `key-scopes.test.ts`, `openapi-coverage.test.ts`, `stream-contract.test.ts`
  (still ELEVEN operations — FP2) + `capture-contract.test.ts` (no contract change — FP3). PASS. `pnpm openapi:gen && git status --porcelain`
  shows only the intended files.
- [ ] **Step 5: Mutation:** make `writeAutoStream` set `target_id = null` → (c) red; make `captureCommon` return `false` → the
  `autoAllowed` states red; drop the refine → the `{}` body red.
- [ ] **Step 6: Commit** `feat(capture): the automatic-streaming switch and autoAllowed on every phone answer`.

**Owes:** unit + DB + API. **Regression:** the panel's `{targetId}` PUT.

---

### Task 4: Auto start — `stream-auto.ts`, `postBeat` step 6, and the Stop stamp (A12)

**Files:**

- Create: `apps/web/src/server/usecases/stream-auto.ts`
- Modify: `apps/web/src/server/usecases/capture-phone.ts` (step 6 call, `not_ready_since` write is T6),
  `apps/web/src/server/usecases/stream-sessions.ts` (`stopSession`)
- Test: `apps/web/src/server/usecases/__tests__/stream-auto.test.ts`

**Interfaces:**

- Consumes: T2's `autoStartVerdict`, `AutoStartRefusal`; T3's `markAutoStartBlocked`; `startBroadcast`, `fixtureStreamTarget`,
  `isPresent`, `tunable`.
- Produces:

```ts
export type AutoStartResult =
  | { fired: false; why: "not_due" | "claim_lost" | "already_running" }
  | { fired: true; sessionId: string }
  | { fired: false; why: "refused"; refusal: AutoStartRefusal };
export async function maybeAutoStart(
  a: { orgId: string; fixtureId: string; pairingId: string; phoneMode: PhoneMode },
  deps: SessionDeps, now: Date,
): Promise<AutoStartResult>;
export function autoStartRefusalOf(err: unknown): AutoStartRefusal | "already_running" | null;   // null = a bug: rethrow
```

`autoStartRefusalOf` maps: `PaymentRequiredError` and `overlay_required` → `not_entitled`; `no_credits` → `no_credit`;
`target_in_use` → `destination_in_use` (the phone's start maps this to `no_destination`; the auto column keeps the
spec's own word); `DESTINATION_NOT_ALLOWED`, `TARGET_UNREADABLE` and the code-less 404 `stream target not found` →
`no_destination`; `storage_exhausted`, `ingest_unavailable` → `unavailable`; `active_session` → `"already_running"`;
`phone_not_paired` → throws (a guard: auto start passes `phonePresent: true`); anything else → `null`.

- [ ] **Step 1: Failing tests** (DB-backed, `captureRig`; the rig's `pair` helper then a beat with `mode: "automatic"`; set the
  fixture `in_play` by `update fixtures set status = 'in_play'`, which is what `appendEvent` writes — FP8; credits granted):
  1. **Fires on the first beat** after `in_play`: one session, `start_cause = 'automatic'`, the action row's `source` is
     `domain`, `created_by` = the code's `issued_by`, `auto_started_at` and `auto_start_session_id` set, `auto_start_refusal`
     null, and the beat's own answer is `go-live` with `startedBy: "automatic"` (T42).
  2. **Predicate table through the use-case:** for each `FALSIFY` conjunct reachable end to end (switch off; mode
     `operator` on the beat; fixture `scheduled`; an open organiser session; `auto_started_at` set; `auto_start_blocked_at`
     set; a prior session with `first_ingest_at`; an attempt 59 s ago) assert **zero** automatic sessions. Count the rows run
     (8) and assert the positive pair (same rig, nothing falsified) starts one.
  3. **Once:** a second and third beat after the first start create nothing; after that session is stopped by the
     **organiser** (`stopSession`) `auto_start_blocked_at` is set (the stamp), another beat starts nothing, and an organiser
     `createSession` (manual Go live) works (always allowed).
  4. **Late pairing (A16):** fixture already `in_play`, phone pairs after → the first beat fires; and a session that already
     received ingest blocks it (`anySessionHadIngest`).
  5. **Refusals, one per code** (derive the list from `AUTO_START_REFUSALS`, assert 5 reached): no credits → `no_credit`;
     plan lacks relay → `not_entitled` (override `streaming.relay` false); no live destination → `no_destination`; the
     destination held by another fixture's session → `destination_in_use`; storage exhausted (`ingest.storage` full) →
     `unavailable`. Each: `auto_start_refusal` = the code, `auto_start_attempted_at` stamped, **`auto_started_at` stays
     null**, no session row, and the beat still answers 200.
  6. **Retry:** after a `no_credit` refusal a beat 59 s later does not retry (zero extra attempts: the `attempted_at` is
     unchanged); a beat at 60 s after a `grantCredits` fires, clears the refusal, stamps `started_at`.
  7. **Race:** two `postBeat` calls started with `Promise.all` create exactly one session (the compare-and-set claim), and
     an organiser Go live racing a beat leaves one open session (the loser's `active_session` is `already_running`, not a refusal).
  8. **The operator's `ended` beat and a beat that stops a session do not start one** (FP10).
  9. **A beat from the holder on a reissued code** attributes the start to that pairing's code issuer (a second user as
     issuer of the new code; assert `created_by`).
  10. **Isolation:** if `startBroadcast` throws an unmapped error, the beat still answers 200, the error is reported, and
      `auto_start_attempted_at` is stamped (retry in 60 s).
  11. **Mode lag (FP13):** a beat that flips `mode` to `operator` stops further auto start immediately (reads the arriving beat).
  12. **Stop stamp (FP9, FP12):** `stopSession` on a running session stamps `auto_start_blocked_at` and creates the settings
      row when none existed — and `fixtureStreamTarget` still resolves the default (FP1); a stop of a terminal session, a
      409 `not_active`, and a tick/sweep end (`phone_lost`) stamp nothing.
  13. **Another sport:** one case on the cricket rig — start fires identically (the predicate reads only status).
- [ ] **Step 2: Run — fails.**
- [ ] **Step 3: Implement.** `maybeAutoStart`:
  1. One statement reads the facts: settings (`left join`), fixture status, `exists` open session, `exists` session with
     `first_ingest_at is not null`, the pairing's `last_beat_at`, `answered_poll_seconds` and its code's `issued_by`.
     No settings row → `{ fired:false, why:"not_due" }` (empty case).
  2. `autoStartVerdict({ …, phonePresent: isPresent({ current: true, lastBeatAt, answeredPoll }, now, tunable("PHONE_SILENT_FLOOR_SECONDS", …)) }, now, tunable("AUTO_START_RETRY_SECONDS", AUTO_START_RETRY_SECONDS))`. Not due → `not_due`.
  3. The claim, which makes "once" and "no double start" atomic:

```sql
update fixture_stream_settings set auto_start_attempted_at = ${now}
 where fixture_id = ${fixtureId} and auto_stream and auto_started_at is null and auto_start_blocked_at is null
   and (auto_start_attempted_at is null or auto_start_attempted_at <= ${new Date(now.getTime() - retrySeconds * 1000)})
returning fixture_id
```
  Zero rows → `claim_lost`.
  4. `fixtureStreamTarget` → none → record `no_destination` (below). Else `startBroadcast({ userId: issuedBy, orgId, source: "auto", pairingId }, fixtureId, { targetId: pick.id, startCause: "automatic", phonePresent: true }, deps)`.
  5. Success: `update … set auto_started_at = ${now}, auto_start_session_id = ${sid}, auto_start_refusal = null`. A mapped
     refusal: `update … set auto_start_refusal = ${code}` (never `auto_started_at`). `already_running` writes nothing.
     `null` from the mapper rethrows.
  In `postBeat`, between step 5's tick and step 6's answer:

```ts
// 6. PR-2 (§7.2): auto start — the current phone's beat, never the operator's own Stop or a beat that stops a session.
if (decided.mine !== null && body.state !== "ended" && decided.stop === null) {
  try { await maybeAutoStart({ orgId: resolved.orgId, fixtureId: resolved.fixtureId, pairingId: decided.mine.id, phoneMode: body.mode }, deps, now); }
  catch (err) { log.error({ err: String(err), orgId: resolved.orgId }, "capture beat: auto start failed — the beat is answered");
                captureError(err, { orgId: resolved.orgId, route: "capture.beat.auto_start" }); }
}
```
  `stopSession`: after the 404 check, `if (!isTerminal(row.state)) { try { await markAutoStartBlocked(auth.orgId, fixtureId, deps.now(), auth.userId ?? null); } catch (err) { log + captureError } }` — a failed stamp is reported and the Stop proceeds (a live broadcast must stop).
- [ ] **Step 4: Run** `stream-auto.test.ts`, `capture-beat.test.ts`, `capture-start.test.ts`, `capture-get.test.ts`,
  `stream-sessions.test.ts` (stopSession callers), `stream-codes.test.ts`. PASS; `t > 0`; confirm `.files`.
- [ ] **Step 5: Mutations (each once):** (a) stamp `auto_started_at` inside the refusal branch → test 5/6 red; (b) delete the
  `claim` (call `startBroadcast` without the `update … returning`) → test 7 red; (c) drop `decided.stop === null` / the
  `ended` guard → test 8 red; (d) remove the `stopSession` stamp → test 3 red; (e) use `resolved.issuedBy` instead of the
  pairing's issuer → test 9 red; (f) `return true` for `phonePresent` is covered in T2's table. Record all.
- [ ] **Step 6: Commit** `feat(capture): automatic start on a paired phone's beat, once, never after an organiser Stop`.

**Owes:** unit + DB + regression (A12). **E2E/smoke:** T8.

---

### Task 5: Auto stop — in the tick

**Files:**

- Modify: `apps/web/src/server/usecases/stream-sessions.ts` (`tickSession`, new `endIfAutoStopDue`, `autoStopFactsOf`)
- Test: `apps/web/src/server/usecases/__tests__/stream-auto-stop.test.ts`

**Interfaces:**

- Consumes: T2's `autoStopVerdict`; `apply`, `readRow`, `isTerminal`, `tunable`.
- Produces: `tickSession` ends a session with `stop(auto_stopped)` when `autoStopDue`; **no signature change**. Internal:

```ts
type AutoStopFacts = { auto_stream: boolean; mode: string | null; finished_at: Date | null; created_at: Date };
async function autoStopFactsOf(exec: Tx | typeof sql, sessionId: string): Promise<AutoStopFacts | null>;
async function endIfAutoStopDue(row: Row, deps: SessionDeps, cause: "poll" | "beat" | "sweep"): Promise<Row>;
```

- [ ] **Step 1: Failing tests** (DB-backed on the rig; a started session via `r.start(phone)` with the pairing beaten
  `mode: "automatic"`; the match finished by `update fixtures set status = 'decided'` (the trigger stamps `finished_at`) and then
  `finished_at` set explicitly where a test needs a chosen instant — FP8; session `created_at` set explicitly where the
  ordering differential needs it):
  1. **Fires 180 s after:** tick at +179 s → open; +180 s → `ending`/`completed` with `end_reason = 'auto_stopped'` and the
     wire reason `auto_stopped` on the next beat (`over S auto_stopped`, T43). The delay is read from
     `AUTO_STOP_AFTER_RESULT_SECONDS`.
  2. **Each caller reaches it** (FP7): `tickSession` with cause `beat`, `poll` (`currentSession`), and `sweep`
     (`tickOpenSessions`), plus `relay-sweep`'s backstop — 4 callers asserted (count it).
  3. **Predicate table through the use-case**, each conjunct falsified alone → still open: switch off; the session phone's
     mode `operator`; fixture not finished (`finished_at` null); before the delay; **session created after `finished_at`**
     (post-result broadcast, never stopped — and the ordering differential: the same fixture, one session created one second
     before and one after, only the first ends). Assert the positive pair and count the 5 rows.
  4. **A reverted result cancels it:** finish, tick at +100 s, revert (`status = 'in_play'` → trigger clears `finished_at`),
     tick at +200 s → open; finish again → the clock restarts from the NEW `finished_at`.
  5. **A12 + A15 regression:** auto start fires, organiser Stop (stamp), organiser Go live by hand (session created before
     the result), result → auto stop ends it. And: a broadcast **started by the organiser by hand before the match** is also stopped.
  6. **First reason wins:** a session already `ending` (organiser Stop) is not re-decided (`end_reason` stays `stopped`); a
     terminal session is untouched; `phone_lost` evaluated first when both hold.
  7. **Locked re-take:** a result reverted between the unlocked read and `apply` ends nothing (drive by calling the
     command function `endIfAutoStopDue` passes to `apply` with the facts changed, or by a revert hook in the fake clock); assert no `end_reason` written.
  8. **No phone / no settings row / deleted fixture:** `pairing_id` null, no row, `fixture_id` null (set null on delete) →
     never auto-stopped, no throw.
  9. **Mode lag (FP13 / Review Focus 2):** the pairing's stored mode is what is judged; flip the stored mode to `operator`
     before the tick → not stopped; flip back → stopped. (Documents the ≤ one-interval lag as designed.)
  10. **Another sport:** the cricket rig ends identically.
  11. **Composed-mode session** (runner path) ends via the runner stop effect without throwing (reuse the composed rig used by `stream-tick.test.ts`).
- [ ] **Step 2: Run — fails.**
- [ ] **Step 3: Implement.** After `if (!isTerminal(row.state)) row = await endIfPhoneLost(...)` add
  `if (!isTerminal(row.state)) row = await endIfAutoStopDue(row, deps, cause);`. `autoStopFactsOf`:

```sql
select coalesce(st.auto_stream, false) as auto_stream, p.mode, f.finished_at, s.created_at
  from fixture_stream_sessions s
  join fixtures f on f.id = s.fixture_id
  left join fixture_stream_settings st on st.fixture_id = s.fixture_id
  left join fixture_stream_pairings p on p.id = s.pairing_id          -- the session's phone, ended or not
 where s.id = ${sessionId}
```
  `endIfAutoStopDue`: unlocked read → verdict via `autoStopVerdict` (delay `tunable("AUTO_STOP_AFTER_RESULT_SECONDS", …)`);
  not due → return; due → `apply(row.id, async (s, tx) => { if (s.state === "ending" || isTerminal(s.state)) return null; const f = await autoStopFactsOf(tx, s.id); return f && due(f) ? { type: "stop", reason: "auto_stopped" } : null; }, deps)`; then reread and log `rule: "auto-stop"` when terminal/ending.
- [ ] **Step 4: Run** `stream-auto-stop.test.ts`, `stream-tick.test.ts`, `relay-sweep.test.ts`, `stream-sessions.test.ts`,
  `capture-beat.test.ts`, `domain/__tests__/session.test.ts`. PASS.
- [ ] **Step 5: Mutations:** drop the locked re-take (use the unlocked verdict only) → test 7 red; change `<` to `<=` or
  drop `session_predates_result` → test 3's differential red; call `endIfAutoStopDue` before `endIfPhoneLost` → test 6's
  `phone_lost`-first case red; remove the `ending` early return → test 6 red. Record all.
- [ ] **Step 6: Commit** `feat(capture): automatic stop 3 minutes after the result, in the tick`.

**Owes:** unit + DB + regression (A12 + A15).

---

### Task 6: The organiser read — `auto`, `health`, the not-ready debounce, device model

**Files:**

- Modify: `apps/web/src/server/api-v1/schemas.ts` (`StreamPhone`), `apps/web/src/server/usecases/stream-phone.ts`,
  `apps/web/src/server/usecases/capture-phone.ts` (the pairing update writes `not_ready_since`), `openapi/v1*.json`
- Test: `usecases/__tests__/stream-phone.test.ts`, `usecases/__tests__/capture-beat.test.ts`

**Interfaces:**

- Produces (`StreamPhone` gains; every addition strict):

```ts
auto: z.object({
  enabled: z.boolean(),
  startedAt: z.string().nullable(),
  blocked: z.boolean(),                       // an organiser Stop turned auto start off for this match (A12)
  refusal: z.enum(AUTO_START_REFUSALS).nullable(),
  refusalAt: z.string().nullable(),           // auto_start_attempted_at, only while a refusal is set
}).strict().nullable(),                       // null = no settings row
// inside phone:
health: z.enum(HEALTH_REASONS).nullable(),    // §7.4's amber reason, one authority (domain/phone-health.ts)
notReadyForMs: z.number().int().nonnegative().nullable(),
notReadyShown: z.boolean(),                   // notReady held >= PHONE_NOT_READY_SHOW_AFTER_SECONDS (R-2)
```

  `lastTakeover {at, model}` already exists (PR-1); the panel's 30-minute window and dismissal are client-side.
- The beat write gains `not_ready_since = case when ${body.notReady}::text is null then null else coalesce(not_ready_since, ${now}) end`.

- [ ] **Step 1: Failing tests.**
  - `auto`: no settings row → `null` (empty case first); a row → `enabled/startedAt/blocked/refusal/refusalAt` from the columns;
    `refusalAt` null when `refusal` is null; after a T4 `no_credit` refusal the read serves `refusal: "no_credit"` and a
    non-null `refusalAt`; serves nothing secret (the existing secret-scan assertion in `stream-phone.test.ts` still runs
    over the new object).
  - `health`: for each reason, drive a beat that causes it (delivery `stalled`; thermal = `HOT_THERMAL_STATUS`; battery
    `LOW_BATTERY_PERCENT − 1` not charging; a held phone silent for `NOT_RESPONDING_BEATS × cadence`) and assert the served
    reason; priority when two hold; **null battery/thermal/bitrate beat (Paired phase) → `health: null` and no battery** (FP14);
    expected values come from `HEALTH_REASONS` and the config constants.
  - `notReady` debounce (FP16, **owner ruling R-2: `PHONE_NOT_READY_SHOW_AFTER_SECONDS` = 20**; every figure below derives from the
    constant): (a) **a flap shorter than the constant never shows** — beats alternating `"sound"` / `null` / `"held"` with every
    non-null stretch `constant − 1` s long, and a replay of a scripted 40-beat trace shaped like staging's 27 sound / 11 held / 3
    camera flips in 10 min: `notReadyShown` is never true (count the beats checked); (b) **a hold of `constant` s shows** —
    `notReadyForMs` equals the elapsed ms and `notReadyShown` is true at exactly `constant` and false 1 s earlier (boundary);
    a reason change inside the hold (`sound` → `held`) keeps the clock; (c) **a clear hides it at once** — the next beat with
    `notReady: null` makes `notReadyShown` false and `notReadyForMs` null in the very next read, and the next non-null starts a
    fresh clock. `notReady` never changes a `maybeAutoStart` outcome (re-run T4's start case with `notReady: "camera"` on the
    beat → it still starts).
  - `model` (FP15): claim beat with `device: {model:"Pixel 8"}` then 3 beats with `device: null` then an `ended` beat with
    `device: null` → `phone.model` and (after a takeover) `lastTakeover.model` stay `"Pixel 8"`; a `resume` claim with
    `device: null` keeps it; a new claim with a model replaces it.
  - `startFailed` (FP17): set by a beat, cleared by the next beat that sends null — already PR-1; one regression assertion.
- [ ] **Step 2: Run — fails** (schema strictness rejects the missing fields; `auto` is `z.null()`).
- [ ] **Step 3: Implement.** `stream-phone.ts` reads the settings row in the same function (non-tenant `sql`, org already
  proven) and fills `auto`; `phone.health = phoneHealthOf({ notResponding, delivery: beat.delivery, thermal: beat.thermal, battery: beat.battery })`;
  select `p.not_ready_since` in `PAIRING_COLS` and derive `notReadyForMs = since === null ? null : now − since` and
  `notReadyShown = notReady !== null && notReadyForMs !== null && notReadyForMs >= PHONE_NOT_READY_SHOW_AFTER_SECONDS * 1000`.
  Update the `StreamPhone` doc comment ("`auto` is PR-2's, always null here" is now false); regenerate OpenAPI.
- [ ] **Step 4: Run** `stream-phone.test.ts`, `capture-beat.test.ts`, `stream-contract.test.ts`, `openapi-coverage.test.ts`. PASS.
- [ ] **Step 5: Mutations:** swap two `HEALTH_REASONS` in the read → priority test red; `>=` to `>` in `notReadyShown` → boundary
  red; drop the `coalesce(not_ready_since, …)` (reset on every beat) → the steady-stretch case red; make the beat write
  `device_model = <body model>` (no coalesce) → the survives-null case red.
- [ ] **Step 6: Commit** `feat(capture): the organiser read serves auto state, phone health and a debounced not-ready`.

**Owes:** unit + DB + API.

---

### Task 7: The sequence model — auto start and stop over beat / result / revert / stop orderings

**Files:**

- Create: `apps/web/src/server/usecases/__tests__/stream-auto-model.test.ts`
- Test: itself (reuses `_capture-rig.ts`; no changes to `capture-model.test.ts`, FP20)

**Interfaces:** Consumes the real `postBeat`, `tickSession`, `stopSession`, `createSession`, `saveStreamSettings`, the rig clock.

- [ ] **Step 1: Write the model** with `fc.commands` over a model `{ autoOn, phoneMode, finishedAt: number|null, sessions: {id, createdAt, startedBy, ended, byAutoStop, hadIngest}[], organiserStopped: boolean, blocked: boolean }`.
  Commands (each predicts its outcome from the spec rows, runs the real call, compares, updates the model):
  `Beat(mode)`, `MatchStart` (status `in_play`), `Finish` (status `decided`, explicit `finished_at` on the rig clock), `Revert`
  (status back to `in_play`), `OrganiserStop`, `ManualGoLive`, `ToggleAuto`, `SetPhoneMode`, `Advance(ms)` with tick, `Ingest(on|off)` (FakeIngest.setState), `GrantCredits`.
  After **every** step, invariants (read from the database, not the model):
  1. at most one automatic session per fixture, ever (`count(start_cause='automatic') <= 1` — once per match);
  2. no automatic session is created after an organiser Stop that precedes it (`created_at > blocked stamp` is impossible);
  3. no session with `created_at >= finished_at` (at the time of the stop) has `end_reason = 'auto_stopped'`;
  4. every `auto_stopped` session had `now ≥ finished_at + AUTO_STOP_AFTER_RESULT_SECONDS` at its end and a finished fixture at that instant;
  5. a reverted result leaves no `auto_stopped` session whose end instant is before a later finish's delay (the pending stop was cancelled);
  6. a refusal never sets `auto_started_at`; a set `auto_started_at` has an `auto_start_session_id` that exists;
  7. `autoAllowed` on the answer equals the model's switch.
  Anti-vacuity counters (each must be > 0 over the drawn runs, with the seed and tally written to `CAPTURE_AUTO_MODEL_REPORT`,
  default the OS tmpdir): auto starts fired, auto starts blocked by an organiser Stop, refusals, retries that fired, auto stops
  fired, auto stops cancelled by a revert, post-result broadcasts left alone (created after `finished_at`), hand-restarts auto-stopped
  (A15), mode flips, two-beat races. ≥ 200 runs (the PR-1 model's reasoning on rare outcomes), seed from `CAPTURE_AUTO_MODEL_SEED` (default fixed), run three times.
- [ ] **Step 2: Run** the file once; it must collect and pass; `t > 0`.
- [ ] **Step 3: Mutation table (each once, record the killer):** remove T4's claim → invariant 1; remove the Stop stamp →
  invariant 2; drop `session_predates_result` → invariant 3; ignore `finished_at` null in the stop → invariant 5; stamp
  `auto_started_at` on refusal → invariant 6 (and the retries counter hits zero — itself a failure).
- [ ] **Step 4: Commit** `test(capture): the auto start/stop sequence model`.

**Owes:** property/sequence (TEST-STRATEGY rule 10) + mutation.

---

### Task 8: E2E, smoke, and workflow wiring (server-visible)

**Files:**

- Create: `apps/web/e2e/walkthrough/capture-auto.spec.ts`
- Modify: `scripts/smoke.ts` (`captureV2Suite`), `.github/workflows/e2e.yml` and its pin `e2e-ci-wiring.test.ts` (**OG-E**),
  `apps/web/e2e/helpers/fake-capture-phone.ts` (a `mode` option — the helper hard-codes `mode: "operator"` at :180)
- Test: the spec, `scripts/__tests__/smoke-select.test.ts` (unchanged names), `e2e-ci-wiring.test.ts`

**Interfaces:** Consumes the walkthrough helpers (`signInAs`, `seedRig` pattern in `capture-phone.spec.ts`), `fakeCapturePhone`,
the fake-ingest control route, a **device link** for scoring ("any surface").

- [ ] **Step 1: Failing walkthrough** (a fresh org per test; whole file, project `walkthrough`; the environment is asserted in
  `beforeEach` like `capture-phone.spec.ts`, including the new tunables):
  1. **Auto start from the Remote scoring pad:** organiser turns the switch on over the API (`PUT stream-settings {autoStream:true}`);
     a fake phone pairs with `mode: "automatic"`; the match is started and scored **through a device link** (the `/score/<token>`
     route, not the console); within one beat the phone hears `go-live` with `startedBy: "automatic"`, the DB shows
     `start_cause = 'automatic'`, one session. The negative pair: the same run with the switch off creates none.
  2. **Auto stop after the tuned delay:** `AUTO_STOP_AFTER_RESULT_SECONDS` shortened; finish the match through the device link;
     the phone's next beat hears `over … auto_stopped`; the session `end_reason` is `auto_stopped`; a broadcast the organiser
     starts **after** the result is not stopped (wait the delay + 2 beats).
  3. **A12 + A15:** auto start, organiser Stop (via the panel's Stop), more beats → no restart; organiser Go live by hand; result →
     auto stop.
  4. **Refusal:** zero credits → `GET stream-phone` serves `auto.refusal = "no_credit"`; grant credits → within the retry window
     (tuned) the session starts and `refusal` is null.
  5. **Switch API** at 320/768/1280 is UI (T13); here the API answers 200/404/403 only.
- [ ] **Step 2: Smoke.** `captureV2Suite` gains: switch on via the API, pair, start the match with a device link score, assert the
  automatic session, finish, advance, assert `auto_stopped`; it keeps the suite's cleanup rules. `SMOKE_ONLY=captureV2 pnpm test:smoke`.
- [ ] **Step 3: Workflow wiring (OG-E, wait for the OK).** Set `AUTO_STOP_AFTER_RESULT_SECONDS` and `AUTO_START_RETRY_SECONDS` in
  `e2e.yml` beside the existing walkthrough tunables (Start server step and Playwright step) and pin both in
  `e2e-ci-wiring.test.ts` the way `PHONE_LOST_LIVE_MINUTES` is. Budget the spec's `test.setTimeout` from the constants
  (`Math.max(FLOOR, base + beats * cadence + AUTO_STOP delay)`), never a flat number (AGENTS.md #20).
- [ ] **Step 4: Run** the spec whole (three runs of the file; record counts), `e2e-ci-wiring.test.ts`, the smoke suite, and
  `capture-phone.spec.ts` whole (the PR-1 walkthrough re-run; it now meets `autoAllowed`).
- [ ] **Step 5: Mutation:** comment out the device-link scoring so the match is started from the console → the "any surface"
  assertion must be the thing that reds only if the helper was the sole producer — confirm by making the helper score through
  the console and asserting test 1's `scoring surface` marker (`device_link` in `score_events`) fails. Record.
- [ ] **Step 6: Commit** `test(capture): auto start and stop walkthrough, smoke case, tunables in the e2e workflow`.

**Owes:** E2E + smoke + regression.

---

### Task 9: Lane close — the server half

**Files:** none new.

- [ ] **Step 1:** `cd $WT/apps/web && rtk proxy pnpm typecheck` (exit 0) and `rtk proxy pnpm lint` (`✖ 0 problems` or no line).
  Also `cd $WT && pnpm typecheck:scripts` (the smoke and tools changes).
- [ ] **Step 2:** `pnpm openapi:gen && git status --porcelain` empty; `pnpm i18n:check` clean (no copy changed).
- [ ] **Step 3:** Re-run every task's scoped command from one list, with `rm -f` on each `$OUT`; paste the raw
  `{p,t,f,files}` counts into the PR description. No full suite.
- [ ] **Step 4: Review.** Per-batch Sonnet reviews were done; now the **Opus whole-branch review** of
  `git diff 7e75fd4a7..HEAD` with this plan as the brief; gaps are written to `.superpowers/` (gitignored) and fixed in the owning
  task's files. Re-run the gates touched.
- [ ] **Step 5: STOP.** No push and no PR without the owner's OK. State plainly: the server half is complete and independent;
  T10–T13 (the panel, built to Option A) are not started. Smoke runs on PRs only; e2e runs on push to `main` only (workflow_dispatch
  with `pr` for a branch) — say which was actually run.

---

## Wave U — the panel (build to the approved mockup Option A)

The §7.6 gate is satisfied (owner ruling 2026-10-07, OG-M). **Every task here builds to Option A**, `/Users/ashokhein/github/seazn.club/.superpowers/sdd/2026-10-07-capture-qr-v2-pr2/mockups/option-a-inline-line.html` (PNGs beside it; gitignored, never commit). Read it before each task. The server half (T1–T9) is already done and needs none of this.

Every task below waits on OG-M. The server half (T1–T9) ships without them.

### Task 10: The switch UI (§7.1) — build to Option A

Mockup: `/Users/ashokhein/github/seazn.club/.superpowers/sdd/2026-10-07-capture-qr-v2-pr2/mockups/option-a-inline-line.html`.

**Files:** Modify `components/v2/fixture-stream-panel.tsx`, `dictionaries/{en,es,fr,nl}/ui.json` (`stream.auto.*`); Test
`components/v2/__tests__/fixture-stream-panel.test.tsx`, `e2e/mobile.spec.ts` whole.

- [ ] **Step 1: Failing tests.** The switch sits under the destination picker in Ready (as Option A draws it) and writes
  `PUT {autoStream}` on change; its checked state follows `read.auto.enabled`; in Live it shows the read-only line "Automatic:
  stops about 3 minutes after the result" (the figure comes from the server constant through the panel's context loader, not a typed
  `3`). A Playwright case at 1280/768/320 (no horizontal scroll) toggles it and re-reads the DB (`auto_stream`).
- [ ] **Step 2–5:** red, implement, green, **mutation** (drop the PUT call → the e2e DB re-read goes red).
- [ ] **Step 6:** `pnpm i18n:gen-keys`, `pnpm i18n:check`; commit.

**Owes:** unit + E2E + visual (entitlement-gated states granted AND denied).

### Task 11: The phone-health line, the not-ready line and the Details data (§7.4) — build to Option A

Mockup: same path as T10.

**Files:** Modify `components/v2/stream-signal-chain.tsx` (fill the reserved `phoneStatus` slot — Option A: **one line in the existing
strip under the chain; an amber state turns that strip amber**), `lib/stream-chain.ts`, `lib/stream-session-view.ts`,
`components/v2/fixture-stream-panel.tsx`, the four dictionaries.

- [ ] **Step 1: Failing tests.**
  - The line "Phone · 78% charging · 2.4 Mbps · heard 4 s ago" is built from the read model only (`beat.battery`,
    `beat.bitrateKbps`, `elapsedMs`). It **omits** the battery part when `battery` is null and the Mbps part when `bitrateKbps` is
    null: assert the strings "0 Mbps" and "null" are absent over a Paired-phase fixture, and that every pre-live state renders
    identically with `battery`/`thermal` null (FP14).
  - The strip turns amber, with the spec's sentence, from `phone.health` in priority order (not responding, stalled, hot, battery
    low) — never from a client-side threshold.
  - "Automatic" / "Operator" beside the state word; "Phone not ready: {reason}" **only when `notReadyShown`**; "Couldn't start on the
    phone" from `startFailed`; "Automatic start couldn't begin: {reason}" as an inline strip from `auto.refusal`, with the Buy credits /
    Manage destinations remedies.
  - **Details (FP22, Q-D):** data used and the app version go in the existing `stream-details` disclosure (`fixture-stream-panel.tsx`
    ~:2149), which exists only in Live/Ending, as two extra chips after the runner's `healthChips`; each is omitted when null. Not shown
    pre-live unless the owner answers Q-D otherwise.
- [ ] **Step 2–5:** red, implement, green, mutation (render amber from a client threshold → the priority test red; drop the
  `notReadyShown` gate → the flap case red; drop the Mbps null guard → the "0 Mbps" absence red).
- [ ] **Step 6:** gen-keys, i18n check, commit. **Owes:** unit + E2E driven through fake beats (each amber state, the not-ready line
  with a flap < constant, a hold ≥ constant and a clear, the refusal) + visual.

### Task 12: Device model and the takeover notice (§7.5) — build to Option A

Mockup: same path as T10.

**Files:** Modify `components/v2/fixture-stream-panel.tsx`, `lib/stream-chain.ts`, the four dictionaries.

- [ ] **Step 1: Failing tests.** "Paired · Pixel 8" under the Phone node from `phone.model` (FP15: persisted by PR-1); for 30 min after
  `lastTakeover.at` an inline amber strip, with Option A's dismiss **X**: "The camera moved to another phone ({model}) at {time}. Not yours?
  Stop the stream, then Revoke & reissue", naming Stop **only when the session is live**. The 30-minute boundary (29:59 shown, 30:00
  not) is computed on the server clock: add `lastTakeover.elapsedMs` to the read model in this task, with its own T6-style test. The X
  persists the dismissal per takeover instant (localStorage in try/catch — a per-viewer convenience only). E2E: a second fake phone claims
  → the strip appears; a dead-phone takeover while live names Stop.
- [ ] **Step 2–5:** red, implement, green, mutation (drop the live gate → the "names Stop only when live" case red).
- [ ] **Step 6:** gen-keys, i18n check, commit. **Owes:** unit + E2E + visual.

### Task 13: UI close — walkthrough, visual verdicts, final review

- [ ] **Step 1:** `capture-auto.spec.ts` and `capture-phone.spec.ts` whole (the PR-1 specs re-run), `mobile.spec.ts` whole (serial: re-run
  after each fix until a full pass — AGENTS.md #21), `fixture-stream-panel.test.tsx`.
- [ ] **Step 2:** Screenshots at 1280, 768, 320 compared with Option A's PNGs beside the mockup, per-screen verdicts; entitlement-gated
  states granted AND denied. Confirm the images exist and differ.
- [ ] **Step 3:** Opus whole-branch review of the UI diff; fix inline.
- [ ] **Step 4: STOP** before any push or PR (owner).

---

## Self-review (2026-10-07, against the spec)

**Spec coverage.** §7.1 switch → T3 (API, `autoAllowed`), T10 (UI). §7.2 auto start → T2 (predicate), T4 (use-case, refusals,
retry, A12 stamp), T7, T8. §7.3 auto stop → T2, T5 (all four tick callers, FP7), T7, T8. §7.4 health line → T2 (`phoneHealthOf`),
T6 (served), T11 (UI). §7.5 model and takeover → T6 (persistence regression, FP15), T12. §7.6 mockups → satisfied (Option A). §8.2 V431 → T1
(plus R-1 and FP16 additions). §9 → T3 (route unchanged, FP2), T6. §11.2 test plan: unit (T2), use-case (T4–T5), sequence (T7),
mutation (each task), E2E (T8, T10–T13), smoke (T8), regression A12+A15 (T5, T8), visual (T13). Gaps found and closed: the
`target_chosen` hole (FP1) had no spec row; the Stop stamp had no home (FP9); health thresholds were duplicated between history and
panel (FP21) and are now one function.

**Placeholder scan.** No TBD/TODO. The two places that name "the helper used in `capture-phone.spec.ts`" (T8) point at existing,
pinned functions; the executor re-pins their line numbers per the batch rule.

**Type consistency.** `AutoStartRefusal` / `AUTO_START_REFUSALS` (T2) = the V431 CHECK list (T1 test) = `StreamPhone.auto.refusal`
(T6). `PhoneMode` is the beat's `mode` enum. `HealthReason` / `HEALTH_REASONS` (T2) = `StreamPhone.phone.health` (T6). `markAutoStartBlocked`
is defined in T3 and used in T4. `maybeAutoStart` takes `pairingId` and reads the issuer itself (FP10). Constants: `AUTO_STOP_AFTER_RESULT_SECONDS`,
`AUTO_START_RETRY_SECONDS`, `PHONE_NOT_READY_SHOW_AFTER_SECONDS` (T1) are the names used in T2, T4–T6, T8.

**Review Focus.** Items 1–5 each have a named test (T1/T3; T5 case 9; T4 case 7; T5 case 1/3 with explicit stamps and T1's note;
T2/T6).

**Spec ambiguities needing a ruling:** R-1 (the `target_chosen` column versus freezing the default), Q-D (app version / data used outside Live),
and, for the controller, R-3 (what counts as an organiser Stop). Smaller plan decisions recorded, not ruled:
the two new tunables (FP6); the blocked stamp survives a switch toggle; auto start latency on a far-cadence phone is up to one
60 s beat (the spec evaluates auto start on beats only, not on the tick).
