// W4 app B, B5b Task 13 (X-CH-4; owner pick 3A) - the match page's result line for a final the organiser ruled joint winners.
// Such a final is decided with NO outcome, so `resultMsg` names no winner and the line was empty. It now says "Joint winners"
// (the division banner's own `title.joint`), in all four locales; every other decided fixture keeps its own line.
import { describe, expect, it } from "vitest";
import { buildMatchCentre, type MatchCentreInput } from "../match-centre";
import type { PublicFixture } from "../data";
import type { SideT } from "../match-centre-schema";
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";

const DICTS = { en, es, fr, nl } as unknown as Record<string, Dict>;
const SIDES: [SideT, SideT] = [
  { entrantId: "e1", name: "Riverside FC", short: "RIV", colour: null, badgeUrl: null },
  { entrantId: "e2", name: "Summit Athletic", short: "SUM", colour: null, badgeUrl: null },
];

function line(fixture: Partial<PublicFixture> & Record<string, unknown>) {
  const input: MatchCentreInput = {
    fixture: {
      id: "fx1", division_id: "d1", stage_id: "s1", pool_id: null, round_no: 2, seq_in_round: 1,
      home_entrant_id: "e1", away_entrant_id: "e2", home_slot_label: null, away_slot_label: null,
      scheduled_at: "2026-11-10T09:00:00.000Z", venue: null, court_label: null, venue_name: null, court_name: null,
      status: "decided", outcome: null, summary: null, last_seq: null, is_final: true, third_place: false, joint_winners_at: null, ...fixture,
    } as PublicFixture,
    sportKey: "football", cfg: {} as never, events: [], lineups: { home: [], away: [] }, sides: SIDES, venueTz: "UTC", locale: "en",
    now: new Date("2026-11-10T12:00:00.000Z"), hrefs: { division: "/d", competition: "/c", calendar: null }, stage: null,
    moduleVersion: null, formatLabel: null,
  };
  return buildMatchCentre(input).header.statusLine;
}

describe("match centre: a joint final's status line", () => {
  it("empty case first: a decided final with no ruling and no outcome has no line (nothing invented)", () => {
    expect(line({})).toBeNull();
  });

  it("a ruled final reads 'Joint winners' in every locale, the dictionary's own words", () => {
    const l = line({ joint_winners_at: "2026-11-10T11:00:00.000Z" });
    expect(l).toEqual({ key: "title.joint" });
    let checked = 0;
    for (const [loc, dict] of Object.entries(DICTS)) {
      const text = t(dict, l!.key, l!.params);
      expect(text, loc).toBe((dict as unknown as Record<string, string>)["title.joint"]);
      expect(text.length, loc).toBeGreaterThan(0);
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("the negative pairs: a ruling on a semi-final, a final with a winner, and an unplayed ruled-looking final keep their own line", () => {
    expect(line({ joint_winners_at: "2026-11-10T11:00:00.000Z", is_final: false }), "a semi").toBeNull();
    const won = line({ outcome: { kind: "win", winner: "e1", loser: "e2" } as never });
    expect(won, "a winner").toEqual({ key: "matchCentre.result.regulation", params: { winner: "Riverside FC" } });
    expect(line({ status: "scheduled", joint_winners_at: "2026-11-10T11:00:00.000Z" }), "unsettled").not.toEqual({ key: "title.joint" });
  });
});
