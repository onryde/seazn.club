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
 * 1280 and 320, whole file. At 320 the Starts/Ends pair stacks, the segmented
 * control drops its icons, and the editor toolbar wraps with 44px buttons;
 * every step below runs the same at both, and the 44px floor is asserted at 320
 * (below `lg`, where the editor's `touch` mode applies).
 */

/** Same shape as the other walkthroughs: a derived budget, not a flat literal.
 *  The counts are this file's own: navigations (org home, the form, the builder
 *  or public page) at 20s, and every tap/type/read at 2.5s. */
const NAV_MS = 20_000;
const ACT_MS = 2_500;
const budget = (navs: number, acts: number) => Math.max(60_000, navs * NAV_MS + acts * ACT_MS);

const WIDTHS = [1280, 320] as const;

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
    const text =
      expected[audience] === "after_publish"
        ? fill("comp.wizard.reach.afterPublish", { audience: LABEL(audience) })
        : LABEL(audience);
    await expect(row, `${why}: ${audience} wording`).toContainText(text);
    if (expected[audience] !== "after_publish") {
      await expect(row.getByText(`${uiEn[`comp.wizard.reach.${expected[audience]}`]}:`, { exact: false })).toHaveCount(1);
    }
  }
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
            const box = await form.getByRole("button", { name: label, exact: true }).boundingBox();
            expect(box, `${label} has no box`).not.toBeNull();
            expect(Math.min(box!.width, box!.height), `${label} is ${box!.width}x${box!.height}px`).toBeGreaterThanOrEqual(44);
          }
        }
        const description = await typeDescription(page, form);
        await expectNoHorizontalScroll(page);

        // 7. Create. The wire body is the third witness to what the screen holds.
        const posted = page.waitForRequest(
          (r) => r.method() === "POST" && /\/api\/v1\/competitions$/.test(new URL(r.url()).pathname),
        );
        await create.click();
        const body = (await posted).postDataJSON() as Record<string, unknown>;
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
        createdId = list.data!.items.find((c) => c.slug === slug)?.id ?? null;
        expect(createdId, `competition '${slug}' is not in the org's list`).not.toBeNull();
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

      const form = await openBlankForm(page, org.slug);
      await form.getByPlaceholder(uiEn["comp.wizard.name.placeholder"]!).fill(name);
      await form.getByLabel(new RegExp(`^${uiEn["comp.wizard.endsOn"]}`)).fill("2030-12-31");
      const description = await typeDescription(page, form);
      await form.getByRole("button", { name: uiEn["comp.wizard.create"]!, exact: true }).click();

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
    });
  });
}
