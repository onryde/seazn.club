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
    }
    expect(screens).toBe(WIDTHS.length * 3);
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
    }
    expect(screens).toBe(WIDTHS.length * 2);
  });
});
