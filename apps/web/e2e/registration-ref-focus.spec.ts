// Walk-fix F1: a TYPED entry reference opens the ticket on THAT entry. A cart sent with two entries hands each its own reference
// (`SZ-XXXX-XXXX-1`, `-2`); the player who types entry 2's reaches `/r/<ref>-2` and must land on entry 2 - its own heading, first -
// with the cart's other entry folded away below, not on the cart's first entry. The bare cart reference keeps the whole ticket.
//
// Driven in a browser against a prod build (the ticket's focus is server-rendered; the fold is a native <details>, so the check that
// it is CLOSED is the browser's, not markup's). The cart is seeded the way the submit path writes one: a group with its reference,
// then two entries whose positions the database's own trigger assigns (V519 trg_cart_position) - never typed here. The reference the
// player types is built by `entryReferenceOf`, the one function every mail and page prints it with.
//
// Widths: 320, 768 and 1280 (a public page: the full bar), with no horizontal page scroll at any of them.
import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { withDb } from "./helpers";
import { noHorizontalScroll, seedRig, WIDTHS } from "./pay-page-kit";
import { entryReferenceOf, generateRefCode } from "../src/lib/ref-code";

const enUi = JSON.parse(
  readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
) as Record<string, string>;
const heading = (position: number, name: string) =>
  enUi["ref.focus.heading"]!.replace("{position}", String(position)).replace("{name}", name);

test.describe("a typed entry reference opens the ticket on that entry (walk-fix F1)", () => {
  test("entry 2's reference focuses entry 2, entry 1's focuses entry 1, the bare reference shows the cart", async ({ browser }) => {
    test.setTimeout(150_000);
    const rig = await seedRig(browser);
    const ref = generateRefCode();
    const names = [`First Entry ${randomBytes(2).toString("hex")}`, `Second Entry ${randomBytes(2).toString("hex")}`] as const;
    const cart = await withDb(async (sql) => {
      const [g] = await sql<{ id: string }[]>`
        insert into registration_groups
          (competition_id, contact_name, contact_email, access_token_hash, amount_cents, currency, payment_method, expires_at,
           locale, ref_code, privacy_consent_at, privacy_consent_version)
        values (${rig.competitionId}, ${names[0]}, ${`delivered+reffocus-${randomBytes(4).toString("hex")}@resend.dev`},
                ${randomBytes(32).toString("hex")}, 3000, 'gbp', 'stripe', now() + interval '10 hours', 'en', ${ref}, now(), 'e2e')
        returning id`;
      for (const name of names) {
        await sql`
          insert into registrations (group_id, division_id, display_name, status, amount_cents)
          values (${g!.id}, ${rig.divisionId}, ${name}, 'pending', 1500)`;
      }
      return sql<{ display_name: string; cart_position: number; cart_size: number }[]>`
        select r.display_name, r.cart_position, g.cart_size from registrations r join registration_groups g on g.id = r.group_id
         where r.group_id = ${g!.id} order by r.cart_position`;
    });
    expect(cart.map((r) => [r.display_name, r.cart_position, r.cart_size]), "premise: the trigger placed them 1 and 2 of 2").toEqual([
      [names[0], 1, 2],
      [names[1], 2, 2],
    ]);
    const typed = cart.map((r) => entryReferenceOf({ ref_code: ref, cart_position: r.cart_position, cart_size: r.cart_size })!);
    expect(typed, "premise: each entry has its own reference").toEqual([`${ref}-1`, `${ref}-2`]);

    const visitor = await (await browser.newContext()).newPage();
    let checked = 0;
    for (const width of WIDTHS) {
      await visitor.setViewportSize({ width, height: 900 });
      for (const [i, entryRef] of typed.entries()) {
        const position = i + 1;
        const res = await visitor.goto(`/r/${entryRef}`);
        expect(res?.status(), `${width} ${entryRef}: 200`).toBe(200);
        const focus = visitor.getByTestId("ref-focus-entry");
        await expect(focus, `${width} ${entryRef}: the focused entry`).toBeVisible();
        await expect(visitor.locator("#ref-focus-heading")).toHaveText(heading(position, names[i]!));
        // The other entry is folded away, CLOSED, below the focused one.
        const others = visitor.getByTestId("ref-other-entries");
        await expect(others).toHaveCount(1);
        expect(await others.evaluate((d) => (d as HTMLDetailsElement).open), `${width} ${entryRef}: the fold starts closed`).toBe(false);
        await expect(others.getByText(names[1 - i]!, { exact: false })).toBeHidden();
        const focusTop = await focus.evaluate((el) => el.getBoundingClientRect().top);
        const othersTop = await others.evaluate((el) => el.getBoundingClientRect().top);
        expect(focusTop, `${width} ${entryRef}: the focused entry comes first`).toBeLessThan(othersTop);
        expect(focusTop, `${width} ${entryRef}: in the first viewport`).toBeLessThan(900);
        await noHorizontalScroll(visitor, `${entryRef} @${width}`);
        checked += 1;
      }
      // The bare cart reference: no focus, both entries on the ticket.
      await visitor.goto(`/r/${ref}`);
      await expect(visitor.getByTestId("ref-focus-entry")).toHaveCount(0);
      await expect(visitor.getByTestId("ref-other-entries")).toHaveCount(0);
      for (const name of names) await expect(visitor.getByText(name, { exact: false }).first()).toBeVisible();
      await noHorizontalScroll(visitor, `bare @${width}`);
      checked += 1;
    }
    expect(checked, "anti-vacuity: two entry references and the bare one at each width").toBe(WIDTHS.length * 3);
  });
});
