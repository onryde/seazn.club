// Player payment page (plan 2026-11-11-player-payment-page, Tasks 4 and 5): the page a chase mail links, `/r/pay/<token>`, driven
// in a browser against a prod build. The token is never hand-made: a REAL producer issues it into a REAL mail, and the runner opens
// that mail's sealed body (e2e/outbox-body-open.ts) and follows its link, as the registrant would.
//
// Which producer: the sweep's T-24h reminder (`POST /api/cron/registrations`), because it is the one whose first attempt is the
// WORKER's - its row still holds its sealed body when the runner reads it. The organiser's reminder (`POST
// /api/v1/registrations/:id/remind`) attempts at once, and with no Resend key (CI, local) that attempt ends the row `dead` and drops
// its body, so its link cannot be read back; the spec still drives it and proves it queued a mail and issued a token.
//
// Needs, in BOTH the server's and this runner's env: EMAIL_OUTBOX_KEK (same value; without it bodies are not sealed) and
// CRON_SECRET (same value). e2e.yml sets both job-level.
//
// Widths: 320, 768 and 1280 (the page is public, so the full bar), with no horizontal page scroll at any of them.
import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { apiJson, TAG, withDb } from "./helpers";
import {
  escapeRe, INSTRUCTIONS, noHorizontalScroll, putSettings, seedDueEntry, seedRig, sweepAndOpenLink, tokensFor, WIDTHS,
} from "./pay-page-kit";

const enUi = JSON.parse(
  readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
) as Record<string, string>;

test.describe("player payment page", () => {
  test("offline entry shows instructions and no Pay", async ({ browser }) => {
    test.setTimeout(150_000);
    const rig = await seedRig(browser);
    const entry = await seedDueEntry(rig, `Offline Entrant ${TAG}`);
    const path = await sweepAndOpenLink(rig.owner, entry.regId);
    expect(await tokensFor(entry.regId), "the sweep's reminder issued one token").toBe(1);

    // The organiser switches the division to offline after the mail went out: the page reads the method at view time.
    await putSettings(rig.owner, rig.divisionId, "offline");

    const visitor = await (await browser.newContext()).newPage();
    let checked = 0;
    for (const width of WIDTHS) {
      await visitor.setViewportSize({ width, height: 900 });
      const res = await visitor.goto(path);
      expect(res?.status(), `${width}: the page answers 200`).toBe(200);
      await expect(visitor.getByTestId("pay-page")).toBeVisible();
      await expect(visitor.getByTestId("pay-offline"), `${width}: the offline panel`).toBeVisible();
      await expect(visitor.getByTestId("pay-offline")).toContainText(INSTRUCTIONS);
      await expect(visitor.getByTestId("pay-offline")).toContainText(entry.refCode);
      await expect(visitor.getByTestId("pay-form"), `${width}: no Pay form`).toHaveCount(0);
      await expect(visitor.getByTestId("pay-page")).toContainText(rig.compName);
      await expect(visitor.getByTestId("pay-page")).toContainText(rig.divName);
      await noHorizontalScroll(visitor, `offline @${width}`);
      checked += 1;
    }
    expect(checked).toBe(WIDTHS.length);

    // The organiser's own reminder, through the real API, now for an offline entry: it answers, queues one mail and issues one
    // more token. (Its body is attempted at once and so is not readable here - see the header.)
    const remind = await apiJson<{ sent: boolean }>(rig.owner.request, `/api/v1/registrations/${entry.regId}/remind`, "POST");
    expect(remind.status, JSON.stringify(remind.error)).toBe(200);
    expect(await tokensFor(entry.regId), "the organiser's reminder issued a token of its own").toBe(2);
    const manual = await withDb((sql) => sql<{ n: string }[]>`
      select count(*)::text as n from email_outbox
       where kind = 'payment_reminder' and ref_type = 'registration' and ref_id = ${entry.regId} and dedupe_key is null`);
    expect(Number(manual[0]!.n), "one organiser reminder row").toBe(1);
    // Every token for an entry stays valid: the sweep's link still opens the page.
    await visitor.setViewportSize({ width: 1280, height: 900 });
    await visitor.goto(path);
    await expect(visitor.getByTestId("pay-offline")).toBeVisible();
  });

  // Task 6: the organiser's button on the registrant panel. The panel's own states are asserted (a mail provider is not configured
  // here, so whether the first attempt was accepted - "sent" or "may arrive late" - depends on the environment; either is a
  // truthful answer and both are pinned by the unit tests). The audit ledger is the arbiter of how many presses went through.
  test("organiser reminds from the panel", async ({ browser }) => {
    test.setTimeout(180_000);
    const rig = await seedRig(browser);
    const entry = await seedDueEntry(rig, `Panel Entrant ${TAG}`);
    const pressed = () =>
      withDb(async (sql) => Number((await sql<{ n: string }[]>`
        select count(*)::text as n from competition_events
         where type = 'registration.payment_reminded' and payload->>'registration_id' = ${entry.regId}`)[0]!.n));
    const sentCopy = enUi["reg.remind.sent"]!;
    const notSentCopy = enUi["reg.remind.notSent"]!;
    const limitCopy = enUi["reg.remind.limit"]!;
    const page = rig.owner;
    const url = `/o/${rig.orgSlug}/c/${rig.compSlug}/registration?tab=registrants`;
    const open = async () => {
      await page.goto(url, { waitUntil: "load" });
      const row = page.locator(`[data-registration-hub-registrant-row][data-registration-id="${entry.regId}"]`);
      await expect(row).toBeVisible({ timeout: 20_000 });
      if (!(await row.evaluate((el) => (el as HTMLDetailsElement).open))) await row.locator("summary").click();
      await expect(row.locator("[data-registration-hub-registrant-detail]")).toBeVisible();
      return row;
    };
    const feedback = (row: ReturnType<Page["locator"]>) => row.locator("[data-registration-hub-registrant-actions-feedback]");
    const lastReminded = (row: ReturnType<Page["locator"]>) => row.locator("[data-registration-hub-registrant-last-reminded]");

    await page.setViewportSize({ width: 1280, height: 900 });
    let row = await open();
    const button = row.locator('[data-registration-hub-registrant-action="remind"]');
    await expect(button, "the button is offered on a pending entry in a division with a fee").toBeVisible();
    await expect(button).toHaveText(enUi["reg.action.remind"]!);
    await expect(lastReminded(row), "never reminded: no line").toHaveCount(0);
    const order = await row.locator("[data-registration-hub-registrant-action]").evaluateAll((els) => els.map((e) => e.getAttribute("data-registration-hub-registrant-action")));
    expect(order.indexOf("remind"), "after Resend confirmation email").toBe(order.indexOf("resend") + 1);

    // First press: no confirm; the panel says what happened and then shows when.
    await button.click();
    await expect(page.getByRole("alertdialog"), "no confirm on a first press").toHaveCount(0);
    await expect(feedback(row)).toHaveText(new RegExp(`^(${escapeRe(sentCopy)}|${escapeRe(notSentCopy)})$`), { timeout: 20_000 });
    expect(await pressed()).toBe(1);
    await expect(lastReminded(row), "Last reminded appears after the refresh").toContainText(enUi["reg.remind.lastReminded"]!.split("{when}")[0]!.trim(), { timeout: 20_000 });

    // Second press inside the hour: asks first; cancelling sends nothing, confirming sends.
    await button.click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(enUi["reg.remind.confirmRecent.title"]!);
    await dialog.getByRole("button").first().click();
    await expect(dialog).toHaveCount(0);
    expect(await pressed(), "cancelled: nothing went out").toBe(1);
    await button.click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button").last().click();
    await expect.poll(pressed, { timeout: 20_000 }).toBe(2);

    // The cap, through the real route: three more audit rows make five; the sixth press is refused in the panel's own words.
    await withDb(async (sql) => {
      const [c] = await sql<{ competition_id: string }[]>`select d.competition_id from divisions d where d.id = ${rig.divisionId}`;
      for (let i = 0; i < 3; i++) {
        await sql`insert into competition_events (competition_id, org_id, type, payload)
                  values (${c!.competition_id}, ${rig.orgId}, 'registration.payment_reminded', ${sql.json({ registration_id: entry.regId })})`;
      }
    });
    row = await open();
    await row.locator('[data-registration-hub-registrant-action="remind"]').click();
    await page.getByRole("alertdialog").getByRole("button").last().click();
    await expect(feedback(row)).toHaveText(limitCopy, { timeout: 20_000 });
    expect(await pressed(), "the sixth press queued nothing").toBe(5);

    // The panel at the other widths: the button and the line are reachable, with no horizontal page scroll.
    let checked = 0;
    for (const width of [320, 768, 1280] as const) {
      await page.setViewportSize({ width, height: 900 });
      row = await open();
      await expect(row.locator('[data-registration-hub-registrant-action="remind"]'), `${width}: the button`).toBeVisible();
      await expect(lastReminded(row), `${width}: last reminded`).toBeVisible();
      await noHorizontalScroll(page, `panel @${width}`);
      checked += 1;
    }
    expect(checked).toBe(3);
  });

  test("unknown token is the opaque 404", async ({ browser }) => {
    test.setTimeout(150_000);
    const rig = await seedRig(browser);
    const entry = await seedDueEntry(rig, `Withdrawn Entrant ${TAG}`);
    const realPath = await sweepAndOpenLink(rig.owner, entry.regId);
    // The positive pair: the real token opens the page before the entry is withdrawn.
    const visitor = await (await browser.newContext()).newPage();
    await visitor.goto(realPath);
    await expect(visitor.getByTestId("pay-form")).toBeVisible();

    const withdraw = await apiJson(rig.owner.request, `/api/v1/registrations/${entry.regId}/withdraw`, "POST");
    expect(withdraw.status, JSON.stringify(withdraw.error)).toBeLessThan(300);

    const unknownPath = `/r/pay/${randomBytes(32).toString("base64url")}`;
    const title = enUi["regPay.notFound.title"]!;
    const bodyCopy = enUi["regPay.notFound.body"]!;
    let checked = 0;
    for (const width of WIDTHS) {
      await visitor.setViewportSize({ width, height: 900 });
      const texts: string[] = [];
      for (const [label, path] of [["unknown", unknownPath], ["withdrawn", realPath]] as const) {
        const res = await visitor.goto(path);
        expect(res?.status(), `${label} @${width}: 404`).toBe(404);
        const notFound = visitor.getByTestId("pay-not-found");
        await expect(notFound, `${label} @${width}: the one not-found`).toBeVisible();
        await expect(notFound).toContainText(title);
        await expect(notFound).toContainText(bodyCopy);
        await expect(visitor.getByTestId("pay-page")).toHaveCount(0);
        await expect(visitor.getByTestId("pay-form")).toHaveCount(0);
        await noHorizontalScroll(visitor, `${label} @${width}`);
        texts.push(await notFound.innerText());
        checked += 1;
      }
      expect(texts[1], `@${width}: a withdrawn entry's real token reads exactly as an unknown one`).toBe(texts[0]);
    }
    expect(checked).toBe(WIDTHS.length * 2);
  });
});
