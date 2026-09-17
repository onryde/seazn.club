import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  TAG,
  activeOrgIdFromRequest,
  addEntrantsViaApi,
  apiJson,
  createStageAndGenerate,
  divisionPath,
  expectNoHorizontalScroll,
  screenshotAtWidths,
  seedVenueWithCourts,
} from "../helpers";

// The organiser's scheduling day, tapped end to end. Setup reaches the state
// through the API; every step below that IS the thing under test is tapped,
// typed or submitted, and the system's own record is read back after it.
test.describe.configure({ mode: "serial" });

/** Every label and door name below comes from the dictionary, never from an
 *  English literal typed into this file: a test that retypes the copy cannot
 *  notice the copy changing under it. `readFileSync` rather than a JSON
 *  `import`, which needs an import attribute Playwright's loader does not
 *  supply — the same shape `competition-desk-actions.spec.ts` uses. */
const en: Record<string, string> = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
);

/**
 * THE SOLVE BUDGET, derived from the solver's own declared wall.
 *
 * `autoSolverWallMs()` (server/usecases/schedule.ts:1992) resolves the ask as
 * `PLACEMENT_WALL_SECONDS`, or a documented default of 10 seconds; the service
 * then applies its own independent `min()` ceiling, so the caller's ask is
 * always an UPPER bound on what a board is actually granted. Measured against
 * the live service, a six-fixture board spends that whole wall
 * (`granted_wall_seconds: 10.0`, `solver_elapsed_ms: 10030`), so this is a real
 * cost and not a safety margin — and a flat literal beside it would be a latent
 * red the moment the wall moves (AGENTS.md §20).
 *
 * MIRRORED, not imported: `autoSolverWallMs` lives in a server module that
 * cannot be pulled into a Playwright spec. Exporting the constant from a leaf
 * the way `HOLD_MS` and `NOT_RECORDING_GRACE_MINUTES` already are is the
 * product change this wants — recorded in task-4-fix-1.md rather than made here.
 */
const SOLVER_WALL_SECONDS_DEFAULT = 10;

/**
 * TOTAL BY CONSTRUCTION — it never throws, because it is called at MODULE
 * SCOPE and `test.setTimeout` below needs its value at declaration time.
 *
 * A throw here would be the worst available failure mode: Playwright collects
 * ZERO tests from a file whose module body throws, and the JSON reporter then
 * emits `suites: 0, expected: 0, unexpected: 0` — which any gate reading
 * `unexpected === 0` scores as a PASS. Measured, not reasoned:
 * `PLACEMENT_WALL_SECONDS=oops` on this file produced exactly that shape.
 * So a malformed value falls back to the documented default and is reported
 * as a `fault` string instead, which the test's first act asserts is absent
 * (beside the budget assertion, which already states this same rule six
 * lines below). Wrong-but-legible budget, RED test — never zero tests.
 *
 * `raw.trim() === ""` runs before `Number(raw)` on purpose: `Number("")` and
 * `Number("   ")` are both `0`, so a blank variable would otherwise be read
 * as a zero-second wall rather than as "unset".
 */
function solverWall(): { ms: number; fault: string | null } {
  const raw = process.env.PLACEMENT_WALL_SECONDS;
  if (raw === undefined || raw.trim() === "") {
    return { ms: SOLVER_WALL_SECONDS_DEFAULT * 1_000, fault: null };
  }
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return {
      ms: SOLVER_WALL_SECONDS_DEFAULT * 1_000,
      fault: `PLACEMENT_WALL_SECONDS must be a finite number > 0, got ${JSON.stringify(raw)}`,
    };
  }
  return { ms: Math.round(seconds * 1_000), fault: null };
}
const SOLVER_WALL = solverWall();

// Budget: fourteen tapped steps, no deliberate waits, one solve. DERIVED, so
// that adding a step or moving the solver's wall moves the budget with it
// rather than leaving a flat constant to red under it.
const STEPS = 14;
const PER_STEP_MS = 4_000;
/** Two solver walls plus slack: one for the solve itself, one because the strip
 *  only paints after the round trip has been persisted and re-rendered. */
const SOLVE_MS = 2 * SOLVER_WALL.ms + 5_000;
const TEST_BUDGET_MS = STEPS * PER_STEP_MS + SOLVE_MS;
/** The OWNER'S constraint on this leg, and the reason the journey is four
 *  entrants and one solve. Asserted as the test's first act (not thrown at
 *  module scope, where a load-time failure reports as ZERO collected tests
 *  rather than as a red one), so the next person to add a step or raise the
 *  solver's wall gets a legible failure instead of silent drift. */
const HARD_BUDGET_MS = 90_000;
test.setTimeout(TEST_BUDGET_MS);

/** The standing UI bar: desktop, tablet and the narrowest phone. */
const FINAL_WIDTHS = [1280, 768, 320];

// ---------------------------------------------------------------- the clock
//
// Every wall-clock value below is typed into the product on the VENUE clock and
// read back from the product's own stored ISO, so this spec never converts a
// zone itself. `DAY0` is only "a date the organiser picked": far enough out to
// be in the future in every zone, inside the competition window seeded below.
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const DAY0 = ymd(Date.now() + 30 * 86_400_000);
const LAST_DAY = ymd(Date.now() + 35 * 86_400_000);
const PLAY_FROM = "09:00";
const PLAY_TO = "17:00";
const MATCH_MINUTES = 45;
const GAP_MINUTES = 15;
const REST_MIN = 60;
const MAX_PER_DAY = 2;
// Lower-cased at the door (`normalizeTags`), so this is what comes back.
const COURT_TAG = `swt-${TAG}`;
/** The roster, and therefore the fixture count: one league fixture per
 *  unordered pair. Every count below is derived from this array's length. */
const ENTRANT_NAMES = [`Ada ${TAG}`, `Bo ${TAG}`, `Cleo ${TAG}`, `Dev ${TAG}`];

// ------------------------------------------------------------ the record
interface HardRule {
  type: string;
  count?: number;
  scope?: { kind?: string; divisionId?: string };
}
interface StoredConstraints {
  restMin?: number;
  noBackToBack?: boolean;
  fieldFairness?: string;
  crossPersonClash?: string;
  hard?: HardRule[];
}
interface StoredConfig {
  matchMinutes?: number;
  gapMinutes?: number;
  courts?: string[];
  startAt?: string | null;
  endAt?: string | null;
  sessionWindows?: { from: string; to: string }[];
  blackouts?: { court?: string; from: string; to: string }[];
  constraints?: StoredConstraints;
}

let divisionId = "";
let competitionId = "";
let base = "";
let divisionBase = "";
let courtIds: string[] = [];
let taggedCourtId = "";
let fixtureIds: string[] = [];

// SHARED-STATE SAFETY. This spec FREEZES a division on a server every other
// spec in the leg shares. On Playwright a test TIMEOUT skips try/finally
// entirely — only afterEach/afterAll run — so a cleanup written as
// `try { … } finally { unfreeze() }` leaks a frozen division on exactly the
// failure most likely to happen, and every later spec touching that division
// then reds with a 422 that has nothing to do with its own change.
// Put the thaw in afterAll, never in finally, and make it idempotent.
//
// And the thaw must VERIFY itself. `apiJson` (helpers.ts:122-139) resolves on
// any status — it never throws on a non-2xx — so a bare `.catch(() => {})`
// around it makes a 403, a 422 and a 500 indistinguishable from success, and
// the leak this hook exists to prevent happens silently. Check the status,
// then re-READ the lock state, and say so loudly in the log if it is still
// locked. Never throw from here: an afterAll that throws masks the test's own
// failure, which is the thing the next person actually needs to read.
test.afterAll(async ({ request }) => {
  if (!divisionId) return;
  try {
    const patch = await apiJson(request, `/api/v1/divisions/${divisionId}/locks`, "PATCH", {
      schedule_locked: false,
    });
    const after = await apiJson<{ schedule_locked: boolean }>(
      request,
      `/api/v1/divisions/${divisionId}`,
    );
    const stillLocked = after.data?.schedule_locked !== false;
    if (patch.status >= 300 || stillLocked) {
      console.error(
        `[scheduling-organiser-day] THAW FAILED for division ${divisionId} — ` +
          `PATCH /locks → ${patch.status} ${JSON.stringify(patch.error ?? {})}, ` +
          `read-back schedule_locked=${JSON.stringify(after.data?.schedule_locked)} ` +
          `(GET → ${after.status}). A division left frozen on this shared server will ` +
          `red later specs with a 422 that has nothing to do with their own change; ` +
          `unfreeze it by hand.`,
      );
    }
  } catch (err) {
    console.error(`[scheduling-organiser-day] THAW THREW for division ${divisionId}: ${String(err)}`);
  }
});

async function goTab(page: Page, path: string, tab: string): Promise<void> {
  await page.goto(`${path}?tab=${tab}`);
  await expect(page.getByRole("main")).toBeVisible();
}

// The division's stored scheduling config — the record every constraints and
// settings assertion reads back. One GET, no caching: the panel writes
// read-modify-write, so a stale copy would hide exactly the races this sweeps.
async function readConfig(
  request: APIRequestContext,
  id: string,
): Promise<StoredConfig> {
  const { data } = await apiJson<{ config: StoredConfig }>(
    request,
    `/api/v1/divisions/${id}/schedule-settings`,
  );
  return data?.config ?? {};
}

// The system's own record of the board, ordered so `toEqual` is meaningful.
// Restore must return every slot to the same time AND the same court, so the
// shape carries both — a count-only read cannot see a court swap.
type Slot = { id: string; at: string; court: string | null };
async function scheduledSlots(request: APIRequestContext, id: string): Promise<Slot[]> {
  const { status, data } = await apiJson<
    { id: string; scheduled_at: string | null; court_id: string | null }[]
  >(request, `/api/v1/divisions/${id}/fixtures`);
  if (status !== 200) throw new Error(`GET /divisions/${id}/fixtures → ${status}`);
  return (data ?? [])
    .filter((f) => f.scheduled_at !== null)
    .map((f) => ({ id: f.id, at: f.scheduled_at!, court: f.court_id }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function divisionRow(
  request: APIRequestContext,
  id: string,
): Promise<{ status: string; schedule_locked: boolean; required_court_tags: string[] }> {
  const { data } = await apiJson<{
    status: string;
    schedule_locked: boolean;
    required_court_tags: string[];
  }>(request, `/api/v1/divisions/${id}`);
  if (!data) throw new Error(`GET /divisions/${id} returned no row`);
  return data;
}

test.beforeAll(async ({ request }) => {
  const orgId = await activeOrgIdFromRequest(request);

  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    name: `Scheduling Day ${TAG}`,
    visibility: "public",
    // No `starts_on`: the settings panel's date pickers carry the competition
    // window as min/max, and an unset floor is what lets DAY0 be any future day.
    ends_on: "2030-12-31",
  });
  if (!comp.data) throw new Error(`competition → ${comp.status} ${JSON.stringify(comp.error)}`);
  competitionId = comp.data.id;

  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${competitionId}/divisions`,
    "POST",
    { name: `Open Singles ${TAG}`, sport_key: "badminton", variant_key: "bwf" },
  );
  if (!div.data) throw new Error(`division → ${div.status} ${JSON.stringify(div.error)}`);
  divisionId = div.data.id;

  // Two venues, one court each, both named "Court 1" — legal (the unique index
  // is per-venue) and the only way the venue-qualified naming in the court
  // picker and the blackout scope select is exercised at all.
  const riverside = await seedVenueWithCourts(request, ["Court 1"], {
    orgId,
    venueName: `Riverside Hall ${TAG}`,
  });
  const northside = await seedVenueWithCourts(request, ["Court 1"], {
    orgId,
    venueName: `Northside Annexe ${TAG}`,
  });
  courtIds = [riverside.courts[0]!.id, northside.courts[0]!.id];
  taggedCourtId = courtIds[0]!;
  // ONE of the two courts carries the tag. That asymmetry is what turns step 2
  // from "a PATCH round-trips" into a proof the requirement reaches the solver:
  // `candidateCourts` (packages/engine) drops every court missing a required
  // tag, so step 8's board must land entirely on this one.
  const tagged = await apiJson(
    request,
    `/api/v1/orgs/${orgId}/courts/${taggedCourtId}`,
    "PATCH",
    { tags: [COURT_TAG] },
  );
  if (tagged.status !== 200) {
    throw new Error(`court tag → ${tagged.status} ${JSON.stringify(tagged.error)}`);
  }

  // Four entrants in a league is six fixtures — enough to exercise rest and the
  // per-day cap, small enough to solve fast. The budget is the design
  // constraint here, not an afterthought.
  const entrants = await addEntrantsViaApi(request, divisionId, ENTRANT_NAMES);
  if (entrants.status >= 300) throw new Error(`entrants → ${entrants.status}`);
  ({ fixtureIds } = await createStageAndGenerate(request, divisionId));
  // Derived from the entrants THIS setup created — a single round robin is one
  // fixture per unordered pair. A literal here would have to be re-typed the
  // moment the roster changes, and would then be asserting yesterday's number.
  expect(fixtureIds).toHaveLength((ENTRANT_NAMES.length * (ENTRANT_NAMES.length - 1)) / 2);

  // `divisionPath` is two localhost GETs and is deliberately not cached, so it
  // is resolved once here and reused rather than called per step.
  divisionBase = await divisionPath(request, divisionId);
  base = `${divisionBase}/schedule`;
});

test("the organiser sets up, schedules, saves, clears, restores, freezes and publishes", async ({
  page,
  request,
}, testInfo) => {
  // ---------------------------------------------------------------- 0
  // The budget, before anything spends it. This leg is the e2e workflow's
  // wall-clock floor and 90s is the owner's constraint on it, so the derived
  // allowance is asserted against that ceiling rather than merely being
  // written down beside it: add a step, or raise PLACEMENT_WALL_SECONDS, and
  // this reds with the arithmetic instead of drifting quietly over.
  //
  // The wall the budget is DERIVED FROM is validated here, in the same first
  // act and for the same reason: `solverWall()` cannot throw at module scope
  // without reducing this whole file to zero collected tests, so it reports a
  // malformed `PLACEMENT_WALL_SECONDS` as a fault string and the assertion
  // lives where a failure is a RED TEST. Asserted BEFORE the arithmetic below,
  // because a fallback wall makes that arithmetic answer about the wrong wall.
  expect(SOLVER_WALL.fault, String(SOLVER_WALL.fault)).toBeNull();
  expect(
    TEST_BUDGET_MS,
    `derived budget ${TEST_BUDGET_MS}ms = ${STEPS} steps x ${PER_STEP_MS}ms + ${SOLVE_MS}ms solve, ` +
      `over the ${HARD_BUDGET_MS}ms this leg is allowed. Cut steps or entrants, not assertions.`,
  ).toBeLessThanOrEqual(HARD_BUDGET_MS);

  // ---------------------------------------------------------------- 1
  // Required courts, on their own Courts tab (moved off Settings 2026-09-17
  // — settings-panel.tsx's `showCourts` prop), then the clock on Settings.
  await goTab(page, base, "courts");
  for (const id of courtIds) {
    await page.getByTestId("court-option").and(page.locator(`[data-court-id="${id}"]`)).check();
  }
  await page.getByRole("button", { name: en["boardset.save"]! }).click();
  await expect
    .poll(async () => [...((await readConfig(request, divisionId)).courts ?? [])].sort())
    .toEqual([...courtIds].sort());

  await goTab(page, base, "settings");

  // `DateTimeField kind="datetime-local"` renders TWO controls — a native date
  // input plus a quarter-hour `<select>` — and deliberately exposes no bare
  // handle on either half. The date input carries the field's visible label;
  // the select is renamed "Time" so it does not read as a second copy of it.
  await page.getByLabel(en["boardset.startAt"]!).fill(DAY0);
  await page.getByRole("combobox", { name: en["datetime.timeLabel"]! }).selectOption(PLAY_FROM);
  await page.getByLabel(en["boardset.endAt"]!).fill(LAST_DAY);

  // TRAP (Task 3 review): `settings-day-start` / `settings-day-end` live in the
  // ELSE branch of `customWindows ? <p> : …` (board/settings-panel.tsx:539). A
  // division whose stored sessionWindows are non-uniform renders a read-only
  // "custom windows" paragraph and NEITHER field. The seed above leaves
  // sessionWindows empty, so both render — asserted before either is driven,
  // because a missing element here means the seed drifted, not that the fill
  // failed. Both testids sit on a WRAPPER DIV (DateTimeField takes no testid
  // prop and `kind="time"` renders a `<select>`), hence `.locator("select")`.
  await expect(page.getByTestId("settings-day-start")).toBeAttached();
  await expect(page.getByTestId("settings-day-end")).toBeAttached();
  await page.getByTestId("settings-day-start").locator("select").selectOption(PLAY_FROM);
  await page.getByTestId("settings-day-end").locator("select").selectOption(PLAY_TO);

  await page.getByTestId("settings-match-minutes").fill(String(MATCH_MINUTES));
  await page.getByTestId("settings-gap-minutes").fill(String(GAP_MINUTES));
  // `boardset.save`, not /save/i: the blackout editor's own button is
  // `constraints.blackout.save` and a loose name matcher stops meaning one
  // control the moment a second Save appears on the panel.
  await page.getByRole("button", { name: en["boardset.save"]! }).click();

  // The whole panel commits behind that ONE Save, so the record is read once
  // for everything it wrote.
  await expect
    .poll(async () => {
      const c = await readConfig(request, divisionId);
      return {
        matchMinutes: c.matchMinutes,
        gapMinutes: c.gapMinutes,
        courts: [...(c.courts ?? [])].sort(),
        days: c.sessionWindows?.length ?? 0,
      };
    })
    .toEqual({
      matchMinutes: MATCH_MINUTES,
      gapMinutes: GAP_MINUTES,
      courts: [...courtIds].sort(),
      // Six play days: DAY0 through LAST_DAY inclusive. Derived from the two
      // dates typed above, not from a number written into the test.
      days: (Date.parse(`${LAST_DAY}T00:00:00Z`) - Date.parse(`${DAY0}T00:00:00Z`)) / 86_400_000 + 1,
    });

  // The play-hours pair is what turns the clock into a window the solver obeys
  // (session windows reduce to blackouts in `calendar.ts`), so its FIRST day is
  // read back and reused as the blackout in step 7 — the product's own
  // interpretation of "09:00 on DAY0", never a zone conversion done here.
  const settingsConfig = await readConfig(request, divisionId);
  const day0Window = settingsConfig.sessionWindows![0]!;
  expect(Date.parse(day0Window.to)).toBeGreaterThan(Date.parse(day0Window.from));

  // ---------------------------------------------------------------- 2
  // Required court tags. Not on /schedule at all — this is the division's own
  // Settings tab (division-settings.tsx), PATCH /divisions/{id}. The run
  // sheet's `stage-court-tags` is a different surface and a different wave's.
  //
  // SCOPED to `division-settings`, deliberately. `divset.requiredTags.title`
  // and `stagetags.title` are the SAME STRING in the dictionary
  // ("Required court tags", ui.json:2276 and :2261) — a page-wide name lookup
  // is a strict-mode red waiting for the day the stage editor shares a screen
  // with this one.
  await goTab(page, divisionBase, "settings");
  const divSettings = page.getByTestId("division-settings");
  await divSettings.getByRole("button", { name: en["divset.requiredTags.title"]! }).click();
  const tagInput = divSettings.getByLabel(en["tags.placeholder"]!);
  await tagInput.fill(COURT_TAG);
  await tagInput.press("Enter");
  // The chip is the panel's own statement that the tag was taken, before any
  // Save — without it a refused entry saves an empty list and still reads green
  // against a division that had no tags to begin with. Addressed by the chip's
  // own remove control, whose accessible name interpolates the tag
  // (`tags.remove`): the chip `<li>` itself also contains the button's "×", so
  // an exact text match on the tag never resolves.
  await expect(
    divSettings.getByRole("button", { name: en["tags.remove"]!.replace("{tag}", COURT_TAG) }),
  ).toBeVisible();
  await divSettings.getByRole("button", { name: en["divset.requiredTags.save"]! }).click();
  await expect
    .poll(async () => (await divisionRow(request, divisionId)).required_court_tags)
    .toEqual([COURT_TAG]);

  // ---------------------------------------------------------------- 3
  // The constraint matrix, swept as a TABLE. The dimension worth sweeping is
  // COMMIT SEMANTICS, which differ per control type and which a
  // fill-everything-then-Save pass sails straight past.
  //
  // What each control OPENS AT. A reachability assertion is satisfied by any
  // value; these defaults are what a regression actually moves.
  await goTab(page, base, "constraints");
  await expect(page.getByTestId("constraint-min-rest")).toHaveValue("0");
  await expect(page.getByTestId("constraint-max-per-day")).toHaveValue("");
  await expect(page.getByTestId("constraint-field-fairness")).toHaveValue("off");
  await expect(page.getByTestId("constraint-cross-person-clash")).not.toBeChecked();
  await expect(page.getByTestId("constraint-no-back-to-back")).not.toBeChecked();

  // ---------------------------------------------------------------- 4
  // Checkboxes and selects commit INSTANTLY on change, no blur. One at a time:
  // every write here is a read-modify-write of the whole `constraints` object.
  //
  // `.click()`, never `.check()`: these controls carry NO optimistic state.
  // `checked` is `constraints.crossPersonClash === "hard"` and `constraints` is
  // only set inside `saveConstraints`'s success callback, so the box does not
  // move until a GET-then-PUT round trip has landed — and `check()`, which
  // verifies the state changed the moment it clicks, fails on a control that is
  // behaving correctly. Both halves are then asserted: the record, and the box
  // catching up to it.
  await page.getByTestId("constraint-cross-person-clash").click();
  await expect
    .poll(async () => (await readConfig(request, divisionId)).constraints?.crossPersonClash)
    .toBe("hard");
  await expect(page.getByTestId("constraint-cross-person-clash")).toBeChecked();
  await page.getByTestId("constraint-no-back-to-back").click();
  await expect
    .poll(async () => (await readConfig(request, divisionId)).constraints?.noBackToBack)
    .toBe(true);
  await expect(page.getByTestId("constraint-no-back-to-back")).toBeChecked();
  await page.getByTestId("constraint-field-fairness").selectOption("rotate");
  await expect
    .poll(async () => (await readConfig(request, divisionId)).constraints?.fieldFairness)
    .toBe("rotate");
  await expect(page.getByTestId("constraint-field-fairness")).toHaveValue("rotate");

  // ---------------------------------------------------------------- 5
  // Number fields are draft-then-commit. THIS is the differential case: typing
  // alone must issue ZERO writes. A test that fills and immediately polls would
  // pass on a panel that committed on every keystroke — which is the regression
  // the queue in constraints-panel.tsx exists to prevent. The save-pulse is
  // read too: it is the panel's own client-side statement that it saved, so the
  // negative does not rest on a race with one HTTP round trip.
  const restField = page.getByTestId("constraint-min-rest");
  const restSaved = page.locator("#rest-min-saved");

  // 5a — THE POSITIVE PAIR FIRST. A probe that has only ever been asserted
  // EMPTY has never been shown to work: it would read green against a marker
  // that is broken, renamed, or permanently blank, and the negative below
  // would then prove nothing at all. So commit for real, watch the marker
  // appear, and only then trust its silence.
  await restField.fill(String(REST_MIN));
  await restField.blur();
  await expect(restSaved).toHaveText(en["constraints.field.saved"]!);
  await expect
    .poll(async () => (await readConfig(request, divisionId)).constraints?.restMin)
    .toBe(REST_MIN);

  // 5b — then WAIT ON THE TRANSITION back to empty, not on a bare timeout.
  // `useSavedPulse` clears itself after its own interval, so this assertion
  // spends exactly that long and lands on a panel that is provably idle — the
  // settled baseline the negative below needs, and the reason it is not racing
  // an in-flight save left over from 5a.
  await expect(restSaved).toHaveText("");

  // 5c — THE NEGATIVE, from that baseline: typing alone must issue ZERO
  // writes. A test that filled and immediately polled would pass on a panel
  // that committed on every keystroke, which is the regression the save queue
  // in constraints-panel.tsx exists to prevent. Bounded by two real round
  // trips rather than a sleep: an immediate per-keystroke commit (the shape
  // this panel actually used to have) lands inside the first one.
  const typed = String(REST_MIN + 15);
  const beforeTyping = await readConfig(request, divisionId);
  await restField.fill(typed);
  await expect(restField).toHaveValue(typed);
  expect(await readConfig(request, divisionId)).toEqual(beforeTyping);
  await expect(restSaved).toHaveText("");
  expect(await readConfig(request, divisionId)).toEqual(beforeTyping);
  await expect(restSaved).toHaveText("");

  // 5d — and the commit still works from there, marker and record together.
  await restField.blur();
  await expect(restSaved).toHaveText(en["constraints.field.saved"]!);
  await expect
    .poll(async () => (await readConfig(request, divisionId)).constraints?.restMin)
    .toBe(REST_MIN + 15);

  // `Number("") === 0` in JS, so an EMPTY numeric input reads as a valid zero
  // rather than as missing. `restMin` is coerced with `Math.max(0, Number(v))`,
  // so clearing it writes 0 — which the engine reads as "no rest floor", not as
  // "unset". Pinned rather than softened: this is what the product MEANS by a
  // cleared field, and a change to it is a change of meaning.
  await page.getByTestId("constraint-min-rest").fill("");
  await page.getByTestId("constraint-min-rest").blur();
  await expect
    .poll(async () => (await readConfig(request, divisionId)).constraints?.restMin)
    .toBe(0);
  await page.getByTestId("constraint-min-rest").fill(String(REST_MIN));
  await page.getByTestId("constraint-min-rest").blur();
  await expect
    .poll(async () => (await readConfig(request, divisionId)).constraints?.restMin)
    .toBe(REST_MIN);

  // ---------------------------------------------------------------- 6
  // The one hard[] rule an organiser can actually express, committed with Enter
  // rather than blur, and carrying the division scope the panel hard-codes.
  // Note the address: `config.constraints.hard`, NOT `config.hard` — the panel
  // writes `saveConstraints(c => ({ ...c, hard: … }))` and `savePatch` stores
  // that object under `constraints`.
  await page.getByTestId("constraint-max-per-day").fill(String(MAX_PER_DAY));
  await page.getByTestId("constraint-max-per-day").press("Enter");
  await expect
    .poll(async () => {
      const rule = (await readConfig(request, divisionId)).constraints?.hard?.find(
        (h) => h.type === "max_fixtures_per_day",
      );
      return rule ? [rule.count, rule.scope?.kind, rule.scope?.divisionId] : null;
    })
    .toEqual([MAX_PER_DAY, "division", divisionId]);

  // The inverse direction. Clearing the field DELETES the rule; a guard checked
  // in one direction only is half tested.
  await page.getByTestId("constraint-max-per-day").fill("");
  await page.getByTestId("constraint-max-per-day").press("Enter");
  await expect
    .poll(async () =>
      ((await readConfig(request, divisionId)).constraints?.hard ?? []).some(
        (h) => h.type === "max_fixtures_per_day",
      ),
    )
    .toBe(false);
  // Put it back — the board below is solved against it.
  await page.getByTestId("constraint-max-per-day").fill(String(MAX_PER_DAY));
  await page.getByTestId("constraint-max-per-day").press("Enter");
  await expect
    .poll(async () =>
      ((await readConfig(request, divisionId)).constraints?.hard ?? []).some(
        (h) => h.type === "max_fixtures_per_day",
      ),
    )
    .toBe(true);

  // ---------------------------------------------------------------- 7
  // A blackout created THROUGH THE UI. Nothing had ever done this.
  //
  // Scope is a FLAT court list plus "" meaning everywhere (division-wide);
  // there is no venue-wide option, so no assertion here assumes one. Blackouts
  // are all-or-nothing behind ONE Save, and that Save only renders while the
  // collection is dirty. `blackout-from`/`blackout-to` are wrapper divs around
  // a date input + a quarter-hour select, so each half is addressed separately
  // — a locator matching one of them alone would be addressing half a value.
  //
  // The window is DAY0's whole play day: the first slot the solver would
  // otherwise fill. Typed on the venue clock in the same words step 1 used.
  await page.getByTestId("blackout-add").click();
  const row = page.getByTestId("blackout-row").first();
  await expect(row.getByTestId("blackout-court")).toHaveValue(""); // opens at everywhere
  await row.getByTestId("blackout-from").locator('input[type="date"]').fill(DAY0);
  await row.getByTestId("blackout-from").locator("select").selectOption(PLAY_FROM);
  await row.getByTestId("blackout-to").locator('input[type="date"]').fill(DAY0);
  await row.getByTestId("blackout-to").locator("select").selectOption(PLAY_TO);
  await page.getByTestId("blackout-save").click();
  await expect(page.getByTestId("blackout-row")).toHaveCount(1);
  await expect
    .poll(async () => (await readConfig(request, divisionId)).blackouts?.length ?? 0)
    .toBe(1);

  // The instants the PRODUCT stored for what was just typed. Every board
  // assertion below reads these, never a constant re-derived here — so the test
  // cannot disagree with the panel about which hour "09:00" was.
  const stored = (await readConfig(request, divisionId)).blackouts![0]!;
  expect(Date.parse(stored.from)).toBe(Date.parse(day0Window.from));
  expect(Date.parse(stored.to)).toBe(Date.parse(day0Window.to));
  // "" is stored as an ABSENT key, not as an empty string — and that claim
  // needs its POSITIVE pair, or it is equally satisfied by a panel that never
  // writes `court` at all and silently drops every court-scoped window. So
  // scope the row to a real court, read the key back, and only then put it
  // back to everywhere. The last of the three is the state step 8 solves
  // against, so the round trip also leaves the board where it was.
  expect(Object.keys(stored).sort()).toEqual(["from", "to"]);
  await row.getByTestId("blackout-court").selectOption(taggedCourtId);
  await page.getByTestId("blackout-save").click();
  await expect
    .poll(async () => (await readConfig(request, divisionId)).blackouts?.[0]?.court)
    .toBe(taggedCourtId);
  await row.getByTestId("blackout-court").selectOption("");
  await page.getByTestId("blackout-save").click();
  await expect
    .poll(async () =>
      Object.keys((await readConfig(request, divisionId)).blackouts?.[0] ?? {}).sort(),
    )
    .toEqual(["from", "to"]);

  const blackoutFrom = Date.parse(stored.from);
  const blackoutTo = Date.parse(stored.to);

  // ---------------------------------------------------------------- 8
  // Solve. Assert what holds for BOTH producers: with the placement service
  // down this takes the greedy path and lands a different board, so this
  // asserts the blackout is respected, the court requirement is honoured and a
  // provenance is reported — never a specific arrangement. And `config.startAt`
  // is NOT the solver's floor: a CP-SAT board legitimately places earlier than
  // it, so nothing here says otherwise.
  await goTab(page, base, "board");
  await page.getByTestId("schedule-auto").click();
  await page.getByTestId("schedule-rebuild-confirm").click();
  const strip = page.getByTestId("schedule-result-strip");
  await expect(strip).toBeVisible({ timeout: SOLVE_MS });

  // Which engine produced the board is ENVIRONMENTAL and is reported, never
  // asserted: `data-engine` names where the BOARD came from, not which solver
  // ran, so "greedy" is the ordinary answer on a small board even with CP-SAT
  // live (build.ts:2330-2392 ships the greedy seed whenever the service's reply
  // does not strictly beat it). Every claim below holds for both producers.
  const engine = await strip.getAttribute("data-engine");
  expect(engine === "greedy" || engine === "optimized", `unknown engine ${engine}`).toBe(true);
  testInfo.annotations.push({ type: "solver-engine", description: String(engine) });

  // The provenance line is `<engine> · <elapsed> · <churn>`. `not.toBeEmpty()`
  // pinned nothing — a single stray character satisfied it — so pin the SHAPE
  // and the engine label the strip chose, read out of the dictionary rather
  // than retyped, so a reworded label moves this with it.
  const provenance = page.getByTestId("schedule-result-provenance");
  await expect(provenance).toContainText(en[`board.result.engine.${engine}`]!);
  expect((await provenance.textContent())?.split(" · ")).toHaveLength(3);

  const placed = await scheduledSlots(request, divisionId);
  // Every generated fixture placed. Derived from the setup's own fixture list,
  // and carrying its own diagnosis: a partial board is a real defect, but it
  // reads as a bare count mismatch unless the strip's status is quoted beside
  // it (AGENTS.md §20 — the misleading line comes first).
  expect(
    placed.length,
    `${placed.length} of ${fixtureIds.length} fixtures placed; ` +
      `strip reports status=${await strip.getAttribute("data-status")} engine=${engine}`,
  ).toBe(fixtureIds.length);
  const matchMs = MATCH_MINUTES * 60_000;
  for (const slot of placed) {
    const startsAt = Date.parse(slot.at);
    // `courtBlocked` compares [start, start+matchMinutes) against the window,
    // so the assertion is an interval overlap, not a start-instant containment.
    expect(
      startsAt < blackoutTo && startsAt + matchMs > blackoutFrom,
      `fixture overlaps the blacked-out window: ${slot.at}`,
    ).toBe(false);
    // The required court tag reached the solver: only one of the two configured
    // courts carries it, so the whole board must sit on that one.
    expect(slot.court, `fixture placed on an untagged court: ${slot.at}`).toBe(taggedCourtId);
  }

  // ---------------------------------------------------------------- 9
  // The wait report NAMES the entrant it claims. Run after the solve on
  // purpose: on an unscheduled board `worst` is empty and the panel renders its
  // "no waits yet" branch, which would make this step assert nothing. The
  // expected name comes from the same report the panel renders, so a change to
  // the source of truth moves the test with it.
  await goTab(page, base, "constraints");
  await page.getByTestId("wait-report-check").click();
  const result = page.getByTestId("wait-report-result");
  // `toBeVisible()` alone is VACUOUS here: `wait-report-result` sits on BOTH
  // branches (constraints-panel.tsx:1037 the "no waits yet" <p>, :1039 the
  // results table), so it means only "a report came back, in either shape".
  // Assert what separates them — the table, by its own aria-label — and that
  // the empty-state sentence is not the thing on screen.
  await expect(result.getByRole("table", { name: en["constraints.waitReport.tableAriaLabel"]! }))
    .toBeVisible();
  await expect(result).not.toHaveText(en["constraints.waitReport.empty"]!);

  const { status: reportStatus, data: report } = await apiJson<{
    worst: { display_name?: string; fixtures?: number }[];
  }>(request, `/api/v1/divisions/${divisionId}/schedule/report`);
  expect(reportStatus).toBe(200);
  const worst = report?.worst ?? [];
  expect(worst.length).toBeGreaterThan(0);
  // The key has to EXIST before its value is asserted: `toContainText(undefined)`
  // and its relatives pass against a payload that simply stopped carrying the
  // field, which is the shape a rename ships.
  const worstRow = worst[0]!;
  expect(Object.keys(worstRow)).toContain("display_name");
  const worstName = worstRow.display_name!;
  expect(typeof worstName).toBe("string");
  expect(worstName.length).toBeGreaterThan(0);
  await expect(result).toContainText(worstName);

  // ---------------------------------------------------------------- 10
  // A save point, made by hand.
  await goTab(page, base, "history");
  await page.getByTestId("savepoint-label").fill(`before-clear ${TAG}`);
  await page.getByTestId("savepoint-create").click();
  await expect(page.getByTestId("checkpoint-row")).toHaveCount(1);
  const checkpointId = await page.getByTestId("checkpoint-row").getAttribute("data-checkpoint-id");
  expect(checkpointId).toBeTruthy();

  // ---------------------------------------------------------------- 11
  // Clear. The panel reports NO counts for it — no "N cleared, M skipped" — so
  // the board's emptiness is read from the system's own record rather than from
  // a number on screen that does not exist.
  await page.getByTestId("schedule-clear").click();
  await page
    .getByRole("alertdialog", { name: en["confirm.clearSlots.title"]! })
    .getByRole("button", { name: en["confirm.clearSlots.label"]! })
    .click();
  await expect.poll(async () => (await scheduledSlots(request, divisionId)).length).toBe(0);

  // ---------------------------------------------------------------- 12
  // Restore, to exactly what step 8 produced. The `toEqual(placed)` is the
  // assertion that matters: every slot back at the same time AND the same
  // court, not merely the same count.
  await page.getByTestId("checkpoint-restore").first().click();
  await page
    .getByRole("alertdialog", { name: en["confirm.restoreCheckpoint.title"]! })
    .getByRole("button", { name: en["confirm.restoreCheckpoint.label"]!, exact: true })
    .click();
  await expect
    .poll(async () => (await scheduledSlots(request, divisionId)).length)
    .toBe(placed.length);
  expect(await scheduledSlots(request, divisionId)).toEqual(placed);

  // ---------------------------------------------------------------- 13
  // Freeze — and the refusal, asserted in BOTH halves. A disabled button proves
  // only that this client declines to ask; it passes against a server that
  // still wipes the board.
  await goTab(page, base, "board");
  await page.getByTestId("board-freeze").click();
  await expect.poll(async () => (await divisionRow(request, divisionId)).schedule_locked).toBe(true);

  // The UI half: each control stays on the page, disabled, and says why.
  await goTab(page, base, "history");
  await expect(page.getByTestId("schedule-clear")).toBeDisabled();
  await expect(page.getByTestId("schedule-clear-reason")).toBeVisible();
  await expect(page.getByTestId("checkpoint-restore").first()).toBeDisabled();
  await expect(page.getByTestId("checkpoint-restore-reason")).toBeVisible();

  // The API half. Without this the test passes against a server that still
  // clears a frozen board.
  const refusedClear = await apiJson(request, "/api/v1/schedule/clear", "POST", {
    division_id: divisionId,
    scope: { excludeLocked: true },
    confirm: true,
  });
  expect(
    refusedClear.status,
    `clear on a frozen division returned ${refusedClear.status}`,
  ).toBe(422);
  expect(refusedClear.error?.message).toContain("the division schedule is locked");
  expect(await scheduledSlots(request, divisionId)).toEqual(placed);

  // RESTORE is the same hole, and it rewrites the WHOLE board, so its blast
  // radius is larger than clear's — a fix scoped to `clearScheduleScoped` alone
  // leaves the organiser equally exposed via the button beside it.
  const refusedRestore = await apiJson(
    request,
    `/api/v1/divisions/${divisionId}/restore`,
    "POST",
    { checkpoint_id: checkpointId, confirm: true },
  );
  expect(
    refusedRestore.status,
    `restore on a frozen division returned ${refusedRestore.status}`,
  ).toBe(422);
  expect(refusedRestore.error?.message).toContain("the division schedule is locked");
  expect(await scheduledSlots(request, divisionId)).toEqual(placed);

  // ---------------------------------------------------------------- 14
  // Publish, then start — WITH THE DIVISION STILL FROZEN, deliberately, and
  // said out loud here because the step reads like an oversight otherwise.
  //
  // Step 13 froze this division and nothing thaws it. Neither
  // `publishSchedule` (usecases/schedule.ts:3552) nor `startDivision` (:3621)
  // consults `divisions.schedule_locked`; both check only `assertNotFrozen`,
  // which is the BILLING freeze on an over-quota org and an unrelated thing
  // wearing the same word (the design doc names all three senses of "frozen"
  // for exactly this reason). So the question this step has to answer
  // honestly is whether that is a hole like F1/S2/S3 — clear and restore
  // editing a frozen board — or the intended behaviour.
  //
  // IT IS INTENDED, and the assertions below pin it as such rather than
  // pinning "these two clicks happened to work":
  //
  //  - The freeze's own copy scopes it: "Freeze — block ALL schedule EDITS
  //    (yours included) until unfrozen" (`board.freezeTitle.freeze`). On this
  //    path neither call writes a fixture row. Publish moves `setup →
  //    scheduled` and appends a ledger event; start moves `scheduled →
  //    active` (its quick-start rolling-times write is gated on
  //    `status === "setup"`, and its generate on the stage being empty —
  //    neither holds here).
  //  - The design document's own customer story for the freeze is "an
  //    organiser freezes a PUBLISHED timetable precisely so it cannot move".
  //    Refusing publish would make freeze-then-publish impossible and force
  //    an unfreeze/publish/refreeze dance that reopens the board to every
  //    other write path in between — the opposite of what the freeze is for.
  //  - `schedule-board.tsx` makes the same call in the UI: the freeze toggle
  //    at :1388 reads `single.schedule_locked`, and the publish/start block
  //    fifteen lines below it at :1411 deliberately gates on STATUS only.
  //    Same component, same variable in scope, different condition.
  //
  // So the honest assertion is not "publish succeeded" but "publish and start
  // succeed WHILE THE FREEZE IS IN FORCE, and neither of them quietly lifts
  // it" — read from the division row on both sides. Without the second read a
  // publish that silently cleared `schedule_locked` would pass here, and that
  // WOULD be the F1/S2/S3 defect.
  await goTab(page, base, "board");
  expect(
    (await divisionRow(request, divisionId)).schedule_locked,
    "step 13's freeze must still be in force, or step 14 proves nothing about a frozen board",
  ).toBe(true);
  await page.getByTestId("board-publish-schedule").click();
  await expect.poll(async () => (await divisionRow(request, divisionId)).status).toBe("scheduled");
  await page.getByTestId("board-start-division").click();
  await expect.poll(async () => (await divisionRow(request, divisionId)).status).toBe("active");
  await expect(page.getByTestId("board-start-division")).toHaveCount(0);
  expect(
    (await divisionRow(request, divisionId)).schedule_locked,
    "publishing and starting must not silently unfreeze the schedule",
  ).toBe(true);
  // The board itself is untouched by either: every slot step 12 restored is
  // still at the same time and the same court. `toEqual(placed)` rather than a
  // count, for the same reason step 12 uses it — a publish that reflowed the
  // board would keep the count and change the timetable.
  expect(await scheduledSlots(request, divisionId)).toEqual(placed);

  // The standing bar is 1280, 768 and 320 with no horizontal page scroll at
  // ANY of them. `screenshotAtWidths` (helpers.ts:240-252) only captures — it
  // asserts nothing at all — so the gate is run per width here rather than
  // once, at whatever viewport the capture happened to leave behind.
  for (const width of FINAL_WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoHorizontalScroll(page);
  }
  await screenshotAtWidths(page, testInfo, "organiser-day-final", FINAL_WIDTHS);

  // A FIRST phone visit to the board. `schedule-board.tsx` reads a SAVED
  // density out of localStorage BEFORE applying its `max-width: 640px` default,
  // and `pickDensity` persists on every click — so a 320 pass that visited 1280
  // in the same context can carry desktop density into the phone view and look
  // like the board opens dense on a phone. Only this key is removed (not the
  // whole store) so nothing else this origin remembers is disturbed.
  await page.evaluate(() => window.localStorage.removeItem("seazn:board:density"));
  await page.setViewportSize({ width: 320, height: 568 });
  await goTab(page, base, "board");
  const densityGroup = page.getByRole("group", { name: en["board.densityAria"]! });
  await expect(densityGroup).toBeVisible();
  // MEASURED on 2026-09-04 against this build, not reasoned from the source:
  // with no stored preference at 320 the board opens on Agenda. Pinning the
  // value, not just "one of them is pressed", is what makes a regression in the
  // phone default visible here at all.
  await expect(densityGroup.locator('button[aria-pressed="true"]')).toHaveText(en["board.density.agenda"]!);
  await expectNoHorizontalScroll(page);
  await page.screenshot({
    path: `${testInfo.outputPath()}/organiser-day-board-320-first-visit.png`,
    fullPage: true,
  });
});
