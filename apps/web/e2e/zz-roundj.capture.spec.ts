// Round J visual capture — NOT a gate. Builds one competition carrying every
// state round J touched, then photographs it at 320, 768 and 1280 so the
// owner can look at the phone composition rather than read about it.
//
// Untracked scratch: delete after the sign-off page is assembled.
import { test, expect } from "@playwright/test";
import {
  TAG, apiJson, addEntrantsViaApi, createStageAndGenerate, competitionPath,
  setFixtureStatusSql, setFixtureScheduledAtSql, setStageStatusSql, assignScorerSql,
} from "./helpers";
import { NOT_RECORDING_GRACE_MINUTES } from "../src/lib/division-phase";

const OUT = process.env.CAPTURE_DIR ?? "/tmp/seazn-env/fxc/roundj-shots";

test("round J: capture the desk at three widths", async ({ page, request }) => {
  test.setTimeout(180_000);
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    name: `Round J ${TAG}`, visibility: "public", ends_on: "2030-12-31",
  });
  expect(comp.status).toBe(201);

  const makeDiv = async (name: string) => {
    const div = await apiJson<{ id: string; slug: string }>(
      request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST",
      { name, sport_key: "generic", variant_key: "score", config: { points: { w: 3, d: 1, l: 0 }, progressScore: false } },
    );
    expect(div.status).toBe(201);
    await addEntrantsViaApi(request, div.data!.id, ["Northside Rovers", "Harbour Athletic", "Kingsway United", "Old Mill FC"]);
    const { stageId, fixtureIds } = await createStageAndGenerate(request, div.data!.id, { kind: "league", name: "League" });
    expect((await apiJson(request, `/api/v1/divisions/${div.data!.id}/start`, "POST")).status).toBeLessThan(400);
    return { div: div.data!, stageId, fixtureIds };
  };

  // 1. A live match nobody is recording, with a scorer assigned (F3).
  const live = await makeDiv("Saturday Premier");
  await assignScorerSql(live.fixtureIds[0]!);
  await setFixtureScheduledAtSql(
    live.fixtureIds[0]!,
    new Date(Date.now() - (NOT_RECORDING_GRACE_MINUTES + 40) * 60_000).toISOString(),
  );
  await setFixtureStatusSql(live.fixtureIds[0]!, "in_play");

  // 2. A red row: league played out, a setup-timing Finals still owed (F4).
  const red = await makeDiv("Championship Cup");
  for (const id of red.fixtureIds) await setFixtureStatusSql(id, "decided");
  await setStageStatusSql(red.stageId, "complete");
  expect((await apiJson(request, `/api/v1/divisions/${red.div.id}/stages`, "POST", {
    seq: 2, kind: "knockout", name: "Finals", config: {},
    progression: { sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }], placement: "rank_order", timing: "setup" },
  })).status).toBe(201);

  const url = await competitionPath(request, comp.data!.id);
  for (const [label, width, height] of [["320", 320, 568], ["768", 768, 1024], ["1280", 1280, 900]] as const) {
    await page.setViewportSize({ width, height });
    await page.goto(url, { waitUntil: "load" });
    await page.screenshot({ path: `${OUT}/desk-${label}.png`, fullPage: true });
    if (width < 640) {
      const more = page.getByTestId("desk-tools-more-toggle");
      await expect(more).toBeVisible();
      await more.click();
      await expect(more).toHaveAttribute("aria-expanded", "true");
      await page.screenshot({ path: `${OUT}/desk-${label}-more-open.png`, fullPage: true });
    }
  }
  // Print what was photographed, so a capture of the wrong state cannot pass
  // for a sign-off (the harness once collected one on zero pictures).
  console.log("CAPTURED", url);
  console.log("MASTHEAD", (await page.getByTestId("desk-masthead-pill").textContent())?.trim());
  console.log("NEEDS", (await page.getByTestId("desk-needs-you").innerText()).replace(/\n+/g, " | "));
});
