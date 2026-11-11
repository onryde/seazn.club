// The sponsor invoice PDF (Task 22, spec §7): what a sponsor and a club print. Real pdfkit and the real brand fonts; every string
// below is read back OUT of the rendered bytes (e2e/pdf-uris.ts), and every label the test expects comes from the locale's
// dictionary, never from the renderer.
//
// The document handed in is a literal: this suite proves the DRAWING. Where the document comes from - the deal, its org, its
// state - is invoice-doc.test.ts, and the two routes that draw it from a real deal are routes.test.ts and invoice-pdf-route.test.ts.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { getDictionary, t } from "@/lib/i18n";
import { LOCALES, type Dict } from "@/lib/i18n-constants";
import { INVOICE_STATES, INVOICE_STATE_KEY, INVOICE_STATE_NOTE_KEY } from "@/lib/sponsor-invoice";
import { TIER_MSG } from "@/components/sponsors/tier-labels";
import { pdfImages, pdfPageCount, pdfTextRuns } from "../../../../e2e/pdf-uris";
import { useBrandFonts } from "../../__tests__/_sheet-fixtures";
import type { SponsorInvoiceDoc } from "../invoice-doc";
import { invoicePdf } from "../invoice-pdf";


/** What one invoice render may take on a loaded runner (a quiet one takes ~100 ms): pdfkit, both brand fonts, the read-back. */
const RENDER_BUDGET_MS = 4_000;

let en: Dict;
let fr: Dict;
beforeAll(async () => {
  useBrandFonts();
  en = await getDictionary("en", "ui");
  fr = await getDictionary("fr", "ui");
});
afterEach(() => vi.unstubAllGlobals());

function invoice(over: Partial<SponsorInvoiceDoc> = {}): SponsorInvoiceDoc {
  return {
    number: "SP-0042",
    issuedOn: "2026-11-09",
    org: { name: "Riverside Shuttlers", address: "12 Mill Lane\nRiverside RS1 2AB", logoPath: null },
    billedTo: { name: "Harbour Bank", email: "billing@harbour.test" },
    line: { description: "Gold board sponsorship — All competitions", amountCents: 25_000, currency: "gbp" },
    included: { tier: "gold", scope: "All competitions", onStream: true },
    state: "unpaid",
    dealEnded: false,
    method: "offline",
    bankDetails: "Riverside Shuttlers\nSort code 12-34-56\nAccount 12345678",
    payable: false,
    cardUnavailable: false,
    locale: "en",
    ...over,
  };
}

async function textOf(doc: SponsorInvoiceDoc) {
  const pdf = await invoicePdf(doc);
  const runs = pdfTextRuns(pdf);
  return { pdf, runs, all: runs.map((r) => r.text).join("\n") };
}

describe("invoicePdf", () => {
  it("prints the number, the club, the sponsor, the line and its total, in the brand fonts", async () => {
    const { pdf, runs, all } = await textOf(invoice());
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdfPageCount(pdf)).toBe(1);
    for (const s of [
      "SP-0042",
      "Riverside Shuttlers",
      "12 Mill Lane",
      "Riverside RS1 2AB",
      "Harbour Bank",
      "billing@harbour.test",
      "Gold board sponsorship — All competitions",
      t(en, "sponsors.invoice.title"),
      t(en, "sponsors.invoice.billedTo"),
      t(en, "sponsors.invoice.total"),
      // English prints day-month-year (the PR 3 fix round): this line read the US "Nov 9, 2026" until then.
      "9 Nov 2026",
    ]) {
      expect(all, s).toContain(s);
    }
    // The amount twice: the line and the total. Its minor unit always shows (an invoice reads £250.00, never £250).
    expect(runs.filter((r) => r.text === "£250.00")).toHaveLength(2);
    // Names in Inter, the number in Barlow: a missed font falls back to Helvetica and garbles "Ł" (doc-theme.ts).
    const fontOf = (text: string) => runs.find((r) => r.text === text)?.font ?? "missing";
    expect(fontOf("Riverside Shuttlers")).toMatch(/Inter-Medium$/);
    expect(fontOf("Harbour Bank")).toMatch(/Inter-Medium$/);
    expect(fontOf("SP-0042")).toMatch(/BarlowCondensed/);
    expect(runs.every((r) => !/Helvetica/.test(r.font)), "no Helvetica fallback").toBe(true);
    expect(runs.filter((r) => r.text.includes("\u0000")), "no glyph the font lacks").toEqual([]);
  });

  // One test per locale, four renders each: sixteen pdfkit renders in one test outlived the 5 s default under a loaded run
  // (STACK_TRACE_ERROR, the runner's timeout). The budget is the renders' cost, not a flat number.
  it("the locale sweep covers the four locales (anti-vacuity: the per-locale tests below exist)", () => {
    expect([...LOCALES]).toEqual(["en", "fr", "es", "nl"]);
  });
  for (const locale of LOCALES) {
    it(`stamps each state in ${locale}'s word, with the line that says where it stands (6 states)`, async () => {
      const ui = await getDictionary(locale, "ui");
      const club = { club: "Riverside Shuttlers" };
      let checked = 0;
      for (const state of INVOICE_STATES) {
        const { all, runs } = await textOf(invoice({ locale, state, dealEnded: state !== "unpaid" && state !== "paid", bankDetails: state === "unpaid" ? "Sort code 12-34-56" : null }));
        expect(all, `${locale} ${state}`).toContain(t(ui, INVOICE_STATE_KEY[state]));
        // The stamp is ONE run of its own, exactly its word: the walkthrough (e2e/walkthrough/sponsor-invoices.spec.ts) reads a
        // sponsor's PDF as `runs.includes(word)`, and the "prints no other stamp" check below is an exact-run one too, so the
        // positive half is held to the same reading (a stamp split across runs would pass the joined-text line above and fail both).
        expect(runs.map((r) => r.text), `${locale} ${state} prints its stamp as one run`).toContain(t(ui, INVOICE_STATE_KEY[state]));
        for (const other of INVOICE_STATES.filter((s) => s !== state)) {
          expect(runs.map((r) => r.text), `${locale} ${state} prints no ${other} stamp`).not.toContain(t(ui, INVOICE_STATE_KEY[other]));
        }
        if (state === "unpaid") {
          for (const note of Object.values(INVOICE_STATE_NOTE_KEY)) expect(all.replace(/\n/g, " ")).not.toContain(t(ui, note, club));
          expect(all.replace(/\n/g, " ")).not.toContain(t(ui, "sponsors.invoice.stateNote.endedDue"));
        } else {
          expect(all.replace(/\n/g, " "), `${locale} ${state}`).toContain(t(ui, INVOICE_STATE_NOTE_KEY[state], club));
        }
        // Barlow draws the stamp and the heads: a word with a glyph it lacks prints a hole.
        expect(runs.filter((r) => r.text.includes("\u0000")), `${locale} ${state}`).toEqual([]);
        checked += 1;
      }
      expect(checked).toBe(6);
    }, INVOICE_STATES.length * RENDER_BUDGET_MS);
  }

  it("an offline invoice whose deal ENDED unpaid after running live is still due: Unpaid, the line that says it ended, and the bank details (review I3)", async () => {
    const { all } = await textOf(invoice({ state: "unpaid", dealEnded: true }));
    const flat = all.replace(/\n/g, " ");
    expect(flat).toContain(t(en, "sponsors.invoice.state.unpaid"));
    expect(flat).toContain(t(en, "sponsors.invoice.stateNote.endedDue"));
    expect(flat).toContain("Sort code 12-34-56");
    // The ended-with-nothing-claimed line names the club to contact.
    const ended = await textOf(invoice({ state: "ended", dealEnded: true, bankDetails: null }));
    expect(ended.all.replace(/\n/g, " ")).toContain(t(en, "sponsors.invoice.stateNote.ended", { club: "Riverside Shuttlers" }));
  });

  it("prints what the sponsorship includes: tier, scope, the public pages, and the stream yes or no", async () => {
    const on = await textOf(invoice());
    for (const s of [
      t(en, "sponsors.invoice.included.title"),
      t(en, TIER_MSG.gold),
      "All competitions",
      t(en, "sponsors.invoice.included.whereValue"),
      t(en, "sponsors.invoice.included.onStream"),
    ]) {
      expect(on.all, s).toContain(s);
    }
    const streamValue = (runs: { text: string }[]) => runs.filter((r) => r.text === t(en, "sponsors.invoice.included.yes") || r.text === t(en, "sponsors.invoice.included.no")).map((r) => r.text);
    expect(streamValue(on.runs)).toEqual([t(en, "sponsors.invoice.included.yes")]);
    const off = await textOf(invoice({ included: { tier: "silver", scope: "Winter League", onStream: false } }));
    expect(streamValue(off.runs)).toEqual([t(en, "sponsors.invoice.included.no")]);
    expect(off.all).toContain(t(en, TIER_MSG.silver));
    expect(off.all).toContain("Winter League");
  });

  it("prints the bank details and the reference while they are set, and nothing of them when they are not", async () => {
    const withBank = await textOf(invoice());
    for (const s of ["Sort code 12-34-56", "Account 12345678", t(en, "sponsors.invoice.bankDetails"), t(en, "sponsors.invoice.bankReference", { number: "SP-0042" })]) {
      expect(withBank.all, s).toContain(s);
    }
    const none = await textOf(invoice({ bankDetails: null }));
    expect(none.all).not.toContain(t(en, "sponsors.invoice.bankDetails"));
    expect(none.all).not.toContain("SP-0042 ");
    expect(none.all).not.toContain(t(en, "sponsors.invoice.bankReference", { number: "SP-0042" }));
    // The empty case: no address, no email, no logo, no bank - still one sheet with its number and total.
    const bare = await textOf(invoice({ org: { name: "Bare Club", address: null, logoPath: null }, billedTo: { name: "Solo", email: null }, bankDetails: null }));
    expect(pdfPageCount(bare.pdf)).toBe(1);
    expect(bare.all).toContain("SP-0042");
    expect(bare.runs.filter((r) => r.text === "£250.00")).toHaveLength(2);
    expect(pdfImages(bare.pdf)).toHaveLength(0);
  });

  it("prints the date day-month-year in every language: en '11 Nov 2026' (never the US 'Nov 11, 2026'), es, fr and nl as before (4 counted)", async () => {
    // Typed from each language's own way of writing a date, never from the renderer.
    const WANT: Record<string, string> = { en: "11 Nov 2026", es: "11 nov 2026", fr: "11 nov. 2026", nl: "11 nov 2026" };
    let checked = 0;
    for (const locale of LOCALES) {
      const { all } = await textOf(invoice({ locale, issuedOn: "2026-11-11" }));
      expect(all, locale).toContain(WANT[locale]);
      checked++;
    }
    expect(checked).toBe(4);
    expect((await textOf(invoice({ issuedOn: "2026-11-11" }))).all, "never the US order").not.toContain("Nov 11, 2026");
  }, 5 * RENDER_BUDGET_MS);

  it("draws in the document's own language: French labels, a French date and a euro amount", async () => {
    const { all, runs } = await textOf(invoice({ locale: "fr", line: { description: "Panneau or — Toutes", amountCents: 123_456, currency: "eur" } }));
    for (const key of ["sponsors.invoice.title", "sponsors.invoice.billedTo", "sponsors.invoice.total", "sponsors.invoice.bankDetails"] as const) {
      expect(all, key).toContain(t(fr, key));
    }
    expect(all).toContain(t(fr, INVOICE_STATE_KEY.unpaid));
    expect(all).toContain("9 nov. 2026");
    // fr groups with a NARROW no-break space (U+202F) and writes the symbol after: 1 234,56 €. Barlow has no U+202F glyph, so a
    // total drawn in Barlow printed "1<missing>234,56 €" (found by this case): every amount is Inter.
    const amount = new Intl.NumberFormat("fr", { style: "currency", currency: "EUR" }).format(1234.56);
    expect(amount).toContain("\u202f");
    expect(runs.filter((r) => r.text === amount)).toHaveLength(2);
    expect(runs.filter((r) => r.text.includes("\u0000")), "no glyph the font lacks").toEqual([]);
    expect(t(fr, "sponsors.invoice.title")).not.toBe(t(en, "sponsors.invoice.title"));
  });

  it("draws the club's logo when the doc carries one, and prints without it when it will not load", async () => {
    // RGBA: pdfkit re-encodes an alpha PNG as plain Flate, which pdfImages reads (an RGB one it embeds predictor-encoded).
    const png = await sharp({ create: { width: 60, height: 20, channels: 4, background: { r: 18, g: 52, b: 86, alpha: 1 } } }).png().toBuffer();
    const fetchMock = vi.fn(async () => new Response(new Uint8Array(png), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const branded = await invoicePdf(invoice({ org: { name: "Riverside Shuttlers", address: null, logoPath: "https://cdn.test/logo.png" } }));
    expect(fetchMock).toHaveBeenCalledWith("https://cdn.test/logo.png", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(pdfImages(branded)).toHaveLength(1);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("gone", { status: 404 })));
    const broken = await textOf(invoice({ org: { name: "Riverside Shuttlers", address: null, logoPath: "https://cdn.test/logo.png" } }));
    expect(pdfImages(broken.pdf)).toHaveLength(0);
    expect(broken.all).toContain("SP-0042");
  });
});
