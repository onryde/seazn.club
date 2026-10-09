import { test, expect, type APIRequestContext, type Browser, type Locator, type Page } from "@playwright/test";
import { TAG, activeOrg, apiJson, addEntrantsViaApi, createStageAndGenerate, expectNoHorizontalScroll, fixturePath, loginUi, screenshotAtWidths } from "./helpers";
import { withDb } from "./rs007-money-kit";
import { dismissCookieBanner } from "./scorepad-a11y-kit";
import { builtinModules } from "@seazn/engine/sports";
import { TIEBREAK_RUNGS } from "@seazn/engine/sports/boardgame";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

/** The en ui dictionary: console copy under test is read from it, never typed. */
const UI_EN = JSON.parse(
  readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
) as Record<string, string>;
const ui = (key: string) => {
  expect(UI_EN[key], `ui.json has ${key}`).toBeTruthy();
  return UI_EN[key]!;
};
const ABANDON = () => ui("score.abandon");

/** Only for the owner's per-screen verdict capture (R24): element crops into the SDD screenshots dir. Unset in CI. */
const SHOTS = process.env.W2A_SHOTS_DIR;
async function crop(target: Locator | Page, name: string, width: number) {
  if (!SHOTS) return;
  const path = `${SHOTS}/${name}-${width}.png`;
  if ("screenshot" in target && "goto" in target) await (target as Page).screenshot({ path });
  else await (target as Locator).screenshot({ path });
}

type Visibility = "private" | "public";
async function knockout(
  r: APIRequestContext, sport: string, variant: string, names = ["W2a Ana", "W2a Ben", "W2a Cy", "W2a Di"], visibility: Visibility = "private",
) {
  return staged(r, sport, variant, "knockout", names, visibility);
}

async function staged(r: APIRequestContext, sport: string, variant: string, kind: "knockout" | "league", names: string[], visibility: Visibility = "private") {
  // Preflight C14: the variant is one the sport declares (module.variants), never a guessed literal.
  expect(Object.keys(builtinModules.find((m) => m.key === sport)?.variants ?? {}), `${sport} declares ${variant}`).toContain(variant);
  const comp = await apiJson<{ id: string; slug: string }>(r, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `W2a ${sport} ${TAG}-${Math.random().toString(36).slice(2, 6)}`,
    visibility,
  });
  const div = await apiJson<{ id: string; slug: string }>(r, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", { name: "Cup", sport_key: sport, variant_key: variant });
  // A team sport's entrants are teams (`assertRosterFits` refuses an individual football entrant).
  const added = await addEntrantsViaApi(r, div.data!.id, names, sport === "football" ? "team" : "individual");
  expect(added.ids, `entrants for ${sport}`).toHaveLength(names.length);
  const { fixtureIds } = await createStageAndGenerate(r, div.data!.id, { kind, name: "Cup" });
  const started = await apiJson(r, `/api/v1/divisions/${div.data!.id}/start`, "POST");
  expect(started.status, `start ${sport}: ${JSON.stringify(started.error)}`).toBeLessThan(300);
  const all = await Promise.all(fixtureIds.map((id) => read(r, id)));
  const ready = all.filter((f) => f.home_entrant_id && f.away_entrant_id);
  const sf = ready[0]!;
  expect(sf, "a fixture with both entrants").toBeTruthy();
  const nameOf = new Map(added.ids.map((id, i) => [id, names[i]!]));
  return { divisionId: div.data!.id, sf, ready, compSlug: comp.data!.slug, divSlug: div.data!.slug, nameOf };
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
    // D-H3: the block's sentence is the LEVEL-result one; I1: a held fixture is the organiser's to settle, so Forfeit and
    // Abandon go with Finalize (their positive pair is the in-play test below).
    await expect(page.getByTestId("needs-decision").locator("[data-cause]")).toHaveAttribute("data-cause", "level");
    await expect(page.getByTestId("needs-decision").locator("[data-cause]")).toHaveText(ui("score.needsDecision.body"));
    await expect(page.getByTestId("score-forfeit")).toHaveCount(0);
    await expect(page.getByRole("button", { name: ABANDON(), exact: true })).toHaveCount(0);
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
    // M10 (fix round 1): the run sheet carries the hold for a recorded abandon too — stored `abandoned`, held all the
    // same — and its Settle row action is the way in.
    const path = await fixturePath(request, sf.id);
    const no = path.split("/f/")[1]!;
    await page.goto(`${path.split("/f/")[0]}?tab=fixtures`);
    const row = page.locator(`li[data-fixture-no="${no}"]`);
    await expect(row.getByTestId("run-sheet-held-chip")).toHaveText("Needs a decision");
    await expect(row.locator("[data-row-action]")).toHaveAttribute("data-row-action", "decide");
    let rowWidths = 0;
    for (const w of [1280, 768, 320]) {
      await page.setViewportSize({ width: w, height: 900 });
      await expect(row.getByTestId("run-sheet-held-chip"), `${w}: the hold is on the row`).toBeVisible();
      await expectNoHorizontalScroll(page);
      await crop(row, "run-sheet-held-abandon", w);
      rowWidths++;
    }
    expect(rowWidths).toBe(3);
    await page.setViewportSize({ width: 1280, height: 900 });
    await row.locator('[data-row-action="decide"]').click();
    await page.waitForURL((u) => u.pathname === path);
    const block = page.getByTestId("needs-decision");
    await expect(block).toBeVisible();
    await expect(page.getByTestId("score-finalize")).toHaveCount(0); // finding 27
    await expect(block.locator("[data-cause]"), "D-H3: the abandoned sentence").toHaveAttribute("data-cause", "abandoned");
    await expect(block.locator("[data-cause]")).toHaveText(ui("score.needsDecision.body.abandoned"));
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
      await dismissCookieBanner(p);
      // The official IS a scorer on this page, not a bare viewer (a viewer is offered no controls either, so without this
      // the negatives below would pass for the wrong reason): the courtside "My matches" link renders only for
      // `canScore && !canEdit` (f/[no]/page.tsx `isOfficialScorer`), and the ledger's void control only while scoring.
      await expect(p.getByRole("link", { name: /My matches/ })).toBeVisible();
      await expect(p.getByText("Void last entry")).toBeVisible();
      await expect(p.getByText("Needs a decision", { exact: true }).first()).toBeVisible(); // the status: the hold is visible to them
      await expect(p.getByTestId("needs-decision")).toHaveCount(0);
      await expect(p.getByTestId("settle-open")).toHaveCount(0);
      await expect(p.getByTestId("score-forfeit")).toHaveCount(0);
      await expect(p.getByRole("button", { name: ABANDON(), exact: true })).toHaveCount(0);
      // M7 (fix round 1): one line tells them WHY nothing is offered.
      await expect(p.getByTestId("held-note")).toHaveText(ui("score.needsDecision.waiting"));
      for (const w of [1280, 768, 320]) {
        await p.setViewportSize({ width: w, height: 900 });
        await expectNoHorizontalScroll(p);
        await crop(p, "console-official-held", w);
      }
    } finally {
      await official.close();
    }
  });

  test("M9 (fix round 1): on an IN-PLAY fixture the organiser is offered Forfeit and Abandon; an official scorer is offered neither", async ({ browser, page, request }) => {
    // The held negatives above pass for an official on ANY fixture unless this is true: Forfeit and Abandon are the
    // organiser's whatever the status. The organiser on the same in-play fixture is the positive pair.
    const { sf } = await knockout(request, "generic", "score");
    await post(request, sf.id, "core.start");
    expect((await read(request, sf.id)).status).toBe("in_play");
    const path = await fixturePath(request, sf.id);
    await page.goto(path);
    await expect(page.getByTestId("score-forfeit")).toBeVisible();
    await expect(page.getByRole("button", { name: ABANDON(), exact: true })).toBeVisible();
    await expect(page.getByTestId("needs-decision"), "in play: nothing is held").toHaveCount(0);
    const official = await officialScorerPage(browser, sf.id);
    try {
      const p = official.page;
      await p.goto(path);
      await dismissCookieBanner(p);
      await expect(p.getByRole("link", { name: /My matches/ }), "a scorer here, not a bare viewer").toBeVisible();
      await expect(p.getByText("Void last entry")).toBeVisible();
      await expect(p.getByTestId("score-forfeit")).toHaveCount(0);
      await expect(p.getByRole("button", { name: ABANDON(), exact: true })).toHaveCount(0);
      await expect(p.getByTestId("held-note"), "in play: no held line").toHaveCount(0);
    } finally {
      await official.close();
    }
  });

  test("the block and the dialog at 1280, 768 and 320: no horizontal scroll, long names wrap whole (M12)", async ({ page, request }, testInfo) => {
    // A realistic 43-character entrant name (AGENTS.md: the truncate defect showed only with one).
    const LONG = ["W2a Maximiliana Konstantinopoulou-Grunewald", "W2a Bartholomew Featherstonehaugh-Wolfeschl", "W2a Cy", "W2a Di"];
    expect(LONG.slice(0, 2).map((n) => n.length)).toEqual([43, 43]);
    const ko = await knockout(request, "generic", "score", LONG);
    const { sf } = ko;
    expect(
      [sf.home_entrant_id!, sf.away_entrant_id!].some((id) => ko.nameOf.get(id)!.length === 43),
      "the fixture under test carries a 43-character name",
    ).toBe(true);
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
        // M12 (fix round 1): the WHOLE name — the one thing being chosen between — never an ellipsis.
        const name = page.getByTestId(`settle-winner-${id}`).locator("span");
        await expect(name).toHaveText(ko.nameOf.get(id)!);
        const cut = await name.evaluate((s) => s.scrollWidth > s.clientWidth + 1 || getComputedStyle(s).textOverflow === "ellipsis");
        expect(cut, `${w} ${id}: the name is not cut`).toBe(false);
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

// ---------------------------------------------------------------------------
// Task 12 — the pad. Selectors are the chassis's own data hooks (tile-grid.tsx `data-tile-id`, guided-sheet.tsx
// `data-choice-option-id`, scorebug.tsx `data-role`/`data-side`, detail-dock.tsx `pad-dock-chip-<id>`; preflight C24),
// never translated labels — except where the COPY is the thing under test (the two hints).
// ---------------------------------------------------------------------------

const pad = (page: Page) => page.getByTestId("score-pad");
const tile = (page: Page, id: string) => pad(page).locator(`[data-tile-id="${id}"]`);
const option = (page: Page, id: string) => pad(page).locator(`[data-choice-option-id="${id}"]`);
const tappableHalves = (page: Page) => pad(page).locator('button[data-role="v3-scorebug-half"]');
const half = (page: Page, side: "home" | "away") => pad(page).locator(`button[data-role="v3-scorebug-half"][data-side="${side}"]`);
const chip = (page: Page, id: string) => page.getByTestId(`pad-dock-chip-${id}`);
const ARMAGEDDON_HINT = "In Armageddon a draw means Black advances.";
const LOTS_HINT = "Decided by lot? Ask the organiser to settle the match.";
const back = (page: Page) => pad(page).getByRole("button", { name: "Back", exact: true });

/** A chess knockout game drawn into its tie-break (BG-KO-1): the drawn result moves the fold to phase "tiebreak". */
async function drawnChessKnockout(r: APIRequestContext) {
  const ko = await knockout(r, "boardgame", "classical");
  await post(r, ko.sf.id, "core.start");
  await post(r, ko.sf.id, RESULT_DRAWN.type, RESULT_DRAWN.payload);
  // Preflight C25 / ruling C12: in phase tiebreak the outcome is null, so the status is in_play — never needs_decision.
  const drawn = await read(r, ko.sf.id);
  expect(drawn.status, "a drawn chess knockout game awaits its tie-break, it is not held").toBe("in_play");
  expect(drawn.outcome).toBeNull();
  return ko;
}
const RESULT_DRAWN = { type: "boardgame.result", payload: { winner: null, method: "agreement" } } as const;

test.describe("W2a — the pad finishes a bracket (Task 12)", () => {
  test("BG-KO-1 + BG-KO-2 (ruling 82): the chess tie-break — lots is the organiser's, the Armageddon hint shows on Armageddon only, exactly two winners named as the entrants, and the tapped winner advances", async ({ page, request }) => {
    const ko = await drawnChessKnockout(request);
    const { sf } = ko;
    await page.goto(await fixturePath(request, sf.id));
    await expect(tile(page, "tiebreak")).toBeVisible();
    // D-H3: the block says the tie-break is pending; I1: held, so no Forfeit and no Abandon (the engine would take an
    // abandon here — tiebreak.test.ts — but a held fixture is the organiser's to settle).
    await expect(page.getByTestId("needs-decision").locator("[data-cause]")).toHaveAttribute("data-cause", "tiebreak");
    await expect(page.getByTestId("needs-decision").locator("[data-cause]")).toHaveText(ui("score.needsDecision.body.tiebreak"));
    await expect(page.getByTestId("score-forfeit")).toHaveCount(0);
    await expect(page.getByRole("button", { name: ABANDON(), exact: true })).toHaveCount(0);
    await expect(tile(page, "draw"), "the game is already drawn: no second Draw").toHaveCount(0);
    await expect(tappableHalves(page), "no half records a result while the tie-break is owed").toHaveCount(0);
    await tile(page, "tiebreak").click();
    await expect(pad(page).getByText(LOTS_HINT)).toBeVisible();
    await expect(pad(page).locator("[data-choice-option-id]")).toHaveCount(3); // rapid, blitz, armageddon — no lots
    const hint = pad(page).getByText(ARMAGEDDON_HINT);
    for (const rung of ["rapid", "blitz"]) {
      await option(page, rung).click();
      await expect(option(page, "home"), `${rung}: the winner step is open`).toBeVisible();
      await expect(hint, `${rung}: no Armageddon hint`).toHaveCount(0);
      await back(page).click();
      await expect(option(page, "armageddon")).toBeVisible();
    }
    await option(page, "armageddon").click();
    await expect(hint).toBeVisible(); // the positive pair of the two negatives above
    await expect(pad(page).locator("[data-choice-option-id]"), "exactly the two entrants; no 'drawn' choice").toHaveCount(2);
    // I2 (fix round 1, spec §5.5 "two entrants, always"): no pairing card was recorded, so the options read the
    // ENTRANTS' names — never "Home"/"Away" — and their ids stay home/away.
    await expect(option(page, "home")).toHaveText(ko.nameOf.get(sf.home_entrant_id!)!);
    await expect(option(page, "away")).toHaveText(ko.nameOf.get(sf.away_entrant_id!)!);
    await option(page, "away").click();
    await expect.poll(async () => (await read(request, sf.id)).outcome).toMatchObject({ kind: "win", winner: sf.away_entrant_id, method: "tiebreak_armageddon" });
    await expect.poll(() => seatedInFinal(sf.id)).toContain(sf.away_entrant_id);
    await expect(tile(page, "tiebreak"), "decided: the tie-break is gone").toHaveCount(0);
  });

  test("a rapid tie-break with its score: the winner and the score land on the ledger as tapped", async ({ page, request }) => {
    const { sf } = await drawnChessKnockout(request);
    await page.goto(await fixturePath(request, sf.id));
    await tile(page, "tiebreak").click();
    await option(page, "rapid").click();
    await option(page, "home").click();
    await expect(option(page, "none"), "step 3, the optional score").toBeVisible();
    await option(page, "1½–½").click();
    await expect.poll(async () => (await read(request, sf.id)).outcome).toMatchObject({ kind: "win", winner: sf.home_entrant_id, method: "tiebreak_rapid" });
    const events = (await apiJson<{ type: string; payload: Record<string, unknown> }[]>(request, `/api/v1/fixtures/${sf.id}/events`)).data!;
    expect(events.filter((e) => e.type === "boardgame.tiebreak").map((e) => e.payload)).toEqual([{ rung: "rapid", winner: sf.home_entrant_id, score: "1½–½" }]);
  });

  test("Back on step 2 returns to step 1 and writes nothing", async ({ page, request }) => {
    const { sf } = await drawnChessKnockout(request);
    await page.goto(await fixturePath(request, sf.id));
    await tile(page, "tiebreak").click();
    await option(page, "rapid").click();
    await expect(option(page, "home")).toBeVisible();
    await back(page).click();
    await expect(option(page, "blitz")).toBeVisible();
    expect((await read(request, sf.id)).status).toBe("in_play");
    const events = (await apiJson<{ type: string }[]>(request, `/api/v1/fixtures/${sf.id}/events`)).data!;
    expect(events.map((e) => e.type)).toEqual(["core.start", "boardgame.result"]); // nothing more
  });

  test("addendum 1 (D-C5): once the organiser settles a chess tie-break by lot, the pad offers nothing — the same page held a mounted pad with the tie-break before, and holds no pad after", async ({ page, request }) => {
    const { sf } = await drawnChessKnockout(request);
    await page.goto(await fixturePath(request, sf.id));
    // Teeth (fix round 1, M8): the SAME page, before the settle, holds a mounted pad offering the tie-break — so every
    // absence below is the settle's doing, never a pad that was not there to begin with.
    await expect(pad(page)).toBeAttached();
    await expect(tile(page, "tiebreak")).toBeVisible();
    await post(request, sf.id, "core.settle", { winner: sf.home_entrant_id, method: "lot" });
    expect((await read(request, sf.id)).outcome).toMatchObject({ kind: "win", winner: sf.home_entrant_id, method: "settled_lot" });
    await page.reload();
    await expect(page.getByText("Void last entry")).toBeVisible(); // the console rendered and is scoring-capable
    await expect(page.getByTestId("needs-decision"), "settled: no longer held").toHaveCount(0);
    // Decided chess declares no post-match panel, so the console unmounts the pad (`shouldMountPad`): nothing at all is
    // offered — no tie-break, no Draw, no result half.
    await expect(pad(page)).toHaveCount(0);
    await expect(tile(page, "tiebreak")).toHaveCount(0);
    await expect(page.locator('[data-tile-id="draw"]')).toHaveCount(0);
    await expect(page.locator('button[data-role="v3-scorebug-half"]')).toHaveCount(0);
  });

  test("D-P1: chess keeps its Draw in every kind while live — a knockout game and a league game both show it", async ({ page, request }) => {
    let checked = 0;
    for (const kind of ["knockout", "league"] as const) {
      const { sf } = await staged(request, "boardgame", "classical", kind, ["W2a Ana", "W2a Ben", "W2a Cy", "W2a Di"]);
      await post(request, sf.id, "core.start");
      await page.goto(await fixturePath(request, sf.id));
      await expect(tile(page, "draw"), kind).toBeVisible();
      await expect(tile(page, "tiebreak"), kind).toHaveCount(0);
      checked++;
    }
    expect(checked).toBe(2);
  });

  test("X-DR-1 / GN-KO-1: a generic bracket's pad offers no level finish and says 'No draws'; the same tally in a league does (the positive pair)", async ({ page, request }) => {
    let checked = 0;
    for (const kind of ["knockout", "league"] as const) {
      // The `score` variant declares allowDraws: true — only the bracket kind may take it away.
      const { sf } = await staged(request, "generic", "score", kind, ["W2a Ana", "W2a Ben", "W2a Cy", "W2a Di"]);
      await post(request, sf.id, "core.start");
      await post(request, sf.id, "generic.score", { by: sf.home_entrant_id, points: 1 });
      await post(request, sf.id, "generic.score", { by: sf.away_entrant_id, points: 1 });
      await page.goto(await fixturePath(request, sf.id));
      await dismissCookieBanner(page);
      await expect(pad(page).locator("[data-tile-id]").first(), `${kind}: the pad rendered`).toBeVisible();
      if (kind === "knockout") {
        await expect(tile(page, "settle"), "a level tally cannot finish a bracket match").toHaveCount(0);
        await expect(pad(page).getByText("No draws")).toBeVisible();
        for (const w of [1280, 768, 320]) {
          await page.setViewportSize({ width: w, height: 900 });
          await expectNoHorizontalScroll(page);
          await crop(pad(page), "pad-generic-bracket", w);
        }
      } else {
        await expect(tile(page, "settle")).toBeVisible();
        await expect(pad(page).getByText("Draws allowed")).toBeVisible();
      }
      checked++;
    }
    expect(checked).toBe(2);
  });

  test("M11 (fix round 1): the device link (/score/[token]) on a generic bracket offers no level finish either; the same tally's link in a league does", async ({ browser, request }) => {
    // The device route mounts its own pad (DeviceScorePad), not the console's — a second consumer of the bracket rule.
    let checked = 0;
    for (const kind of ["knockout", "league"] as const) {
      const { sf } = await staged(request, "generic", "score", kind, ["W2a Ana", "W2a Ben", "W2a Cy", "W2a Di"]);
      await post(request, sf.id, "core.start");
      await post(request, sf.id, "generic.score", { by: sf.home_entrant_id, points: 1 });
      await post(request, sf.id, "generic.score", { by: sf.away_entrant_id, points: 1 });
      const minted = await apiJson<{ id: string; secret: string }>(request, `/api/v1/fixtures/${sf.id}/device-links`, "POST", { label: `W2a ${kind}` });
      expect(minted.status, `mint: ${JSON.stringify(minted.error)}`).toBe(201);
      // A signed-out browser: the token is the credential (device-links.spec.ts), never the organiser's cookie.
      const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
      try {
        const p = await ctx.newPage();
        await p.goto(`/score/${minted.data!.secret}`);
        await dismissCookieBanner(p);
        await expect(p.locator("[data-tile-id]").first(), `${kind}: the device pad rendered`).toBeVisible({ timeout: 20_000 });
        const settle = p.locator('[data-tile-id="settle"]');
        if (kind === "knockout") {
          await expect(settle, "a level tally cannot finish a bracket match on the device either").toHaveCount(0);
          await expect(p.getByText("No draws")).toBeVisible();
          for (const w of [1280, 768, 320]) {
            await p.setViewportSize({ width: w, height: 900 });
            await expectNoHorizontalScroll(p);
            await crop(p, "device-pad-generic-bracket", w);
          }
        } else {
          await expect(settle).toBeVisible();
          await expect(p.getByText("Draws allowed")).toBeVisible();
        }
      } finally {
        await ctx.close();
      }
      checked++;
    }
    expect(checked).toBe(2);
  });

  test("D-O1 (addendum 2): an official scorer's chess dock offers no forfeit; the organiser's does", async ({ browser, page, request }) => {
    const EIGHT = ["W2a Ana", "W2a Ben", "W2a Cy", "W2a Di", "W2a Eve", "W2a Fay", "W2a Gus", "W2a Hal"];
    const { ready } = await knockout(request, "boardgame", "classical", EIGHT);
    expect(ready.length, "four first-round games: one for the organiser, three for the scorer's three widths").toBe(4);
    for (const f of ready) await post(request, f.id, "core.start");
    // The organiser — the positive pair: same sport, same tap, the forfeit chip is offered.
    await page.goto(await fixturePath(request, ready[0]!.id));
    await half(page, "home").click();
    await expect(chip(page, "method:checkmate")).toBeVisible();
    await expect(chip(page, "method:forfeit")).toBeVisible();
    const official = await officialScorerPage(browser, ready[1]!.id);
    try {
      const p = official.page;
      let widths = 0;
      for (const [i, w] of [[1, 1280], [2, 768], [3, 320]] as const) {
        if (i > 1) {
          await withDb(async (sql) => {
            await sql`insert into fixture_officials (org_id, fixture_id, official_id, role_key, response)
                      select org_id, ${ready[i]!.id}, official_id, role_key, response from fixture_officials where fixture_id = ${ready[1]!.id}`;
          });
        }
        await p.setViewportSize({ width: w, height: 900 });
        await p.goto(await fixturePath(request, ready[i]!.id));
        await dismissCookieBanner(p); // the banner would sit over the dock in the crop
        await expect(p.getByText("Void last entry"), `${w}: the official is scoring here`).toBeVisible();
        await half(p, "home").click();
        await expect(chip(p, "method:checkmate"), `${w}: the dock opened`).toBeVisible();
        await expect(chip(p, "method:forfeit"), `${w}: forfeit is the organiser's`).toHaveCount(0);
        await expectNoHorizontalScroll(p);
        await crop(pad(p), "pad-chess-dock-scorer", w);
        widths++;
      }
      expect(widths).toBe(3);
    } finally {
      await official.close();
    }
  });

  test("the pad screens at 1280, 768 and 320: chess live with Draw, the tie-break tile, and each tie-break step — no horizontal scroll", async ({ page, request }) => {
    const live = await knockout(request, "boardgame", "classical");
    await post(request, live.sf.id, "core.start");
    await page.goto(await fixturePath(request, live.sf.id));
    await dismissCookieBanner(page);
    for (const w of [1280, 768, 320]) {
      await page.setViewportSize({ width: w, height: 900 });
      await expect(tile(page, "draw")).toBeVisible();
      await expectNoHorizontalScroll(page);
      await crop(pad(page), "pad-chess-live-draw", w);
    }
    const { sf } = await drawnChessKnockout(request);
    await page.goto(await fixturePath(request, sf.id));
    let steps = 0;
    for (const w of [1280, 768, 320]) {
      await page.setViewportSize({ width: w, height: 900 });
      await expect(tile(page, "tiebreak")).toBeVisible();
      await expectNoHorizontalScroll(page);
      await crop(pad(page), "pad-tiebreak-tile", w);
      await tile(page, "tiebreak").click();
      await expect(option(page, "rapid")).toBeVisible();
      await expectNoHorizontalScroll(page);
      await crop(pad(page), "pad-tiebreak-rung", w);
      await option(page, "rapid").click();
      await expect(option(page, "away")).toBeVisible();
      await expectNoHorizontalScroll(page);
      await crop(pad(page), "pad-tiebreak-winner", w);
      await option(page, "away").click();
      await expect(option(page, "none")).toBeVisible();
      await expectNoHorizontalScroll(page);
      await crop(pad(page), "pad-tiebreak-score", w);
      await back(page).click();
      await back(page).click();
      await option(page, "armageddon").click();
      await expect(pad(page).getByText(ARMAGEDDON_HINT)).toBeVisible();
      await expectNoHorizontalScroll(page);
      await crop(pad(page), "pad-tiebreak-armageddon", w);
      for (const id of ["home", "away"]) {
        const box = await option(page, id).boundingBox();
        expect(box!.height, `${w} ${id}: a 44px tap target`).toBeGreaterThanOrEqual(44);
        expect(box!.x + box!.width, `${w} ${id}: inside the viewport`).toBeLessThanOrEqual(w);
      }
      await back(page).click();
      await pad(page).getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(option(page, "rapid")).toHaveCount(0);
      steps++;
    }
    expect(steps).toBe(3);
    // Nothing was written by any of it.
    const events = (await apiJson<{ type: string }[]>(request, `/api/v1/fixtures/${sf.id}/events`)).data!;
    expect(events.map((e) => e.type)).toEqual(["core.start", "boardgame.result"]);
  });

  test("the phone composition is a branch, not a shrink: the tie-break pad's control set at 320 equals 1280 — membership, order, repeats", async ({ page, request }) => {
    // AGENTS.md (phone composition): verify by a control-set diff from the live DOM, never by box sizes. ATTACHED, not
    // visible — a phone fold hides chrome it still holds (rule 22). Tiles, dock chips and every sheet step's options.
    const { sf } = await drawnChessKnockout(request);
    await page.goto(await fixturePath(request, sf.id));
    const ids = (sel: string, attr: string) => pad(page).locator(sel).evaluateAll((els, a) => els.map((e) => e.getAttribute(a)!), attr);
    const controlSet = async (w: number) => {
      await page.setViewportSize({ width: w, height: 900 });
      await expect(tile(page, "tiebreak")).toBeAttached();
      const set: Record<string, string[]> = {
        tiles: await ids("[data-tile-id]", "data-tile-id"),
        // Every control the pad holds, by its own hook (a tile, an option, a test id, a role) or else its name.
        controls: await pad(page).locator("button, a[href], [role=button]").evaluateAll((els) =>
          els.map((e) =>
            e.getAttribute("data-tile-id") ?? e.getAttribute("data-choice-option-id") ?? e.getAttribute("data-testid") ??
            e.getAttribute("data-role") ?? e.getAttribute("aria-label") ?? (e.textContent ?? "").trim())),
      };
      await tile(page, "tiebreak").click();
      await expect(option(page, "rapid")).toBeAttached();
      set.rung = await ids("[data-choice-option-id]", "data-choice-option-id");
      await option(page, "rapid").click();
      await expect(option(page, "away")).toBeAttached();
      set.winner = await ids("[data-choice-option-id]", "data-choice-option-id");
      await option(page, "away").click();
      await expect(option(page, "none")).toBeAttached();
      set.score = await ids("[data-choice-option-id]", "data-choice-option-id");
      await pad(page).getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(option(page, "rapid")).toHaveCount(0);
      return set;
    };
    const wide = await controlSet(1280);
    const phone = await controlSet(320);
    let compared = 0;
    for (const k of Object.keys(wide)) {
      expect(wide[k]!.length, `${k}: the 1280 set is not empty`).toBeGreaterThan(0);
      expect(phone[k], `${k}: 320 vs 1280`).toEqual(wide[k]);
      compared++;
    }
    expect(compared).toBe(5);
    expect(wide.tiles).toContain("tiebreak");
    expect(wide.rung, "the rungs the engine declares, in its order").toEqual([...TIEBREAK_RUNGS]);
  });
});

// ---------------------------------------------------------------------------
// Task 13 — the public site says HOW a bracket was decided (spec §5.5, D5), and marks a held match. The copy is read
// from the public dictionary, never typed, so the sentence under test is the one the locale ships.
// ---------------------------------------------------------------------------

const PUB = JSON.parse(
  readFileSync(fileURLToPath(new URL("../src/dictionaries/en/public.json", import.meta.url)), "utf8"),
) as Record<string, string>;
const say = (key: string, params: Record<string, string> = {}) => {
  const tpl = PUB[key];
  expect(tpl, `public.json has ${key}`).toBeTruthy();
  return Object.entries(params).reduce((acc, [k, v]) => acc.replaceAll(`{${k}}`, v), tpl!);
};

test.describe("W2a — the public match page and bracket (Task 13)", () => {
  test("the public match page names the settle method and keeps the level score", async ({ page, request }) => {
    const org = await activeOrg(page);
    const ko = await knockout(request, "football", "11-a-side", undefined, "public");
    const { sf } = ko;
    await post(request, sf.id, "core.start");
    await post(request, sf.id, "football.period", { phase: "HT" });
    await post(request, sf.id, "football.period", { phase: "FT" });
    expect((await read(request, sf.id)).status, "the rig must actually hold the fixture").toBe("needs_decision");
    const base = `/shared/${org.slug}/${ko.compSlug}/${ko.divSlug}`;
    const matchUrl = `${base}/fixtures/${sf.id}`;

    // Held: the match page says so and names no winner; the bracket marks the match.
    await page.goto(matchUrl);
    await dismissCookieBanner(page);
    const line = page.getByTestId("mc-status-line");
    await expect(line).toHaveText(say("matchCentre.status.needs_decision"));
    await expect(line).not.toContainText(ko.nameOf.get(sf.away_entrant_id!)!);
    await page.goto(`${base}?tab=standings`);
    const held = page.locator('[data-held="true"]');
    await expect(held, "the held match is marked on the bracket").toHaveCount(1);
    await expect(held).toContainText(say("matchCentre.status.needs_decision"));

    // Settled by lot: the sentence names the method, and the score stays level.
    await post(request, sf.id, "core.settle", { winner: sf.away_entrant_id, method: "lot" });
    await page.goto(matchUrl);
    const winner = ko.nameOf.get(sf.away_entrant_id!)!;
    await expect(line).toHaveText(say("matchCentre.result.settled_lot", { winner }));
    await expect(line, "the right answer differs from the plain line").not.toHaveText(say("matchCentre.result.regulation", { winner }));
    await expect(page.getByTestId("mc-score-0")).toHaveText("0");
    await expect(page.getByTestId("mc-score-1")).toHaveText("0");
    await page.goto(`${base}?tab=standings`);
    await expect(page.locator('[data-held="true"]'), "settled: no longer held").toHaveCount(0);
  });

  test("a chess knockout decided by a scored rapid tie-break: the public line names the rung and the score, the board stays level", async ({ page, request }) => {
    const org = await activeOrg(page);
    const ko = await knockout(request, "boardgame", "classical", undefined, "public");
    const { sf } = ko;
    await post(request, sf.id, "core.start");
    await post(request, sf.id, RESULT_DRAWN.type, RESULT_DRAWN.payload);
    await post(request, sf.id, "boardgame.tiebreak", { rung: "rapid", winner: sf.home_entrant_id, score: "1½–½" });
    expect((await read(request, sf.id)).outcome).toMatchObject({ kind: "win", winner: sf.home_entrant_id, method: "tiebreak_rapid" });
    await page.goto(`/shared/${org.slug}/${ko.compSlug}/${ko.divSlug}/fixtures/${sf.id}`);
    await dismissCookieBanner(page);
    const winner = ko.nameOf.get(sf.home_entrant_id!)!;
    await expect(page.getByTestId("mc-status-line")).toHaveText(
      say("matchCentre.result.tiebreak_rapid.scored", { winner, score: "1½–½" }),
    );
    // M1 (fix round 1): the score is one unbreakable run — at 320 it read "(1½–" over "½)".
    await expect(page.getByTestId("mc-status-line").locator("span.whitespace-nowrap")).toHaveText("1½–½");
    const [a, b] = [await page.getByTestId("mc-score-0").textContent(), await page.getByTestId("mc-score-1").textContent()];
    expect(a, "the drawn game's level score is kept").toBe(b);
    expect(a?.trim()).not.toBe("");
    let widths = 0;
    for (const w of [1280, 768, 320]) {
      await page.setViewportSize({ width: w, height: 900 });
      await expect(page.getByTestId("mc-court-card")).toBeVisible();
      await expectNoHorizontalScroll(page);
      await crop(page.getByTestId("mc-court-card"), "public-match-tiebreak", w);
      widths++;
    }
    expect(widths).toBe(3);
  });

  test("addendum 8: the official's own lane keeps a held fixture as a duty, says it is held, and its View match link (D-H3) opens the console", async ({ browser, request }) => {
    const UI = JSON.parse(
      readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
    ) as Record<string, string>;
    const { sf } = await heldFootball(request);
    const official = await officialScorerPage(browser, sf.id);
    try {
      const p = official.page;
      await p.goto("/me");
      await dismissCookieBanner(p);
      const card = p.getByTestId("me-official-card").filter({ has: p.locator('[data-held="true"]') });
      await expect(card, "the held fixture is on the lane, marked held").toHaveCount(1);
      await expect(card.locator('[data-held="true"]')).toHaveText(UI["score.status.needs_decision"]!);
      // D-H3: there is nothing to SCORE on a held fixture — the link says View match (positive pair: the unit's in-play row).
      const link = card.getByRole("link", { name: new RegExp(`^${UI["me.off.view"]!}`) });
      await expect(link, "a held fixture is still the scorer's to open").toBeVisible();
      await expect(card.getByRole("link", { name: new RegExp(`^${UI["me.off.score"]!}`) })).toHaveCount(0);
      for (const w of [1280, 768, 320]) {
        await p.setViewportSize({ width: w, height: 900 });
        await expectNoHorizontalScroll(p);
        await crop(card, "me-lane-held", w);
      }
      await link.click();
      const consolePath = await fixturePath(request, sf.id);
      await p.waitForURL((u) => u.pathname === consolePath);
    } finally {
      await official.close();
    }
  });

  test("addendum 9: the desk reads an abandoned knockout final as owed work — red pill and a Needs-you row, never Finished", async ({ page, request }) => {
    const UI = JSON.parse(
      readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
    ) as Record<string, string>;
    const org = await activeOrg(page);
    // Two entrants: one fixture, the final. Every fixture is then stored terminal, which is the shape that read Finished.
    const ko = await knockout(request, "football", "11-a-side", ["W2a Ana", "W2a Ben"]);
    expect(ko.ready, "a two-team knockout is one final").toHaveLength(1);
    await post(request, ko.sf.id, "core.start");
    await post(request, ko.sf.id, "core.abandon", { reason: "floodlights" });
    expect((await read(request, ko.sf.id)).status).toBe("abandoned");
    await page.goto(`/o/${org.slug}/c/${ko.compSlug}`);
    await dismissCookieBanner(page);
    const item = page.getByTestId("desk-needs-you").locator('[data-attention="needs_decision"]');
    await expect(item).toHaveCount(1);
    await expect(item.filter({ visible: true }).first()).toContainText(UI["desk.needsYou.needs_decision.action"]!);
    const pill = page.locator('[data-pill="needs_decision"]:visible').first();
    await expect(pill).toHaveText(UI["desk.pill.needs_decision"]!);
    await expect(page.locator(`[data-pill="finished"]`), "not Finished").toHaveCount(0);
    let widths = 0;
    for (const w of [1280, 768, 320]) {
      await page.setViewportSize({ width: w, height: 900 });
      await expect(item.filter({ visible: true }).first()).toBeVisible();
      await expectNoHorizontalScroll(page);
      await crop(item.filter({ visible: true }).first(), "desk-needs-decision", w);
      await crop(page.locator('[data-pill="needs_decision"]:visible').first(), "desk-pill-needs-decision", w);
      widths++;
    }
    expect(widths).toBe(3);
    // M3 (fix round 1): the DIVISION page agrees. It renders no phase pill (its phase gates only the start-locks tip and
    // the run sheet's default filter — finding, fix round 1), so what it shows of the hold is the run sheet's row: the
    // held chip and the Settle action on the abandoned final, never a plain abandoned row.
    await page.setViewportSize({ width: 1280, height: 900 });
    const path = await fixturePath(request, ko.sf.id);
    await page.goto(`${path.split("/f/")[0]}?tab=fixtures`);
    const row = page.locator(`li[data-fixture-no="${path.split("/f/")[1]!}"]`);
    await expect(row.getByTestId("run-sheet-held-chip")).toHaveText("Needs a decision");
    await expect(row.locator("[data-row-action]")).toHaveAttribute("data-row-action", "decide");
    await expect(page.locator('[data-pill="finished"]'), "nothing on the division page reads Finished").toHaveCount(0);
  });

  test("the public screens at 1280, 768 and 320: held match, settled match, held bracket — no horizontal scroll", async ({ page, request }) => {
    const org = await activeOrg(page);
    const LONG = ["W2a Maximiliana Konstantinopoulou-Grunewald", "W2a Bartholomew Featherstonehaugh-Wolfeschl", "W2a Cy", "W2a Di"];
    const ko = await knockout(request, "football", "11-a-side", LONG, "public");
    const { sf } = ko;
    await post(request, sf.id, "core.start");
    await post(request, sf.id, "football.period", { phase: "HT" });
    await post(request, sf.id, "football.period", { phase: "FT" });
    const base = `/shared/${org.slug}/${ko.compSlug}/${ko.divSlug}`;
    let shots = 0;
    for (const w of [1280, 768, 320]) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.goto(`${base}/fixtures/${sf.id}`);
      await dismissCookieBanner(page);
      await expect(page.getByTestId("mc-status-line")).toHaveText(say("matchCentre.status.needs_decision"));
      await expectNoHorizontalScroll(page);
      await crop(page.getByTestId("mc-court-card"), "public-match-held", w);
      await page.goto(`${base}?tab=standings`);
      const held = page.locator('[data-held="true"]');
      await expect(held).toBeVisible();
      await expectNoHorizontalScroll(page);
      await crop(held.locator("xpath=ancestor::a[1]"), "public-bracket-held", w);
      shots++;
    }
    await post(request, sf.id, "core.settle", { winner: sf.away_entrant_id, method: "higher_seed" });
    for (const w of [1280, 768, 320]) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.goto(`${base}/fixtures/${sf.id}`);
      await expect(page.getByTestId("mc-status-line")).toHaveText(
        say("matchCentre.result.settled_higher_seed", { winner: ko.nameOf.get(sf.away_entrant_id!)! }),
      );
      await expectNoHorizontalScroll(page);
      await crop(page.getByTestId("mc-court-card"), "public-match-settled", w);
      shots++;
    }
    expect(shots).toBe(6);
  });
});
