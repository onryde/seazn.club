// R3.5 Task K — `appendEvent` is the single funnel every scoring event passes
// through and it logged NOTHING: every super-over ball, every shoot-out kick
// and every engine refusal on both was invisible in production. This proves
// the log lines exist, carry the right shape, and — K5 — never carry a
// payload value: payloads carry striker/nonStriker/bowler/person ids and,
// for some events, free text, and persons in this product carry consent
// flags, so a log line is not a consented surface.
//
// DB-backed like its siblings in this directory (config-snapshot.test.ts):
// the funnel is a real transaction over real tables, and mocking the DB away
// would only prove a mock's own behaviour, not the funnel's.
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { football } from "@seazn/engine/sports/football";
import { sql } from "@/lib/db";
import { appendEvent } from "../index";

const HAS_DB = !!process.env.DATABASE_URL;

// `lines` must exist before `vi.mock`'s factory can run — vitest hoists
// `vi.mock` calls above every import in this file (including the transitive
// one append-event.ts makes for "@/server/logger", resolved while THIS
// file's own `import { appendEvent } from "../index"` is still linking), so
// nothing declared as ordinary top-level code here is ready yet either.
// `vi.hoisted` is the one construct that runs early enough.
//
// The pino instance itself is built INSIDE the mock factory instead (via a
// dynamic `import("pino")`) rather than up here: a first attempt built it in
// this same `vi.hoisted` block using a statically-imported `pino`, and it
// failed every test with "Cannot access '__vi_import_3__' before
// initialization" — the hoisted callback runs before this file's own static
// imports (pino included) are linked, so it cannot touch them directly. A
// dynamic `import()` inside the (lazily-invoked) factory sidesteps that.
const { lines } = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock("@/server/logger", async () => {
  const { default: pino } = await import("pino");
  // A plain `{ write }` sink is pino's documented minimal destination shape
  // (no real stream needed) — see pino's own test suite. `write` returning
  // synchronously means every line is in `lines` by the time the
  // `log.info`/`log.warn` call that produced it returns, no flush needed.
  const sink = {
    write(chunk: string) {
      lines.push(chunk);
      return true;
    },
  };
  return { log: pino({ level: "debug" }, sink as never) };
});

function parsedLines(): Array<Record<string, unknown>> {
  return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
}
function linesNamed(msg: string): Array<Record<string, unknown>> {
  return parsedLines().filter((l) => l.msg === msg);
}

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

interface Seed {
  orgId: string;
  divisionId: string;
  stageId: string;
  fixtureId: string;
  home: string;
  away: string;
}

/** Fresh org -> competition -> division -> stage -> 2 entrants -> fixture,
 *  raw SQL (config-snapshot.test.ts's pattern) — no usecase layer, so no
 *  entitlement gating, matching what `appendEvent` itself checks (neither). */
async function seed(
  opts: {
    sportKey?: string;
    config?: unknown;
    moduleVersion?: string;
    positionCatalog?: unknown;
  } = {},
): Promise<Seed> {
  const sportKey = opts.sportKey ?? "generic";
  const config = opts.config ?? GENERIC_CONFIG;
  const moduleVersion = opts.moduleVersion ?? "1.0.0";
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"K " + suffix}, ${"k-" + suffix})
    returning id`;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values (${sportKey}, ${sportKey}, ${moduleVersion},
            ${sql.json((opts.positionCatalog ?? { groups: [], lineup: { size: 1, benchMax: 0 } }) as never)})
    on conflict (key) do nothing`;
  const [{ id: competitionId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility)
    values (${orgId}, ${"Comp " + suffix}, ${"comp-" + suffix}, 'private')
    returning id`;
  const [{ id: divisionId }] = await sql<{ id: string }[]>`
    insert into divisions (competition_id, name, slug, sport_key, variant_key, config, module_version)
    values (${competitionId}, 'Div', ${"div-" + suffix}, ${sportKey}, 'default',
            ${sql.json(config as never)}, ${moduleVersion})
    returning id`;
  const [{ id: stageId }] = await sql<{ id: string }[]>`
    insert into stages (division_id, seq, kind, name, config)
    values (${divisionId}, 1, 'league', 'Stage', ${sql.json({})})
    returning id`;
  const [{ id: home }] = await sql<{ id: string }[]>`
    insert into entrants (division_id, kind, display_name, seed)
    values (${divisionId}, 'individual', 'Home', 1) returning id`;
  const [{ id: away }] = await sql<{ id: string }[]>`
    insert into entrants (division_id, kind, display_name, seed)
    values (${divisionId}, 'individual', 'Away', 2) returning id`;
  const [{ id: fixtureId }] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, round_no, seq_in_round, home_entrant_id, away_entrant_id)
    values (${stageId}, ${divisionId}, 1, 1, ${home}, ${away})
    returning id`;
  return { orgId, divisionId, stageId, fixtureId, home, away };
}

/** A football fixture under a real `football.version` — hardcoding "1.0.0"
 *  like the generic default would be a coincidence, not a contract (that IS
 *  football's current version, but `_seed.ts`'s `seedFootballCatalog` reads
 *  it dynamically for exactly this reason, and this mirrors that). */
function seedFootball(cfg: unknown): Promise<Seed> {
  return seed({
    sportKey: "football",
    config: cfg,
    moduleVersion: football.version,
    positionCatalog: football.positions,
  });
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

beforeEach(() => {
  lines.length = 0;
});

describe.skipIf(!HAS_DB)("appendEvent logging (R3.5 Task K)", () => {
  it("K1: logs an accepted event with its type, fixture and resulting seq", async () => {
    const s = await seed();
    await appendEvent(s.orgId, s.fixtureId, 0, { type: "core.start", payload: {} });

    const accepted = linesNamed("scoring event appended");
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({
      fixtureId: s.fixtureId,
      sportKey: "generic",
      eventType: "core.start",
      seq: 1,
      phase: "live",
      status: "in_play",
    });
  });

  it("K2: logs a refusal with the EngineError code and the event type, and still throws", async () => {
    const s = await seed();
    await appendEvent(s.orgId, s.fixtureId, 0, { type: "core.start", payload: {} });
    lines.length = 0;

    // A second core.start replays [core.start, core.start] through the fold —
    // every module refuses a double start with WRONG_PHASE, thrown from
    // INSIDE foldMatch, which is exactly the scope Task K's try/catch covers.
    await expect(
      appendEvent(s.orgId, s.fixtureId, 1, { type: "core.start", payload: {} }),
    ).rejects.toMatchObject({ code: "WRONG_PHASE" });

    const refused = linesNamed("scoring event refused");
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({
      fixtureId: s.fixtureId,
      eventType: "core.start",
      code: "WRONG_PHASE",
    });
    // Re-thrown unchanged means the tx aborted before any insert — no
    // accepted-event line for the refused attempt.
    expect(linesNamed("scoring event appended")).toHaveLength(0);
  });

  it("K3: the accepted-event line shows the decider phase once the fold enters SHOOTOUT", async () => {
    const cfg = football.configSchema.parse({
      extraTime: { enabled: false, halfMinutes: 15 },
      shootout: true,
    });
    const s = await seedFootball(cfg);
    await appendEvent(s.orgId, s.fixtureId, 0, { type: "core.start", payload: {} });
    await appendEvent(s.orgId, s.fixtureId, 1, {
      type: "football.period",
      payload: { phase: "HT" },
    });
    lines.length = 0;

    // 0-0 at FT, extraTime disabled, shootout enabled -> phase flips straight
    // to SHOOTOUT (football.ts resolveFullTime) with zero kicks posted yet.
    await appendEvent(s.orgId, s.fixtureId, 2, {
      type: "football.period",
      payload: { phase: "FT" },
    });

    const accepted = linesNamed("scoring event appended");
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({
      eventType: "football.period",
      phase: "SHOOTOUT",
      status: "in_play",
    });
    // R3.5 ruling: no separate "entered a decider" line — the phase field on
    // this SAME accepted-event line is what makes a decider visible.
    expect(parsedLines().some((l) => typeof l.msg === "string" && /decider/i.test(l.msg))).toBe(
      false,
    );
  });

  it("K4: logs the decided transition with outcome.kind and outcome.method", async () => {
    const cfg = football.configSchema.parse({
      extraTime: { enabled: false, halfMinutes: 15 },
      shootout: true,
    });
    const s = await seedFootball(cfg);
    let seq = 0;
    const post = async (type: string, payload: unknown) => {
      await appendEvent(s.orgId, s.fixtureId, seq, { type, payload });
      seq += 1;
    };
    const kick = (by: "home" | "away", scored: boolean) =>
      post("football.shootout.kick", { by: by === "home" ? s.home : s.away, scored });

    await post("core.start", {});
    await post("football.period", { phase: "HT" });
    await post("football.period", { phase: "FT" }); // 0-0, extraTime off -> SHOOTOUT
    // The exact sequence football.test.ts's own golden decides 4-3 on: 5
    // kicks each, method "shootout" (packages/engine football golden (b)).
    await kick("home", true);
    await kick("away", true);
    await kick("home", true);
    await kick("away", true);
    await kick("home", true);
    await kick("away", true);
    await kick("home", false);
    await kick("away", false);
    await kick("home", true);
    lines.length = 0;
    await kick("away", false); // 4-3 after 5 kicks each -> decides

    const decided = linesNamed("fixture decided");
    expect(decided).toHaveLength(1);
    expect(decided[0]).toMatchObject({
      fixtureId: s.fixtureId,
      sportKey: "football",
      kind: "win",
      method: "shootout",
    });
    // The accepted-event line for this same event reflects the decision too.
    const accepted = linesNamed("scoring event appended");
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({ phase: "done", status: "decided" });
  });

  it("K5: never logs an event payload, a person name, or an email", async () => {
    const s = await seed();
    await appendEvent(s.orgId, s.fixtureId, 0, { type: "core.start", payload: {} });
    lines.length = 0;

    const emailMarker = "jane.doe+consent-marker@example.com";
    await appendEvent(s.orgId, s.fixtureId, 1, {
      type: "generic.score",
      payload: { by: s.home, points: 3, person: emailMarker },
    });

    // Guard against a vacuous pass: the event really was accepted and logged.
    expect(linesNamed("scoring event appended")).toHaveLength(1);
    const raw = lines.join("\n");
    expect(raw.includes(emailMarker)).toBe(false);
    expect(raw.includes(s.home)).toBe(false);
  });
});

// Static, DB-independent checks — always run, regardless of DATABASE_URL.
const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, "../../../../../..");
const V3_DIR = resolve(REPO_ROOT, "apps/web/src/components/v2/scorepad/v3");
const ENGINE_SPORTS_DIR = resolve(REPO_ROOT, "packages/engine/src/sports");

function sourceFilesUnder(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__" || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFilesUnder(full, exts));
    } else if (exts.some((ext) => entry.name.endsWith(ext)) && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("no logger outside the sanctioned funnel (R3.5 Task K, K6/K7)", () => {
  it("K6: no v3 skin imports @/server/** (a client-component build failure tsc cannot see)", () => {
    const files = sourceFilesUnder(V3_DIR, [".ts", ".tsx"]);
    expect(files.length).toBeGreaterThan(0); // guard: the scan really found files
    const offenders = files.filter((f) => /from\s+["']@\/server\//.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("K7: no sport module imports a logger (packages/engine is zero-effectful-deps by declaration)", () => {
    const files = sourceFilesUnder(ENGINE_SPORTS_DIR, [".ts"]);
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.filter((f) =>
      /from\s+["']pino["']|require\(\s*["']pino["']\s*\)/.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
