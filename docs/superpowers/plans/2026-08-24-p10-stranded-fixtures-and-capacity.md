# P10 — Stranded Fixtures, Window De-fork, Server-side Capacity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close P10's real remainder — report fixtures stranded on archived or deleted courts, delete the fourth copy of the window rule, give every verify-config site the same court-calendar signal, and make the capacity precheck calendar-aware by moving it server-side.

**Architecture:** The engine stays pure and database-free: the server resolves which courts are archived or missing and passes the id set through `VerifyConfig`, exactly as `courtCalendars` already arrives. A single `verifyConfigForDivision` replaces five hand-assembled configs. The capacity precheck's computation moves behind a POST endpoint that accepts the board's live unsaved state, so calendars never re-enter the RSC payload P9 shrank.

**Tech Stack:** TypeScript 7 (`typescript@7.0.2`), Node 26, pnpm, Next.js (see `AGENTS.md` — this is not stock Next), vitest, Playwright, zod, pino, postgres.js, `@seazn/engine` workspace package.

**Spec:** `docs/superpowers/specs/bench-product-value/designs/2026-08-24-p10-stranded-fixtures-and-capacity-design.md`

## Global Constraints

- Worktree only: `/Users/ashokhein/github/seazn.club/.claude/worktrees/p10-calendars`, branch `feat/p10-venues-calendars`. **Never** check out in the main repo dir. Prefix `cd <abs worktree> &&` in the *same* bash call — shell cwd resets between calls and a verify run silently executes on `main`.
- **Never `git stash` in this worktree** — the stash stack is shared with the main checkout and popping a foreign stash leaves `package.json` unmerged.
- Vitest is green **only** via `--reporter=json --outputFile` plus jq on `numPassedTests`/`numTotalTests`. `rtk` summaries print `PASS(0) FAIL(0)` for a suite that failed to *collect*. Run engine tests with cwd `packages/engine` and apps/web tests with cwd `apps/web` — from the repo root ~2600 tests never collect.
- Lint only via `rtk proxy npm run lint`, read `✖ N problems`. `rtk` hides lint output entirely otherwise.
- `grep -a` always — this repo reports source files as `Binary file … matches`.
- `settings.orgTz` is the governing clock. `settings.tz` is display only.
- Every user-facing string lands in **all four** dictionaries: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`, flat dotted keys, then `npm run i18n:gen-keys` (`i18n-keys.ts` is generated — parity green, drift red).
- **Do NOT widen `isBlockingConflict` or `isBlockingForBuild`.** The new conflict is reported, never blocking.
- Do not touch: P8's calendar CRUD/editor, the placement service or its proto, `toSlotConfig`'s AI-pack carve-out.
- New server code gets pino structured logging with a named event. Never log in tests.
- Every change ships a test that fails without it.
- Pre-commit: `npm run openapi:gen && git status --porcelain` must be empty.
- UI work is verified by screenshot at 1280, 320 and 768 with no horizontal page scroll.
- Final message from any dispatched agent: under 15 lines — counts, paths, deviations, blockers. No file contents, no diffs.

---

### Task 1: Engine reports `stranded_fixture`

**Files:**
- Modify: `packages/engine/src/scheduling/conflict-detail.ts:56-83` (the `ConflictDetailKind` union) and its `ConflictDetail` variant union
- Modify: `packages/engine/src/scheduling/calendar.ts:1122-1185` (`VerifyConfig`), `:1745-1771` (court window checks)
- Test: `packages/engine/src/scheduling/stranded-fixture.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `VerifyConfig.strandedCourtIds?: readonly string[]`; `ConflictDetailKind` member `"stranded_fixture"`; detail object `{ kind: "stranded_fixture", court: string }`; conflict `{ fixtureId, reason: "court", details }`.

- [ ] **Step 1: Write the failing test**

Create `packages/engine/src/scheduling/stranded-fixture.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { validateAssignments, type Assignment, type VerifyConfig } from "./calendar.ts";

const base: VerifyConfig = {
  perEntrantMinRest: 0,
  gapMinutes: 0,
  blackouts: [],
  sessionWindows: [],
  matchMinutes: 60,
  tz: "Europe/Amsterdam",
};

const assignment = (court: string): Assignment => ({
  fixtureId: `f-${court}`,
  court,
  startAt: Date.UTC(2026, 7, 24, 9, 0),
  endAt: Date.UTC(2026, 7, 24, 10, 0),
  entrants: [],
  people: [],
});

const strandedFor = (conflicts: ReturnType<typeof validateAssignments>) =>
  conflicts.filter((c) => c.details?.kind === "stranded_fixture");

describe("stranded_fixture", () => {
  it("reports a fixture whose court the server flagged stranded", () => {
    const conflicts = validateAssignments([assignment("court-archived")], {
      ...base,
      strandedCourtIds: ["court-archived"],
    });
    const stranded = strandedFor(conflicts);
    expect(stranded).toHaveLength(1);
    expect(stranded[0]).toMatchObject({
      fixtureId: "f-court-archived",
      reason: "court",
      details: { kind: "stranded_fixture", court: "court-archived" },
    });
  });

  it("stays silent for an org with no calendars and no stranded set", () => {
    expect(strandedFor(validateAssignments([assignment("court-live")], base))).toEqual([]);
  });

  it("stays silent for a court that merely has no calendar rows", () => {
    const conflicts = validateAssignments([assignment("court-uncalendared")], {
      ...base,
      courtCalendars: [{ courtId: "court-other", hours: [], exceptions: [] }],
      strandedCourtIds: [],
    });
    expect(strandedFor(conflicts)).toEqual([]);
  });

  it("reports stranded independently of court hours, without duplicating outside_court_hours", () => {
    const conflicts = validateAssignments([assignment("court-archived")], {
      ...base,
      courtCalendars: [
        { courtId: "court-archived", hours: [{ weekday: 1, open_min: 0, close_min: 1440 }], exceptions: [] },
      ],
      strandedCourtIds: ["court-archived"],
    });
    expect(strandedFor(conflicts)).toHaveLength(1);
    expect(conflicts.filter((c) => c.details?.kind === "outside_court_hours")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/p10-calendars/packages/engine && \
  npx vitest run --reporter=json --outputFile=/tmp/p10-t1.json src/scheduling/stranded-fixture.test.ts; echo EXIT=$?
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/p10-t1.json
```

Expected: FAIL — TypeScript rejects `strandedCourtIds` as an unknown `VerifyConfig` property, and `"stranded_fixture"` is not a `ConflictDetailKind`. Note: vitest does **not** typecheck; the failure will surface as zero stranded conflicts found rather than a type error. Both count as red.

- [ ] **Step 3: Add the kind and the detail variant**

In `conflict-detail.ts`, append to the `ConflictDetailKind` union after `"court_tag_mismatch"`:

```ts
  | "stranded_fixture"
```

Find the `ConflictDetail` discriminated-union variant that carries `outside_court_hours` (it holds `court` and an optional `courtName` — grep `-a 'courtName' packages/engine/src/scheduling/conflict-detail.ts`) and add a matching variant:

```ts
  | { kind: "stranded_fixture"; court: string; courtName?: string }
```

- [ ] **Step 4: Add the config field**

In `calendar.ts`'s `VerifyConfig` (`:1122-1185`), inside the trailing object literal beside `courtTagQualifiedIds`:

```ts
    /** Courts the SERVER resolved as archived or absent from `courts`. The engine
     *  holds no database handle, so court STATUS arrives the way court CALENDARS
     *  do. Deliberately not derived from `courtCalendars` absence: an org that has
     *  simply never configured a calendar must stay silent (P10 ruling 1). */
    strandedCourtIds?: readonly string[];
```

- [ ] **Step 5: Report it**

In `calendar.ts`, immediately **before** the `courtHourWindows` lookup at `:1763`, inside the same per-assignment loop:

```ts
      if (strandedCourtIds.has(a.court)) {
        conflicts.push({
          fixtureId: a.fixtureId,
          reason: "court",
          details: { kind: "stranded_fixture", court: a.court },
        });
      }
```

and hoist the set once, beside the `courtHourWindows` build at `:1745`:

```ts
    const strandedCourtIds = new Set(config.strandedCourtIds ?? []);
```

Leave the `openHours !== undefined` short-circuit at `:1763` **exactly as it is** — it is load-bearing for uncalendared orgs.

- [ ] **Step 6: Run the test to verify it passes**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/p10-calendars/packages/engine && \
  npx vitest run --reporter=json --outputFile=/tmp/p10-t1.json src/scheduling/stranded-fixture.test.ts; echo EXIT=$?
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/p10-t1.json
```

Expected: `total: 4, passed: 4, failed: 0`.

- [ ] **Step 7: Prove the conflict is NOT blocking**

Add to the same test file:

```ts
import { isBlockingConflict } from "./calendar.ts";

it("is reported but never blocking", () => {
  const conflicts = validateAssignments([assignment("court-archived")], {
    ...base,
    strandedCourtIds: ["court-archived"],
  });
  expect(conflicts.filter(isBlockingConflict)).toEqual([]);
});
```

If `isBlockingConflict` is not exported from `calendar.ts`, grep for its definition (`grep -an 'isBlockingConflict' packages/engine/src/scheduling/*.ts`) and import from where it lives. Re-run Step 6's command; expect `total: 5, passed: 5`.

- [ ] **Step 8: Run the full engine scheduling suite**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/p10-calendars/packages/engine && \
  npx vitest run --reporter=json --outputFile=/tmp/p10-engine.json src/scheduling; echo EXIT=$?
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/p10-engine.json
```

Expected: zero failures. P9.5's boundary count was 4068/0 for the whole engine; this subset is smaller — record the number you actually get, do not assert a remembered one.

- [ ] **Step 9: Commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/p10-calendars && \
git add packages/engine/src/scheduling/conflict-detail.ts packages/engine/src/scheduling/calendar.ts packages/engine/src/scheduling/stranded-fixture.test.ts && \
git commit -m "feat(engine): report fixtures stranded on archived courts

The 28th conflict kind. Court STATUS arrives from the server the way court
CALENDARS already do, because the engine holds no database handle. Reported,
never blocking: ruling 3 forbids retroactively refusing an assignment on a
since-archived court, and surfacing one is not refusing it.

The calendar.ts:1763 undefined short-circuit is untouched. It is load-bearing
for orgs that have never configured a calendar at all.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Delete the fourth window copy, and teach the guard to see it

**Files:**
- Modify: `packages/engine/src/scheduling/window-single-source.test.ts:19-22` (locator)
- Modify: `apps/web/src/server/usecases/venues.ts:243-258` (delete `resolveCourtDay`), `:676-697` (`countStrandedFixtures`)
- Test: `apps/web/src/server/usecases/venues.test.ts` (extend)

**Interfaces:**
- Consumes: `usableWindows(calendar: CourtCalendar, range: { from: Ymd; to: Ymd }, config: WindowConfig): Window[]` from `@seazn/engine/scheduling/court-windows`; `CourtCalendar = { courtId, hours, exceptions }`; `Window = { from: number; to: number }` in **epoch ms**, not minutes.
- Produces: `countStrandedFixtures` unchanged in signature, corrected in behavior.

- [ ] **Step 1: Extend the single-source guard to reach apps/web**

`window-single-source.test.ts` reads only `./calendar.ts` and `./build-grid.ts` relative to `import.meta.url`, which is why a copy in `apps/web` was invisible. Add:

```ts
const webSource = (file: string): string =>
  readFileSync(new URL(`../../../../apps/web/src/${file}`, import.meta.url), "utf8");

describe("apps/web has no second window rule", () => {
  it("venues.ts resolves court days through the engine, not its own copy", () => {
    const src = webSource("server/usecases/venues.ts");
    expect(src).not.toMatch(/function resolveCourtDay/);
    expect(src).toMatch(/usableWindows/);
  });
});
```

Verify the relative depth before trusting it:

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/p10-calendars && \
  ls packages/engine/src/scheduling/../../../../apps/web/src/server/usecases/venues.ts
```

Expected: the path prints. If it does not, count directory levels again and fix the `../` run.

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/p10-calendars/packages/engine && \
  npx vitest run --reporter=json --outputFile=/tmp/p10-t2a.json src/scheduling/window-single-source.test.ts; echo EXIT=$?
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/p10-t2a.json
```

Expected: FAIL — `resolveCourtDay` still exists in `venues.ts`.

- [ ] **Step 3: Write the failing behavior tests**

The current predicate has three defects to pin. Add to `apps/web/src/server/usecases/venues.test.ts` (match the file's existing setup helpers for org/court/fixture creation — read the nearest existing `putCourtCalendar` test and copy its scaffolding rather than inventing new fixtures):

```ts
it("counts a fixture that STARTS inside hours but ENDS after close as stranded", async () => {
  // court open 09:00-10:00 local; a 60-minute fixture at 09:30 overruns the close.
  const { orgId, courtId } = await seedCourtWithFixtureAt("09:30");
  const res = await putCourtCalendar(auth, courtId, {
    hours: [{ weekday: FIXTURE_WEEKDAY, open_min: 9 * 60, close_min: 10 * 60 }],
    exceptions: [],
  });
  expect(res.strandedFixtureCount).toBe(1);
});

it("counts a fixture sitting inside a blackout as stranded", async () => {
  const { courtId } = await seedCourtWithFixtureAt("09:00");
  const res = await putCourtCalendar(auth, courtId, {
    hours: [{ weekday: FIXTURE_WEEKDAY, open_min: 0, close_min: 1440 }],
    exceptions: [],
  });
  expect(res.strandedFixtureCount).toBe(1); // blackout covers 09:00 for this org
});

it("resolves the day in the org timezone via the same resolver settings.orgTz uses", async () => {
  const { courtId } = await seedCourtWithFixtureAt("00:30"); // 23:30 UTC previous day
  const res = await putCourtCalendar(auth, courtId, {
    hours: [{ weekday: FIXTURE_WEEKDAY, open_min: 0, close_min: 60 }],
    exceptions: [],
  });
  expect(res.strandedFixtureCount).toBe(0);
});
```

The blackout case needs an org with a blackout covering that instant — if the existing test scaffolding has no blackout helper, seed one directly against `schedule_settings` the way the nearest blackout test in this repo does (`grep -an 'blackouts' apps/web/src/server/usecases/*.test.ts`).

- [ ] **Step 4: Run them to verify they fail**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/p10-calendars/apps/web && \
  npx vitest run --reporter=json --outputFile=/tmp/p10-t2b.json src/server/usecases/venues.test.ts; echo EXIT=$?
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/p10-t2b.json
```

Expected: the three new tests fail. If the whole file fails to collect, that is a DB-state problem, not your code — the suite needs `db:apply` **and** `sync:sports`; follow the `seazn-local-env` skill before diagnosing further.

- [ ] **Step 5: Rewrite `countStrandedFixtures` on `usableWindows`**

Replace the body (`venues.ts:676-697`). Note the unit change: `usableWindows` returns **epoch ms** windows, so compare instants, not local minutes — and compare the fixture's whole span.

```ts
async function countStrandedFixtures(
  orgId: string,
  courtId: string,
  hours: readonly CourtHoursRange[],
  exceptions: readonly CourtException[],
): Promise<number> {
  const [org] = await sql<{ timezone: string | null }[]>`
    select timezone from organizations where id = ${orgId}`;
  const tz = resolveVenueTz(null, org?.timezone);
  const settings = await scheduleWindowInputsForOrg(orgId);
  const fixtures = await sql<{ scheduled_at: Date; match_minutes: number | null }[]>`
    select f.scheduled_at, s.match_minutes
    from fixtures f
    left join schedule_settings s on s.division_id = f.division_id
    where f.court_id = ${courtId} and f.scheduled_at is not null
      and f.status in ${sql(UNPLAYED_FIXTURE_STATUSES)}`;
  const calendar: CourtCalendar = { courtId, hours: [...hours], exceptions: [...exceptions] };
  let stranded = 0;
  for (const f of fixtures) {
    const startAt = f.scheduled_at.getTime();
    const endAt = startAt + (f.match_minutes ?? DEFAULT_MATCH_MINUTES) * 60_000;
    const ymd = dayKeyInTz(startAt, tz);
    const windows = usableWindows(calendar, { from: ymd, to: ymd }, {
      tz,
      sessionWindows: settings.sessionWindows,
      blackouts: settings.blackouts,
    });
    if (!windows.some((w) => startAt >= w.from && endAt <= w.to)) stranded++;
  }
  return stranded;
}
```

`scheduleWindowInputsForOrg` and `DEFAULT_MATCH_MINUTES` may not exist. Before writing them, grep for what already resolves session windows and blackouts for an org (`grep -an 'sessionWindows' apps/web/src/server/usecases/*.ts`) and reuse it. If nothing fits, add a small local helper in `venues.ts` reading `schedule_settings` for the court's org — do **not** add a second window computation.

Then delete `resolveCourtDay` (`:243-258`) and remove any now-unused import. If `resolveCourtDay` is exported and referenced by a test, delete that test too: an orphaned symbol after demolition is a regression, and so is a test pinning a deleted rule.

- [ ] **Step 6: Run both suites to verify they pass**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/p10-calendars/apps/web && \
  npx vitest run --reporter=json --outputFile=/tmp/p10-t2b.json src/server/usecases/venues.test.ts; echo EXIT=$?
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/p10-t2b.json
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/p10-calendars/packages/engine && \
  npx vitest run --reporter=json --outputFile=/tmp/p10-t2a.json src/scheduling/window-single-source.test.ts; echo EXIT=$?
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/p10-t2a.json
```

Expected: both zero failures. `venues.test.ts` is known to flake in CI on lock contention — a red there that names a lock timeout is environmental; re-run once before investigating.

- [ ] **Step 7: Commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/p10-calendars && \
git add packages/engine/src/scheduling/window-single-source.test.ts apps/web/src/server/usecases/venues.ts apps/web/src/server/usecases/venues.test.ts && \
git commit -m "fix(venues): compute stranded fixtures with the engine's window rule

resolveCourtDay was a fourth implementation of the window rule. It survived
P9.5's de-forking because window-single-source.test.ts reads only calendar.ts
and build-grid.ts through import.meta.url and never scanned apps/web. The guard
now scans both workspaces, so the next copy cannot hide on either side.

Deleting it corrects three defects in a number organisers already see in the
calendar editor: the predicate tested only the fixture's START minute, so a
fixture overrunning the close counted as fitting; blackouts and session windows
were ignored entirely; and the timezone came from organizations.timezone raw
rather than through the resolver settings.orgTz uses.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: One verify-config builder, and the stranded-court resolver

**Files:**
- Modify: `apps/web/src/server/usecases/court-candidates.ts:250-263` (add resolver beside `courtCalendarsForDivision`)
- Modify: `apps/web/src/server/usecases/schedule.ts:1002` (`toVerifyConfig`), `:1532`, `:2589`, `:2944`, `:3308`
- Modify: `apps/web/src/server/usecases/person-merge.ts:382`
- Test: `apps/web/src/server/usecases/stranded-courts.test.ts` (create)

**Interfaces:**
- Consumes: Task 1's `VerifyConfig.strandedCourtIds`; existing `courtCalendarsForDivision(tx, divisionId, configuredCourtIds): Promise<CourtCalendar[]>`.
- Produces:
  - `strandedCourtIdsForDivision(tx: Tx, divisionId: string, assignedCourtIds: readonly string[]): Promise<string[]>`
  - `verifyConfigForDivision(tx: Tx, settings: ScheduleSettingsOut, fixtures: readonly FixtureLite[], now: number, extraRuleFixtures: readonly RuleFixture[], divisionId: string, assignedCourtIds: readonly string[]): Promise<SlotConfig & VerifyConfig>`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/server/usecases/stranded-courts.test.ts`. Copy org/division/court seeding from the nearest existing `court-candidates` or `schedule` usecase test.

```ts
it("flags a court archived after the fixture was placed", async () => {
  const { tx, divisionId, courtId } = await seedDivisionWithCourt();
  await tx`update courts set archived_at = now() where id = ${courtId}`;
  await expect(strandedCourtIdsForDivision(tx, divisionId, [courtId])).resolves.toEqual([courtId]);
});

it("flags a court id that no longer exists at all", async () => {
  const { tx, divisionId } = await seedDivisionWithCourt();
  const gone = "00000000-0000-4000-8000-000000000001";
  await expect(strandedCourtIdsForDivision(tx, divisionId, [gone])).resolves.toEqual([gone]);
});

it("does NOT flag a live court that simply has no calendar rows", async () => {
  const { tx, divisionId, courtId } = await seedDivisionWithCourt();
  await expect(strandedCourtIdsForDivision(tx, divisionId, [courtId])).resolves.toEqual([]);
});

it("does NOT flag a live court that fell out of the candidate set", async () => {
  // A tag change removes a court from candidates. Ruling 3: that must not red
  // an existing assignment, and it is not a stranding either.
  const { tx, divisionId, courtId } = await seedDivisionWithCourt();
  await tx`update divisions set required_court_tags = array['indoor'] where id = ${divisionId}`;
  await expect(strandedCourtIdsForDivision(tx, divisionId, [courtId])).resolves.toEqual([]);
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/p10-calendars/apps/web && \
  npx vitest run --reporter=json --outputFile=/tmp/p10-t3.json src/server/usecases/stranded-courts.test.ts; echo EXIT=$?
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/p10-t3.json
```

Expected: FAIL — `strandedCourtIdsForDivision` is not defined.

- [ ] **Step 3: Add the resolver**

In `court-candidates.ts`, directly below `courtCalendarsForDivision`:

```ts
/** Court ids among `assignedCourtIds` that are archived or no longer exist.
 *  Deliberately NOT the candidate-set complement: a court dropped from
 *  candidates by a tag change is still a live court, and redding its existing
 *  assignment is exactly what ruling 3 forbids. Archived-or-absent only. */
export async function strandedCourtIdsForDivision(
  tx: Tx,
  divisionId: string,
  assignedCourtIds: readonly string[],
): Promise<string[]> {
  if (assignedCourtIds.length === 0) return [];
  const live = await tx<{ id: string }[]>`
    select id from courts
    where id in ${tx(assignedCourtIds)} and archived_at is null`;
  const liveIds = new Set(live.map((r) => r.id));
  return assignedCourtIds.filter((id) => !liveIds.has(id));
}
```

`divisionId` is unused in the query today but stays in the signature so the call sites read identically to `courtCalendarsForDivision` and a future division-scoped rule has a seam. If the repo's lint rejects an unused parameter, prefix it `_divisionId`.

- [ ] **Step 4: Run to verify it passes**

Same command as Step 2. Expected: `total: 4, passed: 4, failed: 0`.

- [ ] **Step 5: Add the unified builder**

`toVerifyConfig` gains one more optional parameter rather than changing its five existing call shapes:

```ts
export function toVerifyConfig(
  settings: ScheduleSettingsOut,
  fixtures: readonly FixtureLite[],
  now: number,
  extraRuleFixtures: readonly RuleFixture[] = [],
  courtCalendars?: readonly CourtCalendar[],
  strandedCourtIds?: readonly string[],
): SlotConfig & VerifyConfig {
  return {
    ...toSlotConfig(settings, now),
    tz: settings.orgTz,
    ruleFixtures: [...fixtures.map(rowToRuleFixture), ...extraRuleFixtures],
    ...(courtCalendars !== undefined && courtCalendars.length > 0 ? { courtCalendars } : {}),
    ...(strandedCourtIds !== undefined && strandedCourtIds.length > 0 ? { strandedCourtIds } : {}),
  };
}
```

Then add, in `schedule.ts` beside `toVerifyConfig`:

```ts
/** The ONE place a VerifyConfig gets its court signals. Five sites used to
 *  assemble this by hand and person-merge.ts silently omitted the calendars —
 *  hand-assembly is how a blind sixth site gets born. */
export async function verifyConfigForDivision(
  tx: Tx,
  settings: ScheduleSettingsOut,
  fixtures: readonly FixtureLite[],
  now: number,
  extraRuleFixtures: readonly RuleFixture[],
  divisionId: string,
  assignedCourtIds: readonly string[],
): Promise<SlotConfig & VerifyConfig> {
  const [courtCalendars, strandedCourtIds] = await Promise.all([
    courtCalendarsForDivision(tx, divisionId, settings.config.courts),
    strandedCourtIdsForDivision(tx, divisionId, assignedCourtIds),
  ]);
  return toVerifyConfig(settings, fixtures, now, extraRuleFixtures, courtCalendars, strandedCourtIds);
}
```

- [ ] **Step 6: Route all five sites through it**

`assignedCourtIds` is the set of court ids the assignments actually sit on — derive it at each site from the fixtures/assignments already in hand, e.g. `[...new Set(all.map((f) => f.court_id).filter((c): c is string => c !== null))]`.

Replace each site. `:1532` and `:3308` currently resolve via `resolveCourtCalendars(tx, candidateCourtIds.ids)`; keep that resolution if the surrounding code reuses `courtCalendars` elsewhere, and pass `strandedCourtIds` alongside rather than forcing those two through the division helper — the goal is that no site omits a signal, not that all five use one code path where the surrounding scope differs. `:2589`, `:2944` and `person-merge.ts:382` become `await verifyConfigForDivision(...)`.

For `person-merge.ts:382`, the call is inside `validateAssignments(assignments, toVerifyConfig(settings, all, 0, ruleFixtures), siblings, …)`. Hoist it:

```ts
const verifyConfig = await verifyConfigForDivision(
  tx, settings, all, 0, ruleFixtures, divisionId, assignedCourtIds,
);
```

If `person-merge.ts` has no `divisionId` in scope at that point, derive it from the fixtures being validated; if fixtures span divisions, call the helper per division and merge the resulting `courtCalendars`/`strandedCourtIds` arrays. Do not silently validate a multi-division merge against one division's calendars.

- [ ] **Step 7: Add the anti-regression guard**

Append to `stranded-courts.test.ts`:

```ts
it("no verify-config site omits the court signals", () => {
  const src = readFileSync(new URL("./schedule.ts", import.meta.url), "utf8");
  const merge = readFileSync(new URL("./person-merge.ts", import.meta.url), "utf8");
  for (const call of [...src.matchAll(/toVerifyConfig\(/g), ...merge.matchAll(/toVerifyConfig\(/g)]) {
    const tail = (call.input ?? "").slice(call.index ?? 0, (call.index ?? 0) + 400);
    if (tail.startsWith("toVerifyConfig(\n  settings: ScheduleSettingsOut")) continue; // the definition
    expect(tail).toMatch(/courtCalendars|CourtCalendars/);
  }
});
```

This is a text guard, and text guards go stale — if it fires on a legitimate future shape, fix the guard rather than deleting it.

- [ ] **Step 8: Run the server suite**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/p10-calendars/apps/web && \
  npx vitest run --reporter=json --outputFile=/tmp/p10-t3-all.json src/server; echo EXIT=$?
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/p10-t3-all.json
```

Expected: zero failures. Record the total.

- [ ] **Step 9: Commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/p10-calendars && \
git add apps/web/src/server/usecases/court-candidates.ts apps/web/src/server/usecases/schedule.ts apps/web/src/server/usecases/person-merge.ts apps/web/src/server/usecases/stranded-courts.test.ts && \
git commit -m "feat(schedule): resolve stranded courts, and stop hand-building verify configs

person-merge.ts called toVerifyConfig with four arguments and resolved no
calendars at all, so a fixture reassigned during a person merge was validated
with no court-hours signal while every schedule.ts site had one. Five sites
assembling the same config by hand is how that happened.

strandedCourtIdsForDivision is archived-or-absent only. The candidate-set
complement would have been easier and wrong: a court dropped by a tag change is
still live, and redding its assignment is what ruling 3 forbids.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Name it on the board — enrichment and four dictionaries

**Files:**
- Modify: `apps/web/src/components/v2/board/conflict-detail-format.ts:195-210`
- Modify: the court-name enrichment site (grep below)
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`
- Test: `apps/web/src/components/v2/board/conflict-detail-format.test.ts` (extend, or create if absent)

**Interfaces:**
- Consumes: Task 1's `{ kind: "stranded_fixture", court, courtName? }`.
- Produces: dictionary keys `board.conflict.detail.stranded_fixture` and `board.conflict.conflict.stranded_fixture`.

- [ ] **Step 1: Find the enrichment site**

The engine pushes `court: a.court` (an id) but the formatter reads `d.courtName`. Something maps one to the other:

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/p10-calendars && \
  grep -ran 'courtName' apps/web/src --include=*.ts --include=*.tsx | grep -v '\.test\.'
```

Whatever site enriches `outside_court_hours` and `court_tag_mismatch` must enrich `stranded_fixture` identically — including the A12 `Name (Venue)` disambiguation, and including the raw-id fallback, since a stranded court is frequently one that was deleted and has no name left to resolve.

- [ ] **Step 2: Write the failing test**

```ts
it("names a stranded fixture's court", () => {
  expect(formatConflictDetail({ kind: "stranded_fixture", court: "c1", courtName: "Court 1" }, msg))
    .toBe("Court 1 is no longer available");
});

it("falls back to the raw id when a deleted court has no name left", () => {
  expect(formatConflictDetail({ kind: "stranded_fixture", court: "c1" }, msg))
    .toContain("c1");
});
```

Match the existing test file's helper names for `formatConflictDetail`/`msg` — read the neighbouring `outside_court_hours` test rather than assuming these.

- [ ] **Step 3: Run to verify it fails**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/p10-calendars/apps/web && \
  npx vitest run --reporter=json --outputFile=/tmp/p10-t4.json src/components/v2/board; echo EXIT=$?
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/p10-t4.json
```

- [ ] **Step 4: Add the formatter case**

In `conflict-detail-format.ts`, beside `outside_court_hours`:

```ts
    case "stranded_fixture":
      return msg("board.conflict.detail.stranded_fixture", { court: courtLabel(d.courtName, msg) });
```

- [ ] **Step 5: Add the four dictionary entries**

Insert alphabetically beside the existing `board.conflict.detail.outside_court_hours` line in each file:

`apps/web/src/dictionaries/en/ui.json`:
```json
"board.conflict.detail.stranded_fixture": "Court {court} is no longer available",
"board.conflict.conflict.stranded_fixture": "Court unavailable",
```

`apps/web/src/dictionaries/nl/ui.json`:
```json
"board.conflict.detail.stranded_fixture": "Baan {court} is niet meer beschikbaar",
"board.conflict.conflict.stranded_fixture": "Baan niet beschikbaar",
```

`apps/web/src/dictionaries/fr/ui.json`:
```json
"board.conflict.detail.stranded_fixture": "Le court {court} n'est plus disponible",
"board.conflict.conflict.stranded_fixture": "Court indisponible",
```

`apps/web/src/dictionaries/es/ui.json`:
```json
"board.conflict.detail.stranded_fixture": "La pista {court} ya no está disponible",
"board.conflict.conflict.stranded_fixture": "Pista no disponible",
```

Check the neighbouring court-related strings in each non-English file first and match their existing noun choice — if `nl` already says "veld" rather than "baan" for a court elsewhere in this key family, follow that, not this plan.

- [ ] **Step 6: Regenerate keys and verify parity**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/p10-calendars && \
  npm run i18n:gen-keys && git status --porcelain
cd apps/web && npx vitest run --reporter=json --outputFile=/tmp/p10-i18n.json src/dictionaries; echo EXIT=$?
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/p10-i18n.json
```

`i18n-keys.ts` is generated — it MUST appear as modified after adding a key. If `git status` is clean there, the regen did not run.

- [ ] **Step 7: Run the board tests**

Same command as Step 3. Expected: zero failures.

- [ ] **Step 8: Commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/p10-calendars && \
git add apps/web/src/components/v2/board apps/web/src/dictionaries apps/web/src/lib/i18n-keys.ts && \
git commit -m "feat(board): name the court a stranded fixture is stuck on

Four locales, and the raw-id fallback matters more here than for the other court
conflicts: a stranded court is often one that was deleted outright, so there is
frequently no name left to resolve.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Capacity precheck endpoint

**Files:**
- Create: `apps/web/src/app/api/v1/orgs/[id]/divisions/[divisionId]/capacity/route.ts`
- Modify: `apps/web/src/server/usecases/capacity-guard.ts` (add the usecase)
- Modify: `apps/web/src/server/api-v1/schemas.ts`, `apps/web/src/server/api-v1/openapi.ts:152` area
- Test: `apps/web/src/server/usecases/capacity-endpoint.test.ts` (create)

**Interfaces:**
- Consumes: `capacityInputForFixtures(fixtures, config: CapacityConfigInput, divisionId): CapacityInput | null`; `assessCapacity(input: CapacityInput): CapacityReport`; `courtCalendarsForDivision`.
- Produces: `assessCapacityForDivision(auth: AuthCtx, divisionId: string, body: CapacityPrecheckInput): Promise<CapacityReport | null>`; wire schema `CapacityPrecheck`.

- [ ] **Step 1: Write the failing test**

```ts
it("returns a report whose supply respects court hours", async () => {
  const { auth, divisionId, courtId } = await seedDivisionWithCourt();
  await putCourtCalendar(auth, courtId, {
    hours: [{ weekday: 1, open_min: 9 * 60, close_min: 11 * 60 }], // 2h, not 24
    exceptions: [],
  });
  const report = await assessCapacityForDivision(auth, divisionId, bodyFor(divisionId, [courtId]));
  const openAll = await assessCapacityForDivision(auth, uncalendaredDivisionId, bodyFor(uncalendaredDivisionId, [otherCourtId]));
  expect(report!.slotSupply).toBeLessThan(openAll!.slotSupply);
});

it("returns null when the window is unbounded, matching the client contract", async () => {
  const { auth, divisionId } = await seedDivisionWithCourt();
  await expect(assessCapacityForDivision(auth, divisionId, { ...bodyFor(divisionId, []), window: undefined }))
    .resolves.toBeNull();
});

it("refuses a division in another org", async () => {
  const { auth } = await seedDivisionWithCourt();
  const other = await seedOtherOrgDivision();
  await expect(assessCapacityForDivision(auth, other.divisionId, bodyFor(other.divisionId, [])))
    .rejects.toMatchObject({ status: 404 });
});
```

The third test is the one that matters most: this endpoint accepts a division id from the client, so tenant scoping is the security boundary. Follow whatever `requireOrgAuth` + division-ownership check the nearest division-scoped usecase uses.

- [ ] **Step 2: Run to verify it fails**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/p10-calendars/apps/web && \
  npx vitest run --reporter=json --outputFile=/tmp/p10-t5.json src/server/usecases/capacity-endpoint.test.ts; echo EXIT=$?
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/p10-t5.json
```

- [ ] **Step 3: Add the usecase**

In `capacity-guard.ts`:

```ts
export const CapacityPrecheckInput = z.object({
  fixtures: z.array(z.object({
    id: Uuid,
    stage_id: Uuid.nullable(),
    status: z.string(),
    home_entrant_id: Uuid.nullable(),
    away_entrant_id: Uuid.nullable(),
    pool_id: Uuid.nullable(),
  })).max(2000),
  config: z.object({
    courts: z.array(Uuid).max(200),
    sessionWindows: z.array(z.object({ from: z.number(), to: z.number() })).max(50).optional(),
    blackouts: z.array(z.object({ court: Uuid.optional(), from: z.number(), to: z.number() })).max(200).optional(),
    matchMinutes: z.number().int().positive(),
    gapMinutes: z.number().int().min(0),
    perEntrantMinRest: z.number().int().min(0),
    window: z.object({ from: z.number(), to: z.number() }).optional(),
    constraints: z.object({
      restMin: z.number().int().min(0).optional(),
      restByGroup: z.record(z.string(), z.number()).optional(),
      noBackToBack: z.boolean().optional(),
    }).optional(),
  }),
});

/** The capacity precheck used to run in the browser off the board payload, which
 *  meant it had no court calendars — P9 stopped shipping them after they blew the
 *  RSC payload budget — so it treated every court as open all day and could only
 *  OVERSTATE supply. Computing it here gets the calendars without putting them
 *  back on the wire. The body carries the board's LIVE, UNSAVED state: deriving
 *  from stored rows would make the card blind to the edit being previewed, which
 *  is the only reason the card exists. */
export async function assessCapacityForDivision(
  auth: AuthCtx,
  divisionId: string,
  body: z.infer<typeof CapacityPrecheckInput>,
): Promise<CapacityReport | null> {
  return withTenant(auth.orgId, async (tx) => {
    const [division] = await tx<{ id: string }[]>`
      select id from divisions where id = ${divisionId} and org_id = ${auth.orgId}`;
    if (!division) throw new HttpError(404, "division not found", DIVISION_NOT_FOUND_CODE);
    const courtCalendars = await courtCalendarsForDivision(tx, divisionId, body.config.courts);
    const settings = await scheduleSettingsForDivision(tx, divisionId);
    const input = capacityInputForFixtures(body.fixtures, {
      ...body.config,
      tz: settings.orgTz,
      courtCalendars,
    }, divisionId);
    if (input === null) return null;
    const report = assessCapacity(input);
    log.info(
      { orgId: auth.orgId, divisionId, courts: body.config.courts.length,
        fixtures: body.fixtures.length, verdict: report.verdict },
      "capacity_precheck_assessed",
    );
    return report;
  });
}
```

`CapacityConfigInput` has no `courtCalendars` field today (`capacity-input.ts:40-66`) and `usableWindowsFor` (`:143`) passes `hours: []`, `exceptions: []` unconditionally. Add the optional field to `CapacityConfigInput` and thread it into `usableWindowsFor` so the court's own calendar is used when present:

```ts
  const calendar = config.courtCalendars?.find((c) => c.courtId === court);
  const open = usableWindows(
    calendar ?? { courtId: court, hours: [], exceptions: [] },
    { from: ymd, to: ymd },
    { tz, sessionWindows, blackouts },
  );
```

Then replace the `:135-141` doc comment, which currently states the limit as permanent, with one describing the server path. Leaving a stale "no court calendars are passed, and that is a known limit" comment above code that now passes them is its own defect.

- [ ] **Step 4: Add the route**

Create `apps/web/src/app/api/v1/orgs/[id]/divisions/[divisionId]/capacity/route.ts`, mirroring the sponsors-reorder shape:

```ts
import { v1, parseBody } from "@/server/api-v1/http";
import { requireOrgAuth, assertUuid } from "@/server/api-v1/auth";
import { CapacityPrecheckInput, assessCapacityForDivision } from "@/server/usecases/capacity-guard";

type Ctx = { params: Promise<{ id: string; divisionId: string }> };

export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id, divisionId } = await params;
    assertUuid(id, "organization");
    assertUuid(divisionId, "division");
    const body = await parseBody(req, CapacityPrecheckInput);
    const auth = await requireOrgAuth(req, id, "read");
    return assessCapacityForDivision(auth, divisionId, body);
  });
}
```

Confirm the existing `divisions/[divisionId]` route directory name before creating a new one — if this repo nests division routes differently, follow the existing tree.

- [ ] **Step 5: Register the wire schema**

`schemas.ts` holds wire schemas separately from usecase schemas (the sponsors pair proves they are not shared). Add a `CapacityPrecheck` request schema and a `CapacityReport` response schema there, then register the path in `openapi.ts` beside its neighbours at `:152`.

- [ ] **Step 6: Run tests and the drift gate**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/p10-calendars/apps/web && \
  npx vitest run --reporter=json --outputFile=/tmp/p10-t5.json src/server; echo EXIT=$?
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/p10-t5.json
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/p10-calendars && \
  npm run openapi:gen && git status --porcelain
```

`git status --porcelain` must be empty **after** you commit the regenerated spec — a non-empty result here means the generated file is not staged, not that the gate failed.

- [ ] **Step 7: Commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/p10-calendars && \
git add apps/web/src/app/api/v1/orgs apps/web/src/server apps/web/src/lib/capacity-input.ts && \
git commit -m "feat(capacity): assess capacity server-side so it can see court calendars

The precheck ran in the browser off the board payload, and P9 had stopped
shipping per-court calendars there after they blew the RSC budget — so it
treated every court as open all day and could only overstate supply. Computing
it on the server gets the calendars without putting them back on the wire.

The body carries the board's live unsaved state rather than being derived from
stored rows: previewing an edit that has not been saved is the only reason the
card exists.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Board consumes the endpoint

**Files:**
- Modify: `apps/web/src/components/v2/board/settings-panel.tsx:219-229`
- Modify: `apps/web/src/components/v2/stages-panel.tsx:282-288`, `:422-428`
- Modify: `apps/web/src/components/v2/board/capacity-card.tsx:51-66` (props)
- Create: `apps/web/src/lib/use-capacity-report.ts`
- Test: `apps/web/src/lib/use-capacity-report.test.ts`

**Interfaces:**
- Consumes: Task 5's `POST /api/v1/orgs/{id}/divisions/{divisionId}/capacity`.
- Produces: `useCapacityReport(orgId, divisionId, fixtures, config): { report: CapacityReport | null; stale: boolean }`; `CapacityCardProps` gains `stale?: boolean`.

- [ ] **Step 1: Load the design skill**

This is board UI. Invoke `frontend-design` before writing the stale state — the owner's standing rule is to use it, not cite it. The stale state must read as deliberate (the previous numbers, visibly de-emphasised) and never as an error or an empty card.

- [ ] **Step 2: Write the failing hook test**

```ts
it("keeps the previous report visible and marks it stale while refetching", async () => {
  const { result, rerender } = renderHook((props) => useCapacityReport(...props), { initialProps: first });
  await waitFor(() => expect(result.current.report).not.toBeNull());
  const before = result.current.report;
  rerender(second);
  expect(result.current.report).toBe(before);
  expect(result.current.stale).toBe(true);
});

it("debounces bursts of board edits into one request", async () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  const { rerender } = renderHook((props) => useCapacityReport(...props), { initialProps: first });
  for (const edit of edits) rerender(edit);
  await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
});
```

`useId()` throws in this repo's hook harness — if the hook needs an id, take it as a parameter instead. Mock `fetch` with `vi.stubGlobal`; a `vi.doMock` is inert if the module is statically imported.

- [ ] **Step 3: Run to verify it fails**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/p10-calendars/apps/web && \
  npx vitest run --reporter=json --outputFile=/tmp/p10-t6.json src/lib/use-capacity-report.test.ts; echo EXIT=$?
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/p10-t6.json
```

- [ ] **Step 4: Write the hook**

Debounce ~300ms, abort the in-flight request on a new edit via `AbortController`, hold the last successful report, expose `stale` while a request is outstanding or the inputs have changed since the held report. **No client-side fallback computation** — a fallback would be the fork this whole wave exists to close.

- [ ] **Step 5: Swap both call sites**

`settings-panel.tsx:219` and `stages-panel.tsx:422` drop their `useMemo` and read the hook. `capacityForStage` (`stages-panel.tsx:282`) either moves behind the hook per stage or the panel requests one report per stage — pick one and say which in the PR body. Delete `capacityForStage`'s now-dead client computation if nothing else calls it; an orphaned symbol after demolition is a regression.

- [ ] **Step 6: Run to verify it passes, then the whole apps/web suite**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/p10-calendars/apps/web && \
  npx vitest run --reporter=json --outputFile=/tmp/p10-web.json src; echo EXIT=$?
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/p10-web.json
```

Expected: zero failures. P9.5's boundary was 9430/0 — expect a number near that, and treat a large DROP in `total` as a collection failure, not a win.

- [ ] **Step 7: Screenshot the card at three widths**

1280, 768 and 320, each with no horizontal page scroll: the loaded state, the stale state, and the null-report state. Follow the `seazn-local-env` skill for the server; never port 3000 and never the dev DB.

- [ ] **Step 8: Commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/p10-calendars && \
git add apps/web/src/components/v2 apps/web/src/lib/use-capacity-report.ts apps/web/src/lib/use-capacity-report.test.ts && \
git commit -m "feat(board): read capacity from the server, holding the last report while stale

An instant local recompute becomes a debounced round trip. The card keeps the
previous numbers visibly de-emphasised rather than blanking, so an edit never
looks like a broken card. There is deliberately no client-side fallback
computation: a fallback is the placer/verifier fork wearing a different hat.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: E2E, smoke, and the close

**Files:**
- Modify: an existing e2e spec covering court tags/scheduling — `apps/web/e2e/court-tags-scheduling.spec.ts`
- Modify: `apps/web/e2e/mobile.spec.ts` (only if the capacity card's stale state needs width coverage)
- Modify: `docs/superpowers/specs/bench-product-value/portfolio-prompts/_INDEX.md:49`
- Modify: the smoke script covering scheduling

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the e2e**

Archive a court that holds a scheduled fixture, then assert the board shows the stranded conflict **and** that publishing is still permitted. Anchor assertions on `="` — a bare `data-*` probe passes in both states because React serialises an omitted prop as `"$undefined"`. Use `localhost`, never `127.0.0.1` (the secure cookie 401s otherwise).

- [ ] **Step 2: Run it against a prod build**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/p10-calendars/apps/web && \
  PLAYWRIGHT_BASE_URL=http://localhost:3100 npx playwright test e2e/court-tags-scheduling.spec.ts --reporter=list; echo EXIT=$?
```

cwd must be `apps/web` and the base URL must be set. Assert `lsof -ti:3100 -sTCP:LISTEN` is your own PID before trusting a pass — another session squatting the port serves a different build. Never dispatch a long e2e run to a subagent; the 600s watchdog kills it.

- [ ] **Step 3: Smoke on a calendared org**

Schedule a round on an org with court calendars and confirm the capacity card renders server numbers. The local smoke run skips the AI section — that is expected, not a failure.

- [ ] **Step 4: Run the gates BOTH ways**

Engine scheduling with live placement and without, per the standing P9 rule:

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/p10-calendars/packages/engine && \
  npx vitest run --reporter=json --outputFile=/tmp/p10-noplace.json src/scheduling; echo EXIT=$?
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/p10-noplace.json
```

then repeat with the placement service running. A live placement service masks greedy and apply defects, so a single green run proves less than it looks.

- [ ] **Step 5: Lint and typecheck**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/p10-calendars && rtk proxy npm run lint 2>&1 | tail -20
cd packages/engine && npx tsc --noEmit; echo EXIT=$?
cd ../../apps/web && NODE_OPTIONS=--max-old-space-size=6144 npx tsc --noEmit; echo EXIT=$?
```

Read `✖ N problems` from lint output directly. "ESLint output (JSON parse failed)" is the wrapper losing the result, not a clean run. Engine has its own lint task — root lint does not cover it.

- [ ] **Step 6: Update the index**

`_INDEX.md:49` — mark P10 DONE with a one-line outcome, and record in the status log, as discovered: P10's prompt scope items 1–2 were superseded by P9.5; the calendar editor was P8's; D3 was already satisfied by `schedule-health.ts:279-281`; `resolveCourtDay` was a fourth window copy outside the guard's reach; `person-merge.ts:382` was the one blind verify-config site.

- [ ] **Step 7: Commit and open the PR**

One PR for the session. The body names: unplanned fixes, the D2 latency trade-off, which stage-capacity approach Task 6 Step 5 chose, and any deferred test type with its reason. Then run `/code-review` — note it reviews `main` unless pointed at this worktree's diff.

- [ ] **Step 8: Write memory at the wave boundary**

Update `project_p9_scheduler_integration` and `project_p95_window_unification` to record P10 closed, and add reference memories for any new trap found. Run `scripts/agent-memory-snapshot.sh`.

---

## Self-Review

**Spec coverage:** §1 → Tasks 1, 3, 4. §2 → Task 2. §3 → Task 3. §4 → Tasks 5, 6. §5 → Task 7 Step 6 (recorded, not implemented). Testing section → Tasks 1–7, with e2e/smoke/both-ways gates in Task 7.

**Known soft spots**, flagged rather than papered over:
- Task 2 Step 5 names `scheduleWindowInputsForOrg` and `DEFAULT_MATCH_MINUTES`, which may not exist. The step says to grep for the existing resolver first and only add a local helper if nothing fits — it must not become a second window computation.
- Task 4 Step 1 cannot name the enrichment site because the scout found the formatter reads `d.courtName` while the engine pushes `court`; the grep is given instead of a guessed path.
- Task 6 Step 5 leaves one genuine choice open (per-stage hook vs one report per stage) because it depends on how `stages-panel` batches; the PR body must record which was taken.
