// W4 app-A Tasks 19 + 20 (lane B6a), the server half of the desk: what the stage card reads and what a late entry
// answers, on a real database.
//
// - `listKnockoutWaiting` (T19, R24 pick 1A): the players WAITING to join a started root knockout — the stage card's
//   "Waiting to join the bracket" strip, one "Add to bracket" per player. A player who paid online is marked `paid`
//   (B3 review #5: a refused tap needs an exit, and for a paid entry that exit includes a refund).
// - `listStageDrawSeeds` (T20, K5 "shown"; R24 pick 3A): the seed each drawn root knockout recorded on its Generate.
// - The Reinstate reply (B3 re-review, T19 carry): a reinstated player whose place in the bracket has been played on is
//   back on the list but cannot return, and the reply SAYS so (`late_entry: refused, KO_LATE_ENTRY_PLAYED_ON`).
// - `withdrawn_id` (T19 notice "{name} takes {withdrawn}'s place against {opponent}"): a case (2) answer names whose seat
//   was taken.
//
// Expected values: the waiting set is the arrivals each test makes through the real doors (a paid webhook, a free
// confirmation, a Reinstate); the draw seed is `swissDrawSeed(stageId)`, the seed T7 draws with (RB4-D4, its own oracle in
// knockout-draw.test.ts); the seats are read off the rows as they stood before the call. Never the code under test.
//
// Sports: these reads and replies are SQL over entrants, registrations and ledger rows that no sport field reaches, so
// badminton singles carries them; the withdrawn-slot answer is swept over badminton and chess (the boardgame module), the
// two entrant shapes the late-entry door seats.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import { swissDrawSeed } from "@/lib/swiss-draw";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants, patchEntrant } from "../entrants";
import { listKnockoutWaiting, listStageDrawSeeds } from "../knockout-desk";
import { placeWaitingKnockoutEntrant } from "../knockout-late-entry";
import { confirmRegistration, handleRegistrationCheckoutCompleted, putRegistrationSettings } from "../registrations";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { createStages, generateStageFixtures } from "../stages";
import { withdrawEntrantCascade } from "../withdrawal";
import { fakeSession, seedRegistration } from "./_registration-fixtures";
import { seedOrg } from "./_seed";

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

interface SportPick {
  key: string;
  variant: string;
  kind: "individual" | "pair" | "team";
}
/** A sport by key from the engine's registry, its first declared variant and its default entrant kind. */
function sport(key: string): SportPick {
  const m = builtinModules.find((x) => x.key === key);
  if (m === undefined) throw new Error(`no engine module ${key}`);
  const variant = Object.keys(m.variants)[0];
  if (variant === undefined) throw new Error(`${key} declares no variant`);
  return { key, variant, kind: (m.entrantModel?.defaultKind ?? "individual") as SportPick["kind"] };
}
const BADMINTON = sport("badminton");
const CHESS = sport("boardgame");

interface Rig {
  auth: AuthCtx;
  orgId: string;
  competitionId: string;
  divisionId: string;
  stageId: string;
  ids: string[];
}

/** `n` entrants (seeded 1..n unless `seeded: false`), one root knockout "Cup", generated; Started unless `start: false`. */
async function rig(opts: { n: number; sport?: SportPick; start?: boolean; seeded?: boolean }): Promise<Rig> {
  const s = opts.sport ?? BADMINTON;
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "W4 B6a " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
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
    Array.from({ length: opts.n }, (_, i) => ({ kind: s.kind, display_name: `P${i + 1}`, seed: opts.seeded === false ? null : i + 1, members: [] })),
  );
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "knockout", name: "Cup", config: {}, progression: null });
  if (opts.start !== false) await startDivision(auth, division.id);
  return { auth, orgId: auth.orgId, competitionId: comp.id, divisionId: division.id, stageId: stage!.id, ids: made.map((e) => e.id) };
}

interface Row {
  id: string;
  round_no: number;
  seq_in_round: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
  winner_to_fixture: string | null;
}
const rowsOf = (stageId: string) =>
  sql<Row[]>`
    select id, round_no, seq_in_round, home_entrant_id, away_entrant_id, status, winner_to_fixture
      from fixtures where stage_id = ${stageId} order by round_no, seq_in_round`;

async function post(auth: AuthCtx, fixtureId: string, type: string, payload: Record<string, unknown> = {}): Promise<void> {
  const [{ n }] = await sql<{ n: number }[]>`select coalesce(max(seq), 0)::int as n from score_events where fixture_id = ${fixtureId}`;
  await scoreEvent(auth, fixtureId, { expected_seq: n, type, payload });
}
async function homeWin(auth: AuthCtx, f: Row): Promise<void> {
  await post(auth, f.id, "core.start");
  for (let g = 0; g < 2; g++) await post(auth, f.id, "badminton.game.summary", { home: 21, away: 10 });
}

/** A card payment's webhook into the division (the registration door that waits a player, T11). */
async function paidArrival(r: Rig, name: string): Promise<{ entrantId: string; registrationId: string }> {
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
  const { registration } = await seedRegistration(r.competitionId, r.divisionId, settings, { displayName: name });
  await handleRegistrationCheckoutCompleted(fakeSession(registration.id, 500));
  const [reg] = await sql<{ entrant_id: string | null }[]>`select entrant_id from registrations where id = ${registration.id}`;
  expect(reg?.entrant_id, `rig: ${name}'s payment made an entrant`).toBeTruthy();
  return { entrantId: reg!.entrant_id!, registrationId: registration.id };
}

/** A free, offline confirmation (no money moved). */
async function freeArrival(r: Rig, name: string): Promise<string> {
  const { registration } = await seedRegistration(r.competitionId, r.divisionId, { fee_cents: 0, currency: "eur", payment_method: "offline" }, { displayName: name });
  const confirmed = await confirmRegistration(r.auth, registration.id);
  expect(confirmed.entrant_id, `rig: ${name}'s confirmation made an entrant`).toBeTruthy();
  return confirmed.entrant_id!;
}

describe.skipIf(!HAS_DB)("T19 listKnockoutWaiting: the stage card's waiting players (X-LE-10, R24 pick 1A)", () => {
  it("the empty case first: a started knockout nobody arrived at waits nobody", async () => {
    const r = await rig({ n: 6 });
    expect(await listKnockoutWaiting(r.auth, r.divisionId)).toEqual([]);
  });

  it("a free arrival and a paid one wait in arrival order, the paid one marked paid; a tap takes the placed one off", async () => {
    const r = await rig({ n: 6 });
    // Free first: the paid arrival switches the division's registration to card payment.
    const free = await freeArrival(r, "Nora Free");
    const paid = await paidArrival(r, "Oliver Paid");
    const waiting = await listKnockoutWaiting(r.auth, r.divisionId);
    expect(waiting.length, "two arrivals, two waiting").toBe(2);
    expect(waiting).toEqual([
      { entrantId: free, stageId: r.stageId, name: "Nora Free", paid: false },
      { entrantId: paid.entrantId, stageId: r.stageId, name: "Oliver Paid", paid: true },
    ]);
    // Second call, after the tap placed the paid player in a bye: only the free one is left.
    const placed = await placeWaitingKnockoutEntrant(r.auth, r.stageId, paid.entrantId);
    expect(placed.case, "premise: six in eight, a bye is open").toBe("bye");
    expect((await listKnockoutWaiting(r.auth, r.divisionId)).map((w) => w.entrantId)).toEqual([free]);
  });

  it("a waiting player who withdraws waits no more (the exit a refused tap offers)", async () => {
    const r = await rig({ n: 6 });
    const free = await freeArrival(r, "Leaves");
    expect((await listKnockoutWaiting(r.auth, r.divisionId)).map((w) => w.entrantId), "premise: waiting").toEqual([free]);
    await withdrawEntrantCascade(r.auth, free);
    expect(await listKnockoutWaiting(r.auth, r.divisionId)).toEqual([]);
  });

  it("a refunded payment is no longer paid: the refund pointer goes", async () => {
    const r = await rig({ n: 6 });
    const paid = await paidArrival(r, "Refunded");
    await sql`update registrations set refunded_cents = amount_cents where id = ${paid.registrationId}`;
    const [w] = await listKnockoutWaiting(r.auth, r.divisionId);
    expect(w).toMatchObject({ entrantId: paid.entrantId, paid: false });
  });
});

describe.skipIf(!HAS_DB)("T20 listStageDrawSeeds: the seed a drawn root knockout shows (K5, X-SD-7)", () => {
  it("the empty case first: a knockout not yet generated shows no seed", async () => {
    const r = await rig({ n: 6, seeded: false, start: false });
    expect(await listStageDrawSeeds(r.auth, r.divisionId)).toEqual({});
  });

  it("six unseeded players drawn: the stage shows the seed it was drawn with; a second read says the same", async () => {
    const r = await rig({ n: 6, seeded: false, start: false });
    await generateStageFixtures(r.auth, r.stageId);
    const want = { [r.stageId]: swissDrawSeed(r.stageId) };
    expect(await listStageDrawSeeds(r.auth, r.divisionId)).toEqual(want);
    expect(await listStageDrawSeeds(r.auth, r.divisionId), "second call").toEqual(want);
  });

  it("a wholly seeded field is the seeds' fold: nothing drawn, no seed shown (D7-1)", async () => {
    const r = await rig({ n: 6, start: false });
    await generateStageFixtures(r.auth, r.stageId);
    expect((await rowsOf(r.stageId)).length, "premise: the bracket was generated").toBeGreaterThan(0);
    expect(await listStageDrawSeeds(r.auth, r.divisionId)).toEqual({});
  });
});

describe.skipIf(!HAS_DB)("T19 the Reinstate reply says whether the player can return to the bracket (K13)", () => {
  it("a round-1 loser BY PLAY, withdrawn and reinstated: back on the list, the reply refuses the bracket by name (played on)", async () => {
    const r = await rig({ n: 8 });
    const line = (await rowsOf(r.stageId)).find((x) => x.round_no === 1 && x.seq_in_round === 1)!;
    await homeWin(r.auth, line);
    const loser = line.away_entrant_id!;
    await withdrawEntrantCascade(r.auth, loser);
    const back = await patchEntrant(r.auth, loser, { status: "registered" });
    expect(back.status, "the reinstatement itself lands").toBe("registered");
    expect((back as { late_entry?: unknown }).late_entry).toEqual({
      format: "knockout",
      entrant_id: loser,
      stage_id: r.stageId,
      case: "refused",
      reason: "KO_LATE_ENTRY_PLAYED_ON",
    });
    expect(await listKnockoutWaiting(r.auth, r.divisionId), "and nobody waits").toEqual([]);
  });

  it("a player whose own walkover is still reversible: the reply says they wait (the desk flag's case)", async () => {
    const r = await rig({ n: 8 });
    const line = (await rowsOf(r.stageId)).find((x) => x.round_no === 1 && x.seq_in_round === 1)!;
    const gone = line.home_entrant_id!;
    await withdrawEntrantCascade(r.auth, gone);
    const back = await patchEntrant(r.auth, gone, { status: "registered" });
    expect((back as { late_entry?: unknown }).late_entry).toEqual({ format: "knockout", entrant_id: gone, stage_id: r.stageId, case: "waiting" });
  });

  it("a plain field edit (a rename) answers no late_entry: only a reinstatement is an arrival", async () => {
    const r = await rig({ n: 8 });
    const out = await patchEntrant(r.auth, r.ids[0]!, { display_name: "Renamed" });
    expect("late_entry" in out, "no late_entry on a rename").toBe(false);
  });
});

describe.skipIf(!HAS_DB)("T19 a case (2) answer names whose place was taken (`withdrawn_id`)", () => {
  for (const s of [BADMINTON, CHESS]) {
    it(`${s.key}: an organiser's add takes a withdrawn player's seat, naming them; the reinstated player's own tap names themself`, async () => {
      const r = await rig({ n: 8, sport: s });
      const rows = await rowsOf(r.stageId);
      const l1 = rows.find((x) => x.round_no === 1 && x.seq_in_round === 1)!;
      const l2 = rows.find((x) => x.round_no === 1 && x.seq_in_round === 2)!;
      const gone = l1.home_entrant_id!;
      await withdrawEntrantCascade(r.auth, gone);
      const [added] = await createEntrants(r.auth, r.divisionId, [{ kind: s.kind, display_name: "Newcomer", seed: null, members: [] }]);
      expect(added!.late_entry).toMatchObject({ format: "knockout", case: "withdrawn_slot", fixture_id: l1.id, withdrawn_id: gone, opponent_id: l1.away_entrant_id });

      // Second shape: a reinstated player's tap gives back THEIR seat, so the seat taken was their own.
      const gone2 = l2.home_entrant_id!;
      await withdrawEntrantCascade(r.auth, gone2);
      await patchEntrant(r.auth, gone2, { status: "registered" });
      const tap = await placeWaitingKnockoutEntrant(r.auth, r.stageId, gone2);
      expect(tap).toMatchObject({ case: "withdrawn_slot", fixture_id: l2.id, withdrawn_id: gone2, opponent_id: l2.away_entrant_id });
    });
  }
});
