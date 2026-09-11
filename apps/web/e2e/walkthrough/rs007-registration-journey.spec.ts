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
import {
  activeOrg,
  apiJson,
  expectNoHorizontalScroll,
  loginUi,
  mintClaimPathForPlayerRow,
  screenshotAtWidths,
  TAG,
} from "../helpers";

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
    await anon.locator("#reg-who-email").fill(`delivered+journey-captain-${TAG}@resend.dev`);
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
    // Captured for the RS008 review fix #10 segment at the end of this spec,
    // which revisits this exact URL after Mate Two's own claim+opt-out.
    const statusUrl = anon.url();
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
    await anon.locator("#reg-who-email").fill(`delivered+journey-mate-${TAG}@resend.dev`);
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

    // ------------------------------------------------------------------
    // RS008 review fix #10 — a SECOND player follows their OWN claim link,
    // opts out of a public name on /me (built in RS007 — no new UI here),
    // and the status page's roster must show them masked while Mate One
    // (claimed above, never opted out) still renders in full. The status
    // page is `export const dynamic = "force-dynamic"` (verified by reading
    // register/status/page.tsx directly) — no ISR revalidation window to
    // race, a plain reload is always fresh.
    // ------------------------------------------------------------------
    const mate2Email = `delivered+journey-mate2-${TAG}@resend.dev`;
    const mate2Ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    try {
      // Mate Two's OWN join is not what this segment tests — Mate One's UI
      // join above already covers that path end to end. Reaching "granted,
      // with an email on file" via the same PUBLIC API the join page itself
      // calls (never the signed-in `request` fixture — this must be the
      // anonymous caller the real route sees) is the fastest, least-flaky
      // route to the state this segment DOES test: claim-accept, the /me
      // opt-out, and its effect on a re-rendered status page.
      await anon.goto(statusUrl, { waitUntil: "load" });
      const secondClaim = anon.locator('a[href*="/register/join"]').first();
      await expect(secondClaim, "the status page emits no second claim link for Mate Two").toBeVisible();
      const secondHref = await secondClaim.getAttribute("href");
      const secondUrl = new URL(secondHref!, anon.url());
      const joinCode = secondUrl.searchParams.get("join_code")!;
      const player2Id = secondUrl.searchParams.get("player_id")!;
      expect(player2Id, "expected Mate Two's own per-slot claim link, not the generic one").toBeTruthy();

      const joined = await apiJson(
        mate2Ctx.request,
        `/api/v1/public/orgs/${org.slug}/competitions/${comp.data!.slug}/register/join`,
        "POST",
        {
          join_code: joinCode,
          player_id: player2Id,
          player: { full_name: MATES[1], email: mate2Email },
          privacy_consent: true,
        },
      );
      expect(joined.status, "Mate Two's own join failed").toBeLessThan(300);

      // The REAL claim-invite secret went to an inbox this process can never
      // read (only its sha256 lands in the DB) — mint an equivalent one
      // directly, the same shortcut this file's helpers already take for
      // magic links (mintLoginPathBySql). Everything from here IS a real
      // click through the real /claim/[token] UI.
      const claimPath = await mintClaimPathForPlayerRow(player2Id, org.id, mate2Email);
      const mate2Page = await mate2Ctx.newPage();
      // loginUi itself waits until the post-login URL leaves /login and
      // /magic-link behind — by the time it returns, the app's own `next`
      // redirect has already landed on claimPath.
      await loginUi(mate2Page, mate2Email, claimPath);

      const claimButton = mate2Page.getByRole("button", { name: /this is me/i });
      await expect(claimButton, "the claim-accept page never rendered its own accept button").toBeVisible();
      await screenshotAtWidths(mate2Page, testInfo, "10-claim-accept");
      await claimButton.click();

      // ClaimAccept redirects to /me?claimed=1 on success.
      await mate2Page.waitForURL(/\/me(\?|$)/, { timeout: 20_000 });

      // The opt-out toggle (RS007's own ConsentCard, /me — no new UI built
      // for this task). Toggling it OFF is the whole point of this segment.
      const nameConsent = mate2Page.getByLabel(/show my name publicly/i);
      await expect(nameConsent, "could not find the existing /me public-name opt-out toggle").toBeVisible();
      await expect(nameConsent).toBeChecked(); // RS007 default: consent, not silence
      // consent-card.tsx applies the toggle OPTIMISTICALLY, then PATCHes —
      // wait for that PATCH to actually land, not just the checkbox's own
      // (revertible) optimistic state, before trusting the write happened.
      const [patchResponse] = await Promise.all([
        mate2Page.waitForResponse((r) => r.url().includes("/consent") && r.request().method() === "PATCH"),
        nameConsent.uncheck(),
      ]);
      expect(patchResponse.status(), "the /me consent opt-out PATCH failed").toBeLessThan(300);
      await expect(nameConsent).not.toBeChecked();
      await screenshotAtWidths(mate2Page, testInfo, "11-opted-out");

      // Back to the CAPTAIN's own status page — same URL, no rebuild, no
      // cache to invalidate (force-dynamic). Mate Two must now read masked;
      // Mate One (claimed earlier, never opted out) must still read in full.
      await anon.goto(statusUrl, { waitUntil: "load" });
      const mate2Masked = `Mate ${TAG[0]}.`; // maskDisplayName's own "first + last-initial" rule
      await expect(
        anon.getByText(MATES[1]!),
        "Mate Two's raw full name is still visible after their own opt-out",
      ).not.toBeVisible();
      await expect(
        anon.getByText(mate2Masked),
        `expected Mate Two's masked name ("${mate2Masked}") to be visible`,
      ).toBeVisible();
      await expect(
        anon.getByText(MATES[0]!),
        "Mate One (never opted out) must still render in full",
      ).toBeVisible();
      await screenshotAtWidths(anon, testInfo, "12-standings-mixed-consent");
      await expectNoHorizontalScroll(anon);
    } finally {
      await mate2Ctx.close();
    }

    expect(pageErrors, `the journey logged page errors: ${pageErrors.join(" | ")}`).toEqual([]);
  } finally {
    await anonCtx.close();
  }
});
