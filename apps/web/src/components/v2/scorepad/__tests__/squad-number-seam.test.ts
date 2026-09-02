// WS-SQ (ScoringPad v3, R8 sweep) — THE `squadNumber` SEAM, END TO END.
//
// `SquadMember.squadNumber` has existed in the engine since S3
// (`packages/engine/src/core/lineup.ts`), `entrant_members.squad_number` is a
// real populated column, `readLineup` (server/usecases/fixtures.ts) already
// selects it, and `LineupSlotIn` (fixture-console.tsx) already declares it —
// and the number still never reached the pad, because
// `registry.tsx`'s `toLineupSlot` hand-copies its fields and simply did not
// list this one. tsc cannot see that: an OPTIONAL field that is merely never
// set type-checks perfectly. The programme's most-repeated failure class,
// exactly.
//
// So this file deliberately does NOT build a `SquadState` fixture and hand it
// to a badge builder — that proves the fixture. It starts from the WIRE ROW
// SHAPE `readLineup` actually returns and drives the REAL production chain:
//
//   LineupSlotIn (readLineup's row)
//     -> lineupPairFrom / toLineupSlot   (registry.tsx — the hand-copy hop)
//     -> foldClient                      (the real engine fold: init + reduce)
//     -> squadStateOf                    (v3/pad-host.tsx — what `view.squads` IS)
//     -> buildSwap                       (v3/skins/football.tsx — the real consumer)
//
// SCOPE NOTE, so a future reader does not misread this file's green. The badge
// builders compute `lead = positionKey ?? squadNumber`, and `??` SHORT-CIRCUITS.
// For a player who is ON the field with a declared position, the number can
// never be reached, so plumbing it does NOT make six on-ice ice-hockey skaters
// across three position groups render six distinct badges. That precedence is a
// user-visible design decision owned by a separate follow-up, and this file
// asserts nothing about it. What plumbing DOES deliver, and what this file
// pins, is (a) the number genuinely ARRIVES in the squad state every badge
// builder reads, and (b) the BENCH/ON step — whose members carry no
// `positionKey` at all, by `memberFromSlot`'s deliberate design — gets its
// distinguisher for the first time.
import { describe, expect, it } from "vitest";
import type { AnySportModule } from "@seazn/engine/sport";
import type { SquadMember } from "@seazn/engine/core";
import { builtinModules } from "@seazn/engine/sports";
import { makeEnvelope } from "@seazn/engine/testkit";
import type { LineupSlotIn, SideInfo } from "@/components/v2/fixture-console";
import { lineupPairFrom } from "../registry";
import { foldClient } from "../module-client";
import { squadStateOf } from "../v3/pad-host";
import type { PadHostView } from "../v3/types";
import { buildSwap } from "../v3/skins/football";
import type { TFn } from "../v3/skins/football";

const t: TFn = (key, vars) => (vars ? `${key}(${JSON.stringify(vars)})` : key);

const moduleFor = (key: string): AnySportModule =>
  (builtinModules as readonly AnySportModule[]).find((m) => m.key === key)!;

/** A row exactly as `readLineup`'s SQL hands it back (snake_case, nullable
 *  columns present as `null`) — never the engine's camelCase `LineupSlot`. */
function wireRow(over: Partial<LineupSlotIn> & Pick<LineupSlotIn, "person_id">): LineupSlotIn {
  return {
    full_name: over.person_id,
    slot: "starting",
    position_key: null,
    order_no: null,
    roles: [],
    ...over,
  };
}

function side(id: string, rows: readonly LineupSlotIn[]): SideInfo {
  return { id, name: id, members: [], lineup: [...rows] };
}

const memberOf = (members: readonly SquadMember[], personId: string): SquadMember | undefined =>
  members.find((m) => m.personId === personId);

// ---------------------------------------------------------------------------
// A. Ice hockey — the shape the defect was reported against.
//
// Six skaters on the ice across only THREE position groups (icehockey.ts's
// `positions.groups`: G / D / F, `lineup.size` 6). The duplication is the
// point: a fixture whose positions are conveniently all-distinct could not
// witness anything.
// ---------------------------------------------------------------------------
describe("WS-SQ seam: squadNumber reaches `view.squads` through the real chain (ice hockey)", () => {
  const HOME_ROWS: readonly LineupSlotIn[] = [
    wireRow({ person_id: "h-g", slot: "starting", position_key: "G", order_no: 1, squad_number: 30 }),
    wireRow({ person_id: "h-d1", slot: "starting", position_key: "D", order_no: 2, squad_number: 4 }),
    wireRow({ person_id: "h-d2", slot: "starting", position_key: "D", order_no: 3, squad_number: 77 }),
    wireRow({ person_id: "h-f1", slot: "starting", position_key: "F", order_no: 4, squad_number: 9 }),
    wireRow({ person_id: "h-f2", slot: "starting", position_key: "F", order_no: 5, squad_number: 11 }),
    wireRow({ person_id: "h-f3", slot: "starting", position_key: "F", order_no: 6, squad_number: 19 }),
    // The bench. `memberFromSlot` (core/lineup.ts) deliberately drops a bench
    // slot's declared position — a preference, not an occupancy — so the shirt
    // number is the ONLY distinguisher these rows can ever have.
    wireRow({ person_id: "h-b1", slot: "bench", position_key: "F", order_no: 7, squad_number: 21 }),
    wireRow({ person_id: "h-b2", slot: "bench", position_key: "D", order_no: 8, squad_number: 55 }),
  ];

  function homeSquad() {
    const icehockey = moduleFor("icehockey");
    const cfg = icehockey.configSchema.parse({});
    const lineups = lineupPairFrom(
      side("ent-home", HOME_ROWS),
      side("ent-away", [wireRow({ person_id: "a1", position_key: "G", order_no: 1, squad_number: 1 })]),
    );
    const state = foldClient(icehockey, cfg, lineups, [makeEnvelope(0, { type: "core.start", payload: {} })]);
    return squadStateOf(state, lineups).home;
  }

  it("the fixture is REALISTIC: six on-ice skaters collapse into only three position groups", () => {
    const onIce = homeSquad().members.filter((m) => m.onField);
    expect(onIce).toHaveLength(6);
    // Guards this file against quietly becoming a fixture with unique
    // positions, which would make every assertion below vacuous.
    expect(new Set(onIce.map((m) => m.positionKey)).size).toBe(3);
  });

  it("every declared squad number arrives on the SquadMember the badge builders read", () => {
    const members = homeSquad().members;
    // Derived from the wire rows themselves, never a second table typed here:
    // a change to the fixture moves the expectation with it.
    for (const row of HOME_ROWS) {
      expect(memberOf(members, row.person_id)?.squadNumber, row.person_id).toBe(row.squad_number);
    }
  });

  it("the six on-ice skaters carry six DISTINCT numbers — the data a distinguisher needs now exists", () => {
    const onIce = homeSquad().members.filter((m) => m.onField);
    const numbers = onIce.map((m) => m.squadNumber);
    expect(numbers.every((n) => n !== undefined)).toBe(true);
    expect(new Set(numbers).size).toBe(6);
  });

  it("a bench member — who by design carries NO positionKey — still arrives with their number", () => {
    const members = homeSquad().members;
    const bench = memberOf(members, "h-b1")!;
    expect(bench.onField).toBe(false);
    expect(bench.positionKey).toBeUndefined();
    expect(bench.squadNumber).toBe(21);
  });

  it("no declared number, no position -> no invented one: the key is ABSENT, not undefined", () => {
    const icehockey = moduleFor("icehockey");
    const cfg = icehockey.configSchema.parse({});
    const lineups = lineupPairFrom(
      side("ent-home", [
        wireRow({ person_id: "h-none", order_no: 1 }),
        wireRow({ person_id: "h-null", order_no: 2, squad_number: null }),
      ]),
      side("ent-away", []),
    );
    const state = foldClient(icehockey, cfg, lineups, [makeEnvelope(0, { type: "core.start", payload: {} })]);
    const members = squadStateOf(state, lineups).home.members;
    expect(memberOf(members, "h-none")).not.toHaveProperty("squadNumber");
    expect(memberOf(members, "h-null")).not.toHaveProperty("squadNumber");
  });
});

// ---------------------------------------------------------------------------
// B. Football — the same chain driven one hop further, into the REAL badge
// builder, for the case the `??` precedence does NOT short-circuit: the ON
// step's bench pool, whose members have no `positionKey` at all.
//
// This is the user-visible behaviour this plumbing actually delivers today.
// `football.test.ts`'s own WS-D case asserts the same `lead` from a hand-built
// `initSquads({... squadNumber: 14 ...})` fixture — which is exactly the
// arrangement that stayed green for the entire time the number could not
// physically reach production. This one starts from the wire row.
// ---------------------------------------------------------------------------
describe("WS-SQ seam: a bench candidate's badge is reachable from the WIRE row (football)", () => {
  function homeSwapSlot() {
    const football = moduleFor("football");
    const cfg = football.configSchema.parse({});
    const home = side("ent-home", [
      wireRow({ person_id: "h1", slot: "starting", position_key: "GK", order_no: 1, squad_number: 1 }),
      wireRow({ person_id: "h2", slot: "starting", position_key: "CB", order_no: 2, squad_number: 4, roles: ["captain"] }),
      wireRow({ person_id: "h3", slot: "starting", position_key: "ST", order_no: 3, squad_number: 9 }),
      wireRow({ person_id: "h4", slot: "bench", order_no: 4, squad_number: 14 }),
      wireRow({ person_id: "h5", slot: "bench", order_no: 5, squad_number: 15 }),
    ]);
    const away = side("ent-away", [
      wireRow({ person_id: "a1", slot: "starting", position_key: "GK", order_no: 1, squad_number: 1 }),
      wireRow({ person_id: "a4", slot: "bench", order_no: 2, squad_number: 16 }),
    ]);
    const lineups = lineupPairFrom(home, away);
    const state = foldClient(football, cfg, lineups, [makeEnvelope(0, { type: "core.start", payload: {} })]);
    const squads = squadStateOf(state, lineups);
    const view: PadHostView = {
      cfg,
      state,
      summary: {},
      phase: "live",
      band: 3,
      entitlements: {},
      personNames: {},
      squads,
      events: [],
      contextOverrides: {},
    };
    return buildSwap(view, t)[0]!;
  }

  it("the ON step's bench rows lead with the shirt number — undefined until `toLineupSlot` carries it", () => {
    const slot = homeSwapSlot();
    expect(slot.candidates).toContain("h4");
    expect(slot.candidateMeta?.["h4"]?.lead).toBe("14");
    expect(slot.candidateMeta?.["h5"]?.lead).toBe("15");
    // Two bench rows that were previously indistinguishable now are not.
    expect(slot.candidateMeta?.["h4"]?.lead).not.toBe(slot.candidateMeta?.["h5"]?.lead);
  });
});
