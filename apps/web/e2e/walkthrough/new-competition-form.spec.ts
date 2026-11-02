import { test, expect, type Locator, type Page } from "@playwright/test";
import { TAG, activeOrg, apiJson, expectNoHorizontalScroll } from "../helpers";
import { uiEn, fill } from "../match-room-kit";

/**
 * Match Day C8 — an organiser makes a competition through the New competition
 * form, from the org home to the first-division screen and out the other side.
 *
 * Every step IS the thing under test, so every step is tapped or typed: the org
 * home's New competition link, the blank-form choice, the name, the Start date
 * (and Ends following it), the three visibility segments with the "Who will
 * find it" list read after each, the Showcase switch while Private and while
 * Public, "What this allows", the editor (a typed sentence and the Bold button),
 * the Create button's reason before there is a name, Create, and then each of
 * the screen's two exits. The system's own record is read back at the end.
 *
 * ## What the checklist is held to
 *
 * Not to `competitionReach` — that is the function the screen calls, so asking
 * it would prove the screen agrees with itself. The expected rows below are
 * written from the rule the listing code documents (competition-listing.ts: "a
 * draft is unlisted until published"; a competition is born a draft) and
 * checked here as the labels and states a person reads. The same rule is held
 * to the real readers — the link view, the org home, the sitemap source and the
 * discovery view — by `competition-reach-db.test.ts`.
 *
 * ## The "description rendered" step reads the PUBLIC page
 *
 * The organiser's competition page does not print the description; the public
 * page (`/shared/{org}/{competition}`) does. So the step lands on the organiser
 * page via "Later", then opens the public page the organiser would share and
 * reads the typed sentence AND the bold run off it: markdown went in as
 * markdown and came out as markup.
 *
 * ## Widths
 *
 * 1280, 1024 and 320, whole file. 1024 is the first width of the two-column
 * composition (the editor beside the other fields), 1023 the last of the single
 * column. At 320 the Starts/Ends pair stacks, the segmented
 * control drops its icons, and the editor toolbar wraps with 44px buttons;
 * every step below runs the same at all three, and the 44px floor is asserted at 320
 * (below `lg`, where the editor's `touch` mode applies).
 */

/** Same shape as the other walkthroughs: a derived budget, not a flat literal.
 *  The counts are this file's own: navigations (org home, the form, the builder
 *  or public page) at 20s, and every tap/type/read at 2.5s. */
const NAV_MS = 20_000;
const ACT_MS = 2_500;
const budget = (navs: number, acts: number) => Math.max(60_000, navs * NAV_MS + acts * ACT_MS);

// 1024 is the boundary itself: the first width at which the form is two columns.
const WIDTHS = [1280, 1024, 320] as const;

type Visibility = "private" | "unlisted" | "public";
type Audience = "team" | "link" | "org" | "search" | "showcase";
type State = "yes" | "after_publish" | "no";

/** The listing rule, written out for a NEW competition (born a draft). */
const REACH: Record<string, Record<Audience, State>> = {
  private: { team: "yes", link: "no", org: "no", search: "no", showcase: "no" },
  unlisted: { team: "yes", link: "yes", org: "no", search: "no", showcase: "no" },
  public: { team: "yes", link: "yes", org: "after_publish", search: "after_publish", showcase: "no" },
  "public+showcase": { team: "yes", link: "yes", org: "after_publish", search: "after_publish", showcase: "after_publish" },
};

const AUDIENCES: Audience[] = ["team", "link", "org", "search", "showcase"];

const LABEL = (a: Audience) => uiEn[`comp.wizard.reach.${a}`]!;

/** Read the checklist the way a person does and require it to match `expected`. */
async function expectReach(form: Locator, expected: Record<Audience, State>, why: string) {
  const rows = form.getByTestId("competition-reach").locator("li[data-audience]");
  // Anti-vacuity: five rows, in this order, or the loop below checks nothing.
  await expect(rows, `${why}: the checklist must list five audiences`).toHaveCount(AUDIENCES.length);
  expect(await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-audience"))), `${why}: row order`).toEqual(AUDIENCES);
  for (const audience of AUDIENCES) {
    const row = rows.nth(AUDIENCES.indexOf(audience));
    await expect(row, `${why}: ${audience}`).toHaveAttribute("data-state", expected[audience]);
    // The words, not just the attribute: a state is never colour or icon alone.
    // The Showcase row's "later" is a ceiling ("may appear once you publish and
    // it has a published schedule or a result"), every other row's is a plain
    // "once you publish": two keys, so two sentences.
    const text =
      expected[audience] === "after_publish"
        ? fill(audience === "showcase" ? "comp.wizard.reach.showcase.afterPublish" : "comp.wizard.reach.afterPublish", {
            audience: LABEL(audience),
          })
        : LABEL(audience);
    await expect(row, `${why}: ${audience} wording`).toContainText(text);
    if (expected[audience] !== "after_publish") {
      await expect(row.getByText(`${uiEn[`comp.wizard.reach.${expected[audience]}`]}:`, { exact: false })).toHaveCount(1);
    }
  }
}

/**
 * What a finger gets: the control's painted box AND whether the 44px extent
 * of a square centred on it (both axes) hit-tests to the control. `boundingBox()` measures paint; only
 * `elementFromPoint` says what a tap at a point would actually land on.
 */
async function expectTapTarget(control: Locator, label: string) {
  await control.scrollIntoViewIfNeeded();
  const got = await control.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    // The four edge midpoints of a 44px square (1px inside, so an edge pixel is
    // not the test) and the middle. Not the corners: the buttons are rounded, so
    // a point 1px inside the box's corner is outside its painted shape and
    // hit-tests to whatever is behind it.
    const probes = [[-21, 0], [21, 0], [0, -21], [0, 21], [0, 0]] as const;
    const hits = probes.map(([dx, dy]) => {
      const at = document.elementFromPoint(cx + dx, cy + dy);
      return !!at && (at === el || el.contains(at));
    });
    return { w: r.width, h: r.height, hits };
  });
  expect(Math.min(got.w, got.h), `${label} is ${got.w}x${got.h}px`).toBeGreaterThanOrEqual(44);
  expect(got.hits, `${label}: the 44px extent on both axes must hit-test to it`).toEqual([true, true, true, true, true]);
}

/** The breakpoint the editor's `touch` floor and this form's two columns both use (Tailwind `lg`). */
const LG = 1024;

/**
 * The composition at this width, measured: from `lg` two columns inside a card
 * as wide as the header above it, the description beside the decisions with the
 * editor as tall as the left column (28rem at the least); below `lg` one column,
 * the description under the decisions. Boxes, not class names — a class that
 * does not apply passes a class check and fails this.
 */
async function expectComposition(page: Page, form: Locator, width: number) {
  const decisions = form.getByTestId("new-competition-decisions");
  const descriptionCol = form.getByTestId("new-competition-description");
  const editor = descriptionCol.locator(":scope > div");
  await expect(editor, "the description column holds exactly one editor box").toHaveCount(1);
  const [f, d, c, e] = await Promise.all([
    form.boundingBox(),
    decisions.boundingBox(),
    descriptionCol.boundingBox(),
    editor.boundingBox(),
  ]);
  for (const [what, box] of [["form", f], ["decisions", d], ["description", c], ["editor", e]] as const) {
    expect(box, `${what} has no box at ${width}px`).not.toBeNull();
  }
  if (width >= LG) {
    const header = await page.locator("header > div").first().boundingBox();
    expect(header, "the header container").not.toBeNull();
    // The card spans the header's content box (the header pads 16px each side).
    expect(Math.abs(f!.x - (header!.x + 16)), `card left ${f!.x} vs header content ${header!.x + 16}`).toBeLessThanOrEqual(1.5);
    expect(Math.abs(f!.width - (header!.width - 32)), `card ${f!.width}px vs header content ${header!.width - 32}px`).toBeLessThanOrEqual(1.5);
    // Side by side: the description starts to the right of the decisions, on the same row.
    expect(c!.x, "description column is right of the decisions").toBeGreaterThanOrEqual(d!.x + d!.width);
    expect(Math.abs(c!.y - d!.y), "both columns start on one row").toBeLessThanOrEqual(1.5);
    // The decisions column is the narrow one (about 420-460px), the editor gets the rest.
    expect(d!.width).toBeGreaterThanOrEqual(400);
    expect(d!.width).toBeLessThanOrEqual(470);
    expect(e!.width, "the editor has more room than the old 670px card gave the whole form").toBeGreaterThan(d!.width);
    // The editor stretches to the left column's height, and never below 28rem.
    expect(e!.height, "editor min height").toBeGreaterThanOrEqual(448 - 1);
    expect(Math.abs(e!.y + e!.height - (d!.y + d!.height)), "editor bottom meets the left column's bottom").toBeLessThanOrEqual(2);
  } else {
    // One column: stacked, the same width, description below.
    expect(c!.y, "description sits below the decisions").toBeGreaterThanOrEqual(d!.y + d!.height);
    expect(Math.abs(c!.x - d!.x), "same left edge").toBeLessThanOrEqual(1.5);
    expect(Math.abs(c!.width - d!.width), "same width").toBeLessThanOrEqual(1.5);
  }
  // Tab order is the DOM order: the last control of the left column hands focus to the description's first.
  const lastLeft = decisions.locator("button, input, [tabindex='0'], summary").last();
  await lastLeft.focus();
  await page.keyboard.press("Tab");
  expect(
    await descriptionCol.evaluate((col) => col.contains(document.activeElement)),
    "Tab from the end of the decisions lands in the description",
  ).toBe(true);
}

async function tapVisibility(form: Locator, v: Visibility) {
  // `has:` is matched INSIDE each label, so the radio must be page-rooted — a
  // form-rooted locator would look for a form inside the label and match nothing.
  const radio = form.page().getByRole("radio", { name: uiEn[`visibility.${v}.label`]!, exact: true });
  await form.locator("label").filter({ has: radio }).click();
  await expect(radio).toBeChecked();
  // The consequence line under the segments follows the pick.
  await expect(form.getByTestId("visibility-consequence")).toHaveText(uiEn[`visibility.${v}.consequence`]!);
}

/** Step 1 — from the org home, tap New competition; step 1b — choose a blank form. */
async function openBlankForm(page: Page, orgSlug: string): Promise<Locator> {
  await page.goto(`/o/${orgSlug}`);
  await page.getByRole("link", { name: /new competition/i }).first().click();
  await page.waitForURL(new RegExp(`/o/${orgSlug}/c/new$`), { timeout: 20_000 });
  await expect(page.getByTestId("template-gallery")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("template-start-blank").click();
  const form = page.getByTestId("new-competition-form");
  await expect(form).toBeVisible({ timeout: 10_000 });
  return form;
}

/** Type a sentence, then a bold run through the Bold button; returns the markdown the editor must hand over. */
async function typeDescription(page: Page, form: Locator): Promise<{ plain: string; bold: string }> {
  const plain = `Season opener at the club ${TAG}. `;
  const bold = "Bring your own racket";
  const editor = form.getByRole("textbox", { name: uiEn["comp.wizard.description.placeholder"]! });
  await editor.click();
  await page.keyboard.type(plain);
  await form.getByRole("button", { name: uiEn["editor.bold"]!, exact: true }).click();
  await page.keyboard.type(bold);
  await expect(editor).toContainText(`${plain}${bold}`.trim());
  await expect(editor.locator("strong")).toHaveText(bold);
  return { plain, bold };
}

for (const width of WIDTHS) {
  test.describe(`New competition form walkthrough at ${width}px`, () => {
    test.use({ viewport: { width, height: width === 320 ? 640 : 800 } });

    test("every field, the checklist, the showcase rules, Create, then Add your first division opens the builder", async ({
      page,
    }) => {
      // 3 navigations (org home, form, builder) and ~60 taps, types and reads.
      test.setTimeout(budget(3, 60));
      const org = await activeOrg(page);
      const name = `C8 Walk ${width} ${TAG}`;
      const startA = "2030-06-10";
      const startB = "2030-06-12";
      const longEnd = "2030-06-20";
      const startC = "2030-06-11";
      let createdId: string | null = null;

      try {
        // 1. From the org home, tap New competition.
        const form = await openBlankForm(page, org.slug);
        await expectNoHorizontalScroll(page);
        await expectComposition(page, form, width);

        // Required fields (Name, Ends) are marked, optional Starts is not, and the
        // mark is aria-hidden so it is not part of the accessible name.
        await expect(form.locator('label:has(input[maxlength="200"]) > .label > span[aria-hidden="true"]')).toHaveText("*");
        await expect(form.locator('label:has(input[type="date"][aria-required="true"]) > .label > span[aria-hidden="true"]')).toHaveText("*");
        await expect(form.locator('label:has(input[type="date"]:not([aria-required])) span[aria-hidden="true"]')).toHaveCount(0);

        const nameInput = form.getByPlaceholder(uiEn["comp.wizard.name.placeholder"]!);
        const starts = form.getByLabel(uiEn["comp.wizard.startsOn"]!);
        const ends = form.getByLabel(new RegExp(`^${uiEn["comp.wizard.endsOn"]}`));
        const create = form.getByRole("button", { name: uiEn["comp.wizard.create"]!, exact: true });
        const blocker = form.getByTestId("create-blocker");

        // 6. The Create reason, read BEFORE the name is filled (and walked down
        // as each missing field is supplied).
        await expect(create).toBeDisabled();
        await expect(blocker).toHaveText(uiEn["comp.wizard.missing.both"]!);
        await nameInput.fill("x");
        await expect(blocker).toHaveText(uiEn["comp.wizard.missing.endsOn"]!);
        await nameInput.fill("");
        await expect(blocker).toHaveText(uiEn["comp.wizard.missing.both"]!);

        // 2. Type the name; pick a Start and watch Ends follow it.
        await nameInput.fill(name);
        await expect(blocker).toHaveText(uiEn["comp.wizard.missing.endsOn"]!);
        await expect(ends).toHaveValue("");
        await starts.fill(startA);
        await expect(ends, "Ends follows the first Start").toHaveValue(startA);
        await expect(create).toBeEnabled();
        await expect(blocker).toHaveText("");
        // Start moves later while Ends still equals it: Ends goes with it.
        await starts.fill(startB);
        await expect(ends, "Ends follows a later Start").toHaveValue(startB);
        // Ends is then set by hand to a longer event, and Start moves to a day
        // that is still before it: Ends is the organiser's now and stays put.
        await ends.fill(longEnd);
        await starts.fill(startC);
        await expect(ends, "a hand-set Ends does not follow Start").toHaveValue(longEnd);
        await expect(starts).toHaveValue(startC);

        // 3. Private -> Unlisted -> Public, reading the list after each. The
        // form opens on Public (V396), so that is read first, untouched.
        await expect(form.getByRole("radio", { name: uiEn["visibility.public.label"]!, exact: true })).toBeChecked();
        await expectReach(form, REACH["public"]!, "opening state (Public)");
        await tapVisibility(form, "private");
        await expectReach(form, REACH["private"]!, "Private");
        await tapVisibility(form, "unlisted");
        await expectReach(form, REACH["unlisted"]!, "Unlisted");
        await tapVisibility(form, "public");
        await expectReach(form, REACH["public"]!, "Public");

        // 4. Showcase: off-limits while Private, with the reason; on while Public.
        const showcase = form.getByRole("switch", { name: uiEn["showcase.label"]!, exact: true });
        await tapVisibility(form, "private");
        await expect(showcase).toBeDisabled();
        await expect(form.getByText(uiEn["showcase.needsPublic"]!)).toBeVisible();
        await tapVisibility(form, "public");
        await expect(showcase).toBeEnabled();
        await expect(form.getByText(uiEn["showcase.needsPublic"]!)).toHaveCount(0);
        await showcase.check();
        await expect(showcase).toBeChecked();
        await expectReach(form, REACH["public+showcase"]!, "Public + showcase");
        const allows = form.getByText(uiEn["comp.wizard.showcase.allows"]!, { exact: true });
        await allows.click();
        // Byte-identical consent wording, read off the screen.
        await expect(form.getByText(uiEn["showcase.consent"]!, { exact: true })).toBeVisible();
        // Leaving Public switches the showcase off; coming back does not turn it on again.
        await tapVisibility(form, "unlisted");
        await expect(showcase).not.toBeChecked();
        await expectReach(form, REACH["unlisted"]!, "Unlisted after showcase");
        await tapVisibility(form, "public");
        await expect(showcase).not.toBeChecked();
        await showcase.check();
        await expectReach(form, REACH["public+showcase"]!, "Public + showcase (again)");
        await expectNoHorizontalScroll(page);

        // 5. A description in the editor: a typed sentence and a Bold run.
        if (width < 1024) {
          // The phone floor of the editor's `touch` mode, hit-tested on the
          // buttons about to be tapped.
          for (const label of [uiEn["editor.bold"]!, uiEn["editor.italic"]!, uiEn["editor.link"]!]) {
            await expectTapTarget(form.getByRole("button", { name: label, exact: true }), label);
          }
        }
        const description = await typeDescription(page, form);
        await expectNoHorizontalScroll(page);

        // 7. Create. The wire body is the third witness to what the screen holds.
        const isCreate = (r: { method(): string; url(): string }) =>
          r.method() === "POST" && /\/api\/v1\/competitions$/.test(new URL(r.url()).pathname);
        const posted = page.waitForRequest(isCreate);
        const made = page.waitForResponse((r) => isCreate(r.request()));
        await create.click();
        const body = (await posted).postDataJSON() as Record<string, unknown>;
        // The id comes off the 201 itself, so the cleanup below holds even if a
        // later step throws before the list is read.
        createdId = ((await (await made).json()) as { data: { id: string } }).data.id;
        expect(body.visibility).toBe("public");
        expect(body.discoverable).toBe(true);
        expect(body.starts_on).toBe(startC);
        expect(body.ends_on).toBe(longEnd);
        expect(String(body.description)).toContain(`**${description.bold}**`);

        // 8. "Add your first division" — read it, tap it, land in the builder.
        const prompt = page.getByTestId("first-division-prompt");
        await expect(prompt).toBeVisible({ timeout: 20_000 });
        await expect(prompt.getByRole("heading", { name: uiEn["comp.wizard.created.title"]! })).toBeVisible();
        await expect(prompt).toContainText(name);
        await expect(prompt).toContainText(uiEn["comp.wizard.created.showcased"]!);
        await expect(page.getByTestId("new-competition-form")).toHaveCount(0);
        await expectNoHorizontalScroll(page);
        const later = prompt.getByTestId("first-division-later");
        const slug = (await later.getAttribute("href"))!.match(/\/c\/([^/?]+)$/)![1]!;
        await prompt.getByTestId("first-division-add").click();
        await page.waitForURL(new RegExp(`/o/${org.slug}/c/${slug}/d/new$`), { timeout: 20_000 });
        await expect(page.getByRole("heading", { name: "New division", level: 1 })).toBeVisible({ timeout: 20_000 });
        await expect(page.getByTestId("division-builder-name")).toBeVisible();
        await expectNoHorizontalScroll(page);

        // The record agrees with what was done.
        const list = await apiJson<{ items: { id: string; slug: string }[] }>(page.request, "/api/v1/competitions?limit=100");
        expect(list.data!.items.find((c) => c.slug === slug)?.id, `competition '${slug}' is not in the org's list`).toBe(createdId);
        const row = await apiJson<{
          name: string;
          visibility: string;
          discoverable: boolean;
          status: string;
          starts_on: string | null;
          ends_on: string | null;
          description: string | null;
        }>(page.request, `/api/v1/competitions/${createdId}`);
        expect(row.status).toBe(200);
        expect(row.data).toMatchObject({
          name,
          visibility: "public",
          discoverable: true,
          status: "draft",
          starts_on: startC,
          ends_on: longEnd,
        });
        expect(row.data!.description).toContain(`**${description.bold}**`);
      } finally {
        // A showcased competition must not outlive the test on a shared org.
        if (createdId) {
          const res = await apiJson(page.request, `/api/v1/competitions/${createdId}`, "PATCH", { visibility: "private" });
          expect(res.status, "cleanup: take the showcased competition private").toBeLessThan(300);
        }
      }
    });

    test("Later opens the competition page, and the description reads back on the public page", async ({ page }) => {
      // 3 navigations (org home, form, public page) and ~25 taps, types and reads.
      test.setTimeout(budget(3, 25));
      const org = await activeOrg(page);
      const name = `C8 Later ${width} ${TAG}`;

      let createdId: string | null = null;
      try {
        const form = await openBlankForm(page, org.slug);
        await form.getByPlaceholder(uiEn["comp.wizard.name.placeholder"]!).fill(name);
        await form.getByLabel(new RegExp(`^${uiEn["comp.wizard.endsOn"]}`)).fill("2030-12-31");
        const description = await typeDescription(page, form);
        const made = page.waitForResponse(
          (r) => r.request().method() === "POST" && /\/api\/v1\/competitions$/.test(new URL(r.url()).pathname),
        );
        await form.getByRole("button", { name: uiEn["comp.wizard.create"]!, exact: true }).click();
        createdId = ((await (await made).json()) as { data: { id: string } }).data.id;

        const prompt = page.getByTestId("first-division-prompt");
        await expect(prompt).toBeVisible({ timeout: 20_000 });
        await expect(prompt).not.toContainText(uiEn["comp.wizard.created.showcased"]!);
        const slug = (await prompt.getByTestId("first-division-later").getAttribute("href"))!.match(/\/c\/([^/?]+)$/)![1]!;

        // 9. Later: the competition page, its own heading and its Add division link.
        await prompt.getByTestId("first-division-later").click();
        await page.waitForURL(new RegExp(`/o/${org.slug}/c/${slug}$`), { timeout: 20_000 });
        await expect(page.getByRole("heading", { name })).toBeVisible({ timeout: 20_000 });
        await expect(page.getByRole("link", { name: /add division/i })).toBeVisible();
        await expectNoHorizontalScroll(page);

        // The description, rendered where the public reads it.
        await page.goto(`/shared/${org.slug}/${slug}`);
        const main = page.getByRole("main");
        await expect(main).toContainText(description.plain.trim());
        await expect(main.locator("strong", { hasText: description.bold })).toBeVisible();
        await expectNoHorizontalScroll(page);
      } finally {
        // This one opens on Public (the default) and is a draft on a shared org:
        // it counts against dashboard.public.max until it is taken private.
        if (createdId) {
          const res = await apiJson(page.request, `/api/v1/competitions/${createdId}`, "PATCH", { visibility: "private" });
          expect(res.status, "cleanup: take the public draft private").toBeLessThan(300);
        }
      }
    });
  });
}
