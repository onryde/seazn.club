// S12/#421 W10 — the drift guard over registry.tsx's `resolveScorePad` table.
// S11's skins/registry.ts only names the 8 skinned sports (an unlisted sport
// resolves to `null` = universal, which is fine for PadRenderer's own
// question); THIS table must name all 11 `builtinModules` keys explicitly,
// because "universal" here is meant to be a WRITTEN decision, not a
// fallthrough — a new engine sport shipping with no row must fail CI, not
// silently render on the universal path with nobody having decided that was
// right. See registry.tsx's own header for the full reasoning.
import { describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import type { SideInfo } from "@/components/v2/fixture-console";
import { skinFor } from "../skins/registry";
import { RESOLUTION_KIND, eventOutToEnvelope, lineupPairFrom, personNamesFrom, resolveScorePad } from "../registry";

describe("resolveScorePad — drift guard over every builtinModules key", () => {
  it("assertion 1: every builtinModules key has a table row", () => {
    const missing = builtinModules.map((m) => m.key).filter((key) => !(key in RESOLUTION_KIND));
    expect(missing, "a new engine sport shipped with no registry decision").toEqual([]);
  });

  it("assertion 2: every table row is a real module key (no dead rows)", () => {
    const real = new Set(builtinModules.map((m) => m.key));
    const dead = Object.keys(RESOLUTION_KIND).filter((key) => !real.has(key));
    expect(dead, "a table row names a sport the engine does not ship").toEqual([]);
  });

  it("assertion 3: the table agrees with skinFor in BOTH directions", () => {
    for (const m of builtinModules) {
      const row = RESOLUTION_KIND[m.key];
      const hasSkin = skinFor(m.key) !== null;
      if (row === "skin") {
        expect(hasSkin, `"${m.key}" is marked "skin" in registry.tsx but skinFor("${m.key}") is null`).toBe(true);
      } else {
        expect(hasSkin, `"${m.key}" is marked "universal" in registry.tsx but skinFor("${m.key}") returns a skin`).toBe(
          false,
        );
      }
    }
  });

  it("assertion 4: resolveScorePad(key) returns an actual SkinDef for every 'skin' row", () => {
    for (const m of builtinModules) {
      if (RESOLUTION_KIND[m.key] !== "skin") continue;
      const resolution = resolveScorePad(m.key);
      expect(resolution.kind, `resolveScorePad("${m.key}")`).toBe("skin");
      if (resolution.kind === "skin") {
        expect(resolution.skin).toBeTruthy();
        expect(resolution.skin.sports).toContain(m.key);
      }
    }
  });

  it("every 'universal' row resolves to {kind:'universal'}, with no skin attached", () => {
    for (const m of builtinModules) {
      if (RESOLUTION_KIND[m.key] !== "universal") continue;
      expect(resolveScorePad(m.key)).toEqual({ kind: "universal" });
    }
  });

  it("an unknown sport key resolves to universal, without throwing", () => {
    expect(() => resolveScorePad("totally-unknown-sport")).not.toThrow();
    expect(resolveScorePad("totally-unknown-sport")).toEqual({ kind: "universal" });
  });

  it("the table names exactly the 11 shipped sports — 8 skinned, 3 universal (pins the known-good shape)", () => {
    expect(builtinModules.length).toBe(11);
    expect(Object.keys(RESOLUTION_KIND).length).toBe(11);
    const byKind = Object.values(RESOLUTION_KIND).reduce<Record<string, number>>((acc, kind) => {
      acc[kind] = (acc[kind] ?? 0) + 1;
      return acc;
    }, {});
    expect(byKind).toEqual({ skin: 8, universal: 3 });
  });
});

describe("eventOutToEnvelope", () => {
  it("maps snake_case wire fields to the engine's camelCase EventEnvelope", () => {
    const env = eventOutToEnvelope("fx-1", {
      id: "e-1",
      seq: 3,
      type: "core.start",
      payload: { a: 1 },
      recorded_at: "2026-08-13T00:00:00.000Z",
      recorded_by: "user-1",
      voids_event_id: null,
    });
    expect(env).toEqual({
      id: "e-1",
      fixtureId: "fx-1",
      seq: 3,
      type: "core.start",
      payload: { a: 1 },
      recordedAt: "2026-08-13T00:00:00.000Z",
      recordedBy: "user-1",
    });
    expect(env).not.toHaveProperty("voids"); // absent, not `voids: undefined`
  });

  it("maps a non-null voids_event_id to the envelope's own `voids` field", () => {
    const env = eventOutToEnvelope("fx-1", {
      id: "e-2",
      seq: 4,
      type: "core.void",
      payload: {},
      recorded_at: "2026-08-13T00:00:01.000Z",
      recorded_by: "user-1",
      voids_event_id: "e-1",
    });
    expect(env.voids).toBe("e-1");
  });

  it("recorded_by: null passes through as null, never coerced to undefined or a string", () => {
    const env = eventOutToEnvelope("fx-1", {
      id: "e-3",
      seq: 1,
      type: "core.start",
      payload: {},
      recorded_at: "2026-08-13T00:00:00.000Z",
      recorded_by: null,
      voids_event_id: null,
    });
    expect(env.recordedBy).toBeNull();
  });
});

describe("lineupPairFrom", () => {
  it("builds entrantId + slots from the two sides' wire lineups, dropping empty roles", () => {
    const home: SideInfo = {
      id: "ent-h",
      name: "Home",
      members: [],
      lineup: [
        { person_id: "p1", full_name: "Alice", squad_number: 7, slot: "starting", position_key: "GK", order_no: 1, roles: ["captain"] },
      ],
    };
    const away: SideInfo = { id: "ent-a", name: "Away", members: [], lineup: [] };
    const pair = lineupPairFrom(home, away);
    expect(pair.home).toEqual({
      entrantId: "ent-h",
      slots: [{ personId: "p1", slot: "starting", orderNo: 1, positionKey: "GK", roles: ["captain"] }],
    });
    expect(pair.away).toEqual({ entrantId: "ent-a", slots: [] });
  });

  it("a slot with no roles carries no `roles` key at all (not an empty array)", () => {
    const home: SideInfo = {
      id: "ent-h",
      name: "Home",
      members: [],
      lineup: [{ person_id: "p1", full_name: "Alice", slot: "starting", position_key: null, order_no: 1, roles: [] }],
    };
    const pair = lineupPairFrom(home, { id: "ent-a", name: "Away", members: [], lineup: [] });
    expect(pair.home.slots[0]).not.toHaveProperty("roles");
    expect(pair.home.slots[0]).not.toHaveProperty("positionKey");
  });

  it("falls back to append-order index when order_no is null — the SAME fallback server-side buildLineup uses", () => {
    const home: SideInfo = {
      id: "ent-h",
      name: "Home",
      members: [],
      lineup: [
        { person_id: "p1", full_name: "A", slot: "starting", position_key: null, order_no: null, roles: [] },
        { person_id: "p2", full_name: "B", slot: "starting", position_key: null, order_no: null, roles: [] },
      ],
    };
    const pair = lineupPairFrom(home, { id: "ent-a", name: "Away", members: [], lineup: [] });
    expect(pair.home.slots.map((s) => s.orderNo)).toEqual([1, 2]);
  });

  it("a real, explicit order_no wins over the append-order fallback", () => {
    const home: SideInfo = {
      id: "ent-h",
      name: "Home",
      members: [],
      lineup: [{ person_id: "p1", full_name: "A", slot: "bench", position_key: null, order_no: 9, roles: [] }],
    };
    const pair = lineupPairFrom(home, { id: "ent-a", name: "Away", members: [], lineup: [] });
    expect(pair.home.slots[0]!.orderNo).toBe(9);
  });
});

describe("personNamesFrom", () => {
  it("maps person_id -> full_name from both sides' members", () => {
    const home: SideInfo = {
      id: "ent-h",
      name: "Home",
      lineup: [],
      members: [{ person_id: "p1", full_name: "Alice", squad_number: null, default_position_key: null, is_captain: false, roles: [] }],
    };
    const away: SideInfo = {
      id: "ent-a",
      name: "Away",
      lineup: [],
      members: [{ person_id: "p2", full_name: "Bob", squad_number: null, default_position_key: null, is_captain: false, roles: [] }],
    };
    expect(personNamesFrom(home, away)).toEqual({ p1: "Alice", p2: "Bob" });
  });

  it("no members on either side -> an empty map, never a crash", () => {
    const empty: SideInfo = { id: "ent-h", name: "Home", lineup: [], members: [] };
    expect(personNamesFrom(empty, { ...empty, id: "ent-a" })).toEqual({});
  });
});
