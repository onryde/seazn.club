import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { builtinModules } from "@seazn/engine/sports";
import { TAG, activeOrg, addEntrantsViaApi, apiJson, createStageAndGenerate, expectNoHorizontalScroll } from "./helpers";
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
  return { compSlug: comp.data!.slug, divSlug: div.data!.slug, semis, final: final!, nameOf };
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

    // Review (b) — the champion banner: a final won by walkover carries the final's tag beside its line, named by the
    // final's own sentence. The other semi and then the final are walked over (the final's seats come from the cascade).
    const other = ko.semis[1]!;
    await post(request, other.id, "core.forfeit", { by: other.away_entrant_id, reason: "walkover" });
    await expect
      .poll(async () => { const f = await read(request, ko.final.id); return f.home_entrant_id !== null && f.away_entrant_id !== null; }, { timeout: STEP_MS })
      .toBe(true);
    const seated = await read(request, ko.final.id);
    await post(request, ko.final.id, "core.forfeit", { by: seated.away_entrant_id, reason: "walkover" });
    expect((await read(request, ko.final.id)).outcome).toMatchObject({ kind: "award", winner: seated.home_entrant_id, reason: "walkover" });
    const finalSentence = say("forfeit.sentence.walkover", { loser: ko.nameOf.get(seated.away_entrant_id!)! });
    let banners = 0;
    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.goto(`${base}?tab=knockout`);
      await dismissCookieBanner(page);
      const bannerTag = page.getByTestId("mh-knockout-champion-forfeit");
      await expect(bannerTag, `${w}: the champion banner's tag`).toHaveText(tag, { timeout: STEP_MS });
      await expect(bannerTag).toHaveAttribute("aria-label", finalSentence);
      await expect(bannerTag).toHaveCount(1);
      await expectNoHorizontalScroll(page);
      await crop(bannerTag.locator("xpath=ancestor::div[starts-with(@data-testid, 'mh-knockout-champion-')][1]"), `champion-banner-walkover-${w}`);
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
      await expectNoHorizontalScroll(page);
      await crop(page.locator("main"), `match-centre-double-walkover-${w}`);
      screens++;

      await page.goto(`${base}?tab=standings`);
      await dismissCookieBanner(page);
      const tileTag = page.getByRole("img", { name: withNext });
      await expect(tileTag, `${w}: the tile's tag is named by the sentence`).toHaveText(dwTag);
      await expect(tileTag).toHaveCount(1);
      await expectNoHorizontalScroll(page);
      await crop(tileTag.locator("xpath=ancestor::a[1]"), `bracket-tile-double-walkover-${w}`);
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
    expect(screens).toBe(WIDTHS.length * 3);
  });

  // Owner ruling 116 and R116-1 (W2b Task 16): a semi-final winner withdraws while the final's other seat is TBD, so her
  // final seat dies; the other semi's winner then arrives and walks over HER. The final reads as a walkover — her name
  // in her seat, the w/o tag named by "<her> withdrew — walkover." — and never the bye word, which before this read
  // beside the tag. The probe's positive pair is the SAME locator on the SAME page before the arrival, where her dead
  // seat still reads the bye word (a probe that cannot see "Bye" would pass the absence vacuously).
  test("ruling 116 / R116-1: a withdrawn winner's walked-over final names her with w/o on every surface, never Bye, at 1280/768/320", async ({ page, request }) => {
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
      await expectNoHorizontalScroll(page);
      await crop(koCard(), `knockout-card-withdrew-final-${w}`);
      screens++;
    }
    expect(screens).toBe(WIDTHS.length * 5);
  });
});
