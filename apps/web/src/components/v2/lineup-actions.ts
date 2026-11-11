// The lineup editor's state transitions and its ⋯ menu, as pure data.
//
// `apps/web` vitest is `environment: "node"` — no DOM, no clicks — so every
// edit a scorer can make in `lineup-editor.tsx` is a `LineupAction` applied by
// `applyLineupAction`, and the ⋯ menu is the list `lineupMenuItems` returns.
// The component only renders that list and dispatches each item's `action`;
// a test that applies the same actions and folds the result through
// `toPutSlot` is therefore exercising the exact path a tap takes.
//
// The save payload is NOT defined here: `toPutSlot` in lineup-editor.tsx is
// unchanged, and `order_no` is still the row's index in the draft array.
//
// Move up / move down within a group is OWNER-APPROVED (2026-11-11): the old
// editor's ▲/▼ arrows move into the ⋯ menu, and "up" means up within the
// group the scorer is looking at (Starting, Bench, or Coaches & staff).
import type { SlotDraft } from "@/components/v2/lineup-editor";
import type { MessageKey } from "@/lib/messages";

export type LineupRole = SlotDraft["role"];

export type LineupAction =
  | { type: "slot"; slot: "starting" | "bench" }
  | { type: "roleFlag"; key: string; on: boolean }
  | { type: "role"; role: LineupRole }
  | { type: "pairOrder"; value: number | null }
  | { type: "position"; value: string | null }
  | { type: "move"; dir: "up" | "down" }
  | { type: "remove" };

export type LineupGroupKey = "starting" | "bench" | "staff";

/** The editor's group of one row: anyone whose role is not "player" is in
 *  Coaches & staff (whatever their stored slot), players by their slot. */
export function groupKeyOf(s: Pick<SlotDraft, "role" | "slot">): LineupGroupKey {
  return s.role !== "player" ? "staff" : s.slot;
}

/** The row that is the nearest neighbour of `index` IN ITS OWN GROUP
 *  (Starting / Bench / Coaches & staff), or -1. "up" means up within the group
 *  the scorer is looking at. */
function groupNeighbour(slots: SlotDraft[], index: number, dir: "up" | "down"): number {
  const step = dir === "up" ? -1 : 1;
  for (let j = index + step; j >= 0 && j < slots.length; j += step) {
    if (groupKeyOf(slots[j]!) === groupKeyOf(slots[index]!)) return j;
  }
  return -1;
}

/** One edit, applied to the draft. Unknown person -> the draft unchanged, and
 *  a move with no neighbour in the group -> unchanged (the menu disables it;
 *  this is the guard behind the disabled item). */
export function applyLineupAction(
  slots: SlotDraft[],
  personId: string,
  action: LineupAction,
): SlotDraft[] {
  const i = slots.findIndex((s) => s.person_id === personId);
  if (i < 0) return slots;
  const patch = (p: Partial<SlotDraft>) => slots.map((s, j) => (j === i ? { ...s, ...p } : s));
  switch (action.type) {
    case "slot":
      return patch({ slot: action.slot });
    case "role":
      return patch({ role: action.role });
    case "pairOrder":
      return patch({ pair_order: action.value });
    case "position":
      return patch({ position_key: action.value });
    case "roleFlag": {
      const without = slots[i]!.roles.filter((k) => k !== action.key);
      return patch({ roles: action.on ? [...without, action.key] : without });
    }
    case "move": {
      const j = groupNeighbour(slots, i, action.dir);
      if (j < 0) return slots;
      const next = [...slots];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    }
    case "remove":
      return slots.filter((_, j) => j !== i);
  }
}

/** Starting, bench and coaches/staff rows, each carrying its index in the FULL
 *  draft (that index is what `toPutSlot` turns into `order_no`). The row number
 *  the editor SHOWS is the row's place within its own group, never that index. */
export function groupSlots(slots: SlotDraft[]): {
  starting: { s: SlotDraft; index: number }[];
  bench: { s: SlotDraft; index: number }[];
  staff: { s: SlotDraft; index: number }[];
} {
  const out = { starting: [], bench: [], staff: [] } as {
    starting: { s: SlotDraft; index: number }[];
    bench: { s: SlotDraft; index: number }[];
    staff: { s: SlotDraft; index: number }[];
  };
  slots.forEach((s, index) => out[groupKeyOf(s)].push({ s, index }));
  return out;
}

/** The one control a row keeps inline. A sport with a position catalog gets the
 *  position select; otherwise a pair-shaped entrant gets the pair-order select;
 *  otherwise the row has none and stays a single short line. */
export type PrimaryControl = "position" | "pairOrder" | "none";
export function primaryControlFor(opts: { positionGroupCount: number; pairShaped: boolean }): PrimaryControl {
  if (opts.positionGroupCount > 0) return "position";
  if (opts.pairShaped) return "pairOrder";
  return "none";
}

export interface MenuOption {
  id: string;
  /** Verbatim text (a catalog role name) or an i18n key. */
  labelKey?: MessageKey;
  label?: string;
  selected: boolean;
  action: LineupAction;
}
export type MenuItem =
  | {
      kind: "action";
      id: string;
      labelKey: MessageKey;
      params?: Record<string, string>;
      action: LineupAction;
      disabled?: boolean;
      danger?: boolean;
    }
  | { kind: "segment"; id: string; labelKey: MessageKey; options: MenuOption[] };

/** Everything the old inline row could do, as menu items, in menu order.
 *  `primary` removes the one control that is already inline (pair order never
 *  appears twice). */
export function lineupMenuItems(opts: {
  slots: SlotDraft[];
  personId: string;
  roles: { key: string; name?: string }[];
  pairShaped: boolean;
  primary: PrimaryControl;
}): MenuItem[] {
  const i = opts.slots.findIndex((s) => s.person_id === opts.personId);
  if (i < 0) return [];
  const s = opts.slots[i]!;
  // Coaches & staff have no Starting/Bench: the item would move them nowhere visible.
  const items: MenuItem[] =
    s.role !== "player"
      ? []
      : [
          s.slot === "starting"
            ? { kind: "action", id: "slot", labelKey: "lineup.menu.toBench", action: { type: "slot", slot: "bench" } }
            : { kind: "action", id: "slot", labelKey: "lineup.menu.toStarting", action: { type: "slot", slot: "starting" } },
        ];
  for (const r of opts.roles) {
    const on = s.roles.includes(r.key);
    const name = r.name ?? r.key;
    if (r.key === "captain") {
      items.push({
        kind: "action",
        id: `flag:${r.key}`,
        labelKey: on ? "lineup.menu.removeCaptain" : "lineup.menu.makeCaptain",
        action: { type: "roleFlag", key: r.key, on: !on },
      });
    } else {
      items.push({
        kind: "action",
        id: `flag:${r.key}`,
        labelKey: on ? "lineup.menu.unmarkRole" : "lineup.menu.markRole",
        params: { role: name },
        action: { type: "roleFlag", key: r.key, on: !on },
      });
    }
  }
  items.push({
    kind: "segment",
    id: "role",
    labelKey: "lineup.menu.roleLabel",
    options: (["player", "coach", "staff"] as const).map((role) => ({
      id: role,
      labelKey: `lineup.role.${role}` as MessageKey,
      selected: s.role === role,
      action: { type: "role", role },
    })),
  });
  if (opts.pairShaped && opts.primary !== "pairOrder") {
    items.push({
      kind: "segment",
      id: "pairOrder",
      labelKey: "lineup.menu.pairOrderLabel",
      options: [
        { id: "none", labelKey: "lineup.pairOrderPlaceholder", value: null },
        { id: "1", labelKey: "lineup.pairOrder.first", value: 1 },
        { id: "2", labelKey: "lineup.pairOrder.second", value: 2 },
      ].map((o) => ({
        id: o.id,
        labelKey: o.labelKey as MessageKey,
        selected: s.pair_order === o.value,
        action: { type: "pairOrder" as const, value: o.value },
      })),
    });
  }
  items.push(
    {
      kind: "action",
      id: "up",
      labelKey: "lineup.menu.moveUp",
      action: { type: "move", dir: "up" },
      disabled: groupNeighbour(opts.slots, i, "up") < 0,
    },
    {
      kind: "action",
      id: "down",
      labelKey: "lineup.menu.moveDown",
      action: { type: "move", dir: "down" },
      disabled: groupNeighbour(opts.slots, i, "down") < 0,
    },
    { kind: "action", id: "remove", labelKey: "lineup.menu.remove", action: { type: "remove" }, danger: true },
  );
  return items;
}
