// Seeds shared by e2e/open-in-app-buttons.spec.ts and e2e/open-in-app-telemetry.spec.ts: the smallest state that puts
// each of the four phone codes on screen. A helper, not a spec: importing a spec file would register its tests twice.
import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { TAG, addEntrantsViaApi, apiJson, createStageAndGenerate, seedVenueWithCourts, withDb } from "../helpers";
import { waitForHydration } from "../directory-kit";
import { setRigPlan, signInAs } from "../overlay-kit";
import { storeCameraOnly } from "./stream-mode";
import { middayZoneFor, withinToday } from "../midday-zone";

export async function seedGenericDivision(request: APIRequestContext, label: string) {
  const nonce = randomBytes(3).toString("hex");
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31", name: `OpenApp ${label} ${TAG} ${nonce}`, visibility: "public",
  });
  if (comp.status >= 300 || !comp.data) throw new Error(`competition -> ${comp.status} ${JSON.stringify(comp.error)}`);
  const div = await apiJson<{ id: string; slug: string }>(request, `/api/v1/competitions/${comp.data.id}/divisions`, "POST", {
    name: "Open singles", sport_key: "generic", variant_key: "score",
  });
  if (div.status >= 300 || !div.data) throw new Error(`division -> ${div.status} ${JSON.stringify(div.error)}`);
  const ents = await addEntrantsViaApi(request, div.data.id, [`Ada ${label} ${nonce}`, `Bo ${label} ${nonce}`]);
  if (ents.ids.length !== 2) throw new Error(`entrants -> ${ents.status}`);
  const { fixtureIds } = await createStageAndGenerate(request, div.data.id);
  expect(fixtureIds.length, "premise: two entrants make one fixture").toBe(1);
  return { competitionId: comp.data.id, compSlug: comp.data.slug, divisionId: div.data.id, divSlug: div.data.slug, fixtureId: fixtureIds[0]!, nonce };
}

/** One competition with one court that has a match IN PLAY on it (a real core.start): the state in which the court's
 *  focus shows its compact Remote scoring panel and offers a court stream. */
export async function seedCourtInPlay(request: APIRequestContext, label: string) {
  const seed = await seedGenericDivision(request, label);
  const started = await apiJson(request, `/api/v1/divisions/${seed.divisionId}/start`, "POST");
  expect(started.status, `division start: ${JSON.stringify(started.error)}`).toBeLessThan(300);
  const { courts } = await seedVenueWithCourts(request, [`OA ${label} ${seed.nonce} ${TAG}`]);
  const court = courts[0]!;
  // Planned in the zone where the real clock reads midday, so "today" cannot roll over mid-run (midday-zone.ts).
  const now = Date.now();
  const zone = middayZoneFor(now);
  const settings = await apiJson(request, `/api/v1/divisions/${seed.divisionId}/schedule-settings`, "PUT", {
    tz: zone, config: { matchMinutes: 30, courts: [court.id] },
  });
  expect(settings.status, `schedule settings: ${JSON.stringify(settings.error)}`).toBeLessThan(300);
  await withDb(async (sql) => {
    await sql`update fixtures set court_id = ${court.id}, scheduled_at = ${withinToday(now, zone)(-10)} where id = ${seed.fixtureId}`;
  });
  const start = await apiJson(request, `/api/v1/fixtures/${seed.fixtureId}/events`, "POST", { expected_seq: 0, type: "core.start", payload: {} });
  expect(start.status, `core.start: ${JSON.stringify(start.error)}`).toBeLessThan(300);
  return { ...seed, courtId: court.id };
}

/** A connected YouTube channel as a destination, written raw (the OAuth round trip is not under test). */
export async function seedYoutubeDestination(orgId: string, label: string): Promise<void> {
  await withDb(async (sql) => {
    const [owner] = await sql<{ user_id: string }[]>`select user_id from org_members where org_id = ${orgId} limit 1`;
    const [conn] = await sql<{ id: string }[]>`
      insert into org_youtube_connections (org_id, channel_id, channel_title, refresh_token_enc, granted_scope, default_privacy,
                                           consent_by, consent_at, consent_version, status, created_by)
      values (${orgId}, ${`UC${randomBytes(11).toString("hex")}`}, ${`${label} channel`}, ${Buffer.from("not-a-real-envelope")},
              'https://www.googleapis.com/auth/youtube', 'unlisted', ${owner!.user_id}, now(), 1, 'connected', ${owner!.user_id})
      returning id`;
    await sql`insert into org_stream_targets (org_id, kind, label, youtube_connection_id) values (${orgId}, 'youtube', ${label}, ${conn!.id})`;
  });
}

/** A fresh Pro org of its own, signed in on `page`: stream destinations and credits are org-wide. */
export async function seedStreamRig(page: Page) {
  const tag = `${TAG}-${randomBytes(4).toString("hex")}`;
  const email = `delivered+openapp-${tag}@resend.dev`;
  const orgSlug = `openapp-org-${tag}`;
  const orgId = await withDb(async (sql) => {
    const [{ id: userId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified) values (${email}, ${"OpenApp Owner " + tag}, true) returning id`;
    const [{ id: newOrgId }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, status, created_by) values (${"OpenApp Org " + tag}, ${orgSlug}, 'active', ${userId}) returning id`;
    await sql`insert into org_members (org_id, user_id, role) values (${newOrgId}, ${userId}, 'owner')`;
    const [{ id: subId }] = await sql<{ id: string }[]>`
      insert into subscriptions (owner_user_id, plan_key, status) values (${userId}, 'pro', 'active') returning id`;
    await sql`update organizations set subscription_id = ${subId} where id = ${newOrgId}`;
    return newOrgId;
  });
  await signInAs(page, email);
  const seed = await seedGenericDivision(page.request, "stream");
  await storeCameraOnly(page.request, [seed.fixtureId]);
  const { monthlyMatchCredits } = await setRigPlan(orgId, "pro");
  expect(monthlyMatchCredits, "premise: the rig can pay for a stream").toBeGreaterThanOrEqual(1);
  return { orgId, ...seed };
}

/** The fixture page already open: its Stream control, then the Phone tab. Returns the panel's `[data-phone-body]`. */
export async function openPhoneTab(page: Page, timeout: number): Promise<Locator> {
  const control = page.locator('[data-role="fixture-stream"]:visible, [data-role="fixture-stream-phone"]:visible');
  await expect(control).toHaveCount(1, { timeout });
  await waitForHydration(control);
  await control.click();
  const scope = page.locator('[data-role="fixture-stream-body"]');
  await expect(scope).toBeAttached({ timeout });
  const tab = scope.getByTestId("stream-tab-phone");
  if (await tab.count()) await tab.click();
  return scope.locator("[data-phone-body]");
}

/** Match Day on a phone opens on the court list: a tap on the court's row opens its focus (the seed has one court). */
export async function openCourtOnPhone(page: Page, timeout: number): Promise<void> {
  const rows = page.getByTestId("md-court-row");
  await expect(rows).toHaveCount(1, { timeout });
  await waitForHydration(rows);
  await rows.click();
  await expect(page.getByTestId("md-focus")).toBeVisible({ timeout });
}
