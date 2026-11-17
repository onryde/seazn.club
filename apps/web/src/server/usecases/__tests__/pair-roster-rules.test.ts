// W5 app PR A, Task 10 (X-RP-1..3 ← RB5-R1, RB5-R2, RB5-R3; rulings 282, 290) — what a pair's roster may do once its league has
// started, driven on a real database through `patchEntrant` / `createEntrants` and read back from the stored rows, the score
// ledger and the division ledger.
//
// differential (X-RP-2, X-RP-3): today (87445f7af4) a `members` patch goes straight to `writeEntrantPatch` with no phase check
// (entrants.ts patchEntrant), so after Start a partner can be dropped or swapped with every fixture untouched and the pair still
// seated in the table; no `table_withdrawal` row is written.
//
// Expected values: the rule is the rulebook's (RB5-W2: under half of her scheduled matches played, every result is removed and the
// rest voided; RB5-W3: half or more, results stand and the rest walk over; RB5-R2 the pair withdraws as the entrant and the
// remaining player may enter again in a new pair with a fresh record; RB5-R3 a substitute is refused). The sports are the engine
// registry's own: every module whose entrant model declares `pair` (ruling 290: badminton and tennis follow the same 50 percent
// rule with no sport-specific withdrawal code).
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { effectiveEntrantModel } from "@seazn/engine/sport";
import { sql, withTenant } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { post } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants, getEntrant, patchEntrant } from "../entrants";
import { createPerson } from "../persons";
import { startDivision } from "../schedule";
import { createStages } from "../stages";
import { setTeamSquad } from "../teams";
import { syncEntrantRosterFromSquad } from "../entrants";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

/** Every engine module that declares `pair` entrants (read from the registry, never typed here) and a variant to run it under. */
const PAIR_SPORTS = builtinModules
  .filter((m) => effectiveEntrantModel(m.entrantModel ?? null).kinds.includes("pair"))
  .map((m) => ({ key: m.key, variant: Object.keys(m.variants)[0]! }));
const GENERIC = PAIR_SPORTS.find((s) => s.key === "generic")!;

const member = (person_id: string, is_captain = false) => ({ person_id, is_captain, roles: [] as string[] });

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
const eventCount = async (stageId: string) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from score_events e join fixtures f on f.id = e.fixture_id where f.stage_id = ${stageId}`)[0]!.n;
const withdrawalRows = (divisionId: string) =>
  sql<{ payload: Record<string, unknown> }[]>`
    select payload from division_events where division_id = ${divisionId} and type = 'table_withdrawal' order by seq`;
const statusOf = async (id: string) => (await sql<{ status: string }[]>`select status from entrants where id = ${id}`)[0]!.status;
const rosterOf = async (auth: AuthCtx, id: string): Promise<string[]> =>
  ((await getEntrant(auth, id)).members as { person_id: string }[]).map((m) => m.person_id).sort();

interface Rig {
  auth: AuthCtx;
  divisionId: string;
  stageId: string;
  person: (name: string) => Promise<string>;
  /** Each pair: its entrant id and its two people. */
  pairs: { id: string; a: string; b: string }[];
}

/** A league of `n` pairs (one leg), started unless `start: false`. `kind: "team"` seeds teams of THREE instead (generic only). */
async function rig(sport: { key: string; variant: string }, n: number, opts: { start?: boolean; kind?: "pair" | "team" } = {}): Promise<Rig> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "W5 T10 " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const d = await createDivision(auth, comp.id, { name: "Doubles", slug: "d-" + randomUUID().slice(0, 6), sport_key: sport.key, variant_key: sport.variant, config: {} });
  const person = async (full_name: string) =>
    (await createPerson(auth, { full_name, consent: {}, dob: null, gender: null, external_ref: null })).id;
  const pairs: Rig["pairs"] = [];
  for (let i = 0; i < n; i++) {
    const a = await person(`P${i}a`);
    const b = await person(`P${i}b`);
    const people = opts.kind === "team" ? [a, b, await person(`P${i}c`)] : [a, b];
    const [e] = await createEntrants(auth, d.id, [{ kind: opts.kind ?? "pair", display_name: `Pair ${i + 1}`, seed: i + 1, members: people.map((p) => member(p)) }]);
    pairs.push({ id: e!.id, a, b });
  }
  const [stage] = await createStages(auth, d.id, { seq: 1, kind: "league", name: "Table", config: { legs: 1 }, progression: null });
  if (opts.start !== false) await startDivision(auth, d.id);
  return { auth, divisionId: d.id, stageId: stage!.id, person, pairs };
}

/** `leaver` wins `k` of her lines by an ordinary walkover (the opponent did not turn up): a recorded result RB5-W4 counts. */
async function wins(r: Rig, leaver: string, k: number): Promise<Line[]> {
  const mine = (await linesOf(r.stageId)).filter((l) => involves(l, leaver));
  const played = mine.slice(0, k);
  for (const l of played) {
    const out = await post(r.auth, l.id, "core.forfeit", { by: otherSide(l, leaver), reason: "walkover" });
    expect(out.status, "rig: an ordinary walkover is a recorded result").toBe("forfeited");
  }
  return played;
}

describe.skipIf(!HAS_DB)("X-RP-1 (RB5-R1): one person, one entrant per division — pinned", () => {
  it("X-RP-1 the same person twice is refused: twice in one pair, and as two entrants", async () => {
    // pin, no defect expected: R11 shipped as PERSON_ON_OTHER_TEAM (entrants.ts personOnOtherTeamError); the roster-internal case has its own code.
    const r = await rig(GENERIC, 2);
    const x = await r.person("Xena");
    await expect(
      createEntrants(r.auth, r.divisionId, [{ kind: "pair", display_name: "Xena & Xena", members: [member(x), member(x)] }]),
    ).rejects.toMatchObject({ status: 422, code: "ENTRANT_ROSTER_DUPLICATE_MEMBER" });
    // As two entrants: she is entered alone, then named again by a pair — refused by name, after Start too (the late-entry door).
    await createEntrants(r.auth, r.divisionId, [{ kind: "individual", display_name: "Xena", members: [member(x)] }]);
    await expect(
      createEntrants(r.auth, r.divisionId, [{ kind: "pair", display_name: "Xena & Yan", members: [member(x), member(await r.person("Yan"))] }]),
    ).rejects.toMatchObject({ status: 409, code: "PERSON_ON_OTHER_TEAM" });
  }, 120_000);

  it("X-RP-1 one person in two pairs is refused, before and after Start", async () => {
    // pin, no defect expected.
    for (const start of [false, true]) {
      const r = await rig(GENERIC, 2, { start });
      const [one] = r.pairs;
      const extra = await r.person("Extra");
      await expect(
        createEntrants(r.auth, r.divisionId, [{ kind: "pair", display_name: "Poacher", members: [member(one!.a), member(extra)] }]),
        `start=${start}: a player already on a pair`,
      ).rejects.toMatchObject({ status: 409, code: "PERSON_ON_OTHER_TEAM" });
      // The positive pair: a free pair of strangers is taken (a late entrant once the league runs).
      const fresh = await createEntrants(r.auth, r.divisionId, [
        { kind: "pair", display_name: "Fresh", members: [member(await r.person("F1")), member(await r.person("F2"))] },
      ]);
      expect(fresh, `start=${start}: strangers are taken`).toHaveLength(1);
    }
  }, 120_000);
});

describe.skipIf(!HAS_DB)("X-RP-2 (RB5-R2): a pair that loses a partner after Start withdraws", () => {
  it("anti-vacuity: the registry names pair sports, including the two ruling 290 names", () => {
    expect(PAIR_SPORTS.length).toBeGreaterThanOrEqual(2);
    expect(PAIR_SPORTS.map((s) => s.key)).toEqual(expect.arrayContaining(["badminton", "tennis", "generic"]));
  });

  for (const s of PAIR_SPORTS) {
    it(`X-RP-2 a partner dropped mid-league withdraws the pair under the 50 percent rule: under half expunges, half or more walks over [${s.key}]`, async () => {
      // differential: today the members write succeeds and every fixture is untouched, entrants.ts:974-996.
      let checked = 0;
      for (const [played, policy] of [[1, "expunge"], [2, "walkover"]] as const) {
        const r = await rig(s, 4);
        const leaver = r.pairs[0]!;
        const mine = (await linesOf(r.stageId)).filter((l) => involves(l, leaver.id));
        expect(mine, "rig: in a league of 4 she is scheduled 3 matches").toHaveLength(3);
        const won = await wins(r, leaver.id, played);

        const out = await patchEntrant(r.auth, leaver.id, { members: [member(leaver.a)] });

        expect(await statusOf(leaver.id), `${s.key} ${policy}: the pair withdrew as the entrant`).toBe("withdrawn");
        expect(out.cascade, "the cascade's report rides with the entrant").toMatchObject({ entrant_id: leaver.id, status: "withdrawn" });
        // The pair's record is kept as it was — the pair is the entrant; its roster is history, never rewritten.
        expect(await rosterOf(r.auth, leaver.id), "the roster is not rewritten").toEqual([leaver.a, leaver.b].sort());
        const rows = await withdrawalRows(r.divisionId);
        expect(rows.map((x) => [x.payload.policy, x.payload.played_at_departure, x.payload.scheduled]), `${s.key}: the ledger names the rule`).toEqual([[policy, played, 3]]);
        const after = (await linesOf(r.stageId)).filter((l) => involves(l, leaver.id));
        if (policy === "expunge") {
          for (const l of after) expect([l.status, l.outcome], "removed by the expunge").toEqual(["abandoned", null]);
        } else {
          for (const l of won) expect(after.find((x) => x.id === l.id)!.outcome, "a played result stands").toMatchObject({ kind: "award", winner: leaver.id });
          const owed = after.filter((l) => !won.some((w) => w.id === l.id));
          expect(owed).toHaveLength(1);
          expect(owed[0]!.outcome, "the opponent's walkover").toMatchObject({ kind: "award", winner: otherSide(owed[0]!, leaver.id), loser: leaver.id, reason: "withdrew" });
        }
        // RB5-R2: the remaining player may enter again in a new pair, with a fresh record (a late entrant: she holds no line).
        const [fresh] = await createEntrants(r.auth, r.divisionId, [
          { kind: "pair", display_name: "Remaining & Newcomer", members: [member(leaver.a), member(await r.person("Newcomer"))] },
        ]);
        expect(fresh!.id).not.toBe(leaver.id);
        // The organiser's add into a running league is placed at once (catch-up lines, X-CU-9): one against every pair still in the
        // field, and none against the pair that dissolved — a fresh record, nothing of the old pair's carried over.
        const hers = (await linesOf(r.stageId)).filter((l) => involves(l, fresh!.id));
        expect(hers.map((l) => otherSide(l, fresh!.id)).sort(), "a fresh record: a line against each pair still in the field").toEqual(
          r.pairs.slice(1).map((p) => p.id).sort(),
        );
        checked++;
      }
      expect(checked, "both sides of the 50 percent rule were driven").toBe(2);
    }, 400_000);
  }

  it("X-RP-2 both partners dropped (an emptied roster) withdraws the pair; a second drop is no second withdrawal (the sequence)", async () => {
    const r = await rig(GENERIC, 4);
    const leaver = r.pairs[0]!;
    await wins(r, leaver.id, 1);
    await patchEntrant(r.auth, leaver.id, { members: [] });
    expect(await statusOf(leaver.id)).toBe("withdrawn");
    const events = await eventCount(r.stageId);
    expect(await withdrawalRows(r.divisionId)).toHaveLength(1);
    // She is departed: a later roster edit is REFUSED (the record is frozen, fix round 1 I1), so it settles nothing again and
    // writes no second ledger row.
    await expect(patchEntrant(r.auth, leaver.id, { members: [member(leaver.a)] })).rejects.toMatchObject({ status: 422, code: "RR_SUBSTITUTE_PARTNER_REFUSED" });
    expect(await withdrawalRows(r.divisionId), "no second ledger row").toHaveLength(1);
    expect(await eventCount(r.stageId), "no second settle").toBe(events);
    expect(await statusOf(leaver.id)).toBe("withdrawn");
    expect(await rosterOf(r.auth, leaver.id), "the emptied-roster edit never rewrote the record").toEqual([leaver.a, leaver.b].sort());
  }, 200_000);

  it("X-RP-2 the rest of the patch lands, and a disqualifying patch dissolves the pair as a disqualification", async () => {
    const r = await rig(GENERIC, 4);
    const [p0, p1] = r.pairs;
    await patchEntrant(r.auth, p0!.id, { members: [member(p0!.a)], display_name: "Renamed Pair" });
    expect((await getEntrant(r.auth, p0!.id)).display_name).toBe("Renamed Pair");
    expect(await statusOf(p0!.id)).toBe("withdrawn");
    await patchEntrant(r.auth, p1!.id, { members: [member(p1!.a)], status: "disqualified" });
    expect(await statusOf(p1!.id), "status disqualified is honoured, never turned into withdrawn").toBe("disqualified");
    expect(await withdrawalRows(r.divisionId), "one ledger row per pair").toHaveLength(2);
  }, 200_000);
});

describe.skipIf(!HAS_DB)("X-RP-3 (RB5-R3): a substitute partner is refused", () => {
  for (const s of PAIR_SPORTS) {
    it(`X-RP-3 a substitute partner is refused with the pointer, and nothing is written [${s.key}]`, async () => {
      // differential: today accepted — the roster is rewritten and the pair stays seated, entrants.ts:974-996.
      const r = await rig(s, 4);
      const pair = r.pairs[0]!;
      await wins(r, pair.id, 1);
      const newcomer = await r.person("Substitute");
      const lines = await linesOf(r.stageId);
      const events = await eventCount(r.stageId);

      await expect(patchEntrant(r.auth, pair.id, { members: [member(pair.a), member(newcomer)], display_name: "Should Not Land" })).rejects.toMatchObject({
        status: 422,
        code: "RR_SUBSTITUTE_PARTNER_REFUSED",
        message: "A pair can't change partners once play has started. Withdraw the pair and add a new one.",
      });
      expect(await rosterOf(r.auth, pair.id), "the roster is as it was").toEqual([pair.a, pair.b].sort());
      expect((await getEntrant(r.auth, pair.id)).display_name, "a refused patch writes none of its other fields").toBe("Pair 1");
      expect(await statusOf(pair.id)).not.toBe("withdrawn");
      expect(await linesOf(r.stageId)).toEqual(lines);
      expect(await eventCount(r.stageId)).toBe(events);
      expect(await withdrawalRows(r.divisionId)).toEqual([]);
    }, 200_000);
  }

  it("X-RP-3 every shape of a join is refused: drop-and-add, both swapped, an add to a pair, and a join smuggled in a disqualifying patch", async () => {
    const r = await rig(GENERIC, 4);
    const pair = r.pairs[0]!;
    const n1 = await r.person("N1");
    const n2 = await r.person("N2");
    const refused = { status: 422, code: "RR_SUBSTITUTE_PARTNER_REFUSED" };
    let checked = 0;
    for (const members of [[member(pair.b), member(n1)], [member(n1), member(n2)], [member(pair.a), member(pair.b), member(n1)], [member(n1)]]) {
      // The roster cap (2 for a pair) refuses the 3-person shape first, which is also a refusal and writes nothing; the verdict
      // is the join either way, so the shape asserted is "refused, nothing written" for the first, third excepted below.
      const call = patchEntrant(r.auth, pair.id, { members });
      if (members.length === 3) await expect(call).rejects.toMatchObject({ status: 422 });
      else await expect(call).rejects.toMatchObject(refused);
      checked++;
    }
    await expect(patchEntrant(r.auth, pair.id, { members: [member(pair.a), member(n1)], status: "disqualified" })).rejects.toMatchObject(refused);
    checked++;
    expect(checked).toBe(5);
    expect(await statusOf(pair.id), "none of them took the pair out").toBe("registered");
    expect(await rosterOf(r.auth, pair.id)).toEqual([pair.a, pair.b].sort());
    expect(await withdrawalRows(r.divisionId)).toEqual([]);
  }, 200_000);

  it("X-RP-3 a withdrawn pair cannot come back with a different partner, or with one fewer — but a plain Reinstate still works", async () => {
    const r = await rig(GENERIC, 4);
    const pair = r.pairs[0]!;
    await wins(r, pair.id, 1);
    await patchEntrant(r.auth, pair.id, { members: [member(pair.a)] });
    expect(await statusOf(pair.id)).toBe("withdrawn");
    const newcomer = await r.person("Back-door");
    const refused = { status: 422, code: "RR_SUBSTITUTE_PARTNER_REFUSED" };
    await expect(patchEntrant(r.auth, pair.id, { status: "registered", members: [member(pair.a), member(newcomer)] })).rejects.toMatchObject(refused);
    await expect(patchEntrant(r.auth, pair.id, { status: "registered", members: [member(pair.a)] })).rejects.toMatchObject(refused);
    expect(await statusOf(pair.id), "still withdrawn").toBe("withdrawn");
    // A Reinstate — the status alone — is never blocked by the refusal (it reverses her withdrawal).
    await patchEntrant(r.auth, pair.id, { status: "registered" });
    expect(await statusOf(pair.id)).toBe("registered");
    // ...and the same two people re-saved with a captain, after Start, is no change of partners.
    await patchEntrant(r.auth, pair.id, { members: [member(pair.a, true), member(pair.b)] });
    expect(await rosterOf(r.auth, pair.id)).toEqual([pair.a, pair.b].sort());
  }, 200_000);

  it("X-RP-3 the same two people re-saved after Start (a captain flag, the other order) changes no partner and settles nothing", async () => {
    // pin, no defect expected.
    const r = await rig(GENERIC, 4);
    const pair = r.pairs[0]!;
    await wins(r, pair.id, 1);
    const events = await eventCount(r.stageId);
    await patchEntrant(r.auth, pair.id, { members: [member(pair.b), member(pair.a, true)] });
    await patchEntrant(r.auth, pair.id, { members: [member(pair.b), member(pair.a, true)] });
    expect(await rosterOf(r.auth, pair.id)).toEqual([pair.a, pair.b].sort());
    expect(await statusOf(pair.id)).toBe("registered");
    expect(await eventCount(r.stageId), "no score event written").toBe(events);
    expect(await withdrawalRows(r.divisionId), "no ledger row").toEqual([]);
  }, 200_000);
});

describe.skipIf(!HAS_DB)("X-RP-3 (fix round 1, I1) a withdrawn pair's roster is frozen, so Reinstate restores the pair that left", () => {
  it("dissolve, then a members-only edit of the withdrawn pair is refused (fewer, a substitute, a squad sync), then a plain Reinstate restores the ORIGINAL two-member pair", async () => {
    // differential: at 69e0044f08 a departed pair that stayed departed returned `none`, so the members-only edit was written and
    // the plain Reinstate then put a one-partner or substitute pair back into the started league.
    const r = await rig(GENERIC, 4);
    const pair = r.pairs[0]!;
    await wins(r, pair.id, 1);
    await patchEntrant(r.auth, pair.id, { members: [member(pair.a)] });
    expect(await statusOf(pair.id), "premise: the pair withdrew").toBe("withdrawn");
    const original = [pair.a, pair.b].sort();
    expect(await rosterOf(r.auth, pair.id), "premise: the record stands").toEqual(original);

    const newcomer = await r.person("Frozen Sub");
    let refused = 0;
    for (const members of [[member(pair.a)], [member(pair.a), member(newcomer)], [member(newcomer)], []]) {
      await expect(patchEntrant(r.auth, pair.id, { members })).rejects.toMatchObject({ status: 422, code: "RR_SUBSTITUTE_PARTNER_REFUSED" });
      refused++;
    }
    // A squad sync that would change it is refused too.
    const [{ id: teamId }] = await withTenant(r.auth.orgId, (tx) => tx<{ id: string }[]>`
      insert into teams (org_id, name) values (${r.auth.orgId}, ${"Frozen FC " + randomUUID().slice(0, 6)}) returning id`);
    await sql`update entrants set team_id = ${teamId} where id = ${pair.id}`;
    await setTeamSquad(r.auth, teamId, [member(pair.a), member(newcomer)]);
    await expect(syncEntrantRosterFromSquad(r.auth, pair.id)).rejects.toMatchObject({ status: 422, code: "RR_SUBSTITUTE_PARTNER_REFUSED" });
    refused++;
    expect(refused, "anti-vacuity: five refused edits").toBe(5);
    expect(await rosterOf(r.auth, pair.id), "nothing was written").toEqual(original);

    // The same two people re-saved (a captain flag) is no change of partners, withdrawn or not.
    await patchEntrant(r.auth, pair.id, { members: [member(pair.b), member(pair.a, true)] });
    // A plain Reinstate - the status alone - brings the pair that left back, whole.
    await patchEntrant(r.auth, pair.id, { status: "registered" });
    expect(await statusOf(pair.id)).toBe("registered");
    expect(await rosterOf(r.auth, pair.id), "Reinstate restores the ORIGINAL two-member pair").toEqual(original);
  }, 200_000);
});

describe.skipIf(!HAS_DB)("X-RP-3 the squad sync is the same door (R12)", () => {
  it("X-RP-3 a squad sync that would change a started pair's partner is refused and writes nothing; the same squad re-synced passes", async () => {
    // differential: today the sync rewrites the roster whole with no phase check (entrants.ts syncEntrantRosterFromSquad).
    const r = await rig(GENERIC, 3);
    const pair = r.pairs[0]!;
    const [{ id: teamId }] = await withTenant(r.auth.orgId, (tx) => tx<{ id: string }[]>`
      insert into teams (org_id, name) values (${r.auth.orgId}, ${"Doubles FC " + randomUUID().slice(0, 6)}) returning id`);
    await sql`update entrants set team_id = ${teamId} where id = ${pair.id}`;
    await setTeamSquad(r.auth, teamId, [member(pair.a), member(pair.b)]);
    // The positive pair: the squad still names the same two people.
    await syncEntrantRosterFromSquad(r.auth, pair.id);
    expect(await rosterOf(r.auth, pair.id)).toEqual([pair.a, pair.b].sort());
    // A squad with a newcomer, and a squad with one fewer: both refused, the roster untouched.
    for (const squad of [[pair.a, await r.person("Squad Sub")], [pair.a]]) {
      await setTeamSquad(r.auth, teamId, squad.map((id) => member(id)));
      await expect(syncEntrantRosterFromSquad(r.auth, pair.id)).rejects.toMatchObject({ status: 422, code: "RR_SUBSTITUTE_PARTNER_REFUSED" });
      expect(await rosterOf(r.auth, pair.id)).toEqual([pair.a, pair.b].sort());
    }
    expect(await statusOf(pair.id)).toBe("registered");
  }, 200_000);
});

describe.skipIf(!HAS_DB)("X-RP-2/3 where the rule does not apply (pins)", () => {
  it("before Start a partner change is allowed: swapped, dropped, and re-added — nobody withdraws", async () => {
    // pin, no defect expected: before Start the fixtures are regenerated from the field anyway.
    const r = await rig(GENERIC, 3, { start: false });
    const pair = r.pairs[0]!;
    const newcomer = await r.person("Swap");
    await patchEntrant(r.auth, pair.id, { members: [member(pair.a), member(newcomer)] });
    expect(await rosterOf(r.auth, pair.id)).toEqual([pair.a, newcomer].sort());
    await patchEntrant(r.auth, pair.id, { members: [member(pair.a)] });
    expect(await rosterOf(r.auth, pair.id)).toEqual([pair.a]);
    expect(await statusOf(pair.id), "dropping a partner before Start does not withdraw the pair").toBe("registered");
    expect(await withdrawalRows(r.divisionId)).toEqual([]);
  }, 200_000);

  it("a team of 3+ is not a pair: its roster changes freely after Start", async () => {
    // pin, no defect expected: R12 is about pair entrants; a team's lineup substitution is the lineup work.
    const r = await rig(GENERIC, 3, { kind: "team" });
    const team = r.pairs[0]!;
    const newcomer = await r.person("Sub");
    const [c] = ((await getEntrant(r.auth, team.id)).members as { person_id: string }[]).map((m) => m.person_id).filter((id) => id !== team.a && id !== team.b);
    await patchEntrant(r.auth, team.id, { members: [member(team.a), member(team.b), member(newcomer)] });
    expect(await rosterOf(r.auth, team.id)).toEqual([team.a, team.b, newcomer].sort());
    await patchEntrant(r.auth, team.id, { members: [member(team.a), member(c!)] });
    expect(await rosterOf(r.auth, team.id)).toEqual([team.a, c!].sort());
    expect(await statusOf(team.id)).toBe("registered");
    expect(await withdrawalRows(r.divisionId)).toEqual([]);
  }, 200_000);

  it("a pair in a division with no league or group is not held by R12 (a knockout is another rule)", async () => {
    // pin, no defect expected: the brief scopes R12 to a started ROOT TABLE stage.
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "W5 T10 ko " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
    const d = await createDivision(auth, comp.id, { name: "KO", slug: "ko-" + randomUUID().slice(0, 6), sport_key: GENERIC.key, variant_key: GENERIC.variant, config: {} });
    const person = async (full_name: string) => (await createPerson(auth, { full_name, consent: {}, dob: null, gender: null, external_ref: null })).id;
    const made: { id: string; a: string }[] = [];
    for (let i = 0; i < 4; i++) {
      const a = await person(`K${i}a`);
      const [e] = await createEntrants(auth, d.id, [{ kind: "pair", display_name: `K ${i}`, seed: i + 1, members: [member(a), member(await person(`K${i}b`))] }]);
      made.push({ id: e!.id, a });
    }
    await createStages(auth, d.id, { seq: 1, kind: "knockout", name: "Bracket", config: {}, progression: null });
    await startDivision(auth, d.id);
    const swap = await person("KSwap");
    await patchEntrant(auth, made[0]!.id, { members: [member(made[0]!.a), member(swap)] });
    expect(await rosterOf(auth, made[0]!.id)).toEqual([made[0]!.a, swap].sort());
  }, 200_000);
});
