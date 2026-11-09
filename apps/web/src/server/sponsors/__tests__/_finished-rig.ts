// Test rig (R4 sponsors on stream, S12): a REAL finished match in the database, for the On stream tab's preview (ruling R11).
//
// The ledger is the engine's own: the testkit's `buildWalk` generates a valid stream for the sport under the division's own config,
// and the rig CHOOSES a seed by property (a played-to-result match, no forfeit or abandon, with at least one major break and, for
// a sport that declares minors, one minor) instead of trusting a literal seed - an engine release that changes what a seed walks
// to cannot silently turn the suite into a test of an empty match. The expected breaks are the ORACLE: the sport's own
// `naturalBreaks.opensAt`, asked of each event with the state before and after it, sized by the sport's own `kinds` - never the
// loader's output.
//
// The events are written straight into `score_events` (recorded two minutes apart, so no minor is thinned by the 90 s cooldown)
// rather than through `appendEvent`: a walk names players ("H-p1") that a lineup-less fixture would refuse on the write path, and
// the preview only ever READS a finished ledger. The fixture is then marked `decided` with the finish time the caller picks,
// which is what "most recent" orders on.
import { builtinModules } from "@seazn/engine/sports";
import { buildWalk, defaultLineupPair } from "@seazn/engine/testkit";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";

export const T0 = Date.parse("2026-10-31T10:00:00.000Z");
/** Two minutes between events: outside the planner's 90 s cooldown, so every eligible break draws a card. */
export const EVENT_GAP_MS = 120_000;

export interface OracleBreak {
  seq: number;
  kind: string;
  size: "minor" | "major";
  at: string;
}
export interface Walk {
  events: { seq: number; type: string; payload: unknown }[];
  /** What the sport's own declaration says the walk opens. */
  breaks: OracleBreak[];
}

export const moduleOf = (sportKey: string) => {
  const m = builtinModules.find((mod) => mod.key === sportKey);
  if (!m) throw new Error(`no builtin module for "${sportKey}"`);
  return m;
};

/** The event times a rig writes: the n-th event is recorded n gaps after T0. */
export const atOf = (seq: number): string => new Date(T0 + seq * EVENT_GAP_MS).toISOString();

/**
 * A walk that is a played match with breaks in it, found by property. `skip` seeds are passed over, so two fixtures of one sport
 * can be given DIFFERENT matches (the "most recent wins" case needs two that differ).
 */
export function chooseWalk(sportKey: string, cfgInput: unknown, skip = 0): Walk {
  const mod = moduleOf(sportKey);
  const nb = mod.naturalBreaks;
  if (nb === undefined) throw new Error(`${sportKey} declares no breaks`);
  const cfg = mod.configSchema.parse(cfgInput);
  const lineups = defaultLineupPair(mod.positions);
  const hasMinor = nb.kinds.some((k) => k.size === "minor");
  let found = 0;
  for (let seed = 1; seed <= 80; seed++) {
    const { events, states } = buildWalk(mod as never, cfg as never, lineups, seed, 600);
    if (events.some((e) => e.type === "core.forfeit" || e.type === "core.abandon")) continue;
    const init = mod.init(cfg as never, lineups);
    const breaks: OracleBreak[] = [];
    events.forEach((ev, i) => {
      for (const kind of nb.opensAt(ev as never, (i === 0 ? init : states[i - 1]) as never, states[i] as never)) {
        const size = nb.kinds.find((k) => k.kind === kind)?.size;
        if (size === undefined) throw new Error(`${sportKey}: opened a kind it never declared: ${kind}`);
        breaks.push({ seq: ev.seq, kind, size, at: atOf(ev.seq) });
      }
    });
    const majors = breaks.filter((b) => b.size === "major").length;
    const minors = breaks.length - majors;
    if (majors === 0 || (hasMinor && minors === 0)) continue;
    if (found++ < skip) continue;
    return { events: events.map((e) => ({ seq: e.seq, type: e.type, payload: e.payload })), breaks };
  }
  throw new Error(`${sportKey}: no seed in 1..80 walks to a match with breaks (skip ${skip})`);
}

export interface RiggedDivision {
  divisionId: string;
  cfg: unknown;
  fixtureId: string;
  /** The testkit's tokens ("H", "A", "H-p1"...) -> the rows this fixture really has (entrant and person ids). */
  ids: Map<string, string>;
}

/** Individual sports refuse team entrants (the division says so); every other rigged sport takes a team pair. */
const ENTRANT_KIND: Record<string, "individual" | "team"> = { badminton: "individual", tabletennis: "individual", tennis: "individual" };

/**
 * A division of `sportKey` in the competition, with a pair of entrants, ONE generated fixture and its line-ups. A walk names
 * sides ("H"/"A") and players ("H-p1") by the testkit's tokens; the fixture has uuids, so the line-ups are written from the
 * testkit's own `defaultLineupPair` (persons and `lineups` rows) and `ids` maps every token to its row.
 */
export async function seedDivision(auth: AuthCtx, competitionId: string, sportKey: string, variantKey: string, name: string): Promise<RiggedDivision> {
  const division = await createDivision(auth, competitionId, { name, sport_key: sportKey, variant_key: variantKey, config: {} });
  const kind = ENTRANT_KIND[sportKey] ?? "team";
  await createEntrants(auth, division.id, ["Harbour", "Ridge"].map((n, i) => ({ kind, display_name: n, seed: i + 1, members: [] })));
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "League", config: {} });
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  const fx = fixtures[0] as { id: string; home_entrant_id: string; away_entrant_id: string };
  const ids = new Map<string, string>([["H", fx.home_entrant_id], ["A", fx.away_entrant_id]]);
  const pair = defaultLineupPair(moduleOf(sportKey).positions);
  for (const side of [pair.home, pair.away]) {
    for (const slot of side.slots) {
      const [person] = await sql<{ id: string }[]>`
        insert into persons (org_id, full_name) values (${auth.orgId}, ${slot.personId}) returning id`;
      ids.set(slot.personId, person!.id);
      await sql`
        insert into lineups (fixture_id, entrant_id, person_id, org_id, slot, position_key, order_no, roles)
        values (${fx.id}, ${ids.get(side.entrantId)!}, ${person!.id}, ${auth.orgId}, ${slot.slot}, ${slot.positionKey ?? null},
                ${slot.orderNo ?? null}, ${sql.json((slot.roles ?? []) as never)})`;
    }
  }
  return { divisionId: division.id, cfg: division.config, fixtureId: fx.id, ids };
}

/** The walk's payload with every testkit token replaced by the fixture's real id (strings only, at any depth). */
function translate(value: unknown, ids: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") return ids.get(value) ?? value;
  if (Array.isArray(value)) return value.map((v) => translate(v, ids));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, translate(v, ids)]));
  }
  return value;
}

/** Writes the walk as the fixture's ledger and finishes it at `finishedAt` with `status` (default `decided`). */
export async function finishWith(orgId: string, rig: RiggedDivision, walk: Walk, finishedAt: Date, status = "decided"): Promise<void> {
  const fixtureId = rig.fixtureId;
  for (const e of walk.events) {
    await sql`
      insert into score_events (fixture_id, org_id, seq, type, payload, recorded_at)
      values (${fixtureId}, ${orgId}, ${e.seq}, ${e.type}, ${sql.json(translate(e.payload, rig.ids) as never)}, ${atOf(e.seq)})`;
  }
  await sql`update fixtures set status = ${status} where id = ${fixtureId}`;
  // The trigger stamped now(); the stamp is what "most recent" orders on, so it is the caller's.
  await sql`update fixtures set finished_at = ${finishedAt.toISOString()} where id = ${fixtureId}`;
}
