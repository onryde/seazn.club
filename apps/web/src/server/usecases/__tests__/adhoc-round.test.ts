// W5 app PR A, Task 3 (X-BD-6; RB5-S5, FX-G15) — "Add match" lands in a sensible round, driven through the real usecases on a real
// database: the stage is made by `createStages` + `generateStageFixtures`, the loose match by `addFixture`, the quick-match decider
// by `addQuickMatchDecider`.
//
// Main put an added match at `max(round_no) + 1`: in a league whose a-b match had been voided, the missing match then sat in a
// brand-new round while both sides had a free slot in the round it belonged to. Now the default is the latest round where
// neither side is seated, an explicit round past `max + 1` is refused, and the quick-match decider keeps `max + 1`.
//
// Expected values are the stored lines themselves (the round an a-b line sat in BEFORE it was voided is where the missing match
// belongs: read from the row, never from the usecase under test) and the rulebook's n(n-1)/2 / (n-1)-round shape.
import { randomBytes as kekBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import type { CreateQuickMatch } from "@/server/api-v1/schemas";
import { addFixture } from "../stages";
import { addQuickMatchDecider } from "../quick-match-add";
import { hardDeleteQuickMatchCompetition } from "../quick-match-delete";
import { resolveQuickMatchToken, type QuickMatchRow } from "../quick-match-home";
import { skipQuickMatchFixture } from "../quick-match-skip";
import { hashVisitorKey, mintVisitorKey } from "../quick-match-tokens";
import { withdrawEntrantCascade } from "../withdrawal";
import { startDivision } from "../schedule";
import { createQuickMatchAnyFormat } from "./_quick-match-knockout";
import { BADMINTON, FOOTBALL, lineBetween, refusal, rig, rowsOf } from "./_w5-t3-rig";

vi.stubEnv("DEVICE_LINK_KEK", kekBytes(32).toString("hex")); // every quick-match create seals a secret
vi.mock("@/lib/posthog-server", async (orig) => ({
  ...(await orig<typeof import("@/lib/posthog-server")>()),
  captureServer: vi.fn(),
}));

const HAS_DB = !!process.env.DATABASE_URL;
const quickMatches: string[] = [];

afterAll(async () => {
  vi.unstubAllEnvs();
  if (!HAS_DB) return;
  for (const id of quickMatches) await hardDeleteQuickMatchCompetition(id).catch(() => undefined);
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

let BADMINTON_VARIANT = "";
beforeAll(async () => {
  if (!HAS_DB) return;
  const [row] = await sql<{ key: string }[]>`
    select key from sport_variants where sport_key = 'badminton' and is_system and org_id is null order by key limit 1`;
  if (!row) throw new Error("no system badminton variant: run `npm run sync:sports` against this database");
  BADMINTON_VARIANT = row.key;
});

/** The round of the stored line between two entrants. */
const roundOfLine = (rows: Awaited<ReturnType<typeof rowsOf>>, a: string, b: string) => lineBetween(rows, a, b).round_no;
/** "Not played": the voided state a skipped / called-off line stands in (`cancelled`), set the way the write path leaves it. */
const voidLine = (id: string) => sql`update fixtures set status = 'cancelled' where id = ${id}`;
/** The round the match `addFixture` just wrote sits in. */
async function roundOfFixture(id: string): Promise<number> {
  const [r] = await sql<{ round_no: number }[]>`select round_no from fixtures where id = ${id}`;
  return r!.round_no;
}
const maxRoundOf = (rows: readonly { round_no: number }[]) => rows.reduce((m, r) => Math.max(m, r.round_no), 0);

describe.skipIf(!HAS_DB)("X-BD-6 Add match defaults to the latest round where neither side plays", () => {
  it("X-BD-6 an empty stage takes its first added match in round 1 (the empty case)", async () => {
    const r = await rig({ n: 3, generate: false });
    expect(await rowsOf(r.stageId), "premise: nothing generated").toHaveLength(0);
    const added = await addFixture(r.auth, r.stageId, { home_entrant_id: r.ids[0]!, away_entrant_id: r.ids[1]! });
    expect(await roundOfFixture(added.fixture_id)).toBe(1);
  });

  // differential: today round 6 (ad-hoc.ts `input.round_no ?? maxRound + 1`)
  for (const sport of [BADMINTON, FOOTBALL]) {
    it(`X-BD-6 Add match defaults to the latest round where neither side plays (6 ${sport.key} entrants, a-b voided)`, async () => {
      const r = await rig({ n: 6, sport });
      const [a, b] = [r.ids[0]!, r.ids[1]!];
      const rows = await rowsOf(r.stageId);
      expect(maxRoundOf(rows), "premise: a six-team round robin has 5 rounds (the rulebook's n-1)").toBe(5);
      expect(rows, "premise: and 15 matches (n(n-1)/2)").toHaveLength(15);
      const line = lineBetween(rows, a, b);
      await voidLine(line.id);

      const added = await addFixture(r.auth, r.stageId, { home_entrant_id: a, away_entrant_id: b });
      expect(await roundOfFixture(added.fixture_id), "where the missing match belongs, not round 6").toBe(line.round_no);
      expect(line.round_no, "premise: and that round is not main's answer").not.toBe(maxRoundOf(rows) + 1);
    });
  }

  it("X-BD-6 with two free rounds the LATEST wins, and a second Add match takes the other one (the sequence)", async () => {
    const r = await rig({ n: 6 });
    const [a, b] = [r.ids[0]!, r.ids[1]!];
    const rows = await rowsOf(r.stageId);
    const ab = lineBetween(rows, a, b);
    // a second round where BOTH are free: void a's line and b's line in some other round.
    const other = [1, 2, 3, 4, 5].find((n) => n !== ab.round_no)!;
    const inOther = rows.filter((x) => x.round_no === other && [a, b].some((s) => x.home_entrant_id === s || x.away_entrant_id === s));
    expect(inOther, "premise: a and b each play once in the other round").toHaveLength(2);
    await voidLine(ab.id);
    for (const x of inOther) await voidLine(x.id);

    const free = [ab.round_no, other].sort((x, y) => x - y);
    const first = await addFixture(r.auth, r.stageId, { home_entrant_id: a, away_entrant_id: b });
    expect(await roundOfFixture(first.fixture_id), "the later of the two free rounds").toBe(free[1]);
    const second = await addFixture(r.auth, r.stageId, { home_entrant_id: a, away_entrant_id: b });
    expect(await roundOfFixture(second.fixture_id), "the first add filled its round: the OTHER free round is next").toBe(free[0]);
    const third = await addFixture(r.auth, r.stageId, { home_entrant_id: a, away_entrant_id: b });
    expect(await roundOfFixture(third.fixture_id), "both free rounds are taken: a new round after the last").toBe(maxRoundOf(rows) + 1);
  });

  it("X-BD-6 a round where only ONE side is free is not free: the match goes in a new round", async () => {
    const r = await rig({ n: 6 });
    const [a, b, c] = [r.ids[0]!, r.ids[1]!, r.ids[2]!];
    const rows = await rowsOf(r.stageId);
    if (lineBetween(rows, a, c).round_no === lineBetween(rows, a, b).round_no) throw new Error("premise: the a-c line is not the a-b round");
    await voidLine(lineBetween(rows, a, c).id); // a is free in that round, b still plays someone
    const added = await addFixture(r.auth, r.stageId, { home_entrant_id: a, away_entrant_id: b });
    expect(await roundOfFixture(added.fixture_id)).toBe(maxRoundOf(rows) + 1);
  });

  it("X-BD-6 after a withdrawal: the lines the cascade expunged free their round, and the departed entrant's walkovers do not", async () => {
    // Three entrants: every round seats one pair and gives the third a bye, so once c is out (nothing played: the cascade EXPUNGES
    // c's lines), a and b are both free in each round that held a line of c.
    const r = await rig({ n: 3 });
    const [a, b, c] = [r.ids[0]!, r.ids[1]!, r.ids[2]!];
    await startDivision(r.auth, r.divisionId);
    const rows = await rowsOf(r.stageId);
    const abRound = roundOfLine(rows, a, b);
    await withdrawEntrantCascade(r.auth, c);
    const after = await rowsOf(r.stageId);
    const cLines = after.filter((x) => x.home_entrant_id === c || x.away_entrant_id === c);
    expect(cLines, "premise: c had two lines").toHaveLength(2);
    expect(cLines.map((x) => x.status), "premise: nothing was played, so the cascade expunged them (abandoned), not walked them over").toEqual(["abandoned", "abandoned"]);
    const expectedRounds = [1, 2, 3].filter((n) => n !== abRound); // the two rounds that held a line of c
    expect(expectedRounds).toHaveLength(2);

    const added = await addFixture(r.auth, r.stageId, { home_entrant_id: a, away_entrant_id: b });
    expect(await roundOfFixture(added.fixture_id), "the later round that held a line of c, not a new round 4").toBe(Math.max(...expectedRounds));
  });

  // differential: today accepted (any round_no, however far past the table)
  it("X-BD-6 an explicit round past max + 1 is refused (RR_ADHOC_ROUND_INVALID); max + 1 and an existing round are not", async () => {
    const r = await rig({ n: 4 });
    const [a, b] = [r.ids[0]!, r.ids[1]!];
    const max = maxRoundOf(await rowsOf(r.stageId));
    expect(max, "premise: four entrants play 3 rounds").toBe(3);
    const before = (await rowsOf(r.stageId)).length;

    const err = await refusal(addFixture(r.auth, r.stageId, { home_entrant_id: a, away_entrant_id: b, round_no: max + 2 }));
    expect([err.status, err.code]).toEqual([422, "RR_ADHOC_ROUND_INVALID"]);
    expect((await rowsOf(r.stageId)).length, "a refused add writes nothing").toBe(before);

    const next = await addFixture(r.auth, r.stageId, { home_entrant_id: a, away_entrant_id: b, round_no: max + 1 });
    expect(await roundOfFixture(next.fixture_id), "the new round is allowed").toBe(max + 1);
    const existing = await addFixture(r.auth, r.stageId, { home_entrant_id: a, away_entrant_id: b, round_no: 1 });
    expect(await roundOfFixture(existing.fixture_id), "an organiser's own pick of an existing round is honoured (the form never offers a clash)").toBe(1);
    // the boundary moves with the table: after round max + 1 exists, max + 2 is the next round
    const further = await addFixture(r.auth, r.stageId, { home_entrant_id: a, away_entrant_id: b, round_no: max + 2 });
    expect(await roundOfFixture(further.fixture_id)).toBe(max + 2);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// A quick match's "Add a match" is the same writer with its own, documented rule: "a new round at max(round) + 1" (quick-match-add.ts).
// ---------------------------------------------------------------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("X-BD-6 a quick-match decider still lands at max + 1", () => {
  const SIDES = ["Ravi & Sam", "Priya & Tom"];
  async function plainLeague(): Promise<{ row: QuickMatchRow; competitionId: string }> {
    const input: CreateQuickMatch = {
      name: `QM add ${randomUUID().slice(0, 8)}`,
      sport_key: "badminton",
      variant_key: BADMINTON_VARIANT,
      kind: "pair",
      format: "league",
      sides: SIDES,
      plays: 1,
      email: null,
      locale: "en",
    };
    const out = await createQuickMatchAnyFormat(input, { visitorHash: hashVisitorKey(mintVisitorKey()) });
    quickMatches.push(out.competitionId);
    const row = await resolveQuickMatchToken(out.token);
    if (!row) throw new Error("premise: the quick match does not resolve");
    return { row, competitionId: out.competitionId };
  }
  async function lines(competitionId: string) {
    return sql<{ id: string; stage_id: string; round_no: number; status: string; home_entrant_id: string; away_entrant_id: string }[]>`
      select f.id, f.stage_id, f.round_no, f.status, f.home_entrant_id, f.away_entrant_id
      from fixtures f join divisions d on d.id = f.division_id where d.competition_id = ${competitionId}
      order by f.round_no, f.fixture_no`;
  }

  // The only match is Not played (`cancelled`): both sides are FREE in round 1, which is exactly where a latest-free default would put
  // the decider. The quick match's documented rule keeps it at max + 1.
  // differential: addFixture's own default puts the same pair in round 1 (asserted beside it)
  it("X-BD-6 a quick-match decider still lands at max + 1: round 2 after the one match is Not played, where Add match would say round 1", async () => {
    const { row, competitionId } = await plainLeague();
    const [only] = await lines(competitionId);
    expect(await skipQuickMatchFixture(row, only!.id), "premise: Not played").toEqual({ changed: true });
    expect((await lines(competitionId))[0]!.status).toBe("cancelled");

    const added = await addQuickMatchDecider(row, { home: only!.home_entrant_id, away: only!.away_entrant_id });
    expect(await roundOfFixture(added.fixtureId), "the quick match's documented rule: a new round at max(round) + 1").toBe(only!.round_no + 1);

    // the same state through the organiser's door: the latest FREE round is round 1
    const [again] = (await lines(competitionId)).filter((l) => l.id !== added.fixtureId && l.status === "cancelled");
    expect(again, "premise: the voided line is still the only free slot").toBeDefined();
    const viaAddMatch = await withSystemAuthAddFixture(again!.stage_id, again!.home_entrant_id, again!.away_entrant_id);
    expect(await roundOfFixture(viaAddMatch), "the default `latest_free` takes round 1").toBe(only!.round_no);
  });
});

async function withSystemAuthAddFixture(stageId: string, home: string, away: string): Promise<string> {
  const { systemAuth } = await import("@/lib/quick-match-auth");
  const { fixture_id } = await addFixture(systemAuth(), stageId, { home_entrant_id: home, away_entrant_id: away });
  return fixture_id;
}

