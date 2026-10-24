import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { builtinModules } from "@seazn/engine/sports";
import { TAG, activeOrg, addEntrantsViaApi, apiJson, createStageAndGenerate, divisionPath, expectNoHorizontalScroll, seedVenueWithCourts } from "./helpers";
import { dismissCookieBanner } from "./scorepad-a11y-kit";

// W2b Task 13 (spec §5.5, UI-2 option A; X-RS-2, X-DW-1) — a credited result says which one, on every public surface:
// the match centre reads the full sentence, and the two tight surfaces (the hub's results list and the division
// bracket's tile) show the short tag beside the credited score, with the sentence as the tag's accessible name. At 320
// the tile keeps the score and the tag on one row and the page never scrolls sideways.
//
// The rig records through the API (the console's write); the reading is a spectator's, on /shared. Every word is the
// real en public.json; the credited score is the engine's own declaration (football's `awardScore.goals`, FB-WO-1).
// Whole file, never a -g slice (AGENTS.md rule 21). Crops land in `T13_SHOTS` when it is set (never committed).

const PUB = JSON.parse(readFileSync(fileURLToPath(new URL("../src/dictionaries/en/public.json", import.meta.url)), "utf8")) as Record<string, string>;
const say = (key: string, params: Record<string, string> = {}) => {
  const tpl = PUB[key];
  expect(tpl, `public.json has ${key}`).toBeTruthy();
  return Object.entries(params).reduce((acc, [k, v]) => acc.replaceAll(`{${k}}`, v), tpl!);
};

const STEP_MS = 20_000;
const WIDTHS = [1280, 768, 320] as const;
// Single sport (review M-5), on purpose: what this file proves is the BROWSER — the tag's role/name, the sentence in
// the match centre, the 320 row — and no surface here branches on sport (the tag and sentence come from the outcome's
// kind and reason alone). The credited score per sport is swept below the browser: the engine's X-WO-1 (every declared
// cfg), its C1 summary sweep (sets/games shown), and match-centre-forfeit.test.ts's every-sport header sweep. Football
// is the sport whose credit (awardScore) differs from the played 0–0, so a surface that showed the board would fail.
const SPORT = "football";
const VARIANT = "11-a-side";
const football = builtinModules.find((m) => m.key === SPORT)!;
/** FB-WO-1: a walkover credits the variant's declared goals to the side that turned up, nil to the side that did not. */
const CREDIT = (football.configSchema.parse(football.variants[VARIANT]) as { awardScore: { goals: number } }).awardScore.goals;

interface Fx {
  id: string;
  fixture_no: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
  outcome: { kind: string; winner?: string; loser?: string | null; reason?: string } | null;
}
const read = async (r: APIRequestContext, id: string) => (await apiJson<Fx>(r, `/api/v1/fixtures/${id}`)).data!;
const tip = async (r: APIRequestContext, id: string) => (await apiJson<{ last_seq: number }>(r, `/api/v1/fixtures/${id}/state`)).data!.last_seq;
async function post(r: APIRequestContext, id: string, type: string, payload: unknown = {}) {
  const res = await apiJson(r, `/api/v1/fixtures/${id}/events`, "POST", { expected_seq: await tip(r, id), type, payload });
  expect(res.status, `${type}: ${JSON.stringify(res.error)}`).toBeLessThan(300);
}

/** A public, started four-team football knockout. Names are realistic lengths (the 320 overflow class). */
async function publicKnockout(r: APIRequestContext) {
  expect(Object.keys(football.variants), `${SPORT} declares ${VARIANT}`).toContain(VARIANT);
  const comp = await apiJson<{ id: string; slug: string }>(r, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `W2b walkover ${TAG}-${Math.random().toString(36).slice(2, 6)}`,
    visibility: "public",
  });
  expect(comp.status, JSON.stringify(comp.error)).toBe(201);
  const div = await apiJson<{ id: string; slug: string }>(r, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Cup", sport_key: SPORT, variant_key: VARIANT,
  });
  expect(div.status, JSON.stringify(div.error)).toBe(201);
  const names = ["Riverside Athletic FC", "Harbour United Reserves", "Bears of Brockley", "Catford Wanderers"];
  const added = await addEntrantsViaApi(r, div.data!.id, names, "team");
  expect(added.ids).toHaveLength(names.length);
  const { fixtureIds } = await createStageAndGenerate(r, div.data!.id, { kind: "knockout", name: "Cup" });
  const started = await apiJson(r, `/api/v1/divisions/${div.data!.id}/start`, "POST");
  expect(started.status, JSON.stringify(started.error)).toBeLessThan(300);
  const all = await Promise.all(fixtureIds.map((id) => read(r, id)));
  const semis = all.filter((f) => f.home_entrant_id && f.away_entrant_id);
  expect(semis, "two seated semi-finals").toHaveLength(2);
  const final = all.find((f) => !f.home_entrant_id && !f.away_entrant_id);
  expect(final, "a final waiting on both").toBeTruthy();
  const nameOf = new Map(added.ids.map((id, i) => [id, names[i]!]));
  return { divId: div.data!.id, compSlug: comp.data!.slug, divSlug: div.data!.slug, semis, final: final!, nameOf };
}

async function crop(target: Locator, name: string) {
  const dir = process.env.T13_SHOTS;
  if (dir) await target.screenshot({ path: `${dir}/${name}.png` });
}

/** The two boxes share a row: each starts above where the other ends. */
async function expectOneRow(a: Locator, b: Locator, what: string) {
  const [x, y] = [(await a.boundingBox())!, (await b.boundingBox())!];
  expect(x && y, `${what}: both are laid out`).toBeTruthy();
  expect(x.y < y.y + y.height && y.y < x.y + x.height, `${what}: on one row (${JSON.stringify([x, y])})`).toBe(true);
  expect(await b.evaluate((el) => el.getClientRects().length), `${what}: the tag never breaks inside itself`).toBe(1);
}

async function hubResults(page: Page, url: string) {
  await page.goto(url);
  await dismissCookieBanner(page);
  const chip = page.getByTestId("mh-filter-completed");
  await expect(chip).toBeVisible({ timeout: STEP_MS });
  await chip.click();
}

test.describe("W2b — a credited result says which one, on every public surface (Task 13)", () => {
  test("X-RS-2: a walkover — the match centre's sentence, the results list's tag, the bracket tile's tag at 1280/768/320", async ({ page, request }) => {
    test.setTimeout(4 * 60_000);
    const org = await activeOrg(page);
    const ko = await publicKnockout(request);
    const [sf] = ko.semis;
    const loser = sf!.away_entrant_id!;
    await post(request, sf!.id, "core.forfeit", { by: loser, reason: "walkover" });
    expect((await read(request, sf!.id)).outcome).toEqual({ kind: "award", winner: sf!.home_entrant_id, loser, reason: "walkover" });
    const sentence = say("forfeit.sentence.walkover", { loser: ko.nameOf.get(loser)! });
    const tag = say("forfeit.tag.walkover");
    expect(tag, "UI-2 option A's walkover tag").toBe("w/o");
    const base = `/shared/${org.slug}/${ko.compSlug}`;

    let screens = 0;
    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w, height: 900 });

      // The match centre: the full sentence, over the credited score.
      await page.goto(`${base}/${ko.divSlug}/fixtures/${sf!.id}`);
      await dismissCookieBanner(page);
      const line = page.getByTestId("mc-status-line");
      await expect(line, `${w}: the match centre`).toHaveText(sentence);
      await expect(page.getByTestId("mc-score-0")).toHaveText(String(CREDIT));
      await expect(page.getByTestId("mc-score-1")).toHaveText("0");
      await expectNoHorizontalScroll(page);
      await crop(page.locator("main"), `match-centre-walkover-${w}`);
      screens++;

      // The results list: the tag, named by the sentence.
      await hubResults(page, `${base}?tab=matches`);
      const card = page.getByTestId(`mh-match-${sf!.id}`);
      await expect(card).toBeVisible({ timeout: STEP_MS });
      const cardTag = card.getByRole("img", { name: sentence });
      await expect(cardTag, `${w}: the results card's tag is named by the sentence`).toHaveText(tag);
      await expect(cardTag).toHaveAttribute("title", sentence);
      await expect(card).toHaveAttribute("aria-describedby", `mh-forfeit-${sf!.id}`);
      await expectNoHorizontalScroll(page);
      await crop(card, `results-list-walkover-${w}`);
      screens++;

      // The bracket tile: the credited score and the tag on ONE row.
      await page.goto(`${base}/${ko.divSlug}?tab=standings`);
      await dismissCookieBanner(page);
      const footer = page.getByTestId("bracket-forfeit");
      await expect(footer, "only the walked-over semi carries a tag").toHaveCount(1, { timeout: STEP_MS });
      const tileTag = footer.getByRole("img", { name: sentence });
      await expect(tileTag, `${w}: the tile's tag is named by the sentence`).toHaveText(tag);
      const score = footer.locator("span").first();
      await expect(score).toHaveText(new RegExp(`^${CREDIT}\\s*[–—-]\\s*0$`));
      await expectOneRow(score, tileTag, `${w}: the bracket tile`);
      await expectNoHorizontalScroll(page);
      await crop(footer.locator("xpath=ancestor::a[1]"), `bracket-tile-walkover-${w}`);
      screens++;

      // Review I-2 — the division's Schedule, its DEFAULT tab: the tag on the winner's credited score, named by the
      // sentence. (The other tabs' panels are in the DOM, hidden — so scope to the schedule's.)
      await page.goto(`${base}/${ko.divSlug}`);
      await dismissCookieBanner(page);
      const schedTag = page.locator("#panel-schedule").getByRole("img", { name: sentence });
      await expect(schedTag, `${w}: the schedule row's tag is named by the sentence`).toHaveText(tag, { timeout: STEP_MS });
      await expect(schedTag).toHaveCount(1);
      await expect(schedTag).toHaveAttribute("data-testid", "schedule-forfeit-tag");
      await expect(schedTag.locator("xpath=ancestor::a[1]"), `${w}: the row shows the credited score`).toContainText(String(CREDIT));
      // Design review M-3: the stacked score column keeps one right edge — the tag has its own track, so it no longer
      // pushes the winner's digit left of the loser's.
      const scoreCells = schedTag.locator("xpath=ancestor::a[1]").getByTestId("schedule-score");
      await expect(scoreCells, `${w}: two stacked score cells`).toHaveCount(2);
      const rights = await scoreCells.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().right));
      expect(Math.abs(rights[0]! - rights[1]!), `${w}: both digits end on one edge (${rights.join(", ")})`).toBeLessThanOrEqual(0.5);
      const tagLeft = await schedTag.evaluate((el) => el.getBoundingClientRect().left);
      expect(tagLeft, `${w}: the tag follows the scores`).toBeGreaterThanOrEqual(rights[0]!);
      await expectNoHorizontalScroll(page);
      await crop(schedTag.locator("xpath=ancestor::a[1]"), `schedule-walkover-${w}`);
      screens++;

      // Review I-1 — the hub's knockout tab, Rounds (every width): the semi's card carries the tag.
      await page.goto(`${base}?tab=knockout`);
      await dismissCookieBanner(page);
      const koPanel = page.getByTestId("mh-tab-panel-knockout");
      await expect(koPanel).toBeVisible({ timeout: STEP_MS });
      const roundTag = koPanel.getByTestId(`mh-match-${sf!.id}`).getByRole("img", { name: sentence });
      await expect(roundTag, `${w}: the Rounds card's tag is named by the sentence`).toHaveText(tag);
      await expectNoHorizontalScroll(page);
      screens++;

      // …and the Draw (a desktop view — it opens at lg only; a phone's ?view=draw shows Rounds): the semi's node.
      if (w === 1280) {
        await page.goto(`${base}?tab=knockout&view=draw`);
        await dismissCookieBanner(page);
        const node = page.getByTestId(`mh-knockout-node-${sf!.id}`);
        await expect(node).toBeVisible({ timeout: STEP_MS });
        const nodeTag = node.getByRole("img", { name: sentence });
        await expect(nodeTag, "1280: the Draw node's tag is named by the sentence").toHaveText(tag);
        await expect(nodeTag).toHaveAttribute("data-testid", "mh-knockout-node-forfeit");
        await expect(node).toHaveAttribute("aria-describedby", `mh-knockout-forfeit-${sf!.id}`);
        await crop(node, `draw-node-walkover-${w}`);
        screens++;
      }
    }
    expect(screens).toBe(WIDTHS.length * 5 + 1);

    // Review (b), as amended by design audit 3.6(a) — the champion banner of a final won by walkover: its line says
    // "by walkover", so no w/o tag repeats it (the final's own card keeps the tag and its sentence). The other semi and
    // then the final are walked over (the final's seats come from the cascade).
    const other = ko.semis[1]!;
    await post(request, other.id, "core.forfeit", { by: other.away_entrant_id, reason: "walkover" });
    await expect
      .poll(async () => { const f = await read(request, ko.final.id); return f.home_entrant_id !== null && f.away_entrant_id !== null; }, { timeout: STEP_MS })
      .toBe(true);
    const seated = await read(request, ko.final.id);
    await post(request, ko.final.id, "core.forfeit", { by: seated.away_entrant_id, reason: "walkover" });
    expect((await read(request, ko.final.id)).outcome).toMatchObject({ kind: "award", winner: seated.home_entrant_id, reason: "walkover" });
    const finalSentence = say("forfeit.sentence.walkover", { loser: ko.nameOf.get(seated.away_entrant_id!)! });
    const walkoverLine = say("knockout.championLineWalkover", { name: ko.nameOf.get(seated.away_entrant_id!)!, round: "Final" });
    let banners = 0;
    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.goto(`${base}?tab=knockout`);
      await dismissCookieBanner(page);
      const banner = page.locator('[data-testid^="mh-knockout-champion-"]').first();
      await expect(banner, `${w}: the champion banner names the walkover`).toContainText(walkoverLine, { timeout: STEP_MS });
      await expect(page.getByTestId("mh-knockout-champion-forfeit"), `${w}: no w/o tag repeats it`).toHaveCount(0);
      // The final's own card keeps its tag, named by its sentence (the Rounds card, every width).
      await expect(page.getByTestId(`mh-match-${ko.final.id}`).getByRole("img", { name: finalSentence }), `${w}: the final's card tag`).toHaveText(tag);
      await expectNoHorizontalScroll(page);
      await crop(banner, `champion-banner-walkover-${w}`);
      banners++;
    }
    expect(banners).toBe(WIDTHS.length);
  });

  // Design audit 3.6(b): a final won on a disqualification AFTER PLAY was played, so the banner reads "Beat {name} in the
  // Final" and the final's DQ tag rides beside it — on the dark court, in the court card's on-court chip idiom
  // (translucent amber), read off the painted colours, never the light pill. Loop R M-10: the play is real — half-time
  // is a football event after the Start (ruling 112); a disqualification after a bare Start was never played (ruling
  // 115), and the next test pins that it reads as the walkover it is.
  test("audit 3.6: a final won on a disqualification after play — 'Beat X in the Final' with its DQ tag on-court, at 1280/768/320", async ({ page, request }) => {
    test.setTimeout(3 * 60_000);
    const org = await activeOrg(page);
    const ko = await publicKnockout(request);
    for (const semi of ko.semis) await post(request, semi.id, "core.forfeit", { by: semi.away_entrant_id, reason: "walkover" });
    await expect
      .poll(async () => { const f = await read(request, ko.final.id); return f.home_entrant_id !== null && f.away_entrant_id !== null; }, { timeout: STEP_MS })
      .toBe(true);
    const seated = await read(request, ko.final.id);
    await post(request, ko.final.id, "core.start", {});
    await post(request, ko.final.id, "football.period", { phase: "HT" });
    await post(request, ko.final.id, "core.forfeit", { by: seated.away_entrant_id, reason: "disqualified" });
    expect((await read(request, ko.final.id)).outcome).toMatchObject({ kind: "award", winner: seated.home_entrant_id, reason: "disqualified" });
    const loser = ko.nameOf.get(seated.away_entrant_id!)!;
    const sentence = say("forfeit.sentence.disqualified", { loser });
    const line = say("knockout.championLine", { name: loser, round: "Final" });
    let banners = 0;
    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.goto(`/shared/${org.slug}/${ko.compSlug}?tab=knockout`);
      await dismissCookieBanner(page);
      const chip = page.getByTestId("mh-knockout-champion-forfeit");
      await expect(chip, `${w}: the DQ tag beside the line`).toHaveText(say("forfeit.tag.disqualified"), { timeout: STEP_MS });
      await expect(chip).toHaveAttribute("aria-label", sentence);
      const banner = page.locator('[data-testid^="mh-knockout-champion-"]').first();
      await expect(banner, `${w}: the played final's line`).toContainText(line);
      // The painted colours: a translucent background and a light text on the dark court, as the court card's chip.
      const paint = await chip.evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, fg: getComputedStyle(el).color }));
      const strength = await page.evaluate(() => {
        const probe = document.createElement("span");
        probe.className = "bg-amber-400/20 text-amber-300";
        document.body.appendChild(probe);
        const out = { bg: getComputedStyle(probe).backgroundColor, fg: getComputedStyle(probe).color };
        probe.remove();
        return out;
      });
      expect(paint, `${w}: the on-court chip idiom`).toEqual(strength);
      expect(paint.bg, `${w}: translucent, not the light pill`).toMatch(/\/ 0\.2\)|, 0\.2\)/);
      await expectNoHorizontalScroll(page);
      await crop(banner, `champion-banner-dq-${w}`);
      banners++;
    }
    expect(banners).toBe(WIDTHS.length);
  });

  // Loop R M-10 (ruling 115): a disqualification after a bare Start — nothing played — is a walkover, so the champion
  // banner reads the walkover line and no tag repeats it, exactly as a walkover's final does. The banner reads whether
  // the final was played (the engine's reader over its ledger), never the reason.
  test("M-10: a final disqualified after a bare Start reads 'by walkover', no tag beside it, at 1280/768/320", async ({ page, request }) => {
    test.setTimeout(3 * 60_000);
    const org = await activeOrg(page);
    const ko = await publicKnockout(request);
    for (const semi of ko.semis) await post(request, semi.id, "core.forfeit", { by: semi.away_entrant_id, reason: "walkover" });
    await expect
      .poll(async () => { const f = await read(request, ko.final.id); return f.home_entrant_id !== null && f.away_entrant_id !== null; }, { timeout: STEP_MS })
      .toBe(true);
    const seated = await read(request, ko.final.id);
    await post(request, ko.final.id, "core.start", {});
    await post(request, ko.final.id, "core.forfeit", { by: seated.away_entrant_id, reason: "disqualified" });
    expect((await read(request, ko.final.id)).outcome).toMatchObject({ kind: "award", winner: seated.home_entrant_id, reason: "disqualified" });
    const loser = ko.nameOf.get(seated.away_entrant_id!)!;
    const walkoverLine = say("knockout.championLineWalkover", { name: loser, round: "Final" });
    const beatLine = say("knockout.championLine", { name: loser, round: "Final" });
    let banners = 0;
    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.goto(`/shared/${org.slug}/${ko.compSlug}?tab=knockout`);
      await dismissCookieBanner(page);
      const banner = page.locator('[data-testid^="mh-knockout-champion-"]').first();
      await expect(banner, `${w}: the unplayed final's line`).toContainText(walkoverLine, { timeout: STEP_MS });
      await expect(banner, `${w}: never "Beat"`).not.toContainText(beatLine);
      await expect(page.getByTestId("mh-knockout-champion-forfeit"), `${w}: no tag repeats it`).toHaveCount(0);
      // The final's own card keeps its DQ tag and sentence.
      await expect(
        page.getByTestId(`mh-match-${ko.final.id}`).getByRole("img", { name: say("forfeit.sentence.disqualified", { loser }) }),
        `${w}: the final's card tag`,
      ).toHaveText(say("forfeit.tag.disqualified"));
      await expectNoHorizontalScroll(page);
      await crop(banner, `champion-banner-dq-bare-start-${w}`);
      banners++;
    }
    expect(banners).toBe(WIDTHS.length);
  });

  test("X-DW-1: a double walkover names the next round only once the final stands walked over", async ({ page, request }) => {
    test.setTimeout(4 * 60_000);
    const org = await activeOrg(page);
    const ko = await publicKnockout(request);
    const [dw, other] = ko.semis;
    await post(request, dw!.id, "core.forfeit", { by: "both", reason: "walkover" });
    expect((await read(request, dw!.id)).outcome).toEqual({ kind: "double_walkover" });
    const base = `/shared/${org.slug}/${ko.compSlug}/${ko.divSlug}`;
    const bare = say("forfeit.sentence.doubleWalkover");
    const dwTag = say("forfeit.tag.doubleWalkover");

    // The other semi still to play: the final waits, so no clause.
    await page.goto(`${base}/fixtures/${dw!.id}`);
    await dismissCookieBanner(page);
    await expect(page.getByTestId("mc-status-line")).toHaveText(bare);

    // The other semi is walked over too; the final is walked over to its winner (the cascade's seat arrival).
    await post(request, other!.id, "core.forfeit", { by: other!.away_entrant_id, reason: "walkover" });
    await expect.poll(async () => (await read(request, ko.final.id)).outcome?.winner ?? null, { timeout: STEP_MS }).toBe(other!.home_entrant_id);
    const withNext = say("forfeit.sentence.doubleWalkoverNext", { next: ko.nameOf.get(other!.home_entrant_id!)! });

    let screens = 0;
    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.goto(`${base}/fixtures/${dw!.id}`);
      await dismissCookieBanner(page);
      await expect(page.getByTestId("mc-status-line"), `${w}: the match centre`).toHaveText(withNext);
      // Audit 3.1: the court card carries no score lines over "Neither side turned up" — its own no-score dash, never
      // the summary's 0 / 0.
      for (const i of [0, 1]) await expect(page.getByTestId(`mc-score-${i}`), `${w}: the court card's score ${i}`).toHaveText("—");
      await expectNoHorizontalScroll(page);
      await crop(page.locator("main"), `match-centre-double-walkover-${w}`);
      screens++;

      // Audit 3.1's pair: the other semi, walked over N–0, keeps its credited score on the same card.
      await page.goto(`${base}/fixtures/${other!.id}`);
      await dismissCookieBanner(page);
      await expect(page.getByTestId("mc-score-1"), `${w}: the walked-over semi's credited nil`).toHaveText("0");

      // Audit 3.1: the hub's results card reads no 0 / 0 for the double walkover; the same probe finds the other semi's
      // lone "0".
      await hubResults(page, `/shared/${org.slug}/${ko.compSlug}?tab=matches`);
      const dwCard = page.getByTestId(`mh-match-${dw!.id}`);
      await expect(dwCard, `${w}: the double walkover's results card`).toBeVisible({ timeout: STEP_MS });
      await expect(dwCard.getByText("0", { exact: true }), `${w}: the results card reads no 0 / 0`).toHaveCount(0);
      await expect(page.getByTestId(`mh-match-${other!.id}`).getByText("0", { exact: true }), `${w}: the probe's positive pair`).toHaveCount(1);
      await expectNoHorizontalScroll(page);
      await crop(dwCard, `hub-card-double-walkover-${w}`);
      screens++;

      // The knockout draw (drawn from 1024 up; the phone reads the cards above): its node reads no 0 / 0 either.
      if (w >= 1024) {
        await page.goto(`/shared/${org.slug}/${ko.compSlug}?tab=knockout&view=draw`);
        await dismissCookieBanner(page);
        const node = page.getByTestId(`mh-knockout-node-${dw!.id}`);
        await expect(node, `${w}: the double walkover's draw node`).toBeVisible({ timeout: STEP_MS });
        await expect(node.getByText("0", { exact: true }), `${w}: the draw node reads no 0 / 0`).toHaveCount(0);
        await expect(page.getByTestId(`mh-knockout-node-${other!.id}`).getByText("0", { exact: true }), `${w}: the node probe's positive pair`).toHaveCount(1);
        await crop(node, `hub-knockout-node-double-walkover-${w}`);
        screens++;
      }

      await page.goto(`${base}?tab=standings`);
      await dismissCookieBanner(page);
      const tileTag = page.getByRole("img", { name: withNext });
      await expect(tileTag, `${w}: the tile's tag is named by the sentence`).toHaveText(dwTag);
      await expect(tileTag).toHaveCount(1);
      // Design round (audit 3.1's sixth host): the tile's footer is the tag alone — no "0 — 0" headline beside it. The
      // pair: another forfeited tile on the same bracket (a credited walkover) keeps its score in the same footer.
      const tile = tileTag.locator("xpath=ancestor::a[1]");
      await expect(tile.getByTestId("bracket-forfeit"), `${w}: the double walkover's footer is its tag alone`).toHaveText(dwTag);
      await expect(
        page.getByTestId("bracket-forfeit").filter({ hasNot: page.getByRole("img", { name: withNext }) }).first(),
        `${w}: the footer probe's positive pair — a credited walkover keeps its score`,
      ).toHaveText(/\d+\s*[–—-]\s*\d+/);
      await expectNoHorizontalScroll(page);
      await crop(tile, `bracket-tile-double-walkover-${w}`);
      screens++;

      // Review I-2 — the Schedule row: the tag alone, named by the sentence, and never the unplayed 0 — 0. Its pair is
      // the other semi's row (a walkover credited N–0), where the same probe DOES find a lone "0".
      await page.goto(base);
      await dismissCookieBanner(page);
      const schedule = page.locator("#panel-schedule");
      const dwRowTag = schedule.getByRole("img", { name: withNext });
      await expect(dwRowTag, `${w}: the schedule row's tag`).toHaveText(dwTag, { timeout: STEP_MS });
      const dwRow = dwRowTag.locator("xpath=ancestor::a[1]");
      await expect(dwRow.getByText("0", { exact: true }), `${w}: a double walkover reads no 0 — 0`).toHaveCount(0);
      await expect(dwRow).not.toContainText(/0\s*[–—-]\s*0/);
      const otherRow = schedule.getByRole("img", { name: say("forfeit.sentence.walkover", { loser: ko.nameOf.get(other!.away_entrant_id!)! }) }).locator("xpath=ancestor::a[1]");
      await expect(otherRow.getByText("0", { exact: true }), `${w}: the probe's positive pair`).toHaveCount(1);
      await expectNoHorizontalScroll(page);
      await crop(dwRow, `schedule-double-walkover-${w}`);
      screens++;
    }
    expect(screens).toBe(WIDTHS.length * 4 + WIDTHS.filter((w) => w >= 1024).length);

    // Review I-1 — the organiser's slideshow reads `match_states.summary` straight from the database, and painted the
    // double walkover's stored 0 / 0. 1280 only: the board is `max-lg:hidden` behind the phone card below 1024
    // (kiosk-phone-card.spec.ts covers that gate). The board rotates, so step with the arrow key until both the
    // results slide and the bracket slide have been read. Pair: the other semi keeps its credited score on each.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/slideshow/divisions/${ko.divId}`);
    const board = page.getByTestId("kiosk-board");
    await expect(board).toBeVisible({ timeout: STEP_MS });
    const sides = (f: typeof dw) => [ko.nameOf.get(f!.home_entrant_id!)!, ko.nameOf.get(f!.away_entrant_id!)!];
    const UI = JSON.parse(readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8")) as Record<string, string>;
    const resultsTitle = UI["slideshow.slide.latestResults"]!;
    expect(resultsTitle, "premise: the results slide's title").toBeTruthy();
    const seen: Partial<Record<"results" | "bracket", { dw: string; other: string }>> = {};
    await expect
      .poll(
        async () => {
          const got = await board.evaluate(
            (root, [dwN, otherN]) => {
              const spans = (n: string) => [...root.querySelectorAll("span")].filter((x) => x.textContent?.trim() === n);
              /** The smallest element holding one span named A and one named B — that fixture's row or node. */
              const around = ([a, b]: string[]) => {
                let best: string | null = null;
                for (const x of spans(a!)) {
                  for (const y of spans(b!)) {
                    let el: Element | null = x;
                    while (el && !el.contains(y)) el = el.parentElement;
                    const text = el ? (el as HTMLElement).innerText.replace(/\s+/g, " ").trim() : null;
                    if (text !== null && (best === null || text.length < best.length)) best = text;
                  }
                }
                return best;
              };
              const slide = root.querySelector("h2")?.textContent?.trim() ?? "";
              // The bracket slide's canvas: an svg of connector lines under the positioned nodes (`BracketSlide`).
              return { slide, bracket: root.querySelector(".overflow-x-auto > .relative > svg") !== null, dw: around(dwN), other: around(otherN) };
            },
            [sides(dw), sides(other)] as const,
          );
          const kind = got.slide === resultsTitle ? "results" : got.bracket ? "bracket" : null;
          if (kind && got.dw !== null && got.other !== null && !seen[kind]) {
            seen[kind] = { dw: got.dw, other: got.other };
            await crop(board, `slideshow-${kind}-double-walkover-1280`);
          }
          if (!seen.results || !seen.bracket) await page.keyboard.press("ArrowRight");
          return Object.keys(seen).sort().join(",");
        },
        { timeout: 60_000, intervals: [400] },
      )
      .toBe("bracket,results");
    for (const kind of ["results", "bracket"] as const) {
      const got = seen[kind]!;
      console.log(`I-1 slideshow ${kind}: double walkover "${got.dw}" / other semi "${got.other}"`);
      expect(got.dw, `slideshow ${kind}: the double walkover prints its tag`).toContain(dwTag);
      expect(got.dw, `slideshow ${kind}: never the stored 0 / 0`).not.toMatch(/0\s*[–—-]\s*0/);
      expect(got.other, `slideshow ${kind}: the probe's pair — the walkover keeps its credited score`).toMatch(/\d+\s*[–—-]\s*\d+/);
    }
    // Loop R M-11 — the results slide's status cell names the walkover's reason (it read "Forfeit" for every reason),
    // its case kept: innerText applies the cell's uppercase, so a lost `normal-case` reads "W/O". The double walkover's
    // tag is its score's, so its status cell keeps the status word — never the tag twice.
    const woWord = UI["forfeit.tag.walkover"]!;
    const forfeitWord = UI["slideshow.status.forfeit"]!.toUpperCase();
    expect(seen.results!.other.endsWith(` ${woWord}`), `M-11: the walkover's status cell: "${seen.results!.other}"`).toBe(true);
    expect(seen.results!.other, "M-11: never the bare status word").not.toContain(forfeitWord);
    expect(seen.results!.dw.endsWith(` ${forfeitWord}`), `M-11: the double walkover keeps its status word: "${seen.results!.dw}"`).toBe(true);
  });

  // Owner ruling 116 and R116-1 (W2b Task 16): a semi-final winner withdraws while the final's other seat is TBD, so her
  // final seat dies; the other semi's winner then arrives and walks over HER. The final reads as a walkover — her name
  // in her seat, the w/o tag named by "<her> withdrew — walkover." — and never the bye word, which before this read
  // beside the tag. The probe's positive pair is the SAME locator on the SAME page before the arrival, where her dead
  // seat still reads the bye word (a probe that cannot see "Bye" would pass the absence vacuously).
  // R116-2: …and shows the sport's walkover credit, like any walkover: football's `awardScore.goals` to the side that
  // turned up and nil to her, by seat, on each surface that prints a score. Its pair: before the arrival the same
  // match-centre cells print no score.
  test("ruling 116 / R116-1 / R116-2: a withdrawn winner's walked-over final names her with w/o and the credited score on every surface, never Bye, at 1280/768/320", async ({ page, request }) => {
    test.setTimeout(4 * 60_000);
    const org = await activeOrg(page);
    const ko = await publicKnockout(request);
    const [sf1, sf2] = ko.semis;
    const UI = JSON.parse(readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8")) as Record<string, string>;
    const bye = UI["bracket.slot.bye"]!;
    expect(bye, "ui.json's bye word").toBeTruthy();
    // Read through innerText (cell breaks kept, and the match centre's CSS-uppercased "BYE" seen as rendered):
    // textContent glues a row's time cell to its seat ("TBDBye"), where a word boundary never matches.
    const BYE = new RegExp(`\\b${bye}\\b`, "i");
    // SF1 is walked over to its home side, who reaches the final — and then withdraws, with the final's other seat TBD.
    const her = sf1!.home_entrant_id!;
    await post(request, sf1!.id, "core.forfeit", { by: sf1!.away_entrant_id, reason: "walkover" });
    await expect.poll(async () => { const f = await read(request, ko.final.id); return [f.home_entrant_id, f.away_entrant_id].includes(her); }, { timeout: STEP_MS }).toBe(true);
    const withdrew = await apiJson(request, `/api/v1/entrants/${her}/withdraw`, "POST");
    expect(withdrew.status, JSON.stringify(withdrew.error)).toBeLessThan(300);
    const waiting = await read(request, ko.final.id);
    expect([waiting.home_entrant_id, waiting.away_entrant_id, waiting.status], "her final seat is emptied; the final waits").toEqual([null, null, "scheduled"]);
    const base = `/shared/${org.slug}/${ko.compSlug}`;
    const finalRow = (panel: string) => page.locator(`#panel-${panel} a[href$="/fixtures/${ko.final.id}"]`);

    // The positive pair: before the arrival, her dead seat reads the bye word — on the schedule row and the tile.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${base}/${ko.divSlug}`);
    await dismissCookieBanner(page);
    await expect(finalRow("schedule"), "before: the schedule row's dead seat reads the bye word").toContainText(BYE, { timeout: STEP_MS, useInnerText: true });
    await page.goto(`${base}/${ko.divSlug}?tab=standings`);
    await expect(finalRow("standings"), "before: the tile's dead seat reads the bye word").toContainText(BYE, { timeout: STEP_MS, useInnerText: true });
    // …and the hub's knockout card draws its still-pending seat with the waiting-slot "?" crest (the crest probe's pair).
    const koCard = () => page.getByTestId("mh-tab-panel-knockout").getByTestId(`mh-match-${ko.final.id}`);
    await page.goto(`${base}?tab=knockout`);
    await dismissCookieBanner(page);
    // The Rounds list shows one round: the semis while one is still to play, so press the Final (the rail's last chip).
    const finalChip = page.getByTestId("mh-tab-panel-knockout").locator('[data-testid^="mh-knockout-round-"]').last();
    await expect(finalChip).toBeVisible({ timeout: STEP_MS });
    await finalChip.click();
    await expect(koCard(), "before: the pending seat's crest is the waiting slot's").toContainText("?", { timeout: STEP_MS });
    // R116-2's pair: nothing is credited yet, so the match centre's score cells print none.
    await page.goto(`${base}/${ko.divSlug}/fixtures/${ko.final.id}`);
    for (const i of [0, 1]) await expect(page.getByTestId(`mc-score-${i}`), `before: score ${i}`).toHaveText("—", { timeout: STEP_MS });

    // SF2 is walked over to its home side, who arrives and walks over her (awardSeededByes, ruling 116).
    const arriving = sf2!.home_entrant_id!;
    await post(request, sf2!.id, "core.forfeit", { by: sf2!.away_entrant_id, reason: "walkover" });
    await expect.poll(async () => (await read(request, ko.final.id)).status, { timeout: STEP_MS }).toBe("forfeited");
    const final = await read(request, ko.final.id);
    expect(final.outcome, "a walkover naming who withdrew").toEqual({ kind: "award", winner: arriving, loser: her, reason: "withdrew" });
    expect([final.home_entrant_id, final.away_entrant_id].filter(Boolean), "she is never seated").toEqual([arriving]);
    const herName = ko.nameOf.get(her)!;
    const sentence = say("forfeit.sentence.withdrew", { loser: herName });
    const tag = say("forfeit.tag.walkover");
    // R116-2: the credit by seat, home first — the arriving side's goals, her nil.
    const want = final.home_entrant_id === arriving ? [String(CREDIT), "0"] : ["0", String(CREDIT)];
    expect(CREDIT, "premise: the walkover credits goals, so the credit differs from her 0").toBeGreaterThan(0);
    const headline = new RegExp(`^${want[0]}\\s*[–—-]\\s*${want[1]}$`);
    const hubScores = async (card: ReturnType<typeof page.getByTestId>, where: string) => {
      for (const i of [0, 1]) {
        await expect(card.getByTestId(`mh-match-side-${i}`).locator("span.tabular-nums"), `${where}: side ${i}'s score`).toHaveText(want[i]!);
      }
    };

    let screens = 0;
    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w, height: 900 });

      // The match centre: her name in her seat, the withdrew sentence, and no bye word anywhere on the page or its title.
      await page.goto(`${base}/${ko.divSlug}/fixtures/${ko.final.id}`);
      await dismissCookieBanner(page);
      await expect(page.getByTestId("mc-status-line"), `${w}: the match centre's sentence`).toHaveText(sentence, { timeout: STEP_MS });
      await expect(page.locator("main"), `${w}: the match centre names her`).toContainText(herName);
      await expect(page.locator("main"), `${w}: the match centre prints no bye word`).not.toContainText(BYE, { useInnerText: true });
      expect(await page.title(), `${w}: the title names her`).toContain(herName);
      expect(await page.title(), `${w}: the title prints no bye word`).not.toMatch(BYE);
      for (const i of [0, 1]) await expect(page.getByTestId(`mc-score-${i}`), `${w}: the match centre's score ${i}`).toHaveText(want[i]!);
      await expectNoHorizontalScroll(page);
      await crop(page.locator("main"), `match-centre-withdrew-final-${w}`);
      screens++;

      // The schedule row: her name, the w/o tag named by the sentence, no bye word.
      await page.goto(`${base}/${ko.divSlug}`);
      await dismissCookieBanner(page);
      const row = finalRow("schedule");
      await expect(row.getByRole("img", { name: sentence }), `${w}: the schedule row's tag`).toHaveText(tag, { timeout: STEP_MS });
      await expect(row, `${w}: the schedule row names her`).toContainText(herName);
      await expect(row, `${w}: the schedule row prints no bye word`).not.toContainText(BYE, { useInnerText: true });
      // Stacked by seat as any walkover's row (the tag rides the winner's line), never the no-lines headline chip.
      const lines = row.getByTestId("schedule-score");
      await expect(lines, `${w}: the schedule row stacks two score lines`).toHaveCount(2);
      // Design audit 3.9: the tag FOLLOWS the winner's credit ("3" then "w/o"), as on the other hosts; her line ends 0.
      // Design review M-3: each score cell holds its digit alone and the tag sits in its own track, in the cell right
      // after the winner's score — so both digits end on one edge.
      const winLine = final.home_entrant_id === arriving ? 0 : 1;
      for (const i of [0, 1]) {
        await expect(lines.nth(i), `${w}: the schedule row's line ${i}`).toHaveText(new RegExp(`(^|\\D)${want[i]!}$`));
      }
      await expect(
        lines.nth(winLine).locator("xpath=following-sibling::*[1]").getByRole("img", { name: sentence }),
        `${w}: the tag follows the winner's score`,
      ).toHaveText(tag);
      const edges = await lines.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().right));
      expect(Math.abs(edges[0]! - edges[1]!), `${w}: both digits end on one edge (${edges.join(", ")})`).toBeLessThanOrEqual(0.5);
      await expectNoHorizontalScroll(page);
      await crop(row, `schedule-withdrew-final-${w}`);
      screens++;

      // The bracket tile: the same.
      await page.goto(`${base}/${ko.divSlug}?tab=standings`);
      await dismissCookieBanner(page);
      const tile = finalRow("standings");
      await expect(tile.getByRole("img", { name: sentence }), `${w}: the tile's tag`).toHaveText(tag, { timeout: STEP_MS });
      await expect(tile, `${w}: the tile names her`).toContainText(herName);
      await expect(tile, `${w}: the tile prints no bye word`).not.toContainText(BYE, { useInnerText: true });
      await expect(tile.getByTestId("bracket-forfeit").locator("span").first(), `${w}: the tile's credited headline`).toHaveText(headline);
      await expectNoHorizontalScroll(page);
      await crop(tile, `bracket-tile-withdrew-final-${w}`);
      screens++;

      // The hub's results card: her name, the tag, no bye word.
      await hubResults(page, `${base}?tab=matches`);
      const card = page.getByTestId(`mh-match-${ko.final.id}`);
      await expect(card, `${w}: the results card`).toBeVisible({ timeout: STEP_MS });
      await expect(card.getByRole("img", { name: sentence }), `${w}: the results card's tag`).toHaveText(tag);
      await expect(card, `${w}: the results card names her`).toContainText(herName);
      await expect(card, `${w}: the results card prints no bye word`).not.toContainText(BYE, { useInnerText: true });
      await expect(card, `${w}: her side is drawn as a side, never the waiting slot's "?" crest`).not.toContainText("?");
      await hubScores(card, `${w}: the results card`);
      await expectNoHorizontalScroll(page);
      await crop(card, `results-card-withdrew-final-${w}`);
      screens++;

      // The hub's knockout card (Rounds, every width): the same card the positive pair read, now her side. A finished draw
      // opens on its Final, so no chip is pressed.
      await page.goto(`${base}?tab=knockout`);
      await dismissCookieBanner(page);
      await expect(koCard().getByRole("img", { name: sentence }), `${w}: the knockout card's tag`).toHaveText(tag, { timeout: STEP_MS });
      await expect(koCard(), `${w}: the knockout card names her`).toContainText(herName);
      await expect(koCard(), `${w}: the knockout card prints no bye word`).not.toContainText(BYE, { useInnerText: true });
      await expect(koCard(), `${w}: the knockout card draws her as a side`).not.toContainText("?");
      await hubScores(koCard(), `${w}: the knockout card`);
      await expectNoHorizontalScroll(page);
      await crop(koCard(), `knockout-card-withdrew-final-${w}`);
      screens++;
    }
    expect(screens).toBe(WIDTHS.length * 5);
  });
});

/** A knockout whose final waits on SF2 with SF1's winner gone from it: `depart` empties her seat (R116-3, R116-4). */
async function deadSeatKnockout(request: APIRequestContext, depart: (her: string) => Promise<void>) {
  const ko = await publicKnockout(request);
  const [sf1, sf2] = ko.semis;
  const her = sf1!.home_entrant_id!;
  await depart(her);
  await post(request, sf1!.id, "core.forfeit", { by: sf1!.away_entrant_id, reason: "walkover" });
  return { ko, sf2: sf2!, her };
}
/** SF2's winner arrives in the final, walking it over. */
async function arriveInFinal(request: APIRequestContext, ko: Awaited<ReturnType<typeof publicKnockout>>, sf2: Fx) {
  await post(request, sf2.id, "core.forfeit", { by: sf2.away_entrant_id, reason: "walkover" });
  await expect.poll(async () => (await read(request, ko.final.id)).status, { timeout: STEP_MS }).toBe("forfeited");
  return read(request, ko.final.id);
}

// R116-3 (W2b Task 16; owner ruling 116): the ORGANISER's surfaces — the division's run sheet (`?tab=fixtures`) and the
// bracket panel above it — read the same tie as a walkover naming her in her seat, never "{name} has a bye" and never
// the bye label. The positive pair is the same locator before the arrival, where her dead seat reads the bye word; and a
// DQ'd winner's dead seat (a bare status write: the award names nobody) stays a bye on both, after the arrival too.
test.describe("W2b R116-3 — the organiser's run sheet and bracket read ruling 116's walkover as a walkover", () => {
  test("her name in her seat on the run sheet and the bracket panel at 1280/768/320; a DQ'd winner's dead seat stays a bye", async ({ page, request }) => {
    test.setTimeout(4 * 60_000);
    await activeOrg(page);
    const UI = JSON.parse(readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8")) as Record<string, string>;
    const bye = UI["bracket.slot.bye"]!;
    const hasBye = UI["schedule.bye"]!;
    expect([bye, hasBye].every(Boolean), "ui.json's bye words").toBe(true);
    // No word boundary: the run sheet's seat spans glue to their neighbours in innerText ("ByevsWinner of R1·2"). None
    // of this draw's names holds the letters, so the bare word is the probe.
    const BYE = new RegExp(bye, "i");

    const deadSeatFinal = (depart: (her: string) => Promise<void>) => deadSeatKnockout(request, depart);
    const arrive = (ko: Awaited<ReturnType<typeof publicKnockout>>, sf2: Fx) => arriveInFinal(request, ko, sf2);
    const surfaces = (no: number) => ({
      row: page.getByTestId("run-sheet").locator(`li[data-fixture-no="${no}"]`),
      byeRows: page.getByTestId("run-sheet").getByTestId("run-sheet-bye"),
      node: page.getByTestId("bracket-panel").locator(`a[href$="/f/${no}"]`),
    });

    // Ruling 116's tie: SF1's winner reaches the final and withdraws (the final's other seat TBD), SF2's winner arrives.
    const w = await deadSeatFinal(async () => {});
    await expect.poll(async () => { const f = await read(request, w.ko.final.id); return [f.home_entrant_id, f.away_entrant_id].includes(w.her); }, { timeout: STEP_MS }).toBe(true);
    const withdrew = await apiJson(request, `/api/v1/entrants/${w.her}/withdraw`, "POST");
    expect(withdrew.status, JSON.stringify(withdrew.error)).toBeLessThan(300);
    const herName = w.ko.nameOf.get(w.her)!;
    expect([...w.ko.nameOf.values()].filter((x) => BYE.test(x)), "premise: no name holds the bye word's letters").toEqual([]);
    const fixtures = await divisionPath(request, w.ko.divId, "?tab=fixtures");
    const s = surfaces(w.ko.final.fixture_no);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(fixtures);
    await dismissCookieBanner(page);
    await expect(s.row, "before: her dead seat reads the bye word on the run sheet").toContainText(BYE, { timeout: STEP_MS, useInnerText: true });
    await expect(s.node, "before: and on the bracket panel").toContainText(BYE, { useInnerText: true });
    const final = await arrive(w.ko, w.sf2);
    const arriving = w.sf2.home_entrant_id!;
    expect(final.outcome, "a walkover naming who withdrew").toEqual({ kind: "award", winner: arriving, loser: w.her, reason: "withdrew" });
    const arrivingName = w.ko.nameOf.get(arriving)!;

    let screens = 0;
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(fixtures);
      await dismissCookieBanner(page);
      await expect(s.row, `${width}: the final is an ordinary run-sheet row`).toBeVisible({ timeout: STEP_MS });
      await expect(s.byeRows, `${width}: no bye row on this draw`).toHaveCount(0);
      for (const [where, at] of [["run sheet row", s.row], ["bracket node", s.node]] as const) {
        await expect(at, `${width}: the ${where} names her`).toContainText(herName);
        await expect(at, `${width}: the ${where} names the arriving side`).toContainText(arrivingName);
        await expect(at, `${width}: the ${where} prints no bye word`).not.toContainText(BYE, { useInnerText: true });
        console.log(`R116-3 ${width} ${where}: ${(await at.innerText()).replace(/\s+/g, " ").trim()}`);
        screens++;
      }
      await expect(s.row, `${width}: no "has a bye"`).not.toContainText(hasBye.replace("{name}", arrivingName));
      // Design audit 4.1: her name is marked as withdrawn — one chip, the entrant status's word, inside the row's line.
      const chip = s.row.getByTestId("run-sheet-withdrawn");
      await expect(chip, `${width}: one Withdrawn chip`).toHaveCount(1);
      await expect(chip, `${width}: the entrant status's word`).toHaveText(UI["entrants.status.withdrawn"]!);
      // Geometry, as painted: the chip is whole inside the line (never cut "With…"), is not struck through with the
      // forfeited names, and the arriving side still shows beside it — at 320 the chip must not push the opponent out.
      const g = await chip.evaluate((el, arrivingText) => {
        const line = el.closest("a")!;
        const lb = line.getBoundingClientRect();
        const cb = el.getBoundingClientRect();
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        let arrivingLeft: number | null = null;
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if (n.textContent?.includes(arrivingText)) {
            const r = document.createRange();
            r.selectNodeContents(n);
            arrivingLeft = r.getBoundingClientRect().left;
          }
        }
        return {
          chip: [Math.round(cb.left), Math.round(cb.right)],
          line: [Math.round(lb.left), Math.round(lb.right)],
          struck: getComputedStyle(el).textDecorationLine.includes("line-through") || el.closest(".line-through") !== null && getComputedStyle(el).display === "inline",
          arrivingLeft: arrivingLeft === null ? null : Math.round(arrivingLeft),
        };
      }, arrivingName);
      console.log(`audit 4.1 ${width} run sheet chip: ${JSON.stringify(g)}`);
      expect(g.chip[1], `${width}: the chip ends inside its line`).toBeLessThanOrEqual(g.line[1] + 0.5);
      expect(g.struck, `${width}: the chip is not struck through with the names`).toBe(false);
      expect(g.arrivingLeft, `${width}: the arriving side is painted on the line`).not.toBeNull();
      expect(g.arrivingLeft!, `${width}: and starts inside it`).toBeLessThan(g.line[1] - 8);
      await expectNoHorizontalScroll(page);
      await crop(s.row, `organiser-run-sheet-withdrew-final-${width}`);
      await crop(s.node, `organiser-bracket-withdrew-final-${width}`);
    }
    expect(screens).toBe(WIDTHS.length * 2);

    // The pair: a DQ'd winner's dead seat. Her disqualification is the bare status write v1's entrant patch makes, so the
    // award names no loser — a bye on both surfaces, and never her name.
    const dq = await deadSeatFinal(async (her) => {
      const left = await apiJson(request, `/api/v1/entrants/${her}`, "PATCH", { status: "disqualified" });
      expect(left.status, JSON.stringify(left.error)).toBeLessThan(300);
    });
    const dqFinal = await arrive(dq.ko, dq.sf2);
    const dqArriving = dq.sf2.home_entrant_id!;
    expect(dqFinal.outcome, "a walkover by bye, naming nobody").toEqual({ kind: "award", winner: dqArriving, loser: null, reason: "bye" });
    const dqName = dq.ko.nameOf.get(dq.her)!;
    const dqArrivingName = dq.ko.nameOf.get(dqArriving)!;
    const d = surfaces(dqFinal.fixture_no);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(await divisionPath(request, dq.ko.divId, "?tab=fixtures"));
    await dismissCookieBanner(page);
    const dqBye = d.byeRows.filter({ hasText: hasBye.replace("{name}", dqArrivingName) });
    await expect(dqBye, "the run sheet keeps the bye row").toHaveCount(1, { timeout: STEP_MS });
    await expect(d.byeRows, "and it is the only bye row").toHaveCount(1);
    await expect(dqBye, "naming nobody else").not.toContainText(dqName);
    await expect(d.node, "the bracket panel keeps the bye").toContainText(BYE, { useInnerText: true });
    await expect(d.node, "and never prints her").not.toContainText(dqName);
    await expect(page.getByTestId("run-sheet").getByTestId("run-sheet-withdrawn"), "DQ: no Withdrawn chip on the sheet (audit 4.1)").toHaveCount(0);
    console.log(`R116-3 DQ run sheet: ${(await dqBye.innerText()).replace(/\s+/g, " ").trim()}`);
    console.log(`R116-3 DQ bracket node: ${(await d.node.innerText()).replace(/\s+/g, " ").trim()}`);
  });
});

// R116-4 (W2b Task 16; owner ruling 116): the organiser surfaces R116-3 left — the fixture console every run-sheet row
// links to (`/f/{no}`), the schedule board's card and the officials tab's fixture list — name her in her seat, never the
// bye word ("Bye vs Bears of Brockley · forfeited" was the console's header). The positive pairs: before the arrival her
// dead seat reads the bye word on the console and the officials list, and the board card names its feeder; a DQ'd
// winner's dead seat (the award names nobody) keeps exactly that after the arrival too, and never prints her.
test.describe("W2b R116-4 — the organiser's console, board card and officials list name ruling 116's withdrawn winner", () => {
  test("her name in her seat on the fixture console, the board card and the officials list at 1280/768/320; a DQ'd winner's dead seat names nobody", async ({ page, request }) => {
    test.setTimeout(6 * 60_000);
    await activeOrg(page);
    const UI = JSON.parse(readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8")) as Record<string, string>;
    const bye = UI["bracket.slot.bye"]!;
    const [densityAria, densityBoard] = [UI["board.densityAria"]!, UI["board.density.board"]!];
    expect([bye, densityAria, densityBoard].every(Boolean), "ui.json's words").toBe(true);
    // Glued seat text (innerText "ByevsWinner of …"): no word boundary, and no name in this draw holds the letters.
    const BYE = new RegExp(bye, "i");
    const quote = async (at: Locator) => (await at.innerText()).replace(/\s+/g, " ").trim();

    const surfaces = async (divId: string, finalId: string, no: number) => {
      const consoleUrl = await divisionPath(request, divId, `/f/${no}`);
      const boardUrl = await divisionPath(request, divId, "/schedule?tab=board");
      const officialsUrl = await divisionPath(request, divId, "/schedule?tab=officials");
      const header = page.locator("header.card h1").first();
      const card = page.locator(`[data-fixture-id="${finalId}"]`).first();
      const open = async (url: string) => {
        await page.goto(url);
        await dismissCookieBanner(page);
      };
      /** The board on its Board density: a phone opens on Agenda (board-held-card.spec.ts). */
      const openBoard = async () => {
        await open(boardUrl);
        const density = page.getByRole("group", { name: densityAria }).getByRole("button", { name: densityBoard, exact: true });
        if (await density.isVisible()) {
          await density.click();
          await expect(density).toHaveAttribute("aria-pressed", "true");
        }
        await expect(card, "the board shows the final's card").toBeVisible({ timeout: STEP_MS });
      };
      return { header, card, consoleUrl, officialsUrl, open, openBoard };
    };
    /** The board draws a settled tie only where it was PLACED (a held card, board-held-card.spec.ts); the tray lists
     *  unplayed fixtures alone. So each rig's final is placed on a court before it is walked over. */
    const placeFinal = async (divId: string, finalId: string) => {
      const { courts } = await seedVenueWithCourts(request, ["Court 1"]);
      const startAt = new Date(Date.UTC(2030, 5, 1, 9, 0)).toISOString();
      const settings = await apiJson(request, `/api/v1/divisions/${divId}/schedule-settings`, "PUT", {
        tz: "UTC",
        config: { startAt, matchMinutes: 30, gapMinutes: 0, courts: [courts[0]!.id], perEntrantMinRest: 0, blackouts: [], sessionWindows: [] },
      });
      expect(settings.status, JSON.stringify(settings.error)).toBe(200);
      const placed = await apiJson(request, `/api/v1/fixtures/${finalId}`, "PATCH", { scheduled_at: startAt, court_id: courts[0]!.id });
      expect(placed.status, `place the final: ${JSON.stringify(placed.error)}`).toBe(200);
    };
    /** The officials list's row for the final: the one whose label names both of `names`. */
    const officialsRow = (...names: (string | RegExp)[]) =>
      names.reduce((rows: Locator, n) => rows.filter({ hasText: n }), page.locator("table tbody tr"));

    // Ruling 116's tie, as R116-3 builds it: SF1's winner reaches the final and withdraws, SF2's winner arrives.
    const w = await deadSeatKnockout(request, async () => {});
    await expect.poll(async () => { const f = await read(request, w.ko.final.id); return [f.home_entrant_id, f.away_entrant_id].includes(w.her); }, { timeout: STEP_MS }).toBe(true);
    const withdrew = await apiJson(request, `/api/v1/entrants/${w.her}/withdraw`, "POST");
    expect(withdrew.status, JSON.stringify(withdrew.error)).toBeLessThan(300);
    const herName = w.ko.nameOf.get(w.her)!;
    expect([...w.ko.nameOf.values()].filter((x) => BYE.test(x)), "premise: no name holds the bye word's letters").toEqual([]);
    await placeFinal(w.ko.divId, w.ko.final.id);
    const s = await surfaces(w.ko.divId, w.ko.final.id, w.ko.final.fixture_no);

    // Before the arrival: the console and the officials list read the bye word in her dead seat; the board card its
    // feeder. None names her.
    await page.setViewportSize({ width: 1280, height: 900 });
    await s.open(s.consoleUrl);
    await expect(s.header, "before: the console's header reads the bye word in her seat").toContainText(BYE, { timeout: STEP_MS, useInnerText: true });
    await expect(s.header, "before: and never her").not.toContainText(herName);
    console.log(`R116-4 before, console header: ${await quote(s.header)}`);
    await s.openBoard();
    const cardBefore = await quote(s.card);
    expect(cardBefore, "before: the board card does not name her").not.toContain(herName);
    console.log(`R116-4 before, board card: ${cardBefore}`);
    await s.open(s.officialsUrl);
    await expect(officialsRow(BYE), "before: the officials list reads the bye word for the final").toHaveCount(1, { timeout: STEP_MS });
    console.log(`R116-4 before, officials row: ${await quote(officialsRow(BYE).first())}`);

    const final = await arriveInFinal(request, w.ko, w.sf2);
    const arriving = w.sf2.home_entrant_id!;
    expect(final.outcome, "a walkover naming who withdrew").toEqual({ kind: "award", winner: arriving, loser: w.her, reason: "withdrew" });
    const arrivingName = w.ko.nameOf.get(arriving)!;
    // Her seat: the final's empty one. The header and the list print home first.
    const herHome = final.home_entrant_id === null;
    const pair = herHome ? [herName, arrivingName] : [arrivingName, herName];
    // Design audit 4.1: the string surfaces (board card, officials list) mark her name; 4.2: the dictionary's "vs".
    const markOf = (name: string) => UI["schedule.withdrawnSide"]!.replace("{name}", name);
    const MARK_TAIL = markOf("");
    expect(MARK_TAIL.trim(), "premise: the mark adds words").not.toBe("");
    const marked = pair.map((x) => (x === herName ? markOf(x) : x));

    let screens = 0;
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await s.open(s.consoleUrl);
      await expect(s.header, `${width}: the console's header names her`).toContainText(herName, { timeout: STEP_MS });
      const header = await quote(s.header);
      expect(header.indexOf(pair[0]!) < header.indexOf(pair[1]!), `${width}: her name in her seat (${header})`).toBe(true);
      expect(header, `${width}: the console's header prints no bye word`).not.toMatch(BYE);
      // Design review M-4 (audit 4.1): the header marks her as the run sheet does — the Withdrawn chip, once, whole and
      // inside the header at every width (a whole-line truncate cut it to "With…" at 320). Owner option A (2026-10-13):
      // on the phone strip with its details closed the chip takes its own line UNDER the names, so each name keeps
      // real room — beside the chip each was cut to about one letter at 320 ("R… Withdrawn vs B…"). Measured off the
      // rendering: each name's visible box against the width its own first characters need (a Range over its text);
      // never class names. Elsewhere (≥768, no toggle) the chip stays on the names' line.
      const chip = s.header.locator('[data-testid="console-withdrawn"]');
      await expect(chip, `${width}: the console marks her as withdrawn`).toHaveCount(1);
      await expect(chip, `${width}: in the entrant status's own word`).toHaveText(UI["entrants.status.withdrawn"]!);
      // Cropped before the measurements below, so the picture exists whichever way they go.
      await crop(s.header.locator("xpath=ancestor::header[1]"), `organiser-console-withdrew-final-${width}`);
      const phoneStrip = await page.locator('[data-role="match-details-toggle"]').isVisible();
      const FEW = 6;
      const room = await s.header.evaluate(
        (h1, [names, few]) => {
          const chipEl = h1.querySelector('[data-testid="console-withdrawn"]')!;
          const r = chipEl.getBoundingClientRect();
          const line = h1.getBoundingClientRect();
          const spans = (names as string[]).map((name) => [...h1.querySelectorAll("span")].find((x) => x.textContent === name) ?? null);
          const measured = spans.map((el, i) => {
            if (!el || !el.firstChild) return null;
            const range = document.createRange();
            range.setStart(el.firstChild, 0);
            range.setEnd(el.firstChild, Math.min(few as number, (names as string[])[i]!.length));
            return { visible: el.getBoundingClientRect().width, needs: range.getBoundingClientRect().width, bottom: el.getBoundingClientRect().bottom, top: el.getBoundingClientRect().top };
          });
          return {
            whole: chipEl.scrollWidth <= chipEl.clientWidth + 0.5,
            inside: r.left >= line.left - 0.5 && r.right <= line.right + 0.5,
            chipTop: r.top,
            chipBottom: r.bottom,
            names: measured,
          };
        },
        [pair, FEW] as const,
      );
      expect({ whole: room.whole, inside: room.inside }, `${width}: the chip is whole, inside the header`).toEqual({ whole: true, inside: true });
      expect(room.names.every((x) => x !== null), `${width}: both names found in the header`).toBe(true);
      room.names.forEach((x, i) => {
        // Each name shows at least its first FEW characters: its visible box is no narrower than they need.
        expect(x!.visible, `${width}: "${pair[i]}" shows more than a few characters (${x!.visible.toFixed(1)}px for ${x!.needs.toFixed(1)}px)`).toBeGreaterThanOrEqual(x!.needs - 0.5);
      });
      const namesBottom = Math.max(...room.names.map((x) => x!.bottom));
      const herBox = room.names[pair.indexOf(herName)]!;
      if (phoneStrip) {
        expect(room.chipTop, `${width}: closed phone strip — the chip on its own line under the names`).toBeGreaterThanOrEqual(namesBottom - 0.5);
      } else {
        expect(room.chipTop < herBox.bottom && room.chipBottom > herBox.top, `${width}: the chip on her name's line`).toBe(true);
      }
      await expectNoHorizontalScroll(page);
      console.log(`R116-4 ${width} console header: ${header}`);
      screens++;
      // Review M-4 follow-up: on the phone the closed strip truncates the names; opening its details shows both whole
      // (≥768 has no toggle and wraps, so both are whole there already). Gated on the toggle, never a width literal.
      const toggle = page.locator('[data-role="match-details-toggle"]');
      if (await toggle.isVisible()) {
        await toggle.click();
        await expect(toggle, `${width}: the details opened`).toHaveAttribute("aria-expanded", "true");
      }
      const cut = await s.header.evaluate((h1, names) =>
        names.map((name) => {
          const el = [...h1.querySelectorAll("span")].find((x) => x.textContent === name);
          return el ? el.scrollWidth > el.clientWidth + 0.5 : "missing";
        }), pair);
      expect(cut, `${width}: ${await toggle.isVisible() ? "details open" : "≥768"} — both names whole (${pair.join(" / ")})`).toEqual([false, false]);
      await expectNoHorizontalScroll(page);
      await crop(s.header.locator("xpath=ancestor::header[1]"), `organiser-console-withdrew-final-open-${width}`);

      await s.openBoard();
      const card = await quote(s.card);
      expect(card, `${width}: the board card names her`).toContain(herName);
      expect(card.indexOf(pair[0]!) < card.indexOf(pair[1]!), `${width}: in her seat (${card})`).toBe(true);
      expect(card, `${width}: the board card prints no bye word`).not.toMatch(BYE);
      expect(card, `${width}: the board card marks her as withdrawn (audit 4.1)`).toContain(markOf(herName));
      expect(card, `${width}: and only her`).not.toContain(markOf(arrivingName));
      await expectNoHorizontalScroll(page);
      await crop(s.card, `organiser-board-card-withdrew-final-${width}`);
      console.log(`R116-4 ${width} board card: ${card}`);
      screens++;

      await s.open(s.officialsUrl);
      const row = officialsRow(herName, arrivingName);
      await expect(row, `${width}: the officials list names her opposite the arriving side`).toHaveCount(1, { timeout: STEP_MS });
      const label = await quote(row.locator("td").first());
      expect(label, `${width}: her name in her seat, marked as withdrawn (audit 4.1)`).toBe(`${marked[0]} ${UI["schedule.vs"]} ${marked[1]}`);
      await expect(officialsRow(BYE), `${width}: no bye word in the officials list`).toHaveCount(0);
      await expectNoHorizontalScroll(page);
      await crop(row, `organiser-officials-withdrew-final-${width}`);
      console.log(`R116-4 ${width} officials row: ${label}`);
      screens++;
    }
    expect(screens).toBe(WIDTHS.length * 3);

    // The pair: a DQ'd winner's dead seat (the bare status write v1's entrant patch makes): a walkover by bye naming
    // nobody — the console and the officials list keep the bye word, the board card its feeder, and none prints her.
    const dq = await deadSeatKnockout(request, async (her) => {
      const left = await apiJson(request, `/api/v1/entrants/${her}`, "PATCH", { status: "disqualified" });
      expect(left.status, JSON.stringify(left.error)).toBeLessThan(300);
    });
    await placeFinal(dq.ko.divId, dq.ko.final.id);
    const dqFinal = await arriveInFinal(request, dq.ko, dq.sf2);
    const dqArriving = dq.sf2.home_entrant_id!;
    expect(dqFinal.outcome, "a walkover by bye, naming nobody").toEqual({ kind: "award", winner: dqArriving, loser: null, reason: "bye" });
    const [dqName, dqArrivingName] = [dq.ko.nameOf.get(dq.her)!, dq.ko.nameOf.get(dqArriving)!];
    const d = await surfaces(dq.ko.divId, dqFinal.id, dqFinal.fixture_no);
    await page.setViewportSize({ width: 1280, height: 900 });
    await d.open(d.consoleUrl);
    await expect(d.header, "DQ: the console's header keeps the bye word").toContainText(BYE, { timeout: STEP_MS, useInnerText: true });
    await expect(d.header, "DQ: and names the arriving side").toContainText(dqArrivingName);
    await expect(d.header, "DQ: never her").not.toContainText(dqName);
    await expect(d.header.locator('[data-testid="console-withdrawn"]'), "DQ: and marks nobody as withdrawn (review M-4)").toHaveCount(0);
    console.log(`R116-4 DQ console header: ${await quote(d.header)}`);
    await d.openBoard();
    const dqCard = await quote(d.card);
    expect([dqCard.includes(dqArrivingName), dqCard.includes(dqName)], `DQ: the board card names the arriving side, never her (${dqCard})`).toEqual([true, false]);
    expect(dqCard, "DQ: and marks nobody as withdrawn (audit 4.1)").not.toContain(MARK_TAIL);
    console.log(`R116-4 DQ board card: ${dqCard}`);
    await d.open(d.officialsUrl);
    await expect(officialsRow(BYE, dqArrivingName), "DQ: the officials list keeps the bye word").toHaveCount(1, { timeout: STEP_MS });
    await expect(officialsRow(dqName, dqArrivingName), "DQ: and never pairs her with the arriving side").toHaveCount(0);
    await expect(officialsRow(BYE, dqArrivingName), "DQ: marking nobody as withdrawn (audit 4.1)").not.toContainText(MARK_TAIL);
    console.log(`R116-4 DQ officials row: ${await quote(officialsRow(BYE, dqArrivingName).first())}`);
  });
});

// ------------------------------------------------------------------------------------------------ W2b loop H findings
//
// F1 (controller ruling: the result tag never truncates) — at 320 the run sheet's phone line read "Round 2 · forfeited ·
// Bears of Br…": the ellipsis took "won (w/o)". Measured here as GEOMETRY, not text: every rendered copy of the result's
// tail lies wholly inside each clipping ancestor up to its row (`toContainText` reads textContent and cannot see an
// ellipsis). Realistic 43-character names, and every tag the line can end with: w/o, ret., DQ, Aband., 2× w/o.

const UI = JSON.parse(readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8")) as Record<string, string>;
const ui = (key: string) => {
  const w = UI[key];
  expect(w, `ui.json has ${key}`).toBeTruthy();
  return w!;
};
/** "{name} won ({tag})" in the en dictionary's own words, and the part after the name (the tail that must not truncate). */
const wonTagged = (name: string, tagKey: string) => ui("schedule.outcome.wonTagged").replace("{name}", name).replace("{tag}", ui(tagKey));
const wonTaggedTail = (tagKey: string) => wonTagged("", tagKey).trim();

/** Six realistic 43-character team names (AGENTS.md: the 320 overflow only shows with a realistic name). */
const LONG_NAMES = [
  "Riverside Athletic Football Club Under-21 A",
  "Bears of Brockley Sunday League Veterans XI",
  "Harbour United Reserves and Academy Squad B",
  "Kingsbridge Rovers Community Football Group",
  "Thornbury Town Saturday Morning Development",
  "Catford Wanderers Ladies Development Squads",
];

/** A started public football division of `names` (`kind` stage), with `config` merged over the variant. */
async function longNameDivision(r: APIRequestContext, kind: "league" | "knockout", names: string[], config: Record<string, unknown> = {}) {
  const comp = await apiJson<{ id: string; slug: string }>(r, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `W2b loop H ${TAG}-${Math.random().toString(36).slice(2, 6)}`,
    visibility: "public",
  });
  expect(comp.status, JSON.stringify(comp.error)).toBe(201);
  const div = await apiJson<{ id: string; slug: string }>(r, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Cup", sport_key: SPORT, variant_key: VARIANT, config,
  });
  expect(div.status, JSON.stringify(div.error)).toBe(201);
  const added = await addEntrantsViaApi(r, div.data!.id, names, "team");
  expect(added.ids).toHaveLength(names.length);
  const { fixtureIds } = await createStageAndGenerate(r, div.data!.id, { kind, name: "Cup" });
  const started = await apiJson(r, `/api/v1/divisions/${div.data!.id}/start`, "POST");
  expect(started.status, JSON.stringify(started.error)).toBeLessThan(300);
  const all = await Promise.all(fixtureIds.map((id) => read(r, id)));
  const nameOf = new Map(added.ids.map((id, i) => [id, names[i]!]));
  return { divId: div.data!.id, compSlug: comp.data!.slug, divSlug: div.data!.slug, seated: all.filter((f) => f.home_entrant_id && f.away_entrant_id), all, nameOf };
}

/** Every RENDERED copy of `tail` inside `row`, measured against each clipping ancestor up to the row. `crowded`: the line
 *  holding it really was short of room (its lead, or the line itself, overflows) — the precondition that makes a 320
 *  pass mean something. `broken`: a copy whose glyphs sit on more than one line (a tag wrapped is a tag broken).
 *  `glued`: a copy that starts its own box with no visible space after the box before it ("forfeited ·2× w/o").
 *  Design audit 4.3: the tag inside the tail is its own named symbol (`<span role="img">`), so a copy is found across
 *  text nodes — the row's text concatenated, each match mapped back to its nodes — and its box is the symbol's parent. */
async function measureTail(row: Locator, tail: string) {
  return row.evaluate((rowEl, t) => {
    const out = { measured: 0, clipped: [] as string[], crowded: false, broken: 0, glued: [] as number[] };
    const nodes: { n: Text; from: number }[] = [];
    let all = "";
    const walker = document.createTreeWalker(rowEl, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      nodes.push({ n: n as Text, from: all.length });
      all += n.textContent ?? "";
    }
    /** The text node and offset of a position in `all`: a START lies in the last node beginning at or before it, an END
     *  in the last node beginning before it. */
    const locate = (pos: number, end: boolean): [Text, number] => {
      for (let i = nodes.length - 1; i >= 0; i--) if (end ? pos > nodes[i]!.from : pos >= nodes[i]!.from) return [nodes[i]!.n, pos - nodes[i]!.from];
      return [nodes[0]!.n, 0];
    };
    for (let at = all.indexOf(t); at !== -1; at = all.indexOf(t, at + 1)) {
      const [sn, so] = locate(at, false);
      const [en, eo] = locate(at + t.length, true);
      const range = document.createRange();
      range.setStart(sn, so);
      range.setEnd(en, eo);
      // The glyphs' own boxes, node by node: a range across elements also reports the elements' border boxes.
      const glyphs = nodes.filter((x) => x.n === sn || x.n === en || (range.intersectsNode(x.n) && x.from > at && x.from < at + t.length)).flatMap((x) => {
        const piece = document.createRange();
        piece.setStart(x.n, x.n === sn ? so : 0);
        piece.setEnd(x.n, x.n === en ? eo : (x.n.textContent ?? "").length);
        return [...piece.getClientRects()];
      });
      if (glyphs.every((x) => x.width === 0)) continue; // the other breakpoint's copy (display:none)
      const box = range.getBoundingClientRect();
      out.measured++;
      if (new Set(glyphs.filter((x) => x.width > 0).map((x) => Math.round(x.top))).size > 1) out.broken++;
      let holder = sn.parentElement!;
      if (holder.getAttribute("role") === "img") holder = holder.parentElement!;
      const lead = holder.previousElementSibling;
      const before = document.createRange();
      before.setStart(holder, 0);
      before.setEnd(sn, so);
      if (before.toString().trim() === "" && lead !== null) {
        const gap = box.left - lead.getBoundingClientRect().right;
        if (gap < 2) out.glued.push(Math.round(gap * 10) / 10);
      }
      out.crowded ||= holder.scrollWidth > holder.clientWidth + 1 || (lead !== null && lead.scrollWidth > lead.clientWidth + 1);
      for (let el: HTMLElement | null = holder; el !== null && el !== rowEl.parentElement; el = el.parentElement) {
        if (getComputedStyle(el).overflowX === "visible") continue;
        const b = el.getBoundingClientRect();
        if (box.left < b.left - 0.5 || box.right > b.right + 0.5) {
          out.clipped.push(`<${el.tagName.toLowerCase()} class="${el.className}"> [${Math.round(box.left)}–${Math.round(box.right)}] outside [${Math.round(b.left)}–${Math.round(b.right)}]`);
        }
      }
    }
    return out;
  }, tail);
}

async function shot(target: Locator, name: string) {
  const dir = process.env.LOOPH_SHOTS;
  if (dir) await target.screenshot({ path: `${dir}/${name}.png` });
}

/** The F1/F2 rig: a league whose cfg awards an abandon to the side leading (W2b D8), its rows settled by walkover,
 *  retirement, disqualification and abandon; and a knockout semi walked over by both. Each row: what the run sheet
 *  and the console must say, and the tail that must never truncate. */
async function organiserResultRows(request: APIRequestContext) {
  expect(LONG_NAMES.map((n) => n.length), "premise: every name is 43 characters").toEqual(LONG_NAMES.map(() => 43));

  // A league whose cfg awards an abandon to the side leading (W2b D8), so an abandon leaves a winner and a tag.
  const lg = await longNameDivision(request, "league", LONG_NAMES, { abandonPolicy: "award" });
  expect(lg.seated.length, "four seated league fixtures to settle").toBeGreaterThanOrEqual(4);
  const [fW, fR, fD, fA] = lg.seated as [Fx, Fx, Fx, Fx];
  await post(request, fW.id, "core.forfeit", { by: fW.away_entrant_id, reason: "walkover" });
  for (const f of [fR, fD, fA]) await post(request, f.id, "core.start");
  for (const f of [fR, fA]) await post(request, f.id, "football.goal", { by: f.home_entrant_id });
  await post(request, fR.id, "core.forfeit", { by: fR.away_entrant_id, reason: "retired" });
  await post(request, fD.id, "core.forfeit", { by: fD.away_entrant_id, reason: "disqualified" });
  await post(request, fA.id, "core.abandon", { reason: "rain" });
  const settled = await Promise.all([fW, fR, fD, fA].map((f) => read(request, f.id)));
  expect(settled.map((f) => [f.outcome?.kind, f.outcome?.winner]), "each settled for its home side").toEqual(
    [fW, fR, fD, fA].map((f, i) => [i === 3 ? "win" : "award", f.home_entrant_id]),
  );

  // A knockout semi walked over by BOTH sides (X-DW-1: it feeds a final, so the double walkover is admitted).
  const ko = await longNameDivision(request, "knockout", LONG_NAMES.slice(0, 4));
  const dw = ko.seated[0]!;
  await post(request, dw.id, "core.forfeit", { by: "both", reason: "walkover" });
  expect((await read(request, dw.id)).outcome, "a double walkover").toEqual({ kind: "double_walkover" });

  // `fullKey` (design audit 4.3): the expansion each tag owes as its accessible name and tooltip, named here by key.
  const rows = [
    { name: "walkover", div: lg.divId, f: fW, tagKey: "forfeit.tag.walkover", fullKey: "forfeit.tagFull.walkover", winner: lg.nameOf.get(fW.home_entrant_id!)! },
    { name: "retired", div: lg.divId, f: fR, tagKey: "forfeit.tag.retired", fullKey: "forfeit.tagFull.retired", winner: lg.nameOf.get(fR.home_entrant_id!)! },
    { name: "disqualified", div: lg.divId, f: fD, tagKey: "forfeit.tag.disqualified", fullKey: "forfeit.tagFull.disqualified", winner: lg.nameOf.get(fD.home_entrant_id!)! },
    { name: "abandoned", div: lg.divId, f: fA, tagKey: "forfeit.tag.abandoned", fullKey: "forfeit.tagFull.abandoned", winner: lg.nameOf.get(fA.home_entrant_id!)! },
    { name: "double-walkover", div: ko.divId, f: dw, tagKey: "forfeit.tag.doubleWalkover", fullKey: "forfeit.tagFull.doubleWalkover", winner: null },
  ];
  const lineOf = (r: (typeof rows)[number]) => (r.winner === null ? ui(r.tagKey) : wonTagged(r.winner, r.tagKey));
  const tailOf = (r: (typeof rows)[number]) => (r.winner === null ? ui(r.tagKey) : wonTaggedTail(r.tagKey));
  const sheets = new Map([[lg.divId, await divisionPath(request, lg.divId, "?tab=fixtures")], [ko.divId, await divisionPath(request, ko.divId, "?tab=fixtures")]]);
  return { rows, lineOf, tailOf, sheets, lg, ko };
}

test.describe("W2b loop H F1 — the run sheet keeps the result's tag whole", () => {
  test("w/o, ret., DQ, Aband. and 2× w/o with 43-character names: the tail is never clipped at 1280/768/320", async ({ page, request }) => {
    test.setTimeout(6 * 60_000);
    await activeOrg(page);
    const { rows, lineOf, tailOf, sheets, lg, ko } = await organiserResultRows(request);
    let measured = 0;
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      for (const divId of [lg.divId, ko.divId]) {
        await page.goto(sheets.get(divId)!);
        await dismissCookieBanner(page);
        for (const r of rows.filter((x) => x.div === divId)) {
          const row = page.getByTestId("run-sheet").locator(`li[data-fixture-no="${r.f.fixture_no}"]`);
          await expect(row, `${width} ${r.name}: the run-sheet row`).toBeVisible({ timeout: STEP_MS });
          await expect(row, `${width} ${r.name}: the run sheet's words, tag and all`).toContainText(lineOf(r));
          const m = await measureTail(row, tailOf(r));
          console.log(`loop H F1 ${width} ${r.name}: ${(await row.innerText()).replace(/\s+/g, " ").trim()} :: ${JSON.stringify(m)}`);
          expect(m.measured, `${width} ${r.name}: the tail "${tailOf(r)}" is rendered once at this width`).toBe(1);
          expect(m.clipped, `${width} ${r.name}: the tail is never clipped`).toEqual([]);
          expect(m.broken, `${width} ${r.name}: the tail sits on one line`).toBe(0);
          expect(m.glued, `${width} ${r.name}: a space separates the tail from what precedes it (px)`).toEqual([]);
          // At 320 a 43-character name cannot fit beside the tag: the name is what gave way (the precondition).
          if (width === 320 && r.winner !== null) expect(m.crowded, `${width} ${r.name}: the line really was short of room`).toBe(true);
          // Design audit 4.3: the tag is a symbol named in full — one visible copy at this width, its tooltip the same words.
          const symbol = row.getByRole("img", { name: ui(r.fullKey), exact: true });
          await expect(symbol, `${width} ${r.name}: the tag named "${ui(r.fullKey)}"`).toHaveCount(1);
          await expect(symbol, `${width} ${r.name}: showing the tag`).toHaveText(ui(r.tagKey));
          await expect(symbol, `${width} ${r.name}: its tooltip the expansion`).toHaveAttribute("title", ui(r.fullKey));
          await shot(row, `f1-run-sheet-${r.name}-${width}`);
          measured++;
        }
        await expectNoHorizontalScroll(page);
      }
    }
    expect(measured, "rows measured").toBe(WIDTHS.length * rows.length);
  });
});

// F2 (loop H) — the fixture console's decided line said "Bears of Brockley won" beside the run sheet's "won (w/o)": it now
// says what the run sheet says, tag and all, over the same rig.
test.describe("W2b loop H F2 — the fixture console names a credited result as the run sheet does", () => {
  test("w/o, ret., DQ, Aband. and 2× w/o: the console's decided line is the run sheet's words at 1280/768/320", async ({ page, request }) => {
    test.setTimeout(6 * 60_000);
    await activeOrg(page);
    const { rows, lineOf } = await organiserResultRows(request);
    let consoles = 0;
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      for (const r of rows) {
        await page.goto(await divisionPath(request, r.div, `/f/${r.f.fixture_no}`));
        await dismissCookieBanner(page);
        const line = page.getByTestId("console-decided-line");
        await expect(line, `${width} ${r.name}: the console's decided line`).toHaveText(lineOf(r), { timeout: STEP_MS });
        await expect(line.getByRole("img", { name: ui(r.fullKey), exact: true }), `${width} ${r.name}: its tag named in full (audit 4.3)`).toHaveText(ui(r.tagKey));
        await expectNoHorizontalScroll(page);
        await shot(page.locator("header.card").first(), `f2-console-${r.name}-${width}`);
        consoles++;
      }
    }
    expect(consoles, "consoles read").toBe(WIDTHS.length * rows.length);
  });
});

// F4 (loop H) — the hub's results card said "Ended" over a final abandoned for replay (no outcome, the "Aband." tag
// below it). Its status slot reads the same reader as its tag: an abandon that left no winner reads "Abandoned".
test.describe("W2b loop H F4 — the hub's results card does not call a final abandoned for replay Ended", () => {
  test("the abandoned final's card reads Abandoned with its Aband. tag; a walked-over semi's reads Ended, at 1280/768/320", async ({ page, request }) => {
    test.setTimeout(5 * 60_000);
    const org = await activeOrg(page);
    const ko = await publicKnockout(request);
    for (const sf of ko.semis) await post(request, sf.id, "core.forfeit", { by: sf.away_entrant_id, reason: "walkover" });
    await expect.poll(async () => { const f = await read(request, ko.final.id); return Boolean(f.home_entrant_id && f.away_entrant_id); }, { timeout: STEP_MS }).toBe(true);
    const final = await read(request, ko.final.id);
    await post(request, final.id, "core.start");
    await post(request, final.id, "football.goal", { by: final.home_entrant_id });
    await post(request, final.id, "core.abandon", { reason: "rain" });
    const after = await read(request, final.id);
    // Football's declared default is a replay (football.ts `abandonPolicy`): nobody is decided.
    expect([after.status, after.outcome], "abandoned for replay").toEqual(["abandoned", null]);
    const [ENDED, ABANDONED] = [say("matchesHub.ended"), say("matchCentre.status.abandoned")];
    const sentence = say("forfeit.sentence.abandonedBare", { reason: "rain" });
    const base = `/shared/${org.slug}/${ko.compSlug}`;

    let screens = 0;
    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w, height: 900 });
      await hubResults(page, `${base}?tab=matches`);
      const card = page.getByTestId(`mh-match-${final.id}`);
      await expect(card).toBeVisible({ timeout: STEP_MS });
      const state = card.locator("span.ml-auto.shrink-0").first();
      await expect(state, `${w}: the final's status slot`).toHaveText(ABANDONED);
      await expect(card.getByRole("img", { name: sentence }), `${w}: its tag, named by the sentence`).toHaveText(say("forfeit.tag.abandoned"));
      // The pair: a semi walked over ENDED, and still says so.
      const semi = page.getByTestId(`mh-match-${ko.semis[0]!.id}`);
      await expect(semi.locator("span.ml-auto.shrink-0").first(), `${w}: a walked-over semi's slot`).toHaveText(ENDED);
      await expectNoHorizontalScroll(page);
      await shot(card, `f4-results-card-abandoned-${w}`);
      screens++;
    }
    expect(screens).toBe(WIDTHS.length);
  });
});

// Design audit 3.8 — the hub's results card at 320 is 264px of box. An abandon awarded to the side leading (W2b D8,
// `abandonPolicy: "award"`) reads "{winner} won" beside its "Aband." tag; with a realistic 43-character name that
// sentence is wider than the card, and the slot was `shrink-0`, so it painted past the card's edge. Measured as geometry:
// the sentence wraps inside the card, the tag sits wholly inside it on one line, and the page never scrolls sideways.
test.describe("design audit 3.8 — a long result wraps inside the hub card", () => {
  test("an awarded abandon's '{43-character name} won' beside Aband. stays inside its card at 1280/768/320", async ({ page, request }) => {
    test.setTimeout(3 * 60_000);
    const org = await activeOrg(page);
    expect(LONG_NAMES[0]!.length, "premise: a realistic 43-character name").toBe(43);
    const lg = await longNameDivision(request, "league", LONG_NAMES.slice(0, 4), { abandonPolicy: "award" });
    const f = lg.seated[0]!;
    await post(request, f.id, "core.start");
    await post(request, f.id, "football.goal", { by: f.home_entrant_id });
    await post(request, f.id, "core.abandon", { reason: "rain" });
    expect((await read(request, f.id)).outcome, "awarded to the side leading").toMatchObject({ kind: "win", winner: f.home_entrant_id });
    const winner = lg.nameOf.get(f.home_entrant_id!)!;
    const tag = say("forfeit.tag.abandoned");
    let measured = 0;
    let wrapped = 0;
    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w, height: 900 });
      await hubResults(page, `/shared/${org.slug}/${lg.compSlug}?tab=matches`);
      const card = page.getByTestId(`mh-match-${f.id}`);
      await expect(card).toBeVisible({ timeout: STEP_MS });
      const slot = card.getByTestId("mh-match-forfeit");
      await expect(slot, `${w}: the result names the winner`).toContainText(winner);
      await expect(card.getByTestId("mh-match-forfeit-tag"), `${w}: the abandon tag`).toHaveText(tag);
      const g = await card.evaluate((el) => {
        const c = el.getBoundingClientRect();
        const s = el.querySelector('[data-testid="mh-match-forfeit"]')!.getBoundingClientRect();
        const chip = el.querySelector('[data-testid="mh-match-forfeit-tag"]')!;
        const t = chip.getBoundingClientRect();
        const lines = new Set([...chip.getClientRects()].map((r) => Math.round(r.top))).size;
        const sentence = el.querySelector('[data-testid="mh-match-forfeit"] > span:first-child')!;
        const sentenceLines = new Set(
          [...(() => { const r = document.createRange(); r.selectNodeContents(sentence); return r.getClientRects(); })()].filter((x) => x.width > 0).map((x) => Math.round(x.top)),
        ).size;
        return { card: [Math.round(c.left), Math.round(c.right)], slot: [Math.round(s.left), Math.round(s.right)], tag: [Math.round(t.left), Math.round(t.right)], tagLines: lines, sentenceLines };
      });
      console.log(`audit 3.8 ${w}: ${JSON.stringify(g)}`);
      expect(g.slot[1], `${w}: the result slot ends inside the card`).toBeLessThanOrEqual(g.card[1]);
      expect(g.tag[1], `${w}: the tag ends inside the card`).toBeLessThanOrEqual(g.card[1]);
      expect(g.tagLines, `${w}: the tag on one line`).toBe(1);
      if (g.sentenceLines > 1) wrapped++;
      await expectNoHorizontalScroll(page);
      await crop(card, `audit-3-8-hub-card-long-result-${w}`);
      measured++;
    }
    expect(measured).toBe(WIDTHS.length);
    // The precondition that makes the 320 pass mean something: the sentence really was too wide, and wrapped there.
    expect(wrapped, "the long result wrapped at the narrow width at least").toBeGreaterThanOrEqual(1);
  });
});

// W2c Task 16b (X-WO-1 B, Task 9 P-3 "A") — a pool whose points rule awards a walkover score shows ONE number: the
// match centre, the results list and the stage's own format line all say the RULE's award, where the same walkover read
// the division's `awardScore.goals` on the first two until this task. The rule's winner figure is the division's plus 4
// and the side that did not turn up is 1, so a surface still reading the division's number fails on BOTH figures. Whole
// file, never a -g slice; the crops land in `T16B_SHOTS` when it is set (never committed).
const AWARD: [number, number] = [CREDIT + 4, 1];
async function cropB(target: Locator, name: string) {
  const dir = process.env.T16B_SHOTS;
  if (dir) await target.screenshot({ path: `${dir}/${name}.png` });
}

/** A public, started four-team football pool whose stage points rule awards a walkover `AWARD`. */
async function publicPoolWithAward(r: APIRequestContext) {
  const comp = await apiJson<{ id: string; slug: string }>(r, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `W2c walkover award ${TAG}-${Math.random().toString(36).slice(2, 6)}`,
    visibility: "public",
  });
  expect(comp.status, JSON.stringify(comp.error)).toBe(201);
  const div = await apiJson<{ id: string; slug: string }>(r, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Pool", sport_key: SPORT, variant_key: VARIANT,
  });
  expect(div.status, JSON.stringify(div.error)).toBe(201);
  const names = ["Riverside Athletic FC", "Harbour United Reserves", "Bears of Brockley", "Catford Wanderers"];
  const added = await addEntrantsViaApi(r, div.data!.id, names, "team");
  expect(added.ids).toHaveLength(names.length);
  const stage = await apiJson<{ id: string }>(r, `/api/v1/divisions/${div.data!.id}/stages`, "POST", { seq: 1, kind: "league", name: "Pool" });
  expect(stage.status, JSON.stringify(stage.error)).toBe(201);
  const put = await apiJson(r, `/api/v1/stages/${stage.data!.id}/rules`, "PUT", {
    points: { base: { win: 3, draw: 1, loss: 0 }, bonuses: [], forfeit: { winnerPoints: 3, loserPoints: 0, awardScore: AWARD } },
  });
  expect(put.status, JSON.stringify(put.error)).toBe(200);
  const gen = await apiJson<{ fixtures: { id: string }[] }>(r, `/api/v1/stages/${stage.data!.id}/generate`, "POST");
  const started = await apiJson(r, `/api/v1/divisions/${div.data!.id}/start`, "POST");
  expect(started.status, JSON.stringify(started.error)).toBeLessThan(300);
  const fixtures = await Promise.all((gen.data?.fixtures ?? []).map((f) => read(r, f.id)));
  expect(fixtures.length, "a four-team pool has six fixtures").toBe(6);
  const nameOf = new Map(added.ids.map((id, i) => [id, names[i]!]));
  return { divId: div.data!.id, stageId: stage.data!.id, compSlug: comp.data!.slug, divSlug: div.data!.slug, fixtures, nameOf };
}

test.describe("W2c Task 16b — a walkover under a stage points rule reads the rule's number everywhere", () => {
  test("X-WO-1 B: the match centre, the results card and the stage's format line say the award, at 1280/768/320", async ({ page, request }) => {
    test.setTimeout(4 * 60_000);
    expect(AWARD[0], "the premise: the rule's winner figure is not the division's").not.toBe(CREDIT);
    const org = await activeOrg(page);
    const pool = await publicPoolWithAward(request);
    const fx = pool.fixtures[0]!;
    const loser = fx.away_entrant_id!;
    await post(request, fx.id, "core.forfeit", { by: loser, reason: "walkover" });
    expect((await read(request, fx.id)).outcome).toEqual({ kind: "award", winner: fx.home_entrant_id, loser, reason: "walkover" });
    const base = `/shared/${org.slug}/${pool.compSlug}`;
    const clause = say("format.points.forfeitScore", { winner: String(AWARD[0]), loser: String(AWARD[1]) });
    expect(clause, "the clause carries the rule's two figures in the en copy").toContain(`${AWARD[0]}‑${AWARD[1]}`);

    let screens = 0;
    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w, height: 900 });

      // The match centre: the credited score is the rule's, the home side (who turned up) first.
      await page.goto(`${base}/${pool.divSlug}/fixtures/${fx.id}`);
      await dismissCookieBanner(page);
      await expect(page.getByTestId("mc-score-0"), `${w}: the winner's figure`).toHaveText(String(AWARD[0]), { timeout: STEP_MS });
      await expect(page.getByTestId("mc-score-1"), `${w}: the side that did not turn up`).toHaveText(String(AWARD[1]));
      await expectNoHorizontalScroll(page);
      await cropB(page.locator("main"), `match-centre-rule-award-${w}`);
      screens++;

      // The results list: the card's two score figures are the rule's.
      await hubResults(page, `${base}?tab=matches`);
      const card = page.getByTestId(`mh-match-${fx.id}`);
      await expect(card).toBeVisible({ timeout: STEP_MS });
      const figures = card.locator("span.tabular-nums");
      await expect(figures, `${w}: two score figures on the card`).toHaveCount(2);
      await expect(figures.nth(0), `${w}: the card's winner figure`).toHaveText(String(AWARD[0]));
      await expect(figures.nth(1), `${w}: the card's other figure`).toHaveText(String(AWARD[1]));
      await expectNoHorizontalScroll(page);
      await cropB(card, `results-list-rule-award-${w}`);
      screens++;

      // The division page: the stage's own format line says the clause, in the stage chip.
      await page.goto(`${base}/${pool.divSlug}`);
      await dismissCookieBanner(page);
      const chip = page.getByTestId("division-stage-format");
      await expect(chip, `${w}: the stage's format line says the walkover score`).toContainText(clause, { timeout: STEP_MS });
      await expect(chip).toBeVisible();
      await expectNoHorizontalScroll(page);
      await cropB(chip.locator("xpath=ancestor::*[self::li or self::section or self::div][1]"), `stage-format-line-rule-award-${w}`);
      screens++;
    }
    expect(screens).toBe(WIDTHS.length * 3);

    // The table credits what the headline says: the winner's goals for are the rule's winner figure, once.
    await expect
      .poll(async () => {
        const st = await apiJson<{ rows: { entrantId: string; metrics: Record<string, number> }[] }>(request, `/api/v1/stages/${pool.stageId}/standings`);
        const row = (st.data?.rows ?? []).find((x) => x.entrantId === fx.home_entrant_id);
        return row ? [row.metrics.gf, row.metrics.ga] : null;
      }, { timeout: 30_000 })
      .toEqual(AWARD);
  });
});
