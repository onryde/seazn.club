// The online seat gate on an ORGANISER route: approving a registrant in the registration hub.
//
// A division played online on Lichess seats only a player whose Lichess link can play (`lichessGrantPlays`). The self-registration
// submit and the organiser's roster add ask that at the door; this spec is the route that does NOT go through either - an
// organiser pressing Approve on a registration that is already in the queue (the registrant's link may have gone away, or never
// been looked at, since they registered). The same seat gate answers, with the same two codes the roster add uses, and the hub
// says them in the organiser's language (reg.hub.registrants.lichess.*) instead of the server's English.
//
// What it drives, through the real hub (a prod build, a real browser):
//   1. no Lichess link at all  -> Approve is refused as LINK; the registration stays pending; nothing is seated
//   2. the player links (a link that plays) -> the SAME click seats them: the registration is confirmed and an entrant exists
//   3. an identity-only link (linked, never consented to play) -> refused as RECONNECT, not link - and a different sentence
// plus: the refusal is readable at 320 / 768 / 1280 with no sideways scroll (the hub is an org-side page, not /admin).
//
// What is seeded by SQL, and why: the registration rows (the public register endpoint itself holds a player to this same bar,
// so a registrant with no link cannot be submitted through it any more; the state under test - a queued registration whose
// player has no link that plays - is reached by writing under the API, as seedBareRegistrationSql documents), and the
// Lichess link (linking is an OAuth trip to lichess.org; match-room-kit.ts says why the stored token is unopenable).
import { test, expect, type Locator, type Page } from "@playwright/test";
import { activeOrg, apiJson, expectNoHorizontalScroll, seedBareRegistrationSql, TAG, withDb } from "./helpers";
import { CLOCK, seedLichessLink, seedUser, uiEn } from "./match-room-kit";

const registrantsPath = (orgSlug: string, compSlug: string) => `/o/${orgSlug}/c/${compSlug}/registration?tab=registrants`;

/** A public competition with one online (Lichess) division that approves registrations by hand, through the product's own routes. */
async function seedOnlineDivision(page: Page): Promise<{ orgSlug: string; competitionId: string; competitionSlug: string; divisionId: string }> {
  const org = await activeOrg(page);
  const suffix = `${TAG}-${Math.random().toString(36).slice(2, 7)}`;
  const comp = await apiJson<{ id: string; slug: string }>(page.request, "/api/v1/competitions", "POST", {
    name: `Seat gate ${suffix}`,
    ends_on: "2030-12-31",
    visibility: "public",
  });
  expect(comp.status, JSON.stringify(comp.error)).toBeLessThan(300);
  const div = await apiJson<{ id: string }>(page.request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: `Online ${suffix}`,
    sport_key: "boardgame",
    variant_key: "classical",
    config: { variant: "classical", onlinePlay: "lichess", clock: CLOCK },
  });
  expect(div.status, JSON.stringify(div.error)).toBeLessThan(300);
  const settings = await apiJson(page.request, `/api/v1/divisions/${div.data!.id}/registration-settings`, "PUT", {
    enabled: true,
    entrant_kind: "individual",
    fee_cents: 0,
    approval: "manual",
  });
  expect(settings.status, JSON.stringify(settings.error)).toBeLessThan(300);
  return { orgSlug: org.slug, competitionId: comp.data!.id, competitionSlug: comp.data!.slug, divisionId: div.data!.id };
}

/** A pending registration whose one player is the account `userId` (what "I'm playing" writes at submit). */
async function seedQueuedRegistration(world: { competitionId: string; divisionId: string }, userId: string, name: string): Promise<string> {
  const { registrationId } = await seedBareRegistrationSql(world.competitionId, world.divisionId, { displayName: name, status: "pending" });
  await withDb(
    (sql) => sql`
      insert into registration_players (registration_id, full_name, user_id, source)
      values (${registrationId}, ${name}, ${userId}, 'captain_entered')`,
  );
  return registrationId;
}

async function expandRow(page: Page, registrationId: string): Promise<Locator> {
  const row = page.locator(`[data-registration-hub-registrant-row][data-registration-id="${registrationId}"]`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  if (!(await row.evaluate((el) => (el as HTMLDetailsElement).open))) await row.locator("summary").click();
  await expect(row.locator("[data-registration-hub-registrant-detail]")).toBeVisible();
  return row;
}

const approveButton = (row: Locator) => row.locator('[data-registration-hub-registrant-action="approve"]');
const feedback = (row: Locator, tone: "error" | "success") =>
  row.locator(`[data-registration-hub-registrant-actions-feedback][data-tone="${tone}"]`);

test.describe("online seat gate - the registration hub's Approve", () => {
  test("a registrant with no Lichess link is refused as LINK; once they link, the same Approve seats them", async ({ page, request }) => {
    test.setTimeout(180_000);
    const world = await seedOnlineDivision(page);
    const player = await seedUser(`Ada Okonkwo ${TAG}`);
    const regId = await seedQueuedRegistration(world, player.userId, `Ada Okonkwo ${TAG}`);

    await page.goto(registrantsPath(world.orgSlug, world.competitionSlug), { waitUntil: "load" });
    const row = await expandRow(page, regId);

    await approveButton(row).click();
    const refused = feedback(row, "error");
    await expect(refused).toBeVisible({ timeout: 20_000 });
    await expect(refused).toHaveText(uiEn["reg.hub.registrants.lichess.linkRequired.unnamed"]!);
    await expect(refused, "never the server's English").not.toContainText("Every player must");
    await expect(approveButton(row), "the organiser can try again").toBeVisible();
    // Nothing was seated: the refusal rolled the whole approval back.
    const seatedBefore = await apiJson<{ id: string }[]>(request, `/api/v1/divisions/${world.divisionId}/entrants`);
    expect(seatedBefore.data ?? [], "no entrant was created by the refused approval").toHaveLength(0);

    for (const width of [1280, 768, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(refused).toBeVisible();
      await expectNoHorizontalScroll(page);
    }
    await page.setViewportSize({ width: 1280, height: 900 });

    // The player links a Lichess account that plays; the organiser presses the same button again.
    await seedLichessLink(player.userId, `seat-gate-${TAG}-${Math.random().toString(36).slice(2, 7)}`);
    await approveButton(row).click();
    await expect(feedback(row, "success")).toHaveText(uiEn["reg.hub.registrants.detail.actions.approved"]!, { timeout: 20_000 });
    await expect(feedback(row, "error"), "the refusal is gone").toHaveCount(0);

    await expect
      .poll(async () => ((await apiJson<{ id: string }[]>(request, `/api/v1/divisions/${world.divisionId}/entrants`)).data ?? []).length, { timeout: 20_000 })
      .toBe(1);
  });

  test("a link that cannot play is refused as RECONNECT - a different sentence from the missing link", async ({ page }) => {
    test.setTimeout(180_000);
    const world = await seedOnlineDivision(page);
    const player = await seedUser(`Bo Lindqvist ${TAG}`);
    const lichessId = `seat-gate-idonly-${TAG}-${Math.random().toString(36).slice(2, 7)}`;
    // Linked for identity only: no play consent, no play scopes (the state the registration submit tells to reconnect).
    await withDb(
      (sql) => sql`
        insert into user_external_accounts (user_id, provider, external_user_id, username)
        values (${player.userId}, 'lichess', ${lichessId}, ${lichessId})`,
    );
    const regId = await seedQueuedRegistration(world, player.userId, `Bo Lindqvist ${TAG}`);

    await page.goto(registrantsPath(world.orgSlug, world.competitionSlug), { waitUntil: "load" });
    const row = await expandRow(page, regId);
    await approveButton(row).click();

    const refused = feedback(row, "error");
    await expect(refused).toHaveText(uiEn["reg.hub.registrants.lichess.reconnectRequired.unnamed"]!, { timeout: 20_000 });
    expect(uiEn["reg.hub.registrants.lichess.reconnectRequired.unnamed"], "the two reasons read differently").not.toBe(
      uiEn["reg.hub.registrants.lichess.linkRequired.unnamed"],
    );
    await expect(approveButton(row)).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
});
