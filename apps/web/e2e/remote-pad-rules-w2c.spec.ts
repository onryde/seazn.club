import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { apiJson, fixturePath, seedRosteredFixture, TAG } from "./helpers";
import { DOUBLE_SUBMIT_WINDOW_MS } from "../src/components/v2/scorepad/use-pad-pipeline";
import { HOLD_MS } from "../src/components/v2/scorepad/queue";
import { consentedAnonymousState } from "./scorepad-a11y-kit";

// W2c Task 15 (X-SR-7, owner P-1 "A") — an open remote pad follows a live correction of its match's format.
//
// The FIRST test is the Step 1 probe: it records what the product did BEFORE Task 15 (read is not run) and is kept
// as a probe (memory: keep probe specs). It asserts only the setup; its observations go to the test annotations.
//
// Seeding deviates from the brief's local `addEntrantsViaApi` helper on purpose: the badminton v3 pad stamps the
// side's on-field person into every rally (`scorer`), so the fixture needs a real roster, and `seedRosteredFixture`
// is the repo's own badminton seeding (scorepad-v3-badminton.spec.ts). Same competition → division → entrants →
// league stage → generate → core.start chain, plus persons and lineups.

test.describe.configure({ mode: "parallel" });

interface LiveBadminton {
  fixtureId: string;
  secret: string;
}

async function seedLiveBadminton(request: APIRequestContext, label: string): Promise<LiveBadminton> {
  const fx = await seedRosteredFixture(request, {
    label: `W2c rules ${label} ${TAG}`,
    sportKey: "badminton",
    variantKey: "short",
    entrantKind: "individual",
    home: [{ fullName: `W2c Rules Home ${label} ${TAG}` }],
    away: [{ fullName: `W2c Rules Away ${label} ${TAG}` }],
    emitCoreStart: true,
  });
  const minted = await apiJson<{ secret: string }>(request, `/api/v1/fixtures/${fx.fixtureId}/device-links`, "POST", {
    label: `w2c ${label} ${TAG}`,
  });
  expect(minted.status, `mint device link: ${JSON.stringify(minted.error)}`).toBe(201);
  return { fixtureId: fx.fixtureId, secret: minted.data!.secret };
}

async function ledger(request: APIRequestContext, fixtureId: string): Promise<{ seq: number; type: string }[]> {
  const res = await apiJson<{ seq: number; type: string }[]>(request, `/api/v1/fixtures/${fixtureId}/events?since_seq=0`);
  expect(res.status, `GET events: ${JSON.stringify(res.error)}`).toBe(200);
  return res.data ?? [];
}

async function countEvents(request: APIRequestContext, fixtureId: string): Promise<number> {
  return (await ledger(request, fixtureId)).length;
}

/** The device route mounts the pad WITHOUT the console's `data-testid="score-pad"` wrapper, so device-route
 *  locators are scoped to the page body. */
function pad(page: Page) {
  return page.locator("body");
}

/** One tappable scoreboard half, home first (scorepad-v3-badminton.spec.ts's `half`, same reasoning: a half is a
 *  `<button>` only while it is tappable, so scoping to `button` auto-waits for the live render). */
function half(page: Page, side: "home" | "away") {
  return pad(page).locator('[data-role="v3-scorebug"]').locator(".grid > button").nth(side === "home" ? 0 : 1);
}

async function openRemotePad(page: Page, secret: string): Promise<void> {
  await page.goto(`/score/${secret}`);
  await expect(pad(page).locator('[data-role="v3-scorebug"]')).toBeVisible({ timeout: 20_000 });
}

test("probe: an open remote pad after a live correction (records today's behaviour)", async ({ browser, request }) => {
  test.setTimeout(120_000);
  const seeded = await seedLiveBadminton(request, "probe");
  const ctx = await browser.newContext({ storageState: await consentedAnonymousState() });
  const page = await ctx.newPage();
  await openRemotePad(page, seeded.secret);
  // The pad renders no `pad-format-line` testid (none exists in src), so the probe records the pad's visible text.
  const padTextBefore = (await pad(page).innerText()).replace(/\s+/g, " ").slice(0, 400);

  const fix = await apiJson<{ fixtures: { rules_version: number }[] }>(
    request,
    `/api/v1/fixtures/${seeded.fixtureId}/rules`,
    "PUT",
    { rules: { bestOf: 5 } },
  );
  expect(fix.status, JSON.stringify(fix.error)).toBe(200);
  await page.waitForTimeout(20_000); // the pad's own refresh cadence, if any (probe only)
  const padTextAfter = (await pad(page).innerText()).replace(/\s+/g, " ").slice(0, 400);

  const before = await countEvents(request, seeded.fixtureId);
  await half(page, "home").click();
  await page.waitForTimeout(DOUBLE_SUBMIT_WINDOW_MS + 60);
  // The v3 pad soft-commits: a tap is held before it is sent. Wait long enough for the hold to release and the
  // POST to land (or be refused), then read the ledger back.
  let after = before;
  for (let i = 0; i < 30 && after === before; i++) {
    await page.waitForTimeout(1_000);
    after = await countEvents(request, seeded.fixtureId);
  }
  const state = await apiJson<Record<string, unknown>>(request, `/api/v1/fixtures/${seeded.fixtureId}/state`);
  const stateJson = JSON.stringify(state.data ?? {});
  const bestOfInState = [...stateJson.matchAll(/"bestOf":(\d+)/g)].map((m) => Number(m[1]));
  const banner = await page.getByTestId("pad-rules-changed").count();

  test.info().annotations.push({
    type: "observed",
    description: JSON.stringify({
      rulesVersionAfterFix: fix.data?.fixtures[0]?.rules_version,
      padTextChangedWithoutReload: padTextBefore !== padTextAfter,
      padTextBefore,
      padTextAfter,
      eventsBeforeTap: before,
      eventsAfterTap: after,
      tapAccepted: after > before,
      lastEventType: (await ledger(request, seeded.fixtureId)).at(-1)?.type,
      bestOfInState,
      rulesChangedBanner: banner,
    }),
  });
  await ctx.close();
});

/** The v3 pad holds a tap for `HOLD_MS` before it sends it (soft commit), so every wait on the wire is the hold plus
 *  slack (AGENTS.md class 20: a budget derived from the constant, never typed beside it). */
const WIRE_MS = HOLD_MS + 15_000;

/** The organiser corrects the live match to best of five (version 0 → 1). */
async function correctToBestOf5(request: APIRequestContext, fixtureId: string): Promise<void> {
  const fix = await apiJson<{ fixtures: { rules_version: number }[] }>(request, `/api/v1/fixtures/${fixtureId}/rules`, "PUT", {
    rules: { bestOf: 5 },
  });
  expect(fix.status, JSON.stringify(fix.error)).toBe(200);
  expect(fix.data?.fixtures[0]?.rules_version, "premise: the correction bumped the version").toBe(1);
}

/** The format line the pad must show, read off the API in the reader's language (the context is en), never typed. */
async function formatLineNow(request: APIRequestContext, fixtureId: string): Promise<string> {
  const rules = await apiJson<{ format_line: string | null; rules_version: number }>(request, `/api/v1/fixtures/${fixtureId}/rules`);
  expect(rules.status, JSON.stringify(rules.error)).toBe(200);
  expect(rules.data?.format_line, "premise: badminton's format line exists").toBeTruthy();
  return rules.data!.format_line!;
}

test("X-SR-7 P5: a tap after a correction is refused and writes nothing; the pad says the new format, folds it, and the retaken tap lands", async ({
  browser,
  request,
}) => {
  test.setTimeout(Math.max(120_000, 30_000 + 4 * WIRE_MS));
  const seeded = await seedLiveBadminton(request, "p5");
  const ctx = await browser.newContext({ storageState: await consentedAnonymousState() });
  const page = await ctx.newPage();
  await openRemotePad(page, seeded.secret);
  const scorebug = pad(page).locator('[data-role="v3-scorebug"]');
  await expect(scorebug, "premise: the pad opens on the loaded format").toContainText(/best of 3/i);
  await expect(page.getByTestId("pad-rules-changed"), "the empty case: no correction, no banner").toHaveCount(0);

  await correctToBestOf5(request, seeded.fixtureId);
  const line = await formatLineNow(request, seeded.fixtureId);
  const before = await countEvents(request, seeded.fixtureId);

  // The stale tap: made under version 0, refused by the server, never resent.
  await half(page, "home").click();
  const banner = page.getByTestId("pad-rules-changed");
  await expect(banner, "the pad says the format changed").toBeVisible({ timeout: WIRE_MS });
  await expect(banner).toHaveAttribute("role", "status");
  await expect(banner, "…and what it is now, in the reader's language").toContainText(line);
  await expect(pad(page).locator('[data-role="v3-rejection"]'), "the tap is said NOT recorded").toContainText(/not recorded/i);
  await expect(scorebug, "the pad now folds the corrected format").toContainText(/best of 5/i);
  // Only for a per-screen visual verdict (desktop): a crop from the scorebug to the top of the board into W2A_SHOTS_DIR
  // (the switch bracket-finish.spec.ts uses). Unset in CI, where it does nothing.
  const dir = process.env.W2A_SHOTS_DIR;
  if (dir) {
    const width = page.viewportSize()!.width;
    const sy = await page.evaluate(() => window.scrollY);
    const [sb, tiles] = await Promise.all([scorebug.boundingBox(), pad(page).locator('[data-role="v3-tiles"]').boundingBox()]);
    const top = Math.max(0, sb!.y + sy - 8);
    await page.screenshot({
      path: `${dir}/t15-rules-banner-${width}.png`,
      fullPage: true,
      clip: { x: 0, y: top, width, height: tiles!.y + sy + 120 - top },
    });
  }
  expect(await countEvents(request, seeded.fixtureId), "the refused tap wrote nothing").toBe(before);
  const last = (await ledger(request, seeded.fixtureId)).at(-1);
  expect(last?.type, "the ledger still ends where it did").toBe("core.start");

  // The second call: the scorer retakes it under the new rules — it lands.
  await page.waitForTimeout(DOUBLE_SUBMIT_WINDOW_MS + 60);
  await half(page, "home").click();
  await expect.poll(() => countEvents(request, seeded.fixtureId), { timeout: WIRE_MS }).toBe(before + 1);
  expect((await ledger(request, seeded.fixtureId)).at(-1)?.type).toBe("badminton.rally");

  // Dismissed, it stays gone until the next correction.
  await banner.getByRole("button").click();
  await expect(banner).toHaveCount(0);

  // The chrome follows the pad's reload (`onRulesChanged`): its own "Void my last entry" sends the new version and
  // lands — under version 0 it would be refused.
  const voidMine = page.getByTestId("device-void-mine");
  await expect(voidMine).toBeEnabled({ timeout: WIRE_MS });
  await voidMine.click();
  await expect
    .poll(async () => (await ledger(request, seeded.fixtureId)).at(-1)?.type, { timeout: WIRE_MS })
    .toBe("core.void");
  await ctx.close();
});

test("X-SR-7 P5 (the chrome's own write): a void after a correction is refused, the chrome says the new format and moves the pad onto it", async ({
  browser,
  request,
}) => {
  test.setTimeout(Math.max(120_000, 30_000 + 4 * WIRE_MS));
  const seeded = await seedLiveBadminton(request, "chrome");
  const ctx = await browser.newContext({ storageState: await consentedAnonymousState() });
  const page = await ctx.newPage();
  await openRemotePad(page, seeded.secret);
  // One rally of this device's own, under version 0, so the chrome offers to void it.
  await half(page, "home").click();
  await expect.poll(() => countEvents(request, seeded.fixtureId), { timeout: WIRE_MS }).toBe(2); // core.start + the rally
  const voidMine = page.getByTestId("device-void-mine");
  await expect(voidMine).toBeEnabled({ timeout: WIRE_MS });

  await correctToBestOf5(request, seeded.fixtureId);
  const line = await formatLineNow(request, seeded.fixtureId);
  const tip = await countEvents(request, seeded.fixtureId);
  await voidMine.click();
  const banner = page.getByTestId("pad-rules-changed");
  await expect(banner, "the chrome's refusal raises the same banner").toBeVisible({ timeout: WIRE_MS });
  await expect(banner).toContainText(line);
  await expect(page.getByText(/not recorded/i).first(), "the chrome says the void was not recorded").toBeVisible();
  expect(await countEvents(request, seeded.fixtureId), "the refused void wrote nothing").toBe(tip);
  await expect(pad(page).locator('[data-role="v3-scorebug"]'), "the pad folds the corrected format").toContainText(/best of 5/i);

  // The pad's next tap carries the version the chrome reloaded: it lands.
  await page.waitForTimeout(DOUBLE_SUBMIT_WINDOW_MS + 60);
  await half(page, "away").click();
  await expect.poll(() => countEvents(request, seeded.fixtureId), { timeout: WIRE_MS }).toBe(tip + 1);
  await ctx.close();
});

test("X-SR-7 P5 (the organiser's console pad): the fixture page's pad sends the version it loaded, and after a correction the version it reloads", async ({
  page,
  request,
}) => {
  test.setTimeout(Math.max(120_000, 30_000 + 3 * WIRE_MS));
  // The console path's own seam (the fixture page → `scorePadV2.rulesVersion` → `fixture-console.tsx` → the pad): the
  // remote pad's tests above prove the host's refusal handling; this one proves the console's taps carry the version
  // at all — read off the POST the page sends, against the version the API reports (never a typed constant).
  const seeded = await seedLiveBadminton(request, "console");
  const versionNow = async () => {
    const r = await apiJson<{ rules_version: number }>(request, `/api/v1/fixtures/${seeded.fixtureId}/rules`);
    expect(r.status, JSON.stringify(r.error)).toBe(200);
    return r.data!.rules_version;
  };
  const consolePad = page.locator('[data-testid="score-pad"]');
  const consoleHalf = () => consolePad.locator('[data-role="v3-scorebug"]').locator(".grid > button").first();
  /** Taps home and returns the `rules_version` the console's POST carried (undefined when the body has none). */
  const tapAndReadVersion = async (): Promise<unknown> => {
    const posted = page.waitForRequest((r) => r.method() === "POST" && /\/api\/v1\/fixtures\/[^/]+\/events$/.test(new URL(r.url()).pathname), {
      timeout: WIRE_MS,
    });
    await consoleHalf().click();
    return (JSON.parse((await posted).postData() ?? "{}") as { rules_version?: unknown }).rules_version;
  };

  await page.goto(await fixturePath(request, seeded.fixtureId));
  await expect(consolePad.locator('[data-role="v3-scorebug"]')).toBeVisible({ timeout: 20_000 });
  const loaded = await versionNow();
  const before = await countEvents(request, seeded.fixtureId);
  expect(await tapAndReadVersion(), "the console's tap carries the version the page loaded").toBe(loaded);
  await expect.poll(() => countEvents(request, seeded.fixtureId), { timeout: WIRE_MS }).toBe(before + 1);

  // The second call, after a correction: a fresh load reads the NEW version (not a constant), and its tap lands.
  await correctToBestOf5(request, seeded.fixtureId);
  const corrected = await versionNow();
  expect(corrected, "premise: the correction moved the version").not.toBe(loaded);
  await page.reload();
  await expect(consolePad.locator('[data-role="v3-scorebug"]')).toContainText(/best of 5/i, { timeout: 20_000 });
  await page.waitForTimeout(DOUBLE_SUBMIT_WINDOW_MS + 60);
  expect(await tapAndReadVersion(), "after the correction the console sends the version it reloaded").toBe(corrected);
  await expect.poll(() => countEvents(request, seeded.fixtureId), { timeout: WIRE_MS }).toBe(before + 2);
  await expect(page.getByTestId("pad-rules-changed"), "a fresh load is not a correction under an open pad").toHaveCount(0);
});
