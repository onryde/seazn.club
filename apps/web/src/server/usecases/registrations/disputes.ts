import "server-only";
// Chargeback handling and the dispute evidence pack (see ./index.ts).
import type Stripe from "stripe";
import { sql, withTenant } from "@/lib/db";
import { disputeAlertEmail, disputeLostEmail } from "@/lib/email";
import { routes } from "@/lib/routes";
import { toLocale } from "@/lib/i18n-constants";
import { enqueueEmailOnce, expiryWithin, onceKey, recipientLocale } from "@/server/email-outbox";
import type { AuthCtx } from "@/server/api-v1/auth";
import { recoverDisputedTransfer as recoverDisputedTransferCore } from "../dispute-recovery";
import { orgOwnerRecipient } from "../org-owner";
import { audit } from "../audit";
import type { RegistrationRow, RegistrationWithGroupRow, DivisionCtx } from "./types";
import { regGroupCols, divisionCtx, fallbackOrigin, orgReg } from "./lookups";
import { buildCartMail } from "./mail";

/**
 * Dispute lifecycle (spec issue #5 — destination charges make the PLATFORM
 * liable): `created` flags the registration + alerts the org owner; `closed`
 * either clears the flag (won, or a closed inquiry: `warning_closed`) or
 * writes the money off (lost). No automatic
 * entrant changes — contested entries are the organiser's call.
 */
export async function handleRegistrationDispute(
  dispute: Stripe.Dispute,
  phase: "created" | "closed",
): Promise<boolean> {
  const intent =
    typeof dispute.payment_intent === "string"
      ? dispute.payment_intent
      : dispute.payment_intent?.id;
  if (!intent) return false;
  // payment_intent_id lives on the cart now (V364).
  const [reg] = await sql<RegistrationWithGroupRow[]>`
    select ${regGroupCols(sql)}
    from registrations r join registration_groups g on g.id = r.group_id
    where g.payment_intent_id = ${intent}
    order by r.created_at, r.id limit 1`;
  if (!reg) return false; // not an entry-fee charge (or intent not written yet)
  const ctx = await divisionCtx(sql, reg.division_id);

  if (phase === "created") {
    // The owner to alert and their language (D4: the account's, then the org default), read before the transaction opens. `null`: the
    // org has no current owner, so the dispute is recorded and nobody is mailed.
    const owner = await orgOwnerRecipient(sql, reg.org_id);
    const recipient = owner && {
      ...owner,
      locale: await recipientLocale(sql, { pick: null, userId: owner.userId, orgDefault: ctx.default_locale }),
    };
    // ONE transaction records the dispute on the cart (disputed_at/dispute_id live on the cart, V364) and queues the owner's alert, so the
    // alert exists exactly when the record does. The alert is written only on the TRANSITION to this dispute (the cart, read under lock,
    // named another dispute or none): a redelivered `created` is not one. The once-key keeps an older dispute's `created`, arriving again
    // after a newer one moved the cart on, from alerting twice. A webhook has no response to defer behind, so the worker makes the first
    // attempt. The audit stays unconditional: it records every delivery.
    await sql.begin(async (tx) => {
      const [prior] = await tx<{ dispute_id: string | null }[]>`
        select dispute_id from registration_groups where id = ${reg.group_id} for update`;
      await tx`update registration_groups
               set disputed_at = now(), dispute_id = ${dispute.id}, updated_at = now()
               where id = ${reg.group_id}`;
      if (prior?.dispute_id !== dispute.id && recipient) {
        const kind = "registration_dispute_alert";
        await enqueueEmailOnce(tx, {
          kind,
          refType: "dispute",
          refId: dispute.id,
          orgId: reg.org_id,
          to: recipient.email,
          recipientUserId: recipient.userId,
          ...(await disputeAlertEmail(
            {
              orgName: ctx.org_name,
              competitionName: ctx.comp_name,
              displayName: reg.display_name,
              amountCents: dispute.amount,
              currency: reg.currency,
              refCode: reg.ref_code,
            },
            recipient.locale,
          )),
          transactional: false,
          expiresAt: expiryWithin(null),
          dedupeKey: onceKey(kind, "dispute", dispute.id, "created"),
        });
      }
      await audit(tx, ctx.competition_id, reg.org_id, "registration.disputed", {
        registration_id: reg.id,
        dispute_id: dispute.id,
        amount_cents: dispute.amount,
      }, null);
    });
    return true;
  }
  // An inquiry (opened as `warning_needs_response`) that the bank drops without a chargeback closes `warning_closed`: no money was
  // ever taken, so it ends the dispute as a win does. Without this arm the registrant stayed "disputed" for good in the hub and in
  // the division's dispute count.
  if (dispute.status === "won" || dispute.status === "warning_closed") {
    await sql`update registration_groups set disputed_at = null, updated_at = now()
              where id = ${reg.group_id}`;
    await audit(sql, ctx.competition_id, reg.org_id, "registration.dispute_won", {
      registration_id: reg.id,
      dispute_id: dispute.id,
    }, null);
  } else if (dispute.status === "lost") {
    // The write-off must land whatever Stripe does next — same contract as
    // refund failure never undoing a withdrawal. refunded_cents/refunded_at
    // live on the cart now (V364). Cart-scoped by design (review fixup —
    // this used to read `reg.amount_cents`, the EARLIEST entry sharing the
    // intent, and flat-overwrite with it: a fourth, unlisted site of hazard
    // 2's class, wrong on two counts — wrong source value once a cart holds
    // more than one entry, AND non-monotonic like the other three sites).
    // `dispute.amount` is the actual disputed amount — already used the same
    // way in the "created" phase's audit above (line ~1386) — and `greatest`
    // matches syncRegistrationRefund's mirror: never regress what an
    // entry-level refund may already have recorded.
    await sql`update registration_groups
              set refunded_cents = greatest(refunded_cents, ${dispute.amount}),
                  refunded_at = coalesce(refunded_at, now()), updated_at = now()
              where id = ${reg.group_id}`;
    await audit(sql, ctx.competition_id, reg.org_id, "registration.dispute_lost", {
      registration_id: reg.id,
      dispute_id: dispute.id,
    }, null);
    const recovery = await recoverDisputedTransfer(dispute, reg, ctx);
    // `already` = a replayed close (metadata guard hit) — everything below
    // already happened on the first run.
    if (!recovery.already) {
      // The owner's notice states the write-off and what the recovery pulled back, both fixed now, in the owner's language (D4). It is
      // queued once per dispute (`<dispute id>:lost`) and the worker makes the first attempt. A refused enqueue fails the webhook (D1).
      const owner = await orgOwnerRecipient(sql, reg.org_id);
      if (owner) {
        const locale = await recipientLocale(sql, { pick: null, userId: owner.userId, orgDefault: ctx.default_locale });
        const kind = "registration_dispute_lost";
        await enqueueEmailOnce(sql, {
          kind,
          refType: "dispute",
          refId: dispute.id,
          orgId: reg.org_id,
          to: owner.email,
          recipientUserId: owner.userId,
          ...(await disputeLostEmail(
            {
              orgName: ctx.org_name,
              competitionName: ctx.comp_name,
              displayName: reg.display_name,
              amountCents: dispute.amount,
              currency: reg.currency,
              refCode: reg.ref_code,
              recoveredCents: recovery.recoveredCents,
              // divisionRegistrations route deleted (RS001 demolition) —
              // point at the competition page for now; RS004's hub re-points
              // this at the new competition-level Registration hub.
              consoleUrl: fallbackOrigin() + routes.competition(ctx.org_slug, ctx.comp_slug),
            },
            locale,
          )),
          transactional: false,
          expiresAt: expiryWithin(null),
          dedupeKey: onceKey(kind, "dispute", dispute.id, "lost"),
        });
      }
    }
  }
  return true;
}

/**
 * PROMPT-55: on a LOST entry-fee dispute, pull the club's net back off its
 * connected balance so the platform's loss is Stripe's dispute fee only.
 *
 * Thin registration-flavoured wrapper over the shared dispute-recovery core
 * (dispute-recovery.ts, payments-hardening Task 5): all the charge→transfer→
 * reversal mechanics + replay guard live in the core; this builds the audit
 * closure that namespaces the ledger event under `registration.` and folds in
 * registration_id/dispute_id/org context, and tags the reversal with
 * registration_id. Behaviour is unchanged from the pre-extraction inline
 * version — see the core's doc comment for the transfer/reversal economics.
 *
 * Never throws: recovery failure is audited and must not block the webhook
 * ACK or the write-off above. Stripe calls stay OUTSIDE any sql tx.
 */
async function recoverDisputedTransfer(
  dispute: Stripe.Dispute,
  reg: RegistrationRow,
  ctx: DivisionCtx,
): Promise<{ recoveredCents: number; already: boolean }> {
  return recoverDisputedTransferCore(dispute, {
    auditNote: (type, extra) =>
      audit(sql, ctx.competition_id, reg.org_id, `registration.${type}`, {
        registration_id: reg.id,
        dispute_id: dispute.id,
        ...extra,
      }, null),
    reversalMetadata: { registration_id: reg.id },
  });
}

// ---------------------------------------------------------------------------
// Dispute evidence pack
// ---------------------------------------------------------------------------

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function evidenceRow(label: string, value: string): string {
  return `<tr><td style="padding:6px 14px 6px 0;color:#6b7280;white-space:nowrap;vertical-align:top">${esc(label)}</td><td style="padding:6px 0;font-weight:600">${esc(value)}</td></tr>`;
}

/**
 * Everything the platform holds that shows a disputed entry was genuine, as
 * one printable HTML document mapped to Stripe's evidence fields: the
 * registration record, the reconstructed confirmation email (receipt +
 * customer communication), the audit trail (activity log) and the entrant's
 * fixtures (service provided). Organisers download it from the flagged row
 * and paste/upload into the dispute response.
 */
export async function buildDisputeEvidence(
  auth: AuthCtx,
  regId: string,
  origin: string,
): Promise<{ ref: string; html: string }> {
  const reg = await withTenant(auth.orgId, (tx) => orgReg(tx, regId));
  const ctx = await divisionCtx(sql, reg.division_id);
  const [division] = await sql<{ name: string }[]>`
    select name from divisions where id = ${reg.division_id}`;

  const events = await sql<{ type: string; payload: unknown; created_at: Date }[]>`
    select type, payload, created_at from competition_events
    where competition_id = ${ctx.competition_id}
      and payload->>'registration_id' = ${regId}
    order by created_at`;

  // P9 cutover: venue is DERIVED from venues.name via fixtures.venue_id —
  // fixtures.venue (frozen since pass 3a) would silently blank the "service
  // provided" venue line on this Stripe dispute evidence document for any
  // fixture played after the cutover.
  // RS009 — a PLACED SOLO SIGN-UP has no entrant of its own (design §6: they
  // are fielded through the TEAM they were assigned to), so keying the
  // "service provided" evidence on `reg.entrant_id` alone returned zero
  // fixtures for someone who actually played — the weakest possible answer
  // in the one document whose job is to prove they did. Resolve through the
  // placement for those rows.
  const evidenceEntrantId =
    reg.entrant_id ??
    (
      await sql<{ entrant_id: string | null }[]>`
        select tgt.entrant_id from registration_players rp
        join registrations tgt on tgt.id = rp.registration_id
        where rp.assigned_from_registration_id = ${regId}`
    )[0]?.entrant_id ??
    null;

  const fixtures = evidenceEntrantId
    ? await sql<
        { round_no: number | null; status: string; outcome: unknown; scheduled_at: Date | null; venue: string | null }[]
      >`
      select f.round_no, f.status, f.outcome, f.scheduled_at, ven.name as venue
      from fixtures f
      left join venues ven on ven.id = f.venue_id
      where f.home_entrant_id = ${evidenceEntrantId} or f.away_entrant_id = ${evidenceEntrantId}
      order by f.round_no nulls last, f.scheduled_at nulls last`
    : [];

  // The transactional receipt, reconstructed with the exact sender inputs.
  // RS005 W4: the sent mail is now CART-shaped (owner ruling 2026-08-25), so
  // this reconstructs the WHOLE cart via the same `buildCartMail` the
  // submit-time send and the resend action use — not just `reg`'s own
  // entry, which would again attest to a message shape that was never
  // actually sent whenever this entry has cart-mates. `paymentInstructions`/
  // `payDeadline` are forced null exactly as before this wave: instructions
  // can change after the original send, and a reconstruction is not the
  // place to guess whether they did (division settings are otherwise no
  // longer among the inputs here — currency is the CART's snapshot,
  // RS001b — which is also the more honest source for dispute evidence,
  // since it is what the registrant was actually charged in rather than
  // what the division is configured for today). A waiting entry's
  // `waitlistPosition` is forced null for the same reason (B3 review m3,
  // owner ruling 2026-11-13): `buildCartMail` reads the place LIVE, and the
  // queue has moved since the mail went out, so quoting today's place would
  // attest to a number that was never sent. The line states the status alone.
  const { registrationTemplate } = await import("@/lib/email-templates");
  const { getDictionary } = await import("@/lib/i18n");
  const cartMail = await buildCartMail(reg.group_id, origin, null);
  // Reconstruct the receipt exactly as sent — in the registrant's captured
  // locale (cycle 47), so replayed dispute evidence matches the original mail.
  const emailDict = await getDictionary(cartMail?.locale ?? toLocale(reg.locale), "emails");
  const emailText = cartMail
    ? registrationTemplate(
        {
          ...cartMail.args,
          paymentInstructions: null,
          payDeadline: null,
          entries: cartMail.args.entries.map((e) => ({ ...e, waitlistPosition: null })),
        },
        emailDict,
      ).text
    // NEVER silently blank. This document is submitted to Stripe as evidence
    // that a real person really registered; an empty receipt section reads as
    // "no receipt was sent", which is a claim about the merchant, not about a
    // missing row. Before RS005 W4 the receipt was rebuilt from `reg` itself
    // and could not come out empty, so this failure mode is new — it needs a
    // marker a human reviewer can act on rather than an absence they will
    // read as an admission.
    : `[Receipt could not be reconstructed: the registration group ${reg.group_id} `
      + `could not be loaded at ${new Date().toISOString()}. The entry itself is `
      + `evidenced by the registration record and activity log below.]`;

  const when = (d: Date | string | null) => (d ? new Date(d).toISOString() : "—");
  const ref = reg.ref_code ?? reg.id;

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Dispute evidence — ${esc(ref)}</title></head>
<body style="margin:0;font-family:system-ui,-apple-system,sans-serif;color:#18181b">
<div style="background:#150b36;color:#f5f0e8;padding:18px 32px 8px">
  <div style="font-size:18px;font-weight:800;letter-spacing:2px">SEAZN <span style="color:#a3e635">CLUB</span></div>
  <div style="text-align:right;color:#ef4444;font-size:14px;line-height:8px">&#9679;</div>
</div>
<div style="height:4px;background:#a3e635"></div>
<div style="max-width:760px;margin:0 auto;padding:28px 32px">
  <h1 style="font-size:22px;margin:0 0 2px">Dispute evidence pack — ${esc(ref)}</h1>
  <p style="margin:0 0 20px;color:#6b7280;font-size:13px">
    Generated ${new Date().toISOString()} · ${esc(ctx.org_name)} · for the Stripe dispute response${reg.dispute_id ? ` (${esc(reg.dispute_id)})` : ""}.
  </p>

  <h2 style="font-size:15px;margin:20px 0 6px">Registration (product/service + customer)</h2>
  <table style="font-size:14px;border-collapse:collapse">
    ${evidenceRow("Reference", ref)}
    ${evidenceRow("Entrant", reg.display_name)}
    ${evidenceRow("Customer email", reg.contact_email)}
    ${evidenceRow("Competition", `${ctx.comp_name} — ${division?.name ?? ""}`)}
    ${evidenceRow("Service dates", `${ctx.starts_on ?? "—"} – ${ctx.ends_on ?? "—"}`)}
    ${evidenceRow("Amount", `${((reg.amount_cents ?? 0) / 100).toFixed(2)} ${reg.currency.toUpperCase()}`)}
    ${evidenceRow("Payment intent", reg.payment_intent_id ?? "—")}
    ${evidenceRow("Registered at", when(reg.created_at))}
    ${evidenceRow("Status", reg.status)}
    ${evidenceRow("Disputed at", when(reg.disputed_at))}
    ${evidenceRow("Status page", reg.ref_code ? `${origin}/r/${reg.ref_code}` : "—")}
  </table>

  <h2 style="font-size:15px;margin:24px 0 6px">Confirmation email (receipt / customer communication)</h2>
  <p style="margin:0 0 6px;color:#6b7280;font-size:12px">Reconstruction of the transactional email sent to ${esc(reg.contact_email)} at registration.</p>
  <pre style="background:#f6f5f8;border-radius:8px;padding:14px;font-size:12px;white-space:pre-wrap">${esc(emailText)}</pre>

  <h2 style="font-size:15px;margin:24px 0 6px">Activity log (${events.length})</h2>
  <table style="font-size:13px;border-collapse:collapse">
    ${events
      .map((e) =>
        evidenceRow(new Date(e.created_at).toISOString(), `${e.type} ${JSON.stringify(e.payload)}`),
      )
      .join("")}
  </table>

  <h2 style="font-size:15px;margin:24px 0 6px">Fixtures for this entrant (service provided) — ${fixtures.length}</h2>
  ${
    fixtures.length === 0
      ? `<p style="color:#6b7280;font-size:13px;margin:0">No fixtures yet (or the entry has no entrant).</p>`
      : `<table style="font-size:13px;border-collapse:collapse">${fixtures
          .map((f) =>
            evidenceRow(
              `Round ${f.round_no ?? "—"} · ${f.scheduled_at ? new Date(f.scheduled_at).toISOString() : "unscheduled"}`,
              `${f.status}${f.venue ? ` · ${f.venue}` : ""}${f.outcome ? ` · ${JSON.stringify(f.outcome)}` : ""}`,
            ),
          )
          .join("")}</table>`
  }

  <h2 style="font-size:15px;margin:24px 0 6px">How to use</h2>
  <ol style="font-size:13px;color:#374151;padding-left:18px;margin:0">
    <li>Open the dispute in your Stripe Dashboard (platform account).</li>
    <li>Product/service: paste the Registration section; service date = the competition dates.</li>
    <li>Customer communication / receipt: paste the confirmation email reconstruction.</li>
    <li>Activity log + fixtures: upload this document as supporting evidence.</li>
  </ol>
</div>
</body></html>`;

  await withTenant(auth.orgId, (tx) =>
    audit(tx, ctx.competition_id, auth.orgId, "registration.evidence_exported", { registration_id: regId }, auth.userId),
  );
  return { ref, html };
}
