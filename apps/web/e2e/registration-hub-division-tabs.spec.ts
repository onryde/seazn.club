// B7 T24 (spec 2026-11-13 §9.2–9.4) — a division's registration settings open as a closable tab of the organiser hub,
// beside Settings and Registrants, at most two at a time. Driven in a real browser against a real build, because what this
// file proves is exactly what the component suites cannot see (AGENTS.md class 2): that a hidden tab keeps its page — and its
// unsaved edits — MOUNTED across a client navigation, that Back and a reload go through the address the way the host says,
// that the browser's own leave prompt arms and disarms, and that the strip's close buttons are real 44px targets at 320.
//
// Each width is its own describe with its own viewport (1280 and 320), in the "parallel" Desktop Chrome project:
// mobile.spec.ts is the seven-width backstop and is not edited by this task.
//
// Every test seeds its own competition with three fresh divisions through the real API, so no test reads another's tabs.
// Expected copy comes from the shipped English dictionary, the one authority for it.
//
// Selectors (registration-hub-{tab-strip,tabs-host,division-row,config-panel,config-page-chrome}.tsx):
//   [data-testid="reg-hub-tab-settings" | "reg-hub-tab-registrants"]     the section tabs (links, aria-current)
//   [data-testid="reg-hub-tab-division"][data-division-id]               a division tab (link, aria-current)
//   [data-testid="reg-hub-tab-close"][data-division-id]                  its separate × button
//   [data-reg-hub-tab-dirty]                                             the unsaved-edits dot inside a division tab
//   [data-registration-hub-row-configure]                                a Settings row's "Open settings"
//   [data-registration-hub-config-panel][data-layout="page"][data-division-id]   a division's settings page
//   [data-reg-hub-dialog-action="save" | "discard" | "dismiss"]          the evict / close dialog's buttons
//   [data-reg-hub-toast] / [data-reg-hub-reopen]                         the toast and its Reopen
import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TAG, activeOrg, apiJson, expectNoHorizontalScroll, withDb } from "./helpers";
import { waitForHydration } from "./directory-kit";

const UI_EN = JSON.parse(
  readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
) as Record<string, string>;
const copy = (key: string, vars: Record<string, string | number> = {}) => {
  const text = UI_EN[key];
  if (text === undefined) throw new Error(`ui.json has no ${key}`);
  return Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), text);
};

const GENERIC_CONFIG = { points: { w: 3, d: 1, l: 0 }, progressScore: false };

type Seeded = { orgSlug: string; compSlug: string; ids: [string, string, string, ...string[]]; names: [string, string, string, ...string[]] };

/** One competition and three (or more) divisions, none of them with a registration_settings row yet. */
async function seed(
  page: Page,
  request: APIRequestContext,
  names: [string, string, string, ...string[]] = ["Open Singles", "Doubles", "Mixed"],
): Promise<Seeded> {
  const org = await activeOrg(page);
  const suffix = `${TAG}-${Math.random().toString(36).slice(2, 7)}`;
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    name: `Hub Tabs ${suffix}`,
    ends_on: "2030-12-31",
    visibility: "private",
  });
  if (comp.status >= 300) throw new Error(`seed: competition create ${comp.status}`);
  const ids: string[] = [];
  for (const name of names) {
    const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
      name,
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
    });
    if (div.status >= 300) throw new Error(`seed: division create ${div.status}`);
    ids.push(div.data!.id);
  }
  return { orgSlug: org.slug, compSlug: comp.data!.slug, ids: ids as Seeded["ids"], names };
}

const hubPath = (s: Seeded, query = "") => `/o/${s.orgSlug}/c/${s.compSlug}/registration${query}`;

const sectionTab = (page: Page, key: "settings" | "registrants") => page.getByTestId(`reg-hub-tab-${key}`);
const divisionTab = (page: Page, id: string) => page.locator(`[data-testid="reg-hub-tab-division"][data-division-id="${id}"]`);
const closeButton = (page: Page, id: string) => page.locator(`[data-testid="reg-hub-tab-close"][data-division-id="${id}"]`);
const divisionPage = (page: Page, id: string) =>
  page.locator(`[data-registration-hub-config-panel][data-layout="page"][data-division-id="${id}"]`);
const capacity = (page: Page, id: string) => divisionPage(page, id).locator('[data-field="capacity"]');
const dialog = (page: Page) => page.getByRole("dialog").filter({ has: page.locator("[data-reg-hub-dialog-body]") });
const dialogAction = (page: Page, action: "save" | "discard" | "dismiss") =>
  dialog(page).locator(`[data-reg-hub-dialog-action="${action}"]`);
const toast = (page: Page) => page.locator("[data-reg-hub-toast]");

/** The address's tab state, as the host wrote it. */
function addressOf(page: Page): { tab: string | null; open: string | null } {
  const params = new URL(page.url()).searchParams;
  return { tab: params.get("tab"), open: params.get("open") };
}
async function expectAddress(page: Page, want: { tab: string; open: string[] }) {
  await expect
    .poll(() => addressOf(page), { timeout: 20_000 })
    .toEqual({ tab: want.tab, open: want.open.length > 0 ? want.open.join(",") : null });
}

/** The division tabs in strip order. */
async function stripDivisions(page: Page): Promise<string[]> {
  return page.getByTestId("reg-hub-tab-division").evaluateAll((els) => els.map((el) => el.getAttribute("data-division-id") ?? ""));
}

async function expectActive(page: Page, id: string) {
  await expect(divisionTab(page, id)).toHaveAttribute("aria-current", "page", { timeout: 20_000 });
  await expect(divisionPage(page, id)).toBeVisible({ timeout: 20_000 });
  // Past the page's own GET: a field is the sign its state landed.
  await expect(capacity(page, id)).toBeVisible({ timeout: 20_000 });
}

async function toSettings(page: Page) {
  const tab = sectionTab(page, "settings");
  if ((await tab.getAttribute("aria-current")) !== "page") await tab.click();
  await expect(tab).toHaveAttribute("aria-current", "page", { timeout: 20_000 });
  await expect(page.locator("[data-registration-hub-settings-panel]")).toBeVisible({ timeout: 20_000 });
}

/** Settings → the row's "Open settings". Hydration first: before it the button is inert and the click is lost. */
async function clickOpenSettings(page: Page, id: string) {
  await toSettings(page);
  const button = page.locator(`[data-registration-hub-row][data-division-id="${id}"] [data-registration-hub-row-configure]`);
  await expect(button).toBeVisible({ timeout: 20_000 });
  await waitForHydration(button);
  await button.click();
}

async function openFromSettings(page: Page, id: string) {
  await clickOpenSettings(page, id);
  await expectActive(page, id);
}

/** A toast sits over the top of the page for up to 10s; tests that go on to click the strip put it away first. */
async function dismissToast(page: Page) {
  if (await toast(page).isVisible()) await toast(page).getByRole("button", { name: copy("reg.hub.toast.dismiss") }).click();
  await expect(toast(page)).toHaveCount(0);
}

/** Past the effects of the render on screen: a frame, then a task — React runs passive effects after the paint. */
async function afterEffects(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))));
}

/** The division's capacity as the SERVER holds it — never the page's own echo. */
async function storedCapacity(request: APIRequestContext, id: string): Promise<number | null> {
  const res = await apiJson<{ capacity: number | null }>(request, `/api/v1/divisions/${id}/registration-settings`);
  if (res.status !== 200) throw new Error(`registration-settings GET ${res.status}`);
  return res.data!.capacity;
}

async function editCapacity(page: Page, id: string, value: string) {
  await capacity(page, id).fill(value);
  await expect(divisionTab(page, id).locator("[data-reg-hub-tab-dirty]")).toBeVisible({ timeout: 20_000 });
}

/** A half-typed opening date: refused by the page on Save (in the schedule section), and unsaved — the tab shows the dot. */
async function halfTypeOpeningDate(page: Page, id: string) {
  await divisionPage(page, id).locator('[data-field="opens_at_date"]').fill("2030-01-01");
  await expect(divisionTab(page, id).locator("[data-reg-hub-tab-dirty]")).toBeVisible({ timeout: 20_000 });
}

/** The schedule section's focus target on a page: its heading from md up (every section open), its summary below. */
function scheduleFocus(page: Page, id: string, width: number): Locator {
  const section = divisionPage(page, id).locator(`#section-schedule-${id}`);
  return width >= 768 ? section.locator("[data-section-heading]") : section.locator(":scope > summary");
}

/** After a refused save: that page's schedule section has focus and is on screen, below the sticky header. */
async function expectRefusalRevealed(page: Page, id: string, viewport: { width: number; height: number }) {
  const focus = scheduleFocus(page, id, viewport.width);
  await expect(focus).toBeFocused({ timeout: 10_000 });
  const headerBottom = await page.evaluate(() => document.querySelector(".app-gantry")?.getBoundingClientRect().bottom ?? 0);
  // Smooth scroll: wait for it to settle, then the focused element sits on screen, clear of the header.
  await expect
    .poll(async () => {
      const top = (await focus.boundingBox())!.y;
      await page.waitForTimeout(150);
      return Math.abs((await focus.boundingBox())!.y - top) < 1 ? top : Number.NaN;
    }, { timeout: 10_000 })
    .toBeGreaterThanOrEqual(headerBottom - 1);
  expect((await focus.boundingBox())!.y, "the focused refusal is on screen").toBeLessThan(viewport.height);
}

/** A link out of the hub in the app shell, on screen at every width: the header's wordmark (home). */
const leaveLink = (page: Page) => page.locator('header.app-gantry a[href="/"]').first();

/** A, then B, both from Settings; B on screen, open = A,B (A least recently used). */
async function openTwo(page: Page, s: Seeded, editA?: string) {
  await openFromSettings(page, s.ids[0]);
  if (editA !== undefined) await editCapacity(page, s.ids[0], editA);
  await openFromSettings(page, s.ids[1]);
  await expectAddress(page, { tab: `division:${s.ids[1]}`, open: [s.ids[0], s.ids[1]] });
}

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 320, height: 640 },
] as const) {
  test.describe(`registration hub division tabs @${viewport.width}`, () => {
    test.use({ viewport });

    test("an edit survives a switch to Registrants and back, and the tab shows the dot meanwhile", async ({ page, request }) => {
      const s = await seed(page, request);
      const [a] = s.ids;
      await page.goto(hubPath(s), { waitUntil: "load" });
      await openFromSettings(page, a);
      await editCapacity(page, a, "12");

      await sectionTab(page, "registrants").click();
      await expect(sectionTab(page, "registrants")).toHaveAttribute("aria-current", "page", { timeout: 20_000 });
      await expectAddress(page, { tab: "registrants", open: [a] });
      // Hidden, not gone: the page is still in the document behind the tab on screen.
      await expect(divisionPage(page, a)).toBeHidden();
      await expect(divisionPage(page, a)).toHaveCount(1);
      await expect(divisionTab(page, a).locator("[data-reg-hub-tab-dirty]")).toBeVisible();
      await expect(divisionTab(page, a).locator("[data-reg-hub-tab-dirty]")).toHaveAttribute("aria-label", copy("reg.hub.tabs.unsaved"));

      await divisionTab(page, a).click();
      await expectActive(page, a);
      await expect(capacity(page, a)).toHaveValue("12");
      await expect(divisionPage(page, a).locator('[data-config-status="dirty"]')).toBeVisible();
      expect(await storedCapacity(request, a), "a tab switch saves nothing").toBeNull();
    });

    test("reload restores both open tabs, in order, and the one on screen", async ({ page, request }) => {
      const s = await seed(page, request);
      const [a, b] = s.ids;
      await page.goto(hubPath(s), { waitUntil: "load" });
      await openTwo(page, s);

      await page.reload({ waitUntil: "load" });
      await expectActive(page, b);
      expect(await stripDivisions(page)).toEqual([a, b]);
      await expect(divisionTab(page, a)).not.toHaveAttribute("aria-current", "page");
      await expect(divisionPage(page, a)).toBeHidden();
      await divisionTab(page, a).click();
      await expectActive(page, a);
      // Activating moves A to the end of the list: B is now the least recently used.
      await expectAddress(page, { tab: `division:${a}`, open: [b, a] });
      // The strip does not: tabs stay in the order they were opened, so a click never swaps them under the pointer (fix
      // round 1 m2). Only a reload, which has nothing but the address, starts from the address's order.
      expect(await stripDivisions(page)).toEqual([a, b]);
      await divisionTab(page, b).click();
      await expectActive(page, b);
      await expectAddress(page, { tab: `division:${b}`, open: [a, b] });
      expect(await stripDivisions(page)).toEqual([a, b]);
    });

    test("a third clean tab closes the least recently used one, says so, and Reopen brings it back", async ({ page, request }) => {
      const s = await seed(page, request);
      const [a, b, c] = s.ids;
      await page.goto(hubPath(s), { waitUntil: "load" });
      await openTwo(page, s);

      await openFromSettings(page, c);
      await expectAddress(page, { tab: `division:${c}`, open: [b, c] });
      await expect(divisionTab(page, a)).toHaveCount(0);
      await expect(divisionPage(page, a)).toHaveCount(0);
      await expect(dialog(page), "a clean tab closes without asking").toHaveCount(0);
      await expect(toast(page)).toContainText(copy("reg.hub.evicted", { name: s.names[0] }));

      await toast(page).locator("[data-reg-hub-reopen]").click();
      await expectActive(page, a);
      // Reopening is an open like any other: B, now the least recently used, makes room.
      await expectAddress(page, { tab: `division:${a}`, open: [c, a] });
      await expect(divisionTab(page, b)).toHaveCount(0);
      await expect(toast(page)).toContainText(copy("reg.hub.evicted", { name: s.names[1] }));
    });

    test("a third tab with unsaved edits in the least recently used one asks: Cancel keeps everything", async ({ page, request }) => {
      const s = await seed(page, request);
      const [a, b, c] = s.ids;
      await page.goto(hubPath(s), { waitUntil: "load" });
      await openTwo(page, s, "13");
      await clickOpenSettings(page, c);

      await expect(dialog(page)).toBeVisible({ timeout: 20_000 });
      await expect(dialog(page)).toContainText(copy("reg.hub.evict.title", { name: s.names[0] }));
      await expect(dialog(page).locator("[data-reg-hub-dialog-body]")).toHaveText(
        copy("reg.hub.evict.body", { name: s.names[0], next: s.names[2] }),
      );
      // Primary first: the save, then the discard, then the way back out — on screen in that order at 320, stacked.
      const order = await dialog(page).locator("[data-reg-hub-dialog-action]").evaluateAll((els) =>
        els
          .map((el) => ({ action: el.getAttribute("data-reg-hub-dialog-action"), top: el.getBoundingClientRect().top, left: el.getBoundingClientRect().left }))
          .sort((x, y) => x.top - y.top || x.left - y.left)
          .map((x) => x.action),
      );
      expect(order).toEqual(viewport.width < 640 ? ["save", "discard", "dismiss"] : ["dismiss", "discard", "save"]);
      await expect(dialogAction(page, "save")).toHaveText(copy("reg.hub.evict.save"));

      await dialogAction(page, "dismiss").click();
      await expect(dialog(page)).toHaveCount(0);
      await expectAddress(page, { tab: "settings", open: [a, b] });
      await expect(divisionTab(page, c)).toHaveCount(0);
      await expect(divisionTab(page, a).locator("[data-reg-hub-tab-dirty]")).toBeVisible();
      await divisionTab(page, a).click();
      await expectActive(page, a);
      await expect(capacity(page, a)).toHaveValue("13");
    });

    test("a third tab with unsaved edits in the least recently used one: Discard and open swaps without saving", async ({ page, request }) => {
      const s = await seed(page, request);
      const [a, b, c] = s.ids;
      await page.goto(hubPath(s), { waitUntil: "load" });
      await openTwo(page, s, "13");
      await clickOpenSettings(page, c);
      await expect(dialog(page)).toBeVisible({ timeout: 20_000 });

      await dialogAction(page, "discard").click();
      await expectActive(page, c);
      await expectAddress(page, { tab: `division:${c}`, open: [b, c] });
      await expect(divisionTab(page, a)).toHaveCount(0);
      expect(await storedCapacity(request, a), "a discard sends nothing").toBeNull();

      // The discarded edit is gone for good: A reopens on what the server holds.
      await openFromSettings(page, a);
      await expect(capacity(page, a)).toHaveValue("");
      await expect(divisionPage(page, a).locator('[data-config-status="clean"]')).toBeVisible();
    });

    test("a third tab with unsaved edits in the least recently used one: Save and open saves, then swaps", async ({ page, request }) => {
      const s = await seed(page, request);
      const [a, b, c] = s.ids;
      await page.goto(hubPath(s), { waitUntil: "load" });
      await openTwo(page, s, "13");
      await clickOpenSettings(page, c);
      await expect(dialog(page)).toBeVisible({ timeout: 20_000 });

      await dialogAction(page, "save").click();
      await expectActive(page, c);
      await expectAddress(page, { tab: `division:${c}`, open: [b, c] });
      await expect(divisionTab(page, a)).toHaveCount(0);
      await expect.poll(() => storedCapacity(request, a), { timeout: 20_000 }).toBe(13);
      await expect(toast(page)).toContainText(copy("reg.hub.saved"));
    });

    test("× on a tab with unsaved edits: Keep editing keeps it, Discard closes it unsaved", async ({ page, request }) => {
      const s = await seed(page, request);
      const [a] = s.ids;
      await page.goto(hubPath(s), { waitUntil: "load" });
      await openFromSettings(page, a);
      await editCapacity(page, a, "14");

      await closeButton(page, a).click();
      await expect(dialog(page)).toBeVisible();
      await expect(dialog(page)).toContainText(copy("reg.hub.close.title", { name: s.names[0] }));
      await expect(dialog(page).locator("[data-reg-hub-dialog-body]")).toHaveText(
        copy("reg.hub.close.body.one", { count: 1, sections: copy("reg.settings.capacity") }),
      );

      await dialogAction(page, "dismiss").click();
      await expect(dialog(page)).toHaveCount(0);
      await expectActive(page, a);
      await expect(capacity(page, a)).toHaveValue("14");
      await expectAddress(page, { tab: `division:${a}`, open: [a] });

      await closeButton(page, a).click();
      await dialogAction(page, "discard").click();
      await expect(dialog(page)).toHaveCount(0);
      await expect(divisionTab(page, a)).toHaveCount(0);
      await expect(divisionPage(page, a)).toHaveCount(0);
      await expect(sectionTab(page, "settings")).toHaveAttribute("aria-current", "page");
      await expectAddress(page, { tab: "settings", open: [] });
      expect(await storedCapacity(request, a)).toBeNull();
    });

    test("× on a tab with unsaved edits: Save and close persists it and closes the tab", async ({ page, request }) => {
      const s = await seed(page, request);
      const [a] = s.ids;
      await page.goto(hubPath(s), { waitUntil: "load" });
      await openFromSettings(page, a);
      await editCapacity(page, a, "15");

      await closeButton(page, a).click();
      await dialogAction(page, "save").click();
      await expect(dialog(page)).toHaveCount(0, { timeout: 20_000 });
      await expect(divisionTab(page, a)).toHaveCount(0);
      await expectAddress(page, { tab: "settings", open: [] });
      await expect.poll(() => storedCapacity(request, a), { timeout: 20_000 }).toBe(15);

      // And a clean tab's × closes it on the spot, no question asked.
      await dismissToast(page);
      await openFromSettings(page, a);
      await closeButton(page, a).click();
      await expect(dialog(page)).toHaveCount(0);
      await expect(divisionTab(page, a)).toHaveCount(0);
    });

    test("Back off a tab with unsaved edits puts it back and asks", async ({ page, request }) => {
      const s = await seed(page, request);
      const [a] = s.ids;
      await page.goto(hubPath(s), { waitUntil: "load" });
      await openFromSettings(page, a);
      await editCapacity(page, a, "16");

      await page.goBack();
      // The address went back to Settings with nothing open; the host replaces A back in, on screen, and asks.
      await expect(dialog(page)).toBeVisible({ timeout: 20_000 });
      await expect(dialog(page)).toContainText(copy("reg.hub.close.title", { name: s.names[0] }));
      await expectAddress(page, { tab: `division:${a}`, open: [a] });

      await dialogAction(page, "dismiss").click();
      await expectActive(page, a);
      await expect(capacity(page, a), "the edit was never unmounted").toHaveValue("16");
      expect(await storedCapacity(request, a)).toBeNull();

      // The sequence's second round. Save it (clean), close it (clean: no question), open it again — a fresh push — edit, and
      // go Back once more: asked again, and this time Discard lets the tab go, leaving the saved value as it was.
      await divisionPage(page, a).locator('[data-action="save"]').click();
      await expect(divisionPage(page, a).locator('[data-config-status="clean"]')).toBeVisible({ timeout: 20_000 });
      await expect.poll(() => storedCapacity(request, a), { timeout: 20_000 }).toBe(16);
      await dismissToast(page);
      await closeButton(page, a).click();
      await expect(dialog(page)).toHaveCount(0);
      await expectAddress(page, { tab: "settings", open: [] });
      await openFromSettings(page, a);
      await editCapacity(page, a, "19");
      await page.goBack();
      await expect(dialog(page)).toBeVisible({ timeout: 20_000 });
      await dialogAction(page, "discard").click();
      await expect(divisionTab(page, a)).toHaveCount(0);
      await expect(sectionTab(page, "settings")).toHaveAttribute("aria-current", "page");
      await expectAddress(page, { tab: "settings", open: [] });
      expect(await storedCapacity(request, a), "the discarded 19 never reached the server").toBe(16);
    });

    test("the browser asks before leaving only while an edit is unsaved", async ({ page, request }) => {
      const s = await seed(page, request);
      const [a] = s.ids;
      await page.goto(hubPath(s), { waitUntil: "load" });
      await openFromSettings(page, a);
      const prompts: string[] = [];
      page.on("dialog", (d) => {
        prompts.push(d.type());
        void d.dismiss();
      });

      // Clean: a reload goes straight through. (A prompt here would be dismissed, cancel the reload, and throw.)
      await page.reload({ waitUntil: "load" });
      await expectActive(page, a);
      expect(prompts, "no prompt while nothing is unsaved").toEqual([]);

      // Dirty: closing the page runs beforeunload, which asks; dismissing it keeps the page. The host arms the listener in an
      // effect, after the render that drew the dot: let that effect run before closing.
      await editCapacity(page, a, "17");
      await afterEffects(page);
      await page.close({ runBeforeUnload: true });
      await expect.poll(() => prompts, { timeout: 10_000 }).toEqual(["beforeunload"]);
      expect(page.isClosed(), "the dismissed prompt kept the page").toBe(false);

      // Saved: clean again, so closing goes through without a second prompt. Clean is the HOST's word (the tab's dot gone),
      // not just the page's bar: the host is what disarms the listener, in the effect after that render.
      await divisionPage(page, a).locator('[data-action="save"]').click();
      await expect(divisionPage(page, a).locator('[data-config-status="clean"]')).toBeVisible({ timeout: 20_000 });
      await expect(divisionTab(page, a).locator("[data-reg-hub-tab-dirty]")).toHaveCount(0);
      await afterEffects(page);
      await page.close({ runBeforeUnload: true });
      await expect.poll(() => ({ closed: page.isClosed(), prompts: [...prompts] }), { timeout: 10_000 }).toEqual({
        closed: true,
        prompts: ["beforeunload"],
      });
    });

    test("a division with no registration settings yet opens like any other", async ({ page, request }) => {
      const s = await seed(page, request);
      const [a] = s.ids;
      // Fresh divisions carry no row; delete defensively so the state under test does not rest on what create writes.
      const rows = await withDb(async (sql) => {
        await sql`delete from registration_settings where division_id = ${a}`;
        const [r] = await sql<{ n: number }[]>`select count(*)::int as n from registration_settings where division_id = ${a}`;
        return r!.n;
      });
      expect(rows).toBe(0);
      await page.goto(hubPath(s), { waitUntil: "load" });
      await openFromSettings(page, a);
      await expect(capacity(page, a)).toHaveValue("");
      await expect(divisionPage(page, a).locator('[data-config-status="clean"]')).toBeVisible();
    });

    test("the Registrants filters' Clear all and the empty states' links keep the open tabs", async ({ page, request }) => {
      const s = await seed(page, request);
      const [a] = s.ids;
      await page.goto(hubPath(s), { waitUntil: "load" });
      await openFromSettings(page, a);
      await page.goto(hubPath(s, `?tab=registrants&open=${a}&q=nobody-matches-this`), { waitUntil: "load" });
      await expect(divisionTab(page, a)).toBeVisible();

      // From md the pill row's Clear all, below it the chip row's: one of the two is on screen at each width.
      const clearAll = page.locator(viewport.width >= 768 ? "[data-filter-clear-all]" : "[data-chip-clear-all]");
      await expect(clearAll).toBeVisible({ timeout: 20_000 });
      expect(new URL(await clearAll.evaluate((el) => (el as HTMLAnchorElement).href)).searchParams.get("open")).toBe(a);

      // The filtered empty state's link: clears the filters, keeps the tab.
      const filtered = page.locator('[data-registration-hub-registrant-empty="filtered"] a');
      await expect(filtered).toBeVisible({ timeout: 20_000 });
      await waitForHydration(filtered);
      await filtered.click();
      // tab and open were already these before the click: wait on the param the click removes.
      await page.waitForURL((u) => !u.searchParams.has("q"), { timeout: 20_000 });
      await expectAddress(page, { tab: "registrants", open: [a] });
      await expect(divisionTab(page, a)).toBeVisible();

      // The bare empty state's link goes to Settings, still with the tab.
      const bare = page.locator('[data-registration-hub-registrant-empty="empty"] a');
      await expect(bare).toBeVisible({ timeout: 20_000 });
      await bare.click();
      await expectAddress(page, { tab: "settings", open: [a] });
      await expect(divisionTab(page, a)).toBeVisible();
    });

    test("the strip: each × is a whole 44px target, the strip scrolls inside itself, the page never sideways", async ({ page, request }) => {
      // Long names, so at 320 the strip is wider than the screen — the case its own scroller exists for.
      const s = await seed(page, request, ["Under-14 Girls Doubles — Saturday Morning", "Under-16 Boys Singles — Sunday Afternoon", "Mixed"]);
      const [a, b] = s.ids;
      await page.goto(hubPath(s), { waitUntil: "load" });
      await openTwo(page, s);

      const strip = page.getByRole("navigation", { name: copy("reg.hub.tabs.label") });
      const fit = await strip.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth, overflowX: getComputedStyle(el).overflowX, tabIndex: el.tabIndex }));
      expect(fit.overflowX, "the strip is its own scroller").toBe("auto");
      expect(fit.tabIndex, "a scroller owes a tab stop").toBe(0);
      // At 1280 two tabs fit, so there is nothing to scroll; at 320 they cannot, so the strip must scroll (class 23).
      if (viewport.width < 768) expect(fit.scroll, "at 320 the strip holds more than it shows").toBeGreaterThan(fit.client);
      await expectNoHorizontalScroll(page);

      let checked = 0;
      for (const id of [a, b]) {
        const close = closeButton(page, id);
        await close.scrollIntoViewIfNeeded();
        const box = (await close.boundingBox())!;
        expect(box, `× ${id} is measurable`).not.toBeNull();
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
        // Hit-test the paint, not just measure it: the centre and 2px in from each edge land on this × and nothing else.
        const points = [
          [box.x + box.width / 2, box.y + box.height / 2],
          [box.x + 2, box.y + box.height / 2],
          [box.x + box.width - 2, box.y + box.height / 2],
          [box.x + box.width / 2, box.y + 2],
          [box.x + box.width / 2, box.y + box.height - 2],
        ] as const;
        for (const [x, y] of points) {
          const hit = await page.evaluate(
            ([px, py]) => document.elementFromPoint(px, py)?.closest('[data-testid="reg-hub-tab-close"]')?.getAttribute("data-division-id") ?? null,
            [x, y] as const,
          );
          expect(hit, `× ${id} at (${Math.round(x)}, ${Math.round(y)})`).toBe(id);
          checked += 1;
        }
      }
      expect(checked).toBe(10);
      await expectNoHorizontalScroll(page);
    });

    test("axe: the hub with two division tabs open has no serious or critical issue", async ({ page, request }) => {
      const s = await seed(page, request);
      await page.goto(hubPath(s), { waitUntil: "load" });
      await openTwo(page, s, "18");
      // Next streams the head's <title> on a client navigation; axe run mid-swap reads a title-less document.
      await expect(page).toHaveTitle(/\S/, { timeout: 20_000 });
      const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
      const blocking = axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
      expect(axe.passes.length, "axe ran rules against the page").toBeGreaterThan(0);
    });

    test("the settings page: a section reveal adds no #hash, focuses the section and clears the header; the Save bar is one reachable row", async ({ page, request }) => {
      const s = await seed(page, request);
      const [a] = s.ids;
      await page.goto(hubPath(s), { waitUntil: "load" });
      await openFromSettings(page, a);
      const view = divisionPage(page, a);
      const historyBefore = await page.evaluate(() => history.length);
      const headerBottom = await page.evaluate(() => document.querySelector(".app-gantry")?.getBoundingClientRect().bottom ?? 0);
      expect(headerBottom, "the sticky app header is there to clear").toBeGreaterThan(0);

      let target: Locator;
      let focused: Locator;
      if (viewport.width >= 768) {
        // From md: the section index. "form" is the last section, below the fold before the click.
        target = view.locator(`#section-form-${a}`);
        focused = target.locator("[data-section-heading]");
        expect((await target.boundingBox())!.y, "the section starts below the fold").toBeGreaterThan(viewport.height);
        await view.locator('[data-section-link="form"]').click();
      } else {
        // Below md there is no index (it would only repeat the accordions): a refused save is what reveals a section. A
        // half-typed opening date is refused on the page, in the schedule section, scrolled out of sight first.
        await expect(view.locator('nav[aria-label] [data-section-link]').first()).toBeHidden();
        await view.locator('[data-field="opens_at_date"]').fill("2030-01-01");
        await page.evaluate(() => window.scrollTo(0, 0));
        target = view.locator(`#section-schedule-${a}`);
        focused = target.locator(":scope > summary");
        expect((await target.boundingBox())!.y, "the section starts below the fold").toBeGreaterThan(viewport.height);
        await view.locator('[data-action="save"]').click();
        await expect(view.locator('[data-config-status="failed"]')).toBeVisible({ timeout: 20_000 });
      }
      await expect(focused).toBeFocused({ timeout: 10_000 });
      // Smooth scroll: wait for it to settle, then the section's top is clear of the header and on screen.
      await expect
        .poll(async () => {
          const top = (await target.boundingBox())!.y;
          await page.waitForTimeout(150);
          return Math.abs((await target.boundingBox())!.y - top) < 1 ? top : Number.NaN;
        }, { timeout: 10_000 })
        .toBeGreaterThanOrEqual(headerBottom);
      expect((await focused.boundingBox())!.y, "the focused heading is on screen").toBeLessThan(viewport.height);
      expect(new URL(page.url()).hash, "no #hash in the address").toBe("");
      expect(await page.evaluate(() => history.length), "no history entry for a section").toBe(historyBefore);

      // The Save bar: Cancel and Save on one row, both inside the screen, each the element a tap at its centre reaches.
      const bar = view.locator("[data-config-save-bar]");
      const cancel = bar.locator('[data-action="cancel"]');
      const save = bar.locator('[data-action="save"]');
      const cb = (await cancel.boundingBox())!;
      const sb = (await save.boundingBox())!;
      expect(Math.abs(cb.y - sb.y), "Cancel and Save share a row").toBeLessThanOrEqual(1);
      for (const [name, box] of [["cancel", cb], ["save", sb]] as const) {
        expect(box.y + box.height, `${name} is inside the screen`).toBeLessThanOrEqual(viewport.height);
        expect(box.x + box.width, `${name} is inside the screen`).toBeLessThanOrEqual(viewport.width);
        const hit = await page.evaluate(
          ([px, py]) => document.elementFromPoint(px, py)?.closest("[data-action]")?.getAttribute("data-action") ?? null,
          [box.x + box.width / 2, box.y + box.height / 2] as const,
        );
        expect(hit, `a tap on ${name} reaches it`).toBe(name);
      }
      await expectNoHorizontalScroll(page);
    });

    test("a failed Save and open lands on the tab that refused it, with the refusal opened, on screen and focused (fix round 1 m1)", async ({ page, request }) => {
      const s = await seed(page, request);
      const [a, b, c] = s.ids;
      await page.goto(hubPath(s), { waitUntil: "load" });
      await openFromSettings(page, a);
      await halfTypeOpeningDate(page, a);
      await openFromSettings(page, b);
      await clickOpenSettings(page, c);
      await expect(dialog(page)).toBeVisible({ timeout: 20_000 });

      await dialogAction(page, "save").click();
      // The save was refused on the page: no swap. A comes on screen instead, its refusal revealed — after the dialog has
      // gone, so the dialog's own focus restore cannot take it back.
      await expect(dialog(page)).toHaveCount(0, { timeout: 20_000 });
      await expectActive(page, a);
      await expectAddress(page, { tab: `division:${a}`, open: [b, a] });
      await expect(divisionTab(page, c)).toHaveCount(0);
      await expectRefusalRevealed(page, a, viewport);
      await expect(divisionPage(page, a).locator('[data-config-status="failed"]')).toBeVisible();
    });

    test("a failed Save and close on the tab on screen keeps it, with the refusal on screen and focused, not the × (fix round 1 m1)", async ({ page, request }) => {
      const s = await seed(page, request);
      const [a] = s.ids;
      await page.goto(hubPath(s), { waitUntil: "load" });
      await openFromSettings(page, a);
      await halfTypeOpeningDate(page, a);
      await page.evaluate(() => window.scrollTo(0, 0));

      await closeButton(page, a).click();
      await dialogAction(page, "save").click();
      await expect(dialog(page)).toHaveCount(0, { timeout: 20_000 });
      await expectActive(page, a);
      await expectAddress(page, { tab: `division:${a}`, open: [a] });
      await expectRefusalRevealed(page, a, viewport);
      await expect(closeButton(page, a), "the dialog's focus restore did not win").not.toBeFocused();
      expect(await storedCapacity(request, a)).toBeNull();
    });

    test("closing the tab on screen lands on Settings where it was scrolled to (fix round 1 m4)", async ({ page, request }) => {
      // Enough divisions that the Settings list scrolls, at both widths.
      const names = Array.from({ length: 12 }, (_, i) => `Division ${String(i + 1).padStart(2, "0")}`) as Seeded["names"];
      const s = await seed(page, request, names);
      const low = s.ids[9]!;
      await page.goto(hubPath(s), { waitUntil: "load" });
      await toSettings(page);
      const row = page.locator(`[data-registration-hub-row][data-division-id="${low}"]`);
      await row.scrollIntoViewIfNeeded();
      await page.evaluate(() => window.scrollBy(0, 40));
      const before = await page.evaluate(() => window.scrollY);
      expect(before, "premise: Settings is scrolled down").toBeGreaterThan(200);

      const open = row.locator("[data-registration-hub-row-configure]");
      await waitForHydration(open);
      await open.click();
      await expectActive(page, low);
      await closeButton(page, low).click();
      await expect(sectionTab(page, "settings")).toHaveAttribute("aria-current", "page", { timeout: 20_000 });
      await expectAddress(page, { tab: "settings", open: [] });
      await expect.poll(() => page.evaluate(() => window.scrollY), { timeout: 10_000 }).toBeGreaterThan(before - 3);
      expect(Math.abs((await page.evaluate(() => window.scrollY)) - before), "Settings is back where it was").toBeLessThanOrEqual(2);
    });

    test("the tab on screen is scrolled into the strip's view — on arrival and after a scripted switch (fix round 1 m4)", async ({ page, request }) => {
      const s = await seed(page, request, ["Under-14 Girls Doubles — Saturday Morning", "Under-16 Boys Singles — Sunday Afternoon", "Mixed"]);
      const [a, b] = s.ids;
      const strip = page.getByRole("navigation", { name: copy("reg.hub.tabs.label") });
      const inside = async (tab: Locator) => {
        const [box, tabBox] = [(await strip.boundingBox())!, (await tab.boundingBox())!];
        return tabBox.x >= box.x - 1 && tabBox.x + tabBox.width <= box.x + box.width + 1;
      };
      await page.goto(hubPath(s, `?tab=division:${b}&open=${a},${b}`), { waitUntil: "load" });
      await expectActive(page, b);
      await expect.poll(() => inside(divisionTab(page, b)), { timeout: 10_000 }).toBe(true);
      // A switch the strip did not see coming (a script, a keyboard user's Enter): the strip still follows.
      await waitForHydration(sectionTab(page, "settings"));
      await sectionTab(page, "settings").evaluate((el) => (el as HTMLElement).click());
      await expect(sectionTab(page, "settings")).toHaveAttribute("aria-current", "page", { timeout: 20_000 });
      await expect.poll(() => inside(sectionTab(page, "settings")), { timeout: 10_000 }).toBe(true);
      await expectNoHorizontalScroll(page);
    });

    test("a link out of the hub with an unsaved edit asks first: Keep editing stays, Save and leave saves then goes (fix round 1 G1)", async ({ page, request }) => {
      const s = await seed(page, request);
      const [a] = s.ids;
      await page.goto(hubPath(s), { waitUntil: "load" });
      await openFromSettings(page, a);
      await editCapacity(page, a, "21");
      await afterEffects(page);
      const out = leaveLink(page);
      await expect(out).toBeVisible();
      const target = new URL(await out.evaluate((el) => (el as HTMLAnchorElement).href)).pathname;
      expect(target, "premise: the link leaves the hub").not.toBe(hubPath(s));

      await out.click();
      await expect(dialog(page)).toBeVisible({ timeout: 20_000 });
      await expect(dialog(page)).toContainText(copy("reg.hub.leave.title"));
      await expect(dialog(page).locator("[data-reg-hub-dialog-body]")).toHaveText(copy("reg.hub.leave.body.one", { names: s.names[0] }));
      expect(new URL(page.url()).pathname, "held: still on the hub").toBe(hubPath(s));
      await dialogAction(page, "dismiss").click();
      await expect(dialog(page)).toHaveCount(0);
      await expectActive(page, a);
      await expect(capacity(page, a)).toHaveValue("21");

      await out.click();
      await expect(dialog(page)).toBeVisible({ timeout: 20_000 });
      await dialogAction(page, "save").click();
      // Gone (the home link may redirect on to the org's home, so: anywhere but the hub).
      await page.waitForURL((u) => u.pathname !== hubPath(s), { timeout: 20_000 });
      await expect.poll(() => storedCapacity(request, a), { timeout: 20_000 }).toBe(21);
    });

    test("Back past the hub with an unsaved edit asks first: Keep editing stays, Discard and leave goes back (fix round 1 G1)", async ({ page, request }) => {
      const s = await seed(page, request);
      const [a] = s.ids;
      const overview = `/o/${s.orgSlug}/c/${s.compSlug}`;
      await page.goto(overview, { waitUntil: "load" });
      // Into the hub by a client navigation, so the overview is the hub's previous entry in the same document.
      const entry = page.locator("[data-registration-hub-entry]").filter({ visible: true }).first();
      await waitForHydration(entry);
      await entry.click();
      await page.waitForURL((u) => u.pathname === hubPath(s), { timeout: 20_000 });
      await openFromSettings(page, a);
      await editCapacity(page, a, "22");
      await afterEffects(page);

      // Back inside the hub: the hub's own rule (the tab is held and the close question asked).
      await page.goBack();
      await expect(dialog(page)).toContainText(copy("reg.hub.close.title", { name: s.names[0] }), { timeout: 20_000 });
      await dialogAction(page, "dismiss").click();
      await expectActive(page, a);
      await afterEffects(page);

      // Back past the hub: held, the address put back, and asked.
      await page.goBack();
      await expect(dialog(page)).toContainText(copy("reg.hub.leave.title"), { timeout: 20_000 });
      await expect.poll(() => new URL(page.url()).pathname, { timeout: 10_000 }).toBe(hubPath(s));
      await dialogAction(page, "dismiss").click();
      await expect(dialog(page)).toHaveCount(0);
      await expectActive(page, a);
      await expect(capacity(page, a), "the edit was never unmounted").toHaveValue("22");
      await afterEffects(page);

      await page.goBack();
      await expect(dialog(page)).toContainText(copy("reg.hub.leave.title"), { timeout: 20_000 });
      await dialogAction(page, "discard").click();
      await page.waitForURL((u) => u.pathname === overview, { timeout: 20_000 });
      await expect(divisionTab(page, a)).toHaveCount(0);
      expect(await storedCapacity(request, a), "the discarded 22 never reached the server").toBeNull();
    });

    test("Back while Save and leave is saving keeps that dialog busy: its choice is the only one that runs (T24 re-review n1)", async ({ page, request }) => {
      const s = await seed(page, request);
      const [a] = s.ids;
      const overview = `/o/${s.orgSlug}/c/${s.compSlug}`;
      await page.goto(overview, { waitUntil: "load" });
      // Into the hub by a client navigation, so Back has somewhere outside the hub to go.
      const entry = page.locator("[data-registration-hub-entry]").filter({ visible: true }).first();
      await waitForHydration(entry);
      await entry.click();
      await page.waitForURL((u) => u.pathname === hubPath(s), { timeout: 20_000 });
      await openFromSettings(page, a);
      await editCapacity(page, a, "23");
      await afterEffects(page);

      // The save is held at the network, so the dialog stays busy for as long as the test needs it to.
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let puts = 0;
      await page.route(`**/api/v1/divisions/${a}/registration-settings`, async (route) => {
        if (route.request().method() !== "PUT") return route.fallback();
        puts += 1;
        await held;
        await route.fallback();
      });

      await leaveLink(page).click();
      await expect(dialog(page)).toContainText(copy("reg.hub.leave.title"), { timeout: 20_000 });
      await dialogAction(page, "save").click();
      await expect(dialogAction(page, "save")).toHaveText(copy("reg.hub.config.saving"), { timeout: 20_000 });
      await expect(dialogAction(page, "save")).toBeDisabled();
      await expect.poll(() => puts, { timeout: 20_000 }).toBe(1);

      // Back mid-save: held and put back as ever, but the busy dialog is not swapped for a fresh, enabled leave question.
      await page.goBack();
      await expect.poll(() => new URL(page.url()).pathname, { timeout: 10_000 }).toBe(hubPath(s));
      await afterEffects(page);
      await expect(dialog(page)).toHaveCount(1);
      await expect(dialogAction(page, "save"), "still the save in flight").toHaveText(copy("reg.hub.config.saving"));
      for (const action of ["save", "discard", "dismiss"] as const) {
        await expect(dialogAction(page, action), `${action} stays disabled while saving`).toBeDisabled();
      }

      // The save lands: the hub goes where the chosen leave was for (the link), once, and never back to the overview.
      release();
      await page.waitForURL((u) => u.pathname !== hubPath(s), { timeout: 20_000 });
      await expect.poll(() => storedCapacity(request, a), { timeout: 20_000 }).toBe(23);
      await afterEffects(page);
      await page.waitForTimeout(500);
      const landed = new URL(page.url()).pathname;
      expect(landed, "not Back's destination").not.toBe(overview);
      expect(landed, "not the hub").not.toBe(hubPath(s));
      expect(puts, "one save").toBe(1);
    });
  });
}

// T24 re-review n2: the leave guard only prevents a link's default; the click still reaches the link's own handler. The account
// menu closes itself in its items' onClick, so with the old stopPropagation its sheet stayed open over the hub while the leave
// question opened behind it. At 390 (the phone sheet, portalled over a scrim) and at 1280 (the dropdown).
for (const viewport of [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
]) {
  test.describe(`registration hub leave guard and the account menu @${viewport.width}`, () => {
    test.use({ viewport });

    test("an account-menu link with an unsaved edit: the menu closes and the leave question is on top; Discard and leave then goes", async ({ page, request }) => {
      const s = await seed(page, request);
      const [a] = s.ids;
      await page.goto(hubPath(s), { waitUntil: "load" });
      await openFromSettings(page, a);
      await editCapacity(page, a, "24");
      await afterEffects(page);

      const trigger = page.locator('header.app-gantry [data-testid="account-menu-trigger"]');
      const menu = page.getByTestId("account-menu");
      const item = page.getByTestId("account-menu-settings");
      const openMenu = async () => {
        await waitForHydration(trigger);
        await trigger.click();
        await expect(item).toBeVisible({ timeout: 10_000 });
      };
      await openMenu();
      const target = new URL(await item.evaluate((el) => (el as HTMLAnchorElement).href)).pathname;
      expect(target, "premise: the menu item leaves the hub").not.toBe(hubPath(s));

      await item.click();
      await expect(dialog(page)).toContainText(copy("reg.hub.leave.title"), { timeout: 20_000 });
      await expect(menu, "the menu closed itself").toHaveCount(0);
      await expect(page.getByTestId("account-menu-scrim")).toHaveCount(0);
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
      expect(new URL(page.url()).pathname, "held: still on the hub").toBe(hubPath(s));
      // On top: what sits at the centre of the dialog's Keep editing is that button, nothing over it.
      const onTop = await dialogAction(page, "dismiss").evaluate((el) => {
        const r = el.getBoundingClientRect();
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return at !== null && (at === el || el.contains(at));
      });
      expect(onTop, "the leave question is on top").toBe(true);

      await dialogAction(page, "dismiss").click();
      await expect(dialog(page)).toHaveCount(0);
      await expect(capacity(page, a)).toHaveValue("24");

      // The same item again, and this time Discard and leave: the menu's own destination, the edit never saved.
      await afterEffects(page);
      await openMenu();
      await item.click();
      await expect(dialog(page)).toContainText(copy("reg.hub.leave.title"), { timeout: 20_000 });
      await expect(menu).toHaveCount(0);
      await dialogAction(page, "discard").click();
      await page.waitForURL((u) => u.pathname === target, { timeout: 20_000 });
      expect(await storedCapacity(request, a), "the discarded 24 never reached the server").toBeNull();
    });
  });
}
