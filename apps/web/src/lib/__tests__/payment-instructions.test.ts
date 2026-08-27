// {{reference}} substitution + Markdown→text stripping for organiser payment
// instructions (fails without lib/payment-instructions).
import { describe, expect, it } from "vitest";
import {
  fillPaymentInstructions,
  paymentInstructionsText,
  preserveLineBreaks,
} from "../payment-instructions";
import { registrationTemplate } from "../email-templates/registration";
import { renderProse } from "../prose";
import emailsEn from "@/dictionaries/en/emails.json";
import type { Dict } from "@/lib/i18n";

describe("payment instructions", () => {
  it("fills {{reference}} with the ref code, everywhere it appears", () => {
    const out = fillPaymentInstructions(
      "Quote {{reference}} on the transfer. Ref: {{reference}}",
      "SZ-4F7K-2Q9D",
    );
    expect(out).toBe("Quote SZ-4F7K-2Q9D on the transfer. Ref: SZ-4F7K-2Q9D");
  });

  it("degrades gracefully before a reference exists", () => {
    expect(fillPaymentInstructions("Quote {{reference}}.", null)).toBe(
      "Quote your registration reference.",
    );
  });

  it("strips markdown to readable text for email panels", () => {
    expect(
      paymentInstructionsText(
        "## How to pay\n**Bank:** Example Bank\nPay via [our page](https://x.test/pay)\n> cash on the day works too",
      ),
    ).toBe(
      "How to pay\nBank: Example Bank\nPay via our page: https://x.test/pay\ncash on the day works too",
    );
  });

  // Bug (2026-08-27 browser sweep): Markdown treats one \n as insignificant
  // whitespace — only a BLANK line starts a new paragraph — so an organiser's
  // bank details ("Bank: X\nAccount name: Y\nSort code: Z") rendered as one
  // run-on paragraph on the public status page. A real paragraph break
  // (blank line) must still work; only the LONE newlines need hardening.
  it("hard-breaks single newlines but leaves real paragraph breaks (blank lines) alone", () => {
    const md = "Please pay using these details:\n\nBank: Example Bank\nAccount name: Riverside FC\nSort code: 12-34-56";
    expect(preserveLineBreaks(md)).toBe(
      "Please pay using these details:\n\nBank: Example Bank  \nAccount name: Riverside FC  \nSort code: 12-34-56",
    );
  });

  it("does not touch a blank-line-only gap (no spurious hard break introduced)", () => {
    expect(preserveLineBreaks("one\n\ntwo")).toBe("one\n\ntwo");
  });

  // The assertion that actually matters (per lib/prose's own "br" allowlist):
  // rendered HTML, not the intermediate markdown string.
  it("renders each line on its own line — no run-on paragraph — through the real renderProse pipeline", async () => {
    const md = preserveLineBreaks(
      fillPaymentInstructions(
        "Please pay using these details:\n\nBank: Example Bank\nAccount name: RS007 Seed Org\nSort code: 12-34-56\nAccount number: 12345678\nReference: {{reference}}",
        "SZ-AAAA-BBBB",
      ),
    );
    const html = await renderProse(md);
    expect(html).toContain("Bank: Example Bank<br>");
    expect(html).toContain("Account name: RS007 Seed Org<br>");
    expect(html).toContain("Sort code: 12-34-56<br>");
    expect(html).toContain("Account number: 12345678<br>");
    // The blank-line break still produced a real paragraph, not one <br>.
    expect(html).toMatch(/<p>Please pay using these details:<\/p>\s*<p>/);
    // The tell for the bug: these two labels must NEVER be space-joined.
    expect(html).not.toContain("Account name: RS007 Seed Org Sort code:");
  });

  it("registration email carries the personalised, stripped instructions", () => {
    const { html, text } = registrationTemplate(
      {
        orgName: "Riverside",
        competitionName: "Spring Open",
        entries: [{ displayName: "Alex", status: "pending", feeCents: 2500 }],
        totalCents: 2500,
        currency: "gbp",
        paymentInstructions: "**Quote {{reference}}** on your transfer.",
        statusUrl: "https://x.test/status",
        refCode: "SZ-AAAA-BBBB",
      },
      emailsEn as Dict,
    );
    expect(html).toContain("Quote SZ-AAAA-BBBB on your transfer.");
    expect(html).not.toContain("{{reference}}");
    expect(html).not.toContain("**");
    expect(text).toContain("Quote SZ-AAAA-BBBB on your transfer.");
  });
});
