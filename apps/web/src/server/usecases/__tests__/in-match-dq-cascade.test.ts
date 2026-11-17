// W5 app PR A, Task 8b Part 2 (X-WDT-10 ← RB5-W11 as signed by owner ruling 289; X-RT-1, the engine row amended by 289 to point
// here, G2) — a disqualification recorded DURING a match (the pad's sanction ending: `{sport}.sanction` at an end level, then
// `core.forfeit{by, reason: "disqualified"}`) withdraws the entrant from the stage under the table withdrawal (ruling 259:
// disqualification = withdrawal from that moment; ruling 277: the 50 percent rule).
//
// differential: today (ca679673b6) an in-match disqualification ends that one match and nothing else: the entrant stays in the field,
// her other lines stay scheduled, and she is paired again (ruling 258's complaint). Only the organiser's Entrants → Disqualify
// (`patchEntrant {status: "disqualified"}`) ran the cascade.
//
// Driven through the real doors: the scoring route with a real device link (the pad's own scorer — a link may write only its own
// fixture, so the cascade must not run under it), the organiser's `scoreEvent`, and read back from the stored rows, the score
// ledger and the division ledger. Expected values: RB5-W2 (under half of her scheduled league matches played → every result
// removed, the rest voided), RB5-W3 (half or more → results stand, the rest walk over), RB5-W4 (the disqualifying match is one
// she has PLAYED: it is decided by the forfeit), the Swiss rule (X-SW: a Swiss withdrawal always walks over, owner ruling
// 2026-09-24), a knockout's own forfeit (W4: a bracket fixture's DQ is its walkover; no cascade). End levels are the engine's
// declaration (`sanctionEnding.endLevels`), never typed here. Sports: badminton (BWF black card) and tennis (default).
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import type { AnySportModule } from "@seazn/engine/sport";
import { sql } from "@/lib/db";
import { POST as eventsRoute } from "@/app/api/v1/fixtures/[id]/events/route";
import { requireFixtureActor, type AuthCtx } from "@/server/api-v1/auth";
import { post, tip } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createDeviceLink } from "../device-links";
import { createEntrants, patchEntrant } from "../entrants";
import { startDivision } from "../schedule";
import { createStages, generateStageFixtures } from "../stages";
import { seedOrg } from "./_seed";

vi.stubEnv("DEVICE_LINK_KEK", randomBytes(32).toString("hex"));

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  vi.unstubAllEnvs();
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const moduleOf = (key: string): AnySportModule => builtinModules.find((m) => m.key === key) as AnySportModule;

interface SportCase {
  key: string;
  variant: string;
  /** The level the module declares as ENDING the match (`sanctionEnding.endLevels[0]`), read from the engine. */
  endLevel: string;
  /** One point of play to `side`, in the sport's own event: test input, not an expected value. */
  play: (side: string) => { type: string; payload: unknown };
}
function sportCase(key: string, variant: string, play: SportCase["play"]): SportCase {
  const decl = moduleOf(key).sanctionEnding;
  if (decl === undefined || decl.endLevels.length === 0) throw new Error(`${key} declares no ending sanction`);
  expect(Object.keys(moduleOf(key).variants), `${key} declares ${variant}`).toContain(variant);
  return { key, variant, endLevel: decl.endLevels[0]!, play };
}
const BADMINTON = sportCase("badminton", "bwf", (side) => ({ type: "badminton.rally", payload: { wonBy: side } }));
const TENNIS = sportCase("tennis", "tour", (side) => ({ type: "tennis.point", payload: { by: side } }));

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
const withdrawalRows = (divisionId: string) =>
  sql<{ payload: Record<string, unknown> }[]>`
    select payload from division_events where division_id = ${divisionId} and type = 'table_withdrawal' order by seq`;
const statusOf = async (id: string) => (await sql<{ status: string }[]>`select status from entrants where id = ${id}`)[0]!.status;

interface Rig {
  auth: AuthCtx;
  divisionId: string;
  stageId: string;
  ids: string[];
}

/** `n` entrants P1..Pn in one stage of `kind` (a one-leg league unless stated), started. */
async function started(n: number, s: SportCase, kind: "league" | "swiss" | "knockout" = "league"): Promise<Rig> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "W5 T8b DQ " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const d = await createDivision(auth, comp.id, { name: "Open", slug: "o-" + randomUUID().slice(0, 6), sport_key: s.key, variant_key: s.variant, config: {} });
  const es = await createEntrants(
    auth,
    d.id,
    Array.from({ length: n }, (_, i) => ({ kind: "individual" as const, display_name: `P${i + 1}`, seed: i + 1, members: [] })),
  );
  const config = kind === "league" ? { legs: 1 } : kind === "swiss" ? { rounds: 3 } : {};
  const [stage] = await createStages(auth, d.id, { seq: 1, kind, name: "Stage", config, progression: null } as never);
  await startDivision(auth, d.id);
  if (kind === "swiss") await generateStageFixtures(auth, stage!.id); // Pair round 1
  return { auth, divisionId: d.id, stageId: stage!.id, ids: es.map((e) => e.id) };
}

/** An ordinary walkover (not a withdrawal): `loser` did not turn up — a recorded result RB5-W4 counts as played. */
async function walkoverAgainst(auth: AuthCtx, fixtureId: string, loser: string): Promise<void> {
  const out = await post(auth, fixtureId, "core.forfeit", { by: loser, reason: "walkover" });
  expect(out.status, "rig: an ordinary walkover is a recorded result").toBe("forfeited");
}

type Send = (type: string, payload: unknown) => Promise<{ status: number; code: string | null }>;

/** The organiser on the console: `scoreEvent` with the owner session. */
const organiser = (auth: AuthCtx, fixtureId: string): Send => async (type, payload) => {
  try {
    await post(auth, fixtureId, type, payload);
    return { status: 201, code: null };
  } catch (e) {
    return { status: (e as { status?: number }).status ?? 500, code: (e as { code?: string }).code ?? null };
  }
};

/** The pad's scorer: a real device link for THIS fixture, minted by an editor (issued_by), posting to the real scoring route. */
async function scorer(auth: AuthCtx, fixtureId: string): Promise<Send> {
  const [{ id: issuer }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`issuer-${randomUUID().slice(0, 8)}@test.local`}, 'Issuer', true) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${auth.orgId}, ${issuer}, 'owner')`;
  const link = await createDeviceLink({ ...auth, via: "session", userId: issuer, role: "owner" }, fixtureId, "Court phone");
  const headers = { authorization: `Bearer ${link.secret}`, "content-type": "application/json" };
  const door = await requireFixtureActor(new Request("http://test.local/api/v1", { headers }), fixtureId, "score");
  expect(door.via, "rig: a real device-link AuthCtx").toBe("device_link");
  return async (type, payload) => {
    const res = await eventsRoute(
      new Request(`http://test.local/api/v1/fixtures/${fixtureId}/events`, {
        method: "POST",
        headers,
        body: JSON.stringify({ expected_seq: await tip(fixtureId), type, payload }),
      }),
      { params: Promise.resolve({ id: fixtureId }) },
    );
    const body = (await res.json()) as { ok: boolean; error?: { code: string } };
    return { status: res.status, code: body.ok ? null : body.error!.code };
  };
}

/** The pad's ending, as `runEnding` sends it: the match under way, the end-level sanction, then its ending forfeit. */
async function disqualifyInMatch(r: Rig, s: SportCase, line: Line, victim: string, send: Send): Promise<void> {
  expect((await organiser(r.auth, line.id)("core.start", {})).status, "rig: started").toBe(201);
  const p = s.play(otherSide(line, victim));
  expect((await send(p.type, p.payload)).status, "rig: a point").toBe(201);
  expect((await send(`${s.key}.sanction`, { by: victim, level: s.endLevel })).status, "the sanction").toBe(201);
  expect((await send("core.forfeit", { by: victim, reason: "disqualified" })).status, "its ending").toBe(201);
}

/** League of six (five lines each): the victim P1 has played `k` lines (walkovers she won), then is disqualified in the next. */
async function dqAfter(k: number, s: SportCase, via: "organiser" | "scorer") {
  const r = await started(6, s);
  const v = r.ids[0]!;
  const mine = (await linesOf(r.stageId)).filter((l) => involves(l, v));
  expect(mine, "rig: five lines each in a league of six").toHaveLength(5);
  const played = mine.slice(0, k);
  for (const l of played) await walkoverAgainst(r.auth, l.id, otherSide(l, v));
  const dqLine = mine[k]!;
  const send = via === "organiser" ? organiser(r.auth, dqLine.id) : await scorer(r.auth, dqLine.id);
  await disqualifyInMatch(r, s, dqLine, v, send);
  return { r, v, mine, played, dqLine };
}

describe.skipIf(!HAS_DB)("X-WDT-10 (RB5-W11): an in-match disqualification withdraws the entrant from the stage", () => {
  for (const s of [BADMINTON, TENNIS]) {
    it(`X-WDT-10 an in-match disqualification withdraws the entrant from the league [${s.key}]`, async () => {
      // differential: today only the one match ends.
      const { r, v, mine } = await dqAfter(1, s, "organiser");
      expect(await statusOf(v), "she is disqualified").toBe("disqualified");
      // RB5-W2: the DQ match is decided by its forfeit, so she has played 2 of 5 — under half: every line of hers is removed.
      for (const l of await linesOf(r.stageId)) {
        if (!mine.some((m) => m.id === l.id)) continue;
        expect([l.status, l.outcome, await hasActiveExpunge(l.id)], `line vs ${otherSide(l, v)}`).toEqual(["abandoned", null, true]);
      }
      expect((await withdrawalRows(r.divisionId)).map((x) => [x.payload.policy, x.payload.played_at_departure, x.payload.scheduled])).toEqual([["expunge", 2, 5]]);
    }, 180_000);
  }

  it("X-RT-1 an in-match disqualification's cascade follows X-WDT-1 and X-WDT-2 — the pad's scorer, 2 of 5 and 3 of 5", async () => {
    // differential: today the entrant is untouched.
    // 2 of 5 (1 played + the DQ match): under half, every result removed (X-WDT-1 / RB5-W2).
    {
      const { r, v, mine } = await dqAfter(1, BADMINTON, "scorer");
      expect(await statusOf(v)).toBe("disqualified");
      const after = (await linesOf(r.stageId)).filter((l) => mine.some((m) => m.id === l.id));
      for (const l of after) expect([l.status, l.outcome, await hasActiveExpunge(l.id)], "2 of 5: removed").toEqual(["abandoned", null, true]);
      expect((await withdrawalRows(r.divisionId)).map((x) => [x.payload.policy, x.payload.played_at_departure, x.payload.scheduled])).toEqual([["expunge", 2, 5]]);
    }
    // 3 of 5 (2 played + the DQ match): half or more, results stand and the rest walk over (X-WDT-2 / RB5-W3).
    {
      const { r, v, mine, played, dqLine } = await dqAfter(2, BADMINTON, "scorer");
      expect(await statusOf(v)).toBe("disqualified");
      const after = await linesOf(r.stageId);
      for (const p of played) expect(after.find((l) => l.id === p.id)!.outcome, "a played result stands").toMatchObject({ kind: "award", winner: v });
      expect(after.find((l) => l.id === dqLine.id)!.outcome, "the DQ match stands as the opponent's").toMatchObject({
        kind: "award",
        winner: otherSide(dqLine, v),
        loser: v,
        reason: "disqualified",
      });
      const rest = after.filter((l) => mine.some((m) => m.id === l.id) && l.id !== dqLine.id && !played.some((p) => p.id === l.id));
      expect(rest, "two remaining").toHaveLength(2);
      for (const l of rest) expect(l.outcome, "walked over").toMatchObject({ kind: "award", winner: otherSide(l, v), loser: v, reason: "withdrew" });
      expect((await withdrawalRows(r.divisionId)).map((x) => [x.payload.policy, x.payload.played_at_departure, x.payload.scheduled])).toEqual([["walkover", 3, 5]]);
    }
  }, 300_000);

  it("X-WDT-10 a second forfeit write does not cascade twice", async () => {
    // After the cascade: the organiser takes one expunge back and a second DQ is recorded on that line — no second cascade.
    const { r, v, mine, dqLine } = await dqAfter(2, BADMINTON, "organiser");
    expect((await withdrawalRows(r.divisionId)).length, "premise: one cascade").toBe(1);
    const reopened = (await linesOf(r.stageId)).find((l) => mine.some((m) => m.id === l.id) && l.status === "forfeited" && l.id !== dqLine.id && l.outcome?.reason === "withdrew")!;
    const forfeit = (await activeEvents(reopened.id)).find((e) => e.type === "core.forfeit")!;
    await post(r.auth, reopened.id, "core.void", { event_id: forfeit.id });
    await disqualifyInMatch(r, BADMINTON, reopened, v, organiser(r.auth, reopened.id));
    expect(await withdrawalRows(r.divisionId), "still one ledger row").toHaveLength(1);
    expect(await statusOf(v)).toBe("disqualified");

    // An entrant who already LEFT (an organiser's bare status flip, no cascade — patchEntrant's withdrawn) and is disqualified in a
    // line still open: she is owed nothing (patchEntrant's C6: a departed entrant takes no cascade); her other lines stay.
    const r2 = await started(4, BADMINTON);
    const gone = r2.ids[0]!;
    await patchEntrant(r2.auth, gone, { status: "withdrawn" });
    const hers = (await linesOf(r2.stageId)).filter((l) => involves(l, gone));
    await disqualifyInMatch(r2, BADMINTON, hers[0]!, gone, organiser(r2.auth, hers[0]!.id));
    expect(await statusOf(gone), "no second departure written").toBe("withdrawn");
    expect(await withdrawalRows(r2.divisionId), "no cascade").toEqual([]);
    const others = (await linesOf(r2.stageId)).filter((l) => involves(l, gone) && l.id !== hers[0]!.id);
    expect(others.map((l) => l.status), "her other lines untouched").toEqual(["scheduled", "scheduled"]);
  }, 300_000);

  it("X-WDT-10 Reinstate after an in-match disqualification reverses it, and its re-recorded ending does not disqualify her again", async () => {
    // RB5-W6 (X-WDT-8): Reinstate re-records exactly what the expunge removed — here the DQ match's own sanction and its ending.
    // That re-record is a cascade write: it must not run the cascade again.
    const { r, v, mine, dqLine } = await dqAfter(1, BADMINTON, "organiser");
    expect((await withdrawalRows(r.divisionId)).map((x) => x.payload.policy), "premise: expunged").toEqual(["expunge"]);
    const back = await patchEntrant(r.auth, v, { status: "registered" });
    expect(back.status).toBe("registered");
    expect(await statusOf(v), "she stays reinstated").toBe("registered");
    const after = await linesOf(r.stageId);
    expect(after.find((l) => l.id === dqLine.id)!.outcome, "the DQ match's result is back").toMatchObject({ kind: "award", loser: v, reason: "disqualified" });
    const open = after.filter((l) => mine.some((m) => m.id === l.id) && l.status === "scheduled");
    expect(open, "her three unplayed lines are scheduled again").toHaveLength(3);
    expect((await sql<{ n: number }[]>`select count(*)::int as n from division_events where division_id = ${r.divisionId} and type = 'table_withdrawal'`)[0]!.n, "no second cascade").toBe(1);
  }, 180_000);

  it("X-WDT-10 a Swiss stage: an in-match disqualification withdraws her (the Swiss walkover rule, no table row)", async () => {
    // differential: today she stays in the field and is paired again.
    const r = await started(4, BADMINTON, "swiss");
    const round1 = (await linesOf(r.stageId)).filter((l) => l.home_entrant_id !== null && l.away_entrant_id !== null);
    expect(round1, "rig: round 1 paired").toHaveLength(2);
    const line = round1[0]!;
    const v = line.home_entrant_id!;
    await disqualifyInMatch(r, BADMINTON, line, v, await scorer(r.auth, line.id));
    expect(await statusOf(v), "disqualified from the stage").toBe("disqualified");
    expect((await linesOf(r.stageId)).find((l) => l.id === line.id)!.outcome, "the DQ match stands").toMatchObject({ kind: "award", loser: v, reason: "disqualified" });
    expect(await withdrawalRows(r.divisionId), "a Swiss withdrawal writes no table row (RB5-W7 is league/group)").toEqual([]);
  }, 180_000);

  it("X-WDT-10 a knockout fixture: no cascade (brackets are W4's, unchanged)", async () => {
    // pin, no defect expected: the DQ is the bracket's own forfeit; the entrant is not withdrawn.
    const r = await started(4, BADMINTON, "knockout");
    const line = (await linesOf(r.stageId)).find((l) => l.home_entrant_id !== null && l.away_entrant_id !== null)!;
    const v = line.home_entrant_id!;
    const before = await statusOf(v);
    await disqualifyInMatch(r, BADMINTON, line, v, await scorer(r.auth, line.id));
    expect(await statusOf(v), "status unchanged").toBe(before);
    expect((await linesOf(r.stageId)).find((l) => l.id === line.id)!.outcome).toMatchObject({ kind: "award", loser: v, reason: "disqualified" });
  }, 180_000);
});
