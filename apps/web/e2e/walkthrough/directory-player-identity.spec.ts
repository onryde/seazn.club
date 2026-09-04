import { test, expect, type Page } from "@playwright/test";
import { failOnNativeDialog, loginUi } from "../helpers";
import { freshOrg, stamp } from "../directory-kit";

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
  await page.goto("/directory?tab=players");

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
  await page.goto("/directory?tab=players");

  const personName = `Rae Sandoval ${s}`;
  await addPerson(page, { name: personName });

  // Scoping through `roster` is not tidiness. ResponsiveTable renders every
  // cell TWICE — a `hidden sm:block` <table> and an `sm:hidden` card <ul>,
  // both always in the DOM — so a bare page.getByRole("button", { name:
  // "Unlink" }) is a strict-mode violation rather than a miss. The org holds
  // exactly this one person, so the row locator is unambiguous.
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
    failOnNativeDialog(p);
    // "/" rather than the claim link: safeNextPath (lib/auth.ts) rejects any
    // `next` that is not a bare path, so handing loginUi the absolute claim_url
    // drops the claimant into postAuthLanding's auto-provision branch and they
    // never see the claim page at all. They navigate themselves below — to the
    // string the console PRINTED, never one this spec assembles.
    await loginUi(p, email, "/");
    return p;
  }

  const stranger = await signIn(strangerEmail);
  const owner = await signIn(ownerEmail);
  try {
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
    await expect(row()).toContainText("Invite pending");

    // --- 2. the organiser withdraws it -------------------------------------
    await control("Withdraw invite").click();
    await expect(row()).not.toContainText("Invite pending");
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
    await claimButton(owner).click();
    await owner.waitForURL(/\/me(\?|$)/, { timeout: 15_000 });
    await page.reload();
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
    await expect(row()).not.toContainText("Claimed");
    await owner.goto(link2);
    await expect(owner.getByRole("heading", { name: "Already claimed" })).toBeVisible();
    await expect(claimButton(owner)).toHaveCount(0);
  } finally {
    await stranger.context().close();
    await owner.context().close();
  }
});
