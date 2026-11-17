# Chess External Play — execution plan (check-in capacity + Match Day all in one)

Date: 2026-11-17. Status: draft for owner approval.

This file says HOW the four implementation plans are run: order, batches, PRs, models, reviews and gates. WHAT each task builds lives in the plans; this file never restates a step.

| Doc | Role |
|---|---|
| `docs/superpowers/specs/2026-11-05-checkin-capacity-design.md` | Capacity design (owner-approved; §12 = rulings 2026-11-17) |
| `docs/superpowers/specs/2026-11-05-match-day-all-in-one-design.md` | Match Day all-in-one design (owner-approved) |
| `docs/superpowers/plans/2026-11-05-checkin-capacity-1-presence.md` | P1 — webhook presence (V527) |
| `docs/superpowers/plans/2026-11-05-checkin-capacity-2-premint-proof.md` | P2 — `sweep.ts` split, room pre-mint, one-read proof, priced line, paced sweep (V528) |
| `docs/superpowers/plans/2026-11-05-checkin-capacity-3-arbiter.md` | P3 — arbiter participant for the game, check-in/presence gate, loader (V529) |
| `docs/superpowers/plans/2026-11-05-match-day-all-in-one.md` | MD — online rounds inside Match Day, board panel, arbiter page removed |

All four plans were re-pinned against origin/main `c788c6a5f9` and independently reviewed on 2026-11-17. Re-pin again (a scout pass, not a rewrite) if main has moved under a plan's files when its batch starts.

## Model policy

Owner, 2026-11-17, quoted exactly: **"Sonnet Task+Review , Opus for Batch/Whole Review , Opus use Wisely if needed"** (same policy as 2026-11-16: "Sonnet High for Task/Reviewer, Opus for Engine work / Batch / Whole Review").

- Per-task implementer: `implementer-sonnet`, `effort: "high"`. Per-task reviewer: `reviewer-sonnet`, `effort: "high"`.
- Batch review (end of every batch) and whole-PR review (end of every PR): `reviewer` (Opus), `effort: "high"`.
- Opus as a task implementer ONLY for the six critical tasks below (migration, locking, security, revocation). Their per-task review stays Sonnet; the batch review on Opus covers them again.
- Fix loop: findings go back to a FRESH Sonnet implementer with the review file; re-review by Sonnet. Round 3 still red → escalate that task's implementer to Opus.
- Scouts (re-pins, "where is X"): `scout` or Explore, Sonnet.
- Every dispatch passes `model` and `effort` explicitly.

| Task | Implementer | Why Opus |
|---|---|---|
| P1 T2 — the two tables (V527, sealed) | **Opus** | data migration, sealed-table policy |
| P1 T4 — signature verification and key cache | **Opus** | security: the only gate on a public route |
| P2 T1 — migration (V528: unadopted stamp, stay price, `camera_live_first_at`, `token_issued_at`) | **Opus** | data migration on live video tables |
| P2 T7 — the line's stamped price | **Opus** | locking + reservation arithmetic across machines |
| P2 T8 — sweep: revocations first, the cap, the deferral | **Opus** | revocation timing (safeguarding), vendor-outage guard |
| P3 T1 — one participant per (organizer, meeting), floor, refusal (V529) | **Opus** | migration + unique index + 23505 + token exposure |
| Every other code task (32) | Sonnet, high | — |

## Order, batches and PRs

Three PRs, in this order. PR 1 is separate because the design makes the split a pure move of its own; PR 3 is separate because it is the UI surface that needs per-screen owner sign-off. Everything in PR 2 ships dark behind `EXTERNAL_PLAY_PREMINT` and `EXTERNAL_PLAY_PRESENCE_PROOF`.

| Batch | Tasks | Count | PR | Branch / worktree |
|---|---|---|---|---|
| B0 | P2 T0 — split `sweep.ts` (pure move behind the barrel) | 1 | **PR 1** `refactor/sweep-split` | `~/github/seazn.club-worktrees/sweep-split` |
| B1 | P1 T1–T5 — fixture webhooks, tables, parser, signature, presence store | 5 | **PR 2** `feat/checkin-capacity` | `~/github/seazn.club-worktrees/checkin-capacity` |
| B2 | P1 T6–T10c — receiver, route, registration, shadow report, walkthrough, smoke, retention, load webhooks | 8 | PR 2 | same |
| — | P1 T11 — baseline load run on today's code (operator) | run | — | local, before B3 |
| B3 | P2 T1–T5 — migration, unadopted rooms, re-open, pre-mint pass, cron job | 5 | PR 2 | same |
| B4 | P2 T6–T10 — one-read proof, line price, sweep, passing fix, walkthrough | 5 | PR 2 | same |
| B5 | P3 T1–T3 — arbiter participant + gate, browser chains, loader | 3 | PR 2 | same |
| — | P1 T12 + P2 T11 — staging: webhook live, real-Cloudflare gate, flags on (operator) | run | — | after PR 2 is on staging |
| B6 | MD T1–T5a — types, view, focused board, attentions, online night, the freeze's server guard | 6 | **PR 3** `feat/match-day-online` | `~/github/seazn.club-worktrees/match-day-online` |
| B7 | MD T6–T10 — shell, round panel, board panel, cameras, arbiter page removed | 5 | PR 3 | same |
| — | P3 T7 — final load run and the Redis decision (operator) | run | — | after PR 3 on staging |

Totals: 38 code tasks in 8 batches, 4 operator runs, 3 PRs, 8 batch reviews, 3 whole-PR reviews.

Dependencies that force the order: PR 1 merges before B1 starts (P1 T10b adds a call in the sweep that must land in `sweep/run.ts`). P1 T11 must measure today's code, so it runs before B3 changes the seat. B5 consumes P1's presence readers and P2's `linePool`. PR 3 consumes P3's `ArbiterSideMeeting.joinable`, `arbiterSideAdmits`, `sideWatchable`, `rejoinAfterPoll`; PR 2 merges before B6 starts. Batches never run in parallel (they share the seat, line and sweep files); tasks inside a batch run one at a time.

## Per-task loop

1. Orchestrator writes `task-<id>-brief.md` (the five things: exact files, acceptance criteria from the plan task, what not to touch, the scoped verify command, output cap "final message under 15 lines").
2. Implementer builds in the PR's worktree, `cd <abs worktree> &&` prefixed on every command, commits per the plan's commit lines, writes `task-<id>-report.md` with RAW counts (vitest JSON `numPassedTests`/`numTotalTests`, resolved `.testResults[].name`, `EXIT=$?`).
3. Per-task reviewer reads the diff and the plan task, writes `task-<id>-review.md`. Fix loop as above.
4. Orchestrator re-runs the task's scoped gate itself before marking it done in `progress.md`.

Batch end: Opus `reviewer` reads the batch's whole diff against the plans and design, writes `batch-<n>-review.md`; fixes by a fresh Sonnet implementer; re-review. Then a status table to the owner.

PR end: Opus whole-PR review → fixes → scoped gates re-run three times for anything flaky-shaped → owner screenshots where UI (PR 3: 320 / 768 / 1280, per-screen verdicts) → open the PR → one e2e dispatch (`workflow_dispatch` with `--ref` the branch) → merge only on the owner's word.

## Gates (house rules, stated once)

- Scoped tests only: the vitest files, spec and walkthrough covering the changed files. Never the full suite, full tsc or full e2e locally.
- vitest: `cd apps/web && npx vitest run <paths> --reporter=json --outputFile=<ledger>/<task>.json; echo EXIT=$?`. Green = `numFailedTests: 0`, `numTotalTests` > 0, EXIT=0, and every expected file in `.testResults[].name`.
- Lint: `rtk proxy npm run lint` and read `✖ N problems`.
- DB suites need a fresh, fully migrated test DB (`seazn-local-env` skill; `sync:sports` after `db:apply`).
- Every new guard is mutated once (TEST-STRATEGY.md); every sweep reports its checked count; sequence cases (second call, reload, re-pair, other flag state).
- UI (PR 3): all of `e2e/mobile/`, never a `-g` slice; four dictionaries; no horizontal scroll at 320.
- Migrations V527 / V528 / V529 renumbered at merge if main moved. Each PR body flags its migration LOUDLY.

## Operator runs

| Run | When | Pass condition (defined in the plan, not here) |
|---|---|---|
| P1 T11 baseline | before B3 | recorded: calls/board, seat p50/p95, `lockWaitMs` p95, busy count |
| P1 T12 staging gate | PR 2 on staging; owner adds the zone WAF skip rule and registers the webhook | P1 T12 step 5 (real Cloudflare); **`closedByEnded` = 0 or the proof flag stays off** |
| P2 T11 staging rollout | after the gate | pre-mint flag first, then proof flag, per P2 T11 |
| P3 T7 final load | PR 3 on staging | compared with the baseline; decides Redis (design §7) |

Owner-only items: the Cloudflare zone skip rule, the webhook registration on staging and production, and every flag flip in production.

## Ledger

`/Users/ashokhein/github/seazn.club/.superpowers/sdd/2026-11-17-chess-external-play/` in the MAIN checkout (a worktree's ledger dies with the worktree): `progress.md`, `decisions.md`, `task-<id>-{brief,report,review}.md`, `batch-<n>-review.md`, `pr-<n>-review.md`, gate JSON. Write state as it happens.

## Match Day rulings (owner, 2026-11-17, "apply rec")

Recorded in the Match Day design's "Amended 2026-11-17" section and applied in the MD plan:
O1 a cancelled board is listed only while a flag is open, under "Needs a decision"; O2 the division page's Held | Flagged queue stays, same source, Match Day primary; O3 the code's day read leaves online divisions out; O4 online boards follow Match Day's billing-freeze rule.
