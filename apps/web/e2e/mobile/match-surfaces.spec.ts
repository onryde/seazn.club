// Split out of the former e2e/mobile.spec.ts (2026-11-13, verbatim move): match surfaces: the chess tie-break sheet, the forfeit dialog, the online-chess match room, the never-live stream copy, the rules-changed banner and the arbiter round column.
// Runs ONLY in the seven width projects (mobile-320/360/se/14/430, tablet-768/834 — MOBILE_SPECS in playwright.config.ts).

import { test, expect, type Page, type Locator, type APIRequestContext } from "@playwright/test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TAG,
  apiJson,
  activeOrg,
  expectNoHorizontalScroll,
  addEntrantsViaApi,
  createStageAndGenerate,
  fixturePath,
  seedRosteredFixture,
  overflowingIn,
  matchRoomPathBySql,
  seedVenueWithCourts,
  withDb,
} from "../helpers";
import { longName, roundGameSql, seedOnlineRound, seedSeatInvite, uiEn } from "../match-room-kit";
import { backdateOpenSql, cancelFlaggedSql, holdNoShowSql } from "../match-day-online-kit";
import { putArrival } from "../match-day-kit";
import { DEADLINE_AFTER_MS, LINE_DEADLINE_GRACE_MS } from "../../src/server/external-play/window";
import { ARMAGEDDON_RESULTS } from "@seazn/engine/sports/boardgame";
import { consentedAnonymousState, dismissCookieBanner } from "../scorepad-a11y-kit";
import { openMatchActions } from "../helpers/match-actions";
import { v3Sheet, assertTapFloor, padTile, dlDict, projectViewport, projectTag } from "./_shared";

// Not serial: no test here reads state another test writes (no module-level `let` is shared), so one red does not skip the rest (AGENTS.md class 21).

/** Rows a test put into the SHARED e2e organisation that a sibling spec must not meet (a court its Match Day list would show). A test pushes the undo of what it
 *  seeded; the hook runs them after the test, passed or failed, newest first (B11 fix round 2). */
const undoAfterTest: Array<() => Promise<void>> = [];
test.afterEach(async () => {
  while (undoAfterTest.length > 0) await undoAfterTest.pop()!();
});

// W2a Task 12 (spec §5.5, UI-2 option B; BG-KO-1, BG-KO-2 per ruling 82). A drawn chess KNOCKOUT game goes to its
// tie-break, which is the only thing the pad offers: a three-step sheet (rung → winner → optional score). Each step
// must be reachable and hold at this width.
//
// W2c Task 21 (S5, BG-KO-2): the Armageddon is no longer a winner tap. It is three screens — Who had Black?, Result?, then
// a read-back with one Confirm — and EACH must offer the SAME controls here as at 1280, membership and order, never a
// groomed shrink (AGENTS.md, the phone composition). The entrants carry 43-character names: a short name hides the
// wrap, and the read-back sentence is where a long one lands. Options are read by their chassis data hook
// (`data-choice-option-id`, preflight C24), never by a testid or a translated label; the sentence and the labels are
// read from the dictionary, never typed.
test("chess tie-break (W2a): every step of the knockout tie-break sheet is reachable and holds at this width; the Armageddon's three screens match 1280", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `W2a mobile chess ${TAG}-${testInfo.project.name}`,
    visibility: "private",
  });
  expect(comp.status, `competition: ${JSON.stringify(comp.error)}`).toBeLessThan(300);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Cup",
    sport_key: "boardgame",
    variant_key: "classical",
  });
  expect(div.status, `division: ${JSON.stringify(div.error)}`).toBeLessThan(300);
  const longNames = [
    "Alexandria Montgomery-Featherstonehaugh III",
    "Bartholomew Wolfeschlegelstein-Hausenberger",
    "Christopherson Van der Berg-Oosterhuizen Jr",
    "Dominique Castellanos-Villaverde de la Cruz",
  ];
  const added = await addEntrantsViaApi(request, div.data!.id, longNames, "individual");
  expect(added.ids).toHaveLength(4);
  const nameOf = new Map(added.ids.map((id, i) => [id, longNames[i]!]));
  const { fixtureIds } = await createStageAndGenerate(request, div.data!.id, { kind: "knockout", name: "Cup" });
  const started = await apiJson(request, `/api/v1/divisions/${div.data!.id}/start`, "POST");
  expect(started.status, `start: ${JSON.stringify(started.error)}`).toBeLessThan(300);
  let fixtureId: string | null = null;
  let homeEntrantId = "";
  let awayEntrantId = "";
  for (const id of fixtureIds) {
    const f = await apiJson<{ home_entrant_id: string | null; away_entrant_id: string | null }>(request, `/api/v1/fixtures/${id}`);
    if (f.data?.home_entrant_id && f.data.away_entrant_id) { fixtureId = id; homeEntrantId = f.data.home_entrant_id; awayEntrantId = f.data.away_entrant_id; break; }
  }
  expect(fixtureId, "a first-round game with both players").not.toBeNull();
  expect(nameOf.get(awayEntrantId), "the away entrant is one of the four named players").toBeTruthy();
  expect(nameOf.get(homeEntrantId), "the home entrant is one of the four named players").toBeTruthy();
  for (const [type, payload] of [["core.start", {}], ["boardgame.result", { winner: null, method: "agreement" }]] as const) {
    const st = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${fixtureId}/state`);
    const res = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", { expected_seq: st.data!.last_seq, type, payload });
    expect(res.status, `${type}: ${JSON.stringify(res.error)}`).toBeLessThan(300);
  }

  const option = (id: string) => v3Sheet(page).locator(`[data-choice-option-id="${id}"]`);
  const optionIds = () => v3Sheet(page).locator("[data-choice-option-id]").evaluateAll((els) => els.map((e) => e.getAttribute("data-choice-option-id")));
  const backButton = () => v3Sheet(page).getByRole("button", { name: "Back", exact: true });
  const projectWidth = page.viewportSize()!.width;
  /** Only for a per-screen visual verdict: an element crop of the open sheet into W2A_SHOTS_DIR (the switch bracket-finish.spec.ts
   *  uses). Unset in CI, where it does nothing. */
  const shotSheet = async (name: string) => {
    const dir = process.env.W2A_SHOTS_DIR;
    if (dir) await v3Sheet(page).screenshot({ path: `${dir}/${name}-${projectWidth}.png` });
  };
  /** Nothing in the open sheet is wider than the box that clips it (a scrollable region would be reachable; clipped content is not),
   *  and the page does not scroll sideways. The names are 43 characters: this is the check a short name cannot fail. */
  const expectSheetNotClipped = async (screen: string) => {
    const o = await overflowingIn(page, '[data-role="v3-sheet"]', "*", "the tie-break sheet is missing");
    expect(o.clipped, `${screen}: nothing in the sheet is clipped at ${projectWidth}`).toEqual([]);
    await expectNoHorizontalScroll(page);
  };
  /** W2c Task 21 design pass: the deciding steps are ROWS — each option spans the card (less its 16px gutters), a long name wraps
   *  inside it — never a pill hugging its label. */
  const expectRows = async (ids: readonly string[], screen: string) => {
    const sheet = (await v3Sheet(page).boundingBox())!;
    for (const id of ids) {
      const box = (await option(id).boundingBox())!;
      expect(box.width, `${screen} ${id}: a full-width row at ${projectWidth} (${box.width}px in a ${sheet.width}px sheet)`).toBeGreaterThanOrEqual(sheet.width - 40);
    }
  };
  /** The sheet's context lines as the scorer reads them (whitespace collapsed). */
  const contextLines = () =>
    v3Sheet(page).getByTestId("pad-sheet-context-line").evaluateAll((els) => els.map((e) => (e.textContent ?? "").replace(/\s+/g, " ").trim()));

  await page.goto(await fixturePath(page.request, fixtureId!), { waitUntil: "load" });
  await dismissCookieBanner(page);
  await assertTapFloor(padTile(page, "tiebreak"), "chess: tie-break tile");
  await expect(padTile(page, "draw"), "the game is drawn: no second Draw").toHaveCount(0);
  await padTile(page, "tiebreak").click();
  await expect(v3Sheet(page), "the tie-break sheet must open").toBeVisible({ timeout: 20_000 });

  // Step 1 — the rung. Exactly the engine's three, no lots.
  expect(await optionIds()).toEqual(["rapid", "blitz", "armageddon"]);
  for (const id of ["rapid", "blitz", "armageddon"]) await assertTapFloor(option(id), `rung ${id}`);
  await expectRows(["rapid", "blitz", "armageddon"], "Rung step");
  expect(await contextLines(), "the rung pick names no round").toEqual([]);
  await expectSheetNotClipped("Rung step");
  // Step 2 — the winner (rapid), then step 3 — the optional score.
  await option("rapid").click();
  expect(await optionIds()).toEqual(["home", "away"]);
  await assertTapFloor(option("away"), "rapid winner");
  await expect(option("away")).toHaveText(nameOf.get(awayEntrantId)!);
  await expectRows(["home", "away"], "Rapid winner step");
  expect(await contextLines(), "the rapid winner step names its round").toEqual([dlDict("en")["pad.boardgame.tiebreak.rung.rapid"]!]);
  await expectSheetNotClipped("Rapid winner step");
  await shotSheet("s5-20-long-name-rapid-winner");
  await option("away").click();
  expect(await optionIds()).toEqual(["none", "2–0", "1½–½"]);
  await assertTapFloor(option("none"), "score none");
  await expectSheetNotClipped("Score step");
  // Back twice to the rung, then the Armageddon: three screens, each here and at 1280.
  await backButton().click();
  await backButton().click();
  await option("armageddon").click();
  const dict = dlDict("en");
  const hint = v3Sheet(page).getByText(dict["pad.boardgame.tiebreak.armageddonHint"]!);
  const phoneViewport = page.viewportSize()!;
  /** Every control the sheet shows, in DOM order: the choice options by their option id, the rest by testid or label. */
  const controls = () =>
    v3Sheet(page)
      .locator("button, [data-choice-option-id]")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-choice-option-id") ?? e.getAttribute("data-testid") ?? (e.textContent ?? "").trim()));
  /** The control set at this width, then at 1280 — the same screen, the same state — then back to the project's width. */
  const sameControlsAt1280 = async (screen: string): Promise<string[]> => {
    const here = await controls();
    expect(here.length, `${screen}: the sheet shows controls`).toBeGreaterThan(0);
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(v3Sheet(page)).toBeVisible();
    const desktop = await controls();
    await page.setViewportSize(phoneViewport);
    await expect(v3Sheet(page)).toBeVisible();
    expect(here, `${screen} at ${projectWidth} vs 1280: membership and order`).toEqual(desktop);
    return here;
  };

  // Screen 1 — Who had Black? Exactly the two entrants, named in full; no hint (it is the result step's).
  const blackIds = await sameControlsAt1280("Black step");
  expect(blackIds.filter((id) => id.startsWith("black-")), "Black step: the two entrants").toEqual(["black-home", "black-away"]);
  await expect(v3Sheet(page).getByText(dict["pad.boardgame.tiebreak.black.title"]!)).toBeVisible();
  await expect(hint, "the Black step carries no hint").toHaveCount(0);
  await expect(option("black-away")).toHaveText(nameOf.get(awayEntrantId)!);
  for (const id of ["black-home", "black-away"]) await assertTapFloor(option(id), `Black ${id}`);
  await expectRows(["black-home", "black-away"], "Black step");
  expect(await contextLines(), "the Black step names the round and nothing else").toEqual([dict["pad.boardgame.tiebreak.rung.armageddon"]!]);
  await expectSheetNotClipped("Black step");
  await shotSheet("s5-21-long-name-black");
  await option("black-away").click();

  // Screen 2 — Result? The engine's three, each labelled by the dictionary, the hint showing.
  await expect(hint).toBeVisible();
  const resultIds = await sameControlsAt1280("Result step");
  expect(resultIds.filter((id) => id.startsWith("result-")), "Result step: the engine's results, in its order").toEqual(ARMAGEDDON_RESULTS.map((r) => `result-${r}`));
  for (const r of ARMAGEDDON_RESULTS) {
    await expect(option(`result-${r}`)).toHaveText(dict[`pad.boardgame.armageddon.result.${r}`]!);
    await assertTapFloor(option(`result-${r}`), `result ${r}`);
  }
  await expectRows(ARMAGEDDON_RESULTS.map((r) => `result-${r}`), "Result step");
  // Black is the away entrant, so the home entrant is White. Both names are 43 characters: the legend wraps them, it never clips.
  const legend = [dict["pad.boardgame.tiebreak.rung.armageddon"]!, `${dict["pad.boardgame.tiebreak.who.white"]!} ${nameOf.get(homeEntrantId)!}`, `${dict["pad.boardgame.tiebreak.who.black"]!} ${nameOf.get(awayEntrantId)!}`];
  expect(await contextLines(), "the result step says who is White and who is Black").toEqual(legend);
  await expectSheetNotClipped("Result step");
  await shotSheet("s5-22-long-name-result");
  await option("result-draw").click();

  // Screen 3 — the read-back: the sentence in full, then one Confirm that is a real tap target.
  const sentence = dict["pad.boardgame.tiebreak.confirm.drawn"]!.replace("{name}", nameOf.get(awayEntrantId)!);
  await expect(v3Sheet(page).getByTestId("pad-sheet-summary")).toHaveText(sentence);
  const readBackIds = await sameControlsAt1280("Read-back step");
  expect(readBackIds.filter((id) => id === "pad-sheet-confirm"), "the read-back offers exactly one Confirm").toHaveLength(1);
  expect(readBackIds.some((id) => id.startsWith("black-") || id.startsWith("result-")), "the read-back offers no choice to re-tap").toBe(false);
  await assertTapFloor(v3Sheet(page).getByTestId("pad-sheet-confirm"), "Confirm");
  await assertTapFloor(backButton(), "Back on the read-back");
  expect(await contextLines(), "the read-back keeps the same legend above it").toEqual(legend);
  await expectSheetNotClipped("Read-back step");
  await shotSheet("s5-23-long-name-confirm");
  // Nothing was written by walking the sheet.
  const events = await apiJson<{ type: string }[]>(request, `/api/v1/fixtures/${fixtureId}/events`);
  expect(events.data!.map((e) => e.type)).toEqual(["core.start", "boardgame.result"]);
});

// W2b Task 11 (UI-1): the organiser console's forfeit dialog at THIS width. A bottom sheet on phones: every choice is
// reachable and holds the 44px floor, the page never scrolls sideways, Confirm is the element a tap at its edges lands
// on, and the control set — membership and order — is the one 1280 shows (a branch, not a shrink). Long realistic
// names, because a short one hides the wrap (AGENTS.md phone composition: `truncate` / `min-w-0`).
test("forfeit dialog (W2b T11): every choice reachable, 44px floor, no horizontal scroll, Confirm hit-testable; the control set matches 1280", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `W2b mobile forfeit ${TAG}-${testInfo.project.name}`,
    visibility: "private",
  });
  expect(comp.status, `competition: ${JSON.stringify(comp.error)}`).toBeLessThan(300);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "League",
    sport_key: "badminton",
    variant_key: "bwf",
  });
  expect(div.status, `division: ${JSON.stringify(div.error)}`).toBeLessThan(300);
  const names = [`Alexandria Konstantinopoulou-Vanderbilt ${TAG}`, `Maximiliano Wolfeschlegelsteinhausen ${TAG}`];
  const added = await addEntrantsViaApi(request, div.data!.id, names, "individual");
  expect(added.ids).toHaveLength(2);
  const { fixtureIds } = await createStageAndGenerate(request, div.data!.id, { kind: "league", name: "League" });
  const started = await apiJson(request, `/api/v1/divisions/${div.data!.id}/start`, "POST");
  expect(started.status, `start: ${JSON.stringify(started.error)}`).toBeLessThan(300);
  const fixtureId = fixtureIds[0]!;
  const projectWidth = page.viewportSize()!.width;

  await page.goto(await fixturePath(page.request, fixtureId), { waitUntil: "load" });
  await dismissCookieBanner(page);
  const dialog = page.getByTestId("forfeit-dialog");
  const controls = () =>
    dialog
      .locator('[data-testid^="forfeit-who-"], [data-testid^="forfeit-why-"], [data-testid="forfeit-confirm"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
  const open = async () => {
    await openMatchActions(page);
    await page.getByTestId("score-forfeit").click({ timeout: 20_000 });
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await dialog.getByTestId("forfeit-who-away").click();
    await dialog.getByTestId("forfeit-why-walkover").check();
    await expect(dialog.getByTestId("forfeit-preview")).toBeVisible();
  };
  await open();
  for (const w of ["home", "away", "both"]) await assertTapFloor(dialog.getByTestId(`forfeit-who-${w}`), `forfeit side ${w}`);
  // A radio's tap target is its label (the whole row), not the 16px dot.
  await assertTapFloor(dialog.locator("label", { has: page.getByTestId("forfeit-why-walkover") }), "forfeit reason walkover");
  await assertTapFloor(dialog.getByTestId("forfeit-confirm"), "forfeit Confirm");
  await expectNoHorizontalScroll(page);
  const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(widths.scroll, `${projectWidth}: scrollWidth ${widths.scroll} within clientWidth ${widths.client}`).toBeLessThanOrEqual(widths.client);
  const here = await controls();
  expect(here.length, "the dialog's controls were read").toBeGreaterThan(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await page.setViewportSize({ width: 1280, height: 900 });
  await open();
  expect(here, `the dialog's controls at ${projectWidth} vs 1280: membership, order, repeats`).toEqual(await controls());
  await page.keyboard.press("Escape");
  // Nothing was confirmed: walking the dialog wrote nothing.
  const events = await apiJson<{ type: string }[]>(request, `/api/v1/fixtures/${fixtureId}/events`);
  expect(events.data!.map((e) => e.type)).toEqual([]);
});

// Online chess on OUR page (design 2026-10-09 §6, §8.6; Task 17): the live
// match room at this project's REAL width. Below md the room is one column
// in a fixed order — the OPPONENT's clock bar, the board at the column's full
// width, the player's own clock bar (T17B fix 2, D24: by viewer, never by
// colour), the player's own camera tile, then Draw/Resign; from md the board
// takes the left column — with the two bars, each the board's width, framing
// it — and the tile and controls the right. Asserted as the order and
// membership of what is on screen, not as box sizes, so a groomed shrink of
// the desktop layout cannot pass for the phone composition. The presence pill
// needs a real meeting join and is owed to staging (Task 17 part B). Camera
// `optional` so the tile is on screen with no camera duty — no banner
// competes for the top of the column.
test("match room (online chess): a live board is the opponent's clock, a full-width board, own clock, own tile, then Draw/Resign below md — two columns from md — no horizontal scroll", async ({
  browser,
  request,
}) => {
  test.setTimeout(120_000);
  const vp = projectViewport();
  expect(vp, "a width project declares its viewport").not.toBeNull();
  const phone = vp!.width < 768;
  const r = await seedOnlineRound(request, [`Mo Phone ${TAG}`, `Ny Width ${TAG}`], { camera: "optional" });
  const board = r.boards[0]!;
  // White is home on a ledger game (roundGameSql); two plies, so the rules
  // offer a draw and a resign and no longer an abort.
  await roundGameSql(board, { moves: ["e2e4", "e7e5"] });

  const ctx = await browser.newContext({ viewport: vp!, storageState: await consentedAnonymousState() });
  try {
    const p = await ctx.newPage();
    const res = await p.goto(await matchRoomPathBySql(board.fixtureId, board.home.personId));
    expect(res?.status(), "the room renders").toBe(200);
    await expect(p.getByTestId("match-room")).toHaveAttribute("data-screen", "live", { timeout: 20_000 });
    await expect(p.locator("[data-testid=room-board-surface] cg-board piece").first()).toBeAttached({ timeout: 20_000 });

    const order = ["room-clock-opponent", "room-board", "room-clock-you", "room-tile-strip", "room-controls"] as const;
    const box = async (id: string) => {
      const b = await p.getByTestId(id).first().boundingBox();
      expect(b, `${id} is on screen at ${vp!.width}px`).not.toBeNull();
      return b!;
    };
    await expect(p.getByTestId("room-clock-opponent")).toContainText(board.away.name);
    let pairs = 0;
    if (phone) {
      for (let i = 1; i < order.length; i++) {
        const above = await box(order[i - 1]!);
        const below = await box(order[i]!);
        expect(below.y, `${order[i]} sits below ${order[i - 1]} at ${vp!.width}px`).toBeGreaterThanOrEqual(above.y + above.height - 1);
        pairs++;
      }
    } else {
      const theirs = await box("room-clock-opponent");
      const b = await box("room-board");
      const mine = await box("room-clock-you");
      expect(b.y, "the opponent's clock is above the board").toBeGreaterThanOrEqual(theirs.y + theirs.height - 1);
      expect(mine.y, "the player's clock is under the board").toBeGreaterThanOrEqual(b.y + b.height - 1);
      pairs += 2;
      for (const id of ["room-tile-strip", "room-controls"]) {
        const side = await box(id);
        expect(side.x, `${id} is right of the board from md`).toBeGreaterThanOrEqual(b.x + b.width);
        pairs++;
      }
      const tile = await box("room-tile-strip");
      const controls = await box("room-controls");
      expect(controls.y, "the tile above the controls").toBeGreaterThanOrEqual(tile.y + tile.height - 1);
      pairs++;
    }
    expect(pairs, "anti-vacuity: every relation checked").toBe(phone ? order.length - 1 : 5);
    // Each bar is the board's width, left edge to left edge (D24), at every width.
    const b = await box("room-board");
    let framed = 0;
    for (const id of ["room-clock-opponent", "room-clock-you"]) {
      const bar = await box(id);
      expect(Math.abs(bar.width - b.width), `${id} is the board's width at ${vp!.width}px`).toBeLessThanOrEqual(2);
      expect(Math.abs(bar.x - b.x), `${id} lines up with the board at ${vp!.width}px`).toBeLessThanOrEqual(2);
      framed++;
    }
    expect(framed, "anti-vacuity: both bars measured").toBe(2);
    // The sound switch is in the player's bar, a real 44px target (hit-tested: the paint box is not the tap area).
    const toggle = p.getByTestId("room-clock-you").getByTestId("room-sound");
    await expect(toggle).toBeVisible();
    const t = await toggle.boundingBox();
    expect(t, "the switch is painted").not.toBeNull();
    expect(Math.min(t!.width, t!.height), `the switch is at least 44px at ${vp!.width}px`).toBeGreaterThanOrEqual(43.5);
    const hit = await toggle.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return top === el || (top !== null && el.contains(top));
    });
    expect(hit, "the centre of the switch hits the switch").toBe(true);

    // The control set, membership and order, read from the live DOM: the
    // rules' answer at two plies is Offer draw then Resign — never Abort.
    const controls = await p
      .getByTestId("room-controls")
      .locator("button:visible")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
    expect(controls).toEqual(["room-draw", "room-resign"]);
    await expect(p.getByTestId("room-draw")).toBeEnabled();
    await expect(p.getByTestId("room-resign")).toBeEnabled();
    await expect(p.getByTestId("room-abort")).toHaveCount(0);

    const { clipped, scrollable } = await overflowingIn(p, '[data-testid="match-room"]', "button,div,span", "the match room was not in the DOM");
    expect(clipped, "nothing in the room is clipped at this width").toEqual([]);
    for (const s of scrollable) expect(s, "a scrolling box in the room is keyboard-reachable").toMatch(/tabindex=0$/);
    await expectNoHorizontalScroll(p);
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------------------
// R2008 free-gaps (owner ruling 2026-10-20) — the never-live COPY FITS a phone.
//
// The end of a composed stream whose camera never appeared now has two true tellings: the credit is returned (or none was
// taken), or the fixture's never-live refund is already spent and the CHARGE STANDS. Each has a countdown sentence in the
// Phone strip and a sentence on the failed card (`camera_never_live` / `camera_never_live_charged`), and French is the
// longest of the four locales. This block renders BOTH variants in fr and en, at this project's width (it runs under all
// seven), and asserts that nothing is clipped, nothing scrolls the page sideways, the whole sentence is the shipped one,
// and the control a person needs next (Stop on the live card, Try again on the failed one) is under the finger — by
// `elementFromPoint`, because a box is paint and a hit-test is what is on top (AGENTS.md class 2).
//
// WHAT IS STAGED: the two reads the panel polls (`stream-sessions/current` and `stream-phone`) are answered with the
// session the server would serve at each moment — a 15-minute clock cannot be waited for here, and the server's own
// choice of line is proven by the DB suites (stream-composed-free-gaps.test.ts). The copy, the layout, the fixture page
// and the panel are the product's own. The expected sentences come from the dictionaries by KEY, never typed here.
//
// Lives in mobile.spec.ts for the reason the P6 block above does: a new file would run desktop-only. Screenshots go to
// test-results/never-live-copy/ (never committed; e2e.yml's e2e-mobile job uploads the directory as an artifact).
// ---------------------------------------------------------------------------
const NL_SHOTS_DIR = join(process.cwd(), "test-results", "never-live-copy");
const nlDict = (locale: "en" | "fr"): Record<string, string> =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../src/dictionaries/${locale}/ui.json`, import.meta.url)), "utf8")) as Record<string, string>;
const flat = (t: string): string => t.replace(/\s+/g, " ").trim();
/** The two tellings, typed from the ruling: the countdown reason on the wire, and the dictionary key each surface reads. */
const NL_VARIANTS = [
  { variant: "refunded", reason: "camera_never_live", strip: "stream.phone.countdown.live.camera_never_live", fail: "stream.fail.camera_never_live", creditUsed: false },
  { variant: "charged", reason: "camera_never_live_charged", strip: "stream.phone.countdown.live.camera_never_live_charged", fail: "stream.fail.camera_never_live_charged", creditUsed: true },
] as const;
const NL_LOCALES = ["fr", "en"] as const;
const NL_SESSION_ID = "00000000-0000-4000-8000-0000000000a1";

/** A fresh two-entrant league and its one fixture on the shared Pro org, plus a destination to name in the session. */
async function nlRig(page: Page, request: APIRequestContext): Promise<{ fixturePath: string; fixtureId: string; targetId: string }> {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31", name: `Never Live ${TAG}-${projectTag()}`, visibility: "public",
  });
  expect(comp.status, "competition").toBe(201);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Never Live Cup", sport_key: "generic", variant_key: "score", config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  expect(div.status, "division").toBe(201);
  await addEntrantsViaApi(request, div.data!.id, ["Riverside Raptors", "Northgate Nomads"]);
  const { fixtureIds } = await createStageAndGenerate(request, div.data!.id);
  expect(fixtureIds, "a league of two plays once").toHaveLength(1);
  const org = await activeOrg(page);
  const listed = await apiJson<{ id: string }[]>(request, `/api/v1/orgs/${org.id}/stream-targets`);
  let targetId = listed.data?.[0]?.id;
  if (!targetId) {
    const made = await apiJson<{ id: string }>(request, `/api/v1/orgs/${org.id}/stream-targets`, "POST", {
      kind: "youtube", label: "Riverside TV", streamKey: `e2e-${TAG}-${projectTag()}`,
    });
    expect([200, 201], `a destination: ${JSON.stringify(made.error)}`).toContain(made.status);
    targetId = made.data!.id;
  }
  return { fixturePath: await fixturePath(request, fixtureIds[0]!), fixtureId: fixtureIds[0]!, targetId };
}

/** The `current` read as the server serves it (the wire's fields, StreamSessionCurrent), with `over` laid on top. */
function nlSession(rig: { fixtureId: string; targetId: string }, over: Record<string, unknown>): Record<string, unknown> {
  const now = Date.now();
  return {
    id: NL_SESSION_ID, fixtureId: rig.fixtureId, mode: "composed", overlay: { themeId: null, delayMs: 0 }, state: "live", desiredState: "live",
    failReason: null, health: null, ingest: { state: "disconnected", protocol: null }, output: null, balance: 2,
    startedAt: new Date(now - 5 * 60_000).toISOString(), endedAt: null, replayUrl: null,
    target: { id: rig.targetId, kind: "youtube", label: "Riverside TV" }, fixtureDecided: false, fixtureHeld: false, endReason: null,
    creditUsed: true, startCause: "organiser", restart: null, countdown: null, ...over,
  };
}
/** The `stream-phone` read model with a paired, present phone (the panel's strip reads the session for a countdown). */
function nlPhoneRead(): Record<string, unknown> {
  const at = new Date().toISOString();
  return {
    code: { issuedAt: at, state: "active", endCause: null },
    phone: {
      present: true, silent: false, notResponding: false, model: "Pixel 8", appVersion: "capture/2", mode: "operator", state: "publishing",
      notReady: null, notReadyShown: false, health: null, startFailed: null, lastBeatAt: at, elapsedMs: 5_000,
      beat: { battery: null, bitrateKbps: null, delivery: null, thermal: null, dataUsedMB: null }, farPoll: false,
    },
    destination: null, lastTakeover: null, auto: null, legacy: false, finished: false, session: null, court: null,
  };
}

/** Answer the panel's two polls with `staged` (a mutable box, so one route serves every scenario of a test). */
async function nlStage(page: Page, fixtureId: string, staged: { current: Record<string, unknown> | null }): Promise<void> {
  const envelope = (data: unknown) => ({ ok: true, data, requestId: "e2e-staged" });
  await page.route(`**/api/v1/fixtures/${fixtureId}/stream-sessions/current`, (route) =>
    route.request().method() === "GET" ? route.fulfill({ json: envelope(staged.current) }) : route.fallback());
  await page.route(`**/api/v1/fixtures/${fixtureId}/stream-phone`, (route) =>
    route.request().method() === "GET" ? route.fulfill({ json: envelope(nlPhoneRead()) }) : route.fallback());
}

/** The fixture page, its Stream control (one visible twin), and the Phone tab. */
async function nlOpenPanel(page: Page, path: string): Promise<Locator> {
  await page.goto(path, { waitUntil: "load" });
  await dismissCookieBanner(page);
  // The app header is sticky, so a panel scrolled into view for its picture (or for the hit-tests below) is painted over by
  // it: back in flow, the crop and the occlusion checks judge the PANEL, as stream-phone-panel.capture.ts does. Nothing in
  // the panel's own layout moves.
  await page.addStyleTag({ content: "header { position: static !important; }" });
  const control = page.locator('[data-role="fixture-stream"]:visible, [data-role="fixture-stream-phone"]:visible');
  await expect(control, "exactly one visible Stream control").toHaveCount(1, { timeout: 30_000 });
  await control.click();
  const scope = page.locator('[data-role="fixture-stream-body"]');
  await expect(scope).toBeAttached({ timeout: 30_000 });
  const phoneTab = scope.getByTestId("stream-tab-phone");
  if (await phoneTab.count()) await phoneTab.click();
  return scope;
}

/** The whole sentence is on screen: every painted line of `el`'s text is inside the viewport and inside every ancestor that
 *  CLIPS (`overflow` hidden/clip), and `el` itself does not hide content below its own box. A scrolling ancestor
 *  (`auto`/`scroll`) is a feature — its content is reachable — and is skipped on that axis. Returns the line count. */
async function nlExpectFits(el: Locator, label: string): Promise<number> {
  await el.scrollIntoViewIfNeeded();
  const verdict = await el.evaluate((node) => {
    const own = node as HTMLElement;
    const vw = document.documentElement.clientWidth;
    const range = document.createRange();
    range.selectNodeContents(own);
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
    if (rects.length === 0) return { problems: ["no painted text"], lines: 0 };
    const left = Math.min(...rects.map((r) => r.left));
    const right = Math.max(...rects.map((r) => r.right));
    const top = Math.min(...rects.map((r) => r.top));
    const bottom = Math.max(...rects.map((r) => r.bottom));
    const problems: string[] = [];
    if (left < -0.5 || right > vw + 0.5) problems.push(`text spans ${left.toFixed(1)}..${right.toFixed(1)} outside the ${vw}px viewport`);
    if (own.scrollHeight > own.clientHeight + 1) problems.push(`scrollHeight ${own.scrollHeight} > clientHeight ${own.clientHeight}`);
    const name = (a: HTMLElement) => `${a.tagName.toLowerCase()}${a.getAttribute("data-testid") ? `[${a.getAttribute("data-testid")}]` : ""}`;
    for (let a: HTMLElement | null = own; a; a = a.parentElement) {
      const cs = getComputedStyle(a);
      const clipsX = cs.overflowX === "hidden" || cs.overflowX === "clip";
      const clipsY = cs.overflowY === "hidden" || cs.overflowY === "clip";
      if (!clipsX && !clipsY) continue;
      const box = a.getBoundingClientRect();
      if (clipsY && (top < box.top - 0.5 || bottom > box.bottom + 0.5)) {
        problems.push(`${name(a)} clips vertically: text ${top.toFixed(1)}..${bottom.toFixed(1)}, box ${box.top.toFixed(1)}..${box.bottom.toFixed(1)}`);
      }
      if (clipsX && (left < box.left - 0.5 || right > box.right + 0.5)) {
        problems.push(`${name(a)} clips horizontally: text ${left.toFixed(1)}..${right.toFixed(1)}, box ${box.left.toFixed(1)}..${box.right.toFixed(1)}`);
      }
    }
    // Nothing paints over the copy: the topmost element at the middle of its first and of its last painted line is the
    // copy's own box (or inside it) — a hit-test, not a box (a sticky bar or a sheet edge over the last line is not "fit").
    if (bottom - top <= window.innerHeight) {
      const byTop = [...rects].sort((a, b) => a.top - b.top);
      for (const [which, r] of [["first", byTop[0]!], ["last", byTop[byTop.length - 1]!]] as const) {
        const x = Math.min(Math.max(r.left + r.width / 2, 0), vw - 1);
        const y = r.top + r.height / 2;
        const hit = document.elementFromPoint(x, y);
        if (y < 0 || y > window.innerHeight) problems.push(`the ${which} line is outside the viewport (y ${y.toFixed(1)}) after scrolling to it`);
        else if (!(hit && (own === hit || own.contains(hit)))) problems.push(`the ${which} line is covered by ${hit ? name(hit as HTMLElement) : "nothing"}`);
      }
    }
    return { problems, lines: new Set(rects.map((r) => Math.round(r.top))).size };
  });
  expect(verdict.problems, `${label}: the copy is fully visible`).toEqual([]);
  expect(verdict.lines, `${label}: anti-vacuity, some text was painted`).toBeGreaterThan(0);
  return verdict.lines;
}

/** The control is under a finger: scrolled to, its centre is inside the viewport and the topmost element there is the
 *  control (or a descendant) — not a sticky bar, the sheet's edge or a banner. */
async function nlExpectReachable(control: Locator, label: string): Promise<void> {
  await expect(control, `${label}: the control is rendered`).toBeVisible({ timeout: 30_000 });
  await control.scrollIntoViewIfNeeded();
  const verdict = await control.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const top = document.elementFromPoint(x, y);
    const topName = top ? `${top.tagName.toLowerCase()}${top.getAttribute("data-testid") ? `[${top.getAttribute("data-testid")}]` : ""}` : "nothing";
    return { inside: x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight, hit: top === el || (top !== null && el.contains(top)), topName };
  });
  expect(verdict.inside, `${label}: the centre of the control is inside the viewport`).toBe(true);
  expect(verdict.hit, `${label}: the topmost element at the control's centre is ${verdict.topName}`).toBe(true);
}

/** Save the panel's picture and prove the gate has not gone vacuous (AGENTS.md class 10): it exists and differs. */
async function nlShoot(scope: Locator, name: string, shas: Map<string, string>): Promise<void> {
  mkdirSync(NL_SHOTS_DIR, { recursive: true });
  const file = join(NL_SHOTS_DIR, `${projectTag()}-${name}.png`);
  await scope.screenshot({ path: file, animations: "disabled" });
  expect(existsSync(file), `${name}: the screenshot was written`).toBe(true);
  const sha = createHash("sha256").update(readFileSync(file)).digest("hex");
  const twin = shas.get(sha);
  expect(twin, `${name}: pixel-identical to ${twin} — a state that never opened`).toBeUndefined();
  shas.set(sha, name);
}

test("R2008 free-gaps: the never-live COUNTDOWN strip fits and Stop stays reachable — refunded and charged, fr and en", async ({ page, request, baseURL }) => {
  test.setTimeout(240_000);
  const rig = await nlRig(page, request);
  const staged: { current: Record<string, unknown> | null } = { current: null };
  await nlStage(page, rig.fixtureId, staged);
  const shas = new Map<string, string>();
  const sentences = new Set<string>();
  let checked = 0;
  for (const locale of NL_LOCALES) {
    await page.context().addCookies([{ name: "seazn_locale", value: locale, url: baseURL! }]);
    const dict = nlDict(locale);
    for (const v of NL_VARIANTS) {
      const tag = `${projectTag()} ${locale} ${v.variant}`;
      staged.current = nlSession(rig, {
        state: "live", creditUsed: true,
        countdown: { kind: "live", reason: v.reason, elapsedMs: 5 * 60_000, remainingMs: 10 * 60_000 },
      });
      const scope = await nlOpenPanel(page, rig.fixturePath);
      const strip = scope.getByTestId("stream-phone-strip");
      await expect(strip, `${tag}: the countdown strip`).toBeVisible({ timeout: 30_000 });
      const copy = dict[v.strip]!;
      const [head, tail] = copy.split("{remaining}") as [string, string];
      const got = flat((await strip.textContent()) ?? "");
      expect(got.startsWith(flat(head)), `${tag}: the strip opens with the shipped sentence — ${got}`).toBe(true);
      expect(got.endsWith(flat(tail)), `${tag}: the strip ends with the shipped sentence — ${got}`).toBe(true);
      const remaining = got.slice(flat(head).length, got.length - flat(tail).length).trim();
      expect(remaining.length, `${tag}: a time is named between them (${remaining})`).toBeGreaterThan(0);
      sentences.add(got);
      const lines = await nlExpectFits(strip, `${tag} strip`);
      await expectNoHorizontalScroll(page);
      await nlExpectReachable(scope.getByTestId("stream-stop").first(), `${tag} Stop`);
      await nlShoot(scope, `${locale}-${v.variant}-strip`, shas);
      console.log(`[never-live strip ${tag}] ${got.length} chars, ${lines} lines, remaining "${remaining}"`);
      checked++;
    }
  }
  expect(checked, "anti-vacuity: both locales x both tellings").toBe(NL_LOCALES.length * NL_VARIANTS.length);
  expect(sentences.size, "four different sentences were shown").toBe(4);
});

test("R2008 free-gaps: the never-live FAILED card fits and Try again stays reachable — refunded and charged, fr and en", async ({ page, request, baseURL }) => {
  test.setTimeout(240_000);
  const rig = await nlRig(page, request);
  const staged: { current: Record<string, unknown> | null } = { current: null };
  await nlStage(page, rig.fixtureId, staged);
  const shas = new Map<string, string>();
  const sentences = new Set<string>();
  let checked = 0;
  for (const locale of NL_LOCALES) {
    await page.context().addCookies([{ name: "seazn_locale", value: locale, url: baseURL! }]);
    const dict = nlDict(locale);
    for (const v of NL_VARIANTS) {
      const tag = `${projectTag()} ${locale} ${v.variant}`;
      const now = Date.now();
      staged.current = nlSession(rig, {
        state: "failed", desiredState: "ending", failReason: "camera_never_live", creditUsed: v.creditUsed,
        startedAt: new Date(now - 17 * 60_000).toISOString(), endedAt: new Date(now - 2 * 60_000).toISOString(),
        endReason: "failed", countdown: null,
      });
      const scope = await nlOpenPanel(page, rig.fixturePath);
      const card = scope.getByTestId("stream-fail-reason");
      await expect(card, `${tag}: the failed card`).toBeVisible({ timeout: 30_000 });
      const got = flat((await card.textContent()) ?? "");
      expect(got, `${tag}: the card says the shipped sentence`).toBe(flat(dict[v.fail]!));
      sentences.add(got);
      const lines = await nlExpectFits(card, `${tag} fail card`);
      await expectNoHorizontalScroll(page);
      await nlExpectReachable(scope.getByTestId("stream-retry"), `${tag} Try again`);
      await nlShoot(scope, `${locale}-${v.variant}-fail`, shas);
      console.log(`[never-live fail ${tag}] ${got.length} chars, ${lines} lines`);
      checked++;
    }
  }
  expect(checked, "anti-vacuity: both locales x both tellings").toBe(NL_LOCALES.length * NL_VARIANTS.length);
  expect(sentences.size, "four different sentences were shown").toBe(4);
});

test("rules-changed banner (W2c T15, X-SR-7): an open remote pad after a correction says the new format above the board, no horizontal scroll", async ({
  browser,
  request,
}) => {
  test.setTimeout(120_000);
  // Badminton `short`: the P5 rig (best of 3 → 5). Person names carry `projectTag()` (the badminton test's reason above).
  const fx = await seedRosteredFixture(request, {
    label: `Mobile Rules Banner ${TAG}-${projectTag()}`,
    sportKey: "badminton",
    variantKey: "short",
    entrantKind: "individual",
    home: [{ fullName: `Mobile RB Home ${TAG}-${projectTag()}` }],
    away: [{ fullName: `Mobile RB Away ${TAG}-${projectTag()}` }],
    emitCoreStart: true,
  });
  const link = await apiJson<{ secret: string }>(request, `/api/v1/fixtures/${fx.fixtureId}/device-links`, "POST", {
    label: `mobile rules banner ${projectTag()}`,
  });
  expect(link.status, JSON.stringify(link.error)).toBe(201);
  const ctx = await browser.newContext({ viewport: projectViewport() ?? undefined, storageState: await consentedAnonymousState() });
  try {
    const page = await ctx.newPage();
    await page.goto(`/score/${link.data!.secret}`, { waitUntil: "load" });
    const scorebug = page.locator('[data-role="v3-scorebug"]');
    await expect(scorebug).toBeVisible({ timeout: 20_000 });

    const fix = await apiJson(request, `/api/v1/fixtures/${fx.fixtureId}/rules`, "PUT", { rules: { bestOf: 5 } });
    expect(fix.status, JSON.stringify(fix.error)).toBe(200);
    const rules = await apiJson<{ format_line: string | null }>(request, `/api/v1/fixtures/${fx.fixtureId}/rules`);
    const line = rules.data?.format_line;
    expect(line, "premise: badminton's format line exists").toBeTruthy();

    // The stale tap: refused, and the pad raises the banner (the hold, then the wire: `HOLD_MS` is CI-pinned short).
    await scorebug.locator(".grid > button").first().click();
    const banner = page.getByTestId("pad-rules-changed");
    await expect(banner).toBeVisible({ timeout: 45_000 });
    await expect(banner).toContainText(line!);
    // Above the board at every width: the banner sits in the host's unordered band, before the tiles.
    const [b, tiles] = await Promise.all([banner.boundingBox(), page.locator('[data-role="v3-tiles"]').boundingBox()]);
    expect(b, "the banner has a box").not.toBeNull();
    expect(tiles, "the board has a box").not.toBeNull();
    expect(b!.y + b!.height, "the banner ends above the board").toBeLessThanOrEqual(tiles!.y);
    // The format line wraps inside the banner rather than clipping it, and the dismiss keeps its own column.
    const o = await overflowingIn(page, '[data-testid="pad-rules-changed"]', "*", "the rules-changed banner is missing");
    expect(o.clipped, "nothing clipped inside the banner").toEqual([]);
    await expectNoHorizontalScroll(page);
    // Only for a per-screen visual verdict: a crop from the scorebug to the top of the board into W2A_SHOTS_DIR (the switch
    // bracket-finish.spec.ts uses). Unset in CI, where it does nothing.
    const dir = process.env.W2A_SHOTS_DIR;
    if (dir) {
      const width = page.viewportSize()!.width;
      const sy = await page.evaluate(() => window.scrollY);
      const sb = (await scorebug.boundingBox())!;
      const top = Math.max(0, sb.y + sy - 8);
      await page.screenshot({
        path: `${dir}/t15-rules-banner-${width}.png`,
        fullPage: true,
        clip: { x: 0, y: top, width, height: tiles!.y + sy + 120 - top },
      });
    }
  } finally {
    await ctx.close();
  }
});

// Match Day online (plan 2026-11-05-match-day-all-in-one.md Task 6; owner pick: mock Option A, boards are rows; no flag since Match Day all-in-one
// Task 10 retired it - the arbiter round column test that stood above this one is the round panel test below): the online block of Match Day's list at this project's REAL width. One round,
// four boards in four states (a game on file, two held for the organiser, one cancelled with a report to review), every player a realistic
// 43-character name (a long name is what breaks a row). Asserted: the block is the third block of the list and has one round row and a row
// per board; nothing scrolls the page sideways or clips inside it; every row is a 44px target that is HIT-TESTED; below md a tapped board
// opens full-screen over the list with a way back that says where it goes, from md it opens beside the list; "left the list" is the
// shell's driven suite's, the one poll it needs cannot be waited out here. The control set of the block is the one 1280 shows.
test("match day online block: boards are rows of the list; a row opens its panel full-screen below md and beside the list from md; no horizontal scroll; 44px rows", async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);
  const vp = projectViewport();
  expect(vp, "a width project declares its viewport").not.toBeNull();
  const width = vp!.width;
  const phone = width < 768;
  const r = await seedOnlineRound(request, Array.from({ length: 8 }, () => longName()), { camera: "optional", stage: "swiss" });
  // A Swiss stage pairs ONE round at a time: the list has this round and no other (a round-robin would list its paired later rounds too).
  expect(r.boards.length, "premise: four boards").toBe(4);
  const [playing, held, noShow, flagged] = r.boards as [typeof r.boards[number], typeof r.boards[number], typeof r.boards[number], typeof r.boards[number]];
  await roundGameSql(playing, { moves: ["e2e4", "e7e5"] });
  await roundGameSql(held, { moves: ["e2e4", "e7e5"], hold: "mismatch" });
  await holdNoShowSql(noShow.fixtureId);
  await cancelFlaggedSql(r.orgId, flagged.fixtureId);
  // B11 (review): the order is pinned against a court that is THERE. An org starts with no courts, so without this the online block was the only block on the
  // page at most widths and "it comes last" held of any order; with one free court the list has a court block and the online block beside it, in a fixed order.
  const seededCourts = await seedVenueWithCourts(request, ["Court 1"], { orgId: r.orgId });
  expect(seededCourts.courts, "premise: the court the order pin needs was made").toHaveLength(1);
  undoAfterTest.push(() =>
    withDb(async (sql) => {
      // The court, then its venue: both are this test's own rows (a unique venue name), so a sibling spec's courts are never touched.
      await sql`delete from courts where venue_id = ${seededCourts.venueId}`;
      await sql`delete from venues where id = ${seededCourts.venueId}`;
    }),
  );

  const matchDay = `/o/${r.slugs.org}/c/${r.slugs.comp}/match-day`;
  await page.goto(matchDay, { waitUntil: "load" });
  const block = page.getByTestId("md-online");
  await expect(block, "the online block is on the page").toBeVisible({ timeout: 30_000 });
  await expect(block.getByTestId("md-round-row"), "one round row").toHaveCount(1);
  const rows = block.getByTestId("md-board-row");
  await expect(rows, "a row for each board").toHaveCount(r.boards.length);
  // The three blocks' order (spec §5.2): the online block is the LAST of the list column, and it is inside it. Pinned three ways, so an order flip reds each:
  // it is the list's last child; every court row comes BEFORE it in the document; and at least one court row exists (a rule over an empty set holds of any order).
  await expect(page.getByTestId("md-list").getByTestId("md-online"), "the block is in the list column").toHaveCount(1);
  const order = await page.getByTestId("md-list").evaluate((list) => {
    const online = list.querySelector('[data-testid="md-online"]')!;
    const courtRows = [...list.querySelectorAll('[data-testid="md-court-row"]')];
    const kids = [...list.children];
    return {
      onlineIsLastChild: kids[kids.length - 1] === online,
      kids: kids.length,
      courtRows: courtRows.length,
      courtsBeforeOnline: courtRows.filter((row) => (row.compareDocumentPosition(online) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).length,
    };
  });
  expect(order.courtRows, "anti-vacuity: the list has the court row the order is pinned against").toBeGreaterThan(0);
  expect(order.kids, "and the online block has a sibling block before it").toBeGreaterThan(1);
  expect(order.onlineIsLastChild, "the online block is the LAST block of the list column").toBe(true);
  expect(order.courtsBeforeOnline, "and every court row is before it in the document").toBe(order.courtRows);
  const ids = await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-fixture-id")));
  expect(new Set(ids), "each seeded board is one row, once").toEqual(new Set(r.boards.map((b) => b.fixtureId)));

  // ── the default: a phone shows the LIST (nothing was opened); from md the FIRST ROW of the whole list is focused beside it ─────────
  // Design 2026-11-05 §5.2: the desktop's default focus "stays the first row of the whole list, so a court when any court is listed" - the
  // online block is the list's LAST block, so a day with a court focuses that court, not this test's round (B11: at tablet-834 a free
  // "Court 1" came first and the old "the focus is the online round" read red). So the default is asserted as the RULE - the list's first
  // row is the focused one - and this test's own round is addressed by its key, then opened by its row.
  const roundKey = `${r.stageId}:1`;
  const ownRound = block.locator(`[data-testid="md-round-row"][data-key="${roundKey}"]`);
  await expect(ownRound, "this test's own round (its stage, round 1) has the one row of the online block").toHaveCount(1);
  if (phone) {
    await expect(page.getByTestId("md-focus"), "a phone opens on the list").toBeHidden();
  } else {
    const listRows = page.getByTestId("md-list").locator('[data-testid="md-court-row"], [data-testid="md-no-court-row"], [data-testid="md-round-row"], [data-testid="md-board-row"]');
    expect(await listRows.count(), "anti-vacuity: the list has rows").toBeGreaterThan(0);
    await expect(page.getByTestId("md-focus"), "from md the first row is focused beside the list").toBeVisible();
    await expect(listRows.first(), "the list's first row is the focused one (a court when a court is listed, else the round)").toHaveAttribute("aria-current", "true");
    await expect(page.getByTestId("md-focus"), "no board is the default focus").not.toHaveAttribute("data-online", "board");
    // The round row opens its panel beside the list, addressed by ITS key (not "the first row").
    await ownRound.click();
    await expect(page.getByTestId("md-focus")).toHaveAttribute("data-online", "round");
    await expect(page.getByTestId("md-focus"), "the panel is this round's").toHaveAttribute("data-key", roundKey);
    await expect(ownRound).toHaveAttribute("aria-current", "true");
  }

  // ── nothing scrolls sideways, nothing is clipped inside the block ────────────────────────────────────────────────────────────────
  await expectNoHorizontalScroll(page);
  const { clipped, scrollable } = await overflowingIn(page, '[data-testid="md-online"]', "button,li,span,p,h2,div", "the online block was not in the DOM");
  expect(clipped, `the online block clips content at ${width}px`).toEqual([]);
  for (const box of scrollable) expect(box, "a scrolling box that is not keyboard-reachable").toMatch(/tabindex=0$/);

  // ── every row is a 44px target, hit-tested ───────────────────────────────────────────────────────────────────────────────────────
  await assertTapFloor(block.getByTestId("md-round-row"), "the round row");
  // B4 (T6 carry): "Round 1" never breaks inside the round row's title ("Round / 1" at 768, where the right column leaves the title a narrow
  // track). The tail is one no-wrap unit: ONE client rect on every width (a wrapped inline run has one rect per line).
  const tailRects = await ownRound.locator("[data-md-round-tail]").evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return { rects: range.getClientRects().length, text: el.textContent ?? "" };
  });
  expect(tailRects.text, "the tail is the label and the number (the dictionary's words after the division)").toBe(uiEn["matchDay.online.round"]!.split("·")[1]!.replace("{round}", "1").trim());
  expect(tailRects.rects, `"${tailRects.text}" stays on one line at ${width}px`).toBe(1);
  for (let i = 0; i < r.boards.length; i += 1) await assertTapFloor(rows.nth(i), `board row ${i + 1}`);

  // ── a presence ring never stands alone on a line (controller finding V1): each ring is on the line of the LAST client rect of its name's last
  // word. The 43-character names wrap at every phone width; before the fix the ring wrapped onto a line of its own. Read while the list is on screen.
  const rings = await page.evaluate(() => {
    const out: { name: string; ringTop: number; ringBottom: number; lastTop: number; lastBottom: number }[] = [];
    for (const mark of document.querySelectorAll('[data-testid="md-online"] [data-testid="md-presence"]')) {
      const tail = mark.previousElementSibling; // the name's last word, in the same nowrap unit as the ring
      if (!(tail instanceof HTMLElement) || !tail.hasAttribute("data-md-name-tail")) { out.push({ name: "NO-TAIL", ringTop: 0, ringBottom: 0, lastTop: 1, lastBottom: 1 }); continue; }
      const range = document.createRange();
      range.selectNodeContents(tail);
      const rects = [...range.getClientRects()];
      const last = rects[rects.length - 1];
      const ring = mark.getBoundingClientRect();
      out.push({ name: tail.textContent ?? "", ringTop: ring.top, ringBottom: ring.bottom, lastTop: last?.top ?? NaN, lastBottom: last?.bottom ?? NaN });
    }
    return out;
  });
  expect(rings.length, "anti-vacuity: the seeded round draws presence rings (4 boards x 2 seats)").toBeGreaterThan(0);
  for (const g of rings) {
    expect(g.name, "every ring follows its name's last word").not.toBe("NO-TAIL");
    expect(g.ringTop, `ring of "${g.name}" is above its word's last line`).toBeGreaterThanOrEqual(g.lastTop - 1);
    expect(g.ringBottom, `ring of "${g.name}" stands alone below its word's last line`).toBeLessThanOrEqual(g.lastBottom + 1);
  }

  // ── a tap opens THAT board ───────────────────────────────────────────────────────────────────────────────────────────────────────
  const target = page.locator(`[data-testid="md-board-row"][data-fixture-id="${held.fixtureId}"]`);
  await target.scrollIntoViewIfNeeded();
  await target.click();
  const focus = page.getByTestId("md-focus");
  await expect(focus).toBeVisible();
  await expect(focus).toHaveAttribute("data-online", "board");
  await expect(focus).toHaveAttribute("data-fixture-id", held.fixtureId);
  await expect(target).toHaveAttribute("aria-current", "true");
  const focusScan = await overflowingIn(page, '[data-testid="md-focus"]', "button,li,span,p,h2,div", "the board panel was not in the DOM");
  expect(focusScan.clipped, `the board panel clips content at ${width}px`).toEqual([]);
  await expectNoHorizontalScroll(page);
  const back = page.getByTestId("md-back");
  if (phone) {
    // Full-screen over the list: the list is hidden, and the way back is a 44px target that says where it goes.
    await expect(page.getByTestId("md-list"), "below md the list gives way to the panel").toBeHidden();
    await assertTapFloor(back, "the way back");
    // Ruling MD-R27: a board is not a court, so a round or board panel's way back reads "Back to the list" on every day (this one has no court).
    await expect(back).toContainText(uiEn["matchDay.back.list"]!);
    await back.click();
    await expect(page.getByTestId("md-list")).toBeVisible();
    await expect(focus, "back on the list").toBeHidden();
  } else {
    // From md both are on screen: the list stays beside the panel.
    await expect(page.getByTestId("md-list"), "from md the list stays beside the panel").toBeVisible();
  }

  console.log(`[match-day online ${width}px] ${r.boards.length} board rows + 1 round row; ${rings.length} rings on their word's line; clipped ${clipped.length}; ${phone ? "phone: full-screen panel and back" : "tablet: panel beside the list"}`);
});

// Match Day online, Task 7 fix round (review M6): the ROUND PANEL at this project's real width, with the names that break a row. One Swiss
// round open for check-in, three boards, every player a 43-character name (the same shape as the list cell above): the waiting list's rows
// ("Not here yet" - a board's names, Resend, +5) and the link-hold block (a board held for a Lichess link: its names, its reason, "Open round N
// again") are where a name meets a button. Asserted at 320..834: nothing scrolls the page sideways, nothing clips inside the panel, every
// press is a 44px target hit-tested; with the window run out and another board bound, the closed sentence replaces the press, still clean.
test("match day round panel: 43-character names on the check-in rows and the link-hold block do not clip or scroll sideways; presses are 44px targets", async ({
  page,
  request,
}) => {
  test.setTimeout(420_000);
  const vp = projectViewport();
  expect(vp, "a width project declares its viewport").not.toBeNull();
  const width = vp!.width;
  const r = await seedOnlineRound(request, Array.from({ length: 6 }, () => longName()), { camera: "optional", stage: "swiss", open: true });
  expect(r.boards.length, "premise: three boards in round 1").toBe(3);
  const heldBoard = r.boards[0]!;
  // What the open's own skip leaves on a board whose player has not linked Lichess (open-round.ts `heldBoards`).
  await withDb(
    (sql) => sql`update fixture_external_play set status = 'needs_organiser', needs_reason = 'lichess_unlinked', updated_at = now() where fixture_id = ${heldBoard.fixtureId}`,
  );
  const url = `/o/${r.slugs.org}/c/${r.slugs.comp}/match-day?round=${r.stageId}:1`;
  await page.goto(url, { waitUntil: "load" });
  const panel = page.getByTestId("md-focus");
  await expect(panel, "the round panel is on screen").toBeVisible({ timeout: 30_000 });
  await expect(panel).toHaveAttribute("data-online", "round");
  await expect(panel).toHaveAttribute("data-state", "checkin");

  // ── the check-in rows: the two boards still waiting, each seat's name ────────────────────────────────────────────────────────────
  const rows = page.getByTestId("arbiter-waiting-row");
  await expect(rows, "the two boards that are not held are waited on").toHaveCount(2);
  const checkinRows = await rows.count();
  // ── the link-hold block: the held board, its reason, and the round's own press ───────────────────────────────────────────────────
  const block = page.getByTestId("md-round-linkhold");
  await expect(block).toBeVisible();
  await expect(block.getByTestId("md-round-linkhold-board")).toHaveCount(1);
  const again = page.getByTestId("md-round-reopen-cta");
  await expect(again, "nobody is bound to the open: the press is offered, under the reason").toHaveCount(1);
  await expect(block.getByTestId("md-round-reopen-cta"), "and it stands inside the block").toHaveCount(1);

  const check = async (state: string): Promise<{ clipped: number }> => {
    await expectNoHorizontalScroll(page);
    const scan = await overflowingIn(page, '[data-testid="md-focus"]', "button,li,span,p,h2,div", "the round panel was not in the DOM");
    expect(scan.clipped, `the round panel clips content at ${width}px (${state})`).toEqual([]);
    for (const box of scan.scrollable) expect(box, "a scrolling box that is not keyboard-reachable").toMatch(/tabindex=0$/);
    return { clipped: scan.clipped.length };
  };
  const first = await check("check-in rows and a running link hold");
  await assertTapFloor(again, "Open round 1 again");
  await assertTapFloor(rows.first().getByTestId("arbiter-waiting-extend"), "a board's +5");
  await assertTapFloor(page.getByTestId("arbiter-extend-round-cta"), "the round's +5");

  // ── the window run out with another board bound: the closed sentence replaces the press ──────────────────────────────────────────
  await seedSeatInvite(r.boards[1]!.fixtureId, "white", "sent");
  await backdateOpenSql(r.stageId, 1, DEADLINE_AFTER_MS + LINE_DEADLINE_GRACE_MS + 120_000);
  await page.reload({ waitUntil: "load" });
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("md-round-linkhold-board")).toHaveAttribute("data-window-closed", "true");
  await expect(page.getByTestId("md-round-linkhold-closed"), "the closed word is said").toBeVisible();
  await expect(page.getByTestId("md-round-reopen-cta"), "and there is no press to loop on").toHaveCount(0);
  const second = await check("the link hold's window closed");

  console.log(`[match day round panel ${width}px] ${checkinRows} check-in rows, 1 link hold; clipped ${first.clipped}/${second.clipped}`);
});

// Match Day online, Task 8 (the board panel; plan 2026-11-05-match-day-all-in-one.md): the BOARD PANEL at this project's real width, with the names
// that break a row. One Swiss round, two boards, every player a 43-character name: the live board draws the real chessground board with both
// clocks (each a name beside a time), the held board draws its reason, two flag cards and the decisions (a name meets a button). Asserted at
// 320..834: the board and the clocks stay inside the viewport, nothing scrolls the page sideways or clips inside the panel, and every press is a
// 44px target hit-tested; from the live board a way back says where it goes.
test("match day board panel: 43-character names on the clocks, the flag cards and the decisions do not clip or scroll sideways; the board fits the screen; presses are 44px targets", async ({
  page,
  request,
}) => {
  test.setTimeout(420_000);
  const vp = projectViewport();
  expect(vp, "a width project declares its viewport").not.toBeNull();
  const width = vp!.width;
  const phone = width < 768;
  const r = await seedOnlineRound(request, Array.from({ length: 4 }, () => longName()), { camera: "optional", stage: "swiss" });
  expect(r.boards.length, "premise: two boards in round 1").toBe(2);
  const [live, held] = r.boards as [typeof r.boards[number], typeof r.boards[number]];
  const LINE = ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6", "d2d3", "f8c5", "c2c3", "d7d6"];
  await roundGameSql(live, { moves: LINE });
  await roundGameSql(held, { moves: LINE.slice(0, 6), hold: "mismatch" });
  const from = new Date(Date.now() - 20 * 60_000);
  from.setUTCMilliseconds(0);
  const to = new Date(from.getTime() + 95_000);
  const iso = (d: Date) => d.toISOString().replace(".000Z", "Z");
  await withDb(async (sql) => {
    await sql`
      insert into fixture_play_flags (fixture_id, org_id, kind, person_id, note) values
        (${held.fixtureId}, ${r.orgId}, 'out_of_band_play', null,
         ${`plies 2-5 (${LINE.slice(1, 5).join(" ")}) played at Lichess, not through Seazn; camera required`}),
        (${held.fixtureId}, ${r.orgId}, 'camera_lost', ${held.away.personId},
         ${`camera off 95 s of 1800 s in the match: ${iso(from)} to ${iso(to)} (its own off/on events agree); from 2 camera connections over 1 session; camera required`})`;
  });

  const panel = page.getByTestId("md-focus");
  const check = async (state: string): Promise<number> => {
    await expectNoHorizontalScroll(page);
    const scan = await overflowingIn(page, '[data-testid="md-focus"]', "button,li,span,p,h2,div,a", "the board panel was not in the DOM");
    expect(scan.clipped, `the board panel clips content at ${width}px (${state})`).toEqual([]);
    for (const box of scan.scrollable) expect(box, "a scrolling box that is not keyboard-reachable").toMatch(/tabindex=0$/);
    return scan.clipped.length;
  };

  // ── the live board: the real board and both clocks ─────────────────────────────────────────────────────────────────────────────
  const matchDay = `/o/${r.slugs.org}/c/${r.slugs.comp}/match-day`;
  await page.goto(`${matchDay}?board=${live.fixtureId}`, { waitUntil: "load" });
  await expect(panel, "the board panel is on screen").toBeVisible({ timeout: 30_000 });
  await expect(panel).toHaveAttribute("data-fixture-id", live.fixtureId);
  const position = page.getByTestId("md-board-position");
  await expect(position).toBeVisible({ timeout: 30_000 });
  await expect(position.locator("cg-board piece"), "the real board mounted with every piece").toHaveCount(32);
  const boardBox = await position.locator("cg-board").boundingBox();
  expect(boardBox, "the board has a box").not.toBeNull();
  expect(boardBox!.x, "the board starts inside the screen").toBeGreaterThanOrEqual(0);
  expect(boardBox!.x + boardBox!.width, `the board ends inside the ${width}px screen`).toBeLessThanOrEqual(width + 1);
  for (const colour of ["white", "black"]) {
    const clock = position.getByTestId(`md-board-clock-${colour}`);
    await expect(clock, `${colour}'s clock`).toBeVisible();
    const box = (await clock.boundingBox())!;
    expect(box.x + box.width, `${colour}'s clock ends inside the screen`).toBeLessThanOrEqual(width + 1);
    expect(box.height, `${colour}'s clock is tall enough for its name and time`).toBeGreaterThanOrEqual(44);
    await expect(position.getByTestId(`md-board-clock-${colour}-time`), `${colour}'s time is on screen`).toBeVisible();
  }
  const first = await check("the live board");
  await assertTapFloor(page.getByTestId("md-open-pad"), "Open match");
  const back = page.getByTestId("md-back");
  if (phone) {
    await assertTapFloor(back, "the way back");
    await expect(back).toContainText(uiEn["matchDay.back.list"]!);
  }

  // ── the held board: its reason, two flag cards, the decisions ──────────────────────────────────────────────────────────────────
  await page.goto(`${matchDay}?board=${held.fixtureId}`, { waitUntil: "load" });
  await expect(panel).toHaveAttribute("data-fixture-id", held.fixtureId, { timeout: 30_000 });
  await expect(page.getByTestId("md-board-hold")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("md-board-flag"), "both flags are cards").toHaveCount(2, { timeout: 30_000 });
  const goOn = page.getByTestId("arbiter-decision").getByRole("button", { name: uiEn["arbiter.decide.goOn"] });
  const settle = page.getByTestId("arbiter-decision").getByRole("button", { name: uiEn["arbiter.decide.settle"] });
  await expect(goOn).toHaveCount(1);
  await expect(settle).toHaveCount(1);
  const second = await check("the held board with flags and decisions");
  await assertTapFloor(goOn, "Let the game go on");
  await assertTapFloor(settle, "Settle the result now");
  // The settle disclosure is the widest thing the decisions open: its outcomes name two 43-character players (a Swiss round offers three, with the
  // refusal of "No result" said under them).
  await settle.click();
  await expect(page.getByTestId("arbiter-settle").getByRole("button")).toHaveCount(3);
  await expect(page.getByTestId("arbiter-settle-guidance")).toHaveText(uiEn["arbiter.decide.swissNeedsResult"]!);
  for (const choice of await page.getByTestId("arbiter-settle").getByRole("button").all()) await assertTapFloor(choice, "a settle outcome");
  const third = await check("the settle outcomes open");

  console.log(`[match day board panel ${width}px] live board (32 pieces, 2 clocks) + held board (reason, 2 flags, decisions, 3 outcomes + guidance); clipped ${first}/${second}/${third}`);
});

// Match Day online, Task 9 (both players' cameras in the board panel; plan 2026-11-05-match-day-all-in-one.md; design of record: the phone
// composition, cameras AFTER the board and BEFORE the reason, a switch under lg). One Swiss round of 43-character names whose division REQUIRES
// cameras, both players of both boards here. Every width of this matrix is below lg (1024), so the panel is ONE column with a Cameras / Board switch:
// the live board opens on its cameras (the board hidden), the Board press swaps them, and the HELD board opens with its cameras folded to one
// status line a player and a "Show video" press that unfolds them. Asserted at 320..834: no horizontal scroll, nothing clipped inside the panel,
// every control a 44px target, the cameras in the DOM between the board and the reason, and a 43-character name truncated inside its tile.
test("match day board panel, cameras: the switch, the folded held cameras and 43-character names hold at this width; presses are 44px targets; cameras sit after the board and before the reason", async ({
  page,
  request,
}) => {
  test.setTimeout(420_000);
  const vp = projectViewport();
  expect(vp, "a width project declares its viewport").not.toBeNull();
  const width = vp!.width;
  const r = await seedOnlineRound(request, Array.from({ length: 4 }, () => longName()), { camera: "required", stage: "swiss" });
  expect(r.boards.length, "premise: two boards in round 1").toBe(2);
  const [live, held] = r.boards as [typeof r.boards[number], typeof r.boards[number]];
  const LINE = ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6", "d2d3", "f8c5", "c2c3", "d7d6"];
  await roundGameSql(live, { moves: LINE });
  await roundGameSql(held, { moves: LINE.slice(0, 6), hold: "account_changed" });
  for (const board of [live, held]) {
    await putArrival(board.fixtureId, r.orgId, "home", board.home.personId);
    await putArrival(board.fixtureId, r.orgId, "away", board.away.personId);
  }

  const panel = page.getByTestId("md-focus");
  const cameras = page.getByTestId("md-cameras");
  const position = page.getByTestId("md-board-position");
  const check = async (state: string): Promise<void> => {
    await expectNoHorizontalScroll(page);
    const scan = await overflowingIn(page, '[data-testid="md-focus"]', "button,li,span,p,h2,div,a,figure", "the board panel was not in the DOM");
    expect(scan.clipped, `the board panel clips content at ${width}px (${state})`).toEqual([]);
    for (const box of scan.scrollable) expect(box, "a scrolling box that is not keyboard-reachable").toMatch(/tabindex=0$/);
  };
  /** The test ids in document order: the order a phone reads them in. */
  const domOrderNow = (ids: string[]) =>
    page.evaluate((list) => list.map((id) => ({ id, el: document.querySelector(`[data-testid="${id}"]`) })).map((o, i, all) => ({ id: o.id, present: o.el !== null, before: all.slice(0, i).every((p) => p.el === null || o.el === null || (p.el.compareDocumentPosition(o.el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) })), ids);
  /** T10 review M13: the blocks are read from the DOM the moment they exist, not the moment the page said `load` - a decision card or a hold
   *  reason that mounts a poll later read as "not present" under load. Each is waited for (attached; visibility is what the fold denies) first. */
  const domOrder = async (ids: string[]) => {
    for (const id of ids) await expect(page.getByTestId(id).first(), `${id} is in the DOM`).toBeAttached({ timeout: 30_000 });
    return domOrderNow(ids);
  };

  // ── the live board: cameras first, the board one press away ───────────────────────────────────────────────────────────────────
  const matchDay = `/o/${r.slugs.org}/c/${r.slugs.comp}/match-day`;
  await page.goto(`${matchDay}?board=${live.fixtureId}`, { waitUntil: "load" });
  await expect(panel).toHaveAttribute("data-fixture-id", live.fixtureId, { timeout: 30_000 });
  await expect(cameras, "the cameras are on the panel").toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("md-camera-tile")).toHaveCount(2);
  await expect(position, "below lg the cameras are the first view and the board is hidden").toBeHidden();
  const buttons = page.getByTestId("md-camera-switch").getByRole("button");
  await expect(buttons, "Cameras and Board").toHaveCount(2);
  await expect(buttons.nth(0)).toContainText(uiEn["matchDay.cameras.viewCameras"]!);
  await expect(buttons.nth(1)).toContainText(uiEn["matchDay.cameras.viewBoard"]!);
  await expect(buttons.nth(0)).toHaveAttribute("aria-pressed", "true");
  await assertTapFloor(buttons.nth(0), "the Cameras switch");
  await assertTapFloor(buttons.nth(1), "the Board switch");
  // White first, each tile names its player inside its own column (a 43-character name truncates, its full text in the title).
  const tileBoxes: { x: number; right: number; width: number }[] = [];
  for (const colour of ["white", "black"] as const) {
    const tile = page.locator(`[data-testid="md-camera-tile"][data-colour="${colour}"]`);
    await expect(tile).toBeVisible();
    const name = colour === "white" ? live.home.name : live.away.name;
    await expect(tile.locator(`[title="${name}"]`), `${colour}'s 43-character name is in the tile, whole in its title`).toHaveCount(1);
    const box = (await tile.boundingBox())!;
    expect(box.x, `${colour}'s tile starts inside the screen`).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, `${colour}'s tile ends inside the ${width}px screen`).toBeLessThanOrEqual(width + 1);
    tileBoxes.push({ x: box.x, right: box.x + box.width, width: box.width });
  }
  expect(tileBoxes[0]!.x, "White is the first tile").toBeLessThanOrEqual(tileBoxes[1]!.x);
  await check("the live board, cameras");

  // Board: the swap. The board is a real board again, the cameras are hidden, and the seat cards (the names the tiles carried) are back.
  await buttons.nth(1).click();
  await expect(buttons.nth(1)).toHaveAttribute("aria-pressed", "true");
  await expect(position).toBeVisible();
  await expect(position.locator("cg-board piece"), "the real board mounted with every piece").toHaveCount(32);
  await expect(cameras, "the cameras give the phone up").toBeHidden();
  await expect(page.getByTestId("md-cameras-toggle"), "and so does their fold press (it is on the state row, MD-R36)").toBeHidden();
  await expect(page.getByTestId("md-board-seats"), "the seat cards name the players when the tiles are hidden").toBeVisible();
  await check("the live board, board");
  // And back: the cameras return without a reload.
  await buttons.nth(0).click();
  await expect(cameras).toBeVisible();
  await expect(page.getByTestId("md-cameras-toggle")).toBeVisible();
  await expect(position).toBeHidden();

  // The order a phone reads in the DOM (the switch hides one of the two, it never reorders them): board, THEN cameras.
  const order = await domOrder(["md-board-position", "md-board-cameras"]);
  expect(order.every((o) => o.present), "both blocks are in the DOM").toBe(true);
  expect(order.every((o) => o.before), "the board is before the cameras").toBe(true);

  // ── the held board: cameras folded, the reason after them, the decision reachable ────────────────────────────────────────────
  await page.goto(`${matchDay}?board=${held.fixtureId}`, { waitUntil: "load" });
  await expect(panel).toHaveAttribute("data-fixture-id", held.fixtureId, { timeout: 30_000 });
  await expect(page.getByTestId("md-board-hold")).toBeVisible({ timeout: 30_000 });
  await expect(cameras, "a held board opens with its cameras folded").toHaveAttribute("data-folded", "true");
  await expect(page.getByTestId("md-camera-tile")).toHaveCount(2);
  const heldOrder = await domOrder(["md-board-position", "md-board-cameras", "md-board-hold", "arbiter-decision"]);
  expect(heldOrder.every((o) => o.present), "the board, the cameras, the reason and the decision are all in the DOM").toBe(true);
  expect(heldOrder.every((o) => o.before), "the DOM reads: board, cameras, reason, decision").toBe(true);
  const toggle = page.getByTestId("md-cameras-toggle");
  await assertTapFloor(toggle, "Show video");
  await expect(toggle).toHaveText(uiEn["matchDay.cameras.show"]!);
  await check("the held board, cameras folded");
  await toggle.click();
  await expect(cameras).toHaveAttribute("data-folded", "false");
  await expect(toggle).toHaveText(uiEn["matchDay.cameras.hide"]!);
  await check("the held board, cameras unfolded");
  // This held board carries no flag, so "Let the game go on" is not offered; the decision it does offer is Resync and Settle.
  await assertTapFloor(page.getByTestId("arbiter-decision").getByRole("button", { name: uiEn["arbiter.decide.resync"] }), "Resync from Lichess");
  await assertTapFloor(page.getByTestId("arbiter-decision").getByRole("button", { name: uiEn["arbiter.decide.settle"] }), "Settle the result now");

  console.log(`[match day cameras ${width}px] live (switch, 2 tiles, 43-char names) + held (folded, unfolded, reason after the cameras)`);
});
