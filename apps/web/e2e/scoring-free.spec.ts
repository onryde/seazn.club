import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { football } from "@seazn/engine/sports/football";
import {
  activeOrg,
  apiJson,
  expectNoHorizontalScroll,
  fixturePath,
  invalidateOrgEntitlements,
  loginUi,
  seedRosteredFixture,
  setOrgPlanBySql,
  TAG,
  type RosteredFixture,
} from "./helpers";

// W1 / Task 4 (entitlements v18, owner ruling 2026-08-30) — SCORING DETAIL IS
// FREE, AND THE BAND IS THE SCORER'S OWN CONTROL.
//
// Two claims, and neither is provable anywhere but a browser:
//
//  1. A COMMUNITY-PLAN org records a deep event. `football.card` is band 2 —
//     the tier that used to sit behind `scoring.match_timeline`, so a
//     community org's card tile was withheld and the event 402'd at the
//     scoring door. The band is READ OFF THE ENGINE below rather than typed
//     here, so a module that re-bands the card moves this test with it.
//  2. The Recording chip is a PICKER. Its unit suite
//     (`v3/__tests__/recording-chip.test.tsx`) runs in a node environment with
//     no DOM at all: it cannot see real tap area, the CSS cascade, or whether
//     a pick actually re-filters the grid the scorer is looking at. That is
//     this file's whole job.
//
// THREE WIDTHS, in one test each, because "mobile is designed, not shrunk" is
// a binding rule on this programme and 320 is where scorers actually are. The
// sheet must be reachable and hit-testable at every one of them, with no
// horizontal page scroll.
test.describe.configure({ mode: "parallel" });

const CARD_BAND = football.padSpec!(football.configSchema.parse({})).fidelity["football.card"]!;

function pad(page: Page) {
  return page.locator('[data-testid="score-pad"]');
}
function v3Tile(page: Page, id: string) {
  return pad(page).locator(`[data-tile-id="${id}"]`);
}
function chip(page: Page) {
  return pad(page).locator('[data-role="v3-recording-chip"]');
}
function bandRow(page: Page, band: number) {
  return page.locator(`[data-band="${band}"]`);
}

async function ledgerTypes(request: APIRequestContext, fixtureId: string): Promise<string[]> {
  const res = await apiJson<{ type: string }[]>(request, `/api/v1/fixtures/${fixtureId}/events?since_seq=0`);
  expect(res.status, `ledger read failed: ${JSON.stringify(res.error)}`).toBe(200);
  return (res.data ?? []).map((e) => e.type);
}

async function openLiveConsole(page: Page, fx: RosteredFixture): Promise<void> {
  await page.goto(await fixturePath(page.request, fx.fixtureId));
  await expect(pad(page)).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Start match", exact: true }).click();
  await expect
    .poll(async () => ledgerTypes(page.request, fx.fixtureId), { timeout: 20_000 })
    .toContain("core.start");
}

/** What a thumb at the centre of a control actually lands on. `boundingBox()`
 *  measures PAINT and would call a control 44px tall that another element
 *  covers entirely — the trap this programme has hit before. */
async function hitAt(page: Page, box: { x: number; y: number; width: number; height: number }) {
  return page.evaluate(
    ([x, y]) => {
      const el = document.elementFromPoint(x as number, y as number);
      const owner = el?.closest("[data-band],[data-role]");
      return owner?.getAttribute("data-band") ?? owner?.getAttribute("data-role") ?? el?.tagName ?? null;
    },
    [box.x + box.width / 2, box.y + box.height / 2],
  );
}

for (const width of [320, 768, 1280]) {
  test(`a community org picks its recording band and records a band-${CARD_BAND} event through the pad @ ${width}`, async ({
    page,
  }) => {
    // A card is sheet -> choice -> choice -> dock -> flush, plus a band change
    // and a re-render, on a cold prod server.
    test.setTimeout(180_000);
    await page.setViewportSize({ width, height: 900 });

    // A FRESH org on the community plan — never the shared Pro account this
    // project's storageState carries. The whole point is that the plan no
    // longer decides anything here.
    const email = `e2e-free-${TAG}-${width}-${Math.random().toString(36).slice(2, 7)}@example.com`;
    await loginUi(page, email);
    // requirePageAuth on any server page auto-provisions "My organization" for
    // a member of none; `activeOrg` needs that to have already happened.
    await page.goto("/dashboard", { waitUntil: "load" });
    const org = await activeOrg(page);
    await setOrgPlanBySql({ email }, "community");
    await invalidateOrgEntitlements(page.request, org.id);

    const fx = await seedRosteredFixture(page.request, {
      label: `Free Scoring ${TAG} ${width}`,
      sportKey: "football",
      variantKey: "11-a-side",
      home: [
        { fullName: `FS Booked ${TAG}${width}`, positionKey: "MF" },
        { fullName: `FS Other ${TAG}${width}`, positionKey: "DF" },
      ],
      away: [{ fullName: `FS Away ${TAG}${width}`, positionKey: "GK" }],
    });
    await openLiveConsole(page, fx);
    // THE MATCH IS LIVE IN THE LEDGER; THE PAD MAY NOT HAVE CAUGHT UP YET.
    // `openLiveConsole` polls the API for `core.start`, which says the SERVER
    // accepted it — the client still has to fold and re-render into the live
    // phase, and the counts read below are phase-dependent. Read too early they
    // came back `0/0/2/2` (the pre-match grid) instead of `3/3/10/11`, on two
    // widths out of three: a real race, not a flaky assertion. `card-home` is
    // band 2 AND live-only, so waiting for it proves both halves at once.
    await expect(v3Tile(page, "card-home"), "the pad must have re-rendered into the live phase").toBeVisible({
      timeout: 20_000,
    });

    // --- the chip: a disclosure, opening at the sport's own top band --------
    await expect(chip(page)).toBeVisible({ timeout: 10_000 });
    await expect(chip(page)).toHaveAttribute("aria-haspopup", "dialog");
    await expect(chip(page)).toHaveAttribute("aria-expanded", "false");
    // Football declares band-3 events (`football.shot`), so it opens at 3 —
    // "Every detail", the top of the ladder, not a plan name.
    await expect(chip(page)).toContainText("Recording");
    await expect(chip(page)).toContainText("Every detail");

    // NOTHING IS FOR SALE ON THIS PAD.
    await expect(
      pad(page).getByText(/available on|upgrade|locked|is locked/i),
      "the pad must carry no lock, upsell or plan name anywhere",
    ).toHaveCount(0);

    // --- the tap actually lands on the chip, at this width ------------------
    // The scorepad-v3-mobile-composition wave reorders the recording chip
    // BELOW the ribbon and tiles on phones (`max-md:order-3`, pad-host.tsx) —
    // by design, so the board is what a scorer reaches first. Football's live
    // tile grid is tall enough that the chip sits past this test's own fixed
    // `height: 900` at 320px (measured: chip.y ≈ 889, viewport 900 — off the
    // fold by less than the chip's own height). This test predates that
    // reorder (W1) and never scrolled to reach the chip; a real scorer would.
    // Found while chasing CI e2e run 33747095481, `parallel 2/2` — reproduced
    // locally, not environmental.
    await chip(page).scrollIntoViewIfNeeded();
    const chipBox = (await chip(page).boundingBox())!;
    expect(chipBox.height, `the chip must be a 44px target at ${width}`).toBeGreaterThanOrEqual(44);
    expect(await hitAt(page, chipBox)).toBe("v3-recording-chip");

    // --- the sheet: four bands, the active one checked ----------------------
    await chip(page).click();
    await expect(chip(page)).toHaveAttribute("aria-expanded", "true");
    for (const band of [0, 1, 2, 3]) {
      await expect(bandRow(page, band), `band ${band} must be offered`).toBeVisible();
    }
    await expect(bandRow(page, 3)).toHaveAttribute("aria-checked", "true");
    // W1/Task 4 review, C-1 — the rows' own counts. The first build computed
    // these from a tile list the skin had ALREADY truncated to the current
    // band, so every row above it came back capped and a low-band scorer was
    // told all four options were identical. Read the four captions here rather
    // than trusting a unit fixture: this is the only place they are rendered
    // by the real skin at a real band.
    const rowTexts = await page.locator("[data-band]").evaluateAll((rows) => rows.map((row) => row.textContent ?? ""));
    const rowCaptions = rowTexts.map((text) => text.match(/(\d+)\s+action/)?.[1] ?? null);
    expect(rowCaptions.every((n) => n !== null), `every row must caption a count: ${JSON.stringify(rowTexts)}`).toBe(true);
    expect(
      new Set(rowCaptions).size,
      `the four rows all read alike — the picker is advertising itself as a no-op: ${JSON.stringify(rowTexts)}`,
    ).toBeGreaterThan(1);
    // ...and specifically the top two differ, which a GRID-TILE count cannot
    // express on football: `football.shot` is band 3 and has no tile of its
    // own, so it rides the never-band-filtered More sheet.
    expect(Number(rowCaptions[3]), `band 3 must offer more than band 2: ${JSON.stringify(rowTexts)}`).toBeGreaterThan(
      Number(rowCaptions[2]),
    );
    const rowBox = (await bandRow(page, 1).boundingBox())!;
    expect(rowBox.height, `a sheet row must be a real target at ${width}`).toBeGreaterThanOrEqual(44);
    expect(await hitAt(page, rowBox)).toBe("1");
    await expectNoHorizontalScroll(page);

    // --- picking a LOWER band takes the deep tiles off the board ------------
    await bandRow(page, 1).click();
    await expect(chip(page)).toHaveAttribute("aria-expanded", "false");
    await expect(chip(page)).toContainText("Key moments");
    for (const tile of ["card-home", "card-away", "sub-home", "sub-away", "penalty"]) {
      await expect(
        v3Tile(page, tile),
        `${tile} is a band-${CARD_BAND} action — at band 1 it must not be on the board at all`,
      ).toHaveCount(0);
    }
    // ...but the pad never goes blank: band-0 actions stay.
    await expect(v3Tile(page, "goal-home"), "a goal is band 0 and must survive every pick").toBeVisible();

    // --- and picking it back restores them ---------------------------------
    await chip(page).click();
    await bandRow(page, 3).click();
    await expect(v3Tile(page, "card-home")).toBeVisible({ timeout: 10_000 });

    // --- a COMMUNITY org records the band-2 card, end to end ----------------
    await v3Tile(page, "card-home").click();
    const sheet = pad(page).locator('[data-role="v3-sheet"]');
    await expect(sheet).toBeVisible({ timeout: 10_000 });
    await sheet.locator('[data-choice-option-id="yellow"]').click();
    // The Law 12 offence step is itself band >= 2 — reaching it at all is half
    // the proof that the depth is free.
    await expect(sheet).toContainText("What was the offence?");
    await sheet.locator('[data-choice-option-id="dissent"]').click();
    const dock = pad(page).locator('[data-role="v3-dock"]');
    await expect(dock).toBeVisible({ timeout: 10_000 });
    await dock.getByRole("button", { name: `FS Booked ${TAG}${width}`, exact: true }).click();
    await dock.getByRole("button", { name: "Send now", exact: true }).click();
    await expect
      .poll(async () => ledgerTypes(page.request, fx.fixtureId), { timeout: 20_000 })
      .toContain("football.card");

    await expectNoHorizontalScroll(page);
  });
}

// ---------------------------------------------------------------------------
// W1 / Task 4 review, I-2 — the band must not be read during the first render
// ---------------------------------------------------------------------------
//
// `<ScorePad/>` server-renders: `fixture-console.tsx` mounts it unconditionally,
// with no `mounted` gate and no `ssr: false`. The band was originally seeded
// from `localStorage` inside the `useState` initializer, so a returning scorer
// with a stored non-default band got server HTML built at the default and a
// hydration render built at their pick — React discards the tree and rebuilds
// it client-side on every fixture page view. With a stored "1" on football the
// server emits nine tiles and the client's first pass has three.
//
// UNTESTABLE IN NODE, WHICH IS WHY IT SHIPPED. `apps/web` vitest has no
// `window`, so the very guard that made the old initializer "safe" on the
// server (`typeof window === "undefined"`) also made every unit test agree with
// it. Only a real browser hydrating real server HTML can see this.
test("a stored band does not cost a hydration pass on the next page load", async ({ page }) => {
  test.setTimeout(180_000);
  const hydrationErrors: string[] = [];
  // A PRODUCTION React bundle does not spell the word "hydration". It emits
  // `Minified React error #418` (hydration failed), `#423` (error while
  // hydrating) or `#425` (text content did not match server-rendered HTML)
  // with a link to the decoder — so a filter that only looks for the English
  // sentence passes happily over the very defect it is watching for, which is
  // exactly what the first version of this test did.
  const record = (text: string) => {
    if (/hydrat|did not match|server[- ]rendered HTML|Minified React error #(418|421|423|425)/i.test(text)) {
      hydrationErrors.push(text);
    }
  };
  page.on("console", (msg) => {
    if (msg.type() === "error") record(msg.text());
  });
  page.on("pageerror", (err) => record(err.message));

  const email = `e2e-hyd-${TAG}-${Math.random().toString(36).slice(2, 7)}@example.com`;
  await loginUi(page, email);
  await page.goto("/dashboard", { waitUntil: "load" });
  const org = await activeOrg(page);
  await setOrgPlanBySql({ email }, "community");
  await invalidateOrgEntitlements(page.request, org.id);

  const fx = await seedRosteredFixture(page.request, {
    label: `Free Hydration ${TAG}`,
    sportKey: "football",
    variantKey: "11-a-side",
    home: [{ fullName: `FH Home ${TAG}`, positionKey: "MF" }],
    away: [{ fullName: `FH Away ${TAG}`, positionKey: "GK" }],
  });
  await openLiveConsole(page, fx);

  // Store a NON-DEFAULT band, the way a scorer does — through the control.
  await chip(page).click();
  await bandRow(page, 1).click();
  await expect(chip(page)).toContainText("Key moments", { timeout: 10_000 });
  await expect(v3Tile(page, "card-home")).toHaveCount(0);

  // Now reload. This is the load the defect was about: the server knows
  // nothing of the pick, the client does.
  hydrationErrors.length = 0;
  await page.reload({ waitUntil: "load" });
  await expect(chip(page)).toBeVisible({ timeout: 20_000 });
  // The pick survives — it is read after mount, not during the first render.
  await expect(chip(page)).toContainText("Key moments", { timeout: 10_000 });
  await expect(v3Tile(page, "card-home")).toHaveCount(0);
  expect(hydrationErrors, `React reported a hydration problem: ${hydrationErrors.join(" | ")}`).toEqual([]);
});

const LOCALES = ["en", "es", "fr", "nl"] as const;

/** That locale's OWN copy, read from the shipped dictionary rather than typed
 *  here — so a copy change moves the expectation with it instead of reddening
 *  a test that has gone stale. */
function uiFor(locale: (typeof LOCALES)[number]): Record<string, string> {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`../src/dictionaries/${locale}/ui.json`, import.meta.url)), "utf8"),
  ) as Record<string, string>;
}

// ---------------------------------------------------------------------------
// The band labels have to FIT, in every locale, at the narrowest width
// ---------------------------------------------------------------------------
//
// The chip states the level on ONE line at 44px, so the band label competes
// with a localised lead word for a ~90-125px box at 320. English "Cards & key
// moments" lost that competition (135px of text in a 116px box) and was cut to
// "Key moments" by owner ruling; Dutch "Kaarten en belangrijke momenten" then
// "Belangrijke momenten" lost it too. Guessing which translation fits is how a
// third one gets discovered in production, so this MEASURES all four —
// `scrollWidth > clientWidth` is the browser's own answer, and it is the only
// one that survives a font change, a copy change or a new locale.
//
// Band 1 is the longest label on every locale's ladder, and the French lead
// ("Enregistrement", 14 characters against English's 9) makes French the
// tightest box even though its label is short — which is exactly the kind of
// interaction an eyeball on an English screenshot cannot see.
test("the band-1 label fits the chip at 320 in every locale", async ({ page }) => {
  test.setTimeout(240_000);
  const email = `w1loc-${TAG}-${Math.random().toString(36).slice(2, 7)}@example.com`;
  await loginUi(page, email);
  await page.goto("/dashboard", { waitUntil: "load" });
  const org = await activeOrg(page);
  await setOrgPlanBySql({ email }, "community");
  await invalidateOrgEntitlements(page.request, org.id);
  const fx = await seedRosteredFixture(page.request, {
    label: `W1 Locale ${TAG}`,
    sportKey: "football",
    variantKey: "11-a-side",
    home: [{ fullName: `W1 L Home ${TAG}`, positionKey: "MF" }],
    away: [{ fullName: `W1 L Away ${TAG}`, positionKey: "GK" }],
  });
  const path = await fixturePath(page.request, fx.fixtureId);
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto(path);
  await expect(pad(page)).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Start match", exact: true }).click();
  await expect
    .poll(async () => {
      const r = await apiJson<{ type: string }[]>(page.request, `/api/v1/fixtures/${fx.fixtureId}/events?since_seq=0`);
      return (r.data ?? []).map((e) => e.type);
    }, { timeout: 20_000 })
    .toContain("core.start");

  // Band 1 is the longest label on every locale's ladder; pick it once, and it
  // persists per fixture so each locale reload lands back on it.
  await chip(page).click();
  await page.locator('[data-band="1"]').click();
  await expect(chip(page)).toHaveAttribute("aria-expanded", "false", { timeout: 10_000 });

  // NON-VACUITY, ASSERTED FIRST. Everything below compares what the browser
  // rendered against that locale's own dictionary entry. If the four entries
  // were identical the comparison could not tell a working locale switch from
  // an inert one, which is the exact hole this block closes — so the premise
  // is checked rather than assumed.
  const expected = Object.fromEntries(
    LOCALES.map((locale) => [locale, { lead: uiFor(locale)["pad.recording.lead"], band1: uiFor(locale)["pad.recording.band.1"] }]),
  ) as Record<(typeof LOCALES)[number], { lead: string; band1: string }>;
  expect(
    new Set(LOCALES.map((locale) => `${expected[locale].lead}|${expected[locale].band1}`)).size,
    `the four locales' chip copy is not distinct, so this test cannot witness an inert locale switch: ${JSON.stringify(expected)}`,
  ).toBe(LOCALES.length);

  const results: string[] = [];
  const wrongLocale: string[] = [];
  for (const locale of LOCALES) {
    // `resolveLocale` reads the `seazn_locale` cookie FIRST — above the
    // signed-in user's own locale and above the org default — so this is the
    // lever, not `setOrgLocaleSql` (which sits at priority 3 and is used only
    // for public league pages).
    await page.context().clearCookies({ name: "seazn_locale" });
    await page.context().addCookies([
      { name: "seazn_locale", value: locale, url: new URL(page.url()).origin },
    ]);
    await page.goto(path, { waitUntil: "load" });
    await expect(chip(page)).toBeVisible({ timeout: 20_000 });
    // The value span is the third child: meter, lead, value, chevron.
    const fit = await chip(page)
      .locator("span")
      .nth(2)
      .evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth, text: el.textContent }));
    const lead = await chip(page).locator("span").nth(1).evaluate((el) => el.textContent);
    results.push(
      `LOCALE_FIT_320 ${locale}: lead=${JSON.stringify(lead)} value=${JSON.stringify(fit.text)} scroll=${fit.scroll} client=${fit.client} truncated=${fit.scroll > fit.client}`,
    );
    // WHAT WAS MEASURED, NOT JUST HOW WIDE IT WAS (review I-1, fix round 3).
    // A width test alone passes just as happily when the locale switch is
    // INERT — which is not hypothetical: the first version of this loop drove
    // `setOrgLocaleSql`, which sits below the signed-in user's own locale in
    // `resolveLocale`, and measured English four times while reporting four
    // green rows. Comparing against each locale's OWN dictionary entry is what
    // makes a silent revert of the lever red instead of green. It also pins
    // the positional `span.nth(1)`/`nth(2)` this measurement depends on: if
    // the chip's children are ever re-ordered, these stop matching.
    if (lead !== expected[locale].lead || fit.text !== expected[locale].band1) {
      wrongLocale.push(
        `${locale}: expected lead ${JSON.stringify(expected[locale].lead)} + value ${JSON.stringify(expected[locale].band1)}, ` +
          `rendered lead ${JSON.stringify(lead)} + value ${JSON.stringify(fit.text)}`,
      );
    }
  }
  for (const line of results) console.log(line);
  expect(
    wrongLocale,
    `the chip did not render each locale's own copy — the locale switch is inert or the chip's spans moved:\n${wrongLocale.join("\n")}`,
  ).toEqual([]);
  const truncated = results.filter((line) => line.endsWith("truncated=true"));
  expect(truncated, `the band-1 label overflows the chip at 320:\n${truncated.join("\n")}`).toEqual([]);
});
