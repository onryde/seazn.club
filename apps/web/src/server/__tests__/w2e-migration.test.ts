// W2e Task 13b (A1h; spec 2026-10-28 §9, owner rule D18: "always loud when data changes and need migration before
// deploying") — the stored-config cleanup delta, which runs before the deploy:
//  1. it FAILS LOUD (PO decision, Task 13) while any stored config is one the W2e write doors refuse — a volleyball or
//     table tennis set target below the engine's floor, a tennis best of 1 with a match tie-break — naming the count and
//     every row, and writes nothing;
//  2. it removes `shootout.suddenDeath` (hockey, ice hockey; D4) and `progressScore` (generic; D6) from every place a
//     sport config is stored (a0-findings A0.7: division config, stage rules, a match's own format, its frozen snapshot,
//     the state cache);
//  3. it pins every Fast4-shaped tennis set to the tie-break margin it plays today (RB2A-12, TN-SS-2), read off the
//     config's own `tiebreak.winBy` (controller ruling: never a literal 2).
//
// The delta is read by GLOB, never by number (it is renumbered at merge), and its OWN text runs here: inside a
// transaction on a dedicated client that is always rolled back, scoped to the seeded organization as the app's tenant
// role (`app_user` + `app.current_org`, as the W2d migration test does), so RLS shows it that org's rows alone, each
// count is the seed's, and the empty case is deterministic: the shared test DB holds sibling suites' rows, below-floor
// ones included (w2e-config-write.test.ts stores a volleyball setTo 3 on purpose). One test (the Task 12 carry) COMMITS
// an org-scoped run, because the save it proves goes through the app's own pool; RLS still limits it to its own fresh
// organization. Expected values come from the engine's declarations (the floor, the Bo1 refusal, the Fast4 preset, the
// period kernel's strip), from the product's own resolver for "the margin a set plays", and from the pre-W2e server's
// own stored rows (`w2d-pin-before.json`), never from the SQL under test.
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { BO1_MATCH_TIEBREAK, setTargetBelowFloor, writeConfigIssues, type AnySportModule } from "@seazn/engine/sport";
import { connectionOptions, sql, type Tx } from "@/lib/db";
import { foldFixture } from "@/server/engine-db/fold";
import { liveCfg, mergeRulesOverride } from "@/server/engine-db/fixture-cfg";
import { seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { post } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import { asW2dPinTenant, seedW2dPinScenario } from "@/server/engine-db/__tests__/fixtures/w2d-pin-seed";
import { patchDivision } from "@/server/usecases/divisions";

const HAS_DB = !!process.env.DATABASE_URL;
const DELTAS = resolve(__dirname, "../../../../../db/migration/deltas");
const NAME = /^V\d+__w2e_stored_config_cleanup\.sql$/;
const files = readdirSync(DELTAS).filter((f) => NAME.test(f));
const text = files.length === 1 ? readFileSync(resolve(DELTAS, files[0]!), "utf8") : "";
/** The statements, comments removed: a `--` line naming a literal must not satisfy a regex meant for the SQL. */
const code = text.replace(/--.*$/gm, "");
const BLOCK = /do \$\$[\s\S]*?end \$\$;/.exec(code)?.[0];
const STATEMENTS = (BLOCK ?? "")
  .split(";")
  .map((s) => s.trim().replace(/^begin\s+/i, ""))
  .filter((s) => s !== "");
const UPDATES = STATEMENTS.filter((s) => /^update\s/i.test(s));
const PRECHECK = STATEMENTS.find((s) => /^with\s/i.test(s));

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

type Json = Record<string, unknown>;
const moduleOf = (key: string): AnySportModule => {
  const m = builtinModules.find((x) => x.key === key);
  if (!m) throw new Error(`no builtin module ${key}`);
  return m;
};
const parsed = (sport: string, raw: unknown): Json => moduleOf(sport).configSchema.parse(raw) as Json;
const allDefaults = (m: AnySportModule): Json | null => {
  const r = m.configSchema.safeParse({});
  return r.success ? (r.data as Json) : null;
};
const sportsIn = (stmt: string): Set<string> =>
  new Set([...stmt.matchAll(/sport_key\s*(?:=\s*'([a-z]+)'|in\s*\(([^)]*)\))/g)].flatMap((m) => (m[1] ? [m[1]] : [...m[2]!.matchAll(/'([a-z]+)'/g)].map((x) => x[1]!))));

// ── What the engine declares (the expected side of every text test) ──

/** The set-target floor of each sport whose write door declares one: the smallest target its door accepts, with the door's
 *  own sentence one below it (`SetBasedPreset.minSetTo`, read through `writeConfigIssues`). Badminton, on the same
 *  kernel, accepts a target of 1: no floor. */
function engineFloors(): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of builtinModules) {
    const base = allDefaults(m);
    if (base === null || typeof base.setTo !== "number" || typeof base.finalSetTo !== "number") continue;
    let floor = 0;
    for (let n = 1; n <= 99 && floor === 0; n++) if (writeConfigIssues(m, { ...base, setTo: n, finalSetTo: n }).length === 0) floor = n;
    if (floor === 0) throw new Error(`${m.key}: no set target up to 99 is accepted`);
    if (floor === 1) continue;
    expect(writeConfigIssues(m, { ...base, setTo: floor - 1 }), `${m.key}: setTo one below the floor`).toEqual([setTargetBelowFloor(floor)]);
    expect(writeConfigIssues(m, { ...base, finalSetTo: floor - 1 }), `${m.key}: finalSetTo one below the floor`).toEqual([setTargetBelowFloor(floor)]);
    out.set(m.key, floor);
  }
  return out;
}

/** The sports whose write door refuses a best of 1 with a match tie-break (and not a best of 3 with one, nor a best of 1
 *  with a final-set tie-break: the delta's predicate is exactly that pair). */
function engineBo1MatchTiebreakSports(): Set<string> {
  const out = new Set<string>();
  for (const m of builtinModules) {
    const base = allDefaults(m);
    if (base === null) continue;
    const pair = { ...base, bestOf: 1, finalSet: { matchTiebreakTo: 10 } };
    if (!m.configSchema.safeParse(pair).success || !writeConfigIssues(m, pair).includes(BO1_MATCH_TIEBREAK)) continue;
    expect(writeConfigIssues(m, { ...base, bestOf: 3, finalSet: { matchTiebreakTo: 10 } }), `${m.key}: best of 3 with it`).toEqual([]);
    expect(writeConfigIssues(m, { ...base, bestOf: 1, finalSet: { tiebreakTo: 10 } }), `${m.key}: a final-set tie-break`).toEqual([]);
    out.add(m.key);
  }
  return out;
}

/** The sports whose config holds a shoot-out OBJECT from which the schema strips `suddenDeath` (the period kernel's W2e
 *  compatibility path for an older client): the sports that ever declared the key. Football's shoot-out is a boolean. */
function engineSuddenDeathSports(): Set<string> {
  const out = new Set<string>();
  for (const m of builtinModules) {
    const base = allDefaults(m);
    if (base === null) continue;
    const r = m.configSchema.safeParse({ ...base, shootout: { attempts: 5, suddenDeath: true } });
    const so = r.success ? (r.data as Json).shootout : undefined;
    if (so !== null && typeof so === "object" && (so as Json).attempts === 5 && !("suddenDeath" in (so as Json))) out.add(m.key);
  }
  return out;
}

/** The sports with a shipped variant whose set has the Fast4 shape the delta matches (`gamesTo`, `tiebreakAt`). */
const FAST4 = (() => {
  const set = parsed("tennis", moduleOf("tennis").variants.fast4).set as Json;
  return { gamesTo: set.gamesTo as number, tiebreakAt: set.tiebreakAt as number };
})();
function engineFast4Sports(): Set<string> {
  const out = new Set<string>();
  for (const m of builtinModules)
    for (const v of Object.values(m.variants)) {
      const r = m.configSchema.safeParse(v);
      const set = r.success ? ((r.data as Json).set as Json | undefined) : undefined;
      if (set && set.gamesTo === FAST4.gamesTo && set.tiebreakAt === FAST4.tiebreakAt) out.add(m.key);
    }
  return out;
}

describe("W2e migration — its text (no DB)", () => {
  it("the delta exists exactly once, by name pattern; its one block holds the fail-loud count and the updates", () => {
    expect(files, `one ${NAME} in db/migration/deltas`).toHaveLength(1);
    expect(BLOCK, "a do block").toBeDefined();
    expect(PRECHECK, "the fail-loud count").toBeDefined();
    expect(UPDATES.length, "anti-vacuity: the updates").toBeGreaterThan(0);
    // Fail loud BEFORE any write: the count, then its raise, precede the first update.
    const at = (re: RegExp) => STATEMENTS.findIndex((s) => re.test(s));
    expect(at(/^with\s/i)).toBeLessThan(at(/raise exception/i));
    expect(at(/raise exception/i)).toBeLessThan(at(/^update\s/i));
  });

  it("D18 the set-target floor the delta counts below is the engine's own (minSetTo), for exactly the sports that declare one", () => {
    const floors = engineFloors();
    expect(floors.size, "anti-vacuity: sports with a floor").toBeGreaterThan(0);
    const floorLayer = /floor_layer[\s\S]*?\)\s*,\s*below_floor/.exec(PRECHECK ?? "")?.[0] ?? "";
    const lists = [...floorLayer.matchAll(/sport_key\s+in\s*\(([^)]*)\)/g)];
    expect(lists.length, "one sport list per A0.7 place (division, stage rules, match format, snapshot, state cache)").toBe(5);
    for (const l of lists) expect(sportsIn(`sport_key in (${l[1]})`)).toEqual(new Set(floors.keys()));
    const belowFloor = /below_floor\s*\(kind, id\) as \([\s\S]*?\)\s*,\s*tennis_layer/.exec(PRECHECK ?? "")?.[0] ?? "";
    const literals = [...belowFloor.matchAll(/::numeric\s*<\s*(\d+)/g)].map((m) => Number(m[1]));
    expect(literals, "setTo and finalSetTo, each against the floor").toHaveLength(2);
    for (const n of literals) for (const [sport, floor] of floors) expect(n, sport).toBe(floor);
    expect(belowFloor).toMatch(/'setTo'/);
    expect(belowFloor).toMatch(/'finalSetTo'/);
  });

  it("D18 the best-of-1 count is scoped to exactly the sports whose door refuses a best of 1 with a match tie-break", () => {
    const sports = engineBo1MatchTiebreakSports();
    expect(sports.size, "anti-vacuity").toBeGreaterThan(0);
    const tennisLayer = /tennis_layer\s*\(kind[\s\S]*?\)\s*,\s*bo1_match_tiebreak/.exec(PRECHECK ?? "")?.[0] ?? "";
    const scopes = [...tennisLayer.matchAll(/sport_key\s*=\s*'([a-z]+)'/g)].map((m) => m[1]!);
    expect(scopes, "one per A0.7 place").toHaveLength(5);
    for (const s of scopes) expect(new Set([s])).toEqual(sports);
    expect(PRECHECK).toMatch(/best_of = '1'::jsonb/);
    expect(PRECHECK).toMatch(/final_set \? 'matchTiebreakTo'/);
  });

  it("D18 every update is scoped to the sports the engine declares for its key (suddenDeath: the period kernel's; Fast4: tennis; progressScore: generic)", () => {
    const suddenDeath = engineSuddenDeathSports();
    const fast4 = engineFast4Sports();
    expect([suddenDeath.size, fast4.size], "anti-vacuity").toEqual([2, 1]);
    // progressScore was generic's alone, and W2e D6 deleted it, so no engine declaration of it remains to read.
    const progressScore = new Set(["generic"]);
    const seen = { suddenDeath: 0, progressScore: 0, tiebreakWinBy: 0 };
    for (const u of UPDATES) {
      const key = (["suddenDeath", "progressScore", "tiebreakWinBy"] as const).filter((k) => u.includes(k));
      expect(key, `one key per update: ${u.slice(0, 80)}`).toHaveLength(1);
      const want = { suddenDeath, progressScore, tiebreakWinBy: fast4 }[key[0]!];
      expect(sportsIn(u), u.slice(0, 120)).toEqual(want);
      seen[key[0]!] += 1;
    }
    // One per stored place (A0.7): division, stage rules, match override, snapshot, state cache.
    expect(seen).toEqual({ suddenDeath: 5, progressScore: 5, tiebreakWinBy: 5 });
  });

  it("D18 the Fast4 shape the delta matches is the engine's fast4 preset's (gamesTo, tie-break at)", () => {
    const fast4Updates = UPDATES.filter((u) => u.includes("tiebreakWinBy"));
    let checked = 0;
    for (const u of fast4Updates) {
      const games = [...u.matchAll(/gamesTo[}']*\s*=\s*'(\d+)'::jsonb/g)].map((m) => Number(m[1]));
      const at = [...u.matchAll(/tiebreakAt[}']*\s*=\s*'(\d+)'::jsonb/g)].map((m) => Number(m[1]));
      expect(games.length, u.slice(0, 80)).toBeGreaterThan(0);
      for (const g of games) expect(g).toBe(FAST4.gamesTo);
      for (const a of at) expect(a).toBe(FAST4.tiebreakAt);
      checked += games.length + at.length;
    }
    expect(checked, "anti-vacuity").toBeGreaterThan(0);
  });
});

// ── The DB side ──

const ROLLBACK = new Error("rollback");

/** `body` on its own one-connection client inside a transaction that is always rolled back; the notices it raised. */
async function rolledBack<T>(body: (tx: Tx, notices: string[]) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_URL!;
  const notices: string[] = [];
  const client = postgres(url, {
    max: 1,
    ssl: connectionOptions(url).ssl,
    connection: { search_path: connectionOptions(url).schema },
    onnotice: (n) => notices.push(String(n.message)),
  });
  let value: T | undefined;
  try {
    await client.begin(async (tx) => {
      value = await body(tx as unknown as Tx, notices);
      throw ROLLBACK;
    });
    throw new Error("the transaction committed");
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  } finally {
    await client.end();
  }
  return value as T;
}

/** The rest of `tx` as the app's tenant role for `orgId` (`withTenant`): RLS shows that org's rows alone. */
async function asTenant(tx: Tx, orgId: string): Promise<void> {
  await tx`select set_config('app.current_org', ${orgId}, true)`;
  await tx`set local role app_user`;
}

/** Runs the delta's block; returns the per-statement change counts it reported (`<column> <change>` → rows). */
async function runDelta(tx: Tx, notices: string[]): Promise<Record<string, number>> {
  const from = notices.length;
  await tx.unsafe(BLOCK!);
  const out: Record<string, number> = {};
  for (const n of notices.slice(from)) {
    const m = /^W2e stored-config cleanup: (\S+) (\S+)=(\d+)$/.exec(n);
    if (m) out[`${m[1]} ${m[2]}`] = Number(m[3]);
    else if (n !== "W2e stored configs the write doors refuse: count=0") throw new Error(`a notice that is not the delta's: ${n}`);
  }
  expect(Object.keys(out).length, "a change count per update").toBe(UPDATES.length);
  return out;
}

interface Seed {
  label: string;
  sport: string;
  variant: string;
  division: Json;
  /** `stages.config.rules`; absent = none (the stage inherits the division's). */
  stageRules?: Json;
  override?: Json;
  snapshot?: Json;
  /** `match_states.state.cfg` (the rest of the state is a marker the delta must leave alone). */
  stateCfg?: Json;
}
interface Seeded {
  label: string;
  sport: string;
  divisionId: string;
  stageId: string;
  fixtureId: string;
}

/** One organization holding one division, stage, fixture and state row per seed, written raw (the shapes a pre-W2e server
 *  stored, which today's doors would no longer write). Inside the rolled-back transaction, as the connecting role. */
async function seedRows(tx: Tx, seeds: readonly Seed[]): Promise<{ orgId: string; rows: Seeded[] }> {
  const suffix = randomUUID().slice(0, 8);
  const [org] = await tx<{ id: string }[]>`insert into organizations (name, slug) values (${"W2e mig " + suffix}, ${"w2e-mig-" + suffix}) returning id`;
  const [comp] = await tx<{ id: string }[]>`
    insert into competitions (org_id, name, slug) values (${org!.id}, ${"W2e mig " + suffix}, ${"w2e-mig-" + suffix}) returning id`;
  const rows: Seeded[] = [];
  const j = (v: Json | undefined) => (v === undefined ? null : tx.json(v as never));
  for (const [i, s] of seeds.entries()) {
    const [d] = await tx<{ id: string }[]>`
      insert into divisions (competition_id, org_id, name, slug, sport_key, variant_key, config, module_version)
      values (${comp!.id}, ${org!.id}, ${s.label}, ${"d-" + i}, ${s.sport}, ${s.variant}, ${tx.json(s.division as never)},
              (select module_version from sports where key = ${s.sport}))
      returning id`;
    const [st] = await tx<{ id: string }[]>`
      insert into stages (division_id, org_id, seq, kind, name, config)
      values (${d!.id}, ${org!.id}, 1, 'league', 'S1', ${tx.json((s.stageRules === undefined ? {} : { rules: s.stageRules }) as never)})
      returning id`;
    const [f] = await tx<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, rules_override, config_snapshot)
      values (${st!.id}, ${d!.id}, ${org!.id}, 1, 1, ${j(s.override)}, ${j(s.snapshot)})
      returning id`;
    if (s.stateCfg !== undefined) {
      await tx`insert into match_states (fixture_id, org_id, last_seq, state, summary)
               values (${f!.id}, ${org!.id}, 0, ${tx.json({ cfg: s.stateCfg, marker: s.label } as never)}, ${tx.json({ marker: s.label } as never)})`;
    }
    rows.push({ label: s.label, sport: s.sport, divisionId: d!.id, stageId: st!.id, fixtureId: f!.id });
  }
  return { orgId: org!.id, rows };
}

const COLUMNS = ["divisions.config", "stages.config.rules", "fixtures.rules_override", "fixtures.config_snapshot", "match_states.state.cfg"] as const;
type Column = (typeof COLUMNS)[number];
interface Stored {
  id: string;
  sport: string;
  /** The whole column value. */
  raw: unknown;
  /** The sport config inside it (stage rules, state cfg); null when there is none. */
  cfg: unknown;
  ctid: string;
}

/** Every stored row the tenant sees, per A0.7 place, with its ctid (an UPDATE moves it, even to an equal value). */
async function readStored(tx: Tx): Promise<Record<Column, Stored[]>> {
  const divisions = await tx<{ id: string; sport: string; raw: unknown; ctid: string }[]>`
    select d.id, d.sport_key as sport, d.config as raw, d.ctid::text as ctid from divisions d order by d.id`;
  const stages = await tx<{ id: string; sport: string; raw: Json | null; ctid: string }[]>`
    select s.id, d.sport_key as sport, s.config as raw, s.ctid::text as ctid from stages s join divisions d on d.id = s.division_id order by s.id`;
  const fixtures = await tx<{ id: string; sport: string; ov: unknown; snap: unknown; ctid: string }[]>`
    select f.id, d.sport_key as sport, f.rules_override as ov, f.config_snapshot as snap, f.ctid::text as ctid
      from fixtures f join divisions d on d.id = f.division_id order by f.id`;
  const states = await tx<{ id: string; sport: string; raw: Json; ctid: string }[]>`
    select m.fixture_id as id, d.sport_key as sport, m.state as raw, m.ctid::text as ctid
      from match_states m join fixtures f on f.id = m.fixture_id join divisions d on d.id = f.division_id order by m.fixture_id`;
  return {
    "divisions.config": divisions.map((r) => ({ ...r, cfg: r.raw })),
    "stages.config.rules": stages.map((r) => ({ ...r, cfg: r.raw?.rules ?? null })),
    "fixtures.rules_override": fixtures.map((r) => ({ id: r.id, sport: r.sport, raw: r.ov, cfg: r.ov, ctid: r.ctid })),
    "fixtures.config_snapshot": fixtures.map((r) => ({ id: r.id, sport: r.sport, raw: r.snap, cfg: r.snap, ctid: r.ctid })),
    "match_states.state.cfg": states.map((r) => ({ ...r, cfg: r.raw.cfg ?? null })),
  };
}

const isObj = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);
/** Every path at which an object carries `key`. */
const keyPaths = (v: unknown, key: string, path = "$"): string[] =>
  !isObj(v) && !Array.isArray(v)
    ? []
    : Object.entries(v as Json).flatMap(([k, x]) => [...(k === key ? [`${path}.${k}`] : []), ...keyPaths(x, key, `${path}.${k}`)]);
/** `v` without the object at `path` (dot path), as the delta's `#-` removes it. */
function without(v: unknown, path: readonly string[]): unknown {
  if (!isObj(v) || path.length === 0) return v;
  const [head, ...rest] = path;
  if (!(head! in v)) return v;
  const out: Json = { ...v };
  if (rest.length === 0) delete out[head!];
  else out[head!] = without(v[head!], rest);
  return out;
}

// The pre-W2e shapes, built from today's presets plus the key a pre-W2e server stored.
const HOCKEY = parsed("hockey", moduleOf("hockey").variants["fih-shootout"]);
const hockeyLegacy = (): Json => ({ ...HOCKEY, shootout: { ...(HOCKEY.shootout as Json), suddenDeath: true } });
const ICEHOCKEY = parsed("icehockey", moduleOf("icehockey").variants.iihf);
const icehockeyLegacy = (): Json => ({ ...ICEHOCKEY, shootout: { ...(ICEHOCKEY.shootout as Json), suddenDeath: true } });
const GENERIC = parsed("generic", moduleOf("generic").variants.score);
const genericLegacy = (): Json => ({ ...GENERIC, progressScore: false });
const TENNIS_TOUR = parsed("tennis", moduleOf("tennis").variants.tour);
const TENNIS_FAST4 = parsed("tennis", moduleOf("tennis").variants.fast4);
/** A Fast4 division as a pre-W2e server stored it: the fast4 set without the W2e key (its margin was `tiebreak.winBy`). */
const fast4Legacy = (tiebreakWinBy?: number): Json => {
  const set: Json = { ...(TENNIS_FAST4.set as Json) };
  delete set.tiebreakWinBy;
  return { ...TENNIS_FAST4, set, ...(tiebreakWinBy === undefined ? {} : { tiebreak: { winBy: tiebreakWinBy } }) };
};

/** One target per sport per A0.7 place, and a witness of every OTHER sport carrying the same key name in the same place. */
const KEY_SEEDS: Seed[] = [
  {
    label: "hockey fih-shootout, mid-shoot-out",
    sport: "hockey",
    variant: "fih-shootout",
    division: hockeyLegacy(),
    stageRules: { shootout: { attempts: 5, suddenDeath: true, clockSeconds: 8 } },
    override: { shootout: { attempts: 3, suddenDeath: true } },
    snapshot: hockeyLegacy(),
    stateCfg: hockeyLegacy(),
  },
  {
    label: "ice hockey iihf",
    sport: "icehockey",
    variant: "iihf",
    division: icehockeyLegacy(),
    stageRules: { shootout: { attempts: 5, suddenDeath: true } },
    override: { shootout: { attempts: 3, suddenDeath: false } },
    snapshot: icehockeyLegacy(),
    stateCfg: icehockeyLegacy(),
  },
  {
    label: "generic score",
    sport: "generic",
    variant: "score",
    division: genericLegacy(),
    stageRules: { progressScore: true, allowDraws: false },
    override: { progressScore: true },
    snapshot: genericLegacy(),
    stateCfg: genericLegacy(),
  },
  // Witnesses: the same key name under another sport is not the delta's to remove.
  {
    label: "witness: generic with a stray shoot-out suddenDeath",
    sport: "generic",
    variant: "score",
    division: { ...GENERIC, shootout: { attempts: 5, suddenDeath: true } },
    stageRules: { shootout: { attempts: 5, suddenDeath: true } },
    override: { shootout: { suddenDeath: true } },
    snapshot: { ...GENERIC, shootout: { attempts: 5, suddenDeath: true } },
    stateCfg: { ...GENERIC, shootout: { attempts: 5, suddenDeath: true } },
  },
  {
    label: "witness: hockey with a stray progressScore",
    sport: "hockey",
    variant: "fih-outdoor",
    division: { ...parsed("hockey", {}), progressScore: false },
    stageRules: { progressScore: true },
    override: { progressScore: true },
    snapshot: { ...parsed("hockey", {}), progressScore: false },
    stateCfg: { ...parsed("hockey", {}), progressScore: false },
  },
  {
    label: "witness: volleyball with both",
    sport: "volleyball",
    variant: "indoor",
    division: { ...parsed("volleyball", {}), progressScore: false, shootout: { suddenDeath: true } },
    stageRules: { progressScore: true, shootout: { suddenDeath: true } },
    override: { progressScore: true, shootout: { suddenDeath: true } },
    snapshot: { ...parsed("volleyball", {}), progressScore: false, shootout: { suddenDeath: true } },
    stateCfg: { ...parsed("volleyball", {}), progressScore: false, shootout: { suddenDeath: true } },
  },
];

/** The tennis (and one badminton) shapes of Review Focus 5, each named for what the delta must do to it. */
const FAST4_SEEDS: Seed[] = [
  {
    label: "fast4 stored before W2e (margin 2)",
    sport: "tennis",
    variant: "fast4",
    division: fast4Legacy(),
    snapshot: fast4Legacy(),
    stateCfg: fast4Legacy(),
  },
  {
    label: "custom Fast4-shaped set, sudden-death tie-breaks (tiebreak.winBy 1)",
    sport: "tennis",
    variant: "tour",
    division: fast4Legacy(1),
    snapshot: fast4Legacy(1),
    stateCfg: fast4Legacy(1),
  },
  {
    label: "a tour stage, a match whose own format is Fast4 (its stored leaves)",
    sport: "tennis",
    variant: "tour",
    division: TENNIS_TOUR,
    override: { set: { gamesTo: 4, tiebreakAt: 3, tiebreakTo: 5 } },
  },
  {
    label: "a tour division, a stage whose own set is Fast4 with its own margin 1",
    sport: "tennis",
    variant: "tour",
    division: TENNIS_TOUR,
    stageRules: { set: (fast4Legacy().set as Json), tiebreak: { winBy: 1 } },
  },
  {
    label: "a Fast4 division (margin 2), a stage that changed only tiebreak.winBy to 1",
    sport: "tennis",
    variant: "fast4",
    division: fast4Legacy(),
    stageRules: { tiebreak: { winBy: 1 } },
  },
  {
    label: "a Fast4 division (margin 2), a match that changed only tiebreak.winBy to 1",
    sport: "tennis",
    variant: "fast4",
    division: fast4Legacy(),
    override: { tiebreak: { winBy: 1 } },
  },
  {
    label: "a Fast4 division, a match that changed only its tie-break target (inherits the pinned margin)",
    sport: "tennis",
    variant: "fast4",
    division: fast4Legacy(),
    override: { set: { tiebreakTo: 6 } },
  },
  {
    label: "untouched: a short-sets-shaped set (tie-break at 4-all) without the key",
    sport: "tennis",
    variant: "tour",
    division: { ...TENNIS_TOUR, set: { gamesTo: 4, winBy: 2, tiebreakAt: 4, tiebreakTo: 5 } },
    snapshot: { ...TENNIS_TOUR, set: { gamesTo: 4, winBy: 2, tiebreakAt: 4, tiebreakTo: 5 } },
    stateCfg: { ...TENNIS_TOUR, set: { gamesTo: 4, winBy: 2, tiebreakAt: 4, tiebreakTo: 5 } },
  },
  {
    label: "untouched: a fast4 division created under W2e (its own margin 1)",
    sport: "tennis",
    variant: "fast4",
    division: TENNIS_FAST4,
    snapshot: TENNIS_FAST4,
    stateCfg: TENNIS_FAST4,
  },
  {
    label: "untouched: tour",
    sport: "tennis",
    variant: "tour",
    division: TENNIS_TOUR,
    stageRules: { bestOf: 5 },
    override: { set: { tiebreakTo: 10 } },
    snapshot: TENNIS_TOUR,
    stateCfg: TENNIS_TOUR,
  },
  {
    label: "untouched: badminton with a stray Fast4-shaped set",
    sport: "badminton",
    variant: "bwf",
    division: { ...parsed("badminton", {}), set: { gamesTo: 4, winBy: 2, tiebreakAt: 3, tiebreakTo: 5 } },
    snapshot: { ...parsed("badminton", {}), set: { gamesTo: 4, winBy: 2, tiebreakAt: 3, tiebreakTo: 5 } },
    stateCfg: { ...parsed("badminton", {}), set: { gamesTo: 4, winBy: 2, tiebreakAt: 3, tiebreakTo: 5 } },
  },
];

const TARGET: Record<"suddenDeath" | "progressScore", readonly string[]> = { suddenDeath: ["hockey", "icehockey"], progressScore: ["generic"] };
/** The path of each removed key inside the column's sport config. */
const KEY_PATH: Record<"suddenDeath" | "progressScore", readonly string[]> = { suddenDeath: ["shootout", "suddenDeath"], progressScore: ["progressScore"] };
const carries = (key: "suddenDeath" | "progressScore", cfg: unknown): boolean =>
  key === "progressScore" ? isObj(cfg) && "progressScore" in cfg : isObj(cfg) && isObj(cfg.shootout) && "suddenDeath" in cfg.shootout;
/** The raw column value minus the targeted key at its place in that column. */
const removedFrom = (column: Column, key: "suddenDeath" | "progressScore", raw: unknown): unknown =>
  column === "stages.config.rules"
    ? without(raw, ["rules", ...KEY_PATH[key]])
    : column === "match_states.state.cfg"
      ? without(raw, ["cfg", ...KEY_PATH[key]])
      : without(raw, KEY_PATH[key]);

/** The tie-break margin a SET plays under a resolved tennis cfg: its own, else the match's (the kernel's `setTiebreakWinBy`). */
const setMargin = (cfg: unknown): unknown => {
  const c = cfg as { set?: { tiebreakWinBy?: number }; tiebreak?: { winBy?: number } };
  return c.set?.tiebreakWinBy ?? c.tiebreak?.winBy;
};
const isFast4 = (set: unknown): boolean => isObj(set) && set.gamesTo === FAST4.gamesTo && set.tiebreakAt === FAST4.tiebreakAt;
const tennis = moduleOf("tennis");

/** Every config a tennis seed plays, as the product resolves it (`liveCfg` for the stage, then the match's own format;
 *  the frozen snapshot and the state cache as they are). */
function resolvedTennis(stored: Record<Column, Stored[]>, seeded: readonly Seeded[]): { where: string; cfg: unknown }[] {
  const by = (c: Column, id: string) => stored[c].find((r) => r.id === id);
  const out: { where: string; cfg: unknown }[] = [];
  for (const s of seeded.filter((x) => x.sport === "tennis")) {
    const division = by("divisions.config", s.divisionId)!.raw;
    const stageRaw = by("stages.config.rules", s.stageId)!.raw as Json;
    const stage = { kind: "league", config: stageRaw };
    const stageCfg = liveCfg(division, stage as never, tennis as never);
    out.push({ where: `${s.label}: division`, cfg: division });
    out.push({ where: `${s.label}: stage`, cfg: stageCfg });
    out.push({ where: `${s.label}: match`, cfg: mergeRulesOverride(stageCfg as Json, by("fixtures.rules_override", s.fixtureId)!.raw) });
    const snap = by("fixtures.config_snapshot", s.fixtureId)!.raw;
    if (snap !== null) out.push({ where: `${s.label}: snapshot`, cfg: snap });
    const state = by("match_states.state.cfg", s.fixtureId);
    if (state) out.push({ where: `${s.label}: state cache`, cfg: state.cfg });
  }
  return out;
}

describe.skipIf(!HAS_DB)("W2e migration — the keys it removes and the margins it pins (D18, Review Focus 5)", () => {
  it("D18 migration removes suddenDeath and progressScore from every listed column, for their sports only", async () => {
    await rolledBack(async (tx, notices) => {
      const { orgId, rows } = await seedRows(tx, KEY_SEEDS);
      await asTenant(tx, orgId);
      const before = await readStored(tx);
      // Anti-vacuity, per place and per target sport: every A0.7 place carries every key it is asked to drop.
      const expected: Record<string, number> = {};
      for (const key of ["suddenDeath", "progressScore"] as const)
        for (const column of COLUMNS) {
          for (const sport of TARGET[key]) {
            const n = before[column].filter((r) => r.sport === sport && carries(key, r.cfg)).length;
            expect(n, `${column} ${key} carried by ${sport}`).toBeGreaterThan(0);
          }
          expected[`${column} ${key === "suddenDeath" ? "shootout.suddenDeath" : "progressScore"}`] = before[column].filter(
            (r) => TARGET[key].includes(r.sport) && carries(key, r.cfg),
          ).length;
        }
      const changed = await runDelta(tx, notices);
      for (const [k, n] of Object.entries(expected)) expect(changed[k], k).toBe(n);
      const after = await readStored(tx);
      let checked = 0;
      for (const column of COLUMNS) {
        for (const b of before[column]) {
          const a = after[column].find((r) => r.id === b.id)!;
          let want: unknown = b.raw;
          for (const key of ["suddenDeath", "progressScore"] as const) if (TARGET[key].includes(b.sport)) want = removedFrom(column, key, want);
          expect(a.raw, `${column} ${rows.find((r) => [r.divisionId, r.stageId, r.fixtureId].includes(b.id))?.label}`).toEqual(want);
          for (const key of ["suddenDeath", "progressScore"] as const)
            if (TARGET[key].includes(b.sport)) expect(keyPaths(a.cfg, key), `${column} ${b.sport}`).toEqual([]);
          checked += 1;
        }
      }
      expect(checked, "anti-vacuity: rows compared").toBe(COLUMNS.length * KEY_SEEDS.length - KEY_SEEDS.filter((s) => s.stateCfg === undefined).length);
      // The witnesses kept the same-named keys their sport never declared.
      const witness = (label: string) => rows.find((r) => r.label.startsWith(label))!;
      const g = witness("witness: generic");
      expect(keyPaths(after["divisions.config"].find((r) => r.id === g.divisionId)!.cfg, "suddenDeath")).toEqual(["$.shootout.suddenDeath"]);
      const h = witness("witness: hockey");
      expect(keyPaths(after["match_states.state.cfg"].find((r) => r.id === h.fixtureId)!.cfg, "progressScore")).toEqual(["$.progressScore"]);
    });
  }, 60_000);

  it("D18 migration pins every Fast4-shaped set to the margin it plays (tiebreak.winBy, 2 when stored before W2e) and leaves tour and short-sets sets untouched", async () => {
    await rolledBack(async (tx, notices) => {
      const { orgId, rows } = await seedRows(tx, FAST4_SEEDS);
      await asTenant(tx, orgId);
      const before = await readStored(tx);
      const playsBefore = resolvedTennis(before, rows);
      await runDelta(tx, notices);
      const after = await readStored(tx);
      const playsAfter = resolvedTennis(after, rows);
      // 1. Every config each seed plays keeps its set margin, still parses, and a Fast4 set now names its margin.
      expect(playsAfter.map((p) => p.where)).toEqual(playsBefore.map((p) => p.where));
      let fast4 = 0;
      for (const [i, b] of playsBefore.entries()) {
        const a = playsAfter[i]!;
        expect(tennis.configSchema.safeParse(a.cfg).success, `${a.where} parses`).toBe(true);
        expect(setMargin(a.cfg), `${a.where}: the margin it plays`).toBe(setMargin(b.cfg));
        if (isFast4((a.cfg as Json).set)) {
          expect(((a.cfg as Json).set as Json).tiebreakWinBy, `${a.where}: explicit`).toBe(setMargin(b.cfg));
          fast4 += 1;
        }
      }
      expect(fast4, "anti-vacuity: Fast4 configs judged").toBeGreaterThanOrEqual(15);
      // 2. The stored values, by name (the controller's ruling: the config's own tiebreak.winBy, never a literal 2).
      const row = (label: string) => rows.find((r) => r.label.startsWith(label))!;
      const cfgOf = (c: Column, id: string) => after[c].find((r) => r.id === id)!.cfg as Json | null;
      const tbwb = (cfg: Json | null) => ((cfg?.set ?? {}) as Json).tiebreakWinBy;
      const legacy = row("fast4 stored before W2e");
      expect([tbwb(cfgOf("divisions.config", legacy.divisionId)), tbwb(cfgOf("fixtures.config_snapshot", legacy.fixtureId)), tbwb(cfgOf("match_states.state.cfg", legacy.fixtureId))]).toEqual([2, 2, 2]);
      const sudden = row("custom Fast4-shaped set, sudden-death");
      expect([tbwb(cfgOf("divisions.config", sudden.divisionId)), tbwb(cfgOf("fixtures.config_snapshot", sudden.fixtureId)), tbwb(cfgOf("match_states.state.cfg", sudden.fixtureId))]).toEqual([1, 1, 1]);
      // A match's own Fast4 format stores the WHOLE resolved set: its leaves alone plus the key would replace the stage's
      // set whole and drop its winBy (the parse above).
      expect(cfgOf("fixtures.rules_override", row("a tour stage, a match whose own format").fixtureId)).toEqual({
        set: { ...(TENNIS_TOUR.set as Json), gamesTo: 4, tiebreakAt: 3, tiebreakTo: 5, tiebreakWinBy: 2 },
      });
      expect(tbwb(cfgOf("stages.config.rules", row("a tour division, a stage whose own set").stageId))).toBe(1);
      const stageOnly = row("a Fast4 division (margin 2), a stage");
      expect(cfgOf("stages.config.rules", stageOnly.stageId)).toEqual({ tiebreak: { winBy: 1 }, set: { ...(fast4Legacy().set as Json), tiebreakWinBy: 1 } });
      expect(tbwb(cfgOf("divisions.config", stageOnly.divisionId))).toBe(2);
      expect(cfgOf("fixtures.rules_override", row("a Fast4 division (margin 2), a match").fixtureId)).toEqual({
        tiebreak: { winBy: 1 },
        set: { ...(fast4Legacy().set as Json), tiebreakWinBy: 1 },
      });
      expect(cfgOf("fixtures.rules_override", row("a Fast4 division, a match that changed only its tie-break target").fixtureId)).toEqual({ set: { tiebreakTo: 6 } });
      // 3. Untouched, value and row: not a Fast4 shape, already explicit, or not tennis.
      let untouched = 0;
      for (const s of rows.filter((r) => r.label.startsWith("untouched"))) {
        for (const column of COLUMNS) {
          const id = column === "divisions.config" ? s.divisionId : column === "stages.config.rules" ? s.stageId : s.fixtureId;
          const b = before[column].find((r) => r.id === id);
          if (!b) continue;
          expect(after[column].find((r) => r.id === id), `${s.label} ${column}`).toEqual(b);
          untouched += 1;
        }
      }
      // Four untouched seeds, each with a division, stage, match format, snapshot and state-cache row.
      expect(untouched, "anti-vacuity: untouched rows compared, ctid included").toBe(4 * COLUMNS.length);
    });
  }, 60_000);

  it("D18 migration touches no other key: each row equals itself minus the targeted keys, and a tennis set only gains keys", async () => {
    await rolledBack(async (tx, notices) => {
      const { orgId } = await seedRows(tx, [...KEY_SEEDS, ...FAST4_SEEDS]);
      await asTenant(tx, orgId);
      const before = await readStored(tx);
      await runDelta(tx, notices);
      const after = await readStored(tx);
      let checked = 0;
      for (const column of COLUMNS)
        for (const b of before[column]) {
          const a = after[column].find((r) => r.id === b.id)!;
          let bRest = b.raw;
          let aRest = a.raw;
          for (const key of ["suddenDeath", "progressScore"] as const)
            if (TARGET[key].includes(b.sport)) {
              bRest = removedFrom(column, key, bRest);
              aRest = removedFrom(column, key, aRest);
            }
          if (b.sport === "tennis") {
            const setPath = column === "stages.config.rules" ? ["rules", "set"] : column === "match_states.state.cfg" ? ["cfg", "set"] : ["set"];
            const bSet = setPath.reduce<unknown>((v, k) => (isObj(v) ? v[k] : undefined), b.raw);
            const aSet = setPath.reduce<unknown>((v, k) => (isObj(v) ? v[k] : undefined), a.raw);
            // Every leaf the set held is kept as it was; the delta only adds.
            if (isObj(bSet)) expect(aSet, `${column} ${b.id}`).toMatchObject(bSet);
            bRest = without(bRest, setPath);
            aRest = without(aRest, setPath);
          }
          expect(aRest, `${column} ${b.id}`).toEqual(bRest);
          checked += 1;
        }
      expect(checked, "anti-vacuity").toBeGreaterThan(COLUMNS.length * 10);
    });
  }, 60_000);

  it("D18 a second run changes no row: every update matches nothing, and no row is rewritten (ctid)", async () => {
    await rolledBack(async (tx, notices) => {
      const { orgId } = await seedRows(tx, [...KEY_SEEDS, ...FAST4_SEEDS]);
      await asTenant(tx, orgId);
      const first = await runDelta(tx, notices);
      expect(Object.values(first).reduce((a, b) => a + b, 0), "the first run changed rows").toBeGreaterThan(0);
      const once = await readStored(tx);
      const second = await runDelta(tx, notices);
      expect(Object.values(second).every((n) => n === 0), JSON.stringify(second)).toBe(true);
      expect(await readStored(tx)).toEqual(once);
    });
  }, 60_000);
});

// ── Refold: the ledger folds to the same result after the migration ──

interface Folded {
  outcome: unknown;
  summary: unknown;
  state: unknown;
}
const fold = async (tx: Tx, id: string): Promise<Folded | string> => {
  try {
    const f = await foldFixture(tx, id);
    return f === null ? "no events" : { outcome: f.outcome, summary: f.summary, state: f.state };
  } catch (e) {
    return `refold failed: ${(e as Error).message}`;
  }
};
const storedState = async (tx: Tx, id: string) => (await tx<{ state: unknown }[]>`select state from match_states where fixture_id = ${id}`)[0]?.state;

describe.skipIf(!HAS_DB)("W2e migration — a fixture's ledger refolds to the same outcome and summary (D18, Review Focus 5)", () => {
  it("D18 the pre-W2e server's own stored rows (w2d-pin-before.json): keys gone everywhere, every fixture refolds the same", async () => {
    await rolledBack(async (tx, notices) => {
      await seedW2dPinScenario(tx);
      await asW2dPinTenant(tx);
      const before = await readStored(tx);
      // The recording carries both keys in the three FULL places (no stage rule or match override held either).
      for (const [key, place] of [
        ["suddenDeath", "divisions.config"],
        ["suddenDeath", "fixtures.config_snapshot"],
        ["suddenDeath", "match_states.state.cfg"],
        ["progressScore", "divisions.config"],
        ["progressScore", "fixtures.config_snapshot"],
        ["progressScore", "match_states.state.cfg"],
      ] as const)
        expect(before[place].filter((r) => TARGET[key].includes(r.sport) && carries(key, r.cfg)).length, `${place} ${key}`).toBeGreaterThan(0);
      const played = await tx<{ id: string; sport: string }[]>`
        select distinct e.fixture_id as id, d.sport_key as sport
          from score_events e join fixtures f on f.id = e.fixture_id join divisions d on d.id = f.division_id order by 1`;
      expect(played.length, "anti-vacuity: fixtures with a ledger").toBeGreaterThan(50);
      const foldsBefore = new Map<string, Folded | string>();
      for (const { id } of played) foldsBefore.set(id, await fold(tx, id));
      const changed = await runDelta(tx, notices);
      // The delta's own count of each place equals the rows the recording held there.
      for (const key of ["suddenDeath", "progressScore"] as const)
        for (const column of COLUMNS)
          expect(changed[`${column} ${key === "suddenDeath" ? "shootout.suddenDeath" : "progressScore"}`], `${column} ${key}`).toBe(
            before[column].filter((r) => TARGET[key].includes(r.sport) && carries(key, r.cfg)).length,
          );
      const after = await readStored(tx);
      for (const column of COLUMNS)
        for (const r of after[column]) {
          if (TARGET.suddenDeath.includes(r.sport)) expect(keyPaths(r.cfg, "suddenDeath"), `${column} ${r.id}`).toEqual([]);
          if (TARGET.progressScore.includes(r.sport)) expect(keyPaths(r.cfg, "progressScore"), `${column} ${r.id}`).toEqual([]);
        }
      // The fold carries the frozen snapshot into `state.cfg` as stored, so the refolded state differs by exactly the
      // removed key; the outcome and the summary do not move at all.
      let same = 0;
      let cfgMoved = 0;
      for (const { id, sport } of played) {
        const b = foldsBefore.get(id)! as Folded;
        const a = (await fold(tx, id)) as Folded;
        expect(typeof b, `${id}: folded before`).toBe("object");
        expect([a.outcome, a.summary], `${id} (${sport}): outcome and summary`).toEqual([b.outcome, b.summary]);
        let want: unknown = b.state;
        for (const key of ["suddenDeath", "progressScore"] as const) if (TARGET[key].includes(sport)) want = without(want, ["cfg", ...KEY_PATH[key]]);
        expect(a.state, `${id} (${sport}): state, less the removed key`).toEqual(want);
        if (want !== b.state && JSON.stringify(want) !== JSON.stringify(b.state)) cfgMoved += 1;
        same += 1;
      }
      expect(same).toBe(played.length);
      expect(cfgMoved, "anti-vacuity: refolds whose cfg lost a key").toBeGreaterThan(0);
    });
  }, 180_000);

  // Ledgers written through the real write path (scoreEvent), then put back in their pre-W2e stored shape.
  const homeAway = async (id: string) =>
    (await sql<{ home: string; away: string }[]>`select home_entrant_id as home, away_entrant_id as away from fixtures where id = ${id}`)[0]!;
  const shootoutNext = async (id: string): Promise<string | null> =>
    (await sql<{ next: string | null }[]>`select summary #>> '{detail,shootoutNext}' as next from match_states where fixture_id = ${id}`)[0]?.next ?? null;

  /** A league fixture played into its shoot-out and three attempts in (the order the summary names), mid-shoot-out. */
  async function midShootout(sport: "hockey" | "icehockey", variant: string, regulation: readonly string[]) {
    const s = await seedBracket({ sport, variant, stageKind: "league", entrants: 2 });
    const id = s.fixtureIds[0]!;
    const { home, away } = await homeAway(id);
    await post(s.auth, id, "core.start");
    for (const to of regulation) await post(s.auth, id, `${sport}.period.advance`, { to });
    for (const scored of [true, false, true]) {
      const next = await shootoutNext(id);
      await post(s.auth, id, `${sport}.shootout.attempt`, { by: next === "away" ? away : home, scored });
    }
    const [phase] = await sql<{ phase: string }[]>`select state->>'phase' as phase from match_states where fixture_id = ${id}`;
    expect(phase!.phase, "rig: mid-shoot-out").toBe("SHOOTOUT");
    return { s, id };
  }

  it("D18 a hockey and an ice hockey fixture frozen with shootout.suddenDeath, mid-shoot-out: same outcome and summary; the state cache still equals the refold", async () => {
    let checked = 0;
    for (const [sport, variant, regulation] of [
      ["hockey", "fih-shootout", ["Q2", "Q3", "Q4", "FT"]],
      ["icehockey", "iihf", ["P2", "P3", "FT", "FT"]],
    ] as const) {
      const { s, id } = await midShootout(sport, variant, regulation);
      await rolledBack(async (tx, notices) => {
        // The pre-W2e stored shape: every place a W2e write no longer puts the key.
        await tx`update divisions set config = jsonb_set(config, '{shootout,suddenDeath}', 'true') where id = ${s.divisionId}`;
        await tx`update fixtures set config_snapshot = jsonb_set(config_snapshot, '{shootout,suddenDeath}', 'true') where id = ${id}`;
        await tx`update match_states set state = jsonb_set(state, '{cfg,shootout,suddenDeath}', 'true') where fixture_id = ${id}`;
        await asTenant(tx, s.auth.orgId);
        const before = await fold(tx, id);
        expect(typeof before, "rig: folds").toBe("object");
        // The fold carries the frozen snapshot into `state.cfg` as stored: the legacy cache IS the refold, key included.
        expect(await storedState(tx, id), "rig: the legacy cache is the refold").toEqual((before as Folded).state);
        expect(keyPaths((before as Folded).state, "suddenDeath"), "rig: the refold carries the key").toEqual(["$.cfg.shootout.suddenDeath"]);
        const changed = await runDelta(tx, notices);
        expect(
          [changed["divisions.config shootout.suddenDeath"], changed["fixtures.config_snapshot shootout.suddenDeath"], changed["match_states.state.cfg shootout.suddenDeath"]],
          sport,
        ).toEqual([1, 1, 1]);
        const after = await fold(tx, id);
        expect([(after as Folded).outcome, (after as Folded).summary], `${sport}: outcome and summary`).toEqual([(before as Folded).outcome, (before as Folded).summary]);
        expect((after as Folded).state, `${sport}: the state, less the key`).toEqual(without((before as Folded).state, ["cfg", "shootout", "suddenDeath"]));
        expect(await storedState(tx, id), `${sport}: the cache equals the refold`).toEqual((after as Folded).state);
        checked += 1;
      });
    }
    expect(checked).toBe(2);
  }, 120_000);

  /** A Fast4 league fixture stored as a pre-W2e server stored it (no `set.tiebreakWinBy`), scored point by point: set 1
   *  to 3–3, its tie-break to 4–4, then two home points. At margin 2 the second ends the tie-break 6–4; at margin 1 the
   *  first ends it 5–4 and the second opens set 2 — so the two margins fold to different summaries. */
  async function fast4Played(tiebreakWinBy?: number) {
    const s = await seedBracket({ sport: "tennis", variant: "fast4", stageKind: "league", entrants: 2, divisionConfig: fast4Legacy(tiebreakWinBy) });
    const id = s.fixtureIds[0]!;
    const { home, away } = await homeAway(id);
    const [d] = await sql<{ set: Json }[]>`select config->'set' as set from divisions where id = ${s.divisionId}`;
    expect("tiebreakWinBy" in d!.set, "rig: the stored set has no margin, as before W2e").toBe(false);
    await post(s.auth, id, "core.start");
    const point = (by: string) => post(s.auth, id, "tennis.point", { by });
    for (let game = 0; game < 6; game++) for (let p = 0; p < 4; p++) await point(game % 2 === 0 ? home : away);
    for (let p = 0; p < 8; p++) await point(p % 2 === 0 ? home : away);
    await point(home);
    await point(home);
    return { s, id };
  }

  it("D18 a Fast4 fixture with a tie-break, at margin 2 and at an organiser's margin 1: same outcome and summary, the margin pinned explicitly", async () => {
    const summaries: unknown[] = [];
    for (const margin of [undefined, 1] as const) {
      const { s, id } = await fast4Played(margin);
      await rolledBack(async (tx, notices) => {
        await asTenant(tx, s.auth.orgId);
        const before = await fold(tx, id);
        expect(typeof before, "rig: folds").toBe("object");
        expect(await storedState(tx, id), "rig: the cache is the refold").toEqual((before as Folded).state);
        const changed = await runDelta(tx, notices);
        expect([changed["divisions.config set.tiebreakWinBy"], changed["fixtures.config_snapshot set.tiebreakWinBy"], changed["match_states.state.cfg set.tiebreakWinBy"]]).toEqual([1, 1, 1]);
        const [snap] = await tx<{ m: number }[]>`select (config_snapshot #>> '{set,tiebreakWinBy}')::int as m from fixtures where id = ${id}`;
        expect(snap!.m, "the margin it was playing").toBe(margin ?? 2);
        const after = await fold(tx, id);
        expect([(after as Folded).outcome, (after as Folded).summary], `margin ${margin ?? 2}`).toEqual([(before as Folded).outcome, (before as Folded).summary]);
        expect(await storedState(tx, id), "the cache equals the refold").toEqual((after as Folded).state);
        // The tie-break the ledger played at 4–4: first to `tiebreakTo`, by the margin (the preset's target, not a literal).
        const to = (TENNIS_FAST4.set as Json).tiebreakTo as number;
        const tb = ((before as Folded).summary as { detail: { sets: { tb?: unknown }[] } }).detail.sets[0]!.tb;
        expect(tb, `margin ${margin ?? 2}: set 1's tie-break`).toEqual(margin === 1 ? { home: to, away: to - 1 } : { home: to + 1, away: to - 1 });
        summaries.push(tb);
      });
    }
    // The differential: the two margins really fold differently, so a migration that wrote one margin for both would show.
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).not.toEqual(summaries[1]);
  }, 120_000);
});

// ── Fail loud ──

const LIST = "([0-9a-f,-]*)";
const REFUSAL = new RegExp(
  `^W2e stored configs the write doors refuse: count=(\\d+) ${COLUMNS.map((c) => `${c.replace(/\./g, "\\.")}=${LIST}`).join(" ")}$`,
);
type Refusal = { count: number; hint: string | null } & Record<Column, string[]>;
/** The delta in a savepoint: its refusal parsed, or null when it ran. An error that is not the delta's is thrown. */
async function refusalOf(tx: Tx): Promise<Refusal | null> {
  try {
    await tx.savepoint(async (sp) => {
      await sp.unsafe(BLOCK!);
    });
    return null;
  } catch (e) {
    const m = REFUSAL.exec((e as Error).message);
    if (!m) throw e;
    const lists = Object.fromEntries(COLUMNS.map((c, i) => [c, m[i + 2] === "" ? [] : m[i + 2]!.split(",")])) as Record<Column, string[]>;
    return { count: Number(m[1]), hint: (e as { hint?: string }).hint ?? null, ...lists };
  }
}
/** The id the delta names a row by in `column`'s list (a snapshot and a state cache are named by their fixture). */
const idAt = (r: Seeded, column: Column): string =>
  column === "divisions.config" ? r.divisionId : column === "stages.config.rules" ? r.stageId : r.fixtureId;

const VOLLEYBALL = parsed("volleyball", {});
const TABLETENNIS = parsed("tabletennis", {});
const MTB = { matchTiebreakTo: 10 };
/** Each refused seed names the place the refusal is counted on; the rest are its positive pairs. */
const FLOOR_SEEDS: (Seed & { refusedAt?: Column })[] = [
  { label: "volleyball division setTo 3", sport: "volleyball", variant: "indoor", division: { ...VOLLEYBALL, setTo: 3 }, refusedAt: "divisions.config" },
  { label: "table tennis stage finalSetTo 4", sport: "tabletennis", variant: "bo5", division: TABLETENNIS, stageRules: { finalSetTo: 4 }, refusedAt: "stages.config.rules" },
  { label: "volleyball match setTo 3", sport: "volleyball", variant: "indoor", division: VOLLEYBALL, override: { setTo: 3 }, refusedAt: "fixtures.rules_override" },
  { label: "volleyball snapshot setTo 3", sport: "volleyball", variant: "indoor", division: VOLLEYBALL, snapshot: { ...VOLLEYBALL, setTo: 3 }, refusedAt: "fixtures.config_snapshot" },
  { label: "tennis division best of 1 with a match tie-break", sport: "tennis", variant: "tour", division: { ...TENNIS_TOUR, bestOf: 1, finalSet: MTB }, refusedAt: "divisions.config" },
  { label: "tennis stage best of 1 under a match tie-break division", sport: "tennis", variant: "doubles-noad-mtb10", division: { ...TENNIS_TOUR, finalSet: MTB }, stageRules: { bestOf: 1 }, refusedAt: "stages.config.rules" },
  { label: "tennis match's own match tie-break under a best of 1", sport: "tennis", variant: "tour", division: { ...TENNIS_TOUR, bestOf: 1 }, override: { finalSet: MTB }, refusedAt: "fixtures.rules_override" },
  { label: "tennis state cache best of 1 with a match tie-break", sport: "tennis", variant: "tour", division: TENNIS_TOUR, stateCfg: { ...TENNIS_TOUR, bestOf: 1, finalSet: MTB }, refusedAt: "match_states.state.cfg" },
  // Positive pairs: at the floor, a sport with no floor, a final-set tie-break, a best of 3.
  { label: "volleyball at the floor (5)", sport: "volleyball", variant: "indoor", division: { ...VOLLEYBALL, setTo: 5, finalSetTo: 5 }, stageRules: { setTo: 5 }, override: { finalSetTo: 5 }, snapshot: { ...VOLLEYBALL, setTo: 5 }, stateCfg: { ...VOLLEYBALL, finalSetTo: 5 } },
  { label: "badminton setTo 3 (no floor)", sport: "badminton", variant: "bwf", division: { ...parsed("badminton", {}), setTo: 3, finalSetTo: 3 } },
  { label: "tennis best of 1 with a final-set tie-break", sport: "tennis", variant: "tour", division: { ...TENNIS_TOUR, bestOf: 1, finalSet: { tiebreakTo: 10 } } },
  { label: "tennis best of 3 with a match tie-break, a match on best of 3", sport: "tennis", variant: "doubles-noad-mtb10", division: { ...TENNIS_TOUR, finalSet: MTB }, override: { bestOf: 3 }, snapshot: { ...TENNIS_TOUR, finalSet: MTB }, stateCfg: { ...TENNIS_TOUR, finalSet: MTB } },
];

/** Runs `body` in a savepoint that is always rolled back (its tenant role and settings with it). */
const SP_ROLLBACK = new Error("savepoint rollback");
async function inRolledBackSavepoint<T>(tx: Tx, body: (sp: Tx) => Promise<T>): Promise<T> {
  let value: T | undefined;
  await tx
    .savepoint(async (sp) => {
      value = await body(sp as unknown as Tx);
      throw SP_ROLLBACK;
    })
    .catch((e: unknown) => {
      if (e !== SP_ROLLBACK) throw e;
    });
  return value as T;
}

describe.skipIf(!HAS_DB)("W2e migration — fails loud on a stored config the write doors refuse (PO decision, Task 13)", () => {
  it("D18 fail loud: empty case first; a refused config in each A0.7 place raises naming exactly those rows, and writes nothing; once they are put right it runs", async () => {
    await rolledBack(async (tx) => {
      // The empty case: an org with only positive pairs (and a hockey row the delta would clean) passes.
      const clean = await seedRows(tx, [...FLOOR_SEEDS.filter((s) => s.refusedAt === undefined), KEY_SEEDS[0]!]);
      await asTenant(tx, clean.orgId);
      expect(await refusalOf(tx), "the positive pairs refuse nothing").toBeNull();
    });
    await rolledBack(async (tx) => {
      const { orgId, rows } = await seedRows(tx, [...FLOOR_SEEDS, KEY_SEEDS[0]!]);
      await asTenant(tx, orgId);
      const refused = FLOOR_SEEDS.filter((s) => s.refusedAt !== undefined);
      expect(new Set(refused.map((s) => s.refusedAt)), "anti-vacuity: every place refuses once").toEqual(new Set(COLUMNS));
      const idOf = (label: string, at: Column) => idAt(rows.find((x) => x.label === label)!, at);
      const want = Object.fromEntries(
        COLUMNS.map((c) => [c, refused.filter((s) => s.refusedAt === c).map((s) => idOf(s.label, c)).sort()]),
      ) as Record<Column, string[]>;
      const v = await refusalOf(tx);
      expect(v, "the delta refuses").not.toBeNull();
      expect({ ...v!, hint: null }).toEqual({ count: refused.length, hint: null, ...want });
      expect(v!.hint, "the remedy").toMatch(/setTo and finalSetTo to 5 or more[\s\S]*best-of-1 tennis[\s\S]*snapshot or state cache/);
      // Nothing was written: the hockey row still holds its key in every place.
      const hockeyRow = rows.find((r) => r.sport === "hockey")!;
      const [still] = await tx<{ n: number }[]>`
        select ((select config from divisions where id = ${hockeyRow.divisionId}) -> 'shootout' ? 'suddenDeath')::int
             + ((select config_snapshot from fixtures where id = ${hockeyRow.fixtureId}) -> 'shootout' ? 'suddenDeath')::int as n`;
      expect(still!.n, "the refusal wrote nothing").toBe(2);
      // The remedy its hint names, then the run: it passes and cleans.
      await tx`update divisions set config = config || '{"setTo": 25}' where id = ${idOf("volleyball division setTo 3", "divisions.config")}`;
      await tx`update stages set config = config #- '{rules,finalSetTo}' where id = ${idOf("table tennis stage finalSetTo 4", "stages.config.rules")}`;
      await tx`update fixtures set rules_override = null where id = ${idOf("volleyball match setTo 3", "fixtures.rules_override")}`;
      await tx`update fixtures set config_snapshot = config_snapshot || '{"setTo": 25}' where id = ${idOf("volleyball snapshot setTo 3", "fixtures.config_snapshot")}`;
      await tx`update divisions set config = config || '{"finalSet": "same"}' where id = ${idOf("tennis division best of 1 with a match tie-break", "divisions.config")}`;
      await tx`update stages set config = '{}' where id = ${idOf("tennis stage best of 1 under a match tie-break division", "stages.config.rules")}`;
      await tx`update fixtures set rules_override = '{"finalSet": {"tiebreakTo": 10}}' where id = ${idOf("tennis match's own match tie-break under a best of 1", "fixtures.rules_override")}`;
      await tx`update match_states set state = jsonb_set(state, '{cfg,bestOf}', '3') where fixture_id = ${idOf("tennis state cache best of 1 with a match tie-break", "match_states.state.cfg")}`;
      expect(await refusalOf(tx), "put right, it runs").toBeNull();
      const [gone] = await tx<{ has: boolean }[]>`select (config -> 'shootout') ? 'suddenDeath' as has from divisions where id = ${hockeyRow.divisionId}`;
      expect(gone!.has, "and cleans").toBe(false);
    });
  }, 60_000);

  it("D18 fail loud: a stored tennis best of 1 with a match tie-break ALONE stops the migration (review I-1)", async () => {
    await rolledBack(async (tx) => {
      const seed = FLOOR_SEEDS.find((s) => s.label === "tennis division best of 1 with a match tie-break")!;
      const { orgId, rows } = await seedRows(tx, [seed, KEY_SEEDS[0]!]);
      await asTenant(tx, orgId);
      const v = await refusalOf(tx);
      expect(v && { count: v.count, divisions: v["divisions.config"] }).toEqual({ count: 1, divisions: [rows[0]!.divisionId] });
    });
  }, 60_000);

  // Review I-1: the SQL predicates mirror the engine's write doors, so pin them to the doors. Each shape is a diff over a
  // clean shipped config, stored in each A0.7 place in turn (alone in its organization); the delta counts it there iff
  // the engine's `writeConfigIssues` refuses the config that place resolves to. The shapes are built from the engine's
  // own floor (one below it, at it) and its best-of-1 refusal (and the pairs it accepts), so a floor or rule that moves
  // in the engine reds here until the SQL moves with it.
  it("D18 the fail-loud count agrees with the engine's writeConfigIssues, shape by shape and place by place", async () => {
    const floors = engineFloors();
    const lowest = Math.min(...floors.values());
    const shapes: { sport: string; variant: string; diff: Json; why: string }[] = [];
    for (const [sport, floor] of floors) {
      const variant = Object.keys(moduleOf(sport).variants)[0]!;
      shapes.push(
        { sport, variant, diff: { setTo: floor - 1 }, why: "setTo below the floor" },
        { sport, variant, diff: { finalSetTo: floor - 1 }, why: "finalSetTo below the floor" },
        { sport, variant, diff: { setTo: floor, finalSetTo: floor }, why: "at the floor" },
      );
    }
    for (const m of builtinModules) {
      const base = allDefaults(m);
      if (base === null || typeof base.setTo !== "number" || floors.has(m.key)) continue;
      shapes.push({ sport: m.key, variant: Object.keys(m.variants)[0]!, diff: { setTo: lowest - 1, finalSetTo: lowest - 1 }, why: "a set sport with no floor" });
    }
    for (const sport of engineBo1MatchTiebreakSports()) {
      const variant = Object.keys(moduleOf(sport).variants)[0]!;
      shapes.push(
        { sport, variant, diff: { bestOf: 1, finalSet: MTB }, why: "best of 1 with a match tie-break" },
        { sport, variant, diff: { bestOf: 3, finalSet: MTB }, why: "best of 3 with a match tie-break" },
        { sport, variant, diff: { bestOf: 1, finalSet: { tiebreakTo: 10 } }, why: "best of 1 with a final-set tie-break" },
        { sport, variant, diff: { bestOf: 1, finalSet: "same" }, why: "best of 1 without a match tie-break" },
      );
    }
    const tally = { refused: 0, accepted: 0 };
    await rolledBack(async (tx) => {
      for (const shape of shapes) {
        const m = moduleOf(shape.sport);
        const clean = parsed(shape.sport, m.variants[shape.variant]);
        expect(writeConfigIssues(m, clean), `${shape.sport}/${shape.variant}: the clean config`).toEqual([]);
        const whole = { ...clean, ...shape.diff };
        for (const place of COLUMNS) {
          const seed: Seed = {
            label: `${shape.why} @ ${place}`,
            sport: shape.sport,
            variant: shape.variant,
            division: place === "divisions.config" ? whole : clean,
            ...(place === "stages.config.rules" ? { stageRules: shape.diff } : {}),
            ...(place === "fixtures.rules_override" ? { override: shape.diff } : {}),
            ...(place === "fixtures.config_snapshot" ? { snapshot: whole } : {}),
            ...(place === "match_states.state.cfg" ? { stateCfg: whole } : {}),
          };
          // The config the place resolves to, as the product resolves it.
          const stageCfg = liveCfg(seed.division, { kind: "league", config: seed.stageRules === undefined ? {} : { rules: seed.stageRules } } as never, m as never) as Json;
          const resolvedAt: Record<Column, unknown> = {
            "divisions.config": seed.division,
            "stages.config.rules": stageCfg,
            "fixtures.rules_override": mergeRulesOverride(stageCfg, seed.override),
            "fixtures.config_snapshot": seed.snapshot,
            "match_states.state.cfg": seed.stateCfg,
          };
          const engineRefuses = writeConfigIssues(m, resolvedAt[place]).length > 0;
          const v = await inRolledBackSavepoint(tx, async (sp) => {
            const { orgId, rows } = await seedRows(sp, [seed]);
            await asTenant(sp, orgId);
            const r = await refusalOf(sp);
            return r && { count: r.count, named: r[place], id: idAt(rows[0]!, place) };
          });
          const sqlCounts = v !== null && v.count === 1 && v.named.length === 1 && v.named[0] === v.id;
          expect(v === null || sqlCounts, `${seed.label}: a refusal names this row alone`).toBe(true);
          expect(sqlCounts, `${shape.sport} ${seed.label}: the delta counts it iff the engine refuses it`).toBe(engineRefuses);
          tally[engineRefuses ? "refused" : "accepted"] += 1;
        }
      }
    });
    // Anti-vacuity, both sides: every refusing shape in all five places, and its accepted pairs.
    expect(tally.refused, "refused shape × place").toBe((2 * floors.size + engineBo1MatchTiebreakSports().size) * COLUMNS.length);
    expect(tally.accepted, "accepted shape × place").toBeGreaterThan(0);
  }, 180_000);

  it("D18 fail loud over the whole database, as the migration runs: the refusal names a seeded row beside whatever else the DB holds, its lists as long as its count", async () => {
    await rolledBack(async (tx) => {
      const { rows } = await seedRows(tx, [FLOOR_SEEDS[0]!]);
      const v = await refusalOf(tx);
      expect(v, "refused").not.toBeNull();
      expect(v!["divisions.config"]).toContain(rows[0]!.divisionId);
      expect(COLUMNS.reduce((n, c) => n + v![c].length, 0)).toBe(v!.count);
    });
  }, 60_000);
});

// ── Task 12 carry: a started generic division saves once its stored progressScore is gone ──

describe.skipIf(!HAS_DB)("W2e migration — Task 12 carry: a started generic division storing progressScore", () => {
  it("D18 before the migration a save gets 409 DIVISION_FORMAT_LOCKED (the dropped key reads as a change); after it, the same save and a settings change go through", async () => {
    const s = await seedBracket({ sport: "generic", variant: "score", stageKind: "league", entrants: 2 });
    await post(s.auth, s.fixtureIds[0]!, "core.start");
    // The pre-W2e stored shape (W2e's parse no longer writes the key).
    await sql`update divisions set config = config || '{"progressScore": false}'::jsonb where id = ${s.divisionId}`;
    const stored = async () => (await sql<{ config: Json }[]>`select config from divisions where id = ${s.divisionId}`)[0]!.config;
    const legacy = await stored();
    expect(legacy.progressScore, "rig").toBe(false);
    // The Settings page re-sends the stored config.
    await expect(patchDivision(s.auth, s.divisionId, { config: legacy } as never)).rejects.toMatchObject({
      status: 409,
      code: "DIVISION_FORMAT_LOCKED",
      extra: { refused: [expect.objectContaining({ field: "progressScore", code: "DIVISION_FORMAT_LOCKED" })] },
    });
    // The migration, committed, scoped by RLS to this fresh organization.
    const url = process.env.DATABASE_URL!;
    const client = postgres(url, { max: 1, ssl: connectionOptions(url).ssl, connection: { search_path: connectionOptions(url).schema }, onnotice: () => {} });
    try {
      await client.begin(async (tx) => {
        await asTenant(tx as unknown as Tx, s.auth.orgId);
        await tx.unsafe(BLOCK!);
      });
    } finally {
      await client.end();
    }
    const migrated = await stored();
    expect("progressScore" in migrated, "the migration removed it").toBe(false);
    const resend = await patchDivision(s.auth, s.divisionId, { config: migrated } as never);
    expect(resend.refused, "the same save, nothing refused").toEqual([]);
    const points = { ...(migrated.points as Json), w: 2 };
    const changed = await patchDivision(s.auth, s.divisionId, { config: { ...migrated, points } } as never);
    expect(changed.refused).toEqual([]);
    expect((await stored()).points, "the settings change landed").toEqual(points);
  }, 60_000);
});
