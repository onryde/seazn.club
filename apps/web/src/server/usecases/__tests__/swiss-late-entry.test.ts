// W3 Task 9 — "Add late player" through the organiser's Add (`createEntrants` → `admitSwissLateEntrant`), on Postgres
// (spec 2026-10-31-format-matrix-w3-swiss-design.md §4, ruling 250; rules X-SW-12 and X-SW-14):
//   (a) nothing in the round started → the round is re-paired with the newcomer; every slot keeps its time and court;
//   (b) a board started and the round has a bye → the newcomer plays the bye holder; nothing else moves;
//   (c) otherwise → round frozen, the newcomer joins the next round's Pair;
//   no round left → 409 SWISS_NO_ROUND_LEFT (canAddRound), the Swiss over → 422 SWISS_OVER, nothing written.
//
// Every case runs for badminton AND chess (boardgame) through one body. Expected values come from the rulebook and the
// plan's rule list — the case, the round the newcomer plays first, the colours FIDE allows — and from the rows as they
// stood BEFORE the add, never from the code under test.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql, withTenant } from "@/lib/db";
import { byeAward } from "@/lib/fixture-bye";
import { SWISS_REFUSALS, type SwissRefusalCode } from "@/lib/swiss-refusals";
import { builtinModules } from "@seazn/engine/sports";
import { pairRound, type Colour } from "@seazn/engine/scheduling";
import type { AnySportModule } from "@seazn/engine/sport";
import type { AuthCtx } from "@/server/api-v1/auth";
import { resolveModule } from "@/server/engine-db";
import { forfeitPlayedFacts } from "@/server/engine-db/forfeit-played";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { undoDivision } from "../history";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { buildSwissHistory, createStages, generateStageFixtures, type SwissExistingFixture } from "../stages";
import { admitSwissLateEntrant } from "../swiss-late-entry";
import { createCourt, createVenue } from "../venues";
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

const SPORTS = [
  { sport: "badminton", variant: "bwf" },
  { sport: "boardgame", variant: "classical" },
] as const;
type Sport = (typeof SPORTS)[number];

const mod = (key: string): AnySportModule => {
  const m = builtinModules.find((x) => x.key === key);
  if (m === undefined) throw new Error(`no sport ${key}`);
  return m as AnySportModule;
};

type EntrantKind = "individual" | "pair" | "team";
const refusal = (code: SwissRefusalCode) => ({ status: SWISS_REFUSALS[code].status, code });
const LOCKED_SENTENCE = "This tournament has started — the entrant list is locked. Withdrawing entrants still works.";

interface Rig {
  sport: Sport;
  auth: AuthCtx;
  divisionId: string;
  stageId: string;
  kind: EntrantKind;
  /** Entrant ids by seed, P1..Pn. */
  entrants: string[];
}

/** N seeded players, a Swiss of `rounds`, started (the shells minted, the division active and scorable). */
async function swissRig(sport: Sport, n: number, rounds: number): Promise<Rig> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Late entry " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: sport.sport,
    variant_key: sport.variant,
    config: {},
  });
  const kind = (mod(sport.sport).entrantModel?.defaultKind ?? "individual") as EntrantKind;
  const made = await createEntrants(
    auth,
    division.id,
    Array.from({ length: n }, (_, i) => ({ kind, display_name: `P${i + 1}`, seed: i + 1, members: [] })),
  );
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "swiss", name: "Swiss", config: { rounds }, progression: null });
  await startDivision(auth, division.id);
  return { sport, auth, divisionId: division.id, stageId: stage!.id, kind, entrants: made.map((e) => e.id) };
}

interface Row {
  id: string;
  ext_key: string | null;
  round_no: number;
  seq_in_round: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
  outcome: { kind?: string; winner?: string; loser?: string | null; reason?: string } | null;
  scheduled_at: Date | null;
  court_id: string | null;
  venue_id: string | null;
  schedule_locked: boolean;
}

const rowsOf = (stageId: string) =>
  sql<Row[]>`
    select id, ext_key, round_no, seq_in_round, home_entrant_id, away_entrant_id, status, outcome,
           scheduled_at, court_id, venue_id, schedule_locked
    from fixtures where stage_id = ${stageId} order by round_no, seq_in_round`;
const roundOf = (rows: readonly Row[], r: number) => rows.filter((f) => f.round_no === r);
const isBye = (f: Row) => /^sw-r\d+-bye$/.test(f.ext_key ?? "");
const boardsOf = (rows: readonly Row[], r: number) => roundOf(rows, r).filter((f) => !isBye(f));
const seatedIn = (rows: readonly Row[]) => rows.flatMap((f) => [f.home_entrant_id, f.away_entrant_id]).filter((x): x is string => x !== null);
const pair = (rig: Rig) => generateStageFixtures(rig.auth, rig.stageId);

/** The scorer's first event: the board has started. */
async function startBoard(rig: Rig, f: Row): Promise<void> {
  await scoreEvent(rig.auth, f.id, { expected_seq: 0, type: "core.start", payload: {} });
}

/** The scorer's quick result: the home side wins. Real events through the scoring use-case. */
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

/** The organiser's Add of one unseeded player — the product path, `createEntrants`. */
async function addLate(rig: Rig, name: string) {
  const [row] = await createEntrants(rig.auth, rig.divisionId, [{ kind: rig.kind, display_name: name, members: [] }]);
  return row!;
}

async function lateRows(divisionId: string) {
  return sql<{ seq: number; payload: Record<string, unknown> }[]>`
    select seq::int as seq, payload from division_events where division_id = ${divisionId} and type = 'swiss_late_entry' order by seq`;
}

async function firstRoundOf(entrantId: string) {
  const [e] = await sql<{ swiss_first_round: number | null; swiss_first_round_stage_id: string | null }[]>`
    select swiss_first_round, swiss_first_round_stage_id from entrants where id = ${entrantId}`;
  return e!;
}

async function ledgerState(divisionId: string) {
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from division_events where division_id = ${divisionId}`;
  const [d] = await sql<{ seq: string | number; edit_watermark: string | number | null }[]>`
    select seq, edit_watermark from divisions where id = ${divisionId}`;
  return { events: n, seq: Number(d!.seq), watermark: d!.edit_watermark === null ? null : Number(d!.edit_watermark) };
}

/** Courts for the division's schedule settings, and a time the round's boards are placed at. */
async function placeRound(rig: Rig, round: number, courtCount: number, settingsCourts: number): Promise<{ courts: string[]; at: string }> {
  const venue = await createVenue(rig.auth, { name: "Hall " + randomUUID().slice(0, 4), sort: 0 });
  const courts: string[] = [];
  for (let i = 0; i < courtCount; i++) courts.push((await createCourt(rig.auth, venue.id, { name: `Court ${i + 1}`, sort: i, tags: [] })).id);
  const at = "2030-06-01T10:00:00.000Z";
  await sql`
    insert into schedule_settings (division_id, org_id, config)
    values (${rig.divisionId}, ${rig.auth.orgId}, ${sql.json({ courts: courts.slice(0, settingsCourts) } as never)})
    on conflict (division_id) do update set config = excluded.config`;
  const boards = boardsOf(await rowsOf(rig.stageId), round);
  for (const [i, f] of boards.entries()) {
    await sql`update fixtures set scheduled_at = ${at}, court_id = ${courts[i]!}, venue_id = ${venue.id} where id = ${f.id}`;
  }
  return { courts, at };
}

/** Each seated player's opponent in a round ("bye" for the bye). */
function opponentsIn(rows: readonly Row[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of rows) {
    if (isBye(f)) {
      if (f.home_entrant_id) out.set(f.home_entrant_id, "bye");
    } else if (f.home_entrant_id && f.away_entrant_id) {
      out.set(f.home_entrant_id, f.away_entrant_id);
      out.set(f.away_entrant_id, f.home_entrant_id);
    }
  }
  return out;
}

/** The stage's history as the next Pair would read it (T7's played facts included). */
async function historyOf(rig: Rig) {
  const rows = (await rowsOf(rig.stageId)) as unknown as SwissExistingFixture[];
  const [d] = await sql<{ sport_key: string; module_version: string }[]>`select sport_key, module_version from divisions where id = ${rig.divisionId}`;
  const facts = await forfeitPlayedFacts(sql, rows.filter((f) => f.home_entrant_id && f.away_entrant_id), resolveModule(d!.sport_key, d!.module_version));
  const active = await sql<{ id: string; seed: number | null }[]>`
    select id, seed from entrants where division_id = ${rig.divisionId} and status in ('registered','confirmed')`;
  return buildSwissHistory(rows, active.map((e) => ({ ...e, swiss_first_round: null })), facts);
}

/** P-A5 (FIDE C.04.3 A.6): never three games running in one colour, and never a colour lead above two. */
function coloursLegal(seq: readonly Colour[]): boolean {
  let w = 0;
  for (const c of seq) w += c === "W" ? 1 : -1;
  const three = seq.some((c, i) => i >= 2 && seq[i - 1] === c && seq[i - 2] === c);
  return Math.abs(w) <= 2 && !three;
}

for (const s of SPORTS) {
  describe.runIf(HAS_DB)(`W3 T9 Add late player (${s.sport})`, () => {
    it(`X-SW-12 (a) re-pairs round 2 with the newcomer; every slot keeps its time and court (${s.sport})`, async () => {
      const rig = await swissRig(s, 5, 3);
      await pair(rig);
      await playRound(rig, 1);
      await pair(rig); // round 2: two boards and a bye, nothing started
      const { courts, at } = await placeRound(rig, 2, 3, 3);
      const before = await rowsOf(rig.stageId);
      const r2Before = roundOf(before, 2);
      expect(boardsOf(before, 2).length, "premise: round 2 holds two boards").toBe(2);
      expect(r2Before.some(isBye), "premise: and a bye (odd field)").toBe(true);

      const late = await addLate(rig, "Late");
      expect(late.late_entry).toMatchObject({ entrant_id: late.id, stage_id: rig.stageId, case: "a", round: 2 });
      const after = await rowsOf(rig.stageId);
      const r2 = roundOf(after, 2);
      // Six players: three boards, no bye; everyone in the field once, the newcomer included.
      expect(boardsOf(after, 2).length).toBe(3);
      expect(r2.some(isBye), "the even field has no bye").toBe(false);
      const seated = seatedIn(r2);
      expect(new Set(seated).size, "every player seated once").toBe(6);
      expect(seated).toContain(late.id);
      // Every surviving row keeps its id, time and court — only seats changed.
      let kept = 0;
      for (const f of boardsOf(before, 2)) {
        const now = r2.find((x) => x.id === f.id);
        expect(now, `board ${f.ext_key} survives`).toBeDefined();
        expect({ at: now!.scheduled_at?.toISOString(), court: now!.court_id }).toEqual({ at: f.scheduled_at?.toISOString(), court: f.court_id });
        kept++;
      }
      expect(kept, "anti-vacuity: both boards checked").toBe(2);
      // The board the odd→even field needed takes the next free slot: the round's time on the one free court.
      const minted = boardsOf(after, 2).filter((f) => !before.some((b) => b.id === f.id));
      expect(minted.length).toBe(1);
      expect({ at: minted[0]!.scheduled_at?.toISOString(), court: minted[0]!.court_id }).toEqual({ at, court: courts[2] });
      expect(late.late_entry!.new_board).toEqual({ fixture_id: minted[0]!.id, scheduled: true });
      // Other rounds are untouched.
      expect(roundOf(after, 1)).toEqual(roundOf(before, 1));
      // Changed players: exactly those whose opponent differs from before; never the newcomer.
      const was = opponentsIn(r2Before);
      const now = opponentsIn(r2);
      const expectedChanged = [...was.keys()].filter((id) => was.get(id) !== now.get(id)).sort();
      expect(late.late_entry!.repaired).toEqual({ changed_entrant_ids: expectedChanged });
      expect(expectedChanged, "the old bye holder has an opponent now").toContain([...was].find(([, o]) => o === "bye")![0]);
      // Written: the first round (scoped to this stage), one organiser ledger row; the watermark untouched.
      expect(await firstRoundOf(late.id)).toEqual({ swiss_first_round: 2, swiss_first_round_stage_id: rig.stageId });
      const ledger = await lateRows(rig.divisionId);
      expect(ledger.map((e) => e.payload)).toEqual([
        expect.objectContaining({ stage_id: rig.stageId, entrant_id: late.id, case: "a", round: 2, source: "organiser" }),
      ]);
    });

    it(`X-SW-12 (a) mints a board left unscheduled when no court is free (${s.sport})`, async () => {
      const rig = await swissRig(s, 5, 3);
      await pair(rig); // round 1: two boards, a bye
      await placeRound(rig, 1, 2, 2); // the settings name only the two courts the boards hold
      const late = await addLate(rig, "Late");
      expect(late.late_entry).toMatchObject({ case: "a", round: 1 });
      const minted = boardsOf(await rowsOf(rig.stageId), 1).filter((f) => f.scheduled_at === null);
      expect(minted.length, "one board, unplaced").toBe(1);
      expect(late.late_entry!.new_board).toEqual({ fixture_id: minted[0]!.id, scheduled: false });
      expect(minted[0]!.court_id).toBeNull();
    });

    it(`X-SW-12 (a) with an odd result field moves the bye (${s.sport})`, async () => {
      const rig = await swissRig(s, 4, 3);
      await pair(rig);
      await playRound(rig, 1);
      await pair(rig); // round 2: two boards, no bye
      await placeRound(rig, 2, 2, 2);
      const before = await rowsOf(rig.stageId);
      expect(roundOf(before, 2).some(isBye), "premise: an even field has no bye").toBe(false);
      const late = await addLate(rig, "Late");
      expect(late.late_entry).toMatchObject({ case: "a", round: 2 });
      const r2 = roundOf(await rowsOf(rig.stageId), 2);
      const byes = r2.filter(isBye);
      expect(byes.length, "five players: one bye").toBe(1);
      // A bye is not played, so it holds no slot (Task 3, X-SW-29).
      expect({ at: byes[0]!.scheduled_at, court: byes[0]!.court_id, venue: byes[0]!.venue_id }).toEqual({ at: null, court: null, venue: null });
      // FIDE C.04.2 / P-A4: the bye goes to the lowest-ranked player of the lowest score group not byed yet — the newcomer
      // (0 points: round 1 was missed, and a missed round scores 0; unseeded, so ranked below every seed).
      expect(byes[0]!.home_entrant_id).toBe(late.id);
      for (const f of boardsOf(before, 2)) {
        const now = r2.find((x) => x.id === f.id)!;
        expect({ at: now.scheduled_at?.toISOString(), court: now.court_id }).toEqual({ at: f.scheduled_at?.toISOString(), court: f.court_id });
      }
    });

    it(`X-SW-12 (b) the newcomer plays the bye holder; nothing else moves (${s.sport})`, async () => {
      const rig = await swissRig(s, 5, 3);
      await pair(rig);
      await playRound(rig, 1);
      await pair(rig);
      const paired = await rowsOf(rig.stageId);
      await startBoard(rig, boardsOf(paired, 2)[0]!);
      const before = await rowsOf(rig.stageId);
      const byeRow = roundOf(before, 2).find(isBye)!;
      const holder = byeRow.home_entrant_id!;
      const ledgerBefore = await ledgerState(rig.divisionId);

      const late = await addLate(rig, "Late");
      expect(late.late_entry).toMatchObject({ case: "b", round: 2, bye_holder_id: holder });
      const after = await rowsOf(rig.stageId);
      expect(after.some((f) => f.id === byeRow.id), "the bye row is gone").toBe(false);
      const added = after.filter((f) => !before.some((b) => b.id === f.id));
      expect(added.length).toBe(1);
      const board = added[0]!;
      expect(late.late_entry!.new_board).toEqual({ fixture_id: board.id, scheduled: false });
      expect(new Set([board.home_entrant_id, board.away_entrant_id])).toEqual(new Set([holder, late.id]));
      expect({ status: board.status, outcome: board.outcome, round: board.round_no }).toEqual({ status: "scheduled", outcome: null, round: 2 });
      if (s.sport === "badminton") {
        // Non-chess: the engine puts the upper standing — the holder — at home.
        expect(board.home_entrant_id).toBe(holder);
      }
      // Nothing else moved: every other row equal, field for field.
      const others = before.filter((f) => f.id !== byeRow.id);
      expect(after.filter((f) => f.id !== board.id)).toEqual(others);
      expect(others.length, "anti-vacuity: the other rows were compared").toBeGreaterThan(5);
      // The ledger grew by one organiser row; the watermark stands.
      const ledgerAfter = await ledgerState(rig.divisionId);
      expect(ledgerAfter).toEqual({ events: ledgerBefore.events + 1, seq: ledgerBefore.seq + 1, watermark: ledgerBefore.watermark });
      // P-A4: the bye award is gone, so the holder may take the pairing-allocated bye again — with the holder the lowest
      // of a three-player field, the engine hands it to them.
      const hist = await historyOf(rig);
      expect(hist.byes.has(holder), "the holder is bye-eligible again").toBe(false);
      const others3 = rig.entrants.filter((id) => id !== holder).slice(0, 2);
      const odd = pairRound(
        [
          { entrantId: others3[0]!, score: 0, rank: 1 },
          { entrantId: others3[1]!, score: 0, rank: 2 },
          { entrantId: holder, score: 0, rank: 3 },
        ],
        { played: new Set(), byes: hist.byes },
      );
      expect(odd.bye).toBe(holder);
    });

    it(`X-SW-12 (b) the new board key skips a gap (${s.sport})`, async () => {
      const rig = await swissRig(s, 7, 3);
      await pair(rig); // round 1: b1..b3 and a bye
      const r1 = roundOf(await rowsOf(rig.stageId), 1);
      await startBoard(rig, boardsOf(r1, 1)[0]!);
      // A Task 2 re-pack leaves b1, b2, b4.
      await sql`update fixtures set ext_key = 'sw-r1-b4' where id = ${boardsOf(r1, 1)[2]!.id}`;
      const before = boardsOf(await rowsOf(rig.stageId), 1);
      expect(before.map((f) => f.ext_key)).toEqual(["sw-r1-b1", "sw-r1-b2", "sw-r1-b4"]);
      const late = await addLate(rig, "Late");
      expect(late.late_entry).toMatchObject({ case: "b", round: 1 });
      const added = (await rowsOf(rig.stageId)).find((f) => f.id === late.late_entry!.new_board!.fixture_id)!;
      expect(added.ext_key, "largest index + 1, never boards + 1").toBe("sw-r1-b5");
      expect(added.seq_in_round).toBe(Math.max(...before.map((f) => f.seq_in_round)) + 1);
    });

    it(`X-SW-12 admitting the same entrant twice is a no-op (${s.sport})`, async () => {
      const rig = await swissRig(s, 4, 3);
      await pair(rig);
      const late = await addLate(rig, "Late");
      expect(late.late_entry).toMatchObject({ case: "a", round: 1 });
      const seats = await rowsOf(rig.stageId);
      const ledger = await ledgerState(rig.divisionId);
      const again = await withTenant(rig.auth.orgId, (tx) => admitSwissLateEntrant(tx, rig.auth, rig.divisionId, late.id, "organiser"));
      expect(again).toBeNull();
      // A webhook retry's shape too: an automatic second call is as quiet.
      const auto = await withTenant(rig.auth.orgId, (tx) => admitSwissLateEntrant(tx, null, rig.divisionId, late.id, "registration"));
      expect(auto).toBeNull();
      expect(await rowsOf(rig.stageId)).toEqual(seats);
      expect(await ledgerState(rig.divisionId)).toEqual(ledger);
      expect((await lateRows(rig.divisionId)).length, "one ledger row").toBe(1);
    });

    it(`X-SW-12 (c) a started round without a bye: round untouched, newcomer seated in round N+1 at its Pair (${s.sport})`, async () => {
      const rig = await swissRig(s, 4, 3);
      await pair(rig);
      await startBoard(rig, boardsOf(await rowsOf(rig.stageId), 1)[0]!);
      const before = await rowsOf(rig.stageId);
      const late = await addLate(rig, "Late");
      expect(late.late_entry).toEqual({ entrant_id: late.id, stage_id: rig.stageId, case: "c", round: 2 });
      expect(await rowsOf(rig.stageId), "nothing moved").toEqual(before);
      expect(await firstRoundOf(late.id)).toEqual({ swiss_first_round: 2, swiss_first_round_stage_id: rig.stageId });
      await playRound(rig, 1);
      await pair(rig);
      const r2 = roundOf(await rowsOf(rig.stageId), 2);
      expect(seatedIn(r2)).toContain(late.id);
      expect(new Set(seatedIn(r2)).size, "five players in round 2").toBe(5);
    });

    it(`X-SW-12 case (a) never runs over a board an online game stands behind (${s.sport})`, async () => {
      const rig = await swissRig(s, 5, 3);
      await pair(rig); // two boards and a bye, nothing scored
      const board = boardsOf(await rowsOf(rig.stageId), 1)[0]!;
      await sql`
        insert into fixture_external_play (fixture_id, org_id, scheduled_at_basis, status, challenge_id)
        values (${board.id}, ${rig.auth.orgId}, now(), 'ready', ${"gm-" + randomUUID().slice(0, 8)})`;
      const before = await rowsOf(rig.stageId);
      const late = await addLate(rig, "Late");
      // Not (a): the game's board is started (Review Focus 1). The bye is free, so (b) — and no 500.
      expect(late.late_entry).toMatchObject({ case: "b", round: 1 });
      const after = await rowsOf(rig.stageId);
      expect(after.find((f) => f.id === board.id)).toEqual(board);
      expect(after.filter((f) => !isBye(f) && before.some((b) => b.id === f.id))).toEqual(before.filter((f) => !isBye(f)));
    });

    it(`X-SW-12 a board decided with no event behind it (a two-sided walkover) counts as started (${s.sport})`, async () => {
      const rig = await swissRig(s, 4, 3);
      await pair(rig); // two boards, no bye
      const board = boardsOf(await rowsOf(rig.stageId), 1)[0]!;
      await sql`update fixtures set status = 'forfeited',
                  outcome = ${sql.json({ kind: "award", winner: board.home_entrant_id, loser: board.away_entrant_id, reason: "walkover" } as never)}
                where id = ${board.id}`;
      const late = await addLate(rig, "Late");
      // Spec §4: decided other than the bye is started — no re-pair over a settled board; no bye, so (c).
      expect(late.late_entry).toMatchObject({ case: "c", round: 2 });
    });

    it(`X-SW-12 an open device link counts as started; a revoked one does not (C5) (${s.sport})`, async () => {
      const rig = await swissRig(s, 4, 3);
      await pair(rig); // two boards, no bye
      const board = boardsOf(await rowsOf(rig.stageId), 1)[0]!;
      const [{ user_id: issuer }] = await sql<{ user_id: string }[]>`select user_id from org_members where org_id = ${rig.auth.orgId} limit 1`;
      const [link] = await sql<{ id: string }[]>`
        insert into device_links (org_id, fixture_id, token_hash, label, issued_by, expires_at)
        values (${rig.auth.orgId}, ${board.id}, ${"t-" + randomUUID()}, null, ${issuer}, null) returning id`;
      const first = await addLate(rig, "Late 1");
      // A scorer may be on court: the round is started, it has no bye — (c).
      expect(first.late_entry).toMatchObject({ case: "c", round: 2 });
      // The positive pair: revoked, the link counts for nothing and the round re-pairs.
      await sql`update device_links set revoked_at = now() where id = ${link!.id}`;
      const second = await addLate(rig, "Late 2");
      expect(second.late_entry).toMatchObject({ case: "a", round: 1 });
      const r1 = roundOf(await rowsOf(rig.stageId), 1);
      expect(seatedIn(r1), "the re-pair seats the second newcomer").toContain(second.id);
      expect(seatedIn(r1), "and not the first, whose first round is 2").not.toContain(first.id);
    });

    it(`X-SW-12 sequence: a second late player in the same round — (a) then (a); (b) then (c) (${s.sport})`, async () => {
      // (a) then (a): nothing started, so each newcomer re-pairs the round again.
      const a = await swissRig(s, 4, 3);
      await pair(a);
      const l1 = await addLate(a, "Late 1");
      expect(l1.late_entry).toMatchObject({ case: "a", round: 1 });
      expect(roundOf(await rowsOf(a.stageId), 1).filter(isBye).length, "five: a bye").toBe(1);
      const l2 = await addLate(a, "Late 2");
      expect(l2.late_entry).toMatchObject({ case: "a", round: 1 });
      const r1 = roundOf(await rowsOf(a.stageId), 1);
      expect(r1.filter(isBye).length, "six: no bye").toBe(0);
      expect(new Set(seatedIn(r1))).toEqual(new Set([...a.entrants, l1.id, l2.id]));
      // (b) then (c): the first takes the bye, so the row is gone and the second joins the next round.
      const b = await swissRig(s, 5, 3);
      await pair(b);
      await startBoard(b, boardsOf(await rowsOf(b.stageId), 1)[0]!);
      const m1 = await addLate(b, "Late 1");
      expect(m1.late_entry).toMatchObject({ case: "b", round: 1 });
      const m2 = await addLate(b, "Late 2");
      expect(m2.late_entry).toMatchObject({ case: "c", round: 2 });
    });

    it(`X-SW-12 sequence: a late player after a withdrawal (${s.sport})`, async () => {
      const rig = await swissRig(s, 5, 3);
      await pair(rig);
      await playRound(rig, 1);
      await pair(rig);
      const r2 = roundOf(await rowsOf(rig.stageId), 2);
      const leaver = boardsOf(r2, 2)[0]!.home_entrant_id!;
      await withdrawEntrantCascade(rig.auth, leaver);
      // The withdrawal walked the board over: a decided board is a started one (spec §4), so not (a); the bye is free.
      const late = await addLate(rig, "Late");
      expect(late.late_entry).toMatchObject({ case: "b", round: 2 });
      const board = (await rowsOf(rig.stageId)).find((f) => f.id === late.late_entry!.new_board!.fixture_id)!;
      expect([board.home_entrant_id, board.away_entrant_id]).not.toContain(leaver);
    });

    it(`X-SW-12 sequence: a late player after an Undo of Pair next (${s.sport})`, async () => {
      const rig = await swissRig(s, 5, 3);
      await pair(rig);
      await playRound(rig, 1);
      await pair(rig);
      await undoDivision(rig.auth, rig.divisionId); // round 2 back onto its shells
      expect(seatedIn(roundOf(await rowsOf(rig.stageId), 2)), "premise: round 2 unseated").toEqual([]);
      const late = await addLate(rig, "Late");
      // Between rounds: the next round, whoever asks.
      expect(late.late_entry).toMatchObject({ case: "c", round: 2 });
      await pair(rig);
      expect(seatedIn(roundOf(await rowsOf(rig.stageId), 2))).toContain(late.id);
    });

    it(`X-SW-12 sequence: (b) then Undo then Withdraw (${s.sport})`, async () => {
      const rig = await swissRig(s, 5, 3);
      await pair(rig);
      await playRound(rig, 1);
      await pair(rig);
      await startBoard(rig, boardsOf(await rowsOf(rig.stageId), 2)[0]!);
      const late = await addLate(rig, "Late");
      expect(late.late_entry).toMatchObject({ case: "b", round: 2 });
      const holder = late.late_entry!.bye_holder_id!;
      const before = await rowsOf(rig.stageId);
      const ledger = await ledgerState(rig.divisionId);
      // Review Focus 2: no Undo crosses an organiser's late entry — refused by name, nothing cleared.
      await expect(undoDivision(rig.auth, rig.divisionId)).rejects.toMatchObject(refusal("SWISS_LATE_ENTRY_NOT_UNDOABLE"));
      expect(await rowsOf(rig.stageId)).toEqual(before);
      expect(await ledgerState(rig.divisionId)).toEqual(ledger);
      // Withdraw is the way back: the board walks over to the holder.
      const scoreBefore = (await historyOf(rig)).score.get(holder) ?? 0;
      await withdrawEntrantCascade(rig.auth, late.id);
      const board = (await rowsOf(rig.stageId)).find((f) => f.id === late.late_entry!.new_board!.fixture_id)!;
      expect(board.outcome).toMatchObject({ kind: "award", winner: holder });
      // A win without play bars the pairing-allocated bye (P-A4, FIDE C.04.1(d)), and the walkover pays the win.
      const hist = await historyOf(rig);
      expect(hist.score.get(holder), "the walkover pays the holder a win (rulebook §4: 1 point)").toBe(scoreBefore + 1);
      expect(hist.byes.has(holder)).toBe(true);
    });

    it(`C17 before Start an entrant added to a Swiss division is no late player: no stamp, no ledger row (${s.sport})`, async () => {
      const { auth } = await seedOrg("pro");
      const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Pre-start " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
      const division = await createDivision(auth, comp.id, {
        name: "Open",
        slug: "open-" + randomUUID().slice(0, 6),
        sport_key: s.sport,
        variant_key: s.variant,
        config: {},
      });
      const kind = (mod(s.sport).entrantModel?.defaultKind ?? "individual") as EntrantKind;
      await createEntrants(auth, division.id, Array.from({ length: 4 }, (_, i) => ({ kind, display_name: `P${i + 1}`, seed: i + 1, members: [] })));
      const [stage] = await createStages(auth, division.id, { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 3 }, progression: null });
      await generateStageFixtures(auth, stage!.id); // the mint
      await generateStageFixtures(auth, stage!.id); // Pair round 1, before Start
      expect(seatedIn(roundOf(await rowsOf(stage!.id), 1)).length, "premise: round 1 seated before Start").toBe(4);
      const [row] = await createEntrants(auth, division.id, [{ kind, display_name: "Fifth", members: [] }]);
      expect(row!.late_entry, "spec §4: before Start nothing changes").toBeUndefined();
      expect(await firstRoundOf(row!.id)).toEqual({ swiss_first_round: null, swiss_first_round_stage_id: null });
      expect(await lateRows(division.id)).toEqual([]);
    });

    it(`X-SW-14 the last round started: refusal SWISS_NO_ROUND_LEFT with canAddRound true; nothing written (${s.sport})`, async () => {
      const rig = await swissRig(s, 4, 1);
      await pair(rig);
      await startBoard(rig, boardsOf(await rowsOf(rig.stageId), 1)[0]!);
      const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from entrants where division_id = ${rig.divisionId}`;
      const ledger = await ledgerState(rig.divisionId);
      const seats = await rowsOf(rig.stageId);
      await expect(
        createEntrants(rig.auth, rig.divisionId, [
          { kind: rig.kind, display_name: "Late 1", members: [] },
          { kind: rig.kind, display_name: "Late 2", members: [] },
        ]),
      ).rejects.toMatchObject({ ...refusal("SWISS_NO_ROUND_LEFT"), extra: { canAddRound: true } });
      const [{ n: after }] = await sql<{ n: number }[]>`select count(*)::int as n from entrants where division_id = ${rig.divisionId}`;
      expect(after, "the whole batch rolled back").toBe(n);
      expect(await ledgerState(rig.divisionId)).toEqual(ledger);
      expect(await rowsOf(rig.stageId)).toEqual(seats);
    });

    it(`X-SW-14 the Swiss is complete (or its knockout has a started fixture): SWISS_OVER (${s.sport})`, async () => {
      const done = await swissRig(s, 4, 1);
      await pair(done);
      await playRound(done, 1);
      await sql`update stages set status = 'complete' where id = ${done.stageId}`;
      await expect(addLate(done, "Late")).rejects.toMatchObject({ ...refusal("SWISS_OVER"), extra: { canAddRound: false } });
      // Still running, but a later stage has a match under way: over all the same.
      const ko = await swissRig(s, 4, 3);
      await pair(ko);
      const [koStage] = await sql<{ id: string }[]>`
        insert into stages (division_id, seq, kind, name, config) values (${ko.divisionId}, 2, 'knockout', 'KO', '{}') returning id`;
      await sql`
        insert into fixtures (stage_id, division_id, round_no, seq_in_round, home_entrant_id, away_entrant_id, status)
        values (${koStage!.id}, ${ko.divisionId}, 1, 1, ${ko.entrants[0]!}, ${ko.entrants[1]!}, 'in_play')`;
      const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from entrants where division_id = ${ko.divisionId}`;
      await expect(addLate(ko, "Late")).rejects.toMatchObject({ ...refusal("SWISS_OVER"), extra: { canAddRound: false } });
      const [{ n: after }] = await sql<{ n: number }[]>`select count(*)::int as n from entrants where division_id = ${ko.divisionId}`;
      expect(after).toBe(n);
    });
  });
}

describe.runIf(HAS_DB)("W3 T9 the Start lock's other formats (badminton)", () => {
  // single-sport: badminton — the lock reads the stage KIND, never the sport.
  async function startedWith(kind: "league" | "ladder") {
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Lock " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
    const division = await createDivision(auth, comp.id, {
      name: "Open",
      slug: "open-" + randomUUID().slice(0, 6),
      sport_key: "badminton",
      variant_key: "bwf",
      config: {},
    });
    await createEntrants(auth, division.id, Array.from({ length: 4 }, (_, i) => ({ kind: "individual", display_name: `P${i + 1}`, seed: i + 1, members: [] })));
    await createStages(auth, division.id, { seq: 1, kind, name: kind, config: {}, progression: null });
    await sql`update divisions set status = 'active' where id = ${division.id}`;
    return { auth, divisionId: division.id };
  }

  it("a non-Swiss started division still refuses with the existing sentence", async () => {
    const { auth, divisionId } = await startedWith("league");
    await expect(createEntrants(auth, divisionId, [{ kind: "individual", display_name: "Late", members: [] }])).rejects.toMatchObject({
      status: 422,
      message: LOCKED_SENTENCE,
    });
  });

  it("a ladder/americano division still accepts", async () => {
    const { auth, divisionId } = await startedWith("ladder");
    const [row] = await createEntrants(auth, divisionId, [{ kind: "individual", display_name: "Late", members: [] }]);
    expect(row!.display_name).toBe("Late");
    expect(row!.late_entry).toBeUndefined();
    expect(row!.swiss_first_round).toBeNull();
  });
});

describe.runIf(HAS_DB)("W3 T9 (b) colours (boardgame)", () => {
  // single-sport: boardgame — only chess pairs colours; a badminton board has no White.
  it("X-SW-12 (b) a chess bye holder with a White-White history gets Black", async () => {
    const rig = await swissRig(SPORTS[1], 5, 4);
    const [stage] = await sql<{ config: Record<string, unknown> }[]>`select config from stages where id = ${rig.stageId}`;
    expect(stage!.config.chess, "premise: a boardgame Swiss pairs colours (BG-SW-1)").toBe(true);
    const [H, A, B, C, D] = rig.entrants as [string, string, string, string, string];
    const win = (w: string, l: string) => sql.json({ kind: "win", winner: w, loser: l } as never);
    const seat = async (key: string, home: string, away: string | null, decided: boolean) => {
      if (away === null) {
        await sql`update fixtures set home_entrant_id = ${home}, away_entrant_id = null, status = 'forfeited',
                    outcome = ${sql.json(byeAward(home) as never)} where stage_id = ${rig.stageId} and ext_key = ${key}`;
      } else {
        await sql`update fixtures set home_entrant_id = ${home}, away_entrant_id = ${away},
                    status = ${decided ? "decided" : "scheduled"}, outcome = ${decided ? win(home, away) : null}
                  where stage_id = ${rig.stageId} and ext_key = ${key}`;
      }
    };
    // Rounds 1 and 2: H White (home) both times. Round 3: H has the bye; no pair repeats.
    await seat("sw-r1-b1", H, A, true);
    await seat("sw-r1-b2", B, C, true);
    await seat("sw-r1-bye", D, null, true);
    await seat("sw-r2-b1", H, B, true);
    await seat("sw-r2-b2", A, D, true);
    await seat("sw-r2-bye", C, null, true);
    await seat("sw-r3-b1", A, C, false);
    await seat("sw-r3-b2", B, D, false);
    await seat("sw-r3-bye", H, null, true);
    const r3 = boardsOf(await rowsOf(rig.stageId), 3);
    await startBoard(rig, r3[0]!);
    const late = await addLate(rig, "Late");
    expect(late.late_entry).toMatchObject({ case: "b", round: 3, bye_holder_id: H });
    const board = (await rowsOf(rig.stageId)).find((f) => f.id === late.late_entry!.new_board!.fixture_id)!;
    // P-A5 (FIDE C.04.3 A.6): H has played White twice running, so a third White is barred — H takes Black, the newcomer
    // White (home = White).
    expect(coloursLegal(["W", "W", "W"]), "the rule's own reading: WWW is illegal").toBe(false);
    expect(coloursLegal(["W", "W", "B"])).toBe(true);
    expect({ home: board.home_entrant_id, away: board.away_entrant_id }).toEqual({ home: late.id, away: H });
  });
});
