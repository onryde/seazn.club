// W5 app PR A, Task 10b (ruling 292, owner 2026-11-17: "same rule for everywhere") - the pair partner rule is not a league's:
// after Start, in ANY format a pair that loses a partner WITHDRAWS through the cascade, each format's own withdrawal rule
// applying; a substitute partner is refused; the departed pair's roster is frozen. Before Start nothing changes.
//
// differential (every test below): at eb2b12514f `startedTablePair` returned null unless the division had a ROOT league or group
// (`hasRootTableStage`), so in a Swiss, a knockout or a Swiss + knockout division the partner edit was written with every fixture
// untouched and the pair still seated - and a substitute was accepted.
//
// Expected values are the rulebooks', never the code's:
//  - Swiss (W3 R4b, P-A7): the paired undecided board is a WALKOVER to the opponent; a played result stands; the withdrawn entrant
//    is not paired again; Swiss writes no table-withdrawal ledger row (RB5-W7 ledgers league and group only).
//  - Knockout (W4 RB4-V1, RB4-R3): the vacated seat is a walkover to the opponent, who goes on to the next line.
//  - The pair's record is kept as it was (RB5-R2): the pair IS the entrant.
// The sports are the engine registry's own: every module whose entrant model declares `pair`.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { effectiveEntrantModel } from "@seazn/engine/sport";
import { sql, withTenant } from "@/lib/db";
import { CreateStage } from "@/server/api-v1/schemas";
import type { AuthCtx } from "@/server/api-v1/auth";
import { buildTemplateStages } from "@/lib/format-templates";
import { post, rowsOf, type FixtureRow } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import { getCompetitionDesk } from "../competition-desk";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants, getEntrant, patchEntrant, syncEntrantRosterFromSquad } from "../entrants";
import { divisionHistory } from "../history";
import { createPerson } from "../persons";
import { startDivision } from "../schedule";
import { createStages, generateStageFixtures } from "../stages";
import { setTeamSquad } from "../teams";
import { withdrawalOwedSince } from "../withdrawal";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const PAIR_SPORTS = builtinModules
  .filter((m) => effectiveEntrantModel(m.entrantModel ?? null).kinds.includes("pair"))
  .map((m) => ({ key: m.key, variant: Object.keys(m.variants)[0]! }));
const GENERIC = PAIR_SPORTS.find((s) => s.key === "generic")!;
/** The formats ruling 292 widens the rule to (the table formats were Task 10's): a Swiss, a knockout-only division and a mixed
 *  template whose entry stage is NOT a table (swiss_knockout). */
const FORMATS = ["swiss", "knockout", "swiss_knockout"] as const;
type Format = (typeof FORMATS)[number];

const member = (person_id: string, is_captain = false) => ({ person_id, is_captain, roles: [] as string[] });
const REFUSED = { status: 422, code: "RR_SUBSTITUTE_PARTNER_REFUSED" };

interface Rig {
  auth: AuthCtx;
  competitionId: string;
  divisionId: string;
  /** The stage that holds round one: the Swiss, or the bracket. */
  entryStageId: string;
  person: (name: string) => Promise<string>;
  pairs: { id: string; a: string; b: string }[];
}

/** Four pairs (seeds 1-4) in a started division of the given format; a Swiss is paired for round one. */
async function rig(format: Format, sport: { key: string; variant: string }, opts: { start?: boolean } = {}): Promise<Rig> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "W5 T10b " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const d = await createDivision(auth, comp.id, { name: "Doubles", slug: "d-" + randomUUID().slice(0, 6), sport_key: sport.key, variant_key: sport.variant, config: {} });
  const person = async (full_name: string) => (await createPerson(auth, { full_name, consent: {}, dob: null, gender: null, external_ref: null })).id;
  const pairs: Rig["pairs"] = [];
  for (let i = 0; i < 4; i++) {
    const a = await person(`P${i}a`);
    const b = await person(`P${i}b`);
    const [e] = await createEntrants(auth, d.id, [{ kind: "pair", display_name: `Pair ${i + 1}`, seed: i + 1, members: [member(a), member(b)] }]);
    pairs.push({ id: e!.id, a, b });
  }
  let entry: string;
  if (format === "swiss") {
    entry = (await createStages(auth, d.id, { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 2 }, progression: null }))[0]!.id;
  } else if (format === "knockout") {
    entry = (await createStages(auth, d.id, { seq: 1, kind: "knockout", name: "Bracket", config: {}, progression: null }))[0]!.id;
  } else {
    const drafts = buildTemplateStages("swiss_knockout", { swissRounds: 2, poolCount: 2, legs: 1, qualified: 2 });
    expect(drafts.map((x) => x.kind), "premise: the template is a Swiss then a knockout").toEqual(["swiss", "knockout"]);
    const made: { id: string }[] = [];
    for (const [i, x] of drafts.entries()) {
      const input = CreateStage.parse({ seq: i + 1, kind: x.kind, name: x.name, config: x.kind === "swiss" ? { ...x.config, rounds: 2 } : x.config, progression: x.progression });
      made.push((await createStages(auth, d.id, input))[0]!);
    }
    entry = made[0]!.id;
  }
  if (opts.start !== false) {
    await startDivision(auth, d.id);
    if (format !== "knockout") await generateStageFixtures(auth, entry); // Pair round one (startDivision mints the shells)
  }
  return { auth, competitionId: comp.id, divisionId: d.id, entryStageId: entry, person, pairs };
}

const involves = (l: FixtureRow, e: string) => l.home_entrant_id === e || l.away_entrant_id === e;
const otherSide = (l: FixtureRow, e: string) => (l.home_entrant_id === e ? l.away_entrant_id! : l.home_entrant_id!);
const statusOf = async (id: string) => (await sql<{ status: string }[]>`select status from entrants where id = ${id}`)[0]!.status;
const rosterOf = async (auth: AuthCtx, id: string): Promise<string[]> => ((await getEntrant(auth, id)).members as { person_id: string }[]).map((m) => m.person_id).sort();
const ledger = (divisionId: string, type: string) =>
  sql<{ payload: Record<string, unknown> }[]>`select payload from division_events where division_id = ${divisionId} and type = ${type} order by seq`;
const eventCount = async (stageId: string) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from score_events e join fixtures f on f.id = e.fixture_id where f.stage_id = ${stageId}`)[0]!.n;
const lineOf = async (stageId: string, e: string) => {
  const mine = (await rowsOf(stageId)).filter((l) => involves(l, e) && l.home_entrant_id !== null && l.away_entrant_id !== null);
  expect(mine.length, "rig: she holds a seated line in the entry stage").toBeGreaterThan(0);
  return mine[0]!;
};

describe.skipIf(!HAS_DB)("ruling 292: one partner rule in every format after Start", () => {
  it("anti-vacuity: the registry names pair sports and the sweep covers three formats", () => {
    expect(PAIR_SPORTS.length).toBeGreaterThanOrEqual(2);
    expect(PAIR_SPORTS.map((s) => s.key)).toEqual(expect.arrayContaining(["badminton", "tennis", "generic"]));
    expect(FORMATS).toHaveLength(3);
  });

  for (const format of FORMATS) {
    for (const s of PAIR_SPORTS) {
      it(`ruling 292: a started ${format} refuses a substitute, withdraws a pair that loses a partner by that format's own rule, and freezes the departed pair [${s.key}]`, async () => {
        // differential: today the edit is allowed outside a root table (entrants.ts startedTablePair).
        const r = await rig(format, s);
        const leaver = r.pairs[3]!;
        const other = r.pairs[0]!;
        const before = await rowsOf(r.entryStageId);
        const hers = await lineOf(r.entryStageId, leaver.id);
        const opponent = otherSide(hers, leaver.id);

        // 1. A substitute partner is refused (R12a), nothing written - on a pair that is not the leaver's.
        const events = await eventCount(r.entryStageId);
        const newcomer = await r.person("Substitute");
        await expect(patchEntrant(r.auth, other.id, { members: [member(other.a), member(newcomer)], display_name: "Should Not Land" })).rejects.toMatchObject({
          ...REFUSED,
          message: "A pair can't change partners once play has started. Withdraw the pair and add a new one.",
        });
        expect(await rosterOf(r.auth, other.id), "the roster is as it was").toEqual([other.a, other.b].sort());
        expect((await getEntrant(r.auth, other.id)).display_name).toBe("Pair 1");
        expect(await statusOf(other.id)).toBe("registered");
        expect(await rowsOf(r.entryStageId), "no fixture changed").toEqual(before);
        expect(await eventCount(r.entryStageId)).toBe(events);

        // 2. A partner who leaves with nobody joining withdraws the pair through the cascade.
        const out = await patchEntrant(r.auth, leaver.id, { members: [member(leaver.a)] });
        expect(await statusOf(leaver.id), "the pair withdrew as the entrant").toBe("withdrawn");
        expect(out.cascade, "the cascade's report rides with the entrant").toMatchObject({ entrant_id: leaver.id, status: "withdrawn" });
        expect(await rosterOf(r.auth, leaver.id), "the record is kept, never rewritten").toEqual([leaver.a, leaver.b].sort());
        expect(await ledger(r.divisionId, "table_withdrawal"), `${format} writes no table-withdrawal row (RB5-W7)`).toEqual([]);

        // 3. That format's own outcome: her seated line is a walkover to the opponent (W3 R4b; W4 RB4-V1).
        const after = await rowsOf(r.entryStageId);
        const line = after.find((l) => l.id === hers.id)!;
        expect(line.status, `${format}: a walkover, not a void`).toBe("forfeited");
        expect(line.outcome).toMatchObject({ kind: "award", winner: opponent, loser: leaver.id, reason: "withdrew" });
        if (format === "knockout") {
          // RB4-V1 / RB4-R3: the opponent goes on - seated in the next line, the leaver in none.
          const next = after.find((l) => l.id === hers.winner_to_fixture);
          expect(next, "the line has a next line").toBeDefined();
          expect([next!.home_entrant_id, next!.away_entrant_id], "the opponent goes on").toContain(opponent);
          expect(after.filter((l) => l.round_no > hers.round_no).some((l) => involves(l, leaver.id)), "she is seated in no later line").toBe(false);
        } else {
          // W3 P-A7: not paired again. The other board is played out by an ordinary walkover (a result that STANDS), Pair next
          // seats round two without her.
          const rest = after.filter((l) => l.round_no === 1 && l.id !== hers.id && l.home_entrant_id !== null && l.away_entrant_id !== null);
          expect(rest.length, "rig: round one has another board").toBeGreaterThan(0);
          for (const l of rest) await post(r.auth, l.id, "core.forfeit", { by: l.away_entrant_id, reason: "walkover" });
          await generateStageFixtures(r.auth, r.entryStageId);
          const r2 = (await rowsOf(r.entryStageId)).filter((l) => l.round_no === 2);
          expect(r2.length, "round two is paired").toBeGreaterThan(0);
          expect(r2.some((l) => involves(l, leaver.id)), "the withdrawn pair is not paired again (P-A7)").toBe(false);
          const stood = (await rowsOf(r.entryStageId)).find((l) => l.id === rest[0]!.id)!;
          expect(stood.outcome, "a played result stands").toMatchObject({ kind: "award", reason: "walkover" });
        }

        // 4. The departed pair's roster is FROZEN: fewer, a substitute, both gone, and a squad sync that would change it.
        const frozen = await eventCount(r.entryStageId);
        let refused = 0;
        for (const members of [[member(leaver.a)], [member(leaver.a), member(newcomer)], [member(newcomer)], []]) {
          await expect(patchEntrant(r.auth, leaver.id, { members })).rejects.toMatchObject(REFUSED);
          refused++;
        }
        const [{ id: teamId }] = await withTenant(r.auth.orgId, (tx) => tx<{ id: string }[]>`
          insert into teams (org_id, name) values (${r.auth.orgId}, ${"FC " + randomUUID().slice(0, 6)}) returning id`);
        await sql`update entrants set team_id = ${teamId} where id = ${leaver.id}`;
        await setTeamSquad(r.auth, teamId, [member(leaver.a), member(newcomer)]);
        await expect(syncEntrantRosterFromSquad(r.auth, leaver.id)).rejects.toMatchObject(REFUSED);
        refused++;
        expect(refused, "anti-vacuity: five refused edits of the departed pair").toBe(5);
        expect(await rosterOf(r.auth, leaver.id), "nothing was written").toEqual([leaver.a, leaver.b].sort());
        expect(await eventCount(r.entryStageId), "no second settle").toBe(frozen);
      }, 400_000);
    }
  }

  for (const format of FORMATS) {
    it(`ruling 292 pin: before Start a partner change is free in a ${format} - swapped, dropped, nobody withdraws`, async () => {
      // pin, no defect expected: before Start the fixtures are redrawn from the field anyway.
      const r = await rig(format, GENERIC, { start: false });
      const pair = r.pairs[0]!;
      const newcomer = await r.person("Swap");
      await patchEntrant(r.auth, pair.id, { members: [member(pair.a), member(newcomer)] });
      expect(await rosterOf(r.auth, pair.id)).toEqual([pair.a, newcomer].sort());
      await patchEntrant(r.auth, pair.id, { members: [member(pair.a)] });
      expect(await rosterOf(r.auth, pair.id)).toEqual([pair.a]);
      expect(await statusOf(pair.id), "dropping a partner before Start does not withdraw the pair").toBe("registered");
      expect(await ledger(r.divisionId, "table_withdrawal")).toEqual([]);
    }, 200_000);
  }

  it("ruling 292 pin: a team of 3+ is not a pair - its roster changes freely after Start, in a Swiss and a knockout", async () => {
    // pin, no defect expected: R12 is about pair entrants; a team's lineup substitution is the lineup work.
    let checked = 0;
    for (const format of ["swiss", "knockout"] as const) {
      const r = await rig(format, GENERIC);
      const team = r.pairs[1]!;
      await sql`update entrants set kind = 'team' where id = ${team.id}`;
      const newcomer = await r.person("Sub");
      await patchEntrant(r.auth, team.id, { members: [member(team.a), member(newcomer)] });
      expect(await rosterOf(r.auth, team.id), `${format}: a team takes a substitute`).toEqual([team.a, newcomer].sort());
      expect(await statusOf(team.id)).toBe("registered");
      checked++;
    }
    expect(checked).toBe(2);
  }, 300_000);
});

describe.skipIf(!HAS_DB)("ruling 292: Reinstate leaves a trace in every format (the closed 8b limit)", () => {
  it("a Swiss pair dissolved then Reinstated is not owed; a LATER trigger is owed again; the trace is not a history entry; a second edit and a second dissolve work", async () => {
    // differential: `withdrawalOwedSince` learned of a Reinstate only from a `table_withdrawal_voided` row, which a Swiss or knockout
    // cascade never writes - so a finished then Reinstated Swiss pair read as owed.
    const r = await rig("swiss", GENERIC);
    const pair = r.pairs[3]!;
    const owed = (at: Date) => withTenant(r.auth.orgId, (tx) => withdrawalOwedSince(tx, r.divisionId, pair.id, at));
    const t0 = new Date(Date.now() - 60_000);

    // The empty case: nothing was ever reinstated.
    expect(await ledger(r.divisionId, "withdrawal_reinstated"), "no trace before any Reinstate").toEqual([]);
    expect(await owed(t0), "in the field, no cascade run, not reinstated: owed (the trigger is still outstanding)").toBe(true);

    // Another entrant's Reinstate is no evidence about THIS pair (the trace names its entrant).
    const bystander = r.pairs[1]!;
    await patchEntrant(r.auth, bystander.id, { members: [member(bystander.a)] });
    await patchEntrant(r.auth, bystander.id, { status: "registered" });
    expect((await ledger(r.divisionId, "withdrawal_reinstated")).map((x) => x.payload), "premise: only the bystander has a trace").toEqual([{ entrant_id: bystander.id }]);
    expect(await owed(t0), "a bystander's Reinstate does not clear her").toBe(true);

    await patchEntrant(r.auth, pair.id, { members: [member(pair.a)] });
    expect(await statusOf(pair.id)).toBe("withdrawn");
    expect(await owed(t0), "departed: done").toBe(false);

    await patchEntrant(r.auth, pair.id, { status: "registered" });
    expect(await statusOf(pair.id), "Reinstated").toBe("registered");
    expect((await ledger(r.divisionId, "withdrawal_reinstated")).map((x) => x.payload), "a durable trace naming her, after the bystander's").toEqual([{ entrant_id: bystander.id }, { entrant_id: pair.id }]);
    expect(await owed(t0), "THE LIMIT: a Reinstated pair whose cascade wrote no table row is not owed").toBe(false);
    expect(await owed(new Date(Date.now() + 60_000)), "a trigger AFTER the Reinstate is owed again while she is in the field").toBe(true);

    // The internal row is not a history entry (Task 8b's filter), and Undo steps over it.
    const listed = (await divisionHistory(r.auth, r.divisionId)).events.map((e) => e.type);
    expect(listed.filter((t) => t === "withdrawal_reinstated"), "never listed").toEqual([]);

    // A second edit: the same two people re-saved is no change; a substitute is still refused; a second drop dissolves again.
    await patchEntrant(r.auth, pair.id, { members: [member(pair.b), member(pair.a, true)] });
    await expect(patchEntrant(r.auth, pair.id, { members: [member(pair.a), member(await r.person("Late Sub"))] })).rejects.toMatchObject(REFUSED);
    await patchEntrant(r.auth, pair.id, { members: [member(pair.b)] });
    expect(await statusOf(pair.id), "a second dissolve").toBe("withdrawn");
    await patchEntrant(r.auth, pair.id, { status: "registered" });
    expect((await ledger(r.divisionId, "withdrawal_reinstated")).length, "one trace per Reinstate").toBe(3);
  }, 300_000);

  for (const format of FORMATS) {
    it(`ruling 292: a Reinstated ${format} pair reads as done on the desk (not "withdrawal did not finish")`, async () => {
      // The desk lists a started division's departed-after-trigger pair as owed only while she is in the field with no Reinstate on
      // record; a Reinstate that left no trace (Swiss, knockout) read as owed.
      const r = await rig(format, GENERIC);
      const pair = r.pairs[3]!;
      await sql`insert into division_events (division_id, seq, type, payload)
        select ${r.divisionId}, coalesce(max(seq), 0) + 1, 'pair_dissolve_owed', ${sql.json({ entrant_id: pair.id, registration_id: randomUUID() })}
          from division_events where division_id = ${r.divisionId}`;
      const attention = async () =>
        ((await getCompetitionDesk(r.auth, r.competitionId)).divisions.get(r.divisionId)?.attention ?? []).filter((a) => a.kind === "withdrawal_owed");
      expect(await attention(), "premise: a marker with the pair still in the field is owed").toEqual([{ kind: "withdrawal_owed", count: 1, names: ["Pair 4"] }]);
      await patchEntrant(r.auth, pair.id, { members: [member(pair.a)] });
      expect(await attention(), "dissolved: done").toEqual([]);
      await patchEntrant(r.auth, pair.id, { status: "registered" });
      expect(await attention(), "Reinstated: the organiser's last word, not owed").toEqual([]);
    }, 300_000);
  }
});
