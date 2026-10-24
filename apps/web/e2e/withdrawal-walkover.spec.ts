import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { builtinModules } from "@seazn/engine/sports";
import { TAG, activeOrg, addEntrantsViaApi, apiJson, createStageAndGenerate, divisionPath, expectNoHorizontalScroll } from "./helpers";
import { withDb } from "./rs007-money-kit";
import { dismissCookieBanner } from "./scorepad-a11y-kit";
import { decidersOffRules } from "./stage-deciders";

// W2b Task 8 (spec §5.4, X-WD-1 / C17): an organiser withdraws an entrant whose knockout semi is HELD (a level
// football result, needs_decision). Before W2b the cascade skipped the held line and the bracket waited on a settle
// nobody could give (the withdrawn side cannot be named the winner). Now the line walks over to the remaining side,
// and the final is seated with her opponent.
//
// Written by loop F (Task 8). W2b T13 fix round 1 (review (c)): the run sheet's line reads "{name} won (w/o)" before
// Task 13 and after it, so it witnesses the CASCADE only; Task 13's own witness is the spectator's — the public semi's
// sentence names the side that withdrew, and the results card's tag is named by that sentence. The competition is
// public so the spectator can read it.
//
// The withdrawal is done with the organiser's hands (the entrants tab's Withdraw and its confirmation), the rig over
// the API. Whole file, never a -g slice (AGENTS.md rule 21).

const UI = JSON.parse(readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8")) as Record<string, string>;
const PUBLIC = JSON.parse(readFileSync(fileURLToPath(new URL("../src/dictionaries/en/public.json", import.meta.url)), "utf8")) as Record<string, string>;
const ui = (key: string) => {
  expect(UI[key], `ui.json has ${key}`).toBeTruthy();
  return UI[key]!;
};

/** The en public.json words, placeholders filled. */
const say = (key: string, params: Record<string, string> = {}) => {
  const tpl = PUBLIC[key];
  expect(tpl, `public.json has ${key}`).toBeTruthy();
  return Object.entries(params).reduce((acc, [k, v]) => acc.replaceAll(`{${k}}`, v), tpl!);
};

const STEP_MS = 20_000;

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

/** A four-team 11-a-side football knockout, started, the first semi played 0-0 to full time: held (X-BR-2). */
async function heldSemi(r: APIRequestContext) {
  const sport = "football";
  const variant = "11-a-side";
  expect(Object.keys(builtinModules.find((m) => m.key === sport)?.variants ?? {}), `${sport} declares ${variant}`).toContain(variant);
  const comp = await apiJson<{ id: string; slug: string }>(r, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `W2b withdraw ${TAG}-${Math.random().toString(36).slice(2, 6)}`,
    visibility: "public",
  });
  expect(comp.status, JSON.stringify(comp.error)).toBe(201);
  const div = await apiJson<{ id: string; slug: string }>(r, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", { name: "Cup", sport_key: sport, variant_key: variant });
  expect(div.status, JSON.stringify(div.error)).toBe(201);
  const names = ["W2b Ashford", "W2b Brockley", "W2b Catford", "W2b Deptford"];
  const added = await addEntrantsViaApi(r, div.data!.id, names, "team");
  expect(added.ids).toHaveLength(names.length);
  // Every decider off (W2c X-SR-6: a new knockout starts with extra time and penalties), so 0-0 at full time is held.
  const { fixtureIds } = await createStageAndGenerate(r, div.data!.id, {
    kind: "knockout", name: "Cup", config: { rules: decidersOffRules(sport, variant) },
  });
  const started = await apiJson(r, `/api/v1/divisions/${div.data!.id}/start`, "POST");
  expect(started.status, JSON.stringify(started.error)).toBeLessThan(300);
  const all = await Promise.all(fixtureIds.map((id) => read(r, id)));
  const sf = all.find((f) => f.home_entrant_id && f.away_entrant_id)!;
  expect(sf, "a semi with both teams").toBeTruthy();
  await post(r, sf.id, "core.start");
  await post(r, sf.id, "football.period", { phase: "HT" });
  await post(r, sf.id, "football.period", { phase: "FT" });
  expect((await read(r, sf.id)).status, "the rig must hold the semi").toBe("needs_decision");
  const nameOf = new Map(added.ids.map((id, i) => [id, names[i]!]));
  const finalNo = await withDb(async (sql) => {
    const rows = await sql<{ no: number }[]>`
      select n.fixture_no as no from fixtures f join fixtures n on n.id = f.winner_to_fixture where f.id = ${sf.id}`;
    expect(rows, "the semi feeds a final").toHaveLength(1);
    return rows[0]!.no;
  });
  return { divisionId: div.data!.id, compSlug: comp.data!.slug, divSlug: div.data!.slug, sf, nameOf, finalNo };
}

async function withdrawThroughTheScreen(page: Page, name: string): Promise<void> {
  const row = page.locator("tbody tr").filter({ hasText: name });
  await expect(row, `one entrants row for ${name}`).toHaveCount(1, { timeout: STEP_MS });
  await row.getByTestId("entrant-row-withdraw").click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible({ timeout: STEP_MS });
  await expect(dialog).toContainText(name);
  const go = dialog.getByRole("button", { name: ui("confirm.withdrawEntrant.label"), exact: true });
  await expect(go).toBeEnabled({ timeout: STEP_MS });
  await go.click();
  await expect(dialog).toBeHidden({ timeout: STEP_MS });
  await expect(row.locator("[data-entrant-status]")).toHaveAttribute("data-entrant-status", "withdrawn", { timeout: STEP_MS });
}

test.describe("W2b — a withdrawal walks a held knockout line over (X-WD-1)", () => {
  test("X-WD-1: the organiser withdraws a side of a held semi; the run sheet shows the walkover and the final is seated", async ({ page, request }) => {
    test.setTimeout(4 * 60_000);
    const org = await activeOrg(page);
    const { divisionId, compSlug, divSlug, sf, nameOf, finalNo } = await heldSemi(request);
    const leaving = sf.away_entrant_id!;
    const staying = sf.home_entrant_id!;

    await page.goto(await divisionPath(request, divisionId, "?tab=entrants"));
    await withdrawThroughTheScreen(page, nameOf.get(leaving)!);

    // The server's record: a walkover to the remaining side, reason withdrew (the stored fact the tag reads).
    await expect.poll(async () => (await read(request, sf.id)).status, { timeout: STEP_MS }).toBe("forfeited");
    expect((await read(request, sf.id)).outcome).toEqual({ kind: "award", winner: staying, loser: leaving, reason: "withdrew" });

    await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
    const semi = page.locator(`li[data-fixture-no="${sf.fixture_no}"]`);
    const final = page.locator(`li[data-fixture-no="${finalNo}"]`);
    await expect(semi).toBeVisible({ timeout: STEP_MS });
    // No longer held: the chip and its Settle action are gone (their positive pair is bracket-finish.spec.ts).
    await expect(semi.getByTestId("run-sheet-held-chip")).toHaveCount(0);
    await expect(final, "the final is seated with the remaining side").toContainText(nameOf.get(staying)!);

    const tag = say("forfeit.tag.walkover");
    expect(tag, "UI-2 option A: a withdrawal reads the walkover tag").toBe("w/o");
    expect(UI["forfeit.tag.walkover"], "the organiser and the spectator read one abbreviation").toBe(tag);
    const runSheetLine = ui("schedule.outcome.wonTagged").replace("{name}", nameOf.get(staying)!).replace("{tag}", tag);
    const sentence = say("forfeit.sentence.withdrew", { loser: nameOf.get(leaving)! });
    const base = `/shared/${org.slug}/${compSlug}`;
    let widths = 0;
    for (const w of [1280, 768, 320]) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
      await expect(semi, `${w}: the run sheet's line names the winner, tagged`).toContainText(runSheetLine, { timeout: STEP_MS });
      await expect(final, `${w}: the final names the remaining side`).toContainText(nameOf.get(staying)!);
      await expectNoHorizontalScroll(page);

      // The spectator: the semi's match centre says who withdrew (never "won by forfeit")…
      await page.goto(`${base}/${divSlug}/fixtures/${sf.id}`);
      await dismissCookieBanner(page);
      await expect(page.getByTestId("mc-status-line"), `${w}: the public semi's sentence`).toHaveText(sentence, { timeout: STEP_MS });
      await expectNoHorizontalScroll(page);

      // …and the results card's tag is named by that sentence.
      await page.goto(`${base}?tab=matches`);
      await dismissCookieBanner(page);
      const completed = page.getByTestId("mh-filter-completed");
      await expect(completed).toBeVisible({ timeout: STEP_MS });
      await completed.click();
      const card = page.getByTestId(`mh-match-${sf.id}`);
      await expect(card).toBeVisible({ timeout: STEP_MS });
      await expect(card.getByRole("img", { name: sentence }), `${w}: the hub card's tag`).toHaveText(tag);
      await expectNoHorizontalScroll(page);
      widths++;
    }
    expect(widths).toBe(3);
  });
});
