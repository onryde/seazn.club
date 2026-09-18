# Per-stage match rules — branch state

**Updated:** 2026-09-18, after Task 5b (the review-fix pass). A fresh session starts HERE, then reads
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
| 5 — pad surfaces through the resolver | DONE | `fce7d6225` |
| 5b — review fixes (D6 carry, templates door, TOCTOU lock, minors) | DONE | `7e27c760d` |
| 6 — `read` for the nine fields | DONE | `8c1e1f272` |
| 7 — Fixture Console stage panel (Option A, D7) | owed | — |
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

The plan is a hypothesis, and ten of its premises have already been wrong:

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
8. **`getFixture` must NOT be widened** (Task 5). Its result IS the published
   `GET /fixtures/{id}` response, returned unmapped and declared
   `response: S.Fixture` (`openapi.ts:156`), so adding `config_snapshot` and the
   stage config there would push two undeclared fields — one an entire frozen
   config — into the public API, with nothing in the repo catching the drift.
   Both pad routes use `loadFixturePadCfg` instead; `config_snapshot` is named
   in exactly one select.
9. **The spec's regression case (b) was false.** "A stage carrying only
   `shootout` overlays as before" — it did not: the decider overlay never
   reached either pad either. Task 5 therefore fixes a SECOND pre-existing
   defect, wider than recorded: every stage-level `shootout`/`extraTime` was
   invisible on both pads, not just the new `rules`.

10. **A billing freeze is not reachable by creating past the cap** (Task 5b).
    `createCompetition` 402s at the quota BEFORE anything can freeze, so the
    only path to a frozen competition is a DOWNGRADE: build over the cap on
    `pro`, reading the cap from `getLimit` rather than typing a number, then
    drop the plan. There is also no `"free"` plan key — `community` is the
    floor.

## Review — Tasks 1-5 came back Needs Fixes (2026-09-18)

A reviewer pass over the committed tasks found three real defects, all of
which a green suite had been hiding. Fixed in `7e27c760d`, each with a test
that fails without it and a single named mutant killer:

1. **`replaceStages` was silently wiping every override.** The Format tab's
   Apply deletes and recreates every stage from a template body that cannot
   carry `rules` (the D2a guard refuses it). D6 — carried SERVER-SIDE, keyed on
   `seq:kind`, so a stage that changes kind drops its override.
2. **Templates were a THIRD door onto `stages.config`.** `TemplateStage.config`
   is an untyped record spread verbatim into the column, so a template-declared
   `rules` reached it with no sport gate, no allowlist and no merged parse, for
   any sport. Guard in `effectiveStageConfig` + a catalog assertion.
3. **TOCTOU on the per-stage lock.** `putStageRules` took no division advisory
   lock while `append-event` freezes under a FIXTURE-scoped lock, so the two
   never serialised — a scorer could freeze the OLD format against a stage this
   PUT had just declared saved.

Plus: the allowlist ran AFTER the null strip, so `{rules:{notAKey:null}}`
answered 200; the §T2 shape audit scanned two hardcoded paths with a per-line
regex and could see neither a third file nor wrapped SQL; 402 was undeclared on
the route; the freeze guard had no test.

Counts re-run by the orchestrator, not taken on report: the five affected
suites are **32/32, 0 outside the worktree**. The single red in the agent's
full gate (`org-posts-digest.test.ts`, "sweepWeeklyDigests") is a 30001ms
**timeout**, not an assertion — the sweep is O(orgs) and the shared `smr` DB now
holds ~15k organizations. It reds with all three new suites `--exclude`d, and
this branch has never touched that file (`git diff origin/main...HEAD` is empty
for it).

## Walkthrough — the seam is NOT inert (2026-09-18)

Driven by hand on the prod server (label `smr`, :3355), device-link pad
`/score/<token>`, badminton, division default `bestOf: 3`:

| State | What the pad rendered |
| --- | --- |
| Before | **Best of 3 · Game 1** |
| After `stage.config.rules = {"bestOf":5}` | **Best of 5 · Game 1** |

Same URL, same fixture, only the stage row changed. `5` was chosen because the
badminton skin falls back to `cfg.bestOf ?? 3` — a dead path renders 3 and looks
correct, so only a non-default value witnesses the seam. This is what settles
the page-wiring gap below; the unit suite cannot.

The override is still in place on `stages.id = da2fbf75-97a3-4f2a-8dfc-476b003e1c4c`
for Task 7's UI work.

## Owner ruling D7 — Option A (2026-09-18)

Both options were injected into the LIVE division page at
`/o/v11-1ca82625/c/league-ko-89bee4/d/open-c72669?tab=fixtures` on the `smr`
server and screenshotted at 1280 and 320 — real CSS, real neighbouring
controls, real data. The owner picked **A** (inline format row in the stage
card). Full argument and the concrete markup in the spec under D7.

Two facts the render produced that no text sketch could:

- **B puts the editor entry point inside the destructive row** — between
  `Generate fixtures` and `Complete stage` / `Delete` at 1280, and directly
  above the same two in the phone sheet.
- **A at 320 with the editor open: `scrollWidth 320 = clientWidth 320`** —
  no horizontal scroll, fields stacked by `sm:grid-cols-3` alone, so A adds
  no `max-md:` and no `md:hidden` and the stage card keeps its property of
  having NO phone branch.

## Carried out of Task 6 — recorded, not fixed

- **Carrom's `bestOf` still has no `read`** and reopens blank in the division
  editor. Out of the nine in-scope fields, deliberately untouched.
- **Task 6's fix is live for `division-settings.tsx:409,436`**, so the
  division editor now prefills inputs that used to show blank. No unit test
  can see that (`environment: "node"`) — it owes a look in the Task 9
  walkthrough.
- **The `smr` DB is accumulating.** Task 6's wider gate showed four
  pre-existing reds in `credits-monthly-cron.test.ts` /
  `credits-bootstrap-grant.test.ts` — three timeouts and one
  `expected 13 to be less than or equal to 6` per-wallet statement cost, the
  same family as 5b's `org-posts-digest`. None reference match-rules and all
  fail identically in isolation. **Rebuild the label's DB before Task 9's
  gates** rather than reading these as regressions.

## Coverage limit carried into Task 9

Task 5's loader is unit-tested; **the page wiring is not**. `apps/web` vitest is
node-env and never renders those two server components, so nothing yet proves
`padCfg` actually reaches the pad — only that the function feeding it returns
the right config. That is the inert-seam class; the e2e in Task 9 owes it, and a
walkthrough by hand is what settles it before then.

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
