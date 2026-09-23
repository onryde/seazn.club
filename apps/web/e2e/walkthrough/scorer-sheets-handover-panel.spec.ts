// The console's device hand-over panel after scorer sheets made device links
// durable (Task 3): a link lives until the match is finalized or cancelled,
// "Show QR" re-shows the SAME link so a printed sheet keeps working, and only
// an explicit, confirmed "Revoke & reissue" / "Revoke" kills it.
//
// ── WHAT IS A REACH AND WHAT IS THE TEST (this folder's README rule) ───────
// REACH, over the API: a rostered football fixture; for the refusal test, the
// match played to full time and FINALIZED behind the open panel; for the
// Rebuild test, a league stage with a withdrawn entrant.
// THE TEST, in the browser: Create → QR; the live line with its three
// controls; Show QR re-showing the same secret; the reissue and revoke
// questions opened and backed out of (Keep sends NO DELETE — counted off the
// wire), a confirmed reissue minting a new secret whose predecessor no longer
// opens a pad, a confirmed "Revoke now" sending exactly ONE DELETE; the
// ensure route's REAL 422 on a finalized match rendered as the localised
// dlink.error.matchOver, never the server's English; and the Rebuild confirm
// naming printed sheets only when the stage has device links (owner Q4).
// Every panel state is checked at 320/768/1280: no horizontal page scroll,
// nothing overflowing the panel, every button hit-tested at its centre and at
// least 44px, and the same controls in the same order at 320 and 1280.
//
// ── WHERE THE NUMBERS COME FROM ───────────────────────────────────────────
// Every sentence is read from the dictionary the page renders (en + fr), so a
// copy change moves the assertion with it and the French legs prove the panel
// is translated. The sport's official ("Referee" → "arbitre") comes from
// `sport.official.football`, and the English word it must never show in
// French is en's own entry for that key — the same word as the engine's
// `officialLabel.scorer` that leaked before Task 3's fix round 2.
//
// This file began as Task 3's throwaway capture spec; its assertions are the
// only browser proof of the DELETE counts and of the real 422's copy — the
// unit suite drives a double.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect, type APIRequestContext, type Locator, type Page, type TestInfo } from "@playwright/test";
import { activeOrg, apiJson, expectNoHorizontalScroll, fixturePath, seedRosteredFixture, TAG } from "../helpers";
import { waitForHydration } from "../directory-kit";

const dict = (locale: "en" | "fr") =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../src/dictionaries/${locale}/ui.json`, import.meta.url)), "utf8"),
  ) as Record<string, string>;
const EN = dict("en");
const FR = dict("fr");
/** The football official in English — what French must never show. */
const ENGLISH_OFFICIAL = EN["sport.official.football"]!;

const WIDTHS = [320, 768, 1280] as const;
/** A page load, a seed, or a poll of the server's own record. */
const STEP_MS = 20_000;
/** A click or a local assertion: a fraction of a page load. */
const REACH_MS = 5_000;
/** Each budget is DERIVED from the journey its test performs (AGENTS.md 20):
 *  a blown flat budget reports as whichever assertion was in flight. A panel
 *  capture is one act per width. */
const budgetFor = (navs: number, acts: number, captures: number): number =>
  Math.max(60_000, navs * STEP_MS + (acts + captures * WIDTHS.length) * REACH_MS);

async function openPanel(page: Page, path: string, { decided = false } = {}): Promise<Locator> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(path);
  // A decided match unmounts the pad but keeps the hand-over control.
  const anchor = page.locator(decided ? '[data-role="device-handover"]' : '[data-testid="score-pad"]');
  await expect(anchor).toBeVisible({ timeout: STEP_MS });
  await waitForHydration(anchor);
  await page.locator('[data-role="device-handover"]').click();
  const panel = page.locator('[data-role="device-link-panel"]');
  await expect(panel).toBeVisible({ timeout: STEP_MS });
  return panel;
}

/** Paint is not reach (AGENTS.md 2): a tap at the control's centre must land
 *  on the control, and the control must be a 44px target. */
async function hitTest(button: Locator, label: string) {
  const box = await button.boundingBox();
  expect(box, `${label}: no box`).not.toBeNull();
  const hit = await button.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!at && (at === el || el.contains(at));
  });
  expect(hit, `${label}: elementFromPoint at centre is not the control`).toBe(true);
  expect(box!.height, `${label}: height under 44`).toBeGreaterThanOrEqual(44);
}

/** One panel state at every width: layout checks, hit-tests, a screenshot
 *  attached to the report, and the control-set parity between 320 and 1280. */
async function capture(page: Page, panel: Locator, testInfo: TestInfo, name: string) {
  const perWidth: { w: number; buttons: string[] }[] = [];
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: 900 });
    await expect(panel).toBeVisible();
    await panel.scrollIntoViewIfNeeded();
    await expectNoHorizontalScroll(page);
    const overflow = await panel.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow, `${name} ${w}: nothing overflows the panel`).toBeLessThanOrEqual(1);
    const panelBox = await panel.boundingBox();
    expect(panelBox!.width, `${name} ${w}: panel fits the viewport`).toBeLessThanOrEqual(w);
    const buttons = panel.getByRole("button");
    const labels = (await buttons.allInnerTexts()).map((b) => b.trim());
    for (let i = 0; i < labels.length; i++) {
      const button = buttons.nth(i);
      await button.scrollIntoViewIfNeeded();
      await hitTest(button, `${name} ${w} "${labels[i]}"`);
    }
    perWidth.push({ w, buttons: labels });
    const path = testInfo.outputPath(`${name}-${w}.png`);
    await panel.screenshot({ path, animations: "disabled" });
    await testInfo.attach(`${name}-${w}`, { path, contentType: "image/png" });
  }
  expect(perWidth[0]!.buttons, `${name}: same controls, same order at 320 and 1280`).toEqual(perWidth[2]!.buttons);
  await page.setViewportSize({ width: 1280, height: 900 });
}

const tokenIn = async (panel: Locator) =>
  (await panel.locator('[data-testid="device-link-url"]').innerText()).split("/score/")[1]!.trim();

async function setLocale(page: Page, locale: "en" | "fr") {
  await page.context().addCookies([
    { name: "seazn_locale", value: locale, url: new URL(test.info().project.use.baseURL!).origin },
  ]);
}

test("the hand-over panel in every state, en + fr: Show QR re-shows, Revoke and reissue ask first, Keep sends nothing", async ({
  page,
  context,
}, testInfo) => {
  // Navs: seed, 5 panel opens, 2 device-page loads. Acts: ~30 clicks and
  // polls. Captures: 13 panel states (7 en, 6 fr).
  test.setTimeout(budgetFor(8, 30, 13));
  const fx = await seedRosteredFixture(page.request, {
    label: `Sheets Panel ${TAG}`,
    sportKey: "football",
    variantKey: "11-a-side",
    home: [{ fullName: `Sheets Home ${TAG}`, positionKey: "FW" }],
    away: [{ fullName: `Sheets Away ${TAG}`, positionKey: "GK" }],
  });
  const path = await fixturePath(page.request, fx.fixtureId);
  await context.clearCookies({ name: "seazn_locale" });
  await setLocale(page, "en");

  // Every DELETE the browser sends to a device link.
  const deletes: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "DELETE" && r.url().includes("/device-links/")) deletes.push(r.url());
  });

  // 1. No link yet: Create, under the durable-lifetime description.
  let panel = await openPanel(page, path);
  await expect(panel.getByTestId("device-link-mint")).toHaveText(EN["dlink.create"]!);
  await expect(panel).toContainText("until it's finalized or cancelled");
  await expect(panel).toContainText(`as the ${EN["sport.official.football"]!.toLowerCase()}`);
  await expect(panel).not.toContainText(/\btoday\b/i);
  await capture(page, panel, testInfo, "en-1-create");

  // 2. Create → the QR, its pad URL and "same QR every time".
  await panel.getByTestId("device-link-mint").click();
  await expect(panel.getByTestId("device-link-url")).toBeVisible({ timeout: STEP_MS });
  await expect(panel).toContainText(EN["dlink.sameQr"]!);
  const first = await tokenIn(panel);
  await capture(page, panel, testInfo, "en-2-qr");

  // 3. Reload → the live line: until-over copy, three controls, no 1970.
  panel = await openPanel(page, path);
  await expect(panel.getByTestId("device-link-show")).toBeVisible({ timeout: STEP_MS });
  await expect(panel).toContainText(EN["dlink.liveUntilOver"]!);
  await expect(panel).not.toContainText("1970");
  await capture(page, panel, testInfo, "en-3-live");

  // 4. Show QR re-shows the SAME secret (ensure, never reissue).
  await panel.getByTestId("device-link-show").click();
  await expect(panel.getByTestId("device-link-url")).toBeVisible({ timeout: STEP_MS });
  expect(await tokenIn(panel), "Show QR re-shows the same secret").toBe(first);

  // 5. Reissue asks first; Keep backs out. Then Revoke asks first too.
  panel = await openPanel(page, path);
  await panel.getByTestId("device-link-reissue").click();
  await expect(panel.getByRole("alert")).toHaveText(EN["dlink.reissueWarn"]!);
  await capture(page, panel, testInfo, "en-4-reissue-confirm");
  await panel.getByTestId("device-link-keep").click();
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await panel.getByTestId("device-link-revoke").click();
  await expect(panel.getByRole("alert")).toHaveText(EN["dlink.revokeWarn"]!);
  await expect(panel.getByTestId("device-link-revoke-confirm")).toHaveText(EN["dlink.revokeConfirm"]!);
  await capture(page, panel, testInfo, "en-5-revoke-confirm");
  await panel.getByTestId("device-link-keep").click();
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await expect(panel.getByTestId("device-link-show")).toBeVisible();
  expect(deletes, "Revoke then Keep sends no DELETE").toEqual([]);

  // 6. Reissue for real: a NEW secret, and the old one no longer opens a pad.
  await panel.getByTestId("device-link-reissue").click();
  await panel.getByTestId("device-link-reissue-confirm").click();
  await expect(panel.getByTestId("device-link-url")).toBeVisible({ timeout: STEP_MS });
  const second = await tokenIn(panel);
  expect(second, "reissue mints a different secret").not.toBe(first);
  await capture(page, panel, testInfo, "en-6-reissued");
  await panel.getByTestId("device-link-revoke-now").click();
  await expect(panel.getByRole("alert")).toHaveText(EN["dlink.revokeWarn"]!);
  await capture(page, panel, testInfo, "en-7-revoke-now-confirm");
  await panel.getByTestId("device-link-keep").click();
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await expect(panel.getByTestId("device-link-url"), "Keep leaves the QR on screen").toBeVisible();
  expect(deletes, "Revoke now then Keep sends no DELETE").toEqual([]);
  const device = await context.browser()!.newContext();
  const dp = await device.newPage();
  const origin = new URL(page.url()).origin;
  await dp.goto(`${origin}/score/${first}`);
  const oldPadRenders = await dp.locator('[data-role="pad-v3"]').count();
  await dp.goto(`${origin}/score/${second}`);
  await expect(dp.locator('[data-role="pad-v3"]')).toBeVisible({ timeout: STEP_MS });
  await device.close();
  expect(oldPadRenders, "the reissued-away secret no longer opens a pad").toBe(0);

  // 7. fr: the live line names the official in French, and every question.
  await setLocale(page, "fr");
  panel = await openPanel(page, path);
  await expect(panel.getByTestId("device-link-show")).toHaveText(FR["dlink.showQr"]!, { timeout: STEP_MS });
  await expect(panel).toContainText(FR["dlink.liveUntilOver"]!);
  await expect(panel).toContainText("jusqu'à ce qu'elle soit finalisée ou annulée");
  await expect(panel).toContainText(`(rôle : ${FR["sport.official.football"]!.toLowerCase()})`);
  await expect(panel).not.toContainText(new RegExp(`\\b${ENGLISH_OFFICIAL}\\b`, "i"));
  await expect(panel).not.toContainText(/aujourd/i);
  await capture(page, panel, testInfo, "fr-3-live");
  await panel.getByTestId("device-link-revoke").click();
  await expect(panel.getByRole("alert")).toHaveText(FR["dlink.revokeWarn"]!);
  await capture(page, panel, testInfo, "fr-5-revoke-confirm");
  await panel.getByTestId("device-link-keep").click();
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await panel.getByTestId("device-link-reissue").click();
  await expect(panel.getByRole("alert")).toHaveText(FR["dlink.reissueWarn"]!);
  await capture(page, panel, testInfo, "fr-4-reissue-confirm");
  // Show QR closes the open question and re-shows the reissued secret.
  await panel.getByTestId("device-link-show").click();
  await expect(panel.getByTestId("device-link-url")).toBeVisible({ timeout: STEP_MS });
  expect(await tokenIn(panel), "fr Show QR re-shows the reissued secret").toBe(second);
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await expect(panel).toContainText(FR["dlink.sameQr"]!);
  await capture(page, panel, testInfo, "fr-2-qr");

  // 8. fr: "Revoke now" asks too; the confirm sends exactly ONE DELETE.
  expect(deletes, "no DELETE before any revoke confirm").toEqual([]);
  await panel.getByTestId("device-link-revoke-now").click();
  await expect(panel.getByRole("alert")).toHaveText(FR["dlink.revokeWarn"]!);
  await capture(page, panel, testInfo, "fr-7-revoke-now-confirm");
  await panel.getByTestId("device-link-revoke-confirm").click();
  await expect(panel.getByTestId("device-link-mint")).toBeVisible({ timeout: STEP_MS });
  expect(deletes, "the confirm sends exactly one DELETE").toHaveLength(1);
  await capture(page, panel, testInfo, "fr-1-create");
});

// Owner ruling Q4 through the REAL producer: a stage whose fixture has a
// device link (attachments.deviceLinks from getStageRosterDrift) shows the
// sheets line in the Rebuild confirm; a twin stage with no link does not.
test("the Rebuild confirm names printed sheets only when the stage has device links", async ({
  page,
  request,
}, testInfo) => {
  // Per twin: ~8 API reaches, one page load; one capture on the linked twin.
  test.setTimeout(budgetFor(4, 16, 1));
  const org = await activeOrg(page);
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Sheets Rebuild ${TAG}`,
    visibility: "private",
  });
  expect(comp.status, JSON.stringify(comp.error)).toBe(201);
  for (const withLink of [true, false]) {
    const div = await apiJson<{ id: string; slug: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
      name: withLink ? "Linked" : "Plain",
      sport_key: "generic",
      variant_key: "score",
      config: { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false },
    });
    expect(div.status, JSON.stringify(div.error)).toBe(201);
    const divisionId = div.data!.id;
    const names = ["A", "B", "C"].map((n) => `Sheets ${n} ${withLink ? "L" : "P"} ${TAG}`);
    const ents = await apiJson(
      request,
      `/api/v1/divisions/${divisionId}/entrants`,
      "POST",
      names.map((display_name, i) => ({ kind: "individual", display_name, seed: i + 1 })),
    );
    expect(ents.status, JSON.stringify(ents.error)).toBe(201);
    const listed = await apiJson<{ id: string; display_name: string }[]>(request, `/api/v1/divisions/${divisionId}/entrants`);
    const aId = listed.data!.find((e) => e.display_name === names[0])!.id;
    const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
      seq: 1,
      kind: "league",
      name: "League",
      config: {},
    });
    expect(stage.status, JSON.stringify(stage.error)).toBe(201);
    const gen = await apiJson(request, `/api/v1/stages/${stage.data!.id}/generate`, "POST");
    expect(gen.status, JSON.stringify(gen.error)).toBe(200);
    if (withLink) {
      const fxs = await apiJson<{ id: string }[]>(request, `/api/v1/divisions/${divisionId}/fixtures`);
      const link = await apiJson(request, `/api/v1/fixtures/${fxs.data![0]!.id}/device-links`, "POST", {});
      expect(link.status, JSON.stringify(link.error)).toBe(201);
    }
    const wd = await apiJson(request, `/api/v1/entrants/${aId}/withdraw`, "POST");
    expect(wd.status, JSON.stringify(wd.error)).toBe(200);

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/o/${org.slug}/c/${comp.data!.slug}/d/${div.data!.slug}?tab=fixtures`);
    const banner = page.getByTestId("roster-drift-banner");
    await expect(banner).toBeVisible({ timeout: STEP_MS });
    await banner.getByTestId("roster-drift-rebuild").click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    const text = (await dialog.innerText()).replace(/\s+/g, " ");
    if (withLink) {
      expect(text).toContain(EN["progression.rosterDrift.sheetsStop"]!);
      for (const w of WIDTHS) {
        await page.setViewportSize({ width: w, height: 900 });
        await expectNoHorizontalScroll(page);
        const path = testInfo.outputPath(`en-rebuild-confirm-${w}.png`);
        await dialog.screenshot({ path, animations: "disabled" });
        await testInfo.attach(`en-rebuild-confirm-${w}`, { path, contentType: "image/png" });
      }
    } else {
      expect(text).not.toContain(EN["progression.rosterDrift.sheetsStop"]!);
    }
    // Esc cancels (confirm-provider) — nothing is rebuilt.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  }
});

async function postEvent(request: APIRequestContext, fixtureId: string, type: string, payload: Record<string, unknown>) {
  const state = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${fixtureId}/state`);
  expect(state.status, `state before ${type}`).toBe(200);
  const res = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: state.data!.last_seq,
    type,
    payload,
  });
  expect(res.status, `${type}: ${JSON.stringify(res.error)}`).toBeLessThan(300);
}

// Review finding 3 through the REAL producer: the panel is open on a decided
// match, the match is finalized behind it, and Create hits the ensure route's
// real 422 ("fixture is finalized — nothing left to score"). The organiser
// reads dlink.error.matchOver in THEIR locale, never that English.
test("a real 422 on a finalized match renders the localised refusal, never the server's English (en + fr)", async ({
  page,
  context,
}, testInfo) => {
  // Per locale: seed + 3 events + finalize (5 reaches), one panel open, a
  // tap and its response; one capture.
  test.setTimeout(budgetFor(4, 16, 2));
  for (const locale of ["en", "fr"] as const) {
    const d = locale === "en" ? EN : FR;
    const fx = await seedRosteredFixture(page.request, {
      label: `Sheets Refuse ${locale} ${TAG}`,
      sportKey: "football",
      variantKey: "11-a-side",
      home: [{ fullName: `Sheets R Home ${locale} ${TAG}` }],
      away: [{ fullName: `Sheets R Away ${locale} ${TAG}` }],
      entrantKind: "team",
      emitCoreStart: true,
      skipLineups: true,
    });
    // A non-level score, then full time: decided (a level one goes to a shoot-out).
    await postEvent(page.request, fx.fixtureId, "football.goal", { by: fx.homeEntrantId });
    await postEvent(page.request, fx.fixtureId, "football.period", { phase: "HT" });
    await postEvent(page.request, fx.fixtureId, "football.period", { phase: "FT" });
    const path = await fixturePath(page.request, fx.fixtureId);
    await context.clearCookies({ name: "seazn_locale" });
    await setLocale(page, locale);
    const panel = await openPanel(page, path, { decided: true });
    await expect(panel.getByTestId("device-link-mint")).toHaveText(d["dlink.create"]!);

    const state = await apiJson<{ last_seq: number; status: string }>(page.request, `/api/v1/fixtures/${fx.fixtureId}/state`);
    const fin = await apiJson(page.request, `/api/v1/fixtures/${fx.fixtureId}/finalize`, "POST", {
      expected_seq: state.data!.last_seq,
    });
    expect(fin.status, `finalize from ${state.data!.status}: ${JSON.stringify(fin.error)}`).toBe(200);

    const refused = page.waitForResponse(
      (r) => r.url().endsWith(`/api/v1/fixtures/${fx.fixtureId}/device-links`) && r.request().method() === "POST",
    );
    await panel.getByTestId("device-link-mint").click();
    const res = await refused;
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(res.status(), "the ensure route's own refusal").toBe(422);
    expect(body.error.message, "the server really sent English").toMatch(/nothing left to score/);
    await expect(panel).toContainText(d["dlink.error.matchOver"]!);
    await expect(panel).not.toContainText(body.error.message);
    await expect(panel).not.toContainText("fixture is finalized");
    // en's own copy shares "nothing left to score"; any other locale must not.
    if (locale !== "en") await expect(panel).not.toContainText("nothing left to score");
    await capture(page, panel, testInfo, `${locale}-8-refused`);
  }
});
