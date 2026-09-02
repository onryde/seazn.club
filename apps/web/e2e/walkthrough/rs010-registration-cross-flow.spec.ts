// RS010 closeout — the whole registration programme (RS001-RS012, twelve
// sessions, 2026-08-17 to 2026-08-31) driven as ONE continuous journey for
// the first time, looking for places where two individually-correct screens
// DISAGREE about what happened.
//
// WHY THIS EXISTS. Every prior RS wave shipped behind its own isolated e2e
// spec, each proving its own slice green. Nobody has ever run configure ->
// public register -> a teammate's own join -> a capacity waitlist -> an
// organiser's approve -> a registrant's own opt-out as one unbroken flow and
// then read the SAME fact off several screens: the public standings, the
// organiser-only Registrants tab, and the CSV export. A unit test cannot see
// this class of defect — each screen's own query can be independently
// correct and still print a different answer than its sibling, because the
// contradiction lives in the GAP between them, not inside either one.
//
// The one deliberately awkward move in this file, same charter as
// rs007-registration-journey.spec.ts's own header: the teammate's join link
// is READ off the status page's own anchor and followed by a SECOND browser
// context, never constructed by hand — a link that renders but 404s is
// exactly the shape of defect a constructed URL cannot catch.
//
// Setup (competition/division, the hub Settings-tab capacity, the public
// register/join steps, the waitlisting overflow entry) all go through the
// REAL UI, per the walkthrough charter — the only exception is a one-shot SQL
// read to resolve the joined teammate's `registration_players.id` so a claim
// invite can be minted for them (mintClaimPathForPlayerRow, helpers.ts), the
// same "no UI exposes this id" carve-out rs011/rs012's own audit-trail reads
// already take. Everything downstream of that id — logging in, claiming,
// toggling the /me consent control — is a real tap through the real UI.
import { expect, test } from "@playwright/test";
import {
  activeOrg,
  apiJson,
  expectNoHorizontalScroll,
  loginUi,
  mintClaimPathForPlayerRow,
  screenshotAtWidths,
  TAG,
} from "../helpers";

const GENERIC_CONFIG = { points: { w: 3, d: 1, l: 0 }, progressScore: false };

test.describe.configure({ mode: "serial" });

/** One-shot SQL against the app's schema — same local convention
 *  rs012-solo-signup-pool.spec.ts uses (helpers.ts keeps its own `withDb`
 *  private, and every walkthrough that needs a state no API/UI exposes
 *  re-declares this tiny client rather than widening the shared one). */
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
 * The joined teammate's own `registration_players.id` — needed to mint a
 * claim invite (mintClaimPathForPlayerRow) for the opt-out step. No UI or API
 * surface returns this id for a specific named player row, so it is read
 * directly, matching by the EXACT string the join form submitted (full_name
 * is never overwritten by a claim — registration-submit.ts's own comment on
 * that UPDATE — so this is safe to match on).
 */
async function registrationPlayerIdByName(registrationId: string, fullName: string): Promise<string> {
  return withDb(async (sql) => {
    const rows = await sql<{ id: string }[]>`
      select id from registration_players
      where registration_id = ${registrationId} and full_name = ${fullName}
      order by created_at desc limit 1`;
    if (!rows[0]) {
      throw new Error(`no registration_players row named "${fullName}" on registration ${registrationId}`);
    }
    return rows[0].id;
  });
}

/** maskOne's own "first token + last token's first initial" rule
 *  (lib/name-display.ts) — a 2-token name masks predictably: "Mate abc123"
 *  -> "Mate a.". Reused here rather than re-deriving so the expectation
 *  moves with the source of truth if that rule ever changes shape. */
function expectedMask(name: string): string {
  const parts = name.trim().split(/\s+/);
  return `${parts[0]} ${parts[parts.length - 1]![0]}.`;
}

test("configure, register, join, waitlist, approve, opt-out — every screen agrees on who's in", async ({
  page,
  request,
  browser,
}, testInfo) => {
  test.setTimeout(240_000);
  const shot = async (p: import("@playwright/test").Page, name: string) => {
    await p.screenshot({ path: `${testInfo.outputPath()}/${name}.png`, fullPage: true });
  };

  const captainName = `Captain ${TAG}`;
  const captainEmail = `xflow-captain-${TAG}@example.com`;
  const mateName = `Mate ${TAG}`;
  const mateEmail = `xflow-mate-${TAG}@example.com`;
  const teamName = `Cross Flow Team ${TAG}`;
  const overflowCaptainName = `Overflow ${TAG}`;
  const overflowEmail = `xflow-overflow-${TAG}@example.com`;
  const overflowTeamName = `Cross Flow Overflow ${TAG}`;
  const mateMasked = expectedMask(mateName);

  // =================================================================== 1
  // CONFIGURE — a competition + TEAM division (API, setup), registration
  // opened with capacity 1 through the REAL hub Settings-tab UI.
  // ===================================================================
  const org = await activeOrg(page);
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    name: `Cross Flow Cup ${TAG}`,
    visibility: "public",
    ends_on: "2030-12-31",
  });
  expect(comp.status, "could not create the competition this walkthrough needs").toBeLessThan(300);
  const compId = comp.data!.id;
  const compSlug = comp.data!.slug;

  const div = await apiJson<{ id: string; slug: string }>(
    request,
    `/api/v1/competitions/${compId}/divisions`,
    "POST",
    { name: "Cross Flow Division", sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG },
  );
  expect(div.status, "could not create the division this walkthrough needs").toBeLessThan(300);
  const divisionId = div.data!.id;
  const divisionSlug = div.data!.slug;

  await page.goto(`/o/${org.slug}/c/${compSlug}/registration?tab=settings`, { waitUntil: "load" });
  const divRow = page.locator(`[data-registration-hub-row][data-division-id="${divisionId}"]`);
  await expect(divRow, "the Settings tab never rendered a row for this division").toBeVisible({ timeout: 15_000 });
  await divRow.locator("[data-registration-hub-row-configure]").click();

  const configPanel = page.locator("[data-registration-hub-config-panel]");
  await expect(configPanel, "the row-click config panel never opened").toBeVisible({ timeout: 10_000 });
  // Every field below lives in a section that defaults OPEN (Eligibility,
  // Open & close, Capacity) — no disclosure needs expanding first.
  await configPanel.locator('select[data-field="entrant_kind"]').selectOption("team");
  await configPanel.locator('input[data-field="enabled"]').check();
  // Manual approval — so the organiser's own "approve" tap (step 5) is a
  // real transition this test drives, not a no-op on an already-confirmed
  // entry.
  await configPanel.locator('select[data-field="approval"]').selectOption("manual");
  await configPanel.locator('input[data-field="capacity"]').fill("1");
  await screenshotAtWidths(page, testInfo, "01-settings-configured");
  await expectNoHorizontalScroll(page);
  await page.locator('[data-action="save"]').click();
  await expect(configPanel, "saving the config panel never closed it").toBeHidden({ timeout: 10_000 });
  await expect(
    divRow.locator('[data-registration-hub-status="open"]'),
    "the division row must read OPEN once registration is enabled with no window set",
  ).toBeVisible({ timeout: 15_000 });

  const registerUrl = `/shared/${org.slug}/${compSlug}/register`;

  /** One full public-stepper team submission, ending on the status page.
   *  Shared by the captain (step 2) and the overflow captain (step 4) — the
   *  only real UI difference between them is the names and whether a second
   *  (unclaimed) roster row is entered. */
  async function submitTeamEntry(
    anon: import("@playwright/test").Page,
    opts: { name: string; email: string; team: string; extraRosterName?: string },
  ): Promise<string> {
    await anon.goto(registerUrl, { waitUntil: "load" });
    await anon.getByRole("button", { name: /^accept$/i }).click({ timeout: 3000 }).catch(() => {});

    // step 1: WHO
    await anon.locator("#reg-who-name").fill(opts.name);
    await anon.locator("#reg-who-email").fill(opts.email);
    await anon.getByRole("checkbox").first().check().catch(() => {});
    await anon.locator("#reg-who-dob").fill("1990-04-12").catch(() => {});
    await anon.getByRole("button", { name: /^next$/i }).click();

    // step 2: ENTRIES
    await anon.getByRole("button", { name: /add a team/i }).click();
    await anon.getByLabel(/team name/i).first().fill(opts.team);
    await anon.getByRole("button", { name: /^next$/i }).click();

    // step 3: DETAILS — the captain, real and complete; an optional second,
    // named-but-not-yet-claimed row (RS007's own "captain enters on behalf
    // of a team-mate" shape — 1 of N roster rows genuinely complete at
    // submit, the rest pending until the person themselves confirms it).
    const roster = opts.extraRosterName ? [opts.name, opts.extraRosterName] : [opts.name];
    for (const name of roster) {
      await anon.getByRole("button", { name: /\+ add player/i }).click();
      const boxes = anon.getByLabel(/Player \d+ — Your name/);
      await boxes.nth((await boxes.count()) - 1).fill(name);
    }
    await anon.locator('select[id^="reg-self-index"]').first().selectOption({ label: opts.name });
    await anon.getByRole("button", { name: /^next$/i }).click();

    // step 4: CONSENT
    await anon.locator("#reg-consent-privacy").check();
    await anon.getByRole("button", { name: /^next$/i }).click();

    // step 5: REVIEW -> submit
    const [submitResponse] = await Promise.all([
      anon.waitForResponse((r) => r.url().includes("/register") && r.request().method() === "POST"),
      anon.getByRole("button", { name: /^enter\b/i }).last().click(),
    ]);
    expect(submitResponse.status(), `${opts.team}'s submission was refused outright`).toBeLessThan(300);

    await anon.waitForURL(/\/register\/status\?/, { timeout: 30_000 });
    return anon.url();
  }

  // =================================================================== 2
  // REGISTER — a captain, anonymous, real public stepper. 1 of 2 roster
  // rows genuinely complete (the captain's own); the second names the
  // team-mate but stays pending until claimed in step 3.
  // ===================================================================
  const anonA = await browser.newContext();
  const anonB = await browser.newContext();
  const anonC = await browser.newContext();
  let mate2Ctx: import("@playwright/test").BrowserContext | undefined;

  try {
    const captainPage = await anonA.newPage();
    const captainErrors: string[] = [];
    captainPage.on("pageerror", (e) => captainErrors.push(String(e).slice(0, 200)));

    await submitTeamEntry(captainPage, {
      name: captainName,
      email: captainEmail,
      team: teamName,
      extraRosterName: mateName,
    });
    await expect(captainPage.getByText(teamName).first()).toBeVisible();
    await shot(captainPage, "02-status-captain");
    await screenshotAtWidths(captainPage, testInfo, "02-status-captain");
    await expectNoHorizontalScroll(captainPage);

    // ============================================================= 3
    // JOIN — a SECOND anonymous context, following the exact link the
    // status page emits (never constructed), the mate claiming their own
    // named row through the real /register/join UI.
    // =============================================================
    const claim = captainPage.locator('a[href*="/register/join"]').first();
    await expect(claim, "the status page emits no claim link for the pending team-mate row").toBeVisible();
    const claimHref = await claim.getAttribute("href");
    expect(claimHref, "the claim link carries no join_code").toContain("join_code=");

    const matePage = await anonB.newPage();
    const joinResp = await matePage.goto(claimHref!, { waitUntil: "load" });
    expect(
      joinResp?.status(),
      `the claim link the status page emitted resolved to ${joinResp?.status()} — it points at no page`,
    ).toBeLessThan(400);
    await matePage.getByRole("button", { name: /^accept$/i }).click({ timeout: 3000 }).catch(() => {});
    await matePage.getByRole("radio", { name: mateName }).check();
    await matePage.locator("#reg-who-name").fill(mateName);
    await matePage.locator("#reg-who-email").fill(mateEmail);
    await matePage.locator("#reg-consent-privacy").check();
    await shot(matePage, "03-join-filled");
    await matePage.getByRole("button", { name: /confirm my spot/i }).click();
    await expect(
      matePage.getByText(/you're in|confirmed|spot confirmed/i).first(),
      "the join form submitted but nothing confirmed the mate's claim",
    ).toBeVisible({ timeout: 20_000 });
    await screenshotAtWidths(matePage, testInfo, "03-join-confirmed");
    await expectNoHorizontalScroll(matePage);

    // ============================================================= 4
    // A THIRD public submission, overflowing the division's capacity (1),
    // through the real stepper again — must land WAITLISTED, not accepted.
    // =============================================================
    const overflowPage = await anonC.newPage();
    await submitTeamEntry(overflowPage, {
      name: overflowCaptainName,
      email: overflowEmail,
      team: overflowTeamName,
    });
    await expect(
      overflowPage.getByText(/waitlist/i).first(),
      "a submission over a full capacity-1 division must read as waitlisted, not accepted",
    ).toBeVisible({ timeout: 15_000 });
    await shot(overflowPage, "04-status-waitlisted");
    await screenshotAtWidths(overflowPage, testInfo, "04-status-waitlisted");
    await expectNoHorizontalScroll(overflowPage);

    // ============================================================= 5
    // APPROVE — the hub Registrants tab, a real click on the real "Approve"
    // action button. The waitlisted overflow entry is left untouched (it is
    // the negative control for step 7's count check).
    // =============================================================
    await page.goto(`/o/${org.slug}/c/${compSlug}/registration?tab=registrants`, { waitUntil: "load" });
    const teamRow = page.locator("[data-registration-hub-registrant-row]").filter({ hasText: teamName });
    await expect(teamRow, "the Registrants tab never listed the captain's team entry").toBeVisible({ timeout: 15_000 });
    await teamRow.locator("summary").click();

    // The hub's roster panel, unmasked — read BEFORE approve/opt-out too, so
    // step 7's post-opt-out read is a genuine before/after comparison, not
    // the only observation this file makes.
    await expect(
      teamRow.locator("[data-registration-hub-registrant-roster-player]").filter({ hasText: captainName }),
    ).toBeVisible();
    await expect(
      teamRow.locator("[data-registration-hub-registrant-roster-player]").filter({ hasText: mateName }),
    ).toBeVisible();

    const overflowRow = page.locator("[data-registration-hub-registrant-row]").filter({ hasText: overflowTeamName });
    // Each row renders BOTH a phone-card and a desktop-grid rendering of its
    // own status pill (registration-hub-registrant-table.tsx's own `sm:hidden`
    // / `hidden sm:grid` pair, toggled by CSS, not conditional rendering) —
    // `:visible` picks whichever one the current viewport actually shows;
    // both always agree since they render the SAME `row.status`.
    await expect(
      overflowRow.locator('[data-registration-hub-registrant-status="waitlisted"]:visible'),
      "the overflow entry must read WAITLISTED on the organiser's own Registrants tab",
    ).toBeVisible({ timeout: 15_000 });

    const approveBtn = teamRow.locator('[data-registration-hub-registrant-action="approve"]');
    await expect(approveBtn, "a manual-approval division's pending entry must offer an Approve action").toBeVisible({
      timeout: 10_000,
    });
    await screenshotAtWidths(page, testInfo, "05-hub-before-approve");
    await approveBtn.click();
    await expect(
      teamRow.locator('[data-registration-hub-registrant-status="confirmed"]:visible'),
      "approving through the hub UI never flipped the row to confirmed",
    ).toBeVisible({ timeout: 15_000 });
    await screenshotAtWidths(page, testInfo, "06-hub-after-approve");
    await expectNoHorizontalScroll(page);

    const registrationId = await teamRow.getAttribute("data-registration-id");
    if (!registrationId) throw new Error("the approved row carries no data-registration-id");

    // ============================================================= 6
    // OPT-OUT — the mate gets an account (claim invite -> real /claim UI ->
    // real login), then uses the real /me consent control (RS007's
    // ConsentCard, no new UI here) to opt out of a public name.
    // =============================================================
    const mateRowId = await registrationPlayerIdByName(registrationId, mateName);
    const claimPath = await mintClaimPathForPlayerRow(mateRowId, org.id, mateEmail);

    mate2Ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const mate2Page = await mate2Ctx.newPage();
    await loginUi(mate2Page, mateEmail, claimPath);
    const claimButton = mate2Page.getByRole("button", { name: /this is me/i });
    await expect(claimButton, "the claim-accept page never rendered its own accept button").toBeVisible();
    await claimButton.click();
    await mate2Page.waitForURL(/\/me(\?|$)/, { timeout: 20_000 });

    const nameConsent = mate2Page.getByLabel(/show my name publicly/i);
    await expect(nameConsent, "could not find the /me public-name opt-out toggle").toBeVisible();
    await expect(nameConsent).toBeChecked(); // RS007 default: consent, not silence
    const [patchResponse] = await Promise.all([
      mate2Page.waitForResponse((r) => r.url().includes("/consent") && r.request().method() === "PATCH"),
      nameConsent.uncheck(),
    ]);
    expect(patchResponse.status(), "the /me consent opt-out PATCH failed").toBeLessThan(300);
    await expect(nameConsent).not.toBeChecked();
    await screenshotAtWidths(mate2Page, testInfo, "07-me-opted-out");
    await expectNoHorizontalScroll(mate2Page);

    // ============================================================= 7
    // VERIFY ACROSS SCREENS — the actual point of this file.
    // =============================================================

    // 7a. The hub's own roster panel is CONSENT-BLIND (organiser-facing,
    // full names always) — re-read AFTER the opt-out, same row, no reload
    // of anything but this page.
    await page.reload({ waitUntil: "load" });
    const teamRowAfter = page.locator("[data-registration-hub-registrant-row]").filter({ hasText: teamName });
    await teamRowAfter.locator("summary").click();
    await expect(
      teamRowAfter.locator("[data-registration-hub-registrant-roster-player]").filter({ hasText: mateName }),
      "the organiser-only Registrants tab must still show the opted-out player's REAL name",
    ).toBeVisible({ timeout: 15_000 });

    // 7b. The CSV export — organiser-facing, unmasked by design.
    const exportUrl = `/api/v1/competitions/${compId}/registrations/export`;
    const csvResp = await page.request.get(exportUrl);
    expect(csvResp.status(), "the CSV export must succeed for the organiser").toBe(200);
    const csvText = await csvResp.text();
    expect(csvText, "the CSV export must carry the opted-out player's REAL name, unmasked").toContain(mateName);
    expect(csvText, "the CSV export must carry the confirmed captain's name").toContain(captainName);

    // 7c. The public division page's Entrants tab — MASKED for the mate,
    // full for the never-opted-out captain, and the waitlisted overflow
    // team must be absent entirely (it was never confirmed).
    //
    // Polled, not read once: this page is ISR-cached (REVALIDATE_FAST=30s,
    // tag-invalidated by the approve step above via fireDivisionRevalidate)
    // — a single read right after approve can race that regeneration.
    const divisionUrl = `/shared/${org.slug}/${compSlug}/${divisionSlug}`;
    const activePanel = () => captainPage.locator('[role="tabpanel"]:not([hidden])');
    await expect(async () => {
      await captainPage.goto(divisionUrl, { waitUntil: "load" });
      await captainPage.getByRole("button", { name: /^accept$/i }).click({ timeout: 1500 }).catch(() => {});
      await captainPage.getByRole("tab", { name: "Entrants" }).click();
      await expect(activePanel().getByText(mateMasked, { exact: false })).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 40_000, intervals: [2000, 2000, 3000, 3000, 5000, 5000, 5000] });

    await expect(
      activePanel().getByText(captainName),
      "the never-opted-out captain must still render in full on the public Entrants tab",
    ).toBeVisible();
    await expect(
      activePanel().getByText(mateName),
      "the opted-out mate's RAW full name must not be visible on the public Entrants tab",
    ).not.toBeVisible();
    await expect(
      activePanel().getByText(teamName, { exact: false }),
      "the confirmed team must appear exactly once in the public entrant count",
    ).toHaveCount(1);
    await expect(
      activePanel().getByText(overflowTeamName, { exact: false }),
      "the still-waitlisted entry must be EXCLUDED from the public entrant count",
    ).toHaveCount(0);
    await shot(captainPage, "08-public-entrants-cross-checked");
    await screenshotAtWidths(captainPage, testInfo, "08-public-entrants-cross-checked");
    await expectNoHorizontalScroll(captainPage);

    expect(captainErrors, `the captain's own browser logged page errors: ${captainErrors.join(" | ")}`).toEqual([]);
  } finally {
    await anonA.close();
    await anonB.close();
    await anonC.close();
    if (mate2Ctx) await mate2Ctx.close();
  }
});
