import { test, expect, type APIRequestContext } from "@playwright/test";
import { TAG, apiJson, competitionPath, divisionPath, expectNoHorizontalScroll, pickBuilderSport, seedVenueWithCourts, showAllFormats, activeOrgIdFromRequest } from "./helpers";
import { dismissCookieBanner } from "./scorepad-a11y-kit";
import { waitForHydration } from "./directory-kit";
import { showAllFixtures, stageFixtures, type Fx } from "./support/swiss-app-a-kit";
import { dictString } from "./spectator-w2-kit";
import { LONG_NAME_SUFFIX, seedFinishedGroupsOnly } from "./support/pool-winners-kit";
import { seedExpungedLeaver } from "./support/expunged-leaver-kit";
import { saveRoster, seedPair, seedPlayer, stagePartnerSwap, storedMembers, uiEn } from "./entrant-rename-kit";

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

// W5 app PR A, Task 5 (X-CU-7, X-CU-12, X-CU-13; RB5-L3, L13, L14). "Add late player" on a started league: main refused the add
// 422 (the entrant list locked at Start); Task 4's interim accepted it with no seat. Now the newcomer gets one fixture against every
// member — in a member's bye round still to come, else in an appended round — each written UNSCHEDULED, and Undo across the add is
// refused by name. Driven through the routes the desk's Add player form and History panel call. The expected placements are the
// hand derivation over the engine's byes for a seeded five (r1 P5, r2 P4, r3 P3, r4 P2, r5 P1; asserted as the premise): rounds 1-2
// are under way, so P3, P2, P1 meet the newcomer in their bye rounds 3, 4, 5, and P4, P5 (whose byes were in started rounds) in
// appended rounds 6, 7.
test.describe("X-CU-7 a late player gets catch-up fixtures", () => {
  test("a started league of five: the late player meets all five, unscheduled, in rounds 3-7; every earlier line kept; Undo refused", async ({ request }) => {
    test.setTimeout(120_000);
    const { divisionId, stageId, ids } = await seedLeague(request, "Late", 5);
    expect((await generate(request, stageId)).status).toBe(200);
    const stages = await apiJson<{ id: string; config: { round_byes?: { round_no: number; entrant_id: string }[] } }[]>(request, `/api/v1/divisions/${divisionId}/stages`);
    const byes = (stages.data!.find((s) => s.id === stageId)?.config.round_byes ?? []).sort((a, b) => a.round_no - b.round_no);
    expect(byes.map((b) => ids.indexOf(b.entrant_id) + 1), "premise: the byes of a seeded five, r1..r5").toEqual([5, 4, 3, 2, 1]);
    const before = (await stageFixtures(request, divisionId, stageId)) as Pairing[];
    expect(before).toHaveLength(10);

    const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
    expect(started.status, JSON.stringify(started.error)).toBe(200);
    for (const r of [1, 2]) {
      const line = before.find((f) => f.round_no === r)!;
      const ev = await apiJson(request, `/api/v1/fixtures/${line.id}/events`, "POST", { expected_seq: 0, type: "core.start", payload: {} });
      expect(ev.status, JSON.stringify(ev.error)).toBe(201);
    }

    type Late = { id: string; late_entry?: { case: string; fixtures?: { fixture_id: string; round_no: number; placement: string; scheduled: boolean }[] } };
    const add = await apiJson<Late[]>(request, `/api/v1/divisions/${divisionId}/entrants`, "POST", [{ kind: "individual", display_name: `Late newcomer ${TAG}` }]);
    expect(add.status, JSON.stringify(add.error)).toBe(201);
    const late = add.data![0]!;
    expect(late.late_entry?.case).toBe("catch_up");

    const after = (await stageFixtures(request, divisionId, stageId)) as (Pairing & { scheduled_at?: string | null })[];
    const mine = after.filter((f) => f.home_entrant_id === late.id || f.away_entrant_id === late.id).sort((a, b) => a.round_no - b.round_no);
    const opponent = (f: Pairing) => ids.indexOf(f.home_entrant_id === late.id ? f.away_entrant_id! : f.home_entrant_id!) + 1;
    expect(mine.map((f) => `P${opponent(f)}@r${f.round_no}`)).toEqual(["P3@r3", "P2@r4", "P1@r5", "P4@r6", "P5@r7"]);
    expect(mine.every((f) => (f.scheduled_at ?? null) === null), "every catch-up line is unscheduled (X-CU-12)").toBe(true);
    expect((late.late_entry?.fixtures ?? []).map((f) => `${f.placement}:${f.round_no}:${f.scheduled}`).sort()).toEqual([
      "bye_slot:3:false", "bye_slot:4:false", "bye_slot:5:false", "catch_up_round:6:false", "catch_up_round:7:false",
    ]);
    for (const o of before) {
      const now = after.find((f) => f.id === o.id);
      expect(now && [now.round_no, now.home_entrant_id, now.away_entrant_id], `line ${o.id} kept`).toEqual([o.round_no, o.home_entrant_id, o.away_entrant_id]);
    }

    const undo = await apiJson(request, `/api/v1/divisions/${divisionId}/undo`, "POST", {});
    expect(undo.status).toBe(409);
    expect(undo.error?.code).toBe("RR_LATE_ENTRY_NOT_UNDOABLE");
    expect(await stageFixtures(request, divisionId, stageId), "the refused Undo moved nothing").toHaveLength(after.length);
  });
});

// W5 app PR A, Task 6 (X-CU-8; RB5-L10; ruling 271's rule for tables). An AUTOMATIC arrival into a started league is never placed
// by the app and never refused: before this task it was seated nowhere and flagged nowhere. It now WAITS — the competition desk
// says "1 late player waiting — add to the table" (the approved sentence, typed here) — and the organiser's one tap
// (`POST /stages/{id}/late-entrants/{entrantId}/place`, the route W4 built, now dispatched by the stage's kind) writes the
// catch-up lines. The arrival comes through the PUBLIC register door, auto-approved: the same `materialise` every paid, approved,
// waived and webhook confirmation runs (a test has no Stripe, so the door is the free one). Expected: the newcomer meets each of
// the four (RB5-L3), every line unscheduled (RB5-L13); a second tap is refused by name (Review Focus 2).
async function registerLate(request: APIRequestContext, competitionId: string, divisionId: string, who: string): Promise<string> {
  const settings = await apiJson(request, `/api/v1/divisions/${divisionId}/registration-settings`, "PUT", {
    enabled: true,
    entrant_kind: "individual",
    fee_cents: 0,
    payment_method: "offline",
    form_fields: [],
    approval: "auto",
  });
  expect(settings.status, JSON.stringify(settings.error)).toBeLessThan(300);
  const path = await competitionPath(request, competitionId);
  const [, orgSlug, compSlug] = /^\/o\/([^/]+)\/c\/([^/]+)/.exec(path)!;
  const sent = await apiJson<{ entries: { status: string }[] }>(request, `/api/v1/public/orgs/${orgSlug}/competitions/${compSlug}/register`, "POST", {
    contact: { name: who, email: `delivered+${TAG.toLowerCase().replace(/\W+/g, "-")}-${Math.random().toString(36).slice(2, 8)}@resend.dev` },
    privacy_consent: true,
    entries: [{ division_id: divisionId, entrant_kind: "individual", players: [{ full_name: who }], answers: {} }],
  });
  expect(sent.status, JSON.stringify(sent.error)).toBe(201);
  expect(sent.data!.entries[0]!.status, "premise: confirmed at once").toBe("confirmed");
  const list = await apiJson<{ id: string; display_name: string }[]>(request, `/api/v1/divisions/${divisionId}/entrants`);
  const entrant = list.data!.find((e) => e.display_name === who);
  expect(entrant, "premise: the confirmation made an entrant").toBeTruthy();
  return entrant!.id;
}

test.describe("X-CU-8 a paid player waits, then one tap places them", () => {
  test("a registration confirmed after Start: the desk flags one late player for the table; the tap writes four unscheduled catch-up lines; a second tap is RR_LATE_ENTRY_ALREADY_PLACED", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const { divisionId, stageId, ids } = await seedLeague(request, "Waits", 4, "public");
    expect((await generate(request, stageId)).status).toBe(200);
    const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
    expect(started.status, JSON.stringify(started.error)).toBe(200);
    const before = (await stageFixtures(request, divisionId, stageId)) as Pairing[];
    expect(before, "premise: four players, six lines").toHaveLength(6);
    const first = before.find((f) => f.round_no === 1)!;
    const ev = await apiJson(request, `/api/v1/fixtures/${first.id}/events`, "POST", { expected_seq: 0, type: "core.start", payload: {} });
    expect(ev.status, JSON.stringify(ev.error)).toBe(201);

    const div = await apiJson<{ competition_id: string }>(request, `/api/v1/divisions/${divisionId}`);
    const competitionId = div.data!.competition_id;
    const lateId = await registerLate(request, competitionId, divisionId, `Waits Newcomer ${TAG}`);
    const waiting = (await stageFixtures(request, divisionId, stageId)) as Pairing[];
    expect(waiting.some((f) => f.home_entrant_id === lateId || f.away_entrant_id === lateId), "the app placed nobody").toBe(false);
    expect(waiting).toHaveLength(6);

    await page.goto(await competitionPath(request, competitionId));
    await dismissCookieBanner(page);
    const flag = page.locator('[data-attention="late_players_waiting"]').first();
    await expect(flag, "the desk flags the waiting player").toContainText("1 late player waiting — add to the table", { timeout: 20_000 });
    await expect(flag).not.toContainText("bracket");

    type Tap = { format: string; case: string; source: string; fixtures?: { fixture_id: string; scheduled: boolean }[] };
    const tap = await apiJson<Tap>(request, `/api/v1/stages/${stageId}/late-entrants/${lateId}/place`, "POST");
    expect(tap.status, JSON.stringify(tap.error)).toBe(200);
    expect(tap.data).toMatchObject({ format: "league", case: "catch_up", source: "organiser" });
    const after = (await stageFixtures(request, divisionId, stageId)) as (Pairing & { scheduled_at?: string | null })[];
    const mine = after.filter((f) => f.home_entrant_id === lateId || f.away_entrant_id === lateId);
    const opponents = mine.map((f) => (f.home_entrant_id === lateId ? f.away_entrant_id! : f.home_entrant_id!)).sort();
    expect(opponents, "one line against each of the four").toEqual([...ids].sort());
    expect(mine.every((f) => (f.scheduled_at ?? null) === null), "every catch-up line is unscheduled").toBe(true);
    expect((tap.data!.fixtures ?? []).map((f) => f.fixture_id).sort()).toEqual(mine.map((f) => f.id).sort());

    await page.reload();
    await expect(page.locator('[data-attention="late_players_waiting"]'), "the desk row goes").toHaveCount(0, { timeout: 20_000 });
    const again = await apiJson(request, `/api/v1/stages/${stageId}/late-entrants/${lateId}/place`, "POST");
    expect([again.status, again.error?.code, again.error?.message]).toEqual([409, "RR_LATE_ENTRY_ALREADY_PLACED", "This player already has their fixtures."]);
  });
});

// W5 app PR A, Task 8 (X-WDT-5, X-WDT-7, X-WDT-8; ST-G15; RB5-W1/W2/W6/W7). A league leaver under half played used to keep her
// SIGNED-OFF results: the cascade skipped a finalized line (and the ledger's lock refused any write to it). Now every result she
// played is removed through the expunge abandon, finalized included; she stays listed, chipped and ranked last; the footnote
// under the table names the rule; and Reinstate reverses the expunge and takes the footnote away. Expected text is the owner's
// R24 pick 11 A wording, typed here.
test.describe("X-WDT-5 a leaver's signed-off result is removed", () => {
  test("1 of 3 played and finalized: the result goes, she ranks last with the footnote; Reinstate restores her lines", async ({ page, request }) => {
    test.setTimeout(120_000);
    const { divisionId, stageId, ids } = await seedLeague(request, "Expunge", 4);
    expect((await generate(request, stageId)).status).toBe(200);
    const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
    expect(started.status, JSON.stringify(started.error)).toBe(200);
    const [p1, p2] = [ids[0]!, ids[1]!];
    const lines = (await stageFixtures(request, divisionId, stageId)) as Pairing[];
    const signed = lines.find((f) => pairOf(f) === [p1, p2].sort().join("|"))!;
    const p1Home = signed.home_entrant_id === p1;
    let seq = 0;
    for (const [type, payload] of [
      ["core.start", {}],
      ["generic.result", p1Home ? { p1Score: 3, p2Score: 0 } : { p1Score: 0, p2Score: 3 }], // P1 wins: the most points
      ["core.finalize", {}],
    ] as const) {
      const ev = await apiJson<{ seq: number }>(request, `/api/v1/fixtures/${signed.id}/events`, "POST", { expected_seq: seq, type, payload });
      expect(ev.status, `${type}: ${JSON.stringify(ev.error)}`).toBe(201);
      seq = ev.data!.seq;
    }

    const out = await apiJson<{ policy: string; voided: number; skipped_cancelled: number }>(request, `/api/v1/entrants/${p1}/withdraw`, "POST");
    expect(out.status, JSON.stringify(out.error)).toBe(200);
    expect(out.data, "1 of 3 played: under half, all three removed").toMatchObject({ policy: "expunge", voided: 3, skipped_cancelled: 0 });
    const after = (await stageFixtures(request, divisionId, stageId)) as (Pairing & { status: string })[];
    expect(after.find((f) => f.id === signed.id)?.status, "the signed-off result is out").toBe("abandoned");

    const p1Name = `Expunge P1 ${TAG}`;
    await page.goto(await divisionPath(request, divisionId, "?tab=standings"));
    await dismissCookieBanner(page);
    const note = page.getByTestId(`standings-withdrawal-note-${p1}`);
    await expect(note).toHaveText(`${p1Name} (withdrawn): left after 1 of 3, so their results are removed and their other matches are void.`);
    const names = page.locator('tbody th[scope="row"]');
    await expect(names, "she stays listed: four rows").toHaveCount(4);
    await expect(names.last(), "the leaver, with the most points, ranks last").toContainText(p1Name);
    await expect(names.last().getByTestId("standings-withdrawn")).toBeVisible();
    await expectNoHorizontalScroll(page);

    const back = await apiJson(request, `/api/v1/entrants/${p1}`, "PATCH", { status: "registered" });
    expect(back.status, JSON.stringify(back.error)).toBe(200);
    const restored = (await stageFixtures(request, divisionId, stageId)) as (Pairing & { status: string })[];
    const hers = restored.filter((f) => f.home_entrant_id === p1 || f.away_entrant_id === p1);
    expect(hers.filter((f) => f.id !== signed.id).map((f) => f.status), "her unplayed lines are back").toEqual(["scheduled", "scheduled"]);
    await page.reload();
    await expect(page.getByTestId("standings-withdrawal-notes"), "after Reinstate the footnote is gone").toHaveCount(0);
  });
});

// W5 app PR A, Task 8b Part 1 (X-WDT-9 ← RB5-W10; ruling 111 joins the withdrawal door, owner ruling 288). A player who
// withdrew her own entry from the public status page after Start used to leave only her status: her lines stayed seated and
// scheduled, her results stood whatever she had played. Now her withdrawal goes through the table withdrawal — 1 of 3 played
// is under half, so her result is removed and her other matches are void (RB5-W2) — the standings footnote says so, and her
// status page tells her (R24 pick, typed here).
async function registerPlayer(request: APIRequestContext, competitionId: string, divisionId: string, who: string) {
  const settings = await apiJson(request, `/api/v1/divisions/${divisionId}/registration-settings`, "PUT", {
    enabled: true,
    entrant_kind: "individual",
    fee_cents: 0,
    payment_method: "offline",
    form_fields: [],
    approval: "auto",
  });
  expect(settings.status, JSON.stringify(settings.error)).toBeLessThan(300);
  const path = await competitionPath(request, competitionId);
  const [, orgSlug, compSlug] = /^\/o\/([^/]+)\/c\/([^/]+)/.exec(path)!;
  const sent = await apiJson<{ group_id: string; access_token: string; entries: { registration_id: string; status: string }[] }>(
    request,
    `/api/v1/public/orgs/${orgSlug}/competitions/${compSlug}/register`,
    "POST",
    {
      contact: { name: who, email: `delivered+${TAG.toLowerCase().replace(/\W+/g, "-")}-${Math.random().toString(36).slice(2, 8)}@resend.dev` },
      privacy_consent: true,
      entries: [{ division_id: divisionId, entrant_kind: "individual", players: [{ full_name: who }], answers: {} }],
    },
  );
  expect(sent.status, JSON.stringify(sent.error)).toBe(201);
  expect(sent.data!.entries[0]!.status, "premise: confirmed at once").toBe("confirmed");
  const list = await apiJson<{ id: string; display_name: string }[]>(request, `/api/v1/divisions/${divisionId}/entrants`);
  const entrant = list.data!.find((e) => e.display_name === who);
  expect(entrant, "premise: the confirmation made an entrant").toBeTruthy();
  return {
    entrantId: entrant!.id,
    registrationId: sent.data!.entries[0]!.registration_id,
    token: sent.data!.access_token,
    statusPath: `/live/${orgSlug}/${compSlug}/register/status?rid=${sent.data!.group_id}&token=${encodeURIComponent(sent.data!.access_token)}`,
  };
}

test.describe("X-WDT-9 a player withdraws after Start and the table follows the rule", () => {
  test("her own public withdrawal at 1 of 3 played: her result is removed, the footnote names the rule, her status page says so", async ({ page, request }) => {
    test.setTimeout(150_000);
    const { divisionId, stageId } = await seedLeague(request, "SelfLeave", 3, "public");
    const div = await apiJson<{ competition_id: string }>(request, `/api/v1/divisions/${divisionId}`);
    const competitionId = div.data!.competition_id;
    // Rae registers BEFORE Start, so she is in the field and gets her three lines.
    const raeName = `SelfLeave Rae Registrant With A Longer Name ${TAG}`;
    const rae = await registerPlayer(request, competitionId, divisionId, raeName);
    expect((await generate(request, stageId)).status).toBe(200);
    const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
    expect(started.status, JSON.stringify(started.error)).toBe(200);
    const hersBefore = ((await stageFixtures(request, divisionId, stageId)) as Pairing[]).filter((f) => f.home_entrant_id === rae.entrantId || f.away_entrant_id === rae.entrantId);
    expect(hersBefore, "premise: a league of four, three lines each").toHaveLength(3);
    // She wins one: the opponent did not turn up (an ordinary walkover, a recorded result).
    const won = hersBefore[0]!;
    const opp = won.home_entrant_id === rae.entrantId ? won.away_entrant_id! : won.home_entrant_id!;
    const ev = await apiJson(request, `/api/v1/fixtures/${won.id}/events`, "POST", { expected_seq: 0, type: "core.forfeit", payload: { by: opp, reason: "walkover" } });
    expect(ev.status, JSON.stringify(ev.error)).toBe(201);

    // Her own withdrawal, through the public door her status page calls.
    const out = await apiJson(request, `/api/v1/public/registrations/${rae.registrationId}/withdraw`, "POST", { token: rae.token });
    expect(out.status, JSON.stringify(out.error)).toBe(200);
    const after = (await stageFixtures(request, divisionId, stageId)) as (Pairing & { status: string })[];
    const hers = after.filter((f) => f.home_entrant_id === rae.entrantId || f.away_entrant_id === rae.entrantId);
    expect(hers.map((f) => f.status), "1 of 3 is under half: all three are taken out").toEqual(["abandoned", "abandoned", "abandoned"]);
    // A second press (a double click, a retry) settles nothing twice.
    const again = await apiJson(request, `/api/v1/public/registrations/${rae.registrationId}/withdraw`, "POST", { token: rae.token });
    expect(again.status, JSON.stringify(again.error)).toBe(200);

    await page.goto(await divisionPath(request, divisionId, "?tab=standings"));
    await dismissCookieBanner(page);
    await expect(page.getByTestId(`standings-withdrawal-note-${rae.entrantId}`)).toHaveText(
      `${raeName} (withdrawn): left after 1 of 3, so their results are removed and their other matches are void.`,
    );
    await expectNoHorizontalScroll(page);

    for (const width of [1280, 768, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(rae.statusPath);
      await dismissCookieBanner(page);
      await expect(page.getByTestId("reg-status-matches-settled"), `@${width}`).toHaveText("You've withdrawn. Your remaining matches are settled by the event's rules.");
      await expectNoHorizontalScroll(page);
    }
  });
});

// W5 app PR A, Task 8b Part 3 (X-WDT-10, owner ruling 289's condition: "clear instruction when DQ"). The organiser's Entrants →
// Disqualify used to confirm in general words (ruling 260: the per-format policy, the same for every entrant). It now names THIS
// entrant's consequence before the write: her remaining matches by opponent and round, her own count under the 50 percent rule,
// and the undo — then the cascade does exactly that. Expected copy is the brief's wording (Part 3 Files), typed here.
test.describe("X-WDT-10 the organiser sees the consequence before disqualifying", () => {
  test("2 of 5 played: the confirmation names her 3 remaining matches, the 50% outcome and Reinstate; confirmed, the cascade takes those out", async ({ page, request }) => {
    test.setTimeout(150_000);
    const { divisionId, stageId, ids } = await seedLeague(request, "DqCopy", 6);
    // A realistic long name (43 characters) on the entrant the dialog names.
    const name = "Alexandria Montgomery-Featherstonehaugh III";
    const renamed = await apiJson(request, `/api/v1/entrants/${ids[0]}`, "PATCH", { display_name: name });
    expect(renamed.status, JSON.stringify(renamed.error)).toBe(200);
    expect((await generate(request, stageId)).status).toBe(200);
    const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
    expect(started.status, JSON.stringify(started.error)).toBe(200);
    const v = ids[0]!;
    const lines = ((await stageFixtures(request, divisionId, stageId)) as Pairing[]).filter((f) => f.home_entrant_id === v || f.away_entrant_id === v);
    expect(lines, "five lines each in a league of six").toHaveLength(5);
    const other = (f: Pairing) => (f.home_entrant_id === v ? f.away_entrant_id! : f.home_entrant_id!);
    // She wins two by walkover: 2 of 5 played, under half (RB5-W2).
    for (const f of lines.slice(0, 2)) {
      const ev = await apiJson(request, `/api/v1/fixtures/${f.id}/events`, "POST", { expected_seq: 0, type: "core.forfeit", payload: { by: other(f), reason: "walkover" } });
      expect(ev.status, JSON.stringify(ev.error)).toBe(201);
    }
    const open = lines.slice(2).sort((a, b) => a.round_no - b.round_no || a.seq_in_round - b.seq_in_round);
    const named = await apiJson<{ id: string; display_name: string }[]>(request, `/api/v1/divisions/${divisionId}/entrants`);
    const nameOf = new Map(named.data!.map((e) => [e.id, e.display_name]));
    const list = new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(open.map((f) => `${nameOf.get(other(f))} (round ${f.round_no})`));

    await page.goto(await divisionPath(request, divisionId, "?tab=entrants"));
    await dismissCookieBanner(page);
    const row = page.locator("tbody tr").filter({ hasText: name });
    await expect(row).toHaveCount(1, { timeout: 20_000 });
    await row.getByTestId("entrant-row-disqualify").click();
    const dialog = page.getByRole("alertdialog");
    const consequence = dialog.getByTestId("withdrawal-consequence");
    await expect(consequence, "read before the confirmation opens").toHaveAttribute("data-state", "ready", { timeout: 20_000 });
    const said = await consequence.getByTestId("withdrawal-consequence-line").allTextContents();
    // The list's order is the preview's (her lines in fixture order); compare the sentence's members, then its frame.
    expect(said[0]).toMatch(/^These 3 remaining matches will be withdrawn: .+\.$/);
    for (const f of open) expect(said[0], "each remaining match by opponent and round").toContain(`${nameOf.get(other(f))} (round ${f.round_no})`);
    expect(said[0]!.length).toBe(`These 3 remaining matches will be withdrawn: ${list}.`.length);
    expect(said.slice(1)).toEqual([`${name} has played 2 of 5. Under the 50% rule their results will be removed.`, "The organiser can undo this with Reinstate while the stage is running."]);
    for (const [w, h] of [[1280, 900], [768, 1024], [320, 640]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await expect(consequence, `@${w}`).toBeVisible();
      await expectNoHorizontalScroll(page);
    }
    await page.setViewportSize({ width: 1280, height: 900 });

    const sent = page.waitForResponse((res) => new URL(res.url()).pathname === `/api/v1/entrants/${v}` && res.request().method() === "PATCH", { timeout: 20_000 });
    await dialog.getByRole("button", { name: "Disqualify", exact: true }).click();
    expect((await sent).status()).toBe(200);
    const after = ((await stageFixtures(request, divisionId, stageId)) as (Pairing & { status: string })[]).filter((f) => f.home_entrant_id === v || f.away_entrant_id === v);
    expect(after.map((f) => f.status), "all five of her lines taken out, as the confirmation said").toEqual(["abandoned", "abandoned", "abandoned", "abandoned", "abandoned"]);
  });
});

test.describe("X-RP-2, X-RP-3 a started league's pair cannot change partners; losing one withdraws it", () => {
  test("the roster editor: a substitute is refused in the console's own words and nothing moves; dropping the partner withdraws the pair and takes its lines out", async ({ page, request }) => {
    test.setTimeout(150_000);
    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `Pairs ${TAG}`, visibility: "private" });
    expect(comp.status, JSON.stringify(comp.error)).toBe(201);
    const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
      name: "Doubles",
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
    });
    expect(div.status, JSON.stringify(div.error)).toBe(201);
    const divisionId = div.data!.id;
    // The pair under test carries a realistic 43-character name; the three others are plain.
    const leaverName = "Alexandria Montgomery-Featherstonehaugh III";
    const keep = await seedPlayer(request, "Keeper");
    const go = await seedPlayer(request, "Leaver");
    const newcomer = await seedPlayer(request, "Newcomer");
    const leaverId = await seedPair(request, divisionId, [keep, go], leaverName);
    const others: string[] = [];
    for (let i = 0; i < 3; i++) others.push(await seedPair(request, divisionId, [await seedPlayer(request, `Opp${i}a`), await seedPlayer(request, `Opp${i}b`)]));
    const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", { seq: 1, kind: "league", name: "League", config: {} });
    expect(stage.status, JSON.stringify(stage.error)).toBe(201);
    const stageId = stage.data!.id;
    expect((await generate(request, stageId)).status).toBe(200);
    expect((await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST")).status).toBe(200);
    const mine = async () => ((await stageFixtures(request, divisionId, stageId)) as (Pairing & { status: string })[]).filter((f) => f.home_entrant_id === leaverId || f.away_entrant_id === leaverId);
    const lines = await mine();
    expect(lines, "a league of four: three matches each").toHaveLength(3);
    const opp = lines[0]!.home_entrant_id === leaverId ? lines[0]!.away_entrant_id! : lines[0]!.home_entrant_id!;
    const ev = await apiJson(request, `/api/v1/fixtures/${lines[0]!.id}/events`, "POST", { expected_seq: 0, type: "core.forfeit", payload: { by: opp, reason: "walkover" } });
    expect(ev.status, JSON.stringify(ev.error)).toBe(201);
    const roster = await storedMembers(request, leaverId);

    await page.goto(await divisionPath(request, divisionId, "?tab=entrants"));
    await dismissCookieBanner(page);
    const toggle = page.getByRole("cell", { name: leaverName }).getByRole("button", { name: leaverName, exact: false });
    await expect(toggle).toBeVisible({ timeout: 20_000 });
    await toggle.click();
    // 1. A substitute: refused, in the console's words, and the roster, status and lines stay.
    await stagePartnerSwap(page, go.name, newcomer.name);
    const refusedRes = page.waitForResponse((res) => new URL(res.url()).pathname === `/api/v1/entrants/${leaverId}` && res.request().method() === "PATCH", { timeout: 20_000 });
    await saveRoster(page).click();
    expect((await refusedRes).status()).toBe(422);
    const error = page.getByTestId("entrants-error");
    await expect(error).toHaveText(uiEn["roundrobin.refusal.RR_SUBSTITUTE_PARTNER_REFUSED"]!, { timeout: 20_000 });
    for (const [w, h] of [[1280, 900], [768, 1024], [320, 640]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await expect(error, `@${w}`).toBeVisible();
      await expectNoHorizontalScroll(page);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    expect(await storedMembers(request, leaverId), "the roster is as it was").toBe(roster);
    expect((await apiJson<{ status: string }>(request, `/api/v1/entrants/${leaverId}`)).data!.status).not.toBe("withdrawn");
    expect((await mine()).map((f) => f.status), "no line moved").not.toContain("abandoned");

    // 2. The partner dropped: the pair withdraws (1 of 3 played is under half: all three lines are taken out).
    await page.reload();
    await dismissCookieBanner(page);
    await toggle.click();
    const rosterBox = page.getByTestId("entrant-roster");
    await expect(rosterBox.getByText(go.name, { exact: true })).toBeVisible();
    await rosterBox.locator("div", { has: page.getByText(go.name, { exact: true }) }).last().getByRole("button", { name: uiEn["entrants.roster.remove"] }).click();
    const sent = page.waitForResponse((res) => new URL(res.url()).pathname === `/api/v1/entrants/${leaverId}` && res.request().method() === "PATCH", { timeout: 30_000 });
    await saveRoster(page).click();
    expect((await sent).status()).toBe(200);
    await expect.poll(async () => (await apiJson<{ status: string }>(request, `/api/v1/entrants/${leaverId}`)).data!.status, { timeout: 20_000 }).toBe("withdrawn");
    expect((await mine()).map((f) => f.status), "all three of her lines taken out").toEqual(["abandoned", "abandoned", "abandoned"]);
    expect(others.length, "anti-vacuity: three opposing pairs").toBe(3);
    // Fix round 1 (I1): the withdrawn pair's card shows the roster the pair had - BOTH partners, re-seeded from the server's answer, never
    // the staged one-partner roster - and it is read-only: there is no Save roster to press (the record is frozen; Reinstate first).
    await expect(rosterBox.getByText(keep.name, { exact: true })).toBeVisible();
    await expect(rosterBox.getByText(go.name, { exact: true }), "the partner who left is still on the pair's record").toBeVisible();
    await expect(saveRoster(page), "no live Save on a withdrawn pair").toHaveCount(0);
    await expect(rosterBox.getByRole("button", { name: uiEn["entrants.roster.remove"] }), "nothing to remove on a frozen record").toHaveCount(0);
    expect(await storedMembers(request, leaverId), "the server kept both people").toBe(roster);
  });
});

// Ruling 292 (W5 T10b): the partner rule is the same in EVERY format - a started Swiss and a started knockout refuse a substitute in the
// console's own words and withdraw a pair that loses a partner, each by its own rule (Swiss: the paired board is walked over, W3 R4b;
// knockout: the line is walked over to the opponent, RB4-V1). Reinstate then needs no table row to be read as done.
test.describe("ruling 292 a started Swiss or knockout pair cannot change partners; losing one withdraws it", () => {
  for (const kind of ["swiss", "knockout"] as const) {
    test(`the roster editor in a started ${kind}: a substitute is refused and nothing moves; dropping the partner withdraws the pair and walks her line over`, async ({ page, request }) => {
      test.setTimeout(150_000);
      const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `Pairs292 ${kind} ${TAG}`, visibility: "private" });
      expect(comp.status, JSON.stringify(comp.error)).toBe(201);
      const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
        name: "Doubles",
        sport_key: "generic",
        variant_key: "score",
        config: GENERIC_CONFIG,
      });
      expect(div.status, JSON.stringify(div.error)).toBe(201);
      const divisionId = div.data!.id;
      const leaverName = "Alexandria Montgomery-Featherstonehaugh III";
      const keep = await seedPlayer(request, "Keeper");
      const go = await seedPlayer(request, "Leaver");
      const newcomer = await seedPlayer(request, "Newcomer");
      const leaverId = await seedPair(request, divisionId, [keep, go], leaverName);
      for (let i = 0; i < 3; i++) await seedPair(request, divisionId, [await seedPlayer(request, `Opp${i}a`), await seedPlayer(request, `Opp${i}b`)]);
      const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
        seq: 1,
        kind,
        name: kind === "swiss" ? "Swiss" : "Bracket",
        config: kind === "swiss" ? { rounds: 2 } : {},
      });
      expect(stage.status, JSON.stringify(stage.error)).toBe(201);
      const stageId = stage.data!.id;
      expect((await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST")).status).toBe(200);
      if (kind === "swiss") expect((await generate(request, stageId)).status, "Pair round one").toBe(200);
      const mine = async () =>
        ((await stageFixtures(request, divisionId, stageId)) as (Pairing & { status: string })[]).filter(
          (f) => (f.home_entrant_id === leaverId || f.away_entrant_id === leaverId) && f.home_entrant_id !== null && f.away_entrant_id !== null,
        );
      expect(await mine(), "premise: she holds a seated line").toHaveLength(1);
      const roster = await storedMembers(request, leaverId);

      await page.goto(await divisionPath(request, divisionId, "?tab=entrants"));
      await dismissCookieBanner(page);
      const toggle = page.getByRole("cell", { name: leaverName }).getByRole("button", { name: leaverName, exact: false });
      await expect(toggle).toBeVisible({ timeout: 20_000 });
      await toggle.click();
      // 1. A substitute: refused, in the console's words (format-neutral), and nothing moves.
      await stagePartnerSwap(page, go.name, newcomer.name);
      const refusedRes = page.waitForResponse((res) => new URL(res.url()).pathname === `/api/v1/entrants/${leaverId}` && res.request().method() === "PATCH", { timeout: 20_000 });
      await saveRoster(page).click();
      expect((await refusedRes).status()).toBe(422);
      const error = page.getByTestId("entrants-error");
      await expect(error).toHaveText(uiEn["roundrobin.refusal.RR_SUBSTITUTE_PARTNER_REFUSED"]!, { timeout: 20_000 });
      expect(await storedMembers(request, leaverId), "the roster is as it was").toBe(roster);
      expect((await apiJson<{ status: string }>(request, `/api/v1/entrants/${leaverId}`)).data!.status).not.toBe("withdrawn");
      expect((await mine()).map((f) => f.status), "her line did not move").not.toContain("forfeited");

      // 2. The partner dropped: the pair withdraws and her seated line is a walkover to the opponent.
      await page.reload();
      await dismissCookieBanner(page);
      await toggle.click();
      const rosterBox = page.getByTestId("entrant-roster");
      await expect(rosterBox.getByText(go.name, { exact: true })).toBeVisible();
      await rosterBox.locator("div", { has: page.getByText(go.name, { exact: true }) }).last().getByRole("button", { name: uiEn["entrants.roster.remove"] }).click();
      const sent = page.waitForResponse((res) => new URL(res.url()).pathname === `/api/v1/entrants/${leaverId}` && res.request().method() === "PATCH", { timeout: 30_000 });
      await saveRoster(page).click();
      expect((await sent).status()).toBe(200);
      await expect.poll(async () => (await apiJson<{ status: string }>(request, `/api/v1/entrants/${leaverId}`)).data!.status, { timeout: 20_000 }).toBe("withdrawn");
      expect((await mine()).map((f) => f.status), `${kind}: her line is walked over, not voided`).toEqual(["forfeited"]);
      await expect(saveRoster(page), "no live Save on a withdrawn pair").toHaveCount(0);
      expect(await storedMembers(request, leaverId), "the server kept both people").toBe(roster);
    });
  }
});

// X-CUT-4 (W5 T11, FX-G16's table half; RB5-K6): a correction inside a COMPLETED league. An organiser cannot void a result the next
// stage built on, so the unwind a correction really is: take the decided line's events back, re-record it the other way. Before the
// finals start the confirmed proposal goes stale and its seats go back to TBD; a fresh draft waits on the desk and its confirm seats
// the new qualifier. After they start the bracket stands and the desk names who moved.
// Six players, the better seed winning every line, so the table is P1..P6 and the top-four cut P1..P4. The correction: P5 won the match
// P4 was given, so P5 (6 points) is above P4 (3): the cut is P1, P2, P3, P5.
test.describe("X-CUT-4 a corrected league is re-proposed", () => {
  type Line = Fx & { home_entrant_id: string | null; away_entrant_id: string | null; status: string };
  type Proposal = { id: string; computed: { qualifiers: { entrantId: string }[]; ties: { slots: string[]; entrantIds: string[] }[] } };
  // Realistic long names (43 characters) for the two the warning names: the notice must wrap, never scroll the page.
  const LONG_OUT = "Alexandria Montgomery-Featherstonehaugh III";
  const LONG_IN = "Bartholomew Cholmondeley-Featherstonehaugh";

  /** A played line: start, then the result (a corrected line is started again after its events were taken back). */
  async function resultOf(request: APIRequestContext, line: Line, winnerIsHome: boolean): Promise<void> {
    for (const [type, payload] of [
      ["core.start", {}] as const,
      ["generic.result", winnerIsHome ? { p1Score: 2, p2Score: 0 } : { p1Score: 0, p2Score: 2 }] as const,
    ]) {
      const state = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${line.id}/state`);
      const res = await apiJson(request, `/api/v1/fixtures/${line.id}/events`, "POST", { expected_seq: state.data!.last_seq, type, payload });
      expect(res.status, `${type}: ${JSON.stringify(res.error)}`).toBe(201);
    }
  }

  /** Take a line's decision back: every live event, newest first, as a scorer's Undo does. */
  async function takeBack(request: APIRequestContext, fixtureId: string): Promise<void> {
    const ledger = await apiJson<{ id: string; seq: number; type: string; voids_event_id: string | null }[]>(request, `/api/v1/fixtures/${fixtureId}/events?since_seq=0`);
    expect(ledger.status, JSON.stringify(ledger.error)).toBe(200);
    const voided = new Set(ledger.data!.map((e) => e.voids_event_id));
    const live = ledger.data!.filter((e) => e.type !== "core.void" && !voided.has(e.id)).sort((a, b) => b.seq - a.seq);
    expect(live.length, "premise: the line holds live events").toBeGreaterThan(0);
    for (const e of live) {
      const state = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${fixtureId}/state`);
      const res = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", { expected_seq: state.data!.last_seq, type: "core.void", payload: { event_id: e.id } });
      expect(res.status, JSON.stringify(res.error)).toBeLessThan(300);
    }
  }

  const propose = (request: APIRequestContext, stageId: string) => apiJson<Proposal>(request, `/api/v1/stages/${stageId}/seed-proposal`, "POST");

  /** A completed league of six, its top four confirmed into a started-nowhere knockout. P4 and P5 carry the long names. */
  async function confirmedFinals(request: APIRequestContext, label: string) {
    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `${label} ${TAG}`, visibility: "private" });
    expect(comp.status, JSON.stringify(comp.error)).toBe(201);
    const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", { name: "Open", sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG });
    expect(div.status, JSON.stringify(div.error)).toBe(201);
    const divisionId = div.data!.id;
    const added = await apiJson<{ id: string; display_name: string }[]>(request, `/api/v1/divisions/${divisionId}/entrants`, "POST",
      Array.from({ length: 6 }, (_, i) => ({ kind: "individual", display_name: i === 3 ? LONG_OUT : i === 4 ? LONG_IN : `CUT P${i + 1} ${TAG}`, seed: i + 1 })));
    expect(added.status, JSON.stringify(added.error)).toBe(201);
    const ids = added.data!.map((e) => e.id);
    const seedOf = new Map(ids.map((id, i) => [id, i + 1]));
    const nameOf = new Map(added.data!.map((e) => [e.id, e.display_name]));
    const league = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", { seq: 1, kind: "league", name: "League", config: { legs: 1 } });
    expect(league.status, JSON.stringify(league.error)).toBe(201);
    const finals = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
      seq: 2,
      kind: "knockout",
      name: "Finals",
      config: {},
      progression: { sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }], placement: "rank_order", timing: "setup" },
    });
    expect(finals.status, JSON.stringify(finals.error)).toBe(201);
    expect((await apiJson(request, `/api/v1/stages/${finals.data!.id}/generate`, "POST")).status).toBe(200);
    expect((await apiJson(request, `/api/v1/stages/${league.data!.id}/generate`, "POST")).status).toBe(200);
    expect((await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST")).status).toBe(200);
    const leagueRows = async () => (await stageFixtures(request, divisionId, league.data!.id)) as Line[];
    const finalsRows = async () => (await stageFixtures(request, divisionId, finals.data!.id)) as Line[];
    const lines = await leagueRows();
    expect(lines.length, "anti-vacuity: fifteen lines to play").toBe(15);
    for (const f of lines) await resultOf(request, f, seedOf.get(f.home_entrant_id!)! < seedOf.get(f.away_entrant_id!)!);
    const done = await apiJson<{ completed: boolean }>(request, `/api/v1/stages/${league.data!.id}/complete`, "POST");
    expect([done.status, done.data?.completed], JSON.stringify(done.error)).toEqual([200, true]);
    const made = await propose(request, finals.data!.id);
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    expect(made.data!.computed.ties, "premise: the better seed won every line, so no tie").toEqual([]);
    const confirmed = await apiJson(request, `/api/v1/stages/${finals.data!.id}/seed-proposal/confirm`, "POST", { proposalId: made.data!.id });
    expect(confirmed.status, JSON.stringify(confirmed.error)).toBe(200);
    return { divisionId, leagueId: league.data!.id, finalsId: finals.data!.id, ids, seedOf, nameOf, leagueRows, finalsRows };
  }

  type Confirmed = Awaited<ReturnType<typeof confirmedFinals>>;
  const seatsOf = (rows: Line[]) => rows.flatMap((f) => [f.home_entrant_id, f.away_entrant_id]).filter((x): x is string => x !== null);
  /** The line P4 v P5 and P5 winning it: the correction that moves P5 across the cut. */
  async function correctP4P5(request: APIRequestContext, q: Confirmed): Promise<void> {
    const [p4, p5] = [q.ids[3]!, q.ids[4]!];
    const line = (await q.leagueRows()).find((f) => [f.home_entrant_id, f.away_entrant_id].sort().join() === [p4, p5].sort().join())!;
    expect(line, "premise: the league holds P4 v P5").toBeTruthy();
    await takeBack(request, line.id);
    await resultOf(request, line, line.home_entrant_id === p5);
  }

  test("before the finals start: the seats go back, a fresh draft waits on the desk, and its confirm seats the new qualifier on the run sheet", async ({ page, request }) => {
    test.setTimeout(300_000);
    const q = await confirmedFinals(request, "Corrected league");
    const [p4, p5] = [q.ids[3]!, q.ids[4]!];
    expect(seatsOf(await q.finalsRows()).sort(), "premise: the confirmed finals seat P1..P4").toEqual(q.ids.slice(0, 4).sort());

    await correctP4P5(request, q);

    expect(seatsOf(await q.finalsRows()), "the confirmed cut no longer stands: the seats go back").toEqual([]);
    await page.goto(await divisionPath(request, q.divisionId, "?tab=fixtures"));
    await expect(page.locator('[data-progression-state="draft"]'), "a fresh draft waits on the desk with nobody asking").toBeVisible({ timeout: 20_000 });
    const fresh = await propose(request, q.finalsId);
    expect(fresh.status, JSON.stringify(fresh.error)).toBe(201);
    expect(fresh.data!.computed.qualifiers.map((x) => x.entrantId), "P5 in P4's place, the table's order").toEqual([q.ids[0], q.ids[1], q.ids[2], p5]);
    const confirmed = await apiJson(request, `/api/v1/stages/${q.finalsId}/seed-proposal/confirm`, "POST", { proposalId: fresh.data!.id });
    expect(confirmed.status, JSON.stringify(confirmed.error)).toBe(200);

    const seated = await q.finalsRows();
    expect(seatsOf(seated).sort(), "P1, P2, P3 and P5 hold the seats").toEqual([q.ids[0], q.ids[1], q.ids[2], p5].sort());
    await page.goto(await divisionPath(request, q.divisionId, "?tab=fixtures"));
    await showAllFixtures(page);
    const row = page.locator(`li[data-fixture-no="${seated.find((f) => f.home_entrant_id === p5 || f.away_entrant_id === p5)!.fixture_no}"]`);
    await expect(row, "the run sheet seats the new qualifier").toContainText(q.nameOf.get(p5)!, { timeout: 20_000 });
    await expect(row).not.toContainText(q.nameOf.get(p4)!);
  });

  test("before the finals start, a confirmed qualifier leaves: the seat is given back and the next eligible takes it", async ({ request }) => {
    test.setTimeout(300_000);
    const q = await confirmedFinals(request, "Departed qualifier");
    const left = await apiJson(request, `/api/v1/entrants/${q.ids[2]}/withdraw`, "POST");
    expect(left.status, JSON.stringify(left.error)).toBe(200);
    expect(seatsOf(await q.finalsRows()), "her seat is given back, nobody is walked over").toEqual([]);
    const fresh = await propose(request, q.finalsId);
    expect(fresh.status, JSON.stringify(fresh.error)).toBe(201);
    expect(fresh.data!.computed.qualifiers.map((x) => x.entrantId), "RB5-K2: the 5th place takes the vacated place").toEqual([q.ids[0], q.ids[1], q.ids[3], q.ids[4]]);
  });

  test("after the finals start: the bracket stands and the organiser's desk names who moved, at every width", async ({ page, request }) => {
    test.setTimeout(300_000);
    const q = await confirmedFinals(request, "Bracket stands");
    const [p4, p5] = [q.ids[3]!, q.ids[4]!];
    const first = (await q.finalsRows()).find((f) => f.home_entrant_id !== null && f.away_entrant_id !== null)!;
    await apiJson(request, `/api/v1/fixtures/${first.id}/events`, "POST", { expected_seq: 0, type: "core.start", payload: {} });
    const before = await q.finalsRows();

    await correctP4P5(request, q);

    expect(await q.finalsRows(), "no seat moved").toEqual(before);
    expect((await propose(request, q.finalsId)).error?.code, "the proposal stays confirmed").toBe("SEEDING_ALREADY_CONFIRMED");

    const warning = page.getByTestId("table-cut-drift-warning");
    const words = uiEn["table.cutDrift.warning.one"]!;
    expect(words, "premise: the dictionary has the sentence").toBeTruthy();
    for (const width of [1280, 768, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(await divisionPath(request, q.divisionId, "?tab=fixtures"));
      await expect(warning, `visible at ${width}`).toBeVisible({ timeout: 20_000 });
      await expect(warning, "the dictionary's sentence, each name on its own side").toHaveText(words.replace("{in}", q.nameOf.get(p5)!).replace("{out}", q.nameOf.get(p4)!));
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `no horizontal page scroll at ${width}`).toBeLessThanOrEqual(0);
    }
  });
});

// W5 round-robin app PR A, Task 15 (X-BD-3, NEW-W1d-5, S1). The gallery's super-groups card is sport-agnostic: the sheet asks
// the organiser for the sport, variant, entrant kind and field, and the division is built for THAT sport. Driven through the
// real card, sheet and POST, and read back from the division the product wrote.
test.describe("X-BD-3 the gallery makes a badminton super-groups event", () => {
  test("pick the card, choose badminton, pairs and 24 players: the division is badminton, narrowed to pairs, with 6 pools of 4 then 2 groups then a knockout; at every width the sheet does not scroll sideways", async ({ page, request }) => {
    test.setTimeout(180_000);
    const orgs = await apiJson<{ slug: string }[]>(request, "/api/orgs");
    const orgSlug = orgs.data?.[0]?.slug;
    expect(orgSlug, "an org for the signed-in session").toBeTruthy();
    for (const width of [1280, 768, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/o/${orgSlug}/c/new`);
      await dismissCookieBanner(page);
      await page.getByTestId("template-card-super-groups").click();
      const sheet = page.getByRole("dialog");
      await expect(sheet).toBeVisible();
      await expect(page.getByTestId("template-choice"), `the choice block is shown at ${width}`).toBeVisible();
      if (width !== 1280) {
        await expectNoHorizontalScroll(page);
        continue;
      }
      await page.getByTestId("template-choice-sport").selectOption("badminton");
      await page.getByTestId("template-choice-kind").selectOption("pair");
      await page.getByTestId("template-choice-count").selectOption("24");
      await sheet.getByLabel("Ends on", { exact: false }).fill("2030-12-31");
      const name = `Super groups ${TAG}`;
      await sheet.getByLabel("Name", { exact: false }).first().fill(name);
      const posted = page.waitForResponse((r) => r.url().includes("/api/v1/competitions/from-template") && r.request().method() === "POST");
      await page.getByTestId("template-detail-submit").click();
      const res = await posted;
      expect(res.status(), await res.text()).toBe(201);
      const body = (await res.json()) as { data: { divisions: { id: string }[] } };
      expect(body.data.divisions.length, "one division").toBe(1);
      const divisionId = body.data.divisions[0]!.id;
      const div = await apiJson<{ sport_key: string; config: { entrants?: { kinds?: string[] } } }>(request, `/api/v1/divisions/${divisionId}`);
      expect(div.data?.sport_key).toBe("badminton");
      expect(div.data?.config.entrants?.kinds, "the kind the organiser chose narrows the division").toEqual(["pair"]);
      const stages = await apiJson<{ seq: number; kind: string; config: { pools?: { count: number } } }[]>(request, `/api/v1/divisions/${divisionId}/stages`);
      const ordered = [...stages.data!].sort((a, b) => a.seq - b.seq);
      expect(ordered.map((st) => st.kind)).toEqual(["group", "group", "knockout"]);
      expect(ordered.map((st) => st.config.pools?.count), "24 players in pools of 4, then 2 super groups").toEqual([6, 2, undefined]);
    }
  });
});

// W5 app PR A, Task 13 (X-PO-3 <- RB5-P5, X-PO-4 <- RB5-P7; ST-G14 app half; ruling 288). A rank override is checked at write: a pin above
// the table's size is refused by name and stores nothing (main stored it and the engine threw it at the next recompute), a pin on a knockout
// stage is refused by name, and a withdrawal takes the leaver's pin with her. Driven through the route the desk's override calls; there is no
// screen to verify (the refusal sentences are the dictionary's `roundrobin.refusal.*`, rendered by the toast that already shows them).
test.describe("X-PO-3 / X-PO-4 a rank override is checked at write", () => {
  test("a league of four: rank 5 is refused, rank 4 is kept, a knockout stage is refused, a withdrawal drops the leaver's pin", async ({ request }) => {
    test.setTimeout(90_000);
    const { divisionId, stageId, ids } = await seedLeague(request, "Pin", 4);
    expect((await generate(request, stageId)).status).toBe(200);
    const pins = async () =>
      (await apiJson<{ id: string; config: { rank_overrides?: { entrant_id: string; rank: number }[] } }[]>(request, `/api/v1/divisions/${divisionId}/stages`)).data!.find(
        (s) => s.id === stageId,
      )!.config.rank_overrides;
    const pin = (target: string, entrants: { id: string; rank: number }[]) =>
      apiJson(request, `/api/v1/stages/${target}/standings/override`, "POST", {
        rows: entrants.map((e) => ({ entrant_id: e.id, rank: e.rank, reason: "e2e" })),
      });

    const over = await pin(stageId, [{ id: ids[0]!, rank: 5 }]);
    expect(over.status, "above the table's size").toBe(422);
    expect(over.error?.code).toBe("RR_RANK_OVERRIDE_POOL");
    expect(await pins(), "a refused write stores nothing").toBeUndefined();

    expect((await pin(stageId, [{ id: ids[0]!, rank: 4 }, { id: ids[1]!, rank: 3 }])).status, "the table's own size is fine").toBe(200);
    expect((await pins())?.map((p) => `${p.entrant_id}:${p.rank}`).sort()).toEqual([`${ids[0]}:4`, `${ids[1]}:3`].sort());

    const ko = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", { seq: 2, kind: "knockout", name: "Finals", config: {} });
    expect(ko.status, JSON.stringify(ko.error)).toBe(201);
    const onKo = await pin(ko.data!.id, [{ id: ids[0]!, rank: 1 }]);
    expect(onKo.status, "a bracket has no table").toBe(422);
    expect(onKo.error?.code).toBe("RR_RANK_OVERRIDE_NOT_TABLE");

    expect((await apiJson(request, `/api/v1/entrants/${ids[0]}/withdraw`, "POST")).status).toBe(200);
    expect((await pins())?.map((p) => p.entrant_id), "only the leaver's pin goes").toEqual([ids[1]]);
  });
});

// W5 app PR A, Task 17 (X-BD-4 <- RB5-S4; CS-1). A second Complete on a stage that is already complete answers `already_complete` and writes
// nothing: no second proposal, no draw, no division completed twice. Driven through the route the desk's Complete button calls, and on the
// desk itself with a stale tab (another tab completed the stage first), where main read "Stage is not ready to complete".
test.describe("X-BD-4 a second Complete is a no-op that says so", () => {
  async function played(request: APIRequestContext, label: string, withFinals: boolean) {
    const league = await seedLeague(request, label, 4);
    let finalsId: string | undefined;
    if (withFinals) {
      const ko = await apiJson<{ id: string }>(request, `/api/v1/divisions/${league.divisionId}/stages`, "POST", {
        seq: 2,
        kind: "knockout",
        name: "Finals",
        config: {},
        progression: { sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] }], placement: "rank_order", timing: "setup" },
      });
      expect(ko.status, JSON.stringify(ko.error)).toBe(201);
      finalsId = ko.data!.id;
      expect((await generate(request, finalsId)).status, "the day-one bracket").toBe(200);
    }
    expect((await generate(request, league.stageId)).status).toBe(200);
    expect((await apiJson(request, `/api/v1/divisions/${league.divisionId}/start`, "POST")).status).toBe(200);
    const rows = (await stageFixtures(request, league.divisionId, league.stageId)) as Pairing[];
    expect(rows.length, "C(4,2) lines").toBe(6);
    const seed = new Map(league.ids.map((id, i) => [id, i]));
    for (const f of rows) {
      const homeWins = (seed.get(f.home_entrant_id!) ?? 99) < (seed.get(f.away_entrant_id!) ?? 99);
      const res = await apiJson(request, `/api/v1/fixtures/${f.id}/events`, "POST", {
        expected_seq: 0,
        type: "generic.result",
        payload: homeWins ? { p1Score: 2, p2Score: 0 } : { p1Score: 0, p2Score: 2 },
      });
      expect(res.status, JSON.stringify(res.error)).toBe(201);
    }
    return { ...league, finalsId };
  }
  type Done = { completed: boolean; already_complete?: boolean; division_completed?: boolean; seed_proposal?: { id: string; status: string } | null };
  const complete = (request: APIRequestContext, stageId: string) => apiJson<Done>(request, `/api/v1/stages/${stageId}/complete`, "POST");

  test("a league feeding a setup knockout: the second and third Complete name the one draft and change nothing", async ({ request }) => {
    test.setTimeout(120_000);
    const r = await played(request, "Twice", true);
    const first = await complete(request, r.stageId);
    expect(first.status, JSON.stringify(first.error)).toBe(200);
    expect(first.data).toMatchObject({ completed: true, seed_proposal: { status: "draft" } });
    expect(first.data!.already_complete, "the first completion is not a repeat").toBeUndefined();
    const finalsBefore = (await stageFixtures(request, r.divisionId, r.finalsId!)) as Pairing[];

    for (const call of ["second", "third"]) {
      const again = await complete(request, r.stageId);
      expect(again.status, `${call}: ${JSON.stringify(again.error)}`).toBe(200);
      expect(again.data, `${call}: differential - main answered completed: true with no already_complete`).toEqual({
        completed: false,
        already_complete: true,
        events: [],
        seed_proposal: first.data!.seed_proposal,
      });
    }
    expect(await stageFixtures(request, r.divisionId, r.finalsId!), "the knockout's lines are exactly as they were").toEqual(finalsBefore);
  });

  test("the last stage: the second Complete does not complete the division again", async ({ request }) => {
    test.setTimeout(120_000);
    const r = await played(request, "Last", false);
    const first = await complete(request, r.stageId);
    expect(first.data).toMatchObject({ completed: true, division_completed: true });
    const again = await complete(request, r.stageId);
    expect(again.data).toEqual({ completed: false, already_complete: true, events: [], seed_proposal: null });
    expect(again.data!.division_completed, "not completed a second time").toBeUndefined();
  });

  test("a stale tab: Complete pressed after another tab completed the stage says it was already complete, never 'not ready'", async ({ page, request }) => {
    test.setTimeout(180_000);
    const r = await played(request, "Stale", false);
    await page.goto(await divisionPath(request, r.divisionId, "?tab=fixtures"));
    await dismissCookieBanner(page);
    const button = page.getByTestId("stage-complete");
    await expect(button, "every match is settled: Complete is offered").toBeEnabled({ timeout: 20_000 });
    expect((await complete(request, r.stageId)).data?.completed, "the other tab completes it first").toBe(true);

    await button.click();
    const said = uiEn["schedule.notice.alreadyComplete"]!;
    expect(said, "premise: the dictionary has the sentence").toBeTruthy();
    await expect(page.getByText(said), "the desk says so in the organiser's words").toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(uiEn["schedule.notice.notReady"]!)).toHaveCount(0);
  });
});

test.describe("X-BD-1 the builder refuses 7 into 4 and offers 3", () => {
  // differential: the builder judged only the pool count's bounds (2..8), so 4 pools passed Next for a plan of 7 and the server's first
  // Generate then refused the division (C38). Now Next refuses first, with the server's numbers and the count that works (RB5-E4: floor(7/3)=2).
  test("a plan of 7 in 4 pools stops Next naming 3; 3 pools (or a plan of 8) lets it go on, at every width", async ({ page, request }) => {
    test.setTimeout(180_000);
    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `X-BD-1 pools ${TAG}`, visibility: "private" });
    expect(comp.status, JSON.stringify(comp.error)).toBe(201);
    await page.goto(await competitionPath(request, comp.data!.id, "/d/new"));
    await dismissCookieBanner(page);
    await page.getByTestId("division-builder-name").fill(`Pool gate ${TAG}`);
    await pickBuilderSport(page, "badminton");
    await page.getByTestId("division-builder-next").click();
    await expect(page.getByTestId("division-builder")).toHaveAttribute("data-step", "format");

    const card = page.locator('label[data-template="groups_ko"]');
    if (!(await card.isVisible())) await showAllFormats(page);
    await card.click();
    await expect(card.locator('input[type="radio"]')).toBeChecked();
    const plan = page.getByTestId("division-builder-plan-entrants");
    const pools = page.locator('input[data-format-bound="pools"]');
    const error = page.getByTestId("division-builder-error");
    const sentence = (field: string, k: number, have: number, suggested: number) =>
      uiEn["wizard.err.poolSize"]!.replace("{field}", field).replace("{pools}", String(k)).replace("{required}", String(2 * k)).replace("{entrants}", String(have)).replace("{suggested}", String(suggested));

    // The empty case first: the opening plan fills the opening pools, so Next goes on and nothing is refused.
    await expect(error).toHaveCount(0);

    await plan.fill("7");
    await pools.fill("4");
    for (const width of [1280, 768, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.getByTestId("division-builder-next").click();
      await expect(page.getByTestId("division-builder"), `${width}: Next did not move`).toHaveAttribute("data-step", "format");
      await expect(error, `${width}: the refusal names 3`).toHaveText(sentence(uiEn["wizard.pools"]!, 4, 7, 3));
      await expect(error).toBeVisible();
      await expectNoHorizontalScroll(page);
    }
    await page.setViewportSize({ width: 1280, height: 900 });

    // The count it offered works: the refusal goes with the number it named, and Next moves on.
    await pools.fill("3");
    await expect(error).toHaveCount(0);
    await page.getByTestId("division-builder-next").click();
    await expect(page.getByTestId("division-builder")).toHaveAttribute("data-step", "rules");

    // Back, and 4 pools with a plan of 8 (2 per pool) passes too: the gate is the field, not the pool count.
    await page.getByTestId("division-builder-step-format").click();
    await pools.fill("4");
    await plan.fill("8");
    await page.getByTestId("division-builder-next").click();
    await expect(page.getByTestId("division-builder")).toHaveAttribute("data-step", "rules");
  });
});

test.describe("X-BD-8 the builder refuses a cut the field cannot supply and names the largest that works", () => {
  // differential: the builder judged only the Top N's bounds (2..32), so a Top 8 of a plan of 6 passed Next and the server met it at Complete.
  // Now Next refuses first with the numbers the server's Start refuses with (RB5-E6): a Top 8 of 6 names 6; two pools of 4 and 3 supply a top 6.
  test("a Top 8 of a plan of 6 stops Next naming 6; 6 of 6 lets it go on; a best-Nth cut no pool can supply names the pool shape's maximum, at every width", async ({ page, request }) => {
    test.setTimeout(180_000);
    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `X-BD-8 cut ${TAG}`, visibility: "private" });
    expect(comp.status, JSON.stringify(comp.error)).toBe(201);
    await page.goto(await competitionPath(request, comp.data!.id, "/d/new"));
    await dismissCookieBanner(page);
    await page.getByTestId("division-builder-name").fill(`Cut gate ${TAG}`);
    await pickBuilderSport(page, "badminton");
    await page.getByTestId("division-builder-next").click();
    await expect(page.getByTestId("division-builder")).toHaveAttribute("data-step", "format");

    const plan = page.getByTestId("division-builder-plan-entrants");
    const qualify = page.locator('input[data-format-bound="qualify"]');
    const error = page.getByTestId("division-builder-error");
    const exceeds = (have: number, top: number, max: number) =>
      uiEn["wizard.err.cutExceedsField"]!.replace("{field}", uiEn["wizard.qualify"]!).replace("{qualified}", String(top)).replace("{entrants}", String(have)).replaceAll("{max}", String(max));
    const bestNth = (pools: number, top: number, max: number) =>
      uiEn["wizard.err.cutBestNth"]!.replace("{field}", uiEn["wizard.qualify"]!).replace("{pools}", String(pools)).replace("{qualified}", String(top)).replaceAll("{max}", String(max));
    const pick = async (template: string) => {
      const card = page.locator(`label[data-template="${template}"]`);
      if (!(await card.isVisible())) await showAllFormats(page);
      await card.click();
      await expect(card.locator('input[type="radio"]')).toBeChecked();
    };

    // League + knockout: the empty case first - the opening plan supplies the opening Top N, so nothing is refused.
    await pick("league_ko");
    await expect(error).toHaveCount(0);
    await plan.fill("6");
    await qualify.fill("8");
    for (const width of [1280, 768, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.getByTestId("division-builder-next").click();
      await expect(page.getByTestId("division-builder"), `${width}: Next did not move`).toHaveAttribute("data-step", "format");
      await expect(error, `${width}: the refusal names 6`).toHaveText(exceeds(6, 8, 6));
      await expect(error).toBeVisible();
      await expectNoHorizontalScroll(page);
    }
    await page.setViewportSize({ width: 1280, height: 900 });

    // The number it named works (the pin: a cut equal to the field), and Next moves on.
    await qualify.fill("6");
    await expect(error).toHaveCount(0);
    await page.getByTestId("division-builder-next").click();
    await expect(page.getByTestId("division-builder")).toHaveAttribute("data-step", "rules");

    // Groups + knockout: 7 into two pools (4 and 3) cannot supply a best 4th, so a Top 7 names the shape's maximum, 6.
    await page.getByTestId("division-builder-step-format").click();
    await pick("groups_ko");
    await plan.fill("7");
    await page.locator('input[data-format-bound="pools"]').fill("2");
    await qualify.fill("7");
    await page.getByTestId("division-builder-next").click();
    await expect(page.getByTestId("division-builder")).toHaveAttribute("data-step", "format");
    await expect(error).toHaveText(bestNth(2, 7, 6));
    await qualify.fill("6");
    await expect(error).toHaveCount(0);
    await page.getByTestId("division-builder-next").click();
    await expect(page.getByTestId("division-builder")).toHaveAttribute("data-step", "rules");
  });
});

test.describe("X-BD-2 the builder makes a groups-only division", () => {
  // differential: the picker had no pools-only card - "Groups only" (pools, each a round robin, the pool tables the result) could be reached
  // only through the API (NEW-W1d-5), so an organiser who wanted no knockout had to take Groups + Knockout and ignore its finals. R24 pick 9A: its
  // own card, the Pools and Legs knobs, and none of the knockout ones.
  test("the Groups only card shows Pools and Legs and no Top N, third place or carry; Review names it; Create stores ONE group stage with no progression, at every width", async ({ page, request }) => {
    test.setTimeout(240_000);
    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `X-BD-2 groups only ${TAG}`, visibility: "private" });
    expect(comp.status, JSON.stringify(comp.error)).toBe(201);
    await page.goto(await competitionPath(request, comp.data!.id, "/d/new"));
    await dismissCookieBanner(page);
    await page.getByTestId("division-builder-name").fill(`Groups only ${TAG}`);
    await pickBuilderSport(page, "badminton");
    await page.getByTestId("division-builder-next").click();
    await expect(page.getByTestId("division-builder")).toHaveAttribute("data-step", "format");

    const card = page.locator('label[data-template="group_only"]');
    if (!(await card.isVisible())) await showAllFormats(page);
    await expect(card, "the card is on the picker").toBeVisible();
    // The card's words are the dictionary's (label, help), and it draws the group stage alone (one stage, no chevron).
    await expect(card).toContainText(uiEn["format.template.group_only.label"]!);
    await expect(card).toContainText(uiEn["format.template.group_only.help"]!);
    await expect(card.locator("[data-format-shape]")).toHaveAttribute("data-format-shape", "group");
    const order = await page.locator("label[data-template]").evaluateAll((els) => els.map((el) => el.getAttribute("data-template") ?? ""));
    expect(order, "group_only is among the cards").toContain("group_only");
    await card.click();
    await expect(card.locator('input[type="radio"]')).toBeChecked();

    // The knobs it shows: Pools and Legs. None of the knockout ones (the empty case: nothing a knockout owns is on screen).
    const pools = page.locator('input[data-format-bound="pools"]');
    for (const width of [1280, 768, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(pools, `${width}: Pools`).toBeVisible();
      await expect(page.getByTestId("legs-choice"), `${width}: Legs`).toBeVisible();
      await expect(page.locator('input[data-format-bound="qualify"]'), `${width}: no Top N`).toHaveCount(0);
      await expect(page.getByTestId("division-builder-carry"), `${width}: no carry`).toHaveCount(0);
      await expect(page.getByTestId("third-place-choice"), `${width}: no third place`).toHaveCount(0);
      await expectNoHorizontalScroll(page);
    }
    await page.setViewportSize({ width: 1280, height: 900 });

    // The pool gate is the groups_ko one (X-BD-1): 7 entrants in 4 pools stops Next naming 3.
    await page.getByTestId("division-builder-plan-entrants").fill("7");
    await pools.fill("4");
    await page.getByTestId("division-builder-next").click();
    await expect(page.getByTestId("division-builder")).toHaveAttribute("data-step", "format");
    await expect(page.getByTestId("division-builder-error")).toContainText("3");
    // 12 entrants in 3 pools is fine, and nothing about a Top N is ever asked.
    await page.getByTestId("division-builder-plan-entrants").fill("12");
    await pools.fill("3");
    await expect(page.getByTestId("division-builder-error")).toHaveCount(0);
    await page.getByTestId("division-builder-next").click();
    await expect(page.getByTestId("division-builder")).toHaveAttribute("data-step", "rules");
    await page.getByTestId("division-builder-next").click();
    await expect(page.getByTestId("division-builder")).toHaveAttribute("data-step", "review");
    const format = page.locator('[data-review-row="format"]');
    await expect(format).toContainText(uiEn["format.template.group_only.label"]!);
    await expect(format).toContainText("3");
    await expect(format).not.toContainText(uiEn["format.template.groups_ko.label"]!);

    await page.getByTestId("division-builder-create").click();
    await page.waitForURL(/\/d\/[^/?]+/, { timeout: 60_000 });
    // The record: the division holds ONE stage, a group stage of three pools, nothing fed into it.
    const divisions = await apiJson<{ id: string }[]>(request, `/api/v1/competitions/${comp.data!.id}/divisions`);
    expect(divisions.status, JSON.stringify(divisions.error)).toBe(200);
    expect(divisions.data!, "one division however it was reached").toHaveLength(1);
    const stages = await apiJson<{ kind: string; config: { pools?: { count?: number }; legs?: number }; progression: unknown }[]>(request, `/api/v1/divisions/${divisions.data![0]!.id}/stages`);
    expect(stages.data!.map((s) => s.kind), "no second stage").toEqual(["group"]);
    expect(stages.data![0]!.config.pools?.count, "the Pools box's number").toBe(3);
    expect(stages.data![0]!.config.legs, "once").toBe(1);
    expect(stages.data![0]!.progression, "nothing progresses out of it").toBeNull();
  });
});

test.describe("T14b a finished multi-pool Groups only division names each pool's winner (owner 2026-11-18)", () => {
  // differential: today (f305ccc939) the division page and the hub name NOBODY for a finished two-pool Groups only division - the pool tables
  // are the whole result - and before it named the first pool's leader "Champion". The owner's ruling: each pool's winner, no champion.
  test("a finished 2-pool division shows both winners on the division page and the hub's Table tab, and no Champion", async ({ page, request }) => {
    test.setTimeout(240_000);
    const k = await seedFinishedGroupsOnly(request, { label: "T14b 2 pools", pools: 2, perPool: 3, longNames: true });
    expect(k.winners.length, "one winner per pool").toBe(2);

    await page.goto(`/live/${k.orgSlug}/${k.compSlug}/${k.divSlug}`);
    const banner = page.getByTestId("division-pool-winners");
    await expect(banner).toBeVisible();
    await expect(page.getByTestId("division-pool-winner")).toHaveCount(2);
    for (const w of k.winners) await expect(banner, w.name).toContainText(w.name);
    await expect(banner).toContainText(dictString("en", "title.poolWinners"));
    await expect(page.getByTestId("division-title-champion"), "no single champion").toHaveCount(0);
    await expect(page.getByTestId("division-title-joint")).toHaveCount(0);
    await expectNoHorizontalScroll(page);

    // the hub's Table tab: one strip for the division, the same two names
    await page.goto(`/live/${k.orgSlug}/${k.compSlug}?tab=table`);
    const strip = page.locator('[data-testid^="mh-table-pool-winners-"]');
    await expect(strip).toHaveCount(1);
    await expect(strip.getByTestId("mh-table-pool-winner")).toHaveCount(2);
    for (const w of k.winners) await expect(strip, w.name).toContainText(w.name);
    await expect(page.locator('[data-testid^="mh-table-champion-"]')).toHaveCount(0);
    await expectNoHorizontalScroll(page);

    // the API document carries them too, and no row of any table is flagged champion
    const hub = await apiJson<{ poolWinners?: { divisionId: string; pools: { entrantId: string | null }[] }[]; tables: { rows: { champion: boolean }[] }[] }>(request, `/api/v1/public/orgs/${k.orgSlug}/competitions/${k.compSlug}/hub`);
    expect(hub.status).toBe(200);
    expect(hub.data!.poolWinners?.find((w) => w.divisionId === k.divisionId)?.pools.map((p) => p.entrantId).sort()).toEqual(k.winners.map((w) => w.entrantId).sort());
    expect(hub.data!.tables.flatMap((t) => t.rows).some((r) => r.champion)).toBe(false);
    expect(LONG_NAME_SUFFIX.length, "premise: a long name was in play").toBeGreaterThan(40);
  });

  test("with one line still to play nothing is named; a one-pool division crowns its winner as champion", async ({ page, request }) => {
    test.setTimeout(240_000);
    const open = await seedFinishedGroupsOnly(request, { label: "T14b open", pools: 2, perPool: 3, decide: false });
    await page.goto(`/live/${open.orgSlug}/${open.compSlug}/${open.divSlug}`);
    await expect(page.getByTestId("division-pool-winners")).toHaveCount(0);
    await expect(page.getByTestId("division-title-champion")).toHaveCount(0);

    const one = await seedFinishedGroupsOnly(request, { label: "T14b one pool", pools: 1, perPool: 4 });
    await page.goto(`/live/${one.orgSlug}/${one.compSlug}/${one.divSlug}`);
    await expect(page.getByTestId("division-title-champion")).toContainText(one.winners[0]!.name);
    await expect(page.getByTestId("division-pool-winners")).toHaveCount(0);
  });
});

// W5 app PR A, B4 fix wave (owner 2026-11-18, RB5-W2 + RB5-W7): an UNDER-half leaver of a POOL has every result removed, so no
// counted result names her and her pool's table has no row for her - and the footnote used to key on listed rows only, so she had
// none. Now her ledger row records her pool and the note is printed under THAT pool's table, on the organiser's division page and
// the public one. Expected text: the en dictionary's own expunge sentence (the owner's R24 pick 11 A wording), typed here.
test.describe("RB5-W7 an under-half pool leaver keeps her footnote", () => {
  test("two pools of four, she leaves pool A after 1 of 3: the note sits under pool A's table only, on both division pages", async ({ page, request }) => {
    test.setTimeout(180_000);
    const label = "PoolLeaver";
    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `${label} ${TAG}`, visibility: "public" });
    expect(comp.status, JSON.stringify(comp.error)).toBe(201);
    const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", { name: "Open", sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG });
    expect(div.status, JSON.stringify(div.error)).toBe(201);
    const divisionId = div.data!.id;
    const ids = (await addEntrants(request, divisionId, label, 1, 8)).map((e) => e.id);
    const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", { seq: 1, kind: "group", name: "Groups", config: { pools: { count: 2 } } });
    expect(stage.status, JSON.stringify(stage.error)).toBe(201);
    const stageId = stage.data!.id;
    expect((await generate(request, stageId)).status).toBe(200);
    const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
    expect(started.status, JSON.stringify(started.error)).toBe(200);

    const v = ids[0]!;
    const lines = (await stageFixtures(request, divisionId, stageId)) as Pairing[];
    const hers = lines.filter((f) => f.home_entrant_id === v || f.away_entrant_id === v);
    expect(hers, "premise: a pool of four").toHaveLength(3);
    const mates = [...new Set(hers.flatMap((f) => [f.home_entrant_id!, f.away_entrant_id!]))].filter((id) => id !== v);
    const play = async (f: Pairing, homeWins: boolean) => {
      let seq = 0;
      for (const [type, payload] of [["core.start", {}], ["generic.result", homeWins ? { p1Score: 3, p2Score: 0 } : { p1Score: 0, p2Score: 3 }]] as const) {
        const ev = await apiJson<{ seq: number }>(request, `/api/v1/fixtures/${f.id}/events`, "POST", { expected_seq: seq, type, payload });
        expect(ev.status, `${type}: ${JSON.stringify(ev.error)}`).toBe(201);
        seq = ev.data!.seq;
      }
    };
    await play(hers[0]!, hers[0]!.home_entrant_id === v); // she wins her one match
    for (const f of lines.filter((x) => !hers.includes(x))) await play(f, true);
    const out = await apiJson<{ policy: string }>(request, `/api/v1/entrants/${v}/withdraw`, "POST");
    expect(out.status, JSON.stringify(out.error)).toBe(200);
    expect(out.data?.policy, "RB5-W2: 1 of 3 is under half").toBe("expunge");

    const name = (i: number) => `${label} P${i + 1} ${TAG}`;
    const vName = name(0);
    const mateNames = mates.map((id) => name(ids.indexOf(id)));
    const deskPath = await divisionPath(request, divisionId, "?tab=standings");
    const livePath = deskPath.replace(/^\/o\//, "/live/").replace(/\/c\//, "/").replace(/\/d\//, "/");
    // The live page opens on its Schedule tab: `?tab=standings` (an untranslated tab id) puts the table, and its note, in view.
    expect(livePath, "premise: the live path keeps the Standings tab").toMatch(/^\/live\/.*\?tab=standings$/);
    for (const path of [deskPath, livePath]) {
      await page.goto(path);
      await dismissCookieBanner(page);
      const note = page.getByTestId(`standings-withdrawal-note-${v}`);
      await expect(note, path).toBeVisible();
      await expect(note, path).toHaveText(`${vName} (withdrawn): left after 1 of 3, so their results are removed and their other matches are void.`);
      await expect(page.getByTestId("standings-withdrawal-notes"), `${path}: one table carries a note`).toHaveCount(1);
      // The innermost box holding both a table and the note is that table's own wrapper (document order: ancestors first).
      const table = page.locator("div").filter({ has: page.getByTestId("standings-withdrawal-notes") }).filter({ has: page.locator("table") }).last();
      const rows = table.locator('tbody th[scope="row"]');
      await expect(rows, `${path}: her pool lists her three pool-mates, not her (no counted result names her)`).toHaveCount(3);
      for (const m of mateNames) await expect(rows.filter({ hasText: m }), `${path}: ${m} is in the noted table`).toHaveCount(1);
      await expect(rows.filter({ hasText: vName }), path).toHaveCount(0);
      await expectNoHorizontalScroll(page);
    }

    const back = await apiJson(request, `/api/v1/entrants/${v}`, "PATCH", { status: "registered" });
    expect(back.status, JSON.stringify(back.error)).toBe(200);
    await page.goto(deskPath);
    await expect(page.getByTestId("standings-withdrawal-notes"), "after Reinstate the footnote is gone").toHaveCount(0);
  });
});

// W5 app PR A, Task 20 (X-SF-1 <- RB5-T10; ST-G20): the public hub's Table tab marks a leaver. The division page's table has worn a
// "Withdrawn" / "Disqualified" chip since C1; the hub renders from a server-built view and wore none (`buildTableView` took no status).
// Driven through the organiser's own doors (the withdraw route, the Disqualify status write, Reinstate) and read on the hub page a
// visitor opens, at 1280, 768 and 320. P1 carries a 43-character name, the 320px wrap case. Expected words are the product copy, typed.
test.describe("X-SF-1 the hub marks the leaver", () => {
  test("a withdrawn and a disqualified player wear their own chip on the hub's table (never each other's, never a competing row's); Reinstate takes it away; no page scroll at 1280/768/320", async ({ page, request }) => {
    test.setTimeout(240_000);
    const { divisionId, stageId, ids } = await seedLeague(request, "HubChip", 4, "public");
    expect((await generate(request, stageId)).status).toBe(200);
    const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
    expect(started.status, JSON.stringify(started.error)).toBe(200);
    const [p1, p2, p3, p4] = ids as [string, string, string, string];
    const longName = `Riverside Rovers Community Football Club 2nd ${TAG}`;
    const renamed = await apiJson(request, `/api/v1/entrants/${p1}`, "PATCH", { display_name: longName });
    expect(renamed.status, JSON.stringify(renamed.error)).toBe(200);
    const left = await apiJson(request, `/api/v1/entrants/${p1}/withdraw`, "POST");
    expect(left.status, JSON.stringify(left.error)).toBe(200);
    const dq = await apiJson(request, `/api/v1/entrants/${p2}`, "PATCH", { status: "disqualified" });
    expect(dq.status, JSON.stringify(dq.error)).toBe(200);

    const div = await apiJson<{ competition_id: string }>(request, `/api/v1/divisions/${divisionId}`);
    const organiser = await competitionPath(request, div.data!.competition_id);
    const m = /^\/o\/([^/]+)\/c\/([^/?]+)$/.exec(organiser);
    expect(m, `premise: an organiser competition path, got ${organiser}`).not.toBeNull();
    const hubUrl = `/live/${m![1]}/${m![2]}?tab=table`;
    const chip = (id: string, status: "withdrawn" | "disqualified") => page.locator(`[data-testid$="-${status}-${id}"]`);

    for (const width of [1280, 768, 320]) {
      await page.setViewportSize({ width, height: 900 });
      // the hub document may be a few seconds behind a write (ISR): reload until the leaver's chip shows
      await expect
        .poll(async () => {
          await page.goto(hubUrl);
          await dismissCookieBanner(page);
          return chip(p1, "withdrawn").count();
        }, { timeout: 60_000, intervals: [2_000], message: `@${width}: the hub's table marks the withdrawn player` })
        .toBe(1);
      await expect(chip(p1, "withdrawn"), `@${width}`).toBeVisible();
      await expect(chip(p1, "withdrawn"), `@${width}`).toHaveText("Withdrawn");
      await expect(chip(p2, "disqualified"), `@${width}`).toBeVisible();
      await expect(chip(p2, "disqualified"), `@${width}`).toHaveText("Disqualified");
      // each fact is its own: no cross-wearing, and the players still in the field wear nothing
      await expect(chip(p1, "disqualified"), `@${width}`).toHaveCount(0);
      await expect(chip(p2, "withdrawn"), `@${width}`).toHaveCount(0);
      for (const id of [p3, p4]) {
        await expect(chip(id, "withdrawn"), `@${width}`).toHaveCount(0);
        await expect(chip(id, "disqualified"), `@${width}`).toHaveCount(0);
      }
      // the long name keeps its chip on a line of its own: the chip sits BELOW the name, never beside it
      const nameBox = await page.getByTitle(longName).first().boundingBox();
      const chipBox = await chip(p1, "withdrawn").boundingBox();
      expect(nameBox, `@${width}: the name is painted`).not.toBeNull();
      expect(chipBox, `@${width}: the chip is painted`).not.toBeNull();
      expect(chipBox!.y, `@${width}: the chip is under the name`).toBeGreaterThanOrEqual(nameBox!.y + nameBox!.height - 1);
      await expectNoHorizontalScroll(page);
    }

    // Reinstate: the leaver's chip goes, the disqualified player's stays
    const back = await apiJson(request, `/api/v1/entrants/${p1}`, "PATCH", { status: "registered" });
    expect(back.status, JSON.stringify(back.error)).toBe(200);
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect
      .poll(async () => {
        await page.goto(hubUrl);
        return chip(p1, "withdrawn").count();
      }, { timeout: 60_000, intervals: [2_000], message: "after Reinstate the hub's table no longer marks her" })
      .toBe(0);
    await expect(chip(p2, "disqualified")).toHaveCount(1);
  });
});

// B5 owner fix-now (e), n1: Complete from the open-stages warning (competition settings, Status -> Completed) on a stage whose OWN
// completion commits but whose next stage cannot be seeded (STAGE_COMPLETED_SEEDING_FAILED: 7 into pools of 4 and 3, the knockout
// asks for three per pool and the best 4th - the 4th of a pool of three does not exist, RB5-E6). The stage rail says "Stage completed
// - but ..." in amber with the cut's own sentence and refreshes; the warning said "Couldn't complete this stage" in red and kept listing
// a completed stage. Expected words: the en catalog's sentences with the numbers the rulebook gives (7 asked, 6 suppliable).
test.describe("n1 the open-stages warning says completed, but", () => {
  test("Complete stage on a group whose knockout cannot be seeded: the amber 'completed, but' line with the cut's sentence, the stage complete and gone from the list; no page scroll at 1280/768/320", async ({ page, request }) => {
    test.setTimeout(300_000);
    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `n1 wrap ${TAG}`, visibility: "private" });
    expect(comp.status, JSON.stringify(comp.error)).toBe(201);
    const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", { name: "Open", sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG });
    expect(div.status, JSON.stringify(div.error)).toBe(201);
    const divisionId = div.data!.id;
    const added = await apiJson<{ id: string }[]>(request, `/api/v1/divisions/${divisionId}/entrants`, "POST",
      Array.from({ length: 7 }, (_, i) => ({ kind: "individual", display_name: `n1 P${i + 1} ${TAG}`, seed: i + 1 })));
    expect(added.status, JSON.stringify(added.error)).toBe(201);
    const seedOf = new Map(added.data!.map((e, i) => [e.id, i + 1]));
    const groups = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", { seq: 1, kind: "group", name: "Groups", config: { legs: 1, pools: { count: 2 } } });
    expect(groups.status, JSON.stringify(groups.error)).toBe(201);
    const finals = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
      seq: 2,
      kind: "knockout",
      name: "Finals",
      config: {},
      progression: {
        sources: [{ stage: "previous", take: [{ kind: "topNPerGroup", n: 3 }, { kind: "bestNth", nth: 4, count: 1, normaliseUnequalPools: true }] }],
        placement: "rank_order",
        timing: "setup",
      },
    });
    expect(finals.status, JSON.stringify(finals.error)).toBe(201);
    expect((await apiJson(request, `/api/v1/stages/${groups.data!.id}/generate`, "POST")).status).toBe(200);
    expect((await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST")).status).toBe(200);
    // after Start a later stage's Generate is not gated, so the shortfall reaches the completion's proposal (the resolve backstop)
    const fin = await apiJson(request, `/api/v1/stages/${finals.data!.id}/generate`, "POST");
    expect(fin.status, JSON.stringify(fin.error)).toBe(200);
    const lines = (await stageFixtures(request, divisionId, groups.data!.id)) as Pairing[];
    expect(lines.length, "anti-vacuity: pools of 4 and 3 play 6 + 3 lines").toBe(9);
    for (const f of lines) {
      const homeWins = seedOf.get(f.home_entrant_id!)! < seedOf.get(f.away_entrant_id!)!;
      for (const [type, payload] of [["core.start", {}], ["generic.result", homeWins ? { p1Score: 2, p2Score: 0 } : { p1Score: 0, p2Score: 2 }]] as const) {
        const state = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${f.id}/state`);
        const res = await apiJson(request, `/api/v1/fixtures/${f.id}/events`, "POST", { expected_seq: state.data!.last_seq, type, payload });
        expect(res.status, `${type}: ${JSON.stringify(res.error)}`).toBe(201);
      }
    }
    const stageStatus = async (id: string) => (await apiJson<{ status: string }>(request, `/api/v1/stages/${id}`)).data?.status;
    expect(await stageStatus(groups.data!.id), "premise: auto-advance off leaves the played group open").toBe("active");

    await page.goto(await competitionPath(request, comp.data!.id, "/settings"));
    await dismissCookieBanner(page);
    const warning = page.getByTestId("compset-open-stages");
    await page.locator("select").filter({ has: page.locator('option[value="completed"]') }).selectOption("completed");
    await expect(warning).toBeVisible();
    const complete = warning.locator(`[data-complete-stage="${groups.data!.id}"]`);
    await waitForHydration(complete);
    await complete.click();

    const reason = uiEn["roundrobin.refusal.RR_CUT_EXCEEDS_FIELD"]!.replace("{qualified}", "7").replace("{max}", "6");
    const want = uiEn["schedule.error.completedSeedingFailed"]!.replace("{reason}", reason);
    const notice = warning.locator('[data-notice-tone="warning"]');
    await expect(notice, "the amber 'completed, but' line with the cut's own sentence").toHaveText(want, { timeout: 30_000 });
    await expect(warning, "never the red 'could not complete' line").not.toContainText(uiEn["compset.openStages.completeFailed"]!);
    await expect.poll(() => stageStatus(groups.data!.id), { timeout: 30_000 }).toBe("complete");
    await expect(warning.locator(`[data-open-stage="${groups.data!.id}"]`), "the refresh drops the completed stage from the list").toHaveCount(0);
    await expect(notice, "and its line stays").toHaveText(want);
    for (const w of [1280, 768, 320]) {
      await page.setViewportSize({ width: w, height: 900 });
      await expect(notice).toBeVisible();
      await expectNoHorizontalScroll(page);
    }
  });
});

// B5 owner fix-now (d), RB5-W2: a leaver under half played has her lines EXPUNGED. The public Schedule showed each as a match still to
// come - "TBD" in the rail over a 0–0 (– – –) pill. The organiser's division page shows the same line struck through with its status
// word and no score; the public row now does the same (no time, names struck, the public dictionary's "Abandoned" where the score
// was). Read on the organiser's page too, so the two presentations are pinned side by side. Words: the en dictionaries, never typed.
test.describe("RB5-W2 the public schedule shows a leaver's removed lines as removed", () => {
  test("her three expunged lines are struck, say Abandoned, show no TBD and no score; the other lines are untouched; the division page strikes the same three; no page scroll at 1280/768/320", async ({ page, request }) => {
    test.setTimeout(240_000);
    const k = await seedExpungedLeaver(request, "Removed lines");
    const word = dictString("en", "matchCentre.status.abandoned");
    const tbd = uiEn["schedule.tbd"]!;
    const row = (id: string) => page.locator(`a.grid[href$="/fixtures/${id}"]`);
    const struck = (id: string, n: number) =>
      expect
        .poll(async () => row(id).locator("span").evaluateAll((els) => els.filter((e) => getComputedStyle(e).textDecorationLine.includes("line-through")).length))
        .toBe(n);

    // the source presentation: the organiser's fixtures tab strikes her three lines and says "abandoned"
    await page.goto(await divisionPath(request, k.divisionId, "?tab=fixtures"));
    await dismissCookieBanner(page);
    await showAllFixtures(page);
    // a round whose lines are all done folds shut - open every one, so all three of her lines are on the sheet
    const shut = page.locator('[data-testid="run-sheet-round-toggle"][aria-expanded="false"]');
    while ((await shut.count()) > 0) await shut.first().click();
    for (const no of k.removedNos) {
      const deskRow = page.locator(`li[data-fixture-no="${no}"]`);
      await expect(deskRow, "premise: the division page lists her line").toHaveCount(1);
      await expect(deskRow, "the division page says its status").toContainText(uiEn["schedule.fstatus.abandoned"]!);
      await expect(deskRow.locator("a.line-through"), "and strikes its names").toHaveCount(1);
    }

    await page.goto(`/live/${k.orgSlug}/${k.compSlug}/${k.divSlug}`);
    await dismissCookieBanner(page);
    for (const w of [1280, 768, 320]) {
      await page.setViewportSize({ width: w, height: 900 });
      let checked = 0;
      for (const id of k.removed) {
        await expect(row(id), `${w}: an expunged row is marked`).toHaveAttribute("data-expunged", "true");
        await expect(row(id).getByTestId("schedule-expunged"), `${w}: the status word in the score's place`).toHaveText(word);
        await expect(row(id), `${w}: never TBD`).not.toContainText(tbd);
        await expect(row(id).getByTestId("schedule-score"), `${w}: no score`).toHaveCount(0);
        await expect(row(id), `${w}: no 0–0`).not.toContainText("0–0");
        await struck(id, 2);
        checked += 1;
      }
      expect(checked, "anti-vacuity: her three lines").toBe(3);
      // the positive pair: the other played line keeps its score, the two still to be played keep TBD, none is struck
      await expect(row(k.played).getByTestId("schedule-score")).toHaveCount(2);
      for (const id of [k.played, ...k.open]) {
        await expect(row(id)).not.toHaveAttribute("data-expunged", "true");
        await struck(id, 0);
      }
      for (const id of k.open) await expect(row(id)).toContainText(tbd);
      await expectNoHorizontalScroll(page);
    }
  });
});
