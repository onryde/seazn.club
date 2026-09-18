# Per-stage match rules — branch state

**Updated:** 2026-09-17, after Task 3. A fresh session starts HERE, then reads
the spec and the plan beside it.

| File | Why |
| --- | --- |
| `2026-09-17-per-stage-match-rules-override-design.md` | Design of record, v3. Rulings D1, D2, D2a, D3, D4, D5 argued. |
| `../plans/2026-09-17-per-stage-match-rules.md` | The 9-task plan being executed. |

## Position

Branch `feat/stage-match-rules`, worktree `.claude/worktrees/stage-match-rules`,
based on `main` `dc64cfcd6` (contains #794 Swiss formats, #797 spectator W2).
Nothing pushed; no PR yet.

| Task | State | Commit |
| --- | --- | --- |
| 1 — extract the rules table to `lib/match-rules.ts` | DONE | `ce3277243`, plus `7ac5bffdf` (probe-loop pin) |
| 2 — overlay `stage.config.rules` in `stageScopedCfg` + bench mirror | DONE | `3d36a08e8` |
| 3 — six stage-config writers made atomic | DONE | `029a496bd` |
| 4 — `PUT /stages/:id/rules` | DONE | `c3c6204f5` |
| 5 — pad surfaces through the resolver | owed | — |
| 6 — `read` for the nine fields | owed | — |
| 7 — Fixture Console stage panel | owed | — |
| 8 — stage-aware hub format line | owed | — |
| 9 — e2e, smoke, gates | owed | — |

## Environment

Label `smr` is already up: Postgres 54740 (schema v409, sport catalog synced),
placement 50327. Load it into any shell that runs tests, in the SAME call:

```bash
eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label smr)"
```

`seazn-env down --label smr` when the branch is finished, not before. Non-DB
suites need `DATABASE_URL=` empty; DB suites need this label — pointing them at
the dev DB on 5432 makes vitest refuse to start, and it exits BEFORE writing
`--outputFile`, so the symptom is "could not open file", not a test failure.

## Plan premises that proved FALSE (expect more)

The plan is a hypothesis, and three of its steps have already been wrong:

1. **Task 3's test shape was vacuous.** Writing `rules` and then calling the
   usecase PASSES against the un-fixed writer — the usecase re-reads the config
   inside its own transaction. The real interleave holds
   `pg_advisory_xact_lock('division:…')` from a second connection and waits on
   `pg_locks` until the usecase parks after its read. Proved, not inferred.
2. **Task 2's "three tests fail first" was wrong** — only one did. The other two
   passed vacuously before the change, and are decoration without the mutants
   that kill them.
3. **`seedNextStage` is not exported**, so "the usecase that owns stages.ts:3176"
   was not executable; Task 3 drove `overrideStandings` instead.
4. **Task 4's import paths were wrong** — `withTenant` is `@/lib/db` and
   `HttpError` is `@/lib/errors`, not the `@/server/...` paths written down.
5. **Task 4's "export and await `fireStageRevalidate`" was unnecessary.** That
   private function only re-queries `division_id`/`competition_id` and calls
   `fireDivisionRevalidate`, which is synchronous (`: void`) — so calling
   `fireDivisionRevalidate` directly with ids the transaction already read is
   equivalent, one query cheaper, and floats no promise. Do not re-open it.
6. **`EngineError` carries no `status`**, so a test cannot assert `status: 422`
   on `CONFIG_INVALID`; assert the code. `ENGINE_HTTP` in `api-v1/http.ts` maps
   it to 422, which is what the route actually answers.
7. **`key-scopes.ts` is load-bearing for any new route** and was missing from
   Task 4's file list. `key-scopes.test.ts` enforces it. A new route also owes
   `src/server/api-v1/__tests__/` (`openapi-coverage.test.ts`), which is NOT in
   the usecases directory most gates name.

## Findings carried forward

- No in-scope rule field branches its emitted config-key set on its value
  (carrom's `gameTo` is the only one in the whole table, out of scope), so the
  multi-probe loop in `configKeysFor` is pinned by a synthetic field rather than
  a real one.
- `validate-pack.test.ts` reads `stage-cfg.ts` SOURCE and regex-extracts the
  `STAGE_DECIDER_KEYS` literal — reformatting that line reds the bench suite
  from a file in `apps/web`.
- Bench suites run from the WORKTREE ROOT and are not in the root `npm test`; a
  gate that runs only the two workspaces will not see them.
- `stages.config` is `jsonb not null default '{}'`, so `config || …` cannot hit
  the `NULL || x = NULL` trap.
- `history-panel-contrast.test.tsx:246` scans `match-rules.tsx` source text; a
  later move of `MatchRuleFields` must carry that guard.
