import { test, expect, type APIRequestContext, type Browser, type Locator, type Page } from "@playwright/test";
import { TAG, apiJson, addEntrantsViaApi, createStageAndGenerate, expectNoHorizontalScroll, fixturePath, loginUi } from "./helpers";
import { withDb } from "./rs007-money-kit";
import { dismissCookieBanner } from "./scorepad-a11y-kit";
import { builtinModules } from "@seazn/engine/sports";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// W2b Task 11 (UI-1 option A; spec §5.5, §7): the organiser console's forfeit dialog — who → why (by phase) → the
// engine's credit preview → one specific Confirm. Every test asserts through the DOM AND through the API (the ledger,
// the fixture, the table), so a dialog that looks right and sends the wrong thing fails here.
// Whole file, never a -g slice (AGENTS.md rule 21).

interface Fx {
  id: string;
  stage_id: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
  outcome: { kind: string; winner?: string; reason?: string } | null;
}
interface Row { id: string; seq: number; type: string; payload: Record<string, unknown>; voids_event_id?: string | null }
const read = async (r: APIRequestContext, id: string) => (await apiJson<Fx>(r, `/api/v1/fixtures/${id}`)).data!;
const tip = async (r: APIRequestContext, id: string) => (await apiJson<{ last_seq: number }>(r, `/api/v1/fixtures/${id}/state`)).data!.last_seq;
async function post(r: APIRequestContext, id: string, type: string, payload: unknown = {}) {
  const res = await apiJson(r, `/api/v1/fixtures/${id}/events`, "POST", { expected_seq: await tip(r, id), type, payload });
  expect(res.status, `${type}: ${JSON.stringify(res.error)}`).toBeLessThan(300);
  return res;
}
async function ledger(r: APIRequestContext, id: string): Promise<Row[]> {
  const res = await apiJson<Row[]>(r, `/api/v1/fixtures/${id}/events?since_seq=0`);
  expect(res.status, `ledger: ${JSON.stringify(res.error)}`).toBe(200);
  return res.data ?? [];
}
const forfeitsIn = async (r: APIRequestContext, id: string) => (await ledger(r, id)).filter((e) => e.type === "core.forfeit");

/** The en ui dictionary: console copy under test is read from it, never typed. */
const UI_EN = JSON.parse(readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8")) as Record<string, string>;
const ui = (key: string, vars: Record<string, string | number> = {}) => {
  expect(UI_EN[key], `ui.json has ${key}`).toBeTruthy();
  return Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), UI_EN[key]!);
};

/** Only for the owner's per-screen verdict capture: element crops into a SCRATCH dir. Unset in CI — never the repo. */
const SHOTS = process.env.W2B_T11_SHOTS_DIR;
async function crop(target: Locator, name: string, width: number) {
  if (SHOTS) await target.screenshot({ path: `${SHOTS}/${name}-${width}.png` });
}

type Kind = "knockout" | "league";
/** A started division of `sport` (`variant` one the sport declares) with `names`, one `kind` stage, and its first
 *  fixture with both sides seated. */
async function staged(r: APIRequestContext, sport: string, variant: string, kind: Kind, names: string[]) {
  expect(Object.keys(builtinModules.find((m) => m.key === sport)?.variants ?? {}), `${sport} declares ${variant}`).toContain(variant);
  const comp = await apiJson<{ id: string }>(r, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `W2b T11 ${sport} ${TAG}-${Math.random().toString(36).slice(2, 6)}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(r, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", { name: "Cup", sport_key: sport, variant_key: variant });
  const added = await addEntrantsViaApi(r, div.data!.id, names, "individual");
  expect(added.ids).toHaveLength(names.length);
  const { fixtureIds } = await createStageAndGenerate(r, div.data!.id, { kind, name: "Cup" });
  const started = await apiJson(r, `/api/v1/divisions/${div.data!.id}/start`, "POST");
  expect(started.status, `start ${sport}: ${JSON.stringify(started.error)}`).toBeLessThan(300);
  const all = await Promise.all(fixtureIds.map((id) => read(r, id)));
  const fx = all.find((f) => f.home_entrant_id && f.away_entrant_id)!;
  expect(fx, "a fixture with both entrants").toBeTruthy();
  const nameOf = new Map(added.ids.map((id, i) => [id, names[i]!]));
  return { fx, home: nameOf.get(fx.home_entrant_id!)!, away: nameOf.get(fx.away_entrant_id!)!, all, nameOf };
}
const badmintonLeague = (r: APIRequestContext) => staged(r, "badminton", "bwf", "league", [`Asha ${TAG}`, `Bala ${TAG}`]);

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

/** The fixture a semi's winner feeds, its status and slot labels, and which of its seats the semi feeds — read from
 *  the rows, not inferred. */
async function finalFedBy(sfId: string) {
  return withDb(async (sql) => {
    const rows = await sql<{ id: string; status: string; home: string | null; away: string | null; home_label: string | null; away_label: string | null; slot: number }[]>`
      select n.id, n.status, n.home_entrant_id as home, n.away_entrant_id as away,
             n.home_slot_label->>'key' as home_label, n.away_slot_label->>'key' as away_label, f.winner_to_slot as slot
        from fixtures f join fixtures n on n.id = f.winner_to_fixture
       where f.id = ${sfId}`;
    expect(rows, "the semi feeds a final").toHaveLength(1);
    const r = rows[0]!;
    return { ...r, fedSeat: r.slot === 1 ? r.home : r.away, fedLabel: r.slot === 1 ? r.home_label : r.away_label };
  });
}

/** Neither → walkover → Confirm on the open console: the dialog's own double walkover, its preview and its label. */
async function confirmNeither(page: Page) {
  const d = await openDialog(page);
  expect(await sidesShown(d), "before play, with a next match (or a table): Neither is offered").toEqual(["home", "away", "both"]);
  await d.getByTestId("forfeit-who-both").click();
  expect(await reasonsShown(d), "Neither only walks over").toEqual(["walkover"]);
  // Design audit 1.1: the one reason comes with the side — no second tap that decides nothing.
  await expect(d.getByTestId("forfeit-why-walkover"), "the walkover is chosen with Both sides").toBeChecked();
  await expect(d.getByTestId("forfeit-confirm"), "Confirm is ready on the side alone").toBeEnabled();
  await d.getByTestId("forfeit-why-walkover").check();
  // X-DW-4: no score is credited to either side.
  await expect(d.getByTestId("forfeit-preview")).toHaveText(ui("forfeitDialog.preview.none"));
  await expect(d.getByTestId("forfeit-confirm")).toHaveText(ui("forfeitDialog.confirm.doubleWalkover"));
  await d.getByTestId("forfeit-confirm").click();
}

/** The forfeit POSTs a page itself sends (count requests, not ledger rows a retry could merge). */
function countForfeitPosts(page: Page): () => number {
  let n = 0;
  page.on("request", (req) => {
    if (req.method() === "POST" && /\/fixtures\/[^/]+\/events$/.test(new URL(req.url()).pathname) && (req.postData() ?? "").includes('"core.forfeit"')) n++;
  });
  return () => n;
}

/** Hold every GET `page` makes of one fixture's `/state` and `/events` until `release()`: the page keeps the ledger it
 *  had. Its live channel and its poll still FIRE — their reads just wait — so a write made elsewhere stays unheard here
 *  until released. Review Focus 4's race (loop H): page 2's live channel delivers page 1's forfeit within ~350 ms
 *  (measured: a `/events` + `/state` resync landed 4 ms before its Confirm), after which it sends a CURRENT
 *  `expected_seq` and the server answers ALREADY_DECIDED, not SEQ_CONFLICT. `held()` counts the reads that waited. */
async function holdFixtureReads(page: Page, fixtureId: string): Promise<{ release: () => Promise<void>; held: () => number }> {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  let held = 0;
  const reads = (url: URL) => url.pathname === `/api/v1/fixtures/${fixtureId}/state` || url.pathname === `/api/v1/fixtures/${fixtureId}/events`;
  const handler = async (route: Parameters<Parameters<Page["route"]>[1]>[0]) => {
    if (route.request().method() !== "GET") return route.fallback();
    held++;
    await gate;
    await route.fallback();
  };
  await page.route(reads, handler);
  return {
    release: async () => {
      open();
      await page.unroute(reads, handler);
    },
    held: () => held,
  };
}

/** An ACCEPTED official scorer for one fixture, minted as bracket-finish.spec.ts mints one (the suite has no official
 *  storage state): an org viewer whose person is the official the fixture names. */
async function officialScorerPage(browser: Browser, fixtureId: string): Promise<{ page: Page; close: () => Promise<void>; hasSeat: () => Promise<boolean> }> {
  const tag = Math.random().toString(36).slice(2, 8);
  const email = `delivered+w2b-official-${TAG}-${tag}@resend.dev`;
  let orgId = "";
  let userId = "";
  await withDb(async (sql) => {
    const [u] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified) values (${email}, ${"W2b Official " + tag}, true) returning id`;
    const [o] = await sql<{ org_id: string }[]>`
      select c.org_id from fixtures f join divisions d on d.id = f.division_id join competitions c on c.id = d.competition_id
       where f.id = ${fixtureId}`;
    orgId = o!.org_id;
    userId = u!.id;
    await sql`insert into org_members (org_id, user_id, role) values (${o!.org_id}, ${u!.id}, 'viewer')`;
    const [p] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name, user_id, lane) values (${o!.org_id}, ${"W2b Official " + tag}, ${u!.id}, 'official') returning id`;
    const [off] = await sql<{ id: string }[]>`
      insert into officials (org_id, display_name, role_keys, person_id)
      values (${o!.org_id}, ${"W2b Official " + tag}, ${sql.json(["scorer"])}, ${p!.id}) returning id`;
    await sql`insert into fixture_officials (org_id, fixture_id, official_id, role_key, response)
              values (${o!.org_id}, ${fixtureId}, ${off!.id}, 'scorer', 'accepted')`;
  });
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await loginUi(page, email);
  await page.request.post("/api/onboarding/complete", { data: {} }).catch(() => undefined);
  // The viewer row is a TEAM SEAT in the shared org (Pro `members.max` = 10, counted by `grantInvite`), and a shard runs every
  // spec against ONE org: a seat left behind by this helper starves invite-claim.spec.ts of the seats its claims need. So the
  // seat lives exactly as long as the page: `close()` frees it. (The official/person/fixture_officials rows stay: they take no
  // seat, and no foreign key points at org_members.)
  const seatRows = () => withDb((sql) => sql<{ n: number }[]>`select count(*)::int as n from org_members where org_id = ${orgId} and user_id = ${userId}`);
  return {
    page,
    close: async () => {
      try {
        await context.close();
      } finally {
        await withDb(async (sql) => {
          await sql`delete from org_members where org_id = ${orgId} and user_id = ${userId}`;
        });
      }
    },
    hasSeat: async () => (await seatRows())[0]!.n === 1,
  };
}

const RESULT_DRAWN = { type: "boardgame.result", payload: { winner: null, method: "agreement" } } as const;
/** A chess knockout semi drawn into its tie-break (BG-KO-1): phase "tiebreak", status in_play, outcome null. */
async function drawnChessKnockout(r: APIRequestContext) {
  const ko = await staged(r, "boardgame", "classical", "knockout", ["W2b Ana", "W2b Ben", "W2b Cy", "W2b Di"].map((n) => `${n} ${TAG}`));
  await post(r, ko.fx.id, "core.start");
  await post(r, ko.fx.id, RESULT_DRAWN.type, RESULT_DRAWN.payload);
  const drawn = await read(r, ko.fx.id);
  expect(drawn.status, "a drawn chess knockout game awaits its tie-break").toBe("in_play");
  expect(drawn.outcome).toBeNull();
  return ko;
}

const dialogOf = (page: Page) => page.getByTestId("forfeit-dialog");
async function openDialog(page: Page): Promise<Locator> {
  await page.getByTestId("score-forfeit").click({ timeout: 20_000 });
  const d = dialogOf(page);
  await expect(d).toBeVisible({ timeout: 10_000 });
  return d;
}
/** The reasons the open dialog offers, in its own order. */
/** The radio's own label (the input sits inside it). `has:` would scope its inner locator from the dialog again and
 *  match nothing, so the label is the radio's nearest label ancestor. */
const labelOfReason = (d: Locator, reason: string) => d.getByTestId(`forfeit-why-${reason}`).locator("xpath=ancestor::label[1]");
const reasonsShown = async (d: Locator) => d.locator('[data-testid^="forfeit-why-"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")!.slice("forfeit-why-".length)));
const sidesShown = async (d: Locator) => d.locator('[data-testid^="forfeit-who-"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")!.slice("forfeit-who-".length)));

test.describe("W2b — the console's forfeit dialog (Task 11)", () => {
  test("X-RS-1: a walkover before play — Home, Away, Neither; the preview is the engine's credit and a badminton league credits 2-0 × 21-0", async ({ page, request }) => {
    const { fx, home, away } = await badmintonLeague(request);
    expect(fx.status, "never started").toBe("scheduled");
    await page.goto(await fixturePath(request, fx.id));
    const d = await openDialog(page);
    expect(await sidesShown(d)).toEqual(["home", "away", "both"]);
    await expect(d.getByTestId("forfeit-guidance-no-next-match"), "a league has no final to protect").toHaveCount(0);
    await d.getByTestId("forfeit-who-away").click();
    expect(await reasonsShown(d), "before play: a walkover only (withdrew is the cascade's, PF-2)").toEqual(["walkover"]);
    // Design audit 1.1: a side offered one reason has it chosen with the side; Confirm already names it.
    await expect(d.getByTestId("forfeit-why-walkover"), "the one reason is chosen with the side").toBeChecked();
    await expect(d.getByTestId("forfeit-confirm")).toHaveText(ui("forfeitDialog.confirm.walkover"));
    await d.getByTestId("forfeit-why-walkover").check();
    // BD-WO-1: 2-0 in games — the credited headline, not the played 0-0.
    await expect(d.getByTestId("forfeit-preview")).toHaveText(ui("forfeitDialog.preview", { home, homeScore: 2, away, awayScore: 0 }));
    await expect(d.getByTestId("forfeit-confirm")).toHaveText(ui("forfeitDialog.confirm.walkover"));
    await d.getByTestId("forfeit-confirm").click();

    await expect.poll(async () => (await forfeitsIn(request, fx.id)).length, { timeout: 20_000 }).toBe(1);
    expect((await forfeitsIn(request, fx.id))[0]!.payload).toEqual({ by: fx.away_entrant_id, reason: "walkover" });
    await expect(dialogOf(page)).toHaveCount(0);
    await expect(page.getByTestId("score-forfeit"), "decided: no Forfeit").toHaveCount(0, { timeout: 20_000 });
    const after = await read(request, fx.id);
    expect(after.outcome).toMatchObject({ kind: "award", winner: fx.home_entrant_id, reason: "walkover" });
    // The table carries the credit: BD-WO-1 — 2-0 in games, each 21-0.
    await expect
      .poll(async () => {
        const st = await apiJson<{ rows: { entrantId: string; metrics: Record<string, number> }[] }>(request, `/api/v1/stages/${fx.stage_id}/standings`);
        const row = (st.data?.rows ?? []).find((x) => x.entrantId === fx.home_entrant_id);
        return row ? [row.metrics.sets_won, row.metrics.sets_lost, row.metrics.points_won, row.metrics.points_lost] : null;
      }, { timeout: 30_000 })
      .toEqual([2, 0, 42, 0]);
  });

  test("X-RS-1 (rulings 112, 113): a walkover after Start with nothing played — Home, Away, Neither; walkover, disqualified (no retirement); recorded on the started ledger, credited like one before play", async ({ page, request }) => {
    // The stored production shape (ruling 112): the organiser pressed Start, the opponent did not show. Ruling 113:
    // nobody retires from a match never played, so the retirement is not offered until something is.
    const { fx, home, away } = await badmintonLeague(request);
    await post(request, fx.id, "core.start");
    expect((await read(request, fx.id)).status, "started, nothing played").toBe("in_play");
    expect((await ledger(request, fx.id)).map((e) => e.type)).toEqual(["core.start"]);
    await page.goto(await fixturePath(request, fx.id));
    let widths = 0;
    for (const w of [1280, 768, 320]) {
      await page.setViewportSize({ width: w, height: 900 });
      const d = await openDialog(page);
      expect(await sidesShown(d), `${w}: nothing played — Neither is still offered`).toEqual(["home", "away", "both"]);
      await d.getByTestId("forfeit-who-away").click();
      expect(await reasonsShown(d), `${w}: the walkover beside disqualified (R4) — no retirement until something is played (ruling 113); withdrew is the cascade's`).toEqual(["walkover", "disqualified"]);
      await d.getByTestId("forfeit-who-both").click();
      expect(await reasonsShown(d), `${w}: Neither only walks over`).toEqual(["walkover"]);
      await expectNoHorizontalScroll(page);
      await crop(d, "console-forfeit-dialog-after-start", w);
      await page.keyboard.press("Escape");
      await expect(dialogOf(page)).toHaveCount(0);
      widths++;
    }
    expect(widths).toBe(3);
    await page.setViewportSize({ width: 1280, height: 900 });
    const d = await openDialog(page);
    await d.getByTestId("forfeit-who-away").click();
    await d.getByTestId("forfeit-why-walkover").check();
    // BD-WO-1: the walkover credit — 2-0 in games — exactly as before the start (nothing was played).
    await expect(d.getByTestId("forfeit-preview")).toHaveText(ui("forfeitDialog.preview", { home, homeScore: 2, away, awayScore: 0 }));
    await expect(d.getByTestId("forfeit-confirm")).toHaveText(ui("forfeitDialog.confirm.walkover"));
    await d.getByTestId("forfeit-confirm").click();

    await expect.poll(async () => (await forfeitsIn(request, fx.id)).length, { timeout: 20_000 }).toBe(1);
    const rows = await ledger(request, fx.id);
    expect(rows.map((e) => [e.type, e.payload]), "the stored shape: start, then the walkover").toEqual([
      ["core.start", {}],
      ["core.forfeit", { by: fx.away_entrant_id, reason: "walkover" }],
    ]);
    await expect(dialogOf(page)).toHaveCount(0);
    await expect(page.getByTestId("score-forfeit"), "decided: no Forfeit").toHaveCount(0, { timeout: 20_000 });
    expect(await read(request, fx.id)).toMatchObject({ status: "forfeited", outcome: { kind: "award", winner: fx.home_entrant_id, reason: "walkover" } });
    // The page still loads the started walkover (the fold replays it): a reload shows the decided fixture, no error.
    await page.reload();
    await expect(page.getByTestId("score-forfeit")).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByTestId("score-start-match")).toHaveCount(0);
    // The table carries the walkover credit (BD-WO-1 — 2-0 in games, each 21-0), as before the start.
    await expect
      .poll(async () => {
        const st = await apiJson<{ rows: { entrantId: string; metrics: Record<string, number> }[] }>(request, `/api/v1/stages/${fx.stage_id}/standings`);
        const row = (st.data?.rows ?? []).find((x) => x.entrantId === fx.home_entrant_id);
        return row ? [row.metrics.sets_won, row.metrics.sets_lost, row.metrics.points_won, row.metrics.points_lost] : null;
      }, { timeout: 30_000 })
      .toEqual([2, 0, 42, 0]);
  });

  test("X-RS-1 (ruling 112): a retirement once something is played — Neither is gone, the walkover too; the played score stands", async ({ page, request }) => {
    const { fx, home, away } = await badmintonLeague(request);
    await post(request, fx.id, "core.start");
    for (let i = 0; i < 3; i++) await post(request, fx.id, "badminton.rally", { wonBy: fx.home_entrant_id });
    const played = (await apiJson<{ summary: { detail?: { points?: unknown } } }>(request, `/api/v1/fixtures/${fx.id}/state`)).data!.summary.detail?.points;
    expect(played, "the rig scored 3-0 in points").toEqual({ home: 3, away: 0 });
    await page.goto(await fixturePath(request, fx.id));
    const d = await openDialog(page);
    expect(await sidesShown(d), "after play: no Neither").toEqual(["home", "away"]);
    await d.getByTestId("forfeit-who-home").click();
    expect(await reasonsShown(d)).toEqual(["retired", "disqualified"]);
    // Audit 1.3's pair: a match sport keeps the house label.
    await expect(labelOfReason(d, "retired")).toHaveText(ui("forfeitDialog.reason.retired"));
    await d.getByTestId("forfeit-why-retired").check();
    // The home side retired: the away side is credited the match (2-0 in games).
    await expect(d.getByTestId("forfeit-preview")).toHaveText(ui("forfeitDialog.preview", { home, homeScore: 0, away, awayScore: 2 }));
    await expect(d.getByTestId("forfeit-confirm")).toHaveText(ui("forfeitDialog.confirm.retired"));
    await d.getByTestId("forfeit-confirm").click();

    await expect.poll(async () => (await forfeitsIn(request, fx.id)).length, { timeout: 20_000 }).toBe(1);
    expect((await forfeitsIn(request, fx.id))[0]!.payload).toEqual({ by: fx.home_entrant_id, reason: "retired" });
    const rows = await ledger(request, fx.id);
    expect(rows.filter((e) => e.type === "badminton.rally"), "the rallies stay on the ledger").toHaveLength(3);
    expect(rows.filter((e) => e.type === "core.void"), "nothing was voided").toHaveLength(0);
    const after = (await apiJson<{ summary: { detail?: { points?: unknown } } }>(request, `/api/v1/fixtures/${fx.id}/state`)).data!;
    expect(after.summary.detail?.points, "the played score stands").toEqual({ home: 3, away: 0 });
    expect((await read(request, fx.id)).outcome).toMatchObject({ kind: "award", winner: fx.away_entrant_id, reason: "retired" });
  });

  test("X-DW-3: a knockout final shows the guidance instead of Neither; a semi (it feeds the final) offers Neither", async ({ page, request }) => {
    // The positive pair first: a semi-final feeds the final, so a double walkover is the server's to take.
    const semis = await staged(request, "generic", "score", "knockout", ["Ana", "Ben", "Cy", "Di"].map((n) => `${n} ${TAG}`));
    await page.goto(await fixturePath(request, semis.fx.id));
    let d = await openDialog(page);
    expect(await sidesShown(d)).toEqual(["home", "away", "both"]);
    await expect(d.getByTestId("forfeit-guidance-no-next-match")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(dialogOf(page)).toHaveCount(0);

    // A two-entrant knockout IS its final.
    const final = await staged(request, "generic", "score", "knockout", ["Eve", "Fin"].map((n) => `${n} ${TAG}`));
    await page.goto(await fixturePath(request, final.fx.id));
    d = await openDialog(page);
    expect(await sidesShown(d), "no Neither on a final").toEqual(["home", "away"]);
    await expect(d.getByTestId("forfeit-guidance-no-next-match")).toHaveText(ui("forfeitDialog.guidance.noNextMatch"));
    await page.keyboard.press("Escape");
    // The server's own reading agrees: the double walkover the dialog withholds is refused on this fixture.
    const refused = await apiJson(request, `/api/v1/fixtures/${final.fx.id}/events`, "POST", {
      expected_seq: await tip(request, final.fx.id),
      type: "core.forfeit",
      payload: { by: "both", reason: "walkover" },
    });
    expect(refused.error?.code, JSON.stringify(refused.error)).toBe("DOUBLE_WALKOVER_NO_NEXT_MATCH");
    expect(await forfeitsIn(request, final.fx.id)).toHaveLength(0);
  });

  // Review I-2: the console is the FIRST producer of core.forfeit {by:"both"}. Each test drives Neither through the
  // browser and reads what the SERVER stored, then what the table or the next match shows. Expected values are
  // Appendix A's (X-DW-1, X-DW-2, X-DW-4, C-5's bye award), never the module's.
  test("X-DW-1 + X-DW-4: Neither before play records ONE core.forfeit {by: both, walkover}; the league table credits nothing", async ({ page, request }) => {
    // single-sport: X-DW-4 is a product rule; the engine's parity sweep folds every module's double walkover.
    const { fx } = await badmintonLeague(request);
    expect(fx.status, "never started").toBe("scheduled");
    await page.goto(await fixturePath(request, fx.id));
    const posts = countForfeitPosts(page);
    await confirmNeither(page);

    await expect.poll(async () => (await forfeitsIn(request, fx.id)).length, { timeout: 20_000 }).toBe(1);
    expect(posts(), "the page sent one forfeit").toBe(1);
    expect((await forfeitsIn(request, fx.id))[0]!.payload).toEqual({ by: "both", reason: "walkover" });
    expect((await ledger(request, fx.id)).map((e) => e.type), "no core.start: a double walkover is recorded before play").toEqual(["core.forfeit"]);
    await expect(dialogOf(page)).toHaveCount(0);
    await expect(page.getByTestId("score-forfeit"), "decided: no Forfeit").toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByTestId("score-start-match"), "decided: no Start").toHaveCount(0);
    const after = await read(request, fx.id);
    expect([after.status, after.outcome], "X-DW-1: its own outcome, both sides lose").toEqual(["forfeited", { kind: "double_walkover" }]);
    // X-DW-4: P+1, L+1, 0 points for both, no score credited.
    const want = (entrantId: string) => ({ entrantId, played: 1, won: 0, drawn: 0, lost: 1, points: 0, credited: [0, 0, 0, 0] });
    await expect
      .poll(async () => {
        const st = await apiJson<{ rows: { entrantId: string; played: number; won: number; drawn: number; lost: number; points: number; metrics: Record<string, number> }[] }>(
          request,
          `/api/v1/stages/${fx.stage_id}/standings`,
        );
        return (st.data?.rows ?? [])
          .map((r) => ({
            entrantId: r.entrantId, played: r.played, won: r.won, drawn: r.drawn, lost: r.lost, points: r.points,
            // Re-review N-2: a key read must EXIST — a renamed metric would otherwise read as a credited 0.
            credited: ["sets_won", "sets_lost", "points_won", "points_lost"].map((k) => (r.metrics !== undefined && Object.hasOwn(r.metrics, k) ? r.metrics[k] : `no metric ${k}`)),
          }))
          .sort((a, b) => a.entrantId.localeCompare(b.entrantId));
      }, { timeout: 30_000 })
      .toEqual([want(fx.home_entrant_id!), want(fx.away_entrant_id!)].sort((a, b) => a.entrantId.localeCompare(b.entrantId)));
  });

  test("X-DW-1 + X-DW-2: Neither on a semi-final seats nobody in the final; once the other semi is won, the final is that winner's by walkover over a Bye", async ({ page, request }) => {
    // single-sport: the cascade reads the feed graph and the outcome, never the sport (double-walkover-seating.test.ts sweeps it).
    const semis = await staged(request, "generic", "score", "knockout", ["Ana", "Ben", "Cy", "Di"].map((n) => `${n} DW ${TAG}`));
    const sf1 = semis.fx;
    const sf2 = semis.all.find((f) => f.id !== sf1.id && f.home_entrant_id && f.away_entrant_id)!;
    expect(sf2, "the other semi, both seated").toBeTruthy();
    await page.goto(await fixturePath(request, sf1.id));
    const posts = countForfeitPosts(page);
    await confirmNeither(page);

    await expect.poll(async () => (await forfeitsIn(request, sf1.id)).length, { timeout: 20_000 }).toBe(1);
    expect(posts(), "the page sent one forfeit").toBe(1);
    expect((await forfeitsIn(request, sf1.id))[0]!.payload).toEqual({ by: "both", reason: "walkover" });
    const out = await read(request, sf1.id);
    expect([out.status, out.outcome], "X-DW-1").toEqual(["forfeited", { kind: "double_walkover" }]);
    // X-DW-2: the seat it feeds stays empty — neither side advances — and the final waits on the other semi.
    const early = await finalFedBy(sf1.id);
    expect([early.fedSeat, early.status], "nobody seated from the double walkover; the final still scheduled").toEqual([null, "scheduled"]);

    // The other semi is won (home 2-0), so the final's dead seat walks its winner over (X-DW-2, C-5's bye award).
    await post(request, sf2.id, "core.start");
    await post(request, sf2.id, "generic.result", { p1Score: 2, p2Score: 0 });
    expect((await read(request, sf2.id)).outcome).toMatchObject({ kind: "win", winner: sf2.home_entrant_id });
    await expect.poll(async () => (await finalFedBy(sf1.id)).status, { timeout: 20_000 }).toBe("forfeited");
    const final = await finalFedBy(sf1.id);
    expect([final.fedSeat, final.fedLabel], "the dead seat: empty, labelled Bye").toEqual([null, "bracket.slot.bye"]);
    expect((await read(request, final.id)).outcome).toEqual({ kind: "award", winner: sf2.home_entrant_id, loser: null, reason: "bye" });
    // What the next match shows: the winner against a Bye, decided — no Start, no Forfeit.
    await page.goto(await fixturePath(request, final.id));
    const heading = page.locator("header h1").first();
    await expect(heading).toContainText(ui("bracket.slot.bye"), { timeout: 20_000 });
    const winner = semis.nameOf.get(sf2.home_entrant_id!);
    expect(winner, "rig: the other semi's winner has a name").toBeTruthy();
    await expect(heading).toContainText(winner!);
    await expect(page.getByTestId("score-start-match")).toHaveCount(0);
    await expect(page.getByTestId("score-forfeit")).toHaveCount(0);
  });

  test("X-AB-4: a forfeit on a match abandoned under the open dialog is refused — the dialog closes and the console says settle or void", async ({ page, request }) => {
    const { fx } = await badmintonLeague(request);
    await post(request, fx.id, "core.start");
    await page.goto(await fixturePath(request, fx.id));
    const d = await openDialog(page);
    await d.getByTestId("forfeit-who-home").click();
    // Ruling 113: after a bare Start the in-match reason on offer is the disqualification (no retirement before play).
    await d.getByTestId("forfeit-why-disqualified").check();
    // Another device abandons the match while the dialog is open; the console catches up (a tab return).
    await post(request, fx.id, "core.abandon", { reason: "rain" });
    const caughtUp = page.waitForResponse((r) => r.request().method() === "GET" && r.url().includes(`/api/v1/fixtures/${fx.id}/state`));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await caughtUp;
    await expect(dialogOf(page), "the dialog stays open over the refresh — the server judges the send").toBeVisible();
    await d.getByTestId("forfeit-confirm").click();
    await expect(dialogOf(page), "a refusal closes the dialog").toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByTestId("forfeit-refusal")).toHaveText(ui("engineError.ABANDONED_SETTLE_OR_VOID"));
    expect(await forfeitsIn(request, fx.id), "nothing recorded").toHaveLength(0);
    // The API's own answer is the same refusal.
    const direct = await apiJson(request, `/api/v1/fixtures/${fx.id}/events`, "POST", {
      expected_seq: await tip(request, fx.id),
      type: "core.forfeit",
      payload: { by: fx.home_entrant_id, reason: "disqualified" },
    });
    expect(direct.error?.code, JSON.stringify(direct.error)).toBe("ABANDONED_SETTLE_OR_VOID");
  });

  test("BG-WO-3 (W2b-R14): a chess tie-break pending offers one side's walkover, never Neither — and the walkover advances the other side", async ({ page, request }) => {
    const { fx, home, away } = await drawnChessKnockout(request);
    await page.goto(await fixturePath(request, fx.id));
    await expect(page.getByTestId("needs-decision").locator("[data-cause]")).toHaveAttribute("data-cause", "tiebreak");
    await expect(page.getByRole("button", { name: ui("score.abandon"), exact: true }), "held: Abandon stays closed").toHaveCount(0);
    const d = await openDialog(page);
    expect(await sidesShown(d), "R3: never both in a tie-break — the classical game was played").toEqual(["home", "away"]);
    await expect(d.getByTestId("forfeit-guidance-no-next-match")).toHaveCount(0);
    await d.getByTestId("forfeit-who-away").click();
    expect(await reasonsShown(d), "R14 + R4: a walkover in the tie-break, or a retirement / disqualification").toEqual(["walkover", "retired", "disqualified"]);
    await d.getByTestId("forfeit-why-walkover").check();
    // BG-WO-1: chess 1-0.
    await expect(d.getByTestId("forfeit-preview")).toHaveText(ui("forfeitDialog.preview", { home, homeScore: 1, away, awayScore: 0 }));
    await d.getByTestId("forfeit-confirm").click();
    await expect.poll(async () => (await forfeitsIn(request, fx.id)).length, { timeout: 20_000 }).toBe(1);
    expect((await forfeitsIn(request, fx.id))[0]!.payload).toEqual({ by: fx.away_entrant_id, reason: "walkover" });
    expect((await read(request, fx.id)).outcome).toMatchObject({ kind: "award", winner: fx.home_entrant_id });
    await expect.poll(() => seatedInFinal(fx.id), { timeout: 20_000 }).toContain(fx.home_entrant_id);
    await expect(page.getByTestId("needs-decision"), "decided: nothing is held any more").toHaveCount(0, { timeout: 20_000 });
  });

  test("ruling 118: a chess game under way — Start pressed, no move recorded — offers one side's walkover, retirement or disqualification, and Neither; the retirement is recorded and credited 1-0", async ({ page, request }) => {
    // Ruling 118 (owner "A", 2026-10-12): in chess Start means play has begun — Seazn records no moves, so a game in
    // progress is a game played. Single-sport: boardgame is the one module declaring its Start play. The badminton
    // test above is the positive pair: there a bare Start offers no retirement (ruling 113).
    const { fx, home, away } = await staged(request, "boardgame", "classical", "league", ["W2b Eli", "W2b Fay"].map((n) => `${n} ${TAG}`));
    await post(request, fx.id, "core.start");
    expect((await ledger(request, fx.id)).map((e) => e.type), "the Start alone: no move is ever recorded").toEqual(["core.start"]);
    await page.goto(await fixturePath(request, fx.id));
    let widths = 0;
    for (const w of [1280, 768, 320]) {
      await page.setViewportSize({ width: w, height: 900 });
      const d = await openDialog(page);
      expect(await sidesShown(d), `${w}: Neither stays (a double walkover in play, FIDE 6.7.1)`).toEqual(["home", "away", "both"]);
      await d.getByTestId("forfeit-who-away").click();
      expect(await reasonsShown(d), `${w}: walkover (FIDE 6.7.1), retired and disqualified (ruling 118); withdrew is the cascade's`).toEqual(["walkover", "retired", "disqualified"]);
      // Design audit 1.3: beside a dock that records "Resignation", chess's retirement reads in the board's terms.
      await expect(labelOfReason(d, "retired"), `${w}: chess's retirement label`).toHaveText(ui("forfeitDialog.reason.retired.boardgame"));
      await expectNoHorizontalScroll(page);
      await crop(d, "console-forfeit-dialog-chess-after-start", w);
      await page.keyboard.press("Escape");
      await expect(dialogOf(page)).toHaveCount(0);
      widths++;
    }
    expect(widths).toBe(3);
    await page.setViewportSize({ width: 1280, height: 900 });
    const d = await openDialog(page);
    await d.getByTestId("forfeit-who-home").click();
    await d.getByTestId("forfeit-why-retired").check();
    // BG-WO-1: chess 1-0 — the home player retired, so the away player is credited.
    await expect(d.getByTestId("forfeit-preview")).toHaveText(ui("forfeitDialog.preview", { home, homeScore: 0, away, awayScore: 1 }));
    await expect(d.getByTestId("forfeit-confirm")).toHaveText(ui("forfeitDialog.confirm.retired"));
    await d.getByTestId("forfeit-confirm").click();

    await expect.poll(async () => (await forfeitsIn(request, fx.id)).length, { timeout: 20_000 }).toBe(1);
    const rows = await ledger(request, fx.id);
    expect(rows.map((e) => [e.type, e.payload]), "the stored shape: start, then the retirement").toEqual([
      ["core.start", {}],
      ["core.forfeit", { by: fx.home_entrant_id, reason: "retired" }],
    ]);
    await expect(dialogOf(page)).toHaveCount(0);
    await expect(page.getByTestId("score-forfeit"), "decided: no Forfeit").toHaveCount(0, { timeout: 20_000 });
    expect(await read(request, fx.id)).toMatchObject({ status: "forfeited", outcome: { kind: "award", winner: fx.away_entrant_id, reason: "retired" } });
  });

  test("Review Focus 4: a double tap on Confirm sends ONE core.forfeit; a second page's Confirm is refused and says why", async ({ page, request }) => {
    const { fx } = await badmintonLeague(request);
    const second = await page.context().newPage();
    try {
      const path = await fixturePath(request, fx.id);
      await page.goto(path);
      await second.goto(path);
      const posts1 = countForfeitPosts(page);
      const posts2 = countForfeitPosts(second);
      const d1 = await openDialog(page);
      const d2 = await openDialog(second);
      for (const d of [d1, d2]) {
        await d.getByTestId("forfeit-who-home").click();
        await d.getByTestId("forfeit-why-walkover").check();
      }
      // The premise, made a guard rather than a hope: the second page has NOT heard the first one's forfeit when its
      // organiser confirms (it holds the ledger it opened the dialog on — a stale device). The sibling test below is
      // the other side of that race: a second page that HAS heard it.
      const stale = await holdFixtureReads(second, fx.id);
      await d1.getByTestId("forfeit-confirm").dblclick();
      await expect.poll(async () => (await forfeitsIn(request, fx.id)).length, { timeout: 20_000 }).toBe(1);
      expect(posts1(), "the page sent one forfeit for a double tap").toBe(1);
      await d2.getByTestId("forfeit-confirm").click();
      await stale.release();
      // Informational only (design review M-5): how many reads the stale page had parked. The race is proven by the
      // assertions below — the second page's refusal and ONE forfeit on the ledger — not by this count.
      console.log(`Review Focus 4: page 2 reads held while stale: ${stale.held()}`);
      await expect(dialogOf(second), "the refusal closed the second dialog").toHaveCount(0, { timeout: 20_000 });
      await expect(second.getByTestId("forfeit-refusal")).toHaveText(ui("score.seqConflict"));
      expect(posts2()).toBe(1);
      expect(await forfeitsIn(request, fx.id), "one forfeit on the ledger").toHaveLength(1);
    } finally {
      await second.close();
    }
  });

  test("Review Focus 4, the other side of the race: a second page that has HEARD the first forfeit is refused as already decided, and says so", async ({ page, request }) => {
    const { fx } = await badmintonLeague(request);
    const second = await page.context().newPage();
    try {
      const path = await fixturePath(request, fx.id);
      await page.goto(path);
      await second.goto(path);
      const posts2 = countForfeitPosts(second);
      const d1 = await openDialog(page);
      const d2 = await openDialog(second);
      for (const d of [d1, d2]) {
        await d.getByTestId("forfeit-who-home").click();
        await d.getByTestId("forfeit-why-walkover").check();
      }
      await d1.getByTestId("forfeit-confirm").click();
      await expect.poll(async () => (await forfeitsIn(request, fx.id)).length, { timeout: 20_000 }).toBe(1);
      // The tab-return refresh (`refreshIfVisible`) — the live channel's push, made deterministic. The second page now
      // holds the decided match; its open dialog is a snapshot and stays (the server judges the send).
      const resynced = second.waitForResponse((r) => r.url().endsWith(`/api/v1/fixtures/${fx.id}/state`) && r.request().method() === "GET");
      await second.evaluate(() => window.dispatchEvent(new Event("focus")));
      await resynced;
      await expect(second.getByTestId("score-forfeit"), "the second page has heard: decided, no Forfeit").toHaveCount(0, { timeout: 20_000 });
      await expect(d2, "the open dialog is a snapshot").toBeVisible();
      await d2.getByTestId("forfeit-confirm").click();
      await expect(dialogOf(second), "the refusal closed the second dialog").toHaveCount(0, { timeout: 20_000 });
      await expect(second.getByTestId("forfeit-refusal")).toHaveText(ui("engineError.ALREADY_DECIDED"));
      expect(posts2()).toBe(1);
      expect(await forfeitsIn(request, fx.id), "one forfeit on the ledger").toHaveLength(1);
    } finally {
      await second.close();
    }
  });

  test("X-RS-3: an official scorer sees no Forfeit — before play, and on a pending chess tie-break where the organiser does", async ({ browser, page, request }) => {
    const pre = await badmintonLeague(request);
    const tb = await drawnChessKnockout(request);
    // The positive pair: the organiser is offered the Forfeit on both.
    for (const id of [pre.fx.id, tb.fx.id]) {
      await page.goto(await fixturePath(request, id));
      await expect(page.getByTestId("score-forfeit")).toBeVisible({ timeout: 20_000 });
    }
    for (const id of [pre.fx.id, tb.fx.id]) {
      const official = await officialScorerPage(browser, id);
      try {
        const p = official.page;
        await p.goto(await fixturePath(request, id));
        await dismissCookieBanner(p);
        await expect(p.getByRole("link", { name: /My matches/ }), "a scorer here, not a bare viewer").toBeVisible();
        await expect(p.getByTestId("score-forfeit")).toHaveCount(0);
        await expect(p.getByTestId("forfeit-dialog")).toHaveCount(0);
        expect(await official.hasSeat(), "while the official's page is open it holds a team seat (so the release below is not vacuous)").toBe(true);
      } finally {
        await official.close();
      }
      expect(await official.hasSeat(), "closing the official's page frees the team seat it took (Pro members.max is one pool for the whole shard)").toBe(false);
    }
  });

  test("the dialog at 1280, 768 and 320 — before play, after play, a final's guidance: no horizontal scroll, every choice and Confirm reachable", async ({ page, request }) => {
    const longA = `Alexandria Konstantinopoulou-Vanderbilt ${TAG}`;
    const longB = `Maximiliano Wolfeschlegelsteinhausen ${TAG}`;
    const before = await staged(request, "badminton", "bwf", "league", [longA, longB]);
    const afterPlay = await staged(request, "badminton", "bwf", "league", [`${longA} II`, `${longB} II`]);
    await post(request, afterPlay.fx.id, "core.start");
    // Ruling 113: "after play" means something played — a rally — or the retirement below is not on offer.
    await post(request, afterPlay.fx.id, "badminton.rally", { wonBy: afterPlay.fx.home_entrant_id! });
    const final = await staged(request, "generic", "score", "knockout", [`${longA} III`, `${longB} III`]);
    const screens = [
      { name: "t11-before-play", id: before.fx.id, who: "away", why: "walkover" },
      { name: "t11-after-play", id: afterPlay.fx.id, who: "home", why: "retired" },
      { name: "t11-final-guidance", id: final.fx.id, who: "home", why: "walkover" },
    ] as const;
    let checked = 0;
    for (const width of [1280, 768, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const s of screens) {
        await page.goto(await fixturePath(request, s.id));
        await dismissCookieBanner(page);
        const d = await openDialog(page);
        await d.getByTestId(`forfeit-who-${s.who}`).click();
        await d.getByTestId(`forfeit-why-${s.why}`).check();
        await expect(d.getByTestId("forfeit-preview")).toBeVisible();
        await expectNoHorizontalScroll(page);
        // Every choice is inside the viewport's width, and Confirm is the element a tap at its centre lands on.
        for (const el of await d.locator('[data-testid^="forfeit-who-"], [data-testid^="forfeit-why-"], [data-testid="forfeit-confirm"]').all()) {
          await el.scrollIntoViewIfNeeded();
          const box = (await el.boundingBox())!;
          expect(box.x, `${s.name} ${width}: inside the left edge`).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width, `${s.name} ${width}: inside the right edge`).toBeLessThanOrEqual(width + 1);
        }
        // Loop H F3: the who chips wrap at WORD boundaries. Every unbreakable run of every chip's name sits in ONE line box
        // (a run broken across two lines has two rects at two heights), unless the run alone is wider than its label —
        // the last resort `break-words` keeps. A run ends at whitespace or AFTER a hyphen (UAX #14's break opportunity):
        // "Konstantinopoulou-" / "Vanderbilt" is word wrapping, a break inside "Konstantinopoulou" is not. The long
        // surname must be among the runs measured, never excused.
        const words = await d.locator('[data-testid^="forfeit-who-"] > span').evaluateAll((spans) => {
          const out = { measured: [] as string[], broken: [] as string[], excused: [] as string[] };
          for (const span of spans) {
            const label = span.getBoundingClientRect().width;
            const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
            for (let n = walker.nextNode(); n; n = walker.nextNode()) {
              for (const m of (n.textContent ?? "").matchAll(/[^\s-]+-*/g)) {
                const range = document.createRange();
                range.setStart(n, m.index!);
                range.setEnd(n, m.index! + m[0].length);
                const rects = [...range.getClientRects()].filter((r) => r.width > 0);
                const width = rects.reduce((sum, r) => sum + r.width, 0);
                if (width > label) {
                  out.excused.push(m[0]);
                  continue;
                }
                out.measured.push(m[0]);
                if (new Set(rects.map((r) => Math.round(r.top))).size > 1) {
                  out.broken.push(`${m[0]} ${JSON.stringify(rects.map((r) => [Math.round(r.left), Math.round(r.top), Math.round(r.width)]))} in a ${Math.round(label)}px label`);
                }
              }
            }
          }
          return out;
        });
        expect(words.broken, `${s.name} ${width}: no word of a chip's name breaks across lines`).toEqual([]);
        expect(words.measured, `${s.name} ${width}: the long surnames are measured, not excused`).toEqual(
          expect.arrayContaining(["Wolfeschlegelsteinhausen", "Konstantinopoulou-", "Vanderbilt"]),
        );
        expect(words.excused, `${s.name} ${width}: no word here is wider than its label`).toEqual([]);
        const confirm = d.getByTestId("forfeit-confirm");
        await confirm.scrollIntoViewIfNeeded();
        const hit = await confirm.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === el;
        });
        expect(hit, `${s.name} ${width}: Confirm is hit-testable`).toBe(true);
        await crop(d, s.name, width);
        await page.keyboard.press("Escape");
        await expect(dialogOf(page)).toHaveCount(0);
        checked++;
      }
    }
    expect(checked, `screens checked: ${checked}`).toBe(9);
    // Nothing was confirmed: the screens wrote no forfeit.
    for (const s of screens) expect(await forfeitsIn(request, s.id), s.name).toHaveLength(0);
  });
});

// W2c Task 16b (X-WO-1 B, Task 9 P-3 "A"): the console previews the number the table WILL carry. A football pool whose
// stage points rule awards a walkover score previews the RULE's figures for a walkover with nothing played, and the
// confirmed walkover stores the same. The rule's winner figure is the division's plus 4 and the absent side's is 1, so a
// dialog still previewing the division's own credit fails on both figures.
test.describe("W2c Task 16b — the forfeit dialog previews the stage rule's walkover award", () => {
  test("X-WO-1 B: Away does not turn up — the preview is the rule's award, and the stored result says the same", async ({ page, request }) => {
    const football = builtinModules.find((m) => m.key === "football")!;
    const divisionGoals = (football.configSchema.parse(football.variants["11-a-side"]) as { awardScore: { goals: number } }).awardScore.goals;
    const award: [number, number] = [divisionGoals + 4, 1];
    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `W2c T16b ${TAG}-${Math.random().toString(36).slice(2, 6)}`,
      visibility: "private",
    });
    const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
      name: "Pool", sport_key: "football", variant_key: "11-a-side",
    });
    const names = [`Asha FC ${TAG}`, `Bala FC ${TAG}`];
    const added = await addEntrantsViaApi(request, div.data!.id, names, "team");
    expect(added.ids).toHaveLength(2);
    const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${div.data!.id}/stages`, "POST", { seq: 1, kind: "league", name: "Pool" });
    const put = await apiJson(request, `/api/v1/stages/${stage.data!.id}/rules`, "PUT", {
      points: { base: { win: 3, draw: 1, loss: 0 }, bonuses: [], forfeit: { winnerPoints: 3, loserPoints: 0, awardScore: award } },
    });
    expect(put.status, JSON.stringify(put.error)).toBe(200);
    const gen = await apiJson<{ fixtures: { id: string }[] }>(request, `/api/v1/stages/${stage.data!.id}/generate`, "POST");
    const started = await apiJson(request, `/api/v1/divisions/${div.data!.id}/start`, "POST");
    expect(started.status, JSON.stringify(started.error)).toBeLessThan(300);
    const fx = await read(request, gen.data!.fixtures[0]!.id);
    const nameOf = new Map(added.ids.map((id, i) => [id, names[i]!]));
    const home = nameOf.get(fx.home_entrant_id!)!;
    const away = nameOf.get(fx.away_entrant_id!)!;
    expect(award[0], "the premise: the rule's winner figure is not the division's").not.toBe(divisionGoals);

    await page.goto(await fixturePath(request, fx.id));
    const d = await openDialog(page);
    await d.getByTestId("forfeit-who-away").click();
    await d.getByTestId("forfeit-why-walkover").check();
    await expect(d.getByTestId("forfeit-preview"), "the preview is the rule's award, the side that turned up first").toHaveText(
      ui("forfeitDialog.preview", { home, homeScore: award[0], away, awayScore: award[1] }),
    );
    await d.getByTestId("forfeit-confirm").click();
    await expect.poll(async () => (await forfeitsIn(request, fx.id)).length, { timeout: 20_000 }).toBe(1);
    const state = await apiJson<{ summary: { perSide: { line: string }[] } }>(request, `/api/v1/fixtures/${fx.id}/state`);
    expect(state.data!.summary.perSide.map((p) => p.line), "the stored result is what the dialog said").toEqual([String(award[0]), String(award[1])]);
  });
});
