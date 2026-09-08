# Spectator surface — RESUME STATE

> Dedicated state file (owner request 2026-09-05 18:33: "commit and record everything in a
> dedicated state file so that when we start it knows"). A fresh session starts HERE, then
> reads `_INDEX.md` (rulings) and the W1 ledger
> `.superpowers/sdd/2026-09-04-spectator-w1-match-centre/progress.md` (git-ignored, in the
> spectator worktree; its "RESUME HERE" block carries per-task detail). Update this file at
> every handoff; it is committed, the ledger is not.

**Last updated:** 2026-09-08 — **W1 MERGED**.

## Position (read this first)

**W1 is merged.** PR #743, merge commit `60c0615b0` on `main`, 2026-09-08 07:43Z. Branch
`feat/spectator-surface` (tip `ce0830339`) is contained in `main`; the `spectator` worktree
has been reset to the merge commit. Tasks 1–20 all shipped, including 8b, 14b–14d, 15b, the
16a and 16c cosmetic rounds, Task 16's gate, and the whole-branch review — dispositions in
`W1-whole-branch-review-findings.md`.

**How it was verified, because CI could not be the arbiter.** e2e run `34194829130` and then
`34194897523` both passed — all eight jobs, all seven widths. CI never gave a verdict: from
about 06:30Z, every `runs-on: ubuntu-latest` job in this repo died in 2–4 seconds with ZERO
steps recorded (no runner ever allocated), while every `blacksmith-4vcpu-ubuntu-2404` job in
the same runs passed. The identical signature appeared on an unrelated branch
(`docs/entitlements-w4-handoff`) whose CI had been green 16 minutes earlier, which is what
proved it account-wide rather than ours — an Actions spending cap or a GitHub incident. Three
reruns over ten minutes did not clear it. See
[[reference_ci_job_with_zero_steps_never_got_a_runner]].

So the six dead jobs were reproduced locally against the MERGED tree (`origin/main` merged in,
then every gate run): `tsc` clean in web/engine/scripts; eslint 0 errors; OpenAPI, i18n
`gen-keys` and engine schema-snapshot all zero drift; engine boundary and plan-scrub pass;
apps/web **15171 tests, 11600 passed, 0 failed** (4456 suites, 0 failed, all 1177 files inside
the worktree); engine **4363 / 4350 passed, 0 failed**; bench 1187. The security-scan job was
not reproduced and did not need to be — both its steps are `continue-on-error: true`, and this
branch changes no dependency file, so its 42 advisories are pre-existing on main.

**Three CI gates this branch reddened, all fixed before merge** (commits `d04b1339e`,
`ce0830339`):
1. **OpenAPI drift** — the match-centre header gained `phase`/`strength` without a regen.
2. **`z3-retirement-drift`** — a GATE DEFECT, not a missing ledger row. Its scans pass `-a`, so
   `git grep -a -il z3` read our 50 new screenshots as text and 40 matched on random bytes.
   Binary assets are now excluded by extension (`.wasm` deliberately still in scope). This
   branch was the first ever to commit images under a scanned tree. See
   [[reference_git_grep_dash_a_matches_random_bytes_in_binaries]].
3. **`check-vitest-collection`** — working as designed; its explicit file list gained our five
   new `src/server/public-site/__tests__` files, and its two hand-typed counts are now derived
   from that list so one cause reds it once, not twice.

**Post-merge:** the merge pushed to `main`, which is what triggers `e2e.yml` — run
`34200765497` at `60c0615b0`. That is the first e2e over W1 merged with main and is the one to
read before starting W2.

**Deliberately open, carried out of W1** (all three are in the PR body):
- The pad attribution pickers offer BOTH sides (`candidatesForPerson` loops home/away; `role`
  narrows by position, never side), and `action-form.tsx:285` computes each candidate's `side`
  and discards it — so the Bowler picker is a flat, unlabelled ~22-name list of which half are
  invalid, and the refusal is resolved by error code only ("That entry isn't valid for this
  match"), naming no field. Three options were put to the owner (A grouped headers, B inline
  side tag, C filter chip; recommendation A) and NOT yet chosen. Owner call outstanding.
- 228 uncaptioned pad items across 11 sports share the English-in-every-locale defect;
  cricket's eight are fixed, the rest is its own programme.
- The OG card and page title compose the score from different sources — W2, no consent
  exposure (every engine `summary.headline` is numeric).

**Next:** re-pin W2 (`../../plans/2026-09-05-spectator-w2-competition-landing.md`, DRAFT)
against merged `main` before executing — every wave plan is DRAFT until re-pinned after the
wave before it merges.

**Owed documentation:** the bench `_MASTER.md` spectator row still reads "W0 in flight; W1–W4
sequential" — stale since W1 began, and now wrong in the other direction too.

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

## Whole-branch review — 2026-09-07, all four reviewers `needs-fixes`

Full list: `W1-whole-branch-review-findings.md` beside this file. Four Opus reviewers,
read-only, disjoint areas, against `2f3b4f9f4` — which was CI-green 8/8 and unit 523/0
at the time. Everything they found survived ~4,000 passing tests and a full CI run.

FIXING IN THIS ROUND (blocking or one-line):
- B1 the cricket config 500 (the earlier safeParse fix was a no-op — the hard `parse`
  one frame later still threw on the same value) and B2 the uncontained cricket fold.
  Cricket now degrades like every other sport instead of taking the page down.
- P1 `fixture-subheading.ts:55` renders the date in hardcoded en-GB on fr/es/nl.
- S1 `MatchCentreProps.locale` inert (THIRD occurrence of this class on this branch),
  S2 `useLiveFixture.updatedAt` dead, D1 `currentPhaseOf` duplicating `matchPhase`
  (both added by this wave, in the same session).
- T1 `shotAllTabs` silently writes zero screenshots — the vacuous visual gate, in the
  helper the whole R11 sign-off runs through.
- M1/M2 two comments declaring LIVE product defects this branch has already fixed.

QUEUED, NOT FIXED — needs an owner ruling or its own wave:
- B3 masked people's raw person UUIDs reach the anonymous document as testids and React
  keys. Not a one-line fix: needs a stable per-document surrogate id.
- P2 band 2 accepts a run-out credited to a bowler (band 3 refuses the same payload).
- P4 three payload-keyed tallies that can contradict the state-keyed numbers printed
  beside them on the same card.
- P5 duplicate React keys/testids when a super over reuses an innings number.
- The accessibility group (table row headers, tabpanel focus, roving tabindex,
  dangling `aria-controls`, duplicate landmark names).

## OWNER-RECORDED 2026-09-07 — the `sportKey === "cricket"` branch becomes a
## `SportModule` capability, at the FRONT of W2

Owner asked why `match-centre.ts` branches on the sport name instead of using a factory
or strategy. It should: `SportModule` IS the strategy interface, and the non-cricket
path already dispatches through it (`resolveModule` → `buildTimeline({ module })`) with
no sport names anywhere. The branch exists only because `deriveCricketScorecard` has no
slot on that interface.

Measured before answering: it is the ONLY `sportKey === "cricket"` in the entire
public-site tree (two `"cricket"` literals total; the other is a type alias). So this is
one wart, not a spreading pattern — but it has already cost twice: P3 (the branch uses
the cricket SINGLETON and silently drops the division's pinned `moduleVersion`, which
the other branch honours) and B2 (the degrade path had to be hand-written rather than
inherited from the module path).

RULING: add `scorecard?(cfg, events, lineups)` to `SportModule` and let the web layer
resolve the module and ask it. Version pinning comes free, the degrade path is shared,
and the web layer stops knowing sport names. Do it at the FRONT of W2 — W2 adds more
per-sport public surfaces and pays for it immediately. Deliberately NOT in this fix
round: it is an engine interface change touching every module and its conformance
suite, and mixing a refactor into a review-fix round on a green branch makes both
harder to judge.
