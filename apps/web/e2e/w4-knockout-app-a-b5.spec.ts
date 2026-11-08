// W4 app PR A, lane B5 (Tasks 16 and 17): the standalone stepladder / page playoff refusal (X-SP-6, owner ruling 269)
// and a withdrawal inside a FINAL-stage page playoff (X-SP-5), driven over the real HTTP API a signed-in organiser's
// session reaches. The rules come from the W4 rulebook (RB4-S2, RB4-S6, RB4-S7); every refusal sentence is read from the
// English dictionary on disk (e2e cannot import the JSON-backed src modules), so a copy change moves this file with it.
// Seating only (pre-flight ruling C6): where a withdrawn entrant RANKS is the engine bump's (PR B, carry-notes C19).
import { expect, test, type APIRequestContext } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TAG, addEntrantsViaApi, apiJson, withDb } from "./helpers";

const UI_EN = JSON.parse(readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8")) as Record<string, string>;

/** RB4-S6, typed from the rulebook: each table-only kind and the code its standalone refusal carries (pre-flight D13). */
const REFUSED = [
  { kind: "stepladder", code: "STEPLADDER_NEEDS_TABLE_SOURCE" },
  { kind: "page_playoff", code: "PAGE_PLAYOFF_NEEDS_TABLE_SOURCE" },
] as const;
const TOP_FOUR = { sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }], placement: "rank_order", timing: "setup" };

/** A line as the division's fixture list publishes it (the feed edges are projected OUT of that contract). */
interface Fx {
  id: string;
  stage_id: string;
  status: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  outcome: { kind?: string; winner?: string } | null;
}
/** A line's feed edges: where its winner and its loser go next. Read from the table, since no API publishes them. */
interface Edge {
  id: string;
  winner_to_fixture: string | null;
  loser_to_fixture: string | null;
}

async function genericDivision(request: APIRequestContext, label: string): Promise<{ divisionId: string; ids: string[] }> {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `W4 B5 ${label} ${TAG}`, visibility: "private" });
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
  return { divisionId: div.data!.id, ids: added.ids };
}

const stagesOf = async (request: APIRequestContext, divisionId: string) =>
  (await apiJson<{ id: string; kind: string }[]>(request, `/api/v1/divisions/${divisionId}/stages`)).data ?? [];
/** One stage's lines, from the division's fixture list (the run sheet's read). */
const fixturesOf = async (request: APIRequestContext, divisionId: string, stageId: string): Promise<Fx[]> => {
  const res = await apiJson<Fx[]>(request, `/api/v1/divisions/${divisionId}/fixtures`);
  expect(res.status, JSON.stringify(res.error)).toBe(200);
  return res.data!.filter((f) => f.stage_id === stageId);
};
const fixtureOf = async (request: APIRequestContext, divisionId: string, stageId: string, id: string): Promise<Fx> =>
  (await fixturesOf(request, divisionId, stageId)).find((f) => f.id === id)!;

/** Decide one generic line for `winner` (the console's result write). */
async function win(request: APIRequestContext, f: Fx, winner: string): Promise<void> {
  const state = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${f.id}/state`);
  const homeWins = f.home_entrant_id === winner;
  const scored = await apiJson(request, `/api/v1/fixtures/${f.id}/events`, "POST", {
    expected_seq: state.data!.last_seq,
    type: "generic.result",
    payload: { p1Score: homeWins ? 2 : 0, p2Score: homeWins ? 0 : 2 },
  });
  expect(scored.status, JSON.stringify(scored.error)).toBe(201);
}

test.describe("X-SP-6 the API refuses a standalone playoff", () => {
  test("a stepladder or page playoff with nothing to seed from answers 422 by name and writes nothing; after a league it is taken (X-SP-7)", async ({ request }) => {
    let checked = 0;
    for (const { kind, code } of REFUSED) {
      const { divisionId } = await genericDivision(request, `refuse-${kind}`);
      const res = await apiJson(request, `/api/v1/divisions/${divisionId}/stages`, "POST", { seq: 1, kind, name: "Finals", config: {} });
      expect([kind, res.status, res.error?.code]).toEqual([kind, 422, code]);
      // The sentence the organiser reads is the dictionary's (the client renders it by the code).
      expect(UI_EN[`knockout.refusal.${code}`], `${code} has English copy`).toBeTruthy();
      expect(await stagesOf(request, divisionId), `${kind}: nothing written`).toEqual([]);
      // Positive pair: the same kind as a final stage after a league is offered.
      const fed = await apiJson<{ kind: string }[]>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", [
        { seq: 1, kind: "league", name: "League", config: { legs: 1 } },
        { seq: 2, kind, name: "Finals", config: {}, progression: TOP_FOUR },
      ]);
      expect([kind, fed.status], JSON.stringify(fed.error)).toEqual([kind, 201]);
      expect(fed.data!.map((s) => s.kind)).toEqual(["league", kind]);
      checked++;
    }
    expect(checked).toBe(REFUSED.length);
  });
});

test.describe("X-SP-5 a page-playoff withdrawal walks over", () => {
  test("league → page playoff: Q1's withdrawal walks Q1 over, then Q2 over to E's winner; the final is Q1's other side v E's winner, nothing voided", async ({ request }) => {
    test.setTimeout(120_000);
    const { divisionId, ids } = await genericDivision(request, "pp-withdraw");
    const [e1, e2, e3, e4] = ids as [string, string, string, string];
    const seedOf = new Map(ids.map((id, i) => [id, i + 1]));
    const created = await apiJson<{ id: string; kind: string }[]>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", [
      { seq: 1, kind: "league", name: "League", config: { legs: 1 } },
      { seq: 2, kind: "page_playoff", name: "Playoffs", config: {}, progression: TOP_FOUR },
    ]);
    expect(created.status, JSON.stringify(created.error)).toBe(201);
    const leagueId = created.data!.find((s) => s.kind === "league")!.id;
    const ppId = created.data!.find((s) => s.kind === "page_playoff")!.id;
    for (const id of [leagueId, ppId]) expect((await apiJson(request, `/api/v1/stages/${id}/generate`, "POST")).status).toBe(200);
    expect((await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST")).status).toBeLessThan(300);
    // The better seed wins every league line, so the table's order is E1..E4.
    for (const f of await fixturesOf(request, divisionId, leagueId)) {
      await win(request, f, (seedOf.get(f.home_entrant_id!) ?? 9) < (seedOf.get(f.away_entrant_id!) ?? 9) ? f.home_entrant_id! : f.away_entrant_id!);
    }
    expect((await apiJson(request, `/api/v1/stages/${leagueId}/complete`, "POST")).status).toBe(200);
    const proposal = await apiJson<{ id: string; computed: { ties: unknown[] } }>(request, `/api/v1/stages/${ppId}/seed-proposal`, "POST");
    expect(proposal.status, JSON.stringify(proposal.error)).toBe(201);
    expect(proposal.data!.computed.ties).toEqual([]);
    const confirmed = await apiJson(request, `/api/v1/stages/${ppId}/seed-proposal/confirm`, "POST", { proposalId: proposal.data!.id });
    expect(confirmed.status, JSON.stringify(confirmed.error)).toBe(200);

    // RB4-S2, found by the feed edges: Q1 feeds the final AND Q2 (its loser); E feeds Q2; the final feeds nothing.
    const edges = await withDb((sql) => sql<Edge[]>`select id, winner_to_fixture, loser_to_fixture from fixtures where stage_id = ${ppId}`);
    expect(edges, "a page playoff is four lines").toHaveLength(4);
    const q1Edge = edges.find((f) => f.loser_to_fixture !== null);
    expect(q1Edge, "exactly one line sends its loser on: Q1").toBeDefined();
    expect(edges.filter((f) => f.loser_to_fixture !== null)).toHaveLength(1);
    const q2Id = q1Edge!.loser_to_fixture!;
    const eEdge = edges.find((f) => f.winner_to_fixture === q2Id && f.id !== q1Edge!.id);
    const finalEdge = edges.find((f) => f.winner_to_fixture === null);
    expect([eEdge, finalEdge].every((x) => x !== undefined), "E feeds Q2; the final feeds nothing").toBe(true);
    const rows = await fixturesOf(request, divisionId, ppId);
    const byId = (id: string): Fx => {
      const f = rows.find((r) => r.id === id);
      expect(f, `line ${id} is on the division's fixture list`).toBeDefined();
      return f!;
    };
    const [q1, q2, e, final] = [byId(q1Edge!.id), byId(q2Id), byId(eEdge!.id), byId(finalEdge!.id)];
    const pair = (f: Fx) => [f.home_entrant_id, f.away_entrant_id].sort();
    expect([pair(q1), pair(e)], "Q1 = 1 v 2, E = 3 v 4").toEqual([[e1, e2].sort(), [e3, e4].sort()]);

    const out = await apiJson<{ policy: string; voided: number }>(request, `/api/v1/entrants/${e1}/withdraw`, "POST");
    expect(out.status, JSON.stringify(out.error)).toBe(200);
    expect(out.data).toMatchObject({ policy: "walkover", voided: 0 });
    const q1After = await fixtureOf(request, divisionId, ppId, q1.id);
    expect([q1After.status, q1After.outcome?.kind, q1After.outcome?.winner], "Q1 walks over to its other side").toEqual(["forfeited", "award", e2]);

    await win(request, await fixtureOf(request, divisionId, ppId, e.id), e4); // the lower seed wins E, so the answer differs from "seed 3"
    const q2After = await fixtureOf(request, divisionId, ppId, q2.id);
    expect([q2After.status, q2After.outcome?.winner], "Q2 walks over to E's winner").toEqual(["forfeited", e4]);
    const finalAfter = await fixtureOf(request, divisionId, ppId, final.id);
    expect([finalAfter.status, pair(finalAfter)], "the final: Q1's other side v E's winner").toEqual(["scheduled", [e2, e4].sort()]);
    const after = await fixturesOf(request, divisionId, ppId);
    expect(after.filter((f) => f.status === "abandoned" || f.status === "void"), "a withdrawal never voids").toEqual([]);
    expect(after.filter((f) => f.id !== q1.id && (f.home_entrant_id === e1 || f.away_entrant_id === e1)), "the withdrawn seed is never seated again").toEqual([]);
  });
});
