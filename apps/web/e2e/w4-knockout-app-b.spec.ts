// W4 app PR B, batch B1 (Task 3; X-FR-4, rulings 266/267): what Complete answers for a knockout, over the real HTTP API a
// signed-in organiser's session reaches. A knockout of four with no third-place match ranks its two semi-final losers LEVEL,
// 3rd. `finalRanks` stays entrant ids in rank order (every client, the bench and the matrix read that), `places` carries the
// ranks - [1, 2, 3, 3] - and `title` says what the final crowned.
// Expected values are the rulebook's and the line rows read before the Complete; none comes from the Complete answer. Later
// batches add their journeys to this file.
import { expect, request as pwRequest, test, type APIRequestContext } from "@playwright/test";
import { TAG, activeOrg, addEntrantsViaApi, apiJson, competitionPath, divisionPath, pickBuilderSport, showAllFormats, withDb } from "./helpers";
import { dismissCookieBanner } from "./scorepad-a11y-kit";

interface Fx {
  id: string;
  stage_id: string;
  round_no: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  third_place?: boolean;
}

async function genericKnockout(request: APIRequestContext, label: string, config: Record<string, unknown> = {}) {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `W4 B ${label} ${TAG}`, visibility: "private" });
  expect(comp.status, JSON.stringify(comp.error)).toBeLessThan(300);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: `Open ${label}`,
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  expect(div.status, JSON.stringify(div.error)).toBeLessThan(300);
  const added = await addEntrantsViaApi(request, div.data!.id, ["E1", "E2", "E3", "E4"].map((n) => `${n} ${TAG}`));
  expect(added.ids).toHaveLength(4);
  const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${div.data!.id}/stages`, "POST", { seq: 1, kind: "knockout", name: "Main", config });
  expect(stage.status, JSON.stringify(stage.error)).toBe(201);
  expect((await apiJson(request, `/api/v1/stages/${stage.data!.id}/generate`, "POST")).status).toBe(200);
  expect((await apiJson(request, `/api/v1/divisions/${div.data!.id}/start`, "POST")).status).toBeLessThan(300);
  return { divisionId: div.data!.id, stageId: stage.data!.id };
}

const linesOf = async (request: APIRequestContext, divisionId: string, stageId: string): Promise<Fx[]> => {
  const res = await apiJson<Fx[]>(request, `/api/v1/divisions/${divisionId}/fixtures`);
  expect(res.status, JSON.stringify(res.error)).toBe(200);
  return res.data!.filter((f) => f.stage_id === stageId);
};

/** Decide one generic line for its HOME side (the console's result write). */
async function homeWins(request: APIRequestContext, f: Fx): Promise<void> {
  const state = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${f.id}/state`);
  const scored = await apiJson(request, `/api/v1/fixtures/${f.id}/events`, "POST", {
    expected_seq: state.data!.last_seq,
    type: "generic.result",
    payload: { p1Score: 2, p2Score: 0 },
  });
  expect(scored.status, JSON.stringify(scored.error)).toBe(201);
}

type Done = {
  completed: boolean;
  events: { type: string; finalRanks?: string[]; places?: { entrantId: string; rank: number }[]; title?: { kind: string; champion?: string } }[];
};

test.describe("X-FR-4 the stage_completed wire: finalRanks as ids, places with ranks, title", () => {
  test("a knockout of four: finalRanks four ids, places [1,2,3,3] with the semi-final losers level 3rd, title the champion; with a third-place match [1,2,3,4]", async ({ request }) => {
    test.setTimeout(120_000);
    let checked = 0;
    for (const { label, config, ranks } of [
      { label: "shared-3rd", config: {}, ranks: [1, 2, 3, 3] },
      { label: "third-place", config: { thirdPlace: true }, ranks: [1, 2, 3, 4] },
    ]) {
      const { divisionId, stageId } = await genericKnockout(request, label, config);
      for (const round of [1, 2]) for (const f of (await linesOf(request, divisionId, stageId)).filter((l) => l.round_no === round && l.home_entrant_id && l.away_entrant_id)) await homeWins(request, f);
      const rows = await linesOf(request, divisionId, stageId);
      // A third-place match (when asked for) shares the final's round and is flagged `third_place`; the final is the other one.
      const final = rows.find((l) => l.round_no === 2 && l.third_place !== true)!;
      expect(final.home_entrant_id && final.away_entrant_id, `${label}: the final is seated`).toBeTruthy();
      const done = await apiJson<Done>(request, `/api/v1/stages/${stageId}/complete`, "POST");
      expect(done.status, JSON.stringify(done.error)).toBe(200);
      const ev = done.data!.events.find((e) => e.type === "stage_completed")!;
      expect(ev.finalRanks, `${label}: finalRanks is still four ids`).toHaveLength(4);
      expect(ev.finalRanks!.every((id) => typeof id === "string")).toBe(true);
      expect(ev.places!.map((p) => p.rank), `${label}: places`).toEqual(ranks);
      expect(ev.places!.map((p) => p.entrantId), `${label}: places is finalRanks with its ranks`).toEqual(ev.finalRanks);
      expect(ev.finalRanks![0], `${label}: the final's home side won it`).toBe(final.home_entrant_id);
      expect(ev.finalRanks![1]).toBe(final.away_entrant_id);
      expect(ev.title).toEqual({ kind: "champion", champion: final.home_entrant_id });
      checked++;
    }
    expect(checked).toBe(2);
  });
});

// ─── B3b (Task 8): the plate after round two (X-PL-5) and for every field (X-PL-8) ──────────────────────────────────────────────
// A Knockout + Plate division of `n`, built stage by stage through the v1 routes (what the template writes: a main knockout and a
// plate taking `firstLosses`, drawn at setup), played by the scorer's own result events with the BETTER SEED winning every line.
// Expected fields are the rulebook's (RB4-P1: an entrant's FIRST real match loss; a bye is no match), worked by hand per n below.
interface PlateFx extends Fx {
  status: string;
}

async function plateDivision(request: APIRequestContext, label: string, n: number) {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `W4 B plate ${label} ${TAG}`, visibility: "private" });
  expect(comp.status, JSON.stringify(comp.error)).toBeLessThan(300);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: `Plate ${label}`,
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  expect(div.status, JSON.stringify(div.error)).toBeLessThan(300);
  const names = Array.from({ length: n }, (_, i) => `E${i + 1} ${TAG}`);
  const added = await addEntrantsViaApi(request, div.data!.id, names);
  expect(added.ids).toHaveLength(n);
  const main = await apiJson<{ id: string }>(request, `/api/v1/divisions/${div.data!.id}/stages`, "POST", { seq: 1, kind: "knockout", name: "Main draw", config: {} });
  expect(main.status, JSON.stringify(main.error)).toBe(201);
  const plate = await apiJson<{ id: string }>(request, `/api/v1/divisions/${div.data!.id}/stages`, "POST", {
    seq: 2,
    kind: "knockout",
    name: "Plate",
    config: {},
    progression: { sources: [{ stage: "previous", take: [{ kind: "firstLosses" }] }], placement: "rank_order", timing: "setup" },
  });
  expect(plate.status, JSON.stringify(plate.error)).toBe(201);
  expect((await apiJson(request, `/api/v1/stages/${main.data!.id}/generate`, "POST")).status).toBe(200);
  const day1 = await apiJson<{ created: number }>(request, `/api/v1/stages/${plate.data!.id}/generate`, "POST");
  expect([day1.status, day1.data?.created], "the plate has no day-one lines (owner ruling G2)").toEqual([200, 0]);
  expect((await apiJson(request, `/api/v1/divisions/${div.data!.id}/start`, "POST")).status).toBeLessThan(300);
  const seedOf = new Map(added.ids.map((id, i) => [id, i + 1] as const));
  const nameOf = new Map(added.ids.map((id, i) => [id, `E${i + 1}`] as const));
  return { divisionId: div.data!.id, mainId: main.data!.id, plateId: plate.data!.id, seedOf, nameOf };
}

const plateLines = async (request: APIRequestContext, divisionId: string, stageId: string): Promise<PlateFx[]> => {
  const res = await apiJson<PlateFx[]>(request, `/api/v1/divisions/${divisionId}/fixtures`);
  expect(res.status, JSON.stringify(res.error)).toBe(200);
  return res.data!.filter((f) => f.stage_id === stageId);
};

/** Decide every playable, undecided line of `round` of `stageId`: the lower seed wins. */
async function playRoundBetterSeed(request: APIRequestContext, rig: { divisionId: string; seedOf: Map<string, number> }, stageId: string, round: number): Promise<number> {
  let played = 0;
  for (const f of (await plateLines(request, rig.divisionId, stageId)).filter((l) => l.round_no === round && l.home_entrant_id && l.away_entrant_id && !["decided", "finalized", "forfeited"].includes(l.status))) {
    const homeBetter = (rig.seedOf.get(f.home_entrant_id!) ?? 99) < (rig.seedOf.get(f.away_entrant_id!) ?? 99);
    const state = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${f.id}/state`);
    const scored = await apiJson(request, `/api/v1/fixtures/${f.id}/events`, "POST", {
      expected_seq: state.data!.last_seq,
      type: "generic.result",
      payload: { p1Score: homeBetter ? 2 : 0, p2Score: homeBetter ? 0 : 2 },
    });
    expect(scored.status, JSON.stringify(scored.error)).toBe(201);
    played++;
  }
  return played;
}

const compute = (request: APIRequestContext, plateId: string) =>
  apiJson<{ id: string; computed: { qualifiers: { entrantId: string }[] } }>(request, `/api/v1/stages/${plateId}/seed-proposal`, "POST");

test.describe("X-PL-5 the plate draws after round 2", () => {
  test("n=5: no proposal after round 1 (the field is open), a proposal for the first losers E3 and E5 after round 2 while the main final is still to play", async ({ request }) => {
    test.setTimeout(180_000);
    const rig = await plateDivision(request, "n5", 5);
    // Five draw a bracket of eight: seeds 1-3 hold byes, so round 1 is ONE match (E4 v E5) and the bye holders open in round 2.
    expect(await playRoundBetterSeed(request, rig, rig.mainId, 1), "premise: round 1 is one real match").toBe(1);
    const early = await compute(request, rig.plateId);
    expect([early.status, early.error?.code], "after round 1 the bye holders have not played: the field is open, nothing to propose").toEqual([409, "SEEDING_SOURCE_INCOMPLETE"]);
    expect(await plateLines(request, rig.divisionId, rig.plateId), "and the plate has no lines").toEqual([]);
    expect(await playRoundBetterSeed(request, rig, rig.mainId, 2), "premise: round 2 is two matches").toBe(2);
    const final = (await plateLines(request, rig.divisionId, rig.mainId)).find((l) => l.round_no === 3)!;
    expect(["decided", "finalized"], "the main final is still to play").not.toContain(final.status);
    const lines = await plateLines(request, rig.divisionId, rig.plateId);
    expect(lines.length, "the plate is drawn at its field of two: one line").toBe(1);
    const proposal = await compute(request, rig.plateId);
    expect(proposal.status, JSON.stringify(proposal.error)).toBeLessThan(300);
    expect(proposal.data!.computed.qualifiers.map((q) => rig.nameOf.get(q.entrantId)).sort(), "the first losers: E3 (round 2) and E5 (round 1); E4's round-2 loss is not its first").toEqual(["E3", "E5"]);
  });
});

test.describe("X-PL-8 the plate completes at n=5, 6, 7, 9", () => {
  // Rulebook, by hand (better seed wins): n=5 byes 1-3 - R1 4v5 loses 5; round 2 1v4, 2v3 lose 4 (its second match) and 3 (its first), so the
  // first losers are E5 and E3. n=6 byes 1,2 - R1 4v5 and 3v6 lose 5 and 6. n=7 bye 1 - R1 2v7, 3v6, 4v5 lose 7, 6, 5. n=9 byes 1-7 -
  // R1 8v9 loses 9; round 2 1v8 (8 played already), 4v5, 3v6, 2v7 lose 5, 6, 7.
  for (const { n, field } of [
    { n: 5, field: ["E3", "E5"] },
    { n: 6, field: ["E5", "E6"] },
    { n: 7, field: ["E5", "E6", "E7"] },
    { n: 9, field: ["E5", "E6", "E7", "E9"] },
  ]) {
    test(`n=${n}: the plate takes ${field.join(", ")}, is played out, and both stages and the division complete with no 409`, async ({ request }) => {
      test.setTimeout(300_000);
      const rig = await plateDivision(request, `n${n}`, n);
      for (const r of [1, 2]) await playRoundBetterSeed(request, rig, rig.mainId, r);
      const proposal = await compute(request, rig.plateId);
      expect(proposal.status, JSON.stringify(proposal.error)).toBeLessThan(300);
      expect(proposal.data!.computed.qualifiers.map((q) => rig.nameOf.get(q.entrantId)).sort(), `n=${n}: the first losers`).toEqual(field);
      const confirmed = await apiJson<{ filled: number }>(request, `/api/v1/stages/${rig.plateId}/seed-proposal/confirm`, "POST", { proposalId: proposal.data!.id });
      expect(confirmed.status, JSON.stringify(confirmed.error)).toBeLessThan(300);
      // `filled` counts SLOT writes (a bye holder is written into its round-1 line and the line it advances to), so it is not the field:
      // the first losers seated are the distinct entrants now on the plate's lines.
      expect(confirmed.data!.filled, "at least one write per first loser").toBeGreaterThanOrEqual(field.length);
      const seated = new Set((await plateLines(request, rig.divisionId, rig.plateId)).flatMap((l) => [l.home_entrant_id, l.away_entrant_id]).filter((id): id is string => id !== null));
      expect([...seated].map((id) => rig.nameOf.get(id)).sort(), `n=${n}: every first loser is seated on the plate, and nobody else`).toEqual(field);
      for (const stageId of [rig.mainId, rig.plateId]) {
        const rounds = Math.max(...(await plateLines(request, rig.divisionId, stageId)).map((l) => l.round_no));
        for (let r = 1; r <= rounds; r++) await playRoundBetterSeed(request, rig, stageId, r);
      }
      for (const stageId of [rig.mainId, rig.plateId]) {
        const done = await apiJson<{ completed: boolean }>(request, `/api/v1/stages/${stageId}/complete`, "POST");
        expect([done.status, done.data?.completed], JSON.stringify(done.error)).toEqual([200, true]);
      }
      const division = await apiJson<{ status: string }>(request, `/api/v1/divisions/${rig.divisionId}`);
      expect(division.data?.status, "the division completes").toBe("completed");
    });
  }
});

// ─── B4 (Task 10; X-TP-2, X-TP-1, X-TP-6): the organiser's Third place choice, over the real HTTP API ─────────────────────────────
// What the stage settings' control sends: PATCH /stages/{id} { thirdPlace }. Before Start the bracket is drawn again for the new
// setting (Play-off adds a flagged line, Shared removes it); a field under four refuses with its count; once the division starts
// the setting is locked (409). Expected: the rulebook's (a third-place match needs two semi-finals, so four entrants).
test.describe("X-TP-2 the organiser picks Play-off match and the bracket holds a third-place match", () => {
  async function draftKnockout(request: APIRequestContext, label: string, n: number, config: Record<string, unknown> = {}) {
    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `W4 B3P ${label} ${TAG}`, visibility: "private" });
    const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
      name: `Open ${label}`, sport_key: "generic", variant_key: "score", config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    });
    const added = await addEntrantsViaApi(request, div.data!.id, Array.from({ length: n }, (_, i) => `E${i + 1} ${TAG}`));
    expect(added.ids).toHaveLength(n);
    const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${div.data!.id}/stages`, "POST", { seq: 1, kind: "knockout", name: "Main", config });
    expect(stage.status, JSON.stringify(stage.error)).toBe(201);
    expect((await apiJson(request, `/api/v1/stages/${stage.data!.id}/generate`, "POST")).status).toBe(200);
    return { divisionId: div.data!.id, stageId: stage.data!.id };
  }

  test("n=4: Play-off adds exactly one third-place line, Shared takes it away; a division Start alone keeps it editable; the first played match locks it", async ({ request }) => {
    test.setTimeout(120_000);
    const { divisionId, stageId } = await draftKnockout(request, "n4", 4);
    const thirds = async () => (await linesOf(request, divisionId, stageId)).filter((l) => l.third_place === true).length;
    expect(await thirds(), "Shared: no third-place line").toBe(0);
    const playoff = await apiJson(request, `/api/v1/stages/${stageId}`, "PATCH", { thirdPlace: "playoff" });
    expect(playoff.status, JSON.stringify(playoff.error)).toBe(200);
    expect(await thirds(), "Play-off: one third-place line").toBe(1);
    const shared = await apiJson(request, `/api/v1/stages/${stageId}`, "PATCH", { thirdPlace: "shared" });
    expect(shared.status, JSON.stringify(shared.error)).toBe(200);
    expect(await thirds(), "back to Shared: none").toBe(0);
    expect((await apiJson(request, `/api/v1/stages/${stageId}`, "PATCH", { thirdPlace: "playoff" })).status).toBe(200);
    // X-TP-6: the stage STARTS with its first played match, not with the division's Start. Start alone leaves it editable.
    expect((await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST")).status).toBeLessThan(300);
    const stillEditable = await apiJson(request, `/api/v1/stages/${stageId}`, "PATCH", { thirdPlace: "shared" });
    expect(stillEditable.status, `Start alone does not lock: ${JSON.stringify(stillEditable.error)}`).toBe(200);
    expect(await thirds(), "redrawn without it").toBe(0);
    expect((await apiJson(request, `/api/v1/stages/${stageId}`, "PATCH", { thirdPlace: "playoff" })).status).toBe(200);
    expect(await thirds()).toBe(1);
    const semi = (await linesOf(request, divisionId, stageId)).find((l) => l.round_no === 1 && l.home_entrant_id && l.away_entrant_id)!;
    await homeWins(request, semi);
    const locked = await apiJson(request, `/api/v1/stages/${stageId}`, "PATCH", { thirdPlace: "shared" });
    expect(locked.status, "locked once a match has a result").toBe(409);
    expect(JSON.stringify(locked.error)).toContain("THIRD_PLACE_LOCKED");
    expect(await thirds(), "the started bracket keeps its third-place line").toBe(1);
  });

  test("C20: Play-off -> Shared is refused 422 KO_CUT_NOT_WHOLE_ROUND while a later stage's 1-3 cut reads this stage, and the setting is unchanged", async ({ request }) => {
    test.setTimeout(120_000);
    const { divisionId, stageId } = await draftKnockout(request, "cut", 8, { thirdPlace: true });
    const main = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
      seq: 2, kind: "knockout", name: "Main", config: {},
      progression: { sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 3 }] }], placement: "rank_order", timing: "setup" },
    });
    expect(main.status, JSON.stringify(main.error)).toBe(201);
    const refused = await apiJson(request, `/api/v1/stages/${stageId}`, "PATCH", { thirdPlace: "shared" });
    expect(refused.status).toBe(422);
    expect(JSON.stringify(refused.error)).toContain("KO_CUT_NOT_WHOLE_ROUND");
    const stage = await apiJson<{ config?: { thirdPlace?: boolean } }[]>(request, `/api/v1/divisions/${divisionId}/stages`);
    expect(stage.data!.find((x) => (x as { id?: string }).id === stageId)?.config?.thirdPlace, "still a play-off").toBe(true);
  });

  test("n=3: Play-off is refused with the count, and the bracket is unchanged", async ({ request }) => {
    test.setTimeout(120_000);
    const { divisionId, stageId } = await draftKnockout(request, "n3", 3);
    const before = (await linesOf(request, divisionId, stageId)).length;
    const refused = await apiJson(request, `/api/v1/stages/${stageId}`, "PATCH", { thirdPlace: "playoff" });
    expect(refused.status).toBe(422);
    expect(JSON.stringify(refused.error)).toContain("KO_THIRD_PLACE_TOO_FEW");
    expect((await linesOf(request, divisionId, stageId)).length).toBe(before);
  });
});

// ─── B4 (Task 10 Step 5; I-4): the BUILDER journey - the organiser picks Play-off match in the browser ────────────────────────────
// builder (Who plays -> Format: Knockout, Third place: Play-off match -> Review -> Create) -> four players -> Start -> both
// semi-finals played -> the `-3p` line is seated and playable -> played -> places 1, 2, 3, 4 and the public page shows the third-place
// line. Proves the seam builder -> formatStagesFor -> POST stages -> generate, which no unit test drives. The control sits in the
// Format step's own picker (no phone disclosure folds it); the template grid's fold is opened (showAllFormats) and the control is
// awaited as ATTACHED before it is tapped, per AGENTS.md class 22.
test.describe("X-TP-2 the organiser picks Play-off match in the builder and the bracket holds a third-place match", () => {
  // The builder's badminton division carries the sport's DEFAULT variant (bwf-3x15: games to 15), so a game is won at the variant's own
  // `setTo`, read off the division - 21-10 is not a reachable final there (the set predicate refuses it).
  const win = async (request: APIRequestContext, fixtureId: string, setTo: number) => {
    const seq = async () => (await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${fixtureId}/state`)).data!.last_seq;
    for (const ev of [
      { type: "core.start", payload: {} },
      { type: "badminton.game.summary", payload: { home: setTo, away: setTo - 11 } },
      { type: "badminton.game.summary", payload: { home: setTo, away: setTo - 9 } },
    ]) {
      const res = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", { expected_seq: await seq(), ...ev });
      expect(res.status, `${ev.type}: ${JSON.stringify(res.error)}`).toBeLessThan(300);
    }
  };

  test("builder Play-off -> Start -> semi-finals -> the -3p line -> places 1, 2, 3, 4, and the stage's control reads only", async ({ page, request }) => {
    test.setTimeout(240_000);
    const org = await activeOrg(page);
    const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `W4 B builder ${TAG}`, visibility: "public" });
    expect(comp.status, JSON.stringify(comp.error)).toBeLessThan(300);

    await page.goto(`/o/${org.slug}/c/${comp.data!.slug}/d/new`);
    const name = page.getByTestId("division-builder-name");
    await expect(name).toBeVisible({ timeout: 20_000 });
    await name.fill(`Builder 3P ${TAG}`);
    await pickBuilderSport(page, "badminton");
    await page.getByTestId("division-builder-step-format").click();
    await expect(page.getByTestId("division-builder")).toHaveAttribute("data-step", "format");
    await showAllFormats(page);
    const card = page.locator('label[data-template="knockout"]');
    await card.click();
    await expect(card.locator("input")).toBeChecked();
    const entrants = page.getByTestId("division-builder-plan-entrants");
    await entrants.fill("4");
    await entrants.blur();

    const control = page.getByTestId("third-place-choice");
    await expect(control, "the Third place control is in the DOM for a knockout format").toBeAttached();
    await control.scrollIntoViewIfNeeded();
    await expect(control).toHaveAttribute("data-third-place", "shared"); // the default: Shared
    await control.locator('[data-third-place-option="playoff"]').click();
    await expect(control).toHaveAttribute("data-third-place", "playoff");

    await page.getByRole("button", { name: "Review", exact: true }).click();
    await page.getByRole("button", { name: /create division/i }).click();
    await page.waitForURL(/\/o\/[^/]+\/c\/[^/]+\/d\/(?!new(?:$|[/?]))[^/?]+/, { timeout: 20_000 });
    const divSlug = page.url().match(/\/d\/([^/?]+)/)![1]!;
    const divs = await apiJson<{ id: string; slug: string }[]>(request, `/api/v1/competitions/${comp.data!.id}/divisions`);
    const divisionId = divs.data!.find((d) => d.slug === divSlug)!.id;

    // The seam: what the builder SENT is what the stage holds.
    const stages = await apiJson<{ id: string; kind: string; config: { thirdPlace?: boolean } }[]>(request, `/api/v1/divisions/${divisionId}/stages`);
    const ko = stages.data!.find((x) => x.kind === "knockout")!;
    expect(ko.config.thirdPlace, "the builder wrote the organiser's pick onto the knockout stage").toBe(true);

    const added = await addEntrantsViaApi(request, divisionId, ["E1", "E2", "E3", "E4"].map((n) => `${n} ${TAG}`));
    expect(added.ids).toHaveLength(4);
    expect((await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST")).status).toBeLessThan(300);
    const setTo = (await apiJson<{ config: { finalSetTo?: number } }>(request, `/api/v1/divisions/${divisionId}`)).data!.config.finalSetTo;
    expect(typeof setTo, "premise: the division carries its variant's game target").toBe("number");
    const lines = async () => (await apiJson<Fx[]>(request, `/api/v1/divisions/${divisionId}/fixtures`)).data!.filter((f) => f.stage_id === ko.id);
    const semis = (await lines()).filter((l) => l.round_no === 1 && l.third_place !== true);
    expect(semis, "two semi-finals").toHaveLength(2);
    for (const sf of semis) await win(request, sf.id, setTo!);
    const bronze = (await lines()).find((l) => l.third_place === true)!;
    expect(bronze, "the -3p line exists").toBeTruthy();
    expect(bronze.home_entrant_id && bronze.away_entrant_id, "both beaten semi-finalists are seated on it").toBeTruthy();
    const final = (await lines()).find((l) => l.round_no === 2 && l.third_place !== true)!;
    await win(request, bronze.id, setTo!);
    await win(request, final.id, setTo!);
    const done = await apiJson<{ completed: boolean; events: { type: string; places?: { rank: number }[] }[] }>(request, `/api/v1/stages/${ko.id}/complete`, "POST");
    expect(done.status, JSON.stringify(done.error)).toBe(200);
    expect(done.data!.events.find((e) => e.type === "stage_completed")!.places!.map((p) => p.rank), "3rd and 4th are decided by the match").toEqual([1, 2, 3, 4]);

    await page.goto(`/o/${org.slug}/c/${comp.data!.slug}/d/${divSlug}?tab=fixtures`);
    // The stage has begun: the organiser's page reads the control read-only (X-TP-6), whatever it was set to.
    await expect(page.getByTestId("stage-third-place-choice")).toHaveAttribute("data-read-only", "");
  });
});

// ─── T16: the row journeys the earlier batches did not drive (late entry into a Plate, the public places, a vacant title, a pair bracket) ─
// Each reads the rulebook's value (docs/superpowers/specs/2026-09-27-format-matrix-prompts/rulebook-W4-knockout.md), worked by hand in the
// comment above it, never the answer of the call under test. Seats and ranks are asserted, not that a page loaded.

/** The scorer's events for one decided badminton line (two games to the winning side), through the same v1 door the pad writes to. */
async function badmintonLine(request: APIRequestContext, fixtureId: string, homeWon: boolean): Promise<void> {
  for (const [type, payload] of [
    ["core.start", {}],
    ["badminton.game.summary", homeWon ? { home: 21, away: 10 } : { home: 10, away: 21 }],
    ["badminton.game.summary", homeWon ? { home: 21, away: 12 } : { home: 12, away: 21 }],
  ] as const) {
    const state = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${fixtureId}/state`);
    const res = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", { expected_seq: state.data!.last_seq, type, payload });
    expect(res.status, `${type}: ${JSON.stringify(res.error)}`).toBeLessThan(300);
  }
}

/** Decide every playable, undecided line of `round` of `stageId` for the BETTER seed (`seedOf`; an entrant it does not know is the worst). */
async function playBadmintonRound(request: APIRequestContext, divisionId: string, stageId: string, round: number, seedOf: Map<string, number>): Promise<number> {
  const open = (await linesOf(request, divisionId, stageId)).filter(
    (l) => l.round_no === round && l.home_entrant_id && l.away_entrant_id && !["decided", "finalized", "forfeited", "abandoned"].includes((l as PlateFx).status),
  );
  for (const f of open) {
    const homeBetter = (seedOf.get(f.home_entrant_id!) ?? 99) < (seedOf.get(f.away_entrant_id!) ?? 99);
    await badmintonLine(request, f.id, homeBetter);
  }
  return open.length;
}

const livePath = async (request: APIRequestContext, divisionId: string, query = ""): Promise<string> => {
  const m = /^\/o\/([^/]+)\/c\/([^/]+)\/d\/([^/?]+)/.exec(await divisionPath(request, divisionId));
  expect(m, "the division's organiser path").toBeTruthy();
  return `/live/${m![1]}/${m![2]}/${m![3]}${query}`;
};

/** A badminton division (variant bwf) with the entrants `names` of `kind`, seeded in order, one knockout stage, generated and Started. */
async function badmintonKnockout(
  request: APIRequestContext,
  label: string,
  names: string[],
  opts: { kind?: "individual" | "pair"; members?: string[][]; plate?: boolean; config?: Record<string, unknown> } = {},
) {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `W4 B ${label} ${TAG}`, visibility: "public" });
  expect(comp.status, JSON.stringify(comp.error)).toBe(201);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", { name: `Open ${label}`, sport_key: "badminton", variant_key: "bwf", config: {} });
  expect(div.status, JSON.stringify(div.error)).toBe(201);
  const divisionId = div.data!.id;
  const kind = opts.kind ?? "individual";
  const added = await apiJson<{ id: string; display_name: string }[]>(
    request,
    `/api/v1/divisions/${divisionId}/entrants`,
    "POST",
    names.map((n, i) => ({ kind, display_name: n, seed: i + 1, ...(opts.members ? { members: opts.members[i]!.map((person_id) => ({ person_id })) } : {}) })),
  );
  expect(added.status, JSON.stringify(added.error)).toBe(201);
  const ids = added.data!.map((e) => e.id);
  const main = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", { seq: 1, kind: "knockout", name: "Main draw", config: opts.config ?? {} });
  expect(main.status, JSON.stringify(main.error)).toBe(201);
  let plateId: string | undefined;
  if (opts.plate) {
    const plate = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
      seq: 2,
      kind: "knockout",
      name: "Plate",
      config: {},
      progression: { sources: [{ stage: "previous", take: [{ kind: "firstLosses" }] }], placement: "rank_order", timing: "setup" },
    });
    expect(plate.status, JSON.stringify(plate.error)).toBe(201);
    plateId = plate.data!.id;
  }
  expect((await apiJson(request, `/api/v1/stages/${main.data!.id}/generate`, "POST")).status).toBe(200);
  if (plateId) expect((await apiJson(request, `/api/v1/stages/${plateId}/generate`, "POST")).status, "the plate's day-one draw").toBe(200);
  expect((await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST")).status).toBeLessThan(300);
  const seedOf = new Map(ids.map((id, i) => [id, i + 1] as const));
  const nameOf = new Map(ids.map((id, i) => [id, names[i]!] as const));
  return { competitionId: comp.data!.id, divisionId, mainId: main.data!.id, plateId, ids, seedOf, nameOf };
}

// ─── X-LE-3 / X-LE-14: a newcomer takes a withdrawn entrant's seat; a paid arrival waits, is placed by one desk tap, loses round 1 and is in the plate ─
test.describe("X-LE-3 a newcomer takes a withdrawn entrant's seat (withdrawn_slot)", () => {
  test("four started, E4 withdrawn (the line is walked over): a new player added takes E4's seat against E1, the walkover reversed; the next add has no slot and is refused", async ({ request }) => {
    test.setTimeout(120_000);
    const { divisionId, stageId } = await genericKnockout(request, "wslot");
    const entrants = (await apiJson<{ id: string; display_name: string }[]>(request, `/api/v1/divisions/${divisionId}/entrants`)).data!;
    const e4 = entrants.find((e) => e.display_name.startsWith("E4"))!;
    // Standard seeding of four: 1v4 and 2v3 - E4's opponent is E1.
    const before = (await linesOf(request, divisionId, stageId)).find((l) => l.round_no === 1 && (l.home_entrant_id === e4.id || l.away_entrant_id === e4.id))!;
    const e1 = entrants.find((e) => e.display_name.startsWith("E1"))!;
    expect([before.home_entrant_id, before.away_entrant_id].sort(), "premise: E4 meets E1").toEqual([e1.id, e4.id].sort());
    expect((await apiJson(request, `/api/v1/entrants/${e4.id}/withdraw`, "POST")).status).toBe(200);
    const walked = (await linesOf(request, divisionId, stageId)).find((l) => l.id === before.id) as PlateFx;
    expect(walked.status, "premise: the withdrawal walked the line over").not.toBe("scheduled");

    const late = await apiJson<{ id: string; late_entry?: { format: string; case: string; fixture_id?: string; opponent_id?: string } }>(request, `/api/v1/divisions/${divisionId}/entrants`, "POST", {
      kind: "individual",
      display_name: `E5 Late ${TAG}`,
    });
    expect(late.status, JSON.stringify(late.error)).toBe(201);
    expect(late.data!.late_entry, "the case, the line and who they play").toMatchObject({ format: "knockout", case: "withdrawn_slot", fixture_id: before.id, opponent_id: e1.id });
    const after = (await linesOf(request, divisionId, stageId)).find((l) => l.id === before.id) as PlateFx;
    expect([after.home_entrant_id, after.away_entrant_id].sort(), "the newcomer sits where E4 sat").toEqual([e1.id, late.data!.id].sort());
    expect(after.status, "the walkover is reversed").toBe("scheduled");

    // The seat is taken: a second newcomer finds no bye and no withdrawn seat (RB4-L6). The walkover that E4's withdrawal wrote is a decided
    // result, and "started" includes one (RB4-L9), so there is no Rebuild to offer: the add is REFUSED by name and writes nothing.
    const before2 = (await apiJson<unknown[]>(request, `/api/v1/divisions/${divisionId}/entrants`)).data!.length;
    const next = await apiJson(request, `/api/v1/divisions/${divisionId}/entrants`, "POST", { kind: "individual", display_name: `E6 Late ${TAG}` });
    expect([next.status, next.error?.code]).toEqual([409, "KO_LATE_ENTRY_NO_SLOT"]);
    expect((await apiJson<unknown[]>(request, `/api/v1/divisions/${divisionId}/entrants`)).data!.length, "nothing is written").toBe(before2);
  });
});

/** One free registration through the PUBLIC register door, auto-approved (confirmed at once, so with the bracket started the entrant WAITS,
 *  ruling 271); then marked paid by card the way the webhook would (SQL: a test has no Stripe). Returns the entrant's id. */
async function paidArrival(request: APIRequestContext, competitionId: string, divisionId: string, who: string): Promise<string> {
  const settings = await apiJson(request, `/api/v1/divisions/${divisionId}/registration-settings`, "PUT", {
    enabled: true,
    entrant_kind: "individual",
    fee_cents: 0,
    payment_method: "offline",
    form_fields: [],
    approval: "auto",
  });
  expect(settings.status, JSON.stringify(settings.error)).toBeLessThan(300);
  const [, orgSlug, compSlug] = /^\/o\/([^/]+)\/c\/([^/]+)/.exec(await competitionPath(request, competitionId))!;
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
  await withDb(async (sql) => {
    const rows = await sql<{ id: string; group_id: string }[]>`select id, group_id from registrations where entrant_id = ${entrant!.id}`;
    expect(rows.length, "premise: the entrant came from a registration").toBe(1);
    // As the completion handler writes a card payment: the intent on the cart AND on the entry it paid (the desk reads the entry's, V387).
    const intent = `pi_e2e_${rows[0]!.id.slice(0, 8)}`;
    await sql`update registration_groups set payment_intent_id = ${intent} where id = ${rows[0]!.group_id}`;
    await sql`update registrations set amount_cents = 1500, payment_intent_id = ${intent} where id = ${rows[0]!.id}`;
  });
  return entrant!.id;
}

// Six seeded in a Knockout + Plate of eight: seeds 1 and 2 hold byes. A paid registration after Start WAITS; the desk's one tap seats them on the
// LOWEST-seeded holder's bye (RB4-L4: seed 2's), so round 1 is 4v5, 3v6 and 2 v L. The better seed wins every line (L is the worst): round 1 loses
// 5, 6 and L; round 2 is 1v4 and 2v3, whose losers (4, 3) had already won a match. The plate takes whoever loses their FIRST real match (RB4-P1; a
// bye is none), so its field is E5, E6 and L: the tapped player appears in it (X-LE-14).
test.describe("X-LE-14 a paid arrival placed by the desk tap loses round 1 and is in the plate", () => {
  test("waiting -> one tap on the stage card -> round 1 lost -> the plate's proposal and its confirm seat them", async ({ page, request }) => {
    test.setTimeout(240_000);
    const names = ["E1", "E2", "E3", "E4", "E5", "E6"].map((n) => `${n} ${TAG}`);
    const ko = await badmintonKnockout(request, "late-plate", names, { plate: true });
    const lateName = `E7 Late ${TAG}`;
    const lateId = await paidArrival(request, ko.competitionId, ko.divisionId, lateName);
    const holder = ko.ids[1]!; // seed 2
    expect((await linesOf(request, ko.divisionId, ko.mainId)).some((l) => l.home_entrant_id === lateId || l.away_entrant_id === lateId), "the app never places an automatic arrival").toBe(false);

    await page.goto(await divisionPath(request, ko.divisionId, "?tab=fixtures"));
    await dismissCookieBanner(page);
    const strip = page.getByTestId("knockout-waiting");
    await expect(strip, "the stage card lists the waiting player").toBeVisible({ timeout: 20_000 });
    const tap = strip.getByTestId("knockout-waiting-place");
    await tap.scrollIntoViewIfNeeded();
    const answered = page.waitForResponse((r) => r.url().endsWith(`/api/v1/stages/${ko.mainId}/late-entrants/${lateId}/place`) && r.request().method() === "POST");
    await tap.click();
    const res = await answered;
    expect(res.status()).toBe(200);
    expect(((await res.json()) as { data: unknown }).data, "the tap seats them against seed 2's bye").toMatchObject({ case: "bye", opponent_id: holder });
    await expect(strip, "nobody waits any more").toHaveCount(0, { timeout: 20_000 });

    const seedOf = new Map(ko.seedOf).set(lateId, 7);
    // Before round 2 is played the plate says so, and holds no line.
    expect(await playBadmintonRound(request, ko.divisionId, ko.mainId, 1, seedOf), "round 1: three real matches, one of them the tapped player's").toBe(3);
    const r1 = (await linesOf(request, ko.divisionId, ko.mainId)).filter((l) => l.round_no === 1);
    const theirs = r1.find((l) => l.home_entrant_id === lateId || l.away_entrant_id === lateId)!;
    expect([theirs.home_entrant_id, theirs.away_entrant_id].sort(), "they play seed 2").toEqual([holder, lateId].sort());
    await page.reload();
    await expect(page.locator('[data-progression-state="plate-waiting"]'), "the plate waits for round 2").toBeVisible({ timeout: 20_000 });
    expect(await playBadmintonRound(request, ko.divisionId, ko.mainId, 2, seedOf), "round 2: two semi-finals").toBe(2);

    // The desk: a proposal for the plate (drafted, or one tap to compute it), naming exactly the first losers - and the tapped player is one.
    await page.reload();
    const compute = page.getByRole("button", { name: "Compute proposal" });
    const draft = page.locator('[data-progression-state="draft"]');
    await expect(compute.or(draft)).toBeVisible({ timeout: 30_000 });
    if (await compute.isVisible()) await compute.click();
    await expect(draft).toBeVisible({ timeout: 30_000 });
    const seats = await draft.locator("[data-progression-row] select").evaluateAll((els) => els.map((el) => (el as HTMLSelectElement).selectedOptions[0]?.textContent ?? ""));
    expect([...seats].sort(), "the first-match losers, by name: E5, E6 and the tapped player (round 1)").toEqual([`E5 ${TAG}`, `E6 ${TAG}`, lateName].sort());
    await draft.getByRole("button", { name: "Confirm proposal" }).click();
    await expect(page.locator('[data-progression-state="confirmed"]')).toBeVisible({ timeout: 30_000 });
    const plateSeated = new Set((await linesOf(request, ko.divisionId, ko.plateId!)).flatMap((l) => [l.home_entrant_id, l.away_entrant_id]).filter(Boolean));
    expect(plateSeated.has(lateId), "the tapped player is seated in the plate").toBe(true);
    expect([...plateSeated].map((id) => (id === lateId ? lateName : ko.nameOf.get(id!)!)).sort()).toEqual([`E5 ${TAG}`, `E6 ${TAG}`, lateName].sort());
  });
});

// ─── A PAIR bracket: badminton doubles, six pairs ────────────────────────────────────────────────────────────────────────────────────
// Six pairs fill a bracket of eight: pairs 1 and 2 hold byes; round 1 is 4v5 and 3v6, round 2 is 1v4 and 2v3, then the final 1v2. The better seed
// wins every line. Ranks (rulebook): RB4-T2 the two semi-final losers (pairs 3 and 4) share 3rd; RB4-R2 below them strict by elimination round, then
// seed - pair 5 is 5th, pair 6 is 6th; RB4-R1 every pair exactly once. A pair is two people: a pair's own entrant row carries both members.
test.describe("W4 a PAIR bracket: badminton doubles, six pairs, played to the places", () => {
  test("6 pairs with two members each: byes to pairs 1 and 2, the final 1v2, places 1, 2, 3, 3, 5, 6 with every pair once", async ({ request }) => {
    test.setTimeout(240_000);
    const personIds: string[] = [];
    for (let i = 1; i <= 12; i++) {
      const p = await apiJson<{ id: string }>(request, "/api/v1/persons", "POST", { full_name: `Dbl Player ${String(i).padStart(2, "0")} ${TAG}`, consent: { public_name: true } });
      expect(p.status, JSON.stringify(p.error)).toBeLessThan(300);
      personIds.push(p.data!.id);
    }
    const members = Array.from({ length: 6 }, (_, i) => [personIds[2 * i]!, personIds[2 * i + 1]!]);
    const names = Array.from({ length: 6 }, (_, i) => `Pair ${i + 1} ${TAG}`);
    const ko = await badmintonKnockout(request, "pairs", names, { kind: "pair", members });
    const entrants = (await apiJson<{ id: string; kind: string; members?: unknown[] }[]>(request, `/api/v1/divisions/${ko.divisionId}/entrants`)).data!;
    expect(entrants.map((e) => e.kind), "premise: every entrant is a pair").toEqual(Array(6).fill("pair"));

    const r1 = (await linesOf(request, ko.divisionId, ko.mainId)).filter((l) => l.round_no === 1);
    const byes = r1.filter((l) => (l.home_entrant_id === null) !== (l.away_entrant_id === null)).map((l) => ko.seedOf.get((l.home_entrant_id ?? l.away_entrant_id)!)).sort();
    expect(byes, "pairs 1 and 2 hold the byes").toEqual([1, 2]);
    expect(await playBadmintonRound(request, ko.divisionId, ko.mainId, 1, ko.seedOf), "round 1: 4v5 and 3v6").toBe(2);
    expect(await playBadmintonRound(request, ko.divisionId, ko.mainId, 2, ko.seedOf), "round 2: 1v4 and 2v3").toBe(2);
    const final = (await linesOf(request, ko.divisionId, ko.mainId)).find((l) => l.round_no === 3)!;
    expect([final.home_entrant_id, final.away_entrant_id].map((id) => ko.seedOf.get(id!)).sort(), "the final is 1v2").toEqual([1, 2]);
    expect(await playBadmintonRound(request, ko.divisionId, ko.mainId, 3, ko.seedOf)).toBe(1);

    const done = await apiJson<{ completed: boolean; events: { type: string; places?: { entrantId: string; rank: number }[]; title?: { kind: string; champion?: string } }[] }>(request, `/api/v1/stages/${ko.mainId}/complete`, "POST");
    expect([done.status, done.data?.completed], JSON.stringify(done.error)).toEqual([200, true]);
    const ev = done.data!.events.find((e) => e.type === "stage_completed")!;
    const rankOfPair = new Map(ev.places!.map((p) => [ko.seedOf.get(p.entrantId)!, p.rank] as const));
    expect(ev.places!.length, "every pair is ranked").toBe(6);
    expect([1, 2, 3, 4, 5, 6].map((s) => rankOfPair.get(s)), "pair 1..6 rank").toEqual([1, 2, 3, 3, 5, 6]);
    expect(new Set(ev.places!.map((p) => p.entrantId)).size, "each pair appears once").toBe(6);
    expect(ev.title).toEqual({ kind: "champion", champion: ko.ids[0] });
  });
});

// ─── A vacant title: both finalists withdraw ─────────────────────────────────────────────────────────────────────────────────────────
// Four, both semi-finals played for the better seed: the final is E1 v E2. RB4-C3: both finalists out is a vacant title, automatically - both rank
// 2nd and nobody ranks 1st; the semi-final losers (E3, E4) share 3rd (RB4-T2). The page says "Title vacant" and crowns nobody.
test.describe("W4 a vacant title: both finalists withdraw", () => {
  async function seatedFinal(request: APIRequestContext, label: string) {
    const names = ["E1", "E2", "E3", "E4"].map((n) => `${n} ${TAG}`);
    const ko = await badmintonKnockout(request, label, names);
    expect(await playBadmintonRound(request, ko.divisionId, ko.mainId, 1, ko.seedOf), "both semi-finals").toBe(2);
    const final = (await linesOf(request, ko.divisionId, ko.mainId)).find((l) => l.round_no === 2)!;
    expect([final.home_entrant_id, final.away_entrant_id].map((id) => ko.seedOf.get(id!)).sort(), "premise: the final is E1 v E2").toEqual([1, 2]);
    return { ko, final };
  }
  type Done = { completed: boolean; events: { type: string; places?: { entrantId: string; rank: number }[]; title?: { kind: string; champion?: string } }[] };

  test("one finalist leaves by the bare status flip, the other by Withdraw: the final is a double walkover, Complete answers a vacant title with ranks 2, 2, 3, 3, and the public page says so", async ({ page, request }) => {
    test.setTimeout(180_000);
    // The way a final gets TWO departed finalists in the server's own suite (vacant-title.test.ts): the first by the bare flip (ruling 111's
    // self-withdrawal, which cascades nothing), the second by the cascade - the second departure is the trigger.
    const { ko, final } = await seatedFinal(request, "vacant");
    expect((await apiJson(request, `/api/v1/entrants/${ko.ids[0]}`, "PATCH", { status: "withdrawn" })).status).toBe(200);
    expect((await apiJson(request, `/api/v1/entrants/${ko.ids[1]}/withdraw`, "POST")).status).toBe(200);
    const walked = (await apiJson<{ status: string; outcome: { kind?: string } | null }>(request, `/api/v1/fixtures/${final.id}`)).data!;
    expect([walked.status, walked.outcome?.kind], "both sides out: a double walkover").toEqual(["forfeited", "double_walkover"]);

    const done = await apiJson<Done>(request, `/api/v1/stages/${ko.mainId}/complete`, "POST");
    expect([done.status, done.data?.completed], JSON.stringify(done.error)).toEqual([200, true]);
    const ev = done.data!.events.find((e) => e.type === "stage_completed")!;
    expect(ev.title?.kind, "nobody is champion").toBe("vacant");
    expect([...((ev.title as { finalists?: string[] }).finalists ?? [])].sort(), "the title names both finalists").toEqual([ko.ids[0]!, ko.ids[1]!].sort());
    const rankOf = new Map(ev.places!.map((p) => [ko.seedOf.get(p.entrantId)!, p.rank] as const));
    expect([1, 2, 3, 4].map((s) => rankOf.get(s)), "E1..E4: both finalists 2nd, nobody 1st, the semi-final losers level 3rd").toEqual([2, 2, 3, 3]);

    await expect
      .poll(async () => {
        await page.goto(await livePath(request, ko.divisionId, "?tab=standings"));
        return page.getByTestId("division-title-vacant").count();
      }, { timeout: 30_000, message: "the vacant banner on the public division page" })
      .toBe(1);
    await expect(page.getByTestId("division-title-champion"), "nobody is crowned").toHaveCount(0);
    await expect(page.getByTestId("division-title-joint")).toHaveCount(0);
    await expect(page.getByTestId("bracket-title-vacant"), "the final's tile says so").toHaveCount(1);
  });

  // Fix round 1 (PO ruling 2026-11-10, RB4-C3): the desk's own door, two Withdraws in a row, is the vacant title too. The first settles the final as
  // a walkover to the other finalist; the second turns that walkover into the departure double walkover.
  test("two Withdraws of the two finalists (the desk's own door), the second seed first, leave the final a double walkover, the title vacant and both finalists 2nd", async ({ request }) => {
    test.setTimeout(180_000);
    const { ko, final } = await seatedFinal(request, "vacant2");
    // The second finalist first: the reverse of the order the bare-flip test uses.
    for (const id of [ko.ids[1]!, ko.ids[0]!]) expect((await apiJson(request, `/api/v1/entrants/${id}/withdraw`, "POST")).status).toBe(200);
    const walked = (await apiJson<{ status: string; outcome: { kind?: string } | null }>(request, `/api/v1/fixtures/${final.id}`)).data!;
    expect([walked.status, walked.outcome?.kind], "both sides out: a double walkover").toEqual(["forfeited", "double_walkover"]);
    const done = await apiJson<Done>(request, `/api/v1/stages/${ko.mainId}/complete`, "POST");
    const ev = done.data!.events.find((e) => e.type === "stage_completed")!;
    expect([done.status, ev.title?.kind], "Complete answers a vacant title").toEqual([200, "vacant"]);
    const rankOf = new Map(ev.places!.map((p) => [ko.seedOf.get(p.entrantId)!, p.rank] as const));
    expect([1, 2].map((sd) => rankOf.get(sd)), "RB4-C3: both finalists rank 2nd, nobody 1st").toEqual([2, 2]);
  });
});

// ─── The third place on the public readers: Shared reads two 3rds and no 4th, Play-off reads 3rd and 4th ────────────────────────────────
// A four-draw of badminton pairs-free individuals, the better seed winning every line. RB4-T2 (Shared): both semi-final losers rank 3rd and nobody
// ranks 4th - on EVERY surface. RB4-T3 (Play-off): the two semi-final losers play for 3rd and 4th; the winner of the third-place match is 3rd.
// Read here: the PUBLIC standings JSON (no cookie: a spectator's own door) and the public division page. No public HTML surface prints a "3rd"
// label for a bracket (ST-G7: a bracket is drawn as its bracket, never as a table), so the places are read where they are served and the page is
// read for its champion and its matches. E3 and E4 are the semi-final losers (1v4 and 2v3 meet in the semi-finals of four: 1 beats 4, 2 beats 3).
test.describe("X-TP-3 the third place on the public readers", () => {
  type Row = { entrantId: string; rank?: number | null };
  async function played(request: APIRequestContext, label: string, thirdPlace: boolean) {
    const names = ["E1", "E2", "E3", "E4"].map((n) => `${n} ${TAG}`);
    const ko = await badmintonKnockout(request, label, names, { config: thirdPlace ? { thirdPlace: true } : {} });
    expect(await playBadmintonRound(request, ko.divisionId, ko.mainId, 1, ko.seedOf), "both semi-finals").toBe(2);
    // The final and (Play-off) the third-place line share round 2: both are played, the better seed winning.
    expect(await playBadmintonRound(request, ko.divisionId, ko.mainId, 2, ko.seedOf), thirdPlace ? "the final and the third-place match" : "the final").toBe(thirdPlace ? 2 : 1);
    const done = await apiJson<{ completed: boolean }>(request, `/api/v1/stages/${ko.mainId}/complete`, "POST");
    expect([done.status, done.data?.completed], JSON.stringify(done.error)).toEqual([200, true]);
    return ko;
  }
  const publicRows = async (request: APIRequestContext, ko: { divisionId: string; mainId: string }): Promise<Row[]> => {
    const [, org, comp, div] = /^\/live\/([^/]+)\/([^/]+)\/([^/?]+)/.exec(await livePath(request, ko.divisionId))!;
    // A spectator's own door: a context with no cookie at all.
    const anon = await pwRequest.newContext({ baseURL: test.info().project.use.baseURL });
    try {
      const res = await anon.get(`/api/v1/public/orgs/${org}/competitions/${comp}/divisions/${div}/standings`);
      expect(res.status()).toBe(200);
      const body = (await res.json()) as { data: { standings: { stage_id: string; rows: Row[] }[] } };
      return body.data.standings.find((t) => t.stage_id === ko.mainId)?.rows ?? [];
    } finally {
      await anon.dispose();
    }
  };

  test("Shared: the public standings serve ranks 1, 2, 3, 3 (E3 and E4 level 3rd), and the public page shows one champion and three matches", async ({ page, request }) => {
    test.setTimeout(240_000);
    const ko = await played(request, "tp-shared", false);
    const rows = await publicRows(request, ko);
    const byName = new Map(rows.map((r) => [ko.nameOf.get(r.entrantId)!, r.rank] as const));
    expect(rows.length, "anti-vacuity: the table has its four rows").toBe(4);
    expect(["E1", "E2", "E3", "E4"].map((n) => byName.get(`${n} ${TAG}`)), "E1..E4").toEqual([1, 2, 3, 3]);
    expect(rows.some((r) => r.rank === 4), "nobody ranks 4th").toBe(false);

    // The public division page: ONE champion banner and the bracket of three matches (two semi-finals and the final) - no third-place match.
    await page.goto(await livePath(request, ko.divisionId));
    await dismissCookieBanner(page);
    await expect(page.getByTestId("division-title-champion")).toContainText(ko.nameOf.get(ko.ids[0]!)!, { timeout: 20_000 });
    // Each match tile is linked twice on the page, so count DISTINCT fixture hrefs.
    await expect
      .poll(async () => new Set(await page.locator('a[href*="/fixtures/"]').evaluateAll((as) => as.map((a) => a.getAttribute("href")))).size, { message: "Shared: the bracket holds three matches" })
      .toBe(3);
  });

  test("Play-off: the public standings serve ranks 1, 2, 3, 4, and the public page shows the third-place match as a fourth", async ({ page, request }) => {
    test.setTimeout(240_000);
    const ko = await played(request, "tp-playoff", true);
    const rows = await publicRows(request, ko);
    const byName = new Map(rows.map((r) => [ko.nameOf.get(r.entrantId)!, r.rank] as const));
    expect(rows.length, "anti-vacuity: the table has its four rows").toBe(4);
    // The better seed wins the third-place match: of the two losers E3 (beaten by E2) and E4 (beaten by E1), E3 is the better seed, so 3rd.
    expect(["E1", "E2", "E3", "E4"].map((n) => byName.get(`${n} ${TAG}`)), "E1..E4").toEqual([1, 2, 3, 4]);

    await page.goto(await livePath(request, ko.divisionId));
    await dismissCookieBanner(page);
    await expect(page.getByTestId("division-title-champion")).toContainText(ko.nameOf.get(ko.ids[0]!)!, { timeout: 20_000 });
    // Each match tile is linked twice on the page, so count DISTINCT fixture hrefs.
    await expect
      .poll(async () => new Set(await page.locator('a[href*="/fixtures/"]').evaluateAll((as) => as.map((a) => a.getAttribute("href")))).size, { message: "Play-off: the bracket holds four matches, the third-place match among them" })
      .toBe(4);
  });
});
