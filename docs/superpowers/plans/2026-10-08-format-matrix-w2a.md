# Format × Sport Matrix — W2a (brackets always finish) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Agent topology.** Work runs in **loops**, not tasks: each loop is implementer → reviewer until the review is clean and the scoped gate is green (R21). Same-file tasks are batched into one loop (RULES.md batching rule), and two lanes run in parallel worktrees. See **Execution model** and **Loops and lanes** below Review Focus. Task 15 goes to a **different implementer agent** than the one that ran the engine loop (R8). The models for each role are set by the owner's W2a ruling (Execution model). That ruling is the only per-dispatch model override this plan authorises, and it applies to W2a only.

**Goal:** No bracket match can end as "TBD". A level result in a bracket stage is held as `needs_decision` and nobody is seated. The organiser closes it with one kernel-owned `core.settle` event. Chess plays a scorer-recorded tie-break and carrom plays the ICF extra board. The 77 W1d reds turn ✅ with no new red anywhere.

**Architecture** (approach A, ruling 76):
- **Bracket deciders are config.** Each sport module declares `bracketDeciders(cfg): Partial<Cfg>`. `resolveFixtureCfg` merges it on top of the stage-scoped cfg when the fixture's stage kind is in `BRACKET_KINDS`. The V347 freeze then carries it from the first event.
- **Settle belongs to the kernel.** `core.settle` is validated and folded by `foldMatchWithStoppage` and never reaches `module.apply`. The kernel returns a `settlement` beside the state. One helper, `outcomeOf(module, folded)`, turns state plus settlement into the outcome, and every outcome reader moves to it. A source scan pins that list.
- **The server holds and seats:**
  - `fixtureStatusFromFold` takes the stage kind and returns `needs_decision` for a level outcome in a bracket.
  - `onDecided` skips `needs_decision`, and a seating assertion fires only on a bracket fixture that a bug marked decided while it was level.
  - `core.settle`, `core.forfeit` and `core.abandon` share one organiser-only constant, which the pad imports.
- **The UI:**
  - The fixture console shows a "Needs a decision" block and a settle dialog.
  - The pad learns its stage kind and hides Draw in brackets.
  - The boardgame skin runs a three-step tie-break sheet.
- **The harness and the reference model:**
  - The generators reach deciders, settle and abandon at a real score.
  - The model gains an opt-in Settle command.
  - A new `bracket-finish` reference family, written from the rule rows by a separate agent, judges status, advancement and refusals.

**Tech Stack:**
- TypeScript 7 (`typescript-native` 7.0.2) and Node 26 `--experimental-strip-types`: no enums, namespaces or parameter properties; `.ts` import suffixes under `tools/` and `packages/`.
- zod 4; vitest 4; fast-check (already a dependency of `apps/web`, `packages/engine` and `tools/matrix`).
- Next.js (read `node_modules/next/dist/docs/` before touching a page; AGENTS.md); Playwright 1.61.1.
- Postgres deltas under `db/migration/deltas/`; pnpm 10.34.5.
- Stryker 10 (`packages/engine/stryker.groups.mjs`).

**Spec:** `docs/superpowers/specs/2026-10-08-format-matrix-w2a-design.md` (the authority; rulings 71–79 in `docs/superpowers/specs/2026-09-27-format-matrix-prompts/_INDEX.md`).
- Rules: `_RULES.md` R1–R29.
- House rules: `docs/superpowers/TEST-STRATEGY.md` rules 1–10 and the reviewer's four questions; `docs/superpowers/RULES.md` (the four test types, never a full local suite, ≥2 UI options, 1280/768/320 verdicts); `AGENTS.md` classes 1–23 and the phone-composition section.
- Rulebooks: `rulebook-W2-sets-cricket.md` (RB2A-n, NEW-H1 at :57) and `rulebook-W2-goals-boards.md` (RB2B-n).
- Style reference: `docs/superpowers/plans/2026-10-04-format-matrix-w1d.md`.

Where the spec and the tree disagree, the tree wins and the disagreement is listed in **Plan-time findings** below.

---

## Plan-time findings (spec gaps and false premises; each with evidence)

These were found while planning, by reading the tree at `c0416dea6`. None is decided here where the spec leaves it to the owner: the items marked **OWNER** go to the owner as a recommendation before the task that needs them (class 17). The rest are mechanical consequences of the spec's own rules, and the plan follows them.

1. **Settle cannot "fold to win" inside module state.** `foldMatchWithStoppage` returns module state only (`packages/engine/src/core/events.ts:518-526`, return at `:768`). Every consumer reads the outcome as `module.outcome(state)`. The non-test readers are:
   - `apps/web/src/server/engine-db/fold.ts:168`;
   - `apps/web/src/server/engine-db/append-event.ts:329`;
   - `apps/web/src/server/usecases/event-import.ts:324`;
   - `packages/engine/src/sports/cricket/scorecard.ts:1155`;
   - `tools/matrix/lib/fold.ts:62`;
   - `tools/matrix/lib/model/ledger-fold.ts:38`.

   `apps/web/src/server/overlay/recent.ts:321`, `:355` also calls `module.outcome(state)`, but on a point-state PROBE over a stored module state, not on a fold result. A settlement is never part of module state, so it cannot move to `outcomeOf`; it stays bare and listed in the scan's allowed list with that reason (preflight C8).

   The plan therefore returns a kernel `settlement` beside the state and adds `outcomeOf(module, folded)`. Task 4 moves the six fold readers above to it, and a source-scan test pins exactly those six by name (class 1, the inert seam).
2. **The spec says to add `core.settle` to `CoreEv`** (§5.1). `CoreEv` is documented as "the payload set modules see in apply()", with every kernel-owned event deliberately absent (`events.ts:130-149`). Settle is kernel-owned (§5.1, second bullet), so it stays out of `CoreEv`, and a test asserts that `module.apply` never receives it.
3. **The spec's payload says `winner: SideId`.** No `SideId` type exists in the engine (`grep -a "SideId" packages/engine/src` finds none). The kernel's existing entrant reference is `EntrantId` (`core/types.ts:10`), as used by `CoreForfeit.by` (`events.ts:52`). The plan uses `EntrantId`. The kernel derives the loser from `lineups.home/away.entrantId` (`types.ts:240`) and refuses a winner who is neither side. The same applies to `boardgame.tiebreak.winner` (the module's own `sideOf`, `boardgame.ts:228-232`).
4. **`core.settle` must also be in `DURING_STOPPAGE`** (`events.ts:469-490`). A setbased abandon during a suspension leaves the outcome null (`setbased/kernel.ts:818-823`), so the kernel never clears the stoppage (`events.ts:744-749`). A settle would then be refused `WRONG_PHASE` by `:599-605`, and the fixture could never be closed.
5. **`BRACKET_KINDS` clashes with existing names, and the meanings differ.**
   - Four-kind sets already exist, all without ladder: engine `competition/progression.ts:232` `BRACKET_STAGE_KINDS`, and app `engine-db/competition.ts:50` and `usecases/stages.ts:3964`, both named `BRACKET_KINDS`. `grep -arn "BRACKET_KINDS" apps/web/src` finds 36 references in 13 files, and `usecases/__tests__/bracket-kinds-sync.test.ts` pins the three four-kind literals against each other.
   - Those sets mean "has a bracket shape". The spec's five-kind set means "a level result is forbidden".
   - **No rename.** Renaming 36 references is blast radius the spec does not ask for. The engine exports the spec's set as `BRACKET_KINDS` from `@seazn/engine/core`, plus a predicate with a distinct name, `forbidsLevelResult(kind)`. App code calls the predicate and never imports the engine set by name, so no file holds two `BRACKET_KINDS`.
   - A test pins the relation `BRACKET_KINDS = BRACKET_STAGE_KINDS ∪ {ladder}` (Task 3).
6. **A literal throw in `advancingSides` / `bracketWinnerLoser` would break every league draw and every held fixture.**
   - `onDecided` calls `advancingSides` for every decided outcome, league draws included (`usecases/scoring.ts:294`, `:728`).
   - `releaseFedSeats` calls it on every append (`append-event.ts:358`; `fed-seats.ts:183`, `:254`, `:281-282`).
   - `toBracketFixture` calls `bracketWinnerLoser` for every bracket row, held ones included (`engine-db/competition.ts:181`, `:632`; `usecases/stages.ts:4088`).

   So `LEVEL_RESULT_SEATED` fires only on the bug shape: a bracket stage kind, a status in `decided | forfeited | finalized`, and a level outcome. It is placed where the stage kind and the status are both known: `onDecided`, `toBracketFixture`, and the `stages.ts:4088` completed-bracket rebuild. Both helpers keep returning `{}` for a level outcome, which stays correct for leagues.
7. **OWNER (resolved, ruling 82) — existing rows.** A bracket fixture already stored as `decided`/`finalized` with a level outcome (the 77 reds' shape, possibly in production) would make the read paths in finding 6 throw `LEVEL_RESULT_SEATED`.
   - **RESOLVED — ruling 82 (owner, 2026-10-08): backfill.** V431 also moves those rows to `needs_decision`, so the organiser sees the block and can settle them, and no live cup is left with an exception page. The cost is one `update` in the delta (Task 7 Steps 3, 4 and 7, unconditional). With the shape gone, the read-path guards in Task 8 throw on it like any other bug shape.
8. **OpenAPI drift is expected, contrary to spec §5.4.8.** The public fixture status enum at `apps/web/src/server/api-v1/schemas.ts:1658` lists every status, so `needs_decision` changes `openapi/v1.json` and `openapi/v1.public.json` (`scripts/openapi-gen.ts:18-23`). Task 7 regenerates and commits both.
9. **"The V367 courts history" holds no status set.** `db/migration/deltas/V367__venues_and_courts.sql` contains no fixture-status literal. The SQL sets that do are:
   - V214 (the check constraint, `v2-engine/tables/V214__fixtures.sql:21-22`);
   - V354 / V355 (`division_has_results` and `fixtures_division_results_idx`);
   - V419 (the discovery view's `in_play_count`);
   - V430's `fixtures_track_finished` trigger (`deltas/V430__capture_stream_codes.sql`), which the spec does not name.

   Task 7's sweep classifies all of them.
10. **"Next to `core.finalize` and `core.void`": no such set exists.** Finalize and void are separate conditional checks: `scoring.ts:502` (device finalize), `:529-545` (device void own-link) and `:553-558` (scorer finalize/void). Task 9 therefore creates the set itself:
    - `ORGANISER_ONLY_EVENT_TYPES = ["core.settle", "core.forfeit", "core.abandon"]` in a client-safe `apps/web/src/lib/organiser-only-events.ts`. It has no `server-only` import, because a client component importing server code breaks the build (memory).
    - The server refuses when `auth.via === "device_link" || subjectToScorerCapabilityGates(auth)` (`usecases/scorers.ts:46-50`), with `HttpError(403, …)`, which the API maps to `FORBIDDEN` (`api-v1/http.ts:80`). That is the code §7 row 3 asks the plan to name.
11. **Official scorers see Forfeit and Abandon on the console today.**
    - The page passes `canEdit={canScore && !frozen}` (`app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/f/[no]/page.tsx:259`), and an official has `canScore` (`:62`).
    - So `fixture-console.tsx:1422-1433` renders both buttons for them, and after ruling 77 every tap would be refused.
    - Task 11 passes a separate `canOrganise` flag (the page's own `canEdit` for owner/admin, `:59`) and hides Forfeit, Abandon and the settle block behind it.
    - This follows from ruling 77; it is flagged so the reviewer can see the UI change was derived, not invented.
12. **Boardgame `tiebreak` must be `z.boolean().optional()`, absent meaning false — never `.default(false)`.**
    - A default rewrites every frozen golden state string, because cfg is serialised into state (`boardgame.ts:55-77` comment; `packages/engine/src/testkit/GOLDEN-POLICY.md`).
    - Adding `"boardgame.tiebreak"` to `padSpec.fidelity` needs a golden coverage stream for the new type. `COVERAGE_CONFIGS.boardgame` gains `knockoutTiebreak: { tiebreak: true }` (`testkit/golden.ts:785`), still within `MAX_CONFIGS = 4` because coverage configs are counted separately from `EXTRA_CONFIGS` (`:59`, `:68`; executor re-pins).
    - The new stream is appended with `EXTEND_GOLDEN=1` in a commit of its own, and `boardgame.schema.json` is regenerated with `pnpm --filter @seazn/engine schema:snapshot`.
13. **The carrom "rewrite" is an addition, not a change.** `carrom.test.ts:157-170` folds `tieBoard: "draw"` in a league, which stays correct. W2a adds the bracket case beside it. `sport/match-points-bounds.test.ts:233-243` is unaffected.
14. **`replay.ts` is not a `resolveFixtureCfg` caller** (spec §5.4.1). It folds through `loadFoldInputs` (`engine-db/replay.ts:9`, `:65`). The real non-test callers are 11 sites:
    - `engine-db/fold.ts:155`;
    - `engine-db/append-event.ts:270`;
    - `engine-db/competition.ts:325` and `:347`;
    - `public-site/match-centre-load.ts:427`;
    - `usecases/fixtures.ts:115` (`loadFixturePadCfg`, which feeds both pads);
    - `usecases/player-stats.ts:439`;
    - `usecases/event-import.ts:281`;
    - `usecases/admin-fixture-config.ts:122` and `:193`;
    - `usecases/org-posts.ts:777`.

    `loadFoldInputs` must also load the stage kind for `nextStatus`; it selects `config` only today (`fold.ts:153-155`).
15. **The americano decision (spec §5.2, "the plan records which, with the citation").**
    - `audit-2026-09-27/offered-matrix.md:26` marks every sport but generic `?(UI)a` for americano, and the legend at `:7` says "?(UI)" means the builder offers it anyway.
    - Football, cricket and the period kernel (hockey, ice hockey) are therefore **offered**, and each gains `americano` in its allow-list.
    - Setbased (badminton, table tennis, volleyball) and nested (tennis) are unchanged: they always return false (`setbased/kernel.ts:2469`, `nested/kernel.ts:2223`).
    - Note `:43` reason a: the americano console writes `generic.result`, which those kernels reject, so the change is inert in the product today. It is still what X-DR-1 says, and the sweep proves it.
16. **Harness vacuity risk.** Once `supportsDraws` is false in brackets, `stageDrawsOk` (`tools/matrix/lib/scenarios/common.ts:580-582`) stops `defaultPolicy` (`:461-464`) from ever asking for a level result in a bracket. SC-O1 and SC-O2 would then go ✅ without exercising a single decider.
    - Task 14 adds a bracket policy (a level result then its decider or settle) and counted checks (`life-bracket-decider-exercised`), with zero counted as a failure.
    - It also folds the harness's local parity with the **stage-resolved** cfg. `decideFixture` folds with the division cfg today (`common.ts:526`), which would red parity on every boardgame bracket.
17. **A dispatched `matrix-truth.yml` on the branch counts as a weekly run** for staleness (`tools/matrix/ci/staleness.ts:26`; non-blocking at `.github/workflows/ci.yml:1759-1765`). Task 16 records it in the evidence README so nobody reads the next weekly gap as "ran".
18. **`engineFixtureStatus` silently defaults an unknown status to `"scheduled"`** (`apps/web/src/lib/fixture-engine-status.ts`, the `default:` branch). Task 7 maps `needs_decision` explicitly to `"in_play"`: played, not finished, nobody seated. A sweep test fails on any unmapped status.
19. **"Abandoned with no outcome" is narrower than the sports that need a settle.**
    - Cricket's abandon folds to `no_result` (or `tie` in a super over).
    - Football and the period kernel fold a level abandon to `no_result` (`football.ts:1653`, `period/kernel.ts:1446`).
    - Each of those leaves status `abandoned` **with** an outcome in a bracket. Settle's precondition already admits them (a level outcome), but the console block condition in spec §5.5 ("abandoned with no outcome") would hide the button.
    - The plan shows the block for a bracket fixture that is `needs_decision`, or `abandoned` with an outcome that is null or level. It is derived from X-ST-1. **Folded into spec §5.5** with the plan's approval (ruling 82).
    - Superseded in its mechanism by controller ruling C12 (preflight): the block shows iff the stage is a bracket kind AND the kernel's own `settleApplies` is true — fed the effective outcome, whether an abandon is ACTIVE in the ledger (so a generator's event-less void does not show it), and the module's pending-decider hook (chess phase `tiebreak`). Spec §5.1 and §5.5 say so.
20. **OWNER (resolved, ruling 82) — whose colours an armageddon uses.** BG-KO-2 says "a drawn armageddon game is won by Black". The engine knows one colour fact per fixture, `colorOfHome` (`boardgame.ts:197`, set by the pairing card at `:282+`). In FIDE practice the armageddon colours are drawn afresh, so Black in the armageddon need not be Black in the drawn game.
    - Spec §5.2 says "the side recorded as Black for that game", and the payload has no field to record it.
    - **RESOLVED — ruling 82 (owner, 2026-10-08): drop the "Drawn — Black advances" choice in W2a.** The `boardgame.tiebreak` payload has no draw field, and no error code exists for it. The scorer always taps the winner. The pad's armageddon step shows the hint "In Armageddon a draw means Black advances." (4 locales), which is BG-KO-2's W2a enforcement; its proving test asserts the hint renders on the armageddon step and not on rapid or blitz. Recording armageddon colours (`black: EntrantId`) moves to W2c (spec §2.3).
21. **Finalize after settling an abandoned match.**
    - The kernel forwards `core.finalize` to the module, and modules refuse it while their own outcome is null. Boardgame does at `boardgame.ts:636` ("cannot finalize an undecided fixture"); the executor greps the other ten.
    - A settled abandon has a null module outcome, so it could never be finalized.
    - Task 4 makes the kernel own `core.finalize` exactly when a settlement exists and the module outcome is null. The module never sees it, and a test runs it for every sport.
22. **`PadPhase` is closed at `"pre" | "live" | "post"`** (`packages/engine/src/sport/module.ts:450`), so a padSpec panel cannot declare phase `tiebreak`. The plan declares the tie-break panel as phase `live` with `gate: { op: "path-equals", path: "state.phase", value: "tiebreak" }` (`module.ts:133-139`), and gates the two live result panels on `state.phase === "live"`. Both apply only when `cfg.tiebreak === true`, so the padSpec of every existing cfg is byte-identical.
23. **The guided sheet has no free-text step** (`apps/web/src/components/v2/scorepad/v3/types.ts:828`: choice | person | number).
    - The optional tie-break score (spec §5.5 step 3) is therefore a **choice** step: "No score", "2–0" and "1½–½", oriented to the winner and shown for rapid and blitz only.
    - Games per match and rung configuration are W2c's (spec §2.3). Two games per rung is the FIDE World Cup default, and the engine still validates any chess score string an API caller sends.
    - It is recorded as decision D6.
24. **Appending `Settle` to `COMMAND_KINDS` would change every committed fast-check replay.** `modelCommands` builds its arbitraries from `COMMAND_KINDS` in order (`tools/matrix/lib/model/commands.ts:412-416`), and `catalogue/regressions.json` replays by seed and path.
    - Settle is therefore opt-in (`modelCommands({ …, settle: true })`), and the default arbitrary set is unchanged.
    - A test replays every committed regression unchanged.
25. **`fixture-console.tsx` is the R7 component.** The competition-desk index warns that "Fixture Console" in owner vocabulary means the division page's `?tab=fixtures` (`AGENTS.md`, live programmes). Spec §5.5 names `components/v2/fixture-console.tsx` explicitly, and that per-fixture page is where Forfeit and Abandon live (`:1390-1445`). The plan follows the spec. Task 11 also adds a "Needs a decision" chip on the run-sheet row, so the desk shows where the action is.
26. **Plan additions the orchestrator relayed as owner-approved on 2026-10-08, after the spec was written** — recorded as rulings 80 (execution model) and 81 (tooling, batching and CI additions). The spec's §9 and §10 now cite them; the original wording is quoted below for the record.
    - **(a) Models.** Spec §10 says "Agent models are taken from `.claude/agents/*.md` and never overridden". The owner's W2a ruling ("use Opus and Sonnet wisely") overrides that for this wave only (Execution model). `IDX` must record it as a numbered ruling before the first dispatch (Task 0 Step 0), so no agent acts on it second-hand (class 17).
    - **(b) Local Stryker.** Spec §9 says to run locally "the legs covering the changed engine files". Here, changed-lines Stryker (Task 0b) does that per task, and family legs run only in the end-of-wave dispatched `mutation.yml` (Task 17). The probe still runs locally, once (Task 17).
    - **(c) Local truth runs** cover only the W2a cells. The full regression judge runs once, from a CI dispatch (Task 16). That dispatch counts as a weekly run (finding 17).
    - **(d) Batching.** Eighteen tasks (Task 0 and Tasks 1–17) run as ten reviewed loops plus two unreviewed evidence runs (Loops and lanes).
27. **Spec gap: Finalize on a held fixture.** The console shows Finalize whenever the fixture has an outcome (`fixture-console.tsx:798`, `decided = live.outcome !== null || live.status === "abandoned"`; Finalize at `:1404`), and the kernel accepts `core.finalize` after any decision (`POST_DECISION_CORE`, `events.ts:437`). A `needs_decision` fixture, or a bracket fixture `abandoned` with a level `no_result`, could therefore be finalized. That stores `finalized` with a level outcome: the exact shape `LEVEL_RESULT_SEATED` catches, behind a lock (`LOCKED_FIXTURE_STATUSES`) that no settle can open.
    - Spec §7 names no code for it. The plan reuses `LEVEL_RESULT_IN_BRACKET`, whose copy ("a knockout match can't end level") fits, so no new code is invented. The refusal sits in the write path (Task 8), and the console hides Finalize for a held fixture (Task 11).
    - **Folded into spec §5.4 item 3, §5.5 and §7** with the plan's approval (ruling 82), reusing `LEVEL_RESULT_IN_BRACKET`.
---

## Decisions

- **D1.** `BRACKET_KINDS` and `DRAW_KINDS` live in `packages/engine/src/core/types.ts`. They are disjoint, their union is `StageKind.options`, and the test states the empty case first.
- **D2.** The settle precondition is enforced on every fold, not only strict ones, like guarantee 4 (`events.ts:584-598`). The ledger it judges is never cfg-dependent: a level outcome stays level under the same frozen cfg.
- **D3.** The status rule, in order:
  1. an active `core.settle` → `decided` (or `finalized` when the candidate is `core.finalize`, as today);
  2. an active `core.abandon` → `abandoned`;
  3. a level outcome in `BRACKET_KINDS` → `needs_decision`;
  4. otherwise as today.

  It is ONE function, `fixtureStatusFromFold(outcome, active, stageKind)`, called by `nextStatus`, `replay.ts` and `admin-fixture-config.ts`.
- **D4.** NEW-H1's fix predicate, applied only if Task 1 reproduces it: a feeder is dead iff `status = 'cancelled'`, or `status = 'abandoned' AND outcome IS NULL AND` the ledger holds no **active** `core.abandon`. Voids are not voidable (`events.ts:176-213`), so "active" is "no row voids it".
- **D5.** The settle method strings are `settled_lot`, `settled_higher_seed` and `settled_organiser`, and the tie-break methods are `tiebreak_rapid`, `tiebreak_blitz` and `tiebreak_armageddon`. They are an exported tuple in each module, `SETTLE_METHODS` (core) and `TIEBREAK_RUNGS` (boardgame), and the vocab tables are derived from those tuples, never typed again.
- **D6.** The optional tie-break score on the pad is a choice step (finding 23). The engine accepts `^(\d+½?|½)–(\d+½?|½)$` from any caller.
- **D7.** Settle in the model is opt-in (finding 24).
- **D8.** Settle's `note` is optional, `z.string().trim().min(1).max(500)`. It is the organiser's own text, never rendered publicly: it is shown only in the console activity log.

---

## Step 0 — anchors (pinned 2026-10-08 against `c0416dea6` = `origin/main` `7dd45eeab` + the spec)

`E` = `packages/engine/src`. `W` = `apps/web/src`. `HM` = `tools/matrix`. `TR` = `docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs`. `IDX` = `docs/superpowers/specs/2026-09-27-format-matrix-prompts/_INDEX.md`.

| Fact | Where |
|---|---|
| `CoreForfeit {by: EntrantId, reason}`, `CoreAbandon {reason}` | `E/core/events.ts:51-52` |
| `CORE_EVENT_SCHEMAS`; `CoreEv` (kernel-owned types absent by design) | `E/core/events.ts:99-129`, `:130-149` |
| `POST_DECISION_CORE = ["core.note","core.finalize","core.award"]` | `E/core/events.ts:437` |
| `DURING_STOPPAGE` | `E/core/events.ts:469-490` |
| `foldMatch` / `foldMatchWithStoppage`; the module branch, where `decided = module.outcome(state) !== null` | `E/core/events.ts:505-513`, `:518-768`, `:735-750` |
| `resolveVoids`: voids are not voidable | `E/core/events.ts:176-213` |
| `EngineErrorCode` (append-only; its order is frozen by `errors.test.ts:30-60`) | `E/core/errors.ts:7-31` |
| `StageKind` (9 kinds); `MatchOutcome`; `LineupPair` | `E/core/types.ts:91-101`, `:115-139`, `:240` |
| `SportModule.supportsDraws` | `E/sport/module.ts:830` |
| `PadPhase`, `PadGate`, `PadPanel.gate` | `E/sport/module.ts:450`, `:133-139`, `:451-459` |
| `supportsDraws` bodies | boardgame `E/sports/boardgame/boardgame.ts:770`, carrom `E/sports/carrom/carrom.ts:983`, cricket `E/sports/cricket/cricket.ts:3964`, football `E/sports/football/football.ts:2666`, generic `E/sports/generic/generic.ts:650`, period `E/sports/period/kernel.ts:2644`, setbased `E/sports/setbased/kernel.ts:2469`, nested `E/sports/nested/kernel.ts:2223` |
| `BoardgameCfg`; `BoardgameState`; `decideResult`; `apply`; `summary`; padSpec panels | `E/sports/boardgame/boardgame.ts:46-79`, `:190-209`, `:243-280`, `:600-645`, `:647-680`, `:457-491` |
| carrom `tieBoard` and `decideGame` | `E/sports/carrom/carrom.ts:69`, `:306-315` |
| `forEachSport` | `E/testkit/for-each-sport.ts` |
| Golden policy: `MAX_CONFIGS`, `EXTRA_CONFIGS`, `COVERAGE_CONFIGS` | `E/testkit/golden.ts:59`, `:68`, `:785` |
| Existing four-kind bracket sets (finding 5) | `E/competition/progression.ts:232`; `W/server/engine-db/competition.ts:50`; `W/server/usecases/stages.ts:3964` |
| `LOCKED_FIXTURE_STATUSES`; `nextStatus`; `fixtureStatusFromFold` | `W/server/engine-db/append-event.ts:102`, `:117-124`, `:139-149` |
| append: stage select; `resolveFixtureCfg`; fold; outcome; draw guard; `releaseFedSeats`; status; fixtures update | `W/server/engine-db/append-event.ts:201-204`, `:270`, `:300-327`, `:329`, `:335-346`, `:358`, `:386`, `:403-410` |
| `resolveFixtureCfg`; `stageScopedCfg`; `STAGE_DECIDER_KEYS` | `W/server/engine-db/fixture-cfg.ts:39-46`; `W/server/engine-db/stage-cfg.ts:18-40` |
| `bracketWinnerLoser` and its false comment (R28); `toBracketFixture` | `W/server/engine-db/competition.ts:144-163`, `:179-195` |
| `advancingSides` | `W/server/engine-db/fed-seats.ts:97-103` |
| `onDecided`, gated on `outcome !== null \|\| type === "core.void"` | `W/server/usecases/scoring.ts:294`, `:701-760` |
| Device-link and scorer gates | `W/server/usecases/scoring.ts:501-559` |
| `subjectToScorerCapabilityGates` | `W/server/usecases/scorers.ts:46-50` |
| `AUTHORITY_ONLY_EVENT_TYPES` (client) | `W/components/v2/scorepad/v3/pad-host.tsx:727-730` |
| `feederIsDead`; `resolveBracketSeats` `SeatRow` query; cascade writes `abandoned` without events | `W/server/usecases/stages.ts:3657-3660`, `:3831-3836`, `:3863` |
| `engineFixtureStatus` default → `scheduled` | `W/lib/fixture-engine-status.ts` |
| Console: `scoring` flag; match actions; `ForfeitButton`; `TextPromptDialog` | `W/components/v2/fixture-console.tsx:769`, `:1390-1445`, `:1474`, `:142` |
| Page: `canScore`, `canEdit`, `isOfficialScorer`; console `canEdit` prop | `W/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/f/[no]/page.tsx:59-62`, `:259` |
| `loadFixturePadCfg` (both pads read it) | `W/server/usecases/fixtures.ts:98-117`; device page `W/app/score/[token]/page.tsx:267` |
| `resolveScorePadBootstrap`; `ScorePadBootstrap.resolvedConfig`; `PadHostView` (no stage kind) | `W/server/usecases/fidelity.ts:44-70`; `W/components/v2/scorepad/registry.tsx:183`, `:198`, `:294-296`; `W/components/v2/scorepad/v3/types.ts:1400-1411` |
| Boardgame skin `resolvePhase`, `DRAW_TILE_ID`, `buildTiles`, `buildSheets` | `W/components/v2/scorepad/v3/skins/boardgame.tsx:230-235`, `:381`, `:383-411`, `:463-465` |
| Generic skin `allowsDraws(cfg)` and its 4 readers | `W/components/v2/scorepad/v3/skins/generic.tsx:176`, `:357`, `:380`, `:440`, `:506` |
| Guided sheet step kinds | `W/components/v2/scorepad/v3/types.ts:685`, `:738`, `:800`, `:828` |
| `DECIDED_METHOD_KEY`; `decidedOutcomeTemplates`; `renderDecidedOutcome` | `W/lib/scoring-vocab.ts:1298-1303`, `:1375-1388`, `:1400-1430` |
| `ENGINE_ERROR_KEY` | `W/lib/scoring-vocab.ts:583-610` |
| `ENGINE_HTTP: Record<EngineErrorCode, number>`; 403 → `FORBIDDEN` | `W/server/api-v1/http.ts:19-75`, `:80` |
| Public status enum | `W/server/api-v1/schemas.ts:1658` |
| `matchCentre.result.*` (public.json); `fixture.decidedBy.*`, `engineError.*` (ui.json) | `W/dictionaries/en/public.json:184-206`; `W/dictionaries/en/ui.json:3369-3377`, `:3872` |
| `STATUS_LINE_KEYS`; `WIN_METHODS`/`RESULT_KINDS`; `resultMsg`; bracket winner | `W/server/public-site/competition-hub.ts:152-158`; `W/server/public-site/match-centre.ts:175-176`, `:722-760`; `W/components/public-site/bracket.tsx:121` |
| Fixture status check constraint | `db/migration/v2-engine/tables/V214__fixtures.sql:21-22` |
| Highest delta, so the new one is V431 | `db/migration/deltas/V430__capture_stream_codes.sql` |
| Harness: `generateStream`, `OutcomeUnreachable`, `matchesRequest`; `RequestedOutcome`; `drawsAllowed` | `HM/lib/streams/index.ts:46-78`; `HM/lib/streams/types.ts`; `HM/lib/sport-cfg.ts:81` |
| `defaultPolicy`, `decideFixture` (folds with `ctx.cfg`), `decideRound`, `stageDrawsOk` | `HM/lib/scenarios/common.ts:461`, `:469-532`, `:568-575`, `:580` |
| carrom `TIEBOARD_DRAW` refusal | `HM/lib/streams/carrom.ts:11`, `:19-21` |
| `COMMAND_KINDS`; `Cmd`; `modelCommands` | `HM/lib/model/state.ts:31`; `HM/lib/model/commands.ts:105-160`, `:412-416` |
| pad adapters; `outcomesFor` | `HM/lib/pads/boardgame.ts`, `HM/lib/pads/carrom.ts`; `HM/__tests__/pad-adapters.test.ts:54-61` |
| `@seazn/reference` skeleton (`FAMILIES` empty and frozen) and its test | `packages/reference/src/index.ts`, `packages/reference/src/index.test.ts` |
| Reference boundary gate | `scripts/reference-boundary.ts` |
| Committed-evidence sweep `EVIDENCE_DIRS`; lock | `HM/__tests__/committed-matrix.test.ts:71-79`; `TR/plans.lock.json` |
| Baseline reproduce recipe; triage case ids | `TR/w1d-baseline/README.md`; `TR/TRIAGE.md` |
| Stryker groups: core `core-1..3`; modules `modules-1..7`; boardgame `sports-other-1,2,6`; carrom `sports-other-3..6`; generic `sports-other-3,7` | `packages/engine/stryker.groups.mjs` |
| `mutation.yml` dispatch input `group`; floors judged per family, a partial family "not judged" | `.github/workflows/mutation.yml:31-48`; `packages/engine/scripts/stryker-floor.ts:18-22` |
| Root scripts `i18n:gen-keys`, `openapi:gen`, `test:smoke` | `package.json:61`, `:67`, `:47` |

Before building on any line above, the executor pins it again (AGENTS class 5). A line that has moved is a note in the task report, not a blocker. A line whose MEANING is false is a false premise: add it to `IDX` "False premises found" (W2a) and continue.

---

## Global Constraints

- **Worktree.** `/Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a`, branch `feat/format-matrix-w2a`.
  - Every shell command starts `cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a && …`, because cwd resets to the main checkout between calls.
  - Never edit the main checkout. **Never `git stash`**: the stack is shared.
  - **No heredocs.** Write commit messages with the Write tool to `$TMPDIR/w2a-msg.txt`, then run `git commit -F "$TMPDIR/w2a-msg.txt" -- <paths>`. Every message ends with a blank line and the `Co-Authored-By:` line the committing agent's own system prompt gives.
- **Setup once (Task 1 Step 1):**
  - `pnpm install --frozen-lockfile`;
  - symlink `.env.local` and `apps/web/.env.local` from the main checkout;
  - check that `readlink -f node_modules/@seazn/engine` resolves inside the worktree;
  - symlink `.claude/agent-memory` and add it to the worktree's own `info/exclude` (`seazn-local-env` §2).
- **Local env.** Follow `~/.claude/skills/seazn-local-env/SKILL.md`, using `S=~/.claude/skills/seazn-local-env/scripts/seazn-env.sh`, label `w2a`:
  - `$S up --label w2a --all` (fresh pg + `db:apply` + `sync:sports` + prod server);
  - `eval "$($S env --label w2a)"`;
  - `psql "$DATABASE_URL" -Atc "show data_directory"` must equal the label's datadir, and that path is `BENCH_EXPECTED_DATA_DIR`;
  - after a code change, `$S rebuild --label w2a`, never a second `up`;
  - `SMOKE_BASE=http://localhost:<port>` (never 127.0.0.1, never 3000 or 3100);
  - `NEXT_PUBLIC_SCOREPAD_HOLD_MS=3000` for every matrix browser run.
- **Local verification = ONLY the tests that cover the files you changed.** Never the full gate, the full vitest suite, the full e2e suite or `seazn-env gate`. Never a Playwright `-g` slice; run whole spec files (R18).
  - **apps/web vitest**, with `<N>` = the task number:
    ```bash
    cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a/apps/web && rm -f "$TMPDIR/w2a-t<N>.json" && pnpm vitest run <paths> --reporter=json --outputFile="$TMPDIR/w2a-t<N>.json"; echo EXIT=$?
    ```
  - **Engine vitest:**
    ```bash
    cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a/packages/engine && rm -f "$TMPDIR/w2a-t<N>e.json" && pnpm vitest run <paths> --reporter=json --outputFile="$TMPDIR/w2a-t<N>e.json"; echo EXIT=$?
    ```
  - **Reference vitest:** the same, from `packages/reference`, writing `"$TMPDIR/w2a-t<N>r.json"`.
  - **Harness vitest** (CI's own recipe, `ci.yml:253-257`):
    ```bash
    cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a && rm -f "$TMPDIR/w2a-t<N>m.json" && ./packages/engine/node_modules/.bin/vitest run --reporter=json --outputFile="$TMPDIR/w2a-t<N>m.json" --testTimeout=30000 <paths>; echo EXIT=$?
    ```
  - **The judge**, run after every vitest:
    ```bash
    cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a && jq -c '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests,failedSuites:.numFailedTestSuites,files:[.testResults[].name]|length,names:[.testResults[].name]}' "$TMPDIR/w2a-t<N>.json"
    ```
    Green means all of:
    - `failed == 0`;
    - `failedSuites == 0`;
    - `passed == total > 0`;
    - `files` equals the number of paths passed;
    - every name starts with this worktree's absolute path.

    Paste the line into the task report and pin `total`. Never trust an `rtk` summary: `PASS(0) FAIL(0)` is a suite that failed to collect. A vitest positional is a literal filename filter, so a typo silently runs a subset.
  - `.env.local` must be the symlinked file, not a copy, or DB suites skip while `total` stays unchanged. A `--outputFile` from a refused config is STALE: delete it first, as the template does.
- **tsc and eslint, changed files only.**
  - tsc: `cd <wt>/apps/web && rtk proxy node ../../node_modules/typescript-native/bin/tsc --noEmit -p tsconfig.json; echo EXIT=$?`. The app tsconfig is one project; run it once per task that touches `apps/web`, never `pnpm exec tsc`, which rtk rewrites (memory).
  - Engine: `cd <wt>/packages/engine && rtk proxy node ../../node_modules/typescript-native/bin/tsc --noEmit; echo EXIT=$?`.
  - Harness tests: `cd <wt> && rtk proxy node node_modules/typescript-native/bin/tsc -p tsconfig.tools-tests.json; echo EXIT=$?`.
  - eslint: `cd <wt> && rtk proxy ./node_modules/.bin/eslint <changed files>; echo EXIT=$?`. It is clean only with `EXIT=0` and `✖` absent.
- **`grep -a` always**, through `rtk proxy grep -a …` when the full output matters.
- **Golden corpus** (`E/testkit/GOLDEN-POLICY.md`).
  - Never `UPDATE_GOLDEN` or `REBASELINE_GOLDEN`. W2a only appends, with `EXTEND_GOLDEN=1`, in a commit of its own (Task 5).
  - Every new cfg field is `.optional()` with no default (finding 12).
- **Strings** (R23). Every new user-facing string goes into `W/dictionaries/{en,fr,es,nl}/` in the same commit, followed by `pnpm i18n:gen-keys` (root) and `pnpm i18n:check`. `i18n-keys.ts` is generated, so never edit it by hand.
- **Boundary.**
  - `packages/reference` imports `@seazn/engine` only as `import type` from `@seazn/engine/core` (R7; `scripts/reference-boundary.ts`), and nothing from `apps/web`.
  - `tools/` is never imported by `apps/`, `packages/` or `scripts/` (ruling 56).
  - The harness reads product facts as text, never by a relative import of `apps/web` runtime code.
- **Do not touch:**
  - `tools/bench/lib/suites/run-suite.ts` and `PackSchema` (R3);
  - committed `TR/**` evidence (a new run only ADDS a directory and a lock entry);
  - `.github/workflows/e2e.yml`;
  - any golden file except by `EXTEND_GOLDEN=1`.
- **Test authority** (TEST-STRATEGY rules 1–10; R9, R13, R16, R25, R26, R28, R29).
  - Every task lists its state transitions and its **empty case first**: a second call, an empty input, after a withdrawal or void, and another sport.
  - Expected values come from the **rule rows** (`packages/engine/rules/*.md`, Task 2) and the engine's declarations: `StageKind.options`, `BRACKET_KINDS`, `DRAW_KINDS`, `SETTLE_METHODS`, `TIEBREAK_RUNGS`, `module.bracketDeciders`, `module.supportsDraws`. Never from a table typed into the test.
  - Every sweep returns its count, and **zero checked is a failure**.
  - Sport sweeps go through `forEachSport` (R26). A single-sport test carries a one-line reason, and the `pnpm matrix:single-sport --check --against HEAD^1` ratchet stays green.
  - Each guard gets one case where the right answer differs from the wrong one's constant.
  - Tests that do real work state their budget from their work (memory: CI coverage is about 5× slower). The shape is `const BUDGET_MS = Math.max(5_000, cases * PER_CASE_MS * 5)`, passed as the test's timeout argument.
- **Mutation, per member** (R17; spec §9), always through the Task 0 tooling. Never mutate by hand.
  - **Hand mutants (every task, any code).** The task's mutation step names each guard mutant as `{id, file, find, replace, killers}` in `MUT/t<N>.json`, where `MUT` = `docs/superpowers/specs/2026-09-27-format-matrix-prompts/mutants/w2a`. Then run:
    ```bash
    cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a && pnpm mutate --list docs/superpowers/specs/2026-09-27-format-matrix-prompts/mutants/w2a/t<N>.json --json-out "$TMPDIR/w2a-mut-t<N>.json"; echo EXIT=$?
    ```
    The expected result is `EXIT=0`: every row reads `KILLED by <test names>`, 0 survived, and the file is restored byte-identical. Paste the table into the task report. RULES.md asks for the killer list, not a count.
  - The runner applies **one mutant at a time** (grouped mutants hide survivors), runs only that mutant's killers, and restores the saved original bytes. Restoring with `git checkout` would discard the task's own uncommitted work.
  - **Changed-lines Stryker (engine code only)**, as well as the hand mutants:
    ```bash
    cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a/packages/engine && rm -f reports/mutation/changed.json && M="$(node scripts/stryker-changed.mjs --base "$TASK_BASE")" && STRYKER_MUTATE="$M" pnpm mutation > "$TMPDIR/w2a-stryker-t<N>.log" 2>&1; echo EXIT=$?; node scripts/stryker-changed.mjs --report reports/mutation/changed.json --expect "$M"
    ```
    - **Changed-lines Stryker base (controller ruling, Task 0b review ⚠️2):** `TASK_BASE` is the commit the controller recorded before dispatching the loop (given in every dispatch), not the merge base — each task mutates only its own lines. The old report is deleted first and the run is chained with `&&`; `--report … --expect "$M"` refuses a report that is not this run's (I-2). A run whose ranges yield zero mutants (type-only change) exits 2: the task records "no mutable lines" with the `--base` output in its report instead of a verdict table.
    The expected result is `survived: 0, noCoverage: 0`, with a `killedBy` test name for every killed mutant.
    - A survivor gets a killing test, or, if it is truly equivalent, a row in the task report: the mutant, why no input can tell it apart, and the reviewer's agreement.
    - Never `// Stryker disable`. The engine has none today (`grep -arc "Stryker disable" packages/engine/src` returns 0 for every file).
  - Mutate each member once: per outcome kind, per stage kind, per event × authority, per rung. Two guards that cover for each other are separate mutants, each with its own killer.
  - Family legs (`mutation.yml`) run **once, on CI, at the end** (Task 17). Never locally.
- **Truth runs, during development: only the W2a cells.** Never the whole matrix locally.
  - The selection is `TR/w2a-local-selection.json`: `{ "cases": [{ "layer", "only", "scenario" }], "newScenarios": [<scenario keys>] }`. Task 1 writes `cases`, from the 77; Task 14 writes `newScenarios`.
  - The command (`<tag>` names the run):
    ```bash
    S=~/.claude/skills/seazn-local-env/scripts/seazn-env.sh; cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a && eval "$($S env --label w2a)" && export BENCH_EXPECTED_DATA_DIR="$(psql "$DATABASE_URL" -Atc 'show data_directory')" NEXT_PUBLIC_SCOREPAD_HOLD_MS=3000 && SEL=docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w2a-local-selection.json && OUT="$TMPDIR/w2a-local-<tag>" && rm -rf "$OUT" && i=0 && jq -r '.cases[] | select(.layer=="L3") | [.only,.scenario] | @tsv' $SEL | sort -u | while IFS=$'\t' read -r C K; do i=$((i+1)); pnpm matrix:l3 --set w1-driving --only "$C" --scenario "$K" --workers 4 --run-id "w2a-<tag>-$i" --report-dir "$OUT/L3" > "$OUT.$i.log" 2>&1; echo "L3 $C $K EXIT=$?"; done; for L in L1 L2; do jq -r ".browserShards.$L[]" $SEL | while read -r k; do pnpm matrix:browser --layer $L --scope grid --shard "$k/64" --run-id "w2a-<tag>-$L-s$k" --report-dir "$OUT/$L" > "$OUT.$L-s$k.log" 2>&1; echo "$L stripe $k EXIT=$?"; done; done; jq -r '.newScenarios[]' $SEL | while read -r K; do pnpm matrix:l3 --set w1-driving --scenario "$K" --workers 4 --run-id "w2a-<tag>-new-$K" --report-dir "$OUT/L3" > "$OUT.new-$K.log" 2>&1; echo "new $K EXIT=$?"; done
    ```
    - **L1/L2 cells run by grid stripe (Task 1 finding, ruled 2026-10-08):** `--only` with `--layer L1|L2` is refused outside the 6-cell slice, so L1/L2 cells are reached by their stripe (`browserShards` in the selection; stripe k of 64 holds plan items i with i mod 64 = k-1). A stripe also drives 2-4 non-W2a cases; the judge checks only the expected ids, and a lock entry for a stripe run is restricted to that stripe.
    Every line must print `EXIT=0` or `EXIT=1`. `EXIT=2` (refused) or `EXIT=3` (aborted) is an environment fault (Task 1 Step 3).
  - The judge is the Task 1 Step 5 node check, pointed at `$OUT` with the expectation the task states.
  - The **full** `matrix:judge regression` runs ONCE, at the end, on a CI dispatch of `matrix-truth.yml` (about 20 minutes; Task 16). Never locally.
- **Rule-10 sequences.** Any ordered-action surface this wave touches gets a fast-check sequence test with invariants after every step: the fold (settle, void, finalize, abandon) and the model's Settle. A shrunk failure becomes a named regression case with its seed in the same suite, committed **before** the fix (R29).
- **The four test types per task** (RULES.md). A task with no literal UI traces its E2E forward to a named later task's spec file. Smoke and regression are owed per task, or traced forward to Task 17's smoke suite and Task 16's judge regression, by name.
- **Docs as they happen** (R22). Each task's commit updates `IDX`'s W2 row and adds to "False premises found" when it found one.

---

## Review Focus

Five inputs the spec implies but no requirement names. Each line's test is written into the owning task.

1. **The organiser voids a settle.** A reasonable organiser expects the fixture to go back to "Needs a decision" and the seat it filled to empty, or, once the next match has started, a 409 `NEXT_MATCH_STARTED` that changes nothing. Test: Task 8 Step 1, `settle-seating.test.ts` "void of a settle".
2. **Double submit of the settle dialog, or two organisers settling at once.** Exactly one settle is accepted. The second is refused `SETTLE_NOT_APPLICABLE` (or `SEQ_CONFLICT` when it raced), the dialog shows the reason, and nobody is seated twice. Tests: Task 4 Step 1 "a second settle is refused"; Task 11 Step 4 e2e "double submit".
3. **Finalizing a settled abandon.** The organiser expects Finalize to lock it like any decided fixture. Test: Task 4 Step 1 "finalize after settling an abandon", for every sport (finding 21).
4. **A chess knockout fixture scored before deploy** has a frozen cfg without `tiebreak`, and its drawn game arrives after deploy. It must land in `needs_decision` and be settleable, never refused and never a stall. Test: Task 6 Step 1 "a frozen snapshot without deciders keeps them out" plus Task 8 Step 1 "frozen chess draw holds then settles".
5. **One side of a `needs_decision` fixture withdraws.** The fixture must not stay stuck with no action. Controller ruling C17: it stays `needs_decision` (the bracket cascade skips it), the block stays, a settle naming the withdrawn entrant is refused `SETTLE_NOT_APPLICABLE` (reason `withdrawn`), and a settle to the remaining entrant seats them. Auto-walkover of a held fixture is W2b's. Test: Task 8 Step 1 "Review Focus 5 (ruling C17) …".

---

## Execution model (ruling 80, W2a only)

The orchestrator relayed the owner's ruling on 2026-10-08: "use Opus and Sonnet wisely". Like W1d's ruling 69, it authorises a per-dispatch model override **for W2a only**. Outside this table, `.claude/agents/*.md` decides. The principle:
- **Opus** where a miss can pass a green suite, or where the judgement is about semantics, security or the oracle.
- **Sonnet** where the spec dictates the output exactly, and an Opus review or the work's own tests catch errors.

| Loop | Tasks | Implementer | Reviewer |
|---|---|---|---|
| A | 0a mutation runner (it has its own tests) | Sonnet | Opus |
| B | 0b changed-lines Stryker config (touches the floor and gate machinery) | Opus | Opus |
| E1 | 1 reproduce first: truth run plus evidence commit | Sonnet | none; the orchestrator re-checks the counts |
| C | 2 rules reference seed plus checker | Sonnet | Sonnet |
| D | 3, 4, 5 engine batch: allow-lists and sweep, `core.settle`, `bracketDeciders`, boardgame tie-break, carrom | Opus | Opus |
| F | 6, 7, 8, 9 web batch: `resolveFixtureCfg` callers, `needs_decision` migration and sweep, write and seating guards, and the organiser-only gate (security) | Opus | Opus |
| G | 10 NEW-H1 diagnosis and fix | Opus | Opus |
| H | 11, 12, 13 UI: console block and settle dialog, pad stage kind and chess three steps, public strings in 4 locales | Sonnet | Opus |
| P1 | 14 harness: generator breadth, model Settle, adapters, page objects | Sonnet | Opus |
| P2 | 15 reference family `bracket-finish` (R8's independent oracle) | Opus, a **different agent** from loop D's implementer | Opus |
| E2 | 16, 17 final truth run, CI judge regression, `MATRIX.md` regen, screenshot capture, CI dispatches, PR body | Sonnet | none; the orchestrator re-checks |
| R | whole-branch review | none | Opus |
| — | pure locate scouts | Sonnet | none |
| — | scouts that verify a claim the plan or a fix depends on | Opus | none |

Every dispatch names its model explicitly, from this table.

## Loops and lanes

Ten reviewed loops (A, B, C, D, F, G, H, P1, P2, R) and two unreviewed evidence runs (E1, E2), not seventeen dispatches.
- **Batching.** Same-file tasks share one implementer → reviewer loop (RULES.md batching rule):
  - **D (3–5):** `events.ts`, `types.ts` and the module files are shared.
  - **F (6–9):** `append-event.ts`, `fold.ts`, `scoring.ts` and `stages.ts` are shared. Task 9's organiser gate sits in `scoring.ts` beside Task 8's `onDecided` change, so it joins F. Its security questions are a named section of F's review.
  - **H (11–13):** `ui.json`/`public.json` in 4 locales and `scoring-vocab.ts` are shared.
- **`IDX` stays on the main worktree.** No lane worktree (A, B, P1, P2) edits `_INDEX.md`, `plans.lock.json`, `w2a-local-selection.json` or `MATRIX.md`, which avoids merge conflicts. A lane reports its `IDX` lines and selection keys, and the orchestrator commits them on `feat/format-matrix-w2a`. Main-worktree loops (C, D, F, G, H) and runs (E1, E2) run one at a time, and they write `IDX` themselves.

| Loop / lane | Where | File set (disjoint by construction) | Waits on |
|---|---|---|---|
| A | worktree `format-matrix-w2a-mutate` | `scripts/mutate.ts`, `scripts/__tests__/mutate.test.ts`, `scripts/__tests__/fixtures/mutate/**`, root `package.json` (`mutate` script only), `.gitignore` (one line), `MUT/t0a.json` | nothing; starts at once |
| B | worktree `format-matrix-w2a-stryker` | `packages/engine/stryker.config.mjs`, `packages/engine/scripts/stryker-changed.mjs`, `packages/engine/scripts/stryker-changed.d.mts`, `packages/engine/test/stryker-changed-lines.test.ts`, `packages/engine/test/stryker-config-groups.snap.json`, `MUT/t0b.json` | nothing; starts at once, parallel with A |
| E1 | main W2a worktree | `TR/w2a-repro/**`, `TR/w2a-local-selection.json`, `TR/plans.lock.json`, `apps/web/e2e/bracket-new-h1.spec.ts`, `IDX` | nothing; parallel with A and B, and before ANY product change |
| C | main W2a worktree | `packages/engine/rules/**`, `packages/engine/test/rules-reference{,.test}.ts`, `MUT/t2.json` | A merged (its mutation step needs the runner) |
| D | main W2a worktree | Task 3–5 files, which include `tools/matrix/lib/fold.ts` and `tools/matrix/lib/model/ledger-fold.ts` (Task 4's `outcomeOf` readers; preflight C9), and `MUT/t3.json`–`t5.json` | A, B and C merged |
| **P2** | worktree `format-matrix-w2a-reference`, a **different agent** (R8) | `packages/reference/**`, `MUT/t15.json` | C merged: the rule rows are its only input besides the spec. Starts parallel with D. Its Step 4 (the `BRACKET_KINDS` cross-check) waits on D merged and merged into the lane (preflight C28) |
| **P1** | worktree `format-matrix-w2a-harness` | `tools/matrix/**` EXCEPT `tools/matrix/lib/fold.ts` and `tools/matrix/lib/model/ledger-fold.ts` (loop D's until D merges into the lane; preflight C9), `MUT/t14.json`, plus `newScenarios` in `TR/w2a-local-selection.json` (written by the orchestrator from P1's report) | Writing code: the names in D's, F's and H's **Interfaces** blocks, which this plan freezes (`core.settle`, `SETTLE_METHODS`, `boardgame.tiebreak`, `TIEBREAK_RUNGS`, status `needs_decision`, the four error codes, the testids in Task 11). Its gate: D merged (unit tests fold through the real engine); its page-object drive: H merged. Starts parallel with D |
| F | main W2a worktree | Task 6–9 files | D merged |
| G | main W2a worktree | `apps/web/src/server/usecases/stages.ts` (`feederIsDead` and the `SeatRow` select only), `apps/web/src/server/usecases/__tests__/dead-feeder-cascade.test.ts`, `apps/web/e2e/bracket-new-h1.spec.ts` (comment only), `MUT/t10.json` | F merged (shares `stages.ts`) and E1's verdict |
| H | main W2a worktree | Task 11–13 files | F merged (and D) |
| E2 | main W2a worktree | `TR/w2a-*`, `MATRIX.md`, `IDX`, screenshots | every loop merged |
| R | read-only | the whole branch | E2's CI dispatches green |

- **Lane worktrees** start from the branch and merge back with a merge commit (never a squash), after the lane's scoped gate is re-run **on the merged tree**:
  ```bash
  cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a && git worktree add ../format-matrix-w2a-<lane> -b feat/format-matrix-w2a-<lane> feat/format-matrix-w2a; echo EXIT=$?
  cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a && git merge --no-ff feat/format-matrix-w2a-<lane> -m "Merge lane <lane> into W2a"; echo EXIT=$?
  ```
  Each lane worktree gets its own `pnpm install --frozen-lockfile` and `.env.local` symlinks (Global Constraints, setup).
- **A lane edit outside its file set stops the lane.** A production change that forces a test edit in another lane's files means stop and sequence (R2).

## File structure

| Path | Responsibility | Task |
|---|---|---|
| `scripts/mutate.ts` (+ `scripts/__tests__/mutate.test.ts`, fixtures) | Hand-mutant runner: one mutant at a time, killers named, restored byte-identical | 0a |
| `packages/engine/stryker.config.mjs`, `packages/engine/scripts/stryker-changed.mjs` (+ test) | Changed-lines Stryker (`STRYKER_MUTATE`); group config unchanged when unset | 0b |
| `docs/superpowers/specs/2026-09-27-format-matrix-prompts/mutants/w2a/t<N>.json` (`MUT`) | Each task's hand-mutant list, committed with the task | every task |
| `TR/w2a-repro/` | Evidence that the 77 reds and NEW-H1 reproduce before any product change | 1 |
| `TR/w2a-local-selection.json` | The W2a cells local truth runs drive (Global Constraints) | 1, 14 |
| `apps/web/e2e/bracket-new-h1.spec.ts` | NEW-H1 probe: a set-sport knockout semi abandoned from the console, then the final read. Kept after the fix as its regression | 1, 10 |
| `packages/engine/rules/{README,cross-sport,boardgame,carrom,generic,cricket}.md` | Rule rows (ruling 75) | 2 |
| `packages/engine/test/rules-reference.test.ts` | Checker: parses rows, ids unique, every signed row proved by a test that names it | 2 |
| `E/core/types.ts` | `BRACKET_KINDS`, `DRAW_KINDS`, `forbidsLevelResult`, `isLevelOutcome` | 3 |
| `E/sport/supports-draws.test.ts` | 11 sports × 9 kinds sweep (X-DR-1) | 3 |
| `E/core/events.ts`, `E/core/errors.ts` | `core.settle`, `Settlement`, `outcomeOf`, the four new error codes | 4 |
| `E/core/settle.test.ts` | Settle precondition, void, finalize, stoppage, a per-sport sweep and a rule-10 sequence | 4 |
| `E/sport/module.ts` + every module | `bracketDeciders(cfg)` | 5 |
| `E/sports/boardgame/boardgame.ts` | `tiebreak` cfg, phase `tiebreak`, `boardgame.tiebreak` event, padSpec panel | 5 |
| `E/sports/boardgame/tiebreak.test.ts`, `E/sport/bracket-deciders.test.ts` | BG-KO-1/2, CA-KO-1, per-sport declarations | 5 |
| `W/server/engine-db/fixture-cfg.ts` | `resolveFixtureCfg(snapshot, divisionCfg, stage, module)`, with the bracket overlay | 6 |
| `W/server/engine-db/__tests__/bracket-overlay-callers.test.ts` | Per-caller proof that the overlay reaches all 11 sites | 6 |
| `db/migration/deltas/V431__fixture_status_needs_decision.sql` | Status value, plus the legacy backfill (finding 7, ruling 82) | 7 |
| `W/lib/fixture-status.ts` | `FIXTURE_STATUSES`, `FIXTURE_STATUS_CLASS` (played / not finished / needs attention) | 7 |
| `W/lib/__tests__/status-set-sweep.test.ts` + `W/lib/__tests__/status-set-ledger.ts` | Counted sweep of every status set in TS and SQL | 7 |
| `W/server/engine-db/append-event.ts`, `fold.ts`, `replay.ts`, `usecases/admin-fixture-config.ts` | Stage-aware status rule | 7 |
| `W/server/engine-db/level-seat.ts` | `assertNoLevelSeat` (`LEVEL_RESULT_SEATED`) | 8 |
| `W/server/engine-db/__tests__/settle-seating.test.ts` | Write guard, hold, settle seats both, void, withdrawal | 8 |
| `W/lib/organiser-only-events.ts` | `ORGANISER_ONLY_EVENT_TYPES` (client-safe) | 9 |
| `W/server/usecases/stages.ts` (`feederIsDead`) | NEW-H1 predicate (D4) | 10 |
| `W/components/v2/needs-decision.tsx` | The "Needs a decision" block and the settle dialog | 11 |
| `W/components/v2/fixture-console.tsx`, the fixture page | Mount the block; `canOrganise` | 11 |
| `W/components/v2/scorepad/v3/skins/{boardgame,generic}.tsx`, `types.ts`, `registry.tsx`, `fidelity.ts`, `usecases/fixtures.ts` | Stage kind on the pad; Draw hidden; the 3-step tie-break | 12 |
| `W/lib/scoring-vocab.ts`, `W/server/public-site/{match-centre,competition-hub}.ts`, `W/components/public-site/bracket.tsx` | Public sentences and status | 13 |
| `HM/lib/streams/*`, `HM/lib/scenarios/common.ts`, `HM/lib/sport-cfg.ts`, `HM/lib/model/*`, `HM/lib/pads/*`, `HM/lib/browser/pages/fixture-console.ts` | Generator breadth, bracket policy, Settle, adapters | 14 |
| `packages/reference/src/families/bracket-finish.ts` (+ test) | Reference family (R8 agent) | 15 |
| `TR/w2a-*`, `MATRIX.md` | Truth run, judge regression, evidence | 16 |
| `apps/web/e2e/bracket-finish.spec.ts`, `apps/web/e2e/mobile.spec.ts`, `scripts/smoke.ts` | E2E, widths, smoke | 11, 12, 17 |

---

### Task 0: Mutation tooling — the hand-mutant runner (0a) and changed-lines Stryker (0b), before every other task

**Loops A (0a) and B (0b), in parallel worktrees. The models are in Execution model.**

**Where the runner lives, and why: `scripts/mutate.ts`.**
- It is a repo gate that spans workspaces: it mutates `apps/web`, `packages/engine`, `packages/reference` and `tools/matrix` files alike. That is the shape of `scripts/engine-boundary.ts` and `scripts/reference-boundary.ts`, not of a harness.
- `tools/` holds workspace harnesses with their own `package.json` (`tools/matrix`, `tools/bench`), which `apps/` and `packages/` may never import (ruling 56).
- `scripts/__tests__/**` already runs in CI (`ci.yml:786-787`), so the runner's own test is gated with no workflow edit.
- Changed-lines Stryker stays inside `packages/engine`, next to the config it extends (`stryker.config.mjs`, `scripts/stryker-*.mjs`).

**Files (0a):**
- Create: `scripts/mutate.ts`, `scripts/__tests__/mutate.test.ts`, `scripts/__tests__/fixtures/mutate/sum.src.txt`, `scripts/__tests__/fixtures/mutate/sum.spec.txt`
- Modify: root `package.json` (`"mutate"` script), `.gitignore` (`scripts/.mutate-selftest-*/`)

**Files (0b):**
- Create: `packages/engine/scripts/stryker-changed.mjs`, `packages/engine/scripts/stryker-changed.d.mts`, `packages/engine/test/stryker-changed-lines.test.ts`, `packages/engine/test/stryker-config-groups.snap.json` (the pre-0b group configs; preflight C4)
- Modify: `packages/engine/stryker.config.mjs`

**Interfaces:**
- Produces (0a): `pnpm mutate --list <file.json> [--json-out <file>]`. The list is a JSON array of `Mutant`:
  ```ts
  export interface Killer { cwd: string; files: string[]; name?: string }   // cwd repo-relative; files relative to cwd; name = vitest -t
  export interface Mutant { id: string; file: string; find: string; replace: string; killers: Killer[] }   // file repo-relative
  export type Verdict = { id: string; state: "KILLED"; killedBy: string[] } | { id: string; state: "SURVIVED" };
  ```
  Exit codes:
  - `0`: at least one mutant, and every one was killed.
  - `1`: any survivor.
  - `2`: a refused list:
    - zero mutants, or a duplicate mutant id;
    - a `find` matching 0 or more than 1 times;
    - a killer with no `files` (it would run the whole suite);
    - a killer baseline that is red before any mutation;
    - a killer that wrote no JSON report, passed no test on the baseline, or ran no test under the mutant (three guards, three messages);
    - a file not restored byte-identical.
  - The runner runs **vitest killers only**. A guard whose only witness is an e2e or smoke run gets a pure helper with a unit killer instead (Tasks 11 and 17); e2e and smoke never appear in a `MUT/*.json`.
- Produces (0b):
  - Env `STRYKER_MUTATE="<src path>:<a>-<b>[,…]"` on `pnpm mutation`. When it is set, `STRYKER_GROUP` is not read, the run is `changed` (`reports/mutation/changed.json`, never incremental), and `mutate` is exactly the ranges given.
  - `node scripts/stryker-changed.mjs --base <ref>` prints that value from `git diff -U0 <ref> -- src`.
  - `node scripts/stryker-changed.mjs --report <changed.json> --expect "<ranges>"` (refuses with exit 2 a report whose `config.mutate` or mutants do not match the ranges) prints the verdict table and exits non-zero on any `Survived` or `NoCoverage`.
  - With `STRYKER_MUTATE` unset, the config is byte-for-byte the committed pre-0b snapshot, for every group. No test reads git history (CI's engine checkout is shallow).
  - `--base` also mutates NEW untracked src files whole (`git diff` cannot see them).

- [ ] **Step 0 (orchestrator, before dispatch): record the owner's W2a rulings in `IDX`.** The orchestrator records them as rulings 80 (execution model, finding 26a), 81 (the tooling, batching and CI additions) and 82 (plan approval with the answers to findings 7 and 20 and to Task 11's layouts), so the dispatches cite a ruling, not a relay. No dispatch edits `_INDEX.md` for these.

- [ ] **Step 1 (0a): the fixture files and the failing self-test**

`scripts/__tests__/fixtures/mutate/sum.src.txt`, which becomes `sum.ts` in the self-test's scratch directory:

```ts
export const add = (a: number, b: number): number => a + b;
export const isPositive = (n: number): boolean => n > 0;
```

`scripts/__tests__/fixtures/mutate/sum.spec.txt`, which becomes `sum.test.ts`:

```ts
import { expect, it } from "vitest";
import { add, isPositive } from "./sum.ts";
it("adds", () => { expect(add(2, 3)).toBe(5); });
it("knows a positive", () => { expect(isPositive(5)).toBe(true); }); // never probes 0: n >= 0 survives
```

The `.txt` suffixes keep CI's `vitest run scripts/__tests__` from collecting the fixture as a test.

`scripts/__tests__/mutate.test.ts`:

```ts
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMutants, validateMutants, type Mutant } from "../mutate.ts";

const REPO = resolve(import.meta.dirname, "..", "..");
// Outside scripts/__tests__ on purpose: CI's `vitest run scripts/__tests__` positional is a substring filter,
// so a scratch test here can never be collected by a concurrent CI run. Gitignored (scripts/.mutate-selftest-*/).
let dir = "";
let rel = "";
const SRC = "export const add = (a: number, b: number): number => a + b;\nexport const isPositive = (n: number): boolean => n > 0;\n";
let SPEC = ""; // sum.test.ts as copied, for the restore check on a mutant of the test file itself
// Each case spawns vitest once for the baseline and once per mutant; a cold vitest start is about 2 s locally,
// and CI with coverage is about 5x slower (TEST-STRATEGY budget rule).
const SPAWNS = 3;
const BUDGET_MS = Math.max(20_000, SPAWNS * 2_000 * 5);

beforeAll(() => {
  dir = mkdtempSync(join(REPO, "scripts", ".mutate-selftest-"));
  rel = relative(REPO, dir);
  cpSync(join(REPO, "scripts/__tests__/fixtures/mutate/sum.src.txt"), join(dir, "sum.ts"));
  cpSync(join(REPO, "scripts/__tests__/fixtures/mutate/sum.spec.txt"), join(dir, "sum.test.ts"));
  SPEC = readFileSync(join(dir, "sum.test.ts"), "utf8");
});
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

const killers = () => [{ cwd: ".", files: [`${rel}/sum.test.ts`] }];
const mutant = (id: string, find: string, replace: string): Mutant => ({ id, file: `${rel}/sum.ts`, find, replace, killers: killers() });

describe("scripts/mutate.ts — one mutant at a time, restored, killers named", () => {
  it("empty case first: a zero-mutant list is refused (exit 2), never a vacuous pass", async () => {
    const r = await runMutants([], { repo: REPO });
    expect(r.exitCode).toBe(2);
    expect(r.error).toMatch(/zero mutants/);
  });

  it("reports a killed mutant with its killing test, and a survivor, and restores the file byte-identical", async () => {
    const r = await runMutants([mutant("plus-to-minus", "a + b", "a - b"), mutant("gt-to-gte", "n > 0", "n >= 0")], { repo: REPO });
    expect(r.verdicts).toEqual([
      { id: "plus-to-minus", state: "KILLED", killedBy: ["adds"] },
      { id: "gt-to-gte", state: "SURVIVED" },
    ]);
    expect(r.exitCode).toBe(1); // a survivor fails the run
    expect(readFileSync(join(dir, "sum.ts"), "utf8")).toBe(SRC);
  }, BUDGET_MS);

  it("all killed exits 0", async () => {
    const r = await runMutants([mutant("plus-to-minus", "a + b", "a - b")], { repo: REPO });
    expect(r.exitCode).toBe(0);
    expect(readFileSync(join(dir, "sum.ts"), "utf8")).toBe(SRC);
  }, BUDGET_MS);

  it("a find that matches 0 or 2+ times, or a duplicate id, is refused before any edit", async () => {
    const none = await runMutants([mutant("absent", "a * b", "a / b")], { repo: REPO });
    expect(none.exitCode).toBe(2);
    expect(none.error).toMatch(/matches 0 times/);
    const many = await runMutants([mutant("twice", "number", "string")], { repo: REPO });
    expect(many.exitCode).toBe(2);
    expect(many.error).toMatch(/matches [2-9]\d* times/);
    expect(readFileSync(join(dir, "sum.ts"), "utf8")).toBe(SRC);
    const dup = await runMutants([mutant("same", "a + b", "a - b"), mutant("same", "n > 0", "n >= 0")], { repo: REPO });
    expect(dup.exitCode).toBe(2);
    expect(dup.error).toMatch(/duplicate mutant id/);
  });

  it("a red baseline is refused: with every killer already failing, every mutant would read KILLED", async () => {
    writeFileSync(join(dir, "sum.ts"), SRC.replace("a + b", "a + b + 1"));
    try {
      const r = await runMutants([mutant("plus-to-minus", "a + b + 1", "a - b + 1")], { repo: REPO });
      expect(r.exitCode).toBe(2);
      expect(r.error).toMatch(/baseline is red/);
    } finally { writeFileSync(join(dir, "sum.ts"), SRC); }
  }, BUDGET_MS);

  it("a killer with NO files is refused before any spawn: it would run the whole suite (AGENTS.md: never)", () => {
    expect(() => validateMutants([{ ...mutant("plus-to-minus", "a + b", "a - b"), killers: [{ cwd: ".", files: [] }] }], REPO)).toThrow(/would run the WHOLE suite/);
  });

  // Three guards, three distinct messages, three cases: one shared message would let each guard hide the others.
  it("a killer whose file does not exist is refused: vitest wrote no report (a typo'd path is not a kill)", async () => {
    const r = await runMutants([{ ...mutant("plus-to-minus", "a + b", "a - b"), killers: [{ cwd: ".", files: [`${rel}/no-such.test.ts`] }] }], { repo: REPO });
    expect(r.exitCode).toBe(2);
    expect(r.error).toMatch(/wrote no JSON report/);
  }, BUDGET_MS);

  it("a killer whose -t name matches nothing is refused at the baseline (skipped tests count in numTotalTests, so the guard reads numPassedTests)", async () => {
    const r = await runMutants([{ ...mutant("plus-to-minus", "a + b", "a - b"), killers: [{ cwd: ".", files: [`${rel}/sum.test.ts`], name: "no such test name" }] }], { repo: REPO });
    expect(r.exitCode).toBe(2);
    expect(r.error).toMatch(/passed no test on the baseline/);
  }, BUDGET_MS);

  it("a killer that runs no test UNDER the mutant is refused, never read as a survivor", async () => {
    const r = await runMutants([{ id: "skip-adds", file: `${rel}/sum.test.ts`, find: 'it("adds"', replace: 'it.skip("adds"', killers: [{ cwd: ".", files: [`${rel}/sum.test.ts`], name: "adds" }] }], { repo: REPO });
    expect(r.exitCode).toBe(2);
    expect(r.error).toMatch(/ran no test under the mutant/);
    expect(readFileSync(join(dir, "sum.test.ts"), "utf8")).toBe(SPEC);
  }, BUDGET_MS);
});
```

- [ ] **Step 2 (0a): run it; see it fail**

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a-mutate && rm -f "$TMPDIR/w2a-t0a.json" && ./packages/engine/node_modules/.bin/vitest run --reporter=json --outputFile="$TMPDIR/w2a-t0a.json" --testTimeout=30000 scripts/__tests__/mutate.test.ts; echo EXIT=$?
```

Expected: `EXIT=1`, with the suite failing to collect (`../mutate.ts` is missing).

- [ ] **Step 3 (0a): implement `scripts/mutate.ts`**

```ts
// Hand-mutant runner (W2a Task 0a; R17, RULES.md "report the killer list"). For EACH mutant, alone: apply exactly one
// edit, run ONLY its named killers, record KILLED (with the killing tests' names) or SURVIVED, write the saved original
// bytes back and verify them, then the next. Never two mutants at once: a grouped mutant hides a survivor.
// Restores by writing the bytes it read, never `git checkout`: the file under test is usually the task's own
// UNCOMMITTED work, which a checkout would discard.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { isMainModule } from "./lib/main-module.ts";

export interface Killer { cwd: string; files: string[]; name?: string }
export interface Mutant { id: string; file: string; find: string; replace: string; killers: Killer[] }
export type Verdict = { id: string; state: "KILLED"; killedBy: string[] } | { id: string; state: "SURVIVED" };
export interface RunResult { exitCode: 0 | 1 | 2; verdicts: Verdict[]; error?: string }

interface VitestJson {
  numTotalTests: number; numPassedTests: number; numFailedTests: number; numFailedTestSuites: number;
  testResults: { name: string; assertionResults: { title: string; fullName: string; status: string }[] }[];
}

export class Refused extends Error {}

function occurrences(text: string, find: string): number {
  return find === "" ? 0 : text.split(find).length - 1;
}

/** One vitest run of one killer: the engine's vitest binary at the repo root (CI's own recipe for scripts/ and
 *  tools/, ci.yml:257, :787), the workspace's own `pnpm exec vitest` inside a workspace. */
function runKiller(repo: string, k: Killer): VitestJson {
  const out = mkdtempSync(join(tmpdir(), "mutate-"));
  const file = join(out, "r.json");
  try {
    const cwd = resolve(repo, k.cwd);
    const args = ["run", ...k.files, ...(k.name === undefined ? [] : ["-t", k.name]), "--reporter=json", `--outputFile=${file}`, "--testTimeout=30000"];
    const [cmd, argv] = k.cwd === "." ? [join(repo, "packages/engine/node_modules/.bin/vitest"), args] : ["pnpm", ["exec", "vitest", ...args]];
    spawnSync(cmd, argv, { cwd, encoding: "utf8", stdio: ["ignore", "ignore", "ignore"], timeout: 15 * 60_000 });
    if (!existsSync(file)) throw new Refused(`killer ${k.cwd}:${k.files.join(",")} wrote no JSON report (a missing file, or a refused config)`);
    return JSON.parse(readFileSync(file, "utf8")) as VitestJson;
  } finally { rmSync(out, { recursive: true, force: true }); }
}

function failedNames(r: VitestJson): string[] {
  return r.testResults.flatMap((f) => f.assertionResults.filter((a) => a.status === "failed").map((a) => a.fullName));
}

/** Every check that needs no spawn, before anything is touched. Exported so its refusals are tested without a vitest run. */
export function validateMutants(mutants: readonly Mutant[], repo: string): void {
  if (mutants.length === 0) throw new Refused("zero mutants: an empty list proves nothing (anti-vacuity)");
  const ids = new Set<string>();
  for (const m of mutants) {
    if (ids.has(m.id)) throw new Refused(`duplicate mutant id ${m.id}`);
    ids.add(m.id);
    if (m.killers.length === 0) throw new Refused(`${m.id}: names no killer`);
    for (const k of m.killers) {
      if (k.files.length === 0) throw new Refused(`${m.id}: a killer with no files would run the WHOLE suite (never; AGENTS.md) — name the test files`);
    }
    const n = occurrences(readFileSync(resolve(repo, m.file), "utf8"), m.find);
    if (n !== 1) throw new Refused(`${m.id}: find ${JSON.stringify(m.find)} matches ${n} times in ${m.file} (exactly 1 required)`);
  }
}

export async function runMutants(mutants: readonly Mutant[], opts: { repo: string }): Promise<RunResult> {
  const verdicts: Verdict[] = [];
  try {
    validateMutants(mutants, opts.repo);
    // Baseline: every killer green and non-empty on the UNMUTATED tree, or every mutant would read KILLED.
    const seen = new Set<string>();
    for (const k of mutants.flatMap((m) => m.killers)) {
      const key = JSON.stringify(k);
      if (seen.has(key)) continue;
      seen.add(key);
      const r = runKiller(opts.repo, k);
      if (r.numPassedTests === 0) throw new Refused(`killer ${k.cwd}:${k.files.join(",")}${k.name ? ` -t ${k.name}` : ""} passed no test on the baseline (a typo'd path or -t name)`);
      if (r.numFailedTests > 0 || r.numFailedTestSuites > 0) throw new Refused(`killer baseline is red before any mutation: ${failedNames(r).join("; ") || "a suite failed to collect"}`);
    }
    for (const m of mutants) {
      const path = resolve(opts.repo, m.file);
      const original = readFileSync(path);
      const restore = () => {
        writeFileSync(path, original);
        if (!readFileSync(path).equals(original)) throw new Refused(`${m.file} was NOT restored byte-identical after ${m.id}`);
      };
      const onSignal = () => { restore(); process.exit(2); };
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
      try {
        writeFileSync(path, original.toString("utf8").replace(m.find, () => m.replace));
        const killedBy: string[] = [];
        for (const k of m.killers) {
          const r = runKiller(opts.repo, k);
          if (r.numPassedTests === 0 && r.numFailedTests === 0 && r.numFailedTestSuites === 0) throw new Refused(`${m.id}: killer ran no test under the mutant`);
          killedBy.push(...failedNames(r), ...(r.numFailedTestSuites > 0 && failedNames(r).length === 0 ? ["<suite failed to collect>"] : []));
        }
        verdicts.push(killedBy.length > 0 ? { id: m.id, state: "KILLED", killedBy } : { id: m.id, state: "SURVIVED" });
      } finally {
        process.removeListener("SIGINT", onSignal);
        process.removeListener("SIGTERM", onSignal);
        restore();
      }
    }
    return { exitCode: verdicts.every((v) => v.state === "KILLED") ? 0 : 1, verdicts };
  } catch (e) {
    if (e instanceof Refused) return { exitCode: 2, verdicts, error: e.message };
    throw e;
  }
}

function table(verdicts: readonly Verdict[]): string {
  return ["| mutant | verdict |", "|---|---|", ...verdicts.map((v) => `| ${v.id} | ${v.state === "KILLED" ? `KILLED by ${v.killedBy.join("; ")}` : "**SURVIVED**"} |`)].join("\n");
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const at = (flag: string) => { const i = argv.indexOf(flag); return i === -1 ? undefined : argv[i + 1]; };
  const list = at("--list");
  if (list === undefined) { console.error("usage: pnpm mutate --list <mutants.json> [--json-out <file>]"); process.exit(2); }
  const repo = resolve(import.meta.dirname, "..");
  const r = await runMutants(JSON.parse(readFileSync(resolve(list), "utf8")) as Mutant[], { repo });
  console.log(table(r.verdicts));
  if (r.error) console.error(`REFUSED: ${r.error}`);
  const out = at("--json-out");
  if (out !== undefined) writeFileSync(out, JSON.stringify(r, null, 2));
  process.exit(r.exitCode);
}
```

The `.replace(m.find, () => m.replace)` callback form stops `$&` in a replacement from being expanded. A mutant whose killer fails to **collect** under the mutation (a syntax error) is recorded as `<suite failed to collect>`. The reviewer reads that row and rejects it as a kill unless the mutant is a deliberate type-level change.

Root `package.json`, `scripts`: `"mutate": "node --experimental-strip-types --import ./scripts/lib/crash-exit.ts scripts/mutate.ts"`. `.gitignore`: `scripts/.mutate-selftest-*/`.

- [ ] **Step 4 (0a): run the self-test green, plus the CLI's empty case**

The Step 2 command. Expected: `EXIT=0`; the judge shows `total: 9`, `failed: 0`, `files: 1`. Then:

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a-mutate && echo '[]' > "$TMPDIR/w2a-empty.json" && pnpm mutate --list "$TMPDIR/w2a-empty.json"; echo EXIT=$?; echo "LEFTOVER=$(find scripts -maxdepth 1 -name '.mutate-selftest-*' | wc -l | tr -d ' ')"
```

Expected: `REFUSED: zero mutants …`, `EXIT=2`, and `LEFTOVER=0`. The directory is gitignored, so `git status` could never show it; `find` reads the disk.

- [ ] **Step 5 (0a): mutate the runner's own guards, through itself.** Write `MUT/t0a.json`. The killer for each is `{ "cwd": ".", "files": ["scripts/__tests__/mutate.test.ts"] }`.

| id | find → replace | expected killer |
|---|---|---|
| `empty-list` | `if (mutants.length === 0)` → `if (mutants.length < 0)` | "empty case first: a zero-mutant list is refused" |
| `exactly-one` | `if (n !== 1)` → `if (n === 0)` | "a find that matches 0 or 2+ times, or a duplicate id, is refused" |
| `duplicate-id` | `if (ids.has(m.id)) throw` → `if (false) throw` | "a find that matches 0 or 2+ times, or a duplicate id, is refused" |
| `empty-files` | `if (k.files.length === 0) throw` → `if (false) throw` | "a killer with NO files is refused before any spawn" |
| `baseline` | `if (r.numFailedTests > 0 \|\| r.numFailedTestSuites > 0) throw new Refused(\`killer baseline` → `if (false) throw new Refused(\`killer baseline` (in the JSON the pipes are plain `||`) | "a red baseline is refused" |
| `report-missing` | `if (!existsSync(file)) throw` → `if (false) throw` | "a killer whose file does not exist is refused" (the run then throws ENOENT, not a Refused) |
| `baseline-none` | `if (r.numPassedTests === 0) throw` → `if (false) throw` | "a killer whose -t name matches nothing is refused at the baseline" (the mutation-phase guard fires instead, with the other message) |
| `mutant-none` | `if (r.numPassedTests === 0 && r.numFailedTests === 0 && r.numFailedTestSuites === 0) throw` → `if (false) throw` | "a killer that runs no test UNDER the mutant is refused" (reads SURVIVED, exit 1) |
| `restore` | `writeFileSync(path, original);` → `void original;` | "reports a killed mutant … restores the file byte-identical" |
| `survivor-exit` | `verdicts.every((v) => v.state === "KILLED") ? 0 : 1` → `0` | "reports a killed mutant …" (`exitCode` 1) |

Run `pnpm mutate --list docs/superpowers/specs/2026-09-27-format-matrix-prompts/mutants/w2a/t0a.json`. The runner mutating its own source is safe: each killer spawn is a fresh process that imports the file from disk. Expected: `EXIT=0`, ten rows `KILLED by …`, each naming the test listed above.

- [ ] **Step 6 (0b): the failing test** — `packages/engine/test/stryker-changed-lines.test.ts`

```ts
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseMutateRanges, rangesFromDiff, rangesFromUntracked, verdictsFromReport } from "../scripts/stryker-changed.mjs";
import { STRYKER_GROUPS } from "../stryker.groups.mjs";
// The group configs as they were BEFORE Task 0b's edit, written once by `--snapshot` (Step 8a) and committed. No git
// history is read at test time: CI's engine job is a shallow clone with no origin/main, and after the merge the merge
// base would be HEAD itself, comparing the file with itself (preflight C4).
const SNAPSHOT = JSON.parse(readFileSync(resolve(import.meta.dirname, "stryker-config-groups.snap.json"), "utf8")) as Record<string, string>;

const ENGINE = resolve(import.meta.dirname, "..");
const SPAWN_MS = 60_000;
/** The config a child process sees for `env` (the config reads env at import, so each read is its own process). */
function configUnder(file: string, env: Record<string, string | undefined>): string {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `const c = (await import(${JSON.stringify("./" + file)})).default; process.stdout.write(JSON.stringify(c));`], {
    cwd: ENGINE, encoding: "utf8", timeout: SPAWN_MS, env: { ...process.env, STRYKER_GROUP: undefined, STRYKER_MUTATE: undefined, ...env },
  });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout;
}

describe("changed-lines Stryker (W2a Task 0b)", () => {
  it("empty case first: STRYKER_MUTATE set but empty is refused, never a run that mutates nothing", () => {
    expect(() => parseMutateRanges("", ENGINE)).toThrow(/names no range/);
    expect(() => configUnder("stryker.config.mjs", { STRYKER_MUTATE: "" })).toThrow(/names no range/);
  });

  it("parses ranges exactly, and refuses a missing file, a reversed range, a path outside src/ and a test file", () => {
    expect(parseMutateRanges("src/core/events.ts:10-20,src/core/types.ts:5-5", ENGINE)).toEqual(["src/core/events.ts:10-20", "src/core/types.ts:5-5"]);
    expect(() => parseMutateRanges("src/core/nope.ts:1-2", ENGINE)).toThrow(/does not exist/);
    expect(() => parseMutateRanges("src/core/events.ts:20-10", ENGINE)).toThrow(/reversed/);
    expect(() => parseMutateRanges("test/rules-reference.ts:1-2", ENGINE)).toThrow(/outside src/);
    expect(() => parseMutateRanges("src/core/events.test.ts:1-2", ENGINE)).toThrow(/test file/);
  });

  it("with STRYKER_MUTATE the run is 'changed': exactly those ranges, not incremental, its own report — even with STRYKER_GROUP also set", () => {
    let checked = 0;
    for (const env of [{ STRYKER_MUTATE: "src/core/events.ts:10-20" }, { STRYKER_MUTATE: "src/core/events.ts:10-20", STRYKER_GROUP: "core-1" }]) {
      const c = JSON.parse(configUnder("stryker.config.mjs", env));
      expect(c.mutate, JSON.stringify(env)).toEqual(["src/core/events.ts:10-20"]);
      expect(c.incremental).toBe(false);
      expect(c.jsonReporter).toEqual({ fileName: "reports/mutation/changed.json" });
      expect(c.coverageAnalysis).toBe("perTest");
      checked++;
    }
    expect(checked).toBe(2);
  }, 2 * SPAWN_MS);

  it("with STRYKER_MUTATE unset the config equals the pre-0b snapshot, for EVERY group", () => {
    const groups = Object.keys(STRYKER_GROUPS);
    expect(Object.keys(SNAPSHOT).sort()).toEqual([...groups].sort()); // a group added or dropped since the snapshot is a finding
    let checked = 0;
    for (const g of groups) {
      expect(configUnder("stryker.config.mjs", { STRYKER_GROUP: g }), g).toBe(SNAPSHOT[g]);
      checked++;
    }
    expect(checked).toBe(groups.length);
    expect(checked).toBeGreaterThan(0);
  }, Math.max(60_000, Object.keys(STRYKER_GROUPS).length * 3_000 * 5));

  it("rangesFromUntracked: a NEW src file (untracked, so absent from git diff) is mutated whole; test files never", () => {
    expect(rangesFromUntracked([{ path: "src/core/level.ts", lines: 12 }, { path: "src/core/level.test.ts", lines: 40 }])).toEqual(["src/core/level.ts:1-12"]);
    expect(rangesFromUntracked([])).toEqual([]);
  });

  it("rangesFromDiff: added and changed lines of non-test src files only; a deletion-only hunk adds nothing", () => {
    const diff = [
      "diff --git a/packages/engine/src/core/events.ts b/packages/engine/src/core/events.ts",
      "+++ b/packages/engine/src/core/events.ts",
      "@@ -10,0 +11,3 @@",
      "@@ -40,2 +44 @@",
      "@@ -60,4 +63,0 @@",
      "diff --git a/packages/engine/src/core/events.test.ts b/packages/engine/src/core/events.test.ts",
      "+++ b/packages/engine/src/core/events.test.ts",
      "@@ -1,0 +2,9 @@",
    ].join("\n");
    expect(rangesFromDiff(diff)).toEqual(["src/core/events.ts:11-13", "src/core/events.ts:44-44"]);
    expect(rangesFromDiff("")).toEqual([]);
  });

  it("verdictsFromReport names the killers, and counts Survived and NoCoverage as failures", () => {
    const report = {
      testFiles: { "src/x.test.ts": { tests: [{ id: "1", name: "kills it" }] } },
      files: { "src/x.ts": { mutants: [
        { id: "a", mutatorName: "EqualityOperator", replacement: "<=", status: "Killed", killedBy: ["1"], location: { start: { line: 3 } } },
        { id: "b", mutatorName: "BooleanLiteral", replacement: "false", status: "Survived", location: { start: { line: 4 } } },
        { id: "c", mutatorName: "StringLiteral", replacement: '""', status: "NoCoverage", location: { start: { line: 5 } } },
      ] } },
    };
    const v = verdictsFromReport(report);
    expect(v.rows).toEqual([
      { file: "src/x.ts", line: 3, mutator: "EqualityOperator", status: "Killed", killedBy: ["kills it"] },
      { file: "src/x.ts", line: 4, mutator: "BooleanLiteral", status: "Survived", killedBy: [] },
      { file: "src/x.ts", line: 5, mutator: "StringLiteral", status: "NoCoverage", killedBy: [] },
    ]);
    expect(v.failures).toBe(2);
    expect(verdictsFromReport({ testFiles: {}, files: {} }).rows).toEqual([]); // and the CLI refuses an empty report (Step 9)
  });
});
```

- [ ] **Step 7 (0b): run it; see it fail**

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a-stryker/packages/engine && rm -f "$TMPDIR/w2a-t0b.json" && pnpm vitest run test/stryker-changed-lines.test.ts --reporter=json --outputFile="$TMPDIR/w2a-t0b.json"; echo EXIT=$?
```

Expected: `EXIT=1`; the suite fails to collect (`../scripts/stryker-changed.mjs` is missing).

- [ ] **Step 8 (0b): implement**

`packages/engine/scripts/stryker-changed.mjs`:

```js
// Changed-lines Stryker (W2a Task 0b). `STRYKER_MUTATE` names `src/<file>:<a>-<b>` ranges; stryker.config.mjs mutates
// exactly those (perTest coverage, never incremental, report reports/mutation/changed.json). Unset, nothing changes:
// test/stryker-changed-lines.test.ts holds the config byte-identical to the merge base for every group.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { STRYKER_GROUPS } from "../stryker.groups.mjs";

/** @param {string} value @param {string} engine @returns {string[]} */
export function parseMutateRanges(value, engine) {
  const entries = value.split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (entries.length === 0) throw new Error("STRYKER_MUTATE is set but names no range: refusing a run that mutates nothing");
  return entries.map((e) => {
    const m = /^(.+):(\d+)-(\d+)$/.exec(e);
    if (m === null) throw new Error(`STRYKER_MUTATE entry "${e}" is not <src path>:<a>-<b>`);
    const [, file, a, b] = /** @type {[string, string, string, string]} */ (m);
    if (!file.startsWith("src/")) throw new Error(`STRYKER_MUTATE entry "${e}" is outside src/`);
    if (/\.test\.tsx?$/.test(file)) throw new Error(`STRYKER_MUTATE entry "${e}" is a test file`);
    if (!existsSync(join(engine, file))) throw new Error(`STRYKER_MUTATE entry "${e}": ${file} does not exist`);
    if (Number(a) < 1 || Number(b) < Number(a)) throw new Error(`STRYKER_MUTATE entry "${e}" is reversed or starts before line 1`);
    return `${file}:${a}-${b}`;
  });
}

/** `git diff -U0` text → the new-side line ranges of non-test files under packages/engine/src. @param {string} diff */
export function rangesFromDiff(diff) {
  /** @type {string[]} */ const out = [];
  let file = null;
  for (const line of diff.split("\n")) {
    const f = /^\+\+\+ b\/packages\/engine\/(src\/.+)$/.exec(line);
    if (f) { file = /\.test\.tsx?$/.test(f[1]) ? null : f[1]; continue; }
    if (line.startsWith("+++ ")) { file = null; continue; }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h && file !== null) {
      const start = Number(h[1]);
      const count = h[2] === undefined ? 1 : Number(h[2]);
      if (count > 0) out.push(`${file}:${start}-${start + count - 1}`);
    }
  }
  return out;
}

/** Untracked src files (new in the working tree, so `git diff <ref>` cannot see them) → whole-file ranges.
 *  @param {{ path: string; lines: number }[]} files */
export function rangesFromUntracked(files) {
  return files.filter((f) => !/\.test\.tsx?$/.test(f.path) && f.lines > 0).map((f) => `${f.path}:1-${f.lines}`);
}

/** The group configs as the config produces them now, one child process per group (the config reads env at import). */
function snapshotGroups(engine) {
  const out = {};
  for (const g of Object.keys(STRYKER_GROUPS)) {
    out[g] = execFileSync(process.execPath, ["--input-type=module", "-e", "const c = (await import('./stryker.config.mjs')).default; process.stdout.write(JSON.stringify(c));"], {
      cwd: engine, encoding: "utf8", env: { ...process.env, STRYKER_GROUP: g, STRYKER_MUTATE: undefined },
    });
  }
  return out;
}

/** Stryker's mutation-testing-report JSON → one row per mutant, killers by NAME. */
export function verdictsFromReport(report) {
  const names = new Map();
  for (const tf of Object.values(report.testFiles ?? {})) for (const t of tf.tests ?? []) names.set(t.id, t.name);
  const rows = [];
  for (const [file, f] of Object.entries(report.files ?? {})) for (const m of f.mutants ?? [])
    rows.push({ file, line: m.location.start.line, mutator: m.mutatorName, status: m.status, killedBy: (m.killedBy ?? []).map((id) => names.get(id) ?? id) });
  return { rows, failures: rows.filter((r) => r.status === "Survived" || r.status === "NoCoverage").length };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const at = (flag) => { const i = process.argv.indexOf(flag); return i === -1 ? undefined : process.argv[i + 1]; };
  const base = at("--base");
  const report = at("--report");
  const snapshot = at("--snapshot");
  const engine = join(import.meta.dirname, "..");
  if (snapshot !== undefined) {
    writeFileSync(snapshot, JSON.stringify(snapshotGroups(engine), null, 2) + "\n");
  } else if (base !== undefined) {
    const diff = execFileSync("git", ["diff", "-U0", base, "--", "src"], { cwd: engine, encoding: "utf8" });
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", "src"], { cwd: engine, encoding: "utf8" })
      .split("\n").filter((p) => p !== "").map((p) => ({ path: p, lines: readFileSync(join(engine, p), "utf8").split("\n").length }));
    const ranges = [...rangesFromDiff(diff), ...rangesFromUntracked(untracked)];
    if (ranges.length === 0) { console.error("no changed engine src lines against " + base); process.exit(2); }
    process.stdout.write(ranges.join(","));
  } else if (report !== undefined) {
    const v = verdictsFromReport(JSON.parse(readFileSync(report, "utf8")));
    if (v.rows.length === 0) { console.error("the report holds zero mutants: refusing a vacuous pass"); process.exit(2); }
    for (const r of v.rows) console.log(`${r.file}:${r.line} ${r.mutator} ${r.status}${r.killedBy.length ? ` by ${r.killedBy.join("; ")}` : ""}`);
    const count = (s) => v.rows.filter((r) => r.status === s).length;
    console.log(JSON.stringify({ mutants: v.rows.length, killed: count("Killed"), timeout: count("Timeout"), survived: count("Survived"), noCoverage: count("NoCoverage") }));
    process.exit(v.failures === 0 ? 0 : 1);
  } else { console.error("usage: stryker-changed.mjs --base <ref> | --report <changed.json> | --snapshot <out.json>"); process.exit(2); }
}
```

`packages/engine/scripts/stryker-changed.d.mts`:

```ts
export function parseMutateRanges(value: string, engine: string): string[];
export function rangesFromDiff(diff: string): string[];
export function rangesFromUntracked(files: { path: string; lines: number }[]): string[];
export interface ChangedRow { file: string; line: number; mutator: string; status: string; killedBy: string[] }
export function verdictsFromReport(report: unknown): { rows: ChangedRow[]; failures: number };
```

**Step 8a, before the config edit below:** write the snapshot from the UNEDITED config, and commit it with the task. It is the pre-0b truth the byte-equivalence test compares with; it is never regenerated after the edit except as a reviewed, deliberate config change (the commit says so).

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a-stryker/packages/engine && git diff --quiet -- stryker.config.mjs && node scripts/stryker-changed.mjs --snapshot test/stryker-config-groups.snap.json; echo EXIT=$?; grep -c "/Users/" test/stryker-config-groups.snap.json
```

Expected: `EXIT=0` (the `git diff --quiet` guard proves the config is still unedited), and the `grep -c` prints `0`: the snapshot holds no machine-absolute path, so it compares equal on CI. If it prints more than 0, `snapshotGroups` relativises those values against `engine` before writing, and the test does the same to `configUnder`'s output.

In `packages/engine/stryker.config.mjs`, replace the group lines and the four group-derived keys:

```js
import { fileURLToPath } from "node:url";
import { parseMutateRanges } from "./scripts/stryker-changed.mjs";

/** @type {Record<string, string[] | undefined>} */
const groups = STRYKER_GROUPS;
// W2a Task 0b: STRYKER_MUTATE (changed-lines) wins over STRYKER_GROUP. Unset, the config is the group config, unchanged.
const changed = process.env.STRYKER_MUTATE;
const group = changed === undefined ? process.env.STRYKER_GROUP : "changed";
if (changed === undefined && (!group || groups[group] === undefined)) throw new Error(`STRYKER_GROUP must be one of ${Object.keys(groups).join(", ")}`);
```

Then, in the exported object:
- `mutate: changed === undefined ? resolveGroup(group) : parseMutateRanges(changed, fileURLToPath(new URL(".", import.meta.url))),`
- `incremental: changed === undefined,`

`incrementalFile` and `jsonReporter` already interpolate `group`, so they read `changed` unaided. Keep every comment byte-for-byte, and add the new comment lines only above the changed lines. `stryker-sizing.test.ts`'s retired-phrase check reads this file's comments, so a new comment must not quote a sizing figure.

- [ ] **Step 9 (0b): run green, plus the existing tests that read the config**

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a-stryker/packages/engine && rm -f "$TMPDIR/w2a-t0b.json" && pnpm vitest run test/stryker-changed-lines.test.ts test/stryker-groups.test.ts --reporter=json --outputFile="$TMPDIR/w2a-t0b.json"; echo EXIT=$?
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a-stryker/packages/engine && rm -f "$TMPDIR/w2a-t0b2.json" && pnpm vitest run test/stryker-sizing.test.ts -t "the comments that quote the sizing" --reporter=json --outputFile="$TMPDIR/w2a-t0b2.json"; echo EXIT=$?
```

Expected: `EXIT=0` twice. The judge shows `failed: 0` and `files: 2`, then `files: 1`.
- The second run is a vitest `-t` name filter, not a Playwright `-g`. It skips the sizing file's real dry runs (`:794-858`), which are CI's job.
- Pin `total`, and confirm it is > 0 for the `-t` run.

Then a real changed-lines run on a one-line range proves the seam end to end:

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a-stryker/packages/engine && STRYKER_MUTATE="src/core/types.ts:91-101" pnpm mutation > "$TMPDIR/w2a-t0b-run.log" 2>&1; echo EXIT=$?; node scripts/stryker-changed.mjs --report reports/mutation/changed.json --expect "src/core/types.ts:91-101"; echo REPORT_EXIT=$?
```

Expected:
- `EXIT=0`;
- the report prints at least one mutant row on lines 91–101 with `by <test name>`, and `{"mutants":N,…}` with N > 0;
- `REPORT_EXIT` is 0 or 1. Record any survivors in the report; they are not W2a's to fix.

The range is `StageKind`. Record the wall time: it is the per-task cost every later engine task pays.

- [ ] **Step 10 (0b): mutate its guards, with the 0a runner once loop A has merged** (`MUT/t0b.json`; killer `{ "cwd": "packages/engine", "files": ["test/stryker-changed-lines.test.ts"] }`)

| id | find → replace | expected killer |
|---|---|---|
| `empty-range` | `if (entries.length === 0) throw` → `if (false) throw` | "empty case first …" |
| `outside-src` | `if (!file.startsWith("src/")) throw` → `if (false) throw` | "parses ranges exactly …" |
| `test-file` | `if (/\.test\.tsx?$/.test(file)) throw` → `if (false) throw` | "parses ranges exactly …" |
| `reversed` | `Number(b) < Number(a)` → `false` | "parses ranges exactly …" |
| `not-incremental` | `incremental: changed === undefined,` → `incremental: true,` | "with STRYKER_MUTATE the run is 'changed'" |
| `env-wins` | `const group = changed === undefined ? process.env.STRYKER_GROUP : "changed";` → `const group = process.env.STRYKER_GROUP ?? "changed";` | "with STRYKER_MUTATE the run is 'changed' … even with STRYKER_GROUP also set" (report name, the `core-1` env) |
| `deletion-hunk` | `if (count > 0) out.push` → `out.push` | "rangesFromDiff …" |
| `untracked-tests` | `!/\.test\.tsx?$/.test(f.path) && f.lines > 0` → `f.lines > 0` | "rangesFromUntracked …" |
| `nocoverage` | `r.status === "Survived" \|\| r.status === "NoCoverage"` → `r.status === "Survived"` | "verdictsFromReport …" |

Expected: `EXIT=0`, nine rows killed.

- [ ] **Step 11: commit each loop on its lane branch, then merge both into `feat/format-matrix-w2a`**
  - 0a: `feat(scripts): hand-mutant runner — one mutant at a time, killers named, restored byte-identical (W2a Task 0a)`.
  - 0b: `feat(engine): changed-lines Stryker via STRYKER_MUTATE, group config unchanged when unset (W2a Task 0b)`.

  After both merges, re-run Steps 4 and 9 on the merged tree.

**Four test types:**
- Unit: Steps 1–10.
- E2E: N/A as a user flow, because this is developer tooling with no product surface. Traced forward: every later task's mutation step drives it end to end.
- Smoke: Step 4's CLI empty case and Step 9's real changed-lines run.
- Regression: `scripts/__tests__/mutate.test.ts` runs in CI (`ci.yml:787`), and `test/stryker-changed-lines.test.ts` in the engine suite.

---

### Task 1: Reproduce first — the 77 reds and NEW-H1, before any product change

**Evidence run E1, on the main W2a worktree, in parallel with loops A and B. The models are in Execution model.**

**Files:**
- Create: `TR/w2a-local-selection.json` (the `cases` half; Task 14 fills `newScenarios`)
- Create: `TR/w2a-repro/README.md`, `TR/w2a-repro/expect-77.json`, and the run directories `TR/w2a-repro/L1/`, `TR/w2a-repro/L2/` and `TR/w2a-repro/L3/` (harness output, copied whole)
- Create: `TR/w2a-repro/new-h1/report.json` (Playwright JSON report of the probe)
- Create: `apps/web/e2e/bracket-new-h1.spec.ts` (probe, kept; memory: probe specs stay in e2e)
- Modify: `TR/plans.lock.json` (append one entry per new run dir, as the missing-entry failure prints it)
- Modify: `IDX` (W2 row: "W2a Task 1 — reproduction")

**Interfaces:**
- Consumes: the harness at HEAD (`pnpm matrix:l3`, `pnpm matrix:browser`, `pnpm matrix:triage`); `TR/w1d-baseline/{L1,L2,L3}/results.json`.
- Produces: `TR/w2a-repro/expect-77.json`, a JSON array of exactly 77 `caseId` strings (SC-O1 65 + SC-O2 12). Task 16 judges it. `bracket-new-h1.spec.ts` is red at this commit only if NEW-H1 reproduces.

- [ ] **Step 1: Set up the worktree and a fresh environment** (seazn-local-env §0a, §2)

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a && pnpm install --frozen-lockfile > "$TMPDIR/w2a-install.log" 2>&1; echo EXIT=$?
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a && ln -sfn /Users/ashokhein/github/seazn.club/.env.local .env.local && ln -sfn /Users/ashokhein/github/seazn.club/apps/web/.env.local apps/web/.env.local && readlink -f node_modules/@seazn/engine
S=~/.claude/skills/seazn-local-env/scripts/seazn-env.sh; cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a && NEXT_PUBLIC_SCOREPAD_HOLD_MS=3000 $S up --label w2a --all > "$TMPDIR/w2a-up.log" 2>&1; echo EXIT=$?; tail -5 "$TMPDIR/w2a-up.log"
S=~/.claude/skills/seazn-local-env/scripts/seazn-env.sh; cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a && eval "$($S env --label w2a)" && psql "$DATABASE_URL" -Atc "show data_directory"
```

Expected:
- `EXIT=0` twice;
- `readlink` prints a path inside `format-matrix-w2a`;
- `show data_directory` prints the w2a label's own datadir (`$S status` lists it).

Export it as `BENCH_EXPECTED_DATA_DIR` in every later harness command. If it names any other directory you are on a foreign server: stop, `$S down --label w2a`, and `up` again.

- [ ] **Step 2: Derive the 77 expected-red case ids from the committed baseline, by gap**

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a && B=docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1d-baseline && OUT="$TMPDIR/w2a-triage" && rm -rf "$OUT" && mkdir -p "$OUT" && pnpm matrix:triage --runs $B/L1/results.json $B/L2/results.json $B/L3/results.json --out "$OUT"; echo EXIT=$?
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a && mkdir -p docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w2a-repro && jq '[.rows[] | select(.gap=="SC-O1" or .gap=="SC-O2") | .caseId] | sort' "$TMPDIR/w2a-triage/triage.json" > docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w2a-repro/expect-77.json && jq -c '{n:length}' docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w2a-repro/expect-77.json && jq -c '[.rows[] | select(.gap=="SC-O1" or .gap=="SC-O2")] | group_by(.gap) | map({gap:.[0].gap, n:length, byLayer:(group_by(.layer)|map({(.[0].layer):length})|add)})' "$TMPDIR/w2a-triage/triage.json"
```

Expected:
- `{"n":77}`;
- SC-O1 `n:65` and SC-O2 `n:12`;
- layers L1 12, L2 3, L3 62 across the two gaps (spec §1; `TR/w1d-baseline/TRIAGE.md`).

Any other count is a false premise: record it in `IDX` and continue with the triage's own list.

- [ ] **Step 2b: Write the local-selection file from the same 77**

Every later local truth run drives exactly this file (Global Constraints, Truth runs).

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a && T=docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs && node -e '
const fs=require("fs");const want=new Set(JSON.parse(fs.readFileSync(process.argv[1],"utf8")));
const cases=[];for(const L of ["L1","L2","L3"]){for(const c of JSON.parse(fs.readFileSync(process.argv[2]+"/"+L+"/results.json","utf8")).cases){if(want.has(c.caseId))cases.push({layer:L,only:c.row+"|"+c.sport,scenario:c.scenario});}}
const uniq=[...new Map(cases.map(c=>[JSON.stringify(c),c])).values()].sort((a,b)=>JSON.stringify(a)<JSON.stringify(b)?-1:1);
if(uniq.length===0){console.error("zero cases: refusing an empty selection");process.exit(1);}
fs.writeFileSync(process.argv[3],JSON.stringify({note:"W2a local truth-run selection (plan Global Constraints). cases: the cells of the 77 SC-O1/SC-O2 reds (Task 1); newScenarios: the W2a scenarios (Task 14).",cases:uniq,newScenarios:[]},null,2)+"\n");
console.log(JSON.stringify({cases:uniq.length,byLayer:Object.fromEntries(["L1","L2","L3"].map(L=>[L,uniq.filter(c=>c.layer===L).length]))}));' $T/w2a-repro/expect-77.json $T/w1d-baseline $T/w2a-local-selection.json
```

Expected: `cases` > 0, and each of L1, L2 and L3 > 0. A layer with 0 is a false premise against the Step 2 layer split: record it.

- [ ] **Step 3: Re-run every L3 (row, sport) pair those ids name, on this fresh DB**

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a && R=docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w2a-repro && node -e 'const b=require("./docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1d-baseline/L3/results.json");const want=new Set(require("./'$R'/expect-77.json"));const pairs=[...new Set(b.cases.filter(c=>want.has(c.caseId)).map(c=>c.row+"|"+c.sport))].sort();console.log(pairs.join("\n"))' > "$TMPDIR/w2a-l3-pairs.txt"; wc -l < "$TMPDIR/w2a-l3-pairs.txt"
S=~/.claude/skills/seazn-local-env/scripts/seazn-env.sh; cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a && eval "$($S env --label w2a)" && export BENCH_EXPECTED_DATA_DIR="$(psql "$DATABASE_URL" -Atc 'show data_directory')" && i=0 && while read -r p; do i=$((i+1)); pnpm matrix:l3 --set w1-driving --only "$p" --workers 4 --run-id "w2a-repro-l3-$i" --report-dir "$TMPDIR/w2a-repro-l3" > "$TMPDIR/w2a-repro-l3-$i.log" 2>&1; echo "$p EXIT=$?"; done < "$TMPDIR/w2a-l3-pairs.txt"
```

Expected:
- the pair count is > 0, and every L3 case id in `expect-77.json` belongs to one of the pairs;
- each line prints `EXIT=1` (`NO_SIGNAL`: product reds, ruling 19) or `EXIT=0`.

Any `EXIT=2` (refused) or `EXIT=3` (aborted) is an environment fault, not a reproduction: read the log, fix the environment, and re-run that pair.

- [ ] **Step 4: Re-run the L1 and L2 cells the ids name**

```bash
S=~/.claude/skills/seazn-local-env/scripts/seazn-env.sh; cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a && eval "$($S env --label w2a)" && export BENCH_EXPECTED_DATA_DIR="$(psql "$DATABASE_URL" -Atc 'show data_directory')" && export NEXT_PUBLIC_SCOREPAD_HOLD_MS=3000 && pnpm matrix:browser --layer L1 --run-id w2a-repro-l1 --report-dir "$TMPDIR/w2a-repro-l1" > "$TMPDIR/w2a-repro-l1.log" 2>&1; echo "L1 EXIT=$?"; pnpm matrix:browser --layer L2 --run-id w2a-repro-l2 --report-dir "$TMPDIR/w2a-repro-l2" > "$TMPDIR/w2a-repro-l2.log" 2>&1; echo "L2 EXIT=$?"
```

Expected: `EXIT=0` or `EXIT=1` for each layer (the slice scope by default, which contains the L1 and L2 SC-O cells; `TR/w1d-baseline/README.md`).

- [ ] **Step 5: Judge the reproduction: every one of the 77 must be `red` again, and nothing reads `works`**

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a && node -e '
const fs=require("fs"),path=require("path");
const want=new Set(JSON.parse(fs.readFileSync(process.argv[1],"utf8")));
const files=[];for(const d of process.argv.slice(2)){(function walk(p){for(const e of fs.readdirSync(p,{withFileTypes:true})){const f=path.join(p,e.name);if(e.isDirectory())walk(f);else if(e.name==="results.json")files.push(f);}})(d);}
const seen=new Map();for(const f of files)for(const c of JSON.parse(fs.readFileSync(f,"utf8")).cases)if(want.has(c.caseId))seen.set(c.caseId,c.state);
const missing=[...want].filter(id=>!seen.has(id));const works=[...seen].filter(([,s])=>s!=="red").map(([id])=>id);
console.log(JSON.stringify({expected:want.size,found:seen.size,red:[...seen.values()].filter(s=>s==="red").length,missing:missing.length,works}));
process.exit(want.size===77&&missing.length===0&&works.length===0?0:1)' docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w2a-repro/expect-77.json "$TMPDIR/w2a-repro-l1" "$TMPDIR/w2a-repro-l2" "$TMPDIR/w2a-repro-l3"; echo EXIT=$?
```

Expected: `{"expected":77,"found":77,"red":77,"missing":0,"works":[]}` and `EXIT=0`.

A case found `works` did not reproduce (R5). Record it in `IDX` "False premises found (W2a)" with its id and run, remove it from `expect-77.json`, and note the new count in the README. A missing id means a pair was not run: re-run it. Never edit a result.

- [ ] **Step 6: Write the NEW-H1 probe spec** (asserts the 2026-09-21 ruling, "stuck and visible", so it is red while NEW-H1 holds)

`apps/web/e2e/bracket-new-h1.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { TAG, apiJson, addEntrantsViaApi, createStageAndGenerate, fixturePath } from "./helpers";

// NEW-H1 (rulebook-W2-sets-cricket.md:57; W2a spec §5.4.7, §8.2). A set-sport
// knockout semi-final abandoned by its scorer folds to `outcome: null`, the
// exact shape `feederIsDead` (usecases/stages.ts:3657) reads as a generator
// void. The 2026-09-21 owner ruling says an abandoned match is STUCK AND
// VISIBLE: the final's seat stays empty and no walkover is invented. This
// probe asserts the ruling, so it is RED while NEW-H1 holds (W2a Task 1) and
// green after Task 10. Kept in e2e as the regression (memory: keep probes).

interface Fx {
  id: string;
  round_no: number | null;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
  outcome: { kind?: string; winner?: string } | null;
}

test("NEW-H1: an abandoned badminton semi-final leaves the final's seat empty and invents no walkover", async ({ page, request }) => {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `NEW-H1 ${TAG}-${Math.random().toString(36).slice(2, 6)}`,
    visibility: "private",
  });
  expect(comp.status).toBe(201);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Cup",
    sport_key: "badminton",
    variant_key: "bwf",
  });
  expect(div.status).toBe(201);
  const divisionId = div.data!.id;
  await addEntrantsViaApi(request, divisionId, ["H1 One", "H1 Two", "H1 Three", "H1 Four"]);
  const { fixtureIds } = await createStageAndGenerate(request, divisionId, { kind: "knockout", name: "Cup" });
  expect((await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST")).status).toBeLessThan(300);

  const read = async (id: string) => (await apiJson<Fx>(request, `/api/v1/fixtures/${id}`)).data!;
  const all = await Promise.all(fixtureIds.map(read));
  const semis = all.filter((f) => f.home_entrant_id !== null && f.away_entrant_id !== null);
  const final = all.find((f) => f.home_entrant_id === null && f.away_entrant_id === null);
  expect(semis.length).toBe(2); // a 4-draw: two seated semis
  expect(final).toBeTruthy(); // and an unseated final

  // Semi 1: started, then abandoned from the console's own Abandon control (the organiser UI).
  const [sf1, sf2] = semis;
  const tip = async (id: string) => (await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${id}/state`)).data!.last_seq;
  expect((await apiJson(request, `/api/v1/fixtures/${sf1!.id}/events`, "POST", { expected_seq: await tip(sf1!.id), type: "core.start", payload: {} })).status).toBeLessThan(300);
  await page.goto(await fixturePath(request, sf1!.id));
  await page.getByRole("button", { name: "Abandon" }).click();
  await page.getByRole("dialog").getByRole("textbox").fill("rain");
  await page.getByRole("dialog").getByRole("button", { name: "Abandon" }).click();
  await expect.poll(async () => (await read(sf1!.id)).status, { timeout: 15_000 }).toBe("abandoned");
  expect((await read(sf1!.id)).outcome).toBeNull(); // the NEW-H1 shape: abandoned, no outcome

  // Semi 2: a walkover decides it, which runs the seat cascade (onDecided → resolveBracketSeats).
  expect((await apiJson(request, `/api/v1/fixtures/${sf2!.id}/events`, "POST", { expected_seq: await tip(sf2!.id), type: "core.start", payload: {} })).status).toBeLessThan(300);
  expect((await apiJson(request, `/api/v1/fixtures/${sf2!.id}/events`, "POST", { expected_seq: await tip(sf2!.id), type: "core.forfeit", payload: { by: sf2!.away_entrant_id, reason: "walkover" } })).status).toBeLessThan(300);
  await expect.poll(async () => [(await read(final!.id)).home_entrant_id, (await read(final!.id)).away_entrant_id].filter(Boolean).length, { timeout: 15_000 }).toBe(1);

  // The ruling: stuck and visible. The final is NOT turned into a walkover for semi 2's winner.
  const after = await read(final!.id);
  expect(after.status).toBe("scheduled");
  expect(after.outcome).toBeNull();
});
```

The console's Abandon button and dialog labels are pinned from `fixture-console.tsx:1430-1445` and its `TextPromptDialog` (`:142`); the executor re-reads the exact accessible names before the first run.

- [ ] **Step 7: Run the probe as one whole spec file, against the w2a prod server, and keep its JSON report**

```bash
S=~/.claude/skills/seazn-local-env/scripts/seazn-env.sh; cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a/apps/web && eval "$($S env --label w2a)" && mkdir -p ../../docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w2a-repro/new-h1 && PLAYWRIGHT_BASE="$SMOKE_BASE" E2E_PROD_TARGET=1 PLAYWRIGHT_JSON_OUTPUT_NAME=../../docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w2a-repro/new-h1/report.json npx playwright test --project=parallel e2e/bracket-new-h1.spec.ts --reporter=json > /dev/null 2>"$TMPDIR/w2a-h1.err"; echo EXIT=$?; jq -c '.stats' ../../docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w2a-repro/new-h1/report.json
```

Expected, if NEW-H1 reproduces: `EXIT=1`, with `stats.unexpected: 1` and an error on `expect(after.status).toBe("scheduled")` showing `Received: "forfeited"`. Write down what the report says, not what must be true (R20).
- If the report shows `expected: 1` (green), NEW-H1 did not reproduce. Record it in `IDX` "False premises found (W2a)", and Task 10 takes its docs-only branch.
- A failure **before** the final assertion (a selector, a 4xx on create) is an environment or probe fault, never a reproduction verdict: fix the probe and re-run.
- Run `jq '.suites[].specs[].tests[].results[].error.message'` on the report and confirm the failing line is the ruling assertion.

- [ ] **Step 8: Copy the runs into evidence, lock them, write the README, commit**

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a && R=docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w2a-repro && cp -R "$TMPDIR/w2a-repro-l3" $R/L3 && cp -R "$TMPDIR/w2a-repro-l1/w2a-repro-l1" $R/L1 && cp -R "$TMPDIR/w2a-repro-l2/w2a-repro-l2" $R/L2 && ls $R $R/L3 | head -40
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a && rm -f "$TMPDIR/w2a-t1m.json" && ./packages/engine/node_modules/.bin/vitest run --reporter=json --outputFile="$TMPDIR/w2a-t1m.json" --testTimeout=30000 tools/matrix/__tests__/committed-matrix.test.ts; echo EXIT=$?
```

- The first vitest run is expected red with the committed-plans "missing lock entry" failure, which prints each entry to add.
- Append those entries to `TR/plans.lock.json` exactly as printed: the lock is append-only, so add, never reorder.
- Re-run until green and judge it with the Global Constraints jq line. Expected: `failed: 0`, the file count is 1, and every name is under this worktree.

Write `TR/w2a-repro/README.md` with:
- the harness commit (`git rev-parse --short HEAD`) and the data directory check;
- the commands of Steps 2–7, verbatim;
- the Step 5 JSON line;
- the NEW-H1 verdict, quoting the failing assertion's received value from `report.json`;
- one line per case that did not reproduce.

Commit message (written with the Write tool to `$TMPDIR/w2a-msg.txt`):

```
docs(matrix): W2a reproduction — the 77 SC-O reds and the NEW-H1 probe, before any fix

Co-Authored-By: <the committing agent's own line>
```

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a && git add docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w2a-repro docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w2a-local-selection.json docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/plans.lock.json docs/superpowers/specs/2026-09-27-format-matrix-prompts/_INDEX.md apps/web/e2e/bracket-new-h1.spec.ts && git commit -F "$TMPDIR/w2a-msg.txt"; echo EXIT=$?
```

**Four test types:**
- Unit: `committed-matrix.test.ts` (evidence integrity).
- E2E: the NEW-H1 probe (Step 7).
- Smoke: traced forward to Task 17 Step 3.
- Regression: `expect-77.json`, which Task 16 judges.

**Mutation:** none here. This task adds no product guard. The probe's assertions are the guard Task 10 makes pass, and Task 10 mutates its own fix.

---

### Task 2: The rules reference `packages/engine/rules/` and its checker

**Loop C. It waits on loop A merged.**

**Files:**
- Create: `packages/engine/rules/README.md`, `cross-sport.md`, `boardgame.md`, `carrom.md`, `generic.md`, `cricket.md`
- Create: `packages/engine/test/rules-reference.ts` (the parser and the checks), `packages/engine/test/rules-reference.test.ts`, `MUT/t2.json`
- Modify: `IDX` (rulings 71–79 each gain a one-line pointer to their rule ids; the W2 row)

**Interfaces:**
- Produces: the rule ids X-BR-1, X-BR-2, X-ST-1, X-ST-2, X-DR-1, BG-KO-1, BG-KO-2, CA-KO-1, GN-KO-1, CK-KO-1. Every later test that proves a rule contains its id string in a test title (`it("X-ST-1: …")`). Each later task, in its final step, moves its ids out of `AWAITING_PROOF` and into the row's **proved by** cell.
- Produces: `parseRuleRows(text: string, file: string): RuleRow[]`, exported from the test's sibling helper `packages/engine/test/rules-reference.ts`, with `RuleRow = { id: string; rule: string; citation: string; status: string; enforcedAt: string[]; provedBy: string[]; file: string }`.

- [ ] **Step 1: Write the checker test (it fails: no rules directory yet)**

`packages/engine/test/rules-reference.ts`:

```ts
// The rules reference (W2a ruling 75, spec §6). One row per line of a
// markdown table whose header is exactly ROW_HEADER. Cells are split on " | ";
// `enforced at` and `proved by` hold backticked paths separated by "<br>".
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ENGINE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO = resolve(ENGINE, "..", "..");
export const RULES_DIR = join(ENGINE, "rules");
export const ROW_HEADER = "| id | rule | citation | status | enforced at | proved by |";
export const STATUS = /^(signed \d+ \d{4}-\d{2}-\d{2}|deviation \d+ \d{4}-\d{2}-\d{2}|⬜ open)$/;
export const ID = /^[A-Z]{1,3}-[A-Z]{2}-\d+$/;

export interface RuleRow {
  id: string; rule: string; citation: string; status: string;
  enforcedAt: string[]; provedBy: string[]; file: string;
}

const paths = (cell: string): string[] =>
  cell.trim() === "—" ? [] : cell.split("<br>").map((p) => p.trim().replace(/^`|`$/g, "")).filter((p) => p !== "");

export function parseRuleRows(text: string, file: string): RuleRow[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === ROW_HEADER);
  if (start === -1) return [];
  const rows: RuleRow[] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith("| ")) break;
    const cells = line.slice(2, -2).split(" | ");
    if (cells.length !== 6) throw new Error(`${file}: a rule row has ${cells.length} cells, not 6: ${line}`);
    const [id, rule, citation, status, enforced, proved] = cells.map((c) => c.trim()) as [string, string, string, string, string, string];
    rows.push({ id, rule, citation, status, enforcedAt: paths(enforced), provedBy: paths(proved), file });
  }
  return rows;
}

export function ruleFiles(): string[] {
  return readdirSync(RULES_DIR).filter((f) => f.endsWith(".md") && f !== "README.md").sort();
}

export function allRows(): RuleRow[] {
  return ruleFiles().flatMap((f) => parseRuleRows(readFileSync(join(RULES_DIR, f), "utf8"), f));
}

/** A `proved by` entry is a repo-relative test path, or a matrix case id prefixed `matrix:`. */
export const isMatrixCase = (p: string): boolean => p.startsWith("matrix:");
export const fileExists = (p: string): boolean => existsSync(join(REPO, p));
export const fileNames = (p: string, id: string): boolean => readFileSync(join(REPO, p), "utf8").includes(id);

/** The proving checks for one signed row, as data: exported so a synthetic row exercises them while every real row
 *  still awaits proof (preflight C5: at Task 2 no real row reaches these branches). */
export function proofProblems(r: RuleRow): string[] {
  const tests = r.provedBy.filter((p) => !isMatrixCase(p));
  if (tests.length === 0) return [`${r.id} names no proving test`];
  const out: string[] = [];
  for (const p of tests) {
    if (!fileExists(p)) out.push(`${r.id}: ${p} does not exist`);
    else if (!fileNames(p, r.id)) out.push(`${r.id}: ${p} does not contain "${r.id}"`);
  }
  return out;
}
```

`packages/engine/test/rules-reference.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ID, ROW_HEADER, RULES_DIR, STATUS, allRows, fileExists, parseRuleRows, proofProblems, ruleFiles, type RuleRow } from "./rules-reference.ts";

/** Signed rows whose proving test lands in a later W2a task. A task that adds
 *  the proof deletes its id here in the same commit; Task 16 Step 5 requires
 *  this map to be EMPTY. A row not named here must already be proved. */
const AWAITING_PROOF: ReadonlyMap<string, string> = new Map([
  ["X-DR-1", "Task 3"],
  ["X-ST-1", "Task 4"],
  ["BG-KO-1", "Task 5"],
  ["BG-KO-2", "Task 12"],
  ["CA-KO-1", "Task 5"],
  ["X-BR-2", "Task 7"],
  ["X-BR-1", "Task 8"],
  ["GN-KO-1", "Task 8"],
  ["CK-KO-1", "Task 8"],
  ["X-ST-2", "Task 9"],
]);

describe("rules reference (ruling 75, spec §6)", () => {
  it("empty case first: a file with no rule table parses to no rows", () => {
    expect(parseRuleRows("# nothing here\n", "empty.md")).toEqual([]);
  });

  it("parses at least one row from every rule file, and zero rows overall is a failure", () => {
    const files = ruleFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(parseRuleRows(readFileSync(join(RULES_DIR, f), "utf8"), f).length, f).toBeGreaterThan(0);
    expect(allRows().length).toBeGreaterThan(0);
  });

  it("every id is well-formed and unique across all files", () => {
    const rows = allRows();
    const seen = new Map<string, string>();
    for (const r of rows) {
      expect(r.id, `${r.file}: ${r.id}`).toMatch(ID);
      expect(seen.get(r.id), `${r.id} in ${r.file} and ${seen.get(r.id)}`).toBeUndefined();
      seen.set(r.id, r.file);
    }
    expect(seen.size).toBe(rows.length);
  });

  it("every status is signed <ruling> <date>, deviation <ruling> <date> or ⬜ open", () => {
    const rows = allRows();
    for (const r of rows) expect(r.status, r.id).toMatch(STATUS);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("every signed or deviation row names a proving test that exists and contains the id (or awaits proof by name)", () => {
    let checked = 0;
    for (const r of allRows()) {
      if (r.status.startsWith("⬜")) continue;
      if (AWAITING_PROOF.has(r.id)) {
        expect(r.provedBy, `${r.id} awaits ${AWAITING_PROOF.get(r.id)} and must not claim proof yet`).toEqual([]);
        checked++;
        continue;
      }
      expect(proofProblems(r), r.id).toEqual([]);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("the proof checks catch a row with no test, a missing file and a file that does not name the id (synthetic signed rows)", () => {
    const row = (provedBy: string[]): RuleRow => ({ id: "X-ZZ-1", rule: "r", citation: "c", status: "signed 1 2026-10-08", enforcedAt: [], provedBy, file: "synthetic.md" });
    expect(proofProblems(row([]))).toEqual(["X-ZZ-1 names no proving test"]);
    expect(proofProblems(row(["packages/engine/test/no-such.test.ts"]))).toEqual(["X-ZZ-1: packages/engine/test/no-such.test.ts does not exist"]);
    expect(proofProblems(row(["packages/engine/vitest.config.ts"]))).toEqual(['X-ZZ-1: packages/engine/vitest.config.ts does not contain "X-ZZ-1"']);
    expect(proofProblems(row(["packages/engine/test/rules-reference.test.ts"]))).toEqual([]); // the positive pair: this file names X-ZZ-1
  });

  it("the parser refuses a row that is not 6 cells, and ID refuses a malformed id (synthetic inputs)", () => {
    expect(() => parseRuleRows(`${ROW_HEADER}\n|---|---|---|---|---|---|\n| X-ZZ-1 | rule | cite | ⬜ open | — |\n`, "bad.md")).toThrow(/5 cells, not 6/);
    let checked = 0;
    for (const bad of ["x-br-1", "XBR-1", "X-BR-", "ABCD-BR-1"]) { expect(bad, bad).not.toMatch(ID); checked++; }
    expect(checked).toBe(4);
    expect("X-BR-1").toMatch(ID); // the positive pair
  });

  it("every AWAITING_PROOF id is a real signed row (a stale entry is a failure)", () => {
    const signed = new Set(allRows().filter((r) => !r.status.startsWith("⬜")).map((r) => r.id));
    for (const id of AWAITING_PROOF.keys()) expect(signed.has(id), id).toBe(true);
  });

  it("every enforced-at path exists", () => {
    let checked = 0;
    for (const r of allRows()) for (const p of r.enforcedAt) { expect(fileExists(p), `${r.id}: ${p}`).toBe(true); checked++; }
    expect(checked).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a/packages/engine && rm -f "$TMPDIR/w2a-t2e.json" && pnpm vitest run test/rules-reference.test.ts --reporter=json --outputFile="$TMPDIR/w2a-t2e.json"; echo EXIT=$?
```

Expected: `EXIT=1`; the judge shows `failed ≥ 1` with `ENOENT … rules`.

- [ ] **Step 3: Write the README and the five rule files**

`packages/engine/rules/README.md`:

```markdown
# Rules reference

The engine's rules, one row per rule (owner ruling 75, 2026-10-08). This directory moves with the engine.

A rule row is a line of the table whose header is exactly:

| id | rule | citation | status | enforced at | proved by |
|---|---|---|---|---|---|

- **id**: stable, `<SPORT>-<AREA>-<n>`. X = cross-sport. Never reused, never renumbered.
- **rule**: one sentence a scorer or organiser could check.
- **citation**: a federation article, or "product rule" with the ruling that made it.
- **status**: `signed <ruling> <date>`, `deviation <ruling> <date>` or `⬜ open`.
- **enforced at**: backticked repo paths, separated by `<br>`, or `—`.
- **proved by**: backticked repo-relative test paths whose text contains the id, or `matrix:<caseId>`, or `—` while open.

`packages/engine/test/rules-reference.test.ts` checks every row. The wave rulebooks under
`docs/superpowers/specs/2026-09-27-format-matrix-prompts/rulebook-W2-*.md` are frozen research drafts: this
directory is the authority from W2a on.
```

`packages/engine/rules/cross-sport.md` (the enforced-at paths are the files Tasks 4–9 change; they all exist today):

```markdown
# Cross-sport rules

| id | rule | citation | status | enforced at | proved by |
|---|---|---|---|---|---|
| X-BR-1 | In a bracket kind, a fixture is decided only by a win (from play, a decider, a forfeit or settle); `draw`, `tie` and `no_result` are never a decided result. | product rule, ruling 72 | signed 72 2026-10-08 | `apps/web/src/server/engine-db/append-event.ts`<br>`apps/web/src/server/usecases/scoring.ts` | — |
| X-BR-2 | A play-produced level result in a bracket kind is held as `needs_decision`: not decided, nobody seated. | product rule, ruling 79 | signed 79 2026-10-08 | `apps/web/src/server/engine-db/append-event.ts` | — |
| X-ST-1 | `core.settle` applies only to a level outcome, an abandon with no outcome, or a chess bracket game awaiting its tie-break (lots is the organiser's settle); it never names a withdrawn entrant; it records the winner and the method (lot, higher seed, organiser), invents no score, and seats winner and loser. | product rule, ruling 72; preflight rulings C12, C17 (controller, 2026-10-08) | signed 72 2026-10-08 | `packages/engine/src/core/events.ts`<br>`apps/web/src/server/engine-db/append-event.ts` | — |
| X-ST-2 | `core.settle`, `core.forfeit` and `core.abandon` are organiser-only on the server. | product rule, ruling 77 | signed 77 2026-10-08 | `apps/web/src/server/usecases/scoring.ts` | — |
| X-DR-1 | Draws are allowed only in league, group, swiss and americano, and only where the sport allows them. | product rule, rulings 72 and 78 | signed 78 2026-10-08 | `packages/engine/src/core/types.ts` | — |
```

`packages/engine/rules/boardgame.md`:

```markdown
# Board games (chess)

| id | rule | citation | status | enforced at | proved by |
|---|---|---|---|---|---|
| BG-KO-1 | In a bracket, a drawn chess game goes to a tie-break (rapid, blitz, armageddon) recorded by the scorer; lots is the organiser's settle. | product rule following FIDE knockout practice (World Cup regulations, secondary source — re-read before citing it as federation text), ruling 73 | signed 73 2026-10-08 | `packages/engine/src/sports/boardgame/boardgame.ts` | — |
| BG-KO-2 | A drawn armageddon game is won by Black. | FIDE armageddon convention (secondary source), ruling 73; W2a enforcement is the pad hint, ruling 82 | signed 73 2026-10-08 | `apps/web/src/components/v2/scorepad/v3/skins/boardgame.tsx` | — |
```

`packages/engine/rules/carrom.md`:

```markdown
# Carrom

| id | rule | citation | status | enforced at | proved by |
|---|---|---|---|---|---|
| CA-KO-1 | A bracket match always plays the ICF extra board, whatever the division's `tieBoard`. | ICF Laws, Law 56; ruling 74 | signed 74 2026-10-08 | `packages/engine/src/sports/carrom/carrom.ts` | — |
```

`packages/engine/rules/generic.md`:

```markdown
# Generic

| id | rule | citation | status | enforced at | proved by |
|---|---|---|---|---|---|
| GN-KO-1 | A generic bracket fixture refuses a draw; the scorer enters the winner. | product rule, ruling 74 | signed 74 2026-10-08 | `apps/web/src/server/engine-db/append-event.ts` | — |
```

`packages/engine/rules/cricket.md`:

```markdown
# Cricket

| id | rule | citation | status | enforced at | proved by |
|---|---|---|---|---|---|
| CK-KO-1 | A cricket knockout tie with no super over, or a no-result, is held and closed by settle (higher group finisher or lot); joint winners are W4's. | ICC Men's T20 World Cup playing conditions 16.10.5–16.10.6; ruling 74 | signed 74 2026-10-08 | `apps/web/src/server/engine-db/append-event.ts` | — |
```

- [ ] **Step 4: Run the checker green**

The same command as Step 2. Expected:
- `EXIT=0`;
- the judge shows `total: 9`, `failed: 0`, `files: 1`, and a name under the worktree.

- [ ] **Step 5: Mutate each check once, through the runner** (`MUT/t2.json`). The mutants are data and test edits; every killer is `packages/engine/test/rules-reference.test.ts`.

| Mutant (in `rules-reference.test.ts` / `rules-reference.ts`, one at a time) | Expected red |
|---|---|
| Duplicate the X-BR-1 row into `generic.md` | "every id is well-formed and unique" |
| BG-KO-2's status: find `ruling 82 \| signed 73 2026-10-08` (unique to the BG-KO-2 row; BG-KO-1 also carries `signed 73 2026-10-08`) → `ruling 82 \| signed 73 08-10-2026` | "every status is …" |
| Delete `["X-ST-2", "Task 9"]` from `AWAITING_PROOF` | "every signed or deviation row names a proving test" (X-ST-2 names none) |
| Add `["X-ZZ-9", "Task 99"]` to `AWAITING_PROOF` | "every AWAITING_PROOF id is a real signed row" |
| `if (start === -1) return [];` → `if (start === -1) return [{ id: "X-ZZ-1", rule: "", citation: "", status: "⬜ open", enforcedAt: [], provedBy: [], file }];` | "empty case first: a file with no rule table parses to no rows" |
| Change CA-KO-1's enforced-at path to `packages/engine/src/sports/carrom/caron.ts` | "every enforced-at path exists" |
| `if (!fileExists(p)) out.push` → `if (false) out.push` | "the proof checks catch …" (the missing file then throws ENOENT in `fileNames`) |
| `else if (!fileNames(p, r.id)) out.push` → `else if (false) out.push` | "the proof checks catch …" (`vitest.config.ts` case) |
| `if (tests.length === 0) return [` → `if (false) return [` | "the proof checks catch …" (no-test case) |
| `if (cells.length !== 6) throw` → `if (false) throw` | "the parser refuses a row that is not 6 cells …" |
| `export const ID = /^[A-Z]{1,3}-[A-Z]{2}-\d+$/;` → `export const ID = /^.+$/;` | "… ID refuses a malformed id" |

Each row above becomes one entry of `MUT/t2.json`:
- `find` is the exact source text the row names, copied from this task's code blocks, and `replace` is its mutation;
- `killers` is `[{ "cwd": "packages/engine", "files": [<the test file the row names>], "name": <the test title the row names> }]`.

Then run the runner:

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a && pnpm mutate --list docs/superpowers/specs/2026-09-27-format-matrix-prompts/mutants/w2a/t2.json --json-out "$TMPDIR/w2a-mut-t2.json"; echo EXIT=$?
```

Expected: `EXIT=0`; every row `KILLED by` the named test, 0 survived. Paste the table into the report.

- [ ] **Step 6: Commit**

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a && git add packages/engine/rules packages/engine/test/rules-reference.ts packages/engine/test/rules-reference.test.ts docs/superpowers/specs/2026-09-27-format-matrix-prompts/mutants/w2a/t2.json docs/superpowers/specs/2026-09-27-format-matrix-prompts/_INDEX.md && git commit -F "$TMPDIR/w2a-msg.txt"; echo EXIT=$?
```

Message: `feat(engine): rules reference — W2a's ten signed rows and their checker (ruling 75)`, then a blank line and the trailer.

**Four test types:**
- Unit: Step 4.
- E2E: N/A for a docs table and a checker. Its ids are proved by Tasks 4–15's tests, and their e2e is Task 11 and Task 12's specs.
- Smoke: traced forward to Task 17.
- Regression: the checker runs in CI on every engine PR (`packages/engine/test/**` is in the engine vitest include, `vitest.config.ts:51`).

---

### Task 3: `BRACKET_KINDS`, the draw allow-lists, and the 11 × 9 sweep (X-DR-1; ruling 78)

**Loop D (Tasks 3–5: one implementer pass, one review). It waits on loops A, B and C merged. Lanes P1 and P2 start alongside it.**

**Files:**
- Modify: `E/core/types.ts` (after `StageKind`, `:91-101`)
- Modify: `E/sports/boardgame/boardgame.ts:768-772`, `E/sports/generic/generic.ts:650-654`, `E/sports/carrom/carrom.ts:983-988`, `E/sports/football/football.ts:2665-2668`, `E/sports/cricket/cricket.ts:3964-3966`, `E/sports/period/kernel.ts:2644-2647`
- Create: `E/sport/supports-draws.test.ts`, `E/core/stage-kind-sets.test.ts`
- Create: `E/testkit/declared-cfgs.ts`, `E/testkit/declared-cfgs.test.ts`; Modify: `E/testkit/index.ts` (export it). One helper for every sport sweep in W2a (Tasks 3, 4, 5, 14; preflight C7): generic's schema has no default for `resultMode`/`allowDraws`, so `configSchema.parse({})` THROWS for it.
- Modify: `E/sports/boardgame/boardgame.test.ts:158-163`, `E/sports/generic/generic.test.ts:142-148` (the pinning tests, rewritten from X-DR-1)
- Modify: `packages/engine/test/rules-reference.test.ts` (drop `X-DR-1` from `AWAITING_PROOF`), `packages/engine/rules/cross-sport.md` (X-DR-1 proved by)

**Interfaces:**
- Produces (from `@seazn/engine/core`):
  ```ts
  export const BRACKET_KINDS: ReadonlySet<StageKind>; // knockout, double_elim, stepladder, page_playoff, ladder
  export const DRAW_KINDS: ReadonlySet<StageKind>;    // league, group, swiss, americano
  export function forbidsLevelResult(kind: string | null | undefined): boolean;
  export function isLevelOutcome(outcome: MatchOutcome | null | undefined): boolean; // draw | tie | no_result
  ```
- Produces (from `@seazn/engine/testkit`):
  ```ts
  /** Every config a sport DECLARES: each `module.variants` entry parsed, plus the bare schema default only when the
   *  schema accepts `{}`. Throws when a sport declares none. */
  export function declaredCfgs<Cfg>(m: { configSchema: { safeParse(v: unknown): { success: boolean; data?: unknown }; parse(v: unknown): unknown }; variants: Record<string, Partial<Cfg>> }): { name: string; cfg: Cfg }[];
  ```
- The americano decision (finding 15): football, cricket (two innings) and the period kernel gain `americano`; setbased and nested stay false.

- [ ] **Step 1: Write the failing tests**

`E/core/stage-kind-sets.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { BRACKET_STAGE_KINDS } from "../competition/progression.ts";
import { BRACKET_KINDS, DRAW_KINDS, StageKind, forbidsLevelResult, isLevelOutcome } from "./types.ts";

describe("X-DR-1 stage-kind sets (spec §5.4.1, ruling 78)", () => {
  it("empty case first: no kind, null and undefined are not bracket kinds; null is not a level outcome", () => {
    expect(forbidsLevelResult("")).toBe(false);
    expect(forbidsLevelResult(null)).toBe(false);
    expect(forbidsLevelResult(undefined)).toBe(false);
    expect(isLevelOutcome(null)).toBe(false);
    expect(isLevelOutcome(undefined)).toBe(false);
  });
  it("BRACKET_KINDS and DRAW_KINDS are disjoint and together are every StageKind the engine declares", () => {
    const all = StageKind.options;
    expect(all.length).toBeGreaterThan(0);
    for (const k of all) expect(BRACKET_KINDS.has(k) !== DRAW_KINDS.has(k), k).toBe(true);
    expect(BRACKET_KINDS.size + DRAW_KINDS.size).toBe(all.length);
  });
  it("BRACKET_KINDS is the bracket-shape set plus ladder (finding 5)", () => {
    expect(new Set(BRACKET_KINDS)).toEqual(new Set([...BRACKET_STAGE_KINDS, "ladder"]));
  });
  it("forbidsLevelResult agrees with the set for every declared kind and refuses an unknown string", () => {
    let checked = 0;
    for (const k of StageKind.options) { expect(forbidsLevelResult(k)).toBe(BRACKET_KINDS.has(k)); checked++; }
    expect(forbidsLevelResult("knock_out")).toBe(false);
    expect(checked).toBe(StageKind.options.length);
  });
  it("isLevelOutcome is true exactly for draw, tie and no_result", () => {
    expect(isLevelOutcome({ kind: "draw" })).toBe(true);
    expect(isLevelOutcome({ kind: "tie" })).toBe(true);
    expect(isLevelOutcome({ kind: "no_result" })).toBe(true);
    expect(isLevelOutcome({ kind: "win", winner: "H", loser: "A" })).toBe(false);
    expect(isLevelOutcome({ kind: "award", winner: "H" })).toBe(false);
  });
});
```

`E/testkit/declared-cfgs.ts`:

```ts
// W2a (preflight C7). The configs a sport DECLARES — never `configSchema.parse({})` blind: generic's resultMode and
// allowDraws have no default, so that throws and every sweep reds at generic.
export function declaredCfgs<Cfg>(m: {
  configSchema: { safeParse(v: unknown): { success: boolean; data?: unknown }; parse(v: unknown): unknown };
  variants: Record<string, Partial<Cfg>>;
}): { name: string; cfg: Cfg }[] {
  const out = Object.entries(m.variants).map(([name, v]) => ({ name, cfg: m.configSchema.parse(v) as Cfg }));
  const bare = m.configSchema.safeParse({});
  if (bare.success) out.unshift({ name: "(schema default)", cfg: bare.data as Cfg });
  if (out.length === 0) throw new Error("a sport declares no config: nothing to sweep");
  return out;
}
```

`E/testkit/declared-cfgs.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { declaredCfgs } from "./declared-cfgs.ts";
import { forEachSport } from "./for-each-sport.ts";

describe("declaredCfgs (W2a, preflight C7)", () => {
  it("empty case first: a module that declares nothing is refused, never an empty sweep", () => {
    expect(() => declaredCfgs({ configSchema: { safeParse: () => ({ success: false }), parse: (v) => v }, variants: {} })).toThrow(/declares no config/);
  });
  it("every sport yields every declared variant by name, and the schema default only where {} parses", () => {
    let checked = 0;
    const sports = forEachSport(({ key, module }) => {
      const got = declaredCfgs(module as never).map((c) => c.name);
      const bareOk = module.configSchema.safeParse({}).success;
      expect(got, key).toEqual([...(bareOk ? ["(schema default)"] : []), ...Object.keys(module.variants)]);
      expect(got.length, key).toBeGreaterThan(0);
      checked++;
    });
    expect(sports).toBe(11);
    expect(checked).toBe(11);
  });
  it("generic has no schema default, so its declared cfgs are exactly its variants (the case that used to throw)", () => {
    let checked = 0;
    forEachSport(({ key, module }) => {
      if (key !== "generic") return; // one-line reason: generic is the one schema with no defaults (preflight C7)
      expect(module.configSchema.safeParse({}).success).toBe(false);
      expect(declaredCfgs(module as never).map((c) => c.name)).toEqual(Object.keys(module.variants));
      checked++;
    });
    expect(checked).toBe(1);
  });
});
```

`E/sport/supports-draws.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DRAW_KINDS, StageKind } from "../core/types.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";

/** X-DR-1 inside DRAW_KINDS, per sport, from the sport's rulebook and its DECLARED cfg fields — never from
 *  `supportsDraws(cfg, "league")`, the code under test (preflight C6; spec §5.2). Every row cites its rule. */
type C = Record<string, unknown>;
const LEVEL_RESULT_RULE: Record<string, { rule: string; allows: (cfg: C) => boolean }> = {
  football: { rule: "IFAB Laws of the Game, Law 10: a league match may end level", allows: () => true },
  hockey: { rule: "FIH: draws stand where no overtime or shoot-out is configured (hockey/DOMAIN.md:59)", allows: (c) => c.overtime === null && c.shootout === null },
  icehockey: { rule: "IIHF/recreational: draws stand where no decider is configured (icehockey/DOMAIN.md:74)", allows: (c) => c.overtime === null && c.shootout === null },
  cricket: { rule: "MCC Laws of Cricket, Law 16: only a match of two innings a side can be drawn", allows: (c) => c.inningsPerSide === 2 },
  boardgame: { rule: "FIDE Laws of Chess, Art. 5.2: a game may be drawn", allows: () => true },
  carrom: { rule: "ICF Laws: a tied match plays an extra board; a draw only under the tieBoard 'draw' house rule", allows: (c) => c.tieBoard === "draw" },
  generic: { rule: "organiser-declared: a draw only with cfg.allowDraws", allows: (c) => c.allowDraws === true },
  volleyball: { rule: "FIVB: a set-based match always has a winner", allows: () => false },
  badminton: { rule: "BWF: a set-based match always has a winner", allows: () => false },
  tabletennis: { rule: "ITTF: a set-based match always has a winner", allows: () => false },
  tennis: { rule: "ITF: a tennis match always has a winner", allows: () => false },
};

describe("X-DR-1: supportsDraws is an allow-list over DRAW_KINDS, swept 11 sports × 9 kinds", () => {
  it("empty case first: DRAW_KINDS is not empty and is a strict subset of StageKind", () => {
    expect(DRAW_KINDS.size).toBeGreaterThan(0);
    expect(DRAW_KINDS.size).toBeLessThan(StageKind.options.length);
  });

  it("X-DR-1: outside DRAW_KINDS no sport allows a draw; inside, the sport's own rule over its declared cfg decides", () => {
    let checked = 0;
    let drawable = 0;
    let refused = 0;
    const seen: string[] = [];
    const sports = forEachSport(({ key, module }) => {
      const row = LEVEL_RESULT_RULE[key];
      expect(row, `${key} has no X-DR-1 rule row`).toBeDefined();
      seen.push(key);
      for (const { name, cfg } of declaredCfgs(module as never)) {
        for (const kind of StageKind.options) {
          const expected = DRAW_KINDS.has(kind) && row!.allows(cfg as C);
          expect(module.supportsDraws(cfg as never, kind), `${key}/${name} ${kind} (${row!.rule})`).toBe(expected);
          if (expected) drawable++;
          else refused++;
          checked++;
        }
      }
    });
    expect(sports).toBe(11);
    expect(seen.sort()).toEqual(Object.keys(LEVEL_RESULT_RULE).sort()); // no stale or missing rule row
    expect(checked).toBeGreaterThanOrEqual(11 * StageKind.options.length);
    expect(drawable).toBeGreaterThan(0); // a sweep that never sees a true cannot witness the allow-list
    expect(refused).toBeGreaterThan(0);
  });

  it("X-DR-1: the cases the old deny-list got wrong (generic page_playoff/ladder/americano, boardgame knockout)", () => {
    // Right answer differs from the wrong one's constant: the deny-list answered true for all four.
    let checked = 0;
    forEachSport(({ key, module }) => {
      if (key !== "generic" && key !== "boardgame") return; // one-line reason: the two modules the deny-list / always-true covered
      // A declared cfg that allows draws: generic's `score` variant (allowDraws true); boardgame's schema default.
      const drawing = declaredCfgs(module as never).find(({ cfg }) => LEVEL_RESULT_RULE[key]!.allows(cfg as C));
      expect(drawing, `${key} declares no draw-allowing cfg`).toBeDefined();
      for (const kind of ["page_playoff", "ladder", "knockout"] as const) { expect(module.supportsDraws(drawing!.cfg as never, kind), `${key} ${kind}`).toBe(false); checked++; }
      expect(module.supportsDraws(drawing!.cfg as never, "americano"), `${key} americano`).toBe(true);
      checked++;
    });
    expect(checked).toBe(8);
  });
});
```

The test runs about 11 × (1 + variants) × 9 pure calls, under 50 ms, so no budget override is needed.

- [ ] **Step 2: Run them; see them fail**

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a/packages/engine && rm -f "$TMPDIR/w2a-t3e.json" && pnpm vitest run src/core/stage-kind-sets.test.ts src/sport/supports-draws.test.ts --reporter=json --outputFile="$TMPDIR/w2a-t3e.json"; echo EXIT=$?
```

Expected: `EXIT=1`. The stage-kind-sets suite fails to collect (no `BRACKET_KINDS` export), and the sweep fails on `boardgame knockout` (expected false, received true).

- [ ] **Step 3: Implement the sets** (append to `E/core/types.ts` after `export type StageKind`)

```ts
// W2a (spec §5.4.1, rulings 72 and 78). Two halves of StageKind, disjoint and
// exhaustive (stage-kind-sets.test.ts). BRACKET_KINDS is "a level result is
// forbidden because someone must advance" — wider than the bracket-SHAPE set
// (competition/progression.ts BRACKET_STAGE_KINDS), which has no ladder.
export const BRACKET_KINDS: ReadonlySet<StageKind> = new Set<StageKind>([
  "knockout", "double_elim", "stepladder", "page_playoff", "ladder",
]);
export const DRAW_KINDS: ReadonlySet<StageKind> = new Set<StageKind>([
  "league", "group", "swiss", "americano",
]);
export function forbidsLevelResult(kind: string | null | undefined): boolean {
  return typeof kind === "string" && (BRACKET_KINDS as ReadonlySet<string>).has(kind);
}
export function isLevelOutcome(outcome: { kind: string } | null | undefined): boolean {
  return outcome != null && (outcome.kind === "draw" || outcome.kind === "tie" || outcome.kind === "no_result");
}
```

- [ ] **Step 4: Make every `supportsDraws` an allow-list over `DRAW_KINDS`**

Each module imports `DRAW_KINDS` from `../../core/types.ts` (the period kernel from `../../core/types.ts` too).

```ts
// boardgame.ts (replaces :768-772)
  // X-DR-1 (ruling 78): draws only where nobody must advance. A drawn bracket
  // game goes to the tie-break (BG-KO-1), never to a decided draw.
  supportsDraws(_cfg, stage: StageKind) {
    return DRAW_KINDS.has(stage);
  },

// generic.ts (replaces :650-654)
  supportsDraws(cfg, stage: StageKind) {
    return cfg.allowDraws && DRAW_KINDS.has(stage);
  },

// carrom.ts (replaces :983-988)
  supportsDraws(cfg, stage: StageKind) {
    return cfg.tieBoard === "draw" && DRAW_KINDS.has(stage);
  },

// football.ts (replaces :2665-2668) — finding 15: americano is offered (offered-matrix.md:26)
  supportsDraws(_cfg, stage: StageKind) {
    return DRAW_KINDS.has(stage);
  },

// cricket.ts (replaces :3964-3966) — finding 15
  supportsDraws(cfg, stage: StageKind) {
    return cfg.inningsPerSide === 2 && DRAW_KINDS.has(stage);
  },

// period/kernel.ts (replaces :2644-2647) — finding 15
    supportsDraws(cfg, stage: StageKind) {
      return DRAW_KINDS.has(stage) && cfg.overtime === null && cfg.shootout === null;
    },
```

Setbased (`:2469`) and nested (`:2223`) stay `return false`; the sweep proves it.

- [ ] **Step 5: Rewrite the two pinning tests from X-DR-1**

`boardgame.test.ts` replaces `:158-163`:

```ts
  it("X-DR-1: draws only in DRAW_KINDS — a drawn bracket game goes to the tie-break (BG-KO-1)", () => {
    let checked = 0;
    for (const stage of StageKind.options) {
      expect(boardgame.supportsDraws(cfg, stage), stage).toBe(DRAW_KINDS.has(stage));
      checked++;
    }
    expect(checked).toBe(StageKind.options.length);
  });
```

`generic.test.ts` replaces `:142-148`:

```ts
  it("X-DR-1: supports draws only in DRAW_KINDS, and only with allowDraws", () => {
    let checked = 0;
    for (const stage of StageKind.options) {
      expect(generic.supportsDraws(scoreCfg, stage), `score ${stage}`).toBe(DRAW_KINDS.has(stage));
      expect(generic.supportsDraws(winLossCfg, stage), `win_loss ${stage}`).toBe(false);
      checked++;
    }
    expect(checked).toBe(StageKind.options.length);
  });
```

Add `StageKind, DRAW_KINDS` to each file's `../../core/types.ts` import.

- [ ] **Step 6: Run the scoped engine tests green, then the single-sport ratchet**

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a/packages/engine && rm -f "$TMPDIR/w2a-t3e.json" && pnpm vitest run src/core/stage-kind-sets.test.ts src/sport/supports-draws.test.ts src/sports/boardgame/boardgame.test.ts src/sports/generic/generic.test.ts src/sports/carrom/carrom.test.ts src/sports/football/football.test.ts src/sports/cricket/cricket.test.ts src/sports/period/period.test.ts src/sport/match-points-bounds.test.ts src/testkit/declared-cfgs.test.ts --reporter=json --outputFile="$TMPDIR/w2a-t3e.json"; echo EXIT=$?
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a && pnpm matrix:single-sport --check --against HEAD^1; echo EXIT=$?
```

Expected:
- `EXIT=0`;
- `files: 10`, `failed: 0`;
- the ratchet `EXIT=0`: the one sport-filtered test carries its one-line reason.

If `match-points-bounds.test.ts` or a period-kernel test reds on americano, read what it asserts (class 4). A test asserting league-only draws for americano is now wrong against X-DR-1: rewrite it from the rule row, never from the code.

- [ ] **Step 7: Mutate each member once (runner, then changed-lines Stryker)**

| Mutant | Expected red |
|---|---|
| `DRAW_KINDS` without `"americano"` | supports-draws "the cases the old deny-list got wrong" (americano), and the sweep (boardgame americano) |
| `BRACKET_KINDS` without `"ladder"` | stage-kind-sets "disjoint and together …" and "bracket-shape set plus ladder" |
| boardgame `supportsDraws` → `return true` | the sweep (boardgame knockout) and the boardgame.test X-DR-1 test |
| generic: drop `cfg.allowDraws &&` | generic.test "only with allowDraws" (win_loss league) |
| carrom: drop `cfg.tieBoard === "draw" &&` | the sweep: every declared carrom cfg is `tieBoard: "extra"` (`icf`, `club-29`; schema default `"extra"`, carrom.ts:69), so the rule row expects false in league |
| period: drop `&& cfg.shootout === null` | the sweep: hockey's `fih-shootout` variant declares a shoot-out (hockey.ts:142), so its rule row expects false in league |
| `declaredCfgs`: `if (bare.success) out.unshift` → `out.unshift` | declared-cfgs "every sport yields every declared variant by name …" (generic gains a bogus default) |
| `declaredCfgs`: `if (out.length === 0) throw` → `if (false) throw` | declared-cfgs "empty case first …" |
| `isLevelOutcome` without `"no_result"` | stage-kind-sets "isLevelOutcome is true exactly for …" |

Each row above becomes one entry of `MUT/t3.json`:
- `find` is the exact source text the row names, copied from this task's code blocks, and `replace` is its mutation;
- `killers` is `[{ "cwd": "packages/engine", "files": [<the test file the row names>], "name": <the test title the row names> }]`.

Then run the runner:

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a && pnpm mutate --list docs/superpowers/specs/2026-09-27-format-matrix-prompts/mutants/w2a/t3.json --json-out "$TMPDIR/w2a-mut-t3.json"; echo EXIT=$?
```

Expected: `EXIT=0`; every row `KILLED by` the named test, 0 survived. Paste the table into the report.


Then run changed-lines Stryker over this task's engine diff (Global Constraints, Mutation):

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a/packages/engine && rm -f reports/mutation/changed.json && M="$(node scripts/stryker-changed.mjs --base "$TASK_BASE")" && STRYKER_MUTATE="$M" pnpm mutation > "$TMPDIR/w2a-stryker-t3.log" 2>&1; echo EXIT=$?; node scripts/stryker-changed.mjs --report reports/mutation/changed.json --expect "$M"; echo REPORT_EXIT=$?
```

Expected: `REPORT_EXIT=0`, with `survived: 0, noCoverage: 0` and a `by <test>` on every killed row. A survivor gets a killing test, or an equivalence row the reviewer signs. The range covers every earlier loop-D task's lines too, so a later task's run re-proves them.

- [ ] **Step 8: Proof bookkeeping and commit**
  - Delete `["X-DR-1", "Task 3"]` from `AWAITING_PROOF`.
  - Set X-DR-1's proved-by cell to `` `packages/engine/src/sport/supports-draws.test.ts`<br>`packages/engine/src/core/stage-kind-sets.test.ts` ``, and put `X-DR-1:` in the stage-kind-sets describe title too.
  - Run `rules-reference.test.ts` green, using the Task 2 Step 2 command.
  - Commit the engine files, the two tests, the rules and the `IDX` row. Message: `feat(engine): BRACKET_KINDS and the X-DR-1 draw allow-list across 11 sports (ruling 78)`.

**Four test types:**
- Unit: Steps 1–6.
- E2E: traced forward to Task 12, `bracket-finish.spec.ts` "generic bracket has no Draw".
- Smoke: Task 17.
- Regression: Task 16's judge across W3–W7 rows (spec risk row 3).

---

### Task 4: `core.settle`, kernel-owned (X-ST-1), the four error codes, and `outcomeOf` at every reader

**Loop D, continued.**

**Files:**
- Modify: `E/core/events.ts` (schemas `:96-129`, `POST_DECISION_CORE` `:437`, `DURING_STOPPAGE` `:469-490`, `foldMatchWithStoppage` `:518-768`)
- Modify: `E/core/errors.ts` (append four codes), `E/core/errors.test.ts` (the order list)
- Modify: `W/server/api-v1/http.ts` (`ENGINE_HTTP`), `W/lib/scoring-vocab.ts` (`ENGINE_ERROR_KEY`), `W/dictionaries/{en,fr,es,nl}/ui.json` (`engineError.*`)
- Modify: `E/sport/module.ts` (optional `awaitingDecider?(state)` on the module interface; preflight C12)
- Modify (readers → `outcomeOf`): `W/server/engine-db/fold.ts:163-171`, `W/server/engine-db/append-event.ts:300-329`, `W/server/usecases/event-import.ts:300-324`, `E/sports/cricket/scorecard.ts:1153-1155`, `HM/lib/fold.ts:61-62`, `HM/lib/model/ledger-fold.ts:37-38`
- Create: `E/core/settle.test.ts`, `W/server/engine-db/__tests__/outcome-readers.test.ts`
- Modify: `E/sports/cricket/cricket.test.ts` (one case beside "league tie without a super over stands as a tie", `:1140`, inside the describe that owns `tiedMain`, `:1037`; preflight C11)

**Interfaces:**
- Produces (from `@seazn/engine/core`):
  ```ts
  export const SETTLE_METHODS: readonly ["lot", "higher_seed", "organiser"];
  export type SettleMethod = (typeof SETTLE_METHODS)[number];
  export const CoreSettle: z.ZodType<{ winner: string; method: SettleMethod; note?: string }>;
  export interface Settlement { readonly winner: string; readonly loser: string; readonly method: SettleMethod; readonly eventId: string }
  export const settledMethod: (m: SettleMethod) => `settled_${SettleMethod}`;
  // foldMatchWithStoppage now returns { state, stoppage, squads, settlement: Settlement | null }
  export function outcomeOf<Cfg, State>(module: Pick<FoldableModule<Cfg, State>, "outcome">, folded: { state: State; settlement: Settlement | null }): MatchOutcome | null;
  /** THE settle precondition (controller ruling C12): ONE predicate. The kernel calls it with the fold's EFFECTIVE
   *  outcome (outcomeOf, so an active settle already reads as a win and a second settle is refused); the server calls
   *  it on the stored row and serves the answer to the console as `settle_applies` (Task 8). */
  export interface SettleFacts { readonly outcome: MatchOutcome | null; readonly abandoned: boolean; readonly state: unknown }
  export function settleApplies(module: { awaitingDecider?(state: never): boolean }, f: SettleFacts): boolean;
  // true iff isLevelOutcome(f.outcome) || (f.outcome === null && (f.abandoned || module.awaitingDecider?.(f.state) === true))
  // SportModule gains `awaitingDecider?(state: State): boolean` — a level game held for a decider the scorer records
  // (boardgame phase "tiebreak", Task 5). Lots is the organiser's settle there too (ruling 73).
  ```
- New `EngineErrorCode` values, appended in this order: `SETTLE_NOT_APPLICABLE`, `TIEBREAK_NOT_APPLICABLE`, `LEVEL_RESULT_IN_BRACKET`, `LEVEL_RESULT_SEATED`. HTTP codes: 409, 409, 409, 500. (Ruling 82 dropped the fifth code the spec first listed.)
- Kernel-owned `core.finalize`, when `settlement !== null && module.outcome(state) === null` (finding 21).

- [ ] **Step 1: Write the failing engine tests** — `E/core/settle.test.ts`

```ts
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { EngineError } from "./errors.ts";
import { CORE_EVENT_SCHEMAS, SETTLE_METHODS, foldMatchWithStoppage, outcomeOf, settleApplies, settledMethod, type EventEnvelope } from "./events.ts";
import { isLevelOutcome } from "./types.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { defaultLineupPair, makeEnvelope } from "../testkit/index.ts";
import { boardgame } from "../sports/boardgame/index.ts";
import { generic } from "../sports/generic/index.ts";

const ev = (seq: number, type: string, payload: unknown = {}, voids?: string): EventEnvelope => makeEnvelope(seq, { type, payload } as never, voids);
const bgCfg = boardgame.configSchema.parse({});
const bgLineups = defaultLineupPair(boardgame.positions);
const H = bgLineups.home.entrantId;
const A = bgLineups.away.entrantId;
const fold = (events: EventEnvelope[]) => foldMatchWithStoppage(boardgame, bgCfg, bgLineups, events);
const drawn = [ev(1, "core.start"), ev(2, "boardgame.result", { winner: null, method: "agreement" })];
const settle = (seq: number, winner = H, method: string = "lot") => ev(seq, "core.settle", { winner, method });
const codeOf = (f: () => unknown): string | null => { try { f(); return null; } catch (e) { return EngineError.is(e) ? e.code : String(e); } };

describe("X-ST-1: core.settle (spec §5.1)", () => {
  it("empty case first: a stream with no settle folds with settlement null and outcomeOf = module.outcome", () => {
    const f = fold([ev(1, "core.start")]);
    expect(f.settlement).toBeNull();
    expect(outcomeOf(boardgame, f)).toBeNull();
  });

  it("X-ST-1: is registered as a core event and validates its payload", () => {
    expect(Object.hasOwn(CORE_EVENT_SCHEMAS, "core.settle")).toBe(true);
    expect(codeOf(() => fold([...drawn, ev(3, "core.settle", { winner: H, method: "coin" })]))).toBe("INVALID_EVENT");
    expect(codeOf(() => fold([...drawn, ev(3, "core.settle", { winner: H })]))).toBe("INVALID_EVENT");
  });

  it("X-ST-1: on a draw it gives win{winner, loser, settled_<method>} for each declared method, and leaves the score untouched", () => {
    let checked = 0;
    for (const method of SETTLE_METHODS) {
      const f = fold([...drawn, settle(3, A, method)]);
      expect(outcomeOf(boardgame, f)).toEqual({ kind: "win", winner: A, loser: H, method: settledMethod(method) });
      expect(boardgame.outcome(f.state)).toEqual({ kind: "draw" }); // module state is not rewritten
      expect(boardgame.summary(f.state).headline).toBe(boardgame.summary(fold(drawn).state).headline); // no invented score
      checked++;
    }
    expect(checked).toBe(SETTLE_METHODS.length);
  });

  it("X-ST-1: is refused on a live fixture with no outcome and no abandon, and on a decided win", () => {
    expect(codeOf(() => fold([ev(1, "core.start"), settle(2)]))).toBe("SETTLE_NOT_APPLICABLE");
    expect(codeOf(() => fold([ev(1, "core.start"), ev(2, "boardgame.result", { winner: H, method: "checkmate" }), settle(3)]))).toBe("SETTLE_NOT_APPLICABLE");
  });

  it("X-ST-1: a second settle is refused (Review Focus 2)", () => {
    expect(codeOf(() => fold([...drawn, settle(3, H), settle(4, A)]))).toBe("SETTLE_NOT_APPLICABLE");
  });

  it("X-ST-1: a winner who is neither side is refused", () => {
    expect(codeOf(() => fold([...drawn, settle(3, "nobody")]))).toBe("INVALID_EVENT");
  });

  it("C12: settleApplies is THE precondition — level, or nothing decided with an abandon or a pending decider; never a win or an award", () => {
    const hooked = { awaitingDecider: (st: never) => (st as { phase?: string }).phase === "tiebreak" };
    const plain = {};
    const rows: [string, { outcome: unknown; abandoned: boolean; state: unknown }, object, boolean][] = [
      ["empty: nothing played, no abandon, no decider", { outcome: null, abandoned: false, state: { phase: "live" } }, hooked, false],
      ["draw", { outcome: { kind: "draw" }, abandoned: false, state: {} }, plain, true],
      ["tie", { outcome: { kind: "tie" }, abandoned: false, state: {} }, plain, true],
      ["no_result (a level abandon)", { outcome: { kind: "no_result" }, abandoned: true, state: {} }, plain, true],
      ["win (also: an active settle, via outcomeOf)", { outcome: { kind: "win", winner: H, loser: A }, abandoned: false, state: {} }, plain, false],
      ["award", { outcome: { kind: "award", winner: H }, abandoned: false, state: {} }, plain, false],
      ["abandoned with no outcome", { outcome: null, abandoned: true, state: {} }, plain, true],
      ["decider pending (hook true)", { outcome: null, abandoned: false, state: { phase: "tiebreak" } }, hooked, true],
      ["no hook declared: the same state is not settleable", { outcome: null, abandoned: false, state: { phase: "tiebreak" } }, plain, false],
    ];
    let checked = 0;
    for (const [name, facts, module, expected] of rows) { expect(settleApplies(module, facts as never), name).toBe(expected); checked++; }
    expect(checked).toBe(rows.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("C11: the kernel's precondition per outcome kind — draw, tie and no_result settle; win and award are refused (stub outcomes over the REAL kernel)", () => {
    const l = defaultLineupPair(generic.positions);
    const cfg = generic.configSchema.parse(generic.variants.score);
    const kinds = [{ kind: "draw" }, { kind: "tie" }, { kind: "no_result" }, { kind: "win", winner: l.home.entrantId, loser: l.away.entrantId }, { kind: "award", winner: l.home.entrantId }];
    let checked = 0;
    for (const o of kinds) {
      const stub = { ...generic, outcome: () => o }; // `decided` starts false (events.ts:532) and the settle is the only event, so only the precondition judges it
      const got = codeOf(() => foldMatchWithStoppage(stub as never, cfg as never, l, [ev(1, "core.settle", { winner: l.home.entrantId, method: "lot" })]));
      expect(got, o.kind).toBe(isLevelOutcome(o as never) ? null : "SETTLE_NOT_APPLICABLE");
      checked++;
    }
    expect(checked).toBe(5);
  });

  it("C12: a module with a pending decider accepts settle with no outcome and no abandon; without the hook the same stream is refused", () => {
    const l = defaultLineupPair(generic.positions);
    const cfg = generic.configSchema.parse(generic.variants.score);
    const stream = [ev(1, "core.start"), ev(2, "core.settle", { winner: l.away.entrantId, method: "lot" })];
    const pending = { ...generic, awaitingDecider: () => true };
    expect(outcomeOf(pending as never, foldMatchWithStoppage(pending as never, cfg as never, l, stream))).toEqual({ kind: "win", winner: l.away.entrantId, loser: l.home.entrantId, method: "settled_lot" });
    expect(codeOf(() => foldMatchWithStoppage(generic as never, cfg as never, l, stream))).toBe("SETTLE_NOT_APPLICABLE"); // the positive pair's negative
  });

  it("X-ST-1: closes an abandon whose module outcome is null", () => {
    const f = fold([ev(1, "core.start"), ev(2, "core.abandon", { reason: "rain" }), settle(3, H, "higher_seed")]);
    expect(boardgame.outcome(f.state)).toBeNull();
    expect(outcomeOf(boardgame, f)).toEqual({ kind: "win", winner: H, loser: A, method: "settled_higher_seed" });
  });

  it("X-ST-1: a void of the settle restores the prior state, and a new settle is then accepted", () => {
    const voided = fold([...drawn, settle(3, H), ev(4, "core.void", {}, "e-3")]);
    expect(voided.settlement).toBeNull();
    expect(outcomeOf(boardgame, voided)).toEqual({ kind: "draw" });
    const again = fold([...drawn, settle(3, H), ev(4, "core.void", {}, "e-3"), settle(5, A)]);
    expect(outcomeOf(boardgame, again)).toMatchObject({ kind: "win", winner: A });
  });

  it("X-ST-1: after a settle no play event is accepted (guarantee 4), but note and finalize are", () => {
    expect(codeOf(() => fold([ev(1, "core.start"), ev(2, "core.abandon", { reason: "r" }), settle(3), ev(4, "boardgame.result", { winner: H, method: "checkmate" })]))).toBe("ALREADY_DECIDED");
    expect(codeOf(() => fold([...drawn, settle(3), ev(4, "core.note", { text: "ok" })]))).toBeNull();
  });

  it("Review Focus 3: finalize after settling an abandon succeeds for EVERY sport (the kernel owns it there)", () => {
    let accepted = 0;
    const sports = forEachSport(({ key, module }) => {
      const lineups = defaultLineupPair(module.positions);
      for (const { name, cfg } of declaredCfgs(module as never)) { // never parse({}) blind: generic has no default (preflight C7)
        const base = [ev(1, "core.start"), ev(2, "core.abandon", { reason: "rain" })];
        const before = foldMatchWithStoppage(module, cfg as never, lineups, base);
        const o = outcomeOf(module, before);
        if (!(o === null || isLevelOutcome(o))) continue; // this cfg's 0–0 abandon awards a winner: settle is not applicable, by X-ST-1
        const f = foldMatchWithStoppage(module, cfg as never, lineups, [...base, ev(3, "core.settle", { winner: lineups.home.entrantId, method: "organiser" }), ev(4, "core.finalize")]);
        expect(outcomeOf(module, f), `${key}/${name}`).toMatchObject({ kind: "win", winner: lineups.home.entrantId, method: "settled_organiser" });
        accepted++;
      }
    });
    expect(sports).toBe(11);
    expect(accepted).toBeGreaterThan(0);
  });

  it("finding 4: settle is accepted while play is suspended after an abandon that left the stoppage open", () => {
    const f = fold([ev(1, "core.start"), ev(2, "core.suspend", { reason: "rain" }), ev(3, "core.abandon", { reason: "rain" }), settle(4)]);
    expect(f.stoppage).toBeNull();
    expect(outcomeOf(boardgame, f)).toMatchObject({ kind: "win", winner: H });
  });

  it("finding 2: core.settle never reaches module.apply", () => {
    const seen: string[] = [];
    const spy = { ...generic, apply: (s: never, e: EventEnvelope, c: never) => { seen.push(e.type); return generic.apply(s, e as never, c); } };
    const cfg = generic.configSchema.parse({ allowDraws: true, resultMode: "score" });
    const l = defaultLineupPair(generic.positions);
    foldMatchWithStoppage(spy as never, cfg as never, l, [ev(1, "generic.result", { p1Score: 1, p2Score: 1 }), ev(2, "core.settle", { winner: l.home.entrantId, method: "lot" })]);
    expect(seen).toEqual(["generic.result"]);
  });

  it("rule 10: any sequence of settle / void-last / note on a drawn game keeps the invariants after every step", () => {
    // Invariants: (a) outcomeOf is a settled win iff an active settle exists; (b) a refused step leaves nothing behind.
    const step = fc.constantFrom("settleH", "settleA", "voidLast", "note");
    let total = 0; // steps checked across ALL runs (anti-vacuity: zero is a failure)
    let refusedSeen = 0;
    fc.assert(fc.property(fc.array(step, { maxLength: 12 }), (steps) => {
      const events: EventEnvelope[] = [...drawn];
      for (const s of steps) {
        const seq = events.length + 1;
        const candidate =
          s === "settleH" ? settle(seq, H) : s === "settleA" ? settle(seq, A)
          : s === "note" ? ev(seq, "core.note", { text: "n" })
          : (() => { const live = events.filter((e) => e.type !== "core.void" && !events.some((v) => v.voids === e.id)); const t = live.at(-1); return t === undefined || t.seq <= 2 ? null : ev(seq, "core.void", {}, t.id); })();
        if (candidate === null) continue;
        const before = JSON.stringify(fold(events));
        try { fold([...events, candidate]); events.push(candidate); } catch (e) {
          if (!EngineError.is(e)) throw e;
          expect(JSON.stringify(fold(events))).toBe(before); // (b): the refused step left the fold byte-equal
          refusedSeen++;
        }
        const f = fold(events);
        const activeSettle = events.some((e) => e.type === "core.settle" && !events.some((v) => v.voids === e.id));
        expect(outcomeOf(boardgame, f)?.kind).toBe(activeSettle ? "win" : "draw"); // (a)
        total++;
      }
    }), { numRuns: 200 });
    expect(total).toBeGreaterThan(0);
    expect(refusedSeen).toBeGreaterThan(0); // a second settle is generated often enough to witness (b)
  });
});
```

`E/sports/cricket/cricket.test.ts`, added inside the describe that declares `tiedMain` (preflight C11: a REAL tie through the real kernel, not a stub):

```ts
  it("X-ST-1 (C11): a league tie folds to {kind:'tie'} and an organiser settle turns it into a settled win", () => {
    const { events } = tiedMain("repeat");
    const settleEv = makeEnvelope(events.length + 1, { type: "core.settle", payload: { winner: lineups.away.entrantId, method: "lot" } } as never);
    const before = foldMatchWithStoppage(cricket, t20, lineups, events);
    expect(outcomeOf(cricket, before)).toEqual({ kind: "tie" }); // the precondition's input is a tie, not a draw
    const after = foldMatchWithStoppage(cricket, t20, lineups, [...events, settleEv]);
    expect(outcomeOf(cricket, after)).toEqual({ kind: "win", winner: lineups.away.entrantId, loser: lineups.home.entrantId, method: "settled_lot" });
  });
```

It imports `foldMatchWithStoppage, outcomeOf` from `../../core/events.ts` beside the existing `foldMatch` import (`:4`).

If the property shrinks a failure, commit the shrunk `steps` array first, as a named `it("regression <seed>: …")` with that literal array, **before** the fix (R29).

- [ ] **Step 2: Run it; see it fail**

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a/packages/engine && rm -f "$TMPDIR/w2a-t4e.json" && pnpm vitest run src/core/settle.test.ts src/core/errors.test.ts --reporter=json --outputFile="$TMPDIR/w2a-t4e.json"; echo EXIT=$?
```

Expected: `EXIT=1`; `settle.test.ts` fails to collect (no `SETTLE_METHODS`).

- [ ] **Step 3: Append the error codes** (`E/core/errors.ts`, after `"SEEDING_MAP_SOURCE_AMBIGUOUS",`)

```ts
  // W2a (spec §7) — brackets always finish. Appended last, existing order frozen.
  // A settle on a fixture that is not level and not an un-outcomed abandon, or already settled.
  "SETTLE_NOT_APPLICABLE",
  // boardgame.tiebreak outside phase "tiebreak".
  "TIEBREAK_NOT_APPLICABLE",
  // A generic draw in a bracket kind (GN-KO-1); every other level result is held (X-BR-2).
  "LEVEL_RESULT_IN_BRACKET",
  // Assertion: a level result reached bracket seating (X-BR-1). Only a bug reaches it.
  "LEVEL_RESULT_SEATED",
```

Append the same four strings, with the same comment, to the end of the order list in `errors.test.ts`.

- [ ] **Step 4: Implement settle in the kernel** (`E/core/events.ts`)

Below `CoreResume`:

```ts
// W2a (spec §5.1, X-ST-1) — the organiser's settle. Kernel-owned like core.void
// and core.suspend: validated and folded here, NEVER forwarded to module.apply,
// so every sport gains it at once and no frozen golden moves. Not in CoreEv
// (finding 2): CoreEv is the payload set modules see.
export const SETTLE_METHODS = ["lot", "higher_seed", "organiser"] as const;
export const SettleMethod = z.enum(SETTLE_METHODS);
export type SettleMethod = z.infer<typeof SettleMethod>;
export const CoreSettle = z.strictObject({
  winner: EntrantId,
  method: SettleMethod,
  note: z.string().trim().min(1).max(500).optional(),
});
export const settledMethod = (m: SettleMethod): `settled_${SettleMethod}` => `settled_${m}`;

/** An active settle: who advances, who does not, why, and the event that said so. */
export interface Settlement {
  readonly winner: string;
  readonly loser: string;
  readonly method: SettleMethod;
  readonly eventId: string;
}

/** THE settle precondition (spec §5.1 as amended by controller ruling C12). One predicate for the kernel and the
 *  console (through the server's `settle_applies`): a level outcome, or nothing decided while the match is abandoned
 *  or a module-declared decider is pending (chess phase "tiebreak": lots is the organiser's settle, ruling 73).
 *  `outcome` is the EFFECTIVE outcome, so an active settle reads as a win and is not settleable again. */
export interface SettleFacts { readonly outcome: MatchOutcome | null; readonly abandoned: boolean; readonly state: unknown }
export function settleApplies(module: { awaitingDecider?(state: never): boolean }, f: SettleFacts): boolean {
  if (isLevelOutcome(f.outcome)) return true;
  return f.outcome === null && (f.abandoned || module.awaitingDecider?.(f.state as never) === true);
}

/** THE outcome of a fold. A settlement outranks the module's own outcome (a
 *  draw it settled, or the null of an abandon); otherwise it is exactly
 *  `module.outcome(state)`. Every reader of a fold's outcome calls this
 *  (outcome-readers.test.ts pins the list). */
export function outcomeOf<Cfg, State>(
  module: Pick<FoldableModule<Cfg, State>, "outcome">,
  folded: { readonly state: State; readonly settlement: Settlement | null },
): MatchOutcome | null {
  const s = folded.settlement;
  if (s !== null) return { kind: "win", winner: s.winner, loser: s.loser, method: settledMethod(s.method) };
  return module.outcome(folded.state);
}
```

Then:
- add `"core.settle": CoreSettle,` to `CORE_EVENT_SCHEMAS`, after `"core.resume"`;
- change `POST_DECISION_CORE` to `["core.note", "core.finalize", "core.award", "core.settle"]`;
- add `"core.settle",` to `DURING_STOPPAGE` after `"core.finalize"`, with the comment `// W2a finding 4: a settle closes an abandon that left the stoppage open.`;
- import `MatchOutcome` and `isLevelOutcome` from `./types.ts` if they are not already imported;
- in `E/sport/module.ts`, add to the module interface (and to `FoldableModule`'s picked keys): `awaitingDecider?(state: State): boolean; // W2a C12: a level game held for a decider the scorer records`.

In `foldMatchWithStoppage`, change the return type to `{ state: State; stoppage: MatchStoppage | null; squads: SquadState; settlement: Settlement | null }`. Declare `let settlement: Settlement | null = null;` and `let abandonActive = false;` beside `let stoppage`. Add these branches **before** `if (event.type === "core.suspend")`:

```ts
    if (event.type === "core.settle") {
      // X-ST-1 precondition (spec §5.1). Not gated on `strict` (D2): the
      // module outcome it reads is folded against the frozen cfg, and the
      // shape "level, or abandoned with nothing" does not move with cfg.
      const effective = outcomeOf(module, { state, settlement });
      if (!settleApplies(module, { outcome: effective, abandoned: abandonActive, state })) {
        throw new EngineError(
          "SETTLE_NOT_APPLICABLE",
          settlement !== null
            ? "this fixture is already settled — void the settle first"
            : "settle applies only to a level result, an abandoned match with no result, or a pending tie-break",
          { eventId: event.id, outcome: effective, abandoned: abandonActive },
        );
      }
      const p = event.payload as z.infer<typeof CoreSettle>;
      const { home, away } = { home: lineups.home.entrantId, away: lineups.away.entrantId };
      if (p.winner !== home && p.winner !== away) {
        throw new EngineError("INVALID_EVENT", `core.settle winner "${p.winner}" is neither side of this fixture`, { eventId: event.id });
      }
      settlement = { winner: p.winner, loser: p.winner === home ? away : home, method: p.method, eventId: event.id };
      decided = true;
      stoppage = null;
      // kernel-owned: the module never sees it
    } else if (event.type === "core.finalize" && settlement !== null && module.outcome(state) === null) {
      // Finding 21: a settled ABANDON has no module outcome, and modules refuse
      // to finalize an undecided state. The kernel owns finalize exactly here.
      // kernel-owned: the module never sees it
    } else if (event.type === "core.suspend") {
```

The existing `if (event.type === "core.suspend")` becomes the `else if` shown. In the module branch, after `state = module.apply(…)`, add `if (event.type === "core.abandon") abandonActive = true;`. Change the final `return { state, stoppage, squads };` to `return { state, stoppage, squads, settlement };`.

- [ ] **Step 5: Run the engine tests green**

The Step 2 command, with `src/core/events.test.ts src/core/events.time.test.ts src/sports/cricket/cricket.test.ts` added. Expected:
- `EXIT=0`;
- `files: 4`, `failed: 0`;
- the golden suites untouched: run `src/testkit/golden.test.ts` too. Expected `failed: 0` with no golden file changed (`git status --porcelain packages/engine/src/testkit/golden` is empty).

- [ ] **Step 6: Map the codes in the app** (`tsc` forces it, because both maps are `Record<EngineErrorCode, …>`)

`W/server/api-v1/http.ts`, in `ENGINE_HTTP`:

```ts
  SETTLE_NOT_APPLICABLE: 409,
  TIEBREAK_NOT_APPLICABLE: 409,
  LEVEL_RESULT_IN_BRACKET: 409,
  // An assertion (X-BR-1): reaching it is a server bug, so it surfaces as one.
  LEVEL_RESULT_SEATED: 500,
```

`W/lib/scoring-vocab.ts`, in `ENGINE_ERROR_KEY`:

```ts
  SETTLE_NOT_APPLICABLE: "engineError.SETTLE_NOT_APPLICABLE",
  TIEBREAK_NOT_APPLICABLE: "engineError.TIEBREAK_NOT_APPLICABLE",
  LEVEL_RESULT_IN_BRACKET: "engineError.LEVEL_RESULT_IN_BRACKET",
  LEVEL_RESULT_SEATED: "engineError.LEVEL_RESULT_SEATED",
```

`W/dictionaries/<loc>/ui.json`, inside `engineError` beside `DRAW_NOT_ALLOWED` (`:3872` in en):

| key | en | fr | es | nl |
|---|---|---|---|---|
| `SETTLE_NOT_APPLICABLE` | "This match can't be settled — it isn't level, or it's already settled." | "Ce match ne peut pas être tranché — il n'est pas à égalité, ou il l'est déjà." | "Este partido no se puede resolver: no está empatado o ya se resolvió." | "Deze wedstrijd kan niet beslist worden — hij staat niet gelijk of is al beslist." |
| `TIEBREAK_NOT_APPLICABLE` | "A tie-break can only follow a drawn knockout game." | "Un départage ne peut suivre qu'une partie nulle à élimination directe." | "Un desempate solo puede seguir a una partida eliminatoria en tablas." | "Een tiebreak kan alleen volgen op een remise in een knock-outpartij." |
| `LEVEL_RESULT_IN_BRACKET` | "Enter the winner — a knockout match can't end level." | "Saisissez le vainqueur — un match à élimination directe ne peut pas finir à égalité." | "Introduce el ganador: un partido eliminatorio no puede terminar en empate." | "Voer de winnaar in — een knock-outwedstrijd kan niet gelijk eindigen." |
| `LEVEL_RESULT_SEATED` | "Something went wrong placing this result. We've been notified." | "Un problème est survenu en plaçant ce résultat. Nous avons été prévenus." | "Algo salió mal al colocar este resultado. Ya hemos sido avisados." | "Er ging iets mis bij het plaatsen van deze uitslag. We zijn op de hoogte." |

Run `cd <wt> && pnpm i18n:gen-keys && pnpm i18n:check; echo EXIT=$?`. Expected: `EXIT=0`, with the generated `i18n-keys.ts` diff listing exactly the four keys.

- [ ] **Step 7: Write the reader-pin test (it fails until Step 8)** — `W/server/engine-db/__tests__/outcome-readers.test.ts`

```ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Finding 1 (W2a): a settle lives beside module state, so a fold's outcome is
// `outcomeOf(module, folded)`. A bare `<module>.outcome(state)` on a FOLD
// result silently drops a settle (class 1, the inert seam). Each remaining bare
// call is listed with why it is not a fold result.
const REPO = resolve(__dirname, "../../../../../..");
const ROOTS = ["apps/web/src", "packages/engine/src", "tools/matrix/lib"];
const BARE = /\b[A-Za-z]+\.outcome\((state|next|folded)\b/g;
const ALLOWED: Readonly<Record<string, string>> = {
  "packages/engine/src/core/events.ts": "the kernel itself (decided flag, settle precondition, outcomeOf)",
  "apps/web/src/server/overlay/recent.ts": "a point-state PROBE over a stored module state (:321, :355), not a fold result; a settlement is never part of module state, so outcomeOf cannot apply (preflight C8)",
  "packages/engine/src/testkit/stoppages.ts": "testkit: module-level conformance, no settle in its streams",
  "packages/engine/src/testkit/conformance.ts": "testkit: module-level conformance, no settle in its streams",
  "packages/engine/src/testkit/simulation.ts": "testkit: simulation folds without settle",
  "packages/engine/src/testkit/scenarios.ts": "testkit: scenario builder folds without settle",
};
function walk(dir: string, out: string[]): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (e !== "node_modules" && e !== "__tests__") walk(p, out); }
    else if (/\.(ts|tsx)$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}

describe("finding 1: every fold-outcome reader goes through outcomeOf", () => {
  it("no bare <module>.outcome(state) outside the allowed list, and outcomeOf's readers are exactly the six moved fold readers", () => {
    const files = ROOTS.flatMap((r) => walk(join(REPO, r), []));
    expect(files.length).toBeGreaterThan(100);
    const bare: string[] = [];
    const readers: string[] = [];
    for (const f of files) {
      const rel = relative(REPO, f);
      const text = readFileSync(f, "utf8");
      if (/\boutcomeOf\(/.test(text) && rel !== "packages/engine/src/core/events.ts") readers.push(rel);
      if (ALLOWED[rel] !== undefined) continue;
      for (const m of text.matchAll(BARE)) bare.push(`${rel}: ${m[0]}`);
    }
    expect(bare).toEqual([]);
    // Exactly the six fold readers Step 8 moves (preflight C8). A later task that adds a reader adds it here by name.
    expect(readers.sort()).toEqual([
      "apps/web/src/server/engine-db/append-event.ts",
      "apps/web/src/server/engine-db/fold.ts",
      "apps/web/src/server/usecases/event-import.ts",
      "packages/engine/src/sports/cricket/scorecard.ts",
      "tools/matrix/lib/fold.ts",
      "tools/matrix/lib/model/ledger-fold.ts",
    ]);
  });
  it("every allowed file still exists and still holds a bare call (a stale entry is a failure)", () => {
    for (const rel of Object.keys(ALLOWED)) expect(readFileSync(join(REPO, rel), "utf8"), rel).toMatch(BARE);
  });
});
```

`REPO` resolves from `apps/web/src/server/engine-db/__tests__` up six levels to the worktree root; the executor confirms it by printing `REPO` once.

- [ ] **Step 8: Move each reader to `outcomeOf`**

- `fold.ts` `foldFrom`:

  ```ts
  const folded = foldMatchWithStoppage(sportModule, cfg, lineups, envelopes);
  const state = folded.state;
  return { fixtureId, lastSeq: envelopes[envelopes.length - 1]!.seq, state, summary: sportModule.summary(state), outcome: outcomeOf(sportModule, folded), active: resolveVoids(envelopes) };
  ```

- `append-event.ts`: the IIFE returns `foldMatchWithStoppage(sportModule, cfg, lineups, stream, { strictFromSeq: candidate.seq })` into `folded`, then `const state = folded.state;` and `const outcome = outcomeOf(sportModule, folded);`.
- `event-import.ts:300-324`: the same pattern. `if (outcomeOf(sportModule, folded) === null) {`.
- `scorecard.ts:1153-1155`:

  ```ts
  const folded = foldMatchWithStoppage(cricket, cfg, lineups, events, { onFolded: observe });
  const state = folded.state;
  const summary = cricket.summary(state);
  const outcome = outcomeOf(cricket, folded);
  ```

- `tools/matrix/lib/fold.ts:61-62`: `const folded = foldMatchWithStoppage(...); return { outcome: outcomeOf(module, folded), state: folded.state };`.
- `tools/matrix/lib/model/ledger-fold.ts:37-38`: `const folded = foldMatchWithStoppage(...); return outcomeOf(m, folded);`.

Each file imports `foldMatchWithStoppage, outcomeOf` from `@seazn/engine/core` (scorecard: `../../core/events.ts`). `overlay/recent.ts` is not touched: it stays bare and is in `ALLOWED` with its reason; the reviewer confirms that reason by reading `:300-360`.

- [ ] **Step 9: Run the scoped app, engine and harness tests**

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a/apps/web && rm -f "$TMPDIR/w2a-t4.json" && pnpm vitest run src/server/engine-db/__tests__/outcome-readers.test.ts src/server/engine-db/__tests__/replay.test.ts src/server/engine-db/__tests__/append-event.test.ts src/server/usecases/__tests__/event-import-dryrun.test.ts --reporter=json --outputFile="$TMPDIR/w2a-t4.json"; echo EXIT=$?
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a/packages/engine && rm -f "$TMPDIR/w2a-t4e.json" && pnpm vitest run src/core/settle.test.ts src/core/errors.test.ts src/core/events.test.ts src/sports/cricket/scorecard.test.ts src/sports/cricket/cricket.test.ts --reporter=json --outputFile="$TMPDIR/w2a-t4e.json"; echo EXIT=$?
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a && rm -f "$TMPDIR/w2a-t4m.json" && ./packages/engine/node_modules/.bin/vitest run --reporter=json --outputFile="$TMPDIR/w2a-t4m.json" --testTimeout=30000 tools/matrix/__tests__/fold.test.ts tools/matrix/__tests__/model-core.test.ts; echo EXIT=$?
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a/apps/web && rtk proxy node ../../node_modules/typescript-native/bin/tsc --noEmit -p tsconfig.json; echo EXIT=$?
```

Expected: each `EXIT=0`, and each judge line with `failed: 0` and the right file count. Before the run, confirm with `ls` that every path exists, so a missing file is not silently dropped as a filter (memory).

- [ ] **Step 10: Mutate each member once (runner, then changed-lines Stryker)**

| Mutant | Expected red |
|---|---|
| `if (!settleApplies(module, { outcome: effective,` → `if (false && !settleApplies(module, { outcome: effective,` | "is refused on a live fixture …" |
| `const effective = outcomeOf(module, { state, settlement });` → `const effective = module.outcome(state);` | "a second settle is refused" |
| `if (isLevelOutcome(f.outcome)) return true;` → `if (f.outcome?.kind === "draw") return true;` | cricket.test.ts "X-ST-1 (C11): a league tie …" (the drop-tie mutant), plus "C11: the kernel's precondition per outcome kind …" |
| `(f.abandoned \|\| module.awaitingDecider` → `(module.awaitingDecider` | "X-ST-1: closes an abandon whose module outcome is null" |
| `module.awaitingDecider?.(f.state as never) === true` → `false` | "C12: a module with a pending decider accepts settle …" and the truth table's decider row |
| Remove `"core.settle"` from `DURING_STOPPAGE` | "finding 4: settle is accepted while play is suspended" |
| Remove `"core.settle"` from `POST_DECISION_CORE` | "on a draw it gives win …" (`ALREADY_DECIDED`) |
| Delete the kernel `core.finalize` branch | "Review Focus 3", for boardgame at least |
| `outcomeOf` returns `module.outcome(folded.state)` always | "on a draw it gives win …" and `outcome-readers` stays green (it is a scan). The killer is the settle test, which is named |
| Winner check `p.winner !== home && p.winner !== away` → `false` | "a winner who is neither side is refused" |
| Revert `fold.ts` to `sportModule.outcome(state)` | `outcome-readers.test.ts` "no bare …" |

Each row above becomes one entry of `MUT/t4.json`:
- `find` is the exact source text the row names, copied from this task's code blocks, and `replace` is its mutation;
- `killers` is `[{ "cwd": "packages/engine", "files": [<the test file the row names>], "name": <the test title the row names> }]`.

Then run the runner:

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a && pnpm mutate --list docs/superpowers/specs/2026-09-27-format-matrix-prompts/mutants/w2a/t4.json --json-out "$TMPDIR/w2a-mut-t4.json"; echo EXIT=$?
```

Expected: `EXIT=0`; every row `KILLED by` the named test, 0 survived. Paste the table into the report. The last row's killer is `{ "cwd": "apps/web", "files": ["src/server/engine-db/__tests__/outcome-readers.test.ts"] }`.


Then run changed-lines Stryker over this task's engine diff (Global Constraints, Mutation):

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a/packages/engine && rm -f reports/mutation/changed.json && M="$(node scripts/stryker-changed.mjs --base "$TASK_BASE")" && STRYKER_MUTATE="$M" pnpm mutation > "$TMPDIR/w2a-stryker-t4.log" 2>&1; echo EXIT=$?; node scripts/stryker-changed.mjs --report reports/mutation/changed.json --expect "$M"; echo REPORT_EXIT=$?
```

Expected: `REPORT_EXIT=0`, with `survived: 0, noCoverage: 0` and a `by <test>` on every killed row. A survivor gets a killing test, or an equivalence row the reviewer signs. The range covers every earlier loop-D task's lines too, so a later task's run re-proves them.

- [ ] **Step 11: Proof bookkeeping, commit**
  - Delete `["X-ST-1", "Task 4"]` from `AWAITING_PROOF`. Set X-ST-1's proved-by to `` `packages/engine/src/core/settle.test.ts` ``.
  - Run `rules-reference.test.ts` green.
  - Commit: `feat(engine): core.settle owned by the kernel, outcomeOf at every fold reader, four W2a error codes (X-ST-1)`.

**Four test types:**
- Unit: Steps 1–9.
- E2E: Task 11's `bracket-finish.spec.ts` "settle on the console".
- Smoke: Task 17's `bracketFinishSuite`.
- Regression: Task 16; the committed fast-check seed, if any shrank.

---

### Task 5: `bracketDeciders`, the boardgame tie-break (BG-KO-1, BG-KO-2), carrom's extra board (CA-KO-1)

**Loop D, continued. The loop's review runs after this task, over the diff of Tasks 3–5.**

**Files:**
- Modify: `E/sport/module.ts` (add `bracketDeciders` next to `supportsDraws`, `:830`)
- Modify: every module literal, giving each a `bracketDeciders`:
  - `E/sports/boardgame/boardgame.ts`, `E/sports/carrom/carrom.ts`, `E/sports/generic/generic.ts`, `E/sports/football/football.ts`, `E/sports/cricket/cricket.ts`;
  - `E/sports/period/kernel.ts` (hockey and ice hockey through `makePeriodModule`);
  - `E/sports/setbased/kernel.ts` (badminton, table tennis, volleyball);
  - `E/sports/nested/kernel.ts` (tennis).
- Modify: `E/sports/boardgame/boardgame.ts`: cfg `:46-79`, method/state `:104-209`, `decideResult` `:243-280`, schemas `:378-381`, padSpec `:457-491`, `apply` `:600-645`, `summary` `:647-680`
- Modify: `E/testkit/golden.ts` (`COVERAGE_CONFIGS.boardgame`), `E/sports/boardgame/boardgame.schema.json` (regenerated)
- Create: `E/sport/bracket-deciders.test.ts`, `E/sports/boardgame/tiebreak.test.ts`
- Modify: `E/sports/carrom/carrom.test.ts` (add the bracket case beside `:157-170`)

**Interfaces:**
- Consumes: `BRACKET_KINDS`, `DRAW_KINDS` (Task 3); `EngineErrorCode` `TIEBREAK_NOT_APPLICABLE` (Task 4).
- Produces:
  ```ts
  // SportModule
  bracketDeciders(cfg: Cfg): Partial<Cfg>;
  // boardgame
  export const TIEBREAK_RUNGS: readonly ["rapid", "blitz", "armageddon"];
  export type TiebreakRung = (typeof TIEBREAK_RUNGS)[number];
  export const BoardgameTiebreak: z.ZodType<{ rung: TiebreakRung; winner: string; score?: string }>;
  export const CHESS_SCORE: RegExp; // /^(\d+½?|½)–(\d+½?|½)$/
  export const BOARDGAME_TIEBREAK_TYPE = "boardgame.tiebreak";
  // BoardgameCfg.tiebreak?: boolean   (absent = false; finding 12)
  // BoardgameState.phase adds "tiebreak"; BoardgameState.tiebreak?: { rung?: TiebreakRung; score?: string }
  // summary(...).detail.tiebreak?: { rung?: TiebreakRung; score?: string }   (pending while in phase tiebreak)
  // boardgame.awaitingDecider = (s) => s.phase === "tiebreak"   (Task 4's optional hook; controller ruling C12:
  //   lots is the organiser's settle in phase tiebreak, so settleApplies is true there)
  ```

- [ ] **Step 0: Finding 20 is recorded as ruling 82.** The armageddon "Drawn — Black advances" choice is out of W2a. The payload carries no draw field, the scorer always records the winner, and armageddon colours (`black: EntrantId`) are W2c's. Nothing to ask; build to it.

- [ ] **Step 1: Write the failing tests**

`E/sport/bracket-deciders.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";

/** Spec §5.2's declarations, read from the rule rows: BG-KO-1 (tiebreak),
 *  CA-KO-1 (extra board); every other sport declares nothing in W2a. */
const RULED: Readonly<Record<string, Record<string, unknown>>> = {
  boardgame: { tiebreak: true }, // BG-KO-1
  carrom: { tieBoard: "extra" }, // CA-KO-1
};

describe("bracketDeciders, per sport (spec §5.2)", () => {
  it("empty case first: {} is a legal declaration and changes nothing when merged", () => {
    const cfg = { a: 1 };
    expect({ ...cfg, ...{} }).toEqual(cfg);
  });
  it("BG-KO-1 CA-KO-1: every sport declares exactly its ruled overlay, and the overlay parses under its own schema", () => {
    let checked = 0;
    let nonEmpty = 0;
    const sports = forEachSport(({ key, module }) => {
      for (const { cfg } of declaredCfgs(module as never)) { // preflight C7: generic has no schema default
        const overlay = module.bracketDeciders(cfg as never) as Record<string, unknown>;
        expect(overlay, key).toEqual(RULED[key] ?? {});
        expect(() => module.configSchema.parse({ ...(cfg as object), ...overlay }), key).not.toThrow();
        if (Object.keys(overlay).length > 0) nonEmpty++;
        checked++;
      }
    });
    expect(sports).toBe(11);
    expect(checked).toBeGreaterThan(11);
    expect(nonEmpty).toBeGreaterThan(0);
  });
  it("CA-KO-1: the overlay wins over a division tieBoard 'draw' (right answer differs from the division's constant)", () => {
    let checked = 0;
    forEachSport(({ key, module }) => {
      if (key !== "carrom") return; // one-line reason: CA-KO-1 is carrom's own rule
      const cfg = module.configSchema.parse({ tieBoard: "draw" }) as { tieBoard: string };
      expect({ ...cfg, ...module.bracketDeciders(cfg as never) }.tieBoard).toBe("extra");
      checked++;
    });
    expect(checked).toBe(1);
  });
});
```

`E/sports/boardgame/tiebreak.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { EngineError } from "../../core/errors.ts";
import { foldMatch, foldMatchWithStoppage, outcomeOf, settleApplies, type EventEnvelope } from "../../core/events.ts";
import { defaultLineupPair, makeEnvelope } from "../../testkit/index.ts";
import { boardgame, CHESS_SCORE, TIEBREAK_RUNGS } from "./boardgame.ts";

const ev = (seq: number, type: string, payload: unknown = {}): EventEnvelope => makeEnvelope(seq, { type, payload } as never);
const lineups = defaultLineupPair(boardgame.positions);
const H = lineups.home.entrantId;
const A = lineups.away.entrantId;
const ko = boardgame.configSchema.parse({ ...boardgame.bracketDeciders(boardgame.configSchema.parse({})) });
const league = boardgame.configSchema.parse({});
const drawn = [ev(1, "core.start"), ev(2, "boardgame.result", { winner: null, method: "agreement" })];
const fold = (cfg: unknown, events: EventEnvelope[]) => foldMatch(boardgame, cfg as never, lineups, events);
const codeOf = (f: () => unknown): string | null => { try { f(); return null; } catch (e) { return EngineError.is(e) ? e.code : String(e); } };

describe("BG-KO-1 / BG-KO-2: the chess knockout tie-break (ruling 73)", () => {
  it("empty case first: without tiebreak in cfg a drawn game is an ordinary draw (golden-safe)", () => {
    expect("tiebreak" in league).toBe(false); // absent, never defaulted (finding 12)
    expect(boardgame.outcome(fold(league, drawn))).toEqual({ kind: "draw" });
  });
  it("BG-KO-1: with tiebreak, a drawn game opens phase 'tiebreak' with no outcome, and the summary keeps the level score", () => {
    const s = fold(ko, drawn);
    expect(s.phase).toBe("tiebreak");
    expect(boardgame.outcome(s)).toBeNull();
    expect(boardgame.summary(s).headline).toBe(boardgame.summary(fold(league, drawn)).headline); // ½ — ½, never "vs"
  });
  it("BG-KO-1: a double forfeit still folds to no_result (W2b owns it), never a tie-break", () => {
    expect(boardgame.outcome(fold(ko, [ev(1, "core.start"), ev(2, "boardgame.result", { winner: null, method: "double_forfeit" })]))).toEqual({ kind: "no_result" });
  });
  it("BG-KO-1: each rung decides a win with method tiebreak_<rung>, and the summary still shows the level game", () => {
    let checked = 0;
    for (const rung of TIEBREAK_RUNGS) {
      const s = fold(ko, [...drawn, ev(3, "boardgame.tiebreak", { rung, winner: A })]);
      expect(boardgame.outcome(s), rung).toEqual({ kind: "win", winner: A, loser: H, method: `tiebreak_${rung}` });
      expect(boardgame.summary(s).headline).toBe(boardgame.summary(fold(league, drawn)).headline);
      expect((boardgame.summary(s).detail as { tiebreak?: unknown }).tiebreak).toEqual({ rung });
      checked++;
    }
    expect(checked).toBe(3);
  });
  it("BG-KO-1: a tiebreak outside phase 'tiebreak' is refused, per rung", () => {
    let checked = 0;
    for (const rung of TIEBREAK_RUNGS) {
      expect(codeOf(() => fold(ko, [ev(1, "core.start"), ev(2, "boardgame.tiebreak", { rung, winner: H })])), rung).toBe("TIEBREAK_NOT_APPLICABLE");
      expect(codeOf(() => fold(league, [...drawn, ev(3, "boardgame.tiebreak", { rung, winner: H })])), rung).toBe("ALREADY_DECIDED");
      checked++;
    }
    expect(checked).toBe(3);
  });
  it("BG-KO-1: a second tiebreak is refused", () => {
    expect(codeOf(() => fold(ko, [...drawn, ev(3, "boardgame.tiebreak", { rung: "rapid", winner: H }), ev(4, "boardgame.tiebreak", { rung: "blitz", winner: A })]))).toBe("ALREADY_DECIDED");
  });
  it("BG-KO-2 (ruling 82): the engine records the armageddon winner the scorer taps — either side, with or without colours", () => {
    // W2a enforces BG-KO-2 by the pad's hint (Task 12), not here; colours are W2c's (spec §2.3).
    const noColours = boardgame.configSchema.parse({ colors: false, tiebreak: true });
    let checked = 0;
    for (const cfg of [ko, noColours]) for (const winner of [H, A]) {
      const s = fold(cfg, [...drawn, ev(3, "boardgame.tiebreak", { rung: "armageddon", winner })]);
      expect(boardgame.outcome(s)).toEqual({ kind: "win", winner, loser: winner === H ? A : H, method: "tiebreak_armageddon" });
      checked++;
    }
    expect(checked).toBe(4);
  });
  it("the optional score is validated as a chess score", () => {
    for (const ok of ["1½–½", "2–0", "½–1½", "3–2"]) expect(CHESS_SCORE.test(ok), ok).toBe(true);
    for (const bad of ["1.5-0.5", "2-0", "", "–", "a–b", "1½–½ "]) expect(CHESS_SCORE.test(bad), bad).toBe(false);
    expect(codeOf(() => fold(ko, [...drawn, ev(3, "boardgame.tiebreak", { rung: "rapid", winner: A, score: "2-0" })]))).toBe("INVALID_EVENT");
    const s = fold(ko, [...drawn, ev(3, "boardgame.tiebreak", { rung: "rapid", winner: A, score: "1½–½" })]);
    expect((boardgame.summary(s).detail as { tiebreak?: unknown }).tiebreak).toEqual({ rung: "rapid", score: "1½–½" });
  });
  it("C12: in phase tiebreak lots is the organiser's settle — settleApplies is true, a settle decides, and a later tiebreak is refused", () => {
    const pending = fold(ko, drawn);
    expect(settleApplies(boardgame, { outcome: boardgame.outcome(pending), abandoned: false, state: pending })).toBe(true);
    const settled = foldMatchWithStoppage(boardgame, ko as never, lineups, [...drawn, ev(3, "core.settle", { winner: A, method: "lot" })]);
    expect(outcomeOf(boardgame, settled)).toEqual({ kind: "win", winner: A, loser: H, method: "settled_lot" });
    expect(codeOf(() => foldMatchWithStoppage(boardgame, ko as never, lineups, [...drawn, ev(3, "core.settle", { winner: A, method: "lot" }), ev(4, "boardgame.tiebreak", { rung: "rapid", winner: H })]))).toBe("ALREADY_DECIDED");
    // The positive pair's negative: in phase "live" (nothing played) the same settle is refused.
    expect(settleApplies(boardgame, { outcome: null, abandoned: false, state: fold(ko, [ev(1, "core.start")]) })).toBe(false);
    expect(codeOf(() => foldMatchWithStoppage(boardgame, ko as never, lineups, [ev(1, "core.start"), ev(2, "core.settle", { winner: A, method: "lot" })]))).toBe("SETTLE_NOT_APPLICABLE");
  });
  it("abandon in phase tiebreak is accepted and leaves the outcome null (closed by settle, X-ST-1)", () => {
    const s = fold(ko, [...drawn, ev(3, "core.abandon", { reason: "venue closed" })]);
    expect(s.phase).toBe("abandoned");
    expect(boardgame.outcome(s)).toBeNull();
  });
  it("padSpec: unchanged for a cfg without tiebreak; with it, a tie-break panel gated on state.phase", () => {
    const plain = boardgame.padSpec!(league);
    expect(plain.panels.map((p) => p.gate)).toEqual(plain.panels.map(() => undefined));
    const withTb = boardgame.padSpec!(ko);
    const tb = withTb.panels.find((p) => p.actions.some((a) => a.type === "boardgame.tiebreak"));
    expect(tb?.gate).toEqual({ op: "path-equals", path: "state.phase", value: "tiebreak" });
    expect(withTb.fidelity["boardgame.tiebreak"]).toBe(0);
  });
});
```

- [ ] **Step 2: Run them; see them fail**

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a/packages/engine && rm -f "$TMPDIR/w2a-t5e.json" && pnpm vitest run src/sport/bracket-deciders.test.ts src/sports/boardgame/tiebreak.test.ts --reporter=json --outputFile="$TMPDIR/w2a-t5e.json"; echo EXIT=$?
```

Expected: `EXIT=1`; both suites fail to collect (`bracketDeciders` is not a function; `TIEBREAK_RUNGS` is not exported).

- [ ] **Step 3: Add `bracketDeciders` to the interface and to every module**

`E/sport/module.ts`, under `supportsDraws`:

```ts
  // W2a (spec §5.2, ruling 76) — the cfg changes a BRACKET stage applies on top
  // of the resolved cfg (resolveFixtureCfg merges it by stage kind; the V347
  // freeze then carries it). `{}` is a legal declaration.
  bracketDeciders(cfg: Cfg): Partial<Cfg>;
```

Then the modules:
- boardgame: `bracketDeciders: () => ({ tiebreak: true }),` with the comment `// BG-KO-1`;
- carrom: `bracketDeciders: () => ({ tieBoard: "extra" as const }),` with the comment `// CA-KO-1 (ICF Law 56)`;
- generic, football and cricket: `bracketDeciders: () => ({}),` with the comment `// W2a: none (football/cricket deciders stay organiser-configured until W2c)`;
- the three kernels (`period`, `setbased`, `nested`), inside their `make…Module` object literals: `bracketDeciders: () => ({}),`.

`tsc` lists any module literal you missed.

- [ ] **Step 4: Implement the boardgame tie-break** (`E/sports/boardgame/boardgame.ts`)

In `BoardgameCfg` (before `clock`):

```ts
  // W2a BG-KO-1 — set by bracketDeciders in a bracket stage. OPTIONAL with NO
  // default (finding 12): cfg is serialised into every frozen golden state.
  tiebreak: z.boolean().optional(),
```

After `BoardgamePairing`:

```ts
// W2a BG-KO-1/BG-KO-2 (ruling 73). Lots is NOT a rung: drawing lots is the
// organiser's core.settle {method: "lot"}.
export const TIEBREAK_RUNGS = ["rapid", "blitz", "armageddon"] as const;
export type TiebreakRung = (typeof TIEBREAK_RUNGS)[number];
export const CHESS_SCORE = /^(\d+½?|½)–(\d+½?|½)$/;
export const BOARDGAME_TIEBREAK_TYPE = "boardgame.tiebreak";
export const BoardgameTiebreak = z.strictObject({
  rung: z.enum(TIEBREAK_RUNGS),
  winner: PersonId,
  score: z.string().regex(CHESS_SCORE).optional(),
});
export type BoardgameTiebreak = z.infer<typeof BoardgameTiebreak>;
```

Then:
- add `| BoardgameTiebreak` to the `BoardgameEv` union where it is declared, following the existing union style;
- add `"boardgame.tiebreak": BoardgameTiebreak,` to `BOARDGAME_EVENT_SCHEMAS`.

In `BoardgameState`: `phase: "pre" | "live" | "tiebreak" | "done" | "final" | "abandoned";` and

```ts
  // W2a — present from the moment a bracket game is drawn (phase "tiebreak");
  // `rung`/`score` land when the tie-break is recorded.
  // Absent on every stream that never reached a tie-break (golden-safe).
  tiebreak?: { rung?: TiebreakRung; score?: string };
```

In `decideResult`, replace the `if (winner === null) {…}` block:

```ts
  if (winner === null) {
    // Double forfeit ⇒ no result (both default); otherwise an ordinary draw —
    // unless this is a bracket game (BG-KO-1), which goes to the tie-break.
    if (method === "double_forfeit") return { ...base, outcome: { kind: "no_result" } };
    if (state.cfg.tiebreak === true) return { ...base, phase: "tiebreak", outcome: null, tiebreak: {} };
    return { ...base, outcome: { kind: "draw" } };
  }
```

Add `applyTiebreak` after `applyPairing`:

```ts
function tiebreakRefused(message: string, data?: unknown): never {
  throw new EngineError("TIEBREAK_NOT_APPLICABLE", message, data);
}

// W2a BG-KO-1. Only in phase "tiebreak". The scorer records the winner on every
// rung; BG-KO-2 (a drawn armageddon goes to Black) is the pad's hint in W2a, and
// armageddon colours are W2c's (ruling 82).
function applyTiebreak(state: BoardgameState, p: BoardgameTiebreak): BoardgameState {
  if (state.phase !== "tiebreak") tiebreakRefused(`tie-break not allowed in phase "${state.phase}"`);
  const winnerSide = sideOf(state, p.winner);
  return {
    ...state,
    phase: "done",
    tiebreak: {
      rung: p.rung,
      ...(p.score === undefined ? {} : { score: p.score }),
    },
    outcome: { kind: "win", winner: state.entrants[winnerSide], loser: state.entrants[opponent(winnerSide)], method: `tiebreak_${p.rung}` },
  };
}
```

On the boardgame module literal, beside `bracketDeciders`: `awaitingDecider: (s: BoardgameState) => s.phase === "tiebreak", // C12: lots is the organiser's settle (ruling 73)`.

In `apply`'s switch, add `case "boardgame.tiebreak": return applyTiebreak(state, parsePayload(BoardgameTiebreak, ev.payload, ev.type));`. In `summary`, compute the level display:

```ts
    // W2a: a game that went to the tie-break is level on the board; the
    // tie-break decides who advances and never rewrites the score.
    const level = state.tiebreak !== undefined;
    const decided = outcome !== null || level;
    if (level) { home = draw; away = draw; }
    else if (outcome?.kind === "win") { … unchanged … }
    else if (outcome?.kind === "draw") { … unchanged … }
```

Add `...(state.tiebreak === undefined ? {} : { tiebreak: state.tiebreak }),` to `detail`.

In `padSpec(cfg)`:

```ts
  const tiebreakAction: PadAction = {
    type: BOARDGAME_TIEBREAK_TYPE,
    labelKey: { key: "pad.boardgame.action.tiebreak", label: "Tie-break" },
    fields: [{ kind: "enum", path: "rung", values: TIEBREAK_RUNGS }],
    attribution: [{ kind: "side", path: "winner" }],
  };
  const inPhase = (value: string): PadGate => ({ op: "path-equals", path: "state.phase", value });
  const tb = cfg.tiebreak === true;
  const panels: PadPanel[] = [
    { …pre panel unchanged… },
    { labelKey: …result…, phase: "live", layout: "primary", actions: [decisiveResultAction], ...(tb ? { gate: inPhase("live") } : {}) },
    { labelKey: …draw…, phase: "live", layout: "grid", actions: [drawnResultAction], ...(tb ? { gate: inPhase("live") } : {}) },
    ...(tb ? [{ labelKey: { key: "pad.boardgame.panel.tiebreak", label: "Tie-break" }, phase: "live" as const, layout: "primary" as const, actions: [tiebreakAction], gate: inPhase("tiebreak") }] : []),
  ];
```

Add `"boardgame.tiebreak": 0,` to `fidelity` (band 0: the result family). Import `PadGate` from `../../sport/module.ts`.

The new pad label keys go into all four `ui.json` files under `pad.boardgame`:

| key | en | fr | es | nl |
|---|---|---|---|---|
| `pad.boardgame.action.tiebreak` | Tie-break | Départage | Desempate | Tiebreak |
| `pad.boardgame.panel.tiebreak` | Tie-break | Départage | Desempate | Tiebreak |

- [ ] **Step 5: The carrom bracket case** (add to `carrom.test.ts` beside `:157-170`)

```ts
  it("CA-KO-1: in a bracket the overlay plays the extra board even when the division says tieBoard 'draw'", () => {
    const division = carrom.configSchema.parse({ tieBoard: "draw" });
    const bracket = carrom.configSchema.parse({ ...division, ...carrom.bracketDeciders(division) });
    // Tie the first game after maxBoards with equal boards, then one more board.
    const half = Math.floor((division.gameTo - 1) / Math.ceil(division.maxBoards / 2));
    const coins = Math.min(9, half);
    const boards = Array.from({ length: division.maxBoards }, (_, i) =>
      ({ type: "carrom.board.summary", payload: { winner: i % 2 === 0 ? H : A, opponentCoinsLeft: i === division.maxBoards - 1 && division.maxBoards % 2 === 1 ? 0 : coins, queenTo: null } }));
    const stream = [ev(1, "core.start"), ...boards.map((b, i) => ev(i + 2, b.type, b.payload))];
    const asDivision = foldMatch(carrom, division, lineups, stream);
    const asBracket = foldMatch(carrom, bracket, lineups, stream);
    expect(asDivision.gamesDrawn).toBe(1);   // the division's own rule drew the game
    expect(asBracket.gamesDrawn).toBe(0);    // the bracket did not: the game is still live
    const extra = foldMatch(carrom, bracket, lineups, [...stream, ev(stream.length + 1, "carrom.board.summary", { winner: H, opponentCoinsLeft: 1, queenTo: null })]);
    expect(extra.gamesWon.home).toBe(1);     // the extra board decided it
  });
```

`H`, `A`, `ev` and `lineups` follow the helpers already at the top of `carrom.test.ts`; the executor matches their names.

- [ ] **Step 6: Golden coverage for the new event type** (finding 12)
  - Add `knockoutTiebreak: { tiebreak: true }` to `COVERAGE_CONFIGS.boardgame` in `E/testkit/golden.ts:785`.
  - Run the golden suite with `EXTEND_GOLDEN=1` once, in a commit of its own.
  - Regenerate the schema snapshot.

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a/packages/engine && EXTEND_GOLDEN=1 pnpm vitest run src/testkit/golden.test.ts > "$TMPDIR/w2a-t5-gold.log" 2>&1; echo EXIT=$?; git -C ../.. status --porcelain -- packages/engine/src
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a && pnpm --filter @seazn/engine schema:snapshot; echo EXIT=$?; git status --porcelain packages/engine
```

Expected:
- `EXIT=0`;
- `git status` shows only NEW golden files for `boardgame/knockoutTiebreak`, never a modified existing one, plus `boardgame.schema.json` modified;
- a modified existing golden means a default leaked into cfg: stop and fix the schema.

Then run the golden suite **without** `EXTEND_GOLDEN`: `failed: 0`.

- [ ] **Step 7: Run the scoped engine tests green**

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a/packages/engine && rm -f "$TMPDIR/w2a-t5e.json" && pnpm vitest run src/sport/bracket-deciders.test.ts src/sports/boardgame/tiebreak.test.ts src/sports/boardgame/boardgame.test.ts src/sports/carrom/carrom.test.ts src/testkit/golden.test.ts src/testkit/generator-fields.test.ts --reporter=json --outputFile="$TMPDIR/w2a-t5e.json"; echo EXIT=$?
```

Expected: `EXIT=0`, `files: 6`, `failed: 0`.

If `generator-fields.test.ts` requires `boardgame.arbitraryEvent` to emit the new type with each optional field, extend `arbitraryEvent` so that it sometimes emits `{ type: "boardgame.tiebreak", payload: { rung, winner, score? } }`. The kernel refuses it outside phase `tiebreak`, as fuzz input should be.

- [ ] **Step 8: Mutate each member once, per rung and per guard (runner, then changed-lines Stryker)**

| Mutant | Expected red |
|---|---|
| `decideResult`: `state.cfg.tiebreak === true` → `false` | "with tiebreak, a drawn game opens phase 'tiebreak'" |
| `phase`: `applyTiebreak`: delete the phase check | "a tiebreak outside phase 'tiebreak' is refused, per rung" (one mutant; the test's per-rung message shows rapid, blitz and armageddon each red) |
| `awaitingDecider: (s: BoardgameState) => s.phase === "tiebreak"` → `awaitingDecider: (s: BoardgameState) => false` | "C12: in phase tiebreak lots is the organiser's settle …" |
| method `` `tiebreak_${p.rung}` `` → `"tiebreak_rapid"` | "each rung decides …" for blitz and armageddon |
| `outcome.winner`: `state.entrants[winnerSide]` → `state.entrants[opponent(winnerSide)]` | "BG-KO-2 (ruling 82): the engine records the armageddon winner the scorer taps …" (and "each rung decides …") |
| `summary`: drop `if (level) {…}` | "the summary keeps the level score" |
| boardgame `bracketDeciders` → `{}` | bracket-deciders "BG-KO-1 CA-KO-1 …" |
| carrom `bracketDeciders` → `{}` | "CA-KO-1: the overlay wins …" and the carrom.test CA-KO-1 case |
| Change `tiebreak: z.boolean().optional()` to `.default(false)` | "empty case first: … golden-safe" (`"tiebreak" in league`) and the golden suite |

Each row above becomes one entry of `MUT/t5.json`:
- `find` is the exact source text the row names, copied from this task's code blocks, and `replace` is its mutation;
- `killers` is `[{ "cwd": "packages/engine", "files": [<the test file the row names>], "name": <the test title the row names> }]`.

Then run the runner:

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a && pnpm mutate --list docs/superpowers/specs/2026-09-27-format-matrix-prompts/mutants/w2a/t5.json --json-out "$TMPDIR/w2a-mut-t5.json"; echo EXIT=$?
```

Expected: `EXIT=0`; every row `KILLED by` the named test, 0 survived. Paste the table into the report. The phase-check row is ONE mutant (`phase`; preflight C13): three entries with one mutation would be one guard counted three times. Its killer's per-rung assertion message (`rung`) shows that each rung reddened.


Then run changed-lines Stryker over this task's engine diff (Global Constraints, Mutation):

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a/packages/engine && rm -f reports/mutation/changed.json && M="$(node scripts/stryker-changed.mjs --base "$TASK_BASE")" && STRYKER_MUTATE="$M" pnpm mutation > "$TMPDIR/w2a-stryker-t5.log" 2>&1; echo EXIT=$?; node scripts/stryker-changed.mjs --report reports/mutation/changed.json --expect "$M"; echo REPORT_EXIT=$?
```

Expected: `REPORT_EXIT=0`, with `survived: 0, noCoverage: 0` and a `by <test>` on every killed row. A survivor gets a killing test, or an equivalence row the reviewer signs. The range covers every earlier loop-D task's lines too, so a later task's run re-proves them.

- [ ] **Step 9: Proof bookkeeping, commits**
  - Delete BG-KO-1 and CA-KO-1 from `AWAITING_PROOF`. BG-KO-2 stays there until Task 12, whose pad test proves its W2a enforcement (ruling 82).
  - Set proved-by: BG-KO-1 → `` `packages/engine/src/sports/boardgame/tiebreak.test.ts` ``; CA-KO-1 → `` `packages/engine/src/sport/bracket-deciders.test.ts`<br>`packages/engine/src/sports/carrom/carrom.test.ts` ``.
  - Run `rules-reference.test.ts` green.
  - Make two commits:
    1. `feat(engine): bracketDeciders per sport; chess tie-break phase and boardgame.tiebreak (BG-KO-1, CA-KO-1)`;
    2. `test(engine): golden coverage for boardgame.tiebreak (EXTEND_GOLDEN)`, containing only the new golden files and `golden.ts`.

**Four test types:**
- Unit: Steps 1–7.
- E2E: Task 12's `bracket-finish.spec.ts` "chess tie-break on the pad".
- Smoke: Task 17.
- Regression: the golden corpus, and Task 16 for the SC-O1 boardgame rows.

---

### Task 6: The bracket overlay in `resolveFixtureCfg`, reaching every caller (spec §5.4.1; ruling 76)

**Loop F (Tasks 6–9: one implementer pass, one review). It waits on loop D merged.**

**Files:**
- Modify: `W/server/engine-db/fixture-cfg.ts:39-46` (signature and overlay)
- Modify, at the 11 call sites of finding 14. Each select gains `s.kind`, and each call passes `{ kind, config }` plus the sport module:
  - `W/server/engine-db/fold.ts:152-155` (and `FoldInputs` gains `stageKind: string | null`);
  - `W/server/engine-db/append-event.ts:270`;
  - `W/server/engine-db/competition.ts:325`, `:347`;
  - `W/server/public-site/match-centre-load.ts:427`;
  - `W/server/usecases/fixtures.ts:98-117`;
  - `W/server/usecases/player-stats.ts:439`;
  - `W/server/usecases/event-import.ts:281`;
  - `W/server/usecases/admin-fixture-config.ts:100-104`, `:122`, `:193`;
  - `W/server/usecases/org-posts.ts:777`.
- Create: `W/server/engine-db/__tests__/helpers/seed-bracket.ts`, `W/server/engine-db/__tests__/bracket-overlay-callers.test.ts`
- Modify: `W/server/engine-db/__tests__/fixture-cfg.test.ts` (pure cases)

**Interfaces:**
- Consumes: `forbidsLevelResult` (Task 3); `SportModule.bracketDeciders` (Task 5).
- Produces:
  ```ts
  export interface FixtureStageSource { readonly kind: string | null | undefined; readonly config: Record<string, unknown> | null | undefined }
  export interface DeciderSource { readonly configSchema: { parse(v: unknown): unknown }; bracketDeciders(cfg: never): Record<string, unknown> }
  export function resolveFixtureCfg(snapshot: unknown, divisionCfg: unknown, stage: FixtureStageSource | null | undefined, module: DeciderSource): unknown;
  // fold.ts
  export interface FoldInputs { …; stageKind: string | null }   // Task 7 reads it
  export function seedBracket(opts: { sport: string; variant: string; stageKind: StageKind; entrants: number; divisionConfig?: Record<string, unknown> }): Promise<{ auth: AuthCtx; divisionId: string; stageId: string; fixtureIds: string[] }>;
  export function insertLegacyEvents(fixtureId: string, events: readonly { type: string; payload: unknown }[]): Promise<void>; // raw SQL, config_snapshot left NULL (the pre-V347 shape)
  ```

- [ ] **Step 1: Pure tests first** (add to `fixture-cfg.test.ts`)

```ts
import { boardgame } from "@seazn/engine/sports/boardgame";
import { carrom } from "@seazn/engine/sports/carrom";
import { BRACKET_KINDS, StageKind } from "@seazn/engine/core";

describe("resolveFixtureCfg — the bracket overlay (ruling 76, spec §5.4.1)", () => {
  const league = boardgame.configSchema.parse({});
  it("empty case first: no stage, or a stage with no kind, applies no overlay", () => {
    expect(resolveFixtureCfg(null, league, null, boardgame)).toEqual(league);
    expect(resolveFixtureCfg(null, league, { kind: null, config: null }, boardgame)).toEqual(league);
  });
  it("BG-KO-1: every bracket kind gets the sport's declared overlay; every other kind gets none", () => {
    let checked = 0;
    for (const kind of StageKind.options) {
      const out = resolveFixtureCfg(null, league, { kind, config: null }, boardgame) as Record<string, unknown>;
      expect(out, kind).toEqual(BRACKET_KINDS.has(kind) ? { ...league, ...boardgame.bracketDeciders(league) } : league);
      checked++;
    }
    expect(checked).toBe(StageKind.options.length);
  });
  it("CA-KO-1: the overlay wins over the division and the stage overlay (right answer differs from the division's 'draw')", () => {
    const division = carrom.configSchema.parse({ tieBoard: "draw" });
    expect((resolveFixtureCfg(null, division, { kind: "knockout", config: { rules: { tieBoard: "draw" } } }, carrom) as { tieBoard: string }).tieBoard).toBe("extra");
  });
  it("Review Focus 4: a frozen snapshot without deciders keeps them out — the freeze wins over the overlay", () => {
    const frozen = { ...league };
    expect(resolveFixtureCfg(frozen, league, { kind: "knockout", config: null }, boardgame)).toBe(frozen);
    expect("tiebreak" in (resolveFixtureCfg(frozen, league, { kind: "knockout", config: null }, boardgame) as object)).toBe(false);
  });
  it("a non-object live cfg (a JSON null division config) passes through untouched rather than throwing in parse", () => {
    expect(resolveFixtureCfg(null, null, { kind: "knockout", config: null }, boardgame)).toBeNull();
  });
});
```

- [ ] **Step 2: The shared seed helper** — `W/server/engine-db/__tests__/helpers/seed-bracket.ts`

```ts
// Seeds a real division through the usecases (pad-cfg-resolution.test.ts's own pattern), with ONE stage of the
// asked kind and its generated fixtures. Real Postgres; callers skip without DATABASE_URL.
import { randomUUID } from "node:crypto";
import type { StageKind } from "@seazn/engine/core";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";
import { builtinModules } from "@seazn/engine/sports";

/** Preflight C14: a variant key the sport DECLARES in `module.variants` (an engine declaration), never a guessed
 *  literal — "fide"/"fifa" are not declared keys; boardgame declares classical/rapid/blitz (boardgame.ts:581-583),
 *  football "11-a-side" (football.ts:2449), generic win_loss/score, carrom icf/"club-29", badminton bwf/short. */
export function declaredVariant(sport: string, key: string): string {
  const m = builtinModules.find((x) => x.key === sport);
  if (m === undefined || !Object.hasOwn(m.variants, key)) {
    throw new Error(`seedBracket: ${sport} declares no variant "${key}" (declared: ${m === undefined ? "no such sport" : Object.keys(m.variants).join(", ")})`);
  }
  return key;
}

export async function seedBracket(opts: { sport: string; variant: string; stageKind: StageKind; entrants: number; divisionConfig?: Record<string, unknown> }) {
  declaredVariant(opts.sport, opts.variant);
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`insert into organizations (name, slug) values (${"Bo " + suffix}, ${"bo-" + suffix}) returning id`;
  await setOrgPlan(orgId);
  await invalidateOrgEntitlements(orgId);
  const auth: AuthCtx = { orgId, via: "session", userId: null, role: "owner", keyId: null };
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Bo Cup " + suffix, visibility: "private", branding: {} });
  const division = await createDivision(auth, comp.id, { name: "Open", slug: "open-" + suffix, sport_key: opts.sport, variant_key: opts.variant, config: opts.divisionConfig ?? {} });
  await createEntrants(auth, division.id, Array.from({ length: opts.entrants }, (_, i) => ({ kind: "individual" as const, display_name: `B${i + 1}`, seed: i + 1, members: [] })));
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: opts.stageKind, name: "S1", config: {}, progression: null });
  await generateStageFixtures(auth, stage!.id);
  const rows = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${stage!.id} and home_entrant_id is not null and away_entrant_id is not null order by fixture_no`;
  if (rows.length === 0) throw new Error(`seedBracket: ${opts.stageKind} generated no seated fixture`); // R13
  return { auth, divisionId: division.id, stageId: stage!.id, fixtureIds: rows.map((r) => r.id) };
}

/** Events written by raw SQL with config_snapshot left NULL: the pre-V347 shape, the one shape in which a READ
 *  path resolves LIVE cfg for a fixture with history — so it is where a read caller's overlay is observable. */
export async function insertLegacyEvents(fixtureId: string, events: readonly { type: string; payload: unknown }[]): Promise<void> {
  let seq = 0;
  for (const e of events) {
    seq++;
    await sql`insert into score_events (id, fixture_id, seq, type, payload, recorded_at)
              values (${randomUUID()}, ${fixtureId}, ${seq}, ${e.type}, ${sql.json(e.payload as never)}, now())`;
  }
}
```

The executor confirms that `createStages`' and `generateStageFixtures`' signatures match `pad-cfg-resolution.test.ts:70-90` and `stages.ts` before the first run (class 5). The `score_events` columns are from `append-event.ts:385-390`.

- [ ] **Step 3: The per-caller test** — `W/server/engine-db/__tests__/bracket-overlay-callers.test.ts`

```ts
// Spec §5.4.1 + risk row 1 (the inert seam): the overlay must reach EVERY resolveFixtureCfg call site. Each case
// drives the site's REAL exported entry on real rows and reads what resolveFixtureCfg returned THERE, through a
// spy that wraps the real function. A source scan pins the site count so a 12th caller fails until it has a case.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/engine-db/fixture-cfg", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/engine-db/fixture-cfg")>();
  return { ...real, resolveFixtureCfg: vi.fn(real.resolveFixtureCfg) };
});
import { resolveFixtureCfg } from "@/server/engine-db/fixture-cfg";
import { appendEvent, loadFoldInputs } from "@/server/engine-db";
import { sql, withTenant } from "@/lib/db";
import { recomputeStandings } from "@/server/engine-db/competition";
import { loadFixturePadCfg } from "@/server/usecases/fixtures";
import { computePlayerStats } from "@/server/usecases/player-stats";
import { fixtureConfigPanel, resnapshotFixtureConfig } from "@/server/usecases/admin-fixture-config";
import { insertLegacyEvents, seedBracket } from "./helpers/seed-bracket";

const HAS_DB = !!process.env.DATABASE_URL;
const spy = vi.mocked(resolveFixtureCfg);
afterEach(() => spy.mockClear());

/** Every call the spy saw, as (stage kind passed, cfg returned). */
const seen = () => spy.mock.calls.map((c, i) => ({ kind: (c[2] as { kind?: string } | null | undefined)?.kind ?? null, out: spy.mock.results[i]!.value as Record<string, unknown> | null }));
function expectOverlay(kind: string): void {
  const calls = seen();
  expect(calls.length, "the entry never called resolveFixtureCfg").toBeGreaterThan(0);
  expect(calls.some((c) => c.kind === kind && c.out !== null && c.out.tiebreak === true), JSON.stringify(calls)).toBe(true);
}

const REPO = resolve(__dirname, "../../../../../..");
const CALL = /\bresolveFixtureCfg\(/g;
/** One row per production call site; `case` names the test below that drives it. */
const SITES: readonly { file: string; count: number; case: string }[] = [
  { file: "apps/web/src/server/engine-db/fold.ts", count: 1, case: "fold.ts loadFoldInputs" },
  { file: "apps/web/src/server/engine-db/append-event.ts", count: 1, case: "append-event.ts appendEvent" },
  { file: "apps/web/src/server/engine-db/competition.ts", count: 2, case: "competition.ts recomputeStandings" },
  { file: "apps/web/src/server/public-site/match-centre-load.ts", count: 1, case: "match-centre-load.ts loadMatchCentre" },
  { file: "apps/web/src/server/usecases/fixtures.ts", count: 1, case: "fixtures.ts loadFixturePadCfg" },
  { file: "apps/web/src/server/usecases/player-stats.ts", count: 1, case: "player-stats.ts computePlayerStats" },
  { file: "apps/web/src/server/usecases/event-import.ts", count: 1, case: "event-import.ts importEvents" },
  { file: "apps/web/src/server/usecases/admin-fixture-config.ts", count: 2, case: "admin-fixture-config.ts panel and resnapshot" },
  { file: "apps/web/src/server/usecases/org-posts.ts", count: 1, case: "org-posts.ts draftPostsForDecidedFixture" },
];

describe("bracket overlay reaches every resolveFixtureCfg caller (spec §5.4.1)", () => {
  it("the site ledger is exact: 11 production calls, and none unlisted", () => {
    const files: string[] = [];
    (function walk(d: string) { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) { if (e !== "__tests__") walk(p); } else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) files.push(p); } })(join(REPO, "apps/web/src"));
    const found = new Map<string, number>();
    for (const f of files) {
      const rel = relative(REPO, f);
      if (rel.endsWith("engine-db/fixture-cfg.ts")) continue;
      const n = [...readFileSync(f, "utf8").matchAll(CALL)].length;
      if (n > 0) found.set(rel, n);
    }
    expect(Object.fromEntries(found)).toEqual(Object.fromEntries(SITES.map((s) => [s.file, s.count])));
    expect([...found.values()].reduce((a, b) => a + b, 0)).toBe(11);
  });

  it.skipIf(!HAS_DB)("fold.ts loadFoldInputs", async () => {
    const s = await seedBracket({ sport: "boardgame", variant: "classical", stageKind: "knockout", entrants: 2 });
    await insertLegacyEvents(s.fixtureIds[0]!, [{ type: "core.start", payload: {} }]);
    const inputs = await withTenant(s.auth.orgId, (tx) => loadFoldInputs(tx, s.fixtureIds[0]!));
    expect(inputs!.stageKind).toBe("knockout");
    expectOverlay("knockout");
  });

  it.skipIf(!HAS_DB)("append-event.ts appendEvent: the first event freezes the overlay into config_snapshot", async () => {
    const s = await seedBracket({ sport: "boardgame", variant: "classical", stageKind: "knockout", entrants: 2 });
    await appendEvent(s.auth.orgId, s.fixtureIds[0]!, 0, { type: "core.start", payload: {} });
    expectOverlay("knockout");
    const [row] = await sql<{ config_snapshot: Record<string, unknown> }[]>`select config_snapshot from fixtures where id = ${s.fixtureIds[0]!}`;
    expect(row!.config_snapshot.tiebreak).toBe(true);
  });

  it.skipIf(!HAS_DB)("competition.ts recomputeStandings: a league passes its kind and gets NO overlay (the negative pair)", async () => {
    const s = await seedBracket({ sport: "boardgame", variant: "classical", stageKind: "league", entrants: 2 });
    await appendEvent(s.auth.orgId, s.fixtureIds[0]!, 0, { type: "core.start", payload: {} });
    await appendEvent(s.auth.orgId, s.fixtureIds[0]!, 1, { type: "boardgame.result", payload: { winner: null, method: "agreement" } });
    spy.mockClear();
    await sql`update fixtures set config_snapshot = null where id = ${s.fixtureIds[0]!}`; // legacy shape: live cfg at read
    await recomputeStandings(s.auth.orgId, s.stageId);
    const calls = seen();
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) { expect(c.kind).toBe("league"); expect(c.out?.tiebreak).toBeUndefined(); }
  });

  it.skipIf(!HAS_DB)("fixtures.ts loadFixturePadCfg (feeds the console pad and the device pad)", async () => {
    const s = await seedBracket({ sport: "boardgame", variant: "classical", stageKind: "knockout", entrants: 2 });
    const cfg = (await loadFixturePadCfg(s.auth, s.fixtureIds[0]!)) as { cfg: Record<string, unknown>; stageKind: string | null };
    expect(cfg.cfg.tiebreak).toBe(true); // Task 6 Step 5 changes the return shape to { cfg, stageKind }; Task 12 threads stageKind to the pad
    expect(cfg.stageKind).toBe("knockout");
    expectOverlay("knockout");
  });

  it.skipIf(!HAS_DB)("player-stats.ts computePlayerStats", async () => {
    const s = await seedBracket({ sport: "football", variant: "11-a-side", stageKind: "knockout", entrants: 2 });
    await insertLegacyEvents(s.fixtureIds[0]!, [{ type: "core.start", payload: {} }]);
    await withTenant(s.auth.orgId, (tx) => computePlayerStats(tx, s.divisionId));
    // football declares {} (W2a): the observable is the kind reaching the site, with the declared (empty) overlay.
    const calls = seen();
    expect(calls.some((c) => c.kind === "knockout")).toBe(true);
  });

  it.skipIf(!HAS_DB)("admin-fixture-config.ts panel and resnapshot", async () => {
    const s = await seedBracket({ sport: "boardgame", variant: "classical", stageKind: "knockout", entrants: 2 });
    await fixtureConfigPanel(s.fixtureIds[0]!);
    expectOverlay("knockout");
    spy.mockClear();
    await appendEvent(s.auth.orgId, s.fixtureIds[0]!, 0, { type: "core.start", payload: {} });
    spy.mockClear();
    await resnapshotFixtureConfig(randomActor(), s.fixtureIds[0]!, "W2a overlay check");
    expectOverlay("knockout");
  });
});

function randomActor(): string { return crypto.randomUUID(); }
```

Three more cases go into the existing test file that already builds each entry's inputs. Each case reuses that file's own seeding and auth, seeds a boardgame knockout fixture via `seedBracket`, drives the named entry, and ends with the same assertion block. The spy mock is copied to the top of each file:

```ts
const calls = vi.mocked(resolveFixtureCfg).mock.calls.map((c, i) => ({ kind: (c[2] as { kind?: string } | null)?.kind ?? null, out: vi.mocked(resolveFixtureCfg).mock.results[i]!.value as Record<string, unknown> }));
expect(calls.some((c) => c.kind === "knockout" && c.out?.tiebreak === true), JSON.stringify(calls)).toBe(true);
```

| Site | Test file (existing) | Entry driven |
|---|---|---|
| `match-centre-load.ts:427` | `W/server/public-site/__tests__/match-centre-load-feeder-read.test.ts` | `loadMatchCentre(sql, fixture, ctx)`, built as that file builds it, on a fixture with `insertLegacyEvents` history |
| `event-import.ts:281` | `W/server/usecases/__tests__/event-import-dryrun.test.ts` | `importEvents(auth, divisionId, request)`, with that file's request builder carrying one `core.start` stream for the seeded fixture |
| `org-posts.ts:777` | `W/server/usecases/__tests__/org-posts-enrichment-sources.test.ts` | `draftPostsForDecidedFixture(...)` (it calls `extractScorers` at `:528`) on a decided fixture whose snapshot is nulled |

`SITES[].case` names these three by the same titles, so the ledger test lists every site's case.

- [ ] **Step 4: Run them; see them fail**

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a/apps/web && rm -f "$TMPDIR/w2a-t6.json" && pnpm vitest run src/server/engine-db/__tests__/fixture-cfg.test.ts src/server/engine-db/__tests__/bracket-overlay-callers.test.ts --reporter=json --outputFile="$TMPDIR/w2a-t6.json"; echo EXIT=$?
```

Expected: `EXIT=1`. tsc-level failures show up as `resolveFixtureCfg` called with 4 arguments where it takes 3. The ledger test passes at once, because it pins today's sites. That is correct: it is a guard, and Step 7 mutates it.

- [ ] **Step 5: Implement the overlay** (`fixture-cfg.ts`)

```ts
import { forbidsLevelResult } from "@seazn/engine/core";

export interface FixtureStageSource {
  readonly kind: string | null | undefined;
  readonly config: Record<string, unknown> | null | undefined;
}
/** The two members of a sport module the overlay needs; every SportModule satisfies it. */
export interface DeciderSource {
  readonly configSchema: { parse(v: unknown): unknown };
  bracketDeciders(cfg: never): Record<string, unknown>;
}

/** … (existing doc kept) …
 *  W2a (ruling 76): a fixture in a BRACKET stage kind (`forbidsLevelResult`) also gets the sport's
 *  `bracketDeciders(cfg)` on top of the stage-scoped cfg — chess's tie-break, carrom's extra board. The V347
 *  freeze then carries it from the first event; a frozen snapshot is returned untouched (Review Focus 4: a
 *  fixture scored before deploy keeps its cfg and finishes through needs_decision and settle). */
export function resolveFixtureCfg(
  snapshot: unknown,
  divisionCfg: unknown,
  stage: FixtureStageSource | null | undefined,
  module: DeciderSource,
): unknown {
  if (hasFrozenCfg(snapshot)) return snapshot;
  const scoped = stageScopedCfg(divisionCfg, stage?.config);
  if (!forbidsLevelResult(stage?.kind)) return scoped;
  if (scoped === null || typeof scoped !== "object" || Array.isArray(scoped)) return scoped; // a JSON-null division config stays as it is
  const overlay = module.bracketDeciders(module.configSchema.parse(scoped) as never);
  return Object.keys(overlay).length === 0 ? scoped : { ...(scoped as Record<string, unknown>), ...overlay };
}
```

At each call site, add `s.kind` (or `kind`) to the select that already loads `config`, and pass `{ kind, config }` plus the module the site already resolved. `tsc` names any site you missed. Where a site has no module in scope (`fixtures.ts`, `admin-fixture-config.ts`, `org-posts.ts`, `player-stats.ts`), select `d.sport_key, d.module_version` and call `resolveModule(sport_key, module_version)` from `@/server/engine-db`. That is the same resolver `append-event.ts:200` uses.

`fold.ts`:

```ts
  const [stage] = await tx<{ kind: string; config: Record<string, unknown> | null }[]>`
    select kind, config from stages where id = ${fixture.stage_id}
  `;
  const cfg = resolveFixtureCfg(fixture.config_snapshot, division.config, stage, sportModule);
  return { sportKey: division.sport_key, module: sportModule, cfg, lineups, envelopes, stageKind: stage?.kind ?? null };
```

`fixtures.ts` `loadFixturePadCfg` returns `{ cfg, stageKind }`, and both page callers (`page.tsx:69`/`:181`, `score/[token]/page.tsx:267`/`:331`) read `.cfg` now. Task 12 threads `stageKind` on to the pad.

- [ ] **Step 6: Run green, plus tsc and the suites of the files you touched**

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a/apps/web && rm -f "$TMPDIR/w2a-t6.json" && pnpm vitest run src/server/engine-db/__tests__/fixture-cfg.test.ts src/server/engine-db/__tests__/bracket-overlay-callers.test.ts src/server/engine-db/__tests__/config-snapshot.test.ts src/server/engine-db/__tests__/stage-cfg.test.ts src/server/usecases/__tests__/pad-cfg-resolution.test.ts src/server/usecases/__tests__/admin-fixture-config.test.ts src/server/public-site/__tests__/match-centre-load-feeder-read.test.ts src/server/usecases/__tests__/event-import-dryrun.test.ts src/server/usecases/__tests__/org-posts-enrichment-sources.test.ts src/server/usecases/__tests__/player-stats.test.ts --reporter=json --outputFile="$TMPDIR/w2a-t6.json"; echo EXIT=$?
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a/apps/web && rtk proxy node ../../node_modules/typescript-native/bin/tsc --noEmit -p tsconfig.json; echo EXIT=$?
```

Expected: `EXIT=0` both. `files: 10`, `failed: 0`, and `total` > 0 with no skipped DB cases. Run `jq '[.testResults[].assertionResults[] | select(.status=="skipped")] | length'` and expect 0, which proves `.env.local` is the symlink.

- [ ] **Step 7: Mutate each member once (runner)** — `MUT/t6.json`

| id | find → replace | killer (`cwd: apps/web`) |
|---|---|---|
| `overlay-off` | `if (!forbidsLevelResult(stage?.kind)) return scoped;` → `return scoped;` | `fixture-cfg.test.ts` "BG-KO-1: every bracket kind …" |
| `freeze-loses` | `if (hasFrozenCfg(snapshot)) return snapshot;` → `if (false) return snapshot;` | `fixture-cfg.test.ts` "Review Focus 4 …" |
| `overlay-first` | `{ ...(scoped as Record<string, unknown>), ...overlay }` → `{ ...overlay, ...(scoped as Record<string, unknown>) }` | `fixture-cfg.test.ts` "CA-KO-1 …" |
| `fold-kind-dropped` | in `fold.ts`, `resolveFixtureCfg(fixture.config_snapshot, division.config, stage, sportModule)` → `resolveFixtureCfg(fixture.config_snapshot, division.config, stage && { kind: null, config: stage.config }, sportModule)` | `bracket-overlay-callers.test.ts` "fold.ts loadFoldInputs" |
| `append-kind-dropped` | the same edit at `append-event.ts`'s call | "append-event.ts appendEvent …" |
| `pad-kind-dropped` | the same edit at `fixtures.ts`'s call | "fixtures.ts loadFixturePadCfg …" |
| `admin-kind-dropped` | the same edit at `admin-fixture-config.ts`'s first call | "admin-fixture-config.ts panel and resnapshot" |
| `ledger` | delete the `fold.ts` row from `SITES` | "the site ledger is exact …" |

Each of the three cases in the existing files gets one `<site>-kind-dropped` mutant of its own, killed by its own case. Expected: `EXIT=0`, 11 rows killed.

**Four test types:**
- Unit: Steps 1–6.
- E2E: Task 12's `bracket-finish.spec.ts` "chess tie-break on the pad". The pad only offers the tie-break when the overlay reached `loadFixturePadCfg`.
- Smoke: Task 17's `bracketFinishSuite` (a chess knockout match uses the tie-break).
- Regression: `bracket-overlay-callers.test.ts`, and Task 16's judge on the SC-O1 boardgame rows.

---

### Task 7: `needs_decision` — the migration, the stage-aware status rule, and the counted status-set sweep (X-BR-2; spec §5.4.2, §5.4.6)

**Loop F, continued.**

**Files:**
- Create: `db/migration/deltas/V431__fixture_status_needs_decision.sql`
- Modify: `W/server/engine-db/append-event.ts:117-149` (`nextStatus` and `fixtureStatusFromFold` gain `stageKind`), `:386`
- Modify: `W/server/engine-db/replay.ts:65` (passes `inputs.stageKind`), `W/server/usecases/admin-fixture-config.ts:100-104`, `:319` (selects `s.kind`, passes it)
- Modify: `W/lib/fixture-engine-status.ts` (an explicit `needs_decision` → `"in_play"`)
- Modify: `W/server/api-v1/schemas.ts:1658` (the public status enum), `openapi/v1.json`, `openapi/v1.public.json` (regenerated; finding 8)
- Modify: every status set the sweep classifies as one that must contain `needs_decision` (Step 6)
- Create: `W/lib/fixture-status.ts`, `W/lib/__tests__/status-set-sweep.test.ts`, `W/lib/__tests__/status-set-ledger.ts`, `W/server/engine-db/__tests__/needs-decision-status.test.ts`, `W/server/__tests__/v431-needs-decision-migration.test.ts`
- Modify: `W/server/public-site/competition-hub.ts:152-158` (`STATUS_LINE_KEYS` gains `needs_decision`), its schema test `competition-hub-schema.test.ts`, and `W/dictionaries/{en,fr,es,nl}/public.json` (`matchCentre.status.needs_decision`) — moved here from Task 13 (preflight C16)

**Interfaces:**
- Consumes: `forbidsLevelResult`, `isLevelOutcome` (Task 3); `FoldInputs.stageKind` (Task 6); `outcomeOf` (Task 4).
- Produces:
  ```ts
  // W/lib/fixture-status.ts (client-safe: no server-only)
  export const FIXTURE_STATUSES: readonly ["scheduled","in_play","decided","finalized","abandoned","forfeited","cancelled","needs_decision"];
  export type FixtureStatusValue = (typeof FIXTURE_STATUSES)[number];
  // append-event.ts
  export function fixtureStatusFromFold(outcome: MatchOutcome | null, active: readonly EventEnvelope[], stageKind: string | null): string;
  export function nextStatus(candidateType: string, outcome: MatchOutcome | null, active: readonly EventEnvelope[], stageKind: string | null): string;
  ```

- [ ] **Step 0: Finding 7 is recorded as ruling 82: backfill.** The owner approved it on 2026-10-08. The V431 `update` (Step 3), its migration test case (Step 4), and applying it (Step 7) are unconditional. Nothing to ask; build to it.

- [ ] **Step 1: The status rule's failing tests** — `W/server/engine-db/__tests__/needs-decision-status.test.ts` (pure, no DB)

```ts
import { describe, expect, it } from "vitest";
import { BRACKET_KINDS, StageKind, type EventEnvelope, type MatchOutcome } from "@seazn/engine/core";
import { fixtureStatusFromFold, nextStatus } from "../append-event";

const ev = (type: string, i = 1): EventEnvelope => ({ id: `e-${i}`, seq: i, type, payload: {}, recordedAt: "2026-10-08T00:00:00Z", recordedBy: null }) as EventEnvelope;
const LEVEL: readonly MatchOutcome[] = [{ kind: "draw" }, { kind: "tie" }, { kind: "no_result" }];
const WIN: MatchOutcome = { kind: "win", winner: "H", loser: "A" };

describe("X-BR-2: the status rule (spec §5.4.2, D3)", () => {
  it("empty case first: no events and no outcome is scheduled, in any stage kind or none", () => {
    let checked = 0;
    for (const k of [...StageKind.options, null]) { expect(fixtureStatusFromFold(null, [], k)).toBe("scheduled"); checked++; }
    expect(checked).toBe(StageKind.options.length + 1);
  });
  it("X-BR-2: every level outcome kind in every bracket kind is needs_decision; outside brackets it is decided", () => {
    let checked = 0;
    for (const outcome of LEVEL) for (const k of StageKind.options) {
      expect(fixtureStatusFromFold(outcome, [ev("core.start")], k), `${outcome.kind} ${k}`).toBe(BRACKET_KINDS.has(k) ? "needs_decision" : "decided");
      checked++;
    }
    expect(checked).toBe(LEVEL.length * StageKind.options.length);
  });
  it("a win in a bracket is decided (right answer differs from needs_decision's constant)", () => {
    expect(fixtureStatusFromFold(WIN, [ev("core.start")], "knockout")).toBe("decided");
  });
  it("D3 order 1: an active settle is decided even over an active abandon", () => {
    expect(fixtureStatusFromFold(WIN, [ev("core.start", 1), ev("core.abandon", 2), ev("core.settle", 3)], "knockout")).toBe("decided");
  });
  it("D3 order 2: an active abandon stays abandoned, even with a level outcome in a bracket (stuck and visible)", () => {
    let checked = 0;
    for (const outcome of [...LEVEL, null]) { expect(fixtureStatusFromFold(outcome, [ev("core.start", 1), ev("core.abandon", 2)], "knockout")).toBe("abandoned"); checked++; }
    expect(checked).toBe(4);
  });
  it("finalize still wins in nextStatus; a void of the settle (settle absent from active) returns to needs_decision", () => {
    expect(nextStatus("core.finalize", WIN, [ev("core.settle")], "knockout")).toBe("finalized");
    expect(nextStatus("core.void", { kind: "draw" }, [ev("core.start")], "knockout")).toBe("needs_decision");
  });
  it("a null stage kind (a fixture outside any stage) behaves as today", () => {
    expect(fixtureStatusFromFold({ kind: "draw" }, [ev("core.start")], null)).toBe("decided");
  });
});
```

- [ ] **Step 2: Implement the rule** (`append-event.ts`)

```ts
export function nextStatus(candidateType: string, outcome: MatchOutcome | null, active: readonly EventEnvelope[], stageKind: string | null): string {
  if (candidateType === "core.finalize") return "finalized";
  return fixtureStatusFromFold(outcome, active, stageKind);
}

export function fixtureStatusFromFold(outcome: MatchOutcome | null, active: readonly EventEnvelope[], stageKind: string | null): string {
  const has = (type: string) => active.some((event) => event.type === type);
  // W2a D3 (spec §5.4.2), in this order. 1: the organiser's settle decides, even an abandoned match (X-ST-1).
  if (has("core.settle")) return "decided";
  // 2: abandon first otherwise (unchanged): cricket abandon folds to no_result but stays "abandoned" — the
  // 2026-09-21 "stuck and visible" ruling for an abandon nobody has settled.
  if (has("core.abandon")) return "abandoned";
  // 3: a level result in a bracket is HELD (ruling 79, X-BR-2): not decided, nobody seated.
  if (outcome !== null && forbidsLevelResult(stageKind) && isLevelOutcome(outcome)) return "needs_decision";
  if (outcome !== null) return has("core.forfeit") ? "forfeited" : "decided";
  return has("core.start") ? "in_play" : "scheduled";
}
```

Then:
- `append-event.ts:386`: `nextStatus(candidate.type, outcome, active, stage?.kind ?? null)`.
- `replay.ts:65`: `nextStatus(row.type, folded.outcome, folded.active, inputs.stageKind)`.
- `admin-fixture-config.ts:319`: `fixtureStatusFromFold(folded.outcome, folded.active, row.stage_kind)`, after selecting `s.kind as stage_kind` at `:102`.

- [ ] **Step 3: The migration** — `db/migration/deltas/V431__fixture_status_needs_decision.sql`

```sql
-- W2a (spec §5.4.6; rulings 79, 72). A play-produced level result in a bracket stage is HELD as
-- `needs_decision`: not decided, nobody seated, closed by the organiser's core.settle.
-- The V214 inline check is named fixtures_status_check by Postgres (confirmed against the w2a DB:
-- select conname from pg_constraint where conrelid = 'fixtures'::regclass and contype = 'c'
--   and pg_get_constraintdef(oid) like '%status%').
alter table fixtures drop constraint fixtures_status_check;
alter table fixtures add constraint fixtures_status_check check (status in
  ('scheduled','in_play','decided','finalized','abandoned','forfeited','cancelled','needs_decision'));

-- V430's fixtures_track_finished needs no change: needs_decision is NOT in its finished set, so the trigger
-- writes finished_at = null for it — the match is played but not finished (status-set ledger: "not finished").

-- Finding 7, ruling 82 (owner, 2026-10-08): legacy bracket rows stored decided/finalized
-- with a level outcome move to needs_decision, so the organiser sees the block instead of an exception page.
-- The update names `status`, so fixtures_track_finished fires and clears finished_at for them.
update fixtures f set status = 'needs_decision'
  from stages s
 where s.id = f.stage_id
   and s.kind in ('knockout','double_elim','stepladder','page_playoff','ladder')
   and f.status in ('decided','finalized')
   and f.outcome->>'kind' in ('draw','tie','no_result');
```

The kind list is checked against the engine by the Step 4 test, so the SQL literal cannot drift from `BRACKET_KINDS` unseen.

- [ ] **Step 4: The migration test** — `W/server/__tests__/v431-needs-decision-migration.test.ts` (real Postgres, in the style of `court-entities-migration.test.ts`)

```ts
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BRACKET_KINDS } from "@seazn/engine/core";
import { sql } from "@/lib/db";
import { FIXTURE_STATUSES } from "@/lib/fixture-status";
import { seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";

const HAS_DB = !!process.env.DATABASE_URL;
const FILE = resolve(__dirname, "../../../../../db/migration/deltas/V431__fixture_status_needs_decision.sql");
const text = readFileSync(FILE, "utf8");

describe("V431 needs_decision", () => {
  it("the SQL bracket-kind literal is exactly the engine's BRACKET_KINDS", () => {
    const m = /s\.kind in \(([^)]*)\)/.exec(text);
    expect(m).not.toBeNull();
    expect(new Set(m![1]!.split(",").map((s) => s.trim().replace(/'/g, "")))).toEqual(new Set(BRACKET_KINDS));
  });
  it("the check constraint's status list is exactly FIXTURE_STATUSES", () => {
    const m = /status in\s*\(([^)]*)\)\);/.exec(text);
    expect(new Set(m![1]!.replace(/\s/g, "").split(",").map((s) => s.replace(/'/g, "")))).toEqual(new Set(FIXTURE_STATUSES));
  });
  it.skipIf(!HAS_DB)("the live DB accepts needs_decision, refuses an unknown status, and clears finished_at for it", async () => {
    const s = await seedBracket({ sport: "boardgame", variant: "classical", stageKind: "knockout", entrants: 2 });
    const id = s.fixtureIds[0]!;
    await sql`update fixtures set status = 'decided' where id = ${id}`;
    await sql`update fixtures set status = 'needs_decision' where id = ${id}`;
    const [row] = await sql<{ status: string; finished_at: Date | null }[]>`select status, finished_at from fixtures where id = ${id}`;
    expect(row).toEqual({ status: "needs_decision", finished_at: null });
    await expect(sql`update fixtures set status = 'needs_decisions' where id = ${id}`).rejects.toThrow(/fixtures_status_check/);
  });
  it.skipIf(!HAS_DB)("ruling 82 backfill: V431's update moves a decided level KNOCKOUT row to needs_decision and leaves a level LEAGUE row decided", async () => {
    // Preflight C15. Runs the migration's OWN update statement (read from the file, never retyped), inside a
    // transaction that is rolled back, so the shared test DB keeps every other row as it was.
    const update = /update fixtures f set status = 'needs_decision'[\s\S]*?;/.exec(text)?.[0];
    expect(update, "V431 holds the backfill update").toBeDefined();
    const ko = await seedBracket({ sport: "boardgame", variant: "classical", stageKind: "knockout", entrants: 2 });
    const lg = await seedBracket({ sport: "boardgame", variant: "classical", stageKind: "league", entrants: 2 });
    const koId = ko.fixtureIds[0]!;
    const lgId = lg.fixtureIds[0]!;
    const ROLLBACK = new Error("rollback");
    let seen: { id: string; status: string }[] = [];
    await expect(sql.begin(async (tx) => {
      await tx`update fixtures set status = 'decided', outcome = '{"kind":"draw"}'::jsonb where id in (${koId}, ${lgId})`;
      await tx.unsafe(update!);
      seen = await tx<{ id: string; status: string }[]>`select id, status from fixtures where id in (${koId}, ${lgId})`;
      throw ROLLBACK;
    })).rejects.toBe(ROLLBACK);
    const byId = new Map(seen.map((r) => [r.id, r.status]));
    expect(byId.size).toBe(2); // both rows were read inside the transaction
    expect(byId.get(koId)).toBe("needs_decision");
    expect(byId.get(lgId)).toBe("decided"); // the negative pair: a league draw is a result, never held
  });
});
```

`FIXTURE_STATUSES` lives in `W/lib/fixture-status.ts`:

```ts
// Every value of fixtures.status (V214 + V431). Client-safe. The status-set sweep classifies every OTHER list of
// these literals against this one, and V431's migration test holds the check constraint to it.
export const FIXTURE_STATUSES = ["scheduled", "in_play", "decided", "finalized", "abandoned", "forfeited", "cancelled", "needs_decision"] as const;
export type FixtureStatusValue = (typeof FIXTURE_STATUSES)[number];
```

`engineFixtureStatus` gains `case "needs_decision": return "in_play";`, with the comment `// W2a: played, not finished, nobody seated (finding 18)`. Its `default` becomes an exhaustive throw over `FixtureStatusValue`, so a ninth status cannot fall to "scheduled" silently:

```ts
    case "scheduled":
      return "scheduled";
    default:
      throw new Error(`engineFixtureStatus: unknown fixtures.status "${dbStatus}"`);
```

`W/server/api-v1/schemas.ts:1658`: the public status enum becomes `z.enum(FIXTURE_STATUSES)`. Then:

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a && pnpm openapi:gen && git status --porcelain openapi; echo EXIT=$?
```

Expected: `openapi/v1.json` and `openapi/v1.public.json` modified, with `needs_decision` added to the status enum and nothing else (finding 8). Commit both.

- [ ] **Step 5: The counted status-set sweep** — `W/lib/__tests__/status-set-sweep.test.ts` and its ledger

```ts
// Spec §5.4.6 (risk row 2): every list of fixtures.status literals, in TS and SQL, is FOUND by scanning and
// CLASSIFIED in the ledger. Unclassified = failure; a ledger row no longer found = failure; zero found = failure.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURE_STATUSES } from "@/lib/fixture-status";
import { STATUS_SET_LEDGER, type StatusSetClass } from "./status-set-ledger";

const REPO = resolve(__dirname, "../../../../..");
const ROOTS = ["apps/web/src", "packages/engine/src", "db/migration", "tools/matrix/lib", "scripts"];
const LIT = new RegExp(`['"](${FIXTURE_STATUSES.join("|")})['"]`, "g");

/** A "set" is a bracketed or parenthesised span holding ≥ 2 distinct fixture-status literals. Its anchor is the
 *  file plus the sorted literals plus the 40 characters before the span (a const name, a SQL clause). */
function findSets(text: string): { anchor: string; members: Set<string> }[] {
  const out: { anchor: string; members: Set<string> }[] = [];
  const span = /[[(]([^[\]()]*)[\])]/g;
  for (const m of text.matchAll(span)) {
    const members = new Set([...m[1]!.matchAll(LIT)].map((x) => x[1]!));
    if (members.size < 2) continue;
    const before = text.slice(Math.max(0, m.index! - 40), m.index!).replace(/\s+/g, " ").trim();
    out.push({ anchor: `${before.slice(-30)} :: ${[...members].sort().join(",")}`, members });
  }
  return out;
}

/** Preflight C19: two set shapes a bracket span misses. (1) A comparison chain on one line —
 *  `return s === "decided" || s === "finalized";` — whose literals follow `===`/`!==`. (2) A status-keyed map —
 *  `{ scheduled: …, in_play: … }` or `Record<FixtureStatus, …>` — whose KEYS are statuses. Same anchor shape. */
function findChains(text: string): { anchor: string; members: Set<string> }[] {
  const out: { anchor: string; members: Set<string> }[] = [];
  const cmp = new RegExp(`[!=]==?\\s*['"](${FIXTURE_STATUSES.join("|")})['"]`, "g");
  let offset = 0;
  for (const line of text.split("\n")) {
    const hits = [...line.matchAll(cmp)];
    const members = new Set(hits.map((x) => x[1]!));
    if (members.size >= 2) {
      const at = offset + hits[0]!.index!;
      const before = text.slice(Math.max(0, at - 40), at).replace(/\s+/g, " ").trim();
      out.push({ anchor: `chain ${before.slice(-30)} :: ${[...members].sort().join(",")}`, members });
    }
    offset += line.length + 1;
  }
  return out;
}
function findMaps(text: string): { anchor: string; members: Set<string> }[] {
  const out: { anchor: string; members: Set<string> }[] = [];
  const key = new RegExp(`(?:^|[{,\\s])['"]?(${FIXTURE_STATUSES.join("|")})['"]?\\s*:`, "g");
  for (const m of text.matchAll(/\{([^{}]*)\}/g)) {
    const members = new Set([...m[1]!.matchAll(key)].map((x) => x[1]!));
    if (members.size < 2) continue;
    const before = text.slice(Math.max(0, m.index! - 40), m.index!).replace(/\s+/g, " ").trim();
    out.push({ anchor: `map ${before.slice(-30)} :: ${[...members].sort().join(",")}`, members });
  }
  return out;
}

function walk(dir: string, out: string[]): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (e !== "node_modules" && e !== "__tests__" && e !== ".next") walk(p, out); }
    else if (/\.(ts|tsx|sql|mjs)$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}

describe("spec §5.4.6: every fixture-status set is found, classified, and agrees with its class", () => {
  const found = ROOTS.flatMap((r) => walk(join(REPO, r), [])).flatMap((f) => {
    const text = readFileSync(f, "utf8");
    return [...findSets(text), ...findChains(text), ...findMaps(text)].map((s) => ({ ...s, file: relative(REPO, f) }));
  });

  it("empty case first: a text with no status literal yields no set, in any of the three shapes", () => {
    expect(findSets("const x = ['a', 'b'];")).toEqual([]);
    expect(findChains('return s === "a" || s === "b";')).toEqual([]);
    expect(findMaps("const m = { a: 1, b: 2 };")).toEqual([]);
  });
  it("C19: the chain and map shapes are found (the positive pairs)", () => {
    expect(findChains('return s === "decided" || s === "finalized";').map((x) => [...x.members].sort())).toEqual([["decided", "finalized"]]);
    expect(findMaps("const TONE: Record<Status, string> = { scheduled: 'x', in_play: 'y' };").map((x) => [...x.members].sort())).toEqual([["in_play", "scheduled"]]);
  });
  it("found at least one set, and every found set is in the ledger", () => {
    expect(found.length).toBeGreaterThan(0);
    const keys = new Set(STATUS_SET_LEDGER.map((r) => `${r.file} ## ${r.anchor}`));
    expect(found.filter((s) => !keys.has(`${s.file} ## ${s.anchor}`)).map((s) => `${s.file} ## ${s.anchor}`)).toEqual([]);
  });
  it("every ledger row is still found (a stale row is a failure)", () => {
    const keys = new Set(found.map((s) => `${s.file} ## ${s.anchor}`));
    expect(STATUS_SET_LEDGER.filter((r) => !keys.has(`${r.file} ## ${r.anchor}`)).map((r) => `${r.file} ## ${r.anchor}`)).toEqual([]);
  });
  it("each set holds needs_decision exactly when its class says it must", () => {
    let checked = 0;
    const want: Record<StatusSetClass, boolean | null> = { played: false, "not-finished": true, "needs-attention": true, "historical-sql": null, "status-domain": true, "not-a-set": null };
    for (const s of found) {
      const row = STATUS_SET_LEDGER.find((r) => r.file === s.file && r.anchor === s.anchor)!;
      const must = want[row.class];
      if (must === null) continue;
      expect(s.members.has("needs_decision"), `${s.file} ## ${s.anchor} (${row.class}: ${row.why})`).toBe(must);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });
});
```

`W/lib/__tests__/status-set-ledger.ts`:

```ts
/** The classification (spec §5.4.6: played, not finished, needs attention), plus three bookkeeping classes:
 *  - played: the match produced a result that counts (finished set; standings; "has results"). needs_decision is OUT.
 *  - not-finished: the match is live or awaiting something (in-play, open, pending). needs_decision is IN.
 *  - needs-attention: the desk's attention/phase sets that ask an organiser to act. needs_decision is IN.
 *  - status-domain: a full list of every value (check constraint, enums). needs_decision is IN.
 *  - historical-sql: an applied migration superseded by a later delta (V431 or an earlier one); `why` names it.
 *  - not-a-set: a span the scanner matched that is not a status set (a sentence, a test of other strings); `why` says.
 *  An "IN" set without needs_decision, or an "OUT" set with it, fails. */
export type StatusSetClass = "played" | "not-finished" | "needs-attention" | "status-domain" | "historical-sql" | "not-a-set";
export interface StatusSetRow { file: string; anchor: string; class: StatusSetClass; why: string }

export const STATUS_SET_LEDGER: readonly StatusSetRow[] = [
  // Seeded rows, from the plan's reading at c0416dea6; the first run prints every other found set, and each is
  // classified here BY READING its use site (never by its name alone, class 5).
  { file: "db/migration/v2-engine/tables/V214__fixtures.sql", anchor: "<printed by the first run>", class: "historical-sql", why: "superseded by V431's fixtures_status_check" },
  { file: "db/migration/deltas/V431__fixture_status_needs_decision.sql", anchor: "<printed by the first run>", class: "status-domain", why: "the check constraint" },
  { file: "db/migration/deltas/V430__capture_stream_codes.sql", anchor: "<printed by the first run>", class: "played", why: "fixtures_track_finished's finished set: needs_decision is played-not-finished, finished_at null" },
  { file: "apps/web/src/server/engine-db/append-event.ts", anchor: "<printed by the first run>", class: "played", why: "LOCKED_FIXTURE_STATUSES: needs_decision must accept settle and void" },
  { file: "apps/web/src/lib/table-withdrawal.ts", anchor: "<printed by the first run>", class: "played", why: "WITHDRAWAL_PLAYED_STATUSES: needs_decision is OUT — table stages never hold it, and the bracket cascade maps a held row to 'void', which withdrawBracketEntrant skips (ruling C17; Step 6)" },
];
```

The `<printed by the first run>` anchors are the one deliberately data-driven part. The scanner prints each found set's exact anchor on the first run, and the executor pastes it. Each row's class is decided by reading the use site, using the class definitions above.

- [ ] **Step 6: Run the sweep; classify every set; fix every set its class says must change**

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a/apps/web && rm -f "$TMPDIR/w2a-t7.json" && pnpm vitest run src/lib/__tests__/status-set-sweep.test.ts --reporter=json --outputFile="$TMPDIR/w2a-t7.json"; echo EXIT=$?; jq -r '.testResults[].assertionResults[] | select(.status=="failed") | .failureMessages[]' "$TMPDIR/w2a-t7.json" | head -80
```

Classify each printed set into the ledger. Then edit the product sets the "IN/OUT" rule says are wrong:
- `not-finished` and `needs-attention` sets gain `needs_decision`;
- `played` sets must not contain it.

Known decisions, made from the spec's own words:
- **Run-sheet attention** (`stages-panel.tsx` / `run-sheet-groups.ts`): `needs-attention`. The desk shows the fixture as waiting on the organiser.
- **`STATUS_LINE_KEYS`** (`competition-hub.ts:152`): `status-domain`. Task 7 adds `"needs_decision"` to it HERE, with its line `matchCentre.status.needs_decision` in all four `public.json` files: en "Needs a decision", fr "Décision requise", es "Requiere una decisión", nl "Beslissing nodig" (the same values as Task 11's `score.status.needs_decision`). Run `pnpm i18n:gen-keys && pnpm i18n:check` after. Moving it here (preflight C16) keeps this task's sweep green without an "owed by Task 13" row; Task 13 no longer touches `STATUS_LINE_KEYS`.
- **`WITHDRAWAL_PLAYED_STATUSES`** (`table-withdrawal.ts:16`): `played`, WITHOUT `needs_decision` (controller ruling C17; the earlier "plus needs_decision, void and abandon" rationale was false). Its `why`: in a table stage `needs_decision` never occurs (it exists only in bracket kinds); in a bracket, `withdrawEntrantCascade` maps a row in neither this set nor `WITHDRAWAL_PENDING_STATUSES` to `"void"` (`withdrawal.ts:195`), and the engine's `withdrawBracketEntrant` skips every `SETTLED` row (`competition/stage.ts:18`, `:459`). So a withdrawal leaves a held fixture `needs_decision`, untouched. The organiser then settles for the remaining entrant; a settle naming the withdrawn one is refused (Task 8). Auto-walkover of a held fixture is W2b's (spec §2.3).

Re-run until green. Expected: `EXIT=0`. Record the counts by class (and by shape: span, chain, map) in the task report.

**Later loops re-run this sweep (preflight C19).** Its roots include `tools/matrix/lib` (lane P1) and `scripts` (Task 17's `smoke.ts`), which change after loop F. So:
- lane P1 runs `status-set-sweep.test.ts` in its Step 8 (loop H, and so this loop F, is merged into the lane by then). It may not edit the ledger (not its file set): it lists every unclassified set it introduced, with file, anchor and use site, in its report;
- Task 17 (main worktree, after every merge) re-runs it, adds each reported row with a `why` read at its use site, and a stale row fails as before. A red sweep blocks the PR.

- [ ] **Step 7: Apply the delta to the w2a DB and run the scoped suites**

```bash
S=~/.claude/skills/seazn-local-env/scripts/seazn-env.sh; cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a && eval "$($S env --label w2a)" && pnpm db:apply > "$TMPDIR/w2a-t7-db.log" 2>&1; echo EXIT=$?; psql "$DATABASE_URL" -Atc "select pg_get_constraintdef(oid) from pg_constraint where conname = 'fixtures_status_check'"
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a/apps/web && rm -f "$TMPDIR/w2a-t7.json" && pnpm vitest run src/server/engine-db/__tests__/needs-decision-status.test.ts src/server/__tests__/v431-needs-decision-migration.test.ts src/lib/__tests__/status-set-sweep.test.ts src/server/engine-db/__tests__/replay.test.ts src/server/engine-db/__tests__/undo-status.test.ts src/server/engine-db/__tests__/append-event.test.ts src/server/usecases/__tests__/admin-fixture-config.test.ts --reporter=json --outputFile="$TMPDIR/w2a-t7.json"; echo EXIT=$?
```

Expected:
- `db:apply` `EXIT=0`, and the constraint text lists `needs_decision`;
- the vitest `EXIT=0`, `files: 7`, `failed: 0`;
- the `show data_directory` check from Global Constraints still prints w2a's own.

- [ ] **Step 8: Mutate each member once (runner)** — `MUT/t7.json`, per outcome kind and stage kind

| id | find → replace | killer |
|---|---|---|
| `settle-first` | `if (has("core.settle")) return "decided";` → `` (deleted) | "D3 order 1 …" |
| `abandon-before-level` | swap the abandon line below the level line (the find is the two lines in order, the replace is them swapped) | "D3 order 2 …" |
| `level-draw` | `isLevelOutcome(outcome)` → `outcome.kind === "tie" \|\| outcome.kind === "no_result"` | "X-BR-2: every level outcome kind …" (`draw` rows) |
| `level-tie` | `isLevelOutcome(outcome)` → `outcome.kind === "draw" \|\| outcome.kind === "no_result"` | the same test (`tie` rows) |
| `level-nr` | `isLevelOutcome(outcome)` → `outcome.kind === "draw" \|\| outcome.kind === "tie"` | the same test (`no_result` rows) |
| `kind-ignored` | `forbidsLevelResult(stageKind) && ` → `` | "X-BR-2 …" (league rows) and "a null stage kind …" |
| `replay-kind` | `nextStatus(row.type, folded.outcome, folded.active, inputs.stageKind)` → `nextStatus(row.type, folded.outcome, folded.active, null)` | `replay.test.ts` (add the case "replay of a held knockout fixture reports needs_decision", built with `seedBracket` and two `appendEvent` calls) |
| `engine-status` | `case "needs_decision": return "in_play";` → `` (deleted) | `fixture-engine-status` test (add "needs_decision maps to in_play, and an unknown status throws") |
| `sweep-stale` | in `findSets`, `matchAll(LIT)].map((x) => x[1]!));\n    if (members.size < 2) continue;` → the same with `members.size < 3` (a two-line find: `members.size < 2` alone also occurs in `findMaps`, so it is not unique) | "every ledger row is still found" |
| `backfill-kind` | in V431, `and s.kind in ('knockout','double_elim','stepladder','page_playoff','ladder')` → `and s.kind in ('knockout','double_elim','stepladder','page_playoff','ladder','league')` | "ruling 82 backfill: … leaves a level LEAGUE row decided" (and the SQL-literal test) |
| `backfill-level` | in V431, `and f.outcome->>'kind' in ('draw','tie','no_result')` → `and f.outcome->>'kind' in ('tie','no_result')` | "ruling 82 backfill: V431's update moves a decided level KNOCKOUT row …" (its row is a draw) |
| `sweep-class` | in `want`, `"not-finished": true` → `"not-finished": false` | "each set holds needs_decision exactly when …" |
| `sweep-chains` | `if (members.size >= 2) {` (in `findChains`) → `if (members.size >= 3) {` | "C19: the chain and map shapes are found …" |
| `sweep-maps` | `const members = new Set([...m[1]!.matchAll(key)]` → `const members = new Set([...m[1]!.matchAll(LIT)]` | "C19: the chain and map shapes are found …" (unquoted keys are missed) |
| `status-line` | `"needs_decision",` (in `STATUS_LINE_KEYS`) → `` | `competition-hub-schema.test.ts` (add the case "a held fixture's status line is 'Needs a decision'"); moved here from Task 13 (preflight C16) |

Expected: `EXIT=0`, 15 rows killed (the 10 first listed, plus `backfill-kind`, `backfill-level`, `status-line`, `sweep-chains` and `sweep-maps`).

**Four test types:**
- Unit and DB: Steps 1–7.
- E2E: Task 11's `bracket-finish.spec.ts` "a level football knockout goes to needs_decision and the console shows the block".
- Smoke: Task 17.
- Regression: the sweep (CI on every PR), the migration test, and Task 16's judge.

---

### Task 8: The write guard, the seating assertion, `onDecided` held back, settle seating both sides (X-BR-1, GN-KO-1, CK-KO-1)

**Loop F, continued.**

**Files:**
- Modify: `W/server/engine-db/append-event.ts:330-346` (the write guard), `:395-406` (`firstResult`)
- Create: `W/server/engine-db/level-seat.ts`
- Modify: `W/server/usecases/scoring.ts:294` (the `onDecided` gate), `:701-730` (select `f.status`; assert)
- Modify: `W/server/engine-db/competition.ts:144-195` (the false comment becomes the assertion; `toBracketFixture` gains `stageKind`)
- Modify: `W/server/usecases/stages.ts:4080-4092` (the completed-bracket rebuild asserts)
- Modify: `W/server/engine-db/__tests__/draw-guard.test.ts` (rewritten from X-BR-1/X-BR-2, Step 1)
- Create: `W/server/engine-db/__tests__/settle-seating.test.ts`

**Interfaces:**
- Consumes: `outcomeOf`, `SETTLE_METHODS`, `LEVEL_RESULT_IN_BRACKET`, `LEVEL_RESULT_SEATED` (Task 4); `fixtureStatusFromFold` (Task 7); `seedBracket` (Task 6).
- Produces:
  ```ts
  // W/server/engine-db/level-seat.ts
  export const SEATING_STATUSES: ReadonlySet<string>; // decided, forfeited, finalized
  export function assertNoLevelSeat(f: { fixtureId: string; stageKind: string | null; status: string; outcome: unknown }): void; // throws LEVEL_RESULT_SEATED
  ```

- [ ] **Step 1: The failing DB tests** — `W/server/engine-db/__tests__/settle-seating.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { SETTLE_METHODS } from "@seazn/engine/core";
import { sql } from "@/lib/db";
import { appendEvent } from "@/server/engine-db";
import { scoreEvent } from "@/server/usecases/scoring";
import { withdrawEntrantCascade } from "@/server/usecases/withdrawal";
import { assertNoLevelSeat } from "../level-seat";
import { seedBracket } from "./helpers/seed-bracket";

const HAS_DB = !!process.env.DATABASE_URL;
type Row = { status: string; outcome: { kind: string; winner?: string; loser?: string; method?: string } | null; home_entrant_id: string | null; away_entrant_id: string | null; winner_to_fixture: string | null; loser_to_fixture: string | null };
const row = async (id: string) => (await sql<Row[]>`select status, outcome, home_entrant_id, away_entrant_id, winner_to_fixture, loser_to_fixture from fixtures where id = ${id}`)[0]!;
const seq = async (id: string) => (await sql<{ s: number }[]>`select coalesce(max(seq),0)::int as s from score_events where fixture_id = ${id}`)[0]!.s;
const post = async (auth: Parameters<typeof scoreEvent>[0], id: string, type: string, payload: unknown = {}) =>
  scoreEvent(auth, id, { expected_seq: await seq(id), type, payload } as never);
const seated = async (fixtureId: string) => { const r = await row(fixtureId); return [r.home_entrant_id, r.away_entrant_id].filter((x) => x !== null); };

/** A 4-draw knockout: two seated semis feeding an empty final (and, for double_elim, a losers line). */
async function semi(sport: string, variant: string, stageKind: "knockout" | "double_elim" = "knockout") {
  const s = await seedBracket({ sport, variant, stageKind, entrants: 4 });
  const sf = s.fixtureIds[0]!;
  const r = await row(sf);
  return { ...s, sf, final: r.winner_to_fixture!, home: r.home_entrant_id!, away: r.away_entrant_id! };
}

describe("X-BR-1 / X-BR-2: held, never seated; settle seats both", () => {
  it("empty case first: assertNoLevelSeat is silent on no outcome, on a win, and outside brackets", () => {
    expect(() => assertNoLevelSeat({ fixtureId: "f", stageKind: "knockout", status: "scheduled", outcome: null })).not.toThrow();
    expect(() => assertNoLevelSeat({ fixtureId: "f", stageKind: "knockout", status: "decided", outcome: { kind: "win", winner: "a", loser: "b" } })).not.toThrow();
    expect(() => assertNoLevelSeat({ fixtureId: "f", stageKind: "league", status: "decided", outcome: { kind: "draw" } })).not.toThrow();
  });
  it("X-BR-1: the forced bug shape (a level outcome stored decided in a bracket) throws LEVEL_RESULT_SEATED, per level kind and per seating status", () => {
    let checked = 0;
    for (const kind of ["draw", "tie", "no_result"]) for (const status of ["decided", "forfeited", "finalized"]) {
      expect(() => assertNoLevelSeat({ fixtureId: "f", stageKind: "knockout", status, outcome: { kind } }), `${kind} ${status}`).toThrow(expect.objectContaining({ code: "LEVEL_RESULT_SEATED" }));
      checked++;
    }
    expect(checked).toBe(9);
    expect(() => assertNoLevelSeat({ fixtureId: "f", stageKind: "knockout", status: "needs_decision", outcome: { kind: "draw" } })).not.toThrow();
  });

  it.skipIf(!HAS_DB)("X-BR-2: a level football knockout result is held — needs_decision, nobody seated in the final", async () => {
    const t = await semi("football", "11-a-side");
    await post(t.auth, t.sf, "core.start");
    await post(t.auth, t.sf, "football.period.end", {}); // the executor pins the stream that ends a 0–0 match with no decider, from football's own conformance stream
    const r = await row(t.sf);
    expect(r.status).toBe("needs_decision");
    expect(await seated(t.final)).toEqual([]);
  });

  it.skipIf(!HAS_DB)("X-ST-1: settle seats the winner in the final AND the loser on its loser line (right answer differs from an award)", async () => {
    const t = await semi("boardgame", "classical", "double_elim");
    await appendEvent(t.auth.orgId, t.sf, 0, { type: "core.start", payload: {} });
    // A frozen pre-deploy cfg without tiebreak (Review Focus 4): the drawn game holds instead of opening the tie-break.
    await sql`update fixtures set config_snapshot = config_snapshot - 'tiebreak' where id = ${t.sf}`;
    await post(t.auth, t.sf, "boardgame.result", { winner: null, method: "agreement" });
    expect((await row(t.sf)).status).toBe("needs_decision");
    await post(t.auth, t.sf, "core.settle", { winner: t.away, method: "lot" });
    const r = await row(t.sf);
    expect(r.status).toBe("decided");
    expect(r.outcome).toEqual({ kind: "win", winner: t.away, loser: t.home, method: "settled_lot" });
    expect(await seated(t.final)).toEqual([t.away]);
    expect(await seated(r.loser_to_fixture!)).toEqual([t.home]); // an award would seat no loser
  });

  it.skipIf(!HAS_DB)("every settle method reaches the stored outcome", async () => {
    let checked = 0;
    for (const method of SETTLE_METHODS) {
      const t = await semi("generic", "score");
      await post(t.auth, t.sf, "core.start");
      await post(t.auth, t.sf, "core.abandon", { reason: "rain" });
      await post(t.auth, t.sf, "core.settle", { winner: t.home, method });
      expect((await row(t.sf)).outcome?.method).toBe(`settled_${method}`);
      checked++;
    }
    expect(checked).toBe(SETTLE_METHODS.length);
  });

  it.skipIf(!HAS_DB)("Review Focus 1: a void of the settle returns the fixture to needs_decision and empties the seat it filled", async () => {
    const t = await semi("boardgame", "classical");
    await appendEvent(t.auth.orgId, t.sf, 0, { type: "core.start", payload: {} });
    await sql`update fixtures set config_snapshot = config_snapshot - 'tiebreak' where id = ${t.sf}`;
    await post(t.auth, t.sf, "boardgame.result", { winner: null, method: "agreement" });
    await post(t.auth, t.sf, "core.settle", { winner: t.home, method: "organiser" });
    const [settle] = await sql<{ id: string }[]>`select id from score_events where fixture_id = ${t.sf} and type = 'core.settle'`;
    await post(t.auth, t.sf, "core.void", { event_id: settle!.id });
    expect((await row(t.sf)).status).toBe("needs_decision");
    expect(await seated(t.final)).toEqual([]);
  });

  it.skipIf(!HAS_DB)("Review Focus 1: once the next match has started, the void of the settle is refused NEXT_MATCH_STARTED and nothing changes", async () => {
    const t = await semi("boardgame", "classical");
    await appendEvent(t.auth.orgId, t.sf, 0, { type: "core.start", payload: {} });
    await sql`update fixtures set config_snapshot = config_snapshot - 'tiebreak' where id = ${t.sf}`;
    await post(t.auth, t.sf, "boardgame.result", { winner: null, method: "agreement" });
    await post(t.auth, t.sf, "core.settle", { winner: t.home, method: "organiser" });
    await sql`insert into score_events (id, fixture_id, seq, type, payload, recorded_at) values (gen_random_uuid(), ${t.final}, 1, 'core.note', '{"text":"warm-up"}', now())`;
    const [settle] = await sql<{ id: string }[]>`select id from score_events where fixture_id = ${t.sf} and type = 'core.settle'`;
    await expect(post(t.auth, t.sf, "core.void", { event_id: settle!.id })).rejects.toMatchObject({ code: "NEXT_MATCH_STARTED" });
    expect((await row(t.sf)).status).toBe("decided");
    expect(await seated(t.final)).toEqual([t.home]);
  });

  it.skipIf(!HAS_DB)("GN-KO-1: a generic draw in a bracket is refused LEVEL_RESULT_IN_BRACKET and leaves the ledger untouched", async () => {
    const t = await semi("generic", "score");
    await post(t.auth, t.sf, "core.start");
    const before = await seq(t.sf);
    await expect(post(t.auth, t.sf, "generic.result", { p1Score: 1, p2Score: 1 })).rejects.toMatchObject({ code: "LEVEL_RESULT_IN_BRACKET" });
    expect(await seq(t.sf)).toBe(before);
  });

  it.skipIf(!HAS_DB)("CK-KO-1: a cricket knockout no-result is held, then settled by the higher group finisher", async () => {
    const t = await semi("cricket", "t20");
    await post(t.auth, t.sf, "core.start");
    await post(t.auth, t.sf, "core.abandon", { reason: "rain" }); // cricket folds an abandon to no_result (finding 19)
    expect((await row(t.sf)).status).toBe("abandoned");
    await post(t.auth, t.sf, "core.settle", { winner: t.home, method: "higher_seed" });
    expect((await row(t.sf)).status).toBe("decided");
    expect(await seated(t.final)).toEqual([t.home]);
  });

  it.skipIf(!HAS_DB)("Review Focus 5 (ruling C17): a withdrawal leaves a held fixture needs_decision; a settle naming the withdrawn entrant is refused, and a settle for the remaining one seats them", async () => {
    const t = await semi("boardgame", "classical");
    await appendEvent(t.auth.orgId, t.sf, 0, { type: "core.start", payload: {} });
    await sql`update fixtures set config_snapshot = config_snapshot - 'tiebreak' where id = ${t.sf}`;
    await post(t.auth, t.sf, "boardgame.result", { winner: null, method: "agreement" });
    expect((await row(t.sf)).status).toBe("needs_decision");
    await withdrawEntrantCascade(t.auth, t.away);
    const r = await row(t.sf);
    expect(r.status).toBe("needs_decision"); // exactly: withdrawBracketEntrant skips it (withdrawal.ts:195 → "void", stage.ts:459)
    expect(r.outcome).toEqual({ kind: "draw" });
    expect(await seated(t.final)).toEqual([]);
    const before = await seq(t.sf);
    await expect(post(t.auth, t.sf, "core.settle", { winner: t.away, method: "organiser" })).rejects.toMatchObject({ code: "SETTLE_NOT_APPLICABLE", data: { reason: "withdrawn" } });
    expect(await seq(t.sf)).toBe(before); // the refusal wrote nothing
    expect(await seated(t.final)).toEqual([]);
    await post(t.auth, t.sf, "core.settle", { winner: t.home, method: "organiser" }); // the positive pair
    expect((await row(t.sf)).status).toBe("decided");
    expect(await seated(t.final)).toEqual([t.home]);
  });

  it.skipIf(!HAS_DB)("finding 27: finalize of a level bracket result is refused (held, and abandoned-with-no_result), and accepted once settled", async () => {
    const t = await semi("football", "11-a-side");
    await post(t.auth, t.sf, "core.start");
    await post(t.auth, t.sf, "core.abandon", { reason: "floodlights" }); // football folds a level abandon to no_result (finding 19)
    const before = await seq(t.sf);
    await expect(post(t.auth, t.sf, "core.finalize")).rejects.toMatchObject({ code: "LEVEL_RESULT_IN_BRACKET" });
    expect(await seq(t.sf)).toBe(before);
    await post(t.auth, t.sf, "core.settle", { winner: t.home, method: "organiser" });
    await post(t.auth, t.sf, "core.finalize");
    expect((await row(t.sf)).status).toBe("finalized");
  });

  it.skipIf(!HAS_DB)("Review Focus 2: a second settle is refused SETTLE_NOT_APPLICABLE and seats nobody twice", async () => {
    const t = await semi("generic", "score");
    await post(t.auth, t.sf, "core.start");
    await post(t.auth, t.sf, "core.abandon", { reason: "rain" });
    await post(t.auth, t.sf, "core.settle", { winner: t.home, method: "lot" });
    await expect(post(t.auth, t.sf, "core.settle", { winner: t.away, method: "lot" })).rejects.toMatchObject({ code: "SETTLE_NOT_APPLICABLE" });
    expect(await seated(t.final)).toEqual([t.home]);
  });
});
```

The football 0–0 stream (`football.period.end` above) is pinned from football's own conformance or simulation stream for "full time level, no extra time, no shootout" (`E/sports/football/football.test.ts`) before the first run. The `withdrawEntrantCascade(auth, entrantId)` signature is pinned from `withdrawal.ts:130`.

`draw-guard.test.ts` is rewritten from the rule rows (class 4: its titles assert the old refusal):
- `:111` stays a refusal, now `LEVEL_RESULT_IN_BRACKET` (GN-KO-1);
- `:139` "rejects a level football knockout full-time …" becomes "holds a level football knockout full-time as needs_decision (X-BR-2)";
- `:128`, `:163` and `:184` are unchanged.

- [ ] **Step 2: Run them; see them fail**

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a/apps/web && rm -f "$TMPDIR/w2a-t8.json" && pnpm vitest run src/server/engine-db/__tests__/settle-seating.test.ts src/server/engine-db/__tests__/draw-guard.test.ts --reporter=json --outputFile="$TMPDIR/w2a-t8.json"; echo EXIT=$?
```

Expected: `EXIT=1`. `level-seat` is missing, and the football case is refused `DRAW_NOT_ALLOWED` instead of being held.

- [ ] **Step 3: `level-seat.ts`**

```ts
import "server-only";
import { EngineError, forbidsLevelResult, isLevelOutcome } from "@seazn/engine/core";

/** The statuses under which a bracket fixture's outcome SEATS someone (onDecided, toBracketFixture, the rebuild). */
export const SEATING_STATUSES: ReadonlySet<string> = new Set(["decided", "forfeited", "finalized"]);

const isBugShape = (f: { stageKind: string | null; status: string; outcome: unknown }): boolean =>
  forbidsLevelResult(f.stageKind) && SEATING_STATUSES.has(f.status) && isLevelOutcome(f.outcome as never);

/** X-BR-1 (R28: competition.ts:144-150 SAID draws never reach a bracket; this makes it so). Reachable only
 *  through a bug — the status rule holds a level bracket result as needs_decision — so it is tested by forcing. */
export function assertNoLevelSeat(f: { fixtureId: string; stageKind: string | null; status: string; outcome: unknown }): void {
  if (isBugShape(f)) {
    throw new EngineError("LEVEL_RESULT_SEATED", "a level result reached bracket seating", { fixtureId: f.fixtureId, status: f.status, stageKind: f.stageKind });
  }
}
```

There is no report-only read-path form: ruling 82's backfill (V431) removes the legacy shape, so the read paths throw on it like any other bug shape.

- [ ] **Step 4: Wire the guards**

`append-event.ts`, replacing `:330-346`:

```ts
  const stageKind = stage?.kind ?? null;
  // W2a (spec §5.4.3, ruling 79). In a bracket: a GENERIC draw is refused — generic has no decider, the scorer
  // enters the winner (GN-KO-1); every other level result is ACCEPTED and held as needs_decision (X-BR-2).
  // Outside a bracket: a draw the sport refuses is DRAW_NOT_ALLOWED, as before.
  if (outcome !== null && (outcome as { kind?: string }).kind === "draw") {
    if (forbidsLevelResult(stageKind)) {
      if (division.sport_key === "generic") {
        throw new EngineError("LEVEL_RESULT_IN_BRACKET", "a knockout match can't end level — enter the winner", { fixtureId, stage: stageKind });
      }
    } else if (stage !== undefined && !sportModule.supportsDraws(cfg as never, stage.kind as StageKind)) {
      throw new EngineError("DRAW_NOT_ALLOWED", "this stage cannot end level — decide it by extra time or a shootout", { fixtureId, stage: stage.kind });
    }
  }
  // Finding 27: finalizing a level bracket result would store `finalized` + a level outcome — the very shape
  // LEVEL_RESULT_SEATED exists to catch, and a lock no settle could then open. Refused until it is settled.
  // (No "and not settled" clause: `outcome` is outcomeOf's, so a settled fixture's outcome is a win — preflight C20.)
  if (candidate.type === "core.finalize" && forbidsLevelResult(stageKind) && isLevelOutcome(outcome)) {
    throw new EngineError("LEVEL_RESULT_IN_BRACKET", "settle the match before finalizing — a knockout match can't end level", { fixtureId, stage: stageKind });
  }
  // Controller ruling C17: a settle may not advance an entrant who has withdrawn. The organiser settles for the
  // remaining one; auto-walkover of a held fixture is W2b's (spec §2.3).
  if (candidate.type === "core.settle") {
    const winner = (candidate.payload as { winner?: unknown }).winner;
    const [w] = await tx<{ status: string }[]>`select status from entrants where id = ${String(winner)}`;
    if (w?.status === "withdrawn") {
      throw new EngineError("SETTLE_NOT_APPLICABLE", "that entrant has withdrawn — settle for the remaining entrant", { fixtureId, reason: "withdrawn", winner });
    }
  }
```

`firstResult` (spec §5.4.4, the "fires once" comment at `:388`): a held fixture is not yet a result, and its settle is.

```ts
  const firstResult: FirstResult | null =
    (fixture.outcome === null || fixture.status === "needs_decision") && outcome !== null && status !== "needs_decision"
      ? { … unchanged … }
      : null;
```

`scoring.ts:294`:

```ts
    // W2a: a HELD fixture (needs_decision) seats nobody, so onDecided is not called for it (spec §5.4.4).
    if ((result.outcome !== null && result.status !== "needs_decision") || input.type === "core.void") {
```

`onDecided`: add `f.status` to the select and the row type. Right after `if (!fixture) return null;`:

```ts
    assertNoLevelSeat({ fixtureId, stageKind: fixture.kind, status: fixture.status, outcome: fixture.outcome });
```

`competition.ts`: the comment at `:144-150` is replaced with:

```ts
// draw/tie/no_result: a bracket fixture holding one is needs_decision (W2a X-BR-2) and seats nobody, so they
// resolve to neither side here; a level outcome under a SEATING status is the bug shape, and the callers that
// know the stage kind assert it (level-seat.ts, X-BR-1).
```

`toBracketFixture(f, stageKind)` calls `assertNoLevelSeat({ fixtureId: f.id, stageKind, status: f.status, outcome: f.outcome })` first. Its two callers pass the stage kind they already hold. `stages.ts:4088` does the same in the rebuild map.

- [ ] **Step 5: Run green**

The Step 2 command, plus `src/server/engine-db/__tests__/bracket-fixture.test.ts src/server/usecases/__tests__/dead-feeder-cascade.test.ts src/server/usecases/__tests__/bracket-kinds-sync.test.ts src/server/engine-db/__tests__/append-event.test.ts` (the `first-result-held` killer lives there; preflight C20). Expected: `EXIT=0`, `files: 6`, `failed: 0`, 0 skipped. Then tsc: `EXIT=0`.

- [ ] **Step 6: Mutate each member once (runner)** — `MUT/t8.json`

| id | find → replace | killer |
|---|---|---|
| `generic-refusal-off` | `if (division.sport_key === "generic") {` → `if (false) {` | "GN-KO-1 …" |
| `hold-not-refuse` | `if (forbidsLevelResult(stageKind)) {` → `if (false) {` | "X-BR-2: a level football knockout result is held …" (it goes back to `DRAW_NOT_ALLOWED`) |
| `ondecided-gate` | `result.status !== "needs_decision"` → `true` | "X-BR-2 …" (the cascade runs on a held fixture). If the seat stays empty anyway, add a case asserting `onDecided` is not called, with a `vi.spyOn` on the module, and re-run |
| `seat-assert-off` | `if (isBugShape(f)) {` → `if (false) {` | "X-BR-1: the forced bug shape …" |
| `seat-assert-draw` | `isLevelOutcome(f.outcome as never)` → `(f.outcome as { kind?: string })?.kind === "tie" \|\| (f.outcome as { kind?: string })?.kind === "no_result"` | "X-BR-1 … per level kind" (the draw rows) |
| `seat-status-forfeited` | `"decided", "forfeited", "finalized"` → `"decided", "finalized"` | "X-BR-1 … per seating status" (the forfeited rows) |
| `first-result-held` | `&& status !== "needs_decision"` → `` | add the case "a held fixture does not count as a first result; its settle does" to `append-event.test.ts` |
| `settle-withdrawn` | `if (w?.status === "withdrawn") {` → `if (false) {` | "Review Focus 5 (ruling C17): … a settle naming the withdrawn entrant is refused …" |
| `finalize-held` | `if (candidate.type === "core.finalize" && forbidsLevelResult(stageKind)` → `if (false && forbidsLevelResult(stageKind)` | "finding 27: finalize of a level bracket result is refused …" |

There is no `finalize-after-settle` row: that clause was equivalent (a settled fixture's `outcomeOf` is a win, so `isLevelOutcome` is already false) and is dropped from the code (preflight C20). There is no `withdraw-played` row: `WITHDRAWAL_PLAYED_STATUSES` does not change (ruling C17, Task 7 Step 6).

Expected: `EXIT=0`, 9 rows killed.

- [ ] **Step 7: Proof bookkeeping**
  - Delete `X-BR-1`, `GN-KO-1` and `CK-KO-1` from `AWAITING_PROOF` (and `X-BR-2`, which Task 7 owns but whose DB proof is here).
  - Set proved-by:
    - X-BR-1 → `` `apps/web/src/server/engine-db/__tests__/settle-seating.test.ts` ``;
    - X-BR-2 → `` `apps/web/src/server/engine-db/__tests__/needs-decision-status.test.ts`<br>`apps/web/src/server/engine-db/__tests__/settle-seating.test.ts` ``;
    - GN-KO-1 and CK-KO-1 → `settle-seating.test.ts`.
  - Run `rules-reference.test.ts` green.

**Four test types:**
- Unit and DB: Steps 1–5.
- E2E: Task 11 "settle on the console" and "double submit".
- Smoke: Task 17's `bracketFinishSuite`.
- Regression: `draw-guard.test.ts` rewritten, and Task 16's judge.

---

### Task 9: One organiser-only constant, enforced on the server and imported by the pad (X-ST-2; ruling 77)

**Loop F, continued (it shares `scoring.ts` with Task 8). The loop's Opus review has a named "security" section for this task: per event × per authority, plus what happens when a session role changes mid-request.**

**Files:**
- Create: `W/lib/organiser-only-events.ts`
- Modify: `W/server/usecases/scoring.ts:497-559` (one check, before the device and scorer branches)
- Modify: `W/components/v2/scorepad/v3/pad-host.tsx:727-730` (imports the constant), `W/components/v2/scorepad/v3/__tests__/authority-only-tiles.test.ts:63`
- Create: `W/server/usecases/__tests__/organiser-only-events.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const ORGANISER_ONLY_EVENT_TYPES: readonly ["core.settle", "core.forfeit", "core.abandon"];
  export const ORGANISER_ONLY: ReadonlySet<string>;
  ```
  The server refuses with `HttpError(403, "Only an organiser can <verb> a match")`, which maps to the API's `FORBIDDEN` (`api-v1/http.ts:80`). That is the code spec §7 row 3 asks the plan to name.

- [ ] **Step 1: The failing matrix test** (per event × per authority)

```ts
import { describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { scoreEvent } from "@/server/usecases/scoring";
import { ORGANISER_ONLY_EVENT_TYPES } from "@/lib/organiser-only-events";
import { seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";

const HAS_DB = !!process.env.DATABASE_URL;
const seq = async (id: string) => (await sql<{ s: number }[]>`select coalesce(max(seq),0)::int as s from score_events where fixture_id = ${id}`)[0]!.s;

/** Authorities as AuthCtx shapes: the two refused (device link; a non-editor official scorer, the shape
 *  subjectToScorerCapabilityGates selects) and the two allowed (owner, admin). */
const REFUSED = ["device_link", "official"] as const;
const ALLOWED = ["owner", "admin"] as const;

describe("X-ST-2: settle, forfeit and abandon are organiser-only on the server (ruling 77)", () => {
  it("empty case first: the constant is exactly the three ruled types", () => {
    expect([...ORGANISER_ONLY_EVENT_TYPES].sort()).toEqual(["core.abandon", "core.forfeit", "core.settle"]);
  });
  it.skipIf(!HAS_DB)("X-ST-2: every organiser-only type is refused 403 for every non-organiser authority, and nothing is written", async () => {
    let checked = 0;
    for (const type of ORGANISER_ONLY_EVENT_TYPES) for (const who of REFUSED) {
      const s = await seedBracket({ sport: "generic", variant: "score", stageKind: "knockout", entrants: 2 });
      const id = s.fixtureIds[0]!;
      await scoreEvent(s.auth, id, { expected_seq: 0, type: "core.start", payload: {} } as never);
      const auth = await asAuthority(s.auth, s.divisionId, id, who);
      const before = await seq(id);
      await expect(scoreEvent(auth, id, { expected_seq: before, type, payload: payloadFor(type, s) } as never), `${type} ${who}`).rejects.toMatchObject({ status: 403 });
      expect(await seq(id), `${type} ${who}`).toBe(before);
      checked++;
    }
    expect(checked).toBe(ORGANISER_ONLY_EVENT_TYPES.length * REFUSED.length);
  });
  it.skipIf(!HAS_DB)("X-ST-2 positive pair: owner and admin pass the gate for each type (refused only by the engine, if at all)", async () => {
    let checked = 0;
    for (const type of ORGANISER_ONLY_EVENT_TYPES) for (const who of ALLOWED) {
      const s = await seedBracket({ sport: "generic", variant: "score", stageKind: "knockout", entrants: 2 });
      const id = s.fixtureIds[0]!;
      await scoreEvent(s.auth, id, { expected_seq: 0, type: "core.start", payload: {} } as never);
      if (type === "core.settle") await scoreEvent(s.auth, id, { expected_seq: 1, type: "core.abandon", payload: { reason: "rain" } } as never);
      const auth = { ...s.auth, role: who };
      await expect(scoreEvent(auth, id, { expected_seq: await seq(id), type, payload: payloadFor(type, s) } as never), `${type} ${who}`).resolves.toBeTruthy();
      checked++;
    }
    expect(checked).toBe(ORGANISER_ONLY_EVENT_TYPES.length * ALLOWED.length);
  });
  it.skipIf(!HAS_DB)("an official can still post an ordinary play event — the organiser-only check did not swallow the scorer path", async () => {
    // Retitled (preflight C21): this case asserts a play event, not finalize or void. The existing scorer gates for
    // finalize and void (scoring.ts:552-559) keep their own tests, unchanged.
    const s = await seedBracket({ sport: "generic", variant: "score", stageKind: "knockout", entrants: 2 });
    const id = s.fixtureIds[0]!;
    await scoreEvent(s.auth, id, { expected_seq: 0, type: "core.start", payload: {} } as never);
    const official = await asAuthority(s.auth, s.divisionId, id, "official");
    await expect(scoreEvent(official, id, { expected_seq: 1, type: "generic.result", payload: { p1Score: 2, p2Score: 1 } } as never)).resolves.toBeTruthy();
  });
});
```

`asAuthority(auth, divisionId, fixtureId, who)` and `payloadFor(type, s)` are local helpers in the file:
- `device_link` mints a link through the device-link usecase the existing device tests use (`grep -arln "deviceLinkId" apps/web/src/server/usecases/__tests__ | head -3` names them). It returns `{ ...auth, via: "device_link", deviceLinkId }`.
- `official` adds a user as an accepted official scorer on the division, the way `scorers.test.ts` does. It returns `{ ...auth, role: "member", userId }`, so `subjectToScorerCapabilityGates` is true.
- `payloadFor` returns:
  - `{ winner: s.<home entrant> , method: "lot" }` for settle;
  - `{ by: <away entrant>, reason: "walkover" }` for forfeit;
  - `{ reason: "rain" }` for abandon.

- [ ] **Step 2: Run; see it fail**

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a/apps/web && rm -f "$TMPDIR/w2a-t9.json" && pnpm vitest run src/server/usecases/__tests__/organiser-only-events.test.ts src/components/v2/scorepad/v3/__tests__/authority-only-tiles.test.ts --reporter=json --outputFile="$TMPDIR/w2a-t9.json"; echo EXIT=$?
```

Expected: `EXIT=1`. The constant module is missing, and the officials' forfeit and abandon are accepted today.

- [ ] **Step 3: Implement**

`W/lib/organiser-only-events.ts` (no `server-only`: the pad imports it, and a client importing server code breaks the build):

```ts
// X-ST-2 (ruling 77): only an organiser (owner/admin, not a device link, not an official scorer) may settle,
// forfeit or abandon a match. ONE constant: the server's refusal (usecases/scoring.ts) and the pad's tile filter
// (scorepad/v3/pad-host.tsx) both read it, so the two cannot drift.
export const ORGANISER_ONLY_EVENT_TYPES = ["core.settle", "core.forfeit", "core.abandon"] as const;
export const ORGANISER_ONLY: ReadonlySet<string> = new Set(ORGANISER_ONLY_EVENT_TYPES);
```

`scoring.ts`, inserted before `// Device-link capabilities` (`:497`):

```ts
  // X-ST-2 (ruling 77). Before the device and scorer branches, so neither can let one through; 403 → FORBIDDEN.
  if (ORGANISER_ONLY.has(input.type) && (auth.via === "device_link" || subjectToScorerCapabilityGates(auth))) {
    throw new HttpError(403, `Only an organiser can ${input.type === "core.settle" ? "settle" : input.type === "core.forfeit" ? "record a walkover for" : "abandon"} a match`);
  }
```

`pad-host.tsx:727-730`:

```ts
import { ORGANISER_ONLY } from "@/lib/organiser-only-events";
/** … (existing doc kept; now: "the SAME set the server refuses, lib/organiser-only-events.ts") */
export const AUTHORITY_ONLY_EVENT_TYPES: ReadonlySet<string> = ORGANISER_ONLY;
```

`authority-only-tiles.test.ts:63` asserts `["core.abandon", "core.forfeit", "core.settle"]` and that `AUTHORITY_ONLY_EVENT_TYPES === ORGANISER_ONLY` (identity, not equality).

- [ ] **Step 4: Run green**

The Step 2 command, plus `src/server/usecases/__tests__/scorers.test.ts`. Expected: `EXIT=0`, `files: 3`, `failed: 0`, 0 skipped.

- [ ] **Step 5: Mutate per event × per authority (runner)** — `MUT/t9.json`

| id | find → replace | killer |
|---|---|---|
| `drop-settle` | `["core.settle", "core.forfeit", "core.abandon"]` → `["core.forfeit", "core.abandon"]` | "empty case first …" and "X-ST-2: every … refused" (settle rows) |
| `drop-forfeit` | `["core.settle", "core.forfeit", "core.abandon"]` → `["core.settle", "core.abandon"]` | the same (forfeit rows) |
| `drop-abandon` | `["core.settle", "core.forfeit", "core.abandon"]` → `["core.settle", "core.forfeit"]` | the same (abandon rows) |
| `device-allowed` | `auth.via === "device_link" \|\| ` → `` | "X-ST-2: every … refused" (device rows) |
| `official-allowed` | ` \|\| subjectToScorerCapabilityGates(auth)` → `` | the same (official rows) |
| `organiser-refused` | `(auth.via === "device_link" \|\| subjectToScorerCapabilityGates(auth))` → `true` | "X-ST-2 positive pair …" |
| `pad-copy` | `AUTHORITY_ONLY_EVENT_TYPES: ReadonlySet<string> = ORGANISER_ONLY` → `AUTHORITY_ONLY_EVENT_TYPES: ReadonlySet<string> = new Set(["core.forfeit", "core.abandon"])` | `authority-only-tiles.test.ts` (identity) |

The three `drop-*` mutants each name the same `find`. They are three entries with distinct ids, and the runner applies each alone. Expected: `EXIT=0`, 7 rows killed.

- [ ] **Step 6: Proof bookkeeping and the loop F commit set**
  - Delete `X-ST-2` from `AWAITING_PROOF`, and set its proved-by to `` `apps/web/src/server/usecases/__tests__/organiser-only-events.test.ts` ``.
  - Run `rules-reference.test.ts` green.
  - Commit Tasks 6–9 as four commits, one per task, each with its `MUT/t<N>.json`:
    - `feat(server): bracket overlay in resolveFixtureCfg, every caller proven (W2a T6)`;
    - `feat(server): needs_decision status, V431, the counted status-set sweep (W2a T7, X-BR-2)`;
    - `feat(server): hold-not-refuse write guard, LEVEL_RESULT_SEATED, settle seats both sides (W2a T8, X-BR-1)`;
    - `feat(server): organiser-only settle/forfeit/abandon, one constant for server and pad (W2a T9, X-ST-2)`.
  - Then the OpenAPI drift check (`pnpm openapi:gen && git status --porcelain openapi` empty) and loop F's review.

**Four test types:**
- Unit and DB: Steps 1–4.
- E2E: Task 11's console spec "finding 11: on a held fixture the organiser sees Settle; an official scorer sees the fixture and its status but no Settle, Forfeit or Abandon" (preflight C21: the trace now names a test that exists). The pad offers no settle tile by construction: `core.settle` is not in any `padSpec` (Task 4 keeps it kernel-owned), which Task 12's `boardgame-tiebreak.test.ts` "the tie-break sheet never offers settle or lots" asserts.
- Smoke: Task 17 (an official's settle by API is 403).
- Regression: the matrix test runs on every PR.

---

### Task 10: NEW-H1 — a scorer's abandon is not a generator void (spec §5.4.7; D4)

**Loop G. It waits on loop F merged and on E1's verdict (Task 1 Step 7).**

**Files:**
- Modify: `W/server/usecases/stages.ts:3629-3660` (`feederIsDead`), `:3831-3836` (`SeatRow` gains `has_active_abandon`)
- Modify: `W/server/usecases/__tests__/dead-feeder-cascade.test.ts` (new cases)
- Modify: `apps/web/e2e/bracket-new-h1.spec.ts` (header comment only: red at Task 1, green from here)

**Interfaces:**
- Consumes: Task 1's verdict; `seedBracket` (Task 6).
- Produces: `feederIsDead(f: { status: string; outcome: … | null; has_active_abandon: boolean }): boolean`.

- [ ] **Step 0: Branch on E1's verdict.** If the probe went green at Task 1, NEW-H1 is a false premise:
  - record it in `IDX` "False premises found (W2a)", with the probe's `report.json` as evidence;
  - keep the probe as its regression;
  - skip Steps 1–5, and go straight to Step 6's e2e run (expected green).

  The rest of this task assumes the probe reproduced.

- [ ] **Step 1: The failing unit cases** (add to `dead-feeder-cascade.test.ts`)

```ts
  it("NEW-H1: a scorer's abandon (an active core.abandon, outcome null) is NOT a dead feeder — the final stays stuck and visible", async () => {
    const s = await seedBracket({ sport: "badminton", variant: "bwf", stageKind: "knockout", entrants: 4 });
    const [sf1, sf2] = s.fixtureIds;
    await scoreEvent(s.auth, sf1!, { expected_seq: 0, type: "core.start", payload: {} } as never);
    await scoreEvent(s.auth, sf1!, { expected_seq: 1, type: "core.abandon", payload: { reason: "injury" } } as never);
    const [r2] = await sql<{ away_entrant_id: string; winner_to_fixture: string }[]>`select away_entrant_id, winner_to_fixture from fixtures where id = ${sf2!}`;
    await scoreEvent(s.auth, sf2!, { expected_seq: 0, type: "core.start", payload: {} } as never);
    await scoreEvent(s.auth, sf2!, { expected_seq: 1, type: "core.forfeit", payload: { by: r2!.away_entrant_id, reason: "walkover" } } as never);
    const [fin] = await sql<{ status: string; outcome: unknown }[]>`select status, outcome from fixtures where id = ${r2!.winner_to_fixture}`;
    expect(fin).toEqual({ status: "scheduled", outcome: null });
  });
  it("NEW-H1: the generator's own void (abandoned, outcome null, NO core.abandon event) is still dead — the walkover still happens", async () => {
    // The existing "dead feeder" cases build exactly this shape through raw SQL; this case names it D4's way.
    const s = await seedBracket({ sport: "badminton", variant: "bwf", stageKind: "knockout", entrants: 4 });
    const [sf1, sf2] = s.fixtureIds;
    await sql`update fixtures set status = 'abandoned', outcome = null where id = ${sf1!}`;
    const [r2] = await sql<{ away_entrant_id: string; winner_to_fixture: string }[]>`select away_entrant_id, winner_to_fixture from fixtures where id = ${sf2!}`;
    await scoreEvent(s.auth, sf2!, { expected_seq: 0, type: "core.start", payload: {} } as never);
    await scoreEvent(s.auth, sf2!, { expected_seq: 1, type: "core.forfeit", payload: { by: r2!.away_entrant_id, reason: "walkover" } } as never);
    const [fin] = await sql<{ status: string }[]>`select status from fixtures where id = ${r2!.winner_to_fixture}`;
    expect(fin!.status).toBe("forfeited");
  });
  it("NEW-H1: a VOIDED scorer abandon is not active — a feeder the generator later voids is dead and the walkover happens", async () => {
    // preflight C22: this case asserts the feeder's seat outcome (the final's status), not only the feeder's status.
    const s = await seedBracket({ sport: "badminton", variant: "bwf", stageKind: "knockout", entrants: 4 });
    const [sf1, sf2] = s.fixtureIds;
    await scoreEvent(s.auth, sf1!, { expected_seq: 0, type: "core.start", payload: {} } as never);
    await scoreEvent(s.auth, sf1!, { expected_seq: 1, type: "core.abandon", payload: { reason: "injury" } } as never);
    const [ab] = await sql<{ id: string }[]>`select id from score_events where fixture_id = ${sf1!} and type = 'core.abandon'`;
    await scoreEvent(s.auth, sf1!, { expected_seq: 2, type: "core.void", payload: { event_id: ab!.id } } as never);
    const [live] = await sql<{ status: string }[]>`select status from fixtures where id = ${sf1!}`;
    expect(live!.status).toBe("in_play"); // the abandon is gone; the match is live again
    // The generator's void, written without an event (the raw-SQL shape the existing dead-feeder cases use).
    await sql`update fixtures set status = 'abandoned', outcome = null where id = ${sf1!}`;
    const [r2] = await sql<{ away_entrant_id: string; winner_to_fixture: string }[]>`select away_entrant_id, winner_to_fixture from fixtures where id = ${sf2!}`;
    await scoreEvent(s.auth, sf2!, { expected_seq: 0, type: "core.start", payload: {} } as never);
    await scoreEvent(s.auth, sf2!, { expected_seq: 1, type: "core.forfeit", payload: { by: r2!.away_entrant_id, reason: "walkover" } } as never);
    const [fin] = await sql<{ status: string }[]>`select status from fixtures where id = ${r2!.winner_to_fixture}`;
    expect(fin!.status).toBe("forfeited"); // feederIsDead(sf1) === true: the voided abandon did not count as active
  });
```

- [ ] **Step 2: Run them; see the first fail**

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a/apps/web && rm -f "$TMPDIR/w2a-t10.json" && pnpm vitest run src/server/usecases/__tests__/dead-feeder-cascade.test.ts --reporter=json --outputFile="$TMPDIR/w2a-t10.json"; echo EXIT=$?
```

Expected: `EXIT=1`. Only the first new case fails, with `Received: { status: "forfeited", … }`, the same failure as the Task 1 probe. The other two pass, because they pin today's correct behaviour.

- [ ] **Step 3: Implement D4**

`SeatRow`'s select gains:

```sql
             exists (select 1 from score_events a
                      where a.fixture_id = fixtures.id and a.type = 'core.abandon'
                        and not exists (select 1 from score_events v
                                         where v.fixture_id = a.fixture_id and v.voids_event_id = a.id)) as has_active_abandon
```

`feederIsDead`:

```ts
/** … (ruling text kept) …
 *  W2a NEW-H1 (D4, reproduced by apps/web/e2e/bracket-new-h1.spec.ts): `abandoned` with NO outcome is also what a
 *  SCORER's abandon folds to in the set sports and tennis (setbased/kernel.ts:818-823) — a match that was played
 *  and stopped, which the ruling says stays stuck and visible. The generator and this cascade write their voids
 *  WITHOUT an event; a scorer's abandon always has an ACTIVE core.abandon in the ledger (voids are not voidable,
 *  core/events.ts:176-213, so "active" is "no row voids it"). That is the line between them. */
function feederIsDead(f: { status: string; outcome: { winner?: string } | null; has_active_abandon: boolean }): boolean {
  if (f.status === "cancelled") return true;
  return f.status === "abandoned" && f.outcome === null && !f.has_active_abandon;
}
```

`seatFeederIsDead` passes the row through unchanged, and `tsc` lists every other caller of `feederIsDead`.

- [ ] **Step 4: Run green; the probe turns green**

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a/apps/web && rm -f "$TMPDIR/w2a-t10.json" && pnpm vitest run src/server/usecases/__tests__/dead-feeder-cascade.test.ts src/server/usecases/__tests__/stage-orphan-fixtures.test.ts --reporter=json --outputFile="$TMPDIR/w2a-t10.json"; echo EXIT=$?
S=~/.claude/skills/seazn-local-env/scripts/seazn-env.sh; cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a && $S rebuild --label w2a > "$TMPDIR/w2a-rebuild.log" 2>&1; echo EXIT=$?
S=~/.claude/skills/seazn-local-env/scripts/seazn-env.sh; cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a/apps/web && eval "$($S env --label w2a)" && PLAYWRIGHT_BASE="$SMOKE_BASE" E2E_PROD_TARGET=1 npx playwright test --project=parallel e2e/bracket-new-h1.spec.ts; echo EXIT=$?
```

Expected: `EXIT=0` three times. The probe, red at Task 1, is now green (R20: write down the run's own pass line).

- [ ] **Step 5: Mutate (runner)** — `MUT/t10.json`

| id | find → replace | killer |
|---|---|---|
| `abandon-ignored` | `&& !f.has_active_abandon` → `` | "NEW-H1: a scorer's abandon … NOT a dead feeder" |
| `abandon-always` | `&& !f.has_active_abandon` → `&& false` | "NEW-H1: the generator's own void … is still dead" |
| `voids-ignored` | `and not exists (select 1 from score_events v` … `v.voids_event_id = a.id)` → `and true` (the find is the whole `not exists (…)` clause) | "NEW-H1: a VOIDED scorer abandon is not active — … the walkover happens" (the voided abandon then counts as active, the feeder is not dead, the final stays `scheduled`) |
| `cancelled` | `if (f.status === "cancelled") return true;` → `` | the existing "cancelled feeder" case (`dead-feeder-cascade.test.ts`, raw-SQL `cancelled`) |

Expected: `EXIT=0`, every row killed or carrying a recorded reason.

- [ ] **Step 6: Commit** `fix(server): NEW-H1 — a scorer's abandon is not a dead feeder; the generator's void still is (W2a T10, D4)`, then loop G's review.

**Four test types:**
- Unit and DB: Steps 1–4.
- E2E: `bracket-new-h1.spec.ts` (Step 4).
- Smoke: Task 17's `bracketFinishSuite` adds "an abandoned semi leaves the final waiting".
- Regression: the probe spec, which is kept.

---


### Task 11: The console's "Needs a decision" block and the settle dialog (spec §5.5; findings 11, 19, 25, 27)

**Loop H (Tasks 11–13: one implementer pass, one Opus review). It waits on loop F merged. Load the `frontend-design` skill before Step 2, and use it.**

**Files:**
- Create: `W/components/v2/needs-decision.tsx` (`NeedsDecisionBlock` + `SettleDialog`)
- Modify: `W/components/v2/fixture-console.tsx`:
  - `:798`: `decided` and the new `held`;
  - `:1390-1445`: mount the block above the action row; hide Finalize while held (finding 27); gate Forfeit, Abandon and the block on `canOrganise` (finding 11).
- Modify: `W/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/f/[no]/page.tsx:59-62`, `:259` (pass `canOrganise` and `stageKind`)
- Modify: `W/components/v2/stages-panel.tsx` (run-sheet row chip "Needs a decision"; finding 25)
- Modify: `W/dictionaries/{en,fr,es,nl}/ui.json` (`score.needsDecision.*`, `score.status.needs_decision`)
- Create: `apps/web/e2e/bracket-finish.spec.ts` (console part; Task 12 appends the pad part)
- Create: `W/components/v2/__tests__/needs-decision.test.tsx`

**Interfaces:**
- Consumes: `SETTLE_METHODS`, `settleApplies` (Task 4); `awaitingDecider` on boardgame (Task 5); status `needs_decision` (Task 7); `ORGANISER_ONLY` (Task 9); `forbidsLevelResult` (Task 3); `resolveModuleClient` (`scorepad/module-client.ts:41`, already imported by the console at `:58`).
- Produces (the testids lane P1's page object drives; frozen here):
  - `data-testid="needs-decision"`: the block;
  - `data-testid="settle-open"`: its button;
  - `role="dialog"` named by `score.needsDecision.dialogTitle`;
  - `data-testid="settle-winner-<entrantId>"`: two buttons;
  - `data-testid="settle-method-<lot|higher_seed|organiser>"`: radios;
  - `data-testid="settle-note"`;
  - `data-testid="settle-confirm"`;
  - `data-testid="settle-error"`: the refusal text, shown in the BLOCK after the dialog closes (spec §7: "Console dialog closes and shows the reason").
  ```ts
  /** Controller ruling C12: the block shows iff the stage is a bracket kind AND the kernel's own settleApplies is
   *  true — the SAME predicate the kernel's settle precondition calls, fed the same facts. */
  export function needsDecision(
    module: { awaitingDecider?(state: never): boolean },
    f: { outcome: unknown; state: unknown; stageKind: string | null; events: readonly { id: string; type: string; voids_event_id: string | null }[] },
  ): boolean; // forbidsLevelResult(stageKind) && settleApplies(module, { outcome, abandoned: hasActiveAbandon(events), state })
  export function hasActiveAbandon(events: readonly { id: string; type: string; voids_event_id: string | null }[]): boolean;
  export function confirmBlocked(s: { winner: string | null; method: string | null; sending: boolean }): boolean; // preflight C1/C23
  export function finalizeVisible(s: { decided: boolean; held: boolean }): boolean; // finding 27
  ```

- [ ] **Step 0: The layout is already chosen (ruling 82).** The options were shown in brainstorming: UI-1 option A for the console (a "Needs a decision" block above the match-actions section, `fixture-console.tsx:1390`, with a settle dialog), and UI-2 option B for the pad (Task 12). Build to them in the house design; no new options are shown. Before merge, capture the built house-styled screens at 1280, 768 and 320 (Step 6), and record the owner's per-screen verdict (Task 17 Step 3 collects them).

- [ ] **Step 1: The predicates' failing unit test** — `W/components/v2/__tests__/needs-decision.test.tsx` (node environment, pure)

```ts
import { describe, expect, it } from "vitest";
import { BRACKET_KINDS, StageKind, foldMatch } from "@seazn/engine/core";
import { boardgame } from "@seazn/engine/sports/boardgame"; // the "./sports/*" subpath export (engine package.json)
import { defaultLineupPair, makeEnvelope } from "@seazn/engine/testkit";
import { confirmBlocked, finalizeVisible, hasActiveAbandon, needsDecision } from "../needs-decision";

const plain = {}; // a module with no pending-decider hook
const start = { id: "e1", type: "core.start", voids_event_id: null };
const abandon = { id: "e2", type: "core.abandon", voids_event_id: null };
const voidOfAbandon = { id: "e3", type: "core.void", voids_event_id: "e2" };
const WIN = { kind: "win", winner: "a", loser: "b" };

describe("needsDecision = bracket kind AND the kernel's settleApplies (ruling C12; spec §5.5; finding 19)", () => {
  it("empty case first: nothing played, no events, in any kind, needs nothing", () => {
    let checked = 0;
    for (const k of StageKind.options) { expect(needsDecision(plain, { outcome: null, state: {}, stageKind: k, events: [] }), k).toBe(false); checked++; }
    expect(checked).toBe(StageKind.options.length);
  });
  it("a level outcome needs a decision in every bracket kind, and never outside brackets", () => {
    let checked = 0;
    for (const outcome of [{ kind: "draw" }, { kind: "tie" }, { kind: "no_result" }]) for (const k of StageKind.options) {
      expect(needsDecision(plain, { outcome, state: {}, stageKind: k, events: [start] }), `${outcome.kind} ${k}`).toBe(BRACKET_KINDS.has(k));
      checked++;
    }
    expect(checked).toBe(3 * StageKind.options.length);
  });
  it("finding 19: an ACTIVE scorer abandon with a null or level outcome needs a decision; with a win it does not", () => {
    expect(needsDecision(plain, { outcome: null, state: {}, stageKind: "knockout", events: [start, abandon] })).toBe(true);
    expect(needsDecision(plain, { outcome: { kind: "no_result" }, state: {}, stageKind: "knockout", events: [start, abandon] })).toBe(true);
    expect(needsDecision(plain, { outcome: WIN, state: {}, stageKind: "knockout", events: [start, abandon] })).toBe(false);
  });
  it("the generator's void (abandoned, outcome null, NO abandon event) and a voided abandon need nothing — the kernel would refuse the settle", () => {
    expect(hasActiveAbandon([start])).toBe(false);
    expect(hasActiveAbandon([start, abandon])).toBe(true); // the positive pair
    expect(hasActiveAbandon([start, abandon, voidOfAbandon])).toBe(false);
    expect(needsDecision(plain, { outcome: null, state: {}, stageKind: "knockout", events: [start] })).toBe(false);
    expect(needsDecision(plain, { outcome: null, state: {}, stageKind: "knockout", events: [start, abandon, voidOfAbandon] })).toBe(false);
  });
  it("C12: a chess knockout in phase tiebreak (status in_play, outcome null) needs a decision — lots is the organiser's settle", () => {
    const lineups = defaultLineupPair(boardgame.positions);
    const ko = boardgame.configSchema.parse({ ...boardgame.bracketDeciders(boardgame.configSchema.parse({})) });
    const state = foldMatch(boardgame, ko, lineups, [makeEnvelope(1, { type: "core.start", payload: {} } as never), makeEnvelope(2, { type: "boardgame.result", payload: { winner: null, method: "agreement" } } as never)]);
    expect((state as { phase: string }).phase).toBe("tiebreak");
    expect(needsDecision(boardgame, { outcome: boardgame.outcome(state), state, stageKind: "knockout", events: [start] })).toBe(true);
    expect(needsDecision(plain, { outcome: boardgame.outcome(state), state, stageKind: "knockout", events: [start] })).toBe(false); // without the module's hook
  });
  it("decided (including a settled fixture) needs nothing", () => {
    expect(needsDecision(plain, { outcome: { ...WIN, method: "settled_lot" }, state: {}, stageKind: "knockout", events: [start, abandon] })).toBe(false);
  });
  it("confirmBlocked: blocked until a winner AND a method are chosen, and while sending (Review Focus 2)", () => {
    const rows: [string | null, string | null, boolean, boolean][] = [
      [null, null, false, true], ["a", null, false, true], [null, "lot", false, true], ["a", "lot", false, false], ["a", "lot", true, true],
    ];
    let checked = 0;
    for (const [winner, method, sending, blocked] of rows) { expect(confirmBlocked({ winner, method, sending }), JSON.stringify([winner, method, sending])).toBe(blocked); checked++; }
    expect(checked).toBe(5);
  });
  it("finalizeVisible: Finalize shows for a decided fixture and never while it is held (finding 27)", () => {
    expect(finalizeVisible({ decided: true, held: false })).toBe(true);
    expect(finalizeVisible({ decided: true, held: true })).toBe(false);
    expect(finalizeVisible({ decided: false, held: false })).toBe(false);
  });
});
```

- [ ] **Step 2: Build the component** (`W/components/v2/needs-decision.tsx`; v2 tokens, `btn` classes, the console's focus-trap pattern from `TextPromptDialog` `:142-200`)

```tsx
"use client";
import { useEffect, useRef, useState } from "react";
import { SETTLE_METHODS, forbidsLevelResult, settleApplies, type MatchOutcome, type SettleMethod } from "@seazn/engine/core";
import type { Msg } from "@/lib/i18n-runtime";

type LedgerRow = { id: string; type: string; voids_event_id: string | null };

/** An abandon no row voids — the kernel's `abandonActive` (voids are not voidable, core/events.ts:176-213). */
export function hasActiveAbandon(events: readonly LedgerRow[]): boolean {
  return events.some((e) => e.type === "core.abandon" && !events.some((v) => v.voids_event_id === e.id));
}

/** Controller ruling C12: bracket kind AND the kernel's own settle precondition, fed the same facts. */
export function needsDecision(
  module: { awaitingDecider?(state: never): boolean },
  f: { outcome: unknown; state: unknown; stageKind: string | null; events: readonly LedgerRow[] },
): boolean {
  if (!forbidsLevelResult(f.stageKind)) return false;
  return settleApplies(module, { outcome: f.outcome as MatchOutcome | null, abandoned: hasActiveAbandon(f.events), state: f.state });
}

export const confirmBlocked = (s: { winner: string | null; method: string | null; sending: boolean }): boolean =>
  s.winner === null || s.method === null || s.sending;

export const finalizeVisible = (s: { decided: boolean; held: boolean }): boolean => s.decided && !s.held;

const METHOD_KEY: Record<SettleMethod, string> = {
  lot: "score.needsDecision.method.lot",
  higher_seed: "score.needsDecision.method.higherSeed",
  organiser: "score.needsDecision.method.organiser",
};

export function NeedsDecisionBlock(props: {
  msg: Msg;
  home: { id: string; name: string };
  away: { id: string; name: string };
  busy: boolean;
  send: (type: string, payload: unknown) => Promise<{ ok: true } | { ok: false; message: string }>;
}) {
  const [open, setOpen] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null); // spec §7: the dialog closes and the reason shows here
  return (
    <section data-testid="needs-decision" role="status" className="rounded-2xl border border-amber-300 bg-amber-50 p-4">
      <h2 className="text-sm font-semibold text-amber-900">{props.msg("score.needsDecision.title")}</h2>
      <p className="mt-1 text-sm text-amber-900/80">{props.msg("score.needsDecision.body")}</p>
      {refusal !== null && <p data-testid="settle-error" role="alert" className="mt-2 text-sm text-red-700">{refusal}</p>}
      <button type="button" data-testid="settle-open" disabled={props.busy} onClick={() => { setRefusal(null); setOpen(true); }} className="btn btn-primary mt-3 min-h-11 w-full sm:w-auto">
        {props.msg("score.needsDecision.settle")}
      </button>
      {open && <SettleDialog {...props} onClose={() => setOpen(false)} onRefused={(m) => { setRefusal(m); setOpen(false); }} />}
    </section>
  );
}

function SettleDialog(props: Parameters<typeof NeedsDecisionBlock>[0] & { onClose: () => void; onRefused: (message: string) => void }) {
  const { msg } = props;
  const [winner, setWinner] = useState<string | null>(null);
  const [method, setMethod] = useState<SettleMethod | null>(null);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false); // Review Focus 2: the confirm disables on the FIRST tap
  const sendingRef = useRef(false); // the synchronous guard: a dblclick lands before React re-renders `sending`
  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;
  const ref = useRef<HTMLDivElement>(null);
  // Preflight C23: focus ONCE on mount (re-running it on every render stole focus from the note field) …
  useEffect(() => { ref.current?.querySelector<HTMLElement>("button")?.focus(); }, []);
  // … and the Escape handler is bound once, reading the live values through refs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !sendingRef.current) { e.stopPropagation(); onCloseRef.current(); } };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);
  const confirm = async () => {
    if (confirmBlocked({ winner, method, sending: sendingRef.current })) return;
    sendingRef.current = true;
    setSending(true);
    const r = await props.send("core.settle", { winner, method, ...(note.trim() ? { note: note.trim() } : {}) });
    sendingRef.current = false;
    if (r.ok) props.onClose();
    else props.onRefused(r.message);
  };
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-purple-950/30 p-0 backdrop-blur-sm sm:items-center sm:p-4" onPointerDown={(e) => { if (e.target === e.currentTarget && !sending) props.onClose(); }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="settle-title" className="w-full max-w-md rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl">
        <h2 id="settle-title" className="text-base font-semibold text-slate-900">{msg("score.needsDecision.dialogTitle")}</h2>
        <fieldset className="mt-4">
          <legend className="text-xs font-semibold uppercase tracking-[0.09em] text-slate-600">{msg("score.needsDecision.whoAdvances")}</legend>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {[props.home, props.away].map((e) => (
              <button key={e.id} type="button" data-testid={`settle-winner-${e.id}`} aria-pressed={winner === e.id} onClick={() => setWinner(e.id)}
                className={`btn min-h-12 min-w-0 justify-start ${winner === e.id ? "btn-primary" : "btn-ghost"}`}>
                <span className="truncate">{e.name}</span>
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset className="mt-4">
          <legend className="text-xs font-semibold uppercase tracking-[0.09em] text-slate-600">{msg("score.needsDecision.why")}</legend>
          <div className="mt-2 grid gap-1">
            {SETTLE_METHODS.map((m) => (
              <label key={m} className="flex min-h-11 items-center gap-3 rounded-lg px-2 hover:bg-slate-50">
                <input type="radio" name="settle-method" data-testid={`settle-method-${m}`} checked={method === m} onChange={() => setMethod(m)} />
                <span className="text-sm text-slate-800">{msg(METHOD_KEY[m] as never)}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <label className="mt-4 block">
          <span className="text-xs font-semibold uppercase tracking-[0.09em] text-slate-600">{msg("score.needsDecision.note")}</span>
          <input data-testid="settle-note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} className="input mt-1 w-full" />
        </label>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" disabled={sending} onClick={props.onClose} className="btn btn-ghost min-h-11">{msg("common.cancel")}</button>
          <button type="button" data-testid="settle-confirm" disabled={confirmBlocked({ winner, method, sending })} onClick={() => void confirm()} className="btn btn-primary min-h-11">
            {msg("score.needsDecision.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
```

The executor confirms that `Msg`'s import path, the `input` class and `common.cancel` exist (`fixture-console.tsx`'s own imports and its `TextPromptDialog` buttons) and conforms to them.

In `fixture-console.tsx`:
- resolve the module once, defensively, the way `resolvePadSpecForMount` already does (`:436`): `const settleModule = useMemo(() => { try { return resolveModuleClient(sport.key, scorePadV2?.moduleVersion ?? ""); } catch { return {}; } }, [sport.key, scorePadV2?.moduleVersion]);` — an unresolvable pin falls back to "no pending-decider hook", which can only hide the block in phase tiebreak, never show it wrongly;
- compute `const held = needsDecision(settleModule, { outcome: live.outcome, state: live.state, stageKind, events })` (`events` is the console's ledger, `:507`; `live.outcome` is the server's `outcomeOf`);
- render `{canOrganise && held && <NeedsDecisionBlock … />}` above `data-role="match-actions"`;
- change `{decided && (` to `{finalizeVisible({ decided, held }) && (` for Finalize and Share;
- wrap `ForfeitButton` and Abandon in `canOrganise &&`.

The console's `send` already returns the refusal. Adapt it to `{ ok, message }` with `ENGINE_ERROR_KEY` (`scoring-vocab.ts:583`), so the dialog shows the localized `engineError.SETTLE_NOT_APPLICABLE`.

The page passes `canOrganise={canEdit}` (owner/admin, `page.tsx:59`) and `stageKind`, which the page already loads via `loadFixturePadCfg`'s `{ stageKind }` (Task 6).

`stages-panel.tsx` run-sheet row: when the row's status is `needs_decision`, show a chip `msg("score.status.needs_decision")` in the attention tone the desk already uses for red attention (competition-desk `_RULES.md`: attention outranks phase on a pill).

- [ ] **Step 3: Strings, all 4 locales** (`ui.json`), then `pnpm i18n:gen-keys && pnpm i18n:check`

| key | en | fr | es | nl |
|---|---|---|---|---|
| `score.needsDecision.title` | Needs a decision | Décision requise | Requiere una decisión | Beslissing nodig |
| `score.needsDecision.body` | A knockout match can't end level. Choose who advances. | Un match à élimination directe ne peut pas finir à égalité. Choisissez qui se qualifie. | Un partido eliminatorio no puede terminar en empate. Elige quién avanza. | Een knock-outwedstrijd kan niet gelijk eindigen. Kies wie doorgaat. |
| `score.needsDecision.settle` | Settle the match | Trancher le match | Resolver el partido | Wedstrijd beslissen |
| `score.needsDecision.dialogTitle` | Settle the match | Trancher le match | Resolver el partido | Wedstrijd beslissen |
| `score.needsDecision.whoAdvances` | Who advances? | Qui se qualifie ? | ¿Quién avanza? | Wie gaat door? |
| `score.needsDecision.why` | Why? | Pourquoi ? | ¿Por qué? | Waarom? |
| `score.needsDecision.method.lot` | Drawn by lot | Tirage au sort | Por sorteo | Door loting |
| `score.needsDecision.method.higherSeed` | Higher seed / higher group finisher | Meilleure tête de série / mieux classé en poule | Mejor cabeza de serie / mejor clasificado de grupo | Hoogst geplaatst / hoogst geëindigd in de groep |
| `score.needsDecision.method.organiser` | Organiser decision | Décision de l'organisateur | Decisión del organizador | Beslissing van de organisator |
| `score.needsDecision.note` | Note (optional) | Note (facultatif) | Nota (opcional) | Notitie (optioneel) |
| `score.needsDecision.confirm` | Confirm | Confirmer | Confirmar | Bevestigen |
| `score.status.needs_decision` | Needs a decision | Décision requise | Requiere una decisión | Beslissing nodig |

Expected: `EXIT=0` from both, and the `i18n-keys.ts` diff is exactly these 12 keys.

- [ ] **Step 4: The e2e spec (console part)** — `apps/web/e2e/bracket-finish.spec.ts`

```ts
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { TAG, apiJson, addEntrantsViaApi, createStageAndGenerate, fixturePath, screenshotAtWidths, expectNoHorizontalScroll } from "./helpers";
import { builtinModules } from "@seazn/engine/sports";

// W2a spec §9: settle on the console; generic brackets without Draw; the chess tie-break on the pad (Task 12).
// Whole file, never a -g slice (R18).

interface Fx { id: string; home_entrant_id: string | null; away_entrant_id: string | null; winner_to_fixture: string | null; status: string; outcome: { kind: string; winner?: string; method?: string } | null }
const read = async (r: APIRequestContext, id: string) => (await apiJson<Fx>(r, `/api/v1/fixtures/${id}`)).data!;
const tip = async (r: APIRequestContext, id: string) => (await apiJson<{ last_seq: number }>(r, `/api/v1/fixtures/${id}/state`)).data!.last_seq;
const post = async (r: APIRequestContext, id: string, type: string, payload: unknown = {}) => apiJson(r, `/api/v1/fixtures/${id}/events`, "POST", { expected_seq: await tip(r, id), type, payload });

async function knockout(r: APIRequestContext, sport: string, variant: string, names = ["W2a Ana", "W2a Ben", "W2a Cy", "W2a Di"]) {
  // Preflight C14: the variant is one the sport declares (module.variants), never a guessed literal.
  expect(Object.keys(builtinModules.find((m) => m.key === sport)?.variants ?? {}), `${sport} declares ${variant}`).toContain(variant);
  const comp = await apiJson<{ id: string }>(r, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `W2a ${sport} ${TAG}-${Math.random().toString(36).slice(2, 6)}`, visibility: "private" });
  const div = await apiJson<{ id: string }>(r, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", { name: "Cup", sport_key: sport, variant_key: variant });
  await addEntrantsViaApi(r, div.data!.id, names);
  const { fixtureIds } = await createStageAndGenerate(r, div.data!.id, { kind: "knockout", name: "Cup" });
  expect((await apiJson(r, `/api/v1/divisions/${div.data!.id}/start`, "POST")).status).toBeLessThan(300);
  const all = await Promise.all(fixtureIds.map((id) => read(r, id)));
  const sf = all.find((f) => f.home_entrant_id && f.away_entrant_id)!;
  return { divisionId: div.data!.id, sf };
}

/** Settle POSTs the page itself sends (preflight C23: count requests, not ledger rows a retry could merge). */
function countSettlePosts(page: Page): () => number {
  let n = 0;
  page.on("request", (req) => { if (req.method() === "POST" && /\/fixtures\/[^/]+\/events$/.test(new URL(req.url()).pathname) && (req.postData() ?? "").includes('"core.settle"')) n++; });
  return () => n;
}

/** The same seeding as `knockout`, with a league stage: the positive pairs for "Draw hidden in brackets". */
async function league(r: APIRequestContext, sport: string, variant: string) {
  expect(Object.keys(builtinModules.find((m) => m.key === sport)?.variants ?? {}), `${sport} declares ${variant}`).toContain(variant);
  const comp = await apiJson<{ id: string }>(r, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `W2a lg ${sport} ${TAG}-${Math.random().toString(36).slice(2, 6)}`, visibility: "private" });
  const div = await apiJson<{ id: string }>(r, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", { name: "League", sport_key: sport, variant_key: variant });
  await addEntrantsViaApi(r, div.data!.id, ["W2a Lee", "W2a Max"]);
  const { fixtureIds } = await createStageAndGenerate(r, div.data!.id, { kind: "league", name: "League" });
  expect((await apiJson(r, `/api/v1/divisions/${div.data!.id}/start`, "POST")).status).toBeLessThan(300);
  return { sf: await read(r, fixtureIds[0]!) };
}

test("X-BR-2 (C18): a level football knockout RESULT (no abandon) is held — needs_decision, and the block shows", async ({ page, request }) => {
  const { sf } = await knockout(request, "football", "11-a-side");
  await post(request, sf.id, "core.start");
  // The same pinned stream as Task 8 Step 1's X-BR-2 case: full time level, no extra time, no shootout.
  await post(request, sf.id, "football.period.end", {});
  expect((await read(request, sf.id)).status).toBe("needs_decision");
  await page.goto(await fixturePath(request, sf.id));
  await expect(page.getByTestId("needs-decision")).toBeVisible();
  await expect(page.getByTestId("score-finalize")).toHaveCount(0); // finding 27
});

test("settle on the console: an ABANDONED level football knockout shows the block, and settle seats the winner", async ({ page, request }) => {
  const { sf } = await knockout(request, "football", "11-a-side");
  await post(request, sf.id, "core.start");
  await post(request, sf.id, "core.abandon", { reason: "floodlights" }); // a level abandon: no_result (finding 19)
  await page.goto(await fixturePath(request, sf.id));
  const block = page.getByTestId("needs-decision");
  await expect(block).toBeVisible();
  await expect(page.getByTestId("score-finalize")).toHaveCount(0); // finding 27
  await page.getByTestId("settle-open").click();
  const dialog = page.getByRole("dialog");
  await expect(page.getByTestId("settle-confirm")).toBeDisabled(); // nothing chosen yet: pin what it OPENS AT
  await dialog.getByTestId(`settle-winner-${sf.away_entrant_id}`).click();
  await dialog.getByTestId("settle-method-lot").check();
  await page.getByTestId("settle-confirm").click();
  await expect(block).toHaveCount(0);
  const after = await read(request, sf.id);
  expect(after.status).toBe("decided");
  expect(after.outcome).toMatchObject({ kind: "win", winner: sf.away_entrant_id, method: "settled_lot" });
  await expect.poll(async () => { const f = await read(request, sf.winner_to_fixture!); return [f.home_entrant_id, f.away_entrant_id]; }).toContain(sf.away_entrant_id);
});

test("Review Focus 2: a double submit of the settle dialog sends one settle", async ({ page, request }) => {
  const { sf } = await knockout(request, "generic", "score");
  await post(request, sf.id, "core.start");
  await post(request, sf.id, "core.abandon", { reason: "rain" });
  const settlePosts = countSettlePosts(page);
  await page.goto(await fixturePath(request, sf.id));
  await page.getByTestId("settle-open").click();
  await page.getByTestId(`settle-winner-${sf.home_entrant_id}`).click();
  await page.getByTestId("settle-method-organiser").check();
  await page.getByTestId("settle-confirm").dblclick();
  await expect(page.getByTestId("needs-decision")).toHaveCount(0);
  expect(settlePosts()).toBe(1); // the page SENT one settle, not "the server kept one"
  const events = (await apiJson<{ type: string }[]>(request, `/api/v1/fixtures/${sf.id}/events`)).data!;
  expect(events.filter((e) => e.type === "core.settle")).toHaveLength(1);
});

test("a refused settle closes the dialog, shows its reason, and changes nothing; the remaining entrant then settles (spec §7; ruling C17)", async ({ page, request }) => {
  // Deterministic (preflight C23): the refusal is a real server one that cannot race the live poll — the named
  // winner has withdrawn before the page loads (ruling C17: SETTLE_NOT_APPLICABLE, reason withdrawn).
  const { sf } = await knockout(request, "generic", "score");
  await post(request, sf.id, "core.start");
  await post(request, sf.id, "core.abandon", { reason: "rain" });
  expect((await apiJson(request, `/api/v1/entrants/${sf.away_entrant_id}/withdraw`, "POST")).status).toBeLessThan(300);
  await page.goto(await fixturePath(request, sf.id));
  await page.getByTestId("settle-open").click();
  await page.getByTestId(`settle-winner-${sf.away_entrant_id}`).click();
  await page.getByTestId("settle-method-lot").check();
  await page.getByTestId("settle-confirm").click();
  await expect(page.getByRole("dialog")).toHaveCount(0); // the dialog closed
  await expect(page.getByTestId("settle-error")).toBeVisible(); // and the reason shows in the block
  await expect(page.getByTestId("needs-decision")).toBeVisible();
  const before = await read(request, sf.id);
  expect(before.status).toBe("abandoned");
  expect(before.outcome?.kind).not.toBe("win");
  // The positive pair: a settle for the remaining entrant is accepted and seats them.
  await page.getByTestId("settle-open").click();
  await page.getByTestId(`settle-winner-${sf.home_entrant_id}`).click();
  await page.getByTestId("settle-method-organiser").check();
  await page.getByTestId("settle-confirm").click();
  await expect(page.getByTestId("needs-decision")).toHaveCount(0);
  expect((await read(request, sf.id)).outcome).toMatchObject({ kind: "win", winner: sf.home_entrant_id, method: "settled_organiser" });
});

test("finding 11: on a held fixture the organiser sees Settle; an official scorer sees the fixture and its status but no Settle, Forfeit or Abandon", async ({ browser, page, request }) => {
  const { sf } = await knockout(request, "football", "11-a-side");
  await post(request, sf.id, "core.start");
  await post(request, sf.id, "football.period.end", {}); // held: the C18 stream
  const path = await fixturePath(request, sf.id);
  // Positive pair (preflight C23): the organiser, on the same fixture, does see the block.
  await page.goto(path);
  await expect(page.getByTestId("needs-decision")).toBeVisible();
  const official = await browser.newContext({ storageState: "e2e/.auth/official.json" });
  const p = await official.newPage();
  await p.goto(path);
  await expect(p.getByText("Needs a decision", { exact: true })).toBeVisible(); // the status badge: the official sees the held fixture
  await expect(p.getByTestId("needs-decision")).toHaveCount(0);
  await expect(p.getByTestId("settle-open")).toHaveCount(0);
  await expect(p.getByTestId("score-forfeit")).toHaveCount(0);
  await expect(p.getByRole("button", { name: "Abandon" })).toHaveCount(0);
  await official.close();
});

test("the block at 1280, 768 and 320: no horizontal scroll, long names truncate", async ({ page, request }) => {
  // A realistic 43-character entrant name (AGENTS.md: the truncate defect showed only with one).
  const LONG = ["W2a Maximiliana Konstantinopoulou-Grunewald", "W2a Bartholomew Featherstonehaugh-Wolfeschl", "W2a Cy", "W2a Di"];
  expect(LONG.slice(0, 2).map((n) => n.length)).toEqual([43, 43]);
  const { sf } = await knockout(request, "generic", "score", LONG);
  await post(request, sf.id, "core.start");
  await post(request, sf.id, "core.abandon", { reason: "rain" });
  await page.goto(await fixturePath(request, sf.id));
  await page.getByTestId("settle-open").click();
  let widths = 0;
  for (const w of [1280, 768, 320]) {
    await page.setViewportSize({ width: w, height: 900 });
    await expectNoHorizontalScroll(page);
    for (const id of [sf.home_entrant_id!, sf.away_entrant_id!]) {
      const box = await page.getByTestId(`settle-winner-${id}`).boundingBox();
      expect(box, `${w} ${id}`).not.toBeNull();
      expect(box!.x + box!.width, `${w}: the winner button stays inside the viewport`).toBeLessThanOrEqual(w);
    }
    widths++;
  }
  expect(widths).toBe(3);
  await screenshotAtWidths(page, "w2a-settle-dialog", [1280, 768, 320]);
});
```

The official-scorer storage state is pinned from how the existing e2e logs in a non-editor (`grep -arn "storageState" apps/web/e2e/*.ts | head`). If the suite has no official login, the official case instead drives the API with an official's session cookie, as `scorers` e2e does. The `/events` list route is pinned from `api-v1` (`grep -arn "fixtures/:id/events\|events\" " apps/web/src/app/api/v1 | head`).

- [ ] **Step 5: Run the unit test and the whole spec file against the rebuilt w2a server**

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a/apps/web && rm -f "$TMPDIR/w2a-t11.json" && pnpm vitest run src/components/v2/__tests__/needs-decision.test.tsx --reporter=json --outputFile="$TMPDIR/w2a-t11.json"; echo EXIT=$?
S=~/.claude/skills/seazn-local-env/scripts/seazn-env.sh; cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a && $S rebuild --label w2a > "$TMPDIR/w2a-rebuild.log" 2>&1; echo EXIT=$?
S=~/.claude/skills/seazn-local-env/scripts/seazn-env.sh; cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a/apps/web && eval "$($S env --label w2a)" && PLAYWRIGHT_BASE="$SMOKE_BASE" E2E_PROD_TARGET=1 npx playwright test --project=parallel e2e/bracket-finish.spec.ts --reporter=json > "$TMPDIR/w2a-t11-e2e.json" 2>"$TMPDIR/w2a-t11-e2e.err"; echo EXIT=$?; jq -c '.stats' "$TMPDIR/w2a-t11-e2e.json"
```

Expected: `EXIT=0` three times; `stats.expected` = 6, `unexpected` 0 and `skipped` 0.

- [ ] **Step 6: Visual verdict per screen (R24)**
  - Open the screenshots with the Read tool, cropped to the dialog (memory: full-page screenshots dominate context).
  - Write one verdict line per width for the block and for the dialog: alignment, text size, tap targets of 44px or more, truncation, and no overflow.
  - Then the control-set diff at 320 against 1280: membership, order and repeats of the dialog's controls. Write it down; never infer it.
  - These built screens go to the owner for a per-screen verdict before merge (ruling 82; Task 17 Step 3).

- [ ] **Step 7: Mutate (runner)** — `MUT/t11.json`

| id | find → replace | killer |
|---|---|---|
Every row is a vitest killer in `needs-decision.test.tsx` (`cwd: "apps/web"`). The e2e specs re-prove the wiring in Step 5, but no e2e or smoke row appears in a `MUT/*.json` (preflight C1; the runner refuses a killer with no `files`).

| id | find → replace | killer |
|---|---|---|
| `kind-gate` | `if (!forbidsLevelResult(f.stageKind)) return false;` → `` | "a level outcome needs a decision in every bracket kind, and never outside brackets" |
| `active-abandon` | `!events.some((v) => v.voids_event_id === e.id)` → `true` | "the generator's void … and a voided abandon need nothing …" |
| `decider-hook` | `return settleApplies(module, {` → `return settleApplies({}, {` | "C12: a chess knockout in phase tiebreak …" |
| `double-submit` | `s.winner === null \|\| s.method === null \|\| s.sending;` → `s.winner === null \|\| s.method === null;` | "confirmBlocked: blocked until …" (the sending row) |
| `finalize-hidden` | `s.decided && !s.held;` → `s.decided;` | "finalizeVisible: Finalize shows …" |

Expected: `EXIT=0`, 5 rows `KILLED`.

**Four test types:**
- Unit: Step 1.
- E2E: Steps 4–5.
- Smoke: Task 17's `bracketFinishSuite` (the console's settle endpoint path).
- Regression: the spec file, kept.

---

### Task 12: The pad learns its stage kind; Draw hidden in brackets; the chess three-step tie-break (spec §5.5; D6; finding 22–23)

**Loop H, continued.**

**Files:**
- Modify: `W/server/usecases/fidelity.ts:44-70` (`ScorePadBootstrap` gains `stageKind: string | null`), `W/components/v2/scorepad/registry.tsx:183`, `:198`, `:294-296`, `W/components/v2/scorepad/v3/types.ts:1400` (`PadHostView.stageKind`), and the two pages that build the bootstrap (`f/[no]/page.tsx:181`, `score/[token]/page.tsx:331`)
- Modify: `W/components/v2/scorepad/v3/skins/generic.tsx:176` (`allowsDraws(cfg, stageKind)`) and its four readers
- Modify: `W/components/v2/scorepad/v3/skins/boardgame.tsx:230-235`, `:361-411`, `:463-465` (the tie-break tile and sheet; Draw and halves inert while `readPhase === "tiebreak"`)
- Modify: `W/dictionaries/{en,fr,es,nl}/ui.json` (`pad.boardgame.tiebreak.*`). No `pad.generic.knockoutNoDraw`: the generic pad hides Draw silently, so no string renders (preflight C26 — the key was listed with no value and no reader)
- Create: `W/components/v2/scorepad/v3/__tests__/boardgame-tiebreak.test.ts`, `W/components/v2/scorepad/v3/__tests__/bracket-no-draw.test.ts`
- Modify: `apps/web/e2e/bracket-finish.spec.ts` (pad part), `apps/web/e2e/mobile.spec.ts` (the boardgame tie-break describe across the width projects)

**Interfaces:**
- Consumes: `TIEBREAK_RUNGS`, `BOARDGAME_TIEBREAK_TYPE`, `CHESS_SCORE` (Task 5); `loadFixturePadCfg → { cfg, stageKind }` (Task 6).
- Produces:
  - `PadHostView.stageKind: string | null`;
  - `TIEBREAK_TILE_ID = "tiebreak"`;
  - sheet steps `rung` → `winner` → `score`, with `when` predicates;
  - NO new testids (preflight C24). Tests select with the chassis's real attributes: `[data-tile-id="<id>"]` (`tile-grid.tsx:293`) and `[data-choice-option-id="<id>"]` (`guided-sheet.tsx:418`). The only sheet testids are `pad-sheet-number` and `pad-sheet-confirm` (`guided-sheet.tsx:523`, `:549`).

- [ ] **Step 1: The failing skin tests**

`bracket-no-draw.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { BRACKET_KINDS, StageKind } from "@seazn/engine/core";
import { buildTiles as bgTiles, DRAW_TILE_ID } from "../skins/boardgame";
import { buildTiles as genericTiles } from "../skins/generic";
import { liveView } from "./helpers/views"; // the existing helper that builds a PadHostView for a sport (executor pins its name in __tests__/)

describe("Draw is hidden in bracket kinds (spec §5.5; X-DR-1, GN-KO-1)", () => {
  it("empty case first: with no stage kind (a pre-W2a bootstrap) the pad behaves as today", () => {
    expect(bgTiles(liveView("boardgame", { stageKind: null }), (k) => k).some((t) => t.id === DRAW_TILE_ID)).toBe(true);
  });
  it("boardgame: Draw shows exactly outside bracket kinds", () => {
    let checked = 0;
    for (const k of StageKind.options) {
      expect(bgTiles(liveView("boardgame", { stageKind: k }), (x) => x).some((t) => t.id === DRAW_TILE_ID), k).toBe(!BRACKET_KINDS.has(k));
      checked++;
    }
    expect(checked).toBe(StageKind.options.length);
  });
  it("generic (allowDraws true): no draw control in any bracket kind; present in league", () => {
    let checked = 0;
    for (const k of StageKind.options) {
      const tiles = genericTiles(liveView("generic", { stageKind: k, cfg: { resultMode: "score", allowDraws: true } }), (x) => x);
      const hasDraw = tiles.some((t) => /draw/i.test(t.id));
      expect(hasDraw, k).toBe(!BRACKET_KINDS.has(k));
      checked++;
    }
    expect(checked).toBe(StageKind.options.length);
  });
});
```

`boardgame-tiebreak.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { TIEBREAK_RUNGS, boardgame } from "@seazn/engine/sports/boardgame";
import { foldMatch } from "@seazn/engine/core";
import { buildScorebug, buildSheets, buildTiles, DRAW_TILE_ID, TIEBREAK_TILE_ID } from "../skins/boardgame";
import { liveView } from "./helpers/views";

const tiebreakView = () => liveView("boardgame", { stageKind: "knockout", cfg: { tiebreak: true }, statePatch: { phase: "tiebreak", tiebreak: {} } });
const winnerKey = (rung: string) => (rung === "armageddon" ? "winner-armageddon" : "winner");

describe("the chess three-step tie-break on the pad (spec §5.5, BG-KO-1, BG-KO-2 per ruling 82, D6)", () => {
  it("empty case first: in phase live there is no tie-break tile", () => {
    expect(buildTiles(liveView("boardgame", { stageKind: "knockout", cfg: { tiebreak: true } }), (k) => k).some((t) => t.id === TIEBREAK_TILE_ID)).toBe(false);
  });
  it("in phase tiebreak: only the tie-break tile; Draw is gone and the halves are not tappable", () => {
    const v = tiebreakView();
    expect(buildTiles(v, (k) => k).map((t) => t.id)).toEqual([TIEBREAK_TILE_ID]);
    expect(buildTiles(v, (k) => k).some((t) => t.id === DRAW_TILE_ID)).toBe(false);
    expect(buildScorebug(v, (k) => k).halves.every((h) => !h.tappable)).toBe(true);
  });
  it("step 1 offers exactly the engine's rungs, and says lots is the organiser's", () => {
    const sheet = buildSheets(tiebreakView(), (k) => k)[TIEBREAK_TILE_ID]!;
    const rung = sheet.steps.find((s) => s.id === "rung")!;
    expect(rung.kind === "choice" && rung.options.map((o) => o.id)).toEqual([...TIEBREAK_RUNGS]);
    expect(rung.kind === "choice" && rung.hintKey).toBe("pad.boardgame.tiebreak.lotsHint");
  });
  it("the tie-break sheet never offers settle or lots (X-ST-2: settle is the organiser's, on the console; preflight C21)", () => {
    const v = tiebreakView();
    const ids = [
      ...buildTiles(v, (k) => k).map((t) => t.id),
      ...Object.values(buildSheets(v, (k) => k)).flatMap((sh) => sh.steps.flatMap((st) => (st.kind === "choice" ? st.options.map((o) => o.id) : []))),
    ];
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.filter((id) => /settle|\blots?\b/i.test(id))).toEqual([]);
  });
  it("BG-KO-2 (ruling 82): every rung shows ONE winner step with exactly the two entrants; the 'draw means Black advances' hint is on armageddon only", () => {
    const sheet = buildSheets(tiebreakView(), (k) => k)[TIEBREAK_TILE_ID]!;
    let checked = 0;
    for (const rung of TIEBREAK_RUNGS) {
      const shown = sheet.steps.filter((s) => s.id.startsWith("winner") && (s.when?.({ rung }) ?? true));
      expect(shown, rung).toHaveLength(1);
      const step = shown[0]!;
      expect(step.kind === "choice" && step.options.map((o) => o.id), rung).toEqual(["home", "away"]); // no third "drawn" choice
      expect(step.kind === "choice" && step.hintKey === "pad.boardgame.tiebreak.armageddonHint", rung).toBe(rung === "armageddon");
      checked++;
    }
    expect(checked).toBe(TIEBREAK_RUNGS.length);
    expect(sheet.buildPayload({ rung: "armageddon", "winner-armageddon": "away" })).toEqual({ rung: "armageddon", winner: "A" });
    expect(sheet.buildPayload({ rung: "armageddon", "winner-armageddon": "home" })).toEqual({ rung: "armageddon", winner: "H" });
  });
  it("the score step shows for rapid and blitz only, and each offered score is a valid chess score oriented to the winner", () => {
    const sheet = buildSheets(tiebreakView(), (k) => k)[TIEBREAK_TILE_ID]!;
    const score = sheet.steps.find((s) => s.id === "score")!;
    let checked = 0;
    for (const rung of TIEBREAK_RUNGS) {
      expect(score.when?.({ rung, winner: "home" }) ?? true, rung).toBe(rung !== "armageddon");
      checked++;
    }
    expect(checked).toBe(3);
    const p = sheet.buildPayload({ rung: "rapid", winner: "away", score: "1½–½" });
    expect(p).toEqual({ rung: "rapid", winner: "A", score: "1½–½" });
    expect(sheet.buildPayload({ rung: "rapid", winner: "away", score: "none" })).toEqual({ rung: "rapid", winner: "A" });
  });
  it("the seam: every payload the sheet can build folds through the REAL engine to a win (class 1)", () => {
    let checked = 0;
    const sheet = buildSheets(tiebreakView(), (k) => k)[TIEBREAK_TILE_ID]!;
    const cfg = boardgame.configSchema.parse({ tiebreak: true });
    const lineups = { home: { entrantId: "H", members: [] }, away: { entrantId: "A", members: [] } } as never;
    for (const rung of TIEBREAK_RUNGS) for (const winner of ["home", "away"]) for (const score of rung === "armageddon" ? [undefined] : ["none", "2–0", "1½–½"]) {
      const payload = sheet.buildPayload({ rung, [winnerKey(rung)]: winner, ...(score ? { score } : {}) });
      const s = foldMatch(boardgame, cfg, lineups, [
        { id: "e1", seq: 1, type: "core.start", payload: {}, recordedAt: "2026-10-08T00:00:00Z", recordedBy: null },
        { id: "e2", seq: 2, type: "boardgame.result", payload: { winner: null, method: "agreement" }, recordedAt: "2026-10-08T00:00:00Z", recordedBy: null },
        { id: "e3", seq: 3, type: "boardgame.tiebreak", payload, recordedAt: "2026-10-08T00:00:00Z", recordedBy: null },
      ] as never);
      expect(boardgame.outcome(s), JSON.stringify(payload)).toMatchObject({ kind: "win", winner: winner === "home" ? "H" : "A", method: `tiebreak_${rung}` });
      checked++;
    }
    expect(checked).toBe(2 * 3 + 2 * 3 + 2); // rapid 6, blitz 6, armageddon 2
  });
});
```

The `liveView` helper and the sheet testids are pinned from the existing `v3/__tests__` helpers (`grep -arln "PadHostView" apps/web/src/components/v2/scorepad/v3/__tests__ | head`). If no shared helper exists, the executor adds `__tests__/helpers/views.ts` building a `PadHostView` from `{ sport, stageKind, cfg, statePatch }`, the engine's `init`, and the module's `configSchema`.

- [ ] **Step 2: Run them; see them fail**

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a/apps/web && rm -f "$TMPDIR/w2a-t12.json" && pnpm vitest run src/components/v2/scorepad/v3/__tests__/bracket-no-draw.test.ts src/components/v2/scorepad/v3/__tests__/boardgame-tiebreak.test.ts --reporter=json --outputFile="$TMPDIR/w2a-t12.json"; echo EXIT=$?
```

Expected: `EXIT=1`; `TIEBREAK_TILE_ID` is not exported, and `stageKind` is unknown.

- [ ] **Step 3: Thread the stage kind**
  - `ScorePadBootstrap` gains `stageKind: string | null`.
  - `resolveScorePadBootstrap(…, stageKind)` stores it.
  - Both pages pass the `stageKind` they got from `loadFixturePadCfg`.
  - `registry.tsx` copies it into `PadHostView.stageKind`.

  `tsc` lists every construction site of `PadHostView` (the test helpers included), and each gets `stageKind`.

- [ ] **Step 4: The skins**

`generic.tsx`:

```ts
/** … (existing doc kept) … W2a (X-DR-1, GN-KO-1): never in a bracket kind, whatever the cfg says. */
function allowsDraws(cfg: GenericCfgShape, stageKind: string | null): boolean {
  return cfg.allowDraws === true && !forbidsLevelResult(stageKind);
}
```

Each of the four readers (`:357`, `:380`, `:440`, `:506`) passes `view.stageKind`.

`boardgame.tsx`:

```ts
export const TIEBREAK_TILE_ID = "tiebreak";
const inTiebreak = (view: Pick<PadHostView, "state">) => readPhase(asState(view.state)) === "tiebreak";

// buildTiles: before the pairing/draw branches
  if (inTiebreak(view)) {
    if (withinBand(BOARDGAME_TIEBREAK_TYPE, view.band)) {
      tiles.push({ id: TIEBREAK_TILE_ID, label: "pad.boardgame.tiebreak.tile", kind: "standard", span: 4, phases: ["live"], action: { sheet: TIEBREAK_TILE_ID } });
    }
    return tiles;
  }
// the Draw tile's condition gains `&& !forbidsLevelResult(view.stageKind)`

// buildHalf: `tappable` gains `&& !inTiebreak(view)` (its existing `phase === "live"` test reads resolvePhase, which maps tiebreak to live)

function tiebreakSheet(view: PadHostView, t: TFn): GuidedSheetSpec {
  const state = asState(view.state);
  const nameOf = (side: Side) => view.personNames[entrantOf(state, side)] ?? t(SIDE_LABEL[side]);
  const winnerOptions = SIDES.map((side) => ({ id: side, label: nameOf(side) })); // always the two entrants (ruling 82)
  const SCORES = ["none", "2–0", "1½–½"] as const; // D6: oriented to the winner; the engine validates any CHESS_SCORE
  return {
    event: BOARDGAME_TIEBREAK_TYPE,
    steps: [
      { id: "rung", kind: "choice", title: "pad.boardgame.tiebreak.rung.title", hintKey: "pad.boardgame.tiebreak.lotsHint",
        options: TIEBREAK_RUNGS.map((r) => ({ id: r, label: t(`pad.boardgame.tiebreak.rung.${r}`) })) },
      { id: "winner", kind: "choice", title: "pad.boardgame.tiebreak.winner.title", when: (a) => a.rung !== "armageddon",
        options: winnerOptions },
      // BG-KO-2 in W2a (ruling 82): the scorer taps the winner; the hint says a drawn armageddon goes to Black.
      { id: "winner-armageddon", kind: "choice", title: "pad.boardgame.tiebreak.winner.title", hintKey: "pad.boardgame.tiebreak.armageddonHint", when: (a) => a.rung === "armageddon",
        options: winnerOptions },
      { id: "score", kind: "choice", title: "pad.boardgame.tiebreak.score.title", when: (a) => a.rung !== "armageddon",
        options: SCORES.map((s) => ({ id: s, label: s === "none" ? t("pad.boardgame.tiebreak.score.none") : s })) },
    ],
    buildPayload: (a) => {
      const side: Side = (a.winner ?? a["winner-armageddon"]) === "away" ? "away" : "home";
      return {
        rung: a.rung,
        winner: entrantOf(state, side),
        ...(a.score && a.score !== "none" ? { score: a.score } : {}),
      };
    },
  };
}
// buildSheets returns { [PAIRING_TILE_ID]: pairingSheet(view), [TIEBREAK_TILE_ID]: tiebreakSheet(view, t) }
```

Two winner steps, each gated by `when` on the rung, keep `SheetChoiceStep.options` a static array (`types.ts:685`), so the chassis needs no change. Back on each step is the chassis's existing `backStep`, so no skin code is needed for it either.

- [ ] **Step 5: Strings, 4 locales** (`ui.json`, `pad.boardgame.tiebreak.*`)

| key | en | fr | es | nl |
|---|---|---|---|---|
| `tile` | Tie-break | Départage | Desempate | Tiebreak |
| `rung.title` | Which tie-break decided it? | Quel départage a tranché ? | ¿Qué desempate lo decidió? | Welke tiebreak besliste? |
| `lotsHint` | Decided by lot? Ask the organiser to settle the match. | Tirage au sort ? Demandez à l'organisateur de trancher le match. | ¿Por sorteo? Pide al organizador que resuelva el partido. | Door loting? Vraag de organisator de wedstrijd te beslissen. |
| `rung.rapid` | Rapid | Rapide | Rápidas | Rapid |
| `rung.blitz` | Blitz | Blitz | Blitz | Snelschaak |
| `rung.armageddon` | Armageddon | Armageddon | Armagedón | Armageddon |
| `winner.title` | Who won the tie-break? | Qui a gagné le départage ? | ¿Quién ganó el desempate? | Wie won de tiebreak? |
| `armageddonHint` | In Armageddon a draw means Black advances. | À l'Armageddon, une nulle qualifie les Noirs. | En el Armagedón, unas tablas clasifican al negro. | Bij armageddon gaat zwart door bij remise. |
| `score.title` | Tie-break score (optional) | Score du départage (facultatif) | Resultado del desempate (opcional) | Tiebreakstand (optioneel) |
| `score.none` | No score | Pas de score | Sin resultado | Geen stand |

The step-2 title uses no rung name; the spec's "<rung>" interpolation is kept out because the chassis title is a bare key. Record this in the task report as a deviation from §5.5's wording, with the reason. Then run `pnpm i18n:gen-keys && pnpm i18n:check`, and expect `EXIT=0`.

- [ ] **Step 6: The e2e — the pad part of `bracket-finish.spec.ts`, plus the width projects**

Append to `bracket-finish.spec.ts`:

```ts
const tile = (page: Page, id: string) => page.locator(`[data-tile-id="${id}"]`); // tile-grid.tsx:293 (preflight C24)
const option = (page: Page, id: string) => page.locator(`[data-choice-option-id="${id}"]`); // guided-sheet.tsx:418

test("chess tie-break on the pad: BG-KO-2's hint shows on Armageddon only, and the tapped winner advances", async ({ page, request }) => {
  const { sf } = await knockout(request, "boardgame", "classical");
  await post(request, sf.id, "core.start");
  await post(request, sf.id, "boardgame.result", { winner: null, method: "agreement" });
  await page.goto(await fixturePath(request, sf.id));
  await expect(tile(page, "draw")).toHaveCount(0);
  await tile(page, "tiebreak").click();
  const hint = page.getByText("In Armageddon a draw means Black advances.");
  await option(page, "rapid").click();
  await expect(option(page, "home")).toBeVisible(); // the winner step is open
  await expect(hint).toHaveCount(0); // not on rapid (the positive pair follows)
  await page.getByRole("button", { name: "Back" }).click(); // pad.sheet.back
  await option(page, "blitz").click();
  await expect(option(page, "home")).toBeVisible();
  await expect(hint).toHaveCount(0); // not on blitz
  await page.getByRole("button", { name: "Back" }).click();
  await option(page, "armageddon").click();
  await expect(hint).toBeVisible();
  await expect(page.locator("[data-choice-option-id]")).toHaveCount(2); // exactly the two entrants; no "drawn" choice (ruling 82)
  await option(page, "away").click();
  await expect.poll(async () => (await read(request, sf.id)).outcome).toMatchObject({ kind: "win", winner: sf.away_entrant_id, method: "tiebreak_armageddon" });
});

test("the Draw tile's positive pair: a chess LEAGUE game shows Draw", async ({ page, request }) => {
  // Preflight C24: `draw` count 0 above is meaningful only if the same selector finds the tile where Draw is allowed.
  const { sf } = await league(request, "boardgame", "classical");
  await post(request, sf.id, "core.start");
  await page.goto(await fixturePath(request, sf.id));
  await expect(tile(page, "draw")).toBeVisible();
});

test("chess tie-break: Back on step 2 returns to step 1 and keeps nothing", async ({ page, request }) => {
  const { sf } = await knockout(request, "boardgame", "classical");
  await post(request, sf.id, "core.start");
  await post(request, sf.id, "boardgame.result", { winner: null, method: "agreement" });
  await page.goto(await fixturePath(request, sf.id));
  await tile(page, "tiebreak").click();
  await option(page, "rapid").click();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(option(page, "blitz")).toBeVisible();
  // Preflight C25 / ruling C12: in phase tiebreak the outcome is null, so the status rule gives in_play (never
  // needs_decision), and Back wrote nothing.
  expect((await read(request, sf.id)).status).toBe("in_play");
  const events = (await apiJson<{ type: string }[]>(request, `/api/v1/fixtures/${sf.id}/events`)).data!;
  expect(events.filter((e) => e.type === "boardgame.tiebreak")).toHaveLength(0);
  expect(events.length).toBe(2); // core.start and the drawn result, nothing more
});

test("generic bracket has no Draw on the pad; a generic league with allowDraws does (the positive pair)", async ({ page, request }) => {
  const { sf } = await knockout(request, "generic", "score"); // the `score` variant declares allowDraws: true
  await post(request, sf.id, "core.start");
  await page.goto(await fixturePath(request, sf.id));
  await expect(page.locator("[data-tile-id]").first()).toBeVisible(); // the pad rendered
  await expect(tile(page, "draw")).toHaveCount(0);
  const lg = await league(request, "generic", "score");
  await post(request, lg.sf.id, "core.start");
  await page.goto(await fixturePath(request, lg.sf.id));
  await expect(tile(page, "draw")).toBeVisible(); // preflight C26
});
```

In `mobile.spec.ts`, inside the existing per-width describe (serial; R18 / class 21), add a test that drives the drawn-knockout tie-break sheet at each project width. It asserts the sheet's three steps are reachable, that `expectNoHorizontalScroll` holds, and that the Armageddon step's option set at 320 equals the set at 1280 (membership and order). It reads options by `[data-choice-option-id]`, never by a testid (preflight C24).

Run the whole spec files:

```bash
S=~/.claude/skills/seazn-local-env/scripts/seazn-env.sh; cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a && $S rebuild --label w2a > "$TMPDIR/w2a-rebuild.log" 2>&1; echo EXIT=$?
S=~/.claude/skills/seazn-local-env/scripts/seazn-env.sh; cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a/apps/web && eval "$($S env --label w2a)" && PLAYWRIGHT_BASE="$SMOKE_BASE" E2E_PROD_TARGET=1 npx playwright test --project=parallel e2e/bracket-finish.spec.ts --reporter=json > "$TMPDIR/w2a-t12-e2e.json" 2>/dev/null; echo EXIT=$?; jq -c '.stats' "$TMPDIR/w2a-t12-e2e.json"
S=~/.claude/skills/seazn-local-env/scripts/seazn-env.sh; cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a/apps/web && eval "$($S env --label w2a)" && for p in mobile-320 mobile-se mobile-360 mobile-14 mobile-430 tablet-768 tablet-834; do PLAYWRIGHT_BASE="$SMOKE_BASE" E2E_PROD_TARGET=1 npx playwright test --project=$p e2e/mobile.spec.ts --reporter=json > "$TMPDIR/w2a-t12-$p.json" 2>/dev/null; echo "$p EXIT=$? $(jq -c '.stats|{expected,unexpected,skipped}' "$TMPDIR/w2a-t12-$p.json")"; done
```

Expected:
- `bracket-finish.spec.ts`: `stats.expected` 10 (6 from Task 11, 4 here), `unexpected` 0.
- Each width project: `EXIT=0`, `unexpected: 0`.

`mobile.spec.ts` is serial, so a red count is a floor: re-run after each fix until a full pass completes (class 21). Running seven projects one at a time is the whole spec file per project, not a `-g` slice.

- [ ] **Step 7: Visual verdicts, the control-set diff, and the owner's verdict** at 1280, 768 and 320 for:
  - the pad in phase tiebreak;
  - each sheet step, including the armageddon winner step with its hint;
  - the generic bracket pad.

  Write one verdict per screen; the phone pad's control-set diff is at 320 against 1280 (phone-composition section of AGENTS.md). The layout was chosen in brainstorming (UI-2 option B; ruling 82), so no options are shown. Before merge, the built house-styled screens go to the owner, and the owner's per-screen verdict is recorded (Task 17 Step 3 collects them).

- [ ] **Step 8: Mutate per rung and per guard (runner)** — `MUT/t12.json`

| id | find → replace | killer |
|---|---|---|
| `generic-kind` | `cfg.allowDraws === true && !forbidsLevelResult(stageKind)` → `cfg.allowDraws === true` | `bracket-no-draw.test.ts` "generic …" |
| `bg-draw-kind` | the Draw tile's `&& !forbidsLevelResult(view.stageKind)` → `` | "boardgame: Draw shows exactly outside bracket kinds" |
| `tiebreak-early-return` | `    return tiles;\n  }` (in the `inTiebreak` branch) → `  }` | "in phase tiebreak: only the tie-break tile …" |
| `halves-tappable` | `&& !inTiebreak(view)` → `` | the same test (halves) |
| `hint-everywhere` | `hintKey: "pad.boardgame.tiebreak.armageddonHint", when: (a) => a.rung === "armageddon"` → `hintKey: "pad.boardgame.tiebreak.armageddonHint", when: () => true` | "BG-KO-2 (ruling 82): every rung shows ONE winner step …" (two winner steps on rapid) |
| `hint-dropped` | `hintKey: "pad.boardgame.tiebreak.armageddonHint", ` → `` | the same test (armageddon's hint) |
| `armageddon-winner-dropped` | `(a.winner ?? a["winner-armageddon"])` → `a.winner` | the same test (`"winner-armageddon": "away"` posts H) |
| `winner-side-flip` | `=== "away" ? "away" : "home";` → `=== "away" ? "home" : "away";` | the seam test (winner) and "the score step …" |
| `score-armageddon` | `title: "pad.boardgame.tiebreak.score.title", when: (a) => a.rung !== "armageddon"` → `title: "pad.boardgame.tiebreak.score.title", when: () => true` | "the score step shows for rapid and blitz only …" |
| `score-none` | `a.score && a.score !== "none"` → `a.score` | "… score: 'none'" and the seam test (`score: "none"` fails `CHESS_SCORE` in the real fold) |

Expected: `EXIT=0`, 10 rows killed.

- [ ] **Step 9: BG-KO-2 proof bookkeeping (ruling 82).** Delete BG-KO-2 from `AWAITING_PROOF`, set its proved-by to `` `apps/web/src/components/v2/scorepad/v3/__tests__/boardgame-tiebreak.test.ts` ``, and run `rules-reference.test.ts` green.

**Four test types:**
- Unit: Steps 1–4.
- E2E: Step 6.
- Smoke: Task 17.
- Regression: the seam test and the mobile project.

---

### Task 13: Public sentences and the status line, 4 locales (spec §5.5, public surfaces; D5)

**Loop H, continued.**

**Files:**
- Modify: `W/lib/scoring-vocab.ts:1298-1303` (`DECIDED_METHOD_KEY` gains six methods, derived from `SETTLE_METHODS` and `TIEBREAK_RUNGS`), `:1400-1430` (`renderDecidedOutcome` threads the tie-break score)
- Modify: `W/server/public-site/match-centre.ts:175-176` (`WIN_METHODS`), `:722-760` (`resultMsg`: settled and tie-break lines)
- Modify: `W/components/public-site/bracket.tsx:121` (a held fixture shows "Needs a decision", never a winner)
- Modify: `W/dictionaries/{en,fr,es,nl}/ui.json` (`fixture.decidedBy.*`) and `public.json` (`matchCentre.result.*`, the status line)
- Create: `W/lib/__tests__/w2a-decided-sentences.test.ts`

**Interfaces:**
- Consumes: `SETTLE_METHODS`, `settledMethod` (Task 4); `TIEBREAK_RUNGS`, `summary().detail.tiebreak` (Task 5).
- Produces: `renderDecidedOutcome(outcome, names, templates, shootoutScore?, tiebreakScore?)`, where `tiebreakScore` is `string | null`, read from `detail.tiebreak.score`.

- [ ] **Step 1: The failing test**

```ts
import { describe, expect, it } from "vitest";
import { SETTLE_METHODS, settledMethod } from "@seazn/engine/core";
import { TIEBREAK_RUNGS } from "@seazn/engine/sports/boardgame";
import { decidedOutcomeTemplates, renderDecidedOutcome } from "@/lib/scoring-vocab";
import { loadDict } from "@/lib/__tests__/_dict"; // the existing per-locale dictionary loader used by the vocab tests

const LOCALES = ["en", "fr", "es", "nl"] as const;
const names = { A: "Ana", B: "Ben" };

describe("W2a public sentences (spec §5.5, D5): every method the engine declares has its own sentence, in every locale", () => {
  it("empty case first: no outcome renders nothing", () => {
    expect(renderDecidedOutcome(null, names, decidedOutcomeTemplates(loadDict("en")))).toBeNull();
  });
  it("each settle method and each tie-break rung renders a distinct, non-plain sentence naming the winner, in 4 locales", () => {
    let checked = 0;
    const methods = [...SETTLE_METHODS.map(settledMethod), ...TIEBREAK_RUNGS.map((r) => `tiebreak_${r}`)];
    for (const loc of LOCALES) {
      const t = decidedOutcomeTemplates(loadDict(loc));
      const plain = renderDecidedOutcome({ kind: "win", winner: "A", loser: "B" }, names, t);
      const seen = new Set<string>();
      for (const method of methods) {
        const s = renderDecidedOutcome({ kind: "win", winner: "A", loser: "B", method }, names, t)!;
        expect(s, `${loc} ${method}`).toContain("Ana");
        expect(s, `${loc} ${method}`).not.toBe(plain); // right answer differs from the fallback's constant
        expect(s, `${loc} ${method}`).not.toMatch(/settled_|tiebreak_/); // a raw token never leaks
        seen.add(s);
        checked++;
      }
      expect(seen.size, loc).toBe(methods.length);
    }
    expect(checked).toBe(LOCALES.length * 6);
  });
  it("the tie-break score appears when recorded, and no score is invented when it is not", () => {
    const t = decidedOutcomeTemplates(loadDict("en"));
    expect(renderDecidedOutcome({ kind: "win", winner: "A", loser: "B", method: "tiebreak_rapid" }, names, t, null, "1½–½")).toBe("Ana won on rapid tie-break (1½–½)");
    expect(renderDecidedOutcome({ kind: "win", winner: "A", loser: "B", method: "tiebreak_rapid" }, names, t, null, null)).toBe("Ana won on rapid tie-break");
    expect(renderDecidedOutcome({ kind: "win", winner: "A", loser: "B", method: "settled_lot" }, names, t)).toBe("Ana advanced on lot");
  });
});
```

`loadDict` is pinned from the existing vocab tests (`grep -arln "decidedOutcomeTemplates" apps/web/src/lib/__tests__ | head -2`), which already build a `MsgFn` per locale.

- [ ] **Step 2: Run; see it fail**

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a/apps/web && rm -f "$TMPDIR/w2a-t13.json" && pnpm vitest run src/lib/__tests__/w2a-decided-sentences.test.ts --reporter=json --outputFile="$TMPDIR/w2a-t13.json"; echo EXIT=$?
```

Expected: `EXIT=1`; each settled method falls back to `plain`.

- [ ] **Step 3: Implement**

```ts
import { SETTLE_METHODS, settledMethod } from "@seazn/engine/core";
import { TIEBREAK_RUNGS } from "@seazn/engine/sports/boardgame";

// D5: the six W2a methods are DERIVED from the engine's tuples, never typed again.
const camel = (s: string) => s.replace(/_(.)/g, (_, c: string) => c.toUpperCase());
const DECIDED_METHOD_KEY: Record<string, MessageKey> = {
  shootout: "fixture.decidedBy.shootout",
  super_over: "fixture.decidedBy.superOver",
  boundary_count: "fixture.decidedBy.boundaryCount",
  extra_time: "fixture.decidedBy.extraTime",
  ...Object.fromEntries(SETTLE_METHODS.map((m) => [settledMethod(m), `fixture.decidedBy.settled.${camel(m)}` as MessageKey])),
  ...Object.fromEntries(TIEBREAK_RUNGS.map((r) => [`tiebreak_${r}`, `fixture.decidedBy.tiebreak.${r}` as MessageKey])),
};
```

`decidedOutcomeTemplates` adds `tiebreakScored: Record<rung, string>` from `fixture.decidedBy.tiebreakScored.<rung>`. In `renderDecidedOutcome`, before the generic `if (template)` line:

```ts
  if (outcome.method?.startsWith("tiebreak_") && tiebreakScore) {
    const scored = templates.tiebreakScored?.[outcome.method.slice("tiebreak_".length)];
    if (scored) return interpolate(scored, { winner, score: tiebreakScore });
  }
```

Every caller of `renderDecidedOutcome` that has a `summary` passes `summary.detail?.tiebreak?.score ?? null` (`grep -arn "renderDecidedOutcome(\|decidedOutcomeText(" apps/web/src` lists them; `decidedOutcomeText` gets the same parameter).

`match-centre.ts`: `resultMsg`'s `win` branch, for a method in `DECIDED_METHOD_KEY`'s W2a keys, returns `{ key: "matchCentre.result.settled.<m>" | "matchCentre.result.tiebreak.<rung>[Scored]", params: { winner, score? } }`. `RESULT_KINDS` gains the six method names, so the existing exhaustiveness tests cover them.

`competition-hub.ts`'s `STATUS_LINE_KEYS` and `matchCentre.status.needs_decision` already landed in Task 7 (preflight C16); this task does not touch them.

`bracket.tsx:121`: a fixture whose status is `needs_decision` renders the status chip, never a winner highlight, and the level score stays.

- [ ] **Step 4: Strings, 4 locales**

`ui.json`, `fixture.decidedBy`:

| key | en | fr | es | nl |
|---|---|---|---|---|
| `settled.lot` | {winner} advanced on lot | {winner} qualifié par tirage au sort | {winner} avanzó por sorteo | {winner} door na loting |
| `settled.higherSeed` | {winner} advanced as higher seed | {winner} qualifié comme mieux classé | {winner} avanzó como mejor cabeza de serie | {winner} door als hoogst geplaatste |
| `settled.organiser` | {winner} advanced by organiser decision | {winner} qualifié par décision de l'organisateur | {winner} avanzó por decisión del organizador | {winner} door na beslissing van de organisator |
| `tiebreak.rapid` | {winner} won on rapid tie-break | {winner} gagne au départage en rapide | {winner} ganó el desempate de rápidas | {winner} won de rapid-tiebreak |
| `tiebreak.blitz` | {winner} won on blitz tie-break | {winner} gagne au départage en blitz | {winner} ganó el desempate de blitz | {winner} won de snelschaak-tiebreak |
| `tiebreak.armageddon` | {winner} won on Armageddon | {winner} gagne à l'Armageddon | {winner} ganó en el Armagedón | {winner} won de armageddon |
| `tiebreakScored.rapid` | {winner} won on rapid tie-break ({score}) | {winner} gagne au départage en rapide ({score}) | {winner} ganó el desempate de rápidas ({score}) | {winner} won de rapid-tiebreak ({score}) |
| `tiebreakScored.blitz` | {winner} won on blitz tie-break ({score}) | {winner} gagne au départage en blitz ({score}) | {winner} ganó el desempate de blitz ({score}) | {winner} won de snelschaak-tiebreak ({score}) |

`public.json`, `matchCentre.result`: the same eight sentences under `settled.*`, `tiebreak.*` and `tiebreakScored.*`, with the same values. (`matchCentre.status.needs_decision` landed in Task 7.)

Run `pnpm i18n:gen-keys && pnpm i18n:check`, and expect `EXIT=0`.

- [ ] **Step 5: Run green, plus the public suites touched**

The Step 2 command, plus:
- `src/lib/__tests__/scoring-vocab.test.ts`
- `src/server/public-site/__tests__/match-centre.test.ts`
- `src/server/public-site/__tests__/competition-hub-schema.test.ts`

The executor confirms the exact filenames with `ls` first. Expected: `EXIT=0` and `failed: 0`. Then run tsc.

- [ ] **Step 6: E2E.** Add to `bracket-finish.spec.ts`: "the public match page names the settle method and keeps the level score". After the console settle, open the public fixture page and assert the text "advanced on lot" and the level headline. Run the whole file as in Task 12 Step 6.

- [ ] **Step 7: Visual verdicts** at 1280, 768 and 320: the public match centre for a settled fixture and a tie-break fixture, and the hub bracket with a held fixture. One verdict per screen.

- [ ] **Step 8: Mutate (runner)** — `MUT/t13.json`

| id | find → replace | killer |
|---|---|---|
| `drop-settled` | `...Object.fromEntries(SETTLE_METHODS.map(` → `...Object.fromEntries([].map(` | "each settle method …" |
| `drop-tiebreak` | `...Object.fromEntries(TIEBREAK_RUNGS.map(` → `...Object.fromEntries([].map(` | the same (tie-break rows) |
| `scored-ignored` | `&& tiebreakScore) {` → `&& false) {` | "the tie-break score appears when recorded …" |

Expected: `EXIT=0`, 3 rows killed (`status-line` moved to Task 7; preflight C16).

- [ ] **Step 9: Loop H commit set.** Make one commit per task, each with its `MUT/t<N>.json`, then run the OpenAPI drift check (expected empty) and loop H's Opus review.

**Four test types:**
- Unit: Steps 1–5.
- E2E: Step 6.
- Smoke: Task 17 (the public page text).
- Regression: the sentence test in 4 locales.

---

### Task 14: Harness — generator breadth, the bracket policy, Settle in the model, adapters and page objects (spec §5.6.1–3; findings 16, 24)

**Lane P1, in its own worktree `format-matrix-w2a-harness`. It starts parallel with loop D, and its file set is `tools/matrix/**` only.**
- Its code is written against the frozen Interfaces of Tasks 3, 4, 5, 7 and 11.
- Its gate (Step 7) runs after loop D is merged into the branch and merged back into the lane.
- Its page-object drive (Step 8) runs after loop H.
- It reports its `newScenarios` keys and `IDX` lines to the orchestrator; it never edits them.

**Files:**
- Modify: `HM/lib/streams/types.ts` (`RequestedOutcome` gains `settle`, `level`, `tiebreak`, and `abandon` at a real score), `HM/lib/streams/index.ts:46-78`
- Modify: `HM/lib/streams/boardgame.ts`, `generic.ts`, `carrom.ts` (remove `TIEBOARD_DRAW`), `cricket.ts`, `football.ts`, and the period and setbased stream files (the abandon-at-score prefix)
- Modify: `HM/lib/scenarios/common.ts:461-582` (`bracketPolicy`; local fold with the stage-resolved cfg; counters)
- Modify: `HM/lib/sport-cfg.ts:81` (a `stageCfg(sport, cfg, stageKind)` that applies `module.bracketDeciders` when `forbidsLevelResult(stageKind)`; `drawsAllowed` unchanged)
- Modify: `HM/lib/invariants.ts` (`life-bracket-decider-exercised`)
- Modify: `HM/lib/model/state.ts:31`, `HM/lib/model/commands.ts` (`Settle`, opt-in)
- Modify: `HM/lib/pads/boardgame.ts`, `HM/lib/pads/carrom.ts`, `HM/__tests__/pad-adapters.test.ts:54-61`
- Create: `HM/lib/browser/pages/needs-decision.ts` (the console page object)
- Create: `HM/__tests__/w2a-streams.test.ts`, `HM/__tests__/model-settle.test.ts`, `HM/lib/scenarios/w2a-bracket-finish.ts` (the new scenarios)

**Interfaces:**
- Consumes (names only; the harness reads product facts as text and imports `@seazn/engine` runtime as it already does):
  - from `@seazn/engine/core`: `SETTLE_METHODS`, `BRACKET_KINDS`, `forbidsLevelResult`, `isLevelOutcome`, `outcomeOf`;
  - from boardgame: `TIEBREAK_RUNGS`;
  - status `needs_decision`;
  - Task 11's testids.
- Produces:
  ```ts
  export type RequestedOutcome = … | { kind: "level" } | { kind: "settle"; then: Side; method: (typeof SETTLE_METHODS)[number]; after: "level" | "abandon" }
    | { kind: "tiebreak"; rung: (typeof TIEBREAK_RUNGS)[number]; winner: Side } | { kind: "abandon"; atScore?: true };
  export function bracketPolicy(setup: DivisionSetup, f: FixtureRow, sport: string, ordinal: number): RequestedOutcome;
  export const W2A_SCENARIOS: readonly string[]; // the keys lane P1 reports into w2a-local-selection.json `newScenarios`
  ```

- [ ] **Step 1: Stream tests first** — `HM/__tests__/w2a-streams.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { BRACKET_KINDS, SETTLE_METHODS, foldMatchWithStoppage, outcomeOf } from "@seazn/engine/core";
import { TIEBREAK_RUNGS } from "@seazn/engine/sports/boardgame";
import { declaredCfgs, forEachSport, defaultLineupPair } from "@seazn/engine/testkit";
import { generateStream } from "../lib/streams/index.ts";
import { stageCfg } from "../lib/sport-cfg.ts";

const envelopes = (events: { type: string; payload: unknown }[]) => events.map((e, i) => ({ id: `e-${i + 1}`, seq: i + 1, type: e.type, payload: e.payload, recordedAt: "2026-10-08T00:00:00Z", recordedBy: null }));

describe("W2a generator breadth (spec §5.6.1) — every stream folds through the REAL engine (R15)", () => {
  it("empty case first: BRACKET_KINDS is non-empty", () => { expect(BRACKET_KINDS.size).toBeGreaterThan(0); });

  it("every sport: a bracket abandon at a real score (not 0–0), then settle, folds to a settled win", () => {
    let checked = 0;
    const sports = forEachSport(({ key, module }) => {
      const lineups = defaultLineupPair(module.positions);
      const cfg = stageCfg(key, declaredCfgs(module as never)[0]!.cfg, "knockout"); // preflight C7: generic has no schema default
      for (const method of SETTLE_METHODS) {
        const events = generateStream({ sportKey: key, cfg, stageKind: "knockout", home: lineups.home.entrantId, away: lineups.away.entrantId, outcome: { kind: "settle", then: "away", method, after: "abandon" } });
        const abandonAt = events.findIndex((e) => e.type === "core.abandon");
        expect(abandonAt, key).toBeGreaterThan(1); // something was played before the abandon: the "real score" premise
        const f = foldMatchWithStoppage(module, cfg as never, lineups, envelopes(events) as never);
        expect(outcomeOf(module, f), `${key} ${method}`).toMatchObject({ kind: "win", winner: lineups.away.entrantId, method: `settled_${method}` });
        checked++;
      }
    });
    expect(sports).toBe(11);
    expect(checked).toBe(11 * SETTLE_METHODS.length);
  });

  it("boardgame: a drawn bracket game followed by each rung, each side winning (ruling 82: the scorer records the winner)", () => {
    let checked = 0;
    forEachSport(({ key, module }) => {
      if (key !== "boardgame") return; // one-line reason: the tie-break is chess's (BG-KO-1)
      const lineups = defaultLineupPair(module.positions);
      const cfg = stageCfg(key, module.configSchema.parse({}), "knockout");
      for (const rung of TIEBREAK_RUNGS) for (const winner of ["home", "away"] as const) {
        const events = generateStream({ sportKey: key, cfg, stageKind: "knockout", home: lineups.home.entrantId, away: lineups.away.entrantId, outcome: { kind: "tiebreak", rung, winner } });
        const o = outcomeOf(module, foldMatchWithStoppage(module, cfg as never, lineups, envelopes(events) as never));
        expect(o?.kind, `${rung} ${winner}`).toBe("win");
        expect((o as { method?: string }).method).toBe(`tiebreak_${rung}`);
        expect((o as { winner?: string }).winner).toBe(winner === "home" ? lineups.home.entrantId : lineups.away.entrantId);
        checked++;
      }
    });
    expect(checked).toBe(TIEBREAK_RUNGS.length * 2);
  });

  it("carrom: a level bracket match reaches the extra board — with coins ≠ 9 (a value the old generator never emitted)", () => {
    let checked = 0;
    forEachSport(({ key, module }) => {
      if (key !== "carrom") return; // one-line reason: CA-KO-1 is carrom's
      const lineups = defaultLineupPair(module.positions);
      const cfg = stageCfg(key, module.configSchema.parse({ tieBoard: "draw" }), "knockout");
      expect((cfg as { tieBoard: string }).tieBoard).toBe("extra");
      const events = generateStream({ sportKey: key, cfg, stageKind: "knockout", home: lineups.home.entrantId, away: lineups.away.entrantId, outcome: { kind: "win", winner: "home" } });
      expect(events.some((e) => e.type === "carrom.board.summary" && (e.payload as { opponentCoinsLeft: number }).opponentCoinsLeft !== 9)).toBe(true);
      expect(outcomeOf(module, foldMatchWithStoppage(module, cfg as never, lineups, envelopes(events) as never))?.kind).toBe("win");
      checked++;
    });
    expect(checked).toBe(1);
  });

  it("football, hockey, ice hockey, cricket: a level knockout result with no decider folds level (it will be held), then settle wins", () => {
    let checked = 0;
    forEachSport(({ key, module }) => {
      if (!["football", "hockey", "icehockey", "cricket"].includes(key)) return; // one-line reason: spec §5.6.1 names these four
      const lineups = defaultLineupPair(module.positions);
      const cfg = stageCfg(key, module.configSchema.parse({}), "knockout");
      const level = generateStream({ sportKey: key, cfg, stageKind: "knockout", home: lineups.home.entrantId, away: lineups.away.entrantId, outcome: { kind: "level" } });
      const o = outcomeOf(module, foldMatchWithStoppage(module, cfg as never, lineups, envelopes(level) as never));
      expect(["draw", "tie", "no_result"], key).toContain(o?.kind);
      checked++;
    });
    expect(checked).toBe(4);
  });

  it("generic in a bracket: winner-only results; a level request is OutcomeUnreachable", () => {
    let checked = 0;
    forEachSport(({ key, module }) => {
      if (key !== "generic") return; // one-line reason: GN-KO-1
      const lineups = defaultLineupPair(module.positions);
      const cfg = stageCfg(key, module.configSchema.parse({ allowDraws: true, resultMode: "score" }), "knockout");
      expect(() => generateStream({ sportKey: key, cfg, stageKind: "knockout", home: lineups.home.entrantId, away: lineups.away.entrantId, outcome: { kind: "draw" } })).toThrow(/OutcomeUnreachable|unreachable/i);
      checked++;
    });
    expect(checked).toBe(1);
  });
});
```

- [ ] **Step 2: Run; see it fail** (harness recipe)

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a-harness && rm -f "$TMPDIR/w2a-t14m.json" && ./packages/engine/node_modules/.bin/vitest run --reporter=json --outputFile="$TMPDIR/w2a-t14m.json" --testTimeout=30000 tools/matrix/__tests__/w2a-streams.test.ts; echo EXIT=$?
```

Expected: `EXIT=1`; `stageCfg` is not exported.

- [ ] **Step 3: Implement the streams**
  - `stageCfg(sport, cfg, kind)` returns `forbidsLevelResult(kind) ? { ...cfg, ...module.bracketDeciders(cfg) } : cfg`. This is the harness's mirror of Task 6's overlay, built from the engine's own declaration.
  - `generateStream` handles the new request kinds before delegating to the sport generator:
    - `level`: the sport's level stream, via its `tied`, or a drawn result where the sport has one;
    - `abandon` with `atScore: true`: the first half of the sport's `decided` stream (the prefix before its deciding event, found by folding prefixes until `outcome !== null`, then cutting one event earlier), then `core.abandon`;
    - `settle`: the `level` or `abandon` prefix, then `core.settle { winner, method }`;
    - `tiebreak` (boardgame only): `START`, a drawn `boardgame.result`, then `boardgame.tiebreak { rung, winner }`, with the requested side's entrant as the winner.
  - `carrom.ts`: delete `TIEBOARD_DRAW` and its refusal. With `tieBoard: "extra"` (the bracket overlay), a level game is the alternating-board stream with coins `c = Math.min(9, Math.floor((cfg.gameTo - 1) / Math.ceil(cfg.maxBoards / 2)))` — Task 5 Step 5's arithmetic exactly, read from the carrom cfg declaration, never a literal (preflight C27). On an odd `maxBoards` the last board has 0 coins. One extra board then decides, so `c` ≠ 9 whenever `gameTo - 1 < 9·ceil(maxBoards/2)`.
  - `OutcomeUnreachable` reads `drawsAllowed` (now the allow-list) plus `forbidsLevelResult` for `level`.

- [ ] **Step 4: The bracket policy and the counted check** (finding 16)

```ts
/** W2a: in a bracket, every third fixture asks for the hard path — a level result (held, then settled), a
 *  boardgame tie-break, or an abandon at a real score then settle — so SC-O1/SC-O2 cannot turn green without
 *  a single decider having run. Counters feed `life-bracket-decider-exercised` (zero = failure, R25). */
export function bracketPolicy(setup: DivisionSetup, f: FixtureRow, sport: string, ordinal: number): RequestedOutcome {
  const higher: Side = setup.seedOf(f.home_entrant_id!) <= setup.seedOf(f.away_entrant_id!) ? "home" : "away";
  if (ordinal % 3 !== 2) return { kind: "win", winner: higher };
  if (sport === "boardgame") return { kind: "tiebreak", rung: TIEBREAK_RUNGS[ordinal % TIEBREAK_RUNGS.length]!, winner: higher };
  if (sport === "generic") return { kind: "settle", then: higher, method: SETTLE_METHODS[ordinal % SETTLE_METHODS.length]!, after: "abandon" };
  return { kind: "settle", then: higher, method: SETTLE_METHODS[ordinal % SETTLE_METHODS.length]!, after: ordinal % 2 === 0 ? "level" : "abandon" };
}
```

`decideFixture` uses `bracketPolicy` when `forbidsLevelResult(stage.kind)` and `defaultPolicy` otherwise. It posts the stream's settle through the organiser API (settle is organiser-only, X-ST-2), increments `ctx.counters.tiebreaksPosted` and `settlesPosted`, and folds locally with `stageCfg(sport, cfg, stage.kind)`, not `ctx.cfg` (finding 16: parity on every boardgame bracket). In `invariants.ts`:

```ts
export const lifeBracketDeciderExercised: RunInvariant = {
  id: "life-bracket-decider-exercised",
  check: (run) => {
    const bracketStages = run.stages.filter((s) => forbidsLevelResult(s.kind)).length;
    if (bracketStages === 0) return { ok: true, checked: 0, note: "no bracket stage in this run" };
    const n = run.counters.tiebreaksPosted + run.counters.settlesPosted;
    return n > 0 ? { ok: true, checked: n } : { ok: false, checked: 0, message: `a run with ${bracketStages} bracket stage(s) exercised no decider` };
  },
};
```

The `RunInvariant` shape is pinned from the existing life-* invariants in `invariants.ts`. A run with no bracket stage is out of scope, not a pass on zero; its `checked: 0` is recorded with the note. The `W2A_SCENARIOS` file defines the new scenario keys in the catalogue's own builder style (`lib/scenario-catalogue.ts` family `D`):
- `BRACKET_SETTLE_LEVEL`
- `BRACKET_SETTLE_ABANDON`
- `BRACKET_TIEBREAK`
- `BRACKET_EXTRA_BOARD`
- `BRACKET_NO_DRAW_GENERIC`

`pnpm matrix:catalogue` regenerates the committed catalogue; it is a reviewed change (R11).

- [ ] **Step 5: Settle in the model, opt-in (finding 24), with a rule-10 sequence** — `HM/__tests__/model-settle.test.ts`

```ts
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { COMMAND_KINDS, modelCommands, newModelState, type ModelState } from "../lib/model/commands.ts";
import { ModelFakeDriver } from "./model-fake-driver.ts";

// The real model API (read at c0416dea6, preflight C27): modelCommands({ fences, bias? }) (commands.ts:404) gains an
// opt-in `settle?: boolean`; commands are fc.AsyncCommand<ModelState, OrganiserDriver>, run over the
// ModelFakeDriver the way model-core.test.ts's `fresh` (:71) builds it. The row is a SINGLE-stage knockout row
// (modelRowRefusal admits it; state.ts:330).
async function freshKnockout(): Promise<{ m: ModelState; d: ModelFakeDriver }> {
  const d = new ModelFakeDriver({});
  const m = await newModelState({ driver: d, row: "knockout", sport: "generic", variant: "score", entrants: 4, tag: "t" });
  return { m, d };
}

describe("Settle in the model (spec §5.6.2; finding 24)", () => {
  it("empty case first: the default command set is unchanged, so committed seeds replay byte-identical", () => {
    expect(COMMAND_KINDS).not.toContain("Settle");
    expect(modelCommands({ fences: true }).length).toBe(COMMAND_KINDS.length); // settle absent: today's array
    expect(modelCommands({ fences: true, settle: true }).length).toBe(COMMAND_KINDS.length + 1);
  });
  it("rule 10: any sequence with Settle keeps the three invariants after every step, and Settle is actually exercised", async () => {
    let steps = 0; // steps checked across ALL runs
    let settles = 0; // accepted settles across ALL runs (preflight C27: zero is a failure, never `>= 0`)
    await fc.assert(fc.asyncProperty(fc.commands(modelCommands({ fences: true, settle: true }), { maxCommands: 40 }), async (cmds) => {
      const { m, d } = await freshKnockout();
      await fc.asyncModelRun(() => ({ model: m, real: d }), cmds);
      // the model's per-step check (checkStep) runs inside each command; these are its three W2a invariants, read after the run:
      for (const f of [...m.fixtures.values()]) {
        expect(f.status === "decided" && f.outcome !== null && ["draw", "tie", "no_result"].includes(f.outcome.kind)).toBe(false); // no bracket fixture decided level
        if (f.status === "needs_decision") expect(m.seatedFrom(f.id)).toEqual([]); // held seats nobody
        if (f.outcome?.method?.startsWith("settled_")) expect(m.seatedFrom(f.id).length).toBe(f.loserTo ? 2 : 1); // settle seats both
      }
      steps += m.steps.length;
      settles += m.settles.filter((x) => x.status < 300).length;
    }), { numRuns: 100 });
    expect(steps).toBeGreaterThan(0);
    expect(settles).toBeGreaterThan(0);
  });
});
```

`ModelState` gains `settles: { status: number; code: string | null }[]` (beside `generates`, `state.ts:94`), recorded by the `Settle` command. `m.seatedFrom(id)` is the model's existing seat read, or is added beside `fixtures` if the executor finds none; the per-step versions of the three invariants join `checkStep` (`state.ts`, exported via `commands.ts:31`).

`Settle` is a `Cmd` (`commands.ts:105`, the `Walkover` example at `:305`):
- `ready` when the model holds a bracket fixture in `needs_decision`, or one abandoned with a null or level outcome;
- `act` posts `core.settle` as the organiser;
- `mustAccept` is true when `ready`;
- `expectsRefusal` covers a second settle (`SETTLE_NOT_APPLICABLE`).

`modelCommands({ fences, bias, settle: true })` appends it after the existing kinds. The default (`settle` absent) builds exactly today's array. A shrunk failure is committed first as a named case in `catalogue/regressions.json`, with its seed and path (R29).

- [ ] **Step 6: Pad adapters and page objects; `outcomesFor`; one value-constant route case each**
  - `pads/boardgame.ts` drives the tie-break: tap `[data-tile-id="tiebreak"]`, then the rung's `[data-choice-option-id="<rung>"]`, then the winner's `[data-choice-option-id="home|away"]` (preflight C24: the chassis's real attributes; there are no `pad-tile-*` testids) (the `winner-armageddon` step on the armageddon rung), then the score or skip. The `TapStep` kinds come from `tools/bench/lib/drivers/scorer.ts:104`.
  - `outcomesFor` (`pad-adapters.test.ts:54-61`) marks `abandon` organiser-only. The pad adapter refuses to emit it, and the console page object emits it.
  - Route cases: a carrom board with `coins: 7` (≠ the generator's old 9), and a boardgame method `resign` (outside checkmate/agreement). Each is driven through the adapter's tap plan and folded through the engine.
  - `HM/lib/browser/pages/needs-decision.ts`:

```ts
import type { Page } from "playwright";
export class NeedsDecisionPage {
  constructor(private readonly page: Page) {}
  block() { return this.page.getByTestId("needs-decision"); }
  async settle(winnerEntrantId: string, method: "lot" | "higher_seed" | "organiser", note?: string): Promise<void> {
    await this.page.getByTestId("settle-open").click();
    await this.page.getByTestId(`settle-winner-${winnerEntrantId}`).click();
    await this.page.getByTestId(`settle-method-${method}`).check();
    if (note !== undefined) await this.page.getByTestId("settle-note").fill(note);
    await this.page.getByTestId("settle-confirm").click();
    await this.block().waitFor({ state: "detached" });
  }
}
```

- [ ] **Step 7: Run the harness gate** (after loop D is merged into the lane)

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a-harness && git merge --no-ff feat/format-matrix-w2a -m "Merge W2a engine into the harness lane" && rm -f "$TMPDIR/w2a-t14m.json" && ./packages/engine/node_modules/.bin/vitest run --reporter=json --outputFile="$TMPDIR/w2a-t14m.json" --testTimeout=30000 tools/matrix/__tests__/w2a-streams.test.ts tools/matrix/__tests__/model-settle.test.ts tools/matrix/__tests__/pad-adapters.test.ts tools/matrix/__tests__/streams.test.ts tools/matrix/__tests__/scenarios.test.ts tools/matrix/__tests__/invariants.test.ts tools/matrix/__tests__/committed-matrix.test.ts; echo EXIT=$?
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a-harness && rtk proxy node node_modules/typescript-native/bin/tsc -p tsconfig.tools-tests.json; echo EXIT=$?; pnpm matrix:single-sport --check --against HEAD^1; echo EXIT=$?
```

Expected: `EXIT=0` three times; the judge shows `files: 7`, `failed: 0`. The ratchet holds, because every single-sport case above carries its one-line reason. The `streams.test.ts` and `scenarios.test.ts` filenames are confirmed with `ls` first.

- [ ] **Step 8: The page-object drive** (after loop H is merged into the lane). Run one local truth run with `newScenarios` set to the five keys (the selection file is on the main worktree, so the orchestrator writes it from this lane's report). Use the Global Constraints command with `<tag>` = `p1-drive`. Expected:
  - every new-scenario line prints `EXIT=0` or `EXIT=1`;
  - the run's `results.json` holds at least one case per new key;
  - `life-bracket-decider-exercised` has `checked > 0` on every run with a bracket stage.

  Then run Task 7's status-set sweep on the merged lane (preflight C19), and list in the report every set it prints as unclassified that this lane introduced (file, anchor, use site). The lane does not edit the ledger; Task 17 adds the rows.

  ```bash
  cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a-harness/apps/web && rm -f "$TMPDIR/w2a-t14s.json" && pnpm vitest run src/lib/__tests__/status-set-sweep.test.ts --reporter=json --outputFile="$TMPDIR/w2a-t14s.json"; echo EXIT=$?; jq -r '.testResults[].assertionResults[] | select(.status=="failed") | .failureMessages[]' "$TMPDIR/w2a-t14s.json" | head -40
  ```

- [ ] **Step 9: Mutate (runner)** — `MUT/t14.json`

| id | find → replace | killer (`cwd: "."`) |
|---|---|---|
| `policy-never-hard` | `if (ordinal % 3 !== 2) return { kind: "win", winner: higher };` → `return { kind: "win", winner: higher };` | `invariants.test.ts` (add "a bracket run with zero deciders fails life-bracket-decider-exercised") |
| `stagecfg-off` | `forbidsLevelResult(kind) ? { ...cfg, ...module.bracketDeciders(cfg) } : cfg` → `cfg` | `w2a-streams.test.ts` "carrom … extra board" (`tieBoard` stays "draw") |
| `carrom-coins-9` | the coin formula → `9` | the same test (`opponentCoinsLeft !== 9`) |
| `abandon-at-zero` | the prefix cut → `[START]` | "every sport: a bracket abandon at a real score …" (`abandonAt > 1`) |
| `settle-default-on` | `modelCommands`' `settle === true` check → `true` | `model-settle.test.ts` "empty case first …" (`COMMAND_KINDS`) or the replay diff |
| `invariant-held-seat` | the `needs_decision` seat assertion → removed | `model-settle.test.ts` rule-10 (only if the model can seat a held fixture; if it cannot, record the mutant as unreachable with the reason) |

Expected: `EXIT=0`, with every row killed or carrying a recorded reason the reviewer signs.

- [ ] **Step 10: Commit on the lane; report.** Commit message: `test(matrix): W2a generator breadth, bracket policy, opt-in Settle, adapters and the needs-decision page object (T14)`. Report to the orchestrator:
  - the five `newScenarios` keys;
  - the `IDX` lines;
  - the judge lines.

  Then run lane P1's Opus review, and merge back as Loops and lanes says.

**Four test types:**
- Unit: Steps 1–7.
- E2E: Step 8, the browser page object through the real console.
- Smoke: Task 16's truth run.
- Regression: `catalogue/regressions.json` replays unchanged, plus a new seed if one shrank.

---

### Task 15: Reference family `bracket-finish` — **dispatch to a DIFFERENT agent than the engine implementer (R8)**

**Lane P2, in its own worktree `format-matrix-w2a-reference`.**
- It starts once loop C (the rule rows) is merged, parallel with loop D.
- Its inputs are the rule rows in `packages/engine/rules/*.md` and spec §5.6.4, **only**.
- It reads no engine source beyond the `import type` names it is allowed (R7), and nothing from `apps/web`.
- The dispatch brief gives the agent the rule-row files and §5.6.4. It does not include Tasks 3–8 of this plan, so the oracle cannot be shaped by the implementation.

**Files:**
- Create: `packages/reference/src/families/bracket-finish.ts`, `packages/reference/src/families/bracket-finish.test.ts`
- Modify: `packages/reference/src/index.ts` (`FAMILIES` gains `bracketFinish`), `packages/reference/src/index.test.ts` (no longer empty; its sweep becomes "exactly the bracket kinds × every sport resolve to bracket-finish; every other pair still refuses")

**Interfaces:**
- Consumes: `import type { StageKind } from "@seazn/engine/core"` only.
- Produces:
  ```ts
  /** One bracket fixture, described in the RULEBOOK's terms — what was played and what the organiser or scorer did —
   *  never as engine events. */
  export type PlayResult = { kind: "win"; winner: "home" | "away" } | { kind: "level" } | { kind: "none" };
  export type Action =
    | { kind: "abandon" }
    | { kind: "settle"; winner: "home" | "away"; method: "lot" | "higher_seed" | "organiser"; by: "organiser" | "scorer" | "device" }
    | { kind: "tiebreak"; rung: "rapid" | "blitz" | "armageddon"; winner: "home" | "away" }
    | { kind: "void-last" } | { kind: "finalize" };
  export interface BracketCase { stageKind: StageKind; sport: string; play: PlayResult; actions: readonly Action[]; hasLoserLine: boolean }
  export interface BracketExpect {
    status: "scheduled" | "in_play" | "decided" | "needs_decision" | "abandoned" | "finalized"; // in_play: a chess game awaiting its tie-break (ruling C12)
    advances: { winner: "home" | "away"; loser: "home" | "away" | null; method: string } | null;
    refused: readonly { index: number; code: string }[]; // which actions are refused, by rule
  }
  export function expectBracketFinish(c: BracketCase): BracketExpect;
  /** The family record `FAMILIES` holds (preflight C29). */
  export const bracketFinish: {
    readonly stageKinds: readonly StageKind[]; // ["knockout","double_elim","stepladder","page_playoff","ladder"], from X-BR-1's scope
    readonly sports: "any";
    expectAll(cases: readonly BracketCase[]): BracketExpect[];
  };
  ```

- [ ] **Step 1: Write the tests from the rule rows** (`bracket-finish.test.ts`). Each `it` names the rule row it reads. Its first case is the empty bracket.

```ts
import { describe, expect, it } from "vitest";
import { expectBracketFinish, bracketFinish, type BracketCase } from "./bracket-finish.ts";

const base: BracketCase = { stageKind: "knockout", sport: "boardgame", play: { kind: "level" }, actions: [], hasLoserLine: false };

describe("reference family bracket-finish (rule rows X-BR-1/2, X-ST-1/2, BG-KO-1/2, CA-KO-1, GN-KO-1, CK-KO-1)", () => {
  it("empty case first: a bracket with zero fixtures has nothing to expect (and a fixture with nothing played is scheduled)", () => {
    expect(bracketFinish.expectAll([])).toEqual([]);
    expect(expectBracketFinish({ ...base, play: { kind: "none" } })).toEqual({ status: "scheduled", advances: null, refused: [] });
  });
  it("X-BR-2: a level result in a bracket is needs_decision and seats nobody", () => {
    expect(expectBracketFinish({ ...base, sport: "football" })).toEqual({ status: "needs_decision", advances: null, refused: [] });
  });
  it("X-ST-1: settle after a level result advances the winner and the loser, by method", () => {
    const e = expectBracketFinish({ ...base, sport: "football", hasLoserLine: true, actions: [{ kind: "settle", winner: "away", method: "lot", by: "organiser" }] });
    expect(e).toEqual({ status: "decided", advances: { winner: "away", loser: "home", method: "settled_lot" }, refused: [] });
  });
  it("X-ST-1: settle on a decided win is refused; a second settle is refused", () => {
    expect(expectBracketFinish({ ...base, play: { kind: "win", winner: "home" }, actions: [{ kind: "settle", winner: "away", method: "lot", by: "organiser" }] }).refused).toEqual([{ index: 0, code: "SETTLE_NOT_APPLICABLE" }]);
    expect(expectBracketFinish({ ...base, sport: "football", actions: [{ kind: "settle", winner: "away", method: "lot", by: "organiser" }, { kind: "settle", winner: "home", method: "lot", by: "organiser" }] }).refused).toEqual([{ index: 1, code: "SETTLE_NOT_APPLICABLE" }]);
  });
  it("X-ST-2: a scorer's or a device's settle is refused FORBIDDEN, whatever the state", () => {
    for (const by of ["scorer", "device"] as const) {
      expect(expectBracketFinish({ ...base, sport: "football", actions: [{ kind: "settle", winner: "away", method: "lot", by }] }).refused, by).toEqual([{ index: 0, code: "FORBIDDEN" }]);
    }
  });
  it("X-ST-1: an abandon with nothing decided, then settle: decided; a void of the settle: back to abandoned", () => {
    expect(expectBracketFinish({ ...base, play: { kind: "none" }, actions: [{ kind: "abandon" }, { kind: "settle", winner: "home", method: "organiser", by: "organiser" }] }).status).toBe("decided");
    expect(expectBracketFinish({ ...base, play: { kind: "none" }, actions: [{ kind: "abandon" }, { kind: "settle", winner: "home", method: "organiser", by: "organiser" }, { kind: "void-last" }] }).status).toBe("abandoned");
  });
  it("BG-KO-1: a drawn chess game in a bracket goes to a tie-break; each rung decides with its own method", () => {
    for (const rung of ["rapid", "blitz", "armageddon"] as const) {
      expect(expectBracketFinish({ ...base, actions: [{ kind: "tiebreak", rung, winner: "home" }] }).advances, rung).toEqual({ winner: "home", loser: null, method: `tiebreak_${rung}` });
    }
  });
  it("BG-KO-1 + ruling C12: a drawn chess bracket game awaits its tie-break (in_play, nobody seated); lots is the organiser's settle there", () => {
    expect(expectBracketFinish(base)).toEqual({ status: "in_play", advances: null, refused: [] });
    expect(expectBracketFinish({ ...base, actions: [{ kind: "settle", winner: "away", method: "lot", by: "organiser" }] })).toEqual({ status: "decided", advances: { winner: "away", loser: null, method: "settled_lot" }, refused: [] });
    // the positive pair's negative: after the tie-break decided it, a settle is refused
    expect(expectBracketFinish({ ...base, actions: [{ kind: "tiebreak", rung: "rapid", winner: "home" }, { kind: "settle", winner: "away", method: "lot", by: "organiser" }] }).refused).toEqual([{ index: 1, code: "SETTLE_NOT_APPLICABLE" }]);
  });
  it("BG-KO-2 (W2a enforcement per ruling 82): the armageddon winner the scorer records advances, either side — no draw is recorded in W2a", () => {
    for (const winner of ["home", "away"] as const) {
      expect(expectBracketFinish({ ...base, actions: [{ kind: "tiebreak", rung: "armageddon", winner }] }), winner).toEqual({ status: "decided", advances: { winner, loser: null, method: "tiebreak_armageddon" }, refused: [] });
    }
  });
  it("CA-KO-1: a carrom bracket match never ends level — the extra board decides, so 'level' is not a carrom bracket result", () => {
    expect(() => expectBracketFinish({ ...base, sport: "carrom" })).toThrow(/CA-KO-1/);
  });
  it("GN-KO-1: a generic draw in a bracket is refused LEVEL_RESULT_IN_BRACKET", () => {
    expect(expectBracketFinish({ ...base, sport: "generic" })).toEqual({ status: "scheduled", advances: null, refused: [{ index: -1, code: "LEVEL_RESULT_IN_BRACKET" }] });
  });
  it("CK-KO-1: a cricket knockout no-result is held and settled by the higher group finisher", () => {
    expect(expectBracketFinish({ ...base, sport: "cricket", actions: [{ kind: "settle", winner: "home", method: "higher_seed", by: "organiser" }] }).advances).toEqual({ winner: "home", loser: null, method: "settled_higher_seed" });
  });
  it("finalize of a level result is refused until it is settled", () => {
    expect(expectBracketFinish({ ...base, sport: "football", actions: [{ kind: "finalize" }] }).refused).toEqual([{ index: 0, code: "LEVEL_RESULT_IN_BRACKET" }]);
  });
});
```

`index: -1` means the play itself is refused, before any action. The refusal codes are the rule rows' and spec §7's names. Where the rows are silent on an input, the family throws a named `NotRuled` error and never guesses (R6). The agent lists every `NotRuled` it raised, as an owner question.

- [ ] **Step 2: Run; see it fail**

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a-reference/packages/reference && rm -f "$TMPDIR/w2a-t15r.json" && pnpm vitest run src/families/bracket-finish.test.ts src/index.test.ts --reporter=json --outputFile="$TMPDIR/w2a-t15r.json"; echo EXIT=$?
```

Expected: `EXIT=1`; the family is missing.

- [ ] **Step 3: Write the family** from the rule rows: a pure fold over `actions`, with the state `{ status, advances, settled, tiebreakDone }` and one branch per rule row. Each branch carries the rule id in a comment.
  - The family declares `stageKinds = ["knockout","double_elim","stepladder","page_playoff","ladder"]`, typed in the family from rule X-BR-1's scope ("bracket kinds") and spec §5.4.1's list. Its test cross-checks it against the engine's `BRACKET_KINDS` as a VALUE imported at test time only. That is the one place the oracle meets the product, and a disagreement is a finding, never a fix to either side without a ruling (R6, R9).
  - `sports` is `"any"`.
  - `expectAll(cases)` maps.

- [ ] **Step 4: Run green, plus the boundary gate**

The cross-check imports `BRACKET_KINDS` as a VALUE at test time, and that export exists only after Task 3. So P2 waits on loop D for THIS step only (preflight C28): once loop D is merged into `feat/format-matrix-w2a`, merge it into the lane first, as P1 does before its gate:

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a-reference && git merge --no-ff feat/format-matrix-w2a -m "Merge W2a engine into the reference lane (BRACKET_KINDS for the cross-check)"; echo EXIT=$?
```

The merge brings engine source into the lane's tree; the agent still READS none of it (R8), and the boundary gate below proves the family imports none at runtime.

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a-reference/packages/reference && rm -f "$TMPDIR/w2a-t15r.json" && pnpm vitest run src/families/bracket-finish.test.ts src/index.test.ts --reporter=json --outputFile="$TMPDIR/w2a-t15r.json"; echo EXIT=$?
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a-reference && node --experimental-strip-types scripts/reference-boundary.ts; echo EXIT=$?
```

Expected: `EXIT=0` both; the judge shows `files: 2` and `failed: 0`. The boundary gate finds no runtime import of `@seazn/engine` and nothing from `apps/web`.

- [ ] **Step 5: Mutate (runner)** — `MUT/t15.json`. One mutant per rule-row branch (the comment ids make the finds unique), each killed by the `it` that names that row:
  - X-BR-2's hold → decided;
  - X-ST-1's second-settle refusal;
  - X-ST-2's `by` check;
  - each of BG-KO-1's three rungs' method strings;
  - BG-KO-2's recorded winner (mutated to always "home");
  - GN-KO-1;
  - the finalize refusal;
  - ruling C12's tie-break-phase settle (the branch that accepts a settle while the chess tie-break is pending, mutated to refuse).

  Expected: `EXIT=0`, 10 rows killed.

- [ ] **Step 6: Commit on the lane** — `feat(reference): bracket-finish family from the W2a rule rows (R8, independent of the engine fix) (T15)`. Report the `NotRuled` list, then run lane P2's Opus review and merge back.

**Four test types:**
- Unit: Steps 1–4.
- E2E: traced forward. Task 16's truth run judges product results against this family.
- Smoke: N/A as a product flow (an oracle). Traced to Task 16.
- Regression: the family's test runs in CI (`ci.yml:283`).

---


### Task 16: The W2a cells locally, then the full judge regression once on CI (spec §9, §10; R27)

**Run E2 (Sonnet, no reviewer; the orchestrator re-checks every count). It waits on every loop and lane being merged into `feat/format-matrix-w2a`, plus a pushed branch.**

**Files:**
- Create: `TR/w2a-final/**` (local W2a-cell results, the CI merged artifact, and the judge output)
- Modify: `TR/plans.lock.json` (the W2a entries), `docs/superpowers/specs/2026-09-27-format-matrix-prompts/MATRIX.md` (regenerated, never hand-edited), `IDX` (the W2 row and the evidence pointers)

- [ ] **Step 1: The W2a cells locally, after a fresh rebuild.** Run the Global Constraints truth-run command with `<tag>` = `final`. The selection must hold Task 1's `cases` and Task 14's five `newScenarios`, so assert that first:

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a && jq '{cases: (.cases|length), newScenarios: (.newScenarios|length)}' docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w2a-local-selection.json
```

Expected: `cases` equals the distinct `(layer, only, scenario)` triples Task 1 wrote from the 77 (its Step 2b printed the number), and `newScenarios` is 5. Then run the loop; every line prints `EXIT=0`.

The judge is the Task 1 Step 5 node check pointed at `$TMPDIR/w2a-local-final`, with the expectation inverted: every one of the 77 baseline reds is now green, and every new-scenario case is green with `life-bracket-decider-exercised` `checked > 0`. Copy the run directory to `TR/w2a-final/local/`.

- [ ] **Step 2: The full matrix once, on CI.** Dispatch it on the branch; never locally.

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a && git push origin feat/format-matrix-w2a && gh workflow run matrix-truth.yml --ref feat/format-matrix-w2a -f scope=full; echo EXIT=$?
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a && sleep 20 && gh run list --workflow matrix-truth.yml --branch feat/format-matrix-w2a --limit 1 --json databaseId,status,headSha,event
```

Before believing the run:
- confirm `headSha` equals `git rev-parse HEAD` (memory: a dispatched run's head can be another ref);
- confirm `event` is `workflow_dispatch`.

Wait with `gh run watch <id> --exit-status` in a background command that writes `EXIT=$?` itself. A run reported "cancelled" is not a pass. A run whose jobs are all red with zero steps in about 3 seconds is billing or a missing runner, not a defect (memory). Either one is re-dispatched, never judged.

- [ ] **Step 3: Download, then judge each layer against its W1d baseline** (controller ruling C30)

What `tools/matrix/judge.ts` actually does (read, not assumed):
- `regression` refuses (exit 2, `UnexpectedCase`) a `--now` that holds any case not in `--expect`, and (`ExpectedAbsent`) one that lacks an expected case (`holdsExactly`, `judge.ts:209-220`). So `--expect` is the run's OWN case-id list, read from `--now` with jq — never `expect-77.json`, which would be refused.
- It refuses `compared 0` itself (`NoneCompared`, exit 2), so a zero-judged layer cannot pass silently.
- Its only verdict line is `<run> against the baseline <run>: compared N cases; K regressions`, then one line per regression `  <caseId>: <was> → <now> — <reason>`, then `exit <0|1>: …`. `--json-out` writes the same as `JudgeOut` (`regressed[]`, `compared`, `absent[]`).
- It prints NO newly-green list. "Newly red" is therefore `K regressions` (`.regressed | length` in the JSON); "the 77 are green" is a separate jq check over the results, below.

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a && R=docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs && rm -rf "$R/w2a-final/ci" && gh run download <id> --name merged --dir "$R/w2a-final/ci"; echo EXIT=$?; ls -R "$R/w2a-final/ci" | head -40
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a && R=docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs && for L in L1 L2 L3; do NOW="$R/w2a-final/ci/$L/results.json"; if [ ! -f "$NOW" ]; then echo "$L: NOT IN THE CI ARTIFACT"; continue; fi; jq '[.cases[].caseId]' "$NOW" > "$TMPDIR/w2a-expect-$L.json"; pnpm matrix:judge regression --baseline "$R/w1d-baseline/$L/results.json" --now "$NOW" --expect "$TMPDIR/w2a-expect-$L.json" --json-out "$R/w2a-final/judge-$L.json" > "$R/w2a-final/judge-$L.txt" 2>&1; echo "$L EXIT=$?"; head -1 "$R/w2a-final/judge-$L.txt"; jq -c '{compared, newlyRed: (.regressed|length), absent: (.absent|length)}' "$R/w2a-final/judge-$L.json"; done
```

Pin the artifact's internal paths from the `ls -R` first; if a layer's results sit under another name, `NOW` follows the file and the deviation is written into `IDX`.

Expected, per layer the artifact holds:
- `EXIT=0` (exit 1 is a regression, exit 2 a refusal — neither is a pass);
- the first line's `compared N` with N > 0, and `newlyRed: 0`;
- `absent` is read and recorded (a case the W1d baseline held and the CI run lacks); a non-zero `absent` goes to the orchestrator.

Then "the 77 are green", per layer. The ids that CI's artifact does not hold (L1/L2 if the full dispatch did not run them) are read from Step 1's local runs, `TR/w2a-final/local/<L>/results.json`:

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a && R=docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs && node -e '
const fs=require("fs"),p=require("path");const R=process.argv[1];const want=JSON.parse(fs.readFileSync(R+"/w2a-repro/expect-77.json","utf8"));
const seen=new Map();let read=0;
for(const L of ["L1","L2","L3"]){for(const src of [R+"/w2a-final/ci/"+L+"/results.json",R+"/w2a-final/local/"+L+"/results.json"]){if(!fs.existsSync(src))continue;
 for(const c of JSON.parse(fs.readFileSync(src,"utf8")).cases){read++;if(want.includes(c.caseId)&&!seen.has(c.caseId))seen.set(c.caseId,{layer:L,state:c.state,src:p.relative(R,src)});}}}
const missing=want.filter((id)=>!seen.has(id));const notGreen=[...seen].filter(([,v])=>v.state!=="works");
console.log(JSON.stringify({expected:want.length,read,found:seen.size,works:seen.size-notGreen.length,missing:missing.slice(0,10),notGreen:notGreen.slice(0,10)}));
process.exit(want.length>0&&read>0&&missing.length===0&&notGreen.length===0?0:1)' "$R"; echo EXIT=$?
```

Expected: `EXIT=0`, with `found` = `works` = `expected` (77, or Task 1's recorded count if it removed a non-reproducing id), `missing: []` and `notGreen: []`. `works` is `CASE_STATES`'s ✅ (`tools/matrix/lib/results.ts:44-48`).

- [ ] **Step 4: The swiss_playoff R4 cells, read against the SW-H1 flip note (spec §8 item 3; ruling 70).** Read the swiss_playoff R4 cells from the CI results with `jq` (the field names are pinned from the file first), and print the count read. Zero read is a failure.

Then compare each cell with the SW-H1 flip note in `IDX` **before** any movement counts. A cell that moved is classified against the note:
- as a fix the note predicts;
- as a W2b-owned cell that W2a must not have moved;
- or as a regression.

The classification is written into `IDX`. Anything other than "the note predicts it" goes to the orchestrator as a finding, never counted as a win.

- [ ] **Step 5: The lock, `MATRIX.md`, and nothing awaiting proof**

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a && pnpm matrix:render; echo EXIT=$?; git diff --stat -- docs/superpowers/specs/2026-09-27-format-matrix-prompts/MATRIX.md
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a/packages/engine && rm -f "$TMPDIR/w2a-t16r.json" && pnpm vitest run test/rules-reference.test.ts --reporter=json --outputFile="$TMPDIR/w2a-t16r.json"; echo EXIT=$?; jq -c '{passed: .numPassedTests, total: .numTotalTests, failed: .numFailedTests}' "$TMPDIR/w2a-t16r.json"
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a && grep -a -c 'const AWAITING_PROOF: ReadonlyMap<string, string> = new Map(\[\]);' packages/engine/test/rules-reference.test.ts; grep -a -A3 'const AWAITING_PROOF' packages/engine/test/rules-reference.test.ts
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a && rm -f "$TMPDIR/w2a-t16m.json" && ./packages/engine/node_modules/.bin/vitest run --reporter=json --outputFile="$TMPDIR/w2a-t16m.json" --testTimeout=30000 tools/matrix/__tests__/committed-matrix.test.ts; echo EXIT=$?; jq -c '{passed: .numPassedTests, total: .numTotalTests}' "$TMPDIR/w2a-t16m.json"
```

(`AWAITING_PROOF` lives in `rules-reference.test.ts`, never in `plans.lock.json`; preflight C31.)

Expected:
- `matrix:render` `EXIT=0`, and the `MATRIX.md` diff changes only the W2a rows (X-BR, X-ST, X-DR, BG-KO, CA-KO, GN-KO, CK-KO, and the 77 baseline cells);
- `rules-reference.test.ts` `EXIT=0` with `passed` = `total` > 0, and the grep count is `1`: the literal reads `new Map([])` (every rule proved);
- `committed-matrix.test.ts` `EXIT=0` with `passed` = `total` > 0, after the lock entries below are appended (the evidence-integrity sweep over `TR/w2a-final/**`).

The `plans.lock.json` entries for W2a point at `TR/w2a-final/ci` and its run id. The lock's schema is the one W1d used (the `w1d` entries are the template; read them first).

- [ ] **Step 6: Record that this dispatch counts as a weekly run.** `MATRIX_WEEKLY_ENABLED=true` since 2026-10-08 (memory). In `IDX`, record the dispatch run id and date as the W2a full run, so the weekly staleness clock is read correctly at the next weekly run. This is a note, not a workflow change.

- [ ] **Step 7: Commit the evidence** — `docs(matrix): W2a final truth run — W2a cells local, full regression on CI (run <id>)`. `git add` only `TR/w2a-final/**`, `TR/plans.lock.json`, `MATRIX.md` and `IDX`.

**Four test types:** this task is the regression type for the whole wave. Unit, E2E and smoke belong to the tasks that changed code.

---

### Task 17: Ship gate — whole spec files, smoke, widths, screenshots, CI dispatches, PR

**Run E2, continued (Sonnet, no reviewer). Loop R follows it.**

**Files:**
- Modify: `scripts/smoke.ts` (`bracketFinishSuite`, after `hubKnockoutSuite` at `:1967`; called beside it at `:1097`)
- Modify: `apps/web/src/lib/__tests__/status-set-ledger.ts` (rows for sets lane P1 reported and for `smoke.ts`; preflight C19)
- Modify: `IDX` (W2a status row and the per-screen verdicts)
- Create: screenshots under `docs/superpowers/specs/2026-09-27-format-matrix-prompts/evidence/w2a/` (cropped PNGs)

- [ ] **Step 1: The smoke suite** — `bracketFinishSuite`, modelled on `hubKnockoutSuite` (read it first; its helpers, its API wrapper and its cleanup are the pattern). The four flows, each through the real API as the organiser:
  1. A football knockout semi-final played to full time level with no decider (the C18 stream, Task 11): the status is `needs_decision` (an ABANDONED one would read `abandoned`, D3 order 2). Settle `lot` for the away side: decided, `settled_lot`, and the final's slot holds the winner. The public match page text contains "advanced on lot".
  2. A chess knockout game drawn, then `boardgame.tiebreak` armageddon naming the away side as the winner (ruling 82: the scorer records the winner): decided, `tiebreak_armageddon`, the away side seated.
  3. A generic knockout `generic.result` level: refused 409 `LEVEL_RESULT_IN_BRACKET`, and the fixture is unchanged.
  4. A scorer-token `core.settle`: refused 403 `FORBIDDEN`, and the fixture is unchanged (X-ST-2).

  Each flow asserts the response body's error code, not only the HTTP status. Each assertion that reads a list states how many items it checked, and zero is a failure.

```bash
S=~/.claude/skills/seazn-local-env/scripts/seazn-env.sh; cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a && $S rebuild --label w2a > "$TMPDIR/w2a-rebuild.log" 2>&1; echo EXIT=$?
S=~/.claude/skills/seazn-local-env/scripts/seazn-env.sh; cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a && eval "$($S env --label w2a)" && pnpm smoke > "$TMPDIR/w2a-smoke.log" 2>&1; echo EXIT=$?; grep -a -n "bracketFinish\|PASS\|FAIL" "$TMPDIR/w2a-smoke.log" | tail -20
```

Expected: `EXIT=0`, and the log shows the four `bracketFinish` flows passed. There is no `MUT/t17.json`: the runner runs vitest killers only and refuses a killer with no `files` (preflight C1), and the product guards these flows reach are each mutated in their own task's runner list (Tasks 4, 7, 8, 9). Each flow's assertions name the code they expect and count what they read, so a flow that checks nothing fails.

- [ ] **Step 2: Whole e2e spec files touched by the wave, locally** — never a `-g` slice (R18, class 21). The list comes from a grep of the selectors and routes the wave changed, not from filenames (class 16):

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a/apps/web && grep -a -l "needs-decision\|settle-\|data-tile-id\|data-choice-option-id\|score-finalize\|match-actions\|needs_decision\|bracket" e2e/*.spec.ts | sort
```

Run each listed file in full on the project its header names, with the commands of Task 11 Step 5 and Task 12 Step 6, against a rebuilt server. Expected: each file reports `unexpected: 0` and `skipped: 0`. `mobile.spec.ts` runs all seven width projects; a serial red count is a floor, so re-run after each fix until a full pass.

- [ ] **Step 3: Per-screen visual verdicts (R24; class 11).** Capture at 1280, 768 and 320, with `screenshotAtWidths`, cropped to the component:
  - the console with the Needs-a-decision block;
  - the settle dialog;
  - the pad in phase tiebreak, and each tie-break step (the armageddon winner step with its hint);
  - the generic bracket pad with no Draw;
  - the public match centre for a settled fixture and for a tie-break fixture;
  - the hub bracket with a held fixture;
  - the run-sheet row with its chip.

  Confirm the images exist, differ between states, and were taken after the state being proven (class 10). Write one verdict line per screen per width into `IDX`: alignment, text size, tap targets ≥ 44px, truncation, and horizontal scroll. "Looks fine" is not a verdict.

  Then put the same cropped screens to the owner (ruling 82: the layouts were chosen in brainstorming, UI-1 option A and UI-2 option B, and the owner judges the built screens). Record the owner's verdict per screen beside the agent's. A screen the owner rejects goes back to loop H before merge.

- [ ] **Step 4: The Stryker probe, once, locally.** This confirms the changed-lines config still runs the floor:

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a/packages/engine && STRYKER_GROUP=probe pnpm mutation > "$TMPDIR/w2a-probe.log" 2>&1; echo EXIT=$?; tail -5 "$TMPDIR/w2a-probe.log"
```

Expected: `EXIT=0`, with the score at or above the floor the probe states. The env var name is pinned from `stryker.config.mjs`'s `resolveGroup`.

- [ ] **Step 5: The OpenAPI drift check and tsc**

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a && pnpm openapi:gen && git diff --exit-code -- openapi; echo EXIT=$?
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a/apps/web && rtk proxy node ../../node_modules/typescript-native/bin/tsc --noEmit -p tsconfig.json; echo EXIT=$?
```

Expected: `EXIT=0` both. The drift check is the `ci.yml` step's command (read it from `ci.yml` and use that exact line if it differs).

Then the status-set sweep, on the fully merged branch (preflight C19). Add a ledger row for every set lane P1 reported and every set `smoke.ts` now holds, each with a `why` read at its use site, and re-run until green:

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a/apps/web && rm -f "$TMPDIR/w2a-t17s.json" && pnpm vitest run src/lib/__tests__/status-set-sweep.test.ts --reporter=json --outputFile="$TMPDIR/w2a-t17s.json"; echo EXIT=$?; jq -c '{passed: .numPassedTests, total: .numTotalTests}' "$TMPDIR/w2a-t17s.json"
```

Expected: `EXIT=0`, `passed` = `total` > 0.

- [ ] **Step 6: Open the PR, then the heavy checks once, on CI, in parallel.** The PR body:
  - leads with the matrix rows the wave turns green (R27): each rule row, the 77 cells, and the five new scenarios, with the CI run id from Task 16;
  - lists the plan-time findings that became `IDX` rulings;
  - lists the screens with their verdict lines;
  - ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a && gh pr create --base main --head feat/format-matrix-w2a --title "feat(matrix): W2a — knockouts finish (needs_decision, settle, chess tie-break, carrom extra board)" --body-file "$TMPDIR/w2a-pr-body.md"; echo EXIT=$?
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a && gh workflow run mutation.yml --ref feat/format-matrix-w2a -f group=all; echo EXIT=$?
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2a && gh workflow run e2e.yml --ref main -f pr=<PR number>; echo EXIT=$?
```

- **The mutation dispatch.** `group=all` (every family but the probe), because Task 5 touches every sport module (`bracketDeciders`). That puts every `sports-*` family in play, as well as `core-*` and `modules-*`; a narrower list would miss modules whose one-line `bracketDeciders` changed.
- **The e2e dispatch.** It runs `main`'s `e2e.yml` against the PR head (`pr` input). The branch does not edit `e2e.yml`; if it ever does, the dispatch uses `--ref feat/format-matrix-w2a` (memory). A push to `main` while it runs cancels it, and "cancelled" is not a pass: re-dispatch.
- **Smoke** runs on the PR by itself.

Expected:
- every mutation family reports `survived` within the per-family break, and none of the W2a lines survive; the report is read per family, not from the run's colour;
- e2e: all three jobs green, all seven widths;
- smoke and `ci.yml` green on the PR.

- [ ] **Step 7: Docs and the merge.** `IDX`:
  - W2a row: status, PR number, run ids (truth, mutation, e2e);
  - the rulings taken from the plan-time findings;
  - the "False premises found" lines;
  - what moves to W2b.

  The merge is a merge commit, never a squash, and happens only after loop R's verdict is "Ready" and the owner merges or says to (the PR body carries the sign-off list, R11 / class 11).

**Four test types:**
- Smoke: Step 1.
- E2E: Steps 2 and 6.
- Unit and regression: carried by Tasks 0–16, and re-run on CI here.

---

### Loop R: Whole-branch review (Opus reviewer; no implementer)

**It waits on Task 17's CI dispatches being green.** The reviewer gets:
- the spec;
- this plan;
- `git diff origin/main...feat/format-matrix-w2a`;
- the three standing lenses (customer, owner, test design);
- the 23 AGENTS.md failure classes.

It writes its findings to `docs/superpowers/specs/2026-09-27-format-matrix-prompts/reviews/w2a-branch.md` (findings go to a file, not chat). The questions it must answer, each with file:line:
1. **Inert seams (class 1).** Is every new field read by a real consumer in production? Check `stageKind` on the bootstrap, `bracketDeciders` through the overlay, `ORGANISER_ONLY_EVENT_TYPES` in both the server check and the pad, and the six method keys in the public sentences.
2. **The precedence trap (class 19).** Does the overlay's `{ ...cfg, ...bracketDeciders(cfg) }` override an organiser's explicit choice anywhere it should not? And does a frozen snapshot win, as D2 rules?
3. **Over-refusal (class 6).** Is a legitimate settle, tie-break or finalize refused anywhere, such as after a withdrawal, after a void, or in a sport the tests did not reach?
4. **Mutants.** Does every task report carry a runner table with 0 survivors and named killers? Does every engine task carry a changed-lines Stryker report with `survived: 0`?
5. **Oracle independence (R8).** Does `packages/reference/src/families/bracket-finish.ts` read anything from the engine beyond `import type`? Did lane P2's history ever include an engine-source read in its dispatch?
6. **Counts.** Does every sweep report a non-zero count, and did each one's zero-case fail?
7. **Visual verdicts.** Does every screen in Task 17 Step 3 have a verdict at all three widths, and were the images taken after the state?

Verdict: "Ready", or "Needs fixes" with each fix routed to the loop that owns the file. A fix re-runs that loop's scoped gate and its mutants, and loop R re-reads only the fix diff.

---

## Self-review

**1. Spec coverage** (spec section → task):

| Spec | Requirement | Task |
|---|---|---|
| §1 done-when 1 | The 77 cases are green | 16 Step 1 (local), Step 3 (CI) |
| §1 done-when 2 | Judge regression: no new red anywhere, W3–W7 included | 16 Step 3 (per layer, `--expect` = the run's own ids; ruling C30) |
| §1 done-when 3 | NEW-H1 reproduced and fixed, or a false premise | 1, 10 |
| §1 done-when 4; §3; §5.3; §6 | Every ruling has a signed row in `packages/engine/rules/` and a test naming it | 2 (rows and checker); each later task names its row |
| §1 done-when 5; §9 | The gates | Every task's four types; Task 0 tooling; Global Constraints; 17 |
| §2.3 | Auto-walkover of a held fixture on withdrawal deferred to W2b (C17) | 7 Step 6 (the set stays unchanged), 8 Step 1 (Review Focus 5) |
| §2.2 | SC-O1, SC-O2, SC-X1, SC-X3, SC-O5 refusal copy, checklist §4/§7 items | 3, 4, 8, 11 (SC-O5 copy via `engineError.LEVEL_RESULT_IN_BRACKET`, 4 locales), 14 |
| §4 | Approach A: hold, then settle; no new outcome kind | 4, 7, 8 |
| §5.1 | `core.settle` kernel-owned, the ONE precondition `settleApplies` (C12), `settled_<m>`, not stage-aware; `outcomeOf` at every reader; a withdrawn winner refused (C17) | 4 (predicate), 5 (boardgame `awaitingDecider`), 8 (withdrawn guard) |
| §5.2 | `bracketDeciders`; boardgame tie-break; carrom extra board; `supportsDraws` allow-list (americano kept); stall tests rewritten | 3, 5 |
| §5.4 item 1 | Deciders by stage kind at every caller; a frozen snapshot wins | 6 |
| §5.4 items 2, 6 | Status rule; `needs_decision` in every status set | 7 |
| §5.4 items 3, 4 | Write guard; seating assertion | 8 |
| §5.4 item 5 | Organiser check | 9 |
| §5.4 item 7 | NEW-H1 `feederIsDead` | 10 |
| §5.4 item 8 | API: `openapi:gen` | 7 Step 4 (end), 17 Step 5 |
| §5.5 UI-1 | Needs-a-decision block (bracket kind AND `settleApplies`, C12), settle dialog, run-sheet chip | 11 |
| §5.5 UI-2 | Pad stage kind, Draw hidden, chess three steps | 12 |
| §5.5 public | Sentences, status line, bracket, 4 locales | 13 |
| §5.6 items 1–3 | Generator breadth, Settle in the model, adapters and page objects | 14 |
| §5.6 item 4 | Reference family `bracket-finish`, by a different agent | 15 |
| §7 | Four error codes (ruling 82 dropped the armageddon code) | 4 (declared), 5 (`TIEBREAK_NOT_APPLICABLE`), 8 (`LEVEL_RESULT_*`, including finalize on a held fixture) |
| §8 items 1–2 | Generator breadth first; reproduce before fixing | 14 (breadth, before Task 16's run), 1 |
| §8 items 3–4 | After the fixes; swiss_playoff R4 against the SW-H1 flip note; evidence and `MATRIX.md` | 16 |
| §10 | One PR, merge commit, R27 body, separate reference agent, Opus branch review, owner merges, docs as they happen | 15, 17, Loop R; models per the owner's W2a ruling (finding 26) |
| §11 | Risks: inert seam, missed status set, allow-list input change, Stryker floors, cfg freeze | 6, 7, 16, Task 0 + 17 Step 6, Review Focus 4 |

No spec requirement is unmapped.

**2. Placeholder scan.** The remaining `<…>` tokens are run-time values the executor reads off a command it just ran: `<id>`, `<PR number>`, `<tag>`, `<lane>`, `<N>`, and Task 7's `<printed by the first run>` anchors (data-driven by design, finding 13). Each is named with the command that produces it. Every "pinned from …" line names its grep or file, because the plan does not invent a helper's name it has not read.

**3. Type consistency.** These names are used identically across tasks:
- `forbidsLevelResult(kind)` (Tasks 3, 6, 8, 11, 12, 14);
- `isLevelOutcome` (3, 4, 8, 14);
- `outcomeOf(module, folded)` (4, 8, 14);
- `settleApplies(module, { outcome, abandoned, state })` and the optional `awaitingDecider(state)` hook (4, 5, 11);
- `declaredCfgs(module)` from `@seazn/engine/testkit` (3, 4, 5, 14);
- `SETTLE_METHODS` / `settledMethod` (4, 11, 13, 14);
- `TIEBREAK_RUNGS`, `BOARDGAME_TIEBREAK_TYPE`, `CHESS_SCORE` (5, 12, 13, 14);
- `resolveFixtureCfg(snapshot, divisionCfg, stage, module)`, 4 arguments (6);
- `loadFixturePadCfg → { cfg, stageKind }` (6, 11, 12);
- status `needs_decision` and `FIXTURE_STATUSES` (7, 11, 13, 14);
- `ORGANISER_ONLY_EVENT_TYPES` (9, 11, 14);
- the Task 11 testids (11, 14); the pad has NO new testids — `[data-tile-id]` / `[data-choice-option-id]` (12, 14, 17);
- `stageCfg` (14 only; the harness mirror of 6).

**4. Review Focus.** Each of the five lines has its test in its owning task:
1. → Task 8 Step 1;
2. → Task 4 Step 1 plus Task 11 Step 4;
3. → Task 4 Step 1;
4. → Task 6 Step 1 plus Task 8 Step 1;
5. → Task 8 Step 1 (ruling C17), plus Task 11 Step 4's refused-settle test.

**5. Preflight conflicts C1–C34** (`.superpowers/sdd/2026-10-08-format-matrix-w2a/preflight-scan.md`) are applied in the tasks they name; each edit cites its `C<n>`. C12, C17 and C30 follow the controller's rulings; the rest follow the scan's proposed resolutions, with the facts read from the tree.

