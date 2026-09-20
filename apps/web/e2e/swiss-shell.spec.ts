import { test, expect } from "@playwright/test";
import {
  TAG,
  apiJson,
  addEntrantsViaApi,
  divisionPath,
  setDateTime,
} from "./helpers";

// Swiss shell programme — end-to-end through the fixtures desk: mint all-round
// shells, schedule a TBD row ahead of Pair, seat/score via Pair next, then
// Unpair the latest seated round and Pair it again. Unpair is driven through
// `stage-unpair` so Task 6's panel wiring is exercised, not only the API.
test("swiss shells: schedule TBD, Pair, score, Unpair, re-Pair", async ({ page, request }) => {
  test.setTimeout(180_000);

  const SWISS_ROUNDS = 3;
  const SHELL_COUNT = SWISS_ROUNDS * 2; // 4 entrants ⇒ 2 boards per round

  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Swiss shell ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: `Swiss shell ${TAG}`,
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  const divisionId = div.data!.id;
  const stage = await apiJson<{ id: string }>(
    request,
    `/api/v1/divisions/${divisionId}/stages`,
    "POST",
    { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: SWISS_ROUNDS } },
  );
  const swissId = stage.data!.id;

  await addEntrantsViaApi(request, divisionId, ["E1", "E2", "E3", "E4"]);

  type Fx = {
    id: string;
    stage_id: string;
    fixture_no: number;
    round_no: number;
    status: string;
    home_entrant_id: string | null;
    away_entrant_id: string | null;
    scheduled_at: string | null;
    ext_key: string | null;
  };
  const fixturesOf = async (stageId: string): Promise<Fx[]> => {
    const all = await apiJson<Fx[]>(request, `/api/v1/divisions/${divisionId}/fixtures`);
    return (all.data ?? []).filter((f) => f.stage_id === stageId);
  };

  const isSeated = (f: Fx) => f.home_entrant_id !== null && f.away_entrant_id !== null;
  const roundSeated = async (roundNo: number) =>
    (await fixturesOf(swissId)).filter((f) => f.round_no === roundNo).every(isSeated);

  const started = await apiJson<{ generated: number }>(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  expect(started.data!.generated, "startDivision mints all-round shells on the first stage").toBe(SHELL_COUNT);

  const minted = await fixturesOf(swissId);
  expect(minted).toHaveLength(SHELL_COUNT);
  expect(minted.every((f) => f.home_entrant_id === null && f.away_entrant_id === null)).toBe(true);

  const shellToSchedule = minted.find((f) => f.round_no === 1 && f.ext_key === "sw-r1-b1")!;
  const pinnedAt = "2030-06-15T14:00:00.000Z";
  const typed = "2030-06-15T14:00";

  await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
  const row = page.locator(`[data-fixture-no="${shellToSchedule.fixture_no}"]`);
  await row.getByRole("button", { name: "Set time", exact: true }).click();
  await setDateTime(row, typed);
  await row.getByRole("button", { name: "Save", exact: true }).click();
  await expect
    .poll(async () => (await apiJson<Fx>(request, `/api/v1/fixtures/${shellToSchedule.id}`)).data!.scheduled_at, {
      timeout: 15_000,
    })
    .toBe(pinnedAt);

  const pairNext = page.getByTestId("stage-generate");
  await expect(pairNext).toHaveText(/pair next round/i);
  await pairNext.click();
  await expect.poll(() => roundSeated(1), { timeout: 20_000 }).toBe(true);

  const decideRound = async (roundNo: number) => {
    for (const f of await fixturesOf(swissId)) {
      if (f.round_no !== roundNo || !isSeated(f)) continue;
      if (["decided", "finalized"].includes(f.status)) continue;
      const st = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${f.id}/state`);
      await apiJson(request, `/api/v1/fixtures/${f.id}/events`, "POST", {
        expected_seq: st.data!.last_seq,
        type: "generic.result",
        payload: { p1Score: 2, p2Score: 0 },
      });
    }
  };

  await decideRound(1);

  await expect(pairNext).toHaveText(/pair next round/i);
  await pairNext.click();
  await expect.poll(() => roundSeated(2), { timeout: 20_000 }).toBe(true);
  expect(await roundSeated(1)).toBe(true);

  const unpair = page.getByTestId("stage-unpair");
  await expect(unpair).toBeVisible();
  await unpair.click();
  await expect.poll(() => roundSeated(2), { timeout: 20_000 }).toBe(false);
  expect(await roundSeated(1)).toBe(true);

  const rescheduled = (await apiJson<Fx>(request, `/api/v1/fixtures/${shellToSchedule.id}`)).data!;
  expect(rescheduled.scheduled_at).toBe(pinnedAt);

  await expect(pairNext).toHaveText(/pair next round/i);
  await pairNext.click();
  await expect.poll(() => roundSeated(2), { timeout: 20_000 }).toBe(true);
});
