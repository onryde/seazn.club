# Golden floor (GF-1) review (Opus, task + batch)

Range `115b7b573..e8a819460` (7 commits). Reviewed 2026-10-15. Saved by the orchestrator (the reviewer cannot write repo files).

## Verdict: NEEDS FIXES

The floor closes M2 (`reviews/1e.md`) for undo of a sport event, finalize, forfeits and outcome kinds. It does not close it for pause (suspend/resume), for undo of a kernel event, or for lineup changes in 4 sports — yet GOLDEN-POLICY.md and the commits say "the core-event gap is closed". The floor checks presence only, so inert streams count as covered.

## Lens 1 — does each event move a recorded golden?

Teeth = mutant → `REBASELINE_GOLDEN=1` → `fold-epoch:check --against HEAD` in a scratch mirror with this branch as base.

| event | moves a recorded golden | evidence |
|---|---|---|
| void, sport target | 11/11; late correction 9/11 | football and cricket late-void mutants → exit 1 naming only that sport (exit 0 at base); all-sports: 9 violations, boardgame + carrom missed (their voids are gap-1) |
| void, kernel target | 0/11 | no stream has one; void-core-ignored → 0 corpora changed, exit 0 |
| suspend | 0/11 (overlay only) | suspend-noop, suspend-drop-reason → 0 corpora changed, exit 0. SURVIVES |
| resume | 0/11 state | resume-noop → replay red 11/11 (`play is suspended`); only a refusal is caught |
| note | 0/11, by design | — |
| award (player award) | 0/11 (8 module families `return state`) | — |
| finalize | 11/11 | — |
| forfeit outcomes (award:*, double_walkover) | 11/11 | module-folded |
| lineup.* | 7/11 | football, generic, boardgame, carrom survive (no `onLineup`, or state ignores it) |

## Findings

| # | sev | file:line | problem | fix |
|---|---|---|---|---|
| 1 | MAJOR | golden-floor.ts:69-77; golden.ts:205-213; GOLDEN-POLICY.md | Presence-only floor; `recomputeStream` records module state + `module.outcome` only, so kernel-owned suspend/resume and lineup events in sports without `onLineup` are inert. M2 "pause" still unguarded. | (a) record the kernel overlay (stoppage, squads, settlement) per step, written only when non-default, compared in `outputsDiffer` — retires the settle exemption; or (b) an "overlay unpinned" class with `stale()` and corrected doc/commit claims |
| 2 | IMPORTANT | golden-floor-streams.ts:196 | `buildUndo` skips core.* targets: undoing a mistaken forfeit/abandon/start/suspend unpinned in 11/11 (a phone path) | per-sport scenario voiding the deciding forfeit/abandon then resuming play; require that token |
| 3 | IMPORTANT | golden-floor.ts:104-110, :372; test :172 | `LINEUP_TYPES` hand-typed; adding `core.lineup.swap` to `CORE_EVENT_SCHEMAS` stays green (reason "?") | derive from `CORE_TYPES`; throw on a lineup type with no planner; reject "?" |
| 4 | MINOR | golden-floor-streams.ts:191-206 | late correction falls back to striking the last event (boardgame, carrom) | search more configs/seeds for gap > 1, or document |
| 5 | MINOR | golden-floor-streams.ts:10-11; test :400-425 | "both halves asserted" is false (builder filters + byte snapshot) | counted sweep: every recorded void, fold with it = fold minus target+void, ≠ fold minus void |
| 6 | MINOR | golden-floor-streams.test.ts:14, :37, :65 | keep-rule compares against all non-floor streams incl. later generator appends → a later EXTEND reds the floor | measure each floor stream against the streams preceding it |
| 7 | MINOR | apps/web public-player-matches.test.ts:2117, :2124 | envelopes built without `voids` + `catch { continue }` silently drop 22/727 prefixes | pass `event.voids`; assert zero refusals |
| 8 | NIT | golden-forfeit-migration.ts:19-20, :45-46 | comments now false | update |
| 9 | NIT | golden-floor.ts:226 | `OBSERVE_SEEDS=40` cannot reach cricket's tie (~seed 460) | document or per-sport |

## Lenses 2–7

- **Derivation mutants:** 9 run; killed G1–G4, G6–G8; survived new lineup type (#3); G9 equivalent on current data. Settle exemption sound and narrow (all three `stale()` paths tested). `NATURAL_OUTCOMES` matches code. Impossible-by-policy uses the reducer's own code (`lineup.ts:613`), checked both ways.
- **Byte identity:** 312/312 old streams identical; `voids` only on `core.void`; guard vs origin/main exit 0, 312 matched, 69 added.
- **Forfeit migration fix:** testkit-only; keeps `disqualified`/`withdrew`; no corpus byte or production change; tested both ways.
- **apps/web test edits:** no assertion weakened; premise flip correct (now exactly `["core.settle"]` missing).
- **merge-tree:** clean vs main, `feat/engine-split-1e-minor` (merged tree: guard exit 0, 291/291), `feat/engine-split-1f`.
- **Runs:** engine CI way 232/232; other corpus consumers 234/234; apps/web 48/48 + 86/86 (41 DB skips). No new test > 2 s. Ledger 36 ids exact.

## Four questions

Second call no-op (but #6). Empty corpus → every token a hole; no config → settle probe stale (fails closed). Undo of sport event 11/11; kernel event 0/11 (#2). Every registered sport swept; teeth shown for badminton, football, cricket.

## Resolution

Fixed on `test/golden-core-event-floor` after the review (2026-10-15, Sonnet implementer; verdict was NEEDS FIXES). No engine source changed; the 312 existing streams are byte-identical (checked against origin/main's blobs), the floor streams are appended, 69 in total (< 80). Guard `fold-epoch:check --against origin/main`: exit 0, 0 violations, 312 matched / 0 changed / 69 added (origin/main still `115b7b573`).

| # | status | what was done | evidence |
|---|---|---|---|
| 1 | FIXED (option b; option a is GF-2) | `OVERLAY_CLAIMS` in `golden-floor.ts`: an explicit "recorded, overlay unpinned" class (suspend+resume, note, award, and `core.lineup.*` for a module with no `onLineup`). Inertness is DERIVED by ablation (remove the event from every recorded stream, compare each retained step, the removed event's OWN step including index 0, outcome, summary, deltas; lineups judged marginally down the plan order). A claim whose ablation moves a golden, finds nothing recorded, or cannot run is stale by name. `finalize`, `abandon`, `forfeit` are probed as controls and answer "pinned" 11/11. GOLDEN-POLICY.md: the class and the kernel side of an undo are listed under "What the guard cannot see" as MANUAL bumps; no "gap closed" claim is left. Earlier commit messages that say "closed" are published history and were not rewritten; the policy file and this section supersede them. | `golden-floor-overlay.test.ts` 14 tests; injecting an overlay-recording harness stales exactly the kernel-owned claims (pause, lineups) and leaves note/award held; claims-empty mutant -> red (8 failed + 2 suites) |
| 2 | FIXED | Floor requires `undo:core.forfeit`, `undo:core.abandon` (every sport) and `standing:core.abandon` (an abandon nothing strikes; without it the undo stream would have replaced 5 sports' standing-abandon streams). The undo stream records a mis-tapped retirement and a mis-tapped abandon, strikes each at once and plays on to the walk's own result. The fold itself is asked that the event took effect (effective outcome for a forfeit; the kernel's `ABANDONED_SETTLE_OR_VOID` refusal for an abandon, since an abandon decides nothing the module sees), that the void clears it and leaves module state as before. Without the void the later events are refused, so a void that stopped clearing them fails the recorded fold. | `strikeKernelEvent` guards each reached by a test; 11 sports x 2 kernel voids proven in `golden-floor-streams.test.ts`. TEETH (scratch clone, base = this branch): badminton mutant "a void of a forfeit/abandon also strikes the sport event before it", prefix-safe, rebaselined -> `fold-epoch-guard --against HEAD^1` exit 1, `badminton ... matched 22 changed 1 ... VIOLATION: 1 stream(s) fold differently`, the other 10 sports unchanged. |
| 3 | FIXED | Lineup types derived from `CORE_TYPES` (`lineupTypesOf`): a kernel `core.lineup.*` with no planner, or a planner for a dropped type, throws BY NAME at import and at every entry point (`planLineupEvents`, `lineupOffers`, `floorRequirement` take an injectable list). Planners are a `Record` keyed by the plan order. `impossibleReason` refuses `no-candidate`, an unexplained config and a corpus with no config; the impossible-by-policy reasons are asserted to be reducer refusal codes (exhaustive `Record<LineupRejectionReason, true>`). | Reviewer's mutant (`core.lineup.swap` in `CORE_EVENT_SCHEMAS`) -> 3 test files fail to load: "the kernel declares core.lineup.swap and golden-floor.ts has no planner for it". |
| 4 | FIXED | Late correction now prefers an EARLIER event struck after later play and the search runs across every config and seed before settling for an immediate one. Boardgame strikes its `pairing` card (gap 10), carrom its `game.adjust` (gap 12): their board/result events are chained, which is why the old search never found one. Asserted per sport. | each sport's undo stream has a void with gap > 1 (11/11) |
| 5 | FIXED | `golden-floor-voids.test.ts`: every recorded void in every corpus: fold(all) == fold(minus target and void) and != fold(minus the void alone) (a refusal counts), over module state, stoppage, squads, settlement, effective outcome and abandon-in-force. Teeth: a void of an inert note is named decoration; a void-blind reader is named. | 44 voids swept (11/11 sports, sport and kernel targets each), 0 failures |
| 6 | FIXED | Reproduction builds from the streams BEFORE the first floor stream; the keep-rule measures each floor stream against the streams preceding it. | simulated later EXTEND (a generator walk appended after the floor, 11 sports): reproduction byte-identical, keep-rule green, floor met. Old measure (all non-floor streams) -> red |
| 7 | FIXED | `public-player-matches.test.ts` passes `event.voids` (the oracle ledger renumbers voids past the cricket toss it prepends), records refused prefixes and asserts none, and counts compared prefixes against the corpus's own. | 727 prefixes, 0 refused (was 22 silently dropped); mutant dropping `voids` -> 11 red, one per sport |
| 8 | FIXED | Both comments corrected. The prefix reading the migration uses is NOT the fold's (the fold resolves voids over the whole ledger); a counted test pins that no committed forfeit that reaches the fold sits where they differ, with a control that the divergence is real. | `golden-forfeit-migration.test.ts` +2 |
| 9 | DOCUMENTED | `OBSERVE_SEEDS` states what 40 seeds cannot reach (cricket's `tie`, seed ~460) and what covers it instead (`NATURAL_OUTCOMES` by hand, stale check the other way). Per-sport seeds declined: minutes of fold for a ~1-in-500 outcome nothing suggests beyond cricket's. | comment at the declaration, GOLDEN-POLICY.md |

Verification (all from `packages/engine` / `apps/web`, JSON reporter): scoped engine set 858/858 across 20 files, plain and CI-way (coverage run; the threshold exit 1 is the expected partial-run one); apps/web 5 files 175 total, 134 passed, 0 failed, 41 DB skips as before; tsc clean (engine, apps/web); eslint 0 warnings on every touched file; `pnpm engine:boundary` PASS; ledger `golden-floor.json` regenerated, parity before-only 0 / after-only 78 / both 11437 / unaccounted 0. CI-way budgets: two new sweeps carry explicit budgets (overlay recorder 4.8 s -> 60 s; later-EXTEND reproduction 6.5 s -> 60 s; committed-floor reproduction 3.0 s already 30 s).

Mutation sweep over the new code, 35 mutants (class empty, claim scope, own-step and index-0 neutrality, refusal-as-pinned, chain credit, unrecorded-not-stale, impossible-skip, lineup vocabulary both directions, no-candidate, empty offers, void validity, standing token, undo list, ablate renumber and lost target, late-correction ranking, every `strikeKernelEvent` guard, abandon refusal code, migration guard, prefix measure, void-sweep decoration and renumber, the reviewer's schema mutant): 2 survivors on the first pass (chain credit, reopened-state check), both killed by new tests; two further checks on the finished splice (result equality, every prefix folds) were implied by the state check and the strict sequential fold, unreachable by any test, and were dropped as dead guards (the finished ledger is still folded strictly by `buildUndo` and every prefix by `recomputeStream`). The decisive-kernel-events list is now pinned to the rulebook's two instead of read back from the code under test.

Open: GF-2 (record the kernel overlay in the corpus and compare it in the guard) pins everything the class lists; it rewrites `fold-epoch-guard.ts`, which `feat/engine-split-1e-minor` also rewrites, so it waits.

### Resolution check follow-up (N1, timeouts, N2)

| # | status | what was done | evidence |
|---|---|---|---|
| N1 | FIXED | The overlay class was asserted one way only: each claim holds. `OverlayClaim.appliesTo` is split into `assertedFor` (where the probe must agree, from the module's `onLineup` declaration, so staleness still reds) and `covers(module, token, verdict)` (what the class stands for, derived from the ablation VERDICT, so football's `core.lineup.position`, which declares `onLineup` yet moves no golden, is covered). New `uncoveredUnpinned(module, corpus)` ablates EVERY recorded `core.*` event singly (`overlayVerdicts(..., "all")`) and names any that moves nothing yet no class covers. | New counted sweep (per sport x token: probed count equals the corpus's own recorded `core.*` count, at least 4 unpinned per sport), a football test (declares `onLineup`, `position` unpinned in streams > 0, `substitution`/`retirement`/`entry` pinned, covered but not asserted), and a teeth test (the declaration-only rule leaves `football event:core.lineup.position` uncovered by name; a table without the `note` class names `core.note` in all 11 sports). Mutants, each restored from a `cp` backup: the old rule `covers: (m) => m.onLineup === undefined` reds the sweep (`football: an unpinned core event no claim covers`) and the football test; the "all" probing disabled reds the sweep (`football: probed every recorded core event: expected 12 to be 14`) and the teeth test. The retitled "a lineup event is unpinned in EVERY recorded type where the module declares no onLineup..." keeps its `some(pinned)` bound but says so; it no longer stands for the per-token claim. Measured unpinned `core.*` per sport: suspend, resume, note, award everywhere; plus all four lineup types in boardgame, carrom, generic; plus `position` in football. |
| N1 policy | FIXED | `GOLDEN-POLICY.md`: "they move state in the other eight" was false for football's position change. Now: position is inert in football too, `substitution`/`retirement`/`entry` move state wherever `onLineup` exists, `position` moves it in the other seven; the unpinned pairs are derived from the ablation, not the declaration; the manual bump reads "raise each sport's `FOLD_EPOCH` (the MAJOR) by hand". | `golden-policy.test.ts` 32/32. |
| timeouts | FIXED | The overlay "day the harness records the kernel overlay" test and the later-EXTEND test in `golden-floor-streams.test.ts` go from 60_000 to 30_000, the sibling convention. The three new overlay tests, and the "shipped corpora hold every claim" test (4.9 s under coverage at load ~55, near the 5 s default), carry 30_000. | Plain run 1.3-3.8 s each at load ~60; CI-way (coverage) 9.0 s kernel-overlay test, 12.6 s sweep, 13.6 s teeth test, 14.1 s later-EXTEND, all inside 30_000. |
| N2 | NOT CHANGED | Commit body wording left as is (no history rewrite); the squash message comes from this Resolution. | - |

Verification: 13 files (the floor/overlay/streams/voids/forfeit-migration/policy tests, golden, golden-slim, golden-compare, golden-fields, golden-mutations, schema-snapshot, fold-epoch) CI-way (`npm run test:coverage`, no `--testTimeout`): 608 total, 608 passed, 0 failed, 13 suites (the coverage-threshold exit 1 is the expected partial-run one). `fold-epoch:check --against origin/main`: 0 violations, 312 streams compared. tsc and eslint on the touched files clean. Ledger: 81 added ids (3 new, 1 retitled), after-side ids of the five GF-1 test files equal the ledger plus the 8 pre-existing forfeit-migration tests.
