// W5 app-A Task 7 — the counted table late-entry sweep (T5-e, T5-a): late entry into EVERY table entry template, for EVERY entrant
// kind, in EVERY case the wire answers, through the real usecases on Postgres (rules X-CU-7, X-CU-8, X-CU-9, X-CU-11, X-CU-12,
// the W4 row X-LE-2; rulebook RB5-L1..L17). A coverage sweep: it builds nothing.
//
// Expected values come from the rulebook (RB5-L1..L17) and the rows before the add, never the code under test. Where a value is a
// function of the rows, the oracle below is the rulebook's own sentence applied to the rows the stage held BEFORE the add:
//   RB5-L3   a fixture whose opponent holds the bye in a FUTURE round lands in that round; every other owed fixture is appended
//            as a catch-up round after the last drawn round, one fixture per round;
//   RB5-L4   a started round and every earlier row are never changed, round numbers never rewritten;
//   RB5-L6   catch-up rounds follow the order of the rounds the opponents already played (their earliest round), then listed
//            (seed) order;
//   RB5-L7/L15  nothing started -> Rebuild offered, with the catch-up as the alternative; L8 a complete stage refuses by name;
//   RB5-L9   the pool picker defaults to the SMALLEST pool;
//   RB5-L10  automatic arrivals wait for one tap; RB5-L11 "started" is a score event; RB5-L13 catch-up lines are unscheduled;
//   RB5-G2   the newcomer's home/away balance differs by at most 1; RB5-G3 an odd field has exactly one bye per round.
// The snake that fills the pools (RB5-G4) and the pool sizes are re-derived here from the seeds, not read back from the stage.
//
// Enumerated, never sampled:
//   templates — every non-retired STAGE_TEMPLATES entry whose first built stage is a league or group (lib/format-templates.ts),
//               pinned to the five the brief names. A sixth (Task 14's group_only) reds the pin rather than slipping past.
//   kinds     — every `entrants.kind` (EntrantKind), each played by a sport whose engine module DECLARES it and offers every
//               entry template (`entrantModel.kinds`, `templatesForSport`), its natural sport first. Derived, never typed.
//   cases     — the wire's four (`catch_up`, `rebuild_offered`, `refused`, `waiting`) plus `tapped` (a waiting arrival placed by
//               the organiser's one tap, answering `catch_up` with source "organiser"): 5 x 3 x 5 = 75.
//   fed tail  — the four bracket-fed templates x kinds = 12: the bracket never seats a late entrant (X-LE-2, RB5-L2).
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";
import { generateRoundRobin } from "@seazn/engine/scheduling";
import { entrantKindCap, type AnySportModule } from "@seazn/engine/sport";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { STAGE_TEMPLATES, buildTemplateStages, templatesForSport } from "@/lib/format-templates";
import type { AuthCtx } from "@/server/api-v1/auth";
import { CreateStage, EntrantKind, type TableLateEntryResult } from "@/server/api-v1/schemas";
import { engineEntrantKinds } from "@/lib/__tests__/_engine-entrant-kinds";
import { createCompetition } from "../competitions";
import { getCompetitionDesk } from "../competition-desk";
import { createDivision } from "../divisions";
import { createEntrants, patchEntrant } from "../entrants";
import { placeWaitingLateEntrant, placeWaitingTableEntrant } from "../roundrobin-late-entry";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { createStages, generateStageFixtures } from "../stages";
import { withdrawEntrantCascade } from "../withdrawal";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

type Kind = (typeof EntrantKind.options)[number];

/** The refusal table's English rows (lib/roundrobin-refusals.ts), typed here as the oracle. */
const COMPLETE = "This table has finished. Late players can't join it.";
const ALREADY_PLACED = "This player already has their fixtures.";
/** The W4 knockout refusal table's row (lib/knockout-refusals.ts) a tap on a bracket answers: no bracket takes a late entrant (RB5-L2). */
const BRACKET_NOT_WAITING = "This player isn't waiting to join this bracket.";

// ─── What is enumerated ────────────────────────────────────────────────────────────────────────────────────────────────

const KNOBS = { qualified: 4, swissRounds: 3, poolCount: 2, legs: 1 };
const POOL_COUNT = KNOBS.poolCount;

/** Every template whose FIRST stage is a league or group, off the templates' own graphs. */
const ENTRY_TEMPLATES = STAGE_TEMPLATES.filter((t) => {
  if (t.retired) return false;
  const first = t.build(KNOBS)[0];
  return first !== undefined && (first.kind === "league" || first.kind === "group");
}).map((t) => t.key);
const PINNED_ENTRY_TEMPLATES = ["league", "league_ko", "groups_ko", "group_stepladder", "group_playoffs"];
/** The entry templates with a bracket fed from the table. */
const FED_TEMPLATES = ENTRY_TEMPLATES.filter((t) => buildTemplateStages(t, KNOBS).length > 1);
const PINNED_FED_TEMPLATES = ["league_ko", "groups_ko", "group_stepladder", "group_playoffs"];

const KINDS: readonly Kind[] = EntrantKind.options;
const CASES = ["catch_up", "rebuild_offered", "refused", "waiting", "tapped"] as const;
type CaseKey = (typeof CASES)[number];

interface SportPick {
  key: string;
  variant: string;
}

/** The kind's sport, from the engine's declarations: a module declaring the kind (`entrantModel.kinds`) and offered every entry
 *  template, its natural one first (`defaultKind === kind`), else the registry's first. Its first declared variant. */
function sportFor(kind: Kind): SportPick {
  const offered = builtinModules.filter(
    (m) =>
      (m.entrantModel?.kinds ?? ["individual"]).includes(kind) &&
      ENTRY_TEMPLATES.every((t) => templatesForSport(m.key, engineEntrantKinds(m.key)).some((x) => x.key === t)),
  );
  const pick = offered.find((m) => m.entrantModel?.defaultKind === kind) ?? offered[0];
  if (pick === undefined) throw new Error(`no sport declares the '${kind}' entrant kind and offers every entry template`);
  const variant = Object.keys((pick as AnySportModule).variants)[0];
  if (variant === undefined) throw new Error(`sport ${pick.key} declares no variant`);
  return { key: pick.key, variant };
}
const SPORT_OF = new Map(KINDS.map((k) => [k, sportFor(k)] as const));

// ─── The rig ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Seeds are 1-based. The snake that fills `count` pools (RB5-G4), re-derived here: 1..N, then N..1, repeating. */
function snakePoolOfSeed(seed: number, count: number): number {
  const i = seed - 1;
  const lap = Math.floor(i / count);
  const pos = i % count;
  return lap % 2 === 0 ? pos : count - 1 - pos;
}

interface Rig {
  template: string;
  kind: Kind;
  sport: SportPick;
  auth: AuthCtx;
  orgId: string;
  competitionId: string;
  divisionId: string;
  isGroup: boolean;
  /** The table stage (the division's entry stage) and the bracket stages fed from it. */
  tableId: string;
  tableName: string;
  tailIds: string[];
  /** The field: P1..Pn by seed. Eleven over two pools for a group (A = five, odd, B = six), five for a league (odd). */
  fieldSize: number;
  ids: string[];
  /** The entrant withdrawn before Start and reinstated after it (the automatic arrival), when the rig made one. */
  backId: string | null;
  names: Map<string, string>;
}

/** A roster of the kind's own shape: one inline person per seat, at most two (`entrantKindCap`). */
function entrantInput(kind: Kind, name: string, seed?: number) {
  const seats = Math.min(2, entrantKindCap(kind));
  return {
    kind,
    display_name: name,
    ...(seed !== undefined ? { seed } : {}),
    members: Array.from({ length: seats }, (_, i) => ({
      new_person: { full_name: `${name} m${i + 1} ${randomUUID().slice(0, 4)}` },
      is_captain: false,
      roles: [] as string[],
    })),
  };
}

/** The template's own stages, built through the API's own `CreateStage` schema, a seeded field Started (Start draws the table),
 *  the bracket tail's day-one TBD bracket generated as the organiser's Generate lays it out. `back`: one more entrant, withdrawn
 *  BEFORE Start (so the table is drawn without them) — the automatic arrival a Reinstate then brings. */
async function templateRig(template: string, kind: Kind, opts: { back?: boolean } = {}): Promise<Rig> {
  const sport = SPORT_OF.get(kind)!;
  const drafts = buildTemplateStages(template, KNOBS);
  const first = drafts[0]!;
  const isGroup = first.kind === "group";
  const fieldSize = isGroup ? 11 : 5;
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: `W5T7 ${template} ${kind} ` + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: sport.key,
    variant_key: sport.variant,
    config: {},
  });
  const total = fieldSize + (opts.back ? 1 : 0);
  const made = await createEntrants(
    auth,
    division.id,
    Array.from({ length: total }, (_, i) => entrantInput(kind, `P${i + 1}`, i + 1)),
  );
  const stageIds: string[] = [];
  for (const [i, d] of drafts.entries()) {
    const [stage] = await createStages(auth, division.id, CreateStage.parse({ seq: i + 1, kind: d.kind, name: d.name, config: d.config, progression: d.progression }));
    stageIds.push(stage!.id);
  }
  const backId = opts.back ? made[fieldSize]!.id : null;
  if (backId !== null) await withdrawEntrantCascade(auth, backId);
  await startDivision(auth, division.id);
  const tailIds = stageIds.slice(1);
  for (const t of tailIds) await generateStageFixtures(auth, t);
  return {
    template,
    kind,
    sport,
    auth,
    orgId: auth.orgId,
    competitionId: comp.id,
    divisionId: division.id,
    isGroup,
    tableId: stageIds[0]!,
    tableName: first.name,
    tailIds,
    fieldSize,
    ids: made.slice(0, fieldSize).map((e) => e.id),
    backId,
    names: new Map(made.map((e) => [e.id, e.display_name])),
  };
}

interface Row {
  id: string;
  stage_id: string;
  pool_id: string | null;
  ext_key: string | null;
  round_no: number;
  seq_in_round: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
  scheduled_at: Date | null;
  court_id: string | null;
  venue_id: string | null;
  schedule_locked: boolean;
  outcome: unknown;
}

const rowsOf = (stageId: string) =>
  sql<Row[]>`
    select id, stage_id, pool_id, ext_key, round_no, seq_in_round, home_entrant_id, away_entrant_id, status, scheduled_at, court_id,
           venue_id, schedule_locked, outcome
      from fixtures where stage_id = ${stageId} order by round_no, seq_in_round, id`;

async function tailRows(rig: Rig): Promise<Row[]> {
  const out: Row[] = [];
  for (const t of rig.tailIds) out.push(...(await rowsOf(t)));
  return out;
}

/** One scorer event at the fixture's tip. */
async function post(auth: AuthCtx, fixtureId: string, type: string): Promise<void> {
  const [{ n }] = await sql<{ n: number }[]>`select coalesce(max(seq), 0)::int as n from score_events where fixture_id = ${fixtureId}`;
  await scoreEvent(auth, fixtureId, { expected_seq: n, type, payload: {} });
}

/** Start `rounds` (RB5-L11: a score event on a line of the round) in EVERY pool of the table — so a round is started whichever way
 *  "the round has started" is scoped. */
async function startRounds(rig: Rig, rounds: readonly number[]): Promise<number> {
  const rows = await rowsOf(rig.tableId);
  let started = 0;
  for (const pool of new Set(rows.map((r) => r.pool_id))) {
    for (const r of rounds) {
      const line = rows.find((x) => x.pool_id === pool && x.round_no === r);
      expect(line, `rig: pool ${String(pool)} has a line in round ${r}`).toBeDefined();
      await post(rig.auth, line!.id, "core.start");
      started++;
    }
  }
  return started;
}

/** A table stage's answer, narrowed (the table format is `league` or `group`; a Swiss or knockout answer here is a defect). */
function tableAnswer(x: unknown): TableLateEntryResult {
  const a = x as { format?: string } | undefined;
  if (a === undefined || (a.format !== "league" && a.format !== "group")) throw new Error(`a table late add answered ${JSON.stringify(x)}`);
  return a as TableLateEntryResult;
}

async function addLate(rig: Rig, name: string, extra: Record<string, unknown> = {}) {
  const [row] = await createEntrants(rig.auth, rig.divisionId, [{ ...entrantInput(rig.kind, name), ...extra } as never]);
  rig.names.set(row!.id, name);
  return row!;
}

async function waitingOn(entrantId: string): Promise<{ table: string | null; knockout: string | null }> {
  const [e] = await sql<{ t: string | null; k: string | null }[]>`
    select table_waiting_stage_id as t, knockout_waiting_stage_id as k from entrants where id = ${entrantId}`;
  return { table: e!.t, knockout: e!.k };
}

async function ledger(divisionId: string) {
  return (
    await sql<{ payload: Record<string, unknown> }[]>`
      select payload from division_events where division_id = ${divisionId} and type = 'roundrobin_late_entry' order by seq`
  ).map((r) => r.payload);
}

async function attention(rig: Rig) {
  const desk = await getCompetitionDesk(rig.auth, rig.competitionId);
  return desk.divisions.get(rig.divisionId)?.attention ?? [];
}

async function entrantCount(divisionId: string): Promise<number> {
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from entrants where division_id = ${divisionId}`;
  return n;
}

async function refusal(p: Promise<unknown>): Promise<HttpError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, "the call is refused").toBeInstanceOf(HttpError);
  return err as HttpError;
}

// ─── The oracle: the rulebook applied to the rows before the add ──────────────────────────────────────────────────────

interface Scene {
  poolId: string | null;
  poolKey: string | null;
  /** The pool's (league's) members in seed order. */
  members: string[];
  /** The round each member sits out (RB5-G3: exactly one bye per round in an odd field, one leg). */
  byeRound: Map<string, number>;
  /** The round of each member's first line. */
  firstRound: Map<string, number>;
  /** The last round the stage holds, stage-wide. */
  lastRound: number;
  /** `config.round_byes` as stored, every pool. */
  storedByes: { pool: string | null; round_no: number; entrant_id: string }[];
}

async function storedByes(stageId: string) {
  const [row] = await sql<{ b: { pool: string | null; round_no: number; leg: number; entrant_id: string }[] | null }[]>`
    select config -> 'round_byes' as b from stages where id = ${stageId}`;
  return row!.b ?? [];
}

/** Read the stage as it stands, and pin the premises the expectations rest on (each an assertion, not a comment). */
async function sceneOf(rig: Rig): Promise<Scene> {
  const rows = await rowsOf(rig.tableId);
  const pools = await sql<{ id: string; key: string }[]>`select id, key from pools where stage_id = ${rig.tableId} order by key`;
  const seedOf = new Map(rig.ids.map((id, i) => [id, i + 1]));

  let poolId: string | null = null;
  let poolKey: string | null = null;
  let members: string[];
  if (!rig.isGroup) {
    expect(pools, "premise: a league has no pool rows").toEqual([]);
    members = [...rig.ids];
  } else {
    expect(pools.map((p) => p.key), "premise: the pools are A and B").toEqual(["A", "B"]);
    // RB5-G4: the snake fills the pools from the seeds. Sizes derived from the seeds, never read from the stage (RB5-L9: smallest).
    const bySnake = Array.from({ length: POOL_COUNT }, (_, p) => rig.ids.filter((_id, i) => snakePoolOfSeed(i + 1, POOL_COUNT) === p));
    const sizes = bySnake.map((m) => m.length);
    expect(sizes, "premise: eleven seeds snake to five and six").toEqual([5, 6]);
    const smallest = sizes.indexOf(Math.min(...sizes));
    expect(sizes.filter((s) => s === sizes[smallest]).length, "premise: the smallest pool is unique (no tie to break)").toBe(1);
    poolKey = "ABCDEFGH"[smallest]!;
    poolId = pools.find((p) => p.key === poolKey)!.id;
    members = bySnake[smallest]!;
    const seated = new Set(rows.filter((r) => r.pool_id === poolId).flatMap((r) => [r.home_entrant_id!, r.away_entrant_id!]));
    expect([...seated].sort(), "premise: the stored pool is the snake's pool").toEqual([...members].sort());
  }
  expect(members.length % 2, `premise: the joined ${poolKey ?? "league"} is an odd field (RB5-G3: one bye per round)`).toBe(1);

  const inPool = rows.filter((r) => r.pool_id === poolId);
  const poolRounds = [...new Set(inPool.map((r) => r.round_no))].sort((a, b) => a - b);
  const byeRound = new Map<string, number>();
  const firstRound = new Map<string, number>();
  for (const m of members) {
    const mine = inPool.filter((r) => r.home_entrant_id === m || r.away_entrant_id === m);
    const sitting = poolRounds.filter((r) => !mine.some((x) => x.round_no === r));
    expect(sitting.length, `premise: ${rig.names.get(m)} sits out exactly one round`).toBe(1);
    byeRound.set(m, sitting[0]!);
    firstRound.set(m, Math.min(...mine.map((x) => x.round_no)));
  }
  expect(members.map((m) => inPool.filter((r) => r.home_entrant_id === m || r.away_entrant_id === m).length), "premise: one line per other member").toEqual(
    members.map(() => members.length - 1),
  );
  // The engine's own declaration of a round robin's byes over this pool, in seed order (RB5-G3).
  const engine = generateRoundRobin({ entrants: members, seeds: new Map(members.map((m) => [m, seedOf.get(m)!])), config: { legs: 1 } });
  expect(new Map(engine.rounds.map((r) => [r.bye!, r.roundNo])), "premise: the stored schedule's byes are the engine's").toEqual(byeRound);
  const stored = await storedByes(rig.tableId);
  const mineStored = stored.filter((b) => b.pool === poolId);
  expect(new Map(mineStored.map((b) => [b.entrant_id, b.round_no])), "premise: the recorded byes are the rows' own").toEqual(byeRound);
  return { poolId, poolKey, members, byeRound, firstRound, lastRound: Math.max(...rows.map((r) => r.round_no)), storedByes: stored };
}

interface Expected {
  opponent: string;
  kind: "bye_slot" | "catch_up_round";
  round: number;
}

/** RB5-L3 / L4 / L6: each member's fixture lands in that member's bye round when it is still ahead (unstarted); every other owed
 *  fixture is appended after the last drawn round, one per round, ordered by the round the opponent first played in, then listed
 *  order. One leg. */
function expectedPlacement(s: Scene, started: ReadonlySet<number>): Expected[] {
  const out: Expected[] = [];
  const appended: string[] = [];
  for (const m of s.members) {
    const bye = s.byeRound.get(m)!;
    if (!started.has(bye)) out.push({ opponent: m, kind: "bye_slot", round: bye });
    else appended.push(m);
  }
  const order = (m: string) => s.members.indexOf(m);
  appended.sort((x, y) => s.firstRound.get(x)! - s.firstRound.get(y)! || order(x) - order(y));
  appended.forEach((m, k) => out.push({ opponent: m, kind: "catch_up_round", round: s.lastRound + 1 + k }));
  return out.sort((a, b) => a.round - b.round);
}

/** The newcomer's lines as the oracle's shape, off the stored keys. */
function seatsOf(rows: readonly Row[], id: string): Expected[] {
  return rows
    .filter((r) => r.home_entrant_id === id || r.away_entrant_id === id)
    .map((r) => ({
      opponent: r.home_entrant_id === id ? r.away_entrant_id! : r.home_entrant_id!,
      kind: /(^|-)rr-by-/.test(r.ext_key ?? "") ? ("bye_slot" as const) : ("catch_up_round" as const),
      round: r.round_no,
    }))
    .sort((a, b) => a.round - b.round);
}

/** No round seats an entrant twice, across every pool of the stage. Answers how many rounds were checked. */
function assertNobodySeatedTwice(rows: readonly Row[], label: string): number {
  let rounds = 0;
  for (const r of new Set(rows.map((x) => x.round_no))) {
    const seated = rows.filter((x) => x.round_no === r).flatMap((x) => [x.home_entrant_id, x.away_entrant_id]);
    expect(new Set(seated).size, `${label}: round ${r} seats nobody twice`).toBe(seated.length);
    rounds++;
  }
  return rounds;
}

/** What a catch-up (catch_up, tapped, or rebuild_offered's default) writes, against the rows before it (RB5-L3, L4, L13, G2). */
async function assertPlaced(rig: Rig, s: Scene, before: readonly Row[], tailBefore: readonly Row[], late: string, result: TableLateEntryResult, started: ReadonlySet<number>, label: string) {
  const after = await rowsOf(rig.tableId);
  const want = expectedPlacement(s, started);
  expect(want.length, `${label}: anti-vacuity: the oracle owes the newcomer a line per member`).toBe(s.members.length);
  expect(seatsOf(after, late), `${label}: the newcomer's seats`).toEqual(want);
  expect(result.format).toBe(rig.isGroup ? "group" : "league");
  expect(result.stage_id).toBe(rig.tableId);
  expect(result.entrant_id).toBe(late);
  if (rig.isGroup) expect(result.pool_key, `${label}: the smallest pool (RB5-L9)`).toBe(s.poolKey);
  else expect(result.pool_key).toBeUndefined();
  // RB5-L4: every earlier row is byte-equal; the new rows are exactly the answer's.
  const beforeIds = new Set(before.map((r) => r.id));
  expect(after.filter((r) => beforeIds.has(r.id)), `${label}: every earlier row stands`).toEqual(before);
  const fresh = after.filter((r) => !beforeIds.has(r.id));
  expect(fresh.length, `${label}: a line per member, nothing else`).toBe(s.members.length);
  expect(result.fixtures!.map((f) => f.fixture_id).sort(), `${label}: the answer names exactly the new lines`).toEqual(fresh.map((r) => r.id).sort());
  expect(result.appended_rounds, `${label}: appended rounds`).toBe(want.filter((w) => w.kind === "catch_up_round").length);
  // RB5-L13: unscheduled, uncourted, scheduled-status, in the pool joined.
  expect(fresh.map((r) => [r.scheduled_at, r.court_id, r.status, r.pool_id]), `${label}: new lines unscheduled`).toEqual(fresh.map(() => [null, null, "scheduled", s.poolId]));
  expect(result.fixtures!.every((f) => f.scheduled === false)).toBe(true);
  // RB5-G2: the newcomer's home/away balance differs by at most 1.
  const home = fresh.filter((r) => r.home_entrant_id === late).length;
  expect(Math.abs(home - (fresh.length - home)), `${label}: home/away balance within 1`).toBeLessThanOrEqual(1);
  assertNobodySeatedTwice(after, label);
  // The consumed byes leave the record; a started or unconsumed one stays; the other pool's stand (RB5-L4).
  const consumed = new Set(want.filter((w) => w.kind === "bye_slot").map((w) => `${w.round}|${w.opponent}`));
  const wantByes = s.storedByes.filter((b) => !(b.pool === s.poolId && consumed.has(`${b.round_no}|${b.entrant_id}`)));
  const gotByes = await storedByes(rig.tableId);
  const key = (b: { pool: string | null; round_no: number; entrant_id: string }) => `${b.pool}|${b.round_no}|${b.entrant_id}`;
  expect(gotByes.map(key).sort(), `${label}: round_byes lose exactly the consumed byes`).toEqual(wantByes.map(key).sort());
  expect(consumed.size, `${label}: anti-vacuity: byes consumed`).toBe(want.filter((w) => w.kind === "bye_slot").length);
  // RB5-X: the tail never seats the newcomer, and does not move.
  expect(await tailRows(rig), `${label}: the bracket tail stands`).toEqual(tailBefore);
  const tailSeats = (await tailRows(rig)).filter((r) => r.home_entrant_id === late || r.away_entrant_id === late);
  expect(tailSeats, `${label}: the newcomer is in no bracket line`).toEqual([]);
  // The ledger row names the lines (the Joined marker reads it), and the desk counts them (X-CU-12).
  expect((await ledger(rig.divisionId)).at(-1), `${label}: the ledger row`).toMatchObject({
    source: "organiser",
    case: result.case,
    stage_id: rig.tableId,
    entrant_id: late,
    pool_key: s.poolKey,
  });
  expect(((await ledger(rig.divisionId)).at(-1)!.fixture_ids as string[]).sort()).toEqual(fresh.map((r) => r.id).sort());
  const unscheduled = (await attention(rig)).find((a) => a.kind === "unscheduled") as { catchUp?: number } | undefined;
  expect(unscheduled?.catchUp, `${label}: the desk counts the catch-up lines`).toBe(s.members.length);
}

// ─── The cells ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const checked = new Set<string>();
const fedChecked = new Set<string>();
const cellKey = (template: string, kind: Kind, c: CaseKey) => `${template}|${kind}|${c}`;
const ROUNDS_STARTED = [1, 2] as const;

/** (catch_up) rounds 1 and 2 have started: the add is a catch-up. P3/P2/P1-style byes still ahead are consumed (bye_slot), the
 *  started ones are appended; then a SECOND late player owes the first as well (RB5-L16). */
async function cellCatchUp(rig: Rig, label: string): Promise<number> {
  const startedLines = await startRounds(rig, ROUNDS_STARTED);
  const started = new Set<number>(ROUNDS_STARTED);
  const s = await sceneOf(rig);
  const before = await rowsOf(rig.tableId);
  const tailBefore = await tailRows(rig);
  const count = await entrantCount(rig.divisionId);
  const late = await addLate(rig, "Late");
  const result = tableAnswer(late.late_entry);
  expect(result.case, `${label}: a started table takes a catch-up`).toBe("catch_up");
  expect(result.source).toBe("organiser");
  expect(await entrantCount(rig.divisionId), `${label}: the entrant is in`).toBe(count + 1);
  await assertPlaced(rig, s, before, tailBefore, late.id, result, started, label);
  if (!rig.isGroup && rig.template === "league") {
    // The hand derivation of the five-field league (byes r1 P5, r2 P4, r3 P3, r4 P2, r5 P1; rounds 1-2 started): the oracle's own
    // arithmetic cross-checked against the rulebook worked by hand.
    const name = (id: string) => rig.names.get(id)!;
    expect(seatsOf(await rowsOf(rig.tableId), late.id).map((x) => `${name(x.opponent)}:${x.kind}:${x.round}`), `${label}: hand derivation`).toEqual([
      "P3:bye_slot:3",
      "P2:bye_slot:4",
      "P1:bye_slot:5",
      "P4:catch_up_round:6",
      "P5:catch_up_round:7",
    ]);
  }

  // The sequence: a second late player (an explicit pool in a group, RB5-L9) owes the first as well (RB5-L16).
  const afterFirst = await rowsOf(rig.tableId);
  const second = await addLate(rig, "Late 2", rig.isGroup ? { late_entry_pool: s.poolKey } : {});
  const secondAnswer = tableAnswer(second.late_entry);
  expect(secondAnswer.case).toBe("catch_up");
  const rows = await rowsOf(rig.tableId);
  const opp = seatsOf(rows, second.id).map((x) => x.opponent).sort();
  expect(opp, `${label}: the second newcomer plays the members and the first newcomer, once each`).toEqual([...s.members, late.id].sort());
  const afterFirstIds = new Set(afterFirst.map((r) => r.id));
  expect(rows.filter((r) => afterFirstIds.has(r.id)), `${label}: the first newcomer's lines are not moved`).toEqual(afterFirst);
  assertNobodySeatedTwice(rows, `${label} (second)`);
  expect(secondAnswer.fixtures!.length).toBe(s.members.length + 1);
  return startedLines + 1;
}

/** (rebuild_offered) nothing has started: the answer offers Rebuild (RB5-L7); the catch-up is written beside it (RB5-L15), and
 *  every member's fixture lands in its own bye round — all of them are still ahead. */
async function cellRebuildOffered(rig: Rig, label: string): Promise<void> {
  const s = await sceneOf(rig);
  const before = await rowsOf(rig.tableId);
  const tailBefore = await tailRows(rig);
  const late = await addLate(rig, "Late");
  const result = tableAnswer(late.late_entry);
  expect(result.case, `${label}: nothing started offers Rebuild`).toBe("rebuild_offered");
  expect(result.source).toBe("organiser");
  expect(result.reason, `${label}: the default is the catch-up, not a rebuild`).toBeUndefined();
  await assertPlaced(rig, s, before, tailBefore, late.id, result, new Set(), label);
  expect(result.appended_rounds, `${label}: every fixture takes a bye slot`).toBe(0);
  expect(
    (await storedByes(rig.tableId)).filter((b) => b.pool === s.poolId),
    `${label}: every bye of the joined pool became a match`,
  ).toEqual([]);
}

/** (refused) the table is complete: the organiser's add is refused by name and rolled back (RB5-L8); the same arrival by
 *  Reinstate commits, is answered `refused` and is never marked waiting (RB5-L10, "never refused" at the door, L8 at the table). */
async function cellRefused(rig: Rig, label: string): Promise<void> {
  await startRounds(rig, ROUNDS_STARTED);
  await sql`update stages set status = 'complete' where id = ${rig.tableId}`;
  const before = await rowsOf(rig.tableId);
  const tailBefore = await tailRows(rig);
  const count = await entrantCount(rig.divisionId);
  const err = await refusal(addLate(rig, "Late"));
  expect(err, `${label}: refused by name`).toMatchObject({ status: 422, code: "RR_LATE_ENTRY_STAGE_COMPLETE", message: COMPLETE });
  expect(await entrantCount(rig.divisionId), `${label}: the refusal rolled the entrant back`).toBe(count);
  expect(await rowsOf(rig.tableId), `${label}: no line written`).toEqual(before);
  expect(await ledger(rig.divisionId), `${label}: no ledger row`).toEqual([]);

  // The automatic door: commits, answers refused, no marker (a finished table takes no one).
  const back = rig.backId!;
  const reinstated = await patchEntrant(rig.auth, back, { status: "registered" });
  expect(reinstated.status, `${label}: the Reinstate commits`).toBe("registered");
  expect(reinstated.late_entry).toEqual({
    format: rig.isGroup ? "group" : "league",
    entrant_id: back,
    stage_id: rig.tableId,
    case: "refused",
    source: "automatic",
    reason: "RR_LATE_ENTRY_STAGE_COMPLETE",
  });
  expect(await waitingOn(back), `${label}: no marker`).toEqual({ table: null, knockout: null });
  expect(await rowsOf(rig.tableId), `${label}: still no line`).toEqual(before);
  expect(await tailRows(rig), `${label}: the bracket tail stands`).toEqual(tailBefore);
  expect((await attention(rig)).filter((a) => a.kind === "late_players_waiting"), `${label}: nobody waits`).toEqual([]);
  // The desk says so instead: derived on read, naming the player (a finished table's arrival is never silently unplaced).
  expect((await attention(rig)).filter((a) => a.kind === "late_unplaced"), `${label}: the desk names the unplaced arrival`).toEqual([
    { kind: "late_unplaced", count: 1, stageName: rig.tableName, names: [rig.names.get(back)] },
  ]);
}

/** (waiting) an automatic arrival (a Reinstate with no lines) into a started table waits with the desk flag; nothing is written
 *  and nothing is refused (RB5-L10). */
async function cellWaiting(rig: Rig, label: string): Promise<void> {
  await startRounds(rig, ROUNDS_STARTED);
  const before = await rowsOf(rig.tableId);
  const tailBefore = await tailRows(rig);
  const back = rig.backId!;
  expect(before.filter((r) => r.home_entrant_id === back || r.away_entrant_id === back), `${label}: premise: drawn without them`).toEqual([]);
  const reinstated = await patchEntrant(rig.auth, back, { status: "registered" });
  expect(reinstated.late_entry, `${label}: the answer`).toEqual({
    format: rig.isGroup ? "group" : "league",
    entrant_id: back,
    stage_id: rig.tableId,
    case: "waiting",
    source: "automatic",
  });
  expect(await waitingOn(back), `${label}: the marker names the table, never a bracket`).toEqual({ table: rig.tableId, knockout: null });
  expect(await rowsOf(rig.tableId), `${label}: nothing is written`).toEqual(before);
  expect(await tailRows(rig), `${label}: the bracket tail stands`).toEqual(tailBefore);
  expect(await ledger(rig.divisionId), `${label}: no ledger row: the wait is no placement`).toEqual([]);
  expect((await attention(rig)).filter((a) => a.kind === "late_players_waiting"), `${label}: the desk counts one waiting player`).toEqual([
    { kind: "late_players_waiting", count: 1, stageName: rig.tableName, table: true },
  ]);
  expect((await attention(rig)).filter((a) => a.kind === "late_unplaced"), `${label}: a running table has no unplaced arrival`).toEqual([]);
}

/** (tapped) the waiting arrival placed by one tap answers a catch-up with source organiser, clears the marker and the desk row;
 *  a second tap is refused by name. */
async function cellTapped(rig: Rig, label: string): Promise<void> {
  await startRounds(rig, ROUNDS_STARTED);
  const started = new Set<number>(ROUNDS_STARTED);
  const back = rig.backId!;
  const reinstated = await patchEntrant(rig.auth, back, { status: "registered" });
  expect(tableAnswer(reinstated.late_entry).case, `${label}: premise: the arrival waits`).toBe("waiting");
  expect((await attention(rig)).filter((a) => a.kind === "late_players_waiting").length, `${label}: premise: the desk flags it`).toBe(1);
  const s = await sceneOf(rig);
  const before = await rowsOf(rig.tableId);
  const tailBefore = await tailRows(rig);

  const placed = await placeWaitingTableEntrant(rig.auth, rig.tableId, back);
  expect(placed.case, `${label}: one tap runs the cases`).toBe("catch_up");
  expect(placed.source).toBe("organiser");
  await assertPlaced(rig, s, before, tailBefore, back, placed, started, label);
  expect(await waitingOn(back), `${label}: the marker clears`).toEqual({ table: null, knockout: null });
  expect((await attention(rig)).filter((a) => a.kind === "late_players_waiting"), `${label}: the desk row goes`).toEqual([]);
  expect(await ledger(rig.divisionId), `${label}: one ledger row, written by the tap`).toHaveLength(1);

  // The sequence: a second tap on the same player is refused by name and writes nothing.
  const rows = await rowsOf(rig.tableId);
  const err = await refusal(placeWaitingTableEntrant(rig.auth, rig.tableId, back));
  expect(err, `${label}: a second tap`).toMatchObject({ status: 409, code: "RR_LATE_ENTRY_ALREADY_PLACED", message: ALREADY_PLACED });
  expect(await rowsOf(rig.tableId), `${label}: the second tap wrote nothing`).toEqual(rows);
}

const CELL: Record<CaseKey, (rig: Rig, label: string) => Promise<unknown>> = {
  catch_up: cellCatchUp,
  rebuild_offered: cellRebuildOffered,
  refused: cellRefused,
  waiting: cellWaiting,
  tapped: cellTapped,
};
/** The rule ids each case asserts, as tokens in the title. */
const RULES: Record<CaseKey, string> = {
  catch_up: "X-CU-7 X-CU-11 X-CU-12 RB5-L3",
  rebuild_offered: "X-CU-7 X-CU-12 RB5-L7",
  refused: "X-CU-7 X-CU-8 RB5-L8",
  waiting: "X-CU-8 RB5-L10",
  tapped: "X-CU-8 X-CU-11 X-CU-12 RB5-L10",
};
const NEEDS_BACK: Record<CaseKey, boolean> = { catch_up: false, rebuild_offered: false, refused: true, waiting: true, tapped: true };

describe("W5 T7: the axes are what the registry and the templates declare", () => {
  it("the entry templates are the five the brief names, and the bracket-fed ones four", () => {
    expect(ENTRY_TEMPLATES.length, "anti-vacuity: entry templates").toBeGreaterThan(0);
    expect([...ENTRY_TEMPLATES].sort()).toEqual([...PINNED_ENTRY_TEMPLATES].sort());
    expect([...FED_TEMPLATES].sort()).toEqual([...PINNED_FED_TEMPLATES].sort());
  });

  it("every kind has a sport that declares it and offers every entry template", () => {
    expect(KINDS.length, "anti-vacuity: kinds").toBe(3);
    for (const k of KINDS) {
      const sport = SPORT_OF.get(k);
      expect(sport, `a sport for ${k}`).toBeDefined();
      expect(engineEntrantKinds(sport!.key), `${sport!.key} declares ${k}`).toContain(k);
    }
  });
});

describe.skipIf(!HAS_DB)("W5 T7: the counted table late-entry sweep (template x kind x case)", () => {
  for (const template of ENTRY_TEMPLATES) {
    for (const kind of KINDS) {
      for (const c of CASES) {
        it(`${RULES[c]} [${template} / ${kind} / ${c}]`, async () => {
          const rig = await templateRig(template, kind, { back: NEEDS_BACK[c] });
          await CELL[c](rig, `${template}/${kind}/${c}`);
          checked.add(cellKey(template, kind, c));
        }, 180_000);
      }
    }
  }
});

describe.skipIf(!HAS_DB)("W5 T7: a bracket fed from a table never seats a late entrant (X-CU-9, X-LE-2, RB5-L2)", () => {
  for (const template of PINNED_FED_TEMPLATES) {
    for (const kind of KINDS) {
      it(`X-CU-9 X-LE-2 RB5-L2 [${template} / ${kind}] both late doors seat the table only; the bracket stands`, async () => {
        const rig = await templateRig(template, kind, { back: true });
        expect(rig.tailIds.length, "premise: the template has a fed bracket").toBeGreaterThan(0);
        const tailBefore = await tailRows(rig);
        expect(tailBefore.length, "anti-vacuity: the bracket holds lines to be left alone").toBeGreaterThan(0);
        await startRounds(rig, ROUNDS_STARTED);
        // The automatic door: waits on the TABLE, never on a bracket.
        const reinstated = await patchEntrant(rig.auth, rig.backId!, { status: "registered" });
        expect(tableAnswer(reinstated.late_entry)).toMatchObject({ case: "waiting", stage_id: rig.tableId });
        expect(await waitingOn(rig.backId!), "the marker names the table").toEqual({ table: rig.tableId, knockout: null });
        // The organiser's door: seated in the table.
        const late = await addLate(rig, "Late");
        const answer = tableAnswer(late.late_entry);
        expect(answer, "the add joins the table").toMatchObject({ case: "catch_up", stage_id: rig.tableId });
        // A tap addressed to a BRACKET stage places nobody there.
        for (const tail of rig.tailIds) {
          const err = await refusal(placeWaitingLateEntrant(rig.auth, tail, rig.backId!));
          expect(err, `a tap on the fed bracket ${tail} is refused by name`).toMatchObject({ status: 409, code: "KO_LATE_ENTRY_NOT_WAITING", message: BRACKET_NOT_WAITING });
        }
        expect(await waitingOn(rig.backId!), "the refused tap left the waiting marker").toEqual({ table: rig.tableId, knockout: null });
        // The table's own tap still places them.
        const placed = await placeWaitingTableEntrant(rig.auth, rig.tableId, rig.backId!);
        expect(placed).toMatchObject({ case: "catch_up", stage_id: rig.tableId });
        expect(await tailRows(rig), "the bracket stands, line for line").toEqual(tailBefore);
        const inBracket = (await tailRows(rig)).filter((r) => [late.id, rig.backId].some((x) => r.home_entrant_id === x || r.away_entrant_id === x));
        expect(inBracket, "neither late player is in any bracket line").toEqual([]);
        const [{ n }] = await sql<{ n: number }[]>`
          select count(*)::int as n from fixtures where stage_id = ${rig.tableId} and (home_entrant_id in ${sql([late.id, rig.backId!])} or away_entrant_id in ${sql([late.id, rig.backId!])})`;
        expect(n, "anti-vacuity: both are seated in the table").toBeGreaterThan(0);
        fedChecked.add(`${template}|${kind}`);
      }, 180_000);
    }
  }
});

describe.skipIf(!HAS_DB)("W5 T7: the sweep checked every cell", () => {
  it("75 cells (5 templates x 3 kinds x 5 cases) and 12 fed-tail rows, none vacuous", () => {
    const expectedCells = ENTRY_TEMPLATES.length * KINDS.length * CASES.length;
    const expectedFed = FED_TEMPLATES.length * KINDS.length;
    console.log(`W5 T7 matrix: checked ${checked.size}/${expectedCells} cells, ${fedChecked.size}/${expectedFed} fed-tail rows`);
    expect(expectedCells, "the brief's arithmetic: 5 x 3 x 5").toBe(75);
    expect(expectedFed, "the brief's arithmetic: 4 x 3").toBe(12);
    expect(checked.size, "every cell ran to the end").toBe(75);
    expect(fedChecked.size, "every fed-tail row ran to the end").toBe(12);
    for (const t of ENTRY_TEMPLATES) for (const k of KINDS) for (const c of CASES) expect(checked.has(cellKey(t, k, c)), cellKey(t, k, c)).toBe(true);
  });
});
