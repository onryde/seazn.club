import { test, expect, type APIRequestContext } from "@playwright/test";
import { TAG, apiJson, divisionPath, expectNoHorizontalScroll, seedVenueWithCourts, activeOrgIdFromRequest } from "./helpers";
import { showAllFixtures, stageFixtures, type Fx } from "./support/swiss-app-a-kit";

// W5 round-robin app PR A, Task 2 (X-CU-6 FX-G1 #879; FX-G21; #837; X-BD-5). A pre-Start Generate on a league used to insert by
// the engine's POSITIONAL id, so a roster that grew from four to six wrote nine new lines that repeated pairs already drawn and
// missed the pairs the newcomers owed. It now reconciles by (pair, leg). Driven through the route the desk's Generate button
// calls, and read back on the run sheet itself, not only the API.

const GENERIC_CONFIG = { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false };

type Seeded = { divisionId: string; stageId: string; ids: string[] };

async function seedLeague(request: APIRequestContext, label: string, n: number, visibility: "private" | "public" = "private"): Promise<Seeded> {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `${label} ${TAG}`,
    visibility,
  });
  expect(comp.status, JSON.stringify(comp.error)).toBe(201);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  expect(div.status, JSON.stringify(div.error)).toBe(201);
  const divisionId = div.data!.id;
  const ids = (await addEntrants(request, divisionId, label, 1, n)).map((e) => e.id);
  const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
    seq: 1,
    kind: "league",
    name: "League",
    config: {},
  });
  expect(stage.status, JSON.stringify(stage.error)).toBe(201);
  return { divisionId, stageId: stage.data!.id, ids };
}

async function addEntrants(request: APIRequestContext, divisionId: string, label: string, from: number, to: number) {
  const added = await apiJson<{ id: string; display_name: string }[]>(request, `/api/v1/divisions/${divisionId}/entrants`, "POST",
    Array.from({ length: to - from + 1 }, (_, i) => ({ kind: "individual", display_name: `${label} P${from + i} ${TAG}`, seed: from + i })));
  expect(added.status, JSON.stringify(added.error)).toBe(201);
  return added.data!;
}

type Reconcile = { kind: string; placed: string[]; vacated: string[]; slots?: { kept: number; freed: number; unscheduled: number } };
type Generated = { created: number; existing: number; reconcile?: Reconcile };

async function generate(request: APIRequestContext, stageId: string) {
  return apiJson<Generated>(request, `/api/v1/stages/${stageId}/generate`, "POST");
}

type Pairing = Fx & { home_entrant_id: string | null; away_entrant_id: string | null };

/** The unordered pair each line holds, as `lo|hi` - the key the rule is about. */
const pairOf = (f: Pairing) => [f.home_entrant_id, f.away_entrant_id].sort().join("|");
/** Every unordered pair of `ids`, derived from the roster itself. */
const owedPairs = (ids: string[]) => ids.flatMap((a, i) => ids.slice(i + 1).map((b) => [a, b].sort().join("|")));

test.describe("X-CU-6 Generate adds the new players' pairs and nothing twice", () => {
  test("four players grown to six before Start: Generate keeps the six lines and adds the nine missing pairs (no pair twice, none missing), and the run sheet lists 15 lines", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const { divisionId, stageId, ids } = await seedLeague(request, "Grow", 4);
    const first = await generate(request, stageId);
    expect(first.status, JSON.stringify(first.error)).toBe(200);
    expect(first.data!.created).toBe(6);
    const before = (await stageFixtures(request, divisionId, stageId)) as Pairing[];
    expect(before.length, "a board to grow").toBe(6);

    const added = await addEntrants(request, divisionId, "Grow", 5, 6);
    const everyone = [...ids, ...added.map((e) => e.id)];
    const res = await generate(request, stageId);
    expect(res.status, JSON.stringify(res.error)).toBe(200);
    // Parity is kept (even -> even), so the draw is patched in place: the six lines the four already had stay, and C(6,2) - C(4,2) = 9
    // pairs are added. rulebook silent on round count; X-CU-6 keeps lines: the table runs past a fresh six-player draw's five rounds
    // (by hand: the old four fill rounds 1-3, so the newcomers' pairs land from round 4 on - eight rounds in all).
    expect(res.data!.reconcile?.kind).toBe("in_place");
    expect(res.data!.created).toBe(9);

    const after = (await stageFixtures(request, divisionId, stageId)) as Pairing[];
    for (const b of before) expect(after.some((a) => a.id === b.id), `the line ${b.id} survives untouched`).toBe(true);
    expect(Math.max(...after.map((a) => a.round_no)), "eight rounds (hand-derived), past a fresh draw's five").toBe(8);
    const keys = after.map(pairOf);
    const owed = owedPairs(everyone);
    expect(owed.length, "anti-vacuity: C(6,2) pairs owed").toBe(15);
    expect(after.length).toBe(15);
    expect(new Set(keys).size, "no pair twice").toBe(15);
    expect(owed.filter((k) => !keys.includes(k)), "no pair missing").toEqual([]);

    // The desk: the run sheet lists one row per line, with no horizontal page scroll.
    await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
    await showAllFixtures(page);
    await expect(page.locator("[data-fixture-no]")).toHaveCount(15, { timeout: 20_000 });
    await expectNoHorizontalScroll(page);
  });

  test("a second Generate with nothing changed is the named no-op, and creates nothing", async ({ request }) => {
    test.setTimeout(90_000);
    const { divisionId, stageId } = await seedLeague(request, "Again", 4);
    expect((await generate(request, stageId)).status).toBe(200);
    const before = await stageFixtures(request, divisionId, stageId);
    const again = await generate(request, stageId);
    expect(again.status, JSON.stringify(again.error)).toBe(200);
    expect(again.data).toMatchObject({ created: 0, reconcile: { kind: "noop" } });
    const after = await stageFixtures(request, divisionId, stageId);
    expect(after.map((f) => f.id).sort()).toEqual(before.map((f) => f.id).sort());
  });

  test("three players grown to four before Start (an odd field becoming even): the draw is redone once, and a laid-out time follows its PAIR", async ({
    request,
  }) => {
    test.setTimeout(120_000);
    const orgId = await activeOrgIdFromRequest(request);
    const { venueId, courts } = await seedVenueWithCourts(request, [`Flip Court A ${TAG}`, `Flip Court B ${TAG}`], { orgId });
    const { divisionId, stageId, ids } = await seedLeague(request, "Flip", 3);
    expect((await generate(request, stageId)).status).toBe(200);
    const before = (await stageFixtures(request, divisionId, stageId)) as Pairing[];
    expect(before.length).toBe(3);
    // The times this test lays out, per pair: the expected values, never read back from the code under test.
    const laid = new Map<string, { scheduled_at: string; court_id: string }>();
    for (const [i, f] of before.entries()) {
      const slot = { scheduled_at: `2030-06-15T${String(9 + i).padStart(2, "0")}:00:00.000Z`, court_id: courts[i % 2]!.id };
      const placed = await apiJson(request, `/api/v1/fixtures/${f.id}`, "PATCH", { ...slot, venue_id: venueId });
      expect(placed.status, JSON.stringify(placed.error)).toBe(200);
      laid.set(pairOf(f), slot);
    }

    const added = await addEntrants(request, divisionId, "Flip", 4, 4);
    const res = await generate(request, stageId);
    expect(res.status, JSON.stringify(res.error)).toBe(200);
    expect(res.data!.reconcile?.kind).toBe("regenerated");
    // All three of the old pairs exist in the redraw, so all three keep their time; the newcomer's three pairs are bare.
    expect(res.data!.reconcile?.slots).toEqual({ kept: 3, freed: 0, unscheduled: 3 });

    const after = (await stageFixtures(request, divisionId, stageId)) as Pairing[];
    const keys = after.map(pairOf);
    expect(after.length).toBe(6);
    expect(new Set(keys).size).toBe(6);
    expect(owedPairs([...ids, added[0]!.id]).filter((k) => !keys.includes(k))).toEqual([]);
    let checked = 0;
    for (const f of after) {
      const want = laid.get(pairOf(f));
      if (want === undefined) continue;
      expect({ scheduled_at: f.scheduled_at, court_id: f.court_id }, pairOf(f)).toEqual(want);
      checked++;
    }
    expect(checked, "anti-vacuity: every old pair's slot was read back").toBe(3);
  });

  test("after Start an arrival is refused by name and nothing is written; an unchanged roster is still the no-op", async ({
    request,
  }) => {
    test.setTimeout(120_000);
    const { divisionId, stageId } = await seedLeague(request, "Late", 4);
    expect((await generate(request, stageId)).status).toBe(200);
    const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
    expect(started.status, JSON.stringify(started.error)).toBe(200);
    const before = await stageFixtures(request, divisionId, stageId);

    const unchanged = await generate(request, stageId);
    expect(unchanged.status, JSON.stringify(unchanged.error)).toBe(200);
    expect(unchanged.data!.reconcile?.kind).toBe("noop");

    await addEntrants(request, divisionId, "Late", 5, 5);
    const refused = await generate(request, stageId);
    expect(refused.status).toBe(409);
    expect(refused.error?.code).toBe("RR_GENERATE_AFTER_START");
    expect(refused.error?.message).toBe("Play has started, so Generate won't change the fixtures. Use Add late player.");
    const after = await stageFixtures(request, divisionId, stageId);
    expect(after.map((f) => f.id).sort(), "the refusal wrote nothing").toEqual(before.map((f) => f.id).sort());
  });
});

test.describe("FX-G21 an odd league stores its byes", () => {
  test("a five-player league records one bye per round, each player once", async ({ request }) => {
    test.setTimeout(90_000);
    const { divisionId, stageId, ids } = await seedLeague(request, "Odd", 5);
    expect((await generate(request, stageId)).status).toBe(200);
    const stages = await apiJson<{ id: string; config: { round_byes?: { round_no: number; leg: number; entrant_id: string }[] } }[]>(
      request,
      `/api/v1/divisions/${divisionId}/stages`,
    );
    expect(stages.status, JSON.stringify(stages.error)).toBe(200);
    const byes = stages.data!.find((s) => s.id === stageId)?.config.round_byes ?? [];
    expect(byes.length, "five rounds, one bye each").toBe(5);
    expect(byes.map((b) => b.round_no).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(byes.map((b) => b.entrant_id).sort()).toEqual([...ids].sort());
    expect(byes.every((b) => b.leg === 1)).toBe(true);
  });
});

test.describe("X-BD-5 a field too small to generate is refused by name", () => {
  test("one player: Generate is refused 422 STAGE_NOT_READY and the stage holds no line", async ({ request }) => {
    test.setTimeout(60_000);
    const { divisionId, stageId } = await seedLeague(request, "Solo", 1);
    const res = await generate(request, stageId);
    expect(res.status).toBe(422);
    expect(res.error?.code).toBe("STAGE_NOT_READY");
    expect(await stageFixtures(request, divisionId, stageId)).toHaveLength(0);
  });
});

// W5 app PR A, Task 3 (X-BD-6, FX-G15; owner R24 pick 6 option A). Add match used to land at `max(round) + 1`. It now defaults to the latest
// round where NEITHER side plays, and the form's Round select lists a round where a side already plays with its reason, unselectable.
// Driven through the real form on the desk's fixtures tab and read back through the API. The rig is derived from the generated table, never
// typed in: round 3's lines are read back, two of them are picked and their far sides withdrawn, so the only round where both Add match
// sides are free is round 3 BY CONSTRUCTION (each of the six plays in every round of a five-round table, so a side is free only where a
// line of its was expunged).
test.describe("X-BD-6 Add match lands in round 3", () => {
  test("six players, two withdrawn from round 3: the form defaults to Round 3, lists the rounds where a side plays as unselectable, and the added match is written in round 3", async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    const { divisionId, stageId } = await seedLeague(request, "AddRound", 6);
    expect((await generate(request, stageId)).status).toBe(200);
    const lines = (await stageFixtures(request, divisionId, stageId)) as Pairing[];
    expect(lines.length, "a six-player table plays 15 lines").toBe(15);
    const rounds = Math.max(...lines.map((l) => l.round_no));
    expect(rounds, "five rounds for six players").toBe(5);
    const round3 = lines.filter((l) => l.round_no === 3);
    expect(round3.length, "three lines in round 3").toBe(3);
    // Two lines of round 3: (a, x) and (b, y). x and y leave; a and b are then both free in round 3, and nowhere else.
    const [lineA, lineB] = round3 as [Pairing, Pairing];
    const a = lineA.home_entrant_id!;
    const x = lineA.away_entrant_id!;
    const b = lineB.home_entrant_id!;
    const y = lineB.away_entrant_id!;
    expect(new Set([a, x, b, y]).size, "four different players").toBe(4);

    const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
    expect(started.status, JSON.stringify(started.error)).toBe(200);
    // The withdrawal only voids the leaver's lines once the division is under way (before that it is a plain status flip, and the lines
    // stay scheduled): play one round-1 line that neither leaver is in. Each leaver has then played 0 of 5, under half, so her lines are
    // expunged (`POST /entrants/{id}/withdraw`, policy "expunge": the cascade the desk's Withdraw button calls).
    const played = lines.find((l) => l.round_no === 1 && ![x, y].includes(l.home_entrant_id!) && ![x, y].includes(l.away_entrant_id!));
    expect(played, "premise: a round-1 line neither leaver is in").toBeDefined();
    for (const [seq, type, payload] of [[0, "core.start", {}], [1, "generic.result", { p1Score: 2, p2Score: 0 }]] as const) {
      const ev = await apiJson(request, `/api/v1/fixtures/${played!.id}/events`, "POST", { expected_seq: seq, type, payload });
      expect(ev.status, JSON.stringify(ev.error)).toBe(201);
    }
    for (const gone of [x, y]) {
      const res = await apiJson<{ policy: string }>(request, `/api/v1/entrants/${gone}/withdraw`, "POST");
      expect(res.status, JSON.stringify(res.error)).toBe(200);
      expect(res.data!.policy, "an early withdrawal expunges the leaver's lines").toBe("expunge");
    }

    await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
    await page.getByTestId("stage-add-match").first().click();
    const form = page.locator("div.border-dashed").filter({ has: page.getByTestId("add-match-round") });
    const round = form.getByTestId("add-match-round");
    await expect(round, "the Round select waits for both sides").toBeDisabled();
    await form.locator("label", { hasText: /^Home/ }).locator("select").selectOption(a);
    await form.locator("label", { hasText: /^Away/ }).locator("select").selectOption(b);
    await expect(round).toBeEnabled();
    await expect(round, "the default is the latest round where neither side plays").toHaveValue("3");
    await expect(round.locator("option:checked")).toHaveText("Round 3 · both free (suggested)");
    // A round where a side already plays is listed, with its reason, and cannot be picked; the new round after the last is open.
    await expect(round.locator('option[value="5"]')).toBeDisabled();
    await expect(round.locator('option[value="6"]')).toBeEnabled();
    await expect(round.locator('option[value="5"]')).toHaveText(/^Round 5 · .+ plays /);
    await expectNoHorizontalScroll(page);

    await form.getByRole("button", { name: "Add match", exact: true }).click();
    await expect.poll(async () => (await stageFixtures(request, divisionId, stageId)).length, { timeout: 20_000 }).toBe(16);
    const after = (await stageFixtures(request, divisionId, stageId)) as Pairing[];
    const added = after.filter((f) => !lines.some((l) => l.id === f.id));
    expect(added, "exactly the one new line").toHaveLength(1);
    expect(pairOf(added[0]!), "between the two sides picked").toBe([a, b].sort().join("|"));
    expect(added[0]!.round_no, "in round 3, not round 6").toBe(3);
  });
});

// W5 app PR A, Task 3 fix round 1 (X-SF-4, FX-G19): an odd field's round says who sits it out - on the desk's run sheet and on the public
// page's round view - and a player who has left is never named. The expectation is the stored byes (`config.round_byes`, the engine's own
// `rounds[].bye` written at Generate), read back through the API; the rule is "one line per round, naming that round's bye, none for a
// departed player" - never what the page happened to print.
test.describe("X-SF-4 a five-player league says who sits out each round", () => {
  test("five lines on the desk and on the public page, each naming its round's bye; a withdrawal removes exactly that round's line", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const label = "SitOut";
    const { divisionId, stageId, ids } = await seedLeague(request, label, 5, "public");
    expect((await generate(request, stageId)).status).toBe(200);
    const stages = await apiJson<{ id: string; config: { round_byes?: { round_no: number; entrant_id: string }[] } }[]>(request, `/api/v1/divisions/${divisionId}/stages`);
    const byes = stages.data!.find((s) => s.id === stageId)?.config.round_byes ?? [];
    expect(byes.length, "premise: five rounds, one bye each (FX-G21)").toBe(5);
    const nameOf = (id: string) => `${label} P${ids.indexOf(id) + 1} ${TAG}`;
    const byeOfRound = new Map(byes.map((b) => [b.round_no, b.entrant_id]));
    expect(byeOfRound.size, "premise: five distinct rounds").toBe(5);

    const deskPath = await divisionPath(request, divisionId, "?tab=fixtures");
    const livePath = deskPath.replace(/^\/o\//, "/live/").replace(/\/c\//, "/").replace(/\/d\//, "/").replace(/\?tab=fixtures$/, "");

    // The lines currently on a surface, as the rounds' texts; each is checked against the rule for who is on the bye.
    async function readLines(selector: string, where: "desk" | "public") {
      await page.goto(where === "desk" ? deskPath : livePath);
      if (where === "desk") await showAllFixtures(page);
      return page.locator(selector).allInnerTexts();
    }
    const expectNames = (texts: string[], present: string[], absent: string[], where: string) => {
      expect(texts.length, `${where}: one line per round that has a player on the bye`).toBe(present.length);
      for (const name of present) expect(texts.filter((t) => t.includes(name)).length, `${where}: ${name} is named once`).toBe(1);
      for (const name of absent) expect(texts.some((t) => t.includes(name)), `${where}: ${name} is not named`).toBe(false);
    };

    const everyone = ids.map(nameOf);
    expectNames(await readLines("[data-run-sheet-round-sits-out]", "desk"), everyone, [], "desk, before");
    expectNames(await readLines('[data-testid="schedule-sits-out"]', "public"), everyone, [], "public, before");

    // A player leaves: the round they sat out no longer says anyone sits out (the four others keep their line, unchanged).
    const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
    expect(started.status, JSON.stringify(started.error)).toBe(200);
    const leaver = byeOfRound.get(3)!;
    const gone = await apiJson(request, `/api/v1/entrants/${leaver}/withdraw`, "POST");
    expect(gone.status, JSON.stringify(gone.error)).toBe(200);
    const stay = ids.filter((id) => id !== leaver).map(nameOf);
    expectNames(await readLines("[data-run-sheet-round-sits-out]", "desk"), stay, [nameOf(leaver)], "desk, after");
    expectNames(await readLines('[data-testid="schedule-sits-out"]', "public"), stay, [nameOf(leaver)], "public, after");
    await expectNoHorizontalScroll(page);
  });
});
