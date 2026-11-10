// W4 app-A Task 13 (K9; rules X-LL-1…X-LL-5; rulebook RB4-V1…V6, RB4-E7; pre-flight C2, D10, R7) — a departed
// qualifier's main-draw seat takes a LUCKY LOSER, driven through the real doors on a real database: the catalogue's own
// templates (`buildTemplateStages`), Start, the scorer (`scoreEvent`), Complete, the seed proposal and its confirm, and the
// withdrawal cascade (`withdrawEntrantCascade`). Main walked the opponent over (stages.ts F14; the cascade).
//
// Expected values: the rulebook's — the best loser below the cut (RB4-V2) is the qualifying bracket's latest-round loser,
// by seed (C2), read here off the rows (who lost which quarter-final) and the qualifying stage's own final ranks (the
// placement snapshot, RB4-V4); a walkover loser never draws (RB4-V5); the lot among equal-round unseeded losers is the
// house draw with the DESTINATION's seed (`swissRoundOneOrder(swissDrawSeed(main))`, W3 X-SW-22 / W4 T7 — the one
// definition of "drawn" here), with a differential case against the id order and the source's own seed (D10: the tie is
// built through a REAL qualifying stage). Never from the code under test.
//
// Sports: X-LL-1 sweeps badminton singles, badminton pairs and chess (the boardgame module, individual only), each picked
// from the engine registry by key; the rest run on badminton singles — they read seats, seeds and how a line was lost,
// which no sport field reaches.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import { buildTemplateStages } from "@/lib/format-templates";
import { swissDrawSeed, swissRoundOneOrder } from "@/lib/swiss-draw";
import type { AuthCtx } from "@/server/api-v1/auth";
import { CreateStage, WithdrawCascadeReport } from "@/server/api-v1/schemas";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { callFixtureToCourt } from "../match-day-call";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { completeStage, confirmSeedProposal, createStages, generateStageFixtures, getSeedProposal } from "../stages";
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

interface SportPick {
  key: string;
  variant: string;
  kind: "individual" | "pair";
}
/** A sport by key from the engine's registry, its first declared variant, and an entrant kind it declares. */
function sport(key: string, kind?: "individual" | "pair"): SportPick {
  const m = builtinModules.find((x) => x.key === key);
  if (m === undefined) throw new Error(`no engine module ${key}`);
  const variant = Object.keys(m.variants)[0];
  if (variant === undefined) throw new Error(`${key} declares no variant`);
  const declared = (m.entrantModel?.kinds ?? ["individual"]) as string[];
  const k = kind ?? ((m.entrantModel?.defaultKind ?? "individual") as SportPick["kind"]);
  if (!declared.includes(k)) throw new Error(`${key} declares no ${k} entrant`);
  return { key, variant, kind: k };
}
const SINGLES = sport("badminton", "individual");
const PAIRS = sport("badminton", "pair");
const CHESS = sport("boardgame");

type Template = "qualifying_main" | "league_ko" | "groups_ko";

interface Row {
  id: string;
  round_no: number;
  seq_in_round: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
  outcome: { kind?: string; reason?: string; winner?: string; loser?: string | null } | null;
}

interface Rig {
  auth: AuthCtx;
  divisionId: string;
  sport: SportPick;
  /** [source, destination]. */
  stageIds: [string, string];
  /** id → "E<n>", E1 the strongest; and back. */
  nameOf: Map<string, string>;
  idOf: Map<string, string>;
}

const rowsOf = (stageId: string) =>
  sql<Row[]>`
    select id, round_no, seq_in_round, home_entrant_id, away_entrant_id, status, outcome
      from fixtures where stage_id = ${stageId} order by round_no, seq_in_round, id`;

async function post(auth: AuthCtx, fixtureId: string, type: string, payload: Record<string, unknown> = {}): Promise<void> {
  const [{ n }] = await sql<{ n: number }[]>`select coalesce(max(seq), 0)::int as n from score_events where fixture_id = ${fixtureId}`;
  await scoreEvent(auth, fixtureId, { expected_seq: n, type, payload });
}

/** A played win for `winner` on `f`, through the scorer's own events (each sport's vocabulary), from a start. */
async function playWin(r: Rig, f: Row, winner: string): Promise<void> {
  await post(r.auth, f.id, "core.start");
  if (r.sport.key === "boardgame") {
    await post(r.auth, f.id, "boardgame.result", { winner, method: "resign" });
    return;
  }
  const home = winner === f.home_entrant_id;
  for (let g = 0; g < 2; g++) await post(r.auth, f.id, "badminton.game.summary", home ? { home: 21, away: 10 } : { home: 10, away: 21 });
}

/** `n` entrants named E1..En (seeded 1..n unless `unseeded`), the template's two stages from the REAL catalogue at `q`,
 *  Started, and the second stage's day-one draw generated. Nothing played. */
async function rig(opts: { template: Template; n: number; q: number; sport?: SportPick; unseeded?: boolean; pools?: number }): Promise<Rig> {
  const s = opts.sport ?? SINGLES;
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "W4 T13 " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: s.key,
    variant_key: s.variant,
    config: {},
  });
  const made = await createEntrants(
    auth,
    division.id,
    Array.from({ length: opts.n }, (_, i) => ({ kind: s.kind, display_name: `E${i + 1}`, seed: opts.unseeded ? null : i + 1, members: [] })),
  );
  const drafts = buildTemplateStages(opts.template, { swissRounds: 5, poolCount: opts.pools ?? 2, legs: 1, qualified: opts.q });
  expect(drafts.length, `rig: ${opts.template} is two stages`).toBe(2);
  expect(drafts[1]!.progression?.timing, "rig: the second stage is drawn at setup and seeded by a confirm").toBe("setup");
  const ids: string[] = [];
  for (const [i, d] of drafts.entries()) {
    const [stage] = await createStages(
      auth,
      division.id,
      CreateStage.parse({ seq: i + 1, kind: d.kind, name: d.name, config: d.config, progression: d.progression }),
    );
    ids.push(stage!.id);
  }
  await startDivision(auth, division.id);
  await generateStageFixtures(auth, ids[1]!);
  return {
    auth,
    divisionId: division.id,
    sport: s,
    stageIds: [ids[0]!, ids[1]!],
    nameOf: new Map(made.map((e) => [e.id, e.display_name])),
    idOf: new Map(made.map((e) => [e.display_name, e.id])),
  };
}

const num = (r: Rig, id: string) => Number(r.nameOf.get(id)!.slice(1));

/** How a source line ends: the winner on court, or a walkover the LOSER's side gave (`core.forfeit{reason:"walkover"}`). */
type Decide = (f: Row) => { winner: string } | { walkover: "home" | "away" };
/** The lower-numbered entrant wins on court, unless `upsets` names the one who loses to the higher number. */
const favourite = (r: Rig, upsets: string[] = []): Decide => (f) => {
  const [a, b] = [f.home_entrant_id!, f.away_entrant_id!];
  const better = num(r, a) < num(r, b) ? a : b;
  const worse = better === a ? b : a;
  return { winner: upsets.includes(r.nameOf.get(better)!) ? worse : better };
};

/** Play the source out by `decide` and complete it; returns the draft proposal Complete computed. */
async function playSource(r: Rig, decide: Decide): Promise<string> {
  for (let guard = 0; guard < 40; guard++) {
    const open = (await rowsOf(r.stageIds[0])).filter((f) => f.home_entrant_id !== null && f.away_entrant_id !== null && f.status === "scheduled");
    if (open.length === 0) break;
    for (const f of open) {
      const d = decide(f);
      if ("walkover" in d) await post(r.auth, f.id, "core.forfeit", { by: d.walkover === "home" ? f.home_entrant_id : f.away_entrant_id, reason: "walkover" });
      else await playWin(r, f, d.winner);
    }
  }
  const done = await completeStage(r.auth, r.stageIds[0]);
  expect(done.completed, "rig: the source completed").toBe(true);
  expect(done.seed_proposal, "rig: a draft proposal for the destination").toBeTruthy();
  return done.seed_proposal!.id;
}

/** Confirm the newest draft, keeping the table's order at any flagged tie. */
async function confirmLatest(r: Rig): Promise<void> {
  const p = await getSeedProposal(r.auth, r.stageIds[1]);
  expect(p?.status, "rig: the newest proposal is a draft").toBe("draft");
  const tiePicks = p!.computed.ties.map((t) => ({ slots: t.slots, order: [...t.entrantIds].sort((a, b) => num(r, a) - num(r, b)) }));
  await confirmSeedProposal(r.auth, r.stageIds[1], { proposalId: p!.id, ...(tiePicks.length > 0 ? { tiePicks } : {}) });
}

/** The destination's round 1, by name: "E1 v E4" (each line's two names in number order — home or away is the fold's), in
 *  line order. */
async function roundOne(r: Rig): Promise<string[]> {
  const name = (id: string | null) => (id === null ? "-" : r.nameOf.get(id)!);
  return (await rowsOf(r.stageIds[1]))
    .filter((f) => f.round_no === 1)
    .map((f) => [name(f.home_entrant_id), name(f.away_entrant_id)].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))).join(" v "));
}

/** The line of the destination's round 1 that seats `id`. */
async function lineOf(r: Rig, id: string): Promise<Row> {
  const line = (await rowsOf(r.stageIds[1])).find((f) => f.round_no === 1 && (f.home_entrant_id === id || f.away_entrant_id === id));
  expect(line, `premise: ${r.nameOf.get(id)} holds a round-1 seat of the main draw`).toBeTruthy();
  return line!;
}

/** The qualifying stage's final ranks — its placement snapshot (RB4-V4), as stored. */
async function finalRanks(stageId: string): Promise<Map<number, string>> {
  const snaps = await sql<{ rows: { entrantId: string; rank: number | null }[] }[]>`
    select rows from standings_snapshots where stage_id = ${stageId}`;
  expect(snaps.length, "premise: the qualifying stage has one placement snapshot").toBe(1);
  return new Map(snaps[0]!.rows.map((row) => [row.rank!, row.entrantId]));
}

/** Withdraw through the cascade and parse its report strictly against the wire schema. */
async function withdraw(r: Rig, id: string) {
  return WithdrawCascadeReport.parse(await withdrawEntrantCascade(r.auth, id));
}

/** The losers of the source's round `round`, each with how they lost. */
async function losersOf(r: Rig, round: number): Promise<{ id: string; reason: string }[]> {
  return (await rowsOf(r.stageIds[0]))
    .filter((f) => f.round_no === round && f.outcome?.loser)
    .map((f) => ({ id: f.outcome!.loser!, reason: f.outcome!.kind === "award" ? f.outcome!.reason! : "played" }));
}

describe.runIf(HAS_DB)("W4 T13 a departed qualifier takes a lucky loser (K9)", () => {
  // qualifying_main of eight at q = 4 (the builder's), the favourite winning every line: the quarter-final losers are
  // E5..E8 (the fold seats 1v8, 4v5, 3v6, 2v7), the main draw seats E1..E4, its round 1 E1 v E4 and E2 v E3.
  for (const s of [SINGLES, PAIRS, CHESS]) {
    it(`X-LL-1 a qualifier withdraws before their first main-draw match: the best loser below the cut takes the slot [${s.key} ${s.kind}]`, async () => {
      const r = await rig({ template: "qualifying_main", n: 8, q: 4, sport: s });
      await playSource(r, favourite(r));
      await confirmLatest(r);
      expect(await roundOne(r), "premise: the main draw as the fold seats E1..E4").toEqual(["E1 v E4", "E2 v E3"]);
      const e4 = r.idOf.get("E4")!;
      const line = await lineOf(r, e4);

      const out = await withdraw(r, e4);

      // RB4-V2: the best loser below the cut — the quarter-finals' best seed (E5); and RB4-V4: the qualifying stage's
      // own final rank q+1 is the same entrant.
      const ranks = await finalRanks(r.stageIds[0]);
      expect(r.nameOf.get(ranks.get(5)!), "premise: the qualifying stage ranks E5 fifth").toBe("E5");
      expect(out.lucky_loser, "the cascade reports the lucky loser and the line").toEqual({ entrant_id: r.idOf.get("E5"), fixture_id: line.id });
      expect(await roundOne(r), "E5 plays E1 in E4's seat; the other line is untouched").toEqual(["E1 v E5", "E2 v E3"]);
      const after = (await rowsOf(r.stageIds[1])).find((f) => f.id === line.id)!;
      expect({ status: after.status, outcome: after.outcome }, "no walkover was written").toEqual({ status: "scheduled", outcome: null });
      expect(out.walkovers, "the cascade walked nobody over").toBe(0);

      // The seam's consumer: the lucky loser's line plays, and its winner advances.
      await playWin(r, after, r.idOf.get("E5")!);
      const final = (await rowsOf(r.stageIds[1])).find((f) => f.round_no === 2)!;
      expect([final.home_entrant_id, final.away_entrant_id], "E5 won their way into the final").toContain(r.idOf.get("E5"));
    }, 300_000);
  }

  it("X-LL-1 X-LL-3 before the confirm: the proposal offers the lucky loser in the departed qualifier's rank, and the confirm seats them", async () => {
    const r = await rig({ template: "qualifying_main", n: 8, q: 4 });
    await playSource(r, favourite(r));
    const before = await getSeedProposal(r.auth, r.stageIds[1]);
    const seatOf = new Map(before!.computed.qualifiers.map((q) => [q.entrantId, q.destinationSlot]));

    const out = await withdraw(r, r.idOf.get("E4")!);
    expect(out.lucky_loser, "nothing seated yet: the cut, not the cascade, takes the lucky loser").toBeNull();

    const p = await getSeedProposal(r.auth, r.stageIds[1]);
    expect(p?.status, "the withdrawal re-proposed").toBe("draft");
    expect(
      p!.computed.qualifiers.map((q) => [q.rank, r.nameOf.get(q.entrantId), q.destinationSlot]),
      "E5 in E4's rank and seat; every other qualifier keeps theirs (RB4-V2)",
    ).toEqual([
      [1, "E1", seatOf.get(r.idOf.get("E1")!)],
      [2, "E2", seatOf.get(r.idOf.get("E2")!)],
      [3, "E3", seatOf.get(r.idOf.get("E3")!)],
      [4, "E5", seatOf.get(r.idOf.get("E4")!)],
    ]);
    await confirmLatest(r);
    expect(await roundOne(r)).toEqual(["E1 v E5", "E2 v E3"]);
  }, 300_000);

  it("X-LL-3 the lucky loser is read from the qualifying stage's final ranks (an upset: E2 loses a quarter-final)", async () => {
    // E7 beats E2: the quarter-final losers are E8, E5, E6 and E2 — so the best loser is E2, not "the fifth seed".
    const r = await rig({ template: "qualifying_main", n: 8, q: 4 });
    await playSource(r, favourite(r, ["E2"]));
    await confirmLatest(r);
    const ranks = await finalRanks(r.stageIds[0]);
    const qplus1 = ranks.get(5)!;
    expect(r.nameOf.get(qplus1), "premise: the qualifying stage ranks the upset quarter-final loser fifth").toBe("E2");
    const out = await withdraw(r, r.idOf.get("E1")!);
    expect(out.lucky_loser?.entrant_id, "the lucky loser is the qualifying stage's rank q+1").toBe(qplus1);
  }, 300_000);

  it("X-LL-2 once that match has started (a Match Day call), it is a walkover", async () => {
    const r = await rig({ template: "qualifying_main", n: 8, q: 4 });
    await playSource(r, favourite(r));
    await confirmLatest(r);
    const e4 = r.idOf.get("E4")!;
    const line = await lineOf(r, e4);
    const venue = await createVenue(r.auth, { name: "Hall " + randomUUID().slice(0, 4), sort: 0 });
    const court = (await createCourt(r.auth, venue.id, { name: "Court 1", sort: 0, tags: [] })).id;
    await sql`
      insert into schedule_settings (division_id, org_id, config)
      values (${r.divisionId}, ${r.auth.orgId}, ${sql.json({ courts: [court] } as never)})
      on conflict (division_id) do update set config = excluded.config`;
    await sql`update fixtures set scheduled_at = ${"2030-06-01T10:00:00.000Z"}, court_id = ${court}, venue_id = ${venue.id} where id = ${line.id}`;
    await callFixtureToCourt(r.auth, line.id, court);

    const out = await withdraw(r, e4);

    expect(out.lucky_loser, "a called line takes no lucky loser (RB4-V3)").toBeNull();
    const after = (await rowsOf(r.stageIds[1])).find((f) => f.id === line.id)!;
    expect(after.outcome, "E1 walks over E4").toMatchObject({ kind: "award", reason: "withdrew", winner: r.idOf.get("E1"), loser: e4 });
    const seated = new Set((await rowsOf(r.stageIds[1])).flatMap((f) => [f.home_entrant_id, f.away_entrant_id]));
    expect(seated.has(r.idOf.get("E5")!), "no quarter-final loser is seated").toBe(false);
  }, 300_000);

  it("X-LL-2 an empty pool walks over: every quarter-final loser lost by walkover (RB4-E7)", async () => {
    const r = await rig({ template: "qualifying_main", n: 8, q: 4 });
    // Every round-1 line: the AWAY side gives a walkover; the semi-finals and the final are played.
    await playSource(r, (f) => (f.round_no === 1 ? { walkover: "away" } : favourite(r)(f)));
    const qf = await losersOf(r, 1);
    expect(qf.length, "premise: four quarter-final losers").toBe(4);
    expect(qf.every((l) => l.reason === "walkover"), "premise: each lost by walkover").toBe(true);
    await confirmLatest(r);
    const qualifier = (await rowsOf(r.stageIds[1])).find((f) => f.round_no === 1)!.away_entrant_id!;
    const line = await lineOf(r, qualifier);

    const out = await withdraw(r, qualifier);

    expect(out.lucky_loser, "nobody eligible").toBeNull();
    const after = (await rowsOf(r.stageIds[1])).find((f) => f.id === line.id)!;
    expect(after.outcome, "the opponent walks over").toMatchObject({ kind: "award", reason: "withdrew", loser: qualifier });
  }, 300_000);

  it("X-LL-4 a walkover loser is not eligible; the tiebreak uses the destination's draw seed (D10: through a real qualifying stage)", async () => {
    // Eight UNSEEDED in the qualifying draw: the quarter-final losers are four equal-round unseeded losers, so only the lot
    // orders them. One of them lost by walkover and never draws. All four qualifiers withdraw in turn: the three eligible
    // losers take the seats in the destination's lot order, and the fourth vacancy walks over (the pool is empty).
    for (let attempt = 1; ; attempt++) {
      const r = await rig({ template: "qualifying_main", n: 8, q: 4, unseeded: true });
      let walkedOver = false;
      await playSource(r, (f) => {
        if (f.round_no === 1 && !walkedOver) {
          walkedOver = true;
          return { walkover: "away" };
        }
        return { winner: f.home_entrant_id! };
      });
      const qf = await losersOf(r, 1);
      const eligible = qf.filter((l) => l.reason === "played").map((l) => l.id).sort();
      expect(qf.filter((l) => l.reason === "walkover").length, "premise: one quarter-final loser lost by walkover").toBe(1);
      expect(eligible.length, "premise: three played quarter-final losers").toBe(3);
      const lot = (stageId: string) => swissRoundOneOrder(swissDrawSeed(stageId), eligible.map((id) => ({ id, seed: null })));
      const expected = lot(r.stageIds[1]);
      const differential = expected.join() !== eligible.join() && expected.join() !== lot(r.stageIds[0]).join();
      if (!differential) {
        if (attempt >= 6) throw new Error("X-LL-4 rig: six destinations in a row drew the id order or the source's lot");
        continue;
      }
      await confirmLatest(r);
      const qualifiers = (await rowsOf(r.stageIds[1]))
        .filter((f) => f.round_no === 1)
        .flatMap((f) => [f.home_entrant_id!, f.away_entrant_id!]);
      expect(qualifiers.length, "premise: four qualifiers seated").toBe(4);
      const seatedInTurn: (string | null)[] = [];
      for (const q of qualifiers) seatedInTurn.push((await withdraw(r, q)).lucky_loser?.entrant_id ?? null);
      const name = (id: string | null) => (id === null ? null : r.nameOf.get(id)!);
      expect(seatedInTurn.map(name), "the destination's lot, then nobody: the walkover loser never draws").toEqual([...expected, null].map(name));
      return;
    }
  }, 900_000);

  it("X-LL-1 a vacancy in round 2 stays a walkover (RB4-V1)", async () => {
    const r = await rig({ template: "qualifying_main", n: 8, q: 4 });
    await playSource(r, favourite(r));
    await confirmLatest(r);
    for (const f of (await rowsOf(r.stageIds[1])).filter((x) => x.round_no === 1)) {
      await playWin(r, f, num(r, f.home_entrant_id!) < num(r, f.away_entrant_id!) ? f.home_entrant_id! : f.away_entrant_id!);
    }
    const final = (await rowsOf(r.stageIds[1])).find((f) => f.round_no === 2)!;
    expect([r.nameOf.get(final.home_entrant_id!), r.nameOf.get(final.away_entrant_id!)].sort(), "premise: E1 v E2 in the final").toEqual(["E1", "E2"]);

    const out = await withdraw(r, r.idOf.get("E1")!);

    expect(out.lucky_loser, "a round-2 vacancy takes nobody").toBeNull();
    const after = (await rowsOf(r.stageIds[1])).find((f) => f.id === final.id)!;
    expect(after.outcome, "E2 walks over").toMatchObject({ kind: "award", reason: "withdrew", winner: r.idOf.get("E2") });
  }, 300_000);

  it("X-LL-1 sequence: two qualifiers withdraw — the first and the second lucky losers, each in the seat that left", async () => {
    const r = await rig({ template: "qualifying_main", n: 8, q: 4 });
    await playSource(r, favourite(r));
    await confirmLatest(r);
    expect((await withdraw(r, r.idOf.get("E4")!)).lucky_loser?.entrant_id).toBe(r.idOf.get("E5"));
    expect((await withdraw(r, r.idOf.get("E3")!)).lucky_loser?.entrant_id).toBe(r.idOf.get("E6"));
    expect(await roundOne(r)).toEqual(["E1 v E5", "E2 v E6"]);
  }, 300_000);

  it("X-LL-1 sequence: a lucky loser who then withdraws — the next one takes the seat while it is unstarted", async () => {
    const r = await rig({ template: "qualifying_main", n: 8, q: 4 });
    await playSource(r, favourite(r));
    await confirmLatest(r);
    expect((await withdraw(r, r.idOf.get("E4")!)).lucky_loser?.entrant_id).toBe(r.idOf.get("E5"));
    expect((await withdraw(r, r.idOf.get("E5")!)).lucky_loser?.entrant_id, "the next best loser").toBe(r.idOf.get("E6"));
    expect(await roundOne(r)).toEqual(["E1 v E6", "E2 v E3"]);
  }, 300_000);

  it("X-LL-1 the empty case: a withdrawal outside any main draw (a quarter-final loser) seats nobody and moves no seat", async () => {
    const r = await rig({ template: "qualifying_main", n: 8, q: 4 });
    await playSource(r, favourite(r));
    await confirmLatest(r);
    const before = await roundOne(r);
    const out = await withdraw(r, r.idOf.get("E8")!);
    expect(out.lucky_loser).toBeNull();
    expect(await roundOne(r)).toEqual(before);
  }, 300_000);

  it("X-LL-5 a departed league qualifier is replaced by the next-ranked entrant (league_ko, at the cut)", async () => {
    // A league of six at q = 4, the favourite winning every match: the table is E1..E6 in order. E2 leaves after the
    // league completes and before the confirm: the next-ranked entrant, E5, qualifies — the table closes up (RB4-V6, as
    // W3 does for Swiss).
    const r = await rig({ template: "league_ko", n: 6, q: 4 });
    await playSource(r, favourite(r));
    const ranks = await finalRanks(r.stageIds[0]);
    expect([1, 2, 3, 4, 5].map((k) => r.nameOf.get(ranks.get(k)!)), "premise: the league table").toEqual(["E1", "E2", "E3", "E4", "E5"]);

    await withdraw(r, r.idOf.get("E2")!);

    const p = await getSeedProposal(r.auth, r.stageIds[1]);
    expect(p?.status).toBe("draft");
    expect(p!.computed.qualifiers.map((q) => r.nameOf.get(q.entrantId)), "E1, E3, E4 and the next-ranked E5").toEqual(["E1", "E3", "E4", "E5"]);
    await confirmLatest(r);
    const seated = (await rowsOf(r.stageIds[1])).flatMap((f) => [f.home_entrant_id, f.away_entrant_id]).filter((x): x is string => x !== null);
    expect(new Set(seated.map((id) => r.nameOf.get(id))), "the knockout seats them").toEqual(new Set(["E1", "E3", "E4", "E5"]));
  }, 300_000);

  // Review #1: nine in three pools at q = 8 is the top two of each and the two best thirds. E2 wins her pool and leaves
  // before the confirm: her pool closes up and has no eligible third, so the other two pools' thirds are the two best,
  // and everyone still in the field qualifies. Expected: the roster less E2, by count.
  describe("X-LL-5 a departed pool winner cannot win a best third's place (groups_ko, nine in three pools at q = 8)", () => {
    const expected = (r: Rig) => new Set([...r.nameOf.values()].filter((n) => n !== "E2"));
    const seated = async (r: Rig) =>
      new Set((await rowsOf(r.stageIds[1])).filter((f) => f.round_no === 1).flatMap((f) => [f.home_entrant_id, f.away_entrant_id]).map((id) => (id === null ? "-" : r.nameOf.get(id)!)));

    it("thirds with different records: eight qualifiers, no tie, every seat filled", async () => {
      const r = await rig({ template: "groups_ko", n: 9, q: 8, pools: 3 });
      // The favourite wins every line; E9 loses closer than E7, so the two thirds are not level.
      for (const f of (await rowsOf(r.stageIds[0])).filter((x) => x.home_entrant_id !== null && x.away_entrant_id !== null)) {
        const homeWins = num(r, f.home_entrant_id!) < num(r, f.away_entrant_id!);
        const loser = homeWins ? f.away_entrant_id! : f.home_entrant_id!;
        const against = r.nameOf.get(loser) === "E9" ? 19 : 10;
        await post(r.auth, f.id, "core.start");
        for (let g = 0; g < 2; g++) await post(r.auth, f.id, "badminton.game.summary", homeWins ? { home: 21, away: against } : { home: against, away: 21 });
      }
      const done = await completeStage(r.auth, r.stageIds[0]);
      expect(done.completed, "rig: the source completed").toBe(true);
      await withdraw(r, r.idOf.get("E2")!);

      const p = await getSeedProposal(r.auth, r.stageIds[1]);
      expect(p?.status).toBe("draft");
      expect(new Set(p!.computed.qualifiers.map((q) => r.nameOf.get(q.entrantId)))).toEqual(expected(r));
      expect(p!.computed.qualifiers.length, "eight, not seven").toBe(8);
      expect(p!.computed.ties, "no tie: the two thirds are not level, and she is in no comparison").toEqual([]);

      await confirmLatest(r);
      expect(await seated(r), "every seat of round 1, nobody left out beside an empty one").toEqual(expected(r));
    }, 300_000);

    it("the on_complete door: the seeded list is the same eight, and her walkover line is not drawn", async () => {
      const { auth } = await seedOrg("pro");
      const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "W4 LL5 " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
      const division = await createDivision(auth, comp.id, { name: "Open", slug: "open-" + randomUUID().slice(0, 6), sport_key: SINGLES.key, variant_key: SINGLES.variant, config: {} });
      const made = await createEntrants(auth, division.id, Array.from({ length: 9 }, (_, i) => ({ kind: SINGLES.kind, display_name: `E${i + 1}`, seed: i + 1, members: [] })));
      const drafts = buildTemplateStages("groups_ko", { swissRounds: 5, poolCount: 3, legs: 1, qualified: 8 });
      const ids: string[] = [];
      for (const [i, d] of drafts.entries()) {
        const progression = d.progression ? { ...d.progression, timing: "on_complete" as const } : d.progression;
        const [stage] = await createStages(auth, division.id, CreateStage.parse({ seq: i + 1, kind: d.kind, name: d.name, config: d.config, progression }));
        ids.push(stage!.id);
      }
      await startDivision(auth, division.id);
      const r: Rig = {
        auth,
        divisionId: division.id,
        sport: SINGLES,
        stageIds: [ids[0]!, ids[1]!],
        nameOf: new Map(made.map((e) => [e.id, e.display_name])),
        idOf: new Map(made.map((e) => [e.display_name, e.id])),
      };
      for (const f of await rowsOf(ids[0]!)) await playWin(r, f, num(r, f.home_entrant_id!) < num(r, f.away_entrant_id!) ? f.home_entrant_id! : f.away_entrant_id!);
      await withdraw(r, r.idOf.get("E2")!);
      const done = await completeStage(auth, ids[0]!);
      expect(done.completed, "rig: the source completed").toBe(true);
      const [next] = await sql<{ config: { qualified?: string[] } }[]>`select config from stages where id = ${ids[1]!}`;
      expect(new Set(next!.config.qualified?.map((id) => r.nameOf.get(id))), "the roster less her").toEqual(expected(r));
      expect(next!.config.qualified?.length).toBe(8);
    }, 300_000);

    it("thirds dead level: still eight qualifiers; the tie for the seed order names only the two thirds, never her", async () => {
      const r = await rig({ template: "groups_ko", n: 9, q: 8, pools: 3 });
      await playSource(r, favourite(r));
      await withdraw(r, r.idOf.get("E2")!);
      const p = await getSeedProposal(r.auth, r.stageIds[1]);
      expect(new Set(p!.computed.qualifiers.map((q) => r.nameOf.get(q.entrantId)))).toEqual(expected(r));
      const tied = p!.computed.ties.flatMap((t) => t.entrantIds.map((id) => r.nameOf.get(id)));
      expect(tied, "anti-vacuity: the two thirds are level in this rig").toContain("E9");
      expect(tied, "she is in no tie").not.toContain("E2");
      await confirmLatest(r);
      expect(await seated(r)).toEqual(expected(r));
    }, 300_000);
  });

  it("X-LL-5 a departed group qualifier is replaced by the next-ranked entrant of that group (groups_ko, at the cut)", async () => {
    // Eight in two groups (the snake: A = E1 E4 E5 E8, B = E2 E3 E6 E7), the top two of each at q = 4: E1 and E4, E2 and
    // E3. E1 leaves before the confirm: group A's next-ranked entrant, E5, qualifies.
    const r = await rig({ template: "groups_ko", n: 8, q: 4 });
    await playSource(r, favourite(r));
    await withdraw(r, r.idOf.get("E1")!);
    const p = await getSeedProposal(r.auth, r.stageIds[1]);
    expect(p?.status).toBe("draft");
    expect(new Set(p!.computed.qualifiers.map((q) => r.nameOf.get(q.entrantId)))).toEqual(new Set(["E2", "E3", "E4", "E5"]));
  }, 300_000);
});
