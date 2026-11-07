import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { TAG, activeOrg, addEntrantsViaApi, apiJson, createStageAndGenerate, divisionPath, expectNoHorizontalScroll, openBracket } from "./helpers";
import { dismissCookieBanner } from "./scorepad-a11y-kit";

// W4 app A — the public bracket lane (batch B6b, Tasks 22 + 23). Whole file, never a -g slice (AGENTS.md rule 21).
//
// N-1 (Task 22): a tile's result line sat ABSOLUTELY over its top name, so at 320 a tap aimed at a long name landed on
// the score; and a finished bye's empty seat printed "TBD". `apps/web` vitest has no layout, so the hit area is proven
// here, in a browser, with `elementFromPoint` — what a finger actually reaches, not what a box paints.
//
// ST-G7 (Task 23): the embed's standings widget drew a FINISHED knockout's placement snapshot as an all-zero table on a
// club's website; it now draws the knockout as its bracket. Driven through the real producer (the API scores every match
// and completes the stage), read as a stranger's iframe would.
//
// Crops land in `B6B_SHOTS` when it is set (never committed).

const UI = JSON.parse(readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8")) as Record<string, string>;
const word = (dict: Record<string, string>, key: string) => {
  expect(dict[key], `the en dictionary has ${key}`).toBeTruthy();
  return dict[key]!;
};

const STEP_MS = 20_000;
const WIDTHS = [1280, 768, 320] as const;
/** A realistic 43-character entrant name — the length that exposes the 320 overflow class (AGENTS.md, truncate). */
const LONG = "Harbourside Shuttlers Badminton Club Ladies";

interface Fx {
  id: string;
  fixture_no: number;
  round_no: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
}
const read = async (r: APIRequestContext, id: string) => (await apiJson<Fx>(r, `/api/v1/fixtures/${id}`)).data!;
const tip = async (r: APIRequestContext, id: string) => (await apiJson<{ last_seq: number }>(r, `/api/v1/fixtures/${id}/state`)).data!.last_seq;
async function post(r: APIRequestContext, id: string, type: string, payload: unknown = {}) {
  const res = await apiJson(r, `/api/v1/fixtures/${id}/events`, "POST", { expected_seq: await tip(r, id), type, payload });
  expect(res.status, `${type}: ${JSON.stringify(res.error)}`).toBeLessThan(300);
}

async function crop(target: Locator | Page, name: string) {
  const dir = process.env.B6B_SHOTS;
  if (dir) await target.screenshot({ path: `${dir}/${name}.png`, ...("goto" in target ? { fullPage: true } : {}) });
}

/** A public, started knockout; returns its stage, fixtures and slugs. */
async function publicKnockout(
  r: APIRequestContext,
  sport: { key: string; variant: string },
  names: string[],
  label: string,
  kind: "individual" | "team",
) {
  const comp = await apiJson<{ id: string; slug: string }>(r, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `W4 ${label} ${TAG}-${Math.random().toString(36).slice(2, 6)}`,
    visibility: "public",
  });
  expect(comp.status, JSON.stringify(comp.error)).toBe(201);
  const div = await apiJson<{ id: string; slug: string }>(r, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Cup", sport_key: sport.key, variant_key: sport.variant,
  });
  expect(div.status, JSON.stringify(div.error)).toBe(201);
  const added = await addEntrantsViaApi(r, div.data!.id, names, kind);
  expect(added.ids, `entrants: HTTP ${added.status}`).toHaveLength(names.length);
  const { stageId, fixtureIds } = await createStageAndGenerate(r, div.data!.id, { kind: "knockout", name: "Cup" });
  const started = await apiJson(r, `/api/v1/divisions/${div.data!.id}/start`, "POST");
  expect(started.status, JSON.stringify(started.error)).toBeLessThan(300);
  const nameOf = new Map(added.ids.map((id, i) => [id, names[i]!]));
  return { divId: div.data!.id, compSlug: comp.data!.slug, divSlug: div.data!.slug, stageId, fixtureIds, nameOf };
}

test.describe("N-1 a bracket tile keeps its result off the names, and a finished bye reads no TBD (Task 22)", () => {
  test("console tile at 320: a tap on the 43-character name lands on the name, never on the score line", async ({ page, request }) => {
    test.setTimeout(4 * 60_000);
    expect(LONG).toHaveLength(43);
    // Three entrants: seed 1 takes the bye; seed 2 (the long name) plays seed 3. Badminton on purpose: its racquet
    // scoreline ("2 — 1 · 21–15, 18–21, 21–19") is the longest headline a tile carries — the one N-1 reported.
    const ko = await publicKnockout(request, { key: "badminton", variant: "bwf" }, ["Riverside Smashers", LONG, "Catford Feathers"], "N-1", "individual");
    const all = await Promise.all(ko.fixtureIds.map((id) => read(request, id)));
    const played = all.find((f) => f.home_entrant_id && f.away_entrant_id && [f.home_entrant_id, f.away_entrant_id].some((e) => ko.nameOf.get(e) === LONG));
    expect(played, "the long name's first-round match is seated").toBeTruthy();
    await post(request, played!.id, "core.start");
    for (const [home, away] of [[21, 15], [18, 21], [21, 19]] as const) await post(request, played!.id, "badminton.game.summary", { home, away });
    expect((await read(request, played!.id)).status, "the match is decided").toMatch(/decided|finalized/);

    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto(await divisionPath(request, ko.divId, "?tab=fixtures"));
    await dismissCookieBanner(page);
    const panel = await openBracket(page, ko.stageId);
    const tile = panel.locator(`a[href$="/f/${played!.fixture_no}"]`);
    await expect(tile).toBeVisible({ timeout: STEP_MS });
    const headline = tile.getByTestId("bracket-tile-headline");
    await expect(headline, "the decided tile carries its result line").toBeVisible();
    const name = tile.getByText(LONG, { exact: true });
    await name.scrollIntoViewIfNeeded();
    const [n, h] = [await name.boundingBox(), await headline.boundingBox()];
    expect(n && h, "both the name and the result line are laid out").toBeTruthy();
    // The result line is its own row, below both names — never painted over the top name.
    expect(h!.y, `the result line starts below the name (${JSON.stringify({ n, h })})`).toBeGreaterThanOrEqual(n!.y + n!.height - 0.5);
    // What a finger reaches: the topmost element at the centre of the name's VISIBLE part (it truncates inside the
    // tile) is the name, or inside it.
    const t = (await tile.boundingBox())!;
    const cx = (Math.max(n!.x, t.x) + Math.min(n!.x + n!.width, t.x + t.width)) / 2;
    const cy = n!.y + n!.height / 2;
    const hit = await name.evaluate(
      (nameEl, [x, y]) => {
        const el = document.elementFromPoint(x, y);
        // The name node itself or a node inside it — never the tile around it, nor the result line.
        return { inName: !!el && nameEl.contains(el), inHeadline: !!el?.closest('[data-testid="bracket-tile-headline"]') };
      },
      [cx, cy] as const,
    );
    expect(hit, "the tap lands on the name, not the score").toEqual({ inName: true, inHeadline: false });
    await crop(tile, "n1-console-tile-320");

    // The bye: its empty seat reads the bye's word on the public bracket, never "TBD".
    const org = await activeOrg(page);
    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.goto(`/live/${org.slug}/${ko.compSlug}/${ko.divSlug}?tab=standings`);
      await dismissCookieBanner(page);
      const bye = all.find((f) => f.round_no === Math.min(...all.map((x) => x.round_no)) && (!f.home_entrant_id || !f.away_entrant_id));
      expect(bye, "the draw holds a first-round bye").toBeTruthy();
      // Inside the bracket: the schedule tab carries the same link in a row that is hidden behind its tab.
      const card = page.locator(`[data-bracket] a[href$="/fixtures/${bye!.id}"]`).first();
      await expect(card, `${w}: the bye's card`).toBeVisible({ timeout: STEP_MS });
      await expect(card, `${w}: the bye reads its own word`).toContainText(word(UI, "bracket.slot.bye"));
      await expect(card, `${w}: never "to be decided"`).not.toContainText(word(UI, "bracket.tbd"));
      await expectNoHorizontalScroll(page);
      await crop(card, `n1-public-bye-${w}`);
    }
  });
});

test.describe("ST-G7 the embed shows a finished bracket as a bracket", () => {
  test("a finished knockout: the embed's standings widget draws its bracket and no table, at 1280/768/320; /present the same", async ({ page, request }) => {
    test.setTimeout(4 * 60_000);
    const org = await activeOrg(page);
    // The long name is seed 1, so it wins through as the champion (every home side wins 2–1): the share card prints it.
    const names = [LONG, "Riverside Athletic FC", "Harbour United Reserves", "Bears of Brockley"];
    const ko = await publicKnockout(request, { key: "generic", variant: "score" }, names, "ST-G7", "team");
    // Score every match, round by round, then complete the stage — the write that stores its placement snapshot.
    for (let round = 0; round < 4; round++) {
      const open = (await Promise.all(ko.fixtureIds.map((id) => read(request, id)))).filter(
        (f) => f.home_entrant_id && f.away_entrant_id && f.status === "scheduled",
      );
      if (open.length === 0) break;
      for (const f of open) await post(request, f.id, "generic.result", { p1Score: 2, p2Score: 1 });
    }
    const done = await Promise.all(ko.fixtureIds.map((id) => read(request, id)));
    expect(done.every((f) => /decided|finalized/.test(f.status)), "every match is decided").toBe(true);
    const completed = await apiJson(request, `/api/v1/stages/${ko.stageId}/complete`, "POST");
    expect(completed.status, JSON.stringify(completed.error)).toBeLessThan(300);
    const standings = await apiJson<{ rows: unknown[] }>(request, `/api/v1/stages/${ko.stageId}/standings`);
    expect(standings.data?.rows.length, "premise: the finished knockout stored its placement snapshot").toBe(names.length);

    // ST-G26: the division's share card — the image its own page names — draws the champion (a bracket-only division).
    await page.goto(`/live/${org.slug}/${ko.compSlug}/${ko.divSlug}`);
    const ogUrl = await page.locator('meta[property="og:image"]').first().getAttribute("content");
    expect(ogUrl, "the division page names its share image").toBeTruthy();
    // Fetched from THIS server: the meta tag may carry the production origin (`metadataBase`).
    const ogPath = new URL(ogUrl!, page.url());
    const og = await page.request.get(`${ogPath.pathname}${ogPath.search}`);
    expect(og.status(), "the share card renders").toBe(200);
    expect(og.headers()["content-type"]).toContain("image/png");
    if (process.env.B6B_SHOTS) writeFileSync(`${process.env.B6B_SHOTS}/stg26-og-champion.png`, await og.body());

    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.goto(`/embed/divisions/${ko.divId}/standings`);
      // The knockout, drawn as a bracket: its heading and a card per match.
      await expect(page.getByRole("heading", { name: "Cup" }), `${w}: the bracket's heading`).toBeVisible({ timeout: STEP_MS });
      for (const id of ko.fixtureIds) await expect(page.locator(`a[href$="/fixtures/${id}"]`).first(), `${w}: match ${id}`).toBeAttached();
      // ...and never as a table.
      await expect(page.locator("table"), `${w}: no standings table`).toHaveCount(0);
      await expectNoHorizontalScroll(page);
      await crop(page, `stg7-embed-standings-${w}`);
      // The embed's own bracket widget draws the same tree: it fits the frame too (the bleed is off inside /embed).
      await page.goto(`/embed/divisions/${ko.divId}/bracket`);
      await expect(page.locator(`a[href$="/fixtures/${ko.fixtureIds[0]}"]`).first(), `${w}: the bracket widget`).toBeAttached({ timeout: STEP_MS });
      await expectNoHorizontalScroll(page);

      await page.goto(`/live/${org.slug}/${ko.compSlug}/${ko.divSlug}/present`);
      // Mounted first (the masthead clock is set by an effect), as kiosk-phone-card.spec.ts does: below lg the board
      // waits behind its "made for a TV" card, whose Show the board anyway has no handler before hydration.
      await expect(page.locator("header span.tabular-nums"), `${w}: the board mounted`).toBeAttached({ timeout: STEP_MS });
      const showBoard = page.getByTestId("kiosk-phone-card-show-board");
      if (await showBoard.isVisible()) await showBoard.click();
      await expect(page.locator("h2:visible").first(), `${w}: the board shows a slide`).toBeVisible({ timeout: STEP_MS });
      await expectNoHorizontalScroll(page);
      await crop(page, `stg7-present-${w}`);
    }

    // /present rotates its slides in the browser, so the slide LIST is read where the board receives it: its payload.
    // The positive pair first — the probe sees a slide kind at all — then no standings slide for the finished knockout.
    const board = await (await page.request.get(`/live/${org.slug}/${ko.compSlug}/${ko.divSlug}/present`)).text();
    const slidesOf = (kind: string) => board.split(`\\"kind\\":\\"${kind}\\"`).length - 1 + (board.split(`"kind":"${kind}"`).length - 1);
    expect(slidesOf("bracket"), "the knockout's bracket slide is on the board").toBeGreaterThan(0);
    expect(slidesOf("standings"), "and no standings slide").toBe(0);
  });
});
