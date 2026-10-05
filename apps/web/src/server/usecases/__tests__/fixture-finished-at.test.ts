// single-sport: finished_at keys on fixtures.status; no sport module writes it
//
// V430's `fixtures_track_finished` (capture QR v2 PR-1 T3, spec §8.1, C2/C5, ruling R8 / §17.7).
// `finished_at` is when a fixture entered the finished set, kept in ONE place for every writer:
// entering the set stamps it, staying inside keeps the FIRST stamp, leaving clears it. The code's
// expiry (C2: finished_at + 120 min) reads it, so a stamp that moved on an in-set update would
// push expiry out, and a stamp that survived a reverted result would expire a live code.
//
// Sources of truth — never the trigger under test:
//   - the status vocabulary is V214's CHECK list, parsed from the file (and pinned against the
//     live constraint);
//   - the finished set is spec §3's "finished" row, parsed from the spec.
//
// "Another sport" (R8, A20): no sport module writes fixtures.status, so the sweep runs over the
// STATUS WRITERS, each driven through its real use-case (generic, tennis and boardgame between
// them). The testkit has no per-sport finishing driver (FP22).
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { appendEvent } from "@/server/engine-db";
import { resnapshotFixtureConfig } from "../admin-fixture-config";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { getFixtureState } from "../fixtures";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { createStages, generateStageFixtures, unpairSwissRound } from "../stages";
import { divisionRig } from "./_rig";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;
const ROOT = resolve(import.meta.dirname, "../../../../../..");

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

// ---- the declarations ------------------------------------------------------------------------

const quoted = (list: string): string[] => [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
/** V214: `status text not null default 'scheduled' check (status in ('scheduled', …))`. */
const STATUSES = quoted(
  /\bstatus\s+text not null default 'scheduled' check \(status in\s*\(([^)]*)\)\)/
    .exec(readFileSync(resolve(ROOT, "db/migration/v2-engine/tables/V214__fixtures.sql"), "utf8"))?.[1] ?? "",
);
/** Spec §3: `| **finished** | A fixture status in {`decided`, `finalized`, …}. …|`. */
const FINISHED: ReadonlySet<string> = new Set(
  [...(/^\| \*\*finished\*\* \| A fixture status in \{([^}]*)\}/m
    .exec(readFileSync(resolve(ROOT, "docs/superpowers/specs/2026-10-01-capture-qr-v2-design.md"), "utf8"))?.[1] ?? "")
    .matchAll(/`([a-z_]+)`/g)].map((m) => m[1]!),
);
// "" before the file exists — never a module-scope throw, which would collect zero tests and read green.
const V430_PATH = resolve(ROOT, "db/migration/deltas/V430__capture_stream_codes.sql");
const V430 = existsSync(V430_PATH) ? readFileSync(V430_PATH, "utf8") : "";

/** finished_at at MICROSECOND precision — a JS Date rounds to the millisecond, and two stamps in
 *  one millisecond would read as "kept". */
async function stampOf(fixtureId: string): Promise<bigint | null> {
  const [row] = await sql<{ us: string | null }[]>`
    select (extract(epoch from finished_at) * 1000000)::bigint::text as us from fixtures where id = ${fixtureId}`;
  return row!.us === null ? null : BigInt(row!.us);
}
async function statusOf(fixtureId: string): Promise<string> {
  const [row] = await sql<{ status: string }[]>`select status from fixtures where id = ${fixtureId}`;
  return row!.status;
}
/** The DB's clock, read BEFORE a drive: any stamp the drive writes is >= this. */
async function dbNow(): Promise<bigint> {
  const [row] = await sql<{ us: string }[]>`select (extract(epoch from clock_timestamp()) * 1000000)::bigint::text as us`;
  return BigInt(row!.us);
}

describe("the declarations the trigger is checked against", () => {
  it("V214 declares seven statuses, spec §3's finished set is five of them, and the rest is exactly scheduled and in_play", () => {
    expect(STATUSES).toHaveLength(7);
    expect(FINISHED.size).toBe(5);
    for (const s of FINISHED) expect(STATUSES, s).toContain(s);
    expect(STATUSES.filter((s) => !FINISHED.has(s)).sort()).toEqual(["in_play", "scheduled"]);
  });

  it("V430's trigger and backfill name exactly spec §3's finished set (three lists, read off the file)", () => {
    const lists = [
      /if new\.status in \(([^)]*)\)/.exec(V430)?.[1],
      /old\.status not in \(([^)]*)\)/.exec(V430)?.[1],
      /update fixtures set finished_at = now\(\) where status in \(([^)]*)\)/.exec(V430)?.[1],
    ];
    let checked = 0;
    for (const l of lists) {
      expect(l, "a list V430 should carry").toBeDefined();
      expect(quoted(l!).sort()).toEqual([...FINISHED].sort());
      checked++;
    }
    expect(checked).toBe(3);
  });
});

describe.skipIf(!HAS_DB)("fixtures_track_finished — every status pair, insert, and a non-status update", () => {
  it("V214 is still the live vocabulary: fixtures_status_check lists exactly its seven", async () => {
    const [def] = await sql<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'fixtures'::regclass and conname = 'fixtures_status_check'`;
    expect([...def!.def.matchAll(/'([^']+)'::text/g)].map((m) => m[1]!).sort()).toEqual([...STATUSES].sort());
  });

  it("all 49 (A → B) pairs over V214's statuses: entering stamps, staying inside keeps the first stamp, leaving clears", async () => {
    const { auth } = await seedOrg("pro");
    const { fixtureIds } = await divisionRig(auth, { entrants: 2 });
    const fx = fixtureIds[0]!;
    // A first stamp the trigger could never write itself, so "kept" cannot be confused with "re-stamped".
    const SENTINEL = "2001-02-03 04:05:06.789012+00";
    const [{ us: sentinelUs }] = await sql<{ us: string }[]>`select (extract(epoch from ${SENTINEL}::timestamptz) * 1000000)::bigint::text as us`;
    const tally = { stamped: 0, kept: 0, cleared: 0 };
    let pairs = 0;
    for (const a of STATUSES) {
      for (const b of STATUSES) {
        const label = `${a} → ${b}`;
        await sql`update fixtures set status = ${a} where id = ${fx}`;
        if (FINISHED.has(a)) {
          await sql`update fixtures set finished_at = ${SENTINEL}::timestamptz where id = ${fx}`;   // names no status: no trigger
        } else {
          expect(await stampOf(fx), `${label}: ${a} holds no stamp`).toBeNull();
        }
        const t0 = await dbNow();
        await sql`update fixtures set status = ${b} where id = ${fx}`;
        const after = await stampOf(fx);
        if (!FINISHED.has(b)) {
          expect(after, `${label}: leaving (or staying out of) the set clears`).toBeNull();
          tally.cleared++;
        } else if (FINISHED.has(a)) {
          expect(after, `${label}: staying inside the set keeps the first stamp`).toBe(BigInt(sentinelUs));
          tally.kept++;
        } else {
          expect(after, `${label}: entering the set stamps`).not.toBeNull();
          expect(after! >= t0, `${label}: the stamp is this update's`).toBe(true);
          tally.stamped++;
        }
        pairs++;
      }
    }
    expect(pairs).toBe(49);
    // Each branch was walked as often as the set sizes say — none is vacuous.
    const f = FINISHED.size, n = STATUSES.length - FINISHED.size;
    expect(tally).toEqual({ stamped: n * f, kept: f * f, cleared: STATUSES.length * n });
  });

  it("INSERT that supplies no stamp: a row inserted in a finished status is stamped; one inserted unfinished is not", async () => {
    const { auth } = await seedOrg("pro");
    const { fixtureIds } = await divisionRig(auth, { entrants: 2 });
    let checked = 0;
    for (const [i, status] of STATUSES.entries()) {
      const t0 = await dbNow();
      const [row] = await sql<{ id: string }[]>`
        insert into fixtures (stage_id, division_id, round_no, seq_in_round, status)
        select stage_id, division_id, 90, ${i + 1}, ${status} from fixtures where id = ${fixtureIds[0]!}
        returning id`;
      const stamp = await stampOf(row!.id);
      if (FINISHED.has(status)) {
        expect(stamp, status).not.toBeNull();
        expect(stamp! >= t0, status).toBe(true);
      } else {
        expect(stamp, status).toBeNull();
      }
      checked++;
    }
    expect(checked).toBe(STATUSES.length);
  });

  // C-2 (B3 review): history Undo/restore re-inserts a snapshotted row WITH its own finished_at
  // (history.ts restoreFixtures). The INSERT arm keeps a supplied stamp; it stamps now() only when
  // the insert supplies none (the case above). Leaving the set still clears it, and the row's next
  // fresh entry into the set is stamped anew — the supplied stamp is not sticky.
  it("INSERT that SUPPLIES finished_at (history restore): kept in a finished status, cleared in an unfinished one; leaving and re-entering the set stamps anew", async () => {
    const { auth } = await seedOrg("pro");
    const { fixtureIds } = await divisionRig(auth, { entrants: 2 });
    // Bound as TEXT: a timestamp-typed parameter goes through a JS Date and loses the microseconds.
    const SUPPLIED = "2020-01-02T03:04:05.678901Z";
    const suppliedUs = BigInt(Date.UTC(2020, 0, 2, 3, 4, 5, 678)) * 1000n + 901n;
    const insertWith = async (round: number, seq: number, status: string): Promise<string> => {
      const [row] = await sql<{ id: string }[]>`
        insert into fixtures (stage_id, division_id, round_no, seq_in_round, status, finished_at)
        select stage_id, division_id, ${round}, ${seq}, ${status}, ${SUPPLIED}::text::timestamptz
        from fixtures where id = ${fixtureIds[0]!}
        returning id`;
      return row!.id;
    };
    let kept = 0;
    let cleared = 0;
    for (const [i, status] of STATUSES.entries()) {
      const stamp = await stampOf(await insertWith(91, i + 1, status));
      if (FINISHED.has(status)) {
        expect(stamp, status).toBe(suppliedUs);
        kept++;
      } else {
        expect(stamp, status).toBeNull();
        cleared++;
      }
    }
    // The split is the declarations' own: §3's set against V214's vocabulary.
    expect({ kept, cleared }).toEqual({
      kept: STATUSES.filter((s) => FINISHED.has(s)).length,
      cleared: STATUSES.filter((s) => !FINISHED.has(s)).length,
    });
    expect(kept).toBeGreaterThan(0);
    expect(cleared).toBeGreaterThan(0);

    // The sequence after a restore: kept → an in-set move keeps it → leaving clears it → a fresh
    // entry stamps NOW, never the supplied value back.
    const [inSet, otherInSet] = STATUSES.filter((s) => FINISHED.has(s));
    const open = STATUSES.find((s) => !FINISHED.has(s))!;
    const fx = await insertWith(92, 1, inSet!);
    expect(await stampOf(fx)).toBe(suppliedUs);
    await sql`update fixtures set status = ${otherInSet!} where id = ${fx}`;
    expect(await stampOf(fx), "an in-set move keeps the restored stamp").toBe(suppliedUs);
    await sql`update fixtures set status = ${open} where id = ${fx}`;
    expect(await stampOf(fx)).toBeNull();
    const t0 = await dbNow();
    await sql`update fixtures set status = ${inSet!} where id = ${fx}`;
    const fresh = await stampOf(fx);
    expect(fresh).not.toBeNull();
    expect(fresh! >= t0, "a fresh entry is stamped by the trigger").toBe(true);
    expect(fresh).not.toBe(suppliedUs);
  });

  it("an update that does not NAME status never moves finished_at — the trigger is `update of status` (why the backfill cannot be re-stamped by it)", async () => {
    const { auth } = await seedOrg("pro");
    const { fixtureIds } = await divisionRig(auth, { entrants: 2 });
    const fx = fixtureIds[0]!;
    await sql`update fixtures set status = 'decided' where id = ${fx}`;
    const first = await stampOf(fx);
    expect(first).not.toBeNull();
    await sql`update fixtures set scheduled_at = now(), outcome = '{"kind":"draw"}'::jsonb where id = ${fx}`;
    expect(await stampOf(fx)).toBe(first);
    // The backfill's own statement, scoped to this row: a pre-V430 finished row (stamp null) gains one,
    // and its next in-set status update keeps it.
    await sql`update fixtures set finished_at = null where id = ${fx}`;
    const backfill = /update fixtures set finished_at = now\(\) where status in \([^)]*\)/.exec(V430)?.[0];
    expect(backfill).toBeDefined();
    await sql.unsafe(`${backfill} and id = $1`, [fx]);
    const backfilled = await stampOf(fx);
    expect(backfilled).not.toBeNull();
    await sql`update fixtures set status = 'finalized' where id = ${fx}`;
    expect(await stampOf(fx), "a backfilled stamp survives its next in-set update").toBe(backfilled);
  });
});

// ---- the status writers (R8): each driven through its real use-case --------------------------
//
// Re-pinned by behaviour (`grep -rn -a` for writes of fixtures.status under apps/web/src/server).
// Each name is the SQL site that writes the status; the cases below drive it.
const WRITERS = [
  "engine-db/append-event.ts (the fold: decide, walkover, abandon, finalize, void)",
  "usecases/admin-fixture-config.ts (resnapshotFixtureConfig: the admin correction)",
  "usecases/stages.ts (Pair next: the Swiss bye is forfeited)",
  "usecases/stages.ts (clearSwissFixtureSeats: Unpair puts the bye back to scheduled)",
  "usecases/stages.ts (awardSeededByes: a knockout's seeded bye is forfeited)",
] as const;
type Writer = (typeof WRITERS)[number];
const swept = new Set<Writer>();

async function scoreNext(auth: AuthCtx, fixtureId: string, type: string, payload: Record<string, unknown>) {
  const { last_seq } = await getFixtureState(auth, fixtureId);
  return scoreEvent(auth, fixtureId, { expected_seq: last_seq, type, payload });
}

async function boardgameStage(auth: AuthCtx, kind: "swiss" | "knockout", config: Record<string, unknown>, entrants: number) {
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31", name: "Finished-at " + randomUUID().slice(0, 6), visibility: "private", branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open", slug: "open-" + randomUUID().slice(0, 6), sport_key: "boardgame", variant_key: "classical", config: {},
  });
  await createEntrants(auth, division.id, Array.from({ length: entrants }, (_, i) => ({
    kind: "individual" as const, display_name: `P${i + 1}`, seed: i + 1, members: [],
  })));
  const [stage] = await createStages(auth, division.id, { seq: 1, kind, name: kind, config, progression: null });
  return { divisionId: division.id, stageId: stage!.id };
}

describe.skipIf(!HAS_DB)("finished_at through every status writer (R8: the 'another sport' sweep)", () => {
  it("the fold (generic): a result stamps; a void reverts it (C5) and clears; the re-decided result stamps a NEW time; finalize keeps it", async () => {
    const { auth } = await seedOrg("pro");
    const { fixtureIds } = await divisionRig(auth, { entrants: 2 });
    const fx = fixtureIds[0]!;
    await scoreNext(auth, fx, "core.start", {});
    expect(await stampOf(fx), "in_play is not finished").toBeNull();
    const t0 = await dbNow();
    await scoreNext(auth, fx, "generic.result", { p1Score: 3, p2Score: 1 });
    expect(await statusOf(fx)).toBe("decided");
    const first = await stampOf(fx);
    expect(first !== null && first >= t0, "a result stamps").toBe(true);

    // C5: the corrected result moves the fixture OUT of the finished set.
    const [result] = await sql<{ id: string }[]>`
      select id from score_events where fixture_id = ${fx} and type = 'generic.result' order by seq desc limit 1`;
    await scoreNext(auth, fx, "core.void", { event_id: result!.id });
    expect(await statusOf(fx)).toBe("in_play");
    expect(await stampOf(fx), "a reverted result clears the stamp").toBeNull();

    await scoreNext(auth, fx, "generic.result", { p1Score: 1, p2Score: 3 });
    const second = await stampOf(fx);
    expect(second !== null && second > first!, "finishing again stamps a NEW time").toBe(true);

    await scoreNext(auth, fx, "core.finalize", {});
    expect(await statusOf(fx)).toBe("finalized");
    expect(await stampOf(fx), "decided → finalized stays inside the set: the first stamp is kept").toBe(second);
    swept.add(WRITERS[0]);
  });

  it("the fold (generic): a walkover (core.forfeit) stamps, and an abandon stamps", async () => {
    const { auth } = await seedOrg("pro");
    const { fixtureIds } = await divisionRig(auth, { entrants: 3 });
    const seated = await sql<{ id: string }[]>`
      select id from fixtures where id = any(${fixtureIds}) and home_entrant_id is not null and away_entrant_id is not null
       order by round_no, seq_in_round`;
    expect(seated.length, "three entrants' round robin seats at least two matches").toBeGreaterThanOrEqual(2);
    const [walkover, abandoned] = [seated[0]!.id, seated[1]!.id];
    const [{ home }] = await sql<{ home: string }[]>`select home_entrant_id as home from fixtures where id = ${walkover}`;
    let t0 = await dbNow();
    await scoreNext(auth, walkover, "core.forfeit", { by: home, reason: "walkover" });
    expect(await statusOf(walkover)).toBe("forfeited");
    let stamp = await stampOf(walkover);
    expect(stamp !== null && stamp >= t0, "a walkover stamps").toBe(true);

    await scoreNext(auth, abandoned, "core.start", {});
    expect(await stampOf(abandoned)).toBeNull();
    t0 = await dbNow();
    await scoreNext(auth, abandoned, "core.abandon", { reason: "rain" });
    expect(await statusOf(abandoned)).toBe("abandoned");
    stamp = await stampOf(abandoned);
    expect(stamp !== null && stamp >= t0, "an abandon stamps").toBe(true);
    swept.add(WRITERS[0]);
  });

  it("the admin correction (tennis): a re-snapshot that un-decides clears the stamp; one that decides again stamps anew", async () => {
    const suffix = randomUUID().slice(0, 8);
    const BEST_OF_3 = { bestOf: 3, set: { gamesTo: 6, winBy: 2, tiebreakAt: 6, tiebreakTo: 7 }, finalSet: "same",
      game: { noAd: false }, tiebreak: { winBy: 2 }, points: { win: 2, loss: 0 } };
    const [{ id: actorId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, is_staff, staff_role)
      values (${`staff-${suffix}@example.test`}, 'Staff', true, 'superadmin') returning id`;
    const [{ id: orgId }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug) values (${"Org " + suffix}, ${"org-" + suffix}) returning id`;
    const [{ id: competitionId }] = await sql<{ id: string }[]>`
      insert into competitions (org_id, name, slug, visibility) values (${orgId}, ${"Comp " + suffix}, ${"comp-" + suffix}, 'private') returning id`;
    const [{ id: divisionId }] = await sql<{ id: string }[]>`
      insert into divisions (competition_id, name, slug, sport_key, variant_key, config, module_version)
      values (${competitionId}, 'Div', ${"div-" + suffix}, 'tennis', 'score', ${sql.json(BEST_OF_3)}, '1.0.0') returning id`;
    const [{ id: stageId }] = await sql<{ id: string }[]>`
      insert into stages (division_id, seq, kind, name, config) values (${divisionId}, 1, 'league', 'Stage', ${sql.json({})}) returning id`;
    const [{ id: home }] = await sql<{ id: string }[]>`
      insert into entrants (division_id, kind, display_name, seed) values (${divisionId}, 'individual', 'Home', 1) returning id`;
    const [{ id: away }] = await sql<{ id: string }[]>`
      insert into entrants (division_id, kind, display_name, seed) values (${divisionId}, 'individual', 'Away', 2) returning id`;
    const [{ id: fx }] = await sql<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, round_no, seq_in_round, home_entrant_id, away_entrant_id)
      values (${stageId}, ${divisionId}, 1, 1, ${home}, ${away}) returning id`;
    await appendEvent(orgId, fx, 0, { type: "core.start", payload: {} });
    await appendEvent(orgId, fx, 1, { type: "tennis.set_summary", payload: { home: 6, away: 4 } });
    await appendEvent(orgId, fx, 2, { type: "tennis.set_summary", payload: { home: 6, away: 3 } });
    expect(await statusOf(fx)).toBe("decided");
    const first = await stampOf(fx);
    expect(first).not.toBeNull();

    await sql`update divisions set config = ${sql.json({ ...BEST_OF_3, bestOf: 5 })} where id = ${divisionId}`;
    await resnapshotFixtureConfig(actorId, fx, "the league is best of five");
    expect(await statusOf(fx)).toBe("in_play");
    expect(await stampOf(fx), "an admin correction that un-decides clears the stamp").toBeNull();

    await sql`update divisions set config = ${sql.json(BEST_OF_3)} where id = ${divisionId}`;
    const t0 = await dbNow();
    await resnapshotFixtureConfig(actorId, fx, "it was best of three after all");
    expect(await statusOf(fx)).toBe("decided");
    const again = await stampOf(fx);
    expect(again !== null && again >= t0 && again > first!, "deciding again stamps a NEW time").toBe(true);
    swept.add(WRITERS[1]);
  });

  it("Swiss (boardgame, odd field): Pair next forfeits the bye and stamps it; Unpair clears it; a second Pair stamps a NEW time", async () => {
    const { auth } = await seedOrg("pro");
    const { divisionId, stageId } = await boardgameStage(auth, "swiss", { rounds: 2 }, 5);
    await startDivision(auth, divisionId);                                    // mints the shells
    const byeRow = async () => (await sql<{ id: string; status: string }[]>`
      select id, status from fixtures where stage_id = ${stageId} and round_no = 1 and ext_key like '%-bye'`)[0];
    const shell = await byeRow();
    expect(shell, "a five-entrant round 1 has a bye shell").toBeDefined();
    expect(await stampOf(shell!.id)).toBeNull();

    let t0 = await dbNow();
    await generateStageFixtures(auth, stageId);                               // Pair next
    expect((await byeRow())!.status).toBe("forfeited");
    const first = await stampOf(shell!.id);
    expect(first !== null && first >= t0, "the Swiss bye is stamped").toBe(true);
    swept.add(WRITERS[2]);

    await unpairSwissRound(auth, stageId);
    expect((await byeRow())!.status).toBe("scheduled");
    expect(await stampOf(shell!.id), "Unpair moves the bye OUT of the set: cleared").toBeNull();
    swept.add(WRITERS[3]);

    t0 = await dbNow();
    await generateStageFixtures(auth, stageId);                               // the second call
    expect((await byeRow())!.status).toBe("forfeited");
    const second = await stampOf(shell!.id);
    expect(second !== null && second >= t0 && second > first!, "re-paired: a NEW stamp").toBe(true);
  });

  it("knockout (boardgame, five entrants): every seeded bye is forfeited by awardSeededByes and stamped", async () => {
    const { auth } = await seedOrg("pro");
    const { divisionId, stageId } = await boardgameStage(auth, "knockout", {}, 5);
    const t0 = await dbNow();
    await startDivision(auth, divisionId);
    await generateStageFixtures(auth, stageId);
    const byes = await sql<{ id: string; status: string }[]>`
      select id, status from fixtures
       where stage_id = ${stageId} and outcome->>'kind' = 'award' and (home_entrant_id is null) <> (away_entrant_id is null)`;
    expect(byes.length, "the premise: five into a knockout seeds byes").toBeGreaterThan(0);
    for (const b of byes) {
      expect(b.status).toBe("forfeited");
      const stamp = await stampOf(b.id);
      expect(stamp !== null && stamp >= t0, b.id).toBe(true);
    }
    swept.add(WRITERS[4]);
  });

  it("anti-vacuity: every writer named above was swept, and there is at least one", () => {
    expect(WRITERS.length).toBeGreaterThan(0);
    expect([...swept].sort()).toEqual([...WRITERS].sort());
  });
});
