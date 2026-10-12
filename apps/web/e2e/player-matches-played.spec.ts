import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { TAG, apiJson, expectNoHorizontalScroll, linkPersonToUserBySql, loginUi } from "./helpers";
import { withDb } from "./rs007-money-kit";

// W2b R115-1 (X-PS-1, X-PS-2, ruling 115) — a person's matches and W/L count only matches PLAYED, on every surface a
// person reads them: the /me Career cards, the public player card's career rollup, its per-division stats and its
// match list, and the console's ?group=sport API. Driven through the real product: every result below is recorded
// through POST /api/v1/fixtures/{id}/events, the organiser's own door.
//
// One player, per division, against six opponents in a seven-entrant league:
//   1. a played win · 2. a walkover win · 3. a walkover loss · 4. a DQ of the player after a bare Start ·
//   5. a DQ of the player after play · 6. a double walkover the withdrawal cascade writes WITHOUT an event.
// Per division the rules leave matches 2 (1 and 5), one win (1), one loss (5) — the walkovers, the DQ with nothing
// played and the double walkover are no match for anyone (X-PS-1, ruling 115); the DQ after play counts (X-PS-2).
//
// Two badminton divisions (so the public card's career rollup exists — it shows only where it aggregates) and one
// generic division (W/D/L tiles). Expected, from those rules: badminton 4 matches, generic 2 matches with W 1 · L 1,
// six match lines on the public card, three won and three lost.

interface Fixture { id: string; home_entrant_id: string | null; away_entrant_id: string | null }
type Side = "home" | "away";

const SPORTS = {
  badminton: {
    variant: "bwf",
    win: (mine: Side) => {
      const game = mine === "home" ? { home: 21, away: 10 } : { home: 10, away: 21 };
      return [{ type: "badminton.game.summary", payload: game }, { type: "badminton.game.summary", payload: game }];
    },
    play: (opp: string) => ({ type: "badminton.rally", payload: { wonBy: opp } }),
  },
  generic: {
    variant: "score",
    win: (mine: Side) => [{ type: "generic.result", payload: mine === "home" ? { p1Score: 3, p2Score: 1 } : { p1Score: 1, p2Score: 3 } }],
    play: (opp: string) => ({ type: "generic.score", payload: { by: opp, points: 1 } }),
  },
} as const;

async function post(request: APIRequestContext, fixtureId: string, seq: { n: number }, type: string, payload: unknown) {
  const res = await apiJson<{ seq: number }>(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: seq.n,
    type,
    payload,
  });
  expect(res.status, `${type} refused: ${JSON.stringify(res.error)}`).toBeLessThan(300);
  seq.n = res.data!.seq;
}

/** One division of the scene; returns the six scenario fixture ids in order. */
async function seedDivision(
  request: APIRequestContext,
  competitionId: string,
  sport: keyof typeof SPORTS,
  name: string,
  pat: string,
  opponents: string[],
): Promise<{ divisionId: string; scenario: string[] }> {
  const s = SPORTS[sport];
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${competitionId}/divisions`, "POST", {
    name,
    sport_key: sport,
    variant_key: s.variant,
  });
  expect(div.status, `division: ${JSON.stringify(div.error)}`).toBeLessThan(300);
  const divisionId = div.data!.id;
  const ents = await apiJson<{ id: string }[]>(
    request,
    `/api/v1/divisions/${divisionId}/entrants`,
    "POST",
    [pat, ...opponents].map((person_id, i) => ({ kind: "individual", display_name: `${name} E${i} ${TAG}`, seed: i + 1, members: [{ person_id }] })),
  );
  expect(ents.status, `entrants: ${JSON.stringify(ents.error)}`).toBeLessThan(300);
  const patE = ents.data![0]!.id;
  const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", { seq: 1, kind: "league", name: "League" });
  const gen = await apiJson<{ fixtures: Fixture[] }>(request, `/api/v1/stages/${stage.data!.id}/generate`, "POST");
  expect(gen.status).toBeLessThan(300);
  await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  const mine = gen.data!.fixtures.filter(
    (f) => f.home_entrant_id !== null && f.away_entrant_id !== null && (f.home_entrant_id === patE || f.away_entrant_id === patE),
  );
  expect(mine.length, `${name}: Pat meets each opponent once`).toBe(6);

  const scenario: string[] = [];
  for (const [i, f] of mine.entries()) {
    const side: Side = f.home_entrant_id === patE ? "home" : "away";
    const opp = side === "home" ? f.away_entrant_id! : f.home_entrant_id!;
    const seq = { n: 0 };
    scenario.push(f.id);
    if (i === 0) {
      await post(request, f.id, seq, "core.start", {});
      for (const e of s.win(side)) await post(request, f.id, seq, e.type, e.payload);
    } else if (i === 1) {
      await post(request, f.id, seq, "core.forfeit", { by: opp, reason: "walkover" });
    } else if (i === 2) {
      await post(request, f.id, seq, "core.forfeit", { by: patE, reason: "walkover" });
    } else if (i === 3) {
      await post(request, f.id, seq, "core.start", {});
      await post(request, f.id, seq, "core.forfeit", { by: patE, reason: "disqualified" });
    } else if (i === 4) {
      await post(request, f.id, seq, "core.start", {});
      const p = s.play(opp);
      await post(request, f.id, seq, p.type, p.payload);
      await post(request, f.id, seq, "core.forfeit", { by: patE, reason: "disqualified" });
    } else {
      // The withdrawal cascade's no-event double walkover (stages.ts, the `dw` mode), its own statement.
      await withDb(async (sql) => {
        await sql`update fixtures set status = 'forfeited', outcome = ${sql.json({ kind: "double_walkover" } as never)}
                  where id = ${f.id} and status in ('scheduled', 'in_play', 'needs_decision', 'abandoned')`;
      });
    }
  }
  // The leaderboard read writes the snapshot (career surfaces are snapshot-only by design).
  const board = await apiJson(request, `/api/v1/divisions/${divisionId}/stats/players`);
  expect(board.status).toBe(200);
  return { divisionId, scenario };
}

/** dt → dd of one card, read off the page. */
async function tiles(page: Page, testId: string): Promise<Record<string, string>> {
  const card = page.getByTestId(testId);
  const dts = (await card.locator("dt").allInnerTexts()).map((x) => x.trim().toLowerCase());
  const dds = (await card.locator("dd").allInnerTexts()).map((x) => x.trim());
  return Object.fromEntries(dts.map((k, i) => [k, dds[i]!]));
}

test("R115-1: /me, the public player card and the console count only matches played (X-PS-1, X-PS-2, ruling 115)", async ({ page, browser }, testInfo) => {
  test.setTimeout(240_000);
  const person = async (n: string) =>
    (await apiJson<{ id: string }>(page.request, "/api/v1/persons", "POST", { full_name: `${n} ${TAG}`, consent: { public_name: true } })).data!.id;
  const pat = await person("Pat Played");
  const opponents: string[] = [];
  for (let i = 1; i <= 6; i++) opponents.push(await person(`Opp ${i}`));
  const comp = await apiJson<{ id: string; slug: string; org_id: string }>(page.request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Played ${TAG}`,
    visibility: "public",
  });
  const competitionId = comp.data!.id;
  const b1 = await seedDivision(page.request, competitionId, "badminton", "Bad A", pat, opponents);
  const b2 = await seedDivision(page.request, competitionId, "badminton", "Bad B", pat, opponents);
  const g = await seedDivision(page.request, competitionId, "generic", "Gen", pat, opponents);
  const played = [b1, b2, g].flatMap((d) => [d.scenario[0]!, d.scenario[4]!]);
  const unplayed = [b1, b2, g].flatMap((d) => [1, 2, 3, 5].map((i) => d.scenario[i]!));
  expect(played.length + unplayed.length, "scenario fixtures").toBe(18);

  // ---- the console API (?group=sport): the org-scoped career ---------------------------------------------------
  const career = await apiJson<{ sports: { sport_key: string; matches: number; metrics: { key: string; value: number }[] }[] }>(
    page.request,
    `/api/v1/persons/${pat}/stats?group=sport`,
  );
  expect(career.status).toBe(200);
  const bySport = Object.fromEntries(career.data!.sports.map((s) => [s.sport_key, s]));
  expect(bySport.badminton?.matches, "console: badminton matches").toBe(4);
  expect(bySport.generic?.matches, "console: generic matches").toBe(2);
  const gm = (k: string) => bySport.generic?.metrics.find((m) => m.key === k)?.value ?? 0;
  expect([gm("wins"), gm("draws"), gm("losses")], "console: generic W/D/L").toEqual([1, 0, 1]);

  const seen: string[] = [];
  // ---- /me, as the player: a fresh login, the person linked to it -----------------------------------------------
  const playerCtx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const me = await playerCtx.newPage();
  const email = `pat-played-${TAG}@example.com`;
  await loginUi(me, email, "/me");
  const whoami = await apiJson<{ id: string }>(me.request, "/api/users/me");
  expect(whoami.status).toBe(200);
  await linkPersonToUserBySql(pat, whoami.data!.id);
  await me.goto("/me");
  // A fresh context meets the cookie banner, which would sit over the crops below.
  await me.getByTestId("cookie-accept").click();
  for (const width of [1280, 768, 320]) {
    await me.setViewportSize({ width, height: 900 });
    await expect(me.getByTestId("me-career")).toBeVisible({ timeout: 20_000 });
    const bad = me.getByTestId("career-sport-badminton");
    const gen = me.getByTestId("career-sport-generic");
    await expect(bad).toContainText("4 matches");
    await expect(gen).toContainText("2 matches");
    const t = await tiles(me, "career-sport-generic");
    expect([t["wins"], t["draws"] ?? "0", t["losses"]], `/me generic W/D/L at ${width}`).toEqual(["1", "0", "1"]);
    await expectNoHorizontalScroll(me);
    seen.push(`/me@${width}: badminton "${(await bad.locator("p").nth(1).innerText()).trim()}", generic "${(await gen.locator("p").nth(1).innerText()).trim()}" W ${t["wins"]} D ${t["draws"] ?? "-"} L ${t["losses"]}`);
    await me.getByTestId("me-career").screenshot({ path: testInfo.outputPath(`me-career-${width}.png`) });
  }
  await playerCtx.close();

  // ---- the public player card, anonymous ------------------------------------------------------------------------
  const orgs = await apiJson<{ id: string; slug: string }[]>(page.request, "/api/orgs");
  const orgSlug = orgs.data!.find((o) => o.id === comp.data!.org_id)!.slug;
  const anonCtx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const anon = await anonCtx.newPage();
  await anon.goto(`/shared/${orgSlug}/${comp.data!.slug}/players/${pat}`, { waitUntil: "load" });
  await anon.getByTestId("cookie-accept").click();
  for (const width of [1280, 768, 320]) {
    await anon.setViewportSize({ width, height: 900 });
    const rollup = anon.getByTestId("player-career").getByTestId("career-sport-badminton");
    await expect(rollup).toContainText("4 matches", { timeout: 20_000 });
    const list = anon.getByTestId("mh-player-matches");
    const lines = list.locator('[data-testid^="mh-player-match-"]');
    await expect(lines).toHaveCount(6);
    const ids = await lines.evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")!.replace("mh-player-match-", "")));
    expect(ids.sort(), `public lines at ${width}`).toEqual([...played].sort());
    const won = (await list.getByTestId("mh-player-result-won").count()) + (await list.getByTestId("mh-player-slab-result-won").count());
    const lost = (await list.getByTestId("mh-player-result-lost").count()) + (await list.getByTestId("mh-player-slab-result-lost").count());
    expect([won, lost], `public W/L badges at ${width}`).toEqual([3, 3]);
    // The per-division stats are the snapshot the engine folded: badminton's own `matches` key, generic's W/L.
    const perDivision: string[] = [];
    for (const [name, want] of [["Bad A", { matches: "2" }], ["Bad B", { matches: "2" }], ["Gen", { wins: "1", losses: "1" }]] as const) {
      const card = anon.getByTestId("player-stats").locator("div", { has: anon.getByRole("link", { name, exact: true }) }).last();
      const dts = (await card.locator("dt").allInnerTexts()).map((x) => x.trim().toLowerCase());
      const dds = (await card.locator("dd").allInnerTexts()).map((x) => x.trim());
      const got = Object.fromEntries(dts.map((k, i) => [k, dds[i]!]));
      for (const [k, v] of Object.entries(want)) expect(got[k], `public ${name} ${k} at ${width}`).toBe(v);
      perDivision.push(`${name} ${Object.entries(want).map(([k]) => `${k} ${got[k]}`).join(" ")}`);
    }
    await expectNoHorizontalScroll(anon);
    seen.push(`public@${width}: career badminton "${(await rollup.locator("p").nth(1).innerText()).trim()}", lines ${ids.length}, won ${won}, lost ${lost}; stats ${perDivision.join(", ")}`);
    await anon.getByTestId("player-career").screenshot({ path: testInfo.outputPath(`public-career-${width}.png`) });
    await list.screenshot({ path: testInfo.outputPath(`public-matches-${width}.png`) });
  }
  await anonCtx.close();
  expect(seen.length, "surfaces read").toBe(6);
  testInfo.annotations.push({ type: "numbers", description: seen.join(" | ") });
});

// W2b ruling 122 (owner "B", 2026-10-12): a team match counts on a person's career record only for players — the
// side's recorded lineup, or its roster's players when it recorded none. A coach never gets one; a player added to the
// roster after a lineup-less fixture still does (the accepted residue: no join date is stored).
//
// Two generic team divisions in one public competition (the public card's career rollup shows only where it
// aggregates), each Mine v Theirs, one played match each, recorded through the organiser's own doors:
//   A — no lineup; after the match Lou joins Mine's roster.   B — Mine records a sheet: Pia as player, Cole as coach.
// Expected, from the ruling: Pia 2 matches (A by the roster, B by the sheet); Cole, registered as coach, none; Lou 1 (A).
test("ruling 122: the coach is listed with no team match; the player keeps both; a player added after the lineup-less match keeps it (accepted residue)", async ({ page, browser }, testInfo) => {
  test.setTimeout(240_000);
  const person = async (n: string, lane: "player" | "coach") => {
    const res = await apiJson<{ id: string }>(page.request, "/api/v1/persons", "POST", { full_name: `${n} ${TAG}`, consent: { public_name: true }, lane });
    expect(res.status, `person ${n}: ${JSON.stringify(res.error)}`).toBeLessThan(300);
    return res.data!.id;
  };
  const pia = await person("Pia Player", "player");
  const cole = await person("Cole Coach", "coach");
  const lou = await person("Lou Late", "player");
  const oz = await person("Oz Opp", "player");
  const comp = await apiJson<{ id: string; slug: string; org_id: string }>(page.request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Players only ${TAG}`,
    visibility: "public",
  });
  expect(comp.status, `competition: ${JSON.stringify(comp.error)}`).toBeLessThan(300);

  const teamDivision = async (name: string, sheet: boolean) => {
    const div = await apiJson<{ id: string }>(page.request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
      name,
      sport_key: "generic",
      variant_key: "score",
    });
    expect(div.status, `division: ${JSON.stringify(div.error)}`).toBeLessThan(300);
    const divisionId = div.data!.id;
    const ents = await apiJson<{ id: string }[]>(page.request, `/api/v1/divisions/${divisionId}/entrants`, "POST", [
      { kind: "team", display_name: `${name} Mine ${TAG}`, seed: 1, members: [{ person_id: pia }, { person_id: cole }] },
      { kind: "team", display_name: `${name} Theirs ${TAG}`, seed: 2, members: [{ person_id: oz }] },
    ]);
    expect(ents.status, `entrants: ${JSON.stringify(ents.error)}`).toBeLessThan(300);
    const mineId = ents.data![0]!.id;
    const stage = await apiJson<{ id: string }>(page.request, `/api/v1/divisions/${divisionId}/stages`, "POST", { seq: 1, kind: "league", name: "League" });
    const gen = await apiJson<{ fixtures: Fixture[] }>(page.request, `/api/v1/stages/${stage.data!.id}/generate`, "POST");
    expect(gen.status).toBeLessThan(300);
    await apiJson(page.request, `/api/v1/divisions/${divisionId}/start`, "POST");
    const fixtures = gen.data!.fixtures.filter((f) => f.home_entrant_id !== null && f.away_entrant_id !== null);
    expect(fixtures.length, `${name}: one match`).toBe(1);
    const f = fixtures[0]!;
    if (sheet) {
      const put = await apiJson(page.request, `/api/v1/fixtures/${f.id}/lineups/${mineId}`, "PUT", {
        slots: [
          { person_id: pia, slot: "starting", role: "player" },
          { person_id: cole, slot: "starting", role: "coach" },
        ],
      });
      expect(put.status, `${name} sheet: ${JSON.stringify(put.error)}`).toBeLessThan(300);
    }
    const seq = { n: 0 };
    await post(page.request, f.id, seq, "core.start", {});
    for (const e of SPORTS.generic.win(f.home_entrant_id === mineId ? "home" : "away")) await post(page.request, f.id, seq, e.type, e.payload);
    return { divisionId, mineId };
  };
  const a = await teamDivision("Team A", false);
  await teamDivision("Team B", true);
  // Lou joins Mine of A after its match was played.
  const joined = await apiJson(page.request, `/api/v1/entrants/${a.mineId}`, "PATCH", {
    members: [{ person_id: pia }, { person_id: cole }, { person_id: lou }],
  });
  expect(joined.status, `late join: ${JSON.stringify(joined.error)}`).toBeLessThan(300);

  // ---- the console API (?group=sport) ---------------------------------------------------------------------------
  const consoleMatches = async (id: string) => {
    const res = await apiJson<{ sports: { sport_key: string; matches: number }[] }>(page.request, `/api/v1/persons/${id}/stats?group=sport`);
    expect(res.status).toBe(200);
    return res.data!.sports.map((s) => [s.sport_key, s.matches]);
  };
  expect(await consoleMatches(pia), "console: Pia").toEqual([["generic", 2]]);
  expect(await consoleMatches(cole), "console: Cole, the coach").toEqual([]);
  expect(await consoleMatches(lou), "console: Lou, added after the lineup-less match").toEqual([["generic", 1]]);

  const seen: string[] = [];
  // ---- /me, as the coach -----------------------------------------------------------------------------------------
  const coachCtx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const me = await coachCtx.newPage();
  await loginUi(me, `cole-coach-${TAG}@example.com`, "/me");
  const whoami = await apiJson<{ id: string }>(me.request, "/api/users/me");
  expect(whoami.status).toBe(200);
  await linkPersonToUserBySql(cole, whoami.data!.id);
  await me.goto("/me");
  await me.getByTestId("cookie-accept").click();
  for (const width of [1280, 768, 320]) {
    await me.setViewportSize({ width, height: 900 });
    const career = me.getByTestId("me-career");
    await expect(career).toBeVisible({ timeout: 20_000 });
    await expect(career.getByTestId("me-career-empty")).toBeVisible();
    await expect(career.locator('[data-testid^="career-sport-"]')).toHaveCount(0);
    await expectNoHorizontalScroll(me);
    seen.push(`/me coach@${width}: "${(await career.innerText()).replace(/\s+/g, " ").trim()}"`);
    await career.screenshot({ path: testInfo.outputPath(`r122-me-coach-${width}.png`) });
  }
  await coachCtx.close();

  // ---- the public player cards, anonymous -----------------------------------------------------------------------
  const orgs = await apiJson<{ id: string; slug: string }[]>(page.request, "/api/orgs");
  const orgSlug = orgs.data!.find((o) => o.id === comp.data!.org_id)!.slug;
  const anonCtx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const anon = await anonCtx.newPage();
  let banner = true;
  for (const [who, id, want] of [
    ["Cole", cole, { lines: 0, rollup: null }],
    ["Pia", pia, { lines: 2, rollup: "2 matches" }],
    ["Lou", lou, { lines: 1, rollup: null }],
  ] as const) {
    await anon.goto(`/shared/${orgSlug}/${comp.data!.slug}/players/${id}`, { waitUntil: "load" });
    if (banner) {
      await anon.getByTestId("cookie-accept").click();
      banner = false;
    }
    for (const width of [1280, 768, 320]) {
      await anon.setViewportSize({ width, height: 900 });
      const list = anon.getByTestId("mh-player-matches");
      await expect(list).toBeVisible({ timeout: 20_000 });
      await expect(list.locator('[data-testid^="mh-player-match-"]'), `${who} lines at ${width}`).toHaveCount(want.lines);
      const rollup = anon.getByTestId("player-career");
      if (want.rollup === null) await expect(rollup, `${who}: no career rollup at ${width}`).toHaveCount(0);
      else await expect(rollup.getByTestId("career-sport-generic")).toContainText(want.rollup);
      await expectNoHorizontalScroll(anon);
      const rollupText = want.rollup === null ? "none" : `"${(await rollup.getByTestId("career-sport-generic").locator("p").nth(1).innerText()).trim()}"`;
      seen.push(`public ${who}@${width}: matches "${(await list.innerText()).replace(/\s+/g, " ").trim().slice(0, 120)}"; career ${rollupText}`);
      await list.screenshot({ path: testInfo.outputPath(`r122-public-${who.toLowerCase()}-${width}.png`) });
    }
  }
  await anonCtx.close();
  expect(seen.length, "surfaces read").toBe(12);
  testInfo.annotations.push({ type: "numbers", description: seen.join(" | ") });
});
