// Pure helpers for the public dashboard (PROMPT-12).
import { describe, expect, it } from "vitest";
import {
  isReservedSlug,
  buildIcs,
  foldLine,
  sportsEventJsonLd,
  standingsColumns,
  formatMetric,
  setBreakdown,
  stripLiveSetPoints,
  teamShortOf,
  personShortCandidates,
  disambiguatedShorts,
  type StandingsRowLike,
} from "@/lib/public-site";

/** True if `s` contains a high surrogate with no immediately-following low
 *  surrogate, or a low surrogate with no immediately-preceding high one —
 *  i.e. a UTF-16 surrogate pair (one astral codepoint) that got split. */
function hasUnpairedSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe("reserved slugs (doc 09 §1)", () => {
  it("blocks every existing top-level app route", () => {
    for (const slug of ["api", "admin", "dashboard", "login", "tournaments", "t", "legal"]) {
      expect(isReservedSlug(slug)).toBe(true);
    }
  });
  it("is case-insensitive and allows normal org slugs", () => {
    expect(isReservedSlug("API")).toBe(true);
    expect(isReservedSlug("riverside-cc")).toBe(false);
  });
});

describe("ICS feed (doc 09 §2)", () => {
  const event = {
    uid: "fx-1",
    start: new Date("2026-07-12T14:00:00Z"),
    durationMinutes: 90,
    summary: "Tigers vs Lions; Semi, final",
    location: "Main Hall",
  };

  it("emits a valid VCALENDAR with escaped TEXT and DTEND from duration", () => {
    const ics = buildIcs("U16 T20", [event]);
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("DTSTART:20260712T140000Z");
    expect(ics).toContain("DTEND:20260712T153000Z");
    expect(ics).toContain("SUMMARY:Tigers vs Lions\\; Semi\\, final");
    expect(ics).toContain("UID:fx-1@seazn.club");
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });

  it("folds lines longer than 75 octets with a leading space", () => {
    const long = buildIcs("Cal", [
      { ...event, summary: "A".repeat(120) },
    ]);
    const folded = long.split("\r\n").find((l) => l.startsWith(" "));
    expect(folded).toBeDefined();
    expect(long.split("\r\n").every((l) => l.length <= 74)).toBe(true);
  });

  // B2 folding-octet finding: RFC 5545 §3.1 counts OCTETS, not UTF-16 code
  // units. A test built only from ASCII (like the one above — "A".repeat
  // (120), where .length === byte length) cannot tell an octet-correct fold
  // apart from a naive one; it passes either way. These two use genuinely
  // multi-byte text to prove the distinction actually holds.
  describe("foldLine counts UTF-8 octets, not UTF-16 code units", () => {
    it("an accented string UNDER 74 chars but OVER 74 octets still folds", () => {
      // "é" is 1 UTF-16 code unit but 2 UTF-8 octets. 74 of them satisfy a
      // naive `line.length <= 74` check (so a UTF-16-based fold returns it
      // completely unfolded) while totalling 148 octets — a real RFC 5545
      // violation a French/Dutch competition name reproduces routinely.
      const line = "é".repeat(74);
      expect(line.length).toBe(74);
      const folded = foldLine(line);
      expect(folded).toContain("\r\n");
      const enc = new TextEncoder();
      for (const part of folded.split("\r\n")) {
        expect(enc.encode(part).length).toBeLessThanOrEqual(74);
      }
      // Stripping the fold markers (CRLF + the single continuation space)
      // must reconstruct the original text exactly.
      expect(folded.replace(/\r\n /g, "")).toBe(line);
    });

    it("never splits a surrogate pair (an astral codepoint) across a fold boundary", () => {
      // U+1F3C6 TROPHY is one codepoint but a 2-unit UTF-16 surrogate pair.
      // 73 ASCII chars put the pair exactly across a naive slice(0, 74)
      // boundary — reproducing "slice(0, 74) can split a surrogate pair
      // outright" verbatim: the old code would cut after the lone high
      // surrogate, orphaning it on one physical line and starting the next
      // with a lone low surrogate. Both are invalid UTF-16 on their own.
      const trophy = "\u{1F3C6}";
      const line = "A".repeat(73) + trophy + "B".repeat(10);
      const folded = foldLine(line);
      expect(hasUnpairedSurrogate(folded)).toBe(false);
      expect(folded.replace(/\r\n /g, "")).toBe(line);
    });
  });

  it("an all-day event emits DATE-typed bounds and TENTATIVE status", () => {
    const ics = buildIcs("Cup", [
      { uid: "fix-1", allDayOn: "2026-09-13", summary: "Winner of Group A vs Runner-up of Group B" },
    ]);
    expect(ics).toContain("DTSTART;VALUE=DATE:20260913");
    // RFC 5545 §3.6.1: the DATE-typed DTEND is EXCLUSIVE, so a one-day event
    // ends on the following day. Ending on the same date renders as zero-length.
    expect(ics).toContain("DTEND;VALUE=DATE:20260914");
    expect(ics).toContain("STATUS:TENTATIVE");
  });

  // Reviewer finding (Minor, public-site.ts:63-67): every all-day DTEND case
  // above stays mid-month, so nextDay()'s month/year rollover (Date's own
  // UTC carry, not string arithmetic) was never exercised. Values below were
  // computed independently with `new Date(...).setUTCDate(...)`, not copied
  // from a spec.
  it("all-day DTEND rolls over a month boundary — September has 30 days", () => {
    const ics = buildIcs("Cup", [{ uid: "fix-1", allDayOn: "2026-09-30", summary: "Final" }]);
    expect(ics).toContain("DTSTART;VALUE=DATE:20260930");
    expect(ics).toContain("DTEND;VALUE=DATE:20261001");
  });

  it("all-day DTEND rolls over a year boundary", () => {
    const ics = buildIcs("Cup", [{ uid: "fix-1", allDayOn: "2026-12-31", summary: "Final" }]);
    expect(ics).toContain("DTSTART;VALUE=DATE:20261231");
    expect(ics).toContain("DTEND;VALUE=DATE:20270101");
  });

  it("all-day DTEND rolls a leap day into March (2028 is a leap year; 2026 is not)", () => {
    const ics = buildIcs("Cup", [{ uid: "fix-1", allDayOn: "2028-02-29", summary: "Final" }]);
    expect(ics).toContain("DTSTART;VALUE=DATE:20280229");
    expect(ics).toContain("DTEND;VALUE=DATE:20280301");
  });

  it("a timed event stays timed and is marked confirmed", () => {
    const ics = buildIcs("Cup", [
      {
        uid: "fix-1",
        start: new Date("2026-09-13T14:00:00Z"),
        durationMinutes: 90,
        summary: "Lions vs Tigers",
      },
    ]);
    expect(ics).toContain("DTSTART:20260913T140000Z");
    expect(ics).toContain("DTEND:20260913T153000Z");
    expect(ics).toContain("STATUS:CONFIRMED");
    expect(ics).not.toContain("VALUE=DATE");
  });

  it("UID is byte-identical across the tentative-to-timed transition", () => {
    const tentative = buildIcs("Cup", [
      { uid: "fix-1", allDayOn: "2026-09-13", summary: "Winner of Group A vs Runner-up of Group B" },
    ]);
    const timed = buildIcs("Cup", [
      { uid: "fix-1", start: new Date("2026-09-13T14:00:00Z"), durationMinutes: 90, summary: "Lions vs Tigers" },
    ]);
    const uidOf = (s: string) => s.split("\r\n").find((l) => l.startsWith("UID:"));
    expect(uidOf(tentative)).toBe("UID:fix-1@seazn.club");
    expect(uidOf(timed)).toBe(uidOf(tentative));
  });

  // Fix-wave finding 3: DTSTAMP alone can't order the tentative→timed
  // transition — it's derived from the event's own date, not a wall clock —
  // so scheduling a fixture BEFORE the placeholder's anchor date moves
  // DTSTAMP backward. Concretely: a competition ending 2026-09-20 emits the
  // tentative placeholder with DTSTAMP 20260920T000000Z; the same fixture
  // scheduled for 2026-09-18 emits the timed event with DTSTAMP
  // 20260918T100000Z — earlier than the tentative copy. A client ordering
  // revisions by DTSTAMP would keep the stale "TBD" placeholder over the real
  // fixture. SEQUENCE fixes this: monotonically increasing across the
  // transition, independent of any clock. Old code (no SEQUENCE line at all)
  // fails both `toContain` assertions below.
  it("SEQUENCE increments across the tentative-to-timed transition, independent of DTSTAMP", () => {
    const tentative = buildIcs("Cup", [
      { uid: "fix-1", allDayOn: "2026-09-20", summary: "Winner of Group A vs Runner-up of Group B" },
    ]);
    const timed = buildIcs("Cup", [
      { uid: "fix-1", start: new Date("2026-09-18T10:00:00Z"), durationMinutes: 90, summary: "Lions vs Tigers" },
    ]);
    // Confirms the regression scenario itself: DTSTAMP really does move
    // backward here, so SEQUENCE is doing real work, not guarding a case
    // that could not otherwise arise.
    expect(tentative).toContain("DTSTAMP:20260920T000000Z");
    expect(timed).toContain("DTSTAMP:20260918T100000Z");

    expect(tentative).toContain("SEQUENCE:0");
    expect(timed).toContain("SEQUENCE:1");
    const seqOf = (s: string) => Number(s.split("\r\n").find((l) => l.startsWith("SEQUENCE:"))?.slice("SEQUENCE:".length));
    expect(seqOf(timed)).toBeGreaterThan(seqOf(tentative));
  });
});

describe("SportsEvent JSON-LD (doc 09 §3)", () => {
  it("escapes < so the payload cannot close its script tag", () => {
    const json = sportsEventJsonLd({
      name: "Tigers </script><script> vs Lions",
      url: "https://seazn.club/x/y",
      eventStatus: "EventScheduled",
    });
    expect(json).not.toContain("</script>");
    expect(JSON.parse(json)["@type"]).toBe("SportsEvent");
  });
});

describe("standings columns — MetricSpec-driven (doc 09 §2)", () => {
  const specs = [
    { key: "gf", label: "GF" },
    { key: "ga", label: "GA" },
    { key: "gd", label: "GD" },
    { key: "yellow", label: "Yellow cards", display: false },
  ];
  const derived = [{ key: "nrr", label: "NRR", decimals: 3 }];
  const row = (over: Partial<StandingsRowLike>): StandingsRowLike => ({
    entrantId: "A",
    played: 3,
    won: 2,
    drawn: 0,
    lost: 1,
    points: 6,
    metrics: { gf: 5, ga: 2, gd: 3, yellow: 1 },
    ...over,
  });

  it("football shape: P W L + GF GA GD + Pts, no display:false columns", () => {
    const cols = standingsColumns(specs, ["points", "diff"], [row({})], derived);
    expect(cols.map((c) => c.key)).toEqual(["played", "won", "lost", "gf", "ga", "gd", "points"]);
  });

  it("adds a D column as soon as any row has a draw", () => {
    const cols = standingsColumns(specs, ["points"], [row({ drawn: 1 })], derived);
    expect(cols.map((c) => c.key)).toContain("drawn");
  });

  it("adds a derived column only when the cascade uses it", () => {
    const withNrr = standingsColumns(specs, ["points", "nrr"], [row({})], derived);
    expect(withNrr.map((c) => c.key)).toContain("nrr");
    const without = standingsColumns(specs, ["points"], [row({})], derived);
    expect(without.map((c) => c.key)).not.toContain("nrr");
  });

  it("hides a metric column no row carries", () => {
    const cols = standingsColumns(
      [...specs, { key: "buchholz", label: "Buchholz" }],
      ["points"],
      [row({})],
      derived,
    );
    expect(cols.map((c) => c.key)).not.toContain("buchholz");
  });
});

describe("formatMetric", () => {
  it("renders dashes, integers and fixed decimals", () => {
    expect(formatMetric(undefined)).toBe("—");
    expect(formatMetric(3)).toBe("3");
    expect(formatMetric(1.5, 2)).toBe("1.50");
  });
});

describe("setBreakdown (public per-set scoreboard)", () => {
  const summary = {
    headline: "1 — 0 (5–3)",
    perSide: [
      { entrantId: "H", line: "1" },
      { entrantId: "A", line: "0" },
    ],
    detail: {
      sets: [
        { home: 21, away: 15, closed: true },
        { home: 5, away: 3, closed: false },
      ],
      points: { home: 26, away: 18 },
    },
  };

  // Task 14c — `unit` is now a dictionary-key suffix ("game"/"set"), not the
  // literal English display word ("Game"/"Set") this test used to pin —
  // `live-score.tsx` resolves it through `matchCentre.col.<unit>` /
  // `matchCentre.unit.<unit>` instead of rendering it straight through.
  it("extracts every set including the live one, unit-labelled per sport", () => {
    expect(setBreakdown(summary, "badminton")).toEqual({
      unit: "game",
      sets: [
        { home: 21, away: 15, closed: true },
        { home: 5, away: 3, closed: false },
      ],
    });
    expect(setBreakdown(summary, "tabletennis")?.unit).toBe("game");
    expect(setBreakdown(summary, "volleyball")?.unit).toBe("set");
  });

  it("returns null for non-set-based or malformed summaries", () => {
    expect(setBreakdown(null, "badminton")).toBeNull();
    expect(setBreakdown({ headline: "2 — 1" }, "football")).toBeNull();
    expect(setBreakdown({ detail: { sets: [] } }, "badminton")).toBeNull();
    // cricket-style detail with a different shape must not leak through
    expect(setBreakdown({ detail: { innings: [{ runs: 120 }] } }, "cricket")).toBeNull();
    expect(setBreakdown({ detail: { sets: [{ home: "21", away: 15 }] } }, "badminton")).toBeNull();
  });

  it("strips the live-points suffix from the headline (shown in the card instead)", () => {
    expect(stripLiveSetPoints("1 — 0 (14–11)")).toBe("1 — 0");
    expect(stripLiveSetPoints("2 — 1")).toBe("2 — 1");
  });
});

describe("isoDateTime (timestamptz rows crossing into client components)", () => {
  it("converts Date to ISO string — postgres.js returns Date, client sorts strings", async () => {
    const { isoDateTime } = await import("../public-site");
    const d = new Date("2026-07-11T10:00:00Z");
    expect(isoDateTime(d)).toBe("2026-07-11T10:00:00.000Z");
  });
  it("passes strings through and nulls everything else", async () => {
    const { isoDateTime } = await import("../public-site");
    expect(isoDateTime("2026-07-11T10:00:00Z")).toBe("2026-07-11T10:00:00Z");
    expect(isoDateTime(null)).toBeNull();
    expect(isoDateTime(undefined)).toBeNull();
    expect(isoDateTime(42)).toBeNull();
  });
});

describe("competitionChip (spectator status vocabulary)", () => {
  it("maps completed and archived to finished — completed used to read as upcoming", async () => {
    const { competitionChip } = await import("../public-site");
    expect(competitionChip("completed")).toBe("finished");
    expect(competitionChip("archived")).toBe("finished");
    expect(competitionChip("live")).toBe("on-now");
    expect(competitionChip("draft")).toBe("upcoming");
    expect(competitionChip("published")).toBe("upcoming");
  });
});

// R11 fix round, C9 — the match-centre court card abbreviates every entrant
// to three letters. The TEAM rule (`teamShortOf`, unchanged: first three
// compacted letters of the whole name) already disambiguates in practice
// (cricket's BLA/COM), but it collided for PERSON entrants: "Player One" and
// "Player Two" both read "PLA". `personShortCandidates` prefers the surname;
// `disambiguatedShorts` resolves BOTH sides together, since a single side's
// name never carries enough information on its own to know it needs to widen.
describe("teamShortOf / personShortCandidates / disambiguatedShorts (R11 fix round, C9)", () => {
  it("teamShortOf is unchanged — first three compacted, uppercased letters", () => {
    expect(teamShortOf("Blazers")).toBe("BLA");
    expect(teamShortOf("Comets FC")).toBe("COM");
    expect(teamShortOf("")).toBe("?");
  });

  it("personShortCandidates prefers the surname first ('Player One' -> 'ONE', not 'PLA')", () => {
    expect(personShortCandidates("Player One")[0]).toBe("ONE");
    expect(personShortCandidates("Player Two")[0]).toBe("TWO");
  });

  it("a single-word name still yields a usable candidate list (no first/last split to draw on)", () => {
    expect(personShortCandidates("Cher")[0]).toBe("CHE");
  });

  it("disambiguatedShorts: two PERSON entrants whose first names collide but surnames differ — 'Player One'/'Player Two' -> 'ONE'/'TWO', never both 'PLA'", () => {
    const [home, away] = disambiguatedShorts(
      { name: "Player One", isPerson: true },
      { name: "Player Two", isPerson: true },
    );
    expect(home).not.toBe(away);
    expect(home).toBe("ONE");
    expect(away).toBe("TWO");
  });

  // The brief's OWN required case: "include the case where the surnames also
  // collide, and pin what the code does then". Surname-first candidates
  // ("SMI"/"SMI") collide too, so the widened rung (initial + 2 letters of
  // surname) must be what breaks the tie.
  it("disambiguatedShorts: surnames ALSO collide ('Alice Smith'/'Bob Smith') — widens to initial+surname, still 3 letters, still different", () => {
    const [home, away] = disambiguatedShorts(
      { name: "Alice Smith", isPerson: true },
      { name: "Bob Smith", isPerson: true },
    );
    expect(home).not.toBe(away);
    expect(home).toBe("ASM");
    expect(away).toBe("BSM");
    // Each abbreviation is still traceable to its OWN name, not a swap.
    expect(home.startsWith("A")).toBe(true);
    expect(away.startsWith("B")).toBe(true);
  });

  it("disambiguatedShorts: genuinely identical full names on both sides — every candidate exhausted, the positional tie-break still guarantees 'never equal'", () => {
    const [home, away] = disambiguatedShorts(
      { name: "John Smith", isPerson: true },
      { name: "John Smith", isPerson: true },
    );
    expect(home).not.toBe(away);
  });

  it("disambiguatedShorts: TEAM entrants keep today's behaviour unconditionally (out of C9's scope) — no widening even if they collided", () => {
    const [home, away] = disambiguatedShorts(
      { name: "Blazers United", isPerson: false },
      { name: "Blazers Town", isPerson: false },
    );
    // Both compact to "BLA" under the unchanged team rule — this is NOT
    // fixed by C9 (team entrants "keep today's behaviour where it already
    // disambiguates"); pinned here so a future change to the team rule is a
    // deliberate decision, not an accidental side effect of this one.
    expect(home).toBe("BLA");
    expect(away).toBe("BLA");
  });

  it("disambiguatedShorts: a PERSON side against a TEAM side (mixed kinds, defensive — does not occur in practice) resolves each independently and still differs when they would otherwise collide", () => {
    const [home, away] = disambiguatedShorts(
      { name: "Ben Lane", isPerson: true },
      { name: "Ben Lane FC", isPerson: false },
    );
    expect(home).not.toBe(away);
  });
});
