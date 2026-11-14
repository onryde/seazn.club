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
} from "../helpers";
import { longName, roundGameSql, seedOnlineRound, uiEn } from "../match-room-kit";
import { ARMAGEDDON_RESULTS } from "@seazn/engine/sports/boardgame";
import {
  HIT_TARGET_FLOOR_PX,
  consentedAnonymousState,
  dismissCookieBanner,
  floorViolationLines,
  hitTargetFloorReport,
} from "../scorepad-a11y-kit";
import { openMatchActions } from "../helpers/match-actions";
import { v3Sheet, assertTapFloor, padTile, dlDict, projectViewport, projectTag } from "./_shared";

// Not serial: no test here reads state another test writes (no module-level `let` is shared), so one red does not skip the rest (AGENTS.md class 21).

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
    destination: null, lastTakeover: null, auto: null, legacy: false, finished: false, session: null,
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

// The Arbiter Panel's round column (phase 2, spec 2026-10-24-arbiter-round-column-design.md §5.1, §7; C27): at this project's REAL
// width. Below md the column is the first thing on the page, then the waiting seats, then the board picker; from md `main` is two
// tracks and the column is the right-hand one, with the decision area under the camera and above the waiting list (Task 16 D4). Asserted as the order and the edges of what is
// on screen, not as box sizes, so a groomed shrink of the desktop layout cannot pass for the phone composition. Every control in the
// column and in the waiting list is at least 44px and HIT-TESTED (the paint box is not the tap area), nothing scrolls the page
// sideways, and the visible control set of `main` is the one 1280 shows from the same seed, apart from the two controls that exist
// at one width only: the picker (below lg) and the board list (lg and up). Nothing in the column is folded behind a disclosure.
//
// mobile.spec.ts is a SERIAL file (`describe.configure({ mode: "serial" })`): a red test aborts the rest of its project, so a CI
// count for this file is a floor, not a total (AGENTS class 21). This test seeds its own round and reads nothing an earlier test left.
test("arbiter round column: below md the column leads the page; from md it is the right-hand column; no horizontal scroll; 44px targets", async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  const vp = projectViewport();
  expect(vp, "a width project declares its viewport").not.toBeNull();
  const width = vp!.width;
  const phone = width < 768;
  // Two boards, the first with two realistic 43-character names (a long name is what breaks a column), the second held by a mismatch so
  // the queue has a card to review: the column has its queue, its hero and its waiting list at once. `camera: optional` puts the tile
  // on screen with no camera duty.
  const r = await seedOnlineRound(request, [longName(), longName(), `Mo Phone ${TAG}`, `Ny Width ${TAG}`], { camera: "optional" });
  expect(r.boards.length, "premise: two boards").toBe(2);
  const heldBoards = [r.boards[1]!];
  for (const b of heldBoards) await roundGameSql(b, { moves: ["e2e4", "e7e5"], hold: "mismatch" });
  // The waiting list lists the boards still checking in: the ones not held. Derived from the seed, not read back from the page.
  const waitingRows = r.boards.length - heldBoards.length;
  expect(waitingRows, "premise: the seed leaves one board checking in").toBe(1);

  await page.goto(r.arbiterPath, { waitUntil: "load" });
  const col = page.getByTestId("arbiter-round-column");
  const waiting = page.getByTestId("arbiter-waiting");
  await expect(col).toHaveAttribute("data-phase", "checkin", { timeout: 30_000 });
  await expect(waiting, "premise: board 1 is waiting for its seats").toBeVisible({ timeout: 30_000 });
  // Two scopes, not one: the panel mounts the waiting list in its board group, OUTSIDE the column's `aside` (spec §5.1). Every scan
  // below names which of the two it reads, and each is proved non-empty for its own scope. The negative (nothing of the list inside the
  // aside) is paired with the positive just above and the row count that follows.
  await expect(col.getByTestId("arbiter-waiting"), "the waiting list is not inside the column").toHaveCount(0);
  await expect(waiting.getByTestId("arbiter-waiting-row"), "one row for each board still checking in").toHaveCount(waitingRows);
  await expect(col.getByTestId("arbiter-column-review"), "premise: the held board has a card to review").toBeVisible();
  // The decision area is measured below (tablet: above the waiting list). It renders for the board on screen only when that board has
  // something to offer; the panel opens on the FIRST board, which the seed leaves checking in with its round open, so "+5 min" (or the
  // reason it is not offered) and "Settle the result now" are there. Said as a premise, so a seed that stops offering either fails here by
  // name instead of as "the decision area is not on screen" at the measurement.
  await expect(page.getByTestId("arbiter-decision"), "premise: the board on screen (board 1, checking in) has a decision area").toBeVisible();
  // The panel's own `main`: the one that holds the column (the page has no other, but the scope is stated, not assumed).
  const panelMain = page.locator('main:has([data-testid="arbiter-round-column"])');
  await expect(panelMain.locator("figure"), "premise: the camera tile is on screen").toHaveCount(1);
  const phase = await col.getAttribute("data-phase");

  // ── where things are ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  await page.evaluate(() => window.scrollTo(0, 0));
  const rects = await page.evaluate(() => {
    const at = (el: Element | null | undefined) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { top: b.top + window.scrollY, bottom: b.bottom + window.scrollY, left: b.left, right: b.right };
    };
    return {
      aside: at(document.querySelector('[data-testid="arbiter-round-column"]')),
      waiting: at(document.querySelector('[data-testid="arbiter-waiting"]')),
      picker: at(document.querySelector('[data-testid="arbiter-round-column"]')?.closest("main")?.querySelector("select")?.closest("label")),
      decision: at(document.querySelector('[data-testid="arbiter-decision"]')),
      camera: at(document.querySelector('[data-testid="arbiter-round-column"]')?.closest("main")?.querySelector("figure")),
    };
  });
  function need<T>(v: T | null, what: string): T {
    expect(v, `${what} is on screen at ${width}px`).not.toBeNull();
    return v!;
  }
  const aside = need(rects.aside, "the column");
  const wait = need(rects.waiting, "the waiting list");
  const camera = need(rects.camera, "the camera tile");
  const relations: string[] = [];
  const holds = (ok: boolean, what: string) => {
    expect(ok, `${what} at ${width}px`).toBe(true);
    relations.push(what);
  };
  if (phone) {
    const picker = need(rects.picker, "the board picker");
    holds(aside.top < picker.top, "the column's top is above the picker's top");
    holds(wait.top >= aside.bottom - 1, "the waiting list starts below the column");
    holds(wait.bottom <= picker.top + 1, "the waiting list ends above the picker");
  } else {
    // 768 and 834 are md and not lg (lg is 1024): two tracks, the board then the decision then the waiting list in the first, the column in
    // the second. (The panel's two groups are `display: contents` here and have no box to measure, so the boxes that are drawn are read:
    // the camera, the decision area and the list. Task 16 D4: the decision area sits ABOVE the list, not below the whole of it.)
    expect(width, "premise: the tablet widths are md, not lg").toBeLessThan(1024);
    const decision = need(rects.decision, "the decision area");
    holds(aside.left >= camera.right - 1, "the column is right of the camera");
    holds(aside.left >= decision.right - 1, "the column is right of the decision area");
    holds(decision.top >= camera.bottom - 1, "the decision area is below the camera");
    holds(decision.bottom <= wait.top + 1, "the decision area is above the waiting list");
    holds(wait.top >= camera.bottom - 1, "the waiting list is under the camera");
    // The waiting list is in the board track, not the column's: its right edge stops short of the column's left (the relation the
    // box-measuring version of this branch checked as "the column is right of the board group", which the list was part of).
    holds(aside.left >= wait.right - 1, "the column is right of the waiting list");
  }
  const expectedRelations = phone ? 3 : 6;
  expect(relations.length, "anti-vacuity: every relation of this branch was checked").toBe(expectedRelations);

  // ── the sideways scroll, and what overflows inside the column ─────────────────────────────────────────────────────────────────────
  // `expectNoHorizontalScroll` is the gate: it lifts `html, body { overflow-x: clip }` (globals.css) before it measures. A raw
  // `documentElement.scrollWidth <= clientWidth` beside it was removed because it cannot fail under that clip, so it only looked
  // like a second proof. What overflows INSIDE the column is the scan below.
  await expectNoHorizontalScroll(page);
  // A box whose extra content cannot be reached is a defect; one that scrolls is a feature that must be a tab stop (AGENTS class 23).
  let scanned = 0;
  for (const root of ['[data-testid="arbiter-round-column"]', '[data-testid="arbiter-waiting"]']) {
    const { clipped, scrollable } = await overflowingIn(page, root, "button,a,p,span,li,h2,div", `${root} was not in the DOM`);
    expect(clipped, `${root} clips content at ${width}px`).toEqual([]);
    for (const box of scrollable) expect(box, `${root}: a scrolling box that is not keyboard-reachable`).toMatch(/tabindex=0$/);
    scanned += 1;
  }
  expect(scanned, "anti-vacuity: the column and the waiting list were both scanned").toBe(2);

  // ── 44px, measured and hit-tested ──────────────────────────────────────────────────────────────────────────────────────────────────
  const tapTargets = (scope: string) =>
    page.evaluate((sel) => {
      const root = document.querySelector(sel);
      if (!root) return null;
      return Array.from(root.querySelectorAll<HTMLElement>("button, a[href]")).map((el) => {
        el.scrollIntoView({ block: "center", inline: "nearest" });
        const b = el.getBoundingClientRect();
        const shown = b.width > 0 && b.height > 0 && getComputedStyle(el).visibility !== "hidden";
        const hit = shown ? document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2) : null;
        return {
          testid: el.getAttribute("data-testid"),
          name: (el.getAttribute("aria-label") ?? el.innerText ?? "").trim().replace(/\s+/g, " ").slice(0, 60),
          role: el.tagName.toLowerCase(),
          disabled: (el as HTMLButtonElement).disabled === true,
          width: Math.round(b.width * 100) / 100,
          height: Math.round(b.height * 100) / 100,
          shown,
          reachable: hit !== null && (hit === el || el.contains(hit)),
        };
      });
    }, scope);
  const counts: string[] = [];
  // [label, scope, the control that scope must offer, how many of it]: the hero's one press in the column, one board link per row in the list.
  const scopes: [string, string, string, number][] = [
    ["the column", '[data-testid="arbiter-round-column"]', "arbiter-column-reinvite", 1],
    ["the waiting list", '[data-testid="arbiter-waiting"]', "arbiter-waiting-board", waitingRows],
  ];
  for (const [label, scope, mustHave, mustHaveCount] of scopes) {
    const all = await tapTargets(scope);
    expect(all, `${label} is in the DOM`).not.toBeNull();
    const shown = all!.filter((t) => t.shown);
    expect(shown.length, `anti-vacuity: ${label} has controls on screen at ${width}px`).toBeGreaterThan(0);
    expect(shown.map((t) => t.testid), `${label} offers ${mustHave}`).toContain(mustHave);
    expect(shown.filter((t) => t.testid === mustHave).length, `${label} offers ${mustHave} ${mustHaveCount} time(s) at ${width}px`).toBe(mustHaveCount);
    const report = hitTargetFloorReport(shown.map((t) => ({ name: t.name, role: t.role, disabled: t.disabled, width: t.width, height: t.height })));
    expect(report.operable.length, `anti-vacuity: ${label} has operable controls`).toBeGreaterThan(0);
    expect(floorViolationLines(report), `${label}: every control is at least ${HIT_TARGET_FLOOR_PX}px at ${width}px`).toEqual([]);
    const operable = shown.filter((t) => !t.disabled);
    expect(
      operable.filter((t) => !t.reachable).map((t) => t.name),
      `${label}: every control's centre hits the control itself at ${width}px (nothing covers it)`,
    ).toEqual([]);
    counts.push(`${label} ${report.operable.length} controls, ${operable.filter((t) => t.reachable).length} hit-tested`);
  }
  // The column's own controls, by what they are: the queue's Review and the hero's press (both in the column), the row's board link.
  await expect(col.getByTestId("arbiter-column-review")).toBeVisible();

  // ── the control set of `main`, against the same page at 1280 ─────────────────────────────────────────────────────────────────────
  const controlSet = () =>
    page.evaluate(() => {
      const column = document.querySelector('[data-testid="arbiter-round-column"]');
      const waiting = document.querySelector('[data-testid="arbiter-waiting"]');
      const main = column?.closest("main") ?? null;
      const nav = main?.querySelector("nav") ?? null;
      if (!main) return null;
      const keyOf = (el: HTMLElement) =>
        el.getAttribute("data-testid") ??
        el.getAttribute("aria-label") ??
        `${el.tagName.toLowerCase()}:${(el.innerText ?? "").trim().replace(/\s+/g, " ").slice(0, 60)}`;
      return Array.from(main.querySelectorAll<HTMLElement>('button, a[href], select, [role="button"], input, textarea'))
        .filter((el) => {
          const b = el.getBoundingClientRect();
          return b.width > 0 && b.height > 0 && getComputedStyle(el).visibility !== "hidden";
        })
        .map((el) => ({ key: keyOf(el), picker: el.tagName === "SELECT", inNav: nav !== null && nav.contains(el), inColumn: column !== null && column.contains(el), inWaiting: waiting !== null && waiting.contains(el) }));
    });
  const here = await controlSet();
  expect(here, "main is on screen").not.toBeNull();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.getByRole("navigation", { name: uiEn["arbiter.boardsHeading"] }), "at 1280 the board list is on screen").toBeVisible();
  const desk = await controlSet();
  expect(desk, "main is on screen at 1280").not.toBeNull();
  await page.setViewportSize(vp!);
  await expect(panelMain.locator("select"), "back at the project's width the picker is on screen").toBeVisible();
  await expectNoHorizontalScroll(page);

  const boardCount = r.boards.length;
  expect(here!.filter((c) => c.picker).length, `the picker is in the set below lg (${width}px)`).toBe(1);
  expect(here!.filter((c) => c.inNav).length, `the board list is not in the set below lg (${width}px)`).toBe(0);
  expect(desk!.filter((c) => c.picker).length, "the picker is not in the set at 1280").toBe(0);
  expect(desk!.filter((c) => c.inNav).length, "the board list has a button per board at 1280").toBe(boardCount);
  // Everything else is the same controls with the same repeats: MEMBERSHIP and REPEATS, as sorted multisets. Visual order is not
  // claimed here: it is the layout relations above, and with one DOM branched by Tailwind the source order is the same at both
  // widths by construction, so comparing it would prove nothing a width change could move.
  const multiset = (keys: string[]) => [...keys].sort();
  const same = (list: NonNullable<typeof here>) => multiset(list.filter((c) => !c.picker && !c.inNav).map((c) => c.key));
  expect(same(here!), `membership and repeats: the control set at ${width}px, less the picker, is the one 1280 shows, less its board list`).toEqual(same(desk!));
  expect(same(here!).length, "anti-vacuity: the set has controls in it").toBeGreaterThan(0);
  const inColumn = (list: NonNullable<typeof here>) => multiset(list.filter((c) => c.inColumn).map((c) => c.key));
  expect(inColumn(here!), "membership and repeats: the column's controls are the same at both widths").toEqual(inColumn(desk!));
  expect(inColumn(here!).length, "anti-vacuity: the column has controls at both widths").toBeGreaterThan(0);
  // The waiting list is its own scope (outside the aside), so the column's comparison above says nothing about it: it gets its own.
  const inWaiting = (list: NonNullable<typeof here>) => multiset(list.filter((c) => c.inWaiting).map((c) => c.key));
  expect(inWaiting(here!), "membership and repeats: the waiting list's controls are the same at both widths").toEqual(inWaiting(desk!));
  expect(inWaiting(here!).length, "anti-vacuity: the waiting list has controls at both widths").toBeGreaterThan(0);
  expect(here!.filter((c) => c.inColumn && c.inWaiting).length, "the two scopes share no control").toBe(0);

  console.log(
    `[arbiter-column ${width}px] data-phase=${phase}; ${relations.length}/${expectedRelations} layout relations held (${relations.join("; ")}); ${counts.join("; ")}; ` +
      `control set ${here!.length} at ${width}px vs ${desk!.length} at 1280 (column ${inColumn(here!).length} vs ${inColumn(desk!).length}, waiting list ${inWaiting(here!).length} vs ${inWaiting(desk!).length})`,
  );
});
