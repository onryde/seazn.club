// ONE organiser gets a knockout result wrong, voids it, scores it the other
// way, and follows the name the final holds — driven on the organiser console.
//
// THE DEFECT (owner report, 2026-09-23). Voiding a DECIDED knockout result
// erased the outcome but left the winner seated in the next match: `fillSlot`
// only ever fills an EMPTY seat, and nothing emptied one. Re-scoring the match
// the other way then ran a fill that touched no row, so the final kept the
// player who had been voided out — with no control on any screen to fix it
// short of "Rebuild fixtures", which wipes the schedule.
//
// THE RULING (owner-approved, 2026-09-23; `server/engine-db/fed-seats.ts`):
//   - the void empties the seat the result filled and restores its
//     "Winner of R1·1" label — while the next match has not started;
//   - once it HAS started, the void is refused before anything is written,
//     with a message naming the next match in the organiser's own language —
//     by the SAME label the schedule board shows it by (fix round 2 ruling):
//     a knockout final is "F·1" there, never "R2·1" — and the organiser voids
//     that one first.
//
// WHY A WALKTHROUGH. The server tests (`knockout-void-unfill.test.ts`) prove
// every rule against the rows. What none of them can see is the organiser's
// side of it: that the final's own console reads the voided player's name, then
// "Winner of R1·1", then the NEW winner's name, across three separate visits;
// and that the refusal reaches the screen as a sentence in French rather than
// as the server's English (`scoringErrorText` rebuilds it from the error's
// code and `next_match`, which is a seam no unit test drives end to end).
//
// WHAT IS A REACH AND WHAT IS THE TEST. Per this folder's README: the
// competition, the division, its four entrants, the draw, the other semi's
// result and the final's kick-off are REACHES over the API. Both of R1·1's
// results are scored on the pad, the void is the console's own "Void last
// entry", and every claim about the final is read off the final's console.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { TAG, addEntrantsViaApi, apiJson, expectNoHorizontalScroll, failOnNativeDialog, fixturePath, scoreFixture } from "../helpers";
import { HOLD_MS } from "../../src/components/v2/scorepad/queue";
import { nextMatchStartedMessage } from "../../src/lib/next-match-started";
import { composeMatchRef } from "../../src/lib/match-ref";
import { boardRoundCodes } from "../../src/components/v2/board/round-codes";

/** The product's own words, from the dictionaries it renders — never retyped,
 *  so a copy change moves the assertion with it. */
const dictionary = (locale: "en" | "fr") =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../src/dictionaries/${locale}/ui.json`, import.meta.url)), "utf8"),
  ) as Record<string, string>;
const EN = dictionary("en");
const FR = dictionary("fr");
type Dict = typeof EN;

/** `{name}` placeholders, filled the way `useMsg` fills them. */
const say = (dict: Dict, key: string, vars: Record<string, string | number> = {}): string => {
  const template = dict[key];
  expect(template, `dictionary has no "${key}"`).toBeDefined();
  return template!.replace(/\{(\w+)\}/g, (whole, k: string) => (k in vars ? String(vars[k]) : whole));
};
/** "R1·1", composed from `slot.match_ref` the way `matchRef` composes it. */
const ref = (dict: Dict, round: number, seq: number) => say(dict, "slot.match_ref", { round, seq });
/** `dict` as the lookup a component's `msg` is. */
const lookup = (dict: Dict) => (key: string, vars?: Record<string, string | number>) => say(dict, key, vars);

// ---- The budget, derived from the steps (AGENTS.md 20) ----------------------
/** One full page load and the reads made on it. */
const STEP_MS = 20_000;
/** Every console the journey opens, in order. The test counts its own loads
 *  and checks the count against this list at the end. */
const NAVIGATIONS = [
  "R1·1 console — decide it on the pad",
  "final console — the winner is seated",
  "R1·1 console — Void last entry",
  "final console — the seat is open again",
  "R1·1 console — score it the other way",
  "final console — the NEW winner is seated",
  "R1·1 console, in French — the void refused",
] as const;
/** Two results entered on the pad, each HELD for `HOLD_MS` (soft commit,
 *  env-tunable and baked into the bundle — so imported, never guessed) before
 *  it is sent, plus the sheet's taps and the POST. */
const PAD_RESULTS = 2;
const PAD_SLACK_MS = 10_000;
/** API reaches (competition, division, entrants, stage, generate, start,
 *  fixture list, the other semi, the final's start, the two waits for the
 *  final's seat in the record) and the width checks. */
const REACHES = 14;
const WIDTHS = [1280, 768, 375, 320] as const;
const REACH_MS = STEP_MS / 4;
const BUDGET_MS = Math.max(
  120_000,
  NAVIGATIONS.length * STEP_MS + PAD_RESULTS * (HOLD_MS + PAD_SLACK_MS) + (REACHES + WIDTHS.length) * REACH_MS,
);
/** A pad result lands after its hold; the poll outlasts it with room to spare. */
const LANDS_MS = HOLD_MS + 20_000;

interface Fx {
  id: string;
  stage_id: string;
  round_no: number;
  seq_in_round: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  home_slot_label: { key: string; params: Record<string, unknown> } | null;
  away_slot_label: { key: string; params: Record<string, unknown> } | null;
  status: string;
  outcome: { winner?: string } | null;
  /** The round-role columns the schedule board names a round by. */
  ext_key?: string | null;
  lane?: "WB" | "LB" | "GF" | null;
  is_final?: boolean;
  third_place?: boolean;
  conditional?: boolean;
}

async function fixture(request: APIRequestContext, id: string): Promise<Fx> {
  const res = await apiJson<Fx>(request, `/api/v1/fixtures/${id}`);
  expect(res.status, `GET /fixtures/${id}`).toBe(200);
  return res.data!;
}

async function eventCount(request: APIRequestContext, id: string): Promise<number> {
  const res = await apiJson<unknown[]>(request, `/api/v1/fixtures/${id}/events`);
  expect(res.status, `GET /fixtures/${id}/events`).toBe(200);
  return res.data!.length;
}

/** The pad's own score-entry sheet (generic's v3 skin): two number steps,
 *  home then away, each with its own Confirm. */
async function enterResultOnPad(page: Page, home: number, away: number): Promise<void> {
  const pad = page.locator('[data-testid="score-pad"]');
  const entry = pad.locator('[data-tile-id="scoreEntry"]');
  await expect(entry).toBeVisible({ timeout: STEP_MS });
  await entry.click();
  const sheet = pad.locator('[data-role="v3-sheet"]');
  await expect(sheet, "the score-entry tile opens the skin's own sheet").toBeVisible({ timeout: STEP_MS });
  for (const value of [String(home), String(away)]) {
    await sheet.getByRole("spinbutton").fill(value);
    await sheet.getByRole("button", { name: say(EN, "scorepad.action.confirm"), exact: true }).click();
  }
}

test("an organiser voids a decided knockout result, scores it the other way, and the final follows — until it has started", async ({
  page,
  request,
}, testInfo) => {
  // The ceiling is the test's FIRST act (README: never at module scope).
  test.setTimeout(BUDGET_MS);
  failOnNativeDialog(page);
  let visits = 0;
  const visit = async (id: string) => {
    visits += 1;
    await page.goto(await fixturePath(page.request, id));
  };

  // ---- Reach: a started four-entrant knockout on the shared Pro org ----------
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Void Cup ${TAG}`,
    visibility: "private",
  });
  expect(comp.status, `competition POST → ${JSON.stringify(comp.error)}`).toBe(201);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: `Void Cup ${TAG}`,
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  expect(div.status, `division POST → ${JSON.stringify(div.error)}`).toBe(201);
  const divisionId = div.data!.id;
  const names = ["Ada", "Bea", "Cai", "Dev"].map((n) => `${n} ${TAG}`);
  const added = await addEntrantsViaApi(request, divisionId, names);
  expect(added.status).toBe(201);
  const nameOf = new Map(added.ids.map((id, i) => [id, names[i]!]));
  const stage = await apiJson<{ id: string; kind: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
    seq: 1,
    kind: "knockout",
    name: "Cup",
    config: {},
  });
  expect(stage.status, `stage POST → ${JSON.stringify(stage.error)}`).toBe(201);
  const generated = await apiJson(request, `/api/v1/stages/${stage.data!.id}/generate`, "POST");
  expect(generated.status, `generate → ${JSON.stringify(generated.error)}`).toBeLessThan(300);
  const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  expect(started.status, `start → ${JSON.stringify(started.error)}`).toBe(200);

  // The draw is READ BACK, never assumed: which round-one line is R1·1, who
  // plays in it, and which seat of the final it feeds (the label the plain
  // generator stamped there names its feeder).
  const drawn = (await apiJson<Fx[]>(request, `/api/v1/divisions/${divisionId}/fixtures`)).data!.filter(
    (f) => f.stage_id === stage.data!.id,
  );
  const r1 = drawn.filter((f) => f.round_no === 1).sort((a, b) => a.seq_in_round - b.seq_in_round);
  const finals = drawn.filter((f) => f.round_no === 2);
  expect(r1, "four entrants draw two round-one lines").toHaveLength(2);
  expect(finals, "…feeding one final").toHaveLength(1);
  const [line, other] = r1 as [Fx, Fx];
  const final = finals[0]!;
  const fedBy = (label: Fx["home_slot_label"]) =>
    label?.key === "slot.winner_match" && label.params.round === line.round_no && label.params.seq === line.seq_in_round;
  const seatSide: "home" | "away" = fedBy(final.home_slot_label) ? "home" : "away";
  expect(fedBy(seatSide === "home" ? final.home_slot_label : final.away_slot_label), "a seat of the final is fed by R1·1").toBe(
    true,
  );
  const seatOf = (f: Fx) => (seatSide === "home" ? f.home_entrant_id : f.away_entrant_id);
  const homeName = nameOf.get(line.home_entrant_id!)!;
  const awayName = nameOf.get(line.away_entrant_id!)!;
  const feederEn = say(EN, "slot.winner_match", { ext: ref(EN, line.round_no, line.seq_in_round) });
  const finalHeading = () => page.getByRole("heading", { level: 1 });

  // ---- 1. R1·1 decided on the pad: the home side wins -------------------------
  await visit(line.id);
  await enterResultOnPad(page, 3, 1);
  await expect
    .poll(async () => (await fixture(request, line.id)).outcome?.winner ?? null, { timeout: LANDS_MS })
    .toBe(line.home_entrant_id);
  // The advance is a POST-COMMIT hook of the same request (`onDecided`), so
  // the outcome is readable a beat before the final's seat is. Measured: a
  // console opened in that beat renders the old seat and never refreshes it.
  // The record first, then the screen that is claimed to follow it.
  await expect
    .poll(async () => seatOf(await fixture(request, final.id)), { timeout: STEP_MS })
    .toBe(line.home_entrant_id);

  // ---- 2. The final's console names the winner --------------------------------
  await visit(final.id);
  await expect(finalHeading()).toContainText(homeName, { timeout: STEP_MS });
  await expect(finalHeading()).not.toContainText(feederEn);

  // ---- 3. The organiser voids the result from R1·1's console -----------------
  await visit(line.id);
  const voidLast = page.getByRole("button", { name: say(EN, "score.voidLast") });
  await expect(voidLast).toBeEnabled({ timeout: STEP_MS });
  await voidLast.click();
  await expect
    .poll(async () => (await fixture(request, line.id)).outcome, { timeout: STEP_MS })
    .toBeNull();
  expect(seatOf(await fixture(request, final.id)), "the record: the final's seat is empty again").toBeNull();

  // ---- 4. The final's console reads "Winner of R1·1" again -------------------
  await visit(final.id);
  await expect(finalHeading()).toContainText(feederEn, { timeout: STEP_MS });
  await expect(finalHeading()).not.toContainText(homeName);

  // ---- 5. R1·1 scored the OTHER way on the pad --------------------------------
  await visit(line.id);
  await enterResultOnPad(page, 1, 3);
  await expect
    .poll(async () => (await fixture(request, line.id)).outcome?.winner ?? null, { timeout: LANDS_MS })
    .toBe(line.away_entrant_id);
  // Same post-commit beat as step 1: the record is read first.
  await expect
    .poll(async () => seatOf(await fixture(request, final.id)), { timeout: STEP_MS })
    .toBe(line.away_entrant_id);

  // ---- 6. The final's console names the NEW winner ----------------------------
  await visit(final.id);
  await expect(finalHeading()).toContainText(awayName, { timeout: STEP_MS });
  await expect(finalHeading()).not.toContainText(homeName);
  await expect(finalHeading()).not.toContainText(feederEn);

  // ---- 7. The final STARTS; now the void is refused, in the organiser's language
  // The other semi decided and the final kicked off — reaches, not the test.
  await scoreFixture(request, other.id, 2, 0);
  const kickOff = await apiJson(request, `/api/v1/fixtures/${final.id}/events`, "POST", {
    expected_seq: 0,
    type: "core.start",
    payload: {},
  });
  expect(kickOff.status, `final core.start → ${JSON.stringify(kickOff.error)}`).toBeLessThan(300);
  const eventsBefore = await eventCount(request, line.id);

  // The label the refusal must name the final by is the one the SCHEDULE BOARD
  // shows it by (fix round 2 ruling) — read from the board's own source of
  // truth, never retyped: `boardRoundCodes` over the draw as read back, and
  // `matchRef`'s composition, in the organiser's dictionary.
  const boardLabel = (dict: Dict) => {
    const rc = boardRoundCodes(drawn, [{ id: stage.data!.id, kind: stage.data!.kind }], lookup(dict)).get(final.id);
    expect(rc, "the board names a knockout final's round by its code").toBeDefined();
    // schedule-board.tsx's own expression: the code, then its refSeq.
    return composeMatchRef(final.round_no, rc!.refSeq, lookup(dict), rc!.code);
  };
  const finalFr = boardLabel(FR);
  expect(finalFr, "…so it is never called by the round number the board does not print").not.toBe(
    ref(FR, final.round_no, final.seq_in_round),
  );
  await page.context().addCookies([{ name: "seazn_locale", value: "fr", url: new URL(page.url()).origin }]);
  await visit(line.id);
  const refused = say(FR, "score.nextMatchStarted", { ref: finalFr });
  expect(refused, "the French sentence names the next match").toContain(finalFr);
  const voidLastFr = page.getByRole("button", { name: say(FR, "score.voidLast") });
  await expect(voidLastFr).toBeEnabled({ timeout: STEP_MS });
  await voidLastFr.click();
  await expect(page.getByText(refused, { exact: true })).toBeVisible({ timeout: STEP_MS });
  // Both directions: the server's own English must not be what the organiser reads.
  await expect(page.getByText(nextMatchStartedMessage(boardLabel(EN)))).toHaveCount(0);

  // …and nothing was written: no void row, the result stands, the final keeps its player.
  expect(await eventCount(request, line.id), "no void was recorded").toBe(eventsBefore);
  expect((await fixture(request, line.id)).outcome?.winner, "R1·1's result stands").toBe(line.away_entrant_id);
  expect(seatOf(await fixture(request, final.id)), "a match under way keeps its player").toBe(line.away_entrant_id);

  // The refusal is a sentence in an existing slot; it must not push the page
  // sideways at any width. Each width is captured as evidence of what the
  // organiser reads (attached to the report, never compared pixel-wise).
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    const message = page.getByText(refused, { exact: true });
    await expect(message).toBeVisible();
    await expectNoHorizontalScroll(page);
    await message.scrollIntoViewIfNeeded();
    const path = testInfo.outputPath(`refused-${width}.png`);
    await page.screenshot({ path });
    await testInfo.attach(`refused-${width}`, { path, contentType: "image/png" });
  }

  expect(visits, "every page load is in NAVIGATIONS, so the budget covers it").toBe(NAVIGATIONS.length);
});
