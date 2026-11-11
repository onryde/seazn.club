// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { createHash, randomBytes } from "node:crypto";
import {
  BASE,
  type Session,
  call,
  check,
  cookieHeader,
  html,
  newSession,
  postSignedStripeWebhook,
  raw,
  signIn,
  smokeDb,
  tag,
  v1,
  v1data,
} from "../harness.ts";

type Deal = { id: string; deal_status: string; payment_status: string; sponsor_id: string };

/**
 * Sponsor deals (plan 2026-11-07-sponsor-deals, Task 6): offline, complimentary and approval deals over the real API and the
 * real public page, on a FRESH community owner — the plan that must be able to record a sponsorship it was paid in cash
 * (anti-goal 4) — plus the console-only door: a viewer of the Pro org cannot mark a deal paid.
 *
 * F33: every deal row here creates its OWN sponsor. A deal attached to the sponsors suite's gold sponsor would hide it (D8),
 * and the Pro org is shared with later suites.
 */
export async function sponsorDealsSuite(admin: Session, proOrgId: string, viewer: Session): Promise<void> {
  const free = newSession();
  const ver = await signIn(free, `delivered+sponsor_deals_${tag}@resend.dev`);
  const orgs = (await call(free, "/api/orgs")) as { id: string; slug: string }[];
  const org = orgs.find((o) => o.id === ver.org_id)!;
  const comp = v1data<{ id: string; slug: string }>(
    await v1(free, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `Deals Cup ${tag}`, visibility: "public" }),
  );
  const pkg = v1data<{ id: string }>(
    await v1(free, `/api/v1/orgs/${org.id}/sponsor-packages`, "POST", { name: "Partner board", price_cents: 25_000, currency: "gbp", tier: "partner" }),
  );
  const addSponsor = async (name: string): Promise<string> =>
    v1data<{ id: string }>(await v1(free, `/api/v1/orgs/${org.id}/sponsors`, "POST", { name, url: "https://deals.example/" })).id;
  const createDeal = (sponsorId: string, over: Record<string, unknown>) =>
    v1(free, `/api/v1/orgs/${org.id}/sponsors/${sponsorId}/deals`, "POST", {
      package_id: pkg.id, competition_id: null, payment_method: "offline", go_live: "on_payment", ...over,
    });
  const publicPage = async () => (await html(newSession(), `/live/${org.slug}/${comp.slug}`)).body;
  const sponsorCount = async () => v1data<unknown[]>(await v1(free, `/api/v1/orgs/${org.id}/sponsors`)).length;

  // --- When paid: hidden until marked paid, then the SAME sponsor row is on the public page.
  const paidName = `Deal Paid ${tag}`;
  const paidSponsor = await addSponsor(paidName);
  const made = await createDeal(paidSponsor, {});
  const madeData = made.status === 201 ? v1data<{ deal: Deal; invoice_url: string | null }>(made) : null;
  const hiddenPage = await publicPage();
  check(
    "sd offline deal created hidden (201)",
    made.status === 201 && madeData?.invoice_url === null && madeData.deal.deal_status === "awaiting_payment" && !hiddenPage.includes(paidName),
  );
  const before = await sponsorCount();
  const paid = madeData ? await v1(free, `/api/v1/orgs/${org.id}/sponsor-deals/${madeData.deal.id}/mark-paid`, "POST") : null;
  const shownPage = await publicPage();
  check(
    "sd mark-paid puts the SAME sponsor on the public page",
    paid?.status === 200 && v1data<Deal>(paid).deal_status === "live" && shownPage.includes(paidName) &&
      shownPage.includes(`/s/${paidSponsor}`) && (await sponsorCount()) === before,
  );

  // --- After I approve: marked paid is not enough (anti-goal 2).
  const approveName = `Deal Approve ${tag}`;
  const approveSponsor = await addSponsor(approveName);
  const pending = await createDeal(approveSponsor, { go_live: "on_approval" });
  const pendingId = pending.status === 201 ? v1data<{ deal: Deal }>(pending).deal.id : "";
  const marked = pendingId ? await v1(free, `/api/v1/orgs/${org.id}/sponsor-deals/${pendingId}/mark-paid`, "POST") : null;
  const stillHidden = !(await publicPage()).includes(approveName);
  const approved = pendingId ? await v1(free, `/api/v1/orgs/${org.id}/sponsor-deals/${pendingId}/approve`, "POST") : null;
  check(
    "sd approve required: still hidden after mark-paid",
    marked?.status === 200 && v1data<Deal>(marked).deal_status === "awaiting_approval" && stillHidden &&
      approved?.status === 200 && (await publicPage()).includes(approveName),
  );

  // --- Task 8 (anti-goal 1): a signed payment_intent.succeeded moves its deal and puts the deal's OWN sponsor live — the webhook
  // never inserts a sponsor. Community cannot sell online, so the online deal is SQL-seeded the way Send invoice leaves one
  // (awaiting payment, its sponsor hidden), on its own sponsor (F33). Signing needs the server's STRIPE_WEBHOOK_SECRET.
  if (!process.env.STRIPE_WEBHOOK_SECRET || !process.env.DATABASE_URL) {
    check(
      "sd paid webhook: skipped (no STRIPE_WEBHOOK_SECRET or DATABASE_URL — cannot sign a webhook or seed the deal); deals-webhook-seam.test.ts covers it",
      true,
    );
  } else {
    const webhookSponsor = await addSponsor(`Deal Webhook ${tag}`);
    const db = smokeDb();
    let dealId = "";
    try {
      const [row] = await db<{ id: string }[]>`
        insert into sponsor_orders (org_id, package_id, sponsor_id, sponsor_name, sponsor_email, amount_cents, currency, status,
                                    deal_status, payment_method, go_live, tier, includes_on_stream, package_name, competition_id)
        values (${org.id}, ${pkg.id}, ${webhookSponsor}, ${`Deal Webhook ${tag}`}, ${`delivered+deal_webhook_${tag}@resend.dev`},
                25000, 'gbp', 'pending', 'awaiting_payment', 'online', 'on_payment', 'partner', false, 'Partner board', ${null})
        returning id`;
      await db`update sponsors set status = 'inactive' where id = ${webhookSponsor}`;
      dealId = row?.id ?? "";
    } finally {
      await db.end();
    }
    const countBefore = await sponsorCount();
    const status = await postSignedStripeWebhook("payment_intent.succeeded", {
      id: `pi_smoke_${tag}_sd_webhook`,
      object: "payment_intent",
      amount: 25_000,
      amount_received: 25_000,
      currency: "gbp",
      status: "succeeded",
      metadata: { kind: "sponsor", order_id: dealId, org_id: org.id },
    });
    const deal = await v1(free, `/api/v1/orgs/${org.id}/sponsor-deals/${dealId}`);
    const after = v1data<{ id: string; status: string }[]>(await v1(free, `/api/v1/orgs/${org.id}/sponsors`));
    check(
      "sd paid webhook never adds a sponsor row",
      status === 200 && deal.status === 200 && v1data<Deal>(deal).deal_status === "live" &&
        v1data<Deal>(deal).payment_status === "paid" && after.length === countBefore &&
        after.find((x) => x.id === webhookSponsor)?.status === "active",
    );
  }

  // --- Online selling is `sponsors.monetize`: refused on community before any row.
  const onlineSponsor = await addSponsor(`Deal Online ${tag}`);
  const online = await createDeal(onlineSponsor, { payment_method: "online", sponsor_email: `delivered+deal_online_${tag}@resend.dev` });
  const onlineDeals = v1data<Deal[]>(await v1(free, `/api/v1/orgs/${org.id}/sponsor-deals?sponsor_id=${onlineSponsor}`));
  check(
    "sd community online deal refused (402)",
    online.status === 402 && (online.json.error as { feature_key?: string } | undefined)?.feature_key === "sponsors.monetize" &&
      Array.isArray(onlineDeals) && onlineDeals.length === 0,
  );

  // --- D21: every deal write is an editor's. The viewer (a member of the Pro org) reads, and cannot mark paid.
  const viewerSponsor = v1data<{ id: string }>(
    await v1(admin, `/api/v1/orgs/${proOrgId}/sponsors`, "POST", { name: `Deal Viewer ${tag}` }),
  ).id;
  const proPkg = v1data<{ id: string }>(
    await v1(admin, `/api/v1/orgs/${proOrgId}/sponsor-packages`, "POST", { name: `Deal Viewer Package ${tag}`, price_cents: 1_000, currency: "gbp", tier: "partner" }),
  );
  const viewerDeal = await v1(admin, `/api/v1/orgs/${proOrgId}/sponsors/${viewerSponsor}/deals`, "POST", {
    package_id: proPkg.id, competition_id: null, payment_method: "offline", go_live: "on_payment",
  });
  const viewerDealId = viewerDeal.status === 201 ? v1data<{ deal: Deal }>(viewerDeal).deal.id : "";
  const refused = viewerDealId ? await v1(viewer, `/api/v1/orgs/${proOrgId}/sponsor-deals/${viewerDealId}/mark-paid`, "POST") : null;
  const read = viewerDealId ? await v1(viewer, `/api/v1/orgs/${proOrgId}/sponsor-deals/${viewerDealId}`) : null;
  check(
    "sd viewer cannot mark paid (403)",
    refused?.status === 403 && read?.status === 200 && v1data<Deal>(read).payment_status === "pending",
  );

  // --- PR 2 Task 13, completed by Task 15: the hub's ?sponsor= is trusted for nothing. A REAL sponsor id of another org (the Pro org's,
  // made above) on this org's hub answers 200 with the Sponsors tab's list - this org's sponsor in it, the foreign one's name nowhere,
  // and NO sponsor page. Until Task 15 nothing read `hub.sponsorId`, so a page that ACCEPTED the foreign id would have passed too
  // (review M1); the OWN-id row below is the positive pair that makes this absence mean something - the same page DOES draw
  // `data-testid="sponsor-sheet"` for an id that is the org's own.
  const foreignHub = await html(free, `/o/${org.slug}/sponsors?tab=sponsors&sponsor=${viewerSponsor}`);
  check(
    "sd hub ?sponsor=<foreign> answers the list and leaks no foreign name",
    foreignHub.status === 200 &&
      foreignHub.body.includes('data-testid="sponsors-tab-sponsors"') &&
      foreignHub.body.includes(paidName) &&
      !foreignHub.body.includes(`Deal Viewer ${tag}`) &&
      !foreignHub.body.includes('data-testid="sponsor-sheet"'),
  );

  // --- PR 2 Task 14: the Sponsors tab's list, rendered by the real server for a Pro owner. The row of the sponsor whose offline deal
  // waits for its money (made above for the viewer check) carries that deal's chip and exactly ONE action - Mark as paid - and the
  // ADD form above the list asks no tier or scope any more (a deal sets them; the hint says so). A Pro org is the meaningful place for
  // the second half: a community org never had a tier select to remove. The edit form has none either now (owner, 2026-11-11), and is not open here.
  const proOrgs = (await call(admin, "/api/orgs")) as { id: string; slug: string }[];
  const proSlug = proOrgs.find((o) => o.id === proOrgId)?.slug;
  const proHub = proSlug ? await html(admin, `/o/${proSlug}/sponsors?tab=sponsors`) : null;
  const rowStart = proHub ? proHub.body.indexOf(`data-sponsor-id="${viewerSponsor}"`) : -1;
  const row = proHub && rowStart >= 0 ? proHub.body.slice(rowStart, proHub.body.indexOf("</li>", rowStart)) : "";
  const hintAt = proHub ? proHub.body.indexOf("Add a deal afterwards to set their tier and where they show.") : -1;
  const listAt = proHub ? proHub.body.indexOf('data-testid="sponsor-group"') : -1;
  const addForm = proHub && hintAt >= 0 && listAt > hintAt ? proHub.body.slice(hintAt, listAt) : "";
  check(
    "sd hub Sponsors tab: a row shows its deal's chip and one next action; the add form asks no tier",
    proHub?.status === 200 &&
      viewerDealId !== "" &&
      row.includes('data-testid="deal-chip"') &&
      row.includes("Awaiting payment") &&
      (row.match(/data-testid="sponsor-row-action"/g) ?? []).length === 1 &&
      row.includes('data-action="mark_paid"') &&
      addForm.length > 0 &&
      !addForm.includes("<select"),
  );

  // --- PR 2 Task 15: a sponsor's own page. The Pro org's hub with its OWN sponsor's id renders the page body (the server sends it
  // whatever the viewport - below md it is the page, from md the browser swaps it for a side panel), for THAT sponsor, with its Deals
  // section carrying the offline deal made above (the chip is the awaiting-payment one) and its Mark as paid; the list is still
  // there behind it (hidden below md only by a class).
  const ownHub = proSlug ? await html(admin, `/o/${proSlug}/sponsors?tab=sponsors&sponsor=${viewerSponsor}`) : null;
  const sheetAt = ownHub ? ownHub.body.indexOf('data-testid="sponsor-sheet"') : -1;
  const sheet = ownHub && sheetAt >= 0 ? ownHub.body.slice(sheetAt) : "";
  check(
    "sd hub ?sponsor=<id> renders the sponsor page (200, sponsor-sheet)",
    ownHub?.status === 200 &&
      viewerDealId !== "" &&
      sheetAt >= 0 &&
      sheet.includes(`data-sponsor-id="${viewerSponsor}"`) &&
      sheet.includes(`Deal Viewer ${tag}`) &&
      sheet.includes('data-testid="sponsor-sheet-deals"') &&
      sheet.includes(`data-deal-id="${viewerDealId}"`) &&
      sheet.includes("Awaiting payment") &&
      sheet.includes('data-action="mark_paid"') &&
      // Owner, 2026-11-11: the tier and scope are read-only here and a deal sets them - the sponsor (no live deal) says so.
      sheet.includes('data-testid="sponsor-sheet-detail-tier"') &&
      sheet.includes('data-testid="sponsor-sheet-placement-note"') &&
      ownHub.body.includes('data-testid="sponsors-list-view"'),
  );

  // --- PR 3 Task 21: Settings -> Payments carries the "Sponsor invoices" card on EVERY plan. The community owner above saves both
  // fields the way the card does (two single-key PATCHes, F30), and the real server's page answers 200 with the card OPEN AT those
  // values (the page's own read of the two V501 columns); the Pro org's page carries the card too, with nothing stored yet.
  const invoiceAddress = `Smoke Club ${tag}, 12 Mill Lane`;
  const invoiceBank = `Sort 12-34-56 Acc 12345678 ${tag}`;
  const savedAddress = await raw(free, `/api/orgs/${org.id}`, "PATCH", { sponsor_invoice_address: invoiceAddress });
  const savedBank = await raw(free, `/api/orgs/${org.id}`, "PATCH", { sponsor_invoice_bank_details: invoiceBank });
  const communityPayments = await html(free, `/o/${org.slug}/settings/connect`);
  const proPayments = proSlug ? await html(admin, `/o/${proSlug}/settings/connect`) : null;
  const areaBody = (page: string, testId: string) =>
    page.match(new RegExp(`<textarea[^>]*data-testid="${testId}"[^>]*>([\\s\\S]*?)</textarea>`))?.[1] ?? null;
  check(
    "sd settings Payments renders the Sponsor invoices card",
    savedAddress.status === 200 && savedBank.status === 200 &&
      communityPayments.status === 200 &&
      communityPayments.body.includes('data-testid="sponsor-invoices-card"') &&
      communityPayments.body.includes("Sponsor invoices") &&
      areaBody(communityPayments.body, "sponsor-invoice-address") === invoiceAddress &&
      areaBody(communityPayments.body, "sponsor-invoice-bank-details") === invoiceBank &&
      proPayments?.status === 200 &&
      proPayments.body.includes('data-testid="sponsor-invoices-card"') &&
      areaBody(proPayments.body, "sponsor-invoice-address") !== null,
  );

  // --- PR 3 Task 22: the numbered invoice. Its page answers one opaque 404 for a token that opens nothing.
  const unknownInvoice = await html(newSession(), `/r/sponsor/invoice/${randomBytes(32).toString("base64url")}`);
  check(
    "sd invoice page 404 for an unknown token",
    unknownInvoice.status === 404 && unknownInvoice.body.includes('data-testid="sponsor-invoice-not-found"') &&
      !unknownInvoice.body.includes('data-testid="sponsor-invoice"'),
  );

  // The console's copy, for a numbered offline deal on its OWN sponsor (F33) of the Pro org: "read" auth, so the viewer gets it.
  const invoiceSponsor = v1data<{ id: string }>(
    await v1(admin, `/api/v1/orgs/${proOrgId}/sponsors`, "POST", { name: `Deal Invoice ${tag}` }),
  ).id;
  const invoiceDeal = await v1(admin, `/api/v1/orgs/${proOrgId}/sponsors/${invoiceSponsor}/deals`, "POST", {
    package_id: proPkg.id, competition_id: null, payment_method: "offline", go_live: "on_payment",
  });
  const invoiceDealId = invoiceDeal.status === 201 ? v1data<{ deal: Deal }>(invoiceDeal).deal.id : "";
  const consolePdf = invoiceDealId
    ? await fetch(`${BASE}/api/v1/orgs/${proOrgId}/sponsor-deals/${invoiceDealId}/invoice.pdf`, { headers: { cookie: cookieHeader(viewer) } })
    : null;
  const pdfBytes = consolePdf ? Buffer.from(await consolePdf.arrayBuffer()) : Buffer.alloc(0);
  check(
    "sd console invoice.pdf is application/pdf (read auth)",
    consolePdf?.status === 200 &&
      consolePdf.headers.get("content-type") === "application/pdf" &&
      /^attachment; filename="SP-\d{4,}\.pdf"$/.test(consolePdf.headers.get("content-disposition") ?? "") &&
      pdfBytes.subarray(0, 5).toString("latin1") === "%PDF-",
  );

  // Pay on a settled OFFLINE invoice sends the sponsor back to the invoice (303), which reads Paid with no pay form. An offline
  // invoice is refused whether or not it is paid, so this row does NOT witness "pay refuses because it is paid" - that killer is
  // routes.test.ts (an ONLINE deal paid by the webhook). The raw token leaves the app only in the invoice email (Task 23), so
  // this row plants a KNOWN token's hash on the deal it just marked paid (the same sha256 as server/sponsors/report-token.ts
  // hashReportToken); the smoke row that opens a REAL emailed token is Task 23's (F9).
  if (!process.env.DATABASE_URL) {
    check("sd pay on a settled offline invoice: skipped (no DATABASE_URL to plant a known token) - routes.test.ts covers it", true);
  } else {
    const markedPaid = invoiceDealId ? await v1(admin, `/api/v1/orgs/${proOrgId}/sponsor-deals/${invoiceDealId}/mark-paid`, "POST") : null;
    const knownToken = randomBytes(32).toString("base64url");
    const db = smokeDb();
    try {
      await db`update sponsor_orders set invoice_token_hash = ${createHash("sha256").update(knownToken, "utf8").digest()}
                where id = ${invoiceDealId} and invoice_number is not null`;
    } finally {
      await db.end();
    }
    const payRes = await fetch(`${BASE}/r/sponsor/invoice/${knownToken}/pay`, { method: "POST", redirect: "manual" });
    const invoicePage = await html(newSession(), `/r/sponsor/invoice/${knownToken}`);
    check(
      "sd pay on a settled offline invoice: 303 back to the invoice, stamped paid, no pay form",
      markedPaid?.status === 200 && v1data<Deal>(markedPaid).payment_status === "paid" &&
        payRes.status === 303 && (payRes.headers.get("location") ?? "").endsWith(`/r/sponsor/invoice/${knownToken}`) &&
        // The page it lands on: the same token opens the invoice, stamped paid, with no pay form.
        invoicePage.status === 200 && invoicePage.body.includes('data-testid="sponsor-invoice"') &&
        invoicePage.body.includes('data-state="paid"') && !invoicePage.body.includes('data-testid="invoice-pay"'),
    );
  }

  // --- PR 3 Task 23: an OFFLINE invoice is emailed (F13), on the community org whose bank details the Task 21 rows saved, for a deal
  // on its OWN sponsor (F33). Send invoice answers 200 with no payment session, the deal does not move, the send ROTATES the invoice
  // token (F9: the stored hash changes), and exactly one `sponsor_invoice` row for the deal is queued to the billing address with the
  // numbered subject. The row's body (the link itself) is sealed and, on this keyless server, scrubbed by the request's own first
  // attempt, so smoke cannot read the emailed token back (sponsor-invoice-email.test.ts opens the real body and follows its link).
  if (!process.env.DATABASE_URL) {
    check("sd offline invoice email: skipped (no DATABASE_URL to read the outbox) - sponsor-invoice-email.test.ts covers it", true);
  } else {
    const billing = `delivered+deal_invoice_${tag}@resend.dev`;
    const emailSponsor = await addSponsor(`Deal Emailed ${tag}`);
    const emailed = await createDeal(emailSponsor, { sponsor_email: billing });
    const emailedDeal = emailed.status === 201 ? v1data<{ deal: Deal }>(emailed).deal : null;
    const db = smokeDb();
    try {
      const hashOf = async (id: string) =>
        (await db<{ h: Buffer | null }[]>`select invoice_token_hash as h from sponsor_orders where id = ${id}`)[0]?.h ?? null;
      const before = emailedDeal ? await hashOf(emailedDeal.id) : null;
      const sent = emailedDeal ? await v1(free, `/api/v1/orgs/${org.id}/sponsor-deals/${emailedDeal.id}/send-invoice`, "POST") : null;
      const sentData = sent?.status === 200 ? v1data<{ deal: Deal; invoice_url: string }>(sent) : null;
      const after = emailedDeal ? await hashOf(emailedDeal.id) : null;
      const rows = emailedDeal
        ? await db<{ recipient: string; subject: string }[]>`
            select recipient, subject from email_outbox
             where kind = 'sponsor_invoice' and ref_type = 'sponsor_order' and ref_id = ${emailedDeal.id}`
        : [];
      check(
        "sd offline invoice email queued with the invoice link",
        sentData !== null && /\/r\/sponsor\/invoice\/[A-Za-z0-9_-]{20,}$/.test(sentData.invoice_url) &&
          !sentData.invoice_url.includes("checkout.stripe") && sentData.deal.deal_status === emailedDeal?.deal_status &&
          before !== null && after !== null && !before.equals(after) &&
          rows.length === 1 && rows[0]?.recipient === billing.toLowerCase() && /^Invoice SP-\d{4,} — /.test(rows[0]?.subject ?? ""),
      );

      // The invoice page and its PDF for that deal. The emailed token cannot be read back (above), so this row plants a KNOWN
      // token's hash on the deal the way the send stored its own (the same sha256 as server/sponsors/report-token.ts).
      const knownToken = randomBytes(32).toString("base64url");
      if (emailedDeal) {
        await db`update sponsor_orders set invoice_token_hash = ${createHash("sha256").update(knownToken, "utf8").digest()}
                  where id = ${emailedDeal.id} and invoice_number is not null`;
      }
      const page = await html(newSession(), `/r/sponsor/invoice/${knownToken}`);
      const pdf = await fetch(`${BASE}/r/sponsor/invoice/${knownToken}/pdf`);
      const bytes = Buffer.from(await pdf.arrayBuffer());
      check(
        "sd invoice pdf is application/pdf for an invoice token; the page reads unpaid with the bank details",
        page.status === 200 && page.body.includes('data-state="unpaid"') && page.body.includes(invoiceBank) &&
          pdf.status === 200 && pdf.headers.get("content-type") === "application/pdf" &&
          bytes.subarray(0, 5).toString("latin1") === "%PDF-",
      );
    } finally {
      await db.end();
    }
  }

  // --- PR 3 Task 24: an OFFLINE deal that went live and then ended unpaid (its term ran out) is still DUE. It is the one ended deal
  // that offers Mark as paid and Write off (lib/sponsor-deals.ts `endedStillDue`), and the sponsor list's row names it instead of
  // saying a bare "Ended" with an Add deal. Made as a club makes it - a sponsor, an immediate offline deal with a billing email -
  // and then the term ends: no route ends a deal that way (the hourly sweep does), so that one step is SQL, under the CHECKs
  // `ended_shape` (V495) and `written_off_unpaid_offline` (V503: a written-off deal is offline, unpaid and went live).
  if (!process.env.DATABASE_URL) {
    check("sd ended-unpaid deal rows: skipped (no DATABASE_URL to end a deal) - sponsor-deals.test.ts and sponsor-list.test.tsx cover them", true);
  } else {
    type EndedDeal = Deal & { ended_reason: string | null };
    const dueName = `Deal Ended Due ${tag}`;
    const dueSponsor = await addSponsor(dueName);
    const dueMade = await createDeal(dueSponsor, { go_live: "immediate", sponsor_email: `delivered+deal_due_${tag}@resend.dev` });
    const dueDeal = dueMade.status === 201 ? v1data<{ deal: Deal }>(dueMade).deal : null;
    const writeOff = (id: string) => v1(free, `/api/v1/orgs/${org.id}/sponsor-deals/${id}/write-off`, "POST");
    // Nothing is due on a LIVE deal: the club cannot waive an invoice whose sponsor still has the placement.
    const refusedLive = dueDeal ? await writeOff(dueDeal.id) : null;
    check(
      "sd write off is refused on a live deal (409), and the deal is untouched",
      dueDeal?.deal_status === "live" && refusedLive?.status === 409 &&
        v1data<EndedDeal>(await v1(free, `/api/v1/orgs/${org.id}/sponsor-deals/${dueDeal.id}`)).deal_status === "live",
    );

    const knownToken = randomBytes(32).toString("base64url");
    const db = smokeDb();
    let ended = 0;
    try {
      if (dueDeal) {
        ended = (
          await db`update sponsor_orders set deal_status = 'ended', ended_reason = 'expired', ended_at = now()
                    where id = ${dueDeal.id} and deal_status = 'live' returning id`
        ).length;
        // The emailed token cannot be read back (the rows above), so a KNOWN token's hash is planted the way the send stores its own.
        await db`update sponsor_orders set invoice_token_hash = ${createHash("sha256").update(knownToken, "utf8").digest()}
                  where id = ${dueDeal.id} and invoice_number is not null`;
      }
    } finally {
      await db.end();
    }
    const dueHub = await html(free, `/o/${org.slug}/sponsors?tab=sponsors`);
    const dueAt = dueHub.body.indexOf(`data-sponsor-id="${dueSponsor}"`);
    const dueRow = dueAt >= 0 ? dueHub.body.slice(dueAt, dueHub.body.indexOf("</li>", dueAt)) : "";
    const dueBefore = await html(newSession(), `/r/sponsor/invoice/${knownToken}`);
    check(
      "sd ended-unpaid deal: the hub row reads Ended · unpaid with Mark as paid; the invoice still reads unpaid and says it is due",
      ended === 1 && dueHub.status === 200 &&
        dueRow.includes("Ended · unpaid") && (dueRow.match(/data-testid="sponsor-row-action"/g) ?? []).length === 1 &&
        dueRow.includes('data-action="mark_paid"') &&
        dueBefore.status === 200 && dueBefore.body.includes('data-state="unpaid"') &&
        dueBefore.body.includes("This sponsorship has ended, and this invoice is still due.") &&
        !dueBefore.body.includes('data-testid="invoice-pay"'),
    );

    const wroteOff = dueDeal ? await writeOff(dueDeal.id) : null;
    const dueAfter = await html(newSession(), `/r/sponsor/invoice/${knownToken}`);
    const wroteOffDeal = wroteOff?.status === 200 ? v1data<EndedDeal>(wroteOff) : null;
    check(
      "sd write off: the deal reads written_off with its money still unpaid; the invoice reads Written off and asks for nothing",
      wroteOffDeal?.ended_reason === "written_off" && wroteOffDeal.payment_status === "pending" && wroteOffDeal.deal_status === "ended" &&
        dueAfter.status === 200 && dueAfter.body.includes('data-state="written_off"') &&
        dueAfter.body.includes("Nothing due — written off by") &&
        !dueAfter.body.includes('data-testid="invoice-pay"') && !dueAfter.body.includes('data-testid="invoice-bank"'),
    );

    // Once is all: a deal already written off has nothing due, so a second write off is refused and changes nothing.
    const writeOffAgain = dueDeal ? await writeOff(dueDeal.id) : null;
    check(
      "sd a second write off is refused (409)",
      wroteOffDeal !== null && writeOffAgain?.status === 409 &&
        v1data<EndedDeal>(await v1(free, `/api/v1/orgs/${org.id}/sponsor-deals/${dueDeal!.id}`)).ended_reason === "written_off",
    );
  }

  // --- T9, the hourly sweep's route (D20): the cron secret guards it, and the right one answers the sweep's counts. CI sets
  // CRON_SECRET for the smoke job and its server alike (ci.yml), so a wrong secret is exactly a 401.
  const wrongCron = await fetch(`${BASE}/api/cron/sponsor-deals`, { method: "POST", headers: { "x-cron-secret": "definitely-wrong-sponsor-deals" } });
  check("sd cron route refuses a wrong secret (401)", wrongCron.status === 401);
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    check("sd cron route right-secret shape skipped (no CRON_SECRET in smoke env)", true);
  } else {
    const rightCron = await fetch(`${BASE}/api/cron/sponsor-deals`, { method: "POST", headers: { "x-cron-secret": cronSecret } });
    const cron = (await rightCron.json().catch(() => ({}))) as { ok?: boolean; data?: Record<string, unknown> };
    const KEYS = ["checked", "expired", "finished", "promoted", "failed"] as const;
    check(
      "sd cron route answers counts (200)",
      rightCron.status === 200 && cron.ok === true && KEYS.every((k) => typeof cron.data?.[k] === "number"),
    );
  }
}
