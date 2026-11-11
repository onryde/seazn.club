// ONE organiser runs a badminton DOUBLES Knockout + Plate for seven pairs - from the division builder to the public page - and
// the system's own record agrees with what was done. W4 knockout app B, Task 16 (T8-a).
//
// THE JOURNEY. The organiser builds the division in the builder (badminton, PAIRS, Knockout + Plate, "Third place: Shared"), the
// seven pairs are entered, the division is Started on the Fixtures tab, and a LATE eighth pair is added from the stage's own
// "Add to bracket" (the pair takes the one bye: it plays seed 1). Round 1 is played, and the Plate says it draws after round 2;
// round 2 is played, the Plate's proposal names the pairs that lost their FIRST match - the late pair among them - and the
// organiser confirms it. Both brackets are played out, and the PUBLIC division page is read: ONE champion, the two semi-final
// losers level 3rd in the main draw, the Plate's champion, and every pair exactly once.
//
// WHAT IS A REACH AND WHAT IS THE TEST (README rule). The competition, the seven pairs (and the people in them), and the scorer's
// results are REACHES over the v1 API - the pad itself has its own walkthroughs. The builder form, Start, Add to bracket for a
// pair (two new players typed into the form), the Plate's Confirm and the public page are DRIVEN IN THE BROWSER, and each claim
// is read back from the record (the stages the builder wrote, the entrant rows, the fixture seats, the stored places).
//
// EXPECTED VALUES are the rulebook's, worked by hand (rulebook-W4-knockout.md): eight pairs fill a bracket of eight, so round 1 is
// 1 v 8(late), 4v5, 3v6, 2v7; the better seed wins every line (the late pair is the worst seed). Round 2 is 1v4 and 3v2, the
// final 1v2: pair 1 is champion, pair 2 runner-up; the semi-final losers, pairs 4 and 3, share 3rd (RB4-T2); below them ranks
// are strict by round then seed (RB4-R2): pairs 5, 6, 7 and the late pair are 5th..8th. The Plate takes whoever loses their FIRST
// real match (RB4-P1): pairs 5, 6, 7 and the late pair (pairs 3 and 4 lost their second); it is a bracket of four, and its better
// seeds win, so PAIR 5 is the Plate champion.
import { expect, request as pwRequest, test, type APIRequestContext } from "@playwright/test";
import { TAG, activeOrg, apiJson, divisionPath, expectNoHorizontalScroll, pickBuilderSport, showAllFormats } from "../helpers";
import { dismissCookieBanner } from "../scorepad-a11y-kit";

// ---- The budget, derived from the steps (AGENTS.md 20) ----------------------
const STEP_MS = 20_000;
/** Every page load the journey makes (builder, fixtures tab x2 + the Start dialog, rail -> entrants, fixtures reload x3, public x2 + shots). */
const NAVIGATIONS = 14;
/** Reaches: competition, 14 people, 7 pairs, 4 rounds of results (8+7 lines x 3 events is more: counted as ONE call per event below). */
const PEOPLE = 14;
const LINES = 7 + 3 + 1 + 3; // main draw: 4 + 2 + 1; plate of four: 2 + 1 (and the late pair's line is in the 4)
const EVENTS_PER_LINE = 3;
const REACH_MS = STEP_MS / 8;
const BUDGET_MS = Math.max(180_000, NAVIGATIONS * STEP_MS + (PEOPLE + 4 + LINES * EVENTS_PER_LINE * 2) * REACH_MS);
/** Phone widths: shot at all three, no page scroll at any. */
const WIDTHS = [1280, 768, 320] as const;

interface Fx {
  id: string;
  stage_id: string;
  round_no: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
  third_place?: boolean;
}

/** The scorer's events for one decided badminton line: two games to the winning side, each won at the division's own game target `setTo`
 *  (the builder's default variant is games to 15; the target is read off the division, never typed here). */
async function decide(request: APIRequestContext, fixtureId: string, homeWon: boolean, setTo: number): Promise<void> {
  const win = (loses: number) => (homeWon ? { home: setTo, away: loses } : { home: loses, away: setTo });
  for (const [type, payload] of [
    ["core.start", {}],
    ["badminton.game.summary", win(setTo - 11)],
    ["badminton.game.summary", win(setTo - 9)],
  ] as const) {
    const state = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${fixtureId}/state`);
    const res = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", { expected_seq: state.data!.last_seq, type, payload });
    expect(res.status, `${type}: ${JSON.stringify(res.error)}`).toBeLessThan(300);
  }
}

test("an organiser builds a doubles Knockout + Plate for seven pairs, adds a late pair, confirms the plate, plays both brackets out, and the public page reads every pair once", async ({ page, request }, testInfo) => {
  // The ceiling is the test's FIRST act (README: never at module scope).
  test.setTimeout(BUDGET_MS);
  const shots: string[] = [];
  const shoot = async (label: string) => {
    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w, height: 900 });
      await expectNoHorizontalScroll(page);
      const path = testInfo.outputPath(`${label}-${w}.png`);
      await page.screenshot({ path, fullPage: true });
      shots.push(path);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
  };
  const org = await activeOrg(page);

  // ---- Reach: a public competition, and fourteen people for seven pairs -------------------------------------------------
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `Doubles Cup ${TAG}`, visibility: "public" });
  expect(comp.status, JSON.stringify(comp.error)).toBe(201);
  const person: string[] = [];
  for (let i = 1; i <= PEOPLE; i++) {
    const p = await apiJson<{ id: string }>(request, "/api/v1/persons", "POST", { full_name: `Dbl W${String(i).padStart(2, "0")} ${TAG}`, consent: { public_name: true } });
    expect(p.status, JSON.stringify(p.error)).toBeLessThan(300);
    person.push(p.data!.id);
  }

  // ---- 1. The builder: badminton, pairs, Knockout + Plate, Third place: Shared -------------------------------------------
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/o/${org.slug}/c/${comp.data!.slug}/d/new`);
  await dismissCookieBanner(page);
  const name = page.getByTestId("division-builder-name");
  await expect(name).toBeVisible({ timeout: STEP_MS });
  await name.fill(`Doubles ${TAG}`);
  await pickBuilderSport(page, "badminton");
  const kinds = page.getByTestId("division-builder-entrant-kind");
  const pairRadio = kinds.locator('input[name="division-entrant-kind"][value="pair"]');
  await expect(async () => {
    await kinds.locator('label[data-entrant-kind="pair"]').click();
    await expect(pairRadio).toBeChecked({ timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  await page.getByTestId("division-builder-step-format").click();
  await expect(page.getByTestId("division-builder")).toHaveAttribute("data-step", "format");
  await showAllFormats(page);
  const card = page.locator('label[data-template="ko_plate"]');
  await card.click();
  await expect(card.locator("input")).toBeChecked();
  const plan = page.getByTestId("division-builder-plan-entrants");
  await plan.fill("7");
  await plan.blur();
  const third = page.getByTestId("third-place-choice");
  await expect(third, "the Third place control is on the Knockout + Plate format").toBeAttached();
  await third.scrollIntoViewIfNeeded();
  await third.locator('[data-third-place-option="shared"]').click();
  await expect(third).toHaveAttribute("data-third-place", "shared");
  await shoot("builder-format");
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await page.getByRole("button", { name: /create division/i }).click();
  await page.waitForURL(/\/o\/[^/]+\/c\/[^/]+\/d\/(?!new(?:$|[/?]))[^/?]+/, { timeout: STEP_MS });
  const divSlug = page.url().match(/\/d\/([^/?]+)/)![1]!;
  const divs = await apiJson<{ id: string; slug: string; config: { finalSetTo?: number; entrants?: { kinds?: string[] } } }[]>(request, `/api/v1/competitions/${comp.data!.id}/divisions`);
  const division = divs.data!.find((d) => d.slug === divSlug)!;
  const divisionId = division.id;
  expect(division.config.entrants?.kinds, "the division is a PAIRS division").toEqual(["pair"]);
  const setTo = division.config.finalSetTo;
  expect(typeof setTo, "premise: the division carries its variant's game target").toBe("number");
  // The seam: what the builder SENT is what the stages hold - a main draw and a plate that takes the first losses, both on Shared.
  const stages = (await apiJson<{ id: string; kind: string; seq: number; name: string; config: { thirdPlace?: boolean }; progression?: { sources?: { take?: { kind: string }[] }[] } | null }[]>(request, `/api/v1/divisions/${divisionId}/stages`)).data!
    .sort((a, b) => a.seq - b.seq);
  expect(stages.map((s) => s.kind), "two knockout stages").toEqual(["knockout", "knockout"]);
  expect(stages.map((s) => s.config.thirdPlace === true), "Shared on both").toEqual([false, false]);
  expect(stages[1]!.progression?.sources?.[0]?.take?.[0]?.kind, "the plate takes the first losses").toBe("firstLosses");
  const [main, plate] = stages as [(typeof stages)[number], (typeof stages)[number]];

  // ---- Reach: seven pairs, seeded in order; then 2. Start, on the Fixtures tab -----------------------------------------------
  const pairNames = Array.from({ length: 7 }, (_, i) => (i === 0 ? "Harbourside Shuttlers Badminton Club Ladies" : `Pair ${i + 1} ${TAG}`)); // pair 1 is a 43-character name
  const added = await apiJson<{ id: string; display_name: string }[]>(
    request,
    `/api/v1/divisions/${divisionId}/entrants`,
    "POST",
    pairNames.map((n, i) => ({ kind: "pair", display_name: n, seed: i + 1, members: [{ person_id: person[2 * i]! }, { person_id: person[2 * i + 1]! }] })),
  );
  expect(added.status, JSON.stringify(added.error)).toBe(201);
  const ids = added.data!.map((e) => e.id);
  const seedOf = new Map(ids.map((id, i) => [id, i + 1] as const));
  const nameOf = new Map(ids.map((id, i) => [id, pairNames[i]!] as const));

  await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
  await dismissCookieBanner(page);
  await page.getByTestId("launch-start-division").click();
  await page.getByTestId("start-confirm").getByTestId("start-confirm-confirm").click();
  await expect(page.getByTestId("launch-start-division"), "started: no Start button").toHaveCount(0, { timeout: STEP_MS });
  const lines = async (stageId: string): Promise<Fx[]> => (await apiJson<Fx[]>(request, `/api/v1/divisions/${divisionId}/fixtures`)).data!.filter((f) => f.stage_id === stageId);
  const r1Before = (await lines(main.id)).filter((l) => l.round_no === 1);
  const byeLines = r1Before.filter((l) => (l.home_entrant_id === null) !== (l.away_entrant_id === null));
  expect(byeLines.map((l) => seedOf.get((l.home_entrant_id ?? l.away_entrant_id)!)), "seven pairs in a bracket of eight: pair 1 holds the one bye").toEqual([1]);

  // ---- 3. A late pair, from the stage's own Add to bracket -------------------------------------------------------------------
  await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
  const more = page.getByTestId("stage-more").first();
  await expect(more, "a started knockout offers More").toBeVisible({ timeout: STEP_MS });
  await more.click();
  await expect(page.getByTestId("stage-add-late-player").first()).toContainText("Add to bracket");
  await page.getByTestId("stage-add-late-player").first().click();
  await expect(page).toHaveURL(/[?&]tab=entrants/, { timeout: STEP_MS });
  const form = page.locator("#add-entrant");
  await expect(form.getByTestId("entrants-knockout-late-note")).toBeVisible({ timeout: STEP_MS });
  const lateA = `Dbl Late A ${TAG}`;
  const lateB = `Dbl Late B ${TAG}`;
  for (const who of [lateA, lateB]) {
    await form.getByTestId("new-player-name").fill(who);
    await form.getByTestId("new-player-add").click();
    await expect(form.locator(`[aria-pressed="true"]`).filter({ hasText: who }), `${who} is picked into the pair`).toBeVisible({ timeout: STEP_MS });
  }
  const lateName = `${lateA} & ${lateB}`;
  await expect(form.getByLabel("Name", { exact: true }), "a pair is named from its two people").toHaveValue(lateName);
  const answered = page.waitForResponse((r) => r.url().endsWith(`/api/v1/divisions/${divisionId}/entrants`) && r.request().method() === "POST");
  await form.getByRole("button", { name: "Add entrant" }).click();
  const res = await answered;
  expect(res.status()).toBe(201);
  const body = (await res.json()) as { data: { id: string; late_entry?: { format: string; case: string; opponent_id?: string } } };
  const lateId = body.data.id;
  expect(body.data.late_entry, "the late pair takes the one bye and plays pair 1").toMatchObject({ format: "knockout", case: "bye", opponent_id: ids[0] });
  seedOf.set(lateId, 8); // the worst seed: it loses to whoever it meets
  nameOf.set(lateId, lateName);
  const r1 = (await lines(main.id)).filter((l) => l.round_no === 1);
  expect(r1.filter((l) => l.home_entrant_id && l.away_entrant_id), "eight pairs: four real round-one lines").toHaveLength(4);
  const lateLine = r1.find((l) => l.home_entrant_id === lateId || l.away_entrant_id === lateId)!;
  expect([lateLine.home_entrant_id, lateLine.away_entrant_id].sort(), "the late pair plays pair 1").toEqual([ids[0]!, lateId].sort());

  // ---- 4. Round 1 played (better seed wins); the plate says it draws after round 2 -------------------------------------------
  const playRound = async (stageId: string, round: number): Promise<number> => {
    const open = (await lines(stageId)).filter((l) => l.round_no === round && l.home_entrant_id && l.away_entrant_id && !["decided", "finalized", "forfeited", "abandoned"].includes(l.status));
    for (const f of open) await decide(request, f.id, (seedOf.get(f.home_entrant_id!) ?? 99) < (seedOf.get(f.away_entrant_id!) ?? 99), setTo!);
    return open.length;
  };
  expect(await playRound(main.id, 1), "round 1: four lines, the late pair's among them").toBe(4);
  await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
  // Eight pairs, no bye: every first loss is known after round 1, so the plate is already drawable (RB4-P3: "once every first loss is known").
  // The "Plate draws after round 2" card belongs to the n=5-7 brackets with a bye holder, which X-LE-14 in w4-knockout-app-b.spec.ts drives.
  await expect(page.locator('[data-progression-state="plate-waiting"]'), "no bye holder is left to wait for").toHaveCount(0);
  await expect(page.getByRole("button", { name: "Compute proposal" }).or(page.locator('[data-progression-state="draft"]')), "the plate can be drawn now").toBeVisible({ timeout: STEP_MS });
  const plateBefore = await lines(plate.id);
  expect(plateBefore.length, "the plate's lines are drawn as empty first-loss slots").toBeGreaterThan(0);
  expect(plateBefore.flatMap((l) => [l.home_entrant_id, l.away_entrant_id]).filter(Boolean), "and nobody is seated until the organiser confirms").toEqual([]);
  expect(await playRound(main.id, 2), "round 2: two semi-finals (no byes left to play past)").toBe(2);

  // ---- 5. The plate's proposal names the first-match losers, the late pair among them; Confirm -------------------------------
  await page.reload();
  const compute = page.getByRole("button", { name: "Compute proposal" });
  const draft = page.locator('[data-progression-state="draft"]');
  await expect(compute.or(draft)).toBeVisible({ timeout: STEP_MS });
  if (await compute.isVisible()) await compute.click();
  await expect(draft).toBeVisible({ timeout: STEP_MS });
  const seats = await draft.locator("[data-progression-row] select").evaluateAll((els) => els.map((el) => (el as HTMLSelectElement).selectedOptions[0]?.textContent ?? ""));
  expect([...seats].sort(), "pairs 5, 6, 7 and the late pair, by name - never pairs 3 and 4").toEqual([nameOf.get(ids[4]!)!, nameOf.get(ids[5]!)!, nameOf.get(ids[6]!)!, lateName].sort());
  await shoot("plate-proposal");
  await draft.getByRole("button", { name: "Confirm proposal" }).click();
  await expect(page.locator('[data-progression-state="confirmed"]')).toBeVisible({ timeout: STEP_MS });
  const plateSeated = new Set((await lines(plate.id)).flatMap((l) => [l.home_entrant_id, l.away_entrant_id]).filter(Boolean) as string[]);
  expect([...plateSeated].map((id) => nameOf.get(id)!).sort(), "the plate's four seats").toEqual([nameOf.get(ids[4]!)!, nameOf.get(ids[5]!)!, nameOf.get(ids[6]!)!, lateName].sort());

  // ---- 6. Both brackets played out; both stages and the division complete ----------------------------------------------------
  expect(await playRound(main.id, 3), "the main final").toBe(1);
  for (const round of [1, 2]) await playRound(plate.id, round);
  for (const stageId of [main.id, plate.id]) {
    const done = await apiJson<{ completed: boolean; events: { type: string; places?: { entrantId: string; rank: number }[] }[] }>(request, `/api/v1/stages/${stageId}/complete`, "POST");
    expect([done.status, done.data?.completed], JSON.stringify(done.error)).toEqual([200, true]);
  }
  expect((await apiJson<{ status: string }>(request, `/api/v1/divisions/${divisionId}`)).data?.status).toBe("completed");

  // The record: every pair ranked once in the main draw - pair 1, pair 2, pairs 3 and 4 level 3rd, then 5, 6, 7 and the late pair.
  const rowsOf = async (stageId: string) => (await apiJson<{ rows: { entrantId: string; rank?: number | null }[] }>(request, `/api/v1/stages/${stageId}/standings`)).data?.rows ?? [];
  const mainRows = await rowsOf(main.id);
  expect(mainRows.length, "every one of the eight pairs is ranked").toBe(8);
  expect(new Set(mainRows.map((r) => r.entrantId)).size, "each pair once").toBe(8);
  const rankOf = new Map(mainRows.map((r) => [seedOf.get(r.entrantId)!, r.rank] as const));
  expect([1, 2, 3, 4, 5, 6, 7, 8].map((s) => rankOf.get(s)), "ranks of seeds 1..8 (8 is the late pair)").toEqual([1, 2, 3, 3, 5, 6, 7, 8]);
  const plateRows = await rowsOf(plate.id);
  expect(plateRows.find((r) => r.rank === 1)?.entrantId, "the plate's champion is the best of its field: pair 5").toBe(ids[4]);

  // ---- 7. The public page: one champion, two shared 3rds, the plate's champion, every pair once ------------------------------------
  const pub = `/live/${org.slug}/${comp.data!.slug}/${divSlug}`;
  await expect
    .poll(async () => {
      await page.goto(pub);
      return page.getByTestId("division-title-champion").count();
    }, { timeout: 30_000, message: "the champion banner on the public division page" })
    .toBe(1);
  await dismissCookieBanner(page);
  await expect(page.getByTestId("division-title-champion"), "the champion is pair 1 (the 43-character name)").toContainText(nameOf.get(ids[0]!)!);
  await expect(page.getByTestId("division-title-vacant")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Main draw" }).first(), "the main draw's bracket").toBeVisible();
  await expect(page.getByRole("heading", { name: "Plate" }).first(), "and the plate's").toBeVisible();
  await shoot("public-division");

  // A spectator's own door (no cookie): the public standings of both brackets.
  const anon = await pwRequest.newContext({ baseURL: test.info().project.use.baseURL });
  try {
    const res = await anon.get(`/api/v1/public/orgs/${org.slug}/competitions/${comp.data!.slug}/divisions/${divSlug}/standings`);
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { data: { standings: { stage_id: string; rows: { entrantId: string; rank?: number | null }[] }[] } };
    const pubMain = body.data.standings.find((t) => t.stage_id === main.id)?.rows ?? [];
    expect(pubMain.length, "anti-vacuity: the main draw's public table has all eight pairs").toBe(8);
    expect(new Set(pubMain.map((r) => r.entrantId)).size, "every pair exactly once").toBe(8);
    const pubRank = new Map(pubMain.map((r) => [seedOf.get(r.entrantId)!, r.rank] as const));
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((s) => pubRank.get(s)), "two shared 3rds (pairs 3 and 4), no 4th").toEqual([1, 2, 3, 3, 5, 6, 7, 8]);
    const pubPlate = body.data.standings.find((t) => t.stage_id === plate.id)?.rows ?? [];
    expect(pubPlate.find((r) => r.rank === 1)?.entrantId, "the plate's champion, publicly: pair 5").toBe(ids[4]);
    expect(pubPlate.length, "the plate ranks its four pairs").toBe(4);
  } finally {
    await anon.dispose();
  }
  expect(shots.length, "three widths x three screens, none missing").toBe(9);
});
