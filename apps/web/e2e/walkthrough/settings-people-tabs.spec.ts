import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  seedSettingsOrg,
  releaseSettingsOrg,
  settingsUrl,
  type SeededOrg,
} from "../settings-support";
import { apiJson, TAG } from "../helpers";

/**
 * W2 Task 3 — the four PEOPLE-facing panels of `/o/{org}/settings`:
 * `team`, `api`, `preferences`, `account`.
 *
 * Every tab here is driven the same way: fill every control the panel map
 * lists, ONE save, a read of the STORE for persistence, and ONE reload for
 * render-back. The two questions are kept apart on purpose — "the row moved"
 * and "the screen says so" fail for different reasons, and a test that only
 * reloads cannot tell a save from a cached form.
 *
 * OUT OF SCOPE, deliberately: remove-member, transfer-ownership, leave-org and
 * delete-account. Those are Class 3 (ownership and last-actor) cases 11-14 and
 * belong to W3. They are also irreversible against the SHARED Pro user this
 * whole leg is signed in as — a `DELETE /api/users/me` here would not fail this
 * spec, it would end the leg for every other spec in it.
 */

/**
 * `mode: "default"`, and it is load-bearing twice over.
 *
 * The config sets `fullyParallel: true` and the `walkthrough` project does not
 * opt out, so this file's tests would otherwise be SPLIT ACROSS WORKERS — and a
 * `beforeAll` runs once per worker, which would seed one org PER WORKER and
 * spend the shared Pro user's five-owner cap (`assertMayOwnAnotherOrg`) inside
 * a single file. `default` also fixes declaration order, which the restore
 * verification below depends on.
 *
 * `default` rather than `serial`: serial aborts every remaining test in the
 * file after the first red, which hides the second and third defect behind the
 * first (AGENTS.md failure class 21). Here a red must not stop the tabs after
 * it from being driven.
 */
test.describe.configure({ mode: "default" });

// ---------------------------------------------------------------------------
// Reading the store directly
// ---------------------------------------------------------------------------

/**
 * A local one-shot SQL client, copied from `e2e/helpers.ts` because `withDb`
 * there is module-PRIVATE (`async function withDb`, no `export`). Two of its
 * settings are not defaults and a fresh copy gets them wrong: `search_path`
 * (the app lives in a dedicated schema, so unqualified table names resolve
 * nowhere without it) and `prepare` (a pooled `:6543` URL cannot use prepared
 * statements).
 *
 * This is here rather than in `helpers.ts` because that file is owned by
 * another task this wave; a spec may not reach into someone else's lane.
 */
async function withDb<T>(fn: (sql: import("postgres").Sql) => Promise<T>): Promise<T> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL required for direct DB reads in e2e");
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

interface Profile {
  display_name: string;
  timezone: string | null;
  locale: string | null;
}

/**
 * The user's three mutable profile columns.
 *
 * The plan asked for this to be read back from `GET /api/users/me`. That
 * endpoint returns `{ id, org }` and NOTHING ELSE — no display name, no
 * timezone, no locale (`src/app/api/users/me/route.ts`). `GET
 * /api/users/me/export` carries `display_name` but not the other two, and
 * `PATCH` refuses an empty body (`updateProfileSchema` ends in a `.refine`
 * that demands at least one field), so there is no no-op read through the API
 * either. The column IS the thing being restored, so the column is what gets
 * asserted — and unlike any API shape it can express the difference between
 * `null` and `"en"`, which is exactly the distinction a sloppy restore loses.
 */
async function readProfile(userId: string): Promise<Profile> {
  return withDb(async (sql) => {
    const [row] = await sql<Profile[]>`
      select display_name, timezone, locale from users where id = ${userId}`;
    if (!row) throw new Error(`readProfile: no users row for ${userId}`);
    return { display_name: row.display_name, timezone: row.timezone, locale: row.locale };
  });
}

interface OrgDefaults {
  timezone: string | null;
  default_locale: string | null;
  currency: string | null;
}

/**
 * The org's three preference columns. Same reason as above: there is no `GET`
 * export in `src/app/api/orgs/[id]/route.ts` at all (PATCH only), so the plan's
 * `apiJson(request, "/api/orgs/{id}")` read would be a 405; and `GET /api/orgs`
 * carries `timezone` but neither `default_locale` nor `currency`.
 */
async function readOrgDefaults(orgId: string): Promise<OrgDefaults> {
  return withDb(async (sql) => {
    const [row] = await sql<OrgDefaults[]>`
      select timezone, default_locale, currency from organizations where id = ${orgId}`;
    if (!row) throw new Error(`readOrgDefaults: no organizations row for ${orgId}`);
    return row;
  });
}

// ---------------------------------------------------------------------------
// Page-driving helpers
// ---------------------------------------------------------------------------

/**
 * The Save button belonging to `control`.
 *
 * The preferences tab renders THREE separate org forms in one `<section>`, each
 * with its own "Save", so scoping to the section is not enough. Playwright
 * returns matches in document order and an ancestor precedes its descendant, so
 * `.last()` on "divs containing both this control and a Save" is the innermost
 * such div — the component's own root.
 */
function saveNear(page: Page, control: Locator): Locator {
  return page
    .locator("div")
    .filter({ has: control })
    .filter({ has: page.getByRole("button", { name: /^Sav/ }) })
    .last()
    .getByRole("button", { name: /^Sav/ });
}

/**
 * An option value this `<select>` is not already showing.
 *
 * Derived from the control's OWN options rather than a list typed into the
 * test, so that widening `REGISTRATION_CURRENCIES` or `LOCALES` moves this test
 * with the source of truth instead of leaving it asserting yesterday's set
 * (AGENTS.md failure class 19).
 */
async function pickDifferentOption(select: Locator): Promise<string> {
  const current = await select.inputValue();
  const values = await select
    .locator("option")
    .evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
  const next = values.find((v) => v !== current && v !== "");
  if (!next) {
    throw new Error(`pickDifferentOption: no alternative to "${current}" in [${values.join(", ")}]`);
  }
  return next;
}

/** Drive the searchable timezone picker: open, type, take the named row. */
async function pickZone(page: Page, combobox: Locator, city: string): Promise<void> {
  await combobox.click();
  // Closed it is a <button role=combobox>; open it is an <input role=combobox>.
  // The locator re-resolves, which is why the same handle can be filled.
  await combobox.fill(city);
  const row = page.getByRole("option", { name: new RegExp(city) }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
}

// ---------------------------------------------------------------------------
// One org for the whole FILE — see settings-support.ts on why not per test.
// ---------------------------------------------------------------------------

let org: SeededOrg;
let userId = "";
let originalProfile: Profile;
/** A competition in the seeded org, so the api tab's pin control renders. */
let competition: { id: string; name: string };

test.beforeAll(async ({ browser }) => {
  const ctx = await browser.newContext();
  try {
    // Never rebuild the signed-in address from TAG — TAG is per PROCESS, so a
    // `where email = …` seed from a spec worker names an account auth.setup.ts
    // never created. Ask the app who it is.
    const whoami = await apiJson<{ id: string }>(ctx.request, "/api/users/me");
    expect(whoami.data?.id, "GET /api/users/me carried no id").toBeTruthy();
    userId = whoami.data!.id;
    originalProfile = await readProfile(userId);

    org = await seedSettingsOrg(ctx.request, { label: "people-tabs" });

    // `POST /api/orgs` calls `setActiveOrgId`, so the seeded org is ACTIVE in
    // THIS context's cookie jar. `POST /api/v1/competitions` resolves the org
    // from the session's active org, so the competition has to be created here:
    // a per-test `page` context starts fresh from `pro.json`, where the active
    // org is still the shared Pro one, and would file it against that instead.
    const name = `Settings W2 pin ${TAG}`;
    const created = await apiJson<{ id: string }>(ctx.request, "/api/v1/competitions", "POST", {
      name,
      ends_on: "2030-12-31",
      visibility: "public",
    });
    expect(
      created.status,
      `seeding a competition failed: ${created.status} ${JSON.stringify(created.error)}`,
    ).toBeLessThan(300);
    competition = { id: created.data!.id, name };
  } finally {
    await ctx.close();
  }
});

test.afterAll(async ({ browser }) => {
  // Safety net for the shared user. It runs AFTER the verification test at the
  // bottom of this file (a root-suite afterAll runs once every test in the file
  // has finished), so it cannot make that test vacuous — it only stops a failed
  // restore from also breaking a stranger's spec.
  if (userId && originalProfile) {
    const now = await readProfile(userId);
    const drifted =
      now.display_name !== originalProfile.display_name ||
      now.timezone !== originalProfile.timezone ||
      now.locale !== originalProfile.locale;
    if (drifted) {
      await withDb(
        (sql) => sql`
          update users set
            display_name = ${originalProfile.display_name},
            timezone     = ${originalProfile.timezone},
            locale       = ${originalProfile.locale}
          where id = ${userId}`,
      );
    }
  }

  if (org) {
    const ctx = await browser.newContext();
    try {
      await releaseSettingsOrg(ctx.request, org);
    } finally {
      await ctx.close();
    }
  }
});

// ---------------------------------------------------------------------------
// An unknown tab
// ---------------------------------------------------------------------------

test("an unknown ?tab= lands on the organisation panel, not an empty page", async ({ page }) => {
  // `SETTINGS_TABS.includes(rawTab) ? rawTab : "organization"` — settings/page.tsx.
  await page.goto(settingsUrl(org.slug, "bogus"));

  // Scoped to the settings rail on purpose: the app shell marks its own
  // current page, so a bare `[aria-current="page"]` resolves to TWO elements
  // here. That is two navigation landmarks each naming their own position, not
  // the duplicate `aria-current` settings-nav.tsx warns about (its phone shape
  // reuses one set of links rather than rendering a second).
  const rail = page.locator("nav").filter({ has: page.getByRole("link", { name: "Platform API" }) });
  const current = rail.locator('[aria-current="page"]');
  await expect(current).toHaveCount(1, { timeout: 20_000 });
  await expect(current).toHaveText(/Organisation/i);

  // ...and the probe can tell the tabs apart. Without this pair the assertion
  // above would pass just as happily on a rail that always marks the first tab.
  await page.goto(settingsUrl(org.slug, "api"));
  await expect(rail.locator('[aria-current="page"]')).toHaveText(/Platform API/i, {
    timeout: 20_000,
  });
});

// ---------------------------------------------------------------------------
// team
// ---------------------------------------------------------------------------

interface InviteRow {
  id: string;
  token: string;
  email: string | null;
  role: string;
  revoked: boolean;
  used_count: number;
  max_uses: number;
}

test("team tab: an email invite is really accepted, the new member's role changes, and a link revokes", async ({
  page,
  browser,
}) => {
  // Budget: 1 goto + 2 reloads + an anonymous claim + ~8 API reads. Expressed
  // as a sum rather than a flat constant so adding a step moves the budget.
  const NAVIGATIONS = 6;
  const API_READS = 10;
  test.setTimeout(Math.max(60_000, 15_000 + NAVIGATIONS * 6_000 + API_READS * 1_500));

  const memberEmail = `e2e-w2-member-${TAG}-${Math.random().toString(36).slice(2, 6)}@example.com`;
  const invitesUrl = `/api/orgs/${org.orgId}/invites`;
  const readInvites = async () =>
    (await apiJson<InviteRow[]>(page.request, invitesUrl)).data ?? [];
  const liveLinks = (rows: InviteRow[]) => rows.filter((i) => !i.email && !i.revoked);

  await page.goto(settingsUrl(org.slug, "team"));

  // ── invite by email, through the form ────────────────────────────────────
  await page.getByPlaceholder("name@club.org").fill(memberEmail);
  await page.getByTestId("team-invite-email-role").selectOption("viewer");
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes("/invites") && r.request().method() === "POST" && r.ok(),
    ),
    page.getByRole("button", { name: "Send invite" }).click(),
  ]);

  const emailInvite = (await readInvites()).find((i) => i.email === memberEmail);
  expect(emailInvite, `no invite row was stored for ${memberEmail}`).toBeTruthy();
  expect(emailInvite!.role).toBe("viewer");

  // ── a real person accepts it ─────────────────────────────────────────────
  // An invite nobody can accept is a row, not a feature. `browser.newContext()`
  // on its own INHERITS the project storageState (the authed owner's session),
  // so a "fresh" visitor would silently be the owner again and the claim would
  // prove nothing. Spell out empty storage.
  const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const claimed = await anon.request.post(`/api/invites/${emailInvite!.token}/claim`, {
      data: {},
    });
    expect(claimed.ok(), `claiming the invite failed: ${claimed.status()}`).toBe(true);
    const body = (await claimed.json()) as { data: { needs_signin: boolean; org_id: string } };
    expect(body.data.needs_signin).toBe(false);
    expect(body.data.org_id).toBe(org.orgId);
  } finally {
    await anon.close();
  }

  // ── change their role ────────────────────────────────────────────────────
  await page.reload();
  // The member row is the one carrying a role <select>: an email-invite row
  // shows a static badge instead, so this cannot latch onto the invite.
  const memberRow = page
    .locator("li")
    .filter({ hasText: memberEmail })
    .filter({ has: page.getByRole("combobox") });
  await expect(memberRow).toBeVisible({ timeout: 20_000 });
  const roleSelect = memberRow.getByRole("combobox");
  await expect(roleSelect).toHaveValue("viewer");

  await Promise.all([
    page.waitForResponse(
      (r) => /\/members\/[^/]+\/role$/.test(r.url()) && r.request().method() === "POST" && r.ok(),
    ),
    roleSelect.selectOption("admin"),
  ]);

  const members =
    (await apiJson<{ email: string; role: string }[]>(page.request, `/api/orgs/${org.orgId}/members`))
      .data ?? [];
  expect(
    members.find((m) => m.email === memberEmail)?.role,
    "the role change did not reach the members record",
  ).toBe("admin");

  // ── invite by link, and a double tap must not mint two ───────────────────
  await page.getByTestId("team-invite-link-role").selectOption("scorer");
  const before = liveLinks(await readInvites());
  const beforeLinks = before.length;
  const beforeTokens = new Set(before.map((i) => i.token));

  const createLink = page.getByRole("button", { name: /Create link/ });
  await createLink.dblclick();
  // The button re-enables once `busy` clears AND the reload it triggers has
  // landed, so every in-flight create has finished by the time we count.
  await expect(createLink).toBeEnabled({ timeout: 20_000 });
  await expect
    .poll(async () => liveLinks(await readInvites()).length, { timeout: 20_000 })
    .toBeGreaterThan(beforeLinks);

  const afterDouble = liveLinks(await readInvites());
  expect(
    afterDouble.length,
    "a double tap on Create link minted more than one invite",
  ).toBe(beforeLinks + 1);
  const doomed = afterDouble.find((i) => !beforeTokens.has(i.token));
  expect(doomed, "the link invite the double tap created could not be identified").toBeTruthy();
  // The role the picker was on, not merely the default — a create that ignored
  // the select would still have produced exactly one row.
  expect(doomed!.role).toBe("scorer");

  // A sibling, so the revoke below has a positive pair to survive it.
  await page.getByTestId("team-invite-link-role").selectOption("admin");
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes("/invites") && r.request().method() === "POST" && r.ok(),
    ),
    page.getByRole("button", { name: /Create link/ }).click(),
  ]);
  const survivor = liveLinks(await readInvites()).find((i) => i.role === "admin");
  expect(survivor, "the sibling link invite was not created").toBeTruthy();

  // ── revoke one link ──────────────────────────────────────────────────────
  await page.reload();
  // Link rows render the token masked as `/join/xxxx…yyyy`; the leading four
  // characters make the row deterministic without depending on wording.
  const doomedRow = page.locator("li").filter({ hasText: doomed!.token.slice(0, 4) });
  await expect(doomedRow).toBeVisible({ timeout: 20_000 });
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes("/revoke") && r.request().method() === "POST" && r.ok(),
    ),
    doomedRow.getByRole("button", { name: "Revoke" }).click(),
  ]);

  const afterRevoke = await readInvites();
  // The negative...
  expect(
    liveLinks(afterRevoke).some((i) => i.token === doomed!.token),
    "the revoked link is still live",
  ).toBe(false);
  // ...and its positive pair: a route that revoked everything would otherwise
  // read as a pass.
  expect(
    liveLinks(afterRevoke).some((i) => i.token === survivor!.token),
    "revoking one link took its sibling with it",
  ).toBe(true);
});

// ---------------------------------------------------------------------------
// api
// ---------------------------------------------------------------------------

test("api tab: a minted key shows its secret once, actually works, and dies when revoked", async ({
  page,
  playwright,
}) => {
  const keyName = `W2 key ${TAG}`;
  await page.goto(settingsUrl(org.slug, "api"));

  // Every field the panel offers: name, scope, and the competition pin — which
  // renders at all only because beforeAll gave the org a competition
  // (`competitions.length > 0`, api-keys.tsx).
  await page.getByPlaceholder(/Key name/).fill(keyName);
  await page.locator('input[name="key-scope"][value="read"]').check();
  const pin = page.locator("#key-pin");
  await expect(pin, "the competition pin never rendered").toBeVisible({ timeout: 20_000 });
  await pin.selectOption(competition.id);

  await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes("/api-keys") && r.request().method() === "POST" && r.ok(),
    ),
    page.getByRole("button", { name: "Create key" }).click(),
  ]);

  // ── the secret, shown exactly once ───────────────────────────────────────
  const secretBox = page.locator("code").filter({ hasText: /^sc_/ });
  await expect(secretBox).toBeVisible({ timeout: 20_000 });
  const secret = (await secretBox.innerText()).trim();
  expect(secret).toMatch(/^sc_/);

  // ── does it WORK? ────────────────────────────────────────────────────────
  // A row appearing in a list is not the property a customer cares about. This
  // context carries NO cookies, so a 200 below can only have been the key.
  const pinnedUrl = `/api/v1/competitions/${competition.id}`;
  // `storageState` spelled out on BOTH. `playwright.request.newContext()`
  // inherits the project's `use.storageState` exactly as `browser.newContext()`
  // does, so a context left bare here is SIGNED IN as the shared Pro owner —
  // who is a member of this org. The 401 below then reads 200 and the whole
  // test degrades into "a logged-in owner can read their own competition",
  // which is not the claim.
  const EMPTY = { cookies: [], origins: [] };
  const keyed = await playwright.request.newContext({
    storageState: EMPTY,
    extraHTTPHeaders: { Authorization: `Bearer ${secret}` },
  });
  const bare = await playwright.request.newContext({ storageState: EMPTY });
  try {
    const withKey = await keyed.get(pinnedUrl);
    expect(withKey.status(), "the freshly minted key was refused").toBe(200);
    const got = ((await withKey.json()) as { data: { id: string } }).data;
    expect(got.id, "the key read back a different competition").toBe(competition.id);

    // The PIN is not decoration, and this is the assertion that says so. A
    // pinned key is 403 on any rule with no `pin` resolver — the org-wide
    // surface (`key-scopes.ts`: `GET /competitions` carries no pin). Asserting
    // only the 200 above would pass just as happily on a key whose pin was
    // dropped on the way to the server, which is the failure this control
    // exists to prevent.
    expect(
      (await keyed.get("/api/v1/competitions")).status(),
      "a competition-pinned key could still enumerate the whole org",
    ).toBe(403);

    // The honesty pair: the same call unauthenticated is refused, so the 200
    // above cannot have come from an ambient session.
    expect((await bare.get(pinnedUrl)).status()).toBe(401);

    // ── shown ONCE ─────────────────────────────────────────────────────────
    await page.getByRole("button", { name: /dismiss/i }).click();
    await expect(secretBox).toHaveCount(0);
    await page.reload();
    await expect(page.getByText(secret)).toHaveCount(0, { timeout: 20_000 });
    // The key itself is still listed — it is the SECRET that is gone, not the key.
    await expect(page.getByText(keyName).first()).toBeVisible({ timeout: 20_000 });

    // ── revoke, and watch it stop working ──────────────────────────────────
    const keyRow = page.locator("li").filter({ hasText: keyName });
    await keyRow.getByRole("button", { name: "Revoke" }).click();
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/api-keys/") && r.request().method() === "DELETE" && r.ok(),
      ),
      page
        .getByRole("alertdialog")
        .getByRole("button", { name: "Revoke key" })
        .click(),
    ]);

    await expect
      .poll(async () => (await keyed.get(pinnedUrl)).status(), { timeout: 20_000 })
      .toBe(401);
  } finally {
    await keyed.dispose();
    await bare.dispose();
  }
});

// ---------------------------------------------------------------------------
// preferences — the ORGANISATION half (safe: it writes the seeded org)
// ---------------------------------------------------------------------------

test("preferences tab: the org's timezone, public language and entry-fee currency persist", async ({
  page,
}) => {
  await page.goto(settingsUrl(org.slug, "preferences"));

  const orgTz = page.getByRole("combobox", { name: "Organisation scheduling timezone" });
  const orgLang = page.getByRole("combobox", { name: "Organisation public language" });
  const orgCurrency = page.getByRole("combobox", { name: "Entry fee currency" });

  await expect(orgTz).toBeVisible({ timeout: 20_000 });
  const nextLang = await pickDifferentOption(orgLang);
  const nextCurrency = await pickDifferentOption(orgCurrency);

  // Each control owns its own Save — three forms, one section.
  await pickZone(page, orgTz, "Kolkata");
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "PATCH" && r.ok()),
    saveNear(page, orgTz).click(),
  ]);

  await orgLang.selectOption(nextLang);
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "PATCH" && r.ok()),
    saveNear(page, orgLang).click(),
  ]);

  await orgCurrency.selectOption(nextCurrency);
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "PATCH" && r.ok()),
    saveNear(page, orgCurrency).click(),
  ]);

  // Persistence is a question for the store...
  await expect
    .poll(() => readOrgDefaults(org.orgId), { timeout: 20_000 })
    .toEqual({
      timezone: "Asia/Kolkata",
      default_locale: nextLang,
      currency: nextCurrency,
    });

  // ...and render-back is the ONE reload this tab gets.
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Organisation scheduling timezone" })).toContainText(
    "Kolkata",
    { timeout: 20_000 },
  );
  await expect(page.getByRole("combobox", { name: "Organisation public language" })).toHaveValue(
    nextLang,
  );
  await expect(page.getByRole("combobox", { name: "Entry fee currency" })).toHaveValue(nextCurrency);
});

// ---------------------------------------------------------------------------
// The SHARED Pro user's own fields. Everything in here is borrowed.
// ---------------------------------------------------------------------------

test.describe("the shared Pro user's own profile", () => {
  /**
   * Restored in `afterAll`, NEVER in a `finally` inside a test — a Playwright
   * `test.setTimeout` skips `finally`, and what leaks is not this spec's
   * problem but the next spec's: every walkthrough in the leg is signed in as
   * this same account.
   */
  test.afterAll(async ({ browser }) => {
    const ctx = await browser.newContext();
    try {
      const res = await ctx.request.patch("/api/users/me", {
        headers: { "Content-Type": "application/json" },
        data: {
          // `updateProfileSchema` wants a non-empty display name and a locale
          // inside its enum; fall back rather than 400 the restore itself.
          display_name: originalProfile.display_name?.trim() || "E2e Pro",
          timezone: originalProfile.timezone,
          locale: ["en", "fr", "es", "nl"].includes(originalProfile.locale ?? "")
            ? originalProfile.locale
            : null,
        },
      });
      expect(res.ok(), `restoring the shared Pro user failed: ${res.status()}`).toBe(true);
    } finally {
      await ctx.close();
    }
  });

  // Account BEFORE the language flip below, on purpose: switching the user's
  // locale re-renders every English label on the page, so it is the last thing
  // this file does to the shared account.
  test("account tab: the display name persists, and the export carries it", async ({ page }) => {
    const wanted = `W2 Walkthrough ${TAG}`;
    await page.goto(settingsUrl(org.slug, "account"));

    const input = page.getByPlaceholder("Your name");
    await expect(input).toBeVisible({ timeout: 20_000 });
    await input.fill(wanted);

    const profileForm = page.locator("form").filter({ has: page.getByPlaceholder("Your name") });
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/api/users/me") && r.request().method() === "PATCH" && r.ok(),
      ),
      profileForm.getByRole("button", { name: /^Sav/ }).click(),
    ]);

    // The store...
    await expect
      .poll(async () => (await readProfile(userId)).display_name, { timeout: 20_000 })
      .toBe(wanted);

    // ...the product's own read of it (this tab's Download JSON target)...
    const exported = await page.request.get("/api/users/me/export");
    expect(exported.status()).toBe(200);
    const bundle = (await exported.json()) as { profile?: { display_name?: string } };
    expect(bundle.profile?.display_name).toBe(wanted);
    await expect(page.getByRole("link", { name: "Download JSON" })).toHaveAttribute(
      "href",
      "/api/users/me/export",
    );

    // ...and one reload for render-back.
    await page.reload();
    await expect(page.getByPlaceholder("Your name")).toHaveValue(wanted, { timeout: 20_000 });
  });

  test("preferences tab: your own timezone and language persist", async ({ page }) => {
    await page.goto(settingsUrl(org.slug, "preferences"));

    const myTz = page.getByRole("combobox", { name: "Your timezone" });
    await expect(myTz).toBeVisible({ timeout: 20_000 });

    // Pick a zone the account is not already on, so a save that does nothing
    // cannot pass by coincidence.
    const city = originalProfile.timezone === "Asia/Kolkata" ? "Lisbon" : "Kolkata";
    const zone = city === "Lisbon" ? "Europe/Lisbon" : "Asia/Kolkata";

    await pickZone(page, myTz, city);
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/api/users/me") && r.request().method() === "PATCH" && r.ok(),
      ),
      saveNear(page, myTz).click(),
    ]);
    await expect
      .poll(async () => (await readProfile(userId)).timezone, { timeout: 20_000 })
      .toBe(zone);

    await page.reload();
    await expect(page.getByRole("combobox", { name: "Your timezone" })).toContainText(city, {
      timeout: 20_000,
    });

    // The language goes LAST. It repaints the interface, so every assertion
    // after it is deliberately language-agnostic.
    const myLang = page.getByRole("combobox", { name: "Your language" });
    const nextLang = await pickDifferentOption(myLang);
    await myLang.selectOption(nextLang);
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/api/users/me") && r.request().method() === "PATCH" && r.ok(),
      ),
      saveNear(page, myLang).click(),
    ]);
    await expect
      .poll(async () => (await readProfile(userId)).locale, { timeout: 20_000 })
      .toBe(nextLang);
  });
});

// ---------------------------------------------------------------------------
// The restore, proven
// ---------------------------------------------------------------------------

/**
 * Declared after the describe above, so it runs after that group's `afterAll`.
 * Without this the restore is an unverified claim and the next spec in the leg
 * inherits whatever this one happened to leave behind.
 */
test("the shared Pro user's display name, timezone and locale came back", async ({ page }) => {
  expect(await readProfile(userId)).toEqual(originalProfile);

  // And what a PERSON sees, not only what the column holds.
  await page.goto(settingsUrl(org.slug, "account"));
  await expect(page.getByPlaceholder("Your name")).toHaveValue(originalProfile.display_name, {
    timeout: 20_000,
  });
});
