import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { foldEpochOf } from "@seazn/engine/sport";
import { TAG, activeOrg, addEntrantsViaApi, apiJson, createStageAndGenerate } from "./helpers";
import { dismissCookieBanner } from "./scorepad-a11y-kit";

// Engine-split batch 1f, Task 1f-1 (D15, D26, D31): the scoring door's `engine_epoch`.
//
// A prod build holds exactly one fold epoch per sport (every one is 1 today), so a client can never be BEHIND it here — the
// 426 ENGINE_OUTDATED branch, its body, its ordering against a durable replay and its per-sport selectivity are the usecase
// tests' (`usecases/__tests__/scoring-engine-epoch.test.ts`, which mocks the epoch up). What only a real server can prove is
// the other half, and this file is that half:
//   (a) a request carrying the server's own epoch is written through the real route, and the SPECTATOR sees the point;
//   (b) an epoch the schema refuses never reaches the ledger;
//   (c) a client AHEAD of the server is accepted (owner ruling 2026-10-15), and an absent epoch still is (D31, the web pad).
// The expected epoch is read off the engine (`foldEpochOf`), never typed.
const SPORT = "badminton";

interface Rig {
  fixtureId: string;
  home: string;
  publicPath: string;
}

/** A started public badminton division with one seated fixture, through the API. */
async function rig(page: Page): Promise<Rig> {
  const request = page.request;
  const org = await activeOrg(page);
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Epoch E2E ${TAG}-${Math.random().toString(36).slice(2, 6)}`,
    visibility: "public",
  });
  expect(comp.status).toBe(201);
  const div = await apiJson<{ id: string; slug: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Epoch Cup",
    sport_key: SPORT,
    variant_key: "bwf",
  });
  expect(div.status).toBe(201);
  const ents = await addEntrantsViaApi(request, div.data!.id, ["Epoch One", "Epoch Two"]);
  expect(ents.status).toBe(201);
  const { fixtureIds } = await createStageAndGenerate(request, div.data!.id, { kind: "league", name: "League" });
  expect(fixtureIds.length, "a two-entrant league seats one fixture").toBe(1);
  expect((await apiJson(request, `/api/v1/divisions/${div.data!.id}/start`, "POST")).status).toBeLessThan(300);
  const fixtureId = fixtureIds[0]!;
  const fx = await apiJson<{ home_entrant_id: string }>(request, `/api/v1/fixtures/${fixtureId}`);
  expect(fx.status).toBe(200);
  return {
    fixtureId,
    home: fx.data!.home_entrant_id,
    publicPath: `/shared/${org.slug}/${comp.data!.slug}/${div.data!.slug}/fixtures/${fixtureId}`,
  };
}

async function ledger(request: APIRequestContext, fixtureId: string): Promise<{ type: string }[]> {
  const res = await apiJson<{ type: string }[]>(request, `/api/v1/fixtures/${fixtureId}/events?since_seq=0`);
  expect(res.status, `ledger read failed: ${JSON.stringify(res.error)}`).toBe(200);
  return res.data ?? [];
}

test("(a) engine_epoch equal to the server's fold epoch is written (201) and the public match page shows the point", async ({ page }) => {
  const r = await rig(page);
  const engine_epoch = foldEpochOf(SPORT);
  expect(Number.isInteger(engine_epoch) && engine_epoch >= 1, "the epoch under test is a real, positive one").toBe(true);

  const start = await apiJson<{ seq: number }>(page.request, `/api/v1/fixtures/${r.fixtureId}/events`, "POST", {
    expected_seq: 0,
    type: "core.start",
    payload: {},
    engine_epoch,
  });
  expect(start.status, JSON.stringify(start.error)).toBe(201);
  const rally = await apiJson<{ seq: number }>(page.request, `/api/v1/fixtures/${r.fixtureId}/events`, "POST", {
    expected_seq: start.data!.seq,
    type: "badminton.rally",
    payload: { wonBy: r.home },
    engine_epoch,
  });
  expect(rally.status, JSON.stringify(rally.error)).toBe(201);
  expect((await ledger(page.request, r.fixtureId)).map((e) => e.type)).toEqual(["core.start", "badminton.rally"]);

  // The spectator sees it. The scorebug's big number is GAMES won (still 0-0); the rally is the bracketed running score of the
  // game in play beside it, "(1)" for the side that won it and "(0)" for the other.
  await page.goto(r.publicPath);
  await dismissCookieBanner(page);
  await expect(page.getByTestId("mc-court-card")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-testid="mc-score-0"] + span')).toHaveText("(1)", { timeout: 20_000 });
  await expect(page.locator('[data-testid="mc-score-1"] + span')).toHaveText("(0)");
});

test("(b) engine_epoch 0 is a 400 VALIDATION and the ledger is unchanged", async ({ page }) => {
  const r = await rig(page);
  const before = (await ledger(page.request, r.fixtureId)).length;
  const refused: unknown[] = [0, -1, 1.5, "1"];
  for (const engine_epoch of refused) {
    const res = await apiJson(page.request, `/api/v1/fixtures/${r.fixtureId}/events`, "POST", {
      expected_seq: before,
      type: "core.start",
      payload: {},
      engine_epoch,
    });
    expect(res.status, `engine_epoch ${JSON.stringify(engine_epoch)}`).toBe(400);
    expect(res.error?.code, `engine_epoch ${JSON.stringify(engine_epoch)}`).toBe("VALIDATION");
  }
  expect(refused.length, "the test refused something").toBeGreaterThan(0);
  expect((await ledger(page.request, r.fixtureId)).length, "no refused request wrote a row").toBe(before);
});

test("(c) a client AHEAD of the server is accepted, and so is a request with no engine_epoch at all", async ({ page }) => {
  const r = await rig(page);
  const ahead = await apiJson<{ seq: number }>(page.request, `/api/v1/fixtures/${r.fixtureId}/events`, "POST", {
    expected_seq: 0,
    type: "core.start",
    payload: {},
    engine_epoch: foldEpochOf(SPORT) + 1,
  });
  expect(ahead.status, JSON.stringify(ahead.error)).toBe(201);
  const absent = await apiJson<{ seq: number }>(page.request, `/api/v1/fixtures/${r.fixtureId}/events`, "POST", {
    expected_seq: ahead.data!.seq,
    type: "badminton.rally",
    payload: { wonBy: r.home },
  });
  expect(absent.status, JSON.stringify(absent.error)).toBe(201);
  expect((await ledger(page.request, r.fixtureId)).map((e) => e.type)).toEqual(["core.start", "badminton.rally"]);
});
