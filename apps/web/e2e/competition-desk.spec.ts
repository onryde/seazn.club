import { test, expect, type APIRequestContext } from "@playwright/test";
import {
  TAG,
  apiJson,
  activeOrg,
  addEntrantsViaApi,
  createStageAndGenerate,
  setFixtureStatusSql,
  setFixtureScheduledAtSql,
  setStageStatusSql, setZoneSplitSql,
  assignScorerSql,
  backdateFixtureStartSql,
  scoreFixture } from "./helpers";
import { findBucketSplit, findPrintSplit, sweepZoneSplitFinders } from "./zone-split";
import { NOT_RECORDING_GRACE_MINUTES } from "../src/lib/division-phase";

/** "Sun 6 Sep" — matches division-status-line.ts's `nextDateLabel`/`whenLabel`
 *  day portion, so an assertion never hardcodes a calendar date that ages. */
function zoneDayLabel(date: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: tz, weekday: "short", day: "numeric", month: "short",
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("weekday")} ${get("day")} ${get("month")}`;
}

/**
 * H3 fix (final review round 3, Important): this file's org/venue zone-split
 * fixtures used to pin a literal calendar date (`2026-09-06T23:00:00Z`,
 * expiring 2026-09-07 once the `>= now` filter drops it from `next`; a
 * sibling literal expired for exactly one day on 2026-09-20). J1 (fix round F,
 * Critical) then found that searching forward from `now` was not enough on its
 * own: with the ZONE PAIR pinned, the bucketing property existed for only ~4.5
 * hours a day and the helper threw for the other ~19.5 (7145/8760 hourly
 * samples across 2026). Both finders now live in `./zone-split.ts`, choose the
 * ORDERING of the pair at runtime, and are swept for totality by the test
 * directly below. See that module's header for why two orderings are total.
 */

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
  return { compId: comp.data!.id, compSlug: comp.data!.slug, divisionId: div.data!.id, divSlug: div.data!.slug, stageId, fixtureIds };
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
    await expect(page.getByText("Live", { exact: true })).toHaveCount(0);
    await needs.getByRole("link", { name: "Open schedule board" }).click();
    await expect(page).toHaveURL(new RegExp(`/d/${rig.divSlug}/schedule$`));
  });

  // RENAMED by F4 (round J), and the rename is the point. This used to assert
  // that the masthead printed "1 in play" while a division below it said "No
  // scorer". It does not any more: the masthead now obeys the same model rule
  // the rows have always obeyed — a RED attention OUTRANKS the phase — so it
  // says "No scorer" too.
  //
  // RULING (round J): that is the better answer for the organiser and the
  // cost is stated plainly. A live match nobody is recording is more urgent
  // and more actionable than the count of live matches, and the count is
  // still on screen in the rows underneath. The cost is that while ANY
  // division is red, the competition-level "N in play" figure is not in the
  // masthead — accepted, because the alternative is the exact contradiction
  // this wave exists to remove: a calm summary sitting above an alarmed row.
  test("in play with no events: No scorer leads, and the masthead says it too rather than counting calmly", async ({ page, request }) => {
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
    // Review 7 REVERSED round J's first answer here, and the reviewer was
    // right. The masthead briefly suppressed the count whenever any division
    // was red, so "a future stage needs its draw" deleted "1 in play" — the
    // only competition-level live count on the page. A row has to make that
    // trade (one pill, and its alternative is a phase word); the masthead has
    // a whole line. It keeps BOTH facts now, in two chips.
    const masthead = page.getByTestId("desk-masthead-pill");
    await expect(masthead).toHaveAttribute("data-phase", "in_play");
    await expect(masthead, "the live count must survive a red attention").toContainText("1 in play");
    const chip = page.getByTestId("desk-masthead-attention");
    await expect(chip, "and the red attention is named beside it").toHaveAttribute("data-attention-chip", "no_scorer");
  });

  // H2 fix (final review round 3, Important — corrected ruling): G3's gate
  // (`divisionStatus === "active"`) also excluded `scheduled` — exactly what
  // the ordinary Publish action sets. Live: six fixtures dated YESTERDAY on
  // a published, never-started division produced NO "Needs you" section at
  // all — an organiser who published a timetable and never pressed Start got
  // no prompt of any kind. RULING: the gate excludes `setup` only.
  test("published but not started: Needs you still names an overdue result", async ({ page, request }) => {
    const org = await activeOrg(page);
    const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
      name: `Desk Pub ${TAG} ${Math.random().toString(36).slice(2, 6)}`, visibility: "public", ends_on: "2030-12-31",
    });
    const div = await apiJson<{ id: string; slug: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
      name: "Premier", sport_key: "football", variant_key: "11-a-side",
    });
    await addEntrantsViaApi(request, div.data!.id, ["Riverside FC", "Valley CC", "Lakeside FC", "Harbour CC"], "team");
    const { fixtureIds } = await createStageAndGenerate(request, div.data!.id);
    // Publish ONLY — never Start. `divisions.status` lands on 'scheduled',
    // never 'active', the exact shape the ordinary Publish button leaves an
    // organiser in.
    const published = await apiJson(request, `/api/v1/divisions/${div.data!.id}/publish-schedule`, "POST", {});
    expect(published.status).toBe(200);
    // Date one fixture in the past directly — the schedule engine's own
    // validation is not this test's concern, only what the desk does with a
    // published-but-unstarted division that already owes a result.
    await setFixtureScheduledAtSql(fixtureIds[0]!, new Date(Date.now() - 24 * 3600_000).toISOString());

    await page.goto(`/o/${org.slug}/c/${comp.data!.slug}`);
    const needs = page.getByTestId("desk-needs-you");
    await expect(needs).toBeVisible();
    await expect(needs.locator('[data-attention="result_missing"]')).toHaveCount(1);
    const row = page.getByTestId("desk-ledger-row").filter({ hasText: "Premier" }).first();
    await expect(row).toHaveAttribute("data-phase", "scheduled");
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
    // H3 fix (final review round 3, Important): was a literal calendar date
    // (`2026-09-20T10:00:00Z`) that read as "scheduled" only until the phase
    // flipped to `match_day` on that one day — derived from `now` instead, so
    // this stays comfortably in the future regardless of when the suite runs.
    const twoWeeksOut = new Date(Date.now() + 14 * 24 * 3600_000).toISOString();
    const patched = await apiJson(request, `/api/v1/fixtures/${final!.id}`, "PATCH", {
      scheduled_at: twoWeeksOut,
    });
    expect(patched.status).toBeLessThan(300);
    await apiJson(request, `/api/v1/divisions/${div.data!.id}/start`, "POST");

    await page.goto(`/o/${org.slug}/c/${comp.data!.slug}`);
    const row = page.getByTestId("desk-ledger-row").filter({ hasText: "Cup" }).first();
    await expect(row).toHaveAttribute("data-phase", "scheduled");
    await expect(row).toContainText("0 of 3 played");
    await expect(row).toContainText("2 unscheduled");
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
  });

  // J2 (fix round F, Critical) — the eighth instance of this wave's signature
  // defect, and the only one found by asking whether a REVIEWER's "could not
  // confirm this is reachable" was true. It was.
  //
  // `isBracketStageComplete` (packages/engine/src/competition/stage.ts:134)
  // requires only the `isFinal` fixtures to be settled, and a third-place
  // playoff is never `isFinal` (engine-db/competition.ts:151 sets
  // `isFinal: !thirdPlace`). So an organiser who scores the semis and the
  // final and presses "Complete stage" gets a `complete` stage and a
  // `completed` division with the playoff still `scheduled` — and if that
  // playoff was dated (it is normally played BEFORE the final), the row read
  // "3 of 4 played · complete · Finished" beside a red "result missing …
  // Enter result" for that very fixture.
  //
  // Built through the real API the whole way — `config.thirdPlace` is a real
  // production stage-config key (stages.ts:772), and `POST /stages/{id}/
  // complete` is the organiser's own action, which returns 200 with
  // `division_completed: true` in exactly this state.
  test("a knockout completed with its third-place playoff unplayed: never Finished beside a missing result", async ({
    page,
    request,
  }) => {
    const org = await activeOrg(page);
    const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
      name: `Desk 3P ${TAG} ${Math.random().toString(36).slice(2, 6)}`, visibility: "public", ends_on: "2030-12-31",
    });
    const div = await apiJson<{ id: string; slug: string }>(
      request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST",
      { name: "Cup", sport_key: "generic", variant_key: "score", config: { points: { w: 3, d: 1, l: 0 }, progressScore: false } },
    );
    await addEntrantsViaApi(request, div.data!.id, ["Seed1", "Seed2", "Seed3", "Seed4"]);
    const { stageId, fixtureIds } = await createStageAndGenerate(request, div.data!.id, {
      kind: "knockout", name: "Cup", config: { thirdPlace: true },
    });
    // 2 semis + final + the playoff. If this is 3 the config key stopped
    // reaching the generator and everything below would pass vacuously.
    expect(fixtureIds.length).toBe(4);
    await apiJson(request, `/api/v1/divisions/${div.data!.id}/start`, "POST");
    // generateSingleElim pushes the third-place game LAST (bracket.ts).
    const [semi0, semi1, final, playoff] = fixtureIds;
    await scoreFixture(request, semi0!, 2, 1);
    await scoreFixture(request, semi1!, 2, 1);
    // Dated before the final and never played — the ordinary way this happens.
    await setFixtureScheduledAtSql(playoff!, new Date(Date.now() - 24 * 3600_000).toISOString());
    await scoreFixture(request, final!, 3, 0);
    const completed = await apiJson<{ division_completed?: boolean }>(
      request, `/api/v1/stages/${stageId}/complete`, "POST", {},
    );
    // Print the asserted CONTENT beside the gate: without these two the test
    // could be measuring a division that never completed at all, and "not
    // finished" would then be true for entirely the wrong reason.
    expect(completed.status).toBe(200);
    expect(completed.data?.division_completed).toBe(true);
    const divRow = await apiJson<{ status: string }>(request, `/api/v1/divisions/${div.data!.id}`);
    expect(divRow.data?.status).toBe("completed");
    const playoffRow = await apiJson<{ status: string }>(request, `/api/v1/fixtures/${playoff}`);
    expect(playoffRow.data?.status).toBe("scheduled");

    await page.goto(`/o/${org.slug}/c/${comp.data!.slug}`);
    const row = page.getByTestId("desk-ledger-row").filter({ hasText: "Cup" }).first();
    // The row and the Needs-you section must not contradict each other.
    await expect(page.getByTestId("desk-needs-you").locator('[data-attention="result_missing"]')).toHaveCount(1);
    await expect(row).not.toHaveAttribute("data-phase", "finished");
    await expect(row).toHaveAttribute("data-phase", "scheduled");
    await expect(row).toContainText("3 of 4 played");

    // And the other direction: entering the result the row asked for takes it
    // to finished with nothing outstanding. Without this the fix could have
    // been "never finished while any fixture is non-decided" and no test would
    // say so.
    const state = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${playoff}/state`);
    const scored = await apiJson(request, `/api/v1/fixtures/${playoff}/events`, "POST", {
      expected_seq: state.data!.last_seq, type: "generic.result", payload: { p1Score: 1, p2Score: 0 },
    });
    expect(scored.status).toBeLessThan(300);
    await page.goto(`/o/${org.slug}/c/${comp.data!.slug}`);
    const settled = page.getByTestId("desk-ledger-row").filter({ hasText: "Cup" }).first();
    await expect(settled).toHaveAttribute("data-phase", "finished");
    await expect(settled).toContainText("4 of 4 played");
    await expect(page.getByTestId("desk-needs-you")).toHaveCount(0);
  });

  // K1 (fix round G, Critical — instance NINE). Both shapes below are built
  // ENTIRELY through the production API — no SQL — because a state reached by
  // SQL alone may not be one a user can reach, and these two certainly are.
  //
  // Driven live against the pre-fix build at 08:19Z on 2026-09-03, shape A
  // read: masthead "Finished", row `data-phase=finished`, row text
  // "Cup 6 of 6 played · complete Finished Open", and ZERO Needs-you
  // sections — an entire knockout never played, never seeded, and nothing on
  // the page asking for it. Shape B read masthead "Setting up", row
  // `data-phase=setting_up`, "6 of 6 played", and again no Needs-you section.
  const KNOCKOUT_FROM_LEAGUE = {
    sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
    placement: "rank_order",
    timing: "on_complete",
  };

  async function leagueOfFour(request: APIRequestContext, label: string) {
    const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
      name: `Desk ${label} ${TAG} ${Math.random().toString(36).slice(2, 6)}`, visibility: "public", ends_on: "2030-12-31",
    });
    const div = await apiJson<{ id: string; slug: string }>(
      request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST",
      { name: "Cup", sport_key: "generic", variant_key: "score", config: { points: { w: 3, d: 1, l: 0 }, progressScore: false } },
    );
    await addEntrantsViaApi(request, div.data!.id, ["Seed1", "Seed2", "Seed3", "Seed4"]);
    const { stageId, fixtureIds } = await createStageAndGenerate(request, div.data!.id, { kind: "league", name: "League" });
    // A 4-entrant round robin. If this is not 6 the whole state below is a
    // different one and every assertion would be measuring something else.
    expect(fixtureIds.length).toBe(6);
    return { comp: comp.data!, div: div.data!, leagueId: stageId, fixtureIds };
  }

  async function addFinals(request: APIRequestContext, divisionId: string) {
    const created = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
      seq: 2, kind: "knockout", name: "Finals", config: {}, progression: KNOCKOUT_FROM_LEAGUE,
    });
    expect(created.status).toBe(201);
    return created.data!.id;
  }

  test("K1: a fully-played league with an unseeded finals stage is never Finished, and the desk names the stage", async ({
    page,
    request,
  }) => {
    const org = await activeOrg(page);
    const rig = await leagueOfFour(request, "K1a");
    await addFinals(request, rig.div.id);
    await apiJson(request, `/api/v1/divisions/${rig.div.id}/start`, "POST");
    for (const id of rig.fixtureIds) await scoreFixture(request, id, 2, 1);
    // Print the asserted CONTENT beside the gate: stage 1 stays `active`
    // (the organiser never pressed "Complete stage"), stage 2 `pending` with
    // nothing generated. Without this the test could be measuring a division
    // that auto-completed, where "not finished" would be true for the wrong
    // reason.
    const stages = await apiJson<{ id: string; seq: number; status: string }[]>(request, `/api/v1/divisions/${rig.div.id}/stages`);
    expect(stages.data?.map((s) => [s.seq, s.status])).toEqual([[1, "active"], [2, "pending"]]);

    await page.goto(`/o/${org.slug}/c/${rig.comp.slug}`);
    const row = page.getByTestId("desk-ledger-row").filter({ hasText: "Cup" }).first();
    await expect(row).not.toHaveAttribute("data-phase", "finished");
    await expect(row).toHaveAttribute("data-phase", "scheduled");
    await expect(row).toContainText("6 of 6 played");
    // The row must ASK for something, and the masthead must not contradict it.
    await expect(page.locator('[data-pill="needs_fixtures"]:visible').first()).toBeVisible();
    await expect(page.getByTestId("desk-masthead-pill")).not.toHaveAttribute("data-phase", "finished");
    const needs = page.getByTestId("desk-needs-you");
    await expect(needs.locator('[data-attention="needs_fixtures"]')).toHaveCount(1);
    await expect(needs).toContainText("Cup · no fixtures yet in Finals");
    // And the action the row carries actually leads somewhere real.
    await needs.getByRole("link", { name: "Open fixtures" }).click();
    await expect(page).toHaveURL(new RegExp(`/d/${rig.div.slug}\\?tab=fixtures$`));

    // The other direction: the product was never broken — completing the
    // league seeds the finals and the row corrects itself. Without this the
    // fix could have been "never finished while a later stage exists".
    const completed = await apiJson(request, `/api/v1/stages/${rig.leagueId}/complete`, "POST", {});
    expect(completed.status).toBe(200);
    await page.goto(`/o/${org.slug}/c/${rig.comp.slug}`);
    const seeded = page.getByTestId("desk-ledger-row").filter({ hasText: "Cup" }).first();
    await expect(seeded).toContainText("6 of 9 played");
    await expect(page.locator('[data-pill="needs_fixtures"]:visible')).toHaveCount(0);
  });

  test("K1 sibling: a finals stage added AFTER the league completed — setting_up, and still asked for", async ({
    page,
    request,
  }) => {
    const org = await activeOrg(page);
    const rig = await leagueOfFour(request, "K1b");
    await apiJson(request, `/api/v1/divisions/${rig.div.id}/start`, "POST");
    for (const id of rig.fixtureIds) await scoreFixture(request, id, 2, 1);
    // Complete the league FIRST, then add the cup — the ordinary "the league
    // is done, now let's play a knockout" flow, and the only way this shape is
    // reachable through the API at all (completing a stage that already has an
    // `on_complete` successor seeds it immediately).
    const completed = await apiJson(request, `/api/v1/stages/${rig.leagueId}/complete`, "POST", {});
    expect(completed.status).toBe(200);
    await addFinals(request, rig.div.id);
    const stages = await apiJson<{ seq: number; status: string }[]>(request, `/api/v1/divisions/${rig.div.id}/stages`);
    expect(stages.data?.map((s) => [s.seq, s.status])).toEqual([[1, "complete"], [2, "pending"]]);

    await page.goto(`/o/${org.slug}/c/${rig.comp.slug}`);
    const row = page.getByTestId("desk-ledger-row").filter({ hasText: "Cup" }).first();
    await expect(row).toHaveAttribute("data-phase", "setting_up");
    await expect(row).toContainText("6 of 6 played");
    await expect(page.locator('[data-pill="needs_fixtures"]:visible').first()).toBeVisible();
    await expect(page.getByTestId("desk-needs-you").locator('[data-attention="needs_fixtures"]')).toHaveCount(1);
    // K2 (fix round G, Important — instance TEN): the masthead used to print
    // "Setting up" above this row's "6 of 6 played". `setting_up` at
    // competition level means nothing has happened yet, and six matches have.
    await expect(page.getByTestId("desk-masthead-pill")).not.toHaveAttribute("data-phase", "setting_up");
    await expect(page.getByTestId("desk-masthead-pill")).toHaveAttribute("data-phase", "scheduled");
  });

  // K2 (fix round G, Important — instance TEN), the shape the reviewer drove:
  // a `{timing: "setup"}` finals stage after a completed league. The ROW is
  // right ("6 of 6 played · Finals not drawn", red "Needs draw"); the masthead
  // above it read "Setting up", because the ladder's terminal fallback rescued
  // only rows whose phase word was `scheduled`/`match_day` and a rule-4
  // `setting_up` row fell straight through. Observed live at 08:20Z on
  // 2026-09-03 against the pre-fix build.
  // BLOCKER (review 7): both live-recording attentions were INERT in
  // production, and every test for them hid it. `no_scorer` and
  // `not_recording` require `status === "in_play" && eventCount === 0`, but
  // the only production writer of `in_play` is `fixtureStatusFromFold`, whose
  // in-play branch is `has("core.start")` — and `core.start` is itself a
  // `score_events` row that the count included. A fixture the product started
  // therefore always had at least one event, and neither row could ever
  // appear for a real organiser.
  //
  // Every existing test reached `in_play` through `setFixtureStatusSql`, i.e.
  // through raw SQL that no user can perform, so all of them passed against a
  // state the product cannot produce. THIS test reaches it the way a scorer
  // does — by posting `core.start` to the real endpoint — which is the only
  // arrangement that can witness the regression.
  test("the live-recording rows fire for a fixture the PRODUCT started, not just one SQL forced in play", async ({
    page,
    request,
  }) => {
    const org = await activeOrg(page);
    const rig = await leagueOfFour(request, "realstart");
    expect((await apiJson(request, `/api/v1/divisions/${rig.div.id}/start`, "POST")).status).toBe(200);
    const fixtureId = rig.fixtureIds[0]!;
    // The real producer. Nothing else in this test touches `fixtures.status`.
    const started = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
      expected_seq: 0, type: "core.start", payload: {},
    });
    expect(started.status, "core.start must be accepted — this test is meaningless otherwise").toBeLessThan(400);

    await page.goto(`/o/${org.slug}/c/${rig.comp.slug}`);
    const needs = page.getByTestId("desk-needs-you");
    // Nobody assigned yet: the red row.
    await expect(
      needs.locator('[data-attention="no_scorer"]'),
      "a match the product just started, with nothing recorded, must raise No scorer",
    ).toHaveCount(1);

    // Assign someone and backdate the kick-off past the grace: the row becomes
    // its amber complement, and the two never appear together.
    await assignScorerSql(fixtureId);
    // The clock is the KICK-OFF (core.start's own recorded_at), so re-dating
    // the fixture would do nothing — which is the whole point of review 7's
    // Minor 8b, and is what this test caught on its first run. Age the start
    // event instead; the fixture still got in play through the real endpoint.
    await backdateFixtureStartSql(fixtureId, NOT_RECORDING_GRACE_MINUTES + 40);
    await page.reload();
    await expect(needs.locator('[data-attention="not_recording"]')).toHaveCount(1);
    await expect(needs.locator('[data-attention="no_scorer"]')).toHaveCount(0);

    // And the first REAL recorded event clears it — the other direction, so
    // "always fires" cannot pass for "fires correctly".
    const scored = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
      expected_seq: 1, type: "generic.result", payload: { p1Score: 1, p2Score: 0 },
    });
    expect(scored.status).toBeLessThan(400);
    await page.reload();
    await expect(needs.locator('[data-attention="not_recording"]')).toHaveCount(0);
  });

  // F4 (round J): the rows put a red attention on their pill and the masthead
  // showed only the phase, so a competition whose divisions were collectively
  // blocked read calm at the top of its own page. This asserts the WORDS, not
  // just that a pill exists — a `data-pill` attribute with the phase's own
  // copy under it would satisfy a weaker check and still say the wrong thing.
  test("F4: the masthead names the red attention its rows are raising, in the same words", async ({
    page,
    request,
  }) => {
    const org = await activeOrg(page);
    const rig = await leagueOfFour(request, "F4");
    await apiJson(request, `/api/v1/divisions/${rig.div.id}/start`, "POST");
    for (const id of rig.fixtureIds) await scoreFixture(request, id, 2, 1);
    const completed = await apiJson(request, `/api/v1/stages/${rig.leagueId}/complete`, "POST", {});
    expect(completed.status).toBe(200);
    const created = await apiJson<{ id: string }>(request, `/api/v1/divisions/${rig.div.id}/stages`, "POST", {
      seq: 2, kind: "knockout", name: "Finals", config: {},
      progression: { ...KNOCKOUT_FROM_LEAGUE, timing: "setup" },
    });
    expect(created.status).toBe(201);

    await page.goto(`/o/${org.slug}/c/${rig.comp.slug}`);
    const masthead = page.getByTestId("desk-masthead-pill");
    const row = page.getByTestId("desk-ledger-row").filter({ hasText: "Cup" }).first();
    // The row raises it...
    // The row renders its pill TWICE (mobile card + desktop row, one hidden
    // per width) — the same dual-DOM shape that has produced a false reading
    // three times in this wave. `:visible` picks the copy that renders here.
    const rowPill = row.locator('[data-pill="needs_fixtures"]:visible').first();
    await expect(rowPill).toBeVisible();
    // ...and so does the masthead, in its own chip beside the phase.
    const chip = page.getByTestId("desk-masthead-attention");
    await expect(chip).toHaveAttribute("data-attention-chip", "needs_fixtures");
    await expect(chip).toHaveText(/needs fixtures/i);
    // Print the asserted CONTENT beside the gate: the two must agree, and the
    // comparison is what this test exists for — a masthead that invented its
    // own competition-level copy would pass a bare presence check.
    expect(
      (await chip.textContent())?.trim().toLowerCase(),
      "masthead chip and row pill must say the same thing",
    ).toBe((await rowPill.textContent())?.trim().toLowerCase());
  });

  test("K2: the masthead never reads Setting up above a row that has played its whole league", async ({
    page,
    request,
  }) => {
    const org = await activeOrg(page);
    const rig = await leagueOfFour(request, "K2");
    await apiJson(request, `/api/v1/divisions/${rig.div.id}/start`, "POST");
    for (const id of rig.fixtureIds) await scoreFixture(request, id, 2, 1);
    const completed = await apiJson(request, `/api/v1/stages/${rig.leagueId}/complete`, "POST", {});
    expect(completed.status).toBe(200);
    const created = await apiJson<{ id: string }>(request, `/api/v1/divisions/${rig.div.id}/stages`, "POST", {
      seq: 2, kind: "knockout", name: "Finals", config: {},
      progression: { ...KNOCKOUT_FROM_LEAGUE, timing: "setup" },
    });
    expect(created.status).toBe(201);

    await page.goto(`/o/${org.slug}/c/${rig.comp.slug}`);
    const row = page.getByTestId("desk-ledger-row").filter({ hasText: "Cup" }).first();
    // The row itself is unchanged by THIS fix — pinned so a future change to
    // the masthead cannot "fix" the contradiction by breaking the row.
    //
    // M1 (fix round I, instance TWELVE) did change which red row this shape
    // raises: with the Finals bracket never generated, its draw is not
    // computable (`computeSeedProposal` 422s SEEDING_RULES_MISSING), so the
    // row is `needs_fixtures` and its action opens the fixtures tab, where
    // "Generate fixtures" and "Complete stage" both live. It is still RED and
    // it still names the stage, which is all K2's own assertion needs.
    await expect(row).toContainText("6 of 6 played");
    await expect(page.getByTestId("desk-needs-you")).toContainText("Finals");
    await expect(page.locator('[data-pill="needs_fixtures"]:visible').first()).toBeVisible();
    const masthead = page.getByTestId("desk-masthead-pill");
    await expect(masthead).not.toHaveAttribute("data-phase", "setting_up");
    await expect(masthead).not.toContainText("Setting up");
    await expect(masthead).toHaveAttribute("data-phase", "scheduled");
  });

  // Deliberately OUTSIDE the serial block below: serial mode SKIPS the rest of
// its describe after the first failure, so a sweep failure in there would
// take the two tests it is guarding down with it and report them as "did not
// run" — hiding the very symptom (a bucket fixture that cannot be built at
// this hour) that the sweep exists to explain. It needs no page, no request
// and no DB, so it has no reason to be serialised with them.
//
// The finders are pure and DB-free, so this costs no fixture and no page —
  // it is the guard for J1 itself. Round E pinned the zone PAIR, which made
  // the bucketing fixture constructible for only ~4.5 hours a day: the suite
  // was 9/10 for ~81% of the day and a green run inside the window was
  // reported as a fact about the suite. A test whose fixture can only be
  // built during part of the day is a scheduled outage, so the property
  // being pinned here is TOTALITY, not the fixture.
  //
  // An hour apart across a full year covers every hour of the clock and
  // every calendar date, DST transitions included — the two axes a
  // wall-clock-dependent fixture can hide behind. ~8s of pure CPU locally.
  /**
   * L3 (fix round H, Important): the ledger's RED-FIRST order had no test at
   * ANY layer. It lives in `o/[orgSlug]/c/[compSlug]/page.tsx`, an async
   * server component vitest cannot reach, and deleting the red clause left
   * 147/147 green because nothing asserted ROW ORDER. Load-bearing: driven at
   * 09:14Z on 2026-09-03, a red `setting_up` "Zulu" correctly sorted above a
   * `match_day` "Alpha".
   *
   * The two rows are built so that BOTH fallbacks point the other way:
   *   - alphabetically, "Alpha Cup" precedes "Zulu Cup";
   *   - by phase rank, Alpha's `scheduled` (1) precedes Zulu's `setting_up`
   *     (2).
   * Only the red clause can put Zulu first, so this is the one shape whose
   * expected value differs with and without it. (A `match_day` Alpha would
   * contrast even harder, but "is this fixture today?" is answered in the
   * VENUE zone — a dependency this assertion does not need.)
   */
  test("L3: a red row sorts above a clean one whose name AND phase both rank ahead of it", async ({
    page,
    request,
  }) => {
    const org = await activeOrg(page);
    const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
      name: `Desk Order ${TAG} ${Math.random().toString(36).slice(2, 6)}`, visibility: "public", ends_on: "2030-12-31",
    });
    expect(comp.status).toBe(201);
    const makeDivision = async (name: string) => {
      const div = await apiJson<{ id: string; slug: string }>(
        request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST",
        { name, sport_key: "generic", variant_key: "score", config: { points: { w: 3, d: 1, l: 0 }, progressScore: false } },
      );
      expect(div.status).toBe(201);
      await addEntrantsViaApi(request, div.data!.id, ["Seed1", "Seed2", "Seed3", "Seed4"]);
      const { stageId, fixtureIds } = await createStageAndGenerate(request, div.data!.id, { kind: "league", name: "League" });
      expect(fixtureIds.length).toBe(6);
      const started = await apiJson(request, `/api/v1/divisions/${div.data!.id}/start`, "POST");
      expect(started.status).toBeLessThan(400);
      return { div: div.data!, stageId, fixtureIds };
    };

    // Alpha: a perfectly ordinary league, every fixture dated in the future.
    // Nothing red, nothing overdue, nothing unscheduled — phase `scheduled`.
    const alpha = await makeDivision("Alpha Cup");
    const tomorrow = new Date(Date.now() + 24 * 3600_000).toISOString();
    for (const id of alpha.fixtureIds) await setFixtureScheduledAtSql(id, tomorrow);

    // Zulu: its league is played out and complete, and a `setup`-timing
    // Finals stage still owes its FIXTURES — red `needs_fixtures`, phase
    // `setting_up`. (It read `needs_draw` until M1, fix round I: with no
    // generated bracket the draw is not computable, so the row asks for the
    // step that is. Either way it is RED, which is what this test is about.)
    const zulu = await makeDivision("Zulu Cup");
    for (const id of zulu.fixtureIds) await setFixtureStatusSql(id, "decided");
    await setStageStatusSql(zulu.stageId, "complete");
    const finals = await apiJson<{ id: string }>(request, `/api/v1/divisions/${zulu.div.id}/stages`, "POST", {
      seq: 2, kind: "knockout", name: "Finals", config: {},
      progression: {
        sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
        placement: "rank_order",
        timing: "setup",
      },
    });
    expect(finals.status).toBe(201);

    await page.goto(`/o/${org.slug}/c/${comp.data!.slug}`);
    const rows = page.getByTestId("desk-ledger-row");
    await expect(rows).toHaveCount(2);
    // Print the asserted CONTENT beside the gate: without these the order
    // could be right for entirely the wrong reason (both rows red, both the
    // same phase, one row missing altogether).
    const alphaRow = rows.filter({ hasText: "Alpha Cup" });
    const zuluRow = rows.filter({ hasText: "Zulu Cup" });
    await expect(alphaRow).toHaveAttribute("data-phase", "scheduled");
    await expect(zuluRow).toHaveAttribute("data-phase", "setting_up");
    await expect(page.locator('[data-pill="needs_fixtures"]:visible').first()).toBeVisible();
    await expect(zuluRow.locator('[data-pill="needs_fixtures"]').first()).toHaveCount(1);
    await expect(alphaRow.locator("[data-pill]").first()).toHaveAttribute("data-pill", "scheduled");

    // THE ASSERTION: the red row is FIRST, against both its name and its
    // phase rank.
    await expect(rows.nth(0)).toContainText("Zulu Cup");
    await expect(rows.nth(1)).toContainText("Alpha Cup");
  });

  test("both zone-split finders work at every hour of the year, not just some", () => {
    test.setTimeout(180_000);
    const from = new Date();
    const to = new Date(from.getTime() + 366 * 24 * 3600_000);
    const swept = sweepZoneSplitFinders(from, to, 60);
    for (const [name, result] of Object.entries(swept)) {
      // Print the sample count beside the verdict: a sweep that silently
      // measured nothing would otherwise read exactly like a clean one.
      expect(result.samples, `${name} swept too few samples to mean anything`).toBeGreaterThan(8_000);
      expect(
        result.failures.slice(0, 5).map((f) => f.at),
        `${name}: ${result.failures.length}/${result.samples} samples could not build a fixture`,
      ).toEqual([]);
    }
  });

  // J1 (fix round F, Critical) — SERIALISED, and deliberately so.
  // `setZoneSplitSql` writes `organizations.timezone`, which is ORG-WIDE and
  // shared by every test in the run, and captures the previous value at call
  // time to put back in `finally`. With `fullyParallel: true`
  // (playwright.config.ts) the two tests below can interleave on the ONE
  // shared Pro org: A captures UTC and writes London, B captures LONDON (A's
  // value, not the real one) and writes Kolkata, A restores UTC, B restores
  // London — and the org is left permanently in a zone nobody chose. Serial
  // mode puts them in one worker, in order, so each one's capture is the
  // value it actually has to restore.
  //
  // Not sufficient on its own, and not claimed to be: `org-management.spec.ts`
  // ("scheduling timezone is searchable") and `registration-hub.spec.ts`
  // ("registration windows round-trip in the ORG timezone") write the same
  // column on the same shared org with the same capture-and-restore shape, and
  // nothing serialises THOSE against these. That is a pre-existing, file-
  // crossing hazard this round records rather than fixes.
  test.describe("zone splits", () => {
    test.describe.configure({ mode: "serial" });

    // Found by DRIVING the round-D fix, not by a suite — and no unit test can
    // guard it: the masthead label is computed in a server component, and
    // apps/web vitest is `environment: "node"`, so reverting the page to the
    // buggy zone leaves the desk unit suite 35/35 green.
    //
    // The masthead names ONE division's fixture. When that division sits in a
    // different zone from its org, formatting the label in the ORG zone prints
    // a different DAY from the row beneath it: a London org with a New York
    // division at 23:00Z read "Next Mon 7 Sep" above "Next Sun 6 Sep 19:00" —
    // the same match, two days, one screen.
    test("a division in another timezone: masthead and row name the SAME day", async ({ page, request }) => {
      const org = await activeOrg(page);
      const rig = await seed(request);
      // Which of the two zones is the org's and which the venue's is decided
      // at RUNTIME — see zone-split.ts. Reading them back off the result is
      // the whole J1 fix: pinning them here is what made this class of
      // fixture constructible only part of the day.
      const { at, orgTz, venueTz } = findPrintSplit(new Date());
      let restore: (() => Promise<void>) | undefined;
      try {
        restore = await setZoneSplitSql({
          divisionId: rig.divisionId,
          orgTz,
          divisionTz: venueTz,
          fixtureNo: 1,
          at: at.toISOString(),
        });

        await page.goto(`/o/${org.slug}/c/${rig.compSlug}`);
        const row = page.getByTestId("desk-ledger-row").filter({ hasText: "Premier" }).first();
        const venueDay = zoneDayLabel(at, venueTz);
        const orgDay = zoneDayLabel(at, orgTz);
        // Guard the guard: if the two zones named the same day the assertions
        // below would pass on any code at all.
        expect(venueDay, `zone split did not split: ${orgTz} vs ${venueTz} at ${at.toISOString()}`).not.toBe(orgDay);
        // The venue's day, in both places.
        await expect(row).toContainText(venueDay);
        await expect(row).not.toContainText(orgDay);
        const masthead = page.getByTestId("desk-masthead-pill");
        await expect(masthead).toContainText(venueDay);
        await expect(masthead).not.toContainText(orgDay);
      } finally {
        await restore?.();
      }
    });

    // H1 fix (final review round 3, Critical — corrected ruling): the print-
    // consistency test above only proves masthead and row agree on which day
    // they PRINT — it says nothing about which day BUCKETS the fixture into
    // `match_day` in the first place. Reproduced live before this fix (see
    // fix-round-e-report.md): a fixture genuinely dated TODAY at the venue
    // (Kolkata) read "Scheduled", never "Match day", because the phase was
    // bucketed in the ORG zone (London), which was still on the day before.
    test("match day is decided by the venue's calendar day, not the org's", async ({ page, request }) => {
      const org = await activeOrg(page);
      const rig = await seed(request);
      const { at, orgTz, venueTz } = findBucketSplit(new Date());
      let restore: (() => Promise<void>) | undefined;
      try {
        restore = await setZoneSplitSql({
          divisionId: rig.divisionId,
          orgTz,
          divisionTz: venueTz,
          fixtureNo: 1,
          at: at.toISOString(),
        });

        await page.goto(`/o/${org.slug}/c/${rig.compSlug}`);
        const row = page.getByTestId("desk-ledger-row").filter({ hasText: "Premier" }).first();
        // Bucketed in the VENUE zone (today at the venue) — reads match_day
        // even though this same instant is a different calendar day for the
        // org, which is the only reason this can tell the two zones apart.
        await expect(row).toHaveAttribute("data-phase", "match_day");
      } finally {
        await restore?.();
      }
    });
  });
});
