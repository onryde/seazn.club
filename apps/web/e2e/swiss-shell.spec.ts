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

// Task 1.0 (2026-09-20 hardening). A withdrawal mid-tournament used to brick
// Pair next for the rest of the event: the shells were minted for the old
// field, the pairer counts only active entrants, and the seating loop threw
// "swiss bye shell missing for pairing". Driven here over the REAL route
// (POST /entrants/{id}/withdraw) and the REAL panel button, not the usecase,
// because a fixture on both ends proves the fixture.
test("swiss shells: a withdrawal mid-tournament still Pairs, and keeps the slot", async ({ page, request }) => {
  const ROUNDS = 3;
  const FIELD = 6;
  const BOARDS = FIELD / 2; // even field ⇒ no bye until someone withdraws
  const POLL_MS = 20_000;
  // Derived, not a flat literal: setup + one poll-and-act per round driven.
  const ROUNDS_DRIVEN = 2;
  test.setTimeout(75_000 + ROUNDS_DRIVEN * (POLL_MS + 20_000));

  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Swiss withdraw ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: `Swiss withdraw ${TAG}`,
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
    { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: ROUNDS } },
  );
  const swissId = stage.data!.id;

  await addEntrantsViaApi(request, divisionId, ["W1", "W2", "W3", "W4", "W5", "W6"]);

  type Fx = {
    id: string;
    stage_id: string;
    fixture_no: number;
    round_no: number;
    status: string;
    outcome: { kind?: string; winner?: string } | null;
    home_entrant_id: string | null;
    away_entrant_id: string | null;
    scheduled_at: string | null;
    ext_key: string | null;
  };
  const fixturesOf = async (): Promise<Fx[]> => {
    const all = await apiJson<Fx[]>(request, `/api/v1/divisions/${divisionId}/fixtures`);
    return (all.data ?? []).filter((f) => f.stage_id === swissId);
  };
  const seatedBoard = (f: Fx) => f.home_entrant_id !== null && f.away_entrant_id !== null;
  const isSeated = (f: Fx) => f.outcome?.kind === "award" || seatedBoard(f);
  const roundKeys = async (r: number) =>
    (await fixturesOf())
      .filter((f) => f.round_no === r)
      .map((f) => f.ext_key)
      .sort();
  const roundSeated = async (r: number) =>
    (await fixturesOf()).filter((f) => f.round_no === r).every(isSeated);

  const started = await apiJson<{ generated: number }>(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  expect(started.data!.generated, "shells minted for the six-player field").toBe(ROUNDS * BOARDS);

  // Lay round 2 out in advance — the thing a delete-and-recreate would throw away.
  const shell = (await fixturesOf()).find((f) => f.ext_key === "sw-r2-b1")!;
  const pinnedAt = "2030-06-15T14:00:00.000Z";
  await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
  const row = page.locator(`[data-fixture-no="${shell.fixture_no}"]`);
  await row.getByRole("button", { name: "Set time", exact: true }).click();
  await setDateTime(row, "2030-06-15T14:00");
  await row.getByRole("button", { name: "Save", exact: true }).click();
  await expect
    .poll(async () => (await apiJson<Fx>(request, `/api/v1/fixtures/${shell.id}`)).data!.scheduled_at, {
      timeout: 15_000,
    })
    .toBe(pinnedAt);

  const pairNext = page.getByTestId("stage-generate");
  await pairNext.click();
  await expect.poll(() => roundSeated(1), { timeout: POLL_MS }).toBe(true);

  for (const f of await fixturesOf()) {
    if (f.round_no !== 1 || !seatedBoard(f)) continue;
    const st = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${f.id}/state`);
    await apiJson(request, `/api/v1/fixtures/${f.id}/events`, "POST", {
      expected_seq: st.data!.last_seq,
      type: "generic.result",
      payload: { p1Score: 2, p2Score: 0 },
    });
  }

  // The interruption every Swiss event has: someone does not come back.
  const quitter = (await fixturesOf()).find((f) => f.round_no === 1 && seatedBoard(f))!.home_entrant_id!;
  const out = await apiJson(request, `/api/v1/entrants/${quitter}/withdraw`, "POST");
  expect(out.status, "the withdraw route accepted a mid-tournament withdrawal").toBe(200);

  await page.reload();
  await expect(pairNext).toHaveText(/pair next round/i);
  await pairNext.click();
  await expect.poll(() => roundSeated(2), { timeout: POLL_MS }).toBe(true);

  // Reconciled to the five-player field: two boards and the bye the new odd
  // parity needs — and round 1 is exactly where it was.
  expect(await roundKeys(2)).toEqual(["sw-r2-b1", "sw-r2-b2", "sw-r2-bye"]);
  expect(await roundSeated(1)).toBe(true);

  const kept = (await apiJson<Fx>(request, `/api/v1/fixtures/${shell.id}`)).data!;
  expect(kept.scheduled_at, "the organiser's advance layout survived the reconcile").toBe(pinnedAt);
  expect(kept.home_entrant_id).not.toBeNull();
});
