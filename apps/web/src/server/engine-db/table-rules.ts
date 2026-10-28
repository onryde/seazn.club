import "server-only";
// W2d Task 9 (spec §5.4 "Resolution", "Pin at start", §5.8, §6 W1–W11; rule rows X-TB-1, X-TB-2, X-TB-4) — the ONE
// place the web reads a stage's table rules: the points it pays, the order it ranks by and the order it is compared
// across groups by. Every standings read, the public pages, the hub, the embed, the slideshow and the organiser console
// come through here (`table-rules-single-resolver.test.ts` scans for any other reader of the sport default or of the
// division's order). The rules themselves come from the engine's one resolver (`resolveTableRules`); this module adds
// the stage's PIN (OC2), its stored lots draws (§5.8), and the reachable outcomes the rule's bounds range over.
//
//   pending stage  → the live layers: own ?? division ?? sport, under the merged cfg (division ⊕ stage rules).
//   active/complete → its pin, written in the same transaction that activated it (`pinStageTableRules`, called by the
//                     two activation writers in usecases/stages.ts). Division defaults, sport defaults and engine
//                     releases stop reaching it. A started stage with no pin is refused, never read live (the guard).
import type postgres from "postgres";
import { z } from "zod";
import { EngineError, StageKind } from "@seazn/engine/core";
import {
  DECIDED_IN,
  PointsRule,
  membersKeyOf,
  parseStoredPointsRule,
  reachableOutcomes,
  resolveTableRules,
  type MembersKey,
  type OutcomeKey,
  type RankingResult,
  type StoredLotsDraw,
  type TableRulesPin,
} from "@seazn/engine/competition";
import type { AnySportModule, TableStageKind, TiebreakerKey } from "@seazn/engine/sport";
import { log } from "@/server/logger";
import { liveCfg } from "./fixture-cfg";
import { resolveModule } from "./registry";

type Db = postgres.ISql;

/** What a stage ranks and pays by, as the web reads it (plan Task 9 "Produces"). */
export interface LoadedTableRules extends TableRulesPin {
  /** When the pin was written (the DB's `now()`, ISO); null while the stage reads the live layers (pending). */
  readonly pinnedAt: string | null;
  /** The outcomes the stage can produce under its merged cfg (`reachableOutcomes`) — what the rule's bounds range over
   *  (`pointsRuleBounds(rules.points, rules.reachable)`). */
  readonly reachable: ReadonlySet<OutcomeKey>;
  /** PS-7b: the sport layer for this stage (`module.defaultTiebreakers(stageKind, mergedCfg)`, PS-7c), for the editor's
   *  Reset; the UI never calls the module. */
  readonly sportDefault: readonly TiebreakerKey[];
  /** W2e Task 8c (CK-BO-2): the over length the stage's cfg plays (cricket's `ballsPerOver`; The Hundred's is five), which
   *  the table prints net run rate per. Absent where the cfg names none (every other sport) or the sport cannot read it. */
  readonly ballsPerOver?: number;
}

/** W2d: every outcome a stage rule can name — a win or loss however decided, an unplayed loss, a draw, a tie, a no
 *  result. Where the sport cannot say which of them its cfg reaches (a stored cfg its schema refuses), the bounds range
 *  over all of them: wider, never narrower, than the table can pay (R3: cautious, never wrong). A set-score map with no
 *  `set:` key reachable ranges over every pair it names (`pointsRuleBounds`). */
export const EVERY_OUTCOME: ReadonlySet<OutcomeKey> = new Set<OutcomeKey>([
  ...DECIDED_IN.flatMap((d): OutcomeKey[] => [`win.${d}`, `loss.${d}`]),
  "loss.unplayed",
  "draw",
  "tie",
  "noResult",
]);

// The stage kinds that keep a table (`TableStageKind`). A bracket or ladder stage is pinned and ranked, when its
// snapshot is recomputed, by the order a league would (`competition.ts`), as before W2d.
const TABLE_STAGE_KINDS: ReadonlySet<string> = new Set<TableStageKind>(["league", "group", "swiss", "americano"]);
export function tableStageKindOf(kind: string): TableStageKind {
  return TABLE_STAGE_KINDS.has(kind) ? (kind as TableStageKind) : "league";
}

const SOURCE = z.enum(["stage", "division", "sport", "migrated"]);
const CROSS_GROUP_SOURCE = z.enum(["stage", "derived", "migrated"]);
/** The stored pin (`stages.table_rules_pinned`, V475): `{points, tiebreakers, crossGroup, sources}` — `sources.crossGroup`
 *  says whether the cross-group order is the stage's own (T9 re-review N2). */
const StoredPin = z.object({
  points: PointsRule,
  tiebreakers: z.array(z.string()).min(1),
  crossGroup: z.array(z.string()),
  sources: z.object({ points: SOURCE, tiebreakers: SOURCE, crossGroup: CROSS_GROUP_SOURCE }),
});
const Order = z.array(z.string()).min(1);

/** One stage's rows the rules are read from: the stage, its pin, its division. */
export interface TableRulesRow {
  readonly stageId: string;
  readonly kind: string;
  readonly status: string;
  readonly stageConfig: Record<string, unknown> | null;
  readonly pin: unknown;
  readonly pinnedAt: string | null;
  readonly divisionConfig: unknown;
  readonly divisionTiebreakers: readonly string[] | null;
}

const refused = (stageId: string, message: string, extra: Record<string, unknown> = {}) =>
  new EngineError("CONFIG_INVALID", `stage ${stageId}: ${message}`, { stageId, ...extra });

function parsePin(stageId: string, raw: unknown): TableRulesPin {
  const parsed = StoredPin.safeParse(raw);
  if (!parsed.success) throw refused(stageId, "its table-rules pin does not parse", { reason: "pin_invalid", issues: parsed.error.issues });
  return { ...parsed.data, tiebreakers: parsed.data.tiebreakers as TiebreakerKey[], crossGroup: parsed.data.crossGroup as TiebreakerKey[] };
}

// The stage's own values (`stages.config.points`, `.tiebreakers`, `.crossGroupTiebreakers`; spec §5.4 "Storage", §5.9:
// the API's explicit cross-group order, W2d Task 10). Null or absent = inherit (any falsy `points`, as the fold always
// read it). A value that is not a rule or an order is refused, typed.
function ownRulesOf(row: TableRulesRow): {
  points: PointsRule | null;
  tiebreakers: readonly TiebreakerKey[] | null;
  crossGroup: readonly TiebreakerKey[] | null;
} {
  const rawPoints = row.stageConfig?.points;
  let points: PointsRule | null = null;
  if (rawPoints) {
    points = parseStoredPointsRule(rawPoints);
    if (points === null) {
      throw refused(row.stageId, "its own points rule does not parse", {
        reason: "points_invalid",
        issues: PointsRule.safeParse(rawPoints).error?.issues ?? [],
      });
    }
  }
  const rawOrder = row.stageConfig?.tiebreakers;
  let tiebreakers: readonly TiebreakerKey[] | null = null;
  if (rawOrder !== undefined && rawOrder !== null) {
    const order = Order.safeParse(rawOrder);
    if (!order.success) throw refused(row.stageId, "its own tie-break order is not a list of steps", { reason: "order_invalid" });
    tiebreakers = order.data as TiebreakerKey[];
  }
  const rawCross = row.stageConfig?.crossGroupTiebreakers;
  let crossGroup: readonly TiebreakerKey[] | null = null;
  if (rawCross !== undefined && rawCross !== null) {
    const order = Order.safeParse(rawCross);
    if (!order.success) throw refused(row.stageId, "its own cross-group order is not a list of steps", { reason: "order_invalid" });
    crossGroup = order.data as TiebreakerKey[];
  }
  return { points, tiebreakers, crossGroup };
}

function divisionOrderOf(row: TableRulesRow): readonly TiebreakerKey[] | null {
  if (row.divisionTiebreakers === null || row.divisionTiebreakers === undefined) return null;
  const order = Order.safeParse(row.divisionTiebreakers);
  if (!order.success) throw refused(row.stageId, "its division's tie-break order is not a list of steps", { reason: "order_invalid" });
  return order.data as TiebreakerKey[];
}

// The sport's own answer, read as the resolver reads a sport layer: the cfg as its schema parses it, else as given (the
// fold's tolerance, never stricter); a cfg the sport cannot read even so answers `fallback` — this field and the one
// below are what the page offers and what a bound ranges over, never what the table ranks or pays by.
function askedOrElse<T>(module: AnySportModule, mergedCfg: unknown, ask: (cfg: unknown) => T, fallback: T): T {
  const parsed = module.configSchema.safeParse(mergedCfg);
  if (parsed.success) return ask(parsed.data);
  try {
    return ask(mergedCfg);
  } catch {
    return fallback;
  }
}

/** The over length a merged cfg plays, as the sport parses it: a positive whole `ballsPerOver`, else none. The table only
 *  PRINTS by it (net run rate), so a cfg the sport cannot read answers none and the display's default stands, as for
 *  `sportDefault`; nothing ranked or paid depends on it. A sport without the key answers none. */
function ballsPerOverOf(module: AnySportModule, mergedCfg: unknown): number | undefined {
  const parsed = module.configSchema.safeParse(mergedCfg);
  if (!parsed.success) return undefined;
  const n = (parsed.data as Record<string, unknown>).ballsPerOver;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : undefined;
}

function reachableOf(module: AnySportModule, mergedCfg: unknown, kind: string): ReadonlySet<OutcomeKey> {
  const stageKind = StageKind.safeParse(kind);
  if (!stageKind.success) return EVERY_OUTCOME;
  // `reachableOutcomes` parses the cfg (its defaults applied) and throws on one the schema refuses: then every outcome.
  return module.configSchema.safeParse(mergedCfg).success ? reachableOutcomes(module, mergedCfg, stageKind.data) : EVERY_OUTCOME;
}

/** The rules of one stage from its rows (the standings read has them loaded already; `loadTableRules` reads them).
 *  Throws CONFIG_INVALID for an active or complete stage with no pin (spec §5.4: "active or complete ⇒ pinned"), for a
 *  pin or own value that does not parse, and where the resolver must ask a sport that cannot read the merged cfg. */
export function tableRulesOf(row: TableRulesRow, module: AnySportModule): LoadedTableRules {
  const stageKind = tableStageKindOf(row.kind);
  const mergedCfg = liveCfg(row.divisionConfig, { kind: row.kind, config: row.stageConfig }, module);
  const started = row.status === "active" || row.status === "complete";
  const pinned = row.pin === null || row.pin === undefined ? null : parsePin(row.stageId, row.pin);
  if (started && pinned === null) {
    throw refused(row.stageId, `it is ${row.status} but its table rules were never pinned`, { reason: "unpinned", status: row.status });
  }
  const own = pinned === null ? ownRulesOf(row) : { points: null, tiebreakers: null, crossGroup: null };
  const rules = resolveTableRules({
    module,
    stageKind,
    mergedCfg,
    stageOwn: { points: own.points, tiebreakers: own.tiebreakers, crossGroup: own.crossGroup },
    divisionTiebreakers: pinned === null ? divisionOrderOf(row) : null,
    pinned,
  });
  const ballsPerOver = ballsPerOverOf(module, mergedCfg);
  return {
    points: rules.points,
    tiebreakers: rules.tiebreakers,
    crossGroup: rules.crossGroup,
    sources: rules.sources,
    pinnedAt: pinned === null ? null : row.pinnedAt,
    reachable: reachableOf(module, mergedCfg, row.kind),
    sportDefault: askedOrElse(module, mergedCfg, (cfg) => module.defaultTiebreakers(stageKind, cfg), []),
    ...(ballsPerOver === undefined ? {} : { ballsPerOver }),
  };
}

interface RulesQueryRow {
  stage_id: string;
  kind: string;
  status: string;
  config: Record<string, unknown> | null;
  pin: unknown;
  pinned_at: string | null;
  division_config: unknown;
  division_tiebreakers: string[] | null;
  sport_key: string;
  module_version: string;
}

const toRow = (r: RulesQueryRow): TableRulesRow => ({
  stageId: r.stage_id,
  kind: r.kind,
  status: r.status,
  stageConfig: r.config,
  pin: r.pin,
  pinnedAt: r.pinned_at,
  divisionConfig: r.division_config,
  divisionTiebreakers: r.division_tiebreakers,
});

async function rulesRows(db: Db, stageIds: readonly string[]): Promise<RulesQueryRow[]> {
  if (stageIds.length === 0) return [];
  // `pinned_at` as the DB prints it (to_json: ISO 8601 with microseconds), never a JS clock's rounding of it.
  return db<RulesQueryRow[]>`
    select s.id as stage_id, s.kind, s.status, s.config,
           s.table_rules_pinned as pin, to_json(s.table_rules_pinned_at) #>> '{}' as pinned_at,
           d.config as division_config, d.tiebreakers as division_tiebreakers, d.sport_key, d.module_version
    from stages s join divisions d on d.id = s.division_id
    where s.id in ${db(stageIds as string[])}`;
}

/** W2d Task 10 — the rows `tableRulesOf` reads, for the write guards (`usecases/table-rule-guards.ts`): each stage's row
 *  with its name and its division's module, in board order. A guard asks the loader's own question of the rows as they
 *  stand and as a save would leave them, so the write side never re-derives a layer the read side resolves. */
export async function tableRulesRowsOf(
  db: Db,
  where: { readonly stageIds: readonly string[] } | { readonly divisionId: string },
): Promise<{ row: TableRulesRow; name: string; module: AnySportModule }[]> {
  const ids =
    "stageIds" in where
      ? [...where.stageIds]
      : (await db<{ id: string }[]>`select id from stages where division_id = ${where.divisionId} order by seq`).map((r) => r.id);
  const rows = await rulesRows(db, ids);
  const names = new Map(
    (ids.length === 0 ? [] : await db<{ id: string; name: string }[]>`select id, name from stages where id in ${db(ids)}`).map((r) => [r.id, r.name]),
  );
  const byId = new Map(rows.map((r) => [r.stage_id, r]));
  return ids.flatMap((id) => {
    const r = byId.get(id);
    return r === undefined ? [] : [{ row: toRow(r), name: names.get(id) ?? "", module: resolveModule(r.sport_key, r.module_version) }];
  });
}

/** X-TB-1/X-TB-2: the stage's table rules — its pin once active, else the live layers. Throws CONFIG_INVALID for an
 *  active or complete stage with no pin, and the resolver's typed refusals. */
export async function loadTableRules(db: Db, stageId: string): Promise<LoadedTableRules> {
  const [row] = await rulesRows(db, [stageId]);
  if (!row) throw new EngineError("STAGE_NOT_READY", `stage ${stageId} not found`, { stageId });
  return tableRulesOf(toRow(row), resolveModule(row.sport_key, row.module_version));
}

/** A stage's rules in a shape `unstable_cache` keeps (arrays and plain objects only — a Set serialises to `{}`): what
 *  the public documents, the hub and the console carry per stage. `primary` is the sport's first table measure. */
export interface StageTableRulesDoc {
  readonly points: PointsRule;
  readonly tiebreakers: readonly TiebreakerKey[];
  readonly crossGroup: readonly TiebreakerKey[];
  readonly sources: TableRulesPin["sources"];
  readonly pinnedAt: string | null;
  readonly reachable: readonly OutcomeKey[];
  readonly sportDefault: readonly TiebreakerKey[];
  readonly primary: AnySportModule["primaryTableKey"];
  /** W2e Task 8c (CK-BO-2): the stage's over length (`LoadedTableRules.ballsPerOver`), what net run rate is printed per.
   *  Absent for a sport with none - and on a document cached before this field existed, which reads as the default
   *  six-ball over until it is revalidated. */
  readonly ballsPerOver?: number;
}

/** One stage's rules as a document (`tableRulesOf`, its Set spread to an array): what `stageTableRulesDocs` serves, and
 *  what a pure reader's test hands its stage so it carries exactly the loader's shape. Throws as `tableRulesOf` does. */
export function stageTableRulesDocOf(row: TableRulesRow, module: AnySportModule): StageTableRulesDoc {
  const rules = tableRulesOf(row, module);
  return {
    points: rules.points,
    tiebreakers: rules.tiebreakers,
    crossGroup: rules.crossGroup,
    sources: rules.sources,
    pinnedAt: rules.pinnedAt,
    reachable: [...rules.reachable],
    sportDefault: rules.sportDefault,
    primary: module.primaryTableKey,
    ...(rules.ballsPerOver === undefined ? {} : { ballsPerOver: rules.ballsPerOver }),
  };
}

/** The readers that show many stages at once (the public division page and its document, the embed, the hub, the
 *  slideshow, the organiser console): every stage's rules in one read, by stage id. A stage whose rules are refused (a
 *  build this server no longer carries, a cfg its sport cannot read) is LEFT OUT and logged — the reader shows its table
 *  with no qualification status and no tie-break caption, never a guessed order (R3). */
export async function stageTableRulesDocs(db: Db, stageIds: readonly string[]): Promise<Record<string, StageTableRulesDoc>> {
  const out: Record<string, StageTableRulesDoc> = {};
  for (const r of await rulesRows(db, [...new Set(stageIds)])) {
    try {
      out[r.stage_id] = stageTableRulesDocOf(toRow(r), resolveModule(r.sport_key, r.module_version));
    } catch (cause) {
      log.warn({ event: "table_rules_unreadable", stageId: r.stage_id, err: String(cause) }, "stage table rules unreadable");
    }
  }
  return out;
}

/** The order a stage's table is ranked and captioned by, from its loaded rules (a `StageTableRulesDoc` on a public
 *  stage, or the console's): none for a stage the loader refused — never a default re-read by the reader. */
export function tableOrderOf(rules: { readonly tiebreakers: readonly TiebreakerKey[] } | null | undefined): readonly TiebreakerKey[] {
  return rules === null || rules === undefined ? [] : rules.tiebreakers;
}

const pinJson = (rules: TableRulesPin) => ({
  points: rules.points,
  tiebreakers: rules.tiebreakers,
  crossGroup: rules.crossGroup,
  sources: rules.sources,
});

/** X-TB-2 (D9, OC2): fix the stage's table rules as the live layers give them NOW — called by every writer that moves a
 *  stage to `active`, in its transaction, after the status write. Idempotent: a stage already pinned keeps its first pin
 *  (`… where table_rules_pinned is null`; Review Focus 1: a regenerate never re-takes it). */
export async function pinStageTableRules(tx: Db, stageId: string): Promise<void> {
  const [row] = await rulesRows(tx, [stageId]);
  if (!row) throw new EngineError("STAGE_NOT_READY", `stage ${stageId} not found`, { stageId });
  let live: LoadedTableRules;
  try {
    // Read as a pending stage reads: the layers live, whatever the status write just did.
    live = tableRulesOf({ ...toRow(row), status: "pending", pin: null, pinnedAt: null }, resolveModule(row.sport_key, row.module_version));
  } catch (cause) {
    // A stage pinned already keeps its pin even when its live layers no longer read (nothing is written either way).
    if (row.pin !== null && row.pin !== undefined) return;
    throw cause;
  }
  await tx`
    update stages set table_rules_pinned = ${tx.json(pinJson(live) as never)}, table_rules_pinned_at = now()
    where id = ${stageId} and table_rules_pinned is null`;
}

/** PS-5d (Task 10's caller): an own save between activation and the first score, re-pinned. Each field of `saved`:
 *  absent = keep the pin's value and its source; a value = the stage's own (source "stage"); `null` = the own layer
 *  CLEARED — the field reverts to the layer below as it stands NOW (the division's order, else the sport's; the sport's
 *  rule under the live cfg), its source updated (fix round 1, I4b ruling). The new pin is read through the engine's one
 *  resolver over the new own layer (I4a): the cross-group order is the resolver's — derived from the NEW order unless it
 *  is the stage's own (`sources.crossGroup === "stage"`, read, never inferred from the values: re-review N2), never one
 *  derived from the old order or the migration's. The pin's date is kept. No pin → no-op (a pending stage reads live). */
export async function repinStageOwnRules(
  tx: Db,
  stageId: string,
  saved: OwnSave,
): Promise<void> {
  const [locked] = await tx<{ pin: unknown }[]>`select table_rules_pinned as pin from stages where id = ${stageId} for update`;
  if (locked === undefined || locked.pin === null || locked.pin === undefined) return;
  const [row] = await rulesRows(tx, [stageId]);
  if (!row) throw new EngineError("STAGE_NOT_READY", `stage ${stageId} not found`, { stageId });
  const next = repinnedOf({ ...toRow(row), pin: locked.pin }, resolveModule(row.sport_key, row.module_version), saved);
  await tx`update stages set table_rules_pinned = ${tx.json(pinJson(next) as never)} where id = ${stageId}`;
}

/** What one own save writes to a stage's table layer: each field absent = kept, a value = the stage's own, null = cleared. */
export interface OwnSave {
  readonly points?: PointsRule | null;
  readonly tiebreakers?: readonly TiebreakerKey[] | null;
  readonly crossGroup?: readonly TiebreakerKey[] | null;
}

/** The pin `repinStageOwnRules` writes for `saved`, from the stage's row as the save leaves it (its own layer written, its
 *  pin as stored) — pure, so the write guards (`usecases/table-rule-guards.ts`) ask what a save WOULD pin before anything
 *  is written, by the one definition the write itself uses. */
export function repinnedOf(r: TableRulesRow, sportModule: AnySportModule, saved: OwnSave): TableRulesPin {
  const pin = parsePin(r.stageId, r.pin);
  const stageKind = tableStageKindOf(r.kind);
  const mergedCfg = liveCfg(r.divisionConfig, { kind: r.kind, config: r.stageConfig }, sportModule);
  const resolve = (stageOwn: TableRulesInputOwn) =>
    resolveTableRules({ module: sportModule, stageKind, mergedCfg, stageOwn, divisionTiebreakers: divisionOrderOf(r), pinned: null });
  const keepPoints = saved.points === undefined;
  const keepOrder = saved.tiebreakers === undefined;
  // The pin's cross-group order is the stage's own only where its SOURCE says so (re-review N2: never by comparing it with
  // a derived order — a migrated order differs from every derived one, and an own order may equal it). An own one stays
  // across an order save; a derived or migrated one follows the order: kept while the order is, re-derived when it moves.
  const crossGroupIsOwn = pin.sources.crossGroup === "stage";
  const keepCrossGroup = saved.crossGroup === undefined && (crossGroupIsOwn || keepOrder);
  const rules = resolve({
    points: keepPoints ? pin.points : (saved.points ?? null),
    tiebreakers: keepOrder ? pin.tiebreakers : (saved.tiebreakers ?? null),
    crossGroup: saved.crossGroup !== undefined ? saved.crossGroup : crossGroupIsOwn ? pin.crossGroup : null,
  });
  return {
    points: rules.points,
    tiebreakers: rules.tiebreakers,
    crossGroup: keepCrossGroup ? pin.crossGroup : rules.crossGroup,
    sources: {
      points: keepPoints ? pin.sources.points : rules.sources.points,
      tiebreakers: keepOrder ? pin.sources.tiebreakers : rules.sources.tiebreakers,
      crossGroup: keepCrossGroup ? pin.sources.crossGroup : rules.sources.crossGroup,
    },
  };
}

type TableRulesInputOwn = Parameters<typeof resolveTableRules>[0]["stageOwn"];

// ── Stored lots draws (spec §5.8) ──

/** The pool key the engine names a table by: a fixture's pool id, "" for the stage's one table. */
const poolKeyOf = (poolId: string | null): string => poolId ?? "";

/** The stage's stored draws, by pool ("" for none) then members key. The NEWEST row of each (pool, members key) serves,
 *  superseded or not: a tied set that comes back after a draw for a wider set is ordered as it was first drawn, and
 *  nothing new is stored (progress ledger, T5/T9). One row per (pool, members key) is read (`distinct on`, fix round 1
 *  m5): the history of a set drawn again stays in the table, never on the wire. */
export async function loadLotsDraws(tx: Db, stageId: string): Promise<ReadonlyMap<string, ReadonlyMap<MembersKey, StoredLotsDraw>>> {
  const rows = await tx<{ pool_id: string | null; members_key: string; drawn_order: string[]; drawn_at: string }[]>`
    select distinct on (pool_id, members_key) pool_id, members_key, drawn_order, to_json(drawn_at) #>> '{}' as drawn_at
    from stage_lots_draws where stage_id = ${stageId}
    order by pool_id, members_key, drawn_at desc, id desc`;
  const out = new Map<string, Map<MembersKey, StoredLotsDraw>>();
  for (const r of rows) {
    const pool = poolKeyOf(r.pool_id);
    const byKey = out.get(pool) ?? new Map<MembersKey, StoredLotsDraw>();
    byKey.set(r.members_key, { order: r.drawn_order, drawnAt: r.drawn_at });
    out.set(pool, byKey);
  }
  return out;
}

// T7 m9: a draw is stored only as the engine made it — its members distinct, its key theirs (`membersKeyOf`), its order a
// permutation of them. The table's own check holds the last; the first two are this writer's guard.
function assertDrawShape(stageId: string, draw: RankingResult["newLotsDraws"][number]): void {
  const members = new Set(draw.members);
  const fail = (why: string) => refused(stageId, `a lots draw ${why}`, { reason: "lots_draw_invalid", membersKey: draw.membersKey });
  if (members.size !== draw.members.length) throw fail("names an entrant twice");
  if (membersKeyOf(draw.members) !== draw.membersKey) throw fail("carries a members key that is not its members'");
  if (draw.drawnOrder.length !== members.size || !draw.drawnOrder.every((id) => members.has(id))) {
    throw fail("orders entrants other than its members");
  }
}

/** Store the draws a rank call made for one pool (null = the stage's one table). `on conflict do nothing` on the live
 *  key: a racing writer's draw wins for both (Review Focus 3), the caller re-reads. A stored draw whose members intersect
 *  a newly stored one in the same pool is superseded (history kept). */
export async function persistLotsDraws(
  tx: Db,
  stageId: string,
  poolId: string | null,
  draws: RankingResult["newLotsDraws"],
): Promise<void> {
  for (const draw of draws) {
    assertDrawShape(stageId, draw);
    const [stored] = await tx<{ id: string }[]>`
      insert into stage_lots_draws (stage_id, pool_id, members_key, members, drawn_order, seed)
      values (${stageId}, ${poolId}, ${draw.membersKey}, ${draw.members as string[]}::uuid[], ${draw.drawnOrder as string[]}::uuid[], ${draw.seed})
      on conflict do nothing
      returning id`;
    if (stored === undefined) continue;
    await tx`
      update stage_lots_draws set superseded_at = now()
      where stage_id = ${stageId} and pool_id is not distinct from ${poolId} and superseded_at is null
        and id <> ${stored.id} and members && ${draw.members as string[]}::uuid[]`;
  }
}
