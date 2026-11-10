// N-1 (W4 app A Task 22; owner rulings 116/117) — bracket tiles: no result drawn over a name, and no "TBD" on a
// finished bye tile.
//
// 1. The organiser's bracket (`BracketPanel`) drew a decided tile's headline `absolute right-2 top-1.5` — on top of the
//    tile's first name. A badminton headline is the engine's whole racquet scoreline ("2 — 1 · 21–15, …"), so it
//    covered most of the name it sat on. The headline now has its own row under the two names, on all four layouts.
// 2. A settled bye's empty seat is empty for good, yet every tile surface printed "TBD" for it: the public card's footer
//    (a bye has no score and no time, so it fell through to the no-time word — truth run r116, the final's footer), and
//    every seat with no stored label (the legacy double-elimination byes). Ruling 117 handed that "TBD" to W4.
//
// Node env (no DOM): structure is asserted on the markup, anchored on `="` where an attribute decides. Where the browser
// is the only judge (the real hit area at 320, with a realistic 43-character name), see
// `e2e/w4-knockout-app-a-public.spec.ts`.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

vi.mock("@/components/i18n/dict-provider", () => ({
  useMsg: () => (key: string) => key,
}));

import { BracketPanel } from "../bracket-panel";
import { Bracket, type BracketCopy } from "@/components/public-site/bracket";
import { msg } from "@/lib/messages";
import { msgFor } from "@/lib/messages-i18n";
import { resolveSlotLabel } from "@/lib/slot-label";
import { getDictionary } from "@/lib/i18n";
import { publicScheduleCopy } from "@/server/public-site/schedule-copy";
import { buildPublicDivisionSlides } from "@/server/slideshow-data";
import type { SlotLabel } from "@/server/usecases/stage-seeding";
import { foldMatchWithStoppage, type EventEnvelope } from "@seazn/engine/core";
import { builtinModules } from "@seazn/engine/sports";
import { defaultLineupPair, makeEnvelope } from "@seazn/engine/testkit";

// ── fixtures ────────────────────────────────────────────────────────────────

const FIX = (
  id: string,
  round: number,
  seq: number,
  home: string | null,
  away: string | null,
  outcome: unknown,
  status: string,
  no: number,
  homeSlotLabel: SlotLabel | null = null,
  awaySlotLabel: SlotLabel | null = null,
) => ({
  id, stage_id: "st1", division_id: "d1", pool_id: null, round_no: round,
  seq_in_round: seq, fixture_no: no, home_entrant_id: home, away_entrant_id: away,
  home_slot_label: homeSlotLabel, away_slot_label: awaySlotLabel,
  scheduled_at: null, venue: null, court_label: null, officials: null,
  status, outcome, schedule_source: null, schedule_locked: false, created_at: "",
});
type Fx = ReturnType<typeof FIX>;

/** A realistic 43-character entrant name — the length that exposed the 320 overflow class (AGENTS.md, truncate). */
const LONG = "Harbourside Shuttlers Badminton Club Ladies";
const names: Record<string, string> = { e1: LONG, e2: "Canada", e3: "Japan", e4: "Chile", e5: "Peru" };

const tileOf = (html: string, no: number): string => {
  const m = html.match(new RegExp(`<a[^>]*href="/o/org/c/cup/d/open/f/${no}"[^>]*>([\\s\\S]*?)</a>`));
  expect(m, `the tile for fixture #${no} rendered`).not.toBeNull();
  return m![1]!;
};

function consoleMarkup(fx: Fx[], extra: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    createElement(BracketPanel, {
      fixtures: fx as never,
      divisionFixtures: fx as never,
      entrantNames: names,
      orgSlug: "org", compSlug: "cup", divSlug: "open",
      ...extra,
    }),
  );
}

/** The engine's own headline for a played badminton match (setbased `summary`), from its coarse `game.summary` events —
 *  never typed here: the length is the defect, and the engine owns the scoreline. Single sport, with a reason: the
 *  tile's layout is sport-agnostic, and badminton's racquet scoreline is the longest headline shape N-1 reported. */
function badmintonHeadline(): string {
  const m = builtinModules.find((x) => x.key === "badminton");
  expect(m, "badminton is registered").toBeDefined();
  const cfg = m!.configSchema.parse({});
  const l = defaultLineupPair(m!.positions);
  const games: [number, number][] = [[21, 15], [18, 21], [21, 19]];
  const events: EventEnvelope[] = [
    makeEnvelope(1, { type: "core.start", payload: {} }),
    ...games.map(([home, away], i) => makeEnvelope(i + 2, { type: "badminton.game.summary", payload: { home, away } })),
  ];
  const folded = foldMatchWithStoppage(m as never, cfg as never, l, events);
  const headline = (m!.summary(folded.state as never) as { headline?: string } | null)?.headline;
  expect(typeof headline, "the engine wrote a headline").toBe("string");
  return headline!;
}

// ── 1. no result over a name (organiser bracket, all four layouts) ─────────────

describe("N-1: a decided tile's result has its own box, never over a name (organiser bracket)", () => {
  const WIN = (w: string, l: string) => ({ kind: "win", winner: w, loser: l });
  /** Each layout with one decided tile (`d`, fixture #1, whose top name is the 43-character one). */
  const LAYOUTS: { name: string; kind?: "stepladder" | "page_playoff"; testid: string; fx: Fx[] }[] = [
    {
      name: "knockout tree",
      testid: 'data-testid="bracket-panel"',
      fx: [FIX("d", 0, 1, "e1", "e4", WIN("e1", "e4"), "decided", 1), FIX("o", 0, 2, "e2", "e3", null, "scheduled", 2), FIX("x", 1, 1, "e1", null, null, "scheduled", 3)],
    },
    {
      name: "double elimination",
      testid: 'data-testid="bracket-panel-de"',
      fx: [
        FIX("d", 1, 1, "e1", "e2", WIN("e1", "e2"), "decided", 1), FIX("o", 1, 2, "e3", "e4", null, "scheduled", 2),
        FIX("wf", 2, 1, "e1", null, null, "scheduled", 3), FIX("l1", 5, 1, null, null, null, "scheduled", 4),
        FIX("lf", 6, 1, null, null, null, "scheduled", 5), FIX("gf", 9, 1, null, null, null, "scheduled", 6),
      ],
    },
    {
      name: "stepladder",
      kind: "stepladder",
      testid: 'data-testid="bracket-panel-ladder"',
      fx: [FIX("d", 1, 1, "e1", "e2", WIN("e1", "e2"), "decided", 1), FIX("o", 2, 1, "e1", "e3", null, "scheduled", 2), FIX("x", 3, 1, null, "e4", null, "scheduled", 3)],
    },
    {
      name: "page playoff",
      kind: "page_playoff",
      testid: 'data-testid="bracket-panel-page"',
      fx: [
        FIX("d", 1, 1, "e1", "e2", WIN("e1", "e2"), "decided", 1), FIX("o", 1, 2, "e3", "e4", null, "scheduled", 2),
        FIX("q2", 2, 1, "e2", null, null, "scheduled", 3), FIX("fin", 3, 1, "e1", null, null, "scheduled", 4),
      ],
    },
  ];

  let headline = "";
  beforeAll(() => {
    headline = badmintonHeadline();
  });

  it("the premise: the engine's badminton headline is long enough to cover a name", () => {
    // A 166px tile at 11px holds ~25 characters; the overlay hid all but the first few letters of the name under it.
    expect(headline.length, headline).toBeGreaterThanOrEqual(20);
    expect(LONG, "the realistic name is the 43 characters it says it is").toHaveLength(43);
  });

  it("all four layouts: the headline sits in its own row under both names, in normal flow — never absolutely placed", () => {
    let checked = 0;
    for (const l of LAYOUTS) {
      const html = consoleMarkup(l.fx, { ...(l.kind ? { kind: l.kind } : {}), headlines: { d: headline } });
      expect(html, `${l.name}: the layout rendered`).toContain(l.testid);
      const tile = tileOf(html, 1);
      // The headline's own element, by its anchored test id — and exactly one per decided tile.
      const box = tile.match(/<span data-testid="bracket-tile-headline"([^>]*)>([^<]*)<\/span>/);
      expect(box, `${l.name}: the headline has its own box`).not.toBeNull();
      expect(box![2], `${l.name}: it carries the engine's headline`).toBe(headline);
      expect(tile.split('data-testid="bracket-tile-headline"').length - 1, `${l.name}: one box`).toBe(1);
      const cls = box![1]!.match(/class="([^"]*)"/)?.[1] ?? "";
      expect(cls.split(/\s+/), `${l.name}: never absolutely placed (it covered the top name)`).not.toContain("absolute");
      // A long headline truncates inside its own row (the tile links to the match page, which carries the whole score).
      expect(cls.split(/\s+/), `${l.name}: truncates in its row`).toContain("truncate");
      // Its row comes AFTER both names: the names render first, then the result — so it cannot sit over the top one.
      const top = tile.indexOf(`>${LONG}<`);
      const bottom = tile.indexOf(">Canada<") >= 0 ? tile.indexOf(">Canada<") : tile.indexOf(">Chile<");
      expect(top, `${l.name}: the 43-character name rendered`).toBeGreaterThanOrEqual(0);
      expect(bottom, `${l.name}: the second name rendered`).toBeGreaterThan(top);
      expect(tile.indexOf('data-testid="bracket-tile-headline"'), `${l.name}: the result is below both names`).toBeGreaterThan(bottom);
      // And nothing in the tile is pinned to its top-right corner any more.
      expect(tile, `${l.name}: no absolute top-right overlay left`).not.toMatch(/class="[^"]*\babsolute\b[^"]*\bright-2\b/);
      checked++;
    }
    expect(checked, "anti-vacuity: every layout checked").toBe(LAYOUTS.length);
    expect(checked).toBe(4);
  });

  it("the empty case: a tile with no headline draws no result box at all", () => {
    let checked = 0;
    for (const l of LAYOUTS) {
      const html = consoleMarkup(l.fx, { ...(l.kind ? { kind: l.kind } : {}), headlines: {} });
      expect(html, `${l.name}: the layout rendered`).toContain(l.testid);
      expect(html, `${l.name}: no box without a result`).not.toContain('data-testid="bracket-tile-headline"');
      checked++;
    }
    expect(checked).toBe(4);
  });
});

// ── 2. no "TBD" on a finished bye tile ──────────────────────────────────────

/** A legacy bye: a one-seat award with no reason and NO stored label (pre-flight census: the double-elimination byes
 *  written before the bye label existed). Its empty seat has nothing to resolve, so the tile fell back to "TBD". */
const LEGACY_BYE = (winner: string) => ({ kind: "award", winner });
/** Today's bye, as `byeAward` writes it, on a seat `stages.ts` stamped with the bye label. */
const BYE = (winner: string) => ({ kind: "award", winner, loser: null, reason: "bye" });
const BYE_LABEL: SlotLabel = { key: "bracket.slot.bye", params: {} };
/** Ruling 116's walkover: the withdrawn winner's dead seat, NAMED — not a bye, and not touched here. */
const WITHDREW = (winner: string) => ({ kind: "award", winner, loser: "e5", reason: "withdrew" });

/** Each layout with a settled bye on fixture #1 (`e1` seated, the other seat empty) and, for the pair, a tile still
 *  waiting on a result with an unlabelled empty seat (#3). */
const BYE_LAYOUTS: { name: string; kind: "knockout" | "double_elim" | "stepladder" | "page_playoff"; fx: (o: unknown, label: SlotLabel | null) => Fx[] }[] = [
  {
    name: "knockout tree",
    kind: "knockout",
    fx: (o, label) => [
      FIX("b", 0, 1, "e1", null, o, "forfeited", 1, null, label),
      FIX("o", 0, 2, "e2", "e3", null, "scheduled", 2),
      FIX("w", 1, 1, "e1", null, null, "scheduled", 3),
    ],
  },
  {
    name: "double elimination",
    kind: "double_elim",
    fx: (o, label) => [
      FIX("b", 1, 1, "e1", null, o, "forfeited", 1, null, label),
      FIX("o", 1, 2, "e3", "e4", null, "scheduled", 2),
      FIX("w", 2, 1, "e1", null, null, "scheduled", 3),
      FIX("l1", 5, 1, null, null, null, "scheduled", 4),
      FIX("lf", 6, 1, null, null, null, "scheduled", 5),
      FIX("gf", 9, 1, null, null, null, "scheduled", 6),
    ],
  },
  {
    name: "stepladder",
    kind: "stepladder",
    fx: (o, label) => [
      FIX("b", 1, 1, "e1", null, o, "forfeited", 1, null, label),
      FIX("o", 2, 1, "e1", "e3", null, "scheduled", 2),
      FIX("w", 3, 1, "e4", null, null, "scheduled", 3),
    ],
  },
  {
    name: "page playoff",
    kind: "page_playoff",
    fx: (o, label) => [
      FIX("b", 1, 1, "e1", null, o, "forfeited", 1, null, label),
      FIX("o", 1, 2, "e3", "e4", null, "scheduled", 2),
      FIX("w", 2, 1, "e3", null, null, "scheduled", 3),
      FIX("fin", 3, 1, null, null, null, "scheduled", 4),
    ],
  },
];

/** The settled tie mirrored onto the other seat: each layout names its two seats at two call sites (R116-4's lesson —
 *  one seat per layout let a mutant that dropped the other call site live). */
const mirrored = (fx: Fx[]): Fx[] =>
  fx.map((f) =>
    f.status === "forfeited"
      ? { ...f, home_entrant_id: f.away_entrant_id, away_entrant_id: f.home_entrant_id, home_slot_label: f.away_slot_label, away_slot_label: f.home_slot_label }
      : f,
  );

describe("N-1: a finished bye tile reads the bye label and no TBD (organiser bracket)", () => {
  it("all four layouts, the empty seat on BOTH sides, legacy and labelled: the bye label, never bracket.tbd", () => {
    const seen = new Set<string>();
    for (const l of BYE_LAYOUTS) {
      for (const flip of [false, true]) {
        for (const [shape, outcome, label] of [["legacy", LEGACY_BYE("e1"), null], ["labelled", BYE("e1"), BYE_LABEL]] as const) {
          const fx = flip ? mirrored(l.fx(outcome, label)) : l.fx(outcome, label);
          const html = consoleMarkup(fx, l.kind === "stepladder" || l.kind === "page_playoff" ? { kind: l.kind } : {});
          const name = `${l.name}, ${shape}, empty seat ${flip ? "home" : "away"}`;
          const bye = tileOf(html, 1);
          expect(bye, `${name}: the bye's own word`).toContain(">bracket.slot.bye<");
          expect(bye, `${name}: no "to be decided" on a settled bye`).not.toContain("bracket.tbd");
          expect(bye, `${name}: the side that advanced`).toContain(`>${LONG}<`);
          // The pair: a tile still waiting on a result keeps its "to be decided" on its unlabelled empty seat — the
          // bye word is for a SETTLED bye, never for every empty seat.
          expect(tileOf(html, 3), `${name}: a waiting tile is still to be decided`).toContain(">bracket.tbd<");
          seen.add(name);
        }
      }
    }
    expect(seen.size, "4 layouts × 2 seats × 2 shapes").toBe(BYE_LAYOUTS.length * 2 * 2);
    expect(seen.size).toBe(16);
  });

  it("ruling 116's walkover is not a bye: her name in her dead seat, no bye word and no TBD", () => {
    let checked = 0;
    for (const l of BYE_LAYOUTS) {
      const html = consoleMarkup(l.fx(WITHDREW("e1"), BYE_LABEL), l.kind === "stepladder" || l.kind === "page_playoff" ? { kind: l.kind } : {});
      const tile = tileOf(html, 1);
      expect(tile, `${l.name}: her name`).toContain(">Peru<");
      expect(tile, `${l.name}: no bye word`).not.toContain("bracket.slot.bye");
      expect(tile, `${l.name}: no TBD`).not.toContain("bracket.tbd");
      checked++;
    }
    expect(checked).toBe(4);
  });
});

// ── the public card (division page, embed, hub) ─────────────────────────────

describe("N-1: a finished bye tile reads the bye label and no TBD (public bracket card)", () => {
  let copy: BracketCopy;
  beforeAll(async () => {
    copy = publicScheduleCopy(await getDictionary("en", "public"), msg);
  });
  const slotText = (_stageId: string, label: SlotLabel | null) => resolveSlotLabel(label, msg, "schedule.tbd");
  const TBD_WORDS = () => [msg("bracket.tbd"), copy.tbd];

  /** The public row shape: no score on a bye (the engine never scored it), and no time. */
  const pub = (fx: Fx[]) =>
    fx.map((f) => ({
      ...f,
      stage_id: "s",
      summary: null,
      lane: null,
      is_final: false,
      third_place: false,
      conditional: false,
    }));
  const render = (l: (typeof BYE_LAYOUTS)[number], fx: Fx[]) =>
    renderToStaticMarkup(
      createElement(Bracket, {
        kind: l.kind,
        fixtures: pub(fx) as never,
        entrantNames: names,
        fixtureHref: (id: string) => `/f/${id}`,
        lookup: msg,
        slotText,
        copy,
        tz: "UTC",
        locale: "en",
      }),
    );
  const card = (html: string, id: string): string => {
    const m = html.match(new RegExp(`<a[^>]*href="/f/${id}"[^>]*>([\\s\\S]*?)</a>`));
    expect(m, `the card for ${id} rendered`).not.toBeNull();
    return m![1]!;
  };

  it("the premise: the words this guards are real, and the bye word is not one of them", () => {
    expect(TBD_WORDS().every((w) => w.length > 0)).toBe(true);
    expect(TBD_WORDS()).not.toContain(msg("bracket.slot.bye"));
  });

  it("all four layouts, both seats, legacy and labelled: the bye word on the seat, and no TBD anywhere on the card", () => {
    const seen = new Set<string>();
    for (const l of BYE_LAYOUTS) {
      for (const flip of [false, true]) {
        for (const [shape, outcome, label] of [["legacy", LEGACY_BYE("e1"), null], ["labelled", BYE("e1"), BYE_LABEL]] as const) {
          const fx = flip ? mirrored(l.fx(outcome, label)) : l.fx(outcome, label);
          const html = render(l, fx);
          const name = `${l.name}, ${shape}, empty seat ${flip ? "home" : "away"}`;
          const bye = card(html, "b");
          expect(bye, `${name}: the bye's own word on its empty seat`).toContain(`>${msg("bracket.slot.bye")}<`);
          for (const w of TBD_WORDS()) expect(bye, `${name}: no "${w}" on a settled bye (seat or footer)`).not.toContain(`>${w}<`);
          // The pair: an untimed tile still waiting on a result keeps its footer's no-time word.
          expect(card(html, "w"), `${name}: a waiting, untimed card still says ${copy.tbd}`).toContain(`>${copy.tbd}<`);
          seen.add(name);
        }
      }
    }
    expect(seen.size, "4 layouts × 2 seats × 2 shapes").toBe(16);
  });

  it("ruling 116's walkover keeps its own words: her name and the w/o tag, no bye word, no TBD", async () => {
    const withForfeit: BracketCopy = { ...copy, forfeit: (await import("@/lib/forfeit-tag")).forfeitCopyOf((k) => k) };
    let checked = 0;
    for (const l of BYE_LAYOUTS) {
      const html = renderToStaticMarkup(
        createElement(Bracket, {
          kind: l.kind,
          fixtures: pub(l.fx(WITHDREW("e1"), BYE_LABEL)) as never,
          entrantNames: names,
          fixtureHref: (id: string) => `/f/${id}`,
          lookup: msg,
          slotText,
          copy: withForfeit,
          tz: "UTC",
          locale: "en",
        }),
      );
      const tile = card(html, "b");
      expect(tile, `${l.name}: her name`).toContain(">Peru<");
      expect(tile, `${l.name}: no bye word`).not.toContain(`>${msg("bracket.slot.bye")}<`);
      for (const w of TBD_WORDS()) expect(tile, `${l.name}: no ${w}`).not.toContain(`>${w}<`);
      checked++;
    }
    expect(checked).toBe(4);
  });
});

// ── the TV (/present) ───────────────────────────────────────────────────────

describe("N-1: a finished bye tile reads the bye label and no TBD (public /present bracket slide)", () => {
  it("a legacy, unlabelled settled bye names its empty seat with the bye word; a waiting seat stays TBD", async () => {
    let checked = 0;
    for (const flip of [false, true]) {
      const [b, o, w] = (flip ? mirrored : (x: Fx[]) => x)(BYE_LAYOUTS[0]!.fx(LEGACY_BYE("e1"), null));
      const slides = await buildPublicDivisionSlides({
        division: { id: "d1", name: "Open" },
        stages: [{ id: "st1", kind: "knockout", name: "Knockout" }],
        pools: [],
        fixtures: [b!, o!, w!].map((f) => ({ ...f, summary: null, outcome: f.outcome as never })),
        standings: [],
        entrants: Object.entries(names).map(([id, display_name]) => ({ id, display_name })),
      });
      const bracket = slides.find((s) => s.kind === "bracket") as { fixtures: { id: string; home: string | null; away: string | null }[] } | undefined;
      expect(bracket, "the knockout lays out as a bracket slide").toBeDefined();
      const bye = bracket!.fixtures.find((f) => f.id === "b")!;
      const empty = flip ? bye.home : bye.away;
      expect(empty, `empty seat ${flip ? "home" : "away"}: the bye word`).toBe(msgFor("en", "bracket.slot.bye"));
      const waiting = bracket!.fixtures.find((f) => f.id === "w")!;
      expect(waiting.away, "a waiting seat stays to be decided").toBe(msgFor("en", "bracket.tbd"));
      checked++;
    }
    expect(checked).toBe(2);
  });
});
