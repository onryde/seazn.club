// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { type Session, newSession, raw, call, check, signIn, tag, smokeDb, setPlan } from "../harness.ts";

/**
 * v17 gap #293 — the extra-organisation recurring add-on, end to end at the
 * wire, on BOTH paths.
 *
 * PRO path (the payer): a Pro payer standing on their plan's 5-org cap is
 * refused a plain "create org #6" with a 402 that CARRIES a purchase offer;
 * buying the rider lifts the cap by exactly one and the SAME create then
 * succeeds. The refusal is asserted BEFORE the purchase deliberately — "the
 * create succeeded" is evidence of a lift only if it was first proven refused.
 *
 * FREE path (community): an owner at the community one-org cap is refused on
 * the same wire path with NO offer. Community has no rider SKU, so the remedy
 * is an upgrade; offering a purchase there would only relocate the dead end to
 * the purchase route's 400 one screen later.
 *
 * NON-PAYER: an owner of organisations INSIDE the Pro group above, at the
 * very same cap, who is not that group's `subscriptions.owner_user_id`. Also
 * refused, also with no offer — the purchase route (setExtraOrgs →
 * requireBillingOwner) 403s anyone but the payer. Reachable in production:
 * transferGroup moves the payer and leaves org owners where they are.
 *
 * The two absences are worth something only because the payer's arm proves the
 * offer DOES reach this wire on the byte-identical request; that arm is their
 * positive discriminator, and the 402 shape asserted is the TOP-LEVEL one
 * (`lib/http.ts` spreads `extra` next to `feature_key`; the /api/v1 serialiser
 * deliberately does not, and this route is not a v1 route).
 *
 * Nine of the ten organisations are seeded straight into the DB, and the
 * "purchase" writes the `org_addons` row the real webhook
 * (billing-events.syncOrgAddonsForSubscription) is the single writer of —
 * smoke has no live Stripe, exactly as setPlan's own doc comment describes for
 * plans. The attach HTTP round trip is already proven end to end by the
 * billing-group block in main(); this suite's job is the cap BOUNDARY, not
 * attach mechanics. No cache bust is needed after the add-on insert:
 * `getLimit` is the CACHED plan base plus an UNCACHED `org_addons` sum
 * (lib/entitlements.ts), unlike a raw `plan_key` write, which is why the plan
 * flip at the end goes through setPlan and the purchase does not.
 *
 * Own fresh group; keyless-safe, no Stripe calls.
 */
export async function extraOrgAddonSuite(): Promise<void> {
  // orgs.max_owned: community 1 / pro 5. V393 (entitlements v18) deleted the
  // `pro_plus` plan this suite used to start on — and enterprise, the rung that
  // replaced it, resolves orgs.max_owned to NULL (unlimited), which would leave
  // this suite with no boundary to stand on and every refusal below vacuous.
  // So it runs on the two tiers that still HAVE a finite cap: it fills Pro to
  // its cap of 5 and ends by dropping to community's 1. The rider RATE is
  // Stripe's business and is pinned by the BILLING_LIVE suite; what smoke owns
  // is the CAPACITY those caps bound.
  const PRO_ORG_CAP = 5;
  const COMMUNITY_ORG_CAP = 1;

  interface Refusal {
    feature_key?: string;
    reason?: string;
    offer?: string;
  }
  const refusal = (j: unknown) => j as Refusal;

  // Resolved entitlements for an org — the same endpoint the billing tab reads.
  const orgCap = async (s: Session, orgId: string) =>
    (
      (await call(s, `/api/orgs/${orgId}/entitlements`)) as {
        entitlements: Record<string, { limit?: number | null }>;
      }
    ).entitlements["orgs.max_owned"]?.limit;

  const payerEmail = `delivered+orgaddon_${tag}@resend.dev`;
  const payer = newSession();
  const auth = await signIn(payer, payerEmail);
  await setPlan(auth.org_id, "pro", payer); // busts the entitlement cache itself

  const db = smokeDb();
  try {
    const [ownerRow] = await db<{ id: string }[]>`
      select id from users where email = ${payerEmail}`;
    const [orgRow] = await db<{ wallet_id: string }[]>`
      select coalesce(subscription_id::text, id::text) as wallet_id
        from organizations where id = ${auth.org_id}`;
    const payerUserId = ownerRow.id;
    const walletId = orgRow.wallet_id;

    // Fill the group to the Pro cap of 5 — four more organisations on the
    // same subscription, owned by the payer. Both caps must read "at 5": the
    // PERSON cap (assertMayOwnAnotherOrg, which is what a bare create hits) and
    // the GROUP cap (attachOrgToGroup, not exercised here).
    const fillIds: string[] = [];
    for (let i = 0; i < PRO_ORG_CAP - 1; i++) {
      const [seeded] = await db<{ id: string }[]>`
        insert into organizations (name, slug, created_by, subscription_id)
        values (${`Org Addon Fill ${tag} ${i}`}, ${`org-addon-fill-${tag}-${i}`},
                ${payerUserId}, ${walletId})
        returning id`;
      await db`insert into org_members (org_id, user_id, role)
               values (${seeded.id}, ${payerUserId}, 'owner')`;
      fillIds.push(seeded.id);
    }
    const [groupSize] = await db<{ n: number }[]>`
      select count(*)::int as n from organizations where subscription_id = ${walletId}`;
    check(
      `extra-org: fixture built — one Pro bill carrying ${PRO_ORG_CAP} organisations, all owned by its payer`,
      groupSize?.n === PRO_ORG_CAP,
    );
    check(
      "extra-org: the resolved cap starts at the Pro base of 5 — nothing bought yet",
      (await orgCap(payer, auth.org_id)) === PRO_ORG_CAP,
    );

    // --- the refusal, asserted BEFORE anything is bought -----------------
    const blocked = await raw(payer, "/api/orgs", "POST", { name: `Org 6 ${tag}` });
    check(
      "extra-org: organisation #6 is REFUSED at the Pro cap of 5 (402)",
      blocked.status === 402,
    );
    check(
      "extra-org: the payer's 402 carries the purchase offer at the top level (#293)",
      refusal(blocked.json).feature_key === "orgs.max_owned" &&
        refusal(blocked.json).offer === "extra_org",
    );

    // --- NON-PAYER: same group, same cap, no offer -----------------------
    // Co-owning the four seeded organisations puts this user at the same
    // PERSON cap (it counts organisations they own, on anyone's bill) while the
    // only group they could actually buy on is their own auto-provisioned
    // community one. Runs BEFORE the purchase on purpose — a bought rider would
    // lift this cap to 6 and the refusal would stop being reachable.
    const nonPayerEmail = `delivered+orgaddon_nonpayer_${tag}@resend.dev`;
    const nonPayer = newSession();
    await signIn(nonPayer, nonPayerEmail);
    const [npRow] = await db<{ id: string }[]>`
      select id from users where email = ${nonPayerEmail}`;
    for (const id of fillIds) {
      await db`insert into org_members (org_id, user_id, role)
               values (${id}, ${npRow.id}, 'owner')`;
    }
    const npBlocked = await raw(nonPayer, "/api/orgs", "POST", { name: `NP Org ${tag}` });
    check(
      "extra-org/non-payer: an owner inside the same Pro group is refused at the same cap (402)",
      npBlocked.status === 402 && refusal(npBlocked.json).feature_key === "orgs.max_owned",
    );
    check(
      "extra-org/non-payer: ...and is offered NOTHING — only the group's payer may buy the rider (the identical request offered it to the payer above)",
      refusal(npBlocked.json).offer === undefined,
    );
    // WHY the offer is withheld, asserted at the wire rather than argued in a
    // comment. `requireBillingOwner` reads the ACTIVE-ORG cookie, so point it at
    // one of the payer's organisations — the one this user genuinely co-owns —
    // and the route resolves the payer's group and finds someone else's
    // `owner_user_id`. That refusal lands BEFORE `getStripe()`, which is what
    // makes it assertable here with no Stripe key at all.
    nonPayer.cookies["seazn_org"] = fillIds[0]!;
    const npBuy = await raw(nonPayer, "/api/billing/extra-orgs", "POST", { count: 1 });
    check(
      "extra-org/non-payer: the purchase route itself refuses them (403) — the withheld offer is not a dead end, it is the truth",
      npBuy.status === 403,
    );

    // --- FREE path: community sells no rider -----------------------------
    const freeEmail = `delivered+orgaddon_free_${tag}@resend.dev`;
    const free = newSession();
    await signIn(free, freeEmail);
    const freeBlocked = await raw(free, "/api/orgs", "POST", { name: `Free Org ${tag}` });
    check(
      "extra-org/free: a community owner is refused a second organisation (402, orgs.max_owned)",
      freeBlocked.status === 402 && refusal(freeBlocked.json).feature_key === "orgs.max_owned",
    );
    check(
      "extra-org/free: ...and is offered NOTHING — community has no rider SKU, so the remedy is an upgrade rather than a purchase",
      refusal(freeBlocked.json).offer === undefined,
    );
    // Same reasoning as the non-payer arm: the community refusal (409, no live
    // paid subscription to hang an item on) also lands before `getStripe()`, so
    // "the route would refuse them anyway" stops being prose.
    const freeBuy = await raw(free, "/api/billing/extra-orgs", "POST", { count: 1 });
    check(
      "extra-org/free: the purchase route refuses a community group outright (409) — nothing to attach a recurring item to",
      freeBuy.status === 409,
    );

    // --- buy one extra organisation --------------------------------------
    // The webhook is the SINGLE writer of these rows in production; this insert
    // stands in for it exactly as setPlan stands in for a real plan change. The
    // stripe_item_id is tag-unique on purpose: V324's unique index is on
    // stripe_item_id ALONE, so a shared literal would silently move another
    // run's row onto this wallet while every wallet-scoped read still passed.
    await db`
      insert into org_addons (wallet_id, target_org_id, feature_key, delta_each, qty,
                              stripe_item_id, status)
      values (${walletId}, null, 'orgs.max_owned', 1, 1,
              ${`si_smoke_orgaddon_${tag}`}, 'active')`;
    check(
      "extra-org: the purchased rider lifts the resolved cap by exactly one (5 → 6)",
      (await orgCap(payer, auth.org_id)) === PRO_ORG_CAP + 1,
    );

    const created = await raw(payer, "/api/orgs", "POST", { name: `Org 6 ${tag}` });
    check(
      "extra-org: the SAME create that 402'd above now succeeds — organisation #6 exists",
      created.status === 200 && !!(created.json.data as { id?: string } | undefined)?.id,
    );
    const org6Id = (created.json.data as { id?: string } | undefined)?.id;

    // --- the customer's ACTUAL next move: put #6 on the bill they bought for
    // A new organisation is minted on its OWN group, so the story so far ends
    // one step short of what the payer wanted — capacity on THIS bill. The
    // attach is governed by the GROUP cap (assertWithinGroupCap → groupOrgLimit)
    // rather than the PERSON cap the create hit, and that is a second reader of
    // the rider entirely. 5 held + 1 against a cap of 5 + 1 rider is exactly
    // at the line, so this passes only while the rider is being counted.
    const attached6 = await raw(payer, "/api/billing/group/attach", "POST", {
      org_id: org6Id,
      subscription_id: walletId,
    });
    const [groupAfter] = await db<{ n: number }[]>`
      select count(*)::int as n from organizations
       where subscription_id = ${walletId} and deleted_at is null`;
    check(
      "extra-org: organisation #6 ATTACHES to the bill the rider was bought on — the GROUP cap counts it too (6 on one bill)",
      attached6.status === 200 && groupAfter?.n === PRO_ORG_CAP + 1,
    );

    // --- a tier change RE-PRICES the rider; it never resizes it -----------
    // The webhook's convergence (customer.subscription.updated moves the rider
    // item onto the new plan's price) is a RATE change and needs live Stripe —
    // it is the BILLING_LIVE suite's job. The half a customer would actually
    // notice is assertable here with no Stripe at all: after the tier moves,
    // the rider they are still paying for must still be worth exactly +1
    // against the NEW plan's base, never the old one and never nothing.
    // Pro → Community is the downgrade a real customer makes (cancelling Pro
    // drops them to it), and after v18 it is the only tier move left with a
    // finite base on both sides — enterprise resolves this key to unlimited, so
    // "+1 against the new base" is not expressible there.
    await setPlan(auth.org_id, "community", payer);
    check(
      "extra-org: after a Pro → Community tier change the rider still adds exactly one (1 → 2) — a re-price is never a capacity change",
      (await orgCap(payer, auth.org_id)) === COMMUNITY_ORG_CAP + 1,
    );

    // --- CANCELLING the rider gives the capacity back --------------------
    // The direction #293 exists to kill, and the one arm of the loop the rest
    // of this suite does not close: buy, create #11, cancel, keep 11 for ever.
    // Cancellation is a status flip, never a delete and never qty 0 (V323/V324
    // freeze-not-delete, and the CHECK forbids qty 0), so the whole question is
    // whether a 'canceled' row still COUNTS. Widening the counting statuses to
    // include it leaves every other check in this suite green.
    await db`
      update org_addons set status = 'canceled'
       where wallet_id = ${walletId} and stripe_item_id = ${`si_smoke_orgaddon_${tag}`}`;
    check(
      "extra-org: a CANCELED rider stops counting — the cap falls straight back to the plan base (2 → 1)",
      (await orgCap(payer, auth.org_id)) === COMMUNITY_ORG_CAP,
    );
  } finally {
    await db.end();
  }
}
