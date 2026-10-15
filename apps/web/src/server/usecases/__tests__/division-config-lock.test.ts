// W2c Task 15 — the `division-config:<divisionId>` advisory lock (Task 2 I-1, orchestrator ruling; batch-1 Opus review;
// the batch-3 carry). Two connections, no sleeps: a holder takes what one side takes, the other side is launched and is
// either PARKED behind it (`pg_blocking_pids`, the replace-stages-gates.test.ts witness) or finishes on its own — the
// second is the defect, and each test reports it as one rather than as a timeout.
//
// The lock: a format save (`patchDivision` with a variant or config change, `putStageRules`) takes it EXCLUSIVE, right
// after the division lock and before its refusal read. A tiebreakers-only save takes no X (fix round 1, M-2): tiebreakers
// are a column of their own that no first event reads — the freeze resolves the division's `config`, the stage's and the
// match's own — so there is nothing for it to serialise. The first event of a match with no frozen cfg
// (`appendEventInTx`), a decision that may award a walkover by scoring (`onDecided`, a line that feeds a seat), a
// withdrawal's no-event seat write (`writeDepartedSeat`) and a take-back that releases or revives a seat it fed
// (`releaseFedSeats` / `reviveDeadSeats`, fix round 1 M-1) take it SHARED, after their fixture locks. Global order:
//   division: → stage-seats → fixture: → division-config: → row locks.
// An exclusive holder takes no stage-seats or fixture lock after it; a shared holder takes no division lock after it.
//
// Fix round 1 (I-1): a format save also BUMPS the version of every unfrozen match whose format it moves, in the same
// transaction, under its X lock — and the per-match override writer bumps under the fixture lock every append takes. The
// override takes no `division-config:` at all, so it shares exactly one key with an append (`fixture:`) and cannot form
// a cycle with it; the case below parks one behind the other and finishes both.
//
// The races it closes:
//  - I-1: the first event froze the OLD division config while a division save that read "no started stage" committed
//    the new one, so one stage played on mixed rules;
//  - batch-1: the same race against a stage-rules save (`stage-rules.ts`'s comment claimed the division lock closed it;
//    the append never takes that lock);
//  - batch-3: a walkover awarded by SCORING mid-play read the old config while a format save re-wrote only the
//    walkovers it could see, so the new award's stored score was stale.
//
// Real Postgres; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import type { AnySportModule } from "@seazn/engine/sport";
import { sql, withTenant, type Tx } from "@/lib/db";
import { appendEventInTx } from "@/server/engine-db/append-event";
import { awardedMatchState } from "@/server/engine-db/awarded-state";
import { loadLineupPair } from "@/server/engine-db/lineups";
import { bumpMovedRules, unfrozenRules } from "@/server/engine-db/rules-version";
import { declaredVariant, seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { fixtureRow, post, rowsOf, tip, type FixtureRow } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import { patchDivision } from "../divisions";
import { writeFixtureRulesOverride } from "../fixture-rules";
import { loadFixturePadCfg } from "../fixtures";
import { putStageRules } from "../stage-rules";
import { scoreEvent } from "../scoring";
import { writeDepartedSeat } from "../stages";
import { withdrawEntrantCascade } from "../withdrawal";

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

/** Backends waiting on a lock `pid` holds. */
async function waitersOn(pid: number): Promise<number[]> {
  const rows = await sql<{ pid: number }[]>`select pid from pg_locks where not granted and ${pid} = any(pg_blocking_pids(pid))`;
  return [...new Set(rows.map((r) => r.pid))];
}
/** A bounded poll on database state — it proves a wait, it never stands in for one. */
async function until(what: string, done: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
/** Launch `run` while the holder `tx` is open; resolve once it is parked behind the holder, or once it finished
 *  without waiting (the defect). Returns the launched promise and whether it had finished. */
async function launchBehind<T>(holder: Tx, what: string, run: () => Promise<T>) {
  const [held] = await holder<{ pid: number }[]>`select pg_backend_pid() as pid`;
  let settled = false;
  const p = run();
  p.then(
    () => (settled = true),
    () => (settled = true),
  );
  await until(what, async () => settled || (await waitersOn(held!.pid)).length === 1);
  return { p, settled, waiters: (await waitersOn(held!.pid)).length };
}

const KEY = (divisionId: string) => "division-config:" + divisionId;
const snapshotBestOf = async (id: string) =>
  (await sql<{ b: number | null }[]>`select (config_snapshot->>'bestOf')::int as b from fixtures where id = ${id}`)[0]!.b;
const divisionBestOf = async (id: string) =>
  (await sql<{ b: number | null }[]>`select (config->>'bestOf')::int as b from divisions where id = ${id}`)[0]!.b;

// single-sport: badminton — `bestOf` is a division config key every stage inherits, and a match's frozen cfg shows it
// as a number. The lock is keyed on the division and taken in the one append path every sport shares.
async function league(entrants = 3) {
  return seedBracket({ sport: "badminton", variant: "short", stageKind: "league", entrants });
}

describe.skipIf(!HAS_DB)("division-config: the first event and a division format save serialise", () => {
  it("I-1, the append side (SHARED): the first event waits for a save holding the lock and freezes the config that stands at commit — one stage, one format", async () => {
    const b = await league();
    const [f1, f2] = b.fixtureIds;
    const before = await divisionBestOf(b.divisionId);
    let parked!: Awaited<ReturnType<typeof launchBehind>>;
    await withTenant(b.auth.orgId, async (holder) => {
      await holder`select pg_advisory_xact_lock(hashtext(${KEY(b.divisionId)}))`; // what a format save takes
      parked = await launchBehind(holder, "the first event parks behind the save", () =>
        scoreEvent(b.auth, f1!, { expected_seq: 0, type: "core.start", payload: {} }),
      );
      // The save's write, while the event waits.
      await holder`update divisions set config = config || ${holder.json({ bestOf: 5 } as never)} where id = ${b.divisionId}`;
    });
    expect(parked.settled, "the first event waited for the save (it froze nothing before it committed)").toBe(false);
    expect(parked.waiters).toBe(1);
    await parked.p;
    expect(before, "premise: the save moved the format").not.toBe(5);
    expect(await snapshotBestOf(f1!), "the event froze the format that stands at commit").toBe(5);
    await scoreEvent(b.auth, f2!, { expected_seq: 0, type: "core.start", payload: {} });
    expect(await snapshotBestOf(f2!), "a sibling in the same stage plays the same format").toBe(5);
  });

  // Fix round 2 (re-review N-1): the append read the fixture row — its `rules_version` with it — BEFORE it waited on the
  // save, so a pad's first tap parked behind a save that bumped the version passed the check on the stale value and froze
  // the NEW format under a pad folding the OLD one. The save's own bump runs in the holder (`unfrozenRules` →
  // `bumpMovedRules`, the helper `patchDivision` calls), so the version moves exactly as a real save moves it.
  it("fix round 2 (N-1): a pad's first tap parked behind a save that moves its version is refused on the version that stands at commit — nothing frozen, nothing written", async () => {
    const b = await league(2);
    const [f1] = b.fixtureIds;
    const pad = await loadFixturePadCfg(b.auth, f1!);
    const declared = (pad.cfg as { bestOf: number }).bestOf;
    const target = declared === 5 ? 3 : 5;
    let parked!: Awaited<ReturnType<typeof launchBehind>>;
    let bumped: string[] = [];
    await withTenant(b.auth.orgId, async (holder) => {
      await holder`select pg_advisory_xact_lock(hashtext(${KEY(b.divisionId)}))`; // what a format save takes
      const before = await unfrozenRules(holder, { divisionId: b.divisionId });
      parked = await launchBehind(holder, "the pad's first tap parks behind the save", () =>
        scoreEvent(b.auth, f1!, { expected_seq: 0, type: "core.start", payload: {}, rules_version: pad.rulesVersion }),
      );
      // The save's writes while the tap waits: the format, then the version of every match it moved.
      await holder`update divisions set config = config || ${holder.json({ bestOf: target } as never)} where id = ${b.divisionId}`;
      bumped = await bumpMovedRules(holder, before);
    });
    expect(parked.settled, "the tap waited for the save").toBe(false);
    expect(parked.waiters).toBe(1);
    expect(bumped, "premise: the save moved this match's version").toContain(f1!);
    await expect(parked.p).rejects.toMatchObject({ code: "FIXTURE_RULES_CHANGED", extra: { rules_version: pad.rulesVersion + 1 } });
    expect(await snapshotBestOf(f1!), "nothing was frozen under the old pad").toBeNull();
    expect(await tip(f1!), "nothing was written").toBe(0);
    // The pad reloads and taps again: taken, under the format the save committed.
    const reloaded = await loadFixturePadCfg(b.auth, f1!);
    await expect(scoreEvent(b.auth, f1!, { expected_seq: 0, type: "core.start", payload: {}, rules_version: reloaded.rulesVersion })).resolves.toMatchObject({
      seq: 1,
      rules_version: pad.rulesVersion + 1,
    });
    expect(await snapshotBestOf(f1!)).toBe(target);
  });

  it("fix round 2 (N-1), the positive pair: a pad's first tap parked behind a save that moves NOTHING it plays still lands, under the version it sent", async () => {
    const b = await league(2);
    const [f1] = b.fixtureIds;
    const pad = await loadFixturePadCfg(b.auth, f1!);
    let parked!: Awaited<ReturnType<typeof launchBehind>>;
    let bumped: string[] = ["(not run)"];
    await withTenant(b.auth.orgId, async (holder) => {
      await holder`select pg_advisory_xact_lock(hashtext(${KEY(b.divisionId)}))`;
      const before = await unfrozenRules(holder, { divisionId: b.divisionId });
      parked = await launchBehind(holder, "the pad's first tap parks behind the save", () =>
        scoreEvent(b.auth, f1!, { expected_seq: 0, type: "core.start", payload: {}, rules_version: pad.rulesVersion }),
      );
      // A save that writes the format it already stores: it moves no match, so it bumps none.
      await holder`update divisions set config = config where id = ${b.divisionId}`;
      bumped = await bumpMovedRules(holder, before);
    });
    expect(parked.settled, "the tap waited for the save").toBe(false);
    expect(parked.waiters).toBe(1);
    expect(bumped, "premise: the save moved nothing").toEqual([]);
    await expect(parked.p).resolves.toMatchObject({ seq: 1, rules_version: pad.rulesVersion });
    expect(await snapshotBestOf(f1!), "it froze the format the pad folds").toBe((pad.cfg as { bestOf: number }).bestOf);
  });

  it("the other direction: a STARTED match's append never waits for a format save (the lock is for the first freeze only)", async () => {
    const b = await league(2);
    const [f1] = b.fixtureIds;
    await scoreEvent(b.auth, f1!, { expected_seq: 0, type: "core.start", payload: {} });
    let run!: Awaited<ReturnType<typeof launchBehind>>;
    await withTenant(b.auth.orgId, async (holder) => {
      await holder`select pg_advisory_xact_lock(hashtext(${KEY(b.divisionId)}))`;
      run = await launchBehind(holder, "a started match's append finishes on its own", () =>
        scoreEvent(b.auth, f1!, { expected_seq: 1, type: "badminton.game.summary", payload: { home: 11, away: 4 } }),
      );
    });
    expect(run.settled, "it finished while the save held the lock").toBe(true);
    expect(run.waiters).toBe(0);
    await expect(run.p).resolves.toMatchObject({ seq: 2 });
  });

  it("two first events never wait on each other: one proceeds while another, in flight on a sibling, holds the lock SHARED", async () => {
    const b = await league();
    const [f1, f2] = b.fixtureIds;
    let run!: Awaited<ReturnType<typeof launchBehind>>;
    await withTenant(b.auth.orgId, async (holder) => {
      // The sibling's first event, in flight: the append's own transaction body, not yet committed.
      await appendEventInTx(holder, b.auth.orgId, f1!, 0, { type: "core.start", payload: {} });
      run = await launchBehind(holder, "the second first event finishes on its own", () =>
        scoreEvent(b.auth, f2!, { expected_seq: 0, type: "core.start", payload: {} }),
      );
    });
    expect(run.settled, "it finished while the sibling's first event was in flight").toBe(true);
    expect(run.waiters).toBe(0);
    await expect(run.p).resolves.toMatchObject({ seq: 1 });
  });

  it("I-1, the save side (EXCLUSIVE): a division save waits for a first event in flight, then refuses the change by the stage it would split", async () => {
    const b = await league();
    const [f1] = b.fixtureIds;
    const before = await divisionBestOf(b.divisionId);
    let parked!: Awaited<ReturnType<typeof launchBehind>>;
    await withTenant(b.auth.orgId, async (holder) => {
      // The first event, in flight: the append's own transaction body, not yet committed.
      await appendEventInTx(holder, b.auth.orgId, f1!, 0, { type: "core.start", payload: {} });
      parked = await launchBehind(holder, "the division save parks behind the first event", () =>
        patchDivision(b.auth, b.divisionId, { config: { bestOf: 5 } } as never),
      );
    });
    expect(parked.settled, "the save waited for the first event (its refusal read ran after the freeze)").toBe(false);
    expect(parked.waiters).toBe(1);
    await expect(parked.p).rejects.toMatchObject({
      status: 409,
      code: "DIVISION_FORMAT_LOCKED",
      extra: { refused: [expect.objectContaining({ field: "bestOf", stageId: b.stageId })] },
    });
    expect(await divisionBestOf(b.divisionId), "nothing was applied").toBe(before);
    // The variant's own format, as the engine parses it — the one the match froze before the save could land.
    const declared = (moduleOf("badminton").configSchema.parse(moduleOf("badminton").variants.short) as { bestOf: number }).bestOf;
    expect(declared, "premise: the save would have moved it").not.toBe(5);
    expect(await snapshotBestOf(f1!), "the started match keeps the format it froze").toBe(declared);
    // Fix round 1 (I-1): the refused save rolled back whole — its bump with it, on the unstarted siblings too.
    const vs = await sql<{ v: number }[]>`select rules_version v from fixtures where stage_id = ${b.stageId}`;
    expect(vs.map((r) => r.v), "a refused save bumps nothing").toEqual(b.fixtureIds.map(() => 0));
  });

  it("fix round 1 (I-1): the override's bump and a first event in flight serialise on the fixture lock alone, and neither deadlocks", async () => {
    const b = await league();
    const [f1] = b.fixtureIds;
    const declared = (moduleOf("badminton").configSchema.parse(moduleOf("badminton").variants.short) as { bestOf: number }).bestOf;
    const target = declared === 5 ? 3 : 5;
    let parked!: Awaited<ReturnType<typeof launchBehind>>;
    await withTenant(b.auth.orgId, async (holder) => {
      // The first event in flight holds `fixture:` and `division-config:` SHARED (the append's own body).
      await appendEventInTx(holder, b.auth.orgId, f1!, 0, { type: "core.start", payload: {} });
      parked = await launchBehind(holder, "the override parks behind the first event", () =>
        writeFixtureRulesOverride(b.auth, [f1!], { bestOf: target }),
      );
    });
    expect(parked.settled, "the override waited for the first event").toBe(false);
    expect(parked.waiters, "on one lock: the fixture's").toBe(1);
    // The event committed first, so the override met a STARTED match: re-frozen and bumped once — not a 40P01.
    await expect(parked.p).resolves.toEqual({ fixtures: [{ id: f1!, started: true, rules_version: 1 }] });
    expect(await snapshotBestOf(f1!)).toBe(target);
  });

  it("batch-1, the stage save (EXCLUSIVE): a stage-rules save waits for a first event in flight, then refuses: the stage has started", async () => {
    const b = await league();
    const [f1] = b.fixtureIds;
    let parked!: Awaited<ReturnType<typeof launchBehind>>;
    await withTenant(b.auth.orgId, async (holder) => {
      await appendEventInTx(holder, b.auth.orgId, f1!, 0, { type: "core.start", payload: {} });
      parked = await launchBehind(holder, "the stage save parks behind the first event", () =>
        putStageRules(b.auth, b.stageId, { rules: { bestOf: 5 } }),
      );
    });
    expect(parked.settled, "the stage save waited for the first event").toBe(false);
    expect(parked.waiters).toBe(1);
    await expect(parked.p).rejects.toMatchObject({ status: 409, code: "STAGE_FORMAT_LOCKED" });
    const [{ r }] = await sql<{ r: unknown }[]>`select config -> 'rules' as r from stages where id = ${b.stageId}`;
    expect((r as { bestOf?: unknown } | null)?.bestOf, "the stage's rules were not written").toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The batch-3 carry: a walkover awarded by SCORING. A knockout winner withdraws while her next tie's other seat is TBD
// (ruling 116: her seat is stamped dead); the other line is then played, and its decision walks the arriving side over
// the dead seat in `onDecided` (`resolveBracketSeats` → `writeAwardedMatchState`), reading the division's LIVE config
// for the tie's score — no event records it, so nothing froze one. A format save holding the lock must be waited for.
// ---------------------------------------------------------------------------------------------------------------------

const moduleOf = (key: string) => builtinModules.find((m) => m.key === key) as unknown as AnySportModule;

/** Two seated first-round lines that feed one later fixture (withdrawn-winner-walkover.test.ts's rig). */
function siblingsInto(rows: readonly FixtureRow[]): { a: FixtureRow; b: FixtureRow; parentId: string } {
  const first = Math.min(...rows.map((r) => r.round_no));
  const r1 = rows.filter((r) => r.round_no === first && r.home_entrant_id && r.away_entrant_id);
  for (const a of r1) {
    const b = r1.find((x) => x.id !== a.id && x.winner_to_fixture !== null && x.winner_to_fixture === a.winner_to_fixture);
    if (b) return { a, b, parentId: a.winner_to_fixture! };
  }
  throw new Error("rig: no two seated first-round lines feed one fixture");
}

describe.skipIf(!HAS_DB)("batch-3 carry: a walkover awarded by scoring waits for a format save", () => {
  it("the deciding append parks its award behind a save holding the lock, and the walkover is stored under the format that stands", async () => {
    // single-sport: badminton bwf — its walkover credit is the best-of majority (Appendix A), so the format moves the
    // stored score; football's awardScore is the same shape through another key.
    const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "knockout", entrants: 8 });
    const { a, b, parentId } = siblingsInto(await rowsOf(s.stageId));
    await post(s.auth, a.id, "core.start");
    for (let g = 0; g < 2; g++) await post(s.auth, a.id, "badminton.game.summary", { home: 21, away: 10 });
    const w1 = (await fixtureRow(a.id)).home_entrant_id!;
    await withdrawEntrantCascade(s.auth, w1); // her next tie's seat is stamped dead
    await post(s.auth, b.id, "core.start");
    await post(s.auth, b.id, "badminton.game.summary", { home: 21, away: 10 });
    const bestOfBefore = await divisionBestOf(s.divisionId);

    let parked!: Awaited<ReturnType<typeof launchBehind>>;
    await withTenant(s.auth.orgId, async (holder) => {
      await holder`select pg_advisory_xact_lock(hashtext(${KEY(s.divisionId)}))`;
      // The deciding game: its append commits (the line is frozen), then the award waits.
      parked = await launchBehind(holder, "the award parks behind the save", () =>
        post(s.auth, b.id, "badminton.game.summary", { home: 21, away: 10 }),
      );
      await holder`update divisions set config = config || ${holder.json({ bestOf: 5 } as never)} where id = ${s.divisionId}`;
    });
    expect(parked.settled, "the award waited for the save").toBe(false);
    expect(parked.waiters).toBe(1);
    await parked.p;

    const tie = await fixtureRow(parentId);
    expect([tie.status, tie.outcome?.kind, tie.outcome?.loser], "premise: the arriving side walked over her dead seat").toEqual([
      "forfeited",
      "award",
      w1,
    ]);
    expect(bestOfBefore, "premise: the save moved the format").not.toBe(5);
    const cfg = (await loadFixturePadCfg(s.auth, parentId)).cfg as { bestOf: number };
    expect(cfg.bestOf, "the tie resolves the saved format").toBe(5);
    // The expectation is the engine's own walkover fold under the format the tie now resolves, never the write's.
    // Each side on its own seat, as the product folds it (`awarded-state.ts`): her seat is the one the winner is not on.
    const winner = tie.outcome!.winner!;
    const [home, away] = tie.home_entrant_id === winner ? [winner, w1] : [w1, winner];
    const lineups = await withTenant(s.auth.orgId, (tx) => loadLineupPair(tx, parentId, home, away));
    const want = awardedMatchState(moduleOf("badminton"), cfg, lineups, tie.outcome as never, {
      fixtureId: parentId,
      recordedAt: new Date().toISOString(),
    });
    const [stored] = await sql<{ summary: unknown; state: { cfg?: { bestOf?: number } } }[]>`
      select summary, state from match_states where fixture_id = ${parentId}`;
    expect(stored!.summary, "the stored walkover score is the saved format's").toEqual(want.summary);
    expect(stored!.state.cfg?.bestOf).toBe(5);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Fix round 1 (review M-1): the other bracket writers that read seats a format save can reshape. Each one is launched
// behind a holder of the EXCLUSIVE lock (what a format save holds) and must be parked INSIDE its own transaction — the
// write it guards not yet visible — never finish and only then wait somewhere later (an `onDecided` after a take-back
// also takes the lock, so "it waited" alone would not tell the two apart).
// ---------------------------------------------------------------------------------------------------------------------

/** A badminton bwf knockout of eight, line `a` played to a 2-0 decision: its winner sits in `parentId`. */
async function decidedLine() {
  // single-sport: badminton bwf, the batch-3 rig — the locks are in the bracket writers every sport shares.
  const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "knockout", entrants: 8 });
  const { a, b, parentId } = siblingsInto(await rowsOf(s.stageId));
  await post(s.auth, a.id, "core.start");
  await post(s.auth, a.id, "badminton.game.summary", { home: 21, away: 10 });
  const last = await post(s.auth, a.id, "badminton.game.summary", { home: 21, away: 10 });
  const winner = (await fixtureRow(a.id)).home_entrant_id!;
  const parent = await fixtureRow(parentId);
  expect([parent.home_entrant_id, parent.away_entrant_id], "premise: the winner sits in the next match").toContain(winner);
  return { s, a, b, parentId, winner, lastId: last.event_id };
}

const seated = async (fixtureId: string, entrantId: string) => {
  const r = await fixtureRow(fixtureId);
  return r.home_entrant_id === entrantId || r.away_entrant_id === entrantId;
};

describe.skipIf(!HAS_DB)("fix round 1 (M-1): the bracket writers that read seats wait for a format save", () => {
  it("a withdrawal's no-event seat write (writeDepartedSeat) parks behind the save before it writes, then stamps the seat", async () => {
    const { s, parentId, winner } = await decidedLine(); // the next match's other seat is still to be decided: TBD
    let parked!: Awaited<ReturnType<typeof launchBehind>>;
    await withTenant(s.auth.orgId, async (holder) => {
      await holder`select pg_advisory_xact_lock(hashtext(${KEY(s.divisionId)}))`;
      parked = await launchBehind(holder, "the departed seat write parks behind the save", () =>
        withTenant(s.auth.orgId, (tx) => writeDepartedSeat(tx, parentId, winner, "tbd")),
      );
      expect(await seated(parentId, winner), "parked before its write: she still sits there").toBe(true);
    });
    expect(parked.settled, "the seat write waited for the save").toBe(false);
    expect(parked.waiters).toBe(1);
    await expect(parked.p).resolves.toContain(parentId);
    expect(await seated(parentId, winner), "then it stamped her seat dead").toBe(false);
  });

  it("a take-back that RELEASES a seat it fed (releaseFedSeats) parks inside its append, before the void is recorded", async () => {
    const { s, a, parentId, winner, lastId } = await decidedLine();
    const before = await tip(a.id);
    let parked!: Awaited<ReturnType<typeof launchBehind>>;
    await withTenant(s.auth.orgId, async (holder) => {
      await holder`select pg_advisory_xact_lock(hashtext(${KEY(s.divisionId)}))`;
      parked = await launchBehind(holder, "the void parks behind the save", () =>
        post(s.auth, a.id, "core.void", { event_id: lastId }),
      );
      expect(await tip(a.id), "parked inside the append: the void is not recorded yet").toBe(before);
      expect(await seated(parentId, winner), "and the seat it releases still holds her").toBe(true);
    });
    expect(parked.settled, "the void waited for the save").toBe(false);
    expect(parked.waiters).toBe(1);
    await parked.p;
    expect(await tip(a.id)).toBe(before + 1);
    expect(await seated(parentId, winner), "then the take-back released her seat").toBe(false);
  });

  it("a take-back that REVIVES what a double walkover killed (reviveDeadSeats) parks inside its append, before the void is recorded", async () => {
    // single-sport: badminton bwf (above). Line `b` decides first, so its winner waits in the next match; a double
    // walkover on `a` then kills the other seat and the cascade walks `b`'s winner over it (a bye award).
    const s = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "knockout", entrants: 8 });
    const { a, b, parentId } = siblingsInto(await rowsOf(s.stageId));
    await post(s.auth, b.id, "core.start");
    for (let g = 0; g < 2; g++) await post(s.auth, b.id, "badminton.game.summary", { home: 21, away: 10 });
    const dw = await post(s.auth, a.id, "core.forfeit", { by: "both", reason: "walkover" });
    expect((await fixtureRow(a.id)).outcome?.kind, "premise: a double walkover").toBe("double_walkover");
    expect((await fixtureRow(parentId)).status, "premise: the cascade walked b's winner over the dead seat").toBe("forfeited");
    const before = await tip(a.id);
    let parked!: Awaited<ReturnType<typeof launchBehind>>;
    await withTenant(s.auth.orgId, async (holder) => {
      await holder`select pg_advisory_xact_lock(hashtext(${KEY(s.divisionId)}))`;
      parked = await launchBehind(holder, "the void of the double walkover parks behind the save", () =>
        post(s.auth, a.id, "core.void", { event_id: dw.event_id }),
      );
      expect(await tip(a.id), "parked inside the append: the void is not recorded yet").toBe(before);
      expect((await fixtureRow(parentId)).status, "and the walkover it revives still stands").toBe("forfeited");
    });
    expect(parked.settled, "the void waited for the save").toBe(false);
    expect(parked.waiters).toBe(1);
    await parked.p;
    expect(await tip(a.id)).toBe(before + 1);
    expect((await fixtureRow(parentId)).status, "then the revive took the walkover back").toBe("scheduled");
  });
});
