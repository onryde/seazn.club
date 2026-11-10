// W4 app PR B, batch B1 (Task 3; X-FR-4, rulings 266/267): what Complete answers for a knockout, over the real HTTP API a
// signed-in organiser's session reaches. A knockout of four with no third-place match ranks its two semi-final losers LEVEL,
// 3rd. `finalRanks` stays entrant ids in rank order (every client, the bench and the matrix read that), `places` carries the
// ranks - [1, 2, 3, 3] - and `title` says what the final crowned.
// Expected values are the rulebook's and the line rows read before the Complete; none comes from the Complete answer. Later
// batches add their journeys to this file.
import { expect, test, type APIRequestContext } from "@playwright/test";
import { TAG, activeOrg, addEntrantsViaApi, apiJson, pickBuilderSport, showAllFormats } from "./helpers";

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

test.describe("X-PL-8 the plate completes at n=6, 7, 9", () => {
  // Rulebook, by hand (better seed wins): n=6 byes 1,2 - R1 4v5 and 3v6 lose 5 and 6. n=7 bye 1 - R1 2v7, 3v6, 4v5 lose 7, 6, 5. n=9 byes 1-7 -
  // R1 8v9 loses 9; round 2 1v8 (8 played already), 4v5, 3v6, 2v7 lose 5, 6, 7.
  for (const { n, field } of [
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
      expect(confirmed.data!.filled, "every first loser seated").toBe(field.length);
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
  const win = async (request: APIRequestContext, fixtureId: string) => {
    const seq = async () => (await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${fixtureId}/state`)).data!.last_seq;
    for (const ev of [
      { type: "core.start", payload: {} },
      { type: "badminton.game.summary", payload: { home: 21, away: 10 } },
      { type: "badminton.game.summary", payload: { home: 21, away: 12 } },
    ]) {
      const res = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", { expected_seq: await seq(), ...ev });
      expect(res.status, `${ev.type}: ${JSON.stringify(res.error)}`).toBeLessThan(300);
    }
  };

  test("builder Play-off -> Start -> semi-finals -> the -3p line -> places 1, 2, 3, 4, and the public page lists the third-place line", async ({ page, request }) => {
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
    const lines = async () => (await apiJson<Fx[]>(request, `/api/v1/divisions/${divisionId}/fixtures`)).data!.filter((f) => f.stage_id === ko.id);
    const semis = (await lines()).filter((l) => l.round_no === 1 && l.third_place !== true);
    expect(semis, "two semi-finals").toHaveLength(2);
    for (const sf of semis) await win(request, sf.id);
    const bronze = (await lines()).find((l) => l.third_place === true)!;
    expect(bronze, "the -3p line exists").toBeTruthy();
    expect(bronze.home_entrant_id && bronze.away_entrant_id, "both beaten semi-finalists are seated on it").toBeTruthy();
    const final = (await lines()).find((l) => l.round_no === 2 && l.third_place !== true)!;
    await win(request, bronze.id);
    await win(request, final.id);
    const done = await apiJson<{ completed: boolean; events: { type: string; places?: { rank: number }[] }[] }>(request, `/api/v1/stages/${ko.id}/complete`, "POST");
    expect(done.status, JSON.stringify(done.error)).toBe(200);
    expect(done.data!.events.find((e) => e.type === "stage_completed")!.places!.map((p) => p.rank), "3rd and 4th are decided by the match").toEqual([1, 2, 3, 4]);

    await page.goto(`/o/${org.slug}/c/${comp.data!.slug}/d/${divSlug}?tab=fixtures`);
    await expect(page.getByText("3rd", { exact: true }).first(), "the third-place line carries its own round code").toBeAttached();
  });
});
