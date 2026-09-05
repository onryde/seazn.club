import { test, expect, type Page } from "@playwright/test";
import { failOnNativeDialog, loginUi } from "../helpers";
import { dismissConsent, freshOrg, stamp, waitForHydration } from "../directory-kit";

/**
 * The organiser's identity journey on /directory?tab=players, driven by hand.
 *
 * Test A asserts the duplicate queue in BOTH directions — that a real duplicate
 * is proposed, and that a same-name pair with DIFFERING dobs is suppressed. The
 * suppression case is the one no existing spec makes, and it is what a
 * "suggest everything" mutant dies on.
 *
 * Test B follows ONE claim link through every ending it has, and asserts each
 * ending from the INVITEE's browser rather than from the organiser's console:
 * a link that is dead in the database while it still renders a claim button is
 * exactly the defect a console-side assertion cannot see.
 *
 * Fresh org, deliberately. The walkthrough project's storageState is the shared
 * PRO org, and the Players tab renders only the OLDEST 200 persons
 * (`PlayersTab` in src/app/directory/page.tsx passes `limit: 200`; `listPersons`
 * orders by `created_at, id` ascending) — so a person created late in a shared
 * org is not on the page at all, and every assertion below would pass or fail
 * on who else ran first.
 */
test.use({ storageState: { cookies: [], origins: [] } });

/**
 * 120s, matching every other walkthrough spec in this folder (`venues.spec.ts`
 * takes 120s for a strictly smaller journey; others go to 600s). These five
 * shipped on the project's flat 60s default, which was a deliberate speed
 * constraint in the design — and it was wrong.
 *
 * Measured 2026-09-05 on a loaded box: these specs run 7-35s idle and went
 * 26.7s / 57.5s / 1.1m under load, with one crossing 60s on a plain
 * `page.goto`. CI is worse, not better: `e2e.yml` runs `--workers=3` on a
 * 4-vcpu runner shared with Postgres and the Next server.
 *
 * The cost of being wrong here is asymmetric. On overrun Playwright prints
 * whichever poll was in flight ABOVE the timeout line, so a blown clock reads
 * as a data defect — in the same run, two scorepad specs reported
 * "Expected: 9 / Received: 8" over "Test timeout of 240000ms exceeded". A red
 * that lies about its own cause costs more than a slower budget. 120s still
 * catches a real regression against a 35s ceiling.
 */
test.setTimeout(120_000);


/** Contexts this file opened, closed from `afterEach` and NOT from a `finally`.
 *
 *  A Playwright test that exhausts its budget is torn down without unwinding —
 *  `finally` never runs, and only the hooks do. The cleanup below therefore has
 *  to be armed as a hook, or a timeout leaks every extra browser context the
 *  test opened, in a project that runs four workers wide.
 *
 *  `splice(0)` so the list is emptied as it is drained: the hook runs after
 *  BOTH tests in this file, and the first opens no contexts at all. `.catch`
 *  because a context already closed by a crashed browser must not turn cleanup
 *  into a second, more confusing failure on top of the real one. */
const opened: Page[] = [];
test.afterEach(async () => {
  for (const p of opened.splice(0)) await p.context().close().catch(() => {});
});

const roster = (page: Page) => page.getByRole("table", { name: "Players" });
const queue = (page: Page) => page.getByRole("region", { name: "Possible duplicates" });

/**
 * Enter one player through the form the organiser uses, and return the id the
 * roster row carries.
 *
 * The count-before / poll-to-`before + 1` dance is not ceremony. This spec
 * enters the SAME name three times on purpose, and the roster is a real table:
 * a locator reading "the row for Alex Morgan" resolves to two elements on the
 * second call, at which point Playwright aborts on a strict-mode violation
 * instead of asserting anything. Counting first also makes a silently-refused
 * submit a red here rather than a confusing `null` id below.
 *
 * `nth(before)` is the row this call created because `listPersons` orders by
 * `created_at, id` ASCENDING — the newest matching row is always last.
 */
async function addPerson(
  page: Page,
  opts: { name: string; dob?: string },
): Promise<string> {
  const rows = roster(page).getByRole("row", { name: new RegExp(escapeRe(opts.name)) });
  const before = await rows.count();

  await page.getByLabel("Full name").fill(opts.name);
  if (opts.dob) await page.getByLabel("DOB (eligibility only)").fill(opts.dob);
  await page.getByRole("button", { name: "Add player" }).click();

  await expect
    .poll(() => rows.count(), {
      timeout: 15_000,
      message: `roster row for "${opts.name}" after Add player`,
    })
    .toBe(before + 1);

  const id = await rows.nth(before).locator("[data-merge-pick]").getAttribute("data-merge-pick");
  if (!id) throw new Error(`no person id on the row for "${opts.name}"`);
  return id;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("the duplicate queue proposes a real pair and suppresses a false one", async ({ page }) => {
  failOnNativeDialog(page);
  const s = stamp();
  await freshOrg(page, "identity");
  // Blank storageState inherits no consent dismissal, and the banner is a fixed
  // overlay that intercepts clicks on anything in the last card (directory-kit).
  await dismissConsent(page);
  await page.goto("/directory?tab=players");
  // A nav resolves before React attaches handlers, so the first click after one
  // can be swallowed with no way to recover it. Anchored on the ADD FORM, not
  // the roster: a fresh org has no players, so the roster table is not in the
  // DOM at all yet — and the add form is what `addPerson` drives next.
  await waitForHydration(page.getByRole("button", { name: "Add player" }));

  // One human, entered twice: same folded name, same dob. The queue's entry
  // ticket is a shared normalised name; the matching dob raises the rank.
  const twinName = `Alex Morgan ${s}`;
  const keepId = await addPerson(page, { name: twinName, dob: "1990-04-02" });
  const dupeId = await addPerson(page, { name: twinName, dob: "1990-04-02" });

  // A DIFFERENT human who happens to share the name. A differing non-null dob
  // SUPPRESSES the pair outright (person-duplicates.ts) — it is the strongest
  // evidence in the data that these are two people.
  const otherId = await addPerson(page, { name: twinName, dob: "1986-11-19" });

  await page.reload();

  const pair = queue(page).locator(`[data-candidate="${keepId}:${dupeId}"]`);
  await expect(pair).toBeVisible({ timeout: 15_000 });

  // data-evidence-on, NOT mere presence: all three chips always render
  // (duplicates-panel.tsx — "Three signals, always all three"), so a presence
  // assertion would pass on its own inversion. The `false` below is what proves
  // these three read a varying attribute rather than three identical `true`s.
  await expect(pair.locator('[data-evidence-kind="name"]')).toHaveAttribute(
    "data-evidence-on",
    "true",
  );
  await expect(pair.locator('[data-evidence-kind="dob"]')).toHaveAttribute(
    "data-evidence-on",
    "true",
  );
  // Nobody has been entered into an entrant, so the third signal must be off.
  await expect(pair.locator('[data-evidence-kind="shared_entrant"]')).toHaveAttribute(
    "data-evidence-on",
    "false",
  );

  // The suppression. The third person must appear in NO pair, in either order.
  for (const id of [keepId, dupeId]) {
    await expect(queue(page).locator(`[data-candidate="${otherId}:${id}"]`)).toHaveCount(0);
    await expect(queue(page).locator(`[data-candidate="${id}:${otherId}"]`)).toHaveCount(0);
  }
  // And the queue holds exactly the one pair — assertable only because the org
  // is this spec's own.
  await expect(queue(page).locator("[data-candidate]")).toHaveCount(1);
});

/**
 * One claim link, followed to every ending the console can give it:
 *
 *   1. the WRONG address opens it     -> refused, and the invite SURVIVES
 *   2. the organiser withdraws it     -> "Invite withdrawn"
 *   3. the organiser invites again    -> the withdrawn link STAYS withdrawn
 *   4. the invited address accepts it -> spent; "Already claimed" ever after,
 *                                        and an unlink does not hand it back
 *
 * Step 3's positive control — the CURRENT link still works, from the same
 * browser that was just refused twice — is what stops the four refusals above
 * from passing on a claim page that simply never offers the button.
 *
 * Two endings the brief asked for are NOT here, because the console cannot
 * reach them: minting a second invite while one is still OPEN (the row's verb
 * is "Withdraw invite" from the moment router.refresh() lands, so
 * reviveClaimInvite's revoke-on-mint needs a stale second console), and the
 * unlink KILLING a live link (unlink can only follow a claim, and
 * settleClaimRow tests claimed_at before revoked_at, so the dead-end stays
 * "Already claimed" either way). See the task report.
 */
test("a claim link is not transferable, and a withdrawn or spent one never comes back", async ({
  page,
  browser,
}) => {
  failOnNativeDialog(page);
  const s = stamp();
  await freshOrg(page, "claims");
  await dismissConsent(page);
  await page.goto("/directory?tab=players");
  await waitForHydration(page.getByRole("button", { name: "Add player" }));

  const personName = `Rae Sandoval ${s}`;
  await addPerson(page, { name: personName });

  // ResponsiveTable renders every row TWICE — a `hidden sm:block` <table> and
  // an `sm:hidden` card <ul>, both always in the DOM. That does NOT make an
  // unscoped role locator ambiguous: Playwright's queryRole skips elements
  // hidden for ARIA unless `includeHidden`, and the card list is display:none
  // at this project's desktop viewport. The TEXT engine has no such filter, so
  // it is chip assertions that resolve twice — the brief's own
  // page.getByText("Invite pending") is the shape that breaks. Reading
  // everything through the desktop table's single row (the fresh org holds
  // exactly this one person) makes both kinds unambiguous for the same reason.
  const row = () => roster(page).getByRole("row", { name: new RegExp(escapeRe(personName)) });
  const control = (name: string) => row().getByRole("button", { name });
  const claimButton = (p: Page) => p.getByRole("button", { name: /This is me — claim/ });

  const ownerEmail = `claimant-a-${s}@example.com`;
  const strangerEmail = `claimant-b-${s}@example.com`;

  /** Send an invite through the organiser's own dialog; return the one-time
   *  link it prints. */
  async function invite(email: string): Promise<string> {
    await control("Invite to claim…").click();
    const dialog = page.getByRole("dialog", {
      name: `Invite ${personName} to claim their profile`,
    });
    await dialog.getByLabel("Their email").fill(email);
    await dialog.getByRole("button", { name: "Send invite" }).click();

    // "Done" renders on BOTH outcomes of the POST, so waiting on it is what
    // makes the next line a real check instead of one against a dialog that
    // has not answered yet — `toHaveCount(0)` is satisfied by an empty page.
    const done = dialog.getByRole("button", { name: "Done" });
    await expect(done).toBeVisible({ timeout: 15_000 });
    // The link is the send-FAILURE fallback (invite-claim.tsx): with a mailer
    // configured the dialog shows `claim-emailed` and no link at all, and this
    // spec has to say that out loud rather than die on a null further down.
    await expect(
      dialog.getByTestId("claim-emailed"),
      "the mailer accepted this invite, so no link is shown — this spec needs the send-failure fallback",
    ).toHaveCount(0);
    // The fallback is CI's path too, not just this machine's: e2e.yml sets no
    // RESEND_API_KEY, and lib/email.ts's send() returns false when it is unset
    // (officials-directory.spec.ts already leans on exactly this).
    const link = (await dialog.getByTestId("claim-link").textContent())?.trim();
    if (!link) throw new Error("no claim link rendered");
    await done.click();

    // The row's verb flips from "Invite to claim…" to "Withdraw invite" only
    // once router.refresh() lands, which is AFTER the dialog closes. Settling
    // on the badge here is what keeps a later step off a stale button.
    await expect(row()).toContainText("Invite pending");
    return link;
  }

  /** A real second human: a context with genuinely EMPTY storage. A bare
   *  browser.newContext() inherits the organiser's session, and every refusal
   *  below then passes against the wrong identity. */
  async function signIn(email: string): Promise<Page> {
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const p = await ctx.newPage();
    // Registered BEFORE the login, so a context whose loginUi throws is closed
    // too rather than leaking into the rest of the run.
    opened.push(p);
    failOnNativeDialog(p);
    // "/" rather than the claim link: safeNextPath (lib/auth.ts) rejects any
    // `next` that is not a bare path, so handing loginUi the absolute claim_url
    // drops the claimant into postAuthLanding's auto-provision branch and they
    // never see the claim page at all. They navigate themselves below — to the
    // string the console PRINTED, never one this spec assembles.
    await loginUi(p, email, "/");
    // EVERY blank-storage context owes this, not just the organiser's. This one
    // clicks — `claimButton(owner).click()` below — and the consent banner is
    // `fixed bottom-4 … z-40`, so it intercepts pointer events over the last
    // card on a page. The claim page's button happens to sit clear of it today,
    // which makes this spec lucky about layout rather than safe: a control added
    // to that card, or a shorter viewport, turns the click into a retry-until-
    // timeout whose failure names the BUTTON and never the banner.
    await dismissConsent(p);
    return p;
  }

  const stranger = await signIn(strangerEmail);
  const owner = await signIn(ownerEmail);
  const link1 = await invite(ownerEmail);

  // --- 1. not transferable ------------------------------------------------
  // The stranger holds the whole link, signed in, and is refused by name.
  await stranger.goto(link1);
  await expect(
    stranger.getByRole("heading", { name: "Wrong account for this invite" }),
  ).toBeVisible();
  await expect(claimButton(stranger)).toHaveCount(0);

  // ...and the attempt did not consume the invite: it is still open.
  await page.reload();
  // The control about to be clicked, not the page: it exists by now (the row
  // is invited) and is the thing whose handler must be attached.
  await waitForHydration(control("Withdraw invite"));
  await expect(row()).toContainText("Invite pending");

  // --- 2. the organiser withdraws it -------------------------------------
  await control("Withdraw invite").click();
  // A negative and its positive twin, and the twin is the load-bearing half:
  // `not.toContainText` returns `{ matches: isNot }` for a locator resolving
  // to ZERO elements, so on its own it passes against a row that vanished or
  // a locator that drifted. The verb returning to "Invite to claim…" pins the
  // row's real post-state instead of the absence of a string.
  await expect(row()).not.toContainText("Invite pending");
  await expect(control("Invite to claim…")).toBeVisible();
  await owner.goto(link1);
  await expect(owner.getByRole("heading", { name: "Invite withdrawn" })).toBeVisible();
  await expect(claimButton(owner)).toHaveCount(0);

  // --- 3. a fresh invite does not revive the withdrawn one ----------------
  const link2 = await invite(ownerEmail);
  expect(link2).not.toBe(link1);
  await owner.goto(link1);
  await expect(owner.getByRole("heading", { name: "Invite withdrawn" })).toBeVisible();

  // The positive control: the CURRENT link works, in the same browser that
  // was just refused twice.
  await owner.goto(link2);
  await waitForHydration(claimButton(owner));
  await claimButton(owner).click();
  await owner.waitForURL(/\/me(\?|$)/, { timeout: 15_000 });
  await page.reload();
  await waitForHydration(control("Unlink"));
  await expect(row()).toContainText("Claimed");

  // --- 4. accepting spends it --------------------------------------------
  await owner.goto(link2);
  await expect(owner.getByRole("heading", { name: "Already claimed" })).toBeVisible();
  await expect(claimButton(owner)).toHaveCount(0);

  // ...and the organiser's unlink hands the PROFILE back without handing the
  // spent link back with it.
  await control("Unlink").click();
  const unlinkDialog = page.getByRole("dialog", { name: "Unlink this player account?" });
  // tone: danger. The confirm is a click, never Enter.
  await unlinkDialog.getByRole("button", { name: "Unlink" }).click();
  // Same pair as after the withdraw, and it matters more here: this is the
  // ONLY assertion of what the unlink did to the console, so the empty-row
  // vacuity above would let "unlink worked" be reported by a row that is not
  // there. The invite verb coming back is also the real claim being made —
  // the profile is invitable again.
  await expect(row()).not.toContainText("Claimed");
  await expect(control("Invite to claim…")).toBeVisible();
  await owner.goto(link2);
  await expect(owner.getByRole("heading", { name: "Already claimed" })).toBeVisible();
  await expect(claimButton(owner)).toHaveCount(0);
});
