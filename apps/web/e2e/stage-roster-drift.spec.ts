import { test, expect } from "@playwright/test";
import { TAG, apiJson, activeOrg } from "./helpers";

// F3 Task 5 (5a/5b, 2026-08-18 plan) — the browser flow the API-level specs
// (stage-progression.spec.ts) don't cover: withdraw an entrant BEFORE the
// division starts (generateStageFixtures is additive-only, so Generate alone
// can never drop the name — the plan's "corrected premise"), the roster-drift
// banner appears on the fixtures tab naming the stale entrant, Rebuild
// actually replaces the board, and the stale name is gone from it afterward.
const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

test("withdraw pre-start -> roster-drift banner -> rebuild -> the stale name is gone from the board", async ({
  page,
  request,
}) => {
  const org = await activeOrg(page);

  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Drift E2E ${TAG}`,
    visibility: "private",
  });
  expect(comp.status, JSON.stringify(comp.error)).toBe(201);

  const div = await apiJson<{ id: string; slug: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    { name: "Open", sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG },
  );
  expect(div.status, JSON.stringify(div.error)).toBe(201);
  const divisionId = div.data!.id;
  const divSlug = div.data!.slug;

  const createEntrants = await apiJson(request, `/api/v1/divisions/${divisionId}/entrants`, "POST", [
    { kind: "individual", display_name: `Drift Alice ${TAG}`, seed: 1 },
    { kind: "individual", display_name: `Drift Bob ${TAG}`, seed: 2 },
    { kind: "individual", display_name: `Drift Cleo ${TAG}`, seed: 3 },
  ]);
  expect(createEntrants.status, JSON.stringify(createEntrants.error)).toBe(201);
  const entrantsBefore = await apiJson<{ id: string; display_name: string }[]>(
    request,
    `/api/v1/divisions/${divisionId}/entrants`,
  );
  const aliceId = entrantsBefore.data!.find((e) => e.display_name === `Drift Alice ${TAG}`)!.id;

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
  expect(gen.data!.created).toBe(3); // 3-entrant round robin: Alice-Bob, Alice-Cleo, Bob-Cleo

  // Pre-start withdrawal — a plain status flip (division.status is still
  // "setup"), NOT the mid-tournament walkover cascade. This is the exact gap
  // the plan names: Generate alone can never remove Alice's name now.
  const withdrawn = await apiJson<{ policy: string }>(request, `/api/v1/entrants/${aliceId}/withdraw`, "POST");
  expect(withdrawn.status, JSON.stringify(withdrawn.error)).toBe(200);
  expect(withdrawn.data!.policy).toBe("none");

  const addDee = await apiJson(request, `/api/v1/divisions/${divisionId}/entrants`, "POST", [
    { kind: "individual", display_name: `Drift Dee ${TAG}`, seed: 4 },
  ]);
  expect(addDee.status, JSON.stringify(addDee.error)).toBe(201);

  await page.goto(`/o/${org.slug}/c/${comp.data!.slug}/d/${divSlug}?tab=fixtures`);

  const banner = page.getByTestId("roster-drift-banner");
  await expect(banner).toBeVisible({ timeout: 20_000 });
  await expect(banner).toHaveAttribute("data-roster-drift-state", "ghosts");
  await expect(banner).toContainText(`Drift Alice ${TAG}`);

  await banner.getByTestId("roster-drift-rebuild").click();
  // confirm-provider.tsx renders useConfirm()'s dialog with role="alertdialog"
  // (not "dialog" — that's ConfirmDialog's own default, but the provider's
  // wrapper is what actually mounts here), confirmed from this spec's own
  // first failed run's accessibility snapshot.
  const dialog = page.getByRole("alertdialog", { name: "Rebuild this stage's fixtures?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Rebuild" }).click();

  await expect(page.getByText("Rebuilt — 3 fixture(s) replaced.")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("roster-drift-banner")).toHaveCount(0);

  // The stale name is gone from the board; the late registration is on it.
  await expect(page.getByText(`Drift Alice ${TAG}`)).toHaveCount(0);
  await expect(page.getByText(`Drift Dee ${TAG}`).first()).toBeVisible();
});
