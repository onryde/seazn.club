// Scorer sheets §4.3 — the device-link refusal once a result has moved the
// competition on. Driven through the REAL producers (onDecided's fillSlot, the
// Swiss Pair/Unpair calls, the bearer door) and the REAL consumer (scoreEvent),
// never a fixture on both ends. One killing case per gate: winner feed
// (knockout), loser feed, Swiss next round (+ its ad-hoc exclusion), stage
// complete, and the scoring path's own status gate.
import { afterAll, describe, expect, it, vi } from "vitest";
import { sql, withTenant } from "@/lib/db";
import { seedOrg } from "./_seed";
import { decide, deviceFor, fixturesOf, pairNextSwissRound, seedStage, voidEvent } from "./_sheets-rig";
import { addFixture, unpairSwissRound } from "../stages";
import { scoreEvent } from "../scoring";
import { resultCarriedForward } from "../carried-forward";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  vi.unstubAllEnvs();
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

const CARRIED = { status: 403, code: "RESULT_CARRIED_FORWARD" };

describe.skipIf(!HAS_DB)("device-link refusal once a result is carried forward (scorer sheets §4.3)", () => {
  it("empty case: a decided league fixture (no feeds, stage open) — the umpire may void their own result", async () => {
    const { auth } = await seedOrg("pro");
    const { stage } = await seedStage(auth, "league", ["A", "B", "C", "D"]);
    const [f] = await fixturesOf(stage.id);
    const device = await deviceFor(auth, f!.id);
    const own = await decide(device, f!.id);
    await expect(voidEvent(device, f!.id, own)).resolves.toBeDefined();
  });

  it("knockout: the SF is carried the instant it is decided (P5) — device void 403, organiser void passes", async () => {
    const { auth } = await seedOrg("pro");
    const { stage } = await seedStage(auth, "knockout", ["A", "B", "C", "D"]);
    const sf1 = (await fixturesOf(stage.id)).find((x) => x.round_no === 1 && x.seq_in_round === 1)!;
    const device = await deviceFor(auth, sf1.id);
    const own = await decide(device, sf1.id);
    const [target] = await sql<{ home_entrant_id: string | null; away_entrant_id: string | null }[]>`
      select home_entrant_id, away_entrant_id from fixtures where id = ${sf1.winner_to_fixture}`;
    expect(sf1.winner_to_slot === 1 ? target!.home_entrant_id : target!.away_entrant_id).not.toBeNull();
    await expect(voidEvent(device, sf1.id, own)).rejects.toMatchObject(CARRIED);
    // The organiser's session is unaffected (§4.3 last paragraph).
    await expect(voidEvent(auth, sf1.id, own)).resolves.toBeDefined();
  });

  it("loser feed: carried the INSTANT it is decided (onDecided seats the loser, P5/Q2); slot mapping witnessed both ways", async () => {
    const { auth } = await seedOrg("pro");
    const { stage } = await seedStage(auth, "league", ["A", "B", "C", "D"]);
    const [f, target] = await fixturesOf(stage.id);
    // Empty the target's AWAY side and point f's loser at it. onDecided's
    // fillSlot seats the loser there at decide time, for any stage kind:
    // carried immediately (controller ruling).
    await sql`update fixtures set away_entrant_id = null where id = ${target!.id}`;
    await sql`update fixtures set loser_to_fixture = ${target!.id}, loser_to_slot = 2 where id = ${f!.id}`;
    const device = await deviceFor(auth, f!.id);
    const own = await decide(device, f!.id);
    const [seated] = await sql<{ away_entrant_id: string | null }[]>`
      select away_entrant_id from fixtures where id = ${target!.id}`;
    expect(seated!.away_entrant_id, "precondition: decide seated the loser").not.toBeNull();
    await expect(voidEvent(device, f!.id, own)).rejects.toMatchObject(CARRIED);
    // The differential for the slot mapping: empty the AWAY side (slot 2) and
    // leave HOME filled. Not carried now, so the void passes. A mapping that
    // read slot 2 as `home` would still say "filled" and 403 here.
    await sql`update fixtures set away_entrant_id = null where id = ${target!.id}`;
    await expect(voidEvent(device, f!.id, own)).resolves.toBeDefined();
  });

  it("swiss: an ad-hoc match after the LAST round does not carry that round (C7 — ext_key 'adhoc-')", async () => {
    const { auth } = await seedOrg("pro");
    const { stage } = await seedStage(auth, "swiss", ["A", "B", "C", "D"], { rounds: 1 });
    const r1 = (await fixturesOf(stage.id)).filter((x) => x.round_no === 1 && x.home_entrant_id && x.away_entrant_id);
    expect(r1.length, "precondition: round 1 is seated (two boards)").toBe(2);
    const device = await deviceFor(auth, r1[0]!.id);
    const own = await decide(device, r1[0]!.id); // one board only: the stage stays open
    await addFixture(auth, stage.id, { home_entrant_id: r1[1]!.home_entrant_id!, away_entrant_id: r1[1]!.away_entrant_id! });
    const [adhoc] = await sql<{ round_no: number; ext_key: string }[]>`
      select round_no, ext_key from fixtures where stage_id = ${stage.id} and ext_key like 'adhoc-%'`;
    expect(adhoc, "precondition: the ad-hoc match sits at round_no + 1").toMatchObject({ round_no: 2 });
    await expect(voidEvent(device, r1[0]!.id, own)).resolves.toBeDefined();
  });

  it("resultCarriedForward owns its status check: a scheduled fixture with a filled feed is NOT carried; decided is", async () => {
    const { auth } = await seedOrg("pro");
    const { stage } = await seedStage(auth, "knockout", ["A", "B", "C", "D"]);
    const sf2 = (await fixturesOf(stage.id)).find((x) => x.round_no === 1 && x.seq_in_round === 2)!;
    const column = sf2.winner_to_slot === 1 ? sql`home_entrant_id` : sql`away_entrant_id`;
    await sql`update fixtures set ${column} = (select home_entrant_id from fixtures where id = ${sf2.id}) where id = ${sf2.winner_to_fixture}`;
    expect(await withTenant(auth.orgId, (tx) => resultCarriedForward(tx, sf2.id))).toBe(false);
    await sql`update fixtures set status = 'decided' where id = ${sf2.id}`;
    expect(await withTenant(auth.orgId, (tx) => resultCarriedForward(tx, sf2.id))).toBe(true);
  });

  it("swiss: round N is carried while round N+1 is seated, and re-opens when it is unpaired", async () => {
    const { auth } = await seedOrg("pro");
    const { stage } = await seedStage(auth, "swiss", ["A", "B", "C", "D"], { rounds: 2 });
    const r1 = (await fixturesOf(stage.id)).filter((x) => x.round_no === 1 && x.home_entrant_id && x.away_entrant_id);
    expect(r1.length).toBe(2);
    const device = await deviceFor(auth, r1[0]!.id);
    const own = await decide(device, r1[0]!.id);
    await decide(auth, r1[1]!.id);
    await pairNextSwissRound(auth, stage.id);
    await expect(voidEvent(device, r1[0]!.id, own)).rejects.toMatchObject(CARRIED);
    await unpairSwissRound(auth, stage.id);
    await expect(voidEvent(device, r1[0]!.id, own)).resolves.toBeDefined();
  });

  it("stage complete: carried; stage re-opened: not carried", async () => {
    const { auth } = await seedOrg("pro");
    const { stage } = await seedStage(auth, "league", ["A", "B", "C", "D"]);
    const [f] = await fixturesOf(stage.id);
    const device = await deviceFor(auth, f!.id);
    const own = await decide(device, f!.id);
    await sql`update stages set status = 'complete' where id = ${stage.id}`;
    await expect(voidEvent(device, f!.id, own)).rejects.toMatchObject(CARRIED);
    await sql`update stages set status = 'active' where id = ${stage.id}`;
    await expect(voidEvent(device, f!.id, own)).resolves.toBeDefined();
  });

  it("a SCHEDULED fixture whose feed an organiser filled by hand still scores (Review Focus 2)", async () => {
    const { auth } = await seedOrg("pro");
    const { stage } = await seedStage(auth, "knockout", ["A", "B", "C", "D"]);
    const sf2 = (await fixturesOf(stage.id)).find((x) => x.round_no === 1 && x.seq_in_round === 2)!;
    const [anyEntrant] = await sql<{ id: string }[]>`
      select home_entrant_id as id from fixtures where id = ${sf2.id}`;
    const column = sf2.winner_to_slot === 1 ? sql`home_entrant_id` : sql`away_entrant_id`;
    await sql`update fixtures set ${column} = ${anyEntrant!.id} where id = ${sf2.winner_to_fixture}`;
    const device = await deviceFor(auth, sf2.id);
    await expect(
      scoreEvent(device, sf2.id, { expected_seq: 0, type: "core.start", payload: {} }),
    ).resolves.toBeDefined();
  });
});
