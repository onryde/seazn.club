import "server-only";
// Stripe event processing: charge.refunded — pass revoke, AI pack and match-credit claw-back (see ./index.ts).
import type Stripe from "stripe";
import { sql, type Tx } from "@/lib/db";
import { log } from "@/server/logger";
import { revokePassForRefundedCharge } from "@/lib/billing";
import { recordPackRefund } from "@/lib/credits";
// MATCH credits — a different currency from @/lib/credits above, on its own
// table and its own writer. Kept adjacent deliberately so the next reader sees
// that the two are distinct rather than duplicated. The PURCHASE grant lives in
// stream-credits-checkout.ts, shared with reconcile-on-return (Task 14 G1).
import { findStreamPurchase, recordStreamPackRefund } from "@/server/usecases/stream-credits";
import { isPassKey, type PassKey } from "@/lib/currency";
import { reversePassCreditOnRefund } from "@/server/usecases/pass-credit";
import { getStripe } from "@/lib/stripe";
import { passRevokedEmail } from "@/lib/email";
import type { PassRevokedArgs } from "@/lib/email-templates";
import { enqueueEmailOnce, expiryWithin, onceKey, recipientLocale } from "@/server/email-outbox";
import { orgOwnerRecipient } from "@/server/usecases/org-owner";
import type { Locale } from "@/lib/i18n-constants";
import { STREAM_CLAWBACK_REASON, alertCreditPackGrantFailed, alertStreamClawback } from "./staff-alerts";

/** The org owner's notice that an Event Pass was refunded and revoked (kind
 *  `pass_revoked`, ref `charge/<charge id>`), queued on `tx`: the transaction
 *  that deletes the pass (R1). The charge id is the once-key, so a charge is
 *  told about once however many times its refund is delivered; `onceKey`
 *  refuses a charge with no id by name, which takes the revoke down with it.
 *  Addressed to the owner's account (resolved at send), in `locale`; the worker
 *  makes the first attempt. Returns the row's id, or null when the key was
 *  taken. */
export async function queuePassRevokedEmail(
  tx: Tx,
  a: {
    chargeId: string | undefined;
    orgId: string;
    owner: { userId: string; email: string };
    locale: Locale;
    args: PassRevokedArgs;
  },
): Promise<string | null> {
  const kind = "pass_revoked";
  // The key is the charge id itself (no suffix), so it is also the ref.
  const dedupeKey = onceKey(kind, "charge", a.chargeId);
  return enqueueEmailOnce(tx, {
    kind,
    refType: "charge",
    refId: dedupeKey,
    orgId: a.orgId,
    to: a.owner.email,
    recipientUserId: a.owner.userId,
    ...(await passRevokedEmail(a.args, a.locale)),
    transactional: false,
    expiresAt: expiryWithin(null),
    dedupeKey,
  });
}

/** Event Pass refund (P0-3a): a fully-refunded pass charge — dashboard refunds
 *  included — revokes the pass and tells the org owner. The org, competition,
 *  RUNG and the org's default language are read BEFORE the revoke deletes the
 *  row, and so are the owner (the oldest current owner, `orgOwnerRecipient`,
 *  owner ruling Q2) and their language (D4: the account's, then the org
 *  default). The notice is queued on the outbox in the revoke's own
 *  transaction (`inRevoke`), only when a pass row was deleted: a redelivered
 *  refund finds no pass and asks for nothing, and the charge-id once-key holds
 *  the rest. An org with no current owner still loses the pass; nobody is told.
 *
 *  The read is no longer gated on `charge.refunded` (v17 #294). A PARTIAL refund
 *  leaves the pass row alone but still runs `reversePassCreditOnRefund` below,
 *  and that path's staff alert has to name the rung too — which is only knowable
 *  here, from the row, before it can be deleted. One extra indexed lookup by
 *  payment intent on partial refunds; the owner's notice is still gated on the
 *  delete, so nothing customer-visible changes. */
export async function revokePassForRefundedChargeAndNotify(charge: Stripe.Charge): Promise<void> {
  const intent =
    typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
  const [ctx] = intent
    ? await sql<{ org_id: string; org_name: string; comp_name: string; pass_key: string; default_locale: string }[]>`
        select p.org_id, o.name as org_name, c.name as comp_name, p.pass_key, o.default_locale
        from competition_passes p
        join organizations o on o.id = p.org_id
        join competitions   c on c.id = p.competition_id
        where p.stripe_payment_intent = ${intent}`
    : [];
  // isPassKey, not a cast: the column is `not null default 'event_pass'`, so a
  // row written before #294 is genuinely M, and a rung this build predates must
  // still produce a real label rather than a missing dictionary key.
  const passKey: PassKey | null = ctx
    ? isPassKey(ctx.pass_key)
      ? ctx.pass_key
      : "event_pass"
    : null;
  const owner = ctx ? await orgOwnerRecipient(sql, ctx.org_id) : null;
  const notice =
    ctx && passKey && owner
      ? {
          chargeId: charge.id,
          orgId: ctx.org_id,
          owner,
          locale: await recipientLocale(sql, { pick: null, userId: owner.userId, orgDefault: ctx.default_locale }),
          args: { orgName: ctx.org_name, competitionName: ctx.comp_name, passKey },
        }
      : null;
  await revokePassForRefundedCharge(
    charge,
    notice
      ? {
          inRevoke: async (tx) => {
            await queuePassRevokedEmail(tx, notice);
          },
        }
      : {},
  );
  // Unconditional — not gated on the revoke: a partial refund leaves the pass
  // row in place (revokePassForRefundedCharge only deletes on a full refund),
  // but the credit reversal question is about the CHARGE's refund state, not
  // the pass row's survival. `intent` is only undefined for a charge with no
  // payment_intent, which could never have a redemption row to reverse.
  if (intent) await reversePassCreditOnRefund(intent, passKey);
}

/** AI credit-pack refund (v17 SPEC-2 §5, Phase 3 Task 4): a refunded pack
 *  charge claws back only the customer's UNSPENT pack credits (`recordPackRefund`
 *  — under the wallet advisory lock, capped at the purchase, never below zero,
 *  never touching the resetting `grant` bucket, idempotent on replay).
 *
 *  A pack charge is identified by matching the charge's `payment_intent`
 *  against the stored `pack_purchase` ledger row — NOT off `charge.metadata`.
 *  Stripe does NOT copy `payment_intent_data.metadata` onto the Charge object
 *  (Charge metadata and PaymentIntent metadata are distinct fields), so
 *  `charge.metadata` is `{}` for these Checkout-created pack charges; reading it
 *  as the gate would return early on EVERY real pack refund. Instead this
 *  mirrors the sibling refund handlers (`revokePassForRefundedCharge`,
 *  registration/sponsor): match `charge.payment_intent` to a DB row.
 *  `recordPackRefund` does exactly that — a `matched === true` result proves a
 *  `pack_purchase` row exists for this PI, i.e. it WAS a pack, with no metadata
 *  and no Stripe round-trip on the common path.
 *
 *  When `recordPackRefund` returns `matched === false` the charge is EITHER a
 *  non-pack charge (registration/sponsor/pass — the common case, silent no-op)
 *  OR a pack that was paid but never granted then refunded (the T1
 *  paid-but-ungranted class — must alert). These can only be told apart off the
 *  PaymentIntent's metadata (which Part A DOES stamp), so we distinguish with a
 *  guarded PaymentIntent retrieve — only when `STRIPE_SECRET_KEY` is set, done
 *  OUTSIDE any tx (mirroring the dispute path's charge retrieve): if
 *  `pi.metadata.kind === 'credit_pack'` it was an ungranted pack → log + a
 *  best-effort staff alert; otherwise a genuine non-pack charge → silent. */
export async function handlePackChargeRefunded(charge: Stripe.Charge): Promise<void> {
  if (!charge.refunded) return;
  const intent =
    typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
  if (!intent) return; // no intent to match a pack_purchase row against

  const { matched } = await recordPackRefund(intent);
  if (matched) return; // it was a pack and recordPackRefund already clawed back.

  // matched === false: `recordPackRefund`'s cheap indexed `pack_purchase`
  // lookup found no row (no wallet lock taken). Distinguish an ungranted pack
  // from a genuine non-pack charge off the PaymentIntent metadata — a guarded
  // retrieve, keyless envs skip it (a plain non-pack refund no-ops silently).
  if (!process.env.STRIPE_SECRET_KEY) return;
  let pi: Stripe.PaymentIntent;
  try {
    pi = await getStripe().paymentIntents.retrieve(intent);
  } catch {
    return; // a retrieve failure must never block the webhook ACK
  }
  if (pi.metadata?.kind !== "credit_pack") return; // a genuine non-pack charge.

  log.error(
    { chargeId: charge.id, intent },
    "billing: credit_pack charge refunded but no pack_purchase ledger row found — nothing to claw back (was it ever granted?)",
  );
  await alertCreditPackGrantFailed("charge", {
    sessionId: charge.id,
    orgId: pi.metadata?.org_id ?? "unknown",
    packKey: pi.metadata?.pack_key,
    reason: "refunded pack charge has no pack_purchase ledger row to claw back",
  });
}

/** MATCH-credit refund claw-back (streaming R1 lane-B tail, OWNER RULING
 *  2026-09-28 — the ruling block in the programme `_STATE.md`).
 *
 *  Runs LAST on `charge.refunded`, after the AI credit-pack handler, and no-ops
 *  on every charge that is not a match-credit pack — this arm fires on EVERY
 *  refunded charge in the system.
 *
 *  Three outcomes, all of them the ruling's:
 *   * FULL refund (`charge.refunded === true`, Stripe's own flag) → claw back
 *     `min(purchased, balance)`. A claw-back SHORT of the pack means they
 *     streamed before asking for the money back — the refund-abuse signature —
 *     so it is written AND alerted; a clean full reversal is silent because
 *     nothing was spent and no human is owed a look.
 *   * PARTIAL refund (`refunded === false` with `amount_refunded > 0`) → claw
 *     back NOTHING and alert. The fair proportion is a judgement call, and the
 *     AI pack path gates on the same flag for the same reason.
 *   * A refunded charge with no purchase row → log + alert, write nothing.
 *
 *  The gate is the PAYMENT INTENT (`findStreamPurchase`), never
 *  `charge.metadata` — Stripe does not copy `payment_intent_data.metadata` onto
 *  the Charge, so it is `{}` here. `recordPurchase` stores the intent, so the
 *  matched paths need no Stripe round trip; only the ungranted branch does one,
 *  guarded on STRIPE_SECRET_KEY and outside any tx, exactly as the AI pack
 *  handler's does. */
export async function handleStreamPackChargeRefunded(charge: Stripe.Charge): Promise<void> {
  const intent =
    typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
  if (!intent) return; // no intent to match a purchase row against

  // PARTIAL: money moved back but Stripe's full-refund flag is still false.
  // Written as its own limb ahead of the claw-back so the full-vs-partial gate
  // is one comparison that can be mutated on its own.
  if (!charge.refunded) {
    if (charge.amount_refunded <= 0) return; // not a refund at all — a bare charge update.
    const match = await findStreamPurchase(sql, intent);
    if (!match) return; // someone else's charge; silent.
    log.warn(
      { chargeId: charge.id, intent, orgId: match.orgId, purchased: match.purchased },
      "billing: match-credit charge partially refunded — no automatic claw-back, staff alerted",
    );
    await alertStreamClawback({
      shape: "partial",
      refType: "charge",
      refId: charge.id,
      amountRefunded: charge.amount_refunded,
      orgId: match.orgId,
      purchased: match.purchased,
      clawedBack: 0,
      reason: STREAM_CLAWBACK_REASON.partial,
    });
    return;
  }

  const res = await recordStreamPackRefund({ paymentIntentId: intent, via: "refund", reference: charge.id });
  if (res.matched) {
    log.info(
      { chargeId: charge.id, intent, orgId: res.orgId, purchased: res.purchased, clawedBack: res.clawedBack, applied: res.applied },
      "billing: match-credit pack refunded",
    );
    // `clawedBack < purchased`, not `!applied`: a replay reports the EARLIER
    // claw-back's size, so the verdict is the same on every delivery, and a
    // fully-spent pack (which writes no row at all, V410's `delta <> 0`) still
    // alerts — that is precisely the case a human most needs to see.
    if (res.clawedBack < res.purchased) {
      await alertStreamClawback({
        shape: "short",
        refType: "charge",
        refId: charge.id,
        orgId: res.orgId ?? "unknown",
        purchased: res.purchased,
        clawedBack: res.clawedBack,
        reason: STREAM_CLAWBACK_REASON.short,
      });
    }
    return;
  }

  // matched === false: either a genuine non-stream charge (the common case) or
  // a match-credit pack that was paid and never granted, then refunded. Only
  // the PaymentIntent's metadata can tell them apart — `lib/relay-checkout.ts`
  // stamps `payment_intent_data.metadata.kind = "stream_credits"` — so a
  // guarded retrieve, keyless envs skip it and a plain refund no-ops silently.
  if (!process.env.STRIPE_SECRET_KEY) return;
  let pi: Stripe.PaymentIntent;
  try {
    pi = await getStripe().paymentIntents.retrieve(intent);
  } catch {
    return; // a retrieve failure must never block the webhook ACK
  }
  if (pi.metadata?.kind !== "stream_credits") return; // a genuine non-stream charge.

  log.error(
    { chargeId: charge.id, intent },
    "billing: stream_credits charge refunded but no purchase ledger row found — nothing to claw back (was it ever granted?)",
  );
  await alertStreamClawback({
    shape: "ungranted",
    refType: "charge",
    refId: charge.id,
    orgId: pi.metadata?.org_id ?? "unknown",
    reason: STREAM_CLAWBACK_REASON.ungranted,
  });
}
