import { test, expect } from "@playwright/test";
import { TAG, apiJson, addEntrantsViaApi, createStageAndGenerate, fixturePath } from "./helpers";

// NEW-H1 (rulebook-W2-sets-cricket.md:57; W2a spec §5.4.7, §8.2). A set-sport
// knockout semi-final abandoned by its scorer folds to `outcome: null`, the
// exact shape `feederIsDead` (usecases/stages.ts:3657) reads as a generator
// void. The 2026-09-21 owner ruling says an abandoned match is STUCK AND
// VISIBLE: the final's seat stays empty and no walkover is invented. This
// probe asserts the ruling, so it is RED while NEW-H1 holds (W2a Task 1) and
// green after Task 10. Kept in e2e as the regression (memory: keep probes).

interface Fx {
  id: string;
  round_no: number | null;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
  outcome: { kind?: string; winner?: string } | null;
}

test("NEW-H1: an abandoned badminton semi-final leaves the final's seat empty and invents no walkover", async ({ page, request }) => {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `NEW-H1 ${TAG}-${Math.random().toString(36).slice(2, 6)}`,
    visibility: "private",
  });
  expect(comp.status).toBe(201);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Cup",
    sport_key: "badminton",
    variant_key: "bwf",
  });
  expect(div.status).toBe(201);
  const divisionId = div.data!.id;
  await addEntrantsViaApi(request, divisionId, ["H1 One", "H1 Two", "H1 Three", "H1 Four"]);
  const { fixtureIds } = await createStageAndGenerate(request, divisionId, { kind: "knockout", name: "Cup" });
  expect((await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST")).status).toBeLessThan(300);

  const read = async (id: string) => (await apiJson<Fx>(request, `/api/v1/fixtures/${id}`)).data!;
  const all = await Promise.all(fixtureIds.map(read));
  const semis = all.filter((f) => f.home_entrant_id !== null && f.away_entrant_id !== null);
  const final = all.find((f) => f.home_entrant_id === null && f.away_entrant_id === null);
  expect(semis.length).toBe(2); // a 4-draw: two seated semis
  expect(final).toBeTruthy(); // and an unseated final

  // Semi 1: started, then abandoned from the console's own Abandon control (the organiser UI).
  // The control is "Abandon…" and the dialog's submit is "Apply" (scoring.spec.ts:180-185 drives the same pair).
  const [sf1, sf2] = semis;
  const tip = async (id: string) => (await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${id}/state`)).data!.last_seq;
  expect((await apiJson(request, `/api/v1/fixtures/${sf1!.id}/events`, "POST", { expected_seq: await tip(sf1!.id), type: "core.start", payload: {} })).status).toBeLessThan(300);
  await page.goto(await fixturePath(request, sf1!.id));
  await page.getByRole("button", { name: "Abandon…", exact: true }).click({ timeout: 20_000 });
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await dialog.locator('input[name="reason"]').fill("rain");
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect.poll(async () => (await read(sf1!.id)).status, { timeout: 15_000 }).toBe("abandoned");
  expect((await read(sf1!.id)).outcome).toBeNull(); // the NEW-H1 shape: abandoned, no outcome

  // Semi 2: a walkover decides it, which runs the seat cascade (onDecided → resolveBracketSeats).
  expect((await apiJson(request, `/api/v1/fixtures/${sf2!.id}/events`, "POST", { expected_seq: await tip(sf2!.id), type: "core.start", payload: {} })).status).toBeLessThan(300);
  expect((await apiJson(request, `/api/v1/fixtures/${sf2!.id}/events`, "POST", { expected_seq: await tip(sf2!.id), type: "core.forfeit", payload: { by: sf2!.away_entrant_id, reason: "walkover" } })).status).toBeLessThan(300);
  await expect.poll(async () => [(await read(final!.id)).home_entrant_id, (await read(final!.id)).away_entrant_id].filter(Boolean).length, { timeout: 15_000 }).toBe(1);

  // What the cascade left behind, recorded so the JSON report states what was SEEN, not what must be true.
  const sf1After = await read(sf1!.id);
  const sf2After = await read(sf2!.id);
  const after = await read(final!.id);
  test.info().annotations.push({
    type: "observed",
    description: JSON.stringify({
      semi1: { status: sf1After.status, outcome: sf1After.outcome },
      semi2: { status: sf2After.status, outcome: sf2After.outcome },
      final: { status: after.status, outcome: after.outcome, home: after.home_entrant_id, away: after.away_entrant_id },
    }),
  });

  // The ruling: stuck and visible. The final is NOT turned into a walkover for semi 2's winner.
  expect(after.status).toBe("scheduled");
  expect(after.outcome).toBeNull();
});
