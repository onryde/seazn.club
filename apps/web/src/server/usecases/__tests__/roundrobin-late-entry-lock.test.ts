// W5 stress fix F2: a late add into a large league or group takes ONE lock, not one per line.
//
// Before: `placeInRootTable` took the append lock of EVERY line of the stage (`fixture:<id>`, `lockSwissBoardAppends`) before
// it read which rounds had started, so a 144-entrant league (10,296 lines) asked Postgres for 10,297 advisory locks in one
// transaction and a 28-player add answered 500 "out of shared memory" (stress-report.md F2). Those locks existed for one
// reason, which this file keeps proving: a line STARTING (its first event) and the late add's "has this round started?" read
// must serialise — the first event either commits before the read (and the read sees it) or waits for the add to commit.
//
// After: the add takes `division-config:<division>` EXCLUSIVE, the key a first event already takes SHARED before it freezes
// a line (`append-event.ts`), exactly as a format save does for the same "has a stage started?" read (`divisions.ts`
// patchDivision, `stage-rules.ts`). Global order `division:` -> stage seats -> `fixture:` -> `division-config:` -> rows; the
// add holds `division:` first and takes no stage-seat or fixture lock after it.
//
// Two connections, no sleeps (the `division-config-lock.test.ts` witness): one side holds, the other is launched and is either
// PARKED behind it (`pg_blocking_pids`) or finishes on its own — the defect, reported as one rather than as a timeout.
//
// single-sport for the serialisation cases: badminton — the locks are taken in the one append path and the one late-entry
// core every sport shares; the lock COUNT case runs the registry's first team sport as well.
//
// Real Postgres; skipped without DATABASE_URL.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";
import type { AnySportModule } from "@seazn/engine/sport";
import { sql, withTenant, type Tx } from "@/lib/db";
import { EngineError } from "@seazn/engine/core";
import type { AuthCtx } from "@/server/api-v1/auth";
import { appendEventInTx } from "@/server/engine-db/append-event";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { admitTableLateEntrant } from "../roundrobin-late-entry";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { createStages } from "../stages";
import { seedOrg } from "./_seed";

vi.mock("@/lib/posthog-server", () => ({ captureServer: vi.fn().mockResolvedValue(undefined) }));

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

type Kind = "individual" | "team";
const moduleOf = (key: string): AnySportModule => builtinModules.find((m) => m.key === key) as AnySportModule;
const variantOf = (key: string): string => Object.keys(moduleOf(key).variants)[0]!;
function teamSport(): string {
  const m = builtinModules.find((x) => x.entrantModel?.defaultKind === "team");
  if (m === undefined) throw new Error("premise: the registry declares a team sport");
  return m.key;
}

interface Rig {
  auth: AuthCtx;
  divisionId: string;
  stageId: string;
  name: Map<string, string>;
}

/** `n` seeded entrants P1..Pn in one started league (Start draws the table). */
async function started(n: number, sport = "badminton", kind: Kind = "individual"): Promise<Rig> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "F2 " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const d = await createDivision(auth, comp.id, { name: "Open", slug: "f2-" + randomUUID().slice(0, 6), sport_key: sport, variant_key: variantOf(sport), config: {} });
  const es = await createEntrants(auth, d.id, Array.from({ length: n }, (_, i) => ({ kind, display_name: `P${i + 1}`, seed: i + 1, members: [] })) as never);
  const [stage] = await createStages(auth, d.id, { seq: 1, kind: "league", name: "Table", config: { legs: 1 }, progression: null });
  await startDivision(auth, d.id);
  return { auth, divisionId: d.id, stageId: stage!.id, name: new Map(es.map((e) => [e.id, e.display_name])) };
}

/** A late entrant row with no admission yet (the X-CU-7 shape): the test drives the admission itself, on its own transaction. */
async function lateRow(rig: Rig, kind: Kind = "individual"): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into entrants (division_id, kind, display_name) values (${rig.divisionId}, ${kind}, 'Late') returning id`;
  rig.name.set(id, "Late");
  return id;
}

interface Line {
  id: string;
  round_no: number;
  ext_key: string | null;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
}
const lines = (stageId: string) =>
  sql<Line[]>`select id, round_no, ext_key, home_entrant_id, away_entrant_id from fixtures where stage_id = ${stageId} order by round_no, seq_in_round, id`;

/** The late player's lines as "opponent:kind:round" — `kind` read off the stored key (`rr-by-` / `rr-cu-`). */
function seats(rig: Rig, rows: readonly Line[], late: string): string[] {
  return rows
    .filter((r) => r.home_entrant_id === late || r.away_entrant_id === late)
    .map((r) => {
      const other = r.home_entrant_id === late ? r.away_entrant_id! : r.home_entrant_id!;
      const kind = /rr-by-/.test(r.ext_key ?? "") ? "bye_slot" : /rr-cu-/.test(r.ext_key ?? "") ? "catch_up_round" : `other(${r.ext_key})`;
      return `${rig.name.get(other)}:${kind}:${r.round_no}`;
    });
}

async function startLine(auth: AuthCtx, fixtureId: string) {
  const [{ n }] = await sql<{ n: number }[]>`select coalesce(max(seq), 0)::int as n from score_events where fixture_id = ${fixtureId}`;
  return scoreEvent(auth, fixtureId, { expected_seq: n, type: "core.start", payload: {} });
}
async function startRounds(rig: Rig, rounds: number[]) {
  const rows = await lines(rig.stageId);
  for (const r of rounds) await startLine(rig.auth, rows.find((x) => x.round_no === r)!.id);
}

/** Backends waiting on a lock `pid` holds. */
async function waitersOn(pid: number): Promise<number[]> {
  const rows = await sql<{ pid: number }[]>`select pid from pg_locks where not granted and ${pid} = any(pg_blocking_pids(pid))`;
  return [...new Set(rows.map((r) => r.pid))];
}
async function until(what: string, done: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
/** Launch `run` while `holder` is open; resolve once it is parked behind the holder, or once it finished without waiting. */
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

/** The advisory keys THIS transaction holds, as `hashtext` values (single-key form: classid 0 / objid = the int4). */
async function heldAdvisoryKeys(tx: Tx): Promise<number[]> {
  const rows = await tx<{ k: number }[]>`
    select (((classid::bigint) << 32) | objid::bigint)::bigint::int4 as k from pg_locks
     where locktype = 'advisory' and pid = pg_backend_pid() and granted and objsubid = 1`;
  return rows.map((r) => Number(r.k)).sort((a, b) => a - b);
}
async function hashOf(key: string): Promise<number> {
  const [{ h }] = await sql<{ h: number }[]>`select hashtext(${key}) as h`;
  return Number(h);
}

describe.skipIf(!HAS_DB)("F2: a late add takes a fixed set of locks, whatever the stage's size", () => {
  it.each([
    { sport: "badminton", kind: "individual" as Kind, n: 5 },
    { sport: "badminton", kind: "individual" as Kind, n: 12 },
    { sport: teamSport(), kind: "team" as Kind, n: 7 },
  ])("$sport, $n entrants: the add holds `division:`, `division-config:` and the numbering key, and no per-line key", async ({ sport, kind, n }) => {
    const rig = await started(n, sport, kind);
    await startRounds(rig, [1]);
    const lineCount = (await lines(rig.stageId)).length;
    expect(lineCount, "premise: the round robin's own count").toBe((n * (n - 1)) / 2);
    const late = await lateRow(rig, kind);
    // The add's two keys, and the one the fixtures insert trigger takes to number the new lines (V263 `assign_fixture_no`:
    // `fixture_no:<division>`, one key however many rows).
    const expected = [
      await hashOf("division:" + rig.divisionId),
      await hashOf("division-config:" + rig.divisionId),
      await hashOf("fixture_no:" + rig.divisionId),
    ].sort((a, b) => a - b);
    const { held, placed } = await withTenant(rig.auth.orgId, async (tx) => {
      const out = await admitTableLateEntrant(tx, rig.auth, rig.divisionId, late, "organiser");
      return { held: await heldAdvisoryKeys(tx), placed: out };
    });
    expect(placed?.result.case, "the add placed the newcomer").toBe("catch_up");
    expect(held, `the add's own keys, not one per line (the stage holds ${lineCount} lines)`).toEqual(expected);
    expect(seats(rig, await lines(rig.stageId), late).length, "the newcomer owes everyone in the field").toBe(n);
  });
});

describe.skipIf(!HAS_DB)("F2: a line starting and the late add's read still serialise (the guard the per-line locks were for)", () => {
  it("a first event on a bye-slot round waits for the add to commit; the add's bye-slot placement stands, then the round starts", async () => {
    const rig = await started(5);
    await startRounds(rig, [1, 2]);
    const late = await lateRow(rig);
    const round3 = (await lines(rig.stageId)).find((l) => l.round_no === 3)!;
    let parked!: Awaited<ReturnType<typeof launchBehind>>;
    await withTenant(rig.auth.orgId, async (holder) => {
      const out = await admitTableLateEntrant(holder, rig.auth, rig.divisionId, late, "organiser");
      expect(out?.result.case).toBe("catch_up");
      parked = await launchBehind(holder, "the first event parks behind the late add", () => startLine(rig.auth, round3.id));
    });
    expect(parked.settled, "the first event waited for the add (it started nothing before the add committed)").toBe(false);
    expect(parked.waiters).toBe(1);
    await parked.p;
    // The add read round 3 unstarted and placed P3 (round 3's bye) there; the start landed after it.
    expect(seats(rig, await lines(rig.stageId), late)).toEqual(["P3:bye_slot:3", "P2:bye_slot:4", "P1:bye_slot:5", "P4:catch_up_round:6", "P5:catch_up_round:7"]);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${round3.id}`;
    expect(n, "the parked start committed after the add").toBe(1);
  });

  it("a first event in flight makes the add wait; the add then reads its round started and appends instead of using the bye", async () => {
    const rig = await started(5);
    await startRounds(rig, [1, 2]);
    const late = await lateRow(rig);
    const round3 = (await lines(rig.stageId)).find((l) => l.round_no === 3)!;
    let parked!: Awaited<ReturnType<typeof launchBehind>>;
    await withTenant(rig.auth.orgId, async (holder) => {
      // What a scorer's first tap holds until it commits: the line's append lock and the format freeze's key, shared.
      await appendEventInTx(holder, rig.auth.orgId, round3.id, 0, { type: "core.start", payload: {}, recordedBy: rig.auth.userId });
      parked = await launchBehind(holder, "the late add parks behind the first event", () =>
        withTenant(rig.auth.orgId, (tx) => admitTableLateEntrant(tx, rig.auth, rig.divisionId, late, "organiser")),
      );
    });
    expect(parked.settled, "the add waited for the first event (it read nothing before it committed)").toBe(false);
    expect(parked.waiters).toBe(1);
    await parked.p;
    // Round 3 started before the add READ it (not between its read and its write, X-CU-7's demotion): P3's bye is not offered,
    // so P3 joins the appended rounds, which follow the field's seed order (RB5-L6): P3 r6, P4 r7, P5 r8.
    expect(seats(rig, await lines(rig.stageId), late)).toEqual(["P2:bye_slot:4", "P1:bye_slot:5", "P3:catch_up_round:6", "P4:catch_up_round:7", "P5:catch_up_round:8"]);
  });

  it("a Rebuild-by-add with a first event parked behind it: the deleted line refuses the event by name, and no event lands", async () => {
    const rig = await started(5);
    const late = await lateRow(rig);
    const first = (await lines(rig.stageId))[0]!;
    let parked!: Awaited<ReturnType<typeof launchBehind>>;
    await withTenant(rig.auth.orgId, async (holder) => {
      const out = await admitTableLateEntrant(holder, rig.auth, rig.divisionId, late, "organiser", { preferRebuild: true });
      expect(out?.result).toMatchObject({ case: "rebuild_offered", reason: "rebuilt" });
      parked = await launchBehind(holder, "the first event parks behind the rebuild", () => startLine(rig.auth, first.id));
    });
    expect(parked.settled, "the first event waited for the rebuild").toBe(false);
    const err = await parked.p.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err, "refused by name, never a crash").toBeInstanceOf(EngineError);
    expect((err as EngineError).code).toBe("INVALID_EVENT");
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${first.id}`;
    expect(n, "nothing landed on the deleted line").toBe(0);
    expect((await lines(rig.stageId)).length, "the rebuild drew six: 15 lines").toBe(15);
  });
});
