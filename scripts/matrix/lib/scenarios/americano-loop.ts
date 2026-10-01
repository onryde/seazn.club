// W1-driving Task 8 (D9, owner ruling 52). Americano plans every round at
// Start's generate; a re-generate can plan again (false premise 3), so the
// loop never generates. Mexicano plans one round per generate once the
// previous round is decided. Both are bounded by the stage's own
// config.rounds; a mexicano that stops early is a named stall, never ✅.
// Suspected product reds are RECORDED (→ W7), never fixed.
//
// Mexicano is `{ kind: "americano", config.mode: "mexicano" }`
// (format-templates.ts:261, stages.ts:756), never a kind of its own: every
// mexicano branch here keys on BOTH (review 3 I-1).
import { generateAmericano, pairMexicanoRound } from "@seazn/engine/scheduling";
import type { FixtureRow, StageRef } from "../driver/types.ts";
import { routeTo } from "../routing.ts";
import { decideRound, recordGenerate, seatedOpen, type DivisionSetup, type Recorder, type RoundHook } from "./common.ts";
import type { ScenarioContext } from "./types.ts";

type Hooks = { beforeRound?: RoundHook; afterRound?: RoundHook };
type Mode = "americano" | "mexicano";

/** The predicted product reds the loop names, each with the wave it routes
 *  to. The signature words are written verbatim: Task 15 Step 3's triage rule
 *  matches on them. */
export const STALL_ROUTE = routeTo("W7", "mexicano-stalled-on-non-decided: a mexicano waits on ANY fixture not 'decided' (stages.ts:769), so a walkover or a void stops every later round (false premise 14, D9)");
export const PAIR_PLAYERS_ROUTE = routeTo("W7", "mexicano-pair-entrants-counted-as-players: the active read has no kind filter (stages.ts:2290-2293), so round 1's pair entrants are players from round 2 (false premise 17)");
export const TEAM_MEMBER_ROUTE = routeTo("W7", "americano on team entrants plays one arbitrary roster member per team (stages.ts:744-747, false premise 10)");

/** T8-R1: the product's cause for a self-pair — two identical member rows for
 *  one pair entrant hit the entrant_members primary key (V213:9), and the
 *  catch-all answers 500 with the database's message (api-v1/http.ts:244-247).
 *  Only a refusal carrying it is the self-pair; any other 5xx stays unsigned. */
export const SELF_PAIR_CAUSE = /entrant_members_pkey/;

/** n placeholder players — the engine's planners read only their count and order. */
const placeholders = (n: number): string[] => Array.from({ length: n }, (_, i) => `player-${i + 1}`);

/** T7-R1 carry: the fixtures one americano/mexicano round seats over a field
 *  of n, as the ENGINE declares it — its own planner run over n placeholder
 *  players on the stage's courtCount (generateAmericano; mexicano's round
 *  planner, pairMexicanoRound, quartets the same way). null when the stage
 *  declares no courtCount: the product's default then hangs on the live
 *  player count (stages.ts:757-758), and F1 abstains by name. */
export function americanoRoundSize(config: Readonly<Record<string, unknown>>, n: number): number | null {
  const courtCount = config.courtCount;
  if (typeof courtCount !== "number") return null;
  const players = placeholders(n);
  return config.mode === "mexicano"
    ? pairMexicanoRound(players.map((playerId) => ({ playerId, points: 0 })), { courtCount }, 1).matches.length
    : generateAmericano(players, { mode: "americano", courtCount, rounds: 1 })[0].matches.length;
}

/** T8-R2: the rounds Start must plan for an americano over a field of n — the
 *  ENGINE's planner (generateAmericano, the source F1's round size reads) run
 *  over n placeholders on the stage's courts (declared, else the product's own
 *  default, stages.ts:757-758) for config.rounds, counting only the rounds that
 *  seat a match (the product writes nothing for an empty one). A field under
 *  4 never reaches the planner — Start refuses it STAGE_NOT_READY
 *  (stages.ts:751-755) — so under 4 this answers 0 for a Start the product
 *  would not accept. Never config.rounds alone. */
export function americanoPlannedRounds(config: Readonly<Record<string, unknown>>, rounds: number, n: number): number {
  const courtCount = typeof config.courtCount === "number" ? config.courtCount : Math.max(1, Math.floor(n / 4));
  return generateAmericano(placeholders(n), { mode: "americano", courtCount, rounds }).filter((r) => r.matches.length > 0).length;
}

/** The mode the stage is played in, read as the product reads it (stages.ts:756). */
export const modeOf = (stage: Pick<StageRef, "kind" | "config">): Mode | null =>
  (stage.kind !== "americano" ? null : stage.config.mode === "mexicano" ? "mexicano" : "americano");

/** The product's own read model disagrees with the loop the harness chose
 *  for a stage: the case would be driven as the wrong format. */
export class AmericanoModeMismatch extends Error {
  constructor(stageId: string, played: Mode, viewed: string) {
    super(`americano: stage ${stageId} is played as ${played} (its config.mode), but the product's americano view reads it as ${viewed} — the loop would drive the wrong format`);
    this.name = "AmericanoModeMismatch";
  }
}

/** config.rounds is the loop's bound; one the stage does not declare is
 *  refused by name, never guessed (the product's own default depends on the
 *  player count, stages.ts:759). */
function roundsOf(stage: StageRef): number {
  const rounds = stage.config.rounds;
  if (typeof rounds !== "number" || !Number.isInteger(rounds) || rounds < 1) {
    throw new Error(`americano: stage ${stage.id} declares no config.rounds (${JSON.stringify(rounds ?? null)}) — the loop has no bound`);
  }
  return rounds;
}

/** Before the loop: the product's americano view must read the stage in the
 *  mode the harness dispatched on (the seam is proven live, never inert). */
async function viewAgrees(ctx: ScenarioContext, stage: StageRef, mode: Mode): Promise<void> {
  const view = await ctx.driver.americanoView(stage.id);
  if (view.mode !== mode) throw new AmericanoModeMismatch(stage.id, mode, view.mode);
}

const openOf = async (ctx: ScenarioContext, setup: DivisionSetup, stage: StageRef): Promise<FixtureRow[]> =>
  (await ctx.driver.listFixtures(setup.division.id)).filter((f) => f.stage_id === stage.id && seatedOpen(f));

/** The lowest open round, decided whole. */
async function playLowest(ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup, stage: StageRef, open: FixtureRow[], hooks: Hooks): Promise<void> {
  const round = Math.min(...open.map((f) => f.round_no ?? 0));
  await decideRound(ctx, rec, setup, stage, round, open.filter((f) => (f.round_no ?? 0) === round), hooks);
}

export async function playAmericano(ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup, stage: StageRef, hooks: Hooks): Promise<void> {
  const track = rec.track(stage.id);
  const rounds = roundsOf(stage);
  await viewAgrees(ctx, stage, "americano");
  for (let r = 1; r <= rounds; r++) {
    const open = await openOf(ctx, setup, stage);
    if (open.length === 0) break;
    await playLowest(ctx, rec, setup, stage, open, hooks);
  }
  const rows = (await ctx.driver.listFixtures(setup.division.id)).filter((f) => f.stage_id === stage.id);
  const left = rows.filter(seatedOpen);
  // T8-R2: "nothing open" is drained only when Start planned every round the
  // engine lays out for the field Start saw (every division entrant).
  const planned = new Set(rows.map((f) => f.round_no ?? 0)).size;
  const expected = americanoPlannedRounds(stage.config, rounds, setup.entrants.length);
  if (left.length > 0) {
    track.exit = rec.exit = "cap";
    rec.facts.add("cut_short");
    rec.notes.push(`americano: ${left.length} fixture(s) open after config.rounds=${rounds}`);
  } else if (planned < expected) {
    track.exit = rec.exit = "short_plan";
    rec.notes.push(`americano: the product planned ${planned} of the ${expected} round(s) the engine lays out for ${setup.entrants.length} player(s) over config.rounds=${rounds} — played short, never drained`);
  } else {
    track.exit = rec.exit = "drained";
  }
  await recordPersons(ctx, rec, setup, stage);
}

export async function playMexicano(ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup, stage: StageRef, hooks: Hooks): Promise<void> {
  const track = rec.track(stage.id);
  const rounds = roundsOf(stage);
  await viewAgrees(ctx, stage, "mexicano");
  let played = 0;
  // At most config.rounds generates: rounds 2..N, then the drained probe after round N.
  for (let g = 0; g < rounds; g++) {
    const open = await openOf(ctx, setup, stage);
    if (open.length > 0) {
      await playLowest(ctx, rec, setup, stage, open, hooks);
      played++;
    }
    const fixtures = await recordGenerate(ctx, rec, stage.id);
    if (fixtures === null) {
      track.exit = rec.exit = "refused_generate";
      await noteRefusedAfterPairs(ctx, rec, setup, stage, played);
      await recordPersons(ctx, rec, setup, stage);
      return;
    }
    if (track.generates.at(-1)!.created > 0) continue;
    track.exit = rec.exit = played >= rounds ? "drained" : "stalled_rounds";
    if (played < rounds) {
      // False premise 14: the product waits on ANY non-"decided" fixture
      // (stages.ts:769) — a forfeited walkover, a void, a finalized row. Named
      // so triage can route it without a harness hunt. Never cut_short: a stall
      // is the product refusing to go on, not the harness's cap.
      const blocking = (await ctx.driver.listFixtures(setup.division.id)).filter((f) => f.stage_id === stage.id && f.status !== "decided");
      rec.notes.push(blocking.length > 0
        ? `mexicano-stalled-on-non-decided: stalled after round ${played} of ${rounds}; ${blocking.length} fixture(s) not decided (${[...new Set(blocking.map((f) => f.status))].join(", ")}) — predicted product red → ${STALL_ROUTE.wave}`
        : `mexicano: stalled after round ${played} of ${rounds} (generate created 0, every fixture decided) — suspected product red → ${STALL_ROUTE.wave}`);
    }
    await recordPersons(ctx, rec, setup, stage);
    return;
  }
  // The rounds-th generate still created fixtures: planning past the declared
  // rounds is recorded, never played or trusted.
  track.exit = rec.exit = "cap";
  rec.facts.add("cut_short");
  rec.notes.push(`mexicano: generate still created fixtures after config.rounds=${rounds} round(s)`);
  await recordPersons(ctx, rec, setup, stage);
}

/** The sides of a stage's fixtures that are NOT division entrants: the pair
 *  entrants the product minted. */
const pairSides = (setup: Pick<DivisionSetup, "entrantIds">, rows: readonly FixtureRow[]): string[] =>
  [...new Set(rows.flatMap((f) => [f.home_entrant_id, f.away_entrant_id]).filter((e): e is string => e !== null && !setup.entrantIds.has(e)))];

/** A mexicano generate refused with a 5xx whose message is the self-pair's
 *  cause (SELF_PAIR_CAUSE, T8-R1): a pair entrant's person paired with their
 *  own individual entry reaches the entrant_members key — the path false
 *  premise 17 opens. Named with the pair entrants the earlier rounds minted.
 *  A 4xx is a refusal with a reason of its own, and any other 5xx is
 *  unexplained: neither gets the signature (normal, harness-first triage). */
async function noteRefusedAfterPairs(ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup, stage: StageRef, played: number): Promise<void> {
  const g = rec.track(stage.id).generates.at(-1)!;
  if (g.status < 500 || !SELF_PAIR_CAUSE.test(g.message ?? "")) return;
  const rows = (await ctx.driver.listFixtures(setup.division.id)).filter((f) => f.stage_id === stage.id);
  const pairs = pairSides(setup, rows);
  const after = played === 0 ? "before any round was decided" : `after round${played > 1 ? `s 1–${played}` : " 1"} created pair entrants ${pairs.join(", ")}`;
  rec.notes.push(`mexicano-pair-entrants-counted-as-players: round ${played + 1} generate refused ${g.status} ${g.code ?? "(no code)"} (entrant_members_pkey: a person paired with themselves) ${after} → ${PAIR_PLAYERS_ROUTE.wave}`);
}

/** Every entrant seated in this stage → its persons (GET /entrants/{id}), so
 *  I10 (Task 9) and the R4 signature read the product's own members. */
async function recordPersons(ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup, stage: StageRef): Promise<void> {
  const rows = (await ctx.driver.listFixtures(setup.division.id)).filter((f) => f.stage_id === stage.id);
  const sides = new Set(rows.flatMap((f) => [f.home_entrant_id, f.away_entrant_id]).filter((e): e is string => e !== null));
  const out: Record<string, readonly string[]> = {};
  for (const e of sides) out[e] = (await ctx.driver.entrantMembers(e)).map((m) => m.person_id);
  rec.stagePersons.set(stage.id, out);
  if (modeOf(stage) === "mexicano") notePairEntrantDuplicates(rec, setup, rows, out);
  if (setup.kind === "team") noteTeamMembers(rec, setup, out);
}

/** From round 2 on (round 1 seats only the division's own players), the
 *  first OBSERVED REPEAT in one round's seating gets the predicted signature,
 *  once per stage: a person in two seats of the round, or in one seat with
 *  themselves (T8-R3, m-1). The repeat itself is the evidence, read from the
 *  product's own members; that the person sat in an earlier pair is NOT — on
 *  an 8-player field every person does. A round with no repeat gets nothing. */
export function notePairEntrantDuplicates(rec: Recorder, setup: Pick<DivisionSetup, "persons">, rows: readonly FixtureRow[], persons: Readonly<Record<string, readonly string[]>>): void {
  const of = (side: string): readonly string[] => persons[side] ?? setup.persons.get(side) ?? [];
  const rounds = [...new Set(rows.map((f) => f.round_no ?? 0))].filter((r) => r >= 2).sort((a, b) => a - b);
  for (const r of rounds) {
    const seats = rows.filter((x) => (x.round_no ?? 0) === r).flatMap((f) => [f.home_entrant_id, f.away_entrant_id]).filter((e): e is string => e !== null);
    const people = [...new Set(seats.flatMap(of))];
    for (const p of people) {
      const holding = seats.filter((side) => of(side).includes(p));
      const self = holding.find((side) => of(side).filter((x) => x === p).length > 1);
      if (holding.length < 2 && self === undefined) continue;
      const where = self !== undefined ? `in ${self} with themselves` : `in ${holding.join(" and ")}`;
      rec.notes.push(`mexicano-pair-entrants-counted-as-players: round ${r} seats ${p} twice, ${where} → ${PAIR_PLAYERS_ROUTE.wave}`);
      return;
    }
  }
}

/** False premise 10: on team entrants the product seats ONE arbitrary roster
 *  member per team — the finding is this note, since every check may pass.
 *  Names, per team, the person(s) its pair entrants seated. Once per case. */
function noteTeamMembers(rec: Recorder, setup: DivisionSetup, persons: Readonly<Record<string, readonly string[]>>): void {
  const prefix = "americano generated on team entrants with one arbitrary roster member each";
  if (rec.notes.some((n) => n.startsWith(prefix))) return;
  const seated = new Set(Object.entries(persons).filter(([e]) => !setup.entrantIds.has(e)).flatMap(([, ps]) => ps));
  const named = setup.entrants.map((e) => {
    const mine = (setup.persons.get(e.id) ?? []).filter((p) => seated.has(p));
    return `${e.id}→${mine.length === 0 ? "none" : mine.join("+")}`;
  });
  rec.notes.push(`${prefix} — ${TEAM_MEMBER_ROUTE.wave} finding (false premise 10): ${named.join(", ")}`);
}
