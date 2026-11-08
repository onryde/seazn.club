# Swiss auto-advance: pair the next round and confirm the hand-off automatically

Status: design of record, 2026-11-08. Owner brainstorm 2026-11-07 (session "web"), then owner delegation
("no check-in, apply the product-owner recommendation"). Calls made under that delegation are marked **[call]**
and logged in `.superpowers/web-decisions-2026-11-07.md` (D11+).

## 1. Why

An organiser running a 3-round Swiss today must be at the desk at the end of every round to press **Pair next**,
and at the end of the stage to press **Complete** and then **Confirm** the proposal for who moves on. If they are
on court, refereeing, or simply away, the event stalls: boards sit empty while players wait.

The owner wants this to run by itself, but **not instantly**: a scorer must have time to correct a wrong result
before it shapes the next round's pairings. Owner's words: "I don't want to do immediately, like 60 seconds
delay", "just want allow to correct the result".

Success: an organiser switches it on, walks away, and the event moves round to round with a one-minute grace
after each round, stopping (visibly, with the reason) only when a person is genuinely needed.

## 2. Goals, non-goals, anti-goals

Goals
- G1. **Pair the next Swiss round automatically**, about 60 s after the last board of the current round is decided.
- G2. **Confirm the stage hand-off automatically** (the seed proposal for the next stage), about 60 s after the
  proposal is drafted. Applies to any stage hand-off that produces a proposal, not only Swiss (owner).
- G3. **A correction inside the window restarts it.** Any decided-result change (a new result, a void, a
  correction) in the round restarts the 60 s; the action fires only on a round that has been stable for 60 s.
- G4. **A banner on the division's fixtures tab** says what auto-advance is doing: waiting, counting down,
  blocked (with the reason and the fix), done. It clears by itself when the cause clears, and can be closed with ×.
- G5. **Manual buttons keep working** at all times and win: pressing **Pair next** or **Confirm** by hand does the
  action now and the pending automatic one becomes a no-op.

Non-goals
- No automatic pairing for non-Swiss stages (owner: "pairing only for Swiss").
- No automatic resolution of anything that needs judgement: tie-break picks, withdrawals mid-round, abandoned
  boards, roster drift. Those block with a banner.
- No change to how a round is judged complete, how Swiss pairs, or how proposals are computed.

Anti-goals (a failure even if it "works")
- A round paired from a result that was corrected seconds later. (G3 exists for this.)
- Pairing or confirming twice, or racing a human who pressed the button.
- Silent stalls: auto-advance stopped and nobody can see why.
- Surprising an organiser who never opted in. Both switches are **off by default**.

## 3. What exists today (verified 2026-11-08, origin/main 79762c2d9)

- Pair next = `POST /api/v1/stages/:id/generate` → `generateStageFixtures` (usecases/stages.ts:2998), under the
  division advisory lock; Swiss target round from `nextUnseatedSwissRound` (lib/swiss-shell.ts:171); a null target
  is a no-op. Refusals: `STAGE_NOT_READY` (previous round has undecided boards, names abandoned ones),
  `SWISS_NO_LEGAL_PAIRING`, `SWISS_ROUNDS_ABOVE_MAX`, `SCHEDULE_LOCKED`, field under two.
- Round complete = every seated board of the round in `decided|finalized|forfeited` (stages.ts:1429, :1917);
  byes are minted `forfeited`; abandoned/cancelled block.
- `onDecided` (scoring.ts:974, run on every decide AND on `core.void`) → `markDependentSeedProposalsStale` →
  `maybeAutoAdvance` (per-DIVISION `auto_progress`, completes a whole stage when no open fixture remains; no UI).
- Seed proposals: `stage_seed_proposals` (V360), draft|confirmed|stale; drafted by `completeStage` for
  `progression.timing = "setup"`; confirmed by `confirmSeedProposal` (stages.ts:6558) with refusals
  `SEEDING_PROPOSAL_STALE`, `SEEDING_TIE_UNRESOLVED`, `SEEDING_ALREADY_CONFIRMED`, … A decided-result correction
  stales the draft and drafts a fresh one.
- Background work: **no QStash in the repo.** A Cloudflare cron worker (apps/cron-worker) calls `/api/cron/*`
  with `x-cron-secret`: every **minute on prod**, every **5 minutes on stg** (owner ruling 2026-10-27 accepts
  stg lateness). A DB due-time queue pattern exists (email outbox, V470: `next_attempt_at`, lease).
- The fixtures tab has no realtime subscription; it refreshes after its own actions. `band-poll.ts` is the
  existing polling helper.
- `division_events` (hash-chained) is the history; `actor_id` null = system.

## 4. Design

### 4.1 The switches

Two booleans, both default **off**, shown in the stage's settings on the fixtures tab:

| Switch | Lives on | Shown on |
|---|---|---|
| **Pair the next round automatically** | the Swiss stage (`stages.config.autoPair`) | Swiss stages only |
| **Confirm who moves on automatically** | the TARGET stage, the one that receives the qualifiers (`stages.config.autoConfirmHandoff`) | any stage whose `progression.timing = "setup"` (i.e. it gets a seed proposal) |

**[call]** Stored in `stages.config` (strict schema: add both keys to `StageConfig`, schemas.ts:1230, and to the
stage PATCH body). Per stage, not per division, because the owner framed them as stage settings and a division
can mix a Swiss stage with a knockout.

**[call] The confirm switch is keyed on the TARGET stage**, because proposals already are
(`stage_seed_proposals.stage_id` = target, one draft per target). Consequences, all deliberate:
- A target fed by several sources (`progression.sources[]`) gets its proposal only when the last source completes
  (earlier ones get `SEEDING_SOURCE_INCOMPLETE`); its one switch governs it. No per-source switches.
- A Swiss stage feeding a gold and a silver bracket: each bracket has its own switch, so an organiser can let the
  silver bracket go automatically and confirm gold by hand.

**[call] Auto-pair never seats round 1.** Swiss round 1 is pre-minted as empty shells, so "previous round complete"
is vacuously true before play; seating round 1 is the organiser's deliberate start (check-in, roster close). Arming
requires a target round ≥ 2 whose previous round has at least one seated board. Round 1 is always paired by hand.

**[call] The legacy division `auto_progress` steps aside for an auto-pair stage.** With `autoPair` on,
`maybeAutoAdvance` skips that stage, so completion always gets the 60 s grace (and an `on_complete` next stage is
not drawn the instant the last board lands). Divisions without auto-pair behave exactly as today.

**[call] Auto-pair also finishes the stage.** When auto-pair is on and the LAST round settles, the same 60 s window
ends in **Complete stage** (which drafts the proposal). Without this the chain stalls at a Complete click and the
owner's "click confirm at the end of all rounds" pain is only half solved. If the division's legacy
`auto_progress` already completed the stage, this is a no-op.

### 4.2 The settle window and its source of truth

A new table **`stage_auto_actions`** is the single source of truth (one authority per fact):

| column | meaning |
|---|---|
| `id`, `org_id`, `division_id`, `stage_id` | scope |
| `kind` | `pair_round` \| `complete_stage` \| `confirm_handoff` (for confirm, `stage_id` is the TARGET stage) |
| `target` | round number for `pair_round`; the source stage's last round number for `complete_stage`; the proposal id for `confirm_handoff` |
| `due_at` | when it may fire (last relevant change + 60 s) |
| `state` | `waiting` (a board still open) \| `pending` (counting down) \| `paused` (a person is reviewing the proposal) \| `blocked` \| `done` \| `cancelled` (skipped) |
| `blocked_code`, `blocked_detail` | the refusal code/params from the usecase, for the banner |
| `lease_until`, `attempts` | claim/retry, same shape as the email outbox |
| `done_at`, `result` | what was done (round paired / stage completed / proposal confirmed) |

At most one live row (`waiting|pending|blocked`) per (stage, kind) — partial unique index.

**Arming.** A single function `rearmAutoActions(tx, stageId)` recomputes the stage's live row from facts in the
DB. It runs:
- inside `onDecided` (every decide, void, correction) for a fixture of an auto-pair stage,
- after `completeStage` drafts a proposal, and after `markDependentSeedProposalsStale` drafts a fresh one,
- when either switch is turned on (so an already-complete round arms immediately),
- after a manual Pair / Complete / Confirm (to retire the row: state `done`, `result.by = "person"`).

It is idempotent and derives everything again: round complete? → `pending` with `due_at = now + 60 s`
(**restarted on every call**, which is what makes a correction restart the clock, G3); round not complete →
`waiting` with the open boards named; nothing to do → retire.

Re-arm rules that are easy to get wrong:
- **Skip is sticky for its target.** A `cancelled` row keeps its `target`; `rearmAutoActions` never re-arms a
  (stage, kind, target) that has a `cancelled` row, even after corrections. The NEXT target (round N+1) arms
  normally. Skip is offered for `pair_round` and `complete_stage` only; confirm is stopped by pausing or the switch.
- **A new draft re-arms confirm.** A recompute or standings override stales the old draft and inserts a new one;
  that new proposal id gets a fresh `pending` row with a fresh 60 s (unless the stage is `paused`, below).
- **A person reviewing the proposal pauses confirm.** Opening the proposal editor calls
  `POST /api/v1/stages/:id/seed-proposal/hold`, which sets the target's confirm row to `paused` (edits only reach the
  server on Confirm, so the clock must not fire under an organiser mid-edit). Closing the editor without confirming
  calls `.../release`, which re-arms a fresh 60 s. A `paused` row older than 30 minutes with no release is released
  by the sweep (a closed tab must not stall the event forever). Their own Confirm retires the row as `done` by a
  person.

**[call] 60 s is a constant, not a setting** (`AUTO_ADVANCE_SETTLE_MS = 60_000`). The owner asked for "like 60
seconds"; a knob is a premature abstraction. Note: 60 s is longer than the device-link phone's 45 s Undo, so a
phone scorer's own undo window always closes before auto-pair seats the next round (relevant to the carried-forward
guard, which refuses device-link writes once the next round is seated).

### 4.3 Firing

**[call] Firing has two triggers over the one table, and the DB row decides:**

1. **The cron sweep (always on, the guarantee).** A new job `auto-advance` in apps/cron-worker on the FAST trigger
   (minute on prod, 5 min on stg) calls `POST /api/cron/auto-advance` (`x-cron-secret`, same pattern as the email
   outbox). It claims due `pending` rows with a lease (`for update skip locked`), fires each, and writes the outcome.
2. **QStash (optional, the low-latency alarm the owner chose).** When `QSTASH_TOKEN` is configured, arming also
   publishes a delayed message (delay = 60 s) to `POST /api/internal/auto-advance/fire?stage=…` (QStash signature
   verified with `QSTASH_CURRENT_SIGNING_KEY`/`QSTASH_NEXT_SIGNING_KEY`). The handler runs the SAME claim for that
   one stage. A message for a row that was re-armed (later `due_at`) or retired finds nothing due and does nothing.

Why both: the owner chose QStash over cron for reliability and promptness. The repo already runs a minute cron on
prod, so the sweep alone fires within 60–120 s of the last result with no new vendor; QStash tightens that to
~60 s where configured and is never the only path, so a lost or duplicated message cannot stall or double-fire.
Without QStash credentials the feature works on the sweep alone. **Provisioning QStash (token + signing keys on
stg/prod) is an owner action, listed in §8.**

**Firing a row** (one function, `fireAutoAction(rowId)`, used by both triggers):
1. Lock the row; re-check `state = pending`, `due_at <= now`, switch still on. Else stop.
2. Re-derive the precondition from the DB (round still complete / proposal still the current draft and its
   standings hash still matches). If it changed, `rearmAutoActions` and stop.
3. Call the SAME usecase the button calls, as a **system actor** (§4.5):
   `generateStageFixtures` / `completeStage` / `confirmSeedProposal(proposalId, no edits)`.
4. Success → `done`, `done_at`, `result`; write a `division_events` row (`stage_auto_paired`,
   `stage_auto_completed`, `stage_handoff_auto_confirmed`, actor null), publish the division update.
5. A typed refusal (any `UsecaseError` code) → `blocked` with `blocked_code`/`blocked_detail`. Not retried until a
   relevant change re-arms it. Unexpected errors → retry with backoff up to 5 attempts, then `blocked`
   (`AUTO_ADVANCE_FAILED`).

Races: the usecases already serialise on the division advisory lock and are idempotent (null target = no-op;
`SEEDING_ALREADY_CONFIRMED`). A manual press wins and retires the row (§4.2).

### 4.4 Blocked: what needs a person

The auto-confirm never resolves ties or edits a proposal. These block, each with a banner line naming the fix:

| Code | Banner says | Clears when |
|---|---|---|
| `STAGE_NOT_READY` (abandoned board) | Round N: board X was abandoned. Decide or void it. | the board is decided |
| `SWISS_NO_LEGAL_PAIRING` | No legal pairing for round N. Pair by hand or add a round. | a manual pairing / settings change |
| `SEEDING_TIE_UNRESOLVED` | A tie decides who moves on. Pick it, then confirm. | manual confirm |
| `SEEDING_PROPOSAL_STALE` | handled internally: a stale draft re-arms on the fresh one (never shown) | — |
| `SCHEDULE_LOCKED` | The division is frozen. | unfreeze |
| `AUTO_ADVANCE_FAILED` | Auto-advance hit a problem. Use the button. | manual action / re-arm |

Unknown codes render a generic line with the code (never silent).

**Finding folded in (F1):** `confirmSeedProposal` sets `status = 'stale'` and then throws inside the same
transaction, so the stale mark rolls back. The fire path re-checks the standings hash itself (step 2) and this wave
moves the stale write out of the rolled-back transaction (or derives staleness on read), with a test.

### 4.5 The system actor

`AuthCtx.via` gains **`"system"`** (auth.ts:19) with `userId: null`, a fixed `role` of organiser-equivalent for the
three usecases only, and the org id of the row. **[call]** A dedicated value, not `mintOrgOwnerAuth`
(impersonating the oldest owner), so history never claims a person did what the clock did. Any code path that keys
on `via` gets a review; entitlement checks for these three actions are unchanged (pairing and progression are not
paywalled today).

### 4.6 The banner (fixtures tab)

One banner component above the stage rail, from the stage's live `stage_auto_actions` row (plus the most recent
`done` row for 10 minutes):

| State | Tone | Copy (en) | Actions |
|---|---|---|---|
| waiting | neutral/amber | Auto-pairing is waiting. Round 2: board 3 is still being played. Round 3 will be paired 1 minute after it is decided. | × |
| pending | green | Pairing round 3 in about a minute. Every board in round 2 is decided. Correct a result now to restart the wait. | **Pair now**, **Skip this time**, × |
| blocked | red | Auto-pairing stopped. (reason line from §4.4) | the fix's own button where one exists, × |
| done | grey | Round 3 was paired automatically at 10:42. | × |

Same four for complete and confirm, with their own copy. Two extras:
- **Completion countdown offers "Add a round".** A completed stage cannot be reopened (a void does not reopen it),
  so the pending `complete_stage` banner reads "Completing the stage in about a minute. Need another round? Add it
  now." with **Add a round** (the existing `addSwissRound`, which re-arms as `waiting` for the new round) and
  **Skip this time**. **[call]** No extra completion condition beyond this.
- **Confirm paused** (grey): "Paused while you review who moves on. Confirm when ready." No ×-cancel semantics.

**[call]**
- **× closes it for this browser until the state changes** (stored per stage + state + due_at in localStorage);
  it never cancels the action. Owner: "just waiting until clear automatically or close it by x action".
- **Skip this time** sets the row `cancelled` for this round only; the next round arms normally. A switch-off is the
  way to stop it for good.
- Refresh: while a live row exists the banner polls with `band-poll` (every 10 s), and the page `router.refresh()`es
  once when it sees the row go `done`, so the new round appears without a reload.
- Where: above the stage rail on `?tab=fixtures` (the desk's run sheet). **[call]** Not on the competition desk
  card in this wave; the division pill's attention model can take a "blocked" attention later.
- Copy in all 4 locales. Phone (320/360/375/390/430), tablet (768/834) and desktop (1280): one column on phones,
  buttons ≥44 px, no horizontal scroll, wraps (no truncation of the reason line).

### 4.7 History

`history-panel.tsx` gets labels for the three new event types (actor null → rendered "Automatically") and for
the existing `stage_auto_advanced` (F2). **[call]** `stage_auto_advanced` keeps recording the scorer whose result
triggered it; its label reads "Stage completed automatically after a result" and shows that person, so the
"Automatically" rule stays "actor is null" with no rewrite of old rows.

## 5. Sequences that must be tested (house rule: test the sequence)

1. Round completes → 60 s → paired. Second round, same. Last round → 60 s → stage completed → proposal drafted →
   60 s → confirmed.
2. A correction 30 s into the window → clock restarts from the correction; pairing uses the corrected result.
3. A void of a decided board in the window → round no longer complete → `waiting`; deciding it again re-arms.
4. Manual **Pair next** inside the window → paired once; the auto row retires; the fire is a no-op.
5. Two triggers at once (sweep + QStash) → exactly one pairing (lease + advisory lock).
6. Abandoned board → `blocked` with the board named; deciding it re-arms.
7. Tie in the proposal → `blocked`; manual confirm retires it.
8. Switch turned on with a round already complete → arms immediately.
9. Switch turned off while pending → row cancelled; nothing fires.
10. A late withdrawal between rounds → Swiss field drops the entrant, pairing proceeds (existing rule) — or blocks
    with the existing refusal if the field falls under two.
11. Another sport (badminton and chess Swiss at least) and an odd field with a bye.
12. Empty case first: switch on, stage with no fixtures generated → nothing arms. Switch on with round 1 still
    unseated shells → nothing arms (round 1 is always by hand).
13. Skip round 3, then correct a round-2 result → round 3 does NOT re-arm; round 4 arms normally.
14. Organiser opens the proposal editor during the countdown → `paused`; edits + Confirm → confirmed once with the
    edits, no `SEEDING_ALREADY_CONFIRMED`; close without confirming → re-armed 60 s; tab closed → released at 30 min.
15. A target with two sources: first source completes → nothing arms; second completes → proposal → arms.
16. Gold on, silver off → silver confirms automatically, gold waits for a person.
17. Division `auto_progress` on + stage `autoPair` on → last round settles with the 60 s grace, not instantly.
18. Completion countdown → **Add a round** → stage stays open, the new round waits.

## 6. Constraints and house rules

- Schema: new migration (greenfield stance), `stage_auto_actions` with RLS by org like its neighbours.
- All four test types (unit, e2e, smoke, regression); scoped local runs only; e2e and smoke via CI.
- OpenAPI drift: the PATCH body and new routes go through the spec.
- Every new user-facing string in all 4 locale dictionaries; regenerate i18n keys.
- UI verified at 1280, 768 and 320 (plus the seven-width e2e matrix), mockups in the sponsor-deals style.

## 7. Left to the builder

Exact column types and index names; whether `rearmAutoActions` lives in its own module (recommended:
`usecases/auto-advance.ts`); the backoff curve; the banner's component split; event-type names if a better house
convention exists.

## 8. Owner actions (outside the code)

- Provision QStash (Upstash) for stg and prod: `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`,
  `QSTASH_NEXT_SIGNING_KEY`. Until then the minute sweep carries it (prod 60–120 s; stg up to 5 min).
