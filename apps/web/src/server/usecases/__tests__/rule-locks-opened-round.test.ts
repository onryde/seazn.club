// Rebase ruling D2 (2026-10-23): an OPENED round (`stage_round_opens`) locks its stage, exactly as a played match does.
//
// Online (Lichess) chess appends nothing to a fixture's ledger until a result lands and freezes no `config_snapshot`, so
// W2c's PLAYED predicate alone left a running Lichess round's stage - and every division field it inherits - editable:
// the clock could change under games whose players were already invited on it. The open joins THE lock predicate
// (`lockedStageIdsAmong`, rule-locks.ts), so every reader of it follows: the stage save (T17), the division save and its
// lock lines (T20), and the page's list of locked stages. Over the board nothing is opened, and the lock still waits for
// the first event.
//
// `stage_round_opens` is sealed (V451: FORCE RLS, no app_user policy, no grant), so the predicate reads it through
// `stage_ids_with_opened_round` (V469, security definer), scoped to the tenant the transaction runs as (unscoped in a
// privileged transaction, which may read the table anyway).
//
// Single sport by construction: only chess plays online (`supportsOnlinePlay`), so only a chess stage is ever opened.
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { sql, withTenant } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { boardgame } from "@seazn/engine/sports/boardgame";
import { patchDivision } from "../divisions";
import { writeFixtureRulesOverride } from "../fixture-rules";
import { divisionLockedFields, lockedStageIdsAmong } from "../rule-locks";
import { scoreEvent } from "../scoring";
import { formatLockedStageIds, putStageRules } from "../stage-rules";
import { seedOnlineChessFixture, seedOwner } from "./_external-play-seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

const SCHEDULED = new Date("2026-10-01T12:10:00.000Z");
const OPENED = new Date("2026-10-01T12:00:00.000Z");
const TEN_FIVE = { base: 600, increment: 5 }; // 10+5 and 15+10 are both on the Lichess list: the change is legal,
const FIFTEEN_TEN = { base: 900, increment: 10 }; // so only the lock can refuse it

async function seed(onlinePlay: "off" | "lichess", roundOpenedAt?: Date) {
  const s = await seedOnlineChessFixture({
    onlinePlay,
    divisionStarted: true,
    scheduledAt: SCHEDULED,
    linked: false,
    clock: TEN_FIVE,
    ...(roundOpenedAt ? { roundOpenedAt } : {}),
  });
  const auth = { orgId: s.orgId, via: "session", userId: s.ownerUserId, role: "owner", keyId: null } as AuthCtx;
  return { s, auth };
}

async function divisionConfig(divisionId: string): Promise<Record<string, unknown>> {
  const [row] = await sql<{ config: Record<string, unknown> }[]>`select config from divisions where id = ${divisionId}`;
  return row!.config;
}

/** Nothing has been played: no ledger row and no frozen config, so PLAYED is false and only the open can lock. */
async function expectUnplayed(fixtureId: string) {
  const [row] = await sql<{ events: number; snapshot: unknown }[]>`
    select (select count(*)::int from score_events where fixture_id = f.id) as events, f.config_snapshot as snapshot
      from fixtures f where f.id = ${fixtureId}`;
  expect(row, "premise: the fixture exists").toBeDefined();
  expect(row!.events, "premise: no event on the ledger").toBe(0);
  expect(row!.snapshot, "premise: no frozen config").toBeNull();
}

async function opens(stageId: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`select count(*)::int as n from stage_round_opens where stage_id = ${stageId}`;
  return row!.n;
}

describe.skipIf(!HAS_DB)("D2: an opened round locks its stage, before any event", () => {
  it("the empty case: a paired Lichess round nobody has opened locks nothing, and both saves go through", async () => {
    const { s, auth } = await seed("lichess");
    await expectUnplayed(s.fixtureId);
    expect(await opens(s.stageId), "premise: the round is not opened").toBe(0);
    expect(await formatLockedStageIds(auth, s.divisionId)).toEqual([]);
    expect(await divisionLockedFields(auth, s.divisionId)).toEqual([]);
    await putStageRules(auth, s.stageId, { rules: {} });
    const before = await divisionConfig(s.divisionId);
    await patchDivision(auth, s.divisionId, { config: { ...before, clock: FIFTEEN_TEN } });
    expect((await divisionConfig(s.divisionId)).clock, "the clock change landed").toEqual(FIFTEEN_TEN);
  }, 30_000);

  it("T17: the open locks the stage - listed for the page, and the stage save is 409 STAGE_FORMAT_LOCKED, twice", async () => {
    const { s, auth } = await seed("lichess", OPENED);
    await expectUnplayed(s.fixtureId);
    expect(await opens(s.stageId), "premise: the round is opened").toBe(1);
    expect(await formatLockedStageIds(auth, s.divisionId)).toEqual([s.stageId]);
    for (const call of ["first", "second"]) {
      await expect(putStageRules(auth, s.stageId, { rules: {} }), call).rejects.toMatchObject({
        status: 409,
        code: "STAGE_FORMAT_LOCKED",
      });
    }
    await expectUnplayed(s.fixtureId);
  }, 30_000);

  it("T20: the division's clock is locked by the open - 409 DIVISION_FORMAT_LOCKED naming the stage, twice, nothing written", async () => {
    const { s, auth } = await seed("lichess", OPENED);
    await expectUnplayed(s.fixtureId);
    const clockLock = (await divisionLockedFields(auth, s.divisionId)).find((l) => l.field === "clock");
    expect(clockLock, "the page's lock line names the clock").toMatchObject({ code: "DIVISION_FORMAT_LOCKED", stageId: s.stageId });
    const before = await divisionConfig(s.divisionId);
    for (const call of ["first", "second"]) {
      await expect(patchDivision(auth, s.divisionId, { config: { ...before, clock: FIFTEEN_TEN } }), call).rejects.toMatchObject({
        status: 409,
        code: "DIVISION_FORMAT_LOCKED",
        extra: { refused: [expect.objectContaining({ field: "clock", stageId: s.stageId })] },
      });
    }
    expect((await divisionConfig(s.divisionId)).clock, "nothing was written").toEqual(TEN_FIVE);
  }, 30_000);

  it("T19: an online board has no match format for the open to lock - chess declares no match-scope key, so the per-match writer refuses every one (counted)", async () => {
    // The per-match lock is the MATCH's own (X-SR-2: played, finished or decided), not the stage's, and online play is
    // chess only (`supportsOnlinePlay`). So the open owes T19 nothing PROVIDED chess keeps declaring no match-scope key:
    // that assumption is this guard, read from the engine's own declarations.
    const keys = Object.entries(boardgame.ruleKeys ?? {});
    expect(keys.length, "premise: chess declares rule keys").toBeGreaterThan(0);
    expect(keys.filter(([, fact]) => fact.scope === "match").map(([k]) => k), "chess has no per-match format").toEqual([]);
    const { s, auth } = await seed("lichess", OPENED);
    const SENT: Record<string, unknown>[] = [{ clock: FIFTEEN_TEN }, { variant: "blitz" }];
    let refused = 0;
    for (const fragment of SENT) {
      await expect(writeFixtureRulesOverride(auth, [s.fixtureId], fragment), JSON.stringify(fragment)).rejects.toMatchObject({
        code: "RULE_NOT_SETTABLE",
      });
      refused++;
    }
    expect(refused, "anti-vacuity").toBe(SENT.length);
    const [row] = await sql<{ rules_override: unknown }[]>`select rules_override from fixtures where id = ${s.fixtureId}`;
    expect(row!.rules_override, "nothing was written").toBeNull();
  }, 30_000);

  it("over the board: a paired chess round locks nothing until its first event, then locks like any played stage", async () => {
    const { s, auth } = await seed("off");
    await expectUnplayed(s.fixtureId);
    expect(await formatLockedStageIds(auth, s.divisionId), "no event yet: unlocked").toEqual([]);
    await putStageRules(auth, s.stageId, { rules: { clock: FIFTEEN_TEN } });
    await scoreEvent(auth, s.fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
    expect(await formatLockedStageIds(auth, s.divisionId), "the first event locks it").toEqual([s.stageId]);
    await expect(putStageRules(auth, s.stageId, { rules: {} })).rejects.toMatchObject({ status: 409, code: "STAGE_FORMAT_LOCKED" });
  }, 30_000);

  it("the open is read for the transaction's own organisation only: another tenant asking about the same stage sees no lock", async () => {
    const { s } = await seed("lichess", OPENED);
    const stranger = await seedOwner();
    expect(stranger.orgId, "premise: a different organisation").not.toBe(s.orgId);
    const own = await withTenant(s.orgId, (tx) => lockedStageIdsAmong(tx, [s.stageId]));
    expect([...own], "the owner's tenant sees the lock").toEqual([s.stageId]);
    const foreign = await withTenant(stranger.orgId, (tx) => lockedStageIdsAmong(tx, [s.stageId]));
    expect([...foreign], "a stranger's tenant learns nothing about it").toEqual([]);
  }, 30_000);

  it("a privileged transaction (no tenant set) reads the open as the lock it is - never as 'nothing opened'", async () => {
    const { s } = await seed("lichess", OPENED);
    const privileged = await sql.begin((tx) => lockedStageIdsAmong(tx as never, [s.stageId]));
    expect([...privileged]).toEqual([s.stageId]);
  }, 30_000);
});
