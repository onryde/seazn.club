// CI flake, run 40233887793 (PR #1019 smoke): eventless-award-rewrite.test.ts "the division door ... (the empty case
// first)" saw `[{ divisionId, competitionId }]` where a rename-only save must revalidate NOTHING. The rename revalidated
// nothing; the entry was the tail of the SETUP: `generateStageFixtures` ended in `void fireStageRevalidate(...)`, a fire and
// forget that awaits a DB lookup and only THEN calls `fireDivisionRevalidate`. Under load that lookup outlived the
// operation that asked for it, landed after the test's `revalidated.length = 0`, and was counted against the rename.
//
// It is a product defect before it is a test one. In Next 16 a `void`ed promise that awaits anything before it calls
// `revalidateTag` is applied AFTER the request's revalidations have flushed, so it is silently dropped and the public pages
// stay stale for the cache entry's whole life (reference_voided_revalidatetag_is_dropped_after_request_flush). So the
// contract pinned here is the one a route handler needs: by the time a stage write RESOLVES, the revalidation it owes has
// already been fired, and a revalidation that cannot be looked up never turns a committed write into a failure.
//
// How the race is made deterministic: the one lookup `fireStageRevalidate` makes is held for HOLD_MS (the other queries
// run at full speed), and a sequence number orders three events - the lookup finishing, `fireDivisionRevalidate` being
// called, the operation resolving. Un-awaited, the operation resolves ~HOLD_MS before the lookup finishes, on every run;
// awaited, it cannot resolve first. The held lookup is counted: zero held would mean the test never reached the seam.
import { afterAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { declaredVariant, seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { scoreEvent } from "../scoring";
import { completeStage, createStages, generateStageFixtures, unpairSwissRound } from "../stages";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

const rig = vi.hoisted(() => ({
  HOLD_MS: 400,
  /** `fireStageRevalidate`'s one query, by its text: a callback nothing else in these doors shares. */
  LOOKUP: /select s\.division_id, d\.competition_id\s+from stages s join divisions d on d\.id = s\.division_id\s+where s\.id = \$\{stageId\}/,
  armed: false,
  failLookup: false,
  seq: 0,
  held: 0,
  lookupDone: [] as number[],
  fires: [] as { divisionId: string; seq: number }[],
}));

vi.mock("@/lib/db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/db")>();
  const withTenant = (async (...args: Parameters<typeof real.withTenant>) => {
    if (!rig.armed || !rig.LOOKUP.test(String(args[1]))) return real.withTenant(...args);
    rig.held++;
    await new Promise((r) => setTimeout(r, rig.HOLD_MS));
    if (rig.failLookup) throw new Error("rig: the revalidation lookup failed");
    const out = await real.withTenant(...args);
    rig.lookupDone.push(++rig.seq);
    return out;
  }) as typeof real.withTenant;
  return { ...real, withTenant };
});

vi.mock("@/server/public-site/revalidate", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/public-site/revalidate")>();
  return {
    ...real,
    fireDivisionRevalidate: (...args: Parameters<typeof real.fireDivisionRevalidate>) => {
      rig.fires.push({ divisionId: args[0], seq: ++rig.seq });
      return real.fireDivisionRevalidate(...args);
    },
  };
});

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Seen {
  /** Lookups the door held: zero means it never reached `fireStageRevalidate`. */
  held: number;
  /** Held lookups that had finished by the instant the operation resolved. */
  lookupsDoneAtResolve: number;
  /** `fireDivisionRevalidate` calls for the division that came AFTER a finished lookup (so: from `fireStageRevalidate`,
   *  never from `afterScheduleWrite`, which fires with no lookup), and were made before the operation resolved. */
  toldBeforeResolve: number;
  /** ... and those that landed after it resolved, once the held lookup was let go. */
  toldAfterResolve: number;
  /** Every `fireDivisionRevalidate` call for the division, whatever its source. */
  firesInAll: number;
  /** Promise rejections nobody awaited, counted while the door ran and the held lookup finished. */
  unhandled: number;
  outcome: "resolved" | "rejected";
  value: unknown;
}

/** Run one door with the lookup held, and say what had happened by the time it resolved and what landed after. */
async function observe(divisionId: string, op: () => Promise<unknown>, o: { failLookup?: boolean } = {}): Promise<Seen> {
  // Setup's own un-awaited work (the seeding generates) must have landed, or it is counted against this door.
  await sleep(300);
  Object.assign(rig, { armed: true, failLookup: o.failLookup ?? false, held: 0, lookupDone: [], fires: [] });
  let unhandled = 0;
  const onUnhandled = () => void unhandled++;
  process.on("unhandledRejection", onUnhandled);
  let outcome: Seen["outcome"] = "resolved";
  let value: unknown;
  try {
    value = await op();
  } catch {
    outcome = "rejected";
  }
  const resolvedAt = ++rig.seq;
  const lookupsDoneAtResolve = rig.lookupDone.filter((s) => s < resolvedAt).length;
  const mine = () => rig.fires.filter((f) => f.divisionId === divisionId);
  const afterALookup = (f: { seq: number }) => rig.lookupDone.some((d) => d < f.seq);
  const toldBeforeResolve = mine().filter((f) => f.seq < resolvedAt && afterALookup(f)).length;
  await sleep(rig.HOLD_MS + 300);
  process.off("unhandledRejection", onUnhandled);
  const toldAfterResolve = mine().filter((f) => f.seq > resolvedAt && afterALookup(f)).length;
  const held = rig.held;
  const firesInAll = mine().length;
  rig.armed = false;
  return { held, lookupsDoneAtResolve, toldBeforeResolve, toldAfterResolve, firesInAll, unhandled, outcome, value };
}

async function freshLeague() {
  const { auth } = await seedOrg("pro");
  const suffix = randomUUID().slice(0, 8);
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Settle " + suffix, visibility: "private", branding: {} });
  const division = await createDivision(auth, comp.id, { name: "Open", slug: "open-" + suffix, sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG });
  await createEntrants(
    auth,
    division.id,
    Array.from({ length: 4 }, (_, i) => ({ kind: "individual" as const, display_name: `E${i + 1}`, seed: i + 1, members: [] })),
  );
  const [stage] = await createStages(auth, division.id, [{ seq: 1, kind: "league", name: "League", config: {} }]);
  return { auth, divisionId: division.id, stageId: stage!.id };
}

const tip = async (id: string) => (await sql<{ s: number }[]>`select coalesce(max(seq), 0)::int as s from score_events where fixture_id = ${id}`)[0]!.s;

describe.skipIf(!HAS_DB)("a stage write resolves only after the revalidation it owes has been fired (the CI flake, run 40233887793)", () => {
  it("Generate: the stage's lookup finishes and the division is told before the call resolves - the first call, and a second", async () => {
    const t = await freshLeague();
    const first = await observe(t.divisionId, () => generateStageFixtures(t.auth, t.stageId));
    expect(first.outcome).toBe("resolved");
    expect(first.held, "anti-vacuity: the door reached fireStageRevalidate's lookup").toBeGreaterThanOrEqual(1);
    expect(first.lookupsDoneAtResolve, "every lookup had finished when Generate resolved").toBe(first.held);
    expect(first.toldBeforeResolve, "the division was told before Generate resolved").toBeGreaterThanOrEqual(1);
    expect(first.toldAfterResolve, "nothing is told after Generate resolved (that is the entry the next test counted)").toBe(0);

    // The second call (idempotent: it creates nothing) owes the same.
    const again = await observe(t.divisionId, () => generateStageFixtures(t.auth, t.stageId));
    expect(again.held).toBeGreaterThanOrEqual(1);
    expect(again.lookupsDoneAtResolve).toBe(again.held);
    expect(again.toldBeforeResolve).toBeGreaterThanOrEqual(1);
    expect(again.toldAfterResolve).toBe(0);
  }, 60_000);

  it("Complete: the same, on the door that closes a stage; a refused Complete (the empty case) holds no lookup and tells nobody", async () => {
    const s = await seedBracket({ sport: "generic", variant: declaredVariant("generic", "score"), stageKind: "league", entrants: 4 });
    const rows = await sql<{ id: string; away: string }[]>`
      select id, away_entrant_id as away from fixtures where stage_id = ${s.stageId} and home_entrant_id is not null and away_entrant_id is not null`;
    expect(rows.length, "the rig has matches").toBeGreaterThan(1);

    // Nothing is played: Complete is refused before it commits anything, so it has nothing to tell.
    const refused = await observe(s.divisionId, () => completeStage(s.auth, s.stageId));
    expect(refused.value, "an unplayed league does not complete").toMatchObject({ completed: false });
    expect(refused.held, "a Complete that did not complete never looks the stage up for a revalidation").toBe(0);
    expect(refused.firesInAll, "and tells nobody").toBe(0);

    for (const r of rows) {
      await scoreEvent(s.auth, r.id, { expected_seq: await tip(r.id), type: "core.start", payload: {} } as never);
      await scoreEvent(s.auth, r.id, { expected_seq: await tip(r.id), type: "core.forfeit", payload: { by: r.away, reason: "disqualified" } } as never);
    }
    const done = await observe(s.divisionId, () => completeStage(s.auth, s.stageId));
    expect(done.outcome).toBe("resolved");
    expect(done.held, "anti-vacuity: Complete reached fireStageRevalidate's lookup").toBeGreaterThanOrEqual(1);
    expect(done.lookupsDoneAtResolve, "every lookup had finished when Complete resolved").toBe(done.held);
    expect(done.toldBeforeResolve, "the division was told before Complete resolved").toBeGreaterThanOrEqual(1);
    expect(done.toldAfterResolve).toBe(0);
  }, 120_000);

  it("Unpair a Swiss round: the same", async () => {
    const s = await seedBracket({ sport: "generic", variant: declaredVariant("generic", "score"), stageKind: "swiss", entrants: 4, stageConfig: { rounds: 2 } });
    const seen = await observe(s.divisionId, () => unpairSwissRound(s.auth, s.stageId));
    expect(seen.outcome).toBe("resolved");
    expect(seen.held, "anti-vacuity: Unpair reached fireStageRevalidate's lookup").toBeGreaterThanOrEqual(1);
    expect(seen.lookupsDoneAtResolve).toBe(seen.held);
    expect(seen.toldBeforeResolve).toBeGreaterThanOrEqual(1);
    expect(seen.toldAfterResolve).toBe(0);
  }, 60_000);

  it("a revalidation that cannot be looked up never fails the write that already committed", async () => {
    const t = await freshLeague();
    const seen = await observe(t.divisionId, () => generateStageFixtures(t.auth, t.stageId), { failLookup: true });
    expect(seen.held, "anti-vacuity: the lookup was reached, and failed").toBeGreaterThanOrEqual(1);
    expect(seen.outcome, "Generate committed: its caller is not told it failed").toBe("resolved");
    expect(seen.unhandled, "the failure is handled where it happens, not left to reject unobserved").toBe(0);
    expect(seen.toldBeforeResolve + seen.toldAfterResolve, "no lookup, no revalidation from it").toBe(0);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int n from fixtures where stage_id = ${t.stageId}`;
    expect(n, "the write stood").toBeGreaterThan(0);
  }, 60_000);

  it("no call site in stages.ts is left un-awaited (every one is counted)", () => {
    const src = readFileSync(fileURLToPath(new URL("../stages.ts", import.meta.url)), "utf8");
    const sites = src.split("\n").filter((l) => /\bfireStageRevalidate\(/.test(l) && !/function fireStageRevalidate\(/.test(l));
    expect(sites.length, "anti-vacuity: the file calls it").toBeGreaterThan(0);
    const loose = sites.filter((l) => !/\bawait fireStageRevalidate\(/.test(l));
    expect(loose, `${sites.length} call sites checked; these are fired and forgotten`).toEqual([]);
  });
});
