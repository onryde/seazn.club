// Public bracket (PROMPT-62 §3) — two-sided connected tree for single-elim
// shapes, existing column/ladder rendering as the fallback branch.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { Bracket } from "../bracket";
import type { SlotLabel } from "@/server/usecases/stage-seeding";
import { msgFor } from "@/lib/messages-i18n";
// P6 fix round 2, coordinator item #2: `lookup` is now compile-mandatory
// (matches Schedule's `slotLabels`) — every call below that wants the
// plain English default now passes it explicitly, msg() being exactly
// what the removed default value used to be.
import { msg } from "@/lib/messages";

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
      createElement(Bracket, { kind: "knockout", fixtures: fixtures as never, entrantNames: names, fixtureHref: href, lookup: msg }),
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
      createElement(Bracket, { kind: "stepladder", fixtures: fixtures as never, entrantNames: names, fixtureHref: href, lookup: msg }),
    );
    expect(html).not.toContain('data-bracket="two-sided"');
    expect(html).toContain("Rung 1");
  });

  it("falls back to columns when a knockout's shape isn't single-elim (partial data)", () => {
    const fixtures = [F("f1", 0, 1, "a", "b", null), F("f2", 0, 2, "c", "d", null), F("f3", 0, 3, "a", "c", null)];
    const html = renderToStaticMarkup(
      createElement(Bracket, { kind: "knockout", fixtures: fixtures as never, entrantNames: names, fixtureHref: href, lookup: msg }),
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
      createElement(Bracket, { kind: "double_elim", fixtures: fixtures as never, entrantNames: names, fixtureHref: href, lookup: msg }),
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

  it("keeps the column fallback for irregular double-elim shapes", () => {
    const fixtures = [F("f1", 1, 1, "a", "b", null), F("f2", 2, 1, "c", "d", null), F("f3", 2, 2, "a", "c", null)];
    const html = renderToStaticMarkup(
      createElement(Bracket, { kind: "double_elim", fixtures: fixtures as never, entrantNames: names, fixtureHref: href, lookup: msg }),
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
        entrantLogos: logos, fixtureHref: href, lookup: msg,
      }),
    );
    expect(html).toContain('src="https://flags.example/a.png"');
    // b has no badge and d has no entry — exactly one img chip.
    expect(html.match(/<img/g)?.length).toBe(1);
    const without = renderToStaticMarkup(
      createElement(Bracket, { kind: "knockout", fixtures: fixtures as never, entrantNames: names, fixtureHref: href, lookup: msg }),
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
      createElement(Bracket, { kind: "page_playoff", fixtures: fixtures as never, entrantNames: names, fixtureHref: href, lookup: msg }),
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
      createElement(Bracket, { kind: "knockout", fixtures: fixtures as never, entrantNames: names, fixtureHref: href, lookup: msg }),
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
      createElement(Bracket, { kind: "knockout", fixtures: fixtures as never, entrantNames: names, fixtureHref: href, lookup: msg }),
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
      createElement(Bracket, { kind: "double_elim", fixtures: fixtures as never, entrantNames: names, fixtureHref: href, lookup: msg }),
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
});
