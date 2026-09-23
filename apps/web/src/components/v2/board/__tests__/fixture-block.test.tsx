// Board redesign (docs/superpowers/specs/2026-08-10-board-view-redesign-design.md):
// the card's own background becomes the division-color wash, conflicts move
// to a small icon badge instead of overwriting that background, same-code
// conflicts (two `warn.rest` entries — one per entrant — used to render as
// two identical "rest" badges) collapse into one, and the pin/lock affordance
// drops the raw emoji for a real icon. `FixtureBlock` calls `useMsg`, a real
// hook, so it is mounted with `renderToStaticMarkup` — the same pattern
// `move-panel.test.tsx` uses — never called directly as a plain function.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DictProvider } from "@/components/i18n/dict-provider";
import type { Dict } from "@/lib/i18n-constants";
import es from "@/dictionaries/es/ui.json";
import { FixtureBlock } from "../fixture-block";
import type { BoardConflict, BoardFixture } from "../types";

const esDict = es as unknown as Dict;

const fixture: BoardFixture = {
  id: "fx-1",
  stage_id: "st-1",
  division_id: "dv-1",
  round_no: 1,
  seq_in_round: 1,
  home_entrant_id: "p1",
  away_entrant_id: "p2",
  scheduled_at: "2026-08-10T11:30:00.000Z",
  venue: null,
  court_label: "Court 1",
  court_id: "crt-1",
  court_name: "Court 1",
  status: "scheduled",
  schedule_source: "manual",
  schedule_locked: false,
  outcome: null,
};

const baseProps = {
  fixture,
  divisionName: "U16 Singles",
  showDivision: false,
  entrantNames: { p1: "D", p2: "E" },
  feedLabels: {},
  fixtureTitles: {},
  // `conflicts` is a required prop on FixtureBlock (unchanged by this task);
  // tests 4 and 5 below render via `{...baseProps}` with no override, so it
  // must default to an empty array here or both the pre- and post-fix
  // component crash on `conflicts.some(...)`/`conflicts.reduce(...)` before
  // any assertion runs.
  conflicts: [] as BoardConflict[],
  canEdit: true,
  picked: false,
  onPick: () => {},
  onTogglePin: () => {},
  roundCode: undefined,
};

/** The chip's text, read off the ONE element carrying the testid. */
const chipText = (html: string) => /data-testid="board-round-code"[^>]*>([^<]*)</.exec(html)?.[1];

describe("FixtureBlock", () => {
  it("merges same-code conflicts into ONE badge instead of repeating it per entrant", () => {
    // The original bug (and the C3, 2026-08-13 design amendment's reported
    // symptom): two `warn.rest` entries (D needs rest, E needs rest) render
    // as two adjacent, indistinguishable "rest" badges — and, pre-C3, the
    // tooltip's `detail` was raw English embedding the entrant's raw UUID.
    // Structured `details` resolved through `entrantNames` fixes both: one
    // badge, and a localized, name-resolved tooltip.
    const conflicts: BoardConflict[] = [
      { fixture_id: "fx-1", code: "warn.rest", blocking: false, details: { kind: "entrant_below_rest", entrant_ids: ["p1"] } },
      { fixture_id: "fx-1", code: "warn.rest", blocking: false, details: { kind: "entrant_below_rest", entrant_ids: ["p2"] } },
    ];
    const html = renderToStaticMarkup(<FixtureBlock {...baseProps} conflicts={conflicts} />);
    expect(html.match(/>rest</g)).toHaveLength(1);
    // The "; " join, preserved from the pre-C3 raw-string join — now over
    // formatted, name-resolved text instead of raw prose.
    expect(html).toContain('title="D does not get enough rest; E does not get enough rest"');
  });

  it("keeps two DIFFERENT conflict codes as two separate badges, and never crashes on a conflict with no details", () => {
    // Both entries share the same `blocking` value on purpose — the grouping
    // key is `code`, and a case where `blocking` also happens to differ
    // would pass just as well if the code grouped by `blocking` instead.
    // Neither carries `details` (nor the deprecated `detail`) — the
    // formatter must degrade to the code-level label rather than throw.
    const conflicts: BoardConflict[] = [
      { fixture_id: "fx-1", code: "warn.rest", blocking: false },
      { fixture_id: "fx-1", code: "conflict.court", blocking: false },
    ];
    const html = renderToStaticMarkup(<FixtureBlock {...baseProps} conflicts={conflicts} />);
    expect(html.match(/>rest</g)).toHaveLength(1);
    expect(html).toContain(">court clash<");
    expect(html).not.toContain("undefined");
  });

  it("the badge tooltip names the entrant, never a raw UUID (C3, 2026-08-13 design amendment)", () => {
    // The reported symptom, byte for byte: a board conflict tooltip used to
    // render `entrant 6be47174-7f41-4030-…-… below rest`. Anchored on `="` —
    // React serialises an omitted prop as the string "$undefined", so a bare
    // substring probe would pass whether or not the title attribute is
    // really there.
    const uuid = "6be47174-7f41-4030-9c1a-1e2f3a4b5c6d";
    const conflicts: BoardConflict[] = [
      { fixture_id: "fx-1", code: "warn.rest", blocking: false, details: { kind: "entrant_below_rest", entrant_ids: [uuid] } },
    ];
    const html = renderToStaticMarkup(
      <FixtureBlock {...baseProps} entrantNames={{ [uuid]: "Devon" }} conflicts={conflicts} />,
    );
    expect(html).toContain('title="Devon does not get enough rest"');
    expect(html).not.toContain(uuid);
  });

  it("drops the old red/amber conflict background and widens the division rail to 6px", () => {
    const conflicts: BoardConflict[] = [
      { fixture_id: "fx-1", code: "warn.rest", blocking: true, details: { kind: "entrant_below_rest", entrant_ids: ["p1"] } },
    ];
    const html = renderToStaticMarkup(<FixtureBlock {...baseProps} conflicts={conflicts} />);
    expect(html).not.toContain("bg-red-50");
    expect(html).not.toContain("bg-amber-50");
    expect(html).toContain("6px");
  });

  it("renders a lock icon when locked and a pin icon when unlocked — no raw emoji", () => {
    const locked = renderToStaticMarkup(
      <FixtureBlock {...baseProps} fixture={{ ...fixture, schedule_locked: true }} />,
    );
    const unlocked = renderToStaticMarkup(<FixtureBlock {...baseProps} />);
    // Absence of the old emoji alone doesn't prove the new icon is there — a
    // button that silently rendered nothing would pass that check too.
    // lucide-react stamps every icon's own name onto its rendered class list.
    expect(locked).toContain("lucide-lock");
    expect(locked).not.toContain("\u{1F512}"); // 🔒
    expect(unlocked).toContain("lucide-pin");
    expect(unlocked).not.toContain("\u{1F4CC}"); // 📌
  });

  it("fix round 3 (Important 3): an unfilled slot's title resolves through this org's REAL locale, not the client-safe English default", () => {
    // FixtureBlock's own `msg` (useMsg()) was left off cardTitle()'s 4th
    // arg, so an unfilled slot fell through to cardTitle's hardcoded English
    // default (board/types.ts) regardless of the DictProvider ancestor.
    const tbd: BoardFixture = {
      ...fixture,
      home_entrant_id: null,
      away_entrant_id: null,
      home_slot_label: { key: "slot.winner_group", params: { g: "A" } },
      away_slot_label: { key: "slot.winner_group", params: { g: "B" } },
    };
    const html = renderToStaticMarkup(
      <DictProvider dict={esDict} locale="es">
        <FixtureBlock {...baseProps} fixture={tbd} />
      </DictProvider>,
    );
    expect(html).toContain("Ganador del Grupo A");
    expect(html).toContain("Ganador del Grupo B");
    expect(html).not.toContain("Winner of Group A");
  });

  // Schedule-board knockout round codes (2026-09-23, owner-approved design).
  it("a knockout card's chip shows its round code, with the long round name as its tooltip", () => {
    const html = renderToStaticMarkup(
      <FixtureBlock {...baseProps} roundCode={{ code: "QF", label: "Quarter-finals", order: [0, -2, 0] }} />,
    );
    expect(chipText(html)).toBe("QF");
    expect(html).toMatch(/data-testid="board-round-code"[^>]*title="Quarter-finals"/);
    expect(html).not.toContain(">R1<");
  });

  it("a card with no code keeps R{round_no} — and no tooltip", () => {
    const html = renderToStaticMarkup(<FixtureBlock {...baseProps} fixture={{ ...fixture, round_no: 2 }} />);
    expect(chipText(html)).toBe("R2");
    expect(html).not.toMatch(/data-testid="board-round-code"[^>]*title="/);
  });

  // Design review 2026-09-23 (owner-approved): a bracket-role code reads one
  // step heavier than a plain R{n} — weight plus a stronger ink token, no new
  // hue, no fill — and the division badge stays the loudest thing on the card.
  it("a knockout chip is one step heavier than a plain R{n} chip; the division badge stays louder", () => {
    const classesOf = (html: string) =>
      (/data-testid="board-round-code"[^>]*class="([^"]*)"/.exec(html)?.[1] ?? "").split(/\s+/).filter(Boolean);
    const coded = classesOf(
      renderToStaticMarkup(
        <FixtureBlock {...baseProps} showDivision roundCode={{ code: "QF", label: "Quarter-finals", order: [0, -2, 0] }} />,
      ),
    );
    const plain = classesOf(renderToStaticMarkup(<FixtureBlock {...baseProps} showDivision />));
    expect(coded).toContain("font-semibold");
    expect(plain).not.toContain("font-semibold");
    // A stronger ink token on the coded chip, and the plain one keeps the meta line's.
    expect(coded).toContain("text-slate-700");
    expect(plain).toContain("text-slate-500");
    expect(plain).not.toContain("text-slate-700");
    // Never a fill or white ink: those are the division badge's, which must win.
    for (const cls of [...coded, ...plain]) expect(cls).not.toMatch(/^(bg-|text-white)/);
  });

  it("the pick button's accessible name carries the LONG round name for a coded card, the round number otherwise", () => {
    const coded = renderToStaticMarkup(
      <FixtureBlock {...baseProps} roundCode={{ code: "SF", label: "Semi-finals", order: [0, -1, 0] }} />,
    );
    expect(coded).toContain('aria-label="D vs E — Semi-finals. Pick to move"');
    const plain = renderToStaticMarkup(<FixtureBlock {...baseProps} />);
    expect(plain).toContain('aria-label="D vs E — round 1. Pick to move"');
  });

  it("es: the coded accessible name is localized end to end", () => {
    const html = renderToStaticMarkup(
      <DictProvider dict={esDict} locale="es">
        <FixtureBlock
          {...baseProps}
          roundCode={{ code: es["bracket.roundShort.semi"], label: es["bracket.round.semi"], order: [0, -1, 0] }}
        />
      </DictProvider>,
    );
    expect(chipText(html)).toBe(es["bracket.roundShort.semi"]);
    expect(html).toContain(`— ${es["bracket.round.semi"]}. `);
  });

  it("the division chip stays legible on the new division-tinted card background", () => {
    // Before this change the chip used divisionTint for ITS OWN background —
    // once the card itself carries that same tint, a same-color chip on a
    // same-color card is invisible. The chip must use the solid accent color
    // instead (divisionAccent, white text), never the tint.
    const html = renderToStaticMarkup(<FixtureBlock {...baseProps} showDivision />);
    expect(html).not.toMatch(/data-division-chip[^>]*style="[^"]*hsl\(\d+ 70% 93%\)/);
  });
});
