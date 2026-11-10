import "server-only";
// Fixture generation primitives: the americano rotation, the bracket/round-robin
// generators and their dispatcher (`generate`), pool-count and snake draw, the
// knockout draw order and its stored seed, and the departed-qualifier walkovers.

import { randomUUID } from "node:crypto";
import { swissDrawSeed, swissRoundOneOrder } from "@/lib/swiss-draw";
import { chessIndividualOnlyError, isChessSport } from "@/lib/chess-individual-only";
import { EngineError } from "@seazn/engine/core";
import { generateRoundRobin, generateSingleElim, generateDoubleElim, generatePagePlayoff, generateStepladder, type BracketFixtureGen, type GeneratedBracket, generateAmericano, pairMexicanoRound, type AmericanoRound } from "@seazn/engine/scheduling";
import { withdrawBracketEntrant, type BracketFixture } from "@seazn/engine/competition";
import { byeAward } from "@/lib/fixture-bye";
import { parseExtKey } from "@/server/engine-db/competition";
import { engineRoundOf, laneDepthOf } from "@/server/engine-db/bracket-rounds";
import { bracketRosterOf } from "@/server/engine-db/bracket-roster";
import type { Tx, GenFixture, ActiveEntrant } from "./types";

// ---------------------------------------------------------------------------
// Fixture generation (doc 08 §3 — idempotent, returns diff)
// ---------------------------------------------------------------------------

// A generator fixture normalised for persistence, identity = ext_key (the pure
// generator's stable id, spec 05 §6 — regeneration is byte-identical).
// ---------------------------------------------------------------------------
// Americano / Mexicano (Jul3/08 §3, 21 May): individuals rotate partners; the
// stage creates `pair` entrants on the fly for each fixture. Americano is a
// fixed seeded rotation generated upfront; mexicano derives each next round
// from the current per-person points (rank-quartet pairing).
// ---------------------------------------------------------------------------

/**
 * Resolve (or create) the `pair` entrants for a set of person pairs in one
 * batch — an americano stage references dozens of pairs per generate, so a
 * per-pair lookup/insert is a round-trip storm over a pooled connection.
 * Returns a map keyed by the sorted person ids joined with "," → entrant id.
 */
async function pairEntrantsFor(
  tx: Tx,
  divisionId: string,
  pairs: [string, string][],
): Promise<Map<string, string>> {
  const byPair = new Map<string, string>();
  const wanted = new Map<string, [string, string]>();
  for (const p of pairs) {
    const sorted = [...p].sort() as [string, string];
    wanted.set(sorted.join(","), sorted);
  }
  if (wanted.size === 0) return byPair;

  const existing = await tx<{ id: string; members: string[] }[]>`
    select e.id, array_agg(em.person_id order by em.person_id) as members
    from entrants e
    join entrant_members em on em.entrant_id = e.id
    where e.division_id = ${divisionId} and e.kind = 'pair'
    group by e.id`;
  for (const row of existing) {
    const key = row.members.join(",");
    if (wanted.has(key) && !byPair.has(key)) byPair.set(key, row.id);
  }

  const missing = [...wanted.entries()].filter(([key]) => !byPair.has(key));
  if (missing.length === 0) return byPair;

  const personIds = [...new Set(missing.flatMap(([, pair]) => pair))];
  const names = await tx<{ id: string; full_name: string }[]>`
    select id, full_name from persons where id in ${tx(personIds)}`;
  const nameOf = new Map(names.map((n) => [n.id, n.full_name]));

  // Ids are generated client-side so both inserts go out as one multi-row
  // statement each, without relying on RETURNING order.
  const entrantRows = missing.map(([, sorted]) => ({
    id: randomUUID(),
    division_id: divisionId,
    kind: "pair",
    display_name: sorted.map((id) => nameOf.get(id) ?? id).join(" / "),
  }));
  await tx`insert into entrants ${tx(entrantRows)}`;
  const memberRows = missing.flatMap(([, sorted], i) =>
    sorted.map((personId) => ({
      entrant_id: entrantRows[i].id,
      person_id: personId,
      is_captain: false,
    })),
  );
  await tx`insert into entrant_members ${tx(memberRows)}`;
  missing.forEach(([key], i) => byPair.set(key, entrantRows[i].id));
  return byPair;
}

export async function americanoGen(
  tx: Tx,
  divisionId: string,
  stageId: string,
  cfg: Record<string, unknown>,
  entrants: ActiveEntrant[],
): Promise<GenFixture[]> {
  // Chess is individual-only (owner ruling 2026-10-26). This stage mints `pair` entrants for every rotation
  // (pairEntrantsFor below). The create door refuses the stage for chess (assertStageBatchGates, follow-up to #1027);
  // this guard stays for a chess americano stage stored before that refusal, before a single pair is written.
  const [sportRow] = await tx<{ sport_key: string }[]>`select sport_key from divisions where id = ${divisionId}`;
  if (sportRow && isChessSport(sportRow.sport_key)) throw chessIndividualOnlyError();
  // players = the PERSONS behind the individual entrants
  const entrantIds = entrants.map((e) => e.id);
  if (entrantIds.length === 0) return [];
  const memberRows = await tx<{ entrant_id: string; person_id: string }[]>`
    select entrant_id, person_id from entrant_members
    where entrant_id in ${tx(entrantIds)}`;
  const personOf = new Map(memberRows.map((r) => [r.entrant_id, r.person_id]));
  const players = entrantIds
    .map((id) => personOf.get(id))
    .filter((p): p is string => p !== undefined);
  if (players.length < 4) {
    throw new EngineError("STAGE_NOT_READY", "americano needs at least 4 individual players with linked persons", {
      players: players.length,
    });
  }
  const mode = cfg.mode === "mexicano" ? "mexicano" : "americano";
  const courtCount =
    typeof cfg.courtCount === "number" ? cfg.courtCount : Math.max(1, Math.floor(players.length / 4));
  const rounds = typeof cfg.rounds === "number" ? cfg.rounds : Math.max(3, players.length - 1);

  let planned: AmericanoRound[];
  if (mode === "americano") {
    planned = generateAmericano(players, { mode, courtCount, rounds });
  } else {
    // mexicano: next round only once every prior fixture decided
    const existing = await tx<{ round_no: number; status: string }[]>`
      select round_no, status from fixtures where stage_id = ${stageId}`;
    const playedRounds = existing.length > 0 ? Math.max(...existing.map((f) => f.round_no)) : 0;
    if (existing.some((f) => f.status !== "decided")) return []; // wait
    if (playedRounds >= rounds) return [];
    // per-person points: sum of each player's pair score across decided games
    const scores = await tx<{ person_id: string; pts: number }[]>`
      select em.person_id, coalesce(sum(
        case when f.home_entrant_id = em.entrant_id
             then (m.state->'score'->>'home')::numeric
             else (m.state->'score'->>'away')::numeric end), 0) as pts
      from fixtures f
      join match_states m on m.fixture_id = f.id
      join entrant_members em on em.entrant_id in (f.home_entrant_id, f.away_entrant_id)
      where f.stage_id = ${stageId} and f.status = 'decided'
      group by em.person_id`;
    const pts = new Map(scores.map((r) => [r.person_id, Number(r.pts)]));
    planned = [
      pairMexicanoRound(
        players.map((p) => ({ playerId: p, points: pts.get(p) ?? 0 })),
        { courtCount },
        playedRounds + 1,
      ),
    ];
  }

  const pairIds = await pairEntrantsFor(
    tx,
    divisionId,
    planned.flatMap((r) => r.matches.flatMap((m) => [m.team1, m.team2])),
  );
  const idFor = (p: [string, string]) => pairIds.get([...p].sort().join(","))!;
  const gen: GenFixture[] = [];
  for (const round of planned) {
    for (const m of round.matches) {
      gen.push({
        extKey: m.id,
        roundNo: m.roundNo,
        seqInRound: m.court,
        home: idFor(m.team1),
        away: idFor(m.team2),
      });
    }
  }
  return gen;
}

function bracketToGen(bracket: GeneratedBracket, laneDepth: number): GenFixture[] {
  // Per-(lane, round) counters give a stable seq_in_round in emission order.
  const counters = new Map<string, number>();
  const laneOffset = (f: BracketFixtureGen): number =>
    f.bracket === "LB" ? laneDepth : f.bracket === "GF" ? laneDepth * 2 : 0;
  return bracket.fixtures.map((f) => {
    const roundNo = laneOffset(f) + f.round + 1;
    const n = (counters.get(`${f.bracket ?? "WB"}:${roundNo}`) ?? 0) + 1;
    counters.set(`${f.bracket ?? "WB"}:${roundNo}`, n);
    return {
      extKey: f.id,
      roundNo,
      seqInRound: n,
      home: f.home ?? f.award ?? null,
      away: f.away ?? null,
      ...(f.homeFrom ? { homeFrom: { extKey: f.homeFrom.fixtureId, side: f.homeFrom.side } } : {}),
      ...(f.awayFrom ? { awayFrom: { extKey: f.awayFrom.fixtureId, side: f.awayFrom.side } } : {}),
      ...(f.award ? { award: f.award } : {}),
      ...(f.bracket ? { lane: f.bracket } : {}),
      ...(f.isFinal ? { isFinal: true } : {}),
      ...(f.thirdPlace ? { thirdPlace: true } : {}),
      ...(f.conditional ? { conditional: true } : {}),
    };
  });
}

/** Spec 05 §5's own stage-kind split FOR THE WITHDRAWAL POLICY: these are the
 *  kinds that walk a departure over to the opponent. League/group/swiss
 *  expunge it; everything else (including `page_playoff`) voids the remaining
 *  games as an open format.
 *
 *  Deliberately NOT this file's other `BRACKET_KINDS` (further down, and in
 *  engine-db/competition.ts and public-site/champion.ts): that set means
 *  "this stage is bracket-SHAPED" and contains `page_playoff`. This one is
 *  the narrower list the engine's `withdrawBracketEntrant` accepts, and the
 *  exact list `withdrawEntrantCascade` dispatches on — the two are not
 *  interchangeable, and widening this one would silently start walking over
 *  page-playoff fixtures that the cascade voids.
 *
 *  Exported so withdrawal.ts and the generation path below read ONE list: the
 *  whole point of F14 is that "withdraw then generate" and "generate then
 *  withdraw" agree, and two private copies of this set is the obvious way for
 *  them to stop agreeing. */
export const BRACKET_WALKOVER_KINDS: ReadonlySet<string> = new Set([
  "knockout",
  "double_elim",
  "stepladder",
]);

export const EMPTY_ID_SET: ReadonlySet<string> = new Set<string>();

/** F14 — owner ruling 2026-09-21. A qualifier who departed BEFORE the bracket
 *  was generated keeps their drawn seat, and their pairing becomes a walkover
 *  for the surviving side. The draw is preserved; nobody is promoted.
 *
 *  The POLICY is the cascade's own: `withdrawBracketEntrant` is the same pure
 *  engine function `withdrawEntrantCascade` calls once the bracket exists, so
 *  the two orderings of "withdraw" and "generate" cannot drift onto different
 *  rules. Only the APPLICATION differs, and it has to — at generation time the
 *  fixture has no row and no id, so there is nothing to post a `core.forfeit`
 *  scoring event against. The same OUTCOME is baked into the insert instead:
 *  both seats filled, `status: 'forfeited'`, `{kind: 'award', winner}`, which
 *  is precisely the shape every sport kernel emits for a two-sided walkover
 *  (and which `isOneSidedAwardBye` keeps separate from a real bye).
 *
 *  Every line is fed in as `scheduled`, byes included. Marking an
 *  already-awarded bye SETTLED (which is what the post-generation cascade
 *  sees, and what this code did first) changes NOTHING and was removed as
 *  decoration: a mutation sweep proved the branch inert, because the engine
 *  only ever emits a ONE-SIDED bye, so `withdrawBracketEntrant` finds no
 *  opponent to hand the walkover to and the update is discarded below either
 *  way. The bye is left alone by the `walkoverTo === undefined` arm, which
 *  IS covered. */
export function walkoverDepartedQualifiers(
  stageId: string,
  kind: string,
  gen: GenFixture[],
  departed: ReadonlySet<string>,
): { gen: GenFixture[]; voided: ReadonlySet<string> } {
  // C5/C9: the engine's round is 0-based per lane; `roundNo` is the stored, offset one.
  const laneDepth = laneDepthOf(gen.map((g) => ({ lane: parseExtKey(g.extKey).bracket, roundNo: g.roundNo })));
  const fixtures: BracketFixture[] = gen.map((g) => ({
    id: g.extKey,
    round: engineRoundOf(g.roundNo, parseExtKey(g.extKey).bracket, laneDepth),
    status: "scheduled" as const,
    ...(g.home === null ? {} : { home: g.home }),
    ...(g.away === null ? {} : { away: g.away }),
  }));
  const awardTo = new Map<string, string>();
  const voided = new Set<string>();
  const byExt = new Map(gen.map((g) => [g.extKey, g]));
  const departedSeat = new Map<string, "home" | "away">();
  for (const entrantId of departed) {
    const { updates } = withdrawBracketEntrant(
      {
        id: stageId,
        kind: kind as "knockout" | "double_elim" | "stepladder",
        // engine 5.0.0: `entrants` is the stage's DRAWN roster (`bracketRosterOf`, the same function the completion read
        // uses): everyone seated, departed included - and the departed qualifiers, who may hold no seat at all (C1/C12).
        entrants: bracketRosterOf({
          drawn: [...departed],
          seated: gen.flatMap((g) => [g.home, g.away]).filter((id): id is string => id !== null),
        }),
      },
      entrantId,
      fixtures,
    );
    for (const u of updates) {
      if (u.status !== "walkover") continue;
      // W2b D-G3 corner 3 (spec §5.4, X-WD-3): her opponent is a seat still to be FED — a stepladder's climber, any
      // later round — so there is nobody to walk over to YET. Her seat is emptied and stamped dead instead of the
      // line being voided, and whoever arrives walks over it with no organiser step (`resolveBracketSeats`). A
      // bye's phantom side is not fed (no `*From`), so her structural bye stays the recipient-less void below.
      if (u.walkoverTo === undefined) {
        const g = byExt.get(u.fixtureId);
        const side = g?.home === entrantId ? "home" : g?.away === entrantId ? "away" : undefined;
        const fed = side === "home" ? g!.away === null && g!.awayFrom !== undefined : side === "away" ? g!.home === null && g!.homeFrom !== undefined : false;
        if (side !== undefined && fed) {
          departedSeat.set(u.fixtureId, side);
          continue;
        }
      }
      // OWNER RULING 2026-09-21 (re-review C2): a walkover REQUIRES A LIVE
      // RECIPIENT. Where there is none — both sides of the pairing departed,
      // or the opponent seat is a TBD feed (stepladder, and every later
      // round) — the line is VOID, and a void line advances nobody.
      //
      // This used to `continue`, which left the line untouched and therefore
      // live: generation then seated two withdrawn entrants in a `scheduled`
      // fixture an organiser could put on a court. The comment here claimed
      // it followed the cascade's rule; it did not. The cascade rewrites such
      // an update to `{status: "void"}` and APPLIES it
      // (`withdrawal.ts`, "A TBD opponent can't receive a walkover").
      if (u.walkoverTo === undefined || departed.has(u.walkoverTo)) {
        voided.add(u.fixtureId);
        continue;
      }
      awardTo.set(u.fixtureId, u.walkoverTo);
    }
  }
  if (awardTo.size === 0 && voided.size === 0 && departedSeat.size === 0) return { gen, voided };
  // The two sets are disjoint by construction: a line is awarded only when
  // its opponent is live, and voided only when it is not.
  //
  // Stripping the award is what covers a structural BYE whose holder departed
  // — `buildSingleElim` awarded it to her before anybody withdrew, and the
  // insert below reads `g.award` for BOTH the status and the outcome, so a
  // voided line that kept its award would still be written `forfeited` with a
  // withdrawn entrant recorded as the WINNER. The line itself is already in
  // `voided`: her bye fixture seats her in `home`, so the engine reports it
  // like any other and the recipient-less branch above catches it. A second,
  // explicit `g.award && departed.has(g.award)` pass was written here first
  // and removed — mutation-tested as a true equivalent (nothing could kill
  // it), which is the evidence that this strip is the real guard.
  return {
    gen: gen.map((g) => {
      const seat = departedSeat.get(g.extKey);
      if (seat !== undefined) return { ...g, [seat]: null, departedSeat: seat };
      if (voided.has(g.extKey)) {
        const { award: awardedToNobody, ...rest } = g;
        void awardedToNobody;
        return rest;
      }
      const winner = awardTo.get(g.extKey);
      return winner === undefined ? g : { ...g, award: winner };
    }),
    voided,
  };
}

// `BYE_SLOT_LABEL` — the slot label stamped on a bye's PHANTOM side — lives in lib/bye-line.ts since W4 T3 (ruling D7:
// one authority a client-safe reader can import), beside `isByeLine`, which reads it.

/** The generator's baked award (`g.award`): a structural bye (one seat) is a bye; F14's departed-qualifier pairing
 *  (both seats filled) is the walkover a withdrawal records — `reason: "withdrew"`, the departed side the loser —
 *  so "withdraw then generate" and "generate then withdraw" store the same outcome. */
export function generatedAward(winner: string, home: string | null, away: string | null) {
  const other = winner === home ? away : home;
  return other === null ? byeAward(winner) : { kind: "award", winner, loser: other, reason: "withdrew" };
}

/**
 * W4 T7 (K5; RB4-D3, RB4-D6, X-SD-6/X-SD-9): whether a knockout's Generate DRAWS its field — the unseeded entrants placed
 * at random (`knockoutDrawOrder`), never in registration order. Not when an API `slotOrder` is set (RB4-D6: the slot map
 * overrides the draw, and it indexes into the field as given), nor when the stage draws from `config.qualified` (a fed
 * stage: that order IS the seeding), nor when nobody is unseeded (a wholly seeded field is the fold alone, X-SW-22's rule).
 */
export function knockoutDraws(active: readonly ActiveEntrant[], cfg: Record<string, unknown>): boolean {
  return !Array.isArray(cfg.slotOrder) && !Array.isArray(cfg.qualified) && active.some((e) => e.seed === null);
}

/**
 * W4 T7 (K5; RB4-D3/D4): a root knockout's field in DRAW order — the seeded first, by seed (the engine folds them,
 * RB4-D1/D2), then the unseeded shuffled with the stage's own seed (`swissRoundOneOrder(swissDrawSeed(stageId), …)`, the
 * W3 draw: one PRNG, one seed rule, so the same stage and the same field always draw the same bracket — RB4-D4, and a
 * Rebuild reuses it, RB4-D5). `active` itself (a copy, in its order) when the stage does not draw (`knockoutDraws`).
 */
export function knockoutDrawOrder(stageId: string, active: readonly ActiveEntrant[], cfg: Record<string, unknown>): ActiveEntrant[] {
  if (!knockoutDraws(active, cfg)) return [...active];
  const byId = new Map(active.map((e) => [e.id, e]));
  return swissRoundOneOrder(swissDrawSeed(stageId), active).map((id) => {
    const e = byId.get(id);
    if (e === undefined) throw new Error(`knockoutDrawOrder: the draw returned ${id}, which is not in the field`);
    return e;
  });
}

/** W4 T7 (RB4-D4): the draw seed the stage's newest Generate recorded (`fixtures_generated.payload.draw_seed`), or null —
 *  nothing generated yet, or that Generate drew nothing (a seeded field, an API slot map, a fed stage). The desk shows it
 *  (Task 20). */
export async function readStageDrawSeed(tx: Tx, stageId: string): Promise<number | null> {
  const [row] = await tx<{ seed: unknown }[]>`
    select e.payload->'draw_seed' as seed from division_events e
    where e.division_id = (select division_id from stages where id = ${stageId})
      and e.type = 'fixtures_generated' and e.payload->>'stage_id' = ${stageId}
    order by e.seq desc limit 1`;
  return typeof row?.seed === "number" ? row.seed : null;
}

// Distribute seed-ordered entrants into `count` pools by seeded snake
// (doc 05 §1: assignment seeded_snake) — 1..N, then N..1, repeating.
export function snakeDistribute<T>(ordered: readonly T[], count: number): T[][] {
  const pools: T[][] = Array.from({ length: count }, () => []);
  for (const [i, entrant] of ordered.entries()) {
    const lap = Math.floor(i / count);
    const pos = i % count;
    const pool = lap % 2 === 0 ? pos : count - 1 - pos;
    pools[pool].push(entrant);
  }
  return pools;
}

// Exported: stage-seeding.ts's sourceShapeOf (relocated there, F2 Task 6)
// needs the same pool-count derivation this file's own generation path uses,
// so the two can never drift onto different pool-count rules.
export const POOL_KEYS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function poolCount(cfg: Record<string, unknown>): number {
  const pools = cfg.pools as { count?: unknown } | undefined;
  const count = typeof pools?.count === "number" ? pools.count : 1;
  if (!Number.isInteger(count) || count < 1 || count > POOL_KEYS.length) {
    throw new EngineError("CONFIG_INVALID", `invalid pool count ${String(count)}`, { count });
  }
  return count;
}

function roundRobinGen(
  entrants: ActiveEntrant[],
  legs: number,
  extPrefix = "",
  poolId?: string,
): GenFixture[] {
  const ids = entrants.map((e) => e.id);
  const seeds = new Map(entrants.filter((e) => e.seed != null).map((e) => [e.id, e.seed as number]));
  const schedule = generateRoundRobin({ entrants: ids, seeds, config: { legs } });
  return schedule.fixtures.map((f) => ({
    extKey: extPrefix + f.id,
    roundNo: f.roundNo,
    seqInRound: f.court,
    home: f.home,
    away: f.away,
    ...(poolId ? { poolId } : {}),
  }));
}

export function generate(
  kind: string,
  cfg: Record<string, unknown>,
  entrants: ActiveEntrant[],
  poolIds: Map<string, string>, // pool key ('A'…) → pools.id
): GenFixture[] {
  const ids = entrants.map((e) => e.id);
  const seeds = new Map(entrants.filter((e) => e.seed != null).map((e) => [e.id, e.seed as number]));
  switch (kind) {
    case "league":
    case "group": {
      // Jul3/08 §2: legs > 2 allowed (triple/quad RR), capped at 8
      const rawLegs = typeof cfg.legs === "number" ? Math.trunc(cfg.legs) : 1;
      const legs = Math.min(Math.max(rawLegs, 1), 8);
      const count = kind === "group" ? poolCount(cfg) : 1;
      if (count === 1) return roundRobinGen(entrants, legs);
      // Seeded-snake pools, each playing its own round robin (doc 05 §1).
      const ordered = [...entrants].sort(
        (a, b) => (a.seed ?? Number.MAX_SAFE_INTEGER) - (b.seed ?? Number.MAX_SAFE_INTEGER),
      );
      return snakeDistribute(ordered, count).flatMap((poolEntrants, i) => {
        const key = POOL_KEYS[i];
        return roundRobinGen(poolEntrants, legs, `p${key}-`, poolIds.get(key));
      });
    }
    case "knockout": {
      const bracket = generateSingleElim({
        entrants: ids,
        seeds,
        thirdPlace: cfg.thirdPlace === true,
        // Jul3/08 §4 (7 Jan): organiser-chosen bye recipients
        ...(Array.isArray(cfg.byes) ? { byeEntrants: cfg.byes as string[] } : {}),
        // PROMPT-59 §2: explicit published slot map (seed numbers index into
        // the resolved qualification order); engine validates the shape.
        ...(Array.isArray(cfg.slotOrder)
          ? { slotOrder: (cfg.slotOrder as unknown[]).map((s) => (s === null ? null : Number(s))) }
          : {}),
      });
      return bracketToGen(bracket, bracket.rounds);
    }
    case "page_playoff": {
      const bracket = generatePagePlayoff({ entrants: ids, seeds });
      return bracketToGen(bracket, bracket.rounds);
    }
    case "double_elim": {
      const bracket = generateDoubleElim({ entrants: ids, seeds, bracketReset: cfg.bracketReset === true });
      return bracketToGen(bracket, bracket.rounds);
    }
    case "stepladder": {
      const bracket = generateStepladder({ entrants: ids, seeds });
      return bracketToGen(bracket, bracket.rounds);
    }
    default:
      throw new EngineError("CONFIG_INVALID", `cannot generate fixtures for stage kind '${kind}'`, { kind });
  }
}