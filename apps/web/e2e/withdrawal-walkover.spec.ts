import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { builtinModules } from "@seazn/engine/sports";
import { TAG, addEntrantsViaApi, apiJson, createStageAndGenerate, divisionPath, expectNoHorizontalScroll } from "./helpers";
import { withDb } from "./rs007-money-kit";

// W2b Task 8 (spec §5.4, X-WD-1 / C17): an organiser withdraws an entrant whose knockout semi is HELD (a level
// football result, needs_decision). Before W2b the cascade skipped the held line and the bracket waited on a settle
// nobody could give (the withdrawn side cannot be named the winner). Now the line walks over to the remaining side,
// and the final is seated with her opponent.
//
// Written by loop F (Task 8); goes green when Task 13 lands the public walkover tag (UI-2 option A: `w/o`) on the
// run sheet's result line — loop H runs it. Until then the one red is the tag lookup below, by design.
//
// The withdrawal is done with the organiser's hands (the entrants tab's Withdraw and its confirmation), the rig over
// the API. Whole file, never a -g slice (AGENTS.md rule 21).

const UI = JSON.parse(readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8")) as Record<string, string>;
const PUBLIC = JSON.parse(readFileSync(fileURLToPath(new URL("../src/dictionaries/en/public.json", import.meta.url)), "utf8")) as Record<string, string>;
const ui = (key: string) => {
  expect(UI[key], `ui.json has ${key}`).toBeTruthy();
  return UI[key]!;
};

/** UI-2 option A's walkover tag, as the plan rules it (Task 13: "tags `w/o` …"). Read from the dictionaries by VALUE,
 *  so this spec does not guess the key Task 13 names; exactly one key per dictionary is the tag. */
function walkoverTag(): string {
  const hits = [...Object.entries(UI), ...Object.entries(PUBLIC)].filter(([, v]) => v === "w/o");
  expect(hits.length, "Task 13's walkover tag (`w/o`) exists in an en dictionary").toBeGreaterThan(0);
  return hits[0]![1];
}

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
  const comp = await apiJson<{ id: string }>(r, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `W2b withdraw ${TAG}-${Math.random().toString(36).slice(2, 6)}`,
    visibility: "private",
  });
  expect(comp.status, JSON.stringify(comp.error)).toBe(201);
  const div = await apiJson<{ id: string }>(r, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", { name: "Cup", sport_key: sport, variant_key: variant });
  expect(div.status, JSON.stringify(div.error)).toBe(201);
  const names = ["W2b Ashford", "W2b Brockley", "W2b Catford", "W2b Deptford"];
  const added = await addEntrantsViaApi(r, div.data!.id, names, "team");
  expect(added.ids).toHaveLength(names.length);
  const { fixtureIds } = await createStageAndGenerate(r, div.data!.id, { kind: "knockout", name: "Cup" });
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
  return { divisionId: div.data!.id, sf, nameOf, finalNo };
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
    const { divisionId, sf, nameOf, finalNo } = await heldSemi(request);
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

    const tag = walkoverTag();
    let widths = 0;
    for (const w of [1280, 768, 320]) {
      await page.setViewportSize({ width: w, height: 900 });
      await expect(semi, `${w}: the walkover tag is on the semi's row`).toContainText(tag);
      await expect(final, `${w}: the final names the remaining side`).toContainText(nameOf.get(staying)!);
      await expectNoHorizontalScroll(page);
      widths++;
    }
    expect(widths).toBe(3);
  });
});
