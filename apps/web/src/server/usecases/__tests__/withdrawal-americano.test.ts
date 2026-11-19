// Withdrawing an individual from an AMERICANO (or mexicano) stage.
//
// The defect (driven live on 2026-11-18, americano of 8, round 1 played, Player 1 withdrawn): the cascade reported
// `policy: "none", voided: 0` and four scheduled matches still named the withdrawn player. An americano's fixtures
// name per-round PAIR entrants minted from the individuals (`pairEntrantsFor`, stages/generators.ts), so the cascade's
// "a fixture whose home or away IS the entrant" never matched a person withdrawn from the field.
//
// The rule (controller's PO call, 2026-11-18; the engine declares no americano withdrawal policy of its own - its
// `withdrawTableEntrant` is league/group/swiss and `withdrawBracketEntrant` is the brackets): the withdrawn player's
// UNPLAYED matches are voided - the pairs involving them do not play - and their PLAYED results stand, so the personal
// points they earned stay on the leaderboard. A match is theirs when either of its pairs holds their person.
//
// Single sport (generic): the americano generator and the cascade read persons and pair entrants, never a sport module.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import type { AuthCtx } from "@/server/api-v1/auth";
import { americanoView } from "../americano";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants, patchEntrant } from "../entrants";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { createStages, generateStageFixtures } from "../stages";
import { withdrawEntrantCascade } from "../withdrawal";
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
  /** The individual entrants, seed order. */
  ids: string[];
  /** Their persons, same order. */
  persons: string[];
}

async function rig(opts: { mode?: "americano" | "mexicano"; players?: number; rounds?: number; start?: boolean } = {}): Promise<Rig> {
  const players = opts.players ?? 8;
  const { auth } = await seedOrg("pro");
  await setOrgPlan(auth.orgId, "pro");
  await invalidateOrgEntitlements(auth.orgId);
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Americano " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Padel",
    slug: "padel",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  const persons: string[] = [];
  for (let i = 0; i < players; i++) {
    const [p] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name, consent) values (${auth.orgId}, ${"Pad " + (i + 1)}, ${sql.json({})}) returning id`;
    persons.push(p!.id);
  }
  const rows = await createEntrants(
    auth,
    division.id,
    persons.map((person_id, i) => ({
      kind: "individual" as const,
      display_name: `Player ${i + 1}`,
      seed: i + 1,
      members: [{ person_id, is_captain: false, roles: [] }],
    })),
  );
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "americano" as never,
    name: "Americano",
    config: { mode: opts.mode ?? "americano", courtCount: 2, rounds: opts.rounds ?? 5 },
  });
  await generateStageFixtures(auth, stage!.id);
  if (opts.start ?? true) await startDivision(auth, division.id);
  return { auth, divisionId: division.id, stageId: stage!.id, ids: rows.map((r) => r.id), persons };
}

interface Fx {
  id: string;
  round_no: number;
  status: string;
  /** The persons on both pairs of this match. */
  people: string[];
}

async function fixtures(stageId: string): Promise<Fx[]> {
  return sql<Fx[]>`
    select f.id, f.round_no, f.status,
           array(select em.person_id from entrant_members em
                 where em.entrant_id in (f.home_entrant_id, f.away_entrant_id)) as people
    from fixtures f where f.stage_id = ${stageId} order by f.round_no, f.seq_in_round`;
}

async function play(auth: AuthCtx, fixtureId: string, home: number, away: number): Promise<void> {
  await scoreEvent(auth, fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
  await scoreEvent(auth, fixtureId, { expected_seq: 1, type: "generic.result", payload: { p1Score: home, p2Score: away } });
}

/** Every fixture of round `n` played 24-18 (the home pair wins), so each player has earned points before anyone leaves. */
async function playRound(r: Rig, n: number): Promise<number> {
  const round = (await fixtures(r.stageId)).filter((f) => f.round_no === n);
  for (const f of round) await play(r.auth, f.id, 24, 18);
  return round.length;
}

/** The cascade's void is an EXPUNGED abandon: fixture status `abandoned` plus one `core.abandon{expunge:true}` ledger row,
 *  written by `withdrawal_cascade` with reason `withdrew` - never a recorded (scorer) abandon, never a cancel. */
async function abandonRows(fixtureId: string): Promise<{ reason: unknown; expunge: unknown }[]> {
  const rows = await sql<{ payload: { reason?: unknown; expunge?: unknown } }[]>`
    select payload from score_events where fixture_id = ${fixtureId} and type = 'core.abandon' order by seq`;
  return rows.map((r) => ({ reason: r.payload.reason, expunge: r.payload.expunge }));
}
const EXPUNGED = [{ reason: "withdrew", expunge: true }];

describe.skipIf(!HAS_DB)("withdrawing an individual from an americano", () => {
  it("voids their unplayed matches, leaves every other match and their played results alone", async () => {
    const r = await rig();
    const played = await playRound(r, 1);
    expect(played, "premise: round 1 has matches and they are decided").toBeGreaterThan(0);
    const before = await fixtures(r.stageId);
    const person = r.persons[0]!;
    const theirs = before.filter((f) => f.people.includes(person));
    const theirUnplayed = theirs.filter((f) => f.status === "scheduled");
    // Anti-vacuity: the premise of the defect - the player has both a played and several unplayed matches.
    expect(theirs.some((f) => f.status === "decided"), "premise: they played round 1").toBe(true);
    expect(theirUnplayed.length, "premise: they have unplayed matches to lose").toBeGreaterThan(1);
    expect(before.some((f) => f.status === "scheduled" && !f.people.includes(person)), "premise: others' matches exist").toBe(true);

    const out = await withdrawEntrantCascade(r.auth, r.ids[0]!);

    expect(out).toMatchObject({ status: "withdrawn", policy: "expunge", walkovers: 0, voided: theirUnplayed.length, skipped_finalized: 0 });
    const after = await fixtures(r.stageId);
    for (const f of after) {
      const was = before.find((b) => b.id === f.id)!;
      if (theirUnplayed.some((u) => u.id === f.id)) {
        expect(f.status, `their unplayed match ${f.id} is abandoned (was ${was.status})`).toBe("abandoned");
        expect(await abandonRows(f.id), `match ${f.id} carries exactly one expunging cascade abandon`).toEqual(EXPUNGED);
      } else {
        expect(f.status, `match ${f.id} is not theirs to lose and keeps its status`).toBe(was.status);
        expect(await abandonRows(f.id), `match ${f.id} was not touched`).toEqual([]);
      }
    }
  });

  it("their played results stand: the leaderboard keeps what they earned and nobody else's points move", async () => {
    const r = await rig();
    await playRound(r, 1);
    const view0 = await americanoView(r.auth, r.stageId);
    const pointsOf = (v: typeof view0, name: string) => v.leaderboard.find((l) => l.name === name)?.points;
    const everyone = Object.fromEntries(view0.leaderboard.map((l) => [l.name, l.points]));
    expect(Object.keys(everyone).length, "premise: the leaderboard lists every player who played").toBe(8);

    await withdrawEntrantCascade(r.auth, r.ids[0]!);

    const view1 = await americanoView(r.auth, r.stageId);
    expect(pointsOf(view1, "Pad 1"), "the withdrawn player keeps the points they earned").toBe(everyone["Pad 1"]);
    for (const l of view1.leaderboard) expect(l.points, `${l.name} is unchanged`).toBe(everyone[l.name]);
    expect(view1.leaderboard.length).toBe(view0.leaderboard.length);
  });

  it("a second withdrawal voids only their own matches; a match holding both withdrawn players is voided once", async () => {
    const r = await rig();
    await playRound(r, 1);
    const before = await fixtures(r.stageId);
    // The second leaver is a player who SHARES an unplayed match with the first (partner or opponent) - found from the
    // generated rotation, never assumed.
    const firstPerson = r.persons[0]!;
    const unplayedWithFirst = before.filter((f) => f.status === "scheduled" && f.people.includes(firstPerson));
    const secondIdx = r.persons.findIndex((p, i) => i !== 0 && unplayedWithFirst.some((f) => f.people.includes(p)));
    expect(secondIdx, "premise: some player shares an unplayed match with the first leaver").toBeGreaterThan(0);
    const secondPerson = r.persons[secondIdx]!;
    const shared = unplayedWithFirst.filter((f) => f.people.includes(secondPerson));
    expect(shared.length, "premise: at least one match holds both").toBeGreaterThan(0);
    const secondOnly = before.filter((f) => f.status === "scheduled" && f.people.includes(secondPerson) && !f.people.includes(firstPerson));
    expect(secondOnly.length, "premise: the second player has matches the first did not touch").toBeGreaterThan(0);

    const first = await withdrawEntrantCascade(r.auth, r.ids[0]!);
    expect(first.voided).toBe(unplayedWithFirst.length);
    for (const f of shared) expect(await abandonRows(f.id), "the shared match is voided by the first withdrawal").toEqual(EXPUNGED);

    const second = await withdrawEntrantCascade(r.auth, r.ids[secondIdx]!);
    expect(second.voided, "only the second player's OWN remaining matches: the shared one is already void").toBe(secondOnly.length);
    for (const f of shared) expect(await abandonRows(f.id), "the shared match is voided ONCE, not again").toEqual(EXPUNGED);
    for (const f of secondOnly) expect(await abandonRows(f.id)).toEqual(EXPUNGED);
    const after = await fixtures(r.stageId);
    expect(after.filter((f) => f.status === "scheduled" && (f.people.includes(secondPerson) || f.people.includes(firstPerson)))).toEqual([]);
  });

  it("a match already in play is not yet finished, so it is voided too (the same pending rule every format's withdrawal uses)", async () => {
    const r = await rig();
    await playRound(r, 1);
    const live = (await fixtures(r.stageId)).find((f) => f.status === "scheduled" && f.people.includes(r.persons[0]!))!;
    await scoreEvent(r.auth, live.id, { expected_seq: 0, type: "core.start", payload: {} });
    expect((await fixtures(r.stageId)).find((f) => f.id === live.id)!.status, "premise: the match is in play").toBe("in_play");

    const out = await withdrawEntrantCascade(r.auth, r.ids[0]!);
    expect(out.voided).toBeGreaterThan(1);
    expect((await fixtures(r.stageId)).find((f) => f.id === live.id)!.status).toBe("abandoned");
    expect(await abandonRows(live.id)).toEqual(EXPUNGED);
  });

  it("withdrawing the same player twice is refused 409 and voids nothing more", async () => {
    const r = await rig();
    await playRound(r, 1);
    await withdrawEntrantCascade(r.auth, r.ids[0]!);
    const snapshot = await fixtures(r.stageId);
    const err = await withdrawEntrantCascade(r.auth, r.ids[0]!).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(409);
    expect(await fixtures(r.stageId)).toEqual(snapshot);
  });

  it("a player with nothing left to play voids nothing and the policy is none (the empty case)", async () => {
    const r = await rig({ rounds: 1 });
    await playRound(r, 1); // the whole stage is played
    const out = await withdrawEntrantCascade(r.auth, r.ids[0]!);
    expect(out).toMatchObject({ policy: "none", voided: 0, walkovers: 0 });
    expect((await fixtures(r.stageId)).every((f) => f.status === "decided")).toBe(true);
  });

  it("before Start there is nothing to settle: a plain status flip", async () => {
    const r = await rig({ start: false });
    const before = await fixtures(r.stageId);
    const out = await withdrawEntrantCascade(r.auth, r.ids[0]!);
    expect(out).toMatchObject({ policy: "none", voided: 0 });
    expect(await fixtures(r.stageId)).toEqual(before);
  });

  it("a reinstatement flips the status back and does not un-void: the matches stay voided", async () => {
    const r = await rig();
    await playRound(r, 1);
    const out = await withdrawEntrantCascade(r.auth, r.ids[0]!);
    expect(out.voided, "premise: something was voided").toBeGreaterThan(0);
    const voided = await fixtures(r.stageId);
    await patchEntrant(r.auth, r.ids[0]!, { status: "registered" });
    const [e] = await sql<{ status: string }[]>`select status from entrants where id = ${r.ids[0]!}`;
    expect(e!.status).toBe("registered");
    expect(await fixtures(r.stageId), "reinstating does not touch the ledger").toEqual(voided);
  });

  it("a disqualification settles an americano exactly as a withdrawal does", async () => {
    const r = await rig();
    await playRound(r, 1);
    const theirs = (await fixtures(r.stageId)).filter((f) => f.status === "scheduled" && f.people.includes(r.persons[2]!));
    expect(theirs.length, "premise").toBeGreaterThan(0);
    const out = await patchEntrant(r.auth, r.ids[2]!, { status: "disqualified" });
    expect((out as { cascade?: { voided: number; policy: string } }).cascade).toMatchObject({ policy: "expunge", voided: theirs.length });
  });

  it("the pairs of an ordinary player are untouched: another player's unplayed matches keep playing", async () => {
    const r = await rig();
    await playRound(r, 1);
    const before = await fixtures(r.stageId);
    await withdrawEntrantCascade(r.auth, r.ids[0]!);
    const after = await fixtures(r.stageId);
    const bystander = r.persons[7]!;
    const kept = after.filter((f) => f.people.includes(bystander) && !f.people.includes(r.persons[0]!));
    expect(kept.length, "premise: the bystander has matches without the leaver").toBeGreaterThan(0);
    for (const f of kept) expect(f.status).toBe(before.find((b) => b.id === f.id)!.status);
  });
});

describe.skipIf(!HAS_DB)("withdrawing an individual from a mexicano", () => {
  it("control: with nobody withdrawn, round 2 generates once round 1 is played", async () => {
    const r = await rig({ mode: "mexicano", rounds: 3 });
    for (const f of (await fixtures(r.stageId)).filter((x) => x.round_no === 1)) await play(r.auth, f.id, 24, 18);
    await generateStageFixtures(r.auth, r.stageId);
    expect((await fixtures(r.stageId)).filter((f) => f.round_no === 2).length).toBeGreaterThan(0);
  });

  it("voids their match this round and the next round still pairs the remaining field", async () => {
    const r = await rig({ mode: "mexicano", rounds: 3 });
    const round1 = (await fixtures(r.stageId)).filter((f) => f.round_no === 1);
    expect(round1.length, "premise: mexicano generates round 1 only").toBeGreaterThan(0);
    const theirs = round1.find((f) => f.people.includes(r.persons[0]!))!;
    const out = await withdrawEntrantCascade(r.auth, r.ids[0]!);
    expect(out).toMatchObject({ policy: "expunge", voided: 1 });
    expect(await abandonRows(theirs.id), "their round-1 match is expunged").toEqual(EXPUNGED);
    // play the rest of round 1
    for (const f of round1.filter((x) => x.id !== theirs.id)) await play(r.auth, f.id, 24, 18);

    await generateStageFixtures(r.auth, r.stageId);
    const after = await fixtures(r.stageId);
    const round2 = after.filter((f) => f.round_no === 2);
    // The field for round 2 is the 7 who are still in. A match is 4 players (two pairs of two), so the rule - not the
    // generator - says 7 players fill floor(7/4) = 1 match and 3 sit out.
    const activeCount = (await sql<{ n: number }[]>`
      select count(*)::int as n from entrants where division_id = ${r.divisionId} and kind = 'individual' and status in ('registered','confirmed')`)[0]!.n;
    expect(activeCount, "premise: 7 of the 8 are still in").toBe(7);
    expect(round2.length, "7 players fill floor(7/4) matches").toBe(Math.floor(activeCount / 4));
    const playing = new Set(round2.flatMap((f) => f.people));
    expect(playing.size, "each match seats 4 distinct players").toBe(round2.length * 4);
    expect(playing.has(r.persons[0]!), "the withdrawn player is not paired again").toBe(false);
    expect(activeCount - playing.size, "the byes: everyone still in who is not playing").toBe(3);
  });
});
