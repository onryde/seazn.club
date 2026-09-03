# Scheduling Walkthroughs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two fast walkthrough specs that drive an organiser's whole scheduling
day and the officials handoff by hand, plus the freeze guard, copy and testids
they need.

**Architecture:** Seven tasks in dependency order — a hand-driven pass first (Task 0), because a defect found on screen must be recorded as a finding rather than frozen into a spec as expected behaviour; then — the server guard and its copy
first (the walkthrough asserts them), then the testids the specs select on, then
the two specs, then a measured performance gate. Production changes are additive
only: one 422 guard, one disabled state, three dictionary keys, and testids.

**Tech Stack:** Next.js (see `node_modules/next/dist/docs/` before writing app
code), Playwright, vitest, postgres via `@/lib/db`, `@seazn/engine`.

**Spec:** `docs/superpowers/specs/2026-09-03-scheduling-walkthrough-design.md`

## Global Constraints

- **Worktree:** all work happens in `.claude/worktrees/sched-walkthrough` on
  branch `feat/scheduling-walkthrough`. Never check out in the main repo dir.
  A fresh worktree has NO `node_modules` — run `npm install` first.
- **Never `git stash` in a worktree.** The stash stack is shared with the main
  checkout; a no-op push followed by a pop lands a foreign stash and leaves
  `package.json` unmerged.
- **Every change ships a test that fails without it.** Four types per task:
  unit, E2E, smoke, regression.
- **Any new or changed user-facing string goes in all four locale
  dictionaries** — `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`. Keys are
  FLAT dotted strings (`"confirm.clearSlots.title"`), not nested objects.
  After adding an `en` key run `npm run i18n:gen-keys`; `apps/web/src/lib/
  i18n-keys.ts` is GENERATED and CI fails on drift.
- **Performance budget (owner constraint, 2026-09-03):** each spec must run in
  **≤ 90s** local warm, and the pair must not raise the `walkthrough` leg's
  wall clock. The leg's current tail is `scorepad-v3-tennis-mtb` at ~174s and
  it runs at `--workers=3`, so two ≤90s files slot underneath that tail and
  the leg stays flat. Task 6 MEASURES this; a spec over budget is not done.
- **No `page.waitForTimeout` anywhere.** Use `expect.poll` / web-first
  assertions. Express any timeout as a DERIVED cost, never a flat constant.
- **Verification traps that apply to every task:**
  - Judge vitest green only from `--reporter=json --outputFile`
    (`numPassedTests`/`numTotalTests`), never an `rtk` `PASS(0) FAIL(0)`
    summary — that is what a suite that failed to COLLECT looks like.
  - Run vitest as `cd apps/web && npx vitest`, never `--root apps/web`
    (loses 208 tests, invents 21 ENOENT failures).
  - Prefix `cd <abs worktree> &&` in the SAME call — shell cwd resets to the
    main checkout between calls, and a verify run then silently executes on
    `main` and returns a false green.
  - `grep` reports files here as `Binary file … matches`. Always `-a`.
  - Run whole Playwright spec files, never a `-g` slice.

---

### Task 0: Drive both journeys by hand, before a line of spec is written

Owner's ruling 2026-09-03: hand-drive first, then codify. This task exists so
that a defect found on screen is recorded as a finding rather than frozen into
a spec as expected behaviour. It writes no test code.

**Files:**
- Create: `docs/superpowers/specs/2026-09-03-scheduling-walkthrough-findings.md`

- [ ] **Step 1: Stand the environment up**

Follow the `seazn-local-env` skill (`~/.claude/skills/seazn-local-env/SKILL.md`
— machine-local, invoke with the Skill tool). Two traps it names that cost the
most here: `db:apply` alone is NOT a fresh schema (it needs `sync:sports`), and
a `pg_ctl` that fails with "Address already in use" is followed by a `createdb`
that SUCCEEDS against another session's server — confirm `show data_directory`
is yours.

Bring the **placement service** up as well. Without it the solve silently takes
the greedy path, which places differently; a hand-drive against greedy is not
the journey CI runs.

- [ ] **Step 2: Drive the organiser day**

Prod build, real browser. Every step of Task 4's journey, in order, at 1280.
Do not read code to decide whether something works — use it. A claim about what
a person SEES is settled only by driving the product.

Write down what you saw, never what must be true.

- [ ] **Step 3: Drive the officials handoff**

Every step of Task 5's journey, both people, in two browser profiles. Follow
the claim link by clicking it.

- [ ] **Step 4: Repeat both at 768 and 320**

At phone width compare the visible control SET — membership, order, repeat
count — against 1280, not box sizes. Six tabs of dense organiser tooling is
exactly where a groomed shrink hides. Equal sets at every width means escalate
to the design owner, not auto-fail.

Check the no-horizontal-scroll bar at each width, and remember that gate passes
happily on squashed and overlapping content — read what renders.

- [ ] **Step 5: Confirm or refute F1 live**

Freeze a division, then press Clear. Record exactly what happens: whether the
button is live, whether the board is wiped, and what the organiser is told.
F1 is confirmed in code but a read is not a run.

- [ ] **Step 6: Write the findings doc and STOP**

One section per finding: what a customer gains or loses, blast radius,
recommendation, and the strongest argument against it. Include screenshots.

Report back before starting Task 1 — findings may change what the later tasks
should assert, and that is the entire point of doing this first.

---

### Task 1: The clear-on-frozen guard

`clearScheduleScoped` is the only division write path that does not refuse a
frozen division. Four siblings do: `schedule.ts:2524` (apply), `:2901` (fixture
move), `schedule-ai.ts:912` (AI plan), `competition-schedule-apply.ts:419`
(joint apply). This task makes it five.

**Files:**
- Modify: `apps/web/src/server/usecases/history.ts:659-679`
- Test: `apps/web/src/server/usecases/__tests__/history.test.ts`

**Interfaces:**
- Consumes: `divisionLockState(tx, divisionId): Promise<{ frozen: boolean;
  scopes: LockedScope[] }>` from `apps/web/src/server/usecases/schedule.ts:531`.
- Produces: `clearScheduleScoped` throws `HttpError(422, "the division schedule
  is locked — unlock it to edit")` on a frozen division. Task 2's UI and Task 4's
  spec both depend on that exact status and message.

- [ ] **Step 1: Write the failing test**

Add to `apps/web/src/server/usecases/__tests__/history.test.ts`, inside the same
`describe` that holds the existing scoped-clear test. `setDivisionLocks` is
already imported at the top of that file.

```ts
it("scoped clear refuses a frozen division, and still clears an unfrozen one", async () => {
  const { auth } = await seedOrg();
  const { division, fixtures } = await seedDivision(auth, { kind: "group", pools: { count: 2 } });
  const { courtA } = await seedCourts(auth);
  for (let i = 0; i < fixtures.length; i++) {
    await patchFixture(auth, fixtures[i]!.id, { scheduled_at: at(9 + i), court_id: courtA });
  }

  // The unfrozen control case runs FIRST, so a guard that refuses everything
  // cannot pass this test by refusing both halves.
  const before = await clearScheduleScoped(auth, {
    division_id: division.id,
    scope: { excludeLocked: true },
    confirm: true,
  });
  expect(before.cleared).toBeGreaterThan(0);
  await undoDivision(auth, division.id);

  await setDivisionLocks(auth, division.id, { schedule_locked: true });

  await expect(
    clearScheduleScoped(auth, {
      division_id: division.id,
      scope: { excludeLocked: true },
      confirm: true,
    }),
  ).rejects.toMatchObject({ status: 422 });

  // The refusal must not have wiped anything on its way out.
  const [after] = await sql<{ scheduled: number }[]>`
    select count(*) filter (where scheduled_at is not null)::int as scheduled
    from fixtures where division_id = ${division.id}`;
  expect(after!.scheduled).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/sched-walkthrough/apps/web && \
  npx vitest run src/server/usecases/__tests__/history.test.ts \
  --reporter=json --outputFile=/tmp/t1.json; echo "EXIT=$?"
```

Expected: FAIL. The `rejects.toMatchObject({ status: 422 })` assertion fails
because the clear succeeds. Confirm from the JSON, not the summary: read
`numFailedTests` and confirm `.testResults[].name` resolves inside the
WORKTREE, not the main checkout.

Requires `DATABASE_URL` — the file skips without it, and a skipped test looks
exactly like a passing one. Confirm `numTotalTests` counted your test.

- [ ] **Step 3: Add the guard**

In `apps/web/src/server/usecases/history.ts`, add `divisionLockState` to the
existing import from `./schedule` (the file already imports
`generateStageFixtures` from `./stages`; add a sibling import line if there is
no `./schedule` import yet):

```ts
import { divisionLockState } from "./schedule";
```

Then inside `clearScheduleScoped`, immediately after the existence check and
before `clearableFixtures`:

```ts
    const [division] = await tx`select 1 from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    // The freeze applies to every division write path — apply
    // (schedule.ts:2524), fixture move (:2901), AI plan (schedule-ai.ts:912)
    // and joint apply (competition-schedule-apply.ts:419) all refuse on these
    // exact terms. Clear was the one that did not, so a frozen board could be
    // wiped by the one control whose whole point is that it is destructive.
    const lockState = await divisionLockState(tx, divisionId);
    if (lockState.frozen) {
      throw new HttpError(422, "the division schedule is locked — unlock it to edit");
    }
    const fixtures = await clearableFixtures(tx, divisionId);
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/sched-walkthrough/apps/web && \
  npx vitest run src/server/usecases/__tests__/history.test.ts \
  --reporter=json --outputFile=/tmp/t1.json; echo "EXIT=$?"
```

Expected: PASS. Read `numPassedTests` and `numFailedTests` from the JSON.

- [ ] **Step 5: Prove the test can fail (mutation)**

Comment out the two guard lines, re-run, confirm RED, restore. A guard nothing
kills is not tested. Paste both counts into the task report.

- [ ] **Step 6: Add the smoke assertion**

In `scripts/smoke.ts`, find the scheduling section and add a check that
freezes a division, POSTs `/api/v1/schedule/clear`, and asserts 422. Follow the
surrounding assertion style in that file exactly — read its neighbours first.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/server/usecases/history.ts \
        apps/web/src/server/usecases/__tests__/history.test.ts \
        scripts/smoke.ts
git commit -m "fix(schedule): scoped clear refuses a frozen division

clearScheduleScoped took the division lock, checked the division existed and
never asked whether the schedule was frozen — so the one control whose whole
purpose is to be destructive was the one path a freeze did not stop. The four
sibling write paths all refuse on these terms; this makes it five."
```

---

### Task 2: The Danger zone tells the truth, in four languages

Two defects in one card. `history-panel.tsx:440-468` ships three hardcoded
English strings, and its only render gate is `canEdit` — so on a frozen
division the button is live and the organiser learns about the freeze from a
422.

**Files:**
- Modify: `apps/web/src/components/v2/history-panel.tsx:438-470`
- Modify: `apps/web/src/dictionaries/en/ui.json`, `.../es/ui.json`,
  `.../fr/ui.json`, `.../nl/ui.json`
- Modify (generated): `apps/web/src/lib/i18n-keys.ts` — via `npm run i18n:gen-keys`, never by hand
- Test: `apps/web/src/components/v2/__tests__/history-panel-danger-zone.test.tsx` (create)

**Interfaces:**
- Consumes: Task 1's 422. `HistoryPanel` already receives what it needs to know
  the division is frozen — if it does not, read `schedule/page.tsx:421` and
  thread the existing `scheduleLocked` value down as a prop rather than
  fetching it again.
- Produces: `data-testid="schedule-clear"` (the button) and
  `data-testid="schedule-clear-reason"` (the frozen note). Task 4 selects both.

- [ ] **Step 1: Add the four dictionary keys to `en`**

Keys are flat dotted strings. Add to `apps/web/src/dictionaries/en/ui.json`:

```json
  "history.danger.title": "Danger zone",
  "history.danger.body": "Clears timetable slots only — locked and decided fixtures always survive, and the action is undoable above.",
  "history.danger.clear": "Clear schedule…",
  "history.danger.frozen": "The schedule is frozen. Unfreeze it on the board to clear slots."
```

- [ ] **Step 2: Add the same four keys to `es`, `fr` and `nl`**

Translate; do not copy the English. Match the register of the neighbouring
`confirm.clearSlots.*` keys already present in each file.

- [ ] **Step 3: Regenerate the key union**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/sched-walkthrough && \
  npm run i18n:gen-keys && git diff --stat apps/web/src/lib/i18n-keys.ts
```

Expected: `i18n-keys.ts: N keys.` and a non-empty diff adding four keys. CI
fails on drift, so a missing regen is a red build.

- [ ] **Step 4: Write the failing test**

Create `apps/web/src/components/v2/__tests__/history-panel-danger-zone.test.tsx`.
Follow the render harness used by the sibling tests in that directory — read
`constraints-panel-commit-semantics.test.tsx` first for the established pattern.

```tsx
it("disables the clear button and says why when the division is frozen", () => {
  renderPanel({ canEdit: true, scheduleLocked: true });
  expect(screen.getByTestId("schedule-clear")).toBeDisabled();
  expect(screen.getByTestId("schedule-clear-reason")).toHaveTextContent(/frozen/i);
});

it("leaves the clear button live when the division is not frozen", () => {
  renderPanel({ canEdit: true, scheduleLocked: false });
  expect(screen.getByTestId("schedule-clear")).toBeEnabled();
  expect(screen.queryByTestId("schedule-clear-reason")).toBeNull();
});

it("renders no English literal for the danger zone", () => {
  renderPanel({ canEdit: true, scheduleLocked: false });
  // The card must read from the dictionary. A literal survives a locale switch
  // and this is the assertion that catches it.
  expect(screen.getByTestId("schedule-clear")).toHaveTextContent(
    dictionaries.en["history.danger.clear"],
  );
});
```

- [ ] **Step 5: Run it and verify it fails**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/sched-walkthrough/apps/web && \
  npx vitest run src/components/v2/__tests__/history-panel-danger-zone.test.tsx \
  --reporter=json --outputFile=/tmp/t2.json; echo "EXIT=$?"
```

Expected: FAIL — no `schedule-clear` testid exists yet.

- [ ] **Step 6: Rewrite the danger zone**

Replace `history-panel.tsx:438-470`. Note `apps/web` vitest is
`environment: "node"` for most suites — this component test needs the jsdom
harness the sibling tests use; if that harness does not exist, the disabled
state is proven by Task 4's e2e instead and this test asserts markup only.

```tsx
      {canEdit && (
        <div className="card border-red-100 p-4">
          <h3 className="text-sm font-semibold text-red-700">{msg("history.danger.title")}</h3>
          <p className="mt-1 text-xs text-slate-500">{msg("history.danger.body")}</p>
          {scheduleLocked && (
            <p className="mt-1 text-xs text-slate-500" data-testid="schedule-clear-reason">
              {msg("history.danger.frozen")}
            </p>
          )}
          <button
            type="button"
            data-testid="schedule-clear"
            className="btn btn-danger mt-2"
            disabled={busy || scheduleLocked}
            onClick={async () => {
              const ok = await confirmDialog({
                title: msg("confirm.clearSlots.title"),
                body: msg("confirm.clearSlots.body"),
                confirmLabel: msg("confirm.clearSlots.label"),
                tone: "danger",
              });
              if (!ok) return;
              void run(() =>
                apiV1("/api/v1/schedule/clear", {
                  method: "POST",
                  json: { division_id: divisionId, scope: { excludeLocked: true }, confirm: true },
                }),
              );
            }}
          >
            {msg("history.danger.clear")}
          </button>
        </div>
      )}
```

Keep the existing `btn-danger` comment block — it records why the class is not
hand-rolled, and deleting it re-opens a fixed defect.

- [ ] **Step 7: Run the test and verify it passes**

Same command as Step 5. Expected: PASS.

- [ ] **Step 8: Mutate BOTH guards, one at a time**

Two guards now cover the clear path: the server 422 (Task 1) and this disabled
state. They cover for each other, so each is untested unless mutated alone.

1. Set `disabled={busy}` — the component test must go red, Task 1's unit test
   must stay green.
2. Restore, then comment out Task 1's guard — the unit test must go red, the
   component test must stay green.

Paste both results.

- [ ] **Step 9: Check locale parity**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/sched-walkthrough && \
  npm run i18n:check 2>&1 | tail -20
```

Expected: no missing-key report for the four new keys in any of es/fr/nl.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/components/v2/history-panel.tsx \
        apps/web/src/components/v2/__tests__/history-panel-danger-zone.test.tsx \
        apps/web/src/dictionaries apps/web/src/lib/i18n-keys.ts
git commit -m "fix(history): the danger zone speaks four languages and respects the freeze

The card shipped three hardcoded English literals next to a confirm dialog that
correctly read the dictionary, and gated only on canEdit — so a frozen division
offered a live Clear button and explained itself with a 422. Disabled with a
reason, because a vanished control reads as a missing feature."
```

---

### Task 3: Testids for the five panels that have none

`constraints-panel.tsx`, `board/settings-panel.tsx`,
`shared/court-multi-picker.tsx` and `officials-panel.tsx` carry **zero**
`data-testid` attributes between them; `history-panel.tsx` has exactly one.
Tasks 4 and 5 would otherwise select on translated button text, which reds on a
copy change and breaks under any non-`en` locale.

**Files:**
- Modify: `apps/web/src/components/v2/shared/court-multi-picker.tsx`
- Modify: `apps/web/src/components/v2/board/settings-panel.tsx`
- Modify: `apps/web/src/components/v2/constraints-panel.tsx` (constraint rows
  ~`:588`, blackout editor `:822-940`, wait report `:1008-1021`)
- Modify: `apps/web/src/components/v2/history-panel.tsx` (save point `:257-260`,
  restore `:394`)
- Modify: `apps/web/src/components/v2/officials-panel.tsx` (propose `:308`,
  apply `:333`, assign select `:531`, unavailable note `:502`)
- Modify: `apps/web/src/components/me/officiating-lane.tsx` (blackout editor
  `:83`, accept `:189`)
- Test: `apps/web/src/components/v2/__tests__/scheduling-testid-contract.test.tsx` (create)

**Interfaces:**
- Produces: the testid vocabulary Tasks 4 and 5 select on. Exact strings, no
  variation:

| testid | control |
|---|---|
| `court-picker` | the multi-picker container |
| `court-option` | each court toggle, plus `data-court-id={id}` |
| `settings-match-minutes` | match length input |
| `settings-gap-minutes` | gap input |
| `settings-day-start` / `settings-day-end` | play-hours inputs |
| `constraint-min-rest` | min-rest input |
| `constraint-max-per-day` | max-fixtures-per-day input |
| `blackout-editor` | the editor container |
| `blackout-add` | add-window button |
| `blackout-from` / `blackout-to` | window bounds |
| `blackout-court` | the court selector (absent = venue-wide) |
| `blackout-row` | each saved window |
| `wait-report-check` | the run-check button |
| `wait-report-result` | its result region |
| `savepoint-label` / `savepoint-create` | save-point input and button |
| `checkpoint-row` | each save point, plus `data-checkpoint-id={id}` |
| `checkpoint-restore` | that row's restore button |
| `officials-propose` / `officials-apply` | propose and apply |
| `officials-assign-select` | the per-fixture select, plus `data-fixture-id` |
| `officials-unavailable-note` | the blackout collision note |
| `official-blackout-date` / `official-blackout-add` | `/me` blackout editor |
| `me-official-accept` / `me-official-decline` | `/me` response buttons |

- [ ] **Step 1: Write the failing contract test**

Create `apps/web/src/components/v2/__tests__/scheduling-testid-contract.test.tsx`.
This is a source-scan test, not a render test — `apps/web` vitest is
`environment: "node"` and cannot see the DOM. It asserts the literal is present
in the source of the file that owns it, which is exactly enough to catch a
rename.

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const OWNED: Record<string, string[]> = {
  "src/components/v2/shared/court-multi-picker.tsx": ["court-picker", "court-option"],
  "src/components/v2/board/settings-panel.tsx": [
    "settings-match-minutes", "settings-gap-minutes", "settings-day-start", "settings-day-end",
  ],
  "src/components/v2/constraints-panel.tsx": [
    "constraint-min-rest", "constraint-max-per-day", "blackout-editor", "blackout-add",
    "blackout-from", "blackout-to", "blackout-court", "blackout-row",
    "wait-report-check", "wait-report-result",
  ],
  "src/components/v2/history-panel.tsx": [
    "savepoint-label", "savepoint-create", "checkpoint-row", "checkpoint-restore",
    "schedule-clear", "schedule-clear-reason",
  ],
  "src/components/v2/officials-panel.tsx": [
    "officials-propose", "officials-apply", "officials-assign-select",
    "officials-unavailable-note",
  ],
  "src/components/me/officiating-lane.tsx": [
    "official-blackout-date", "official-blackout-add",
    "me-official-accept", "me-official-decline",
  ],
};

describe("scheduling testid contract", () => {
  for (const [file, ids] of Object.entries(OWNED)) {
    it(`${file} owns its testids`, () => {
      const src = readFileSync(new URL(`../../../../${file}`, import.meta.url), "utf8");
      for (const id of ids) {
        expect(src, `${file} is missing data-testid="${id}"`).toContain(`data-testid="${id}"`);
      }
    });
  }
});
```

Resolve the relative URL against this test file's real location before running —
if the depth is wrong every case fails identically for the wrong reason.

- [ ] **Step 2: Run it and verify it fails**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/sched-walkthrough/apps/web && \
  npx vitest run src/components/v2/__tests__/scheduling-testid-contract.test.tsx \
  --reporter=json --outputFile=/tmp/t3.json; echo "EXIT=$?"
```

Expected: FAIL on all six files. Read the failure MESSAGES — they must name
missing testids, not a file-not-found.

- [ ] **Step 3: Add the attributes**

Purely additive. Do not rename an existing attribute, do not change a class, do
not restructure JSX. Where a control already has an `aria-label`, keep it — the
testid is additional, and the aria-label is what a screen reader uses.

`court-option` and `checkpoint-row` and `officials-assign-select` repeat per
item, so each also carries the `data-*` identity column named in the table
above; a repeated testid with no identity cannot be targeted.

- [ ] **Step 4: Run it and verify it passes**

Same command as Step 2. Expected: PASS, 6 tests.

- [ ] **Step 5: Confirm nothing else broke**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/sched-walkthrough/apps/web && \
  npx vitest run --reporter=json --outputFile=/tmp/t3-full.json; echo "EXIT=$?"
```

Read `numFailedTests` and `numTotalTests` from the JSON. A drop in
`numTotalTests` against the pre-task count means a suite failed to COLLECT —
that reads as green in every summary and is not.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components apps/web/src/components/me
git commit -m "test(scheduling): give the five scheduling panels the testids they lacked

constraints, settings, the court picker and the officials panel carried zero
data-testid between them, so every e2e reaching them selected on translated
button text. Additive attributes only."
```

---

### Task 4: `scheduling-organiser-day.spec.ts`

One division, one continuous journey, thirteen tapped steps. **Budget: ≤ 90s
local warm.**

**Files:**
- Create: `apps/web/e2e/walkthrough/scheduling-organiser-day.spec.ts`

**Interfaces:**
- Consumes: Task 3's testids; Task 1's 422; Task 2's `schedule-clear` /
  `schedule-clear-reason`. From `apps/web/e2e/helpers.ts`:
  `apiJson(request, path, method?, body?)`,
  `divisionPath(request, divisionId, tail?)`,
  `seedVenueWithCourts(request, names?, opts?) → { venueId, courts }`,
  `addEntrantsViaApi(request, divisionId, names, kind?, seedOffset?)`,
  `createStageAndGenerate(request, divisionId, stage?) → { stageId, fixtureIds }`,
  `screenshotAtWidths(page, testInfo, name, widths?)`,
  `expectNoHorizontalScroll(page, opts?)`, `TAG`.
- Existing board testids: `schedule-auto`, `schedule-result-strip`,
  `schedule-result-provenance`, `board-freeze`, `board-publish-schedule`,
  `board-start-division`. Court tags come from `division-settings.tsx:628`
  (`PATCH /divisions/{id}`), NOT `stage-court-tags` — that surface is being
  rewritten by the concurrent competition-desk W2 wave.

- [ ] **Step 1: Write the spec, setup first**

Keep the journey small on purpose — the budget is the design constraint, not an
afterthought. **Four entrants in a league is six fixtures**, which is enough to
exercise rest and per-day caps and small enough to solve fast. Two courts across
two venues exercises venue-qualified naming without adding solve time.

```ts
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import {
  TAG, apiJson, addEntrantsViaApi, createStageAndGenerate, divisionPath,
  seedVenueWithCourts, screenshotAtWidths, expectNoHorizontalScroll,
} from "../helpers";

// The organiser's scheduling day, tapped end to end. Setup reaches the state
// through the API; every step below that IS the thing under test is tapped.
test.describe.configure({ mode: "serial" });

// Budget: 13 tapped steps, no deliberate waits, a 6-fixture solve. Derived, so
// that adding a step moves the budget with it rather than leaving a flat
// constant to red under it.
const STEPS = 13;
const PER_STEP_MS = 6_000;
const SOLVE_MS = 30_000;
test.setTimeout(STEPS * PER_STEP_MS + SOLVE_MS);

async function goTab(page: Page, base: string, tab: string): Promise<void> {
  await page.goto(`${base}?tab=${tab}`);
  await expect(page.getByRole("main")).toBeVisible();
}

// The division's stored scheduling config — the record every constraints and
// settings assertion reads back. One GET, no caching: the panel writes
// read-modify-write, so a stale copy would hide exactly the races this sweeps.
async function readConfig(
  request: APIRequestContext,
  divisionId: string,
): Promise<Record<string, any>> {
  const { data } = await apiJson<{ config: Record<string, any> }>(
    request,
    `/api/v1/divisions/${divisionId}/schedule-settings`,
  );
  return data?.config ?? {};
}

// The system's own record of the board, ordered so `toEqual` is meaningful.
// Restore must return every slot to the same time AND the same court, so the
// shape carries both — a count-only read cannot see a court swap.
type Slot = { id: string; at: string; court: string | null };
async function scheduledSlots(
  request: APIRequestContext,
  divisionId: string,
): Promise<Slot[]> {
  const { data } = await apiJson<{ id: string; scheduled_at: string | null; court_id: string | null }[]>(
    request,
    `/api/v1/divisions/${divisionId}/fixtures`,
  );
  return (data ?? [])
    .filter((f) => f.scheduled_at !== null)
    .map((f) => ({ id: f.id, at: f.scheduled_at!, court: f.court_id }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
```

Confirm `GET /api/v1/divisions/{id}/fixtures` is the real route and returns
those field names before relying on it — if it does not, read the route that
`stages-panel.tsx` itself calls and use that. A helper built on a guessed
route fails identically to a broken product.

Seed in a `beforeAll`: create the competition and division through the API,
four entrants, two venues with one court each, then `createStageAndGenerate`.
Resolve `base = await divisionPath(request, divisionId, "/schedule")` once and
reuse it — `divisionPath` is two localhost GETs and is deliberately not cached,
so calling it per step is pure waste.

- [ ] **Step 2: Write steps 1-6 — settings, tags, constraints, blackout, wait, precheck**

Each step taps, then reads the system's own record back. The record read is
what makes it a walkthrough rather than a screenshot.

```ts
test("the organiser sets up, schedules, saves, clears, restores, freezes and publishes", async ({
  page, request,
}, testInfo) => {
  // 1 — required courts and the clock
  await goTab(page, base, "settings");
  await page.getByTestId("court-option").first().click();
  await page.getByTestId("settings-match-minutes").fill("45");
  await page.getByTestId("settings-gap-minutes").fill("15");
  // TRAP (found reviewing Task 3): `settings-day-start` / `settings-day-end`
  // live in the ELSE branch of `customWindows ? <p> : …`
  // (`board/settings-panel.tsx:539`). A division whose stored sessionWindows
  // are non-uniform renders a read-only "custom windows" paragraph and NEITHER
  // field. The seed must therefore leave sessionWindows uniform or empty, or
  // these two fills throw on an element that correctly does not exist.
  await expect(page.getByTestId("settings-day-start")).toBeAttached();
  await page.getByRole("button", { name: /save/i }).click();
  await expect.poll(async () => {
    const { data } = await apiJson<{ config: { matchMinutes: number } }>(
      request, `/api/v1/divisions/${divisionId}/schedule-settings`);
    return data?.config.matchMinutes;
  }).toBe(45);

  // 3 — the constraint matrix, swept as a TABLE. Enumerated from the panel on
  // 2026-09-03; do not substitute the engine's constraint vocabulary here.
  // Only `max_fixtures_per_day` has a UI writer at all — `rest-min` writes
  // `constraints.restMin`, which is NOT a hard[] rule — so asserting
  // `hard[].type === "min_rest_minutes"` after a UI edit can never pass.
  //
  // The dimension worth sweeping is COMMIT SEMANTICS, which differ per control
  // type and which a fill-everything-then-Save pass sails straight past.
  await goTab(page, base, "constraints");

  // 3a — what each control OPENS AT. A reachability assertion is satisfied by
  // any value; these defaults are what a regression actually moves.
  await expect(page.getByTestId("constraint-min-rest")).toHaveValue("0");
  await expect(page.getByTestId("constraint-max-per-day")).toHaveValue("");
  await expect(page.getByTestId("constraint-field-fairness")).toHaveValue("off");
  await expect(page.getByTestId("constraint-cross-person-clash")).not.toBeChecked();
  await expect(page.getByTestId("constraint-no-back-to-back")).not.toBeChecked();

  // 3b — checkboxes and selects commit INSTANTLY on change, no blur.
  await page.getByTestId("constraint-cross-person-clash").check();
  await expect.poll(() => readConfig(request, divisionId)
    .then((c) => c.constraints?.crossPersonClash)).toBe("hard");
  await page.getByTestId("constraint-no-back-to-back").check();
  await expect.poll(() => readConfig(request, divisionId)
    .then((c) => c.constraints?.noBackToBack)).toBe(true);
  await page.getByTestId("constraint-field-fairness").selectOption("rotate");
  await expect.poll(() => readConfig(request, divisionId)
    .then((c) => c.constraints?.fieldFairness)).toBe("rotate");

  // 3c — number fields are draft-then-commit. THIS is the differential case:
  // typing alone must issue ZERO writes. A test that fills and immediately
  // polls would pass on a panel that committed on every keystroke, which is
  // the regression `constraints-panel-commit-semantics` exists to prevent.
  const beforeTyping = await readConfig(request, divisionId);
  await page.getByTestId("constraint-min-rest").fill("60");
  expect(await readConfig(request, divisionId)).toEqual(beforeTyping);
  await page.getByTestId("constraint-min-rest").blur();
  await expect.poll(() => readConfig(request, divisionId)
    .then((c) => c.constraints?.restMin)).toBe(60);

  // 3d — the one hard[] rule an organiser can actually express, committed with
  // Enter rather than blur, and carrying the division scope the panel hard-codes.
  await page.getByTestId("constraint-max-per-day").fill("2");
  await page.getByTestId("constraint-max-per-day").press("Enter");
  await expect.poll(async () => {
    const c = await readConfig(request, divisionId);
    const rule = c.hard?.find((h) => h.type === "max_fixtures_per_day");
    return rule ? [rule.count, rule.scope?.kind] : null;
  }).toEqual([2, "division"]);

  // 3e — the inverse direction. Clearing the field DELETES the rule; a guard
  // checked in one direction only is half tested.
  await page.getByTestId("constraint-max-per-day").fill("");
  await page.getByTestId("constraint-max-per-day").press("Enter");
  await expect.poll(async () => {
    const c = await readConfig(request, divisionId);
    return c.hard?.some((h) => h.type === "max_fixtures_per_day") ?? false;
  }).toBe(false);
  // Put it back — later steps schedule against it.
  await page.getByTestId("constraint-max-per-day").fill("2");
  await page.getByTestId("constraint-max-per-day").press("Enter");

  // 4 — a blackout created THROUGH THE UI. Nothing has ever done this.
  // Scope is a FLAT court list plus "" meaning everywhere (division-wide).
  // There is no venue-wide option — "all courts at venue X" is not expressible,
  // so do not write an assertion that assumes one.
  // Blackouts are all-or-nothing behind ONE Save, refused while any row is
  // invalid, and `to <= from` is refused with `errorOrder`.
  await page.getByTestId("blackout-add").click();
  await page.getByTestId("blackout-from").fill(BLACKOUT_FROM);
  await page.getByTestId("blackout-to").fill(BLACKOUT_TO);
  await expect(page.getByTestId("blackout-court")).toHaveValue(""); // opens at everywhere
  await page.getByTestId("blackout-save").click();
  await expect(page.getByTestId("blackout-row")).toHaveCount(1);
  await expect.poll(() => readConfig(request, divisionId)
    .then((c) => c.blackouts?.length ?? 0)).toBe(1);

  // 5 — the wait report names the entrant it claims, not just "a report ran".
  await page.getByTestId("wait-report-check").click();
  await expect(page.getByTestId("wait-report-result")).toBeVisible();
});
```

Derive every expected value from what was just entered, never from a constant
typed into the test — a change to the source of truth must move the test with
it.

- [ ] **Step 3: Write steps 7-10 — solve, save point, clear, restore**

```ts
  // 7 — solve. Assert what holds for BOTH producers: with the placement
  // service down this takes the greedy path and lands a different board, so
  // assert the blackout is respected and a provenance is reported, never a
  // specific arrangement. And config.startAt is NOT the solver's floor — a
  // CP-SAT board legitimately places earlier. Do not assert otherwise.
  await goTab(page, base, "board");
  await page.getByTestId("schedule-auto").click();
  await expect(page.getByTestId("schedule-result-strip")).toBeVisible({ timeout: SOLVE_MS });
  await expect(page.getByTestId("schedule-result-provenance")).not.toBeEmpty();

  const placed = await scheduledSlots(request, divisionId);
  expect(placed.length).toBeGreaterThan(0);
  for (const slot of placed) {
    expect(
      slot.at >= BLACKOUT_FROM && slot.at < BLACKOUT_TO,
      `fixture placed inside the blackout window: ${slot.at}`,
    ).toBe(false);
  }

  // 8 — save point
  await goTab(page, base, "history");
  await page.getByTestId("savepoint-label").fill(`before-clear ${TAG}`);
  await page.getByTestId("savepoint-create").click();
  await expect(page.getByTestId("checkpoint-row")).toHaveCount(1);

  // 9 — clear, and 10 — restore to exactly what step 7 produced
  await page.getByTestId("schedule-clear").click();
  await page.getByRole("button", { name: /clear slots/i }).click();
  await expect.poll(async () => (await scheduledSlots(request, divisionId)).length).toBe(0);

  await page.getByTestId("checkpoint-restore").first().click();
  await expect.poll(async () => (await scheduledSlots(request, divisionId)).length)
    .toBe(placed.length);
  expect(await scheduledSlots(request, divisionId)).toEqual(placed);
```

The final `toEqual(placed)` is the assertion that matters: restore must return
every slot to the same time AND the same court, not merely the same count.

- [ ] **Step 4: Write steps 11-13 — freeze, the refusal, publish**

The freeze gate is asserted in TWO halves. A disabled button proves only that
this client declines to ask; it passes against a server that still wipes the
board.

```ts
  // 11 — freeze
  await goTab(page, base, "board");
  await page.getByTestId("board-freeze").click();

  // 12a — the UI half: the control is present, disabled, and says why.
  await goTab(page, base, "history");
  await expect(page.getByTestId("schedule-clear")).toBeDisabled();
  await expect(page.getByTestId("schedule-clear-reason")).toBeVisible();

  // 12b — the API half. Without this the test passes against a server that
  // still clears a frozen board.
  const refused = await apiJson(request, "/api/v1/schedule/clear", "POST", {
    division_id: divisionId, scope: { excludeLocked: true }, confirm: true,
  });
  expect(refused.status, `clear on a frozen division returned ${refused.status}`).toBe(422);
  expect(await scheduledSlots(request, divisionId)).toEqual(placed);

  // 13 — publish, then start. Run to the terminal state.
  await goTab(page, base, "board");
  await page.getByTestId("board-publish-schedule").click();
  await expect(page.getByTestId("board-start-division")).toBeVisible();

  await screenshotAtWidths(page, testInfo, "organiser-day-final", [1280, 768, 320]);
  await expectNoHorizontalScroll(page);
```

- [ ] **Step 5: Run it and record the wall clock**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/sched-walkthrough/apps/web && \
  time npx playwright test --project=walkthrough \
  e2e/walkthrough/scheduling-organiser-day.spec.ts --reporter=list; echo "EXIT=$?"
```

Needs a prod build and `E2E_PROD_TARGET` — follow the `seazn-local-env` skill,
and bring the placement service up so the solve takes the CP-SAT path CI takes.

Expected: PASS, and **under 90s**. If it is over, cut fixture count before you
cut assertions.

- [ ] **Step 6: Prove it can fail**

Revert Task 1's guard, re-run, confirm step 12b goes red. Restore. Then break
the blackout assertion's window and confirm step 7 reds. A spec that passes on
its first run deserves the least trust.

- [ ] **Step 7: Commit**

```bash
git add apps/web/e2e/walkthrough/scheduling-organiser-day.spec.ts
git commit -m "test(walkthrough): the organiser's scheduling day, tapped end to end

Thirteen steps from required courts to a started division, including the two
surfaces nothing had ever tapped — a blackout created in the UI and the stage's
required court tags — and the freeze refusal asserted at both layers."
```

---

### Task 5: `scheduling-officials-handoff.spec.ts`

The two-person seam: a link one person sends another, and an assignment that
has to survive the recipient's own calendar. **Budget: ≤ 90s local warm.**

**Files:**
- Create: `apps/web/e2e/walkthrough/scheduling-officials-handoff.spec.ts`

**Interfaces:**
- Consumes: Task 3's officials and `/me` testids. API shape from scouting:
  `POST /api/v1/officials` (create), `POST /api/v1/officials/{id}/invite`,
  `POST /api/v1/divisions/{id}/officials/auto` (propose),
  `POST /api/v1/divisions/{id}/officials/apply` (assign),
  `PATCH /api/v1/fixtures/{id}/officials` (manual),
  `GET|POST|DELETE /api/v1/officials/{id}/availability` (blackout),
  `PATCH /api/v1/me/assigned-fixtures/{id}/response` (accept/decline).
  Tables: `officials`, `fixture_officials` (PK `fixture_id, role_key,
  official_id`; `response`, `responded_at`, `decline_reason`),
  `official_availability` (unique `official_id, date`, status fixed at
  `unavailable`).

- [ ] **Step 1: Set up two browser contexts**

The organiser uses the suite's shared `storageState`. The official is a
different person and must NOT inherit it — **a bare `browser.newContext()`
inherits the signed-in state** in this repo, so pass `storageState: undefined`
explicitly or the "official" is silently the organiser and the whole handoff is
fictional.

```ts
const officialCtx = await browser.newContext({ storageState: undefined });
const officialPage = await officialCtx.newPage();
```

Close both in `afterAll`.

- [ ] **Step 2: Invite, and follow the link from the page that emits it**

```ts
  // Invite through the directory UI.
  await page.goto(directoryPath);
  await page.getByRole("button", { name: /add|invite/i }).click();
  await page.getByLabel(/name/i).fill(`Official ${TAG}`);
  await page.getByLabel(/email/i).fill(officialEmail);
  await page.getByRole("button", { name: /save|invite/i }).click();

  // Read the claim link OFF THE PAGE. Constructing it is how a dead link stays
  // green — the whole point of this step is that the link resolves.
  const claimUrl = await page.getByRole("link", { name: /claim|invite/i })
    .first().getAttribute("href");
  expect(claimUrl, "the directory emitted no claim link").toBeTruthy();
  await officialPage.goto(claimUrl!);
```

- [ ] **Step 3: The official blacks out a day, from their own screen**

```ts
  await officialPage.goto("/me");
  await officialPage.getByTestId("official-blackout-date").fill(BLACKOUT_DATE);
  await officialPage.getByTestId("official-blackout-add").click();
  await expect.poll(async () => {
    const { data } = await apiJson<{ date: string }[]>(
      request, `/api/v1/officials/${officialId}/availability`);
    return data?.map((r) => r.date) ?? [];
  }).toContain(BLACKOUT_DATE);
```

This is the first assertion anywhere on the G9 read-back route from a browser.

- [ ] **Step 4: Propose, then assign by actually choosing**

```ts
  await goTab(page, base, "officials");
  await page.getByTestId("officials-propose").click();
  await expect(page.getByTestId("officials-apply")).toBeEnabled();
  await page.getByTestId("officials-apply").click();

  // The manual assign. Pin what the control OPENS AT and what was chosen —
  // reachability is satisfied by any value, and every existing test stops at
  // "the select is visible".
  const select = page.getByTestId("officials-assign-select").first();
  const fixtureId = await select.getAttribute("data-fixture-id");
  await expect(select).toHaveValue("");           // opens unassigned
  await select.selectOption({ label: `Official ${TAG}` });

  await expect.poll(async () => {
    const { data } = await apiJson<{ official_id: string }[]>(
      request, `/api/v1/fixtures/${fixtureId}/officials`);
    return data?.map((r) => r.official_id) ?? [];
  }).toContain(officialId);
```

- [ ] **Step 5: The official accepts, and the blackout collision is surfaced**

```ts
  await officialPage.goto("/me");
  await officialPage.getByTestId("me-official-accept").first().click();
  await expect.poll(async () => {
    const { data } = await apiJson<{ official_id: string; response: string | null }[]>(
      request, `/api/v1/fixtures/${fixtureId}/officials`);
    return data?.find((r) => r.official_id === officialId)?.response;
  }).toBe("accepted");

  // Now assign the same person on the day they blacked out. The product must
  // say so rather than accept silently.
  await page.goto(`${base}?tab=officials`);
  await assignOnBlackoutDay(page, officialId);
  await expect(page.getByTestId("officials-unavailable-note")).toBeVisible();
```

If the note does NOT appear, that is a finding, not a blocker — record it in
the findings doc and assert the behaviour the product actually has, with a
comment naming it as a defect and a link to the finding.

- [ ] **Step 6: Screenshots and the scroll gate**

```ts
  await screenshotAtWidths(page, testInfo, "officials-handoff-final", [1280, 768, 320]);
  await expectNoHorizontalScroll(page);
```

- [ ] **Step 7: Run it, record the wall clock, prove it can fail**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/sched-walkthrough/apps/web && \
  time npx playwright test --project=walkthrough \
  e2e/walkthrough/scheduling-officials-handoff.spec.ts --reporter=list; echo "EXIT=$?"
```

Expected: PASS, under 90s. Then mutate: comment out the `selectOption` call and
confirm the assignment assertion reds — if it stays green the assign is being
satisfied by the propose/apply step above it and the manual path is still
untested.

- [ ] **Step 8: Commit**

```bash
git add apps/web/e2e/walkthrough/scheduling-officials-handoff.spec.ts
git commit -m "test(walkthrough): the officials handoff, both people driven

Invite, the claim link followed from the page that emits it, the official's own
blackout, propose, apply, and the manual assign actually chosen — every existing
test stopped at asserting that select was visible."
```

---

### Task 6: The performance gate and the wave report

A walkthrough that doubles the leg's wall clock is not optimised, and the leg
is already the e2e workflow's floor.

**Files:**
- Modify: `apps/web/e2e/walkthrough/README.md` (the "What is here" table and
  the measured-cost paragraph)
- Modify: `docs/superpowers/specs/2026-09-03-scheduling-walkthrough-findings.md` (created in Task 0)

- [ ] **Step 1: Measure the leg, not the file**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/sched-walkthrough/apps/web && \
  time npx playwright test --project=walkthrough --workers=3 \
  --reporter=json --output=/tmp/wt.json 2>&1 | tail -5; echo "EXIT=$?"
```

Record: the leg's total wall clock, and each new spec's own duration from the
JSON. The pass condition is that the leg's wall clock is **not materially above
its pre-task value** — the two new files should hide under the
`scorepad-v3-tennis-mtb` tail at `--workers=3`.

- [ ] **Step 2: If either spec is over 90s, cut work — not assertions**

In order of preference: fewer entrants (four is already the floor for a league
that exercises rest); one venue instead of two if venue-qualified naming is
proven elsewhere; drop the mid-journey screenshots and keep only the final
`screenshotAtWidths`. Never buy time by deleting a record read-back — that is
the part that makes it a walkthrough.

- [ ] **Step 3: Update the README**

Add both specs to the "What is here" table with one line each on what they
drive, and update the measured-cost paragraph with the numbers from Step 1.
That paragraph is the only place the leg's real cost is written down.

- [ ] **Step 4: Write the findings doc**

Everything the hand-driven pass and the two specs turned up: F1-F5 from the
spec with their final disposition, plus anything new. For each finding: what a
customer gains or loses, the blast radius, a recommendation, and the strongest
argument against it. A bare technical list is not a finding report.

- [ ] **Step 5: Confirm the CI wiring still holds**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/sched-walkthrough/apps/web && \
  npx vitest run src/lib/__tests__/e2e-ci-wiring.test.ts \
  --reporter=json --outputFile=/tmp/wiring.json; echo "EXIT=$?"
```

That test exists because a project nothing dispatches is indistinguishable from
a passing one. It must still select both new files.

- [ ] **Step 6: Full gate, then commit**

Run the whole `walkthrough` project and the whole vitest suite. Confirm
`numTotalTests` has not DROPPED against the pre-wave count — a drop is a
collection failure wearing a green summary.

```bash
git add apps/web/e2e/walkthrough/README.md \
        docs/superpowers/specs/2026-09-03-scheduling-walkthrough-findings.md
git commit -m "docs(walkthrough): record the scheduling walkthroughs and their cost"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: the surface map → Tasks 4
and 5; F1 → Task 1; F2 → Task 2; F3 → Task 5 step 4; F4 → Task 4 step 2; F5 →
Task 4 (court tags via `division-settings.tsx:628`); testids → Task
3; the four test types → Task 1 steps 1/6 and Task 4 step 4 and the mutation
steps; verification bars → Task 6. The owner's speed constraint, added after the
spec was approved, is carried as a Global Constraint and gated in Task 6.

**Known gap, deliberate.** Task 4's step-2 code block shows steps 1, 3, 4 and 5
but not the `?tab=fixtures` court-tags step (step 2) or the capacity precheck
read (step 6) as literal code — both are single taps on the court-tags control and
the capacity card, and the surrounding pattern (tap, then read the record back
through `apiJson`) is shown three times in the same block. An executor who
cannot write those two from the pattern should stop and ask rather than guess.

**Type consistency.** `divisionLockState` returns `{ frozen, scopes }` and is
used as `lockState.frozen` in Task 1 — matches `schedule.ts:531`.
`clearScheduleScoped` keeps its signature. `scheduledSlots(request, divisionId)`
is defined once in Task 4 step 1 and returns `Slot[]` sorted by fixture id, so
the `toEqual(placed)` in step 3 compares time AND court rather than a count.
Testid strings in Task 3's table are the same strings Tasks 4 and 5 select on.
