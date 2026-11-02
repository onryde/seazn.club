import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { registerBuiltins } from "@seazn/engine/sports";
import type { AnySportModule, SportRegistry } from "@seazn/engine/sport";
import { StagesPanel } from "@/components/v2/stages-panel";
import { isChessSport } from "@/lib/chess-individual-only-rule";
import { messages } from "@/lib/messages";
import { routes } from "@/lib/routes";
import { VENUE_NOUNS, venueNoun } from "@/lib/venue";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => vi.fn(async () => false) }));
vi.mock("@/components/ui/tip", () => ({ TipCallout: ({ id }: { id: string }) => <div data-tip={id} /> }));

// Match Day B2, fix round 1 (I1): "Find a court" read "court" for every sport. The run sheet is mounted by the stage panel, and
// the panel knows the division's sport (`sportKey`), so the noun is chosen HERE (`lib/venue.ts`'s `venueNoun`, the convention
// Match Day's own headers use) and carried to the row. This renders the REAL panel, which mounts the real run sheet and rows,
// so the word read is the one an organiser sees - not a prop handed to a row by the test.

const MATCH_DAY = routes.competitionMatchDay("org", "comp");
const key = (noun: string) => `runsheet.action.findCourt.${noun}` as keyof typeof messages;

/** Every sport the engine registers (never a list typed here: a new sport joins the sweep by registering). */
const SPORTS: string[] = [];
registerBuiltins({
  register(m: AnySportModule) {
    SPORTS.push(m.key);
  },
  get: () => {
    throw new Error("capture registry: get");
  },
  latest: () => {
    throw new Error("capture registry: latest");
  },
} as SportRegistry);

const stage = { id: "s1", seq: 1, kind: "league", name: "League", config: {}, progression: null, status: "active" };
const fixture = (no: number, o: Record<string, unknown> = {}) => ({
  id: `f${no}`, stage_id: "s1", pool_id: null, round_no: 1, seq_in_round: no, fixture_no: no,
  home_entrant_id: "e1", away_entrant_id: "e2", scheduled_at: null as string | null, venue: null, court_label: null,
  court_id: null, court_name: null, status: "scheduled", outcome: null as unknown, ...o,
});
// Two open unscheduled matches (the pile) and one that already has a time (never asked for a court).
const FIXTURES = [fixture(1), fixture(2), fixture(3, { scheduled_at: "2026-09-05T10:00:00.000Z" })];
const PROPS = {
  divisionId: "d1", competitionId: "c1", orgSlug: "org", compSlug: "comp", divSlug: "div",
  stages: [stage], fixtures: FIXTURES, entrantNames: { e1: "Alpha", e2: "Bravo" },
  canEdit: true, tz: "UTC", orgTz: "UTC", canExport: false, viewerPlan: "community" as const,
};

/** The text of every Find link the panel drew (the link is `<a ... data-testid="run-sheet-find-court" ...>TEXT</a>`). */
function findLabels(html: string): string[] {
  return [...html.matchAll(/<a [^>]*data-testid="run-sheet-find-court"[^>]*>([^<]*)<\/a>/g)].map((m) => m[1]!);
}
const panel = (sportKey: string | undefined, matchDayHref: string | null = MATCH_DAY) =>
  renderToStaticMarkup(<StagesPanel {...PROPS} sportKey={sportKey} matchDayHref={matchDayHref} />);

describe("the panel hands the row the sport's playing-area word", () => {
  // The empty case first: not a match day draws no link at all, whatever the sport.
  it("not a match day: no link in any sport's panel", () => {
    expect(SPORTS.length).toBeGreaterThan(5);
    let checked = 0;
    for (const sport of SPORTS) {
      expect(findLabels(panel(sport, null)), sport).toEqual([]);
      checked += 1;
    }
    expect(checked).toBe(SPORTS.length);
  });

  it("football's pitch is asked for as a pitch, and a chess game's board as a board", () => {
    const pitch = messages[key("pitch")];
    const board = messages[key("board")];
    const court = messages[key("court")];
    // The premises these cases stand on, read off the repo's own declarations.
    expect(venueNoun("football")).toBe("pitch");
    expect(isChessSport("boardgame")).toBe(true);
    expect(venueNoun("boardgame")).toBe("board");
    expect(new Set([pitch, board, court]).size, "three different sentences").toBe(3);
    // Two open unscheduled matches: two links, each the sport's own.
    expect(findLabels(panel("football"))).toEqual([pitch, pitch]);
    // `boardgame` is the sport key a chess division carries.
    expect(findLabels(panel("boardgame"))).toEqual([board, board]);
  });

  it("an absent sport reads the court, `venueNoun`'s own default", () => {
    expect(findLabels(panel(undefined))).toEqual([messages[key("court")], messages[key("court")]]);
  });

  it("every registered sport: its links read the dictionary string for ITS noun, and every noun is exercised", () => {
    let checked = 0;
    const nouns = new Set<string>();
    for (const sport of SPORTS) {
      const noun = venueNoun(sport);
      nouns.add(noun);
      const want = messages[key(noun)];
      expect(want, `${sport}: ${noun} has an English string`).toBeTruthy();
      expect(findLabels(panel(sport)), sport).toEqual([want, want]);
      checked += 1;
    }
    expect(checked).toBe(SPORTS.length);
    // The sweep can witness a hard-coded "court": more than one noun is in play across the registry.
    expect(nouns.size, `nouns reached: ${[...nouns].join(",")}`).toBeGreaterThan(2);
    for (const n of nouns) expect(VENUE_NOUNS as readonly string[]).toContain(n);
  });
});
