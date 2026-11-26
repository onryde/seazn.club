// "Open in app" on the four panels that show a phone code (spec 2026-11-25 §5.4, plan Tasks 4 and 5): Remote scoring on
// the fixture console (full) and on a Match Day court (compact), the Match Day code sheet, the fixture's Phone stream
// card and the court stream sheet. Driven in a real browser because the whole question is WHO sees the button — an
// Android user agent, after mount, below `md` — which the node unit suite cannot ask, and because the href must be the
// panel's OWN live code: each one is compared with what the server answered, and the scoring one is TAPPED through to the
// real /app/score fallback page (the page a phone without the app gets).
//
// THE BUTTONS ARE BEHIND A BUILD FLAG (`NEXT_PUBLIC_OPEN_IN_APP`, baked into the client bundle; fly.stg.toml sets it,
// production does not). This runner reads the same variable. Under CI it must be "1" — the beforeAll FAILS rather than
// skips, so a job that loses the variable cannot pass by testing nothing. Locally, run it against a build made WITHOUT the
// flag and the same walk asserts ZERO buttons on every panel.
//
// Single-sport (generic) by design: the panels, the codes and the links are fixture-, competition- and court-level and
// read no sport.
import { test, expect, devices, type Locator, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { activeOrg, apiJson, competitionPath, expectNoHorizontalScroll, fixturePath, TAG } from "./helpers";
import { waitForHydration } from "./directory-kit";
import { holdRemoteScoringOpen, openConsolePanel } from "./helpers/console-panels";
import { openCourtOnPhone, openPhoneTab, seedCourtInPlay, seedGenericDivision, seedStreamRig, seedYoutubeDestination } from "./helpers/open-in-app-seeds";
import { captureQrV2Text, type CaptureQrV2 } from "../src/lib/capture-qr";

const ENABLED = process.env.NEXT_PUBLIC_OPEN_IN_APP === "1";
/** When set, each panel is photographed at every width into this directory. */
const SHOTS = process.env.E2E_OIA_SHOTS;

const EN = JSON.parse(readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8")) as Record<string, string>;

const PHONE = { width: 390, height: 844 };
/** The three widths every UI change is held to, after the phone the walk is done on. `md` is 768. */
const WIDTHS = [320, 768, 1280] as const;
const MD = 768;
const STEP_MS = 20_000;

const ANDROID_UA = devices["Pixel 7"].userAgent;
const IPHONE_UA = devices["iPhone 14"].userAgent;

test.use({ viewport: PHONE, hasTouch: true });

test.beforeAll(() => {
  if (process.env.CI) {
    expect(ENABLED, "CI must build AND run with NEXT_PUBLIC_OPEN_IN_APP=1 (the e2e.yml job env): without it nothing here is tested").toBe(true);
  }
});

/** Console errors that name hydration, and any uncaught page error. The button is drawn only after mount, so the server's
 *  markup and the first client render must agree. */
function watchHydration(page: Page): string[] {
  const seen: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && /hydrat|did not match|#418|#423|#425/i.test(m.text())) seen.push(m.text());
  });
  page.on("pageerror", (e) => seen.push(String(e)));
  return seen;
}

/** The panel at every width: no sideways scroll, the button shown below `md` and hidden from it, and — with SHOTS — a
 *  photograph. `anchor` is something of the panel that is on screen at every width (its QR). Ends back on the phone. */
async function acrossWidths(page: Page, panel: Locator, anchor: Locator, name: string): Promise<void> {
  const button = panel.getByTestId("open-in-app");
  let checked = 0;
  for (const width of [PHONE.width, ...WIDTHS]) {
    await page.setViewportSize({ width, height: width < MD ? PHONE.height : 900 });
    await expect(anchor, `${name} at ${width}: the panel is on screen`).toBeVisible();
    if (!ENABLED) await expect(button, `${name} at ${width}: no flag, no button`).toHaveCount(0);
    else if (width < MD) await expect(button, `${name} at ${width}: shown`).toBeVisible();
    else await expect(button, `${name} at ${width}: hidden from md`).toBeHidden();
    await expectNoHorizontalScroll(page);
    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      await anchor.scrollIntoViewIfNeeded();
      // The panel's own box, and the page around it.
      await panel.screenshot({ path: join(SHOTS, `${name}-${width}-panel.png`), animations: "disabled" });
      await page.screenshot({ path: join(SHOTS, `${name}-${width}-page.png`), animations: "disabled" });
    }
    checked += 1;
  }
  expect(checked).toBe(4);
  await page.setViewportSize(PHONE);
}

/** The button a panel must show (flag on) — a plain, reachable, 44px anchor above the QR with the or-scan line between —
 *  or must not (flag off). Returns its href, or null with the flag off. */
async function openInAppHref(panel: Locator, qr: Locator): Promise<string | null> {
  await expect(qr, "premise: the code is on screen").toBeVisible({ timeout: STEP_MS });
  const button = panel.getByTestId("open-in-app");
  if (!ENABLED) {
    await expect(button).toHaveCount(0);
    await expect(panel.getByText(EN["openApp.orScan"]!)).toHaveCount(0);
    return null;
  }
  await expect(button).toHaveCount(1, { timeout: STEP_MS });
  await expect(button).toHaveText(EN["openApp.button"]!);
  await expect(button).toHaveAttribute("rel", "noreferrer");
  expect(await button.getAttribute("target"), "same tab: Chrome hands it to the app").toBeNull();
  const orScan = panel.getByText(EN["openApp.orScan"]!, { exact: true });
  await expect(orScan).toBeVisible();
  // Paint is not reach: a tap at the centre must land on the anchor, and it must be a 44px target.
  await button.scrollIntoViewIfNeeded();
  const reach = await button.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { height: r.height, lands: hit !== null && (hit === el || el.contains(hit)), font: getComputedStyle(el).fontFamily, transform: getComputedStyle(el).textTransform };
  });
  expect(reach.height).toBeGreaterThanOrEqual(44);
  expect(reach.lands, "the tap lands on Open in app").toBe(true);
  expect(reach.transform).toBe("uppercase");
  expect(reach.font, "the condensed display face, not the console's body font").toMatch(/Barlow/i);
  const [b, s, q] = [await button.boundingBox(), await orScan.boundingBox(), await qr.boundingBox()];
  expect(b!.y + b!.height, "the button sits above the or-scan line").toBeLessThanOrEqual(s!.y);
  expect(s!.y + s!.height, "the or-scan line sits above the QR").toBeLessThanOrEqual(q!.y);
  return (await button.getAttribute("href"))!;
}

/** The text a `/app/stream#…` link carries: unpadded base64url of the QR's UTF-8 bytes. */
function streamText(href: string, origin: string): string {
  const prefix = `${origin}/app/stream#`;
  expect(href.startsWith(prefix), `a stream link: ${href.slice(0, prefix.length)}`).toBe(true);
  const fragment = href.slice(prefix.length);
  expect(fragment).toMatch(/^[A-Za-z0-9_-]+$/);
  return Buffer.from(fragment, "base64url").toString("utf8");
}

const originOf = (page: Page) => new URL(page.url()).origin;

/** The hint lines under the button, by key, in order. */
const hints = (panel: Locator) =>
  panel.getByTestId("open-in-app-hint").evaluateAll((els) => els.map((e) => [e.getAttribute("data-hint"), e.textContent]));
const hint = (key: string) => [key, EN[key]!];

// ===========================================================================
// The walk
// ===========================================================================

test.describe("Android phone", () => {
  test.use({ userAgent: ANDROID_UA });

  test("Remote scoring on the fixture console: no button before Create; then the minted link, Score in browser, a reissue, and a tap through to the real /app/score page", async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    const hydration = watchHydration(page);
    const seed = await seedGenericDivision(request, "full");
    await holdRemoteScoringOpen(page);
    await page.goto(await fixturePath(request, seed.fixtureId));
    const pad = page.locator('[data-testid="score-pad"]');
    await expect(pad).toBeVisible({ timeout: STEP_MS });
    await waitForHydration(pad);
    await openConsolePanel(page, "handover");
    const panel = page.locator('[data-role="device-link-panel"]');
    const mint = panel.getByTestId("device-link-mint");
    await expect(mint).toBeVisible({ timeout: STEP_MS });
    await expect(panel.getByTestId("open-in-app"), "no secret yet, no button").toHaveCount(0);

    await mint.click();
    const url = panel.getByTestId("device-link-url");
    await expect(url).toBeVisible({ timeout: STEP_MS });
    const origin = originOf(page);
    const padUrl = (await url.textContent())!.trim();
    const secret = padUrl.slice(`${origin}/score/`.length);
    expect(secret).toMatch(/^dl_[A-Za-z0-9_-]{43}$/);
    const qr = panel.getByTestId("dlink-qr");
    const href = await openInAppHref(panel, qr);
    if (ENABLED) {
      expect(href).toBe(`${origin}/app/score#${secret}`);
      const inBrowser = panel.getByTestId("score-in-browser-link");
      await expect(inBrowser).toHaveText(EN["openApp.scoreInBrowser"]!);
      await expect(inBrowser).toHaveAttribute("href", padUrl);
      await expect(inBrowser).toHaveAttribute("target", "_blank");
      expect((await inBrowser.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    } else {
      await expect(panel.getByTestId("score-in-browser-link")).toHaveCount(0);
    }
    await acrossWidths(page, panel, qr, "scoring-console");

    // Reload: the link is still live but the page no longer holds its secret, so there is nothing to open — no button.
    // Revoke & reissue (offered in this state) mints a new one, and the button follows it.
    await page.reload();
    await expect(pad).toBeVisible({ timeout: STEP_MS });
    await waitForHydration(pad);
    await openConsolePanel(page, "handover");
    await expect(panel.getByTestId("device-link-reissue")).toBeVisible({ timeout: STEP_MS });
    await expect(panel.getByTestId("open-in-app"), "a live link whose secret is not held: no button").toHaveCount(0);
    await panel.getByTestId("device-link-reissue").click();
    await panel.getByTestId("device-link-reissue-confirm").click();
    await expect(url).not.toHaveText(padUrl, { timeout: STEP_MS });
    const nextUrl = (await url.textContent())!.trim();
    const nextHref = await openInAppHref(panel, qr);
    if (ENABLED) {
      expect(nextHref).toBe(`${origin}/app/score#${nextUrl.slice(`${origin}/score/`.length)}`);
      expect(nextHref).not.toBe(href);
      // The real consumer, with no app installed: a tap in the SAME tab loads the /app/score fallback page (the app's
      // absent half of an Android App Link), which strips the secret from history; its own way back returns here.
      const console_ = page.url();
      const tabs = page.context().pages().length;
      await panel.getByTestId("open-in-app").tap();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(EN["openApp.fallback.title"]!, { timeout: STEP_MS });
      await expect(page).toHaveURL(`${origin}/app/score`);
      expect(page.context().pages(), "no new tab").toHaveLength(tabs);
      const back = page.getByTestId("score-in-browser");
      await expect(back).toBeVisible();
      await back.click();
      await expect(page).toHaveURL(console_);
    }
    expect(hydration).toEqual([]);
  });

  test("Match Day: a court's compact Remote scoring panel, then the Match Day code sheet — each button carries the code just made", async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    const hydration = watchHydration(page);
    const seed = await seedCourtInPlay(request, "day");
    await page.goto(await competitionPath(request, seed.competitionId, "/match-day"), { waitUntil: "load" });

    // The court's own scorer link (the compact panel, open while the match has no link).
    await openCourtOnPhone(page, STEP_MS);
    const scorer = page.getByTestId("md-scorer");
    const panel = scorer.locator('[data-role="device-link-panel"]');
    const mint = panel.getByTestId("device-link-mint");
    await expect(mint).toBeVisible({ timeout: STEP_MS });
    await waitForHydration(mint);
    await expect(panel.getByTestId("open-in-app")).toHaveCount(0);
    await mint.click();
    const url = panel.getByTestId("device-link-url");
    await expect(url).toBeAttached({ timeout: STEP_MS });
    const origin = originOf(page);
    const padUrl = (await url.textContent())!.trim();
    const secret = padUrl.slice(`${origin}/score/`.length);
    expect(secret).toMatch(/^dl_[A-Za-z0-9_-]{43}$/);
    const href = await openInAppHref(panel, panel.getByTestId("dlink-qr"));
    if (ENABLED) {
      expect(href).toBe(`${origin}/app/score#${secret}`);
      await expect(panel.getByTestId("score-in-browser-link")).toHaveAttribute("href", padUrl);
    }
    await acrossWidths(page, panel, panel.getByTestId("dlink-qr"), "scoring-matchday-court");

    // The Match Day code (offered on the court list): its link is the md_ token the server just answered.
    await page.goto(await competitionPath(request, seed.competitionId, "/match-day"), { waitUntil: "load" });
    await waitForHydration(page.getByTestId("md-code-open"));
    await page.getByTestId("md-code-open").click();
    const sheet = page.getByTestId("md-code-sheet");
    await expect(sheet.getByTestId("md-code-mint")).toBeVisible({ timeout: STEP_MS });
    await expect(sheet.getByTestId("open-in-app"), "no code yet, no button").toHaveCount(0);
    const answered = page.waitForResponse((r) => r.request().method() === "POST" && /\/match-day-codes(\?|$)/.test(r.url()));
    await sheet.getByTestId("md-code-mint").click();
    const body = (await (await answered).json()) as { data?: { url: string }; url?: string };
    const dayUrl = (body.data?.url ?? body.url)!;
    const token = /\/day\/(md_[A-Za-z0-9_-]+)$/.exec(dayUrl)?.[1];
    expect(token, "premise: the server answered a day URL").toBeTruthy();
    const dayHref = await openInAppHref(sheet, sheet.getByTestId("md-code-qr-image"));
    if (ENABLED) {
      expect(dayHref).toBe(`${origin}/app/day#${token}`);
      await expect(sheet.getByTestId("score-in-browser-link"), "a day code opens only in the app or by QR").toHaveCount(0);
      await expect(sheet.getByTestId("open-in-app-hint")).toHaveCount(0);
    }
    await acrossWidths(page, sheet, sheet.getByTestId("md-code-qr-image"), "matchday-code");
    expect(hydration).toEqual([]);
  });

  test("the court stream sheet: the button carries the court QR's exact text, under it the two lines the sheet can honestly say", async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    const hydration = watchHydration(page);
    const seed = await seedCourtInPlay(request, "court");
    const orgId = (await activeOrg(page)).id;
    const label = `OpenApp channel ${seed.nonce} ${TAG}`;
    await seedYoutubeDestination(orgId, label);
    await page.goto(await competitionPath(request, seed.competitionId, "/match-day"), { waitUntil: "load" });

    await openCourtOnPhone(page, STEP_MS);
    const link = page.getByTestId("md-cs-link");
    await expect(link).toBeVisible({ timeout: STEP_MS });
    await waitForHydration(link);
    await link.click();
    const sheet = page.getByTestId("md-cs-sheet");
    await sheet.getByRole("radio", { name: label }).check();
    await page.getByTestId("md-cs-link-confirm").click();
    const qr = page.getByTestId("md-cs-qr-image");
    await expect(qr).toBeVisible({ timeout: STEP_MS });
    const listed = await apiJson<{ court_id: string; qr: CaptureQrV2 }[]>(request, `/api/v1/competitions/${seed.competitionId}/court-streams`);
    const mine = listed.data?.find((l) => l.court_id === seed.courtId);
    expect(mine?.qr, "premise: the server reads this court's QR back").toBeTruthy();

    // The whole dialog: the sheet's body is swapped for the QR view once linked.
    const dialog = page.getByRole("dialog").filter({ has: qr });
    const href = await openInAppHref(dialog, qr);
    if (ENABLED) {
      expect(streamText(href!, originOf(page))).toBe(captureQrV2Text(mine!.qr));
      expect(await hints(dialog)).toEqual([hint("openApp.stream.checkFirst"), hint("openApp.stream.thenGoLive")]);
    }
    await acrossWidths(page, dialog, qr, "stream-court");
    expect(hydration).toEqual([]);
  });

  test("the fixture's Phone stream card: the button carries the card's own code; its line names a missing destination, then Go live; a reissue moves the link", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const hydration = watchHydration(page);
    const rig = await seedStreamRig(page);
    const answered = page.waitForResponse((r) => r.request().method() === "POST" && /\/stream-code(\?|$)/.test(r.url()), { timeout: 60_000 });
    const path = await fixturePath(page.request, rig.fixtureId);
    await page.goto(path);
    const body = await openPhoneTab(page, STEP_MS);
    const card = body.getByTestId("stream-code-card");
    const qr = card.getByTestId("stream-qr");
    const paste = card.getByTestId("stream-qr-text");
    // No destination yet: the button is there (pairing needs none), and its line says what is missing.
    await expect(body.getByTestId("stream-dest-empty")).toBeVisible({ timeout: STEP_MS });
    const first = await openInAppHref(card, qr);
    const origin = originOf(page);
    const issued = (await (await answered).json()) as { data?: { qr: CaptureQrV2 }; qr?: CaptureQrV2 };
    const issuedQr = (issued.data?.qr ?? issued.qr)!;
    if (ENABLED) {
      expect(streamText(first!, origin)).toBe(captureQrV2Text(issuedQr));
      expect(streamText(first!, origin), "the paste field holds the same bytes the QR does").toBe(await paste.inputValue());
      expect(await hints(card)).toEqual([hint("openApp.stream.needDestination")]);
    } else {
      await expect(card.getByTestId("open-in-app-hint")).toHaveCount(0);
    }
    await acrossWidths(page, card, qr, "stream-fixture-no-destination");

    const target = await apiJson(page.request, `/api/v1/orgs/${rig.orgId}/stream-targets`, "POST", {
      kind: "youtube", label: `OpenApp key ${rig.nonce}`, streamKey: `e2e-${randomBytes(6).toString("hex")}`,
    });
    expect(target.status, JSON.stringify(target.error)).toBeLessThan(300);
    await page.reload();
    await openPhoneTab(page, STEP_MS);
    await expect(body.getByTestId("stream-dest-empty")).toHaveCount(0, { timeout: STEP_MS });
    const ready = await openInAppHref(card, qr);
    if (ENABLED) {
      await expect.poll(() => hints(card), { timeout: STEP_MS }).toEqual([hint("openApp.stream.thenGoLive")]);
    }
    await acrossWidths(page, card, qr, "stream-fixture-ready");

    const before = await paste.inputValue();
    await card.getByTestId("stream-code-reissue").click();
    const confirm = page.getByRole("alertdialog");
    await confirm.getByRole("button", { name: EN["stream.code.reissue.confirm.button"]!, exact: true }).click();
    await expect(paste).not.toHaveValue(before, { timeout: STEP_MS });
    const next = await openInAppHref(card, qr);
    if (ENABLED) {
      expect(next).not.toBe(ready);
      expect(streamText(next!, origin)).toBe(await paste.inputValue());
    }
    expect(hydration).toEqual([]);
  });
});

test.describe("any other phone", () => {
  test.use({ userAgent: IPHONE_UA });

  test("an iPhone sees the panels exactly as before: the codes, and no button, line or app block", async ({ page, request }) => {
    test.setTimeout(150_000);
    const hydration = watchHydration(page);
    const seed = await seedCourtInPlay(request, "iphone");
    await page.goto(await competitionPath(request, seed.competitionId, "/match-day"), { waitUntil: "load" });
    expect(await page.evaluate(() => navigator.userAgent), "premise: the page sees an iPhone").toContain("iPhone");

    await openCourtOnPhone(page, STEP_MS);
    const panel = page.getByTestId("md-scorer").locator('[data-role="device-link-panel"]');
    const mint = panel.getByTestId("device-link-mint");
    await expect(mint).toBeVisible({ timeout: STEP_MS });
    await waitForHydration(mint);
    await mint.click();
    await expect(panel.getByTestId("dlink-qr")).toBeVisible({ timeout: STEP_MS });
    await expect(panel.getByTestId("open-in-app-block")).toHaveCount(0);
    await expect(panel.getByTestId("score-in-browser-link")).toHaveCount(0);
    await expect(panel.getByText(EN["openApp.orScan"]!)).toHaveCount(0);

    await page.goto(await competitionPath(request, seed.competitionId, "/match-day"), { waitUntil: "load" });
    await waitForHydration(page.getByTestId("md-code-open"));
    await page.getByTestId("md-code-open").click();
    const sheet = page.getByTestId("md-code-sheet");
    await sheet.getByTestId("md-code-mint").click();
    await expect(sheet.getByTestId("md-code-qr-image")).toBeVisible({ timeout: STEP_MS });
    await expect(sheet.getByTestId("open-in-app-block")).toHaveCount(0);
    await expect(sheet.getByText(EN["openApp.orScan"]!)).toHaveCount(0);
    expect(hydration).toEqual([]);
  });
});
