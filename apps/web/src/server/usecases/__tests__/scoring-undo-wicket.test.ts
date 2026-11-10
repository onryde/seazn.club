// 2026-11-10 (owner, "apply rec"): a cricket wicket is voidable only while it is the latest ACTIVE ball of the match.
// Voiding an older one replays the ledger without it (over boundaries shift, bowler rules are not re-checked, the
// dismissed batter is no longer out, the incoming batter keeps batting) so the server refuses it, 409
// UNDO_WICKET_NOT_LATEST, for every caller (scorer accounts, API keys, device links). docs/specs/2026-11-10-cricket-wicket-void-latest-only.md.
//
// Real DB. The ledger is written as raw rows because the guard reads rows, not folds: a raw row can hold the shapes the
// rule is about (a wicket, a bowler change after it, a voided ball after it) without scripting a legal match around them.
// The fold half of the claim (the card after a void back) is in lib/__tests__/cricket-wicket-void.test.ts.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { HttpError } from "@/lib/errors";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { __assertUndoTargetForTests as assertUndoTarget, scoreEvent } from "../scoring";
import { seedOrg, startedCricketDivisionWithFixture } from "./_rig";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const BALL = { over: 0, ballInOver: 1, striker: "h1", nonStriker: "h2", bowler: "a7", runs: { bat: 1 } };
const WICKET = { ...BALL, wicket: { kind: "bowled", out: "h1", bowlerCredited: true } };

type Seed = { auth: AuthCtx; fixtureId: string; ids: Record<string, string>; seq: () => number };

/** A started cricket fixture with a raw ledger: start, a single, a WICKET, a bowler change. */
async function ledger(extra: Array<[name: string, type: string, payload: unknown]> = []): Promise<Seed> {
  const { auth } = await seedOrg();
  const { fixtureId } = await startedCricketDivisionWithFixture(auth);
  const seed: Seed = { auth, fixtureId, ids: {}, seq: () => 0 };
  let n = 0;
  seed.seq = () => n;
  const add = async (name: string, type: string, payload: unknown, voids: string | null = null) => {
    n += 1;
    const id = randomUUID();
    seed.ids[name] = id;
    await sql`insert into score_events (id, fixture_id, org_id, seq, type, payload, voids_event_id)
              values (${id}, ${fixtureId}, ${auth.orgId}, ${n}, ${type}, ${sql.json(payload as never)}, ${voids})`;
  };
  Object.assign(seed, { add });
  await add("start", "core.start", {});
  await add("single", "cricket.ball", BALL);
  await add("wicket", "cricket.ball", WICKET);
  await add("change", "cricket.bowler.change", { bowler: "a8" });
  for (const [name, type, payload] of extra) await add(name, type, payload);
  return seed;
}
const addTo = (s: Seed) =>
  (s as unknown as { add: (name: string, type: string, payload: unknown, voids?: string | null) => Promise<void> }).add;
const voidInput = (s: Seed, name: string) =>
  ({ type: "core.void", payload: { event_id: s.ids[name] }, expected_seq: s.seq() }) as never;
const attempt = (s: Seed, name: string) => assertUndoTarget(s.auth, s.fixtureId, voidInput(s, name)).then(
  () => null,
  (e: unknown) => e as HttpError,
);

describe.skipIf(!HAS_DB)("a cricket wicket is voidable only while it is the latest ball", () => {
  it("the latest wicket may be voided, even with a non-ball entry (a bowler change) after it", async () => {
    const s = await ledger();
    expect(await attempt(s, "wicket")).toBeNull();
  });

  it("a wicket with a later ball is refused: 409 UNDO_WICKET_NOT_LATEST", async () => {
    const s = await ledger([["four", "cricket.ball", BALL]]);
    const err = await attempt(s, "wicket");
    expect(err).toBeInstanceOf(HttpError);
    expect(err!.status).toBe(409);
    expect(err!.code).toBe("UNDO_WICKET_NOT_LATEST");
  });

  it("the refusal writes nothing: through scoreEvent the ledger is the same size after", async () => {
    const s = await ledger([["four", "cricket.ball", BALL]]);
    const count = async () => (await sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${s.fixtureId}`)[0]!.n;
    const before = await count();
    expect(before).toBe(5);
    const err = await scoreEvent(s.auth, s.fixtureId, {
      type: "core.void", payload: { event_id: s.ids.wicket }, expected_seq: s.seq(),
    } as never).catch((e: unknown) => e as HttpError);
    expect((err as HttpError).code).toBe("UNDO_WICKET_NOT_LATEST");
    expect(await count()).toBe(before);
  });

  it("an older NON-wicket ball is voidable as before (today's behaviour), and so is the latest ball", async () => {
    const s = await ledger([["four", "cricket.ball", BALL]]);
    expect(await attempt(s, "single")).toBeNull();
    expect(await attempt(s, "four")).toBeNull();
  });

  it("a later ball that is itself voided does not count: the wicket is the latest again", async () => {
    const s = await ledger([["four", "cricket.ball", BALL]]);
    expect((await attempt(s, "wicket"))!.code).toBe("UNDO_WICKET_NOT_LATEST");
    await addTo(s)("voidFour", "core.void", { event_id: s.ids.four }, s.ids.four);
    expect(await attempt(s, "wicket")).toBeNull();
  });

  it("the void-back sequence: newest first, every step passes the rule, the wicket last", async () => {
    const s = await ledger([["four", "cricket.ball", BALL], ["six", "cricket.ball", BALL]]);
    const passed: string[] = [];
    for (const name of ["six", "four", "change", "wicket"]) {
      expect(await attempt(s, name), `${name} is the latest active entry of its kind when its turn comes`).toBeNull();
      passed.push(name);
      await addTo(s)(`void-${name}`, "core.void", { event_id: s.ids[name] }, s.ids[name]);
    }
    expect(passed).toEqual(["six", "four", "change", "wicket"]);
  });

  it("a super-over wicket follows the same rule", async () => {
    const s = await ledger([["soWicket", "cricket.superover.ball", WICKET], ["soBall", "cricket.superover.ball", BALL]]);
    expect((await attempt(s, "soWicket"))!.code).toBe("UNDO_WICKET_NOT_LATEST");
    expect(await attempt(s, "soBall")).toBeNull();
  });

  it("a later ball in ANOTHER fixture is not a later ball of this one", async () => {
    const s = await ledger();
    const other = await startedCricketDivisionWithFixture(s.auth);
    await sql`insert into score_events (id, fixture_id, org_id, seq, type, payload)
              values (${randomUUID()}, ${other.fixtureId}, ${s.auth.orgId}, 99, 'cricket.ball', ${sql.json(BALL as never)})`;
    expect(await attempt(s, "wicket")).toBeNull();
  });

  it("the rule is cricket's: another sport's event that merely carries a wicket key is untouched", async () => {
    const s = await ledger([["goal", "football.goal", { by: "x", wicket: { out: "y" } }], ["next", "football.goal", { by: "x" }]]);
    expect(await attempt(s, "goal")).toBeNull();
  });

  it("a ball whose wicket is null is not a wicket", async () => {
    const s = await ledger([["nullWicket", "cricket.ball", { ...BALL, wicket: null }], ["after", "cricket.ball", BALL]]);
    expect(await attempt(s, "nullWicket")).toBeNull();
  });
});
