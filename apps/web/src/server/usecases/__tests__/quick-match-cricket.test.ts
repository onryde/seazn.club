// Quick match cricket (owner 2026-11-13 "yes" to queue it, 2026-11-14 "why still not cricket in the quick match?"; decision
// log 2026-11-13; spec 2026-11-03-quick-match-design.md C11 as amended 2026-11-14): a guest scores a cricket League with
// what its pad offers at bands 0–1 — the toss (asked at Start), the Start, over summaries and Close innings — and the
// table is the engine's: its points rule (win 2, tie 1) and its net run rate.
//
// Every quick match is made by the real producer (`createQuickMatch` behind the guarded create a guest's post reaches), every
// event by the real write path (`scoreEvent`), every Not played and Put back by the home's own writers, every table by the
// real standings read. The events are the ones the guest's pad builds: the toss through the Start question's own builder
// (`cricketTossEvent`), each over through the over-summary sheet's shape (this over's runs, wickets and balls added onto the
// innings' totals, `partial: true`), each close through the Close innings sheet's (`{ reason }`).
//
// Expected values come from the engine's declarations (the variant's `points`, its `ballsPerOver` and `ballsPerInnings`,
// the close reasons the pad offers) and the rulebook (ICC Playing Conditions: a tie is equal totals when both innings are
// complete; the side batting second wins once it passes the first innings' total; net run rate is runs scored per over
// faced less runs conceded per over bowled), never from the usecase's own answer.
//
// Single-sport on purpose: cricket is the only band-capped quick match sport (`QUICK_MATCH_BAND_CAPPED_SPORTS`); every
// offered sport's create, score, skip and put back are swept elsewhere (quick-match-skip.test.ts, quick-match-sweep).
//
// Real Postgres required; the cases skip without DATABASE_URL.
import { randomBytes as kekBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cricketPadRules } from "@seazn/engine/pad";
import type { StandingsRow } from "@seazn/engine/competition";
import { builtinModules } from "@seazn/engine/sports";

import { cricketTossEvent } from "@/components/v2/scorepad/v3/skins/cricket-start-toss";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { pickVariant } from "@/lib/preferred-variant";
import { QUICK_MATCH_ERRORS } from "@/lib/quick-match-constants";
import type { CreateQuickMatch } from "@/server/api-v1/schemas";
import { createQuickMatch, systemAuth } from "../quick-match-create";
import { hardDeleteQuickMatchCompetition } from "../quick-match-delete";
import { readQuickMatchHome, resolveQuickMatchToken, type QuickMatchHome, type QuickMatchRow } from "../quick-match-home";
import { putBackQuickMatchFixture, skipQuickMatchFixture } from "../quick-match-skip";
import { listQuickMatchSports } from "../quick-match-sports";
import { hashVisitorKey, mintVisitorKey } from "../quick-match-tokens";
import { scoreEvent } from "../scoring";
import { getStandings } from "../stages";
import { quickMatchFullTable } from "@/app/q/[token]/full-table";

vi.stubEnv("DEVICE_LINK_KEK", kekBytes(32).toString("hex"));   // every create seals a home token (A15)
vi.mock("@/lib/posthog-server", async (orig) => ({
  ...(await orig<typeof import("@/lib/posthog-server")>()),
  captureServer: vi.fn(),
}));

const HAS_DB = !!process.env.DATABASE_URL;
const cricket = builtinModules.find((m) => m.key === "cricket")!;
const created: string[] = [];
let VARIANT = "";
let KIND: CreateQuickMatch["kind"] = "team";
/** The variant's own rules, as the engine resolves them. */
let CFG: { points: { win: number; tie: number; loss: number }; ballsPerOver: number; ballsPerInnings: number | null };

beforeAll(async () => {
  if (!HAS_DB) return;
  const sport = (await listQuickMatchSports()).find((s) => s.sport_key === "cricket");
  if (!sport) throw new Error("premise: cricket is offered for quick matches");
  // The setup screen's default (`pickVariant`, D6), the variant a guest who touches nothing plays.
  VARIANT = pickVariant("cricket", sport.variants.map((v) => ({ key: v.variant_key })));
  KIND = sport.kinds.at(-1)!;
  CFG = cricket.configSchema.parse((cricket.variants as Record<string, unknown>)[VARIANT]) as typeof CFG;
});

afterAll(async () => {
  if (!HAS_DB) return;
  for (const id of created) await hardDeleteQuickMatchCompetition(id).catch(() => undefined);
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

const input = (over: Partial<CreateQuickMatch> = {}): CreateQuickMatch => ({
  name: `QM cricket ${randomUUID().slice(0, 8)}`,
  sport_key: "cricket",
  variant_key: VARIANT,
  kind: KIND,
  format: "league",
  sides: ["Falcons", "Kites", "Owls"],
  plays: 1,
  email: null,
  locale: "en",
  ...over,
});

async function make(over: Partial<CreateQuickMatch> = {}): Promise<{ row: QuickMatchRow; competitionId: string }> {
  const out = await createQuickMatch(input(over), { visitorHash: hashVisitorKey(mintVisitorKey()), mailAllowed: async () => true });
  created.push(out.competitionId);
  const row = await resolveQuickMatchToken(out.token);
  if (!row) throw new Error(`precondition: quick match ${out.id} does not resolve`);
  return { row, competitionId: out.competitionId };
}
async function homeOf(row: QuickMatchRow): Promise<QuickMatchHome> {
  const home = await readQuickMatchHome(row);
  if (!home) throw new Error(`precondition: quick match ${row.id} has no home`);
  return home;
}

interface Fx { id: string; status: string; home_entrant_id: string; away_entrant_id: string; outcome: { kind?: string; winner?: string } | null }
async function fixturesOf(competitionId: string): Promise<Fx[]> {
  return sql<Fx[]>`
    select f.id, f.status, f.home_entrant_id, f.away_entrant_id, f.outcome
      from fixtures f join divisions d on d.id = f.division_id
     where d.competition_id = ${competitionId} order by f.round_no, f.fixture_no`;
}
async function fixture(id: string): Promise<Fx> {
  const [f] = await sql<Fx[]>`select id, status, home_entrant_id, away_entrant_id, outcome from fixtures where id = ${id}`;
  return f!;
}
async function ledgerOf(fixtureId: string) {
  const events = await sql<{ id: string; seq: number; type: string; payload: string; voids_event_id: string | null }[]>`
    select id, seq, type, payload::text as payload, voids_event_id from score_events where fixture_id = ${fixtureId} order by seq`;
  const states = await sql<{ last_seq: number; state: string; summary: string }[]>`
    select last_seq, state::text as state, summary::text as summary from match_states where fixture_id = ${fixtureId}`;
  return { events, states };
}
const rowsOf = async (home: QuickMatchHome) => (await getStandings(systemAuth(), home.stageId)).rows as StandingsRow[];

/** One match as the guest's pad writes it, at the next seq each time. */
function guest(fixtureId: string) {
  let seq = 0;
  const innings = { runs: 0, wickets: 0, legalBalls: 0 };
  const post = async (type: string, payload: Record<string, unknown>) =>
    scoreEvent(systemAuth(), fixtureId, { expected_seq: seq++, type, payload });
  return {
    /** The Start question's answers ("Who won the toss?", "Bat or bowl?"), then the Start. */
    async tossAndStart(wonBy: string, elected: "bat" | "bowl") {
      const toss = cricketTossEvent(wonBy, elected);
      await post(toss.type, toss.payload);
      return post("core.start", {});
    },
    /** The over-summary sheet: THIS over's runs, wickets and balls (a full over unless named), added onto the innings. */
    async over(runs: number, wickets = 0, balls = CFG.ballsPerOver) {
      innings.runs += runs;
      innings.wickets += wickets;
      innings.legalBalls += balls;
      return post("cricket.innings.summary", { ...innings, partial: true });
    },
    /** Close innings, with a reason the pad's sheet offers; the next over starts a fresh innings. */
    async close(reason: string) {
      expect(cricketPadRules.inningsCloseReasons, "premise: the pad's Close innings offers this reason").toContain(reason);
      Object.assign(innings, { runs: 0, wickets: 0, legalBalls: 0 });
      return post("cricket.innings.close", { reason });
    },
    /** Void my last entry (Edit result): an over taken back leaves the innings at the totals before it, as the fold does. */
    async void(eventId: string, over?: { runs: number; wickets?: number; balls?: number }) {
      if (over) {
        innings.runs -= over.runs;
        innings.wickets -= over.wickets ?? 0;
        innings.legalBalls -= over.balls ?? CFG.ballsPerOver;
      }
      return post("core.void", { event_id: eventId });
    },
    get seq() { return seq; },
  };
}

/** ICC net run rate from whole-over totals: runs per over faced less runs per over conceded. */
const nrr = (forRuns: number, forBalls: number, againstRuns: number, againstBalls: number) =>
  (forRuns * CFG.ballsPerOver) / forBalls - (againstRuns * CFG.ballsPerOver) / againstBalls;

describe.skipIf(!HAS_DB)("a cricket quick match, scored at the guest's bands (toss, Start, overs, Close innings)", () => {
  it("premise: the setup screen opens on a limited-overs variant with a points rule that pays a tie", () => {
    expect(VARIANT, "a default variant").not.toBe("");
    expect(CFG.ballsPerInnings, `${VARIANT}: limited overs`).not.toBeNull();
    expect(CFG.points.tie, "a tie pays something, less than a win").toBeGreaterThan(CFG.points.loss);
    expect(CFG.points.tie).toBeLessThan(CFG.points.win);
  });

  it("League + Knockout is refused (League only, C11 as amended): the create says so with its code", async () => {
    const err = await make({ format: "league_knockout", qualifiers: 2, sides: ["Falcons", "Kites", "Owls", "Rooks"] }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HttpError);
    expect({ status: (err as HttpError).status, code: (err as HttpError).code }).toEqual({ status: 422, code: QUICK_MATCH_ERRORS.FORMAT_NOT_OFFERED });
    // The positive pair: the same sides make a League.
    const ok = await make({ sides: ["Falcons", "Kites", "Owls", "Rooks"] });
    expect((await fixturesOf(ok.competitionId)).length, "a round robin of 4 is 4·3/2").toBe(6);
  });

  it("a tie, then a chase won; the table is the engine's points and net run rate; Edit result, Not played and Put back leave it exact", async () => {
    const { row, competitionId } = await make();
    const fixtures = await fixturesOf(competitionId);
    expect(fixtures, "a round robin of 3 is 3·2/2").toHaveLength(3);
    const [m1, m2] = fixtures as [Fx, Fx];

    // ── Match 1: a tie. The away side wins the toss and bowls, so the home side bats first (the engine seats it).
    const g1 = guest(m1.id);
    await g1.tossAndStart(m1.away_entrant_id, "bowl");
    await g1.over(9);
    await g1.over(7, 1);
    await g1.close("other");
    await g1.over(10, 1);
    await g1.over(6);
    const tie = await g1.close("other");
    expect(tie.status, "both innings complete, equal totals: decided").toBe("decided");
    expect((await fixture(m1.id)).outcome, "16 v 16 is a tie").toMatchObject({ kind: "tie" });

    let rows = await rowsOf(await homeOf(row));
    const by = (id: string) => rows.find((r) => r.entrantId === id)!;
    expect([by(m1.home_entrant_id).points, by(m1.away_entrant_id).points], "a tie pays each side the variant's tie points").toEqual([
      CFG.points.tie,
      CFG.points.tie,
    ]);

    // ── Match 2: a chase won. The home side wins the toss and bowls; the away side sets 20, the home side passes it.
    const g2 = guest(m2.id);
    await g2.tossAndStart(m2.home_entrant_id, "bowl");
    await g2.over(12);
    await g2.over(8, 2);
    await g2.close("other");
    await g2.over(14);
    const won = await g2.over(7);   // 21 off 12: past 20, the innings closes itself and the match is decided
    expect(won.status, "the chase passes the total: decided").toBe("decided");
    const decided = await fixture(m2.id);
    expect(decided.outcome, "the side batting second wins").toMatchObject({ winner: m2.home_entrant_id });

    rows = await rowsOf(await homeOf(row));
    const winner = by(m2.home_entrant_id);
    const loser = by(m2.away_entrant_id);
    const tiePoints = [m1.home_entrant_id, m1.away_entrant_id].includes(m2.home_entrant_id) ? CFG.points.tie : 0;
    expect(winner.points - tiePoints, "a win pays the variant's win points").toBe(CFG.points.win);
    expect(loser.won).toBe(0);
    // Net run rate, as the /q home's Full table prints it (the public table's own columns and cells), against the ICC formula
    // from the overs entered: the winner's two matches if it played the tie (16 off 12 each way there), else its one.
    const inTie = [m1.home_entrant_id, m1.away_entrant_id].includes(m2.home_entrant_id);
    const tieRuns = inTie ? 16 : 0;
    const tieBalls = inTie ? 12 : 0;
    expect(winner.metrics, "the engine's run and ball totals behind it").toMatchObject({
      runs_for: 21 + tieRuns,
      runs_against: 20 + tieRuns,
      balls_faced_eff: 12 + tieBalls,
      balls_bowled_eff: 12 + tieBalls,
    });
    const full = quickMatchFullTable(await homeOf(row), (k) => String(k));
    expect(full, "a league has a full table").not.toBeNull();
    const nrrAt = full!.columns.findIndex((c) => c.key === "nrr");
    expect(nrrAt, `the table has an NRR column (${full!.columns.map((c) => c.key).join(", ")})`).toBeGreaterThanOrEqual(0);
    expect(Number(full!.cells[m2.home_entrant_id]![nrrAt])).toBeCloseTo(nrr(21 + tieRuns, 12 + tieBalls, 20 + tieRuns, 12 + tieBalls), 2);
    expect(Number(full!.cells[m2.away_entrant_id]![nrrAt]), "the loser's is below zero").toBeLessThan(0);

    // ── Edit result: the deciding over taken back. The match is live again at 14 off 6, and the win leaves the table.
    const [{ id: lastId }] = await sql<{ id: string }[]>`
      select id from score_events where fixture_id = ${m2.id} order by seq desc limit 1`;
    const reopened = await g2.void(lastId!, { runs: 7 });
    expect(reopened.status, "the result taken back: in play").toBe("in_play");
    rows = await rowsOf(await homeOf(row));
    expect(by(m2.home_entrant_id).won, "no win stands").toBe(0);

    // ── Not played, then Put back: the ledger and the stored state are byte-identical, the match live again.
    const before = await ledgerOf(m2.id);
    expect(await skipQuickMatchFixture(row, m2.id)).toEqual({ changed: true });
    expect((await fixture(m2.id)).status).toBe("cancelled");
    expect(await putBackQuickMatchFixture(row, m2.id)).toEqual({ changed: true, status: "in_play" });
    expect(await ledgerOf(m2.id), "byte-identical").toEqual(before);

    // ── The over scored again: decided once more, the same winner.
    const again = await g2.over(7);
    expect(again.status).toBe("decided");
    expect((await fixture(m2.id)).outcome).toMatchObject({ winner: m2.home_entrant_id });
    rows = await rowsOf(await homeOf(row));
    expect(by(m2.home_entrant_id).won).toBe(1);
  }, 60_000);
});
