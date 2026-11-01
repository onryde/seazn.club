// W3 Task 10c — late entry in EVERY Swiss format and for EVERY entrant kind, through the real usecases on Postgres
// (owner 2026-11-01: "make sure that it does support in all format and support all entrant kind"; rules X-SW-12, X-SW-13,
// X-SW-14; spec 2026-10-31-format-matrix-w3-swiss-design.md §4, rulings 250/251). A coverage sweep: it builds nothing.
//
// Enumerated, never sampled:
//   templates — every STAGE_TEMPLATES entry whose stages hold a Swiss (lib/format-templates.ts), pinned to the three the
//               brief names; built through `buildTemplateStages` and the API's own `CreateStage` schema, so the stages
//               are what the division builder makes. Late entry acts on the ROOT Swiss only; the playoff/knockout tail
//               takes its field from the cut.
//   kinds     — every `entrants.kind` (V212; `EntrantKind` in schemas.ts). Each is played by a sport whose engine module
//               DECLARES it (`entrantModel.kinds`), its natural sport first (`defaultKind`), among the sports this file
//               can score a played win in — chess for individual (chess is individual-only), badminton for a doubles
//               pair, football for a team. Derived below, never typed as a table.
//   cases     — (a) re-pair, (b) take the bye, (c) next round, an automatic arrival (a registration confirm: always (c)),
//               and the refusals (the last round started: SWISS_NO_ROUND_LEFT; the Swiss finished: SWISS_OVER).
//
// Expected values come from the rulebook and the plan's rules — the case and the round the newcomer plays first (ruling
// 250), 0 for each missed round with no score (ruling 251), the template's own seeding declaration (rankRange from 1,
// rank_order) — and from the rows as they stood before the add, never from the code under test.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql, withTenant } from "@/lib/db";
import { builtinModules } from "@seazn/engine/sports";
import { entrantKindCap, type AnySportModule } from "@seazn/engine/sport";
import { STAGE_TEMPLATES, buildTemplateStages, templatesForSport } from "@/lib/format-templates";
import { entrantListLocked, divisionTakesSwissLateEntry, isRunningRootSwiss } from "@/lib/open-entry-stages";
import { SWISS_REFUSALS, type SwissRefusalCode } from "@/lib/swiss-refusals";
import { defaultSwissChess } from "@/lib/swiss-draw";
import type { LateEntryDecision } from "@/lib/swiss-late-entry";
import { sportStageRule } from "@/lib/stage-points-splits";
import type { AuthCtx } from "@/server/api-v1/auth";
import { CreateStage, EntrantKind } from "@/server/api-v1/schemas";
import { resolveModule } from "@/server/engine-db";
import { forfeitPlayedFacts } from "@/server/engine-db/forfeit-played";
import type { StandingsSnapshotRow } from "@/server/public-site/data";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { confirmRegistration, putRegistrationSettings } from "../registrations";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import {
  buildSwissHistory,
  completeStage,
  confirmSeedProposal,
  createStages,
  generateStageFixtures,
  swissActiveEntrants,
  type SwissExistingFixture,
} from "../stages";
import { createCourt, createVenue } from "../venues";
import { seedRegistration } from "./_registration-fixtures";
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
type Outcome = { kind?: string; winner?: string; loser?: string | null; reason?: string } | null;

interface Row {
  id: string;
  stage_id: string;
  ext_key: string | null;
  round_no: number;
  seq_in_round: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
  outcome: Outcome;
  scheduled_at: Date | null;
  court_id: string | null;
  venue_id: string | null;
  schedule_locked: boolean;
}

// ─── What is enumerated ────────────────────────────────────────────────────────────────────────────────────────────────

/** Every template whose stages hold a Swiss, read off the templates' OWN stage graphs (any knobs: kinds do not depend on
 *  them). The brief names three; a fourth would red the pin below rather than slip past the matrix. */
const SWISS_TEMPLATES = STAGE_TEMPLATES.filter((t) =>
  t.build({ qualified: 4, swissRounds: 3, poolCount: 2, legs: 1 }).some((s) => s.kind === "swiss"),
).map((t) => t.key);

/** A PLAYED win for `winner` after `core.start`, through the scorer's own events — each sport's own vocabulary. The set
 *  of sports this file can drive; the kind ↔ sport pairing below is chosen from the engine's declarations within it. */
const PLAYED_WIN: Record<string, (auth: AuthCtx, f: Row, winner: string) => Promise<void>> = {
  boardgame: async (auth, f, winner) => {
    await post(auth, f.id, "boardgame.result", { winner, method: "resign" });
  },
  badminton: async (auth, f, winner) => {
    const home = winner === f.home_entrant_id;
    for (let g = 0; g < 2; g++) await post(auth, f.id, "badminton.game.summary", home ? { home: 21, away: 10 } : { home: 10, away: 21 });
  },
  football: async (auth, f, winner) => {
    await post(auth, f.id, "football.goal", { by: winner });
    await post(auth, f.id, "football.period", { phase: "HT" });
    await post(auth, f.id, "football.period", { phase: "FT" });
  },
};

interface SportPick {
  key: string;
  variant: string;
  module: AnySportModule;
}

/** The kind's sport, from the engine's declarations: a module that declares the kind (`entrantModel.kinds`) and is
 *  offered every Swiss template (`templatesForSport` — chess refuses only the formats that mint pairs), its natural one
 *  first (`defaultKind === kind`), else the registry's first. The variant is the module's first declared one. */
function sportFor(kind: Kind): SportPick {
  const offered = builtinModules.filter(
    (m) =>
      m.key in PLAYED_WIN &&
      (m.entrantModel?.kinds ?? ["individual"]).includes(kind) &&
      SWISS_TEMPLATES.every((t) => templatesForSport(m.key).some((x) => x.key === t)),
  );
  const pick = offered.find((m) => m.entrantModel?.defaultKind === kind) ?? offered[0];
  if (pick === undefined) throw new Error(`no scorable sport declares the '${kind}' entrant kind`);
  const variant = Object.keys(pick.variants)[0];
  if (variant === undefined) throw new Error(`sport ${pick.key} declares no variant`);
  return { key: pick.key, variant, module: pick as AnySportModule };
}

const KINDS: readonly Kind[] = EntrantKind.options;
const SPORT_OF = new Map(KINDS.map((k) => [k, sportFor(k)] as const));
const sportOf = (kind: Kind): SportPick => SPORT_OF.get(kind)!;

const CASES = ["a", "b", "c", "automatic", "refused"] as const;
type CaseKey = (typeof CASES)[number];

/** Each case's decision (`LateEntryDecision`, lib/swiss-late-entry.ts), typed so a new decision kind is a compile error
 *  here until it has a case (review m5). `noop` alone has none: an already-admitted entrant (a webhook retry, a double
 *  submit) is not an arrival — swiss-late-entry.test.ts drives it ("admitting the same entrant twice is a no-op"). */
const DECISION_OF = {
  a: "repair",
  b: "take_bye",
  c: "next_round",
  automatic: "next_round",
  refused: "refused",
} as const satisfies Record<CaseKey, LateEntryDecision["kind"]>;
type Uncased = Exclude<LateEntryDecision["kind"], (typeof DECISION_OF)[CaseKey] | "noop">;
const EVERY_DECISION_CASED: [Uncased] extends [never] ? true : Uncased = true;

/** The knob the tail's cut reads (`rankRange(1, qualified)`); swiss_playoff's Page playoff is a fixed four. */
const QUALIFIED = 4;

// ─── Rig ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Rig {
  template: string;
  kind: Kind;
  sport: SportPick;
  auth: AuthCtx;
  competitionId: string;
  divisionId: string;
  swissStageId: string;
  /** The playoff/knockout stage the cut feeds; null for the plain `swiss` template. */
  tailStageId: string | null;
  /** Entrant ids by seed, P1..Pn. */
  entrants: string[];
}

/** A roster of the kind's own shape: one inline person per seat, at most two (`entrantKindCap`: an individual holds one,
 *  a pair two). */
function entrantInput(kind: Kind, name: string, seed?: number) {
  const seats = Math.min(2, entrantKindCap(kind));
  return {
    kind,
    display_name: name,
    ...(seed !== undefined ? { seed } : {}),
    members: Array.from({ length: seats }, (_, i) => ({
      new_person: { full_name: `${name} m${i + 1} ${randomUUID().slice(0, 4)}` },
      is_captain: false,
      roles: [],
    })),
  };
}

/** N seeded entrants of `kind` in the template's own stages, started (the Swiss shells minted); the tail's day-one TBD
 *  bracket generated, as the organiser's Generate lays it out. */
async function templateRig(template: string, kind: Kind, n: number, rounds: number): Promise<Rig> {
  const sport = sportOf(kind);
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: `Matrix ${template} ${kind} ` + randomUUID().slice(0, 6),
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
  const made = await createEntrants(
    auth,
    division.id,
    Array.from({ length: n }, (_, i) => entrantInput(kind, `P${i + 1}`, i + 1)),
  );
  const drafts = buildTemplateStages(template, { qualified: QUALIFIED, swissRounds: rounds, poolCount: 2, legs: 1 });
  expect(drafts[0]?.kind, `premise: ${template} opens with its Swiss`).toBe("swiss");
  expect(drafts[0]?.progression, `premise: ${template}'s Swiss is a ROOT one`).toBeNull();
  const ids: string[] = [];
  for (const [i, d] of drafts.entries()) {
    // Through the API's own request schema, as swiss-knockout-shape.test.ts does: what the picker builds is what the API
    // accepts, and a malformed draft throws here instead of seeding a different stage.
    const [stage] = await createStages(
      auth,
      division.id,
      CreateStage.parse({ seq: i + 1, kind: d.kind, name: d.name, config: d.config, progression: d.progression }),
    );
    ids.push(stage!.id);
  }
  // The individual kind's sport is chess (the boardgame module): its Swiss is stored a CHESS Swiss (`chess: true`,
  // BG-SW-1), so the latecomer meets FIDE colours too. Read off the stored stage, against the creation default.
  const [swissCfg] = await sql<{ chess: boolean | null }[]>`select (config->>'chess')::boolean as chess from stages where id = ${ids[0]!}`;
  expect(swissCfg!.chess === true, `premise: ${sport.key}'s Swiss is stored chess iff the sport is chess`).toBe(defaultSwissChess(sport.key));
  await startDivision(auth, division.id);
  const tailStageId = ids[1] ?? null;
  if (tailStageId !== null) await generateStageFixtures(auth, tailStageId);
  return {
    template,
    kind,
    sport,
    auth,
    competitionId: comp.id,
    divisionId: division.id,
    swissStageId: ids[0]!,
    tailStageId,
    entrants: made.map((e) => e.id),
  };
}

const rowsOf = (stageId: string) =>
  sql<Row[]>`
    select id, stage_id, ext_key, round_no, seq_in_round, home_entrant_id, away_entrant_id, status, outcome,
           scheduled_at, court_id, venue_id, schedule_locked
    from fixtures where stage_id = ${stageId} order by round_no, seq_in_round`;
const tailRowsOf = async (rig: Rig) => (rig.tailStageId === null ? [] : rowsOf(rig.tailStageId));
const roundOf = (rows: readonly Row[], r: number) => rows.filter((f) => f.round_no === r);
const isBye = (f: Row) => /^sw-r\d+-bye$/.test(f.ext_key ?? "");
const boardsOf = (rows: readonly Row[], r: number) => roundOf(rows, r).filter((f) => !isBye(f));
const seatedIn = (rows: readonly Row[]) => rows.flatMap((f) => [f.home_entrant_id, f.away_entrant_id]).filter((x): x is string => x !== null);
const pair = (rig: Rig) => generateStageFixtures(rig.auth, rig.swissStageId);

/** One scorer event at the fixture's tip (`expected_seq` = the events already recorded). */
async function post(auth: AuthCtx, fixtureId: string, type: string, payload: Record<string, unknown> = {}): Promise<void> {
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${fixtureId}`;
  await scoreEvent(auth, fixtureId, { expected_seq: n, type, payload });
}

/** The scorer's first event: the board has started. */
const startBoard = (rig: Rig, f: Row) => post(rig.auth, f.id, "core.start");

/** A played win for `winner`, from wherever the board stands (a started board is played on from its Start). */
async function winBoard(rig: Rig, f: Row, winner: string): Promise<void> {
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${f.id}`;
  if (n === 0) await startBoard(rig, f);
  await PLAYED_WIN[rig.sport.key]!(rig.auth, f, winner);
}

/** Every undecided board of round `r` is played; `winnerOf` picks each board's winner (the home side by default). */
async function playRound(rig: Rig, r: number, winnerOf: (f: Row) => string = (f) => f.home_entrant_id!): Promise<void> {
  const boards = boardsOf(await rowsOf(rig.swissStageId), r).filter((f) => f.status !== "decided");
  expect(boards.length, `rig: round ${r} has boards to play`).toBeGreaterThan(0);
  for (const f of boards) await winBoard(rig, f, winnerOf(f));
  const after = boardsOf(await rowsOf(rig.swissStageId), r);
  expect(after.map((f) => f.status), `rig: round ${r} is decided`).toEqual(after.map(() => "decided"));
}

/** The organiser's Add of one unseeded entrant of the rig's kind — the product path, `createEntrants`. */
async function addLate(rig: Rig, name: string) {
  const [row] = await createEntrants(rig.auth, rig.divisionId, [entrantInput(rig.kind, name)]);
  return row!;
}

async function entrantCount(divisionId: string): Promise<number> {
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from entrants where division_id = ${divisionId}`;
  return n;
}

async function firstRoundOf(entrantId: string) {
  const [e] = await sql<{ kind: string; swiss_first_round: number | null; swiss_first_round_stage_id: string | null }[]>`
    select kind, swiss_first_round, swiss_first_round_stage_id from entrants where id = ${entrantId}`;
  return e!;
}

async function lateRows(divisionId: string) {
  return (
    await sql<{ payload: Record<string, unknown> }[]>`
      select payload from division_events where division_id = ${divisionId} and type = 'swiss_late_entry' order by seq`
  ).map((r) => r.payload);
}

async function ledgerCount(divisionId: string): Promise<number> {
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from division_events where division_id = ${divisionId}`;
  return n;
}

/** The Swiss stage's STORED table (what the public pages and the cut read), in its stored order — written by the
 *  product's fold, read here only. */
async function storedTable(stageId: string): Promise<StandingsSnapshotRow[]> {
  const snaps = await sql<{ rows: StandingsSnapshotRow[] }[]>`select rows from standings_snapshots where stage_id = ${stageId}`;
  expect(snaps.length, "a Swiss keeps one overall table").toBeLessThanOrEqual(1);
  return snaps[0]?.rows ?? [];
}

/** The history the next Pair reads — the stage's rows, its played facts, and the field with each entrant's
 *  STAGE-SCOPED first round (`swissActiveEntrants`, the Pair's own read). */
async function historyOf(rig: Rig) {
  const rows = (await rowsOf(rig.swissStageId)) as unknown as SwissExistingFixture[];
  const [d] = await sql<{ sport_key: string; module_version: string }[]>`select sport_key, module_version from divisions where id = ${rig.divisionId}`;
  const facts = await forfeitPlayedFacts(sql, rows.filter((f) => f.home_entrant_id && f.away_entrant_id), resolveModule(d!.sport_key, d!.module_version));
  const field = await withTenant(rig.auth.orgId, (tx) => swissActiveEntrants(tx, rig.divisionId, rig.swissStageId));
  return buildSwissHistory(rows, field, facts);
}

/** What the rows hold for `id`, counted off the fixtures alone: a win is a decided board or a bye award naming them the
 *  winner (a bye is a win, rulebook §7), a loss a decided board they sat on and did not win. A missed round holds no row,
 *  so it adds nothing — which is the rule under test (ruling 251: 0, no score). */
function recordOnRows(rows: readonly Row[], id: string) {
  const mine = rows.filter((f) => f.home_entrant_id === id || f.away_entrant_id === id);
  const won = mine.filter((f) => (f.outcome?.kind === "win" || f.outcome?.kind === "award") && f.outcome.winner === id).length;
  const lost = mine.filter((f) => !isBye(f) && f.status === "decided" && f.outcome?.winner !== undefined && f.outcome.winner !== id).length;
  const byes = mine.filter((f) => isBye(f) && f.outcome?.kind === "award").length;
  return { won, lost, byes };
}

/** What the sport's DECLARED Swiss points rule pays each result the rigs produce (`tablePointsRule` through
 *  `sportStageRule`, the stage editor's own read): a played win, a played loss, a bye. Mirrors the engine's documented
 *  payout (points.ts `payout`, ruling 108): a set sport pays its `bySetScore` pair, a bye pays the rule's forfeit row
 *  when it sets one, else the winner's win (a bye is a win, rulebook §7). Premises guard what this does not model. */
function declaredPay(rig: Rig): { win: number; loss: number; bye: number } {
  const declared = sportStageRule(rig.sport.module, rig.sport.module.variants[rig.sport.variant], "swiss");
  expect(declared, `premise: ${rig.sport.key} declares a Swiss points rule`).not.toBeNull();
  const rule = declared!.rule;
  expect(rule.bonuses, "premise: the rule pays no bonuses").toEqual([]);
  const set = rule.bySetScore;
  // A set table keyed by exact scores would pay by the score; the rigs' sports declare only the catch-all.
  if (set !== undefined) expect(Object.keys(set), "premise: the set table is the catch-all alone").toEqual(["*"]);
  const pair = set?.["*"];
  const win = pair ? pair[0] : rule.win.regulation;
  return { win, loss: pair ? pair[1] : rule.loss.regulation, bye: rule.forfeit?.winnerPoints ?? win };
}

/** The points `id`'s fixture rows earn under `pay` — no draws in these rigs (premise) — and nothing for a round with no
 *  row: a missed round adds 0 (ruling 251). */
function pointsOnRows(rows: readonly Row[], id: string, pay: { win: number; loss: number; bye: number }): number {
  expect(rows.filter((f) => f.outcome?.kind === "draw").length, "premise: no draws").toBe(0);
  const { won, lost, byes } = recordOnRows(rows, id);
  return (won - byes) * pay.win + lost * pay.loss + byes * pay.bye;
}

/** Every stored row's POINTS against the declared rule over the fixture rows (review round 2): the fold pays what the
 *  sport declares, and a latecomer's missed rounds pay nothing. Answers how many rows were checked. */
async function assertStoredPoints(rig: Rig, label: string): Promise<number> {
  const rows = await rowsOf(rig.swissStageId);
  const pay = declaredPay(rig);
  const table = await storedTable(rig.swissStageId);
  for (const r of table) expect(r.points, `${label}: ${r.entrantId}'s stored points are the declared rule's`).toBe(pointsOnRows(rows, r.entrantId, pay));
  return table.length;
}

/** Ruling 251 on the two records a missed round could leak into: the Pair's history (its score and bye eligibility,
 *  P-A4) and the stored table. Expected values are the rows' own facts; a missed round adds nothing to either. */
async function assertMissedRoundsScoreZero(rig: Rig, lateId: string, label: string): Promise<void> {
  const rows = await rowsOf(rig.swissStageId);
  const facts = recordOnRows(rows, lateId);
  const hist = await historyOf(rig);
  expect(hist.score.get(lateId) ?? 0, `${label}: the Pair counts only what was played (0 per missed round)`).toBe(facts.won);
  expect(hist.byes.has(lateId), `${label}: a missed round is no bye (P-A4: still bye-eligible)`).toBe(facts.byes > 0);
  const row = (await storedTable(rig.swissStageId)).find((r) => r.entrantId === lateId);
  if (facts.won + facts.lost === 0) {
    // Nothing decided yet: the stored table may not list them, and if it does it holds nothing.
    if (row !== undefined) {
      expect({ played: row.played, won: row.won, lost: row.lost, drawn: row.drawn, points: row.points }, `${label}: an empty record`).toEqual({
        played: 0,
        won: 0,
        lost: 0,
        drawn: 0,
        points: 0,
      });
    }
    return;
  }
  expect(row, `${label}: the stored table lists the latecomer once they have a result`).toBeDefined();
  // Played counts the rounds they were in — a bye is one (it is a win) — and never a missed round.
  expect({ played: row!.played, won: row!.won, lost: row!.lost, drawn: row!.drawn }, `${label}: the stored table holds only the rounds played`).toEqual({
    played: facts.won + facts.lost,
    won: facts.won,
    lost: facts.lost,
    drawn: 0,
  });
  // Points too (review round 2), for every stored row: the latecomer's are the declared rule over the rounds played.
  expect(await assertStoredPoints(rig, label), `${label}: anti-vacuity: stored rows checked`).toBeGreaterThan(0);
}

const refusal = (code: SwissRefusalCode) => ({ status: SWISS_REFUSALS[code].status, code });

/** Round `r`'s boards placed on courts at a time, as the planner leaves them (T9's `placeRound`, without the settings the
 *  re-pair's slot reuse needs): a venue, a court per board, one start time. */
async function placeBoards(rig: Rig, r: number): Promise<void> {
  const venue = await createVenue(rig.auth, { name: "Hall " + randomUUID().slice(0, 4), sort: 0 });
  const boards = boardsOf(await rowsOf(rig.swissStageId), r);
  for (const [i, f] of boards.entries()) {
    const court = await createCourt(rig.auth, venue.id, { name: `Court ${i + 1}`, sort: i, tags: [] });
    await sql`update fixtures set scheduled_at = ${"2030-06-01T10:00:00.000Z"}, court_id = ${court.id}, venue_id = ${venue.id} where id = ${f.id}`;
  }
}

const swissPremise = (rows: readonly Row[], r: number) => ({
  seated: new Set(seatedIn(roundOf(rows, r))).size,
  byeRows: roundOf(rows, r).filter(isBye).length,
});

// ─── The cells ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** (a) nothing of round 2 has started: round 2 is re-paired with the newcomer; round 1 and the tail stand. Four entrants
 *  so round 1 — the round the newcomer misses — holds no bye row, the shape a missed-as-bye rule would credit. */
async function cellA(rig: Rig): Promise<void> {
  await pair(rig);
  await playRound(rig, 1);
  await pair(rig);
  const before = await rowsOf(rig.swissStageId);
  expect(swissPremise(before, 1), "premise: round 1 seated all four, no bye row").toEqual({ seated: 4, byeRows: 0 });
  expect(boardsOf(before, 2).map((f) => f.status), "premise: round 2 paired, nothing started").toEqual(["scheduled", "scheduled"]);
  const tailBefore = await tailRowsOf(rig);

  const late = await addLate(rig, "Late");
  expect(late.late_entry).toMatchObject({ entrant_id: late.id, stage_id: rig.swissStageId, case: "a", round: 2 });
  const after = await rowsOf(rig.swissStageId);
  // Five: two boards and a bye, every active entrant seated once, the newcomer among them.
  expect(swissPremise(after, 2), "round 2 re-paired over five").toEqual({ seated: 5, byeRows: 1 });
  expect(seatedIn(roundOf(after, 2)).length, "nobody seated twice").toBe(5);
  expect(seatedIn(roundOf(after, 2))).toContain(late.id);
  expect(roundOf(after, 1), "round 1 stands, field for field").toEqual(roundOf(before, 1));
  expect(await tailRowsOf(rig), "the tail never takes a latecomer").toEqual(tailBefore);
  expect(await firstRoundOf(late.id)).toEqual({ kind: rig.kind, swiss_first_round: 2, swiss_first_round_stage_id: rig.swissStageId });
  expect(await lateRows(rig.divisionId)).toEqual([expect.objectContaining({ entrant_id: late.id, case: "a", round: 2, source: "organiser" })]);
  await assertMissedRoundsScoreZero(rig, late.id, "after the re-pair");
  await playRound(rig, 2);
  await assertMissedRoundsScoreZero(rig, late.id, "after round 2");
}

/** (b) a board of round 2 has started and the round has a bye: the newcomer plays the holder; nothing else moves. */
async function cellB(rig: Rig): Promise<void> {
  await pair(rig);
  await playRound(rig, 1);
  await pair(rig);
  await placeBoards(rig, 2);
  await startBoard(rig, boardsOf(await rowsOf(rig.swissStageId), 2)[0]!);
  const before = await rowsOf(rig.swissStageId);
  expect(swissPremise(before, 2), "premise: round 2 seats five with a bye").toEqual({ seated: 5, byeRows: 1 });
  // Review m3: the rows compared below carry real times, courts and venues, so "field for field" is not null = null.
  expect(
    boardsOf(before, 2).map((f) => f.scheduled_at !== null && f.court_id !== null && f.venue_id !== null),
    "premise: round 2's boards are placed",
  ).toEqual([true, true]);
  const byeRow = roundOf(before, 2).find(isBye)!;
  const holder = byeRow.home_entrant_id!;
  const tailBefore = await tailRowsOf(rig);
  const tableBefore = new Map((await storedTable(rig.swissStageId)).map((r) => [r.entrantId, r]));

  const late = await addLate(rig, "Late");
  expect(late.late_entry).toMatchObject({ entrant_id: late.id, stage_id: rig.swissStageId, case: "b", round: 2, bye_holder_id: holder });
  const after = await rowsOf(rig.swissStageId);
  expect(after.some((f) => f.id === byeRow.id), "the bye row is gone").toBe(false);
  const added = after.filter((f) => !before.some((b) => b.id === f.id));
  expect(added.length, "one board added").toBe(1);
  const board = added[0]!;
  expect(late.late_entry!.new_board?.fixture_id).toBe(board.id);
  expect(new Set([board.home_entrant_id, board.away_entrant_id]), "the newcomer plays the holder").toEqual(new Set([holder, late.id]));
  expect({ round: board.round_no, status: board.status, outcome: board.outcome }).toEqual({ round: 2, status: "scheduled", outcome: null });
  // Nothing else moved: every other row field for field — seats, round and order, status and outcome, time, court, venue,
  // lock — the tail included.
  const others = before.filter((f) => f.id !== byeRow.id);
  expect(after.filter((f) => f.id !== board.id), "every other Swiss row stands").toEqual(others);
  expect(others.length, "anti-vacuity: the other rows were compared").toBeGreaterThan(5);
  expect(others.filter((f) => f.court_id !== null).length, "anti-vacuity: placed rows among them").toBe(2);
  expect(await tailRowsOf(rig), "the tail never takes a latecomer").toEqual(tailBefore);
  // The stored table: the holder's bye win is gone; every other record stands (a rank may move — that is the refold).
  // The whole record (review m3): played, won, drawn, lost, points and every metric the sport DECLARES (its own results:
  // goals, sets, colours…). What may move is what the holder's lost bye win refolds: the rank, the tie notes (`tieBreak`,
  // `level`) and the table-derived tie-break values (Buchholz, Sonneborn-Berger — sums over opponents' scores).
  const own = rig.sport.module.metrics.map((m) => m.key);
  expect(own.length, `premise: ${rig.sport.key} declares its own metrics`).toBeGreaterThan(0);
  const record = (r: StandingsSnapshotRow) => ({
    played: r.played,
    won: r.won,
    drawn: r.drawn,
    lost: r.lost,
    points: r.points,
    metrics: Object.fromEntries(own.map((k) => [k, r.metrics[k]])),
  });
  const tableAfter = new Map((await storedTable(rig.swissStageId)).map((r) => [r.entrantId, r]));
  expect(tableAfter.get(holder)?.won, "the bye's win left the stored table").toBe(tableBefore.get(holder)!.won - 1);
  let compared = 0;
  for (const id of rig.entrants.filter((x) => x !== holder)) {
    const was = tableBefore.get(id);
    const now = tableAfter.get(id);
    expect(was, `${id} was in the stored table`).toBeDefined();
    expect(now, `${id} is still in the stored table`).toBeDefined();
    expect(own.filter((k) => typeof was!.metrics[k] !== "number"), `${id}: every declared metric was stored`).toEqual([]);
    expect(record(now!), `${id}'s record stands`).toEqual(record(was!));
    compared++;
  }
  expect(compared, "anti-vacuity: four other records compared, each present before and after").toBe(4);
  expect(await firstRoundOf(late.id)).toEqual({ kind: rig.kind, swiss_first_round: 2, swiss_first_round_stage_id: rig.swissStageId });
  expect(await lateRows(rig.divisionId)).toEqual([expect.objectContaining({ entrant_id: late.id, case: "b", round: 2, source: "organiser" })]);
  await assertMissedRoundsScoreZero(rig, late.id, "after taking the bye");
  await winBoard(rig, board, late.id);
  await assertMissedRoundsScoreZero(rig, late.id, "after the new board is won");
}

/** (c) a board of round 1 has started and the round has no bye: round 1 is untouched; the newcomer joins round 2. */
async function cellC(rig: Rig): Promise<void> {
  await pair(rig);
  await startBoard(rig, boardsOf(await rowsOf(rig.swissStageId), 1)[0]!);
  const before = await rowsOf(rig.swissStageId);
  expect(swissPremise(before, 1), "premise: round 1 seats four, no bye row").toEqual({ seated: 4, byeRows: 0 });
  const tailBefore = await tailRowsOf(rig);

  const late = await addLate(rig, "Late");
  expect(late.late_entry).toEqual({ entrant_id: late.id, stage_id: rig.swissStageId, case: "c", round: 2 });
  expect(await rowsOf(rig.swissStageId), "nothing moved").toEqual(before);
  expect(await tailRowsOf(rig), "the tail never takes a latecomer").toEqual(tailBefore);
  expect(await firstRoundOf(late.id)).toEqual({ kind: rig.kind, swiss_first_round: 2, swiss_first_round_stage_id: rig.swissStageId });
  expect(await lateRows(rig.divisionId)).toEqual([expect.objectContaining({ entrant_id: late.id, case: "c", round: 2, source: "organiser" })]);
  await playRound(rig, 1);
  // Round 1 — fully seated, no bye row — is exactly the round an implicit-bye rule would credit them for.
  await assertMissedRoundsScoreZero(rig, late.id, "after the missed round");
  await pair(rig);
  const rows2 = await rowsOf(rig.swissStageId);
  const r2 = roundOf(rows2, 2);
  expect(seatedIn(r2).filter((id) => id === late.id).length, "the next Pair seats the newcomer once").toBe(1);
  expect(swissPremise(r2, 2), "round 2 seats all five").toEqual({ seated: 5, byeRows: 1 });
  // Review m4 — the Pair's OUTPUT honours the 0, not just its history: a Swiss pairs within score groups and gives the
  // bye to the lowest one (rulebook §7; FIDE C.04.3). After round 1 the newcomer is in the 0-point group with round 1's
  // losers — never with its winners — so it meets a loser or holds the bye, and the bye never goes to a winner.
  const r1Winners = new Set(boardsOf(rows2, 1).map((f) => f.outcome!.winner!));
  expect(r1Winners.size, "premise: round 1 had two winners").toBe(2);
  const lateRow = r2.find((f) => f.home_entrant_id === late.id || f.away_entrant_id === late.id)!;
  const opponent = isBye(lateRow) ? null : lateRow.home_entrant_id === late.id ? lateRow.away_entrant_id : lateRow.home_entrant_id;
  expect(opponent !== null && r1Winners.has(opponent), "the newcomer is not paired up into the 1-point group").toBe(false);
  expect(r1Winners.has(r2.find(isBye)!.home_entrant_id!), "the bye goes to the 0-point group").toBe(false);
  await playRound(rig, 2);
  await assertMissedRoundsScoreZero(rig, late.id, "after round 2");
}

/** An automatic arrival — a free registration confirmed while round 1 is paired and NOTHING has started, where an
 *  organiser would re-pair — takes (c): nothing moves, and the next Pair seats them. The registration's entrant kind is
 *  the rig's (the division's registration settings), so the arrival is of that kind. */
/** A free registration of the rig's kind (the division's registration settings say which), confirmed through the real
 *  `confirmRegistration` — the automatic arrival path. Answers the entrant it made. */
async function registerAndConfirm(rig: Rig, name: string): Promise<string> {
  const settings = await putRegistrationSettings(rig.auth, rig.divisionId, {
    enabled: true,
    entrant_kind: rig.kind,
    fee_cents: 0,
    form_fields: [],
    opens_at: null,
    closes_at: null,
    capacity: null,
    refund_lock_at: null,
  });
  expect(settings.entrant_kind, "premise: the division registers this kind").toBe(rig.kind);
  const seats = Math.min(2, entrantKindCap(rig.kind));
  const { registration } = await seedRegistration(
    rig.competitionId,
    rig.divisionId,
    { fee_cents: 0, currency: "eur", payment_method: "offline" },
    { displayName: name, players: Array.from({ length: seats }, (_, i) => ({ name: `${name} p${i + 1}` })) },
  );
  const confirmed = await confirmRegistration(rig.auth, registration.id);
  expect(confirmed.status, "an automatic arrival is never refused (ruling 250)").toBe("confirmed");
  expect(confirmed.entrant_id, "the confirmation made an entrant").toBeTruthy();
  return confirmed.entrant_id!;
}

async function cellAutomatic(rig: Rig): Promise<void> {
  await pair(rig);
  const before = await rowsOf(rig.swissStageId);
  expect(boardsOf(before, 1).map((f) => f.status), "premise: round 1 paired, nothing started").toEqual(["scheduled", "scheduled"]);
  const tailBefore = await tailRowsOf(rig);
  const arrival = await registerAndConfirm(rig, "Arrival");
  expect(await rowsOf(rig.swissStageId), "an automatic arrival never re-pairs").toEqual(before);
  expect(await tailRowsOf(rig)).toEqual(tailBefore);
  expect(await firstRoundOf(arrival)).toEqual({ kind: rig.kind, swiss_first_round: 2, swiss_first_round_stage_id: rig.swissStageId });
  expect(await lateRows(rig.divisionId)).toEqual([
    { stage_id: rig.swissStageId, entrant_id: arrival, case: "c", round: 2, source: "registration" },
  ]);
  await playRound(rig, 1);
  await assertMissedRoundsScoreZero(rig, arrival, "after the missed round");
  await pair(rig);
  expect(seatedIn(roundOf(await rowsOf(rig.swissStageId), 2)).filter((id) => id === arrival).length, "round 2 seats the arrival once").toBe(1);
  await playRound(rig, 2);
  await assertMissedRoundsScoreZero(rig, arrival, "after round 2");
}

/** The stage rows the client mirror reads (`lib/open-entry-stages.ts`), as the division page passes them. */
async function stageRowsOf(divisionId: string) {
  return sql<{ id: string; kind: string; progression: unknown; config: unknown; status: string }[]>`
    select id, kind, progression, config, status from stages where division_id = ${divisionId} order by seq`;
}

async function divisionStatus(divisionId: string): Promise<string> {
  const [d] = await sql<{ status: string }[]>`select status from divisions where id = ${divisionId}`;
  return d!.status;
}

/** Nothing written by a refused add: no entrant, no ledger row, no fixture moved (the tail's included). */
async function expectRefusedAdd(rig: Rig, code: SwissRefusalCode, canAddRound: boolean): Promise<void> {
  const n = await entrantCount(rig.divisionId);
  const ledger = await ledgerCount(rig.divisionId);
  const swiss = await rowsOf(rig.swissStageId);
  const tail = await tailRowsOf(rig);
  await expect(addLate(rig, "Late " + code)).rejects.toMatchObject({ ...refusal(code), extra: { canAddRound } });
  expect(await entrantCount(rig.divisionId), `${code}: no entrant written`).toBe(n);
  expect(await ledgerCount(rig.divisionId), `${code}: no ledger row`).toBe(ledger);
  expect(await rowsOf(rig.swissStageId), `${code}: the Swiss stands`).toEqual(swiss);
  expect(await tailRowsOf(rig), `${code}: the tail stands`).toEqual(tail);
}

/** The refusals: the last round started (SWISS_NO_ROUND_LEFT, "Add a round" offered), then the Swiss completed through the
 *  real `completeStage` (SWISS_OVER) — and the desk's list lock agrees: closed. */
async function cellRefused(rig: Rig): Promise<void> {
  await pair(rig);
  await startBoard(rig, boardsOf(await rowsOf(rig.swissStageId), 1)[0]!);
  await expectRefusedAdd(rig, "SWISS_NO_ROUND_LEFT", true);
  await playRound(rig, 1);
  const done = await completeStage(rig.auth, rig.swissStageId);
  expect(done.completed, "the one-round Swiss completes").toBe(true);
  await expectRefusedAdd(rig, "SWISS_OVER", false);
  const stages = await stageRowsOf(rig.divisionId);
  const status = await divisionStatus(rig.divisionId);
  expect(entrantListLocked(status, stages), "a finished Swiss locks the list again").toBe(true);
  expect(divisionTakesSwissLateEntry(status, stages), "and offers no late add").toBe(false);
}

const CELL: Record<CaseKey, { n: number; rounds: number; run: (rig: Rig) => Promise<void> }> = {
  a: { n: 4, rounds: 3, run: cellA },
  b: { n: 5, rounds: 3, run: cellB },
  c: { n: 4, rounds: 3, run: cellC },
  automatic: { n: 4, rounds: 3, run: cellAutomatic },
  refused: { n: 4, rounds: 1, run: cellRefused },
};

// ─── The cut ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The templates with a tail fed by the Swiss's cut. */
const CUT_TEMPLATES = SWISS_TEMPLATES.filter(
  (t) => buildTemplateStages(t, { qualified: QUALIFIED, swissRounds: 3, poolCount: 2, legs: 1 }).length > 1,
);

/** The cut rig's Swiss rounds (the template's `swissRounds` knob). Four, so that in `top-seed-first` the latecomer, who
 *  plays three and can lose only to seed 1, ends on at least two wins: with five entrants that is always inside the
 *  top four whatever the tie-breaks, so its seed — and the lower bound under it — is always asserted. */
const CUT_ROUNDS = 4;

/** Who wins a board in the cut rig. `latecomer-first`: the latecomer beats everyone, otherwise the better seed wins.
 *  `top-seed-first` (review round 2): seed 1 beats everyone — the latecomer included — so seed 1 ends on CUT_ROUNDS wins
 *  while the latecomer, who missed a round, holds at most CUT_ROUNDS − 1: a real "more points" set above it. */
const CUT_ORDERS = ["latecomer-first", "top-seed-first"] as const;
type CutOrder = (typeof CUT_ORDERS)[number];

/** Four seeded entrants; round 1 starts, so a late entrant takes (c) and misses round 1 (no bye row in it). The Swiss is
 *  played out in `order`, then completed through the real `completeStage`, which computes the tail's seed proposal. */
async function toTheCut(template: string, kind: Kind, order: CutOrder = "latecomer-first") {
  const rig = await templateRig(template, kind, 4, CUT_ROUNDS);
  await pair(rig);
  await startBoard(rig, boardsOf(await rowsOf(rig.swissStageId), 1)[0]!);
  const late = await addLate(rig, "Late");
  expect(late.late_entry, "premise: the latecomer misses round 1").toMatchObject({ case: "c", round: 2 });
  const seedOf = (id: string) => rig.entrants.indexOf(id) + 1;
  const strength = (id: string) =>
    order === "latecomer-first" ? (id === late.id ? 0 : seedOf(id)) : id === late.id ? 1.5 : seedOf(id);
  const better = (f: Row) => (strength(f.home_entrant_id!) < strength(f.away_entrant_id!) ? f.home_entrant_id! : f.away_entrant_id!);
  for (let r = 1; r <= CUT_ROUNDS; r++) {
    if (r > 1) await pair(rig);
    await playRound(rig, r, better);
  }
  const rows = await rowsOf(rig.swissStageId);
  expect(swissPremise(rows, 1), "premise: round 1, the missed one, seated four and no bye row").toEqual({ seated: 4, byeRows: 0 });
  expect(seatedIn(roundOf(rows, 1)), "premise: the latecomer sat out round 1").not.toContain(late.id);
  const done = await completeStage(rig.auth, rig.swissStageId);
  expect(done.completed, "the Swiss completes").toBe(true);
  expect(done.seed_proposal, "and proposes the tail's seeds").toBeTruthy();
  return { rig, late, rows, proposalId: done.seed_proposal!.id };
}

describe.runIf(HAS_DB)("X-SW-12 matrix: every Swiss template × every entrant kind × case (a)/(b)/(c)", () => {
  it("what is enumerated: the three Swiss templates, every entrant kind on a sport that declares it", () => {
    expect([...SWISS_TEMPLATES].sort(), "re-pinned from format-templates.ts").toEqual(["swiss", "swiss_knockout", "swiss_playoff"]);
    expect([...KINDS].sort(), "V212's entrant kinds").toEqual(["individual", "pair", "team"]);
    for (const k of KINDS) {
      const s = sportOf(k);
      expect(s.module.entrantModel?.kinds ?? ["individual"], `${s.key} declares '${k}'`).toContain(k);
    }
    // Chess is individual-only (owner ruling 2026-10-26): its module declares nothing else, so it carries the individual
    // kind and no other.
    expect(sportOf("individual").module.entrantModel?.kinds).toEqual(["individual"]);
    expect(defaultSwissChess(sportOf("individual").key), "the individual kind is played as chess").toBe(true);
    expect(new Set(KINDS.map((k) => sportOf(k).key)).size, "a sport per kind").toBe(KINDS.length);
    expect(EVERY_DECISION_CASED, "every decision kind but noop has a case").toBe(true);
    expect(new Set(Object.values(DECISION_OF)).size, "four decisions, five cases (automatic is a next_round)").toBe(4);
  });

  const checked = new Set<string>();
  for (const template of SWISS_TEMPLATES) {
    for (const kind of KINDS) {
      for (const c of CASES) {
        it(`${template} × ${kind} (${sportOf(kind).key}) × (${c})`, async () => {
          const cell = CELL[c];
          const rig = await templateRig(template, kind, cell.n, cell.rounds);
          await cell.run(rig);
          checked.add(`${template}|${kind}|${c}`);
        }, 120_000);
      }
    }
  }

  // Runs after every cell (a file's tests run in order). A `-t` slice that skips cells reds it: a partial sweep is not a
  // sweep.
  it("anti-vacuity: every cell enumerated was checked (templates × kinds × cases), and zero is a failure", () => {
    expect(checked.size, "cells checked").toBeGreaterThan(0);
    expect(checked.size, "cells checked = templates × kinds × cases").toBe(SWISS_TEMPLATES.length * KINDS.length * CASES.length);
    expect(SWISS_TEMPLATES.length * KINDS.length * CASES.length, "3 × 3 × 5").toBe(45);
  });
});

describe.runIf(HAS_DB)("X-SW-12 the cut carries a latecomer correctly", () => {
  it("the tail templates are the two Swiss composites", () => {
    expect([...CUT_TEMPLATES].sort()).toEqual(["swiss_knockout", "swiss_playoff"]);
  });

  const cut = new Set<string>();
  /** Templates that seeded a latecomer with a real "more points" set above it (review round 2: the lower bound bites). */
  const moreAbove = new Set<string>();
  for (const template of CUT_TEMPLATES) {
    for (const kind of KINDS) {
      for (const order of CUT_ORDERS) {
        it(`X-SW-12 the cut carries a latecomer correctly: ${template} × ${kind} (${sportOf(kind).key}), ${order}`, async () => {
          const { rig, late, rows, proposalId } = await toTheCut(template, kind, order);
          // 0 for the missed round (ruling 251): the latecomer's rows hold rounds 2 and 3 and nothing for round 1.
          const facts = recordOnRows(rows, late.id);
          expect(facts.won + facts.lost, "premise: the latecomer played every round but the missed one").toBe(CUT_ROUNDS - 1);
          if (order === "latecomer-first") expect(facts.won, "premise: won every round played").toBe(CUT_ROUNDS - 1);
          // The witness (review m2): the Pair's history — the place a missed round could be credited as a bye — holds
          // only what was won (in latecomer-first, CUT_ROUNDS − 1, where a bye-credit would add one). The stored fold has no
          // implicit-bye path; its record and points below are structural guards.
          const hist = await historyOf(rig);
          expect(hist.score.get(late.id) ?? 0, "the Pair scores the missed round 0").toBe(facts.won);
          expect(hist.byes.has(late.id), "bye-ineligible only for a real bye row, never for the missed round").toBe(facts.byes > 0);
          const table = await storedTable(rig.swissStageId);
          const row = table.find((r) => r.entrantId === late.id);
          expect(row, "the stored table lists the latecomer").toBeDefined();
          expect({ played: row!.played, won: row!.won, lost: row!.lost, drawn: row!.drawn }, "the stored table: the rounds played").toEqual({
            played: CUT_ROUNDS - 1,
            won: facts.won,
            lost: facts.lost,
            drawn: 0,
          });

          // Review I1 + round 2 — the rank oracle, independent of the stored table (stage-seeding reads that same
          // snapshot, so it cannot judge it). Points are every Swiss table's first criterion; each entrant's points are
          // the sport's DECLARED rule over its fixture rows, a missed round paying 0. Every stored row must carry exactly
          // those points, the stored order must never rise in them, and the latecomer's seed must sit below everyone
          // with more and above everyone with fewer.
          const pay = declaredPay(rig);
          const field = [...rig.entrants, late.id];
          const pointsOf = new Map(field.map((id) => [id, pointsOnRows(rows, id, pay)]));
          expect(new Set(table.map((r) => r.entrantId)), "the stored table is the field").toEqual(new Set(field));
          expect(await assertStoredPoints(rig, "at the cut"), "anti-vacuity: every stored row's points checked").toBe(field.length);
          let ordered = 0;
          for (let i = 1; i < table.length; i++) {
            const [hi, lo] = [table[i - 1]!.entrantId, table[i]!.entrantId];
            expect(pointsOf.get(hi)!, `stored place ${i} has at least place ${i + 1}'s points`).toBeGreaterThanOrEqual(pointsOf.get(lo)!);
            ordered++;
          }
          expect(ordered, "anti-vacuity: every neighbouring pair of the field").toBe(field.length - 1);
          const latePoints = pointsOf.get(late.id)!;
          const above = field.filter((id) => pointsOf.get(id)! > latePoints).length;
          const level = field.filter((id) => pointsOf.get(id)! === latePoints).length;
          if (order === "top-seed-first") {
            // Seed 1 won every board (round 1's included); the latecomer cannot have played that many.
            expect(pointsOf.get(rig.entrants[0]!), "premise: seed 1 took every round").toBe(CUT_ROUNDS * pay.win);
            expect(above, "a real set with more points than the latecomer").toBeGreaterThanOrEqual(1);
          }
          expect(above + level, "premise: the latecomer qualifies whatever the tie-breaks").toBeLessThanOrEqual(QUALIFIED);

          const [proposal] = await sql<{ computed: { qualifiers: { rank: number; source: { rank: number }; entrantId: string; destinationSlot: string }[]; ties: { slots: string[]; entrantIds: string[] }[] } }[]>`
            select computed from stage_seed_proposals where id = ${proposalId}`;
          expect(proposal!.computed.qualifiers.length, "anti-vacuity: the cut took four").toBe(QUALIFIED);
          const mine = proposal!.computed.qualifiers.find((q) => q.entrantId === late.id);
          // FIDE C.07 16.2.3 (VUR — a missed round counts as a zero-point unplayed round in the tie-breaks) is NOT
          // asserted: engine 1.1.0 does not implement it (an Engine PR 2.0.0 row), so the chess cells' order inside a
          // points group is the engine's non-VUR tie-break. App-B carry: assert it against VUR here once the engine 2.0.0
          // snapshot is installed.
          expect(mine, "the proposal seats the latecomer").toBeDefined();
          const seed = mine!.rank;
          expect(seed, "no entrant with more points is seeded below the latecomer").toBeGreaterThanOrEqual(above + 1);
          expect(seed, "no entrant with fewer points is seeded above the latecomer").toBeLessThanOrEqual(above + level);
          if (above > 0) moreAbove.add(template);
          // The hand-off stays faithful: the stored place, the stored rank and the proposal's source rank are that seed.
          const position = table.findIndex((r) => r.entrantId === late.id) + 1;
          expect({ position, rank: row!.rank, sourceRank: mine!.source.rank }, "the cut carries the stored place").toEqual({
            position: seed,
            rank: seed,
            sourceRank: seed,
          });
          // The day-one bracket's seed labels, read BEFORE the fill (a filled slot carries the entrant, not the label).
          const labels = new Map<string, number | undefined>();
          for (const f of await sql<{ id: string; home_slot_label: { seed?: number } | null; away_slot_label: { seed?: number } | null }[]>`
            select id, home_slot_label, away_slot_label from fixtures where stage_id = ${rig.tailStageId!}`) {
            labels.set(`${f.id}:home`, f.home_slot_label?.seed);
            labels.set(`${f.id}:away`, f.away_slot_label?.seed);
          }
          // Confirm, resolving any flagged tie as the engine computed it (each slot keeps its computed qualifier).
          const bySlot = new Map(proposal!.computed.qualifiers.map((q) => [q.destinationSlot, q.entrantId]));
          await confirmSeedProposal(rig.auth, rig.tailStageId!, {
            proposalId,
            tiePicks: proposal!.computed.ties.map((t) => ({ slots: t.slots, order: t.slots.map((s) => bySlot.get(s)!) })),
          });
          // The bracket seats the latecomer on a slot the template's seeding labelled with that seed.
          const seats = await sql<{ id: string; home_entrant_id: string | null; away_entrant_id: string | null }[]>`
            select id, home_entrant_id, away_entrant_id from fixtures where stage_id = ${rig.tailStageId!}`;
          const seededAt = seats.flatMap((f) => [
            ...(f.home_entrant_id === late.id ? [labels.get(`${f.id}:home`)] : []),
            ...(f.away_entrant_id === late.id ? [labels.get(`${f.id}:away`)] : []),
          ]);
          expect(seededAt.length, "the latecomer holds a seat in the tail").toBeGreaterThan(0);
          expect(new Set(seededAt), "every seat they hold was labelled with their seed").toEqual(new Set([seed]));
          cut.add(`${template}|${kind}|${order}`);
        }, 180_000);
      }
    }
  }

  it("anti-vacuity: every tail template × kind × order was carried through the cut", () => {
    expect(cut.size).toBeGreaterThan(0);
    expect(cut.size).toBe(CUT_TEMPLATES.length * KINDS.length * CUT_ORDERS.length);
    expect([...moreAbove].sort(), "every tail template seeded a latecomer with entrants above it on points").toEqual([...CUT_TEMPLATES].sort());
  });
});

describe.runIf(HAS_DB)("X-SW-12 the playoff/knockout stage refuses a late entry", () => {
  const refused = new Set<string>();
  for (const template of CUT_TEMPLATES) {
    for (const kind of KINDS) {
      it(`X-SW-12 the playoff/knockout stage refuses a late entry: ${template} × ${kind} (${sportOf(kind).key})`, async () => {
        const { rig, proposalId } = await toTheCut(template, kind);
        const [proposal] = await sql<{ computed: { qualifiers: { destinationSlot: string; entrantId: string }[]; ties: { slots: string[] }[] } }[]>`
          select computed from stage_seed_proposals where id = ${proposalId}`;
        const bySlot = new Map(proposal!.computed.qualifiers.map((q) => [q.destinationSlot, q.entrantId]));
        await confirmSeedProposal(rig.auth, rig.tailStageId!, {
          proposalId,
          tiePicks: proposal!.computed.ties.map((t) => ({ slots: t.slots, order: t.slots.map((s) => bySlot.get(s)!) })),
        });
        // The list, as the desk reads it: the Swiss is over, the tail is running — locked, no late add offered.
        const stages = await stageRowsOf(rig.divisionId);
        const status = await divisionStatus(rig.divisionId);
        expect(status, "premise: the division plays on in its tail").toBe("active");
        expect(stages.map((s) => isRunningRootSwiss(s)), "no stage is a running root Swiss").toEqual(stages.map(() => false));
        expect(stages.length, "anti-vacuity: both stages read").toBe(2);
        expect(entrantListLocked(status, stages), "the list is locked").toBe(true);
        expect(divisionTakesSwissLateEntry(status, stages)).toBe(false);
        // The server refuses by name — before the tail starts, and once it has.
        await expectRefusedAdd(rig, "SWISS_OVER", false);
        const seated = (await tailRowsOf(rig)).find((f) => f.home_entrant_id !== null && f.away_entrant_id !== null && f.status === "scheduled");
        expect(seated, "premise: the tail has a seated match").toBeDefined();
        await startBoard(rig, seated!);
        await expectRefusedAdd(rig, "SWISS_OVER", false);

        // Review m7 / ruling 250 — an AUTOMATIC arrival is never refused: a registration confirmed while the tail runs is
        // accepted and recorded as joining after the last round (the Swiss's declared rounds + 1); the playoff/knockout
        // never seats it — its field is the cut — and the Swiss does not move.
        const swissBefore = await rowsOf(rig.swissStageId);
        const tailBefore = await tailRowsOf(rig);
        const arrival = await registerAndConfirm(rig, "Tail arrival");
        expect(await firstRoundOf(arrival)).toEqual({ kind, swiss_first_round: CUT_ROUNDS + 1, swiss_first_round_stage_id: rig.swissStageId });
        expect((await lateRows(rig.divisionId)).at(-1), "recorded as joining after the last round").toEqual({
          stage_id: rig.swissStageId,
          entrant_id: arrival,
          case: "c",
          round: CUT_ROUNDS + 1,
          source: "registration",
        });
        expect(await rowsOf(rig.swissStageId), "the Swiss stands").toEqual(swissBefore);
        const tailAfter = await tailRowsOf(rig);
        expect(tailAfter, "the tail stands").toEqual(tailBefore);
        expect(seatedIn(tailAfter), "never seated in the playoff/knockout").not.toContain(arrival);
        expect(seatedIn(tailAfter).length, "anti-vacuity: the tail seats its qualifiers").toBeGreaterThan(0);
        refused.add(`${template}|${kind}`);
      }, 180_000);
    }
  }

  it("anti-vacuity: every tail template × kind was refused", () => {
    expect(refused.size).toBeGreaterThan(0);
    expect(refused.size).toBe(CUT_TEMPLATES.length * KINDS.length);
  });
});
