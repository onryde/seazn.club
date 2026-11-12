// Polish wave P3 (W1, W4): the registration surfaces share ONE money spelling and ONE deadline spelling. A new surface (or an edit)
// that reaches for `formatMinor` (drops the decimals of a whole amount) or hand-rolls a deadline puts "£15" beside "£15.00" again, and
// no render test can see it until a person reads two screens side by side. This scan pins the wiring: every registration money surface
// imports `formatMoneyExact`, none imports `formatMinor`, and the surfaces that print a deadline go through `fmtPublicDeadline`.
//
// It reads source on purpose (apps/web vitest is `environment: "node"`: no DOM). The render tests beside each surface prove the
// output; this proves nothing else is quietly using the other formatter.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src");
const REG = "app/(public)/live/[orgSlug]/[competitionSlug]/register";

/** A registration surface that prints an amount. */
const MONEY_SURFACES = [
  "components/public-site/register/division-card.tsx",
  "components/public-site/register/entry-cart.tsx",
  "components/public-site/register/step-review.tsx",
  "components/public-site/register/register-stepper.tsx",
  `${REG}/status/entry-card.tsx`,
  `${REG}/status/page.tsx`,
  "components/registrations/pay-page-view.tsx",
  "lib/email-templates/shared.ts",
];

/** A surface that prints a pay-by deadline. */
const DEADLINE_SURFACES = [
  `${REG}/status/entry-card.tsx`,
  "components/registrations/pay-page-view.tsx",
  "lib/email-templates/registration.ts",
];

const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");
const importsName = (src: string, name: string) =>
  new RegExp(`import\\s*(?:type\\s*)?\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from`).test(src);

describe("the registration surfaces share one money spelling and one deadline spelling (polish wave P3)", () => {
  it("every money surface uses formatMoneyExact and none imports formatMinor (counted)", () => {
    let checked = 0;
    for (const rel of MONEY_SURFACES) {
      const src = read(rel);
      expect(importsName(src, "formatMoneyExact"), `${rel} imports formatMoneyExact`).toBe(true);
      expect(importsName(src, "formatMinor"), `${rel} imports formatMinor`).toBe(false);
      checked += 1;
    }
    expect(checked).toBe(MONEY_SURFACES.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("every deadline surface goes through fmtPublicDeadline; none hand-rolls the old spelling (counted)", () => {
    let checked = 0;
    for (const rel of DEADLINE_SURFACES) {
      const src = read(rel);
      expect(src, `${rel} uses fmtPublicDeadline`).toContain("fmtPublicDeadline");
      expect(src, `${rel} still hand-rolls a UTC deadline`).not.toMatch(/timeZone:\s*"UTC",\s*timeZoneName/);
      checked += 1;
    }
    expect(checked).toBe(DEADLINE_SURFACES.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("the pay page no longer carries its own money formatter (the shared one is the only one)", () => {
    expect(read("lib/registration-pay.ts")).not.toContain("payPageMoney");
    expect(read("components/registrations/pay-page-view.tsx")).not.toContain("payPageMoney");
  });
});
