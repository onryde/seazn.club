// FU1 (match-day follow-ups): registration only offers and accepts the entrant kinds its DIVISION allows.
//
// Played by hand, end to end, against a division whose Entrant kinds were narrowed AFTER its registration was set up -
// the one state the settings save can no longer produce, and exactly the one an organiser lands in by changing the
// division's Entrants tab. Before FU1 nothing compared the two: the public page took team entries for a division that no
// longer held teams.
//
// The seam is driven through its REAL producer and consumer, not a fixture on both ends: the division's kinds are
// narrowed through the Entrants door (PATCH config.entrants), and every assertion reads what a person sees -
//   1. the public register page: the division's card says entries are unavailable and offers no Add control;
//   2. the organiser's registration hub: the row is flagged, and the config panel keeps the stored kind selected but
//      marked not allowed, offers only the kinds the division takes, and refuses the save on the page (no PUT);
//   3. picking an offered kind saves, the flag goes, and the public card opens with that kind's Add control.
// Every changed screen is shot at 1280 / 768 / 320 with no horizontal page scroll; the entrant-type select keeps a 44px
// target at each width.
//
// Setup uses the API to REACH that state (the walkthrough charter permits it); the fix is made through the UI.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { activeOrg, apiJson, expectNoHorizontalScroll, screenshotAtWidths, TAG } from "../helpers";
import { routes } from "../../src/lib/routes";

const GENERIC_CONFIG = { points: { w: 3, d: 1, l: 0 }, progressScore: false };
const WIDTHS = [1280, 768, 320];

/** Copy read from the dictionary the page renders from, never retyped here. */
const UI_EN: Record<string, string> = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
);
function ui(key: string, vars: Record<string, string> = {}): string {
  const raw = UI_EN[key];
  if (raw === undefined) throw new Error(`missing en ui dictionary key: ${key}`);
  return Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), raw);
}

test.describe.configure({ mode: "serial" });

/** Open a division's row-click config panel and wait past its own async GET. Returns the dialog (its Save button is a
 *  sibling of the content div, not a descendant). Same selectors as registration-hub.spec.ts, re-declared because the
 *  walkthrough project refuses a spec importing a spec. */
async function openConfigPanel(page: Page, divisionId: string): Promise<Locator> {
  const row = page.locator(`[data-registration-hub-row][data-division-id="${divisionId}"]`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.locator("[data-registration-hub-row-configure]").click();
  const content = page.locator(`[data-registration-hub-config-panel][data-division-id="${divisionId}"]`);
  await expect(content).toBeVisible({ timeout: 20_000 });
  await expect(content.locator('[data-field="entrant_kind"]')).toBeVisible({ timeout: 20_000 });
  return page.getByRole("dialog").filter({ has: content });
}

/** The entrant-type select's options as the browser holds them: value, label, disabled. */
async function optionsOf(select: Locator): Promise<{ value: string; label: string; disabled: boolean }[]> {
  return select.locator("option").evaluateAll((els) =>
    els.map((o) => ({
      value: (o as HTMLOptionElement).value,
      label: (o.textContent ?? "").trim(),
      disabled: (o as HTMLOptionElement).disabled,
    })),
  );
}

test("a division narrowed after its registration was set up: the public card closes, the hub flags it, and picking an allowed kind reopens it", async ({
  page,
  request,
  browser,
}, testInfo) => {
  test.setTimeout(240_000);

  // ---------------------------------------------------------------- setup
  const org = await activeOrg(page);
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    name: `Kinds Cup ${TAG}`,
    visibility: "public",
    ends_on: "2030-12-31",
  });
  expect(comp.status, JSON.stringify(comp.error)).toBeLessThan(300);

  const mkDivision = async (name: string) => {
    const d = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
      name,
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
    });
    expect(d.status, JSON.stringify(d.error)).toBeLessThan(300);
    return d.data!.id;
  };
  // Two ordinary open divisions beside the narrowed one: the public stepper shows its division cards only when more than
  // one division is open (a single open division collapses that step and auto-seeds its entry, hiding every closed
  // card), and the hub gets rows that must NOT be flagged.
  const openId = await mkDivision(`Open Singles ${TAG}`);
  const pairsId = await mkDivision(`Open Doubles ${TAG}`);
  const narrowedId = await mkDivision(`Club Teams ${TAG}`);
  for (const [id, kind] of [
    [openId, "individual"],
    [pairsId, "pair"],
    [narrowedId, "team"],
  ] as const) {
    const s = await apiJson(request, `/api/v1/divisions/${id}/registration-settings`, "PUT", {
      enabled: true,
      entrant_kind: kind,
      capacity: 10,
      fee_cents: 0,
      form_fields: [],
    });
    expect(s.status, `${kind}: ${JSON.stringify(s.error)}`).toBeLessThan(300);
  }
  // The organiser narrows the division on its Entrants tab: individuals only. Its registration still says team.
  const narrowed = await apiJson(request, `/api/v1/divisions/${narrowedId}`, "PATCH", {
    config: { ...GENERIC_CONFIG, entrants: { kinds: ["individual"], defaultKind: "individual" } },
  });
  expect(narrowed.status, JSON.stringify(narrowed.error)).toBeLessThan(300);
  // The save door itself now refuses the stale kind by name (the server half of the panel's client gate).
  const refused = await apiJson(request, `/api/v1/divisions/${narrowedId}/registration-settings`, "PUT", {
    enabled: true,
    entrant_kind: "team",
    capacity: 10,
    fee_cents: 0,
    form_fields: [],
  });
  expect(refused.status).toBe(422);
  expect(JSON.stringify(refused.error)).toContain("ENTRANT_KIND_NOT_ALLOWED");

  const registerUrl = routes.publicRegister(org.slug, comp.data!.slug);
  // A registrant is not logged in: the public page is driven from a context with no auth state.
  const anonCtx = await browser.newContext();
  let anon = await anonCtx.newPage();
  const pageErrors: string[] = [];

  /** Step 1 (who), then the entries step where the division cards live. A FRESH tab per visit: the stepper keeps its
   *  draft, step included, in sessionStorage (per tab), so a reload in the same tab resumes past step 1. */
  const toEntries = async () => {
    await anon.close();
    anon = await anonCtx.newPage();
    anon.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 200)));
    await anon.goto(registerUrl, { waitUntil: "load" });
    await anon.getByRole("button", { name: /^accept$/i }).click({ timeout: 3000 }).catch(() => {});
    await anon.locator("#reg-who-name").fill(`Kinds Visitor ${TAG}`, { timeout: 20_000 });
    await anon.locator("#reg-who-email").fill(`delivered+kinds-${TAG}@resend.dev`, { timeout: 20_000 });
    await anon.getByRole("button", { name: /^next$/i }).click({ timeout: 20_000 });
  };
  // The card is the INNERMOST rounded box holding the division's heading (the step's own panel is one too).
  const cardOf = (name: string) =>
    anon.locator("div.rounded-xl").filter({ has: anon.getByRole("heading", { name, exact: true }) }).last();

  try {
    // ------------------------------------------- 1. the public page, before the fix
    await toEntries();
    const closedCard = cardOf(`Club Teams ${TAG}`);
    await expect(closedCard).toBeVisible({ timeout: 20_000 });
    await expect(closedCard.getByText(ui("register.entries.badge.kindUnavailable"), { exact: true })).toBeVisible();
    // Closed for its kind, not for its window: no window-closed badge, and no Add control of any kind.
    await expect(closedCard.getByText(ui("register.entries.badge.closed"), { exact: true })).toHaveCount(0);
    await expect(closedCard.getByRole("button")).toHaveCount(0);
    // Positive pair: the ordinary division beside it opens, with its Add control.
    const openCard = cardOf(`Open Singles ${TAG}`);
    await expect(openCard.getByRole("button", { name: ui("register.entries.add.individual") })).toBeVisible();
    await expect(openCard.getByText(ui("register.entries.badge.kindUnavailable"), { exact: true })).toHaveCount(0);
    await screenshotAtWidths(anon, testInfo, "01-public-entries-unavailable", WIDTHS, async (p) => {
      await expect(closedCard.getByText(ui("register.entries.badge.kindUnavailable"), { exact: true })).toBeVisible();
      await expectNoHorizontalScroll(p);
    });

    // ------------------------------------------- 2. the organiser's hub, before the fix
    await page.goto(routes.competitionRegistration(org.slug, comp.data!.slug), { waitUntil: "load" });
    const flagOf = (id: string) =>
      page.locator(`[data-registration-hub-row][data-division-id="${id}"] [data-testid="row-kind-not-allowed"]`);
    await expect(flagOf(narrowedId)).toHaveText(ui("reg.hub.row.kindNotAllowed"), { timeout: 20_000 });
    await expect(flagOf(openId)).toHaveCount(0);
    await expect(flagOf(pairsId)).toHaveCount(0);
    await screenshotAtWidths(page, testInfo, "02-hub-row-flagged", WIDTHS, async (p) => {
      await expect(flagOf(narrowedId)).toBeVisible();
      await expectNoHorizontalScroll(p);
    });

    const panel = await openConfigPanel(page, narrowedId);
    const select = panel.locator('[data-field="entrant_kind"]');
    const teamName = ui("divset.entrants.kind.team");
    // The stored kind stays selected - never silently swapped - but is marked not allowed and cannot be picked again;
    // the only choice offered is the kind the division takes.
    await expect(select).toHaveValue("team");
    expect(await optionsOf(select)).toEqual([
      { value: "team", label: ui("reg.settings.entrant.notAllowedOption", { kind: teamName }), disabled: true },
      { value: "individual", label: ui("reg.settings.entrant.individual"), disabled: false },
    ]);
    const hint = panel.getByTestId("entrant-kind-not-allowed");
    await expect(hint).toHaveText(ui("reg.settings.entrant.notAllowedHint", { kind: teamName }));
    await screenshotAtWidths(page, testInfo, "03-panel-kind-not-allowed", WIDTHS, async (p) => {
      await hint.scrollIntoViewIfNeeded();
      await expect(hint).toBeVisible();
      await expectNoHorizontalScroll(p);
      const box = await select.boundingBox();
      expect(box, "the entrant-type select has a box").not.toBeNull();
      expect(box!.height, `entrant-type select height at ${p.viewportSize()?.width}px`).toBeGreaterThanOrEqual(44);
    });

    // The save is stopped on the page: no PUT leaves, and the reason sits on the entrant type.
    let puts = 0;
    page.on("request", (req) => {
      if (req.method() === "PUT" && req.url().includes(`/divisions/${narrowedId}/registration-settings`)) puts += 1;
    });
    await panel.locator('[data-action="save"]').click();
    const fieldError = panel.locator('[data-field-error="entrant_kind"]');
    await expect(fieldError).toHaveText(ui("reg.settings.entrant.notAllowedError"));
    expect(puts, "a save of a kind the division does not take must not reach the server").toBe(0);
    await screenshotAtWidths(page, testInfo, "04-panel-save-refused", WIDTHS, async (p) => {
      await fieldError.scrollIntoViewIfNeeded();
      await expectNoHorizontalScroll(p);
    });

    // ------------------------------------------- 3. the fix: pick the kind the division takes, save
    await select.selectOption("individual");
    await expect(hint).toHaveCount(0);
    await panel.locator('[data-action="save"]').click();
    await expect.poll(() => puts, { timeout: 20_000 }).toBe(1);
    await expect(page.locator(`[data-registration-hub-config-panel][data-division-id="${narrowedId}"]`)).toHaveCount(0, {
      timeout: 20_000,
    });
    const saved = await apiJson<{ entrant_kind: string }>(request, `/api/v1/divisions/${narrowedId}/registration-settings`, "GET");
    expect(saved.data?.entrant_kind).toBe("individual");
    await expect(flagOf(narrowedId)).toHaveCount(0, { timeout: 20_000 });

    // The public card opens, offering the kind the division takes.
    await toEntries();
    const reopened = cardOf(`Club Teams ${TAG}`);
    await expect(reopened.getByRole("button", { name: ui("register.entries.add.individual") })).toBeVisible({ timeout: 20_000 });
    await expect(reopened.getByText(ui("register.entries.badge.kindUnavailable"), { exact: true })).toHaveCount(0);
    expect(pageErrors, "the public page threw").toEqual([]);
  } finally {
    await anonCtx.close();
  }
});
