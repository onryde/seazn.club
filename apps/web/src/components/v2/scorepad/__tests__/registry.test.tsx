// S12/#421 W10 originally, now the post-lane-demolition survivors (R7): the
// SINGLE registry both real entry points consult, and the wire/lineup/person
// builders both page loaders share. The drift guard this file used to carry
// over registry.tsx's `resolveScorePad`/`RESOLUTION_KIND`/`NO_V2_SKIN_SPORTS`
// table is gone along with the table itself — R7 demolished the legacy v2
// pad lane once carrom (the last sport) converted to v3, so `RESOLUTION_KIND`
// had no "skin" rows left and `resolveScorePad` had no callers left to prove
// consistent. See registry.tsx's own header for the full record.
import { describe, expect, it, vi } from "vitest";
import type { AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { makeEnvelope } from "@seazn/engine/testkit";
import type { SideInfo } from "@/components/v2/fixture-console";
import { renderIsland } from "@/components/__tests__/_hook-harness";
import { ScorePad, lineupPairFrom, personNamesFrom } from "../registry";
import { eventOutToEnvelope } from "../wire";
import { foldClient } from "../module-client";
import { PadHostV3 } from "../v3/pad-host";
import type { SkinDefV3 } from "../v3/types";

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
    // R2/task E: resolvePad now takes a live translator too (v3/registry.ts's
    // own header explains why) — this fake sportKey never reaches a real
    // skin's own string-building, so a no-op stand-in is fine either way.
    // "cricket" is forced to "legacy" here (real module, so
    // `resolveModuleClient` still succeeds and the mock actually reaches
    // registry.tsx's own throw) — there is no real sportKey that resolves to
    // "legacy" any more (`LEGACY_SPORTS.size` is 0), so this is the only way
    // to exercise that branch at all.
    resolvePad: (key: string, t: (k: string) => string) => {
      if (key === "generic") return { lane: "v3" as const, skin: FAKE_V3_SKIN };
      if (key === "cricket") return { lane: "legacy" as const };
      return actual.resolvePad(key, t);
    },
  };
});

describe("ScorePad — the v3 lane renders PadHostV3 with the resolved skin (R2/task B)", () => {
  const home: SideInfo = { id: "ent-h", name: "Home", lineup: [], members: [] };
  const away: SideInfo = { id: "ent-a", name: "Away", lineup: [], members: [] };
  const genericConfig = { resultMode: "win_loss", allowDraws: false, points: { w: 3, d: 1, l: 0 }, progressScore: false };

  it("a sportKey resolvePad reports as v3 renders PadHostV3 with the resolved skin", () => {
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
    expect((output?.props as { skin?: unknown }).skin).toBe(FAKE_V3_SKIN);
    expect((output?.props as { fixtureId?: unknown }).fixtureId).toBe("fx-1");
    expect((output?.props as { queueDbName?: unknown }).queueDbName).toBe("scorepad-fx-1");
  });

  // R7 lane demolition: registry.tsx's own "legacy" branch used to render
  // `<PadRenderer/>`; with that renderer deleted (no sport resolves to
  // "legacy" today — `v3/__tests__/registry-totality.test.ts` pins
  // `LEGACY_SPORTS.size` at 0), the branch is now a loud throw instead of a
  // silent fallback to a component that no longer exists. Reached here only
  // by mocking `resolvePad` — there is no real sportKey that takes this path.
  it("a sportKey resolvePad reports as legacy throws, rather than silently rendering nothing", () => {
    expect(() =>
      renderIsland(ScorePad, {
        fixtureId: "fx-1",
        sportKey: "cricket", // mocked above to force the "legacy" lane
        moduleVersion: "1.0.0",
        resolvedConfig: genericConfig,
        home,
        away,
        initialEvents: [],
        auth: { kind: "session" as const },
        identity: { recordedBy: "user-1", deviceLinkId: null },
        entitlements: {},
        band: 3 as const,
      }),
    ).toThrow(/legacy pad lane/);
  });
});
