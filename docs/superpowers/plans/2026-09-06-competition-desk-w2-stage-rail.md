# Competition Desk — W2 tail: the stage rail (PR A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move stage chrome off the fixtures sheet and onto a dedicated stage rail, desktop only, closing owner ruling 11 and current-state finding 6 ("actions in six places").

**Architecture:** A new presentational component `components/v2/desk/stage-rail.tsx` receives everything it renders as props and owns no data hooks. `StagesPanel` keeps every `useState` and every subscription it has today and passes callbacks down, mirroring the `AddStageForm` `onDone`/`onError`/`onPaywall` pattern already in the file. The panel's root gains an `lg:` two-column grid (`1fr 280px`); below `lg` the rail stacks under the sheet unstyled — the phone composition is W3's, not this PR's.

**Tech Stack:** Next.js (App Router), React client components, Tailwind, vitest (`environment: "node"`), Playwright.

**Spec:** `docs/superpowers/specs/2026-09-02-competition-desk-design.md` §W2 and §W3 (amendment 5); owner rulings 11 and 13 in `docs/superpowers/specs/2026-09-02-competition-desk-prompts/_INDEX.md`.

## Global Constraints

- **This PR is DESKTOP ONLY.** Owner rulings 6 and 7 hold. Do not add a single `max-md:`, `md:hidden` or bottom-sheet behaviour — that is W3's task T6. The rail may stack unstyled below `lg`. It must still pass the seven-width gate with no horizontal page scroll.
- **`capacityByStage` must not move.** `stages-panel.tsx:542-546` states it explicitly: the auto-schedule button "has to stay a DIRECT part of this component's own render output; see the hook's own header for why a per-stage child component broke pre-existing tests that locate it by testid". `useCapacityReportsByStage` stays called exactly once, in `StagesPanel`. The rail receives a per-stage verdict as a plain prop.
- **Every `data-testid` and `data-row-action` value moves verbatim.** Tests locate these controls by testid; renaming one is a silent red in a suite you did not run.
- **"Compute proposal" is not a control.** Ruling 11 lists seven; six exist. `propose()` is a private closure inside `autoScheduleStage` and shares the auto-schedule handler. Do not invent a button for it. This false premise is recorded in `_INDEX.md`; do not re-derive it.
- Package manager is **pnpm**. Run vitest as `cd apps/web && pnpm vitest run`, never via `--root`, and judge green only from `--reporter=json --outputFile` (`numPassedTests` / `numTotalTests`). `rtk` prints `PASS(0) FAIL(0)` for a suite that failed to collect.
- Every change ships a test that fails without it.
- Any new or changed user-facing string goes into all four dictionaries (`dictionaries/{en,es,fr,nl}/ui.json`) followed by `pnpm i18n:gen-keys`. This PR should need none — it moves existing controls.

---

### Task 1: The rail component, with the three header controls

**Files:**
- Create: `apps/web/src/components/v2/desk/stage-rail.tsx`
- Create: `apps/web/src/components/v2/desk/__tests__/stage-rail.test.tsx`
- Modify: `apps/web/src/components/v2/stages-panel.tsx` (header controls at 923-1016; the stage `map` at 887-889)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `StageRail`, and the props type later tasks extend.

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

`apps/web/src/components/v2/desk/__tests__/stage-rail.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StageRail } from "../stage-rail";

const stage = { id: "s1", name: "League", kind: "league", seq: 1, status: "active" } as never;

describe("StageRail", () => {
  it("renders the three header controls with their existing testids", () => {
    const html = renderToStaticMarkup(
      <StageRail
        stage={stage}
        canEdit
        busy={null}
        fixtureCount={4}
        deletable
        onAct={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(html).toContain('data-testid="stage-generate"');
    expect(html).toContain('data-testid="stage-complete"');
    expect(html).toContain('data-testid="stage-delete"');
  });

  it("renders nothing at all when the viewer cannot edit", () => {
    const html = renderToStaticMarkup(
      <StageRail
        stage={stage}
        canEdit={false}
        busy={null}
        fixtureCount={4}
        deletable
        onAct={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(html).toBe("");
  });
});
```

**These three testids do not exist yet — this task adds them.** Verified against the tree: the only testids in `stages-panel.tsx:923-1130` are `stage-auto-schedule`, `stage-auto-schedule-blocked`, `stage-unscheduled-count`, `roster-drift-banner` and `roster-drift-rebuild`. Generate, Complete and Delete carry none, so nothing locates them by testid today and adding `stage-generate` / `stage-complete` / `stage-delete` breaks no existing test. Task 4's e2e gate needs them to prove the sheet is empty of stage chrome.

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd apps/web && pnpm vitest run src/components/v2/desk/__tests__/stage-rail.test.tsx \
  --reporter=json --outputFile=/tmp/w2rail-1.json; \
  node -e 'const r=require("/tmp/w2rail-1.json");console.log(r.numTotalTests,r.numPassedTests,r.numFailedTests)'
```

Expected: fails to resolve `../stage-rail`. Confirm `numTotalTests` is 0 or the failure names the missing module — a *collection* failure reports as zero tests, not as a failed one, so read the numbers rather than the word FAIL.

- [ ] **Step 3: Create the component**

Move the JSX for Generate/Pair next (`stages-panel.tsx:932-976`), Complete stage (`:987-996`) and Delete stage (`:999-1016`) verbatim into `stage-rail.tsx`. Change only what has to change: `act(stage.id, "generate")` becomes `onAct(stage.id, "generate")`, and the delete confirm becomes `onDelete({ id: stage.id, name: stage.name })` so `confirmDialog` stays in the panel. Keep every className and every testid byte-identical. Return `null` when `!canEdit`.

Add `"use client"` at the top — the rail takes event handlers.

- [ ] **Step 4: Wire it into the panel**

In the stage `map` (`:887-889`), replace the three header buttons with `<StageRail … />` inside the existing `<header className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-4 py-3">`. Leave the header element itself alone in this task — the layout move is Task 4.

- [ ] **Step 5: Run the rail test and the panel suites**

```bash
cd apps/web && pnpm vitest run src/components/v2/desk/__tests__/stage-rail.test.tsx \
  src/components/v2/__tests__/stages-panel-delete.test.tsx \
  src/components/v2/__tests__/stages-panel-generate-precondition.test.tsx \
  src/components/v2/__tests__/stages-panel-phase.test.tsx \
  --reporter=json --outputFile=/tmp/w2rail-2.json; \
  node -e 'const r=require("/tmp/w2rail-2.json");console.log(r.numTotalTests,r.numPassedTests,r.numFailedTests)'
```

Expected: all pass, and `numTotalTests` is the sum of the four files' counts — a *drop* in the total means a suite stopped collecting, which reads as green if you only check failures.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/v2/desk/stage-rail.tsx \
        apps/web/src/components/v2/desk/__tests__/stage-rail.test.tsx \
        apps/web/src/components/v2/stages-panel.tsx
git commit -m "feat(desk): the stage rail takes the three header controls"
```

---

### Task 2: Add match and the court-tags editor move to the rail

**Files:**
- Modify: `apps/web/src/components/v2/desk/stage-rail.tsx`
- Modify: `apps/web/src/components/v2/stages-panel.tsx` (Add match button `:977-986`, form mount `:1064-1076`, court tags mount `:1146-1151`)
- Modify: `apps/web/src/components/v2/desk/__tests__/stage-rail.test.tsx`

**Interfaces:**
- Consumes: `StageRailProps` from Task 1.
- Produces: `StageRailProps` extended with

```ts
  addingTo: string | null;
  onToggleAddMatch: (stageId: string) => void;
  adhoc: boolean;
  courtTagsSlot: React.ReactNode;
```

`courtTagsSlot` is a **slot, not a component reference**: `StageCourtTagsEditor` stays mounted by the panel and is passed down as an element, so the rail keeps owning no data.

- [ ] **Step 1: Extend the test first**

Add two cases to `stage-rail.test.tsx`: (1) the Add match control renders for an ad-hoc stage kind and is absent for a kind not in `ADHOC_STAGE_KINDS`; (2) `courtTagsSlot` content is rendered where given. Assert on the real testid and on a sentinel string passed through the slot, e.g. `courtTagsSlot={<i data-testid="ct-slot" />}` then `expect(html).toContain('data-testid="ct-slot"')`.

- [ ] **Step 2: Run and confirm the two new cases fail**

```bash
cd apps/web && pnpm vitest run src/components/v2/desk/__tests__/stage-rail.test.tsx \
  --reporter=json --outputFile=/tmp/w2rail-3.json; \
  node -e 'const r=require("/tmp/w2rail-3.json");console.log(r.numTotalTests,r.numPassedTests,r.numFailedTests)'
```

Expected: `numFailedTests` is 2, `numTotalTests` is 4.

- [ ] **Step 3: Move the two controls**

Add match: the button moves; `setAddingTo(...)` becomes `onToggleAddMatch(stage.id)`. `AddMatchForm` itself does NOT move — it stays mounted in the panel below the sheet, because it reads `boardSlotOptions`, which also feeds `<RunSheet>`. Moving the trigger without the form is deliberate; note it in a comment so the next reader does not "finish" the job.

Court tags: pass `<StageCourtTagsEditor stageId={stage.id} canEdit={canEdit} suggestions={courtTagSuggestions} msg={msg} />` from the panel as `courtTagsSlot`.

- [ ] **Step 4: Run the rail test plus every suite that renders StagesPanel**

```bash
cd apps/web && pnpm vitest run src/components/v2/desk/__tests__ src/components/v2/__tests__ \
  --reporter=json --outputFile=/tmp/w2rail-4.json; \
  node -e 'const r=require("/tmp/w2rail-4.json");console.log(r.numTotalTests,r.numPassedTests,r.numFailedTests)'
```

Expected: zero failures AND a total no lower than the baseline you record before this task. Record that baseline now if you have not: run the same command on `HEAD~2` and write the number into the commit body.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/v2/desk/stage-rail.tsx \
        apps/web/src/components/v2/desk/__tests__/stage-rail.test.tsx \
        apps/web/src/components/v2/stages-panel.tsx
git commit -m "feat(desk): add match and court tags move to the rail"
```

---

### Task 3: The auto-schedule CTA, under the capacity constraint

**Files:**
- Modify: `apps/web/src/components/v2/desk/stage-rail.tsx`
- Modify: `apps/web/src/components/v2/stages-panel.tsx` (`:1078-1130`, button `:1099-1108`)
- Modify: `apps/web/src/components/v2/desk/__tests__/stage-rail.test.tsx`
- Read first, do not modify: `stages-panel.tsx:542-546` and the header of `useCapacityReportsByStage`

**Interfaces:**
- Consumes: everything above.
- Produces: `StageRailProps` extended with

```ts
  unscheduledCount: number;
  capacityBlocked: { blocked: boolean; reason: string | null } | null;
  onAutoSchedule: (stageId: string) => void;
```

**This is the task most likely to go wrong.** The hook stays in the panel. The rail gets a plain, already-computed verdict. If you find yourself importing `useCapacityReportsByStage` into `stage-rail.tsx`, stop — that is the shape the in-code comment says broke tests before.

- [ ] **Step 1: Read the constraint before writing anything**

Open `stages-panel.tsx:536-547` and the header comment of `useCapacityReportsByStage`. Write one sentence in your task notes stating what broke last time. If you cannot state it, you are not ready to do this task.

- [ ] **Step 2: Write the failing test, including the blocked case**

Add to `stage-rail.test.tsx`: the CTA renders with its blocked reason when `capacityBlocked={{ blocked: true, reason: "No courts on Saturday" }}`, and renders enabled with no reason text when `capacityBlocked={{ blocked: false, reason: null }}`. Assert the reason STRING is present in the blocked case and ABSENT in the unblocked one — a test that only checks the button exists passes in both states and witnesses nothing.

These two testids **already exist** and must survive the move byte-identical: `stage-auto-schedule` and `stage-auto-schedule-blocked`. So does `stage-unscheduled-count` in the same block. Existing tests locate them.

- [ ] **Step 3: Run and confirm failure**

```bash
cd apps/web && pnpm vitest run src/components/v2/desk/__tests__/stage-rail.test.tsx \
  --reporter=json --outputFile=/tmp/w2rail-5.json; \
  node -e 'const r=require("/tmp/w2rail-5.json");console.log(r.numTotalTests,r.numPassedTests,r.numFailedTests)'
```

- [ ] **Step 4: Move the CTA, keep the subscription**

In the panel, keep `const capacityByStage = useCapacityReportsByStage(divisionId, capacityRequestByStage);` exactly where it is. Compute the per-stage verdict in the panel's own render (`capacityGateBlocks(capacityByStage.get(stage.id))` or whatever the current call is) and pass the result down.

- [ ] **Step 5: Run the capacity suite specifically — this is the gate**

```bash
cd apps/web && pnpm vitest run src/components/v2/__tests__/stages-panel-capacity.test.tsx \
  src/components/v2/__tests__/stages-panel-auto-schedule-seq.test.tsx \
  --reporter=json --outputFile=/tmp/w2rail-6.json; \
  node -e 'const r=require("/tmp/w2rail-6.json");console.log(r.numTotalTests,r.numPassedTests,r.numFailedTests)'
```

Expected: pass, with the total unchanged from before the task. If either reddens, the extraction violated the constraint — revert the CTA move and pass the whole button through as a slot instead, the way Task 2 handles court tags.

- [ ] **Step 6: Mutate, to prove the blocked test is real**

Temporarily change the rail so it always renders the CTA enabled and ignores `capacityBlocked`. Re-run Step 3's command. Expected: exactly one test reddens (the blocked case). If nothing reddens, the assertion is decoration — fix it before restoring.

- [ ] **Step 7: Restore the mutation and commit**

```bash
git add apps/web/src/components/v2/desk/stage-rail.tsx \
        apps/web/src/components/v2/desk/__tests__/stage-rail.test.tsx \
        apps/web/src/components/v2/stages-panel.tsx
git commit -m "feat(desk): the auto-schedule CTA moves to the rail, capacity subscription stays put"
```

---

### Task 4: The two-column layout, and the gates

**Files:**
- Modify: `apps/web/src/components/v2/stages-panel.tsx` (the stage `map` wrapper at `:887-889`, `<section className="card overflow-hidden">` at `:921-922`)
- Modify: `apps/web/e2e/run-sheet.spec.ts`

- [ ] **Step 1: Write the failing e2e assertion**

Add a case to `run-sheet.spec.ts` asserting that at 1280 the rail and the sheet sit side by side — measure `boundingBox()` on both and assert the rail's `x` exceeds the sheet's `x + width - 1`. Then assert the sheet contains **no** stage-chrome control: query the sheet subtree for the six testids and expect zero. That second assertion is what actually encodes ruling 11; the geometry alone would pass on a stacked layout with the rail merely last.

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd apps/web && pnpm playwright test e2e/run-sheet.spec.ts --project=parallel
```

Expected: the side-by-side assertion fails — there is no two-column layout yet.

- [ ] **Step 3: Add the grid**

Wrap the per-stage body in `lg:grid lg:grid-cols-[1fr_280px] lg:gap-6` and place the rail as the second child. Below `lg` it stacks; leave it unstyled there.

- [ ] **Step 4: Run the whole spec file, not a slice**

```bash
cd apps/web && pnpm playwright test e2e/run-sheet.spec.ts e2e/run-sheet-dates-and-court.spec.ts --project=parallel
```

Never use `-g` to select a subset here — a filter that matches neither of the tests your change breaks is how six green local gates missed two CI reds on the phone-composition wave.

- [ ] **Step 5: Seven-width gate**

```bash
cd apps/web && pnpm playwright test e2e/mobile.spec.ts \
  --project=mobile-320 --project=mobile-360 --project=mobile-se \
  --project=mobile-14 --project=mobile-430 --project=tablet-768 --project=tablet-834
```

Run the WHOLE file. `mobile.spec.ts` is `describe.configure({ mode: "serial" })`, so the first red aborts the rest — treat any failure count as a floor and re-run after each fix until a full pass completes.

- [ ] **Step 6: Screenshot at 1280, 768 and 320**

Capture the fixtures tab in a state that actually has a stage with unscheduled fixtures. Print the row text beside each capture and confirm it reads the state you intended — a width gate cannot tell you it measured the wrong page state, and a probe on this exact surface once passed all three widths against a page whose setup calls had silently failed. Confirm the three images exist and DIFFER.

- [ ] **Step 7: Typecheck, lint, commit**

```bash
pnpm typecheck
pnpm --filter web exec eslint src/components/v2/desk/stage-rail.tsx src/components/v2/stages-panel.tsx
```

`rtk` hides lint output — if you see "ESLint output (JSON parse failed)", that is the wrapper losing the result, not a clean run. Use `rtk proxy` and read `✖ N problems`.

```bash
git add apps/web/src/components/v2/stages-panel.tsx apps/web/e2e/run-sheet.spec.ts
git commit -m "feat(desk): the fixtures tab becomes sheet plus rail at lg"
```

---

## Done when

- Six controls render on the rail; the sheet subtree contains none of their testids.
- `stages-panel-capacity.test.tsx` and `stages-panel-auto-schedule-seq.test.tsx` pass with an unchanged total.
- `run-sheet.spec.ts` + `run-sheet-dates-and-court.spec.ts` fully green.
- Whole `mobile.spec.ts` green at all seven widths.
- Three screenshots exist, differ, and their printed row text shows the intended state.
- `_INDEX.md` ruling 11 marked closed, with the "Compute proposal" false premise recorded beside it.
