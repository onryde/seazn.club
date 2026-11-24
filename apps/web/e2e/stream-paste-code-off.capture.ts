// The organiser stream panel's code card with the paste code OFF (Task 34): the QR alone, no paste field, no Copy — how
// stg and prod render it, where STREAM_PASTE_CODE is unset and the relay is not fake (config.ts `streamPasteCodeShown`).
// A visual probe at 1280, 768 and 320, cropped to the panel.
//
// A CAPTURE HARNESS, not a spec: `.capture.ts` falls outside every project's `testMatch` except `gallery`, and the
// STREAM_PASTE_CODE_PROBE guard makes it a no-op without it. Every e2e, CI and smoke server shows the paste code (they
// run the fake relay), so this runs by hand against a server started WITH the flag off:
//
//   STREAM_PASTE_CODE=false CAPTURE_QR_V2_ALWAYS=1 <a server: next dev, or seazn-env's standalone server>
//   STREAM_PASTE_CODE_PROBE=1 PLAYWRIGHT_BASE=http://localhost:PORT E2E_PROD_TARGET=1 DATABASE_URL=… \
//     pnpm exec playwright test --project=gallery e2e/stream-paste-code-off.capture.ts
//
// The shots land in the test's output folder (`testInfo.outputPath`), printed at the end. Under `next dev`, warm
// `POST /api/auth/magic-link/consume` first: e2e/global-setup.ts probes it, and a cold compile reads as "answered nothing".
//
// THE PRECONDITION FAILS LOUDLY: a paste field on the card means the server was started without STREAM_PASTE_CODE=false,
// and every shot would show the wrong state. Each image is checked to exist and to differ from the other two.
import { test, expect, type Page } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { TAG, addEntrantsViaApi, apiJson, createStageAndGenerate, expectNoHorizontalScroll } from "./helpers";
import { setRigPlan, signInAs } from "./overlay-kit";

const ON = process.env.STREAM_PASTE_CODE_PROBE === "1";
/** Desktop, tablet, phone — the house bar (AGENTS.md). The crop is the panel. */
const WIDTHS = [
  { w: 1280, h: 900 },
  { w: 768, h: 1024 },
  { w: 320, h: 640 },
] as const;
const PASTE_IDS = ["stream-qr-field", "stream-qr-text", "stream-qr-copy"] as const;

test.use({ storageState: { cookies: [], origins: [] } });

async function withDb<T>(fn: (sql: import("postgres").Sql) => Promise<T>): Promise<T> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL required for the rig");
  const { default: postgres } = await import("postgres");
  const sql = postgres(dbUrl, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl: process.env.DATABASE_SSL === "disable" ? false : /@(localhost|127\.0\.0\.1)[:/]/.test(dbUrl) ? false : "require",
    prepare: !dbUrl.includes(":6543"),
    max: 1,
  });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

/** A fresh org on pro, one generic division of two entrants, its one fixture, and a destination to pick. */
async function seedRig(page: Page): Promise<{ fixturePath: string }> {
  const tag = `${TAG}-${randomBytes(4).toString("hex")}`;
  const email = `delivered+paste-off-${tag}@resend.dev`;
  const orgSlug = `paste-off-${tag}`;
  const orgId = await withDb(async (sql) => {
    const [{ id: userId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified) values (${email}, ${"Probe Owner " + tag}, true) returning id`;
    const [{ id }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, status, created_by) values (${"Riverside Club"}, ${orgSlug}, 'active', ${userId}) returning id`;
    await sql`insert into org_members (org_id, user_id, role) values (${id}, ${userId}, 'owner')`;
    const [{ id: subId }] = await sql<{ id: string }[]>`
      insert into subscriptions (owner_user_id, plan_key, status) values (${userId}, 'pro', 'active') returning id`;
    await sql`update organizations set subscription_id = ${subId} where id = ${id}`;
    return id;
  });
  await signInAs(page, email);
  const comp = await apiJson<{ id: string; slug: string }>(page.request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31", name: "Spring League", visibility: "public",
  });
  expect(comp.status, "competition").toBeLessThan(300);
  const div = await apiJson<{ id: string; slug: string }>(page.request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Open", sport_key: "generic", variant_key: "score", config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  expect(div.status, "division").toBeLessThan(300);
  const ents = await addEntrantsViaApi(page.request, div.data!.id, ["Riverside Raptors", "Northgate Nomads"]);
  expect(ents.ids, "entrants").toHaveLength(2);
  const { fixtureIds } = await createStageAndGenerate(page.request, div.data!.id);
  expect(fixtureIds, "a league of two plays once").toHaveLength(1);
  const [f] = await withDb((sql) => sql<{ no: number }[]>`select fixture_no as no from fixtures where division_id = ${div.data!.id}`);
  await setRigPlan(orgId, "pro");
  const target = await apiJson(page.request, `/api/v1/orgs/${orgId}/stream-targets`, "POST", {
    kind: "youtube", label: "Riverside TV", streamKey: `e2e-${randomBytes(6).toString("hex")}`,
  });
  expect([200, 201], "destination").toContain(target.status);
  return { fixturePath: `/o/${orgSlug}/c/${comp.data!.slug}/d/${div.data!.slug}/f/${f!.no}` };
}

test("paste code OFF: the code card is the QR alone — no paste field, no Copy — at 1280, 768 and 320", async ({ page }, testInfo) => {
  test.skip(!ON, "STREAM_PASTE_CODE_PROBE=1 runs it, against a server started with STREAM_PASTE_CODE=false");
  test.setTimeout(8 * 60_000);
  const rig = await seedRig(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(rig.fixturePath, { timeout: 240_000 });
  const reject = page.getByRole("button", { name: "Reject", exact: true });
  await reject.waitFor({ state: "visible", timeout: 8_000 }).then(() => reject.click()).catch(() => undefined);
  await page.addStyleTag({ content: "header { position: static !important; }" });
  const control = page.locator('[data-role="fixture-stream"]:visible, [data-role="fixture-stream-phone"]:visible');
  await expect(control).toHaveCount(1, { timeout: 120_000 });
  await control.click();
  const scope = page.locator('[data-role="fixture-stream-body"]');
  await expect(scope).toBeAttached({ timeout: 60_000 });
  const phoneTab = scope.getByTestId("stream-tab-phone");
  if (await phoneTab.count()) await phoneTab.click();
  await expect(scope.getByTestId("stream-code-card")).toBeVisible({ timeout: 60_000 });
  await expect(scope.getByTestId("stream-qr")).toBeVisible({ timeout: 60_000 });
  // The precondition, loudly: a paste field means the server shows it, and this probe would shoot the wrong state.
  const present = await scope.getByTestId("stream-qr-text").count();
  if (present > 0) {
    throw new Error("the code card shows the paste field: start the server with STREAM_PASTE_CODE=false (every fake-relay or development server shows it by default)");
  }
  for (const id of PASTE_IDS) await expect(scope.getByTestId(id), id).toHaveCount(0);
  await expect(scope.getByTestId("stream-code-reissue"), "Revoke & reissue stays").toBeVisible();
  const shas: string[] = [];
  for (const { w, h } of WIDTHS) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(600); // the QR's ResizeObserver re-snaps
    await expectNoHorizontalScroll(page);
    await scope.getByTestId("stream-code-card").scrollIntoViewIfNeeded();
    for (const id of PASTE_IDS) await expect(scope.getByTestId(id), `${id} @${w}`).toHaveCount(0);
    await expect(scope.getByTestId("stream-qr"), `the QR @${w}`).toBeVisible();
    const file = testInfo.outputPath(`paste-off-code-card@${w}.png`);
    await scope.screenshot({ path: file, animations: "disabled" });
    expect(existsSync(file), `@${w} was written`).toBe(true);
    shas.push(createHash("sha256").update(readFileSync(file)).digest("hex"));
  }
  expect(new Set(shas).size, "three widths, three different images").toBe(WIDTHS.length);
  console.log(`paste-code-off shots: ${testInfo.outputPath()}`);
});
