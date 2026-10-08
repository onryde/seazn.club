// W2a fix round 1 (review M-3, controller ruling D-F1): the three behaviours Task 8 changed, pinned.
//  1. A held fixture's discipline and news refreshes wait for the settle (spec §5.4.4: scoreEvent runs onDecided,
//     refreshDiscipline and refreshNews only for a decided write or a void).
//  2. A LEGACY generic held row (a generic draw stored before W2a, in a stage that is a bracket now; V432 holds it)
//     refuses any later event whose fold is still the draw — LEVEL_RESULT_IN_BRACKET, "enter the winner".
//  3. D-F1: except a core.void. The organiser must be able to undo a settle; voiding the settle on such a row returns
//     it to needs_decision.
// Witnesses are passthrough spies on the two modules the refreshes call (the real code still runs).
import { afterAll, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ notify: 0, drafted: [] as string[] }));

vi.mock("@/server/usecases/discipline", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/usecases/discipline")>();
  return {
    ...real,
    // refreshDiscipline's last act, unconditional (an empty list when no rule is due).
    notifyServedSuspensions: vi.fn(async (...a: Parameters<typeof real.notifyServedSuspensions>) => {
      calls.notify++;
      return real.notifyServedSuspensions(...a);
    }),
  };
});
vi.mock("@/server/usecases/org-posts", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/usecases/org-posts")>();
  return {
    ...real,
    // refreshNews drafts for a division with auto_posts on; the fixture id is its second argument.
    draftPostsForDecidedFixture: vi.fn(async (...a: Parameters<typeof real.draftPostsForDecidedFixture>) => {
      calls.drafted.push(a[1]);
      return real.draftPostsForDecidedFixture(...a);
    }),
  };
});

const { sql } = await import("@/lib/db");
const { appendEvent } = await import("@/server/engine-db");
const { scoreEvent } = await import("@/server/usecases/scoring");
const { seedBracket } = await import("./helpers/seed-bracket");
const { LEVEL_RESULT_REASON } = await import("@/lib/level-result-reason");

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const seq = async (id: string) =>
  (await sql<{ s: number }[]>`select coalesce(max(seq), 0)::int as s from score_events where fixture_id = ${id}`)[0]!.s;
const status = async (id: string) => (await sql<{ status: string }[]>`select status from fixtures where id = ${id}`)[0]!.status;
const sides = async (id: string) =>
  (await sql<{ home: string; away: string }[]>`select home_entrant_id as home, away_entrant_id as away from fixtures where id = ${id}`)[0]!;
type Auth = Parameters<typeof scoreEvent>[0];
const post = async (auth: Auth, id: string, type: string, payload: unknown = {}) =>
  scoreEvent(auth, id, { expected_seq: await seq(id), type, payload } as never);

describe.skipIf(!HAS_DB)("M-3: the held behaviours Task 8 changed", () => {
  it("X-BR-2: a held fixture's discipline and news refreshes wait for the settle; the settle runs both", async () => {
    const s = await seedBracket({ sport: "boardgame", variant: "classical", stageKind: "knockout", entrants: 2 });
    const id = s.fixtureIds[0]!;
    await sql`update divisions set auto_posts = true where id = ${s.divisionId}`;
    await appendEvent(s.auth.orgId, id, 0, { type: "core.start", payload: {} });
    // A frozen cfg without the bracket overlay's tie-break, so the drawn game HOLDS (settle-seating's dropTiebreak).
    await sql`update fixtures set config_snapshot = config_snapshot - 'tiebreak' where id = ${id}`;
    const notifyBefore = calls.notify;
    await post(s.auth, id, "boardgame.result", { winner: null, method: "agreement" });
    expect(await status(id), "the rig must actually hold the fixture").toBe("needs_decision");
    expect(calls.notify - notifyBefore, "refreshDiscipline ran for the held write").toBe(0);
    expect(calls.drafted.filter((x) => x === id), "refreshNews ran for the held write").toEqual([]);
    const { home } = await sides(id);
    await post(s.auth, id, "core.settle", { winner: home, method: "organiser" });
    expect(await status(id)).toBe("decided");
    expect(calls.notify - notifyBefore, "the settle runs refreshDiscipline").toBe(1);
    expect(calls.drafted.filter((x) => x === id), "the settle runs refreshNews").toEqual([id]);
  });

  it("M-1: each LEVEL_RESULT_IN_BRACKET emitter names its reason — a generic draw asks for the winner, a finalize of a held fixture for a settle", async () => {
    const g = await seedBracket({ sport: "generic", variant: "score", stageKind: "knockout", entrants: 2 });
    const gid = g.fixtureIds[0]!;
    await post(g.auth, gid, "core.start");
    await expect(post(g.auth, gid, "generic.result", { p1Score: 2, p2Score: 2 })).rejects.toMatchObject({
      code: "LEVEL_RESULT_IN_BRACKET",
      data: { reason: LEVEL_RESULT_REASON.genericDraw },
    });
    const c = await seedBracket({ sport: "boardgame", variant: "classical", stageKind: "knockout", entrants: 2 });
    const cid = c.fixtureIds[0]!;
    await appendEvent(c.auth.orgId, cid, 0, { type: "core.start", payload: {} });
    await sql`update fixtures set config_snapshot = config_snapshot - 'tiebreak' where id = ${cid}`;
    await post(c.auth, cid, "boardgame.result", { winner: null, method: "agreement" });
    expect(await status(cid)).toBe("needs_decision");
    await expect(post(c.auth, cid, "core.finalize")).rejects.toMatchObject({
      code: "LEVEL_RESULT_IN_BRACKET",
      data: { reason: LEVEL_RESULT_REASON.finalizeUnsettled },
    });
  });

  /** A generic draw stored before W2a: recorded in a league (where it was a result), the stage then a knockout and
   *  the row held — the shape V432's backfill leaves. */
  async function legacyGenericHeld() {
    const s = await seedBracket({ sport: "generic", variant: "score", stageKind: "league", entrants: 2 });
    const id = s.fixtureIds[0]!;
    await post(s.auth, id, "core.start");
    await post(s.auth, id, "generic.result", { p1Score: 1, p2Score: 1 });
    await sql`update stages set kind = 'knockout' where id = ${s.stageId}`;
    await sql`update fixtures set status = 'needs_decision' where id = ${id}`;
    const [f] = await sql<{ kind: string }[]>`select outcome->>'kind' as kind from fixtures where id = ${id}`;
    expect(f!.kind, "the rig: a stored generic draw").toBe("draw");
    return { ...s, id };
  }

  it("GN-KO-1 (legacy): a held generic draw refuses a later non-settle event with LEVEL_RESULT_IN_BRACKET, and the ledger is untouched", async () => {
    const t = await legacyGenericHeld();
    const before = await seq(t.id);
    await expect(post(t.auth, t.id, "core.note", { text: "late note" })).rejects.toMatchObject({ code: "LEVEL_RESULT_IN_BRACKET" });
    expect(await seq(t.id)).toBe(before);
    expect(await status(t.id)).toBe("needs_decision");
  });

  it("D-F1: the organiser can undo a settle on a legacy generic held row — the void is accepted and the row is held again", async () => {
    const t = await legacyGenericHeld();
    const { home } = await sides(t.id);
    await post(t.auth, t.id, "core.settle", { winner: home, method: "organiser" });
    expect(await status(t.id), "the settle decides it").toBe("decided");
    const [settle] = await sql<{ id: string }[]>`
      select id from score_events where fixture_id = ${t.id} and type = 'core.settle' order by seq desc limit 1`;
    await post(t.auth, t.id, "core.void", { event_id: settle!.id });
    expect(await status(t.id), "voiding the settle returns the row to needs_decision").toBe("needs_decision");
    // The exemption is the void's alone: the next non-settle event is refused again.
    await expect(post(t.auth, t.id, "core.note", { text: "after the undo" })).rejects.toMatchObject({ code: "LEVEL_RESULT_IN_BRACKET" });
  });
});
