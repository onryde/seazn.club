// W4 app PR A, lane B5 (Task 16): the standalone stepladder / page playoff refusal (X-SP-6, owner ruling 269), driven
// over the real HTTP API a signed-in organiser's session reaches. The rules come from the W4 rulebook (RB4-S6, RB4-S7);
// every refusal sentence is read from the English dictionary on disk (e2e cannot import the JSON-backed src modules), so
// a copy change moves this file with it.
import { expect, test, type APIRequestContext } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TAG, addEntrantsViaApi, apiJson } from "./helpers";

const UI_EN = JSON.parse(readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8")) as Record<string, string>;

/** RB4-S6, typed from the rulebook: each table-only kind and the code its standalone refusal carries (pre-flight D13). */
const REFUSED = [
  { kind: "stepladder", code: "STEPLADDER_NEEDS_TABLE_SOURCE" },
  { kind: "page_playoff", code: "PAGE_PLAYOFF_NEEDS_TABLE_SOURCE" },
] as const;
const TOP_FOUR = { sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }], placement: "rank_order", timing: "setup" };

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
