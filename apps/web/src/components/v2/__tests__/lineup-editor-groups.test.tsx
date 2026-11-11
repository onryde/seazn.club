// Lineup editor, Option A (owner-approved 2026-11-11): rows grouped under
// Starting / Bench, ONE primary inline control, everything else in a ⋯ menu.
//
// This repo tests client components through `renderToStaticMarkup` (vitest is
// `environment: "node"`, no jsdom), so a tap is proven by driving the same
// pure `applyLineupAction` the component dispatches, and the menu by rendering
// `LineupMenuPanel` over the editor's own `lineupMenuItems`. The save payload
// is proven by folding the editor's draft through `toPutSlot` and then through
// the API's REAL `PutLineup` schema — the door the PUT actually goes through.
//
// Expected values are literals written from the OLD controls' behaviour
// (slot select, position select, role select, pair-order select, role
// checkboxes, up/down arrows, ×) and from the engine's own declarations
// (`builtinModules`), never read back from the code under test.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { builtinModules } from "@seazn/engine/sports";
import { DictProvider } from "@/components/i18n/dict-provider";
import uiEn from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import type { LineupSlotIn, SideInfo } from "@/components/v2/fixture-console";
import {
  LineupEditor,
  LineupMenuPanel,
  draftFromSavedLineup,
  isPairShaped,
  lineupEditorApplies,
  toPutSlot,
  type SlotDraft,
} from "@/components/v2/lineup-editor";
import {
  applyLineupAction,
  groupSlots,
  lineupMenuItems,
  primaryControlFor,
  type PrimaryControl,
} from "@/components/v2/lineup-actions";
import { lineupCatalogFor } from "@/server/usecases/lineup-catalog";
import { PutLineup } from "@/server/api-v1/schemas/scoring";

const dict = uiEn as unknown as Dict;
const wrap = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <DictProvider dict={dict} locale="en">
      {node}
    </DictProvider>,
  );

const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const NAME = ["", "Alpha", "Bravo", "Charlie", "Delta"];

function slot(n: number, s: "starting" | "bench", extra: Partial<LineupSlotIn> = {}): LineupSlotIn {
  return { person_id: id(n), full_name: NAME[n]!, slot: s, position_key: null, order_no: n, roles: [], ...extra };
}
const draft = (rows: LineupSlotIn[]): SlotDraft[] => draftFromSavedLineup(rows);
const order = (slots: SlotDraft[]) => slots.map((s) => s.full_name);

function sideOf(lineup: LineupSlotIn[], kind: string | undefined = "team"): SideInfo {
  return {
    id: "e1",
    name: "Home",
    kind,
    members: lineup.map((l) => ({
      person_id: l.person_id,
      full_name: l.full_name,
      squad_number: null,
      default_position_key: null,
      is_captain: false,
      roles: [],
    })),
    lineup,
  };
}

const editor = (props: Partial<React.ComponentProps<typeof LineupEditor>> & { side: SideInfo }) =>
  wrap(
    <LineupEditor
      fixtureId="f1"
      positionGroups={[]}
      roles={[]}
      lineupSize={2}
      canEdit={true}
      onSaved={() => {}}
      {...props}
    />,
  );

/** The markup of one group section (its heading and rows, nothing else). */
function groupHtml(html: string, key: "starting" | "bench" | "staff"): string {
  const start = html.indexOf(`data-testid="lineup-group-${key}"`);
  expect(start, `no ${key} group rendered`).toBeGreaterThan(-1);
  const ends = (["starting", "bench", "staff"] as const)
    .filter((k) => k !== key)
    .map((k) => html.indexOf(`data-testid="lineup-group-${k}"`))
    .filter((at) => at > start);
  const end = ends.length > 0 ? Math.min(...ends) : html.length;
  return html.slice(start, end);
}

describe("grouping by slot", () => {
  const mixed = [slot(1, "starting"), slot(2, "bench"), slot(3, "starting"), slot(4, "bench")];

  it("puts each row under the group of its OWN slot, in draft order, with the bench count in its heading", () => {
    const html = editor({ side: sideOf(mixed) });
    const starting = groupHtml(html, "starting");
    const bench = groupHtml(html, "bench");
    expect(starting).toContain(">Alpha</span>");
    expect(starting).toContain(">Charlie</span>");
    expect(starting).not.toContain(">Bravo</span>");
    expect(starting).not.toContain(">Delta</span>");
    expect(bench).toContain(">Bravo</span>");
    expect(bench).toContain(">Delta</span>");
    expect(bench).not.toContain(">Alpha</span>");
    expect(starting.split('data-testid="lineup-row"').length - 1).toBe(2);
    expect(bench.split('data-testid="lineup-row"').length - 1).toBe(2);
    expect(bench).toContain("Bench · 2");
    // the header status is unchanged
    expect(html).toContain("2/2 starting");
  });

  it("the row number is the row's place WITHIN ITS GROUP (1, 2, 3…), never its order_no; the payload keeps order_no", () => {
    const html = editor({ side: sideOf(mixed) });
    const starting = groupHtml(html, "starting");
    const bench = groupHtml(html, "bench");
    // starting = Alpha (order_no 1), Charlie (order_no 3): shown 1. and 2.
    expect(starting).toContain(">1.</span>");
    expect(starting).toContain(">2.</span>");
    expect(starting).not.toContain(">3.</span>");
    // bench = Bravo (order_no 2), Delta (order_no 4): shown 1. and 2., not 2. and 4.
    expect(bench).toContain(">1.</span>");
    expect(bench).toContain(">2.</span>");
    expect(bench).not.toContain(">4.</span>");
    // the wire is unchanged: order_no is still the draft index + 1
    expect(draft(mixed).map((s, i) => toPutSlot(s, i, false).order_no)).toEqual([1, 2, 3, 4]);
  });

  it("coaches and staff sit in their own third group: not in Bench, no position select, role still in the menu", () => {
    const side = sideOf([
      slot(1, "starting"),
      slot(2, "bench"),
      slot(3, "bench", { role: "coach" }),
      slot(4, "starting", { role: "staff" }),
    ]);
    const html = editor({ side, positionGroups: [{ key: "GK", name: "Goalkeeper" }] });
    const staff = groupHtml(html, "staff");
    const bench = groupHtml(html, "bench");
    expect(staff).toContain(">Charlie</span>");
    expect(staff).toContain(">Delta</span>");
    expect(staff.split('data-testid="lineup-row"').length - 1).toBe(2);
    expect(staff).toContain("Coaches &amp; staff");
    expect(staff).not.toContain('data-testid="lineup-position-select"');
    expect(staff).toContain('data-testid="lineup-row-menu-button"');
    expect(staff).toContain(">1.</span>");
    expect(staff).toContain(">2.</span>");
    // Bench counts players only
    expect(bench).toContain("Bench · 1");
    expect(bench).not.toContain(">Charlie</span>");
    expect(groupHtml(html, "starting")).not.toContain(">Delta</span>");
    expect(groupHtml(html, "starting")).toContain('data-testid="lineup-position-select"');
    // role stays changeable in the staff row's menu; no Starting/Bench item there
    const items = lineupMenuItems({ slots: draft([slot(3, "bench", { role: "coach" })]), personId: id(3), roles: [], pairShaped: false, primary: "position" });
    expect(items.map((i) => i.id)).toEqual(["role", "up", "down", "remove"]);
  });

  it("phone overflow chain: the card, its header and a 43-char name row all carry min-w-0 + truncate (browser proof: mobile.spec.ts hit-test)", () => {
    const long = "Bartholomew Maximilian Featherstonehaugh-Smythe";
    const html = editor({ side: sideOf([slot(1, "starting", { full_name: long })]) });
    expect(long.length).toBeGreaterThanOrEqual(43);
    expect(html).toMatch(/<section class="card min-w-0 p-4" data-testid="lineup-editor"/);
    expect(html).toMatch(/<header class="[^"]*\bmin-w-0\b/);
    expect(html).toMatch(/<li data-testid="lineup-row"[^>]*class="flex min-w-0 /);
    expect(html).toMatch(/class="min-w-\[2.5rem\] truncate[^"]*">Bartholomew/);
  });

  it("no one holds a role: no Coaches & staff group renders (empty case)", () => {
    expect(editor({ side: sideOf(mixed) })).not.toContain('data-testid="lineup-group-staff"');
  });

  it("move up/down inside Coaches & staff swaps only staff rows", () => {
    const d = draft([slot(1, "starting", { role: "coach" }), slot(2, "starting"), slot(3, "bench", { role: "staff" })]);
    expect(order(applyLineupAction(d, id(3), { type: "move", dir: "up" }))).toEqual(["Charlie", "Bravo", "Alpha"]);
    expect(groupSlots(d).staff.map((r) => r.index)).toEqual([0, 2]);
    expect(groupSlots(d).starting.length + groupSlots(d).bench.length + groupSlots(d).staff.length).toBe(3);
  });

  it("groupSlots keeps the full-draft index each row will be saved under", () => {
    const g = groupSlots(draft(mixed));
    expect(g.starting.map((r) => r.index)).toEqual([0, 2]);
    expect(g.bench.map((r) => r.index)).toEqual([1, 3]);
    expect(g.starting.length + g.bench.length).toBe(4);
  });

  it("empty case: nobody starting still renders the Starting group, saying so; an empty draft renders no groups", () => {
    const allBench = editor({ side: sideOf([slot(1, "bench"), slot(2, "bench")]) });
    expect(groupHtml(allBench, "starting")).toContain("No one here yet");
    expect(groupHtml(allBench, "bench")).toContain("Bench · 2");
    expect(allBench).toContain("0/2 starting");
    const none = editor({ side: sideOf([]), canEdit: false });
    expect(none).not.toContain('data-testid="lineup-group-starting"');
    expect(none).not.toContain('data-testid="lineup-group-bench"');
    expect(none).toContain("No lineup submitted.");
  });

  it("a row moved to the bench changes group but keeps its place in the order", () => {
    const after = applyLineupAction(draft(mixed), id(1), { type: "slot", slot: "bench" });
    expect(after.map((s) => [s.full_name, s.slot])).toEqual([
      ["Alpha", "bench"],
      ["Bravo", "bench"],
      ["Charlie", "starting"],
      ["Delta", "bench"],
    ]);
    const html = editor({ side: sideOf(after.map((s, i) => slot(i + 1, s.slot))) });
    expect(groupHtml(html, "bench")).toContain("Bench · 3");
  });
});

describe("every ⋯ action does what the old inline control did", () => {
  const base = () =>
    draft([
      slot(1, "starting", { position_key: "GK" }),
      slot(2, "starting"),
      slot(3, "bench", { roles: ["captain"] }),
    ]);

  it("Move to bench / Move to starting == the old slot select", () => {
    const toBench = applyLineupAction(base(), id(2), { type: "slot", slot: "bench" });
    expect(toBench.map((s) => s.slot)).toEqual(["starting", "bench", "bench"]);
    const toStart = applyLineupAction(base(), id(3), { type: "slot", slot: "starting" });
    expect(toStart.map((s) => s.slot)).toEqual(["starting", "starting", "starting"]);
    // nothing else about the row changed
    expect(toStart[2]).toMatchObject({ roles: ["captain"], role: "player", order_no: 3 });
  });

  it("position == the old position select, including clearing it", () => {
    const set = applyLineupAction(base(), id(2), { type: "position", value: "DF" });
    expect(set.map((s) => s.position_key)).toEqual(["GK", "DF", null]);
    const clear = applyLineupAction(base(), id(1), { type: "position", value: null });
    expect(clear.map((s) => s.position_key)).toEqual([null, null, null]);
  });

  it("Player/Coach/Staff == the old role select", () => {
    for (const role of ["coach", "staff", "player"] as const) {
      const out = applyLineupAction(base(), id(2), { type: "role", role });
      expect(out.map((s) => s.role)).toEqual(["player", role, "player"]);
    }
  });

  it("pair order == the old pair-order select (1st, 2nd, none)", () => {
    expect(applyLineupAction(base(), id(1), { type: "pairOrder", value: 1 })[0]!.pair_order).toBe(1);
    expect(applyLineupAction(base(), id(1), { type: "pairOrder", value: 2 })[0]!.pair_order).toBe(2);
    const twice = applyLineupAction(applyLineupAction(base(), id(1), { type: "pairOrder", value: 2 }), id(1), {
      type: "pairOrder",
      value: null,
    });
    expect(twice[0]!.pair_order).toBeNull();
  });

  it("Make/Remove captain (and any catalog flag) == the old role checkbox, and is NOT exclusive, exactly as before", () => {
    // Before: each row's checkbox was independent — ticking Bravo while Charlie
    // held `captain` left BOTH flagged (the engine's `unique` rule refuses it
    // at the scoring door, not in this editor). Behaviour is deliberately
    // unchanged by a layout change.
    const both = applyLineupAction(base(), id(2), { type: "roleFlag", key: "captain", on: true });
    expect(both.map((s) => s.roles)).toEqual([[], ["captain"], ["captain"]]);
    const off = applyLineupAction(both, id(3), { type: "roleFlag", key: "captain", on: false });
    expect(off.map((s) => s.roles)).toEqual([[], ["captain"], []]);
    const second = applyLineupAction(both, id(2), { type: "roleFlag", key: "wicketkeeper", on: true });
    expect(second[1]!.roles).toEqual(["captain", "wicketkeeper"]);
    // turning a flag on twice never duplicates it
    const again = applyLineupAction(both, id(2), { type: "roleFlag", key: "captain", on: true });
    expect(again[1]!.roles).toEqual(["captain"]);
  });

  it("Move up / Move down == the old arrows when the groups are contiguous", () => {
    expect(order(applyLineupAction(base(), id(2), { type: "move", dir: "up" }))).toEqual(["Bravo", "Alpha", "Charlie"]);
    expect(order(applyLineupAction(base(), id(1), { type: "move", dir: "down" }))).toEqual(["Bravo", "Alpha", "Charlie"]);
  });

  it("Move up / down stays inside the row's own group when the draft interleaves them", () => {
    const interleaved = draft([slot(1, "starting"), slot(2, "bench"), slot(3, "starting")]);
    // Charlie (starting) up swaps with Alpha, the nearest STARTING row, not with Bravo
    expect(order(applyLineupAction(interleaved, id(3), { type: "move", dir: "up" }))).toEqual(["Charlie", "Bravo", "Alpha"]);
    expect(order(applyLineupAction(interleaved, id(1), { type: "move", dir: "down" }))).toEqual(["Charlie", "Bravo", "Alpha"]);
  });

  it("a move with no neighbour in the group is a no-op (the guard behind the disabled item)", () => {
    const interleaved = draft([slot(1, "starting"), slot(2, "bench"), slot(3, "starting")]);
    expect(applyLineupAction(interleaved, id(2), { type: "move", dir: "up" })).toBe(interleaved);
    expect(applyLineupAction(interleaved, id(2), { type: "move", dir: "down" })).toBe(interleaved);
    expect(applyLineupAction(interleaved, id(1), { type: "move", dir: "up" })).toBe(interleaved);
    const items = lineupMenuItems({ slots: interleaved, personId: id(2), roles: [], pairShaped: false, primary: "none" });
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(byId.up).toMatchObject({ disabled: true });
    expect(byId.down).toMatchObject({ disabled: true });
    const mid = lineupMenuItems({ slots: interleaved, personId: id(3), roles: [], pairShaped: false, primary: "none" });
    expect(Object.fromEntries(mid.map((i) => [i.id, i])).up).toMatchObject({ disabled: false });
  });

  it("Remove from lineup == the old ×, and the person returns to the add-picker", () => {
    const out = applyLineupAction(base(), id(2), { type: "remove" });
    expect(order(out)).toEqual(["Alpha", "Charlie"]);
    expect(applyLineupAction(base(), id(9), { type: "remove" })).toHaveLength(3);
    // After removal the person is only a roster member: the editor shows the
    // two remaining rows and offers Bravo under the list as a pick chip.
    const side = sideOf([slot(1, "starting"), slot(2, "starting"), slot(3, "bench")]);
    side.lineup = [slot(1, "starting"), slot(3, "bench")];
    const html = editor({ side });
    expect(html.split('data-testid="lineup-row"').length - 1).toBe(2);
    expect(html).toContain("Bravo");
    expect(html).not.toContain("More actions for Bravo");
    expect(html).toMatch(/Bravo[\s\S]*>start<\/button>[\s\S]*>bench<\/button>/);
  });
});

describe("the ⋯ menu offers every control the old row had", () => {
  const rows = draft([slot(1, "starting"), slot(2, "bench")]);
  const ids = (opts: { roles: { key: string }[]; pairShaped: boolean; primary: PrimaryControl; who?: number }) =>
    lineupMenuItems({ slots: rows, personId: id(opts.who ?? 1), ...opts }).map((i) => i.id);

  it("cricket-shaped row: slot, each catalog flag, role, up, down, remove — in that order", () => {
    expect(ids({ roles: [{ key: "captain" }, { key: "wicketkeeper" }], pairShaped: false, primary: "position" })).toEqual([
      "slot",
      "flag:captain",
      "flag:wicketkeeper",
      "role",
      "up",
      "down",
      "remove",
    ]);
  });

  it("a pair-shaped row whose primary is the position select gets the pair order in the menu; a pair-order primary does not repeat it", () => {
    expect(ids({ roles: [], pairShaped: true, primary: "position" })).toContain("pairOrder");
    expect(ids({ roles: [], pairShaped: true, primary: "pairOrder" })).not.toContain("pairOrder");
    expect(ids({ roles: [], pairShaped: false, primary: "position" })).not.toContain("pairOrder");
  });

  it("the slot item says where the row GOES, and the captain item flips with the row's state", () => {
    const starting = lineupMenuItems({ slots: rows, personId: id(1), roles: [{ key: "captain" }], pairShaped: false, primary: "none" });
    const bench = lineupMenuItems({
      slots: applyLineupAction(rows, id(2), { type: "roleFlag", key: "captain", on: true }),
      personId: id(2),
      roles: [{ key: "captain" }],
      pairShaped: false,
      primary: "none",
    });
    expect(starting[0]).toMatchObject({ labelKey: "lineup.menu.toBench" });
    expect(bench[0]).toMatchObject({ labelKey: "lineup.menu.toStarting" });
    expect(starting[1]).toMatchObject({ labelKey: "lineup.menu.makeCaptain" });
    expect(bench[1]).toMatchObject({ labelKey: "lineup.menu.removeCaptain" });
  });

  it("the rendered panel is a role=menu with every item, the destructive one last and marked", () => {
    const items = lineupMenuItems({
      slots: rows,
      personId: id(1),
      roles: [{ key: "captain" }],
      pairShaped: true,
      primary: "position",
    });
    const html = wrap(<LineupMenuPanel name="Alpha" items={items} onAction={() => {}} onClose={() => {}} />);
    expect(html).toContain('role="menu"');
    for (const text of ["Move to bench", "Make captain", "Move up", "Move down", "Remove from lineup", "Pair order"]) {
      expect(html, text).toContain(text);
    }
    expect(html.lastIndexOf("Remove from lineup")).toBeGreaterThan(html.lastIndexOf("Move down"));
    expect(html).toMatch(/text-red-600[^>]*>Remove from lineup/);
    // Phone is a bottom sheet and desktop a dropdown — ONE node, switched by classes
    expect(html).toContain("max-md:fixed");
    expect(html).toContain("md:absolute");
    expect((html.match(/role="menu"/g) ?? []).length).toBe(1);
    // every control is at least 44px tall
    expect(html.match(/min-h-11/g)?.length ?? 0).toBeGreaterThanOrEqual(items.length);
  });

  it("an editable row has the ⋯ trigger; a read-only viewer gets no menu and a disabled primary control", () => {
    const side = sideOf([slot(1, "starting")]);
    const edit = editor({ side, positionGroups: [{ key: "GK", name: "Goalkeeper" }] });
    expect(edit).toContain('data-testid="lineup-row-menu-button"');
    expect(edit).toContain('aria-haspopup="menu"');
    expect(edit).toContain('aria-expanded="false"');
    expect(edit).toContain("h-11 w-11");
    const ro = editor({ side, canEdit: false, positionGroups: [{ key: "GK", name: "Goalkeeper" }] });
    expect(ro).not.toContain('data-testid="lineup-row-menu-button"');
    expect(ro).toMatch(/<select disabled=""[^>]*data-testid="lineup-position-select"/);
  });

  it("the row shows a lime C for the captain and COACH/STAFF only when the role is not player", () => {
    const side = sideOf([
      slot(1, "starting", { roles: ["captain"] }),
      slot(2, "starting", { role: "coach" }),
      slot(3, "bench"),
    ]);
    const html = editor({ side, roles: [{ key: "captain" }] });
    expect(html.split('data-testid="lineup-badge-captain"').length - 1).toBe(1);
    expect(html).toContain("bg-lime-400");
    expect(html.split('data-testid="lineup-badge-role"').length - 1).toBe(1);
    expect(html).toContain(">Coach</span>");
    expect(html).not.toContain(">Staff</span>");
  });
});

describe("the save payload is identical for the same edits", () => {
  // Folded through the editor's builder and then the API's own PutLineup door.
  const put = (slots: SlotDraft[], pairShaped: boolean) =>
    PutLineup.parse({ slots: slots.map((s, i) => toPutSlot(s, i, pairShaped)) }).slots;

  it("a sequence of ⋯ edits yields exactly the body the old controls produced", () => {
    let d = draft([
      slot(1, "starting", { position_key: "GK" }),
      slot(2, "starting"),
      slot(3, "starting"),
      slot(4, "bench"),
    ]);
    d = applyLineupAction(d, id(2), { type: "position", value: "DF" });
    d = applyLineupAction(d, id(2), { type: "roleFlag", key: "captain", on: true });
    d = applyLineupAction(d, id(3), { type: "slot", slot: "bench" });
    d = applyLineupAction(d, id(4), { type: "move", dir: "up" });
    d = applyLineupAction(d, id(3), { type: "role", role: "coach" });
    d = applyLineupAction(d, id(1), { type: "remove" });
    expect(put(d, false)).toEqual([
      { person_id: id(2), slot: "starting", position_key: "DF", order_no: 1, roles: ["captain"], role: "player", pair_order: null },
      { person_id: id(4), slot: "bench", position_key: null, order_no: 2, roles: [], role: "player", pair_order: null },
      { person_id: id(3), slot: "bench", position_key: null, order_no: 3, roles: [], role: "coach", pair_order: null },
    ]);
  });

  it("pair order rides the payload for a pair-shaped side and is nulled for any other, as before", () => {
    const d = applyLineupAction(draft([slot(1, "starting"), slot(2, "starting")]), id(2), { type: "pairOrder", value: 2 });
    expect(put(d, true).map((s) => s.pair_order)).toEqual([null, 2]);
    expect(put(d, false).map((s) => s.pair_order)).toEqual([null, null]);
  });

  it("an untouched lineup round-trips unchanged (the editor adds nothing of its own)", () => {
    const saved = [
      slot(1, "starting", { position_key: "GK", roles: ["captain"], role: "player", pair_order: null }),
      slot(2, "bench", { role: "staff" }),
    ];
    expect(put(draftFromSavedLineup(saved), false)).toEqual([
      { person_id: id(1), slot: "starting", position_key: "GK", order_no: 1, roles: ["captain"], role: "player", pair_order: null },
      { person_id: id(2), slot: "bench", position_key: null, order_no: 2, roles: [], role: "staff", pair_order: null },
    ]);
  });
});

// The primary inline control per sport, from the engine's own declarations.
// Position catalog -> position select; else a pair entrant -> pair-order
// select; else nothing (the row stays one short line).
describe("primary control, swept over every shipped sport", () => {
  const EXPECTED: Record<string, { team?: PrimaryControl; individual?: PrimaryControl; pair?: PrimaryControl }> = {
    football: { team: "position" },
    cricket: { team: "position" },
    hockey: { team: "position" },
    icehockey: { team: "position" },
    volleyball: { team: "position", pair: "position" },
    tennis: { individual: "none", pair: "pairOrder" },
    badminton: { individual: "none", pair: "pairOrder" },
    tabletennis: { individual: "none", pair: "pairOrder" },
  };

  it("every sport whose editor is reachable gets the declared control for each entrant kind it can field", () => {
    let checked = 0;
    const seen = new Set<string>();
    for (const mod of builtinModules) {
      const catalog = lineupCatalogFor(mod, {});
      if (!lineupEditorApplies({ lineupSize: catalog.lineup.size, benchMax: catalog.lineup.benchMax ?? 0 })) continue;
      seen.add(mod.key);
      const want = EXPECTED[mod.key];
      expect(want, `${mod.key} has an editor but no expectation`).toBeDefined();
      for (const kind of mod.entrantModel?.kinds ?? ["team"]) {
        const primary = primaryControlFor({
          positionGroupCount: catalog.groups.length,
          pairShaped: isPairShaped(kind),
        });
        expect(primary, `${mod.key}/${kind}`).toBe((want as Record<string, PrimaryControl>)[kind]);
        // ... and through the real render, not just the selector
        const lineup = [slot(1, "starting"), slot(2, "starting")];
        const html = editor({
          side: sideOf(lineup, kind),
          positionGroups: catalog.groups,
          roles: catalog.roles ?? [],
          lineupSize: catalog.lineup.size,
        });
        expect(html.includes('data-testid="lineup-position-select"'), `${mod.key}/${kind} position`).toBe(primary === "position");
        expect(html.includes('data-testid="lineup-pairorder-select"'), `${mod.key}/${kind} pairorder`).toBe(primary === "pairOrder");
        // exactly ONE inline select per row at most
        expect((html.match(/<select/g) ?? []).length).toBe(primary === "none" ? 0 : 2);
        checked++;
      }
    }
    expect(seen.size).toBeGreaterThan(0);
    expect([...seen].sort()).toEqual(Object.keys(EXPECTED).sort());
    // 5 team sports + volleyball's second kind + 3 racquet sports x 2 kinds = 5 + 1 + 6
    expect(checked).toBe(12);
  });

  it("the sweep sees all three outcomes (it cannot pass on a selector that always answers one thing)", () => {
    const outcomes = new Set(Object.values(EXPECTED).flatMap((e) => Object.values(e)));
    expect(outcomes).toEqual(new Set(["position", "pairOrder", "none"]));
  });
});
