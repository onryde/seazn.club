import { test, expect, type Page } from "@playwright/test";
import { TAG, apiJson, activeOrg, loginUi, mintEmailClaimPathBySql, withDb } from "./helpers";
import { CLAIM_EMAIL_SIGNIN_MS } from "../src/lib/claim-signin-window";

// PROMPT-53 acceptance: invite → claim → RSVP on /me → organiser sees the
// chip in the lineup picker → QR self-check-in marks presence. Consent flip
// by the player revalidates the public card immediately; unclaimed persons
// stay invisible everywhere; a second claim attempt fails clean.
//
// Serial: creates a player user (magic-link budget) and leans on the shared
// Pro org.

const playerEmail = `delivered+e2e-player-${TAG}@resend.dev`;

interface Person {
  id: string;
  full_name: string;
  user_id: string | null;
}
interface MyFixtureOut {
  id: string;
  fixture_no: number;
  availability: { status: string; note: string | null } | null;
  checked_in_at: string | null;
}

/** Explicitly no session: the project's `use.storageState` is the organiser's, and these steps are about a visitor who has none. */
const SIGNED_OUT = { storageState: { cookies: [], origins: [] } };

test.describe("player accounts (PROMPT-53)", () => {
  test.describe.configure({ mode: "serial" });
  test.slow();

  let orgSlug: string;
  let compSlug: string;
  let divSlug: string;
  let compId: string;
  let divisionId: string;
  let ada: Person; // claimed by the player
  let ben: Person; // stays unclaimed — the regression control
  let claimUrl: string;
  let playerPage: Page;

  test.beforeAll(async ({ browser }) => {
    playerPage = await (await browser.newContext()).newPage();
  });
  test.afterAll(async () => {
    await playerPage.context().close();
  });

  test("organiser: roster persons, generate fixtures, invite Ada to claim", async ({
    page,
    request,
  }) => {
    const org = await activeOrg(page);
    orgSlug = org.slug;

    const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Players ${TAG}`,
      visibility: "public",
    });
    compId = comp.data!.id;
    compSlug = comp.data!.slug;
    const div = await apiJson<{ id: string; slug: string }>(
      request,
      `/api/v1/competitions/${compId}/divisions`,
      "POST",
      {
        name: "Open",
        sport_key: "generic",
        variant_key: "score",
        config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      },
    );
    divisionId = div.data!.id;
    divSlug = div.data!.slug;

    const mk = async (name: string) =>
      (
        await apiJson<Person>(request, "/api/v1/persons", "POST", {
          full_name: `${name} ${TAG}`,
          consent: {},
        })
      ).data!;
    ada = await mk("Ada");
    ben = await mk("Ben");

    await apiJson(request, `/api/v1/divisions/${divisionId}/entrants`, "POST", [
      { kind: "individual", display_name: ada.full_name, seed: 1, members: [{ person_id: ada.id }] },
      { kind: "individual", display_name: ben.full_name, seed: 2, members: [{ person_id: ben.id }] },
    ]);
    const stage = await apiJson<{ id: string }>(
      request,
      `/api/v1/divisions/${divisionId}/stages`,
      "POST",
      { seq: 1, kind: "league", name: "League" },
    );
    await apiJson(request, `/api/v1/stages/${stage.data!.id}/generate`, "POST");
    await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");

    // Invite Ada — the claim_url embeds the one-time secret (e2e token trick).
    const invite = await apiJson<{ claim_url: string }>(
      request,
      `/api/v1/persons/${ada.id}/claim-invites`,
      "POST",
      { email: playerEmail },
    );
    expect(invite.status).toBe(201);
    claimUrl = invite.data!.claim_url;
    expect(claimUrl).toContain("/claim/pc_");

    // The invite's email is ONE `claim_invite` row, ref Ada's person, written with
    // the claim. Its first attempt was made in the request, so it is no longer
    // waiting and holds no body (no Resend key here: `dead`).
    const inviteMail = await withDb(
      (sql) => sql<{ status: string; hasBody: boolean }[]>`
        select status, body_sealed is not null as "hasBody"
          from email_outbox
         where kind = 'claim_invite' and ref_type = 'person' and ref_id = ${ada.id}`,
    );
    expect(
      {
        count: inviteMail.length,
        waiting: inviteMail.filter((r) => r.status === "queued" || r.status === "sending").length,
        withBody: inviteMail.filter((r) => r.hasBody).length,
      },
      "one claim invite email for Ada, its first attempt made, no body kept",
    ).toEqual({ count: 1, waiting: 0, withBody: 0 });
  });

  test("player: claim via magic link and land on /me", async () => {
    // Logged out, the auth card must sit centred in the night-stage column
    // (regression: the max-w-sm card sat left-aligned inside the max-w-md
    // claim column until it got mx-auto).
    await playerPage.goto(claimUrl);
    const card = playerPage.locator("main .card").first();
    await expect(card).toBeVisible();
    const cardBox = (await card.boundingBox())!;
    const viewport = playerPage.viewportSize()!;
    expect(Math.abs(cardBox.x + cardBox.width / 2 - viewport.width / 2)).toBeLessThan(3);

    // The claim page's AuthForm carries next=/claim/<token>, and that is what
    // keeps a claiming player player-only: a login with no `next` falls
    // through to the org-resolution branch and hands them "My organization"
    // (the person link they are about to make does not exist yet, so
    // isPlayerOnly is false at this moment). Mirror the real flow.
    await loginUi(playerPage, playerEmail, claimUrl.slice(claimUrl.indexOf("/claim/")));
    await playerPage.goto(claimUrl);
    await playerPage.getByRole("button", { name: /This is me/ }).click();
    await playerPage.waitForURL(/\/me\?claimed=1/);
    await expect(playerPage.getByText("Profile claimed")).toBeVisible();
    // The claimed fixture list shows the league match against Ben.
    await expect(playerPage.getByText(ben.full_name).first()).toBeVisible();
  });

  test("player: RSVP Out with a note from the /me hero", async () => {
    await playerPage.goto("/me");
    // Hero = next match; Ada has exactly one fixture (vs Ben). exact: true —
    // substring matching would hit the header's "Sign out" button.
    await playerPage.getByRole("button", { name: "Out", exact: true }).first().click();
    await expect(playerPage.getByText("Saved").first()).toBeVisible();
    const note = playerPage
      .getByPlaceholder("Add a note for the organiser (optional)")
      .first();
    await note.fill("away that weekend");
    await note.blur();
    await expect(playerPage.getByText("Saved").first()).toBeVisible();

    const mine = await apiJson<{ upcoming: MyFixtureOut[] }>(
      playerPage.request,
      "/api/v1/me/fixtures",
    );
    const rsvpd = mine.data!.upcoming.find((f) => f.availability?.status === "out");
    expect(rsvpd, "RSVP persisted to the API read").toBeTruthy();
    expect(rsvpd!.availability!.note).toBe("away that weekend");
  });

  test("organiser: lineup picker shows Ada's ✗ chip and Ben's — chip", async ({
    page,
    request,
  }) => {
    const mine = await apiJson<{ upcoming: MyFixtureOut[] }>(playerPage.request, "/api/v1/me/fixtures");
    const fixture = mine.data!.upcoming[0]!;
    await page.goto(`/o/${orgSlug}/c/${compSlug}/d/${divSlug}/f/${fixture.fixture_no}`);

    // Ada RSVP'd out → ✗ with the note as tooltip; Ben never claimed → "—".
    const adaChip = page.getByLabel(`${ada.full_name}: unavailable — away that weekend`);
    await expect(adaChip.first()).toBeVisible({ timeout: 20_000 });
    const benChip = page.getByLabel(`${ben.full_name}: no availability answer`);
    await expect(benChip.first()).toBeVisible();

    // Mint the check-in QR from the console (editor session).
    const link = await apiJson<{ url: string }>(
      request,
      `/api/v1/fixtures/${fixture.id}/checkin-link`,
      "POST",
    );
    expect(link.status).toBe(201);
    process.env.E2E_CHECKIN_URL = link.data!.url;
  });

  test("player: QR check-in marks presence; organiser sees the venue dot", async ({ page }) => {
    await playerPage.goto(process.env.E2E_CHECKIN_URL!);
    await playerPage.getByRole("button", { name: /check in/i }).click();
    await expect(playerPage.getByTestId("checkin-done")).toBeVisible();

    const mine = await apiJson<{ upcoming: MyFixtureOut[] }>(playerPage.request, "/api/v1/me/fixtures");
    const fixture = mine.data!.upcoming[0]!;
    expect(fixture.checked_in_at).toBeTruthy();
    // Check-in never clobbers an explicit RSVP: Ada stays "out".
    expect(fixture.availability?.status).toBe("out");

    await page.goto(`/o/${orgSlug}/c/${compSlug}/d/${divSlug}/f/${fixture.fixture_no}`);
    await expect(
      page.getByLabel(`${ada.full_name}: checked in at the venue`).first(),
    ).toBeVisible({ timeout: 20_000 });
  });

  test("second claim fails clean: 409 re-invite, dead link, unclaimed regression", async ({
    request,
  }) => {
    // Re-inviting a claimed person is a clean 409.
    const again = await apiJson(request, `/api/v1/persons/${ada.id}/claim-invites`, "POST", {
      email: "delivered+someone-else@resend.dev",
    });
    expect(again.status).toBe(409);
    expect(again.error?.message).toContain("already claimed");

    // The used link is a dead end with its own copy, not a crash.
    await playerPage.goto(claimUrl);
    await expect(playerPage.getByText("Already claimed")).toBeVisible();

    // Ben (unclaimed) is untouched by all of the above.
    const persons = await apiJson<Person[]>(request, "/api/v1/persons?limit=200");
    const benRow = persons.data && "items" in (persons.data as object)
      ? (persons.data as unknown as { items: Person[] }).items.find((p) => p.id === ben.id)
      : undefined;
    expect(benRow?.user_id ?? null).toBeNull();
  });

  test("consent flip by the player revalidates the public card; unclaimed stays 404", async ({
    request,
  }) => {
    const cardUrl = (personId: string) =>
      `/shared/${orgSlug}/${compSlug}/players/${personId}`;

    // Before consent: both cards 404 (public_players_v is consent-gated).
    expect((await request.get(cardUrl(ada.id))).status()).toBe(404);
    expect((await request.get(cardUrl(ben.id))).status()).toBe(404);

    // Player flips public_name ON from /me.
    await playerPage.goto("/me");
    await playerPage.getByLabel("Show my name publicly").check();
    await expect
      .poll(async () => (await request.get(cardUrl(ada.id))).status(), {
        message: "public card appears after consent ON",
        timeout: 15_000,
      })
      .toBe(200);
    const body = await (await request.get(cardUrl(ada.id))).text();
    expect(body).toContain(ada.full_name);

    // …and OFF again: the card disappears just as fast.
    await playerPage.getByLabel("Show my name publicly").uncheck();
    await expect
      .poll(async () => (await request.get(cardUrl(ada.id))).status(), {
        message: "public card disappears after consent OFF",
        timeout: 15_000,
      })
      .toBe(404);

    // The unclaimed control never appeared at any point.
    expect((await request.get(cardUrl(ben.id))).status()).toBe(404);
  });

  test("growth nudge: claimed player sees run-your-own; organiser does not", async ({ page }) => {
    // Ada is player-only (claim never hands out a default org) → the PLG
    // night ribbon shows. The organiser session has an org → both nudges
    // (ribbon + footer "create an organisation" line) stay hidden.
    await playerPage.goto("/me");
    await expect(playerPage.getByTestId("run-your-own")).toBeVisible();
    await page.goto("/me");
    await expect(page.getByTestId("run-your-own")).toHaveCount(0);
    await expect(page.locator('a[href="/orgs/new"]')).toHaveCount(0);
  });

  // Claiming from the INVITE EMAIL signs the player in, in one tap (V464: a claim has two secrets — the
  // organiser's console link, and the one that only ever goes into the email). Cleo is invited through the
  // REAL route; the mail's link is stood in by mintEmailClaimPathBySql (see its doc: the mail is not
  // capturable and its secret is never returned by an API — the producer → mail seam is pinned in
  // claim-invites/__tests__/email-secret.test.ts). Each step below opens a FRESH signed-out context.
  test.describe("emailed link signs in (one tap)", () => {
    const cleoEmail = `delivered+e2e-cleo-${TAG}@resend.dev`;
    let cleo: Person;
    let consoleUrl: string;
    let emailPath: string;

    test("organiser invites Cleo: the console link is returned, the emailed one is not", async ({ request }) => {
      cleo = (
        await apiJson<Person>(request, "/api/v1/persons", "POST", { full_name: `Cleo ${TAG}`, consent: {} })
      ).data!;
      const invite = await apiJson<Record<string, unknown>>(
        request,
        `/api/v1/persons/${cleo.id}/claim-invites`,
        "POST",
        { email: cleoEmail },
      );
      expect(invite.status).toBe(201);
      consoleUrl = invite.data!.claim_url as string;
      expect(consoleUrl).toContain("/claim/pc_");
      emailPath = await mintEmailClaimPathBySql(cleo.id);
      expect(emailPath).toContain("/claim/pc_");
      expect(consoleUrl).not.toContain(emailPath);
      // The response names no field for the emailed link, whatever it is called.
      expect(Object.keys(invite.data!).filter((k) => /email_?(token|secret|claim)/i.test(k))).toEqual([]);
    });

    test("signed out, the organiser's CONSOLE link still asks you to sign in — no one-tap", async ({ browser }) => {
      const ctx = await browser.newContext(SIGNED_OUT);
      const p = await ctx.newPage();
      await p.goto(consoleUrl);
      await expect(p.getByRole("heading", { name: "Claim your profile" })).toBeVisible();
      await expect(p.getByLabel("Email")).toBeVisible();
      await expect(p.getByRole("button", { name: "Claim and sign in" })).toHaveCount(0);
      // The accept route refuses it without a session, exactly as before.
      const consoleToken = consoleUrl.slice(consoleUrl.indexOf("/claim/") + "/claim/".length);
      // Sent the way our own page sends it (Sec-Fetch-Site), so what is refused is the SECRET, not the missing proof.
      const refused = await p.request.post(`/api/claims/${consoleToken}/accept`, {
        headers: { "sec-fetch-site": "same-origin" },
      });
      expect(refused.status()).toBe(401);
      // ...and the emailed secret from outside our page is refused too: no session may start without that proof.
      const noProof = await p.request.post(`/api/claims/${emailPath.slice("/claim/".length)}/accept`);
      expect(noProof.status()).toBe(403);
      await ctx.close();
    });

    test("signed out, the EMAILED link: nothing happens on load; one tap signs in and claims", async ({ browser, request }) => {
      const ctx = await browser.newContext(SIGNED_OUT);
      const p = await ctx.newPage();

      // A mail scanner / link preview GETs the link: it must not consume it or start a session.
      const scan = await ctx.request.get(emailPath);
      expect(scan.status()).toBe(200);
      expect((await ctx.request.get("/api/v1/me/fixtures")).status()).toBe(401);

      await p.goto(emailPath);
      await expect(p.getByRole("heading", { name: "Claim your profile" })).toBeVisible();
      const cta = p.getByRole("button", { name: "Claim and sign in" });
      await expect(cta).toBeVisible();
      // The one primary action on a phone-first page: a 44px tap target, and what is under its centre is the
      // button itself (boundingBox measures paint; elementFromPoint is what a finger hits).
      const box = (await cta.boundingBox())!;
      expect(box.height, "tap target height").toBeGreaterThanOrEqual(44);
      expect(
        await cta.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return hit === el || el.contains(hit);
        }),
        "the button is what sits under its own centre",
      ).toBe(true);
      await expect(p.getByLabel("Email")).toHaveCount(0); // no second email round
      // The invited address is shown masked, not in full.
      await expect(p.getByText(`${cleoEmail[0]}***`, { exact: false }).first()).toBeVisible();
      expect(await p.content()).not.toContain(cleoEmail);
      // Still signed out after the page has loaded and settled.
      expect((await ctx.request.get("/api/v1/me/fixtures")).status()).toBe(401);

      await cta.click();
      await p.waitForURL(/\/me\?claimed=1/, { timeout: 20_000 });
      await expect(p.getByText("Profile claimed")).toBeVisible();

      // Signed in as the invited address, and the organiser sees the profile claimed.
      expect((await ctx.request.get("/api/v1/me/fixtures")).status()).toBe(200);
      const persons = await apiJson<{ items: Person[] }>(request, "/api/v1/persons?limit=200");
      expect(persons.data!.items.find((x) => x.id === cleo.id)?.user_id).toBeTruthy();

      // A stale tab on the same (now used) link is a dead end, not a second sign-in.
      const stale = await (await browser.newContext(SIGNED_OUT)).newPage();
      await stale.goto(emailPath);
      await expect(stale.getByText("Already claimed")).toBeVisible();
      await expect(stale.getByRole("button", { name: "Claim and sign in" })).toHaveCount(0);
      await stale.context().close();
      await ctx.close();
    });

    test("past its sign-in window the emailed link asks you to sign in, like the console link", async ({ browser, request }) => {
      const dara = (
        await apiJson<Person>(request, "/api/v1/persons", "POST", { full_name: `Dara ${TAG}`, consent: {} })
      ).data!;
      const invite = await apiJson(request, `/api/v1/persons/${dara.id}/claim-invites`, "POST", {
        email: `delivered+e2e-dara-${TAG}@resend.dev`,
      });
      expect(invite.status).toBe(201);
      const path = await mintEmailClaimPathBySql(dara.id);
      const token = path.slice("/claim/".length);
      const ctx = await browser.newContext(SIGNED_OUT);
      const p = await ctx.newPage();

      // Inside the window: the one-tap card.
      await p.goto(path);
      const cta = p.getByRole("button", { name: "Claim and sign in" });
      await expect(cta).toBeVisible();
      // A marker on this document: if the page reloads or navigates, it is gone.
      await p.evaluate(() => {
        (window as unknown as { __sameDocument?: boolean }).__sameDocument = true;
      });

      // The window closes while the page is open (the clock is the row's creation time, which the window constant is measured from).
      await withDb(async (sql) => {
        await sql`update person_claims set created_at = created_at - ${`${CLAIM_EMAIL_SIGNIN_MS + 60_000} milliseconds`}::interval
                  where person_id = ${dara.id} and claimed_at is null and revoked_at is null`;
      });

      // The tap lands after it: the server refuses with CLAIM_SIGNIN_EXPIRED and the card turns, IN PLACE, into
      // the normal sign-in — not a raw "Not authenticated", and not a reload.
      await cta.click();
      await expect(p.getByLabel("Email")).toBeVisible({ timeout: 15_000 });
      await expect(p.getByRole("button", { name: "Claim and sign in" })).toHaveCount(0);
      await expect(p.getByText("Not authenticated")).toHaveCount(0);
      await expect(p.getByRole("status").filter({ hasText: /no longer signs you in/i })).toBeVisible();
      expect(await p.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument)).toBe(true);
      expect(new URL(p.url()).pathname).toBe(path);
      // The sign-in it shows brings the visitor back to THIS claim page afterwards (the seam is the link's next=).
      await expect(p.locator(`a[href^="/api/auth/google?next="]`)).toHaveAttribute(
        "href",
        `/api/auth/google?next=${encodeURIComponent(path)}`,
      );
      expect((await ctx.request.get("/api/v1/me/fixtures")).status()).toBe(401); // nothing was signed in

      // A fresh load of the same link past the window shows that sign-in straight away.
      await p.goto(path);
      await expect(p.getByRole("heading", { name: "Claim your profile" })).toBeVisible();
      await expect(p.getByLabel("Email")).toBeVisible(); // the normal sign-in card
      await expect(p.getByRole("button", { name: "Claim and sign in" })).toHaveCount(0);
      // The server enforces it, not the page: the accept route refuses too, with the specific code, and nothing was consumed.
      const refused = await p.request.post(`/api/claims/${token}/accept`, { headers: { "sec-fetch-site": "same-origin" } });
      expect(refused.status()).toBe(401);
      expect(await refused.json()).toMatchObject({ ok: false, code: "CLAIM_SIGNIN_EXPIRED" });
      expect((await ctx.request.get("/api/v1/me/fixtures")).status()).toBe(401);
      await ctx.close();
    });
  });
});
