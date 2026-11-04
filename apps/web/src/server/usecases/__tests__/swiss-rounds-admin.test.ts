// W3 Task 12 (SW-M10, #838, RB3-5; rules X-SW-17 and BG-SW-1) on Postgres — a Swiss stage's round count stays editable
// until the first fixture of the stage STARTS (`patchSwissStage`); after that the organiser has "Add a round"
// (`addSwissRound`) and Finish (Task 13). Spec 2026-10-31-format-matrix-w3-swiss-design.md §8 Q2 ("Rounds editable until
// the first fixture starts … per stage, then Finish/Add a round only"), ruling 250 ("Add a round" while running, "This
// Swiss is over" after) and rulebook-W3-swiss.md §3.1/§3.2 for the bounds.
//
// "Started" is T9's ONE predicate (`swissBoardStartedSql`): a result or any evidence (`fixtureHasResultSql`), an online
// game's bridge row, a Match Day call that still holds (ruling 257), or a decided board that is not the bye. A bye alone
// is not a start (Task 3), and a device link is not one (T9 re-ruling I1). Expected values are the rulebook's numbers typed here — hard max n − 1 for an even field, n
// for an odd one; safe max ⌊n/2⌋ (§3.2's table) — and the shell counts are ⌊n/2⌋ boards plus a bye for an odd n, never
// read off the code under test. Every refused write is checked against the rows and the ledger as they stood before it.
//
// Sports: the edit itself is swept over every sport the registry offers a Swiss. The sequences run for badminton (the
// house racket sport) and boardgame (chess: the one sport whose Pair differs, and the one the colour toggle is for).
// Single-sport cases carry their reason inline.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { builtinModules } from "@seazn/engine/sports";
import { entrantKindCap } from "@seazn/engine/sport";
import { templatesForSport } from "@/lib/format-templates";
import { SWISS_REFUSALS, type SwissRefusalCode } from "@/lib/swiss-refusals";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { undoDivision } from "../history";
import { LIVE_CALL_ALIASES, callFixtureToCourt, undoCall } from "../match-day-call";
import { confirmRegistration } from "../registrations";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { completeStage, createStages, generateStageFixtures, replaceStages, unpairSwissRound } from "../stages";
import { addSwissRound, listSwissRoundControls, patchSwissStage, swissBoardStartedSql } from "../swiss-rounds-admin";
import { createCourt, createVenue, deleteCourt } from "../venues";
import { withdrawEntrantCascade } from "../withdrawal";
import { seedRegistration } from "./_registration-fixtures";
import { seedOrg } from "./_seed";
import { engineEntrantKinds } from "@/lib/__tests__/_engine-entrant-kinds";

const HAS_DB = !!process.env.DATABASE_URL;

// A RECORDING passthrough on `afterScheduleWrite` (the pattern competition-schedule-apply.test.ts uses): the real invalidation
// still runs, and each call's division and fixture ids are kept, so a test can say which fixtures a write named for the
// public-document cache (`pub:v1:fixture:{id}`).
const sched = vi.hoisted(() => ({ named: [] as { divisionId: string; fixtureIds: string[] }[] }));
vi.mock("../schedule", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../schedule")>();
  return {
    ...actual,
    afterScheduleWrite: (divisionId: string, competitionId: string, reason: "schedule" | "publish" | "start", fixtureIds: readonly string[]) => {
      sched.named.push({ divisionId, fixtureIds: [...fixtureIds] });
      return actual.afterScheduleWrite(divisionId, competitionId, reason, fixtureIds);
    },
  };
});

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

const SPORTS = [
  { sport: "badminton", variant: "bwf" },
  { sport: "boardgame", variant: "classical" },
] as const;
type Sport = { sport: string; variant: string };
type Kind = "individual" | "pair" | "team";

/** The HTTP status each refusal this file meets was RULED to answer — typed here from the brief and the controller's
 *  status rule ("422 when the request can never succeed as sent, 409 when it is resolvable another way"), never read
 *  off `SWISS_REFUSALS`, the table under test (Fix round 1, review m6). */
const RULED_STATUS = {
  STAGE_NOT_SWISS: 422, // never succeeds on that stage
  SWISS_CHESS_LOCKED: 422, // Phase 2 ruling: the colours' own code, 422
  SWISS_CHESS_ALWAYS_ON: 422, // UI5 item 4 (owner 2026-11-03): a chess Swiss always balances colours - never succeeds as sent
  SWISS_NO_ROUND_LEFT: 409, // T10: resolvable by Add a round
  SWISS_OVER: 422, // T12 brief: the Swiss is over, nothing resolves it
  SWISS_ROUNDS_BELOW_SEATED: 409, // T12 ruling: Unpair resolves it
  SWISS_ROUNDS_CHANGE_NOT_UNDOABLE: 422, // controller 2026-11-01: a barrier is a permanent ledger row
  SWISS_ROUNDS_LOCKED: 409, // T12 ruling: Finish now / Add a round resolve it
} as const satisfies Partial<Record<SwissRefusalCode, 409 | 422>>;
const refusal = (code: keyof typeof RULED_STATUS) => ({ status: RULED_STATUS[code], code });

/** Rulebook §3.1 "Bounds": hard max n − 1 for an even field, n for an odd one. Typed here, never read off the code. */
const HARD_MAX = (n: number) => (n % 2 === 0 ? n - 1 : n);

interface Rig {
  sport: Sport;
  auth: AuthCtx;
  competitionId: string;
  divisionId: string;
  stageId: string;
  kind: Kind;
  /** Entrant ids by seed, P1..Pn. */
  entrants: string[];
}

/** A roster entry of the kind's own shape: one inline person per seat, at most two (`entrantKindCap`). */
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

/** N seeded entrants of the sport's own default kind and a Swiss of `rounds` — NOT started, nothing generated. */
async function swissRig(sport: Sport, n: number, rounds: number, auth?: AuthCtx): Promise<Rig> {
  const owner = auth ?? (await seedOrg("pro")).auth;
  const comp = await createCompetition(owner, {
    ends_on: "2030-12-31",
    name: "Rounds edit " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(owner, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: sport.sport,
    variant_key: sport.variant,
    config: {},
  });
  const sportModule = builtinModules.find((m) => m.key === sport.sport)!;
  const kind = (sportModule.entrantModel?.defaultKind ?? "individual") as Kind;
  const made = await createEntrants(owner, division.id, Array.from({ length: n }, (_, i) => entrantInput(kind, `P${i + 1}`, i + 1)));
  const [stage] = await createStages(owner, division.id, { seq: 1, kind: "swiss", name: "Swiss", config: { rounds }, progression: null });
  return { sport, auth: owner, competitionId: comp.id, divisionId: division.id, stageId: stage!.id, kind, entrants: made.map((e) => e.id) };
}

interface Row {
  id: string;
  ext_key: string | null;
  round_no: number;
  seq_in_round: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
  scheduled_at: Date | null;
  court_id: string | null;
}

const rowsOf = (stageId: string) =>
  sql<Row[]>`
    select id, ext_key, round_no, seq_in_round, home_entrant_id, away_entrant_id, status, scheduled_at, court_id
    from fixtures where stage_id = ${stageId} order by round_no, seq_in_round`;
const isBye = (f: Row) => /^sw-r\d+-bye$/.test(f.ext_key ?? "");
const roundOf = (rows: readonly Row[], r: number) => rows.filter((f) => f.round_no === r);
const boardsOf = (rows: readonly Row[], r: number) => roundOf(rows, r).filter((f) => !isBye(f));
const roundsIn = (rows: readonly Row[]) => [...new Set(rows.map((f) => f.round_no))].sort((a, b) => a - b);
const keysOf = (rows: readonly Row[], r: number) => roundOf(rows, r).map((f) => f.ext_key);
const seatedIn = (rows: readonly Row[]) => rows.flatMap((f) => [f.home_entrant_id, f.away_entrant_id]).filter((x): x is string => x !== null);

async function storedConfig(stageId: string): Promise<Record<string, unknown>> {
  const [s] = await sql<{ config: Record<string, unknown> }[]>`select config from stages where id = ${stageId}`;
  return s!.config;
}

/** The ledger's length and the division's own token and watermark: what a refused write must leave alone, and what a
 *  barrier row must move (the token) and must NOT move (the watermark — T5 carry). */
async function ledgerState(divisionId: string) {
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from division_events where division_id = ${divisionId}`;
  const [d] = await sql<{ seq: string | number; edit_watermark: string | number | null }[]>`
    select seq, edit_watermark from divisions where id = ${divisionId}`;
  return { events: n, seq: Number(d!.seq), watermark: d!.edit_watermark === null ? null : Number(d!.edit_watermark) };
}

async function roundsRows(divisionId: string) {
  return sql<{ seq: number; payload: Record<string, unknown>; actor_id: string | null }[]>`
    select seq::int as seq, payload, actor_id from division_events
    where division_id = ${divisionId} and type = 'swiss_rounds_changed' order by seq`;
}

/** The scorer's first event: the board has started. */
async function startBoard(rig: Rig, f: Row): Promise<void> {
  await scoreEvent(rig.auth, f.id, { expected_seq: 0, type: "core.start", payload: {} });
}

/** The scorer's quick result: the home side wins, through real scoring events. */
async function homeWins(rig: Rig, f: Row): Promise<void> {
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${f.id}`;
  let seq = n;
  if (seq === 0) await scoreEvent(rig.auth, f.id, { expected_seq: seq++, type: "core.start", payload: {} });
  if (rig.sport.sport === "boardgame") {
    await scoreEvent(rig.auth, f.id, { expected_seq: seq, type: "boardgame.result", payload: { winner: f.home_entrant_id, method: "resign" } });
  } else {
    await scoreEvent(rig.auth, f.id, { expected_seq: seq++, type: "badminton.game.summary", payload: { home: 21, away: 10 } });
    await scoreEvent(rig.auth, f.id, { expected_seq: seq, type: "badminton.game.summary", payload: { home: 21, away: 12 } });
  }
}

async function playRound(rig: Rig, r: number): Promise<void> {
  const boards = boardsOf(await rowsOf(rig.stageId), r).filter((f) => f.status !== "decided");
  expect(boards.length, `rig: round ${r} has boards to play`).toBeGreaterThan(0);
  for (const f of boards) await homeWins(rig, f);
  const after = boardsOf(await rowsOf(rig.stageId), r);
  expect(after.map((f) => f.status), `rig: round ${r} is decided`).toEqual(after.map(() => "decided"));
}

const pair = (rig: Rig) => generateStageFixtures(rig.auth, rig.stageId);

/** An automatic arrival: a free, offline registration confirmed through the real `confirmRegistration` → `materialise`
 *  (T9's `confirmArrival`, swiss-late-arrival.test.ts). */
async function registerAndConfirm(rig: Rig, name: string): Promise<string> {
  const { registration } = await seedRegistration(
    rig.competitionId,
    rig.divisionId,
    { fee_cents: 0, currency: "eur", payment_method: "offline" },
    { displayName: name },
  );
  const confirmed = await confirmRegistration(rig.auth, registration.id);
  expect(confirmed.entrant_id, `rig: ${name}'s confirmation made an entrant`).toBeTruthy();
  return confirmed.entrant_id!;
}

// ---------------------------------------------------------------------------------------------------------------------
// The edit before any start (#838's regression: the Format tab's Apply answered FORMAT_LOCKED once shells exist; since FMT5 it
// asks to clear them instead, FORMAT_CHANGE_CONFIRM)
// ---------------------------------------------------------------------------------------------------------------------

describe.runIf(HAS_DB)("X-SW-17 the round count is editable until the first fixture starts", () => {
  it("X-SW-17 rounds edit after shells exist and before any start: 5 → 3 deletes rounds 4–5 shells; 3 → 4 mints round 4 (every sport offering a Swiss)", async () => {
    const { auth } = await seedOrg("pro");
    const offered = builtinModules.filter((m) => templatesForSport(m.key, engineEntrantKinds(m.key)).some((t) => t.key === "swiss"));
    expect(offered.length, "premise: the registry offers a Swiss").toBeGreaterThan(1);
    let checked = 0;
    for (const m of offered) {
      const variant = Object.keys(m.variants)[0]!;
      // A field of 6: §3.2's table gives 3 recommended, safe max 3, hard max 5 — so 5 rounds is allowed (warn).
      const rig = await swissRig({ sport: m.key, variant }, 6, 5, auth);
      await pair(rig); // the mint: 5 rounds × 3 boards
      const minted = await rowsOf(rig.stageId);
      expect(roundsIn(minted), `${m.key}: premise, 5 rounds of shells`).toEqual([1, 2, 3, 4, 5]);
      // #838's premise, on this very stage: replacing the stage graph is the old way to change the count. Since FMT5 it no
      // longer refuses outright: it would CLEAR every shell (and asks for that confirm, FORMAT_CHANGE_CONFIRM, writing
      // nothing). The rounds edit below is the way that keeps rounds 1–3.
      await expect(
        replaceStages(rig.auth, rig.divisionId, [{ seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 3 }, progression: null }]),
        `${m.key}: premise — replacing the stages asks to clear the shells`,
      ).rejects.toMatchObject({ status: 409, code: "FORMAT_CHANGE_CONFIRM" });
      expect(await rowsOf(rig.stageId), `${m.key}: the unconfirmed replace moved nothing`).toEqual(minted);
      const ledger0 = await ledgerState(rig.divisionId);

      // 5 → 3: rounds 4 and 5 go (3 boards each, a field of 6 has no bye); rounds 1–3 keep every row, id and key.
      const down = await patchSwissStage(rig.auth, rig.stageId, { rounds: 3 });
      expect(down, `${m.key}: 5 → 3`).toMatchObject({
        rounds: 3,
        swiss_rounds: { verdict: "ok", recommended: 3, safeMax: 3, hardMax: 5 },
        shells: { added: 0, removed: 6, slots_freed: 0 },
      });
      const afterDown = await rowsOf(rig.stageId);
      expect(roundsIn(afterDown), `${m.key}: rounds 4–5 deleted`).toEqual([1, 2, 3]);
      expect(afterDown, `${m.key}: rounds 1–3 untouched`).toEqual(minted.filter((f) => f.round_no <= 3));
      expect((await storedConfig(rig.stageId)).rounds, `${m.key}: stored`).toBe(3);

      // 3 → 4: round 4 minted for the field (3 boards, unseated), the next key past nothing in that round.
      const up = await patchSwissStage(rig.auth, rig.stageId, { rounds: 4 });
      expect(up, `${m.key}: 3 → 4`).toMatchObject({
        rounds: 4,
        swiss_rounds: { verdict: "warn", recommended: 3, safeMax: 3, hardMax: 5 },
        shells: { added: 3, removed: 0, slots_freed: 0 },
      });
      const afterUp = await rowsOf(rig.stageId);
      expect(keysOf(afterUp, 4), `${m.key}: round 4's shells`).toEqual(["sw-r4-b1", "sw-r4-b2", "sw-r4-b3"]);
      expect(roundOf(afterUp, 4).map((f) => [f.seq_in_round, f.status, f.home_entrant_id, f.away_entrant_id])).toEqual([
        [1, "scheduled", null, null],
        [2, "scheduled", null, null],
        [3, "scheduled", null, null],
      ]);
      expect(afterUp.filter((f) => f.round_no <= 3), `${m.key}: rounds 1–3 still untouched`).toEqual(afterDown);

      // Each change is one barrier row (design §10.8), the organiser's, the division's token moved and the watermark not.
      const rows = await roundsRows(rig.divisionId);
      expect(rows.map((r) => r.payload), `${m.key}: two barrier rows`).toEqual([
        { stage_id: rig.stageId, from: 5, to: 3, via: "edit", source: "organiser" },
        { stage_id: rig.stageId, from: 3, to: 4, via: "edit", source: "organiser" },
      ]);
      expect(rows.every((r) => r.actor_id === rig.auth.userId), `${m.key}: the organiser is the actor`).toBe(true);
      const ledger1 = await ledgerState(rig.divisionId);
      expect(ledger1, `${m.key}: two rows, token moved, watermark untouched`).toEqual({
        events: ledger0.events + 2,
        seq: ledger0.seq + 2,
        watermark: ledger0.watermark,
      });

      // The SEQUENCE: the same count again is a no-op — no shells, no barrier row.
      const again = await patchSwissStage(rig.auth, rig.stageId, { rounds: 4 });
      expect(again.shells, `${m.key}: a second call with the same count`).toEqual({ added: 0, removed: 0, slots_freed: 0 });
      expect(await rowsOf(rig.stageId)).toEqual(afterUp);
      expect(await ledgerState(rig.divisionId), `${m.key}: no row for a no-op`).toEqual(ledger1);
      checked++;
    }
    expect(checked, "anti-vacuity: every Swiss-offering sport edited").toBe(offered.length);
  }, 300_000);

  for (const s of SPORTS) {
    it(`X-SW-17 an odd field: round 4 is minted with its bye; a laid-out deleted board is reported freed (${s.sport})`, async () => {
      const rig = await swissRig(s, 5, 5);
      await pair(rig);
      // The organiser laid out one round-5 board (a time is a slot, `holdsSlot`), and nothing else.
      const laid = boardsOf(await rowsOf(rig.stageId), 5)[0]!;
      await sql`update fixtures set scheduled_at = '2030-06-01T10:00:00Z' where id = ${laid.id}`;
      const down = await patchSwissStage(rig.auth, rig.stageId, { rounds: 3 });
      // Two rounds of a field of 5: 2 boards + 1 bye each = 6 rows; one laid-out board's slot is reported, never dropped.
      expect(down.shells).toEqual({ added: 0, removed: 6, slots_freed: 1 });
      const up = await patchSwissStage(rig.auth, rig.stageId, { rounds: 4 });
      expect(up.shells).toEqual({ added: 3, removed: 0, slots_freed: 0 });
      expect(keysOf(await rowsOf(rig.stageId), 4)).toEqual(["sw-r4-b1", "sw-r4-b2", "sw-r4-bye"]);
    });

    it(`X-SW-17 before any Generate the edit only stores the count — no shells (${s.sport})`, async () => {
      // The empty case: no fixtures at all. Generate mints the stored count later.
      const rig = await swissRig(s, 6, 5);
      const out = await patchSwissStage(rig.auth, rig.stageId, { rounds: 3 });
      expect(out).toMatchObject({ rounds: 3, shells: { added: 0, removed: 0, slots_freed: 0 } });
      expect(await rowsOf(rig.stageId)).toEqual([]);
      // Fix round 1 (review I2 MB): a RAISE before Generate stores the count too — no round 4 shell with no rounds 1-3.
      const raised = await patchSwissStage(rig.auth, rig.stageId, { rounds: 4 });
      expect(raised).toMatchObject({ rounds: 4, shells: { added: 0, removed: 0, slots_freed: 0 } });
      expect(await rowsOf(rig.stageId), "nothing minted before Generate").toEqual([]);
      expect((await storedConfig(rig.stageId)).rounds).toBe(4);
      await pair(rig);
      expect(roundsIn(await rowsOf(rig.stageId)), "Generate mints the stored count").toEqual([1, 2, 3, 4]);
    });

    it(`X-SW-17 a bye alone does not lock rounds (${s.sport})`, async () => {
      // Task 3: a bye is settled at Pair (status forfeited, its cfg frozen) but nobody played it. Spec §8 Q2: the count
      // locks at the first fixture that STARTS.
      const rig = await swissRig(s, 5, 3);
      await startDivision(rig.auth, rig.divisionId);
      await pair(rig); // round 1: 2 boards and the bye, awarded at once
      const r1 = roundOf(await rowsOf(rig.stageId), 1);
      expect(r1.filter(isBye).map((f) => f.status), "premise: the bye is awarded").toEqual(["forfeited"]);
      const out = await patchSwissStage(rig.auth, rig.stageId, { rounds: 2 });
      expect(out).toMatchObject({ rounds: 2, shells: { removed: 3 } });
      // The positive pair: one core.start, and the count is fixed.
      await startBoard(rig, boardsOf(await rowsOf(rig.stageId), 1)[0]!);
      await expect(patchSwissStage(rig.auth, rig.stageId, { rounds: 3 })).rejects.toMatchObject(refusal("SWISS_ROUNDS_LOCKED"));
    });

    it(`X-SW-17 after the first core.start: SWISS_ROUNDS_LOCKED with canFinish and canAddRound (${s.sport})`, async () => {
      // A field of 5 (hard max 5) on 3 rounds: a 4th can be added. Nothing is finished until a round is decided (Task 13's
      // k = the latest round whose seated boards are all decided; k = 0 → nothing to finish).
      const rig = await swissRig(s, 5, 3);
      await startDivision(rig.auth, rig.divisionId);
      await pair(rig);
      await startBoard(rig, boardsOf(await rowsOf(rig.stageId), 1)[0]!);
      const rows = await rowsOf(rig.stageId);
      const ledger = await ledgerState(rig.divisionId);
      const config = await storedConfig(rig.stageId);
      await expect(patchSwissStage(rig.auth, rig.stageId, { rounds: 2 })).rejects.toMatchObject({
        ...refusal("SWISS_ROUNDS_LOCKED"),
        extra: { canFinish: false, canAddRound: true },
      });
      expect(await rowsOf(rig.stageId), "nothing written").toEqual(rows);
      expect(await ledgerState(rig.divisionId)).toEqual(ledger);
      expect(await storedConfig(rig.stageId)).toEqual(config);
      // The chess colours are fixed with it — refused with their OWN code (controller ruling, Phase 2: never the rounds
      // sentence, which offers recoveries a colour change has not).
      await expect(patchSwissStage(rig.auth, rig.stageId, { chess: true })).rejects.toMatchObject(refusal("SWISS_CHESS_LOCKED"));
      // UI5 item 4 (owner 2026-11-03): on chess (the boardgame key, the rulebook's chess sport) switching the colours OFF is
      // refused whether or not play has started — that answer comes first, and a body naming the count as well is the same
      // refusal. Another sport keeps the start lock's answers.
      const chess = s.sport === "boardgame";
      await expect(patchSwissStage(rig.auth, rig.stageId, { chess: false })).rejects.toMatchObject(
        refusal(chess ? "SWISS_CHESS_ALWAYS_ON" : "SWISS_CHESS_LOCKED"),
      );
      await expect(patchSwissStage(rig.auth, rig.stageId, { rounds: 4, chess: false })).rejects.toMatchObject(
        chess ? refusal("SWISS_CHESS_ALWAYS_ON") : { ...refusal("SWISS_ROUNDS_LOCKED"), extra: { canFinish: false, canAddRound: true } },
      );
      expect(await rowsOf(rig.stageId), "nothing written by the colour refusals").toEqual(rows);
      expect(await ledgerState(rig.divisionId)).toEqual(ledger);
      expect(await storedConfig(rig.stageId)).toEqual(config);

      // The SEQUENCE: round 1 decided → the Swiss can be finished after it.
      await playRound(rig, 1);
      await expect(patchSwissStage(rig.auth, rig.stageId, { rounds: 4 })).rejects.toMatchObject({
        ...refusal("SWISS_ROUNDS_LOCKED"),
        extra: { canFinish: true, canAddRound: true },
      });
      // Complete: over — the count can never move again, so 422 SWISS_OVER (batch-4 ruling m1), as Add a round and Finish
      // answer — not the 409 LOCKED, whose status says another way resolves it. Neither recovery is offered.
      await pair(rig);
      await playRound(rig, 2);
      await pair(rig);
      await playRound(rig, 3);
      await completeStage(rig.auth, rig.stageId);
      await expect(patchSwissStage(rig.auth, rig.stageId, { rounds: 4 })).rejects.toMatchObject({
        ...refusal("SWISS_OVER"),
        extra: { canFinish: false, canAddRound: false },
      });
    }, 120_000);

    it(`X-SW-17 an online game on a board locks rounds (${s.sport})`, async () => {
      // T9's predicate, Review Focus 1: a board an online game stands behind has started, scored or not.
      const rig = await swissRig(s, 4, 3);
      await startDivision(rig.auth, rig.divisionId);
      await pair(rig);
      const board = boardsOf(await rowsOf(rig.stageId), 1)[0]!;
      await sql`
        insert into fixture_external_play (fixture_id, org_id, scheduled_at_basis, status, challenge_id)
        values (${board.id}, ${rig.auth.orgId}, now(), 'ready', ${"gm-" + randomUUID().slice(0, 8)})`;
      await expect(patchSwissStage(rig.auth, rig.stageId, { rounds: 2 })).rejects.toMatchObject(refusal("SWISS_ROUNDS_LOCKED"));
    });

    it(`ruling 257 a Match Day call on a board locks rounds; Undo call unlocks them (${s.sport})`, async () => {
      // Owner ruling 257 (2026-11-02): a call is a start, read through THE predicate — so the rounds lock, which reads it
      // too, holds the count the moment a board is called, though nothing was scored. Only a LIVE call (liveCallSql): the
      // positive pair is the same stage after Undo call.
      const rig = await swissRig(s, 4, 3);
      await startDivision(rig.auth, rig.divisionId);
      await pair(rig);
      const venue = await createVenue(rig.auth, { name: "Hall " + randomUUID().slice(0, 4), sort: 0 });
      const court = await createCourt(rig.auth, venue.id, { name: "Court 1", sort: 0, tags: [] });
      const board = boardsOf(await rowsOf(rig.stageId), 1)[0]!;
      expect((await listSwissRoundControls(rig.auth, rig.divisionId))[rig.stageId]!.started, "premise: nothing started yet").toBe(false);

      await callFixtureToCourt(rig.auth, board.id, court.id);
      const rows = await rowsOf(rig.stageId);
      expect(rows.find((f) => f.id === board.id)!.status, "premise: the call wrote no status").toBe("scheduled");
      const ledger = await ledgerState(rig.divisionId);
      const config = await storedConfig(rig.stageId);
      expect((await listSwissRoundControls(rig.auth, rig.divisionId))[rig.stageId]!.started, "the desk reads the call as a start").toBe(true);
      await expect(patchSwissStage(rig.auth, rig.stageId, { rounds: 2 })).rejects.toMatchObject(refusal("SWISS_ROUNDS_LOCKED"));
      await expect(patchSwissStage(rig.auth, rig.stageId, { chess: true })).rejects.toMatchObject(refusal("SWISS_CHESS_LOCKED"));
      expect(await rowsOf(rig.stageId), "nothing written").toEqual(rows);
      expect(await ledgerState(rig.divisionId)).toEqual(ledger);
      expect(await storedConfig(rig.stageId)).toEqual(config);

      await undoCall(rig.auth, board.id);
      expect((await listSwissRoundControls(rig.auth, rig.divisionId))[rig.stageId]!.started, "a cleared call is no start").toBe(false);
      expect(await patchSwissStage(rig.auth, rig.stageId, { rounds: 2 })).toMatchObject({ rounds: 2 });
    });

    it(`ruling 257 Unpair ends the call of the board it empties: the lock lifts, the slot is the plan again, a re-Pair carries no call; with no call Unpair is as before (${s.sport})`, async () => {
      // An emptied board cannot be called, and a call left on it would keep the round "started" for ever (the rounds lock,
      // Finish and the next Pair all read the one predicate). Unpair ends the call as Undo call does: the board goes back on
      // the slot it held before the call (the plan, ruling B). The control runs the same Unpair with no call.
      const run = async (called: boolean) => {
        const rig = await swissRig(s, 4, 3);
        await startDivision(rig.auth, rig.divisionId);
        await pair(rig);
        const venue = await createVenue(rig.auth, { name: "Hall " + randomUUID().slice(0, 4), sort: 0 });
        const planned = await createCourt(rig.auth, venue.id, { name: "Court 1", sort: 0, tags: [] });
        const free = await createCourt(rig.auth, venue.id, { name: "Court 2", sort: 1, tags: [] });
        const plannedAt = "2030-06-01T10:00:00.000Z";
        const [board, other] = boardsOf(await rowsOf(rig.stageId), 1);
        await sql`update fixtures set scheduled_at = ${plannedAt}, court_id = ${planned.id}, venue_id = ${venue.id} where id = ${board!.id}`;
        if (called) {
          await callFixtureToCourt(rig.auth, board!.id, free.id);
          const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_calls where fixture_id = ${board!.id}`;
          expect(n, "premise: the board is called").toBe(1);
          expect((await listSwissRoundControls(rig.auth, rig.divisionId))[rig.stageId]!.started, "premise: the call locks the round").toBe(true);
          expect((await rowsOf(rig.stageId)).find((f) => f.id === board!.id)!.court_id, "premise: the call moved the board").toBe(free.id);
        }
        const ids = boardsOf(await rowsOf(rig.stageId), 1).map((f) => f.id);
        expect(ids.length, "premise: two boards in round 1").toBe(2);

        sched.named.length = 0;
        expect(await unpairSwissRound(rig.auth, rig.stageId)).toMatchObject({ cleared: 2, round: 1 });
        // The post-commit cache write names the board a call-end put back on its plan (its public document carried the called
        // court), and nothing when no call stood: Unpair's own `[]` is unchanged.
        expect(sched.named.filter((n) => n.divisionId === rig.divisionId), "one write, for this division").toEqual([
          { divisionId: rig.divisionId, fixtureIds: called ? [board!.id] : [] },
        ]);
        const after = await rowsOf(rig.stageId);
        const r1 = roundOf(after, 1);
        expect(seatedIn(r1), "the round is back on its shells").toEqual([]);
        const [{ n: callRows }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_calls where fixture_id in ${sql(ids)}`;
        expect(callRows, "no call stands on an emptied board").toBe(0);
        const back = after.find((f) => f.id === board!.id)!;
        expect({ court: back.court_id, at: back.scheduled_at?.toISOString() }, "the plan, as Undo call puts it back").toEqual({ court: planned.id, at: plannedAt });
        expect(after.find((f) => f.id === other!.id)!.court_id, "the other board's slot is not touched").toBe(other!.court_id);
        expect((await listSwissRoundControls(rig.auth, rig.divisionId))[rig.stageId]!.started, "the round is unstarted").toBe(false);
        expect(await patchSwissStage(rig.auth, rig.stageId, { rounds: 2 }), "the rounds edit goes through").toMatchObject({ rounds: 2 });

        await pair(rig); // a re-Pair seats the same shells again — and carries no call
        expect(seatedIn(roundOf(await rowsOf(rig.stageId), 1)).length, "re-paired: four seated").toBe(4);
        const [{ n: afterPair }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_calls where fixture_id in ${sql(ids)}`;
        expect(afterPair, "the re-Pair carries no call").toBe(0);
        expect((await listSwissRoundControls(rig.auth, rig.divisionId))[rig.stageId]!.started, "still unstarted").toBe(false);
        return { slot: { court: back.court_id, at: back.scheduled_at?.toISOString() }, planned: planned.id };
      };
      const noCall = await run(false);
      const withCall = await run(true);
      // The positive pair: Unpair with no call keeps the planned slot, and the called round ends on the same slot.
      expect(noCall.slot).toEqual({ court: noCall.planned, at: "2030-06-01T10:00:00.000Z" });
      expect(withCall.slot).toEqual({ court: withCall.planned, at: "2030-06-01T10:00:00.000Z" });
    }, 120_000);

    it(`ruling 257 ending a call survives a deleted pre-call court: Unpair and Undo call put the board on no court, never a dangling one (${s.sport})`, async () => {
      // `deleteCourt` refuses only while a fixture is ON the court, and the call moved the board off its planned court - so
      // that court can go while the board is called. The call's record of it carries no FK, and writing it back used to fail
      // at COMMIT (the court FK is deferred), leaving the Unpair / Undo call stuck for good (history.ts's `liveCourt` rule).
      const plannedAt = "2030-06-01T10:00:00.000Z";
      let ended = 0;
      for (const how of ["Unpair", "Undo call"] as const) {
        const rig = await swissRig(s, 4, 3);
        await startDivision(rig.auth, rig.divisionId);
        await pair(rig);
        const venue = await createVenue(rig.auth, { name: "Hall " + randomUUID().slice(0, 4), sort: 0 });
        const planned = await createCourt(rig.auth, venue.id, { name: "Court 1", sort: 0, tags: [] });
        const free = await createCourt(rig.auth, venue.id, { name: "Court 2", sort: 1, tags: [] });
        const board = boardsOf(await rowsOf(rig.stageId), 1)[0]!;
        await sql`update fixtures set scheduled_at = ${plannedAt}, court_id = ${planned.id}, venue_id = ${venue.id} where id = ${board.id}`;
        await callFixtureToCourt(rig.auth, board.id, free.id);
        await deleteCourt(rig.auth, planned.id);
        const [{ n: gone }] = await sql<{ n: number }[]>`select count(*)::int as n from courts where id = ${planned.id}`;
        expect(gone, "premise: the pre-call court is deleted while the board is called").toBe(0);

        if (how === "Unpair") await unpairSwissRound(rig.auth, rig.stageId);
        else await undoCall(rig.auth, board.id);

        const [back] = await sql<{ court_id: string | null; scheduled_at: Date | null }[]>`
          select court_id, scheduled_at from fixtures where id = ${board.id}`;
        expect({ court: back!.court_id, at: back!.scheduled_at?.toISOString() }, `${how}: no court, the planned time`).toEqual({ court: null, at: plannedAt });
        const [{ n: calls }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_calls where fixture_id = ${board.id}`;
        expect(calls, `${how}: the call is gone`).toBe(0);
        ended++;
      }
      expect(ended, "anti-vacuity: both ways of ending a call ran").toBe(2);
    }, 120_000);

    it(`ruling 257 a live call on ANOTHER division's fixture leaves this Swiss round unstarted (${s.sport})`, async () => {
      // Pins the correlation of the call arm to THIS board (`fc.fixture_id = f.id`): without it, any live call in the
      // organisation would start every Swiss board in it.
      const rig = await swissRig(s, 4, 3);
      await startDivision(rig.auth, rig.divisionId);
      await pair(rig);
      const neighbour = await swissRig(s, 4, 3, rig.auth); // the same organisation, another division
      await startDivision(neighbour.auth, neighbour.divisionId);
      await pair(neighbour);
      const venue = await createVenue(rig.auth, { name: "Hall " + randomUUID().slice(0, 4), sort: 0 });
      const court = await createCourt(rig.auth, venue.id, { name: "Court 1", sort: 0, tags: [] });
      await callFixtureToCourt(neighbour.auth, boardsOf(await rowsOf(neighbour.stageId), 1)[0]!.id, court.id);
      expect(
        (await listSwissRoundControls(neighbour.auth, neighbour.divisionId))[neighbour.stageId]!.started,
        "premise: the neighbour's call is live and starts its own round",
      ).toBe(true);
      expect((await listSwissRoundControls(rig.auth, rig.divisionId))[rig.stageId]!.started, "this division is untouched").toBe(false);
      expect(await patchSwissStage(rig.auth, rig.stageId, { rounds: 2 })).toMatchObject({ rounds: 2 });
    });

    it(`X-SW-17 a decided board with no event behind it locks rounds (${s.sport})`, async () => {
      // T9's predicate: "decided other than the bye" is started — a two-sided walkover an import or a pre-W2b generator
      // wrote holds no event, yet its board is settled. Planted: no product path writes one on a Swiss round today.
      const rig = await swissRig(s, 4, 3);
      await startDivision(rig.auth, rig.divisionId);
      await pair(rig);
      const board = boardsOf(await rowsOf(rig.stageId), 1)[0]!;
      await sql`
        update fixtures set status = 'forfeited',
          outcome = ${sql.json({ kind: "award", winner: board.home_entrant_id, loser: board.away_entrant_id, reason: "withdrew" } as never)}
        where id = ${board.id}`;
      await expect(patchSwissStage(rig.auth, rig.stageId, { rounds: 2 })).rejects.toMatchObject(refusal("SWISS_ROUNDS_LOCKED"));
    });

    it(`X-SW-17 rounds above the field's hard max refuse 422 as sent; nothing written (${s.sport})`, async () => {
      // A field of 6: hard max 5 (§3.2).
      const rig = await swissRig(s, 6, 3);
      await pair(rig);
      const rows = await rowsOf(rig.stageId);
      const ledger = await ledgerState(rig.divisionId);
      await expect(patchSwissStage(rig.auth, rig.stageId, { rounds: 6 })).rejects.toMatchObject({
        status: 422,
        code: "SWISS_ROUNDS_ABOVE_MAX",
        extra: { rounds: 6, field: 6, hardMax: 5, canFinish: false },
      });
      expect(await rowsOf(rig.stageId)).toEqual(rows);
      expect(await ledgerState(rig.divisionId)).toEqual(ledger);
      expect((await storedConfig(rig.stageId)).rounds).toBe(3);
      // The hard max itself goes through.
      expect((await patchSwissStage(rig.auth, rig.stageId, { rounds: 5 })).shells.added, "2 rounds × 3 boards").toBe(6);
    });

    it(`c2: after a pre-Start shrink the count can be LOWERED to what the field pairs, and Start then goes through (${s.sport})`, async () => {
      // T11 carry c2: shells minted for 6 × 5, two withdraw before Start → a field of 4 (hard max 3): Start refuses 5.
      const rig = await swissRig(s, 6, 5);
      await pair(rig);
      await withdrawEntrantCascade(rig.auth, rig.entrants[4]!);
      await withdrawEntrantCascade(rig.auth, rig.entrants[5]!);
      await expect(startDivision(rig.auth, rig.divisionId), "premise: Start refuses 5 rounds over 4").rejects.toMatchObject({
        status: 422,
        code: "SWISS_ROUNDS_ABOVE_MAX",
        extra: { rounds: 5, field: 4, hardMax: 3 },
      });
      // 4 is still above the shrunk field's hard max; 3 is not (n = 4 → recommended 2, safe 2, hard 3: a warning).
      await expect(patchSwissStage(rig.auth, rig.stageId, { rounds: 4 })).rejects.toMatchObject({
        status: 422,
        code: "SWISS_ROUNDS_ABOVE_MAX",
        extra: { rounds: 4, field: 4, hardMax: 3 },
      });
      const out = await patchSwissStage(rig.auth, rig.stageId, { rounds: 3 });
      expect(out).toMatchObject({ rounds: 3, swiss_rounds: { verdict: "warn", recommended: 2, safeMax: 2, hardMax: 3 }, shells: { removed: 6 } });
      await expect(startDivision(rig.auth, rig.divisionId)).resolves.toMatchObject({ started: true });
      await pair(rig);
      const seated = seatedIn(boardsOf(await rowsOf(rig.stageId), 1)).sort();
      expect(seated, "round 1 seats the four left").toEqual(rig.entrants.slice(0, 4).sort());
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// The guards a rounds edit carries (each reached, each mutated once — see the task report)
// ---------------------------------------------------------------------------------------------------------------------

describe.runIf(HAS_DB)("patchSwissStage guards (badminton — the guards read rows and the ledger, never the sport)", () => {
  const BADMINTON = SPORTS[0];

  it("STAGE_NOT_SWISS (422) for a league stage, and for Add a round; nothing written", async () => {
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "League " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
    const division = await createDivision(auth, comp.id, { name: "Open", slug: "open-" + randomUUID().slice(0, 6), sport_key: "badminton", variant_key: "bwf", config: {} });
    const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "League", config: {}, progression: null });
    const before = await ledgerState(division.id);
    await expect(patchSwissStage(auth, stage!.id, { rounds: 3 })).rejects.toMatchObject(refusal("STAGE_NOT_SWISS"));
    await expect(addSwissRound(auth, stage!.id)).rejects.toMatchObject(refusal("STAGE_NOT_SWISS"));
    expect(await storedConfig(stage!.id)).not.toHaveProperty("rounds");
    expect(await ledgerState(division.id)).toEqual(before);
  });

  it("an unknown stage, or another organisation's, is 404 to both", async () => {
    const rig = await swissRig(BADMINTON, 4, 2);
    const { auth: stranger } = await seedOrg("pro");
    await expect(patchSwissStage(stranger, rig.stageId, { rounds: 1 })).rejects.toMatchObject({ status: 404 });
    await expect(addSwissRound(stranger, rig.stageId)).rejects.toMatchObject({ status: 404 });
    await expect(patchSwissStage(rig.auth, randomUUID(), { rounds: 1 })).rejects.toMatchObject({ status: 404 });
    expect((await storedConfig(rig.stageId)).rounds).toBe(2);
  });

  it("a frozen timetable refuses both, as Unpair does (SCHEDULE_LOCKED, 422)", async () => {
    const rig = await swissRig(BADMINTON, 4, 2);
    await pair(rig);
    await sql`update divisions set schedule_locked = true where id = ${rig.divisionId}`;
    const rows = await rowsOf(rig.stageId);
    await expect(patchSwissStage(rig.auth, rig.stageId, { rounds: 1 })).rejects.toMatchObject({ status: 422, code: "SCHEDULE_LOCKED" });
    await expect(addSwissRound(rig.auth, rig.stageId)).rejects.toMatchObject({ status: 422, code: "SCHEDULE_LOCKED" });
    expect(await rowsOf(rig.stageId)).toEqual(rows);
    expect((await storedConfig(rig.stageId)).rounds).toBe(2);
  });

  it("SWISS_ROUNDS_BELOW_SEATED (409): a count below a seated round is refused; at it, it goes through", async () => {
    // Unreachable through the product under T9's started predicate (a round seats only after the round before it is
    // decided, which is a start), so the seated round 3 is planted: the guard is the fact, not the comment.
    // A field of 6 on 4 rounds (hard max 5).
    const rig = await swissRig(BADMINTON, 6, 4);
    await pair(rig);
    const r3 = boardsOf(await rowsOf(rig.stageId), 3)[0]!;
    await sql`update fixtures set home_entrant_id = ${rig.entrants[0]!}, away_entrant_id = ${rig.entrants[1]!} where id = ${r3.id}`;
    const rows = await rowsOf(rig.stageId);
    const ledger = await ledgerState(rig.divisionId);
    await expect(patchSwissStage(rig.auth, rig.stageId, { rounds: 2 })).rejects.toMatchObject(refusal("SWISS_ROUNDS_BELOW_SEATED"));
    expect(SWISS_REFUSALS.SWISS_ROUNDS_BELOW_SEATED.status, "ruled 409: Unpair resolves it").toBe(409);
    expect(await rowsOf(rig.stageId)).toEqual(rows);
    expect(await ledgerState(rig.divisionId)).toEqual(ledger);
    expect((await storedConfig(rig.stageId)).rounds).toBe(4);
    expect((await patchSwissStage(rig.auth, rig.stageId, { rounds: 3 })).shells.removed, "round 4's three boards only").toBe(3);
  });

  it("a shell the edit would delete that carries recorded data refuses (the started read covers every row); nothing written", async () => {
    // Planted: an unseated shell never holds evidence (nobody can score it). The "started" read runs over EVERY row of
    // the stage and includes the canonical evidence list (`fixtureHasResultSql` ⊇ `fixtureEvidenceSql`), so a shell the
    // edit would delete is never deleted with data on it: the edit is refused as locked.
    const rig = await swissRig(BADMINTON, 4, 3);
    await pair(rig);
    const r3 = boardsOf(await rowsOf(rig.stageId), 3)[0]!;
    await sql`update fixtures set config_snapshot = '{}'::jsonb where id = ${r3.id}`;
    const rows = await rowsOf(rig.stageId);
    await expect(patchSwissStage(rig.auth, rig.stageId, { rounds: 2 })).rejects.toMatchObject(refusal("SWISS_ROUNDS_LOCKED"));
    expect(await rowsOf(rig.stageId)).toEqual(rows);
    expect((await storedConfig(rig.stageId)).rounds).toBe(3);
  });

  it("a deleted shell carrying its own format refuses by name (FIXTURE_HAS_OWN_FORMAT); nothing written", async () => {
    const rig = await swissRig(BADMINTON, 4, 3);
    await pair(rig);
    const r3 = boardsOf(await rowsOf(rig.stageId), 3)[0]!;
    await sql`update fixtures set rules_override = '{"bestOf": 1}'::jsonb where id = ${r3.id}`;
    const rows = await rowsOf(rig.stageId);
    await expect(patchSwissStage(rig.auth, rig.stageId, { rounds: 2 })).rejects.toMatchObject({ code: "FIXTURE_HAS_OWN_FORMAT" });
    expect(await rowsOf(rig.stageId)).toEqual(rows);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Add a round (ruling 250: offered while running, "This Swiss is over" after)
// ---------------------------------------------------------------------------------------------------------------------

describe.runIf(HAS_DB)("X-SW-17 Add a round", () => {
  it("a field under two is refused STAGE_NOT_READY (the Generate rule), never ABOVE_MAX; the desk read agrees (badminton — arithmetic on the field)", async () => {
    // Fix round 1 (review m5): 3 players × 2 rounds, round 1 played, two withdraw — round 3's field is 1, which pairs nobody.
    const rig = await swissRig(SPORTS[0], 3, 2);
    await startDivision(rig.auth, rig.divisionId);
    await pair(rig);
    await playRound(rig, 1);
    await withdrawEntrantCascade(rig.auth, rig.entrants[1]!);
    await withdrawEntrantCascade(rig.auth, rig.entrants[2]!);
    const before = await rowsOf(rig.stageId);
    await expect(addSwissRound(rig.auth, rig.stageId)).rejects.toMatchObject({ code: "STAGE_NOT_READY" });
    expect(await rowsOf(rig.stageId), "nothing written").toEqual(before);
    expect((await storedConfig(rig.stageId)).rounds).toBe(2);
    expect((await listSwissRoundControls(rig.auth, rig.divisionId))[rig.stageId]?.addRound).toMatchObject({
      canAddRound: false,
      refusal: "field",
      field: 1,
    });

    // Before any Generate there is no shell to mint, so the mint's own field check never runs: this early refusal is the
    // only guard (mutation-checked) — without it a field of 1 would silently store one more round.
    const bare = await swissRig(SPORTS[0], 3, 2);
    await withdrawEntrantCascade(bare.auth, bare.entrants[1]!);
    await withdrawEntrantCascade(bare.auth, bare.entrants[2]!);
    await expect(addSwissRound(bare.auth, bare.stageId)).rejects.toMatchObject({ code: "STAGE_NOT_READY" });
    expect((await storedConfig(bare.stageId)).rounds, "the count is not stored").toBe(2);
    expect(await rowsOf(bare.stageId)).toEqual([]);
  });

  for (const s of SPORTS) {
    it(`X-SW-17 Add a round mints round N+1 for the current field and is an undo barrier (${s.sport})`, async () => {
      // 6 players × 2 rounds, both played; then one withdraws. Round 3 is for the field of 5 that is left — 2 boards and
      // a bye (⌊5/2⌋ + 1) — not the 3 boards the original 6 had.
      const rig = await swissRig(s, 6, 2);
      await startDivision(rig.auth, rig.divisionId);
      await pair(rig);
      await playRound(rig, 1);
      await pair(rig);
      await playRound(rig, 2);
      await withdrawEntrantCascade(rig.auth, rig.entrants[5]!);
      const ledger0 = await ledgerState(rig.divisionId);

      const out = await addSwissRound(rig.auth, rig.stageId);
      expect(out).toEqual({ rounds: 3, shells_added: 3 });
      expect((await storedConfig(rig.stageId)).rounds).toBe(3);
      const r3 = roundOf(await rowsOf(rig.stageId), 3);
      expect(r3.map((f) => [f.ext_key, f.seq_in_round, f.home_entrant_id, f.away_entrant_id])).toEqual([
        ["sw-r3-b1", 1, null, null],
        ["sw-r3-b2", 2, null, null],
        ["sw-r3-bye", 3, null, null],
      ]);
      expect((await roundsRows(rig.divisionId)).map((r) => r.payload)).toEqual([
        { stage_id: rig.stageId, from: 2, to: 3, via: "add_round", source: "organiser" },
      ]);
      expect(await ledgerState(rig.divisionId), "one row; the watermark untouched").toEqual({
        events: ledger0.events + 1,
        seq: ledger0.seq + 1,
        watermark: ledger0.watermark,
      });

      // An undo barrier (design §10.8): Undo refuses by name and changes nothing.
      const rows = await rowsOf(rig.stageId);
      const ledger1 = await ledgerState(rig.divisionId);
      await expect(undoDivision(rig.auth, rig.divisionId)).rejects.toMatchObject(refusal("SWISS_ROUNDS_CHANGE_NOT_UNDOABLE"));
      expect(await rowsOf(rig.stageId)).toEqual(rows);
      expect(await ledgerState(rig.divisionId)).toEqual(ledger1);

      // The added round pairs: every one of the five left is seated in round 3.
      await pair(rig);
      expect(seatedIn(roundOf(await rowsOf(rig.stageId), 3)).sort(), "round 3 seats the five left").toEqual(rig.entrants.slice(0, 5).sort());
      // C12a: the first Undo inverts that Pair (its seats clear); the barrier refuses the next one.
      await undoDivision(rig.auth, rig.divisionId);
      expect(seatedIn(roundOf(await rowsOf(rig.stageId), 3)), "the Pair of round 3 undone").toEqual([]);
      await expect(undoDivision(rig.auth, rig.divisionId)).rejects.toMatchObject(refusal("SWISS_ROUNDS_CHANGE_NOT_UNDOABLE"));
    }, 180_000);

    it(`X-SW-17 Add a round above the hard max refuses (${s.sport})`, async () => {
      // A field of 4 has a hard max of 3 (§3.2): 3 rounds can grow to nothing.
      const rig = await swissRig(s, 4, 3);
      await startDivision(rig.auth, rig.divisionId);
      await pair(rig);
      const rows = await rowsOf(rig.stageId);
      const ledger = await ledgerState(rig.divisionId);
      await expect(addSwissRound(rig.auth, rig.stageId)).rejects.toMatchObject({
        status: 422,
        code: "SWISS_ROUNDS_ABOVE_MAX",
        extra: { rounds: 4, field: 4, hardMax: 3, canFinish: false },
      });
      expect(await rowsOf(rig.stageId)).toEqual(rows);
      expect(await ledgerState(rig.divisionId)).toEqual(ledger);
      expect((await storedConfig(rig.stageId)).rounds).toBe(3);
      // The positive pair: one round less, and it adds.
      const two = await swissRig(s, 4, 2);
      await startDivision(two.auth, two.divisionId);
      await pair(two);
      expect(await addSwissRound(two.auth, two.stageId)).toEqual({ rounds: 3, shells_added: 2 });
    });

    it(`X-SW-17 Add a round after the Swiss is complete refuses SWISS_OVER (${s.sport})`, async () => {
      const done = await swissRig(s, 4, 1);
      await startDivision(done.auth, done.divisionId);
      await pair(done);
      await playRound(done, 1);
      await completeStage(done.auth, done.stageId);
      const rows = await rowsOf(done.stageId);
      await expect(addSwissRound(done.auth, done.stageId)).rejects.toMatchObject({ ...refusal("SWISS_OVER"), extra: { canAddRound: false } });
      expect(await rowsOf(done.stageId)).toEqual(rows);
      expect((await storedConfig(done.stageId)).rounds).toBe(1);
      // Still running, but a later stage has a match under way: over all the same (ruling 250 "its knockout has started").
      const ko = await swissRig(s, 4, 2);
      await startDivision(ko.auth, ko.divisionId);
      await pair(ko);
      const [koStage] = await sql<{ id: string }[]>`
        insert into stages (division_id, seq, kind, name, config) values (${ko.divisionId}, 2, 'knockout', 'KO', '{}') returning id`;
      await sql`
        insert into fixtures (stage_id, division_id, round_no, seq_in_round, home_entrant_id, away_entrant_id, status)
        values (${koStage!.id}, ${ko.divisionId}, 1, 1, ${ko.entrants[0]!}, ${ko.entrants[1]!}, 'in_play')`;
      await expect(addSwissRound(ko.auth, ko.stageId)).rejects.toMatchObject(refusal("SWISS_OVER"));
      // The positive pair: that later fixture not started (scheduled) is no start, and the round adds.
      await sql`update fixtures set status = 'scheduled' where stage_id = ${koStage!.id}`;
      expect(await addSwissRound(ko.auth, ko.stageId)).toEqual({ rounds: 3, shells_added: 2 });
    });
  }

  it("a second Add a round counts from the first: 2 → 3 → 4, two barrier rows (badminton — the count is arithmetic)", async () => {
    const rig = await swissRig(SPORTS[0], 6, 2);
    await startDivision(rig.auth, rig.divisionId);
    await pair(rig);
    expect(await addSwissRound(rig.auth, rig.stageId)).toEqual({ rounds: 3, shells_added: 3 });
    expect(await addSwissRound(rig.auth, rig.stageId)).toEqual({ rounds: 4, shells_added: 3 });
    expect(roundsIn(await rowsOf(rig.stageId))).toEqual([1, 2, 3, 4]);
    expect((await roundsRows(rig.divisionId)).map((r) => [r.payload.from, r.payload.to])).toEqual([
      [2, 3],
      [3, 4],
    ]);
  });

  it("before any Generate Add a round only stores the count (the empty case; badminton)", async () => {
    const rig = await swissRig(SPORTS[0], 6, 2);
    expect(await addSwissRound(rig.auth, rig.stageId)).toEqual({ rounds: 3, shells_added: 0 });
    expect(await rowsOf(rig.stageId)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// C11: one canAddRound predicate — every place that offers the button agrees with what the button does
// ---------------------------------------------------------------------------------------------------------------------

describe.runIf(HAS_DB)("C11 the offered Add a round never leads to SWISS_ROUNDS_ABOVE_MAX", () => {
  it("SWISS_ROUNDS_LOCKED's canAddRound is exactly whether Add a round goes through (n = 3..6, at and one below the hard max; badminton — the bound is arithmetic on the field)", async () => {
    const { auth } = await seedOrg("pro");
    let checked = 0;
    let offered = 0;
    for (const n of [3, 4, 5, 6]) {
      for (const rounds of [HARD_MAX(n) - 1, HARD_MAX(n)]) {
        const rig = await swissRig(SPORTS[0], n, rounds, auth);
        await startDivision(rig.auth, rig.divisionId);
        await pair(rig);
        await startBoard(rig, boardsOf(await rowsOf(rig.stageId), 1)[0]!);
        const err = await patchSwissStage(rig.auth, rig.stageId, { rounds }).then(
          () => null,
          (e: unknown) => e as { code?: string; extra?: { canAddRound?: unknown } },
        );
        expect(err?.code, `n=${n} rounds=${rounds}: locked`).toBe("SWISS_ROUNDS_LOCKED");
        const canAddRound = err!.extra!.canAddRound;
        // The rulebook's answer: one more round fits iff rounds + 1 ≤ hard max.
        expect(canAddRound, `n=${n} rounds=${rounds}`).toBe(rounds + 1 <= HARD_MAX(n));
        if (canAddRound === true) {
          await expect(addSwissRound(rig.auth, rig.stageId), `n=${n} rounds=${rounds}: offered → it adds`).resolves.toMatchObject({ rounds: rounds + 1 });
          offered++;
        } else {
          // No round complete yet (one board started): Finish now cannot resolve it — 422 as sent (T12 status rule).
          await expect(addSwissRound(rig.auth, rig.stageId), `n=${n} rounds=${rounds}: not offered`).rejects.toMatchObject({
            status: 422,
            code: "SWISS_ROUNDS_ABOVE_MAX",
            extra: { canFinish: false, hardMax: HARD_MAX(n) },
          });
        }
        checked++;
      }
    }
    expect(checked, "anti-vacuity: (n, rounds) cells").toBe(8);
    expect(offered, "both answers reached").toBe(4);
  }, 300_000);

  it("SWISS_NO_ROUND_LEFT's canAddRound counts the field Add a round will see — never the arriving player (badminton — arithmetic on the field)", async () => {
    // 4 players × 3 rounds is at the hard max (§3.2: n = 4 → 3). The arriving fifth would make a field of 5 (hard max 5),
    // but the refusal rolls their add back, so Add a round sees 4 — the button must not be offered.
    const four = await swissRig(SPORTS[0], 4, 3);
    await startDivision(four.auth, four.divisionId);
    await pair(four);
    await playRound(four, 1);
    await pair(four);
    await playRound(four, 2);
    // Mid-Swiss (round 3 not yet paired): Finish after round 2 resolves an add above the hard max — the ruled 409 (review
    // I2 MA), its plan riding with it. Refused, nothing written.
    await expect(addSwissRound(four.auth, four.stageId), "mid-Swiss: Finish is offered").rejects.toMatchObject({
      status: 409,
      code: "SWISS_ROUNDS_ABOVE_MAX",
      extra: { rounds: 4, field: 4, hardMax: 3, canFinish: true, finish: { after: 2, rounds: 3 } },
    });
    await pair(four);
    await startBoard(four, boardsOf(await rowsOf(four.stageId), 3)[0]!);
    await expect(createEntrants(four.auth, four.divisionId, [entrantInput(four.kind, "Late")])).rejects.toMatchObject({
      ...refusal("SWISS_NO_ROUND_LEFT"),
      // Phase 2: the stage it names is where the entrants panel's "Add a round" recovery posts.
      extra: { canAddRound: false, stageId: four.stageId },
    });
    // T13 (C11 applied to Finish): round 3 is under way, so Finish is refused too (a started board cannot be unpaired) —
    // `canFinish` is THE Finish predicate's answer, false, and the refusal can never succeed as sent: 422. (Before T13 it
    // read "a round is complete" and offered a Finish that would have refused.)
    await expect(addSwissRound(four.auth, four.stageId), "and indeed it refuses").rejects.toMatchObject({
      status: 422,
      code: "SWISS_ROUNDS_ABOVE_MAX",
      extra: { rounds: 4, field: 4, hardMax: 3, canFinish: false },
    });
    // Round 3 decided: every round is, so Finish would only do what Complete does — not offered (batch-4 ruling m3:
    // Complete is the action), and the add can never succeed as sent: 422, canFinish false. (Before that ruling this was
    // the 409 offering "Finish after round 3"; the 409 with Finish offered is pinned above, mid-Swiss.)
    await playRound(four, 3);
    await expect(addSwissRound(four.auth, four.stageId), "every round decided: Finish is not offered").rejects.toMatchObject({
      status: 422,
      code: "SWISS_ROUNDS_ABOVE_MAX",
      extra: { rounds: 4, field: 4, hardMax: 3, canFinish: false },
    });

    // The positive pair: 6 players × 3 rounds (hard max 5) — offered, and Add a round goes through; the late player then
    // joins the added round. (An even field: an odd one's round 3 has a bye, and the newcomer would take it — case (b).)
    const six = await swissRig(SPORTS[0], 6, 3);
    await startDivision(six.auth, six.divisionId);
    await pair(six);
    await playRound(six, 1);
    await pair(six);
    await playRound(six, 2);
    await pair(six);
    await startBoard(six, boardsOf(await rowsOf(six.stageId), 3)[0]!);
    await expect(createEntrants(six.auth, six.divisionId, [entrantInput(six.kind, "Late")])).rejects.toMatchObject({
      ...refusal("SWISS_NO_ROUND_LEFT"),
      extra: { canAddRound: true, stageId: six.stageId },
    });
    expect(await addSwissRound(six.auth, six.stageId)).toEqual({ rounds: 4, shells_added: 3 });
    const [late] = await createEntrants(six.auth, six.divisionId, [entrantInput(six.kind, "Late")]);
    expect(late!.late_entry, "the late player joins the added round").toMatchObject({ case: "c", round: 4 });
  }, 180_000);

  it("an automatic arrival recorded after the last round is in the added round's field (badminton — arithmetic on the field)", async () => {
    // 4 × 3 at the hard max; a paid registration after round 3 started is recorded "joined after the last round"
    // (round 4, ruling 250). Round 4's field is then 5 (hard max 5): Add a round fits, and its round seats them.
    const rig = await swissRig(SPORTS[0], 4, 3);
    await startDivision(rig.auth, rig.divisionId);
    await pair(rig);
    await playRound(rig, 1);
    await pair(rig);
    await playRound(rig, 2);
    await pair(rig);
    await startBoard(rig, boardsOf(await rowsOf(rig.stageId), 3)[0]!);
    const late = await registerAndConfirm(rig, "Paid late");
    await playRound(rig, 3);
    // 5 in round 4's field: 2 boards and a bye.
    expect(await addSwissRound(rig.auth, rig.stageId)).toEqual({ rounds: 4, shells_added: 3 });
    await pair(rig);
    expect(seatedIn(roundOf(await rowsOf(rig.stageId), 4)), "the paid latecomer plays round 4").toContain(late);
  }, 180_000);
});

// ---------------------------------------------------------------------------------------------------------------------
// Chess colours: always on for a chess Swiss (BG-SW-1; UI5 item 4, owner 2026-11-03 — the desk's switch is gone, and the
// PATCH refuses turning them off). UI5 fix round 1 (controller ruling I1): a stage stored off before this pairs in colour
// until its round 1 is paired — read-side, no data migration; one whose round 1 was already paired keeps what it paired
// with.
// ---------------------------------------------------------------------------------------------------------------------

describe.runIf(HAS_DB)("BG-SW-1 chess colours are always on for a chess Swiss", () => {
  // Boardgame only: the chess default and its lot are a boardgame rule (T8, `defaultSwissChess`); badminton is the other
  // sport, for the positive pair (the refusal is the chess rule's, not every Swiss's).
  const [BADMINTON, BOARDGAME] = SPORTS;

  async function roundOnePairRow(divisionId: string) {
    const [row] = await sql<{ payload: Record<string, unknown> }[]>`
      select payload from division_events
      where division_id = ${divisionId} and type = 'fixtures_generated' and payload->>'round' = '1'
      order by seq desc limit 1`;
    return row!.payload;
  }
  /** A stage stored with colours off before UI5 (the switch could write it then): the legacy row, by SQL. */
  async function legacyOff(stageId: string) {
    await sql`update stages set config = config || ${sql.json({ chess: false })} where id = ${stageId}`;
  }
  /** A round 1 paired BEFORE fix round 1 on a stage stored off was paired plain: its Pair row drew no colour lot. Built
   *  by SQL — the Pair this file can run today colours it. */
  async function pairedPlainBeforeTheRule(divisionId: string) {
    const n = await sql`
      update division_events set payload = payload - 'colour_lot'
      where division_id = ${divisionId} and type = 'fixtures_generated' and payload->>'round' = '1' and payload ? 'colour_lot'`;
    expect(n.count, "rig: round 1's Pair row had a lot to strip").toBe(1);
  }
  /** The `chess` option each Pair handed the engine, through the real `pairRound` (spied, never replaced). */
  async function chessHandedToTheEngine(write: () => Promise<unknown>): Promise<boolean[]> {
    const engine = await import("@seazn/engine/scheduling");
    const spy = vi.spyOn(engine, "pairRound");
    try {
      await write();
      return spy.mock.calls.map((c) => c[2]?.chess === true);
    } finally {
      spy.mockRestore();
    }
  }

  it("UI5 item 4: switching a chess Swiss's colours off is 422 SWISS_CHESS_ALWAYS_ON before the start, nothing written; Pair draws the colour lot", async () => {
    const rig = await swissRig(BOARDGAME, 4, 3);
    expect((await storedConfig(rig.stageId)).chess, "premise: a new boardgame Swiss is stored with chess on (T8)").toBe(true);
    const config = await storedConfig(rig.stageId);
    let refused = 0;
    for (const body of [{ chess: false }, { rounds: 2, chess: false }]) {
      await expect(patchSwissStage(rig.auth, rig.stageId, body), JSON.stringify(body)).rejects.toMatchObject(refusal("SWISS_CHESS_ALWAYS_ON"));
      expect(await storedConfig(rig.stageId), `${JSON.stringify(body)}: nothing written (the count included)`).toEqual(config);
      refused++;
    }
    expect(refused, "anti-vacuity: refused bodies").toBe(2);
    expect(await roundsRows(rig.divisionId), "no round-count change either").toEqual([]);
    // Its cleared pair: `chess: true` (a no-op here) and the count alone still go through on the same stage.
    expect(await patchSwissStage(rig.auth, rig.stageId, { chess: true })).toMatchObject({ rounds: 3, chess: true });
    expect(await patchSwissStage(rig.auth, rig.stageId, { rounds: 2 })).toMatchObject({ rounds: 2, chess: true });
    await pair(rig);
    await pair(rig); // Pair round 1
    expect(await roundOnePairRow(rig.divisionId), "chess on: round 1 coloured by lot").toHaveProperty("colour_lot");

    // Another sport: the refusal is chess's, not every Swiss's — badminton's `chess: false` still goes through.
    const other = await swissRig(BADMINTON, 4, 3);
    expect(await patchSwissStage(other.auth, other.stageId, { chess: false })).toMatchObject({ rounds: 3, chess: false });
  });

  // Fix round 1 flipped this test (it pinned "Pair keeps a stored off"): the owner ruled colours always ON for a chess
  // Swiss, so a stage stored off that has not paired round 1 pairs in colour, whatever is stored (controller ruling I1).
  it("UI5 fix round 1 (I1, Q2): a chess Swiss stored off before the change pairs round 1 in colour — read-side, nothing written; ON goes through; a re-Apply stores it on", async () => {
    const rig = await swissRig(BOARDGAME, 4, 3);
    await legacyOff(rig.stageId);
    await pair(rig);
    expect(await chessHandedToTheEngine(() => pair(rig)), "Pair round 1: the engine balances colours").toEqual([true]);
    expect(await roundOnePairRow(rig.divisionId), "round 1 coloured by lot").toHaveProperty("colour_lot");
    expect((await storedConfig(rig.stageId)).chess, "read-side: the stored off is not rewritten").toBe(false);

    // Switching it ON is the one change left (before play): it goes through and is stored.
    const on = await swissRig(BOARDGAME, 4, 3);
    await legacyOff(on.stageId);
    expect(await patchSwissStage(on.auth, on.stageId, { chess: true })).toMatchObject({ rounds: 3, chess: true });
    expect((await storedConfig(on.stageId)).chess).toBe(true);
    // ...and once on, off is refused again.
    await expect(patchSwissStage(on.auth, on.stageId, { chess: false })).rejects.toMatchObject(refusal("SWISS_CHESS_ALWAYS_ON"));
    // UI5 fix round 1 (ruling Q2): the Format tab's Apply re-sends the template body, which names no `chess`. A legacy
    // off is NOT carried onto a chess Swiss (StageCarry, T8 m6, carried it before): the create door refuses an off, and
    // the replaced slot is stored with the default.
    const body = [{ seq: 1, kind: "swiss" as const, name: "Swiss", config: { rounds: 3 }, progression: null }];
    const legacy = await swissRig(BOARDGAME, 4, 3);
    await legacyOff(legacy.stageId);
    const [again] = await replaceStages(legacy.auth, legacy.divisionId, body);
    expect(again!.config.chess, "the legacy off is not carried: stored on").toBe(true);
    // The positive pair for the carry: never stored off, a re-Apply keeps the default on.
    const fresh = await swissRig(BOARDGAME, 4, 3);
    const [kept] = await replaceStages(fresh.auth, fresh.divisionId, body);
    expect(kept!.config.chess).toBe(true);
    // Another sport keeps its own off through the carry: the drop is chess's alone.
    const racket = await swissRig(BADMINTON, 4, 3);
    await legacyOff(racket.stageId);
    const [carried] = await replaceStages(racket.auth, racket.divisionId, body);
    expect(carried!.config.chess, "badminton: the stored off rides the carry").toBe(false);
  });

  it("UI5 fix round 1 (I1): once round 1 is paired the stage keeps what it paired with — plain stays off, coloured stays on (round 2)", async () => {
    let compared = 0;
    for (const { plain, want } of [
      { plain: true, want: false },
      { plain: false, want: true },
    ]) {
      const rig = await swissRig(BOARDGAME, 4, 3);
      await legacyOff(rig.stageId);
      await startDivision(rig.auth, rig.divisionId); // mints the shells
      await pair(rig); // Pair round 1
      if (plain) await pairedPlainBeforeTheRule(rig.divisionId);
      await playRound(rig, 1);
      const label = plain ? "paired plain before the rule: a stage under way keeps its stored off" : "paired in colour: round 2 balances them";
      expect(await chessHandedToTheEngine(() => pair(rig)), label).toEqual([want]);
      expect(roundOf(await rowsOf(rig.stageId), 2).length, "rig: round 2 seated").toBeGreaterThan(0);
      expect((await storedConfig(rig.stageId)).chess, "read-side: nothing written").toBe(false);
      compared++;
    }
    expect(compared, "anti-vacuity: both histories paired round 2").toBe(2);
  }, 120_000);

  it("UI5 fix round 1 (I1): another sport is untouched — a badminton Swiss stored off pairs round 1 plain", async () => {
    const rig = await swissRig(BADMINTON, 4, 3);
    await legacyOff(rig.stageId);
    await pair(rig);
    expect(await chessHandedToTheEngine(() => pair(rig)), "badminton: no colours").toEqual([false]);
    expect(await roundOnePairRow(rig.divisionId), "no colour lot outside chess").not.toHaveProperty("colour_lot");
    // Its positive pair: badminton stored ON still pairs coloured (the stored on is read as it always was).
    const on = await swissRig(BADMINTON, 4, 3);
    await sql`update stages set config = config || ${sql.json({ chess: true })} where id = ${on.stageId}`;
    await pair(on);
    expect(await chessHandedToTheEngine(() => pair(on)), "badminton stored on: colours").toEqual([true]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The sequence: edit rounds, Pair, Undo (Task 5's barrier; C12a — written to the engine's walk)
// ---------------------------------------------------------------------------------------------------------------------

describe.runIf(HAS_DB)("X-SW-17 edit rounds, Pair, Undo", () => {
  for (const s of SPORTS) {
    it(`the first Undo inverts the Pair; the next one refuses SWISS_ROUNDS_CHANGE_NOT_UNDOABLE by name (${s.sport})`, async () => {
      const rig = await swissRig(s, 5, 4);
      await pair(rig); // the mint
      await patchSwissStage(rig.auth, rig.stageId, { rounds: 3 });
      await pair(rig); // Pair round 1
      expect(seatedIn(roundOf(await rowsOf(rig.stageId), 1)).length, "premise: round 1 seated").toBe(5);
      await undoDivision(rig.auth, rig.divisionId);
      expect(seatedIn(roundOf(await rowsOf(rig.stageId), 1)), "C12a: the first Undo clears round 1's seats").toEqual([]);
      const rows = await rowsOf(rig.stageId);
      const ledger = await ledgerState(rig.divisionId);
      // The next Undo would invert the mint, which precedes the round change: refused by name, nothing written.
      await expect(undoDivision(rig.auth, rig.divisionId)).rejects.toMatchObject(refusal("SWISS_ROUNDS_CHANGE_NOT_UNDOABLE"));
      expect(await rowsOf(rig.stageId)).toEqual(rows);
      expect(await ledgerState(rig.divisionId)).toEqual(ledger);
      expect(roundsIn(rows), "the edited count's shells stand").toEqual([1, 2, 3]);
    }, 120_000);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// The desk's read (Phase 2): the rail's "Rounds: N · Edit", its More menu's "Add a round" and the chess switch are drawn
// from `listSwissRoundControls` — the SAME predicates the writes judge by, so what the desk offers is what goes through.
// ---------------------------------------------------------------------------------------------------------------------

describe.runIf(HAS_DB)("listSwissRoundControls (the desk's view of the rounds lock and Add a round)", () => {
  it("the empty case: a division with no Swiss stage has no controls; a league stage beside a Swiss is not listed", async () => {
    const rig = await swissRig(SPORTS[0], 4, 3);
    const [league] = await createStages(rig.auth, rig.divisionId, { seq: 2, kind: "league", name: "L", config: {}, progression: null });
    const controls = await listSwissRoundControls(rig.auth, rig.divisionId);
    expect(Object.keys(controls), "the Swiss only").toEqual([rig.stageId]);
    expect(controls).not.toHaveProperty(league!.id);
    const none = await swissRig(SPORTS[0], 4, 3);
    await sql`delete from stages where id = ${none.stageId}`;
    expect(await listSwissRoundControls(none.auth, none.divisionId)).toEqual({});
  });

  for (const s of SPORTS) {
    it(`before the first start: editable, the next Pair's field, and chess as stored; after it: started (${s.sport})`, async () => {
      // A field of 5 on 3 rounds: hard max 5 (rulebook §3.1), so a 4th round fits.
      const rig = await swissRig(s, 5, 3);
      const before = (await listSwissRoundControls(rig.auth, rig.divisionId))[rig.stageId]!;
      expect(before).toEqual({
        started: false,
        rounds: 3,
        // T8: a boardgame Swiss is created with chess on; any other sport stores none (off).
        chess: s.sport === "boardgame",
        field: 5,
        addRound: { canAddRound: true, refusal: null, field: 5, hardMax: HARD_MAX(5) },
        // T13: nothing is played, so there is nothing to finish with (the predicate's k = 0).
        finish: { canFinish: false, refusal: "nothing_played", finishedAfter: 0, inProgress: false, completeInstead: false },
      });
      await startDivision(rig.auth, rig.divisionId);
      await pair(rig);
      // A bye alone is no start (Task 3): the round-1 bye is awarded at Pair.
      expect((await listSwissRoundControls(rig.auth, rig.divisionId))[rig.stageId]!.started, "the bye alone").toBe(false);
      await startBoard(rig, boardsOf(await rowsOf(rig.stageId), 1)[0]!);
      const after = (await listSwissRoundControls(rig.auth, rig.divisionId))[rig.stageId]!;
      expect(after.started, "one core.start").toBe(true);
      // The read and the write agree: started ⇒ the PATCH is locked.
      await expect(patchSwissStage(rig.auth, rig.stageId, { rounds: 3 })).rejects.toMatchObject(refusal("SWISS_ROUNDS_LOCKED"));
    }, 120_000);
  }

  it("canAddRound is exactly whether Add a round goes through (n = 3..6, at and one below the hard max, then over; badminton — arithmetic on the field)", async () => {
    const { auth } = await seedOrg("pro");
    let checked = 0;
    let offered = 0;
    for (const n of [3, 4, 5, 6]) {
      for (const rounds of [HARD_MAX(n) - 1, HARD_MAX(n)]) {
        const rig = await swissRig(SPORTS[0], n, rounds, auth);
        await startDivision(rig.auth, rig.divisionId);
        await pair(rig);
        await startBoard(rig, boardsOf(await rowsOf(rig.stageId), 1)[0]!);
        const control = (await listSwissRoundControls(rig.auth, rig.divisionId))[rig.stageId]!;
        // The rulebook's answer: one more round fits iff rounds + 1 ≤ hard max.
        expect(control.addRound.canAddRound, `n=${n} rounds=${rounds}`).toBe(rounds + 1 <= HARD_MAX(n));
        if (control.addRound.canAddRound) {
          await expect(addSwissRound(rig.auth, rig.stageId), `n=${n} rounds=${rounds}: offered → it adds`).resolves.toMatchObject({ rounds: rounds + 1 });
          offered++;
        } else {
          expect(control.addRound, `n=${n} rounds=${rounds}: the reason the desk shows`).toEqual({
            canAddRound: false,
            refusal: "above_max",
            field: n,
            hardMax: HARD_MAX(n),
          });
          // No round complete yet (one board started): Finish now cannot resolve it — 422 as sent (T12 status rule).
          await expect(addSwissRound(rig.auth, rig.stageId), `n=${n} rounds=${rounds}: not offered`).rejects.toMatchObject({
            status: 422,
            code: "SWISS_ROUNDS_ABOVE_MAX",
            extra: { canFinish: false, hardMax: HARD_MAX(n) },
          });
        }
        checked++;
      }
    }
    expect(checked, "anti-vacuity: (n, rounds) cells").toBe(8);
    expect(offered, "both answers reached").toBe(4);

    // Over: a complete Swiss offers nothing, and the write agrees.
    const done = await swissRig(SPORTS[0], 4, 1, auth);
    await startDivision(done.auth, done.divisionId);
    await pair(done);
    await playRound(done, 1);
    await completeStage(done.auth, done.stageId);
    expect((await listSwissRoundControls(done.auth, done.divisionId))[done.stageId]!.addRound).toEqual({
      canAddRound: false,
      refusal: "over",
      field: null,
      hardMax: null,
    });
    await expect(addSwissRound(done.auth, done.stageId)).rejects.toMatchObject(refusal("SWISS_OVER"));
  }, 300_000);

  it("a Swiss stored without a valid round count offers no control (its own Generate refuses it, CONFIG_INVALID); the others stay", async () => {
    const rig = await swissRig(SPORTS[0], 4, 3);
    const [second] = await createStages(rig.auth, rig.divisionId, { seq: 2, kind: "swiss", name: "S2", config: { rounds: 2 }, progression: null });
    expect(Object.keys(await listSwissRoundControls(rig.auth, rig.divisionId)).sort(), "premise: both listed").toEqual([rig.stageId, second!.id].sort());
    await sql`update stages set config = config - 'rounds' where id = ${second!.id}`;
    expect(Object.keys(await listSwissRoundControls(rig.auth, rig.divisionId))).toEqual([rig.stageId]);
  });

  it("another organisation's division reads as no controls (RLS), never another club's stages", async () => {
    const rig = await swissRig(SPORTS[0], 4, 3);
    const other = await seedOrg("pro");
    expect(await listSwissRoundControls(other.auth, rig.divisionId)).toEqual({});
  });
});

// Ruling 257: the predicate's call arm runs `liveCallSql` (match-day-call.ts), whose own aliases are `fc` and `g`. A caller
// aliasing the fixtures row `g` or `fc` would collide with them and silently read "any live call in the organisation" — so
// the predicate refuses those two aliases by name (an assumption made a guard, with the test that reaches it). Sport-free.
describe.runIf(HAS_DB)("swissBoardStartedSql refuses the aliases liveCallSql owns", () => {
  it("both of `LIVE_CALL_ALIASES` throw; the aliases the callers use (`f`, default) build", () => {
    const owned = Object.values(LIVE_CALL_ALIASES);
    expect(owned, "anti-vacuity: the call row's alias and its fixture's").toHaveLength(2);
    const refused = owned.map((alias) => {
      try {
        swissBoardStartedSql(sql as never, alias);
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    });
    expect(refused.length, "anti-vacuity: every owned alias tried").toBe(owned.length);
    for (const m of refused) expect(m, "refused by name").toEqual(expect.stringMatching(/liveCallSql/));
    expect(() => swissBoardStartedSql(sql as never, "f")).not.toThrow();
    expect(() => swissBoardStartedSql(sql as never)).not.toThrow();
  });
});
