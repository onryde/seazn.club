# Engine split — GF-2 batch review (Opus, whole batch)

Range `origin/main(5887f0c36)..ff84756d9` (37 commits, T1–T4 and their review fixes). Reviewed 2026-10-16. Saved by the orchestrator (the reviewer cannot write repo files).

## Verdict: NEEDS FIXES — 0 MAJOR, 1 IMPORTANT, 2 MINOR, 3 NIT

The guard's rule holds: the freeze rule, the stats-gained rule, the corpus-level format fall and the batch floor all survive the review's mutants (9/9 code mutants killed, every kill an assertion failure), and three kernel mutants on recorder columns no task had tried each reached exactly the sports expected. No fail-open where a phone-visible fold change lands with no bump. To fix: the reformat tool cannot migrate one class of stream and its refusal gives advice that cannot work (I-1, blocks W2c's planned rebase, measured); a probe-only field can be stored in a corpus unnoticed (M-1); the S2 handoff contradicts Q2 (M-2).

## Findings

| # | sev | file:line | problem | fix |
|---|---|---|---|---|
| I-1 | IMPORTANT | `src/testkit/golden-reformat.ts:76-81`; `GOLDEN-POLICY.md:146-151` | Reformat dead end: a format-1 corpus with any stream whose module outcome differs from the effective one (settle, expunge where the module still answers, withdrawal over a level result) can never be reformatted. The refusal says "a re-baseline, land it on its own first", but a format-1 re-baseline records the module value again, so the reformat refuses again. Measured on W2c's format-1 corpora under W2c's engine: football, hockey, icehockey refuse on `abandonAward#9000x` (recorded draw, replayed null; deltas too). `reformatAll` is all-or-nothing, so W2c's planned `REFORMAT_GOLDEN=1` refuses everything. | In the refusal, detect "the format-1 field equals `recomputeStream(...,1)` but not the effective value" and name the real route (start from main's format-3 corpus and re-append via EXTEND). GOLDEN-POLICY paragraph. Test both message branches. |
| M-1 | MINOR | `src/testkit/golden.ts:2410` (`Recomputed.dense`), `:260`; `scripts/fold-epoch-guard.ts:517-558` (`parseCorpus`) | `recomputeStream` returns the probe-only `dense`; spreading its result skips TS excess-property checks, so `{...recomputeStream(...)}` + `slimStream` writes `dense` into the corpus — exactly the shape W2c's `extendBranches` takes. "No dense" checks are per writer only. Measured: 1.8 KB of `dense` on a non-floor carrom stream left 684/684 green across 11 golden files; guard exit 0. (A floor stream is caught by batch reproduction.) | Committed-corpus sweep: every stream's keys are exactly its format's set; `parseCorpus` refuses unknown stream keys (exit 2); or `recomputeStream` returns `storedFields` and `dense` stays on `recomputeKernel`. |
| M-2 | MINOR | `docs/superpowers/specs/engine-split/capture-s2-handoff.md:163,171-175,179-180` | Says "Since GF-2 they are format 2" (they are format 3); lists player-stat folds as "still not pinned … MANUAL MAJOR" / "invisible to both halves … MANUAL MAJOR", contradicting Q2, its own :140 and `GOLDEN-POLICY.md:426-432`; says note and award unpinned, but award is pinned in football/hockey/icehockey. | Rewrite: format 3; stats a guarded MINOR, manual MINOR outside the recorded rows (point to the policy list); award unpinned only in the 8 sports with no declared key. |
| n1 | NIT | `GOLDEN-POLICY.md:383-385` | A stats-fold change in how an undeclared award key is treated is server-only — a manual minor by Q2; text says "manual MAJOR of every sport it reaches". | Split: module-state change owes MAJOR; stats-fold change owes MINOR. |
| n2 | NIT | `golden-stats.test.ts` (9), `golden-format.test.ts` (7), `golden-overlay.test.ts` (1) | Flat `60_000`/`120_000` budgets beside `sweepBudget` (class 20); reintroduced in T4. Harmless today (slowest 13 s). | Use `sweepBudget`. |
| n3 | NIT | coverage | Every overlay column witnessed by exactly one stream per sport. Not a gap against the floor (asks for one). | Record "one witness per column" in the policy floor section. |

## Corpus coverage per sport (tip)

405 streams, 3,201,971 B (main 2,722,041, +17.6%), all format 3. Overlay cells: streams that set / clear.

| sport | streams (floor) | events | KB | stoppage | squads | settle | expunge | levelW | decider | stats>0 | award |
|---|---|---|---|---|---|---|---|---|---|---|---|
| football | 37 (8) | 388 | 281 | 1/1 | 1/0 | 1/1 | 1/1 | 1/1 | 0 | 26 | motm |
| cricket | 39 (8) | 1147 | 775 | 1/1 | 1/0 | 1/1 | 1/1 | 1/1 | 0 | 27 | – |
| boardgame | 84 (8) | 218 | 161 | 2/1 | 1/0 | 1/1 | 1/1 | 1/1 | 2/2 | 74 | – |
| carrom | 19 (7) | 250 | 208 | 1/1 | 1/0 | 1/1 | 1/1 | – | 0 | 14 | – |
| generic | 58 (8) | 126 | 96 | 1/1 | 1/0 | 1/1 | 1/1 | 1/1 | 0 | 43 | – |
| volleyball | 23 (9) | 664 | 191 | 2/1 | 1/0 | 1/1 | 1/1 | – | 0 | 6 | – |
| badminton | 24 (9) | 341 | 119 | 2/1 | 1/0 | 1/1 | 1/1 | – | 0 | 24 | – |
| tabletennis | 27 (8) | 484 | 167 | 1/1 | 1/0 | 1/1 | 1/1 | – | 0 | 27 | – |
| tennis | 33 (9) | 951 | 317 | 2/1 | 1/0 | 1/1 | 1/1 | – | 0 | 33 | – |
| icehockey | 27 (9) | 313 | 381 | 1/1 | 1/0 | 1/1 | 1/1 | 1/1 | 0 | 25 | mvp |
| hockey | 34 (10) | 455 | 429 | 2/1 | 1/0 | 1/1 | 1/1 | 1/1 | 0 | 32 | potm |

## Mutations run (scratch git mirror; kill = assertion failure only)

Recorder teeth (kernel mutant → `REBASELINE_GOLDEN=1` → guard against the pre-mutation commit), columns no task had reproduced:
- K1 `levelWithdrawal` drops `eventId` (`core/events.ts:1077`): exit 1, major owed in exactly the 6 sports that can end level, 1 stream each.
- K2 substitution not counted, `subsUsed += 0` (`core/lineup.ts:605`): exit 1, all 11, 1 stream each.
- K3 `settlement` drops `eventId` (`events.ts:1129`): exit 1, all 11, 1 stream each.

Code mutants 9/9 killed, 0 timeouts: G1 freeze rule off (6/112), G2 stats-unfrozen count dropped (5/112), G3 lockfile not fold source (3/112), G4 `overlayTransitions` clear before set (1/99), G5 award credited at 0 counts (2/119), G6 2→3 reformat skips `playerStats` (18/110), G7 `floorBatches` merges non-contiguous runs (2/46), G8 `corpusBefore` keeps every config (2/46), G9 `statsDiffer` always false (6/112). Probe: `dense` on a floor stream caught (3 red); on a non-floor stream nothing catches it (M-1).

## Lenses

1. Fail-open hunt: freeze × stats-gained precedence matches the header (both field sets gained under touched source → major; 2→3 under touched source → minor; stats-only with kernel fields both sides → per header). Fail-closed: format fall judged on the corpus; hybrid exit 2; no change list → source touched. Engine `src` imports nothing from `*.schema.json`, `rules/` or the testkit; production apps/web does not import the testkit; zod the only external import (lockfile classified). Batch floor × W2c's 9000x streams after a batch: covered. Only gaps: I-1, M-1.
2. Recorder fidelity: every column has a kernel-mutant witness (stoppage, squads, expunged, outcome, summaries, decider in T3; stats in T4; levelWithdrawal, squads/subsUsed, settlement here). A recorder writing only `[]` stats is caught by the counted independent sweep (`golden-stats.test.ts:274-337`).
3. Merge readiness vs main: rebased; `fold-epoch:check --against origin/main` exit 0, 381 matched, recorded 381, added 24, 0 violations.
4. CI: `ci.yml:132` runs the PR checkout's guard against HEAD^1 with full history (1.7 s). CLI tests use derived `spawnBudget`, sweeps `sweepBudget`. `fold-epoch-guard-cli.test.ts` grew 53→82 tests, 246 s on one worker under load ~20 — now the engine suite's longest file.
5. Matrix rows: draft below.
6. Policy honesty: cannot-see list verified against the code (refusals `events.ts` ~:943/:1108, award-policy configs, stats-outside-rows list, both `STATS_FOLD_VERSION` statements); problems M-2, n1.
7. Size/perf: +17.6% bytes; recorder folds every prefix, O(n²) per stream (same order as format 1) plus one stats fold; guard O(streams).

Re-run (scoped): engine 18 files 994/994 (paths under gf2); apps/web 8 reader files 408 pass / 0 fail / 41 skip (Postgres-gated); tsc 0; `engine:boundary` PASS (330 files).

Four questions: a format-3 reformat is a verify-only no-op and a second EXTEND appends nothing; empty corpora / empty `reformatAll` refused, overlay transitions state the empty case first, a guard comparing 0 streams exits 2; settle→void→settle, withdrawal→void, expunge→void recorded in every sport and reached by K1/K3; K1 named exactly the 6 level sports, K2/K3 all 11.

## W2c merge-readiness (measured)

W2c's engine `src` diff (29 files) applied onto the gf2 tip in a scratch mirror, `REBASELINE_GOLDEN=1`: 10/11 corpora byte-identical (no summaries/overlay/stats moved). Boardgame refuses on `knockoutTiebreak#100008` (Armageddon payload changed by W2c); re-recording it is removed+added → major owed, paid by W2c's boardgame:2. The guard with W2c's table (football, boardgame, carrom, generic, hockey at 2) against gf2: 0 violations.

Do NOT reformat W2c's format-1 corpora (I-1). Path: take main's (GF-2) corpus for every sport → re-record boardgame #100008 → `EXTEND_GOLDEN=1` to re-append W2c's streams (added, owe nothing; carrom's draw config grows a `levelWithdrawal` hole EXTEND fills) → in `extendBranches` use `storedFields(recomputeStream(..., corpusFormat(corpus)))` (M-1). Expected conflicts: `golden-policy.test.ts:419-437`, `:441-453` red by design once `abandonAward`/`sharedAbandon` configs land (W2c rewrites the "A kernel overlay a corpus never exercises" bullet); in `fold-epoch-guard-cli.test.ts` take GF-2's live-table version.

## Draft PR line

`Matrix rows: none — GF-2 changes only the engine's golden test harness (src/testkit), the golden corpora (a data-only reformat to format 3 plus appended floor streams), the fold-epoch guard script and docs; no engine source outside src/testkit, no FOLD_EPOCH/FOLD_MINOR entry and no apps/web product code changes (only two corpus-reader tests), so no format or stage rule a matrix row exercises moves.`

## Resolution

(pending)
