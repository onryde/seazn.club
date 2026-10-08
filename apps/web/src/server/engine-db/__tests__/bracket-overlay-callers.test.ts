// W2a Task 6 — spec §5.4.1 + risk row 1 (the inert seam): the bracket overlay must reach EVERY resolveFixtureCfg
// call site. Each case drives the site's REAL exported entry on real rows and reads what resolveFixtureCfg returned
// THERE, through a spy that wraps the real function. A source scan pins the site count, so a 12th caller fails
// until it has a case. Three sites are driven from the existing suite that already builds their inputs
// (match-centre-load-feeder-read, event-import-dryrun, org-posts-enrichment-sources); `SITES[].case` names them.
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/engine-db/fixture-cfg", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/engine-db/fixture-cfg")>();
  return { ...real, resolveFixtureCfg: vi.fn(real.resolveFixtureCfg) };
});
import { resolveFixtureCfg } from "@/server/engine-db/fixture-cfg";
import { appendEvent, completeStageIfReady, recomputeStandings } from "@/server/engine-db";
import { loadFoldInputs } from "@/server/engine-db/fold";
import { sql, withTenant } from "@/lib/db";
import { loadFixturePadCfg } from "@/server/usecases/fixtures";
import { computePlayerStats } from "@/server/usecases/player-stats";
import { fixtureConfigPanel, resnapshotFixtureConfig } from "@/server/usecases/admin-fixture-config";
import { insertLegacyEvents, seedBracket } from "./helpers/seed-bracket";

const HAS_DB = !!process.env.DATABASE_URL;
const spy = vi.mocked(resolveFixtureCfg);
afterEach(() => spy.mockClear());
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

/** Every call the spy saw, as (stage kind passed, cfg returned). */
const seen = () =>
  spy.mock.calls.map((c, i) => ({
    kind: (c[2] as { kind?: string | null } | null | undefined)?.kind ?? null,
    out: spy.mock.results[i]!.value as Record<string, unknown> | null,
  }));
function expectOverlay(kind: string): void {
  const calls = seen();
  expect(calls.length, "the entry never called resolveFixtureCfg").toBeGreaterThan(0);
  expect(calls.some((c) => c.kind === kind && c.out !== null && c.out.tiebreak === true), JSON.stringify(calls)).toBe(true);
}

const REPO = resolve(__dirname, "../../../../../..");
const CALL = /\bresolveFixtureCfg\(/g;
/** Comments are not call sites: admin-fixture-config.ts says "`resolveFixtureCfg(null, …)` rather than…" in prose. */
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
/** One row per production call site; `case` names the test that drives it. */
const SITES: readonly { file: string; count: number; case: string }[] = [
  { file: "apps/web/src/server/engine-db/fold.ts", count: 1, case: "fold.ts loadFoldInputs" },
  { file: "apps/web/src/server/engine-db/append-event.ts", count: 1, case: "append-event.ts appendEvent" },
  { file: "apps/web/src/server/engine-db/competition.ts", count: 2, case: "competition.ts loadStageInputs" },
  { file: "apps/web/src/server/public-site/match-centre-load.ts", count: 1, case: "match-centre-load.ts loadMatchCentre" },
  { file: "apps/web/src/server/usecases/fixtures.ts", count: 1, case: "fixtures.ts loadFixturePadCfg" },
  { file: "apps/web/src/server/usecases/player-stats.ts", count: 1, case: "player-stats.ts computePlayerStats" },
  { file: "apps/web/src/server/usecases/event-import.ts", count: 1, case: "event-import.ts importEvents" },
  { file: "apps/web/src/server/usecases/admin-fixture-config.ts", count: 2, case: "admin-fixture-config.ts panel and resnapshot" },
  { file: "apps/web/src/server/usecases/org-posts.ts", count: 1, case: "org-posts.ts draftPostsForDecidedFixture" },
];

describe("bracket overlay reaches every resolveFixtureCfg caller (spec §5.4.1)", () => {
  it("the site ledger is exact: 11 production calls, and none unlisted", () => {
    const files: string[] = [];
    (function walk(d: string) {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) {
          if (e !== "__tests__") walk(p);
        } else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) files.push(p);
      }
    })(join(REPO, "apps/web/src"));
    expect(files.length).toBeGreaterThan(0); // the walk read the tree
    const found = new Map<string, number>();
    for (const f of files) {
      const rel = relative(REPO, f);
      if (rel.endsWith("engine-db/fixture-cfg.ts")) continue;
      const n = [...stripComments(readFileSync(f, "utf8")).matchAll(CALL)].length;
      if (n > 0) found.set(rel, n);
    }
    expect(Object.fromEntries(found)).toEqual(Object.fromEntries(SITES.map((s) => [s.file, s.count])));
    expect([...found.values()].reduce((a, b) => a + b, 0)).toBe(11);
  });

  it("the comment stripper keeps a call and drops prose (both directions)", () => {
    expect([...stripComments("const a = resolveFixtureCfg(x); // resolveFixtureCfg(y)").matchAll(CALL)].length).toBe(1);
    expect([...stripComments("/* resolveFixtureCfg(y) */\nconst u = 'http://x'; resolveFixtureCfg(z)").matchAll(CALL)].length).toBe(1);
  });

  it.skipIf(!HAS_DB)("fold.ts loadFoldInputs", async () => {
    const s = await seedBracket({ sport: "boardgame", variant: "classical", stageKind: "knockout", entrants: 2 });
    await insertLegacyEvents(s.fixtureIds[0]!, [{ type: "core.start", payload: {} }]);
    const inputs = await withTenant(s.auth.orgId, (tx) => loadFoldInputs(tx, s.fixtureIds[0]!));
    expect(inputs!.stageKind).toBe("knockout");
    expect((inputs!.cfg as { tiebreak?: unknown }).tiebreak).toBe(true);
    expectOverlay("knockout");
  });

  it.skipIf(!HAS_DB)("append-event.ts appendEvent: the first event freezes the overlay into config_snapshot", async () => {
    const s = await seedBracket({ sport: "boardgame", variant: "classical", stageKind: "knockout", entrants: 2 });
    await appendEvent(s.auth.orgId, s.fixtureIds[0]!, 0, { type: "core.start", payload: {} });
    expectOverlay("knockout");
    const [row] = await sql<{ config_snapshot: Record<string, unknown> }[]>`
      select config_snapshot from fixtures where id = ${s.fixtureIds[0]!}`;
    expect(row!.config_snapshot.tiebreak).toBe(true);
  });

  it.skipIf(!HAS_DB)("competition.ts loadStageInputs: both knockout calls (a decided game, a seeded bye) get the overlay", async () => {
    // Three entrants in a four-draw: one seated semi-final and one bye. Completion reads each fixture's cfg —
    // the played one through the standings delta, the bye through awardByeDelta — and both are bracket fixtures.
    const s = await seedBracket({ sport: "boardgame", variant: "classical", stageKind: "knockout", entrants: 3 });
    const [home] = await sql<{ home_entrant_id: string }[]>`select home_entrant_id from fixtures where id = ${s.fixtureIds[0]!}`;
    await appendEvent(s.auth.orgId, s.fixtureIds[0]!, 0, { type: "core.start", payload: {} });
    await appendEvent(s.auth.orgId, s.fixtureIds[0]!, 1, { type: "boardgame.result", payload: { winner: home!.home_entrant_id, method: "checkmate" } });
    await sql`update fixtures set config_snapshot = null where stage_id = ${s.stageId}`; // legacy shape: live cfg at read
    spy.mockClear();
    await completeStageIfReady(s.auth.orgId, s.stageId);
    const calls = seen();
    expect(calls.length, JSON.stringify(calls)).toBe(2); // the decided semi and the bye, one call each
    for (const c of calls) {
      expect(c.kind).toBe("knockout");
      expect(c.out?.tiebreak, JSON.stringify(calls)).toBe(true);
    }
  });

  it.skipIf(!HAS_DB)("competition.ts loadStageInputs: a league passes its kind and gets NO overlay (the negative pair)", async () => {
    const s = await seedBracket({ sport: "boardgame", variant: "classical", stageKind: "league", entrants: 2 });
    await appendEvent(s.auth.orgId, s.fixtureIds[0]!, 0, { type: "core.start", payload: {} });
    await appendEvent(s.auth.orgId, s.fixtureIds[0]!, 1, { type: "boardgame.result", payload: { winner: null, method: "agreement" } });
    await sql`update fixtures set config_snapshot = null where id = ${s.fixtureIds[0]!}`;
    spy.mockClear();
    await recomputeStandings(s.auth.orgId, s.stageId);
    const calls = seen();
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.kind).toBe("league");
      expect(c.out?.tiebreak).toBeUndefined();
    }
  });

  it.skipIf(!HAS_DB)("fixtures.ts loadFixturePadCfg (feeds the console pad and the device pad)", async () => {
    const s = await seedBracket({ sport: "boardgame", variant: "classical", stageKind: "knockout", entrants: 2 });
    const loaded = await loadFixturePadCfg(s.auth, s.fixtureIds[0]!);
    expect((loaded.cfg as Record<string, unknown>).tiebreak).toBe(true);
    expect(loaded.stageKind).toBe("knockout"); // Task 12 threads it on to the pad
    expectOverlay("knockout");
  });

  it.skipIf(!HAS_DB)("player-stats.ts computePlayerStats", async () => {
    // Boardgame rather than a sport that declares {}: chess has a stats model AND a non-empty overlay, so what the
    // site returned is observable, not only the kind it was handed.
    const s = await seedBracket({ sport: "boardgame", variant: "classical", stageKind: "knockout", entrants: 2 });
    await insertLegacyEvents(s.fixtureIds[0]!, [{ type: "core.start", payload: {} }]);
    await withTenant(s.auth.orgId, (tx) => computePlayerStats(tx, s.divisionId));
    expectOverlay("knockout");
  });

  it.skipIf(!HAS_DB)("admin-fixture-config.ts panel and resnapshot", async () => {
    const s = await seedBracket({ sport: "boardgame", variant: "classical", stageKind: "knockout", entrants: 2 });
    const panel = await fixtureConfigPanel(s.fixtureIds[0]!);
    expect((panel!.live as Record<string, unknown>).tiebreak).toBe(true);
    expectOverlay("knockout");
    spy.mockClear();
    await appendEvent(s.auth.orgId, s.fixtureIds[0]!, 0, { type: "core.start", payload: {} });
    spy.mockClear();
    const suffix = randomUUID().slice(0, 8);
    const [{ id: actorId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, is_staff, staff_role)
      values (${`staff-${suffix}@example.test`}, 'Staff', true, 'superadmin') returning id`;
    await resnapshotFixtureConfig(actorId, s.fixtureIds[0]!, "W2a overlay check");
    expectOverlay("knockout");
    const [row] = await sql<{ config_snapshot: Record<string, unknown> }[]>`
      select config_snapshot from fixtures where id = ${s.fixtureIds[0]!}`;
    expect(row!.config_snapshot.tiebreak).toBe(true); // the re-frozen cfg kept the deciders
  });
});
