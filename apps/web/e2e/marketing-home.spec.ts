import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// The home page redirects signed-in users to /dashboard — run signed out.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe("marketing home (design/v3/12)", () => {
  test("default draw renders without any interaction", async ({ page }) => {
    await page.goto("/");
    const draw = page.locator("#the-draw");
    await expect(draw.locator("svg[role=img]")).toBeVisible();
    await expect(draw.getByText("GROUP STAGE")).toBeVisible();
    await expect(draw.getByText("QUALIFIERS ADVANCE ↓")).toBeVisible();
    await expect(draw.getByText("🏆")).toBeVisible();
  });

  test("format switch redraws via the public API", async ({ page }) => {
    await page.goto("/");
    const api = page.waitForResponse("**/api/public/format-preview");
    await page.getByRole("radio", { name: "League", exact: true }).click();
    expect((await api).status()).toBe(200);
    await expect(page.locator("#the-draw").getByText("Everyone plays everyone")).toBeVisible();
  });

  test("Make it real carries choices into /start", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("make-it-real").click();
    await expect(page).toHaveURL(/\/start\?sport=Football&entrants=8&format=groups-knockout/);
  });

  // The hero's one primary since owner 2026-11-13 (Option A): a Sport select over the quick match offer and "Start a quick
  // match", a GET to /<lang>/play?sport=<key> that opens the setup on that sport. The option is read off the select, the
  // offer as the page renders it, never typed here; the SECOND one, so a preselect differs from /play's own default.
  async function pickSecondSport(page: Page): Promise<string> {
    const select = page.getByTestId("qm-cta-form").locator('select[name="sport"]');
    await expect(select).toBeVisible();
    const values = await select.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
    expect(values.length, "the hero offers at least two sports").toBeGreaterThanOrEqual(2);
    await select.selectOption(values[1]!);
    return values[1]!;
  }

  test("hero quick match start opens /play on the chosen sport", async ({ page }) => {
    await page.goto("/en");
    const sport = await pickSecondSport(page);
    await page.getByTestId("qm-cta-form").getByRole("button", { name: "Start a quick match →" }).click();
    await page.waitForURL((url) => url.pathname === "/en/play" && url.searchParams.get("sport") === sport);
    const chip = page.getByTestId("qm-setup-form").locator(`input[name="sport_key"][value="${sport}"]`);
    await expect(chip).toBeChecked();
    // The organiser's funnel left the hero: no entrants, no date, no Setup button on the home any more.
    await page.goto("/en");
    await expect(page.getByTestId("qm-cta-form")).toBeVisible();
    await expect(page.locator("form[data-start-funnel]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Setup →" })).toHaveCount(0);
  });

  test("hero quick match start works without JavaScript (a plain GET form)", async ({ browser }) => {
    const ctx = await browser.newContext({ javaScriptEnabled: false, storageState: { cookies: [], origins: [] } });
    const page = await ctx.newPage();
    try {
      await page.goto("/en");
      const sport = await pickSecondSport(page);
      await page.getByTestId("qm-cta-form").getByRole("button", { name: "Start a quick match →" }).click();
      await page.waitForURL((url) => url.pathname === "/en/play" && url.searchParams.get("sport") === sport);
      // The server's HTML alone opens on it: the chip is written checked, no script ran.
      await expect(page.getByTestId("qm-setup-form").locator(`input[name="sport_key"][value="${sport}"]`)).toBeChecked();
    } finally {
      await ctx.close();
    }
  });

  // Owner 2026-11-13: the hero's art follows the Sport select, one scene per sport the quick match offers. The sports are
  // read off the select as the page renders the offer, never typed here; the art is the vignette's `data-sport` box.
  async function offeredSports(page: Page): Promise<string[]> {
    const select = page.getByTestId("qm-cta-form").locator('select[name="sport"]');
    await expect(select).toBeVisible();
    const values = await select.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
    expect(values.length, "the hero offers at least two sports").toBeGreaterThanOrEqual(2);
    return values;
  }
  const runningAnimations = (page: Page) =>
    page
      .getByTestId("vignette-run")
      .evaluate((el) => el.getAnimations({ subtree: true }).filter((a) => a.playState === "running").length);

  test("the hero art follows the Sport select, one named scene per offered sport, each played on a pick", async ({ page }) => {
    await page.goto("/en");
    const sports = await offeredSports(page);
    const select = page.getByTestId("qm-cta-form").locator('select[name="sport"]');
    const art = page.locator("[data-sport]");
    // The server draws the sport the select opens on.
    await expect(art).toHaveAttribute("data-sport", sports[0]!);
    const names = new Set<string>();
    for (const sport of [...sports.slice(1), sports[0]!]) {
      await select.selectOption(sport);
      await expect(art).toHaveAttribute("data-sport", sport);
      names.add((await art.locator("svg[role=img]").getAttribute("aria-label")) ?? "");
      // A pick plays its scene at once: the object is in flight, not resting on the last sport's final frame.
      expect(await runningAnimations(page), `${sport} plays on the pick`).toBeGreaterThan(0);
    }
    expect([...names].filter(Boolean).length, "each sport's scene has its own accessible name").toBe(sports.length);
  });

  test("reduced motion: a picked sport shows its final frame and plays nothing", async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: "reduce", storageState: { cookies: [], origins: [] } });
    const page = await ctx.newPage();
    try {
      await page.goto("/en");
      const sports = await offeredSports(page);
      await page.getByTestId("qm-cta-form").locator('select[name="sport"]').selectOption(sports[1]!);
      await expect(page.locator("[data-sport]")).toHaveAttribute("data-sport", sports[1]!);
      expect(await runningAnimations(page), "nothing moves under reduced motion").toBe(0);
      // The final frame: the object rests where it lands, not at its starting point.
      const ball = page.getByTestId("vignette-run").locator(".mk-ball").first();
      expect(await ball.evaluate((el) => getComputedStyle(el).transform)).not.toBe("none");
      await expect(page.getByTestId("scorebug")).not.toHaveText(/^\s*LIVE\s*$/);
    } finally {
      await ctx.close();
    }
  });

  test("the organiser's setup is one link below the Start, to the /start wizard", async ({ page }) => {
    await page.goto("/en");
    const link = page.getByTestId("hero-event-link");
    await expect(link).toHaveText("Running a full league or tournament? Set up an event →");
    const box = await link.boundingBox();
    expect(box?.height ?? 0, "a 44px tap target").toBeGreaterThanOrEqual(44);
    await link.click();
    await page.waitForURL((url) => url.pathname === "/en/start");
    await expect(page.getByRole("heading", { name: "Start your competition" })).toBeVisible();
  });

  test("nav flips from night to solid after the hero", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("[data-mk-nav]")).toHaveClass(/mk-nav-night/);
    await page.locator("#the-draw").scrollIntoViewIfNeeded();
    await expect(page.locator("[data-mk-nav]")).toHaveClass(/mk-nav-solid/);
  });

  test("reveal system fires on scroll (mk-in lands once)", async ({ page }) => {
    await page.goto("/");
    await page.locator("#the-draw").scrollIntoViewIfNeeded();
    await expect(page.locator("#the-draw .mk-reveal.mk-in").first()).toBeVisible();
  });

  test("reduced motion renders end states", async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: "reduce" });
    const page = await ctx.newPage();
    await page.goto("/");
    await expect(page.getByTestId("scorebug")).toBeVisible();
    await expect(page.locator("#the-draw").getByText("GROUP STAGE")).toBeVisible();
    await ctx.close();
  });

  test("floodlit finale renders the three ticket stubs", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Pick your season" })).toBeVisible();
    for (const tier of ["Community", "Event Pass", "Pro"]) {
      await expect(page.getByText(tier, { exact: true }).first()).toBeVisible();
    }
    await expect(page.getByRole("link", { name: "Start your tournament →" })).toBeVisible();
  });

  test("axe: no serious/critical violations on / (v3/11 gap 11)", async ({ page }) => {
    await page.goto("/", { waitUntil: "load" });
    await page.waitForTimeout(400);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    const blocking = results.violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    );
    expect(blocking.map((v) => `${v.id} — ${v.nodes[0]?.html}`)).toEqual([]);
  });
});
