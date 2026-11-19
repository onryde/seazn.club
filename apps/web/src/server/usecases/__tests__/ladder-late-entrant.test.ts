// A late entrant to a RUNNING ladder joins the bottom of `config.ladder_order` in the transaction that admits them.
//
// The defect: `ladder_order` is written once, on the first challenge, from the field as it stood then. An entrant
// added afterwards was in no rung, so every challenge naming them refused LADDER_ENTRANT_FOREIGN and the ladder panel
// (which lists `ladder_order`) did not show them at all - the division builder's own promise that "ladders take late
// joiners by design" (entrants.ts) could never be kept.
//
// Where a newcomer goes: the bottom. The engine declares no ladder-entry rule (its X-LE rows are knockout, Swiss and
// stepladder entry); the convention this ladder already follows is seed order, and a newcomer is the youngest seed -
// the same place a withdrawn-then-reinstated entrant who never held a rung lands.
//
// Single sport (generic): the order lives in stage config and is read by no sport module, so another sport changes
// nothing here - the shared helper has no sport input at all.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants, patchEntrant } from "../entrants";
import { commitImport, createImport } from "../imports";
import { confirmRegistration } from "../registrations";
import { completeStage, createStages, generateStageFixtures, issueChallenge } from "../stages";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { withdrawEntrantCascade } from "../withdrawal";
import { appendToLadderOrder } from "../ladder-late-entry";
import { seedRegistration } from "./_registration-fixtures";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

interface Rig {
  auth: AuthCtx;
  divisionId: string;
  stageId: string;
  ids: string[];
}

async function addEntrants(auth: AuthCtx, divisionId: string, names: string[], seedFrom: number): Promise<string[]> {
  const rows = await createEntrants(
    auth,
    divisionId,
    names.map((display_name, i) => ({
      kind: "individual" as const,
      display_name,
      seed: seedFrom + i,
      members: [],
    })),
  );
  return rows.map((r) => r.id);
}

/** A ladder of `n` seeded players with a wide `challengeRange`, so a refusal can only come from the guard under test. */
async function ladder(n = 4): Promise<Rig> {
  const { auth } = await seedOrg("pro");
  await setOrgPlan(auth.orgId, "pro");
  await invalidateOrgEntitlements(auth.orgId);
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Ladder " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  const ids = await addEntrants(auth, division.id, Array.from({ length: n }, (_, i) => `L${i + 1}`), 1);
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "ladder" as never,
    name: "Club ladder",
    config: { challengeRange: 10 },
  });
  await generateStageFixtures(auth, stage!.id); // no-op: ladder fixtures are on demand
  // A RUNNING division: "late" means after Start, and createEntrants admits it only because a ladder is an open format.
  await startDivision(auth, division.id);
  return { auth, divisionId: division.id, stageId: stage!.id, ids };
}

async function storedOrder(stageId: string): Promise<string[] | undefined> {
  const [row] = await sql<{ config: { ladder_order?: string[] } }[]>`select config from stages where id = ${stageId}`;
  return row!.config.ladder_order;
}

/** The first challenge is how a real ladder gets its order (the producer), so the rig drives it rather than writing config. */
async function startTheLadder(r: Rig): Promise<string[]> {
  const out = await issueChallenge(r.auth, r.stageId, { challenger_id: r.ids[1]!, opponent_id: r.ids[0]! });
  return out.ladder_order;
}

async function refusalCode(p: Promise<unknown>): Promise<string | undefined> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  return err instanceof HttpError ? err.code : undefined;
}

describe.skipIf(!HAS_DB)("a late entrant joins the bottom of a running ladder", () => {
  it("is on the ladder at the bottom the moment they are added, the rest of the order untouched", async () => {
    const r = await ladder(4);
    const before = await startTheLadder(r);
    expect(before).toHaveLength(4); // anti-vacuity: a real order was written by the first challenge

    const [late] = await addEntrants(r.auth, r.divisionId, ["Late"], 5);
    const after = await storedOrder(r.stageId);
    expect(after).toEqual([...before, late]);
  });

  it("can challenge upward and be challenged, with no LADDER_ENTRANT_FOREIGN", async () => {
    const r = await ladder(4);
    const before = await startTheLadder(r);
    const [late, late2] = await addEntrants(r.auth, r.divisionId, ["Late", "Late 2"], 5);

    // late challenges the player above them (issued BY the late entrant)
    await issueChallenge(r.auth, r.stageId, { challenger_id: late!, opponent_id: before[3]! });
    // and is challenged by a second newcomer (issued TO the late entrant)
    const out = await issueChallenge(r.auth, r.stageId, { challenger_id: late2!, opponent_id: late! });
    expect(out.fixture_id).toBeTruthy();
  });

  it("a second late entrant lands below the first", async () => {
    const r = await ladder(3);
    const before = await startTheLadder(r);
    const [a] = await addEntrants(r.auth, r.divisionId, ["Late A"], 4);
    const [b, c] = await addEntrants(r.auth, r.divisionId, ["Late B", "Late C"], 5);
    expect(await storedOrder(r.stageId)).toEqual([...before, a, b, c]);
  });

  it("appends below the CURRENT order, after a result has reordered the ladder", async () => {
    const r = await ladder(3);
    await startTheLadder(r);
    // L3 challenges L1; L1 forfeits, so the challenger takes the rung (scoring.ts swaps the two positions).
    const fx = await issueChallenge(r.auth, r.stageId, { challenger_id: r.ids[2]!, opponent_id: r.ids[0]! });
    await scoreEvent(
      r.auth,
      fx.fixture_id,
      { expected_seq: 0, type: "core.forfeit", payload: { by: r.ids[0]!, reason: "walkover" } },
    );
    const mid = await storedOrder(r.stageId);
    expect(mid![0], "the result really reordered the ladder: the challenger now holds the top rung").toBe(r.ids[2]!);
    const [late] = await addEntrants(r.auth, r.divisionId, ["Late"], 4);
    expect(await storedOrder(r.stageId)).toEqual([...mid!, late]);
  });

  it("before the first challenge nothing is written - the first challenge's own initialisation still includes them", async () => {
    const r = await ladder(3);
    expect(await storedOrder(r.stageId)).toBeUndefined(); // the empty case: no order yet
    const [late] = await addEntrants(r.auth, r.divisionId, ["Early late"], 4);
    expect(await storedOrder(r.stageId)).toBeUndefined(); // admission does not invent an order
    const order = await startTheLadder(r);
    expect(order).toContain(late);
  });

  it("a reinstated entrant who already holds a rung keeps it - not moved, not duplicated", async () => {
    const r = await ladder(4);
    const before = await startTheLadder(r);
    await withdrawEntrantCascade(r.auth, r.ids[1]!);
    await patchEntrant(r.auth, r.ids[1]!, { status: "registered" });
    expect(await storedOrder(r.stageId)).toEqual(before);
  });

  it("an entrant withdrawn BEFORE the first challenge, then reinstated after it, is appended at the bottom", async () => {
    const r = await ladder(4);
    // withdrawn first: the first challenge's initialisation reads the live field, so they hold no rung
    await patchEntrant(r.auth, r.ids[3]!, { status: "withdrawn" });
    const before = await startTheLadder(r);
    expect(before).not.toContain(r.ids[3]!);
    expect(before).toHaveLength(3);

    await patchEntrant(r.auth, r.ids[3]!, { status: "registered" });
    expect(await storedOrder(r.stageId)).toEqual([...before, r.ids[3]!]);
    // and they can play
    await issueChallenge(r.auth, r.stageId, { challenger_id: r.ids[3]!, opponent_id: before[2]! });
  });

  it("a withdrawn late entrant stays on the ladder but is refused with the withdrawn code, not the foreign one", async () => {
    const r = await ladder(3);
    const before = await startTheLadder(r);
    const [late] = await addEntrants(r.auth, r.divisionId, ["Late"], 4);
    await withdrawEntrantCascade(r.auth, late!);
    expect(await storedOrder(r.stageId)).toEqual([...before, late]);
    expect(await refusalCode(issueChallenge(r.auth, r.stageId, { challenger_id: late!, opponent_id: before[2]! }))).toBe(
      "LADDER_ENTRANT_WITHDRAWN",
    );
  });

  it("a FINISHED ladder is left as it ended - a late entrant does not edit its final order", async () => {
    const r = await ladder(3);
    await startTheLadder(r);
    const fx = await issueChallenge(r.auth, r.stageId, { challenger_id: r.ids[2]!, opponent_id: r.ids[1]! });
    await scoreEvent(r.auth, fx.fixture_id, { expected_seq: 0, type: "core.forfeit", payload: { by: r.ids[1]!, reason: "walkover" } });
    // settle the first challenge too, so every challenge is decided and the stage can complete
    const first = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${r.stageId} and status = 'scheduled'`;
    for (const f of first) await scoreEvent(r.auth, f.id, { expected_seq: 0, type: "core.forfeit", payload: { by: r.ids[0]!, reason: "walkover" } });
    await completeStage(r.auth, r.stageId);
    const [done] = await sql<{ status: string }[]>`select status from stages where id = ${r.stageId}`;
    expect(done!.status, "premise: the ladder really finished").toBe("complete");
    const ended = await storedOrder(r.stageId);

    await addEntrants(r.auth, r.divisionId, ["Too late"], 4);
    expect(await storedOrder(r.stageId)).toEqual(ended);
  });

  it("an entrant added by a door that never called the helper still becomes challengeable (self-heal at the reader)", async () => {
    const r = await ladder(3);
    const before = await startTheLadder(r);
    const [{ id }] = await sql<{ id: string }[]>`
      insert into entrants (division_id, kind, display_name, status)
      values (${r.divisionId}, 'individual', 'Raw door', 'registered') returning id`;
    expect(await storedOrder(r.stageId)).toEqual(before); // the raw insert bypassed every door
    await issueChallenge(r.auth, r.stageId, { challenger_id: id, opponent_id: before[2]! });
    expect(await storedOrder(r.stageId)).toEqual([...before, id]);
  });
});

describe.skipIf(!HAS_DB)("every door that admits an entrant appends to a running ladder", () => {
  it("a confirmed registration joins the bottom (registrations/materialise.ts)", async () => {
    const r = await ladder(3);
    const before = await startTheLadder(r);
    const [reg] = await sql<{ competition_id: string }[]>`select competition_id from divisions where id = ${r.divisionId}`;
    const { registration } = await seedRegistration(
      reg!.competition_id,
      r.divisionId,
      { fee_cents: 0, currency: "eur", payment_method: "offline" },
      { displayName: "Signed up late" },
    );
    const confirmed = await confirmRegistration(r.auth, registration.id);
    expect(confirmed.entrant_id, "premise: the confirmation made an entrant").toBeTruthy();
    expect(await storedOrder(r.stageId)).toEqual([...before, confirmed.entrant_id]);
  });

  // single-sport: football - an import's `entrant.create` makes TEAM entrants only, and this is also the non-generic sport case.
  it("an imported team joins the bottom (imports.ts entrant.create)", async () => {
    const csv = (rows: string[]) => ({
      filename: "import.csv",
      contentType: "text/csv",
      buffer: Buffer.from(["Club,Team,Player,DOB,Number,Position,Captain,Division", ...rows].join("\r\n"), "utf8"),
    });
    const { auth } = await seedOrg("pro");
    await setOrgPlan(auth.orgId, "pro");
    await invalidateOrgEntitlements(auth.orgId);
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Import " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
    const slug = "lad-" + randomUUID().slice(0, 4);
    const division = await createDivision(auth, comp.id, { name: "U12", slug, sport_key: "football", variant_key: "small-sided", config: {} });
    const first = await createImport(
      auth,
      csv(["A SC,A Team,Ada One,2014-01-01,1,,,", "B SC,B Team,Bo Two,2014-01-02,2,,,", "C SC,C Team,Cy Three,2014-01-03,3,,,"].map((row) => row + slug)),
    );
    expect(first.plan.issues, "premise: the roster file plans clean").toEqual([]);
    await commitImport(auth, first.importId, null);
    const [stage] = await createStages(auth, division.id, {
      seq: 1,
      kind: "ladder" as never,
      name: "Club ladder",
      config: { challengeRange: 10 },
    });
    await startDivision(auth, division.id);
    const teams = await sql<{ id: string }[]>`select id from entrants where division_id = ${division.id} order by created_at, id`;
    expect(teams, "premise: three teams").toHaveLength(3);
    const started = await issueChallenge(auth, stage!.id, { challenger_id: teams[1]!.id, opponent_id: teams[0]!.id });
    expect(started.ladder_order).toHaveLength(3);

    const late = await createImport(auth, csv([`D SC,D Team,Di Four,2014-01-04,4,,,${slug}`]));
    expect(late.plan.stats.entrants, "premise: the file makes one entrant").toBe(1);
    await commitImport(auth, late.importId, null);
    const [d] = await sql<{ id: string }[]>`select id from entrants where division_id = ${division.id} and display_name = 'D Team'`;
    expect(await storedOrder(stage!.id)).toEqual([...started.ladder_order, d!.id]);
  });
});

// The result hook (scoring.ts) swaps two rungs. It used to rewrite the WHOLE `ladder_order` from the `stage_config` it
// read at the top of its transaction, so a late add that committed its append while the result was being scored was
// overwritten by the stale order. Driven here with two connections: tx1 admits a newcomer and appends them but has not
// committed; the result is scored meanwhile (it reads the pre-append order and its write blocks on tx1's row lock);
// tx1 then commits. The newcomer must survive the swap.
describe.skipIf(!HAS_DB)("a late add that commits while a ladder result is being scored survives the swap", () => {
  async function scoringBlockedOnALock(): Promise<boolean> {
    for (let i = 0; i < 100; i++) {
      const [row] = await sql<{ n: number }[]>`
        select count(*)::int as n from pg_stat_activity
        where wait_event_type = 'Lock' and query ilike '%jsonb_build_object%ladder_order%'`;
      if (row!.n > 0) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }

  it("the swap lands, the newcomer is still on the ladder at the bottom, nobody is lost or duplicated", async () => {
    const r = await ladder(3);
    const before = await startTheLadder(r); // [L1, L2, L3]
    const fx = await issueChallenge(r.auth, r.stageId, { challenger_id: r.ids[2]!, opponent_id: r.ids[0]! });

    let release!: () => void;
    const held = new Promise<void>((res) => (release = res));
    let admitted!: () => void;
    const admittedSignal = new Promise<void>((res) => (admitted = res));
    let lateId = "";
    const tx1 = sql.begin(async (tx) => {
      const [e] = await tx<{ id: string }[]>`
        insert into entrants (division_id, org_id, kind, display_name, seed)
        values (${r.divisionId}, ${r.auth.orgId}, 'individual', 'Late in flight', 99) returning id`;
      lateId = e!.id;
      await appendToLadderOrder(tx, r.divisionId);
      admitted();
      await held;
    });
    await admittedSignal;

    // L3 (the challenger) takes the game: the hook swaps L3 above L1.
    const scoring = scoreEvent(r.auth, fx.fixture_id, { expected_seq: 0, type: "core.forfeit", payload: { by: r.ids[0]!, reason: "walkover" } });
    // Anti-vacuity: the score really is blocked behind the uncommitted append. If it were not, the test would pass without
    // ever interleaving anything.
    expect(await scoringBlockedOnALock(), "the result's ladder write is waiting on the append's row lock").toBe(true);
    release();
    await tx1;
    await scoring;

    const order = await storedOrder(r.stageId);
    expect(order, "the late entrant survived the swap, at the bottom").toEqual([r.ids[2]!, r.ids[1]!, r.ids[0]!, lateId]);
    expect(new Set(order).size, "nobody duplicated").toBe(order!.length);
    expect(before).toHaveLength(3);
  });

  it("a result where the holder wins swaps nothing (the SQL guard: winner below loser), and a later add still lands at the bottom", async () => {
    const r = await ladder(3);
    await startTheLadder(r);
    const fx = await issueChallenge(r.auth, r.stageId, { challenger_id: r.ids[2]!, opponent_id: r.ids[0]! });
    // the holder (L1) wins: the challenger forfeits - no swap, order unchanged except for the append
    await scoreEvent(r.auth, fx.fixture_id, { expected_seq: 0, type: "core.forfeit", payload: { by: r.ids[2]!, reason: "walkover" } });
    const [late] = await addEntrants(r.auth, r.divisionId, ["Late"], 4);
    expect(await storedOrder(r.stageId)).toEqual([r.ids[0]!, r.ids[1]!, r.ids[2]!, late]);
  });
});
