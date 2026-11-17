// W5 app PR A, Task 8b Part 1 (X-WDT-9 ← RB5-W10; ruling 111 joins the withdrawal door, owner ruling 288) — a registrant's
// own withdrawal, from the public status page (`withdrawRegistrationPublic`, token) and from /r/[ref]
// (`withdrawRegistrationByRef`, ref + token), driven on a real database and read back from the stored rows, the score ledger
// and the division ledger.
//
// differential: today (ca679673b6) `registrations/withdraw.ts withdrawCore` writes `entrants.status = 'withdrawn'` with no phase
// check and no cascade, so after Start the leaver's lines stay seated and scheduled, her results stand whatever she played, and
// no `table_withdrawal` row is written.
//
// Expected values: the rule is the rulebook's (RB5-W2: under half of her scheduled league matches played, every result is removed
// and the rest voided; RB5-W3: half or more, results stand and the rest walk over to the opponents; RB5-W4: the count), and the
// rows are read before and after — never from the cascade's own report. Sports: badminton (BWF) and chess (the boardgame
// module), each from the engine registry by key; an ordinary walkover is the recorded result every module accepts before play.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import { generateRefCode } from "@/lib/ref-code";
import type { AuthCtx } from "@/server/api-v1/auth";
import { post } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants, patchEntrant } from "../entrants";
import { getCompetitionDesk } from "../competition-desk";
import { CASCADE_RETRY_AFTER_MS } from "../withdrawal";
import { confirmRegistration, groupById, withdrawRegistrationByRef, withdrawRegistrationPublic } from "../registrations";
import { startDivision } from "../schedule";
import { createStages } from "../stages";
import { seedRegistration } from "./_registration-fixtures";
import { seedOrg } from "./_seed";

// A cascade failure is simulated by making the door the registrant's path calls throw once (`failNextCascade`); every other
// call is the real cascade.
const control = vi.hoisted(() => ({ failNext: false, calls: 0 }));
vi.mock("../withdrawal", async (io) => {
  const real = await io<typeof import("../withdrawal")>();
  return {
    ...real,
    withdrawEntrantCascade: async (...args: Parameters<typeof real.withdrawEntrantCascade>) => {
      control.calls++;
      if (control.failNext) {
        control.failNext = false;
        throw new Error("simulated: the cascade's first write failed");
      }
      return real.withdrawEntrantCascade(...args);
    },
  };
});
vi.mock("@/server/email-outbox/transport", () => ({ deliver: vi.fn() }));
vi.mock("@/lib/stripe", async (io) => ({
  ...(await io<typeof import("@/lib/stripe")>()),
  getStripe: () => {
    throw new Error("this suite makes no Stripe call");
  },
}));

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

interface SportPick {
  key: string;
  variant: string;
}
function sport(key: string): SportPick {
  const m = builtinModules.find((x) => x.key === key);
  if (m === undefined) throw new Error(`no engine module ${key}`);
  const variant = Object.keys(m.variants)[0];
  if (variant === undefined) throw new Error(`${key} declares no variant`);
  return { key, variant };
}
const BADMINTON = sport("badminton");
const CHESS = sport("boardgame");

interface Line {
  id: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
  outcome: { kind?: string; winner?: string; loser?: string | null; reason?: string } | null;
}
const linesOf = (stageId: string) =>
  sql<Line[]>`select id, home_entrant_id, away_entrant_id, status, outcome from fixtures where stage_id = ${stageId} order by round_no, seq_in_round, id`;
const involves = (l: Line, e: string) => l.home_entrant_id === e || l.away_entrant_id === e;
const otherSide = (l: Line, e: string) => (l.home_entrant_id === e ? l.away_entrant_id! : l.home_entrant_id!);

async function activeEvents(fixtureId: string) {
  const evs = await sql<{ id: string; type: string; payload: Record<string, unknown>; voids_event_id: string | null }[]>`
    select id, type, payload, voids_event_id from score_events where fixture_id = ${fixtureId} order by seq`;
  const voided = new Set(evs.filter((e) => e.voids_event_id !== null).map((e) => e.voids_event_id));
  return evs.filter((e) => e.type !== "core.void" && !voided.has(e.id));
}
const hasActiveExpunge = async (fixtureId: string) =>
  (await activeEvents(fixtureId)).some((e) => e.type === "core.abandon" && e.payload.expunge === true);
const eventCount = async (stageId: string) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from score_events e join fixtures f on f.id = e.fixture_id where f.stage_id = ${stageId}`)[0]!.n;
const withdrawalRows = (divisionId: string) =>
  sql<{ seq: number; payload: Record<string, unknown>; actor_id: string | null }[]>`
    select seq::int as seq, payload, actor_id from division_events where division_id = ${divisionId} and type = 'table_withdrawal' order by seq`;
const entrantOf = async (id: string) =>
  (await sql<{ status: string; table_waiting_stage_id: string | null }[]>`select status, table_waiting_stage_id from entrants where id = ${id}`)[0]!;
/** What her status page reads (`groupById`, the page's own loader): does her card say her matches are settled? */
async function settledOnHerPage(registrationId: string, token: string): Promise<boolean | undefined> {
  const [{ group_id }] = await sql<{ group_id: string }[]>`select group_id from registrations where id = ${registrationId}`;
  const view = await groupById(group_id, token);
  return view.entries.find((e) => e.id === registrationId)?.matches_settled;
}
const registrationStatus = async (id: string) => (await sql<{ status: string }[]>`select status from registrations where id = ${id}`)[0]!.status;

interface Rig {
  auth: AuthCtx;
  competitionId: string;
  divisionId: string;
  stageId: string;
  /** The registrant's entrant, her registration and its cart's token and reference. */
  leaver: string;
  registrationId: string;
  token: string;
  ref: string;
  /** Everyone else, in seed order. */
  others: string[];
}

/**
 * A league of `n` (one leg): `n - 1` organiser-made entrants and ONE registrant, confirmed through the registration door before
 * Start (so her entrant came from her registration, as a real player's does). Started unless `start: false`.
 */
async function rig(n: number, opts: { sport?: SportPick; start?: boolean } = {}): Promise<Rig> {
  const s = opts.sport ?? BADMINTON;
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "W5 T8b " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const d = await createDivision(auth, comp.id, { name: "Open", slug: "o-" + randomUUID().slice(0, 6), sport_key: s.key, variant_key: s.variant, config: {} });
  const made = await createEntrants(
    auth,
    d.id,
    Array.from({ length: n - 1 }, (_, i) => ({ kind: "individual" as const, display_name: `P${i + 1}`, seed: i + 1, members: [] })),
  );
  const ref = generateRefCode();
  const { registration, access_token } = await seedRegistration(comp.id, d.id, { fee_cents: 0, currency: "eur", payment_method: "offline" }, { displayName: "Rae Registrant", refCode: ref });
  const confirmed = await confirmRegistration(auth, registration.id);
  expect(confirmed.entrant_id, "rig: the confirmation made her entrant").toBeTruthy();
  const [stage] = await createStages(auth, d.id, { seq: 1, kind: "league", name: "Table", config: { legs: 1 }, progression: null });
  if (opts.start !== false) await startDivision(auth, d.id);
  return {
    auth,
    competitionId: comp.id,
    divisionId: d.id,
    stageId: stage!.id,
    leaver: confirmed.entrant_id!,
    registrationId: registration.id,
    token: access_token,
    ref,
    others: made.map((e) => e.id),
  };
}

/** The leaver wins `k` of her lines by an ordinary walkover (the opponent did not turn up): a recorded result RB5-W4 counts. */
async function leaverWins(r: Rig, k: number): Promise<Line[]> {
  const mine = (await linesOf(r.stageId)).filter((l) => involves(l, r.leaver));
  const played = mine.slice(0, k);
  for (const l of played) {
    const out = await post(r.auth, l.id, "core.forfeit", { by: otherSide(l, r.leaver), reason: "walkover" });
    expect(out.status, "rig: an ordinary walkover is a recorded result").toBe("forfeited");
  }
  return played;
}

describe.skipIf(!HAS_DB)("X-WDT-9 (RB5-W10): a player's own withdrawal after Start goes through the table withdrawal", () => {
  for (const s of [BADMINTON, CHESS]) {
    it(`X-WDT-9 a registrant who withdraws after Start leaves the stage by the 50 percent rule [${s.key}]`, async () => {
      // differential: today status only, fixtures untouched.
      const r = await rig(6, { sport: s });
      const mine = (await linesOf(r.stageId)).filter((l) => involves(l, r.leaver));
      expect(mine, "rig: in a league of 6 she is scheduled 5 matches").toHaveLength(5);
      await leaverWins(r, 2);

      await withdrawRegistrationPublic(r.registrationId, r.token);

      expect(await registrationStatus(r.registrationId)).toBe("withdrawn");
      expect((await entrantOf(r.leaver)).status).toBe("withdrawn");
      // RB5-W2: 2 of 5 played is under half — every result she played is removed and the rest voided.
      const after = (await linesOf(r.stageId)).filter((l) => involves(l, r.leaver));
      expect(after).toHaveLength(5);
      for (const l of after) {
        expect([l.status, l.outcome, await hasActiveExpunge(l.id)], `line vs ${otherSide(l, r.leaver)}: removed by the expunge`).toEqual(["abandoned", null, true]);
      }
      const rows = await withdrawalRows(r.divisionId);
      expect(rows.map((x) => [x.payload.stage_id, x.payload.policy, x.payload.played_at_departure, x.payload.scheduled])).toEqual([[r.stageId, "expunge", 2, 5]]);
      expect(await settledOnHerPage(r.registrationId, r.token), "her status page says her matches are settled").toBe(true);
    }, 180_000);
  }

  it("X-WDT-9 the by-ref door behaves the same — at half played, the results stand and the rest walk over", async () => {
    // differential: today status only, fixtures untouched.
    const r = await rig(6);
    const played = await leaverWins(r, 3);

    const cart = await withdrawRegistrationByRef(r.ref, r.registrationId, r.token);
    expect(cart.entries.map((e) => e.status)).toEqual(["withdrawn"]);

    expect((await entrantOf(r.leaver)).status).toBe("withdrawn");
    // RB5-W3: 3 of 5 played is half or more — her three results stand, her two remaining lines walk over to the opponents.
    for (const l of played) {
      expect((await linesOf(r.stageId)).find((x) => x.id === l.id)!.outcome, "a played result stands").toMatchObject({ kind: "award", winner: r.leaver });
    }
    const owed = (await linesOf(r.stageId)).filter((l) => involves(l, r.leaver) && !played.some((p) => p.id === l.id));
    expect(owed).toHaveLength(2);
    for (const l of owed) {
      expect(l.outcome, "the opponent's walkover").toMatchObject({ kind: "award", winner: otherSide(l, r.leaver), loser: r.leaver, reason: "withdrew" });
    }
    const rows = await withdrawalRows(r.divisionId);
    expect(rows.map((x) => [x.payload.policy, x.payload.played_at_departure, x.payload.scheduled])).toEqual([["walkover", 3, 5]]);
  }, 180_000);

  it("X-WDT-9 the ledger names the player as actor", async () => {
    const r = await rig(4);
    await withdrawRegistrationPublic(r.registrationId, r.token);
    const rows = await withdrawalRows(r.divisionId);
    expect(rows, "one row: her one league").toHaveLength(1);
    expect(rows[0]!.payload.actor, "the registrant, by her registration").toEqual({ kind: "registrant", registration_id: r.registrationId });
    // No staff user did this: the row's user column is empty (an organiser's withdrawal carries the organiser's id there).
    expect(rows[0]!.actor_id).toBeNull();
  }, 120_000);

  it("X-WDT-9 before Start the bare withdrawal is unchanged", async () => {
    // pin, no defect expected: before Start a withdrawal is a status flip — nothing is settled, the field regenerates.
    const r = await rig(4, { start: false });
    const before = await linesOf(r.stageId);
    const events = await eventCount(r.stageId);
    await withdrawRegistrationPublic(r.registrationId, r.token);
    expect((await entrantOf(r.leaver)).status).toBe("withdrawn");
    expect(await linesOf(r.stageId), "no line moved").toEqual(before);
    expect(await eventCount(r.stageId), "no score event written").toBe(events);
    expect(await withdrawalRows(r.divisionId), "no ledger row").toEqual([]);
    expect(await settledOnHerPage(r.registrationId, r.token), "before Start nothing was settled: no claim").toBe(false);
  }, 120_000);

  it("X-WDT-9 a waiting late arrival who withdraws has no lines: the cascade settles nothing and the marker clears", async () => {
    // The empty case: Task 6's automatic arrival into a started league waits (`table_waiting_stage_id`) and holds no line.
    const r = await rig(4);
    const { registration, access_token } = await seedRegistration(r.competitionId, r.divisionId, { fee_cents: 0, currency: "eur", payment_method: "offline" }, { displayName: "Late Lou" });
    const late = (await confirmRegistration(r.auth, registration.id)).entrant_id!;
    expect((await entrantOf(late)).table_waiting_stage_id, "rig: she waits on the league").toBe(r.stageId);
    const before = await linesOf(r.stageId);
    const events = await eventCount(r.stageId);
    await withdrawRegistrationPublic(registration.id, access_token);
    expect(await entrantOf(late)).toEqual({ status: "withdrawn", table_waiting_stage_id: null });
    expect(await linesOf(r.stageId), "no line moved").toEqual(before);
    expect(await eventCount(r.stageId), "no score event written").toBe(events);
    expect(await withdrawalRows(r.divisionId), "no ledger row: she held no line").toEqual([]);
    expect(await settledOnHerPage(registration.id, access_token), "she held no match: no claim").toBe(false);
  }, 120_000);
});

describe.skipIf(!HAS_DB)("X-WDT-9 the public door into the cascade: who reaches it, retries and failure", () => {
  it("X-WDT-9 a wrong token reaches nothing: no withdrawal, no cascade", async () => {
    const r = await rig(4);
    const before = await linesOf(r.stageId);
    const status = (await entrantOf(r.leaver)).status;
    const calls = control.calls;
    await expect(withdrawRegistrationPublic(r.registrationId, "srt_" + randomUUID().replace(/-/g, ""))).rejects.toMatchObject({ status: 404 });
    await expect(withdrawRegistrationByRef(r.ref, r.registrationId, "srt_" + randomUUID().replace(/-/g, ""))).rejects.toMatchObject({ status: 404 });
    expect(control.calls, "the cascade was never called").toBe(calls);
    expect(await registrationStatus(r.registrationId)).toBe("confirmed");
    expect((await entrantOf(r.leaver)).status).toBe(status);
    expect(await linesOf(r.stageId)).toEqual(before);
  }, 120_000);

  it("X-WDT-9 a double POST runs one cascade", async () => {
    const r = await rig(6);
    await leaverWins(r, 2);
    const calls = control.calls;
    const both = await Promise.allSettled([
      withdrawRegistrationPublic(r.registrationId, r.token),
      withdrawRegistrationByRef(r.ref, r.registrationId, r.token),
    ]);
    expect(both.map((x) => x.status), "both answer").toEqual(["fulfilled", "fulfilled"]);
    expect(control.calls - calls, "one cascade").toBe(1);
    // And a later retry runs none.
    await withdrawRegistrationPublic(r.registrationId, r.token);
    expect(control.calls - calls, "the retry ran no second cascade").toBe(1);
    expect(await withdrawalRows(r.divisionId), "one ledger row").toHaveLength(1);
    for (const l of (await linesOf(r.stageId)).filter((x) => involves(x, r.leaver))) {
      const abandons = (await activeEvents(l.id)).filter((e) => e.type === "core.abandon" && e.payload.expunge === true);
      expect(abandons, "one expunge per line").toHaveLength(1);
    }
  }, 180_000);

  it("X-WDT-9 a cascade that fails leaves her in the field, recoverable by the organiser's Withdraw — never marked withdrawn with lines untouched", async () => {
    const r = await rig(6);
    await leaverWins(r, 2);
    const before = await linesOf(r.stageId);
    const status = (await entrantOf(r.leaver)).status;
    expect(["registered", "confirmed"], "rig: she is in the field").toContain(status);
    control.failNext = true;
    // Her withdrawal stands (the registration committed first); the response does not fail for a table write she cannot fix.
    await withdrawRegistrationPublic(r.registrationId, r.token);
    expect(await registrationStatus(r.registrationId)).toBe("withdrawn");
    // Recoverable: she still reads as in the field (so the organiser's Withdraw still runs the cascade); nothing was settled.
    expect((await entrantOf(r.leaver)).status, "not half-withdrawn: no departed status over seated lines").toBe(status);
    expect(await linesOf(r.stageId)).toEqual(before);
    expect(await settledOnHerPage(r.registrationId, r.token), "unfinished: her page claims nothing").toBe(false);
    const { withdrawEntrantCascade } = await import("../withdrawal");
    await withdrawEntrantCascade(r.auth, r.leaver);
    expect((await entrantOf(r.leaver)).status).toBe("withdrawn");
    const rows = await withdrawalRows(r.divisionId);
    expect(rows.map((x) => [x.payload.policy, x.payload.played_at_departure, x.payload.scheduled])).toEqual([["expunge", 2, 5]]);
    expect(await settledOnHerPage(r.registrationId, r.token), "finished by the organiser: now it is settled").toBe(true);
  }, 180_000);
});

/** The desk's "withdrawal did not finish" rows (review I2 b, derived on read). */
async function deskOwed(r: Rig) {
  const desk = await getCompetitionDesk(r.auth, r.competitionId);
  return (desk.divisions.get(r.divisionId)?.attention ?? []).filter((a) => a.kind === "withdrawal_owed");
}
const pastTheWindow = (registrationId: string) =>
  sql`update registrations set withdrawn_at = withdrawn_at - make_interval(secs => ${CASCADE_RETRY_AFTER_MS / 1000 + 60}) where id = ${registrationId}`;

describe.skipIf(!HAS_DB)("X-WDT-9 review I2: a failed withdrawal is shown on the desk and finished by a retry", () => {
  it("I2 the desk names her as owed; her retry inside the window runs nothing, past it finishes the cascade, and the item clears", async () => {
    const r = await rig(6);
    await leaverWins(r, 2);
    expect(await deskOwed(r), "the empty case: nobody owed").toEqual([]);
    control.failNext = true;
    await withdrawRegistrationPublic(r.registrationId, r.token);
    expect(control.failNext, "premise: the cascade ran and failed").toBe(false);
    expect(await deskOwed(r)).toEqual([{ kind: "withdrawal_owed", count: 1, names: ["Rae Registrant"] }]);
    const calls = control.calls;
    // A double POST arrives inside the window: it must not run a second cascade beside a first that may still be running.
    await withdrawRegistrationPublic(r.registrationId, r.token);
    expect(control.calls - calls, "inside the window: no cascade").toBe(0);
    expect(await deskOwed(r), "still owed").toHaveLength(1);
    await pastTheWindow(r.registrationId);
    await withdrawRegistrationByRef(r.ref, r.registrationId, r.token);
    expect(control.calls - calls, "past the window: one cascade").toBe(1);
    expect((await entrantOf(r.leaver)).status).toBe("withdrawn");
    expect((await withdrawalRows(r.divisionId)).map((x) => [x.payload.policy, x.payload.played_at_departure, x.payload.scheduled])).toEqual([["expunge", 2, 5]]);
    expect(await deskOwed(r), "finished: the item clears").toEqual([]);
    await withdrawRegistrationPublic(r.registrationId, r.token);
    expect(control.calls - calls, "departed: a further retry runs none").toBe(1);
  }, 180_000);

  it("I2 a finished withdrawal, and a Reinstate after it, never read as owed (the registration stays withdrawn: m4, parked)", async () => {
    const r = await rig(6);
    await leaverWins(r, 2);
    await withdrawRegistrationPublic(r.registrationId, r.token);
    expect((await entrantOf(r.leaver)).status, "premise: the cascade finished").toBe("withdrawn");
    expect(await deskOwed(r)).toEqual([]);
    await patchEntrant(r.auth, r.leaver, { status: "registered" });
    expect(await registrationStatus(r.registrationId), "premise (m4): the registration still reads withdrawn").toBe("withdrawn");
    expect(await deskOwed(r), "reinstated: in the field, and not owed").toEqual([]);
    // Nor does a retry past the window withdraw her again — her Reinstate is the organiser's last word.
    await pastTheWindow(r.registrationId);
    const calls = control.calls;
    await withdrawRegistrationPublic(r.registrationId, r.token);
    expect(control.calls - calls, "no second withdrawal over a Reinstate").toBe(0);
    expect((await entrantOf(r.leaver)).status, "she stays reinstated").not.toBe("withdrawn");
  }, 180_000);
});
