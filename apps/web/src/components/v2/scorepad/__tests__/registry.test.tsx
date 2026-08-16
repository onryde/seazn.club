// S12/#421 W10 — the drift guard over registry.tsx's `resolveScorePad` table.
// S11's skins/registry.ts only names the 8 skinned sports (an unlisted sport
// resolves to `null` = universal, which is fine for PadRenderer's own
// question); THIS table must name all 11 `builtinModules` keys explicitly,
// because "universal" here is meant to be a WRITTEN decision, not a
// fallthrough — a new engine sport shipping with no row must fail CI, not
// silently render on the universal path with nobody having decided that was
// right. See registry.tsx's own header for the full reasoning.
import { describe, expect, it, vi } from "vitest";
import type { AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { makeEnvelope } from "@seazn/engine/testkit";
import type { SideInfo } from "@/components/v2/fixture-console";
import { renderIsland } from "@/components/__tests__/_hook-harness";
import { skinFor } from "../skins/registry";
import { RESOLUTION_KIND, ScorePad, lineupPairFrom, personNamesFrom, resolveScorePad } from "../registry";
import { eventOutToEnvelope } from "../wire";
import { foldClient } from "../module-client";
import { PadRenderer } from "../pad-renderer";
import { PadHostV3 } from "../v3/pad-host";
import type { SkinDefV3 } from "../v3/types";

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

  // S12/#421 pass B — Fix 3: `padSpec` is an OPTIONAL hook on `SportModule`
  // (packages/engine/src/sport/module.ts:388). `resolveScorePadBootstrap`
  // (server/usecases/fidelity.ts:117) falls back to `EMPTY_SPEC` when a
  // module has none — no declared `fidelityEntitlements`, so no gates, so
  // band 3 and the full v2 UI regardless of what the org actually bought.
  // Dead today because all 11 `builtinModules` happen to implement it, and
  // the real write path still refuses the append at the scoring door
  // (`scoring.ts`'s `requiredFeatureForEvent`) — so today's worst case is
  // misleading UI, not a billing bypass. This assertion is what turns "a
  // 12th sport forgets padSpec" into a CI failure instead of a silent,
  // ungated pad shipping — the same "written decision, not a fallthrough"
  // posture assertions 1-4 above already hold this table to.
  it("assertion 5: every builtinModules entry implements padSpec (no module ships an ungated pad)", () => {
    const missing = builtinModules.filter((m) => typeof m.padSpec !== "function").map((m) => m.key);
    expect(missing, "a module with no padSpec has no fidelityEntitlements, so no gate at all — see fidelity.ts's EMPTY_SPEC fallback").toEqual([]);
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

// ---------------------------------------------------------------------------
// S12/#421 pass B — Fix 2: `role` (player/coach/staff, S3/#426 ruling) never
// reached `toLineupSlot`'s wire shape, per registry.tsx's own (now corrected)
// comment, so `LineupSlot.role` defaulted to "player" for every client-side
// slot regardless of what was actually recorded. The DB already carries the
// real column, and `server/usecases/fixtures.ts`'s `readLineup` SQL already
// selects it — the gap was purely `LineupSlotIn` (fixture-console.tsx) never
// declaring the field, so `toLineupSlot` had nothing typed to read even
// though the runtime row already carried it.
// ---------------------------------------------------------------------------
describe("lineupPairFrom: role reaches the client LineupSlot (S12/#421 pass B, Fix 2)", () => {
  it("carries a non-player role through to the built LineupSlot", () => {
    const home: SideInfo = {
      id: "ent-h",
      name: "Home",
      members: [],
      lineup: [
        { person_id: "p-coach", full_name: "Coach One", slot: "starting", position_key: null, order_no: 1, roles: [], role: "coach" },
      ],
    };
    const pair = lineupPairFrom(home, { id: "ent-a", name: "Away", members: [], lineup: [] });
    expect(pair.home.slots[0]).toMatchObject({ personId: "p-coach", role: "coach" });
  });

  it("a player role (or an absent role) carries no `role` key at all -- mirrors server/engine-db/lineups.ts's own buildLineup convention", () => {
    const home: SideInfo = {
      id: "ent-h",
      name: "Home",
      members: [],
      lineup: [
        { person_id: "p1", full_name: "A", slot: "starting", position_key: null, order_no: 1, roles: [], role: "player" },
        { person_id: "p2", full_name: "B", slot: "starting", position_key: null, order_no: 2, roles: [] },
      ],
    };
    const pair = lineupPairFrom(home, { id: "ent-a", name: "Away", members: [], lineup: [] });
    expect(pair.home.slots[0]).not.toHaveProperty("role");
    expect(pair.home.slots[1]).not.toHaveProperty("role");
  });

  it("end-to-end: a coach-role lineup slot is excluded from football's onPitch/bench pool once the client engine folds it (the picker-pool bug this fix closes)", () => {
    const footballModule = (builtinModules as readonly AnySportModule[]).find((m) => m.key === "football")!;
    const cfg = footballModule.configSchema.parse({});
    const home: SideInfo = {
      id: "ent-h",
      name: "Home",
      members: [],
      lineup: [
        { person_id: "p-player-1", full_name: "Player One", slot: "starting", position_key: "GK", order_no: 1, roles: [], role: "player" },
        { person_id: "p-coach-1", full_name: "Coach One", slot: "starting", position_key: null, order_no: 2, roles: [], role: "coach" },
      ],
    };
    const away: SideInfo = { id: "ent-a", name: "Away", members: [], lineup: [] };
    const lineups = lineupPairFrom(home, away);

    const state = foldClient(footballModule, cfg, lineups, [makeEnvelope(0, { type: "core.start", payload: {} })]) as {
      squads: { home: { onPitch: readonly string[]; bench: readonly string[] } };
    };
    expect(state.squads.home.onPitch).toContain("p-player-1");
    expect(state.squads.home.onPitch).not.toContain("p-coach-1");
    expect(state.squads.home.bench).not.toContain("p-coach-1");
  });
});

// ---------------------------------------------------------------------------
// S12/#421 pass D — `pairOrder` (doubles serve order, S3/#426's engine
// LineupSlot field) reaches the client LineupSlot. Was previously omitted on
// purpose (this file's own prior comment: "no DB column at all today ...
// carrying it through this function would be a dead, always-undefined
// field"). V361 adds the column, `fixtures.ts` carries it through
// readLineup/putLineup, and the editor gained a control for it — this test
// mirrors the role tests immediately above exactly, one field over.
// ---------------------------------------------------------------------------
describe("lineupPairFrom: pairOrder reaches the client LineupSlot (S12/#421 pass D)", () => {
  it("carries a pairOrder value through to the built LineupSlot", () => {
    const home: SideInfo = {
      id: "ent-h",
      name: "Home",
      members: [],
      lineup: [
        { person_id: "p1", full_name: "Alice", slot: "starting", position_key: null, order_no: 1, roles: [], pair_order: 1 },
        { person_id: "p2", full_name: "Bob", slot: "starting", position_key: null, order_no: 2, roles: [], pair_order: 2 },
      ],
    };
    const pair = lineupPairFrom(home, { id: "ent-a", name: "Away", members: [], lineup: [] });
    expect(pair.home.slots[0]).toMatchObject({ personId: "p1", pairOrder: 1 });
    expect(pair.home.slots[1]).toMatchObject({ personId: "p2", pairOrder: 2 });
  });

  it("an absent or null pair_order carries no pairOrder key at all", () => {
    const home: SideInfo = {
      id: "ent-h",
      name: "Home",
      members: [],
      lineup: [
        { person_id: "p1", full_name: "Alice", slot: "starting", position_key: null, order_no: 1, roles: [] },
        { person_id: "p2", full_name: "Bob", slot: "starting", position_key: null, order_no: 2, roles: [], pair_order: null },
      ],
    };
    const pair = lineupPairFrom(home, { id: "ent-a", name: "Away", members: [], lineup: [] });
    expect(pair.home.slots[0]).not.toHaveProperty("pairOrder");
    expect(pair.home.slots[1]).not.toHaveProperty("pairOrder");
  });
});

// R2/task B — registry.tsx:280 used to throw a deliberate, loud failure for
// any sport resolved to the v3 lane ("no v3 renderer is wired yet"); this
// wave replaces it with the real branch. `V3_SKINS` (v3/registry.ts) stays
// EMPTY through the end of THIS wave (do-not-touch — cricket's own
// conversion is a later task), so there is no REAL sport this file can
// exercise the branch through without mutating that registry. Mocking
// `resolvePad` for a single sportKey proves the ROUTING decision itself
// (mutation-relevant: a mutant swapping `padLane.lane === "v3"` for
// `=== "legacy"`, or forgetting to thread `skin`, changes this test's
// outcome) — `PadHostV3`'s own body never runs here (renderIsland invokes
// `ScorePad` ONE level deep, per _hook-harness.tsx's own doc; `<PadHostV3
// .../>` below is only ever a REACT ELEMENT this test inspects, never
// called), which is exactly the intended split: the shell is e2e's job, the
// routing decision is this file's.
const FAKE_V3_SKIN: SkinDefV3 = {
  key: "generic",
  tapModel: "S",
  scorebug: () => ({
    context: "",
    phase: "live",
    halves: [
      { who: [{ name: "H" }], big: "0" },
      { who: [{ name: "A" }], big: "0" },
    ],
    strip: [],
  }),
  tiles: () => [],
  dock: () => null,
};

vi.mock("../v3/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../v3/registry")>();
  return {
    ...actual,
    resolvePad: (key: string) => (key === "generic" ? { lane: "v3" as const, skin: FAKE_V3_SKIN } : actual.resolvePad(key)),
  };
});

describe("ScorePad — the v3 lane renders PadHostV3, never PadRenderer (R2/task B)", () => {
  const home: SideInfo = { id: "ent-h", name: "Home", lineup: [], members: [] };
  const away: SideInfo = { id: "ent-a", name: "Away", lineup: [], members: [] };
  const genericConfig = { resultMode: "win_loss", allowDraws: false, points: { w: 3, d: 1, l: 0 }, progressScore: false };

  it("a sportKey resolvePad reports as v3 renders PadHostV3 with the resolved skin — the legacy PadRenderer path is never reached", () => {
    const island = renderIsland(ScorePad, {
      fixtureId: "fx-1",
      sportKey: "generic",
      moduleVersion: "1.0.0",
      resolvedConfig: genericConfig,
      home,
      away,
      initialEvents: [],
      auth: { kind: "session" as const },
      identity: { recordedBy: "user-1", deviceLinkId: null },
      entitlements: {},
      band: 3 as const,
    });
    const [output] = island.tree();
    expect(output?.type).toBe(PadHostV3);
    expect(output?.type).not.toBe(PadRenderer);
    expect((output?.props as { skin?: unknown }).skin).toBe(FAKE_V3_SKIN);
    expect((output?.props as { fixtureId?: unknown }).fixtureId).toBe("fx-1");
    expect((output?.props as { queueDbName?: unknown }).queueDbName).toBe("scorepad-fx-1");
  });
});
