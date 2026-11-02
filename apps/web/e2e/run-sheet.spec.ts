import { test, expect, type Page, type Locator } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
  TAG,
  apiJson,
  divisionPath,
  createStageAndGenerate,
  setFixtureScheduledAtSql,
  setFixtureStatusSql,
  setZoneSplitSql,
  setDateTime,
  expectNoHorizontalScroll,
  addEntrantsViaApi,
  seedVenueWithCourts,
  openBracket,
} from "./helpers";
// The repo's one cookie-banner dismissal — idempotent no-op under the authed
// `page` fixture (consent is already pre-dismissed into AUTH_STATE), but
// Task 9's brief calls it out explicitly: a fresh phone context is the one
// place it actually matters, so every width loop below calls it anyway
// rather than assuming the storageState always covers the surface driving.
import { dismissCookieBanner } from "./scorepad-a11y-kit";
// Same authority the row itself uses (`zoned-datetime.ts`, #448) — the
// expected instant below is DERIVED from the two zones, not typed as a
// constant, so the case still witnesses the regression if either zone
// changes (fix round 3).
import { isoFromZonedDateTime, zonedDateTimeInput } from "../src/lib/zoned-datetime";
// The SAME day-bucketing authority `buildRunSheet` and `fixtureRowAction`
// both call — the expected day key below is derived from it rather than
// re-implemented with `toISOString().slice(0, 10)`, which is only the right
// answer while the venue zone happens to be UTC (fix round 4).
import { dayKeyInTz } from "@seazn/engine/scheduling/tz";
import { dayLabel } from "../src/lib/day-label";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The SHIPPED English copy, so a copy assertion has one authority and moves
 *  with the dictionary instead of freezing yesterday's sentence into a test
 *  (same idiom as `competition-desk-actions.spec.ts` and four others). */
const UI_EN = JSON.parse(
  readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
) as Record<string, string>;

/**
 * SHARED-STATE TEARDOWN — `afterEach`, deliberately NOT a `finally`.
 *
 * `organizations.timezone` is org-wide, and every parallel spec in the run
 * shares the one Pro org `auth.setup.ts` provisions. Only the two tests in
 * the "zone-split cases" describe mutate it (`setZoneSplitSql`); every other
 * test here touches fixtures/schedule_settings rows scoped to a division it
 * created itself, which are fine to leave dirty.
 *
 * A `try`/`finally` looks like it covers the restore and does not: on a
 * Playwright TIMEOUT the test body is abandoned and its `finally` NEVER
 * RUNS — only hooks do. The leak would then survive for the rest of the run
 * and surface as day-bucketing or time-formatting failures scattered across
 * unrelated spec files, which is about the most misleading shape a failure
 * can take here: nobody debugging `competition-desk.spec.ts` goes looking
 * for a timezone restore in this one. Fix round 4 moved it here, where it
 * runs on pass, on failure, and on timeout alike.
 *
 * Idempotent and safe when nothing was mutated: `null` until a test actually
 * captures a restore, and cleared BEFORE awaiting so a second `afterEach`
 * (or a retry) cannot re-run a stale closure. Worker-local by construction —
 * each Playwright worker is its own process, so each restores only what it
 * itself captured.
 */
let pendingOrgTzRestore: (() => Promise<void>) | null = null;

test.afterEach(async () => {
  const restore = pendingOrgTzRestore;
  pendingOrgTzRestore = null;
  if (restore !== null) await restore();
});

/**
 * REVIEW FINDING 4 — the run sheet's own clipping gate, and the half of the
 * viewport rule `expectNoHorizontalScroll` STRUCTURALLY CANNOT COVER here.
 *
 * `data-testid="run-sheet"` is itself `div.card.overflow-hidden`
 * (`run-sheet.tsx`), so nothing this sheet renders can ever reach the
 * document's scroll width: the card clips it first. Measured, with a
 * deliberately 900px-wide time cell at a 320px viewport — the span really was
 * 900px and really did stick 646px past the card, and BOTH the old
 * `documentElement.scrollWidth <= clientWidth` comparison and
 * `expectNoHorizontalScroll` reported the page clean. The page-level helper is
 * still called at both sites (it is the repo's one authority for "did the
 * PAGE go wide", and it is the thing that would catch this row pushing `main`
 * out), but on its own it is a gate that cannot witness this sheet's own
 * overflow.
 *
 * So this is the second half, in the shape `mobile.spec.ts`'s `overflowingIn`
 * established: split the overflow on computed `overflow-x`. Content wider
 * than its box inside an `auto`/`scroll` box is a REACHABLE rail — a feature,
 * and held to being keyboard-reachable rather than waved through. Inside a
 * `hidden`/`visible`/`clip` box it is CLIPPED — content the organiser cannot
 * get to, which is a defect. `text-overflow: ellipsis` / `-webkit-line-clamp`
 * is the third case: shortened ON PURPOSE and carrying its own signal, which
 * is what every `truncate` in the row is. All three are returned and each is
 * held to something, so a future overflow cannot hide behind an exemption.
 */
async function expectRunSheetNotClipped(page: Page, label: string): Promise<void> {
  const seen = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('[data-testid="run-sheet"]');
    if (root === null) return { absent: true, clipped: [], scrollable: [], truncatedByDesign: [], visuallyHidden: [] };
    const suspects: HTMLElement[] = [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))];
    const over = suspects.filter((el) => el.scrollWidth - el.clientWidth > 1);
    const describe = (el: HTMLElement) =>
      `${el.tagName.toLowerCase()}${el.dataset.testid ? `[${el.dataset.testid}]` : ""}` +
      `${typeof el.className === "string" && el.className.trim() !== "" ? `.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}` : ""} ` +
      `${el.scrollWidth}px content in ${el.clientWidth}px` +
      `${el.hasAttribute("tabindex") ? ` tabindex=${el.getAttribute("tabindex")}` : ""}` +
      `${el.textContent && el.textContent.trim() !== "" ? ` text=${JSON.stringify(el.textContent.trim().slice(0, 24))}` : ""}`;
    const reachable = (el: HTMLElement) => /^(auto|scroll)$/.test(getComputedStyle(el).overflowX);
    const shortenedOnPurpose = (el: HTMLElement) => {
      const cs = getComputedStyle(el);
      if (cs.textOverflow === "ellipsis") return true;
      const clamp = cs.webkitLineClamp;
      return clamp !== "" && clamp !== "none";
    };
    // The `sr-only` idiom, detected by COMPUTED STYLE and not by class name:
    // absolutely positioned into a 1x1 box. Its content "overflows" by
    // construction and is meant to — it is there for assistive tech, not for
    // the eye. Recognising it by geometry rather than by `.sr-only` means a
    // renamed utility keeps its exemption and a 300px box calling itself
    // `sr-only` does not get one.
    const visuallyHidden = (el: HTMLElement) =>
      getComputedStyle(el).position === "absolute" && el.clientWidth <= 1 && el.clientHeight <= 1;
    const controlCount = (el: HTMLElement) =>
      el.querySelectorAll("button, a[href], input, select, textarea, [tabindex]").length;
    const rest = over.filter((el) => !reachable(el));
    const hidden = rest.filter(visuallyHidden);
    const stillClipped = rest.filter((el) => !visuallyHidden(el));
    return {
      absent: false,
      clipped: stillClipped.filter((el) => !shortenedOnPurpose(el)).map(describe),
      scrollable: over.filter(reachable).map(describe),
      truncatedByDesign: stillClipped.filter(shortenedOnPurpose).map(describe),
      visuallyHidden: hidden.map((el) => `${describe(el)} controls=${controlCount(el)}`),
    };
  });
  // PRINT WHAT WAS SEEN beside the gate (_RULES.md) — an empty `clipped` list
  // means nothing unless the sheet was actually on the page to be measured.
  console.log(`${label}: run sheet overflow —`, JSON.stringify(seen));
  expect(seen.absent, `${label}: the run sheet was not in the DOM — nothing was measured`).toBe(false);
  expect(seen.clipped, `${label}: content is clipped inside the run sheet's own card`).toEqual([]);
  // The exemptions are ASSERTED, never assumed: a rail that lost its tab stop
  // reddens instead of quietly becoming an unreachable clip.
  for (const box of seen.scrollable) {
    expect(box, `${label}: a scrolling box in the run sheet is not keyboard-reachable`).toMatch(/tabindex=0$/);
  }
  // A visually-hidden LABEL is the point of `sr-only`; a visually-hidden
  // CONTROL is a control nobody can reach. The exemption is held to exactly
  // that line, so a future 1x1 box that swallows a button reddens here.
  for (const box of seen.visuallyHidden) {
    expect(box, `${label}: a visually-hidden box in the run sheet contains a control`).toMatch(/ controls=0$/);
  }
}

// Competition Desk W2, Task 4 — the fixtures tab as a run sheet. This is the
// seam obligation for Tasks 2 and 3: `fixtureRowAction` and `buildRunSheet`
// are pure builders in a jsdom-less `vitest` runner, blind to DOM wiring —
// their real producer (`listDivisionFixtures`, via the division page) and
// consumer (the rendered sheet) are proven ONLY here.
//
// `createDivisionForTest` does not exist — this defines its own local seed
// function in the style of `capacity-precheck.spec.ts`'s `seedTightRoundRobin`,
// composing the real `apps/web/e2e/helpers.ts` exports rather than an
// invented request body (a probe in W1 passed at every width once because its
// setup calls had silently failed — stages 400, generate 404, start 422 —
// while the page was never in the state under test).
/**
 * A fixed-offset IANA zone in which `nowMs` reads as local **midday**.
 *
 * Fix round 4 (controller finding). Rounds 1-3 fought the UTC day boundary
 * with a clamp on how far the seeded fixtures could sit from real "now":
 * first `Math.max(3, room - 2)` (which DEMANDED 3 minutes of room it did not
 * have and overshot into tomorrow, a live 23:58 red), then half the room
 * actually available. The halving is arithmetically sound — half a positive
 * is strictly less than it, so every seeded instant stays inside today — but
 * it bought that by SHRINKING THE OFFSETS, and the "future" row has a second
 * job the clamp cannot do: it must still be in the future when the PAGE
 * RENDERS, which is three SQL writes, four API reads and a page load later.
 * At 23:59:50 UTC the future offset became 5 seconds, the row was already
 * past by render, `filteredNowIndex` moved, and the NOW-rule position
 * assertion went red with no day-group message to explain it. The window
 * went from ~3 minutes a day to tens of seconds; it never closed.
 *
 * A floor cannot both stay inside today and outlast render latency — that is
 * the real tension, and neither clamp resolves it. The offsets are not the
 * free variable here; THE VENUE ZONE IS. The sheet buckets and prints in
 * `scheduleSettings.tz` (amendment 4) and this seed chooses that value, so
 * choosing one where "now" is local midday puts ~12 hours of room on each
 * side of the day boundary at every hour of the real clock. The offsets then
 * go back to a flat ±90/-30 minutes: far enough that render latency is
 * irrelevant, and provably inside one local day whenever the run starts.
 *
 * `Etc/GMT±N` is POSIX-style and INVERTS THE SIGN — `Etc/GMT-5` is UTC+5.
 * These zones are deliberate: fixed-offset and DST-free, so a real zone's
 * seasonal shift cannot move the midday anchor out from under the seed.
 */
function middayZoneFor(nowMs: number): string {
  const offsetHours = 12 - new Date(nowMs).getUTCHours();
  if (offsetHours === 0) return "UTC";
  return `Etc/GMT${offsetHours > 0 ? "-" : "+"}${Math.abs(offsetHours)}`;
}

async function seedRunSheetDivision(
  request: import("@playwright/test").APIRequestContext,
  opts: { tz?: string } = {},
) {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `RunSheet E2E ${TAG}`,
    visibility: "private",
  });
  const compId = comp.data!.id;
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${compId}/divisions`, "POST", {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  const divisionId = div.data!.id;
  await apiJson(
    request,
    `/api/v1/divisions/${divisionId}/entrants`,
    "POST",
    ["A", "B", "C", "D"].map((n, i) => ({ kind: "individual", display_name: n, seed: i + 1 })),
  );
  // The venue zone this whole sheet buckets and prints in (amendment 4).
  // Defaults to UTC (the convention `division-schedule.spec.ts` uses); the
  // day-grouping case passes a midday zone instead — see `middayZoneFor`.
  const settings = await apiJson(request, `/api/v1/divisions/${divisionId}/schedule-settings`, "PUT", {
    config: {},
    tz: opts.tz ?? "UTC",
  });
  expect(settings.status, `schedule-settings PUT failed: ${JSON.stringify(settings.error)}`).toBeLessThan(300);
  const { fixtureIds } = await createStageAndGenerate(request, divisionId);
  return { divisionId, fixtureIds };
}

test("the run sheet groups by venue day and prints the day, the time and the pitch", async ({ page, request }) => {
  // Fix round 4: the venue zone is CHOSEN so that real "now" is local midday
  // in it — see `middayZoneFor` for the whole argument. Everything below is
  // then flat and deterministic; there is no clamp, no floor, and no hour of
  // the real clock at which this case behaves differently.
  const now = Date.now();
  const tz = middayZoneFor(now);
  const { divisionId, fixtureIds } = await seedRunSheetDivision(request, { tz });
  expect(fixtureIds.length, "seed produced no fixtures — setup failed, not the sheet").toBeGreaterThanOrEqual(3);
  // The seed's whole safety argument in one assertion, printed: "now" must
  // really be near the middle of the venue-zone day, or the flat ±90-minute
  // offsets below are not safe and the reader should be told so HERE rather
  // than discovering it as a mystery day-group failure 40 lines later.
  const hourInTz = Number(
    new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: tz }).format(new Date(now)),
  );
  console.log("run sheet seed zone:", tz, "| local hour there:", hourInTz);
  expect(hourInTz, `middayZoneFor(${tz}) did not land near midday`).toBeGreaterThanOrEqual(11);
  expect(hourInTz, `middayZoneFor(${tz}) did not land near midday`).toBeLessThanOrEqual(13);

  // Times relative to REAL now — NOT `page.clock`, which has zero uses in
  // this repo (`grep -a -rn "page.clock" apps/web/e2e` returns nothing), so
  // the NOW rule's actual position can never be pinned to a fixed clock; it
  // has to be derived from whatever "now" the SUT itself reads at render.
  // Two rows before now, one after, all on the same venue-zone day.
  //
  // FLAT offsets, no clamp: the midday zone above guarantees ~12 hours of
  // room on both sides of the local day boundary, so 90 minutes can never
  // reach it. And 90 minutes of headroom is what makes the FUTURE row still
  // future when the page finally renders — the property the round-2 halving
  // clamp silently gave up (at 23:59:50 it left a 5-second future offset,
  // which three SQL writes and a page load outlive).
  const beforeFarMin = 90;
  const beforeNearMin = 30;
  const afterMin = 90;
  await setFixtureScheduledAtSql(fixtureIds[0]!, new Date(now - beforeFarMin * 60_000).toISOString());
  await setFixtureScheduledAtSql(fixtureIds[1]!, new Date(now - beforeNearMin * 60_000).toISOString());
  await setFixtureScheduledAtSql(fixtureIds[2]!, new Date(now + afterMin * 60_000).toISOString());

  // Derived from the seed through the SUT's OWN bucketing authority (fix
  // round 1, IMPORTANT 5a; fix round 4 re-derives it via `dayKeyInTz` rather
  // than a UTC-only string slice, since the venue zone is no longer UTC).
  const expectedDayKey = dayKeyInTz(now, tz);

  // Match Day E1 item 1 (owner 2026-11-01): the stage card groups its rows under a header bar PER ROUND - "Round 2 - 0 of 2 done - day -
  // 21:10-21:50" - not under day headings, and an untimed row sits last in its round saying "No time yet" rather than under a "Not yet
  // scheduled" group. So what this case pins is the DERIVED shape: the rounds come in earliest-kickoff order (untimed rounds last), the
  // rows in a round in time order, each bar names its day and its clock span in the venue zone, and the NOW rule appears once.
  const all = await apiJson<{ id: string; fixture_no: number; round_no: number; scheduled_at: string | null }[]>(
    request,
    `/api/v1/divisions/${divisionId}/fixtures`,
  );
  const rows = all.data!;
  expect(rows.length, "the seed's six fixtures are all on the API").toBe(6);
  const timed = (r: { scheduled_at: string | null }) => (r.scheduled_at === null ? Number.POSITIVE_INFINITY : Date.parse(r.scheduled_at));
  const roundNos = [...new Set(rows.map((r) => r.round_no))];
  const earliest = (n: number) => Math.min(...rows.filter((r) => r.round_no === n).map(timed));
  const expectedRounds = [...roundNos].sort((a, b) => earliest(a) - earliest(b) || a - b);
  const expectedOrder = new Map(
    expectedRounds.map((n) => [
      n,
      rows
        .filter((r) => r.round_no === n)
        .sort((a, b) => timed(a) - timed(b) || a.fixture_no - b.fixture_no)
        .map((r) => String(r.fixture_no)),
    ]),
  );
  console.log("run sheet expected rounds:", expectedRounds, JSON.stringify([...expectedOrder]));
  const clock = (iso: string) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: tz }).format(new Date(iso));

  await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
  const sheet = page.getByTestId("run-sheet");
  await expect(sheet).toBeVisible();
  // The division opens on All (nothing started), so every round is on the sheet.
  await sheet.locator('[data-filter="all"]').click();

  // No day headings and no "Not yet scheduled" group in a stage card any more.
  await expect(sheet.locator("[data-run-sheet-day]"), "no day headings in a stage card").toHaveCount(0);
  await expect(sheet.locator('[data-run-sheet-block="unscheduled"]'), "no unscheduled group").toHaveCount(0);
  await expect(sheet.getByText("Not yet scheduled")).toHaveCount(0);

  // POSITIVE PAIR: the rounds are really on the page, in the derived order.
  const rounds = sheet.locator("[data-run-sheet-round]");
  await expect(rounds, "one section per round").toHaveCount(expectedRounds.length);
  const seenRounds = await rounds.evaluateAll((els) => els.map((el) => Number(el.getAttribute("data-run-sheet-round"))));
  console.log("run sheet rounds seen:", seenRounds, "expected:", expectedRounds);
  expect(seenRounds, "rounds in earliest-kickoff order, untimed rounds last").toEqual(expectedRounds);

  let barsChecked = 0;
  for (const n of expectedRounds) {
    const round = sheet.locator(`[data-run-sheet-round="${n}"]`);
    const mine = rows.filter((r) => r.round_no === n);
    const stamped = mine.filter((r) => r.scheduled_at !== null).map((r) => r.scheduled_at!).sort();
    // Rows: in time order, untimed last - read off the page, compared to the order derived from the API.
    const seenNos = await round.locator("[data-fixture-no]").evaluateAll((els) => els.map((el) => el.getAttribute("data-fixture-no")));
    expect(seenNos, `round ${n}: rows in time order, untimed last`).toEqual(expectedOrder.get(n));
    const bar = round.getByTestId("run-sheet-round-bar");
    await expect(bar).toContainText(UI_EN["schedule.round"]!.replace("{n}", String(n)));
    await expect(bar, `round ${n}: how many are done`).toContainText(
      UI_EN[mine.length === 1 ? "runsheet.round.done.one" : "runsheet.round.done.other"]!.replace("{done}", "0").replace("{total}", String(mine.length)),
    );
    if (stamped.length === 0) {
      await expect(bar.locator("[data-run-sheet-round-dates]"), `round ${n}: nothing timed, no date`).toHaveCount(0);
      await expect(bar.locator("[data-run-sheet-round-span]")).toHaveCount(0);
    } else {
      await expect(bar.locator("[data-run-sheet-round-dates]")).toContainText(dayLabel(expectedDayKey, "en"));
      const span = stamped.length === 1 || clock(stamped[0]!) === clock(stamped[stamped.length - 1]!) ? clock(stamped[0]!) : `${clock(stamped[0]!)}\u2013${clock(stamped[stamped.length - 1]!)}`;
      await expect(bar.locator("[data-run-sheet-round-span]"), `round ${n}: the clock span in the venue zone`).toContainText(span);
    }
    // An untimed OPEN row says so on the row.
    const untimed = mine.filter((r) => r.scheduled_at === null);
    for (const r of untimed) {
      await expect(round.locator(`[data-fixture-no="${r.fixture_no}"]`), `fixture ${r.fixture_no}: no time yet`).toContainText(UI_EN["runsheet.noTimeYet"]!);
    }
    // ...and a timed one does not.
    for (const r of mine.filter((x) => x.scheduled_at !== null)) {
      await expect(round.locator(`[data-fixture-no="${r.fixture_no}"]`)).not.toContainText(UI_EN["runsheet.noTimeYet"]!);
    }
    barsChecked++;
  }
  expect(barsChecked, "every round's bar was checked").toBe(expectedRounds.length);
  expect(barsChecked).toBeGreaterThan(0);
  // The per-row "Round N" label is gone: every "Round N" on the sheet is a bar's.
  await expect(sheet.getByText(/Round \d/)).toHaveCount(expectedRounds.length);

  // The NOW rule sits between the 30-minutes-ago row and the 90-minutes-hence row: exactly one rule in the whole sheet, AND at the right
  // POSITION - a `nowIndex` pinned to 0 (every row read as "in the future") would still pass a bare `toHaveCount(1)`. The row immediately
  // after the rule in DOM order must be the FUTURE fixture.
  const expectedFixtureNos = await Promise.all(
    [fixtureIds[0]!, fixtureIds[1]!, fixtureIds[2]!].map(async (id) => {
      const info = await apiJson<{ fixture_no: number }>(request, `/api/v1/fixtures/${id}`);
      return info.data!.fixture_no;
    }),
  );
  await expect(sheet.getByTestId("run-sheet-now")).toHaveCount(1);
  const afterNowFixtureNo = await sheet
    .getByTestId("run-sheet-now")
    .locator("xpath=following-sibling::*[1]")
    .getAttribute("data-fixture-no");
  console.log("run sheet row immediately after NOW:", afterNowFixtureNo, "expected:", expectedFixtureNos[2]);
  expect(afterNowFixtureNo).toBe(String(expectedFixtureNos[2]));
});

// Regression (finding 3, competition-desk-design.md "Error and empty
// states" + supplement C7): "a decided fixture renders no 'Unscheduled'
// chip." W1's `FixtureLine` put a settled-but-never-timed fixture into its
// round list (`scheduled_at !== null || isBye(f) || f.status !== "scheduled"`
// — a decided match's status alone satisfied the third clause) and rendered
// its "Unscheduled" timetable chip on an already-played match. The run sheet
// fixes this a level up, not just by dropping the chip:
// `buildRunSheet`'s null-`scheduled_at` branch only keeps OPEN work
// (`scheduled`/`in_play`, run-sheet-groups.ts's `OPEN` set) in the
// unscheduled pile — a settled fixture with no time is never "open
// scheduling work". Fix round 1 (controller ruling) corrected WHERE it goes
// from there: dropping it off the sheet entirely was itself a regression
// (W1's round list kept these rows) — it now lands in its own terminal
// "settled" block, with a "Result" action, never a stale "Unscheduled" one.
test("regression (finding 3): a decided fixture with no recorded time never reads as unscheduled", async ({
  page,
  request,
}) => {
  const { divisionId, fixtureIds } = await seedRunSheetDivision(request);
  expect(fixtureIds.length, "seed produced no fixtures — setup failed, not the sheet").toBeGreaterThanOrEqual(1);

  const target = fixtureIds[0]!;
  const targetInfo = await apiJson<{ fixture_no: number }>(request, `/api/v1/fixtures/${target}`);
  const fixtureNo = targetInfo.data!.fixture_no;

  // Decided, and deliberately left with no `scheduled_at` at all — a
  // retroactively-recorded result the organiser never put a kickoff time on.
  await setFixtureStatusSql(target, "decided");
  await setFixtureScheduledAtSql(target, null);

  await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
  const sheet = page.getByTestId("run-sheet");
  // IMPORTANT 5d (fix round 1): assert the sheet actually rendered BEFORE
  // asserting an absence inside it — a blank or 500'd page also satisfies
  // "the fixture does not appear inside the unscheduled block", which is
  // exactly the "reachable" bar this whole regression class exists to clear.
  await expect(sheet).toBeVisible();

  // Match Day E1 item 1: a stage card has no "Not yet scheduled" group and no terminal "settled" block - the decided match sits in its
  // own ROUND like every other row, with its Result action, and says nothing of "No time yet" (that is for OPEN work only).
  await expect(sheet.locator('[data-run-sheet-block="unscheduled"]'), "no unscheduled group exists in a stage card").toHaveCount(0);
  await expect(sheet.locator('[data-run-sheet-block="settled"]')).toHaveCount(0);
  const settledRow = sheet.locator(`[data-fixture-no="${fixtureNo}"]`);
  // POSITIVE PAIR: the row is on the sheet, once, inside a round section.
  await expect(settledRow).toHaveCount(1);
  await expect(settledRow.locator("xpath=ancestor::*[@data-run-sheet-round][1]")).toHaveCount(1);
  console.log(`regression finding-3 fixture_no=${fixtureNo}, row text:`, await settledRow.textContent());
  await expect(settledRow, "a played match with no time is a result, not 'No time yet'").not.toContainText(UI_EN["runsheet.noTimeYet"]!);
  await expect(settledRow.locator('[data-row-action="result"]')).toHaveCount(1);
  await expect(settledRow.locator('[data-row-action="set_time"]')).toHaveCount(0);
  // ...while an OPEN untimed neighbour does say it (the other side of the same rule).
  const open = await apiJson<{ fixture_no: number }>(request, `/api/v1/fixtures/${fixtureIds[1]!}`);
  await expect(sheet.locator(`[data-fixture-no="${open.data!.fixture_no}"]`)).toContainText(UI_EN["runsheet.noTimeYet"]!);
});

// CRITICAL 1 (fix round 1): the run sheet had no empty-filter state. The
// filter was "today" on a match day (it opens on "all" since PB1; the state is
// still reached by choosing Today); a division whose real fixtures
// exist but none land on today's venue-zone day rendered a filter bar, a tz
// caption, and NOTHING below it — the flagship surface reading as broken on
// the one day it exists for. The same vacuous shape amendment 3 already paid
// for one level up: the empty set answers no to every question and lands on
// whatever the default is. Driven live rather than asserted from
// `buildRunSheet`'s own output, since the whole point is what an organiser
// SEES, not that the builder returns an empty array (it always did — the gap
// was the component never rendering anything for that case).
test("empty-filter state: switching to a filter with no matching rows shows a message and a way back to All", async ({
  page,
  request,
}) => {
  const { divisionId, fixtureIds } = await seedRunSheetDivision(request);
  expect(fixtureIds.length, "seed produced no fixtures — setup failed, not the sheet").toBeGreaterThanOrEqual(1);
  // Far in the future — never "today" no matter when this suite runs.
  await setFixtureScheduledAtSql(fixtureIds[0]!, "2030-06-15T09:00:00.000Z");

  await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
  const sheet = page.getByTestId("run-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId("run-sheet-filter")).toBeVisible();

  await sheet.locator('[data-filter="today"]').click();
  const empty = sheet.getByTestId("run-sheet-empty");
  await expect(empty).toBeVisible({ timeout: 10_000 });
  const emptyText = await empty.textContent();
  console.log("run sheet empty-filter state text:", emptyText);
  expect(emptyText, "empty-filter copy must exist and say something").toBeTruthy();
  // The filter bar and tz caption stay up — only the body goes empty, so the
  // organiser can still see and change the active filter.
  await expect(sheet.getByTestId("run-sheet-filter")).toBeVisible();
  await expect(sheet.getByTestId("tz-caption")).toBeVisible();

  // The affordance back to All actually recovers the sheet — not just
  // present, but functional.
  await sheet.getByTestId("run-sheet-empty-show-all").click();
  await expect(empty).toHaveCount(0);
  // A 4-entrant round robin is three rounds: the sheet is back, under a bar each.
  await expect(sheet.locator("[data-run-sheet-round]")).toHaveCount(3);
});

// SERIAL, and only these two. Both write `organizations.timezone`, which
// is org-wide and shared by every parallel spec in the run (auth.setup.ts
// provisions ONE Pro org). `fullyParallel: true` parallelises tests WITHIN
// a file, so before this block the two ran in different workers and each
// could see the other's zone: caught live on 2026-09-04, when the note case
// read the org as UTC and the page rendered `America/New_York` because the
// write case had just set it in another worker. Serial mode is the price;
// read a failure count for this describe as a FLOOR, not a total, because
// the first red skips the rest of the block (and only this block).
//
// They also both SET the zone rather than reading it, to the same
// `ORG_TZ`. Reading it cannot work: three other spec files
// (`competition-desk`, `registration-hub`, the organiser walkthrough) write
// the same column, so a value read at the top of a test can be stale by the
// time the page renders.
test.describe("zone-split cases — they share organizations.timezone", () => {
  test.describe.configure({ mode: "serial" });

  /** The one org zone every test in this block writes, so two of them
   *  overlapping (or one restoring while the other reads) can never make
   *  them contradict each other on the value itself. */
  const ORG_TZ = "America/New_York";

  // Fix round 3 (owner ruling): the inline "Set time" editor resolves the
  // typed value in the ORG zone (`orgTz`, #448), never the VENUE zone (`tz`,
  // display-only, amendment 4) and never the browser's implicit zone. This is
  // a VALUE pin, not a reachability check — the whole reason the defect
  // survived every prior write site's own test coverage is that nothing
  // seeded a division where `tz` and `orgTz` actually DISAGREE, so a
  // wrong-zone write and a right-zone write produced the identical instant
  // and nothing could tell them apart. `setZoneSplitSql` seeds exactly that
  // shape.
  test("fix round 3 (owner ruling): the inline Set-time editor writes the ORG zone, not the venue zone", async ({
    page,
    request,
  }) => {
    const { divisionId, fixtureIds } = await seedRunSheetDivision(request);
    expect(fixtureIds.length, "seed produced no fixtures — setup failed, not the sheet").toBeGreaterThanOrEqual(1);
    const target = fixtureIds[0]!;
    const targetInfo = await apiJson<{ fixture_no: number }>(request, `/api/v1/fixtures/${target}`);
    const fixtureNo = targetInfo.data!.fixture_no;

    // A division whose venue zone DIFFERS from its org zone. `fixtureNo: -1`
    // matches no real row — every fixture in this division (the target
    // included) is left/forced unscheduled by the helper's own "null every
    // OTHER fixture" clause, which is exactly the state "Set time" needs to
    // be reachable at all.
    // Fix round 4: the restore is REGISTERED, not wrapped in a `try`/`finally`.
    // A Playwright timeout abandons the test body without running its
    // `finally`, which would leave the SHARED org's timezone mutated for the
    // rest of the run — see the `afterEach` at the top of this file for the
    // whole argument. Fix round 5 closes the last window inside the helper
    // too: `registerRestore` hands the undo over BEFORE the UPDATE, so the
    // column is never dirty with nothing registered (the awaited return value
    // only exists once the whole helper resolves).
    await setZoneSplitSql({
      divisionId,
      orgTz: ORG_TZ,
      divisionTz: "Asia/Tokyo",
      fixtureNo: -1,
      at: "2030-01-01T00:00:00.000Z",
      registerRestore: (undo) => {
        pendingOrgTzRestore = undo;
      },
    });
    await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
    const targetRow = page.locator(`[data-fixture-no="${fixtureNo}"]`);
    await targetRow.getByRole("button", { name: "Set time", exact: true }).click();
    const typed = "2026-10-12T15:00";
    await setDateTime(page, typed);
    await targetRow.getByRole("button", { name: "Save", exact: true }).click();

    // DERIVED from both zones, never a typed constant — this stays a real
    // witness if either zone (or the chosen date, which crosses a DST
    // boundary differently for each) ever changes. Sanity-checked that the
    // two zones actually disagree for this instant, or the test would be
    // vacuously satisfied by either implementation.
    const expectedInstant = isoFromZonedDateTime(typed, ORG_TZ);
    const wrongZoneInstant = isoFromZonedDateTime(typed, "Asia/Tokyo");
    expect(expectedInstant, "orgTz and tz must actually disagree for this instant, or the case proves nothing").not.toBe(
      wrongZoneInstant,
    );

    // Polled, not a single read — the PATCH is fired from a client click and
    // can still be in flight the instant this check runs. Prints the actual
    // read on every poll tick via a side-channel `let`, so a failure still
    // shows what was seen rather than just a timeout.
    let lastSeen: string | null | undefined;
    await expect
      .poll(
        async () => {
          lastSeen = (await apiJson<{ scheduled_at: string | null }>(request, `/api/v1/fixtures/${target}`)).data!
            .scheduled_at;
          return lastSeen;
        },
        { timeout: 15_000 },
      )
      .toBe(expectedInstant);
    console.log(
      "set-time write: typed",
      typed,
      "| written",
      lastSeen,
      "| expected (orgTz)",
      expectedInstant,
      "| would-be-wrong (tz)",
      wrongZoneInstant,
    );
  });

  // Fix round 4 — the zone note, both directions.
  //
  // Round 3 added it unconditionally, saying only which zone the input accepts.
  // Two problems, both about whether an organiser keeps reading it: it fired on
  // every division, including the majority where `orgTz === tz` and there is
  // nothing to disambiguate (a note that speaks when it has nothing to say
  // trains people to stop reading it), and it never said that the ROW
  // redisplays in a different zone, which is the actual confusion — a typed
  // 15:00 reappearing as 04:00 with no visible cause reads as data loss.
  //
  // This is also where `orgTz` gets its teeth. The editor's initial VALUE is
  // no longer read from the fixture (see run-sheet-row.tsx: the ladder only
  // opens this editor for a fixture with no time at all, so that read was dead
  // code), so the note is the one place `orgTz` is observable in the DOM.
  // Pinned as an exact sentence built from the dictionary's own string, not a
  // substring check — a containment assertion cannot tell "enter in NY, shown
  // in Tokyo" from the swapped, exactly-wrong "enter in Tokyo, shown in NY".
  //
  // This case lives in ZONE_SPLIT_CASES (serial) with the fix-round-3 write
  // test, and it SETS the org zone rather than reading it — see that describe's
  // own header for why a read-based expectation cannot work here.
  test("fix round 4: the set-time zone note names both clocks, and only appears when they differ", async ({
    page,
    request,
  }) => {
    const openEditor = async (divisionId: string, fixtureNo: number) => {
      await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
      const row = page.locator(`[data-fixture-no="${fixtureNo}"]`);
      await row.locator('[data-row-action="set_time"]').click();
      await expect(row.getByTestId("run-sheet-set-time-editor")).toBeVisible();
      return row;
    };

    // Phase 1 — the two zones DISAGREE. `fixtureNo: -1` matches no real row,
    // so the helper's "null every OTHER fixture" clause leaves every fixture
    // unscheduled, which is the state "Set time" needs to be reachable at all.
    const differing = await seedRunSheetDivision(request);
    expect(differing.fixtureIds.length, "seed produced no fixtures — setup failed, not the sheet").toBeGreaterThanOrEqual(
      1,
    );
    const noA = (await apiJson<{ fixture_no: number }>(request, `/api/v1/fixtures/${differing.fixtureIds[0]!}`)).data!
      .fixture_no;
    // Registered for `afterEach`, never a `finally` — a Playwright timeout
    // skips `finally` entirely and would leave the shared org mutated. And
    // registered from INSIDE the helper, before its first write (round 5).
    await setZoneSplitSql({
      divisionId: differing.divisionId,
      orgTz: ORG_TZ,
      divisionTz: "Asia/Tokyo",
      fixtureNo: -1,
      at: "2030-01-01T00:00:00.000Z",
      registerRestore: (undo) => {
        pendingOrgTzRestore = undo;
      },
    });
    const rowA = await openEditor(differing.divisionId, noA);
    const note = rowA.getByTestId("run-sheet-set-time-zone-note");
    await expect(note).toBeVisible();
    const seen = (await note.textContent())?.trim() ?? "";
    // Built from the SHIPPED English string, so the copy has exactly one
    // authority and a reworded note moves this expectation with it.
    const expected = UI_EN["runsheet.setTime.zoneNote"]!.replace("{orgTz}", ORG_TZ).replace("{tz}", "Asia/Tokyo");
    console.log(`zone note (orgTz=${ORG_TZ}, tz=Asia/Tokyo):`, JSON.stringify(seen));
    expect(seen).toBe(expected);
    // The sentence must actually change when the two zones swap places, or a
    // reversed note would pass this case.
    expect(expected).not.toBe(
      UI_EN["runsheet.setTime.zoneNote"]!.replace("{orgTz}", "Asia/Tokyo").replace("{tz}", ORG_TZ),
    );

    // Phase 2 — the two zones AGREE, on a SECOND division of this test's own,
    // whose venue zone is set to the SAME `ORG_TZ` the org is already on. No
    // further org write: the column keeps the one value every test in this
    // describe puts there, so nothing here can contradict its neighbour.
    // Every absence below is paired with a positive twin (the editor and its
    // date input are visible), because `toHaveCount(0)` is equally satisfied
    // by a page that failed to render the editor at all.
    const matching = await seedRunSheetDivision(request, { tz: ORG_TZ });
    const noB = (await apiJson<{ fixture_no: number }>(request, `/api/v1/fixtures/${matching.fixtureIds[0]!}`)).data!
      .fixture_no;
    const rowB = await openEditor(matching.divisionId, noB);
    const editorText = (await rowB.getByTestId("run-sheet-set-time-editor").textContent())?.trim() ?? "";
    console.log(`editor text when orgTz === tz === ${ORG_TZ}:`, JSON.stringify(editorText.slice(0, 40)), "…");
    await expect(rowB.getByTestId("run-sheet-set-time-editor")).toBeVisible();
    await expect(rowB.locator('input[type="date"]')).toBeVisible();
    await expect(rowB.getByTestId("run-sheet-set-time-zone-note")).toHaveCount(0);
  });

  // FIX ROUND 5 — THE TEST THAT COULD NOT EXIST BEFORE THIS ROUND.
  //
  // Round 4 deleted the editor's `orgTz` READ as dead code, correctly: with
  // no way to reopen the editor on a fixture that already had a time, the
  // truthy branch of `fixture.scheduled_at ? zonedDateTimeInput(…, orgTz)`
  // was unreachable and a mutation of it could not go red. The owner has
  // since ruled that missing path a REGRESSION, so the read is back — and
  // this is the value pin it now owes.
  //
  // A wrong read here is NOT self-cancelling and is close to invisible: the
  // row DISPLAYS in `tz` (amendment 4) while the field READS in `orgTz`
  // (#448), so seeding the field from `tz` would make the editor agree with
  // the row on screen — which looks right — and then round-trip an instant
  // fourteen hours from the one the organiser was actually looking at. Only
  // a division where the two zones DISAGREE can tell the two implementations
  // apart, which is why this lives in the zone-split block.
  test("fix round 5 (owner ruling): the editor on an already-scheduled fixture opens in the ORG zone", async ({
    page,
    request,
  }) => {
    const { divisionId, fixtureIds } = await seedRunSheetDivision(request);
    expect(fixtureIds.length, "seed produced no fixtures — setup failed, not the sheet").toBeGreaterThanOrEqual(1);
    const target = fixtureIds[0]!;
    const fixtureNo = (await apiJson<{ fixture_no: number }>(request, `/api/v1/fixtures/${target}`)).data!.fixture_no;

    // 19:00Z on the 12th is 15:00 on the 12th in New York and 04:00 on the
    // 13th in Tokyo — the two zones disagree on the DATE as well as the
    // clock, so a wrong read cannot hide in the time half alone.
    const at = "2026-10-12T19:00:00.000Z";
    await setZoneSplitSql({
      divisionId,
      orgTz: ORG_TZ,
      divisionTz: "Asia/Tokyo",
      fixtureNo,
      at,
      registerRestore: (undo) => {
        pendingOrgTzRestore = undo;
      },
    });

    // DERIVED through the production helper the component itself calls —
    // never a typed constant, so this moves with the zones instead of
    // freezing today's arithmetic.
    const expectedInput = zonedDateTimeInput(at, ORG_TZ);
    const wrongZoneInput = zonedDateTimeInput(at, "Asia/Tokyo");
    expect(expectedInput, "the two zones must disagree for this instant, or the case proves nothing").not.toBe(
      wrongZoneInput,
    );

    await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
    const row = page.locator(`[data-fixture-no="${fixtureNo}"]`);
    // Opened through the affordance an organiser actually uses — the TIME
    // CELL — not by reaching for the editor directly.
    await row.getByTestId("run-sheet-edit-time").click();
    await expect(row.getByTestId("run-sheet-set-time-editor")).toBeVisible();

    const shown = await row.getByTestId("run-sheet-set-time-editor").evaluate((el) => ({
      date: (el.querySelector('input[type="date"]') as HTMLInputElement | null)?.value ?? null,
      time: (el.querySelector("select") as HTMLSelectElement | null)?.value ?? null,
    }));
    // The DISPLAY string, formatted in the page with the same call
    // `ClientTime` makes — never rebuilt from the ISO string by hand. F9 (W2
    // walkthrough gate 1) forced `hourCycle: "h23"` on the run sheet's time
    // cell specifically (its fixed 56px column wrapped a 12-hour "4:00 AM" to
    // two lines at every width) — mirrored here, or this comparison would
    // still expect the pre-fix AM/PM string and fail on the fix, not the
    // regression it exists to catch.
    const display = await page.evaluate(
      ([iso, venueTz, orgZone]) => {
        const d = new Date(iso);
        const f = (z: string) =>
          d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: z, hourCycle: "h23" });
        return { inTz: f(venueTz), inOrgTz: f(orgZone) };
      },
      [at, "Asia/Tokyo", ORG_TZ] as const,
    );
    console.log(
      "editor seed: instant",
      at,
      "| field shows",
      JSON.stringify(shown),
      "| expected (orgTz)",
      expectedInput,
      "| would-be-wrong (tz)",
      wrongZoneInput,
      "| row displays",
      JSON.stringify(display),
    );
    // THE PIN: the field is seeded in `orgTz`.
    expect(`${shown.date}T${shown.time}`).toBe(expectedInput);
    // And the ROW is displaying the other zone, so this case witnesses the
    // asymmetry rather than a division where it cannot arise. `toHaveText`
    // rather than a `textContent()` read: `ClientTime` starts as an empty
    // string and fills in on mount, so a single read can catch it pre-
    // hydration and pass or fail on timing rather than on the zone.
    expect(display.inTz, "the two zones must render differently, or this proves nothing").not.toBe(display.inOrgTz);
    await expect(row.getByTestId("run-sheet-edit-time")).toHaveText(display.inTz);
  });

  // ADJUDICATED FIX — a CANCELLED edit survived in the field.
  //
  // `when` used to be seeded by `useState`'s initializer, which runs once per
  // MOUNT, while `editing` toggles many times inside one mount and Cancel was
  // `setEditing(false)` and nothing else. Driven by hand: open the editor on
  // a fixture stored at 09:00, type a different time, press Cancel, reopen —
  // and the field still showed the abandoned value while the row's own time
  // cell printed the stored one. Two different times in one row, and ONE
  // confirming tap on Save would have committed the edit the organiser had
  // explicitly given up on. Clearing the date half and cancelling produced
  // the same lie inverted: a blank field, Save disabled, on a fixture that
  // has a time.
  //
  // BOTH DIRECTIONS ARE ASSERTED, and not for thoroughness' sake — a fix that
  // only reseeds when the stored value is non-empty passes the first case and
  // fails the second, so one case alone cannot tell a real fix from half of
  // one.
  //
  // It lives in THIS block, not outside it, because the expected seed has to
  // be exact: `zonedDateTimeInput(stored, ORG_TZ)` through the same helper the
  // component seeds with. Outside the block `orgTz` is whatever the shared
  // column happens to hold, which three other spec files also write — an
  // expectation derived from a value read at the top of a test can be stale by
  // the time the page renders (proven in round 4). Here the zone is set, so
  // the assertion is a real value pin rather than "stable across opens",
  // which a consistently WRONG seed would also satisfy.
  test("adjudicated fix: cancelling an edit does not leave the abandoned value in the field", async ({
    page,
    request,
  }) => {
    const { divisionId, fixtureIds } = await seedRunSheetDivision(request);
    expect(fixtureIds.length, "seed produced no fixtures — setup failed, not the sheet").toBeGreaterThanOrEqual(1);
    const target = fixtureIds[0]!;
    const fixtureNo = (await apiJson<{ fixture_no: number }>(request, `/api/v1/fixtures/${target}`)).data!.fixture_no;

    const stored = "2030-06-15T09:00:00.000Z";
    await setZoneSplitSql({
      divisionId,
      orgTz: ORG_TZ,
      divisionTz: "Asia/Tokyo",
      fixtureNo,
      at: stored,
      registerRestore: (undo) => {
        pendingOrgTzRestore = undo;
      },
    });
    // Derived through the component's own helper, never typed.
    const expectedSeed = zonedDateTimeInput(stored, ORG_TZ);

    await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
    // POSITIVE PAIR, first: the sheet and the row really rendered, so every
    // field reading below is about a page that got where it was going.
    await expect(page.getByTestId("run-sheet")).toBeVisible();
    const row = page.locator(`[data-fixture-no="${fixtureNo}"]`);
    await expect(row).toHaveCount(1);
    const editor = row.getByTestId("run-sheet-set-time-editor");

    const openEditor = async () => {
      await row.getByTestId("run-sheet-edit-time").click();
      // Second half of the positive pair — a value read from a closed editor
      // would be meaningless, and an absence assertion would pass on it.
      await expect(editor).toBeVisible();
      await expect(editor.locator('input[type="date"]')).toBeVisible();
    };
    const fieldValue = () =>
      editor.evaluate((el) => {
        const d = (el.querySelector('input[type="date"]') as HTMLInputElement | null)?.value ?? "";
        const t = (el.querySelector("select") as HTMLSelectElement | null)?.value ?? "";
        return `${d}T${t}`;
      });
    const cancel = async () => {
      await row.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(editor).toHaveCount(0);
    };

    await openEditor();
    expect(await fieldValue(), "the editor did not open on the stored instant").toBe(expectedSeed);

    // ---- direction 1: a TYPED value must not survive Cancel ----
    const typed = `${expectedSeed.slice(0, 10)}T16:45`;
    expect(typed, "pick a time that differs from the stored one, or this proves nothing").not.toBe(expectedSeed);
    await setDateTime(editor, typed);
    expect(await fieldValue(), "the typed value did not take").toBe(typed);
    await cancel();
    await openEditor();
    const afterCancel = await fieldValue();
    console.log("typed", typed, "then cancelled and reopened — field shows:", afterCancel, "| stored:", expectedSeed);
    expect(afterCancel, "a cancelled edit survived in the field").toBe(expectedSeed);

    // ---- direction 2: a CLEARED value must not survive Cancel either ----
    await editor.locator('input[type="date"]').fill("");
    expect((await fieldValue()).startsWith("T"), "the date half did not clear").toBe(true);
    await cancel();
    await openEditor();
    const afterClearCancel = await fieldValue();
    console.log("cleared the date then cancelled and reopened — field shows:", afterClearCancel);
    expect(afterClearCancel, "a cancelled CLEAR left the field blank on a fixture that has a time").toBe(expectedSeed);
  });
});

// Fix round 4, CRITICAL — the "When" field in this editor was ZERO PIXELS
// WIDE at every width, and every gate in the suite passed over it.
//
// `DateTimeSplitField`'s outer box is `@container` (`container-type:
// inline-size`), which applies inline-size CONTAINMENT: its own contents stop
// contributing to its inline size. As a flex item of this editor's row its
// flex-basis is `auto` → max-content → contained → 0, and both halves
// collapsed to the browser's ~26px minimum: on screen, an empty box under
// "When" with the time select's chevron floating over the Save button.
// Measured before the fix at 320/390/768/1280: container 0px, date input
// 26px, time select 26px, and the select's own centre hit-testing to a
// BUTTON. An organiser could not set a fixture time from this tab on any
// device — and with `FixtureLine` retired this is the only inline set-time
// path in the product.
//
// WHY NOTHING CAUGHT IT: `setDateTime` (helpers.ts) drives the halves with
// `.fill()` and `.selectOption()`, and `schedule-datetime-ux.spec.ts` reads
// `<option>` values straight out of the DOM. All of that works perfectly on a
// zero-width control — the element exists, is "visible" to Playwright, and
// accepts programmatic input. Only a BOX MEASUREMENT plus a real hit test can
// see it, which is what this case is.
test("fix round 4: the inline Set-time field is a usable, tappable control at 320 and at 1280", async ({
  page,
  request,
}) => {
  const { divisionId, fixtureIds } = await seedRunSheetDivision(request);
  expect(fixtureIds.length, "seed produced no fixtures — setup failed, not the sheet").toBeGreaterThanOrEqual(1);

  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
    const sheet = page.getByTestId("run-sheet");
    await expect(sheet).toBeVisible();

    const setTime = sheet.locator('[data-row-action="set_time"]').first();
    await setTime.scrollIntoViewIfNeeded();
    await setTime.click();
    // Deliberately located by the CONTROL it contains, not by the
    // `run-sheet-set-time-editor` testid that shipped alongside this fix: an
    // assertion introduced in the same commit as its own hook can only be run
    // against the fixed build, and this case had to produce a true red
    // against the BROKEN one first. It did — 26px halves, container 0px.
    const editor = sheet.locator("li", { has: page.locator('input[type="date"]') }).first();
    await expect(editor.locator('input[type="date"]')).toBeVisible();

    // Measured from the LIVE box, and hit-tested at the tap point with
    // `document.elementFromPoint` — never `boundingBox()` alone, which
    // reports paint and not hit area (a control can measure 44px and still
    // be untappable under an overlay). `scrollIntoView` first: elementFromPoint
    // is VIEWPORT-relative and returns null for anything below the fold,
    // which reads as "untappable" when it only means "off-screen".
    const seen = await editor.evaluate((el) => {
      const container = el.querySelector('[class*="@container"]') as HTMLElement | null;
      const dateInput = el.querySelector('input[type="date"]') as HTMLElement | null;
      const timeSelect = el.querySelector("select") as HTMLElement | null;
      const w = (node: HTMLElement | null) => (node === null ? -1 : Math.round(node.getBoundingClientRect().width));
      const hit = (node: HTMLElement | null) => {
        if (node === null) return "(absent)";
        node.scrollIntoView({ block: "center" });
        const r = node.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return "(zero box)";
        const target = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return target === node ? "self" : `${target?.tagName.toLowerCase() ?? "(nothing)"}`;
      };
      return {
        containerW: w(container),
        dateW: w(dateInput),
        timeW: w(timeSelect),
        dateHit: hit(dateInput),
        timeHit: hit(timeSelect),
      };
    });
    console.log(`set-time field at ${width}px:`, JSON.stringify(seen));

    // 120px is not a style preference: below it a `dd/mm/yyyy` date input
    // clips its own placeholder and the time select shows a bare chevron —
    // the state this test exists to prevent measured 26px. The defect it
    // witnesses is an order of magnitude away from the threshold, so the
    // number is a floor, not a pixel-perfect snapshot that will churn.
    expect(seen.containerW, `the @container box collapsed at ${width}px`).toBeGreaterThanOrEqual(200);
    expect(seen.dateW, `the date input is unusably narrow at ${width}px`).toBeGreaterThanOrEqual(120);
    expect(seen.timeW, `the time select is unusably narrow at ${width}px`).toBeGreaterThanOrEqual(120);
    expect(seen.dateHit, `the date input is not what a tap at its centre hits at ${width}px`).toBe("self");
    expect(seen.timeHit, `the time select is not what a tap at its centre hits at ${width}px`).toBe("self");
    // REVIEW FINDING 4 — this used to compare `documentElement.scrollWidth`
    // to its own `clientWidth`, which CANNOT FAIL. `globals.css:71` sets
    // `overflow-x: clip` on `html, body`, and a clipped overflow does not
    // grow `scrollWidth`: the two numbers are equal on every page in this
    // app no matter how far a child sticks out, so the assertion was a
    // tautology dressed as a viewport gate (the same defect #325 already
    // fixed once, in `helpers.ts`). `expectNoHorizontalScroll` is the
    // repo's own answer: it lifts the clip, reads the real `scrollWidth`,
    // and — crucially — only names a culprit that is NOT contained by its
    // own `overflow-x: auto|scroll|hidden` ancestor, so a legitimate
    // swipe rail stays a feature while a clipped overflow stays a defect.
    await expectNoHorizontalScroll(page);
    // ...and the sheet's own card clips, so the page-level helper alone
    // still cannot witness an overflow that starts inside it.
    await expectRunSheetNotClipped(page, `open Set-time editor at ${width}px`);

    // And it still WORKS as a control, not just as a box: type a time
    // through the same helper every other spec uses and read it back.
    await setDateTime(editor, "2030-06-15T14:30");
    const roundTrip = await editor.evaluate((el) => ({
      date: (el.querySelector('input[type="date"]') as HTMLInputElement | null)?.value ?? null,
      time: (el.querySelector("select") as HTMLSelectElement | null)?.value ?? null,
    }));
    console.log(`set-time field round trip at ${width}px:`, JSON.stringify(roundTrip));
    expect(roundTrip).toEqual({ date: "2030-06-15", time: "14:30" });
  }
});

// Written in round 4 as the premise behind the (then) deleted `orgTz` read:
// `fixtureRowAction`'s branch 4 returns `set_time` only for
// `scheduledAt === null`, so a timed fixture's ACTION is `score` /
// `assign_scorer` / `result`, each a plain `<Link>` that never opens an
// editor. That half is unchanged and still asserted. What round 5 changed is
// the conclusion drawn from it: the editor being unreachable was a
// REGRESSION, not a design, and the time cell is now its door.
//
// RENAMED IN ROUND 5, because round 5 made the old name a lie. It used to
// read "…offers no inline editor at all", which was true when the only door
// was the `set_time` action; the owner has since ruled that gap a regression
// and the time cell is now a door. What this case still asserts — and what
// it is now named for — is that the ACTION COLUMN stays at one control and
// that control is scoring, with the editor reachable somewhere else. A test
// whose title outlives what it asserts is a defect in its own right
// (_RULES.md: "Read what a test ASSERTS, never what it is called" — this
// repo has shipped one asserting the opposite of its title).
test("a timed fixture's ACTION is scoring — the editor is not in the action column", async ({ page, request }) => {
  const { divisionId, fixtureIds } = await seedRunSheetDivision(request);
  expect(fixtureIds.length, "seed produced no fixtures — setup failed, not the sheet").toBeGreaterThanOrEqual(1);
  const target = fixtureIds[0]!;
  const fixtureNo = (await apiJson<{ fixture_no: number }>(request, `/api/v1/fixtures/${target}`)).data!.fixture_no;
  await setFixtureScheduledAtSql(target, "2030-06-15T09:00:00.000Z");

  await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
  await expect(page.getByTestId("run-sheet")).toBeVisible();
  const row = page.locator(`[data-fixture-no="${fixtureNo}"]`);
  // POSITIVE twin first: the row is really on the page and really carries an
  // action, so the absences below are absences and not a blank page.
  await expect(row).toHaveCount(1);
  const action = await row.locator("[data-row-action]").getAttribute("data-row-action");
  console.log(`scheduled fixture_no=${fixtureNo} action:`, action);
  expect(["score", "assign_scorer"], "a timed, unsettled fixture is scoring work").toContain(action);
  await expect(row.locator('[data-row-action="set_time"]')).toHaveCount(0);
  await expect(row.getByTestId("run-sheet-set-time-editor")).toHaveCount(0);
  await expect(row.locator('input[type="date"]')).toHaveCount(0);
  // Fix round 5: the row now reaches its editor through the TIME CELL
  // instead — the door round 4 correctly reported as missing. The absence
  // above is still the right assertion for the ACTION column (one control,
  // and it is scoring), so this positive twin says where the door moved to.
  await expect(row.getByTestId("run-sheet-edit-time")).toHaveCount(1);
});

// FIX ROUND 5 — the restored "correct a time already set" path, driven end
// to end as an organiser would.
//
// Owner ruling: pre-W2 the row carried `schedule.editTime` plus a separate
// `schedule.unschedule`; the rewrite dropped both and nothing on this tab
// took them over, so an organiser handling a rain delay or a typo had no way
// back on the tab they were standing on — the row just said "Score". The
// affordance is now the TIME CELL itself, and "clear this time" lives inside
// the editor rather than as a second row-level control.
//
// Deliberately ZONE-AGNOSTIC. It asserts the ROUND TRIP ("I set 16:45; when
// I come back it says 16:45"), not an absolute instant, so it cannot be
// perturbed by whatever `organizations.timezone` happens to be while the
// serial zone-split block above is running in another worker. The absolute
// value in `orgTz` is pinned by that block's own case, where the zone is
// controlled.
test("fix round 5: the time cell opens the editor, corrects the time, and can clear it", async ({ page, request }) => {
  const { divisionId, fixtureIds } = await seedRunSheetDivision(request);
  expect(fixtureIds.length, "seed produced no fixtures — setup failed, not the sheet").toBeGreaterThanOrEqual(1);
  const target = fixtureIds[0]!;
  const fixtureNo = (await apiJson<{ fixture_no: number }>(request, `/api/v1/fixtures/${target}`)).data!.fixture_no;
  await setFixtureScheduledAtSql(target, "2030-06-15T09:00:00.000Z");

  // A REAL TAP TARGET at both widths, hit-tested at the click point. The
  // round-4 defect was a control whose centre resolved to the Save button, so
  // `boundingBox()` alone is not evidence — and `elementFromPoint` is
  // viewport-relative, so the element is scrolled into view first or an
  // off-screen control reads as untappable.
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
    const row = page.locator(`[data-fixture-no="${fixtureNo}"]`);
    const cell = row.getByTestId("run-sheet-edit-time");
    await expect(cell).toBeVisible();
    const seen = await cell.evaluate((el) => {
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return {
        w: Math.round(r.width),
        h: Math.round(r.height),
        // The button or anything inside it counts — `ClientTime` renders a
        // child, so requiring strict identity would fail on a correct build.
        hitsSelf: hit !== null && (hit === el || el.contains(hit)),
        hitTag: hit === null ? "(nothing)" : hit.tagName.toLowerCase(),
        name: el.getAttribute("aria-label"),
        text: (el.textContent ?? "").trim(),
      };
    });
    console.log(`time cell at ${width}px:`, JSON.stringify(seen));
    expect(seen.h, `the time cell is not a 44px tap target at ${width}px`).toBeGreaterThanOrEqual(44);
    expect(seen.hitsSelf, `a tap at the time cell's centre hits ${seen.hitTag} at ${width}px`).toBe(true);
    // It must SAY what it does — "09:00" alone is not an accessible name.
    expect(seen.name, "the time cell has no accessible name").toBeTruthy();
    // REVIEW FINDING 4, second site — see the note in the round-4 case
    // above. `scrollWidth <= clientWidth` is a tautology under
    // `html, body { overflow-x: clip }` and could not fail; this helper
    // lifts the clip, measures the document's real width, and is blind to
    // sanctioned scrolling regions rather than blaming them.
    await expectNoHorizontalScroll(page);
    await expectRunSheetNotClipped(page, `time cell at ${width}px`);
  }

  // CORRECT THE TIME. Asserted as a round trip through the product's own
  // read: type it, save it, reopen, and read the field back.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
  const row = page.locator(`[data-fixture-no="${fixtureNo}"]`);
  await row.getByTestId("run-sheet-edit-time").click();
  const editor = row.getByTestId("run-sheet-set-time-editor");
  await expect(editor).toBeVisible();

  // AXE, scoped to the sheet, with the editor OPEN. `mobile.spec.ts`'s own
  // axe sweep covers `?tab=standings` and never this tab, so the run sheet
  // had zero accessibility coverage — and round 5 turns a passive time label
  // into an interactive control, which is exactly the kind of change that
  // rule set exists to catch. Scoped with `.include` rather than scanning the
  // whole page: this asserts something about MY surface, and a page-wide
  // scan here would either inherit unrelated violations or need exclusions
  // that quietly hide real ones. Non-vacuous by construction — the sheet is
  // on screen with rows and an open editor at this point, which the
  // assertions above have already proven.
  const axe = await new AxeBuilder({ page }).include('[data-testid="run-sheet"]').withTags(["wcag2a", "wcag2aa"]).analyze();
  const blocking = axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  console.log(
    "axe on the run sheet (editor open):",
    axe.violations.length,
    "violations,",
    blocking.length,
    "serious/critical",
  );
  expect(
    blocking.map((v) => `${v.id} — ${v.nodes[0]?.html}`),
    "axe serious/critical on the run sheet with the time editor open",
  ).toEqual([]);
  const corrected = "2030-06-15T16:45";
  await setDateTime(editor, corrected);
  await row.getByRole("button", { name: "Save", exact: true }).click();

  // The write landed at all (zone-independent: any instant but the original).
  let afterSave: string | null | undefined;
  await expect
    .poll(
      async () => {
        afterSave = (await apiJson<{ scheduled_at: string | null }>(request, `/api/v1/fixtures/${target}`)).data!
          .scheduled_at;
        return afterSave;
      },
      { timeout: 15_000 },
    )
    .not.toBe("2030-06-15T09:00:00.000Z");
  console.log("corrected time: typed", corrected, "| stored", afterSave);
  expect(afterSave, "the correction did not store an instant at all").toBeTruthy();

  // NOT asserted here: what the field shows when reopened. That is a
  // ZONE-DEPENDENT reading (`orgTz`), and `organizations.timezone` is shared
  // and written by three other spec files as well as this one's serial
  // block, so a value seeded before a reload and read after it can straddle
  // a concurrent flip. It is pinned instead in the zone-split block, where
  // the zone is controlled and the assertion is strictly stronger — the
  // exact instant, against `zonedDateTimeInput(at, orgTz)`.

  // CLEAR IT — the retired `schedule.unschedule` capability, recovered
  // inside the editor rather than as a second row-level control. Reopened
  // through the same time cell, which is the point of the affordance.
  await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
  await row.getByTestId("run-sheet-edit-time").click();
  await expect(editor).toBeVisible();
  await editor.getByTestId("run-sheet-clear-time").click();
  await expect
    .poll(
      async () =>
        (await apiJson<{ scheduled_at: string | null }>(request, `/api/v1/fixtures/${target}`)).data!.scheduled_at,
      { timeout: 15_000 },
    )
    .toBeNull();
  // And the row goes back to being open scheduling work — positive twin for
  // the absence below, so "the time cell is gone" cannot pass on a blank page.
  await expect(row.locator('[data-row-action="set_time"]')).toHaveCount(1);
  await expect(row.getByTestId("run-sheet-edit-time")).toHaveCount(0);
  console.log("after clearing: the row is open scheduling work again (set_time), and the time cell is inert");
});

// FIX ROUND 5, the dead-end guard. `moveFixture` refuses a timetable change
// for any status but `MOVABLE_STATUS` ("scheduled") with a 422 — "fixture is
// X — decided fixtures are immutable". So the time cell must NOT be an
// affordance on an in-play or settled row: an editor whose Save cannot
// succeed is a dead end, which is the class this whole wave exists to remove.
//
// The still-scheduled row in the same division is the POSITIVE CONTROL. Both
// absences below would pass just as happily on a build where the feature
// never renders at all; the control is what makes them mean "because of the
// status".
test("fix round 5: an in-play or settled row's time is not an affordance, but a scheduled one's is", async ({
  page,
  request,
}) => {
  const { divisionId, fixtureIds } = await seedRunSheetDivision(request);
  expect(fixtureIds.length, "seed needs three fixtures for this case").toBeGreaterThanOrEqual(3);
  const nos: number[] = [];
  for (const id of [fixtureIds[0]!, fixtureIds[1]!, fixtureIds[2]!]) {
    await setFixtureScheduledAtSql(id, "2030-06-15T09:00:00.000Z");
    nos.push((await apiJson<{ fixture_no: number }>(request, `/api/v1/fixtures/${id}`)).data!.fixture_no);
  }
  await setFixtureStatusSql(fixtureIds[0]!, "in_play");
  await setFixtureStatusSql(fixtureIds[1]!, "decided");
  // fixtureIds[2] stays `scheduled` — the control.

  await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
  const sheet = page.getByTestId("run-sheet");
  await expect(sheet).toBeVisible();
  // EXPLICITLY "All". The sheet has opened on "all" since PB1 whatever the day
  // reads as (it used to open on "today" once an `in_play` fixture tipped the
  // division into a match day, which with rows dated 2030 emptied the sheet).
  // Kept as a guard: clicking it is a no-op when "all" is already active.
  await sheet.locator('[data-filter="all"]').click();

  const report: Record<string, unknown> = {};
  for (const [label, no] of [
    ["in_play", nos[0]!],
    ["decided", nos[1]!],
    ["scheduled", nos[2]!],
  ] as const) {
    const row = page.locator(`[data-fixture-no="${no}"]`);
    await expect(row, `${label} row is missing from the sheet entirely`).toHaveCount(1);
    report[label] = {
      action: await row.locator("[data-row-action]").getAttribute("data-row-action"),
      editTimeCells: await row.getByTestId("run-sheet-edit-time").count(),
    };
  }
  console.log("time-cell affordance by status:", JSON.stringify(report));

  await expect(page.locator(`[data-fixture-no="${nos[0]}"]`).getByTestId("run-sheet-edit-time")).toHaveCount(0);
  await expect(page.locator(`[data-fixture-no="${nos[1]}"]`).getByTestId("run-sheet-edit-time")).toHaveCount(0);
  // THE CONTROL: the same page, the same division, a movable row — the
  // affordance is there.
  await expect(page.locator(`[data-fixture-no="${nos[2]}"]`).getByTestId("run-sheet-edit-time")).toHaveCount(1);
});

// Match Day E1 item 1 (owner 2026-11-01) - the stage's actions moved INTO the card header. History: Competition Desk W3 Task 5 gave the
// rail a desktop COLUMN, "Option B" stacked it BELOW the sheet, and now the actions group is the header's own: on one row with the title,
// to the left of a thin divider and the settings buttons, above the rows. What this case still guards is the sweep that every action
// control lives in the rail and ONLY the rail - never inside the rows (`stage-run-sheet`), and never a second copy elsewhere.
// `roster-drift-banner`/`roster-drift-rebuild` stay out of the sweep: they are per-stage STATE about the fixtures below, not an action.
//
// The footer ("To schedule in this stage N ->", `stage-unscheduled-count`) is GONE - the counts line says it - so it is no longer a
// stage-chrome testid; its absence is asserted in its own right below.
//
// Run as an EDITING viewer: for a non-editing viewer `<StageRail>` returns `null` and the court-tags line is the only chrome left.
const STAGE_CHROME_TESTIDS = ["stage-generate", "stage-complete", "stage-delete", "stage-add-match"] as const;

test("desktop (E1): the stage's actions sit in the card HEADER - left of the divider and the settings buttons, above the rows - and none leaks into the rows", async ({
  page,
  request,
}) => {
  // The default league stage from `seedRunSheetDivision`: unscheduled fixtures (nothing scheduled yet), the sole stage (deletable), status
  // not complete, an adhoc kind (league) - the state that makes the testids actually render, so the "none in the rows" sweep below
  // witnesses a real move rather than a vacuous scan over controls nothing ever built.
  const { divisionId, fixtureIds } = await seedRunSheetDivision(request);
  expect(fixtureIds.length, "seed produced no fixtures - setup failed, not the layout").toBeGreaterThanOrEqual(1);

  // Fixed viewport, deliberately: the geometry has to mean "at 1280", not "whatever this project happens to be sized at today".
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));

  const card = page.locator("section.card[data-stage-id]").first();
  const header = card.locator("header").first();
  const rail = card.getByTestId("stage-rail");
  const rows = card.getByTestId("stage-run-sheet");
  const tools = card.getByTestId("stage-tools");
  const divider = card.getByTestId("stage-controls-divider");
  await expect(header, "the card header did not render - nothing was measured").toBeVisible();
  await expect(rail, "stage-rail did not render - nothing was measured").toBeVisible();
  await expect(rows, "the stage's rows did not render - nothing was measured").toBeVisible();

  const headerBox = (await header.boundingBox())!;
  const railBox = (await rail.boundingBox())!;
  const rowsBox = (await rows.boundingBox())!;
  const toolsBox = (await tools.boundingBox())!;
  const dividerBox = (await divider.boundingBox())!;
  const title = (await card.locator("header h3").first().boundingBox())!;
  console.log("E1 geometry - header:", headerBox, "| rail:", railBox, "| divider:", dividerBox, "| tools:", toolsBox, "| rows:", rowsBox);
  // The actions are INSIDE the header's box, and the header is above the rows.
  expect(railBox.y, "the rail starts inside the header").toBeGreaterThanOrEqual(headerBox.y - 1);
  expect(railBox.y + railBox.height, "and ends inside it").toBeLessThanOrEqual(headerBox.y + headerBox.height + 1);
  expect(headerBox.y + headerBox.height, "the header is above the rows").toBeLessThanOrEqual(rowsBox.y + 1);
  // One row at 1280: the title, then the actions, then the divider, then the settings buttons - left to right, on one line.
  expect(railBox.x, "the actions are right of the title").toBeGreaterThan(title.x + title.width - 1);
  expect(dividerBox.x, "the divider is right of the actions").toBeGreaterThanOrEqual(railBox.x + railBox.width - 1);
  expect(toolsBox.x, "the settings buttons are right of the divider").toBeGreaterThanOrEqual(dividerBox.x + dividerBox.width - 1);
  expect(Math.abs(railBox.y - toolsBox.y), "actions and settings share a line").toBeLessThan(24);
  expect(dividerBox.width, "a thin rule").toBeLessThanOrEqual(2);

  // PRINT WHAT WAS SEEN beside the gate (_RULES.md): where each stage-chrome testid landed.
  const presence: Record<string, { onPage: number; inRail: number; inRows: number }> = {};
  for (const testid of STAGE_CHROME_TESTIDS) {
    presence[testid] = {
      onPage: await page.locator(`[data-testid="${testid}"]`).count(),
      inRail: await rail.locator(`[data-testid="${testid}"]`).count(),
      inRows: await rows.locator(`[data-testid="${testid}"]`).count(),
    };
  }
  console.log("E1 stage-chrome testid placement:", JSON.stringify(presence));
  const totalOnPage = Object.values(presence).reduce((n, p) => n + p.onPage, 0);
  expect(totalOnPage, "none of the stage-chrome testids rendered at all - the sweep below would be vacuous").toBeGreaterThan(0);
  for (const testid of STAGE_CHROME_TESTIDS) {
    expect(presence[testid]!.inRows, `${testid} leaked into the rows`).toBe(0);
    // Whatever DID render is fully accounted for inside the rail - never a second copy somewhere else on the page.
    expect(presence[testid]!.inRail, `${testid}: rail count does not match page-wide count`).toBe(presence[testid]!.onPage);
  }
  // The retired footer: not there at any width.
  // Final review G6: `stage-unscheduled-count` is rendered by no source now, so asserting it absent could never fail. What took the
  // footer's place is asserted instead: the counts line's clause is the one door to the Schedule page (exactly one on the page), it says
  // the seed's own count - every fixture the seed made is still unscheduled - and it is a real link.
  const toSchedule = page.getByTestId("stage-progress-to-schedule");
  await expect(toSchedule, "exactly one 'to schedule' door on the page: the counts line's clause").toHaveCount(1);
  await expect(toSchedule, "the clause says how many fixtures the seed left unscheduled").toHaveText(`${fixtureIds.length} to schedule`);
  await expect(toSchedule, "and it is the link to the Schedule page").toHaveAttribute("href", /\/schedule$/);
  await expect(page.getByText("To schedule in this stage")).toHaveCount(0);
  // ...and the count it carried is still said, in the counts line.
  await expect(card.getByTestId("stage-progress-counts")).toContainText(/\d+ to schedule/);
});

// W3 Task 8 — unify the phone breakpoint on `md:` (768), not `sm:` (640).
// Ruling 15: the ledger switches at `md:`, while the masthead and this row
// used to switch at `sm:` — at 768 the ledger was already a card while the
// run sheet was already a desktop row, i.e. the two disagreed about where
// "phone" ends. 768 already reads as one line under EITHER breakpoint (768
// >= 640 and >= 768), so it cannot witness this change by itself — the case
// that actually distinguishes `sm:` from `md:` is 700 (>= 640, < 768), a
// width no e2e project covers (the seven-width matrix is
// 320/360/375/390/430/768/834 — nothing in 641-767). Before this task the
// row read `sm:flex-row`, so 700 rendered ONE LINE (wrong: an organiser
// scrolling faster than 768px still had the entrant name and the action
// sharing a row it should not); after, `md:flex-row`, so 700 stays STACKED.
test("Task 8: the run-sheet row is one line at 768 and still stacked at 700 (md, not sm)", async ({
  page,
  request,
}) => {
  const { divisionId, fixtureIds } = await seedRunSheetDivision(request);
  expect(fixtureIds.length, "seed produced no fixtures — setup failed, not the row").toBeGreaterThanOrEqual(1);
  const target = fixtureIds[0]!;
  const fixtureNo = (await apiJson<{ fixture_no: number }>(request, `/api/v1/fixtures/${target}`)).data!.fixture_no;
  // A future, still-`scheduled` time so `canEditFixtureTime` renders the time
  // cell as a button (`run-sheet-edit-time`, same setup `fixtureRowAction`'s
  // own test above uses) — the element this test measures against the
  // action column.
  await setFixtureScheduledAtSql(target, "2030-06-15T09:00:00.000Z");

  for (const { width, stacked } of [
    { width: 768, stacked: false },
    { width: 700, stacked: true },
  ]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
    const sheet = page.getByTestId("run-sheet");
    await expect(sheet).toBeVisible();
    const row = page.locator(`[data-fixture-no="${fixtureNo}"]`);
    await expect(row).toHaveCount(1);
    const timeCell = row.getByTestId("run-sheet-edit-time");
    const action = row.locator("[data-row-action]").first();
    await expect(timeCell, `no editable time cell at ${width}px — setup did not produce the state under test`).toBeVisible();
    await expect(action, `no action element at ${width}px — setup did not produce the state under test`).toBeVisible();
    const timeBox = await timeCell.boundingBox();
    const actionBox = await action.boundingBox();
    // PRINT WHAT WAS SEEN beside the gate (_RULES.md) — a width gate cannot
    // otherwise tell you it measured the wrong page state.
    console.log(`Task 8 row geometry at ${width}px — time cell box:`, timeBox, "| action box:", actionBox);
    expect(timeBox, `time cell has no box at ${width}px`).not.toBeNull();
    expect(actionBox, `action has no box at ${width}px`).not.toBeNull();
    const deltaY = Math.abs(actionBox!.y - timeBox!.y);
    if (stacked) {
      expect(
        deltaY,
        `expected the row STACKED at ${width}px (action well below the time cell), saw deltaY=${deltaY}`,
      ).toBeGreaterThan(20);
    } else {
      expect(
        deltaY,
        `expected the row ONE LINE at ${width}px (time cell and action share a y), saw deltaY=${deltaY}`,
      ).toBeLessThan(6);
    }
  }
});

// W3 Task 9 (A3) — the phone run-sheet row becomes two deliberate lines.
//
// Before this, the phone row reflowed into THREE lines below `md` (meta,
// name, action) — a FOURTH whenever a fixture actually carried a result or
// "no scorer yet" sub-line, which the seeded state below does on purpose, so
// the merge this task makes is actually exercised. Design of record (W3
// spec, "Tasks 1 and 6-10"): "the acceptance criterion for the phone work is
// a CONTROL-SET DIFF... W2's gate measured them byte-identical (71 controls,
// diff empty) — that equality is the groomed-shrink signature this wave
// exists to break, not a side effect of it." A box-size or screenshot
// comparison cannot witness that; only a diff of the live DOM's visible
// parts can.
test("Task 9: the phone run-sheet row is two deliberate lines, and its control set differs from desktop's", async ({
  page,
  request,
}) => {
  // `middayZoneFor` (this file, above): the venue zone this seed's "today"
  // check runs in. Puts ~12h of headroom either side of the UTC day
  // boundary around the `scheduled_at` set below, the same reasoning the
  // day-grouping case at the top of this file already needed once.
  const { divisionId, fixtureIds } = await seedRunSheetDivision(request, { tz: middayZoneFor(Date.now()) });
  expect(fixtureIds.length, "seed produced no fixtures — setup failed, not the row").toBeGreaterThanOrEqual(1);
  const target = fixtureIds[0]!;
  const targetInfo = await apiJson<{ fixture_no: number; home_entrant_id: string | null }>(
    request,
    `/api/v1/fixtures/${target}`,
  );
  const fixtureNo = targetInfo.data!.fixture_no;
  const homeEntrantId = targetInfo.data!.home_entrant_id;
  expect(homeEntrantId, "seeded fixture has no home entrant — cannot rename it, not what this case tests").not.toBeNull();

  // A realistic long entrant name, not a short placeholder — the scorepad
  // phone-composition wave's own regression (a single missing `min-w-0` on
  // the ancestor chain put 106px of overflow on the page at 320-390) was
  // visible ONLY with a name this long and only in a browser.
  const LONG_NAME = "Bartholomew Alexander Weatherstonehaugh Jr.";
  expect(LONG_NAME.length, "fixture setup: this case needs the realistic 43-char name the brief calls for").toBe(43);
  const renamed = await apiJson(request, `/api/v1/entrants/${homeEntrantId}`, "PATCH", { display_name: LONG_NAME });
  expect(renamed.status, `renaming the entrant failed: ${JSON.stringify(renamed.error)}`).toBeLessThan(300);

  // Match Day E1 item 1: a row under its round's bar no longer says "Round N", so the merge this case witnesses needs a meta part that
  // is still there. A COURT is one (`courtLabel`): without it the meta line is empty, the phone has nothing to fold into line 2, and the
  // phone and desktop sets are legitimately equal - the "differ" gate below would then be failing on the seed, not on the row.
  const { venueId, courts } = await seedVenueWithCourts(request, ["Centre"]);
  const placed = await apiJson(request, `/api/v1/fixtures/${target}`, "PATCH", { venue_id: venueId, court_id: courts[0]!.id });
  expect(placed.status, `placing the fixture on a court failed: ${JSON.stringify(placed.error)}`).toBeLessThan(300);

  // Scheduled TODAY with no officials assigned — `fixtureRowAction`'s branch
  // 6, the ONE ladder state that populates the result-shaped sub-line
  // ("No scorer yet") alongside a real action ("Assign scorer"). A fixture
  // with neither would leave line 2 carrying only the meta text, and could
  // not witness the meta+sub-line MERGE this task makes.
  await setFixtureScheduledAtSql(target, new Date(Date.now() + 5 * 60_000).toISOString());

  // The row's visible parts — every visible `a[href]`/`button`/`p` inside
  // it, as `tag:text`, in BOTH forms: `order` is GEOMETRIC reading order
  // (y-centre then x — never DOM order, since CSS is what composes a phone
  // row) for the report to show what a reader actually sees; `bag` is the
  // same list SORTED, for the membership+repeats comparison the acceptance
  // criterion gates on.
  //
  // The gate reads `bag`, not `order`, because `order` has a real, harmless
  // tie this row's OWN desktop layout already contains and Task 9 does not
  // touch: `items-center` puts the action button's centre exactly on the
  // entrant column's MIDDLE line (measured: time/name/action all centre at
  // y=857 on a seeded row, meta 18px above, sub-line 18px below), so at
  // 1280 the action sorts ahead of the sub-line by x — a tie-break, not a
  // compositional fact. Gating on `order` flagged that tie as "the sets
  // already differ" against the UNCHANGED baseline the first time this was
  // run (see the task report), which would make the gate pass without the
  // fix ever landing — the "guard nothing kills" shape. `bag` is immune to
  // it: today the exact same five strings render at both widths (same bag,
  // different tie-broken order); after the fix, hiding the meta/sub-line
  // paragraphs on phone and replacing them with ONE combined string is a
  // genuine four-vs-five MEMBERSHIP change no tie-break can produce.
  const rowControlSet = (fno: number): Promise<{ order: string[]; bag: string[] }> =>
    page.evaluate((fixtureNoArg) => {
      const root = document.querySelector<HTMLElement>(`[data-fixture-no="${fixtureNoArg}"]`);
      if (root === null) return { order: ["(row absent)"], bag: ["(row absent)"] };
      const isVisible = (el: HTMLElement) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
      };
      const items = Array.from(root.querySelectorAll<HTMLElement>("a[href], button, p"))
        .filter(isVisible)
        .map((el) => {
          const r = el.getBoundingClientRect();
          const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
          return { tag: el.tagName.toLowerCase(), text, yCenter: Math.round(r.top + r.height / 2), x: Math.round(r.left) };
        })
        .filter((i) => i.text !== "");
      const order = [...items].sort((a, b) => a.yCenter - b.yCenter || a.x - b.x).map((i) => `${i.tag}:${i.text}`);
      const bag = [...order].sort();
      return { order, bag };
    }, fno);

  const sets: Record<number, { order: string[]; bag: string[] }> = {};
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
    await dismissCookieBanner(page);
    const sheet = page.getByTestId("run-sheet");
    await expect(sheet, `run sheet did not render at ${width}px`).toBeVisible();
    const row = page.locator(`[data-fixture-no="${fixtureNo}"]`);
    await expect(row, `seeded row did not render at ${width}px`).toHaveCount(1);
    sets[width] = await rowControlSet(fixtureNo);
  }
  // PRINT WHAT WAS SEEN beside the gate (_RULES.md) — this dump IS the
  // baseline/after-fix measurement the task report has to carry.
  console.log("Task 9 row control set at 320px: ", JSON.stringify(sets[320]));
  console.log("Task 9 row control set at 1280px:", JSON.stringify(sets[1280]));

  // THE ACCEPTANCE CRITERION (design of record, quoted above): the phone and
  // desktop composition must be a genuinely different set of visible parts.
  // Non-vacuous first — an empty-vs-empty "difference" would trivially
  // satisfy the inequality below without proving anything.
  expect(sets[320]!.bag.length, "phone control set is empty — nothing was measured").toBeGreaterThan(0);
  expect(sets[1280]!.bag.length, "desktop control set is empty — nothing was measured").toBeGreaterThan(0);
  expect(
    sets[320]!.bag,
    "the 320px and 1280px control sets must DIFFER — see the printed sets above; equal sets mean the phone row is the desktop row shrunk, not composed",
  ).not.toEqual(sets[1280]!.bag);

  // ---- geometry at 320: exactly two lines ---------------------------------
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
  await dismissCookieBanner(page);
  const row320 = page.locator(`[data-fixture-no="${fixtureNo}"]`);
  await expect(row320, "seeded row did not render at 320px").toHaveCount(1);

  const nameLink = row320.locator("a", { hasText: LONG_NAME.slice(0, 12) }).first();
  const action = row320.locator("[data-row-action]").first();
  const timeEl = row320.getByTestId("run-sheet-edit-time");
  await expect(nameLink, "no entrant name link at 320px — setup did not produce the state under test").toBeVisible();
  await expect(action, "no action element at 320px — setup did not produce the state under test").toBeVisible();
  await expect(
    timeEl,
    "no editable time cell at 320px — setup did not reach canEditFixtureTime, not what this case tests",
  ).toBeVisible();

  // The two-line ceiling, DERIVED live from the row's own computed styles —
  // never a hardcoded pixel constant, which goes stale the moment the type
  // scale or the tap-target floor moves (the "flat literal beside a derived
  // boundary" shape Ruling T8-C, above in mobile.spec.ts, exists to prevent).
  const geometry = await row320.evaluate((li) => {
    const num = (v: string) => parseFloat(v) || 0;
    const outer = li.firstElementChild as HTMLElement | null; // the flex-col wrapper
    const nameEl = li.querySelector("a[href]") as HTMLElement | null;
    const actionEl = li.querySelector("[data-row-action]") as HTMLElement | null;
    const liCs = getComputedStyle(li);
    const outerCs = outer ? getComputedStyle(outer) : null;
    return {
      liHeight: li.getBoundingClientRect().height,
      lineHeight: nameEl ? num(getComputedStyle(nameEl).lineHeight) : 20,
      actionMinHeight: actionEl ? num(getComputedStyle(actionEl).minHeight) : 44,
      rowGap: outerCs ? num(outerCs.rowGap || outerCs.gap) : 8,
      padY: num(liCs.paddingTop) + num(liCs.paddingBottom),
    };
  });
  console.log("Task 9 geometry at 320px:", JSON.stringify(geometry));
  // Each of the two lines is at least as tall as its own control's declared
  // tap floor (line 1's time button, line 2's action button both carry
  // `min-h-11`) or its text line-height, whichever is taller — plus the
  // row's own gap and padding. A small rounding tolerance (2px) covers
  // sub-pixel layout, never a margin big enough to hide a real third line.
  const ceiling = geometry.padY + geometry.rowGap + 2 * Math.max(geometry.lineHeight, geometry.actionMinHeight) + 2;
  expect(
    geometry.liHeight,
    `row height ${geometry.liHeight}px exceeds the derived two-line ceiling ${ceiling}px — the row is reflowing into more than two lines`,
  ).toBeLessThanOrEqual(ceiling);

  // Line 2 shares a visual line: the combined meta/sub-line text and the
  // action's own box must sit at (roughly) the same y-centre.
  // `p:visible`, not a bare `p`: the desktop-only copy of this text
  // (`hidden md:block`) is still IN THE DOM at 320px (one DOM, branched —
  // never a second phone tree) and its exact "No scorer yet" is a
  // substring of the phone paragraph's combined "<court> · No scorer yet",
  // so an unscoped `hasText` match is a strict-mode violation on two nodes.
  const line2Text = row320.locator("p:visible", { hasText: UI_EN["runsheet.sub.noScorer"]! });
  await expect(line2Text, "no phone line-2 text at 320px — the merge did not render").toBeVisible();
  const line2Box = await line2Text.boundingBox();
  const actionBox = await action.boundingBox();
  expect(line2Box, "line-2 text has no box").not.toBeNull();
  expect(actionBox, "action has no box").not.toBeNull();
  const line2CenterY = line2Box!.y + line2Box!.height / 2;
  const actionCenterY = actionBox!.y + actionBox!.height / 2;
  console.log("Task 9 line-2 y-centres — text:", line2CenterY, "| action:", actionCenterY);
  expect(
    Math.abs(line2CenterY - actionCenterY),
    "the action and the line-2 sub-line text do not share a visual line",
  ).toBeLessThan(8);

  // ---- hit-test, not box measurement (AGENTS.md #2/#10, this file's own
  // "fix round 4" case above): `boundingBox()` reports paint, not hit area —
  // a control can measure 44px and still be untappable under an overlay. ----
  const hitTest = async (locator: Locator): Promise<string> => {
    // `elementFromPoint` is VIEWPORT-relative and returns null for anything
    // below the fold, which reads as "untappable" when it only means
    // "off-screen" — this file's own "fix round 4" case above hit exactly
    // this and scrolls first for the same reason.
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    if (box === null) return "(no box)";
    return locator.evaluate(
      (el, [x, y]) => {
        const hit = document.elementFromPoint(x as number, y as number);
        if (hit === null) return "(nothing)";
        return hit === el || el.contains(hit) ? "self" : hit.tagName.toLowerCase();
      },
      [box.x + box.width / 2, box.y + box.height / 2],
    );
  };
  const hits = {
    time: await hitTest(timeEl),
    name: await hitTest(nameLink),
    action: await hitTest(action),
  };
  console.log("Task 9 hit-test at 320px:", JSON.stringify(hits));
  for (const [control, result] of Object.entries(hits)) {
    expect(result, `${control}'s own centre must hit itself or a child, got "${result}"`).toBe("self");
  }

  // ---- no clipping, even with the 43-character name ----------------------
  await expectNoHorizontalScroll(page);
  await expectRunSheetNotClipped(page, "Task 9 two-line row at 320px, 43-char entrant name");
});

// W3 Task 10 — the stage rail folds into a bottom sheet on phones.
//
// Tasks 2-4 moved every stage-header action control onto `<StageRail>`;
// Task 5 gave it a desktop column (`stage-rail`, this file's own Task 5
// test above). Below `md` that column has nowhere to go — this task folds
// it behind a floating "Stage tools" trigger that opens a bottom sheet,
// cribbing `components/modal.tsx`'s bottom-sheet CSS pattern (brief) but
// moving its breakpoint from `sm:` to `md:` per ruling 15 (this file's own
// Task 8 test above already unified the run-sheet row on the same
// breakpoint).
//
// THE ONE THING THIS WAVE KEEPS GETTING WRONG (brief, verbatim): StageRail
// returns `null` for `!canEdit`, so anything keyed to it vanishes for a
// non-editing viewer unless built once and placed in exactly one spot. The
// trigger/sheet here are both INSIDE `<StageRail>`'s own early-return guard
// (stage-rail.tsx), so a non-editing viewer gets neither — same contract
// Tasks 3/4/5 already rely on, never re-derived.
//
// Two stages, deliberately (brief's own warning: "if the panel mounts one
// rail per stage, opening the first leaves the others' controls boxless").
// `open` is owned by `stages-panel.tsx`'s own `openRailFor` — a SHARED
// single value, same shape as the pre-existing `addingTo` (only one stage's
// inline "Add match" form opens at a time) — never a local `useState`
// inside `<StageRail>` (that was tried first and reverted: it reddened
// `stages-panel-auto-schedule-seq.test.tsx` / `-result-strip.test.tsx`,
// both of which walk `<StageRail>` through `expandWithHooks`, a
// deliberately read-only test-hook dispatcher — stage-rail.tsx's own header
// has the full account). A shared value is also the right UX here, not
// merely a workaround: a second open sheet would be a second
// `position:fixed` overlay stacked on the first. So this test proves the
// ACTUAL contract — opening stage 2's sheet closes stage 1's — rather than
// the independence an instance-local `useState` would have given; either
// way, a test that opens only stage 1 and asserts on stage 2 would see
// stage 2 "boxless" (brief's own phrase), so both are opened and checked.
test("Task 10: the stage rail folds into a bottom sheet at 320, one stage's sheet open at a time", async ({
  page,
  request,
}) => {
  const { divisionId, fixtureIds } = await seedRunSheetDivision(request);
  expect(fixtureIds.length, "seed produced no fixtures — setup failed, not the fold").toBeGreaterThanOrEqual(1);
  // A second, independent stage — no progression, no generated fixtures.
  // `stage.status !== "complete"` is StageRail's own gate for `stage-generate`
  // (stage-rail.tsx), and a freshly created stage is `pending`, so this is
  // enough to make a SECOND rail render real controls without needing a
  // second round of fixture generation.
  const second = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
    seq: 2,
    kind: "league",
    name: "Consolation",
    config: {},
  });
  expect(second.status, `second stage creation failed: ${JSON.stringify(second.error)}`).toBeLessThan(300);

  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
  await dismissCookieBanner(page);

  const rails = page.getByTestId("stage-rail");
  await expect(rails, "expected one stage-rail per stage — two stages were seeded").toHaveCount(2);
  const rail1 = rails.nth(0);
  const rail2 = rails.nth(1);

  // Match Day C3: a stage that has fixtures has no Generate (it leads with Complete, waiting); a fresh stage leads with Generate.
  // Each rail's own first control is what folds.
  const generate1 = rail1.getByTestId("stage-complete");
  const generate2 = rail2.getByTestId("stage-generate");
  const trigger1 = rail1.getByTestId("stage-rail-trigger");
  const trigger2 = rail2.getByTestId("stage-rail-trigger");

  // ---- before any tap: controls ATTACHED but not visible, trigger visible.
  // `toBeAttached`, not `toBeVisible`, on the folded controls (brief) —
  // visibility is exactly what the fold denies; the assertion has to prove
  // the control still EXISTS, hidden, not that it was never built.
  await expect(generate1, "stage 1's stage-complete never rendered at all — nothing to fold").toBeAttached();
  await expect(generate2, "stage 2's stage-generate never rendered at all — nothing to fold").toBeAttached();
  await expect(generate1, "stage 1's control is visible before any tap — the fold did not happen").not.toBeVisible();
  await expect(generate2, "stage 2's control is visible before any tap — the fold did not happen").not.toBeVisible();
  await expect(trigger1, "stage 1's Stage tools trigger is not visible at 320").toBeVisible();
  await expect(trigger2, "stage 2's Stage tools trigger is not visible at 320").toBeVisible();

  // ---- open stage 1's sheet: every one of ITS controls becomes visible,
  // and stage 2 stays folded (never opened yet — brief's own "boxless"
  // warning, witnessed directly rather than assumed).
  await trigger1.click();
  await expect(generate1, "stage 1's control did not become visible after tapping ITS OWN trigger").toBeVisible();
  await expect(
    generate2,
    "stage 2's control became visible when only stage 1's trigger was tapped — nothing opened it",
  ).not.toBeVisible();

  // ---- close it the way a PERSON has to. An open sheet mounts a
  // `fixed inset-0 z-30` backdrop that covers the whole viewport, the other
  // stage's trigger included, so "tap trigger 2 while sheet 1 is open" is an
  // interaction the UI does not permit: the tap lands on the backdrop. The
  // first version of this test drove it anyway and hung until the 60s budget
  // died (CI run 34142421718, `locator.click: Test timeout of 60000ms
  // exceeded`) — a real finding about the fold, surfacing as a timeout.
  // The backdrop's own onClick calls the same `onToggleOpen(stage.id)`, so
  // dismissing is the documented way out.
  const backdrop = page.getByTestId("stage-rail-backdrop");
  await expect(backdrop, "an open sheet rendered no backdrop — nothing can dismiss it").toBeVisible();
  await backdrop.click({ position: { x: 10, y: 10 } }); // review m6: the CENTRE can sit under the sheet
  await expect(generate1, "tapping the backdrop did not close stage 1's sheet").not.toBeVisible();
  await expect(backdrop, "the backdrop outlived the sheet it belongs to").toHaveCount(0);

  // ---- now stage 2 opens, and stage 1 stays shut.
  await trigger2.click();
  await expect(generate2, "stage 2's control did not become visible after tapping ITS OWN trigger").toBeVisible();
  await expect(
    generate1,
    "stage 1's control came back when stage 2's sheet opened — only one sheet may be open",
  ).not.toBeVisible();

  // ---- and back again, so this proves a toggle rather than "the second
  // stage always wins".
  await page.getByTestId("stage-rail-backdrop").click({ position: { x: 10, y: 10 } });
  await expect(generate2, "tapping the backdrop did not close stage 2's sheet").not.toBeVisible();
  await trigger1.click();
  await expect(generate1, "stage 1's control did not become visible after re-tapping its trigger").toBeVisible();
  await expect(generate2, "stage 2's control is still visible after stage 1's sheet re-opened").not.toBeVisible();

  // ---- control-set diff (brief step 6): stage 1's rail composition at 320
  // (open) must differ from 1280 — trigger present at 320 and absent at
  // 1280, the rail's own action controls the other way around. Same "bag of
  // visible tag:text" idiom Task 9 established for the run-sheet row, above.
  const railControlSet = (rail: Locator): Promise<string[]> =>
    rail.evaluate((root) => {
      const isVisible = (el: HTMLElement) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
      };
      return Array.from(root.querySelectorAll<HTMLElement>("a[href], button, p"))
        .filter(isVisible)
        .map((el) => `${el.tagName.toLowerCase()}:${(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim()}`)
        .filter((s) => !s.endsWith(":"))
        .sort();
    });
  const set320 = await railControlSet(rail1);

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
  await dismissCookieBanner(page);
  const rail1desktop = page.getByTestId("stage-rail").nth(0);
  await expect(rail1desktop.getByTestId("stage-complete"), "stage 1's control is not visible at 1280 with no tap").toBeVisible();
  const set1280 = await railControlSet(rail1desktop);
  console.log("Task 10 stage-rail control set at 320px (open):", JSON.stringify(set320));
  console.log("Task 10 stage-rail control set at 1280px:      ", JSON.stringify(set1280));
  expect(set320.length, "320px control set is empty — nothing was measured").toBeGreaterThan(0);
  expect(set1280.length, "1280px control set is empty — nothing was measured").toBeGreaterThan(0);
  expect(
    set320,
    "the 320px (open) and 1280px control sets must differ — see the printed sets above",
  ).not.toEqual(set1280);
  // And, the concrete fact that difference is made of: the trigger exists
  // only on phone, never at desktop.
  expect(set320.some((s) => s.includes(UI_EN["schedule.stageTools"]!)), "trigger text missing from the 320px set").toBe(true);
  expect(set1280.some((s) => s.includes(UI_EN["schedule.stageTools"]!)), "trigger text leaked into the 1280px set").toBe(false);

  await expectNoHorizontalScroll(page);
});

// W3 Task 10 — the other half of the same criterion: at `md` and up there is
// no trigger and no tap. `768` (`md`'s own value, ruling 15) and `1280` both
// gated here. Match Day E1 item 1 moved the actions group into the card
// header, so the geometry check here is "the rail is inside the header, above
// the rows", the same shape this file's own "desktop (E1)" test above
// measures at 1280.
test("Task 10: at md and up the Stage tools trigger is absent and the rail is visible with no tap", async ({
  page,
  request,
}) => {
  const { divisionId, fixtureIds } = await seedRunSheetDivision(request);
  expect(fixtureIds.length, "seed produced no fixtures — setup failed, not the layout").toBeGreaterThanOrEqual(1);

  for (const width of [768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
    await dismissCookieBanner(page);
    const sheet = page.getByTestId("stage-sheet").first();
    const rail = page.getByTestId("stage-rail").first();
    await expect(sheet, `stage-sheet did not render at ${width}px`).toBeVisible();
    await expect(rail, `stage-rail did not render at ${width}px`).toBeVisible();
    const trigger = rail.getByTestId("stage-rail-trigger");
    const generate = rail.getByTestId("stage-complete"); // C3: the seeded stage has fixtures, so its first control is Complete
    await expect(trigger, `Stage tools trigger is visible at ${width}px — should be md:hidden`).not.toBeVisible();
    await expect(generate, `stage-complete is not visible at ${width}px with no tap`).toBeVisible();

    // Match Day E1 item 1: the actions group is in the card HEADER at both widths - inside the header's box, above the rows.
    const header = sheet.locator("header").first();
    const rows = sheet.getByTestId("stage-run-sheet");
    const headerBox = await header.boundingBox();
    const railBox = await rail.boundingBox();
    const rowsBox = await rows.boundingBox();
    console.log(`E1 geometry at ${width}px - header:`, headerBox, "| stage-rail:", railBox, "| rows:", rowsBox);
    expect(headerBox, `the header has no box at ${width}px`).not.toBeNull();
    expect(railBox, `stage-rail has no box at ${width}px`).not.toBeNull();
    expect(rowsBox, `the rows have no box at ${width}px`).not.toBeNull();
    expect(railBox!.y, `at ${width}px the rail starts inside the header`).toBeGreaterThanOrEqual(headerBox!.y - 1);
    expect(railBox!.y + railBox!.height, `at ${width}px the rail ends inside the header`).toBeLessThanOrEqual(headerBox!.y + headerBox!.height + 1);
    expect(headerBox!.y + headerBox!.height, `at ${width}px the header sits above the rows`).toBeLessThanOrEqual(rowsBox!.y + 1);
  }
  await expectNoHorizontalScroll(page);
});

// W3 Task 10 — axe, scoped to the open sheet at 320: a new scrolling region
// owes a tabindex/role/name or axe reds SERIOUS on
// `scrollable-region-focusable` (AGENTS.md #23). They cannot be gated on a
// MEDIA QUERY; they are gated on the `open` prop (review m10), which is JS
// state — so open at 320 is exactly the state that has to be checked, and it
// is also the only state in which this box can overflow at all.
test("Task 10: axe — the open stage-tools sheet at 320 has no serious/critical violations", async ({
  page,
  request,
}) => {
  const { divisionId, fixtureIds } = await seedRunSheetDivision(request);
  expect(fixtureIds.length, "seed produced no fixtures — setup failed, not the sheet").toBeGreaterThanOrEqual(1);

  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
  await dismissCookieBanner(page);
  const trigger = page.getByTestId("stage-rail-trigger").first();
  await expect(trigger, "Stage tools trigger is not visible at 320px").toBeVisible();
  await trigger.click();
  const sheet = page.getByTestId("stage-rail-sheet").first();
  await expect(sheet, "the sheet did not open").toBeVisible();

  const axe = await new AxeBuilder({ page }).include('[data-testid="stage-rail-sheet"]').withTags(["wcag2a", "wcag2aa"]).analyze();
  const blocking = axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  console.log("Task 10 axe on the open stage-tools sheet:", axe.violations.length, "total,", blocking.length, "blocking");
  expect(
    blocking.map((v) => `${v.id} — ${v.nodes[0]?.html}`),
    "axe serious/critical on the open stage-tools sheet",
  ).toEqual([]);
});

// W3 Task 10, controller measurement round - D4, kept through Match Day E1 item 1 (the actions moved from a block under the rows to the
// card header): at 768/834 (device widths in the seven-width matrix) the rail's own buttons measured 28-30px tall - under the 44px tap
// floor - so every control the header and the card foot offer carries `min-h-11`, unconditionally. E1 adds the controls it brought: the
// settings buttons beside the divider and the Complete ⓘ.
//
// D2 (the rail's children sharing one LEFT edge) was a property of the old stacked block and retired with it: the header is a wrapping row
// now, so there is no column to align. D3 stays retracted (flex slack, not misalignment).
test("Task 10 controller round / E1: every control the card header and foot offer clears the 44px floor, at 1280 and 768", async ({
  page,
  request,
}) => {
  const { divisionId, fixtureIds } = await seedRunSheetDivision(request);
  expect(fixtureIds.length, "seed produced no fixtures - setup failed, not the layout").toBeGreaterThanOrEqual(1);

  let checked = 0;
  for (const width of [1280, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
    await dismissCookieBanner(page);

    const card = page.locator("section.card[data-stage-id]").first();
    // The seeded stage has fixtures but no result: Complete is there and WAITING (so its ⓘ is too), Delete and the settings buttons render.
    const controls: [string, Locator][] = [
      ["stage-complete", card.getByTestId("stage-complete")],
      ["stage-complete-info (the ⓘ)", card.getByTestId("stage-complete-info")],
      ["stage-delete", card.getByTestId("stage-delete")],
      ["stage-add-match", card.getByTestId("stage-add-match")],
      ["stage-tool-format", card.getByTestId("stage-tool-format")],
      ["court-tags trigger", card.getByTestId("stage-court-tags").getByRole("button").first()],
    ];
    for (const [name, control] of controls) {
      await expect(control, `${name} not visible at ${width}px`).toBeVisible();
      const box = await control.boundingBox();
      console.log(`D4 geometry at ${width}px - ${name}:`, box);
      expect(box, `${name} has no box at ${width}px`).not.toBeNull();
      expect(box!.height, `${name} is ${box!.height}px tall at ${width}px - under the 44px tap floor`).toBeGreaterThanOrEqual(44);
      checked++;
    }
  }
  expect(checked, "every control at both widths was measured").toBe(12);
  await expectNoHorizontalScroll(page);
});

// "Option B" (controller measurement, owner sign-off session) - the headline defect that killed "Option A": a two-column grid forced the
// CARD to whatever height the 280px RAIL column needed, measured `body=262px rail=262px content=99px VOID=163px` at 1280. The fix removed the
// grid; this measures the actual claim - "no column, no void" - directly: the card's own height against the height its stacked content
// actually occupies. Match Day E1 item 1 put the actions in the header, so the content now ends at the card's FOOT, the court-tags line.
test("Option B (E1): the card's content height closes the void (no more empty column) at 1280 and 768", async ({
  page,
  request,
}) => {
  const { divisionId, fixtureIds } = await seedRunSheetDivision(request);
  expect(fixtureIds.length, "seed produced no fixtures - setup failed, not the void check").toBeGreaterThanOrEqual(1);

  let checked = 0;
  for (const width of [1280, 768]) {
    await page.setViewportSize({ width, height: 1200 });
    await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
    await dismissCookieBanner(page);

    const sheet = page.getByTestId("stage-sheet").first();
    const foot = page.getByTestId("stage-court-tags").first();
    // The stage's own `<section className="card ...">` - no testid of its own, but `stage-sheet` is a direct child of it
    // (stages-panel.tsx), so its immediate parent IS the card.
    const card = sheet.locator("xpath=..");
    await expect(sheet, `stage-sheet not visible at ${width}px`).toBeVisible();
    await expect(foot, `the card foot not visible at ${width}px`).toBeVisible();
    await expect(card, `card wrapper not found at ${width}px`).toBeVisible();

    const cardBox = await card.boundingBox();
    const sheetBox = await sheet.boundingBox();
    const footBox = await foot.boundingBox();
    expect(cardBox, `card has no box at ${width}px`).not.toBeNull();
    expect(sheetBox, `stage-sheet has no box at ${width}px`).not.toBeNull();
    expect(footBox, `the card foot has no box at ${width}px`).not.toBeNull();

    const contentBottom = footBox!.y + footBox!.height;
    const contentHeight = contentBottom - cardBox!.y;
    const voidPx = cardBox!.height - contentHeight;
    console.log(
      `Option B void-check at ${width}px - card height=${cardBox!.height}px, content height=${contentHeight}px, void=${voidPx}px`,
      "| sheet:", sheetBox, "| foot:", footBox,
    );
    expect(voidPx, `card is ${voidPx}px taller than its own stacked content at ${width}px - the column's void is back`).toBeLessThan(20);
    checked++;
  }
  expect(checked).toBe(2);
  await expectNoHorizontalScroll(page);
});

// The progress counts line itself (kept from "Option A" — the owner did
// not object to the information, only to the two-column layout it could
// never fill on its own; see the "Option B" void-check test above for the
// layout half of the fix). Owner ruling (this round): the BAR that used to
// sit above this line is gone — it only earned its place while it could
// show mixed state, and a solid full-width block once every fixture was
// scheduled said nothing this text does not say better. This test's own
// subject survives that removal unchanged: it proves the counts line
// renders in a real browser (not just the node-environment unit suite,
// `stages-panel-progress.test.tsx`, which cannot see real layout) and that
// the stage body is still not the 814x234px empty cell the controller
// originally measured, now on the strength of the counts line alone.
test("Task 10 controller round: the stage card body carries the fixtures-progress counts, not an empty cell", async ({
  page,
  request,
}) => {
  const { divisionId, fixtureIds } = await seedRunSheetDivision(request);
  expect(fixtureIds.length, "seed produced no fixtures — setup failed, not the body").toBeGreaterThanOrEqual(1);
  // Play one fixture so the counts line has more than one clause to show —
  // a division fresh off generate is ALL unscheduled, which would pass a
  // vacuous "the body isn't 234px" check without proving the multi-clause
  // composition renders correctly.
  const target = fixtureIds[0]!;
  await setFixtureScheduledAtSql(target, "2026-09-10T10:00:00.000Z");
  await setFixtureStatusSql(target, "decided");

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
  await dismissCookieBanner(page);

  const sheet = page.getByTestId("stage-sheet").first();
  await expect(sheet, "stage-sheet did not render").toBeVisible();
  await expect(sheet.getByTestId("stage-progress-bar"), "the progress bar was removed this round — it must never come back").toHaveCount(0);
  const counts = sheet.getByTestId("stage-progress-counts");
  await expect(counts, "no progress counts line rendered in the stage body").toBeVisible();
  const countsText = await counts.textContent();
  console.log("Task 10 controller round — progress counts text:", countsText);
  expect(countsText, "progress counts line is empty").toBeTruthy();
  expect(countsText, "done clause missing").toContain(UI_EN["schedule.progress.done.one"]);
  expect(countsText, "to-schedule clause missing").toMatch(/to schedule/);

  // NOT a "taller than 234px" assertion. 234px was the height the RETIRED
  // 280px rail forced on this body while the body itself had nothing in it —
  // it is the defect's number, not a floor to clear. Option B made the card
  // content-sized, so a body that is now SHORTER than 234px is the fix
  // working, and asserting `> 234` made this test fail on a correct build
  // (CI run 34142421718: `stage-sheet height 129px`). The void itself is
  // measured properly by this file's own "Option B: the card's content height
  // closes the void" test, which compares card height against stacked content
  // height — that is where the layout claim belongs.
  //
  // What THIS test uniquely owns is the browser-only half: the counts line is
  // really PAINTED, not merely present in the markup. `stages-panel-progress
  // .test.tsx` runs in vitest's node environment and cannot tell those apart.
  const countsBox = await counts.boundingBox();
  console.log("Task 10 controller round — stage-progress-counts box:", countsBox);
  expect(countsBox, "progress counts line has no box — present in markup but not painted").not.toBeNull();
  expect(countsBox!.height, "progress counts line painted with zero height").toBeGreaterThan(0);
  expect(countsBox!.width, "progress counts line painted with zero width").toBeGreaterThan(0);
  const sheetBox = await sheet.boundingBox();
  expect(sheetBox, "stage-sheet has no box").not.toBeNull();
  expect(
    countsBox!.height,
    "the counts line is taller than the body that contains it — the body is not sized by its content",
  ).toBeLessThanOrEqual(sheetBox!.height);

  await expectNoHorizontalScroll(page);
});

// Competition desk W3, controller ruling C-1 — the sticky bracket round
// header overlap. PRE-EXISTING FROM W2: `run-sheet.tsx` has zero commits in
// `origin/main..HEAD` before this fix (verified twice, per the controller) —
// W3 did not cause this, but fixing it means W3 now touches a file it
// otherwise never would.
//
// Cause (controller diagnosis, verified against the source before fixing):
// the round header was `sticky top-14 z-10` inside a bracket `<section
// class="card overflow-hidden">`, itself inside `<div data-testid="run-
// sheet" class="card overflow-hidden">`. `overflow: hidden` makes an
// ancestor the CONTAINING BLOCK a sticky descendant sticks to, not the
// viewport — and neither ancestor here ever scrolls internally (the PAGE
// does), so the header sat at a fixed 56px offset from its own box,
// permanently, overlapping whatever row occupied that band — even at
// `scrollY = 0`, before any scrolling happened at all. Fix: both
// `overflow-hidden`s removed; the ONE thing they were doing beyond breaking
// sticky (clipping the first round header's own background so it does not
// square off past the section's rounded top corner) moves onto that one
// header directly (`rounded-t-2xl`, first round only).
//
// Ruling C-1 (verify by measurement, not by eye): TWO checks, not one — a
// fix that merely stops the overlap by deleting the sticky would also pass
// a naive "no overlap" scan, so this file's own second test scrolls the
// page and asserts the header is STILL on screen, pinned to its group.
test.describe("run sheet: sticky bracket round header no longer overlaps a row (controller ruling C-1)", () => {
  async function seedKnockout(request: import("@playwright/test").APIRequestContext) {
    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `RunSheet Sticky E2E ${TAG}`,
      visibility: "private",
    });
    const compId = comp.data!.id;
    const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${compId}/divisions`, "POST", {
      name: "Cup",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    });
    const divisionId = div.data!.id;
    // 8 entrants -> quarters(4) + semis(2) + final(1), three round headers
    // and enough rows to make the page genuinely scrollable — a 4-entrant
    // (one header) bracket would not exercise "scroll past the first
    // header" at all.
    await addEntrantsViaApi(request, divisionId, ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8"]);
    const { courts } = await seedVenueWithCourts(request, ["Sticky Court"]);
    const settings = await apiJson(request, `/api/v1/divisions/${divisionId}/schedule-settings`, "PUT", {
      config: {
        startAt: "2026-09-20T10:00:00.000Z",
        matchMinutes: 30,
        gapMinutes: 15,
        courts: [courts[0]!.id],
        perEntrantMinRest: 0,
        blackouts: [],
        sessionWindows: [],
      },
      tz: "UTC",
    });
    expect(settings.status, `schedule-settings PUT failed: ${JSON.stringify(settings.error)}`).toBeLessThan(300);
    const { fixtureIds } = await createStageAndGenerate(request, divisionId, { kind: "knockout", name: "Cup" });
    expect(fixtureIds.length, "an 8-entrant knockout is 4+2+1 = 7 fixtures").toBe(7);
    await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
    return { divisionId };
  }

  test("zero overlaps between any round header and any row, at 1280", async ({ page, request }) => {
    const { divisionId } = await seedKnockout(request);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
    await dismissCookieBanner(page);

    const sheet = page.getByTestId("run-sheet");
    await expect(sheet, "run-sheet did not render").toBeVisible();
    const headers = sheet.locator('[data-run-sheet-block="bracket"] header.sticky');
    const headerCount = await headers.count();
    expect(headerCount, "expected 3 round headers (quarters/semis/final)").toBe(3);
    const rows = sheet.locator('[data-run-sheet-block="bracket"] li[data-fixture-no]');
    const rowCount = await rows.count();
    expect(rowCount, "expected 7 rows (4+2+1)").toBe(7);

    const headerBoxes = await Promise.all(
      Array.from({ length: headerCount }, (_, i) => headers.nth(i).boundingBox()),
    );
    const rowBoxes = await Promise.all(Array.from({ length: rowCount }, (_, i) => rows.nth(i).boundingBox()));
    console.log("C-1 overlap scan — header boxes:", JSON.stringify(headerBoxes));
    console.log("C-1 overlap scan — row boxes:", JSON.stringify(rowBoxes));

    const overlaps: string[] = [];
    headerBoxes.forEach((h, hi) => {
      expect(h, `header ${hi} has no box`).not.toBeNull();
      rowBoxes.forEach((r, ri) => {
        expect(r, `row ${ri} has no box`).not.toBeNull();
        // Vertical overlap test: two boxes overlap unless one is entirely
        // above the other.
        const verticallyClear = h!.y + h!.height <= r!.y || r!.y + r!.height <= h!.y;
        if (!verticallyClear) overlaps.push(`header ${hi} overlaps row ${ri} (h=${JSON.stringify(h)}, r=${JSON.stringify(r)})`);
      });
    });
    expect(overlaps, `overlaps found:\n${overlaps.join("\n")}`).toEqual([]);

    await expectNoHorizontalScroll(page);
  });

  test("the round header still sticks to the viewport when the page is actually scrolled — not merely un-overlapping", async ({
    page,
    request,
  }) => {
    const { divisionId } = await seedKnockout(request);
    // A short viewport, deliberately: forces the page to be genuinely
    // scrollable regardless of how tall the stage cards above the run
    // sheet happen to render.
    await page.setViewportSize({ width: 1280, height: 700 });
    await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
    await dismissCookieBanner(page);

    const sheet = page.getByTestId("run-sheet");
    await expect(sheet, "run-sheet did not render").toBeVisible();
    const firstHeader = sheet.locator('[data-run-sheet-block="bracket"] header.sticky').first();
    await expect(firstHeader, "first round header did not render").toBeVisible();

    // Scroll the FIRST header out of its natural in-flow position — well
    // past where it would sit unscrolled — then confirm it is still ON
    // SCREEN, near the top of the viewport (pinned), rather than having
    // scrolled away with its round. `scrollIntoView` on the header itself
    // would trivially "fix" this by construction; scroll the LAST row of
    // the LAST round instead, forcing real page movement past the first
    // header's natural position.
    const lastRow = sheet.locator('[data-run-sheet-block="bracket"] li[data-fixture-no]').last();
    await lastRow.scrollIntoViewIfNeeded();

    const box = await firstHeader.boundingBox();
    console.log("C-1 sticky-on-scroll — first header box after scrolling to the last row:", JSON.stringify(box));
    expect(box, "first header has no box after scrolling — it scrolled away instead of sticking").not.toBeNull();
    // "Still on screen, pinned near its stick point" — top-14 (56px) from
    // the viewport top, generous tolerance for the app nav bar's own
    // height and sub-pixel layout, but nowhere close to having scrolled
    // off past the top of the viewport (a negative or wildly displaced y
    // would mean it did not stick).
    expect(box!.y, `header y=${box!.y} is not pinned near the top of the viewport — it did not stick`).toBeGreaterThanOrEqual(0);
    expect(box!.y, `header y=${box!.y} is too far down to be "stuck" — it looks like it never left its normal flow position`).toBeLessThan(
      120,
    );

    await expectNoHorizontalScroll(page);
  });
});

// Owner request (competition desk W3, on top of Option B) — "Required court
// tags" becomes a real button (>= 44px) that opens a modal
// (components/modal.tsx, reused), replacing the old 248x16px inline
// disclosure. Driven through a real browser — apps/web vitest has no DOM,
// so it cannot see the button's real tap height or that a genuine modal
// dialog opened; that half is unit-tested instead
// (stages-panel-court-tags-modal.test.tsx).
test("court-tags trigger opens a modal containing the editor body, and clears the 44px floor", async ({
  page,
  request,
}) => {
  const { divisionId, fixtureIds } = await seedRunSheetDivision(request);
  expect(fixtureIds.length, "seed produced no fixtures — setup failed, not the modal").toBeGreaterThanOrEqual(1);

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
  await dismissCookieBanner(page);

  const trigger = page.getByTestId("stage-court-tags-trigger").first();
  await expect(trigger, "court-tags trigger button did not render").toBeVisible();
  const triggerBox = await trigger.boundingBox();
  console.log("court-tags trigger box:", JSON.stringify(triggerBox));
  expect(triggerBox, "trigger has no box").not.toBeNull();
  expect(triggerBox!.height, `trigger is ${triggerBox!.height}px tall — under the 44px tap floor`).toBeGreaterThanOrEqual(44);

  await trigger.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog, "modal did not open").toBeVisible();
  // The editor body, exactly as it was inline before — round-role heading,
  // the "no rounds yet" copy for a stage with none configured (this seed's
  // default state), not a placeholder or a stripped-down summary.
  await expect(dialog).toContainText(UI_EN["stagetags.rounds.heading"]!);

  // Close via the modal's own "×" — the trigger's toggle semantics stay
  // available for programmatic callers (unit tests), but a real user closes
  // through the dialog itself.
  await page.getByRole("button", { name: "Close" }).click();
  await expect(dialog, "modal did not close").toBeHidden();

  await expectNoHorizontalScroll(page);
});

// ---------------------------------------------------------------------------
// Review finding M2 (rewritten for Match Day C3, again for PB1) - a stage's fixtures live IN its card, and the Today filter must not
// strand them.
//
// Before C3 the stage card offered a "View N fixtures" trip to a division-wide sheet below; M2 was that label promising N rows and
// the type filter delivering fewer. The trip is gone - the rows are in the card. PB1 (owner, 2026-11-02): the sheet now opens on
// "All" even on a match day, so every one of a stage's fixtures is in its card from the first paint; Today is a tap away and must
// narrow the rows to the day, and "All" must bring them all back, in THEIR stage's card. Invisible to the unit suite twice over:
// apps/web vitest is environment:"node" so the filter's onClick never runs, and the run-sheet unit tests drive <RunSheet> with an
// explicit `filter` prop, which is precisely the coupling this lives in.
// ---------------------------------------------------------------------------
test("Review M2 (C3, PB1): the stage card holds its rows - no 'View N fixtures' - the sheet opens on All on a match day, Today narrows it, All restores every fixture", async ({
  page,
  request,
}) => {
  const { divisionId, fixtureIds } = await seedRunSheetDivision(request);
  expect(fixtureIds.length, "seed produced no fixtures - setup failed, not the filter").toBeGreaterThanOrEqual(2);

  // The division must be STARTED, or `resolvePhase`'s rung 1
  // (`divisionStatus === "setup"` => setting_up, division-phase.ts) short-
  // circuits every later rung and the sheet opens on "All" - which is
  // exactly how the first run of this test failed, at its own guard below
  // rather than by passing vacuously.
  const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  expect(started.status, `division start failed: ${JSON.stringify(started.error)}`).toBeLessThan(300);

  // One fixture TODAY: that is what puts the division in the match_day phase,
  // which used to make the filter open on "today". Every other fixture is
  // pushed to a date that filter excludes, so a Today filter can only ever
  // show fewer than the stage holds - and the sheet opening on All is the
  // difference between N rows and 1 in the card on first paint.
  const today = new Date();
  today.setUTCHours(12, 0, 0, 0);
  await setFixtureScheduledAtSql(fixtureIds[0]!, today.toISOString());
  const future = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);
  for (const id of fixtureIds.slice(1)) await setFixtureScheduledAtSql(id, future.toISOString());

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
  await dismissCookieBanner(page);

  // The premise, stated: this division IS in the match-day phase (the Today chip is there), and the sheet still opened on All.
  const todayChip = page.getByTestId("run-sheet-filter").locator('[data-filter="today"]');
  const allChip = page.getByTestId("run-sheet-filter").locator('[data-filter="all"]');
  await expect(todayChip, "no Today chip - this division is not in the match-day phase").toBeVisible();
  await expect(allChip, "the run sheet did not open on All on a match day").toHaveAttribute("aria-pressed", "true");
  await expect(todayChip, "the run sheet opened on Today").toHaveAttribute("aria-pressed", "false");

  // The retired trip is gone, and its words with it.
  // Final review G6: `stage-view-fixtures` is rendered by no source now, so a count-0 check on it could never fail. What replaced the
  // trip is asserted instead: the stage's rows are IN its card, the one place they are (the count checks further down say how many).
  await expect(
    page.locator("section.card[data-stage-id]").getByTestId("stage-run-sheet"),
    "the rows are in the stage's card, where the 'View N fixtures' trip used to lead",
  ).toBeVisible();
  await expect(page.getByText(/View \d+ fixtures?/)).toHaveCount(0);

  // On first paint (All) every fixture the stage holds is in its card.
  const inCards = page.locator('[data-testid="stage-run-sheet"] li[data-fixture-no]');
  await expect
    .poll(async () => inCards.count(), { message: "the sheet did not open with every fixture in the stage's card" })
    .toBe(fixtureIds.length);

  // Today keeps exactly the one fixture that is today, and it sits in its stage's card.
  await todayChip.click();
  await expect.poll(async () => inCards.count(), { message: "Today did not keep the one fixture that is today" }).toBe(1);

  // 'All': every fixture the stage holds, in the card - not on a sheet elsewhere.
  await allChip.click();
  await expect
    .poll(async () => inCards.count(), { message: "'All' did not bring every fixture into its stage's card" })
    .toBe(fixtureIds.length);
  // Every row on the page is one of the cards' rows: there is no second, division-wide copy.
  await expect(page.locator('[data-testid="run-sheet"] li[data-fixture-no]')).toHaveCount(fixtureIds.length);
  await expect(
    page.getByTestId("run-sheet-empty"),
    "the 'no fixtures match' state outlived the filter that caused it",
  ).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Review finding M4 — the phone Stage-tools sheet behaves modally (a
// full-viewport backdrop eats every tap behind it) but declared none of a
// modal's contract. No unit test can see any of this: apps/web vitest is
// environment:"node", so focus() is vacuous there (a class-scan test stays
// green while the real behaviour is absent), and the existing axe scan is
// scoped with .include('[data-testid="stage-rail-sheet"]'), which excludes the
// backdrop and focus behaviour entirely.
// ---------------------------------------------------------------------------
test("Review M4: the phone Stage tools sheet closes on Escape and gives focus back to its trigger", async ({
  page,
  request,
}) => {
  const { divisionId, fixtureIds } = await seedRunSheetDivision(request);
  expect(fixtureIds.length, "seed produced no fixtures — setup failed, not the sheet").toBeGreaterThanOrEqual(1);

  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
  await dismissCookieBanner(page);

  const trigger = page.getByTestId("stage-rail-trigger").first();
  const sheet = page.getByTestId("stage-rail-sheet").first();
  const generate = page.getByTestId("stage-complete").first(); // C3: the seeded stage has fixtures, so its control is Complete
  await expect(trigger, "no Stage tools trigger at 320").toBeVisible();

  await trigger.click();
  await expect(generate, "the sheet did not open").toBeVisible();

  // Open, it is a dialog and it says so — a screen reader is told the rest of
  // the page is inert, which is what the backdrop already enforces visually.
  await expect(sheet, "the open sheet is not exposed as a dialog").toHaveAttribute("role", "dialog");
  await expect(sheet, "the open sheet does not claim modality").toHaveAttribute("aria-modal", "true");

  // Focus moved INTO the sheet on open. Without this the organiser is left on
  // a trigger buried under the scrim, and Tab walks the page behind it.
  await expect
    .poll(
      async () => sheet.evaluate((el) => el.contains(document.activeElement)),
      { message: "focus stayed outside the sheet when it opened" },
    )
    .toBe(true);

  await page.keyboard.press("Escape");
  await expect(generate, "Escape did not close the sheet").not.toBeVisible();
  await expect(
    page.getByTestId("stage-rail-backdrop"),
    "the backdrop outlived the sheet Escape closed",
  ).toHaveCount(0);

  // ...and focus came back to where it started, not to <body>.
  await expect
    .poll(
      async () => trigger.evaluate((el) => el === document.activeElement),
      { message: "focus was not restored to the Stage tools trigger after Escape" },
    )
    .toBe(true);

  // Closed, it sheds all of it (review m10): no dialog role, no landmark name
  // and NO tab stop — the box only scrolls while it is open, so a closed one
  // is dead weight in the tab order and a duplicate entry in the landmark
  // list, once per stage. The positive half of this pair is above: open, all
  // three are present.
  await expect(sheet, "the closed sheet still claims a role").not.toHaveAttribute("role", /.*/);
  await expect(sheet, "the closed sheet is still a tab stop").not.toHaveAttribute("tabindex", /.*/);
  await expect(sheet, "the closed sheet is still a named landmark").not.toHaveAttribute("aria-label", /.*/);
});

// ---------------------------------------------------------------------------
// Review finding m1 — the NOW rule at the very bottom of the sheet.
//
// C-1 removed the card's `overflow-hidden` (sticky headers need the PAGE as
// their containing block) on the argument that nothing square-cornered can
// ever sit at the card's bottom edge. `NowRule` is the exception:
// `bg-lime-50`, square corners, and `filteredNowIndex` places it LAST in the
// `<ul>` once no fixture in the day is still ahead.
//
// No unit test can see this — apps/web vitest is environment:"node", and a
// class-scan would pass on a class that never wins the cascade — so the
// assertion below is on COMPUTED style, from a browser, in the state that
// produces it: every fixture of the division timed EARLIER TODAY, which
// leaves one day block, no unscheduled pile, no settled-untimed pile, and
// therefore a day block that is the last thing in the card.
// ---------------------------------------------------------------------------
test("Review m1 (C3): the NOW rule that ends a stage's sheet stays square while the stage's court-tags foot sits under it, and the card keeps its own corners", async ({ page, request }) => {
  // Same zone trick the day-grouping case uses: real "now" is local midday
  // there, so "an hour ago" is unambiguously the SAME local day and this
  // case behaves identically at every hour of the real clock.
  const tz = middayZoneFor(Date.now());
  const { divisionId, fixtureIds } = await seedRunSheetDivision(request, { tz });
  expect(fixtureIds.length, "seed produced no fixtures — setup failed, not the corners").toBeGreaterThanOrEqual(2);

  // EVERY fixture in the past, today. Nothing ahead ⇒ the NOW rule renders
  // after the last row rather than between two of them; nothing untimed ⇒
  // no unscheduled block follows the day block.
  const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  for (const id of fixtureIds) await setFixtureScheduledAtSql(id, past);

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
  await dismissCookieBanner(page);

  // Match Day C3: the sheet is one stage's rows INSIDE that stage's card. E1 item 1 moved the stage rail up into the card's header, so
  // what follows the sheet now is the card's foot, the stage's court-tags line (an editor's control, a viewer's read-only value). A NOW
  // rule that ends the sheet is therefore mid-card, and (as with a NOW rule that ends a day block with later days to come) it must
  // stay SQUARE: a rounded lime bar in the middle of a card is the defect. Nothing in a stage card ends on the sheet (`endsCard` is
  // false for the panel's embedded sheets, review m3); the prop's `true` half is the division-wide sheet's, pinned by the unit suite.
  const stageSheet = page.getByTestId("run-sheet").getByTestId("stage-run-sheet");
  const now = stageSheet.getByTestId("run-sheet-now");
  await expect(now, "no NOW rule rendered — nothing was measured").toHaveCount(1);

  // The state this test exists for, asserted rather than assumed: the rule really is the last element in the stage's sheet, and the
  // card's court-tags foot really does follow it inside the same card. Without both, the radius check below passes on a state that was never set up.
  const placed = await now.evaluate((el) => {
    const sheet = el.closest('[data-testid="stage-run-sheet"]');
    const all = sheet ? Array.from(sheet.querySelectorAll("li, section")) : [];
    const card = el.closest("section[data-stage-id]");
    const foot = card?.querySelector('[data-testid="stage-court-tags"]') ?? null;
    return {
      isLast: all.length > 0 && all[all.length - 1] === el,
      footFollows: foot !== null && (el.compareDocumentPosition(foot) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    };
  });
  expect(placed.isLast, "the NOW rule is not the last element in the sheet — this case did not set up").toBe(true);
  expect(placed.footFollows, "the card's court-tags foot does not follow the sheet inside its card — this case did not set up").toBe(true);

  const radii = await now.evaluate((el) => {
    const card = el.closest("section[data-stage-id]") as HTMLElement;
    return {
      ruleLeft: getComputedStyle(el).borderBottomLeftRadius,
      ruleRight: getComputedStyle(el).borderBottomRightRadius,
      cardLeft: getComputedStyle(card).borderBottomLeftRadius,
    };
  });
  console.log("m1 NOW-rule corner radii:", JSON.stringify(radii));
  // The card has corners to protect (read live, never a literal) - and the rule, mid-card, takes none of them.
  expect(parseFloat(radii.cardLeft), "the stage card has no rounded corners - the differential below proves nothing").toBeGreaterThan(0);
  expect(parseFloat(radii.ruleLeft), "a mid-card NOW rule must not be rounded at the bottom-left").toBe(0);
  expect(parseFloat(radii.ruleRight), "a mid-card NOW rule must not be rounded at the bottom-right").toBe(0);

  // The DIFFERENTIAL half (review m6; restored from the base test): a row in the middle of the same list stays SQUARE too. Without
  // it the zero radii above would also pass on "nothing is ever rounded" (the `.rounded-b-2xl` rule deleted outright, or never
  // applied), which says nothing about the scoped rule this case exists for. (Rounding is scoped to the last block of a sheet that
  // ENDS its card - the unit suite pins that half, `run-sheet-spacing.test.tsx`.)
  const midRadius = await stageSheet.locator("li[data-fixture-no]").first().evaluate((el) => getComputedStyle(el).borderBottomLeftRadius);
  console.log("m1 mid-list row radius:", midRadius);
  expect(parseFloat(midRadius), "a mid-list row must stay square - the rounding is scoped to the last block of a sheet that ends the card").toBe(0);
  expect(await stageSheet.locator("li[data-fixture-no]").count(), "anti-vacuity: the sheet has fixture rows beside the rule").toBeGreaterThanOrEqual(2);
});

// Competition desk W4, review finding m2 — the bracket round header's sticky
// offset must follow the day header's ACTUAL height.
//
// The offset shipped as `top-[86px]`: 56 (nav) plus a day header height
// assumed to be 30px at one line. `DayHeading` prints
// "<long weekday date> · <venue> · N fixtures", which at 320 with a real
// venue name wraps to two lines — and the bracket header then overlaps the
// header it exists to stack under, by the difference. The finding was
// recorded as unreproduced for a specific reason: it needs a division holding
// BOTH a day block and a bracket block with a placed venue, driven at 320,
// and the two live sticky cases above (C-1, C-3) both seed a bracket-ONLY
// division. So that state had never been rendered at any width.
//
// This is the only test that can see the fix. `apps/web` vitest is
// `environment: "node"` — the unit suite pins the static half (the sheet
// publishes `--desk-day-h`, the header derives its offset from it) and cannot
// run the `ResizeObserver` that supplies the real number.
test("a round bar (table stage) and a bracket round bar (knockout), each in its own stage card, each pin right under the nav, at 320 (finding m2, C3, E1)", async ({
  page,
  request,
}) => {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `RunSheet StickyMix ${TAG}`,
    visibility: "private",
  });
  const compId = comp.data!.id;
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${compId}/divisions`, "POST", {
    name: "Mixed",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  const divisionId = div.data!.id;
  await addEntrantsViaApi(request, divisionId, ["M1", "M2", "M3", "M4"]);

  // A venue name long enough to WRAP the day header at 320. The wrap is the
  // whole premise, so it is asserted below rather than assumed — a name that
  // happened to fit would make every assertion here vacuous.
  const { venueId, courts } = await seedVenueWithCourts(request, ["Show Court"], {
    venueName: `Northbridge Memorial Athletic Ground ${TAG}`,
  });
  const settings = await apiJson(request, `/api/v1/divisions/${divisionId}/schedule-settings`, "PUT", {
    config: {},
    tz: "UTC",
  });
  expect(settings.status, `schedule-settings PUT failed: ${JSON.stringify(settings.error)}`).toBeLessThan(300);

  // A league stage carries the DAY block, a knockout stage the BRACKET block.
  const league = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
    seq: 1,
    kind: "league",
    name: "Group",
  });
  expect(league.status, `league stage POST failed: ${JSON.stringify(league.error)}`).toBeLessThan(300);
  const entrants = await apiJson<{ id: string }[]>(request, `/api/v1/divisions/${divisionId}/entrants`);
  const [e1, e2] = entrants.data!;
  // A FUTURE day, not today: `stages-panel.tsx` opens the sheet on the
  // "today" filter once the division's phase is match_day, which would filter
  // the (unscheduled) bracket rows away and leave nothing to stack.
  const dayAt = new Date(Date.now() + 6 * 24 * 3600_000);
  dayAt.setUTCHours(10, 0, 0, 0);
  const placed = await apiJson(request, `/api/v1/stages/${league.data!.id}/fixtures`, "POST", {
    home_entrant_id: e1!.id,
    away_entrant_id: e2!.id,
    scheduled_at: dayAt.toISOString(),
    venue_id: venueId,
    court_id: courts[0]!.id,
  });
  expect(placed.status, `ad-hoc fixture POST failed: ${JSON.stringify(placed.error)}`).toBeLessThan(300);

  const cup = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
    seq: 2,
    kind: "knockout",
    name: "Cup",
  });
  expect(cup.status, `knockout stage POST failed: ${JSON.stringify(cup.error)}`).toBeLessThan(300);
  const gen = await apiJson<{ fixtures: { id: string }[] }>(
    request,
    `/api/v1/stages/${cup.data!.id}/generate`,
    "POST",
  );
  expect((gen.data?.fixtures ?? []).length, "knockout generated no fixtures").toBeGreaterThan(0);

  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
  await dismissCookieBanner(page);

  const sheet = page.getByTestId("run-sheet");
  await expect(sheet, "run-sheet did not render").toBeVisible();
  // Match Day E1 item 1: a table stage's rows sit under a ROUND bar (the day heading is gone from a stage card), and a knockout's under its
  // named-round bar - the same sticky `header` in both. Each is in its own stage's sheet; each pins right under the nav; neither sheet has a
  // day heading, so neither publishes an offset for one.
  const roundBar = sheet.locator('[data-run-sheet-round] header.sticky').first();
  const bracketHeader = sheet.locator('[data-run-sheet-block="bracket"] header.sticky').first();
  await expect(roundBar, "no round bar - the mixed state this test needs never rendered").toBeVisible();
  await expect(bracketHeader, "no bracket block - the mixed state this test needs never rendered").toBeVisible();
  await expect(sheet.locator("[data-run-sheet-day]"), "no day heading survives in a stage card").toHaveCount(0);

  const measured = await page.evaluate(() => {
    const round = document.querySelector<HTMLElement>("[data-run-sheet-round] header")!;
    const bracket = document.querySelector<HTMLElement>('[data-run-sheet-block="bracket"] header')!;
    const sheetOf = (el: HTMLElement) => el.closest<HTMLElement>('[data-testid="stage-run-sheet"]')!;
    const published = (el: HTMLElement) =>
      getComputedStyle(sheetOf(el).querySelector<HTMLElement>(".space-y-6")!).getPropertyValue("--desk-day-h");
    return {
      roundText: round.textContent ?? "",
      roundTop: getComputedStyle(round).top,
      bracketTop: getComputedStyle(bracket).top,
      roundStage: sheetOf(round).getAttribute("data-stage-id"),
      bracketStage: sheetOf(bracket).getAttribute("data-stage-id"),
      roundPublished: published(round),
      bracketPublished: published(bracket),
      roundSticky: getComputedStyle(round).position,
      bracketSticky: getComputedStyle(bracket).position,
    };
  });
  console.log("m2 sticky offsets at 320:", JSON.stringify(measured));

  // The state: the two bars really are in two different stage sheets, the League's and the Cup's, and both are sticky.
  expect(measured.roundStage, "the round bar is in the League's sheet").toBe(league.data!.id);
  expect(measured.bracketStage, "the bracket bar is in the Cup's sheet").toBe(cup.data!.id);
  expect(measured.roundSticky).toBe("sticky");
  expect(measured.bracketSticky).toBe("sticky");
  expect(Number.parseFloat(measured.roundTop), "the League's round bar pins right under the nav").toBeCloseTo(56, 0);
  expect(Number.parseFloat(measured.bracketTop), "the Cup's bracket bar pins right under the nav").toBeCloseTo(56, 0);
  // No day heading above either: both sheets publish a zero offset.
  expect(Number.parseFloat(measured.roundPublished), "the League's sheet publishes no day-heading height").toBe(0);
  expect(Number.parseFloat(measured.bracketPublished), "the Cup's sheet publishes no day-heading height").toBe(0);
  // The bar's words wrap, they never push the page sideways.
  await expectNoHorizontalScroll(page);
});

// ---------------------------------------------------------------------------
// The DRAW LIST and the BRACKET TREE name the SAME feeder for the SAME match
// — at 1280 (2026-09-21).
//
// The owner's report, off the live product: a division page's `?tab=fixtures`
// showed a knockout whose seeded semis read "Rank 1 vs Rank 4" but whose
// final read "TBD vs TBD — Awaiting draw", while the SCHEDULE showed that
// same fixture as "Winner of R1·1 vs Winner of R1·2". A defect in the gap
// between two individually-correct screens.
//
// `mobile.spec.ts` covers this at 320/360/375/390/430/768/834. Nothing
// covered it at 1280 — which is not a missing PROJECT (`parallel`, `serial`
// and `walkthrough` all run `devices["Desktop Chrome"]`, viewport 1280x720,
// so the width was already in CI) but a missing TEST. This is the organiser's
// own width, and the width the two panels sit side by side at.
//
// The shape that reproduces it is a SETUP-timed progression bracket, and only
// that: the plain `generateStageFixtures` stamps `slot.winner_match` into
// `*_slot_label`, so a plain knockout was never affected.
// `generateProgressionSetupFixtures` leaves a sibling-fed seat's stored label
// NULL on purpose (`stageOwesDraw`/`awaitsSeedDraw` read "no label ⇒
// sibling-fed"), so the FEED EDGES are the only thing that knows. A league of
// 4 feeding a 4-qualifier knockout is the smallest bracket with such a seat.
//
// This is the case the width sweep cannot be: it ties the two panels to ONE
// match by its `fixture_no` — `data-fixture-no` on the list row, `/f/<no>` on
// the tree node's href — rather than asserting each surface separately and
// hoping they meant the same fixture. Asserting them separately is exactly
// what let them drift apart in the first place.
// ---------------------------------------------------------------------------

/** The shipped sentence for a winner-fed seat, composed the way
 *  `resolveSlotLabel` composes it (`{ext}` via `slot.match_ref`), so a
 *  dictionary edit moves this test instead of freezing today's copy.
 *  `UI_EN` is this file's existing one-authority idiom. */
const feederEn = (round: number, seq: number): string =>
  UI_EN["slot.winner_match"]!.replace(
    "{ext}",
    UI_EN["slot.match_ref"]!.replace("{round}", String(round)).replace("{seq}", String(seq)),
  );

/** The shipped sentence for a seat still held by a SEED, from the same
 *  authority — a retyped "Rank 1" would be this file's one un-sourced string. */
const seedSeatEn = (rank: number): string => UI_EN["slot.rank_range"]!.replace("{rank}", String(rank));

test("at 1280 the tree and the draw list under it name the same feeder for the same match", async ({
  page,
  request,
}) => {
  // Pin the width this test exists for. `devices["Desktop Chrome"]` is 1280
  // wide today; if a config change moves it, this says so rather than
  // quietly proving a different width (and the mobile projects never match
  // this file, so there is no second viewport to accommodate).
  expect(page.viewportSize()?.width, "this case is the 1280 one").toBe(1280);

  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `DrawFeed E2E ${TAG}`,
    visibility: "private",
  });
  expect(comp.status, `competition POST failed: ${JSON.stringify(comp.error)}`).toBeLessThan(300);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  expect(div.status, `division POST failed: ${JSON.stringify(div.error)}`).toBeLessThan(300);
  const divisionId = div.data!.id;
  await addEntrantsViaApi(request, divisionId, ["Seed A", "Seed B", "Seed C", "Seed D"]);

  const stages = await apiJson<{ id: string; kind: string }[]>(
    request,
    `/api/v1/divisions/${divisionId}/stages`,
    "POST",
    [
      { seq: 1, kind: "league", name: "League", config: { legs: 1 } },
      {
        seq: 2,
        kind: "knockout",
        name: "Cup",
        config: {},
        progression: {
          sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
          placement: "rank_order",
          timing: "setup",
        },
      },
    ],
  );
  expect(stages.status, `stages POST failed: ${JSON.stringify(stages.error)}`).toBeLessThan(300);
  const koId = stages.data!.find((s) => s.kind === "knockout")!.id;

  const gen = await apiJson<{
    created: number;
    fixtures: { round_no: number; fixture_no: number; home_entrant_id: string | null }[];
  }>(request, `/api/v1/stages/${koId}/generate`, "POST");
  expect(gen.status, `generate POST failed: ${JSON.stringify(gen.error)}`).toBeLessThan(300);
  // Two semis + a final, every seat empty: the bracket is drawn but unplayed.
  // Without this the assertions below could pass against a bracket that never
  // had a sibling-fed seat in it.
  expect(gen.data!.created).toBe(3);
  const finals = gen.data!.fixtures.filter((f) => f.round_no === 2);
  expect(finals.length, "no round-2 fixture — nothing here is sibling-fed").toBe(1);
  expect(gen.data!.fixtures.every((f) => f.home_entrant_id === null)).toBe(true);
  const finalNo = finals[0]!.fixture_no;
  expect(typeof finalNo, "the generate payload carried no fixture_no to tie the panels by").toBe("number");

  await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));

  const sheet = page.getByTestId("run-sheet");
  await expect(sheet, "the draw list never rendered").toBeVisible({ timeout: 20_000 });
  // Match Day E1 item 3: the tree opens inside the Cup's card from its Bracket button (closed by default).
  const tree = await openBracket(page, koId);
  await expect(tree, "the bracket tree never rendered").toBeVisible({ timeout: 20_000 });

  const R1_1 = feederEn(1, 1);
  const R1_2 = feederEn(1, 2);
  // The two derivations must differ, or "both panels contain both" is
  // satisfied by one string appearing twice.
  expect(R1_2, "the two feeder sentences are identical").not.toBe(R1_1);

  // THE SAME MATCH, by its per-division ordinal: `data-fixture-no` on the
  // list row, `/f/<no>` on the tree node's href.
  const listRow = sheet.locator(`[data-fixture-no="${finalNo}"]`);
  const treeNode = tree.locator(`a[href$="/f/${finalNo}"]`);
  await expect(listRow, `no draw-list row for fixture ${finalNo}`).toHaveCount(1);
  await expect(treeNode, `no tree node for fixture ${finalNo}`).toHaveCount(1);

  // THE CLAIM. Both seats of that one match, named by their feeder, on BOTH
  // panels. Removing `seatLabel`'s feed branch puts all four back to TBD.
  await expect(listRow).toContainText(R1_1);
  await expect(listRow).toContainText(R1_2);
  await expect(treeNode).toContainText(R1_1);
  await expect(treeNode).toContainText(R1_2);

  // The POSITIVE pair for the negative below: the seeded semis DID render
  // their own stored labels, so an absent "Winner of" above would be a real
  // absence rather than a blank tab.
  await expect(sheet.getByText(seedSeatEn(1), { exact: false }).first()).toBeVisible();
  await expect(tree.getByText(seedSeatEn(1), { exact: false }).first()).toBeVisible();
  // …and no seat anywhere on this tab still says TBD, on a bracket where
  // every seat has a known feeder or a known seed.
  await expect(sheet.getByText(/^TBD$/)).toHaveCount(0);
  await expect(tree.getByText(/^TBD$/)).toHaveCount(0);
  // A resolved lookup, not a leaked key.
  await expect(sheet).not.toContainText("slot.winner_match");
  await expect(tree).not.toContainText("slot.winner_match");
  await expectNoHorizontalScroll(page);
});
