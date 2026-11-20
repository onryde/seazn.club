// W5 app PR B Task 2 (X-WDT-4 <- RB5-W7, the decision half: the decision names its rule and its counts; ST-G15 note; preflight
// C13): a table withdrawal's footnote counts ("left after 2 of 5") are the ENGINE's - the `entrant_withdrawn` event's `played` and
// `scheduled` (engine 10.0.0, `void_remaining` only) - read inside `decideTableWithdrawal`, the ONE decision the cascade applies and
// the Disqualify preview shows (ruling 289), so the stored ledger row and the preview cannot count apart.
//
// differential: today (709fa61330) the decision returns the app's own count (`played.length`, `played.length + pending.length`) and
// never reads the event's - the seam test below hands the decision an event whose counts differ from the rows and reads which one
// it returns. Over real rows the two agree (RB5-W4 counts the same lines), which is what the parity rigs pin: the app's count stays
// only as the parity's other side.
//
// Expected values: the rulebook's (RB5-W4: a line with a recorded result is played, played + pending is the count the 50 percent
// rule reads; RB5-W2: under half -> expunge; RB5-W3: half or more -> walkover; Swiss always walks over, owner ruling 2026-09-24),
// typed per rig from how the rig was played - never from the code under test.
//
// single-sport (badminton) for the parity rigs: the counts are lines and statuses, which no sport field reaches; the sport sweep
// is the walkover row's own describe.
import { afterAll, describe, expect, it, vi } from "vitest";

/** The engine seam: pass-through unless a test hands `withdrawTableEntrant` an event of its own. */
const engineSeam = vi.hoisted(() => ({ event: undefined as undefined | Record<string, unknown>, calls: 0 }));
vi.mock("@seazn/engine/competition", async (io) => {
  const real = await io<typeof import("@seazn/engine/competition")>();
  return {
    ...real,
    withdrawTableEntrant: (...args: Parameters<typeof real.withdrawTableEntrant>) => {
      engineSeam.calls++;
      const out = real.withdrawTableEntrant(...args);
      return engineSeam.event === undefined ? out : { ...out, events: [engineSeam.event as never] };
    },
  };
});
// No network on these paths (the late arrival's confirmation): a Stripe call is a failure, and mail never leaves.
vi.mock("@/lib/stripe", async (io) => ({
  ...(await io<typeof import("@/lib/stripe")>()),
  getStripe: () => {
    throw new Error("this suite makes no Stripe call");
  },
}));
vi.mock("@/server/email-outbox/transport", () => ({ deliver: vi.fn() }));

import { randomUUID } from "node:crypto";
import { withdrawTableEntrant } from "@seazn/engine/competition";
import { builtinModules } from "@seazn/engine/sports";
import type { AnySportModule } from "@seazn/engine/sport";
import { forEachSportAsync } from "@seazn/engine/testkit";
import enPublic from "@/dictionaries/en/public.json";
import { sql } from "@/lib/db";
import { tableWithdrawalInputs, type WithdrawalFixtureRow } from "@/lib/table-withdrawal";
import { withdrawalNoteBody } from "@/lib/table-withdrawal-note";
import type { AuthCtx } from "@/server/api-v1/auth";
import { playBadminton, post, tip } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import { loadTableWithdrawals } from "@/server/public-site/table-withdrawals";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants, patchEntrant } from "../entrants";
import { confirmRegistration } from "../registrations";
import { placeWaitingTableEntrant } from "../roundrobin-late-entry";
import { startDivision } from "../schedule";
import { finalizeFixture, scoreEvent } from "../scoring";
import { createStages } from "../stages";
import { decideTableWithdrawal, withdrawEntrantCascade } from "../withdrawal";
import { previewWithdrawal } from "../withdrawal-preview";
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

const row = (id: string, status: string, home: string | null, away: string | null, outcome: unknown = null): WithdrawalFixtureRow => ({
  id,
  status,
  home_entrant_id: home,
  away_entrant_id: away,
  outcome,
});
const WON = { kind: "win", winner: "x" };
const LEAGUE = { id: "stage-1", kind: "league" as const };

describe("X-WDT-4 the decision reads the engine event's counts (C13: one decision, two readers)", () => {
  it("X-WDT-4 the decision's counts are the engine event's, not the app's own count of the rows", () => {
    // Her rows: one decided, two still to play - the app's own count is 1 of 3. The engine event is handed 7 of 11, a count no
    // row gives, so only a decision that reads the event can return it.
    const mine = [row("a", "decided", "me", "o1", WON), row("b", "scheduled", "me", "o2"), row("c", "scheduled", "o3", "me")];
    engineSeam.event = { type: "entrant_withdrawn", stageId: LEAGUE.id, entrantId: "me", policy: "void_remaining", mode: "award", played: 7, scheduled: 11 };
    try {
      const d = decideTableWithdrawal(LEAGUE, "me", mine);
      expect({ mode: d.mode, played: d.played, scheduled: d.scheduled }).toEqual({ mode: "walkover", played: 7, scheduled: 11 });
    } finally {
      engineSeam.event = undefined;
    }
  });

  it("X-WDT-4 an engine event without its counts is refused by name (a guard, not a fallback to the app's count)", () => {
    const mine = [row("a", "decided", "me", "o1", WON), row("b", "scheduled", "me", "o2")];
    engineSeam.event = { type: "entrant_withdrawn", stageId: LEAGUE.id, entrantId: "me", policy: "void_remaining", mode: "award" };
    try {
      expect(() => decideTableWithdrawal(LEAGUE, "me", mine)).toThrow(/entrant_withdrawn.*counts/);
    } finally {
      engineSeam.event = undefined;
    }
  });

  it("X-WDT-4 over real rows the engine's counts are the app's (RB5-W4 parity), every mix of statuses", () => {
    // Every status a line of hers can hold, with and without a result: played = a played status with a result (an abandoned
    // line with a stored result too, RB5-W4's B3 reading); pending = scheduled or in play; a cancelled line is neither.
    const statuses = ["scheduled", "in_play", "decided", "finalized", "forfeited", "abandoned", "cancelled", "needs_decision"];
    let checked = 0;
    for (const s1 of statuses) {
      for (const s2 of statuses) {
        for (const withResult of [true, false]) {
          const mine = [row("a", s1, "me", "o1", withResult ? WON : null), row("b", s2, "o2", "me", withResult ? null : WON), row("c", "scheduled", "me", "o3")];
          const app = tableWithdrawalInputs("me", mine);
          const d = decideTableWithdrawal(LEAGUE, "me", mine);
          expect([d.played, d.scheduled], `${s1}/${s2}/${withResult}`).toEqual([app.played.length, app.played.length + app.pending.length]);
          checked++;
        }
      }
    }
    expect(checked, "anti-vacuity").toBe(statuses.length * statuses.length * 2);
  });

  it("X-WDT-4 the empty case: no lines -> the engine's expunge of 0 of 0, and the footnote's own line for it (never 'left after 0 of 0')", () => {
    const d = decideTableWithdrawal(LEAGUE, "me", []);
    expect({ mode: d.mode, played: d.played, scheduled: d.scheduled, pending: d.pending, updates: d.updates }).toEqual({
      mode: "expunge",
      played: 0,
      scheduled: 0,
      pending: [],
      updates: [],
    });
    const body = withdrawalNoteBody({ policy: d.mode, played: d.played, scheduled: d.scheduled });
    expect(body.key, "R24 item 11: nothing scheduled has its own line").toBe("table.withdrawalNote.none");
    expect((enPublic as Record<string, string>)[body.key]).toBe("left before any match was scheduled.");
  });

  it("X-WDT-4 a Swiss withdrawal is unchanged: always a walkover (owner ruling 2026-09-24), the engine's counts", () => {
    const SWISS = { id: "swiss-1", kind: "swiss" as const };
    // 1 of 5 played: under half, which would expunge in a league - a Swiss walks over.
    const mine = [row("a", "decided", "me", "o1", WON), ...["b", "c", "d", "e"].map((id, i) => row(id, "scheduled", "me", `o${i + 2}`))];
    const d = decideTableWithdrawal(SWISS, "me", mine);
    expect({ mode: d.mode, played: d.played, scheduled: d.scheduled, walkovers: d.updates.length }).toEqual({ mode: "walkover", played: 1, scheduled: 5, walkovers: 4 });
    const league = decideTableWithdrawal(LEAGUE, "me", mine);
    expect(league.mode, "the positive pair: the same rows expunge in a league").toBe("expunge");
  });
});

// --------------------------------------------------------------------------------------------------------------------------
// The parity rigs (R4a/b/c): the stored ledger row (the footnote's source) against the rulebook and the app's own count.

type Kind = "individual" | "pair" | "team";
const moduleOf = (key: string): AnySportModule => builtinModules.find((m) => m.key === key) as AnySportModule;
const variantOf = (key: string): string => Object.keys(moduleOf(key).variants)[0]!;

interface Rig {
  auth: AuthCtx;
  competitionId: string;
  divisionId: string;
  stageId: string;
  id: Map<string, string>;
}

/** `n` entrants P1..Pn seeded in order, one root league of `sport`, Started. */
async function league(n: number, sport = "badminton"): Promise<Rig> {
  const kind = (moduleOf(sport).entrantModel?.defaultKind ?? "individual") as Kind;
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "W5 B T2 " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const d = await createDivision(auth, comp.id, { name: "Open", slug: "o-" + randomUUID().slice(0, 6), sport_key: sport, variant_key: variantOf(sport), config: {} });
  const es = await createEntrants(
    auth,
    d.id,
    Array.from({ length: n }, (_, i) => ({ kind, display_name: `P${i + 1}`, seed: i + 1, members: [] })),
  );
  const [s] = await createStages(auth, d.id, { seq: 1, kind: "league", name: "League", config: { legs: 1 }, progression: null });
  await startDivision(auth, d.id);
  return { auth, competitionId: comp.id, divisionId: d.id, stageId: s!.id, id: new Map(es.map((e) => [e.display_name, e.id])) };
}

interface Line extends WithdrawalFixtureRow {
  ext_key: string | null;
}
const linesOf = (stageId: string, entrantId: string) =>
  sql<Line[]>`
    select id, ext_key, status, home_entrant_id, away_entrant_id, outcome from fixtures
     where stage_id = ${stageId} and (home_entrant_id = ${entrantId} or away_entrant_id = ${entrantId})
     order by round_no, seq_in_round, id`;

/** Her line against `opponent`. */
async function lineAgainst(r: Rig, entrantId: string, opponent: string): Promise<Line> {
  const l = (await linesOf(r.stageId, entrantId)).find((x) => x.home_entrant_id === opponent || x.away_entrant_id === opponent);
  if (l === undefined) throw new Error("rig: no line between the two");
  return l;
}

/** The stored ledger row's counts, and the app's own count over her rows BEFORE the withdrawal (the parity's other side). */
async function withdrawAndRead(r: Rig, entrantId: string) {
  const before = await linesOf(r.stageId, entrantId);
  const app = tableWithdrawalInputs(entrantId, before);
  const preview = (await previewWithdrawal(r.auth, entrantId, "withdrawn")).stages.find((s) => s.stage_id === r.stageId);
  await withdrawEntrantCascade(r.auth, entrantId);
  const active = (await loadTableWithdrawals(r.divisionId)).filter((x) => x.entrant_id === entrantId);
  expect(active, "one active ledger row for her").toHaveLength(1);
  return {
    stored: { policy: active[0]!.policy, played: active[0]!.played_at_departure, scheduled: active[0]!.scheduled },
    app: { played: app.played.length, scheduled: app.played.length + app.pending.length },
    preview: preview === undefined ? undefined : { mode: preview.mode, played: preview.played, scheduled: preview.scheduled },
  };
}

describe.skipIf(!HAS_DB)("X-WDT-4 the stored note equals the engine event's counts (R4 rigs)", () => {
  it("R4a 2 of 5 played, one of them signed off: an expunge, 'left after 2 of 5', the preview the same count", async () => {
    const r = await league(6);
    const [p1, p2, p3] = [r.id.get("P1")!, r.id.get("P2")!, r.id.get("P3")!];
    const a = await lineAgainst(r, p1, p2);
    await playBadminton(r.auth, a.id, a.home_entrant_id === p1);
    await finalizeFixture(r.auth, a.id, await tip(a.id));
    expect((await lineAgainst(r, p1, p2)).status, "rig: the result under the line is signed off").toBe("finalized");
    const b = await lineAgainst(r, p1, p3);
    await playBadminton(r.auth, b.id, b.home_entrant_id === p3);
    const out = await withdrawAndRead(r, p1);
    // RB5-W4: 2 played of 5 scheduled; RB5-W2: 2/5 is under half -> expunge.
    expect(out.stored).toEqual({ policy: "expunge", played: 2, scheduled: 5 });
    expect(out.app, "parity: the app's own count").toEqual({ played: 2, scheduled: 5 });
    expect(out.preview, "the Disqualify preview reads the same decision").toEqual({ mode: "expunge", played: 2, scheduled: 5 });
  }, 300_000);

  it("R4b 3 of 5 played: a walkover, 'left after 3 of 5', her other two matches walked over", async () => {
    const r = await league(6);
    const p1 = r.id.get("P1")!;
    for (const opp of ["P2", "P3", "P4"]) {
      const l = await lineAgainst(r, p1, r.id.get(opp)!);
      await playBadminton(r.auth, l.id, l.home_entrant_id === p1);
    }
    const out = await withdrawAndRead(r, p1);
    // RB5-W4: 3 of 5; RB5-W3: half or more -> walkover.
    expect(out.stored).toEqual({ policy: "walkover", played: 3, scheduled: 5 });
    expect(out.app).toEqual({ played: 3, scheduled: 5 });
    expect(out.preview).toEqual({ mode: "award", played: 3, scheduled: 5 });
    const walked = (await linesOf(r.stageId, p1)).filter((l) => (l.outcome as { reason?: string } | null)?.reason === "withdrew");
    expect(walked, "the two unplayed lines are walkovers").toHaveLength(2);
  }, 300_000);

  it("R4c a catch-up line is counted: 2 played of 3 drawn + 1 catch-up = 2 of 4, half -> a walkover", async () => {
    const r = await league(4);
    const [p1, p2, p3] = [r.id.get("P1")!, r.id.get("P2")!, r.id.get("P3")!];
    // The stage has started (a scorer's Start on a round-1 line), so a confirmed arrival waits for the organiser's tap.
    const first = (await sql<{ id: string }[]>`select id from fixtures where stage_id = ${r.stageId} and round_no = 1 order by seq_in_round limit 1`)[0]!;
    await scoreEvent(r.auth, first.id, { expected_seq: await tip(first.id), type: "core.start", payload: {} });
    const { registration } = await seedRegistration(r.competitionId, r.divisionId, { fee_cents: 0, currency: "eur", payment_method: "offline" }, { displayName: "Late" });
    const confirmed = await confirmRegistration(r.auth, registration.id);
    const late = confirmed.entrant_id!;
    const placed = await placeWaitingTableEntrant(r.auth, r.stageId, late);
    expect(placed.case, "rig: the arrival's catch-up set").toBe("catch_up");
    const catchUp = await lineAgainst(r, p1, late);
    expect(catchUp.ext_key, "rig: P1's line against the arrival is a catch-up line").toMatch(/^rr-(cu|by)-/);
    for (const opp of [p2, p3]) {
      const l = await lineAgainst(r, p1, opp);
      await playBadminton(r.auth, l.id, l.home_entrant_id === p1);
    }
    const out = await withdrawAndRead(r, p1);
    // RB5-W4: the catch-up line is one of hers to play: 2 of 4; RB5-W3: 2/4 is half -> walkover (without it, 2/3 - also a
    // walkover, but "after 2 of 3").
    expect(out.stored).toEqual({ policy: "walkover", played: 2, scheduled: 4 });
    expect(out.app).toEqual({ played: 2, scheduled: 4 });
  }, 300_000);

  it("X-WDT-4 after Reinstate the note is gone; a second withdrawal writes the engine's new count", async () => {
    const r = await league(4);
    const [p1, p2] = [r.id.get("P1")!, r.id.get("P2")!];
    const first = await withdrawAndRead(r, p1);
    // RB5-W4: nothing played of 3 -> an expunge of 0 of 3.
    expect(first.stored).toEqual({ policy: "expunge", played: 0, scheduled: 3 });
    await patchEntrant(r.auth, p1, { status: "registered" });
    expect(await loadTableWithdrawals(r.divisionId), "Reinstate voids the row: no footnote").toEqual([]);
    const l = await lineAgainst(r, p1, p2);
    await playBadminton(r.auth, l.id, l.home_entrant_id === p1);
    const second = await withdrawAndRead(r, p1);
    expect(second.stored, "the sequence: 1 of 3 now, still under half").toEqual({ policy: "expunge", played: 1, scheduled: 3 });
  }, 300_000);

  it("X-WDT-4 the empty case on a real table: a waiting arrival holds no line, so her withdrawal writes no row (nothing to footnote)", async () => {
    const r = await league(4);
    const first = (await sql<{ id: string }[]>`select id from fixtures where stage_id = ${r.stageId} and round_no = 1 order by seq_in_round limit 1`)[0]!;
    await scoreEvent(r.auth, first.id, { expected_seq: await tip(first.id), type: "core.start", payload: {} });
    const { registration } = await seedRegistration(r.competitionId, r.divisionId, { fee_cents: 0, currency: "eur", payment_method: "offline" }, { displayName: "Waiting" });
    const late = (await confirmRegistration(r.auth, registration.id)).entrant_id!;
    expect(await linesOf(r.stageId, late), "rig: she waits, seated nowhere").toEqual([]);
    const calls = engineSeam.calls;
    await withdrawEntrantCascade(r.auth, late);
    expect(engineSeam.calls - calls, "no line, no decision to take").toBe(0);
    expect(await loadTableWithdrawals(r.divisionId)).toEqual([]);
  }, 300_000);
});

describe.skipIf(!HAS_DB)("X-WDT-4 every sport: the walkover row stores the engine's counts", () => {
  it("1 of 2 played (an ordinary walkover is a recorded result in every sport): a walkover, 'left after 1 of 2'", async () => {
    const seen: string[] = [];
    await forEachSportAsync(async ({ key }) => {
      if (key === "generic") return; // no catalogue variant a division can be created on without the seeded score variant
      const r = await league(3, key);
      const [l, a, b] = [r.id.get("P1")!, r.id.get("P2")!, r.id.get("P3")!];
      const played = await lineAgainst(r, l, a);
      const out0 = await post(r.auth, played.id, "core.forfeit", { by: a, reason: "walkover" });
      expect(out0.status, `${key}: rig: an ordinary walkover is a recorded result`).toBe("forfeited");
      const before = await linesOf(r.stageId, l);
      const engine = withdrawTableEntrant({ id: r.stageId, kind: "league" }, l, tableWithdrawalInputs(l, before)).events[0];
      const out = await withdrawAndRead(r, l);
      // RB5-W4: 1 of 2; RB5-W3: half -> walkover.
      expect(out.stored, `${key}: the rulebook's count`).toEqual({ policy: "walkover", played: 1, scheduled: 2 });
      expect(engine, `${key}: the engine's own event says the same`).toMatchObject({ mode: "award", played: 1, scheduled: 2 });
      const owed = await lineAgainst(r, l, b);
      expect(owed.outcome, `${key}: the unplayed line is B's walkover`).toMatchObject({ winner: b, reason: "withdrew" });
      seen.push(key);
    });
    expect(seen.length, `anti-vacuity: sports swept (${seen.join(", ")})`).toBeGreaterThan(0);
    expect(seen.length, "every builtin module but generic").toBe(builtinModules.filter((m) => m.key !== "generic").length);
  }, 600_000);
});
