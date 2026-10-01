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
  const left = await openOf(ctx, setup, stage);
  track.exit = rec.exit = left.length === 0 ? "drained" : "cap";
  if (left.length > 0) {
    rec.facts.add("cut_short");
    rec.notes.push(`americano: ${left.length} fixture(s) open after config.rounds=${rounds}`);
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

/** A mexicano generate refused with a 5xx after earlier rounds minted pair
 *  entrants: the self-pair path false premise 17 opens (a pair entrant's
 *  person paired with their own individual entry reaches the entrant_members
 *  key, V213:9). Named with its evidence; a 4xx is a refusal with a reason of
 *  its own and gets no signature. */
async function noteRefusedAfterPairs(ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup, stage: StageRef, played: number): Promise<void> {
  const g = rec.track(stage.id).generates.at(-1)!;
  if (g.status < 500 || played < 1) return;
  const rows = (await ctx.driver.listFixtures(setup.division.id)).filter((f) => f.stage_id === stage.id);
  const pairs = pairSides(setup, rows);
  if (pairs.length === 0) return;
  rec.notes.push(`mexicano-pair-entrants-counted-as-players: round ${played + 1} generate refused ${g.status} ${g.code ?? "(no code)"} after round${played > 1 ? `s 1–${played}` : " 1"} created pair entrants ${pairs.join(", ")} → ${PAIR_PLAYERS_ROUTE.wave}`);
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

/** From round 2 on: the first person seated twice in one round, with a pair
 *  entrant an EARLIER round seated that holds them, gets the predicted
 *  signature — once per stage. The evidence is required: a duplicate no
 *  earlier pair explains gets no signature and goes to normal triage. */
export function notePairEntrantDuplicates(rec: Recorder, setup: Pick<DivisionSetup, "entrantIds" | "persons">, rows: readonly FixtureRow[], persons: Readonly<Record<string, readonly string[]>>): void {
  const of = (side: string): readonly string[] => persons[side] ?? setup.persons.get(side) ?? [];
  const rounds = [...new Set(rows.map((f) => f.round_no ?? 0))].filter((r) => r >= 2).sort((a, b) => a - b);
  for (const r of rounds) {
    const count = new Map<string, number>();
    for (const f of rows.filter((x) => (x.round_no ?? 0) === r)) {
      for (const side of [f.home_entrant_id, f.away_entrant_id]) if (side !== null) for (const p of of(side)) count.set(p, (count.get(p) ?? 0) + 1);
    }
    for (const [p, n] of count) {
      if (n < 2) continue;
      const earlier = rows.filter((f) => (f.round_no ?? 0) < r);
      const via = pairSides(setup, earlier).find((e) => of(e).includes(p));
      if (via === undefined) continue;
      const q = Math.min(...earlier.filter((f) => f.home_entrant_id === via || f.away_entrant_id === via).map((f) => f.round_no ?? 0));
      rec.notes.push(`mexicano-pair-entrants-counted-as-players: round ${r} seats ${p} twice, directly and via pair entrant ${via} (a round-${q} pair, q < r) → ${PAIR_PLAYERS_ROUTE.wave}`);
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
