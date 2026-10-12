import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { TAG, addEntrantsViaApi, apiJson, createStageAndGenerate, expectNoHorizontalScroll } from "./helpers";
import { newPhoneRequest } from "./helpers/fake-capture-phone";
import { signInAs } from "./overlay-kit";
import { tokenTag } from "../src/server/relay/domain/capture-record";

// CAPTURE RECORD UPLOAD, end to end (spec 2026-10-12 §10, P7/Q5): a phone with the fixture's stream code sends a record
// over the REAL route — cookie-less, Bearer tok, NDJSON — and staff read it on /admin, by ref and beside the fixture.
// The record carries a line of ANOTHER code (a foreign pair, then a line under it with a distinctive value): the page must
// show the kept lines and never that value, which the server dropped before storing anything. It also carries a BAD line
// (a key off capture's allow-list): owner ruling RL (2026-10-12) drops that line, stores the rest, and /admin shows the
// bad-line count — never the line.
//
// /admin is staff-only and desktop-only (owner, 2026-09-28): 1280 only, no phone widths.
// PARALLEL-SAFE: a fresh org whose own owner is made staff — the shared Pro owner's staff bit is never borrowed.
// ONE SPORT, on purpose: the capture surface reads no sport (the capture walkthroughs' own reasoning).

async function withDb<T>(fn: (sql: import("postgres").Sql) => Promise<T>): Promise<T> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL required for direct DB setup in e2e");
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

/** A fresh Pro org whose owner is staff, signed in on `page`, with one league fixture and its stream code. */
async function seedStaffFixtureWithCode(page: Page): Promise<{ userId: string; fixtureId: string; code: string; tok: string; tag: string }> {
  const tag = `${TAG}-${randomBytes(4).toString("hex")}`;
  const email = `delivered+caprec-${tag}@resend.dev`;
  const userId = await withDb(async (sql) => {
    const [{ id: uid }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified, is_staff, staff_role)
      values (${email}, ${"Capture Records Staff " + tag}, true, true, 'support') returning id`;
    const [{ id: orgId }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, status, created_by) values (${"Capture Records " + tag}, ${`caprec-${tag}`}, 'active', ${uid}) returning id`;
    await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${uid}, 'owner')`;
    const [{ id: subId }] = await sql<{ id: string }[]>`
      insert into subscriptions (owner_user_id, plan_key, status) values (${uid}, 'pro', 'active') returning id`;
    await sql`update organizations set subscription_id = ${subId} where id = ${orgId}`;
    return uid;
  });
  await signInAs(page, email);
  const comp = await apiJson<{ id: string }>(page.request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31", name: `Capture records ${tag}`, visibility: "private",
  });
  expect(comp.status, JSON.stringify(comp.error)).toBeLessThan(300);
  const div = await apiJson<{ id: string }>(page.request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Open", sport_key: "generic", variant_key: "score", config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  expect(div.status, JSON.stringify(div.error)).toBeLessThan(300);
  const ents = await addEntrantsViaApi(page.request, div.data!.id, [`Asha ${tag}`, `Bala ${tag}`]);
  expect(ents.ids).toHaveLength(2);
  const { fixtureIds } = await createStageAndGenerate(page.request, div.data!.id);
  const fixtureId = fixtureIds[0]!;
  const minted = await apiJson<{ qr: { v: number; code: string; slot: number; tok: string } }>(page.request, `/api/v1/fixtures/${fixtureId}/stream-code`, "POST");
  expect(minted.status, JSON.stringify(minted.error)).toBe(200);
  return { userId, fixtureId, code: minted.data!.qr.code, tok: minted.data!.qr.tok, tag };
}

test("a phone's record reaches /admin at 1280: by ref (typed in lower case) and on the fixture page, kept lines shown, the other code's line nowhere", async ({ page }) => {
  test.setTimeout(120_000);
  const rig = await seedStaffFixtureWithCode(page);
  try {
    const foreign = `foreign-${rig.tag}`;
    const bad = `badline-${rig.tag}`;
    const at = new Date().toISOString();
    const lines = [
      { at, kind: "pair", claim: "new", slot: 0, tokenTag: tokenTag(rig.tok), stopped: false },
      { at, kind: "thermal", level: "warn", status: 3, headroom: 0.4 },
      // Another code's pairing on this phone (its tag cannot be this tok's): the window closes, and the line under it is
      // not this code's — both are counted and dropped.
      { at, kind: "pair", claim: "new", slot: 0, tokenTag: tokenTag(`${rig.tok}-not-this-code`), stopped: false },
      { at, kind: "vendor-log", level: "error", tag: "RtmpClient", message: foreign },
      // A bad line (ruling RL): `battery` is on no allow-list, so the line is dropped and counted apart — not a 422.
      { at, kind: "thermal", battery: 1, message: bad },
    ];
    // Cookie-less, as the phone is: the Bearer tok is the only credential.
    const phone = await newPhoneRequest(new URL(page.url()).origin);
    const res = await phone.post(`/api/v1/capture/codes/${rig.code}/records`, {
      headers: { Authorization: `Bearer ${rig.tok}`, "Content-Type": "application/x-ndjson" },
      data: lines.map((l) => JSON.stringify(l)).join("\n"),
    });
    expect(res.status(), await res.text()).toBe(201);
    // The contract's closed 201: {ref, kept, dropped}, `dropped` covering the other code's lines AND the bad one.
    const ok = (await res.json()) as { ref: string; kept: number; dropped: number };
    expect(Object.keys(ok).sort()).toEqual(["dropped", "kept", "ref"]);
    expect([ok.kept, ok.dropped]).toEqual([2, 3]);
    await phone.dispose();

    await page.setViewportSize({ width: 1280, height: 800 });

    // The support path: staff type the ref the operator read out — any case — into the lookup form.
    await page.goto("/admin/capture-records");
    await page.getByTestId("capture-record-ref-input").fill(ok.ref.toLowerCase());
    await page.getByTestId("capture-record-ref-input").press("Enter");
    const record = page.locator(`[data-testid="capture-record"][data-ref="${ok.ref}"]`);
    await expect(record).toBeVisible({ timeout: 20_000 });
    await expect(record.getByTestId("capture-record-counts")).toHaveText(/5\D+2\D+3/);
    await expect(record.getByTestId("capture-record-invalid")).toHaveText("1");
    const rows = record.getByTestId("capture-record-line");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toHaveAttribute("data-kind", "pair");
    await expect(rows.nth(1)).toHaveAttribute("data-kind", "thermal");
    await expect(rows.nth(1)).toContainText("headroom=0.4");
    // Positive pair for the absences below: the page DOES render kept line text.
    await expect(record).toContainText(`tokenTag=${tokenTag(rig.tok)}`);
    expect(await page.content(), "the other code's line never reaches the page").not.toContain(foreign);
    expect(await page.content(), "the bad line never reaches the page").not.toContain(bad);
    await expectNoHorizontalScroll(page);

    // A ref that is not one, and a well-formed one that names no record.
    await page.goto("/admin/capture-records?ref=nope");
    await expect(page.getByTestId("capture-record-not-found")).toBeVisible();
    await expect(page.getByTestId("capture-record")).toHaveCount(0);

    // Beside the fixture: no session was ever started, so the record names none and is listed as unlinked.
    await page.goto(`/admin/fixtures?id=${rig.fixtureId}`);
    const section = page.getByTestId("capture-records-section");
    await expect(section).toBeVisible({ timeout: 20_000 });
    await expect(section.getByTestId("capture-records-none")).toHaveCount(0);
    await expect(section.getByTestId("capture-records-unlinked").locator(`[data-ref="${ok.ref}"]`)).toBeVisible();
    expect(await page.content()).not.toContain(foreign);
    expect(await page.content()).not.toContain(bad);
    await expectNoHorizontalScroll(page);
  } finally {
    await withDb((sql) => sql`update users set is_staff = false, staff_role = null where id = ${rig.userId}`);
  }
});
