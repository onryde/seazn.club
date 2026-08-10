# Board View Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the approved board-view redesign — direction B (division-color
lane cards, icon conflict badges, quiet empty cells), a fixed Move panel, a
duplicated legend, and soft blackout highlighting — per
`docs/superpowers/specs/2026-08-10-board-view-redesign-design.md`.

**Architecture:** Four component files change (`move-panel.tsx`,
`fixture-block.tsx`, `board-grid.tsx`, `schedule-board.tsx`), each an
independently testable, self-contained diff. `board-grid.tsx` gains one new
optional prop (`blackouts`) and reuses two pure helpers
(`toMs`/`overlaps`) already written and tested in
`use-disruption-signals.ts`, exported rather than duplicated.

**Tech Stack:** Next.js/React 19, Tailwind v4, `lucide-react` (already a
dependency, not yet used under `components/v2/board/`), vitest
(`environment: "node"`, no jsdom — every test below uses
`renderToStaticMarkup` or the shared `_hook-harness`, matching this
workspace's existing convention).

**Agent topology (`docs/superpowers/RULES.md`):** Scout (Sonnet, High) for
any exploration beyond what this plan already nails down. Implementer
(Sonnet, MAX effort — set in `.claude/agents/implementer.md` frontmatter)
writes each task. Reviewer (Sonnet, MAX effort) reviews the diff before the
next task starts; loop Implementer → Reviewer → gap list → Implementer →
Reviewer until clean and every test is green. The 5 tasks below touch
disjoint primary files (`move-panel.tsx` / `fixture-block.tsx` /
`board-grid.tsx`+`use-disruption-signals.ts`+`globals.css`+dictionaries /
`schedule-board.tsx`+`board-v3.spec.ts`+`smoke.ts`), so each gets its own
Implementer → Reviewer loop — the batching rule ("several tasks touching the
SAME files → one inline pass") doesn't trigger here.

## Global Constraints

- Scope is exactly `move-panel.tsx`, `fixture-block.tsx`, `board-grid.tsx`,
  `board-legend.tsx` (unchanged structurally), and the composition in
  `schedule-board.tsx`. Do not touch agenda/lanes density modes, the AI
  console, settings panel, or conflicts panel (spec's own "out of scope").
- Every new or changed user-facing string ships in all 4 locale dictionaries
  (`en`, `nl`, `fr`, `es`) — never hardcoded English.
- `i18n-keys.ts` is GENERATED — never hand-edit it. Run
  `npm run i18n:gen-keys` (repo root) after any `en/ui.json` change, then
  `npm run i18n:check` for parity.
- Every task ships a test that fails against the current code and passes
  after the change (TDD, not written after the fact) — this is the
  "regression" leg of the four below.
- **All 4 test types per task, per `docs/superpowers/RULES.md`: unit, E2E
  (Playwright), smoke (`scripts/smoke.ts`), regression.** Below, a task that
  has no NEW behavior beyond what a sibling task's E2E/smoke already drives
  through the same live page says so explicitly and points at that
  coverage — never skipped as N/A. Every UI scenario is checked in BOTH
  shapes the redesign has to handle: single-division (no legend, no
  division chip — the shape in the original bug screenshot) and
  multi-division (legend renders, chips render).
- Before every commit: `npm run openapi:gen && git status --porcelain`
  must be empty (pre-commit OpenAPI drift check, RULES.md). This change
  touches no API/schema, so this should be a no-op confirmation every time
  — if it isn't, something unexpected happened and needs investigating
  before the commit, not after.
- UI is verified by screenshot at desktop (1280px), 320px, and 768px, with
  no horizontal page scroll at any of them (Task 5).
- This workspace has no jsdom. A component that calls a real hook (`useMsg`,
  `useState`, …) must be tested through `renderToStaticMarkup` or
  `_hook-harness`'s `renderIsland` — never called as a plain function.

---

### Task 1: Move panel — fix the width-collapse bug, restyle as a slim light toolbar

**Files:**
- Modify: `apps/web/src/components/v2/board/move-panel.tsx`
- Test: `apps/web/src/components/v2/board/__tests__/move-panel.test.tsx`

**Interfaces:**
- Consumes: `DateTimeField` (`../shared/datetime-field`), unchanged signature.
- Produces: no change to `MovePanel`'s own props or exported signature —
  every other file that renders `<MovePanel .../>` is unaffected.

- [ ] **Step 1: Write the failing test**

Add to the bottom of `apps/web/src/components/v2/board/__tests__/move-panel.test.tsx`, inside the existing `describe("MovePanel", ...)` block:

```tsx
  it("wraps the When field in an explicit-width container so it cannot collapse", () => {
    // Regression for the bug shipped in 00631754 (quarter-hour datetime
    // split field): every OTHER caller of DateTimeField(kind="datetime-local")
    // wraps it in something with a definite width (a grid track, a plain
    // div); this panel dropped it bare into a `flex flex-wrap` row instead,
    // so the split field's percentage-sized date/time children resolved
    // against an auto-sized flex item and collapsed to a near-zero box.
    const html = renderToStaticMarkup(
      <MovePanel {...baseProps} boardConfig={{ config: baseConfig, orgTz: "UTC" }} />,
    );
    expect(html).toContain('class="w-80 max-w-full"');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/v2/board/__tests__/move-panel.test.tsx`
Expected: FAIL — `expect(html).toContain('class="w-80 max-w-full"')` — the class does not exist yet.

- [ ] **Step 3: Replace the panel's return statement**

In `apps/web/src/components/v2/board/move-panel.tsx`, replace the entire `return (...)` block (currently lines 96–145) with:

```tsx
  return (
    <div
      role="dialog"
      aria-label={msg("board.moveAria", { title: cardTitle(fixture, entrantNames, feedLabels) })}
      className="flex flex-wrap items-end gap-3 rounded-lg border border-purple-100 bg-white p-3 shadow-sm"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="mr-1 flex flex-col gap-0.5">
        <span className="text-xs font-semibold text-purple-700">
          {msg("board.moveLabel", { title: cardTitle(fixture, entrantNames, feedLabels) })}
        </span>
        <span className="text-[11px] text-slate-500">{msg("board.moveHint")}</span>
      </div>
      <div className="w-80 max-w-full">
        <DateTimeField
          kind="datetime-local"
          value={when}
          onChange={setWhen}
          label={msg("board.when")}
          options={boardSlotOptions}
        />
      </div>
      <label className="block">
        <span className="label">{venueCap}</span>
        <select value={court} onChange={(e) => setCourt(e.target.value)} className="input px-2 py-1 text-xs">
          {courts.length === 0 && <option value="">{msg("board.unassigned")}</option>}
          {courts.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </label>
      <div className="ml-auto flex gap-2">
        <button type="button" onClick={onClose} className="btn btn-ghost px-3 py-1.5 text-xs">
          {msg("board.cancel")}
        </button>
        <button
          type="button"
          // Resolved on the venue clock, matching the seed and the option list
          // above. `new Date(when)` here would read the wall clock the organiser
          // just picked off the BOARD'S grid as the BROWSER's, storing an instant
          // the offset away from the slot they chose.
          onClick={() =>
            onMove(when ? isoFromZonedDateTime(when, boardConfig.orgTz) : null, court || null)
          }
          className="btn btn-primary px-3 py-1.5 text-xs"
        >
          {msg("board.move")}
        </button>
      </div>
    </div>
  );
```

Two deliberate changes beyond the width fix: the panel goes from a solid
`bg-purple-50` block to a lighter `bg-white` card with a subtler border (the
approved direction keeps the console's light work-surface, not a boxed
alert), and Cancel now sits before Move with both right-aligned (`ml-auto`) —
primary action last/rightmost, matching the approved mockup.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run src/components/v2/board/__tests__/move-panel.test.tsx`
Expected: PASS, all 6 tests (5 existing + 1 new).

- [ ] **Step 5: E2E — a new test that measures the rendered width (RULES.md requires all 4 test types)**

The existing e2e suite (`apps/web/e2e/board-v3.spec.ts`) already drives the
Move dialog through a real submit ("two clients: the stale one 409s..."),
but that proves the FUNCTIONAL path, not the visual one — Playwright can
`fill()`/`selectOption()` a CSS-collapsed element just fine, so that test
would have passed even with the bug. Add a new test that measures the
rendered box, inside `test.describe.serial("board v3 (PROMPT-33)", ...)`,
right after the `"legend filters to two divisions..."` test:

```tsx
  test("Move panel's When field renders at a real width, not collapsed (regression)", async ({
    page,
  }) => {
    await page.goto(boardUrl);
    await page.locator("[data-fixture-id] button[aria-pressed]").first().click();
    const dialog = page.getByRole("dialog", { name: /^Move / });
    const dateInput = dialog.locator('input[type="date"]');
    await expect(dateInput).toBeVisible();
    const box = await dateInput.boundingBox();
    // The bug (00631754, fixed by this redesign) collapsed this to a
    // near-zero box — a real native date input is never this narrow.
    expect(box?.width ?? 0).toBeGreaterThan(80);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  });
```

Run: `cd apps/web && npx playwright test board-v3.spec.ts -g "renders at a real width"`
Expected: on a checkout of this task's change, PASS. (Reviewer: confirm
this test FAILS on the pre-fix `move-panel.tsx` before approving — checkout
the parent commit, rerun, confirm the box width assertion trips, then
return to this task's commit.)

- [ ] **Step 6: Smoke — covered by Task 3's `boardRedesignSuite`, not duplicated here**

`scripts/smoke.ts` has no browser and cannot measure a rendered box width —
this bug is CSS-layout-only, outside what an HTTP-only smoke check can see.
Task 3 adds `boardRedesignSuite`, which does assert the schedule board page
still renders 200 after this redesign; that is this task's smoke
touchpoint (page doesn't 500), not a duplicate-purpose new suite.

- [ ] **Step 7: OpenAPI drift check**

```bash
npm run openapi:gen && git status --porcelain
```

Expected: no diff (this task touches no API/schema).

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/v2/board/move-panel.tsx apps/web/src/components/v2/board/__tests__/move-panel.test.tsx apps/web/e2e/board-v3.spec.ts
git commit -m "fix(board): give the Move panel's When field a definite width

The quarter-hour datetime split field (00631754) collapsed to a near-empty
box here because move-panel.tsx dropped it bare into a flex row with no
width of its own — every other caller wraps it in something that does.
Restyled the panel as a lighter inline toolbar while touching the file."
```

---

### Task 2: Fixture cards — division-color wash, icon conflict badge, merged same-code conflicts, real icons

**Files:**
- Modify: `apps/web/src/components/v2/board/fixture-block.tsx`
- Test (new): `apps/web/src/components/v2/board/__tests__/fixture-block.test.tsx`

**Interfaces:**
- Consumes: `divisionAccent`, `divisionShortCode`, `divisionTint` from
  `@/lib/division-hue` (drops `divisionInk` — no longer used in this file).
  `AlertTriangle`, `Lock`, `Pin` from `lucide-react` (new).
- Produces: `FixtureBlock`'s props are UNCHANGED — `board-grid.tsx` (Task 3)
  calls it exactly as it does today.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/components/v2/board/__tests__/fixture-block.test.tsx`:

```tsx
// Board redesign (docs/superpowers/specs/2026-08-10-board-view-redesign-design.md):
// the card's own background becomes the division-color wash, conflicts move
// to a small icon badge instead of overwriting that background, same-code
// conflicts (two `warn.rest` entries — one per entrant — used to render as
// two identical "rest" badges) collapse into one, and the pin/lock affordance
// drops the raw emoji for a real icon. `FixtureBlock` calls `useMsg`, a real
// hook, so it is mounted with `renderToStaticMarkup` — the same pattern
// `move-panel.test.tsx` uses — never called directly as a plain function.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FixtureBlock } from "../fixture-block";
import type { BoardConflict, BoardFixture } from "../types";

const fixture: BoardFixture = {
  id: "fx-1",
  stage_id: "st-1",
  division_id: "dv-1",
  round_no: 1,
  seq_in_round: 1,
  home_entrant_id: "p1",
  away_entrant_id: "p2",
  scheduled_at: "2026-08-10T11:30:00.000Z",
  venue: null,
  court_label: "Court 1",
  status: "scheduled",
  schedule_source: "manual",
  schedule_locked: false,
  outcome: null,
};

const baseProps = {
  fixture,
  divisionName: "U16 Singles",
  showDivision: false,
  entrantNames: { p1: "D", p2: "E" },
  feedLabels: {},
  canEdit: true,
  picked: false,
  onPick: () => {},
  onTogglePin: () => {},
};

describe("FixtureBlock", () => {
  it("merges same-code conflicts into ONE badge instead of repeating it per entrant", () => {
    // The original bug: two `warn.rest` entries (D needs rest, E needs rest)
    // rendered as two adjacent, indistinguishable "rest" badges.
    const conflicts: BoardConflict[] = [
      { fixture_id: "fx-1", code: "warn.rest", blocking: false, detail: "D needs more rest" },
      { fixture_id: "fx-1", code: "warn.rest", blocking: false, detail: "E needs more rest" },
    ];
    const html = renderToStaticMarkup(<FixtureBlock {...baseProps} conflicts={conflicts} />);
    expect(html.match(/>rest</g)).toHaveLength(1);
    expect(html).toContain("D needs more rest; E needs more rest");
  });

  it("keeps two DIFFERENT conflict codes as two separate badges", () => {
    const conflicts: BoardConflict[] = [
      { fixture_id: "fx-1", code: "warn.rest", blocking: false, detail: "D needs rest" },
      { fixture_id: "fx-1", code: "conflict.court", blocking: true, detail: "Court double-booked" },
    ];
    const html = renderToStaticMarkup(<FixtureBlock {...baseProps} conflicts={conflicts} />);
    expect(html.match(/>rest</g)).toHaveLength(1);
    expect(html).toContain(">court clash<");
  });

  it("drops the old red/amber conflict background and widens the division rail to 6px", () => {
    const conflicts: BoardConflict[] = [
      { fixture_id: "fx-1", code: "warn.rest", blocking: true, detail: "D needs rest" },
    ];
    const html = renderToStaticMarkup(<FixtureBlock {...baseProps} conflicts={conflicts} />);
    expect(html).not.toContain("bg-red-50");
    expect(html).not.toContain("bg-amber-50");
    expect(html).toContain("6px");
  });

  it("renders a lock icon when locked and a pin icon when unlocked — no raw emoji", () => {
    const locked = renderToStaticMarkup(
      <FixtureBlock {...baseProps} fixture={{ ...fixture, schedule_locked: true }} />,
    );
    const unlocked = renderToStaticMarkup(<FixtureBlock {...baseProps} />);
    expect(locked).not.toContain("\u{1F512}"); // 🔒
    expect(unlocked).not.toContain("\u{1F4CC}"); // 📌
  });

  it("the division chip stays legible on the new division-tinted card background", () => {
    // Before this change the chip used divisionTint for ITS OWN background —
    // once the card itself carries that same tint, a same-color chip on a
    // same-color card is invisible. The chip must use the solid accent color
    // instead (divisionAccent, white text), never the tint.
    const html = renderToStaticMarkup(<FixtureBlock {...baseProps} showDivision />);
    expect(html).not.toMatch(/data-division-chip[^>]*style="[^"]*hsl\(\d+ 70% 93%\)/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/v2/board/__tests__/fixture-block.test.tsx`
Expected: FAIL on all 5 — none of this behavior exists in the current file
(two "rest" badges present, `bg-red-50`/`bg-amber-50` present, `border-left-width` is `3px`, raw emoji present, chip still uses `divisionTint`).

- [ ] **Step 3: Rewrite `fixture-block.tsx`**

Replace the imports (lines 6–10):

```tsx
import { divisionAccent, divisionShortCode, divisionTint } from "@/lib/division-hue";
import type { FeedLabelPair } from "@/lib/schedule-board";
import { CONFLICT_LABEL, cardTitle, type BoardConflict, type BoardFixture } from "./types";
import { useMsg } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";
import { AlertTriangle, Lock, Pin } from "lucide-react";
```

Replace the body from `const movable = ...` through the end of the function (lines 41–139) with:

```tsx
  const msg = useMsg();
  const movable = canEdit && fixture.status === "scheduled";
  const title = cardTitle(fixture, entrantNames, feedLabels);
  const statusLabel = (s: string) => {
    const key = `schedule.fstatus.${s}` as MessageKey;
    const label = msg(key);
    return label === key ? s.replace("_", " ") : label;
  };
  const conflictLabel = (code: string) => {
    const key = `board.conflict.${code}` as MessageKey;
    const label = msg(key);
    return label === key ? (CONFLICT_LABEL[code] ?? code) : label;
  };
  // Same conflict CODE can appear once per person it touches (a rest warning
  // fires for both D and E) — merge those into one badge with every detail
  // joined in the tooltip, rather than printing the same word twice.
  const conflictGroups = Object.values(
    conflicts.reduce<Record<string, BoardConflict[]>>((acc, c) => {
      (acc[c.code] ??= []).push(c);
      return acc;
    }, {}),
  );
  const blocking = conflicts.some((c) => c.blocking);
  return (
    <div
      data-fixture-id={fixture.id}
      draggable={movable}
      onDragStart={(e) => e.dataTransfer.setData("text/fixture", fixture.id)}
      className={`group relative mb-0.5 rounded border border-slate-200 px-1.5 py-1 text-[11px] leading-tight ${
        picked ? "ring-2 ring-purple-500" : ""
      } ${movable ? "cursor-grab" : "opacity-80"}`}
      style={{
        borderLeftWidth: 6,
        borderLeftColor: divisionAccent(fixture.division_id),
        backgroundColor: divisionTint(fixture.division_id),
      }}
    >
      {/* Conflict severity is now a badge, not the card's own background —
          the background is the division's, and the two stopped sharing a
          channel. */}
      {conflicts.length > 0 && (
        <span
          aria-hidden
          className={`absolute -top-1.5 -right-1.5 grid h-4 w-4 place-items-center rounded-full ring-2 ring-white ${
            blocking ? "bg-red-600 text-white" : "bg-amber-500 text-white"
          }`}
        >
          <AlertTriangle className="h-2.5 w-2.5" strokeWidth={2.5} />
        </span>
      )}
      <div className="flex items-center gap-1">
        {/* A decided fixture is done — no scheduling handle. It comes back the
            moment the result is undone (status returns to 'scheduled'). */}
        {movable ? (
          <button
            type="button"
            onClick={onPick}
            aria-pressed={picked}
            aria-label={msg("board.block.pickAria", {
              title,
              n: fixture.round_no,
              state: picked ? msg("board.block.statePicked") : msg("board.block.statePick"),
            })}
            className="min-w-0 flex-1 truncate text-left font-medium text-slate-700 hover:text-purple-700"
          >
            {title}
          </button>
        ) : (
          <span className="min-w-0 flex-1 truncate text-left font-medium text-slate-600">
            {title}
          </span>
        )}
        {canEdit && fixture.status === "scheduled" && (
          <button
            type="button"
            onClick={onTogglePin}
            aria-label={fixture.schedule_locked ? msg("board.block.unlock") : msg("board.block.pin")}
            title={fixture.schedule_locked ? msg("board.block.lockedTitle") : msg("board.block.pinTitle")}
            className={fixture.schedule_locked ? "text-purple-700" : "text-slate-400 opacity-30 group-hover:opacity-100"}
          >
            {fixture.schedule_locked ? (
              <Lock className="h-3 w-3" strokeWidth={2.5} />
            ) : (
              <Pin className="h-3 w-3" strokeWidth={2.5} />
            )}
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1 text-[10px] text-slate-500">
        {showDivision && (
          <span
            title={divisionName}
            data-division-chip={divisionShortCode(divisionName)}
            className="rounded px-1 font-semibold text-white"
            style={{ backgroundColor: divisionAccent(fixture.division_id) }}
          >
            {divisionShortCode(divisionName)}
          </span>
        )}
        {time && <span>{time}</span>}
        <span>R{fixture.round_no}</span>
        {fixture.status !== "scheduled" && <span className="text-sky-600">{statusLabel(fixture.status)}</span>}
        {conflictGroups.map((group) => {
          const head = group[0]!;
          const groupBlocking = group.some((c) => c.blocking);
          const detail = group.map((c) => c.detail).filter(Boolean).join("; ");
          return (
            <span
              key={head.code}
              title={detail || undefined}
              className={`rounded px-1 ${groupBlocking ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`}
            >
              {conflictLabel(head.code)}
            </span>
          );
        })}
      </div>
    </div>
  );
}
```

(The function signature and its prop destructuring above `const msg = useMsg();`, i.e. lines 1–40, are unchanged — only the imports and the body from `const msg = useMsg();` onward move.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run src/components/v2/board/__tests__/fixture-block.test.tsx`
Expected: PASS, all 5.

- [ ] **Step 5: E2E — extend the existing rest-violation test with a card-level assertion**

`apps/web/e2e/board-v3.spec.ts`'s `"injected rest violation → badge count →
panel → jump-to-fixture"` test (around line 207) already injects the exact
two-entrant `warn.rest` scenario this task's merge fix targets — it just
never checked the CARD's own badge, only the side panel's list. Extend it
rather than duplicate the rig. Insert right before the existing
`await panel.getByRole("button", { name: "Jump to fixture →" }).first().click();`
line (still inside the same test, `fa`/`fb` already in scope):

```tsx
    // The card itself must show ONE merged "rest" badge, not two (the
    // original bug: two warn.rest entries — one per entrant — rendered as
    // two identical, indistinguishable badges).
    const card = page.locator(`[data-fixture-id="${fa}"]`);
    await expect(card.getByText("rest", { exact: true })).toHaveCount(1);
    // No raw pin/lock emoji anywhere on the board — real icons only.
    await expect(page.getByText("📌")).toHaveCount(0);
    await expect(page.getByText("🔒")).toHaveCount(0);

```

Run: `cd apps/web && npx playwright test board-v3.spec.ts -g "injected rest violation"`
Expected: PASS. (Reviewer: confirm this specific assertion block fails
against the pre-Task-2 `fixture-block.tsx` — two "rest" text nodes, not
one.)

- [ ] **Step 6: Smoke — covered by Task 3's `boardRedesignSuite`**

That suite's `"no raw pin emoji in the markup"` check exercises this task's
icon swap on a real rendered fixture card; not duplicated here.

- [ ] **Step 7: OpenAPI drift check**

```bash
npm run openapi:gen && git status --porcelain
```

Expected: no diff.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/v2/board/fixture-block.tsx apps/web/src/components/v2/board/__tests__/fixture-block.test.tsx apps/web/e2e/board-v3.spec.ts
git commit -m "feat(board): fixture cards wash with division color, conflicts move to an icon badge

Conflict state used to overwrite the card's own bg-red-50/bg-amber-50,
fighting the division-hue border for the same visual channel. It's now a
small icon badge, division color owns the card, same-code conflicts (two
'rest' badges for a two-entrant rest warning) merge into one, and the
pin/lock affordance drops the raw emoji for lucide icons."
```

---

### Task 3: Board grid — quiet empty cells, condensed headers, blackout highlighting

**Files:**
- Modify: `apps/web/src/components/v2/board/board-grid.tsx`
- Modify: `apps/web/src/components/v2/board/use-disruption-signals.ts` (export two existing pure helpers)
- Modify: `apps/web/src/app/globals.css` (one new small component class)
- Modify: `apps/web/src/dictionaries/en/ui.json`, `nl/ui.json`, `fr/ui.json`, `es/ui.json`
- Test (new): `apps/web/src/components/v2/board/__tests__/board-grid-blackout.test.tsx`

**Interfaces:**
- Consumes: `overlaps(startMs, endMs, bFrom, bTo): boolean` and
  `toMs(v: string | Date): number` from `./use-disruption-signals` (both
  already exist as module-private functions — this task only adds the
  `export` keyword, no behavior change, so `use-disruption-signals.test.ts`
  if any keeps passing unmodified).
- Produces: `BoardGrid` gains one new prop, `blackouts?: BoardConfig["blackouts"]`
  (default `[]` when omitted — the two existing call sites in
  `schedule-board-ghosts.test.tsx` and `schedule-board-grid-step.test.tsx`
  need no changes). Task 4 passes `blackouts={cfg.blackouts}`.

- [ ] **Step 1: Export the two helpers `board-grid.tsx` will reuse**

In `apps/web/src/components/v2/board/use-disruption-signals.ts`, change:

```ts
function toMs(v: string | Date): number {
```

to:

```ts
export function toMs(v: string | Date): number {
```

and:

```ts
function overlaps(startMs: number, endMs: number, bFrom: number, bTo: number): boolean {
```

to:

```ts
export function overlaps(startMs: number, endMs: number, bFrom: number, bTo: number): boolean {
```

No test needed for this step alone — it's covered by Step 2's failing test in `board-grid.tsx`, which imports both.

- [ ] **Step 2: Add the two new i18n keys (blackout aria copy)**

The visible "Blackout" label in the cell reuses the EXISTING `board.conflict.warn.blackout` key (already translated in all 4 dictionaries) — no new label key. Two new ARIA keys are needed, matching the existing `placeAriaCourt`/`placeAriaUnassigned` pair's shape. The old `board.grid.placeHere` key becomes dead (its only use site is deleted in Step 4) and is removed.

In `apps/web/src/dictionaries/en/ui.json`, replace:

```json
  "board.grid.placeAriaCourt": "Place picked match at {time} on {court}",
  "board.grid.placeAriaUnassigned": "Place picked match at {time} (unassigned)",
  "board.grid.placeHere": "Place here",
```

with:

```json
  "board.grid.placeAriaCourt": "Place picked match at {time} on {court}",
  "board.grid.placeAriaUnassigned": "Place picked match at {time} (unassigned)",
  "board.grid.blackoutAriaCourt": "{time} on {court} is blacked out — you can still place here",
  "board.grid.blackoutAriaVenue": "{time} is blacked out on every board — you can still place here",
```

In `apps/web/src/dictionaries/nl/ui.json`, replace the matching three lines with:

```json
  "board.grid.placeAriaCourt": "Plaats gekozen wedstrijd om {time} op {court}",
  "board.grid.placeAriaUnassigned": "Plaats gekozen wedstrijd om {time} (niet-toegewezen)",
  "board.grid.blackoutAriaCourt": "{time} op {court} is geblokkeerd — u kunt hier nog steeds plaatsen",
  "board.grid.blackoutAriaVenue": "{time} is geblokkeerd op elk bord — u kunt hier nog steeds plaatsen",
```

In `apps/web/src/dictionaries/fr/ui.json`:

```json
  "board.grid.placeAriaCourt": "Placer le match sélectionné à {time} sur {court}",
  "board.grid.placeAriaUnassigned": "Placer le match sélectionné à {time} (non attribué)",
  "board.grid.blackoutAriaCourt": "{time} sur {court} est indisponible — vous pouvez quand même placer ici",
  "board.grid.blackoutAriaVenue": "{time} est indisponible sur tous les tableaux — vous pouvez quand même placer ici",
```

In `apps/web/src/dictionaries/es/ui.json`:

```json
  "board.grid.placeAriaCourt": "Colocar el partido seleccionado a las {time} en {court}",
  "board.grid.placeAriaUnassigned": "Colocar el partido seleccionado a las {time} (sin asignar)",
  "board.grid.blackoutAriaCourt": "{time} en {court} está bloqueado — aún puedes colocar aquí",
  "board.grid.blackoutAriaVenue": "{time} está bloqueado en todos los tableros — aún puedes colocar aquí",
```

Then, from the repo root:

```bash
npm run i18n:gen-keys && npm run i18n:check
```

Expected: `i18n:gen-keys` regenerates `apps/web/src/lib/i18n-keys.ts` (do not
hand-edit it); `i18n:check` reports no parity errors.

- [ ] **Step 3: Add the blackout hatch CSS**

In `apps/web/src/app/globals.css`, immediately after the closing brace of `.table tbody tr:nth-child(even) { @apply bg-purple-50/30; }` (inside the `.table` block, still within `@layer components`), add:

```css

  /* Blackout window on the schedule board grid (2026-08-10 board redesign):
     a hatch, not a solid fill, so it reads as "off-limits" without fighting
     a fixture card's own division-tint background for the same channel. The
     gap stripe is transparent on purpose — a `hover:bg-purple-50` utility on
     the same element shows THROUGH it, tinting the hatch on hover. */
  .board-blackout {
    background-image: repeating-linear-gradient(135deg, #f1f5f9 0 6px, transparent 6px 12px);
  }
```

- [ ] **Step 4: Write the failing tests**

Create `apps/web/src/components/v2/board/__tests__/board-grid-blackout.test.tsx`:

```tsx
// Board redesign (docs/superpowers/specs/2026-08-10-board-view-redesign-design.md):
// blackout windows get a hatched, always-visible highlight on the grid — but
// stay SOFT (still clickable/droppable), matching the server, which treats
// `warn.blackout` as a warning, not a rejection. `BoardGrid` calls `useMsg`,
// so it is mounted with `renderToStaticMarkup`, never called directly.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardGrid } from "../board-grid";

const T11 = Date.parse("2026-08-10T11:00:00.000Z");
const T1130 = Date.parse("2026-08-10T11:30:00.000Z");

const baseProps = {
  day: "2026-08-10",
  slots: [T11, T1130],
  slotMinutes: 30,
  courts: ["Court 1", "Court 2"],
  fixtures: [],
  divisionNames: {},
  entrantNames: {},
  feedLabels: {},
  conflictsByFixture: {},
  canEdit: true,
  multi: false,
  pickedId: null,
  onPick: () => {},
  onPlace: () => {},
  onDropCard: () => {},
  onTogglePin: () => {},
  venueCap: "Court",
  highlightId: null,
  ghosts: null,
};

describe("BoardGrid blackout zones", () => {
  it("hatches a court-specific blackout only on its own court", () => {
    const html = renderToStaticMarkup(
      <BoardGrid
        {...baseProps}
        blackouts={[{ court: "Court 2", from: "2026-08-10T11:00:00.000Z", to: "2026-08-10T11:30:00.000Z" }]}
      />,
    );
    expect(html.match(/board-blackout/g)).toHaveLength(1);
  });

  it("hatches every court on a venue-wide (courtless) blackout", () => {
    const html = renderToStaticMarkup(
      <BoardGrid
        {...baseProps}
        blackouts={[{ from: "2026-08-10T11:00:00.000Z", to: "2026-08-10T11:30:00.000Z" }]}
      />,
    );
    expect(html.match(/board-blackout/g)).toHaveLength(2);
  });

  it("does not hatch a row the blackout window doesn't reach", () => {
    // Window is 11:00–11:30 — the SECOND slot (11:30–12:00) must stay clean.
    const html = renderToStaticMarkup(
      <BoardGrid
        {...baseProps}
        slots={[T1130]}
        blackouts={[{ from: "2026-08-10T11:00:00.000Z", to: "2026-08-10T11:30:00.000Z" }]}
      />,
    );
    expect(html).not.toContain("board-blackout");
  });

  it("keeps blackout cells enabled (soft) once a fixture is picked — never disabled", () => {
    const html = renderToStaticMarkup(
      <BoardGrid
        {...baseProps}
        pickedId="fx-1"
        blackouts={[{ from: "2026-08-10T11:00:00.000Z", to: "2026-08-10T11:30:00.000Z" }]}
      />,
    );
    expect(html).not.toContain("disabled");
  });

  it("drops the old repeated 'Place here' text entirely", () => {
    const html = renderToStaticMarkup(<BoardGrid {...baseProps} pickedId="fx-1" />);
    expect(html).not.toContain("Place here");
  });
});
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `cd apps/web && npx vitest run src/components/v2/board/__tests__/board-grid-blackout.test.tsx`
Expected: FAIL on all 5 — `BoardGrid` does not accept a `blackouts` prop yet (TypeScript/runtime: the prop is silently ignored, so no `board-blackout` class ever appears; the last test fails because "Place here" is still printed today).

- [ ] **Step 6: Update `board-grid.tsx`**

Replace the imports (lines 7–14):

```tsx
import { dayKey } from "@/lib/schedule-board";
import type { FeedLabelPair } from "@/lib/schedule-board";
import { FixtureBlock } from "./fixture-block";
import { timeLabel } from "@/lib/day-label";
import { divisionInk, divisionTint } from "@/lib/division-hue";
import { UNASSIGNED, type BoardConfig, type BoardConflict, type BoardFixture, type GhostBlock } from "./types";
import { useMsg } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";
import { overlaps, toMs } from "./use-disruption-signals";
import { Plus } from "lucide-react";
```

(Only `type BoardConfig` and the last two lines are new — `divisionInk`/`divisionTint` stay, still used by `GhostBlockView` further down.)

Add `blackouts` to the props destructuring and its type block. Change:

```tsx
export function BoardGrid({
  day,
  slots,
  slotMinutes,
  courts,
  fixtures,
  divisionNames,
  entrantNames,
  feedLabels,
  conflictsByFixture,
  canEdit,
  multi,
  pickedId,
  onPick,
  onPlace,
  onDropCard,
  onTogglePin,
  venueCap,
  highlightId,
  ghosts,
}: {
```

to:

```tsx
export function BoardGrid({
  day,
  slots,
  slotMinutes,
  courts,
  fixtures,
  divisionNames,
  entrantNames,
  feedLabels,
  conflictsByFixture,
  canEdit,
  multi,
  pickedId,
  onPick,
  onPlace,
  onDropCard,
  onTogglePin,
  venueCap,
  highlightId,
  ghosts,
  blackouts = [],
}: {
```

and add, right after the `ghosts?: GhostBlock[] | null;` line in the type block:

```tsx
  /** Blackout windows from the board's own config (v3/04 board redesign) —
   *  highlighted on the grid, never disabled: the server treats a blackout as
   *  a warning (`warn.blackout`), not a rejection, so the client must not
   *  refuse what the server allows. */
  blackouts?: BoardConfig["blackouts"];
```

Add the intersection helper right after the existing `isMajor` line (`const isMajor = (t: number) => ...`):

```tsx
  const inBlackout = (t: number, court: string | null) => {
    for (const b of blackouts) {
      if (b.court != null && b.court !== court) continue;
      const bFrom = toMs(b.from);
      const bTo = toMs(b.to);
      if (Number.isNaN(bFrom) || Number.isNaN(bTo)) continue;
      if (overlaps(t, t + slotMinutes * MIN, bFrom, bTo)) return b;
    }
    return null;
  };
```

Replace the two `<th>` blocks in `<thead>`:

```tsx
            <th className="sticky top-0 z-10 w-16 border-b border-slate-200 bg-slate-50 px-2 py-2 text-left font-medium text-slate-500">
              {msg("board.grid.time")}
            </th>
            {columns.map((c) => (
              <th
                key={c ?? UNASSIGNED}
                className="sticky top-0 z-10 min-w-36 border-b border-slate-200 border-l bg-slate-50 px-2 py-2 text-left font-medium text-slate-600"
              >
                {c ?? msg("board.grid.unassignedCol", { venue: venueCap.toLowerCase() })}
              </th>
            ))}
```

with:

```tsx
            <th className="app-display sticky top-0 z-10 w-16 border-b border-slate-200 bg-slate-50 px-2 py-2 text-left text-[10px] font-bold text-slate-400">
              {msg("board.grid.time")}
            </th>
            {columns.map((c) => (
              <th
                key={c ?? UNASSIGNED}
                className="app-display sticky top-0 z-10 min-w-36 border-b-2 border-purple-200 border-l border-l-slate-200 bg-slate-50 px-2 py-2 text-left text-[11px] font-bold text-slate-800"
              >
                {c ?? msg("board.grid.unassignedCol", { venue: venueCap.toLowerCase() })}
              </th>
            ))}
```

(`.app-display` is the console's existing condensed-header CSS class — see
`duplicates-panel.tsx` for the same recipe already in production.)

Replace the entire `{columns.map((court) => { ... })}` block (the whole callback body, from `const inSlot = ...` through its closing `)}`) with:

```tsx
              {columns.map((court) => {
                const inSlot = (at: number) => at >= t && at < t + slotMinutes * MIN;
                const sameCol = (c: string | null) => (court === null ? c === null : c === court);
                const cell = fixtures.filter(
                  (f) => sameCol(f.court_label) && inSlot(new Date(f.scheduled_at as string).getTime()),
                );
                const cellGhosts = showGhosts
                  ? ghosts!.filter((g) => sameCol(g.court) && inSlot(g.at))
                  : [];
                const iso = new Date(t).toISOString();
                const blackout =
                  !showGhosts && canEdit && cell.length === 0 ? inBlackout(t, court) : null;
                return (
                  <td
                    key={court ?? UNASSIGNED}
                    className={`${rowHeight} border-b border-l border-slate-100 px-1 py-0.5 align-top`}
                    onDragOver={canEdit && !showGhosts ? (e) => e.preventDefault() : undefined}
                    onDrop={
                      canEdit && !showGhosts
                        ? (e) => {
                            e.preventDefault();
                            const fid = e.dataTransfer.getData("text/fixture");
                            if (fid) onDropCard(fid, iso, court);
                          }
                        : undefined
                    }
                  >
                    {/* AI proposal on screen: read-only ghost preview (§3). */}
                    {showGhosts
                      ? cellGhosts.map((g) => <GhostBlockView key={g.id} ghost={g} msg={msg} />)
                      : cell.map((f) => (
                          <div key={f.id} className={highlightId === f.id ? "animate-pulse" : undefined}>
                            <FixtureBlock
                              fixture={f}
                              divisionName={divisionNames[f.division_id] ?? ""}
                              showDivision={multi}
                              entrantNames={entrantNames}
                              feedLabels={feedLabels}
                              conflicts={conflictsByFixture[f.id] ?? []}
                              canEdit={canEdit}
                              picked={pickedId === f.id}
                              onPick={() => onPick(f.id)}
                              onTogglePin={() => onTogglePin(f)}
                            />
                          </div>
                        ))}
                    {!showGhosts && canEdit && cell.length === 0 && (
                      <button
                        type="button"
                        onClick={() => onPlace(iso, court)}
                        aria-label={
                          blackout
                            ? blackout.court
                              ? msg("board.grid.blackoutAriaCourt", { time: timeLabel(t), court: blackout.court })
                              : msg("board.grid.blackoutAriaVenue", { time: timeLabel(t) })
                            : court
                              ? msg("board.grid.placeAriaCourt", { time: timeLabel(t), court })
                              : msg("board.grid.placeAriaUnassigned", { time: timeLabel(t) })
                        }
                        className={`h-full ${placeHeight} w-full rounded text-[8px] font-bold uppercase tracking-wide transition ${
                          blackout
                            ? "board-blackout text-slate-400 hover:bg-purple-50 hover:text-purple-600"
                            : pickedId
                              ? "grid place-items-center text-transparent hover:bg-purple-50 hover:text-purple-600 focus-visible:bg-purple-50 focus-visible:text-purple-600"
                              : "text-transparent"
                        }`}
                        tabIndex={pickedId ? 0 : -1}
                        disabled={!pickedId}
                        data-blackout={blackout ? "true" : undefined}
                      >
                        {blackout ? (
                          msg("board.conflict.warn.blackout")
                        ) : pickedId ? (
                          <Plus className="mx-auto h-3.5 w-3.5" strokeWidth={2.5} />
                        ) : (
                          ""
                        )}
                      </button>
                    )}
                  </td>
                );
              })}
```

(`data-blackout` is a plain DOM marker for tests, deliberately independent
of the `board-blackout` CSS class name — a future restyle shouldn't have to
touch the E2E/smoke selectors below.)

The rest of the file (`fixturesOn`, `GHOST_TONE`, `GhostBlockView`) is unchanged.

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd apps/web && npx vitest run src/components/v2/board/__tests__/board-grid-blackout.test.tsx`
Expected: PASS, all 5.

- [ ] **Step 8: Confirm no collateral damage in sibling board-grid callers**

Run: `cd apps/web && npx vitest run src/components/v2/__tests__/schedule-board-ghosts.test.tsx src/components/v2/__tests__/schedule-board-grid-step.test.tsx --reporter=json --outputFile=/tmp/board-grid-siblings.json`
Expected: same pass count as before this task (the new `blackouts` prop defaults to `[]`, so these callers — which never pass it — are unaffected). Read `/tmp/board-grid-siblings.json`'s `numFailedTests`; must be `0`.

- [ ] **Step 9: E2E — a new blackout test (genuinely new behavior, no existing coverage to extend)**

Add to `apps/web/e2e/board-v3.spec.ts`, inside the same `describe.serial`
block, after the `"pick-then-place is keyboard-operable..."` test. Uses
`rig.divisions[2]` — untouched by the rest-violation test's settings PUT on
`divisions[0]` — to stay fully isolated from the other tests in this file:

```tsx
  test("blackout window: hatched, always visible, and still placeable (soft, not blocked)", async ({
    page,
    request,
  }) => {
    const d2 = rig.divisions[2]!;
    await apiJson(request, `/api/v1/divisions/${d2.id}/schedule-settings`, "PUT", {
      config: {
        startAt: "2026-09-15T09:00:00.000Z",
        matchMinutes: 30,
        gapMinutes: 0,
        courts: courtsOf(2),
        perEntrantMinRest: 0,
        blackouts: [
          { court: courtsOf(2)[0], from: "2026-09-15T09:00:00.000Z", to: "2026-09-15T09:30:00.000Z" },
        ],
        sessionWindows: [],
      },
      tz: "UTC",
    });
    const target = rig.fixtures[d2.id]![6]!;
    await apiJson(request, `/api/v1/fixtures/${target}`, "PATCH", {
      scheduled_at: null,
      court_label: null,
    });

    await page.goto(`${boardUrl}?d=${d2.slug}`);
    const blackoutCell = page.locator('[data-blackout="true"]').first();
    await expect(blackoutCell).toBeVisible();

    // Soft: pick the unscheduled fixture, place it INTO the hatched cell —
    // it must succeed, matching the server's own warn.blackout-is-a-warning
    // (not a rejection) behavior.
    await page.getByRole("button", { name: /^Unscheduled/ }).click();
    const sheet = page.getByRole("region", { name: "Unscheduled fixtures" });
    await sheet.locator("[data-fixture-id] button[aria-pressed]").first().click();
    await blackoutCell.click();

    await expect
      .poll(
        async () =>
          (await apiJson<{ scheduled_at: string | null }>(request, `/api/v1/fixtures/${target}`))
            .data!.scheduled_at,
        { timeout: 15_000 },
      )
      .not.toBeNull();
  });
```

Run: `cd apps/web && npx playwright test board-v3.spec.ts -g "blackout window"`
Expected: PASS.

- [ ] **Step 10: Smoke — new `boardRedesignSuite`, additive-only**

`scripts/smoke.ts`'s existing `schedRegV3Suite` (line ~9727) is a single,
very long function this task should NOT edit blind — its full blast radius
past the point this plan has read is unknown, and RULES.md's own rule is to
escalate rather than risk that, not silently expand scope into it. Add a
new, fully self-contained function instead — own competition, own 2-division
rig (division count needed for Task 4's legend check, folded in here since
it's the same page load) — called once, right after the existing
`schedRegV3Suite` call:

In `scripts/smoke.ts`, add this new function (near the other `*Suite`
functions, e.g. right after `schedRegV3Suite`'s closing brace):

```ts
// --- Board redesign (2026-08-10): legend duplicated below the grid, and
// blackout windows highlighted on the grid. Own tiny 2-division rig,
// additive only — isolated from schedRegV3Suite's much larger one so this
// never risks any of that suite's assertions. Competition dates are pinned
// explicitly (both here AND on the division's own schedule config) because
// the board's initial `day` is `days[0]`, derived from competitionStart/
// competitionEnd with no URL override — smoke has no browser, so it only
// ever sees whatever day the SSR'd page opens on by default.
async function boardRedesignSuite(admin: Session, orgSlug: string): Promise<void> {
  const comp = v1data<{ id: string; slug: string }>(
    await v1(admin, "/api/v1/competitions", "POST", {
      starts_on: "2026-10-05",
      ends_on: "2026-10-06",
      name: `Board redesign ${tag}`,
      visibility: "public",
    }),
  );

  const divA = v1data<{ id: string }>(
    await v1(admin, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Board Redesign A",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );
  await v1(admin, `/api/v1/divisions/${divA.id}/entrants`, "POST", [
    { kind: "individual", display_name: "Redesign A P1", seed: 1 },
    { kind: "individual", display_name: "Redesign A P2", seed: 2 },
  ]);
  const stageA = v1data<{ id: string }>(
    await v1(admin, `/api/v1/divisions/${divA.id}/stages`, "POST", {
      seq: 1,
      kind: "league",
      name: "League",
    }),
  );
  await v1(admin, `/api/v1/divisions/${divA.id}/schedule-settings`, "PUT", {
    config: {
      startAt: "2026-10-05T09:00:00.000Z",
      matchMinutes: 30,
      gapMinutes: 0,
      courts: ["A", "B"],
      perEntrantMinRest: 0,
      blackouts: [{ court: "A", from: "2026-10-05T09:00:00.000Z", to: "2026-10-05T09:30:00.000Z" }],
      sessionWindows: [],
    },
  });
  const genA = v1data<{ fixtures: { id: string }[] }>(
    await v1(admin, `/api/v1/stages/${stageA.id}/generate`, "POST"),
  );
  // Court B, same time — outside the court-A-scoped blackout — so a real
  // FixtureBlock renders on the initial page load for the pin-icon check.
  await v1(admin, `/api/v1/fixtures/${genA.fixtures[0]!.id}`, "PATCH", {
    scheduled_at: "2026-10-05T09:00:00.000Z",
    court_label: "B",
  });

  // Division B exists purely so the division-filter legend has 2+ divisions
  // to render at all (BoardLegend returns null at divisions.length <= 1).
  const divB = v1data<{ id: string }>(
    await v1(admin, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Board Redesign B",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );
  await v1(admin, `/api/v1/divisions/${divB.id}/entrants`, "POST", [
    { kind: "individual", display_name: "Redesign B P1", seed: 1 },
    { kind: "individual", display_name: "Redesign B P2", seed: 2 },
  ]);
  await v1(admin, `/api/v1/divisions/${divB.id}/stages`, "POST", {
    seq: 1,
    kind: "league",
    name: "League",
  });

  const board = await html(admin, `/o/${orgSlug}/c/${comp.slug}/schedule`);
  check("board redesign: page renders (pro)", board.status === 200);
  check(
    "board redesign: blackout cell marked on the grid",
    board.body.includes('data-blackout="true"'),
  );
  check(
    "board redesign: legend renders twice (above the grid and below it)",
    (board.body.match(/aria-label="Filter by division"/g) ?? []).length === 2,
  );
  check(
    "board redesign: no raw pin emoji in the markup (real fixture is on screen)",
    board.body.includes("Redesign A P1") && !board.body.includes("\u{1F4CC}"),
  );
}
```

The call site (`await boardRedesignSuite(admin, renamed.slug);`, reusing the
already-Pro `org2`/`renamed` from `schedRegV3Suite`'s call just above it) is
added in Task 4, since Task 4 is what makes the legend actually render
twice — wiring the call here would 1/4-fail until Task 4 lands.

Run (once Task 4 has wired the call site): `npx tsx scripts/smoke.ts` (or
this repo's usual smoke invocation) and grep its output for `board redesign:`
— all 4 lines must read `PASS`.

- [ ] **Step 11: OpenAPI drift check**

```bash
npm run openapi:gen && git status --porcelain
```

Expected: no diff.

- [ ] **Step 12: Commit**

```bash
git add apps/web/src/components/v2/board/board-grid.tsx apps/web/src/components/v2/board/use-disruption-signals.ts apps/web/src/app/globals.css apps/web/src/dictionaries/en/ui.json apps/web/src/dictionaries/nl/ui.json apps/web/src/dictionaries/fr/ui.json apps/web/src/dictionaries/es/ui.json apps/web/src/lib/i18n-keys.ts apps/web/src/components/v2/board/__tests__/board-grid-blackout.test.tsx apps/web/e2e/board-v3.spec.ts scripts/smoke.ts
git commit -m "feat(board): quiet empty cells, condensed headers, blackout highlighting

Empty cells stop repeating 'Place here' on every open slot (~30x on a
typical board) — quiet until hover/focus, then a wash + a plus mark.
Blackout windows (BoardConfig.blackouts) now get a hatched, always-visible
highlight; soft on purpose — placing there still works, matching the
server's own warn.blackout-is-a-warning-not-a-rejection behavior."
```

---

### Task 4: Wire blackouts into the grid, duplicate the legend below the board

**Files:**
- Modify: `apps/web/src/components/v2/schedule-board.tsx`
- Test (new): `apps/web/src/components/v2/__tests__/schedule-board-legend.test.tsx`

**Interfaces:**
- Consumes: `BoardGrid`'s new `blackouts` prop (Task 3), `BoardLegend`'s
  existing props (unchanged).
- Produces: nothing downstream depends on this file's internals.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/v2/__tests__/schedule-board-legend.test.tsx`:

```tsx
// The division-filter legend used to render once, above the grid — invisible
// again the moment a tall board scrolled it past the top of the viewport
// (docs/superpowers/specs/2026-08-10-board-view-redesign-design.md). It now
// repeats below the grid too, sharing the same filter state. Mounted through
// the shared hook harness, same pattern as schedule-board-polish.test.tsx —
// this workspace has no jsdom.
import { describe, expect, it, vi } from "vitest";
import { renderIsland } from "@/components/__tests__/_hook-harness";
import type { BoardDivision, BoardFixture, BoardStage } from "../board/types";
import { BoardLegend } from "../board/board-legend";

const nav = vi.hoisted(() => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn(), search: "" }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: nav.refresh, replace: nav.replace, push: nav.push }),
  usePathname: () => "/o/acme/competitions/c1/schedule",
  useSearchParams: () => new URLSearchParams(nav.search),
}));

vi.mock("@/components/i18n/dict-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/i18n/dict-provider")>();
  return { ...actual, useLocale: () => "en" as const };
});

vi.mock("@/lib/analytics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analytics")>();
  return { ...actual, track: vi.fn() };
});

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return { ...actual, apiV1: () => Promise.resolve({ conflicts: [] }) };
});

import { ScheduleBoard } from "../schedule-board";

const DIVISIONS: BoardDivision[] = [
  { id: "d1", name: "Under 12s", slug: "u12", status: "active", seq: 4, schedule_locked: false },
  { id: "d2", name: "Under 14s", slug: "u14", status: "active", seq: 5, schedule_locked: false },
];
const STAGES: BoardStage[] = [
  { id: "s1", division_id: "d1", name: "Round robin", kind: "round_robin", ordinal: 1 },
  { id: "s2", division_id: "d2", name: "Round robin", kind: "round_robin", ordinal: 1 },
] as unknown as BoardStage[];
const FIXTURES: BoardFixture[] = [
  {
    id: "f1",
    stage_id: "s1",
    division_id: "d1",
    round_no: 1,
    seq_in_round: 1,
    home_entrant_id: "e1",
    away_entrant_id: "e2",
    scheduled_at: "2026-08-01T09:00:00.000Z",
    venue: null,
    court_label: "Court 1",
    status: "scheduled",
    schedule_source: "manual",
    schedule_locked: false,
    outcome: null,
  } as unknown as BoardFixture,
];

const SETTINGS = {
  tz: "Europe/London",
  config: {
    startAt: "2026-08-01T09:00:00.000Z",
    endAt: "2026-08-01T18:00:00.000Z",
    matchMinutes: 60,
    gapMinutes: 0,
    courts: ["Court 1", "Court 2"],
    perEntrantMinRest: 0,
    blackouts: [{ court: "Court 2", from: "2026-08-01T09:00:00.000Z", to: "2026-08-01T10:00:00.000Z" }],
    sessionWindows: [],
  },
} as unknown as Parameters<typeof ScheduleBoard>[0]["settings"];

type BoardProps = Parameters<typeof ScheduleBoard>[0];

const baseProps = (): BoardProps =>
  ({
    divisions: DIVISIONS,
    stages: STAGES,
    fixtures: FIXTURES,
    entrantNames: { e1: "Alpha", e2: "Bravo" },
    activeEntrantCounts: { d1: 2, d2: 0 },
    feedLabels: {},
    settings: SETTINGS,
    canEdit: true,
    constraintsAllowed: true,
    canManage: true,
    aiAllowed: true,
    currency: "usd",
    competitionStart: "2026-08-01",
    competitionEnd: "2026-08-02",
    officialsWithBlackout: 0,
    competition: { id: "c1", divisionSettings: { d1: SETTINGS, d2: SETTINGS } },
  }) as unknown as BoardProps;

vi.stubGlobal("window", {
  localStorage: { getItem: () => null, setItem: () => {} },
  matchMedia: () => ({ matches: false }),
  get location() {
    return { search: nav.search };
  },
});

describe("board legend + blackout wiring", () => {
  it("renders the legend once above the grid and once below it, same divisions", () => {
    const island = renderIsland(ScheduleBoard, baseProps());
    const legends = island.tree().filter((el) => el.type === BoardLegend);
    expect(legends).toHaveLength(2);
    for (const legend of legends) {
      expect(legend.props).toMatchObject({ divisions: DIVISIONS });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/v2/__tests__/schedule-board-legend.test.tsx`
Expected: FAIL — `expect(legends).toHaveLength(2)` sees `1` (only the existing legend above the grid).

- [ ] **Step 3: Wire the `blackouts` prop into `BoardGrid`**

In `apps/web/src/components/v2/schedule-board.tsx`, find the `<BoardGrid ... />` call (around line 1223) and add one prop after `ghosts={dayGhosts}`:

```tsx
            <BoardGrid
              day={day}
              slots={slots}
              slotMinutes={slotMinutes}
              courts={courts}
              fixtures={dayFixtures}
              divisionNames={divisionNames}
              entrantNames={entrantNames}
              feedLabels={feedLabels}
              conflictsByFixture={actions.conflictsByFixture}
              canEdit={canEdit}
              multi={multi}
              pickedId={pickedId}
              onPick={pick}
              onPlace={(iso, court) => void place(iso, court)}
              onDropCard={(fid, iso, court) => void actions.moveCard(fid, iso, court)}
              onTogglePin={(f) => void actions.togglePin(f)}
              venueCap={venueCap}
              highlightId={highlightId}
              ghosts={dayGhosts}
              blackouts={cfg.blackouts}
            />
```

- [ ] **Step 4: Duplicate the legend below the board**

Immediately after the closing `</div>` of the "Board + tray share the row" container (the `<div className="flex items-start gap-4">...</div>` that holds `BoardGrid`/`WeekView`/`BoardAgenda`/`BoardLanes` and `BoardTray`, ending around line 1306) and before the `{panelOpen && (` block, add:

```tsx
      {/* Same filter state as the legend above — repeated so a tall board
          never scrolls the division filter out of reach (board redesign,
          docs/superpowers/specs/2026-08-10-board-view-redesign-design.md). */}
      {density === "board" && view === "day" && (
        <BoardLegend
          divisions={divisions}
          selected={selectedSlugs}
          onToggle={toggleFilter}
          onClear={() => toggleFilter(null)}
        />
      )}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/web && npx vitest run src/components/v2/__tests__/schedule-board-legend.test.tsx`
Expected: PASS.

- [ ] **Step 6: E2E — multi-division: fix the now-ambiguous locator, assert the legend count**

The legend now renders twice, so `apps/web/e2e/board-v3.spec.ts`'s
`"legend filters to two divisions in two taps..."` test (around line 186)
breaks: `page.getByRole("button", { name: "U16 Boys", exact: true }).click()`
matches TWO elements once this task lands (one per legend instance) and
Playwright's strict mode throws. This is caused directly by this task, so
it's fixed here, not filed separately (RULES.md: fix inline within blast
radius). Right after `await page.goto(boardUrl);`, add the count assertion,
then scope both existing clicks to `.first()`:

```tsx
    // Legend now renders twice — once above the grid, once below it — both
    // sharing one filter state (board redesign, 2026-08-10).
    await expect(page.getByRole("group", { name: "Filter by division" })).toHaveCount(2);
```

then change:

```tsx
    await page.getByRole("button", { name: "U16 Boys", exact: true }).click();
    await page.getByRole("button", { name: "U16 Girls", exact: true }).click();
```

to:

```tsx
    await page.getByRole("button", { name: "U16 Boys", exact: true }).first().click();
    await page.getByRole("button", { name: "U16 Girls", exact: true }).first().click();
```

Run: `cd apps/web && npx playwright test board-v3.spec.ts -g "legend filters"`
Expected: PASS.

- [ ] **Step 7: E2E — single-division: no legend, no chip, at all (the original bug's own shape)**

Everything above runs against `board-v3.spec.ts`'s 5-division rig. The
screenshot that started this redesign was a SINGLE-division board — legend
absent entirely (`BoardLegend` returns `null` at `divisions.length <= 1`),
no division chip on cards (`showDivision = multi = false`). Add a new,
fully independent test to `apps/web/e2e/schedule-board.spec.ts` (which
already has an established single-division rig pattern — see its
`test.describe.serial("schedule board", ...)` block), as a standalone test
after the file's `"the publish gate offers a way through..."` test:

```tsx
// Board redesign (2026-08-10): a SINGLE-division board — no legend at all
// (BoardLegend returns null at divisions.length <= 1), no division chip on
// cards (multi = false) — is the exact scenario the redesign started from.
// Own rig, independent of the describe.serial block above.
test("single-division board: no legend, no division chip, Move panel still works at a real width", async ({
  page,
  request,
}) => {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Single division ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: "Solo",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  const divisionId = div.data!.id;
  await addEntrantsViaApi(request, divisionId, ["Ash", "Birch", "Cedar", "Dune"]);
  const out = await createStageAndGenerate(request, divisionId);
  await apiJson(request, `/api/v1/divisions/${divisionId}/schedule-settings`, "PUT", {
    tz: "UTC",
    config: {
      startAt: new Date(Date.UTC(2026, 9, 20, 9, 0)).toISOString(),
      matchMinutes: 30,
      gapMinutes: 0,
      courts: ["Court A"],
      perEntrantMinRest: 0,
    },
  });
  await apiJson(request, `/api/v1/fixtures/${out.fixtureIds[0]!}`, "PATCH", {
    scheduled_at: new Date(Date.UTC(2026, 9, 20, 9, 0)).toISOString(),
    court_label: "Court A",
  });

  await page.goto(await divisionPath(page.request, divisionId, "/schedule?tab=board"));
  await expect(page.getByText("Ash").first()).toBeVisible({ timeout: 20_000 });

  // No legend anywhere on a single-division board — neither instance.
  await expect(page.getByRole("group", { name: "Filter by division" })).toHaveCount(0);
  // No division chip on the card either (showDivision = multi = false).
  await expect(page.locator("[data-fixture-id] [data-division-chip]")).toHaveCount(0);
  // No raw pin/lock emoji.
  await expect(page.getByText("📌")).toHaveCount(0);
  await expect(page.getByText("🔒")).toHaveCount(0);

  // The Move panel bug this redesign fixes was reported on exactly this
  // single-division shape — confirm the When field renders at a real width.
  await page.locator("[data-fixture-id] button[aria-pressed]").first().click();
  const dialog = page.getByRole("dialog", { name: /^Move / });
  const dateInput = dialog.locator('input[type="date"]');
  await expect(dateInput).toBeVisible();
  const box = await dateInput.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(80);
});
```

Run: `cd apps/web && npx playwright test schedule-board.spec.ts -g "single-division board"`
Expected: PASS.

- [ ] **Step 8: Smoke — wire `boardRedesignSuite`'s call site**

Task 3 wrote the suite function itself but deferred its call site here,
since the legend only actually renders twice once THIS task lands. In
`scripts/smoke.ts`, right after the existing line
`await schedRegV3Suite(admin, renamed.slug, org2.id);` (around line 659),
add:

```ts
  await boardRedesignSuite(admin, renamed.slug);
```

Run: `npx tsx scripts/smoke.ts` (or this repo's usual smoke invocation) and
grep the output for `board redesign:` — expect 4 lines, all `PASS`.

- [ ] **Step 9: OpenAPI drift check**

```bash
npm run openapi:gen && git status --porcelain
```

Expected: no diff.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/components/v2/schedule-board.tsx apps/web/src/components/v2/__tests__/schedule-board-legend.test.tsx apps/web/e2e/board-v3.spec.ts apps/web/e2e/schedule-board.spec.ts scripts/smoke.ts
git commit -m "feat(board): pass blackouts into the grid, repeat the legend below it

Two independent asks folded into the same redesign pass: BoardGrid can now
highlight blackout windows (needs the board's own config.blackouts, which
schedule-board.tsx already held), and the division-filter legend no longer
disappears once the grid scrolls it off the top of a tall board."
```

---

### Task 5: Full regression + screenshot verification

**Files:** none (verification only).

- [ ] **Step 1: Run every touched/added test file together, JSON reporter**

```bash
cd apps/web && npx vitest run \
  src/components/v2/board/__tests__/move-panel.test.tsx \
  src/components/v2/board/__tests__/fixture-block.test.tsx \
  src/components/v2/board/__tests__/board-grid-blackout.test.tsx \
  src/components/v2/__tests__/schedule-board-legend.test.tsx \
  src/components/v2/__tests__/schedule-board-ghosts.test.tsx \
  src/components/v2/__tests__/schedule-board-grid-step.test.tsx \
  src/components/v2/__tests__/schedule-board-polish.test.tsx \
  src/components/v2/__tests__/schedule-board-day-tab.test.tsx \
  --reporter=json --outputFile=/tmp/board-redesign-full.json
```

Read `/tmp/board-redesign-full.json` — do not trust a bare pass/fail summary
printed to the terminal (this repo's `rtk` wrapper prints `PASS(0) FAIL(0)`
for a suite that failed to collect). Confirm `numFailedTests: 0` and that
`numTotalTests` is at least the sum of every test in the files above (so
nothing silently failed to collect). Cross-check every `.testResults[].name`
path actually resolves under `apps/web/src/components/v2/` — if the shell's
cwd drifted to a worktree's main checkout mid-session, these paths would
resolve on the wrong tree and still report green.

- [ ] **Step 1b: Run every E2E test this plan touched or added, then the smoke script**

```bash
cd apps/web && npx playwright test board-v3.spec.ts schedule-board.spec.ts
```

Expected: every test in both files PASSES — not just the ones this plan
added (Tasks 1-4's diffs to `board-v3.spec.ts` and `schedule-board.spec.ts`
modify shared setup/locators in a few places; a green run here is what
proves those edits didn't break a sibling test in the same file).

```bash
npx tsx scripts/smoke.ts 2>&1 | grep -E "board redesign:|sched board v3"
```

Expected: every matched line reads `PASS`.

- [ ] **Step 2: i18n parity**

```bash
npm run i18n:gen-keys && npm run i18n:check && git status --porcelain
```

`i18n:check` must report no errors. `git status --porcelain` should show
`apps/web/src/lib/i18n-keys.ts` modified (from Task 3) and nothing else
unexpected — if `i18n:gen-keys` produces further changes here beyond what
Task 3 already committed, that means a dictionary key was missed; fix and
re-run before continuing.

- [ ] **Step 3: Lint**

```bash
cd apps/web && rtk proxy npm run lint
```

Read for `✖ N problems` — `rtk`'s filtered summary hides ESLint output
entirely on this repo, so use `proxy` and read the raw output, not the
wrapped summary.

- [ ] **Step 4: Bring up a local environment and verify visually**

Follow the `seazn-local-env` skill (`~/.claude/skills/seazn-local-env/SKILL.md`)
to bring up a fresh DB + prod server on a fresh port — never `:3000`, never
the local dev DB. Sign in, create (or open) a competition with 2+ sibling
divisions (so the legend renders — it returns `null` at
`divisions.length <= 1`), at least one pair of fixtures scheduled close
enough to trigger a `warn.rest` conflict on both entrants (to see the merged
badge), and a blackout window configured on the Constraints panel's blackout
editor (court-specific or venue-wide — either exercises the highlight).
Separately, also open (or create) a competition with exactly ONE division —
the shape the original bug screenshot was — since the automated coverage
(Task 4, Step 7) checks it too and a human pass should confirm the same
thing renders as expected: no legend anywhere, no division chip on cards.

Using the browser tools, on the multi-division schedule board:

1. Screenshot at 1280px, 320px, and 768px. Confirm no horizontal page
   scroll at any width.
2. Confirm the legend renders both above the density/day toolbar row AND
   below the grid, with identical chips.
3. Pick a fixture and open the Move panel. Confirm the When field renders a
   real, readable date + time control (not a blank/collapsed box) at all
   three widths.
4. Confirm a fixture with two same-code conflicts (e.g. two `warn.rest`
   hits) shows exactly ONE "rest" badge, and that hovering it (desktop) or
   reading its `title` shows both entrants' detail text.
5. Confirm the blackout cell(s) show the hatched highlight, are still
   clickable once a fixture is picked (soft, not disabled), and that
   clicking one still places the fixture (matching today's server
   behavior — a `warn.blackout` badge appears on the placed card
   afterward, same as before this change).
6. Confirm the pin/lock glyphs render as real icons, not the raw
   📌/🔒 emoji.
7. On the SINGLE-division competition: confirm no legend renders anywhere
   (above or below the grid), no division chip appears on any card, and the
   Move panel's When field still renders at a real width there too.

If any of these fail, fix before considering this plan complete — this is
the verification step, not a formality; per project rule, a UI change isn't
done until it's been seen rendering for real.

## Self-Review

**Spec coverage** — every section of `docs/superpowers/specs/2026-08-10-board-view-redesign-design.md` maps to a task: the Move panel bug + restyle (Task 1), fixture cards / conflict badges / merged same-code conflicts / icons (Task 2), empty cells / headers / blackout (Task 3), legend duplication + blackout wiring (Task 4), testing + screenshot verification (Task 5). The spec's "out of scope" list (agenda/lanes, AI console, settings panel, conflicts panel) is restated in Global Constraints so no task drifts into it.

**Placeholder scan** — no TBD/TODO; every step carries the actual diff or the actual command, not a description of one.

**Type consistency** — `BoardGrid`'s new `blackouts?: BoardConfig["blackouts"]` (Task 3) is the exact type `schedule-board.tsx` already holds as `cfg.blackouts` (Task 4) and the exact shape `use-disruption-signals.ts` already consumes — no shape translation needed anywhere. `FixtureBlock`'s prop signature is untouched by Task 2, so Task 3's call site needs no changes beyond what's already written into its diff.

**Four test types, per RULES.md** — every task carries all four, or points
at exactly which sibling task's coverage subsumes it and why (never a bare
"N/A"): Task 1 (unit + E2E width measurement + smoke via Task 3's page-200
check + the failing-first unit test as regression), Task 2 (unit + E2E
extension of the existing rest-violation test + smoke via Task 3's no-emoji
check + regression), Task 3 (unit + new E2E blackout test + new
`boardRedesignSuite` smoke + regression), Task 4 (unit + E2E fix/addition
covering BOTH multi-division and single-division shapes + smoke call-site
wiring + regression). Single-division (no legend, no chip — the original
bug's own shape) and multi-division (legend, chips) are both exercised at
the unit level (every `fixture-block.test.tsx`/`board-grid-blackout.test.tsx`
case defaults `showDivision`/`multi` to `false`) and the E2E level (Task 4
Step 6 is multi-division, Step 7 is single-division).
