// The builder's Schedule fold read the sport's playing-area noun as an ENGLISH word in every locale: a Dutch organiser
// building a football division saw "Kies de pitches die dit schema mag gebruiken" and, on a free plan, "Eén pitch -
// parallelle pitchs zijn uitgeschakeld" (the English plural "s" was baked into the copy). This renders the REAL builder
// under each non-English dictionary for a sport of each noun, and reads the words out of the markup. Expected words come
// from the dictionary's own `venue.noun.*` entries.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DivisionBuilder, type SportOption } from "@/components/v2/division-builder";
import { DictProvider } from "@/components/i18n/dict-provider";
import { engineEntrantChoice } from "@/lib/__tests__/_engine-entrant-kinds";
import { VENUE_NOUNS, venueNoun, type VenueNoun } from "@/lib/venue";
import type { Venue } from "@/components/v2/shared/court-multi-picker";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";
import type { Dict, Locale } from "@/lib/i18n-constants";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/o/org/c/comp/d/new",
}));

const REC = (d: Dict) => d as unknown as Record<string, string>;
const word = (d: Dict, noun: VenueNoun, form: "singular" | "plural") => REC(d)[`venue.noun.${noun}.${form}`];
const NON_EN: [Locale, Dict][] = [
  ["es", esUi as Dict],
  ["fr", frUi as Dict],
  ["nl", nlUi as Dict],
];
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const fill = (s: string, vars: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k]));

// One sport per noun, and each proves its own noun through venueNoun (never a pairing typed here that the code could contradict).
const SPORT_FOR: Record<VenueNoun, string> = { court: "badminton", pitch: "football", table: "tabletennis", board: "chess", rink: "icehockey" };

function sportsFor(key: string): SportOption[] {
  return [{ key, name: key, variants: [{ key: "std", name: "Standard", system: true }], entrants: engineEntrantChoice("generic") }];
}

function orgVenues(): Venue[] {
  const stamp = "2026-01-01T00:00:00.000Z";
  return [
    {
      id: "venue-1", name: "Riverside Centre", address: null, sort: 0, archived_at: null, created_at: stamp,
      courts: [{ id: "court-1", venue_id: "venue-1", name: "Hall A", sort: 0, tags: [], archived_at: null, created_at: stamp }],
    },
  ];
}

function render(dict: Dict, locale: Locale, sportKey: string): string {
  return renderToStaticMarkup(
    <DictProvider dict={dict} locale={locale}>
      <DivisionBuilder competitionId="c1" orgSlug="org" compSlug="comp" sports={sportsFor(sportKey)} venues={orgVenues()} constraintsAllowed={false} viewerPlan="community" />
    </DictProvider>,
  );
}

describe("the division builder's Schedule fold names the venue in the reader's language", () => {
  it("anti-vacuity: one sport per noun, and the pairing is the engine-facing helper's own", () => {
    expect(Object.keys(SPORT_FOR).length).toBe(VENUE_NOUNS.length);
    for (const noun of VENUE_NOUNS) expect(venueNoun(SPORT_FOR[noun]), noun).toBe(noun);
  });

  it("every noun x locale: heading and the free-plan hint carry the locale's noun and the plural is its own word", () => {
    let checked = 0;
    for (const noun of VENUE_NOUNS) {
      for (const [l, dict] of NON_EN) {
        const html = render(dict, l, SPORT_FOR[noun]);
        const plural = word(dict, noun, "plural");
        const singular = word(dict, noun, "singular");
        // The picker's heading: the capitalised plural, on its own.
        expect(html, `${noun}/${l} heading`).toContain(`<span class="label">${plural}</span>`);
        // The free-plan hint: the dictionary's sentence around the singular and the plural.
        const hint = escapeHtml(fill(REC(dict)["wizard.venuesProHint"], { venue: singular.toLowerCase(), venues: plural.toLowerCase() }));
        expect(html, `${noun}/${l} pro hint`).toContain(hint);
        // No placeholder survives the interpolation.
        expect(html, `${noun}/${l}`).not.toMatch(/\{venues?\}/);
        checked++;
      }
    }
    expect(checked).toBe(VENUE_NOUNS.length * NON_EN.length);
  });

  it("English: a football division's hint says 'parallel pitches', not the 'pitchs' the baked-in s produced", () => {
    const html = render(enUi as Dict, "en", SPORT_FOR.pitch);
    expect(html).toContain("One pitch only");
    expect(html).toContain("parallel pitches are switched off");
    expect(html).not.toContain("pitchs");
  });
});
