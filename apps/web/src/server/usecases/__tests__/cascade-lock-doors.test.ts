// W5 app PR A, B3 batch fix wave (I-1, I-2, m-1, m-3) - how the withdrawal cascade's doors COMPOSE, on a real database, read
// back from the stored rows (entrant status, the score ledger, the division ledger).
//
// I-1 (RB5-W6; ruling: Reinstate's reverse only for a PATCH that carries a status into the field over a DEPARTED prior status,
// under the shared per-entrant cascade lock, the status re-read inside it). differential: today (01888347fa) `patchEntrant` asks
// `tableReinstateOwed` on EVERY write that leaves her in the field, outside the lock, so a rename sent while her cascade is live
// reverses the expunges already written and the cascade then writes her `withdrawn` over restored lines.
//
// I-2 (RB3-17 "a disqualification is withdrawal from that moment": the first departure governs; ruling: a departed entrant
// entering any door again settles nothing, writes no `table_withdrawal` row, and keeps her status). differential: today the
// cascade refuses only `status === as`, so a disqualified registrant's own later withdrawal re-runs it and writes `withdrawn`
// with a second `table_withdrawal` row.
//
// Expected values come from the rulebook (RB5-W2: under half played, every result of hers removed - one `core.abandon{expunge}`
// active on each of her lines; RB5-W3: half or more, her results stand) and from the rows read BEFORE the step under test, never
// from the cascade's own report. Sport: badminton (BWF) - the doors are sport-blind (no sport branch in withdrawal.ts or
// entrants.ts); the per-sport cells live in table-expunge / pair-partner-every-format.
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
import { confirmRegistration, withdrawRegistrationPublic } from "../registrations";
import { startDivision } from "../schedule";
import { createStages } from "../stages";
import { withdrawEntrantCascade } from "../withdrawal";
import { seedRegistration } from "./_registration-fixtures";
import { seedOrg } from "./_seed";

// `pauseAfter`: once a cascade write of that type with `expunge: true` has gone through, the cascade waits on `gate` (a cascade
// LIVE between two settles, holding its lock). `failVoids`: after `passVoids` cascade-writer `core.void`s have gone through, the
// next `failVoids` of them throw (set only around a Reinstate, so they are its reverse's writes). W5 stress fix F3: the reverse
// writes its voids in ONE transaction through `appendEventInTx` (void-lines.ts), no longer one `scoreEvent` each, so the throw
// sits on that export; `scoreEvent`'s own append calls it from inside its module and never meets this mock.
const control = vi.hoisted(() => ({
  pauseAfter: null as string | null,
  gate: null as Promise<void> | null,
  paused: null as (() => void) | null,
  failVoids: 0,
  passVoids: 0,
  cutAfterExpunge: false,
}));
vi.mock("@/server/engine-db/append-event", async (io) => {
  const real = await io<typeof import("@/server/engine-db/append-event")>();
  return {
    ...real,
    appendEventInTx: async (...args: Parameters<typeof real.appendEventInTx>) => {
      const input = args[4];
      if (input.writer === "withdrawal_cascade" && input.type === "core.void" && control.failVoids > 0) {
        if (control.passVoids > 0) {
          control.passVoids--;
        } else {
          control.failVoids--;
          throw new Error("simulated: a write of the Reinstate's reverse failed");
        }
      }
      return real.appendEventInTx(...args);
    },
  };
});
vi.mock("../scoring", async (io) => {
  const real = await io<typeof import("../scoring")>();
  return {
    ...real,
    scoreEvent: async (...args: Parameters<typeof real.scoreEvent>) => {
      const [, , input, opts] = args;
      const type = (input as { type: string }).type;
      const out = await real.scoreEvent(...args);
      const expunge = (input as { payload?: { expunge?: unknown } }).payload?.expunge === true;
      if (opts?.writer === "withdrawal_cascade" && type === "core.abandon" && expunge && control.cutAfterExpunge) {
        control.cutAfterExpunge = false;
        throw new Error("simulated: the cascade was cut off after its first expunge");
      }
      if (opts?.writer === "withdrawal_cascade" && control.pauseAfter === type && expunge && control.gate) {
        control.pauseAfter = null;
        const gate = control.gate;
        control.paused?.();
        await gate;
      }
      return out;
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

const bad = builtinModules.find((m) => m.key === "badminton")!;
const variant = Object.keys(bad.variants)[0]!;

interface Rig {
  auth: AuthCtx;
  divisionId: string;
  stageId: string;
  leaver: string;
  registrationId: string;
  token: string;
}

/** A league of `n` (single leg) whose `n`-th entrant is a confirmed registrant (`leaver`), started. */
async function rig(n: number, opts: { start?: boolean } = {}): Promise<Rig> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "B3 doors " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const d = await createDivision(auth, comp.id, { name: "Open", slug: "o-" + randomUUID().slice(0, 6), sport_key: "badminton", variant_key: variant, config: {} });
  await createEntrants(auth, d.id, Array.from({ length: n - 1 }, (_, i) => ({ kind: "individual" as const, display_name: `P${i + 1}`, seed: i + 1, members: [] })));
  const { registration, access_token } = await seedRegistration(comp.id, d.id, { fee_cents: 0, currency: "eur", payment_method: "offline" }, { displayName: "Rae", refCode: generateRefCode() });
  const confirmed = await confirmRegistration(auth, registration.id);
  const [stage] = await createStages(auth, d.id, { seq: 1, kind: "league", name: "Table", config: { legs: 1 }, progression: null });
  if (opts.start !== false) await startDivision(auth, d.id);
  return { auth, divisionId: d.id, stageId: stage!.id, leaver: confirmed.entrant_id!, registrationId: registration.id, token: access_token };
}

type Line = { id: string; home_entrant_id: string | null; away_entrant_id: string | null; status: string };
const linesOf = (stageId: string) =>
  sql<Line[]>`select id, home_entrant_id, away_entrant_id, status from fixtures where stage_id = ${stageId} order by round_no, seq_in_round, id`;
const involves = (l: Line, e: string) => l.home_entrant_id === e || l.away_entrant_id === e;
const other = (l: Line, e: string) => (l.home_entrant_id === e ? l.away_entrant_id! : l.home_entrant_id!);
const statusOf = async (id: string) => (await sql<{ status: string }[]>`select status from entrants where id = ${id}`)[0]!.status;
const tableRows = (d: string) =>
  sql<{ seq: number; type: string; payload: Record<string, unknown> }[]>`
    select seq::int as seq, type, payload from division_events where division_id = ${d} and type in ('table_withdrawal', 'table_withdrawal_voided') order by seq`;
/** The `table_withdrawal` rows still active (not named by a `table_withdrawal_voided`). */
async function activeTableRows(d: string) {
  const rows = await tableRows(d);
  const voided = new Set(rows.filter((r) => r.type === "table_withdrawal_voided").map((r) => r.payload.voids_seq));
  return rows.filter((r) => r.type === "table_withdrawal" && !voided.has(r.seq));
}
const eventCount = async (stageId: string) =>
  (await sql<{ n: number }[]>`select count(*)::int n from score_events e join fixtures f on f.id = e.fixture_id where f.stage_id = ${stageId}`)[0]!.n;
/** How many of her lines carry an ACTIVE `core.abandon{expunge: true}` (RB5-W2's removal, as the ledger holds it). */
async function activeExpunges(stageId: string, e: string): Promise<number> {
  let n = 0;
  for (const l of (await linesOf(stageId)).filter((x) => involves(x, e))) {
    const evs = await sql<{ id: string; type: string; payload: Record<string, unknown>; voids_event_id: string | null }[]>`
      select id, type, payload, voids_event_id from score_events where fixture_id = ${l.id}`;
    const v = new Set(evs.map((x) => x.voids_event_id).filter(Boolean));
    if (evs.some((x) => !v.has(x.id) && x.type === "core.abandon" && x.payload.expunge === true)) n++;
  }
  return n;
}
/** Her lines as they stand: status per line, in line order. */
const herStatuses = async (stageId: string, e: string) => (await linesOf(stageId)).filter((l) => involves(l, e)).map((l) => l.status);

/** Run `withdrawEntrantCascade` and hold it LIVE right after its first expunge abandon; resolve `release()` to let it finish. */
function pausedCascade(r: Rig) {
  let release!: () => void;
  let reached!: () => void;
  const atPause = new Promise<void>((res) => (reached = res));
  control.gate = new Promise<void>((res) => (release = res));
  control.paused = reached;
  control.pauseAfter = "core.abandon";
  const run = withdrawEntrantCascade(r.auth, r.leaver);
  return { run, atPause, release };
}

describe.runIf(HAS_DB)("B3 I-1: a Reinstate's reverse runs only for a status change, under the cascade lock", () => {
  it("a rename sent while her cascade is LIVE reverses nothing: all 5 lines stay expunged, the footnote stands, she is withdrawn", async () => {
    const r = await rig(6);
    const mine = (await linesOf(r.stageId)).filter((l) => involves(l, r.leaver));
    expect(mine).toHaveLength(5); // a league of 6, one leg: 5 lines each
    await post(r.auth, mine[0]!.id, "core.forfeit", { by: other(mine[0]!, r.leaver), reason: "walkover" }); // 1 of 5 played: RB5-W2 expunge
    const p = pausedCascade(r);
    await p.atPause;
    expect(await activeExpunges(r.stageId, r.leaver)).toBe(1); // the cascade is mid-way: one expunge written, four to go
    await patchEntrant(r.auth, r.leaver, { display_name: "Rae renamed" });
    p.release();
    await p.run;
    expect(await statusOf(r.leaver)).toBe("withdrawn");
    expect(await activeExpunges(r.stageId, r.leaver)).toBe(5);
    const rows = await activeTableRows(r.divisionId);
    expect(rows.map((x) => [x.payload.policy, x.payload.played_at_departure, x.payload.scheduled])).toEqual([["expunge", 1, 5]]);
    expect((await sql<{ display_name: string }[]>`select display_name from entrants where id = ${r.leaver}`)[0]!.display_name).toBe("Rae renamed");
  }, 240_000);

  it("a Reinstate sent while her cascade is LIVE waits for it, then reverses the WHOLE withdrawal (status back, every line restored, footnote gone)", async () => {
    const r = await rig(6);
    const mine = (await linesOf(r.stageId)).filter((l) => involves(l, r.leaver));
    await post(r.auth, mine[0]!.id, "core.forfeit", { by: other(mine[0]!, r.leaver), reason: "walkover" });
    const before = await herStatuses(r.stageId, r.leaver); // the pre-withdrawal state RB5-W6 restores
    const p = pausedCascade(r);
    await p.atPause;
    let settled = false;
    const reinstate = patchEntrant(r.auth, r.leaver, { status: "registered" }).finally(() => (settled = true));
    await new Promise((res) => setTimeout(res, 600)); // several lock polls
    expect(settled).toBe(false); // it waits on the cascade's lock - it does not run beside the live cascade
    p.release();
    await p.run;
    await reinstate;
    expect(await statusOf(r.leaver)).toBe("registered");
    expect(await activeExpunges(r.stageId, r.leaver)).toBe(0);
    expect(await herStatuses(r.stageId, r.leaver)).toEqual(before);
    expect(await activeTableRows(r.divisionId)).toEqual([]);
  }, 240_000);

  it("sequence: withdraw, rename (no reverse), Reinstate (reverse), rename again (nothing owed) - each step's rows as RB5-W2/W6 say", async () => {
    const r = await rig(6);
    const mine = (await linesOf(r.stageId)).filter((l) => involves(l, r.leaver));
    await post(r.auth, mine[0]!.id, "core.forfeit", { by: other(mine[0]!, r.leaver), reason: "walkover" });
    const before = await herStatuses(r.stageId, r.leaver);
    await withdrawEntrantCascade(r.auth, r.leaver);
    const events = await eventCount(r.stageId);
    await patchEntrant(r.auth, r.leaver, { display_name: "Rae (left)" }); // a departed entrant's rename: a plain write
    expect([await statusOf(r.leaver), await activeExpunges(r.stageId, r.leaver), await eventCount(r.stageId)]).toEqual(["withdrawn", 5, events]);
    const back = await patchEntrant(r.auth, r.leaver, { status: "registered" });
    expect(back.status).toBe("registered");
    expect(await herStatuses(r.stageId, r.leaver)).toEqual(before);
    expect(await activeTableRows(r.divisionId)).toEqual([]);
    const after = await eventCount(r.stageId);
    await patchEntrant(r.auth, r.leaver, { display_name: "Rae" });
    await patchEntrant(r.auth, r.leaver, { status: "registered" }); // a second Reinstate of an entrant in the field: nothing owed
    expect(await eventCount(r.stageId)).toBe(after);
  }, 240_000);

  it("a cascade cut off part-way leaves her in the field: a status re-asserted then is no Reinstate and takes nothing back", async () => {
    const r = await rig(6);
    const mine = (await linesOf(r.stageId)).filter((l) => involves(l, r.leaver));
    await post(r.auth, mine[0]!.id, "core.forfeit", { by: other(mine[0]!, r.leaver), reason: "walkover" });
    const held = await statusOf(r.leaver);
    control.cutAfterExpunge = true;
    await expect(withdrawEntrantCascade(r.auth, r.leaver)).rejects.toThrow(/cut off/);
    expect([await statusOf(r.leaver), await activeExpunges(r.stageId, r.leaver)]).toEqual([held, 1]);
    const events = await eventCount(r.stageId);
    await patchEntrant(r.auth, r.leaver, { status: "registered" }); // her prior status is in the field: nothing to reverse
    expect([await activeExpunges(r.stageId, r.leaver), await eventCount(r.stageId)]).toEqual([1, events]);
    // The cascade's own retry (the organiser's Withdraw) resumes it and decides as the first run did (RB5-W2: 1 of 5).
    await withdrawEntrantCascade(r.auth, r.leaver);
    expect([await statusOf(r.leaver), await activeExpunges(r.stageId, r.leaver)]).toEqual(["withdrawn", 5]);
    expect((await activeTableRows(r.divisionId)).map((x) => [x.payload.policy, x.payload.played_at_departure, x.payload.scheduled])).toEqual([["expunge", 1, 5]]);
  }, 240_000);
});

describe.runIf(HAS_DB)("B3 m-3/m-1: a Reinstate's reverse that throws", () => {
  it("one failed write: the reverse is retried in the same request and finishes (no partial reverse is left)", async () => {
    const r = await rig(6);
    const mine = (await linesOf(r.stageId)).filter((l) => involves(l, r.leaver));
    await post(r.auth, mine[0]!.id, "core.forfeit", { by: other(mine[0]!, r.leaver), reason: "walkover" });
    const before = await herStatuses(r.stageId, r.leaver);
    await withdrawEntrantCascade(r.auth, r.leaver);
    // Let the reverse write one void, then fail the next: a reverse cut off part-way. F3: its voids are ONE transaction, so the
    // one written rolls back with the failure and the in-request retry writes them all.
    control.passVoids = 1;
    control.failVoids = 1;
    const back = await patchEntrant(r.auth, r.leaver, { status: "registered" });
    expect([control.passVoids, control.failVoids]).toEqual([0, 0]); // one void landed, then the failure was reached
    expect(back.status).toBe("registered");
    expect(await herStatuses(r.stageId, r.leaver)).toEqual(before);
    expect(await activeExpunges(r.stageId, r.leaver)).toBe(0);
    // m-1: the reverse's report rides with the entrant (nothing it could not put back here).
    expect(back.reinstate?.not_restored).toEqual([]);
  }, 240_000);

  it("a reverse that keeps failing: she stays departed, the PATCH refuses, and the next Reinstate finishes the whole reverse", async () => {
    const r = await rig(6);
    const mine = (await linesOf(r.stageId)).filter((l) => involves(l, r.leaver));
    await post(r.auth, mine[0]!.id, "core.forfeit", { by: other(mine[0]!, r.leaver), reason: "walkover" });
    const before = await herStatuses(r.stageId, r.leaver);
    await withdrawEntrantCascade(r.auth, r.leaver);
    control.passVoids = 1; // a partial reverse: one void lands, every later one fails
    control.failVoids = 1_000;
    await expect(patchEntrant(r.auth, r.leaver, { status: "registered" })).rejects.toThrow(/simulated/);
    control.failVoids = 0;
    expect(await statusOf(r.leaver)).toBe("withdrawn"); // the PATCH changed nothing a client can see
    // F3: nor did the reverse - its voids are one transaction, so the void that went through rolled back with the failure and
    // every expunge abandon of hers still stands (5 lines, RB5-W2).
    expect(await activeExpunges(r.stageId, r.leaver)).toBe(5);
    expect(await activeTableRows(r.divisionId)).toHaveLength(1);
    const back = await patchEntrant(r.auth, r.leaver, { status: "registered" });
    expect(back.status).toBe("registered");
    expect(await herStatuses(r.stageId, r.leaver)).toEqual(before);
    expect(await activeTableRows(r.divisionId)).toEqual([]);
  }, 240_000);
});

describe.runIf(HAS_DB)("B3 I-2: a departed entrant entering a door again changes nothing (the first departure governs)", () => {
  it("organiser's Disqualify, then the registrant withdraws her registration: still disqualified, one row, no new score event", async () => {
    const r = await rig(6);
    const mine = (await linesOf(r.stageId)).filter((l) => involves(l, r.leaver));
    for (const l of mine.slice(0, 3)) await post(r.auth, l.id, "core.forfeit", { by: other(l, r.leaver), reason: "walkover" }); // 3 of 5: RB5-W3
    await patchEntrant(r.auth, r.leaver, { status: "disqualified" });
    expect((await activeTableRows(r.divisionId)).map((x) => [x.payload.policy, x.payload.played_at_departure, x.payload.scheduled])).toEqual([["walkover", 3, 5]]);
    const events = await eventCount(r.stageId);
    await withdrawRegistrationPublic(r.registrationId, r.token);
    expect(await statusOf(r.leaver)).toBe("disqualified");
    expect((await activeTableRows(r.divisionId)).map((x) => [x.payload.policy, x.payload.played_at_departure, x.payload.scheduled])).toEqual([["walkover", 3, 5]]);
    expect(await eventCount(r.stageId)).toBe(events);
    // The registration side still withdraws by its own rules.
    expect((await sql<{ status: string }[]>`select status from registrations where id = ${r.registrationId}`)[0]!.status).toBe("withdrawn");
  }, 240_000);

  it("the organiser's Withdraw on a disqualified entrant is refused and writes nothing; a second Disqualify the same", async () => {
    const r = await rig(6);
    await patchEntrant(r.auth, r.leaver, { status: "disqualified" });
    const events = await eventCount(r.stageId);
    const rows = (await tableRows(r.divisionId)).length;
    await expect(withdrawEntrantCascade(r.auth, r.leaver)).rejects.toMatchObject({ status: 409 });
    await expect(withdrawEntrantCascade(r.auth, r.leaver, { as: "disqualified" })).rejects.toMatchObject({ status: 409 });
    expect([await statusOf(r.leaver), await eventCount(r.stageId), (await tableRows(r.divisionId)).length]).toEqual(["disqualified", events, rows]);
  }, 240_000);

  it("before Start: a disqualified registrant's own withdrawal keeps her disqualified (the bare flip never downgrades)", async () => {
    const r = await rig(4, { start: false });
    await patchEntrant(r.auth, r.leaver, { status: "disqualified" });
    await withdrawRegistrationPublic(r.registrationId, r.token);
    expect(await statusOf(r.leaver)).toBe("disqualified");
  }, 240_000);

  it("after a Reinstate the door is open again: a second departure runs (one active row, the new one)", async () => {
    const r = await rig(6);
    const mine = (await linesOf(r.stageId)).filter((l) => involves(l, r.leaver));
    for (const l of mine.slice(0, 3)) await post(r.auth, l.id, "core.forfeit", { by: other(l, r.leaver), reason: "walkover" });
    await patchEntrant(r.auth, r.leaver, { status: "disqualified" });
    await patchEntrant(r.auth, r.leaver, { status: "registered" });
    expect(await activeTableRows(r.divisionId)).toEqual([]);
    await withdrawRegistrationPublic(r.registrationId, r.token);
    expect(await statusOf(r.leaver)).toBe("withdrawn");
    expect((await activeTableRows(r.divisionId)).map((x) => [x.payload.policy, x.payload.played_at_departure, x.payload.scheduled])).toEqual([["walkover", 3, 5]]);
  }, 240_000);
});
