// S12/#421 pass D — two defects in the product's own lineup editor:
//
// 1. `role` (player/coach/staff, S3/#426 ruling) is read correctly by
//    `loadLineupPair` and — this session — by the pad's own fold
//    (registry.tsx's `toLineupSlot`), but `LineupEditor` never rendered a
//    control for it and its own `save()` dropped the field from the PUT
//    body entirely. So the coach-exclusion those fixes implement was
//    unreachable through the product's own UI: a coach saved through the
//    editor was silently written back as "player".
// 2. `pair_order` (doubles serve order) had no DB column, no write path and
//    no UI at all (V361 + fixtures.ts add the first two; this file owns
//    the third) — and only for a pair-shaped entrant (tennis/badminton/
//    tabletennis doubles), never rendered as a dead/disabled control
//    otherwise.
//
// This repo tests client components via `renderToStaticMarkup` — no
// jsdom/@testing-library anywhere in the tree (see capacity-card.test.tsx's
// own header comment) — so the SAVE-payload and INITIAL-DRAFT mapping logic
// is proven through the pure functions `lineup-editor.tsx` exports for
// exactly this reason, and rendering is proven through static HTML
// presence/absence (the same convention lineup-editor-prefill.test.tsx
// already uses), never through a simulated click or an SSR `selected`
// attribute this repo has no precedent for trusting.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { builtinModules } from "@seazn/engine/sports";
import { makeEnvelope } from "@seazn/engine/testkit";
import type { AnySportModule } from "@seazn/engine/sport";
import {
  LineupEditor,
  draftFromSavedLineup,
  isPairShaped,
  toPutSlot,
  type SlotDraft,
} from "@/components/v2/lineup-editor";
import { lineupPairFrom } from "@/components/v2/scorepad/registry";
import { foldClient } from "@/components/v2/scorepad/module-client";
import { DictProvider } from "@/components/i18n/dict-provider";
import uiEn from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import type { LineupSlotIn, SideInfo } from "@/components/v2/fixture-console";

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
    is_captain: false,
    roles: [],
  };
}

const base = {
  fixtureId: "f1",
  roles: [],
  lineupSize: 1,
  onSaved: () => {},
};

// ---------------------------------------------------------------------------
// Defect 1 — role
// ---------------------------------------------------------------------------

describe("draftFromSavedLineup — role", () => {
  it("carries a saved coach role into the draft (was silently dropped to the SlotDraft default)", () => {
    const lineup: LineupSlotIn[] = [
      { person_id: "p1", full_name: "Coach One", slot: "starting", position_key: null, order_no: 1, roles: [], role: "coach" },
    ];
    expect(draftFromSavedLineup(lineup)[0]?.role).toBe("coach");
  });

  it("an absent role defaults the draft to player", () => {
    const lineup: LineupSlotIn[] = [
      { person_id: "p1", full_name: "A", slot: "starting", position_key: null, order_no: 1, roles: [] },
    ];
    expect(draftFromSavedLineup(lineup)[0]?.role).toBe("player");
  });
});

describe("toPutSlot — role (the regression: save() used to omit this key entirely)", () => {
  const draft: SlotDraft = {
    person_id: "p1",
    full_name: "Coach One",
    slot: "starting",
    position_key: null,
    order_no: 1,
    roles: [],
    role: "coach",
    pair_order: null,
  };

  it("includes the slot's role in the PUT body", () => {
    expect(toPutSlot(draft, 0).role).toBe("coach");
  });

  it("end-to-end: a coach round-trips through the SAVE payload, `toLineupSlot` and the engine fold, and is excluded from the pool (must fail without the editor fix)", () => {
    const footballModule = (builtinModules as readonly AnySportModule[]).find((m) => m.key === "football")!;
    const cfg = footballModule.configSchema.parse({});
    const slots: SlotDraft[] = [
      { person_id: "p-player", full_name: "Player One", slot: "starting", position_key: "GK", order_no: 1, roles: [], role: "player", pair_order: null },
      draft, // the coach, person_id "p1"
    ];
    // Exactly what LineupEditor.save() now sends as the PUT body.
    const putBody = { slots: slots.map(toPutSlot) };
    // Exactly what a re-read would hand back (readLineup's column order),
    // fed straight into the SAME wire type the real page loader uses.
    const rereadLineup: LineupSlotIn[] = putBody.slots.map((s, i) => ({
      person_id: s.person_id,
      full_name: slots[i]!.full_name,
      slot: s.slot,
      position_key: s.position_key,
      order_no: s.order_no,
      roles: s.roles,
      role: s.role,
      pair_order: s.pair_order,
    }));
    const home: SideInfo = { id: "ent-h", name: "Home", members: [], lineup: rereadLineup };
    const away: SideInfo = { id: "ent-a", name: "Away", members: [], lineup: [] };
    const lineups = lineupPairFrom(home, away);

    const state = foldClient(footballModule, cfg, lineups, [
      makeEnvelope(0, { type: "core.start", payload: {} }),
    ]) as { squads: { home: { onPitch: readonly string[]; bench: readonly string[] } } };
    expect(state.squads.home.onPitch).toContain("p-player");
    expect(state.squads.home.onPitch).not.toContain("p1");
    expect(state.squads.home.bench).not.toContain("p1");
  });
});

describe("LineupEditor renders a role control per slot", () => {
  it("shows a role select for a prefilled draft row", () => {
    const side: SideInfo = { id: "e1", name: "Home", members: [member(1)], lineup: [] };
    const html = wrap(<LineupEditor {...base} positionGroups={[]} side={side} canEdit={true} />);
    expect(html).toContain("Role for Player 1");
  });
});

// ---------------------------------------------------------------------------
// Defect 2 — pair_order
// ---------------------------------------------------------------------------

describe("isPairShaped", () => {
  it("true for an empty position catalog with exactly two roster members (tennis/badminton/tabletennis doubles shape)", () => {
    expect(isPairShaped([], 2)).toBe(true);
  });

  it("false with a position catalog (team sports: football, hockey, ...)", () => {
    expect(isPairShaped([{ key: "GK" }], 2)).toBe(false);
  });

  it("false with one member (singles/individual)", () => {
    expect(isPairShaped([], 1)).toBe(false);
  });

  it("false with more than two members (a team roster, even with no positions declared)", () => {
    expect(isPairShaped([], 5)).toBe(false);
  });
});

describe("draftFromSavedLineup / toPutSlot — pair_order", () => {
  it("a saved pair_order reaches the draft", () => {
    const lineup: LineupSlotIn[] = [
      { person_id: "p1", full_name: "A", slot: "starting", position_key: null, order_no: 1, roles: [], pair_order: 2 },
    ];
    expect(draftFromSavedLineup(lineup)[0]?.pair_order).toBe(2);
  });

  it("an unset pair_order defaults the draft to null", () => {
    const lineup: LineupSlotIn[] = [
      { person_id: "p1", full_name: "A", slot: "starting", position_key: null, order_no: 1, roles: [] },
    ];
    expect(draftFromSavedLineup(lineup)[0]?.pair_order).toBeNull();
  });

  it("the PUT body carries pair_order through unchanged", () => {
    const draft: SlotDraft = {
      person_id: "p1", full_name: "A", slot: "starting", position_key: null,
      order_no: 1, roles: [], role: "player", pair_order: 1,
    };
    expect(toPutSlot(draft, 0).pair_order).toBe(1);
  });

  it("full chain: save -> read -> toLineupSlot -> LineupSlot.pairOrder", () => {
    const draft: SlotDraft = {
      person_id: "p1", full_name: "A", slot: "starting", position_key: null,
      order_no: 1, roles: [], role: "player", pair_order: 1,
    };
    const putBody = { slots: [draft].map(toPutSlot) };
    const reread: LineupSlotIn[] = putBody.slots.map((s, i) => ({
      person_id: s.person_id, full_name: [draft][i]!.full_name, slot: s.slot,
      position_key: s.position_key, order_no: s.order_no, roles: s.roles,
      role: s.role, pair_order: s.pair_order,
    }));
    const home: SideInfo = { id: "ent-h", name: "Home", members: [], lineup: reread };
    const pair = lineupPairFrom(home, { id: "ent-a", name: "Away", members: [], lineup: [] });
    expect(pair.home.slots[0]).toMatchObject({ personId: "p1", pairOrder: 1 });
  });
});

describe("LineupEditor renders a pair-order control only for a pair-shaped side", () => {
  it("renders it when positionGroups is empty and the roster has exactly two members", () => {
    const side: SideInfo = { id: "e1", name: "Home", members: [member(1), member(2)], lineup: [] };
    const html = wrap(
      <LineupEditor {...base} positionGroups={[]} lineupSize={1} side={side} canEdit={true} />,
    );
    expect(html).toContain("Pair order for Player 1");
  });

  it("does NOT render it for a team sport with a position catalog, even with two members — no disabled control either", () => {
    const side: SideInfo = { id: "e1", name: "Home", members: [member(1), member(2)], lineup: [] };
    const html = wrap(
      <LineupEditor
        {...base}
        positionGroups={[{ key: "GK", name: "Goalkeeper" }]}
        lineupSize={2}
        side={side}
        canEdit={true}
      />,
    );
    expect(html).not.toContain("Pair order for Player 1");
    expect(html).not.toContain('name="pair_order"');
  });

  it("does NOT render it for an individual (one-member) entrant", () => {
    const side: SideInfo = { id: "e1", name: "Home", members: [member(1)], lineup: [] };
    const html = wrap(<LineupEditor {...base} positionGroups={[]} side={side} canEdit={true} />);
    expect(html).not.toContain("Pair order for Player 1");
  });
});
