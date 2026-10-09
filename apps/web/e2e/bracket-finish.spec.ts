import { test, expect, type APIRequestContext, type Browser, type Locator, type Page } from "@playwright/test";
import { TAG, apiJson, addEntrantsViaApi, createStageAndGenerate, expectNoHorizontalScroll, fixturePath, loginUi, screenshotAtWidths } from "./helpers";
import { withDb } from "./rs007-money-kit";
import { builtinModules } from "@seazn/engine/sports";

// W2a spec §9 (format-matrix W2a, loop H): a bracket always finishes.
//  - the console: a HELD fixture (a level result in a knockout, or an abandon that decided nobody) shows "Needs a
//    decision" to the organiser, whose settle seats the winner; an official scorer sees the hold and none of the
//    organiser-only controls (Task 11);
//  - the pad: generic brackets offer no Draw; the chess tie-break (Task 12).
// Whole file, never a -g slice (AGENTS.md rule 21).

interface Fx {
  id: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
  outcome: { kind: string; winner?: string; method?: string } | null;
}
const read = async (r: APIRequestContext, id: string) => (await apiJson<Fx>(r, `/api/v1/fixtures/${id}`)).data!;
const tip = async (r: APIRequestContext, id: string) => (await apiJson<{ last_seq: number }>(r, `/api/v1/fixtures/${id}/state`)).data!.last_seq;
async function post(r: APIRequestContext, id: string, type: string, payload: unknown = {}) {
  const res = await apiJson(r, `/api/v1/fixtures/${id}/events`, "POST", { expected_seq: await tip(r, id), type, payload });
  expect(res.status, `${type}: ${JSON.stringify(res.error)}`).toBeLessThan(300);
  return res;
}

/** Only for the owner's per-screen verdict capture (R24): element crops into the SDD screenshots dir. Unset in CI. */
const SHOTS = process.env.W2A_SHOTS_DIR;
async function crop(target: Locator | Page, name: string, width: number) {
  if (!SHOTS) return;
  const path = `${SHOTS}/${name}-${width}.png`;
  if ("screenshot" in target && "goto" in target) await (target as Page).screenshot({ path });
  else await (target as Locator).screenshot({ path });
}

async function knockout(r: APIRequestContext, sport: string, variant: string, names = ["W2a Ana", "W2a Ben", "W2a Cy", "W2a Di"]) {
  // Preflight C14: the variant is one the sport declares (module.variants), never a guessed literal.
  expect(Object.keys(builtinModules.find((m) => m.key === sport)?.variants ?? {}), `${sport} declares ${variant}`).toContain(variant);
  const comp = await apiJson<{ id: string }>(r, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `W2a ${sport} ${TAG}-${Math.random().toString(36).slice(2, 6)}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(r, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", { name: "Cup", sport_key: sport, variant_key: variant });
  // A team sport's entrants are teams (`assertRosterFits` refuses an individual football entrant).
  const added = await addEntrantsViaApi(r, div.data!.id, names, sport === "football" ? "team" : "individual");
  expect(added.ids, `entrants for ${sport}`).toHaveLength(names.length);
  const { fixtureIds } = await createStageAndGenerate(r, div.data!.id, { kind: "knockout", name: "Cup" });
  const started = await apiJson(r, `/api/v1/divisions/${div.data!.id}/start`, "POST");
  expect(started.status, `start ${sport}: ${JSON.stringify(started.error)}`).toBeLessThan(300);
  const all = await Promise.all(fixtureIds.map((id) => read(r, id)));
  const sf = all.find((f) => f.home_entrant_id && f.away_entrant_id)!;
  expect(sf, "a drawn semi-final with both entrants").toBeTruthy();
  return { divisionId: div.data!.id, sf };
}

/** Who sits in the fixture a semi's winner feeds — read from the row, not inferred. */
async function seatedInFinal(sfId: string): Promise<(string | null)[]> {
  return withDb(async (sql) => {
    const rows = await sql<{ home: string | null; away: string | null }[]>`
      select n.home_entrant_id as home, n.away_entrant_id as away
        from fixtures f join fixtures n on n.id = f.winner_to_fixture
       where f.id = ${sfId}`;
    expect(rows, "the semi feeds a final").toHaveLength(1);
    return [rows[0]!.home, rows[0]!.away];
  });
}

/** A football 0–0 to full time — no extra time or shootout is configured for 11-a-side, so a knockout HOLDS it
 *  (X-BR-2). The stream is the one `settle-seating.test.ts` pins: `football.period` HT, then FT. */
async function heldFootball(r: APIRequestContext) {
  const { sf, divisionId } = await knockout(r, "football", "11-a-side");
  await post(r, sf.id, "core.start");
  await post(r, sf.id, "football.period", { phase: "HT" });
  await post(r, sf.id, "football.period", { phase: "FT" });
  const held = await read(r, sf.id);
  expect(held.status, "the rig must actually hold the fixture").toBe("needs_decision");
  expect(held.outcome).toEqual({ kind: "draw" });
  return { sf, divisionId };
}

/** Settle POSTs the page itself sends (preflight C23: count requests, not ledger rows a retry could merge). */
function countSettlePosts(page: Page): () => number {
  let n = 0;
  page.on("request", (req) => {
    if (req.method() === "POST" && /\/fixtures\/[^/]+\/events$/.test(new URL(req.url()).pathname) && (req.postData() ?? "").includes('"core.settle"')) n++;
  });
  return () => n;
}

/**
 * An ACCEPTED official scorer for one fixture: an org viewer (not an editor) whose person is the official the fixture
 * names. The suite has no official storage state, so it is minted here — the same rows `acceptedOfficialCovers`
 * (usecases/scorers.ts) reads, and nothing more.
 */
async function officialScorerPage(browser: Browser, fixtureId: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const tag = Math.random().toString(36).slice(2, 8);
  const email = `delivered+w2a-official-${TAG}-${tag}@resend.dev`;
  await withDb(async (sql) => {
    const [u] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified) values (${email}, ${"W2a Official " + tag}, true) returning id`;
    const [o] = await sql<{ org_id: string }[]>`
      select c.org_id from fixtures f join divisions d on d.id = f.division_id join competitions c on c.id = d.competition_id
       where f.id = ${fixtureId}`;
    await sql`insert into org_members (org_id, user_id, role) values (${o!.org_id}, ${u!.id}, 'viewer')`;
    const [p] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name, user_id, lane) values (${o!.org_id}, ${"W2a Official " + tag}, ${u!.id}, 'official') returning id`;
    const [off] = await sql<{ id: string }[]>`
      insert into officials (org_id, display_name, role_keys, person_id)
      values (${o!.org_id}, ${"W2a Official " + tag}, ${sql.json(["scorer"])}, ${p!.id}) returning id`;
    await sql`insert into fixture_officials (org_id, fixture_id, official_id, role_key, response)
              values (${o!.org_id}, ${fixtureId}, ${off!.id}, 'scorer', 'accepted')`;
  });
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await loginUi(page, email);
  await page.request.post("/api/onboarding/complete", { data: {} }).catch(() => undefined);
  return { page, close: () => context.close() };
}

test.describe("W2a — the console settles a held bracket fixture (Task 11)", () => {
  test("X-BR-2 (C18): a level football knockout RESULT is held — the block shows, Finalize does not, and the run sheet says so", async ({ page, request }) => {
    const { sf } = await heldFootball(request);
    const path = await fixturePath(request, sf.id);
    await page.goto(path);
    await expect(page.getByTestId("needs-decision")).toBeVisible();
    await expect(page.getByTestId("settle-open")).toBeVisible();
    await expect(page.getByTestId("score-finalize")).toHaveCount(0); // finding 27
    // Finding 25: the division's run sheet carries the hold and offers Settle, which lands on this console.
    const no = path.split("/f/")[1]!;
    await page.goto(`${path.split("/f/")[0]}?tab=fixtures`);
    const row = page.locator(`li[data-fixture-no="${no}"]`);
    await expect(row.getByTestId("run-sheet-held-chip")).toHaveText("Needs a decision");
    await expect(row.locator("[data-row-action]")).toHaveAttribute("data-row-action", "decide");
    await row.locator('[data-row-action="decide"]').click();
    await expect(page.getByTestId("needs-decision")).toBeVisible();
  });

  test("settle on the console: an ABANDONED football knockout that decided nobody shows the block, and the settle seats the winner", async ({ page, request }) => {
    const { sf } = await knockout(request, "football", "11-a-side");
    await post(request, sf.id, "core.start");
    await post(request, sf.id, "core.abandon", { reason: "floodlights" }); // a level abandon decides nobody (finding 19)
    expect((await read(request, sf.id)).status).toBe("abandoned");
    await page.goto(await fixturePath(request, sf.id));
    const block = page.getByTestId("needs-decision");
    await expect(block).toBeVisible();
    await expect(page.getByTestId("score-finalize")).toHaveCount(0); // finding 27
    await page.getByTestId("settle-open").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId("settle-confirm")).toBeDisabled(); // nothing chosen yet: pin what it OPENS AT
    await dialog.getByTestId(`settle-winner-${sf.away_entrant_id}`).click();
    await expect(page.getByTestId("settle-confirm"), "a winner alone is not enough").toBeDisabled();
    await dialog.getByTestId("settle-method-lot").check();
    await page.getByTestId("settle-confirm").click();
    await expect(block).toHaveCount(0);
    const after = await read(request, sf.id);
    expect(after.status).toBe("decided");
    expect(after.outcome).toMatchObject({ kind: "win", winner: sf.away_entrant_id, method: "settled_lot" });
    await expect.poll(() => seatedInFinal(sf.id)).toContain(sf.away_entrant_id);
  });

  test("Review Focus 2: a double submit of the settle dialog sends one settle", async ({ page, request }) => {
    const { sf } = await knockout(request, "generic", "score");
    await post(request, sf.id, "core.start");
    await post(request, sf.id, "core.abandon", { reason: "rain" });
    const settlePosts = countSettlePosts(page);
    await page.goto(await fixturePath(request, sf.id));
    await page.getByTestId("settle-open").click();
    await page.getByTestId(`settle-winner-${sf.home_entrant_id}`).click();
    await page.getByTestId("settle-method-organiser").check();
    await page.getByTestId("settle-confirm").dblclick();
    await expect(page.getByTestId("needs-decision")).toHaveCount(0);
    expect(settlePosts()).toBe(1); // the page SENT one settle, not "the server kept one"
    const events = (await apiJson<{ type: string }[]>(request, `/api/v1/fixtures/${sf.id}/events`)).data!;
    expect(events.filter((e) => e.type === "core.settle")).toHaveLength(1);
  });

  test("a refused settle closes the dialog, shows its reason, and changes nothing; the remaining entrant then settles (spec §7; ruling C17)", async ({ page, request }) => {
    // Deterministic (preflight C23): the refusal is a real server one that cannot race the live poll — the named
    // winner has withdrawn before the page loads (ruling C17: SETTLE_NOT_APPLICABLE, reason withdrawn).
    const { sf } = await knockout(request, "generic", "score");
    await post(request, sf.id, "core.start");
    await post(request, sf.id, "core.abandon", { reason: "rain" });
    expect((await apiJson(request, `/api/v1/entrants/${sf.away_entrant_id}/withdraw`, "POST")).status).toBeLessThan(300);
    await page.goto(await fixturePath(request, sf.id));
    await page.getByTestId("settle-open").click();
    await page.getByTestId(`settle-winner-${sf.away_entrant_id}`).click();
    await page.getByTestId("settle-method-lot").check();
    await page.getByTestId("settle-confirm").click();
    await expect(page.getByRole("dialog")).toHaveCount(0); // the dialog closed
    await expect(page.getByTestId("settle-error")).toBeVisible(); // and the reason shows in the block
    await expect(page.getByTestId("settle-error")).not.toBeEmpty();
    await expect(page.getByTestId("needs-decision")).toBeVisible();
    const before = await read(request, sf.id);
    expect(before.status).toBe("abandoned");
    expect(before.outcome?.kind).not.toBe("win");
    // The positive pair: a settle for the remaining entrant is accepted and seats them.
    await page.getByTestId("settle-open").click();
    await page.getByTestId(`settle-winner-${sf.home_entrant_id}`).click();
    await page.getByTestId("settle-method-organiser").check();
    await page.getByTestId("settle-confirm").click();
    await expect(page.getByTestId("needs-decision")).toHaveCount(0);
    expect((await read(request, sf.id)).outcome).toMatchObject({ kind: "win", winner: sf.home_entrant_id, method: "settled_organiser" });
  });

  test("finding 11: on a held fixture the organiser sees Settle; an official scorer sees the fixture and its status but no Settle, Forfeit or Abandon", async ({ browser, page, request }) => {
    const { sf } = await heldFootball(request);
    const path = await fixturePath(request, sf.id);
    // Positive pair (preflight C23): the organiser, on the same fixture, does see the block.
    await page.goto(path);
    await expect(page.getByTestId("needs-decision")).toBeVisible();
    const official = await officialScorerPage(browser, sf.id);
    try {
      const p = official.page;
      await p.goto(path);
      // The official IS a scorer on this page, not a bare viewer (a viewer is offered no controls either, so without this
      // the negatives below would pass for the wrong reason): the courtside "My matches" link renders only for
      // `canScore && !canEdit` (f/[no]/page.tsx `isOfficialScorer`), and the ledger's void control only while scoring.
      await expect(p.getByRole("link", { name: /My matches/ })).toBeVisible();
      await expect(p.getByText("Void last entry")).toBeVisible();
      await expect(p.getByText("Needs a decision", { exact: true }).first()).toBeVisible(); // the status: the hold is visible to them
      await expect(p.getByTestId("needs-decision")).toHaveCount(0);
      await expect(p.getByTestId("settle-open")).toHaveCount(0);
      await expect(p.getByTestId("score-forfeit")).toHaveCount(0);
      await expect(p.getByRole("button", { name: "Abandon…" })).toHaveCount(0);
      for (const w of [1280, 768, 320]) {
        await p.setViewportSize({ width: w, height: 900 });
        await expectNoHorizontalScroll(p);
        await crop(p, "console-official-held", w);
      }
    } finally {
      await official.close();
    }
  });

  test("the block and the dialog at 1280, 768 and 320: no horizontal scroll, long names truncate", async ({ page, request }, testInfo) => {
    // A realistic 43-character entrant name (AGENTS.md: the truncate defect showed only with one).
    const LONG = ["W2a Maximiliana Konstantinopoulou-Grunewald", "W2a Bartholomew Featherstonehaugh-Wolfeschl", "W2a Cy", "W2a Di"];
    expect(LONG.slice(0, 2).map((n) => n.length)).toEqual([43, 43]);
    const { sf } = await knockout(request, "generic", "score", LONG);
    await post(request, sf.id, "core.start");
    await post(request, sf.id, "core.abandon", { reason: "rain" });
    await page.goto(await fixturePath(request, sf.id));
    const block = page.getByTestId("needs-decision");
    let widths = 0;
    for (const w of [1280, 768, 320]) {
      await page.setViewportSize({ width: w, height: 900 });
      await expect(block).toBeVisible();
      await expectNoHorizontalScroll(page);
      const b = await page.getByTestId("settle-open").boundingBox();
      expect(b!.height, `${w}: Settle is a 44px tap target`).toBeGreaterThanOrEqual(44);
      await crop(block, "console-held-block", w);
      await page.getByTestId("settle-open").click();
      for (const id of [sf.home_entrant_id!, sf.away_entrant_id!]) {
        const box = await page.getByTestId(`settle-winner-${id}`).boundingBox();
        expect(box, `${w} ${id}`).not.toBeNull();
        expect(box!.x + box!.width, `${w}: the winner button stays inside the viewport`).toBeLessThanOrEqual(w);
        expect(box!.height, `${w}: a 44px tap target`).toBeGreaterThanOrEqual(44);
      }
      await expectNoHorizontalScroll(page);
      await crop(page.getByRole("dialog"), "console-settle-dialog", w);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      widths++;
    }
    expect(widths).toBe(3);
    await screenshotAtWidths(page, testInfo, "w2a-held-block", [1280, 768, 320]);
  });
});
