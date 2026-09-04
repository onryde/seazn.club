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

// Budget: fourteen tapped steps, no deliberate waits, a six-fixture solve.
// DERIVED, so that adding a step moves the budget with it rather than leaving a
// flat constant to red under it (AGENTS.md §20).
const STEPS = 14;
const PER_STEP_MS = 6_000;
const SOLVE_MS = 30_000;
test.setTimeout(STEPS * PER_STEP_MS + SOLVE_MS);

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
test.afterAll(async ({ request }) => {
  if (!divisionId) return;
  await apiJson(request, `/api/v1/divisions/${divisionId}/locks`, "PATCH", {
    schedule_locked: false,
  }).catch(() => {});
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
  const entrants = await addEntrantsViaApi(request, divisionId, [
    `Ada ${TAG}`,
    `Bo ${TAG}`,
    `Cleo ${TAG}`,
    `Dev ${TAG}`,
  ]);
  if (entrants.status >= 300) throw new Error(`entrants → ${entrants.status}`);
  ({ fixtureIds } = await createStageAndGenerate(request, divisionId));
  expect(fixtureIds).toHaveLength(6);

  // `divisionPath` is two localhost GETs and is deliberately not cached, so it
  // is resolved once here and reused rather than called per step.
  divisionBase = await divisionPath(request, divisionId);
  base = `${divisionBase}/schedule`;
});

test("the organiser sets up, schedules, saves, clears, restores, freezes and publishes", async ({
  page,
  request,
}, testInfo) => {
  // ---------------------------------------------------------------- 1
  // Required courts and the clock, typed into the Settings tab.
  await goTab(page, base, "settings");
  for (const id of courtIds) {
    await page.getByTestId("court-option").and(page.locator(`[data-court-id="${id}"]`)).check();
  }

  // `DateTimeField kind="datetime-local"` renders TWO controls — a native date
  // input plus a quarter-hour `<select>` — and deliberately exposes no bare
  // handle on either half. The date input carries the field's visible label;
  // the select is renamed "Time" so it does not read as a second copy of it.
  await page.getByLabel("Start date & time").fill(DAY0);
  await page.getByRole("combobox", { name: "Time" }).selectOption(PLAY_FROM);
  await page.getByLabel("End date").fill(LAST_DAY);

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
  // "Save settings", not /save/i: the blackout editor's own button is
  // "Save blackout windows" and a loose name matcher stops meaning one control.
  await page.getByRole("button", { name: "Save settings" }).click();

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
  await goTab(page, divisionBase, "settings");
  await page.getByRole("button", { name: "Required court tags" }).click();
  await page.getByLabel("Type a tag and press Enter").fill(COURT_TAG);
  await page.getByLabel("Type a tag and press Enter").press("Enter");
  await page.getByRole("button", { name: "Save requirement" }).click();
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
  const beforeTyping = await readConfig(request, divisionId);
  await page.getByTestId("constraint-min-rest").fill(String(REST_MIN));
  await expect(page.locator("#rest-min-saved")).toHaveText("");
  expect(await readConfig(request, divisionId)).toEqual(beforeTyping);
  await page.getByTestId("constraint-min-rest").blur();
  await expect
    .poll(async () => (await readConfig(request, divisionId)).constraints?.restMin)
    .toBe(REST_MIN);

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
  expect(stored.court).toBeUndefined(); // "" is stored as ABSENT, not as ""
  expect(Date.parse(stored.from)).toBe(Date.parse(day0Window.from));
  expect(Date.parse(stored.to)).toBe(Date.parse(day0Window.to));
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
  const strip = page.getByTestId("schedule-result-strip");
  await expect(strip).toBeVisible({ timeout: SOLVE_MS });
  await expect(page.getByTestId("schedule-result-provenance")).not.toBeEmpty();
  // Reported, not asserted: which engine produced the board is environmental
  // (CP-SAT when the placement service is up, greedy when it is not), and every
  // claim below has to hold either way.
  const engine = await strip.getAttribute("data-engine");
  testInfo.annotations.push({ type: "solver-engine", description: String(engine) });

  const placed = await scheduledSlots(request, divisionId);
  expect(placed).toHaveLength(fixtureIds.length);
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
  await expect(result).toBeVisible();
  const { data: report } = await apiJson<{ worst: { display_name: string }[] }>(
    request,
    `/api/v1/divisions/${divisionId}/schedule/report`,
  );
  expect(report!.worst.length).toBeGreaterThan(0);
  await expect(result).toContainText(report!.worst[0]!.display_name);

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
    .getByRole("alertdialog", { name: "Clear unlocked slots?" })
    .getByRole("button", { name: "Clear slots" })
    .click();
  await expect.poll(async () => (await scheduledSlots(request, divisionId)).length).toBe(0);

  // ---------------------------------------------------------------- 12
  // Restore, to exactly what step 8 produced. The `toEqual(placed)` is the
  // assertion that matters: every slot back at the same time AND the same
  // court, not merely the same count.
  await page.getByTestId("checkpoint-restore").first().click();
  await page
    .getByRole("alertdialog", { name: "Restore this save point?" })
    .getByRole("button", { name: "Restore", exact: true })
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
  // Publish, then start. Run to the terminal state, and read the status the
  // product actually moved the division to — `board-start-division` renders on
  // any division that is neither active nor completed, so its mere presence
  // after a publish proves nothing.
  await goTab(page, base, "board");
  await page.getByTestId("board-publish-schedule").click();
  await expect.poll(async () => (await divisionRow(request, divisionId)).status).toBe("scheduled");
  await page.getByTestId("board-start-division").click();
  await expect.poll(async () => (await divisionRow(request, divisionId)).status).toBe("active");
  await expect(page.getByTestId("board-start-division")).toHaveCount(0);

  await screenshotAtWidths(page, testInfo, "organiser-day-final", [1280, 768, 320]);

  // A FIRST phone visit to the board. `schedule-board.tsx` reads a SAVED
  // density out of localStorage BEFORE applying its `max-width: 640px` default,
  // and `pickDensity` persists on every click — so a 320 pass that visited 1280
  // in the same context can carry desktop density into the phone view and look
  // like the board opens dense on a phone. Only this key is removed (not the
  // whole store) so nothing else this origin remembers is disturbed.
  await page.evaluate(() => window.localStorage.removeItem("seazn:board:density"));
  await page.setViewportSize({ width: 320, height: 568 });
  await goTab(page, base, "board");
  const densityGroup = page.getByRole("group", { name: "Board density" });
  await expect(densityGroup).toBeVisible();
  // MEASURED on 2026-09-04 against this build, not reasoned from the source:
  // with no stored preference at 320 the board opens on Agenda. Pinning the
  // value, not just "one of them is pressed", is what makes a regression in the
  // phone default visible here at all.
  await expect(densityGroup.locator('button[aria-pressed="true"]')).toHaveText("Agenda");
  await expectNoHorizontalScroll(page);
  await page.screenshot({
    path: `${testInfo.outputPath()}/organiser-day-board-320-first-visit.png`,
    fullPage: true,
  });
});
