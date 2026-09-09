// Spectator surface W2, Task 7 — `MatchCard`'s static-markup contract
// (brief's own Step 4 test, verbatim where the brief is right, plus dispatch
// ruling 5's fix and its own positive pair). A W1 `CourtCard`
// (`match-centre/court-card.tsx`) variant: same "already resolved by the
// builder" convention (every `Msg` goes through `t()`, every timestamp
// through `fmtDate`/`fmtTime` with the fixture's OWN `tz`), same
// `min-w-0`/`truncate` ancestor-chain discipline (AGENTS.md).
//
// Dispatch ruling 5 — `roundLabel` is null whenever the round has no role
// beyond its number (schema comment, `competition-hub-schema.ts:86-89`),
// which is the COMMON case. The brief's own meta line
// (`[stageName, roundLabel].filter(Boolean).join(" · ")`) silently drops the
// round on every one of those matches, and `matchesHub.round` ("Round
// {round}") would have no consumer at all. `MatchCard` renders `roundLabel`
// when present and `t(dict, "matchesHub.round", { round })` when it is null
// — tested as a positive pair below.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";
import type { HubMatchT } from "@/server/public-site/competition-hub-schema";
import type { MatchCentreHeaderT } from "@/server/public-site/match-centre-schema";
import { MatchCard } from "../matches-hub/match-card";

const dict = en as Dict;
const NOW = Date.parse("2026-09-05T12:00:00Z");

function baseHeader(overrides: Partial<MatchCentreHeaderT> = {}): MatchCentreHeaderT {
  return {
    live: false,
    status: "scheduled",
    sides: [
      { entrantId: "e1", name: "Blue Blazers", short: "BLZ", colour: null, badgeUrl: null },
      { entrantId: "e2", name: "Queens", short: "QNS", colour: null, badgeUrl: null },
    ],
    scoreLines: [null, null],
    subLines: [null, null],
    battingIndex: null,
    statusLine: null,
    rateLine: null,
    phase: null,
    strength: null,
    updatedAt: "2026-09-05T12:00:00.000Z",
    ...overrides,
  };
}

function hubMatch(
  overrides: Partial<Omit<HubMatchT, "header">> & { header?: Partial<MatchCentreHeaderT> } = {},
): HubMatchT {
  const { header: headerOverrides, ...rest } = overrides;
  return {
    fixtureId: "f1",
    divisionId: "d1",
    divisionSlug: "div-a",
    divisionName: "Division A",
    sportKey: "cricket",
    stageName: "League",
    roundNo: 3,
    roundLabel: null,
    bucket: "upcoming",
    tz: "Europe/London",
    scheduledAt: null,
    venueName: "Riverside Oval",
    courtName: "Court 1",
    href: "/riverside/autumn-cup/div-a/fixtures/f1",
    header: baseHeader(headerOverrides),
    winnerIndex: null,
    resultLine: null,
    ...rest,
  };
}

function card(m: HubMatchT, now: number = NOW, opts: { showDivision?: boolean; compact?: boolean } = {}) {
  return renderToStaticMarkup(
    <MatchCard match={m} dict={dict} locale="en" now={now} showDivision={opts.showDivision ?? true} compact={opts.compact} />,
  );
}

describe("MatchCard", () => {
  const live = hubMatch({
    bucket: "live",
    header: { status: "in_play", live: true, scoreLines: ["56/6", "12/0"], subLines: ["(8.0)", "(2.1)"] },
  });

  it("live: LIVE pill, both score lines with sub-lines, division chip, venue/court, links to the match centre", () => {
    const h = card(live);
    expect(h).toContain(`data-testid="mh-match-${live.fixtureId}"`);
    expect(h).toContain(`href="${live.href}"`);
    expect(h).toContain(`data-testid="mh-match-live"`);
    expect(h).toContain("56/6");
    expect(h).toContain("(2.1)");
    expect(h).toContain(`data-testid="mh-match-division"`);
    expect(h).toContain("Court 1");
  });

  it("decided: the result line and the winner row in bold; no LIVE pill; no relative time (positive pair with scheduled)", () => {
    const h = card(
      hubMatch({ bucket: "completed", winnerIndex: 1, resultLine: "Queens won by 4 wickets", header: { status: "decided" } }),
    );
    expect(h).toContain("Queens won by 4 wickets");
    expect(h).toMatch(/data-testid="mh-match-side-1"[^>]*data-winner="true"/);
    expect(h).not.toContain(`data-testid="mh-match-live"`);
    expect(h).not.toContain(`data-testid="mh-match-starts"`);
  });

  it("scheduled within 24h: 'Starts in 2 hours' from Intl.RelativeTimeFormat in the org locale; beyond 24h: the venue-zone date+time; unscheduled: Time TBD", () => {
    const now = Date.parse("2026-09-05T12:00:00Z");
    expect(
      card(hubMatch({ bucket: "upcoming", scheduledAt: "2026-09-05T14:00:00Z", tz: "Europe/London" }), now),
    ).toMatch(/mh-match-starts[^<]*>Starts in 2 hours</);
    expect(
      card(hubMatch({ bucket: "upcoming", scheduledAt: "2026-09-12T14:00:00Z", tz: "Europe/London" }), now),
    ).toContain("15:00"); // BST
    expect(card(hubMatch({ bucket: "upcoming", scheduledAt: null }), now)).toContain("Time TBD");
  });

  it("meta line shows roundLabel when present, and a 'Round N' fallback from the round number when it is null (positive pair)", () => {
    const withLabel = card(hubMatch({ stageName: "Playoffs", roundLabel: "Semi-final", roundNo: 3 }));
    expect(withLabel).toContain("Playoffs · Semi-final");

    const withoutLabel = card(hubMatch({ stageName: "League", roundLabel: null, roundNo: 4 }));
    expect(withoutLabel).toContain("League · Round 4");
  });

  it("a 43-character side name renders in a min-w-0 truncate cell with a title; a TBD side (entrantId '') renders its slot label, never blank", () => {
    const longName = "A".repeat(43);
    const h = card(
      hubMatch({
        header: {
          sides: [
            { entrantId: "", name: "Winner of SF1", short: "SF1", colour: null, badgeUrl: null },
            { entrantId: "e2", name: longName, short: "LNG", colour: null, badgeUrl: null },
          ],
        },
      }),
    );
    // Mutant (a), Step 7: drop `min-w-0` from the name span — this regex
    // reds only if it asserts the CLASS itself, not merely the text.
    expect(h).toMatch(/class="[^"]*min-w-0[^"]*truncate[^"]*"[^>]*title="Winner of SF1"/);
    expect(h).toContain(longName);
    expect(h).toContain("Winner of SF1");
    expect(h).not.toContain('title=""');
  });

  it("crest: img when badgeUrl; initials otherwise (never an empty tile)", () => {
    const withBadge = card(
      hubMatch({
        header: {
          sides: [
            { entrantId: "e1", name: "Blue Blazers", short: "BLZ", colour: null, badgeUrl: "https://x/b.png" },
            { entrantId: "e2", name: "Queens", short: "QNS", colour: null, badgeUrl: null },
          ],
        },
      }),
    );
    expect(withBadge).toContain('src="https://x/b.png"');

    const withoutBadge = card(
      hubMatch({
        header: {
          sides: [
            { entrantId: "e1", name: "Blue Blazers", short: "BLZ", colour: null, badgeUrl: null },
            { entrantId: "e2", name: "Queens", short: "QNS", colour: null, badgeUrl: null },
          ],
        },
      }),
    );
    expect(withoutBadge).toContain(">BB<");
  });
});
