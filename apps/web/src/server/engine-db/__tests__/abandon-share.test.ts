// W2c Task 7 (CA-AB-2, GN-AB-2; owner P-5; review I6) - "share the points" on an abandon, at the layers the engine unit
// test cannot see. The engine folds a shared abandon to a draw; whether the SERVER takes it is two separate gates, and each
// is tested where it lives:
//   - the SAVE: `patchDivision` parses the division cfg through the sport's own schema, so a cfg that shares points without
//     allowing draws is refused CONFIG_INVALID with the owner's wording and nothing is written;
//   - the APPEND: a draw the stage's cfg does not support is DRAW_NOT_ALLOWED, so the fold and that gate must agree on a
//     shared draw (and a cfg that got past the save, by a direct write, still cannot record one).
// Real Postgres (callers skip without DATABASE_URL). Expected values are the rule rows (GN-AB-1/2, CA-AB-1/2) and the
// owner's wording, never the code under test.
import { afterAll, describe, expect, it } from "vitest";
import { BRACKET_KINDS, DRAW_KINDS, StageKind } from "@seazn/engine/core";
import { sql } from "@/lib/db";
import { appendEvent } from "@/server/engine-db";
import { patchDivision } from "@/server/usecases/divisions";
import { seedBracket } from "./helpers/seed-bracket";

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

/** The owner's wording (P-5), as signed in the rule row GN-AB-2. */
const SHARE_NEEDS_DRAWS = "Sharing the points needs draws to be allowed.";
/** Carrom's refusal (P-5 fix round 1, owner ruling): it names the setting to change. */
const SHARE_NEEDS_DRAWN_GAME = "Sharing the points needs a drawn game to be possible — set 'Game tied at max boards' to 'Drawn game' first.";

type Fx = { status: string; outcome: { kind: string } | null; home: string; away: string };
const fx = async (id: string) =>
  (await sql<Fx[]>`select status, outcome, home_entrant_id as home, away_entrant_id as away from fixtures where id = ${id}`)[0]!;
const configOf = async (divisionId: string) => (await sql<{ config: Record<string, unknown> }[]>`select config from divisions where id = ${divisionId}`)[0]!.config;
/** The division's cfg with `extra` merged in by a DIRECT write - the stand-in for a division form save with a value that
 *  save accepts, or (with a value it refuses) for a cfg that got in around the save. Before the first event, so the fixture
 *  freezes it. */
const setConfig = (divisionId: string, extra: Record<string, unknown>) =>
  sql`update divisions set config = config || ${sql.json(extra as never)} where id = ${divisionId}`;

async function liveGeneric(extra: Record<string, unknown>) {
  const b = await seedBracket({ sport: "generic", variant: "score", stageKind: "league", entrants: 2 });
  await setConfig(b.divisionId, extra);
  const id = b.fixtureIds[0]!;
  const f = await fx(id);
  await appendEvent(b.auth.orgId, id, 0, { type: "core.start", payload: {} });
  await appendEvent(b.auth.orgId, id, 1, { type: "generic.score", payload: { by: f.home, points: 2 } });
  await appendEvent(b.auth.orgId, id, 2, { type: "generic.score", payload: { by: f.away, points: 1 } });
  return { b, id, f };
}

async function liveCarrom(extra: Record<string, unknown>) {
  const b = await seedBracket({ sport: "carrom", variant: "icf", stageKind: "league", entrants: 2 });
  await setConfig(b.divisionId, extra);
  const id = b.fixtureIds[0]!;
  await appendEvent(b.auth.orgId, id, 0, { type: "core.start", payload: {} });
  return { b, id };
}

describe.skipIf(!HAS_DB)("GN-AB-2 CA-AB-2 share at append time (review I6)", () => {
  it("empty case first: with no policy an abandon is a replay (GN-AB-1) - abandoned, nobody decided - and voiding it resumes play", async () => {
    const { b, id } = await liveGeneric({});
    await appendEvent(b.auth.orgId, id, 3, { type: "core.abandon", payload: { reason: "weather" } });
    expect(await fx(id)).toMatchObject({ status: "abandoned", outcome: null });
    const [abandon] = await sql<{ id: string }[]>`select id from score_events where fixture_id = ${id} and type = 'core.abandon'`;
    await appendEvent(b.auth.orgId, id, 4, { type: "core.void", payload: {}, voids: abandon!.id });
    expect(await fx(id)).toMatchObject({ status: "in_play", outcome: null });
  });

  it("GN-AB-2: allowDraws on - a 2-1 abandon under share is accepted as a draw and decided", async () => {
    const { b, id } = await liveGeneric({ allowDraws: true, abandonPolicy: "share" });
    await appendEvent(b.auth.orgId, id, 3, { type: "core.abandon", payload: { reason: "weather" } });
    expect(await fx(id)).toMatchObject({ status: "decided", outcome: { kind: "draw" } });
  });

  it("GN-AB-2: a cfg that reached the ledger around the save (draws off, share on) still cannot record the draw - DRAW_NOT_ALLOWED, ledger untouched", async () => {
    const { b, id } = await liveGeneric({ allowDraws: false, abandonPolicy: "share" });
    const before = (await sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${id}`)[0]!.n;
    await expect(appendEvent(b.auth.orgId, id, 3, { type: "core.abandon", payload: { reason: "weather" } })).rejects.toMatchObject({ code: "DRAW_NOT_ALLOWED" });
    expect((await sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${id}`)[0]!.n).toBe(before);
  });

  it("CA-AB-2: carrom with the house draw rule - an abandon under share is accepted as a draw and decided", async () => {
    const { b, id } = await liveCarrom({ tieBoard: "draw", abandonPolicy: "share" });
    await appendEvent(b.auth.orgId, id, 1, { type: "core.abandon", payload: { reason: "weather" } });
    expect(await fx(id)).toMatchObject({ status: "decided", outcome: { kind: "draw" } });
  });

  it("CA-AB-2: carrom under ICF play (tieBoard extra) is the case the save refuses; around the save the draw is DRAW_NOT_ALLOWED", async () => {
    const { b, id } = await liveCarrom({ tieBoard: "extra", abandonPolicy: "share" });
    await expect(appendEvent(b.auth.orgId, id, 1, { type: "core.abandon", payload: { reason: "weather" } })).rejects.toMatchObject({ code: "DRAW_NOT_ALLOWED" });
  });
});

describe.skipIf(!HAS_DB)("a shared abandon is a RESULT the table credits - the organiser's settle (X-AB-5) must not turn it into a win", () => {
  /** A settle on `id` naming its home side the winner, as the organiser would send it. */
  const settleHome = async (orgId: string, id: string, atSeq: number) => {
    const f = await fx(id);
    return appendEvent(orgId, id, atSeq, { type: "core.settle", payload: { winner: f.home, method: "organiser" } });
  };

  it("GN-AB-2: generic, 2-1 abandoned under share (a draw) - a settle is refused not_bracket and the draw and its status stand", async () => {
    const { b, id } = await liveGeneric({ allowDraws: true, abandonPolicy: "share" });
    await appendEvent(b.auth.orgId, id, 3, { type: "core.abandon", payload: { reason: "weather" } });
    expect(await fx(id)).toMatchObject({ status: "decided", outcome: { kind: "draw" } });
    await expect(settleHome(b.auth.orgId, id, 4)).rejects.toMatchObject({ code: "SETTLE_NOT_APPLICABLE", data: { reason: "not_bracket" } });
    expect(await fx(id), "the shared points were not rewritten into a win").toMatchObject({ status: "decided", outcome: { kind: "draw" } });
  });

  it("CA-AB-2: carrom (house draw rule), abandoned under share - the same refusal", async () => {
    const { b, id } = await liveCarrom({ tieBoard: "draw", abandonPolicy: "share" });
    await appendEvent(b.auth.orgId, id, 1, { type: "core.abandon", payload: { reason: "weather" } });
    expect(await fx(id)).toMatchObject({ status: "decided", outcome: { kind: "draw" } });
    await expect(settleHome(b.auth.orgId, id, 2)).rejects.toMatchObject({ code: "SETTLE_NOT_APPLICABLE", data: { reason: "not_bracket" } });
    expect(await fx(id)).toMatchObject({ status: "decided", outcome: { kind: "draw" } });
  });

  it("the negative pair: the same generic stage with NO policy - the abandon decides nobody, and the settle is accepted", async () => {
    const { b, id } = await liveGeneric({ allowDraws: true });
    await appendEvent(b.auth.orgId, id, 3, { type: "core.abandon", payload: { reason: "weather" } });
    expect(await fx(id)).toMatchObject({ status: "abandoned", outcome: null });
    await settleHome(b.auth.orgId, id, 4);
    expect(await fx(id)).toMatchObject({ status: "decided", outcome: { kind: "win" } });
  });
});

describe.skipIf(!HAS_DB)("P-5 the save refuses share without draws, with the owner's wording, and writes nothing", () => {
  /** `{ code, data.issues }` of the refusal a save of `config` over the division gets, or null when it saved. */
  async function refusalOf(auth: Parameters<typeof patchDivision>[0], divisionId: string, config: Record<string, unknown>) {
    return patchDivision(auth, divisionId, { config } as never).then(
      () => null,
      (e: unknown) => e as { code: string; data: { issues: { message: string; path: string[] }[] } },
    );
  }

  it("P-5 generic: allowDraws off + share is CONFIG_INVALID on the abandonPolicy field, the stored cfg is unchanged; the same save with draws allowed saves", async () => {
    const b = await seedBracket({ sport: "generic", variant: "score", stageKind: "league", entrants: 2 });
    const before = await configOf(b.divisionId);
    const refusal = await refusalOf(b.auth, b.divisionId, { ...before, allowDraws: false, abandonPolicy: "share" });
    expect(refusal, "the save must be refused").not.toBeNull();
    expect(refusal!.code).toBe("CONFIG_INVALID");
    expect(refusal!.data.issues.map((i) => [i.message, i.path])).toEqual([[SHARE_NEEDS_DRAWS, ["abandonPolicy"]]]);
    expect(await configOf(b.divisionId), "nothing was written").toEqual(before);
    // The positive pair: the same write with draws allowed saves, and the policy is stored.
    expect(await refusalOf(b.auth, b.divisionId, { ...before, allowDraws: true, abandonPolicy: "share" })).toBeNull();
    expect(await configOf(b.divisionId)).toMatchObject({ allowDraws: true, abandonPolicy: "share" });
  });

  it("P-5 carrom: share under tieBoard extra is refused the same way; with tieBoard draw it saves", async () => {
    const b = await seedBracket({ sport: "carrom", variant: "icf", stageKind: "league", entrants: 2 });
    const before = await configOf(b.divisionId);
    const refusal = await refusalOf(b.auth, b.divisionId, { ...before, tieBoard: "extra", abandonPolicy: "share" });
    expect(refusal, "the save must be refused").not.toBeNull();
    expect(refusal!.code).toBe("CONFIG_INVALID");
    expect(refusal!.data.issues.map((i) => [i.message, i.path])).toEqual([[SHARE_NEEDS_DRAWN_GAME, ["abandonPolicy"]]]);
    expect(await configOf(b.divisionId), "nothing was written").toEqual(before);
    expect(await refusalOf(b.auth, b.divisionId, { ...before, tieBoard: "draw", abandonPolicy: "share" })).toBeNull();
    expect(await configOf(b.divisionId)).toMatchObject({ tieBoard: "draw", abandonPolicy: "share" });
  });
});

// I3 (owner ruling, fix round 1): `share` is a TABLE-stage policy. A shared abandon is a drawn result, and a bracket
// forbids a level result (someone must advance), so in a bracket stage the policy is IGNORED: an abandon follows W2a (held,
// ruling 72) and the organiser's settle decides it. The abandon itself is never refused. Before this, generic refused the
// abandon (LEVEL_RESULT_IN_BRACKET) and carrom recorded a draw in a bracket.
describe.skipIf(!HAS_DB)("I3 share applies in table stages only: every stage kind, generic and carrom", () => {
  const KIND_CONFIG: Partial<Record<(typeof StageKind.options)[number], { entrants: number; stageConfig?: Record<string, unknown> }>> = {
    swiss: { entrants: 4, stageConfig: { rounds: 3 } },
    americano: { entrants: 8, stageConfig: { mode: "americano", courtCount: 2, rounds: 3 } },
  };
  const sports = [
    { key: "generic", variant: "score", share: { allowDraws: true, abandonPolicy: "share" } },
    { key: "carrom", variant: "icf", share: { tieBoard: "draw", abandonPolicy: "share" } },
  ] as const;

  /** The first seated board of a stage of `kind`, started, with `share` applied to the division cfg and, for generic, a
   *  2-1 score on it - so the abandon is of a match that is not level (a bare share-draw would not be a draw of two
   *  equals, and the replay/share difference must be visible). */
  async function board(sport: (typeof sports)[number], kind: (typeof StageKind.options)[number]) {
    const k = KIND_CONFIG[kind] ?? { entrants: 4 };
    const b = await seedBracket({ sport: sport.key, variant: sport.variant, stageKind: kind, entrants: k.entrants, ...(k.stageConfig ? { stageConfig: k.stageConfig } : {}) });
    await setConfig(b.divisionId, sport.share);
    const id = b.fixtureIds[0]!;
    const f = await fx(id);
    await appendEvent(b.auth.orgId, id, 0, { type: "core.start", payload: {} });
    let seq = 1;
    if (sport.key === "generic") {
      await appendEvent(b.auth.orgId, id, seq++, { type: "generic.score", payload: { by: f.home, points: 2 } });
      await appendEvent(b.auth.orgId, id, seq++, { type: "generic.score", payload: { by: f.away, points: 1 } });
    }
    return { b, id, f, seq };
  }

  it("every BRACKET kind: the share policy is ignored - the abandon is ACCEPTED and held (outcome null, never a draw), and the settle decides it", async () => {
    let checked = 0;
    for (const sport of sports)
      for (const kind of BRACKET_KINDS) {
        const { b, id, f, seq } = await board(sport, kind);
        await appendEvent(b.auth.orgId, id, seq, { type: "core.abandon", payload: { reason: "weather" } }).catch((e: unknown) => {
          throw new Error(`${sport.key} ${kind}: the abandon itself was refused: ${(e as { code?: string }).code ?? String(e)}`);
        });
        expect(await fx(id), `${sport.key} ${kind}: held, nobody decided`).toMatchObject({ status: "abandoned", outcome: null });
        await appendEvent(b.auth.orgId, id, seq + 1, { type: "core.settle", payload: { winner: f.home, method: "organiser" } });
        expect(await fx(id), `${sport.key} ${kind}: the organiser's settle seats a winner`).toMatchObject({ status: "decided", outcome: { kind: "win" } });
        checked++;
      }
    expect(checked).toBe(sports.length * BRACKET_KINDS.size);
    expect(checked).toBeGreaterThan(0);
  }, 600_000);

  it("the positive pair - every TABLE kind keeps the policy: the same abandon under share is a drawn result the table credits", async () => {
    let checked = 0;
    for (const sport of sports)
      for (const kind of DRAW_KINDS) {
        const { b, id, seq } = await board(sport, kind);
        await appendEvent(b.auth.orgId, id, seq, { type: "core.abandon", payload: { reason: "weather" } });
        expect(await fx(id), `${sport.key} ${kind}: shared`).toMatchObject({ status: "decided", outcome: { kind: "draw" } });
        checked++;
      }
    expect(checked).toBe(sports.length * DRAW_KINDS.size);
    expect(checked + sports.length * BRACKET_KINDS.size, "every stage kind was visited, by one half or the other").toBe(sports.length * StageKind.options.length);
  }, 600_000);

  it("sequence (generic knockout): abandon, undo the abandon, play on to a win - the bracket line behaves as without any policy", async () => {
    const { b, id, f, seq } = await board(sports[0], "knockout");
    await appendEvent(b.auth.orgId, id, seq, { type: "core.abandon", payload: { reason: "weather" } });
    const [abandon] = await sql<{ id: string }[]>`select id from score_events where fixture_id = ${id} and type = 'core.abandon'`;
    await appendEvent(b.auth.orgId, id, seq + 1, { type: "core.void", payload: {}, voids: abandon!.id });
    expect(await fx(id)).toMatchObject({ status: "in_play", outcome: null });
    await appendEvent(b.auth.orgId, id, seq + 2, { type: "generic.score", payload: { by: f.home, points: 5 } });
    await appendEvent(b.auth.orgId, id, seq + 3, { type: "core.abandon", payload: { reason: "weather again" } });
    expect(await fx(id), "a second abandon is held the same way").toMatchObject({ status: "abandoned", outcome: null });
  });
});
