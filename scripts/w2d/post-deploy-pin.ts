// W2d Task 9 fix rounds 1 (I2), 2 (N1-N4, the shoot-out split) and 3 (N5-N8, held rows) — the post-deploy step for the
// table-rules pin. ONE file, four jobs.
//
// V475 pins every started stage, converts every W2c `{base, bonuses, forfeit}` stage rule, and moves every football,
// hockey and ice hockey division config and organisation sport variant off the retired shoot-out split while it
// migrates. Between that migration and the deploy of the code that pins at activation, the OLD code is still serving: a
// stage it starts (or completes) in that window is left active/complete with no pin, a stage rule it saves is written in
// the old `{base}` shape (which the W2d reader, `parseStoredPointsRule`, reads as NO rule), and a division config or
// variant it saves carries `shootoutWin`/`shootoutLoss` again (which the W2d schema strips silently, so the division
// would pay draw + the default bonus instead of the organiser's split). This script closes that window, once, after the
// deploy, in this order:
//
//   1. split — every football/hockey/ice hockey division config and organisation-owned (`org_id` not null) sport variant
//      still holding `shootoutWin`/`shootoutLoss` is converted by `dropShootoutSplit`, the TypeScript twin of V475's
//      `w2d_drop_shootout_split` (spec §5.3, PS-1: `soBonus = shootoutWin − draw`, ice hockey drops the keys). A config
//      that twin refuses is NOT written and is counted `refused`; that division's stages are then not pinned (a pin
//      taken over a config the reader strips would pin the default bonus silently). The system presets (`org_id` null)
//      are `sync:sports`'s, written from the code, which carries no split.
//   2. convert — every stage `config.points` still in the `{base}` shape becomes the outcome-keyed rule through
//      `parseLegacyPointsRule`, the engine's B1 authority (the twin of V475's `w2d_legacy_points`). A refused value is
//      not written, counted `refused`, and its stage not pinned. A stage that is ALREADY pinned (V475 pinned it, or the
//      new code did, before the old code saved this rule) has its pin's points re-pinned to the converted rule through
//      the app's own `repinStageOwnRules` — what the W2d code does on an own save (PS-5d) — counted `repinned` (N4).
//   3. pin — every `active`/`complete` stage with no pin is pinned through the app's own `pinStageTableRules` (the
//      activation door's code, run here), each in its own transaction. Steps 1 and 2 run FIRST so a started stage's pin
//      carries its converted config and rule, never the sport's.
//   4. `--check` — read-only: prints the three counts (started stages with no pin; `{base}` stage rules; configs on the
//      shoot-out split) and the rows a run would HOLD, and exits 1 if any is above 0, else 0. Nothing is written.
//
// HELD (fix round 3, owner ruling: the script NEVER changes what a scored stage reads). Each row's transaction first asks
// the app's own lock predicate (`lockedStageIdsAmong`, server/usecases/rule-locks.ts: a played fixture or an opened
// round) of every stage that row's write would reach, under the lock the app's rule writers take (`division-config:`
// EXCLUSIVE, which a match's first event takes SHARED before it freezes: a first tap in flight commits before the read
// and is seen, or waits for this row). A hit is HELD: not written, named on stderr (`held: …`), counted
// in the summary and in `--check`, and the run exits 1. A held row is the owner's to decide ("call us"); running again
// holds it again. What a row reaches:
//   - a `{base}` stage rule, or a started stage's pin: that stage (pinned or not — its own rule, or the pin itself);
//   - a division config on the split: every stage of it that reads the division's points — no pin and no own rule (a
//     falsy `config.points`, the reader's "inherit"; a pending stage with an ad-hoc match or a ladder challenge reads
//     its live layers), or a pin the app took over them (`sources.points` "sport"). Not a V475 pin ("migrated": taken
//     from the pre-W2d rule before V475 dropped the split) and not an own rule's ("stage"). The started stages of a
//     held division are held with it (a pin taken over its config would pin the stripped split).
//   - an organisation variant: no stage. A variant's config is COPIED into a division when one is created or changes
//     variant (usecases/divisions.ts); no stage reads it live, so a variant is never held.
// After a division's conversion, every UNSCORED stage of it pinned over the old config (`sources.points` "sport": the
// new code's pin at activation, after the deploy, over the stripped split — re-review N8) is re-pinned from the
// converted config through `repinStageOwnRules` (points only, source "sport"; order, cross-group order and date kept),
// counted `repinned`.
//
//   node --experimental-strip-types scripts/w2d/post-deploy-pin.ts --check   # audit, writes nothing
//   node --experimental-strip-types scripts/w2d/post-deploy-pin.ts           # split, convert, then pin
//
// Options: `--org <uuid>` (repeatable) limits every count and write to those orgs; `--prod` is required for any
// DATABASE_URL whose host is not localhost / 127.0.0.1 / ::1. ONLY THE OWNER passes `--prod`. The URL is read from the
// environment and never accepted on argv, never printed, and never handed to anything that can echo it before this
// file has parsed it itself (`parseDatabaseUrl`, which never echoes; a `new URL` error carries its input). Every driver
// message this script prints has the URL's host, port, user, password and database name, and any IP address, taken out
// (`redact`).
//
// Exit: 0 = nothing left to do; 1 = work remains (`--check` found some, or a run refused, failed or held a row — a deploy
// must stop); 2 = refused to start (no/unreadable/non-local URL without `--prod`, a bad argument). Safe to run twice: a
// converted config holds no split, a converted rule is no longer `{base}`, a pinned stage is no longer unpinned, and
// `pinStageTableRules` itself writes only `where table_rules_pinned is null` — a second run reports zeros and changes no
// row.
//
// Why the app's code and not SQL: the pin must be exactly the one activation takes (the loader's layers, the module's
// declared order, the derived cross-group order), and the one place that is computed is `pinStageTableRules`
// (apps/web/src/server/engine-db/table-rules.ts), as the re-pin of an own save is `repinStageOwnRules`. Node cannot load
// that file as-is (`server-only`, the `@/` alias, extensionless specifiers), so `main` registers a resolve hook for
// exactly those three before it imports it.
import { registerHooks } from "node:module";
import { existsSync, statSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import postgres from "postgres";
import { parseLegacyPointsRule } from "@seazn/engine/competition";
import { isMainModule } from "../lib/main-module.ts";

type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;

export interface Args {
  check: boolean;
  prod: boolean;
  orgs: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The argv this script takes, or the reason it refuses one. Never echoes a value it refuses (it could be a URL). */
export function parseArgs(argv: readonly string[]): Args | { error: string } {
  const out: Args = { check: false, prod: false, orgs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") out.check = true;
    else if (a === "--prod") out.prod = true;
    else if (a === "--org") {
      const v = argv[++i];
      if (v === undefined || !UUID.test(v)) return { error: "--org takes an org id (a uuid)" };
      out.orgs.push(v.toLowerCase());
    } else return { error: `unknown argument #${i + 1} (takes --check, --prod, --org <uuid>)` };
  }
  return out;
}

// ── The URL: parsed here first, never echoed (re-review N1, N3) ──

/** DATABASE_URL as the driver will read it. Holds secrets: used for the locality check and for `redact`, never printed. */
export interface DatabaseUrl {
  /** The URL as given. */
  raw: string;
  /** `host[:port]` as written. */
  host: string;
  hostname: string;
  /** As written; "" when the URL names none (the driver then uses 5432). */
  port: string;
  username: string;
  password: string;
  /** The database as the driver sends it (`url.pathname.slice(1)`, not decoded); "" when the URL names none. */
  database: string;
  /** A `?host=`/`?hostaddr=` parameter: the URL's host is then not proven to be the one reached. */
  hostOverride: boolean;
}

/** Our own parse of DATABASE_URL, run before anything else sees it: the same reading postgres.js 3.4.9's `parseUrl`
 *  makes (the authority's host after the first `@`, then `new URL`, then the decoded user and password), so the host
 *  checked is the host the driver connects to. Refuses (null) a URL that is not `postgres:`/`postgresql:`, names no host
 *  (a socket or PGHOST), names a host list (the driver connects to any of them), carries a second `@` in its authority
 *  (the driver and `new URL` disagree on its host), or cannot be read or decoded. Never throws and never returns or
 *  echoes any part of an input it refuses. */
export function parseDatabaseUrl(url: string): DatabaseUrl | null {
  try {
    const scheme = url.indexOf("://");
    if (scheme < 0) return null;
    const authority = url.slice(scheme + 3).split(/[?/]/)[0] ?? "";
    const driverHost = decodeURIComponent(authority.slice(authority.indexOf("@") + 1));
    if (driverHost.includes(",") || driverHost.includes("@")) return null;
    const u = new URL(url);
    if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") return null;
    if (u.hostname === "") return null;
    return {
      raw: url,
      host: u.host,
      hostname: u.hostname,
      port: u.port,
      username: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: u.pathname.slice(1),
      hostOverride: u.searchParams.has("host") || u.searchParams.has("hostaddr"),
    };
  } catch {
    return null;
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const isLocalDatabase = (db: DatabaseUrl): boolean => !db.hostOverride && LOCAL_HOSTS.has(db.hostname.toLowerCase());

/** Is this a database on this machine? The host must be exactly localhost / 127.0.0.1 / ::1 — a URL `parseDatabaseUrl`
 *  refuses, or one with a `host`/`hostaddr` query override, is not proven local and reads as remote. Never throws and
 *  never returns any part of the URL. */
export function isLocalDatabaseUrl(url: string): boolean {
  const db = parseDatabaseUrl(url);
  return db !== null && isLocalDatabase(db);
}

const safeDecode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** `s` anywhere it is not part of a longer alphanumeric run. */
const word = (s: string, flags: string): RegExp => new RegExp(`(?<![A-Za-z0-9])${escapeRe(s)}(?![A-Za-z0-9])`, flags);
const IPV4 = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?![\d.])/g;
const IPV6 = /(?<![\w:])\[?(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}\]?(?::\d{1,5})?(?![\w:])/gi;

/** A driver or server message with the URL's host, port, user, password and database — and any IP address the host
 *  resolved to — taken out (re-review N3: `connect ECONNREFUSED ip:port`, `write CONNECTION_CLOSED host:port`, `password
 *  authentication failed for user "x"`; N7: `database "x" does not exist`). The rest of the message (its code words) is
 *  kept so the owner can act on it. */
export function redact(message: string, db: DatabaseUrl | null): string {
  let out = message;
  const take = (s: string, label: string, flags = "gi"): void => {
    if (s.length > 0) out = out.replace(word(s, flags), label);
  };
  if (db !== null) {
    if (db.raw.length > 0) out = out.split(db.raw).join("<url>");
    take(db.password, "<password>", "g");
    // the host as named, an IPv6 one without its brackets (`connect ECONNREFUSED ::1:5432`); its port goes below
    take(db.hostname.replace(/^\[|\]$/g, ""), "<host>");
    take(db.username, "<user>");
    // as the driver sent it, and decoded (a name with an escape in it)
    take(db.database, "<database>");
    take(safeDecode(db.database), "<database>");
  }
  out = out.replace(IPV4, "<address>").replace(IPV6, "<address>");
  // the port as a number of its own (never four digits inside an id: `-` is a uuid's separator)
  const port = db === null || db.port === "" ? "5432" : db.port;
  return out.replace(new RegExp(`(?<![A-Za-z0-9-])${escapeRe(port)}(?![A-Za-z0-9-])`, "g"), "<port>");
}

/** One failed row as printed: its id, the error's code, and its message with the connection's details taken out. */
export function failureLine(id: string, e: unknown, db: DatabaseUrl | null): string {
  const code = (e as { code?: unknown } | null)?.code;
  const message = e instanceof Error ? e.message : String(e);
  return `${id}: ${typeof code === "string" ? code : "ERROR"} ${redact(message, db)}`;
}

// ── The shoot-out split (spec §5.3, PS-1; the TypeScript twin of V475's `w2d_drop_shootout_split`) ──

const SPLIT_SPORTS = new Set(["football", "hockey", "icehockey"]);
const SPLIT_KEYS = ["shootoutWin", "shootoutLoss"] as const;

export type SplitNotice = "overtime-differs" | "loss-differs-from-draw" | "bonus-clamped";
export type SplitResult = { cfg: unknown; changed: boolean; notices: SplitNotice[] } | { refused: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const has = (o: Record<string, unknown>, k: string): boolean => Object.hasOwn(o, k);

class SplitRefused extends Error {}

/** A table-points value as the pre-W2d schema read it (`w2d_points_num`): absent ⇒ `fallback`; absent with no fallback
 *  and `required` ⇒ refused; present and not a number (a JSON null too) ⇒ refused. */
function pointsNum(p: Record<string, unknown>, key: string, fallback: number | null, what: string, required: boolean): number | null {
  if (!has(p, key)) {
    if (fallback === null && required) throw new SplitRefused(`${what} is missing`);
    return fallback;
  }
  const v = p[key];
  if (typeof v !== "number") throw new SplitRefused(`${what} is not a number`);
  return v;
}

/** `a − b` as Postgres `numeric` subtracts two JSON numbers: exact in decimal (0.3 − 0.1 is 0.2, not 0.19999…). */
function decimalSub(a: number, b: number): number {
  const places = (n: number): number | null => {
    const s = String(n);
    if (/e/i.test(s)) return null;
    const dot = s.indexOf(".");
    return dot < 0 ? 0 : s.length - dot - 1;
  };
  const pa = places(a);
  const pb = places(b);
  if (pa === null || pb === null) return a - b;
  const f = 10 ** Math.max(pa, pb);
  return (Math.round(a * f) - Math.round(b * f)) / f;
}

/** A config off the retired shoot-out split, exactly as V475's `w2d_drop_shootout_split` converts it. Football and
 *  hockey: `soBonus = shootoutWin − draw` (draw absent: 1), clamped at 0, unless a `soBonus` is already there; a
 *  `shootoutLoss` other than the draw is said (a draw-plus-bonus shoot-out pays its loser the draw). Ice hockey: the keys
 *  are dropped (a shoot-out pays the overtime values), and a split that differs from `otWin ?? win` / `otLoss ?? loss`
 *  is said. Any other sport, or a config with neither key, is returned as it is (`changed: false`). */
export function dropShootoutSplit(sport: string, cfg: unknown): SplitResult {
  const p = isObject(cfg) ? cfg.points : undefined;
  if (!SPLIT_SPORTS.has(sport) || !isObject(cfg) || !isObject(p) || !SPLIT_KEYS.some((k) => has(p, k))) {
    return { cfg, changed: false, notices: [] };
  }
  try {
    const notices: SplitNotice[] = [];
    const sw = pointsNum(p, "shootoutWin", null, `${sport} points.shootoutWin`, false);
    const sl = pointsNum(p, "shootoutLoss", null, `${sport} points.shootoutLoss`, false);
    const next: Record<string, unknown> = { ...p };
    if (sport === "icehockey") {
      const otherOf = (ot: string, plain: string): unknown => (has(p, ot) ? p[ot] : has(p, plain) ? p[plain] : undefined);
      const differs = (side: number | null, other: unknown): boolean => side !== null && !(typeof other === "number" && other === side);
      if (differs(sw, otherOf("otWin", "win")) || differs(sl, otherOf("otLoss", "loss"))) notices.push("overtime-differs");
    } else {
      const d = pointsNum(p, "draw", 1, `${sport} points.draw`, true) as number;
      if (sl !== null && sl !== d) notices.push("loss-differs-from-draw");
      if (sw !== null && !has(p, "soBonus")) {
        let bonus = decimalSub(sw, d);
        if (bonus < 0) {
          notices.push("bonus-clamped");
          bonus = 0;
        }
        next.soBonus = bonus;
      }
    }
    for (const k of SPLIT_KEYS) delete next[k];
    return { cfg: { ...cfg, points: next }, changed: true, notices };
  } catch (e) {
    if (e instanceof SplitRefused) return { refused: e.message };
    throw e;
  }
}

/** The rows a split conversion reads, in SQL: the twin's own precondition, so a row it would return unchanged is never
 *  listed. */
const SPLIT_ROWS = (sql: Sql | Tx) => sql`
  sport_key in ('football', 'hockey', 'icehockey')
  and jsonb_typeof(config -> 'points') = 'object'
  and config -> 'points' ?| array['shootoutWin', 'shootoutLoss']`;

/** The organisation sport variants on the split: never a system preset (`org_id` null), which `sync:sports` writes. One
 *  fragment for the count and the write, so the two cannot disagree on which rows are in. */
const SPLIT_VARIANTS = (sql: Sql | Tx) => sql`org_id is not null and ${SPLIT_ROWS(sql)}`;

/** Scope fragment: every count and write below is limited to the named orgs, or to none. */
function inOrgs(sql: Sql | Tx, orgs: readonly string[]) {
  return orgs.length === 0 ? sql`true` : sql`org_id in ${sql(orgs as string[])}`;
}

/** The stages of a division whose table reads the division's points (fix round 3): no pin and no own rule — a falsy
 *  `config.points` is the reader's "inherit" (`ownRulesOf`: `if (rawPoints)`; jsonb null, false, 0 and "" alike) — or a
 *  pin the app took over the division's layers (`sources.points` "sport"). A V475 pin ("migrated") was taken from the
 *  pre-W2d rule before V475 dropped the split, and an own rule ("stage") is the stage's: neither reads the division. */
const READS_DIVISION_POINTS = (sql: Sql | Tx) => sql`
  ((table_rules_pinned is null
    and (config -> 'points' is null or config -> 'points' in ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb)))
   or table_rules_pinned -> 'sources' ->> 'points' = 'sport')`;

const BASE_RULE_ROWS = (sql: Sql | Tx) => sql`jsonb_typeof(config -> 'points') = 'object' and config -> 'points' ? 'base'`;
const UNPINNED_STARTED = (sql: Sql | Tx) => sql`status in ('active', 'complete') and table_rules_pinned is null`;

/** The app's lock predicate (`lockedStageIdsAmong`, server/usecases/rule-locks.ts): the stages among `stageIds` with a
 *  played fixture or an opened round. */
export type LockedAmong = (tx: Sql | Tx, stageIds: readonly string[]) => Promise<Set<string>>;

export interface Census {
  /** Stages `active`/`complete` with no pin. */
  unpinnedStarted: number;
  /** Stages whose `config.points` is still the W2c `{base}` shape. */
  baseStageRules: number;
  /** Football/hockey/ice hockey division configs and organisation sport variants still on the shoot-out split. */
  shootoutSplitConfigs: number;
  /** Of the rows above, those a run would HOLD (each is also still in its own count): division configs whose split
   *  reaches a scored stage, and `{base}` and unpinned started stages that are scored or whose division is held. */
  held: number;
}

/** The rows a run would hold, as `run` decides them, read in one pass (`--check` and the run's `after`). */
async function heldCount(sql: Sql, orgs: readonly string[], locked: LockedAmong): Promise<number> {
  const splitDivisions = (await sql<{ id: string }[]>`select id from divisions where ${SPLIT_ROWS(sql)} and ${inOrgs(sql, orgs)}`).map((d) => d.id);
  const reach =
    splitDivisions.length === 0
      ? []
      : await sql<{ id: string; division_id: string }[]>`
          select id, division_id from stages where division_id in ${sql(splitDivisions)} and ${READS_DIVISION_POINTS(sql)}`;
  const based = await sql<{ id: string }[]>`select id from stages where ${BASE_RULE_ROWS(sql)} and ${inOrgs(sql, orgs)}`;
  const unpinned = await sql<{ id: string; division_id: string }[]>`
    select id, division_id from stages where ${UNPINNED_STARTED(sql)} and ${inOrgs(sql, orgs)}`;
  const scored = await locked(sql, [...new Set([...reach, ...based, ...unpinned].map((s) => s.id))]);
  const heldDivisions = new Set(reach.filter((s) => scored.has(s.id)).map((s) => s.division_id));
  const heldStages = new Set([
    ...based.filter((s) => scored.has(s.id)).map((s) => s.id),
    ...unpinned.filter((s) => scored.has(s.id) || heldDivisions.has(s.division_id)).map((s) => s.id),
  ]);
  return heldDivisions.size + heldStages.size;
}

export async function census(sql: Sql, orgs: readonly string[], locked: LockedAmong): Promise<Census> {
  const [row] = await sql<{ unpinned: number; base: number }[]>`
    select count(*) filter (where ${UNPINNED_STARTED(sql)})::int as unpinned,
           count(*) filter (where ${BASE_RULE_ROWS(sql)})::int as base
      from stages where ${inOrgs(sql, orgs)}`;
  const [split] = await sql<{ n: number }[]>`
    select (select count(*) from divisions where ${SPLIT_ROWS(sql)} and ${inOrgs(sql, orgs)})::int
         + (select count(*) from sport_variants where ${SPLIT_VARIANTS(sql)} and ${inOrgs(sql, orgs)})::int as n`;
  return { unpinnedStarted: row.unpinned, baseStageRules: row.base, shootoutSplitConfigs: split.n, held: await heldCount(sql, orgs, locked) };
}

export interface RunReport {
  /** Division configs moved off the shoot-out split. */
  divisionConfigs: number;
  /** Organisation sport variants moved off the shoot-out split. */
  variantConfigs: number;
  converted: number;
  /** Pinned stages re-pinned: of `converted`, those whose pin's points became the converted rule (N4); and the unscored
   *  stages of a converted division pinned over its old config, re-pinned from the converted one (N8). */
  repinned: number;
  pinned: number;
  /** What a reader refused, one line each (`stage <id> …`, `division <id> …`, `variant …`): left as it is, and a refused
   *  stage or division's stages not pinned. */
  refused: string[];
  /** Rows whose write failed: `id: CODE message` (`failureLine`). */
  failed: string[];
  /** Rows not written because the write would reach a scored stage, one line each (`stage <id>: …`, `division <id>: …`). */
  held: string[];
  /** What the split conversion said out loud, one line per config (V475 raises the same as notices). */
  notices: string[];
  after: Census;
}

type PinStage = (tx: Tx, stageId: string) => Promise<void>;
type RepinStage = (tx: Tx, stageId: string, saved: { readonly points?: unknown }) => Promise<void>;

/** The app's two pin doors and its lock predicate the run calls (`server/engine-db/table-rules.ts`,
 *  `server/usecases/rule-locks.ts`), and the parsed URL its failures are redacted against. */
export interface Doors {
  pinStageTableRules: PinStage;
  repinStageOwnRules: RepinStage;
  lockedStageIdsAmong: LockedAmong;
  db: DatabaseUrl | null;
}

/** The lock the app's rule writers hold from before their lock read to their commit (`stage-rules.ts` putStageRules,
 *  `divisions.ts` patchDivision): `division-config:<division>` EXCLUSIVE, which a match's first event takes SHARED before
 *  it freezes (append-event.ts) — so a first tap in flight commits before the lock read below it (which then sees the
 *  stage played) or waits for this row's commit. Taken first in each row's transaction (the app's global order puts it
 *  after `division:`, stage seats and `fixture:`, none of which this script takes; the rows it writes are locked
 *  `for update` after it). */
async function lockDivisionRules(tx: Tx, divisionId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtext(${"division-config:" + divisionId}))`;
}

const SCORED = "it has a played fixture or an opened round";

/** The writes, in order (split, convert, then pin), each row in its own transaction; a row whose write would reach a
 *  scored stage is held. */
export async function run(sql: Sql, orgs: readonly string[], doors: Doors): Promise<RunReport> {
  const report: RunReport = {
    divisionConfigs: 0,
    variantConfigs: 0,
    converted: 0,
    repinned: 0,
    pinned: 0,
    refused: [],
    failed: [],
    held: [],
    notices: [],
    after: { unpinnedStarted: 0, baseStageRules: 0, shootoutSplitConfigs: 0, held: 0 },
  };
  const refusedStages = new Set<string>();
  const refusedDivisions = new Set<string>();
  const heldDivisions = new Set<string>();
  // One line per held row: a stage held for its `{base}` rule is not asked again for its pin (step 3 skips it).
  const heldKeys = new Set<string>();
  const hold = (key: string, why: string): void => {
    heldKeys.add(key);
    report.held.push(`${key}: ${why}`);
  };

  // 1. the shoot-out split: division configs, then organisation sport variants
  const divisions = await sql<{ id: string }[]>`
    select id from divisions where ${SPLIT_ROWS(sql)} and ${inOrgs(sql, orgs)} order by id`;
  for (const { id } of divisions) {
    try {
      const outcome = await sql.begin(async (tx) => {
        await lockDivisionRules(tx, id);
        const [row] = await tx<{ sport_key: string; config: unknown }[]>`
          select sport_key, config from divisions where id = ${id} and ${SPLIT_ROWS(tx)} for update`;
        if (row === undefined) return null; // converted by someone else since the list was read
        // N5(b), N8: the stages this conversion reaches, and whether any is scored — asked before the twin, so a
        // division that would also be refused is held (the owner's call comes first)
        const reach = await tx<{ id: string; pinned: boolean }[]>`
          select id, table_rules_pinned is not null as pinned from stages
           where division_id = ${id} and ${READS_DIVISION_POINTS(tx)} order by id for update`;
        const locked = await doors.lockedStageIdsAmong(tx, reach.map((s) => s.id));
        const scored = reach.filter((s) => locked.has(s.id)).map((s) => s.id);
        if (scored.length > 0) return { kind: "held" as const, scored };
        const r = dropShootoutSplit(row.sport_key, row.config);
        if ("refused" in r) return { kind: "refused" as const, why: r.refused };
        if (!r.changed) return null; // the twin's own precondition is the row filter's: nothing to write
        await tx`update divisions set config = jsonb_set(config, '{points}', ${tx.json((r.cfg as { points: never }).points)}) where id = ${id}`;
        // N8: a stage the app pinned over the old config reads the stripped split for good — re-pinned from the
        // converted config (points only, from the live layers now: source "sport")
        let repinned = 0;
        for (const s of reach) {
          if (!s.pinned) continue;
          await doors.repinStageOwnRules(tx, s.id, { points: null });
          repinned++;
        }
        return { kind: "converted" as const, notices: r.notices, repinned };
      });
      if (outcome === null) continue;
      if (outcome.kind === "held") {
        heldDivisions.add(id);
        hold(`division ${id}`, `shoot-out split not converted: it would change the table of stage(s) ${outcome.scored.join(", ")} (${SCORED}); its started stages not pinned`);
      } else if (outcome.kind === "refused") {
        refusedDivisions.add(id);
        report.refused.push(`division ${id}: shoot-out split not converted (${outcome.why}); its stages not pinned`);
      } else {
        report.divisionConfigs++;
        report.repinned += outcome.repinned;
        for (const n of outcome.notices) report.notices.push(`division ${id}: ${n}`);
      }
    } catch (e) {
      report.failed.push(failureLine(`division ${id}`, e, doors.db));
    }
  }
  // An organisation variant reaches no stage (a division copies it when created or moved to it), so it is never held.
  const variants = await sql<{ sport_key: string; key: string; org_id: string }[]>`
    select sport_key, key, org_id from sport_variants
     where ${SPLIT_VARIANTS(sql)} and ${inOrgs(sql, orgs)}
     order by sport_key, key, org_id`;
  for (const v of variants) {
    const name = `variant ${v.sport_key}/${v.key} of org ${v.org_id}`;
    try {
      const outcome = await sql.begin(async (tx) => {
        const [row] = await tx<{ config: unknown }[]>`
          select config from sport_variants
           where sport_key = ${v.sport_key} and key = ${v.key} and org_id = ${v.org_id} and ${SPLIT_VARIANTS(tx)} for update`;
        if (row === undefined) return null;
        const r = dropShootoutSplit(v.sport_key, row.config);
        if (!("refused" in r) && r.changed) {
          await tx`
            update sport_variants set config = jsonb_set(config, '{points}', ${tx.json((r.cfg as { points: never }).points)})
             where sport_key = ${v.sport_key} and key = ${v.key} and org_id = ${v.org_id}`;
        }
        return r;
      });
      if (outcome === null) continue;
      if ("refused" in outcome) report.refused.push(`${name}: shoot-out split not converted (${outcome.refused})`);
      else if (outcome.changed) {
        report.variantConfigs++;
        for (const n of outcome.notices) report.notices.push(`${name}: ${n}`);
      }
    } catch (e) {
      report.failed.push(failureLine(name, e, doors.db));
    }
  }

  // 2. the `{base}` stage rules; a stage already pinned has its pin's points re-pinned (N4); a scored stage is held (N5a)
  const based = await sql<{ id: string; division_id: string }[]>`
    select id, division_id from stages where ${BASE_RULE_ROWS(sql)} and ${inOrgs(sql, orgs)} order by id`;
  for (const { id, division_id } of based) {
    try {
      const outcome = await sql.begin(async (tx) => {
        await lockDivisionRules(tx, division_id);
        const [row] = await tx<{ points: unknown; pinned: boolean }[]>`
          select config -> 'points' as points, table_rules_pinned is not null as pinned from stages
           where id = ${id} and ${BASE_RULE_ROWS(tx)} for update`;
        if (row === undefined) return "gone" as const; // converted by someone else since the list was read
        if ((await doors.lockedStageIdsAmong(tx, [id])).has(id)) return "held" as const;
        const rule = parseLegacyPointsRule(row.points);
        if (rule === null) return "refused" as const;
        await tx`update stages set config = jsonb_set(config, '{points}', ${tx.json(rule)}) where id = ${id}`;
        if (!row.pinned) return "converted" as const;
        // The old code saved this rule over a stage already pinned: the W2d code re-pins an own save (PS-5d), so this
        // does — the points field only, its source "stage"; the order, the cross-group order and the pin's date kept.
        await doors.repinStageOwnRules(tx, id, { points: rule });
        return "repinned" as const;
      });
      if (outcome === "converted" || outcome === "repinned") report.converted++;
      if (outcome === "repinned") report.repinned++;
      if (outcome === "held") hold(`stage ${id}`, `{base} rule not converted (${SCORED}); not pinned`);
      if (outcome === "refused") {
        refusedStages.add(id);
        report.refused.push(`stage ${id}: {base} rule not converted (the B1 reader refuses it); not pinned`);
      }
    } catch (e) {
      // Rolled back, its rule still `{base}`: the pin below refuses it too (`ownRulesOf` reads no `{base}` rule).
      report.failed.push(failureLine(`stage ${id}`, e, doors.db));
    }
  }

  // 3. the pin of every started stage with none — not a scored one (N5, N6: a pin taken now is W2d's rule, not the one
  // it was scored under), nor one whose division is held
  const unpinned = await sql<{ id: string; division_id: string }[]>`
    select id, division_id from stages where ${UNPINNED_STARTED(sql)} and ${inOrgs(sql, orgs)} order by id`;
  for (const { id, division_id } of unpinned) {
    const key = `stage ${id}`;
    if (heldKeys.has(key)) continue;
    if (heldDivisions.has(division_id)) {
      hold(key, `not pinned: its division ${division_id} is held`);
      continue;
    }
    try {
      const outcome = await sql.begin(async (tx) => {
        await lockDivisionRules(tx, division_id);
        const [row] = await tx<{ id: string }[]>`select id from stages where id = ${id} and ${UNPINNED_STARTED(tx)} for update`;
        if (row === undefined) return "gone" as const;
        // the lock first: a scored stage is held even where its rule or division was refused (as `--check` counts it)
        if ((await doors.lockedStageIdsAmong(tx, [id])).has(id)) return "held" as const;
        if (refusedStages.has(id) || refusedDivisions.has(division_id)) return "skipped" as const;
        await doors.pinStageTableRules(tx, id);
        const [after] = await tx<{ pinned: boolean }[]>`select table_rules_pinned is not null as pinned from stages where id = ${id}`;
        if (after?.pinned !== true) throw Object.assign(new Error("the pin wrote nothing"), { code: "NOT_PINNED" });
        return "pinned" as const;
      });
      if (outcome === "pinned") report.pinned++;
      if (outcome === "held") hold(key, `not pinned (${SCORED})`);
    } catch (e) {
      report.failed.push(failureLine(key, e, doors.db));
    }
  }
  report.after = await census(sql, orgs, doors.lockedStageIdsAmong);
  return report;
}

// A held row is never written, so it stays in its own count too; `held` is named here so the exit reads as the rule does.
const anyLeft = (c: Census): boolean => c.unpinnedStarted > 0 || c.baseStageRules > 0 || c.shootoutSplitConfigs > 0 || c.held > 0;

/** Exit code of an apply run: 0 only when nothing was refused, failed or held and nothing is left in scope. */
export function exitCodeOfRun(r: RunReport): number {
  return r.refused.length > 0 || r.failed.length > 0 || r.held.length > 0 || anyLeft(r.after) ? 1 : 0;
}

/** Exit code of `--check`: 1 while any count is above 0. */
export function exitCodeOfCheck(c: Census): number {
  return anyLeft(c) ? 1 : 0;
}

/** Barrels node reads as the one module the doors this file loads need from them. `@/server/engine-db` re-exports
 *  from append-event, rebuild, replay and the rest, which reach `lib/errors.ts` — whose constructor parameter properties
 *  Node 26 cannot strip (it has no transform mode) — while `rule-locks.ts` takes only `resolveModule` from it, whose
 *  home is `registry.ts`. Fail-loud: a module that imports any other name from the barrel stops this script at link
 *  time ("does not provide an export named …"), before it connects. */
const BARREL_AS = new Map([["@/server/engine-db", "server/engine-db/registry"]]);

/** Lets node load apps/web server modules: `server-only` is a no-op, `@/` is apps/web/src (a barrel in `BARREL_AS` as
 *  the module named there), and an extensionless relative specifier is the `.ts`/`.tsx`/`/index.ts` file on disk.
 *  Process-wide, so only `main` calls it. */
function registerWebResolve(webSrc: string): void {
  const file = (p: string): string | null => {
    for (const c of [p, `${p}.ts`, `${p}.tsx`, `${p}/index.ts`]) if (existsSync(c) && statSync(c).isFile()) return c;
    return null;
  };
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "server-only") return { url: "data:text/javascript,export{}", shortCircuit: true };
      if (specifier.startsWith("@/")) {
        const f = file(resolvePath(webSrc, BARREL_AS.get(specifier) ?? specifier.slice(2)));
        if (f !== null) return { url: pathToFileURL(f).href, shortCircuit: true };
      }
      if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
        const f = file(resolvePath(dirname(fileURLToPath(context.parentURL)), specifier));
        if (f !== null) return { url: pathToFileURL(f).href, shortCircuit: true };
      }
      return next(specifier, context);
    },
  });
}

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  const args = parseArgs(argv);
  if ("error" in args) {
    console.error(`post-deploy-pin: ${args.error}`);
    return 2;
  }
  const url = env.DATABASE_URL;
  if (url === undefined || url === "") {
    console.error("post-deploy-pin: DATABASE_URL is not set.");
    return 2;
  }
  // N1: parsed HERE before anything else sees it — nothing below gets a URL this parse could not read.
  const db = parseDatabaseUrl(url);
  if (db === null) {
    console.error("post-deploy-pin: DATABASE_URL is not a valid postgres URL (postgres:// or postgresql://, one host). It is not printed.");
    return 2;
  }
  if (!isLocalDatabase(db) && !args.prod) {
    console.error("post-deploy-pin: refused — DATABASE_URL is not a local database (localhost / 127.0.0.1 / ::1). Only the owner runs this against a deployed database, with --prod.");
    return 2;
  }
  const webSrc = fileURLToPath(new URL("../../apps/web/src/", import.meta.url));
  registerWebResolve(webSrc);
  const dbModule = (await import(pathToFileURL(resolvePath(webSrc, "lib/db.ts")).href)) as {
    connectionOptions(url: string, env: NodeJS.ProcessEnv): { ssl: false | "require"; prepare: boolean; schema: string };
  };
  const tableRules = (await import(pathToFileURL(resolvePath(webSrc, "server/engine-db/table-rules.ts")).href)) as {
    pinStageTableRules: PinStage;
    repinStageOwnRules: RepinStage;
  };
  const ruleLocks = (await import(pathToFileURL(resolvePath(webSrc, "server/usecases/rule-locks.ts")).href)) as {
    lockedStageIdsAmong: LockedAmong;
  };
  let sql: Sql;
  try {
    // N1: the driver's own option parse can still refuse what ours read (a `target_session_attrs` it does not know, and
    // its message echoes the value): a fixed message, never the error's.
    const { ssl, prepare, schema } = dbModule.connectionOptions(url, env);
    sql = postgres(url, { ssl, prepare, max: 1, connection: { search_path: schema }, onnotice: () => undefined });
  } catch {
    console.error("post-deploy-pin: the database driver refused DATABASE_URL's options. It is not printed.");
    return 2;
  }
  try {
    if (args.check) {
      const c = await census(sql, args.orgs, ruleLocks.lockedStageIdsAmong);
      console.log(JSON.stringify({ mode: "check", ...c }));
      return exitCodeOfCheck(c);
    }
    const r = await run(sql, args.orgs, {
      pinStageTableRules: tableRules.pinStageTableRules,
      repinStageOwnRules: tableRules.repinStageOwnRules,
      lockedStageIdsAmong: ruleLocks.lockedStageIdsAmong,
      db,
    });
    for (const n of r.notices) console.error(`shoot-out split converted, said: ${n}`);
    for (const line of r.refused) console.error(`refused: ${line}`);
    for (const f of r.failed) console.error(`failed: ${f}`);
    for (const line of r.held) console.error(`held: ${line}`);
    console.log(
      JSON.stringify({
        mode: "apply",
        divisionConfigs: r.divisionConfigs,
        variantConfigs: r.variantConfigs,
        converted: r.converted,
        repinned: r.repinned,
        pinned: r.pinned,
        refused: r.refused.length,
        failed: r.failed.length,
        held: r.held.length,
        unpinnedStarted: r.after.unpinnedStarted,
        baseStageRules: r.after.baseStageRules,
        shootoutSplitConfigs: r.after.shootoutSplitConfigs,
      }),
    );
    return exitCodeOfRun(r);
  } catch (e) {
    // A connection or SQL failure: its code and its message with the connection's details taken out (N3).
    const code = (e as { code?: unknown }).code;
    const message = e instanceof Error ? e.message : String(e);
    console.error(`post-deploy-pin: failed (${typeof code === "string" ? code : e instanceof Error ? e.name : "error"}): ${redact(message, db)}`);
    return 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (isMainModule(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2), process.env);
  } catch (e) {
    // Never node's own print of an unhandled rejection: an error's fields can carry the URL.
    const message = e instanceof Error ? e.message : String(e);
    console.error(`post-deploy-pin: failed (${e instanceof Error ? e.name : "error"}): ${redact(message, parseDatabaseUrl(process.env.DATABASE_URL ?? ""))}`);
    process.exitCode = 1;
  }
}
