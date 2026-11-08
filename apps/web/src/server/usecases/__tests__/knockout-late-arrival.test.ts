// W4 app-A Task 11 (X-LE-10, gaps K7 and K13; spec 2026-11-04 §4.1, ruling 271) — AUTOMATIC arrivals into a drawn root
// knockout, driven through every real door on a real database: a free confirmation, a card payment's webhook (and its
// retry), a waitlist promotion, an import and a Reinstate. None is placed by the app and none is refused (a payment that
// has moved cannot be un-taken by a 409): the entrant WAITS — `entrants.knockout_waiting_stage_id` names the stage, the desk
// says "1 late player waiting — add to bracket" — and the organiser's one tap (`placeWaitingKnockoutEntrant`, the route
// `POST /stages/{id}/late-entrants/{entrantId}/place`) runs the cases "Add late player" runs. Main placed nobody and
// flagged nobody: a paid player confirmed after the draw was in no bracket and on no list (K7), and a reinstated player
// was silently back in the field with their walked-over seat lost (K13).
//
// Expected values: the bye a tap takes is RB4-L4 over the STORED byes (`rb4L4ExpectedLine`, the one oracle); every other
// expectation is the rulebook's case (X-LE-10: wait, never refused; one tap places), the rows as they stood before the
// arrival, or the stage's own name read from its row — never the code under test.
//
// Sports: the confirmation and Reinstate rows sweep badminton singles, badminton pairs and chess (the boardgame module,
// individual only), each from the engine registry by key; the import row is football (an import's `entrant.create` makes
// TEAM entrants only). The payment, waitlist, concurrency and refusal rows run on badminton singles: they read the marker,
// the seats and the ledger, which no sport field reaches.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { builtinModules } from "@seazn/engine/sports";
import { sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { buildTemplateStages } from "@/lib/format-templates";
import { rb4L4ExpectedLine, type StoredByeLine } from "@/lib/__tests__/rb4-l4-oracle";
import type { AuthCtx } from "@/server/api-v1/auth";
import { CreateStage } from "@/server/api-v1/schemas";
import { appendEventInTx } from "@/server/engine-db/append-event";
import { getCompetitionDesk } from "../competition-desk";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants, patchEntrant } from "../entrants";
import { commitImport, createImport } from "../imports";
import { placeWaitingKnockoutEntrant } from "../knockout-late-entry";
import {
  confirmRegistration,
  handleRegistrationCheckoutCompleted,
  openPromotionSeatGate,
  promoteOldestWaitlisted,
  putRegistrationSettings,
} from "../registrations";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { createStages, rebuildStageFixtures } from "../stages";
import { withdrawEntrantCascade } from "../withdrawal";
import { fakeSession, seedRegistration } from "./_registration-fixtures";
import { seedOrg } from "./_seed";

// No network on these paths: a Stripe call is a failure (the webhook is fed its session), and mail never leaves.
const getStripeMock = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("this suite makes no Stripe call");
  }),
);
vi.mock("@/lib/stripe", async (io) => ({ ...(await io<typeof import("@/lib/stripe")>()), getStripe: getStripeMock }));
vi.mock("@/server/email-outbox/transport", () => ({ deliver: vi.fn() }));

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

/** The plan's sentences (task-11 brief, refusal table), typed here: the refusal table is the code under test. */
const NOT_WAITING = "This player isn't waiting to join this bracket.";
const FED = (stage: string) => `This knockout is filled from ${stage}. Add the player there.`;

interface SportPick {
  key: string;
  variant: string;
  kind: "individual" | "pair" | "team";
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
const SWEEP = [SINGLES, PAIRS, CHESS];

interface Row {
  id: string;
  round_no: number;
  seq_in_round: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
  outcome: { kind?: string; reason?: string; winner?: string; loser?: string | null } | null;
  winner_to_fixture: string | null;
}

interface Rig {
  auth: AuthCtx;
  orgId: string;
  competitionId: string;
  divisionId: string;
  stageId: string;
  stageName: string;
  sport: SportPick;
  ids: string[];
}

const entrant = (s: SportPick, name: string, seed: number | null) => ({ kind: s.kind, display_name: name, seed, members: [] });

/** `n` entrants seeded 1..n, one root knockout named "Cup", started (unless `start: false`). */
async function rig(opts: { n: number; sport?: SportPick; start?: boolean }): Promise<Rig> {
  const s = opts.sport ?? SINGLES;
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "W4 T11 " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
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
    Array.from({ length: opts.n }, (_, i) => entrant(s, `P${i + 1}`, i + 1)),
  );
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "knockout", name: "Cup", config: {}, progression: null });
  if (opts.start !== false) await startDivision(auth, division.id);
  return {
    auth,
    orgId: auth.orgId,
    competitionId: comp.id,
    divisionId: division.id,
    stageId: stage!.id,
    stageName: "Cup",
    sport: s,
    ids: made.map((e) => e.id),
  };
}

const rowsOf = (stageId: string) =>
  sql<Row[]>`
    select id, round_no, seq_in_round, home_entrant_id, away_entrant_id, status, outcome, winner_to_fixture
      from fixtures where stage_id = ${stageId} order by round_no, seq_in_round`;
const rowById = async (id: string) =>
  (await sql<Row[]>`
    select id, round_no, seq_in_round, home_entrant_id, away_entrant_id, status, outcome, winner_to_fixture
      from fixtures where id = ${id}`)[0]!;

async function waitingOn(entrantId: string): Promise<string | null> {
  const [e] = await sql<{ w: string | null }[]>`select knockout_waiting_stage_id as w from entrants where id = ${entrantId}`;
  return e!.w;
}

/** The stages any fixture seats `entrantId` in. */
async function seatedIn(entrantId: string): Promise<string[]> {
  const rows = await sql<{ stage_id: string }[]>`
    select distinct stage_id from fixtures where ${entrantId} in (home_entrant_id, away_entrant_id)`;
  return rows.map((r) => r.stage_id);
}

async function lateRows(divisionId: string) {
  return (
    await sql<{ payload: Record<string, unknown> }[]>`
      select payload from division_events where division_id = ${divisionId} and type = 'knockout_late_entry' order by seq`
  ).map((r) => r.payload);
}

/** The desk's late-player rows for the rig's division (`getCompetitionDesk`, the loader the desk and Match Day read). */
async function deskLate(r: Rig) {
  const desk = await getCompetitionDesk(r.auth, r.competitionId);
  return (desk.divisions.get(r.divisionId)?.attention ?? []).filter((a) => a.kind === "late_players_waiting");
}

function storedByeLines(rows: readonly Row[]): StoredByeLine[] {
  return rows
    .filter((x) => x.round_no === 1 && x.outcome?.kind === "award" && x.outcome.reason === "bye" && x.outcome.winner)
    .map((x) => ({ lineId: x.id, holderId: x.outcome!.winner!, seq: x.seq_in_round }));
}
async function seedsOf(divisionId: string): Promise<Map<string, number | null>> {
  const rows = await sql<{ id: string; seed: number | null }[]>`select id, seed from entrants where division_id = ${divisionId}`;
  return new Map(rows.map((x) => [x.id, x.seed]));
}

/** A free, offline registration confirmed through `confirmRegistration` → `materialise`. */
async function confirmArrival(r: Rig, name: string): Promise<{ entrantId: string; status: string }> {
  const { registration } = await seedRegistration(r.competitionId, r.divisionId, { fee_cents: 0, currency: "eur", payment_method: "offline" }, { displayName: name });
  const confirmed = await confirmRegistration(r.auth, registration.id);
  expect(confirmed.entrant_id, `rig: ${name}'s confirmation made an entrant`).toBeTruthy();
  return { entrantId: confirmed.entrant_id!, status: confirmed.status };
}

async function refusal(p: Promise<unknown>): Promise<HttpError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, "the tap is refused").toBeInstanceOf(HttpError);
  return err as HttpError;
}

async function post(auth: AuthCtx, fixtureId: string, type: string, payload: Record<string, unknown> = {}): Promise<void> {
  const [{ n }] = await sql<{ n: number }[]>`select coalesce(max(seq), 0)::int as n from score_events where fixture_id = ${fixtureId}`;
  await scoreEvent(auth, fixtureId, { expected_seq: n, type, payload });
}

describe.skipIf(!HAS_DB)("W4 T11: automatic arrivals into a drawn knockout wait for one tap (X-LE-10, K7)", () => {
  it("the empty case first: before Start an arrival is nobody's to wait — no marker, no desk row", async () => {
    const r = await rig({ n: 6, start: false });
    const { entrantId } = await confirmArrival(r, "Early");
    expect(await waitingOn(entrantId)).toBeNull();
    expect(await deskLate(r)).toEqual([]);
  });

  for (const s of SWEEP) {
    it(`K7 a confirmation after the draw waits: nothing moves, the desk says so, one tap takes the bye [${s.key}/${s.kind}]`, async () => {
      // Six seeded in a bracket of eight: seeds 1 and 2 hold byes, so an organiser's add WOULD be placed — the arrival
      // still waits (ruling 271: the app never places an automatic arrival).
      const r = await rig({ n: 6, sport: s });
      const before = await rowsOf(r.stageId);
      const stored = storedByeLines(before);
      expect(stored.length, "premise: six in eight hold two stored byes").toBe(2);

      const { entrantId, status } = await confirmArrival(r, "Late");
      expect(status, "never refused").toBe("confirmed");
      expect(await waitingOn(entrantId), "waits on the root knockout").toBe(r.stageId);
      expect(await seatedIn(entrantId), "seated nowhere").toEqual([]);
      expect(await rowsOf(r.stageId), "nothing moved").toEqual(before);
      expect(await lateRows(r.divisionId), "no ledger row: the wait is no placement").toEqual([]);
      expect(await deskLate(r)).toEqual([{ kind: "late_players_waiting", count: 1, stageName: r.stageName }]);

      const want = rb4L4ExpectedLine(stored, await seedsOf(r.divisionId), before.filter((x) => x.round_no === 1).length);
      const holder = stored.find((l) => l.lineId === want)!.holderId;
      const placed = await placeWaitingKnockoutEntrant(r.auth, r.stageId, entrantId);
      expect(placed).toMatchObject({ format: "knockout", case: "bye", entrant_id: entrantId, stage_id: r.stageId, fixture_id: want, opponent_id: holder });
      const line = await rowById(want!);
      expect(new Set([line.home_entrant_id, line.away_entrant_id]), "the late player plays the holder").toEqual(new Set([holder, entrantId]));
      expect({ status: line.status, outcome: line.outcome }).toEqual({ status: "scheduled", outcome: null });
      expect(await waitingOn(entrantId), "the marker clears").toBeNull();
      expect(await deskLate(r), "the desk row goes").toEqual([]);
      expect((await lateRows(r.divisionId)).map((p) => [p.entrant_id, p.case, p.source])).toEqual([[entrantId, "bye", "organiser"]]);
    });

    it(`K13 a Reinstate after the walkover waits; the old seat is not re-seated; the tap gives their own seat back [${s.key}/${s.kind}]`, async () => {
      const r = await rig({ n: 8, sport: s });
      const line0 = (await rowsOf(r.stageId)).find((x) => x.round_no === 1 && x.seq_in_round === 2)!;
      const gone = line0.home_entrant_id!;
      const opp = line0.away_entrant_id!;
      await withdrawEntrantCascade(r.auth, gone);
      const walked = await rowById(line0.id);
      expect(walked.outcome, "premise: the withdrawal walked the line over").toMatchObject({ kind: "award", reason: "withdrew", winner: opp });

      await patchEntrant(r.auth, gone, { status: "registered" });
      expect(await waitingOn(gone), "waits on the root knockout").toBe(r.stageId);
      expect(await rowById(line0.id), "the walked-over seat is not silently re-seated").toEqual(walked);
      expect(await deskLate(r)).toEqual([{ kind: "late_players_waiting", count: 1, stageName: r.stageName }]);

      const placed = await placeWaitingKnockoutEntrant(r.auth, r.stageId, gone);
      expect(placed).toMatchObject({ case: "withdrawn_slot", fixture_id: line0.id, opponent_id: opp });
      const line = await rowById(line0.id);
      expect({ home: line.home_entrant_id, away: line.away_entrant_id, status: line.status, outcome: line.outcome }).toEqual({
        home: gone,
        away: opp,
        status: "scheduled",
        outcome: null,
      });
      const next = await rowById(line0.winner_to_fixture!);
      expect([next.home_entrant_id, next.away_entrant_id], "the walkover winner is taken back out of round 2").not.toContain(opp);
      expect(await waitingOn(gone)).toBeNull();
      const seats = await sql<{ round_no: number }[]>`
        select round_no from fixtures where stage_id = ${r.stageId} and ${gone} in (home_entrant_id, away_entrant_id)`;
      expect(seats.map((x) => x.round_no), "one seat, in round 1 — never a second").toEqual([1]);
    });
  }

  /** Line 1's home player withdrawn (a walkover against them), line 2 played, and the round-2 line they feed started. */
  async function walkoverWinnerStartsRoundTwo(r: Rig, gone: string, l1: Row, l2: Row, before?: () => Promise<void>) {
    await withdrawEntrantCascade(r.auth, gone);
    if (before) await before();
    await homeWin(r.auth, l2);
    await post(r.auth, l1.winner_to_fixture!, "core.start");
  }

  it("K13 a player reinstated AFTER their walkover winner started round 2 is not flagged: the tap could only refuse", async () => {
    // B3 fix round 1 (review #1): main of T11 flagged them, and the tap answered "no slot left" forever.
    const r = await rig({ n: 8 });
    const rows = await rowsOf(r.stageId);
    const l1 = rows.find((x) => x.round_no === 1 && x.seq_in_round === 1)!;
    const l2 = rows.find((x) => x.round_no === 1 && x.seq_in_round === 2)!;
    expect(l1.winner_to_fixture, "premise: lines 1 and 2 feed one round-2 line").toBe(l2.winner_to_fixture);
    const gone = l1.home_entrant_id!;
    await walkoverWinnerStartsRoundTwo(r, gone, l1, l2);
    expect((await rowById(l1.id)).outcome, "premise: their own line is still a walkover against them").toMatchObject({ reason: "withdrew", loser: gone });
    await patchEntrant(r.auth, gone, { status: "registered" });
    expect(await waitingOn(gone)).toBeNull();
    expect(await deskLate(r)).toEqual([]);
  });

  it("K13 a player flagged while their seat was reversible, whose walkover winner then starts round 2, is refused by the tap and keeps waiting", async () => {
    const r = await rig({ n: 8 });
    const rows = await rowsOf(r.stageId);
    const l1 = rows.find((x) => x.round_no === 1 && x.seq_in_round === 1)!;
    const l2 = rows.find((x) => x.round_no === 1 && x.seq_in_round === 2)!;
    const gone = l1.home_entrant_id!;
    await walkoverWinnerStartsRoundTwo(r, gone, l1, l2, async () => {
      await patchEntrant(r.auth, gone, { status: "registered" });
      expect(await waitingOn(gone), "flagged while the walkover was reversible").toBe(r.stageId);
    });
    const answer = await placeWaitingKnockoutEntrant(r.auth, r.stageId, gone);
    expect(answer).toMatchObject({ case: "refused", reason: "KO_LATE_ENTRY_NO_SLOT" });
    expect(await waitingOn(gone), "a refused tap keeps them waiting").toBe(r.stageId);
    expect(await lateRows(r.divisionId)).toEqual([]);
  });

  it("a reinstatement after a bare status flip never left the bracket (its line still open): no marker, no desk row", async () => {
    const r = await rig({ n: 8 });
    const line0 = (await rowsOf(r.stageId)).find((x) => x.round_no === 1 && x.seq_in_round === 1)!;
    const who = line0.home_entrant_id!;
    // `status: "withdrawn"` through PATCH is the bare flip (ruling 111's self-withdrawal): no cascade, nothing walked over.
    await patchEntrant(r.auth, who, { status: "withdrawn" });
    expect((await rowById(line0.id)).outcome, "premise: the line is still open, the entrant still on it").toBeNull();
    await patchEntrant(r.auth, who, { status: "registered" });
    expect(await waitingOn(who)).toBeNull();
    expect(await deskLate(r)).toEqual([]);
  });

  it("a card payment's webhook waits the player, and its retry flags them once", async () => {
    const r = await rig({ n: 6 });
    await sql`update organizations set stripe_charges_enabled = true, stripe_account_id = ${"acct_" + randomUUID().slice(0, 8)} where id = ${r.orgId}`;
    const settings = await putRegistrationSettings(r.auth, r.divisionId, {
      enabled: true,
      entrant_kind: "individual",
      payment_method: "stripe",
      fee_cents: 500,
      form_fields: [],
      opens_at: null,
      closes_at: null,
      capacity: null,
      refund_lock_at: null,
    });
    const { registration } = await seedRegistration(r.competitionId, r.divisionId, settings, { displayName: "Paid" });
    await handleRegistrationCheckoutCompleted(fakeSession(registration.id, 500));
    const [reg] = await sql<{ status: string; entrant_id: string | null }[]>`select status, entrant_id from registrations where id = ${registration.id}`;
    expect(reg, "premise: the payment confirmed the entry").toMatchObject({ status: "confirmed" });
    const entrantId = reg!.entrant_id!;
    expect(await waitingOn(entrantId)).toBe(r.stageId);
    expect(await seatedIn(entrantId)).toEqual([]);

    await handleRegistrationCheckoutCompleted(fakeSession(registration.id, 500));
    expect(await waitingOn(entrantId)).toBe(r.stageId);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from entrants where division_id = ${r.divisionId}`;
    expect(n, "one entrant for one payment").toBe(r.ids.length + 1);
    expect(await deskLate(r), "one flag, once").toEqual([{ kind: "late_players_waiting", count: 1, stageName: r.stageName }]);
    expect(await lateRows(r.divisionId)).toEqual([]);
    expect(getStripeMock).not.toHaveBeenCalled();
  });

  it("a waitlist promotion that seats waits too", async () => {
    const r = await rig({ n: 6 });
    const settings = await putRegistrationSettings(r.auth, r.divisionId, {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 0,
      form_fields: [],
      opens_at: null,
      closes_at: null,
      capacity: null,
      refund_lock_at: null,
    });
    const { registration } = await seedRegistration(
      r.competitionId,
      r.divisionId,
      { fee_cents: 0, currency: "eur", payment_method: "offline" },
      { status: "waitlisted", displayName: "Waiter" },
    );
    const before = await rowsOf(r.stageId);
    const gate = await openPromotionSeatGate(r.divisionId, settings);
    expect(gate, "premise: a seating promotion opens a gate").toBeDefined();
    const promoted = await sql.begin((tx) => promoteOldestWaitlisted(tx, r.divisionId, settings, undefined, gate));
    expect(promoted?.id).toBe(registration.id);
    expect(promoted?.status).toBe("confirmed");
    expect(await waitingOn(promoted!.entrant_id!)).toBe(r.stageId);
    expect(await rowsOf(r.stageId)).toEqual(before);
  });

  it("an arrival into a COMPLETE knockout is marked nowhere (no round 1 left to join), and the desk never counts one", async () => {
    const r = await rig({ n: 6 });
    const { entrantId: early } = await confirmArrival(r, "Early");
    expect(await waitingOn(early), "premise: waiting while the stage runs").toBe(r.stageId);
    await sql`update stages set status = 'complete' where id = ${r.stageId}`;
    expect(await deskLate(r), "a complete stage's waiting list is not counted").toEqual([]);
    const { entrantId, status } = await confirmArrival(r, "Late");
    expect(status).toBe("confirmed");
    expect(await waitingOn(entrantId)).toBeNull();
  });

  it("a waiting player who withdraws leaves the desk count, and the tap then refuses by name", async () => {
    const r = await rig({ n: 6 });
    const { entrantId } = await confirmArrival(r, "Late");
    const { entrantId: other } = await confirmArrival(r, "Later");
    expect(await deskLate(r)).toEqual([{ kind: "late_players_waiting", count: 2, stageName: r.stageName }]);
    await withdrawEntrantCascade(r.auth, entrantId);
    expect(await deskLate(r)).toEqual([{ kind: "late_players_waiting", count: 1, stageName: r.stageName }]);
    expect(await refusal(placeWaitingKnockoutEntrant(r.auth, r.stageId, entrantId))).toMatchObject({
      status: 409,
      code: "KO_LATE_ENTRY_NOT_WAITING",
      message: NOT_WAITING,
    });
    expect(await waitingOn(other)).toBe(r.stageId);
  });

  it("the tap refuses by name: a seated player, a second tap, another division's player; an unknown stage is 404", async () => {
    const r = await rig({ n: 6 });
    const { entrantId } = await confirmArrival(r, "Late");
    let checked = 0;
    const notWaiting = async (p: Promise<unknown>, why: string) => {
      expect(await refusal(p), why).toMatchObject({ status: 409, code: "KO_LATE_ENTRY_NOT_WAITING", message: NOT_WAITING });
      checked++;
    };
    await notWaiting(placeWaitingKnockoutEntrant(r.auth, r.stageId, r.ids[0]!), "an original, seated player");
    await placeWaitingKnockoutEntrant(r.auth, r.stageId, entrantId);
    await notWaiting(placeWaitingKnockoutEntrant(r.auth, r.stageId, entrantId), "the second tap on a placed player");
    const other = await rig({ n: 6 });
    const { entrantId: theirs } = await confirmArrival(other, "Theirs");
    expect(await waitingOn(theirs), "premise: waiting in their own division").toBe(other.stageId);
    await notWaiting(placeWaitingKnockoutEntrant(r.auth, r.stageId, theirs), "another division's waiting player");
    expect(await waitingOn(theirs), "untouched").toBe(other.stageId);
    expect(checked).toBe(3);
    expect(await refusal(placeWaitingKnockoutEntrant(r.auth, randomUUID(), entrantId))).toMatchObject({ status: 404 });
  });

  it("ko_plate: a player waits on the main draw; a tap on the plate is FED_STAGE naming it, a tap on the main draw places", async () => {
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "W4 T11 plate " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
    const division = await createDivision(auth, comp.id, { name: "Open", slug: "open-" + randomUUID().slice(0, 6), sport_key: "badminton", variant_key: SINGLES.variant, config: {} });
    await createEntrants(auth, division.id, Array.from({ length: 6 }, (_, i) => entrant(SINGLES, `P${i + 1}`, i + 1)));
    const stageIds: string[] = [];
    for (const [i, d] of buildTemplateStages("ko_plate", { qualified: 4, swissRounds: 3, poolCount: 2, legs: 1 }).entries()) {
      const [st] = await createStages(auth, division.id, CreateStage.parse({ seq: i + 1, kind: d.kind, name: d.name, config: d.config, progression: d.progression }));
      stageIds.push(st!.id);
    }
    await startDivision(auth, division.id);
    const [mainId, plateId] = stageIds as [string, string];
    const r: Rig = { auth, orgId: auth.orgId, competitionId: comp.id, divisionId: division.id, stageId: mainId, stageName: "", sport: SINGLES, ids: [] };
    const [{ name: mainName }] = await sql<{ name: string }[]>`select name from stages where id = ${mainId}`;
    const { entrantId } = await confirmArrival(r, "Late");
    expect(await waitingOn(entrantId)).toBe(mainId);
    expect(await refusal(placeWaitingKnockoutEntrant(auth, plateId, entrantId))).toMatchObject({
      status: 422,
      code: "KO_LATE_ENTRY_FED_STAGE",
      message: FED(mainName),
    });
    expect(await waitingOn(entrantId), "a refused tap moves nothing").toBe(mainId);
    expect(await placeWaitingKnockoutEntrant(auth, mainId, entrantId)).toMatchObject({ case: "bye", stage_id: mainId });
    expect(await seatedIn(entrantId)).toEqual([mainId]);
  });

  it("two taps at once on two waiting players and ONE bye: one takes it, the other is answered and keeps waiting (x3)", async () => {
    let checked = 0;
    for (let run = 0; run < 3; run++) {
      // Seven in a bracket of eight: one bye, seed 1's.
      const r = await rig({ n: 7 });
      expect(storedByeLines(await rowsOf(r.stageId)).length, "premise: one stored bye").toBe(1);
      const a = (await confirmArrival(r, "A")).entrantId;
      const b = (await confirmArrival(r, "B")).entrantId;
      const answers = await Promise.all([placeWaitingKnockoutEntrant(r.auth, r.stageId, a), placeWaitingKnockoutEntrant(r.auth, r.stageId, b)]);
      // Nothing in the stage has started, so the loser of the race is offered a Rebuild.
      expect(answers.map((x) => x.case).sort(), `run ${run}`).toEqual(["bye", "rebuild_offered"]);
      const won = answers.find((x) => x.case === "bye")!.entrant_id;
      const lost = won === a ? b : a;
      expect(await seatedIn(won)).toEqual([r.stageId]);
      expect(await seatedIn(lost), "never a second seat on one bye").toEqual([]);
      expect([await waitingOn(won), await waitingOn(lost)]).toEqual([null, r.stageId]);
      expect(await deskLate(r)).toEqual([{ kind: "late_players_waiting", count: 1, stageName: r.stageName }]);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("Rebuild seats every active entrant and clears the waiting markers", async () => {
    const r = await rig({ n: 8 });
    const a = (await confirmArrival(r, "A")).entrantId;
    const b = (await confirmArrival(r, "B")).entrantId;
    // A full bracket: no bye, no withdrawn seat; nothing started, so the tap offers the Rebuild.
    expect(await placeWaitingKnockoutEntrant(r.auth, r.stageId, a)).toMatchObject({ case: "rebuild_offered", reason: "KO_LATE_ENTRY_NO_SLOT" });
    expect(await waitingOn(a)).toBe(r.stageId);
    await rebuildStageFixtures(r.auth, r.stageId);
    expect([await waitingOn(a), await waitingOn(b)]).toEqual([null, null]);
    expect(await seatedIn(a)).toEqual([r.stageId]);
    expect(await seatedIn(b)).toEqual([r.stageId]);
    expect(await deskLate(r)).toEqual([]);
  });
});

describe.skipIf(!HAS_DB)("W4 T11: an import into a drawn knockout (football)", () => {
  // single-sport: football — an import's `entrant.create` makes TEAM entrants only, and chess is individual-only.
  it("X-LE-10 an import entrant.create after the draw waits, never refused with round 1 full; the tap offers Rebuild", async () => {
    const csv = (rows: string[]) => ({
      filename: "import.csv",
      contentType: "text/csv",
      buffer: Buffer.from(["Club,Team,Player,DOB,Number,Position,Captain,Division", ...rows].join("\r\n"), "utf8"),
    });
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "W4 T11 import " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
    const slug = "u12-" + randomUUID().slice(0, 4);
    const division = await createDivision(auth, comp.id, { name: "U12", slug, sport_key: "football", variant_key: "small-sided", config: {} });
    const first = await createImport(
      auth,
      csv(["A SC,A Team,Ada One,2014-01-01,1,,,", "B SC,B Team,Bo Two,2014-01-02,2,,,", "C SC,C Team,Cy Three,2014-01-03,3,,,", "D SC,D Team,Di Four,2014-01-04,4,,,"].map((x) => x + slug)),
    );
    expect(first.plan.issues, "premise: the roster file plans clean").toEqual([]);
    await commitImport(auth, first.importId, null);
    const [stage] = await createStages(auth, division.id, { seq: 1, kind: "knockout", name: "Cup", config: {}, progression: null });
    await startDivision(auth, division.id);
    const before = await rowsOf(stage!.id);
    expect(before.filter((x) => x.round_no === 1 && x.home_entrant_id && x.away_entrant_id).length, "premise: four teams, round 1 full").toBe(2);

    const late = await createImport(auth, csv([`E SC,E Team,Ed Five,2014-01-05,5,,,${slug}`]));
    expect(late.plan.stats.entrants, "premise: the file makes one entrant").toBe(1);
    await commitImport(auth, late.importId, null);
    const [e] = await sql<{ id: string; w: string | null }[]>`
      select id, knockout_waiting_stage_id as w from entrants where division_id = ${division.id} and display_name = 'E Team'`;
    expect(e?.w, "the import committed and the team waits").toBe(stage!.id);
    expect(await rowsOf(stage!.id), "nothing moved").toEqual(before);
    const r: Rig = { auth, orgId: auth.orgId, competitionId: comp.id, divisionId: division.id, stageId: stage!.id, stageName: "Cup", sport: SINGLES, ids: [] };
    expect(await deskLate(r)).toEqual([{ kind: "late_players_waiting", count: 1, stageName: "Cup" }]);
    expect(await placeWaitingKnockoutEntrant(auth, stage!.id, e!.id)).toMatchObject({ case: "rebuild_offered", reason: "KO_LATE_ENTRY_NO_SLOT" });
    expect(await waitingOn(e!.id)).toBe(stage!.id);
  });
});

/** A home win on `f` through the scorer's own events (badminton: two games). */
async function homeWin(auth: AuthCtx, f: Row): Promise<void> {
  await post(auth, f.id, "core.start");
  for (let g = 0; g < 2; g++) await post(auth, f.id, "badminton.game.summary", { home: 21, away: 10 });
}

// B3 fix round 1 (review #1): an entrant who already holds a seat is flagged only when the tap could act — their own
// round-1 line a withdrawal's walkover against them, still reversible. Main of T11 flagged every reinstated entrant not
// on an undecided line, and the tap then answered "Round 1 complete; no slot left." forever: a stuck desk row.
describe.skipIf(!HAS_DB)("B3 fix #1: a reinstated seat holder is flagged only when the tap can give the seat back", () => {
  it("a round-1 loser BY PLAY, withdrawn and reinstated, is no late player: no marker, no desk row", async () => {
    const r = await rig({ n: 8 });
    const line = (await rowsOf(r.stageId)).find((x) => x.round_no === 1 && x.seq_in_round === 1)!;
    await homeWin(r.auth, line);
    const loser = line.away_entrant_id!;
    const played = await rowById(line.id);
    expect(played.outcome?.reason, "premise: decided by play, not a walkover").not.toBe("withdrew");
    expect(played.outcome?.winner, "premise: the home player won").toBe(line.home_entrant_id);
    await withdrawEntrantCascade(r.auth, loser);
    await patchEntrant(r.auth, loser, { status: "registered" });
    expect(await waitingOn(loser)).toBeNull();
    expect(await deskLate(r)).toEqual([]);
  });

  it("a round-1 WINNER walked over in round 2, withdrawn and reinstated, is no late player: no marker, no desk row", async () => {
    const r = await rig({ n: 8 });
    const rows = await rowsOf(r.stageId);
    const l1 = rows.find((x) => x.round_no === 1 && x.seq_in_round === 1)!;
    const l2 = rows.find((x) => x.round_no === 1 && x.seq_in_round === 2)!;
    expect(l1.winner_to_fixture, "premise: lines 1 and 2 feed one round-2 line").toBe(l2.winner_to_fixture);
    await homeWin(r.auth, l1);
    await homeWin(r.auth, l2);
    const winner = l1.home_entrant_id!;
    await withdrawEntrantCascade(r.auth, winner);
    const r2 = await rowById(l1.winner_to_fixture!);
    expect(r2.outcome, "premise: the withdrawal walked round 2 over, against them").toMatchObject({ kind: "award", reason: "withdrew", loser: winner });
    await patchEntrant(r.auth, winner, { status: "registered" });
    expect(await waitingOn(winner)).toBeNull();
    expect(await deskLate(r)).toEqual([]);
  });
});

/**
 * B3 fix round 1 (review #2): a scorer starting a round-2 match, stopped INSIDE its transaction right after it took the
 * match's append lock (`fixture:<id>`, as append-event.ts does), while a placing path runs. Deterministic, never a sleep
 * race (the W3 T5 precedent, swiss-undo-pair-next.test.ts): the scorer is released only once Postgres reports the
 * placing path blocked on the scorer's backend (`pg_blocking_pids`), or once it finished without waiting — the defect.
 */
async function againstAScorerInFlight<T>(
  orgId: string,
  fixtureId: string,
  place: () => Promise<T>,
  append: (tx: postgres.TransactionSql) => Promise<unknown> = (tx) => appendEventInTx(tx, orgId, fixtureId, 0, { type: "core.start", payload: {} }),
) {
  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  let holding!: (pid: number) => void;
  const held = new Promise<number>((res) => (holding = res));
  const scorer = withTenant(orgId, async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${"fixture:" + fixtureId}))`;
    const [{ pid }] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
    holding(pid);
    await gate;
    await append(tx);
  }).then(
    () => "committed" as const,
    (e: unknown) => e,
  );
  const pid = await held;
  let settled = false;
  const placed = place().then(
    (v) => ({ ok: v }),
    (e: unknown) => ({ err: e }),
  );
  void placed.then(() => (settled = true));
  let blocked = false;
  for (let i = 0; i < 400 && !settled && !blocked; i++) {
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from pg_stat_activity where ${pid}::int = any(pg_blocking_pids(pid))`;
    blocked = n > 0;
    if (!blocked) await new Promise((res) => setTimeout(res, 25));
  }
  release();
  return { blocked, scorer: await scorer, placed: await placed };
}

/** Six seeded in eight (seeds 1 and 2 hold byes); the round-1 match feeding seed 2's round-2 line is played, so that
 *  line is a real match a scorer can start. RB4-L4 names seed 2's bye — until its round 2 starts (X-LE-9). */
async function seedTwoRoundTwoReady() {
  const r = await rig({ n: 6 });
  const rows = await rowsOf(r.stageId);
  const stored = storedByeLines(rows);
  const seeds = await seedsOf(r.divisionId);
  const holderOfSeed = (n: number) => stored.find((b) => seeds.get(b.holderId) === n)!;
  const b1 = holderOfSeed(1);
  const b2 = holderOfSeed(2);
  expect(rb4L4ExpectedLine(stored, seeds, rows.filter((x) => x.round_no === 1).length), "premise: RB4-L4 names seed 2's bye").toBe(b2.lineId);
  const r2Id = rows.find((x) => x.id === b2.lineId)!.winner_to_fixture!;
  const feeder = rows.find((x) => x.round_no === 1 && x.winner_to_fixture === r2Id && x.id !== b2.lineId)!;
  await homeWin(r.auth, feeder);
  const r2 = await rowById(r2Id);
  expect([r2.home_entrant_id, r2.away_entrant_id].filter(Boolean).length, "premise: seed 2's round-2 line is seated both sides").toBe(2);
  return { r, b1, b2, r2 };
}

describe.skipIf(!HAS_DB)("B3 fix #2: placing waits for a scorer starting round 2 (X-LE-9 under a race)", () => {
  async function expectRoundTwoKept(r2: Row) {
    const after = await rowById(r2.id);
    expect([after.home_entrant_id, after.away_entrant_id], "round 2 keeps both players").toEqual([r2.home_entrant_id, r2.away_entrant_id]);
    expect(after.status, "round 2 is under way").not.toBe("scheduled");
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${r2.id}`;
    expect(n, "the scorer's start committed").toBe(1);
  }

  it("Add late player: the add waits, then takes seed 1's bye — never seed 2's, whose round 2 has started", async () => {
    const { r, b1, r2 } = await seedTwoRoundTwoReady();
    const out = await againstAScorerInFlight(r.orgId, r2.id, () => createEntrants(r.auth, r.divisionId, [entrant(SINGLES, "Late", null)]));
    expect(out.blocked, "the add waited on round 2's append lock").toBe(true);
    expect(out.scorer).toBe("committed");
    expect("ok" in out.placed ? out.placed.ok[0]?.late_entry : out.placed.err).toMatchObject({
      format: "knockout",
      case: "bye",
      fixture_id: b1.lineId,
      opponent_id: b1.holderId,
    });
    await expectRoundTwoKept(r2);
  }, 120_000);

  it("the organiser's tap: it waits, then places the waiting player on seed 1's bye", async () => {
    const { r, b1, r2 } = await seedTwoRoundTwoReady();
    const { entrantId } = await confirmArrival(r, "Late");
    expect(await waitingOn(entrantId), "premise: waiting").toBe(r.stageId);
    const out = await againstAScorerInFlight(r.orgId, r2.id, () => placeWaitingKnockoutEntrant(r.auth, r.stageId, entrantId));
    expect(out.blocked, "the tap waited on round 2's append lock").toBe(true);
    expect(out.scorer).toBe("committed");
    expect("ok" in out.placed ? out.placed.ok : out.placed.err).toMatchObject({ case: "bye", fixture_id: b1.lineId, opponent_id: b1.holderId });
    await expectRoundTwoKept(r2);
  }, 120_000);
});

// B3 fix round 2: the placing lock takes `fixture:` keys in BRACKET order — every round-1 line, then the lines they feed
// — the global order of every bracket writer (fed-seats.ts `bracketOrder`: ascending (round_no, id)). Round 1 fixed
// sorted all the keys together by id, so an add could hold a round-2 line while it queued on a round-1 line whose void
// (holding its own lock, as every append does) then asked for that round-2 line to take its seat back: 40P01.
describe.skipIf(!HAS_DB)("B3 fix #2 round 2: placing takes round 1's append locks before the lines they feed", () => {
  /** Six seeded in eight, both round-1 matches played; the one whose round-2 line's id sorts BEFORE its own — the shape
   *  where one id-sorted pass takes round 2's lock first. Re-rigged until one exists (each match ~1/2). */
  async function playedLineFeedingAnEarlierId() {
    for (let attempt = 1; attempt <= 8; attempt++) {
      const r = await rig({ n: 6 });
      const matches = (await rowsOf(r.stageId)).filter((x) => x.round_no === 1 && x.home_entrant_id !== null && x.away_entrant_id !== null);
      expect(matches.length, "premise: two round-1 matches beside the two byes").toBe(2);
      for (const m of matches) await homeWin(r.auth, m);
      const line = matches.find((m) => m.winner_to_fixture! < m.id);
      if (line !== undefined) return { r, line, attempts: attempt };
    }
    throw new Error("rig: eight draws without a round-1 match feeding a line whose id sorts before its own");
  }

  it("a void taking a round-1 result back, its line's lock held while an add waits: no 40P01, the void commits, then the add places", async () => {
    const { r, line } = await playedLineFeedingAnEarlierId();
    const next = line.winner_to_fixture!;
    expect((await rowById(next)).home_entrant_id ?? (await rowById(next)).away_entrant_id, "premise: round 2 holds a seat").not.toBeNull();
    const [last] = await sql<{ id: string; seq: number }[]>`
      select id, seq from score_events where fixture_id = ${line.id} order by seq desc limit 1`;
    const out = await againstAScorerInFlight(
      r.orgId,
      line.id,
      () => createEntrants(r.auth, r.divisionId, [entrant(SINGLES, "Late", null)]),
      (tx) => appendEventInTx(tx, r.orgId, line.id, last!.seq, { type: "core.void", payload: { event_id: last!.id }, voids: last!.id }),
    );
    expect(out.blocked, "the add waited on the round-1 line's append lock").toBe(true);
    expect(out.scorer, "the void's take-back committed").toBe("committed");
    expect("ok" in out.placed ? out.placed.ok[0]?.late_entry : out.placed.err).toMatchObject({ format: "knockout", case: "bye" });
    const after = await rowById(line.id);
    expect(after.outcome, "the void took the round-1 result back").toBeNull();
    const fed = await rowById(next);
    expect([fed.home_entrant_id, fed.away_entrant_id], "its winner left the round-2 seat").not.toContain(line.home_entrant_id);
  }, 240_000);
});
