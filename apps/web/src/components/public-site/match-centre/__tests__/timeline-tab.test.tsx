// Spectator surface W1, Task 13 — TimelineTab static-markup tests plus the
// `localiseParams` unit tests. `environment: "node"`, real React SSR.
//
// ---------------------------------------------------------------------------
// Mutants killed (Task 13) — Timeline
// ---------------------------------------------------------------------------
//  (n) DROP THE TERM LOOKUP — `localiseParams` returns its `params` argument
//      unchanged, so an engine token reaches the reader untranslated.
//      → RED: "localiseParams maps a known token through term.*".
//
//  (o) BADGE ALWAYS — the `sideIndex !== null` guard on the side badge removed
//      (rendering `sides[0]` for a null index).
//      → RED: "the side badge appears ONLY when sideIndex is non-null".
//
// Both compile and collect (`numTotalTests` unchanged), so neither is the
// collection-break shape that reads as a survivor.
import { beforeAll, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import { MatchCentreDoc, type MatchCentreDocT } from "@/server/public-site/match-centre-schema";
import type { LiveFixtureData } from "../../live-score-data";
import { TimelineTab, localiseParams } from "../timeline-tab";
import { AWAY, HOME, line, makeDoc } from "./fixtures";

const dict = en as Dict;
const data = {} as LiveFixtureData;
const LOCALES: Record<string, Dict> = { en: en as Dict, es: es as Dict, fr: fr as Dict, nl: nl as Dict };

// Delivered newest first by `buildTimeline`; the panel must NOT re-sort.
const LINES = [
  line(9, "timeline.football.card", {
    marker: "31'",
    sideIndex: 1,
    emphasis: "strong",
    text: {
      key: "timeline.football.card",
      params: { side: "Rajasthan Rajvansh", colour: "yellow", detail: "S. Samson" },
    },
  }),
  line(5, "timeline.set.won", {
    sideIndex: 0,
    emphasis: "strong",
    text: {
      key: "timeline.set.won",
      params: { set: 1, home: 6, away: 4, winner: "Mumbai Kings" },
    },
  }),
  line(2, "timeline.football.goal", {
    marker: "23'",
    sideIndex: 0,
    emphasis: "score",
    text: { key: "timeline.football.goal", params: { side: "Mumbai Kings", detail: "R. Sharma" } },
  }),
  line(1, "timeline.core.start", { emphasis: "strong" }),
];

const FULL = makeDoc({ timeline: LINES });
const EMPTY_LIST = makeDoc({ timeline: [] });
const NULL_LIST = makeDoc({ timeline: null });

const render = (d: MatchCentreDocT): string =>
  renderToStaticMarkup(<TimelineTab doc={d} dict={dict} data={data} />);

/** Raw SSR markup with the entities React escapes decoded back — for
 *  assertions about the COPY a reader sees, not about the serialisation. */
const text = (html: string): string =>
  html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

beforeAll(() => {
  for (const d of [FULL, EMPTY_LIST, NULL_LIST]) {
    expect(MatchCentreDoc.safeParse(d).success).toBe(true);
  }
});

describe("localiseParams", () => {
  it("maps a known token through term.*", () => {
    // The BRANCH THAT TRANSLATES. `yellow` is an engine enum member that Task 7
    // puts in a param verbatim; without this it reaches a Dutch reader as
    // "yellow kaart".
    expect(localiseParams(dict, { colour: "yellow" })).toEqual({ colour: en["term.yellow"] });
    expect(localiseParams(dict, { kind: "double_fault" })).toEqual({
      kind: en["term.double_fault"],
    });
    // …in every locale, not only English.
    expect(localiseParams(LOCALES.fr, { colour: "yellow" })).toEqual({ colour: fr["term.yellow"] });
    expect(localiseParams(LOCALES.nl, { colour: "red" })).toEqual({ colour: nl["term.red"] });
    expect(localiseParams(LOCALES.es, { kind: "ue" })).toEqual({ kind: es["term.ue"] });
  });

  it("passes an unknown token through UNCHANGED", () => {
    // The OTHER branch, and the one that matters most: side names, person
    // names and free text must never be mangled by a term lookup.
    expect(localiseParams(dict, { side: "Mumbai Kings" })).toEqual({ side: "Mumbai Kings" });
    expect(localiseParams(dict, { detail: "R. Sharma" })).toEqual({ detail: "R. Sharma" });
    expect(localiseParams(dict, { outcome: "some_future_token" })).toEqual({
      outcome: "some_future_token",
    });
    // Numbers are left alone (a `term.1` lookup would be nonsense).
    expect(localiseParams(dict, { set: 1, home: 6 })).toEqual({ set: 1, home: 6 });
    // Absent params stay absent rather than becoming `{}`.
    expect(localiseParams(dict, undefined)).toBeUndefined();
  });

  it("only ENUM-VALUED param names are looked up — free text is never swapped", () => {
    // Narrowed from "any value that looks like a token": an official's note
    // reading "HT", or any single uppercase word in `{detail}`, was being
    // replaced with "Half-time". The PRODUCER decides what a param means, so
    // the name is the gate.
    expect(localiseParams(dict, { phase: "HT" })).toEqual({ phase: en["term.HT"] });
    expect(localiseParams(dict, { text: "HT" })).toEqual({ text: "HT" });
    expect(localiseParams(dict, { detail: "OT" })).toEqual({ detail: "OT" });
    expect(localiseParams(dict, { side: "HT" })).toEqual({ side: "HT" });
    // …and every name the builder DOES fill from an enum is covered.
    expect(localiseParams(dict, { colour: "yellow" })?.colour).toBe(en["term.yellow"]);
    expect(localiseParams(dict, { kind: "ace" })?.kind).toBe(en["term.ace"]);
    expect(localiseParams(dict, { to: "P2" })?.to).toBe(en["term.P2"]);
    expect(localiseParams(dict, { key: "motm" })?.key).toBe(en["term.motm"]);
  });

  it("does not mangle a side name that merely LOOKS like a token", () => {
    // `term.red` exists; a club called "Red" must still print as "Red". The
    // lookup is case-sensitive and the dictionary tokens are lower case, which
    // is what keeps these apart — asserted so a future "normalise the case"
    // tidy-up cannot land silently.
    expect(localiseParams(dict, { side: "Red" })).toEqual({ side: "Red" });
  });
});

describe("phase vocabulary", () => {
  it("`term.<phase>` matches `ui.json`'s `matchPhase.<phase>` in every locale", () => {
    // ONE product, one name per phase. The console has called it "Half-time"
    // since long before this surface existed, and `ui.json` is the authority —
    // a spectator page saying "HT" where the console says "Half-time" is the
    // drift this prevents. Derived from the intersection of the two files, so
    // a phase added to either is covered without editing this test.
    const pairs: Record<string, [Record<string, unknown>, Record<string, unknown>]> = {
      en: [en as Record<string, unknown>, enUi as Record<string, unknown>],
      es: [es as Record<string, unknown>, esUi as Record<string, unknown>],
      fr: [fr as Record<string, unknown>, frUi as Record<string, unknown>],
      nl: [nl as Record<string, unknown>, nlUi as Record<string, unknown>],
    };
    let compared = 0;
    const drift: string[] = [];
    for (const [locale, [pub, ui]] of Object.entries(pairs)) {
      const shared = Object.keys(ui)
        .filter((k) => k.startsWith("matchPhase."))
        .map((k) => k.slice("matchPhase.".length))
        .filter((phase) => typeof pub[`term.${phase}`] === "string");
      for (const phase of shared) {
        compared++;
        if (pub[`term.${phase}`] !== ui[`matchPhase.${phase}`]) {
          drift.push(`${locale}:${phase} "${String(pub[`term.${phase}`])}" vs "${String(ui[`matchPhase.${phase}`])}"`);
        }
      }
    }
    // The gate says what it compared: an empty intersection would pass silently.
    expect(compared).toBeGreaterThanOrEqual(4 * 8);
    expect(drift).toEqual([]);
  });

  it("the period labels the Sets tab needs are all present", () => {
    // `term.H1`/`H2`/`ET_H1`/`ET_H2` serve BOTH surfaces: the football period
    // marker on this timeline and `columnLabels` on the Sets table.
    for (const phase of ["H1", "H2", "ET_H1", "ET_H2", "Q1", "P1", "OT"]) {
      for (const [locale, d] of Object.entries(LOCALES)) {
        expect(typeof d[`term.${phase}`], `${locale}:${phase}`).toBe("string");
      }
    }
  });
});

describe("TimelineTab", () => {
  it("EMPTY: a null or empty timeline renders the panel container and no rows", () => {
    for (const d of [EMPTY_LIST, NULL_LIST]) {
      const html = render(d);
      expect(html).toContain('data-testid="mc-timeline"');
      expect(html).not.toContain('data-testid="mc-timeline-line-');
    }
    expect(render(FULL)).toContain('data-testid="mc-timeline-line-'); // positive pair
  });

  it("the root does NOT claim the tabpanel role — MatchCentre's wrapper owns it", () => {
    // `MatchCentre` wraps whichever panel is active in ONE element carrying
    // `role="tabpanel"`, `id="mc-tab-panel-timeline"` and `aria-labelledby`. A
    // panel that also declared them would nest two tabpanels and put the same
    // id in the document twice — so this asserts their ABSENCE, and the panel
    // keeps only its own testid.
    const html = render(FULL);
    expect(html).toContain('data-testid="mc-timeline"');
    expect(html).not.toContain('role="tabpanel"');
    expect(html).not.toContain('id="mc-tab-panel-timeline"');
    expect(html).not.toContain('aria-labelledby=');
  });

  it("renders one row per line, in the DELIVERED order — never re-sorted", () => {
    const html = render(FULL);
    // Rows are named by 1-BASED ARRAY POSITION, not `seq` — see the
    // component's note 3 (a derived line shares its cause's `seq`, so `seq`
    // cannot name a row). `LINES` is delivered newest first with seqs
    // 9, 5, 2, 1, so positions 1..4 must appear in that order and the row at
    // position 1 must be the seq-9 line's own text.
    const at = (position: number) => html.indexOf(`data-testid="mc-timeline-line-${position}"`);
    for (const position of [1, 2, 3, 4]) expect(at(position), `row ${position}`).toBeGreaterThanOrEqual(0);
    expect(at(1)).toBeLessThan(at(2));
    expect(at(2)).toBeLessThan(at(3));
    expect(at(3)).toBeLessThan(at(4));
    // Position alone cannot witness a re-sort — 1,2,3,4 come out in order
    // whatever the rows are. Anchor on CONTENT: the marker of the seq-9 line
    // (delivered first) must be in row 1, and the seq-2 line's in row 3.
    expect(html.slice(at(1), at(2))).toContain("31&#x27;");
    expect(html.slice(at(3), at(4))).toContain("23&#x27;");
  });

  it("resolves the text, localises token params and leaves names alone", () => {
    const html = render(FULL);
    expect(html).toContain("Rajasthan Rajvansh");
    expect(html).toContain("S. Samson");
    // The derived set line's numbers and side name survive untouched.
    expect(html).toContain("Set 1 to Mumbai Kings");
    expect(html).not.toContain("{side}");
    expect(html).not.toContain("{colour}");
  });

  it("a token param is localised IN THE RENDERED LINE, witnessed where the term differs from the token", () => {
    // Asserted in FRENCH deliberately. `term.yellow` is the string "yellow" in
    // English, so an English assertion is satisfied by the UNLOCALISED token
    // too and cannot witness a dropped lookup — the mutation sweep found
    // exactly that. In French the right answer ("jaune") and the wrong one
    // ("yellow") are different strings.
    const html = renderToStaticMarkup(
      <TimelineTab doc={FULL} dict={LOCALES.fr} data={data} />,
    );
    expect(fr["term.yellow"]).not.toBe("yellow"); // the differential holds
    expect(html).toContain(fr["term.yellow"]);
    expect(html).not.toContain("yellow");
    // …and a real name in the same params is still untouched.
    expect(html).toContain("Rajasthan Rajvansh");
    expect(html).toContain("S. Samson");
  });

  it("the marker column carries the sport notation as given", () => {
    const html = render(FULL);
    // Row 1 is the seq-9 card, the first line delivered — ids are the array
    // POSITION now (component note 3), not the `seq`.
    expect(html).toContain('data-testid="mc-marker-1"');
    // React SSR escapes the apostrophe in "31'" to `&#x27;`, so the raw markup
    // is decoded before asserting on the notation a reader actually sees —
    // asserting the entity instead would pin React's escaping, not the copy.
    expect(text(html)).toContain("31'");
    expect(text(html)).toContain("23'");
    // The LAST line (core.start, position 4) has no marker, so it renders no
    // marker cell content to mistake for one. This is the negative half.
    expect(html).not.toContain('data-testid="mc-marker-4"');
  });

  it("the side badge appears ONLY when sideIndex is non-null", () => {
    const html = render(FULL);
    // Row 1 (the seq-9 card) is the away side, row 3 (the seq-2 goal) the
    // home side — ids are the array POSITION now, see component note 3.
    expect(html).toContain('data-testid="mc-side-badge-1"');
    expect(html).toContain('data-testid="mc-side-badge-3"');
    expect(html).toContain(AWAY.short);
    expect(html).toContain(HOME.short);
    // …and row 4 (core.start) belongs to neither. This is the negative half.
    expect(html).not.toContain('data-testid="mc-side-badge-4"');
  });

  it("emphasis reaches the markup, and the three values are distinguishable", () => {
    const html = render(FULL);
    expect(html).toContain('data-emphasis="score"');
    expect(html).toContain('data-emphasis="strong"');
    const normalOnly = render(makeDoc({ timeline: [line(1, "timeline.core.start")] }));
    expect(normalOnly).toContain('data-emphasis="normal"');
  });

  it("no dictionary key leaks into the markup unresolved", () => {
    for (const d of [FULL, EMPTY_LIST, NULL_LIST]) {
      const html = render(d);
      expect(html).not.toContain("timeline.");
      expect(html).not.toContain("matchCentre.");
      expect(html).not.toContain("term.");
    }
  });
});

// ---------------------------------------------------------------------------
// P5 (whole-branch review) — TWO LINES CAN SHARE A `seq`.
// ---------------------------------------------------------------------------
//
// This file's own note 1 says it out loud: `buildTimeline` puts a DERIVED line
// (a set won, a period ending) immediately above the event that caused it, and
// "those two lines share a `seq`". The row testids were named off that `seq`
// anyway, so the derived line and its cause produced `mc-timeline-line-7`
// twice — a duplicate React key and an e2e selector that silently matches
// whichever came first.
//
// The fix is `commentary-tab.tsx`'s note 1b, applied to a FLAT list: the
// 1-based ARRAY POSITION, which cannot collide by construction. It also keeps
// the ids matching `/^mc-timeline-line-\d+$/`, which is how the walkthrough
// specs count rows.
describe("TimelineTab — a derived line sharing its cause's seq produces no duplicate ids", () => {
  const SHARED_SEQ_LINES = [
    // The DERIVED line: "set 1 to Mumbai Kings", emitted above its cause.
    line(7, "timeline.set.won", {
      marker: "SET",
      sideIndex: 0,
      emphasis: "strong",
      text: { key: "timeline.set.won", params: { set: 1, home: 6, away: 4, winner: "Mumbai Kings" } },
    }),
    // Its CAUSE: the rally that closed the set — same `seq`, by construction.
    line(7, "timeline.setbased.rally", {
      marker: "6-4",
      sideIndex: 1,
      emphasis: "score",
      text: { key: "timeline.setbased.rally", params: { side: "Rajasthan Rajvansh", home: 6, away: 4 } },
    }),
    line(1, "timeline.core.start", { emphasis: "strong" }),
  ];
  const SHARED_SEQ = makeDoc({ timeline: SHARED_SEQ_LINES });

  const idsWithPrefix = (html: string, prefix: string): string[] =>
    [...html.matchAll(/data-testid="([^"]+)"/g)].map((m) => m[1]!).filter((id) => id.startsWith(prefix));

  const duplicates = (ids: string[]): string[] => ids.filter((id, i) => ids.indexOf(id) !== i);

  // MUTANT KILLED (whole-branch review fix round): `const position = i + 1`
  // reverted to `const position = line.seq`, applied by hand and restored from
  // a `cp` backup of the FIXED state. `numTotalTests` stayed 534.
  // → RED: "no row, marker or side-badge testid appears twice", "the ids are
  //   the 1-BASED ARRAY POSITION, in delivered order", "renders one row per
  //   line, in the DELIVERED order", "the marker column carries the sport
  //   notation as given", "the side badge appears ONLY when sideIndex is
  //   non-null".
  it("the fixture really does collide — two lines carry the same seq", () => {
    // The premise, asserted rather than assumed (rule 5).
    expect(SHARED_SEQ_LINES[0]!.seq).toBe(SHARED_SEQ_LINES[1]!.seq);
  });

  it("no row, marker or side-badge testid appears twice", () => {
    const html = render(SHARED_SEQ);
    for (const prefix of ["mc-timeline-line-", "mc-marker-", "mc-side-badge-"]) {
      const ids = idsWithPrefix(html, prefix);
      expect(ids.length, prefix).toBeGreaterThan(0); // the probe fires at all
      expect(duplicates(ids), prefix).toEqual([]);
    }
  });

  it("the ids are the 1-BASED ARRAY POSITION, in delivered order", () => {
    const html = render(SHARED_SEQ);
    for (const i of [1, 2, 3]) expect(html, `row ${i}`).toContain(`data-testid="mc-timeline-line-${i}"`);
    // Delivered order is preserved: the derived line is row 1, its cause row 2.
    expect(html.indexOf('data-testid="mc-timeline-line-1"')).toBeLessThan(
      html.indexOf('data-testid="mc-timeline-line-2"'),
    );
    // Both of the colliding rows keep their own marker and badge.
    expect(html).toContain('data-testid="mc-marker-1"');
    expect(html).toContain('data-testid="mc-marker-2"');
    expect(html).toContain('data-testid="mc-side-badge-1"');
    expect(html).toContain('data-testid="mc-side-badge-2"');
    // The negative half — row 3 has neither a marker nor a side, so the two
    // optional cells are still conditional and not unconditionally emitted.
    expect(html).not.toContain('data-testid="mc-marker-3"');
    expect(html).not.toContain('data-testid="mc-side-badge-3"');
    // …and the ids still match the shape the walkthrough specs count on.
    expect(idsWithPrefix(html, "mc-timeline-line-").every((id) => /^mc-timeline-line-\d+$/.test(id))).toBe(true);
  });
});
