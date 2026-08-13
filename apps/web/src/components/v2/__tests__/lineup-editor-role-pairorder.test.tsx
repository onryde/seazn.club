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
    // pairShaped=false: football is a team sport, not pair-shaped.
    expect(toPutSlot(draft, 0, false).role).toBe("coach");
  });

  it("end-to-end: a coach round-trips through the SAVE payload, `toLineupSlot` and the engine fold, and is excluded from the pool (must fail without the editor fix)", () => {
    const footballModule = (builtinModules as readonly AnySportModule[]).find((m) => m.key === "football")!;
    const cfg = footballModule.configSchema.parse({});
    const slots: SlotDraft[] = [
      { person_id: "p-player", full_name: "Player One", slot: "starting", position_key: "GK", order_no: 1, roles: [], role: "player", pair_order: null },
      draft, // the coach, person_id "p1"
    ];
    // Exactly what LineupEditor.save() now sends as the PUT body (football
    // is not pair-shaped).
    const putBody = { slots: slots.map((s, i) => toPutSlot(s, i, false)) };
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
  // S12/#421 pass E review, Finding 1: the old (positionGroups.length === 0 &&
  // memberCount === 2) heuristic was wrong for 2/11 sports — a generic TEAM
  // entrant with 2 members false-positived, and a real volleyball pair
  // false-negatived (its catalog is non-empty). The authoritative source is
  // the entrant's OWN declared kind (`entrants.kind`, set at registration and
  // validated against the division's effective entrant model —
  // server/usecases/entrants.ts's ENTRANT_KIND_NOT_ALLOWED/
  // ENTRANT_ROSTER_TOO_BIG checks — and never patchable afterward), so this
  // needs no sport-specific catalog or count inference and no per-sport list:
  // any sport that ever declares a "pair" kind is handled for free.
  it("true when the entrant's own kind is \"pair\"", () => {
    expect(isPairShaped("pair")).toBe(true);
  });

  it("false for a team entrant, even one shaped like Finding 1's false positive (empty catalog, 2 members) — kind alone decides", () => {
    expect(isPairShaped("team")).toBe(false);
  });

  it("false for an individual entrant", () => {
    expect(isPairShaped("individual")).toBe(false);
  });

  it("false when no kind is known at all (legacy/pre-field fixtures)", () => {
    expect(isPairShaped(undefined)).toBe(false);
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

  it("the PUT body carries pair_order through unchanged when the side IS pair-shaped", () => {
    const draft: SlotDraft = {
      person_id: "p1", full_name: "A", slot: "starting", position_key: null,
      order_no: 1, roles: [], role: "player", pair_order: 1,
    };
    expect(toPutSlot(draft, 0, true).pair_order).toBe(1);
  });

  // Finding 2 (S12/#421 pass E review): draftFromSavedLineup/toPutSlot used
  // to carry pair_order unconditionally, so an entrant that hit Finding 1's
  // false positive and saved a pair_order, then was read again after the fix
  // (now correctly not pair-shaped), kept re-sending that stale value on
  // every future PUT — the editor replaces the whole lineup, so this is the
  // only place a stale value can ever be cleared; there is no separate "clear"
  // control.
  it("the PUT body nulls a stale pair_order when the side is NOT pair-shaped", () => {
    const draft: SlotDraft = {
      person_id: "p1", full_name: "A", slot: "starting", position_key: null,
      order_no: 1, roles: [], role: "player", pair_order: 2, // stale, from before the side lost pair-shapedness
    };
    expect(toPutSlot(draft, 0, false).pair_order).toBeNull();
  });

  it("full chain: save -> read -> toLineupSlot -> LineupSlot.pairOrder", () => {
    const draft: SlotDraft = {
      person_id: "p1", full_name: "A", slot: "starting", position_key: null,
      order_no: 1, roles: [], role: "player", pair_order: 1,
    };
    const putBody = { slots: [draft].map((s, i) => toPutSlot(s, i, true)) };
    const reread: LineupSlotIn[] = putBody.slots.map((s, i) => ({
      person_id: s.person_id, full_name: [draft][i]!.full_name, slot: s.slot,
      position_key: s.position_key, order_no: s.order_no, roles: s.roles,
      role: s.role, pair_order: s.pair_order,
    }));
    const home: SideInfo = { id: "ent-h", name: "Home", kind: "pair", members: [], lineup: reread };
    const pair = lineupPairFrom(home, { id: "ent-a", name: "Away", members: [], lineup: [] });
    expect(pair.home.slots[0]).toMatchObject({ personId: "p1", pairOrder: 1 });
  });
});

describe("LineupEditor renders a pair-order control only for a pair-shaped entrant (side.kind === \"pair\")", () => {
  it("renders it for a pair-kind entrant with an empty position catalog (tennis/badminton/tabletennis/carrom doubles shape)", () => {
    const side: SideInfo = { id: "e1", name: "Home", kind: "pair", members: [member(1), member(2)], lineup: [] };
    const html = wrap(
      <LineupEditor {...base} positionGroups={[]} lineupSize={1} side={side} canEdit={true} />,
    );
    expect(html).toContain("Pair order for Player 1");
  });

  // Finding 1's false negative: volleyball beach pairs declare a real 5-group
  // position catalog (packages/engine/src/sports/setbased/volleyball.ts), so
  // the old empty-catalog heuristic never showed the control for them.
  it("renders it for a volleyball beach-pair entrant despite a non-empty position catalog", () => {
    const side: SideInfo = { id: "e1", name: "Home", kind: "pair", members: [member(1), member(2)], lineup: [] };
    const volleyballPositions = [
      { key: "P1", name: "Position 1" },
      { key: "P2", name: "Position 2" },
      { key: "P3", name: "Position 3" },
      { key: "P4", name: "Position 4" },
      { key: "P5", name: "Position 5" },
    ];
    const html = wrap(
      <LineupEditor {...base} positionGroups={volleyballPositions} lineupSize={2} side={side} canEdit={true} />,
    );
    expect(html).toContain("Pair order for Player 1");
  });

  // Finding 1's false positive: a generic TEAM entrant that happens to hold
  // exactly two members used to read as "pair-shaped" too (generic declares
  // no position catalog and no entrantModel, so effectiveEntrantModel's
  // default upper-bound-only check never rejected a 2-member team).
  it("does NOT render it for a generic team entrant with exactly two members", () => {
    const side: SideInfo = { id: "e1", name: "Home", kind: "team", members: [member(1), member(2)], lineup: [] };
    const html = wrap(<LineupEditor {...base} positionGroups={[]} lineupSize={1} side={side} canEdit={true} />);
    expect(html).not.toContain("Pair order for Player 1");
    expect(html).not.toContain('name="pair_order"');
  });

  it("does NOT render it for a team sport with a position catalog, even with two members — no disabled control either", () => {
    const side: SideInfo = { id: "e1", name: "Home", kind: "team", members: [member(1), member(2)], lineup: [] };
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
    const side: SideInfo = { id: "e1", name: "Home", kind: "individual", members: [member(1)], lineup: [] };
    const html = wrap(<LineupEditor {...base} positionGroups={[]} side={side} canEdit={true} />);
    expect(html).not.toContain("Pair order for Player 1");
  });

  it("does NOT render it when the side carries no kind at all (legacy fixture predating the field)", () => {
    const side: SideInfo = { id: "e1", name: "Home", members: [member(1), member(2)], lineup: [] };
    const html = wrap(<LineupEditor {...base} positionGroups={[]} lineupSize={1} side={side} canEdit={true} />);
    expect(html).not.toContain("Pair order for Player 1");
  });
});
