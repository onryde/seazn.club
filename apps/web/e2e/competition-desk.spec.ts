import { test, expect, type APIRequestContext } from "@playwright/test";
import {
  TAG,
  apiJson,
  activeOrg,
  addEntrantsViaApi,
  createStageAndGenerate,
  setFixtureStatusSql,
  setFixtureScheduledAtSql,
  setStageStatusSql, setZoneSplitSql } from "./helpers";

/** YYYY-MM-DD in a zone — matches division-phase.ts's own `localDateKey`. */
function zoneDateKey(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

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
 * sibling literal at :111 expired for exactly one day on 2026-09-20). Both
 * `findPrintSplitInstant` and `findBucketSplitInstant` below SEARCH forward
 * from `now` at 5/15-minute steps instead of hand-deriving an offset — this
 * also sidesteps DST, since whatever the real UTC offset is on the day the
 * suite runs, the loop finds an instant that actually exhibits the property
 * asked for, rather than assuming e.g. Europe/London is in BST.
 *
 * First future instant where org and venue format to DIFFERENT calendar days
 * for the SAME instant — the shape H1's printing fix (G2) needs (masthead
 * and row must still agree, both read in the venue zone).
 */
function findPrintSplitInstant(from: Date, orgTz: string, venueTz: string): Date {
  for (let mins = 15; mins <= 60 * 24 * 3; mins += 15) {
    const candidate = new Date(from.getTime() + mins * 60_000);
    if (zoneDateKey(candidate, orgTz) !== zoneDateKey(candidate, venueTz)) return candidate;
  }
  throw new Error("findPrintSplitInstant: no zone split found in a 3-day window");
}

/**
 * First instant that is STILL TODAY at the venue but a DIFFERENT day for the
 * org — the shape H1's bucketing fix needs: `match_day` must key off the
 * venue's calendar day, not the org's. Picking `at` equal to "now" itself
 * cannot discriminate (any instant trivially agrees with itself in every
 * zone), so this searches forward from `now` for a genuinely divergent one.
 */
function findBucketSplitInstant(from: Date, orgTz: string, venueTz: string): Date {
  const todayOrg = zoneDateKey(from, orgTz);
  const todayVenue = zoneDateKey(from, venueTz);
  for (let mins = 5; mins <= 60 * 24 * 2; mins += 5) {
    const candidate = new Date(from.getTime() + mins * 60_000);
    if (zoneDateKey(candidate, venueTz) === todayVenue && zoneDateKey(candidate, orgTz) !== todayOrg) {
      return candidate;
    }
  }
  throw new Error("findBucketSplitInstant: no zone split found in a 2-day window");
}

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

  // Found by DRIVING the round-D fix, not by a suite — and no unit test can
  // guard it: the masthead label is computed in a server component, and
  // apps/web vitest is `environment: "node"`, so reverting the page to the
  // buggy zone leaves the desk unit suite 35/35 green.
  //
  // The masthead names ONE division's fixture. When that division sits in a
  // different zone from its org, formatting the label in the ORG zone prints a
  // different DAY from the row beneath it: a London org with a New York
  // division at 23:00Z read "Next Mon 7 Sep" above "Next Sun 6 Sep 19:00" —
  // the same match, two days, one screen.
  test("a division in another timezone: masthead and row name the SAME day", async ({ page, request }) => {
    const org = await activeOrg(page);
    const rig = await seed(request);
    const orgTz = "Europe/London";
    const venueTz = "America/New_York";
    // Any instant where the two zones disagree on the calendar day — see
    // `findPrintSplitInstant`'s own doc comment for why this is searched
    // rather than a pinned literal.
    const at = findPrintSplitInstant(new Date(), orgTz, venueTz);
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
    const orgTz = "Europe/London";
    const venueTz = "Asia/Kolkata";
    const at = findBucketSplitInstant(new Date(), orgTz, venueTz);
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
      // Bucketed in the VENUE zone (today, Kolkata) — reads match_day even
      // though this same instant is a different calendar day for the org.
      await expect(row).toHaveAttribute("data-phase", "match_day");
    } finally {
      await restore?.();
    }
  });
});
