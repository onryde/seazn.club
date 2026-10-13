import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { TAG, apiJson, expectNoHorizontalScroll, linkPersonToUserBySql, loginUi } from "./helpers";
import { withDb } from "./rs007-money-kit";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// W2b R115-4 — the two surfaces players actually look at, /me and the public player card, ask the read-side stats
// check, so a snapshot folded under an older fold version (R115-2's `STATS_FOLD_VERSION`) is refolded once a player
// looks at it. Driven through the real product: results go through POST /api/v1/fixtures/{id}/events, the console
// leaderboard read folds the snapshot, and then the snapshot is put back to what an older build left behind. That
// means stale numbers (every value off by five) and a fold record whose inputs md5 is not this build's. The DB test
// (player-stats-read-side-check-r115-4) pins the exact pre-version md5; any mismatch takes the same path.
//
// Design (R115-4): the check runs after the response and never folds on the request. So the first visit shows the
// rows as they stood, the check refolds the division in the background, and a later visit shows the refold. This spec
// records what each visit SHOWS and when the refold landed, rather than assuming it. Measured 2026-10-12: /me (dynamic)
// is fresh on the very next visit. The card (ISR) is not: its refold runs inside the page's cache scope, where the ISR
// tags cannot be cleared, so the card shows the refold once its own `revalidate` window lapses (fresh at 318 s).
//
// Scene, per surface (two competitions, so neither surface's once-a-minute throttle hides the other's check): a
// generic league of four, where Pat has a played win and a walkover win. X-PS-1 gives Pat wins 1, losses 0 (no
// losses tile: zero tiles are dropped).

interface Fixture { id: string; home_entrant_id: string | null; away_entrant_id: string | null }

async function post(request: APIRequestContext, fixtureId: string, seq: { n: number }, type: string, payload: unknown) {
  const res = await apiJson<{ seq: number }>(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", { expected_seq: seq.n, type, payload });
  expect(res.status, `${type} refused: ${JSON.stringify(res.error)}`).toBeLessThan(300);
  seq.n = res.data!.seq;
}

async function seedScene(request: APIRequestContext, label: string) {
  const person = async (n: string) =>
    (await apiJson<{ id: string }>(request, "/api/v1/persons", "POST", { full_name: `${n} ${TAG}`, consent: { public_name: true } })).data!.id;
  const pat = await person(`Pat ${label}`);
  const opponents = [await person(`${label} Opp 1`), await person(`${label} Opp 2`), await person(`${label} Opp 3`)];
  const comp = await apiJson<{ id: string; slug: string; org_id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Stale ${label} ${TAG}`,
    visibility: "public",
  });
  expect(comp.status).toBeLessThan(300);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Gen",
    sport_key: "generic",
    variant_key: "score",
  });
  const divisionId = div.data!.id;
  const ents = await apiJson<{ id: string }[]>(
    request,
    `/api/v1/divisions/${divisionId}/entrants`,
    "POST",
    [pat, ...opponents].map((person_id, i) => ({ kind: "individual", display_name: `${label} E${i} ${TAG}`, seed: i + 1, members: [{ person_id }] })),
  );
  const patE = ents.data![0]!.id;
  const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", { seq: 1, kind: "league", name: "League" });
  const gen = await apiJson<{ fixtures: Fixture[] }>(request, `/api/v1/stages/${stage.data!.id}/generate`, "POST");
  await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  const mine = gen.data!.fixtures.filter((f) => f.home_entrant_id === patE || f.away_entrant_id === patE);
  expect(mine.length, `${label}: Pat meets three opponents`).toBe(3);
  const [played, walkover] = mine;
  const s1 = { n: 0 };
  await post(request, played!.id, s1, "core.start", {});
  const home = played!.home_entrant_id === patE;
  await post(request, played!.id, s1, "generic.result", home ? { p1Score: 3, p2Score: 1 } : { p1Score: 1, p2Score: 3 });
  const woOpp = walkover!.home_entrant_id === patE ? walkover!.away_entrant_id! : walkover!.home_entrant_id!;
  await post(request, walkover!.id, { n: 0 }, "core.forfeit", { by: woOpp, reason: "walkover" });
  // The console leaderboard read folds the snapshot under this build's version.
  const board = await apiJson<{ rows: { person_id: string; stats: Record<string, number> }[] }>(request, `/api/v1/divisions/${divisionId}/stats/players`);
  expect(board.status).toBe(200);
  const right = board.data!.rows.find((r) => r.person_id === pat)!.stats;
  expect([right.wins, right.losses ?? 0], `${label}: X-PS-1 for Pat`).toEqual([1, 0]);
  return { pat, divisionId, right, comp: comp.data! };
}

/** What an older build left behind: the rows it folded (every value off by five) and its fold record's md5. */
async function age(divisionId: string, personId: string, right: Record<string, number>) {
  const stale = Object.fromEntries(Object.entries(right).map(([k, v]) => [k, v + 5]));
  await withDb(async (sql) => {
    await sql`update player_stat_snapshots set stats = ${sql.json(stale as never)} where division_id = ${divisionId} and person_id = ${personId}`;
    await sql`update player_stat_folds set inputs_md5 = 'folded-before-STATS_FOLD_VERSION' where division_id = ${divisionId}`;
  });
  return stale;
}

const storedWins = (divisionId: string, personId: string) =>
  withDb(async (sql) => {
    const [row] = await sql<{ wins: number; md5: string }[]>`
      select (ps.stats->>'wins')::int as wins, pf.inputs_md5 as md5
      from player_stat_snapshots ps join player_stat_folds pf on pf.division_id = ps.division_id
      where ps.division_id = ${divisionId} and ps.person_id = ${personId}`;
    return row!;
  });

/** dt → dd of one card. */
async function readTiles(page: Page, card: ReturnType<Page["getByTestId"]>): Promise<string> {
  const dts = (await card.locator("dt").allInnerTexts()).map((x) => x.trim().toLowerCase());
  const dds = (await card.locator("dd").allInnerTexts()).map((x) => x.trim());
  const got = Object.fromEntries(dts.map((k, i) => [k, dds[i]!]));
  return `W ${got["wins"] ?? "-"} L ${got["losses"] ?? "-"}`;
}

test("R115-4: /me and the public card refold an old-version snapshot after the first visit; /me is fresh on the next visit, the card within its ISR window", async ({ page, browser }) => {
  test.setTimeout(600_000);
  const seen: string[] = [];

  // ---- /me -------------------------------------------------------------------------------------------------------
  const a = await seedScene(page.request, "Me");
  const playerCtx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const me = await playerCtx.newPage();
  await loginUi(me, `delivered+pat-stale-${TAG}@resend.dev`, "/me");
  const whoami = await apiJson<{ id: string }>(me.request, "/api/users/me");
  await linkPersonToUserBySql(a.pat, whoami.data!.id);
  const staleA = await age(a.divisionId, a.pat, a.right);
  expect((await storedWins(a.divisionId, a.pat)).wins, "/me: the stale row is in place").toBe(staleA.wins);

  await me.setViewportSize({ width: 1280, height: 900 });
  await me.goto("/me");
  const career = me.getByTestId("career-sport-generic");
  await expect(career).toBeVisible({ timeout: 20_000 });
  const meBefore = await readTiles(me, career);
  expect(meBefore, "/me first visit: the rows as they stood").toBe(`W ${staleA.wins} L ${staleA.losses ?? "-"}`);
  const t0 = Date.now();
  await expect.poll(async () => (await storedWins(a.divisionId, a.pat)).wins, { timeout: 30_000 }).toBe(a.right.wins);
  const meFoldMs = Date.now() - t0;
  expect((await storedWins(a.divisionId, a.pat)).md5, "/me: restamped").not.toBe("folded-before-STATS_FOLD_VERSION");
  await me.reload();
  await expect(career).toBeVisible({ timeout: 20_000 });
  const meAfter = await readTiles(me, career);
  expect(meAfter, "/me second visit: fresh").toBe("W 1 L -");
  await expectNoHorizontalScroll(me);
  seen.push(`/me career generic: before "${meBefore}", after "${meAfter}" (refold landed ${meFoldMs} ms after the first visit)`);
  await playerCtx.close();

  // ---- the public player card ------------------------------------------------------------------------------------
  const b = await seedScene(page.request, "Card");
  const staleB = await age(b.divisionId, b.pat, b.right);
  const orgs = await apiJson<{ id: string; slug: string }[]>(page.request, "/api/orgs");
  const orgSlug = orgs.data!.find((o) => o.id === b.comp.org_id)!.slug;
  const anonCtx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const anon = await anonCtx.newPage();
  await anon.setViewportSize({ width: 1280, height: 900 });
  const url = `/shared/${orgSlug}/${b.comp.slug}/players/${b.pat}`;
  const tile = () => anon.getByTestId("player-stats").locator("div", { has: anon.getByRole("link", { name: "Gen", exact: true }) }).last();
  await anon.goto(url, { waitUntil: "load" });
  await expect(tile()).toBeVisible({ timeout: 20_000 });
  const cardBefore = await readTiles(anon, tile());
  expect(cardBefore, "card first visit: the rows as they stood").toBe(`W ${staleB.wins} L ${staleB.losses ?? "-"}`);
  const t1 = Date.now();
  await expect.poll(async () => (await storedWins(b.divisionId, b.pat)).wins, { timeout: 30_000 }).toBe(b.right.wins);
  const cardFoldMs = Date.now() - t1;
  expect((await storedWins(b.divisionId, b.pat)).md5, "card: restamped").not.toBe("folded-before-STATS_FOLD_VERSION");
  // The second visit, straight after the refold. RECORDED, not asserted either way: the card is ISR, and the refold
  // its own after-response check ran could not clear the ISR tags from inside the page's cache scope (the server logs
  // "the ISR tags could not be cleared from here"), so the page entry rendered on the first visit stands until its
  // `revalidate` window lapses.
  const visit = async () => {
    await anon.goto(url, { waitUntil: "load" });
    await expect(tile()).toBeVisible({ timeout: 20_000 });
    return readTiles(anon, tile());
  };
  const second = await visit();
  // The bound the product does promise: the page's own declared `revalidate` (read from the page, not typed here),
  // then one stale-while-revalidate visit to start the regeneration, then the fresh one.
  const pageSrc = readFileSync(fileURLToPath(new URL("../src/app/(public)/shared/[orgSlug]/[competitionSlug]/players/[personId]/page.tsx", import.meta.url)), "utf8");
  const revalidateS = Number(/^export const revalidate = (\d+);/m.exec(pageSrc)?.[1]);
  expect(revalidateS, "the card page declares its ISR window").toBeGreaterThan(0);
  const visits: string[] = [`${Math.round((Date.now() - t1) / 1000)}s:${second}`];
  let cardAfter = second;
  if (cardAfter !== "W 1 L -") {
    await anon.waitForTimeout(Math.max(0, t1 + revalidateS * 1000 - Date.now()));
    const deadline = t1 + (revalidateS + 30) * 1000;
    while (cardAfter !== "W 1 L -" && Date.now() < deadline) {
      cardAfter = await visit();
      visits.push(`${Math.round((Date.now() - t1) / 1000)}s:${cardAfter}`);
      if (cardAfter !== "W 1 L -") await anon.waitForTimeout(5_000);
    }
  }
  await expectNoHorizontalScroll(anon);
  seen.push(
    `public card Gen: before "${cardBefore}", refold landed ${cardFoldMs} ms after the first visit; ` +
      `second visit "${second}"; visits (s after the first visit) ${visits.join(", ")}; ISR window ${revalidateS}s`,
  );
  await anonCtx.close();
  test.info().annotations.push({ type: "numbers", description: seen.join(" | ") });
  expect(cardAfter, `card: fresh within its ISR window (${revalidateS}s) plus one regenerating visit`).toBe("W 1 L -");
});
