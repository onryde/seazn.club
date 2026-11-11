// The AI side's markup (components/billing-credits.tsx). One thing is pinned here: the "Invite & earn" referral card is
// hidden (owner, 2026-11-11). Its copy is gone from the dictionaries and its reads from the view model (credits-tab.ts,
// pinned by its own "reads no referral data" test), so the card is asserted absent by its markup — `data-referral` and
// the `/refer/` link — in every locale. The /refer route and the referral grants are untouched.
//
// Expected strings come from the dictionary FILES read off disk, never from the component's own keys.
//
// Mutant table (applied once by hand):
//   A1 referral card   restore the `data-referral` section   → "the AI side shows no Invite & earn card"
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { getDictionary } from "@/lib/i18n";
import type { CreditsTabView } from "@/server/usecases/credits-tab";

// The pack button is a client island with its own checkout; it is not what this file is about.
vi.mock("@/components/buy-credits", () => ({ BuyCredits: () => <button type="button" data-buy-credits /> }));

import { BillingCredits } from "@/components/billing-credits";

const LOCALES = ["en", "nl", "fr", "es"] as const;
const dictFile = (loc: string): Record<string, string> =>
  JSON.parse(readFileSync(path.join(process.cwd(), "src/dictionaries", loc, "ui.json"), "utf8"));
const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#x27;");

const VIEW: CreditsTabView = {
  balance: 42,
  grantUsed: 3,
  grantCap: 10,
  grantResetsInDays: 12,
  packBalance: 35,
  sharedOrgCount: 1,
  history: [],
};

async function markup(loc: (typeof LOCALES)[number]): Promise<string> {
  const dict = await getDictionary(loc, "ui");
  return renderToStaticMarkup(
    <BillingCredits view={VIEW} dict={dict} locale={loc} exportHref="/o/riverside/settings/billing/credits.csv" packs={[]} currency="gbp" />,
  );
}

describe("Settings → Credits → AI", () => {
  it("the AI side shows no Invite & earn card, in any locale (A1)", async () => {
    let checked = 0;
    for (const loc of LOCALES) {
      const out = await markup(loc);
      const file = dictFile(loc);
      expect(out, loc).not.toContain("data-referral");
      expect(out, loc).not.toContain('href="/refer/');
      // The card's copy left the dictionaries with it.
      expect(Object.keys(file).filter((k) => k.startsWith("billing.credits.referral.")), loc).toEqual([]);
      // positive pair: the wallet card itself is still there, with its title
      expect(out, loc).toContain("data-credits");
      expect(out, loc).toContain(esc(file["billing.credits.title"]!));
      checked++;
    }
    expect(checked, "anti-vacuity: all four locales were rendered").toBe(4);
  });
});
