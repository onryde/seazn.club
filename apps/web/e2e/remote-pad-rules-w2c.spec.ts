import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { apiJson, seedRosteredFixture, TAG } from "./helpers";
import { DOUBLE_SUBMIT_WINDOW_MS } from "../src/components/v2/scorepad/use-pad-pipeline";
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
