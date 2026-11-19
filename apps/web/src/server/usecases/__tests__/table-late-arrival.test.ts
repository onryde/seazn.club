// W5 app-A Task 6 (X-CU-8; RB5-L10; Review Focus 1 and 2) — AUTOMATIC arrivals into a running root league or group, driven
// through every real door on a real database: a free confirmation, a card payment's webhook (and its retry), a waitlist
// promotion, an import and a Reinstate. None is placed by the app and none is refused (a payment that has moved cannot be
// un-taken by a 409): the entrant WAITS — `entrants.table_waiting_stage_id` (V532) names the stage and the desk counts it — and
// the organiser's one tap (`placeWaitingTableEntrant`, the route `POST /stages/{id}/late-entrants/{entrantId}/place`) runs the
// cases "Add late player" runs (Task 5's admission, never a copy of it).
//
// differential: today (848366a556) every automatic door calls only the Swiss and knockout admitters
// (registrations/materialise.ts:231-232, imports.ts:734-735, entrants.ts:1093-1094), so an arrival into a started league is
// seated nowhere and flagged nowhere — the marker stays null and the desk counts nobody.
//
// "Seatless" (the parked Task 5 review m2): an arrival waits only when it holds NO fixture of any kind in the stage — V532's own
// backfill predicate — so a Reinstate whose lines still exist (table lines or an Add match row) never waits.
//
// Expected values: the rulebook's cases (RB5-L10: an automatic arrival waits, never placed, never refused; RB5-L3: the tap's
// catch-up seats the newcomer against every member still in the field, once per leg — so the opponents are the rig's own
// entrants as they stood before the arrival), the refusal table's English typed here, and the rows before the arrival — never
// the code under test.
//
// Sports: the confirmation + tap row sweeps badminton singles, badminton pairs and chess (the boardgame module), each from the
// engine registry by key; the import row is football (an import's `entrant.create` makes TEAM entrants only). The payment,
// waitlist, concurrency and cleanup rows run on badminton singles: they read the marker, the seats and the ledger, which no
// sport field reaches.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { builtinModules } from "@seazn/engine/sports";
import { connectionOptions, sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { rankedStageStandings } from "@/server/engine-db/competition";
import { getCompetitionDesk } from "../competition-desk";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants, patchEntrant } from "../entrants";
import { commitImport, createImport } from "../imports";
import {
  confirmRegistration,
  handleRegistrationCheckoutCompleted,
  openPromotionSeatGate,
  promoteOldestWaitlisted,
  putRegistrationSettings,
  withdrawRegistrationPublic,
} from "../registrations";
import { placeWaitingLateEntrant, placeWaitingTableEntrant } from "../roundrobin-late-entry";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { createStages, deleteStage, rebuildStageFixtures } from "../stages";
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

/** The refusal table's English rows (lib/roundrobin-refusals.ts), typed here as the oracle. */
const NOT_WAITING = "This player isn't waiting for a place.";
const ALREADY_PLACED = "This player already has their fixtures.";

type Kind = "individual" | "pair" | "team";
interface SportPick {
  key: string;
  variant: string;
  kind: Kind;
}
/** A sport by key from the engine's registry, its first declared variant, and an entrant kind it declares. */
function sport(key: string, kind?: Kind): SportPick {
  const m = builtinModules.find((x) => x.key === key);
  if (m === undefined) throw new Error(`no engine module ${key}`);
  const variant = Object.keys(m.variants)[0];
  if (variant === undefined) throw new Error(`${key} declares no variant`);
  const declared = (m.entrantModel?.kinds ?? ["individual"]) as string[];
  const k = kind ?? ((m.entrantModel?.defaultKind ?? "individual") as Kind);
  if (!declared.includes(k)) throw new Error(`${key} declares no ${k} entrant`);
  return { key, variant, kind: k };
}
const SINGLES = sport("badminton", "individual");
const PAIRS = sport("badminton", "pair");
const CHESS = sport("boardgame");
const SWEEP = [SINGLES, PAIRS, CHESS];

interface Rig {
  auth: AuthCtx;
  orgId: string;
  competitionId: string;
  divisionId: string;
  stageId: string;
  stageName: string;
  /** The entrants the rig made, in seed order. */
  ids: string[];
}

/** `n` entrants seeded 1..n, one root table stage named "Table" (a league unless `group`), started unless `start: false`. */
async function rig(opts: { n: number; sport?: SportPick; start?: boolean; group?: { pools: number }; legs?: number }): Promise<Rig> {
  const s = opts.sport ?? SINGLES;
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "W5 T6 " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
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
    Array.from({ length: opts.n }, (_, i) => ({ kind: s.kind, display_name: `P${i + 1}`, seed: i + 1, members: [] })),
  );
  const legs = opts.legs ?? 1;
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: opts.group ? "group" : "league",
    name: "Table",
    config: opts.group ? { legs, pools: { count: opts.group.pools } } : { legs },
    progression: null,
  });
  if (opts.start !== false) await startDivision(auth, division.id);
  return { auth, orgId: auth.orgId, competitionId: comp.id, divisionId: division.id, stageId: stage!.id, stageName: "Table", ids: made.map((e) => e.id) };
}

interface Row {
  id: string;
  round_no: number;
  ext_key: string | null;
  pool_id: string | null;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  scheduled_at: Date | null;
  court_id: string | null;
  status: string;
}
const rowsOf = (stageId: string) =>
  sql<Row[]>`
    select id, round_no, ext_key, pool_id, home_entrant_id, away_entrant_id, scheduled_at, court_id, status
      from fixtures where stage_id = ${stageId} order by round_no, seq_in_round, id`;

async function waitingOn(entrantId: string): Promise<string | null> {
  const [e] = await sql<{ w: string | null }[]>`select table_waiting_stage_id as w from entrants where id = ${entrantId}`;
  return e!.w;
}

/** The lines seating `entrantId` in `stageId`. */
async function linesOf(stageId: string, entrantId: string): Promise<Row[]> {
  return (await rowsOf(stageId)).filter((r) => r.home_entrant_id === entrantId || r.away_entrant_id === entrantId);
}

/** `entrantId`'s opponents over `rows`, sorted. */
function opponents(rows: readonly Row[], entrantId: string): string[] {
  return rows.map((r) => (r.home_entrant_id === entrantId ? r.away_entrant_id! : r.home_entrant_id!)).sort();
}

async function ledger(divisionId: string) {
  return (
    await sql<{ payload: Record<string, unknown> }[]>`
      select payload from division_events where division_id = ${divisionId} and type = 'roundrobin_late_entry' order by seq`
  ).map((r) => r.payload);
}

/** The desk's late-player rows for the rig's division (`getCompetitionDesk`, the loader the desk and Match Day read). */
async function deskLate(r: Rig) {
  const desk = await getCompetitionDesk(r.auth, r.competitionId);
  return (desk.divisions.get(r.divisionId)?.attention ?? []).filter((a) => a.kind === "late_players_waiting");
}
const WAITING_ROW = (r: Rig, count: number) => [{ kind: "late_players_waiting", count, stageName: r.stageName, table: true }];

/** The desk's "arrived after the table finished" rows (fix round 1, derived on read). */
async function deskUnplaced(r: Rig) {
  const desk = await getCompetitionDesk(r.auth, r.competitionId);
  return (desk.divisions.get(r.divisionId)?.attention ?? []).filter((a) => a.kind === "late_unplaced");
}

/** A free, offline registration confirmed through `confirmRegistration` → `materialise`. */
async function confirmArrival(r: Rig, name: string): Promise<{ entrantId: string; status: string; registrationId: string; token: string }> {
  const { registration, access_token } = await seedRegistration(r.competitionId, r.divisionId, { fee_cents: 0, currency: "eur", payment_method: "offline" }, { displayName: name });
  const confirmed = await confirmRegistration(r.auth, registration.id);
  expect(confirmed.entrant_id, `rig: ${name}'s confirmation made an entrant`).toBeTruthy();
  return { entrantId: confirmed.entrant_id!, status: confirmed.status, registrationId: registration.id, token: access_token };
}

async function refusal(p: Promise<unknown>): Promise<HttpError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, "the tap is refused").toBeInstanceOf(HttpError);
  return err as HttpError;
}

/** Start round 1 (a scorer's `core.start` on its first line: the K4 predicate's first arm), so the stage has started. */
async function startRoundOne(r: Rig): Promise<void> {
  const first = (await rowsOf(r.stageId)).find((x) => x.round_no === 1)!;
  const [{ n }] = await sql<{ n: number }[]>`select coalesce(max(seq), 0)::int as n from score_events where fixture_id = ${first.id}`;
  await scoreEvent(r.auth, first.id, { expected_seq: n, type: "core.start", payload: {} });
}

describe.skipIf(!HAS_DB)("W5 T6: automatic arrivals into a running league or group wait for one tap (X-CU-8)", () => {
  it("X-CU-8 the empty case first: before Start an arrival is nobody's to wait — no marker, no desk row", async () => {
    const r = await rig({ n: 4, start: false });
    const { entrantId } = await confirmArrival(r, "Early");
    expect(await waitingOn(entrantId)).toBeNull();
    expect(await deskLate(r)).toEqual([]);
  });

  for (const s of SWEEP) {
    it(`X-CU-8 a confirmation into a started league waits with a flag, and one tap places it [${s.key}/${s.kind}]`, async () => {
      // differential: today seated nowhere and no flag.
      const r = await rig({ n: 4, sport: s });
      await startRoundOne(r);
      const before = await rowsOf(r.stageId);
      const { entrantId, status } = await confirmArrival(r, "Late");
      expect(status, "never refused").toBe("confirmed");
      expect(await waitingOn(entrantId), "waits on the root league").toBe(r.stageId);
      expect(await linesOf(r.stageId, entrantId), "seated nowhere").toEqual([]);
      expect(await rowsOf(r.stageId), "nothing moved").toEqual(before);
      expect(await ledger(r.divisionId), "no ledger row: the wait is no placement").toEqual([]);
      expect(await deskLate(r)).toEqual(WAITING_ROW(r, 1));

      const placed = await placeWaitingTableEntrant(r.auth, r.stageId, entrantId);
      expect(placed).toMatchObject({ format: "league", case: "catch_up", source: "organiser", entrant_id: entrantId, stage_id: r.stageId });
      const mine = await linesOf(r.stageId, entrantId);
      // RB5-L3: one line against every member, one leg.
      expect(opponents(mine, entrantId), "the newcomer plays every member once").toEqual([...r.ids].sort());
      expect(await waitingOn(entrantId), "the marker clears").toBeNull();
      expect(await deskLate(r), "the desk row goes").toEqual([]);
    });
  }

  it("X-CU-8 a paid confirmation into a started league waits with a flag", async () => {
    // differential: today seated nowhere and no flag.
    const r = await rig({ n: 4 });
    await startRoundOne(r);
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
    expect(await linesOf(r.stageId, entrantId)).toEqual([]);
    expect(await deskLate(r)).toEqual(WAITING_ROW(r, 1));
    expect(getStripeMock).not.toHaveBeenCalled();
  });

  it("X-CU-8 a webhook retry flags one waiting entrant once", async () => {
    // Review Focus 1: Stripe redelivers. One entrant, one marker, one desk flag, never a catch-up set.
    const r = await rig({ n: 4 });
    await startRoundOne(r);
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
    const before = await rowsOf(r.stageId);
    await handleRegistrationCheckoutCompleted(fakeSession(registration.id, 500));
    await handleRegistrationCheckoutCompleted(fakeSession(registration.id, 500));
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from entrants where division_id = ${r.divisionId}`;
    expect(n, "one entrant for one payment").toBe(r.ids.length + 1);
    const [{ w }] = await sql<{ w: number }[]>`select count(*)::int as w from entrants where table_waiting_stage_id = ${r.stageId}`;
    expect(w, "one waiting marker").toBe(1);
    expect(await deskLate(r), "one flag, once").toEqual(WAITING_ROW(r, 1));
    expect(await rowsOf(r.stageId), "never a catch-up set").toEqual(before);
    expect(await ledger(r.divisionId)).toEqual([]);
  });

  it("X-CU-8 a waitlist promotion into a started league waits with a flag", async () => {
    // differential: today seated nowhere and no flag.
    const r = await rig({ n: 4 });
    await startRoundOne(r);
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
    expect(await deskLate(r)).toEqual(WAITING_ROW(r, 1));
  });

  it("X-CU-8 a waiting arrival is not listed in the table until placed", async () => {
    // F9 — pin, no defect expected: the stage's entrants are the seated set (server/engine-db/competition.ts:537-542).
    const r = await rig({ n: 4 });
    await startRoundOne(r);
    const { entrantId } = await confirmArrival(r, "Late");
    const listed = await withTenant(r.orgId, async (tx) => (await rankedStageStandings(tx, r.stageId)).map((x) => x.entrantId));
    expect(listed.length, "anti-vacuity: the table lists rows").toBe(r.ids.length);
    expect(listed).not.toContain(entrantId);
    await placeWaitingTableEntrant(r.auth, r.stageId, entrantId);
    const after = await withTenant(r.orgId, async (tx) => (await rankedStageStandings(tx, r.stageId)).map((x) => x.entrantId));
    expect(after, "placed, the newcomer is listed").toContain(entrantId);
  });

  it("X-CU-8 a Reinstate whose lines still exist keeps them and never waits", async () => {
    // The lines' walkovers are reversed by Task 8 (the table withdrawal); this task's half is that such a Reinstate never waits.
    const r = await rig({ n: 4 });
    await startRoundOne(r);
    const gone = r.ids[3]!;
    const mine = (await linesOf(r.stageId, gone)).map((x) => x.id).sort();
    expect(mine.length, "premise: the leaver holds lines").toBe(r.ids.length - 1);
    await withdrawEntrantCascade(r.auth, gone);
    const back = await patchEntrant(r.auth, gone, { status: "registered" });
    expect(back.status).toBe("registered");
    expect(await waitingOn(gone), "never waits").toBeNull();
    expect((await linesOf(r.stageId, gone)).map((x) => x.id).sort(), "the same lines, none added").toEqual(mine);
    expect(await deskLate(r)).toEqual([]);
  });

  it("X-CU-8 a Reinstate with no lines waits", async () => {
    // Withdrawn before Start (a plain status flip), so Start drew the league without them; reinstated after it.
    const r = await rig({ n: 5, start: false });
    const gone = r.ids[4]!;
    await withdrawEntrantCascade(r.auth, gone);
    await startDivision(r.auth, r.divisionId);
    expect(await linesOf(r.stageId, gone), "premise: drawn without them").toEqual([]);
    const back = await patchEntrant(r.auth, gone, { status: "registered" });
    expect(back.late_entry).toEqual({ format: "league", entrant_id: gone, stage_id: r.stageId, case: "waiting", source: "automatic" });
    expect(await waitingOn(gone)).toBe(r.stageId);
    expect(await deskLate(r)).toEqual(WAITING_ROW(r, 1));
  });

  it("X-CU-8 the arrival is never refused: into a COMPLETE league it commits and the answer says the stage is complete", async () => {
    const r = await rig({ n: 5, start: false });
    const gone = r.ids[4]!;
    await withdrawEntrantCascade(r.auth, gone);
    await startDivision(r.auth, r.divisionId);
    await sql`update stages set status = 'complete' where id = ${r.stageId}`;
    const { entrantId, status } = await confirmArrival(r, "Late");
    expect(status, "the confirmation commits").toBe("confirmed");
    expect(await waitingOn(entrantId), "a finished table takes no one (RB5-L8): no marker").toBeNull();
    const back = await patchEntrant(r.auth, gone, { status: "registered" });
    expect(back.status, "the Reinstate commits").toBe("registered");
    expect(back.late_entry).toEqual({
      format: "league",
      entrant_id: gone,
      stage_id: r.stageId,
      case: "refused",
      source: "automatic",
      reason: "RR_LATE_ENTRY_STAGE_COMPLETE",
    });
    expect(await waitingOn(gone)).toBeNull();
    expect(await deskLate(r)).toEqual([]);
  });

  it("X-CU-8 one tap runs the cases: catch-up written unscheduled, marker cleared, ledger source organiser with the fixture ids", async () => {
    const r = await rig({ n: 4 });
    await startRoundOne(r);
    const { entrantId } = await confirmArrival(r, "Late");
    const placed = await placeWaitingTableEntrant(r.auth, r.stageId, entrantId);
    expect(placed.case).toBe("catch_up");
    const mine = await linesOf(r.stageId, entrantId);
    expect(mine.length, "anti-vacuity: one line per member").toBe(r.ids.length);
    for (const l of mine) {
      expect({ at: l.scheduled_at, court: l.court_id, status: l.status }, "RB5-L13: unscheduled").toEqual({ at: null, court: null, status: "scheduled" });
      expect(l.ext_key, "a catch-up key").toMatch(/^rr-(cu|by)-r\d+-c\d+-L1$/);
    }
    expect(await waitingOn(entrantId)).toBeNull();
    const rows = await ledger(r.divisionId);
    expect(rows.map((p) => [p.entrant_id, p.source, p.case])).toEqual([[entrantId, "organiser", "catch_up"]]);
    // Task 5b's "Joined round N" marker reads these ids.
    expect([...(rows[0]!.fixture_ids as string[])].sort()).toEqual(mine.map((l) => l.id).sort());
    expect((placed.fixtures ?? []).map((f) => f.fixture_id).sort()).toEqual(mine.map((l) => l.id).sort());
  });

  it("X-CU-8 a second waiting arrival placed after the first owes the first too (two late entrants owe each other)", async () => {
    const r = await rig({ n: 4 });
    await startRoundOne(r);
    const a = (await confirmArrival(r, "A")).entrantId;
    const b = (await confirmArrival(r, "B")).entrantId;
    expect(await deskLate(r)).toEqual(WAITING_ROW(r, 2));
    await placeWaitingTableEntrant(r.auth, r.stageId, a);
    expect(await deskLate(r)).toEqual(WAITING_ROW(r, 1));
    await placeWaitingTableEntrant(r.auth, r.stageId, b);
    expect(opponents(await linesOf(r.stageId, b), b)).toEqual([...r.ids, a].sort());
    expect(opponents(await linesOf(r.stageId, a), a)).toEqual([...r.ids, b].sort());
    expect(await deskLate(r)).toEqual([]);
  });

  it("X-CU-8 two taps, one player: one catch-up set (x3)", async () => {
    // Review Focus 2: the second tap answers RR_LATE_ENTRY_ALREADY_PLACED by name.
    let checked = 0;
    for (let run = 0; run < 3; run++) {
      const r = await rig({ n: 4 });
      await startRoundOne(r);
      const { entrantId } = await confirmArrival(r, "Late");
      const settled = await Promise.allSettled([
        placeWaitingTableEntrant(r.auth, r.stageId, entrantId),
        placeWaitingTableEntrant(r.auth, r.stageId, entrantId),
      ]);
      const ok = settled.filter((x) => x.status === "fulfilled");
      const bad = settled.flatMap((x) => (x.status === "rejected" ? [x.reason as HttpError] : []));
      expect(ok.length, `run ${run}: one tap places`).toBe(1);
      expect(bad.map((e) => ({ status: e.status, code: e.code, message: e.message })), `run ${run}`).toEqual([
        { status: 409, code: "RR_LATE_ENTRY_ALREADY_PLACED", message: ALREADY_PLACED },
      ]);
      const mine = await linesOf(r.stageId, entrantId);
      expect(opponents(mine, entrantId), `run ${run}: one catch-up set`).toEqual([...r.ids].sort());
      expect(await ledger(r.divisionId), `run ${run}: one ledger row`).toHaveLength(1);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("X-CU-8 the tap refuses by name: an original seated player, another division's waiting player, a never-waiting one; an unknown stage is 404", async () => {
    const r = await rig({ n: 4 });
    await startRoundOne(r);
    let checked = 0;
    expect(await refusal(placeWaitingTableEntrant(r.auth, r.stageId, r.ids[0]!)), "an original").toMatchObject({
      status: 409,
      code: "RR_LATE_ENTRY_ALREADY_PLACED",
      message: ALREADY_PLACED,
    });
    checked++;
    const other = await rig({ n: 4 });
    await startRoundOne(other);
    const { entrantId: theirs } = await confirmArrival(other, "Theirs");
    expect(await refusal(placeWaitingTableEntrant(r.auth, r.stageId, theirs)), "another division's").toMatchObject({
      status: 409,
      code: "RR_LATE_ENTRY_NOT_WAITING",
      message: NOT_WAITING,
    });
    checked++;
    expect(await waitingOn(theirs), "untouched").toBe(other.stageId);
    const [early] = await createEntrants(r.auth, r.divisionId, [{ kind: "individual", display_name: "Bench", seed: null, members: [] }]);
    // An organiser's add is placed at once (Task 5), so a never-waiting unseated entrant is made by hand here.
    await sql`delete from fixtures where stage_id = ${r.stageId} and ${early!.id} in (home_entrant_id, away_entrant_id)`;
    expect(await refusal(placeWaitingTableEntrant(r.auth, r.stageId, early!.id)), "never flagged, unseated").toMatchObject({
      status: 409,
      code: "RR_LATE_ENTRY_NOT_WAITING",
    });
    checked++;
    expect(checked).toBe(3);
    expect(await refusal(placeWaitingTableEntrant(r.auth, randomUUID(), r.ids[0]!))).toMatchObject({ status: 404 });
  });

  it("X-CU-8 the route's dispatcher sends a table stage to the table tap", async () => {
    const r = await rig({ n: 4 });
    await startRoundOne(r);
    const { entrantId } = await confirmArrival(r, "Late");
    expect(await placeWaitingLateEntrant(r.auth, r.stageId, entrantId)).toMatchObject({ format: "league", case: "catch_up" });
    expect(await waitingOn(entrantId)).toBeNull();
  });

  it("X-CU-8 a waiting arrival into a two-pool group: the tap places it in the pool named", async () => {
    const r = await rig({ n: 6, group: { pools: 2 } });
    await startRoundOne(r);
    const pools = await sql<{ id: string; key: string }[]>`select id, key from pools where stage_id = ${r.stageId} order by key`;
    expect(pools.map((p) => p.key), "premise: pools A and B").toEqual(["A", "B"]);
    const { entrantId } = await confirmArrival(r, "Late");
    expect(await waitingOn(entrantId)).toBe(r.stageId);
    const placed = await placeWaitingTableEntrant(r.auth, r.stageId, entrantId, "B");
    expect(placed).toMatchObject({ format: "group", case: "catch_up", pool_key: "B" });
    const mine = await linesOf(r.stageId, entrantId);
    const poolB = pools.find((p) => p.key === "B")!.id;
    const membersB = new Set(
      (await rowsOf(r.stageId)).filter((x) => x.pool_id === poolB && x.home_entrant_id !== entrantId && x.away_entrant_id !== entrantId).flatMap((x) => [x.home_entrant_id!, x.away_entrant_id!]),
    );
    expect(mine.length, "anti-vacuity").toBeGreaterThan(0);
    expect(mine.every((l) => l.pool_id === poolB), "every line in pool B").toBe(true);
    expect(opponents(mine, entrantId)).toEqual([...membersB].sort());
  });
});

describe.skipIf(!HAS_DB)("W5 B2 batch: which byes a placement may take (RB5-L3, L4)", () => {
  type Bye = { pool: string | null; round_no: number; leg: number; entrant_id: string };
  const byesOf = async (stageId: string) =>
    ((await sql<{ b: Bye[] | null }[]>`select config -> 'round_byes' as b from stages where id = ${stageId}`)[0]!.b ?? []);
  /** A scorer's `core.start` on one line (the K4 predicate's first arm). */
  async function startLine(r: Rig, fixtureId: string): Promise<void> {
    const [{ n }] = await sql<{ n: number }[]>`select coalesce(max(seq), 0)::int as n from score_events where fixture_id = ${fixtureId}`;
    await scoreEvent(r.auth, fixtureId, { expected_seq: n, type: "core.start", payload: {} });
  }

  it("I1 started rounds are read PER POOL: round 3 started in pool B only leaves pool A's round-3 bye to take, as in a fresh pool", async () => {
    // RB5-L3: the newcomer's line goes into the pool's own unstarted bye slots. RB5-L4: a bye in a round that has STARTED in that
    // pool is not consumed. Pool B starting its round 3 says nothing about pool A's round 3.
    const r = await rig({ n: 10, group: { pools: 2 } });
    const pools = await sql<{ id: string; key: string }[]>`select id, key from pools where stage_id = ${r.stageId} order by key`;
    expect(pools.map((p) => p.key), "premise: pools A and B").toEqual(["A", "B"]);
    const [A, B] = [pools[0]!.id, pools[1]!.id];
    const rows = await rowsOf(r.stageId);
    for (const [pool, round] of [[A, 1], [B, 1], [B, 3]] as const) await startLine(r, rows.find((x) => x.pool_id === pool && x.round_no === round)!.id);
    const byesA = (await byesOf(r.stageId)).filter((b) => b.pool === A);
    expect(byesA.map((b) => b.round_no), "premise: five in pool A, one bye a round (the generator's own declaration)").toEqual([1, 2, 3, 4, 5]);
    const { entrantId } = await confirmArrival(r, "Late");
    await placeWaitingTableEntrant(r.auth, r.stageId, entrantId, "A");
    const mine = await linesOf(r.stageId, entrantId);
    // Pool A started round 1 only: rounds 2-5 are its unstarted bye slots, each one taken against its holder.
    const want = byesA.filter((b) => b.round_no !== 1).map((b) => `${b.round_no}:${b.entrant_id}`);
    const got = mine.filter((l) => /rr-by-/.test(l.ext_key ?? "")).map((l) => `${l.round_no}:${l.home_entrant_id === entrantId ? l.away_entrant_id : l.home_entrant_id}`);
    expect(got.sort(), "the round-3 bye is taken, as in a fresh pool").toEqual(want.sort());
    expect(want.length, "anti-vacuity").toBe(4);
    expect((await byesOf(r.stageId)).filter((b) => b.pool === A).map((b) => b.round_no), "only round 1's bye stays").toEqual([1]);
    expect(mine.every((l) => l.pool_id === A), "every line in pool A").toBe(true);
  });

  it("M1 a waiting player an organiser put into an Add match in round 3 never also takes round 3's bye on the tap", async () => {
    // A player plays at most once a round: the Add match row (adhoc-N) is a fixed seat, the newcomer's as much as anyone's.
    // differential: before this fix the tap consumed the round-3 bye and seated the newcomer twice in round 3.
    const r = await rig({ n: 5 });
    await startRoundOne(r);
    const { entrantId } = await confirmArrival(r, "Late");
    const byes = await byesOf(r.stageId);
    const holder3 = byes.find((b) => b.round_no === 3)!.entrant_id;
    const other = r.ids.find((id) => id !== holder3)!;
    await sql`
      insert into fixtures (stage_id, division_id, round_no, seq_in_round, home_entrant_id, away_entrant_id, ext_key, status)
      values (${r.stageId}, ${r.divisionId}, 3, 9, ${entrantId}, ${other}, 'adhoc-1', 'scheduled')`;
    await placeWaitingTableEntrant(r.auth, r.stageId, entrantId);
    const mine = await linesOf(r.stageId, entrantId);
    const perRound = new Map<number, number>();
    for (const l of mine) perRound.set(l.round_no, (perRound.get(l.round_no) ?? 0) + 1);
    expect(perRound.get(3), "round 3: the Add match only").toBe(1);
    expect([...perRound.values()].every((n) => n === 1), "never twice in a round").toBe(true);
    expect((await byesOf(r.stageId)).some((b) => b.round_no === 3 && b.entrant_id === holder3), "round 3's bye is kept").toBe(true);
    // The round-3 holder is still owed: an appended catch-up line, after every drawn round.
    const vsHolder = mine.filter((l) => l.home_entrant_id === holder3 || l.away_entrant_id === holder3);
    expect(vsHolder.map((l) => /rr-cu-/.test(l.ext_key ?? "")), "owed, appended").toEqual([true]);
  });
});

describe.skipIf(!HAS_DB)("W5 T6: every cleanup path of the waiting marker (storage table, G7)", () => {
  it("X-CU-8 Rebuild clears every waiting marker", async () => {
    // Nothing scored (Rebuild refuses a stage with a result): two arrivals wait, Rebuild draws them both in.
    const r = await rig({ n: 4 });
    const a = (await confirmArrival(r, "A")).entrantId;
    const b = (await confirmArrival(r, "B")).entrantId;
    expect([await waitingOn(a), await waitingOn(b)], "premise: both wait").toEqual([r.stageId, r.stageId]);
    await rebuildStageFixtures(r.auth, r.stageId);
    expect([await waitingOn(a), await waitingOn(b)]).toEqual([null, null]);
    expect((await linesOf(r.stageId, a)).length, "seated by the redraw").toBe(r.ids.length + 1);
    expect(await deskLate(r)).toEqual([]);
  });

  it("X-CU-8 withdrawing a waiting entrant clears the marker", async () => {
    // differential: none — the clear is this task's own; red until the cascade writes it.
    const r = await rig({ n: 4 });
    await startRoundOne(r);
    const { entrantId } = await confirmArrival(r, "Late");
    const { entrantId: other } = await confirmArrival(r, "Later");
    expect(await deskLate(r)).toEqual(WAITING_ROW(r, 2));
    await withdrawEntrantCascade(r.auth, entrantId);
    expect(await waitingOn(entrantId), "the marker clears").toBeNull();
    expect(await deskLate(r)).toEqual(WAITING_ROW(r, 1));
    expect(await waitingOn(other), "another's marker stands").toBe(r.stageId);
    await withdrawEntrantCascade(r.auth, other);
    expect(await waitingOn(other)).toBeNull();
    expect(await deskLate(r), "the desk count back to 0").toEqual([]);
    expect(await refusal(placeWaitingTableEntrant(r.auth, r.stageId, entrantId))).toMatchObject({ status: 409, code: "RR_LATE_ENTRY_NOT_WAITING" });
  });

  it("X-CU-8 deleting the stage nulls the marker", async () => {
    // Pin: V532's `on delete set null`.
    const r = await rig({ n: 4 });
    const { entrantId } = await confirmArrival(r, "Late");
    expect(await waitingOn(entrantId), "premise").toBe(r.stageId);
    await deleteStage(r.auth, r.stageId);
    const [st] = await sql`select 1 from stages where id = ${r.stageId}`;
    expect(st, "premise: the stage is gone").toBeUndefined();
    expect(await waitingOn(entrantId)).toBeNull();
  });
});

describe.skipIf(!HAS_DB)("W5 T6 fix round 1: a table that finished flags late arrivals on the desk (RB5-L8, L10)", () => {
  /** A league of four, started, then marked complete (a finished table: every line stands as drawn). */
  async function finished(): Promise<Rig> {
    const r = await rig({ n: 4 });
    await sql`update stages set status = 'complete' where id = ${r.stageId}`;
    return r;
  }

  it("X-CU-8 the empty case first: a finished table with nobody late raises nothing", async () => {
    const r = await finished();
    expect(await deskUnplaced(r)).toEqual([]);
  });

  it("X-CU-8 a confirmation into a COMPLETE league: no marker, and the desk names the player arrived after the table finished", async () => {
    // differential: today (b5062a338d) the confirmation commits, no marker, and the desk shows nothing — a paid player in no stage.
    const r = await finished();
    const { entrantId, registrationId, token } = await confirmArrival(r, "Late Lou");
    expect(await waitingOn(entrantId), "a finished table takes no one: no marker").toBeNull();
    expect(await deskLate(r), "no waiting row: there is no tap").toEqual([]);
    expect(await deskUnplaced(r)).toEqual([{ kind: "late_unplaced", count: 1, stageName: r.stageName, names: ["Late Lou"] }]);
    // Their leaving clears it (derived): the registrant withdraws their own entry.
    await withdrawRegistrationPublic(registrationId, token);
    expect(await deskUnplaced(r), "withdrawn: the count is 0").toEqual([]);
  });

  it("X-CU-8 positive pair: the same arrival into a RUNNING league waits and is never named as arrived-after-finish", async () => {
    const r = await rig({ n: 4 });
    const { entrantId } = await confirmArrival(r, "Late Lou");
    expect(await waitingOn(entrantId)).toBe(r.stageId);
    expect(await deskLate(r)).toEqual(WAITING_ROW(r, 1));
    expect(await deskUnplaced(r)).toEqual([]);
  });

  it("X-CU-8 the originals of a finished table are never named, and a withdrawn arrival leaves it (cascade)", async () => {
    const r = await finished();
    const a = (await confirmArrival(r, "Ann Late")).entrantId;
    await confirmArrival(r, "Bo Late");
    expect(await deskUnplaced(r)).toEqual([{ kind: "late_unplaced", count: 2, stageName: r.stageName, names: ["Ann Late", "Bo Late"] }]);
    await withdrawEntrantCascade(r.auth, a);
    expect(await deskUnplaced(r)).toEqual([{ kind: "late_unplaced", count: 1, stageName: r.stageName, names: ["Bo Late"] }]);
  });

  it("X-CU-8 m1: a Reinstate of a player who still holds lines in a COMPLETE league is never answered 'stage complete'", async () => {
    // differential: today (b5062a338d) the complete check ran before the seat check and answered refused STAGE_COMPLETE.
    const r = await rig({ n: 4 });
    await startRoundOne(r);
    const gone = r.ids[3]!;
    await withdrawEntrantCascade(r.auth, gone);
    await sql`update stages set status = 'complete' where id = ${r.stageId}`;
    const back = await patchEntrant(r.auth, gone, { status: "registered" });
    expect(back.status).toBe("registered");
    expect(back.late_entry, "no late-entry answer: they hold their lines").toBeUndefined();
    expect(await waitingOn(gone)).toBeNull();
    expect(await deskUnplaced(r), "seated in the table: never named").toEqual([]);
  });
});

describe.skipIf(!HAS_DB)("W5 T6 fix round 1: the marker is cleared on every departure (m2) and the tap locks the entrant row (m4)", () => {
  it("X-CU-8 m2: a waiting player who withdraws their own registration stops waiting", async () => {
    // differential: today (b5062a338d) registrations/withdraw.ts writes the status directly and the marker stays set.
    const r = await rig({ n: 4 });
    await startRoundOne(r);
    const { entrantId, registrationId, token } = await confirmArrival(r, "Late");
    expect(await waitingOn(entrantId), "premise").toBe(r.stageId);
    await withdrawRegistrationPublic(registrationId, token);
    const [e] = await sql<{ status: string }[]>`select status from entrants where id = ${entrantId}`;
    expect(e!.status, "premise: the entrant left").toBe("withdrawn");
    expect(await waitingOn(entrantId)).toBeNull();
    expect(await deskLate(r)).toEqual([]);
  });

  it("X-CU-8 m4: a withdrawal holding the entrant row when the tap arrives is seen by the tap — refused, nothing placed", async () => {
    // Deterministic: a second connection writes the departure (as `writeEntrantPatch` does) and holds it uncommitted; the tap is
    // started and observed WAITING on a lock; then the departure commits. With `for update` the tap re-reads the row and refuses;
    // without it the tap reads the old committed row, writes the catch-up set, and only then waits on its own marker clear.
    const r = await rig({ n: 4 });
    await startRoundOne(r);
    const { entrantId } = await confirmArrival(r, "Late");
    const url = process.env.DATABASE_URL!;
    const holder = postgres(url, { max: 1, ssl: connectionOptions(url).ssl, connection: { search_path: connectionOptions(url).schema } });
    const watcher = postgres(url, { max: 1, ssl: connectionOptions(url).ssl, connection: { search_path: connectionOptions(url).schema } });
    try {
      const reserved = await holder.reserve();
      try {
        await reserved`begin`;
        await reserved`update entrants set status = 'withdrawn', table_waiting_stage_id = null where id = ${entrantId}`;
        const tap = placeWaitingTableEntrant(r.auth, r.stageId, entrantId).then(
          (v) => ({ ok: true as const, v }),
          (e: unknown) => ({ ok: false as const, e }),
        );
        let waited = false;
        for (let i = 0; i < 200 && !waited; i++) {
          const [{ n }] = await watcher<{ n: number }[]>`
            select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`;
          waited = n > 0;
          if (!waited) await new Promise((res) => setTimeout(res, 25));
        }
        expect(waited, "premise: the tap is waiting on the held row").toBe(true);
        await reserved`commit`;
        const answer = await tap;
        expect(answer.ok, "the tap is refused").toBe(false);
        expect(answer.ok ? null : (answer.e as HttpError).code).toBe("RR_LATE_ENTRY_NOT_WAITING");
      } finally {
        reserved.release();
      }
    } finally {
      await holder.end();
      await watcher.end();
    }
    expect(await linesOf(r.stageId, entrantId), "nothing placed for a departed player").toEqual([]);
    expect(await ledger(r.divisionId)).toEqual([]);
  });
});

describe.skipIf(!HAS_DB)("W5 T6: an import into a started league (football)", () => {
  // single-sport: football — an import's `entrant.create` makes TEAM entrants only, and chess is individual-only.
  it("X-CU-8 an import into a started league waits with a flag", async () => {
    // differential: today seated nowhere and no flag.
    const csv = (rows: string[]) => ({
      filename: "import.csv",
      contentType: "text/csv",
      buffer: Buffer.from(["Club,Team,Player,DOB,Number,Position,Captain,Division", ...rows].join("\r\n"), "utf8"),
    });
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "W5 T6 import " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
    const slug = "u12-" + randomUUID().slice(0, 4);
    const division = await createDivision(auth, comp.id, { name: "U12", slug, sport_key: "football", variant_key: "small-sided", config: {} });
    const first = await createImport(
      auth,
      csv(["A SC,A Team,Ada One,2014-01-01,1,,,", "B SC,B Team,Bo Two,2014-01-02,2,,,", "C SC,C Team,Cy Three,2014-01-03,3,,,", "D SC,D Team,Di Four,2014-01-04,4,,,"].map((x) => x + slug)),
    );
    expect(first.plan.issues, "premise: the roster file plans clean").toEqual([]);
    await commitImport(auth, first.importId, null);
    const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "Table", config: { legs: 1 }, progression: null });
    await startDivision(auth, division.id);
    const before = await rowsOf(stage!.id);
    expect(before.length, "premise: four teams, six lines").toBe(6);

    const late = await createImport(auth, csv([`E SC,E Team,Ed Five,2014-01-05,5,,,${slug}`]));
    expect(late.plan.stats.entrants, "premise: the file makes one entrant").toBe(1);
    await commitImport(auth, late.importId, null);
    const [e] = await sql<{ id: string; w: string | null }[]>`
      select id, table_waiting_stage_id as w from entrants where division_id = ${division.id} and display_name = 'E Team'`;
    expect(e?.w, "the import committed and the team waits").toBe(stage!.id);
    expect(await rowsOf(stage!.id), "nothing moved").toEqual(before);
    const r: Rig = { auth, orgId: auth.orgId, competitionId: comp.id, divisionId: division.id, stageId: stage!.id, stageName: "Table", ids: [] };
    expect(await deskLate(r)).toEqual(WAITING_ROW(r, 1));
    // Nothing has started: the tap writes the catch-up set and offers Rebuild beside it (RB5-L7).
    expect(await placeWaitingTableEntrant(auth, stage!.id, e!.id)).toMatchObject({ format: "league", case: "rebuild_offered", source: "organiser" });
    expect((await linesOf(stage!.id, e!.id)).length).toBe(4);
    expect(await waitingOn(e!.id)).toBeNull();
  });

  it("X-CU-8 an import into a COMPLETE league: no marker, and the desk names the team arrived after the table finished", async () => {
    // differential: today (b5062a338d) the import commits, no marker, and the desk shows nothing.
    const csv = (rows: string[]) => ({
      filename: "import.csv",
      contentType: "text/csv",
      buffer: Buffer.from(["Club,Team,Player,DOB,Number,Position,Captain,Division", ...rows].join("\r\n"), "utf8"),
    });
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "W5 T6 import done " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
    const slug = "u12-" + randomUUID().slice(0, 4);
    const division = await createDivision(auth, comp.id, { name: "U12", slug, sport_key: "football", variant_key: "small-sided", config: {} });
    const first = await createImport(
      auth,
      csv(["A SC,A Team,Ada One,2014-01-01,1,,,", "B SC,B Team,Bo Two,2014-01-02,2,,,", "C SC,C Team,Cy Three,2014-01-03,3,,,"].map((x) => x + slug)),
    );
    expect(first.plan.issues, "premise: the roster file plans clean").toEqual([]);
    await commitImport(auth, first.importId, null);
    const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "Table", config: { legs: 1 }, progression: null });
    await startDivision(auth, division.id);
    await sql`update stages set status = 'complete' where id = ${stage!.id}`;
    const late = await createImport(auth, csv([`E SC,E Team,Ed Five,2014-01-05,5,,,${slug}`]));
    await commitImport(auth, late.importId, null);
    const [e] = await sql<{ id: string; w: string | null }[]>`
      select id, table_waiting_stage_id as w from entrants where division_id = ${division.id} and display_name = 'E Team'`;
    expect(e, "the import committed").toBeDefined();
    expect(e!.w, "no marker").toBeNull();
    const r: Rig = { auth, orgId: auth.orgId, competitionId: comp.id, divisionId: division.id, stageId: stage!.id, stageName: "Table", ids: [] };
    expect(await deskLate(r)).toEqual([]);
    expect(await deskUnplaced(r)).toEqual([{ kind: "late_unplaced", count: 1, stageName: "Table", names: ["E Team"] }]);
  });
});
