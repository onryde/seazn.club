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
};

describe("FixtureBlock", () => {
  it("merges same-code conflicts into ONE badge instead of repeating it per entrant", () => {
    // The original bug: two `warn.rest` entries (D needs rest, E needs rest)
    // rendered as two adjacent, indistinguishable "rest" badges.
    const conflicts: BoardConflict[] = [
      { fixture_id: "fx-1", code: "warn.rest", blocking: false, detail: "D needs more rest" },
      { fixture_id: "fx-1", code: "warn.rest", blocking: false, detail: "E needs more rest" },
    ];
    const html = renderToStaticMarkup(<FixtureBlock {...baseProps} conflicts={conflicts} />);
    expect(html.match(/>rest</g)).toHaveLength(1);
    expect(html).toContain("D needs more rest; E needs more rest");
  });

  it("keeps two DIFFERENT conflict codes as two separate badges", () => {
    // Both entries share the same `blocking` value on purpose — the grouping
    // key is `code`, and a case where `blocking` also happens to differ
    // would pass just as well if the code grouped by `blocking` instead.
    const conflicts: BoardConflict[] = [
      { fixture_id: "fx-1", code: "warn.rest", blocking: false, detail: "D needs rest" },
      { fixture_id: "fx-1", code: "conflict.court", blocking: false, detail: "Court double-booked" },
    ];
    const html = renderToStaticMarkup(<FixtureBlock {...baseProps} conflicts={conflicts} />);
    expect(html.match(/>rest</g)).toHaveLength(1);
    expect(html).toContain(">court clash<");
  });

  it("drops the old red/amber conflict background and widens the division rail to 6px", () => {
    const conflicts: BoardConflict[] = [
      { fixture_id: "fx-1", code: "warn.rest", blocking: true, detail: "D needs rest" },
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

  it("the division chip stays legible on the new division-tinted card background", () => {
    // Before this change the chip used divisionTint for ITS OWN background —
    // once the card itself carries that same tint, a same-color chip on a
    // same-color card is invisible. The chip must use the solid accent color
    // instead (divisionAccent, white text), never the tint.
    const html = renderToStaticMarkup(<FixtureBlock {...baseProps} showDivision />);
    expect(html).not.toMatch(/data-division-chip[^>]*style="[^"]*hsl\(\d+ 70% 93%\)/);
  });
});
