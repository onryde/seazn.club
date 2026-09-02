import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
  activeOrg,
  apiJson,
  expectNoHorizontalScroll,
  fixturePath,
  invalidateOrgEntitlements,
  loginUi,
  seedRosteredFixture,
  setDivisionConfigSql,
  setOrgPlanBySql,
  TAG,
  type RosteredFixture,
} from "./helpers";

// ScoringPad v3, wave R3/task D — the coverage football's conversion OWES
// beyond re-pointing the four pre-existing skin tests and the three
// scorepad-v2.spec.ts console tests at the v3 DOM. Sibling of
// scorepad-v3-cricket.spec.ts, same shape and the same reasoning: the
// conversions prove the old flows still work, this file proves the things the
// v3 pad does that the v2 pad never could.
//
// What lives here and why each one is not provable anywhere else:
//
//  - The DETAIL DOCK's narrowing and its mutations. `buildDock` offers only
//    the SCORING side's on-pitch players (`applyGoal` refuses any other
//    scorer) and the flags are chips on the same payload, so "one goal, four
//    flag combinations, two people" is one tap plus enrichment rather than six
//    tiles. Only a browser can prove a chip's `mutate` reached the SUBMITTED
//    payload rather than a local copy of it.
//  - CARDS: three colours, `second_yellow` its OWN colour (ruling R3-1, the
//    brief's "yellow/red" is recorded false in `_INDEX.md`), and the band-2
//    `Offence?` step. B4 shipped the card CODE — the caution/dismissal swatch
//    and wash — with no e2e at all.
//  - The two INDEPENDENT substitution caps. `maxSubs` counts PLAYERS,
//    `subWindows` counts STOPPAGES; neither implies the other, and a test
//    proving one proves nothing about the other. `subWindows` has NEVER FIRED
//    IN PRODUCTION (v2 sent no `at` on any event), so R3 is the wave that
//    turns it on and this is its first coverage anywhere.
//  - The PER-SPORT IDENTITY (owner ruling R3-6): the fourth official's amber
//    LED board and the card colour codes. Both are `--sport-*` tokens resolved
//    in the browser — a unit test can only assert the class name, never the
//    colour a scorer actually sees.
//  - REACHABILITY of all nine `football.*` event types (ruling R3-4): five on
//    dedicated tiles/sheets, four through the generic More sheet.
//
// Deliberately NOT serial: every test seeds its own fixture (and the one
// band-gated test its own org), so there is no shared state to serialise for.
test.describe.configure({ mode: "parallel" });

function pad(page: Page) {
  return page.locator('[data-testid="score-pad"]');
}

/** A tile by `TileSpec.id` (`data-tile-id`, tile-grid.tsx) — never by
 *  accessible name, which is the concatenation of two LOCALISED strings
 *  ("Goal" + "Home"). Football's board is
 *  `goal-<side>` / `card-<side>` / `sub-<side>` / `period` / `penalty` /
 *  `more`, every side tile spanning half the four-column grid. */
function v3Tile(page: Page, id: string) {
  return pad(page).locator(`[data-tile-id="${id}"]`);
}

function v3Sheet(page: Page) {
  return pad(page).locator('[data-role="v3-sheet"]');
}

function v3Dock(page: Page) {
  return pad(page).locator('[data-role="v3-dock"]');
}

async function ledger(
  request: APIRequestContext,
  fixtureId: string,
): Promise<{ id: string; seq: number; type: string; payload: Record<string, unknown> }[]> {
  const res = await apiJson<{ id: string; seq: number; type: string; payload: Record<string, unknown> }[]>(
    request,
    `/api/v1/fixtures/${fixtureId}/events?since_seq=0`,
  );
  expect(res.status, `ledger read failed: ${JSON.stringify(res.error)}`).toBe(200);
  return res.data ?? [];
}

async function countOf(request: APIRequestContext, fixtureId: string, type: string): Promise<number> {
  return (await ledger(request, fixtureId)).filter((e) => e.type === type).length;
}

/** Dispatch a real ledger event directly, reading `last_seq` fresh each call.
 *  Used for SETUP only — the one action a test is actually about always goes
 *  through the real pad. Same helper, same posture as
 *  scorepad-v3-cricket.spec.ts's own. */
async function postEvent(
  request: APIRequestContext,
  fixtureId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const state = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${fixtureId}/state`);
  if (state.status !== 200 || !state.data) {
    throw new Error(`postEvent(${type}): GET state -> ${state.status} ${JSON.stringify(state.error)}`);
  }
  const res = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: state.data.last_seq,
    type,
    payload,
  });
  if (res.status >= 300) {
    throw new Error(`postEvent(${type}) -> ${res.status} ${JSON.stringify(res.error)}`);
  }
}

/** MERGE a few cfg keys into the division's existing config — never replace
 *  it. `setDivisionConfigSql` writes the column verbatim, so a bare object
 *  would drop every default the division was created with (the same read-then-
 *  write shape gallery.capture.ts's cricket hook already uses for
 *  `reviews.perInnings`). Called BEFORE the first event so no fold has read
 *  the old shape. */
async function mergeDivisionConfig(
  request: APIRequestContext,
  divisionId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const div = await apiJson<{ config: Record<string, unknown> }>(request, `/api/v1/divisions/${divisionId}`);
  if (div.status !== 200 || !div.data) {
    throw new Error(`mergeDivisionConfig: GET division -> ${div.status} ${JSON.stringify(div.error)}`);
  }
  await setDivisionConfigSql(divisionId, { ...div.data.config, ...patch });
}

/** Open the console and take the fixture live through the console's own
 *  "Start match" control — the real organiser flow. */
async function openLiveConsole(page: Page, fx: RosteredFixture): Promise<void> {
  await page.goto(await fixturePath(page.request, fx.fixtureId));
  await expect(pad(page)).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Start match", exact: true }).click();
  await expect
    .poll(async () => (await ledger(page.request, fx.fixtureId)).map((e) => e.type), { timeout: 20_000 })
    .toContain("core.start");
}

/** `openLiveConsole` minus the tap, for a fixture whose `core.start` (and
 *  whatever setup follows it) was already posted through `postEvent`. */
async function openConsoleAlreadyLive(page: Page, fx: RosteredFixture): Promise<void> {
  await page.goto(await fixturePath(page.request, fx.fixtureId));
  await expect(pad(page)).toBeVisible({ timeout: 20_000 });
}

/** The dock's own dismiss control (`pad.dock.dismiss` — "Send now"):
 *  detail-dock.tsx's `dismiss()` calls `releaseHeld`, an IMMEDIATE FLUSH of
 *  the soft-commit hold, never a cancel. Nothing below is testing hold TIMING
 *  (scorepad-v3-cricket.spec.ts owns both sides of that window), so flushing
 *  early sends the same event sooner. */
async function sendHeldNow(page: Page): Promise<void> {
  await v3Dock(page).getByRole("button", { name: "Send now", exact: true }).click();
}

// ---------------------------------------------------------------------------
// The Detail Dock — the goal's enrichment window
// ---------------------------------------------------------------------------

test("football v3: the goal dock narrows to the scoring side, and every chip reaches the SUBMITTED payload", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 FB Dock ${TAG}`,
    sportKey: "football",
    variantKey: "11-a-side",
    home: [
      { fullName: `V3 FBD Scorer ${TAG}`, positionKey: "FW" },
      { fullName: `V3 FBD Assister ${TAG}`, positionKey: "MF" },
    ],
    away: [{ fullName: `V3 FBD Away ${TAG}`, positionKey: "GK" }],
  });
  await openLiveConsole(page, fx);

  await v3Tile(page, "goal-home").click();
  const dock = v3Dock(page);
  await expect(dock).toBeVisible({ timeout: 10_000 });
  await expect(dock).toContainText("Goal detail");

  // THE NARROWING, which is the half no unit test can prove reached the
  // screen: `applyGoal` refuses a scorer who is not on the pitch of `by` (own
  // goals included), so a HOME goal's dock must never offer an AWAY player —
  // otherwise the pad hands the scorer a tap the fold will reject.
  await expect(
    dock.getByRole("button", { name: `V3 FBD Away ${TAG}`, exact: true }),
    "the dock must not offer the other side's players as scorers",
  ).toHaveCount(0);

  // `ownGoal` and `penalty` are booleans on the SAME payload, so they are dock
  // TOGGLES rather than tiles of their own — six goal tiles for four flag
  // combinations is exactly the fan-out the design caps.
  await dock.getByRole("button", { name: "Penalty", exact: true }).click();
  await dock.getByRole("button", { name: `V3 FBD Scorer ${TAG}`, exact: true }).click();
  await dock.getByRole("button", { name: `Assist V3 FBD Assister ${TAG}`, exact: true }).click();
  await sendHeldNow(page);

  await expect.poll(async () => countOf(page.request, fx.fixtureId, "football.goal"), { timeout: 20_000 }).toBe(1);
  const goal = (await ledger(page.request, fx.fixtureId)).find((e) => e.type === "football.goal")!;
  // The SUBMITTED payload, not the optimistic one: three separate chip
  // mutations against a still-held event, all of which had to survive the
  // flush. A dock that mutated a copy would leave `{ by }` alone here and
  // still look right on screen.
  expect(goal.payload).toEqual({
    by: fx.homeEntrantId,
    penalty: true,
    scorer: fx.personIds[`V3 FBD Scorer ${TAG}`]!,
    assist: fx.personIds[`V3 FBD Assister ${TAG}`]!,
  });
});

// ---------------------------------------------------------------------------
// Cards — three colours, second_yellow its own, and the band-2 offence step
// ---------------------------------------------------------------------------

test("football v3: all three card colours are reachable, second_yellow included, with the Offence step", async ({
  page,
}) => {
  // Three full card flows (sheet -> dock -> flush), each with its own hold
  // window; well past the 60s default.
  test.setTimeout(180_000);
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 FB Cards ${TAG}`,
    sportKey: "football",
    variantKey: "11-a-side",
    home: [
      { fullName: `V3 FBC Booked ${TAG}`, positionKey: "MF" },
      { fullName: `V3 FBC Sent ${TAG}`, positionKey: "DF" },
    ],
    away: [{ fullName: `V3 FBC Away ${TAG}`, positionKey: "GK" }],
  });
  await openLiveConsole(page, fx);

  const booked = fx.personIds[`V3 FBC Booked ${TAG}`]!;
  const sent = fx.personIds[`V3 FBC Sent ${TAG}`]!;

  // --- 1. YELLOW, with the offence -----------------------------------------
  await v3Tile(page, "card-home").click();
  const sheet = v3Sheet(page);
  await expect(sheet, "the Card tile must open its side's own sheet").toBeVisible({ timeout: 10_000 });
  await expect(sheet).toContainText("Which card?");
  // R3-1: THREE colours. `second_yellow` is its OWN colour in the engine, it
  // carries its own suspension tariff, and it already has copy in four locales
  // — the brief's "yellow/red" would have left it and all 13 `CardReason`
  // values unreachable from the pad.
  for (const colour of ["yellow", "red", "second_yellow"]) {
    await expect(
      sheet.locator(`[data-choice-option-id="${colour}"]`),
      `the card sheet must offer ${colour}`,
    ).toBeVisible();
  }
  await sheet.locator('[data-choice-option-id="yellow"]').click();

  // The `Offence?` step, band >= 2. This org scores at band 3, so the step is
  // present; the "and NOT below it" half is a DIFFERENT shape and is proved by
  // the community-band test below — at band 0/1 the card tile is withheld
  // entirely (`football.card` is a band-2 event and a tile the ACTIVE band
  // refuses would throw on tap), so the sheet cannot be reached at all.
  await expect(sheet, "band >= 2 must be asked for the Law 12 offence").toContainText("What was the offence?");
  await sheet.locator('[data-choice-option-id="dissent"]').click();

  // The person arrives through the dock, which is what keeps one field to one
  // entry point.
  let dock = v3Dock(page);
  await expect(dock).toBeVisible({ timeout: 10_000 });
  await expect(dock).toContainText("Card detail");
  await dock.getByRole("button", { name: `V3 FBC Booked ${TAG}`, exact: true }).click();
  await sendHeldNow(page);
  await expect.poll(async () => countOf(page.request, fx.fixtureId, "football.card"), { timeout: 20_000 }).toBe(1);

  // --- 2. SECOND YELLOW, only offerable to someone already on one ----------
  await v3Tile(page, "card-home").click();
  await expect(sheet).toBeVisible({ timeout: 10_000 });
  await sheet.locator('[data-choice-option-id="second_yellow"]').click();
  await sheet.locator('[data-choice-option-id="second_caution"]').click();
  dock = v3Dock(page);
  await expect(dock).toBeVisible({ timeout: 10_000 });
  // `applyCard`'s own two refusals, applied to the LIST rather than caught
  // afterwards: a second yellow WITHOUT a prior yellow is refused outright, so
  // the only person this dock may offer is the one already booked.
  await expect(
    dock.getByRole("button", { name: `V3 FBC Sent ${TAG}`, exact: true }),
    "a second yellow must not be offered to a player with no prior yellow",
  ).toHaveCount(0);
  await dock.getByRole("button", { name: `V3 FBC Booked ${TAG}`, exact: true }).click();
  await sendHeldNow(page);
  await expect.poll(async () => countOf(page.request, fx.fixtureId, "football.card"), { timeout: 20_000 }).toBe(2);

  // --- 3. RED, to the other player ------------------------------------------
  await v3Tile(page, "card-home").click();
  await expect(sheet).toBeVisible({ timeout: 10_000 });
  await sheet.locator('[data-choice-option-id="red"]').click();
  await sheet.locator('[data-choice-option-id="violent_conduct"]').click();
  dock = v3Dock(page);
  await expect(dock).toBeVisible({ timeout: 10_000 });
  await dock.getByRole("button", { name: `V3 FBC Sent ${TAG}`, exact: true }).click();
  await sendHeldNow(page);
  await expect.poll(async () => countOf(page.request, fx.fixtureId, "football.card"), { timeout: 20_000 }).toBe(3);

  const cards = (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "football.card");
  expect(cards.map((c) => c.payload.color)).toEqual(["yellow", "second_yellow", "red"]);
  expect(cards[0]!.payload).toEqual({ by: fx.homeEntrantId, color: "yellow", reason: "dissent", person: booked });
  expect(cards[1]!.payload).toEqual({
    by: fx.homeEntrantId,
    color: "second_yellow",
    reason: "second_caution",
    person: booked,
  });
  expect(cards[2]!.payload).toEqual({
    by: fx.homeEntrantId,
    color: "red",
    reason: "violent_conduct",
    person: sent,
  });
});

test("football v3: below band 2 there is no card, sub or penalty tile at all — so no Offence step either", async ({
  page,
}) => {
  test.setTimeout(120_000);
  // The "NOT below band 2" half of ruling R3-1, and it is a TILE-level fact
  // rather than a step-level one. `EVENT_BAND` puts `football.card`,
  // `football.sub` and `football.penalty` at band 2, and `buildTiles`
  // withholds any action whose band exceeds the ACTIVE band — because
  // `filterTilesByBand` (chassis) filters on ENTITLED bands while
  // `createSkinDispatch` refuses anything the resulting view does not declare,
  // so an entitled org scoring at band 0 would otherwise see the tiles and
  // every tap would throw.
  //
  // A FRESH org on the community plan, never the shared Pro account this
  // project's storageState carries: the band comes from ORG ENTITLEMENTS
  // (`resolveFidelityBand`), and every scoring-depth key is
  // `community:false / pro:true`.
  const email = `e2e-fbband-${TAG}-${Math.random().toString(36).slice(2, 7)}@example.com`;
  await loginUi(page, email);
  // requirePageAuth on any server page is what auto-provisions "My
  // organization" for a member of none — `activeOrg` needs that to have
  // already happened.
  await page.goto("/dashboard", { waitUntil: "load" });
  const org = await activeOrg(page);
  await setOrgPlanBySql({ email }, "community");
  await invalidateOrgEntitlements(page.request, org.id);

  const fx = await seedRosteredFixture(page.request, {
    label: `V3 FB Band ${TAG}`,
    sportKey: "football",
    variantKey: "11-a-side",
    home: [
      { fullName: `V3 FBB Home ${TAG}`, positionKey: "FW" },
      { fullName: `V3 FBB Bench ${TAG}`, slot: "bench" },
    ],
    away: [{ fullName: `V3 FBB Away ${TAG}`, positionKey: "GK" }],
  });
  await openLiveConsole(page, fx);

  // Band 0/1 still SCORES — the point is that the pad offers only what the
  // fold will accept, never that it goes blank.
  await expect(v3Tile(page, "goal-home"), "a goal is a band-0 event and must stay").toBeVisible();
  await expect(v3Tile(page, "period"), "a period marker is a band-0 event and must stay").toBeVisible();
  for (const tile of ["card-home", "card-away", "sub-home", "sub-away", "penalty"]) {
    await expect(
      v3Tile(page, tile),
      `${tile} is a band-2 action — below band 2 it must not be on the board at all`,
    ).toHaveCount(0);
  }
});

// ---------------------------------------------------------------------------
// Substitutions — the swap sheet, and TWO independent caps
// ---------------------------------------------------------------------------

test("football v3: the substitution PLAYER cap (maxSubs) refuses in the sport's own words", async ({ page }) => {
  test.setTimeout(120_000);
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 FB MaxSubs ${TAG}`,
    sportKey: "football",
    variantKey: "11-a-side",
    home: [
      { fullName: `V3 MS Start1 ${TAG}`, positionKey: "FW" },
      { fullName: `V3 MS Start2 ${TAG}`, positionKey: "MF" },
      { fullName: `V3 MS Bench1 ${TAG}`, slot: "bench" },
      { fullName: `V3 MS Bench2 ${TAG}`, slot: "bench" },
    ],
    away: [{ fullName: `V3 MS Away ${TAG}`, positionKey: "GK" }],
  });
  // `11-a-side` declares NEITHER cap by default (football.ts's `variants`), so
  // both refusal tests set their own — which is also how a real competition
  // configures Law 3.
  await mergeDivisionConfig(page.request, fx.divisionId, { maxSubs: 1 });
  await postEvent(page.request, fx.fixtureId, "core.start", {});
  // UNSTAMPED, deliberately: an unstamped substitution joins no window and
  // consumes none, so this fixture reaches the PLAYER cap with the WINDOW cap
  // untouched. That isolation is the whole point — the two are independent.
  await postEvent(page.request, fx.fixtureId, "football.sub", {
    by: fx.homeEntrantId,
    off: fx.personIds[`V3 MS Start1 ${TAG}`]!,
    on: fx.personIds[`V3 MS Bench1 ${TAG}`]!,
  });
  await openConsoleAlreadyLive(page, fx);

  await v3Tile(page, "sub-home").click();
  const swap = pad(page).locator('[data-role="v3-swap"]');
  await expect(swap).toBeVisible({ timeout: 10_000 });
  // The refusal is only visible AFTER an off pick — the off step itself does
  // not carry it (recorded in `_INDEX.md` as a known limit of the R3 chassis
  // fix, not an accident). Pinning the flow here is what stops a later change
  // "fixing" that silently.
  await swap.locator(`[data-candidate-id="${fx.personIds[`V3 MS Start2 ${TAG}`]!}"]`).click();
  await expect(
    swap.locator('[data-role="swap-refusal"]'),
    "the player cap must be worded by the SKIN, in the scorer's own language",
  ).toHaveText("1 of 1 substitutions used");
  // Never the chassis fallback, and never the generic empty state: a refusal
  // the module worded silently falling through to "No roster available yet."
  // was defect 4 of the R3 chassis sub-wave.
  await expect(swap).not.toContainText("No roster available yet");
  await expect(swap).not.toContainText("That change isn't allowed right now");
});

test("football v3: the substitution WINDOW cap (subWindows) is a SECOND, independent refusal", async ({ page }) => {
  test.setTimeout(120_000);
  // The cap that has NEVER FIRED IN PRODUCTION. v2 football sent no `at` on
  // any event, so every substitution ever recorded through that pad was
  // unstamped and consumed no window; R3-2 is what turns the cap on, by
  // stamping the swap from the fold's own `asOf`. This is its first coverage.
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 FB SubWindows ${TAG}`,
    sportKey: "football",
    variantKey: "11-a-side",
    home: [
      { fullName: `V3 SW Start1 ${TAG}`, positionKey: "FW" },
      { fullName: `V3 SW Start2 ${TAG}`, positionKey: "MF" },
      { fullName: `V3 SW Bench1 ${TAG}`, slot: "bench" },
      { fullName: `V3 SW Bench2 ${TAG}`, slot: "bench" },
    ],
    away: [{ fullName: `V3 SW Away ${TAG}`, positionKey: "GK" }],
  });
  // maxSubs deliberately GENEROUS: `subPolicy` checks the player cap first, so
  // a low `maxSubs` here would refuse for the wrong reason and this test would
  // pass while proving nothing about windows.
  await mergeDivisionConfig(page.request, fx.divisionId, { maxSubs: 5, subWindows: 1 });
  await postEvent(page.request, fx.fixtureId, "core.start", {});
  await postEvent(page.request, fx.fixtureId, "football.sub", {
    by: fx.homeEntrantId,
    off: fx.personIds[`V3 SW Start1 ${TAG}`]!,
    on: fx.personIds[`V3 SW Bench1 ${TAG}`]!,
    at: { period: "H1", elapsed: 600 },
  });
  // A LATER stamped event moves the fold's `asOf` on. That matters: three
  // substitutions sharing one stamp are ONE window, so a second swap at
  // 10:00 would legally join the window already open and must NOT be refused.
  // Only a stamp naming a NEW moment can exhaust a one-window allowance.
  await postEvent(page.request, fx.fixtureId, "football.card", {
    by: fx.homeEntrantId,
    color: "yellow",
    at: { period: "H1", elapsed: 1200 },
  });
  await openConsoleAlreadyLive(page, fx);

  await v3Tile(page, "sub-home").click();
  const swap = pad(page).locator('[data-role="v3-swap"]');
  await expect(swap).toBeVisible({ timeout: 10_000 });
  await swap.locator(`[data-candidate-id="${fx.personIds[`V3 SW Start2 ${TAG}`]!}"]`).click();
  await expect(
    swap.locator('[data-role="swap-refusal"]'),
    "the WINDOW cap is its own string — 'players used' would be the wrong reason",
  ).toHaveText("Home has used all 1 substitution windows");
});

// ---------------------------------------------------------------------------
// candidateMeta — distinguishing the "who comes off" rows (WS-D, R8 sweep)
//
// R7 shipped the MECHANISM (`CandidateMeta`, types.ts; `renderCandidateRow`,
// context-strip.tsx) and volleyball populated it for its libero picker; this
// is football's first wiring, and a pure `buildSwap` unit test (football.
// test.ts) cannot see whether `renderCandidateRow` actually painted the
// badge — AGENTS.md's own class-2 warning ("pure-builder tests cannot see
// wiring"). Only a browser can prove the row a scorer taps actually shows a
// badge, and shows a DIFFERENT one for two different on-pitch teammates.
// ---------------------------------------------------------------------------

test("football v3: the OFF-step swap rows carry a real, DISTINCT badge per on-pitch player, at 320px and 768px", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 FB Meta ${TAG}`,
    sportKey: "football",
    variantKey: "11-a-side",
    home: [
      // One NUMBERED and one not, on the same pitch: the badge leads with the
      // shirt number and falls back to the position code (owner ruling
      // 2026-09-01), so this pair proves BOTH branches in a browser.
      { fullName: `V3 CM Keeper ${TAG}`, positionKey: "GK", squadNumber: 1 },
      { fullName: `V3 CM Back ${TAG}`, positionKey: "CB" },
      { fullName: `V3 CM Bench1 ${TAG}`, slot: "bench" },
    ],
    away: [{ fullName: `V3 CM Away ${TAG}`, positionKey: "GK" }],
  });
  await postEvent(page.request, fx.fixtureId, "core.start", {});
  await openConsoleAlreadyLive(page, fx);

  await v3Tile(page, "sub-home").click();
  const swap = pad(page).locator('[data-role="v3-swap"]');
  await expect(swap).toBeVisible({ timeout: 10_000 });

  const keeperId = fx.personIds[`V3 CM Keeper ${TAG}`]!;
  const backId = fx.personIds[`V3 CM Back ${TAG}`]!;
  const keeperLead = swap.locator(`[data-candidate-id="${keeperId}"] [data-candidate-lead]`);
  const backLead = swap.locator(`[data-candidate-id="${backId}"] [data-candidate-lead]`);

  // The rows are the OFF step's — the live on-pitch pool, not the kickoff
  // sheet — so this also proves `footballCandidateMeta` is keyed off the
  // same ids `offCandidates` actually offers, not merely present somewhere.
  // The keeper is numbered, so their badge is the NUMBER (it would read "GK"
  // under the old position-led order); the unnumbered centre-back falls back to
  // their position code.
  await expect(keeperLead, "shirt-number badge missing on the OFF-step row a scorer actually taps").toHaveText("1");
  await expect(backLead, "fallback position badge missing on the OFF-step row a scorer actually taps").toHaveText("CB");
  const keeperText = await keeperLead.textContent();
  const backText = await backLead.textContent();
  expect(keeperText, "two different on-pitch players must show DIFFERENT badges").not.toBe(backText);

  // Visual proof at both required widths (AGENTS.md UI bar: 320px + 768px,
  // no horizontal scroll) — screenshotted, not merely asserted on text, since
  // the brief's own concern is a scorer visually distinguishing the rows.
  for (const width of [320, 768] as const) {
    await page.setViewportSize({ width, height: 900 });
    await expect(keeperLead).toBeVisible();
    await expect(backLead).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: test.info().outputPath(`swap-off-step-${width}.png`) });
  }
});

// R3 task-D follow-up (owner-approved matrix): the two refusal tests above
// prove each cap FIRES. Nothing yet proves either cap gets out of the way
// when the fixture is genuinely still under it, and `applySub`'s window
// arithmetic (football.ts:1200-1220) has a THIRD behaviour neither refusal
// test touches — a substitution sharing the CURRENT `asOf` joins the open
// window rather than opening a new one, so it must never be refused even at
// `subWindows: 1`. The four tests below are the "allowed" side of the same
// matrix, plus the rolling-subs carve-out: `lineupPolicy(cfg)` (football.ts
// ~1762) omits `maxSubs` entirely when `rollingSubs` is set, so the PLAYER
// cap is uncapped under rolling — but nothing in `applySub`'s window check
// (football.ts:1211) is gated on `rolling`, so the WINDOW cap still applies
// there. Do not fold that into a "rolling ignores both caps" test — it does not.

/** Opens `tileId`'s swap sheet, picks `offId` then `onId`, and asserts the
 *  sheet never shows a refusal in between — the shared tail of every
 *  "allowed" sub test below (each proves a different reason the caps do not
 *  fire, so the assertion on absence of a refusal is what they all share). */
async function pickAllowedSwap(
  page: Page,
  tileId: string,
  offId: string,
  onId: string,
  refusalContext: string,
): Promise<void> {
  await v3Tile(page, tileId).click();
  const swap = pad(page).locator('[data-role="v3-swap"]');
  await expect(swap).toBeVisible({ timeout: 10_000 });
  await swap.locator(`[data-candidate-id="${offId}"]`).click();
  await expect(swap.locator('[data-role="swap-refusal"]'), refusalContext).toHaveCount(0);
  await swap.locator(`[data-candidate-id="${onId}"]`).click();
}

test("football v3: a substitution under BOTH caps succeeds — no refusal, event lands with its stamp", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 FB Allowed ${TAG}`,
    sportKey: "football",
    variantKey: "11-a-side",
    home: [
      { fullName: `V3 AL Start1 ${TAG}`, positionKey: "FW" },
      { fullName: `V3 AL Bench1 ${TAG}`, slot: "bench" },
    ],
    away: [{ fullName: `V3 AL Away ${TAG}`, positionKey: "GK" }],
  });
  await mergeDivisionConfig(page.request, fx.divisionId, { maxSubs: 3, subWindows: 3 });
  await postEvent(page.request, fx.fixtureId, "core.start", {});
  // Stamps `asOf` so the UI sub below actually carries an `at` (`stampOf`,
  // football.tsx:319, omits `at` while `asOf` is unset) — otherwise this
  // would pass without the window cap ever engaging at all.
  await postEvent(page.request, fx.fixtureId, "football.card", {
    by: fx.homeEntrantId,
    color: "yellow",
    at: { period: "H1", elapsed: 300 },
  });
  await openConsoleAlreadyLive(page, fx);

  await pickAllowedSwap(
    page,
    "sub-home",
    fx.personIds[`V3 AL Start1 ${TAG}`]!,
    fx.personIds[`V3 AL Bench1 ${TAG}`]!,
    "well under both caps — never refused",
  );

  await expect.poll(async () => countOf(page.request, fx.fixtureId, "football.sub"), { timeout: 20_000 }).toBe(1);
  const sub = (await ledger(page.request, fx.fixtureId)).find((e) => e.type === "football.sub")!;
  expect(sub.payload).toMatchObject({ at: { period: "H1", elapsed: 300 } });
});

test("football v3: a second substitution in a NEW window, still under both caps, is not refused", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 FB Combined ${TAG}`,
    sportKey: "football",
    variantKey: "11-a-side",
    home: [
      { fullName: `V3 CC Start1 ${TAG}`, positionKey: "FW" },
      { fullName: `V3 CC Start2 ${TAG}`, positionKey: "MF" },
      { fullName: `V3 CC Bench1 ${TAG}`, slot: "bench" },
      { fullName: `V3 CC Bench2 ${TAG}`, slot: "bench" },
    ],
    away: [{ fullName: `V3 CC Away ${TAG}`, positionKey: "GK" }],
  });
  await mergeDivisionConfig(page.request, fx.divisionId, { maxSubs: 2, subWindows: 2 });
  await postEvent(page.request, fx.fixtureId, "core.start", {});
  // First sub (API, unstamped-window-opening): 1 of 2 players, 1 of 2 windows.
  await postEvent(page.request, fx.fixtureId, "football.sub", {
    by: fx.homeEntrantId,
    off: fx.personIds[`V3 CC Start1 ${TAG}`]!,
    on: fx.personIds[`V3 CC Bench1 ${TAG}`]!,
    at: { period: "H1", elapsed: 600 },
  });
  // A later stamp moves `asOf` on, so the UI sub below opens a SECOND,
  // distinct window rather than joining the first.
  await postEvent(page.request, fx.fixtureId, "football.card", {
    by: fx.homeEntrantId,
    color: "yellow",
    at: { period: "H1", elapsed: 1200 },
  });
  await openConsoleAlreadyLive(page, fx);

  // 2 of 2 players, 2 of 2 windows — exactly AT both caps, still not over.
  await pickAllowedSwap(
    page,
    "sub-home",
    fx.personIds[`V3 CC Start2 ${TAG}`]!,
    fx.personIds[`V3 CC Bench2 ${TAG}`]!,
    "the second window is still within the cap of 2",
  );

  await expect.poll(async () => countOf(page.request, fx.fixtureId, "football.sub"), { timeout: 20_000 }).toBe(2);
  const subs = (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "football.sub");
  expect(subs[1]!.payload).toMatchObject({ at: { period: "H1", elapsed: 1200 } });
});

test("football v3: a rolling-subs variant ignores the PLAYER cap — maxSubs never refuses it", async ({ page }) => {
  test.setTimeout(120_000);
  // `youth` sets `rollingSubs: true` (football.ts variants) and nothing else,
  // so this is the same fixture shape as the other sub tests minus the
  // no-re-entry rule. `subWindows` is deliberately left UNSET here — this
  // test is about the player cap only; football.ts:1211's window check has no
  // `rolling` exemption and is not what this test is proving.
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 FB Rolling ${TAG}`,
    sportKey: "football",
    variantKey: "youth",
    home: [
      { fullName: `V3 RS Start1 ${TAG}`, positionKey: "FW" },
      { fullName: `V3 RS Start2 ${TAG}`, positionKey: "MF" },
      { fullName: `V3 RS Bench1 ${TAG}`, slot: "bench" },
      { fullName: `V3 RS Bench2 ${TAG}`, slot: "bench" },
    ],
    away: [{ fullName: `V3 RS Away ${TAG}`, positionKey: "GK" }],
  });
  await mergeDivisionConfig(page.request, fx.divisionId, { maxSubs: 1 });
  await postEvent(page.request, fx.fixtureId, "core.start", {});
  await openConsoleAlreadyLive(page, fx);

  await pickAllowedSwap(
    page,
    "sub-home",
    fx.personIds[`V3 RS Start1 ${TAG}`]!,
    fx.personIds[`V3 RS Bench1 ${TAG}`]!,
    "the first sub, well under any cap",
  );
  await expect.poll(async () => countOf(page.request, fx.fixtureId, "football.sub"), { timeout: 20_000 }).toBe(1);

  // Second sub: `maxSubs: 1` is already spent by a non-rolling variant's own
  // rules. Under rolling it must not even be checked.
  await pickAllowedSwap(
    page,
    "sub-home",
    fx.personIds[`V3 RS Start2 ${TAG}`]!,
    fx.personIds[`V3 RS Bench2 ${TAG}`]!,
    "rollingSubs makes maxSubs a no-op",
  );
  await expect.poll(async () => countOf(page.request, fx.fixtureId, "football.sub"), { timeout: 20_000 }).toBe(2);
});

test("football v3: a second substitution sharing the CURRENT window is not refused, even at subWindows: 1", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 FB WindowReuse ${TAG}`,
    sportKey: "football",
    variantKey: "11-a-side",
    home: [
      { fullName: `V3 WR Start1 ${TAG}`, positionKey: "FW" },
      { fullName: `V3 WR Start2 ${TAG}`, positionKey: "MF" },
      { fullName: `V3 WR Bench1 ${TAG}`, slot: "bench" },
      { fullName: `V3 WR Bench2 ${TAG}`, slot: "bench" },
    ],
    away: [{ fullName: `V3 WR Away ${TAG}`, positionKey: "GK" }],
  });
  await mergeDivisionConfig(page.request, fx.divisionId, { maxSubs: 5, subWindows: 1 });
  await postEvent(page.request, fx.fixtureId, "core.start", {});
  // Opens the ONLY window this division allows. No stamped event follows, so
  // `asOf` stays at this exact stamp — the UI sub below has nowhere else to
  // land but the SAME window.
  await postEvent(page.request, fx.fixtureId, "football.sub", {
    by: fx.homeEntrantId,
    off: fx.personIds[`V3 WR Start1 ${TAG}`]!,
    on: fx.personIds[`V3 WR Bench1 ${TAG}`]!,
    at: { period: "H1", elapsed: 600 },
  });
  await openConsoleAlreadyLive(page, fx);

  await pickAllowedSwap(
    page,
    "sub-home",
    fx.personIds[`V3 WR Start2 ${TAG}`]!,
    fx.personIds[`V3 WR Bench2 ${TAG}`]!,
    "same window as the one already open — subWindows: 1 must not fire twice",
  );

  await expect.poll(async () => countOf(page.request, fx.fixtureId, "football.sub"), { timeout: 20_000 }).toBe(2);
  const subs = (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "football.sub");
  expect(subs[1]!.payload).toMatchObject({ at: { period: "H1", elapsed: 600 } });
});

test("football v3: an already-substituted player stays VISIBLE on the on-list, with the reason beside the name", async ({
  page,
}) => {
  test.setTimeout(120_000);
  // R2b's binding ruling, reaching football's swap sheet for the first time
  // (defect 4 of the R3 chassis sub-wave): an ineligible candidate is a real
  // native `disabled` button showing WHY, never removed and never merely
  // dimmed. Under `reentry: "none"` — the non-rolling variants — a player who
  // has already come off may not come back on.
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 FB Reentry ${TAG}`,
    sportKey: "football",
    variantKey: "11-a-side",
    home: [
      { fullName: `V3 RE Start1 ${TAG}`, positionKey: "FW" },
      { fullName: `V3 RE Start2 ${TAG}`, positionKey: "MF" },
      { fullName: `V3 RE Bench1 ${TAG}`, slot: "bench" },
      { fullName: `V3 RE Bench2 ${TAG}`, slot: "bench" },
    ],
    away: [{ fullName: `V3 RE Away ${TAG}`, positionKey: "GK" }],
  });
  await postEvent(page.request, fx.fixtureId, "core.start", {});
  await postEvent(page.request, fx.fixtureId, "football.sub", {
    by: fx.homeEntrantId,
    off: fx.personIds[`V3 RE Start1 ${TAG}`]!,
    on: fx.personIds[`V3 RE Bench1 ${TAG}`]!,
  });
  await openConsoleAlreadyLive(page, fx);

  await v3Tile(page, "sub-home").click();
  const swap = pad(page).locator('[data-role="v3-swap"]');
  await expect(swap).toBeVisible({ timeout: 10_000 });
  // The OFF step must be scoped to who is ACTUALLY on the pitch now — not the
  // kickoff sheet. `view.squads` degrades to `initSquads(lineups)` for this
  // sport, which never moves, so without `SwapSlot.offCandidates` this list
  // would offer the player who came off and hide the one who came on.
  await expect(
    swap.locator(`[data-candidate-id="${fx.personIds[`V3 RE Start1 ${TAG}`]!}"]`),
    "the off list must not still offer a player who has already been substituted off",
  ).toHaveCount(0);
  await expect(swap.locator(`[data-candidate-id="${fx.personIds[`V3 RE Bench1 ${TAG}`]!}"]`)).toBeVisible();

  await swap.locator(`[data-candidate-id="${fx.personIds[`V3 RE Start2 ${TAG}`]!}"]`).click();
  const gone = swap.locator(`[data-candidate-id="${fx.personIds[`V3 RE Start1 ${TAG}`]!}"]`);
  await expect(gone, "an ineligible candidate is shown, not removed").toBeVisible();
  await expect(gone).toHaveAttribute("data-blocked", "true");
  await expect(gone).toBeDisabled();
  await expect(gone).toContainText("Already substituted off");
});

// ---------------------------------------------------------------------------
// Per-sport visual identity (owner ruling R3-6) — B4 shipped it with no e2e
// ---------------------------------------------------------------------------

test("football v3: the LED board is football's OWN amber, and the card sheet carries the caution/dismissal codes", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 FB Identity ${TAG}`,
    sportKey: "football",
    variantKey: "11-a-side",
    home: [{ fullName: `V3 FBI Home ${TAG}`, positionKey: "FW" }],
    away: [{ fullName: `V3 FBI Away ${TAG}`, positionKey: "GK" }],
  });
  await openLiveConsole(page, fx);

  // THE SIGNATURE: the fourth official's board, an inset LED panel in the
  // scorebug's band. Asserted as a RESOLVED COLOUR, not as a class name — the
  // whole `--sport-*` token layer only means anything if it reaches the paint,
  // and a unit test can see the class either way. #ffb703 is football's amber;
  // the chassis default this overrides is the product's lime.
  const led = pad(page).locator('[data-strip-tone="led"]').first();
  await expect(led, "the period must render on the LED board, not as plain strip text").toBeVisible();
  await expect(led).toContainText("Period");
  // Prose, never the fold's own token: "H1" is an internal literal of
  // football's `Phase` union, and it is AMBIGUOUS (quarters mode reuses it as
  // quarter 1), so only football's own cfg can read it.
  await expect(led, "the strip says the period in a scorer's words").toContainText("First half");
  await expect(led).not.toContainText("H1");
  expect(await led.evaluate((el) => getComputedStyle(el).color)).toBe("rgb(255, 183, 3)");

  // The token layer enters the DOM in exactly ONE place, the pad root, and
  // inherits from there — so every descendant resolves the sport's palette
  // without any of them knowing which sport is mounted.
  const root = pad(page).locator('[data-role="pad-v3"]');
  expect(await root.evaluate((el) => getComputedStyle(el).getPropertyValue("--sport-led").trim())).toBe("#ffb703");

  // COLOUR AS INFORMATION, the load-bearing argument for the whole ruling: a
  // referee does not raise a "destructive action". Before B4 a red card
  // rendered in the chassis's generic destructive red, indistinguishable from
  // Abandon, and a yellow rendered as neutral.
  await v3Tile(page, "card-home").click();
  const sheet = v3Sheet(page);
  await expect(sheet).toBeVisible({ timeout: 10_000 });
  await expect(sheet.locator('[data-choice-option-id="yellow"]')).toHaveAttribute(
    "data-choice-option-tone",
    "caution",
  );
  await expect(sheet.locator('[data-choice-option-id="red"]')).toHaveAttribute(
    "data-choice-option-tone",
    "dismissal",
  );
  // BOTH, in offence order: a second yellow is a yellow card AND a red one,
  // not a red with a note — the same reason the engine keeps it as its own
  // colour. The chassis draws one swatch per entry and takes the OUTCOME (the
  // last) for the option's wash.
  const second = sheet.locator('[data-choice-option-id="second_yellow"]');
  await expect(second).toHaveAttribute("data-choice-option-tone", "caution dismissal");
  const swatches = second.locator(".pad-card-swatch");
  await expect(swatches).toHaveCount(2);
  expect(await swatches.nth(0).evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(255, 214, 10)");
  expect(await swatches.nth(1).evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(208, 0, 0)");
});

// ---------------------------------------------------------------------------
// Reachability — all nine football.* event types (ruling R3-4)
// ---------------------------------------------------------------------------

test("football v3: all nine football.* event types are reachable — five on the board, four through More", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 FB Nine ${TAG}`,
    sportKey: "football",
    variantKey: "11-a-side",
    home: [
      { fullName: `V3 FBN Home ${TAG}`, positionKey: "FW" },
      { fullName: `V3 FBN Bench ${TAG}`, slot: "bench" },
    ],
    away: [{ fullName: `V3 FBN Away ${TAG}`, positionKey: "GK" }],
  });
  await openLiveConsole(page, fx);

  // FIVE on dedicated surfaces. `dedicatedEventTypes` resolves a tile's event,
  // a sheet's event AND (since R3's chassis fix) a swap slot's declared
  // `eventType`, which is what keeps each of these off the More sheet as a
  // second, un-narrowed route to the same action.
  for (const tile of ["goal-home", "goal-away", "card-home", "card-away", "sub-home", "sub-away", "period", "penalty"]) {
    await expect(v3Tile(page, tile), `${tile} must be on the board`).toBeVisible();
  }

  // FOUR through the generic More sheet (ruling R3-4) — never band-filtered,
  // deliberately: More is where a LOW-band org reaches its only recording
  // actions.
  await v3Tile(page, "more").click();
  const sheet = v3Sheet(page);
  await expect(sheet).toBeVisible({ timeout: 10_000 });
  for (const label of ["Shot", "Sin bin", "Sin bin return"]) {
    await expect(
      sheet.getByRole("button", { name: label, exact: true }),
      `${label} must be reachable through More`,
    ).toBeVisible();
  }
  // And the five dedicated ones must NOT also appear here as generic forms —
  // the duplicate `dedicatedEventTypes` closed for the swap path.
  for (const label of ["Goal", "Card", "Substitution", "Period marker", "Penalty"]) {
    await expect(
      sheet.getByRole("button", { name: label, exact: true }),
      `${label} already has a dedicated surface and must not be duplicated in More`,
    ).toHaveCount(0);
  }

  // Reachability proved by OFFER above; proved by SUBMISSION here, once,
  // through the generic form — otherwise "reachable" would only mean "a button
  // exists". `football.shot` is the band-3 event, so this also proves the More
  // sheet dispatches at the top band.
  await sheet.getByRole("button", { name: "Shot", exact: true }).click();
  await sheet.getByLabel("Outcome").selectOption("blocked");
  await sheet.getByLabel("At period").selectOption("H1");
  await sheet.getByLabel("At elapsed", { exact: true }).fill("120");
  await sheet.getByRole("button", { name: "Home", exact: true }).click();
  await sheet.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect.poll(async () => countOf(page.request, fx.fixtureId, "football.shot"), { timeout: 20_000 }).toBe(1);
  const shot = (await ledger(page.request, fx.fixtureId)).find((e) => e.type === "football.shot")!;
  expect(shot.payload).toMatchObject({ by: fx.homeEntrantId, outcome: "blocked" });
});

// R3.5 (Tasks D, E, F, J) — this REPLACES the pre-wave test asserting
// `football.shootout.kick` was reachable ONLY through the generic More sheet.
// That claim is now FALSE (Task J gives it a dedicated tile+sheet pair, so
// it is de-duplicated out of More by `dedicatedEventTypes` exactly like
// Goal/Card/Sub/Period/Penalty already were) — this is the coverage Task J's
// own brief calls for: "drive an entire decider through the board, tile taps
// only", asserting the tally, the cue and the reachability change together,
// since the four tasks all edit the same functions and a defect at their
// seam would not show up testing any one task's slice alone.
test("football v3: kick tiles drive the shoot-out — reachable, tallied, cued, side-attributed, and no longer duplicated in More (R3.5 D/E/F/J)", async ({
  page,
}) => {
  test.setTimeout(180_000);
  // The shoot-out panel is gated TWICE: `cfg.shootout` decides whether the
  // FORMAT can ever reach one (a league fixture never declares it, so the
  // panel is simply absent), and a runtime gate on `state.phase === "SHOOTOUT"`
  // decides whether it is reachable right now. Both have to be satisfied, so
  // this needs its own fixture and its own seeded route to the kicks.
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 FB Shootout ${TAG}`,
    sportKey: "football",
    variantKey: "11-a-side",
    home: [{ fullName: `V3 FBS Home ${TAG}`, positionKey: "FW" }],
    away: [{ fullName: `V3 FBS Away ${TAG}`, positionKey: "GK" }],
  });
  // No extra time: with `extraTime.enabled` false, a level score at FT goes
  // STRAIGHT to the kicks (`resolveFullTime`), which is the shortest legal
  // route to the phase this test needs. `halfMinutes` is spelled out even
  // though it is irrelevant here: `extraTime` is a plain `z.object` whose two
  // fields are BOTH required, with the DEFAULT applied only to the whole
  // object — `{ enabled: false }` alone fails the cfg parse, and because the
  // division config is written by SQL, nothing validates it on the way in:
  // the failure surfaces as the console rendering no pad at all, which reads
  // as a pad defect. (Measured, this session.) A goal each keeps the
  // scorebug's `big` figures non-zero, so F3's assertion below is checking
  // the SECOND figure, not the only one.
  await mergeDivisionConfig(page.request, fx.divisionId, {
    shootout: true,
    extraTime: { enabled: false, halfMinutes: 15 },
  });
  await postEvent(page.request, fx.fixtureId, "core.start", {});
  await postEvent(page.request, fx.fixtureId, "football.goal", { by: fx.homeEntrantId });
  await postEvent(page.request, fx.fixtureId, "football.goal", { by: fx.awayEntrantId });
  await postEvent(page.request, fx.fixtureId, "football.period", { phase: "HT" });
  await postEvent(page.request, fx.fixtureId, "football.period", { phase: "FT" });
  await openConsoleAlreadyLive(page, fx);

  // F6/F7/F17 — kick tiles present, occupying the space Goal vacates; cards
  // remain legal (SHOOTOUT is a phase of the MATCH, not of play).
  await expect(pad(page).locator('[data-strip-tone="led"]').first()).toContainText("Shoot-out");
  await expect(v3Tile(page, "goal-home"), "the ball is not in play during the kicks").toHaveCount(0);
  await expect(v3Tile(page, "kick-home")).toBeVisible();
  await expect(v3Tile(page, "kick-away")).toBeVisible();
  await expect(v3Tile(page, "card-home")).toBeVisible();

  // F9 — no cue, and NEITHER tile disabled, before the first kick: either
  // side may start.
  await expect(pad(page).locator('[data-strip-item-id="nextKicker"]')).toHaveCount(0);
  await expect(v3Tile(page, "kick-home")).toHaveAttribute("data-tile-disabled", "false");
  await expect(v3Tile(page, "kick-away")).toHaveAttribute("data-tile-disabled", "false");

  // R3.5/Task J — the ninth type is no longer reachable through the generic
  // More sheet at all now that it is dedicated; this is the corrected claim
  // replacing the false one this test used to make.
  //
  // R7-39 (owner-approved) went further, in the chassis: `suppressEmptyMoreTile`
  // now hides the More tile itself once its own sheet would be a guaranteed
  // dead end — and at SHOOTOUT, kick and card are the only two action types
  // this phase/band offers, both already dedicated tiles. So More isn't just
  // missing "Shoot-out kick" inside its sheet, the tile is ABSENT entirely —
  // a stronger proof than opening a sheet and finding one button missing from
  // it. Confirmed against the real page: at SHOOTOUT the tile row is exactly
  // Shoot-out kick (home/away) + Card (home/away), no More tile at all.
  await expect(v3Tile(page, "more"), "no dead-end More tile once its only content is dedicated").toHaveCount(0);

  // Tap the kick tile — a real board interaction, not an API post.
  await v3Tile(page, "kick-home").click();
  const kickSheet = v3Sheet(page);
  await expect(kickSheet).toBeVisible({ timeout: 10_000 });
  await kickSheet.locator('[data-choice-option-id="scored"]').click();
  await expect
    .poll(async () => countOf(page.request, fx.fixtureId, "football.shootout.kick"), { timeout: 20_000 })
    .toBe(1);

  // F3 — the scorebug's SECOND figure moves; the board now agrees with its
  // own headline instead of showing the frozen 1-1 regulation score twice.
  await expect(pad(page).locator("[data-half-sub]").first()).toHaveText("(1)");
  // F10 — the cue names Away, and Home's own tile is now disabled — never
  // absent, so the board never reads as broken.
  await expect(pad(page).locator('[data-strip-item-id="nextKicker"]')).toContainText("Away");
  await expect(v3Tile(page, "kick-home")).toHaveAttribute("data-tile-disabled", "true");
  await expect(v3Tile(page, "kick-away")).toHaveAttribute("data-tile-disabled", "false");

  // F12 — the SCORER's Activity panel (the one carrying the Void buttons, as
  // opposed to the read-only audit table which already named the side) now
  // names the side too. Rows are newest-first, so the first row is this kick.
  //
  // PAGE-WIDE, not pad-scoped (R7/C1, gallery.capture.ts's own `padEventRows`
  // fix): C1 moved the ledger OUT of the pad root on the console (`ScorePad`'s
  // `hideActivity`), so `v3-activity-slot` — the pad-host-internal wrapper —
  // never renders here at all; `[data-role="v3-activity"]` is the panel's own
  // root (activity.tsx), rendered exactly once regardless of lane.
  const activity = page.locator('[data-role="v3-activity"]');
  await expect(activity.locator('[data-role="v3-activity-row"]').first()).toContainText("Home");
  await expect(activity.locator('[data-role="v3-activity-row"]').first()).toContainText("Scored");

  // Away kicks and misses.
  await v3Tile(page, "kick-away").click();
  const kickSheet2 = v3Sheet(page);
  await expect(kickSheet2).toBeVisible({ timeout: 10_000 });
  await kickSheet2.locator('[data-choice-option-id="missed"]').click();
  await expect
    .poll(async () => countOf(page.request, fx.fixtureId, "football.shootout.kick"), { timeout: 20_000 })
    .toBe(2);

  // F13 — the missed kick's row also names the side.
  await expect(activity.locator('[data-role="v3-activity-row"]').first()).toContainText("Away");
  await expect(activity.locator('[data-role="v3-activity-row"]').first()).toContainText("Missed");

  // The cue reverts to Home once kicks are tied 1-1 taken (`expectedKicker`
  // falls back to whoever kicked first), and the tiles swap which one is
  // disabled — the same mechanism F14's void-reversion relies on.
  await expect(pad(page).locator('[data-strip-item-id="nextKicker"]')).toContainText("Home");
  await expect(v3Tile(page, "kick-home")).toHaveAttribute("data-tile-disabled", "false");
  await expect(v3Tile(page, "kick-away")).toHaveAttribute("data-tile-disabled", "true");

  // Zero WCAG AA violations on the PAD — never scanned before. Scoped to
  // `[data-testid="score-pad"]`, the SAME `pad()` element every other
  // assertion in this file already targets — matching the repo's two
  // existing axe precedents exactly (scorepad-skins.spec.ts's
  // `expectPadAxeClean`, v6-sports.spec.ts's icehockey scan) rather than
  // inventing a third invocation shape. An UNSCOPED first run of this exact
  // check found a real, pre-existing, deterministic failure OUTSIDE the pad
  // (`fixture-console.tsx`'s "vs" separator, `text-slate-400` on white,
  // ~2.6:1) — precisely the "wider fixture console chrome" debt
  // scorepad-skins.spec.ts's own header comment already names as
  // out-of-scope for a pad-focused pass, not something this task introduced
  // or should widen its blast radius to fix.
  const axe = await new AxeBuilder({ page })
    .include('[data-testid="score-pad"]')
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  const blocking = axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(
    blocking.map((v) => `${v.id} — ${v.nodes[0]?.html}`),
    "axe serious/critical on the shoot-out pad",
  ).toEqual([]);
});

// R3.5/Task G (F18) — home scores 3 in a row, away misses 3 in a row: decided
// after the 6th kick (3-0, away's 2 remaining attempts can no longer reach
// home's lead of 3) — the exact arithmetic football.test.ts's own "enforces
// kick alternation and early decision" golden pins at the engine level.
async function decideByShootout(request: APIRequestContext, fx: RosteredFixture): Promise<void> {
  await postEvent(request, fx.fixtureId, "core.start", {});
  await postEvent(request, fx.fixtureId, "football.period", { phase: "HT" });
  await postEvent(request, fx.fixtureId, "football.period", { phase: "FT" });
  const kicks: [string, boolean][] = [
    [fx.homeEntrantId, true],
    [fx.awayEntrantId, false],
    [fx.homeEntrantId, true],
    [fx.awayEntrantId, false],
    [fx.homeEntrantId, true],
    [fx.awayEntrantId, false],
  ];
  for (const [by, scored] of kicks) {
    await postEvent(request, fx.fixtureId, "football.shootout.kick", { by, scored });
  }
}

test("football v3: a shoot-out decision names the winner and the method — public page, organiser console, and the share text (R3.5/Task G, F18)", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 FB Decided ${TAG}`,
    sportKey: "football",
    variantKey: "11-a-side",
    home: [{ fullName: `V3 FBD Home ${TAG}`, positionKey: "FW" }],
    away: [{ fullName: `V3 FBD Away ${TAG}`, positionKey: "GK" }],
  });
  await mergeDivisionConfig(page.request, fx.divisionId, {
    shootout: true,
    extraTime: { enabled: false, halfMinutes: 15 },
  });
  await decideByShootout(page.request, fx);

  const decided = await apiJson<{
    status: string;
    outcome: { kind: string; winner: string; loser: string; method: string };
  }>(page.request, `/api/v1/fixtures/${fx.fixtureId}`);
  expect(decided.status, `GET fixture -> ${decided.status}`).toBe(200);
  expect(decided.data!.status).toBe("decided");
  expect(decided.data!.outcome).toEqual({
    kind: "win",
    winner: fx.homeEntrantId,
    loser: fx.awayEntrantId,
    method: "shootout",
  });

  const org = await activeOrg(page);
  const comp = await apiJson<{ slug: string }>(page.request, `/api/v1/competitions/${fx.competitionId}`);
  const division = await apiJson<{ slug: string }>(page.request, `/api/v1/divisions/${fx.divisionId}`);
  const publicPath = `/shared/${org.slug}/${comp.data!.slug}/${division.data!.slug}/fixtures/${fx.fixtureId}`;

  // Public fixture page — the winner AND the score-qualified method, never
  // the raw "shootout" token.
  await page.goto(publicPath);
  await expect(page.getByText(/won 3–0 on penalties/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("shootout", { exact: false })).toHaveCount(0);

  // Organiser console — the v3 pad has UNMOUNTED (decided); this sentence is
  // the one surface left that can say who won and how.
  await page.goto(await fixturePath(page.request, fx.fixtureId));
  await expect(pad(page)).toHaveCount(0);
  await expect(page.getByText(/won 3–0 on penalties/)).toBeVisible({ timeout: 20_000 });

  // Share text — ShareButton's `text` prop reaches navigator.share/wa.me
  // directly (share-button.tsx), never the DOM, so it is stubbed and its
  // call arguments inspected rather than asserted as visible text.
  await page.goto(publicPath);
  await page.evaluate(() => {
    Object.defineProperty(window.navigator, "share", {
      configurable: true,
      value: (data: unknown) => {
        (window as unknown as { __shareCall?: unknown }).__shareCall = data;
        return Promise.resolve();
      },
    });
  });
  await page.getByRole("button", { name: "Share on WhatsApp" }).click();
  const shareCall = await page.evaluate(
    () => (window as unknown as { __shareCall?: { text?: string } }).__shareCall,
  );
  expect(shareCall?.text, "the WhatsApp message must say who won and how").toContain(
    "won 3–0 on penalties",
  );
});

// R3.5/Task O — the test above proves the SSR sentence is correct on a FRESH
// navigation to an ALREADY-decided fixture (`decideByShootout` finishes
// before `page.goto` ever runs), which is the reload case and proves nothing
// about liveness. This one opens the public page FIRST, on a fixture that
// has not even started, then decides it from a separate API context while
// the page stays open — no `page.goto`/`page.reload` between opening it and
// the final assertion. `LiveScore`'s own 15 s poll (`POLL_MS`,
// components/public-site/live-score.tsx) is the only mechanism that can
// produce the sentence once the page is already sitting open, so this test
// has to actually wait it out rather than assert something already true at
// load.
test("football v3: the public page's decided sentence updates live while already open, with no reload (R3.5/Task O)", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 FB Live Decide ${TAG}`,
    sportKey: "football",
    variantKey: "11-a-side",
    home: [{ fullName: `V3 FBLD Home ${TAG}`, positionKey: "FW" }],
    away: [{ fullName: `V3 FBLD Away ${TAG}`, positionKey: "GK" }],
  });
  await mergeDivisionConfig(page.request, fx.divisionId, {
    shootout: true,
    extraTime: { enabled: false, halfMinutes: 15 },
  });

  const org = await activeOrg(page);
  const comp = await apiJson<{ slug: string }>(page.request, `/api/v1/competitions/${fx.competitionId}`);
  const division = await apiJson<{ slug: string }>(page.request, `/api/v1/divisions/${fx.divisionId}`);
  const publicPath = `/shared/${org.slug}/${comp.data!.slug}/${division.data!.slug}/fixtures/${fx.fixtureId}`;

  // Open the page BEFORE a single event has been posted (seedRosteredFixture
  // never emits core.start unless asked), and never navigate again.
  await page.goto(publicPath);
  await expect(page.getByText("Not started")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/won .* on penalties/)).toHaveCount(0);

  // A DIFFERENT context posts every event — the same helper the reload test
  // above uses, run against `page.request` (a raw HTTP call), never a click
  // on this open page.
  await decideByShootout(page.request, fx);

  await expect(page.getByText(/won 3–0 on penalties/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("shootout", { exact: false })).toHaveCount(0);
});

// R3.5/Task I (F19) — points.shootoutWin/shootoutLoss have worked in the
// engine since spec 04 and had zero references in apps/web; this proves the
// UI-shaped config (nested under `points`, per match-rules.tsx's own unit
// tests) reaches a REAL decided fixture's standings row, not just that the
// config round-trips. Stage kind is whatever seedRosteredFixture defaults to
// (league) — football.ts's standingsDelta never reads StageCtx.kind, so a
// league stage exercises the identical code path a group stage would.
test("football v3: group-stage shoot-out points reach the standings (R3.5/Task I, F19)", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 FB SOPoints ${TAG}`,
    sportKey: "football",
    variantKey: "11-a-side",
    home: [{ fullName: `V3 FBP Home ${TAG}`, positionKey: "FW" }],
    away: [{ fullName: `V3 FBP Away ${TAG}`, positionKey: "GK" }],
  });
  await mergeDivisionConfig(page.request, fx.divisionId, {
    shootout: true,
    extraTime: { enabled: false, halfMinutes: 15 },
    points: { win: 3, draw: 1, loss: 0, shootoutWin: 2, shootoutLoss: 1 },
  });
  await decideByShootout(page.request, fx);

  const fixture = await apiJson<{ status: string; stage_id: string }>(
    page.request,
    `/api/v1/fixtures/${fx.fixtureId}`,
  );
  expect(fixture.status, `GET fixture -> ${fixture.status}`).toBe(200);
  expect(fixture.data!.status).toBe("decided");

  await expect
    .poll(
      async () => {
        const standings = await apiJson<{ rows: { entrantId: string; points: number }[] }>(
          page.request,
          `/api/v1/stages/${fixture.data!.stage_id}/standings`,
        );
        return standings.data?.rows.find((r) => r.entrantId === fx.homeEntrantId)?.points;
      },
      { timeout: 20_000 },
    )
    .toBe(2); // shoot-out WIN pays 2, not the flat 3

  const standings = await apiJson<{ rows: { entrantId: string; points: number }[] }>(
    page.request,
    `/api/v1/stages/${fixture.data!.stage_id}/standings`,
  );
  expect(
    standings.data!.rows.find((r) => r.entrantId === fx.awayEntrantId)?.points,
    "shoot-out LOSS pays 1, not the flat 0",
  ).toBe(1);
});

// R8/WS-B2 — the app-side half of "a required attribution item's dead-end
// tap" (engine half: d4c8ddbfb, `PadAttributionItem.required`; app half:
// view-model.ts's `checkActionValidity` + action-form.tsx's
// `renderAttributionRow`, both sport-agnostic — no per-sport branching
// anywhere in either file). The task brief pinned cricket.toss.wonBy as
// this proof's real-browser target; that premise does not hold (memory
// rule #5 — verified by RUNNING pad-host.tsx's own `dedicatedEventTypes`/
// `moreActions` against the real cricket skin+engine padSpec, not assumed
// from a read): cricket.toss (and cricket.review, the other action the
// engine commit names) is one of cricket's dedicated-tile actions, and
// every one of those opens its own GuidedSheet — a strictly sequential
// step wizard with no Confirm separate from its own last step, so it
// cannot structurally reach a dead-end tap at all. The one cricket action
// that DOES ride the generic More sheet with a required item
// (`cricket.player.line`, post-match) turned out to need a genuinely
// completed fixture, and once a fixture is decided BOTH the console and
// the device-link route replace the pad with a read-only summary — an
// unrelated, pre-existing product gap, out of this task's scope.
//
// `football.shot` is the real, live-phase equivalent this file's own
// "all nine football.* event types are reachable" test above already
// drives through the generic More sheet — same required SIDE item shape
// (`by`, engine-stamped `required: true`), same chassis code, no
// completed-match complication. Reusing it here is the actual REAL
// producer→consumer proof for R8/WS-B2: a node builder test cannot see
// the rendered disabled Confirm button, the visible reason, or the
// red-asterisk/"required" marker — this test drives all three through the
// live pad, then confirms the built payload actually reaches the ledger.
test("football v3 (R8/WS-B2): a required attribution item on the generic More sheet gates Confirm with a visible reason, and the built payload carries it once filled — no dead-end tap", async ({
  page,
}) => {
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 FB ReqAttr ${TAG}`,
    sportKey: "football",
    variantKey: "11-a-side",
    home: [{ fullName: `V3 FBRA Home ${TAG}`, positionKey: "FW" }],
    away: [{ fullName: `V3 FBRA Away ${TAG}`, positionKey: "GK" }],
  });
  await openLiveConsole(page, fx);

  await v3Tile(page, "more").click();
  const sheet = v3Sheet(page);
  await expect(sheet, "the More sheet must open").toBeVisible({ timeout: 10_000 });

  await sheet.getByRole("button", { name: "Shot", exact: true }).click();

  const confirm = sheet.getByRole("button", { name: "Confirm", exact: true });
  await expect(confirm, "disabled before anything is filled").toBeDisabled();

  const group = sheet.locator('[data-attribution-path="by"]');
  await expect(group, "the required attribution row must render").toBeVisible({ timeout: 10_000 });
  await expect(group, "red-asterisk marker (data-required)").toHaveAttribute("data-required", "true");
  await expect(group, "the \"required\" microcopy must be visible text, not a tooltip").toContainText("Required");

  // Every declared FIELD (the pre-existing gate) — Confirm must STAY
  // disabled once these alone are filled: before this fix, fields alone
  // satisfied checkActionValidity and the required side (`by`) could be
  // skipped straight to a silently-rejected submit.
  await sheet.getByLabel("Outcome").selectOption("blocked");
  await sheet.getByLabel("At period").selectOption("H1");
  await sheet.getByLabel("At elapsed", { exact: true }).fill("120");

  await expect(
    confirm,
    "still disabled with every FIELD filled — fields alone must not satisfy the required attribution gate",
  ).toBeDisabled();
  await expect(sheet, "Confirm's one-line reason must name what's missing").toContainText("Choose who's required");

  await sheet.getByRole("button", { name: "Home", exact: true }).click();

  await expect(confirm, "enables once the required item is filled").toBeEnabled();
  await confirm.click();

  await expect.poll(async () => countOf(page.request, fx.fixtureId, "football.shot"), { timeout: 20_000 }).toBe(1);
  const shot = (await ledger(page.request, fx.fixtureId)).find((e) => e.type === "football.shot")!;
  expect(shot.payload.by, "the attributed side must reach the built payload — no silent drop").toBe(
    fx.homeEntrantId,
  );
});
