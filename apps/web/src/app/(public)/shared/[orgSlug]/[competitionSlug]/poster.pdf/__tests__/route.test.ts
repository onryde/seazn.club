// Group D (2026-08-24 owner ruling): the public poster gets the draw as page
// 2 onward (round-by-round list, grouped by stage/round, board slot labels),
// and its two hardcoded-English strings + toLocaleDateString("en-GB", …)
// resolve through the org's own default_locale — the same pattern the public
// calendar route already uses (calendar.ics/__tests__/route.test.ts).
//
// A pdfkit PDF's content streams are FlateDecode-compressed by default (see
// this repo's exports.ts test/e2e split — "grepping the response bytes …
// would prove nothing either way"), so most of this file proves STRUCTURE:
// page count via the PDF's own /Count field (validated against this repo's
// pdfkit output — see decodePdfPageCount below), magic bytes, and division
// scoping. The buildDrawModel VALUE proofs (grouping, slot-label/locale
// resolution) live in lib/__tests__/poster-draw.test.ts against the plain JS
// model, not against PDF bytes.
//
// For the highest-value strings — the two former hardcoded literals and the
// draw's own rendered fixture text — this file goes one step further than
// that established split: it inflates each content stream for real (Node's
// built-in zlib; pdfkit's FlateDecode is standard zlib, not raw deflate) and
// decodes the hex-bracketed Tj/TJ operands as windows-1252. This is valid
// ONLY because this route draws exclusively with the 14 standard, UNEMBEDDED
// PDF fonts (Helvetica/Helvetica-Bold) — pdfkit hex-encodes their glyphs
// directly as WinAnsiEncoding byte values with no font subsetting/CID
// mapping in between. It would silently stop working if the route ever
// switched to an embedded custom font (the hex tokens would then be glyph
// indices, not character codes) — a future maintainer hitting that should
// fall back to the page-count/magic-byte style of proof used elsewhere here.
import { beforeEach, describe, expect, it, vi } from "vitest";
import zlib from "node:zlib";
import { getDictionary, t } from "@/lib/i18n";
import { msgFor } from "@/lib/messages-i18n";
import { resolveSlotLabel } from "@/lib/slot-label";
import type { PublicFixture, PublicEntrant, PublicDivision } from "@/server/public-site/data";

const getPublicCompetition = vi.fn();
const getPublicDivision = vi.fn();
vi.mock("@/server/public-site/data", () => ({
  getPublicCompetition: (...a: unknown[]) => getPublicCompetition(...a),
  getPublicDivision: (...a: unknown[]) => getPublicDivision(...a),
}));

// Both mocks are module-level (shared across every `it` below) and this file
// asserts on CALL HISTORY (toHaveBeenCalledWith), not just resolved values —
// vitest does not clear mock call history between tests on its own (no
// clearMocks/restoreMocks in vitest.config.ts), so a later test's assertion
// would otherwise see calls left over from an earlier one.
beforeEach(() => {
  getPublicCompetition.mockReset();
  getPublicDivision.mockReset();
});

function decodePdfPageCount(pdf: Buffer): number {
  const raw = pdf.toString("latin1");
  const m =
    /\/Type\s*\/Pages[^>]*?\/Count\s+(\d+)/.exec(raw) ||
    /\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages/.exec(raw);
  if (!m) throw new Error("no /Count found in PDF object table — not a well-formed pdfkit output");
  return Number(m[1]);
}

/** See the file header comment — recovers the actual drawn characters from a
 *  pdfkit PDF built entirely from standard, unembedded fonts.
 *
 *  pdfkit emits kerned text as a `TJ` array — several hex strings interleaved
 *  with bare numbers that nudge the NEXT glyph, e.g.
 *  `[<...706172> -40 <7469646f73...>] TJ` for "…par" + "tidos…" (one word,
 *  "partidos", split only because of a kerning pair). Those numbers are NOT
 *  spaces, so the hex pieces within one `[...] TJ` array are decoded and
 *  concatenated with NO separator; only SEPARATE operators (different
 *  `.text()` calls / lines) get a joining space. An earlier version of this
 *  helper flattened every `<hex>` token file-wide with a uniform space
 *  between them, which silently broke a kerned word's own exact-substring
 *  assertions (verified against that failure before landing this fix). */
function decodePdfText(pdf: Buffer): string {
  const raw = pdf.toString("latin1");
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  const decoder = new TextDecoder("windows-1252");
  const decodeHexRun = (segment: string): string => {
    const hexRe = /<([0-9A-Fa-f]+)>/g;
    let out = "";
    let hm: RegExpExecArray | null;
    while ((hm = hexRe.exec(segment))) out += decoder.decode(Buffer.from(hm[1]!, "hex"));
    return out;
  };
  const lines: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = streamRe.exec(raw))) {
    let inflated: Buffer;
    try {
      inflated = zlib.inflateSync(Buffer.from(m[1]!, "latin1"));
    } catch {
      continue; // not a FlateDecode text stream (e.g. the QR image XObject)
    }
    const content = inflated.toString("latin1");
    // Kerned runs: `[ <hex> num <hex> num <hex> ... ] TJ`.
    const tjArrayRe = /\[([^\]]*)\]\s*TJ/g;
    let am: RegExpExecArray | null;
    while ((am = tjArrayRe.exec(content))) {
      const line = decodeHexRun(am[1]!);
      if (line) lines.push(line);
    }
    // Unkerned single strings: `<hex> Tj`.
    const tjRe = /<([0-9A-Fa-f]+)>\s*Tj/g;
    let tm: RegExpExecArray | null;
    while ((tm = tjRe.exec(content))) lines.push(decoder.decode(Buffer.from(tm[1]!, "hex")));
  }
  return lines.join(" ");
}

const ORG = (locale: string) => ({
  id: "o1",
  name: "Test Org",
  slug: "test-org",
  branded: false,
  branding: {},
  logo: null,
  about: null,
  default_locale: locale,
  card_payments: false,
});

const COMPETITION = {
  id: "c1",
  org_id: "o1",
  name: "Test Comp",
  slug: "test-comp",
  description: null,
  starts_on: "2026-09-01",
  ends_on: "2026-09-13",
  branding: {},
  status: "active",
  visibility: "public" as const,
};

const DIVISION = (over: Partial<PublicDivision> = {}): PublicDivision => ({
  id: "d1",
  competition_id: "c1",
  name: "Open",
  slug: "open",
  description: null,
  sport_key: "generic",
  variant_key: "score",
  status: "active",
  module_version: "1.0.0",
  tiebreakers: null,
  sport_name: null,
  entrant_count: 4,
  ...over,
});

const F = (over: Partial<PublicFixture>): PublicFixture => ({
  id: "f1",
  division_id: "d1",
  stage_id: "s1",
  pool_id: null,
  round_no: 1,
  seq_in_round: 1,
  home_entrant_id: null,
  away_entrant_id: null,
  home_slot_label: null,
  away_slot_label: null,
  scheduled_at: null,
  venue: null,
  court_label: null,
  venue_name: null,
  court_name: null,
  status: "scheduled",
  outcome: null,
  summary: null,
  last_seq: null,
  ...over,
});

const E = (over: Partial<PublicEntrant>): PublicEntrant => ({
  id: "e1",
  division_id: "d1",
  kind: "individual",
  display_name: "Entrant",
  seed: 1,
  status: "confirmed",
  members: [],
  team_display: null,
  badge_url: null,
  ...over,
});

/** A 4-entrant knockout shape: 2 semis with real entrants, and a final whose
 *  slots are still TBD slot labels — the "day-one fixtures" case the owner
 *  ruling names. */
const KNOCKOUT_DRAW = {
  stages: [{ id: "s1", division_id: "d1", seq: 1, kind: "knockout" as const, name: "Cup", status: "setup" }],
  pools: [],
  fixtures: [
    F({ id: "semi1", round_no: 1, seq_in_round: 1, home_entrant_id: "e1", away_entrant_id: "e2" }),
    F({ id: "semi2", round_no: 1, seq_in_round: 2, home_entrant_id: "e3", away_entrant_id: "e4" }),
    F({
      id: "final",
      round_no: 2,
      seq_in_round: 1,
      home_slot_label: { key: "slot.winner_group", params: { g: "A" } },
      away_slot_label: { key: "slot.runner_up_group", params: { g: "B" } },
    }),
  ],
  standings: [],
  entrants: [
    E({ id: "e1", display_name: "Lions" }),
    E({ id: "e2", display_name: "Tigers", seed: 2 }),
    E({ id: "e3", display_name: "Bears", seed: 3 }),
    E({ id: "e4", display_name: "Wolves", seed: 4 }),
  ],
  tz: "UTC",
};

/** The shape the poster used to print blank: a final whose two seats have NO
 *  stored label and are fed by their OWN stage's semis. `KNOCKOUT_DRAW` above
 *  cannot see this — its final carries stored group labels, which win under
 *  `seatLabel`'s precedence and hide the question entirely. */
const SIBLING_FED_DRAW = {
  stages: [
    { id: "s1", division_id: "d1", seq: 1, kind: "knockout" as const, name: "Cup", status: "setup" },
  ],
  pools: [],
  fixtures: [
    F({
      id: "semi1",
      round_no: 1,
      seq_in_round: 1,
      home_entrant_id: "e1",
      away_entrant_id: "e2",
      winner_to_fixture: "final",
      winner_to_slot: 1,
    }),
    F({
      id: "semi2",
      round_no: 1,
      seq_in_round: 2,
      home_entrant_id: "e3",
      away_entrant_id: "e4",
      winner_to_fixture: "final",
      winner_to_slot: 2,
    }),
    F({ id: "final", round_no: 2, seq_in_round: 1, is_final: true }),
  ],
  standings: [],
  entrants: [
    E({ id: "e1", display_name: "Lions" }),
    E({ id: "e2", display_name: "Tigers", seed: 2 }),
    E({ id: "e3", display_name: "Bears", seed: 3 }),
    E({ id: "e4", display_name: "Wolves", seed: 4 }),
  ],
  tz: "UTC",
};

const NO_FIXTURES_DRAW = {
  stages: [],
  pools: [],
  fixtures: [],
  standings: [],
  entrants: [],
  tz: "UTC",
};

/** A single no-pool league stage big enough to force drawDrawPages' OWN
 *  `ensureSpace` to add a SECOND draw page (a third physical page overall) —
 *  see the "spans 3+ physical pages" describe block below for why this size
 *  specifically matters. round_no/seq_in_round need not form a realistic
 *  round-robin schedule; buildDrawModel only groups by them. */
const BIG_LEAGUE_ROUNDS = 40;
const BIG_LEAGUE_PER_ROUND = 6;
function bigLeagueDraw() {
  const fixtures: PublicFixture[] = [];
  for (let r = 1; r <= BIG_LEAGUE_ROUNDS; r++) {
    for (let s = 1; s <= BIG_LEAGUE_PER_ROUND; s++) {
      const isLast = r === BIG_LEAGUE_ROUNDS && s === BIG_LEAGUE_PER_ROUND;
      fixtures.push(
        F({
          id: `r${r}f${s}`,
          round_no: r,
          seq_in_round: s,
          home_entrant_id: isLast ? "eLast" : "e1",
          away_entrant_id: "e2",
        }),
      );
    }
  }
  return {
    stages: [{ id: "s1", division_id: "d1", seq: 1, kind: "league" as const, name: "Marathon League", status: "active" }],
    pools: [],
    fixtures,
    standings: [],
    entrants: [
      E({ id: "e1", display_name: "Team A" }),
      E({ id: "e2", display_name: "Team B", seed: 2 }),
      E({ id: "eLast", display_name: "Final Round Team", seed: 3 }),
    ],
    tz: "UTC",
  };
}

const get = async (
  qs = "",
  org = "test-org",
  comp = "test-comp",
): Promise<{ status: number; buf: Buffer }> => {
  const { GET } = await import("../route");
  const res = await GET(new Request(`http://t/shared/${org}/${comp}/poster.pdf${qs}`), {
    params: Promise.resolve({ orgSlug: org, competitionSlug: comp }),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, buf };
};

describe("GET .../poster.pdf — no fixtures anywhere (regression: page 1 unchanged)", () => {
  it("a competition with a division but zero fixtures still renders exactly one page", async () => {
    getPublicCompetition.mockResolvedValue({
      org: ORG("en"),
      competition: COMPETITION,
      divisions: [DIVISION()],
      liveNow: [],
    });
    getPublicDivision.mockResolvedValue({
      org: ORG("en"),
      competition: COMPETITION,
      division: DIVISION(),
      ...NO_FIXTURES_DRAW,
    });

    const { status, buf } = await get();
    expect(status).toBe(200);
    expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(decodePdfPageCount(buf)).toBe(1);
  });

  it("a competition with NO divisions at all (never reaches getPublicDivision) still renders one page", async () => {
    getPublicCompetition.mockResolvedValue({
      org: ORG("en"),
      competition: COMPETITION,
      divisions: [],
      liveNow: [],
    });

    const { status, buf } = await get();
    expect(status).toBe(200);
    expect(decodePdfPageCount(buf)).toBe(1);
    expect(getPublicDivision).not.toHaveBeenCalled();
  });
});

describe("GET .../poster.pdf — day-one fixtures add the draw from page 2", () => {
  it("a 4-entrant knockout with an unresolved final adds at least one more page", async () => {
    getPublicCompetition.mockResolvedValue({
      org: ORG("en"),
      competition: COMPETITION,
      divisions: [DIVISION()],
      liveNow: [],
    });
    getPublicDivision.mockResolvedValue({
      org: ORG("en"),
      competition: COMPETITION,
      division: DIVISION(),
      ...KNOCKOUT_DRAW,
    });

    const { status, buf } = await get();
    expect(status).toBe(200);
    expect(decodePdfPageCount(buf)).toBeGreaterThan(1);
  });

  it("the day-one final's slot labels reach the rendered page as real text, resolved the same way the board does", async () => {
    getPublicCompetition.mockResolvedValue({
      org: ORG("en"),
      competition: COMPETITION,
      divisions: [DIVISION()],
      liveNow: [],
    });
    getPublicDivision.mockResolvedValue({
      org: ORG("en"),
      competition: COMPETITION,
      division: DIVISION(),
      ...KNOCKOUT_DRAW,
    });

    const { buf } = await get();
    const text = decodePdfText(buf);
    expect(text).toContain("Winner of Group A");
    expect(text).toContain("Runner-up of Group B");
    // …and the resolved semis carry real names, not a placeholder.
    expect(text).toContain("Lions");
    expect(text).toContain("Tigers");
  });

  it("resolves the draw's slot labels in the ORG's own locale (es), not hardcoded English", async () => {
    getPublicCompetition.mockResolvedValue({
      org: ORG("es"),
      competition: COMPETITION,
      divisions: [DIVISION()],
      liveNow: [],
    });
    getPublicDivision.mockResolvedValue({
      org: ORG("es"),
      competition: COMPETITION,
      division: DIVISION(),
      ...KNOCKOUT_DRAW,
    });

    const { status, buf } = await get();
    expect(status).toBe(200);
    const text = decodePdfText(buf);
    expect(text).toContain("Ganador del Grupo A");
    expect(text).toContain("Subcampeón del Grupo B");
    expect(text).not.toContain("Winner of Group");
  });

  it("renders each fixture row's 'vs' separator through the org's own locale too — French 'contre', never the English literal", async () => {
    // Review gap (2026-08-24): drawDrawPages() used to hardcode the English
    // word "vs" between the two sides instead of looking it up, so a French
    // org's poster printed the wrong word on every fixture row. The other
    // fr-locale test above (NO_FIXTURES_DRAW) can't catch this — it never
    // renders a fixture row at all.
    getPublicCompetition.mockResolvedValue({
      org: ORG("fr"),
      competition: COMPETITION,
      divisions: [DIVISION()],
      liveNow: [],
    });
    getPublicDivision.mockResolvedValue({
      org: ORG("fr"),
      competition: COMPETITION,
      division: DIVISION(),
      ...KNOCKOUT_DRAW,
    });

    const { status, buf } = await get();
    expect(status).toBe(200);
    const text = decodePdfText(buf);
    expect(text).toContain("contre");
    expect(text).not.toContain("vs");
  });
});

describe("GET .../poster.pdf — a sibling-fed seat is NAMED, not left blank", () => {
  // The poster resolved seats with `resolveSlotLabel` alone, so a seat with no
  // STORED label printed "TBD" while the bracket, the hub, the match centre
  // and the embed all said "Winner of Semi-finals, match 1" for the same
  // match. A spectator holding the printed sheet beside the page its QR code
  // opens saw two different answers.
  //
  // Both assertions are needed and neither replaces the other: the positive
  // proves the public sentence arrives, the negative proves the old TBD is
  // gone. A test with only the positive would pass on a page that printed
  // both.
  const mockDraw = () => {
    getPublicCompetition.mockResolvedValue({
      org: ORG("en"),
      competition: COMPETITION,
      divisions: [DIVISION()],
      liveNow: [],
    });
    getPublicDivision.mockResolvedValue({
      org: ORG("en"),
      competition: COMPETITION,
      division: DIVISION(),
      ...SIBLING_FED_DRAW,
    });
  };

  it("prints the public feeder sentence for the final's two seats, not the TBD word", async () => {
    mockDraw();
    const dict = await getDictionary("en", "public");
    // DERIVED from the dictionaries, never typed here — so moving the wording
    // moves this test with it instead of leaving it asserting yesterday's copy.
    const round = msgFor("en", "bracket.round.semi");
    const first = t(dict, "knockout.feederWinner", { round, seq: 1 });
    const second = t(dict, "knockout.feederWinner", { round, seq: 2 });
    const tbd = msgFor("en", "schedule.tbd");
    // The premise, stated rather than assumed: the sentence this test looks
    // for is not the word it also requires to be absent.
    expect(first, "the premise: the feeder sentence IS the tbd word").not.toBe(tbd);

    const text = decodePdfText(await get().then((r) => r.buf));
    expect(text, "the poster lost the final's first feeder").toContain(first);
    expect(text, "the poster lost the final's second feeder").toContain(second);
    expect(text, "the poster still prints TBD for a seat it can name").not.toContain(tbd);
  });

  it("leaves a STORED label's words alone — only the blank seat is filled", async () => {
    // The half the owner deferred, pinned so it cannot drift by accident.
    //
    // This is the regression CI caught and every unit test here missed: the
    // first fix resolved BOTH halves through the public namer, which reworded
    // a stored `slot.winner_match` from the board's "Winner of R1-1" into
    // "Winner of Semi-finals, match 1". `e2e/poster-pdf-draw.spec.ts` reds on
    // that; nothing local did, because the fixture above has no stored label
    // for the namer to overwrite. A seat with one is the missing case.
    getPublicCompetition.mockResolvedValue({
      org: ORG("en"),
      competition: COMPETITION,
      divisions: [DIVISION()],
      liveNow: [],
    });
    getPublicDivision.mockResolvedValue({
      org: ORG("en"),
      competition: COMPETITION,
      division: DIVISION(),
      ...SIBLING_FED_DRAW,
      fixtures: SIBLING_FED_DRAW.fixtures.map((f) =>
        f.id === "final"
          ? { ...f, home_slot_label: { key: "slot.winner_match" as const, params: { round: 1, seq: 1 } } }
          : f,
      ),
    });

    // Through the production resolver, not a hand-built msgFor call:
    // `slot.winner_match`'s `{ext}` is composed INSIDE resolveSlotLabel from
    // {round, seq}, so spelling the expectation by hand yields the raw
    // "Winner of {ext}" and proves nothing.
    const board = resolveSlotLabel(
      { key: "slot.winner_match", params: { round: 1, seq: 1 } },
      (k, v) => msgFor("en", k, v),
      "schedule.tbd",
    );
    const publicWords = t(await getDictionary("en", "public"), "knockout.feederWinner", {
      round: msgFor("en", "bracket.round.semi"),
      seq: 1,
    });
    // The premise: the two vocabularies really do differ, or this test cannot
    // witness the regression it exists for.
    expect(board, "the premise: board and public words are the same string").not.toBe(publicWords);

    const text = decodePdfText(await get().then((r) => r.buf));
    expect(text, "a stored label lost the words it has always printed").toContain(board);
    expect(text, "the namer reworded a STORED label — that is the deferred half").not.toContain(
      publicWords,
    );
  });

  it("says it in the org's own locale, so the fix is not an English accident", async () => {
    getPublicCompetition.mockResolvedValue({
      org: ORG("fr"),
      competition: COMPETITION,
      divisions: [DIVISION()],
      liveNow: [],
    });
    getPublicDivision.mockResolvedValue({
      org: ORG("fr"),
      competition: COMPETITION,
      division: DIVISION(),
      ...SIBLING_FED_DRAW,
    });
    const frDict = await getDictionary("fr", "public");
    const expected = t(frDict, "knockout.feederWinner", {
      round: msgFor("fr", "bracket.round.semi"),
      seq: 1,
    });
    const english = t(await getDictionary("en", "public"), "knockout.feederWinner", {
      round: msgFor("en", "bracket.round.semi"),
      seq: 1,
    });
    expect(expected, "the premise: the fr sentence is the English one").not.toBe(english);

    const text = decodePdfText(await get().then((r) => r.buf));
    expect(text, "a French org's poster named the seat in English").toContain(expected);
  });
});

describe("GET .../poster.pdf — ?division= scopes the draw the same way it already scopes the QR", () => {
  it("requesting one division's poster renders only that division's fixtures; the other division's name never appears", async () => {
    const openDiv = DIVISION({ id: "d1", slug: "open", name: "Open Singles" });
    const reservesDiv = DIVISION({ id: "d2", slug: "reserves", name: "Reserves" });
    getPublicCompetition.mockResolvedValue({
      org: ORG("en"),
      competition: COMPETITION,
      divisions: [openDiv, reservesDiv],
      liveNow: [],
    });
    getPublicDivision.mockImplementation(
      async (_org: string, _comp: string, slug: string) =>
        slug === "open"
          ? { org: ORG("en"), competition: COMPETITION, division: openDiv, ...KNOCKOUT_DRAW }
          : { org: ORG("en"), competition: COMPETITION, division: reservesDiv, ...NO_FIXTURES_DRAW },
    );

    const scoped = await get("?division=reserves");
    expect(decodePdfPageCount(scoped.buf)).toBe(1); // reserves has no fixtures
    expect(getPublicDivision).toHaveBeenCalledWith("test-org", "test-comp", "reserves");
    expect(getPublicDivision).not.toHaveBeenCalledWith("test-org", "test-comp", "open");

    getPublicDivision.mockClear();
    const scopedOpen = await get("?division=open");
    expect(decodePdfPageCount(scopedOpen.buf)).toBeGreaterThan(1); // open's final is day-one
    expect(getPublicDivision).toHaveBeenCalledWith("test-org", "test-comp", "open");
    expect(getPublicDivision).not.toHaveBeenCalledWith("test-org", "test-comp", "reserves");
  });

  it("no ?division= renders every division's draw — the reserves' own section heading appears", async () => {
    const openDiv = DIVISION({ id: "d1", slug: "open", name: "Open Singles" });
    const reservesDiv = DIVISION({ id: "d2", slug: "reserves", name: "Reserves" });
    getPublicCompetition.mockResolvedValue({
      org: ORG("en"),
      competition: COMPETITION,
      divisions: [openDiv, reservesDiv],
      liveNow: [],
    });
    getPublicDivision.mockImplementation(
      async (_org: string, _comp: string, slug: string) =>
        slug === "open"
          ? { org: ORG("en"), competition: COMPETITION, division: openDiv, ...KNOCKOUT_DRAW }
          : {
              org: ORG("en"),
              competition: COMPETITION,
              division: reservesDiv,
              stages: [{ id: "s2", division_id: "d2", seq: 1, kind: "league" as const, name: "League", status: "setup" }],
              pools: [],
              fixtures: [F({ id: "res1", stage_id: "s2", home_entrant_id: "e1", away_entrant_id: "e2" })],
              standings: [],
              entrants: [E({ id: "e1", display_name: "Reserve A" }), E({ id: "e2", display_name: "Reserve B", seed: 2 })],
              tz: "UTC",
            },
    );

    const { buf } = await get();
    const text = decodePdfText(buf);
    expect(text).toContain("Reserves");
    expect(text).toContain("Reserve A");
    expect(text).toContain("Open Singles");
  });
});

describe("GET .../poster.pdf — page 1 copy resolves through the org's own locale", () => {
  it("the former hardcoded 'Scan to follow live' / subtitle resolve in French, not English", async () => {
    getPublicCompetition.mockResolvedValue({
      org: ORG("fr"),
      competition: COMPETITION,
      divisions: [DIVISION()],
      liveNow: [],
    });
    getPublicDivision.mockResolvedValue({
      org: ORG("fr"),
      competition: COMPETITION,
      division: DIVISION(),
      ...NO_FIXTURES_DRAW,
    });

    const { buf } = await get();
    const text = decodePdfText(buf);
    expect(text).toContain("Scannez pour suivre en direct");
    expect(text).toContain("aucune appli nécessaire");
    expect(text).not.toContain("Scan to follow live");
  });

  it("the competition dates format via the org's locale, not a hardcoded en-GB — the month name differs", async () => {
    getPublicCompetition.mockResolvedValue({
      org: ORG("fr"),
      competition: COMPETITION, // starts_on 2026-09-01, ends_on 2026-09-13
      divisions: [DIVISION()],
      liveNow: [],
    });
    getPublicDivision.mockResolvedValue({
      org: ORG("fr"),
      competition: COMPETITION,
      division: DIVISION(),
      ...NO_FIXTURES_DRAW,
    });

    const { buf } = await get();
    const text = decodePdfText(buf);
    // French month name, not English "September".
    expect(text).toContain("septembre");
    expect(text).not.toContain("September");
  });

  // Owner ruling 2026-09-16: an English org's public dates are day-month. Bare
  // "en" gave `Intl` the US "September 1, 2026"; the handout reads the order a
  // British or Irish club (and every other English org) writes.
  it("an English org's dates read day-month, not the US month-day bare 'en' gives Intl", async () => {
    getPublicCompetition.mockResolvedValue({
      org: ORG("en"),
      competition: COMPETITION, // starts_on 2026-09-01, ends_on 2026-09-13
      divisions: [DIVISION()],
      liveNow: [],
    });
    getPublicDivision.mockResolvedValue({
      org: ORG("en"),
      competition: COMPETITION,
      division: DIVISION(),
      ...NO_FIXTURES_DRAW,
    });

    const text = decodePdfText((await get()).buf);
    expect(text).toContain("1 September 2026");
    expect(text).toContain("13 September 2026");
    expect(text).not.toContain("September 1, 2026");
  });

  // ── THE PRINTED DATES ARE CALENDAR DAYS ─────────────────────────────────
  // `competition.starts_on`/`ends_on` are pg `date` columns — wall-clock days,
  // not instants. `new Date("2026-09-01")` is UTC MIDNIGHT, so formatting it
  // with no `timeZone` formats in whatever zone the Node process runs in, and
  // every zone behind UTC prints the day before. Measured on COMPETITION's
  // own start date, in this route's French locale:
  //
  //     UTC                  1 septembre 2026
  //     America/New_York    31 août 2026        <-- wrong day, wrong MONTH
  //
  // This is the printed handout, so a US-hosted render puts the wrong date on
  // paper. The same rule is written out at length on
  // `components/public-site/matches-hub/info-tab.tsx`. A wall-clock day has no
  // zone to be converted INTO, so the answer is UTC, never the venue's zone.
  //
  // NOTE this route must keep its own `toLocaleDateString(locale, …)` call
  // rather than adopt `lib/format.ts`'s `fmtDate`: that helper pins
  // `LOCALE = "en-GB"` internally and takes no locale parameter, so using it
  // here would silently drop the localised month names the test above pins.
  it("prints the calendar days the organiser typed, not the day before them", async () => {
    getPublicCompetition.mockResolvedValue({
      org: ORG("fr"),
      competition: COMPETITION, // starts_on 2026-09-01, ends_on 2026-09-13
      divisions: [DIVISION()],
      liveNow: [],
    });
    getPublicDivision.mockResolvedValue({
      org: ORG("fr"),
      competition: COMPETITION,
      division: DIVISION(),
      ...NO_FIXTURES_DRAW,
    });

    const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "long", year: "numeric" };
    const dayIn = (tz: string, iso: string) =>
      new Date(iso).toLocaleDateString("fr", { ...opts, timeZone: tz });

    // The fixture is PROVEN differential rather than assumed: if these two ever
    // agreed, everything below would pass on a route formatting in the wrong
    // zone.
    expect(
      dayIn("America/New_York", "2026-09-01"),
      "the premise: this date really does read as a different day in New York",
    ).not.toBe(dayIn("UTC", "2026-09-01"));

    const { buf } = await get();
    const text = decodePdfText(buf);

    // Spacing-tolerant: pdfkit may split a drawn line across text operators.
    const flexible = (s: string) => new RegExp(s.replace(/\s+/g, "\\s*"));
    expect(text).toMatch(flexible(dayIn("UTC", "2026-09-01")));
    expect(text).toMatch(flexible(dayIn("UTC", "2026-09-13")));

    // The wrong day lands in a different MONTH here, so this negative is
    // immune to how pdfkit broke the line up.
    expect(text).not.toContain("août");
  });

  // ── THE GUARD THAT WORKS AT EVERY RUNNER ZONE ───────────────────────────
  // Everything above compares RENDERED DAYS, and a rendered day cannot
  // distinguish the two implementations on a process at or ahead of UTC.
  // `ci.yml`'s test job is `ubuntu-latest` with no `TZ`, i.e. UTC, so every
  // assertion above passes in the broken state there. A guard that only works
  // when an environment variable happens to be set is a guard someone deletes.
  //
  // So assert the MECHANISM instead. This route keeps its own
  // `toLocaleDateString` call (see the note above on why it cannot use
  // `fmtDate`), so the contract is not "never called" — it is "never called
  // WITHOUT an explicit zone", which separates the two implementations at any
  // runner zone.
  it("formats the poster's dates in an explicit UTC zone, whatever zone the process runs in", async () => {
    getPublicCompetition.mockResolvedValue({
      org: ORG("fr"),
      competition: COMPETITION,
      divisions: [DIVISION()],
      liveNow: [],
    });
    getPublicDivision.mockResolvedValue({
      org: ORG("fr"),
      competition: COMPETITION,
      division: DIVISION(),
      ...NO_FIXTURES_DRAW,
    });

    const seen: (Intl.DateTimeFormatOptions | undefined)[] = [];
    const real = Date.prototype.toLocaleDateString;
    const spy = vi
      .spyOn(Date.prototype, "toLocaleDateString")
      .mockImplementation(function (this: Date, l?: unknown, o?: Intl.DateTimeFormatOptions) {
        seen.push(o);
        return real.call(this, l as string | undefined, o);
      });
    try {
      await get();
    } finally {
      // Restored in `finally`: a render that throws — or the first assertion
      // failing — would otherwise leave `Date.prototype` patched for every
      // test that runs after this one in this file.
      spy.mockRestore();
    }

    // Non-vacuous first: a guard that passes because the poster formatted NO
    // dates would survive deleting the date line altogether.
    expect(seen.length, "the poster really did format at least one date").toBeGreaterThan(0);
    expect(
      seen.filter((o) => o?.timeZone !== "UTC"),
      "every date this poster prints carries an explicit UTC zone",
    ).toEqual([]);
  });
});

describe("GET .../poster.pdf — a draw spanning 3+ physical pages (pdfkit page-buffer regression)", () => {
  // pdfkit only keeps the CURRENT page in its internal buffer unless
  // constructed with `bufferPages: true` — every addPage() call flushes
  // whatever was buffered before pushing the new page onto it (pdfkit's own
  // `addPage()`: `if (!this.options.bufferPages) this.flushPages()`). The
  // numeric page-footer loop at the bottom of drawDrawPages() calls
  // `doc.switchToPage()` on EVERY draw page only after the whole draw has
  // been laid out — which only works if every one of those pages is STILL
  // in the buffer at that point.
  //
  // A draw that fits on a single page 2 (any fixture count up to roughly 90
  // rows on this layout — proved live against a real 91-fixture Postgres
  // round-robin during Group D verification, and by KNOCKOUT_DRAW/the big
  // pooled fixtures above, none of which exceed one draw page) never
  // exposes this: drawDrawPages' own `ensureSpace` calls `newPage()` at
  // most once, so `pagesAdded` stays 1 and the footer loop only ever
  // touches the one page still sitting in the buffer — the same reason
  // neither the mocked route tests above nor buildDrawModel's own unit
  // tests (which never touch pdfkit) caught this. Only a draw big enough to
  // force a SECOND `newPage()` inside drawDrawPages (a third physical page
  // overall) reaches `switchToPage` for an already-flushed page and throws
  // `switchToPage(N) out of bounds, current buffer covers pages M to M` —
  // which surfaces to a spectator as an unauthenticated 500 with an empty
  // body, since the throw happens before `doc.end()` is ever reached.
  it("a 240-fixture league draw renders every page without throwing, including the final round's text", async () => {
    getPublicCompetition.mockResolvedValue({
      org: ORG("en"),
      competition: COMPETITION,
      divisions: [DIVISION()],
      liveNow: [],
    });
    getPublicDivision.mockResolvedValue({
      org: ORG("en"),
      competition: COMPETITION,
      division: DIVISION(),
      ...bigLeagueDraw(),
    });

    const { status, buf } = await get();
    expect(status).toBe(200);
    expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
    // At least: page 1 (QR) + 2 draw pages — the exact count is a layout
    // constant this test does not want to pin, but 3 is the minimum needed
    // to have ever exercised the buggy switchToPage path at all.
    expect(decodePdfPageCount(buf)).toBeGreaterThanOrEqual(3);

    const text = decodePdfText(buf);
    // Round 1 (first draw page) AND the final round (necessarily on a LATER
    // page, since a single page cannot hold all 240 rows) both decode —
    // proving every page actually reached the output stream, not just the
    // ones before the crash used to occur on.
    expect(text).toContain("Team A");
    expect(text).toContain("Final Round Team");
  });
});
