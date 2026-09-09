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

function card(m: HubMatchT, now: number = NOW, opts: { showDivision?: boolean } = {}) {
  return renderToStaticMarkup(
    <MatchCard match={m} dict={dict} locale="en" now={now} showDivision={opts.showDivision ?? true} />,
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

  it("scheduled within 24h: 'Starts in 2 hours' from Intl.RelativeTimeFormat in the org locale; beyond 24h: the venue-zone DATE; unscheduled: no starts line at all", () => {
    // COUNTED, not merely contained. The card has two slots that can each
    // carry a time — the status slot top-right and this line bottom-right —
    // and the visual pass found them saying the same thing twice on two of
    // these three cases. `toContain("15:00")` and `toContain("Time TBD")`
    // passed in BOTH the duplicated and the fixed state, so they could not
    // witness the defect they sat next to. Counting can.
    const now = Date.parse("2026-09-05T12:00:00Z");
    const times = (h: string, s: string) => h.split(s).length - 1;

    const soon = card(
      hubMatch({ bucket: "upcoming", scheduledAt: "2026-09-05T14:00:00Z", tz: "Europe/London" }),
      now,
    );
    expect(soon).toMatch(/mh-match-starts[^<]*>Starts in 2 hours</);
    // The exact time still appears once, in the status slot: a relative
    // sentence alone would not tell a spectator when to turn up.
    expect(times(soon, "15:00")).toBe(1);

    const far = card(
      hubMatch({ bucket: "upcoming", scheduledAt: "2026-09-12T14:00:00Z", tz: "Europe/London" }),
      now,
    );
    expect(times(far, "15:00")).toBe(1); // BST, and stated ONCE
    expect(far).toMatch(/mh-match-starts[^<]*>Sat 12 Sep/); // the DATE is what this line adds
    expect(far).not.toMatch(/mh-match-starts[^<]*>[^<]*15:00/);

    const tbd = card(hubMatch({ bucket: "upcoming", scheduledAt: null }), now);
    expect(times(tbd, "Time TBD")).toBe(1); // status slot only
    expect(tbd).not.toContain(`data-testid="mh-match-starts"`);
  });

  it("the meta row wraps rather than truncating the venue behind a result line", () => {
    // A class assertion, and it is honest about its limit: `apps/web` vitest is
    // `environment: "node"`, so nothing here can see a line box. What this
    // pins is that the row is allowed to wrap at all — the layout itself was
    // verified in a browser at 320/360/390/768/1280 during the visual pass,
    // where the un-wrapped row truncated "Garon Park · Court 1" to
    // "Garon Park · …" with the ellipsis landing after the separator.
    const h = card(
      hubMatch({
        bucket: "completed",
        winnerIndex: 1,
        resultLine: "Queens Park won by 4 wickets",
        header: { status: "decided" },
      }),
    );
    expect(h).toMatch(/class="[^"]*flex-wrap[^"]*"[^>]*>\s*<span class="[^"]*truncate/);
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
