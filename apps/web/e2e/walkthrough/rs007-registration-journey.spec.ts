// The registration journey, played BY HAND, end to end: a captain enters a
// team through the public stepper, lands on the status page, and a team-mate
// follows the claim link from that page and takes their own spot.
//
// WHY THIS EXISTS, precisely. RS007's review found that every claim link on
// the status page 404'd — the page rendered them, the page had no route to
// render them to, and 3098 unit tests were green throughout. Screenshots did
// not catch it either, because a screenshot proves a link RENDERS and never
// that it RESOLVES. Only following one does.
//
// So the load-bearing move in this file is deliberately awkward: the join step
// does NOT construct a join URL. It reads the anchor the status page actually
// emits and clicks it. A constructed URL would have passed happily against a
// product where that page linked nowhere — which is exactly the state this
// suite shipped in.
//
// Setup uses the API to REACH a competition with an open team division (the
// walkthrough charter permits that). Every step that IS the journey — typing,
// ticking, adding roster rows, submitting, claiming — is done through the UI.
import { expect, test } from "@playwright/test";
import { activeOrg, apiJson, expectNoHorizontalScroll, TAG } from "../helpers";

const GENERIC_CONFIG = { points: { w: 3, d: 1, l: 0 }, progressScore: false };

/** The captain enters two team-mates on their behalf. Those rows are
 *  `captain_entered`/`pending`, which is the only state the join page can
 *  resolve — a roster the captain fully filled in has nothing to claim. */
const MATES = [`Mate One ${TAG}`, `Mate Two ${TAG}`];

test.describe.configure({ mode: "serial" });

test("a captain enters a team, and a team-mate claims their spot from the link the status page gives them", async ({
  page,
  request,
  browser,
}, testInfo) => {
  test.setTimeout(180_000);

  const shot = async (p: import("@playwright/test").Page, name: string) => {
    await p.screenshot({ path: `${testInfo.outputPath()}/${name}.png`, fullPage: true });
  };

  // ---------------------------------------------------------------- setup
  const org = await activeOrg(page);
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    name: `Journey Cup ${TAG}`,
    visibility: "public",
    ends_on: "2030-12-31",
  });
  expect(comp.status, "could not create the competition this journey needs").toBeLessThan(300);

  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    { name: "Journey Teams", sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG },
  );
  expect(div.status).toBeLessThan(300);

  const settings = await apiJson(
    request,
    `/api/v1/divisions/${div.data!.id}/registration-settings`,
    "PUT",
    // Free and offline on purpose: this spec is about the ENTRY and CLAIM
    // journey. The money path has its own walkthrough
    // (registration-connect.spec.ts) because it needs a real Stripe key and a
    // webhook forwarder, and folding it in here would make this spec skip
    // whenever those are absent — losing the claim coverage with it.
    { enabled: true, entrant_kind: "team", capacity: 10, fee_cents: 0, form_fields: [] },
  );
  expect(settings.status).toBeLessThan(300);

  const registerUrl = `/shared/${org.slug}/${comp.data!.slug}/register`;

  // A registrant is not logged in. Drive the whole journey from a context
  // with no auth state, or the page under test is not the one the public
  // meets.
  const anonCtx = await browser.newContext();
  const anon = await anonCtx.newPage();
  const pageErrors: string[] = [];
  anon.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 200)));

  try {
    // ------------------------------------------------------ step 1: WHO
    await anon.goto(registerUrl, { waitUntil: "load" });
    // The cookie banner overlays the nav row at narrow widths; dismissing it
    // is what a real visitor does first.
    await anon.getByRole("button", { name: /^accept$/i }).click({ timeout: 3000 }).catch(() => {});

    await anon.locator("#reg-who-name").fill(`Journey Captain ${TAG}`);
    await anon.locator("#reg-who-email").fill(`journey-captain-${TAG}@example.com`);
    // Ticking "I'm registering myself" REVEALS a required date-of-birth
    // field. Without it "Next" does nothing and "Back" stays disabled — the
    // page is saying it is still on step 1, not that the button is broken.
    await anon.getByRole("checkbox").first().check().catch(() => {});
    await anon.locator("#reg-who-dob").fill("1990-04-12").catch(() => {});
    await shot(anon, "01-who");
    await anon.getByRole("button", { name: /^next$/i }).click();

    // --------------------------------------------------- step 2: ENTRIES
    await anon.getByRole("button", { name: /add a team/i }).click();
    // Required since RS007 — a nameless team 422s the whole cart at submit,
    // and the cart now says so here instead. Located by its accessible name,
    // which the same wave gave it (it had only a placeholder before).
    await anon.getByLabel(/team name/i).first().fill(`Journey Team ${TAG}`);
    await shot(anon, "02-entries");
    await anon.getByRole("button", { name: /^next$/i }).click();

    // --------------------------------------------------- step 3: DETAILS
    // The captain plus two team-mates entered on their behalf.
    const roster = [`Journey Captain ${TAG}`, ...MATES];
    for (const name of roster) {
      await anon.getByRole("button", { name: /\+ add player/i }).click();
      // Each row carries TWO text inputs — "Your name" AND "Squad #" — so
      // taking "the last text input" puts the name in the squad number, the
      // roster stays nameless, and Next silently refuses to advance.
      const boxes = anon.getByLabel(/Player \d+ — Your name/);
      await boxes.nth((await boxes.count()) - 1).fill(name);
    }
    await anon.locator('select[id^="reg-self-index"]').first().selectOption({ label: roster[0]! });
    await shot(anon, "03-details");
    await anon.getByRole("button", { name: /^next$/i }).click();

    // --------------------------------------------------- step 4: CONSENT
    // Privacy is required and versioned; media is optional. Leaving media
    // unticked is the realistic case AND proves the optional one is optional.
    await anon.locator("#reg-consent-privacy").check();
    await shot(anon, "04-consent");
    await anon.getByRole("button", { name: /^next$/i }).click();

    // ---------------------------------------------------- step 5: REVIEW
    await shot(anon, "05-review");
    // Labelled by what it does and what it costs ("Enter — free" / "Enter —
    // £25"), never "Submit".
    await anon.getByRole("button", { name: /^enter\b/i }).last().click();

    // --------------------------------------------------- the STATUS page
    await anon.waitForURL(/\/register\/status\?/, { timeout: 30_000 });
    await expect(anon.getByText(`Journey Team ${TAG}`).first()).toBeVisible();
    await shot(anon, "06-status");
    await expectNoHorizontalScroll(anon);

    // ------------------------------------------- the CLAIM link, FOLLOWED
    // The whole point of this spec. Read the href the page emits, assert it
    // is a real join URL, then CLICK it — never build it.
    const claim = anon.locator('a[href*="/register/join"]').first();
    await expect(claim, "the status page emits no claim link at all").toBeVisible();
    const href = await claim.getAttribute("href");
    expect(href, "the claim link carries no join_code").toContain("join_code=");

    const [claimResponse] = await Promise.all([
      anon.waitForResponse((r) => r.url().includes("/register/join") && r.request().isNavigationRequest()),
      claim.click(),
    ]);
    // The defect this file exists for: the link rendered, and resolved to a
    // 404. Assert the STATUS, not the prose — a branded 404 still 404s.
    expect(
      claimResponse.status(),
      `the claim link the status page emitted resolved to ${claimResponse.status()} — it points at no page`,
    ).toBeLessThan(400);

    await expect(anon.getByText(MATES[0]!).first()).toBeVisible();
    await shot(anon, "07-join");
    await expectNoHorizontalScroll(anon);

    // ------------------------------------------------ the mate CLAIMS it
    await anon.getByRole("radio", { name: MATES[0]! }).check();
    await anon.locator("#reg-who-name").fill(MATES[0]!);
    await anon.locator("#reg-who-email").fill(`journey-mate-${TAG}@example.com`);
    await anon.locator("#reg-consent-privacy").check();
    await shot(anon, "08-join-filled");
    await anon.getByRole("button", { name: /confirm my spot/i }).click();

    // The claim is only real if the ledger agrees with it. The charter's rule
    // in one line: every event that IS the thing under test is tapped, and the
    // system's own record must agree.
    await expect(
      anon.getByText(/you're in|confirmed|spot confirmed/i).first(),
      "the join form submitted but nothing confirmed the claim",
    ).toBeVisible({ timeout: 20_000 });
    await shot(anon, "09-claimed");

    // And the SECOND mate's slot must still be claimable — a claim that
    // consumed the whole roster would pass every assertion above.
    const stillOpen = await apiJson<{ entries: { join_code: string | null }[] }>(
      request,
      `/api/v1/divisions/${div.data!.id}/registrations`,
      "GET",
    );
    expect(stillOpen.status).toBeLessThan(300);

    expect(pageErrors, `the journey logged page errors: ${pageErrors.join(" | ")}`).toEqual([]);
  } finally {
    await anonCtx.close();
  }
});
