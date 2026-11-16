// The product pages (/product/streaming, /sports/cricket) in a browser: what the unit suites cannot see. Those run
// without a DOM, so the taps, the fold, the menus, real overflow and the no-script page are all proven here.
import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { expectNoHorizontalScroll } from "./helpers";

test.use({ storageState: { cookies: [], origins: [] } });

const RALLY_PAGES = ["/sports/badminton", "/sports/table-tennis", "/sports/volleyball"] as const;
const GOAL_PAGES = ["/sports/football", "/sports/hockey", "/sports/ice-hockey"] as const;
const PAGES = ["/product/streaming", "/product/remote-scoring", "/product/format", "/product/scheduling", "/product/sponsoring", "/product/match-day", "/sports/cricket", ...RALLY_PAGES, ...GOAL_PAGES, "/sports/tennis"] as const;
/** How many pad keys each sport family's demo offers, by page: every one must be a real tap target. */
const PAD_KEYS: Record<string, [selector: string, count: number]> = {
  ...Object.fromEntries(RALLY_PAGES.map((p) => [p, ['[data-testid^="rally-point-"]', 2]])),
  ...Object.fromEntries(GOAL_PAGES.map((p) => [p, ['[data-testid^="goal-key-"]', 5]])),
  "/sports/tennis": ['[data-testid^="tennis-point-"]', 2],
  // Sponsoring opens on an online invoice: four tiers, three methods, its three go-live rules, and a draft's two steps.
  "/product/sponsoring": ['[data-testid^="sponsor-tier-"], [data-testid^="sponsor-method-"], [data-testid^="sponsor-rule-"], [data-testid^="sponsor-step-"]', 12],
  // Match Day opens with two free courts to call and one match whose result can go in.
  "/product/match-day": ['[data-testid="md-demo"] [data-act]', 3],
};
const WIDTHS = [320, 768, 1280] as const;

const score = (page: Page, id: "chase-score" | "chase-mc-score" | "chase-stream-score") => page.getByTestId(id);

/**
 * Open a page as a first-time visitor and answer the cookie banner. The banner is fixed bottom-left, which is exactly
 * where the pad sits on a desktop first view, so a visitor has to answer it before the keys are reachable; the tests
 * do what that visitor does rather than pretending the banner is not there.
 */
async function visit(page: Page, path: string) {
  await page.goto(path);
  const banner = page.getByTestId("cookie-consent");
  await banner.getByRole("button", { name: "Reject" }).click();
  await expect(banner).toBeHidden();
}

/** Tap a pad key the way a finger would: only if the key is what is actually on top at its centre. */
async function tapKey(page: Page, key: string) {
  const k = page.getByTestId(`chase-key-${key}`);
  await k.scrollIntoViewIfNeeded();
  const onTop = await k.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === el;
  });
  expect(onTop, `key ${key} is the top element at its own centre`).toBe(true);
  await k.click();
}

/** Lazy pictures only load near the viewport: walk the page so every one has had its chance. */
async function walkPage(page: Page) {
  await page.evaluate(async () => {
    for (let y = 0; y < document.documentElement.scrollHeight; y += window.innerHeight / 2) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 60));
    }
    await Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; }))));
    window.scrollTo(0, 0);
  });
}

test.describe("product pages: the working demo", () => {
  test("cricket: a tap moves the pad, the match page tile and the stream tile; undo puts all three back", async ({ page }) => {
    await visit(page, "/sports/cricket");
    for (const id of ["chase-score", "chase-mc-score", "chase-stream-score"] as const) await expect(score(page, id)).toHaveText("27/2");
    await expect(page.getByTestId("chase-need")).toContainText("22");

    await tapKey(page, "4");
    for (const id of ["chase-score", "chase-mc-score", "chase-stream-score"] as const) await expect(score(page, id)).toHaveText("31/2");
    await expect(page.getByTestId("chase-need")).toContainText("18");

    await tapKey(page, "out");
    await expect(score(page, "chase-mc-score")).toHaveText("31/3");
    await tapKey(page, "wide");
    await expect(score(page, "chase-stream-score")).toHaveText("32/3");

    for (let i = 0; i < 3; i++) await page.getByTestId("chase-undo").click();
    for (const id of ["chase-score", "chase-mc-score", "chase-stream-score"] as const) await expect(score(page, id)).toHaveText("27/2");
    // Nothing left to take back: a fourth press changes nothing.
    await page.getByTestId("chase-undo").click();
    await expect(score(page, "chase-score")).toHaveText("27/2");
  });

  for (const path of RALLY_PAGES) {
    test(`${path}: a point moves the pad, the match page tile and the stream tile; take back undoes it; the match can be won`, async ({ page }) => {
      await visit(page, path);
      const demo = page.getByTestId("rally-demo");
      const num = async (id: string) => Number(await page.getByTestId(id).innerText());
      const [a0, b0] = [await num("rally-score-a"), await num("rally-score-b")];
      expect(a0, "the opening score is a real mid-set score").toBeGreaterThan(b0);
      expect(b0).toBeGreaterThan(0);
      const setsBefore = await page.getByTestId("rally-set").count();
      expect(setsBefore).toBeGreaterThanOrEqual(2);

      await page.getByTestId("rally-point-b").click();
      await expect(page.getByTestId("rally-score-b")).toHaveText(String(b0 + 1));
      await expect(page.getByTestId("rally-mc-score-b")).toHaveText(String(b0 + 1));
      await expect(page.getByTestId("rally-stream-score")).toHaveText(`${a0}-${b0 + 1}`);
      await page.getByTestId("rally-undo").click();
      await expect(page.getByTestId("rally-score-b")).toHaveText(String(b0));
      await expect(page.getByTestId("rally-stream-score")).toHaveText(`${a0}-${b0}`);
      await expect(demo).toHaveAttribute("data-rally-winner", "");

      // The leader is a few points from the match: award them until it is over (bounded, so a dead pad fails here).
      let taps = 0;
      while ((await demo.getAttribute("data-rally-winner")) === "" && taps < 8) {
        await page.getByTestId("rally-point-a").click();
        taps++;
      }
      await expect(demo).toHaveAttribute("data-rally-winner", "a");
      expect(taps, "the opening state is a few points from the end").toBeLessThanOrEqual(4);
      await expect(page.getByTestId("rally-set")).toHaveCount(setsBefore + 1);
      const me = page.getByTestId("rally-table-me").locator("td");
      await expect(me.nth(1)).toHaveText("1");
      await expect(me.nth(2)).toHaveText("1");
      // Over: another point changes nothing.
      const final = await page.getByTestId("rally-stream-score").innerText();
      await page.getByTestId("rally-point-b").click();
      await expect(page.getByTestId("rally-stream-score")).toHaveText(final);
    });
  }

  for (const path of GOAL_PAGES) {
    test(`${path}: a goal moves the pad, the match page tile and the stream tile; a card joins the timeline; full time settles the table`, async ({ page }) => {
      await visit(page, path);
      const demo = page.getByTestId("goal-demo");
      const num = async (id: string) => Number(await page.getByTestId(id).innerText());
      const [a0, b0] = [await num("goal-score-a"), await num("goal-score-b")];
      expect(a0, "the demo opens level").toBe(b0);
      const events0 = await page.getByTestId("goal-event").count();

      await page.getByTestId("goal-key-goal-a").click();
      await expect(page.getByTestId("goal-score-a")).toHaveText(String(a0 + 1));
      await expect(page.getByTestId("goal-mc-score-a")).toHaveText(String(a0 + 1));
      await expect(page.getByTestId("goal-stream-score")).toHaveText(`${a0 + 1}-${b0}`);
      await expect(page.getByTestId("goal-event")).toHaveCount(events0 + 1);

      await page.getByTestId("goal-key-card-b").click();
      await expect(page.getByTestId("goal-event")).toHaveCount(events0 + 2);
      await expect(page.getByTestId("goal-event").last()).toHaveAttribute("data-event-kind", "card");
      await expect(page.getByTestId("goal-stream-score"), "a card changes no score").toHaveText(`${a0 + 1}-${b0}`);
      await page.getByTestId("goal-undo").click();
      await expect(page.getByTestId("goal-event")).toHaveCount(events0 + 1);

      await expect(demo).toHaveAttribute("data-goal-result", "");
      await page.getByTestId("goal-key-fulltime").click();
      await expect(demo).toHaveAttribute("data-goal-result", "a");
      const me = page.getByTestId("goal-table-me").locator("td");
      await expect(me.nth(1)).toHaveText("1");
      await expect(me.nth(2)).toHaveText("1");
      // Over: a late goal changes nothing; take back reopens the match.
      await page.getByTestId("goal-key-goal-b").click();
      await expect(page.getByTestId("goal-stream-score")).toHaveText(`${a0 + 1}-${b0}`);
      await page.getByTestId("goal-undo").click();
      await expect(demo).toHaveAttribute("data-goal-result", "");
    });
  }

  test("tennis: a point moves the call on the pad, the match page tile and the stream tile; the leader can serve it out", async ({ page }) => {
    await visit(page, "/sports/tennis");
    const demo = page.getByTestId("tennis-demo");
    const [a0, b0] = [await page.getByTestId("tennis-call-a").innerText(), await page.getByTestId("tennis-call-b").innerText()];
    expect(a0).not.toBe(b0);
    await expect(page.getByTestId("tennis-stream-score")).toHaveText(`${a0}-${b0}`);
    const cols0 = await page.getByTestId("tennis-setcol-a").count();
    // The set columns read across, on the line of the current call: not stacked above it.
    const tops = await page.locator('[data-testid="tennis-setcol-a"], [data-testid="tennis-mc-call-a"]').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().bottom)));
    expect(tops.length).toBe(cols0 + 1);
    expect(Math.max(...tops) - Math.min(...tops), `set columns and the call share a line: ${tops}`).toBeLessThanOrEqual(8);

    await page.getByTestId("tennis-point-b").click();
    // The trailing side draws level: both sides now show the call the leader opened on.
    await expect(page.getByTestId("tennis-call-b")).toHaveText(a0);
    await expect(page.getByTestId("tennis-mc-call-b")).toHaveText(a0);
    await expect(page.getByTestId("tennis-stream-score")).toHaveText(`${a0}-${a0}`);
    await page.getByTestId("tennis-undo").click();
    await expect(page.getByTestId("tennis-call-b")).toHaveText(b0);

    let taps = 0;
    while ((await demo.getAttribute("data-tennis-winner")) === "" && taps < 6) {
      await page.getByTestId("tennis-point-a").click();
      taps++;
    }
    await expect(demo).toHaveAttribute("data-tennis-winner", "a");
    expect(taps).toBeLessThanOrEqual(3);
    await expect(page.getByTestId("tennis-setcol-a")).toHaveCount(cols0);
    await expect(page.getByTestId("tennis-setcol-a").last()).toHaveText("6");
    const me = page.getByTestId("tennis-table-me").locator("td");
    await expect(me.nth(2)).toHaveText("1");
    const final = await page.getByTestId("tennis-stream-score").innerText();
    await page.getByTestId("tennis-point-b").click();
    await expect(page.getByTestId("tennis-stream-score")).toHaveText(final);
  });

  test("match day: a call moves the desk, the phone and the court's camera together, and a busy team is passed over", async ({ page }) => {
    await visit(page, "/product/match-day");
    const court = (i: number) => page.getByTestId(`md-court-${i}`);
    const cam = (i: number) => page.getByTestId("md-cams").locator("li").nth(i);
    const waiting = page.getByTestId("md-waiting");
    await expect(court(1)).toHaveAttribute("data-court-state", "free");
    await expect(waiting).toHaveAttribute("data-waiting", "4");
    await expect(cam(0)).toHaveAttribute("data-stream", "live");

    // Call, then undo: the match goes back and the same one is offered again.
    const offered = await court(1).getByTestId("md-next").innerText();
    await court(1).locator('[data-act="call"]').click();
    await expect(court(1)).toHaveAttribute("data-court-state", "called");
    await expect(page.getByTestId("md-event")).toHaveAttribute("data-event", "call");
    await expect(waiting).toHaveAttribute("data-waiting", "3");
    await expect(court(1).locator('[data-act="call"]')).toHaveCount(0);
    await court(1).locator('[data-act="undo"]').click();
    await expect(court(1)).toHaveAttribute("data-court-state", "free");
    await expect(waiting).toHaveAttribute("data-waiting", "4");
    await expect(court(1).getByTestId("md-next")).toHaveText(offered);

    // Called is not on air; the camera goes live only when the players are on.
    await court(1).locator('[data-act="call"]').click();
    await expect(cam(1)).toHaveAttribute("data-stream", "waiting");
    await court(1).locator('[data-act="start"]').click();
    await expect(court(1)).toHaveAttribute("data-court-state", "playing");
    await expect(cam(1)).toHaveAttribute("data-stream", "live");
    await expect(page.getByTestId("md-phone").locator("li").nth(1)).toHaveAttribute("data-phone-state", "playing");

    // The next match in line has a team still playing on court 1: it is held, named, and the one after is called.
    const held = page.getByTestId("md-held");
    await expect(held).toContainText("Southend Blue Blazers");
    const heldText = await held.innerText();
    await court(2).locator('[data-act="call"]').click();
    await expect(held).toHaveText(heldText);
    await court(2).locator('[data-act="start"]').click();
    // Court 3 has no phone: a match plays there and nothing streams.
    await expect(cam(2)).toHaveAttribute("data-stream", "none");

    // Result in on court 1: the court frees, the held match is released and is what the court now offers.
    await court(0).locator('[data-act="result"]').click();
    await expect(court(0)).toHaveAttribute("data-court-state", "free");
    await expect(cam(0)).toHaveAttribute("data-stream", "waiting");
    await expect(held).toHaveCount(0);
    await expect(page.getByTestId("md-done")).toContainText("1");
    await expect(court(0).getByTestId("md-next")).toContainText("Southend Blue Blazers");

    await page.getByTestId("md-reset").click();
    await expect(waiting).toHaveAttribute("data-waiting", "4");
    await expect(court(0)).toHaveAttribute("data-court-state", "playing");
  });

  test("sponsoring: a sponsor reaches the page and the stream only when the deal's own rule is met, and leaves when it ends", async ({ page }) => {
    await visit(page, "/product/sponsoring");
    const demo = page.getByTestId("sponsor-demo");
    const onPage = page.getByTestId("sponsor-on-page");
    const stream = page.getByTestId("sponsor-stream");
    await expect(demo).toHaveAttribute("data-deal-status", "draft");
    await expect(onPage).toHaveCount(0);

    // Bank or cash, live after I approve: payment alone is not enough.
    await page.getByTestId("sponsor-method-offline").click();
    await page.getByTestId("sponsor-rule-on_approval").click();
    await expect(demo).toHaveAttribute("data-deal-status", "awaiting_payment");
    await expect(page.getByTestId("sponsor-step-approve")).toHaveCount(0);
    await page.getByTestId("sponsor-step-pay").click();
    await expect(demo).toHaveAttribute("data-deal-status", "awaiting_approval");
    await expect(demo).toHaveAttribute("data-deal-money", "paid");
    await expect(onPage).toHaveCount(0);
    await expect(stream).toHaveAttribute("data-on-stream", "false");
    await page.getByTestId("sponsor-step-approve").click();
    await expect(demo).toHaveAttribute("data-deal-status", "live");
    await expect(onPage).toBeVisible();
    await expect(onPage).toContainText("Harbour Bakery");
    await expect(stream).toHaveAttribute("data-on-stream", "true");
    await expect(page.getByTestId("sponsor-log")).toHaveCount(2);

    // The tier decides where on the page, and how many turns on the stream: no two of these read the same.
    const turns: string[] = [];
    for (const tier of ["title", "gold", "partner"] as const) {
      await page.getByTestId(`sponsor-tier-${tier}`).click();
      await expect(page.getByTestId("sponsor-board")).toHaveAttribute("data-board-tier", tier);
      await expect(onPage).toHaveCount(1);
      turns.push(await page.getByTestId("sponsor-turns").innerText());
    }
    expect(new Set(turns).size).toBe(3);

    await page.getByTestId("sponsor-step-end").click();
    await expect(demo).toHaveAttribute("data-deal-status", "ended");
    await expect(onPage).toHaveCount(0);
    await expect(stream).toHaveAttribute("data-on-stream", "false");
    await expect(page.locator('[data-testid^="sponsor-step-"]')).toHaveCount(0);

    // A complimentary deal has no payment to wait for: "When paid" is not offered, and it is live from the start.
    await page.getByTestId("sponsor-method-complimentary").click();
    await expect(page.getByTestId("sponsor-rule-on_payment")).toHaveCount(0);
    // It kept "After I approve", which a complimentary deal also offers, so it waits for that.
    await expect(demo).toHaveAttribute("data-deal-status", "awaiting_approval");
    await page.getByTestId("sponsor-rule-immediate").click();
    await expect(demo).toHaveAttribute("data-deal-status", "live");
    await expect(demo).toHaveAttribute("data-deal-money", "free");
    await page.getByTestId("sponsor-reset").click();
    await expect(demo).toHaveAttribute("data-deal-status", "live");
  });

  test("cricket: a six, a four and a wicket are announced on the stream tile, and the over's last ball adds its summary", async ({ page }) => {
    await visit(page, "/sports/cricket");
    const moment = page.getByTestId("chase-moment");
    await expect(moment).toHaveCount(0);
    for (const [key, kind, word] of [["6", "six", "SIX"], ["4", "four", "FOUR"], ["out", "out", "OUT"]] as const) {
      await tapKey(page, key);
      await expect(moment).toHaveAttribute("data-moment", kind);
      await expect(moment).toHaveText(word);
    }
    // An ordinary ball clears it; the demo opened one ball into the over, so two more legal balls finish it.
    await tapKey(page, "1");
    await expect(moment).toHaveCount(0);
    await tapKey(page, "2");
    await expect(moment).toHaveAttribute("data-moment", "over");
    const score = await page.getByTestId("chase-stream-score").innerText();
    await expect(page.getByTestId("chase-moment-over")).toContainText(score);
    await expect(page.getByTestId("chase-moment-over")).toContainText("End of over 4");
    // It sits inside the picture and clear of the score bar.
    const [m, v, bar] = await Promise.all([moment.boundingBox(), page.getByTestId("chase-stream").boundingBox(), page.locator('[data-testid="chase-stream"] .mkp-ov').boundingBox()]);
    expect(m!.x + m!.width).toBeLessThanOrEqual(v!.x + v!.width + 1);
    expect(m!.y + m!.height).toBeLessThanOrEqual(bar!.y + 1);
    await page.getByTestId("chase-undo").click();
    await expect(moment).toHaveCount(0);
  });

  test("cricket: finishing the chase updates the table, and the keys then stop changing the score", async ({ page }) => {
    await visit(page, "/sports/cricket");
    const me = page.getByTestId("chase-table-me").locator("td");
    await expect(me.nth(2)).toHaveText("0");
    await expect(me.nth(3)).toHaveText("0");
    for (let i = 0; i < 4; i++) await tapKey(page, "6");
    await expect(page.getByTestId("chase-demo")).toHaveAttribute("data-chase-end", "won");
    await expect(score(page, "chase-score")).toHaveText("51/2");
    await expect(me.nth(2)).toHaveText("1");
    await expect(me.nth(3)).toHaveText("2");
    await page.getByTestId("chase-key-6").click();
    await page.getByTestId("chase-key-out").click();
    await expect(score(page, "chase-score")).toHaveText("51/2");
    // Taking the last ball back reopens the chase.
    await page.getByTestId("chase-undo").click();
    await expect(page.getByTestId("chase-demo")).toHaveAttribute("data-chase-end", "");
    await expect(me.nth(3)).toHaveText("0");
  });

  test("streaming: the pad drives the stream, and the style and state switches change it", async ({ page }) => {
    await visit(page, "/product/streaming");
    const stream = page.getByTestId("chase-stream");
    await expect(page.getByTestId("chase-tile-table")).toHaveCount(0);
    await tapKey(page, "2");
    await expect(score(page, "chase-stream-score")).toHaveText("29/2");
    await expect(stream).toHaveAttribute("data-stream-style", "bar");
    await page.getByTestId("chase-seg-style-bug").click();
    await expect(stream).toHaveAttribute("data-stream-style", "bug");
    await expect(page.getByTestId("chase-seg-style-bug")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("chase-seg-style-bar")).toHaveAttribute("aria-pressed", "false");
    for (const [state, word] of [["recon", "Reconnecting"], ["final", "Final"], ["soon", "Starting soon"], ["live", "Live"]] as const) {
      await page.getByTestId(`chase-seg-state-${state}`).click();
      await expect(stream).toHaveAttribute("data-stream-state", state);
      await expect(page.getByTestId("chase-stream-state")).toHaveText(word);
    }
    // The score survived every switch.
    await expect(score(page, "chase-stream-score")).toHaveText("29/2");
  });

  test("a tap flashes the screens it changed, and never under reduced motion", async ({ browser }) => {
    for (const reducedMotion of ["no-preference", "reduce"] as const) {
      const ctx = await browser.newContext({ reducedMotion, storageState: { cookies: [], origins: [] } });
      const page = await ctx.newPage();
      await visit(page, "/sports/cricket");
      await expect(page.locator(".mkp-flash")).toHaveCount(0);
      await tapKey(page, "1");
      await expect(score(page, "chase-score")).toHaveText("28/2");
      const flashed = await page.locator(".mkp-flash").count();
      if (reducedMotion === "reduce") expect(flashed).toBe(0);
      else expect(flashed).toBeGreaterThanOrEqual(3);
      await ctx.close();
    }
  });
});

test.describe("remote scoring: the signal demo", () => {
  test("no signal: the phone keeps scoring, the other screen stands still, then catches up in one go", async ({ page }) => {
    await visit(page, "/product/remote-scoring");
    const demo = page.getByTestId("signal-demo");
    const phone = page.getByTestId("signal-phone-score");
    const others = page.getByTestId("signal-server-score");
    const sw = page.getByTestId("signal-switch");
    const tapSignalKey = async (key: string) => {
      const k = page.getByTestId(`signal-key-${key}`);
      await k.scrollIntoViewIfNeeded();
      expect(await k.evaluate((el) => { const r = el.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === el; }), `key ${key} on top`).toBe(true);
      await k.click();
    };

    // With signal a tap reaches everyone at once.
    await expect(sw).toHaveAttribute("aria-checked", "true");
    await tapSignalKey("1");
    await expect(phone).toHaveText("28/2");
    await expect(others).toHaveText("28/2");

    await sw.click();
    await expect(sw).toHaveAttribute("aria-checked", "false");
    await expect(demo).toHaveAttribute("data-signal", "off");
    for (const key of ["4", "6", "wide"]) await tapSignalKey(key);
    await expect(phone).toHaveText("39/2");
    await expect(others).toHaveText("28/2");
    await expect(demo).toHaveAttribute("data-waiting", "3");
    await expect(page.getByTestId("signal-badge")).toContainText("3");
    await expect(page.getByTestId("signal-server-note")).toHaveText("Waiting for the phone");

    // Taking back a tap that never left the phone shortens the queue.
    await page.getByTestId("signal-undo").click();
    await expect(phone).toHaveText("38/2");
    await expect(demo).toHaveAttribute("data-waiting", "2");
    await expect(others).toHaveText("28/2");

    await sw.click();
    await expect(others).toHaveText("38/2");
    await expect(demo).toHaveAttribute("data-waiting", "0");
    await expect(page.getByTestId("signal-badge")).toContainText("2 sent");
    await expect(page.getByTestId("signal-server-note")).toHaveText("Up to date");
  });

  test("the switch works from the keyboard and says what it is", async ({ page }) => {
    await visit(page, "/product/remote-scoring");
    const sw = page.getByRole("switch", { name: "Signal" });
    await sw.focus();
    await page.keyboard.press("Space");
    await expect(sw).toHaveAttribute("aria-checked", "false");
    await page.keyboard.press("Enter");
    await expect(sw).toHaveAttribute("aria-checked", "true");
  });

  test("the nav's Product menu lists Remote scoring and lands on it", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/pricing");
    const product = page.getByTestId("nav-menu-product");
    await product.getByRole("button").click();
    await product.getByRole("link", { name: "Remote scoring" }).click();
    await expect(page).toHaveURL(/\/product\/remote-scoring$/);
    await expect(page.locator("h1")).toHaveText("No signal? Keep scoring.");
  });
});

test.describe("formats: the recommender demo", () => {
  test("changing the day changes what fits, and the cards show the recommender's own numbers", async ({ page }) => {
    await visit(page, "/product/format");
    const card = (slug: string) => page.getByTestId(`format-card-${slug}`);
    // Opening day: 8 teams. A league of 8 is 28 matches and a knockout is 7: the rulebook's n(n-1)/2 and n-1.
    await expect(page.getByTestId("format-entrants")).toHaveText("8");
    await expect(page.getByTestId("format-card-league-matches")).toContainText("28");
    await expect(page.getByTestId("format-card-knockout-matches")).toContainText("7");
    await expect(page.locator('[data-best="true"]')).toHaveCount(1);

    // Two more teams: 10 → 45 and 9.
    await page.getByTestId("format-entrants-more").click();
    await page.getByTestId("format-entrants-more").click();
    await expect(page.getByTestId("format-entrants")).toHaveText("10");
    await expect(page.getByTestId("format-card-league-matches")).toContainText("45");
    await expect(page.getByTestId("format-card-knockout-matches")).toContainText("9");

    // Squeeze the day to one pitch for one hour at 90 minutes: nothing fits, so nothing wears Best fit.
    for (let i = 0; i < 3; i++) await page.getByTestId("format-hours-less").click();
    await page.getByTestId("format-courts-less").click();
    await page.getByTestId("format-minutes-90").click();
    await expect(page.getByTestId("format-hours")).toHaveText("1");
    await expect(page.getByTestId("format-hours-less")).toBeDisabled();
    await expect(card("league")).toHaveAttribute("data-state", "over");
    await expect(page.locator('[data-best="true"]')).toHaveCount(0);

    // A generous day brings a best fit back.
    for (let i = 0; i < 11; i++) await page.getByTestId("format-hours-more").click();
    for (let i = 0; i < 5; i++) await page.getByTestId("format-courts-more").click();
    await page.getByTestId("format-minutes-20").click();
    await expect(page.locator('[data-best="true"]')).toHaveCount(1);
    await expect(page.getByTestId("format-minutes-20")).toHaveAttribute("aria-pressed", "true");
  });

  test("the nav's Formats link lands on the product page", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/pricing");
    const product = page.getByTestId("nav-menu-product");
    await product.getByRole("button").click();
    await product.getByRole("link", { name: "Formats" }).click();
    await expect(page).toHaveURL(/\/product\/format$/);
    await expect(page.locator("h1")).toHaveText("The format that fits your day.");
  });
});

test.describe("scheduling: the day board demo", () => {
  test("a clash is refused, the rest fills itself, and a delay moves what players see", async ({ page }) => {
    await visit(page, "/product/scheduling");
    const demo = page.getByTestId("day-demo");
    const status = page.getByTestId("day-status");
    const cell = (c: number, s: number) => page.getByTestId(`day-cell-${c}-${s}`);
    // Opening day: three placed, three waiting, nothing published, free cells are not tappable yet.
    await expect(demo.locator('[data-match]:not([data-match=""])')).toHaveCount(3);
    await expect(page.getByTestId("day-tray").getByRole("button")).toHaveCount(3);
    await expect(demo).toHaveAttribute("data-published", "false");
    await expect(cell(1, 1)).toBeDisabled();
    await expect(page.getByTestId("day-publish")).toBeDisabled();

    // Blazers already play at 09:40 on Court 1 (m3). Blazers v Lions (m5) on Court 2 at 09:40 is refused, by name.
    await page.getByTestId("day-tray-m5").click();
    await cell(1, 1).click();
    await expect(status).toHaveAttribute("data-refused", "team");
    await expect(status).toContainText("Blazers");
    await expect(cell(1, 1)).toHaveAttribute("data-match", "");
    // The same match one start later is fine.
    await cell(1, 2).click();
    await expect(cell(1, 2)).toHaveAttribute("data-match", "m5");
    await expect(status).toHaveAttribute("data-refused", "");

    // Fill the rest: all six on the board, no two in one cell, and Publish wakes up.
    await page.getByTestId("day-fill").click();
    await expect(demo.locator('[data-match]:not([data-match=""])')).toHaveCount(6);
    const ids = await demo.locator("[data-match]").evaluateAll((els) => els.map((e) => e.getAttribute("data-match")));
    expect(new Set(ids).size).toBe(6);
    await expect(page.getByTestId("day-public").locator("li")).toHaveCount(0);
    await page.getByTestId("day-publish").click();
    await expect(demo).toHaveAttribute("data-published", "true");
    const rows = page.getByTestId("day-public").locator("li");
    await expect(rows).toHaveCount(6);
    await expect(rows.first().locator("b")).toHaveText("09:00");

    // Rain: one step is the real board's 15 minutes; the public list moves with it and says so.
    await page.getByTestId("day-delay").click();
    await expect(rows.first().locator("b")).toHaveText("09:15");
    await expect(rows.last().locator("b")).toHaveText("10:35");
    await expect(page.getByTestId("day-updated")).toContainText("15");
    await expect(demo).toHaveAttribute("data-published", "true");

    // Lifting a match takes the day back to draft: players see nothing until it is published again.
    await cell(0, 0).click();
    await expect(demo).toHaveAttribute("data-published", "false");
    await expect(rows).toHaveCount(0);
  });

  test("the board works from the keyboard, and the nav's Scheduling link lands here", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/pricing");
    const product = page.getByTestId("nav-menu-product");
    await product.getByRole("button").click();
    await product.getByRole("link", { name: "Scheduling" }).click();
    await expect(page).toHaveURL(/\/product\/scheduling$/);
    await expect(page.locator("h1")).toHaveText("Every match, a court and a time.");
    await page.getByTestId("cookie-consent").getByRole("button", { name: "Reject" }).click().catch(() => {});
    await page.getByTestId("day-tray-m4").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("day-tray-m4")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("day-cell-1-1").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("day-cell-1-1")).toHaveAttribute("data-match", "m4");
  });
});

test.describe("scheduling: the recorded runs", () => {
  test("three recordings are offered, and picking one plays it on the product's own screen with its price", async ({ page }) => {
    await visit(page, "/product/scheduling");
    const runs = page.locator('[data-section="runs"]');
    // Not loaded at the top of the page; scrolling to it brings the replay in.
    await expect(runs.locator('[data-runs="waiting"]')).toBeVisible();
    await expect(runs.locator("[data-ai-template]")).toHaveCount(0);
    await runs.scrollIntoViewIfNeeded();
    await expect(runs.locator("[data-ai-template]")).toHaveCount(3);
    await runs.locator('[data-ai-template="club-night"]').click();
    await expect(runs.locator('[data-ai-demo="ready"]')).toHaveAttribute("data-ai-started", "true");
    await expect(runs.locator('[data-ai-screen="true"]')).toBeVisible();
    await expect(runs.locator('[data-ai-price="run"]')).toBeVisible({ timeout: 30_000 });
    expect(Number(await runs.locator('[data-ai-price="run"]').getAttribute("data-credits"))).toBeGreaterThan(0);
    // The product's own components render here with only a slice of the dictionary shipped: no raw key may show,
    // and a court is named, never "unknown".
    const text = await runs.innerText();
    expect(text).not.toMatch(/\b(board|courtPicker|scheduling|sched|constraints)\.[a-zA-Z][a-zA-Z0-9.]+/);
    expect(text).not.toContain("Unknown court");
    expect(text.length).toBeGreaterThan(400);
  });
});

test.describe("live: the listing page in the product theme", () => {
  for (const width of [320, 768, 1280]) {
    test(`/live at ${width}: one headline, a wall or an honest empty state, and no way to the old directory`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await visit(page, "/live");
      await expect(page.locator("h1")).toHaveCount(1);
      await expect(page.locator("h1")).toHaveText("Live now.");
      const wall = page.locator('[data-section="wall"]');
      await expect(wall).toBeVisible();
      // Whatever the database holds, the wall shows exactly one of its two states.
      const cards = await wall.locator(".mkp-wall-card").count();
      const banner = await page.getByTestId("live-start").count();
      expect(cards > 0 ? banner === 0 : banner === 1, `cards ${cards}, banner ${banner}`).toBe(true);
      await expect(page.locator('main a[href*="/discover"]')).toHaveCount(0);
      await expectNoHorizontalScroll(page);
      expect(errors).toEqual([]);
    });
  }
});

test.describe("product pages: layout", () => {
  for (const path of PAGES) {
    for (const width of WIDTHS) {
      test(`${path} at ${width}: no sideways scroll, no page errors, every picture loads`, async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.setViewportSize({ width, height: 900 });
        const res = await page.goto(path);
        expect(res?.status()).toBe(200);
        await walkPage(page);
        // The site clips sideways overflow (`overflow-x: clip`), which pins a naive scrollWidth to the viewport; the
        // helper lifts the clip before measuring, and organiser-console.spec.ts carries the control that proves it can fail.
        await expectNoHorizontalScroll(page);
        const m = await page.evaluate(() => ({
          images: document.images.length,
          broken: [...document.images].filter((i) => !i.naturalWidth).map((i) => i.getAttribute("src")),
          h1: document.querySelectorAll("h1").length,
        }));
        expect(m.images, "pictures on the page").toBeGreaterThanOrEqual(4);
        expect(m.broken).toEqual([]);
        expect(m.h1).toBe(1);
        expect(errors).toEqual([]);
        // Every pad key is a real tap target.
        const sizes = await page.locator('[data-testid^="chase-key-"], [data-testid^="signal-key-"]').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
        // Every control of the page's demo is a real tap target: pad keys, or the format demo's steppers.
        const controls = path === "/product/format"
          ? await page.locator('[data-testid^="format-"][data-testid$="-less"], [data-testid^="format-"][data-testid$="-more"], [data-testid^="format-minutes-"]').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)))
          : path === "/product/scheduling"
            ? await page.getByTestId("day-demo").getByRole("button").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)))
            : PAD_KEYS[path]
              ? await page.locator(PAD_KEYS[path]![0]).evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)))
              : sizes;
        // Scheduling: six board cells, three matches waiting, three actions. The other sports: their family's pad keys.
        const expected = path === "/product/format" ? 11 : path === "/product/scheduling" ? 12 : (PAD_KEYS[path]?.[1] ?? 8);
        expect(controls.length).toBe(expected);
        for (const h of controls) expect(h).toBeGreaterThanOrEqual(44);
      });
    }
  }

  for (const lang of ["fr", "nl", "es"] as const) {
    test(`${lang} at 320: the longer copy still fits`, async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 800 });
      let checked = 0;
      for (const path of PAGES) {
        await page.goto(`/${lang}${path}`);
        await expect(page.locator("html")).toHaveAttribute("lang", lang);
        await walkPage(page);
        await expectNoHorizontalScroll(page);
        // No button label is clipped by its own box.
        const clipped = await page.locator(".mkp a.mkp-btn, .mkp button").evaluateAll((els) =>
          els.filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent),
        );
        expect(clipped, `${lang}${path}`).toEqual([]);
        checked++;
      }
      expect(checked).toBe(PAGES.length);
    });
  }

  test("with script off, both pages read complete and the demo shows its opening state", async ({ browser }) => {
    const ctx = await browser.newContext({ javaScriptEnabled: false, storageState: { cookies: [], origins: [] } });
    const page = await ctx.newPage();
    for (const [path, sections, scores] of [
      ["/product/streaming", 8, ["chase-score", "chase-stream-score"]],
      ["/sports/cricket", 9, ["chase-score", "chase-stream-score"]],
      ["/sports/badminton", 7, []],
      ["/sports/table-tennis", 7, []],
      ["/sports/volleyball", 7, []],
      ["/sports/football", 7, []],
      ["/sports/hockey", 7, []],
      ["/sports/ice-hockey", 7, []],
      ["/sports/tennis", 7, []],
      ["/product/remote-scoring", 7, ["signal-phone-score", "signal-server-score"]],
      ["/product/format", 6, []],
      ["/product/scheduling", 7, []],
      ["/product/sponsoring", 6, []],
      ["/product/match-day", 8, []],
    ] as const) {
      await page.goto(path);
      for (const id of scores) await expect(page.getByTestId(id)).toHaveText("27/2");
      await expect(page.locator("[data-section]")).toHaveCount(sections);
      await expect(page.locator(".mkp h2")).toHaveCount(sections - 2);
      // The questions are readable without script: the first is open, the rest are native disclosures.
      await expect(page.locator(".mkp-faq details").first()).toHaveAttribute("open", "");
    }
    await ctx.close();
  });

  test("a sport with no page is a 404, prefixed or not", async ({ request }) => {
    for (const path of ["/sports/notasport", "/en/sports/tabletennis", "/fr/sports/notasport"]) {
      expect((await request.get(path)).status(), path).toBe(404);
    }
    expect((await request.get("/sports/cricket")).status()).toBe(200);
  });

  test("/sports: a card per sport at every width, nothing wider than the screen, and a card opens its sport's page", async ({ page, request }) => {
    for (const lang of ["", "/fr"]) expect((await request.get(`${lang}/sports`)).status(), `${lang}/sports`).toBe(200);
    const slugs = ["cricket", ...[...RALLY_PAGES, ...GOAL_PAGES, "/sports/tennis"].map((p) => p.replace("/sports/", ""))];
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 800 });
      await visit(page, "/sports");
      await walkPage(page);
      await expect(page.locator('[data-testid^="sport-card-"]')).toHaveCount(slugs.length);
      await expectNoHorizontalScroll(page);
      const broken = await page.evaluate(() => [...document.images].filter((i) => i.naturalWidth === 0).map((i) => i.src));
      expect(broken, `${width}px`).toEqual([]);
      await page.context().clearCookies();
    }
    for (const slug of slugs) await expect(page.getByTestId(`sport-card-${slug}`)).toHaveAttribute("href", `/sports/${slug}`);
    await page.getByTestId("sport-card-football").click();
    await expect(page).toHaveURL(/\/sports\/football$/);
    await expect(page.getByTestId("goal-demo")).toBeVisible();
  });

  for (const path of [...PAGES, "/sports"]) {
    test(`${path}: no serious accessibility violation`, async ({ page }) => {
      await page.goto(path);
      const results = await new AxeBuilder({ page }).analyze();
      const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      expect(bad.map((v) => `${v.id}: ${v.nodes.length} — ${v.nodes[0]?.target}`)).toEqual([]);
    });
  }
});

test.describe("marketing nav: Product and Sports", () => {
  test("desktop: the menus open by keyboard, close on Escape, and their links land on real pages", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/pricing");
    const product = page.getByTestId("nav-menu-product");
    const button = product.getByRole("button");
    const link = product.getByRole("link", { name: "Streaming" });
    await expect(button).toHaveAttribute("aria-expanded", "false");
    await expect(link).toBeHidden();
    await button.focus();
    await page.keyboard.press("Enter");
    await expect(button).toHaveAttribute("aria-expanded", "true");
    await expect(link).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(link).toBeHidden();
    await expect(button).toBeFocused();
    // Outside click closes too.
    await button.click();
    await expect(link).toBeVisible();
    await page.locator("main").click({ position: { x: 5, y: 300 } });
    await expect(link).toBeHidden();

    await button.click();
    await link.click();
    await expect(page).toHaveURL(/\/product\/streaming$/);
    await expect(page.locator("h1")).toContainText("already on your stream");

    const sports = page.getByTestId("nav-menu-sports");
    await sports.getByRole("button").click();
    await sports.getByRole("link", { name: "Cricket" }).click();
    await expect(page).toHaveURL(/\/sports\/cricket$/);
    await expect(page.locator("h1")).toHaveText("Scores every ball.");
  });

  test("the night nav stays readable over the product hero and flips solid once it scrolls away", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/sports/cricket");
    const nav = page.locator("[data-mk-nav]");
    await expect(nav).toHaveClass(/mk-nav-night/);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect(nav).toHaveClass(/mk-nav-solid/);
  });

  test("Pricing and Live are reached from the nav, so they carry no back arrow; a page that is not still does", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const back = page.getByRole("button", { name: "Back", exact: true });
    // The control: the arrow exists and this locator finds it, or the two absences below prove nothing.
    await page.goto("/help");
    await expect(back).toBeVisible();
    for (const path of ["/pricing", "/live"]) {
      await page.goto(path);
      await expect(page.locator("[data-mk-nav]")).toBeVisible();
      await expect(back, path).toHaveCount(0);
    }
  });

  test("phone: the panel lists the same pages under Product and Sports", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto("/product/streaming");
    await expect(page.getByTestId("nav-menu-product")).toBeHidden();
    await page.getByRole("button", { name: "Open menu" }).click();
    const panel = page.getByRole("menu");
    await expect(panel.getByRole("group", { name: "Product" }).getByRole("menuitem", { name: "Streaming" })).toBeVisible();
    await expect(panel.getByRole("group", { name: "Sports" }).getByRole("menuitem", { name: "Cricket" })).toBeVisible();
    await expect(panel.getByRole("menuitem", { name: "Pricing" })).toBeVisible();
    // The panel fits the screen it opened on.
    const box = await panel.boundingBox();
    expect(box!.y + box!.height).toBeLessThanOrEqual(800);
    await panel.getByRole("menuitem", { name: "Cricket" }).click();
    await expect(page).toHaveURL(/\/sports\/cricket$/);
  });
});
