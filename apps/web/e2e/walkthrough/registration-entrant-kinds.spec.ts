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
//   2. the organiser's registration hub: the row is flagged and reads Closed with no Copy/Open/QR (fix round 1, m1), and
//      the config panel keeps the stored kind selected but marked not allowed, offers only the kinds the division takes,
//      and refuses the save on the page (no PUT);
//   3. picking an offered kind saves, the flag goes, the row reads Open with its link again, and the public card opens
//      with that kind's Add control.
// Every changed screen is shot at 1280 / 768 / 320 with no horizontal page scroll; the entrant-type select keeps a 44px
// target at each width. A second test (fix rounds 1-2, m6) MEASURES, in a real browser, that every option of the select
// fits at 320 in every locale. A third (fix round 1, I1) drives the narrowing guard through its real producer
// and consumer: the Entrants tab's Save, refused while a live registration holds the kind, said in the reader's language.
//
// Setup uses the API to REACH that state (the walkthrough charter permits it); the fix is made through the UI.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { activeOrg, apiJson, expectNoHorizontalScroll, screenshotAtWidths, TAG } from "../helpers";
import { routes } from "../../src/lib/routes";

const GENERIC_CONFIG = { points: { w: 3, d: 1, l: 0 }, progressScore: false };
const WIDTHS = [1280, 768, 320];

/** Copy read from the dictionary the page renders from, never retyped here. */
const LOCALES = ["en", "es", "fr", "nl"] as const;
const UI: Record<(typeof LOCALES)[number], Record<string, string>> = Object.fromEntries(
  LOCALES.map((loc) => [
    loc,
    JSON.parse(readFileSync(fileURLToPath(new URL(`../../src/dictionaries/${loc}/ui.json`, import.meta.url)), "utf8")),
  ]),
) as never;
function uiIn(loc: (typeof LOCALES)[number], key: string, vars: Record<string, string> = {}): string {
  const raw = UI[loc][key];
  if (raw === undefined) throw new Error(`missing ${loc} ui dictionary key: ${key}`);
  return Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), raw);
}
const ui = (key: string, vars: Record<string, string> = {}) => uiIn("en", key, vars);

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
    const rowOf = (id: string) => page.locator(`[data-registration-hub-row][data-division-id="${id}"]`);
    const flagOf = (id: string) => rowOf(id).locator('[data-testid="row-kind-not-allowed"]');
    const statusOf = (id: string) => rowOf(id).locator("[data-registration-hub-status]");
    // The register link's readonly field - CopyLink's Copy/Open/QR row is present exactly when it is.
    const linkOf = (id: string) => rowOf(id).locator("input[readonly]");
    await expect(flagOf(narrowedId)).toHaveText(ui("reg.hub.row.kindNotAllowed"), { timeout: 20_000 });
    await expect(flagOf(openId)).toHaveCount(0);
    await expect(flagOf(pairsId)).toHaveCount(0);
    // m1: the row says what the public meets - Closed, and no link to share - while its window is open; the rows beside it
    // (the positive pair) say Open now and keep their link.
    await expect(statusOf(narrowedId)).toHaveAttribute("data-registration-hub-status", "closed");
    await expect(statusOf(narrowedId)).toHaveText(ui("reg.hub.row.status.closed"));
    await expect(linkOf(narrowedId)).toHaveCount(0);
    for (const id of [openId, pairsId]) {
      await expect(statusOf(id)).toHaveText(ui("reg.hub.row.status.open"));
      await expect(linkOf(id)).toHaveCount(1);
    }
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
    // Fix round 1 (m6): the refused option shows the kind's own word; its accessible name carries "(not allowed)".
    expect(await optionsOf(select)).toEqual([
      { value: "team", label: teamName, disabled: true },
      { value: "individual", label: ui("reg.settings.entrant.individual"), disabled: false },
    ]);
    await expect(select.locator('option[value="team"]')).toHaveAttribute(
      "aria-label",
      ui("reg.settings.entrant.notAllowedOption", { kind: teamName }),
    );
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
    await expect(statusOf(narrowedId)).toHaveText(ui("reg.hub.row.status.open"), { timeout: 20_000 });
    await expect(linkOf(narrowedId)).toHaveCount(1);

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

// Fix round 1 (m6) and fix round 2: EVERY option of the entrant-type select must show its text whole at 320, in every
// locale. A select cannot wrap, and a clipped value is what the organiser reads. The review first ESTIMATED this from a
// screenshot; it is measured here instead, in the browser that draws it. A width:auto clone of the select, holding only
// the option, asks the browser how wide the control must be to show that text whole (arrow, padding and border
// included). That width is held against the select's own width.
// Two selects cover every option label there is:
//   - a teams-only division storing individual: the refused option (the kind's word) plus Team;
//   - an all-kinds division: Individual, Team and Pair.
// Measured before the fixes, at a 202px select: "{kind} (not allowed)" needed 219-259px and "Individual (creates a
// player)" needed 239-302px, in all four locales. Every measurement is written to fit.json.
test("every entrant-type option fits the select at 320 in every locale, measured in the browser", async ({ page, request }, testInfo) => {
  test.setTimeout(240_000);
  const org = await activeOrg(page);
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    name: `Kinds Fit ${TAG}`,
    visibility: "public",
    ends_on: "2030-12-31",
  });
  expect(comp.status, JSON.stringify(comp.error)).toBeLessThan(300);
  const mkDivision = async (name: string, entrants: { kinds: string[]; defaultKind: string } | null) => {
    const d = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
      name,
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
    });
    expect(d.status, JSON.stringify(d.error)).toBeLessThan(300);
    const put = await apiJson(request, `/api/v1/divisions/${d.data!.id}/registration-settings`, "PUT", {
      enabled: true,
      entrant_kind: "individual",
      capacity: 10,
      fee_cents: 0,
      form_fields: [],
    });
    expect(put.status, JSON.stringify(put.error)).toBeLessThan(300);
    if (entrants) {
      // No registration yet, so the narrowing door allows it (I1 refuses only under live registrations).
      const narrowed = await apiJson(request, `/api/v1/divisions/${d.data!.id}`, "PATCH", {
        config: { ...GENERIC_CONFIG, entrants },
      });
      expect(narrowed.status, JSON.stringify(narrowed.error)).toBeLessThan(300);
    }
    return d.data!.id;
  };
  const refusedId = await mkDivision(`Squads ${TAG}`, { kinds: ["team"], defaultKind: "team" });
  const allKindsId = await mkDivision(`Everyone ${TAG}`, null);
  /** The option labels each select must show, from the locale's dictionary - never from the page. */
  const expectedLabels = (loc: (typeof LOCALES)[number]) => ({
    [refusedId]: [uiIn(loc, "divset.entrants.kind.individual"), uiIn(loc, "reg.settings.entrant.team")],
    [allKindsId]: ["individual", "team", "pair"].map((k) => uiIn(loc, `reg.settings.entrant.${k}`)),
  });

  const origin = new URL((testInfo.project.use.baseURL as string | undefined) ?? process.env.PLAYWRIGHT_BASE ?? "http://localhost:3000").origin;
  await page.setViewportSize({ width: 320, height: 800 });
  const fits: { locale: string; division: string; text: string; need: number; have: number }[] = [];
  let measuredOptions = 0;
  try {
    for (const loc of LOCALES) {
      // `seazn_locale` is the explicit switcher pick and outranks the user's and the org's locale.
      await page.context().addCookies([{ name: "seazn_locale", value: loc, url: origin }]);
      for (const id of [refusedId, allKindsId]) {
        await page.goto(routes.competitionRegistration(org.slug, comp.data!.slug), { waitUntil: "load" });
        const panel = await openConfigPanel(page, id);
        const select = panel.locator('[data-field="entrant_kind"]');
        await expect(select).toHaveValue("individual");
        const measured = await select.evaluate((el) => {
          const sel = el as HTMLSelectElement;
          const have = sel.getBoundingClientRect().width;
          return Array.from(sel.options).map((opt) => {
            const text = (opt.textContent ?? "").trim();
            const probe = sel.cloneNode(false) as HTMLSelectElement;
            const only = document.createElement("option");
            only.textContent = text;
            probe.appendChild(only);
            probe.style.cssText += ";width:auto;min-width:0;max-width:none;position:absolute;left:0;top:0;visibility:hidden";
            sel.parentElement!.appendChild(probe);
            const need = probe.getBoundingClientRect().width;
            probe.remove();
            return { text, need, have };
          });
        });
        const label = id === refusedId ? "refused" : "all-kinds";
        expect(measured.map((m) => m.text), `${loc} ${label}: the options are the dictionary's`).toEqual(expectedLabels(loc)[id]);
        for (const m of measured) {
          fits.push({ locale: loc, division: label, ...m });
          expect.soft(m.need, `${loc} ${label} "${m.text}" needs ${m.need}px; the select is ${m.have}px`).toBeLessThanOrEqual(m.have);
          measuredOptions++;
        }
        const box = await select.boundingBox();
        expect(box!.height, `${loc} ${label}: the 44px target`).toBeGreaterThanOrEqual(44);
        await expectNoHorizontalScroll(page);
        if (id === refusedId) {
          const hint = panel.getByTestId("entrant-kind-not-allowed");
          await expect(hint).toHaveText(uiIn(loc, "reg.settings.entrant.notAllowedHint", { kind: uiIn(loc, "divset.entrants.kind.individual") }));
          // The hint DESCRIBES the select and marks it invalid (fix round 2), read off the live DOM.
          await expect(select).toHaveAttribute("aria-invalid", "true");
          await expect(select).toHaveAttribute("aria-describedby", (await hint.getAttribute("id"))!);
          await hint.scrollIntoViewIfNeeded();
        } else {
          await expect(select).not.toHaveAttribute("aria-invalid", /.*/);
          await select.scrollIntoViewIfNeeded();
        }
        await page.screenshot({ path: `${testInfo.outputPath()}/05-panel-${label}-${loc}-320.png` });
      }
    }
  } finally {
    await page.context().clearCookies({ name: "seazn_locale" });
    writeFileSync(`${testInfo.outputPath()}/fit.json`, JSON.stringify(fits, null, 1));
  }
  // Anti-vacuity: 4 locales x (2 + 3) options, every one measured.
  expect(measuredOptions, "every option in every locale measured").toBe(LOCALES.length * 5);
});

// Fix round 1 (I1, owner 2026-11-04; m2): a pending team registration holds "team", so the Entrants tab may not take team
// out. The refusal travels server -> route -> client error -> the tab's reader, and the organiser reads it in their own
// language with the kind and the count - never the server's English. Withdrawing the entry lets the SAME save land.
test("the Entrants tab refuses to take out a kind a live registration holds, in the organiser's language, and saves once it is withdrawn", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(180_000);
  const org = await activeOrg(page);
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    name: `Kinds Guard ${TAG}`,
    visibility: "public",
    ends_on: "2030-12-31",
  });
  expect(comp.status, JSON.stringify(comp.error)).toBeLessThan(300);
  const div = await apiJson<{ id: string; slug: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: `Guarded Teams ${TAG}`,
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  expect(div.status, JSON.stringify(div.error)).toBeLessThan(300);
  const put = await apiJson(request, `/api/v1/divisions/${div.data!.id}/registration-settings`, "PUT", {
    enabled: true,
    entrant_kind: "team",
    approval: "manual",
    capacity: 10,
    fee_cents: 0,
    form_fields: [],
  });
  expect(put.status, JSON.stringify(put.error)).toBeLessThan(300);
  // A real public sign-up (reach, not the thing under test): manual approval leaves it pending, with no entrant.
  const entry = await apiJson<{ entries: { registration_id: string; status: string }[] }>(
    request,
    `/api/v1/public/orgs/${org.slug}/competitions/${comp.data!.slug}/register`,
    "POST",
    {
      contact: { name: `Guard Captain ${TAG}`, email: `delivered+kinds-guard-${TAG}@resend.dev` },
      privacy_consent: true,
      entries: [
        {
          division_id: div.data!.id,
          entrant_kind: "team",
          team_name: `Guard FC ${TAG}`,
          players: [{ full_name: `Guard Captain ${TAG}` }],
          answers: {},
        },
      ],
    },
  );
  expect(entry.status, JSON.stringify(entry.error)).toBeLessThan(300);
  expect(entry.data!.entries[0]!.status, "premise: the entry is live and unseated").toBe("pending");

  const origin = new URL((testInfo.project.use.baseURL as string | undefined) ?? process.env.PLAYWRIGHT_BASE ?? "http://localhost:3000").origin;
  const entrantsUrl = `/o/${org.slug}/c/${comp.data!.slug}/d/${div.data!.slug}?tab=entrants`;
  /** Open the folded Entrant kinds block, untick team, Save. */
  const untickTeamAndSave = async (loc: (typeof LOCALES)[number]) => {
    await page.goto(entrantsUrl, { waitUntil: "load" });
    const title = uiIn(loc, "divset.entrants.kinds").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    await page.getByRole("button", { name: new RegExp(`^${title}`) }).click({ timeout: 20_000 });
    const block = page.getByTestId("entrant-kinds");
    await expect(block).toBeVisible();
    const team = block.locator('[data-kind="team"]');
    await expect(team).toHaveAttribute("aria-pressed", "true");
    await team.click();
    await expect(team).toHaveAttribute("aria-pressed", "false");
    await block.getByRole("button", { name: uiIn(loc, "divset.entrants.save"), exact: true }).click();
  };
  const refusalIn = (loc: (typeof LOCALES)[number]) =>
    uiIn(loc, "divset.err.registrationKindInUse.one", { kind: uiIn(loc, "divset.entrants.kind.team").toLocaleLowerCase() });

  let refusals = 0;
  try {
    for (const loc of ["en", "fr"] as const) {
      await page.context().addCookies([{ name: "seazn_locale", value: loc, url: origin }]);
      await untickTeamAndSave(loc);
      const error = page.getByTestId("entrant-kinds-error");
      await expect(error).toHaveText(refusalIn(loc), { timeout: 20_000 });
      await expect(error, `${loc}: not the server's English`).not.toContainText("live registration(s)");
      await expect(page.getByTestId("entrant-kinds-notice")).toHaveCount(0);
      if (loc === "en") {
        await screenshotAtWidths(page, testInfo, "06-entrants-tab-kind-in-use", WIDTHS, async (p) => {
          await error.scrollIntoViewIfNeeded();
          await expect(error).toBeVisible();
          await expectNoHorizontalScroll(p);
        });
      }
      refusals++;
    }
  } finally {
    await page.context().clearCookies({ name: "seazn_locale" });
  }
  expect(refusals).toBe(2);
  // Nothing was written: the division still takes team.
  const stored = await apiJson<{ config: { entrants?: unknown } }>(request, `/api/v1/divisions/${div.data!.id}`, "GET");
  expect(stored.data?.config.entrants, "a refused save writes no override").toBeUndefined();

  // The organiser does what the sentence says - withdraws the entry - and the same save lands.
  const withdrawn = await apiJson(request, `/api/v1/registrations/${entry.data!.entries[0]!.registration_id}/withdraw`, "POST", {});
  expect(withdrawn.status, JSON.stringify(withdrawn.error)).toBeLessThan(300);
  await untickTeamAndSave("en");
  await expect(page.getByTestId("entrant-kinds-notice")).toHaveText(ui("divset.entrants.saved"), { timeout: 20_000 });
  await expect(page.getByTestId("entrant-kinds-error")).toHaveCount(0);
  const after = await apiJson<{ config: { entrants?: { kinds: string[] } } }>(request, `/api/v1/divisions/${div.data!.id}`, "GET");
  expect(after.data?.config.entrants?.kinds).not.toContain("team");
});
