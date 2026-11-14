// Walk-fix A review I1 - the register page fed by the REAL public panel (real Postgres; skipped without DATABASE_URL).
//
// register-page-closed.test.tsx hands the page a `closed_reason` it typed itself, so it cannot see which reason the server
// picks. The defect lived exactly there: a card division whose window had shut was closed as `payments_unavailable` while
// Connect could not charge, and the page turned that into "registration opens once the organiser finishes payment setup" -
// on a competition whose registration closed weeks ago. Here the producer is `publicRegistrationInfo` itself.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { sql } from "@/lib/db";
import { putRegistrationSettings } from "@/server/usecases/registrations";
import { SETTINGS_BASE, stripeRig } from "@/server/usecases/__tests__/_registration-fixtures";
import en from "@/dictionaries/en/ui.json";
import RegisterPage from "../page";

vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => "en" }));

const HAS_DB = !!process.env.DATABASE_URL;
const EN = en as Record<string, string>;
const unescape = (html: string) => html.replace(/&#x27;/g, "'").replace(/&amp;/g, "&");

describe.skipIf(!HAS_DB)("register page over the real panel - a card division while Connect cannot charge (walk-fix I1)", () => {
  it("window shut: the plain not-open line; window open: the card-payments sentence", async () => {
    const { orgId, orgSlug, owner, competition, division } = await stripeRig();
    const pageWith = async (window: { opens_at: string | null; closes_at: string | null }) => {
      // A card fee needs Connect to save; the page is read with charges off.
      await sql`update organizations set stripe_charges_enabled = true where id = ${orgId}`;
      await putRegistrationSettings(owner, division.id, { ...SETTINGS_BASE, payment_method: "stripe", fee_cents: 500, ...window });
      await sql`update organizations set stripe_charges_enabled = false where id = ${orgId}`;
      return unescape(
        renderToStaticMarkup(
          await RegisterPage({
            params: Promise.resolve({ orgSlug, competitionSlug: competition.slug }),
            searchParams: Promise.resolve({}),
          }),
        ),
      );
    };
    const cases = [
      { label: "closed in the past", window: { opens_at: null, closes_at: "2020-01-01T00:00:00Z" }, says: "register.notOpen", not: "register.cardPaymentsUnavailable" },
      { label: "open now", window: { opens_at: null, closes_at: null }, says: "register.cardPaymentsUnavailable", not: "register.notOpen" },
    ];
    let checked = 0;
    for (const c of cases) {
      const html = await pageWith(c.window);
      expect(EN[c.says], c.says).toBeTruthy();
      expect(html, c.label).toContain(EN[c.says]);
      expect(html, c.label).not.toContain(EN[c.not]);
      expect(html, c.label).not.toContain("<form");
      checked++;
    }
    expect(checked).toBe(cases.length);
  });
});
