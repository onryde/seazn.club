// Scoring-defects fix round 1, m6. The signed-audit lock's explanation used to live in a `title` on a plain span: nothing a
// touch screen or a keyboard can reach. It is now text on the page, in every locale. Rendered through the real component
// and the real dictionaries, so the string on screen is the one the dictionary holds.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { DictProvider } from "@/components/i18n/dict-provider";
import { AuditStrip } from "@/components/v2/audit-strip";
import type { Locale } from "@/lib/i18n-constants";

const DICTS = { en, es, fr, nl } as Record<Locale, Record<string, string>>;
const html = (locale: Locale, entitled: boolean) =>
  renderToStaticMarkup(
    <DictProvider dict={DICTS[locale] as never} locale={locale}>
      <AuditStrip fixtureId="fx-1" verified tamperedSeq={null} entitled={entitled} />
    </DictProvider>,
  );
const unescape = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

describe("AuditStrip — the lock says what unlocks the download, on the page", () => {
  it("a locked strip shows the hint as text in every locale, and carries it in no tooltip", () => {
    let checked = 0;
    for (const loc of Object.keys(DICTS) as Locale[]) {
      const out = html(loc, false);
      const hint = DICTS[loc]["audit.proHint"]!;
      expect(hint.length, `${loc}: the dictionary has the hint`).toBeGreaterThan(20);
      expect(unescape(out), `${loc} the hint is text in the markup`).toContain(`data-testid="audit-pro-hint">${hint}</p>`);
      expect(out, `${loc} no title attribute carries it`).not.toMatch(/title="/);
      expect(unescape(out), `${loc} the label is still there`).toContain(DICTS[loc]["audit.pro"]!);
      checked += 1;
    }
    expect(checked, "anti-vacuity: four locales").toBe(4);
  });

  it("the negative pair: an entitled strip offers the download and shows no lock hint", () => {
    const out = html("en", true);
    expect(out).toContain("/api/v1/fixtures/fx-1/audit");
    expect(out).not.toContain("audit-pro-hint");
  });
});
