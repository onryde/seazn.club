// The playing-area noun reached the board's screens as an ENGLISH word in every locale: `schedule/page.tsx` hands the
// boards `venueLabel(sport)` ("Pitch"), and the panels fed it - lowercased, "pluralised" with an English "s" - into
// `{venue}` or straight into the JSX (settings-panel's collapsed summary, move-panel's label). A Dutch organiser read
// "Niet-toegewezen pitch". These render the REAL components under each non-English dictionary, for every noun, and read
// the word out of the markup. Expected words come from the dictionary's own `venue.noun.*` entries, never from the
// helper under test.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { registerBuiltins } from "@seazn/engine/sports";
import type { AnySportModule, SportRegistry } from "@seazn/engine/sport";
import { DictProvider } from "@/components/i18n/dict-provider";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { VENUE_NOUNS, venueLabel, venueNoun, type VenueNoun } from "@/lib/venue";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";
import type { Venue } from "@/components/v2/shared/court-multi-picker";
import { BoardGrid } from "../board-grid";
import { MovePanel } from "../move-panel";
import { CourtsPanel, SettingsPanel } from "../settings-panel";
import type { BoardConfig, BoardFixture } from "../types";

const capacityProps: Record<string, unknown>[] = [];
vi.mock("../capacity-card", () => ({
  CapacityCard: (p: Record<string, unknown>) => {
    capacityProps.push(p);
    return null;
  },
}));

type L = "es" | "fr" | "nl";
const NON_EN: [L, Dict][] = [
  ["es", esUi as Dict],
  ["fr", frUi as Dict],
  ["nl", nlUi as Dict],
];
const REC = (d: Dict) => d as unknown as Record<string, string>;
const word = (d: Dict, noun: VenueNoun, form: "singular" | "plural") => REC(d)[`venue.noun.${noun}.${form}`];
/** The noun the dictionary declares, lowercase, as it reads mid-sentence. */
const lower = (d: Dict, noun: VenueNoun, form: "singular" | "plural") => word(d, noun, form).toLowerCase();
const label = (noun: VenueNoun) => noun.charAt(0).toUpperCase() + noun.slice(1);
const fill = (s: string, vars: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k]));

function render(ui: ReactElement, dict: Dict, locale: Locale): string {
  return renderToStaticMarkup(
    <DictProvider dict={dict} locale={locale}>
      {ui}
    </DictProvider>,
  );
}

const SPORTS: string[] = [];
registerBuiltins({
  register(m: AnySportModule) {
    SPORTS.push(m.key);
  },
  get: () => {
    throw new Error("capture registry: get");
  },
} as unknown as SportRegistry);

const config = (courts: string[]): BoardConfig => ({
  startAt: "2026-08-10T09:00:00.000Z",
  endAt: null,
  matchMinutes: 40,
  gapMinutes: 5,
  courts,
  perEntrantMinRest: 0,
  blackouts: [],
  sessionWindows: [],
});

const gridProps = {
  day: "2026-08-10",
  slots: [Date.parse("2026-08-10T11:00:00.000Z")],
  slotMinutes: 30,
  fixtures: [],
  entrantNames: {},
  divisionNames: {},
  feedLabels: {},
  fixtureTitles: {},
  roundCodes: new Map(),
  conflictsByFixture: {},
  canEdit: true,
  multi: false,
  pickedId: null,
  onPick: () => {},
  onPlace: () => {},
  onDropCard: () => {},
  onTogglePin: () => {},
  highlightId: null,
  ghosts: null,
  courts: [] as string[],
};

const fixture: BoardFixture = {
  id: "fx-1",
  stage_id: "st-1",
  division_id: "dv-1",
  round_no: 1,
  seq_in_round: 1,
  home_entrant_id: null,
  away_entrant_id: null,
  scheduled_at: null,
  venue: null,
  court_label: null,
  court_id: null,
  court_name: null,
  status: "scheduled",
  schedule_source: "manual",
  schedule_locked: false,
  outcome: null,
};

function orgVenues(): Venue[] {
  const stamp = "2026-01-01T00:00:00.000Z";
  return [
    {
      id: "venue-1",
      name: "Riverside Centre",
      address: null,
      sort: 0,
      archived_at: null,
      created_at: stamp,
      courts: [
        { id: "court-1", venue_id: "venue-1", name: "Hall A", sort: 0, tags: [], archived_at: null, created_at: stamp },
        { id: "court-2", venue_id: "venue-1", name: "Hall B", sort: 1, tags: [], archived_at: null, created_at: stamp },
      ],
    },
  ];
}

describe("the board's unassigned column names the noun in the reader's language", () => {
  it("anti-vacuity: the registry yields sports", () => {
    expect(SPORTS.length).toBeGreaterThan(5);
  });

  it("every registered sport x locale: the dictionary's own phrase around the dictionary's own noun", () => {
    let checked = 0;
    for (const sport of SPORTS) {
      for (const [l, dict] of NON_EN) {
        const html = render(<BoardGrid {...gridProps} venueCap={venueLabel(sport)} />, dict, l);
        const want = fill(REC(dict)["board.grid.unassignedCol"], { venue: lower(dict, venueNoun(sport), "singular") });
        expect(html, `${sport}/${l}`).toContain(`>${want}</th>`);
        checked++;
      }
    }
    expect(checked).toBe(SPORTS.length * NON_EN.length);
  });

  it("English is unchanged: football's column is 'Unassigned pitch'", () => {
    expect(render(<BoardGrid {...gridProps} venueCap="Pitch" />, enUi as Dict, "en")).toContain(">Unassigned pitch</th>");
  });
});

describe("the move panel's label is the noun, not the English label it was handed", () => {
  it("every noun x locale", () => {
    let checked = 0;
    for (const noun of VENUE_NOUNS) {
      for (const [l, dict] of NON_EN) {
        const html = render(
          <MovePanel
            fixture={fixture}
            courts={["Court 1"]}
            entrantNames={{}}
            feedLabels={{}}
            venueCap={label(noun)}
            boardConfig={{ config: config(["Court 1"]), orgTz: "UTC" }}
            onMove={() => {}}
            onRemove={() => {}}
            onClose={() => {}}
          />,
          dict,
          l,
        );
        expect(html, `${noun}/${l}`).toContain(`<span class="label">${word(dict, noun, "singular")}</span>`);
        checked++;
      }
    }
    expect(checked).toBe(VENUE_NOUNS.length * NON_EN.length);
  });
});

describe("the Courts tab: heading, description and remove button speak the locale's noun", () => {
  it("every noun x locale", () => {
    let checked = 0;
    for (const noun of VENUE_NOUNS) {
      for (const [l, dict] of NON_EN) {
        const html = render(
          <CourtsPanel
            divisionId="div-1"
            config={config(["court-1", "court-2"])}
            canEdit
            venueCap={label(noun)}
            venues={orgVenues()}
            onSaved={() => {}}
            onError={() => {}}
          />,
          dict,
          l,
        );
        // The heading is the capitalised plural, on its own.
        expect(html, `${noun}/${l} heading`).toContain(`<span class="label">${word(dict, noun, "plural")}</span>`);
        // The description reads the lowercase plural mid-sentence.
        const desc = html.match(/<p class="mb-2 text-xs text-slate-400">([^<]*)<\/p>/)?.[1] ?? "";
        expect(desc, `${noun}/${l} description`).toContain(lower(dict, noun, "plural"));
        // The remove button reads the lowercase singular and the 1-based position.
        const remove = fill(REC(dict)["boardset.removeVenue"], { venue: lower(dict, noun, "singular"), n: 1 });
        expect(html, `${noun}/${l} remove`).toContain(`aria-label="${remove}"`);
        checked++;
      }
    }
    expect(checked).toBe(VENUE_NOUNS.length * NON_EN.length);
  });
});

describe("the settings panel", () => {
  it("collapsed summary: '(N <noun>, ...)' uses the locale's singular for one court and its plural for the rest", () => {
    let checked = 0;
    for (const noun of VENUE_NOUNS) {
      for (const [l, dict] of NON_EN) {
        for (const [courts, form] of [[["c1"], "singular"], [["c1", "c2"], "plural"]] as const) {
          const html = render(
            <SettingsPanel
              divisionId="div-1"
              config={config([...courts])}
              canEdit
              constraintsAllowed
              venueCap={label(noun)}
              orgTz="UTC"
              onSaved={() => {}}
              onError={() => {}}
              viewerPlan="community"
            />,
            dict,
            l,
          );
          expect(html, `${noun}/${l}/${courts.length}`).toContain(`(${courts.length} ${lower(dict, noun, form)}, `);
          checked++;
        }
      }
    }
    expect(checked).toBe(VENUE_NOUNS.length * NON_EN.length * 2);
  });

  it("English keeps its summary: '(2 pitches, ...' and '(1 court, ...'", () => {
    const sum = (venueCap: string, courts: string[]) =>
      render(
        <SettingsPanel divisionId="d" config={config(courts)} canEdit constraintsAllowed venueCap={venueCap} orgTz="UTC" onSaved={() => {}} onError={() => {}} viewerPlan="community" />,
        enUi as Dict,
        "en",
      );
    expect(sum("Pitch", ["a", "b"])).toContain("(2 pitches, ");
    expect(sum("Court", ["a"])).toContain("(1 court, ");
  });

  it("expanded: the turnaround hint and the capacity card both get the locale's lowercase singular", () => {
    let checked = 0;
    for (const noun of VENUE_NOUNS) {
      for (const [l, dict] of NON_EN) {
        capacityProps.length = 0;
        const html = render(
          <SettingsPanel
            divisionId="div-1"
            config={config(["court-1"])}
            canEdit
            constraintsAllowed
            venueCap={label(noun)}
            venues={orgVenues()}
            orgTz="UTC"
            defaultOpen
            onSaved={() => {}}
            onError={() => {}}
            viewerPlan="community"
          />,
          dict,
          l,
        );
        const want = lower(dict, noun, "singular");
        // The capacity card says "Add 1 <noun>" from this prop (its own word is not reachable in a static render).
        expect(capacityProps.length, `${noun}/${l}: the card mounted`).toBeGreaterThan(0);
        expect(capacityProps.at(-1)?.venueLabel, `${noun}/${l}`).toBe(want);
        // The turnaround hint is the dictionary's sentence around that noun.
        const hint = fill(REC(dict)["boardset.gapHint"], { venue: want }).replace(/'/g, "&#x27;");
        expect(html, `${noun}/${l} gap hint`).toContain(hint);
        checked++;
      }
    }
    expect(checked).toBe(VENUE_NOUNS.length * NON_EN.length);
  });
});
