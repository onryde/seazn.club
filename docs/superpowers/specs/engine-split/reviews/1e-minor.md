# Engine split — 1e-M (fold version MAJOR/MINOR) review (Opus, task + batch)

Range `115b7b573..cfa8deba1` (5 commits). Reviewed 2026-10-15. Saved by the orchestrator (the reviewer cannot write repo files).

## Verdict: NEEDS FIXES

Guard code correct and fails closed; 18/18 mutants killed; ledger exact. The docs' headline minor example (a changed default `pointsMap`, re-baselined) cannot produce a minor: the golden replay's config-subset pin reds (`cfg.pointsMap.*[0]: recorded 2, replayed 3`), and the only green routes (laundering configs, re-recording) are majors. Changing an existing default VALUE is always a major. Owner decision (F1).

## Premise: "deltas only ⇒ the phone is unaffected"

True for every consumer today, by convention. No pad code reads `standingsDelta`/`supportsDraws`/`@seazn/engine/competition`; server callers (`engine-db/append-event.ts:521`) and organiser UIs only (`stages-panel.tsx`, `bracket-panel.tsx`, `forfeit-dialog.tsx:118` — organiser-only, `pad-host.tsx:1301`). An award's summary reads `forfeitCredit` (`core/events.ts:205`) — a credit change reaching the summary is a major (walkthrough c2); a non-displayed metric (`points_won`) is a minor (c). Invisible to both classes: mid-match summaries (golden records `summary(finalState)` only, `golden.ts:221`; pad recomputes live, `use-pad-pipeline.ts:1260-1262`), kernel overlays, player-stats folds (`src/stats/stats.ts` in the phone closure; rendering on phone unverified).

## Findings

| # | sev | file:line | problem | fix |
|---|---|---|---|---|
| F1 | MAJOR | spec `:623` (D34); `GOLDEN-POLICY.md:128-130,161-165` | Headline minor case impossible: all 11 modules embed `cfg` in state; REBASELINE splices recorded cfg (`golden.ts:1144`); replay config pin (`golden.ts:1758-1781`) reds. D34 self-contradicts (moved state = major). | Owner: (i) correct docs to real minors (`standingsDelta`/`supportsDraws` code, credit on non-displayed metrics, a default that only ADDS a key); a changed default value is a major. Or (ii) module-declared server-only config keys tolerated by the state pin (new work). |
| F2 | MINOR | `GOLDEN-POLICY.md:130-131` | "must not be paid with a major" but guard accepts it (`fold-epoch-guard.ts:220`, test `:182-188`) | "need not, unless the same PR owes a manual major" |
| F3 | MINOR | GOLDEN-POLICY "What the guard cannot see" | omits mid-match summaries, player stats | add bullet: manual major |
| F4 | MINOR | `fold-epoch.ts:7-8` | "only the server computes deltas" is an assumption in a comment; `standingsDelta` is in the `./sport` closure | write into S2 handoff/contract: phone must not compute or render `standingsDelta`/`supportsDraws`/non-headline credit; else revisit D34 |
| F5 | MINOR | 1f `capture-s2-handoff.md:106-110,127` | stale once 1e-M merges | second-to-merge rewrites: send MAJOR; deltas-only → `FOLD_MINOR`; harness-only state rewrites still major |
| F6 | MINOR | spec §8 `:393-410` | semver table / 2b changeset rule name `FOLD_EPOCH` only | add `FOLD_MINOR` line (owner) |

## Fail-open hunt: nothing fails open

states+deltas → major (`fold-epoch-guard.ts:136`); config changed with identical outputs → removed+added → major; mixed streams → major wins; minor never settles major; pair only goes up; introducing-PR baseline reads 0 and the tree must declare `FOLD_MINOR` (M9); key-set drift blocked by type + load check (M10).

## Mutants: 18/18 killed

M1 deltas-as-major 15 · M2 summary dropped 5 · M3 per-state compare dropped 5 · M4 minor precedence 2 · M5 minor-down removed 4 · M6 `>`→`>=` 11 · M7 `!majorRose` dropped 5 · M8 minor settles major 10 · M9 tree needn't declare 1 · M10 key-set check removed 1 · M11 `<0`→`<-1` 1 · M12 missing baseline minor = 1 → 3 · M13 removed owe no major 14 · M14 config dropped from input 7 · M15 `foldMinorOf` reads `FOLD_EPOCH` 4 · M16 not frozen 1 · M17 integer check dropped 1 · M18 unnamed sport minor = 7 → 1.

## Walkthroughs

- (a) badminton default `pointsMap` 2→3 + REBASELINE: guard says minor owed, but golden replay RED (F1).
- (a2) default key ADDED (`"2-1":[3,1]`): deltas-only 10 streams, replay green; minor owed → bumped → exit 0.
- (b) `cap` 30→31 laundered via configs: minor only → `major owed … FOLD_MINOR 0 -> 1 does not stand in`; major → exit 0.
- (c) set-kernel credit +1 point per credited set: deltas-only in badminton/tabletennis/volleyball; minors → exit 0.
- (c2) football `goalCredit(awardScore+1)`: summary + deltas; minor only → major owed; major → exit 0.

## Packaging, merge-tree, tests, ledger

`FOLD_MINOR`/`foldMinorOf` via `src/sport/index.ts:7`; boundary 47 modules PASS; dist `.d.ts` declares both, `fold-epoch.js` import-free, frozen, 11 keys. Merge-tree clean vs 1f `45c5bc0a6`, golden floor `e8a819460`, main. CI-way 123/123 (53+57+13). ESLint ignores `packages/engine`. Ledger 93 → 123, 30 added = ledger set, 0 retired.

## Four questions

Second call pure (`(2,4)→5`). Empty `FOLD_MINOR` → exit 2; baseline without → 0; zero streams → exit 2. Withdrawal/void overlays unrecorded → manual major (F3). Each sport its own pair; all 11 swept.

## Resolution

Controller-relayed ruling 2026-10-15 on F1: option (i), correct the docs, no server-only-config-keys work. Docs and one code comment only; the guard, the table and the tests' assertions are unchanged.

- **F1 (MAJOR): fixed.** D34 (spec `:623`) and GOLDEN-POLICY no longer offer a changed default `pointsMap` as a minor. They state that every module embeds its config in state, so changing an existing default VALUE moves states and is a **major**, that the replay reds on it (`cfg.pointsMap.*[0]: recorded 2, replayed 3`) and `REBASELINE_GOLDEN` cannot land it, and list the real minors: `standingsDelta` / `supportsDraws` code; credit on a metric that is not displayed (the set kernels' `points_won` credited by a forfeit; a credit the summary reads, football's `goalCredit`, is a major); a default that only ADDS a key. A division's own organiser-set config never owes a version change. **My implementer walkthrough (a) was wrong:** it ran the re-baseline and compared the corpus bytes, but never ran the plain golden replay afterwards, so it recorded a minor that cannot be landed. Re-run in a scratch worktree on `cfa8deba1`: (a) `pointsMap` `*` `[2,0]`->`[3,0]` + re-baseline: plain replay RED (`PASS (11) FAIL (1)`, as the review found); (a2) default gains `"2-1":[3,1]` + re-baseline: configs and events identical, states/outcome/summary byte-identical on 15/15, deltas differ on 10, plain replay 12/12 green, guard exit 1 `minor owed ... raise FOLD_MINOR.badminton to 1`, minor bumped exit 0; (c) set-kernel forfeit credit `+ 1` per credited set + re-baseline of badminton, tabletennis, volleyball: states/outcome/summary byte-identical, deltas differ on 1 forfeit stream per sport, plain replay green for all three, guard names those three sports as `minor owed`, minors bumped exit 0. No test title or witness claimed a `pointsMap` default as a minor (the CLI tests write the deltas change by hand; the only `pointsMap` witnesses are the 1e laundering tests, which correctly owe a major), so no test changed; the `moveDeltas` helper's comment now says what it stands in for and that a changed default value is not one of the shapes.
- **F2: fixed.** "must not be paid with a major bump" is now "need not be paid with a major bump, unless the same PR owes a manual major".
- **F3: fixed.** "What the guard cannot see" gains two bullets, mid-match summaries and player-statistics folds (`src/stats/stats.ts`), each a manual major. They are added after the last existing bullet, clear of the lines the golden-floor branch rewrites.
- **F4: fixed.** The `fold-epoch.ts` header states the assumption as a contract: a phone must not compute or render `standingsDelta`, `supportsDraws` or credit on a metric the summary does not show; `standingsDelta` is in the `./sport` closure so no type stops it; if a phone ever does, D34 is to be revisited. The capture S2 handoff is not touched here.
- **F5:** handled on the 1f branch, skipped.
- **F6: fixed.** Spec §8: the `minor` row also covers a `FOLD_MINOR` change with no `FOLD_EPOCH` change, the `major` row notes a result confined to the standings deltas is a minor (D34), the changeset rule and §5.5's 2b changeset check fail a `FOLD_MINOR` change under a changeset below minor, and the §10.1 table row reads `FOLD_MINOR (alone) => minor`.
