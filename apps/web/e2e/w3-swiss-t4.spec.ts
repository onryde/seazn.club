import { test, expect } from "@playwright/test";
import { TAG, apiJson, divisionPath, expectNoHorizontalScroll, withDb } from "./helpers";
import { uiEn } from "./match-room-kit";
import { LATE_SPORTS, stageFixtures, type Seated } from "./support/swiss-app-a-kit";

// W3 Swiss app-B Task 4 (SW-H1 on the desk; X-SW-3, X-SW-26). A Swiss round with no legal pairing is refused by name, and the
// desk says WHY with the recovery inside the notice. Own file, run only by the CI dispatch (`e2e.yml`) and judged as a whole,
// never with `-g`. The S6 history (rounds 1-3 of six players, each a home win, leaving two unplayed triangles) is written onto
// the product's OWN minted shells by SQL: no UI path reaches a dead end deterministically after W3's guards, so the refusal
// itself comes from the real server and engine when the organiser presses Pair next - not from a fixture.
//
// The expected words are typed here in English (the org's locale), not read from the dictionary under test; the numbers are the
// arithmetic of the shape: six players -> three boards a round, rounds 1-3 decided, so the refused round is 4, Finish is after
// round 3, rounds 4 and 5 are shells (3 + 3 = 6 rows) and go.
const HISTORY: readonly (readonly (readonly [number, number])[])[] = [
  [[0, 1], [2, 3], [4, 5]],
  [[0, 5], [1, 2], [3, 4]],
  [[0, 3], [1, 4], [2, 5]],
];

test.describe("X-SW-3 / X-SW-26 an unpairable round refuses by name and finishes after the last full round", () => {
  // The sports run in separate tests, each its own organisation of state; serial mode is NOT set (a red in one must not hide the other).
  for (const sport of LATE_SPORTS) {
    test(`Pair next names the round and the reason, offers Finish after round 3, and the confirmed Finish seeds the knockout from round 3's table (${sport.key})`, async ({
      page,
      request,
    }) => {
      test.setTimeout(240_000);
      // --- Setup through the product's own API: a 5-round Swiss feeding a knockout of the top three (the swiss_knockout shape).
      const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
        ends_on: "2030-12-31",
        name: `T4 ${sport.key} ${TAG}`,
        visibility: "private",
      });
      expect(comp.status, JSON.stringify(comp.error)).toBe(201);
      const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
        name: "Open",
        sport_key: sport.key,
        variant_key: sport.variant,
        config: sport.config,
      });
      expect(div.status, JSON.stringify(div.error)).toBe(201);
      const divisionId = div.data!.id;
      const added = await apiJson<{ id: string; seed: number | null }[]>(
        request,
        `/api/v1/divisions/${divisionId}/entrants`,
        "POST",
        Array.from({ length: 6 }, (_, i) => ({ kind: "individual", display_name: `T4 S${i + 1} ${TAG}`, seed: i + 1, members: [] })),
      );
      expect(added.status, JSON.stringify(added.error)).toBe(201);
      // p0..p5 are seeds 1..6, whatever order the POST answered them in.
      const ids = [...added.data!].sort((a, b) => (a.seed ?? 0) - (b.seed ?? 0)).map((e) => e.id);
      expect(ids, "premise: six entrants").toHaveLength(6);
      const swiss = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
        seq: 1,
        kind: "swiss",
        name: "Swiss",
        config: { rounds: 5 },
      });
      expect(swiss.status, JSON.stringify(swiss.error)).toBe(201);
      const ko = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
        seq: 2,
        kind: "knockout",
        name: "Knockout",
        config: {},
        progression: {
          sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 3 }] }],
          placement: "rank_order",
          timing: "setup",
        },
      });
      expect(ko.status, JSON.stringify(ko.error)).toBe(201);
      const swissId = swiss.data!.id;
      const koId = ko.data!.id;
      const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
      expect(started.status, `start → ${JSON.stringify(started.error)}`).toBe(200);
      const drawn = await apiJson(request, `/api/v1/stages/${koId}/generate`, "POST");
      expect(drawn.status, `the knockout's TBD bracket → ${JSON.stringify(drawn.error)}`).toBe(200);

      // --- The history, onto the minted shells. A shell that is missing or takes nothing fails here, not later as a mystery.
      await withDb(async (sql) => {
        let written = 0;
        for (const [i, round] of HISTORY.entries()) {
          for (const [b, [home, away]] of round.entries()) {
            const outcome = { kind: "win", winner: ids[home]!, loser: ids[away]! };
            const done = await sql`
              update fixtures set home_entrant_id = ${ids[home]!}, away_entrant_id = ${ids[away]!}, status = 'decided',
                outcome = ${sql.json(outcome)}
              where stage_id = ${swissId} and ext_key = ${`sw-r${i + 1}-b${b + 1}`}
              returning id`;
            expect(done.length, `shell sw-r${i + 1}-b${b + 1} exists and took the result`).toBe(1);
            written++;
          }
        }
        expect(written, "every board of the history written").toBe(9);
      });
      const roundsIn = async () => [...new Set((await stageFixtures(request, divisionId, swissId)).map((f) => f.round_no))].sort();
      expect(await roundsIn(), "premise: five rounds are minted").toEqual([1, 2, 3, 4, 5]);
      const seatedIn4 = async () =>
        ((await stageFixtures(request, divisionId, swissId)) as Seated[]).filter(
          (f) => f.round_no === 4 && (f.home_entrant_id !== null || f.away_entrant_id !== null),
        );
      expect(await seatedIn4(), "premise: round 4 is empty shells").toEqual([]);

      // The table after round 3, read BEFORE anything is pressed: the independent expectation for the knockout's seeds.
      const table = await apiJson<{ rows: { entrantId: string; rank?: number }[] }>(request, `/api/v1/stages/${swissId}/standings`);
      expect(table.status, JSON.stringify(table.error)).toBe(200);
      const top3 = [...table.data!.rows].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0)).slice(0, 3).map((r) => r.entrantId);
      expect(top3, "premise: three ranked").toHaveLength(3);

      // The knockout's seed proposals, straight from the table. Finish completes the Swiss and the completion computes a DRAFT
      // proposal for a `timing: "setup"` next stage (propose, never auto-fill), so the proof that Finish seeded the knockout is
      // THAT row, read here - not a POST to /seed-proposal, which recomputes from the standings as they stand now and would
      // pass for any consistent table.
      type Proposal = { id: string; status: string; computed: { qualifiers: { rank: number; entrantId: string }[] } };
      const proposalsOf = () =>
        withDb((sql) => sql<Proposal[]>`select id, status, computed from stage_seed_proposals where stage_id = ${koId} order by created_at, id`);
      expect(await proposalsOf(), "premise: the knockout has no seed proposal before anything is pressed").toEqual([]);

      // --- The desk: Pair next is refused and the notice says why.
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
      const card = page.locator(`[data-stage-id="${swissId}"]`);
      const pairNext = card.getByTestId("stage-generate");
      await expect(pairNext).toBeEnabled({ timeout: 20_000 });
      const refused = page.waitForResponse((res) => res.url().endsWith(`/api/v1/stages/${swissId}/generate`) && res.request().method() === "POST");
      await pairNext.click();
      const answer = await refused;
      const body = (await answer.json()) as { error?: { code?: string; round?: number; reason?: string; finishAfter?: number; canFinish?: boolean } };
      expect(answer.status(), "409: Finish after round 3 is the way out").toBe(409);
      expect(body.error, "the refusal names the round and the recovery").toMatchObject({
        code: "SWISS_NO_LEGAL_PAIRING",
        round: 4,
        finishAfter: 3,
        canFinish: true,
      });

      const notice = page.getByTestId("schedule-pairing-refusal");
      await expect(notice).toBeVisible({ timeout: 20_000 });
      // The words: the round, why (S6: every unmet pair is a rematch) and the recovery - never the success copy of a round
      // that seated nobody, and never the red line.
      await expect(notice).toContainText("Round 4 can't be paired");
      expect(body.error!.reason, "premise: the S6 history is a dead end of rematches").toBe("rematch");
      await expect(notice).toContainText("would repeat a match already played");
      await expect(notice).toContainText("finish the Swiss after round 3");
      // The consequence is the confirm's, in the same words (review m6): the table is recalculated, not final as it stands.
      await expect(notice).toContainText("recalculated as a 3-round event");
      await expect(notice).not.toContainText("final as they stand");
      await expect(page.getByText(uiEn["schedule.notice.nothingNew"]!)).toHaveCount(0);
      await expect(page.getByTestId("schedule-error")).toHaveCount(0);
      // Three rounds are decided, so the round count is fixed (rounds lock at the first start): Finish is the only way out
      // and the notice does not offer, or promise, a Change rounds it could not deliver.
      const finishBtn = notice.getByTestId("schedule-pairing-finish");
      await expect(finishBtn).toHaveText("Finish after round 3");
      await expect(notice.getByTestId("schedule-pairing-rounds")).toHaveCount(0);
      await expect(notice).not.toContainText(/change (the number of )?rounds/i);
      expect(await seatedIn4(), "the refusal seats nobody").toEqual([]);

      // No horizontal page scroll with the notice up, at the three widths the owner reviews (1280 / 768 / 320).
      for (const width of [1280, 768, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await expect(notice).toBeVisible();
        await expectNoHorizontalScroll(page);
      }
      await page.setViewportSize({ width: 1280, height: 900 });

      // --- Finish: asks first (declining writes nothing), then ends the Swiss after round 3.
      await finishBtn.click();
      const confirm = page.getByRole("alertdialog", { name: uiEn["stage.finish.confirm.title"]! });
      await expect(confirm).toBeVisible();
      await expect(confirm).toContainText("The Swiss ends after round 3. The table is recalculated as a 3-round event.");
      await expect(confirm).toContainText("Rounds 4–5 are removed.");
      await confirm.getByRole("button", { name: uiEn["schedule.cancel"]! }).click();
      await expect(confirm).toHaveCount(0);
      expect(await roundsIn(), "declined: nothing written").toEqual([1, 2, 3, 4, 5]);
      expect(await proposalsOf(), "declined: the knockout is not seeded either").toEqual([]);
      await expect(notice, "declined: the notice stays").toBeVisible();

      await finishBtn.click();
      await expect(confirm).toBeVisible();
      const posted = page.waitForResponse((res) => res.url().endsWith(`/api/v1/stages/${swissId}/swiss/finish`) && res.request().method() === "POST");
      await confirm.getByRole("button", { name: uiEn["stage.finish.confirm.label"]! }).click();
      const finished = await posted;
      expect(finished.status(), "Finish writes once").toBe(200);
      const done = ((await finished.json()) as { data?: { seed_proposal?: { id: string; status: string } } }).data;
      expect(done).toMatchObject({ finished_after: 3, shells_removed: 6, completed: true, seed_proposal: { status: "draft" } });
      await expect(page.getByText("The Swiss finished after round 3.")).toBeVisible({ timeout: 20_000 });
      await expect(notice, "the refusal is cleared once the Swiss is finished").toHaveCount(0);
      expect(await roundsIn(), "rounds 4 and 5 are gone").toEqual([1, 2, 3]);

      // --- The knockout seeded from round 3's table: the draft Finish's own completion wrote, read from the database before any
      // POST. Its qualifiers in rank order are the top three of the table read before anything was pressed.
      const proposals = await proposalsOf();
      expect(proposals.map((p) => p.status), "exactly one proposal, a draft: the one Finish computed").toEqual(["draft"]);
      expect(proposals[0]!.id, "and it is the one Finish's response named").toBe(done!.seed_proposal!.id);
      expect(
        [...proposals[0]!.computed.qualifiers].sort((a, b) => a.rank - b.rank).map((q) => q.entrantId),
        "the knockout's seeds are the top three after round 3",
      ).toEqual(top3);
    });
  }
});
