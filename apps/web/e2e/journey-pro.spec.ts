import { test, expect } from "@playwright/test";
import {
  TAG,
  apiJson,
  activeOrg,
  addEntrantsViaApi,
  createCompetitionViaUi,
  createDivisionViaUi,
  createStageAndGenerate,
  scoreFixture,
  scoreRemainingFixtures,
  divisionPath,
} from "./helpers";

// Full Pro lifecycle as one ordered story: create a competition through the
// wizard, add divisions (UI + API), enter entrants, generate fixtures, start,
// score to completion, then verify standings, the slideshow, and the public
// site. UI drives the moments that matter; the API seeds repetitive state
// (same split the other specs use).
test.describe.serial("pro lifecycle", () => {
  const PLAYERS = ["Ada", "Boole", "Curie", "Dirac", "Euler", "Fermi"];
  let competitionId: string;
  let competitionSlug: string;
  let uiDivisionId: string; // built through the tabbed builder (default sport)
  let divisionId: string; // generic/score division — scored + published below
  let divisionSlug: string;
  let stageId: string;
  let fixtureIds: string[] = [];
  let orgSlug: string;

  test("create a public competition via the wizard", async ({ page, request }) => {
    competitionId = await createCompetitionViaUi(page, `Pro Cup ${TAG}`, "public");
    await expect(page.getByRole("link", { name: /add division/i })).toBeVisible();
    const comp = await apiJson<{ slug: string }>(request, `/api/v1/competitions/${competitionId}`);
    competitionSlug = comp.data!.slug;
    expect(competitionSlug).toBeTruthy();
  });

  test("add two divisions — builder UI plus API (multi-division is Pro)", async ({
    page,
    request,
  }) => {
    uiDivisionId = await createDivisionViaUi(page, competitionId, "Premier");
    expect(uiDivisionId).toBeTruthy();

    const div = await apiJson<{ id: string; slug: string }>(
      request,
      `/api/v1/competitions/${competitionId}/divisions`,
      "POST",
      {
        name: "Open",
        sport_key: "generic",
        variant_key: "score",
        config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      },
    );
    // A 5th division would 402 on community (divisions.per_competition.max = 4).
    expect(div.status).toBe(201);
    divisionId = div.data!.id;
    divisionSlug = div.data!.slug;
  });

  test("add entrants — one through the panel, the rest via API", async ({ page, request }) => {
    await page.goto(await divisionPath(page.request, divisionId, "?tab=entrants"));
    // If other specs left teams in the shared org, the Add-entrant form
    // defaults to "Existing team" (and flips async once teams load, detaching
    // the fields) — pin it to the ad-hoc "New entrant" mode first.
    //
    // PROVE the pin stuck rather than clicking and hoping. The previous
    // `click().catch(() => undefined)` raced the very flip the comment above
    // describes: teams finish loading, the form switches back, and the fill
    // below lands on a detached field. It passed alone and failed 2 of 3
    // full-project runs — the shared org only has teams in it once earlier
    // specs have run. Retrying the toggle until the Name box is actually
    // there closes the race; only the PINNING is retried, never the add, so a
    // retry can never enter the same entrant twice.
    const modeToggle = page.getByRole("button", { name: "New entrant", exact: true });
    const nameBox = page.getByRole("textbox", { name: "Name", exact: true });
    await expect(async () => {
      if (await modeToggle.isVisible().catch(() => false)) {
        await modeToggle.click({ timeout: 3_000 }).catch(() => undefined);
      }
      await expect(nameBox).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000, intervals: [250, 500, 1_000, 2_000] });
    await nameBox.fill(PLAYERS[0]!);
    await page.getByRole("button", { name: "Add entrant", exact: true }).click();
    await expect(page.getByRole("cell", { name: PLAYERS[0]! })).toBeVisible({ timeout: 20_000 });

    const bulk = await addEntrantsViaApi(request, divisionId, PLAYERS.slice(1), "individual", 1);
    expect(bulk.status).toBeLessThan(300);
    await page.reload();
    for (const name of PLAYERS) {
      await expect(page.getByRole("cell", { name })).toBeVisible();
    }
  });

  test("generate round-robin fixtures", async ({ request }) => {
    const out = await createStageAndGenerate(request, divisionId);
    stageId = out.stageId;
    fixtureIds = out.fixtureIds;
    // 6 entrants, single round robin → 15 fixtures.
    expect(fixtureIds.length).toBe(15);

    // Competition Desk W2 (Task 4): the fixtures tab's run sheet gives an
    // UNSCHEDULED row exactly one action — "Set time" — never "Score"
    // (`fixtureRowAction`'s ladder, Task 2, already reviewed and approved).
    // This journey used to jump straight from "Start tournament" to a
    // "Score" link on a never-timed fixture; that entry point is retired by
    // design, so this now times every fixture first, the same way a real
    // organiser would have to. A future date (well past "today" in this
    // environment) keeps the action "Score" rather than "Assign scorer"
    // (rule 5 of the ladder: scheduled TODAY with no officials assigned).
    const base = Date.UTC(2026, 9, 12, 9, 0, 0); // 2026-10-12 09:00Z
    for (let i = 0; i < fixtureIds.length; i++) {
      const patched = await apiJson(request, `/api/v1/fixtures/${fixtureIds[i]!}`, "PATCH", {
        scheduled_at: new Date(base + i * 30 * 60_000).toISOString(),
      });
      expect(patched.status, `scheduling fixture ${i} failed: ${JSON.stringify(patched.error)}`).toBeLessThan(300);
    }
  });

  test("start the tournament from the division console", async ({ page, request }) => {
    // Publish the competition BEFORE starting, because `draft` is the one
    // status under which the promotion this test exists to cover cannot fire.
    // `createCompetition` never inserts `status` (usecases/competitions.ts),
    // so every competition this suite makes falls to the column default
    // 'draft', and `startDivision`'s `update competitions set status = 'live'
    // ... and status = 'published'` therefore matches no row. Without this
    // PATCH the `start-confirm-competition` assertion below is a test of an
    // absent line and the `live` poll at the end can never pass.
    // PATCH is the ONLY path that can set status: `CreateCompetition` declares
    // no `status` and zod STRIPS it, so a create sent one returns 201 draft
    // with no error (e2e/settings-support.ts's seedCompetition, note 2).
    const published = await apiJson<{ status: string }>(
      request,
      `/api/v1/competitions/${competitionId}`,
      "PATCH",
      { status: "published" },
    );
    expect(
      published.status,
      `publishing the competition failed: ${JSON.stringify(published.error)}`,
    ).toBe(200);
    // The PATCH's own row, not a re-read: a 200 that silently kept 'draft'
    // would leave every assertion below testing the wrong precondition.
    expect(published.data?.status, "the competition must actually be published").toBe("published");

    await page.goto(await divisionPath(page.request, divisionId));
    await page.getByRole("button", { name: "Start tournament" }).click();
    // Start now confirms first (design 2026-09-20) — the button opens a dialog
    // and POSTs nothing. The consequences the organiser is shown are asserted
    // here, not just the presence of a sheet: a dialog that renders an empty
    // body would still let this journey through.
    const confirm = page.getByTestId("start-confirm");
    await expect(confirm).toBeVisible({ timeout: 20_000 });
    await expect(confirm).toContainText("The timetable goes live to players now.");
    await expect(confirm.getByTestId("start-confirm-entrants")).toBeVisible();
    // The competition is published, so the promotion really happens and the
    // dialog owes the organiser that sentence. Its TEXT, not just its
    // presence: the line's whole job is naming which move is about to be made,
    // and `start-confirm-dialog.tsx` renders a consequence only when it is
    // true for this division.
    await expect(confirm.getByTestId("start-confirm-competition")).toHaveText(
      "The competition moves from published to live.",
    );
    // Published, so it is listed already: no still-a-draft note (the community
    // journey starts a public DRAFT and sees it — the other half of the pair).
    await expect(confirm.getByTestId("start-confirm-draft")).toHaveCount(0);
    await page.getByTestId("start-confirm-confirm").click();
    // Fixtures were pre-generated, so quick-start generates 0 and only
    // refreshes (no redirect). The button label flips to "Starting…" while the
    // POST is in flight, so poll the API for the real status change.
    await expect
      .poll(
        async () => {
          try {
            return (await apiJson<{ status: string }>(request, `/api/v1/divisions/${divisionId}`))
              .data?.status;
          } catch {
            return undefined; // transient dev-server hiccup — keep polling
          }
        },
        { timeout: 20_000 },
      )
      .toBe("active");
    // And the consequence the dialog promised, in the data: the parent
    // competition really moved published -> live. The promotion rides in
    // startDivision's own status transaction, so this is settled by the time
    // the division reads `active` — polled anyway, on the same terms as the
    // division read above, so a transient API hiccup is a retry not a red.
    await expect
      .poll(
        async () => {
          try {
            return (
              await apiJson<{ status: string }>(
                request,
                `/api/v1/competitions/${competitionId}`,
              )
            ).data?.status;
          } catch {
            return undefined;
          }
        },
        { timeout: 20_000 },
      )
      .toBe("live");
    await page.goto(await divisionPath(page.request, divisionId, "?tab=fixtures"));
    await expect(page.getByRole("link", { name: /^Score/ }).first()).toBeVisible({
      timeout: 20_000,
    });
  });

  test("score one fixture on the pad, the rest via API", async ({ page, request }) => {
    await page.goto(await divisionPath(page.request, divisionId, "?tab=fixtures"));
    await page.getByRole("link", { name: /^Score/ }).first().click();
    await page.waitForURL(/\/f\/\d+/, { timeout: 20_000 });
    // PROMPT-30: the URL carries the per-division ordinal — map back to the id.
    const padNo = Number(page.url().match(/\/f\/(\d+)/)![1]!);
    let padFixtureId = "";
    for (const id of fixtureIds) {
      const fx = await apiJson<{ fixture_no: number }>(request, `/api/v1/fixtures/${id}`);
      if (fx.data!.fixture_no === padNo) {
        padFixtureId = id;
        break;
      }
    }
    expect(padFixtureId).not.toBe("");
    // ScoringPad v3 (R7/A1 — `generic` moved onto `V3_SKINS`; the v2
    // universal renderer's own "Enter final score" ActionForm this test used
    // to drive no longer renders for this sport). The score-mode board's
    // `scoreEntry` TILE opens the skin's own guided sheet: two number steps,
    // each with its own Confirm, prefilled from the running tally (0-0 here).
    // No "Start match" tap first: generic.result tolerates phase "pre" as
    // well as "live" (generic.ts's own applyResult), so the tile is on screen
    // the moment the console renders.
    const pad = page.locator('[data-testid="score-pad"]');
    const scoreEntry = pad.locator('[data-tile-id="scoreEntry"]');
    await expect(scoreEntry).toBeVisible({ timeout: 20_000 });
    await scoreEntry.click();
    const sheet = pad.locator('[data-role="v3-sheet"]');
    await expect(sheet, "the score-entry tile must open the skin's own sheet").toBeVisible({ timeout: 20_000 });
    for (const value of ["3", "1"]) {
      await sheet.getByRole("spinbutton").fill(value);
      await sheet.getByRole("button", { name: "Confirm", exact: true }).click();
    }
    // v3 soft-commits: the result is HELD for queue.ts's HOLD_MS (6s) before
    // it is sent, so the status poll below — 20s — is what waits it out.
    // `generic.result` declares no dock (nothing to enrich on a terminal
    // card), so there is no flush control to press instead.
    // The result is decided when the API says so (UI copy churns during save).
    await expect
      .poll(
        async () =>
          (await apiJson<{ status: string }>(request, `/api/v1/fixtures/${padFixtureId}/state`))
            .data?.status,
        { timeout: 20_000 },
      )
      .toMatch(/decided|finalized/);

    await scoreRemainingFixtures(request, fixtureIds, new Set([padFixtureId]));
    // Every fixture is now decided.
    for (const id of fixtureIds.slice(0, 3)) {
      const state = await apiJson<{ status: string }>(request, `/api/v1/fixtures/${id}/state`);
      expect(["decided", "finalized"]).toContain(state.data!.status);
    }
  });

  test("complete the stage and verify the standings table", async ({ page, request }) => {
    const done = await apiJson(request, `/api/v1/stages/${stageId}/complete`, "POST");
    expect(done.status).toBeLessThan(300);

    await page.goto(await divisionPath(page.request, divisionId, "?tab=standings"));
    // A ranked table with every entrant present (names render as rowheaders).
    for (const name of PLAYERS) {
      await expect(page.getByRole("row", { name: new RegExp(`\\b${name}\\b`) }).first()).toBeVisible(
        { timeout: 20_000 },
      );
    }
  });

  test("slideshow renders the standings slide", async ({ page }) => {
    await page.goto(`/slideshow/divisions/${divisionId}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Open", {
      timeout: 20_000,
    });
    await expect(page.getByText(PLAYERS[0]!).first()).toBeVisible();
  });

  test("public site and public JSON expose the completed division", async ({
    page,
    request,
  }) => {
    orgSlug = (await activeOrg(page)).slug;

    // G9: the console division header deep-links to the public HUB with this
    // division already selected — `?tab=matches&division=<slug>`, not the
    // standalone division page it used to point at (that page is slated for a
    // 308 into the hub). The spellings are the hub's own: "matches" is a
    // `deriveHubTabs` id and `?division=` is what `readDivisionParam` reads.
    await page.goto(await divisionPath(page.request, divisionId));
    await expect(
      page.locator(
        `a[href="/shared/${orgSlug}/${competitionSlug}?tab=matches&division=${divisionSlug}"]`,
      ),
    ).toBeVisible({ timeout: 20_000 });

    // Public competition page lists the division.
    await page.goto(`/shared/${orgSlug}/${competitionSlug}`);
    await expect(page.getByText("Open").first()).toBeVisible({ timeout: 20_000 });

    // Division page defaults to the schedule tab — results show as links
    // ("Boole vs Ada 3 — 1"); the bare name also hides in a filter <option>,
    // so anchor on the visible fixture links, then the standings tab.
    await page.goto(`/shared/${orgSlug}/${competitionSlug}/${divisionSlug}`);
    await expect(
      page.getByRole("link", { name: new RegExp(`\\b${PLAYERS[0]!}\\b`) }).first(),
    ).toBeVisible({ timeout: 20_000 });
    await page.getByRole("tab", { name: "Standings" }).click();
    await expect(
      page.getByRole("row", { name: new RegExp(`\\b${PLAYERS[0]!}\\b`) }).first(),
    ).toBeVisible({ timeout: 20_000 });

    // Public JSON endpoints respond with non-empty payloads.
    const base = `/api/v1/public/orgs/${orgSlug}/competitions/${competitionSlug}/divisions/${divisionSlug}`;
    for (const leaf of ["entrants", "standings", "schedule"]) {
      const res = await apiJson<unknown[]>(request, `${base}/${leaf}`);
      expect(res.status, `${leaf} should be public`).toBe(200);
    }
  });

  test("a private competition is invisible on the public site", async ({ page, request }) => {
    const comp = await apiJson<{ id: string; slug: string }>(
      request,
      "/api/v1/competitions",
      "POST",
      { ends_on: "2030-12-31", name: `Secret ${TAG}`, visibility: "private" },
    );
    const res = await page.request.get(`/shared/${orgSlug}/${comp.data!.slug}`);
    expect(res.status()).toBe(404);
  });

  test("an unlisted competition is reachable by link but noindexed", async ({
    page,
    request,
  }) => {
    const comp = await apiJson<{ id: string; slug: string }>(
      request,
      "/api/v1/competitions",
      "POST",
      { ends_on: "2030-12-31", name: `Backdoor ${TAG}`, visibility: "unlisted" },
    );
    await page.goto(`/shared/${orgSlug}/${comp.data!.slug}`);
    await expect(page.getByRole("heading", { name: `Backdoor ${TAG}` })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  });

  test("timetable export is available on Pro", async ({ request }) => {
    const res = await request.get(`/api/v1/competitions/${competitionId}/exports/timetable`);
    expect(res.status()).toBe(200);
  });
});
