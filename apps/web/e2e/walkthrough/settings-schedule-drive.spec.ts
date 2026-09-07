import { test, expect, type APIRequestContext } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  seedSettingsOrg,
  releaseSettingsOrg,
  seedCompetition,
  releaseCompetition,
  seedDivision,
  releaseDivision,
  type SeededOrg,
  type SeededCompetition,
} from "../settings-support";
import { apiJson, setDateTime } from "../helpers";
import { routes } from "../../src/lib/routes";

/**
 * W6 of the settings walkthrough programme — the division `settings` and
 * `constraints` schedule tabs (`/o/{org}/c/{comp}/d/{div}/schedule`), zero e2e
 * coverage before this wave. Closes design's Class-4 cases #17 (play-hours
 * client gate) and the settings-tab/constraints-tab drive+persist coverage
 * feeding cases #15/#16/#18/#22 (bounds — Task 2's job, not this one's).
 *
 * `mode: "default"`, not `serial`, for the same reason every prior wave file
 * in this folder gives: `fullyParallel: true` plus `--workers=3` would run
 * `beforeAll` (and so `seedSettingsOrg`) once per worker against a shared Pro
 * user capped at five owned orgs, and `serial` would abort every later test on
 * the first red on an uncovered surface (AGENTS.md failure class 21).
 */
test.describe.configure({ mode: "default" });

/**
 * Copy read from the dictionary the page renders from, never retyped here —
 * this folder's own idiom (`settings-competition-drive.spec.ts:36`).
 */
const UI_EN: Record<string, string> = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
);
function ui(key: string): string {
  const raw = UI_EN[key];
  if (raw === undefined) throw new Error(`missing en ui dictionary key: ${key}`);
  return raw;
}

const L = {
  saved: ui("boardset.saved"),
  hoursError: ui("boardset.hoursError"),
};

/**
 * The WIRE shape of GET/PUT `/api/v1/divisions/{id}/schedule-settings`
 * (`toWire`, `usecases/schedule.ts:165-172`, pinned by
 * `schedule-settings-wire.test.ts`): `{ division_id, config, tz, updated_at }`
 * — `tz` here is the RESOLVED display zone (division override -> org tz ->
 * 'UTC'), never the raw stored column.
 */
interface ScheduleSettingsRead {
  division_id: string;
  config: {
    matchMinutes: number;
    gapMinutes: number;
    perEntrantMinRest: number;
    startAt: string | null;
    endAt: string | null;
    sessionWindows: { from: string; to: string }[];
    constraints?: { noBackToBack?: boolean };
  };
  tz: string;
  updated_at: string;
}

/** The row as the SERVER sees it — never the panel's own echo. */
async function readScheduleSettings(
  request: APIRequestContext,
  divisionId: string,
): Promise<ScheduleSettingsRead> {
  const res = await apiJson<ScheduleSettingsRead>(
    request,
    `/api/v1/divisions/${divisionId}/schedule-settings`,
    "GET",
  );
  expect(res.status, `GET .../schedule-settings: ${JSON.stringify(res.error)}`).toBe(200);
  expect(res.data, "schedule-settings GET must carry a row").toBeDefined();
  return res.data!;
}

// ---------------------------------------------------------------------------

let org: SeededOrg;
let comp: SeededCompetition;

test.beforeAll(async ({ browser }) => {
  // Its own context, not the `request` fixture — `seedSettingsOrg` moves the
  // `seazn_org` cookie of whatever jar it is handed, and a per-test fixture's
  // jar is not the one any test gets anyway (settings-support.ts, and every
  // prior wave file's own beforeAll follows this exact shape).
  const ctx = await browser.newContext();
  try {
    org = await seedSettingsOrg(ctx.request, { plan: "pro", label: "W6-drive" });
    comp = await seedCompetition(ctx.request, org.orgId, {});
  } finally {
    await ctx.close();
  }
});

test.afterAll(async ({ browser }) => {
  // Guarded independently, never `comp.id` as the first line unconditionally:
  // if `seedCompetition` throws after `seedSettingsOrg` already succeeded,
  // `comp` stays `undefined` and an unguarded read here would throw before
  // `releaseSettingsOrg` ever runs — leaking the org (one of the shared Pro
  // user's five owner slots) for the rest of the leg. Same shape as
  // `settings-competition-drive.spec.ts:198-202`'s `if (!org) return;`,
  // extended to two independently-seeded resources.
  const ctx = await browser.newContext();
  try {
    if (comp) await releaseCompetition(ctx.request, comp.id);
    if (org) await releaseSettingsOrg(ctx.request, org);
  } finally {
    await ctx.close();
  }
});

function scheduleUrl(divSlug: string, tab: "settings" | "constraints"): string {
  return `${routes.divisionSchedule(org.slug, comp.slug, divSlug)}?tab=${tab}`;
}

test("settings tab: matchMinutes/gapMinutes/perEntrantMinRest persist across a reload", async ({
  page,
  request,
}) => {
  const div = await seedDivision(request, comp.id);
  try {
    await page.goto(scheduleUrl(div.slug, "settings"));

    // Stable data-testid hooks (settings-panel.tsx), not `getByLabel` — the
    // match-length/gap inputs sit inside a wrapping `<label>` whose text
    // content also includes each field's hint span, and this file would
    // rather not re-derive whether that stays substring-safe as copy changes.
    await page.getByTestId("settings-match-minutes").fill("45");
    await page.getByTestId("settings-gap-minutes").fill("10");
    // The rest field has no data-testid, but a real id (`boardset-rest`) a
    // wrapping `<label htmlFor>` names — read directly off the DOM.
    await page.locator("#boardset-rest").fill("15");
    await page.getByRole("button", { name: /^Save/i }).click();
    await expect(page.getByText(L.saved)).toBeVisible();

    await page.reload();
    await expect(page.getByTestId("settings-match-minutes")).toHaveValue("45");
    await expect(page.getByTestId("settings-gap-minutes")).toHaveValue("10");
    await expect(page.locator("#boardset-rest")).toHaveValue("15");

    const read = await readScheduleSettings(request, div.id);
    expect(read.config.matchMinutes).toBe(45);
    expect(read.config.gapMinutes).toBe(10);
    expect(read.config.perEntrantMinRest).toBe(15);
  } finally {
    await releaseDivision(request, div.id);
  }
});

test("settings tab: startAt/endAt persist across a reload, and an untouched tz survives the save", async ({
  page,
  request,
}) => {
  const div = await seedDivision(request, comp.id);
  try {
    // The console has offered no timezone control since V305 — every save
    // from this panel omits `tz` — so the only way to put a division in the
    // state the omit-means-untouched contract is actually about (one that
    // already carries its OWN zone override) is a scripted PUT first.
    const preSeed = await apiJson(
      request,
      `/api/v1/divisions/${div.id}/schedule-settings`,
      "PUT",
      { config: {}, tz: "Europe/Madrid" },
    );
    expect(preSeed.status, `pre-seed PUT tz: ${JSON.stringify(preSeed.error)}`).toBe(200);

    await page.goto(scheduleUrl(div.slug, "settings"));

    // The seeded org has no explicit `organizations.timezone` (never set by
    // `createOrgForUser`), so this page's VENUE clock (`orgTz`,
    // `resolveVenueTz(null, org.timezone)`) is "UTC" — independent of the
    // division's own `tz` override above, by design (#448: the display lane
    // and the governing clock are deliberately different fields).
    const dateInputs = page.locator('input[type="date"]');
    await setDateTime(page, "2026-10-01T09:00"); // startAt: split date+time control
    await dateInputs.nth(1).fill("2026-10-05"); // endAt: plain date input

    await page.getByRole("button", { name: /^Save/i }).click();
    await expect(page.getByText(L.saved)).toBeVisible();

    await page.reload();
    await expect(dateInputs.first()).toHaveValue("2026-10-01");
    await expect(page.getByLabel("Time", { exact: true })).toHaveValue("09:00");
    await expect(dateInputs.nth(1)).toHaveValue("2026-10-05");

    const read = await readScheduleSettings(request, div.id);
    // The venue clock is UTC, so the stored instants are exact: startAt is
    // the picked wall-clock moment, endAt is that DAY'S LAST MINUTE
    // (`DAY_END_HHMM`, settings-panel.tsx) on the same clock.
    expect(read.config.startAt).toBe("2026-10-01T09:00:00.000Z");
    expect(read.config.endAt).toBe("2026-10-05T23:59:00.000Z");
    // The save above never touched `tz` — the omitted key must leave the
    // division's own pre-seeded override exactly as it was, not fall back to
    // the org's (unset) zone.
    expect(read.tz).toBe("Europe/Madrid");
  } finally {
    await releaseDivision(request, div.id);
  }
});

test("case #17: half-filled or inverted play hours block the save before any network write", async ({
  page,
  request,
}) => {
  const div = await seedDivision(request, comp.id);
  try {
    await page.goto(scheduleUrl(div.slug, "settings"));

    let putFired = false;
    page.on("request", (req) => {
      if (req.method() === "PUT" && req.url().includes("/schedule-settings")) putFired = true;
    });

    // Both play-hours fields render as `<select>` (datetime-field.tsx
    // `kind="time"` — Chrome's native time-picker popup ignores `step`, so
    // this control owns its own quarter-hour option list), never a fillable
    // text/time input — `.fill()` here would throw.
    await page.getByTestId("settings-day-start").locator("select").selectOption("18:00");
    await page.getByTestId("settings-day-end").locator("select").selectOption("09:00"); // inverted
    await page.getByRole("button", { name: /^Save/i }).click();

    // `save()` (settings-panel.tsx) sets this error and `return`s BEFORE the
    // `apiV1(...PUT...)` call — a synchronous early exit inside the click
    // handler, not a rejected request — so asserting the copy and the absent
    // network call together is what proves the GUARD is wired, not just that
    // `dailyHoursToWindows` itself returns null in isolation.
    await expect(page.getByText(L.hoursError)).toBeVisible();
    expect(putFired).toBe(false);

    // Half-filled: one play-hours field set, the other left at "No time" — a
    // real reachable state, not a hypothetical. `datetime-field.tsx`'s
    // `kind="time"` select always renders a genuine empty `<option
    // value="">`, never merely a placeholder, so `selectOption("")` lands on
    // it. This is the OTHER half of this test's own title ("half-filled or
    // inverted"): a distinct code path through `dailyHoursToWindows`
    // (one HHMM string, one empty string) from the fully-inverted pair above.
    await page.getByTestId("settings-day-start").locator("select").selectOption("10:00");
    await page.getByTestId("settings-day-end").locator("select").selectOption(""); // half-filled
    await page.getByRole("button", { name: /^Save/i }).click();
    await expect(page.getByText(L.hoursError)).toBeVisible();
    expect(putFired).toBe(false);
  } finally {
    await releaseDivision(request, div.id);
  }
});

test("constraints tab: noBackToBack persists across a reload", async ({ page, request }) => {
  const div = await seedDivision(request, comp.id);
  try {
    await page.goto(scheduleUrl(div.slug, "constraints"));

    const toggle = page.getByTestId("constraint-no-back-to-back");
    await expect(toggle).not.toBeChecked();
    // Instant-save on toggle (`constraints-panel.tsx`'s `saveConstraints`) —
    // there is no separate Save button for this field; the checked state only
    // settles once the panel's own GET-then-PUT round trip resolves, so
    // waiting on it here is itself the proof the write completed.
    await toggle.click();
    await expect(toggle).toBeChecked();

    await page.reload();
    await expect(page.getByTestId("constraint-no-back-to-back")).toBeChecked();

    const read = await readScheduleSettings(request, div.id);
    expect(read.config.constraints?.noBackToBack).toBe(true);
  } finally {
    await releaseDivision(request, div.id);
  }
});
