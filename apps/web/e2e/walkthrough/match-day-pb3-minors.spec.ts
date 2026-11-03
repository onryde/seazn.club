import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  TAG,
  addEntrantsViaApi,
  apiJson,
  competitionPath,
  createStageAndGenerate,
  expectNoHorizontalScroll,
  invalidateOrgEntitlements,
  setEntitlementOverrideSql,
  setOrgPlanBySql,
  withDb,
} from "../helpers";
import { dismissConsent, freshOrg } from "../directory-kit";
import { uiEn, fill } from "../match-room-kit";

/**
 * Match Day PB3 - the minors batch, TAPPED. One organiser per test, on an organisation of their own (the shared e2e organisation's
 * plan and caps must never move), in a real browser, at the widths each change owes (the UI bar: 1280 / 768 / 320, plus 1024 for the
 * New competition form).
 *
 *   Item 1  The grey hint in the four editors that never drew one: the org About box, the payment instructions, the news composer and
 *           the competition settings description. Each is checked the way a person meets it: the hint is on screen, it is the house
 *           placeholder grey (read off a real input's own ::placeholder, not a colour typed here), it is gone with the first
 *           keystroke, it is never part of what is SAVED (typed text goes in as typed, an emptied box saves nothing - the stored value
 *           is read back from the database), and it comes back when the box is emptied again.
 *   Item 2  A billing-FROZEN competition's run sheet still offers Settle on a held match (a level knockout game), while the timetable
 *           stays frozen (no Set time) - and the Settle goes to the fixture page's decision panel. The positive pair is the same
 *           competition before the freeze.
 *   Item 6  The New competition form's "Who will find it" checklist when the plan's public limit is FULL: it says, in the product's
 *           words, that this one will be created private, names the way out, and the competition the organiser then creates really IS
 *           private. A free slot has no such note.
 *   Item 7  The Match Day banner on a frozen competition names the competitions that are frozen (this one first, then up to three in
 *           all, then "+N more") - the set the SERVER stored, read back from the database - and each name beside this one is a link to
 *           its own competition.
 *
 * Expected values come from the dictionaries and the database, never from the code under test. Hard budgets are derived from the
 * counts of navigations and taps, not a flat literal.
 */

const NAV_MS = 20_000;
const ACT_MS = 2_500;
const budget = (navs: number, acts: number) => Math.max(90_000, navs * NAV_MS + acts * ACT_MS);

/** A brand-new user is shown onboarding and the product tour over the org home (a dialog that intercepts every tap): mark both done, as auth.setup does. */
async function skipTour(page: Page): Promise<void> {
  await page.request.post("/api/onboarding/complete", { data: {} }).catch(() => undefined);
  const res = await page.request.post("/api/tour", { data: {} });
  expect(res.status(), "the tour is marked seen").toBeLessThan(300);
}

const orgSlugOf = (orgId: string): Promise<string> =>
  withDb(async (sql) => (await sql<{ slug: string }[]>`select slug from organizations where id = ${orgId}`)[0]!.slug);

/** The house placeholder grey, read off a real input's own `::placeholder` (the `.input` class is the house field). */
async function houseGrey(page: Page): Promise<string> {
  return page.evaluate(() => {
    const probe = document.createElement("input");
    probe.className = "input";
    probe.placeholder = "probe";
    document.body.appendChild(probe);
    const color = getComputedStyle(probe, "::placeholder").color;
    probe.remove();
    return color;
  });
}

// ── Item 1 ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The first line of a (possibly multi-line) hint: what a computed `content` string must show, whatever it does with line breaks. */
const firstLine = (hint: string): string => hint.split("\n")[0]!;

interface HintBox {
  label: string;
  /** The dictionary key of the hint the box must draw. */
  key: string;
  /** The dictionary key of the copy that LABELS the box on screen: its accessible name (PB3 review C1 - the hint is not the name). */
  labelKey: string;
  /** The editor's contenteditable on the page the person is on. */
  editor: (page: Page) => Locator;
  /** Type `text` in, press the box's own save, and return what is STORED (database). */
  saveTyped: (page: Page, text: string) => Promise<string | null>;
  /** Press the box's own save with the box EMPTY, and return what is stored. */
  saveEmpty: (page: Page) => Promise<string | null>;
  /** A box that closes on save (the news composer) is opened again before it is emptied. */
  reopen?: (page: Page) => Promise<void>;
}

const EDITOR = (page: Page): Locator => page.locator('[contenteditable="true"][aria-placeholder]');

async function prove(page: Page, box: HintBox, width: number): Promise<void> {
  const hint = uiEn[box.key]!;
  expect(hint, `${box.label}: the dictionary has a hint`).toBeTruthy();
  const editor = box.editor(page);
  await expect(editor, `${box.label}: the editor is on the page`).toBeVisible({ timeout: NAV_MS });
  await expect(editor).toHaveAttribute("aria-placeholder", hint);
  // The box is NAMED by its own label, found the way a screen reader finds it: by role and name. Never the generic fallback (the payment
  // box and the news body are not "Description"s), and the hint is the placeholder, not the name.
  const name = uiEn[box.labelKey]!;
  expect(name, `${box.label}: the dictionary has the label`).toBeTruthy();
  await expect(editor, `${box.label}: the box's accessible name is its own label`).toHaveAttribute("aria-label", name);
  await expect(page.getByRole("textbox", { name, exact: true }), `${box.label}: the one textbox with that name`).toHaveCount(1);
  expect(name, `${box.label}: the hint is not the name`).not.toBe(hint);
  if (box.labelKey !== "compset.description") expect(name, `${box.label}: not the generic fallback`).not.toBe(uiEn["editor.description"]);

  // Drawn, in the house grey, inside the viewport.
  const empty = editor.locator("p.is-editor-empty");
  await expect(empty, `${box.label}: an empty editor draws its hint`).toHaveCount(1);
  expect(await empty.getAttribute("data-placeholder"), `${box.label}: the hint is the dictionary's sentence, verbatim`).toBe(hint);
  const drawn = await empty.evaluate((el) => {
    const b = getComputedStyle(el, "::before");
    return { content: b.content, color: b.color, whiteSpace: b.whiteSpace };
  });
  expect(drawn.content, `${box.label}: the ::before shows the sentence`).toContain(firstLine(hint));
  const grey = await houseGrey(page);
  expect(grey, "anti-vacuity: a real colour").not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  expect(drawn.color, `${box.label}: the hint is the house placeholder grey`).toBe(grey);
  if (hint.includes("\n")) expect(drawn.whiteSpace, `${box.label}: a several-line example keeps its line breaks`).toBe("pre-line");
  const vw = page.viewportSize()!.width;
  const rect = (await empty.boundingBox())!;
  expect(rect.height, `${box.label}: the hint takes room on screen`).toBeGreaterThan(8);
  expect(rect.x + rect.width, `${box.label}: the hint stays inside the ${width}px screen`).toBeLessThanOrEqual(vw + 1);
  await expectNoHorizontalScroll(page);

  // The first keystroke removes it, and it is never document text.
  const typed = `PB3 ${box.label} ${TAG}`;
  await editor.click();
  await page.keyboard.type(typed);
  await expect(empty, `${box.label}: typing removes the hint`).toHaveCount(0);
  expect(await editor.evaluate((el) => el.textContent ?? ""), `${box.label}: the hint is not text in the box`).not.toContain(firstLine(hint));

  // Saved as typed, with no hint in it.
  const stored = await box.saveTyped(page, typed);
  expect(stored, `${box.label}: what was typed is what was saved`).toBe(typed);
  expect(stored, `${box.label}: the hint is not in the saved value`).not.toContain(firstLine(hint));

  // Emptied again: the hint is back (the box is empty, so it says what goes in it) - and saving the empty box stores nothing.
  if (box.reopen) await box.reopen(page);
  await expect(editor, `${box.label}: the editor is back for the empty pass`).toBeVisible({ timeout: NAV_MS });
  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  await expect(empty, `${box.label}: an emptied box draws its hint again`).toHaveCount(1);
  const storedEmpty = await box.saveEmpty(page);
  expect(storedEmpty ?? "", `${box.label}: an empty box saves nothing, not its hint`).toBe("");
}

for (const width of [1280, 768, 320] as const) {
  test(`item 1 at ${width}: the org About, payment instructions, news composer and competition description each draw a grey hint that is gone on typing and never saved`, async ({
    page,
  }) => {
    test.setTimeout(budget(8, 60));
    await page.setViewportSize({ width, height: width === 320 ? 640 : 900 });
    const { orgId } = await freshOrg(page, `h1w${width}`);
    await dismissConsent(page);
    await skipTour(page);
    await setOrgPlanBySql({ orgId }, "pro");
    await invalidateOrgEntitlements(page.request, orgId);
    const slug = await orgSlugOf(orgId);
    const comp = await apiJson<{ id: string; slug: string }>(page.request, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `Hint ${width} ${TAG}`,
      visibility: "private",
    });
    expect(comp.status, `competition: ${JSON.stringify(comp.error)}`).toBe(201);

    const orgValue = (column: "about" | "payment_instructions") => async (): Promise<string | null> =>
      withDb(async (sql) => (await sql<Record<string, string | null>[]>`select ${sql(column)} as v from organizations where id = ${orgId}`)[0]!.v);

    const descriptionOf = async (): Promise<string | null> =>
      (await withDb((sql) => sql<{ description: string | null }[]>`select description from competitions where id = ${comp.data!.id}`))[0]!.description;

    const boxes: HintBox[] = [
      {
        label: "about",
        key: "settings.org.about.placeholder",
        labelKey: "settings.org.about",
        editor: EDITOR,
        saveTyped: async (p) => {
          await p.getByRole("button", { name: uiEn["settings.org.about.save"]!, exact: true }).click();
          await expect.poll(orgValue("about"), { timeout: NAV_MS }).not.toBeNull();
          return orgValue("about")();
        },
        saveEmpty: async (p) => {
          await p.getByRole("button", { name: uiEn["settings.org.about.save"]!, exact: true }).click();
          await expect.poll(async () => (await orgValue("about")()) ?? "", { timeout: NAV_MS }).toBe("");
          return orgValue("about")();
        },
      },
      {
        label: "payment",
        key: "pay.cashPlaceholder",
        labelKey: "pay.cashTitle",
        editor: EDITOR,
        saveTyped: async (p) => {
          await p.getByRole("button", { name: uiEn["pay.save"]!, exact: true }).click();
          await expect.poll(orgValue("payment_instructions"), { timeout: NAV_MS }).not.toBeNull();
          return orgValue("payment_instructions")();
        },
        saveEmpty: async (p) => {
          await p.getByRole("button", { name: uiEn["pay.save"]!, exact: true }).click();
          await expect.poll(async () => (await orgValue("payment_instructions")()) ?? "", { timeout: NAV_MS }).toBe("");
          return orgValue("payment_instructions")();
        },
      },
      {
        label: "news",
        key: "news.composer.bodyPlaceholder",
        labelKey: "news.composer.body",
        editor: EDITOR,
        // The composer closes after a save: the empty pass is a SECOND post, opened afresh (reopen), whose body is the empty box.
        saveTyped: async (p, text) => {
          await p.getByTestId("composer-title").fill(`Post ${TAG}`);
          await p.getByTestId("composer-save").click();
          await expect(p.getByTestId("news-composer")).toHaveCount(0, { timeout: NAV_MS });
          const rows = await withDb((sql) => sql<{ body_md: string }[]>`select body_md from org_posts where org_id = ${orgId} order by created_at desc limit 1`);
          expect(rows[0]!.body_md).toBe(text);
          return rows[0]!.body_md;
        },
        reopen: async (p) => {
          await p.getByTestId("news-new").click();
          await expect(p.getByTestId("news-composer")).toBeVisible({ timeout: NAV_MS });
          await expect(EDITOR(p).locator("p.is-editor-empty"), "news: a fresh composer draws the hint").toHaveCount(1);
        },
        saveEmpty: async (p) => {
          await p.getByTestId("composer-title").fill(`Empty ${TAG}`);
          await p.getByTestId("composer-save").click();
          await expect(p.getByTestId("news-composer")).toHaveCount(0, { timeout: NAV_MS });
          const rows = await withDb((sql) => sql<{ body_md: string; title: string }[]>`select body_md, title from org_posts where org_id = ${orgId} order by created_at desc limit 1`);
          expect(rows[0]!.title, "the newest post is the empty one").toBe(`Empty ${TAG}`);
          return rows[0]!.body_md;
        },
      },
      {
        label: "competition",
        key: "compset.descriptionPlaceholder",
        labelKey: "compset.description",
        editor: EDITOR,
        // The DB is polled, not the "Saved." line: the first save leaves it on screen, so it cannot witness the second.
        saveTyped: async (p) => {
          await p.getByRole("button", { name: uiEn["compset.save"]!, exact: true }).click();
          await expect.poll(descriptionOf, { timeout: NAV_MS }).not.toBeNull();
          return descriptionOf();
        },
        saveEmpty: async (p) => {
          await p.getByRole("button", { name: uiEn["compset.save"]!, exact: true }).click();
          await expect.poll(async () => (await descriptionOf()) ?? "", { timeout: NAV_MS }).toBe("");
          return descriptionOf();
        },
      },
    ];

    let proved = 0;
    for (const box of boxes) {
      const url =
        box.label === "about"
          ? `/o/${slug}/settings`
          : box.label === "payment"
            ? `/o/${slug}/settings/connect`
            : box.label === "news"
              ? `/o/${slug}/settings?tab=news`
              : `/o/${slug}/c/${comp.data!.slug}/settings`;
      await page.goto(url, { waitUntil: "load" });
      if (box.label === "news") await page.getByTestId("news-new").click();
      await prove(page, box, width);
      proved++;
    }
    expect(proved, "all four boxes were proved").toBe(4);
  });
}

// ── Item 2 ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

for (const width of [1280, 320] as const) {
  test(`item 2 at ${width}: a billing-frozen competition's run sheet still offers Settle on a held match, keeps the timetable frozen, and Settle opens the decision`, async ({
    page,
  }) => {
    test.setTimeout(budget(6, 40));
    await page.setViewportSize({ width, height: width === 320 ? 640 : 900 });
    const { orgId } = await freshOrg(page, `h2w${width}`);
    await dismissConsent(page);
    await skipTour(page);
    await setOrgPlanBySql({ orgId }, "pro");
    await invalidateOrgEntitlements(page.request, orgId);

    // A knockout of four: both semi-finals have their entrants. One is HELD (a level game with nothing to decide it); the other is
    // simply waiting with no time.
    const comp = await apiJson<{ id: string }>(page.request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `Held ${width} ${TAG}`, visibility: "private" });
    expect(comp.status, `competition: ${JSON.stringify(comp.error)}`).toBe(201);
    const div = await apiJson<{ id: string }>(page.request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", { name: "Cup", sport_key: "generic", variant_key: "score" });
    expect(div.status, `division: ${JSON.stringify(div.error)}`).toBe(201);
    const ents = await addEntrantsViaApi(page.request, div.data!.id, ["Ana", "Ben", "Cal", "Dee"].map((n) => `${n} ${TAG}`));
    expect(ents.ids).toHaveLength(4);
    await createStageAndGenerate(page.request, div.data!.id, { kind: "knockout", name: "Cup" });
    const started = await apiJson(page.request, `/api/v1/divisions/${div.data!.id}/start`, "POST");
    expect(started.status, `division start: ${JSON.stringify(started.error)}`).toBeLessThan(300);
    const semis = await withDb((sql) => sql<{ id: string; fixture_no: number }[]>`
      select id, fixture_no from fixtures where division_id = ${div.data!.id} and home_entrant_id is not null and away_entrant_id is not null order by fixture_no`);
    expect(semis, "a four-entrant knockout opens with two semi-finals").toHaveLength(2);
    const held = semis[0]!;
    const waiting = semis[1]!;
    await withDb((sql) => sql`update fixtures set status = 'needs_decision', outcome = ${sql.json({ kind: "draw" })} where id = ${held.id}`);

    const fixturesTab = async () => {
      await page.goto(`${await competitionPath(page.request, comp.data!.id)}/d/${await divSlug(div.data!.id)}?tab=fixtures`, { waitUntil: "load" });
      await expect(page.locator(`li[data-fixture-no="${held.fixture_no}"]`), "the held match is on the run sheet").toBeVisible({ timeout: NAV_MS });
    };
    const divSlug = async (id: string) => (await withDb((sql) => sql<{ slug: string }[]>`select slug from divisions where id = ${id}`))[0]!.slug;
    const heldRow = () => page.locator(`li[data-fixture-no="${held.fixture_no}"]`);
    const waitingRow = () => page.locator(`li[data-fixture-no="${waiting.fixture_no}"]`);

    // BEFORE the freeze (the positive pair): the organiser can Settle the held match and Set a time on the waiting one.
    await fixturesTab();
    await expect(heldRow().locator('[data-row-action="decide"]'), "unfrozen: Settle is offered").toHaveText(uiEn["runsheet.action.decide"]!);
    await expect(waitingRow().locator('[data-row-action="set_time"]'), "unfrozen: the waiting match can be given a time").toHaveCount(1);
    await expect(page.getByText(uiEn["chip.frozen"]!, { exact: true }), "unfrozen: no read-only chip").toHaveCount(0);

    // FREEZE it for real: a newer competition holds the one running place under a limit of one.
    const newer = await apiJson<{ id: string }>(page.request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `Running ${width} ${TAG}`, visibility: "private" });
    expect(newer.status, `the running competition: ${JSON.stringify(newer.error)}`).toBe(201);
    await setEntitlementOverrideSql(orgId, "competitions.max_active", 1);
    await invalidateOrgEntitlements(page.request, orgId);

    await fixturesTab();
    expect(
      await withDb(async (sql) => (await sql<{ id: string }[]>`select id from competitions where org_id = ${orgId} and frozen_at is not null`).map((r) => r.id)),
      "the server froze this competition (stored), not the newer one",
    ).toEqual([comp.data!.id]);
    await expect(page.getByText(uiEn["chip.frozen"]!, { exact: true }).first(), "frozen: the read-only chip says so").toBeVisible();
    // Settle is still offered, as the same Settle, on the same row.
    const decide = heldRow().locator('[data-row-action="decide"]');
    await expect(decide, "frozen: Settle is still offered on the held match").toHaveText(uiEn["runsheet.action.decide"]!);
    expect((await decide.boundingBox())!.height, "a 44px target").toBeGreaterThanOrEqual(43.5);
    // ...while the timetable stays frozen: no Set time on the waiting match, and the held row offers nothing but its one action.
    await expect(waitingRow().locator('[data-row-action="set_time"]'), "frozen: no Set time (the timetable is still frozen)").toHaveCount(0);
    await expect(waitingRow().locator('[data-row-action="view"]'), "frozen: the waiting match offers View instead (positive pair)").toHaveCount(1);
    await expectNoHorizontalScroll(page);

    // Tap it: the fixture page's decision panel, with its Settle button live.
    await decide.click();
    await expect(page).toHaveURL(new RegExp(`/f/${held.fixture_no}(\\?|$)`), { timeout: NAV_MS });
    await expect(page.getByTestId("needs-decision"), "the fixture page asks for the decision").toBeVisible({ timeout: NAV_MS });
    await expect(page.getByTestId("settle-open"), "and the button to settle it is live on a frozen competition").toBeEnabled();
    await expectNoHorizontalScroll(page);
  });
}

// ── Item 6 ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

type Audience = (typeof REACH_AUDIENCES)[number];
type State = "yes" | "no" | "after_publish";
const REACH_AUDIENCES = ["team", "link", "org", "search", "showcase"] as const;
/** The listing rule for a NEW competition (born a draft), written out as the C8 walkthrough writes it. */
const REACH: Record<"private" | "unlisted" | "public", Record<Audience, State>> = {
  private: { team: "yes", link: "no", org: "no", search: "no", showcase: "no" },
  unlisted: { team: "yes", link: "yes", org: "no", search: "no", showcase: "no" },
  public: { team: "yes", link: "yes", org: "after_publish", search: "after_publish", showcase: "no" },
};

for (const width of [1280, 1024, 768, 320] as const) {
  test(`item 6 at ${width}: with the public limit full, Public and Link only say this one will be created private and how to get out - and it really is created private`, async ({
    page,
  }) => {
    test.setTimeout(budget(5, 40));
    await page.setViewportSize({ width, height: width === 320 ? 640 : 900 });
    const { orgId } = await freshOrg(page, `h6w${width}`);
    await dismissConsent(page);
    await skipTour(page);
    const slug = await orgSlugOf(orgId);
    // A real full cap: a limit of one public competition, and room for the second competition the test creates.
    await setEntitlementOverrideSql(orgId, "dashboard.public.max", 1);
    await setEntitlementOverrideSql(orgId, "competitions.max_active", 50);
    await invalidateOrgEntitlements(page.request, orgId);
    // The way out the note names exists on this plan: the next plan up lifts the limit (read from the matrix, not typed here).
    const pro = await withDb((sql) => sql<{ int_value: number | null }[]>`select int_value from plan_entitlements where plan_key = 'pro' and feature_key = 'dashboard.public.max'`);
    expect(pro, "the plan matrix has a Pro public limit").toHaveLength(1);
    expect(pro[0]!.int_value === null || pro[0]!.int_value > 1, "Pro lifts a limit of one, so the note offers the upgrade").toBe(true);

    const openForm = async (): Promise<Locator> => {
      await page.goto(`/o/${slug}`, { waitUntil: "load" });
      await page.getByRole("link", { name: /new competition/i }).first().click();
      await page.waitForURL(new RegExp(`/o/${slug}/c/new$`), { timeout: NAV_MS });
      await expect(page.getByTestId("template-gallery")).toBeVisible({ timeout: NAV_MS });
      await page.getByTestId("template-start-blank").click();
      const form = page.getByTestId("new-competition-form");
      await expect(form).toBeVisible({ timeout: NAV_MS });
      return form;
    };
    const pick = async (form: Locator, v: "private" | "unlisted" | "public") => {
      const radio = page.getByRole("radio", { name: uiEn[`visibility.${v}.label`]!, exact: true });
      await form.locator("label").filter({ has: radio }).click();
      await expect(radio).toBeChecked();
    };
    const expectReach = async (form: Locator, expected: Record<Audience, State>, why: string) => {
      const rows = form.getByTestId("competition-reach").locator("li[data-audience]");
      await expect(rows, `${why}: five audiences (anti-vacuity)`).toHaveCount(REACH_AUDIENCES.length);
      for (const [i, audience] of REACH_AUDIENCES.entries()) {
        await expect(rows.nth(i), `${why}: ${audience}`).toHaveAttribute("data-state", expected[audience]);
      }
    };

    // 1. The slot is FREE: the form opens on Public, promises its reach, and carries no note (the positive pair).
    let form = await openForm();
    await expect(form.getByRole("radio", { name: uiEn["visibility.public.label"]!, exact: true })).toBeChecked();
    await expect(form.getByTestId("public-cap-note"), "a free slot: no note").toHaveCount(0);
    await expectReach(form, REACH.public, "free slot, Public");
    // ... and the two other places the form speaks of reach keep their promise while a slot is free: the line under the segments, and a
    // Showcase switch that can be turned on.
    const consequence = form.getByTestId("visibility-consequence");
    const showcase = form.getByRole("switch", { name: uiEn["showcase.label"]!, exact: true });
    await expect(consequence, "free slot: Public's line promises the listing").toHaveText(uiEn["visibility.public.consequence"]!);
    await expect(showcase, "free slot: Showcase can be turned on").toBeEnabled();

    // 2. Fill the slot with a real public competition. Only a PUBLISHED one holds a place under dashboard.public.max (a draft does
    //    not: the meter counts "actually published" dashboards), so the holder is published, by the row, as the unit test does.
    const holder = await apiJson<{ id: string }>(page.request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `Holder ${width} ${TAG}`, visibility: "public" });
    expect(holder.status, `the holder: ${JSON.stringify(holder.error)}`).toBe(201);
    await withDb((sql) => sql`update competitions set status = 'published' where id = ${holder.data!.id}`);
    expect(
      (await withDb((sql) => sql<{ visibility: string; status: string }[]>`select visibility, status from competitions where id = ${holder.data!.id}`))[0],
      "premise: the first public competition really is public and published (it took the slot)",
    ).toEqual({ visibility: "public", status: "published" });

    // 3. The slot is TAKEN: Public and Link only say what will really happen; Private says nothing.
    form = await openForm();
    await expect(form.getByRole("radio", { name: uiEn["visibility.public.label"]!, exact: true }), "it opens on Public").toBeChecked();
    await expectNoHorizontalScroll(page);
    let checkedNotes = 0;
    for (const v of ["public", "unlisted"] as const) {
      await pick(form, v);
      const note = form.getByTestId("public-cap-note");
      await expect(note, `${v}: the cap note is shown`).toBeVisible();
      await expect(note).toContainText(uiEn["comp.wizard.reach.capped.title"]!);
      await expect(note, `${v}: the note names the limit`).toContainText(fill("comp.wizard.reach.capped.body", { limit: "1" }));
      await expect(note.getByRole("link", { name: uiEn["comp.wizard.reach.capped.upgrade"]!, exact: true }), `${v}: and the way out`).toHaveAttribute(
        "href",
        `/o/${slug}/settings/billing`,
      );
      // The note names the audience in the checklist's own words (the members of the organisation), never "team" (owner, C8).
      const rowWords = uiEn["comp.wizard.reach.team"]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      await expect(note, `${v}: the note names the row's audience`).toHaveText(new RegExp(rowWords, "i"));
      await expect(note, `${v}: and does not say "team"`).not.toHaveText(/\bteam\b/i);
      // The checklist tells the truth: only members of the organisation will find it.
      await expectReach(form, REACH.private, `${v} over the cap`);
      // So do the other two places the form speaks of reach (PB3 review m5): the line under the segments stops promising the listing,
      // the link and search engines; the Showcase switch is off, with the CAP as its reason.
      await expect(consequence, `${v}: the line under the segments says it is created private`).toHaveText(uiEn["visibility.capped.consequence"]!);
      await expect(consequence, `${v}: and no longer promises the old reach`).not.toHaveText(uiEn[`visibility.${v}.consequence`]!);
      await expect(showcase, `${v}: Showcase cannot be turned on`).toBeDisabled();
      await expect(form.getByText(uiEn["comp.wizard.showcase.capped"]!, { exact: true }), `${v}: the reason is the cap`).toBeVisible();
      await expect(form.getByText(uiEn["showcase.needsPublic"]!), `${v}: not "set visibility to public" under a Public that is selected`).toHaveCount(0);
      checkedNotes++;
    }
    expect(checkedNotes, "both visibilities that take a public place were checked").toBe(2);
    await pick(form, "private");
    await expect(form.getByTestId("public-cap-note"), "private: nothing to warn about").toHaveCount(0);
    await expectReach(form, REACH.private, "Private");
    await expect(consequence, "private: its own line, as it always was").toHaveText(uiEn["visibility.private.consequence"]!);
    await expect(form.getByText(uiEn["showcase.needsPublic"]!), "private: the old reason, as it always was").toBeVisible();
    // Back on Public: the note is back, in the screen, with a 44px way out and no sideways scroll.
    await pick(form, "public");
    const note = form.getByTestId("public-cap-note");
    const upgrade = note.getByRole("link", { name: uiEn["comp.wizard.reach.capped.upgrade"]!, exact: true });
    expect((await upgrade.boundingBox())!.height, "a 44px target").toBeGreaterThanOrEqual(43.5);
    const box = (await note.boundingBox())!;
    expect(box.x, "the note starts on screen").toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, "and ends on screen").toBeLessThanOrEqual(page.viewportSize()!.width + 1);
    await expectNoHorizontalScroll(page);

    // 4. The promise is kept: create it as Public and it comes out PRIVATE.
    const name = `Capped ${width} ${TAG}`;
    await form.getByPlaceholder(uiEn["comp.wizard.name.placeholder"]!).fill(name);
    await form.getByLabel(new RegExp(`^${uiEn["comp.wizard.endsOn"]}`)).fill("2030-06-12");
    const made = page.waitForResponse((r) => r.request().method() === "POST" && /\/api\/v1\/competitions$/.test(new URL(r.url()).pathname));
    await form.getByRole("button", { name: uiEn["comp.wizard.create"]!, exact: true }).click();
    const created = (await (await made).json()) as { data: { id: string } };
    expect(
      (await withDb((sql) => sql<{ visibility: string }[]>`select visibility from competitions where id = ${created.data.id}`))[0]!.visibility,
      "the competition the note promised private is private",
    ).toBe("private");
  });
}

// ── Item 7 ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

for (const width of [1280, 768, 320] as const) {
  test(`item 7 at ${width}: the frozen banner on Match Day names the frozen competitions - this one first, three in all, then "+N more" - and each other name opens that competition`, async ({
    page,
  }) => {
    test.setTimeout(budget(5, 30));
    await page.setViewportSize({ width, height: width === 320 ? 640 : 900 });
    const { orgId } = await freshOrg(page, `h7w${width}`);
    await dismissConsent(page);
    await skipTour(page);
    await setOrgPlanBySql({ orgId }, "pro");
    // Room to create five, then the freeze: a limit of one running place leaves four frozen (three named, one more).
    await setEntitlementOverrideSql(orgId, "competitions.max_active", 50);
    await invalidateOrgEntitlements(page.request, orgId);
    const made: { id: string; name: string }[] = [];
    for (const letter of ["Alpha", "Bravo", "Charlie", "Delta", "Echo"]) {
      const name = `${letter} Cup ${width} ${TAG}`;
      const c = await apiJson<{ id: string }>(page.request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name, visibility: "private" });
      expect(c.status, `${name}: ${JSON.stringify(c.error)}`).toBe(201);
      made.push({ id: c.data!.id, name });
    }
    await setEntitlementOverrideSql(orgId, "competitions.max_active", 1);
    await invalidateOrgEntitlements(page.request, orgId);

    // The freeze is chosen on the first read: open the first competition's Match Day, as its organiser would.
    const first = made[0]!;
    await page.goto(`${await competitionPath(page.request, first.id)}/match-day`, { waitUntil: "load" });
    await expect(page.getByTestId("md-header")).toBeVisible({ timeout: 30_000 });
    const frozenInDb = await withDb(async (sql) =>
      (await sql<{ id: string; name: string }[]>`select id, name from competitions where org_id = ${orgId} and frozen_at is not null order by name`),
    );
    expect(frozenInDb, "a limit of one over five live competitions freezes four").toHaveLength(4);

    // Open Match Day of one that IS frozen (the freeze keeps the newest running, so pick from the stored set) - the LAST of them by name.
    // The server lists names in name order, so an implementation that merely printed that order would hide this one behind "+1 more";
    // only one that puts the competition on screen first names it (PB3 review m3).
    const subject = frozenInDb[frozenInDb.length - 1]!;
    await page.goto(`${await competitionPath(page.request, subject.id)}/match-day`, { waitUntil: "load" });
    await expect(page.getByTestId("md-header")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("md-frozen"), "the banner is there").toHaveText(uiEn["matchDay.frozen"]!);
    const names = page.getByTestId("md-frozen-names");
    await expect(names, "and it names the frozen competitions").toBeVisible();

    // Three named (this one first), the rest counted - all read against the STORED set.
    const text = (await names.textContent()) ?? "";
    expect(text).toContain(uiEn["matchDay.frozenNames"]!);
    const named = frozenInDb.filter((r) => text.includes(r.name));
    expect(named, "three competitions are named").toHaveLength(3);
    expect(text.indexOf(subject.name), "this competition is named at all (not hidden behind '+N more')").toBeGreaterThanOrEqual(0);
    expect(text.indexOf(subject.name), "this competition is named first").toBeLessThan(Math.min(...named.filter((r) => r.id !== subject.id).map((r) => text.indexOf(r.name))));
    const unnamed = frozenInDb.filter((r) => !text.includes(r.name));
    expect(unnamed, "one frozen competition is counted, not named").toHaveLength(1);
    expect(text, "the count of the rest").toContain(fill("matchDay.frozenMore", { count: "1" }));
    // Never a competition that is not frozen.
    for (const m of made.filter((c) => !frozenInDb.some((r) => r.id === c.id))) expect(text, "a running competition is not named").not.toContain(m.name);

    // This one is plain text; the others are links to their own competition pages.
    await expect(names.getByRole("link"), "two links, for the two others named").toHaveCount(2);
    await expectNoHorizontalScroll(page);

    // 44px targets (PB3 review m1), by what a finger lands on: every name, link or plain, and the "+N more" are 44px tall, and the
    // element at the top, middle and bottom of each link IS that link (a painted box is not a hit area).
    const entries = names.locator("li");
    await expect(entries, "three names and the '+1 more'").toHaveCount(4);
    for (const li of await entries.all()) {
      const inner = li.locator("a, span").first();
      const hit = (await ((await inner.count()) > 0 ? inner : li).boundingBox())!;
      expect(hit.height, `an entry is a 44px target: ${(await li.textContent())?.trim()}`).toBeGreaterThanOrEqual(43.5);
    }
    let hitTested = 0;
    for (const link of await names.getByRole("link").all()) {
      await link.scrollIntoViewIfNeeded();
      for (const fraction of [0.08, 0.5, 0.92]) {
        const lands = await link.evaluate((el, f) => {
          const r = el.getBoundingClientRect();
          const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height * f);
          return at !== null && (at === el || el.contains(at));
        }, fraction);
        expect(lands, `a tap ${Math.round(fraction * 100)}% down "${(await link.textContent())?.trim()}" lands on it`).toBe(true);
        hitTested++;
      }
    }
    expect(hitTested, "anti-vacuity: both links, three points each").toBe(6);
    // The rows are a wrapping flex row, the label above it: read from the page, not from the class names.
    const labelBox = (await names.locator("p").boundingBox())!;
    const firstEntry = (await entries.first().boundingBox())!;
    expect(firstEntry.y, "the label is a line of its own, above the names").toBeGreaterThanOrEqual(labelBox.y + labelBox.height - 1);
    const other = named.find((r) => r.id !== subject.id)!;
    await names.getByRole("link", { name: other.name }).click();
    await expect(page).toHaveURL(new RegExp(`${(await competitionPath(page.request, other.id)).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), { timeout: NAV_MS });
  });
}
