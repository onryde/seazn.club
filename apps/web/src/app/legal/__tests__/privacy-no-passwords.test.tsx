import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Password sign-in was removed 2026-10-19 (src/lib/__tests__/no-password-auth.test.ts is the code tripwire). The
// product signs in by a single-use emailed link and Google only, so no legal page a data subject reads may still
// say we collect a password hash, send password-reset emails, or hash passwords with bcrypt. The privacy policy
// did all three until that day.
//
// Sport: not applicable (legal copy).
vi.mock("@/components/marketing-nav", () => ({ MarketingNav: () => null }));
vi.mock("@/components/marketing-footer", () => ({ MarketingFooter: () => null }));

import PrivacyPage from "../privacy/page";
import TermsPage from "../terms/page";
import DpaPage from "../dpa/page";
import CookiePolicyPage from "../cookie-policy/page";
import SubProcessorsPage from "../sub-processors/page";

const PAGES: Record<string, () => React.ReactElement> = {
  privacy: () => <PrivacyPage />,
  terms: () => <TermsPage />,
  dpa: () => <DpaPage />,
  "cookie-policy": () => <CookiePolicyPage />,
  "sub-processors": () => <SubProcessorsPage />,
};

/** What a reader sees: the markup without tags (attribute values and class names are not copy). */
const textOf = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

describe("legal pages — no mention of password sign-in", () => {
  it("no legal page mentions a password or bcrypt", () => {
    let checked = 0;
    for (const [name, render] of Object.entries(PAGES)) {
      const html = renderToStaticMarkup(render());
      // Anti-vacuity: a page that rendered nothing would satisfy every "does not mention" below.
      expect(textOf(html).length, `${name} rendered real copy`).toBeGreaterThan(500);
      expect(textOf(html), `${name} mentions a password`).not.toMatch(/password/i);
      expect(textOf(html), `${name} mentions bcrypt`).not.toMatch(/bcrypt/i);
      checked++;
    }
    expect(checked, "anti-vacuity: every legal page was read").toBe(Object.keys(PAGES).length);
    expect(checked).toBe(5);
  });

  it("the matcher can fail: it sees the three sentences the privacy page used to carry", () => {
    // The positive pair of the test above: without this, a regex typo would pass the page checks forever.
    for (const old of [
      "email address, display name, avatar URL, password hash.",
      "Sending transactional emails (verification, password reset, billing receipts).",
      "Passwords are hashed with bcrypt.",
    ]) {
      expect(old, old).toMatch(/password/i);
    }
    expect("Passwords are hashed with bcrypt.").toMatch(/bcrypt/i);
  });

  it("the privacy policy says how people sign in instead, in the places the password lines were", () => {
    const text = textOf(renderToStaticMarkup(<PrivacyPage />));
    // Security section: the replacement sentence sits in section 11 beside the TLS line it used to follow.
    const from = text.indexOf("11. Security");
    expect(from, "section 11 exists").toBeGreaterThan(-1);
    const security = text.slice(from, text.indexOf("12.", from));
    expect(security).toContain("Data is encrypted in transit (TLS) and at rest.");
    expect(security).toContain("Sign-in is by a single-use emailed link or by Google.");
    // Account data lists the email, name and avatar and nothing about credentials.
    expect(text).toContain("email address, display name, avatar URL.");
    // The transactional mail we do send.
    expect(text).toContain("(verification, sign-in links, billing receipts)");
  });
});
