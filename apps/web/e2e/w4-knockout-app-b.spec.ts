// W4 app PR B, batch B1 (Task 3; X-FR-4, rulings 266/267): what Complete answers for a knockout, over the real HTTP API a
// signed-in organiser's session reaches. A knockout of four with no third-place match ranks its two semi-final losers LEVEL,
// 3rd. `finalRanks` stays entrant ids in rank order (every client, the bench and the matrix read that), `places` carries the
// ranks - [1, 2, 3, 3] - and `title` says what the final crowned.
// Expected values are the rulebook's and the line rows read before the Complete; none comes from the Complete answer. Later
// batches add their journeys to this file.
import { expect, test, type APIRequestContext } from "@playwright/test";
import { TAG, addEntrantsViaApi, apiJson } from "./helpers";

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
