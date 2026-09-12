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
import { autoColour } from "@/components/ui/entity-logo";
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
    pillNote: null,
    metaLine: null,
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

// `showDivision` and `crestSize` are passed STRAIGHT THROUGH, never `?? …`.
// The helper used to substitute its own default for `showDivision`, so every
// test rendered the chip-visible arm while the component itself defaulted to
// hidden — the fixture picked the arm and the real default went unwitnessed in
// both directions. Now an omitted prop here is an omitted prop there, so the
// live test below is what proves the default and the explicit test proves the
// other arm. `crestSize` follows the same rule for the same reason.
function card(
  m: HubMatchT,
  now: number = NOW,
  opts: { showDivision?: boolean; crestSize?: 24 | 32 } = {},
) {
  return renderToStaticMarkup(
    <MatchCard
      match={m}
      dict={dict}
      locale="en"
      now={now}
      showDivision={opts.showDivision}
      crestSize={opts.crestSize}
    />,
  );
}

/** One side row's markup — from its testid to whatever follows it, the other
 *  side row or the card's footer row. A negative assertion read off the whole
 *  card passes on a card that says the same thing somewhere else (Task 9
 *  review F4), and "this side is NOT painted" is exactly that shape. */
const sideHtml = (h: string, i: 0 | 1): string => {
  const at = h.indexOf(`data-testid="mh-match-side-${i}"`);
  expect(at, `side ${i} is in the markup`).toBeGreaterThan(-1);
  const ends = [
    h.indexOf(`data-testid="mh-match-side-`, at + 1),
    h.indexOf(`class="mt-2 flex`, at + 1),
  ].filter((x) => x > -1);
  return h.slice(at, ends.length > 0 ? Math.min(...ends) : h.length);
};

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
    // This is now also the DEFAULT's own witness — `card()` passes no
    // `showDivision` at all (see the helper), so the chip being here proves
    // the component defaults to showing it. Flip `showDivision = true` to
    // `false` in the destructure and this line reds.
    expect(h).toContain(`data-testid="mh-match-division"`);
    expect(h).toContain("Court 1");
  });

  it("showDivision={false} drops the chip entirely (the arm a division page needs, and the one no test took)", () => {
    const h = card(live, NOW, { showDivision: false });
    expect(h).not.toContain(`data-testid="mh-match-division"`);
    // A positive pair, so this cannot pass by rendering nothing at all: the
    // rest of the meta row is untouched.
    expect(h).toContain(`data-testid="mh-match-live"`);
    expect(h).not.toContain("Division A");
  });

  it("the accessible name NAMES THE TWO SIDES — the `aria-label` on the wrapping <a> replaces everything inside it", () => {
    // `matchesHub.card.label` shipped as the bare noun "Match card" in all
    // four locales while `MatchCard` already passed `{home, away}`;
    // `interpolate()` drops vars with no matching `{param}` silently, so a
    // screen-reader link list over a 40-match hub announced "Match card,
    // link" forty times. Three gates passed it: the dictionary parity test
    // compares es/fr/nl against EN and EN had zero placeholders,
    // `check-parity.ts` compares key SETS only, and nothing here asserted the
    // attribute. This asserts the RENDERED attribute, which is the only thing
    // that can tell a template from a noun.
    const h = card(live);
    expect(h).toContain('aria-label="Blue Blazers v Queens"');
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

  // The sub-hour arm, which no test executed. `Math.round(Δ/3_600_000) ||
  // Math.round(Δ/60_000)` picked the VALUE and `|Δ| >= 3_600_000 ? "hour" :
  // "minute"` picked the UNIT independently, and they disagree across the
  // entire [30min, 60min) band: the hour-rounded value is 1 there (JS rounds
  // .5 up), which is truthy, so the minutes fallback never engaged while the
  // unit stayed "minute". Every match half an hour to an hour away read
  // "Starts in 1 minute" — the exact window a spectator uses to decide
  // whether to leave for the ground — and 30/40/45/59 were all measured
  // saying it. The suite's only relative case was 2 hours, where the two
  // decisions happen to agree.
  //
  // Expectations come from `Intl.RelativeTimeFormat` itself, never a table of
  // sentences typed in here, so a locale-data change moves the test with the
  // product. The UNIT column is stated, because the unit boundary IS what is
  // under test.
  it("the relative sentence takes its value from the unit it names: 30/45/59 minutes read as minutes, not '1 minute'", () => {
    const rtf = new Intl.RelativeTimeFormat("en", { numeric: "always" });
    const rows: { minutes: number; unit: "hour" | "minute" }[] = [
      { minutes: 29, unit: "minute" }, // was already right
      { minutes: 30, unit: "minute" }, // the boundary the old `||` broke
      { minutes: 45, unit: "minute" },
      { minutes: 59, unit: "minute" }, // last minute before the unit flips
      { minutes: 60, unit: "hour" }, // was already right
      { minutes: 120, unit: "hour" },
      { minutes: -20, unit: "minute" }, // past its slot, still bucketed upcoming
    ];
    for (const { minutes, unit } of rows) {
      const h = card(
        hubMatch({
          bucket: "upcoming",
          scheduledAt: new Date(NOW + minutes * 60_000).toISOString(),
          tz: "Europe/London",
        }),
      );
      const expected = rtf.format(unit === "hour" ? minutes / 60 : minutes, unit);
      expect(h, `${minutes} minutes away`).toMatch(
        new RegExp(`mh-match-starts[^<]*>Starts ${expected}<`),
      );
    }
  });

  // A match that was CALLED OFF, which is the case the card was silent about.
  // `resultLine` cannot cover any of these: it is gated on
  // `status === "decided"` and abandoned / forfeited / cancelled all map to
  // `other` (`match-centre.ts:692-705`), so the card showed "Ended" and an
  // empty line where the reason belongs.
  describe("a called-off match says so", () => {
    const calledOff = (fixtureStatus: string, extra: Partial<HubMatchT> = {}) =>
      card(
        hubMatch({
          bucket: "completed",
          ...extra,
          header: {
            status: "other",
            statusLine: { key: `matchCentre.status.${fixtureStatus}` },
            ...(extra.header as Partial<MatchCentreHeaderT>),
          },
        }),
      );

    it("abandoned reads 'Abandoned', not a blank where the result would be", () => {
      const h = calledOff("abandoned");
      expect(h).toContain(`data-testid="mh-match-status"`);
      expect(h).toContain("Abandoned");
    });

    it("a FORFEITED match names the forfeit beside its bolded winner (the worst silent case)", () => {
      // `winnerIndex` is taken straight off `winner_entrant_id` and is NOT
      // gated on status, so before this the card bolded one side and gave no
      // reason at all — it read as an ordinary win.
      const h = calledOff("forfeited", { winnerIndex: 1 });
      expect(h).toMatch(/data-testid="mh-match-side-1"[^>]*data-winner="true"/);
      expect(h).toContain("Forfeited");
    });

    it("cancelled reads 'Cancelled'", () => {
      expect(calledOff("cancelled")).toContain("Cancelled");
    });

    it("POSTPONED beats the countdown: it is not terminal, so it sits in Upcoming carrying its OLD kick-off time", () => {
      // `bucketFixture` treats `postponed` as non-terminal, so the fixture
      // stays in Upcoming with a `scheduledAt` nobody is playing to. Showing
      // "Starts in 2 hours" there is worse than showing nothing.
      const h = card(
        hubMatch({
          bucket: "upcoming",
          scheduledAt: "2026-09-05T14:00:00Z",
          tz: "Europe/London",
          header: { status: "other", statusLine: { key: "matchCentre.status.postponed" } },
        }),
        Date.parse("2026-09-05T12:00:00Z"),
      );
      expect(h).toContain("Postponed");
      expect(h).not.toContain(`data-testid="mh-match-starts"`);
      expect(h).not.toContain("Starts in 2 hours");
    });

    it("a DECIDED match still shows its result sentence, not a status word (positive pair — the result outranks the status line)", () => {
      const h = card(
        hubMatch({
          bucket: "completed",
          winnerIndex: 1,
          resultLine: "Queens won by 4 wickets",
          header: { status: "decided", statusLine: null },
        }),
      );
      expect(h).toContain("Queens won by 4 wickets");
      expect(h).not.toContain(`data-testid="mh-match-status"`);
    });
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

  it("meta line shows roundLabel when present, and a bare 'Round N' fallback from the round number when it is null (positive pair)", () => {
    const withLabel = card(hubMatch({ stageName: "Playoffs", roundLabel: "Semi-final", roundNo: 3 }));
    expect(withLabel).toContain("Playoffs · Semi-final");

    // `stageName: ""`, not "League". `competition-hub.ts:501,515` hangs BOTH
    // fields off the same `stage` (`stageName: stage?.name ?? ""`,
    // `roundLabel: stage ? roundRoleLabel(…) : null`), so a null `roundLabel`
    // IMPLIES an empty `stageName` — the builder cannot produce the
    // "League" + null pairing this fixture used to assert, and the sentence
    // it pinned ("League · Round 4") is unreachable in production. The branch
    // was genuinely exercised; the expected VALUE was a document nobody can
    // hit, which is how a test gets read later as confirming a pairing that
    // does not exist. The real fallback render is the round on its own.
    const withoutLabel = card(hubMatch({ stageName: "", roundLabel: null, roundNo: 4 }));
    expect(withoutLabel).toMatch(/>Round 4</);
    expect(withoutLabel).not.toContain(" · Round 4");
  });

  it("the division chip cannot wrap inside its own pill (class assertion — node vitest cannot measure a line box)", () => {
    // `environment: "node"`: this pins the CLASSES, and cannot see geometry.
    // What it defends is that the chip has any white-space control at all —
    // every sibling in that flex row is protected (`min-w-0 truncate` on the
    // stage/round span, `shrink-0` on the status slot) and the chip had none,
    // so a long division name shrank past its min-content and wrapped INSIDE
    // the pill, turning the meta row into a two-line blob. Same failure
    // AGENTS.md records for the detail dock's entrant chips. The rendered
    // result still needs a browser at 320 with a realistic long name.
    const h = card(
      hubMatch({ divisionName: "Mixed Doubles Championship" }),
      NOW,
      { showDivision: true },
    );
    const chipClass = h.match(/data-testid="mh-match-division" class="([^"]*)"/)?.[1];
    expect(chipClass, "the chip's class attribute").toBeTruthy();
    for (const cls of ["shrink-0", "truncate", "max-w-[45%]"]) {
      expect(chipClass!.split(" "), cls).toContain(cls);
    }
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

  it("a side's own COLOUR paints its crest, per side — the field crossed the wire and was read by nothing", () => {
    // `Side.colour` (`match-centre-schema.ts:11`) is populated for every hub
    // fixture — `competition-hub.ts`'s `hubSides` off `primaryColour`, and
    // `match-centre-load.ts:207` off the same `colors.home_primary` — and this
    // card passed only `badgeUrl`. So one badge-less club rendered as a
    // coloured tile on the Teams tab and a grey one here, on the same page.
    //
    // TWO colours in one render, not one: a single painted side is satisfied by
    // a card that paints a constant, and the two inks differ as well as the two
    // backgrounds, so a hardcoded white ink cannot pass either.
    const h = card(
      hubMatch({
        header: {
          sides: [
            { entrantId: "e1", name: "Rochford Ramblers", short: "RRA", colour: "#123456", badgeUrl: null },
            { entrantId: "e2", name: "Canvey Canaries", short: "CAN", colour: "#ffdd00", badgeUrl: null },
          ],
        },
      }),
    );
    expect(sideHtml(h, 0)).toContain("background:#123456");
    expect(sideHtml(h, 0)).toContain("color:#ffffff");
    expect(sideHtml(h, 0)).toContain(">RR<");
    expect(sideHtml(h, 1)).toContain("background:#ffdd00");
    expect(sideHtml(h, 1)).toContain("color:#0f172a");
    expect(sideHtml(h, 1)).toContain(">CC<");
    // Neither side's paint leaks into the other's row.
    expect(sideHtml(h, 0)).not.toContain("#ffdd00");
    expect(sideHtml(h, 1)).not.toContain("#123456");
  });

  it("no colour → the neutral tile, and a badge still beats a colour (the two negatives the painted arm needs)", () => {
    const mixed = card(
      hubMatch({
        header: {
          sides: [
            { entrantId: "e1", name: "Blue Blazers", short: "BLZ", colour: null, badgeUrl: null },
            { entrantId: "e2", name: "Queens Park", short: "QNS", colour: "#123456", badgeUrl: "https://x/q.png" },
          ],
        },
      }),
    );
    // Side 0: no colour of its own, so one is DERIVED from the name — a grey
    // tile identifies nothing, and most sides have no colour. It is painted the
    // same way a declared one is, so the assertion is that it is the name's
    // colour rather than that there is no paint.
    expect(sideHtml(mixed, 0)).toContain(`background:${autoColour("Blue Blazers")}`);
    expect(sideHtml(mixed, 0)).toContain(">BB<");
    // Side 1: a club with BOTH shows its badge and paints nothing — otherwise a
    // club that uploaded a crest would get a coloured box behind a transparent
    // PNG.
    expect(sideHtml(mixed, 1)).toContain(`src="https://x/q.png"`);
    expect(sideHtml(mixed, 1)).not.toContain("background:");
    expect(sideHtml(mixed, 1)).not.toContain(">QP<");
  });

  it("the crest is 24 by default and 32 when the caller asks — a size prop that changes nothing is a dead prop", () => {
    // Task 7's review deleted a `compact` prop that shipped declared-but-dead:
    // the Overview's live rail passed it and got an identical card back with
    // nothing red to say so. `crestSize` exists for that same caller, so it
    // owes the differential that would have caught `compact`.
    const plain = hubMatch();
    expect(card(plain)).toContain("h-6 w-6");
    expect(card(plain)).not.toContain("h-8 w-8");
    expect(card(plain, NOW, { crestSize: 32 })).toContain("h-8 w-8");
    expect(card(plain, NOW, { crestSize: 32 })).not.toContain("h-6 w-6");
    // The explicit 24 is the same render as the omitted one: the default is the
    // component's, not the helper's.
    expect(card(plain, NOW, { crestSize: 24 })).toBe(card(plain));
  });
});
