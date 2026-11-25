/**
 * Online Chess credits, the organiser's side of the payment, end to end (spec docs/superpowers/specs/2026-11-23-online-chess-credits-design.md
 * §8.3-§8.8; plan Task 12): the amber pay line, the receipt in its three modes (pay / payAndOpen / change), the paid chip, and the competition
 * page's "Not paid" flag - each driven through the real page, the real routes and the real database, with a REAL Stripe sandbox purchase for the
 * one scene that has to run short.
 *
 *   A  a division is short of credits: the amber line says it, Pay opens the receipt, the receipt says "Buy credits" and preselects the smallest
 *      pack that covers the shortfall, the Stripe SANDBOX checkout (4242) takes the money, the organiser lands back on the receipt (the address
 *      names the division, the checkout session is the arrival key), pays, and the chip shows no way back to the amber line; Open round 1 then
 *      asks for nothing, and after the freeze the chip offers no Change size;
 *   B  pay and open: the first press on an unpaid package is refused 402, the receipt opens on the STORED size, its one confirm re-sends the open
 *      with the payment, and the round opens with the payment said in its notice;
 *   C  a division paid early from the amber line WITHOUT the camera (the first receipt answered Yes, then No: the total follows the answer, the pay
 *      body carries `cameras: false`), moved up from the chip, moved down with the credits shown and then really back, then given the Fair-play camera
 *      at the SAME size from the chip (Yes alone is enough: the total is the server's camera difference, and the division's setting is written
 *      Required with the payment), then - before round 1 - the camera turned OFF again from the chip, the camera price really back (Task 15);
 *   D  the competition page flags the unpaid division for its organiser (a link to the Fixtures tab) and stops when it is paid;
 *   E  a division paid WITH the camera on its first receipt (Yes): the camera price, `cameras: true` in the body, the package holds the camera and the
 *      division's camera setting reads Required (Task 15).
 *
 * Where the expected numbers come from: the price table is the leaf's (`packagePrice`, checked against the spec's table by the unit suite), the
 * packs are the engine's own declarations (`STREAM_CREDIT_PACKS`), the words are the English dictionary's, the balance and the shortfall are read
 * from the server's quote and the ledger. Nothing is derived from the receipt's own arithmetic.
 *
 * Server env (an e2e server like Match Day's): ONLINE_CHESS_ALWAYS=1 (the flag), a REAL Stripe test key (STRIPE_SECRET_KEY is a SANDBOX key), no
 * Resend and no Lichess/RealtimeKit fixtures needed - a round is opened and its invites are only queued. Each scene is its own fresh org, so no
 * other worker's credits move this one's balance; the shared e2e org is never touched.
 *
 * Budget: from the taps (`budget`), never a flat number - the Stripe sheet alone is a minute.
 */
import { test, expect, type Page } from "@playwright/test";
import { apiJson, setOrgPlanBySql, withDb } from "../helpers";
import { dismissConsent, freshOrg } from "../directory-kit";
import { fill, seedOnlineRound, uiEn, fundOnlinePayment, type SeededRound } from "../match-room-kit";
import { openRoundPanel, openRoundSent, focus } from "../match-day-online-kit";
import { ONLINE_SIZES, packagePrice, type OnlineSize } from "../../src/lib/online-chess-package";
import { STREAM_CREDIT_PACKS } from "../../src/lib/stream-credit-packs";

// Every scene signs in as its own brand-new organiser: the file-scope blank session (directory-kit's freshOrg contract).
test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: "serial" });

const PLAYERS = ["Ana Petrova", "Bo Lindqvist", "Chen Wei", "Dara Okafor"];
const ENTRANTS = PLAYERS.length;

/** A test's budget from what it does: a base, plus a fixed cost per tap and per request round trip, plus the Stripe sheet when it is bought. */
const budget = (taps: number, opts: { stripe?: boolean } = {}): number => 120_000 + taps * 6_000 + (opts.stripe ? 240_000 : 0);

// The leaf's price at a size, camera off (these divisions set no camera policy: the competition's default is off).
const priceOf = (size: OnlineSize): number => packagePrice(size, false);

interface Quote {
  size: number; price: number; owed: number; shortBy: number | null; balance: number; refusal: string | null; covers: boolean;
  back: { pack: number; monthly: number; forfeited: number } | null;
}
const quoteOf = async (page: Page, divisionId: string, size: number, cameras?: boolean): Promise<Quote> => {
  const q = await apiJson<Quote>(page.request, `/api/v1/divisions/${divisionId}/online-package?size=${size}${cameras === undefined ? "" : `&cameras=${cameras}`}`);
  expect(q.status, `quote ${size}: ${JSON.stringify(q.error)}`).toBe(200);
  return q.data!;
};
const balanceOf = async (page: Page, divisionId: string): Promise<number> => (await quoteOf(page, divisionId, ONLINE_SIZES[0]!)).balance;

/** A brand-new Pro organiser with one online division left UNPAID at the smallest size and four linked players, round 1 paired and not opened. */
async function unpaidDivision(page: Page, label: string): Promise<SeededRound> {
  const org = await freshOrg(page, label);
  await dismissConsent(page);
  await setOrgPlanBySql({ orgId: org.orgId }, "pro");
  const r = await seedOnlineRound(page.request, PLAYERS, { open: false, unpaid: true, stage: "swiss" });
  expect(r.boards, "premise: two boards are paired").toHaveLength(ENTRANTS / 2);
  return r;
}

const orgIdOf = (divisionId: string) =>
  withDb(async (sql) => (await sql<{ org_id: string }[]>`select org_id from divisions where id = ${divisionId}`)[0]!.org_id);

/** The unpaid division's size set so the receipt is SHORT by exactly one credit: a size priced above the balance, the balance topped up to one
 *  under its price (the grant is this org's own, nobody else's balance moves). One credit short, so the smallest covering pack is the 1-credit
 *  one, whatever the org held. Returns the size, the one-credit shortfall's pack and the balance before the pack. */
async function setShortByOne(page: Page, divisionId: string): Promise<{ size: OnlineSize; pack: (typeof STREAM_CREDIT_PACKS)[number]; balance: number }> {
  const held = await balanceOf(page, divisionId);
  const found = ONLINE_SIZES.find((s) => priceOf(s) > held);
  expect(found, `premise: some size is priced above a balance of ${held}`).toBeDefined();
  const size: OnlineSize = found!;
  await fundOnlinePayment(divisionId, priceOf(size) - 1 - held);
  const balance = await balanceOf(page, divisionId);
  expect(priceOf(size) - balance, "premise: short by exactly one credit").toBe(1);
  const pack = [...STREAM_CREDIT_PACKS].sort((a, b) => a.credits - b.credits).find((p) => p.credits >= 1)!;
  const patched = await apiJson(page.request, `/api/v1/divisions/${divisionId}`, "PATCH", { online_size: size });
  expect(patched.status, `online_size ${size}: ${JSON.stringify(patched.error)}`).toBeLessThan(300);
  return { size, pack, balance };
}

const packageRow = (divisionId: string) =>
  withDb(async (sql) => {
    const [p] = await sql<{ size: number; paid_at: Date | null; frozen_at: Date | null; credits_paid: number; credits_refunded: number; cameras_paid: boolean }[]>`
      select size, paid_at, frozen_at, credits_paid, credits_refunded, cameras_paid from division_online_packages where division_id = ${divisionId} and refunded_at is null`;
    return p!;
  });

/** Stripe's embedded checkout, paid with the 4242 test card (the SANDBOX): the country is pinned to GB so the postal field is the simple one. */
async function payWithTestCard(page: Page): Promise<void> {
  const frame = page.frameLocator('iframe[src*="stripe.com"]').first();
  const card = frame.getByPlaceholder("1234 1234 1234 1234");
  await card.waitFor({ timeout: 90_000 });
  await frame.getByRole("button", { name: /pay securely with/i }).waitFor({ timeout: 15_000 }).catch(() => undefined);
  await card.fill("4242424242424242");
  await frame.getByPlaceholder("MM / YY").fill("12 / 34");
  await frame.getByRole("textbox", { name: "CVC" }).fill("123");
  await frame.getByPlaceholder("Full name on card").fill("E2E Buyer");
  await frame.getByRole("combobox", { name: "Country or region" }).selectOption("GB");
  await page.waitForTimeout(1500); // choosing a country remounts the address block; typing before it settles is lost
  await frame.getByRole("textbox", { name: "Postal code" }).fill("SW1A 1AA");
  await page.waitForTimeout(500);
  // The sheet is the only scroller and Playwright cannot reach it from inside the cross-origin frame: bring Pay into view.
  await page.getByRole("dialog").locator("div.overflow-y-auto").first().evaluate((el) => { el.scrollTop = el.scrollHeight; }).catch(() => undefined);
  await page.waitForTimeout(400);
  await frame.getByRole("button", { name: "Pay" }).click();
}

/** "{n} credit(s)", the dictionary's one/other pair, as the receipt's rows say it. */
const credits = (n: number): string => fill(n === 1 ? "onlineChess.receipt.credits.one" : "onlineChess.receipt.credits.other", { count: n });

const receipt = (page: Page) => page.getByTestId("online-receipt");
/** The receipt's Fair-play camera answer (Task 15): its radio, and the label around it - the part a person taps (the radio itself is visually hidden). */
const cameraRadio = (page: Page, yes: boolean) => page.getByTestId(yes ? "online-receipt-cameras-yes" : "online-receipt-cameras-no");
const answerCamera = async (page: Page, yes: boolean): Promise<void> => {
  await cameraRadio(page, yes).locator("xpath=..").click();
  await expect(cameraRadio(page, yes), `the ${yes ? "Yes" : "No"} answer is chosen`).toBeChecked();
  await expect(page.getByTestId("online-receipt-cameras")).toHaveAttribute("data-cameras", yes ? "yes" : "no");
};
/** The division's own camera setting ("Camera during online play"), as the database holds it. */
const divisionCameraPolicy = (divisionId: string) =>
  withDb(async (sql) => (await sql<{ p: string | null }[]>`select camera_policy as p from divisions where id = ${divisionId}`)[0]!.p);
/** The pay door's request bodies, recorded as the browser sends them. */
const recordPays = (page: Page, divisionId: string): Record<string, unknown>[] => {
  const bodies: Record<string, unknown>[] = [];
  page.on("request", (q) => {
    if (q.method() === "POST" && q.url().includes(`/divisions/${divisionId}/online-package`)) bodies.push((q.postDataJSON() ?? {}) as Record<string, unknown>);
  });
  return bodies;
};
const confirm = (page: Page) => page.getByTestId("online-receipt-confirm");

test.describe("Online Chess credits: the organiser pays", () => {
  test("A: short of credits, the receipt buys a covering pack in the Stripe sandbox, lands back on itself, pays, and the round then opens free", async ({ page }) => {
    test.setTimeout(budget(30, { stripe: true }));
    const r = await unpaidDivision(page, "ocshort");
    await page.setViewportSize({ width: 1280, height: 900 });

    // A size one credit above the balance, so the receipt really runs short and the smallest covering pack is the 1-credit one. The package is unpaid,
    // so the size moves for free.
    const short = await setShortByOne(page, r.divisionId);
    const { size, pack, balance } = short;

    // The sandbox leg needs a checkout Stripe can open for this pack. CI's dummy key 5xxes, and a sandbox whose pack price has drifted from the table is
    // REFUSED by the checkout's drift guard (502) - an environment fault, not this feature. The status is reported, never a guessed cause; scene A2 below
    // runs the same return without Stripe. A real key and a synced sandbox return 200 and everything below RUNS for real.
    const probe = await apiJson(page.request, "/api/billing/relay-checkout", "POST", {
      orgId: await orgIdOf(r.divisionId), pack: pack.size, returnTo: "division", divisionId: r.divisionId, size,
    });
    test.skip(probe.status >= 500, `Stripe sandbox cannot open the ${pack.size}-credit pack's checkout (probe ${probe.status} ${probe.error?.code ?? ""}); scene A2 covers the return without it`);
    expect(probe.status, `relay-checkout probe: ${JSON.stringify(probe.error)}`).toBe(200);

    // The amber line: held, size and the price, with both its buttons.
    await page.goto(r.fixturesTab);
    const line = page.getByTestId("online-pay-line");
    await expect(line).toBeVisible({ timeout: 30_000 });
    await expect(line).toContainText(fill("onlineChess.payLine.text", { held: ENTRANTS, size }));
    await expect(page.getByTestId("online-pay-line-pay")).toHaveText(fill(priceOf(size) === 1 ? "onlineChess.payLine.pay.one" : "onlineChess.payLine.pay.other", { count: priceOf(size) }));
    await expect(page.getByTestId("online-paid-chip"), "unpaid: no chip").toHaveCount(0);

    // Pay opens the receipt on the stored size; the shortfall is said, the confirm reads Buy credits and the covering pack is named.
    await page.getByTestId("online-pay-line-pay").click();
    await expect(receipt(page)).toHaveAttribute("data-mode", "pay");
    await expect(receipt(page)).toHaveAttribute("data-size", String(size));
    await expect(page.getByTestId("online-receipt-short")).toHaveAttribute("data-pack", String(pack.size));
    await expect(confirm(page)).toHaveText(uiEn["onlineChess.receipt.confirm.buy"]!);
    expect((await packageRow(r.divisionId)).paid_at, "nothing was spent by looking").toBeNull();

    // Buy credits: the chooser, the covering pack preselected; its sandbox checkout takes the card.
    await confirm(page).click();
    const tile = page.getByTestId(`credits-stream-buy-pack-${pack.size}`);
    await expect(tile).toHaveAttribute("data-preselected", "true");
    await tile.click();
    await expect(page.locator('iframe[src*="stripe.com"]').first()).toBeVisible({ timeout: 60_000 });
    await payWithTestCard(page);

    // Back on the division page, on the receipt that was open: the address names the division and the size, the session is the arrival key.
    await page.waitForURL(/\/d\/[^?]+\?[^#]*oc=pay/, { timeout: 120_000 });
    await expect(receipt(page), "the receipt reopens on every ?oc=pay arrival").toBeVisible({ timeout: 60_000 });
    await expect(receipt(page)).toHaveAttribute("data-mode", "pay");
    await expect(receipt(page)).toHaveAttribute("data-size", String(size));
    await expect.poll(() => balanceOf(page, r.divisionId), { message: "the pack's credits landed (reconciled on return)", timeout: 60_000 }).toBe(balance + pack.credits);
    await expect(confirm(page), "covered now: the confirm is a payment").toHaveText(
      fill(priceOf(size) === 1 ? "onlineChess.payLine.pay.one" : "onlineChess.payLine.pay.other", { count: priceOf(size) }),
      { timeout: 30_000 },
    );
    await confirm(page).click();

    // Paid: the chip says so, the amber line is gone, and the ledger holds exactly the price.
    const chip = page.getByTestId("online-paid-chip");
    await expect(chip).toBeVisible({ timeout: 30_000 });
    await expect(chip).toContainText(fill("onlineChess.chip.text", { size }));
    await expect(page.getByTestId("online-pay-line")).toHaveCount(0);
    await expect(page.getByTestId("online-paid-chip-change"), "before the freeze the chip offers Change size").toBeVisible();
    const row = await packageRow(r.divisionId);
    expect([row.size, row.paid_at !== null, row.credits_paid]).toEqual([size, true, priceOf(size)]);
    expect(await balanceOf(page, r.divisionId), "bought, then spent exactly the price").toBe(balance + pack.credits - priceOf(size));

    // Open round 1: paid, so the press asks for nothing - no receipt - and the round opens; then the freeze takes Change size away.
    await openRoundPanel(page, r, "before");
    await page.getByTestId("md-round-open-cta").click();
    const sent = openRoundSent(page, r.stageId);
    await page.getByTestId("md-round-confirm-confirm").click();
    expect((await sent).status(), "a paid package opens on the first press").toBeLessThan(300);
    await expect(receipt(page), "no receipt: nothing is owed").toHaveCount(0);
    await expect(focus(page)).toHaveAttribute("data-state", "checkin", { timeout: 30_000 });
    await page.goto(r.fixturesTab);
    await expect(page.getByTestId("online-paid-chip")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("online-paid-chip-change"), "a round opened: the size is frozen").toHaveCount(0);
    expect((await packageRow(r.divisionId)).frozen_at, "the freeze is stamped").not.toBeNull();
  });

  test("A2: the return from buying credits reopens the receipt on EVERY arrival - keyed on the session, not the page - and the covered receipt pays", async ({ page }) => {
    // What the return does, with no Stripe: the pack's credits are granted by the test (the webhook's ledger row) and the buyer lands on the address the
    // relay-checkout route builds (`?tab=fixtures&oc=pay&checkout=success&session_id=...`). The reconcile of an id Stripe never heard of is `not_ours`
    // and says nothing (it never throws), so the receipt is the page's own.
    test.setTimeout(budget(18));
    const r = await unpaidDivision(page, "ocreturn");
    await page.setViewportSize({ width: 1280, height: 900 });
    const { size, pack, balance } = await setShortByOne(page, r.divisionId);
    const returnUrl = (session: string): string => `${r.fixturesTab}${r.fixturesTab.includes("?") ? "&" : "?"}oc=pay&checkout=success&session_id=${session}`;

    // Before the return: the receipt is short and the chooser offers the covering pack, preselected.
    await page.goto(r.fixturesTab);
    await page.getByTestId("online-pay-line-pay").click();
    await expect(page.getByTestId("online-receipt-short")).toHaveAttribute("data-pack", String(pack.size));
    await confirm(page).click();
    await expect(page.getByTestId(`credits-stream-buy-pack-${pack.size}`)).toHaveAttribute("data-preselected", "true");
    await fundOnlinePayment(r.divisionId, pack.credits);
    expect(await balanceOf(page, r.divisionId), "the pack's credits are in").toBe(balance + pack.credits);

    // Arrival 1: the receipt is open on the stored size, covered.
    await page.goto(returnUrl("cs_test_oc12_arrival_one"));
    await expect(receipt(page), "the receipt reopens on the return").toBeVisible({ timeout: 30_000 });
    await expect(receipt(page)).toHaveAttribute("data-mode", "pay");
    await expect(receipt(page)).toHaveAttribute("data-size", String(size));
    await expect(confirm(page), "covered now: a payment, not Buy credits").toHaveText(
      fill(priceOf(size) === 1 ? "onlineChess.payLine.pay.one" : "onlineChess.payLine.pay.other", { count: priceOf(size) }),
      { timeout: 30_000 },
    );

    // The organiser closes it; a LATER arrival (another session id on the same page) opens it again - the open is keyed on the arrival.
    await page.getByTestId("online-receipt-cancel").click();
    await expect(receipt(page)).toHaveCount(0);
    expect((await packageRow(r.divisionId)).paid_at, "closing spent nothing").toBeNull();
    await page.goto(returnUrl("cs_test_oc12_arrival_two"));
    await expect(receipt(page), "a second arrival opens it again").toBeVisible({ timeout: 30_000 });

    // Confirm: exactly the price leaves, once.
    await confirm(page).click();
    await expect(page.getByTestId("online-paid-chip")).toBeVisible({ timeout: 30_000 });
    const row = await packageRow(r.divisionId);
    expect([row.size, row.paid_at !== null, row.credits_paid]).toEqual([size, true, priceOf(size)]);
    expect(await balanceOf(page, r.divisionId), "the return's pack, then exactly the price").toBe(balance + pack.credits - priceOf(size));
  });

  test("B: pay and open - the first press is refused 402, the receipt opens on the stored size, its confirm re-sends the open with the payment", async ({ page }) => {
    test.setTimeout(budget(16));
    const r = await unpaidDivision(page, "ocpayopen");
    await page.setViewportSize({ width: 1280, height: 900 });
    const stored = ONLINE_SIZES[0]!;
    const price = priceOf(stored);
    await fundOnlinePayment(r.divisionId, price); // a balance that covers it (this org holds only its own grant)
    const before = await balanceOf(page, r.divisionId);

    const posts: Record<string, unknown>[] = [];
    page.on("request", (q) => {
      if (q.method() === "POST" && q.url().includes(`/stages/${r.stageId}/open-round`)) posts.push((q.postDataJSON() ?? {}) as Record<string, unknown>);
    });
    await openRoundPanel(page, r, "before");
    const first = page.waitForResponse((res) => res.request().method() === "POST" && res.url().includes(`/stages/${r.stageId}/open-round`));
    await page.getByTestId("md-round-open-cta").click();
    await page.getByTestId("md-round-confirm-confirm").click();
    const refused = await first;
    expect([refused.status(), ((await refused.json()) as { error?: { code?: string } }).error?.code], "the gate is live: 402 unpaid").toEqual([402, "ONLINE_CHESS_UNPAID"]);

    // The receipt, on the STORED size, in the payAndOpen mode, its total the leaf's price and its confirm the one press that pays and opens.
    await expect(receipt(page)).toBeVisible({ timeout: 30_000 });
    await expect(receipt(page)).toHaveAttribute("data-mode", "payAndOpen");
    await expect(receipt(page)).toHaveAttribute("data-size", String(stored));
    await expect(page.getByTestId("online-receipt-row-total")).toContainText(credits(price));
    await expect(confirm(page)).toHaveText(fill(price === 1 ? "onlineChess.receipt.confirm.payOpen.one" : "onlineChess.receipt.confirm.payOpen.other", { count: price }));
    expect(await balanceOf(page, r.divisionId), "looking spent nothing").toBe(before);

    const second = openRoundSent(page, r.stageId);
    await confirm(page).click();
    const opened = await second;
    expect(opened.status(), "the confirm's open went through").toBeLessThan(300);
    const answer = ((await opened.json()) as { data: { opened: boolean; payment: { applied: boolean; credits: number; size: number } | null } }).data;
    expect(answer.opened).toBe(true);
    expect(answer.payment, "the server says it applied the payment").toMatchObject({ applied: true, credits: price, size: stored });
    expect(posts, "two presses: the bare open, then the open with the payment").toHaveLength(2);
    expect(posts[0], "the first carries no payment").not.toHaveProperty("pay");
    expect(posts[1]!.pay, "the second carries the quote's size and total").toMatchObject({ size: stored, expectedOwed: price });
    expect(await balanceOf(page, r.divisionId), "exactly the price left the balance").toBe(before - price);
    await expect(focus(page)).toHaveAttribute("data-state", "checkin", { timeout: 30_000 });
    expect((await packageRow(r.divisionId)).frozen_at, "paid and opened: frozen").not.toBeNull();
  });

  test("C: pay early WITHOUT the camera, move up from the chip, move down - the credits are shown, then really back - then the camera on at the paid size, and off again with its price back", async ({ page }) => {
    test.setTimeout(budget(44));
    const r = await unpaidDivision(page, "ocmove");
    await page.setViewportSize({ width: 1280, height: 900 });
    const [small, mid] = [ONLINE_SIZES[0]!, ONLINE_SIZES[1]!];
    await fundOnlinePayment(r.divisionId, priceOf(mid) + 5);
    const start = await balanceOf(page, r.divisionId);
    const pays = recordPays(page, r.divisionId);
    expect(await divisionCameraPolicy(r.divisionId), "premise: the division inherits the competition's camera setting (off)").toBeNull();

    // Pay early, at the stored size, from the amber line. The first receipt opens at the division's camera setting (off: No); answering Yes prices the
    // camera, answering No again prices without it - the total follows the answer, and the organiser pays WITHOUT the camera.
    await page.goto(r.fixturesTab);
    await page.getByTestId("online-pay-line-pay").click();
    await expect(receipt(page)).toHaveAttribute("data-mode", "pay");
    await expect(cameraRadio(page, false), "the first receipt opens at the division's setting: No").toBeChecked();
    await expect(page.getByTestId("online-receipt-row-total")).toContainText(credits(priceOf(small)));
    await answerCamera(page, true);
    await expect(page.getByTestId("online-receipt-row-total"), "Yes: the camera price").toContainText(credits(packagePrice(small, true)));
    await answerCamera(page, false);
    await expect(page.getByTestId("online-receipt-row-total"), "No: the price without it").toContainText(credits(priceOf(small)));
    await confirm(page).click();
    await expect(page.getByTestId("online-paid-chip")).toContainText(fill("onlineChess.chip.text", { size: small }), { timeout: 30_000 });
    await expect(page.getByTestId("online-pay-line")).toHaveCount(0);
    expect(await balanceOf(page, r.divisionId)).toBe(start - priceOf(small));
    expect(pays.at(-1), "the pay body carries the No").toMatchObject({ size: small, expectedOwed: priceOf(small), cameras: false });
    expect((await packageRow(r.divisionId)).cameras_paid, "paid without the camera").toBe(false);
    expect(await divisionCameraPolicy(r.divisionId), "No over a division already off writes nothing").toBeNull();

    // Move up from the chip: the list offers sizes, picking the next one prices only the difference.
    await page.getByTestId("online-paid-chip-change").click();
    await expect(receipt(page)).toHaveAttribute("data-mode", "change");
    await page.getByTestId(`online-receipt-size-${mid}`).click();
    await expect(receipt(page)).toHaveAttribute("data-size", String(mid));
    await expect(page.getByTestId("online-receipt-row-total")).toContainText(credits(priceOf(mid) - priceOf(small)));
    await confirm(page).click();
    await expect(page.getByTestId("online-paid-chip")).toContainText(fill("onlineChess.chip.text", { size: mid }), { timeout: 30_000 });
    expect(await balanceOf(page, r.divisionId), "only the difference was taken").toBe(start - priceOf(mid));

    // Move down: the receipt says how many credits come back (the server's own quote), and they are back after the confirm.
    const down = await quoteOf(page, r.divisionId, small);
    expect(down.back, "premise: the quote offers a move down").not.toBeNull();
    const backTotal = down.back!.pack + down.back!.monthly;
    expect(backTotal, "the leaf: the difference between the two prices is what comes back, less nothing forfeited here").toBe(priceOf(mid) - priceOf(small) - down.back!.forfeited);
    await page.getByTestId("online-paid-chip-change").click();
    await page.getByTestId(`online-receipt-size-${small}`).click();
    await expect(receipt(page)).toHaveAttribute("data-size", String(small));
    await expect(confirm(page)).toHaveText(
      backTotal === 0 ? uiEn["onlineChess.receipt.confirm.moveDown.none"]! : fill(backTotal === 1 ? "onlineChess.receipt.confirm.moveDown.one" : "onlineChess.receipt.confirm.moveDown.other", { count: backTotal }),
    );
    const afterUp = await balanceOf(page, r.divisionId);
    await confirm(page).click();
    await expect(page.getByTestId("online-paid-chip")).toContainText(fill("onlineChess.chip.text", { size: small }), { timeout: 30_000 });
    expect(await balanceOf(page, r.divisionId), "the credits the receipt promised are back").toBe(afterUp + backTotal);
    expect((await packageRow(r.divisionId)).size).toBe(small);

    // The Fair-play camera ON at the SAME paid size (spec 8.6, Task 15): the chip opens the change receipt at what was paid (No, no size chosen), and the
    // Yes alone must be enough to get a quote - the camera difference at this size, as the server prices it (the receipt's total is the server's).
    expect((await packageRow(r.divisionId)).cameras_paid, "premise: paid without cameras").toBe(false);
    const camera = await quoteOf(page, r.divisionId, small, true);
    const cameraDiff = packagePrice(small, true) - packagePrice(small, false);
    expect(cameraDiff, "premise: the camera costs credits at the paid size").toBeGreaterThan(0);
    expect(camera.owed, "the server's quote for (paid size, Yes) is the leaf's camera difference").toBe(cameraDiff);
    const beforeCamera = await balanceOf(page, r.divisionId);
    await page.getByTestId("online-paid-chip-change").click();
    await expect(receipt(page)).toHaveAttribute("data-mode", "change");
    await expect(cameraRadio(page, false), "the change receipt opens at what was paid: No").toBeChecked();
    await expect(confirm(page), "nothing chosen yet").toHaveText(uiEn["onlineChess.receipt.confirm.choose"]!);
    await answerCamera(page, true);
    await expect(receipt(page), "the camera is quoted AT the paid size").toHaveAttribute("data-size", String(small));
    await expect(page.getByTestId("online-receipt-row-total")).toContainText(credits(camera.owed));
    await expect(confirm(page)).toHaveText(fill(camera.owed === 1 ? "onlineChess.payLine.pay.one" : "onlineChess.payLine.pay.other", { count: camera.owed }));
    await expect(page.getByTestId("online-package-notice"), "nothing is said about the setting while the organiser is still deciding").toHaveCount(0);
    await confirm(page).click();
    await expect(receipt(page)).toHaveCount(0, { timeout: 30_000 });
    const after = await packageRow(r.divisionId);
    expect([after.size, after.cameras_paid], "the camera is paid, the size did not move").toEqual([small, true]);
    expect(pays.at(-1), "the pay body carries the Yes").toMatchObject({ size: small, expectedOwed: cameraDiff, cameras: true });
    // The answer is the division's setting now, written with the payment, and the page says so after the receipt has closed.
    expect(await divisionCameraPolicy(r.divisionId), "the Yes wrote the division's setting").toBe("required");
    await expect(page.getByTestId("online-package-notice")).toHaveText(fill("onlineChess.receipt.cameras.set", { policy: uiEn["divset.camera.required"]! }));
    expect(await balanceOf(page, r.divisionId), "exactly the camera difference left the balance").toBe(beforeCamera - camera.owed);

    // ...and OFF again before round 1 (Task 15): the change receipt opens at Yes (what was paid); No is a move down at the same size, and the camera
    // price comes back, as the server's quote splits it.
    const off = await quoteOf(page, r.divisionId, small, false);
    expect(off.back, "premise: the quote offers the camera price back").not.toBeNull();
    const offBack = off.back!.pack + off.back!.monthly;
    expect(offBack + off.back!.forfeited, "the leaf: the camera difference is what comes back, less what is forfeited").toBe(cameraDiff);
    await page.getByTestId("online-paid-chip-change").click();
    await expect(receipt(page)).toHaveAttribute("data-mode", "change");
    await expect(cameraRadio(page, true), "the change receipt opens at what was paid: Yes").toBeChecked();
    await answerCamera(page, false);
    // The next size up WITHOUT the camera costs what this one WITH it did: its row nets nothing and says so - never "paid" (it was never bought).
    expect(packagePrice(mid, false), "premise: the next size without the camera is priced as the paid one with it").toBe(packagePrice(small, true));
    await expect(page.getByTestId(`online-receipt-size-${mid}-note`)).toHaveText(uiEn["onlineChess.receipt.size.even"]!);
    await expect(confirm(page)).toHaveText(
      offBack === 0 ? uiEn["onlineChess.receipt.confirm.camerasOff.none"]! : fill(offBack === 1 ? "onlineChess.receipt.confirm.camerasOff.one" : "onlineChess.receipt.confirm.camerasOff.other", { count: offBack }),
    );
    const beforeOff = await balanceOf(page, r.divisionId);
    await confirm(page).click();
    await expect(receipt(page)).toHaveCount(0, { timeout: 30_000 });
    expect(await balanceOf(page, r.divisionId), "the camera price the receipt promised is back").toBe(beforeOff + offBack);
    const offRow = await packageRow(r.divisionId);
    expect([offRow.size, offRow.cameras_paid], "the camera is off, the size did not move").toEqual([small, false]);
    expect(pays.at(-1), "the pay body carries the No and the return").toMatchObject({ size: small, expectedOwed: -cameraDiff, cameras: false });
    expect(await divisionCameraPolicy(r.divisionId), "the No wrote the division's setting").toBe("off");
    await expect(page.getByTestId("online-package-notice")).toHaveText(fill("onlineChess.receipt.cameras.set", { policy: uiEn["divset.camera.off"]! }));
  });

  test("E: the first receipt answered Yes pays WITH the Fair-play camera, and the division's camera setting reads Required", async ({ page }) => {
    test.setTimeout(budget(10));
    const r = await unpaidDivision(page, "occamyes");
    await page.setViewportSize({ width: 1280, height: 900 });
    const small = ONLINE_SIZES[0]!;
    const withCamera = packagePrice(small, true);
    expect(withCamera, "premise: the camera changes the price").toBeGreaterThan(priceOf(small));
    await fundOnlinePayment(r.divisionId, withCamera);
    const start = await balanceOf(page, r.divisionId);
    const pays = recordPays(page, r.divisionId);
    expect((await quoteOf(page, r.divisionId, small, true)).owed, "the server's quote for Yes is the leaf's camera price").toBe(withCamera);

    await page.goto(r.fixturesTab);
    await page.getByTestId("online-pay-line-pay").click();
    await expect(receipt(page)).toHaveAttribute("data-mode", "pay");
    await expect(cameraRadio(page, false), "the first receipt opens at the division's setting: No").toBeChecked();
    await answerCamera(page, true);
    await expect(page.getByTestId("online-receipt-row-total")).toContainText(credits(withCamera));
    await expect(page.getByTestId("online-receipt-row-cameras")).toHaveAttribute("data-cameras", "on");
    await confirm(page).click();
    await expect(page.getByTestId("online-paid-chip")).toContainText(fill("onlineChess.chip.text", { size: small }), { timeout: 30_000 });
    expect(pays.at(-1), "the pay body carries the Yes").toMatchObject({ size: small, expectedOwed: withCamera, cameras: true });
    expect(await balanceOf(page, r.divisionId), "the camera price left the balance").toBe(start - withCamera);
    expect((await packageRow(r.divisionId)).cameras_paid, "the package holds the camera").toBe(true);
    expect(await divisionCameraPolicy(r.divisionId), "the division's camera setting is written with the payment").toBe("required");
    await expect(page.getByTestId("online-package-notice")).toHaveText(fill("onlineChess.receipt.cameras.set", { policy: uiEn["divset.camera.required"]! }));
  });

  test("D: the competition page flags the unpaid online division for its organiser, links to the Fixtures tab, and stops when it is paid", async ({ page }) => {
    test.setTimeout(budget(10));
    const r = await unpaidDivision(page, "ocflag");
    await page.setViewportSize({ width: 1280, height: 900 });
    const competition = `/o/${r.slugs.org}/c/${r.slugs.comp}`;

    await page.goto(competition);
    const flag = page.getByTestId("online-unpaid-flag");
    // Phone card and desktop row both carry it in the markup (the card's is hidden at this width); the visible one is the desktop row's.
    await expect(flag.locator("visible=true"), "an unpaid online division is flagged, once on screen").toHaveCount(1, { timeout: 30_000 });
    await expect(flag, "both layouts carry the flag in the markup").toHaveCount(2);
    await expect(flag.locator("visible=true")).toHaveText(uiEn["onlineChess.flag.text"]!);
    expect(await flag.locator("visible=true").getAttribute("href"), "the flag opens the division on its Fixtures tab").toBe(`${competition}/d/${r.slugs.div}?tab=fixtures`);
    await flag.locator("visible=true").click();
    await expect(page.getByTestId("online-pay-line"), "and lands on the amber line").toBeVisible({ timeout: 30_000 });

    // The public hub never carries it, whoever is reading.
    const hub = await page.request.get(`/live/${r.slugs.org}/${r.slugs.comp}`);
    expect(hub.status(), "premise: the public page is served").toBeLessThan(400);
    expect(await hub.text()).not.toContain("online-unpaid-flag");

    // Paid: the flag goes.
    await fundOnlinePayment(r.divisionId, priceOf(ONLINE_SIZES[0]!));
    const paid = await apiJson(page.request, `/api/v1/divisions/${r.divisionId}/online-package`, "POST", {
      size: ONLINE_SIZES[0], expectedOwed: priceOf(ONLINE_SIZES[0]!),
    });
    expect(paid.status, `pay: ${JSON.stringify(paid.error)}`).toBeLessThan(300);
    await page.goto(competition);
    await expect(page.getByTestId("desk-ledger-row").first(), "premise: the division is on the page").toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("online-unpaid-flag"), "paid: no flag").toHaveCount(0);
  });
});
