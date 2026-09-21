// RS012's whole pool journey, played BY HAND — a solo sign-up registers,
// waits, and is either placed onto a team or refunded when nobody places
// them in time; a visitor who arrives once the pool is already full is
// driven through the REAL public stepper, not asserted against a fixture.
//
// WHY THIS EXISTS, precisely, per this charter (see
// rs007-registration-journey.spec.ts's own header for the original case
// this pattern was built to catch): 3098+ unit tests are green for every
// piece of RS012 in isolation — soloPoolIsFull, poolPlaceByDate,
// fetchPoolSummary's SQL, the assign route — and NOT ONE of them has ever
// clicked the Registrants tab's pool banner, opened the assign sheet for a
// pooled solo sign-up, or watched a real visitor hit the pool-full 422
// through the actual wizard. The RS012 code review's own open finding is
// "nothing warns the visitor before they complete the whole wizard" — that
// claim has never been driven, only reasoned about. This file drives it.
//
// Setup uses the API (and, where the engine module registry would refuse a
// bespoke roster shape, direct SQL — see seedCustomTeamDivision below) to
// REACH a division whose derived pool bound is small and known. Every step
// that IS the journey under test — the organiser opening the banner,
// picking a team, the registrant reading their own status page, a visitor
// hitting the wizard's actual refusal screen — is driven through the UI.
import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { activeOrg, apiJson, expectNoHorizontalScroll, screenshotAtWidths, TAG } from "../helpers";

test.describe.configure({ mode: "serial" });

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

// ---------------------------------------------------------------------------
// One-shot SQL against the app's schema (helpers.ts keeps withDb private —
// same convention payments-hardening.spec.ts / registration-public-api.spec.ts
// / event-pass.spec.ts already use for exactly this reason).
// ---------------------------------------------------------------------------
async function withDb<T>(fn: (sql: import("postgres").Sql) => Promise<T>): Promise<T> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL required for direct DB setup in e2e");
  const { default: postgres } = await import("postgres");
  const sql = postgres(dbUrl, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl:
      process.env.DATABASE_SSL === "disable"
        ? false
        : /@(localhost|127\.0\.0\.1)[:/]/.test(dbUrl)
          ? false
          : "require",
    prepare: !dbUrl.includes(":6543"),
    max: 1,
  });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

/**
 * Every sport key this file has put into the catalog, so the hook below can
 * take them away again.
 *
 * `sports` is not a test scratch table: `/onboarding` lists every row in it, so
 * a key left behind becomes a tile on a real account's welcome screen for as
 * long as that database lives. The keys minted here are `rs012-pool-<random>` —
 * a FRESH one per run — so a literal cleanup could not work even if someone
 * wrote one, and the leak is invisible to every assertion in this file. Same
 * registry shape as `src/server/usecases/__tests__/registration-submit.test.ts`,
 * for the same reason: the next site that mints is cleaned up by construction
 * rather than by remembering.
 */
const MINTED_SPORT_KEYS = new Set<string>();

/** Record a sport key this file inserted, so `afterAll` can remove it. */
function mintedSport(key: string): string {
  MINTED_SPORT_KEYS.add(key);
  return key;
}

test.afterAll(async () => {
  if (MINTED_SPORT_KEYS.size === 0) return;
  const keys = [...MINTED_SPORT_KEYS];
  await withDb(async (sql) => {
    // Order is part of the fix. All three children of `sports` are NO ACTION
    // (`divisions`, `player_profiles`, `sport_variants`), so the catalog row
    // cannot go while any of them still points at it. Everything hanging off a
    // division — entrants, registrations, settings, stages — cascades with it.
    await sql`delete from divisions where sport_key in ${sql(keys)}`;
    await sql`delete from player_profiles where sport_key in ${sql(keys)}`;
    await sql`delete from sport_variants where sport_key in ${sql(keys)}`;
    await sql`delete from sports where key in ${sql(keys)}`;
  });
  MINTED_SPORT_KEYS.clear();
});

/**
 * A TEAM division backed by a fresh, test-only sport whose roster shape
 * (lineup size + bench) is small and KNOWN — the shared `generic` sport's
 * roster_cap of 1 is too tight to hold a captain+mate team at all, and this
 * spec needs a division whose DERIVED pool bound (capacity × roster_cap −
 * seated, RS012 ruling 1) is small enough to fill deliberately.
 *
 * `createDivision` (the real API) resolves `sport_key` against the engine's
 * fixed module registry and refuses an unregistered key, so the `sports` +
 * `divisions` rows go in via raw SQL — the same bypass
 * fetch-pool-summary.test.ts's own `seedCustomTeamDivision` uses (see
 * .claude/agent-memory/implementer/reference_custom_sport_key_needs_direct_division_insert.md).
 * `registration_settings` is written through the REAL PUT API afterward:
 * `putRegistrationSettings` never touches the sport module, so nothing here
 * needs to be faked for it — the settings save is genuinely real.
 */
async function seedCustomTeamDivision(
  request: APIRequestContext,
  competitionId: string,
  opts: {
    lineupSize: number;
    benchMax: number;
    capacity: number;
    placeByAt?: string | null;
  },
): Promise<{ id: string; name: string }> {
  const suffix = randomBytes(4).toString("hex");
  const sportKey = mintedSport(`rs012-pool-${suffix}`);
  const name = `RS012 Pool Division ${suffix}`;
  const divisionId = await withDb(async (sql) => {
    await sql`
      insert into sports (key, name, module_version, position_catalog)
      values (${sportKey}, 'RS012 Pool Test Sport', '1.0.0',
        ${sql.json({ groups: [], lineup: { size: opts.lineupSize, benchMax: opts.benchMax } })})`;
    const [row] = await sql<{ id: string }[]>`
      insert into divisions
        (competition_id, name, slug, sport_key, variant_key, config, module_version, tiebreakers, youth)
      values (${competitionId}, ${name}, ${`rs012-pool-div-${suffix}`}, ${sportKey}, 'std',
        ${sql.json(GENERIC_CONFIG)}, '1.0.0', null, false)
      returning id`;
    if (!row) throw new Error("seedCustomTeamDivision: division insert failed");
    return row.id;
  });
  const settings = await apiJson(request, `/api/v1/divisions/${divisionId}/registration-settings`, "PUT", {
    enabled: true,
    entrant_kind: "team",
    capacity: opts.capacity,
    fee_cents: 0,
    form_fields: [],
    allow_free_agents: true,
    place_by_at: opts.placeByAt ?? null,
  });
  if (settings.status >= 300) {
    throw new Error(
      `seedCustomTeamDivision: registration-settings PUT -> ${settings.status} ${JSON.stringify(settings.error)}`,
    );
  }
  return { id: divisionId, name };
}

interface SubmitResult {
  group_id: string;
  access_token: string;
  entries: { join_code: string | null }[];
}

function statusUrl(orgSlug: string, compSlug: string, res: SubmitResult): string {
  return `/shared/${orgSlug}/${compSlug}/register/status?rid=${res.group_id}&token=${res.access_token}`;
}

test("a pooled solo sign-up is placed through the real Registrants-tab banner and assign sheet, and reads their own status page as assigned, never waiting", async ({
  page,
  request,
  browser,
}, testInfo) => {
  test.setTimeout(120_000);
  const shot = async (p: import("@playwright/test").Page, name: string) => {
    await p.screenshot({ path: `${testInfo.outputPath()}/${name}.png`, fullPage: true });
  };
  const suffix = randomBytes(4).toString("hex");

  // ---------------------------------------------------------------- setup
  const org = await activeOrg(page);
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    name: `RS012 Pool Cup A ${TAG}-${suffix}`,
    visibility: "public",
    ends_on: "2030-12-31",
  });
  expect(comp.status, "could not create the competition this test needs").toBeLessThan(300);
  const compId = comp.data!.id;
  const compSlug = comp.data!.slug;

  // lineup size 2 + bench 1 -> roster_cap 3, capacity 5 -> a generous bound.
  // This test is about the assign/status LOOP, not the bound itself (the
  // OTHER test below fills the bound deliberately) — the derived bound just
  // needs to be big enough that one team + one solo sign-up never trips it.
  const div = await seedCustomTeamDivision(request, compId, { lineupSize: 2, benchMax: 1, capacity: 5 });

  // A real team, so the assign sheet has somewhere to place the solo
  // sign-up. Submitted through the API (reach, not the thing under test —
  // the ENTRY journey itself is rs007's charter).
  const teamName = `RS012 Team A ${suffix}`;
  const team = await apiJson<SubmitResult>(request, `/api/v1/public/orgs/${org.slug}/competitions/${compSlug}/register`, "POST", {
    contact: { name: `RS012 Captain A ${suffix}`, email: `delivered+rs012-captain-a-${suffix}@resend.dev` },
    privacy_consent: true,
    entries: [
      {
        division_id: div.id,
        entrant_kind: "team",
        team_name: teamName,
        players: [{ full_name: `RS012 Captain A ${suffix}` }, { full_name: `RS012 Mate A ${suffix}` }],
        answers: {},
      },
    ],
  });
  expect(team.status, "the team entry this test needs to assign onto failed to submit").toBeLessThan(300);

  // The solo sign-up under test — one real person, waiting.
  const soloName = `RS012 Solo A ${suffix}`;
  const solo = await apiJson<SubmitResult>(request, `/api/v1/public/orgs/${org.slug}/competitions/${compSlug}/register`, "POST", {
    contact: { name: soloName, email: `delivered+rs012-solo-a-${suffix}@resend.dev` },
    privacy_consent: true,
    entries: [
      {
        division_id: div.id,
        entrant_kind: "team",
        free_agent: true,
        players: [{ full_name: soloName }],
        answers: {},
      },
    ],
  });
  expect(solo.status, "the pooled solo sign-up this test assigns failed to submit").toBeLessThan(300);
  const soloStatusPath = statusUrl(org.slug, compSlug, solo.data!);

  // -------------------------------------------------- ORGANISER: the hub
  // `page` is already authenticated as the Pro owner via storageState — no
  // loginUi needed for the org side, exactly like rs007's captain steps use
  // the anon context directly rather than logging in.
  await page.goto(`/o/${org.slug}/c/${compSlug}/registration?tab=registrants`, { waitUntil: "load" });

  const banner = page.locator("[data-registration-hub-pool-summary]");
  await expect(banner, "the pool summary banner must render for a pooled solo sign-up").toBeVisible({
    timeout: 20_000,
  });
  await shot(page, "01-pool-banner");
  await screenshotAtWidths(page, testInfo, "01-pool-banner");
  await expectNoHorizontalScroll(page);

  // Click THROUGH the banner's own row link — never build the URL by hand
  // (the same "read the real anchor, don't construct it" rule rs007's claim
  // link exists to enforce). It must land pre-filtered to this division with
  // free_agent checked.
  const bannerRow = banner.locator("a").first();
  await expect(bannerRow, "the banner renders no row link to click through").toBeVisible();
  await bannerRow.click();
  await page.waitForURL((u) => u.searchParams.get("division_id") === div.id && u.searchParams.get("free_agent") === "1", {
    timeout: 15_000,
  });

  const row = page.locator("details").filter({ hasText: soloName }).first();
  await expect(row, "the pre-filtered table must list the pooled solo sign-up").toBeVisible({ timeout: 15_000 });
  await row.locator("summary").click();

  const opener = row.locator('[data-registration-hub-assign-action="open"]');
  await expect(opener, "a pooled solo sign-up must offer the assign control").toBeVisible({ timeout: 15_000 });
  await opener.click();

  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  const targetButton = page.locator("[data-registration-hub-assign-target]").first();
  await expect(targetButton, "the assign sheet lists no target team").toBeVisible({ timeout: 15_000 });
  await shot(page, "02-assign-sheet");
  await targetButton.click();
  await expect(sheet, "the assign sheet should close once the placement succeeds").toBeHidden({ timeout: 15_000 });

  // ------------------------------------------------- REGISTRANT: status
  const anonCtx = await browser.newContext();
  try {
    const anon = await anonCtx.newPage();
    await anon.goto(soloStatusPath, { waitUntil: "load" });
    await expect(
      anon.getByText(new RegExp(`Assigned to ${teamName}`)),
      "the placed solo sign-up must see which team they were assigned to",
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      anon.getByText(/waiting for a team/i),
      "an ASSIGNED entry must never still say it is waiting",
    ).not.toBeVisible();
    await expect(
      anon.getByText(/automatically refunded/i),
      "an ASSIGNED entry must never still carry the pool deadline notice",
    ).not.toBeVisible();
    await shot(anon, "03-status-assigned");
    await screenshotAtWidths(anon, testInfo, "03-status-assigned");
    await expectNoHorizontalScroll(anon);
  } finally {
    await anonCtx.close();
  }
});

test("an unplaced solo sign-up sees its own deadline, is auto-withdrawn once it passes, and a visitor who arrives once the pool is full is refused through the real public stepper", async ({
  page,
  request,
  browser,
}, testInfo) => {
  test.setTimeout(120_000);
  const shot = async (p: import("@playwright/test").Page, name: string) => {
    await p.screenshot({ path: `${testInfo.outputPath()}/${name}.png`, fullPage: true });
  };
  const suffix = randomBytes(4).toString("hex");

  const org = await activeOrg(page);
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    name: `RS012 Pool Cup B ${TAG}-${suffix}`,
    visibility: "public",
    ends_on: "2030-12-31",
  });
  expect(comp.status).toBeLessThan(300);
  const compId = comp.data!.id;
  const compSlug = comp.data!.slug;

  // roster_cap 1 (lineup size 1, bench 0), capacity 1 -> derived pool bound
  // (capacity x roster_cap - seated) is EXACTLY 1 with no teams registered:
  // this is RS012 ruling 1's own bound, deliberately made reachable rather
  // than left an unverified formula. place_by_at is already in the PAST —
  // a real organiser who set a date and then forgot about it, the exact
  // "common failure" the owner's ruling 2 reasoning names.
  const PAST_DEADLINE = "2020-03-15T00:00:00.000Z";
  const div = await seedCustomTeamDivision(request, compId, {
    lineupSize: 1,
    benchMax: 0,
    capacity: 1,
    placeByAt: PAST_DEADLINE,
  });

  const registerUrl = `/shared/${org.slug}/${compSlug}/register`;

  // Solo sign-up #1 — fills the pool bound to exactly 1/1.
  const solo1Name = `RS012 Solo B1 ${suffix}`;
  const solo1 = await apiJson<SubmitResult>(request, `/api/v1/public/orgs/${org.slug}/competitions/${compSlug}/register`, "POST", {
    contact: { name: solo1Name, email: `delivered+rs012-solo-b1-${suffix}@resend.dev` },
    privacy_consent: true,
    entries: [
      {
        division_id: div.id,
        entrant_kind: "team",
        free_agent: true,
        players: [{ full_name: solo1Name }],
        answers: {},
      },
    ],
  });
  expect(solo1.status, "the first pooled solo sign-up failed to submit").toBeLessThan(300);
  const solo1StatusPath = statusUrl(org.slug, compSlug, solo1.data!);

  // ------------------------------------------- REGISTRANT: waiting, pre-sweep
  const anon1Ctx = await browser.newContext();
  let refusalAlertText = "";
  let statusAfterSweepText = "";
  try {
    const anon1 = await anon1Ctx.newPage();
    await anon1.goto(solo1StatusPath, { waitUntil: "load" });
    await expect(
      anon1.getByText(/waiting for a team/i),
      "an unplaced solo sign-up must say it is waiting",
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      anon1.getByText(/automatically refunded/i),
      "an unplaced solo sign-up with a place-by date must see the deadline notice",
    ).toBeVisible();
    await shot(anon1, "04-status-waiting-past-deadline");
    await screenshotAtWidths(anon1, testInfo, "04-status-waiting-past-deadline");
    await expectNoHorizontalScroll(anon1);

    // ---------------------------------------------------------------
    // THE PUBLIC POOL-FULL REFUSAL — the case this whole dispatch exists
    // to cover. The bound is 1/1 right now (solo1 is still pooled, not yet
    // swept), so a SECOND visitor driven through the REAL stepper must be
    // refused. Deliberately BEFORE the sweep below: the sweep would
    // withdraw solo1 and free the very slot this refusal depends on.
    // ---------------------------------------------------------------
    const anon2Ctx = await browser.newContext();
    try {
      const anon2 = await anon2Ctx.newPage();
      const pageErrors: string[] = [];
      anon2.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));

      await anon2.goto(registerUrl, { waitUntil: "load" });
      await anon2.getByRole("button", { name: /^accept$/i }).click({ timeout: 3000 }).catch(() => {});

      // step 1: WHO — no "I'm playing" tick, so no DOB is required.
      await anon2.locator("#reg-who-name").fill(`RS012 Solo B2 ${suffix}`);
      await anon2.locator("#reg-who-email").fill(`delivered+rs012-solo-b2-${suffix}@resend.dev`);
      await shot(anon2, "05-pool-full-who");
      await anon2.getByRole("button", { name: /^next$/i }).click();

      // step 2: ENTRIES — "Sign up solo" is the only affordance a real
      // visitor has for a free-agent entry; never construct the cart state
      // by hand.
      await anon2.getByRole("button", { name: /sign up solo/i }).click();
      await shot(anon2, "06-pool-full-entries");
      await anon2.getByRole("button", { name: /^next$/i }).click();

      // step 3: DETAILS — a free-agent entry has nothing to fill in
      // (entryDetailsComplete is unconditionally true for one), so this
      // step is a single read-only note and Next.
      await anon2.getByRole("button", { name: /^next$/i }).click();

      // step 4: CONSENT
      await anon2.locator("#reg-consent-privacy").check();
      await anon2.getByRole("button", { name: /^next$/i }).click();

      // step 5: REVIEW — submit, and watch the REAL response land.
      await shot(anon2, "07-pool-full-review");
      const [submitResponse] = await Promise.all([
        anon2.waitForResponse((r) => r.url().includes("/register") && r.request().method() === "POST"),
        anon2.getByRole("button", { name: /^enter\b/i }).last().click(),
      ]);
      expect(
        submitResponse.status(),
        "a second solo sign-up against a full pool must be REFUSED, not accepted",
      ).toBeGreaterThanOrEqual(400);

      // Two role="alert" elements exist on this page: the submit error AND
      // Next's own route announcer (#__next-route-announcer__, present on
      // every page, empty). Filter to the one carrying real text.
      const alert = anon2.getByRole("alert").filter({ hasText: /.+/ });
      await expect(alert, "the wizard must show SOMETHING when a submission is refused, not go silent").toBeVisible({
        timeout: 15_000,
      });
      refusalAlertText = (await alert.textContent())?.trim() ?? "";
      await shot(anon2, "08-pool-full-refusal");
      await screenshotAtWidths(anon2, testInfo, "08-pool-full-refusal");
      await expectNoHorizontalScroll(anon2);

      expect(pageErrors, `the pool-full attempt logged uncaught page errors: ${pageErrors.join(" | ")}`).toEqual([]);
    } finally {
      await anon2Ctx.close();
    }

    // ------------------------------------------------------- THE SWEEP
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret) {
      throw new Error(
        "CRON_SECRET env var required to drive /api/cron/registrations in this test " +
          "(export the same value the server under test was started with)",
      );
    }
    const sweep = await request.fetch("/api/cron/registrations", {
      method: "POST",
      headers: { "x-cron-secret": cronSecret },
    });
    expect(sweep.status(), "the registrations sweep call itself failed").toBeLessThan(300);
    const sweepBody = (await sweep.json()) as { data?: { poolDeadlinePassed?: number } };
    expect(
      sweepBody.data?.poolDeadlinePassed ?? 0,
      "the sweep ran but reports withdrawing nobody — solo1's past deadline should have been caught",
    ).toBeGreaterThan(0);

    // -------------------------------------------- REGISTRANT: post-sweep
    await anon1.goto(solo1StatusPath, { waitUntil: "load" });
    await expect(
      anon1.getByText("withdrawn", { exact: false }),
      "the auto-refunded entry must show a withdrawn status badge",
    ).toBeVisible({ timeout: 20_000 });
    // `.innerText()`, NEVER `.textContent()`: Next's RSC hydration payload
    // embeds the WHOLE i18n dictionary as JSON inside a <script> tag on
    // every page (self.__next_f.push(...)), and `.textContent()` walks
    // script contents too — it found "Waiting for a team" as a translation
    // STRING living in that JSON blob even once the fix correctly stopped
    // rendering it, a false positive this session caught by re-running the
    // walkthrough headed rather than trusting the assertion on paper.
    // `.innerText()` reflects only rendered, visible text.
    statusAfterSweepText = (await anon1.locator("body").innerText()).replace(/\s+/g, " ").trim();
    await shot(anon1, "09-status-withdrawn-post-sweep");
    await screenshotAtWidths(anon1, testInfo, "09-status-withdrawn-post-sweep");
    await expectNoHorizontalScroll(anon1);
  } finally {
    await anon1Ctx.close();
  }

  // Surfaced in the test report (not asserted — this is the observational
  // half of the dispatch: describe what a real visitor/registrant sees,
  // never assert a UX opinion as a pass/fail gate).
  console.log(`[RS012] pool-full refusal alert text: ${JSON.stringify(refusalAlertText)}`);

  // This ONE line is a real gate, not an observation: this walkthrough is
  // what first caught the withdrawn-entry defect (the card showed the
  // WITHDRAWN badge right next to "Waiting for a team" and an already-past
  // refund date — awaitingTeamAssignment/poolPlaceByDate, view-model.ts,
  // gated on free_agent+assigned_team_name alone, never on status). Fixed
  // by requiring the entry not be in a terminal status. Asserted here, live
  // through the real product, on top of the unit regression coverage in
  // view-model.test.ts — the walkthrough that found the bug is the
  // walkthrough that proves it stays fixed.
  expect(
    /waiting for a team/i.test(statusAfterSweepText),
    `status page after sweep still says "waiting for a team": ${statusAfterSweepText}`,
  ).toBe(false);
});
