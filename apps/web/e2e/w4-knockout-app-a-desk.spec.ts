import { expect, test, type APIRequestContext } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TAG, addEntrantsViaApi, apiJson, fixturePath } from "./helpers";
import { dismissCookieBanner } from "./scorepad-a11y-kit";

// W4 app PR A, lane B-desk (Tasks 18 + 21). Whole file, never a -g slice (AGENTS.md rule 21).

const uiEn: Record<string, string> = JSON.parse(
  readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
);
const GENERIC_CONFIG = { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false };

interface Fx {
  id: string;
  stage_id: string;
  round_no: number;
  status: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  outcome: { kind: string; winner?: string; loser?: string | null; reason?: string } | null;
}

async function divisionFixtures(request: APIRequestContext, divisionId: string): Promise<Fx[]> {
  const all = await apiJson<Fx[]>(request, `/api/v1/divisions/${divisionId}/fixtures`);
  expect(all.status, JSON.stringify(all.error)).toBe(200);
  return all.data ?? [];
}

/** A started generic knockout of four, both semis seated and unplayed. */
async function startedKnockout(request: APIRequestContext, label: string) {
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31", name: `${label} ${TAG} ${Math.random().toString(36).slice(2, 6)}`, visibility: "private",
  });
  expect(comp.status, JSON.stringify(comp.error)).toBe(201);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Open", sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG,
  });
  expect(div.status, JSON.stringify(div.error)).toBe(201);
  const names = [1, 2, 3, 4].map((i) => `${label} S${i} ${TAG}`);
  const added = await addEntrantsViaApi(request, div.data!.id, names, "individual");
  expect(added.ids).toHaveLength(4);
  const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${div.data!.id}/stages`, "POST", { seq: 1, kind: "knockout", name: "Cup" });
  expect(stage.status, JSON.stringify(stage.error)).toBe(201);
  expect((await apiJson(request, `/api/v1/stages/${stage.data!.id}/generate`, "POST")).status).toBe(200);
  const started = await apiJson(request, `/api/v1/divisions/${div.data!.id}/start`, "POST");
  expect(started.status, JSON.stringify(started.error)).toBe(200);
  const semis = (await divisionFixtures(request, div.data!.id)).filter((f) => f.home_entrant_id && f.away_entrant_id);
  expect(semis, "premise: two seated semis").toHaveLength(2);
  return { compId: comp.data!.id, divisionId: div.data!.id, stageId: stage.data!.id, ids: added.ids, names, semis };
}


test.describe("K12 a disqualification walkover is worded as one", () => {
  // W4 T18 (K12), driven first on the base build: the organiser console's Activity row read "Withdrawal recorded" for a
  // DQ cascade's walkover as for a withdrawal's — the console keyed its disqualified set by seat while the cascade's
  // `core.forfeit.by` names the ENTRANT. C12: the stored reason stays `withdrew` (the engine credits it; `disqualified`
  // is the after-play reason), so the wording comes from the side's status, never from a new reason.
  test('K12 a DQ walkover reads "Disqualification recorded"; a withdrawal still reads "Withdrawal recorded"', async ({ page, request }) => {
    test.setTimeout(180_000);
    const DQ = uiEn["pad.ribbon.core.forfeit.disqualified"];
    const WD = uiEn["pad.ribbon.core.forfeit.withdrew"];
    expect([DQ, WD], "the catalog declares both words").toEqual(["Disqualification recorded", "Withdrawal recorded"]);
    const k = await startedKnockout(request, "K12");
    const [sfA, sfB] = k.semis;
    const dqLoser = sfA!.away_entrant_id!;
    const wdLoser = sfB!.away_entrant_id!;
    const dqRes = await apiJson(request, `/api/v1/entrants/${dqLoser}`, "PATCH", { status: "disqualified" });
    expect(dqRes.status, JSON.stringify(dqRes.error)).toBe(200);
    const wdRes = await apiJson(request, `/api/v1/entrants/${wdLoser}/withdraw`, "POST", {});
    expect(wdRes.status, JSON.stringify(wdRes.error)).toBeLessThan(300);
    const after = await divisionFixtures(request, k.divisionId);
    const cases = [
      { label: "disqualification", sf: sfA!, loser: dqLoser, says: DQ!, never: WD! },
      { label: "withdrawal", sf: sfB!, loser: wdLoser, says: WD!, never: DQ! },
    ];
    for (const c of cases) {
      const row = after.find((f) => f.id === c.sf.id);
      // The credit is the withdrawal's, byte for byte, in both cases (C12): only the words differ.
      expect(row?.status, `${c.label}: the semi is walked`).toBe("forfeited");
      expect(row?.outcome, `${c.label}: the stored award`).toEqual({
        kind: "award", loser: c.loser, reason: "withdrew", winner: c.sf.home_entrant_id,
      });
      await page.goto(await fixturePath(request, c.sf.id));
      await dismissCookieBanner(page);
      const captions = page.locator('[data-role="v3-activity-caption"]');
      await expect(captions.filter({ hasText: c.says }), `${c.label}: the Activity row says "${c.says}"`).toHaveCount(1);
      await expect(captions.filter({ hasText: c.never }), `${c.label}: and never "${c.never}"`).toHaveCount(0);
    }
  });
});
