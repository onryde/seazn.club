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
