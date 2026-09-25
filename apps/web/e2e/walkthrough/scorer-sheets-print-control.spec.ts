// Scorer sheets §4.4 (Task 9) — the organiser's print control on the
// competition schedule page, option A (owner ruling Q5): a day select and a
// "Print scorer sheets" button right of the page title, stacking under it on
// phones.
//
// ── WHAT IS A REACH AND WHAT IS THE TEST (this folder's README rule) ───────
// REACH, over the API: a league division whose fixtures sit on three days —
// the last round's two matches moved to the ORG's today and two days on, the
// rest on the seed's 2026-09-15 — so the right default (today) is NOT the
// first option.
// THE TEST, in the browser: the picker opens at the org's today and offers
// exactly the org-clock days the fixtures sit on; Print sends the PICKED day;
// the file lands as a browser download under the server's filename; a 422
// "nothing on that day" renders the LOCALISED line (en, fr), never the
// server's English; a Community org without an Event Pass gets the
// device-links upgrade pill, saying what it sells in the page's language,
// instead of the button. Every state is checked at 320/768/1280: no
// horizontal page scroll, both controls hit-tested at their centre and at
// least 44px, the same controls in the same order at 320 and 1280, BESIDE the
// title from 768 up (the phone composition is below 768 only) and under it at
// 320. A refusal hands the button back and moves neither the title nor the
// control (page-relative boxes, idle vs refused, at 768 and 1280).
//
// ── THE ROUTE IS STUBBED IN THE FIRST TEST, DELIBERATELY ────────────────────
// `POST /api/v1/competitions/{id}/exports/scorer-sheets` is Task 8's, built in
// parallel with this task. The first test answers it with `page.route` in
// exactly Task 8's contract (200 application/pdf + `attachment; filename=
// "scorer-sheets-<day>.pdf"`; a refusal in the v1 envelope with code
// NO_FIXTURES_ON_DAY), so what it proves is the BROWSER half: the request the
// control sends, the download it produces, the copy a refusal shows, at every
// width. Since the fold the real route is on this branch too, so the second
// test drives the SAME control against it, unstubbed: the file saved is Task
// 8's real PDF (one QR per match on the day, the scoring link never printed as
// text, the same QR on a reprint), and the refusal is the route's own 422.
// Scanning a QR taken from those bytes is Task 10's golden journey
// (scorer-sheets-print-scan.spec.ts), which prints through this control.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect, type Locator, type Page, type Route, type TestInfo } from "@playwright/test";
import {
  activeOrgIdFromRequest,
  apiJson,
  competitionPath,
  expectNoHorizontalScroll,
  orgTimezoneSql,
  seedScoredDivision,
  TAG,
} from "../helpers";
import { dismissConsent, freshOrg, waitForHydration } from "../directory-kit";
import { pdfLinkUris, pdfTextRuns } from "../pdf-uris";

const dict = (locale: "en" | "fr" | "es") =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../src/dictionaries/${locale}/ui.json`, import.meta.url)), "utf8"),
  ) as Record<string, string>;
const EN = dict("en");
const FR = dict("fr");
const ES = dict("es");

const WIDTHS = [320, 768, 1280] as const;
/** The pill's width cap holds until xl; 1024 is where releasing it early
 *  left the Spanish title (the longest reason) under 40% of the header. */
const PILL_WIDTHS = [320, 768, 1024, 1280] as const;
/** A page load, a seed, or a poll of the server's own record. */
const STEP_MS = 20_000;
/** A click or a local assertion: a fraction of a page load. */
const REACH_MS = 5_000;
/** Each budget is DERIVED from the journey its test performs (AGENTS.md 20). */
const budgetFor = (navs: number, acts: number, captures: number): number =>
  Math.max(60_000, navs * STEP_MS + (acts + captures * WIDTHS.length) * REACH_MS);

const DAY_MS = 86_400_000;
/** `YYYY-MM-DD` of an instant on `tz`'s wall clock — lib/scorer-sheets.ts's
 *  `localDateOf`, restated so the spec does not import app code. */
const localDate = (at: Date, tz: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);

async function setLocale(page: Page, locale: "en" | "fr" | "es") {
  await page.context().addCookies([
    { name: "seazn_locale", value: locale, url: new URL(test.info().project.use.baseURL!).origin },
  ]);
}

/** The schedule page's header: the title and whatever sits beside it. */
const header = (page: Page) => page.locator("main h1.page-title").locator("xpath=..");

/** Paint is not reach (AGENTS.md 2): a tap at the control's centre must land
 *  on the control, and the control must be a 44px target. */
async function hitTest(control: Locator, label: string) {
  await control.scrollIntoViewIfNeeded();
  const box = await control.boundingBox();
  expect(box, `${label}: no box`).not.toBeNull();
  const hit = await control.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!at && (at === el || el.contains(at));
  });
  expect(hit, `${label}: elementFromPoint at centre is not the control`).toBe(true);
  expect(box!.height, `${label}: height under 44`).toBeGreaterThanOrEqual(44);
}

/** The controls in `scope` (itself included), by tag and first line of text,
 *  in DOM order — the membership-and-order diff (AGENTS phone composition),
 *  not box sizes. */
const controlSet = (scope: Locator) =>
  scope.evaluate((root) =>
    [root, ...Array.from(root.querySelectorAll("*"))]
      .filter((el) => el.matches("select, button, a"))
      .map((el) => `${el.tagName.toLowerCase()}:${(el as HTMLElement).innerText.split("\n")[0]!.trim()}`),
  );

/** A box in PAGE coordinates, so two reads either side of a state change
 *  compare even if the window scrolled between them. */
const pageBox = (el: Locator) =>
  el.evaluate((node) => {
    const r = node.getBoundingClientRect();
    return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
  });

/** The title's and the control's page boxes at each width the control sits
 *  beside the title — read idle, then again once a refusal has landed. */
async function rowBoxes(page: Page, control: Locator) {
  const out: Record<number, { title: Awaited<ReturnType<typeof pageBox>>; control: Awaited<ReturnType<typeof pageBox>> }> =
    {};
  for (const w of [768, 1280]) {
    await page.setViewportSize({ width: w, height: 900 });
    out[w] = { title: await pageBox(page.locator("main h1.page-title")), control: await pageBox(control) };
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  return out;
}

/** One state at every width: layout checks, hit-tests, the header shot and
 *  the first screenful attached, and the control-set parity 320 vs 1280.
 *  Option A as ruled: the control on the title's row, right-aligned, from 768
 *  up; under the title on a phone.
 *  `error` — a refusal line on screen: from 768 it belongs to the control's
 *  column, below the control's row, never under the title.
 *  `widths` — the Community pill adds 1024, the width its cap is sized for. */
async function capture(
  page: Page,
  control: Locator,
  testInfo: TestInfo,
  name: string,
  targets: Locator[],
  { error, widths = WIDTHS }: { error?: Locator; widths?: readonly number[] } = {},
) {
  const perWidth: { w: number; controls: string[] }[] = [];
  for (const w of widths) {
    await page.setViewportSize({ width: w, height: 900 });
    await expect(control).toBeVisible();
    await expectNoHorizontalScroll(page);
    const title = await page.locator("main h1.page-title").boundingBox();
    const box = await control.boundingBox();
    const head = await header(page).boundingBox();
    expect(title && box && head, `${name} ${w}: title, control and header all have boxes`).toBeTruthy();
    expect(box!.x + box!.width, `${name} ${w}: the control stays inside the viewport`).toBeLessThanOrEqual(w);
    if (w === 320) {
      expect(box!.y, `${name} 320: the control stacks UNDER the title on a phone`).toBeGreaterThanOrEqual(
        title!.y + title!.height - 1,
      );
    }
    if (w >= 768) {
      // On the title's row: the two overlap vertically, and the control starts
      // where the title's column ends.
      expect(box!.y, `${name} ${w}: the control sits BESIDE the title, on its row`).toBeLessThan(
        title!.y + title!.height,
      );
      expect(box!.y + box!.height, `${name} ${w}: the control sits BESIDE the title, on its row`).toBeGreaterThan(
        title!.y,
      );
      expect(box!.x, `${name} ${w}: the control is right of the title`).toBeGreaterThanOrEqual(
        title!.x + title!.width - 1,
      );
      expect(
        Math.abs(box!.x + box!.width - (head!.x + head!.width)),
        `${name} ${w}: the control is right-aligned in the header`,
      ).toBeLessThanOrEqual(1);
      // Beside, not crowding: the title keeps a real share of the row. The
      // French upgrade pill at its natural width left the title 20% of the
      // row at 768 — six lines of a two-line title.
      expect(title!.width, `${name} ${w}: the title keeps at least 40% of the header`).toBeGreaterThanOrEqual(
        head!.width * 0.4,
      );
      if (error) {
        const line = await error.boundingBox();
        expect(line, `${name} ${w}: the refusal line has a box`).not.toBeNull();
        expect(line!.x, `${name} ${w}: the refusal line starts in the control's column, not under the title`).toBeGreaterThanOrEqual(
          box!.x - 1,
        );
        expect(line!.y, `${name} ${w}: the refusal line sits below the control's row`).toBeGreaterThanOrEqual(
          box!.y + box!.height - 1,
        );
      }
    }
    for (const [i, t] of targets.entries()) await hitTest(t, `${name} ${w} target ${i}`);
    perWidth.push({ w, controls: await controlSet(control) });
    const headPath = testInfo.outputPath(`${name}-${w}-header.png`);
    await header(page).screenshot({ path: headPath, animations: "disabled" });
    await testInfo.attach(`${name}-${w}-header`, { path: headPath, contentType: "image/png" });
    const viewPath = testInfo.outputPath(`${name}-${w}-view.png`);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: viewPath, animations: "disabled" });
    await testInfo.attach(`${name}-${w}-view`, { path: viewPath, contentType: "image/png" });
  }
  expect(perWidth[0]!.controls.length, `${name}: the control set is not empty`).toBeGreaterThan(0);
  expect(perWidth[0]!.controls, `${name}: same controls, same order at 320 and 1280`).toEqual(
    perWidth.at(-1)!.controls,
  );
  await page.setViewportSize({ width: 1280, height: 900 });
}

/** The REACH, over the API: a league division whose last round's two matches
 *  move to the ORG's today and two days on, every other match staying on the
 *  seed's 2026-09-15 — three printable days, today the default and NOT the
 *  first option. */
async function reachThreeDays(page: Page) {
  const seeded = await seedScoredDivision(page.request, [`Ada ${TAG}`, `Bo ${TAG}`, `Cy ${TAG}`, `Di ${TAG}`], {
    decide: false,
  });
  const orgId = await activeOrgIdFromRequest(page.request);
  // resolveVenueTz(null, org.timezone): the org's zone, else UTC.
  const tz = (await orgTimezoneSql(orgId)) ?? "UTC";
  const listed = await apiJson<{ id: string; round_no: number; seq_in_round: number }[]>(
    page.request,
    `/api/v1/divisions/${seeded.divisionId}/fixtures`,
  );
  // The LAST round's two matches move — the board refuses a round that
  // starts on an earlier day than the round before it (rule H6), so only
  // the final round can go later. One to the ORG's today, one two days on
  // (minute-rounded); every other match stays on the seed's 2026-09-15.
  const lastRound = Math.max(...(listed.data ?? []).map((f) => f.round_no));
  const last = (listed.data ?? [])
    .filter((f) => f.round_no === lastRound)
    .sort((a, b) => a.seq_in_round - b.seq_in_round);
  expect(last.length, "precondition: the last round has two matches").toBe(2);
  const now = new Date(Math.floor(Date.now() / 60_000) * 60_000);
  const moves = [now, new Date(now.getTime() + 2 * DAY_MS)];
  for (const [i, at] of moves.entries()) {
    const res = await apiJson(page.request, `/api/v1/fixtures/${last[i]!.id}`, "PATCH", {
      scheduled_at: at.toISOString(),
    });
    expect(res.status, `re-dating match ${i} of the last round: ${JSON.stringify(res.error)}`).toBe(200);
  }
  const relisted = (
    await apiJson<{ scheduled_at: string | null; status: string }[]>(
      page.request,
      `/api/v1/divisions/${seeded.divisionId}/fixtures`,
    )
  ).data!;
  // The org-clock days the fixtures now sit on — what the SQL day list must
  // return — and the default the spec rules: today if it has fixtures.
  const expectedDays = [
    ...new Set(
      relisted
        .filter((f) => f.status === "scheduled" && f.scheduled_at !== null)
        .map((f) => localDate(new Date(f.scheduled_at!), tz)),
    ),
  ].sort();
  const today = localDate(now, tz);
  expect(expectedDays, "precondition: today is a printable day").toContain(today);
  expect(expectedDays.length, "precondition: three days on offer").toBe(3);
  expect(expectedDays[0], "precondition: the default is NOT the first option").not.toBe(today);
  const earlier = expectedDays[0]!;
  return { seeded, today, earlier, expectedDays, todays: last[0]!.id, laterAt: moves[1]! };
}

test.describe("an organiser on a plan with device links", () => {
  test("the picker opens at the org's today; Print sends the picked day and saves the file; a refusal reads localised (en + fr)", async ({
    page,
    context,
  }, testInfo) => {
    // Navs: seed (~12 API calls ≈ 3 navs), 3 page loads. Acts: ~20.
    // Captures: 4 states (en idle, en refusal, fr idle, fr refusal).
    test.setTimeout(budgetFor(6, 20, 4));
    const { seeded, today, earlier, expectedDays } = await reachThreeDays(page);

    // Task 8's route, in its contract. Records every body the control sends.
    const sent: { date: string }[] = [];
    let answer: "pdf" | "none" = "pdf";
    await page.route(`**/api/v1/competitions/${seeded.competitionId}/exports/scorer-sheets`, async (route: Route) => {
      expect(route.request().method()).toBe("POST");
      const body = route.request().postDataJSON() as { date: string };
      sent.push(body);
      if (answer === "none") {
        await route.fulfill({
          status: 422,
          contentType: "application/json",
          body: JSON.stringify({
            ok: false,
            error: { code: "NO_FIXTURES_ON_DAY", message: "No fixtures to print on that day" },
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        headers: {
          "content-type": "application/pdf",
          "content-disposition": `attachment; filename="scorer-sheets-${body.date}.pdf"`,
          "cache-control": "private, no-store",
        },
        body: `%PDF-1.3 stub ${body.date}`,
      });
    });

    await context.clearCookies({ name: "seazn_locale" });
    await setLocale(page, "en");
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(await competitionPath(page.request, seeded.competitionId, "/schedule"));
    const control = page.getByTestId("print-sheets");
    const day = page.getByTestId("print-sheets-day");
    const submit = page.getByTestId("print-sheets-submit");
    await expect(control).toBeVisible({ timeout: STEP_MS });
    await waitForHydration(control);

    // 1. Opens AT the org's today, offering exactly the org-clock days.
    await expect(day).toHaveValue(today);
    expect(await day.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value))).toEqual(
      expectedDays,
    );
    await expect(submit).toHaveText(EN["sheets.print"]!);
    await capture(page, control, testInfo, "en-1-idle", [day, submit]);

    // 2. Print today: one POST carrying today, one download under its name.
    const [first] = await Promise.all([page.waitForEvent("download"), submit.click()]);
    expect(first.suggestedFilename()).toBe(`scorer-sheets-${today}.pdf`);
    expect(readFileSync((await first.path())!, "latin1")).toBe(`%PDF-1.3 stub ${today}`);
    expect(sent).toEqual([{ date: today }]);
    await expect(submit).toBeEnabled();
    await expect(submit).toHaveText(EN["sheets.print"]!);

    // 3. Pick an earlier day: THAT day is what is sent and saved.
    await day.selectOption(earlier);
    const [second] = await Promise.all([page.waitForEvent("download"), submit.click()]);
    expect(second.suggestedFilename()).toBe(`scorer-sheets-${earlier}.pdf`);
    expect(sent.at(-1)).toEqual({ date: earlier });

    // 4. The route refuses (nothing left on that day): the LOCALISED line,
    //    never the server's English, no download — and the button handed back,
    //    with neither the title nor the control moved by the sentence.
    const idleEn = await rowBoxes(page, control);
    answer = "none";
    let downloads = 0;
    page.on("download", () => downloads++);
    await submit.click();
    const error = page.getByTestId("print-sheets-error");
    await expect(error).toHaveText(EN["sheets.error.noFixtures"]!);
    await expect(error).toHaveAttribute("role", "alert");
    await expect(page.locator("main")).not.toContainText("No fixtures to print on that day");
    await expect(submit).toBeEnabled();
    await expect(submit).toHaveText(EN["sheets.print"]!);
    expect(downloads).toBe(0);
    expect(await rowBoxes(page, control), "en: a refusal moves neither the title nor the control").toEqual(idleEn);
    await capture(page, control, testInfo, "en-2-refused", [day, submit], { error });

    // 5. French: the same states read in French.
    answer = "pdf";
    await setLocale(page, "fr");
    await page.reload();
    await expect(control).toBeVisible({ timeout: STEP_MS });
    await waitForHydration(control);
    await expect(day).toHaveValue(today);
    await expect(submit).toHaveText(FR["sheets.print"]!);
    await expect(control).toContainText(FR["sheets.day"]!);
    await capture(page, control, testInfo, "fr-1-idle", [day, submit]);
    const idleFr = await rowBoxes(page, control);
    answer = "none";
    await submit.click();
    await expect(error).toHaveText(FR["sheets.error.noFixtures"]!);
    await expect(submit).toBeEnabled();
    await expect(submit).toHaveText(FR["sheets.print"]!);
    // The longer French line is the one that used to push the control off
    // the title's row.
    expect(await rowBoxes(page, control), "fr: a refusal moves neither the title nor the control").toEqual(idleFr);
    await capture(page, control, testInfo, "fr-2-refused", [day, submit], { error });
    expect(sent.length, "every click sent exactly one POST").toBe(4);
  });

  test("against Task 8's REAL route, unstubbed: Print saves the day's real PDF, a reprint carries the same QR, and a day emptied since the page loaded reads the route's own 422 in French", async ({
    page,
    context,
  }) => {
    // Navs: seed (~12 API calls ≈ 3 navs), 1 page load, 1 re-date. Acts: ~12.
    test.setTimeout(budgetFor(5, 12, 0));
    const { seeded, today, todays, laterAt } = await reachThreeDays(page);
    await context.clearCookies({ name: "seazn_locale" });
    await setLocale(page, "fr");
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(await competitionPath(page.request, seeded.competitionId, "/schedule"));
    const control = page.getByTestId("print-sheets");
    const day = page.getByTestId("print-sheets-day");
    const submit = page.getByTestId("print-sheets-submit");
    await expect(control).toBeVisible({ timeout: STEP_MS });
    await waitForHydration(control);
    await expect(day).toHaveValue(today);

    // 1. The real file, under the route's own filename: a PDF with ONE QR —
    //    today holds one match — whose link is a scoring link, never printed
    //    as text (the link is a bearer secret).
    const printToday = async () => {
      const [download] = await Promise.all([page.waitForEvent("download", { timeout: STEP_MS }), submit.click()]);
      expect(download.suggestedFilename()).toBe(`scorer-sheets-${today}.pdf`);
      return readFileSync((await download.path())!);
    };
    const pdf = await printToday();
    expect(pdf.subarray(0, 5).toString("latin1"), "the saved file is a PDF").toBe("%PDF-");
    const uris = pdfLinkUris(pdf);
    expect(uris, "one QR, for today's one match").toHaveLength(1);
    const token = new URL(uris[0]!).pathname.match(/^\/score\/([^/]+)$/)?.[1];
    expect(token, `a scoring link: ${uris[0]}`).toBeTruthy();
    expect(pdfTextRuns(pdf).filter((r) => r.text.includes(token!))).toEqual([]);
    await expect(submit).toBeEnabled();

    // 2. A reprint carries the same QR: a link is ensured, never rotated.
    expect(pdfLinkUris(await printToday())).toEqual(uris);

    // 3. Today's one match moves off the day AFTER the page loaded: the list on
    //    screen still offers today, and the real route refuses it — its 422
    //    NO_FIXTURES_ON_DAY, read in French, never the route's English.
    const moved = await apiJson(page.request, `/api/v1/fixtures/${todays}`, "PATCH", {
      scheduled_at: new Date(laterAt.getTime() + 60 * 60_000).toISOString(),
    });
    expect(moved.status, `moving today's match: ${JSON.stringify(moved.error)}`).toBe(200);
    await expect(day).toHaveValue(today);
    let downloads = 0;
    page.on("download", () => downloads++);
    const answered = page.waitForResponse(
      (r) => r.url().endsWith("/exports/scorer-sheets") && r.request().method() === "POST",
    );
    await submit.click();
    const res = await answered;
    expect(res.status(), "the real route's refusal").toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("NO_FIXTURES_ON_DAY");
    const error = page.getByTestId("print-sheets-error");
    await expect(error).toHaveText(FR["sheets.error.noFixtures"]!);
    await expect(page.locator("main")).not.toContainText("No fixtures to print on that day");
    await expect(submit).toBeEnabled();
    expect(downloads).toBe(0);
  });
});

test.describe("a Community organiser without an Event Pass", () => {
  // A fresh user and org nobody else touches (directory-kit's freshOrg): the
  // shared Pro org cannot be moved to Community without moving its whole group.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("sees the upgrade pill where the Print button would be, saying what it sells (en + fr + es)", async ({
    page,
  }, testInfo) => {
    // Navs: login + org (2), seed (~3), 3 page loads. Acts: ~10. Captures: 3,
    // each at four widths — costed as 4 captures at the standard three.
    test.setTimeout(budgetFor(8, 10, 4));
    await freshOrg(page, "sheets9");
    await dismissConsent(page);
    const seeded = await seedScoredDivision(page.request, [`Eli ${TAG}`, `Fay ${TAG}`], { decide: false });
    await setLocale(page, "en");
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(await competitionPath(page.request, seeded.competitionId, "/schedule"));
    await expect(page.locator("main h1.page-title")).toBeVisible({ timeout: STEP_MS });
    const gate = header(page).locator('a[data-feature="scoring.device_links"]');
    await expect(gate).toBeVisible();
    // The print control's own sentence, not the feature's hand-over-links one.
    await expect(gate).toContainText(EN["sheets.gate.reason"]!);
    await expect(page.getByTestId("print-sheets-submit")).toHaveCount(0);
    await expect(page.getByTestId("print-sheets-day")).toHaveCount(0);
    await capture(page, gate, testInfo, "community-gate-en", [], { widths: PILL_WIDTHS });

    await setLocale(page, "fr");
    await page.reload();
    await expect(gate).toBeVisible({ timeout: STEP_MS });
    await expect(gate).toContainText(FR["sheets.gate.reason"]!);
    await capture(page, gate, testInfo, "community-gate-fr", [], { widths: PILL_WIDTHS });

    // Spanish carries the longest reason: the width where the cap matters.
    await setLocale(page, "es");
    await page.reload();
    await expect(gate).toBeVisible({ timeout: STEP_MS });
    await expect(gate).toContainText(ES["sheets.gate.reason"]!);
    await capture(page, gate, testInfo, "community-gate-es", [], { widths: PILL_WIDTHS });
  });
});
