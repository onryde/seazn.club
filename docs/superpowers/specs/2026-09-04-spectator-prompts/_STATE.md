# Spectator surface — RESUME STATE

> Dedicated state file (owner request 2026-09-05 18:33: "commit and record everything in a
> dedicated state file so that when we start it knows"). A fresh session starts HERE, then
> reads `_INDEX.md` (rulings) and the W1 ledger
> `.superpowers/sdd/2026-09-04-spectator-w1-match-centre/progress.md` (git-ignored, in the
> spectator worktree; its "RESUME HERE" block carries per-task detail). Update this file at
> every handoff; it is committed, the ledger is not.

**Last updated:** 2026-09-06 00:0x London.

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
| 17 engine enriched band-2 lines | complete, reviewed (514bd2176 + fix 1a1849454: snapshot regenerated, golden corpus 28→30 streams) | branch |
| 6 `buildMatchCentre` | implementer DONE (lane commit 1a88e8bc6 in `agent-af7842db778895abe`); task review IN FLIGHT; NOT yet cherry-picked | lane |
| 8 dictionaries + coverage test | implementer DONE (lane commits c1bf271f3 + 58a74f982 in `agent-a733c4deec73194d4`); review = Needs fixes → fix round 1 IN FLIGHT (result keys by engine METHOD `regulation/dls/innings/super_over/boundary_count` + tie/no_result/draw with `{winner}` `{margin}`; `GLYPH_KINDS` derived from the classes map; parity both ways) | lane |
| 18 pad More sheet + first line e2e | implementer DONE_WITH_CONCERNS (lane commit ea888772b in `agent-a749a9f65817abaa0`; env t18 down); review IN FLIGHT. PRODUCT FINDING: the player-line post-phase panel is unreachable — the console unmounts the pad the instant a fixture is `decided` — so band-2 player lines cannot be entered through the product today; the new e2e is red for that reason. OWNER DECISION NEEDED: allow the minimal organiser-console mount fix in this wave (recommended) or accept Tasks 17–18 as API-only until the pad programme fixes it. | lane |
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
- RULING 2026-09-05 23:2x (binds Tasks 6 and 8): result message keys follow the engine's `outcome.method` vocabulary plus non-win outcomes — `matchCentre.result.{regulation,dls,innings,super_over,boundary_count,tie,no_result,draw}` — params `{winner}` + `{margin}` (engine margin string verbatim, never parsed).
- W3: DRAFT plan written (`…-w3-poster.md`, 10 tasks) + prompt section; owner questions Q1 fonts (static TTFs), Q2 title sponsor on free orgs (keep rule), Q3 `describeFormat`/`division.config` ownership vs W2 (W3 builds to W2's contract if W2 unmerged).
- W4: DRAFT plan written (`…-w4-gallery.md`, 12 tasks) + prompt section; 6 owner questions (consent gate — neither consent source can express "declined"; `assets` bucket + prefix; new table not a post kind; ride W1/W2 documents for liveness; testids `gl-*`; plan-tiered quota recorded not built).
- W5: CANDIDATE DRAFT plan (9 tasks, option A) + prompt `W5-team-page.md` committed (56c0cd1ca). NOT ruled in scope.
- `_DESIGN.md` verified + corrected (team colours EXIST: `team_display_v.colors` reaches the public payload unread) and committed (481f510a5); theme sheet published: https://claude.ai/code/artifact/45c81708-095d-458c-b49f-b471e2901415. Phase 2 (per-wave "Design theme" sections in prompts and plans) IN FLIGHT.
- `_INDEX.md` single-pass update DONE (plans list, waves line, status rows, design + state pointers).

## Open owner questions (recommendations recorded in `_INDEX.md` / the ledger)

1. W2: testid prefix `mh-*` (spec) — recommend keep.
2. W2: ratio leaders need an engine `leaderboards` declaration — recommend permit (additive).
3. W2: org-home liveness poll-only — recommend yes.
4. W5: in scope or not — plan drafted as a candidate for a ruling.
5. Any "proposed" token in `_DESIGN.md` — owner rules; existing tokens are cited, not changed.

## In flight at 23:3x (post-outage)

- Task 6 review; Task 8 fix round 1; Task 18 implementer (resumed); W4 plan (Opus, new); W5 prompt + plan verification (Opus); design verification (Opus). Next after they land: cherry-pick Tasks 6, 8, 18 onto the feature branch (union dictionaries, regenerate keys, tsc), commit the W4/W5/_DESIGN docs, `_INDEX.md` single-pass update, design phase 2, then Task 9.
