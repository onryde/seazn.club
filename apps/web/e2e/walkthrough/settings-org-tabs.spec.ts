import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  seedSettingsOrg,
  releaseSettingsOrg,
  settingsUrl,
  type SeededOrg,
} from "../settings-support";
import { apiJson, TAG } from "../helpers";
import { BRAND_PALETTE } from "../../src/lib/brand-palette";

/**
 * W2 of the settings walkthrough programme — the organisation, news and
 * sponsor-CRUD tabs of `/o/{org}/settings`, driven the way an organiser drives
 * them and then read back through an API that is not the writer's own echo.
 *
 * This surface had NO behavioural e2e before this file: `tab=sponsors` appeared
 * exactly once in the whole suite (`mobile.spec.ts`, a layout scan) and
 * `tab=news` not at all.
 *
 * SCOPE: the sponsors CRUD half only. Every control in `sponsor-packages.tsx`
 * (sell / invoice / refund) is the monetize half — it needs the shared Connect
 * fixture account, which has no release path and which crashes smoke's
 * sponsor-checkout suite while another org holds it. Logo upload is out too:
 * it needs a storage round trip and belongs with the other upload surfaces.
 *
 * `mode: "default"`, not the ambient behaviour and not `serial`:
 *
 *  - playwright.config.ts sets `fullyParallel: true` and the walkthrough leg
 *    runs at `--workers=3`, so WITHOUT this line Playwright spreads this file's
 *    tests across workers — and `beforeAll` runs once PER WORKER. That would
 *    seed one org per worker against a shared Pro user who may own five in
 *    total (`orgs.max_owned`; `assertMayOwnAnotherOrg` bounds a PERSON, not a
 *    group) with `org-management.spec.ts` already spending one every run. The
 *    fourth seed 402s.
 *  - `default` rather than `serial` because serial SKIPS every test after the
 *    first red. This file exists to find defects on an uncovered surface; a
 *    cascade that hides the second one is the opposite of what it is for
 *    (AGENTS.md failure class 21 — a serial file's failure count is a floor).
 *
 * WHAT `mode: "default"` DOES NOT BUY, observed here rather than assumed:
 * Playwright discards a worker after a FAILING test and starts a fresh one for
 * the rest of the file, so `beforeAll` runs again and this file seeds another
 * org — "one org per file" is really one per worker GENERATION, and a run with
 * four reds seeds four. That is safe, and was checked rather than reasoned
 * about: after two all-red runs every `e2e-pro-*` user still owned exactly one
 * org, because each generation's `afterAll` released its own. It matters only
 * if a release is ever made conditional.
 */
test.describe.configure({ mode: "default" });

/**
 * Copy read from the dictionary the page renders from, never retyped here — a
 * test carrying its own copy of a string asserts yesterday's wording and goes
 * red on a rewrite that broke nothing (this folder's idiom: settings-admin.spec.ts:11,
 * division-delete.spec.ts:19).
 */
const UI_EN: Record<string, string> = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
);

/** `msg()`'s `{name}` interpolation, for the aria-labels that carry one. Throws
 *  on a missing key: a renamed key must red loudly here rather than quietly
 *  resolve to a locator that matches nothing and times out somewhere else. */
function ui(key: string, vars: Record<string, string | number> = {}): string {
  const raw = UI_EN[key];
  if (raw === undefined) throw new Error(`missing en dictionary key: ${key}`);
  return raw.replace(/\{(\w+)\}/g, (_m, k: string) => String(vars[k] ?? `{${k}}`));
}

// Field labels.
//
// NOTHING here is reached with `getByLabel`, deliberately. Every field on these
// panels sits inside a WRAPPING <label> that also holds the control itself, and
// Playwright resolves a wrapping label by its text CONTENT — which folds in the
// control's own text (a <select>'s option labels; an <input>'s value once it is
// prefilled, as the sponsor edit form's always is). A locator written that way
// works on the empty add form and silently stops matching on the edit form.
// Fields are located as "the input inside the label that says X" instead, and
// the two SponsorForm selects by an option VALUE — which also disambiguates
// them from `sponsor-packages.tsx`, whose Tier and Competition labels come from
// the SAME two dictionary keys and which renders for any org with
// `sponsors.monetize`.
const L = {
  sponsorName: ui("settings.org.sponsors.name"),
  sponsorLink: ui("settings.org.sponsors.link"),
  addSponsor: ui("settings.org.sponsors.add"),
  saveSponsor: ui("sponsors.save"),
  orgSave: ui("settings.org.save"),
  aboutSave: ui("settings.org.about.save"),
  aboutBox: ui("settings.org.about.placeholder"),
  newsBody: ui("news.composer.bodyPlaceholder"),
  newsDelete: ui("news.delete"),
  newsArchive: ui("news.archive"),
} as const;

/**
 * Any palette entry, derived from the palette itself rather than typed in — a
 * swatch removed or recoloured moves this test with it instead of leaving it
 * asserting yesterday's hex (AGENTS.md failure class 19). The LAST entry so it
 * is never the leading "default" chip, whose stored value is null.
 */
const SWATCH = BRAND_PALETTE[BRAND_PALETTE.length - 1]!;
const SWATCH_LABEL = ui(`swatch.${SWATCH.name}`);

/**
 * Test budgets expressed in what the test actually does, never a flat constant
 * beside a derived cost (Global Constraint 9). A settings navigation is a cold
 * server render of a tab that runs its own per-tab queries; a "commit" is one
 * UI mutation — click, network round trip, and the list refresh behind it.
 */
const NAV_MS = 20_000;
const COMMIT_MS = 9_000;
const budget = (navs: number, commits: number): number =>
  Math.max(60_000, 15_000 + navs * NAV_MS + commits * COMMIT_MS);

const READ_MS = 20_000;

interface SponsorRow {
  id: string;
  name: string;
  url: string | null;
  tier: string;
  competition_id: string | null;
  display_order: number;
}

interface PostRow {
  id: string;
  title: string;
  status: string;
  kind: string;
  competition_id: string | null;
  body_md: string;
}

interface OrgListRow {
  id: string;
  name: string;
  slug: string;
  branding: { colors?: { primary?: string | null } } | null;
}

/**
 * One org for the whole FILE (settings-support.ts explains why not per test),
 * plus one competition on it.
 *
 * The competition is not decoration: `scope` is one of the four sponsor fields
 * this task owes, and with no competition the scope <select> holds exactly one
 * option ("All competitions"). Driving it would then be a no-op that passes
 * whatever the control does — a reachability assertion satisfied by any value,
 * which is the shape AGENTS.md failure class 19 exists to warn about.
 */
let org: SeededOrg;
let comp: { id: string; name: string };

test.beforeAll(async ({ browser }) => {
  const ctx = await browser.newContext();
  try {
    org = await seedSettingsOrg(ctx.request, { label: "org-tabs" });
    // `POST /api/v1/competitions` authenticates through `requireAuth`, which
    // resolves the ACTIVE org — it takes no org id. This works here precisely
    // because `seedSettingsOrg` just moved `seazn_org` in THIS context's cookie
    // jar onto the org it created (settings-support.ts, finding C). It would
    // land on the shared Pro org from anywhere else.
    const name = `W2 sponsors ${TAG}`;
    const created = await apiJson<{ id: string; name: string }>(
      ctx.request,
      "/api/v1/competitions",
      "POST",
      { name, ends_on: "2030-12-31" },
    );
    if (!created.data) {
      throw new Error(
        `beforeAll: POST /api/v1/competitions failed (${created.status}) ${
          created.error?.message ?? ""
        }`.trim(),
      );
    }
    comp = { id: created.data.id, name: created.data.name };
  } finally {
    await ctx.close();
  }
});

test.afterAll(async ({ browser }) => {
  // Global Constraint 6: the release lives here and NOT in a `finally` inside a
  // test. A Playwright `test.setTimeout` does not unwind the test function, so
  // a `finally` there never runs — and a leaked seed spends one of the shared
  // Pro user's five owner slots for the rest of the leg.
  if (!org) return;
  const ctx = await browser.newContext();
  try {
    await releaseSettingsOrg(ctx.request, org);
  } finally {
    await ctx.close();
  }
});

// --- reads that are not the writer's own echo -------------------------------

async function listSponsors(request: APIRequestContext): Promise<SponsorRow[]> {
  const res = await apiJson<SponsorRow[]>(request, `/api/v1/orgs/${org.orgId}/sponsors`);
  expect(res.status, "GET /api/v1/orgs/{id}/sponsors").toBe(200);
  // `apiJson` swallows a body-parse failure and hands back `data: undefined`,
  // so without this a 200 carrying a broken envelope would degrade every
  // downstream assertion to `expect(undefined)` and pass vacuously.
  expect(res.data, "sponsors read must carry rows").toBeDefined();
  return res.data!;
}

async function listPosts(request: APIRequestContext): Promise<PostRow[]> {
  const res = await apiJson<PostRow[]>(request, `/api/v1/orgs/${org.orgId}/posts`);
  expect(res.status, "GET /api/v1/orgs/{id}/posts").toBe(200);
  expect(res.data, "posts read must carry rows").toBeDefined();
  return res.data!;
}

/**
 * The organisation row as the SERVER sees it.
 *
 * `GET /api/orgs` (getUserOrgs) is the only read API that returns an org's
 * `branding` — `/api/orgs/{id}` has a PATCH and nothing else, so there is no
 * per-org GET at all, and `about` is exposed by no API in the app (it is read
 * only by the settings page's own server query and by the public org page).
 * That is why `about` below is proven by the tab's one reload rather than by a
 * second API: the read the plan's sketch assumed does not exist.
 */
async function orgRow(request: APIRequestContext): Promise<OrgListRow> {
  const res = await apiJson<OrgListRow[]>(request, "/api/orgs");
  expect(res.status, "GET /api/orgs").toBe(200);
  const row = res.data?.find((o) => o.id === org.orgId);
  expect(row, `GET /api/orgs must list the seeded org ${org.orgId}`).toBeDefined();
  return row!;
}

/**
 * TipTap is a contenteditable, not an <input> — click it and type, which is
 * also what drives its `onUpdate` → `getMarkdown()` round trip.
 *
 * The explicit attach wait is not ceremony. `ProseEditor` sets
 * `immediatelyRender: false`, so this element is created by a client effect and
 * does not exist in the server HTML at all — and ONCE, in ~10 runs of this
 * file, the news composer's editor never appeared: `composer-title`,
 * `composer-kind` and `composer-scope` had all been driven successfully, and
 * this locator then waited out the WHOLE remaining test budget (91s) and
 * reported a bare "waiting for getByRole('textbox')". It has not reproduced in
 * the nine runs since. Bounding the wait at READ_MS keeps that shape from
 * eating a test's entire clock and mislabelling itself as something else
 * (AGENTS.md failure class 20), and names the editor as the thing that is
 * missing rather than the click as the thing that failed.
 */
async function typeProse(page: Page, accessibleName: string, text: string): Promise<void> {
  const box = page.getByRole("textbox", { name: accessibleName });
  await expect(box, `the ${accessibleName} editor must mount`).toBeAttached({ timeout: READ_MS });
  await box.click();
  await page.keyboard.type(text);
}

/** The input inside the wrapping <label> whose own copy says `label`. See the
 *  note on `L` for why this is not `getByLabel`. */
function field(scope: Page | ReturnType<Page["locator"]>, label: string) {
  return scope.locator("label").filter({ hasText: label }).locator("input");
}

// ---------------------------------------------------------------------------
// ORGANISATION
// ---------------------------------------------------------------------------

test("organisation tab: about and brand colour persist, and an unknown tab lands here", async ({
  page,
}) => {
  test.setTimeout(budget(3, 2));

  const about = `Wanderers of ${TAG} founded in a garage.`;

  // Case 24's W2 share, folded in as a per-tab assertion rather than a test of
  // its own: page.tsx:119 falls an unrecognised `?tab=` back to "organization"
  // (`SETTINGS_TABS.includes(rawTab) ? rawTab : "organization"`). Nothing else
  // on the settings page renders `org-identity-name`, so this is a real probe
  // of WHICH panel came back — not merely that the route was a 200.
  await page.goto(settingsUrl(org.slug, "bogus"));
  await expect(page.getByTestId("org-identity-name")).toHaveText(org.name, { timeout: READ_MS });

  await page.goto(settingsUrl(org.slug, "organization"));

  // Brand colour is a swatch picker, not a text field: `OrgBrandColor` PATCHes
  // `{ branding: { colors: { primary } } }` on SELECT, with no save button.
  const chip = page.getByRole("button", { name: SWATCH_LABEL, exact: true });
  await expect(chip, "Pro org must get the colour picker, not the upsell").toBeVisible({
    timeout: READ_MS,
  });
  const colourPatch = page.waitForResponse(
    (r) => r.url().includes(`/api/orgs/${org.orgId}`) && r.request().method() === "PATCH",
  );
  await chip.click();
  expect((await colourPatch).status(), "brand colour PATCH").toBe(200);

  // Count only the PATCHes that carry `about`, so the brand-colour write above
  // cannot be mistaken for a second save of this one.
  let aboutPatches = 0;
  page.on("request", (r) => {
    if (r.method() !== "PATCH" || !r.url().includes(`/api/orgs/${org.orgId}`)) return;
    const body = r.postDataJSON() as Record<string, unknown> | null;
    if (body && "about" in body) aboutPatches++;
  });

  await typeProse(page, L.aboutBox, about);
  const saveAbout = page.getByRole("button", { name: L.aboutSave, exact: true });
  const aboutPatch = page.waitForResponse(
    (r) =>
      r.url().includes(`/api/orgs/${org.orgId}`) &&
      r.request().method() === "PATCH" &&
      "about" in ((r.request().postDataJSON() as Record<string, unknown> | null) ?? {}),
  );
  await saveAbout.click();
  expect((await aboutPatch).status(), "about PATCH").toBe(200);

  // Double-submit, case 24's other W2 share: `disabled={!dirty || busy}` must
  // put the control out of reach the moment it is used. `dirty` also goes false
  // on success, so the button stays disabled after the save settles — a second
  // save is unreachable, and exactly one write left the page.
  await expect(saveAbout, "Save must disable itself while/after saving").toBeDisabled();
  expect(aboutPatches, "one click on Save must produce exactly one write").toBe(1);

  // "Did it persist" — an API read, and NOT the PATCH's own echo.
  await expect
    .poll(async () => (await orgRow(page.request)).branding?.colors?.primary, {
      timeout: READ_MS,
      message: "brand colour must be readable back off GET /api/orgs",
    })
    .toBe(SWATCH.hex);

  // "Does it render back" — the ONE reload this tab gets.
  await page.reload();
  await expect(page.getByRole("textbox", { name: L.aboutBox })).toContainText(about, {
    timeout: READ_MS,
  });
  await expect(
    page.getByRole("button", { name: SWATCH_LABEL, exact: true }),
    "the saved swatch must come back selected",
  ).toHaveAttribute("aria-pressed", "true");
});

// ---------------------------------------------------------------------------
// NEWS
// ---------------------------------------------------------------------------

test("news tab: compose a draft, publish it, archive it, then delete only it", async ({ page }) => {
  test.setTimeout(budget(2, 4));

  const title = `Season opener ${TAG}`;
  const body = `The first fixture of ${TAG} kicks off on Saturday.`;

  // The delete below needs a POSITIVE pair: a sibling that must SURVIVE it.
  // Without one, a route that deleted every post would read as a pass.
  const siblingTitle = `Committee notes ${TAG}`;
  const sibling = await apiJson<PostRow>(
    page.request,
    `/api/v1/orgs/${org.orgId}/posts`,
    "POST",
    { title: siblingTitle },
  );
  expect(sibling.status, "seed the sibling post").toBe(201);

  await page.goto(settingsUrl(org.slug, "news"));
  await page.getByTestId("news-new").click();

  await page.getByTestId("composer-title").fill(title);
  await page.getByTestId("composer-kind").selectOption("announcement");
  await page.getByTestId("composer-scope").selectOption(comp.id);
  await typeProse(page, L.newsBody, body);

  const created = page.waitForResponse(
    (r) =>
      r.url().includes(`/api/v1/orgs/${org.orgId}/posts`) && r.request().method() === "POST",
  );
  await page.getByTestId("composer-save").click();
  expect((await created).status(), "compose a draft").toBe(201);

  // "Did it persist": every field the composer carried, read back off the API.
  await expect
    .poll(async () => (await listPosts(page.request)).some((p) => p.title === title), {
      timeout: READ_MS,
      message: "the composed draft must appear in GET /api/v1/orgs/{id}/posts",
    })
    .toBe(true);
  const draft = (await listPosts(page.request)).find((p) => p.title === title)!;
  expect(draft.status, "a composed post starts as a draft").toBe("draft");
  expect(draft.kind, "the kind picker's value").toBe("announcement");
  expect(draft.competition_id, "the scope picker's value").toBe(comp.id);
  expect(draft.body_md, "the prose editor's markdown").toContain(body);

  // "Does it render back": the ONE reload this tab gets.
  await page.reload();
  const draftRow = page.getByTestId("draft-row").filter({ hasText: title });
  await expect(draftRow).toBeVisible({ timeout: READ_MS });

  // Publish.
  const published = page.waitForResponse(
    (r) => r.url().includes(`/api/v1/posts/${draft.id}`) && r.request().method() === "PATCH",
  );
  await draftRow.getByTestId("draft-publish").click();
  expect((await published).status(), "publish").toBe(200);
  await expect
    .poll(async () => (await listPosts(page.request)).find((p) => p.id === draft.id)?.status, {
      timeout: READ_MS,
      message: "publish must move the post's status",
    })
    .toBe("published");

  const publishedRow = page.getByTestId("published-row").filter({ hasText: title });
  await expect(publishedRow).toBeVisible({ timeout: READ_MS });

  // Archive.
  const archived = page.waitForResponse(
    (r) => r.url().includes(`/api/v1/posts/${draft.id}`) && r.request().method() === "PATCH",
  );
  await publishedRow.getByRole("button", { name: L.newsArchive, exact: true }).click();
  expect((await archived).status(), "archive").toBe(200);
  await expect
    .poll(async () => (await listPosts(page.request)).find((p) => p.id === draft.id)?.status, {
      timeout: READ_MS,
      message: "archive must move the post's status",
    })
    .toBe("archived");

  // Delete, last, because it removes its own subject. The archived list is
  // folded behind a <details> — open it before reaching for the row.
  await page.getByTestId("news-archived").locator("summary").click();
  const archivedRow = page.getByTestId("archived-row").filter({ hasText: title });
  await expect(archivedRow).toBeVisible({ timeout: READ_MS });
  const deleted = page.waitForResponse(
    (r) => r.url().includes(`/api/v1/posts/${draft.id}`) && r.request().method() === "DELETE",
  );
  await archivedRow.getByRole("button", { name: L.newsDelete, exact: true }).click();
  expect((await deleted).status(), "delete").toBe(204);

  // The negative AND its positive pair: the subject is gone, the sibling is not.
  await expect
    .poll(async () => (await listPosts(page.request)).some((p) => p.title === title), {
      timeout: READ_MS,
      message: "the deleted post must leave the org's post list",
    })
    .toBe(false);
  const after = await listPosts(page.request);
  expect(after.map((p) => p.title), "the deleted post is gone").not.toContain(title);
  expect(after.map((p) => p.title), "its sibling survived").toContain(siblingTitle);
});

// ---------------------------------------------------------------------------
// SPONSORS (CRUD half)
// ---------------------------------------------------------------------------

test("sponsors tab: add three, reorder, edit tier and scope, delete only one", async ({ page }) => {
  test.setTimeout(budget(2, 6));

  const A = `Alpha Tools ${TAG}`;
  const B = `Bravo Bakery ${TAG}`;
  const C = `Charlie Cycles ${TAG}`;
  const B2 = `Bravo Bakery & Co ${TAG}`;

  await page.goto(settingsUrl(org.slug, "sponsors"));

  // DOM order on this tab is: OrgSponsors' add form, then its rows (each of
  // which becomes an edit form in place), then SponsorPackages. So `.first()`
  // on a field is always the add form — including while a row is being edited,
  // where the edit form is the SECOND match and the packages form the third.
  const addName = field(page, L.sponsorName).first();
  const addLink = field(page, L.sponsorLink).first();
  // The tier select is the one offering "gold"; the scope select is the one
  // offering this org's competition.
  const addTier = page
    .locator("select")
    .filter({ has: page.locator('option[value="gold"]') })
    .first();
  const addScope = page
    .locator("select")
    .filter({ has: page.locator(`option[value="${comp.id}"]`) })
    .first();
  const addButton = page.getByRole("button", { name: L.addSponsor, exact: true });

  await expect(addName, "Pro org must get the sponsor manager").toBeVisible({ timeout: READ_MS });
  await expect(addTier, "sponsors.tiers is Pro — the tier select must render").toBeVisible();
  await expect(addScope, "sponsors.tiers is Pro — the scope select must render").toBeVisible();

  async function addSponsor(name: string, link: string, double = false): Promise<void> {
    await addName.fill(name);
    await addLink.fill(link);
    const posted = page.waitForResponse(
      (r) =>
        r.url().endsWith(`/api/v1/orgs/${org.orgId}/sponsors`) && r.request().method() === "POST",
    );
    // Double-submit, case 24's W2 share, applied where a repeat actually HARMS:
    // two POSTs here are two sponsor rows on the public pages. `disabled={busy
    // || !value.name.trim()}` plus the `setDraft(EMPTY_DRAFT)` on success is the
    // guard; the row count below is what proves it held.
    if (double) await addButton.dblclick();
    else await addButton.click();
    expect((await posted).status(), `create ${name}`).toBe(201);
    await expect(page.getByText(name, { exact: false }).first()).toBeVisible({ timeout: READ_MS });
  }

  await addSponsor(A, "alpha-tools.example.com", true);
  await addSponsor(B, "bravo-bakery.example.com");
  await addSponsor(C, "charlie-cycles.example.com");

  const mine = (rows: SponsorRow[]): SponsorRow[] => rows.filter((s) => s.name.endsWith(TAG));

  // Persistence, and the double-submit's real question: THREE rows, not four.
  await expect
    .poll(async () => mine(await listSponsors(page.request)).map((s) => s.name), {
      timeout: READ_MS,
      message: "three adds, one of them double-clicked, must leave three rows",
    })
    .toEqual([A, B, C]);
  const seeded = mine(await listSponsors(page.request));
  expect(seeded[0]!.url, "the link field is normalised to https:// and stored").toBe(
    "https://alpha-tools.example.com",
  );
  expect(seeded.map((s) => s.tier), "the tier select's default").toEqual([
    "partner",
    "partner",
    "partner",
  ]);

  // --- reorder: witness the ORDER, not that the list still has three members.
  const reordered = page.waitForResponse(
    (r) => r.url().includes(`/sponsors/reorder`) && r.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: ui("settings.org.sponsors.moveUp", { name: C }), exact: true })
    .click();
  expect((await reordered).status(), "reorder").toBe(200);
  await expect
    .poll(async () => mine(await listSponsors(page.request)).map((s) => s.name), {
      timeout: READ_MS,
      message: "moving the third sponsor up must read back as [A, C, B]",
    })
    .toEqual([A, C, B]);

  // "Does it render back" — the ONE reload this tab gets. Read the rendered
  // ORDER out of the list, not merely its membership.
  await page.reload();
  await expect
    .poll(
      async () =>
        (await page.locator("li").filter({ hasText: TAG }).allInnerTexts())
          .map((t) => [A, B, C].find((n) => t.includes(n)))
          .filter((n): n is string => !!n),
      { timeout: READ_MS, message: "the saved order must render back" },
    )
    .toEqual([A, C, B]);

  // --- edit: name, link, tier and scope, on the row that is now in the middle.
  await page
    .getByRole("button", { name: ui("sponsors.edit", { name: B }), exact: true })
    .click();
  // Exactly one <li> holds a sponsor-name field at a time: the row being edited.
  const editRow = page
    .locator("li")
    .filter({ has: page.locator("label").filter({ hasText: L.sponsorName }) });
  await field(editRow, L.sponsorName).fill(B2);
  await field(editRow, L.sponsorLink).fill("bravo-bakery.example.org");
  await editRow
    .locator("select")
    .filter({ has: page.locator('option[value="gold"]') })
    .selectOption("gold");
  await editRow
    .locator("select")
    .filter({ has: page.locator(`option[value="${comp.id}"]`) })
    .selectOption(comp.id);
  const patched = page.waitForResponse(
    (r) => /\/sponsors\/[0-9a-f-]{36}$/.test(r.url()) && r.request().method() === "PATCH",
  );
  await editRow.getByRole("button", { name: L.saveSponsor, exact: true }).click();
  expect((await patched).status(), "edit").toBe(200);

  await expect
    .poll(
      async () => {
        const row = mine(await listSponsors(page.request)).find((s) => s.name === B2);
        return row && {
          name: row.name,
          url: row.url,
          tier: row.tier,
          competition_id: row.competition_id,
        };
      },
      { timeout: READ_MS, message: "every edited field must persist together" },
    )
    .toEqual({
      name: B2,
      url: "https://bravo-bakery.example.org",
      tier: "gold",
      competition_id: comp.id,
    });

  // --- delete, last, because it removes its own subject.
  const removed = page.waitForResponse(
    (r) => /\/sponsors\/[0-9a-f-]{36}$/.test(r.url()) && r.request().method() === "DELETE",
  );
  await page
    .getByRole("button", { name: ui("settings.org.sponsors.remove", { name: C }), exact: true })
    .click();
  expect((await removed).status(), "delete").toBe(200);

  // The negative AND its positive pair: C is gone, A and the edited B survived.
  await expect
    .poll(async () => mine(await listSponsors(page.request)).map((s) => s.name).sort(), {
      timeout: READ_MS,
      message: "delete must remove its own subject and leave its siblings",
    })
    .toEqual([A, B2].sort());
});

// ---------------------------------------------------------------------------
// ORGANISATION — rename, LAST, because it moves the org's slug
// ---------------------------------------------------------------------------

test("organisation tab: a rename regenerates the slug and the page follows it", async ({
  page,
}) => {
  test.setTimeout(budget(1, 1));

  const renamed = `Renamed ${TAG} FC`;
  await page.goto(settingsUrl(org.slug, "organization"));

  // Scoped to the rename block: OrgRename's wrapping <label> holds the Save
  // button as well as the input, so its text content is not just its own copy.
  const nameField = page.locator('[data-tour="org-rename"]').locator("input");
  await expect(nameField).toHaveValue(org.name, { timeout: READ_MS });
  await nameField.fill(renamed);

  const patch = page.waitForResponse(
    (r) => r.url().includes(`/api/orgs/${org.orgId}`) && r.request().method() === "PATCH",
  );
  // Scoped to the rename block: `settings.org.save` is "Save", and an unscoped
  // exact match would be ambiguous the moment another control on this tab
  // gains one.
  await page
    .locator('[data-tour="org-rename"]')
    .getByRole("button", { name: L.orgSave, exact: true })
    .click();
  const res = await patch;
  expect(res.status(), "rename PATCH").toBe(200);
  const newSlug = ((await res.json()) as { data: { slug: string } }).data.slug;
  expect(newSlug, "a rename regenerates the slug (PROMPT-30)").not.toBe(org.slug);

  // The component `router.replace`s onto the new slug — the old URL would 301
  // for anyone else still holding it, but the organiser's own tab must move.
  await page.waitForURL(new RegExp(`/o/${newSlug}/settings`), { timeout: READ_MS });

  // "Did it persist": an API read, not the PATCH's echo.
  await expect
    .poll(async () => (await orgRow(page.request)).name, {
      timeout: READ_MS,
      message: "the new name must be readable back off GET /api/orgs",
    })
    .toBe(renamed);
  expect((await orgRow(page.request)).slug, "…and so must the new slug").toBe(newSlug);

  // "Does it render back": `router.refresh()` re-runs the server component, so
  // the identity row is a real re-read rather than client state.
  await expect(page.getByTestId("org-identity-name")).toHaveText(renamed, { timeout: READ_MS });

  // Keep the file's shared handle honest for anything that runs after this.
  org.slug = newSlug;
  org.name = renamed;
});
