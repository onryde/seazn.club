// W2a Task 6 — spec §5.4.1 + risk row 1 (the inert seam): the bracket overlay must reach EVERY resolveFixtureCfg
// call site. Each case drives the site's REAL exported entry on real rows and reads what resolveFixtureCfg returned
// THERE, through a spy that wraps the real function. A source scan pins the site count, so a 13th caller fails
// until it has a case.
//
// W2c Task 10 (spec §4.4, D4) — the same ledger proves the fixture's OWN match override (`fixtures.rules_override`)
// reaches every one of those sites. The resolver now takes the fixture ROW, so tsc forces each caller to pass a
// `rules_override` — but tsc cannot read the SQL text, and a select that forgot the column hands the resolver
// `undefined`, which it reads as "no override" and says nothing. So every case below seeds an override on its
// fixture BEFORE invoking the entry and asserts that every call the entry made carried it, and — where the fixture
// has no frozen snapshot — that the cfg handed back carries it last. All the sites are driven from THIS file, the
// three whose W2a overlay case lives in their own suite (match-centre-load-feeder-read, event-import-dryrun,
// org-posts-enrichment-sources) included.
//
// W2c Task 14 (the §8 seam). The writer (`usecases/fixture-rules.ts` `writeFixtureRulesOverride`) is now the only
// production producer of the column. The W2a cases below ride BOARDGAME, whose bracket overlay is observable — and
// boardgame declares no match-scoped key, so the writer refuses every override on it (RULE_NOT_SETTABLE); their raw
// seeding stays a plumbing witness of the readers. The badminton describe at the end drives the REAL producer: the
// writer's own stored override, through the pad, the fold, the freeze and a live correction. Task 14 also adds a
// 13th site (`fixture-override-guards.ts`, a division save re-checking every unstarted match's own format).
//
// W2c batch-5 fix (review Q1): the 16th site, `public-site/stage-format-lines.ts` - the stage chip and the hub line, which
// resolve the cfg of a STAGE (no fixture) and so take no match override BY CONSTRUCTION. Its row says `override: false`; its
// case drives the real entry and asserts the bracket overlay reached it and that the call carried `rules_override: null`.
// The line itself cannot witness the overlay (`describeDeciders` lays `bracketDeciders` over its cfg again), so the case
// reads what the RESOLVER returned there, through the spy.
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

/** One stack per resolver call, in call order: which production line made it. `spy.mockClear()` does not touch it,
 *  so the calls since the last clear are always its last `spy.mock.calls.length` entries. */
const STACKS = vi.hoisted(() => [] as string[]);
vi.mock("@/server/engine-db/fixture-cfg", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/engine-db/fixture-cfg")>();
  return {
    ...real,
    resolveFixtureCfg: vi.fn((...args: Parameters<typeof real.resolveFixtureCfg>) => {
      const limit = Error.stackTraceLimit;
      Error.stackTraceLimit = 50;
      STACKS.push(new Error().stack ?? "");
      Error.stackTraceLimit = limit;
      return real.resolveFixtureCfg(...args);
    }),
  };
});
import { builtinModules } from "@seazn/engine/sports";
import { resolveFixtureCfg } from "@/server/engine-db/fixture-cfg";
import { appendEvent, completeStageIfReady, recomputeStandings } from "@/server/engine-db";
import { loadFoldInputs } from "@/server/engine-db/fold";
import { sql, withTenant } from "@/lib/db";
import type { MessageKey } from "@/lib/messages";
import { msgFor } from "@/lib/messages-i18n";
import type { PublicFixture } from "@/server/public-site/data";
import { loadMatchCentre, type MatchCentreLoadCtx } from "@/server/public-site/match-centre-load";
import { importEvents } from "@/server/usecases/event-import";
import { loadFixturePadCfg } from "@/server/usecases/fixtures";
import { draftPostsForDecidedFixture } from "@/server/usecases/org-posts";
import { computePlayerStats } from "@/server/usecases/player-stats";
import { fixtureConfigPanel, resnapshotFixtureConfig } from "@/server/usecases/admin-fixture-config";
import { stageFormatLines } from "@/server/public-site/stage-format-lines";
import { patchDivision } from "@/server/usecases/divisions";
import { writeFixtureRulesOverride } from "@/server/usecases/fixture-rules";
import { writeAwardedMatchState } from "@/server/engine-db/awarded-state";
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

/** The brief's override: badminton's match-scoped `bestOf` (spec §4.1 Q5). Boardgame — the sport the W2a cases ride,
 *  because its bracket overlay is observable — declares NO match-scoped key, so on a boardgame row this is a
 *  plumbing witness, not a format a writer would accept; the resolver merges without validating (Task 14's writer
 *  validates). Boardgame's cfg has no `bestOf`, so the key reads back only if the override landed. */
const OVERRIDE = { bestOf: 1 } as const;
async function seedOverride(where: { fixtureId: string } | { stageId: string }): Promise<void> {
  const n =
    "fixtureId" in where
      ? await sql`update fixtures set rules_override = ${sql.json(OVERRIDE as never)} where id = ${where.fixtureId}`
      : await sql`update fixtures set rules_override = ${sql.json(OVERRIDE as never)} where stage_id = ${where.stageId}`;
  expect(n.count, "the override was written").toBeGreaterThan(0);
}
/** The production call site (repo-relative `file:line:col`) that made a resolver call, read off the call's own stack:
 *  the first frame under apps/web/src that is neither a test nor the resolver itself. */
function callSite(stack: string): string {
  for (const line of stack.split("\n")) {
    const m = /(apps\/web\/src\/[^\s():?]+\.tsx?)(?:\?[^\s:)]*)?:(\d+):(\d+)/.exec(line);
    if (m && !m[1]!.includes("/__tests__/") && !m[1]!.endsWith("engine-db/fixture-cfg.ts")) return `${m[1]}:${m[2]}:${m[3]}`;
  }
  throw new Error(`no production frame in the resolver call's stack:\n${stack}`);
}
/** M3 (review): every call site a case DROVE with the override, as the spy saw it — never a case's own claim. */
const DRIVEN = new Set<string>();
/** Every call the entry made carried the fixture row's override (the brief's `calls.at(-1)` check, on every call);
 *  returns how many calls that was, which is never 0. Each call's site goes into DRIVEN. */
function expectOverrideArg(): number {
  const calls = spy.mock.calls;
  expect(calls.length, "the entry never called resolveFixtureCfg").toBeGreaterThan(0);
  expect(spy.mock.calls.at(-1)![0]).toMatchObject({ rules_override: OVERRIDE });
  for (const c of calls) expect(c[0], JSON.stringify(c[0])).toMatchObject({ rules_override: OVERRIDE });
  const stacks = STACKS.slice(-calls.length);
  expect(stacks, "one stack per call since the last clear").toHaveLength(calls.length);
  for (const st of stacks) DRIVEN.add(callSite(st));
  return calls.length;
}
/** The sites a case drove WITHOUT an override, because the site has no fixture row to take one from (`override: false`
 *  in SITES): a stage's own line. Each call must carry exactly the null override - a fixture's override reaching a stage
 *  line would be a stage that plays one match's format. */
const DRIVEN_NO_OVERRIDE = new Set<string>();
function expectNoOverrideArg(): number {
  const calls = spy.mock.calls;
  expect(calls.length, "the entry never called resolveFixtureCfg").toBeGreaterThan(0);
  for (const c of calls) expect(c[0], JSON.stringify(c[0])).toEqual({ config_snapshot: null, rules_override: null });
  const stacks = STACKS.slice(-calls.length);
  expect(stacks, "one stack per call since the last clear").toHaveLength(calls.length);
  for (const st of stacks) DRIVEN_NO_OVERRIDE.add(callSite(st));
  return calls.length;
}
/** …and a call of `kind` handed back a LIVE cfg with the override merged (the fixture had no frozen snapshot). */
function expectOverrideOut(kind: string): void {
  const calls = seen();
  expect(calls.some((c) => c.kind === kind && c.out !== null && c.out.bestOf === OVERRIDE.bestOf), JSON.stringify(calls)).toBe(true);
}

const REPO = resolve(__dirname, "../../../../../..");
const CALL = /\bresolveFixtureCfg\(/g;
/** Comments are not call sites: admin-fixture-config.ts says "`resolveFixtureCfg({ config_snapshot: null, … }, …)`
 *  rather than…" in prose. */
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
/** One row per production call site; `case` names the test that drives it. */
const SITES: readonly { file: string; count: number; case: string; override?: false }[] = [
  { file: "apps/web/src/server/engine-db/fold.ts", count: 1, case: "fold.ts loadFoldInputs" },
  // W2c Task 15 (X-SR-7): the second is the refusal's format line — the rules that stand, named for the refused pad
  // (rules-version.test.ts pins it against the describer over `loadFixturePadCfg`'s cfg).
  { file: "apps/web/src/server/engine-db/append-event.ts", count: 2, case: "append-event.ts appendEvent" },
  { file: "apps/web/src/server/engine-db/competition.ts", count: 2, case: "competition.ts loadStageInputs" },
  { file: "apps/web/src/server/public-site/match-centre-load.ts", count: 1, case: "match-centre-load.ts loadMatchCentre" },
  { file: "apps/web/src/server/usecases/fixtures.ts", count: 1, case: "fixtures.ts loadFixturePadCfg" },
  { file: "apps/web/src/server/usecases/player-stats.ts", count: 1, case: "player-stats.ts computePlayerStats" },
  { file: "apps/web/src/server/usecases/event-import.ts", count: 1, case: "event-import.ts importEvents" },
  { file: "apps/web/src/server/usecases/admin-fixture-config.ts", count: 2, case: "admin-fixture-config.ts panel and resnapshot" },
  { file: "apps/web/src/server/usecases/org-posts.ts", count: 1, case: "org-posts.ts draftPostsForDecidedFixture" },
  // R116-2 (W2b Task 16): the score of ruling 116's walkover, which no event records.
  { file: "apps/web/src/server/engine-db/awarded-state.ts", count: 1, case: "awarded-state.ts writeAwardedMatchState" },
  // W2c Task 14 (I-A one layer up): a division save re-resolves every unstarted match's own format.
  { file: "apps/web/src/server/usecases/fixture-override-guards.ts", count: 1, case: "fixture-override-guards.ts refuseInvalidatedOverrides" },
  // W2c Task 15 fix round 1 (I-1): a format save re-resolves every unfrozen match before and after it writes, and bumps
  // the version of each whose format moved — so a pad open before kickoff is refused rather than frozen under.
  { file: "apps/web/src/server/engine-db/rules-version.ts", count: 1, case: "rules-version.ts unfrozenRules" },
  // W2c Task 16 (batch-5 review Q1): the stage chip and the hub line resolve the cfg of a STAGE - a fixture-less call with
  // `config_snapshot: null, rules_override: null` - so the overlay is the whole of what reaches it. `override: false`.
  { file: "apps/web/src/server/public-site/stage-format-lines.ts", count: 1, case: "stage-format-lines.ts stageFormatLines", override: false },
];
/** The ledger's total, which the source scan and the driven set must both reach. */
const SITE_TOTAL = SITES.reduce((n, s) => n + s.count, 0);

describe("bracket overlay reaches every resolveFixtureCfg caller (spec §5.4.1)", () => {
  it("the site ledger is exact: 16 production calls, and none unlisted", () => {
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
    expect([...found.values()].reduce((a, b) => a + b, 0)).toBe(16);
    expect(SITE_TOTAL, "the ledger's own rows add up to the scan").toBe(16);
  });

  it("the comment stripper keeps a call and drops prose (both directions)", () => {
    expect([...stripComments("const a = resolveFixtureCfg(x); // resolveFixtureCfg(y)").matchAll(CALL)].length).toBe(1);
    expect([...stripComments("/* resolveFixtureCfg(y) */\nconst u = 'http://x'; resolveFixtureCfg(z)").matchAll(CALL)].length).toBe(1);
  });

  it.skipIf(!HAS_DB)("fold.ts loadFoldInputs", async () => {
    const s = await seedBracket({ sport: "boardgame", variant: "classical", stageKind: "knockout", entrants: 2 });
    await seedOverride({ fixtureId: s.fixtureIds[0]! });
    await insertLegacyEvents(s.fixtureIds[0]!, [{ type: "core.start", payload: {} }]);
    const inputs = await withTenant(s.auth.orgId, (tx) => loadFoldInputs(tx, s.fixtureIds[0]!));
    expect(inputs!.stageKind).toBe("knockout");
    expect((inputs!.cfg as { tiebreak?: unknown }).tiebreak).toBe(true);
    expect((inputs!.cfg as { bestOf?: unknown }).bestOf, "W2c: the fold reads the match override").toBe(OVERRIDE.bestOf);
    expectOverlay("knockout");
    expectOverrideArg();
  });

  it.skipIf(!HAS_DB)("append-event.ts appendEvent: the first event freezes the overlay into config_snapshot", async () => {
    const s = await seedBracket({ sport: "boardgame", variant: "classical", stageKind: "knockout", entrants: 2 });
    await seedOverride({ fixtureId: s.fixtureIds[0]! });
    await appendEvent(s.auth.orgId, s.fixtureIds[0]!, 0, { type: "core.start", payload: {} });
    expectOverlay("knockout");
    expectOverrideArg();
    const [row] = await sql<{ config_snapshot: Record<string, unknown> }[]>`
      select config_snapshot from fixtures where id = ${s.fixtureIds[0]!}`;
    expect(row!.config_snapshot.tiebreak).toBe(true);
    // Spec §4.4: at the first event the override is frozen with everything else.
    expect(row!.config_snapshot.bestOf, "W2c: the override was frozen at the first event").toBe(OVERRIDE.bestOf);
  });

  it.skipIf(!HAS_DB)("append-event.ts appendEvent: the X-SR-7 refusal names the format the match plays now, overlay and override in", async () => {
    // W2c Task 15: a pad's tap under an old rules version is refused with the rules that stand — read through the same
    // resolver, so a bracket match's refusal names its deciders and its own format, not the bare division's.
    const s = await seedBracket({ sport: "boardgame", variant: "classical", stageKind: "knockout", entrants: 2 });
    const id = s.fixtureIds[0]!;
    await seedOverride({ fixtureId: id });
    await appendEvent(s.auth.orgId, id, 0, { type: "core.start", payload: {} });
    // A correction's bump (a started match's is `refreezeFixture`'s; the version is all this case needs).
    await sql`update fixtures set rules_version = rules_version + 1 where id = ${id}`;
    spy.mockClear();
    await expect(
      appendEvent(s.auth.orgId, id, 1, { type: "core.start", payload: {}, rulesVersion: 0 }),
    ).rejects.toMatchObject({ code: "FIXTURE_RULES_CHANGED" });
    expect(expectOverrideArg(), "the refusal is the only resolver call: it comes before anything else reads the cfg").toBe(1);
    expectOverlay("knockout");
  });

  it.skipIf(!HAS_DB)("competition.ts loadStageInputs: both knockout calls (a decided game, a seeded bye) get the overlay", async () => {
    // Three entrants in a four-draw: one seated semi-final and one bye. Completion reads each fixture's cfg —
    // the played one through the standings delta, the bye through awardByeDelta — and both are bracket fixtures.
    const s = await seedBracket({ sport: "boardgame", variant: "classical", stageKind: "knockout", entrants: 3 });
    await seedOverride({ stageId: s.stageId }); // the bye's row too: it is the second call's fixture
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
      expect(c.out?.bestOf, `W2c: ${JSON.stringify(calls)}`).toBe(OVERRIDE.bestOf);
    }
    expect(expectOverrideArg()).toBe(2);
  });

  it.skipIf(!HAS_DB)("competition.ts loadStageInputs: a league passes its kind and gets NO overlay (the negative pair)", async () => {
    const s = await seedBracket({ sport: "boardgame", variant: "classical", stageKind: "league", entrants: 2 });
    await seedOverride({ fixtureId: s.fixtureIds[0]! });
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
    // W2c: the override is no bracket decider — it lands in a league exactly as in a knockout.
    expectOverrideOut("league");
    expectOverrideArg();
  });

  it.skipIf(!HAS_DB)("fixtures.ts loadFixturePadCfg (feeds the console pad and the device pad)", async () => {
    const s = await seedBracket({ sport: "boardgame", variant: "classical", stageKind: "knockout", entrants: 2 });
    await seedOverride({ fixtureId: s.fixtureIds[0]! });
    const loaded = await loadFixturePadCfg(s.auth, s.fixtureIds[0]!);
    expect((loaded.cfg as Record<string, unknown>).tiebreak).toBe(true);
    expect((loaded.cfg as Record<string, unknown>).bestOf, "W2c: the pad reads the match override").toBe(OVERRIDE.bestOf);
    expect(loaded.stageKind).toBe("knockout"); // Task 12 threads it on to the pad
    expectOverlay("knockout");
    expectOverrideArg();
  });

  it.skipIf(!HAS_DB)("player-stats.ts computePlayerStats", async () => {
    // Boardgame rather than a sport that declares {}: chess has a stats model AND a non-empty overlay, so what the
    // site returned is observable, not only the kind it was handed.
    const s = await seedBracket({ sport: "boardgame", variant: "classical", stageKind: "knockout", entrants: 2 });
    await seedOverride({ fixtureId: s.fixtureIds[0]! });
    await insertLegacyEvents(s.fixtureIds[0]!, [{ type: "core.start", payload: {} }]);
    await withTenant(s.auth.orgId, (tx) => computePlayerStats(tx, s.divisionId));
    expectOverlay("knockout");
    expectOverrideOut("knockout");
    expectOverrideArg();
  });

  it.skipIf(!HAS_DB)("awarded-state.ts writeAwardedMatchState: ruling 116's walkover is scored under the bracket's cfg", async () => {
    // A two-entrant final whose away side withdrew after winning in: her seat is empty, the award names her.
    const s = await seedBracket({ sport: "boardgame", variant: "classical", stageKind: "knockout", entrants: 2 });
    const id = s.fixtureIds[0]!;
    await seedOverride({ fixtureId: id });
    const [f] = await sql<{ home_entrant_id: string; away_entrant_id: string }[]>`
      select home_entrant_id, away_entrant_id from fixtures where id = ${id}`;
    const award = { kind: "award", winner: f!.home_entrant_id, loser: f!.away_entrant_id, reason: "withdrew" };
    await sql`update fixtures set away_entrant_id = null, status = 'forfeited', outcome = ${sql.json(award)} where id = ${id}`;
    spy.mockClear();
    await withTenant(s.auth.orgId, (tx) => writeAwardedMatchState(tx, id));
    expectOverlay("knockout");
    expectOverrideOut("knockout");
    expectOverrideArg();
    const [row] = await sql<{ summary: { perSide: unknown[] } }[]>`select summary from match_states where fixture_id = ${id}`;
    expect(row!.summary.perSide, "and its score was written").toHaveLength(2);
  });

  it.skipIf(!HAS_DB)("admin-fixture-config.ts panel and resnapshot", async () => {
    const s = await seedBracket({ sport: "boardgame", variant: "classical", stageKind: "knockout", entrants: 2 });
    await seedOverride({ fixtureId: s.fixtureIds[0]! });
    const panel = await fixtureConfigPanel(s.fixtureIds[0]!);
    expect((panel!.live as Record<string, unknown>).tiebreak).toBe(true);
    expect((panel!.live as Record<string, unknown>).bestOf, "W2c: the panel's live cfg carries the override").toBe(OVERRIDE.bestOf);
    expectOverlay("knockout");
    expectOverrideArg();
    spy.mockClear();
    await appendEvent(s.auth.orgId, s.fixtureIds[0]!, 0, { type: "core.start", payload: {} });
    // W2c: the frozen cfg carries the override, so the panel's live cfg must too — or every overridden match would
    // read "diverged" to staff the moment it started. The override's key is NEW to this cfg, so it is also the
    // key-order witness: `live` holds it last, jsonb returns the snapshot's keys in its own order.
    spy.mockClear();
    expect((await fixtureConfigPanel(s.fixtureIds[0]!))!.diverged, "a just-frozen overridden fixture has not diverged").toBe(false);
    spy.mockClear();
    const suffix = randomUUID().slice(0, 8);
    const [{ id: actorId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, is_staff, staff_role)
      values (${`staff-${suffix}@example.test`}, 'Staff', true, 'superadmin') returning id`;
    await resnapshotFixtureConfig(actorId, s.fixtureIds[0]!, "W2a overlay check");
    expectOverlay("knockout");
    expectOverrideArg();
    // The hatch's own call is the one that resolves LIVE (snapshot null); it must pass the row's override, not null.
    const hatch = spy.mock.calls.filter((c) => (c[0] as { config_snapshot: unknown }).config_snapshot === null);
    expect(hatch, JSON.stringify(spy.mock.calls.map((c) => c[0]))).toHaveLength(1);
    expect(hatch[0]![0]).toEqual({ config_snapshot: null, rules_override: OVERRIDE });
    const [row] = await sql<{ config_snapshot: Record<string, unknown> }[]>`
      select config_snapshot from fixtures where id = ${s.fixtureIds[0]!}`;
    expect(row!.config_snapshot.tiebreak).toBe(true); // the re-frozen cfg kept the deciders
    expect(row!.config_snapshot.bestOf, "W2c: and the match override").toBe(OVERRIDE.bestOf);
  });

  it.skipIf(!HAS_DB)("match-centre-load.ts loadMatchCentre: both reads — the loader's own, and publicFixture's pre-read rows", async () => {
    // Pre-V347 history (no snapshot), so the public read resolves LIVE cfg — the one shape in which this site's
    // overlay and override are observable. `readConfigRows` has TWO selects of the fixture row: the one-statement
    // read, and the snapshot-only read when the caller already holds the division and stage rows.
    const s = await seedBracket({ sport: "boardgame", variant: "classical", stageKind: "knockout", entrants: 2 });
    await sql`update competitions set visibility = 'public' where id = ${s.competitionId}`;
    await seedOverride({ fixtureId: s.fixtureIds[0]! });
    await insertLegacyEvents(s.fixtureIds[0]!, [{ type: "core.start", payload: {} }]);
    const [fixture] = await sql<PublicFixture[]>`
      select id, division_id, stage_id, pool_id, round_no, seq_in_round,
             home_entrant_id, away_entrant_id, home_slot_label, away_slot_label,
             scheduled_at, venue, court_label,
             status, outcome, summary, last_seq,
             lane, is_final, third_place, conditional, stream_url
      from public_fixtures_v where id = ${s.fixtureIds[0]!}`;
    expect(fixture, "the public view serves the seeded fixture").toBeDefined();
    const [div] = await sql<{ module_version: string; config: unknown }[]>`
      select module_version, config from divisions where id = ${s.divisionId}`;
    const [stage] = await sql<{ kind: string; config: Record<string, unknown> | null }[]>`
      select kind, config from stages where id = ${s.stageId}`;
    const ctx: MatchCentreLoadCtx = {
      orgTz: null,
      division: { sportKey: "boardgame", moduleVersion: div!.module_version, formatLabel: "classical", tz: null, youth: false, playerNameDisplay: null },
      locale: "en",
      hrefs: { division: "/d", competition: "/c", calendar: null },
      stage: { name: "Knockout", roundLabel: null },
      slotLabelLookup: (key: MessageKey, vars?: Record<string, string | number>) => msgFor("en", key, vars),
    };
    let paths = 0;
    for (const c of [ctx, { ...ctx, configRows: { division: { config: div!.config }, stage: { config: stage!.config, kind: stage!.kind } } }]) {
      spy.mockClear();
      await loadMatchCentre(sql, fixture!, c);
      expectOverlay("knockout");
      expectOverrideOut("knockout");
      expectOverrideArg();
      paths++;
    }
    expect(paths).toBe(2);
  });

  it.skipIf(!HAS_DB)("event-import.ts importEvents: the fixture named by id and by ext_key", async () => {
    // The dry-run fold resolves the fixture's cfg before it judges the stream; a start-only stream is then refused
    // not_decided, which writes nothing — the cfg it was judged under is what this case reads. `resolveFixture` has
    // one SELECT per way a stream names its fixture, so both are driven.
    const s = await seedBracket({ sport: "boardgame", variant: "classical", stageKind: "knockout", entrants: 2 });
    await seedOverride({ fixtureId: s.fixtureIds[0]! });
    await sql`update fixtures set ext_key = 'W2C-T10' where id = ${s.fixtureIds[0]!}`;
    const refs = [{ id: s.fixtureIds[0]! }, { ext_key: "W2C-T10" }];
    for (const [i, fixture] of refs.entries()) {
      spy.mockClear();
      const report = await importEvents(s.auth, s.divisionId, {
        import_id: `imp-w2c-override-${i}`,
        streams: [{ fixture, events: [{ type: "core.start", payload: {} }] }],
      });
      expect(report.results[0]!.error?.code, JSON.stringify(fixture)).toBe("import.not_decided"); // the fold ran
      expectOverlay("knockout");
      expectOverrideOut("knockout");
      expectOverrideArg();
    }
    expect(refs).toHaveLength(2);
  });

  it.skipIf(!HAS_DB)("org-posts.ts draftPostsForDecidedFixture", async () => {
    // A decided boardgame knockout fixture in an auto-posting division, its snapshot nulled (the legacy shape) so the
    // result draft's scorer fold (`extractScorers`) resolves LIVE cfg — where this site's override is observable.
    const s = await seedBracket({ sport: "boardgame", variant: "classical", stageKind: "knockout", entrants: 2 });
    await sql`update divisions set auto_posts = true where id = ${s.divisionId}`;
    const id = s.fixtureIds[0]!;
    await seedOverride({ fixtureId: id });
    const [f] = await sql<{ home_entrant_id: string }[]>`select home_entrant_id from fixtures where id = ${id}`;
    await appendEvent(s.auth.orgId, id, 0, { type: "core.start", payload: {} });
    await appendEvent(s.auth.orgId, id, 1, { type: "boardgame.result", payload: { winner: f!.home_entrant_id, method: "checkmate" } });
    await sql`update fixtures set config_snapshot = null where id = ${id}`;
    spy.mockClear();
    await withTenant(s.auth.orgId, (tx) => draftPostsForDecidedFixture(tx, id, true));
    expectOverlay("knockout");
    expectOverrideOut("knockout");
    expectOverrideArg();
  });

  it.skipIf(!HAS_DB)("fixture-override-guards.ts refuseInvalidatedOverrides: a division save re-resolves the match's own format", async () => {
    // Raw seeding (boardgame: see the header); the save changes a key the boardgame schema reads, so the guard runs.
    const s = await seedBracket({ sport: "boardgame", variant: "classical", stageKind: "knockout", entrants: 2 });
    await seedOverride({ fixtureId: s.fixtureIds[0]! });
    spy.mockClear();
    await patchDivision(s.auth, s.divisionId, { config: { ...(builtinModules.find((m) => m.key === "boardgame")!.variants.classical as object) } });
    expectOverlay("knockout");
    expectOverrideOut("knockout");
    expectOverrideArg();
  });

  it.skipIf(!HAS_DB)("rules-version.ts unfrozenRules: a format save re-resolves every unfrozen match, before and after, to bump the ones it moved", async () => {
    // W2c Task 15 fix round 1 (I-1). Raw seeding (boardgame: see the header); the save moves the time control, a key
    // the boardgame schema reads, so the match's resolved format moves and its version with it.
    const s = await seedBracket({ sport: "boardgame", variant: "classical", stageKind: "knockout", entrants: 2 });
    const id = s.fixtureIds[0]!;
    await seedOverride({ fixtureId: id });
    spy.mockClear();
    await patchDivision(s.auth, s.divisionId, { config: { variant: "rapid" } });
    expectOverlay("knockout");
    expectOverrideOut("knockout");
    expectOverrideArg();
    const [r] = await sql<{ v: number }[]>`select rules_version v from fixtures where id = ${id}`;
    expect(r!.v, "the save moved the match's format: its version moved").toBe(1);
  });

  it.skipIf(!HAS_DB)("stage-format-lines.ts stageFormatLines: a knockout chip gets the bracket overlay over the division's drawn tie board, and the call carries NO match override", async () => {
    // Carrom: the one sport whose bracket overlay is observable on a stage (`tieBoard`: 'extra' in a bracket, whatever the
    // division plays). The division plays 'draw'; the stage names no rules of its own, so the overlay is the ONLY source
    // of 'extra' - and the chip's WORDS cannot tell (`describeDeciders` lays the overlay over its cfg again), so the
    // resolver's own answer is read through the spy.
    const carrom = builtinModules.find((m) => m.key === "carrom")!;
    const s = await seedBracket({
      sport: "carrom",
      variant: "icf",
      stageKind: "knockout",
      entrants: 2,
      divisionConfig: { ...(carrom.variants.icf as Record<string, unknown>), tieBoard: "draw" },
      stageRules: "division",
    });
    const [div] = await sql<{ config: { tieBoard?: string } }[]>`select config from divisions where id = ${s.divisionId}`;
    expect(div!.config.tieBoard, "premise: the division plays a drawn tie board").toBe("draw");
    const stages = await sql<{ id: string; name: string; seq: number; kind: string; rules: unknown }[]>`
      select id, name, seq, kind, config -> 'rules' as rules from stages where division_id = ${s.divisionId}`;
    expect(stages, "premise: one knockout stage with no rules of its own").toHaveLength(1);
    expect(stages[0]!.rules ?? null, "premise: the stage names no rules").toBeNull();

    spy.mockClear();
    const lines = stageFormatLines("carrom", carrom, div!.config, stages);
    const calls = seen();
    expect(calls.length, JSON.stringify(calls)).toBe(1); // one stage, one resolution
    expect(calls[0]!.kind).toBe("knockout");
    expect(calls[0]!.out?.tieBoard, "the resolver laid the bracket's extra board over the division's draw").toBe("extra");
    expect(expectNoOverrideArg()).toBe(1);
    // …and the chip says it (the words come from the same cfg).
    expect(lines.flatMap((l) => l.line.map((c) => c.key)), JSON.stringify(lines)).toContain("format.rules.decider.extraBoard");

    // The negative pair: the same division's TABLE stage never gets the overlay, so its resolution keeps the division's draw.
    spy.mockClear();
    stageFormatLines("carrom", carrom, div!.config, [{ ...stages[0]!, kind: "league" }]);
    const league = seen();
    expect(league.length).toBe(1);
    expect(league[0]!.kind).toBe("league");
    expect(league[0]!.out?.tieBoard, "no overlay on a table stage").toBe("draw");
  });

  // M3 (review): the ledger above pins the 16 sites in the SOURCE; this pins that the cases DROVE all 16 - 15 with the
  // override and the stage line without one (its row says `override: false`). Sites come from the spy's own caller frames (`callSite`), so a case cannot vouch for a site it never
  // reached. Declared last: vitest runs a file's cases in order, so every case above has run (or was filtered out
  // with -t, in which case this one is filtered out too).
  it.skipIf(!HAS_DB)("every one of the 16 call sites was driven (15 with the override, the stage line without), per the spy's caller frames", () => {
    const tally = (driven: ReadonlySet<string>) => {
      const byFile = new Map<string, number>();
      for (const site of driven) {
        const file = site.replace(/:\d+:\d+$/, "");
        byFile.set(file, (byFile.get(file) ?? 0) + 1);
      }
      return byFile;
    };
    const withOverride = tally(DRIVEN);
    const withoutOverride = tally(DRIVEN_NO_OVERRIDE);
    const missing = SITES.filter((s) => ((s.override === false ? withoutOverride : withOverride).get(s.file) ?? 0) !== s.count).map(
      (s) =>
        `${s.file}: ${(s.override === false ? withoutOverride : withOverride).get(s.file) ?? 0} of ${s.count} driven ${s.override === false ? "without" : "with"} the override`,
    );
    expect(missing, `NOT DRIVEN: ${missing.join("; ")} (driven: ${JSON.stringify([...DRIVEN, ...DRIVEN_NO_OVERRIDE].sort())})`).toEqual([]);
    expect([...withOverride.keys()].sort(), "with the override: exactly the sites that take one").toEqual(
      SITES.filter((s) => s.override !== false).map((s) => s.file).sort(),
    );
    expect([...withoutOverride.keys()].sort(), "without: exactly the sites that cannot").toEqual(
      SITES.filter((s) => s.override === false).map((s) => s.file).sort(),
    );
    expect(DRIVEN.size + DRIVEN_NO_OVERRIDE.size, "anti-vacuity: the sites checked").toBe(SITE_TOTAL);
    expect(SITE_TOTAL).toBe(16);
  });
});

describe("W2c: a match override through the real read and write folds (spec §4.4)", () => {
  // Badminton, a league: `bestOf` is a key badminton declares match-scoped (spec §4.1 Q5), and a league adds no
  // decider, so every value below is the division's, the override's, or the frozen one — nothing else.
  it.skipIf(!HAS_DB)("X-SR-2 sequence: no override, an override, a second read, the first event freezes it, then neither a cleared override nor a void moves it", async () => {
    const badminton = builtinModules.find((m) => m.key === "badminton")!;
    const declared = (badminton.configSchema.parse(badminton.variants.bwf) as { bestOf: unknown }).bestOf;
    expect(typeof declared, "the premise: the variant declares a bestOf").toBe("number");
    expect(declared, "the premise: the override differs from the division's value").not.toBe(OVERRIDE.bestOf);
    const s = await seedBracket({ sport: "badminton", variant: "bwf", stageKind: "league", entrants: 2 });
    const id = s.fixtureIds[0]!;
    const padBestOf = async () => ((await loadFixturePadCfg(s.auth, id)).cfg as { bestOf?: unknown }).bestOf;
    const foldBestOf = async () =>
      ((await withTenant(s.auth.orgId, (tx) => loadFoldInputs(tx, id)))!.cfg as { bestOf?: unknown }).bestOf;

    expect(await padBestOf(), "1. empty case: no override reads the division's value").toBe(declared);
    // Task 14 (§8): the REAL producer — the one writer — and what it stored, read back off the row.
    await writeFixtureRulesOverride(s.auth, [id], { ...OVERRIDE });
    const [stored] = await sql<{ rules_override: unknown }[]>`select rules_override from fixtures where id = ${id}`;
    expect(stored!.rules_override, "2. the writer stored the override").toEqual(OVERRIDE);
    expect(await padBestOf(), "2. the override").toBe(OVERRIDE.bestOf);
    expect(await padBestOf(), "3. a second read agrees").toBe(OVERRIDE.bestOf);
    const start = await appendEvent(s.auth.orgId, id, 0, { type: "core.start", payload: {} });
    const [frozen] = await sql<{ config_snapshot: { bestOf?: unknown } }[]>`select config_snapshot from fixtures where id = ${id}`;
    expect(frozen!.config_snapshot.bestOf, "4. the first event froze the override").toBe(OVERRIDE.bestOf);
    // Task 14: a live correction through the writer (only a start recorded, so any format fits) re-freezes, and the
    // pad and the read fold both read it; then back to the override for the steps below.
    await writeFixtureRulesOverride(s.auth, [id], { bestOf: declared });
    expect(await padBestOf(), "4b. a correction re-froze the match's format").toBe(declared);
    expect(await foldBestOf(), "4b. and the read fold reads it").toBe(declared);
    await writeFixtureRulesOverride(s.auth, [id], { ...OVERRIDE });
    expect(await padBestOf(), "4c. and back").toBe(OVERRIDE.bestOf);
    // A raw column write after the freeze is not a correction (Task 14's writer refolds); the snapshot wins.
    await sql`update fixtures set rules_override = null where id = ${id}`;
    expect(await padBestOf(), "5. a cleared override moves the pad nothing").toBe(OVERRIDE.bestOf);
    expect(await foldBestOf(), "5. nor the read fold").toBe(OVERRIDE.bestOf);
    await appendEvent(s.auth.orgId, id, 1, { type: "core.void", payload: {}, voids: start.event.id });
    expect(await padBestOf(), "6. after the start is voided the frozen cfg still holds (V347 is monotonic)").toBe(OVERRIDE.bestOf);
    expect(await foldBestOf(), "6. and the read fold agrees").toBe(OVERRIDE.bestOf);
  });
});
