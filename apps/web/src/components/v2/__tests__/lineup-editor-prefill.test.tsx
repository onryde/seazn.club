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

function side(overrides: Partial<SideInfo>): SideInfo {
  return {
    id: "e1",
    name: "Home",
    members: [member(1), member(2), member(3)],
    lineup: [],
    ...overrides,
  };
}

const base = {
  fixtureId: "f1",
  positionGroups: [],
  roles: [],
  lineupSize: 2,
  onSaved: () => {},
};

// "More actions for {name}" is the aria-label a LINEUP ROW's ⋯ button carries
// (the slot select it replaced is gone — Starting/Bench are groups now) — the
// add-picker below lists roster names too, so bare name matching can't tell a
// prefilled row from a pickable member. Rows are counted per group via
// `data-slot`.
const rows = (html: string, slot: "starting" | "bench") =>
  html.split(`data-testid="lineup-row" data-slot="${slot}"`).length - 1;
describe("LineupEditor roster auto-prefill", () => {
  it("prefills a draft from the roster when nothing is saved: first lineupSize start, rest bench", () => {
    const html = wrap(<LineupEditor {...base} side={side({})} canEdit={true} />);
    expect(html).toContain("More actions for Player 1");
    expect(html).toContain("More actions for Player 2");
    expect(html).toContain("More actions for Player 3");
    expect(rows(html, "starting")).toBe(2);
    expect(rows(html, "bench")).toBe(1);
    expect(html).toContain("2/2 starting");
    expect(html).not.toContain("No lineup submitted");
  });

  it("keeps the honest empty state for read-only viewers", () => {
    const html = wrap(<LineupEditor {...base} side={side({})} canEdit={false} />);
    expect(html).toContain("No lineup submitted.");
    expect(html).not.toContain("More actions for Player 1");
    expect(rows(html, "starting") + rows(html, "bench")).toBe(0);
  });

  it("a saved lineup wins over the roster prefill", () => {
    const html = wrap(
      <LineupEditor
        {...base}
        canEdit={true}
        side={side({
          lineup: [
            {
              person_id: member(2).person_id,
              full_name: "Player 2",
              slot: "starting",
              position_key: null,
              order_no: 1,
              roles: [],
            },
          ],
        })}
      />,
    );
    expect(html).toContain("More actions for Player 2");
    expect(html).not.toContain("More actions for Player 1");
    expect(rows(html, "starting")).toBe(1);
    expect(rows(html, "bench")).toBe(0);
    expect(html).toContain("1/2 starting");
  });
});
