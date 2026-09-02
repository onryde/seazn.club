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
// SCOPE. Sections A and B pin the PLUMBING: (a) the number genuinely ARRIVES in
// the squad state every badge builder reads, and (b) the BENCH/ON step — whose
// members carry no `positionKey` at all, by `memberFromSlot`'s deliberate
// design — gets its distinguisher.
//
// Section C pins the PRECEDENCE that spends it. The builders originally computed
// `lead = positionKey ?? squadNumber`, and `??` SHORT-CIRCUITS, so for a player
// ON the field with a declared position the number could never be reached and
// the plumbing alone did not make six on-ice ice-hockey skaters across three
// position groups render six distinct badges. The owner reversed that on
// 2026-09-01 (`lead = squadNumber ?? positionKey`); section C is that case,
// driven end to end, and it fails under the old order.
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
import { icehockeySkinV3 } from "../v3/skins/icehockey";
import type { SwapSlot } from "../v3/types";

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

/** The real chain, up to `view.squads`, for an ice-hockey home side given as
 *  WIRE ROWS. Shared by section A (which reads the squad) and section C (which
 *  drives the real skin one hop further), so the realism guard section A puts
 *  on this fixture protects section C's badges too. */
function icehockeyHome(rows: readonly LineupSlotIn[] = HOME_ROWS) {
  const icehockey = moduleFor("icehockey");
  const cfg = icehockey.configSchema.parse({});
  const lineups = lineupPairFrom(
    side("ent-home", rows),
    side("ent-away", [wireRow({ person_id: "a1", position_key: "G", order_no: 1, squad_number: 1 })]),
  );
  const state = foldClient(icehockey, cfg, lineups, [makeEnvelope(0, { type: "core.start", payload: {} })]);
  return { cfg, state, squads: squadStateOf(state, lineups) };
}

describe("WS-SQ seam: squadNumber reaches `view.squads` through the real chain (ice hockey)", () => {
  const homeSquad = () => icehockeyHome().squads.home;

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
// builder, for the ON step's bench pool: members who have no `positionKey` at
// all, and for whom the shirt number is therefore the only badge possible under
// EITHER precedence. That is what makes this section a stable plumbing witness
// rather than a precedence one — section C owns the precedence.
//
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
      // These two DECLARE a bench position, so the fixture stays realistic
      // rather than degenerate. Under the ORIGINAL `positionKey ?? squadNumber`
      // order that made the case load-bearing: `lead` was "14" only because the
      // fold refuses to treat a bench preference as an occupancy. Since the
      // 2026-09-01 reversal the number leads regardless, so the two
      // `not.toBe("ST"/"CB")` assertions below no longer witness that drop —
      // they are kept as a cheap guard that a bench row shows a number and not
      // a position. `memberFromSlot`'s rule is pinned directly by section A's
      // "a bench member ... carries NO positionKey" case.
      wireRow({ person_id: "h4", slot: "bench", position_key: "ST", order_no: 4, squad_number: 14 }),
      wireRow({ person_id: "h5", slot: "bench", position_key: "CB", order_no: 5, squad_number: 15 }),
    ]);
    const away = side("ent-away", [
      wireRow({ person_id: "a1", slot: "starting", position_key: "GK", order_no: 1, squad_number: 1 }),
      wireRow({ person_id: "a4", slot: "bench", position_key: "ST", order_no: 2, squad_number: 16 }),
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
    // And explicitly NOT their declared bench position — the fixture declares
    // "ST"/"CB" for these two, so a fold that carried a bench preference as an
    // occupancy would show those instead and this assertion would fail.
    expect(slot.candidateMeta?.["h4"]?.lead).not.toBe("ST");
    expect(slot.candidateMeta?.["h5"]?.lead).not.toBe("CB");
  });
});

// ---------------------------------------------------------------------------
// C. THE CASE THE PRECEDENCE CHANGE EXISTS FOR — owner ruling, 2026-09-01:
//
//     "Number leads, position falls back — `lead = squadNumber ?? positionKey`.
//      Every skater with a declared number gets a unique badge; this is what
//      actually closes the six-identical-rows complaint. Players are known by
//      their shirt number, and it's what a scorer reads off the jersey under
//      time pressure. Position still shows for anyone with no number declared."
//
// Ice hockey puts SIX skaters on the ice across only THREE position groups
// (icehockey.ts `positions.groups`: G/D/F), so a position-LED badge can never
// distinguish more than three of them however well the number is plumbed —
// which is why section A above, written while the precedence still ran
// `positionKey ?? squadNumber`, could only pin the number's ARRIVAL and
// explicitly disclaimed the badge.
//
// Driven through the REAL ice-hockey skin — `icehockeySkinV3(t).swap`, i.e.
// `period-shared.ts`'s `periodCandidateMeta` — from the SAME wire rows section
// A folds. Not a hand-built `SquadState` handed to a builder: that arrangement
// is precisely what stayed green for the whole time the number could not
// physically reach production.
// ---------------------------------------------------------------------------
describe("WS-PREC: the swap badge leads with the shirt number (ice hockey, the six-identical-rows case)", () => {
  function homeSwapSlot(rows: readonly LineupSlotIn[] = HOME_ROWS): SwapSlot {
    const { cfg, state, squads } = icehockeyHome(rows);
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
    return icehockeySkinV3(t).swap!(view)[0]!;
  }

  it("gives the six on-ice skaters SIX DISTINCT badges — three position groups could only ever make three", () => {
    const slot = homeSwapSlot();
    const off = slot.offCandidates!;
    expect(off).toHaveLength(6);

    // Expected values derived from the WIRE ROWS themselves, never a second
    // table typed here: a change to the fixture moves the expectation with it.
    const declaredNumber = new Map(HOME_ROWS.map((row) => [row.person_id, row.squad_number]));
    for (const id of off) {
      expect(slot.candidateMeta?.[id]?.lead, id).toBe(String(declaredNumber.get(id)));
    }

    // The headline, and the assertion the old `positionKey ?? squadNumber`
    // precedence fails: six rows, six different things to read. Under the old
    // rule this Set held {"G","D","F"}.
    expect(new Set(off.map((id) => slot.candidateMeta?.[id]?.lead)).size).toBe(6);
  });

  it("the three FORWARDS — indistinguishable under a position-led badge — now read differently from each other", () => {
    const slot = homeSwapSlot();
    // Named explicitly, the way a scorer meets it: three players who share one
    // position group and must still be told apart at a glance.
    const forwards = ["h-f1", "h-f2", "h-f3"];
    const leads = forwards.map((id) => slot.candidateMeta?.[id]?.lead);
    expect(leads).toEqual(["9", "11", "19"]);
    expect(new Set(leads).size).toBe(3);
  });

  it("a skater with a position and NO declared number still shows the position — the fallback keeps working", () => {
    const slot = homeSwapSlot([
      wireRow({ person_id: "h-g", slot: "starting", position_key: "G", order_no: 1, squad_number: 30 }),
      wireRow({ person_id: "h-d1", slot: "starting", position_key: "D", order_no: 2 }),
      wireRow({ person_id: "h-d2", slot: "starting", position_key: "D", order_no: 3, squad_number: null }),
      wireRow({ person_id: "h-f1", slot: "starting", position_key: "F", order_no: 4, squad_number: 9 }),
      wireRow({ person_id: "h-f2", slot: "starting", position_key: "F", order_no: 5, squad_number: 11 }),
      wireRow({ person_id: "h-f3", slot: "starting", position_key: "F", order_no: 6, squad_number: 19 }),
    ]);
    // Absent and explicitly-null both fall back; neither invents a number.
    expect(slot.candidateMeta?.["h-d1"]?.lead).toBe("D");
    expect(slot.candidateMeta?.["h-d2"]?.lead).toBe("D");
    // …while their numbered team-mates on the same ice still lead with theirs.
    expect(slot.candidateMeta?.["h-g"]?.lead).toBe("30");
    expect(slot.candidateMeta?.["h-f1"]?.lead).toBe("9");
  });

  it("neither a number nor a position -> no badge at all: the row renders exactly as it does today", () => {
    const slot = homeSwapSlot([
      wireRow({ person_id: "h-g", slot: "starting", position_key: "G", order_no: 1, squad_number: 30 }),
      wireRow({ person_id: "h-bare", slot: "bench", order_no: 2 }),
    ]);
    expect(slot.candidates).toContain("h-bare");
    expect(slot.candidateMeta?.["h-bare"]).toBeUndefined();
  });
});
