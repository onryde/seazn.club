// Sponsor deals T22 - the sponsor's invoice page, /r/sponsor/invoice/[token] (spec §7), modelled on the report page's suite
// (../../../[token]/__tests__/page.test.tsx). renderToStaticMarkup (apps/web vitest is `environment: "node"`, no DOM).
//
// The SEAM is real end to end (F9): the REAL createDeal mints the token (captured by wrapping the real `mintInvoiceToken`),
// the real page renders it through the real `invoiceDocByToken` and the real database, and a second real mint rotates it - the
// old link then answers the opaque 404. Stand-ins: Stripe and the mail transport (no network), the request context Next would
// supply (locale, headers, cookies) and `notFound`, which Next turns into the 404.
//
// What the page must do (brief, Acceptance):
//   - noindex, nofollow, no referrer; a head read from the reader's locale alone, no database;
//   - rate-limited by `publicRateLimit` BEFORE the lookup: a throttled visit gets its screen, never the invoice, no statement;
//   - an unknown, a rotated and a malformed token: notFound() - the ONE opaque 404, at the same cost;
//   - the invoice in the ORG's language (here fr, read by an en visitor), every label from that dictionary;
//   - `ph-no-capture` on the two elements that paint the token (the PDF link, the pay form);
//   - the pay form only on an invoice a card can pay (online, due); bank details only on an offline invoice, while due.
// Killers: the opaque-404 case (a 404 that tells "rotated" from "unknown"); the throttled case (limit removed or moved after the
// lookup); the offline case (createDeal skips the mint: no token, nothing to open).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Tx } from "@/lib/db";

const ctx = vi.hoisted(() => ({ locale: "en" as "en" | "es" | "fr" | "nl", ip: "203.0.113.7", cookieReads: [] as string[] }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => ctx.locale }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      ctx.cookieReads.push(name);
      return undefined;
    },
    getAll: () => [],
    has: () => false,
    set: () => {},
    delete: () => {},
  }),
  headers: async () => new Headers({ "x-forwarded-for": `${ctx.ip}, 10.0.0.1`, "accept-language": "en" }),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));
const stripe = vi.hoisted(() => ({ create: vi.fn(), retrieve: vi.fn(), expire: vi.fn() }));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({ checkout: { sessions: { create: stripe.create, retrieve: stripe.retrieve, expire: stripe.expire } } }),
}));
const deliverMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/email-outbox/transport", () => ({ deliver: deliverMock }));
const minted = vi.hoisted(() => [] as { dealId: string; token: string }[]);
vi.mock("@/server/sponsors/invoice-doc", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/server/sponsors/invoice-doc")>();
  return {
    ...orig,
    mintInvoiceToken: vi.fn(async (tx: Tx, dealId: string) => {
      const token = await orig.mintInvoiceToken(tx, dealId);
      minted.push({ dealId, token });
      return token;
    }),
  };
});

import { sql, statementCount, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { __setRateLimitCounterForTests } from "@/lib/rate-limit";
import { getDictionary, t } from "@/lib/i18n";
import { stubOutboxEnv } from "@/server/usecases/__tests__/_invite-mail";
import { createDeal } from "@/server/usecases/sponsor-deals";
import { mintInvoiceToken, type SponsorInvoiceDoc } from "@/server/sponsors/invoice-doc";
import { INVOICE_STATES } from "@/lib/sponsor-invoice";
import { BILLED_ROW_CLASS, STAMP_CLASS, SponsorInvoiceView } from "@/components/sponsors/invoice-view";
import { ORIGIN, cleanUp, dealInput, idempotentCreate, rigOrg, rigPackage, rigSponsor, uniq } from "@/server/sponsors/__tests__/_invoice-rig";
import SponsorInvoicePage, { generateMetadata } from "../page";
import SponsorInvoiceNotFound, { generateMetadata as notFoundMetadata } from "../not-found";

const HAS_DB = !!process.env.DATABASE_URL;
const en = await getDictionary("en", "ui");
const fr = await getDictionary("fr", "ui");
const es = await getDictionary("es", "ui");
const LONG_PACKAGE = "Harbourside Building Supplies Premier Courtside Board"; // a long name must wrap, never push the page sideways

const counted = new Map<string, number>();
let overLimit = false;
beforeEach(() => {
  counted.clear();
  overLimit = false;
  minted.length = 0;
  ctx.locale = "en";
  ctx.ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
  ctx.cookieReads = [];
  stubOutboxEnv();
  deliverMock.mockReset().mockImplementation(async () => ({ ok: true, providerId: `re_${uniq()}` }));
  stripe.create.mockReset().mockImplementation(idempotentCreate());
  stripe.retrieve.mockReset().mockImplementation(async (id: string) => ({ id, status: "open" }));
  stripe.expire.mockReset().mockImplementation(async (id: string) => ({ id, status: "expired" }));
  __setRateLimitCounterForTests(async (key) => {
    const n = (counted.get(key) ?? 0) + 1;
    counted.set(key, n);
    return { count: overLimit ? 61 : n, ttlMs: 30_000 };
  });
});
afterEach(() => __setRateLimitCounterForTests(null));
afterAll(async () => {
  if (HAS_DB) await cleanUp();
});

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const render = async (token: string) => renderToStaticMarkup(await SponsorInvoicePage({ params: Promise.resolve({ token }) }));
/** The element with this test id, as markup (its open tag through its own close). */
const openTag = (html: string, testId: string) => html.match(new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? "";

/** A document as invoice-doc.ts builds it, for the view alone (no database). */
function viewDoc(over: Partial<SponsorInvoiceDoc> = {}): SponsorInvoiceDoc {
  return {
    number: "SP-0042",
    issuedOn: "2026-11-09",
    org: { name: "Club Bádminton Ribera", address: null, logoPath: null },
    billedTo: { name: "Suministros de Construcción del Puerto", email: "cuentas.por.pagar@suministros-del-puerto.example" },
    line: { description: "Panel de pista — Todas las competiciones", amountCents: 123_456, currency: "eur" },
    included: { tier: "gold", scope: "Todas las competiciones", onStream: true },
    state: "unpaid",
    dealEnded: false,
    method: "online",
    bankDetails: null,
    payable: true,
    cardUnavailable: false,
    locale: "es",
    ...over,
  };
}
const renderView = (doc: SponsorInvoiceDoc, ui = es) =>
  renderToStaticMarkup(<SponsorInvoiceView doc={doc} ui={ui} pdfHref="/r/sponsor/invoice/T/pdf" payAction="/r/sponsor/invoice/T/pay" />);
const classTokens = (cls: string) => new Set(cls.split(/\s+/).filter(Boolean));

describe("the view: layout, ink and what it says (no database)", () => {
  it("320px: the bill-to block and its stamp STACK below sm and sit side by side from sm - es 'Pendiente de pago' never squeezes the sponsor's name (review I5)", () => {
    const row = classTokens(BILLED_ROW_CLASS);
    for (const want of ["flex", "flex-col", "min-w-0", "sm:flex-row", "sm:justify-between"]) expect(row.has(want), want).toBe(true);
    // Nothing puts them side by side below sm.
    for (const unwanted of ["flex-row", "justify-between"]) expect(row.has(unwanted), unwanted).toBe(false);
    const html = renderView(viewDoc());
    // The section that holds the name is that row, and the stamp can never be wider than it.
    expect(html).toMatch(new RegExp(`<section class="${BILLED_ROW_CLASS}"><div[^>]*><h2[^>]*>${esc(t(es, "sponsors.invoice.billedTo"))}</h2><p data-testid="invoice-billed-to"`));
    const stamp = openTag(html, "invoice-state");
    expect(stamp).toMatch(/class="[^"]*\bmax-w-full\b/);
    expect(html).toContain(`>${esc(t(es, "sponsors.invoice.state.unpaid"))}<`);
  });

  it("the stamp wears house tokens only, never a raw palette colour; every token it names is declared in globals.css (5 states counted, review m6)", () => {
    const css = readFileSync(resolve(process.cwd(), "src/app/globals.css"), "utf8");
    let checked = 0;
    for (const state of INVOICE_STATES) {
      const cls = STAMP_CLASS[state];
      expect(cls, state).not.toMatch(/\b(?:text|border)-(?:red|emerald|green|slate|gray|zinc|neutral|rose|amber|lime|purple)-\d{2,3}\b/);
      const colours = [...cls.matchAll(/\b(?:text|border)-(\[var\(--[a-z-]+\)\]|[a-z-]+)/g)].map((m) => m[1]!);
      expect(colours, state).toHaveLength(2);
      for (const c of colours) {
        const variable = c.startsWith("[var(") ? c.slice(5, -2) : `--color-${c}`;
        expect(css, `${state}: ${variable} is a house token`).toMatch(new RegExp(`${variable.replace(/[-]/g, "\\-")}\\s*:`));
      }
      expect(openTag(renderView(viewDoc({ state, payable: false })), "invoice-state"), state).toContain(cls);
      checked++;
    }
    expect(checked).toBe(5);
    // Due and settled differ, so the stamp's ink alone tells them apart.
    expect(STAMP_CLASS.unpaid).not.toBe(STAMP_CLASS.paid);
  });

  it("says what is true of every way it ended: cancelled by the club, ended and still due (with how to pay), ended with nothing claimed (3 counted, review I3)", () => {
    const club = "Club Bádminton Ribera";
    const cases: [string, Partial<SponsorInvoiceDoc>, string, boolean][] = [
      ["End now", { state: "void", dealEnded: true, payable: false }, t(es, "sponsors.invoice.stateNote.void"), false],
      ["offline, ran live, term ran out", { state: "unpaid", dealEnded: true, method: "offline", payable: false, bankDetails: "IBAN ES91 2100 0418 4502 0005 1332" }, t(es, "sponsors.invoice.stateNote.endedDue"), true],
      ["ended, nothing claimed", { state: "ended", dealEnded: true, payable: false }, t(es, "sponsors.invoice.stateNote.ended", { club }), false],
    ];
    let checked = 0;
    for (const [label, over, note, bank] of cases) {
      const html = renderView(viewDoc(over));
      expect(html, label).toMatch(new RegExp(`data-testid="invoice-state-note"[^>]*>${esc(note).replace(/[.*+?^$()|[\]\\]/g, "\\$&")}<`));
      expect(html.includes('data-testid="invoice-bank"'), label).toBe(bank);
      expect(html, label).not.toContain('data-testid="invoice-pay"');
      checked++;
    }
    expect(checked).toBe(3);
    expect(t(es, "sponsors.invoice.stateNote.ended", { club }), "the club is named").toContain(club);
    // The positive pair: an invoice due while its deal runs carries no note (the page says how to pay).
    expect(renderView(viewDoc())).not.toContain('data-testid="invoice-state-note"');
  });

  it("a card-payable invoice the club cannot take cards for says so and names the club - no button that cannot work (review m2)", () => {
    const html = renderView(viewDoc({ payable: false, cardUnavailable: true }));
    expect(html).toMatch(new RegExp(`data-testid="invoice-card-unavailable"[^>]*>${esc(t(es, "sponsors.invoice.cardUnavailable", { club: "Club Bádminton Ribera" }))}<`));
    expect(html).not.toContain('data-testid="invoice-pay"');
    // The positive pair: payable shows the button and no such line.
    const ok = renderView(viewDoc());
    expect(ok).toContain('data-testid="invoice-pay"');
    expect(ok).not.toContain('data-testid="invoice-card-unavailable"');
  });
});

describe("metadata", () => {
  it("is noindex, nofollow and no-referrer, titled in the reader's locale - read from the locale alone, no database", async () => {
    ctx.locale = "fr";
    const before = statementCount();
    const meta = await generateMetadata();
    expect(statementCount() - before, "the head needs no lookup").toBe(0);
    expect(meta.robots).toEqual({ index: false, follow: false });
    expect(meta.referrer).toBe("no-referrer");
    expect(meta.title).toBe(t(fr, "sponsors.invoice.meta.title"));
    expect(meta.description).toBe(t(fr, "sponsors.invoice.meta.description"));
  });

  it("the 404's head is its own and says the same: noindex, nofollow, no-referrer, no lookup", async () => {
    ctx.locale = "fr";
    const before = statementCount();
    const meta = await notFoundMetadata();
    expect(statementCount() - before).toBe(0);
    expect(meta.robots).toEqual({ index: false, follow: false });
    expect(meta.referrer).toBe("no-referrer");
    expect(meta.title).toBe(t(fr, "sponsors.invoice.notFound.title"));
    const html = renderToStaticMarkup(await SponsorInvoiceNotFound());
    expect(html).toContain('data-testid="sponsor-invoice-not-found"');
    expect(html).toContain(esc(t(fr, "sponsors.invoice.notFound.body")));
  });
});

describe("a throttled visit", () => {
  it("gets the throttled screen, never the invoice or the 404, and spends no statement; the client's own IP is the bucket", async () => {
    overLimit = true;
    const before = statementCount();
    const html = await render(randomBytes(32).toString("base64url"));
    expect(statementCount() - before, "checked before the lookup").toBe(0);
    expect(html).toContain('data-testid="sponsor-invoice-throttled"');
    expect(html).toContain(esc(t(en, "sponsors.invoice.throttled.title")));
    expect(html).not.toContain('data-testid="sponsor-invoice"');
    expect([...counted.keys()]).toEqual([`rl:pubv1:${ctx.ip}`]);
  });

  it("a limiter that fails for any other reason is a real error, not the throttled screen (2 failures counted)", async () => {
    let checked = 0;
    for (const failure of [new Error("limiter exploded"), new HttpError(503, "limiter unavailable")]) {
      __setRateLimitCounterForTests(async () => {
        throw failure;
      });
      const before = statementCount();
      await expect(render(randomBytes(32).toString("base64url"))).rejects.toBe(failure);
      expect(statementCount() - before).toBe(0);
      checked++;
    }
    expect(checked).toBe(2);
  });
});

describe.skipIf(!HAS_DB)("the seam: the real createDeal's token, the real page", () => {
  it("empty case: a token that names nothing is the 404, before any deal exists", async () => {
    await expect(render(randomBytes(32).toString("base64url"))).rejects.toThrow("NOT_FOUND");
  });

  it("an offline invoice opens with no session, in the ORG's language, with its bank details, a PDF link behind ph-no-capture and no pay form", async () => {
    const org = await rigOrg({ locale: "fr", address: "12 rue du Port\n75001 Paris", bank: "IBAN FR76 3000 6000 0112 3456 7890 189" });
    const pkg = await rigPackage(org, { name: LONG_PACKAGE, price: 123_456, currency: "eur", onStream: true });
    const sponsor = await rigSponsor(org);
    const { deal } = await createDeal(org.auth, sponsor.id, dealInput(pkg.id), ORIGIN);
    expect(minted.map((m) => m.dealId), "createDeal minted this deal's token (F9)").toEqual([deal.id]);
    const token = minted[0]!.token;

    const html = await render(token);
    expect(ctx.cookieReads.filter((name) => /session|auth|sid/i.test(name)), "no session is read").toEqual([]);
    expect(html).toContain('data-testid="sponsor-invoice"');
    expect(html).toContain('lang="fr"');
    // The org's first invoice (T20): SP-0001. The words are fr although the visitor reads en.
    expect(html).toMatch(/data-testid="invoice-number"[^>]*>SP-0001</);
    expect(html).toContain(esc(t(fr, "sponsors.invoice.title")));
    expect(html).not.toContain(`>${esc(t(en, "sponsors.invoice.billedTo"))}<`);
    expect(html).toContain(esc(t(fr, "sponsors.invoice.line", { package: LONG_PACKAGE, scope: t(fr, "sponsors.scopeAll") })));
    expect(html).toMatch(new RegExp(`data-testid="invoice-state" data-state="unpaid"[^>]*>${esc(t(fr, "sponsors.invoice.state.unpaid"))}<`));
    expect(html).toContain(esc(org.name));
    expect(html).toContain(esc(sponsor.name));
    const amount = new Intl.NumberFormat("fr", { style: "currency", currency: "EUR" }).format(1234.56);
    expect(html.split(amount).length - 1, "the line and the total").toBe(2);
    expect(html).toContain("IBAN FR76 3000 6000 0112 3456 7890 189");
    expect(html).toContain(esc(t(fr, "sponsors.invoice.bankReference", { number: "SP-0001" })));
    expect(html).toContain(esc(t(fr, "sponsors.invoice.included.yes")));
    // No pay form on an offline invoice: it is paid by transfer.
    expect(html).not.toContain('data-testid="invoice-pay"');
    expect(html).not.toContain(`/r/sponsor/invoice/${token}/pay`);
    // The token is painted in exactly one place here, the PDF link, and that element is ph-no-capture.
    expect(html.split(token).length - 1).toBe(1);
    const pdfLink = openTag(html, "invoice-pdf");
    expect(pdfLink).toContain(`href="/r/sponsor/invoice/${token}/pdf"`);
    expect(pdfLink).toMatch(/class="[^"]*\bph-no-capture\b/);
    // Print: the buttons are chrome.
    expect(html).toMatch(/<footer[^>]*class="[^"]*\bprint:hidden\b/);
    // Long names wrap: min-w-0 on the line's boxes and break-words on the cell.
    expect(openTag(html, "invoice-line")).toMatch(/\bbreak-words\b/);
  });

  it("an online invoice still due shows the pay form, posting to /pay behind ph-no-capture, and no bank block - bank details are for offline invoices, even when the club set them", async () => {
    const org = await rigOrg({ locale: "en", bank: "Sort code 12-34-56" });
    const pkg = await rigPackage(org);
    const sponsor = await rigSponsor(org);
    await createDeal(org.auth, sponsor.id, dealInput(pkg.id, { payment_method: "online" }), ORIGIN);
    const token = minted.at(-1)!.token;
    const html = await render(token);
    const form = openTag(html, "invoice-pay");
    expect(form).toContain(`action="/r/sponsor/invoice/${token}/pay"`);
    expect(form).toContain('method="post"');
    expect(form).toMatch(/class="[^"]*\bph-no-capture\b/);
    expect(html).toContain(esc(t(en, "sponsors.invoice.payByCard")));
    expect(html).not.toContain('data-testid="invoice-bank"');
    expect(html).not.toContain("Sort code 12-34-56");
    expect(html).toContain(esc(t(en, "sponsors.invoice.included.no")));
    // Every element that carries the token is ph-no-capture: two of them.
    expect(html.split(token).length - 1).toBe(2);
  });

  it("Connect stopped taking charges: the real page drops the pay form and names the club to contact; the token is painted once, behind ph-no-capture", async () => {
    const org = await rigOrg({ locale: "en" });
    const pkg = await rigPackage(org);
    const sponsor = await rigSponsor(org);
    await createDeal(org.auth, sponsor.id, dealInput(pkg.id, { payment_method: "online" }), ORIGIN);
    const token = minted.at(-1)!.token;
    expect(await render(token), "premise: payable while Connect takes charges").toContain('data-testid="invoice-pay"');
    await sql`update organizations set stripe_charges_enabled = false where id = ${org.orgId}`;
    const html = await render(token);
    expect(html).not.toContain('data-testid="invoice-pay"');
    expect(html).toContain(esc(t(en, "sponsors.invoice.cardUnavailable", { club: org.name })));
    expect(html.split(token).length - 1).toBe(1);
    expect(openTag(html, "invoice-pdf")).toMatch(/class="[^"]*\bph-no-capture\b/);
  });

  it("one opaque 404 for an unknown, a ROTATED and a malformed token - the same answer at the same cost (3 counted)", async () => {
    const org = await rigOrg();
    const pkg = await rigPackage(org);
    const sponsor = await rigSponsor(org);
    const { deal } = await createDeal(org.auth, sponsor.id, dealInput(pkg.id), ORIGIN);
    const old = minted.at(-1)!.token;
    expect(await render(old), "premise: the link opened before the rotation").toContain('data-testid="sponsor-invoice"');
    // The rotation Task 23's Resend does: a new real mint replaces the hash.
    const fresh = await withTenant(org.orgId, (tx) => mintInvoiceToken(tx, deal.id));
    expect(await render(fresh), "the new link opens").toContain('data-testid="sponsor-invoice"');
    const costs: number[] = [];
    for (const token of [randomBytes(32).toString("base64url"), old, "not a token %%%"]) {
      const before = statementCount();
      await expect(render(token), token).rejects.toThrow("NOT_FOUND");
      costs.push(statementCount() - before);
    }
    expect(costs).toHaveLength(3);
    expect(new Set(costs).size, `one lookup for each: ${costs.join(", ")}`).toBe(1);
  });
});
