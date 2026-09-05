# Spectator surface — RESUME STATE

> Dedicated state file (owner request 2026-09-05 18:33: "commit and record everything in a
> dedicated state file so that when we start it knows"). A fresh session starts HERE, then
> reads `_INDEX.md` (rulings) and the W1 ledger
> `.superpowers/sdd/2026-09-04-spectator-w1-match-centre/progress.md` (git-ignored, in the
> spectator worktree; its "RESUME HERE" block carries per-task detail). Update this file at
> every handoff; it is committed, the ledger is not.

**Last updated:** 2026-09-05 18:35 London (deadline handoff in progress — see "In flight").

## Where things live

- Branch `feat/spectator-surface`, worktree `.claude/worktrees/spectator` (locked). Base
  `11a1407f1` (origin/main at rebase). NOT pushed, NO PR — the owner has not asked for one.
- Design of record: `../2026-09-04-spectator-surface-design.md`. Rules: `_RULES.md`.
  Rulings/false premises: `_INDEX.md`. Design system: `_DESIGN.md` (being written).
- Plans: W1 `../../plans/2026-09-04-spectator-w1-match-centre.md` (18 tasks, executing);
  W2 `../../plans/2026-09-05-spectator-w2-competition-landing.md` (DRAFT, 19 tasks);
  W3 `…-w3-poster.md`, W4 `…-w4-gallery.md`, W5 `…-w5-public-team-page.md` (DRAFTS being
  written 2026-09-05 by Fable planning agents; present only if their agents finished — see
  "In flight").
- Git in the worktree: plain `/usr/bin/git <verb> …`, one command per call; commit with
  `commit -o <paths>` from the worktree ROOT (the shell cwd persists between calls and a
  subdirectory cwd makes `-o` paths fail with "pathspec did not match").

## W1 execution state (subagent-driven; Opus implementer/reviewer)

| Task | State | Where |
| --- | --- | --- |
| 1–4 engine scorecard fold | complete, reviewed | branch |
| 5 schema + public lineups | complete, reviewed | branch (cherry-pick 4afd441fc) |
| 7 timeline/sets builders | complete, reviewed | branch (lane C picks) |
| 10, 11 shell + summary tab + live-score localisation | complete, reviewed | branch (lane B picks) |
| 12, 13 scorecard / commentary / timeline / sets / info tabs | complete, reviewed | branch (lane C picks) |
| 17 engine enriched band-2 lines | merged 514bd2176; fix round 1 = 1a1849454 (snapshot + golden corpus); scoped re-review IN FLIGHT | branch |
| 6 `buildMatchCentre` | IN FLIGHT, isolated worktree `agent-af7842db778895abe` (reset to b8ed8fa31) | not on branch |
| 8 dictionaries + coverage test | IN FLIGHT, isolated worktree `agent-a733c4deec73194d4` (reset to b8ed8fa31) | not on branch |
| 18 pad More sheet + first line e2e | IN FLIGHT, isolated worktree `agent-a749a9f65817abaa0` (reset to 514bd2176); env label `t18` (down it if `seazn-env status` lists it) | not on branch |
| 9 API + realtime | not started (after 6; adds the Task-6-exports ⊆ dictionary-keys parity test) | — |
| 14 page wiring | not started (after 6, 8, 9; retires `BUILDER_ONLY_KEYS`) | — |
| 15 walkthrough e2e | not started (owes the public-page assertion of Task 18's enriched line; testids `mc-over-<innings>.<over>`, `mc-ball-<innings>.<over>.<ball>`) | — |
| 16 gates + R11 visual sign-off + final review + `_INDEX.md` | not started | — |

Integration already done on the branch: lane B (7 commits) and lane C (14 commits) were
CHERRY-PICKED (never merged — lane branches carry copies of each other's commits), the four
`public.json` files resolved by KEY UNION, `i18n-keys.ts` regenerated once (b8ed8fa31).
Verification on b8ed8fa31: public-site suites 537/0 (26 pending = DB suites on empty
`DATABASE_URL`), apps/web tsc 0, i18n parity OK; engine cricket + testkit gates 527/527 on
1a1849454.

## How to finish an in-flight lane after a session loss

1. `/usr/bin/git worktree list` → the lane's worktree path and `worktree-agent-*` branch.
2. In that worktree: `/usr/bin/git status --porcelain` and `/usr/bin/git log --oneline -3`
   (base b8ed8fa31 or 514bd2176). A dirty tree = the implementer died mid-task; a commit
   beyond the base = done or WIP (read the message). The task report in
   `.superpowers/sdd/2026-09-04-spectator-w1-match-centre/task-<N>-report.md` exists only
   if the implementer finished (a "Resume" section means a deadline WIP commit).
3. Resume the task with a FRESH implementer (Opus) pointed at the brief
   (`task-<N>-brief.md`), the contract notes (Task 6: `task-6-contract-notes.md`), the
   lane worktree, and the WIP state; then task review; then cherry-pick onto the feature
   branch (dictionary conflicts → key union; regenerate `i18n-keys.ts`; run
   `pnpm exec tsc --noEmit -p tsconfig.json` in `apps/web` — a zod `.default()` makes a
   field REQUIRED on the output type and breaks fixtures silently under a green suite).
4. Order after that: 9 → 14 → 15 → 16. Before the PR: rebase onto main, regenerate
   `i18n-keys.ts` and require ZERO diff, register `w0-spectator-capture.spec.ts` and the
   W1 walkthrough spec in main's `WALKTHROUGH_SPECS` inventory (PR #723) in the same
   commit, take a pre-merge e2e signal via `workflow_dispatch` `pr` input, and hold the
   merge while main's walkthrough leg is red.

## Wave planning state (Fable planning agents, docs only)

- W2: DRAFT plan committed (f0d06b1f1); prompt `W2-landing.md` carries the plan section and
  three owner questions with recommendations (`mh-*` testids; count leaders now + one
  additive engine `leaderboards` declaration for ratio leaders; org-home poll-only).
- W3, W4: plans + prompt sections being written (agents in flight at 18:35).
- W5: CANDIDATE DRAFT plan with a design section + new prompt `W5-team-page.md` being
  written (agent in flight). W5 is NOT ruled in scope.
- `_DESIGN.md` + theme sheet being written by the design agent; phase 2 (per-wave "Design
  theme" sections in prompts and plans) not started.
- `_INDEX.md` single-pass update (plans list, wave rows, design pointer) pending the above.

## Open owner questions (recommendations recorded in `_INDEX.md` / the ledger)

1. W2: testid prefix `mh-*` (spec) — recommend keep.
2. W2: ratio leaders need an engine `leaderboards` declaration — recommend permit (additive).
3. W2: org-home liveness poll-only — recommend yes.
4. W5: in scope or not — plan drafted as a candidate for a ruling.
5. Any "proposed" token in `_DESIGN.md` — owner rules; existing tokens are cited, not changed.

## In flight at the deadline handoff (fill in at 18:58)

_To be completed at the deadline: for each agent still running, its worktree, dirty files,
WIP commit (if any), and the exact next step._
