// Task 16 sign-off D10: the Fixtures tab's needs-result queue heading read "Online play — needs result" (an em dash) in all four
// locales. The house voice has no dash in a heading; the colon says the same thing. The heading is read where a person reads it,
// out of the rendered queue under each locale's own dictionary, so a key the component stops asking for cannot pass.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DictProvider } from "@/components/i18n/dict-provider";
import type { Dict } from "@/lib/i18n-constants";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { NEEDS_REASONS } from "@/server/external-play/types";
import { ExternalPlayNeedsResultQueue, type HeldRow } from "../external-play-needs-result-queue";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));

const LOCALES = { en, es, fr, nl } as const;
type Locale = keyof typeof LOCALES;

// Built from code points: a `\u` escape in a tool argument arrives as a raw control character.
const DASHES = [0x2013, 0x2014, 0x2015, 0x2212, 0x2192, 0x2190].map((c) => String.fromCharCode(c));

const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

const HELD: HeldRow = {
  fixtureId: "f1",
  reason: NEEDS_REASONS[0]!,
  homeName: "Rafael Quintero",
  awayName: "Mei Lin Chu",
  whiteSide: "home",
  revokedSeat: null,
  roundNo: 3,
  boardNo: 5,
  stageName: "Open Swiss",
  canResync: false,
  seated: false,
  noResultOffer: { kind: "void" },
};

function headingOf(locale: Locale): string {
  const h = renderToStaticMarkup(
    <DictProvider dict={LOCALES[locale] as unknown as Dict} locale={locale}>
      <ExternalPlayNeedsResultQueue held={[HELD]} flagged={[]} ownFlagged={0} />
    </DictProvider>,
  );
  const m = /<h2 id="external-play-queue-title"[^>]*>([^<]*)<\/h2>/.exec(h);
  if (!m) throw new Error("the queue rendered no title heading");
  return decode(m[1]!);
}

describe("the needs-result queue heading (sign-off D10)", () => {
  it("English reads the ruled wording: 'Online play: needs result'", () => {
    expect(headingOf("en")).toBe("Online play: needs result");
  });

  it("no locale's heading has a dash or an arrow, and each says it with a colon (checked: 4 locales)", () => {
    let checked = 0;
    for (const locale of Object.keys(LOCALES) as Locale[]) {
      const heading = headingOf(locale);
      expect(heading.length, `${locale}: a heading was read`).toBeGreaterThan(5);
      expect(heading, `${locale}: reads the dictionary's own value`).toBe(LOCALES[locale]["externalPlay.queue.title"]);
      for (const d of DASHES) expect(heading.includes(d), `${locale}: no U+${d.charCodeAt(0).toString(16)} in "${heading}"`).toBe(false);
      expect(heading, `${locale}: the colon carries the pause`).toContain(":");
      checked += 1;
    }
    expect(checked, "anti-vacuity: locales checked").toBe(4);
  });

  it("the four headings are four different sentences (a copy of English in a locale would pass the dash check alone)", () => {
    const all = (Object.keys(LOCALES) as Locale[]).map(headingOf);
    expect(new Set(all).size).toBe(4);
  });
});
