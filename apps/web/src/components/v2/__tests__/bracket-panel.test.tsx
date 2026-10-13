// BracketPanel (PROMPT-62 §2) — node-env test: renderToStaticMarkup only (no
// jsdom in this repo). The dict provider is mocked to identity keys.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

vi.mock("@/components/i18n/dict-provider", () => ({
  useMsg: () => (key: string) => key,
}));

import { BracketPanel } from "../bracket-panel";

// 4-team knockout: two R0 matches decided, final pending (TBD feeds resolved
// to winners? no — keep away side of final unresolved to exercise TBD).
const FIX = (
  id: string,
  round: number,
  seq: number,
  home: string | null,
  away: string | null,
  outcome: unknown,
  status: string,
  no: number,
  homeSlotLabel: { key: string; params: Record<string, unknown> } | null = null,
  awaySlotLabel: { key: string; params: Record<string, unknown> } | null = null,
) => ({
  id, stage_id: "st1", division_id: "d1", pool_id: null, round_no: round,
  seq_in_round: seq, fixture_no: no, home_entrant_id: home, away_entrant_id: away,
  home_slot_label: homeSlotLabel, away_slot_label: awaySlotLabel,
  scheduled_at: null, venue: null, court_label: null, officials: null,
  status, outcome, schedule_source: null, schedule_locked: false, created_at: "",
});

const fixtures = [
  FIX("f1", 0, 1, "e1", "e4", { kind: "win", winner: "e1", loser: "e4" }, "decided", 1),
  FIX("f2", 0, 2, "e2", "e3", null, "in_play", 2),
  FIX("f3", 1, 1, "e1", null, null, "scheduled", 3),
];

const entrantNames = { e1: "Mexico", e2: "Canada", e3: "Japan", e4: "Chile" };

function markup(extra: Partial<Parameters<typeof BracketPanel>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(BracketPanel, {
      fixtures: fixtures as never,
      // Whole-division scope for the feed-label map. These cases are all
      // single-stage, so it is the same row list; `extra` overrides both
      // together where a case supplies its own fixtures.
      divisionFixtures: (extra.fixtures ?? fixtures) as never,
      entrantNames,
      entrantBadges: { e1: "https://flags.example/mex.png" },
      headlines: { f1: "2–1" },
      orgSlug: "org", compSlug: "cup", divSlug: "open",
      ...extra,
    }),
  );
}

describe("BracketPanel", () => {
  it("renders a two-sided tree: svg connectors, centred final, winner bold, TBD feed", () => {
    const html = markup();
    expect(html).toContain("<svg");
    expect(html).toContain('data-side="center"');
    expect(html).toContain("bracket.tbd"); // unresolved away feed of the final
    expect(html).toContain("2–1"); // decided headline
    // winner emphasised, loser muted (class hooks)
    expect(html).toMatch(/font-semibold[^>]*>Mexico|Mexico<\/span>/);
    expect(html).toContain('href="/o/org/c/cup/d/open/f/1"');
    expect(html).toContain("flags.example/mex.png"); // entrant badge on the node
    expect(html).toContain("animate-live-pulse"); // in-play node pulses
  });

  it("returns null for non-bracket shapes (page falls back to the flat list)", () => {
    const ladder = [FIX("a", 0, 1, "e1", "e2", null, "scheduled", 1), FIX("b", 1, 1, null, null, null, "scheduled", 2), FIX("c", 2, 1, null, null, null, "scheduled", 3)];
    expect(markup({ fixtures: ladder as never })).toBe("");
  });

  it("renders the two-lane geometry for a double-elim shape (G8)", () => {
    // 4-entrant DE, persisted round numbering (k=2): WB 1–2, LB 5–6, GF 9.
    const de = [
      FIX("w1", 1, 1, "e1", "e2", null, "scheduled", 1),
      FIX("w2", 1, 2, "e3", "e4", null, "scheduled", 2),
      FIX("wf", 2, 1, null, null, null, "scheduled", 3),
      FIX("l1", 5, 1, null, null, null, "scheduled", 4),
      FIX("lf", 6, 1, null, null, null, "scheduled", 5),
      FIX("gf", 9, 1, null, null, null, "scheduled", 6),
    ];
    const html = markup({ fixtures: de as never });
    expect(html).toContain('data-testid="bracket-panel-de"');
    expect(html).toContain("bracket.winners");
    expect(html).toContain("bracket.losers");
    // Lane/pair annotation, deliberately left as-is (see bracket-panel.tsx's
    // own comment) -- matches the public site's untouched "Grand final"/
    // "Reset" pair rather than roundRoleLabel's list-heading phrasing.
    expect(html).toContain("bracket.grandFinal");
    expect(html.match(/data-lane="WB"/g)?.length).toBe(3);
    expect(html.match(/data-lane="LB"/g)?.length).toBe(2);
    expect(html).toContain('href="/o/org/c/cup/d/open/f/6"');
    expect(html).toContain("<svg");
  });

  // Post-merge code review, defect 2: same structural gap as the public
  // site's DoubleElim tree — this panel labelled the two LANES as a whole
  // ("bracket.winners"/"bracket.losers") but never named individual ROUNDS
  // via roundRoleLabel. Reuses the "G8" test's 4-entrant shape above (k=2):
  // WB round_no 1 (2 games) is a semi-final, round_no 2 (1 game) the
  // winners' final; LB round_no 5 is losers' round 1, round_no 6 the
  // losers' final. useMsg() is mocked to the identity function in this
  // file, so asserting the KEY (not translated text) is the faithful check
  // here, same as the G8 test's own "bracket.winners" assertion.
  it("names each round's column too, not just the two lanes (review finding: defect 2)", () => {
    const de = [
      FIX("w1", 1, 1, "e1", "e2", null, "scheduled", 1),
      FIX("w2", 1, 2, "e3", "e4", null, "scheduled", 2),
      FIX("wf", 2, 1, null, null, null, "scheduled", 3),
      FIX("l1", 5, 1, null, null, null, "scheduled", 4),
      FIX("lf", 6, 1, null, null, null, "scheduled", 5),
      FIX("gf", 9, 1, null, null, null, "scheduled", 6),
    ];
    const html = markup({ fixtures: de as never });
    expect(html).toContain("bracket.round.semi"); // WB round_no 1
    expect(html).toContain("bracket.round.winnersFinal"); // WB round_no 2
    expect(html).toContain("bracket.round.losersRound"); // LB round_no 5
    expect(html).toContain("bracket.round.losersFinal"); // LB round_no 6
    // The lane headers are still present too — this addition is additive.
    expect(html).toContain("bracket.winners");
    expect(html).toContain("bracket.losers");
  });
});

describe("BracketPanel — stepladder", () => {
  it("kind=stepladder renders the rung list with labels and fixture links", () => {
    const rungs = [
      FIX("r1", 1, 1, "e1", "e2", { kind: "win", winner: "e1" }, "decided", 1),
      FIX("r2", 2, 1, "e1", "e3", null, "scheduled", 2),
      FIX("r3", 3, 1, null, "e4", null, "scheduled", 3),
    ];
    const html = markup({ kind: "stepladder", fixtures: rungs as never });
    expect(html).toContain('data-testid="bracket-panel-ladder"');
    expect((html.match(/bracket\.round\.rung/g) ?? []).length).toBe(2); // F1: was bracket.rung
    expect(html).toContain("bracket.round.final"); // the summit match is the Final (F1: was bracket.final)
    expect(html).toContain('href="/o/org/c/cup/d/open/f/2"');
    expect(html).toContain("bracket.tbd"); // unresolved rung-3 slot
  });
});

describe("BracketPanel — page playoffs", () => {
  it("kind=page_playoff renders the four-slot card with i18n captions", () => {
    const fx = [
      FIX("q1", 1, 1, "e1", "e2", { kind: "win", winner: "e1" }, "decided", 1),
      FIX("el", 1, 2, "e3", "e4", null, "scheduled", 2),
      FIX("q2", 2, 1, "e2", null, null, "scheduled", 3),
      FIX("fin", 3, 1, "e1", null, null, "scheduled", 4),
    ];
    const html = markup({ kind: "page_playoff", fixtures: fx as never });
    expect(html).toContain('data-testid="bracket-panel-page"');
    // F1: these four moved from bracket.* to bracket.round.* (PP_ROLE).
    for (const key of ["bracket.round.qualifier1", "bracket.round.eliminator", "bracket.round.qualifier2", "bracket.round.final"]) {
      expect(html).toContain(key);
    }
    expect(html.match(/data-slot=/g)?.length).toBe(4);
    expect(html).toContain('href="/o/org/c/cup/d/open/f/3"');
  });
});

// P6/D4b task A — regression: a fixture list with a MIX of filled and
// TBD-with-a-real-label rows renders both correctly. useMsg() is mocked to
// identity in this file (line 7-9) so the assertions check that the
// CORRECT key (proving the resolver picked the right slot.* pattern and did
// not fall through to the generic null fallback) reaches the DOM, anchored
// on `="` per the RSC vacuous-assertion rule — a bare data-* probe passes
// whether React actually resolved anything (an omitted prop serialises as
// the literal string "$undefined"), so this checks real rendered text
// between real tags instead.
describe("BracketPanel — mixed filled + TBD-with-label rows (regression)", () => {
  it("a filled side and a slot-labelled TBD side render distinctly in the same tree", () => {
    const fx = [
      FIX("f1", 0, 1, "e1", "e4", { kind: "win", winner: "e1" }, "decided", 1),
      // f2 home is a real entrant; away is undecided but carries a real
      // group_rank descriptor — the "TBD with a label" row.
      FIX("f2", 0, 2, "e2", null, null, "in_play", 2, null, { key: "slot.runner_up_group", params: { g: "B" } }),
      // f3 (the final): home fed by f1's winner (still null pre-fill, no
      // label yet — the genuinely-unknown case), away has NO label either.
      FIX("f3", 1, 1, null, null, null, "scheduled", 3),
    ];
    const html = markup({ fixtures: fx as never });
    // Filled sides: real entrant names, anchored as actual rendered text.
    expect(html).toMatch(/>Mexico<\/span>|font-semibold[^>]*>Mexico</);
    expect(html).toMatch(/>Canada<\/span>/);
    // The slot-labelled TBD side: the mocked useMsg returns the key
    // unchanged, so seeing the EXACT key (not "bracket.tbd") proves
    // resolveSlotLabel chose the real label over the null fallback.
    expect(html).toContain("slot.runner_up_group");
    // The genuinely-unknown side (f3, no label at all) still falls back to
    // the existing bracket.tbd key, not a hardcoded "TBD" — and it must NOT
    // be confused with the labelled row above (both present, distinct).
    expect(html).toContain("bracket.tbd");
    // f3's two null sides — each renders its resolved text TWICE: once as
    // the `title` attribute (finding #5), once as the visible child text.
    expect((html.match(/title="bracket\.tbd"/g) ?? []).length).toBe(2);
    expect((html.match(/>bracket\.tbd</g) ?? []).length).toBe(2);
  });

  // Fix round 1, finding #5 (MINOR): a slot label like "Best 3 of the
  // 3rd-place teams" is far wider than a team name and the node truncates
  // it — every side needs a `title` so a pointer/keyboard user can still
  // read the whole thing. Anchored on the real `title="…"` attribute value,
  // not just its presence, so a `title=""` regression would still fail this.
  it("every truncated side carries a title with its own resolved text (finding #5)", () => {
    // Same shape as the mixed-rows regression above (2 semis + 1 final) —
    // a valid single-elim tree, or twoSidedBracket rejects it and the panel
    // renders nothing.
    const fx = [
      FIX("f1", 0, 1, "e1", "e4", { kind: "win", winner: "e1" }, "decided", 1),
      FIX("f2", 0, 2, "e2", null, null, "in_play", 2, null, { key: "slot.runner_up_group", params: { g: "B" } }),
      FIX("f3", 1, 1, null, null, null, "scheduled", 3),
    ];
    const html = markup({ fixtures: fx as never });
    expect(html).toContain('title="Mexico"');
    expect(html).toContain('title="Chile"');
    expect(html).toContain('title="Canada"');
    expect(html).toContain('title="slot.runner_up_group"');
  });
});

// R116-3 (W2b Task 16; owner ruling 116): a withdrawn winner's dead seat, walked over by the side that arrived, reads
// as any walkover reads — HER name, muted, beside the winner — on every organiser bracket layout, never the stored bye
// label. The pair: an award with no loser (an odd draw's bye, a double walkover's dead seat, a DQ'd winner's — all
// `loser: null`, withdrawal-w2b's `seatWalkover`) keeps the bye label. Her entrant ("Peru") sits nowhere else in each
// shape, so her name can only come from the dead seat.
describe("BracketPanel — R116-3: ruling 116's walkover names her on every layout", () => {
  const BYE_LABEL = { key: "bracket.slot.bye", params: {} };
  const names = { ...entrantNames, e5: "Peru" };
  const withdrew = (winner: string) => ({ kind: "award", winner, loser: "e5", reason: "withdrew" });
  const bye = (winner: string) => ({ kind: "award", winner, loser: null, reason: "bye" });
  /** Each layout's shape with its awarded tie: `dead` is the empty seat, `winner` the side that arrived. */
  const LAYOUTS: { name: string; kind?: string; testid: string; build: (outcome: (w: string) => unknown) => unknown[] }[] = [
    {
      name: "knockout tree",
      testid: "",
      build: (o) => [
        FIX("f1", 0, 1, "e1", "e4", { kind: "win", winner: "e1", loser: "e4" }, "decided", 1),
        FIX("f2", 0, 2, "e2", "e3", { kind: "win", winner: "e2", loser: "e3" }, "decided", 2),
        FIX("f3", 1, 1, "e1", null, o("e1"), "forfeited", 3, null, BYE_LABEL),
      ],
    },
    {
      name: "double elimination",
      testid: 'data-testid="bracket-panel-de"',
      build: (o) => [
        FIX("w1", 1, 1, "e1", "e2", { kind: "win", winner: "e1", loser: "e2" }, "decided", 1),
        FIX("w2", 1, 2, "e3", "e4", { kind: "win", winner: "e3", loser: "e4" }, "decided", 2),
        FIX("wf", 2, 1, "e1", null, o("e1"), "forfeited", 3, null, BYE_LABEL),
        FIX("l1", 5, 1, null, null, null, "scheduled", 4),
        FIX("lf", 6, 1, null, null, null, "scheduled", 5),
        FIX("gf", 9, 1, null, null, null, "scheduled", 6),
      ],
    },
    {
      name: "stepladder",
      kind: "stepladder",
      testid: 'data-testid="bracket-panel-ladder"',
      build: (o) => [
        FIX("r1", 1, 1, "e1", "e2", { kind: "win", winner: "e1" }, "decided", 1),
        FIX("r2", 2, 1, "e1", "e3", { kind: "win", winner: "e3" }, "decided", 2),
        FIX("r3", 3, 1, null, "e4", o("e4"), "forfeited", 3, BYE_LABEL, null),
      ],
    },
    {
      name: "page playoff",
      kind: "page_playoff",
      testid: 'data-testid="bracket-panel-page"',
      build: (o) => [
        FIX("q1", 1, 1, "e1", "e2", { kind: "win", winner: "e1" }, "decided", 1),
        FIX("el", 1, 2, "e3", "e4", { kind: "win", winner: "e3" }, "decided", 2),
        FIX("q2", 2, 1, "e2", "e3", { kind: "win", winner: "e3" }, "decided", 3),
        FIX("fin", 3, 1, "e1", null, o("e1"), "forfeited", 4, null, BYE_LABEL),
      ],
    },
  ];

  // R116-4: each layout names its two seats at two separate call sites, so her dead seat is driven on BOTH — the shape as
  // built, and the awarded tie mirrored (seats and their stored labels swapped). One seat per layout let a mutant that
  // dropped the reader from the other seat's call site live.
  type Fx = ReturnType<typeof FIX>;
  const mirrored = (fx: Fx[]): Fx[] =>
    fx.map((f) =>
      f.status === "forfeited"
        ? {
            ...f,
            home_entrant_id: f.away_entrant_id,
            away_entrant_id: f.home_entrant_id,
            home_slot_label: f.away_slot_label,
            away_slot_label: f.home_slot_label,
          }
        : f,
    );
  const deadSeat = (fx: Fx[]): "home" | "away" => (fx.find((f) => f.status === "forfeited")!.home_entrant_id === null ? "home" : "away");

  it("her name, never the bye label; and a bye (no loser) keeps the bye label — all four layouts, her dead seat on BOTH sides", () => {
    const seen = new Set<string>();
    for (const l of LAYOUTS) {
      for (const flip of [false, true]) {
        const shape = (o: (w: string) => unknown) => (flip ? mirrored(l.build(o) as Fx[]) : (l.build(o) as Fx[]));
        const render = (o: (w: string) => unknown) => {
          const fx = shape(o);
          return markup({ fixtures: fx as never, divisionFixtures: fx as never, entrantNames: names, ...(l.kind ? { kind: l.kind as never } : {}) });
        };
        const seat = deadSeat(shape(withdrew));
        const name = `${l.name}, her seat ${seat}`;
        const walked = render(withdrew);
        if (l.testid) expect(walked, `${name}: the layout rendered`).toContain(l.testid);
        expect(walked, `${name}: her name in her dead seat`).toContain(">Peru<");
        expect(walked, `${name}: no bye label`).not.toContain("bracket.slot.bye");
        const byed = render(bye);
        expect(byed, `${name}: the bye keeps its label`).toContain("bracket.slot.bye");
        expect(byed, `${name}: and names nobody there`).not.toContain("Peru");
        seen.add(name);
      }
    }
    // Both seats on each of the four layouts, by the seat each case actually put her in — not by the loop's count.
    expect([...seen].sort()).toEqual(
      LAYOUTS.flatMap((l) => [`${l.name}, her seat away`, `${l.name}, her seat home`]).sort(),
    );
  });
});

// Design review M-1 (audit 3.1 on the organiser's bracket): a double walkover credits nobody, but its stored summary
// carries a "0–0" headline (`listFixtureHeadlines` reads it straight from match_states), which read as an unplayed
// match. Every layout draws the tag in the headline's place, in the same muted voice; a credited headline is kept.
describe("BracketPanel — a double walkover's node shows its tag, not the 0–0 (review M-1)", () => {
  const DW = { kind: "double_walkover" };
  const WIN = (w: string, l: string) => ({ kind: "win", winner: w, loser: l });
  const LAYOUTS: { name: string; kind?: "stepladder" | "page_playoff"; testid: string; fx: ReturnType<typeof FIX>[] }[] = [
    {
      name: "knockout",
      testid: 'data-testid="bracket-panel"',
      fx: [FIX("dw", 0, 1, "e1", "e4", DW, "forfeited", 1), FIX("ok", 0, 2, "e2", "e3", WIN("e2", "e3"), "decided", 2), FIX("x", 1, 1, null, "e2", null, "scheduled", 3)],
    },
    {
      name: "double elimination",
      testid: 'data-testid="bracket-panel-de"',
      fx: [
        FIX("dw", 1, 1, "e1", "e2", DW, "forfeited", 1), FIX("ok", 1, 2, "e3", "e4", WIN("e3", "e4"), "decided", 2),
        FIX("wf", 2, 1, null, "e3", null, "scheduled", 3), FIX("l1", 5, 1, null, null, null, "scheduled", 4),
        FIX("lf", 6, 1, null, null, null, "scheduled", 5), FIX("gf", 9, 1, null, null, null, "scheduled", 6),
      ],
    },
    {
      name: "stepladder",
      kind: "stepladder",
      testid: 'data-testid="bracket-panel-ladder"',
      fx: [FIX("dw", 1, 1, "e1", "e2", DW, "forfeited", 1), FIX("ok", 2, 1, "e3", "e4", WIN("e3", "e4"), "decided", 2), FIX("x", 3, 1, null, "e3", null, "scheduled", 3)],
    },
    {
      name: "page playoff",
      kind: "page_playoff",
      testid: 'data-testid="bracket-panel-page"',
      fx: [
        FIX("dw", 1, 1, "e1", "e2", DW, "forfeited", 1), FIX("ok", 1, 2, "e3", "e4", WIN("e3", "e4"), "decided", 2),
        FIX("q2", 2, 1, null, "e3", null, "scheduled", 3), FIX("fin", 3, 1, null, null, null, "scheduled", 4),
      ],
    },
  ];
  const MUTED = "font-display text-[11px] tabular-nums text-[color:var(--app-fg-muted,#94a3b8)]";

  it("all four layouts: the tag in the headline's muted slot, once; the credited node keeps its headline", () => {
    let checked = 0;
    for (const l of LAYOUTS) {
      const html = markup({ ...(l.kind ? { kind: l.kind } : {}), fixtures: l.fx as never, headlines: { dw: "0–0", ok: "2–1" } });
      expect(html, `${l.name}: the layout rendered`).toContain(l.testid);
      expect(html, `${l.name}: the double walkover's 0–0 is gone`).not.toContain("0–0");
      expect(html, `${l.name}: its tag sits in the headline's muted slot`).toContain(`${MUTED}">forfeit.tag.doubleWalkover</span>`);
      expect(html.split("forfeit.tag.doubleWalkover").length - 1, `${l.name}: once`).toBe(1);
      expect(html, `${l.name}: the credited node keeps its headline`).toContain(`${MUTED}">2–1</span>`);
      checked++;
    }
    expect(checked).toBe(LAYOUTS.length);
    expect(checked).toBe(4);
  });

  it("the empty case: a double walkover with no stored headline still shows its tag (the result is known)", () => {
    const html = markup({ fixtures: LAYOUTS[0]!.fx as never, headlines: {} });
    expect(html.split("forfeit.tag.doubleWalkover").length - 1).toBe(1);
  });
});

