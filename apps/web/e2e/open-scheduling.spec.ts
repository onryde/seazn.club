import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import {
  TAG,
  apiJson,
  loginUi,
  addEntrantsViaApi,
  createStageAndGenerate,
  seedVenueWithCourts,
} from "./helpers";

/**
 * Scheduling is open to every plan — division boards since #382/V353, and the
 * JOINT competition board since entitlements v18/V393 — proven in the browser,
 * on a real COMMUNITY org.
 *
 * Why this file exists. V353 is a data change: three rows flipped, five
 * inserted. Nothing in TypeScript moved, so every unit suite could stay green
 * with the migration unapplied — and `entitlements-scheduling.test.ts` proves
 * only that `hasFeature` answers true, never that the organiser reaches the
 * board. The three `requireFeature` calls it unblocks
 * (`putScheduleSettings`, `applySchedule`, `moveFixture`) are only exercised
 * end-to-end from here.
 *
 * ANTI-VACUITY, and how it changed. This file used to be two-sided: asserting
 * only "the community org got a 200" is satisfied by an entitlement table that
 * over-grants everything, so `scheduling.multi_division` refusing community was
 * the counterweight that proved the gates still bound at all.
 *
 * Entitlements v18 (V393) granted that key to community deliberately, so the
 * counterweight is GONE and cannot be replaced from this surface — every
 * scheduling key is now free on community (`scheduling.ai` since V302,
 * `board`/`constraints` since V353, `multi_division` since V393). Do not read
 * a green run here as evidence that the entitlement system still refuses
 * anything; it no longer says that, and this paragraph exists so a later
 * session does not re-derive the old guarantee from the file's shape.
 *
 * What holds instead: every test anchors on a POSITIVE locator that renders
 * only in the un-gated branch, asserted BEFORE its `toHaveCount(0)`. That is
 * what still separates "no paywall" from "no page" — a count of zero on a
 * marker is otherwise satisfied by a blank render, which is the exact
 * green-by-absence this file was built to refuse.
 *
 * Own org, own owner, own competition — nothing here touches the shared Pro
 * user's org budget, so it belongs in the parallel project.
 */

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

const hex = () => randomBytes(4).toString("hex");

async function withDb<T>(
  fn: (sql: import("postgres").Sql) => Promise<T>,
): Promise<T> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl)
    throw new Error("DATABASE_URL required for direct DB setup in e2e");
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

interface SeededOrg {
  orgId: string;
  orgSlug: string;
  ownerEmail: string;
}

/** A COMMUNITY org with its own fresh owner — explicitly on the free plan, so
 *  nothing here can accidentally read as a Pro result. */
async function seedCommunityOrg(): Promise<SeededOrg> {
  const tag = hex();
  const ownerEmail = `delivered+os-owner-${TAG}-${tag}@resend.dev`;
  return withDb(async (sql) => {
    const [owner] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${ownerEmail}, ${"OS Owner " + tag}, true)
      returning id`;
    const orgSlug = `os-org-${TAG}-${tag}`;
    const [org] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, status, created_by)
      values (${"OS Org " + tag}, ${orgSlug}, 'active', ${owner!.id})
      returning id`;
    await sql`
      insert into org_members (org_id, user_id, role)
      values (${org!.id}, ${owner!.id}, 'owner')`;
    const [group] = await sql<{ id: string }[]>`
      insert into subscriptions (owner_user_id, plan_key, status)
      values (${owner!.id}, 'community', 'active')
      returning id`;
    await sql`update organizations set subscription_id = ${group!.id} where id = ${org!.id}`;
    return { orgId: org!.id, orgSlug, ownerEmail };
  });
}

async function loginAsOwner(page: Page, email: string): Promise<void> {
  await loginUi(page, email);
  await page.request
    .post("/api/onboarding/complete", { data: {} })
    .catch(() => undefined);
}

interface Rig {
  compId: string;
  compSlug: string;
  divisionId: string;
  divSlug: string;
  stageId: string;
  fixtureIds: string[];
}

/** A private competition, a generic division with four entrants, and one
 *  stage's fixtures — created through the API as the signed-in owner. Slugs are
 *  read back, because the console pages are slug-routed. */
async function seedRig(
  request: import("@playwright/test").APIRequestContext,
): Promise<Rig> {
  const comp = await apiJson<{ id: string; slug: string }>(
    request,
    "/api/v1/competitions",
    "POST",
    {
      ends_on: "2030-12-31",
      name: `Open Sched ${TAG} ${hex()}`,
      visibility: "private",
    },
  );
  const div = await apiJson<{ id: string; slug: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: `Open ${hex()}`,
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
    },
  );
  await addEntrantsViaApi(request, div.data!.id, [
    "Bolt",
    "Wire",
    "Coil",
    "Fuse",
  ]);
  const { stageId, fixtureIds } = await createStageAndGenerate(
    request,
    div.data!.id,
  );
  return {
    compId: comp.data!.id,
    compSlug: comp.data!.slug,
    divisionId: div.data!.id,
    divSlug: div.data!.slug,
    stageId,
    fixtureIds,
  };
}

test.describe("Community reaches the board and the constraints (#382)", () => {
  test("a Community org stores a constraint-bearing schedule setting", async ({
    page,
  }) => {
    const org = await seedCommunityOrg();
    await loginAsOwner(page, org.ownerEmail);
    const rig = await seedRig(page.request);
    const { courts } = await seedVenueWithCourts(page.request, [
      "Court A",
      "Court B",
    ]);

    // Every one of these trips `usesConstraints` on its own: a rest floor, a
    // blackout AND a second court. Before V353 this was a flat 402 on community.
    const res = await page.request.put(
      `/api/v1/divisions/${rig.divisionId}/schedule-settings`,
      {
        headers: { "content-type": "application/json" },
        data: JSON.stringify({
          tz: "UTC",
          config: {
            startAt: new Date(Date.UTC(2026, 9, 12, 9, 0)).toISOString(),
            matchMinutes: 45,
            gapMinutes: 5,
            courts: courts.map((c) => c.id),
            perEntrantMinRest: 30,
          },
        }),
      },
    );
    expect(res.status(), await res.text()).toBe(200);

    // …and it STUCK. A 200 that stored nothing would pass a status-only check.
    const read = await apiJson<{
      config: { courts: string[]; perEntrantMinRest: number };
    }>(page.request, `/api/v1/divisions/${rig.divisionId}/schedule-settings`);
    expect(read.data!.config.courts).toEqual(courts.map((c) => c.id));
    expect(read.data!.config.perEntrantMinRest).toBe(30);
  });

  test("a Community org edits the board: a manual apply and a pin", async ({
    page,
  }) => {
    const org = await seedCommunityOrg();
    await loginAsOwner(page, org.ownerEmail);
    const rig = await seedRig(page.request);
    const { courts } = await seedVenueWithCourts(page.request, ["Court A"]);

    // `source: "manual"` is the branch gated on `scheduling.board`.
    const applied = await page.request.post(
      `/api/v1/stages/${rig.stageId}/schedule/apply`,
      {
        headers: { "content-type": "application/json" },
        data: JSON.stringify({
          source: "manual",
          assignments: [
            {
              fixture_id: rig.fixtureIds[0],
              scheduled_at: new Date(Date.UTC(2026, 9, 12, 9, 0)).toISOString(),
              court_id: courts[0]!.id,
            },
          ],
        }),
      },
    );
    expect(applied.status(), await applied.text()).toBe(200);

    // `schedule_locked` on a move is the other `scheduling.board` branch.
    const pinned = await page.request.patch(
      `/api/v1/fixtures/${rig.fixtureIds[0]}`,
      {
        headers: { "content-type": "application/json" },
        data: JSON.stringify({ schedule_locked: true }),
      },
    );
    expect(pinned.status(), await pinned.text()).toBe(200);

    const fixture = await apiJson<{
      schedule_locked: boolean;
      court_id: string | null;
      court_name: string | null;
    }>(page.request, `/api/v1/fixtures/${rig.fixtureIds[0]}`);
    expect(fixture.data!.schedule_locked).toBe(true);
    expect(fixture.data!.court_id).toBe(courts[0]!.id);
    expect(fixture.data!.court_name).toBe("Court A");
  });

  test("the division board page renders no scheduling paywall for Community", async ({
    page,
  }) => {
    const org = await seedCommunityOrg();
    await loginAsOwner(page, org.ownerEmail);
    const rig = await seedRig(page.request);

    const schedule = `/o/${org.orgSlug}/c/${rig.compSlug}/d/${rig.divSlug}/schedule`;
    await page.goto(schedule);
    // Anchor on the tab strip, not on a panel heading: the panels are separate
    // ?tab= views, so "History" is a LINK here and its heading only exists once
    // that tab is open. Anchoring on the heading made this wait 30s and fail on
    // a page that had rendered the whole board correctly.
    await expect(page.getByRole("link", { name: "history" })).toBeVisible({
      timeout: 30_000,
    });
    // The UpgradeGate carries data-feature; neither scheduling key may appear.
    await expect(page.locator('[data-feature="scheduling.board"]')).toHaveCount(
      0,
    );
    await expect(
      page.locator('[data-feature="scheduling.constraints"]'),
    ).toHaveCount(0);

    // The constraints editor is the other half of what V353 opened, and it is a
    // tab of its own — a board-only check would pass even if it were still
    // walled. Assert the panel actually rendered, so an empty tab cannot pass
    // as an ungated one.
    await page.goto(`${schedule}?tab=constraints`);
    await expect(
      page.getByRole("heading", {
        name: "Constraints & planning",
        exact: true,
      }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.locator('[data-feature="scheduling.constraints"]'),
    ).toHaveCount(0);
  });

  test("the JOINT board opens for Community too — the last scheduling paywall is gone", async ({
    page,
  }) => {
    // This test used to assert the opposite, and deliberately so: until
    // entitlements v18 `scheduling.multi_division` was the one scheduling
    // feature kept paid, and this was the file's counterweight against #382
    // giving the whole area away by accident. V393 grants it to community on
    // purpose (design doc §2 — "charge for leverage, never correctness"), so
    // the sentinel is INVERTED rather than deleted: it now guards the ruling
    // that the joint board is free, and reds if anything walls it again.
    const org = await seedCommunityOrg();
    await loginAsOwner(page, org.ownerEmail);
    const rig = await seedRig(page.request);

    await page.goto(`/o/${org.orgSlug}/c/${rig.compSlug}/schedule`);
    // The positive pair, and it has to come FIRST. `toHaveCount(0)` on a
    // paywall marker is satisfied by a page that never rendered at all, which
    // is the green-by-absence shape this file was written to refuse. The
    // density control lives only in the ALLOWED branch — the gated branch
    // returns an h1 and an UpgradeGate and nothing else — so reaching it is
    // proof the joint board itself came back.
    await expect(
      page.getByRole("group", { name: "Board density" }),
    ).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.locator('[data-feature="scheduling.multi_division"]'),
    ).toHaveCount(0);
  });
});

test.describe("At the save-point cap the window rolls, and the panel says so (#382)", () => {
  test("the third save point names the one it replaced", async ({ page }) => {
    const org = await seedCommunityOrg();
    await loginAsOwner(page, org.ownerEmail);
    const rig = await seedRig(page.request);

    // ?tab=history — the save-point control lives in the HistoryPanel, which the
    // page only mounts for that tab. Landing on the default board tab left this
    // waiting 30s for an input that was never going to be there.
    await page.goto(
      `/o/${org.orgSlug}/c/${rig.compSlug}/d/${rig.divSlug}/schedule?tab=history`,
    );
    const input = page.getByLabel("Save point label");
    await expect(input).toBeVisible({ timeout: 30_000 });
    // exact: true — the panel also carries two info buttons labelled "About:
    // Undo and save points" and "About: Save points", and getByRole matches a
    // name by substring, so the loose form resolves to three elements.
    const save = page.getByRole("button", { name: "Save point", exact: true });

    const first = `before rain ${hex()}`;
    for (const label of [first, `after rain ${hex()}`]) {
      await input.fill(label);
      await save.click();
      await expect(page.getByText(label, { exact: false })).toBeVisible({
        timeout: 20_000,
      });
    }
    // Two saves, still under the community cap of 2 — no notice yet. Asserting
    // its ABSENCE first is what stops a notice that always renders from passing
    // the assertion below.
    await expect(page.getByText("was replaced", { exact: false })).toHaveCount(
      0,
    );

    await input.fill(`third ${hex()}`);
    await save.click();

    // The save SUCCEEDED (no paywall), and the notice names the label that went.
    //
    // Scoped to the LIST, not the page. The eviction notice itself quotes the
    // evicted label — that is the point of it — so a page-wide `getByText(first)`
    // is self-contradictory with the `toContainText(first)` assertion three lines
    // below: it matches the very notice it then requires to name `first`.
    await expect(
      page.getByRole("listitem").filter({ hasText: first }),
    ).toHaveCount(0, {
      timeout: 20_000,
    });
    const notice = page.getByText("was replaced", { exact: false });
    await expect(notice).toBeVisible({ timeout: 20_000 });
    await expect(notice).toContainText(first);
    await expect(notice).toContainText("2 save points");
    // A notice, not a paywall: nothing was refused.
    await expect(
      page.locator('[data-feature="schedule.checkpoints.max"]'),
    ).toHaveCount(0);
    await expect(
      page.getByText("Undo still rewinds past it", { exact: false }),
    ).toBeVisible();

    // 375px — the notice is new copy on a panel that was already dense, and it
    // is the longest single sentence in it. Asserted rather than screenshotted
    // so a future edit that makes it overflow fails here instead of shipping.
    await page.setViewportSize({ width: 375, height: 667 });
    await expect(notice).toBeVisible();
    const overflows = await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    );
    expect(overflows, "the history panel scrolls horizontally at 375px").toBe(
      false,
    );
    await page.screenshot({
      path: "test-results/eviction-notice-375.png",
      fullPage: true,
    });
  });
});
