// The organiser's match page has ONE back button at the left of its top row, the row the Check-in QR sits in
// (owner 2026-11-26). It is a real link to the division's fixtures tab, so it works from a shared link or a new tab.
// An accepted official who is not an org member cannot open any division page (requireOrgPage 404s them), so theirs
// goes to /me. What only a browser can settle: the click lands, the 44px box is hit-testable, the row at 1280/768/320.
//
// single-sport: the button is the page's own, built from the three slugs. No sport reaches it or its destination.
import { test, expect, type Browser, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  TAG,
  apiJson,
  divisionPath,
  expectNoHorizontalScroll,
  fixturePath,
  loginUi,
  seedRosteredFixture,
  withDb,
} from "./helpers";
import { dismissCookieBanner } from "./scorepad-a11y-kit";

const en = JSON.parse(readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8")) as Record<string, string>;
const TO_FIXTURES = en["fixture.back.fixtures"]!;
const TO_MY_MATCHES = en["fixture.back.myMatches"]!;
const WIDTHS = [1280, 768, 320] as const;

const backTo = (page: Page, name: string): Locator => page.getByRole("main").getByRole("link", { name, exact: true });

async function seed(page: Page, label: string) {
  const fx = await seedRosteredFixture(page.request, {
    label: `Match back ${label} ${TAG}`,
    sportKey: "generic",
    variantKey: "score",
    home: [{ fullName: `Back Home Player ${label} ${TAG}` }],
    away: [{ fullName: `Back Away Player ${label} ${TAG}` }],
    emitCoreStart: false,
  });
  const match = await fixturePath(page.request, fx.fixtureId);
  const division = await divisionPath(page.request, fx.divisionId);
  const no = match.split("/f/")[1]!;
  return { ...fx, match, fixtures: `${division}?tab=fixtures`, no };
}

/** A 44px target that is really on top at its centre and near each edge: a box alone also measures a covered control. */
async function expectHittable(link: Locator, at: string): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = (await link.boundingBox())!;
  expect(box.width, `${at}: 44px wide`).toBeGreaterThanOrEqual(44);
  expect(box.height, `${at}: 44px tall`).toBeGreaterThanOrEqual(44);
  const hits = await link.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    // The button is round, so the probes run along its two diameters, 3px inside the rim.
    return [[cx, cy], [r.left + 3, cy], [r.right - 3, cy], [cx, r.top + 3], [cx, r.bottom - 3]].map(([x, y]) => {
      const top = document.elementFromPoint(x!, y!);
      return top !== null && el.contains(top);
    });
  });
  expect(hits, `${at}: hit-testable at the centre and all four edges`).toEqual([true, true, true, true, true]);
  return box;
}

async function expectLandsOnFixtures(page: Page, fixtures: string, no: string): Promise<void> {
  await page.waitForURL((u) => u.pathname + u.search === fixtures, { timeout: 20_000 });
  // The run sheet is the fixtures tab's own: its row for this match proves the tab, not only the address.
  await expect(page.locator(`li[data-fixture-no="${no}"]`).first()).toBeVisible({ timeout: 20_000 });
}

test("the organiser's match page: back sits left of the Check-in QR and opens this division's fixtures, at 1280, 768 and 320", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const fx = await seed(page, "Organiser");
  let checked = 0;
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: width === 320 ? 568 : 900 });
    // A fresh load with no match-page history behind it, as from a shared link.
    await page.goto(fx.match);
    await dismissCookieBanner(page);
    const back = backTo(page, TO_FIXTURES);
    await expect(back).toHaveCount(1);
    await expect(back, "a real link to the fixtures address").toHaveAttribute("href", fx.fixtures);
    const box = await expectHittable(back, `${width}`);
    const qr = page.getByTestId("checkin-open");
    await expect(qr, `${width}: PREMISE: a scheduled match offers the Check-in QR`).toBeVisible();
    const qrBox = (await qr.boundingBox())!;
    expect(box.x + box.width, `${width}: back is left of the QR button`).toBeLessThan(qrBox.x);
    expect(Math.abs(box.y + box.height / 2 - (qrBox.y + qrBox.height / 2)), `${width}: one row`).toBeLessThanOrEqual(2);
    await expectNoHorizontalScroll(page);
    await back.click();
    await expectLandsOnFixtures(page, fx.fixtures, fx.no);
    checked++;
  }
  expect(checked).toBe(WIDTHS.length);
});

test("once play starts the QR goes and back stays, still opening the fixtures; it goes there from any previous page", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const fx = await seed(page, "InPlay");
  const started = await apiJson(page.request, `/api/v1/fixtures/${fx.fixtureId}/events`, "POST", {
    expected_seq: 0,
    type: "core.start",
    payload: {},
  });
  expect(started.status, JSON.stringify(started.error)).toBe(201);
  // Arrive from somewhere that is NOT the fixtures tab: a history.back() would return there.
  await page.goto("/me");
  await page.goto(fx.match);
  await dismissCookieBanner(page);
  await expect(page.getByTestId("score-pad"), "PREMISE: the match page rendered").toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("checkin-open"), "PREMISE: no Check-in QR in play").toHaveCount(0);
  const back = backTo(page, TO_FIXTURES);
  await expectHittable(back, "in play");
  await back.click();
  await expectLandsOnFixtures(page, fx.fixtures, fx.no);
});

/** An accepted official for one fixture, signed in as themselves. `member` adds the org viewer seat; without it they are
 *  the usual official (design v2 §A2): no membership at all. */
async function official(browser: Browser, fixtureId: string, member: boolean) {
  const nonce = Math.random().toString(36).slice(2, 8);
  const email = `delivered+match-back-${TAG}-${nonce}@resend.dev`;
  const { orgId, userId } = await withDb(async (sql) => {
    const [u] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified) values (${email}, ${"Back Official " + nonce}, true) returning id`;
    const [o] = await sql<{ org_id: string }[]>`
      select c.org_id from fixtures f join divisions d on d.id = f.division_id join competitions c on c.id = d.competition_id
       where f.id = ${fixtureId}`;
    if (member) await sql`insert into org_members (org_id, user_id, role) values (${o!.org_id}, ${u!.id}, 'viewer')`;
    const [p] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name, user_id, lane) values (${o!.org_id}, ${"Back Official " + nonce}, ${u!.id}, 'official') returning id`;
    const [off] = await sql<{ id: string }[]>`
      insert into officials (org_id, display_name, role_keys, person_id)
      values (${o!.org_id}, ${"Back Official " + nonce}, ${sql.json(["scorer"])}, ${p!.id}) returning id`;
    await sql`insert into fixture_officials (org_id, fixture_id, official_id, role_key, response)
              values (${o!.org_id}, ${fixtureId}, ${off!.id}, 'scorer', 'accepted')`;
    return { orgId: o!.org_id, userId: u!.id };
  });
  // The viewer row is a team seat in the shared org: it lives only as long as the page (bracket-finish.spec.ts).
  const release = async () => {
    if (member) await withDb(async (sql) => { await sql`delete from org_members where org_id = ${orgId} and user_id = ${userId}`; });
  };
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  try {
    await loginUi(page, email);
    await page.request.post("/api/onboarding/complete", { data: {} }).catch(() => undefined);
  } catch (err) {
    await context.close();
    await release();
    throw err;
  }
  return {
    page,
    close: async () => {
      try {
        await context.close();
      } finally {
        await release();
      }
    },
  };
}

for (const member of [true, false]) {
  const who = member ? "an official who is an org member" : "an official who is not a member";
  test(`${who}: one back button, to a page they can open, at 1280, 768 and 320`, async ({ browser, page }) => {
    test.setTimeout(150_000);
    const fx = await seed(page, member ? "Member" : "Stranger");
    const o = await official(browser, fx.fixtureId, member);
    try {
      const p = o.page;
      const name = member ? TO_FIXTURES : TO_MY_MATCHES;
      const href = member ? fx.fixtures : "/me";
      let checked = 0;
      for (const width of WIDTHS) {
        await p.setViewportSize({ width, height: 900 });
        await p.goto(fx.match);
        await dismissCookieBanner(p);
        await expect(p.getByTestId("score-pad"), `${width}: PREMISE: given the pad`).toBeVisible({ timeout: 20_000 });
        await expect(p.getByTestId("checkin-open"), `${width}: officials are not offered the QR`).toHaveCount(0);
        const back = backTo(p, name);
        await expect(back).toHaveCount(1);
        await expect(back).toHaveAttribute("href", href);
        await expectHittable(back, `${who} ${width}`);
        // A member keeps the courtside shortcut to their own matches; for anyone else the button IS that way back.
        await expect(p.getByRole("main").locator('a[href="/me"]')).toHaveCount(1);
        await expectNoHorizontalScroll(p);
        await back.click();
        if (member) await expectLandsOnFixtures(p, fx.fixtures, fx.no);
        else {
          await p.waitForURL((u) => u.pathname === "/me", { timeout: 20_000 });
          await expect(p.getByRole("heading", { level: 1 })).toBeVisible();
        }
        checked++;
      }
      expect(checked).toBe(WIDTHS.length);
      if (!member) {
        // Why their button does not point at the fixtures tab: that page is not theirs to open.
        const refused = await p.goto(fx.fixtures);
        expect(refused?.status(), "a non-member has no fixtures tab").toBe(404);
      }
    } finally {
      await o.close();
    }
  });
}
