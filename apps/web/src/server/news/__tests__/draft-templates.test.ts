// PROMPT-82 Step 2 — pure draft templates (no DB). Title exactness, body
// composition (competition line, venue-tz date, conditional scorers/movement),
// round recap results + standings, and locale switching of static strings.
import { describe, expect, it } from "vitest";
import {
  resultDraft,
  roundRecapDraft,
  draftWhen,
  weeklyDigestDraft,
  ENRICHMENT_DICT_KEYS,
} from "../draft-templates";

const BASE = {
  locale: "en" as const,
  homeName: "Riverside",
  awayName: "Northside",
  homeScore: "3",
  awayScore: "1",
  competitionName: "Spring Cup",
  divisionName: "Premier",
  // A fixed instant that lands in the afternoon in Europe/London.
  scheduledAt: "2026-05-10T13:30:00.000Z",
  venueTz: "Europe/London",
  venue: "Riverside Park",
};

describe("resultDraft", () => {
  it("title is exactly '{home} {s}–{s} {away}' with an en dash", () => {
    const { title } = resultDraft(BASE);
    expect(title).toBe("Riverside 3–1 Northside");
  });

  it("body carries the competition line and a venue-tz date", () => {
    const { bodyMd } = resultDraft(BASE);
    expect(bodyMd).toContain("Spring Cup");
    expect(bodyMd).toContain("Premier");
    expect(bodyMd).toContain("Riverside Park");
    // venue zone is labelled and rendered in-zone (14:30 BST, not 13:30 UTC).
    expect(bodyMd).toContain("(Europe/London)");
    expect(bodyMd).toContain("14:30");
  });

  it("scorers block appears only when provided", () => {
    expect(resultDraft(BASE).bodyMd).not.toContain("Scorers");
    const withScorers = resultDraft({
      ...BASE,
      scorers: [{ name: "A. Smith", count: 2 }, { name: "B. Jones" }],
    });
    expect(withScorers.bodyMd).toContain("Scorers");
    expect(withScorers.bodyMd).toContain("A. Smith (2)");
    expect(withScorers.bodyMd).toContain("- B. Jones");
    expect(withScorers.bodyMd).not.toContain("B. Jones (");
  });

  it("standings-movement line appears only when provided", () => {
    expect(resultDraft(BASE).bodyMd).not.toContain("moves up");
    const moved = resultDraft({ ...BASE, movement: { team: "Riverside", position: 2 } });
    expect(moved.bodyMd).toContain("Riverside moves up to 2nd.");
  });

  it("locale switches the static strings (fr/es/nl)", () => {
    const scorers = [{ name: "A. Smith" }];
    const movement = { team: "Riverside", position: 2 };
    expect(resultDraft({ ...BASE, locale: "fr", scorers, movement }).bodyMd).toContain("Buteurs");
    expect(resultDraft({ ...BASE, locale: "fr", scorers, movement }).bodyMd).toContain("2e place");
    expect(resultDraft({ ...BASE, locale: "es", scorers }).bodyMd).toContain("Goleadores");
    expect(resultDraft({ ...BASE, locale: "nl", scorers }).bodyMd).toContain("Doelpuntenmakers");
  });

  it("fr locale renders fully localized strings with no unresolved tokens", () => {
    const { bodyMd } = resultDraft({
      ...BASE,
      locale: "fr",
      scheduledAt: null,
      venueTz: null,
      scorers: [{ name: "A. Smith", count: 2 }],
      movement: { team: "Riverside", position: 2 },
    });
    expect(bodyMd).not.toContain("undefined");
    expect(bodyMd).not.toContain("null");
    expect(bodyMd).not.toContain("{{");
    // English fallbacks must not leak through when the locale is fr.
    expect(bodyMd).not.toContain("Scorers");
    expect(bodyMd).not.toContain("moves up");
    expect(bodyMd).toContain("Buteurs");
    expect(bodyMd).toContain("A. Smith (2)");
    expect(bodyMd).toContain("Riverside monte à la 2e place.");
    expect(bodyMd).toContain("À confirmer"); // localized TBC placeholder (no scheduledAt)
  });
});

describe("roundRecapDraft", () => {
  const input = {
    locale: "en" as const,
    competitionName: "Spring Cup",
    divisionName: "Premier",
    roundNo: 3,
    results: [
      { homeName: "Riverside", homeScore: "3", awayName: "Northside", awayScore: "1" },
      { homeName: "Eastend", homeScore: "0", awayName: "Westgate", awayScore: "0" },
    ],
    standings: [
      { position: 1, name: "Riverside", played: 3, points: 9 },
      { position: 2, name: "Westgate", played: 3, points: 5 },
      { position: 3, name: "Eastend", played: 3, points: 4 },
    ],
  };

  it("title uses the 1-based round number and the division", () => {
    expect(roundRecapDraft(input).title).toBe("Round 3 recap: Premier");
  });

  it("body contains every result line and the top-3 standings block", () => {
    const { bodyMd } = roundRecapDraft(input);
    expect(bodyMd).toContain("Riverside 3–1 Northside");
    expect(bodyMd).toContain("Eastend 0–0 Westgate");
    expect(bodyMd).toContain("Standings");
    expect(bodyMd).toContain("1. Riverside — 9 pts (3)");
    expect(bodyMd).toContain("2. Westgate — 5 pts (3)");
    expect(bodyMd).toContain("3. Eastend — 4 pts (3)");
  });

  it("clamps the standings block to exactly the given rows when fewer than 5 entrants exist — no padding/undefined", () => {
    const twoTeamInput = {
      ...input,
      standings: [
        { position: 1, name: "Riverside", played: 3, points: 9 },
        { position: 2, name: "Northside", played: 3, points: 6 },
      ],
    };
    const { bodyMd } = roundRecapDraft(twoTeamInput);
    expect(bodyMd).not.toContain("undefined");
    expect(bodyMd).not.toContain("null");
    // Exactly two standings lines — no padding to a fixed 5-row block.
    const standingsLines = bodyMd
      .split("\n")
      .filter((l) => /^\d+\. /.test(l));
    expect(standingsLines).toHaveLength(2);
    expect(bodyMd).toContain("1. Riverside — 9 pts (3)");
    expect(bodyMd).toContain("2. Northside — 6 pts (3)");
    expect(bodyMd).not.toContain("3. ");
  });

  it("localizes the section headings", () => {
    const fr = roundRecapDraft({ ...input, locale: "fr" });
    expect(fr.bodyMd).toContain("Résultats");
    expect(fr.bodyMd).toContain("Classement");
    expect(fr.title).toContain("journée 3");
  });
});

describe("draftWhen", () => {
  it("returns the locale's TBC placeholder when unscheduled", () => {
    expect(draftWhen(null, "Europe/London", "en")).toBe("TBC");
    expect(draftWhen(null, null, "es")).toBe("Por confirmar");
  });
});

// P3 (D7) — the no-regression anchor. Recorded from the UNMODIFIED function,
// before enrichment support existed, via a throwaway node script printing
// JSON.stringify(resultDraft(...)) / JSON.stringify(roundRecapDraft(...)).
// Absent `enrichment` must produce this EXACT object — a real byte compare,
// not a `toContain` fragment check, so nothing about the pre-existing output
// can drift while enrichment is being added.
describe("byte-identical output when enrichment is absent (regression anchor)", () => {
  it("resultDraft(BASE) — no scorers, no movement, no enrichment", () => {
    expect(resultDraft(BASE)).toEqual({
      title: "Riverside 3–1 Northside",
      bodyMd: "**Spring Cup** · Premier\nRiverside Park · Sun 10 May, 14:30 (Europe/London)",
    });
  });

  it("resultDraft with scorers + movement, still no enrichment field", () => {
    expect(
      resultDraft({
        ...BASE,
        scorers: [{ name: "A. Smith", count: 2 }],
        movement: { team: "Riverside", position: 2 },
      }),
    ).toEqual({
      title: "Riverside 3–1 Northside",
      bodyMd:
        "**Spring Cup** · Premier\nRiverside Park · Sun 10 May, 14:30 (Europe/London)\n\n**Scorers**\n- A. Smith (2)\n\nRiverside moves up to 2nd.",
    });
  });

  it("roundRecapDraft — no enrichment field", () => {
    const input = {
      locale: "en" as const,
      competitionName: "Spring Cup",
      divisionName: "Premier",
      roundNo: 3,
      results: [
        { homeName: "Riverside", homeScore: "3", awayName: "Northside", awayScore: "1" },
        { homeName: "Eastend", homeScore: "0", awayName: "Westgate", awayScore: "0" },
      ],
      standings: [
        { position: 1, name: "Riverside", played: 3, points: 9 },
        { position: 2, name: "Westgate", played: 3, points: 5 },
        { position: 3, name: "Eastend", played: 3, points: 4 },
      ],
    };
    expect(roundRecapDraft(input)).toEqual({
      title: "Round 3 recap: Premier",
      bodyMd:
        "**Spring Cup** · Premier\n\n**Results**\n- Riverside 3–1 Northside\n- Eastend 0–0 Westgate\n\n**Standings**\n1. Riverside — 9 pts (3)\n2. Westgate — 5 pts (3)\n3. Eastend — 4 pts (3)",
    });
  });
});

describe("resultDraft enrichment", () => {
  it("full enrichment adds a top-performers block, leader moves, and a streak line", () => {
    const { bodyMd } = resultDraft({
      ...BASE,
      enrichment: {
        topPerformers: [{ personName: "A. Smith", statLine: "2 goals" }],
        leaderboardMoves: [{ personName: "A. Smith", metric: "goals", from: 4, to: 2 }],
        streak: { entrantName: "Riverside", kind: "win", length: 3 },
      },
    });
    expect(bodyMd).toContain("Top performers");
    expect(bodyMd).toContain("A. Smith — 2 goals");
    expect(bodyMd).toContain("A. Smith moved to #2 in goals (was #4).");
    expect(bodyMd).toContain("Riverside have now won 3 in a row.");
  });

  it("unbeaten streak uses the unbeaten wording, not the win wording", () => {
    const { bodyMd } = resultDraft({
      ...BASE,
      enrichment: { streak: { entrantName: "Riverside", kind: "unbeaten", length: 5 } },
    });
    expect(bodyMd).toContain("Riverside are unbeaten in their last 5.");
    expect(bodyMd).not.toContain("have now won");
  });

  it("partial enrichment (only topPerformers) renders only that block", () => {
    const { bodyMd } = resultDraft({
      ...BASE,
      enrichment: { topPerformers: [{ personName: "A. Smith", statLine: "2 goals" }] },
    });
    expect(bodyMd).toContain("Top performers");
    expect(bodyMd).not.toContain("moved to #");
    expect(bodyMd).not.toContain("in a row");
    expect(bodyMd).not.toContain("unbeaten");
  });

  it("an enrichment object with every field empty/absent renders no extra block", () => {
    const withEmpty = resultDraft({ ...BASE, enrichment: {} });
    expect(withEmpty).toEqual(resultDraft(BASE));
  });

  it("fr locale renders enrichment fully localized, no unresolved tokens", () => {
    const { bodyMd } = resultDraft({
      ...BASE,
      locale: "fr",
      enrichment: {
        topPerformers: [{ personName: "A. Smith", statLine: "2 buts" }],
        streak: { entrantName: "Riverside", kind: "win", length: 3 },
      },
    });
    expect(bodyMd).toContain("Meilleures performances");
    expect(bodyMd).toContain("Riverside enchaîne 3 victoires de suite.");
    expect(bodyMd).not.toContain("{{");
    expect(bodyMd).not.toContain("undefined");
  });
});

describe("roundRecapDraft enrichment", () => {
  const RECAP_BASE = {
    locale: "en" as const,
    competitionName: "Spring Cup",
    divisionName: "Premier",
    roundNo: 3,
    results: [{ homeName: "Riverside", homeScore: "3", awayName: "Northside", awayScore: "1" }],
    standings: [{ position: 1, name: "Riverside", played: 3, points: 9 }],
  };

  it("full enrichment renders leaders, biggest result, and standings moves", () => {
    const { bodyMd } = roundRecapDraft({
      ...RECAP_BASE,
      enrichment: {
        leaders: [{ metric: "goals", personName: "A. Smith", value: 12 }],
        biggestResult: { label: "Riverside 5–0 Eastend" },
        standingsMoves: [{ entrantName: "Riverside", from: 3, to: 1 }],
      },
    });
    expect(bodyMd).toContain("Leaders");
    expect(bodyMd).toContain("goals: A. Smith (12)");
    expect(bodyMd).toContain("Biggest result: Riverside 5–0 Eastend");
    expect(bodyMd).toContain("Movers");
    expect(bodyMd).toContain("Riverside climbed from 3 to 1.");
  });

  it("partial enrichment (only biggestResult) renders only that line", () => {
    const { bodyMd } = roundRecapDraft({
      ...RECAP_BASE,
      enrichment: { biggestResult: { label: "Riverside 5–0 Eastend" } },
    });
    expect(bodyMd).toContain("Biggest result: Riverside 5–0 Eastend");
    expect(bodyMd).not.toContain("Leaders");
    expect(bodyMd).not.toContain("Movers");
  });

  it("absent enrichment is byte-identical to the pre-existing call", () => {
    expect(roundRecapDraft(RECAP_BASE)).toEqual(roundRecapDraft({ ...RECAP_BASE, enrichment: undefined }));
  });
});

describe("weeklyDigestDraft", () => {
  const DIGEST_BASE = {
    locale: "en" as const,
    orgName: "Riverside FC",
    weekOfYmd: "2026-08-03",
    standings: [],
    leaders: [],
    upcoming: [],
    upcomingOverflow: 0,
  };

  it("title carries the org name and a formatted week-of date", () => {
    const { title } = weeklyDigestDraft(DIGEST_BASE);
    expect(title).toContain("Riverside FC");
    expect(title).toContain("3 Aug 2026");
  });

  it("every section renders when data exists", () => {
    const { bodyMd } = weeklyDigestDraft({
      ...DIGEST_BASE,
      standings: [
        {
          divisionName: "Premier",
          top3: [{ position: 1, name: "Riverside", points: 12 }],
          climber: { entrantName: "Eastend", from: 5, to: 2 },
        },
      ],
      leaders: [{ divisionName: "Premier", metricLabel: "goals", personName: "A. Smith", value: 9 }],
      upcoming: [
        {
          dayYmd: "2026-08-10",
          lines: [{ homeName: "Riverside", awayName: "Northside", timeLabel: "14:30" }],
        },
      ],
      upcomingOverflow: 4,
      claimedHighlight: { personName: "A. Smith", statLine: "9 goals" },
    });
    expect(bodyMd).toContain("Standings movement");
    expect(bodyMd).toContain("1. Riverside — 12 pts");
    expect(bodyMd).toContain("Biggest climber: Eastend (5 → 2)");
    expect(bodyMd).toContain("Stat leaders");
    expect(bodyMd).toContain("Premier — goals: A. Smith (9)");
    expect(bodyMd).toContain("Next 7 days");
    expect(bodyMd).toContain("Riverside v Northside (14:30)");
    expect(bodyMd).toContain("…and 4 more");
    expect(bodyMd).toContain("Your player of the week");
    expect(bodyMd).toContain("A. Smith — 9 goals");
  });

  it("an absent section renders no heading at all — no 'no data' filler line", () => {
    const { bodyMd } = weeklyDigestDraft({
      ...DIGEST_BASE,
      leaders: [{ divisionName: "Premier", metricLabel: "goals", personName: "A. Smith", value: 9 }],
    });
    expect(bodyMd).not.toContain("Standings movement");
    expect(bodyMd).not.toContain("Next 7 days");
    expect(bodyMd).not.toContain("player of the week");
    expect(bodyMd).toContain("Stat leaders");
  });

  it("every section absent yields an empty body, never a placeholder sentence", () => {
    const { bodyMd } = weeklyDigestDraft(DIGEST_BASE);
    expect(bodyMd).toBe("");
  });

  it("fr locale renders fully localized, no unresolved tokens", () => {
    const { title, bodyMd } = weeklyDigestDraft({
      ...DIGEST_BASE,
      locale: "fr",
      leaders: [{ divisionName: "Premier", metricLabel: "buts", personName: "A. Smith", value: 9 }],
    });
    expect(title).toContain("semaine du");
    expect(bodyMd).toContain("Meilleures stats");
    expect(title).not.toContain("{{");
    expect(bodyMd).not.toContain("undefined");
  });
});

// The i18n regression gate (dictionary-copy-truth-style, but for THIS
// namespace): seeded from the template's OWN key list, not from the
// dictionaries — the event-copy-gate lesson (a gate that reads its expected
// list off the thing it is checking cannot fail).
describe("ENRICHMENT_DICT_KEYS", () => {
  it("is non-empty and every entry is under news.enrich./news.recap./news.digest.", () => {
    expect(ENRICHMENT_DICT_KEYS.length).toBeGreaterThan(15);
    for (const key of ENRICHMENT_DICT_KEYS) {
      expect(key).toMatch(/^news\.(enrich|recap|digest)\./);
    }
  });
});
