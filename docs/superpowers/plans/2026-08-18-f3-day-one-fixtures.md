# F3 — day-one fixtures, and a correct draw — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development`
> to execute this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** every format an organiser can pick shows its whole draw — final
included — the day the division is created, with a correct cross-group draw and
a warning when late entries make that draw stale.

**Organiser value (why each task exists is restated per task):** an organiser
publishes one link on day one and it already shows the route to the final;
qualifiers come from every group rather than only the first two; and when late
entries change the shape, the organiser is told before anyone plays, with one
button to rebuild.

**Architecture:** the capability already exists — `progression.timing: "setup"`
makes `generateProgressionSetupFixtures` (`stages.ts:1432`) write placeholder
fixtures with `home/away_slot_label`. F3 turns it on for every picker format,
replaces the picker's hand-rolled 2-pool interleave with the engine's
`topNPerGroup` + `snake` (already proven by `t20-super8.json`), adds a derived
staleness signal + rebuild affordance, and moves the picker's 14 English
`label`/`help` literals into the four locale dictionaries.

**Tech Stack:** TypeScript 7, Node 26, pnpm, Next.js (app router), vitest,
Playwright, Postgres via Flyway (`db/migration/deltas`).

**Spec:** `docs/superpowers/specs/2026-08-18-format-progression-f3-f5-design.md`
§2, §3, §7 — read with `docs/superpowers/specs/2026-08-17-format-progression-prompts/_INDEX.md`
(rulings) and `_RULES.md` (invariants).

## Global Constraints

- **Every change ships a test that fails without it.** All four types this
  session: unit, e2e (Playwright), smoke (`scripts/smoke.ts`), regression.
- **Four locales, always**: `apps/web/src/dictionaries/{en,es,fr,nl}/*.json`,
  flat dotted keys. A key with no reader is the inert-seam pattern — ship the
  reader in the same commit.
- **UI verified by screenshot** at 1280, 320, 768; no horizontal page scroll.
- **Judge vitest only from** `--reporter=json --outputFile`; read
  `numPassedTests` / `numTotalTests` / `numFailedTestSuites`.
- **CI gate is `turbo run lint typecheck` from the repo root**, not `npm run lint`.
- `apps/web` typecheck needs `NODE_OPTIONS=--max-old-space-size=6144`.
- Worktree: `/Users/ashokhein/github/seazn.club/.claude/worktrees/f3-day-one`,
  branch `feat/f3-day-one-fixtures`. Prefix `cd <abs worktree> &&` in the SAME
  call as every command. Never `git stash` here.
- DB for this session: `seazn-env … --label f3` (Postgres :54583, db `seazn_f3`).
  `eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label f3)"`.
- **Known-red baseline, measured on this branch 2026-08-18**: 2561 passed /
  2608 total, 4 failed — all in
  `apps/web/src/server/usecases/__tests__/schedule-build-honours-locks.test.ts`
  (needs the placement service; `seazn-env up --label f3 --placement`). Any
  other red is yours.
- **Do not touch**: `packages/engine/src/sport/**`, the fidelity-tier scale, the
  scoring pad, the `StageKind` enum.
- **Do not open a GitHub issue for anything found.** Fix it here; if the fix
  widens past this plan's file list, stop and ask. Record every such fix in the
  PR body under `Unplanned fixes`.

## Owner rulings this plan executes (dated 2026-08-18)

| # | Ruling |
|---|---|
| R1 | All six multi-stage picker templates flip to `timing: "setup"` |
| R2 | Placement derived from source shape — automatic, no new UI |
| R3 | Entrant churn: **detect and offer** — banner + one-click rebuild, never auto-reshape, never lock entrants |
| R4 | Flip scope = `format-templates.ts` ×6 **plus `config/format-gallery.tsx` ×3**; `stages-panel.tsx`'s ad-hoc AddStageForm and the seed scripts stay `on_complete` |
| R5 | `groups_ko` converts its hand-rolled `picks` interleave to `topNPerGroup` (+ `bestNth` remainder) with `snake` placement |

---

## File structure

| File | Responsibility after F3 |
|---|---|
| `apps/web/src/lib/format-templates.ts` | 14 templates; `timing: "setup"` on the six; knob-aware `build(knobs)`; i18n key refs instead of English literals |
| `apps/web/src/config/format-gallery.tsx` | gallery `cannedStages` — same `setup` timing as the picker |
| `apps/web/src/components/v2/division-builder.tsx` | renders template label/help via `useMsg()`; mexicano mapping comment |
| `apps/web/src/components/v2/division-settings.tsx` | same, on the settings surface |
| `apps/web/src/components/v2/stages-panel.tsx` | new: staleness banner + rebuild action |
| `apps/web/src/server/usecases/stages.ts` | new: derived staleness comparison exposed on the stage payload; sourced-key disambiguation (P6) |
| `packages/engine/src/competition/progression.ts` | P6: ambiguity detection in `placeDescriptors`/`descriptorKey` consumers |
| `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json` | 28 new keys (14 labels + 14 helps) + banner copy |

---

## Findings that changed this plan (verified in code, 2026-08-18)

1. **§2.3's "wrong draw" premise is true, but via a different mechanism.**
   `groups_ko` does not emit a flat ranked list — its take is `picks`
   alternating `A1,B1,A2,B2…` (`format-templates.ts:69-97`), a hand-rolled
   2-pool snake. What is actually broken: the builder offers a **pools 2–8
   knob** (`division-builder.tsx:694-706`) which `buildTemplateStages`
   (`format-templates.ts:215-224`) applies to the group stage — while the
   knockout's `picks` stay hardcoded to pools A and B. **With 4 pools, groups C
   and D produce no qualifiers at all.** Organiser value of fixing it: every
   group you create can actually qualify someone.
2. **Three more user-reachable emitters** beyond the brief's six:
   `config/format-gallery.tsx:277,308,321`. Owner ruling R4 includes them.
3. **`timing: "setup"` + `carry` is rejected by the schema**
   (`api-v1/schemas.ts` second `.refine`). No template, gallery entry, catalogue
   file or UI writes `carry` (grep: zero hits outside `stages.ts`/tests), so no
   organiser loses anything today — but after F3 the marketed Pro entitlement
   `standings.carry_over` (`feature-copy.ts:51`) is unreachable on any picker
   format via the API too. **Not fixed here**; recorded in the index as a
   product decision for the owner (implementing carry on the setup path means
   carrying points at `confirmSeedProposal` time).
4. **The 25-format sweep is a committed snapshot**
   (`__tests__/__snapshots__/format-catalogue.test.ts.snap`, asserted at
   `format-catalogue.test.ts:88`). The flip moves it. Re-baseline honestly: a
   commit that shows the diff and states which formats changed and why — never
   a silent regeneration.
5. **No fixtures-vs-rules comparator exists.** `computeSeedProposal` compares
   inline at `stages.ts:2287-2311`. Task 5 extracts that comparison so the
   banner and the 422 cannot drift apart (this repo's parallel-path failure).

---

### Task 1: Flip every picker format to day-one fixtures

**Organiser value:** pick League + Finals, and the final is on the schedule the
same minute the division exists — with "Winner of Group A" style placeholders
rather than TBD, because labelling only ever runs on the `setup` path.

**Files:**
- Modify: `apps/web/src/lib/format-templates.ts:63,98,112,125,194,208`
- Modify: `apps/web/src/config/format-gallery.tsx:278,309,322`
- Test: `apps/web/src/lib/__tests__/format-templates.test.ts`
- Test: `apps/web/src/server/usecases/__tests__/format-catalogue.test.ts` (+ its snapshot)

**Interfaces:**
- Consumes: nothing.
- Produces: every multi-stage `StageDraft.progression.timing === "setup"`. Later
  tasks assume the picker's six and the gallery's three are all `setup`.

- [ ] **Step 1: Write the failing test** — in `format-templates.test.ts`, one
  test that walks `STAGE_TEMPLATES`, builds each with representative knobs, and
  asserts every non-null `progression.timing` is `"setup"`; plus the same walk
  over `format-gallery.tsx`'s `cannedStages`. It must fail listing all nine.
- [ ] **Step 2: Run it, confirm it fails**
  `cd <worktree> && npx vitest run --root apps/web --reporter=json --outputFile=/tmp/f3-t1.json src/lib/__tests__/format-templates.test.ts`
- [ ] **Step 3: Flip the nine `timing` literals.** Update the file-header
  comment in `format-templates.ts:11-13` — it currently states that every writer
  emits `on_complete` as a deliberate F2 decision; it must now say F3 flipped
  them and why.
- [ ] **Step 4: Update the inline assertions** in `format-templates.test.ts`
  (`:29-30,67-68,126-127,144-145,153-154,182-183,191-192`) and
  `format-catalogue.test.ts:23-24,45-46`. Delete the stale "F3 owns flipping
  timing to setup" comment at `format-templates.test.ts:9`.
- [ ] **Step 5: Re-baseline the sweep snapshot deliberately.** Run
  `format-catalogue.test.ts`, inspect the snapshot diff, and confirm by reading
  it that the only changes are timing-driven (placeholder fixtures now present
  at setup for the six/nine formats). Commit the snapshot in its own commit
  whose message names every format whose shape changed.
- [ ] **Step 6: Run both suites green** (`--reporter=json`, check
  `numFailedTestSuites: 0` and that `numTotalTests` moved).
- [ ] **Step 7: Commit** — `feat(formats): every picker format shows its full draw at setup`

### Task 2: A draw that uses every group

**Organiser value:** four groups means four groups' worth of qualifiers, drawn
so group-mates meet as late as the bracket allows — the standard convention,
instead of a two-pool assumption that silently ignored groups C and D.

**Files:**
- Modify: `apps/web/src/lib/format-templates.ts` (`StageDraft` build
  signature, `groups_ko` at `:67-99`, `buildTemplateStages` at `:215-224`)
- Modify: `apps/web/src/config/format-gallery.tsx:265-278` (the `picks` entry —
  same 2-pool assumption)
- Test: `apps/web/src/lib/__tests__/format-templates.test.ts`
- Test: `apps/web/src/server/usecases/__tests__/format-catalogue.test.ts`

**Interfaces:**
- Consumes: Task 1's `timing: "setup"`.
- Produces: `build: (knobs: TemplateKnobs) => StageDraft[]` — the build callback
  now receives the whole knob set, not just `q`. Every template in the array
  changes signature; `buildTemplateStages` passes `knobs` straight through and
  keeps applying `legs`/`rounds`/`pools` to `config` afterwards.

- [ ] **Step 1: Write the failing tests.** Three cases, all against
  `buildTemplateStages("groups_ko", …)`:
  (a) `{qualified: 8, poolCount: 4}` → take is
  `[{kind:"topNPerGroup", n:2}]`, `placement: "snake"`;
  (b) `{qualified: 16, poolCount: 6}` → `[{kind:"topNPerGroup", n:2},
  {kind:"bestNth", nth:3, count:4}]` (12 + 4 = 16 — euro24's shape, which is the
  reference to match, not a third convention);
  (c) `{qualified: 3, poolCount: 2}` (reachable from the Settings tab's free
  2–32 input) → `[{kind:"topNPerGroup", n:1}, {kind:"bestNth", nth:2, count:1}]`.
  Plus a regression test named for the defect: with `poolCount: 4`, the emitted
  take must not reference only pools A and B.
- [ ] **Step 2: Run, confirm failure** (same vitest invocation as Task 1).
- [ ] **Step 3: Implement.** `n = Math.floor(q / poolCount)`,
  `r = q - n * poolCount`; take `= [topNPerGroup n]` plus, when `r > 0`,
  `[{kind:"bestNth", nth: n + 1, count: r}]`; placement `"snake"`. Guard
  `n === 0` (q < poolCount) by falling back to `topNPerGroup 1` truncated —
  write the test for that case too and make the behaviour explicit in a comment.
- [ ] **Step 4: Run tests green.**
- [ ] **Step 5: Verify the engine agrees.** Add a test in
  `format-catalogue.test.ts` that runs the real generator over
  `groups_ko` with 4 pools / 8 qualifiers and asserts the produced slot labels
  name all four pools.
- [ ] **Step 6: Commit** — `fix(formats): groups + knockout draws from every pool, not just A and B`

### Task 3: Resolve P6 — multi-source key collisions

**Organiser value:** none directly; this is the "silent wrong wiring" class this
programme exists to end. A collision would put the wrong team's placeholder in
the wrong bracket seat with every test green.

**Files:**
- Modify: `packages/engine/src/competition/progression.ts:209-254` (`placeDescriptors`)
- Modify: `apps/web/src/server/usecases/stages.ts:1457-1462` (`slotOf`)
- Test: `packages/engine/src/competition/progression.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `placeDescriptors` throws `SEEDING_MAP_SOURCE_AMBIGUOUS` when a
  `seeded_map.source` string matches descriptors from more than one
  `sources[]` entry. `slotOf` keys on `${sourceIndex}:${descriptorKey(d)}`.

- [ ] **Step 1: Write the failing test.** Two sources each exposing a pool "A",
  `placement: "seeded_map"`, `map: [{slot:"1", source:"A1"}]`. Today it silently
  resolves to whichever `flat()` visits first. Assert it throws
  `SEEDING_MAP_SOURCE_AMBIGUOUS`. Second test: two sources with pool "A", no
  seeded_map — assert both slots survive into `placeDescriptors`' output with
  distinct `sourceIndex`, and that a `slotOf`-style map keyed the new way holds
  two entries rather than one.
- [ ] **Step 2: Run, confirm failure.**
- [ ] **Step 3: Implement.** In `placeDescriptors`, build `byKey` while counting
  duplicates; throw `EngineError("SEEDING_MAP_SOURCE_AMBIGUOUS", …)` naming the
  key and the two source indexes. In `stages.ts`, key `slotOf` by sourced key
  and look it up the same way at `:1556-1566`. Replace the "KNOWN LIMITATION"
  comment at `progression.ts:203-208` with what is now true.
- [ ] **Step 4: Run engine + stages suites green.**
- [ ] **Step 5: Record the verdict in the programme index** —
  `_INDEX.md` gets a line saying the collision was real, was unreachable from
  the picker (all shipped progressions are single-source), and is now a 422
  rather than a silent mis-seat.
- [ ] **Step 6: Commit** — `fix(engine): a seeded_map source matching two progression sources now 422s`

### Task 4: Prove day-one fixtures are schedulable (§7 P1)

**Organiser value:** the whole tournament — group stage and knockout — can be
scheduled, printed and shared on day one, instead of scheduling stage 1 now and
coming back later for the bracket.

**Files:**
- Test: `apps/web/src/server/usecases/__tests__/` (new integration spec)
- Test: `scripts/smoke.ts` (a day-one assertion in the existing format section)

- [ ] **Step 1: Write the failing integration test.** Create a division from
  `groups_ko` (4 pools, 8 qualifiers), generate, then assert: the knockout
  stage's placeholder fixtures exist with `home_slot_label`/`away_slot_label`
  set, they appear in the schedule board payload, and a BUILD run places them
  without erroring. Needs the DB env (`--label f3`) and, for BUILD, the
  placement service (`--placement`).
- [ ] **Step 2: Run it, confirm it fails or passes for the right reason.** If a
  scheduling gate rejects entrant-less fixtures, **stop and report** — the
  design says that gate is then the real work.
- [ ] **Step 3: Add the smoke assertion** in `scripts/smoke.ts` alongside the
  existing format checks: a picker-created multi-stage division has fixtures in
  its final stage immediately after creation.
- [ ] **Step 4: Run smoke** against the label-f3 server and paste the counts.
- [ ] **Step 5: Commit** — `test(formats): day-one fixtures reach the board and survive a build`

### Task 5: Entrant churn — detect and offer (R3)

**Organiser value:** late entries are normal. Today the organiser finds out the
bracket no longer matches only when seeding 422s, after they have already
shared the link. After this task they see "built for 16 qualifiers; your groups
now produce 18 — rebuild?" with one button, and nothing reshapes unless they
press it.

**Files:**
- Modify: `apps/web/src/server/usecases/stages.ts` — extract the comparison at
  `:2287-2311` into a shared helper; extend `listStages` (`:178`)
- Modify: `apps/web/src/components/v2/stages-panel.tsx` — `StageRow` type
  (`:39-47`), banner near the stage row, rebuild via the existing
  `POST /stages/{id}/generate` (`:470-473`)
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`
- Test: unit (helper), integration (payload), e2e (banner + rebuild), smoke

**Interfaces:**
- Consumes: Task 1 (`setup` stages exist to go stale) and Task 2 (`topNPerGroup`
  makes the produced count pool-count dependent, which is what drifts).
- Produces: `progressionDrift: { generated: number; expected: number } | null`
  on each `StageRow`, derived — never stored.

- [ ] **Step 1: Write the failing unit test** for the extracted helper
  (`progressionDriftOf(stage, sourceShapes, generatedSlotCount)`): equal counts
  → `null`; more expected than generated → the pair; fewer → the pair.
- [ ] **Step 2: Write the failing integration test** — create a `setup` stage
  from 2 pools × top 2, generate, add enough entrants to make a third pool, and
  assert `listStages` reports the drift while nothing regenerates on its own.
- [ ] **Step 3: Extract the helper and make `computeSeedProposal` call it**, so
  the 422 at `:2305` and the banner cannot disagree. Its existing behaviour must
  not change — the existing proposal tests are the guard.
- [ ] **Step 4: Build the banner.** Amber callout on the affected stage row,
  matching the existing warning at `stages-panel.tsx:549`; copy in four locales;
  primary action calls the existing generate endpoint and refreshes. It must be
  reachable and readable at 320px.
- [ ] **Step 5: Write the stranded-seed regression test.** Per
  `stages.ts:1490-1499`: a rebuild offered by this banner must not strand seeds
  into the state whose own error text admits "regenerate them first" cannot
  work. Assert the rebuild either succeeds or fails with an actionable message —
  never leaves a stage that can no longer be seeded.
- [ ] **Step 6: e2e** — add to `apps/web/e2e/` a spec that drives the banner and
  the rebuild, and add the surface to `mobile.spec.ts` so all seven widths cover
  it (a new UI surface has zero width coverage until it is listed there).
- [ ] **Step 7: Screenshot** at 1280, 320, 768; no horizontal page scroll.
- [ ] **Step 8: Commit** — `feat(stages): warn when late entries outgrow a generated bracket`

### Task 6: The picker speaks four languages

**Organiser value:** a Spanish, French or Dutch organiser reads the format
picker in their own language instead of English — the first screen of the
product, and the last hardcoded-English surface in it.

**Files:**
- Modify: `apps/web/src/lib/format-templates.ts` (14 × `label`/`help`
  → key refs, e.g. `labelKey: "wizard.format.league_ko.label"`)
- Modify: `apps/web/src/components/v2/division-builder.tsx:672-673`
- Modify: `apps/web/src/components/v2/division-settings.tsx:539,544`
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json` (+28 keys)
- Modify: `apps/web/e2e/formats.spec.ts:26-32,62`,
  `apps/web/e2e/mobile.spec.ts:1612,1692`,
  `apps/web/e2e/format-templates.spec.ts:45,68`
- Modify: `apps/web/src/components/v2/division-builder.tsx:61` — one-line
  mexicano→americano comment (§4 ruling; nothing else)

- [ ] **Step 1: Write the failing test** — a unit test asserting every
  `STAGE_TEMPLATES` entry exposes a key that exists in all four locale files,
  and that neither component renders a raw literal (assert on the rendered
  output going through `msg()`).
- [ ] **Step 2: Run, confirm failure.**
- [ ] **Step 3: Add the 28 keys to all four locales**, English text copied
  verbatim from today's literals so English rendering is byte-identical.
- [ ] **Step 4: Wire the readers in the same commit** — `useMsg()` in both
  components; no key ships without a reader.
- [ ] **Step 5: Update the e2e specs** that pin the English strings; they still
  pin English because the e2e locale is English, but they must resolve through
  the dictionary, not the literal.
- [ ] **Step 6: `npm run i18n:check`** (CI runs it at `.github/workflows/ci.yml:110`)
  and `npm run i18n:gen-keys` staleness check.
- [ ] **Step 7: Commit** — `feat(i18n): the format picker reads from the dictionaries`

### Task 7: Verification wave (nothing is done until this is green)

- [ ] `cd <worktree> && NODE_OPTIONS=--max-old-space-size=6144 npx turbo run lint typecheck > /tmp/f3-gate.log 2>&1; echo "EXIT=$?"` — the CI gate.
- [ ] Full `apps/web` vitest with `--reporter=json --outputFile`; compare against
  the 2561/2608 baseline, with the 4 placement-service reds accounted for.
- [ ] `packages/engine` suite (it has its own lint + coverage gate).
- [ ] e2e on a prod build (`E2E_PROD_TARGET`), including `mobile.spec.ts`'s seven
  width projects.
- [ ] Smoke against the label-f3 standalone server.
- [ ] `npm run openapi:gen && git status --porcelain` empty.
- [ ] Screenshots at 1280 / 320 / 768 of: the builder picker, a created
  multi-stage division's stage list with day-one fixtures, and the staleness
  banner.
- [ ] Update `_INDEX.md`: F3 status, the four findings above, and the
  `carry` + `setup` product decision.
