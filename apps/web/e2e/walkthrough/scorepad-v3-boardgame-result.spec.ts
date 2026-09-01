// R7/A2 — boardgame: the tapModel-S GRAMMAR itself, owner ruling R7-2 quoted
// verbatim in `v3/skins/boardgame.tsx`'s own header: "tap DECIDES, dock
// enriches." A tap on a player half commits `boardgame.result` IMMEDIATELY;
// the ribbon reads the result in words with Undo; a ~12s dock (`HOLD_MS`)
// then offers Method as OPTIONAL enrichment. This is the grammar this skin
// shipped ONCE, the OPPOSITE way (tapModel T: every action a tile opening a
// guided sheet, nothing committed until the sheet's own Confirm) — the
// owner considered that argument and rejected it. This file exists to prove
// the ACCEPTED grammar actually ships, not the rejected one: a ledger row
// must appear from the tap ALONE, and a Method chip must ENRICH that same
// held row rather than post a second event.
//
// Two branches, two tests (`buildDock`'s own DISJOINT-BY-INTENT
// vocabularies, boardgame.ts:378-385 — DECISIVE_METHODS after a half tap,
// DRAWN_METHODS after the "Draw / no result" tile, never one flat 13-value
// list, R7-10): a decisive half tap, and the draw tile. Both are terminal —
// `decideResult` sets `phase: "done"` unconditionally for either branch, so
// EITHER tap alone already reaches the match's own terminal state; there is
// no multi-phase transition to drive through first, unlike carrom's or
// badminton's own game/set boundaries.
//
// COST: every UI assertion below happens BEFORE the held event is flushed
// ("Send now" / the hold expiring), because the fixture-console shell polls
// the fixture's SERVER status independently of the pad's own optimistic
// fold and can unmount the pad the instant it observes "decided" — so this
// file never touches the UI again after flushing. The eventual ledger/
// outcome checks that follow a flush go through the API only, the same
// "prove it against the real record, not the screen" split every sibling
// walkthrough takes for its own post-decide checks.
//
// Set DEMO_PACE=<ms> and run with `--headed` to watch it happen in a real
// browser; DEMO_HOLD=<ms> keeps the window open at the end.
import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { apiJson, expectNoHorizontalScroll, fixturePath, seedRosteredFixture, TAG } from "../helpers";
import { HOLD_MS } from "../../src/components/v2/scorepad/queue";

test.describe.configure({ mode: "parallel" });

function pad(page: Page) {
  return page.locator('[data-testid="score-pad"]');
}
function scorebug(page: Page) {
  return pad(page).locator('[data-role="v3-scorebug"]');
}
/** Scoped to `button` deliberately, matching every sibling walkthrough's own
 *  `half`: a half renders EITHER a `<button>` (tappable, tapModel S) OR a
 *  plain `<div>` at the same grid position, and a wildcard locator happily
 *  "clicks" the dead `<div>`. */
function half(page: Page, side: "home" | "away") {
  return scorebug(page).locator(".grid > button").nth(side === "home" ? 0 : 1);
}
function ribbon(page: Page) {
  return pad(page).locator('[data-role="v3-ribbon"]');
}
function dock(page: Page) {
  return pad(page).locator('[data-role="v3-dock"]');
}
function tile(page: Page, id: string) {
  return pad(page).locator(`[data-tile-id="${id}"]`);
}

type LedgerEvent = { id: string; seq: number; type: string; payload: Record<string, unknown> };

async function ledger(request: APIRequestContext, fixtureId: string): Promise<LedgerEvent[]> {
  const res = await apiJson<LedgerEvent[]>(request, `/api/v1/fixtures/${fixtureId}/events?since_seq=0`);
  expect(res.status, `ledger read failed: ${JSON.stringify(res.error)}`).toBe(200);
  return res.data ?? [];
}
async function resultsOf(request: APIRequestContext, fixtureId: string): Promise<LedgerEvent[]> {
  return (await ledger(request, fixtureId)).filter((e) => e.type === "boardgame.result");
}
async function fixtureState(request: APIRequestContext, fixtureId: string) {
  const res = await apiJson<{
    status: string;
    outcome: { kind?: string; winner?: string; method?: string } | null;
  }>(request, `/api/v1/fixtures/${fixtureId}/state`);
  expect(res.status, `state read failed: ${JSON.stringify(res.error)}`).toBe(200);
  return res.data!;
}

const PACE = Number(process.env.DEMO_PACE ?? 0);
const HOLD = Number(process.env.DEMO_HOLD ?? 0);
async function beat(page: Page): Promise<void> {
  if (PACE > 0) await page.waitForTimeout(PACE);
}

let shotNo = 0;
async function shot(page: Page, caption: string): Promise<void> {
  shotNo += 1;
  const n = String(shotNo).padStart(2, "0");
  for (const width of [1280, 768, 320]) {
    await page.setViewportSize({ width, height: 1100 });
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: `e2e-artifacts/boardgame-result/${n}-${caption}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 1100 });
}

// 2 taps worst-case (the half/draw tap, then the method chip) — derived from
// HOLD_MS per AGENTS.md's own rule, even though "Send now" keeps the real
// cost far under a full hold in the common case.
const TEST_TIMEOUT = Math.max(180_000, 60_000 + 2 * (HOLD_MS + 2_000));

test("R7/A2 — boardgame: a half tap commits the result immediately, and a Method chip enriches the same held row", async ({
  page,
}) => {
  test.setTimeout(TEST_TIMEOUT);
  shotNo = 0;

  const homeName = `V3 Boardgame Home ${TAG}`;
  const awayName = `V3 Boardgame Away ${TAG}`;
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 Boardgame Result ${TAG}`,
    sportKey: "boardgame",
    variantKey: "classical",
    entrantKind: "individual",
    home: [{ fullName: homeName }],
    away: [{ fullName: awayName }],
    emitCoreStart: true,
  });

  await page.goto(await fixturePath(page.request, fx.fixtureId));
  await expect(pad(page)).toBeVisible({ timeout: 20_000 });
  await expect(half(page, "home"), "a live fixture must render a tappable half").toBeVisible();
  await shot(page, "match-open");

  expect(
    (await resultsOf(page.request, fx.fixtureId)).length,
    "no result must exist before anything is tapped",
  ).toBe(0);

  // ---- THE TAP: commits `boardgame.result` IMMEDIATELY. No sheet, no
  // Confirm — the rejected tapModel-T design is the ONE this proves absent.
  await beat(page);
  await half(page, "home").click();

  // ---- ASSERTED WITH NOTHING ELSE TAPPED YET — the ruling's own core
  // claim. `pipeline.events` (use-pad-pipeline.ts) folds in the HELD event
  // optimistically before it ever reaches the server, so this needs no wait
  // for a network round trip: the ribbon and dock are a DIRECT consequence
  // of the tap itself.
  await expect(ribbon(page), "the ribbon must read the result in words the instant the half is tapped").toContainText(
    "Result recorded",
    { timeout: 5_000 },
  );
  await expect(ribbon(page), "the ribbon must name the winner, not just say something was recorded").toContainText(
    "Home",
  );
  await expect(
    ribbon(page).getByRole("button", { name: "Take back", exact: true }),
    "a result committed by a tap must carry Undo immediately",
  ).toBeVisible();
  await expect(dock(page), "a decisive tap must open the enrichment dock").toBeVisible({ timeout: 5_000 });
  await expect(dock(page), "the dock must offer the DECISIVE method set").toContainText("Checkmate");
  await expect(
    dock(page),
    "a decisive tap's dock must not offer the DRAWN-only method set (R7-10)",
  ).not.toContainText("Stalemate");
  await expect(dock(page)).not.toContainText("Draw by agreement");
  await shot(page, "committed-immediately");

  // ---- A METHOD CHIP ENRICHES THE HELD ROW, never posts a second event ----
  // `DockChip.mutate` writes straight to the durable IndexedDB queue store
  // (`makeDockStore`/`mutateHeld`, detail-dock.tsx) — a DIFFERENT surface
  // from the React `pendingEnvelopes` snapshot the ribbon renders from
  // (use-pad-pipeline.ts), which is captured once at enqueue time and only
  // replaced once the event actually round-trips. So the chip's own
  // pressed/selected state — not the ribbon line — is the live evidence a
  // tap registered; the ribbon (and the server) only pick up "Checkmate"
  // once this flushes, checked below against the real ledger.
  const checkmateChip = dock(page).getByRole("button", { name: "Checkmate", exact: true });
  await beat(page);
  await checkmateChip.click();
  await expect(checkmateChip, "the tapped Method chip must show as selected").toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // Flush now — no more UI assertions past this point (see this file's own
  // header on why).
  await dock(page).getByRole("button", { name: "Send now", exact: true }).click();

  await expect
    .poll(async () => (await resultsOf(page.request, fx.fixtureId)).length, {
      timeout: HOLD_MS + 10_000,
      message: "the tap never reached the server ledger",
    })
    .toBe(1);
  const results = await resultsOf(page.request, fx.fixtureId);
  expect(results.length, "the Method chip must enrich the held row, never post a second event").toBe(1);
  expect(results[0]!.payload.winner, "the wrong side was recorded as winner").toBe(fx.homeEntrantId);
  expect(results[0]!.payload.method, "the tapped Method chip never reached the payload").toBe("checkmate");

  const decided = await fixtureState(page.request, fx.fixtureId);
  expect(decided.status, "a decisive result must decide the match").toBe("decided");
  expect(decided.outcome, "a decided boardgame result carries no outcome").not.toBeNull();
  expect(decided.outcome!.winner).toBe(fx.homeEntrantId);
  expect(decided.outcome!.method).toBe("checkmate");

  if (HOLD > 0) await page.waitForTimeout(HOLD);
});

test("R7/A2 — boardgame: the Draw / no result tile opens the DRAWN method set, and the scorebug reads ½–½", async ({
  page,
}) => {
  test.setTimeout(TEST_TIMEOUT);
  shotNo = 0;

  const homeName = `V3 Boardgame Draw Home ${TAG}`;
  const awayName = `V3 Boardgame Draw Away ${TAG}`;
  const fx = await seedRosteredFixture(page.request, {
    label: `V3 Boardgame Draw ${TAG}`,
    sportKey: "boardgame",
    variantKey: "classical",
    entrantKind: "individual",
    home: [{ fullName: homeName }],
    away: [{ fullName: awayName }],
    emitCoreStart: true,
  });

  await page.goto(await fixturePath(page.request, fx.fixtureId));
  await expect(pad(page)).toBeVisible({ timeout: 20_000 });
  const drawTile = tile(page, "draw");
  await expect(drawTile, "the Draw / no result tile must be reachable live").toBeVisible();
  await shot(page, "match-open");

  // ---- THE DRAW TILE: the one outcome no half tap can express — posts the
  // SAME `boardgame.result` type, `winner: null`, directly (a tile action
  // CAN post an event with no sheet at all).
  await beat(page);
  await drawTile.click();

  // Asserted with nothing else tapped, same posture as the decisive test.
  await expect(dock(page), "the draw tile must open the enrichment dock").toBeVisible({ timeout: 5_000 });
  await expect(dock(page), "a drawn tap's dock must offer the DRAWN method set").toContainText("Stalemate");
  await expect(dock(page)).toContainText("Draw by agreement");
  await expect(
    dock(page),
    "a drawn tap's dock must not offer the DECISIVE-only methods (R7-10)",
  ).not.toContainText("Checkmate");
  await expect(dock(page)).not.toContainText("Resignation");
  await expect(dock(page)).not.toContainText("Flag fall");

  // The scorebug must already read the official half-point score — off the
  // engine's own `summary()`, folded optimistically, not re-derived here
  // (`reference_state_goals_is_not_the_official_score.md`).
  const homeBig = scorebug(page).locator(".grid > *").nth(0).locator(".app-display.font-bold");
  const awayBig = scorebug(page).locator(".grid > *").nth(1).locator(".app-display.font-bold");
  await expect(homeBig, "a draw must credit both sides the half-point, not zero").toHaveText("½", {
    timeout: 5_000,
  });
  await expect(awayBig).toHaveText("½");
  await shot(page, "drawn-half-point");

  // Flush now — no more UI assertions past this point.
  await dock(page).getByRole("button", { name: "Send now", exact: true }).click();

  await expect
    .poll(async () => (await resultsOf(page.request, fx.fixtureId)).length, {
      timeout: HOLD_MS + 10_000,
      message: "the draw tile's tap never reached the server ledger",
    })
    .toBe(1);
  const results = await resultsOf(page.request, fx.fixtureId);
  expect(results[0]!.payload.winner, "a draw must record winner: null, never an entrant id").toBeNull();

  const decided = await fixtureState(page.request, fx.fixtureId);
  expect(decided.status, "the draw tile must decide the match too — it is the SAME terminal event type").toBe(
    "decided",
  );
  expect(decided.outcome, "a decided draw carries no outcome").not.toBeNull();
  expect(decided.outcome!.kind, "a winner: null result with no double_forfeit method must read as a draw").toBe(
    "draw",
  );

  if (HOLD > 0) await page.waitForTimeout(HOLD);
});
