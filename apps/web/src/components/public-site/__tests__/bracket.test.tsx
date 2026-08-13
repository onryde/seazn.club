// Public bracket (PROMPT-62 §3) — two-sided connected tree for single-elim
// shapes, existing column/ladder rendering as the fallback branch.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { Bracket } from "../bracket";
import type { SlotLabel } from "@/server/usecases/stage-seeding";

const F = (
  id: string, round: number, seq: number,
  home: string | null, away: string | null,
  outcome: { kind?: string; winner?: string } | null,
  status = "scheduled",
  homeSlotLabel: SlotLabel | null = null,
  awaySlotLabel: SlotLabel | null = null,
) => ({
  id, division_id: "d", stage_id: "s", pool_id: null, round_no: round,
  seq_in_round: seq, home_entrant_id: home, away_entrant_id: away,
  home_slot_label: homeSlotLabel, away_slot_label: awaySlotLabel,
  scheduled_at: null, venue: null, court_label: null, status, outcome,
  summary: outcome ? { headline: "2–0" } : null,
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
      createElement(Bracket, { kind: "knockout", fixtures: fixtures as never, entrantNames: names, fixtureHref: href }),
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
      createElement(Bracket, { kind: "stepladder", fixtures: fixtures as never, entrantNames: names, fixtureHref: href }),
    );
    expect(html).not.toContain('data-bracket="two-sided"');
    expect(html).toContain("Rung 1");
  });

  it("falls back to columns when a knockout's shape isn't single-elim (partial data)", () => {
    const fixtures = [F("f1", 0, 1, "a", "b", null), F("f2", 0, 2, "c", "d", null), F("f3", 0, 3, "a", "c", null)];
    const html = renderToStaticMarkup(
      createElement(Bracket, { kind: "knockout", fixtures: fixtures as never, entrantNames: names, fixtureHref: href }),
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
      createElement(Bracket, { kind: "double_elim", fixtures: fixtures as never, entrantNames: names, fixtureHref: href }),
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
      createElement(Bracket, { kind: "double_elim", fixtures: fixtures as never, entrantNames: names, fixtureHref: href }),
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
        entrantLogos: logos, fixtureHref: href,
      }),
    );
    expect(html).toContain('src="https://flags.example/a.png"');
    // b has no badge and d has no entry — exactly one img chip.
    expect(html.match(/<img/g)?.length).toBe(1);
    const without = renderToStaticMarkup(
      createElement(Bracket, { kind: "knockout", fixtures: fixtures as never, entrantNames: names, fixtureHref: href }),
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
      createElement(Bracket, { kind: "page_playoff", fixtures: fixtures as never, entrantNames: names, fixtureHref: href }),
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
      createElement(Bracket, { kind: "knockout", fixtures: fixtures as never, entrantNames: names, fixtureHref: href }),
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
});
