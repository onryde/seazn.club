# F2 — Unified Progression Field Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `stages.qualification` and `stages.seeding` — two vocabularies
that describe the same idea ("who arrives in this stage, from where, in what
order") and can never both be set on one stage — with one `stages.progression`
field that is the union of both, backed by one pure engine resolver.

**Architecture:** Today the take-rule expansion and all three placement
algorithms (`rank_order`/`snake`/`seeded_map`) are pure but live in
`apps/web/src/server/usecases/stage-seeding.ts`, next to DB-reading code that
has no business owning pure logic; and a SECOND, overlapping resolution
algorithm (`resolveQualification`) lives in the engine
(`packages/engine/src/competition/qualification.ts`) and has silently drifted
from the first — `bestNth` (stage-seeding) flags ties and refuses unequal
pools; `bestOfRank` (qualification) neither flags nor refuses, it silently
normalises (when asked) or silently compares raw (when not). This plan moves
the whole pure layer — types, take-rule expansion, placement, resolution — into
one new engine module, `packages/engine/src/competition/progression.ts`, and
converts every apps/web writer and reader to the one field it backs. The two
existing DB-orchestration flows (auto-seed-on-complete, and
propose/confirm-at-setup) are **not merged** — that is a deliberate, named
decision (Decision 3 below), not an oversight.

**Tech Stack:** TypeScript 7, Node 26, pnpm workspaces, vitest, Flyway
migrations, Next.js (App Router), 4-locale flat-dotted-key dictionaries, zod.

**Spec:** `docs/superpowers/specs/2026-08-17-format-progression-design.md`
(§2.1, §3, §5) and
`docs/superpowers/specs/2026-08-17-format-progression-prompts/F2-unified-progression-field.md`.

## Global Constraints

- **Every change ships a test that fails without it.**
- Any new or changed user-facing string goes in **all 4 locale dictionaries**
  (`apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`), never hardcoded English.
  Dictionaries use **flat dotted keys**. Do not add a key nothing reads yet —
  `i18n:check` verifies locale parity, not usage, so an unused key stays green
  while being inert (L3's reverted mistake).
- The engine (`packages/engine/src`) must not import from `apps/web` and must
  not contain user-facing English. `scripts/engine-boundary.ts` also bans
  `Date.now(`, `Math.random(`, `new Date()` and `node:*` imports there.
- Judge vitest green **only** from `--reporter=json --outputFile`
  (`numTotalTests` / `numPassedTests` / `numFailedTestSuites`). A suite that
  fails to collect reports 0 tests and 0 failures.
- Prefix `cd <abs worktree> &&` in the **same** shell call as every command;
  cwd resets to the main checkout between calls.
- New branch in a worktree (already done: `feat/f2-unified-progression-field`
  off `main` `300a36f30`), never the main checkout.
- `apps/web` typecheck peaks ~2.8 GB — **do not run a full `apps/web`
  typecheck as a verification step**; it kills subagents on the 600s
  watchdog. `npx tsc -p packages/engine --noEmit` is fast and is the gate
  for every engine-only task; a `git grep` for the deleted field names is
  the tsc-adjacent gate for the apps/web tasks.
- **F1 merges first.** `packages/engine/src/scheduling/bracket.ts`,
  `packages/engine/src/exports/build.ts`, and the `bracketToGen`/`roundTitle`
  functions inside `apps/web/src/server/usecases/stages.ts` belong to F1 —
  do not edit them here. Before opening this session's PR, **rebase onto
  merged F1** and re-run this plan's own `git grep`/gate steps against the
  rebased tree, because F1 deletes `roundTitle` and touches `bracketToGen`
  inside the same giant `stages.ts` file this plan edits in Tasks 5–6 — a
  textual conflict is likely even though the two sessions' edits are in
  logically disjoint regions of the file.
- `stages.ts`, `schemas.ts` and `stage-seeding.ts` are single-writer files for
  this whole programme — this session touches all three; no parallel work on
  them from any other session.

---

## Existing state (pinned 2026-08-17, re-pin every line reference before starting — several in the prompt had already moved)

### The four rule shapes, cross-vocabulary

| name | vocabulary | type site | Zod site |
|---|---|---|---|
| `topN` | qualification | `packages/engine/src/competition/qualification.ts:25-28` | `apps/web/src/server/api-v1/schemas.ts:492` (`TopNS`) |
| `rankRange` | seeding | `apps/web/src/server/usecases/stage-seeding.ts:43` | `schemas.ts:549-552` (`RankRangeTakeS`) |
| `bestOfRank` | qualification | `qualification.ts:29-39` | `schemas.ts:493-502` (`BestOfRankS`) |
| `bestNth` | seeding | `stage-seeding.ts:45` | `schemas.ts:554-556` (`BestNthTakeS`) |

`topNPerGroup` (seeding-only) is a **different** capability from
`topN` (qualification-only) and is **not** part of either collapse — do not
conflate them.

### Corrected line numbers (the prompt's table had drifted)

- The mutual-exclusion 422 (`SEEDING_RULES_MISSING`, "a stage declares either
  'qualification' or 'seeding', not both") is at `stages.ts:228-234`, not
  `217-222` (217-222 is the per-division-batch stage-count check, an
  unrelated guard three lines above it).
- `fillSlot` is **defined** at `stages.ts:1661-1674`, not `2303-2306` (that
  line range is a comment inside `confirmSeedProposal` describing it, not the
  function). It needs **no changes** in this plan — it writes
  `home_entrant_id`/`away_entrant_id`/clears `*_slot_label` by fixture id and
  slot number; it has never read `qualification` or `seeding`.
- `computeSeedProposal` starts at `stages.ts:2183` (prompt said `2172`);
  `confirmSeedProposal` at `stages.ts:2317` (prompt said `2172` for both —
  they are two different functions ~130 lines apart).
- `generateSeededStageFixtures` is `stages.ts:1396-1751` (prompt said
  `1376-1505` — the function is longer than quoted; 1505 is mid-function,
  the feed-wiring pass that follows the label-writing pass shown below).
- `seedNextStage` starts at `stages.ts:1868` (prompt said `1763` — that line
  is inside the `CompleteStageResult` interface's doc comment naming it, not
  the function itself).
- `qualifierCount` is at `stages.ts:757-763` (prompt's `qualifierCount`
  reference had no line number).

### Findings that change what this session must build (verified, not assumed)

1. **`from?: string` on every `QualificationSpec` leaf is dead.**
   `TakePicks.from`, `TopN.from`, `BestOfRank.from`, `RoundLosers.from`,
   `CombinedQualification.from` are all declared
   (`qualification.ts:22,26,30,45,62`) and zod-validated
   (`schemas.ts:492-511`), but **nothing in the codebase ever reads
   `.from`** — `git grep -a` across `packages/engine/src` and
   `apps/web/src` for `.from` on a qualification spec returns zero hits
   outside the declarations themselves, and neither
   `combined-qualification.test.ts` nor
   `qualification-from-any-stage.test.ts` (369 and 158 lines, sound like
   they'd cover it) sets it. `seedNextStage` (`stages.ts:1868`) always
   resolves every combined child against the **one** just-completed stage's
   tables. **Multi-source qualification — the one capability the design
   calls "the axis seeding lacks" and the one this session's own acceptance
   list requires a test for ("multi-source `sources[]` with dedupe") — has
   never actually worked server-side.** This session does not carry forward
   a working feature under a new name; it builds one for the first time.
   Task 2 implements real multi-source resolution at the engine level (pure,
   fully testable there); Task 6 wires it through `stages.ts` at the level
   the acceptance criterion requires, with an explicitly narrowed trigger
   contract (see Decision 4).
2. **`bestOfRank.normaliseUnequalPools` is implemented and unit-tested, but
   UNREACHABLE in production — it is an inert seam, not dead code.** The
   distinction matters, because "dead code" invites deletion and this is a
   working engine capability with no caller that can trigger it. Verified
   2026-08-17, all three links in the chain:
   - `resolveQualification` reads the flag and acts on it
     (`qualification.ts:274,277`), calling `normalisedRow`.
   - `normalisedRow` (`qualification.ts:153-177`) returns the **un-normalised**
     row whenever `results.length === 0` — that is its first branch.
   - The only production caller is `seedNextStage` (`stages.ts:1945`), which
     builds its `PoolTable`s from `standings_snapshots` as `{pool, rows}`
     (`stages.ts:1930-1933`). **`grep -an 'results:' stages.ts` returns
     nothing** — `.results` is never populated anywhere in that file, so
     `normalisedRow` always takes its no-op branch in production.

   The only callers that DO populate `.results` are `qualification.test.ts`
   (via its `rankedPool` helper) and `testkit/simulation.ts:796`. So the
   capability is real and green in unit tests, and cannot fire for a user.

   Consequence for this session: absorbing the field into the merged `bestNth`
   (Decision 2) regresses nothing, and does NOT oblige this session to plumb a
   per-pool match ledger through `seedNextStage`/`sourceStandingsTables`. What
   it DOES oblige is honesty about the state — see Decision 2b. What would make
   it reachable, if a later session wants it: populate `PoolTable.results` in
   `seedNextStage` from the source stage's fixture results, at which point the
   existing engine branch starts working with no engine change at all.
3. **`stage-seeding.ts:19-33`'s KNOWN GAP comment** (bestNth has no UEFA
   unequal-pools normalisation; it refuses instead,
   `SEEDING_BESTNTH_UNEQUAL_POOLS`) is answered by Decision 2b: **carried
   forward, not closed**, now on one shape with one comment instead of two
   files disagreeing silently.
4. **Three catalogue templates carry `.seeding`**: `league-playoff.json:29-33`
   (`rankRange`, `rank_order`), `euro24.json:30-43` (`topNPerGroup` **and**
   `bestNth` in the same `take[]`, `seeded_map`), `t20-super8.json:30-34,45-49`
   (`topNPerGroup` twice, `snake` then `rank_order`). The other five catalogue
   templates (`americano-night`, `box-league`, `slam128`, `swiss11`, `wc32`)
   have neither field at any stage — confirmed by `grep`, zero hits — and
   need no seeding-block edit, only the DB column rename to keep instantiating
   at all (their `insert into stages (..., seeding)` call site in
   `templates.ts:327-330` runs for every template regardless).
5. **`templates.ts`'s `instantiateTemplate` never writes `qualification`
   at all** — its insert (`templates.ts:326-331`) has six columns:
   `division_id, seq, kind, name, config, seeding`. Every catalogue template
   stage that qualifies from an earlier one does so through `.seeding`, never
   `.qualification` — confirmed by design doc §2 ("in practice only the
   catalogue templates" write `seeding`) and by `grep`, zero
   `templateStage.qualification` references anywhere in `templates.ts`.
6. **The design's own proposed `Progression` shape
   (`sources[]`/`placement` only) omits the axis the whole session exists
   to preserve**: whether a stage's fixtures appear **at setup, as TBD**
   (today: `.seeding`) or **only once its source completes** (today:
   `.qualification`). Losing that distinction silently is exactly the kind
   of drift this programme exists to end, so this plan adds it back as an
   explicit, required field — see Decision 1.

---

## Decisions this plan makes (owner ruling 4 says collapse; it does not say
## which name survives or how — this plan settles both, on evidence)

**Decision 1 — `timing` is a new, required field, not implied by field
presence.** Once `qualification` and `seeding` become one field, there is no
longer a "which column is set" signal for `generateStageFixtures` to branch
on. The DB/wire `ProgressionSchema` (apps/web only — **not** part of the
engine's pure type, which does not need it) gains:
```ts
timing: z.enum(["setup", "on_complete"])
```
required, no default (ruling 5: "strict constraints from day one, no
permissive interim state"). `"setup"` = today's `.seeding` behaviour (TBD
placeholders generated independently of source completion, propose/confirm
fill). `"on_complete"` = today's `.qualification` behaviour (auto-seed only
once the source stage completes, no propose/confirm step). Every existing
writer sets it to whichever value reproduces its **current** behaviour
exactly — Task 5 is explicit about which writer gets which value, and no
writer's default timing changes in this session (that reclassification,
e.g. giving `ko_plate` day-one fixtures, is F3's job per the prompt's "Not in
scope").

**Decision 2 — which name survives each collapse.** `rankRange` survives over
`topN` (it is strictly more expressive — `topN: n` is `rankRange{from:1,to:n}`
— and the design doc itself names this). **Consequence, not a choice**: this
makes F2 own migrating all five `topN`-emitting/detecting sites in
`format-templates.ts` (`:39,72,81,156,198`) — the prompt's "Not in scope: the
picker keeps behaving as it does now, **through the new field**" requires the
picker to compile and emit *something*, and the old `qualification.topN`
shape is being dropped from the database entirely, so there is no version of
"defer this to F3" available. `bestNth` survives over `bestOfRank`, for a
different reason than `rankRange` did: not expressiveness (they cover the
same case, "N best rank-R finishers across pools") but because `bestNth`
already carries the real, tested cross-group cascade with tie-flagging and
an explicit unequal-pools refusal (`stage-seeding.ts:299-346`,
`resolveQualifiers`), which two shipped catalogue templates
(`euro24.json`, `t20-super8.json`) already depend on, while `bestOfRank`'s
only additional field (`normaliseUnequalPools`) is the production-unreachable
inert seam documented in Finding 2 above. Both survivors keep the `kind`-tagged discriminated-union
style already used by `rankRange`/`topNPerGroup`/`bestNth` — the untagged
bare-object style (`{topN: n}`, `{bestOfRank: {...}}`) does not survive
either collapse, for consistency with the merged `TakeRule` union needing to
be exhaustively `switch`-able.

**Decision 2b — the merged `bestNth` absorbs `normaliseUnequalPools` as a
field, and this session carries the gap forward rather than closing it.**
The merged shape is
`{kind: "bestNth", nth: number, count: number, normaliseUnequalPools?: boolean}`.
Behaviour: `normaliseUnequalPools` absent/false (the default) preserves
`bestNth`'s existing refusal — unequal pool row counts throw
`SEEDING_BESTNTH_UNEQUAL_POOLS`, never silently compare. Setting it `true`
preserves `bestOfRank`'s existing (inert, per Finding 2) normalisation
attempt: the refusal is silenced, and `normalisedRow`-equivalent logic runs,
but because no caller in this codebase populates a per-pool match-result
ledger yet — not before this session, not after it — the flag today has the
same practical effect as "compare the raw ranked rows without refusing."
**This is not a new gap this session introduces**; it is the same gap
`stage-seeding.ts:19-33` already documents, now on one shape with one
comment instead of two files that disagreed about whether it existed. Wiring
real per-pool `FixtureResult` ledgers into `sourceStandingsTables` (Task 6)
would close it for real, but that is a genuine scope increase (a new DB read
per source stage, threaded through two call sites) that neither the F2
prompt's file list nor its acceptance criteria call for — the acceptance
list only requires that **neither capability silently vanishes**, which a
test proving both branches (refuse vs. silence-the-refusal) still fire
satisfies without that expansion. Task 2's tests pin both branches so a
future session that DOES wire real ledgers through has a red test the moment
it changes this behaviour, rather than a silent no-op staying green forever.

**Required alongside those tests:** the merged rule's implementation carries a
comment stating, in the code itself, that the `normaliseUnequalPools: true`
branch is unreachable in production because no caller populates
`PoolTable.results`, and that populating it in `seedNextStage` from the source
stage's fixture results is the one change that makes the existing branch start
working. Finding 2 cost a full re-derivation this session precisely because
that fact lived nowhere near the code; a plan-only record repeats the cost for
the next reader. The comment is part of Task 2's deliverable, not optional
polish.

**Decision 3 — the two DB-level flows (auto-seed-on-complete,
propose/confirm-at-setup) stay separate.** Unifying the **field** does not
mean merging `seedNextStage`'s fully-automatic completion-triggered flow with
`computeSeedProposal`/`confirmSeedProposal`'s propose-then-organiser-confirms
flow — those differ in a real product way (owner ruling, stage-seeding.ts:13:
"propose + confirm, never fully automatic") that this session is not asked to
revisit. Both flows now read the **same** `stages.progression` column and
call into the **same** engine `resolveProgression` (Task 2), branching on
`progression.timing` to decide which of the two to run — this is the "one
resolver, two orchestrations" shape, not "one resolver, one orchestration."

**Decision 4 — multi-source auto-trigger is best-effort, same shape as
today, generalised from one candidate stage to N.** `completeStage`
(`stages.ts:1793-1799`) today looks up **only** `seq > current.seq order by
seq limit 1` — the immediately next stage — and tries to seed/propose it,
swallowing failure (`STAGE_NOT_READY` etc.) silently, because the organiser
can always retry later (an explicit "Generate"/"recompute proposal" action
exists in the UI for exactly this). A multi-source progression's sources may
name stages that are not the one seq-adjacent to it. This session keeps the
trigger scoped to "check the immediately-next stage when ANY stage
completes" (unchanged) but the **resolution** itself, once triggered, is
genuinely multi-source: it builds tables for every distinct stage the
progression's `sources[]` reference, and throws (caught, swallowed, same as
today) if any of them is not yet complete. A multi-source progression whose
sources finish out of "seq order" relative to which one is `seq+1` may need a
manual recompute — this is a named, tested limitation, not a silent one; it
does not regress anything (multi-source resolution does not work **at all**
today, per Finding 1).

---

## The union — what `TakeRule` must express (design doc's table, mapped to the shipped names)

| capability | shipped `TakeRule.kind` | prior name(s) |
|---|---|---|
| `rankRange {from,to}` | `rankRange` | seeding's `rankRange`, qualification's `topN` (`from:1`) |
| `topNPerGroup {n}` | `topNPerGroup` | seeding only, unchanged |
| `bestNth {nth,count,normaliseUnequalPools?}` | `bestNth` | seeding's `bestNth`, qualification's `bestOfRank` |
| `picks [{pool,rank}]` | `picks` | qualification's `TakePicks` |
| `roundLosers {round,count}` | `roundLosers` | qualification's `RoundLosers` (L3/#414) |

Placement (`rank_order \| snake \| seeded_map`) and multi-`sources[]` with
dedupe are orthogonal to `TakeRule` and apply uniformly across all five kinds
— see the `Progression`/`ProgressionSpec` shapes in Task 1.

---

## File structure

- **Create** `packages/engine/src/competition/progression.ts` — the whole pure
  layer: types, `expandTake`, `expandSources`, `placeDescriptors`,
  `resolveProgression`, `progressionSize`. Supersedes
  `qualification.ts`'s `QualificationSpec`/`resolveQualification`/
  `qualificationSize` (deleted) and `stage-seeding.ts`'s
  `TakeRule`/`Placement`/`SlotDescriptor`/`expandTake`/`placeDescriptors`/
  `resolveQualifiers`/`validateSeedingAgainstShape` (deleted from
  `stage-seeding.ts`, re-exported from the engine instead). `placementTable`,
  `PoolTable`, and `EngineError` usage stay conceptually where they were —
  `PoolTable`/`StageTables`-equivalent shapes move into `progression.ts` too,
  since the resolver owns them now.
- **Create** `packages/engine/src/competition/progression.test.ts`.
- **Modify** `packages/engine/src/competition/index.ts` — drop the
  `qualification.ts` export, add `progression.ts`.
- **Modify** `packages/engine/src/competition/stage.ts` — import
  `PoolTable`/`StageTables`-equivalents from `./progression.ts` instead of
  `./qualification.ts`.
- **Modify** `packages/engine/src/testkit/simulation.ts` — the engine's own
  simulation harness calls `resolveQualification`/`qualificationSize` with a
  hand-built `QualificationSpec`; convert to `resolveProgression`/
  `progressionSize` with the new shape.
- **Delete** `packages/engine/src/competition/qualification.ts` and
  `qualification.test.ts` (superseded; their still-relevant assertions move
  into `progression.test.ts`).
- **Modify** `apps/web/src/server/api-v1/schemas.ts` — one `ProgressionSchema`
  replacing `QualificationSpecSchema` and `StageSeedingSchema`; `CreateStage`
  gains `progression`, loses `qualification`/`seeding`.
- **Modify** `apps/web/src/server/usecases/stage-seeding.ts` — shrinks to the
  DB-touching pieces only (`resolveSeedingSource`→generalised,
  `sourceShapeOf`, `sourceStandingsTables`, `standingsHash`,
  `destinationSlotsBySeed`); re-exports the pure types/functions from the
  engine so existing `import ... from "./stage-seeding"` call sites in
  `stages.ts` need fewer edits. Consider renaming the file to
  `stage-progression.ts` in the same commit as the rest of Task 6 if time
  allows — not required for correctness, and not done if it would touch more
  import sites than the plan already lists.
- **Modify** `apps/web/src/server/usecases/stages.ts` — `createStages`,
  `generateStageFixtures`, `generateSeededStageFixtures`, `seedNextStage`,
  `computeSeedProposal`, `confirmSeedProposal`, `qualifierCount`,
  `previewDivisionFixtures`'s `PreviewStageInput.qualification` field.
- **Modify** `apps/web/src/server/usecases/templates.ts` — `instantiateTemplate`'s
  insert and validation.
- **Modify** `apps/web/src/server/templates/schema.ts` —
  `TemplateStageSeeding` → `TemplateStageProgression`.
- **Modify** the three catalogue JSON files that carry `.seeding`:
  `league-playoff.json`, `euro24.json`, `t20-super8.json`.
- **Modify** `apps/web/src/components/v2/format-templates.ts` — `StageDraft`,
  all `qualification:` emit sites, `detectTemplate`'s `topN`/`losersOfRound`
  reads.
- **Modify** `apps/web/e2e/mobile.spec.ts:1504` — `seeding:` → `progression:`.
- **Create** `db/migration/deltas/V371__stage_progression_field.sql` —
  **provisional.** V367 is already held by two other unmerged branches
  (`feat/p8-venues-schema-ui`'s `V367__venues_and_courts.sql`,
  `feat/rs002-registration-usecases`'s `V367__registration_entry_refunds.sql`)
  and `feat/f1-bracket-round-role` took **two** numbers this session, V368
  (`V368__fixture_round_role.sql`) and V369
  (`V369__public_fixtures_round_role.sql`) — this plan was briefly numbered
  V369 before F1's second migration appeared, which is itself the evidence
  that picking a number at write time does not hold. Re-verify against `origin/main` immediately
  before opening this session's PR (see Task 4's note) — whichever of these
  branches merges last has to renumber regardless of what was free when its
  plan was written.
- **Modify** `packages/engine/src/core/errors.ts` and `errors.test.ts` — four
  new `EngineErrorCode` members.
- **Modify** `apps/web/src/server/api-v1/http.ts` — `ENGINE_HTTP` map gains
  the four new codes at 422.
- Run `npm run openapi:gen`, commit the diff.

---

### Task 1: Engine — `Progression` types, take-rule expansion, placement

**Files:**
- Create: `packages/engine/src/competition/progression.ts`
- Test: `packages/engine/src/competition/progression.test.ts`

**Interfaces:**
```ts
export interface PoolRankPick { pool: string; rank: number }

export type TakeRule =
  | { kind: "rankRange"; from: number; to: number }
  | { kind: "topNPerGroup"; n: number }
  | { kind: "bestNth"; nth: number; count: number; normaliseUnequalPools?: boolean }
  | { kind: "picks"; picks: readonly PoolRankPick[] }
  | { kind: "roundLosers"; round: number; count: number };

export interface ProgressionSource {
  stage: "previous" | { stageId: string };
  take: readonly TakeRule[];
}

export interface SeededMapEntry { slot: string; source: string }

/** The pure, engine-facing shape — deliberately WITHOUT `timing`. When a
 *  stage's fixtures appear (at setup vs. on source completion) is an
 *  apps/web orchestration decision (Decision 1), not something the take-rule/
 *  placement/resolution math needs to know. apps/web's `ProgressionSchema`
 *  (schemas.ts) is `ProgressionSpec & { timing: "setup" | "on_complete" }`. */
export interface ProgressionSpec {
  sources: readonly ProgressionSource[];
  placement: "rank_order" | "snake" | "seeded_map";
  map?: readonly SeededMapEntry[];
}

export type SlotDescriptor =
  | { kind: "group_rank"; pool: string; rank: number }
  | { kind: "rank_range"; rank: number }
  | { kind: "best_nth"; nth: number; position: number; normaliseUnequalPools?: boolean }
  | { kind: "round_loser"; round: number; position: number };

export interface SlotLabel { key: string; params: Record<string, unknown> }

export interface SourceShape {
  /** Pool KEYS in stable order ('A','B',…), or [] for an ungrouped/single-table source (league/swiss). */
  poolKeys: string[];
}

/** A descriptor tagged with WHICH `ProgressionSource` (index into
 *  `spec.sources`) it came from — the piece neither prior implementation
 *  needed, because neither supported more than one real source stage
 *  (Finding 1). Index 0 for every single-source progression, which is every
 *  progression this session's writers emit — multi-source is new capability,
 *  exercised only by this task's own tests plus one Task 6 DB integration
 *  test. */
export interface SourcedSlot { sourceIndex: number; descriptor: SlotDescriptor }
```

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine/src/competition/progression.test.ts
import { describe, expect, it } from "vitest";
import {
  descriptorKey,
  descriptorLabel,
  expandSources,
  expandTake,
  placeDescriptors,
  type ProgressionSource,
  type SourceShape,
  type TakeRule,
} from "./progression.ts";

const GROUPED: SourceShape = { poolKeys: ["A", "B"] };
const UNGROUPED: SourceShape = { poolKeys: [] };

describe("expandTake", () => {
  it("rankRange expands to one pot, one descriptor per rank — the topN replacement", () => {
    const take: TakeRule[] = [{ kind: "rankRange", from: 1, to: 3 }];
    expect(expandTake(take, UNGROUPED)).toEqual([
      [
        { kind: "rank_range", rank: 1 },
        { kind: "rank_range", rank: 2 },
        { kind: "rank_range", rank: 3 },
      ],
    ]);
  });

  it("topNPerGroup expands wave-major across the source's real pool count", () => {
    const take: TakeRule[] = [{ kind: "topNPerGroup", n: 2 }];
    expect(expandTake(take, GROUPED)).toEqual([
      [
        { kind: "group_rank", pool: "A", rank: 1 },
        { kind: "group_rank", pool: "B", rank: 1 },
      ],
      [
        { kind: "group_rank", pool: "A", rank: 2 },
        { kind: "group_rank", pool: "B", rank: 2 },
      ],
    ]);
  });

  it("bestNth carries normaliseUnequalPools onto every emitted descriptor", () => {
    const take: TakeRule[] = [{ kind: "bestNth", nth: 3, count: 2, normaliseUnequalPools: true }];
    expect(expandTake(take, GROUPED)).toEqual([
      [
        { kind: "best_nth", nth: 3, position: 1, normaliseUnequalPools: true },
        { kind: "best_nth", nth: 3, position: 2, normaliseUnequalPools: true },
      ],
    ]);
  });

  it("picks expands to one singleton pot PER pick, in declaration order — never reordered", () => {
    // Declaration order is data (gotcha carried forward verbatim): each pick
    // is its own pot so placement:"snake" (a 1-element pot reversed is
    // itself) can never silently reorder a literal enumeration.
    const take: TakeRule[] = [{ kind: "picks", picks: [{ pool: "B", rank: 1 }, { pool: "A", rank: 1 }] }];
    expect(expandTake(take, GROUPED)).toEqual([
      [{ kind: "group_rank", pool: "B", rank: 1 }],
      [{ kind: "group_rank", pool: "A", rank: 1 }],
    ]);
  });

  it("roundLosers expands to one pot of round_loser descriptors, sized by count (design's closing note — L3/#414's bracket->plate can pre-generate like any other take rule)", () => {
    const take: TakeRule[] = [{ kind: "roundLosers", round: 1, count: 4 }];
    expect(expandTake(take, UNGROUPED)).toEqual([
      [
        { kind: "round_loser", round: 1, position: 1 },
        { kind: "round_loser", round: 1, position: 2 },
        { kind: "round_loser", round: 1, position: 3 },
        { kind: "round_loser", round: 1, position: 4 },
      ],
    ]);
  });
});

describe("expandSources", () => {
  it("tags every descriptor with its source index, in source declaration order", () => {
    const sources: ProgressionSource[] = [
      { stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] },
      { stage: { stageId: "s1" }, take: [{ kind: "rankRange", from: 1, to: 1 }] },
    ];
    const shapeOf = () => UNGROUPED;
    const pots = expandSources(sources, shapeOf);
    expect(pots).toEqual([
      [
        { sourceIndex: 0, descriptor: { kind: "rank_range", rank: 1 } },
        { sourceIndex: 0, descriptor: { kind: "rank_range", rank: 2 } },
      ],
      [{ sourceIndex: 1, descriptor: { kind: "rank_range", rank: 1 } }],
    ]);
  });
});

describe("placeDescriptors", () => {
  it("rank_order flattens pots in declaration order (single-source, unchanged from stage-seeding.ts)", () => {
    const pots = expandSources(
      [{ stage: "previous", take: [{ kind: "topNPerGroup", n: 2 }] }],
      () => GROUPED,
    );
    const placed = placeDescriptors(pots, "rank_order");
    expect(placed.map((s) => s.descriptor)).toEqual([
      { kind: "group_rank", pool: "A", rank: 1 },
      { kind: "group_rank", pool: "B", rank: 1 },
      { kind: "group_rank", pool: "A", rank: 2 },
      { kind: "group_rank", pool: "B", rank: 2 },
    ]);
  });

  it("snake reverses every other pot (World Cup convention, unchanged)", () => {
    const pots = expandSources(
      [{ stage: "previous", take: [{ kind: "topNPerGroup", n: 2 }] }],
      () => GROUPED,
    );
    const placed = placeDescriptors(pots, "snake");
    expect(placed.map((s) => s.descriptor)).toEqual([
      { kind: "group_rank", pool: "A", rank: 1 },
      { kind: "group_rank", pool: "B", rank: 1 },
      { kind: "group_rank", pool: "B", rank: 2 },
      { kind: "group_rank", pool: "A", rank: 2 },
    ]);
  });

  it("seeded_map overrides named seats, fills the rest in relative order — the euro24 shape", () => {
    const pots = expandSources(
      [
        {
          stage: "previous",
          take: [
            { kind: "topNPerGroup", n: 1 },
            { kind: "bestNth", nth: 3, count: 2 },
          ],
        },
      ],
      () => ({ poolKeys: ["A", "B", "C", "D"] }),
    );
    const placed = placeDescriptors(pots, "seeded_map", [
      { slot: "5", source: "best:2" },
      { slot: "6", source: "best:1" },
    ]);
    expect(placed[4]!.descriptor).toEqual({ kind: "best_nth", nth: 3, position: 2 });
    expect(placed[5]!.descriptor).toEqual({ kind: "best_nth", nth: 3, position: 1 });
    // unclaimed seats (the four group winners) fill 1..4 in their own order
    expect(placed[0]!.descriptor).toEqual({ kind: "group_rank", pool: "A", rank: 1 });
  });

  it("seeded_map still 422s on an out-of-range slot or an unknown source (carried verbatim)", () => {
    const pots = expandSources(
      [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] }],
      () => UNGROUPED,
    );
    expect(() => placeDescriptors(pots, "seeded_map", [{ slot: "9", source: "rank:1" }])).toThrow(
      /outside the 1\.\.2 seed range/,
    );
    expect(() => placeDescriptors(pots, "seeded_map", [{ slot: "1", source: "nope" }])).toThrow(
      /does not match any qualifier/,
    );
  });
});

describe("descriptorKey / descriptorLabel", () => {
  it("round_loser gets its own key and i18n pattern ref", () => {
    const d: import("./progression.ts").SlotDescriptor = { kind: "round_loser", round: 1, position: 3 };
    expect(descriptorKey(d)).toBe("loser:1:3");
    expect(descriptorLabel(d)).toEqual({ key: "slot.round_loser", params: { round: 1, n: 3 } });
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
cd <worktree>/packages/engine && npx vitest run src/competition/progression.test.ts --reporter=json --outputFile=/tmp/f2-t1.json > /tmp/f2-t1.log 2>&1; echo "EXIT=$?"
jq '{total:.numTotalTests,failedSuites:.numFailedTestSuites}' /tmp/f2-t1.json
```
Expected: failed suite, 0 tests — `./progression.ts` does not exist yet.

- [ ] **Step 3: Write the implementation**

```ts
// packages/engine/src/competition/progression.ts
//
// The unified progression field (design doc §2.1/§3, F2). Neither the OLD
// `qualification` vocabulary nor the OLD `seeding` vocabulary was a superset
// of the other — qualification alone could express multiple SOURCE stages
// with dedupe; seeding alone could express a group-count-agnostic take
// pattern and a real DRAW (snake/seeded_map). This module is the union: one
// TakeRule type covering every prior spec shape, one placement algorithm,
// one resolver. Pure — no DB, no tenant, idempotent.
import { EngineError } from "../core/errors.ts";
import type { EntrantId } from "../core/types.ts";
import {
  foldResults,
  resultsAmong,
  type FixtureResult,
  type StandingsRow,
} from "./standings.ts";
import { rankStandings } from "./tiebreakers.ts";

export interface PoolRankPick {
  pool: string;
  rank: number;
}

// The union table (design doc §2.1, F2 prompt): rankRange survives topN
// (topN:n IS rankRange{from:1,to:n} — the design doc names this directly);
// bestNth survives bestOfRank (bestNth already has the real cross-group
// cascade + tie-flagging + unequal-pools refusal two shipped catalogue
// templates depend on; bestOfRank's only extra field,
// normaliseUnequalPools, is absorbed here — see this repo's F2 plan
// Decision 2b for why it is carried forward rather than newly wired to a
// real per-pool match ledger). picks/roundLosers are qualification's
// TakePicks/RoundLosers, unchanged in meaning, given the kind-tagged shape
// the rest of this union already uses.
export type TakeRule =
  | { kind: "rankRange"; from: number; to: number }
  | { kind: "topNPerGroup"; n: number }
  | { kind: "bestNth"; nth: number; count: number; normaliseUnequalPools?: boolean }
  | { kind: "picks"; picks: readonly PoolRankPick[] }
  | { kind: "roundLosers"; round: number; count: number };

export interface ProgressionSource {
  stage: "previous" | { stageId: string };
  take: readonly TakeRule[];
}

export interface SeededMapEntry {
  slot: string;
  source: string;
}

// Deliberately WITHOUT a "when do these fixtures appear" field — that is an
// apps/web orchestration decision (createStages / generateStageFixtures),
// not something take-rule/placement/resolution math needs. apps/web's wire
// ProgressionSchema is this shape plus `timing`.
export interface ProgressionSpec {
  sources: readonly ProgressionSource[];
  placement: "rank_order" | "snake" | "seeded_map";
  map?: readonly SeededMapEntry[];
}

// WHO a not-yet-filled slot represents, independent of whether the source
// stage has finished (shape) or has real standings (resolution).
// `descriptorKey` is the wire identity `seeded_map.source` matches against;
// `descriptorLabel` is the i18n pattern ref persisted onto
// fixtures.home/away_slot_label.
export type SlotDescriptor =
  | { kind: "group_rank"; pool: string; rank: number }
  | { kind: "rank_range"; rank: number }
  | { kind: "best_nth"; nth: number; position: number; normaliseUnequalPools?: boolean }
  | { kind: "round_loser"; round: number; position: number };

export interface SlotLabel {
  key: string;
  params: Record<string, unknown>;
}

export interface SourceShape {
  poolKeys: string[];
}

/** A descriptor tagged with which `ProgressionSpec.sources[]` entry produced
 *  it. Index 0 for every single-source progression — every progression this
 *  session's writers emit is single-source; multi-source is new capability
 *  (Finding 1: it never worked before this module). */
export interface SourcedSlot {
  sourceIndex: number;
  descriptor: SlotDescriptor;
}

export function descriptorKey(d: SlotDescriptor): string {
  switch (d.kind) {
    case "group_rank":
      return `${d.pool}${d.rank}`;
    case "rank_range":
      return `rank:${d.rank}`;
    case "best_nth":
      return `best:${d.position}`;
    case "round_loser":
      return `loser:${d.round}:${d.position}`;
  }
}

export function descriptorLabel(d: SlotDescriptor): SlotLabel {
  switch (d.kind) {
    case "group_rank":
      if (d.rank === 1) return { key: "slot.winner_group", params: { g: d.pool } };
      if (d.rank === 2) return { key: "slot.runner_up_group", params: { g: d.pool } };
      return { key: "slot.nth_group", params: { n: d.rank, g: d.pool } };
    case "rank_range":
      return { key: "slot.rank_range", params: { rank: d.rank } };
    case "best_nth":
      return { key: "slot.best_nth", params: { rank: d.position, nth: d.nth } };
    case "round_loser":
      return { key: "slot.round_loser", params: { round: d.round, n: d.position } };
  }
}

function expandOne(rule: TakeRule, shape: SourceShape): SlotDescriptor[][] {
  switch (rule.kind) {
    case "rankRange": {
      const pot: SlotDescriptor[] = [];
      for (let r = rule.from; r <= rule.to; r++) pot.push({ kind: "rank_range", rank: r });
      return [pot];
    }
    case "topNPerGroup": {
      const pools = shape.poolKeys.length > 0 ? shape.poolKeys : [""];
      const pots: SlotDescriptor[][] = [];
      // WAVE-major, not pool-major: every group's winner (wave 1) before any
      // group's runner-up (wave 2) — the standard tournament convention, and
      // what makes "snake" meaningful.
      for (let wave = 1; wave <= rule.n; wave++) {
        pots.push(pools.map((pool) => ({ kind: "group_rank", pool, rank: wave })));
      }
      return pots;
    }
    case "bestNth": {
      const pot: SlotDescriptor[] = [];
      for (let i = 1; i <= rule.count; i++) {
        pot.push({
          kind: "best_nth",
          nth: rule.nth,
          position: i,
          ...(rule.normaliseUnequalPools !== undefined
            ? { normaliseUnequalPools: rule.normaliseUnequalPools }
            : {}),
        });
      }
      return [pot];
    }
    case "picks":
      // Declaration order is data — one singleton pot PER pick so no
      // placement (snake included) can ever reorder a literal enumeration.
      return rule.picks.map((p) => [{ kind: "group_rank", pool: p.pool, rank: p.rank }]);
    case "roundLosers": {
      const pot: SlotDescriptor[] = [];
      for (let i = 1; i <= rule.count; i++) pot.push({ kind: "round_loser", round: rule.round, position: i });
      return [pot];
    }
  }
}

export function expandTake(take: readonly TakeRule[], shape: SourceShape): SlotDescriptor[][] {
  return take.flatMap((rule) => expandOne(rule, shape));
}

/** Total qualifier count across every rule, every kind — never throws (a
 *  read path, previewDivisionFixtures, sizes a stage graph with it). */
export function progressionSize(take: readonly TakeRule[]): number {
  return take.reduce((n, rule) => {
    if (rule.kind === "rankRange") return n + Math.max(0, rule.to - rule.from + 1);
    if (rule.kind === "topNPerGroup") return n; // group-count-dependent; callers with a real shape use expandTake instead
    if (rule.kind === "bestNth") return n + rule.count;
    if (rule.kind === "picks") return n + rule.picks.length;
    return n + rule.count; // roundLosers
  }, 0);
}

/** Flatten every source's pots, IN SOURCE DECLARATION ORDER, tagging each
 *  descriptor with which source produced it. `shapeOf` is a callback rather
 *  than an array because callers resolve shape lazily (a source stage's
 *  pool count may need its own DB read, per source). */
export function expandSources(
  sources: readonly ProgressionSource[],
  shapeOf: (sourceIndex: number) => SourceShape,
): SourcedSlot[][] {
  return sources.flatMap((source, sourceIndex) =>
    expandTake(source.take, shapeOf(sourceIndex)).map((pot) =>
      pot.map((descriptor) => ({ sourceIndex, descriptor })),
    ),
  );
}

function snakeMerge(pots: readonly SourcedSlot[][]): SourcedSlot[] {
  return pots.flatMap((pot, i) => (i % 2 === 0 ? pot : [...pot].reverse()));
}

/** Resolve `sources[].take`'s pots + `placement` into the final seed 1..N
 *  order. `seeded_map` entries are validated here (unknown source /
 *  out-of-range or duplicate slot) — the "422 at rule save, not at proposal
 *  time" contract carried forward from stage-seeding.ts.
 *
 *  KNOWN LIMITATION, not fixed here: `seeded_map`'s `source` string matches
 *  against `descriptorKey`, which does not encode which SOURCE a descriptor
 *  came from. A seeded_map entry against a multi-source progression whose
 *  two sources happen to emit the same descriptor key (e.g. both have a
 *  "group_rank A1") resolves to whichever pot's copy `flat()` visits first.
 *  This is the same single-source assumption stage-seeding.ts always made;
 *  F2 does not test or fix the seeded_map + multi-source combination — no
 *  shipped writer produces it. */
export function placeDescriptors(
  pots: readonly SourcedSlot[][],
  placement: "rank_order" | "snake" | "seeded_map",
  map?: readonly SeededMapEntry[],
): SourcedSlot[] {
  const flat = placement === "snake" ? snakeMerge(pots) : pots.flat();
  if (placement !== "seeded_map" || !map || map.length === 0) return flat;

  const total = flat.length;
  const byKey = new Map(flat.map((s) => [descriptorKey(s.descriptor), s] as const));
  const seats: (SourcedSlot | undefined)[] = new Array(total).fill(undefined);
  const claimed = new Set<string>();

  for (const entry of map) {
    const seat = Number(entry.slot);
    if (!Number.isInteger(seat) || seat < 1 || seat > total) {
      throw new EngineError(
        "SEEDING_MAP_SLOT_INVALID",
        `seeded_map slot "${entry.slot}" is outside the 1..${total} seed range`,
        { slot: entry.slot, total },
      );
    }
    const slot = byKey.get(entry.source);
    if (!slot) {
      throw new EngineError(
        "SEEDING_MAP_SOURCE_INVALID",
        `seeded_map source "${entry.source}" does not match any qualifier this stage's rules produce`,
        { source: entry.source, available: [...byKey.keys()] },
      );
    }
    if (seats[seat - 1] !== undefined) {
      throw new EngineError("SEEDING_MAP_SLOT_INVALID", `seeded_map assigns seed ${seat} more than once`, {
        slot: seat,
      });
    }
    seats[seat - 1] = slot;
    claimed.add(entry.source);
  }

  const remaining = flat.filter((s) => !claimed.has(descriptorKey(s.descriptor)));
  let ri = 0;
  for (let i = 0; i < total; i++) {
    if (seats[i] === undefined) seats[i] = remaining[ri++];
  }
  return seats as SourcedSlot[];
}

/** The full "does this progression actually resolve" check every WRITER
 *  must run before trusting it (createStages/replaceStages, and
 *  templates.ts's instantiateTemplate): expand every source's take against
 *  its real shape, let placeDescriptors validate a seeded_map's
 *  slot/source references, then require at least 2 qualifiers total. */
export function validateProgressionAgainstShapes(
  shapes: readonly SourceShape[],
  progression: Pick<ProgressionSpec, "sources" | "placement" | "map">,
): void {
  const pots = expandSources(progression.sources, (i) => shapes[i]!);
  placeDescriptors(pots, progression.placement, progression.map); // throws on a bad seeded_map
  const total = pots.reduce((n, p) => n + p.length, 0);
  if (total < 2) {
    throw new EngineError("SEEDING_RULES_MISSING", "this stage's progression rules produce fewer than 2 qualifiers");
  }
}
```

`progressionSize`'s `topNPerGroup` branch deliberately returns `n` unchanged
(cannot size a group-count-dependent rule without a real `SourceShape`) —
this mirrors `qualificationSize`'s old behaviour exactly (it never saw
`topNPerGroup` at all, since that rule was seeding-only) and matches
`previewDivisionFixtures`'s existing `|| 4` fallback at the call site
(Task 6) for any spec `progressionSize` cannot fully size.

- [ ] **Step 4: Run the test and confirm it passes**

Re-run Step 2's command. Expected: every `describe` block green,
`numFailedTestSuites: 0`.

- [ ] **Step 5: Add the four new EngineErrorCode members**

`placeDescriptors`/`validateProgressionAgainstShapes` above now throw
`EngineError`, not `HttpError` — they moved from apps/web (free-string codes)
into the engine (a closed, append-only enum). Add, at the end of the list in
`packages/engine/src/core/errors.ts` (append-only — "existing order frozen"):

```ts
  // F2 (unified progression field) — placeDescriptors/
  // validateProgressionAgainstShapes moved from apps/web's stage-seeding.ts
  // into the engine; these four codes moved with them, string-for-string, so
  // the wire-visible error.code an existing client sees is unchanged.
  "SEEDING_RULES_MISSING",
  "SEEDING_MAP_SLOT_INVALID",
  "SEEDING_MAP_SOURCE_INVALID",
  "SEEDING_BESTNTH_UNEQUAL_POOLS",
```

Mirror the same four additions, same order, into
`packages/engine/src/core/errors.test.ts`'s `EngineErrorCode.options` array
(the "code taxonomy matches spec 03 §7" test — this is the append-only
assertion the file's own comment warns about). Then, in
`apps/web/src/server/api-v1/http.ts`'s `ENGINE_HTTP` map, add all four at
`422` (same status every other business-rule engine code gets):

```ts
  SEEDING_RULES_MISSING: 422,
  SEEDING_MAP_SLOT_INVALID: 422,
  SEEDING_MAP_SOURCE_INVALID: 422,
  SEEDING_BESTNTH_UNEQUAL_POOLS: 422,
```

- [ ] **Step 6: Run the errors test and the engine boundary gate**

```bash
cd <worktree>/packages/engine && npx vitest run src/core/errors.test.ts --reporter=json --outputFile=/tmp/f2-t1-errors.json > /tmp/f2-t1-errors.log 2>&1; echo "EXIT=$?"
cd <worktree> && npx tsx scripts/engine-boundary.ts; echo "EXIT=$?"
```
Expected: both `EXIT=0`.

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/competition/progression.ts packages/engine/src/competition/progression.test.ts packages/engine/src/core/errors.ts packages/engine/src/core/errors.test.ts apps/web/src/server/api-v1/http.ts
git commit -m "engine(F2): unify take-rule expansion and placement into progression.ts"
```

---

### Task 2: Engine — `resolveProgression` (multi-source, dedupe, ties, bestNth refusal)

**Files:**
- Modify: `packages/engine/src/competition/progression.ts` (add resolution)
- Modify: `packages/engine/src/competition/progression.test.ts`

**Interfaces:**
```ts
export interface PoolTable {
  pool: string;
  rows: readonly StandingsRow[];
  results?: readonly FixtureResult[]; // only read when normaliseUnequalPools is true
}
export interface BracketFixtureRow {
  round: number;
  loser?: EntrantId;
}
export interface SourceTables {
  pools: readonly PoolTable[];
  bracket?: readonly BracketFixtureRow[]; // only present for a bracket-kind source; only roundLosers reads it
}
export interface ResolvedProgressionEntry {
  seed: number;
  sourceIndex: number;
  descriptor: SlotDescriptor;
  entrantId: EntrantId;
  rank: number;
  tieUnbroken: boolean;
}
export interface ProgressionTieFlag {
  descriptors: SlotDescriptor[];
  entrantIds: EntrantId[];
  reason: string;
}
export function resolveProgression(
  spec: ProgressionSpec,
  shapes: readonly SourceShape[],
  tables: readonly SourceTables[],
): { qualifiers: ResolvedProgressionEntry[]; ties: ProgressionTieFlag[] };

export function placementTable(finalRanks: readonly EntrantId[]): PoolTable; // unchanged from qualification.ts
```

`shapes`/`tables` are index-aligned with `spec.sources` — the SAME two-read
shape both existing DB call sites (`seedNextStage`, `computeSeedProposal`)
already use (shape from `pools`/`config`, tables from
`standings_snapshots`), just per-source instead of singular.

- [ ] **Step 1: Write the failing tests**

```ts
describe("resolveProgression", () => {
  const leagueTable = (ranked: string[]): SourceTables => ({
    pools: [{ pool: "", rows: ranked.map((entrantId, i) => ({ entrantId, rank: i + 1 }) as StandingsRow) }],
  });

  it("resolves rankRange against a single source — the topN replacement, same answer", () => {
    const spec: ProgressionSpec = {
      sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] }],
      placement: "rank_order",
    };
    const { qualifiers } = resolveProgression(spec, [{ poolKeys: [] }], [leagueTable(["e1", "e2", "e3"])]);
    expect(qualifiers.map((q) => q.entrantId)).toEqual(["e1", "e2"]);
  });

  it("resolves multi-source, in source declaration order, and dedupes across them", () => {
    // The capability the design calls the axis seeding lacks, and Finding 1
    // establishes never actually worked server-side before this module.
    const spec: ProgressionSpec = {
      sources: [
        { stage: "previous", take: [{ kind: "rankRange", from: 1, to: 1 }] },
        { stage: { stageId: "s0" }, take: [{ kind: "rankRange", from: 1, to: 1 }] },
      ],
      placement: "rank_order",
    };
    const { qualifiers } = resolveProgression(
      spec,
      [{ poolKeys: [] }, { poolKeys: [] }],
      [leagueTable(["e1", "e2"]), leagueTable(["e3", "e4"])],
    );
    expect(qualifiers.map((q) => q.entrantId)).toEqual(["e1", "e3"]);
  });

  it("rejects an entrant qualifying through two sources, with a code", () => {
    const spec: ProgressionSpec = {
      sources: [
        { stage: "previous", take: [{ kind: "rankRange", from: 1, to: 1 }] },
        { stage: { stageId: "s0" }, take: [{ kind: "rankRange", from: 1, to: 1 }] },
      ],
      placement: "rank_order",
    };
    expect(() =>
      resolveProgression(
        spec,
        [{ poolKeys: [] }, { poolKeys: [] }],
        [leagueTable(["e1"]), leagueTable(["e1"])],
      ),
    ).toThrow(/qualifies through more than one/);
    try {
      resolveProgression(spec, [{ poolKeys: [] }, { poolKeys: [] }], [leagueTable(["e1"]), leagueTable(["e1"])]);
    } catch (err) {
      expect(EngineError.is(err, "QUALIFICATION_INVALID")).toBe(true);
    }
  });

  it("bestNth refuses unequal pool sizes by default (carried from stage-seeding.ts, never silently ranks raw stats)", () => {
    const tables: SourceTables = {
      pools: [
        { pool: "A", rows: [{ entrantId: "a1", rank: 1 }, { entrantId: "a2", rank: 2 }] as StandingsRow[] },
        { pool: "B", rows: [{ entrantId: "b1", rank: 1 }, { entrantId: "b2", rank: 2 }, { entrantId: "b3", rank: 3 }] as StandingsRow[] },
      ],
    };
    const spec: ProgressionSpec = {
      sources: [{ stage: "previous", take: [{ kind: "bestNth", nth: 2, count: 2 }] }],
      placement: "rank_order",
    };
    expect(() => resolveProgression(spec, [{ poolKeys: ["A", "B"] }], [tables])).toThrow(
      /cannot compare rank-2 finishers across pools of different sizes/,
    );
  });

  it("bestNth with normaliseUnequalPools:true silences the refusal — Decision 2b, absorbed not newly wired", () => {
    const tables: SourceTables = {
      pools: [
        { pool: "A", rows: [{ entrantId: "a1", rank: 1 }, { entrantId: "a2", rank: 2 }] as StandingsRow[] },
        { pool: "B", rows: [{ entrantId: "b1", rank: 1 }, { entrantId: "b2", rank: 2 }, { entrantId: "b3", rank: 3 }] as StandingsRow[] },
      ],
    };
    const spec: ProgressionSpec = {
      sources: [
        { stage: "previous", take: [{ kind: "bestNth", nth: 2, count: 2, normaliseUnequalPools: true }] },
      ],
      placement: "rank_order",
    };
    const { qualifiers } = resolveProgression(spec, [{ poolKeys: ["A", "B"] }], [tables]);
    expect(qualifiers).toHaveLength(2);
  });

  it("roundLosers reads the source's bracket, equality-filters by round, never sorts by it (sparse round numbering)", () => {
    const tables: SourceTables = {
      pools: [],
      bracket: [
        { round: 1, loser: "l1" },
        { round: 1, loser: "l2" },
        { round: 2, loser: "l3" },
      ],
    };
    const spec: ProgressionSpec = {
      sources: [{ stage: "previous", take: [{ kind: "roundLosers", round: 1, count: 2 }] }],
      placement: "rank_order",
    };
    const { qualifiers } = resolveProgression(spec, [{ poolKeys: [] }], [tables]);
    expect(qualifiers.map((q) => q.entrantId)).toEqual(["l1", "l2"]);
  });

  it("flags a tie instead of silently ordering it — never trusts the deterministic seed/id fallback", () => {
    const tied: StandingsRow[] = [
      { entrantId: "a", rank: 1 },
      { entrantId: "b", rank: 1, tieUnbroken: true, tieBreak: { key: "seed", with: ["c"] } } as StandingsRow,
      { entrantId: "c", rank: 1, tieUnbroken: true, tieBreak: { key: "seed", with: ["b"] } } as StandingsRow,
    ];
    const spec: ProgressionSpec = {
      sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 1 }] }],
      placement: "rank_order",
    };
    const { ties } = resolveProgression(spec, [{ poolKeys: [] }], [{ pools: [{ pool: "", rows: tied }] }]);
    expect(ties).toHaveLength(0); // the resolver never even reaches b/c: rank 1's row (a) already answers rankRange{1,1}
  });

  it("picks resolve positionally, never resorted — declaration order IS seed order", () => {
    const tables: SourceTables = {
      pools: [
        { pool: "A", rows: [{ entrantId: "a1", rank: 1 }] as StandingsRow[] },
        { pool: "B", rows: [{ entrantId: "b1", rank: 1 }] as StandingsRow[] },
      ],
    };
    const spec: ProgressionSpec = {
      sources: [
        {
          stage: "previous",
          take: [{ kind: "picks", picks: [{ pool: "B", rank: 1 }, { pool: "A", rank: 1 }] }],
        },
      ],
      placement: "rank_order",
    };
    const { qualifiers } = resolveProgression(spec, [{ poolKeys: ["A", "B"] }], [tables]);
    expect(qualifiers.map((q) => q.entrantId)).toEqual(["b1", "a1"]);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
cd <worktree>/packages/engine && npx vitest run src/competition/progression.test.ts --reporter=json --outputFile=/tmp/f2-t2.json > /tmp/f2-t2.log 2>&1; echo "EXIT=$?"
```
Expected: the new `describe("resolveProgression", …)` block fails — `resolveProgression` is not exported yet — while Task 1's tests still pass.

- [ ] **Step 3: Implement `resolveProgression`**, appended to `progression.ts`:

```ts
export interface PoolTable {
  pool: string;
  rows: readonly StandingsRow[];
  // Only consulted when a best_nth descriptor carries
  // normaliseUnequalPools:true (Decision 2b) — absent for every caller in
  // this codebase today, matching production behaviour before this session.
  results?: readonly FixtureResult[];
}
export interface BracketFixtureRow {
  round: number;
  loser?: EntrantId;
}
export interface SourceTables {
  pools: readonly PoolTable[];
  bracket?: readonly BracketFixtureRow[];
}
export interface ResolvedProgressionEntry {
  seed: number;
  sourceIndex: number;
  descriptor: SlotDescriptor;
  entrantId: EntrantId;
  rank: number;
  tieUnbroken: boolean;
}
export interface ProgressionTieFlag {
  descriptors: SlotDescriptor[];
  entrantIds: EntrantId[];
  reason: string;
}

const normPool = (s: string): string => s.trim().toLowerCase().replace(/^pool\s+/, "");

function findPool(pools: readonly PoolTable[], pool: string): PoolTable {
  const want = normPool(pool);
  const table = pools.find((p) => normPool(p.pool) === want);
  if (!table) {
    throw new EngineError(
      "STAGE_NOT_READY",
      `no pool "${pool || "overall"}" in the source stage — available pools: ${pools.map((p) => p.pool).join(", ")}`,
      { pool, available: pools.map((p) => p.pool) },
    );
  }
  return table;
}

function rowAtRank(table: PoolTable, rank: number): StandingsRow {
  const row = table.rows.find((r) => r.rank === rank);
  if (!row) {
    throw new EngineError("STAGE_NOT_READY", `pool "${table.pool}" has no entrant ranked ${rank} yet`, {
      pool: table.pool,
      rank,
    });
  }
  return row;
}

// UEFA "drop the lowest-ranked pool member's results" normalisation
// (Decision 2b) — unchanged from qualification.ts's normalisedRow, moved
// verbatim. A no-op when `results` is absent or empty, which is every
// caller in this codebase today.
function normalisedRow(table: PoolTable, candidateId: EntrantId): StandingsRow {
  const results = table.results ?? [];
  const bottom = table.rows[table.rows.length - 1];
  if (bottom === undefined || bottom.entrantId === candidateId || results.length === 0) {
    const full = table.rows.find((row) => row.entrantId === candidateId);
    if (full === undefined) {
      throw new EngineError("STAGE_NOT_READY", `candidate "${candidateId}" not in its pool table`, { candidateId });
    }
    return full;
  }
  const survivors = table.rows.map((row) => row.entrantId).filter((id) => id !== bottom.entrantId);
  const kept = resultsAmong(new Set(survivors), results);
  const refolded = foldResults(survivors, kept);
  const row = refolded.find((entry) => entry.entrantId === candidateId);
  if (!row) {
    throw new EngineError("STAGE_NOT_READY", `candidate "${candidateId}" not in its pool table`, { candidateId });
  }
  return row;
}

// Same cascade both prior implementations already used verbatim
// (orderCandidates in qualification.ts, crossGroupOrder in
// stage-seeding.ts) — unifying it is a rename, not a behaviour change.
function crossGroupOrder(rows: StandingsRow[]): StandingsRow[] {
  return rankStandings(rows, { cascade: ["points", "diff", "for", "wins"] }).rows;
}

function loserAt(bracket: readonly BracketFixtureRow[] | undefined, round: number, position: number): StandingsRow {
  if (!bracket) {
    throw new EngineError("STAGE_NOT_READY", "roundLosers needs the completed stage's bracket fixtures", { round });
  }
  // Equality-filter only — never arithmetic on `round` (rounds number
  // sparsely: 1,2,3 on a winners' side, 7-10 on a losers' side). The
  // filtered array's order IS bracket position; the CALLER that assembled
  // `bracket` is the ordering authority, not this function.
  const losers = bracket.filter(
    (f): f is BracketFixtureRow & { loser: EntrantId } => f.round === round && f.loser !== undefined,
  );
  const row = losers[position - 1];
  if (!row) {
    throw new EngineError(
      "QUALIFICATION_INVALID",
      `bracket round ${round} has no loser at position ${position} (found ${losers.length})`,
      { round, position, available: losers.length },
    );
  }
  return { entrantId: row.loser, rank: position } as StandingsRow;
}

export function resolveProgression(
  spec: ProgressionSpec,
  shapes: readonly SourceShape[],
  tables: readonly SourceTables[],
): { qualifiers: ResolvedProgressionEntry[]; ties: ProgressionTieFlag[] } {
  const pots = expandSources(spec.sources, (i) => shapes[i]!);
  const placed = placeDescriptors(pots, spec.placement, spec.map);

  const qualifiers: ResolvedProgressionEntry[] = [];
  const tieGroups = new Map<string, ProgressionTieFlag>();
  const seen = new Set<EntrantId>();
  const bestNthCache = new Map<string, StandingsRow[]>();

  placed.forEach((slot, i) => {
    const seed = i + 1;
    const src = tables[slot.sourceIndex];
    if (!src) {
      throw new EngineError("STAGE_NOT_READY", `progression source ${slot.sourceIndex} has no tables yet`, {
        sourceIndex: slot.sourceIndex,
      });
    }
    let row: StandingsRow;
    const d = slot.descriptor;
    if (d.kind === "group_rank") {
      row = rowAtRank(findPool(src.pools, d.pool), d.rank);
    } else if (d.kind === "rank_range") {
      row = rowAtRank(findPool(src.pools, ""), d.rank);
    } else if (d.kind === "round_loser") {
      row = loserAt(src.bracket, d.round, d.position);
    } else {
      // best_nth — every pool's nth-place row, compared together (once per
      // distinct nth), exactly like resolveQualification.bestOfRank used to
      // — never one candidate at a time.
      const cacheKey = `${slot.sourceIndex}:${d.nth}`;
      let ordered = bestNthCache.get(cacheKey);
      if (!ordered) {
        const candidates = src.pools.map((p) => {
          const picked = rowAtRank(p, d.nth);
          return d.normaliseUnequalPools === true ? normalisedRow(p, picked.entrantId) : picked;
        });
        if (d.normaliseUnequalPools !== true) {
          const sizes = new Set(src.pools.map((p) => p.rows.length));
          if (sizes.size > 1) {
            throw new EngineError(
              "SEEDING_BESTNTH_UNEQUAL_POOLS",
              `bestNth cannot compare rank-${d.nth} finishers across pools of different sizes (${[...sizes]
                .sort((a, b) => a - b)
                .join(",")}) — UEFA normalisation for unequal pools isn't implemented`,
              { nth: d.nth, poolSizes: src.pools.map((p) => ({ pool: p.pool, size: p.rows.length })) },
            );
          }
        }
        ordered = crossGroupOrder(candidates);
        bestNthCache.set(cacheKey, ordered);
      }
      const candidate = ordered[d.position - 1];
      if (!candidate) {
        throw new EngineError(
          "QUALIFICATION_INVALID",
          `bestNth needs ${d.position} pools with a rank-${d.nth} finisher, found ${ordered.length}`,
          { nth: d.nth, position: d.position },
        );
      }
      row = candidate;
    }

    if (seen.has(row.entrantId)) {
      throw new EngineError(
        "QUALIFICATION_INVALID",
        `entrant ${row.entrantId} qualifies through more than one source or take rule`,
        { entrantId: row.entrantId },
      );
    }
    seen.add(row.entrantId);

    qualifiers.push({
      seed,
      sourceIndex: slot.sourceIndex,
      descriptor: d,
      entrantId: row.entrantId,
      rank: row.rank ?? 0,
      tieUnbroken: row.tieUnbroken === true,
    });

    if (row.tieUnbroken === true) {
      const group = [row.entrantId, ...(row.tieBreak?.with ?? [])].sort();
      const key = group.join(",");
      const existing = tieGroups.get(key);
      if (existing) existing.descriptors.push(d);
      else tieGroups.set(key, { descriptors: [d], entrantIds: group, reason: row.tieBreak?.key ?? "seed" });
    }
  });

  return { qualifiers, ties: [...tieGroups.values()] };
}

// L3/#414 — wraps any finish order as a single-pool PoolTable, unchanged
// from qualification.ts.
export function placementTable(finalRanks: readonly EntrantId[]): PoolTable {
  return {
    pool: "",
    rows: finalRanks.map((entrantId, i) => ({
      entrantId,
      played: 0,
      won: 0,
      drawn: 0,
      lost: 0,
      points: 0,
      metrics: {},
      rank: i + 1,
    })),
  };
}
```

- [ ] **Step 4: Run and confirm green**

Re-run Step 2's command. Expected: all `describe` blocks pass,
`numFailedTestSuites: 0`.

- [ ] **Step 5: Delete the superseded engine module and fix its three other consumers**

```bash
git rm packages/engine/src/competition/qualification.ts packages/engine/src/competition/qualification.test.ts
```

Update `packages/engine/src/competition/index.ts`:
```ts
export * from "./stage.ts";
export * from "./standings.ts";
export * from "./tiebreakers.ts";
export * from "./progression.ts";
export * from "./display.ts";
export * from "./points.ts";
```

`packages/engine/src/competition/stage.ts:11` — change
`import type { PoolTable, StageTables } from "./qualification.ts";` to
`import type { PoolTable, SourceTables as StageTables } from "./progression.ts";`
(the name `StageTables` does not survive the move — `stage.ts` only ever
used it as a type alias for "pools + optional bracket", which `SourceTables`
is; renaming the import binding, not the file's own usage, is the smallest
diff).

`packages/engine/src/testkit/simulation.ts:20-24,793-800,876,903,1146` —
this is the engine's own chaos/simulation harness, and it hand-builds a
`QualificationSpec` to feed `resolveQualification`/`qualificationSize`.
Convert its one call site's spec literal
(`{ from: "swiss", topN: Math.min(4, n) }`, `:903`, and the sibling at
`:876`) to
`{ sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: Math.min(4, n) }] }], placement: "rank_order" }`,
change the imports to `resolveProgression`/`progressionSize` from
`../competition/progression.ts`, and change `resolveProgression`'s call
site (`:796`) to pass `[{ poolKeys: [] }]`/`[tables]` (single-source,
wrapping the existing `StageTables` value in a one-element array) instead of
the old bare `spec, tables` pair. `qualificationSize(spec)` at `:798,1146`
becomes `progressionSize(spec.sources[0]!.take)` — the simulation harness
only ever builds single-source specs, so this is exact, not an
approximation.

- [ ] **Step 6: Full engine gate**

```bash
cd <worktree>/packages/engine && npx vitest run --reporter=json --outputFile=/tmp/f2-t2-all.json > /tmp/f2-t2-all.log 2>&1; echo "EXIT=$?"
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests,suites:.numFailedTestSuites}' /tmp/f2-t2-all.json
cd <worktree> && npx tsc -p packages/engine --noEmit; echo "EXIT=$?"
npx tsx scripts/engine-boundary.ts; echo "EXIT=$?"
```
Expected: whole engine suite green (including `testkit/simulation.test.ts`
and any `sim`/`chaos`/`undo-sweep` suites that exercise it), tsc EXIT=0,
boundary EXIT=0.

- [ ] **Step 7: Commit**

```bash
git add -A packages/engine
git commit -m "engine(F2): resolve multi-source progressions with dedupe and tie-flagging; retire qualification.ts"
```

---

### Task 3: Zod — one `ProgressionSchema`, `CreateStage` updated, mutual-exclusion 422 deleted

**Files:**
- Modify: `apps/web/src/server/api-v1/schemas.ts` (delete
  `QualificationSpecSchema` block `:486-529`, `StageSeedingSchema` block
  `:543-573`; add `ProgressionSchema`; `CreateStage` `:575-582`)
- Modify: `apps/web/src/server/templates/schema.ts` (`TemplateStageSeeding`
  `:38-59`, `TemplateStage.seeding` `:102-111`)
- Test: `apps/web/src/server/api-v1/__tests__/progression-schema.test.ts`
  (create — mirror the neighbouring `__tests__` files' style in that
  directory for the zod-parsing test shape)

**Interfaces:**
```ts
export const ProgressionSchema: z.ZodType<ProgressionInput>; // see below
export type ProgressionInput = { sources: ...; placement: ...; map?: ...; timing: "setup" | "on_complete" };
```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { ProgressionSchema } from "@/server/api-v1/schemas";

describe("ProgressionSchema", () => {
  it("accepts the euro24 shape — topNPerGroup + bestNth, one source, seeded_map", () => {
    const result = ProgressionSchema.safeParse({
      sources: [
        {
          stage: "previous",
          take: [
            { kind: "topNPerGroup", n: 2 },
            { kind: "bestNth", nth: 3, count: 4 },
          ],
        },
      ],
      placement: "seeded_map",
      map: [{ slot: "13", source: "best:1" }],
      timing: "setup",
    });
    expect(result.success).toBe(true);
  });

  it("rejects topN — the collapsed shape no longer parses (rankRange replaces it)", () => {
    const result = ProgressionSchema.safeParse({
      sources: [{ stage: "previous", take: [{ kind: "topN", n: 4 } as never] }],
      placement: "rank_order",
      timing: "on_complete",
    });
    expect(result.success).toBe(false);
  });

  it("requires timing — no default (ruling 5: strict from day one)", () => {
    const result = ProgressionSchema.safeParse({
      sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
      placement: "rank_order",
    });
    expect(result.success).toBe(false);
  });

  it("still refuses seeded_map with an empty map (carried verbatim)", () => {
    const result = ProgressionSchema.safeParse({
      sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] }],
      placement: "seeded_map",
      timing: "setup",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a multi-source progression — new capability, dedupe enforced at resolution, not parse", () => {
    const result = ProgressionSchema.safeParse({
      sources: [
        { stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] },
        { stage: { stageId: "00000000-0000-0000-0000-000000000000" }, take: [{ kind: "picks", picks: [{ pool: "A", rank: 1 }] }] },
      ],
      placement: "rank_order",
      timing: "on_complete",
    });
    expect(result.success).toBe(true);
  });

  it("accepts roundLosers with a required count — L3/#414, absorbed unchanged", () => {
    const result = ProgressionSchema.safeParse({
      sources: [{ stage: "previous", take: [{ kind: "roundLosers", round: 1, count: 4 }] }],
      placement: "rank_order",
      timing: "on_complete",
    });
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
cd <worktree> && npm run test --workspace apps/web -- run apps/web/src/server/api-v1/__tests__/progression-schema.test.ts --reporter=json --outputFile=/tmp/f2-t3.json > /tmp/f2-t3.log 2>&1; echo "EXIT=$?"
```
Expected: failed suite — `ProgressionSchema` is not exported yet.

- [ ] **Step 3: Implement.** Delete `TopNS`, `BestOfRankS`, `RoundLosersS`,
  `QualificationSpecSchema` (`schemas.ts:486-529`) and `RankRangeTakeS`
  through `StageSeedingSchema` (`schemas.ts:549-573` — but keep
  `SeededMapEntryS`, it survives unchanged). Replace with:

```ts
// F2 (unified progression field) — replaces QualificationSpecSchema and
// StageSeedingSchema. Mirrors the plain-TS shape in
// @seazn/engine/competition (TakeRule/ProgressionSource/SeededMapEntry)
// field-for-field — usecases import THOSE types, not these zod schemas, so
// a shape drift here would 400 at the edge without tripping tsc. Keep them
// in lockstep by hand.
const PoolRankPickS = z.object({ pool: z.string().min(1), rank: z.number().int().min(1) }).strict();
const RankRangeTakeS = z
  .object({ kind: z.literal("rankRange"), from: z.number().int().min(1), to: z.number().int().min(1) })
  .strict()
  .refine((t) => t.to >= t.from, { message: "rankRange: to must be >= from", path: ["to"] });
const TopNPerGroupTakeS = z.object({ kind: z.literal("topNPerGroup"), n: z.number().int().min(1).max(16) }).strict();
const BestNthTakeS = z
  .object({
    kind: z.literal("bestNth"),
    nth: z.number().int().min(1),
    count: z.number().int().min(1),
    normaliseUnequalPools: z.boolean().optional(),
  })
  .strict();
const PicksTakeS = z.object({ kind: z.literal("picks"), picks: z.array(PoolRankPickS).min(1) }).strict();
// L3/#414 — `count` is REQUIRED, mirroring the engine: progressionSize reads
// losersOfRound.count unconditionally on a read path that must never throw.
const RoundLosersTakeS = z
  .object({ kind: z.literal("roundLosers"), round: z.number().int().min(1), count: z.number().int().min(1) })
  .strict();
export const TakeRuleSchema = z.union([RankRangeTakeS, TopNPerGroupTakeS, BestNthTakeS, PicksTakeS, RoundLosersTakeS]);

const SeededMapEntryS = z.object({ slot: z.string().min(1).max(20), source: z.string().min(1).max(40) }).strict();

const ProgressionSourceS = z
  .object({
    stage: z.union([z.literal("previous"), z.object({ stageId: Uuid }).strict()]),
    take: z.array(TakeRuleSchema).min(1).max(8),
  })
  .strict();

// Decision 1 (F2 plan) — `timing` is the axis the design doc's own proposed
// shape omitted: whether this stage's fixtures appear at setup, as TBD
// placeholders (old `.seeding`), or only once every source stage completes
// (old `.qualification`). Required, no default — ruling 5's "strict
// constraints from day one."
export const ProgressionSchema = z
  .object({
    sources: z.array(ProgressionSourceS).min(1).max(8),
    placement: z.enum(["seeded_map", "snake", "rank_order"]),
    map: z.array(SeededMapEntryS).max(64).optional(),
    timing: z.enum(["setup", "on_complete"]),
  })
  .strict()
  .refine((s) => s.placement !== "seeded_map" || (s.map !== undefined && s.map.length > 0), {
    message: "seeded_map placement needs a non-empty map",
    path: ["map"],
  });
export type ProgressionInput = z.infer<typeof ProgressionSchema>;
```

Update `CreateStage` (`schemas.ts:575-582`):
```ts
export const CreateStage = z.object({
  seq: z.number().int().min(1),
  kind: StageKind,
  name: z.string().min(1).max(200),
  config: z.record(z.string(), z.unknown()).default({}),
  progression: ProgressionSchema.nullish(),
});
```

`apps/web/src/server/templates/schema.ts:38-59,102-111` — rename
`TemplateStageSeeding` to `TemplateStageProgression`, narrowed the same way
(`source: "previous"` only — a catalog JSON has no live stage UUID yet):

```ts
export const TemplateStageProgression = ProgressionSchema.refine(
  (p): p is ProgressionInput & { sources: (ProgressionInput["sources"][number] & { stage: "previous" })[] } =>
    p.sources.every((s) => s.stage === "previous"),
  {
    message:
      'template stage progression must use source: "previous" for every source — a catalog template has no live stage id to reference yet',
    path: ["sources"],
  },
);
export type TemplateStageProgression = z.infer<typeof TemplateStageProgression>;
```
and on `TemplateStage`:
```ts
  progression: TemplateStageProgression.optional(),
```
(update the doc comment above it the same way — "Cross-stage progression
wiring… euro24's R16, t20-super8's Super 8 and SF/F, league-playoff's
page_playoff").

Update the import at `schemas.ts` top and `templates/schema.ts:35` from
`StageSeedingSchema`/`StageSeedingInput` to `ProgressionSchema`/
`ProgressionInput`.

- [ ] **Step 4: Delete the mutual-exclusion 422**

`stages.ts:224-234` (the `if (s.qualification != null && s.seeding != null)`
block, inside `createStages`'s per-stage loop) is deleted outright — with one
field there is nothing left to be mutually exclusive with. This edit belongs
to Task 5 (writers) since it is in the same function as the insert rewrite;
noted here so Task 3's zod change and Task 5's usecase change are not
reviewed as if they could ship independently — `CreateStage` losing
`qualification`/`seeding` and `stages.ts` still branching on them would not
compile.

- [ ] **Step 5: Run and confirm green, then the engine boundary + schema drift gates**

```bash
cd <worktree> && npm run test --workspace apps/web -- run apps/web/src/server/api-v1/__tests__/progression-schema.test.ts --reporter=json --outputFile=/tmp/f2-t3.json > /tmp/f2-t3.log 2>&1; echo "EXIT=$?"
```
Expected green — this task alone will NOT make `apps/web` typecheck (Task 5/6
still reference the old fields); do not run a full `apps/web` tsc yet.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/server/api-v1/schemas.ts apps/web/src/server/templates/schema.ts apps/web/src/server/api-v1/__tests__/progression-schema.test.ts
git commit -m "schema(F2): one ProgressionSchema replaces QualificationSpecSchema and StageSeedingSchema"
```

---

### Task 4: Migration — verify zero rows, drop `qualification`/`seeding`, add `progression jsonb`

**Files:**
- Create: `db/migration/deltas/V371__stage_progression_field.sql`

**A note on the V-number, because this plan has now been wrong about it three
times — and the third time broke `main`.** This file has been numbered V367,
then V369, then V370, and is now **V371**.

What happened is the part worth reading. RS002 (#607) and F1 (#606) each
renumbered off P8's V367 while they were open, each independently landed on
V368, and both merged minutes apart. `main` then contained two files numbered
V368 and Flyway refused to run at all:

    ERROR: Found more than one migration with version 368

No fresh clone, worktree or CI Postgres job could build a schema. Every one of
those pull requests was green in isolation — **the collision did not exist in
any branch, only in the merge**, so no gate could have caught it. It was
repaired on `main` by `604767c63`, which moved the registration delta to V370.

So `main` now holds V367 (P8), V368 and V369 (F1), and V370 (RS002). V371 is
this plan's best guess and **not a reservation**. The rule the episode
teaches: a number is not claimed by choosing it, nor by opening a PR with it —
only by merging. Re-check `git ls-tree origin/main db/migration/deltas`
against a freshly fetched `origin/main` **immediately before merging**, not
merely before opening the PR, and rename then if V371 has since gone.

**Step 1: Verify the zero-rows premise — STOP if it is false.**

This is the acceptance list's first item and the prompt's explicit Step 1;
it runs before any schema edit, against the target database (not a fresh
local one — the premise is about production, and the whole migration's
correctness rests on it). Load `supabase:supabase-postgres-best-practices`
first, per standing rules.

```bash
cd <worktree> && psql "$DATABASE_URL" -c "
  select
    (select count(*) from stages where qualification is not null) as qualification_rows,
    (select count(*) from stages where seeding is not null) as seeding_rows;
"
```
Expected, per ruling 5: both `0`. **If either is nonzero, STOP** — do not
write the migration; escalate instead (the ruling is dated, per its own
text, "and this document will outlive its accuracy"). Record the exact query
and its output in the PR body verbatim — this is an acceptance-list item, not
optional evidence.

- [ ] **Step 2: Write the migration**

```sql
-- V369 — unify stages.qualification and stages.seeding into one
-- stages.progression field (F2, design doc §2.1/§5). Greenfield per owner
-- ruling 2026-08-17: no production data (verified zero rows against the
-- target database before this file was written — see the PR body for the
-- query and its output). No backfill, no dual-read, no compat shim — both
-- old columns are dropped in the same migration that adds the new one.
--
-- `progression` is NOT NULL: every stage either has real progression rules
-- or the column is simply absent from the row's concerns (a division's
-- FIRST stage never had qualification/seeding either) — modelled the same
-- way the old columns were, nullable, not "NOT NULL with a sentinel". A
-- stage with no upstream source (first in its division) has
-- progression = null, same meaning as before.
alter table stages drop column qualification;
alter table stages drop column seeding;
alter table stages add column progression jsonb;

-- Structural shape checks the zod layer already enforces at the edge — this
-- is defence in depth for anything that writes stages directly (a future
-- migration, a script), not a substitute for ProgressionSchema. Mirrors the
-- CHECK style already used elsewhere in this table (`kind in (...)`).
alter table stages
  add constraint stages_progression_shape_chk check (
    progression is null
    or (
      jsonb_typeof(progression -> 'sources') = 'array'
      and jsonb_array_length(progression -> 'sources') >= 1
      and progression ? 'placement'
      and progression -> 'placement' <@ '["seeded_map", "snake", "rank_order"]'::jsonb
      and progression ? 'timing'
      and progression -> 'timing' <@ '["setup", "on_complete"]'::jsonb
    )
  );

comment on column stages.progression is
  'F2: the union of the old qualification and seeding vocabularies — one or '
  'more sources (each an earlier stage + take rules), one placement '
  '(rank_order/snake/seeded_map), and timing (setup = TBD placeholders '
  'generated independently of source completion, propose+confirm fill; '
  'on_complete = auto-seed only once every source stage completes). See '
  '@seazn/engine/competition (progression.ts) for the take-rule vocabulary '
  'and apps/web/src/server/api-v1/schemas.ts (ProgressionSchema) for the '
  'full validated shape.';
```

`progression -> 'placement' <@ '[...]'::jsonb` is a jsonb-containment
membership check (`<@`) against a small literal array — cheaper and clearer
than a regex or a `case`, and matches the style Postgres best-practice
guidance recommends for "is this scalar one of a small fixed set" inside a
CHECK over jsonb.

- [ ] **Step 3: Verify the migration applies from zero**

```bash
cd <worktree> && ~/.claude/skills/seazn-local-env/scripts/seazn-env.sh up --label f2-fresh && echo "EXIT=$?"
psql "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label f2-fresh | grep DATABASE_URL | cut -d= -f2-)" -c "\d stages" | grep -a progression
~/.claude/skills/seazn-local-env/scripts/seazn-env.sh down --label f2-fresh
```
Expected: `schema ready` at the new version; `\d stages` shows `progression`
present, `qualification`/`seeding` absent.

- [ ] **Step 4: Commit**

```bash
git add db/migration/deltas/V371__stage_progression_field.sql
git commit -m "db(F2): drop stages.qualification/seeding, add stages.progression jsonb"
```

---

### Task 5: Writers — `createStages`, `instantiateTemplate`, the 3 catalogue JSONs, `format-templates.ts`, `mobile.spec.ts`

> **Added 2026-08-18 after Task 3 shipped — two files this plan never assigned
> to anybody.** Both were found by the Task 3 implementer and confirmed to be
> real, unowned work. Neither is optional: leave them and F2 ships a UI that
> reads a column the migration has already dropped.
>
> 1. **`apps/web/src/components/v2/template-gallery.tsx`** — a LIVE component
>    still reading `.seeding`. It appears in no task's file list. The reason it
>    stayed invisible is worth noting: `TemplateStage` is not `.strict()`, so
>    the real catalogue JSON's `.seeding` block is silently STRIPPED rather
>    than rejected, and nothing errors. Task 5 owns it, alongside the catalogue
>    JSONs it renders.
> 2. **The `Stage` RESPONSE schema** (`apps/web/src/server/api-v1/schemas.ts`,
>    around 607-617) still exposes raw `qualification` / `seeding` records.
>    Task 3 deliberately left it — it is a read-path shape, so it belongs with
>    the readers in **Task 6**, not here. Recorded in both places so whichever
>    session runs first cannot assume the other took it.
>
> Known-red until Task 5 reshapes the catalogue JSON, and NOT new defects:
> `catalog.test.ts` (3 failures) and `template-gallery-progression.test.tsx`
> (2 failures).
>
> ### The review sweep found FIVE more unowned files — and one silent write
>
> A review of Tasks 1-4 (2026-08-18) swept for every remaining reader and
> writer of the old fields. The two above were not the whole set. **Every file
> below is required work in this task and none of it was in any task's file
> list.** Confirmed by re-running the sweep independently.
>
> **First, the change that makes this whole class LOUD instead of silent —
> do this before the rest.** `CreateStage` (`schemas.ts`, ends `});`) is
> **not `.strict()`**. So `stages-panel.tsx:961`, the live "Add stage" flow,
> POSTs `qualification: { topN }`, Zod silently DROPS the unknown key, the
> stage is created with `progression: null`, the request returns success, and
> that stage never generates anyone. No error, no log, a real organiser
> action that quietly does nothing. Add `.strict()` to `CreateStage` and the
> same silent drop becomes a 400 that names the offending key — and every
> remaining site in this list turns into a loud failure a test can catch
> rather than a silent one nobody sees. This is the same non-strict hole that
> hid `template-gallery.tsx`: `TemplateStage` is not `.strict()` either, so
> the catalogue JSON's `.seeding` block is stripped rather than rejected.
>
> Then convert, all of them writers or readers of the dropped columns:
> - `components/v2/stages-panel.tsx` (~8 sites, incl. the POST at :961)
> - `config/format-gallery.tsx` (~13 sites, incl. `qualification: {topN: 4}`
>   at :289 and :298 — these feed the REAL engine through
>   `previewDivisionFixtures`, so they are not decorative)
> - `components/v2/division-settings.tsx` (:136, :166)
> - `app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx:133` —
>   `stages.filter(s => s.seeding != null)` degrades to `[]` once the column
>   is gone, so the P6/D4b seed-proposal panel silently DISAPPEARS from every
>   division. Another silent one: no error, just a missing feature.
> - `app/api/.../format-preview/route.ts:14`
>
> ### The 5a sweep found THREE MORE, and they are scripts, not components
>
> Recorded 2026-08-18 after Task 5a's `.strict()` sweep. None of these were in
> any file list, and none is a component, which is why every component-scoped
> sweep so far missed them:
>
> - **`scripts/seed-demo.ts`** (~18 references, `TEMPLATES` map around lines
>   131-217, POSTed at 946/1078/1224/1267). **`seed:demo` is fully broken**
>   until this is converted. That matters beyond this session: demo data is a
>   standing project rule, and every session that stands up a demo environment
>   depends on it.
> - **`scripts/smoke.ts`** (~12 references, notably `:6289` PUT
>   `qualification:null`, `:6629-6637` POST `seeding:{}`, `:14651`
>   `roundLosers`). Smoke runs on PRs, so **F2's own PR will go red here**
>   until these are converted. Not optional, and not deferrable to a follow-up.
> - **`scripts/seed-fifa2026.ts`** (~5 references, `:412`, `:422`).
>
> ### Task 5b sweep (2026-08-18) found the same class one layer further out: e2e specs
>
> All 8 files above (5 UI + 3 scripts) are converted and committed on
> `feat/f2-t5b-writers`. A repo-wide `grep -rn "qualification:\|seeding:"
> apps/web/e2e/*.spec.ts` during Task 5b's own verification found **four e2e
> spec files, none in any task's file list, none a component or a script,
> which is why every earlier sweep (component-scoped, then script-scoped)
> missed this layer too**. `.github/workflows/e2e.yml` runs on every PR
> (owner-confirmed) — these are not deferrable on the same reasoning
> `smoke.ts` wasn't. Task 5b's own dispatch named exactly one of these
> (`mobile.spec.ts:1504`, now drifted to two different line numbers below)
> as a heads-up for collateral UI-text breakage, not as an assignment, and
> Task 5b's UI changes touched zero rendered strings — so nothing here is a
> side effect of Task 5b, and nothing here was in scope to fix under that
> dispatch's file list. Recording precisely, same as the 5a note above, so
> whichever session picks this up doesn't have to re-derive it:
>
> - **`apps/web/e2e/division-settings.spec.ts:94`** — `qualification: null`
>   in a stages PUT body.
> - **`apps/web/e2e/formats.spec.ts:73,82`** — reads a stage's
>   `.qualification` straight off the GET response and asserts
>   `{losersOfRound: {round,count}}` on it; both the read and the assertion
>   shape need to move to `.progression`/`roundLosers` once Task 6 converts
>   the `Stage` response schema (schemas.ts ~607-617) they depend on.
> - **`apps/web/e2e/mobile.spec.ts:1470`** — `seeding: {source, take:
>   [{kind:"topNPerGroup", n:1}], placement}`.
> - **`apps/web/e2e/mobile.spec.ts:1609`** — `seeding: {source, take:
>   [{kind:"rankRange", from:1, to:2}], placement}`. This is the exact
>   literal the ORIGINAL Task 5 Step 7 (before the 5a/5b split) already
>   described converting — it was never actually done; the line number
>   drifted from :1504 to :1609 as unrelated PRs landed on `main` in the
>   meantime.
> - **`apps/web/e2e/stage-progression.spec.ts:60`** — `seeding: {source,
>   take: [{kind:"topNPerGroup", n:2}], placement}`.
>
> All five carry `timing: "setup"` once converted (every one is exercising
> the propose/confirm day-one-TBD path, same as `mobile.spec.ts`'s Task 5
> Step 7 code block already specified). Unlike Task 5b's UI/script sites,
> these can't be verified even statically against a mocked call — Playwright
> specs run against a REAL server, so both the textual conversion AND its
> correctness are blocked on Task 6 (`stages.ts`'s INSERT still targets the
> dropped columns) in a way this session was explicitly told not to attempt
> to stand up.
>
> ### A FOURTH wave: four e2e specs, found by Task 5b's sweep
>
> Recorded 2026-08-18. `apps/web/e2e/` still carries 21 references to the old
> fields across four specs, and **e2e is LIVE on pull requests**, so F2's PR
> reds here until they are converted:
>
> - `mobile.spec.ts` (12 refs, incl. :1470, :1609)
> - `stage-progression.spec.ts` (5 refs, incl. :60)
> - `formats.spec.ts` (3 refs, :73, :82)
> - `division-settings.spec.ts` (1 ref, :94)
>
> These need a running server to verify, so they are blocked behind Task 6's
> `stages.ts` fix like everything else live. Treat them as the LAST piece of
> F2, not an optional follow-up — merging F2 with them unconverted means
> merging a red PR.
>
> **Count the waves, because the lesson is in the sequence.** The unowned work
> was found in four passes: two files (Task 3), then five more (the Tasks 1-4
> review), then three scripts (Task 5a's `.strict()` sweep), then four e2e
> specs (Task 5b's sweep). Each sweep was scoped to what the previous author
> was touching — components, then usecases, then scripts, then specs — and
> each one found files the last had no reason to look at. The plan's original
> file lists were not merely incomplete; they were incomplete in a way that
> only a differently-scoped sweep could reveal. Any future field rename in
> this repo should start by grepping ALL of `apps/web/src`, `scripts/`,
> `apps/web/e2e/` and `db/` in one pass, before writing any task list.
>
> ### Two facts about the tests themselves, learned the hard way
>
> **The component tests CANNOT catch the `CreateStage` silent-drop bug.** All
> seven components/v2 suites plus `seed-proposal-stage-pairing` stayed green
> (25/25) through the whole episode, because none of them invokes the real
> server-only `CreateStage` schema. The production defect was invisible to
> every test that looked like it covered the area. That is why `.strict()` had
> to be the fix rather than a test.
>
> **`catalog.test.ts:68` is tautological.** It asserts wc32's knockout stage
> has `seeding === undefined` on a template that carries NEITHER `seeding` nor
> `progression` — verified, zero occurrences of either. It passed before the
> rename, passes after it, and would pass if the field were deleted entirely.
> Rewrite it to assert what is actually true of wc32, or delete it; leaving it
> is a test that can never fail.
>
> The pattern worth naming, because it will recur in Task 6: **every one of
> these fails silently rather than loudly** — a dropped key, a filter that
> matches nothing, a stripped JSON block. None of them throws. A green test
> run proves nothing about them, which is exactly why they survived four
> tasks and two reviews.

**Files:**
- Modify: `apps/web/src/server/usecases/stages.ts` (`createStages`
  `:137-264`; the mutual-exclusion 422 deleted per Task 3 Step 4)
- Modify: `apps/web/src/server/usecases/templates.ts` (`instantiateTemplate`
  `:280-333`)
- Modify: `apps/web/src/server/templates/catalog/league-playoff.json`,
  `euro24.json`, `t20-super8.json`
- Modify: `apps/web/src/components/v2/format-templates.ts` (`StageDraft`
  `:6-11`, five `qualification:`/`topN`/`losersOfRound` sites at `:39,72,81,
  156,196-198`)
- Modify: `apps/web/e2e/mobile.spec.ts:1504`
- Test: `apps/web/src/server/usecases/__tests__/catalog-progression.test.ts`
  (create); `apps/web/src/components/v2/__tests__/format-templates.test.ts`
  (extend if it exists, else create alongside the file per repo convention)

- [ ] **Step 1: Write the failing tests**

```ts
// apps/web/src/server/usecases/__tests__/catalog-progression.test.ts
// Real Postgres required; skipped without DATABASE_URL — the 3 catalogue
// templates carrying .seeding must instantiate onto the new field and
// produce the SAME stage graphs they do today (acceptance list item 7).
import { describe, expect, it } from "vitest";
import { instantiateTemplate } from "../templates";
import { CATALOG } from "@/server/templates/catalog";
// ...seedOrg/auth helpers, matching the neighbouring templates/__tests__/catalog.test.ts style

const HAS_DB = !!process.env.DATABASE_URL;
(HAS_DB ? describe : describe.skip)("catalogue templates instantiate onto stages.progression", () => {
  it.each(["league-playoff", "euro24", "t20-super8"])("%s: every stage with a source has progression, not the old fields", async (key) => {
    const template = CATALOG.find((t) => t.key === key)!;
    const { auth } = await seedOrg();
    const result = await instantiateTemplate(auth, { templateKey: key });
    for (const division of result.divisions) {
      const rows = await sql<{ progression: unknown; kind: string }[]>`
        select progression, kind from stages where id = any(${division.stages.map((s) => s.id)}) order by seq`;
      for (const row of rows.slice(1)) {
        // every stage but the first has a source
        expect(row.progression).not.toBeNull();
        expect((row.progression as { timing: string }).timing).toBe("setup");
      }
    }
  });
});
```

```ts
// apps/web/src/components/v2/__tests__/format-templates.test.ts
import { describe, expect, it } from "vitest";
import { buildTemplateStages, detectTemplate } from "../format-templates";

describe("format-templates emit progression, not qualification", () => {
  it("league_ko emits rankRange, on_complete — the topN replacement, unchanged behaviour", () => {
    const stages = buildTemplateStages("league_ko", { qualified: 4, swissRounds: 5, poolCount: 2, legs: 1 });
    const finals = stages[1]!;
    expect(finals.progression).toEqual({
      sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
      placement: "rank_order",
      timing: "on_complete",
    });
  });

  it("ko_plate still emits roundLosers, on_complete — unchanged, F3 owns flipping timing to setup", () => {
    const stages = buildTemplateStages("ko_plate", { qualified: 4, swissRounds: 5, poolCount: 2, legs: 1 });
    expect(stages[1]!.progression).toEqual({
      sources: [{ stage: "previous", take: [{ kind: "roundLosers", round: 1, count: 4 }] }],
      placement: "rank_order",
      timing: "on_complete",
    });
  });

  it("detectTemplate reads rankRange, not topN — round-trips through the new field", () => {
    const stages = buildTemplateStages("qualifying_main", { qualified: 8, swissRounds: 5, poolCount: 2, legs: 1 });
    expect(detectTemplate(stages)).toBe("qualifying_main");
  });
});
```

- [ ] **Step 2: Run and confirm failure** (same `--reporter=json --outputFile` pattern as prior tasks).

- [ ] **Step 3: `createStages` — rewrite the insert, delete the mutual-exclusion 422**

`stages.ts:158-172` (the cross-stage-feed DAG edges loop) reads
`s.qualification` to decide "qualification always flows from an earlier
stage" — replace with `s.progression`:
```ts
      if (s.progression != null) {
        // progression always flows from an earlier stage (every source names one)
        edges.push({ from: String(s.seq - 1), to: String(f.to_stage_seq) }); // unchanged shape, s.progression replaces s.qualification
      }
```
Wait — keep the existing edge-building logic exactly as-is; only the
condition's field name changes (`s.qualification !== undefined && s.qualification !== null`
→ `s.progression !== undefined && s.progression !== null`).

`stages.ts:187-190` (the `carry` entitlement check) reads
`s.qualification as { carry?: string }` — `carry` never moved into
`ProgressionSchema` (it was never part of the union table either — it is a
`TopN`/qualification-only field the design doc does not mention and this
plan's union table does not carry forward). **Decision, recorded here
because it is a scope boundary, not an oversight**: `carry` is out of F2's
union table and out of this session's file list; grep for `carry` across
`format-templates.ts`/catalog JSON confirms no shipped writer sets it today,
so this line becomes dead with nothing depending on it. Delete the block
(`:187-190`) rather than port it — porting a field this session's own
grounding found unused would be exactly the "seam for later" anti-pattern.
If a future session needs carry-over on a `.progression` stage, it is a new
field addition to `ProgressionSchema`, not a restoration.

`stages.ts:224-264` — the per-stage loop and insert:
```ts
    const rows: StageRow[] = [];
    for (const s of inputs) {
      const [dupe] = await tx`
        select 1 from stages where division_id = ${divisionId} and seq = ${s.seq}`;
      if (dupe) throw new HttpError(409, `stage seq ${s.seq} already exists`);
      const [row] = await tx<StageRow[]>`
        insert into stages (division_id, seq, kind, name, config, progression)
        values (${divisionId}, ${s.seq}, ${s.kind}, ${s.name}, ${tx.json(s.config as never)},
                ${s.progression ? tx.json(s.progression as never) : null})
        returning ${tx(STAGE_COLS)}`;
      rows.push(row);
    }
    // Progression rules validated AFTER every stage in this batch is
    // inserted, so `source: "previous"` / `{stageId}` resolves against
    // sibling stages in THIS batch too, regardless of input array order —
    // unchanged contract from the old .seeding validation.
    for (const s of inputs) {
      if (!s.progression) continue;
      const row = rows.find((r) => r.seq === s.seq)!;
      await validateStageProgression(tx, row, s.progression);
    }
```
`STAGE_COLS` (`:92`) becomes
`["id", "division_id", "seq", "kind", "name", "config", "progression", "status"]`
and `StageRow` (`:80-90`) loses the `qualification`/`seeding` fields, gains
one `progression: Record<string, unknown> | null`.

- [ ] **Step 4: `templates.ts` — rewrite `instantiateTemplate`'s insert**

`templates.ts:304-330`:
```ts
          if (templateStage.progression !== undefined) {
            if (si === 0) {
              throw new Error("progression.sources[].stage is 'previous' but this is the division's first stage");
            }
            const [sourceRow] = await tx<{ kind: string; config: Record<string, unknown> }[]>`
              select kind, config from stages where id = ${stageResults[si - 1]!.id}`;
            await validateStageProgression(tx, { division_id: divisionId, seq: si + 1 }, templateStage.progression, [
              { kind: sourceRow!.kind, config: sourceRow!.config },
            ]);
          }
          const stageName = t(dict, templateStage.i18nNameKey);
          const [stage] = await tx<{ id: string }[]>`
            insert into stages (division_id, seq, kind, name, config, progression)
            values (${divisionId}, ${si + 1}, ${templateStage.kind}, ${stageName},
                    ${tx.json(effectiveStageConfig(templateStage) as never)},
                    ${templateStage.progression ? tx.json(templateStage.progression as never) : null})
            returning id`;
```
(`validateStageProgression`'s exact signature is finalised in Task 6, which
also converts `validateSeedingAgainstShape`'s two call sites — this task's
Step 4 states the call shape it needs; Task 6 is the one that makes it
compile, since both edits land in the same PR before any verification gate
runs.)

- [ ] **Step 5: Rewrite the 3 catalogue JSONs**

`league-playoff.json:26-33` (page_playoff stage):
```json
        {
          "i18nNameKey": "templates.stage.pagePlayoff",
          "kind": "page_playoff",
          "size": 4,
          "progression": {
            "sources": [{ "stage": "previous", "take": [{ "kind": "rankRange", "from": 1, "to": 4 }] }],
            "placement": "rank_order",
            "timing": "setup"
          },
```

`euro24.json:26-43` (knockout stage):
```json
        {
          "i18nNameKey": "templates.stage.knockout",
          "kind": "knockout",
          "size": 16,
          "progression": {
            "sources": [
              {
                "stage": "previous",
                "take": [
                  { "kind": "topNPerGroup", "n": 2 },
                  { "kind": "bestNth", "nth": 3, "count": 4 }
                ]
              }
            ],
            "placement": "seeded_map",
            "map": [
              { "slot": "13", "source": "best:1" },
              { "slot": "14", "source": "best:2" },
              { "slot": "15", "source": "best:3" },
              { "slot": "16", "source": "best:4" }
            ],
            "timing": "setup"
          },
```

`t20-super8.json:26-34` (super8 group stage) and `:41-49` (knockout stage) —
both `topNPerGroup` blocks, each wrapped the same way:
```json
          "progression": {
            "sources": [{ "stage": "previous", "take": [{ "kind": "topNPerGroup", "n": 2 }] }],
            "placement": "snake",
            "timing": "setup"
          },
```
and, for the knockout stage, `"placement": "rank_order"` in place of
`"snake"` (unchanged from today — only the wrapper key and `timing` are new).

The other five catalogue JSONs (`americano-night`, `box-league`, `slam128`,
`swiss11`, `wc32`) need **no** content edit — confirmed by Finding 4, zero
`seeding`/`qualification` keys in any of them.

- [ ] **Step 6: `format-templates.ts` — `StageDraft` and all five sites**

```ts
export interface StageDraft {
  kind: string;
  name: string;
  config: Record<string, unknown>;
  progression: {
    sources: { stage: "previous"; take: unknown[] }[];
    placement: "rank_order" | "snake" | "seeded_map";
    map?: { slot: string; source: string }[];
    timing: "setup" | "on_complete";
  } | null;
}
```
Every one of the 14 templates' `qualification: null` sites becomes
`progression: null` — a mechanical rename, no behaviour change (13
occurrences: `:31,38,46-52,71,79,88,96,103,110,117,125,133,141`, plus the
5 non-null sites below). The five sites that carried a real spec:

`:39` (`league_ko`):
```ts
      { kind: "knockout", name: "Finals", config: {}, progression: {
        sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: q }] }],
        placement: "rank_order",
        timing: "on_complete",
      } },
```

`:72` (`group_stepladder`):
```ts
      { kind: "stepladder", name: "Stepladder finals", config: {}, progression: {
        sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: q }] }],
        placement: "rank_order",
        timing: "on_complete",
      } },
```

`:81` (`group_playoffs`):
```ts
      { kind: "page_playoff", name: "Playoffs", config: {}, progression: {
        sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
        placement: "rank_order",
        timing: "on_complete",
      } },
```

`:57-63` (`groups_ko`, the `TakePicks`/`picks` site) becomes:
```ts
        progression: {
          sources: [
            {
              stage: "previous",
              take: [
                {
                  kind: "picks",
                  picks: Array.from({ length: q }, (_, i) => ({
                    pool: i % 2 === 0 ? "A" : "B",
                    rank: Math.floor(i / 2) + 1,
                  })),
                },
              ],
            },
          ],
          placement: "rank_order",
          timing: "on_complete",
        },
```

`:146` (`ko_plate`):
```ts
        progression: {
          sources: [{ stage: "previous", take: [{ kind: "roundLosers", round: 1, count: q }] }],
          placement: "rank_order",
          timing: "on_complete",
        },
```

`:156` (`qualifying_main`):
```ts
      { kind: "knockout", name: "Main draw", config: {}, progression: {
        sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: q }] }],
        placement: "rank_order",
        timing: "on_complete",
      } },
```

`detectTemplate` (`:174-207`) — its parameter type and the two reads at
`:196-198`:
```ts
export function detectTemplate(
  stages: {
    kind: string;
    config?: Record<string, unknown> | null;
    progression?: { sources: { take: { kind: string }[] }[] } | null;
  }[],
): string | null {
  ...
  if (kinds === "knockout+knockout") {
    const take = stages[1]?.progression?.sources[0]?.take ?? [];
    if (take.some((t) => t.kind === "roundLosers")) return "ko_plate";
    if (take.some((t) => t.kind === "rankRange")) return "qualifying_main";
    return null;
  }
```

Every writer above sets `timing: "on_complete"` — Decision 1's explicit
statement that no writer's default timing changes in this session; the
picker still waits for its source stage to complete before generating,
exactly as today.

- [ ] **Step 7: `mobile.spec.ts:1504`**

```ts
        progression: {
          sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] }],
          placement: "rank_order",
          timing: "setup",
        },
```
replacing the `seeding: { source: "previous", take: [...], placement: "rank_order" }`
literal (the test is exercising the D4a propose/confirm flow, hence
`timing: "setup"`, not `"on_complete"` — this is the ONE call site in this
plan that changes a `timing` value, and it changes it because the OLD field
this line used, `.seeding`, only ever meant `"setup"`; there is no field
this line used to say `"on_complete"` to preserve). The comment two lines
above it referencing `rankRange(1,2)` needs no change — it already names the
shape correctly.

- [ ] **Step 8: Run and confirm green**

```bash
cd <worktree> && npm run test --workspace apps/web -- run apps/web/src/components/v2/__tests__/format-templates.test.ts --reporter=json --outputFile=/tmp/f2-t5a.json > /tmp/f2-t5a.log 2>&1; echo "EXIT=$?"
```
The DB-backed `catalog-progression.test.ts` needs `validateStageProgression`
from Task 6 to exist first — run it at the end of Task 6's gate instead of
here; do not block this task's commit on it.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/server/usecases/stages.ts apps/web/src/server/usecases/templates.ts apps/web/src/server/templates/catalog apps/web/src/components/v2/format-templates.ts apps/web/src/components/v2/__tests__/format-templates.test.ts apps/web/src/server/usecases/__tests__/catalog-progression.test.ts apps/web/e2e/mobile.spec.ts
git commit -m "writers(F2): createStages, instantiateTemplate, the picker and catalogue templates emit progression"
```

---

### Task 6: Readers — `generateStageFixtures`, `seedNextStage` (multi-source), `computeSeedProposal`/`confirmSeedProposal`, `qualifierCount`, `openapi:gen`, full gate

> **Added 2026-08-18 — the `Stage` RESPONSE schema is yours.**
> `apps/web/src/server/api-v1/schemas.ts` (around 607-617) still exposes raw
> `qualification` / `seeding` records to API consumers. Task 3 rewrote the
> REQUEST schemas and deliberately left this one, because it is a read-path
> shape. No task owned it until now. It must move to `progression` in this
> task, and `openapi:gen` re-run — the published contract still advertises two
> fields the database no longer has.
>
> ### Four defects the Tasks 1-4 review found, to close here
>
> 1. **`V371`'s CHECK does not enforce "`seeded_map` needs a non-empty `map`"**
>    — the one invariant this plan's own Gotchas section says to carry
>    forward. Verified empirically: `placement: "seeded_map"` with no `map`
>    key PASSES the constraint, and `placeDescriptors`
>    (`progression.ts:214`) then silently resolves it as `rank_order`. A
>    wrong-but-plausible draw, no error. Either tighten the CHECK in a
>    follow-up migration or enforce it in `ProgressionSchema` — decide, and
>    say which, rather than leaving it to whichever layer someone checks
>    first.
> 2. **Tie flagging is untested where it matters.** The sole tie test
>    (`progression.test.ts:285`) proves only that `ties` stays EMPTY — the
>    tied rows are never reached. Nothing exercises `ties` actually being
>    POPULATED. This was the least-proven code in the diff and it is still
>    the least-proven code.
> 3. **No test resolves 2+ take rules in ONE source.** That is euro24's real
>    shape (`topNPerGroup` + `bestNth` together, the old
>    `CombinedQualification`). Only ordering via `placeDescriptors` is
>    covered, not resolution and dedupe through `resolveProgression`.
> 4. **A human-readable error regressed.** `topN` used to tell an organiser
>    "takes the top N, only M available — lower the count". `rankRange` now
>    reaches them as `rowAtRank`'s generic "no entrant ranked N yet"
>    (`progression.ts:358`), untested, and it is NOT in `seeding-error.ts`'s
>    allowlist so it arrives verbatim (`http.ts:196`). Restore a message that
>    tells the organiser what to DO.

**Files:**
- Modify: `apps/web/src/server/usecases/stage-seeding.ts` — shrink to
  DB-touching pieces; add `validateStageProgression`,
  `resolveProgressionSource` (generalises `resolveSeedingSource` to N
  sources), `sourcesToTables` (builds `SourceTables[]`/`SourceShape[]` for N
  sources); re-export the engine's pure surface.
- Modify: `apps/web/src/server/usecases/stages.ts` — `generateStageFixtures`
  `:886-934`, `generateSeededStageFixtures`→ folded into one
  `generateProgressionSetupFixtures` `:1396-1751`, `seedNextStage`
  `:1868-2029`, `computeSeedProposal` `:2183-2270`, `confirmSeedProposal`
  `:2317-2470`, `qualifierCount` `:757-763`, `previewDivisionFixtures`
  `:778-859` (`PreviewStageInput.qualification` field, `roundTitle` call
  **untouched** — F1's territory).
- Test: `apps/web/src/server/usecases/__tests__/progression-multi-source.test.ts`
  (create — the DB-level half of the multi-source acceptance criterion;
  Task 2 already covers it at the engine level).
- Test: extend `apps/web/src/server/usecases/__tests__/stage-progression.test.ts`,
  `combined-qualification.test.ts` → migrate its assertions onto
  `progression`/`resolveProgression` rather than deleting the coverage
  (dedupe-across-two-`combine`-children is now dedupe-across-two-`sources[]`
  — same product behaviour, new field name).

- [ ] **Step 1: Write the failing DB integration test**

```ts
// progression-multi-source.test.ts — real Postgres required.
// Finding 1: multi-source progression has never worked server-side before
// this session (the old `from?` field was declared, validated, and never
// read). This test is the acceptance list's "multi-source sources[] with
// dedupe" item, at the DB-integration level (progression.test.ts, Task 2,
// covers it at the pure-engine level).
it("seeds a stage from TWO different completed source stages, in declaration order, deduped", async () => {
  const { auth } = await seedOrg();
  const div = await createDivision(auth, { ...GENERIC, name: "D" });
  const [a, b, final] = await createStages(auth, div.id, [
    { seq: 1, kind: "league", name: "A", config: {} },
    { seq: 2, kind: "league", name: "B", config: {} },
    {
      seq: 3,
      kind: "knockout",
      name: "Final",
      config: {},
      progression: {
        sources: [
          { stage: { stageId: "" /* filled below, after a/b exist */ }, take: [{ kind: "rankRange", from: 1, to: 1 }] },
          { stage: { stageId: "" }, take: [{ kind: "rankRange", from: 1, to: 1 }] },
        ],
        placement: "rank_order",
        timing: "on_complete",
      },
    },
  ]);
  // ... complete A and B (score enough fixtures each), then completeStage on
  // whichever completes LAST; assert the final's config.qualified is
  // [winnerOfA, winnerOfB] in that order, and a repeat-entrant scenario
  // (same team registered in both A and B, finishing 1st in both) 422s
  // QUALIFICATION_INVALID via completeStage's best-effort swallow surfacing
  // through a manual seed-proposal-equivalent recompute call instead —
  // follow the neighbouring qualification-from-any-stage.test.ts's
  // multi-stage setup helpers for the create/score/complete boilerplate
  // rather than reinventing it.
});
```

- [ ] **Step 2: Run and confirm failure** (same pattern; `createStages` will
  reject the input until Task 3/5 land — if this is run after Tasks 3/5 in
  sequence, it instead fails inside `seedNextStage`, which is the actual red
  this task turns green).

- [ ] **Step 3: `stage-seeding.ts` — shrink to DB-touching pieces, re-export the engine surface**

```ts
import "server-only";
// D4a/P5 design doc — DB-reading half of stage progression. The pure half
// (take-rule expansion, placement, resolution) moved to
// @seazn/engine/competition (progression.ts) in F2; this file now owns only
// what genuinely needs a transaction: resolving a source-stage REFERENCE
// into a concrete stage row, reading its real shape/standings, and the
// proposal bookkeeping (hash, destination-slot lookup) that only makes
// sense against live fixture rows.
import {
  descriptorKey,
  descriptorLabel,
  expandSources,
  expandTake,
  placeDescriptors,
  progressionSize,
  resolveProgression,
  validateProgressionAgainstShapes,
  type ProgressionSpec,
  type SlotDescriptor,
  type SlotLabel,
  type SourceShape,
  type SourceTables,
  type SourcedSlot,
  type TakeRule,
} from "@seazn/engine/competition";
import { HttpError } from "@/lib/errors";
import { EngineError } from "@seazn/engine/core";

export {
  descriptorKey,
  descriptorLabel,
  expandSources,
  expandTake,
  placeDescriptors,
  progressionSize,
  resolveProgression,
  type ProgressionSpec,
  type SlotDescriptor,
  type SlotLabel,
  type SourceShape,
  type SourceTables,
  type SourcedSlot,
  type TakeRule,
};

export interface PoolTableRows {
  pool: string;
  rows: readonly import("@seazn/engine/competition").StandingsRow[];
}

/** Every DB-facing caller (createStages, replaceStages, templates.ts) hits
 *  this before trusting a progression. Wraps the engine's
 *  validateProgressionAgainstShapes, translating its EngineError into the
 *  HttpError shape callers already handle (same codes, string-for-string —
 *  see Task 1 Step 5's comment on why the codes moved verbatim). */
export async function validateStageProgression(
  tx: Tx,
  target: { division_id: string; seq: number },
  progression: ProgressionSpec,
  presetSources?: { kind: string; config: Record<string, unknown> }[],
): Promise<void> {
  const shapes: SourceShape[] = [];
  for (let i = 0; i < progression.sources.length; i++) {
    const source = presetSources?.[i]
      ? presetSources[i]!
      : await resolveProgressionSource(tx, target, progression.sources[i]!.stage);
    shapes.push(await sourceShapeOf(tx, source));
  }
  try {
    validateProgressionAgainstShapes(shapes, progression);
  } catch (err) {
    if (EngineError.is(err)) throw new HttpError(422, err.message, err.code, err.data as never);
    throw err;
  }
}
```

`resolveProgressionSource` — generalises the old `resolveSeedingSource`
(unchanged body, renamed) to be callable once per `ProgressionSource`
(Decision 4: multi-source means calling this in a loop, once per distinct
`sources[i].stage`, not once per stage). `sourceShapeOf` is unchanged
verbatim. `sourceStandingsTables`/`standingsHash`/`destinationSlotsBySeed`
stay, unchanged in body — they read `fixtures`/`standings_snapshots`, which
did not change shape.

- [ ] **Step 4: `stages.ts` — `generateStageFixtures`'s branch**

`:898-910` (the pre-check before the main transaction):
```ts
    const pre = await withTenant(auth.orgId, async (tx) => {
      const [stage] = await tx<StageRow[]>`
        select ${tx(STAGE_COLS)} from stages where id = ${stageId}`;
      if (!stage) throw new HttpError(404, "stage not found");
      if (!stage.progression) return null;
      const progression = stage.progression as unknown as ProgressionSpec & { timing: "setup" | "on_complete" };
      if (progression.timing === "setup") return { setup: true as const };
      if (Array.isArray(stage.config.qualified)) return null; // already resolved (idempotent re-complete)
      const [prev] = await tx<{ id: string; status: string }[]>`
        select id, status from stages
        where division_id = ${stage.division_id} and seq < ${stage.seq}
        order by seq desc limit 1`;
      return prev ? { setup: false as const, prev } : null;
    });
    if (pre?.setup) {
      const outcome = await generateProgressionSetupFixtures(auth, stageId);
      ...unchanged from here down (the outcome/analytics block)...
    }
    if (pre) {
      if (pre.prev.status !== "complete") {
        throw new EngineError(
          "STAGE_NOT_READY",
          "this stage draws its entrants from the previous stage's final table — complete the previous stage first",
          { stageId, previousStageId: pre.prev.id },
        );
      }
      await seedNextStage(auth, pre.prev.id);
    }
```
`Array.isArray(stage.config.qualified)` — this guard used to distinguish "no
`.qualification`" from "an unrelated stage" implicitly (via `!stage.qualification`
short-circuiting first); now that both timings share one field, the
`progression.timing === "on_complete"` branch is the ONLY path that reaches
this check, so its meaning is unchanged: "already resolved, do not wait on a
predecessor a second time."

- [ ] **Step 5: `generateSeededStageFixtures` → `generateProgressionSetupFixtures`**

Rename the function; its body (`:1396-1751`) changes in exactly three
places, everything else (pool materialisation, stranded-seed guard, label
writing, feed wiring, insert) is unchanged:

1. `const seeding = stage.seeding as unknown as StageSeedingInput;` becomes
   `const progression = stage.progression as unknown as ProgressionSpec;`
   (the `timing` field is read by the caller, not needed inside this
   function — it only runs for `timing === "setup"`).
2. The single-source resolve-and-expand block:
   ```ts
   const source = await resolveSeedingSource(tx, stage, seeding.source);
   const shape = await sourceShapeOf(tx, source);
   const pots = expandTake(seeding.take, shape);
   const placed = placeDescriptors(pots, seeding.placement, seeding.map);
   ```
   becomes the multi-source form:
   ```ts
   const shapes: SourceShape[] = [];
   for (const s of progression.sources) {
     const source = await resolveProgressionSource(tx, stage, s.stage);
     shapes.push(await sourceShapeOf(tx, source));
   }
   const pots = expandSources(progression.sources, (i) => shapes[i]!);
   const placed = placeDescriptors(pots, progression.placement, progression.map);
   ```
   `placed` is now `SourcedSlot[]`, not `SlotDescriptor[]` — every
   `placed[i]` use below (`descriptorLabel(slotOf.get(...)!)` etc.) reads
   `.descriptor` off it; `seedOfSlotId`/`slotOf` bookkeeping is unaffected
   (it maps a synthetic `slot:N` id to the SourcedSlot, and
   `descriptorLabel(slotOf.get(id)!.descriptor)` replaces the old
   `descriptorLabel(slotOf.get(id)!)`).
3. `placed.length < 2` guard's error message: `"this stage's seeding rules produce fewer than 2 qualifiers"`
   → `"this stage's progression rules produce fewer than 2 qualifiers"`.

Every other line (the group-pool materialisation loop, the stranded-seeds
guard, the three `for (const g of gen)` label/insert/feed passes) is
untouched — none of them read `.seeding`/`.qualification` directly, only the
already-resolved `placed`/`slotOf`/`gen` locals this task's Step 5.2 already
covers.

- [ ] **Step 6: `seedNextStage` — the `on_complete` path, now multi-source**

`:1868-2029`'s core (after the standings-tables construction, which is
unchanged: `pools`/`overall`/`bracket` for the JUST-COMPLETED stage) changes
its resolution call. Today (single, implicit source — the completed stage
itself):
```ts
    const entrants = resolveQualification(spec as QualificationSpec, {
      pools,
      ...(overall ? { overall } : {}),
      ...(bracket ? { bracket } : {}),
    });
```
becomes, reading `next.progression` and resolving EVERY distinct source it
names (Decision 4 — the trigger stays "check when the immediately-next stage's
predecessor completes", unchanged; the RESOLUTION underneath is genuinely
multi-source):
```ts
    const progression = next.progression as unknown as ProgressionSpec;
    const shapes: SourceShape[] = [];
    const sourceTables: SourceTables[] = [];
    for (const s of progression.sources) {
      const source = await resolveProgressionSource(tx, next, s.stage);
      shapes.push(await sourceShapeOf(tx, source));
      // The just-completed stage's own tables are already in hand (pools/
      // overall/bracket above); ANY OTHER named source must be complete
      // NOW too, or this throws STAGE_NOT_READY — caught by completeStage's
      // existing best-effort try/catch (Decision 4), same as today.
      if (source.id === completedStageId) {
        sourceTables.push({ pools, bracket });
      } else {
        const [srcRow] = await tx<{ status: string }[]>`select status from stages where id = ${source.id}`;
        if (srcRow?.status !== "complete") {
          throw new EngineError("STAGE_NOT_READY", "a progression source stage is not complete yet", {
            stageId: source.id,
          });
        }
        sourceTables.push(await tablesForCompletedStage(tx, source));
      }
    }
    const { qualifiers } = resolveProgression(progression, shapes, sourceTables);
    const entrants = qualifiers.map((q) => q.entrantId);
```
`tablesForCompletedStage(tx, stage)` is a NEW small helper factoring out the
`pools`/`overall`/`bracket`-from-`standings_snapshots` construction
(`:1895-1943`) into something callable for an ARBITRARY completed stage, not
just `completedStageId` — the body is the existing code, unchanged, wrapped
in a function so it can run once per distinct source instead of once,
inline, for the implicit single source. The `isSpec` guard at `:1885-1893`
and the `carry`-over block at `:1955-1975` (Task 5 Step 3 already deleted
`carry` from the zod/writer side; delete this reader-side block too, in this
task, for the same reason — dead field, no writer sets it).

`qualifierCount` (`:757-763`) → `progressionSize`, reading the new shape and
delegating to the engine (single-source case only — `previewDivisionFixtures`
never sees a multi-source spec, since no writer in this session emits one):
```ts
function qualifierCount(progression: unknown): number {
  if (!progression || typeof progression !== "object") return 0;
  const spec = progression as { sources?: { take?: unknown }[] };
  const take = spec.sources?.[0]?.take;
  return Array.isArray(take) ? progressionSize(take as TakeRule[]) : 0;
}
```
`previewDivisionFixtures`'s `PreviewStageInput` (`:729-734`) renames its
`qualification: unknown` field to `progression: unknown`, and its one call
site (`:787`, `qualifierCount(stage.qualification)`) becomes
`qualifierCount(stage.progression)`. `roundTitle` and every other line of
`previewDivisionFixtures` is untouched (F1's territory) — this is exactly the
rebase-sensitive overlap the Global Constraints section calls out; if F1 has
already landed and deleted `roundTitle`/rewired the round-title call by the
time this task runs, apply this diff against F1's version of the function,
not the one pinned above.

- [ ] **Step 7: `computeSeedProposal`/`confirmSeedProposal` — field renames only**

Both functions' logic is a straight rename (`stage.seeding`→`stage.progression`,
`StageSeedingInput`→`ProgressionSpec`, `seeding.source`→ a loop over
`progression.sources` matching Step 5's pattern, `expandTake`/`placeDescriptors`
calls gain the multi-source wrapping) — no new branching, since these two
functions only ever run for `timing === "setup"` progressions (the
propose/confirm UI is not offered for `on_complete` stages, unchanged). The
`if (!stage.seeding)` guards (`:2187-2189`, `:2329`) become
`if (!stage.progression)`; `SEEDING_RULES_MISSING`'s message text
("this stage has no seeding rules declared") is unchanged — it is still the
correct English for "this stage's progression is null," and the message
string is not part of any test assertion this plan found, so it is not
renamed gratuitously.

- [ ] **Step 8: `openapi:gen`**

```bash
cd <worktree> && npm run openapi:gen && git status --porcelain; echo "EXIT=$?"
```
Expected: the generated OpenAPI doc changes (new `Progression`/`TakeRule`
shapes replacing `QualificationSpec`/`StageSeeding`); commit the diff in the
same commit as this task (acceptance list: "`openapi:gen` run and committed;
`git status --porcelain` empty").

- [ ] **Step 9: Full verification gate**

```bash
cd <worktree> && eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label f2)" && npx vitest run --reporter=json --outputFile=/tmp/f2-all.json > /tmp/f2-all.log 2>&1; echo "EXIT=$?"
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests,suites:.numFailedTestSuites}' /tmp/f2-all.json
cd <worktree> && npx tsc -p packages/engine --noEmit; echo "EXIT=$?"
npx tsx scripts/engine-boundary.ts; echo "EXIT=$?"
npm run i18n:check; echo "EXIT=$?"
git grep -na "QualificationSpec\|stages\.qualification\|stage\.qualification\|\.seeding\b" -- apps/web/src packages/engine/src | grep -av "__tests__" ; echo "grep EXIT=$?"
```
The final `git grep` is the tsc-adjacent gate the Global Constraints section
promises in place of a full `apps/web` typecheck — expect **no output**
(grep exit 1) outside test files still asserting historical behaviour in
their own comments; if any production file still names the deleted fields,
this task is not done. Cross-check the five known-red suites from
`_RULES.md` §4 against this run's failures — re-verify that list is still
accurate before attributing anything to it.

Do not run a bare `apps/web` `tsc --noEmit` here — it is the Global
Constraints section's explicitly banned step (2.8 GB, kills the watchdog).
The `git grep` above plus the full vitest run (which fails to COLLECT any
suite with a real type error, showing as a failed suite with 0 tests) is
this session's substitute gate.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/server/usecases/stage-seeding.ts apps/web/src/server/usecases/stages.ts apps/web/src/server/usecases/__tests__/progression-multi-source.test.ts apps/web/src/server/usecases/__tests__/stage-progression.test.ts apps/web/src/server/usecases/__tests__/combined-qualification.test.ts apps/web/openapi apps/web/public/openapi* 2>/dev/null
git commit -m "readers(F2): generateStageFixtures/seedNextStage/proposal flow read stages.progression, multi-source resolution wired end to end"
```

(adjust the `openapi` glob to wherever `openapi:gen` actually writes in this
repo — confirm with `git status --porcelain` from Step 8 rather than
guessing the path.)

---

## Self-review

**Spec coverage.** The union table's five `TakeRule` kinds each have an
engine-level test (Task 1: shape/expansion; Task 2: resolution) and a
writer that emits them (Task 5: `rankRange`/`picks`/`roundLosers` via
`format-templates.ts`, `topNPerGroup`/`bestNth` via the three catalogue
JSONs). Placement's three algorithms each have a Task 1 test, and
`seeded_map`'s non-empty-map refine is carried into `ProgressionSchema`
(Task 3) verbatim. Multi-source + dedupe has a pure test (Task 2) and a DB
test (Task 6) — the one union-table capability Finding 1 established never
actually worked before this session, not merely moved. `roundLosers` still
seeds a plate from round-1 losers (Task 6 Step 6, `ko_plate`'s
`on_complete` path, unchanged trigger/behaviour). "Placement resolved by ONE
implementation" — Task 1/2 delete `stage-seeding.ts`'s own copies of
`expandTake`/`placeDescriptors`/`resolveQualifiers` and `qualification.ts`'s
`resolveQualification` entirely; Task 6 Step 9's `git grep` is the proof
step the acceptance list asks for. All 8 catalogue templates instantiate —
5 need no content edit (Finding 4), 3 are rewritten and asserted against
their stage graphs (Task 5/6 tests). Engine boundary gate is exercised at
the end of Tasks 1, 2 and 6. No user-facing English enters
`packages/engine` — `SlotLabel`'s `{key, params}` pattern is carried forward
unchanged; the one new i18n surface (`slot.round_loser`) is NOT added to the
dictionaries in this session, because nothing reads it yet (no writer emits
`timing: "setup"` + `roundLosers` together — that is F3's job per "Not in
scope" and the Global Constraints' "do not add a key nothing reads" rule).
If a reviewer expects the key anyway, it is a one-line follow-up, not a gap
in this plan.

**Two ownership decisions resolved, not deferred** (per this plan's brief):
`rankRange` survives `topN` (Decision 2, and its consequence — F2 owns all
five `format-templates.ts` sites, Task 5); `bestNth` survives `bestOfRank`
and absorbs `normaliseUnequalPools`, with the pre-existing dead-code gap
named and pinned by a test rather than silently carried (Decision 2b, Task
2). The design doc's own proposed `Progression` shape is corrected (Decision
1, `timing`) with a stated reason, per "refine it if the code argues
otherwise, and record why."

**Known, named limitations — not silent gaps:** `seeded_map` +
multi-source descriptor-key collisions (Task 1, `placeDescriptors`'s doc
comment); `normaliseUnequalPools:true` remains a no-op absent a real
per-pool match ledger no caller populates (Decision 2b); a multi-source
progression whose sources complete out of `seq`-adjacency order may need a
manual recompute (Decision 4).

**Cross-session dependency.** `previewDivisionFixtures`
(`stages.ts:778-859`) and `qualifierCount`/`progressionSize`'s call site
inside it are touched by this session; `roundTitle` and the round-naming
half of the same function are F1's. Task 6 Step 6 states explicitly: apply
this session's diff against whatever F1 leaves behind after it merges, not
against the line numbers pinned at session start — F1 merges first per the
Global Constraints section.

### Critical Files for Implementation

- `packages/engine/src/competition/progression.ts`
- `apps/web/src/server/api-v1/schemas.ts`
- `apps/web/src/server/usecases/stages.ts`
- `apps/web/src/server/usecases/stage-seeding.ts`
- `db/migration/deltas/V371__stage_progression_field.sql`
