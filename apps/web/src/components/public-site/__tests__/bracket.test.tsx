// Public bracket (PROMPT-62 §3) — two-sided connected tree for single-elim
// shapes, existing column/ladder rendering as the fallback branch.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Bracket } from "../bracket";
import { BRACKET_CREST_CLASS } from "../matches-hub/bracket-crest";
import type { SlotLabel } from "@/server/usecases/stage-seeding";
import { msgFor } from "@/lib/messages-i18n";
// P6 fix round 2, coordinator item #2: `lookup` is now compile-mandatory
// (matches Schedule's `slotLabels`) — every call below that wants the
// plain English default now passes it explicitly, msg() being exactly
// what the removed default value used to be.
import { msg } from "@/lib/messages";
import { resolveSlotLabel } from "@/lib/slot-label";
import { getDictionary } from "@/lib/i18n";
import { t } from "@/lib/i18n-runtime";
import { publicRoundNamer } from "@/server/public-site/feeder-slot-label";

// R10d n4: `slotText` is compile-required: an unfilled side's text, which
// every real caller takes from the public round namer's `slot`. None of the
// cases below that pass `boardText` carry a feeder label (`slot.winner_match`
// / `slot.loser_match`), and for every other label the namer's text IS
// `resolveSlotLabel(label, lookup, "schedule.tbd")` (feeder-slot-label.ts), so
// they keep asserting what they did. The feeder sentence is pinned with the
// REAL namer in the R10d n4 describe at the end of this file.
const boardText = (_stageId: string, label: SlotLabel | null) => resolveSlotLabel(label, msg, "schedule.tbd");

const F = (
  id: string, round: number, seq: number,
  home: string | null, away: string | null,
  outcome: { kind?: string; winner?: string } | null,
  status = "scheduled",
  homeSlotLabel: SlotLabel | null = null,
  awaySlotLabel: SlotLabel | null = null,
  // F1 Task 4: the persisted round-role columns (V368/V369) — trailing and
  // optional so every pre-existing call site above keeps compiling unchanged.
  lane: "WB" | "LB" | "GF" | null = null,
  isFinal = false,
  thirdPlace = false,
  conditional = false,
) => ({
  id, division_id: "d", stage_id: "s", pool_id: null, round_no: round,
  seq_in_round: seq, home_entrant_id: home, away_entrant_id: away,
  home_slot_label: homeSlotLabel, away_slot_label: awaySlotLabel,
  scheduled_at: null, venue: null, court_label: null, status, outcome,
  summary: outcome ? { headline: "2–0" } : null,
  lane, is_final: isFinal, third_place: thirdPlace, conditional,
});

const names = { a: "Ants", b: "Bees", c: "Cats", d: "Dogs" };
const href = (id: string) => `/f/${id}`;

describe("public Bracket", () => {
  it("renders the two-sided tree for a knockout: svg connectors + centred final", () => {
    const fixtures = [
      F("f1", 0, 1, "a", "d", { kind: "win", winner: "a" }, "decided"),
      F("f2", 0, 2, "b", "c", null, "in_play"),
      F("f3", 1, 1, "a", null, null),
    ];
    const html = renderToStaticMarkup(
      createElement(Bracket, { kind: "knockout", fixtures: fixtures as never, entrantNames: names, fixtureHref: href, lookup: msg, slotText: boardText }),
    );
    expect(html).toContain("<svg");
    expect(html).toContain('data-bracket="two-sided"');
    expect(html).toContain('data-side="center"');
    expect(html).toContain("2–0");
    expect(html).toContain('href="/f/f1"');
  });

  it("keeps the column/ladder branch for stepladder shapes", () => {
    const fixtures = [
      F("f1", 1, 1, "a", "b", null),
      F("f2", 2, 1, null, "c", null),
      F("f3", 3, 1, null, "d", null),
    ];
    const html = renderToStaticMarkup(
      createElement(Bracket, { kind: "stepladder", fixtures: fixtures as never, entrantNames: names, fixtureHref: href, lookup: msg, slotText: boardText }),
    );
    expect(html).not.toContain('data-bracket="two-sided"');
    expect(html).toContain("Rung 1");
  });

  it("falls back to columns when a knockout's shape isn't single-elim (partial data)", () => {
    const fixtures = [F("f1", 0, 1, "a", "b", null), F("f2", 0, 2, "c", "d", null), F("f3", 0, 3, "a", "c", null)];
    const html = renderToStaticMarkup(
      createElement(Bracket, { kind: "knockout", fixtures: fixtures as never, entrantNames: names, fixtureHref: href, lookup: msg, slotText: boardText }),
    );
    expect(html).not.toContain('data-bracket="two-sided"');
  });

  it("renders the two-lane double-elim geometry (G1)", () => {
    // 4-entrant DE with the persisted round numbering (k=2):
    // WB rounds 1–2, LB rounds 5–6, grand final round 9.
    const fixtures = [
      F("w1", 1, 1, "a", "b", null),
      F("w2", 1, 2, "c", "d", null),
      F("wf", 2, 1, null, null, null),
      F("l1", 5, 1, null, null, null),
      F("lf", 6, 1, null, null, null),
      F("gf", 9, 1, null, null, null),
    ];
    const html = renderToStaticMarkup(
      createElement(Bracket, { kind: "double_elim", fixtures: fixtures as never, entrantNames: names, fixtureHref: href, lookup: msg, slotText: boardText }),
    );
    expect(html).toContain('data-bracket="double-elim"');
    expect(html).toContain("Winners bracket");
    expect(html).toContain("Losers bracket");
    expect(html).toContain("Grand final");
    expect(html.match(/data-lane="WB"/g)?.length).toBe(3);
    expect(html.match(/data-lane="LB"/g)?.length).toBe(2);
    expect(html.match(/data-lane="GF"/g)?.length).toBe(1);
    expect(html).toContain("<svg");
  });

  // Post-merge code review, defect 2: this component (the TREE branch,
  // taken by every WELL-FORMED double elimination) only ever labelled the
  // two LANES as a whole ("Winners bracket"/"Losers bracket") — it never
  // named individual ROUNDS via roundRoleLabel, so the flagship "name every
  // round by its role" fix never reached the shape the design's own
  // motivating bug describes (a double elimination of 8 — §2.3). Round
  // numbers below are the REAL persisted values (verified against
  // bracket-layout.test.ts's deRefs(8) + doubleElimBracket, not guessed):
  // WB 1-3, LB 7-10 with game counts [2,2,1,1], GF 14 — NOT the "irregular"
  // test below's hand-simplified LB, which is deliberately a different,
  // non-regular shape.
  it("names a REGULAR, well-formed double-elim of 8 through the tree (review finding: defect 2)", () => {
    const fixtures = [
      // WB round_no 1: quarter-finals (4 games).
      F("w1", 1, 1, null, null, null, "scheduled", null, null, "WB"),
      F("w2", 1, 2, null, null, null, "scheduled", null, null, "WB"),
      F("w3", 1, 3, null, null, null, "scheduled", null, null, "WB"),
      F("w4", 1, 4, null, null, null, "scheduled", null, null, "WB"),
      // WB round_no 2: semi-finals (2 games).
      F("w5", 2, 1, null, null, null, "scheduled", null, null, "WB"),
      F("w6", 2, 2, null, null, null, "scheduled", null, null, "WB"),
      // WB round_no 3: the winners' final (1 game) — NOT the tournament final.
      F("wf", 3, 1, null, null, null, "scheduled", null, null, "WB"),
      // LB round_no 7-8: 2 games each; round_no 9-10: 1 game each — the
      // [2,2,1,1] shape doubleElimBracket's regularity check requires for k=3.
      F("l1a", 7, 1, null, null, null, "scheduled", null, null, "LB"),
      F("l1b", 7, 2, null, null, null, "scheduled", null, null, "LB"),
      F("l2a", 8, 1, null, null, null, "scheduled", null, null, "LB"),
      F("l2b", 8, 2, null, null, null, "scheduled", null, null, "LB"),
      F("l3", 9, 1, null, null, null, "scheduled", null, null, "LB"),
      F("lf", 10, 1, null, null, null, "scheduled", null, null, "LB"),
      // GF round_no 14 (no reset game — bracketReset:false, same as deRefs(8)).
      F("gf", 14, 1, null, null, null, "scheduled", null, null, "GF", true, false, false),
    ];
    const html = renderToStaticMarkup(
      createElement(Bracket, { kind: "double_elim", fixtures: fixtures as never, entrantNames: names, fixtureHref: href, lookup: msg, slotText: boardText }),
    );
    // Confirms the TREE branch rendered, not the column fallback.
    expect(html).toContain('data-bracket="double-elim"');
    // Each WB round name appears exactly once — the original bug produced
    // several "Semi-finals"/"Final"s in one bracket by naming from match
    // count instead of position.
    expect(html.match(/>Quarter-finals</g) ?? []).toHaveLength(1);
    expect(html.match(/>Semi-finals</g) ?? []).toHaveLength(1);
    expect(html).toContain("Winners&#x27; final"); // renderToStaticMarkup escapes '
    // Each LB round name is distinct, despite two rounds sharing a game
    // count (2 games) and two more sharing another (1 game) — a count-based
    // namer would have collapsed these onto duplicate labels.
    expect(html).toContain("Losers&#x27; round 1");
    expect(html).toContain("Losers&#x27; round 2");
    expect(html).toContain("Losers&#x27; round 3");
    expect(html).toContain("Losers&#x27; final");
    expect(html).toContain("Grand final");
    // The lane headers are still present too, now sourced from lookup()
    // instead of a hardcoded literal — this test doubles as the
    // localization regression the hardcoded strings never had.
    expect(html).toContain("Winners bracket");
    expect(html).toContain("Losers bracket");
    // A double-elim never produces a bare "final" role on its own — only
    // winners_final/losers_final/grand_final (each qualified).
    expect(html.match(/>Final</g) ?? []).toHaveLength(0);
  });

  it("keeps the column fallback for irregular double-elim shapes", () => {
    const fixtures = [F("f1", 1, 1, "a", "b", null), F("f2", 2, 1, "c", "d", null), F("f3", 2, 2, "a", "c", null)];
    const html = renderToStaticMarkup(
      createElement(Bracket, { kind: "double_elim", fixtures: fixtures as never, entrantNames: names, fixtureHref: href, lookup: msg, slotText: boardText }),
    );
    expect(html).not.toContain('data-bracket="double-elim"');
  });

  it("renders badge chips in nodes when entrantLogos provides them (F4)", () => {
    const fixtures = [
      F("f1", 0, 1, "a", "d", null),
      F("f2", 0, 2, "b", "c", null),
      F("f3", 1, 1, null, null, null),
    ];
    const logos = { a: "https://flags.example/a.png", b: null };
    const html = renderToStaticMarkup(
      createElement(Bracket, {
        kind: "knockout", fixtures: fixtures as never, entrantNames: names,
        entrantLogos: logos, fixtureHref: href, lookup: msg, slotText: boardText,
      }),
    );
    expect(html).toContain('src="https://flags.example/a.png"');
    // b has no badge and d has no entry — exactly one img chip.
    expect(html.match(/<img/g)?.length).toBe(1);
    // Review N2 m3: its class is the ONE constant the hub's Draw renders too.
    expect(html).toContain(`<img src="https://flags.example/a.png" alt="" class="${BRACKET_CREST_CLASS}"/>`);
    const without = renderToStaticMarkup(
      createElement(Bracket, { kind: "knockout", fixtures: fixtures as never, entrantNames: names, fixtureHref: href, lookup: msg, slotText: boardText }),
    );
    expect(without).not.toContain("<img");
  });

  it("renders the Page-playoff card (Q1/Eliminator/Q2/Final) for page_playoff", () => {
    const fixtures = [
      F("q1", 1, 1, "a", "b", { kind: "win", winner: "a" }, "decided"),
      F("el", 1, 2, "c", "d", null, "in_play"),
      F("q2", 2, 1, "b", null, null),
      F("fin", 3, 1, "a", null, null),
    ];
    const html = renderToStaticMarkup(
      createElement(Bracket, { kind: "page_playoff", fixtures: fixtures as never, entrantNames: names, fixtureHref: href, lookup: msg, slotText: boardText }),
    );
    expect(html).toContain('data-bracket="page-playoff"');
    for (const cap of ["Qualifier 1", "Eliminator", "Qualifier 2", "Final"]) expect(html).toContain(cap);
    expect(html.match(/data-slot=/g)?.length).toBe(4);
    expect(html).toContain("<svg");
  });

  // P6/D4b task A — regression: a fixture list with a MIX of a filled
  // (real-entrant) row and an unfilled row carrying a real V360 slot label
  // must render BOTH correctly through the SAME shared resolver, against the
  // REAL en dictionary (this file's Bracket never mocks msg()/useMsg() — it
  // imports the client-safe msg() directly), not the raw "TBD" this surface
  // printed before P6. Anchored on `="` per the RSC vacuous-assertion rule:
  // a bare data-* probe would pass whether or not the label actually
  // resolved (React serialises an omitted prop as the literal string
  // "$undefined"), so every assertion below checks the actual rendered text
  // between real tags, not merely that some attribute is present.
  it("a MIX of filled and slot-labelled TBD rows both render — real dictionary, no raw \"TBD\"", () => {
    const fixtures = [
      // f1: fully decided, both sides real entrants — the "filled" row.
      F("f1", 0, 1, "a", "b", { kind: "win", winner: "a" }, "decided"),
      // f2: home real, away UNDECIDED but carries a real slot label — the
      // "TBD with a label" row (V360's descriptorLabel() shape).
      F("f2", 0, 2, "c", null, null, "scheduled", null, { key: "slot.winner_group", params: { g: "A" } }),
      // f3 (round 1, the final): BOTH sides undecided, one with a label, one
      // truly unknown — proves the null-label fallback stays distinct from
      // a resolved label in the SAME render pass.
      F("f3", 1, 1, null, null, null, "scheduled", { key: "slot.runner_up_group", params: { g: "B" } }, null),
    ];
    const html = renderToStaticMarkup(
      createElement(Bracket, { kind: "knockout", fixtures: fixtures as never, entrantNames: names, fixtureHref: href, lookup: msg, slotText: boardText }),
    );
    // Filled row: real entrant names, anchored as actual rendered text.
    expect(html).toMatch(/>Ants<\/span>/);
    expect(html).toMatch(/>Bees<\/span>/);
    // TBD-with-label rows: the REAL interpolated English text from
    // dictionaries/en/ui.json, not the bare key and not a hand-concatenated
    // string — proves the label path is live end to end on this surface.
    expect(html).toMatch(/>Winner of Group A<\/span>/);
    expect(html).toMatch(/>Runner-up of Group B<\/span>/);
    // The one truly-unknown side (f3's home) falls back to the existing
    // localized "bracket.tbd" text — still not a hardcoded literal in THIS
    // component, but genuinely equal to it in English.
    expect(html).toMatch(/>TBD<\/span>/);
    // No leaked pattern keys or unfilled {placeholder} tokens anywhere.
    expect(html).not.toContain("slot.winner_group");
    expect(html).not.toContain("slot.runner_up_group");
    expect(html).not.toMatch(/\{[a-zA-Z]+\}/);
  });

  // Fix round 1, finding #5 (MINOR): "slot.best_nth" resolves to text like
  // "Best 3 of the 3rd-place teams" — far wider than a team name — and this
  // node truncates it. Every side needs a `title` with the SAME text that
  // renders, so a pointer/keyboard user can still read the whole label.
  it("every truncated side carries a title with its own resolved text (finding #5)", () => {
    const fixtures = [
      F("f1", 0, 1, "a", "d", { kind: "win", winner: "a" }, "decided"),
      F("f2", 0, 2, "b", null, null, "scheduled", null, { key: "slot.best_nth", params: { rank: 2, nth: 3 } }),
      F("f3", 1, 1, null, null, null),
    ];
    const html = renderToStaticMarkup(
      createElement(Bracket, { kind: "knockout", fixtures: fixtures as never, entrantNames: names, fixtureHref: href, lookup: msg, slotText: boardText }),
    );
    expect(html).toContain('title="Ants"');
    expect(html).toContain('title="Dogs"');
    expect(html).toContain('title="Bees"');
    expect(html).toContain('title="Best 2 of the 3-place teams"');
  });

  // Fix round 1, finding #2 (CRITICAL): this component previously had NO way
  // to reach a real locale at all — it always resolved slot labels through
  // the client-safe English msg(), regardless of the org's own
  // default_locale. Proves the new `lookup` prop actually drives the
  // rendered text (not just accepted and ignored) — the caller (the public
  // division/embed pages) builds it from msgFor(orgLocale, …), same pattern
  // as data.ts:502-503.
  it("resolves slot labels through the injected `lookup`, not always English (finding #2)", () => {
    const fixtures = [
      F("f1", 0, 1, "a", "d", { kind: "win", winner: "a" }, "decided"),
      F("f2", 0, 2, "b", null, null, "scheduled", null, { key: "slot.winner_group", params: { g: "A" } }),
      F("f3", 1, 1, null, null, null),
    ];
    const esLookup = (k: Parameters<typeof msgFor>[1], v?: Record<string, string | number>) => msgFor("es", k, v);
    const html = renderToStaticMarkup(
      createElement(Bracket, {
        kind: "knockout",
        fixtures: fixtures as never,
        entrantNames: names,
        fixtureHref: href,
        lookup: esLookup,
        slotText: (_stageId: string, label: SlotLabel | null) => resolveSlotLabel(label, esLookup, "schedule.tbd"),
      }),
    );
    expect(html).toMatch(/>Ganador del Grupo A</); // slot.winner_group, es
    expect(html).not.toContain("Winner of Group A");
    // The genuinely-unknown side (f3) falls back through the SAME lookup —
    // es's bracket.tbd ("Por definir"), not the English default. (f3's OWN
    // scheduled_at/headline area separately and correctly renders a literal
    // "TBD" — that is FixtureCard's pre-existing, out-of-scope time-status
    // fallback, not a slot label, so this checks the SLOT specifically via
    // its title attribute rather than a blanket "no TBD anywhere" scan.)
    expect(html).toMatch(/title="Por definir"/);
    expect(html).not.toContain("bracket.tbd");
  });

  // F1 Task 4 — the bug this whole session exists to kill: naming a round by
  // its match count instead of its position. A well-formed double-elim of 8
  // takes the DoubleElim TREE branch above (which only labels lanes/GF, not
  // per-round names), so this shape is deliberately IRREGULAR — LB round
  // "l1" has 1 game where doubleElimBracket()'s regularity check expects 2 —
  // to force the SAME column fallback the pre-existing "irregular" test
  // above already proves is reachable. That is exactly where the count-based
  // namer used to live (`kind === "double_elim"` fell through to a raw
  // `Round ${round_no}`, using the persisted LANE-ENCODED number).
  it("names double-elim rounds by lane, not by match count (irregular fallback shape)", () => {
    const fixtures = [
      F("w1", 1, 1, null, null, null, "decided", null, null, "WB"),
      F("w2", 1, 2, null, null, null, "decided", null, null, "WB"),
      F("w3", 1, 3, null, null, null, "decided", null, null, "WB"),
      F("w4", 1, 4, null, null, null, "decided", null, null, "WB"),
      F("w5", 2, 1, null, null, null, "decided", null, null, "WB"),
      F("w6", 2, 2, null, null, null, "decided", null, null, "WB"),
      F("wf", 3, 1, null, null, null, "scheduled", null, null, "WB"),
      F("l1", 7, 1, null, null, null, "scheduled", null, null, "LB"),
      F("lf", 8, 1, null, null, null, "scheduled", null, null, "LB"),
      F("gf", 14, 1, null, null, null, "scheduled", null, null, "GF", true, false, false),
    ];
    const html = renderToStaticMarkup(
      createElement(Bracket, { kind: "double_elim", fixtures: fixtures as never, entrantNames: names, fixtureHref: href, lookup: msg, slotText: boardText }),
    );
    expect(html).not.toContain('data-bracket="double-elim"'); // confirms the fallback, not the tree
    expect(html).toContain("Quarter-finals"); // WB round 1 (4 games, 3 rounds out)
    expect(html).toContain("Semi-finals"); // WB round 2
    // renderToStaticMarkup HTML-escapes text nodes, so "Winners' final"
    // comes back as "Winners&#x27; final" — asserting the raw string.
    expect(html).toContain("Winners&#x27; final"); // WB round 3 — NOT the tournament final
    expect(html).toContain("Losers&#x27; round 1"); // LB round 7
    expect(html).toContain("Losers&#x27; final"); // LB round 8
    expect(html).toContain("Grand final"); // GF round 14
    // The old bug: double_elim fell through to the raw, lane-encoded
    // round_no ("Round 7", "Round 14", …) because only "knockout" had a
    // fromEnd branch. None of those numbers should appear as a round name.
    expect(html).not.toMatch(/>Round 7</);
    expect(html).not.toMatch(/>Round 14</);
    // A double-elim never produces a bare "final" role — only
    // winners_final/losers_final/grand_final — so the plain word never
    // appears on its own (only inside "Winners' final" etc).
    expect(html.match(/>Final</g) ?? []).toHaveLength(0);
  });

  // Page-playoff naming (Qualifier 1 / Eliminator / Qualifier 2 / Final) is
  // already covered end to end by "renders the Page-playoff card" above —
  // that test asserts the exact same four labels this task's PP_ROLE
  // conversion must keep producing, and it still passes unchanged, which is
  // the falsifiability proof for this file's other conversion (the
  // roundName() fallback above gets its own dedicated test since nothing
  // pre-existing exercised it for double_elim).

  // Knockout-captions gap (F1 left this the one bracket shape with NO round
  // names at all): TwoSided is the TREE branch a well-formed, regular
  // knockout actually renders through — every prior naming fix (DoubleElim,
  // PagePlayoff, the column fallback) missed it because it renders no text
  // to be wrong. A depth's L and R columns are the SAME round, so each name
  // is computed ONCE (columnRoundLabel) and rendered at both mirrored
  // x-positions — the two captions can never disagree, only ever repeat.
  it("names a REGULAR, well-formed knockout of 8 through the tree, including 3rd place", () => {
    const fixtures = [
      // Round 0: quarter-finals (4 games).
      F("q1", 0, 1, null, null, null),
      F("q2", 0, 2, null, null, null),
      F("q3", 0, 3, null, null, null),
      F("q4", 0, 4, null, null, null),
      // Round 1: semi-finals (2 games).
      F("s1", 1, 1, null, null, null),
      F("s2", 1, 2, null, null, null),
      // Round 2: the final (lowest seq) + the 3rd-place playoff (2nd seq) —
      // twoSidedBracket() places both at the centre column (bracket-layout.ts).
      F("fin", 2, 1, null, null, null, "scheduled", null, null, null, true, false, false),
      F("tp", 2, 2, null, null, null, "scheduled", null, null, null, false, true, false),
    ];
    const html = renderToStaticMarkup(
      createElement(Bracket, { kind: "knockout", fixtures: fixtures as never, entrantNames: names, fixtureHref: href, lookup: msg, slotText: boardText }),
    );
    expect(html).toContain('data-bracket="two-sided"'); // confirms the TREE branch, not the fallback
    // Each round name appears exactly TWICE — once above the L column, once
    // above the mirrored R column — never once (missing a side) and never
    // more (which would mean a depth bled into the wrong column).
    expect(html.match(/>Quarter-finals</g) ?? []).toHaveLength(2);
    expect(html.match(/>Semi-finals</g) ?? []).toHaveLength(2);
    // The centre column (the tournament final) renders exactly once.
    expect(html.match(/>Final</g) ?? []).toHaveLength(1);
    // The 3rd-place playoff — previously unlabelled entirely, the gap this
    // task exists to close — gets its own caption via roundRole()'s
    // thirdPlace early return, distinct from "Final".
    expect(html.match(/>Third place</g) ?? []).toHaveLength(1);
    expect(html.match(/data-side="center"/g) ?? []).toHaveLength(2);
  });

  it("does not render a 3rd-place caption when the knockout has no 3rd-place playoff", () => {
    const fixtures = [
      F("s1", 0, 1, "a", "b", null),
      F("s2", 0, 2, "c", "d", null),
      F("fin", 1, 1, null, null, null),
    ];
    const html = renderToStaticMarkup(
      createElement(Bracket, { kind: "knockout", fixtures: fixtures as never, entrantNames: names, fixtureHref: href, lookup: msg, slotText: boardText }),
    );
    expect(html).toContain('data-bracket="two-sided"');
    expect(html.match(/>Semi-finals</g) ?? []).toHaveLength(2);
    expect(html.match(/>Final</g) ?? []).toHaveLength(1);
    expect(html).not.toContain("Third place");
    expect(html.match(/data-side="center"/g) ?? []).toHaveLength(1);
  });

  // Layout defect (this session): at desktop the tree was clipped ~48px on
  // its right edge while the `/shared/[orgSlug]` shell's `max-w-5xl <main>`
  // left real page margin unused beside it (measured: a knockout of 8 needs
  // 1040px, main's content box is ~992px). `.bracket-bleed` (globals.css)
  // reclaims that margin without touching the shared shell. Every render
  // path in this file wraps its tree/columns in its own overflow-x-auto
  // scroller (unregressed — genuinely-too-wide brackets must still scroll),
  // so every one of them needs the class, not just the two-sided tree the
  // defect was measured on.
  it("every bracket wrapper — tree AND column fallback — carries bracket-bleed", () => {
    const twoSided = renderToStaticMarkup(
      createElement(Bracket, {
        kind: "knockout",
        fixtures: [
          F("f1", 0, 1, "a", "d", { kind: "win", winner: "a" }, "decided"),
          F("f2", 0, 2, "b", "c", null, "in_play"),
          F("f3", 1, 1, "a", null, null),
        ] as never,
        entrantNames: names, fixtureHref: href, lookup: msg, slotText: boardText,
      }),
    );
    expect(twoSided).toMatch(/class="[^"]*\bbracket-bleed\b[^"]*"[^>]*data-bracket="two-sided"/);

    const doubleElim = renderToStaticMarkup(
      createElement(Bracket, {
        kind: "double_elim",
        fixtures: [
          F("w1", 1, 1, "a", "b", null),
          F("w2", 1, 2, "c", "d", null),
          F("wf", 2, 1, null, null, null),
          F("l1", 5, 1, null, null, null),
          F("lf", 6, 1, null, null, null),
          F("gf", 9, 1, null, null, null),
        ] as never,
        entrantNames: names, fixtureHref: href, lookup: msg, slotText: boardText,
      }),
    );
    expect(doubleElim).toMatch(/class="[^"]*\bbracket-bleed\b[^"]*"[^>]*data-bracket="double-elim"/);

    const pagePlayoff = renderToStaticMarkup(
      createElement(Bracket, {
        kind: "page_playoff",
        fixtures: [
          F("q1", 1, 1, "a", "b", { kind: "win", winner: "a" }, "decided"),
          F("el", 1, 2, "c", "d", null, "in_play"),
          F("q2", 2, 1, "b", null, null),
          F("fin", 3, 1, "a", null, null),
        ] as never,
        entrantNames: names, fixtureHref: href, lookup: msg, slotText: boardText,
      }),
    );
    expect(pagePlayoff).toMatch(/class="[^"]*\bbracket-bleed\b[^"]*"[^>]*data-bracket="page-playoff"/);

    const columns = renderToStaticMarkup(
      createElement(Bracket, {
        kind: "stepladder",
        fixtures: [
          F("f1", 1, 1, "a", "b", null),
          F("f2", 2, 1, null, "c", null),
          F("f3", 3, 1, null, "d", null),
        ] as never,
        entrantNames: names, fixtureHref: href, lookup: msg, slotText: boardText,
      }),
    );
    expect(columns).not.toContain('data-bracket="two-sided"'); // confirms the fallback branch rendered
    expect(columns).toMatch(/class="[^"]*\bbracket-bleed\b[^"]*"[^>]*data-bracket="columns"/);
  });

  it("`.bracket-bleed` pins the left edge to the content column and grows width only, rightward", () => {
    // Source-level assertion, same reasoning as modal-viewport-units.test.ts
    // (adjacent __tests__ dir): renderToStaticMarkup has no layout engine —
    // nothing here can compute a real clientWidth/left — so this reads the
    // CSS rule body a revert would actually break.
    //
    // Coordinator's rebuild-measured correction: the first cut bled the
    // wrapper out symmetrically (`left: 50%` + `margin-left: calc(-50vw +
    // 1rem)`), which closed the clip but over-corrected — it pulled the
    // LEFT edge off the page's own content column (144px at a 1280
    // viewport) out to a flat 16px, so the tree hung ~128px left of its own
    // "KO" heading. The fix must leave the static left edge untouched (no
    // `position`, no `left`, no `margin-left` at all — any of those
    // reappearing is the over-correction creeping back) and grow `width`
    // only: `100%` (the containing block it already fills) plus
    // `max(0px, (100vw - 64rem) / 2)`, the shell's own half-margin past its
    // 64rem (max-w-5xl) breakpoint, clamped to 0px below it so this stays a
    // no-op under the breakpoint exactly like before.
    const css = readFileSync(
      fileURLToPath(new URL("../../../app/globals.css", import.meta.url)),
      "utf8",
    );
    const start = css.indexOf("\n  .bracket-bleed {");
    expect(start).toBeGreaterThan(-1);
    const rule = css.slice(start, css.indexOf("\n  .bottom-bar {", start));
    expect(rule).toMatch(/width:\s*calc\(100% \+ max\(0px, \(100vw - 64rem\) \/ 2\)\)/);
    // Pins the left edge as unmoved: none of the properties the symmetric
    // over-correction relied on may reappear in this rule.
    expect(rule).not.toMatch(/\bleft\s*:/);
    expect(rule).not.toMatch(/margin-left\s*:/);
    expect(rule).not.toMatch(/position\s*:\s*relative/);
  });
});

// R10d n4 — the public bracket (the embed bracket widget and the division page)
// was the last spectator surface that printed the organiser board's
// "Winner of R1·2" for a side still waiting on a match. It now takes the text
// from the public round namer, the one the hub, the match centre, the calendar
// and the schedule widget use.
describe("public Bracket — a waiting side names its feeder's ROUND (R10d n4)", () => {
  const semisThenFinal = (away: SlotLabel | null) => [
    F("s1", 1, 1, "a", "b", null),
    F("s2", 1, 2, "c", "d", null),
    F("fin", 2, 1, null, null, null, "scheduled", { key: "slot.winner_match", params: { round: 1, seq: 1 } }, away),
  ];

  it("a feeder label renders the REAL namer's round-named sentence, in the side's title and its text, never an R·code", async () => {
    const fixtures = semisThenFinal({ key: "slot.loser_match", params: { round: 1, seq: 2 } });
    const dict = await getDictionary("en", "public");
    const namer = publicRoundNamer({ ui: msg, dict, fixtures: fixtures as never, stageKind: () => "knockout" });
    const html = renderToStaticMarkup(
      createElement(Bracket, { kind: "knockout", fixtures: fixtures as never, entrantNames: names, fixtureHref: href, lookup: msg, slotText: namer.slot }),
    );
    const semi = msg("bracket.round.semi");
    const winner = t(dict, "knockout.feederWinner", { round: semi, seq: 1 });
    const loser = t(dict, "knockout.feederLoser", { round: semi, seq: 2 });
    expect(winner).toBe("Winner of Semi-finals, match\u00a01");
    expect(html).toContain(`title="${winner}"`);
    expect(html).toContain(`>${winner}</span>`);
    expect(html).toContain(`title="${loser}"`);
    expect(html).not.toMatch(/R\d+·\d+/);
  });

  it("a side with NO label keeps this surface's own bracket.tbd and never asks the namer", () => {
    const fixtures = semisThenFinal(null);
    const frLookup = (k: Parameters<typeof msgFor>[1], v?: Record<string, string | number>) => msgFor("fr", k, v);
    const asked: Array<SlotLabel | null> = [];
    const html = renderToStaticMarkup(
      createElement(Bracket, {
        kind: "knockout",
        fixtures: fixtures as never,
        entrantNames: names,
        fixtureHref: href,
        lookup: frLookup,
        slotText: (_stageId: string, label: SlotLabel | null) => {
          asked.push(label);
          return "from the namer";
        },
      }),
    );
    expect(asked, "only the labelled side reads through the namer").toEqual([
      { key: "slot.winner_match", params: { round: 1, seq: 1 } },
    ]);
    expect(html).toContain('title="from the namer"');
    // fr is one of the locales where the two differ: "À définir" vs "À déterminer".
    expect(msgFor("fr", "bracket.tbd")).not.toBe(msgFor("fr", "schedule.tbd"));
    expect(html).toContain(`title="${msgFor("fr", "bracket.tbd")}"`);
    expect(html).not.toContain(msgFor("fr", "schedule.tbd"));
  });
});
