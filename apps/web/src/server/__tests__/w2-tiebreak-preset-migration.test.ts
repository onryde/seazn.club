// W2 release (owner rule D18: "always loud when data changes and need migration before deploying") — the stored tie-break
// list delta, which runs before the deploy:
//  1. it expands a football preset NAME stored where its keys belong (`["fifa2026"]`, written before the F5 edge guard
//     `TiebreakerKeyS`) into that preset's keys, spliced in place and de-duplicated keeping the first occurrence, in every
//     place a football list is stored (division, division config, stage's own order, the stage's pin);
//  2. it FAILS LOUD while any list the standings read reads is one that read refuses (a value that is not a list, an
//     entry that is not a string or not a key, a block modifier out of place, an empty list where the loader refuses it),
//     naming every list, and writes nothing.
// Staging (2026-10-30): 3 football divisions of the archived "FIFA World Cup 2027" hold `["fifa2026"]`, and V475's pin
// copied it into their 6 started stages' `table_rules_pinned.tiebreakers` — the place a started stage is actually read from.
//
// The delta is read by GLOB, never by number (it is renumbered at merge), and its OWN text runs here: inside a transaction
// on a dedicated client that is always rolled back, scoped to the seeded organization as the app's tenant role
// (`app_user` + `app.current_org`), so RLS shows it that org's rows alone and every count is the seed's (the shared test
// DB holds sibling suites' rows). Expected values come from the engine's declarations (`FOOTBALL_TIEBREAKERS`, the
// football module's `tablePresets`, `TiebreakerKeyS.options`, each sport's `defaultTiebreakers` and `tablePointsRule`)
// and from the read path itself (`tableRulesOf` + `rankStandings`, the loader and the ranker every standings read goes
// through) — never from the SQL under test.
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { EngineError } from "@seazn/engine/core";
import { defaultCrossGroup, rankStandings } from "@seazn/engine/competition";
import type { AnySportModule, TableStageKind, TiebreakerKey } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { FOOTBALL_TIEBREAKERS } from "@seazn/engine/sports/football";
import { TiebreakerKeyS } from "@/server/api-v1/schemas";
import { connectionOptions, sql, type Tx } from "@/lib/db";
import { rankedStageStandings } from "@/server/engine-db/competition";
import { tableRulesOf, tableRulesRowsOf } from "@/server/engine-db/table-rules";
import { seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { post } from "@/server/engine-db/__tests__/helpers/w2b-rig";

const HAS_DB = !!process.env.DATABASE_URL;
const DELTAS = resolve(__dirname, "../../../../../db/migration/deltas");
const NAME = /^V\d+__w2_tiebreak_preset_names\.sql$/;
const files = readdirSync(DELTAS).filter((f) => NAME.test(f));
const text = files.length === 1 ? readFileSync(resolve(DELTAS, files[0]!), "utf8") : "";
/** The statements, comments removed: a `--` line naming a literal must not satisfy a regex meant for the SQL. */
const code = text.replace(/--.*$/gm, "");
const BLOCK = /do \$\$[\s\S]*?end \$\$;/.exec(code)?.[0];

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
const firstVariant = (m: AnySportModule): string => Object.keys(m.variants)[0]!;
const cfgOf = (m: AnySportModule): Json => m.configSchema.parse(m.variants[firstVariant(m)]) as Json;

// ── The SQL's literals ──
const sqlTextArray = (name: string): string[] => {
  const body = new RegExp(`${name} constant text\\[\\] := array\\[([^\\]]*)\\]`).exec(code)?.[1];
  return body === undefined ? [] : [...body.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]!);
};
const SQL_PRESETS = ((): Record<string, string[]> => {
  const body = /presets constant jsonb := '([^']*)'/.exec(code)?.[1];
  return body === undefined ? {} : (JSON.parse(body) as Record<string, string[]>);
})();
const SQL_KEYS = sqlTextArray("tiebreak_keys");
const SQL_BLOCK_KEYS = sqlTextArray("block_keys");
const SQL_MODIFIERS = sqlTextArray("modifier_keys");

// ── What the read path refuses, asked of the read path (the ranker every standings read runs) ──
/** The ranker's verdict on an order: null when it runs, else its CONFIG_INVALID message. Zero rows: the cascade is parsed
 *  up front (`parseCascade`), so the refusal does not depend on the table. */
function rankRefusal(cascade: readonly unknown[]): string | null {
  try {
    rankStandings([], { cascade: cascade as TiebreakerKey[] });
    return null;
  } catch (e) {
    if (e instanceof EngineError && e.code === "CONFIG_INVALID") return e.message;
    throw e;
  }
}
const KEYS = TiebreakerKeyS.options as readonly TiebreakerKey[];
/** The block modifiers: the keys the ranker refuses directly after a plain step. */
const MODIFIERS = KEYS.filter((k) => rankRefusal(["points", k, "lots"]) !== null);
/** The head-to-head block keys: the keys a modifier may directly follow. */
const BLOCK_KEYS = KEYS.filter((k) => !MODIFIERS.includes(k) && rankRefusal([k, MODIFIERS[0]]) === null);

/** The table stage kinds a sport is asked its presets for (`TableStageKind`). */
const TABLE_KINDS: readonly TableStageKind[] = ["league", "group", "swiss", "americano"];
/** The sports that declare named tie-break presets on any table stage kind: sport → kind → presets. */
const NAMED_PRESETS = new Map(
  builtinModules
    .map((m) => [m.key, new Map(TABLE_KINDS.map((k) => [k, m.tablePresets?.(k).tiebreakers ?? []] as const))] as const)
    .filter(([, byKind]) => [...byKind.values()].some((presets) => presets.length > 0)),
);
const PRESET_NAMES = Object.keys(FOOTBALL_TIEBREAKERS) as (keyof typeof FOOTBALL_TIEBREAKERS)[];

describe("W2 tie-break preset migration — its text (no DB)", () => {
  it("the delta exists exactly once, by name pattern; one block expands BEFORE it censuses, and the census raises", () => {
    expect(files, `one ${NAME} in db/migration/deltas`).toHaveLength(1);
    expect(BLOCK, "a do block").toBeDefined();
    const firstUpdate = BLOCK!.search(/\bupdate\s+(divisions|stages)\b/i);
    const raise = BLOCK!.search(/raise exception/i);
    expect(firstUpdate, "an update").toBeGreaterThan(0);
    expect(raise, "the census raise comes after every expansion").toBeGreaterThan(BLOCK!.lastIndexOf("expanded=%"));
    expect((BLOCK!.match(/\bupdate\s+(divisions|stages)\b/gi) ?? []).length, "one update per expanded place").toBe(4);
  });

  it("D18 the SQL key list IS TiebreakerKeyS.options (so a new engine key cannot drift past the census)", () => {
    expect(SQL_KEYS.length, "anti-vacuity").toBeGreaterThan(0);
    expect(SQL_KEYS).toEqual([...TiebreakerKeyS.options]);
  });

  it("D18 the SQL presets ARE FOOTBALL_TIEBREAKERS and the football module's named presets; no other sport names one", () => {
    expect(builtinModules.length, "anti-vacuity: the registry").toBeGreaterThan(1);
    expect([...NAMED_PRESETS.keys()], "the sports with named tie-break presets").toEqual(["football"]);
    let kinds = 0;
    for (const [kind, presets] of NAMED_PRESETS.get("football")!) {
      expect(Object.fromEntries(presets.map((p) => [p.id, [...p.keys]])), `football ${kind}: its presets are FOOTBALL_TIEBREAKERS`).toEqual(FOOTBALL_TIEBREAKERS);
      kinds += 1;
    }
    expect(kinds, "anti-vacuity: every table stage kind").toBe(TABLE_KINDS.length);
    expect(SQL_PRESETS).toEqual(FOOTBALL_TIEBREAKERS);
    expect(Object.keys(SQL_PRESETS).length, "anti-vacuity").toBe(PRESET_NAMES.length);
    // The expansion is scoped to football: every sport_key the expansion's lists name.
    const expansion = BLOCK!.slice(0, BLOCK!.search(/raise exception/i));
    const firstCte = expansion.slice(0, expansion.search(/\bupdate\s+divisions\b/i));
    expect(new Set([...firstCte.matchAll(/sport_key\s*=\s*'([a-z]+)'/g)].map((m) => m[1]))).toEqual(new Set(NAMED_PRESETS.keys()));
    expect([...firstCte.matchAll(/sport_key\s*=/g)].length, "one per expanded place").toBe(4);
  });

  it("D18 the SQL block keys and modifiers ARE the ranker's (a modifier directly follows a block key)", () => {
    expect(MODIFIERS.length, "anti-vacuity: modifiers").toBeGreaterThan(0);
    expect(BLOCK_KEYS.length, "anti-vacuity: block keys").toBeGreaterThan(0);
    for (const m of MODIFIERS) expect(rankRefusal(["points", m, "lots"]), m).toMatch(/head-to-head block/);
    for (const m of MODIFIERS) for (const b of BLOCK_KEYS) expect(rankRefusal(["points", b, m, "lots"]), `${b} ${m}`).toBeNull();
    // At most one modifier per block.
    expect(rankRefusal(["points", BLOCK_KEYS[0], MODIFIERS[0], MODIFIERS[0], "lots"])).toMatch(/head-to-head block/);
    expect(new Set(SQL_MODIFIERS)).toEqual(new Set(MODIFIERS));
    expect(new Set(SQL_BLOCK_KEYS)).toEqual(new Set(BLOCK_KEYS));
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

const PLACES = [
  "divisions.tiebreakers",
  "divisions.config.tiebreakers",
  "stages.config.tiebreakers",
  "stages.config.crossGroupTiebreakers",
  "stages.table_rules_pinned.tiebreakers",
  "stages.table_rules_pinned.crossGroup",
] as const;
type Place = (typeof PLACES)[number];
const EXPANDED_PLACES: readonly Place[] = ["divisions.tiebreakers", "divisions.config.tiebreakers", "stages.config.tiebreakers", "stages.table_rules_pinned.tiebreakers"];

interface Delta {
  expanded: Record<string, { n: number; ids: string[] }>;
  checked: Record<string, number>;
  checkedTotal: number;
  unread: string | null;
}
const EXPANDED = /^W2 tie-break preset names: (\S+) expanded=(\d+) ids=([0-9a-f,-]*)$/;
const CENSUS = /^W2 tie-break census: checked=(\d+) (.*) refused=0$/;
const UNREAD = /^W2 tie-break census: divisions\.config\.tiebreakers is read by nothing; lists there the read would refuse: (.*)$/;

/** Runs the delta's block; returns what its notices reported. A notice that is not the delta's is a failure. */
async function runDelta(tx: Tx, notices: string[]): Promise<Delta> {
  const from = notices.length;
  await tx.unsafe(BLOCK!);
  const out: Delta = { expanded: {}, checked: {}, checkedTotal: -1, unread: null };
  for (const n of notices.slice(from)) {
    let m: RegExpExecArray | null;
    if ((m = EXPANDED.exec(n))) out.expanded[m[1]!] = { n: Number(m[2]), ids: m[3] === "" ? [] : m[3]!.split(",") };
    else if ((m = CENSUS.exec(n))) {
      out.checkedTotal = Number(m[1]);
      for (const pair of m[2]!.split(" ")) {
        const [k, v] = pair.split("=");
        out.checked[k!] = Number(v);
      }
    } else if ((m = UNREAD.exec(n))) out.unread = m[1]!;
    else throw new Error(`a notice that is not the delta's: ${n}`);
  }
  expect(Object.keys(out.expanded).sort(), "a notice per expanded place").toEqual([...EXPANDED_PLACES].sort());
  expect(Object.keys(out.checked).sort(), "the census names every place").toEqual([...PLACES].sort());
  return out;
}

interface Refused {
  place: string;
  id: string;
  sport: string;
  entry: string;
  why: string;
}
const REFUSAL = /^W2 stored tie-break lists the standings read refuses: count=(\d+) (.*)$/s;
const ROW = /^place=(\S+) id=(\S+) sport=(\S+) entry=(.*) why=(.+)$/s;
/** The delta in a savepoint: its refusal parsed, or null when it ran. An error that is not the delta's is thrown. */
async function refusalOf(tx: Tx): Promise<{ count: number; rows: Refused[]; hint: string | null } | null> {
  try {
    await tx.savepoint(async (sp) => {
      await sp.unsafe(BLOCK!);
    });
    return null;
  } catch (e) {
    const m = REFUSAL.exec((e as Error).message);
    if (!m) throw e;
    const rows = m[2]!.split("; ").map((r) => {
      const x = ROW.exec(r);
      if (!x) throw new Error(`a refusal row the test cannot read: ${r}`);
      return { place: x[1]!, id: x[2]!, sport: x[3]!, entry: x[4]!, why: x[5]! };
    });
    return { count: Number(m[1]), rows, hint: (e as { hint?: string }).hint ?? null };
  }
}

/** A stored list in a seed; `ABSENT` leaves the key out of its object (a pin without it). */
const ABSENT = Symbol("absent");
type Stored = unknown | typeof ABSENT;
interface ListSeed {
  label: string;
  sport: string;
  /** `divisions.tiebreakers`; absent = SQL null. */
  division?: Stored;
  /** `divisions.config.tiebreakers`; absent = no key. */
  divisionConfig?: Stored;
  /** `stages.config.tiebreakers` / `.crossGroupTiebreakers`; absent = no key. */
  stageOrder?: Stored;
  stageCrossGroup?: Stored;
  /** A pin (the stage is then ACTIVE): its lists, each defaulting to the sport's own (absent = left out of the pin). */
  pin?: { tiebreakers?: Stored; crossGroup?: Stored };
  /** Where the read is expected to meet the list under test (and the census to count it). */
  subject: Place;
}
interface SeededList {
  seed: ListSeed;
  divisionId: string;
  stageId: string;
}
/** The id the census names a seed's list by: a division's or a stage's. */
const idOf = (s: SeededList, place: Place): string => (place.startsWith("divisions.") ? s.divisionId : s.stageId);
const sportDefault = (m: AnySportModule): TiebreakerKey[] => [...m.defaultTiebreakers("league", cfgOf(m))];

/** One organization holding one division and one league stage per seed, written raw (shapes the doors no longer write),
 *  inside the rolled-back transaction, as the connecting role. */
async function seedLists(tx: Tx, seeds: readonly ListSeed[]): Promise<{ orgId: string; rows: SeededList[] }> {
  const suffix = randomUUID().slice(0, 8);
  const [org] = await tx<{ id: string }[]>`insert into organizations (name, slug) values (${"W2 tb " + suffix}, ${"w2-tb-" + suffix}) returning id`;
  const [comp] = await tx<{ id: string }[]>`
    insert into competitions (org_id, name, slug) values (${org!.id}, ${"W2 tb " + suffix}, ${"w2-tb-" + suffix}) returning id`;
  // `tx.json`, never a stringified param under `::jsonb` (postgres.js would encode the string again: a JSON string). A JSON
  // null is written by its own update below (the driver sends a JS null as SQL null).
  const asJson = (v: Stored | undefined) => (v === undefined || v === ABSENT || v === null ? null : tx.json(v as never));
  const rows: SeededList[] = [];
  for (const [i, s] of seeds.entries()) {
    const m = moduleOf(s.sport);
    const config: Json = { ...cfgOf(m), ...(s.divisionConfig === undefined ? {} : { tiebreakers: s.divisionConfig }) };
    const [d] = await tx<{ id: string }[]>`
      insert into divisions (competition_id, org_id, name, slug, sport_key, variant_key, config, module_version, tiebreakers)
      values (${comp!.id}, ${org!.id}, ${s.label}, ${"d-" + i}, ${s.sport}, ${firstVariant(m)}, ${tx.json(config as never)},
              (select module_version from sports where key = ${s.sport}), ${asJson(s.division)})
      returning id`;
    if (s.division === null) await tx`update divisions set tiebreakers = 'null'::jsonb where id = ${d!.id}`;
    const stageConfig: Json = {
      ...(s.stageOrder === undefined ? {} : { tiebreakers: s.stageOrder }),
      ...(s.stageCrossGroup === undefined ? {} : { crossGroupTiebreakers: s.stageCrossGroup }),
    };
    let pin: Json | null = null;
    if (s.pin) {
      const order = sportDefault(m);
      pin = {
        points: m.tablePointsRule(cfgOf(m), "league"),
        ...(s.pin.tiebreakers === ABSENT ? {} : { tiebreakers: s.pin.tiebreakers === undefined ? order : s.pin.tiebreakers }),
        ...(s.pin.crossGroup === ABSENT ? {} : { crossGroup: s.pin.crossGroup === undefined ? defaultCrossGroup(order) : s.pin.crossGroup }),
        sources: { points: "migrated", tiebreakers: "migrated", crossGroup: "migrated" },
      };
    }
    const [st] = await tx<{ id: string }[]>`
      insert into stages (division_id, org_id, seq, kind, name, status, config, table_rules_pinned, table_rules_pinned_at)
      values (${d!.id}, ${org!.id}, 1, 'league', 'S1', ${pin ? "active" : "pending"}, ${tx.json(stageConfig as never)},
              ${pin ? tx.json(pin as never) : null}, ${pin ? new Date() : null})
      returning id`;
    rows.push({ seed: s, divisionId: d!.id, stageId: st!.id });
  }
  return { orgId: org!.id, rows };
}

/** The standings read's verdict on a stage, through the loader (`tableRulesRowsOf` → `tableRulesOf`) and the ranker
 *  (`rankStandings`, the order and the cross-group order): its rules, or its CONFIG_INVALID message. */
async function readOf(tx: Tx, stageId: string): Promise<{ tiebreakers: readonly string[]; crossGroup: readonly string[]; source: string } | string> {
  const [loaded] = await tableRulesRowsOf(tx as never, { stageIds: [stageId] });
  if (!loaded) throw new Error(`stage ${stageId} not visible`);
  try {
    const rules = tableRulesOf(loaded.row, loaded.module);
    const refusal = rankRefusal(rules.tiebreakers) ?? rankRefusal(rules.crossGroup);
    if (refusal !== null) return refusal;
    return { tiebreakers: rules.tiebreakers, crossGroup: rules.crossGroup, source: rules.sources.tiebreakers };
  } catch (e) {
    if (e instanceof EngineError && e.code === "CONFIG_INVALID") return e.message;
    throw e;
  }
}

interface StoredRows {
  divisions: Map<string, { tiebreakers: unknown; config: unknown; ctid: string }>;
  stages: Map<string, { config: unknown; pin: unknown; ctid: string }>;
}
async function readStored(tx: Tx): Promise<StoredRows> {
  const d = await tx<{ id: string; tiebreakers: unknown; config: unknown; ctid: string }[]>`
    select id, tiebreakers, config, ctid::text as ctid from divisions order by id`;
  const s = await tx<{ id: string; config: unknown; pin: unknown; ctid: string }[]>`
    select id, config, table_rules_pinned as pin, ctid::text as ctid from stages order by id`;
  return {
    divisions: new Map(d.map((r) => [r.id, { tiebreakers: r.tiebreakers, config: r.config, ctid: r.ctid }])),
    stages: new Map(s.map((r) => [r.id, { config: r.config, pin: r.pin, ctid: r.ctid }])),
  };
}
/** The list a seed's place holds, as stored. */
function listAt(stored: StoredRows, s: SeededList, place: Place): unknown {
  const d = stored.divisions.get(s.divisionId)!;
  const st = stored.stages.get(s.stageId)!;
  switch (place) {
    case "divisions.tiebreakers":
      return d.tiebreakers;
    case "divisions.config.tiebreakers":
      return (d.config as Json).tiebreakers;
    case "stages.config.tiebreakers":
      return (st.config as Json).tiebreakers;
    case "stages.config.crossGroupTiebreakers":
      return (st.config as Json).crossGroupTiebreakers;
    case "stages.table_rules_pinned.tiebreakers":
      return (st.pin as Json | null)?.tiebreakers;
    case "stages.table_rules_pinned.crossGroup":
      return (st.pin as Json | null)?.crossGroup;
  }
}

/** A seed holding `list` at `place` and nothing else of its own (so the read meets that list). */
function at(place: Place, sport: string, list: Stored, label: string): ListSeed {
  const base = { label, sport, subject: place };
  switch (place) {
    case "divisions.tiebreakers":
      return { ...base, division: list };
    case "divisions.config.tiebreakers":
      return { ...base, divisionConfig: list };
    case "stages.config.tiebreakers":
      return { ...base, stageOrder: list };
    case "stages.config.crossGroupTiebreakers":
      return { ...base, stageCrossGroup: list };
    case "stages.table_rules_pinned.tiebreakers":
      return { ...base, pin: { tiebreakers: list } };
    case "stages.table_rules_pinned.crossGroup":
      return { ...base, pin: { crossGroup: list } };
  }
}

/** Every list a seed stores (the census's count of it): its own places, plus both pin lists when it has a pin. */
function listsOf(s: ListSeed): Place[] {
  const out: Place[] = [];
  const has = (v: Stored | undefined) => v !== undefined && v !== null;
  if (has(s.division)) out.push("divisions.tiebreakers");
  if (has(s.divisionConfig)) out.push("divisions.config.tiebreakers");
  if (has(s.stageOrder)) out.push("stages.config.tiebreakers");
  if (has(s.stageCrossGroup)) out.push("stages.config.crossGroupTiebreakers");
  if (s.pin) out.push("stages.table_rules_pinned.tiebreakers", "stages.table_rules_pinned.crossGroup");
  return out;
}

// The sweep: every sport's own default order, in every place, is a list the read takes — and a set of shapes it refuses.
const VALID_SEEDS: ListSeed[] = builtinModules.flatMap((m) =>
  PLACES.map((place) =>
    at(place, m.key, place.includes("crossGroup") ? defaultCrossGroup(sportDefault(m)) : sportDefault(m), `${m.key} default at ${place}`),
  ),
);
const JUNK = "goal_average";
/** Shapes the census must judge, every one through the read: refused ones and the accepted edges beside them (labels
 *  ending "(accepted)" or "(inherits)", which the read must take: their positive pairs). */
const SHAPE_SEEDS: ListSeed[] = [
  at("divisions.tiebreakers", "hockey", ["fifa2026"], "a football preset name on hockey"),
  at("stages.table_rules_pinned.tiebreakers", "tennis", ["points", "uefa", "lots"], "a football preset name in a tennis pin"),
  at("stages.config.tiebreakers", "football", ["points", JUNK, "lots"], "a junk key in a football stage order"),
  at("stages.config.crossGroupTiebreakers", "football", ["points", "fifa2026"], "a preset name in a cross-group order (not expanded)"),
  at("divisions.tiebreakers", "volleyball", ["wins", 3, "lots"], "a number entry"),
  at("stages.table_rules_pinned.crossGroup", "cricket", ["points", null], "a null entry in a pin's cross-group order"),
  at("divisions.tiebreakers", "generic", "fifa2026", "a string, not a list"),
  at("stages.config.tiebreakers", "badminton", { keys: ["wins"] }, "an object, not a list"),
  { ...at("stages.table_rules_pinned.tiebreakers", "carrom", ABSENT, "a pin without its order"), subject: "stages.table_rules_pinned.tiebreakers" },
  at("divisions.tiebreakers", "tabletennis", [], "an empty division order"),
  at("stages.config.tiebreakers", "icehockey", [], "an empty stage order"),
  at("stages.config.crossGroupTiebreakers", "boardgame", [], "an empty stage cross-group order"),
  at("stages.table_rules_pinned.tiebreakers", "football", [], "an empty pinned order"),
  at("stages.table_rules_pinned.crossGroup", "football", [], "an empty pinned cross-group order (accepted)"),
  at("divisions.tiebreakers", "football", ["points", "h2h_reapply", "lots"], "a modifier after a plain key"),
  at("stages.table_rules_pinned.tiebreakers", "hockey", ["points", "h2h_points", "h2h_reapply", "h2h_exclusion", "lots"], "two modifiers on one block"),
  // Ends in a block key: `->` with index -1 reads the LAST entry, so a census asking "the entry before the first" by index
  // would find a block and pass it.
  at("stages.config.tiebreakers", "football", ["h2h_reapply", "points", "h2h_wins"], "a modifier first"),
  at("stages.config.tiebreakers", "football", ["points", "h2h_wins", "h2h_exclusion", "lots"], "a modifier after a block (accepted)"),
  at("divisions.tiebreakers", "football", null, "JSON null (inherits)"),
];
// Not read by anything: never raised, named in a notice.
const UNREAD_SEEDS: ListSeed[] = [at("divisions.config.tiebreakers", "hockey", ["points", JUNK], "junk in the unread division config")];

describe.skipIf(!HAS_DB)("W2 tie-break preset migration — the census is the read path (D18)", () => {
  it("D18 empty case first: an org with no stored list runs, checks zero lists and expands nothing", async () => {
    await rolledBack(async (tx, notices) => {
      const { orgId } = await seedLists(tx, [{ label: "nothing stored", sport: "football", subject: "divisions.tiebreakers" }]);
      await asTenant(tx, orgId);
      const delta = await runDelta(tx, notices);
      expect(delta.checkedTotal).toBe(0);
      for (const p of EXPANDED_PLACES) expect(delta.expanded[p], p).toEqual({ n: 0, ids: [] });
    });
  }, 60_000);

  it("D18 the census names EXACTLY the lists the standings read refuses, every sport, every place (and checks them all)", async () => {
    await rolledBack(async (tx) => {
      const { orgId, rows } = await seedLists(tx, [...VALID_SEEDS, ...SHAPE_SEEDS, ...UNREAD_SEEDS]);
      await asTenant(tx, orgId);
      // The read's verdict on each seed's stage, before the delta (none of these lists is one the delta expands).
      const refusedByRead = new Set<string>();
      let accepted = 0;
      for (const r of rows) {
        const read = await readOf(tx, r.stageId);
        if (typeof read === "string") refusedByRead.add(`${r.seed.subject} ${idOf(r, r.seed.subject)}`);
        else accepted += 1;
      }
      // The rig is what its labels say: every shape seed the read refuses unless it is a named positive pair, and every
      // sport's own default order taken in every place.
      for (const r of rows) {
        const positive = VALID_SEEDS.includes(r.seed) || UNREAD_SEEDS.includes(r.seed) || /\((accepted|inherits)\)$/.test(r.seed.label);
        expect(refusedByRead.has(`${r.seed.subject} ${idOf(r, r.seed.subject)}`), `rig: ${r.seed.label}`).toBe(!positive);
      }
      // Anti-vacuity: the sweep holds both verdicts, every place and every sport.
      expect(refusedByRead.size, "refused by the read").toBeGreaterThanOrEqual(15);
      expect(accepted, "accepted by the read").toBeGreaterThanOrEqual(VALID_SEEDS.length);
      expect(new Set(VALID_SEEDS.map((s) => s.sport)).size).toBe(builtinModules.length);
      const v = await refusalOf(tx);
      expect(v, "the delta refuses").not.toBeNull();
      const named = new Set(v!.rows.map((x) => `${x.place} ${x.id}`));
      expect([...named].sort(), "named = refused by the read").toEqual([...refusedByRead].sort());
      expect(v!.count, "one per refused entry").toBe(v!.rows.length);
      // Each named row carries its sport and the entry it was refused for.
      const bySeed = (label: string) => rows.find((r) => r.seed.label === label)!;
      const row = (label: string) => v!.rows.find((x) => x.id === idOf(bySeed(label), bySeed(label).seed.subject))!;
      expect(row("a football preset name on hockey")).toEqual({ place: "divisions.tiebreakers", id: bySeed("a football preset name on hockey").divisionId, sport: "hockey", entry: '"fifa2026"', why: "not a tie-break key" });
      expect(row("a junk key in a football stage order")).toMatchObject({ sport: "football", entry: `"${JUNK}"`, why: "not a tie-break key" });
      expect(row("a number entry")).toMatchObject({ entry: "3", why: "not a string" });
      expect(row("a string, not a list")).toMatchObject({ entry: '"fifa2026"', why: "not a list" });
      expect(row("a pin without its order")).toMatchObject({ entry: "absent", why: "not a list" });
      expect(row("an empty division order")).toMatchObject({ entry: "[]", why: "empty" });
      expect(row("a modifier after a plain key")).toMatchObject({ entry: '"h2h_reapply"', why: "a modifier not directly after a head-to-head block" });
      expect(v!.hint, "the remedy").toMatch(/TiebreakerKeyS[\s\S]*null to inherit[\s\S]*pin/);
      // The unread place is never raised: its seed's stage reads fine, and its list is not named.
      expect(named.has(`divisions.config.tiebreakers ${rows.find((r) => r.seed === UNREAD_SEEDS[0])!.divisionId}`)).toBe(false);
    });
  }, 120_000);

  it("D18 with every refused list put right, it runs: the census checks every stored list per place, and names the unread junk", async () => {
    await rolledBack(async (tx, notices) => {
      const seeds = [...VALID_SEEDS, ...UNREAD_SEEDS];
      const { orgId, rows } = await seedLists(tx, seeds);
      await asTenant(tx, orgId);
      const before = await readStored(tx);
      const delta = await runDelta(tx, notices);
      const want = Object.fromEntries(PLACES.map((p) => [p, seeds.flatMap(listsOf).filter((x) => x === p).length]));
      expect(delta.checked).toEqual(want);
      for (const p of PLACES) expect(delta.checked[p], `anti-vacuity: ${p}`).toBeGreaterThan(0);
      expect(delta.checkedTotal).toBe(seeds.flatMap(listsOf).length);
      const junk = rows.find((r) => r.seed === UNREAD_SEEDS[0])!;
      expect(delta.unread, "the unread junk is named").toBe(`id=${junk.divisionId} sport=hockey entry="${JUNK}" why=not a tie-break key`);
      // Nothing expanded; every row as it was, value and row (ctid).
      for (const p of EXPANDED_PLACES) expect(delta.expanded[p]!.n, p).toBe(0);
      expect(await readStored(tx)).toEqual(before);
    });
  }, 120_000);
});

describe.skipIf(!HAS_DB)("W2 tie-break preset migration — football preset names expand (D18)", () => {
  // Each preset alone, in every place the delta expands; the subject's read reaches it.
  const ALONE: ListSeed[] = PRESET_NAMES.flatMap((p) => EXPANDED_PLACES.map((place) => at(place, "football", [p], `${p} alone at ${place}`)));
  // A preset's keys, spliced where its name stood, each key's FIRST occurrence kept.
  const fifa = FOOTBALL_TIEBREAKERS.fifa2026;
  const classic = FOOTBALL_TIEBREAKERS.classic;
  const MIXED: { seed: ListSeed; want: string[] }[] = [
    // The brief's case: the preset's own first and last key around it, so the result is the preset.
    { seed: at("divisions.tiebreakers", "football", ["points", "fifa2026", "lots"], "points, fifa2026, lots"), want: [...fifa] },
    // A differential: a key ahead of the preset keeps ITS place, the preset's copy is dropped; a key after it stays after.
    {
      seed: at("stages.table_rules_pinned.tiebreakers", "football", ["diff", "classic", "seed"], "diff, classic, seed"),
      want: ["diff", ...classic.filter((k) => k !== "diff"), "seed"],
    },
    // Two presets: the second contributes only the keys the first lacks (here none), and the first's ORDER stands — the
    // result is classic, not fifa2026. (`["classic", "uefa"]` would leave uefa's modifier after `lots`: the census refuses
    // that one, below.)
    {
      seed: at("stages.config.tiebreakers", "football", ["classic", "fifa2026"], "classic, fifa2026"),
      want: [...classic, ...fifa.filter((k) => !(classic as string[]).includes(k))],
    },
  ];
  const UNTOUCHED: ListSeed[] = [
    at("divisions.tiebreakers", "football", [...FOOTBALL_TIEBREAKERS.uefa], "a valid football list (the uefa keys)"),
    at("stages.table_rules_pinned.tiebreakers", "football", ["points", "diff", "for", "lots"], "a valid football pin"),
    at("stages.config.tiebreakers", "football", ["points", "wins", "lots"], "a valid football stage order"),
    at("divisions.tiebreakers", "hockey", sportDefault(moduleOf("hockey")), "a valid hockey list"),
    at("divisions.config.tiebreakers", "football", ["points", "lots"], "a valid football config list"),
    at("divisions.tiebreakers", "football", null, "JSON null (inherits)"),
  ];

  it("D18 each preset alone, in every place, becomes its keys (FOOTBALL_TIEBREAKERS); mixed lists keep first occurrences; valid lists are untouched, byte for byte", async () => {
    await rolledBack(async (tx, notices) => {
      const seeds = [...ALONE, ...MIXED.map((m) => m.seed), ...UNTOUCHED];
      const { orgId, rows } = await seedLists(tx, seeds);
      await asTenant(tx, orgId);
      // The read refuses every subject holding a preset name before the delta (the defect), except the unread config.
      for (const r of rows.filter((x) => x.seed.label.includes("alone") || MIXED.some((m) => m.seed === x.seed))) {
        if (r.seed.subject === "divisions.config.tiebreakers") continue;
        expect(typeof (await readOf(tx, r.stageId)), `${r.seed.label}: refused before`).toBe("string");
      }
      const before = await readStored(tx);
      const delta = await runDelta(tx, notices);
      const after = await readStored(tx);
      // 1. The notices: per place, exactly the rows that held a name.
      for (const place of EXPANDED_PLACES) {
        const held = rows.filter((r) => [...ALONE, ...MIXED.map((m) => m.seed)].includes(r.seed) && r.seed.subject === place);
        expect(delta.expanded[place]!.n, place).toBe(held.length);
        expect([...delta.expanded[place]!.ids].sort(), place).toEqual(held.map((r) => idOf(r, place)).sort());
        expect(held.length, `anti-vacuity: ${place}`).toBeGreaterThanOrEqual(PRESET_NAMES.length);
      }
      // 2. Each preset alone is its keys, and the read now ranks by them (the config place: no reader, the value alone).
      let judged = 0;
      for (const r of rows.filter((x) => ALONE.includes(x.seed))) {
        const name = (r.seed.label.split(" ")[0] ?? "") as keyof typeof FOOTBALL_TIEBREAKERS;
        expect(listAt(after, r, r.seed.subject), r.seed.label).toEqual(FOOTBALL_TIEBREAKERS[name]);
        if (r.seed.subject !== "divisions.config.tiebreakers") {
          const read = await readOf(tx, r.stageId);
          expect(read, `${r.seed.label}: read after`).toMatchObject({ tiebreakers: FOOTBALL_TIEBREAKERS[name] });
        }
        judged += 1;
      }
      expect(judged, "anti-vacuity: presets × places").toBe(PRESET_NAMES.length * EXPANDED_PLACES.length);
      for (const m of MIXED) {
        const r = rows.find((x) => x.seed === m.seed)!;
        expect(listAt(after, r, m.seed.subject), m.seed.label).toEqual(m.want);
        expect(await readOf(tx, r.stageId), `${m.seed.label}: read after`).toMatchObject({ tiebreakers: m.want });
      }
      // 3. Untouched: value and row (ctid) of every division and stage that held no name.
      let untouched = 0;
      for (const r of rows.filter((x) => UNTOUCHED.includes(x.seed))) {
        expect(after.divisions.get(r.divisionId), `${r.seed.label}: division`).toEqual(before.divisions.get(r.divisionId));
        expect(after.stages.get(r.stageId), `${r.seed.label}: stage`).toEqual(before.stages.get(r.stageId));
        untouched += 1;
      }
      expect(untouched).toBe(UNTOUCHED.length);
      // 4. Only the list moved: each expanded row equals itself with that one list replaced.
      for (const r of rows.filter((x) => !UNTOUCHED.includes(x.seed))) {
        const b = before;
        const a = after;
        const sub = r.seed.subject;
        if (sub.startsWith("divisions.")) expect(a.stages.get(r.stageId), `${r.seed.label}: its stage`).toEqual(b.stages.get(r.stageId));
        else expect(a.divisions.get(r.divisionId), `${r.seed.label}: its division`).toEqual(b.divisions.get(r.divisionId));
        const strip = (rows_: StoredRows): unknown => {
          const d = rows_.divisions.get(r.divisionId)!;
          const s = rows_.stages.get(r.stageId)!;
          const cfg = { ...(d.config as Json) };
          delete cfg.tiebreakers;
          const scfg = { ...(s.config as Json) };
          delete scfg.tiebreakers;
          const pin = s.pin === null ? null : { ...(s.pin as Json) };
          if (pin) delete pin.tiebreakers;
          return { cfg, scfg, pin };
        };
        expect(strip(a), `${r.seed.label}: the rest of its row`).toEqual(strip(b));
      }
    });
  }, 120_000);

  it("D18 a splice the read would refuse (a modifier left after a plain key once its block is de-duplicated) raises; the read agrees", async () => {
    // What the brief's rule (splice, keep each key's first occurrence) makes of each, and the ranker's verdict on that.
    const keepFirst = (lists: readonly (readonly string[])[]): string[] => [...new Set(lists.flat())];
    const uefa = FOOTBALL_TIEBREAKERS.uefa;
    const cases = [
      { label: "block keys, then uefa", list: ["h2h_points", "h2h_diff", "h2h_for", "uefa"], spliced: keepFirst([["h2h_points", "h2h_diff", "h2h_for"], uefa]) },
      { label: "classic, then uefa", list: ["classic", "uefa"], spliced: keepFirst([classic, uefa]) },
    ];
    for (const c of cases) expect(rankRefusal(c.spliced), `${c.label}: the ranker refuses the splice`).toMatch(/head-to-head block/);
    await rolledBack(async (tx) => {
      const { orgId, rows } = await seedLists(
        tx,
        cases.map((c, i) => at(i === 0 ? "divisions.tiebreakers" : "stages.config.tiebreakers", "football", c.list, c.label)),
      );
      await asTenant(tx, orgId);
      const v = await refusalOf(tx);
      const why = "a modifier not directly after a head-to-head block";
      expect(v?.rows, "named").toEqual([
        { place: "divisions.tiebreakers", id: rows[0]!.divisionId, sport: "football", entry: '"h2h_reapply"', why },
        { place: "stages.config.tiebreakers", id: rows[1]!.stageId, sport: "football", entry: '"h2h_reapply"', why },
      ]);
      // All-or-nothing: the splices were rolled back with the refusal.
      const after = await readStored(tx);
      expect([listAt(after, rows[0]!, "divisions.tiebreakers"), listAt(after, rows[1]!, "stages.config.tiebreakers")]).toEqual(cases.map((c) => c.list));
    });
  }, 60_000);

  it("D18 fifa2026 on a NON-football division raises naming it, and the block writes nothing (a football row beside it stays a name)", async () => {
    await rolledBack(async (tx) => {
      const seeds = [
        at("divisions.tiebreakers", "hockey", ["fifa2026"], "hockey fifa2026"),
        at("divisions.tiebreakers", "football", ["fifa2026"], "football fifa2026"),
        at("stages.table_rules_pinned.tiebreakers", "football", ["uefa"], "football pin uefa"),
      ];
      const { orgId, rows } = await seedLists(tx, seeds);
      await asTenant(tx, orgId);
      const before = await readStored(tx);
      const v = await refusalOf(tx);
      expect(v, "refused").not.toBeNull();
      // The football rows were expanded before the census, so the hockey row is the only one named.
      expect(v!.rows).toEqual([{ place: "divisions.tiebreakers", id: rows[0]!.divisionId, sport: "hockey", entry: '"fifa2026"', why: "not a tie-break key" }]);
      expect(v!.count).toBe(1);
      expect(await readStored(tx), "nothing written: values and rows (ctid)").toEqual(before);
      expect(listAt(before, rows[1]!, "divisions.tiebreakers"), "rig: the football row held the name").toEqual(["fifa2026"]);
    });
  }, 60_000);

  it("D18 a second run changes no row: every expansion matches nothing, and no row is rewritten (ctid)", async () => {
    await rolledBack(async (tx, notices) => {
      const { orgId } = await seedLists(tx, [...ALONE, ...MIXED.map((m) => m.seed), ...UNTOUCHED]);
      await asTenant(tx, orgId);
      const first = await runDelta(tx, notices);
      expect(Object.values(first.expanded).reduce((a, b) => a + b.n, 0), "the first run expanded rows").toBeGreaterThan(0);
      const once = await readStored(tx);
      const second = await runDelta(tx, notices);
      for (const p of EXPANDED_PLACES) expect(second.expanded[p], p).toEqual({ n: 0, ids: [] });
      expect(second.checked, "the census checks the same lists").toEqual(first.checked);
      expect(await readStored(tx)).toEqual(once);
    });
  }, 60_000);
});

// ── The seam: a football league as staging holds it (V475's pin copied the division's name), read by the real standings path ──

describe.skipIf(!HAS_DB)("W2 tie-break preset migration — the standings read, before and after (staging's shape)", () => {
  it("D18 a played football league pinned with ['fifa2026'] throws on read; after the delta it ranks by fifa2026 (points first, not seed order)", async () => {
    // Football alone: the only sport that declares named presets (the text test above holds that).
    const s = await seedBracket({ sport: "football", variant: firstVariant(moduleOf("football")), stageKind: "league", entrants: 2 });
    const id = s.fixtureIds[0]!;
    const [seats] = await sql<{ home: string; away: string; homeSeed: number; awaySeed: number }[]>`
      select f.home_entrant_id as home, f.away_entrant_id as away, h.seed as "homeSeed", a.seed as "awaySeed"
        from fixtures f join entrants h on h.id = f.home_entrant_id join entrants a on a.id = f.away_entrant_id where f.id = ${id}`;
    // The lower seed wins, so the table by points differs from the table by seed.
    const winner = seats!.homeSeed > seats!.awaySeed ? seats!.home : seats!.away;
    const loser = winner === seats!.home ? seats!.away : seats!.home;
    await post(s.auth, id, "core.start");
    await post(s.auth, id, "football.goal", { by: winner, minute: 10 });
    await post(s.auth, id, "football.period", { phase: "HT" });
    await post(s.auth, id, "football.period", { phase: "FT" });
    await rolledBack(async (tx, notices) => {
      // The pre-W2 shape: the division's list a preset name, the started stage's pin a copy of it (V475), a pending stage.
      await tx`update divisions set tiebreakers = '["fifa2026"]'::jsonb where id = ${s.divisionId}`;
      const n = await tx`
        update stages set table_rules_pinned = jsonb_set(jsonb_set(table_rules_pinned, '{tiebreakers}', '["fifa2026"]'), '{sources,tiebreakers}', '"migrated"')
         where id = ${s.stageId} and table_rules_pinned is not null`;
      expect(n.count, "rig: the generated stage is pinned").toBe(1);
      const [pending] = await tx<{ id: string }[]>`
        insert into stages (division_id, org_id, seq, kind, name, config) values (${s.divisionId}, ${s.auth.orgId}, 2, 'league', 'S2', '{}') returning id`;
      await asTenant(tx, s.auth.orgId);
      await expect(rankedStageStandings(tx, s.stageId), "the started stage: refused").rejects.toMatchObject({ code: "CONFIG_INVALID" });
      expect(await readOf(tx, pending!.id), "the pending stage: refused").toMatch(/fifa2026/);
      const delta = await runDelta(tx, notices);
      expect([delta.expanded["divisions.tiebreakers"]!.ids, delta.expanded["stages.table_rules_pinned.tiebreakers"]!.ids]).toEqual([[s.divisionId], [s.stageId]]);
      const table = await rankedStageStandings(tx, s.stageId);
      expect(table.map((r) => r.entrantId), "points first: the winner, though the lower seed").toEqual([winner, loser]);
      expect(await readOf(tx, s.stageId)).toMatchObject({ tiebreakers: FOOTBALL_TIEBREAKERS.fifa2026, source: "migrated" });
      expect(await readOf(tx, pending!.id)).toMatchObject({ tiebreakers: FOOTBALL_TIEBREAKERS.fifa2026, source: "division" });
    });
  }, 120_000);
});
