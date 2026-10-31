import { test, expect, type APIRequestContext } from "@playwright/test";
import { TAG, apiJson, activeOrgIdFromRequest, divisionPath, seedVenueWithCourts } from "./helpers";

// W3 Swiss app-A (spec 2026-10-31-format-matrix-w3-swiss-design.md). One
// describe per rule, each driven through the real desk.

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

type Fx = {
  id: string;
  stage_id: string;
  fixture_no: number;
  pool_id: string | null;
  round_no: number;
  seq_in_round: number;
  scheduled_at: string | null;
  court_id: string | null;
  ext_key?: string | null;
};

const position = (f: Pick<Fx, "pool_id" | "round_no" | "seq_in_round">) =>
  `${f.pool_id ?? "-"}|${f.round_no}|${f.seq_in_round}`;

async function stageFixtures(request: APIRequestContext, divisionId: string, stageId: string): Promise<Fx[]> {
  const all = await apiJson<Fx[]>(request, `/api/v1/divisions/${divisionId}/fixtures`);
  expect(all.status, JSON.stringify(all.error)).toBe(200);
  return (all.data ?? []).filter((f) => f.stage_id === stageId);
}

// X-RB-1 (W3 T1, #840): Rebuild used to delete every fixture and regenerate
// fresh rows, so every time and court the organiser had laid out was gone. It
// now keeps each slot at its (pool, round, seq) position. Driven through the
// roster-drift banner's Rebuild button, the only place an organiser presses it,
// and read back on the run sheet itself, not only the API.
test.describe("X-RB-1 rebuild keeps the board", () => {
  test("pin a court and time on every fixture, withdraw a player, Rebuild — every slot is still there", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const orgId = await activeOrgIdFromRequest(request);
    // TAG-unique court names: CI's shared Pro org already carries other specs' "Court 1".
    const courtNames = [`Keep Court A ${TAG}`, `Keep Court B ${TAG}`];
    const { venueId, courts } = await seedVenueWithCourts(request, courtNames, { orgId });

    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `Rebuild keeps ${TAG}`,
      visibility: "private",
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

    const added = await apiJson<{ id: string; display_name: string }[]>(
      request,
      `/api/v1/divisions/${divisionId}/entrants`,
      "POST",
      [`Keep Alice ${TAG}`, `Keep Bob ${TAG}`, `Keep Cleo ${TAG}`].map((n, i) => ({
        kind: "individual",
        display_name: n,
        seed: i + 1,
      })),
    );
    expect(added.status, JSON.stringify(added.error)).toBe(201);
    const aliceId = added.data!.find((e) => e.display_name === `Keep Alice ${TAG}`)!.id;

    const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
      seq: 1,
      kind: "league",
      name: "League",
      config: {},
    });
    expect(stage.status, JSON.stringify(stage.error)).toBe(201);
    const stageId = stage.data!.id;
    const gen = await apiJson<{ created: number }>(request, `/api/v1/stages/${stageId}/generate`, "POST");
    expect(gen.status, JSON.stringify(gen.error)).toBe(200);

    // Lay out every fixture: its own hour, alternating courts. The expected
    // slot per position is what THIS test writes, never what the code returns.
    const laid = new Map<string, { scheduled_at: string; court_id: string; court: string }>();
    const before = await stageFixtures(request, divisionId, stageId);
    expect(before.length, "a board to lay out").toBe(3);
    for (const [i, f] of before.entries()) {
      const at = `2030-06-15T${String(9 + i).padStart(2, "0")}:00:00.000Z`;
      const court = courts[i % 2]!;
      const placed = await apiJson(request, `/api/v1/fixtures/${f.id}`, "PATCH", {
        scheduled_at: at,
        venue_id: venueId,
        court_id: court.id,
      });
      expect(placed.status, JSON.stringify(placed.error)).toBe(200);
      laid.set(position(f), { scheduled_at: at, court_id: court.id, court: court.name });
    }

    // Pre-Start withdrawal plus a late registration: the drift Rebuild answers.
    const withdrawn = await apiJson(request, `/api/v1/entrants/${aliceId}/withdraw`, "POST");
    expect(withdrawn.status, JSON.stringify(withdrawn.error)).toBe(200);
    const late = await apiJson(request, `/api/v1/divisions/${divisionId}/entrants`, "POST", [
      { kind: "individual", display_name: `Keep Dee ${TAG}`, seed: 4 },
    ]);
    expect(late.status, JSON.stringify(late.error)).toBe(201);

    await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
    const banner = page.getByTestId("roster-drift-banner");
    await expect(banner).toBeVisible({ timeout: 20_000 });
    await banner.getByTestId("roster-drift-rebuild").click();
    const dialog = page.getByRole("alertdialog", { name: "Rebuild this stage's fixtures?" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Rebuild" }).click();
    // Every position survived (3 entrants before, 3 after), so the notice is the
    // plain one: no slot was freed or left unscheduled.
    await expect(page.getByText("Rebuilt — 3 fixture(s) replaced.", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(`Keep Alice ${TAG}`)).toHaveCount(0);

    const after = await stageFixtures(request, divisionId, stageId);
    expect(after.some((f) => before.some((b) => b.id === f.id)), "new rows, not an in-place edit").toBe(false);
    let checked = 0;
    for (const f of after) {
      const want = laid.get(position(f));
      expect(want, `position ${position(f)} was laid out`).toBeDefined();
      expect({ scheduled_at: f.scheduled_at, court_id: f.court_id }, position(f)).toEqual({
        scheduled_at: want!.scheduled_at,
        court_id: want!.court_id,
      });
      // On the run sheet: the rebuilt row names the court it inherited.
      await expect(page.locator(`[data-fixture-no="${f.fixture_no}"]`)).toContainText(want!.court);
      checked++;
    }
    expect(checked, "anti-vacuity: every rebuilt fixture was read back").toBe(3);
  });
});

// X-RB-1 (W3 T2, SW-L8): a pre-Start departure shrinks every unseated Swiss
// round, and the shrink used to take the highest-seq board whatever it held —
// so the board an organiser had laid out in advance went, while a bare one
// survived. Driven through the desk's own "Pair next round" button, the press
// that runs the reshape, and read back on the run sheet.
test.describe("X-RB-1 pre-Start reshape keeps pinned boards", () => {
  test("eight → seven before Start: round 2 loses its unscheduled board, the pinned b4 keeps its court and time", async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    const orgId = await activeOrgIdFromRequest(request);
    const courtNames = [`Pin Court A ${TAG}`, `Pin Court B ${TAG}`];
    const { venueId, courts } = await seedVenueWithCourts(request, courtNames, { orgId });

    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `Reshape keeps ${TAG}`,
      visibility: "private",
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
    const added = await apiJson<{ id: string; display_name: string }[]>(
      request,
      `/api/v1/divisions/${divisionId}/entrants`,
      "POST",
      Array.from({ length: 8 }, (_, i) => ({ kind: "individual", display_name: `Pin P${i + 1} ${TAG}`, seed: i + 1 })),
    );
    expect(added.status, JSON.stringify(added.error)).toBe(201);
    const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
      seq: 1,
      kind: "swiss",
      name: "Swiss",
      config: { rounds: 3 },
    });
    expect(stage.status, JSON.stringify(stage.error)).toBe(201);
    const stageId = stage.data!.id;
    // Mint the shells: eight ⇒ four boards a round, no bye.
    const minted = await apiJson(request, `/api/v1/stages/${stageId}/generate`, "POST");
    expect(minted.status, JSON.stringify(minted.error)).toBe(200);

    const round2 = (rows: Fx[]) => rows.filter((f) => f.round_no === 2).sort((a, b) => a.seq_in_round - b.seq_in_round);
    const before = round2(await stageFixtures(request, divisionId, stageId));
    expect(before.map((f) => f.ext_key)).toEqual(["sw-r2-b1", "sw-r2-b2", "sw-r2-b3", "sw-r2-b4"]);
    // Lay out boards 1, 2 and 4; board 3 stays bare.
    const laid = new Map<string, { scheduled_at: string; court_id: string; court: string }>();
    for (const [i, key] of ["sw-r2-b1", "sw-r2-b2", "sw-r2-b4"].entries()) {
      const f = before.find((r) => r.ext_key === key)!;
      const at = `2030-06-16T${String(9 + i).padStart(2, "0")}:00:00.000Z`;
      const court = courts[i % 2]!;
      const placed = await apiJson(request, `/api/v1/fixtures/${f.id}`, "PATCH", {
        scheduled_at: at,
        venue_id: venueId,
        court_id: court.id,
      });
      expect(placed.status, JSON.stringify(placed.error)).toBe(200);
      laid.set(key, { scheduled_at: at, court_id: court.id, court: court.name });
    }

    // A pre-Start departure: the highest seed leaves before anything starts.
    const leaving = added.data!.find((e) => e.display_name === `Pin P8 ${TAG}`)!;
    const gone = await apiJson(request, `/api/v1/entrants/${leaving.id}`, "DELETE");
    expect(gone.status, JSON.stringify(gone.error)).toBeLessThan(300);

    await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
    const pairNext = page.getByTestId("stage-generate");
    await expect(pairNext).toHaveText(/pair next round/i, { timeout: 20_000 });
    await pairNext.click();
    await expect
      .poll(async () => round2(await stageFixtures(request, divisionId, stageId)).map((f) => `${f.seq_in_round}:${f.ext_key}`), {
        timeout: 20_000,
      })
      .toEqual(["1:sw-r2-b1", "2:sw-r2-b2", "3:sw-r2-b4", "4:sw-r2-bye"]);

    const after = round2(await stageFixtures(request, divisionId, stageId));
    let checked = 0;
    for (const [key, want] of laid) {
      const f = after.find((r) => r.ext_key === key)!;
      expect({ scheduled_at: f.scheduled_at, court_id: f.court_id }, key).toEqual({
        scheduled_at: want.scheduled_at,
        court_id: want.court_id,
      });
      await expect(page.locator(`[data-fixture-no="${f.fixture_no}"]`)).toContainText(want.court);
      checked++;
    }
    expect(checked, "anti-vacuity: every pinned board was read back").toBe(3);
    expect(after.some((f) => f.id === before.find((r) => r.ext_key === "sw-r2-b3")!.id), "the bare board is the one deleted").toBe(false);
  });
});

