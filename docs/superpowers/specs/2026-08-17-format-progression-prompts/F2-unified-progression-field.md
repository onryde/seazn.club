# F2 — one progression field: the union of `qualification` and `seeding`

Paste this whole file as the session opener. Read `_RULES.md`, then `_INDEX.md`,
then this. Engine + schema + server session. No UI.

Branch `feat/f2-unified-progression` in a fresh worktree. One PR.
Design: `../2026-08-17-format-progression-design.md` §2.1, §3, §5.

**Independent of F1.** F3, F4 and F5 all wait on this MERGING, not on this being
written — they must be authored against the shape that actually ships.

## Why

Two fields describe the same idea — who arrives in this stage, from where, in
what order — and a stage may hold only one of them
(`stages.ts:217-222` returns 422 `SEEDING_RULES_MISSING` when both are set).
The split has a hard product consequence:

- `seeding` generates a stage's fixtures **at setup, with placeholder slots**.
  `qualification` generates nothing until its source stage completes.
- **Every multi-stage picker template uses `qualification`. None uses
  `seeding`.** So no competition built through the normal picker shows its final
  before the league ends.
- `seeding` can express a correct **draw** (`snake`, `seeded_map`,
  `topNPerGroup`); `qualification` cannot. A `topN: 6` over two groups flattens
  everyone into one ranked list, so two teams from the same group can meet in
  the quarter-final.

Neither field is a superset of the other, so this is a union, not a rename.

## The union — what the new field must express

| capability | today only in | notes |
|---|---|---|
| `rankRange {from,to}` | seeding | |
| `topNPerGroup {n}` | seeding | expands across however many groups exist |
| `bestNth {nth,count}` | seeding | |
| `picks [{pool,rank}]` | qualification (`TakePicks`) | literal enumeration, declaration order is seed order |
| `topN {n}` | qualification | equivalent to `rankRange 1..n` — collapse, do not keep both |
| `bestOfRank {rank,count,normaliseUnequalPools?}` | qualification | overlaps `bestNth`; reconcile deliberately and record which won |
| `roundLosers {round,count}` | qualification (L3/#414) | **`count` is required** |
| `placement: rank_order \| snake \| seeded_map(map[])` | seeding | `seeded_map` requires a non-empty map |
| **multiple sources**, each naming a different stage | qualification (`combine[]` + per-spec `from?`) | `seeding.source` is singular — this is the axis seeding lacks |
| dedupe across sources | qualification | an entrant qualifying twice is an error, not a duplicate |
| TBD generation before the source completes | seeding | the whole point |

Proposed shape (refine it if the code argues otherwise, and record why):

```ts
interface Progression {
  sources: { stage: "previous" | { stageId: string }; take: TakeRule[] }[];
  placement: "rank_order" | "snake" | { seededMap: { slot: string; source: string }[] };
}
```

## Scope

1. **Engine** — one pure resolver. The take rules and all three placement
   algorithms are pure and belong next to `qualification.ts`; today the
   placement half lives in `apps/web/src/server/usecases/stage-seeding.ts`
   (`TakeRule`/`Placement`/`SeededMapEntry` at `:42-52`, `placeDescriptors`,
   pattern expansion at `:118-137`, snake at `:158-160`, seeded_map at
   `:166-215`). Move the pure parts into `packages/engine`; leave behind only
   what genuinely needs a transaction (source-shape validation reads the DB).
2. **Migration** — `V<next>__stage_progression.sql`. **Greenfield, owner-ruled
   2026-08-17: no production data.** Drop `stages.qualification` and
   `stages.seeding`; add `stages.progression jsonb`. Strict constraints from day
   one. **Step 1 of this session is to verify the zero-rows premise against the
   target database and STOP if it is false** — the ruling is dated and this file
   will outlive its accuracy.
3. **Zod** — one `ProgressionSchema` replacing `QualificationSpecSchema`
   (`schemas.ts:508`) and `StageSeedingSchema` (`:543-555`). Delete the
   mutual-exclusion 422 at `stages.ts:217-222`; with one field it is unreachable.
4. **Writers** — `createStages` (`stages.ts:228`) and `instantiateTemplate`
   (`templates.ts:327`).
5. **Readers** — `seedNextStage` (`stages.ts:1763`), `generateSeededStageFixtures`
   (`:1376-1505`), `computeSeedProposal` (`:2038`), `confirmSeedProposal`
   (`:2172`), `fillSlot` (`:2303-2306`), `validateSeedingAgainstShape`
   (`stage-seeding.ts:235-244`), `qualifierCount`.
6. **The 8 catalogue templates** (`apps/web/src/server/templates/catalog/*.json`)
   — rewrite their `seeding` blocks. They are the only shipped producers of the
   old seeding shape.
7. `npm run openapi:gen`, committed.

## Not in scope

- Making the picker emit the new field, or day-one generation for picker
  formats — **that is F3.** F2 changes the plumbing; the picker keeps behaving
  as it does now, through the new field.
- Round naming — F1.
- Anything about score-dependent formats — F4.

## Acceptance

- [ ] Zero-rows premise verified against the target DB before the migration is
      written; recorded in the PR body with the query and its output
- [ ] Migration applies from zero on a clean schema; `stages.qualification` and
      `stages.seeding` are gone
- [ ] **Every capability in the union table above has a test**, including the
      two that only one side had: multi-source `sources[]` with dedupe, and
      `snake` / `seeded_map` placement
- [ ] An entrant qualifying through two sources is rejected, with a code
- [ ] `roundLosers` still seeds a plate from round-1 losers in bracket order
      (L3/#414's behaviour, now through the new field)
- [ ] Placement is resolved by ONE implementation — grep proves
      `stage-seeding.ts` no longer holds a second copy
- [ ] All 8 catalogue templates instantiate and produce the same stage graphs
      they do today — assert the graphs, not just that it did not throw
- [ ] `openapi:gen` run and committed; `git status --porcelain` empty
- [ ] Engine boundary gate green; no user-facing English in `packages/engine`
- [ ] `npx tsc --noEmit` in `apps/web` EXIT=0 (`NODE_OPTIONS=--max-old-space-size=6144`)
- [ ] Goldens byte-identical

## Gotchas

- **`topN` and `rankRange` are the same fact.** Keeping both invites the exact
  drift this session exists to end. Same question for `bestOfRank` vs `bestNth`
  — pick one, delete the other, say which in the PR body.
- **`seeded_map` validation is real** — the current zod refine requires a
  non-empty map iff `placement === "seeded_map"`. Carry that; do not let a
  slot-override placement ship with nothing to override.
- **Declaration order is data.** `TakePicks.take` is consumed positionally —
  its array order IS the seed order. Any reshaping that sorts or normalises it
  silently changes brackets.
- **`generateSeededStageFixtures` needs the ORDERED list, not a count**
  (`:1382-1400` builds `placed: SlotDescriptor[]`, then mints `slot:N` per
  entry). A refactor that hands it a size will compile and produce wrong
  pairings.
- **Both fill-time paths re-derive the same order** (`computeSeedProposal:2069`
  recomputes `placeDescriptors`). If the unified resolver is not deterministic,
  a proposal and its confirmation can disagree.
- L3/#414 added `roundLosers` to the qualification union; absorb it rather than
  reimplementing it.
- The five known-red suites in `_RULES.md` §4 are not yours.

## Execution

Sequential implementer → reviewer loop. `stages.ts`, `schemas.ts` and
`stage-seeding.ts` are single-writer, and this session touches all three.

**Scout (sonnet) first:** re-pin every line reference above, and report the
current signature of every reader listed in scope item 5. file:line table only,
under 30 lines.

**Reviewer focus:** is there exactly one placement implementation? Does any
reader still branch on which of the two old fields was set? Is declaration order
preserved end to end? Does the migration assume rows exist anywhere?

## On close

`_INDEX.md`: F2 → DONE, the **shipped** `Progression` shape (F3/F4 are authored
against it, so paste the real type), which of the overlapping rule pairs
survived, and the new V-number. Memory + `scripts/agent-memory-snapshot.sh`.
