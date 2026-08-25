import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LineupEditor } from "@/components/v2/lineup-editor";
import { DictProvider } from "@/components/i18n/dict-provider";
import uiEn from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import type { SideInfo } from "@/components/v2/fixture-console";

const dict = uiEn as unknown as Dict;
const wrap = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <DictProvider dict={dict} locale="en">
      {node}
    </DictProvider>,
  );

function member(i: number): SideInfo["members"][number] {
  return {
    person_id: `00000000-0000-0000-0000-00000000000${i}`,
    full_name: `Player ${i}`,
    squad_number: i,
    default_position_key: null,
    is_captain: i === 1,
    roles: [],
  };
}

const base = {
  fixtureId: "f1",
  positionGroups: [],
  roles: [],
  onSaved: () => {},
};

// D-3 (defect register): "Doubles lineup badge reads '2/1 starting'". Root
// cause is a unit mismatch, not a data or engine bug. `lineupSize` counts
// UNITS — one nominated player OR PAIR per side
// (packages/engine/src/sports/tennis/tennis.ts's positions.lineup.size = 1,
// "one nominated unit (player or pair) per side" — that value is correct and
// unchanged here). `startingCount` (slots.filter(slot === "starting").length)
// already counts PEOPLE. A doubles pair fills its one unit with 2 people, so
// comparing/labelling straight against the raw `lineupSize` read "2/1
// starting" and the emerald/slate switch never turned emerald. The fix
// expresses the expected PEOPLE count as `pairShaped ? lineupSize * 2 :
// lineupSize` and uses that one expression for both the badge text and the
// colour switch, and — the same mismatch wearing different clothes — for the
// roster auto-populate seeding at mount, which used raw `lineupSize` to
// decide how many roster members start by default and so under-seeded a
// fresh doubles pair's starters too.
describe("LineupEditor starting-count badge — pair-shaped sides (D-3)", () => {
  it("a saved 2-of-2-people doubles lineup reads '2/2 starting' in the emerald state, not '2/1'", () => {
    const p1 = member(1);
    const p2 = member(2);
    const side: SideInfo = {
      id: "e1",
      name: "Home",
      kind: "pair",
      members: [p1, p2],
      lineup: [
        { person_id: p1.person_id, full_name: p1.full_name, slot: "starting", position_key: null, order_no: 1, roles: [] },
        { person_id: p2.person_id, full_name: p2.full_name, slot: "starting", position_key: null, order_no: 2, roles: [] },
      ],
    };
    const html = wrap(<LineupEditor {...base} lineupSize={1} side={side} canEdit={true} />);
    expect(html).toContain('text-xs text-emerald-600">2/2 starting');
    expect(html).not.toContain("2/1 starting");
  });

  it("a saved 1-of-2-people doubles lineup reads '1/2 starting' and stays slate (guards against a fix that is always emerald for pair sides)", () => {
    const p1 = member(1);
    const p2 = member(2);
    const side: SideInfo = {
      id: "e1",
      name: "Home",
      kind: "pair",
      members: [p1, p2],
      lineup: [
        { person_id: p1.person_id, full_name: p1.full_name, slot: "starting", position_key: null, order_no: 1, roles: [] },
        { person_id: p2.person_id, full_name: p2.full_name, slot: "bench", position_key: null, order_no: 2, roles: [] },
      ],
    };
    const html = wrap(<LineupEditor {...base} lineupSize={1} side={side} canEdit={true} />);
    expect(html).toContain('text-xs text-slate-400">1/2 starting');
    expect(html).not.toContain("text-emerald-600");
  });

  it("a fresh (unsaved) doubles pair auto-populates BOTH partners as starting — the same mismatch in the roster draft-seeding path, not just the badge", () => {
    const side: SideInfo = {
      id: "e1",
      name: "Home",
      kind: "pair",
      members: [member(1), member(2)],
      lineup: [],
    };
    const html = wrap(<LineupEditor {...base} lineupSize={1} side={side} canEdit={true} />);
    expect(html).toContain('text-xs text-emerald-600">2/2 starting');
    expect(html).not.toContain("1/2 starting");
  });

  it("a non-pair side is unaffected: lineupSize already counts people (regression guard)", () => {
    const side: SideInfo = {
      id: "e1",
      name: "Home",
      kind: "team",
      members: [member(1), member(2), member(3)],
      lineup: [],
    };
    const html = wrap(<LineupEditor {...base} lineupSize={2} side={side} canEdit={true} />);
    expect(html).toContain('text-xs text-emerald-600">2/2 starting');
  });
});
