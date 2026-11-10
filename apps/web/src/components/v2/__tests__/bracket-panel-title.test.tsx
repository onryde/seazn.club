// W4 app B, B5b Task 13 (X-CH-1, X-CH-3, X-CH-4; owner pick 3A) - the organiser's bracket tile for a deciding final:
// "Joint winners" under ONE trophy, or a muted "Title vacant". Node env (no DOM): the markup is asserted, anchored on `="`
// where an attribute decides. The real hit area and the 43-character name at 320 are judged in the browser (the B5b
// screenshots; e2e/bracket-finish.spec.ts).
//
// The tile's labels are the dictionary's own (`bracket.jointWinners`, `bracket.titleVacant`), read from en/ui.json - never
// typed here - and `useMsg` is doubled to return the key, so a missing key shows as itself.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

vi.mock("@/components/i18n/dict-provider", () => ({ useMsg: () => (key: string) => key }));

import { BracketPanel } from "../bracket-panel";
import { finalTitleTag, TITLE_SETTLED_STATUSES } from "@/lib/final-title-tag";
import { BRACKET_SETTLED } from "@/server/public-site/champion";

const FIX = (id: string, round: number, seq: number, home: string | null, away: string | null, outcome: unknown, status: string, no: number, extra: Record<string, unknown> = {}) => ({
  id, stage_id: "st1", division_id: "d1", pool_id: null, round_no: round, seq_in_round: seq, fixture_no: no,
  home_entrant_id: home, away_entrant_id: away, home_slot_label: null, away_slot_label: null,
  scheduled_at: null, venue: null, court_label: null, officials: null, status, outcome, schedule_source: null, schedule_locked: false, created_at: "",
  ...extra,
});
type Fx = ReturnType<typeof FIX>;

const LONG = "Harbourside Shuttlers Badminton Club Ladies"; // 43 characters
const names: Record<string, string> = { e1: LONG, e2: "Canada", e3: "Japan", e4: "Chile" };
const WIN = (w: string, l: string) => ({ kind: "win", winner: w, loser: l });
const DW = { kind: "double_walkover" };
const AT = "2026-11-10T12:00:00.000Z";

const tileOf = (html: string, no: number): string => {
  const m = html.match(new RegExp(`<a[^>]*href="/o/org/c/cup/d/open/f/${no}"[^>]*>([\\s\\S]*?)</a>`));
  expect(m, `the tile for fixture #${no} rendered`).not.toBeNull();
  return m![1]!;
};
const markup = (fx: Fx[], extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(BracketPanel, { fixtures: fx as never, divisionFixtures: fx as never, entrantNames: names, orgSlug: "org", compSlug: "cup", divSlug: "open", ...extra }));

/** Each layout with its deciding final as fixture #3 (`final`); the semis are decided. `over` is what the final carries. */
interface Layout { name: string; kind?: "stepladder" | "page_playoff"; testid: string; build: (final: Partial<Fx> & Record<string, unknown>) => Fx[] }
const LAYOUTS: Layout[] = [
  {
    name: "knockout tree", testid: 'data-testid="bracket-panel"',
    build: (o) => [FIX("s1", 0, 1, "e1", "e4", WIN("e1", "e4"), "decided", 1), FIX("s2", 0, 2, "e2", "e3", WIN("e2", "e3"), "decided", 2), FIX("final", 1, 1, "e1", "e2", null, "scheduled", 3, { is_final: true, ...o })],
  },
  {
    name: "stepladder", kind: "stepladder", testid: 'data-testid="bracket-panel-ladder"',
    build: (o) => [FIX("s1", 1, 1, "e1", "e2", WIN("e1", "e2"), "decided", 1), FIX("s2", 2, 1, "e1", "e3", WIN("e1", "e3"), "decided", 2), FIX("final", 3, 1, "e1", "e4", null, "scheduled", 3, { is_final: true, ...o })],
  },
  {
    name: "page playoff", kind: "page_playoff", testid: 'data-testid="bracket-panel-page"',
    build: (o) => [FIX("s1", 1, 1, "e1", "e2", WIN("e1", "e2"), "decided", 1), FIX("s2", 1, 2, "e3", "e4", WIN("e3", "e4"), "decided", 2), FIX("q2", 2, 1, "e1", "e3", WIN("e1", "e3"), "decided", 5), FIX("final", 3, 1, "e1", "e4", null, "scheduled", 3, { is_final: true, ...o })],
  },
];

const JOINT = { status: "decided", joint_winners_at: AT, outcome: null };
const VACANT = { status: "forfeited", outcome: DW };

describe("finalTitleTag: the one reader behind every tile", () => {
  it("empty case first: a plain scheduled final, and a fixture with none of the fields, carry no tag", () => {
    expect(finalTitleTag({ is_final: true, status: "scheduled", outcome: null })).toBeNull();
    expect(finalTitleTag({ status: "decided", outcome: null })).toBeNull();
  });
  it("joint needs the ruling AND a settled status AND a deciding final; vacant needs a double walkover on one", () => {
    const base = { is_final: true, third_place: false };
    expect(finalTitleTag({ ...base, status: "decided", outcome: null, joint_winners_at: AT })).toBe("joint");
    expect(finalTitleTag({ ...base, status: "scheduled", outcome: null, joint_winners_at: AT }), "unsettled").toBeNull();
    expect(finalTitleTag({ ...base, is_final: false, status: "decided", outcome: null, joint_winners_at: AT }), "a semi").toBeNull();
    expect(finalTitleTag({ ...base, third_place: true, status: "decided", outcome: null, joint_winners_at: AT }), "bronze").toBeNull();
    expect(finalTitleTag({ ...base, status: "forfeited", outcome: DW })).toBe("vacant");
    expect(finalTitleTag({ ...base, is_final: false, status: "forfeited", outcome: DW }), "a double walkover in a semi is no vacant title").toBeNull();
    expect(finalTitleTag({ ...base, third_place: true, status: "forfeited", outcome: DW }), "nor in the bronze match").toBeNull();
    expect(finalTitleTag({ ...base, status: "decided", outcome: WIN("e1", "e2") }), "a winner is a champion, not a tag").toBeNull();
  });
  it("its settled set equals the champion reader's (one authority for which statuses settle a game)", () => {
    expect([...TITLE_SETTLED_STATUSES].sort()).toEqual([...BRACKET_SETTLED].sort());
  });
});

describe("B5b T13: the organiser's bracket final tile (pick 3A)", () => {
  it("a joint final reads 'Joint winners' under ONE trophy, in its own row below both names, on every layout", () => {
    let checked = 0;
    for (const l of LAYOUTS) {
      const html = markup(l.build(JOINT), l.kind ? { kind: l.kind } : {});
      expect(html, `${l.name}: rendered`).toContain(l.testid);
      const tile = tileOf(html, 3);
      expect(tile.split('data-testid="bracket-tile-title-joint"').length - 1, `${l.name}: one title row`).toBe(1);
      expect(tile.split("🏆").length - 1, `${l.name}: ONE trophy`).toBe(1);
      expect(tile, `${l.name}: the label`).toContain(">bracket.jointWinners<");
      expect(tile, `${l.name}: no vacant line on a joint final`).not.toContain("bracket.titleVacant");
      // Below both names (in flow), never absolutely placed over one.
      expect(tile.indexOf('data-testid="bracket-tile-title-joint"'), `${l.name}: below the names`).toBeGreaterThan(tile.indexOf(`>${LONG}<`));
      const row = tile.match(/<span data-testid="bracket-tile-title-joint" class="([^"]*)"/)?.[1] ?? "";
      expect(row.split(/\s+/), `${l.name}: in flow`).not.toContain("absolute");
      expect(tile, `${l.name}: the 43-character name is whole`).toContain(`>${LONG}<`);
      checked++;
    }
    expect(checked, "anti-vacuity: every layout").toBe(LAYOUTS.length);
  });

  it("a vacant title reads a muted 'Title vacant' with NO trophy, on every layout", () => {
    let checked = 0;
    for (const l of LAYOUTS) {
      const tile = tileOf(markup(l.build(VACANT), l.kind ? { kind: l.kind } : {}), 3);
      expect(tile, l.name).toContain('data-testid="bracket-tile-title-vacant"');
      expect(tile, l.name).toContain(">bracket.titleVacant<");
      expect(tile, `${l.name}: no trophy`).not.toContain("🏆");
      expect(tile, `${l.name}: not the joint row`).not.toContain("bracket-tile-title-joint");
      expect(tile, `${l.name}: replaces the double-walkover tag in the same slot (no second row)`).not.toContain("forfeit.tag.doubleWalkover");
      checked++;
    }
    expect(checked).toBe(LAYOUTS.length);
  });

  it("the negative pairs: an unplayed final, a final with a winner, and the SEMI of a joint bracket draw neither title", () => {
    let checked = 0;
    for (const l of LAYOUTS) {
      const open = markup(l.build({}), l.kind ? { kind: l.kind } : {});
      const won = markup(l.build({ status: "decided", outcome: WIN("e1", "e2") }), l.kind ? { kind: l.kind } : {});
      const joint = markup(l.build(JOINT), l.kind ? { kind: l.kind } : {});
      for (const [what, html, no] of [["unplayed final", open, 3], ["final with a winner", won, 3], ["semi in a joint bracket", joint, 1]] as const) {
        const tile = tileOf(html, no);
        expect(tile, `${l.name}: ${what}`).not.toContain("bracket-tile-title");
        expect(tile, `${l.name}: ${what}`).not.toContain("🏆");
      }
      checked++;
    }
    expect(checked).toBe(LAYOUTS.length);
  });

  it("a joint ruling on a fixture that is NOT a deciding final is ignored (the flag is the final's own)", () => {
    const tile = tileOf(markup(LAYOUTS[0]!.build({ ...JOINT, is_final: false })), 3);
    expect(tile).not.toContain("bracket-tile-title");
  });
});
