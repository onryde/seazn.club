// Seazn-hosted video T47: the match-card scenes shared by `match-card-stream.test.tsx` and the golden it compares against. The golden
// (`__golden__/match-card-nostream.json`) holds each scene's markup as the card rendered it BEFORE the camera existed (generated once from
// the card at the commit before T47), so "a card with neither a stream nor a replay is exactly what it was" is a comparison with the old
// markup, never with the new code's own output.
import type { HubMatchT } from "@/server/public-site/competition-hub-schema";
import type { MatchCentreHeaderT } from "@/server/public-site/match-centre-schema";

export const SCENE_NOW = Date.parse("2026-09-05T12:00:00Z");

export function header(over: Partial<MatchCentreHeaderT> = {}): MatchCentreHeaderT {
  return {
    live: false, status: "scheduled",
    sides: [
      { entrantId: "e1", name: "Blue Blazers", short: "BLZ", colour: null, badgeUrl: null },
      { entrantId: "e2", name: "Queens", short: "QNS", colour: null, badgeUrl: null },
    ],
    scoreLines: [null, null], subLines: [null, null], battingIndex: null, statusLine: null, rateLine: null, phase: null, strength: null,
    pillNote: null, metaLine: null, updatedAt: "2026-09-05T12:00:00.000Z", ...over,
  };
}

export function hubMatch(over: Partial<Omit<HubMatchT, "header">> & { header?: Partial<MatchCentreHeaderT> } = {}): HubMatchT {
  const { header: h, ...rest } = over;
  return {
    fixtureId: "f1", divisionId: "d1", divisionSlug: "div-a", divisionName: "Division A", sportKey: "cricket", stageName: "League", roundNo: 3,
    roundLabel: null, bucket: "upcoming", tz: "Europe/London", scheduledAt: "2026-09-05T14:30:00.000Z", venueName: "Riverside Oval", courtName: "Court 1",
    href: "/riverside/autumn-cup/div-a/fixtures/f1", header: header(h), winnerIndex: null, resultLine: null, ...rest,
  };
}

/** The scenes: every arm of the card's status slot, and the forfeit chip (the one other thing `aria-describedby` points at). */
export const SCENES: Record<string, HubMatchT> = {
  upcoming: hubMatch(),
  upcomingNoTime: hubMatch({ fixtureId: "f2", scheduledAt: null }),
  live: hubMatch({ fixtureId: "f3", bucket: "live", header: { status: "in_play", live: true, scoreLines: ["56/6", "12/0"], subLines: ["(8.0)", "(2.1)"] } }),
  completed: hubMatch({ fixtureId: "f4", bucket: "completed", winnerIndex: 0, resultLine: "Blue Blazers won by 12 runs", header: { status: "decided", scoreLines: ["140/6", "128/9"] } }),
  forfeit: hubMatch({
    fixtureId: "f5", bucket: "completed", winnerIndex: 1, resultLine: "Queens won by walkover",
    forfeit: { kind: "forfeit", tag: "w/o", sentence: "Blue Blazers forfeited; Queens were awarded the match" },
  }),
  expunged: hubMatch({ fixtureId: "f6", bucket: "completed", expunged: true }),
};
