import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { HERO_AUTO_PLAYS, heroScoreText, type HeroSceneKey } from "../src/components/marketing/hero-scenes";
import { waitForHydration } from "./directory-kit";

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
  /** Every animation in the art, by its play state. */
  const playStates = (page: Page) =>
    page.getByTestId("vignette-run").evaluate((el) => el.getAnimations({ subtree: true }).map((a) => a.playState));
  /** The scorebug's score (the chip's last span; LIVE and its dot come first). */
  const scoreOf = (page: Page) => page.getByTestId("scorebug").locator("span").last();
  /** The scene's object, read off the page: its own toss and fly (the landing animation), where it is drawn now, and where
   *  the scene lands it (the run's `--mk-land`). */
  const flight = (page: Page) =>
    page.getByTestId("vignette-run").evaluate((run) => {
      const ball = run.querySelector(".mk-ball");
      if (!ball) throw new Error("no .mk-ball in the art");
      const own = ball
        .getAnimations()
        .filter((a): a is CSSAnimation => a instanceof CSSAnimation && /^mk-ball-(toss|fly)$/.test(a.animationName));
      const fly = own.find((a) => a.animationName === "mk-ball-fly");
      const m = new DOMMatrixReadOnly(getComputedStyle(ball).transform);
      const land = getComputedStyle(run).getPropertyValue("--mk-land").split(",").map((v) => parseFloat(v));
      return {
        names: own.map((a) => a.animationName).sort(),
        flyAt: fly ? Number(fly.currentTime) : null,
        flyState: fly?.playState ?? null,
        at: [m.e, m.f],
        land,
      };
    });
  const landed = (f: { at: number[]; land: number[] }) => Math.hypot(f.at[0]! - f.land[0]!, f.at[1]! - f.land[1]!) < 0.75;

  test("the hero art follows the Sport select: each pick plays its own scene from the start, lands it and moves its score", async ({ page }) => {
    await page.goto("/en");
    const sports = await offeredSports(page);
    // The budget is the landings it waits out (one per pick), not a flat guess (AGENTS.md #20).
    test.setTimeout(30_000 + sports.length * 6_000);
    const select = page.getByTestId("qm-cta-form").locator('select[name="sport"]');
    const art = page.locator("[data-sport]");
    // The server draws the sport the select opens on.
    await expect(art).toHaveAttribute("data-sport", sports[0]!);
    const names = new Set<string>();
    let played = 0;
    for (const sport of [...sports.slice(1), sports[0]!] as HeroSceneKey[]) {
      await select.selectOption(sport);
      await expect(art).toHaveAttribute("data-sport", sport);
      names.add((await art.locator("svg[role=img]").getAttribute("aria-label")) ?? "");
      // The pick starts the scene's OWN play from its start: the object's toss and fly are fresh, it is not yet where it
      // lands, and the score reads the sport's first frame.
      const start = await flight(page);
      expect(start.names, `${sport}: the object's toss and fly`).toEqual(["mk-ball-fly", "mk-ball-toss"]);
      expect(start.flyAt!, `${sport}: a play started by the pick, not one already flown`).toBeLessThan(1_000);
      expect(landed(start), `${sport}: not landed at the pick (${start.at} vs ${start.land})`).toBe(false);
      await expect(scoreOf(page), `${sport}: its first frame`).toHaveText(heroScoreText(sport, 0));
      // The landing: the object comes to rest where the scene lands it, and the score moves to its next frame. It rests there
      // only until the next auto play remounts the run (a play's length after the pick), so the poll samples finely
      // rather than with expect.poll's backoff, which can step over that window.
      await expect
        .poll(async () => landed(await flight(page)), { message: `${sport}: lands at --mk-land`, timeout: 6_000, intervals: [100] })
        .toBe(true);
      await expect(scoreOf(page), `${sport}: the landing moves the score`).toHaveText(heroScoreText(sport, 1));
      played++;
    }
    expect(played, "picks played").toBe(sports.length);
    expect([...names].filter(Boolean).length, "each sport's scene has its own accessible name").toBe(sports.length);
    // The replay, on the same scene: the object flies again from the start and lands again, and the score moves on.
    const last = sports[0]! as HeroSceneKey;
    await art.getByRole("button", { name: "Replay animation" }).click();
    const again = await flight(page);
    expect(again.flyAt!, "the replay starts a fresh play").toBeLessThan(1_000);
    expect(landed(again), "the replay starts from the toss, not the landing").toBe(false);
    await expect
      .poll(async () => landed(await flight(page)), { message: "the replay lands", timeout: 6_000, intervals: [100] })
      .toBe(true);
    await expect(scoreOf(page), "the replay's landing moves the score").toHaveText(heroScoreText(last, 2));
  });

  test("reduced motion: every picked sport shows its resting frame (the object landed, the decided score) and plays nothing", async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: "reduce", storageState: { cookies: [], origins: [] } });
    const page = await ctx.newPage();
    try {
      await page.goto("/en");
      const sports = await offeredSports(page);
      const select = page.getByTestId("qm-cta-form").locator('select[name="sport"]');
      let checked = 0;
      for (const sport of [...sports.slice(1), sports[0]!] as HeroSceneKey[]) {
        await select.selectOption(sport);
        await expect(page.locator("[data-sport]")).toHaveAttribute("data-sport", sport);
        expect(await runningAnimations(page), `${sport}: nothing moves under reduced motion`).toBe(0);
        // The object rests where the scene lands it, not where it starts.
        const f = await flight(page);
        expect(f.names, `${sport}: no toss, no fly`).toEqual([]);
        expect(landed(f), `${sport}: at --mk-land (${f.at} vs ${f.land})`).toBe(true);
        // The score the animated art rests on after its plays: the decided frame, never a mid-play one.
        await expect(scoreOf(page), sport).toHaveText(heroScoreText(sport, HERO_AUTO_PLAYS));
        checked++;
      }
      expect(checked, "sports checked").toBe(sports.length);
    } finally {
      await ctx.close();
    }
  });

  // Review m5 (2026-11-13): off-screen the art holds every animation, the endless sway and pulse included, and its play's
  // timers with them; it resumes where it held once back in view.
  test("off-screen the art holds every animation, and plays on back in view", async ({ page }) => {
    await page.goto("/en");
    const art = page.locator("[data-sport]");
    const running = async () => (await playStates(page)).filter((s) => s === "running").length;
    await expect.poll(running, { message: "in view: it plays" }).toBeGreaterThan(0);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect(art).toHaveAttribute("data-offscreen", "");
    await expect.poll(running, { message: "off-screen: nothing runs" }).toBe(0);
    expect((await playStates(page)).filter((s) => s === "paused").length, "off-screen: held, not finished").toBeGreaterThan(0);
    await art.scrollIntoViewIfNeeded();
    await expect(art).not.toHaveAttribute("data-offscreen");
    await expect.poll(running, { message: "back in view: it plays on" }).toBeGreaterThan(0);
  });

  test("on a phone a pick waits below the fold: its play holds unseen, then lands once the art is scrolled into view", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/en");
    const art = page.locator("[data-sport]");
    const sports = await offeredSports(page);
    expect((await art.boundingBox())?.y ?? 0, "the art starts below a 320×568 fold").toBeGreaterThan(568);
    await expect(art, "below the fold: held").toHaveAttribute("data-offscreen", "");
    const sport = sports[1]! as HeroSceneKey;
    await page.getByTestId("qm-cta-form").locator('select[name="sport"]').selectOption(sport);
    await expect(art).toHaveAttribute("data-sport", sport);
    const held = await flight(page);
    expect(held.flyState, "the new play's flight holds").toBe("paused");
    // Longer than a whole play: nothing flies on and nothing lands unseen.
    await page.waitForTimeout(3_500);
    expect((await flight(page)).flyAt, "the flight has not moved on").toBe(held.flyAt);
    await expect(scoreOf(page), "no landing unseen").toHaveText(heroScoreText(sport, 0));
    await art.scrollIntoViewIfNeeded();
    await expect(art).not.toHaveAttribute("data-offscreen");
    await expect
      .poll(async () => landed(await flight(page)), { message: "in view: it lands", timeout: 6_000, intervals: [100] })
      .toBe(true);
    await expect(scoreOf(page)).toHaveText(heroScoreText(sport, 1));
  });

  // Start wizard plan T5 (review m2): the link follows the hero's Sport select, so /start opens on the sport picked there.
  // The SECOND offered sport, read off the select: a link stuck on the select's first (its default) cannot pass. The href is
  // read BEFORE the click, so a link that only rewrote itself on the way out would fail here too.
  test("the organiser's setup is one link below the Start, to the /start wizard, on the sport the select picked", async ({ page }) => {
    await page.goto("/en");
    const link = page.getByTestId("hero-event-link");
    await expect(link).toHaveText("Running a full league or tournament? Set up an event →");
    const box = await link.boundingBox();
    expect(box?.height ?? 0, "a 44px tap target").toBeGreaterThanOrEqual(44);
    await waitForHydration(link);
    const sport = (await offeredSports(page))[1]!;
    await page.getByTestId("qm-cta-form").locator('select[name="sport"]').selectOption(sport);
    await expect(link, "the link follows the pick").toHaveAttribute("href", `/en/start?sport=${sport}`);
    await link.click();
    await page.waitForURL((url) => url.pathname === "/en/start" && url.searchParams.get("sport") === sport);
    const wizard = page.locator("[data-start-wizard]");
    await expect(wizard).toHaveAttribute("data-step", "sport");
    await expect(page.getByRole("heading", { name: "Set up an event" })).toBeVisible();
    await expect(wizard.locator('input[name="sport"]:checked'), "the wizard opens on that sport, and only it").toHaveCount(1);
    await expect(wizard.locator('input[name="sport"]:checked')).toHaveAttribute("value", sport);
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
