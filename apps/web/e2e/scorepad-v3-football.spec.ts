import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import {
  activeOrg,
  apiJson,
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

test("football v3: the ninth type, football.shootout.kick, is reachable once the match reaches the kicks", async ({
  page,
}) => {
  test.setTimeout(120_000);
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
  // route to the phase this test needs.
  //
  // `halfMinutes` is spelled out even though it is irrelevant here: `extraTime`
  // is a plain `z.object` whose two fields are BOTH required, with the DEFAULT
  // applied only to the whole object. `{ enabled: false }` alone therefore
  // fails the cfg parse — and because the division config is written by SQL,
  // nothing validates it on the way in: the failure surfaces as the console
  // rendering no pad at all, which reads as a pad defect. (Measured, this
  // session.)
  await mergeDivisionConfig(page.request, fx.divisionId, {
    shootout: true,
    extraTime: { enabled: false, halfMinutes: 15 },
  });
  await postEvent(page.request, fx.fixtureId, "core.start", {});
  await postEvent(page.request, fx.fixtureId, "football.period", { phase: "HT" });
  await postEvent(page.request, fx.fixtureId, "football.period", { phase: "FT" });
  await openConsoleAlreadyLive(page, fx);

  // SHOOTOUT is a phase of the MATCH, so it maps to `PadPhase` "live" and the
  // pad keeps its chrome — but the ball is not in play, so every in-play tile
  // is correctly gone. That leaves More as the only recording surface, which
  // is exactly the case ruling R3-4 put the four rare types there for.
  await expect(pad(page).locator('[data-strip-tone="led"]').first()).toContainText("Shoot-out");
  await expect(v3Tile(page, "goal-home"), "the ball is not in play during the kicks").toHaveCount(0);
  await v3Tile(page, "more").click();
  const sheet = v3Sheet(page);
  await expect(sheet).toBeVisible({ timeout: 10_000 });
  await expect(
    sheet.getByRole("button", { name: "Shoot-out kick", exact: true }),
    "the shoot-out panel's own gate must open once the match reaches the kicks",
  ).toBeVisible();
});
