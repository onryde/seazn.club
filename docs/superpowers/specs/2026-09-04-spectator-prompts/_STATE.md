# Spectator surface — RESUME STATE

> Dedicated state file (owner request 2026-09-05 18:33: "commit and record everything in a
> dedicated state file so that when we start it knows"). A fresh session starts HERE, then
> reads `_INDEX.md` (rulings) and the W1 ledger
> `.superpowers/sdd/2026-09-04-spectator-w1-match-centre/progress.md` (git-ignored, in the
> spectator worktree; its "RESUME HERE" block carries per-task detail). Update this file at
> every handoff; it is committed, the ledger is not.

**Last updated:** 2026-09-06, after the second cosmetic round (16c) and a second rebase.

## Position at the last handoff (read this first)

Branch `feat/spectator-surface` in the `spectator` worktree. Tip when this was written:
`fa61b23a9`, rebased onto `origin/main ac85c705f` (105 commits replayed, one conflict — a
"Last updated" line in the bench `_MASTER.md`). Tree clean.

**Done, reviewed, on the branch:** Tasks 1–20, including 8b, 14b–14d, 15b, the 16a cosmetic
round (C1–C6) and its fix round, and `ac3d49ca2` (an OpenAPI regen that 16a owed and skipped
— a public schema field had been added without running `openapi:gen`, which CI checks).

**In flight at the handoff:** the scoped review of 16c (cosmetics C7–C10), diff
`review-ac3d49ca2..7681cb8b6.diff`, verdict due in `task-16c-review.md`. 16c's six commits sit
in lane `agent-a4b308f799056d2c2` and are NOT yet on the branch — cherry-pick them after the
review clears.

**Then, in order:**
1. Cherry-pick 16c, verify on the merged tree (scoped suites + tsc + `i18n:gen-keys` and
   `openapi:gen` for zero drift — 16c touched a public schema, so the regen is owed again).
2. Rule on 16c's found-not-fixed item: `sets-tab.tsx`'s panel caption carries the same
   kind-vs-unit defect as C8 one level down (badminton and table tennis would show a "Sets"
   heading over "Game" columns). Leaning fix-now — C8 exists because the vocabulary was wrong,
   and the same defect one level down would ship knowingly.
3. Task 16, the gate, in the spectator worktree with no other implementer active: contract
   notes in `task-16-contract-notes.md`. Fresh `t16` env; `seazn-env gate`; full `apps/web` and
   `packages/engine` vitest with the DB, judged on JSON totals; the WHOLE `mobile.spec.ts` per
   project (a serial file's failure count is a floor); the walkthrough project; cricket-lines,
   football and scorepad-skins e2e; smoke. Then R11: read ALL 50 screens against `_DESIGN.md`
   §9 and write the per-screen verdict table into the design doc under "W1 sign-off — per-screen
   verdicts". Strengthen `public-isr-contract.test.ts` to assert `dynamic` is absent (one line).
4. Final whole-branch review — Opus, on the settled diff, slim package of
   `origin/main..feat/spectator-surface` excluding generated JSON, goldens and PNGs. ONE fix
   dispatch, one scoped re-review, residuals adjudicated.
5. Report to the owner. **NO PR until the owner says so.**

**Owed documentation before the PR:** the bench `_MASTER.md` spectator row still reads "W0 in
flight; W1–W4 sequential" — stale since W1 began.

**OPEN FOLLOW-UP — the DLS revised target is invisible to a spectator.** Ruled 2026-09-07
(product owner, during the gate): NOT a gate item and not fixed in W1, because unlike the
shootout sentence — where the engine had the fact and the page dropped it — this number has
never been surfaced at all. It is a feature needing a design decision, not a defect.

What was found by driving a real DLS match (Hundred format, 150/0 off 100 balls, rain cutting
the chase to 50 balls, revised target 84, chase all out 60): the board reads "Kings won by 23
runs (DLS)" above scores of 150 and 60, and nothing anywhere explains how 150 v 60 is a
23-run win. The target is what explains it. It is missing in BOTH states, for different
reasons:
- LIVE: `live.target` exists on the card but is only used as a GATE in
  `matchCentre.chase.need` ("{side} need {runs} to win") and never printed — so a spectator
  cannot tell a revised target from an original one.
- DECIDED: `target` lives on the card's `live` block, which is null once the match ends, so
  the number is not reachable from where `buildHeader` reads at all. Surfacing it there needs
  `revisedTarget`/`targetSource` carried out of the fold onto the card — an engine change.

Two changes, then, not one. Whoever picks this up should decide first WHERE it belongs (the
chase line, an Info row, or both) rather than starting from the plumbing.

**Findings to carry into the PR body:** band-2 player lines were never submittable through the
product (two stacked defects, both fixed); the cricket skin's `buildDock` has no "Send now" for
non-ball events; `usecases/exports.ts` reads `colors->>'primary'`, a key nothing writes, so the
fixtures CSV colour columns are always empty; `schedule.tsx:256` is spectator-facing text at
≈2.87:1 (queued for W2); `term.bat` / `term.bowl` want a native-speaker pass. Take the pre-merge
e2e signal via `workflow_dispatch` with the `pr` input — `e2e.yml` triggers on push to `main`
only, so a PR gets no automatic e2e signal, ever.

**Design artifacts** are listed in `_INDEX.md` under "Design artifacts". All three now publish
without the `downloads` capability (owner request 2026-09-06), so the W0 canvas's Export PNG/PDF
buttons are inert by design — do not "fix" them.

## Where things live

- Branch `feat/spectator-surface`, worktree `.claude/worktrees/spectator` (locked). REBASED onto
  origin/main ca016e25c on 2026-09-06 (86 commits, no conflicts; keys/OpenAPI regenerate with
  zero drift; tsc clean; engine gates 594/594). NOT pushed, NO PR — the owner has not asked for one.
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
| 6 `buildMatchCentre` | complete, reviewed (3 fix rounds); cherry-picked as 1dced1192 557e967d0 d70675739 85297f5e0. Follow-up 8b (14 builder keys ×4 locales) complete + reviewed: 8e9e8cc8d; coverage test green | branch |
| 8 dictionaries + coverage test | complete, reviewed; cherry-picked onto the branch as 45ed8c2e9 edd8de9d0 d1c333e5f (result keys by engine METHOD + tie/no_result/draw with `{winner}` `{margin}`; `GLYPH_CLASSES` single source; parity both ways). Branch verified: public-site 545/0, tsc 0, i18n parity OK | branch |
| 18 pad More sheet + first line e2e | complete, reviewed; cherry-picked as 57793bf53 cab4536d3 c14c76e50 (eight labels ×4 locales; line-entry e2e `test.fixme` until the console mount fix — OWNER DECISION 1 open; public-page assertion owed to Task 15). Branch verified: scorepad 2556/0, engine 400/400, tsc 0 | branch |
| 9 API + realtime | complete, reviewed; cherry-picked as e5a053034 (`match-centre-load.ts` loader for both call sites; parity test; OpenAPI response schema added). Branch verified: public-site 575/0, tsc 0, parity OK, zero regen drift | branch |
| 14 page wiring | complete, reviewed (approved with owed items); cherry-picked as 061d87f19; follow-ups 14b (reviewed), 14c (metadata + set scoreboard words; reviewed in the final review) and 14d (55b7fffa3: ISR RESTORED on the fixture page — `?tab=` read client-side under Suspense; unit enum test; review in flight) DONE — no hardcoded English left except the OG image's baked "VS" (spec: untouched) | branch |
| 15 walkthrough e2e | complete, reviewed (two fix rounds): two walkthrough files 7/7 + 11/11 at CI's --workers=3, mobile ×7, smoke marker, 48 screens committed, WALKTHROUGH_SPECS registered, W0 harness deleted; two product defects found and fixed in 15b | branch |
| 16 gates + R11 visual sign-off + final review + `_INDEX.md` | 16a cosmetic round IN FLIGHT (C1–C5 from the orchestrator's read of the screens: desktop tables stretched, unlabeled innings sections, duplicate status word, bold zeros, top-performer labels); gates (16b) + final review after Task 15's re-review and 16a land; notes `task-16-contract-notes.md`, `task-16-cosmetics.md` | lane |
| 19 console mount fix (owner ruling 17) | complete, reviewed (approved with owed teardown — confirmed down); cherry-picked as 28d18cce8; mount fix live-proven; the line-entry e2e stays fixme'd until Task 20 | branch |
| 20 single-aspect player lines (product-owner ruling, same goal as 17) | complete, reviewed (1 fix round); cherry-picked as 443fea686 f0d1d453f — the line-entry walkthrough passes for real (3 cases); `PadField.group` in the engine; no schema/reducer change | branch |

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
- `_DESIGN.md` verified + corrected (team colours EXIST: `team_display_v.colors` reaches the public payload unread) and committed (481f510a5); theme sheet published: https://claude.ai/code/artifact/45c81708-095d-458c-b49f-b471e2901415. Phase 2 DONE: `## Design theme` sections in W1–W5 prompts + a Design bullet in each draft plan. Ruling recorded: team colour = `colors.home_primary` (not `colors.primary`, a key nobody writes) through the contrast guard, then the division-hue wheel, then neutral — one resolver in W2.
- `_INDEX.md` single-pass update DONE (plans list, waves line, status rows, design + state pointers).

## Open owner questions (recommendations recorded in `_INDEX.md` / the ledger)

0. RULED 2026-09-06: team colour source confirmed (ruling 15); W5 in scope (ruling 16). OPEN: Task 18's console mount fix (recommended approve).
1. W2: testid prefix `mh-*` (spec) — recommend keep.
2. W2: ratio leaders need an engine `leaderboards` declaration — recommend permit (additive).
3. W2: org-home liveness poll-only — recommend yes.
4. W5: IN SCOPE (ruling 16); ten prompt questions carry recommendations.
5. Any "proposed" token in `_DESIGN.md` — owner rules; existing tokens are cited, not changed.

## In flight at 23:3x (post-outage)

- Task 6 review; Task 8 fix round 1; Task 18 implementer (resumed); W4 plan (Opus, new); W5 prompt + plan verification (Opus); design verification (Opus). Next after they land: cherry-pick Tasks 6, 8, 18 onto the feature branch (union dictionaries, regenerate keys, tsc), commit the W4/W5/_DESIGN docs, `_INDEX.md` single-pass update, design phase 2, then Task 9.
