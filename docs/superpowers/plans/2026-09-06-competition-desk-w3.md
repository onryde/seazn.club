# Competition Desk W3 — the stage rail, the in-play band, and the phone composition

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move stage chrome onto a rail and fold it for phones, give the competition page a live in-play band, make the fixtures tab a real phone composition rather than a groomed shrink, and stop an odd-entrant Swiss stage reporting its own designed sit-out as a data fault.

**Architecture:** One branch, ten tasks, in dependency order. The rail is built desktop-only first (tasks 2-5) and folded last (task 10), so the desktop composition is settled before any phone behaviour touches it. The band has one producer — `getCompetitionDesk` gains the fixture list for first paint, and a new read-only endpoint returns the same shape for a 20 s poll. The phone work re-composes DOM that already exists rather than branching a second tree.

**Tech Stack:** Next.js App Router (async server components + `"use client"` islands), React, Tailwind, Zod (api-v1 schemas), vitest (`environment: "node"` — no DOM), Playwright.

**Spec:** `docs/superpowers/specs/2026-09-02-competition-desk-design.md` §W3 (amendment 5). Owner rulings 11-18 in `docs/superpowers/specs/2026-09-02-competition-desk-prompts/_INDEX.md`.

## Global Constraints

- **One PR** (ruling 18). Ruling 13's substance still holds inside it: the rail is built **desktop-only** in tasks 2-5, and nothing folds it until task 10. Do not add a `max-md:`, an `md:hidden` or a bottom sheet to the rail before task 10.
- **Task order is a dependency, not a preference.** Task 1 and tasks 2-5 both edit `stages-panel.tsx`; task 1 goes first so the rail extraction moves settled code. Task 10 needs tasks 2-5 merged into the branch.
- **`capacityByStage` must not move.** `stages-panel.tsx` says so above the `useCapacityReportsByStage` call: the auto-schedule button "has to stay a DIRECT part of this component's own render output; see the hook's own header for why a per-stage child component broke pre-existing tests that locate it by testid". The hook stays called exactly once, in `StagesPanel`. `stage-rail.tsx` is **presentational** and receives a per-stage verdict as a plain prop.
- **"Compute proposal" is not a control.** Ruling 11 lists seven; six exist. `propose()` is a private closure inside `autoScheduleStage`, sharing the auto-schedule handler. Move six. Invent no seventh.
- **Testids:** `stage-auto-schedule`, `stage-auto-schedule-blocked`, `stage-unscheduled-count`, `roster-drift-banner`, `roster-drift-rebuild` already exist and must move byte-identical. Generate, Complete and Delete carry **none** — task 2 adds `stage-generate` / `stage-complete` / `stage-delete`, breaking no existing locator.
- **`in_play` is DERIVED, never stored.** `server/engine-db/append-event.ts` — `return has("core.start") ? "in_play" : "scheduled"`. In e2e, start a fixture with `seedRosteredFixture(request, { …, emitCoreStart: true })`. **Never `setFixtureStatusSql`** (`e2e/helpers.ts`): it force-sets the column with no engine event, producing a fixture that looks in-play with an empty ledger — a band test built on it asserts nothing.
- **The acceptance criterion for the phone work is a control-set DIFF at 320 vs 1280.** W2's gate measured them byte-identical (71 controls, `diff` empty). Same set at smaller sizes is a groomed shrink; a different set is a composition. Compare the visible control SET from the live DOM — membership, order, repeats — never box sizes.
- **Run whole spec files, never a `-g` slice.** `mobile.spec.ts` is `describe.configure({ mode: "serial" })`: the first red aborts everything after it, so a failure count is a floor, not a total. Re-run after each fix until a full pass completes.
- **Task 8 changes the 640-767 band, which no Playwright project covers** (320/360/375/390/430/768/834). Check ~700 by hand; the matrix is structurally blind to it.
- `apps/web` vitest is `environment: "node"` — **no DOM**. A `max-md:hidden` body still renders into the markup, so a class-scan test stays green while five width projects go red on `toBeVisible()`. Anything a user touches gets an e2e, not just a unit.
- All new user-facing strings go in `dictionaries/{en,es,fr,nl}/ui.json` under `desk.*`, then `pnpm i18n:gen-keys` (regenerates `i18n-keys.ts` — never hand-edit it).
- Package manager is **pnpm**. Vitest: `cd apps/web && pnpm vitest run …`, never `--root`. Judge green from `--reporter=json --outputFile` (`numPassedTests` / `numTotalTests`), and treat a DROP in the total as a collection failure, not a pass.
- Every change ships a test that fails without it.

---

### Task 1: The odd-Swiss sit-out miscopy — drive it, then fix it

**First, because it is the only task whose shape is unknown, and because it edits `stages-panel.tsx` before the rail extraction moves that code.**

**Files:**
- Read: `packages/engine/src/scheduling/swiss.ts` (`pairRound`, the `bye` field)
- Read: `apps/web/src/server/usecases/stages.ts` (`swissGen` mapping; the stage-wide `referenced` query and the `ghosts`/`unplaced` computation)
- Modify (one of, decided by Step 3): `apps/web/src/lib/roster-drift-eligibility.ts` · `apps/web/src/server/usecases/stages.ts` · `apps/web/src/components/v2/stages-panel.tsx` + the four dictionaries
- Test: `apps/web/src/server/usecases/__tests__/stage-roster-drift.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing later tasks depend on.

**Background, established — do not re-derive:** `pairRound` puts the sat-out entrant in a `bye` field, excluded from `pairings`. `swissGen` maps only `round.pairings`, so that entrant gets **no fixture row at all** — not a bye row, not a null-opponent row. Roster drift computes `unplaced` as active entrants referenced by no fixture **stage-wide**, so the sat-out entrant lands in it, `hasDrift` goes true, and the banner "Fixtures don't match the roster" plus a "Rebuild fixtures" CTA renders. Keys are `progression.rosterDrift.heading` and `progression.rosterDrift.rebuildCta`, translated in all four locales. `isRosterDriftEligible` gates on `stage.progression === null` **and** `!ROSTER_DRIFT_INELIGIBLE_KINDS.has(stage.kind)`, where the set is `{ladder, americano}` — so the miscopy can only appear on a **progression-less** Swiss stage. That narrows the repro.

- [ ] **Step 1: Stand up a local environment**

Follow the `seazn-local-env` skill. Two traps it exists for: `db:apply` alone is not a fresh schema — it needs `sync:sports`, or `funnel.test.ts` fails `expected 'generic' to be 'badminton'`; and a `pg_ctl` that fails with "Address already in use" is followed by a `createdb` that SUCCEEDS against another session's server. Confirm `show data_directory` is yours before trusting anything.

- [ ] **Step 2: Drive the repro in a browser**

Division with an **odd** entrant count (5 is enough), a **Swiss** stage with no progression, generate round 1. Open `?tab=fixtures`. Read the banner. Screenshot it.

- [ ] **Step 3: Drive the second round — the question the fix turns on**

Pair round 2 so the round-1 sat-out entrant now plays. Re-read the banner. Write down what you SAW, not what must be true:

- **Banner clears** → the flag is transient, visible only until the sat-out entrant is first paired. Fix narrowly: suppress a Swiss sit-out from `unplaced` for the round it sits out.
- **Banner persists** → a standing false alarm on every odd Swiss stage. Re-wording alone would be a cover-up; prefer the `unplaced` fix here too.
- **Only if neither is workable**, add `"swiss"` to `ROSTER_DRIFT_INELIGIBLE_KINDS`. Last, because it silences the banner for a genuine mid-stage roster change — the case it exists for.

Replace the UNCONFIRMED paragraph in `_INDEX.md`'s "W3 item 6" section with what you observed.

- [ ] **Step 4: Write the failing test**

`stage-roster-drift.test.ts` has **zero** swiss cases — `grep -a swiss` across all three roster-drift test files returns nothing. Its green is not coverage here.

The file already imports what you need; use these, do not invent helper names: `seedOrg` and `GENERIC_CONFIG` from `./_seed`, `createCompetition` from `../competitions`, `createDivision` from `../divisions`, `createEntrants` / `patchEntrant` from `../entrants`, `startDivision` from `../schedule`, plus `createStages`, `generateStageFixtures`, `getStageRosterDrift`, `rebuildStageFixtures`, `decideFixture` and `appendEvent`.

```ts
it("an odd-entrant swiss stage does not report its own sit-out as roster drift", async () => {
  const { auth, orgId } = await seedOrg();
  const competitionId = await createCompetition(auth, orgId, /* … as the file's other cases do … */);
  const divisionId = await createDivision(auth, competitionId, GENERIC_CONFIG);
  await createEntrants(auth, divisionId, FIVE_ENTRANTS);   // ODD on purpose
  const [stage] = await createStages(auth, divisionId, [{ kind: "swiss", name: "Swiss", progression: null }]);
  await startDivision(auth, divisionId);
  await generateStageFixtures(auth, stage.id);

  const drift = await getStageRosterDrift(auth, divisionId);
  expect(drift[stage.id]?.unplaced ?? []).toEqual([]);
});
```

Copy the exact argument shapes off the knockout case already in the file rather than trusting the ellipses. **Five entrants, not four** — an even count produces no sit-out and the test passes against unfixed code. Drive the REAL generator: hand-building the row shape the product does not produce is how the bye suite stayed green while never once executing against a real bye.

- [ ] **Step 5: Run it and confirm it fails**

```bash
cd apps/web && pnpm vitest run src/server/usecases/__tests__/stage-roster-drift.test.ts \
  --reporter=json --outputFile=/tmp/w3-t1-1.json; \
  node -e 'const r=require("/tmp/w3-t1-1.json");console.log(r.numTotalTests,r.numPassedTests,r.numFailedTests)'
```

Expected: exactly one failure, total = old total + 1.

- [ ] **Step 6: Apply the fix chosen in Step 3**

- [ ] **Step 7: Re-run, then mutate**

Re-run Step 5: green, total unchanged. Then revert the fix locally and confirm the new test — **and only the new test** — reddens. If a pre-existing test also reddens, the fix changed behaviour beyond the sit-out; stop and reconsider.

- [ ] **Step 8: Re-drive the browser repro**

The unit test proves the computation, not that a person stops seeing the banner. Repeat Step 2, confirm with your eyes, screenshot the cleared state and confirm the two images DIFFER.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/server/usecases/__tests__/stage-roster-drift.test.ts <the file you fixed> \
        docs/superpowers/specs/2026-09-02-competition-desk-prompts/_INDEX.md
git commit -m "fix(desk): an odd-swiss sit-out is a design, not roster drift"
```

---

### Task 2: The rail component, with the three header controls

**Files:**
- Create: `apps/web/src/components/v2/desk/stage-rail.tsx`
- Create: `apps/web/src/components/v2/desk/__tests__/stage-rail.test.tsx`
- Modify: `apps/web/src/components/v2/stages-panel.tsx` (header controls ~923-1016; the stage `map` ~887-889)

**Interfaces:**
- Consumes: nothing.
- Produces:

```ts
export interface StageRailProps {
  stage: StageRow;
  canEdit: boolean;
  busy: string | null;
  fixtureCount: number;
  deletable: boolean;
  onAct: (stageId: string, action: "generate" | "complete" | "delete") => void;
  onDelete: (stage: { id: string; name: string }) => void;
}
```

- [ ] **Step 1: Write the failing test**

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StageRail } from "../stage-rail";

const stage = { id: "s1", name: "League", kind: "league", seq: 1, status: "active" } as never;

describe("StageRail", () => {
  it("renders the three header controls with their testids", () => {
    const html = renderToStaticMarkup(
      <StageRail stage={stage} canEdit busy={null} fixtureCount={4} deletable
        onAct={() => {}} onDelete={() => {}} />,
    );
    expect(html).toContain('data-testid="stage-generate"');
    expect(html).toContain('data-testid="stage-complete"');
    expect(html).toContain('data-testid="stage-delete"');
  });

  it("renders nothing at all when the viewer cannot edit", () => {
    const html = renderToStaticMarkup(
      <StageRail stage={stage} canEdit={false} busy={null} fixtureCount={4} deletable
        onAct={() => {}} onDelete={() => {}} />,
    );
    expect(html).toBe("");
  });
});
```

**These three testids do not exist yet — this task adds them.** Verified: the only testids in the stage-chrome region are `stage-auto-schedule`, `stage-auto-schedule-blocked`, `stage-unscheduled-count`, `roster-drift-banner`, `roster-drift-rebuild`. Nothing locates Generate/Complete/Delete today, so adding these breaks nothing, and task 5's e2e gate needs them.

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd apps/web && pnpm vitest run src/components/v2/desk/__tests__/stage-rail.test.tsx \
  --reporter=json --outputFile=/tmp/w3-t2-1.json; \
  node -e 'const r=require("/tmp/w3-t2-1.json");console.log(r.numTotalTests,r.numPassedTests,r.numFailedTests)'
```

Expected: fails to resolve `../stage-rail`. A *collection* failure reports as zero tests, not as a failed one — read the numbers, not the word FAIL.

- [ ] **Step 3: Create the component**

Move the JSX for Generate/Pair next, Complete stage and Delete stage verbatim into `stage-rail.tsx`. Change only what must change: `act(stage.id, "generate")` → `onAct(stage.id, "generate")`; the delete confirm → `onDelete({ id: stage.id, name: stage.name })`, so `confirmDialog` stays in the panel. Keep every className byte-identical. Return `null` when `!canEdit`. Add `"use client"`.

- [ ] **Step 4: Wire it into the panel**

In the stage `map`, replace the three header buttons with `<StageRail … />` inside the existing `<header className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-4 py-3">`. Leave the header element alone — the layout move is task 5.

- [ ] **Step 5: Run the rail test and the panel suites**

```bash
cd apps/web && pnpm vitest run src/components/v2/desk/__tests__/stage-rail.test.tsx \
  src/components/v2/__tests__/stages-panel-delete.test.tsx \
  src/components/v2/__tests__/stages-panel-generate-precondition.test.tsx \
  src/components/v2/__tests__/stages-panel-phase.test.tsx \
  --reporter=json --outputFile=/tmp/w3-t2-2.json; \
  node -e 'const r=require("/tmp/w3-t2-2.json");console.log(r.numTotalTests,r.numPassedTests,r.numFailedTests)'
```

Expected: all pass, total = the four files' sum. A *drop* means a suite stopped collecting, which reads as green if you only check failures.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/v2/desk/stage-rail.tsx \
        apps/web/src/components/v2/desk/__tests__/stage-rail.test.tsx \
        apps/web/src/components/v2/stages-panel.tsx
git commit -m "feat(desk): the stage rail takes the three header controls"
```

---

### Task 3: Add match and the court-tags editor move to the rail

**Files:**
- Modify: `apps/web/src/components/v2/desk/stage-rail.tsx`
- Modify: `apps/web/src/components/v2/stages-panel.tsx` (Add match button ~977-986, form mount ~1064-1076, court tags mount ~1146-1151)
- Modify: `apps/web/src/components/v2/desk/__tests__/stage-rail.test.tsx`

**Interfaces:**
- Consumes: `StageRailProps` from task 2.
- Produces: `StageRailProps` extended with

```ts
  addingTo: string | null;
  onToggleAddMatch: (stageId: string) => void;
  adhoc: boolean;
  courtTagsSlot: React.ReactNode;
```

`courtTagsSlot` is a **slot, not a component reference**: `StageCourtTagsEditor` stays mounted by the panel and is passed down as an element, so the rail keeps owning no data.

- [ ] **Step 1: Extend the test first**

Two cases: (1) the Add match control renders for an ad-hoc stage kind and is absent for a kind not in `ADHOC_STAGE_KINDS`; (2) `courtTagsSlot` content renders where given — pass `courtTagsSlot={<i data-testid="ct-slot" />}` and assert `html` contains it.

- [ ] **Step 2: Run and confirm the two new cases fail**

```bash
cd apps/web && pnpm vitest run src/components/v2/desk/__tests__/stage-rail.test.tsx \
  --reporter=json --outputFile=/tmp/w3-t3-1.json; \
  node -e 'const r=require("/tmp/w3-t3-1.json");console.log(r.numTotalTests,r.numPassedTests,r.numFailedTests)'
```

Expected: `numFailedTests` 2, `numTotalTests` 4.

- [ ] **Step 3: Move the two controls**

Add match: the button moves; `setAddingTo(...)` → `onToggleAddMatch(stage.id)`. `AddMatchForm` itself does **not** move — it stays mounted in the panel because it reads `boardSlotOptions`, which also feeds `<RunSheet>`. Moving the trigger without the form is deliberate; leave a comment saying so, or the next reader will "finish" the job.

Court tags: pass `<StageCourtTagsEditor stageId={stage.id} canEdit={canEdit} suggestions={courtTagSuggestions} msg={msg} />` from the panel as `courtTagsSlot`.

- [ ] **Step 4: Run the rail test plus every suite that renders StagesPanel**

```bash
cd apps/web && pnpm vitest run src/components/v2/desk/__tests__ src/components/v2/__tests__ \
  --reporter=json --outputFile=/tmp/w3-t3-2.json; \
  node -e 'const r=require("/tmp/w3-t3-2.json");console.log(r.numTotalTests,r.numPassedTests,r.numFailedTests)'
```

Expected: zero failures AND a total no lower than the baseline. Record that baseline before the task by running the same command on the previous commit.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/v2/desk/stage-rail.tsx \
        apps/web/src/components/v2/desk/__tests__/stage-rail.test.tsx \
        apps/web/src/components/v2/stages-panel.tsx
git commit -m "feat(desk): add match and court tags move to the rail"
```

---

### Task 4: The auto-schedule CTA, under the capacity constraint

**Files:**
- Modify: `apps/web/src/components/v2/desk/stage-rail.tsx`
- Modify: `apps/web/src/components/v2/stages-panel.tsx` (~1078-1130, button ~1099-1108)
- Modify: `apps/web/src/components/v2/desk/__tests__/stage-rail.test.tsx`
- Read first, do not modify: the comment above `useCapacityReportsByStage`, and the hook's own header

**Interfaces:**
- Consumes: everything above.
- Produces: `StageRailProps` extended with

```ts
  unscheduledCount: number;
  capacityBlocked: { blocked: boolean; reason: string | null } | null;
  onAutoSchedule: (stageId: string) => void;
```

**The task most likely to go wrong.** The hook stays in the panel; the rail gets a plain, already-computed verdict. If you find yourself importing `useCapacityReportsByStage` into `stage-rail.tsx`, stop — that is the shape the in-code comment says broke tests before.

- [ ] **Step 1: Read the constraint before writing anything**

Open the comment above the `useCapacityReportsByStage` call and the hook's header. Write one sentence in your notes stating what broke last time. If you cannot state it, you are not ready for this task.

- [ ] **Step 2: Write the failing test, including the blocked case**

The CTA renders its blocked reason when `capacityBlocked={{ blocked: true, reason: "No courts on Saturday" }}`, and renders enabled with no reason text when `{ blocked: false, reason: null }`. Assert the reason STRING is present in one and ABSENT in the other — a test that only checks the button exists passes in both states and witnesses nothing.

`stage-auto-schedule`, `stage-auto-schedule-blocked` and `stage-unscheduled-count` **already exist** and must survive the move byte-identical. Existing tests locate them.

- [ ] **Step 3: Run and confirm failure**

```bash
cd apps/web && pnpm vitest run src/components/v2/desk/__tests__/stage-rail.test.tsx \
  --reporter=json --outputFile=/tmp/w3-t4-1.json; \
  node -e 'const r=require("/tmp/w3-t4-1.json");console.log(r.numTotalTests,r.numPassedTests,r.numFailedTests)'
```

- [ ] **Step 4: Move the CTA, keep the subscription**

`const capacityByStage = useCapacityReportsByStage(divisionId, capacityRequestByStage);` stays exactly where it is. Compute the per-stage verdict in the panel's own render and pass the result down.

- [ ] **Step 5: Run the capacity suite — this is the gate**

```bash
cd apps/web && pnpm vitest run src/components/v2/__tests__/stages-panel-capacity.test.tsx \
  src/components/v2/__tests__/stages-panel-auto-schedule-seq.test.tsx \
  --reporter=json --outputFile=/tmp/w3-t4-2.json; \
  node -e 'const r=require("/tmp/w3-t4-2.json");console.log(r.numTotalTests,r.numPassedTests,r.numFailedTests)'
```

Expected: pass, total unchanged. If either reddens, the extraction violated the constraint — revert the CTA move and pass the whole button through as a slot, as task 3 does for court tags.

- [ ] **Step 6: Mutate, to prove the blocked test is real**

Temporarily make the rail always render the CTA enabled, ignoring `capacityBlocked`. Re-run Step 3. Expected: exactly one test reddens. If none does, the assertion is decoration — fix it before restoring.

- [ ] **Step 7: Restore and commit**

```bash
git add apps/web/src/components/v2/desk/stage-rail.tsx \
        apps/web/src/components/v2/desk/__tests__/stage-rail.test.tsx \
        apps/web/src/components/v2/stages-panel.tsx
git commit -m "feat(desk): the auto-schedule CTA moves to the rail, capacity subscription stays put"
```

---

### Task 5: The two-column layout, desktop only

**Files:**
- Modify: `apps/web/src/components/v2/stages-panel.tsx` (the stage `map` wrapper, `<section className="card overflow-hidden">`)
- Modify: `apps/web/e2e/run-sheet.spec.ts`

- [ ] **Step 1: Write the failing e2e**

At 1280, assert the rail and the sheet sit side by side — `boundingBox()` on both, rail `x` greater than sheet `x + width - 1`. Then assert the sheet subtree contains **none** of the six stage-chrome testids. That second assertion is what encodes ruling 11; geometry alone passes on a stacked layout with the rail merely last.

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd apps/web && pnpm playwright test e2e/run-sheet.spec.ts --project=parallel
```

- [ ] **Step 3: Add the grid**

Wrap the per-stage body in `lg:grid lg:grid-cols-[1fr_280px] lg:gap-6`, rail second. Below `lg` it stacks, unstyled. **No phone styling in this task** — that is task 10.

- [ ] **Step 4: Run the whole spec files**

```bash
cd apps/web && pnpm playwright test e2e/run-sheet.spec.ts e2e/run-sheet-dates-and-court.spec.ts --project=parallel
```

Never `-g` a subset: a filter that matched neither broken test is how six green local gates missed two CI reds on the phone-composition wave.

- [ ] **Step 5: Seven-width gate**

```bash
cd apps/web && pnpm playwright test e2e/mobile.spec.ts \
  --project=mobile-320 --project=mobile-360 --project=mobile-se \
  --project=mobile-14 --project=mobile-430 --project=tablet-768 --project=tablet-834
```

Whole file. Serial mode means any failure count is a floor.

- [ ] **Step 6: Screenshot at 1280, 768, 320**

Capture a stage that actually has unscheduled fixtures. Print the row text beside each capture and confirm it reads the intended state — a width gate cannot tell you it measured the wrong page state, and a probe on this exact surface once passed all three widths against a page whose setup calls had silently failed. Confirm the images exist and DIFFER.

- [ ] **Step 7: Typecheck, lint, commit**

```bash
pnpm typecheck
```

`rtk` hides lint output — "ESLint output (JSON parse failed)" is the wrapper losing the result, not a clean run. Use `rtk proxy` and read `✖ N problems`.

```bash
git add apps/web/src/components/v2/stages-panel.tsx apps/web/e2e/run-sheet.spec.ts
git commit -m "feat(desk): the fixtures tab becomes sheet plus rail at lg"
```

---

### Task 6: The band's producer — one shape, two doors

**Files:**
- Modify: `apps/web/src/server/usecases/competition-desk.ts` (types ~35-72; the fixture query ~226-270)
- Create: `apps/web/src/app/api/v1/competitions/[id]/desk/route.ts`
- Modify: `apps/web/src/server/api-v1/schemas.ts`
- Modify: `apps/web/src/server/api-v1/openapi.ts` (the `ROUTES` array)
- Test: `apps/web/src/server/usecases/__tests__/competition-desk.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces, for task 7:

```ts
export interface DeskInPlayFixture {
  id: string;
  division_id: string;
  division_name: string;
  home: string | null;
  away: string | null;
  fixture_no: number;
  event_count: number;
  started_at: string | null;
}

export interface CompetitionDesk {
  in_play: number;
  in_play_fixtures: DeskInPlayFixture[];  // NEW — ordered by started_at ascending, nulls last
  up_next: DeskNextFixture | null;        // NEW — the soonest `next` across divisions
  divisions: Map<string, DeskDivision>;
  now: string;
}
```

**The data is already fetched.** The existing query already selects `f.id, f.division_id, f.status, f.scheduled_at, f.fixture_no, f.stage_id, h.display_name as home, a.display_name as away, coalesce(e.n,0)::int as event_count, e.started_at`. This task exposes it on the type; it should need no new query. Confirm by reading the query before writing SQL.

- [ ] **Step 1: Write the failing usecase test**

```ts
it("carries every in-play fixture, ordered by kickoff, with its event count", async () => {
  const desk = await getCompetitionDesk(auth, competitionId);
  expect(desk.in_play_fixtures.map((f) => f.fixture_no)).toEqual([1, 2]);
  expect(desk.in_play_fixtures[0]?.event_count).toBe(0);
  expect(desk.in_play).toBe(desk.in_play_fixtures.length);
});
```

The last assertion matters most: it pins the new list against the scalar the pill already renders, so the two cannot drift into two authorities for one fact.

Seed at least **two** in-play fixtures with **different** event counts — one at zero (the "NO SCORE" case), one above. A single sample cannot witness an ordering or per-row mapping bug.

- [ ] **Step 2: Run and confirm failure**

```bash
cd apps/web && pnpm vitest run src/server/usecases/__tests__/competition-desk.test.ts \
  --reporter=json --outputFile=/tmp/w3-t6-1.json; \
  node -e 'const r=require("/tmp/w3-t6-1.json");console.log(r.numTotalTests,r.numPassedTests,r.numFailedTests)'
```

- [ ] **Step 3: Extend the usecase**

Add the two fields, derived from rows already in hand. `up_next` is the soonest `next` across divisions. No second query for either.

- [ ] **Step 4: Add the Zod schema**

`S.CompetitionDesk` in `schemas.ts`, mirroring the interface. `S.Fixture` already declares the status enum `["scheduled","in_play","decided","finalized","abandoned","forfeited","cancelled"]` — reuse it rather than retyping the members.

- [ ] **Step 5: Add the route**

`apps/web/src/app/api/v1/competitions/[id]/desk/route.ts`, following `app/api/v1/fixtures/[id]/route.ts`:

```ts
export const GET = v1(async (req, { params }) => {
  const { id } = await params;
  const auth = await requireResourceAuth(req, { competitionId: id }, "read");
  return getCompetitionDesk(auth, id);
});
```

Return the usecase value bare — `v1()` supplies the `{ ok, data, requestId }` envelope and maps `HttpError` to its status (403 → `FORBIDDEN`, 404 → `NOT_FOUND`), `ZodError` → 400, `AuthError` → 401. Read `server/api-v1/auth.ts` and copy the helper an existing competition-scoped GET uses; do not guess `requireResourceAuth`'s argument shape.

- [ ] **Step 6: Add the OpenAPI row**

```ts
{ path: "/competitions/{id}/desk", method: "get", summary: "Get a competition desk summary", tag: "competitions", response: S.CompetitionDesk },
```

Then `pnpm openapi:gen`. A coverage test asserts `ROUTES` matches route files 1:1, so a missing row is CI-red rather than a silent gap.

- [ ] **Step 7: Run the suites and typecheck**

```bash
cd apps/web && pnpm vitest run src/server/usecases/__tests__/competition-desk.test.ts \
  src/server/api-v1/__tests__ \
  --reporter=json --outputFile=/tmp/w3-t6-2.json; \
  node -e 'const r=require("/tmp/w3-t6-2.json");console.log(r.numTotalTests,r.numPassedTests,r.numFailedTests)'
cd ../.. && pnpm typecheck
```

`openapi-coverage.test.ts` catches a missing `ROUTES` row. A local `pnpm build` does **not** typecheck — run `pnpm typecheck` as its own gate.

- [ ] **Step 8: Smoke the endpoint**

Add a smoke case: the endpoint 200s and validates against `S.CompetitionDesk`. Assert the envelope is `{ ok: true, data: … }`, not a bare body.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/server/usecases/competition-desk.ts \
        apps/web/src/server/usecases/__tests__/competition-desk.test.ts \
        apps/web/src/server/api-v1/schemas.ts apps/web/src/server/api-v1/openapi.ts \
        apps/web/src/app/api/v1/competitions/ openapi/
git commit -m "feat(desk): the in-play fixture list gets one producer and one door"
```

---

### Task 7: The in-play band

**Files:**
- Create: `apps/web/src/components/v2/desk/in-play-band.tsx`
- Create: `apps/web/src/components/v2/desk/__tests__/in-play-band.test.tsx`
- Modify: `apps/web/src/app/o/[orgSlug]/c/[compSlug]/page.tsx` (between the masthead row's closing `</div>` ~398 and `<NeedsYou dict={dict} items={needs} />` ~400)
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`

**Interfaces:**
- Consumes: `DeskInPlayFixture`, `in_play_fixtures`, `up_next` from task 6.
- Produces:

```ts
export function InPlayBand(props: {
  competitionId: string;
  initial: { inPlay: DeskInPlayFixture[]; upNext: DeskNextFixture | null };
  dict: Dict;
}): React.ReactElement | null;
```

- [ ] **Step 1: Write the failing unit test — the guard first**

```tsx
it("renders nothing when no fixture is in play", () => {
  const html = renderToStaticMarkup(
    <InPlayBand competitionId="c1" initial={{ inPlay: [], upNext: null }} dict={dict} />,
  );
  expect(html).toBe("");
});

it("prints NO SCORE for an in-play fixture with an empty ledger, and the score otherwise", () => {
  const html = renderToStaticMarkup(
    <InPlayBand competitionId="c1"
      initial={{ inPlay: [fixtureWithZeroEvents, fixtureWithEvents], upNext: null }} dict={dict} />,
  );
  expect(html).toContain(dict.desk.band.noScore);
  expect(html.split(dict.desk.band.noScore).length - 1).toBe(1);  // exactly once
});
```

The "exactly once" count is the point. An assertion that `NO SCORE` merely appears passes on a band that prints it for every card.

- [ ] **Step 2: Run and confirm failure**

```bash
cd apps/web && pnpm vitest run src/components/v2/desk/__tests__/in-play-band.test.tsx \
  --reporter=json --outputFile=/tmp/w3-t7-1.json; \
  node -e 'const r=require("/tmp/w3-t7-1.json");console.log(r.numTotalTests,r.numPassedTests,r.numFailedTests)'
```

- [ ] **Step 3: Add the four dictionaries**

`desk.band.noScore`, `desk.band.upNext`, and an accessible name for the band region. All four locales, no hardcoded English. Then `pnpm i18n:gen-keys && pnpm i18n:check`.

- [ ] **Step 4: Build the component**

`"use client"`. Night ground; numerals styled with the existing `--sport-led` token (`app/globals.css`, `var(--color-lime-400, #9ae600)`). **No LED-numeral component exists** — a grep for seven-segment/LED-digit primitives is empty. Build the numerals fresh with the token; do not hunt for one to reuse.

One card per in-play fixture across divisions, plus one dashed "Up next". `"NO SCORE"` in red when `event_count === 0`. Return `null` when the list is empty — no empty state.

If the band scrolls horizontally on a phone it owes `tabindex="0"` plus a role and an accessible name, or axe reds at SERIOUS on `scrollable-region-focusable`. `tabindex` cannot be varied by media query, so it is unconditional.

- [ ] **Step 5: Poll, on the established pattern**

No query library here. Copy the shape of `components/v2/board/run-elapsed.tsx`:

```ts
useEffect(() => {
  if (!live) return;
  const id = setInterval(() => { void refresh(); }, 20_000);
  return () => clearInterval(id);
}, [live]);
```

`live` is true while the competition pill says in play — so the interval is **cleared**, not merely skipped, when play stops. `refresh()` fetches `/api/v1/competitions/{id}/desk` and reads `json.data`.

- [ ] **Step 6: Mount it**

`page.tsx` is an async server component; the desk comes from `await getCompetitionDesk(auth, id).catch(...)` and can be `null`. Insert between the masthead row's closing `</div>` and `<NeedsYou … />`. Pass `initial` from the already-awaited desk so the band paints on first load. Render nothing when `desk === null`.

- [ ] **Step 7: Run the unit test, then MUTATE the guard**

```bash
cd apps/web && pnpm vitest run src/components/v2/desk/__tests__/in-play-band.test.tsx \
  --reporter=json --outputFile=/tmp/w3-t7-2.json; \
  node -e 'const r=require("/tmp/w3-t7-2.json");console.log(r.numTotalTests,r.numPassedTests,r.numFailedTests)'
```

Then delete the `inPlay.length > 0` guard and re-run. Expected: **exactly one** test reddens. If none does, the guard is untested.

- [ ] **Step 8: Write the e2e — with a REAL ledger event**

```ts
await seedRosteredFixture(request, { divisionId, /* … */ emitCoreStart: true });
await page.goto(compUrl);
await expect(page.getByTestId("desk-in-play-band")).toBeVisible();
await expect(page.getByTestId("desk-in-play-band")).toContainText("NO SCORE");
```

**Do not reach for `setFixtureStatusSql`.** It sets the column with no engine event, and `in_play` is derived from `has("core.start")` — the band would render over a fixture that never started and the test would prove nothing.

Then decide the fixture and assert the band disappears. Verify the poll with `page.clock`, never a sleep.

- [ ] **Step 9: Regression — the band is absent off match day**

On a competition with no in-play fixture, the band's testid resolves to **zero** elements. Pair it with the positive case in the same file so the negative cannot pass vacuously against a page that failed to load — a zero-resolving locator satisfies "absent" for the wrong reason.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/components/v2/desk/in-play-band.tsx \
        apps/web/src/components/v2/desk/__tests__/in-play-band.test.tsx \
        apps/web/src/app/o/\[orgSlug\]/c/\[compSlug\]/page.tsx \
        apps/web/src/dictionaries apps/web/src/lib/i18n-keys.ts apps/web/e2e/
git commit -m "feat(desk): the competition page gets a live in-play band"
```

---

### Task 8: Unify the phone breakpoint on `md:`

**Files:**
- Modify: `apps/web/src/components/v2/desk/run-sheet-row.tsx` (row wrapper, action cell, the `sm:contents` hits)
- Modify: `apps/web/src/app/o/[orgSlug]/c/[compSlug]/page.tsx` (the six `max-sm:*` / `sm:hidden` tool classes)
- Modify: `apps/web/src/components/v2/desk/desk-tools-more.tsx` (`sm:hidden`)

**Interfaces:** none — class changes only.

**Ruling 15.** The ledger switches at `md:` (768), the masthead and run-sheet row at `sm:` (640). At 768 the ledger is a card while the run sheet is already a desktop row.

- [ ] **Step 1: Enumerate before editing**

```bash
cd apps/web && grep -an "sm:" src/components/v2/desk/run-sheet-row.tsx \
  src/components/v2/desk/desk-tools-more.tsx \
  "src/app/o/[orgSlug]/c/[compSlug]/page.tsx"
```

Write the list into your notes. `\bmd:hidden\b` also matches inside `max-md:hidden` — opposites. Read each hit; do not pattern-replace.

- [ ] **Step 2: Write the failing e2e**

At **768** the run-sheet row is ONE line — the time cell and action cell share a `boundingBox().y` within a few pixels. That already passes today. So **also** assert at **700**, via explicit `setViewportSize({ width: 700, height: 900 })`, that the row is STACKED. That second assertion is the one that fails before the change, and no project covers it.

- [ ] **Step 3: Run it and confirm the 700 case fails**

```bash
cd apps/web && pnpm playwright test e2e/run-sheet.spec.ts --project=parallel
```

- [ ] **Step 4: Rewrite the classes**

`sm:` → `md:` and `max-sm:` → `max-md:` on the enumerated hits only. Do not touch `sm:` classes belonging to unrelated components in the same files.

- [ ] **Step 5: Whole spec files, then seven widths**

```bash
cd apps/web && pnpm playwright test e2e/run-sheet.spec.ts e2e/run-sheet-dates-and-court.spec.ts \
  e2e/competition-desk.spec.ts --project=parallel
cd apps/web && pnpm playwright test e2e/mobile.spec.ts \
  --project=mobile-320 --project=mobile-360 --project=mobile-se \
  --project=mobile-14 --project=mobile-430 --project=tablet-768 --project=tablet-834
```

- [ ] **Step 6: Check 640-767 by hand**

Screenshot the fixtures tab and the competition page at 700. No project covers this band.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/v2/desk/run-sheet-row.tsx \
        apps/web/src/components/v2/desk/desk-tools-more.tsx \
        apps/web/src/app/o/\[orgSlug\]/c/\[compSlug\]/page.tsx apps/web/e2e/run-sheet.spec.ts
git commit -m "fix(desk): one phone breakpoint for the whole desk, md not sm"
```

---

### Task 9: Two-line run-sheet rows

**Files:**
- Modify: `apps/web/src/components/v2/desk/run-sheet-row.tsx`
- Test: `apps/web/e2e/run-sheet.spec.ts`

**Interfaces:** none — composition only.

**Today's phone row is three reflowed lines**, action as a ~100px pill on its own line; the sheet runs 3,805px (6.7 screens) at 320 against 2,271px at 1280. A3 makes it two deliberate lines: line 1 = time + entrants; line 2 = court/round sub-line + the one action, right-aligned.

Current cells:

| Cell | className |
| --- | --- |
| Time (editable) | `-my-1 flex min-h-11 w-14 shrink-0 items-center font-mono text-sm tabular-nums text-slate-600 underline decoration-slate-300 decoration-dotted underline-offset-4 hover:text-purple-700 hover:decoration-purple-500`, `data-testid="run-sheet-edit-time"` |
| Time (read-only) | `w-14 shrink-0 font-mono text-sm tabular-nums text-slate-600` |
| Entrant block | `min-w-0 flex-1`; sub-line `min-w-0 truncate text-xs text-slate-500`; name link `block min-w-0 truncate text-sm font-medium …` |
| Action | wrapper `flex flex-wrap items-center gap-2 sm:contents` (→ `md:contents` after task 8); button `btn btn-primary min-h-11 shrink-0 px-3 text-xs`, `data-row-action` |

- [ ] **Step 1: Capture the baseline control set**

At 320 and 1280, dump the visible control set from the live DOM — membership, order, repeats — and `diff` them. Record that today they are identical. This is the measurement the task has to move.

- [ ] **Step 2: Write the failing assertion**

At 320 the row occupies exactly TWO text lines: take `boundingBox().height` and assert it is below a two-line ceiling **derived from the row's own computed `line-height` and padding** — not a hardcoded pixel constant, which goes stale the moment the type scale moves. Also assert the action's box shares a visual line with the sub-line (compare `y` centres).

- [ ] **Step 3: Run and confirm it fails**

```bash
cd apps/web && pnpm playwright test e2e/run-sheet.spec.ts --project=mobile-320
```

- [ ] **Step 4: Recompose**

Two rows in the phone stack, not three. `truncate` needs `min-w-0` on the **whole ancestor chain**, not just the span — a missing one put 106px of horizontal overflow on the page at 320-390 on the scorepad wave, visible only with a realistic 43-character entrant name and only in a browser. Test with a 43-character name.

- [ ] **Step 5: Re-measure the control set — the acceptance criterion**

Re-run Step 1's dump. The sets at 320 and 1280 must now **DIFFER**. If `diff` is still empty, the row is a shrink and the task is not done, whatever the screenshots look like.

- [ ] **Step 6: Hit-test, do not measure**

For each control, take its centre and confirm `document.elementFromPoint` resolves to it or a child. `boundingBox()` reports paint: a control can measure 44px and still be untappable under an overlay. The cookie banner intercepts phone clicks on a fresh context.

- [ ] **Step 7: Whole-file gates**

```bash
cd apps/web && pnpm playwright test e2e/run-sheet.spec.ts e2e/run-sheet-dates-and-court.spec.ts --project=parallel
cd apps/web && pnpm playwright test e2e/mobile.spec.ts \
  --project=mobile-320 --project=mobile-360 --project=mobile-se \
  --project=mobile-14 --project=mobile-430 --project=tablet-768 --project=tablet-834
```

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/v2/desk/run-sheet-row.tsx apps/web/e2e/run-sheet.spec.ts
git commit -m "feat(desk): the phone run-sheet row becomes two deliberate lines"
```

---

### Task 10: The rail folds into a bottom sheet

**Requires tasks 2-5 in the branch.**

**Files:**
- Modify: `apps/web/src/components/v2/desk/stage-rail.tsx`
- Modify: `apps/web/src/components/v2/stages-panel.tsx` (the `lg:` grid from task 5)
- Test: `apps/web/e2e/run-sheet.spec.ts`, `apps/web/e2e/mobile.spec.ts`

**Interfaces:**
- Consumes: `StageRailProps` from tasks 2-4.
- Produces: no new exports. The trigger is a floating "Stage tools" button below `md:`.

**Precedent to reuse, not reinvent:** `apps/web/src/components/modal.tsx` already implements bottom-sheet-under-`sm` — `flex max-h-[85dvh] w-full … flex-col rounded-t-2xl … pb-[calc(1.5rem+env(safe-area-inset-bottom))] sm:rounded-2xl sm:pb-6`, with `<span className="sheet-handle" aria-hidden />`. Crib the pattern; move its breakpoint to `md:` per ruling 15.

- [ ] **Step 1: Write the failing e2e**

At 320: the rail's controls are NOT visible; a "Stage tools" trigger IS; tapping it opens the sheet and every rail control becomes visible. At 1280: the trigger is absent and the rail controls are visible with no tap.

Wait on **`toBeAttached`**, not `toBeVisible`, for the folded controls before opening — visibility is exactly what the fold denies. Gate the open on the **trigger being visible**, not on a width literal: clicking a hidden control throws.

- [ ] **Step 2: Run and confirm failure**

```bash
cd apps/web && pnpm playwright test e2e/run-sheet.spec.ts --project=mobile-320 --project=parallel
```

- [ ] **Step 3: Grep the suite for the rail's testids first**

```bash
cd apps/web && grep -an "stage-generate\|stage-complete\|stage-delete\|stage-auto-schedule\|stage-unscheduled-count" e2e/ src/
```

`stage-auto-schedule`, `stage-auto-schedule-blocked` and `stage-unscheduled-count` pre-date this programme and have existing callers; `stage-generate` / `stage-complete` / `stage-delete` were added by task 2, so their only callers are this branch's tests. Folding a control breaks every test that asserts it VISIBLE, and **no unit test can see it**. Make those tests OPEN the fold. Do not weaken their assertions to match the new markup.

- [ ] **Step 4: Build the fold**

Below `md:` the rail renders inside the sheet; the floating trigger is `md:hidden`. **`/\bmd:hidden\b/` also matches inside `max-md:hidden`** — anchor assertions on `\s...hidden"`, or they pass on their own inversion.

If the panel mounts one rail per stage, opening the first leaves the others' controls boxless and `boundingBox()` returns null. Open EVERY instance the test touches.

- [ ] **Step 5: Whole-file gates**

```bash
cd apps/web && pnpm playwright test e2e/run-sheet.spec.ts e2e/mobile.spec.ts \
  --project=mobile-320 --project=mobile-360 --project=mobile-se \
  --project=mobile-14 --project=mobile-430 --project=tablet-768 --project=tablet-834
```

- [ ] **Step 6: Control-set diff, again**

The fixtures tab's control set at 320 must differ from 1280 — the second half of the criterion task 9 opened.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/v2/desk/stage-rail.tsx apps/web/src/components/v2/stages-panel.tsx apps/web/e2e/
git commit -m "feat(desk): the stage rail becomes a bottom sheet on phones"
```

---

## Final gate — the whole wave

- [ ] `cd apps/web && pnpm vitest run --reporter=json --outputFile=/tmp/w3-final.json`, and confirm `.testResults[].name` paths resolve inside **this worktree**. Shell cwd can reset to the main checkout between calls: a verify run launched from a worktree can silently execute on `main` and return a false green.
- [ ] `pnpm typecheck` as its own gate — a local build does not typecheck, and vitest can be structurally blind (`tsconfig.scripts.json` excludes tests).
- [ ] `pnpm lint` via `rtk proxy`, reading `✖ N problems`.
- [ ] Whole `mobile.spec.ts` at all seven widths, green in one uninterrupted run.
- [ ] `pnpm i18n:check` — four locales at parity.
- [ ] Screenshots at 1280 / 768 / 320 for the competition page and the fixtures tab in all four phases. Confirm the images EXIST and DIFFER, and print the asserted content beside each so a capture of the wrong state cannot pass.
- [ ] **Walkthrough**: drive the whole surface as an organiser on a match day. A green suite is not a working product — findings reachable from ~4,000 passing tests have included untranslated copy nothing renders and a page whose chunks were never emitted.
- [ ] Per-screen verdicts written into `_INDEX.md`. "CI green" / "no gaps" is not sign-off.
- [ ] Ruling 11 marked closed in `_INDEX.md`, with the "Compute proposal" false premise recorded beside it.
