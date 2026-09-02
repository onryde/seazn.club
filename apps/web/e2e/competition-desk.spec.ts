import { test, expect, type APIRequestContext } from "@playwright/test";
import {
  TAG,
  apiJson,
  activeOrg,
  addEntrantsViaApi,
  createStageAndGenerate,
  setFixtureStatusSql,
  setStageStatusSql,
} from "./helpers";

async function seed(request: APIRequestContext) {
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    name: `Desk ${TAG} ${Math.random().toString(36).slice(2, 6)}`, visibility: "public", ends_on: "2030-12-31",
  });
  const div = await apiJson<{ id: string; slug: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Premier", sport_key: "football", variant_key: "11-a-side",
  });
  await addEntrantsViaApi(request, div.data!.id, ["Riverside FC", "Valley CC", "Lakeside FC", "Harbour CC"], "team");
  const { stageId, fixtureIds } = await createStageAndGenerate(request, div.data!.id);
  await apiJson(request, `/api/v1/divisions/${div.data!.id}/start`, "POST");
  return { compId: comp.data!.id, compSlug: comp.data!.slug, divSlug: div.data!.slug, stageId, fixtureIds };
}

test.describe("competition desk", () => {
  test("unscheduled league: Needs you names the gap and the ledger row is scheduled, not live", async ({ page, request }) => {
    const org = await activeOrg(page);
    const rig = await seed(request);
    await page.goto(`/o/${org.slug}/c/${rig.compSlug}`);
    const needs = page.getByTestId("desk-needs-you");
    await expect(needs.locator('[data-attention="unscheduled"]')).toHaveCount(1);
    await expect(needs).toContainText(`Premier · ${rig.fixtureIds.length} fixtures unscheduled`);
    const row = page.getByTestId("desk-ledger-row").first();
    // F1 fix (final review, Critical): fixtures exist but none carry a
    // time yet, so this reads setting_up (with the unscheduled attention
    // above), never "scheduled" — the old rule 5 read "scheduled" here
    // while the row's OWN status line said "nothing scheduled" next to it.
    await expect(row).toHaveAttribute("data-phase", "setting_up");
    // Toothless-guard fix: the old assertion checked for
    // "Nothing scheduled yet" — a string that lives only at
    // entity-card.tsx's `card.next.none`, which this page never renders.
    // The live defect copy is lowercase and has no "yet"; re-anchored on
    // that, and on the row actually stating a played count that must never
    // sit beside it.
    await expect(row).toContainText(`0 of ${rig.fixtureIds.length} played`);
    await expect(row).not.toContainText(/nothing scheduled/i);
    await expect(page.getByText("Live", { exact: true })).toHaveCount(0);
    await needs.getByRole("link", { name: "Open schedule board" }).click();
    await expect(page).toHaveURL(new RegExp(`/d/${rig.divSlug}/schedule$`));
  });

  test("in play with no events: No scorer leads and the competition pill counts it", async ({ page, request }) => {
    const org = await activeOrg(page);
    const rig = await seed(request);
    await setFixtureStatusSql(rig.fixtureIds[0]!, "in_play");
    await page.goto(`/o/${org.slug}/c/${rig.compSlug}`);
    const first = page.getByTestId("desk-needs-you").locator("[data-attention]").first();
    await expect(first).toHaveAttribute("data-attention", "no_scorer");
    // The division ledger row renders its PhasePill twice (mobile card +
    // desktop row, one hidden by CSS per width, per division-ledger.tsx) — a
    // bare `.first()` resolves the mobile-hidden copy at this project's
    // desktop viewport and reads as a failure. `:visible` picks whichever
    // copy actually renders here, the same fix registration-hub.spec.ts's
    // `statusLocator` uses for the identical dual-DOM shape.
    await expect(page.locator('[data-pill="no_scorer"]:visible').first()).toBeVisible();
    await expect(page.locator('[data-phase="in_play"]').first()).toContainText("1 in play");
  });

  test("all decided: finished, no Needs you section at all", async ({ page, request }) => {
    const org = await activeOrg(page);
    const rig = await seed(request);
    await setStageStatusSql(rig.stageId, "complete");
    for (const id of rig.fixtureIds) await setFixtureStatusSql(id, "decided");
    await page.goto(`/o/${org.slug}/c/${rig.compSlug}`);
    await expect(page.getByTestId("desk-ledger-row").first()).toHaveAttribute("data-phase", "finished");
    await expect(page.getByTestId("desk-needs-you")).toHaveCount(0);
  });

  // fix-round-c, Defect 1 (owner ruling 2026-09-02): a scoped re-review found
  // the wave's headline contradiction still reachable through a knockout
  // shape the earlier F1 fix didn't cover — a TBD-entrant final can carry a
  // date (division-phase.ts rule 5 doesn't require entrants to be filled),
  // while card-stats.ts's `next` query excludes TBD-entrant fixtures, so
  // `next` comes back null even though the phase reads "scheduled".
  // Reproduced live before this fix: "0 of 3 played · nothing scheduled ·
  // 2 unscheduled" beside a "Scheduled" pill.
  test("knockout with only the TBD final dated: scheduled, never the nothing-scheduled contradiction", async ({
    page,
    request,
  }) => {
    const org = await activeOrg(page);
    const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
      name: `Desk KO ${TAG} ${Math.random().toString(36).slice(2, 6)}`, visibility: "public", ends_on: "2030-12-31",
    });
    const div = await apiJson<{ id: string; slug: string }>(
      request,
      `/api/v1/competitions/${comp.data!.id}/divisions`,
      "POST",
      { name: "Cup", sport_key: "generic", variant_key: "score", config: { points: { w: 3, d: 1, l: 0 }, progressScore: false } },
    );
    await addEntrantsViaApi(request, div.data!.id, ["Seed1", "Seed2", "Seed3", "Seed4"]);
    const { fixtureIds } = await createStageAndGenerate(request, div.data!.id, { kind: "knockout", name: "Cup" });
    expect(fixtureIds.length).toBe(3); // 2 semis (real entrants, undated) + final (TBD, dated below)
    const fixtures = await Promise.all(
      fixtureIds.map((id) => apiJson<{ id: string; home_entrant_id: string | null; away_entrant_id: string | null }>(
        request, `/api/v1/fixtures/${id}`,
      ).then((r) => r.data!)),
    );
    const final = fixtures.find((f) => !f.home_entrant_id && !f.away_entrant_id);
    expect(final).toBeTruthy();
    const patched = await apiJson(request, `/api/v1/fixtures/${final!.id}`, "PATCH", {
      scheduled_at: "2026-09-20T10:00:00Z",
    });
    expect(patched.status).toBeLessThan(300);
    await apiJson(request, `/api/v1/divisions/${div.data!.id}/start`, "POST");

    await page.goto(`/o/${org.slug}/c/${comp.data!.slug}`);
    const row = page.getByTestId("desk-ledger-row").filter({ hasText: "Cup" }).first();
    await expect(row).toHaveAttribute("data-phase", "scheduled");
    await expect(row).toContainText("0 of 3 played");
    await expect(row).toContainText("2 unscheduled");
    await expect(row).not.toContainText(/nothing scheduled/i);
  });

  // fix-round-c, Defect 2 (owner ruling 2026-09-02): the fix for Defect 1
  // over-applied `setting_up` to a mid-season division that has already
  // played fixtures but not yet dated its next round — a league dated a
  // round at a time, the normal way one runs. Reproduced live before this
  // fix: "1 of 6 played · 5 unscheduled" read "Setting up" beside a
  // part-filled progress bar.
  test("mid-season league, one played and the rest undated: scheduled, never setting_up", async ({
    page,
    request,
  }) => {
    const org = await activeOrg(page);
    const rig = await seed(request);
    // `seed()` uses sport_key "football" — its own event schema doesn't
    // accept the sport-agnostic `generic.result` type `scoreFixture` sends,
    // so this file's own established convention for forcing a result
    // (`setFixtureStatusSql`, already used by the "all decided" test above)
    // is used here too rather than a mismatched real event.
    await setFixtureStatusSql(rig.fixtureIds[0]!, "decided");

    await page.goto(`/o/${org.slug}/c/${rig.compSlug}`);
    const row = page.getByTestId("desk-ledger-row").filter({ hasText: "Premier" }).first();
    await expect(row).toHaveAttribute("data-phase", "scheduled");
    await expect(row).toContainText(`1 of ${rig.fixtureIds.length} played`);
    await expect(row).not.toContainText(/setting up/i);
    await expect(row).not.toContainText(/nothing scheduled/i);
  });
});
