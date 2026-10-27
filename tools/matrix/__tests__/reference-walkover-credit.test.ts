// W2b Task 15 Step 3 (plan PF-12): the reference ↔ engine cross-check for the walkover-credit family. It lives here,
// beside W2a's reference-bracket.test.ts, because it depends on both packages: @seazn/reference may only `import type`
// from the engine (R7), and the engine never imports the reference.
//
// Every case `enumerateCreditCases()` holds is folded through the REAL sport module — the case's stream (the play
// before the forfeit, rebuilt event by event from the case's scoresheet, then `core.forfeit`) through
// `foldMatchWithStoppage` (strict from seq 1, the product's fold), its outcome through the module's own
// `standingsDelta`, its credit through `forfeitCredit`, its players'-stats reading through the stats fold's declared
// rule — and the engine's answer is compared field by field with `walkoverCredit`'s:
//   * winner / loser — every metric key the reference names (a key it leaves out is not judged: its own contract);
//   * excluded — every key the reference excludes is in the engine's `forfeitCredit(...).excluded` (an exclusion is
//     realised as a 0 credit, so a key the engine ALSO excludes that the reference credits 0, or does not name, is the
//     same table — and one the reference credits non-zero reds on the metric itself);
//   * points — the cfg's own declared points table read for the reference's "win" / "zero" (`forfeitPoints`, the
//     harness's one reader of the four shapes) against both deltas' points;
//   * statsMatch — `PlayerStatsModel.unplayed`, or, where a model declares none, `forfeitStatsRole` (the rule the
//     stats fold applies, stats.ts `PlayerStatsModel.unplayed`'s own contract).
// A disagreement is never resolved by editing the reference to match the engine (the rule row decides): this file
// fails and prints both answers, and the orchestrator routes the loser to its own loop.
import { forfeitStatsRole } from "@seazn/engine/stats";
import { DRAW_KINDS, resolveVoids, type AwardReason, type MatchOutcome, type StageKind, type StandingsDelta } from "@seazn/engine/core";
import { CarromBoardSummary } from "@seazn/engine/sports/carrom";
import { declaredCfgs } from "@seazn/engine/testkit";
import * as reference from "@seazn/reference";
import { CREDIT_METRIC_RULES, CREDIT_SPORTS, CreditRefused, WALKOVER_CREDIT_DATA, enumerateCreditCases, walkoverCredit, walkoverCreditFamily, type CreditAnswer, type CreditCase } from "@seazn/reference";
import { describe, expect, it } from "vitest";
import { envelopes, foldStream } from "../lib/fold.ts";
import { forfeitPoints } from "../lib/scenarios/w2b-checks.ts";
import { sportModule } from "../lib/sport-cfg.ts";
import { TEST_BALLS, declaredAllOut } from "../lib/streams/cricket.ts";
import { footballPhases } from "../lib/streams/football.ts";
import { periodLabels } from "../lib/streams/period.ts";
import { START, type StreamEvent } from "../lib/streams/types.ts";

type Side = "home" | "away";
type Offender = Side | "both";
type Sheet = { readonly home: readonly number[]; readonly away: readonly number[] };
type Cfg = Record<string, unknown>;

// The two seats' entrant ids (the harness's empty-slot lineups, lib/fold.ts lineupsFor).
const H = "H";
const A = "A";
const idOf = (s: Side): string => (s === "home" ? H : A);
const other = (s: Side): Side => (s === "home" ? "away" : "home");
const LEAGUE = { kind: "league" } as const;

/** Every case enumerator a module exports (the tripwire's reader, review M5). An export is one by NAME — `enumerate*`,
 *  at any arity — or by SHAPE: a zero-argument function, or a zero-argument method of an exported object or of an object
 *  in an exported array (a family), that returns a non-empty array of objects. Arity 0 is the one shape this can call
 *  without inventing an input, so an enumerator that needs one is held to the name. Classes are never called, and a
 *  zero-argument export that throws reds the tripwire with its own error rather than being read as "not one". */
function caseEnumerators(mod: Record<string, unknown>): { found: string[]; called: number } {
  const found = new Set<string>();
  let called = 0;
  const isClass = (f: (...args: never[]) => unknown) => /^class\b/.test(Function.prototype.toString.call(f));
  const read = (name: string, f: unknown, self: unknown) => {
    if (typeof f !== "function") return;
    const fn = f as (...args: never[]) => unknown;
    if (/^enumerate/.test(name.slice(name.lastIndexOf(".") + 1))) found.add(name);
    if (isClass(fn) || fn.length !== 0) return;
    called++;
    const out: unknown = fn.call(self);
    if (Array.isArray(out) && out.length > 0 && out.every((x) => typeof x === "object" && x !== null && !Array.isArray(x))) found.add(name);
  };
  const members = (name: string, holder: unknown) => {
    if (holder === null || typeof holder !== "object" || Array.isArray(holder)) return;
    for (const [key, member] of Object.entries(holder)) read(`${name}.${key}`, member, holder);
  };
  for (const [name, value] of Object.entries(mod)) {
    read(name, value, undefined);
    if (Array.isArray(value)) value.forEach((v, i) => members(`${name}[${i}]`, v));
    else members(name, value);
  }
  return { found: [...found].sort(), called };
}

/** The stream could not be built from the case's scoresheet: refused by name, never guessed (a failing item). */
class SheetUnbuildable extends Error {
  constructor(sport: string, why: string) {
    super(`cross-check: ${sport} scoresheet — ${why}`);
    this.name = "SheetUnbuildable";
  }
}

// ── The engine's cfg for a case ──────────────────────────────────────────────────────────────────────────────────

/** The cfg a case is folded under, as `CreditCase.variant`'s recipe says: a DECLARED name is the engine's declared cfg
 *  of that name, parsed and UNMODIFIED (`declaredCfgs`); a named extra is not declared — it is a stage's match rules,
 *  so its data keys are laid over the sport's base cfg (the schema default, or its first variant where the schema has
 *  none) and parsed by the sport's own configSchema. */
function engineCfgOf(c: CreditCase): Cfg {
  const m = sportModule(c.sport);
  const declared = declaredCfgs(m as never) as { name: string; cfg: Cfg }[];
  const hit = declared.find((d) => d.name === c.variant);
  if (hit !== undefined) return hit.cfg;
  if (c.variant === undefined) throw new Error(`cross-check: ${c.label ?? c.sport} names no cfg`);
  const variants = m.variants as Record<string, Cfg>;
  const base = m.configSchema.safeParse({}).success ? {} : (Object.values(variants)[0] ?? {});
  return m.configSchema.parse({ ...base, ...c.cfg }) as Cfg;
}

// ── The scoresheet as the sport's own events ─────────────────────────────────────────────────────────────────────

/** One unit's points, point by point: alternate (home first) up to the lower score, then the leader's run — so no
 *  side reaches the unit's end (target, two clear, cap) before the unit's last point, a deuce unit included. */
function pointByPoint(h: number, a: number, point: (s: Side) => StreamEvent[]): StreamEvent[] {
  const out: StreamEvent[] = [];
  for (let i = 0; i < Math.min(h, a); i++) out.push(...point("home"), ...point("away"));
  const lead: Side = h > a ? "home" : "away";
  for (let i = 0; i < Math.abs(h - a); i++) out.push(...point(lead));
  return out;
}

/** Units past the last one that holds any score: a unit nobody has scored in yet has not begun (no event). */
function begunUnits(sheet: Sheet): { h: number; a: number }[] {
  const units = sheet.home.map((h, i) => ({ h, a: sheet.away[i] ?? 0 }));
  while (units.length > 0 && units[units.length - 1]!.h === 0 && units[units.length - 1]!.a === 0) units.pop();
  return units;
}

/** The play before the forfeit, in the sport's own vocabulary (the generators' event types, tools/matrix/lib/streams):
 *  `pre` before core.start (a toss), `play` after it. The sheet's units are the reference's: goals per period, points
 *  per set or game, games per tennis set, points per carrom game, runs per innings, a generic tally. */
function sheetEvents(sport: string, cfg: Cfg, sheet: Sheet): { pre: StreamEvent[]; play: StreamEvent[] } {
  if (sheet.home.length !== sheet.away.length) throw new SheetUnbuildable(sport, "the two sides' unit lists differ in length");
  const units = begunUnits(sheet);
  const play: StreamEvent[] = [];
  switch (sport) {
    case "football":
    case "hockey":
    case "icehockey": {
      // The period boundary between two units is the sport's own marker (never full time: the last unit stays open, the
      // match is live) — football's phase markers short of FT, the period kernel's advance to each next label.
      const markers: StreamEvent[] = sport === "football"
        ? (footballPhases(cfg.halves as number) ?? []).slice(0, -1).map((phase) => ({ type: "football.period", payload: { phase } }))
        : periodLabels((cfg.periods as { count: number }).count).slice(1).map((to) => ({ type: `${sport}.period.advance`, payload: { to } }));
      if (units.length - 1 > markers.length) throw new SheetUnbuildable(sport, `${units.length} units, but the cfg plays ${markers.length + 1} period(s)`);
      // W2d T18 (HK-TB-2): the write path refuses a hockey goal without its type, so the sheet's goals are field goals
      // (`fg`, FIH's open-play goal) — the plain goal a score sheet records, no pc/stroke column moved.
      const goal = (by: string): StreamEvent => ({ type: `${sport}.goal`, payload: sport === "hockey" ? { by, kind: "fg" } : { by } });
      units.forEach(({ h, a }, i) => {
        for (let g = 0; g < h; g++) play.push(goal(H));
        for (let g = 0; g < a; g++) play.push(goal(A));
        if (i < units.length - 1) play.push(markers[i]!);
      });
      return { pre: [], play };
    }
    case "volleyball":
    case "tabletennis":
    case "badminton":
      for (const { h, a } of units) play.push(...pointByPoint(h, a, (s) => [{ type: `${sport}.rally`, payload: { wonBy: idOf(s) } }]));
      return { pre: [], play };
    case "tennis":
      // Each game four straight points to its winner (no deuce from 0); the games of a set alternate like a set's points.
      for (const { h, a } of units) play.push(...pointByPoint(h, a, (s) => Array.from({ length: 4 }, () => ({ type: "tennis.point", payload: { by: idOf(s) } }))));
      return { pre: [], play };
    case "carrom": {
      const coinMax = (CarromBoardSummary.shape.opponentCoinsLeft as unknown as { maxValue: number }).maxValue;
      const ppc = cfg.pointsPerCoin as number;
      const gameTo = cfg.gameTo as number;
      const maxBoards = cfg.maxBoards as number;
      const boards = (s: Side, points: number): StreamEvent[] => {
        if (points % ppc !== 0) throw new SheetUnbuildable(sport, `${points} points is no whole number of coins at ${ppc} a coin`);
        const out: StreamEvent[] = [];
        for (let left = points / ppc; left > 0; left -= Math.min(coinMax, left)) out.push({ type: "carrom.board.summary", payload: { winner: idOf(s), opponentCoinsLeft: Math.min(coinMax, left), queenTo: null } });
        return out;
      };
      for (const { h, a } of units) {
        const finished = h >= gameTo || a >= gameTo;
        // A finished game: the loser's boards first, then the winner's, the winner's last board the one that reaches the
        // target. An unfinished one must leave a board to play, or it would end on the leader (decideGame).
        const won: Side = h >= gameTo ? "home" : "away";
        const game = finished ? [...boards(other(won), won === "home" ? a : h), ...boards(won, won === "home" ? h : a)] : [...boards("home", h), ...boards("away", a)];
        if (finished ? game.length > maxBoards : game.length >= maxBoards) throw new SheetUnbuildable(sport, `${h}-${a} needs ${game.length} boards; the cfg plays ${maxBoards}`);
        play.push(...game);
      }
      return { pre: [], play };
    }
    case "generic":
      for (const { h, a } of units) {
        if (h > 0) play.push({ type: "generic.score", payload: { by: H, points: h } });
        if (a > 0) play.push({ type: "generic.score", payload: { by: A, points: a } });
      }
      return { pre: [], play };
    case "cricket": {
      // The units are each side's innings. The side that has batted batted first (home, unless the sheet shows away
      // batting while home has nothing — then away won the toss and batted); an innings at 0 after every other has not
      // begun. Every innings but the last is closed (all out, the quota used); the last is under way, a wicket and a
      // ball in hand. The engine's all-out is its own declaration (the pad's wickets ceiling, streams/cricket.ts).
      const first: Side = (sheet.home[0] ?? 0) === 0 && (sheet.away[0] ?? 0) > 0 ? "away" : "home";
      const innings: number[] = [];
      for (let i = 0; i < sheet.home.length; i++) for (const s of [first, other(first)]) innings.push((s === "home" ? sheet.home : sheet.away)[i]!);
      while (innings.length > 0 && innings[innings.length - 1] === 0) innings.pop();
      const allOut = declaredAllOut(sportModule("cricket").padSpec?.(cfg));
      const quota = (cfg.ballsPerInnings as number | null) ?? TEST_BALLS;
      innings.forEach((runs, i) => {
        const open = i === innings.length - 1;
        play.push({ type: "cricket.innings.summary", payload: open ? { runs, wickets: Math.min(3, allOut - 1), legalBalls: Math.min(60, quota - 1), partial: true } : { runs, wickets: allOut, legalBalls: quota } });
      });
      return { pre: first === "away" ? [{ type: "cricket.toss", payload: { wonBy: A, elected: "bat" } }] : [], play };
    }
    case "boardgame":
      // A chess game is its result: nothing is played short of it (the reference's sheet is empty).
      if (units.length > 0) throw new SheetUnbuildable(sport, "a chess game has no scoring event short of its result");
      return { pre: [], play };
    default:
      throw new SheetUnbuildable(sport, "no event vocabulary for this sport");
  }
}

// ── One comparison ───────────────────────────────────────────────────────────────────────────────────────────────

/** One forfeited match to fold: the reference's case, the seat at fault, the stream, and the stream before the
 *  forfeit that decides it (which must fold undecided — else the forfeit is not what decided the match). */
interface Item {
  readonly label: string;
  readonly c: CreditCase;
  readonly offender: Offender;
  readonly prefix: readonly StreamEvent[];
  readonly events: readonly StreamEvent[];
}

interface EngineAnswer {
  outcome: MatchOutcome | null;
  winner: Readonly<Record<string, number>>;
  loser: Readonly<Record<string, number>>;
  excluded: readonly string[];
  points: { winner: number; loser: number };
  statsMatch: boolean;
  /** Every metric key the module declares (its table's columns) — the keys `compare` owes a judgement (Loop R M-16). */
  declared: readonly string[];
}

interface Judgement {
  readonly label: string;
  readonly rows: readonly string[];
  readonly mismatches: readonly string[];
  readonly reference: CreditAnswer | string;
  readonly engine: EngineAnswer | string;
}

const forfeit = (by: Offender, reason: CreditCase["reason"]): StreamEvent => ({
  type: "core.forfeit",
  payload: by === "both" ? { by: "both", reason: "walkover" } : { by: idOf(by), reason },
});

/** The rule rows a case is judged by: the sport's credit row (its walkover, or its retirement), the cross-sport rows,
 *  and players' stats — every id one the family cites (asserted below). */
const SPORT_ROW: Readonly<Record<string, string>> = { football: "FB", hockey: "HK", icehockey: "IH", volleyball: "VB", tabletennis: "TT", badminton: "BD", tennis: "TN", cricket: "CK", boardgame: "BG", carrom: "CA", generic: "GN" };
function rowsOf(c: CreditCase): string[] {
  if (c.reason === "double_walkover") return ["X-DW-1", "X-DW-4", "X-PS-1"];
  const p = SPORT_ROW[c.sport] ?? "??";
  const retirement = c.reason === "retired" || c.reason === "disqualified" || (c.reason === "withdrew" && c.played !== undefined);
  // Cricket and chess have no separate retirement row: CK-WO-1 "incl. refusal to continue", BG-WO-1 "or post-start".
  const credit = retirement && p !== "CK" && p !== "BG" ? `${p}-RT-1` : `${p}-WO-1`;
  const cross = c.reason === "withdrew" ? ["X-WD-1"] : retirement ? ["X-RT-1"] : ["X-WO-1"];
  // Ruling 115: a disqualification with nothing played (an empty scoresheet) is treated like a walkover — X-PS-1's.
  const something = c.played !== undefined && (c.played.home.length > 0 || c.played.away.length > 0);
  return [credit, ...cross, c.reason === "retired" || (c.reason === "disqualified" && something) ? "X-PS-2" : "X-PS-1"];
}

/** Loop R M-16: the credit is the same in every table (X-WO-1) — every stage kind the engine declares a table for
 *  (DRAW_KINDS, its own split), not the league alone. The league's answer is the one compared with the reference. */
function tableKindMismatches(
  m: { standingsDelta(o: MatchOutcome, cfg: Cfg, ctx: { kind: StageKind }, state: unknown): readonly StandingsDelta[] },
  o: MatchOutcome,
  cfg: Cfg,
  state: unknown,
  league: readonly StandingsDelta[],
): string[] {
  const shape = (d: readonly StandingsDelta[]) => JSON.stringify(d.map((x) => ({ points: x.points, metrics: x.metrics })));
  const out: string[] = [];
  for (const kind of DRAW_KINDS) {
    if (kind === LEAGUE.kind) continue;
    const other_ = m.standingsDelta(o, cfg, { kind }, state);
    if (shape(other_) !== shape(league)) out.push(`standings (${kind}): ${shape(other_)}, the league's ${shape(league)}`);
  }
  return out;
}

function engineAnswer(item: Item, cfg: Cfg, mismatches: string[]): EngineAnswer | string {
  const m = sportModule(item.c.sport);
  const before = foldStream(m, cfg, H, A, item.prefix);
  if (before.outcome !== null) mismatches.push(`the play before the forfeit already decided the match: ${JSON.stringify(before.outcome)}`);
  const f = foldStream(m, cfg, H, A, item.events);
  const o = f.outcome;
  const want = item.offender === "both"
    ? { kind: "double_walkover" }
    : { kind: "award", winner: idOf(other(item.offender)), loser: idOf(item.offender), reason: item.c.reason };
  if (JSON.stringify(o) !== JSON.stringify(want)) mismatches.push(`outcome: the forfeit should decide it as ${JSON.stringify(want)}, the engine folds ${JSON.stringify(o)}`);
  if (o === null || (o.kind !== "award" && o.kind !== "double_walkover")) return `the engine's fold decides no forfeit: ${JSON.stringify(o)}`;
  const [dh, da] = m.standingsDelta(o, cfg, LEAGUE, f.state) as [StandingsDelta, StandingsDelta];
  mismatches.push(...tableKindMismatches(m, o, cfg, f.state, [dh, da]));
  const winnerSide: Side = item.offender === "both" ? "home" : other(item.offender);
  const [w, l] = winnerSide === "home" ? [dh, da] : [da, dh];
  // A double walkover is the module's walkover by "both" (D9), as its own standingsDelta asks it.
  const reason: AwardReason = item.offender === "both" || item.c.reason === "double_walkover" ? "walkover" : item.c.reason;
  const credit = m.forfeitCredit(cfg, f.state, reason, item.offender) as { excluded: readonly string[] };
  const active = resolveVoids(envelopes("cross-check", item.events));
  const role = forfeitStatsRole(active);
  if (role === null) mismatches.push("players' stats: the engine reads no active forfeit in the ledger (forfeitStatsRole null)");
  const unplayed = m.playerStats?.unplayed !== undefined ? m.playerStats.unplayed(active) : role === "unplayed";
  return { outcome: o, winner: w.metrics, loser: l.metrics, excluded: [...credit.excluded], points: { winner: w.points, loser: l.points }, statsMatch: !unplayed, declared: m.metrics.map((x) => x.key) };
}

function judge(item: Item): Judgement {
  const mismatches: string[] = [];
  const rows = rowsOf(item.c);
  let ref: CreditAnswer;
  try {
    ref = walkoverCredit(item.c);
  } catch (e) {
    if (!(e instanceof CreditRefused)) throw e;
    return { label: item.label, rows, mismatches: [`the reference refused it (${e.reason})`], reference: e.message, engine: "not folded" };
  }
  let cfg: Cfg;
  let eng: EngineAnswer | string;
  try {
    cfg = engineCfgOf(item.c);
    eng = engineAnswer(item, cfg, mismatches);
  } catch (e) {
    // An engine refusal (EngineError from a strict fold, a module guard) is the engine's answer: it disagrees.
    return { label: item.label, rows, mismatches: [`the engine refused it: ${e instanceof Error ? `${e.name} ${e.message}` : String(e)}`], reference: ref, engine: "refused" };
  }
  if (typeof eng === "string") return { label: item.label, rows, mismatches: [...mismatches, eng], reference: ref, engine: eng };
  return { label: item.label, rows, mismatches: [...mismatches, ...compare(ref, eng, cfg, item)], reference: ref, engine: eng };
}

/** The event types the sheet builder writes (sheetEvents) and the forfeit and void around them: a stream of these
 *  records play and its score, never a card, a penalty, a goal's kind or a set piece. */
const SHEET_VOCABULARY = new Set([
  "core.start", "core.forfeit", "core.void", "cricket.toss", "cricket.innings.summary", "football.goal", "football.period",
  "hockey.goal", "hockey.period.advance", "icehockey.goal", "icehockey.period.advance", "volleyball.rally", "tabletennis.rally",
  "badminton.rally", "tennis.point", "carrom.board.summary", "generic.score",
]);

/** Loop R M-16 — a side's own record of an "as-played" column in this stream: what the play recorded, read from the
 *  stream's events (the cross-check built them), never from the module. Points and boards are counted; every other
 *  as-played column (cards, penalty minutes, goal kinds, set pieces, fair play) is a record the sheet's vocabulary
 *  cannot write, so it is 0 — the premise is asserted on the stream, not assumed. */
function playedRecord(item: Item, key: string, side: Side): number | string {
  const active = resolveVoids(envelopes("as-played", item.events)).map((e) => ({ type: e.type, payload: e.payload as Record<string, unknown> }));
  // A goal's only own key is `by` — and hockey's field-goal type (W2d T18: the sheet's goals are `fg`, which moves no
  // pc/stroke column); any other kind is a record this reader does not count.
  const plainGoalKey = (e: { type: string; payload: Record<string, unknown> }, k: string) =>
    k === "by" || (e.type === "hockey.goal" && k === "kind" && e.payload.kind === "fg");
  const foreign = active.filter((e) => !SHEET_VOCABULARY.has(e.type) || (e.type.endsWith(".goal") && Object.keys(e.payload).some((k) => !plainGoalKey(e, k))));
  if (foreign.length > 0) return `the stream records ${JSON.stringify(foreign.map((e) => e.type))}, which this reader does not count`;
  const id = idOf(side);
  const count = (type: string, mine: (p: Record<string, unknown>) => boolean) => active.filter((e) => e.type === type && mine(e.payload)).length;
  if (item.c.sport === "tennis" && key === "points_won") return count("tennis.point", (p) => p.by === id);
  if (item.c.sport === "carrom" && key === "boards_won") return count("carrom.board.summary", (p) => p.winner === id);
  if (item.c.sport === "carrom" && key === "boards_lost") return count("carrom.board.summary", (p) => p.winner === idOf(other(side)));
  return 0;
}

/** The field-by-field comparison of one reference answer with the engine's (the header's five fields), and (Loop R
 *  M-16) every column the module declares under the reference's rule for it — a column the answer leaves out is
 *  judged by that rule, never skipped. */
function compare(ref: CreditAnswer, eng: EngineAnswer, cfg: Cfg, item: Item): string[] {
  const out: string[] = [];
  for (const [side, want, got] of [["winner", ref.winner, eng.winner], ["loser", ref.loser, eng.loser]] as const) {
    for (const [k, v] of Object.entries(want)) if (got[k] !== v) out.push(`${side}.${k}: reference ${v}, engine ${String(got[k])}`);
  }
  const rules = CREDIT_METRIC_RULES[item.c.sport] ?? {};
  const winnerSide: Side = item.offender === "both" ? "home" : other(item.offender);
  for (const k of eng.declared) {
    const rule = rules[k];
    if (rule === undefined) { out.push(`${k}: the reference states no rule for a column the engine declares`); continue; }
    const named = k in ref.winner && k in ref.loser;
    if (rule === "credited") { if (!named) out.push(`${k}: credited by the reference's rule, but its answer names no value`); continue; }
    if (named) continue; // the answer's own value (a double walkover's X-DW-4 zero) was compared above
    for (const [side, seat, got] of [["winner", winnerSide, eng.winner[k]], ["loser", other(winnerSide), eng.loser[k]]] as const) {
      const want = rule === "none" ? 0 : playedRecord(item, k, seat);
      if (typeof want === "string") { out.push(`${side}.${k} (${rule}): ${want}`); continue; }
      // Nothing recorded may be no key at all: the period kernel emits a set piece's three counters only once one was
      // recorded. Absent reads as nothing recorded — never as a value — so it agrees with 0 and with nothing else.
      if (!(got === want || (got === undefined && want === 0))) out.push(`${side}.${k} (${rule}): the stream records ${want}, engine ${String(got)}`);
    }
  }
  for (const k of ref.excluded) if (!eng.excluded.includes(k)) out.push(`excluded: the reference excludes "${k}", the engine's forfeitCredit does not`);
  const pts = forfeitPoints(cfg, ref.points, ref.winner);
  if ("unread" in pts) out.push(`points (${ref.points}): ${pts.unread}`);
  else if (pts.winner !== eng.points.winner || pts.loser !== eng.points.loser) out.push(`points: reference "${ref.points}" = ${pts.winner}/${pts.loser} by the cfg's table, engine ${eng.points.winner}/${eng.points.loser}`);
  if (ref.statsMatch !== eng.statsMatch) out.push(`statsMatch: reference ${ref.statsMatch}, engine ${eng.statsMatch}`);
  return out;
}

interface Sweep { readonly compared: number; readonly agreed: number; readonly disagreements: readonly Judgement[]; readonly sports: ReadonlySet<string> }

function sweep(items: readonly Item[]): Sweep {
  const judged = items.map(judge);
  const disagreements = judged.filter((j) => j.mismatches.length > 0);
  return { compared: judged.length, agreed: judged.length - disagreements.length, disagreements, sports: new Set(items.map((i) => i.c.sport)) };
}

/** Zero compared is a FAILURE; every disagreement fails, printed with both answers and the rows that decide it. */
function expectAgreement(s: Sweep, what: string): void {
  expect(s.compared, `${what}: zero compared is a vacuous green`).toBeGreaterThan(0);
  const report = s.disagreements.map((d) => [
    `● ${d.label}  [rows ${d.rows.join(", ")}]`,
    ...d.mismatches.map((x) => `    - ${x}`),
    `    reference: ${typeof d.reference === "string" ? d.reference : JSON.stringify(d.reference)}`,
    `    engine:    ${typeof d.engine === "string" ? d.engine : JSON.stringify(d.engine)}`,
  ].join("\n")).join("\n");
  expect(s.disagreements.length, `${what}: ${s.disagreements.length} of ${s.compared} disagree\n${report}`).toBe(0);
  expect(s.agreed).toBe(s.compared);
}

// ── The items ────────────────────────────────────────────────────────────────────────────────────────────────────

/** A case as the streams it is folded on. No scoresheet and one side at fault: BOTH seats (the reference's credit is
 *  the same whichever side defaulted — the engine's seat mapping is what that checks). A double walkover: both. A
 *  scoresheet: the side the case names. */
function itemsOf(c: CreditCase, label = c.label ?? `${c.sport} · ${c.reason}`): Item[] {
  if (c.reason === "double_walkover" && c.played === undefined) return [{ label, c, offender: "both", prefix: [], events: [forfeit("both", c.reason)] }];
  if (c.played === undefined) {
    return (["home", "away"] as const).map((seat) => ({ label: `${label} · ${seat} at fault`, c, offender: seat, prefix: [], events: [forfeit(seat, c.reason)] }));
  }
  const offender: Offender = c.reason === "double_walkover" ? "both" : (c.by ?? (() => { throw new Error(`cross-check: ${label} has a scoresheet and names no side at fault`); })());
  const { pre, play } = sheetEvents(c.sport, engineCfgOf(c), c.played);
  const prefix = [...pre, START, ...play];
  return [{ label: offender === "both" ? label : `${label} · ${offender} at fault`, c, offender, prefix, events: [...prefix, forfeit(offender, c.reason)] }];
}

/** Items whose stream could not be built count as failing items, never as skips. */
function itemsOrUnbuildable(cases: readonly CreditCase[]): { items: Item[]; unbuildable: string[] } {
  const items: Item[] = [];
  const unbuildable: string[] = [];
  for (const c of cases) {
    try { items.push(...itemsOf(c)); } catch (e) { if (e instanceof SheetUnbuildable) unbuildable.push(`${c.label}: ${e.message}`); else throw e; }
  }
  return { items, unbuildable };
}

const CASES = enumerateCreditCases();

describe("walkover-credit ↔ the engine (W2b Task 15 Step 3, PF-12): every enumerated case folded through the real sport module", () => {
  it("empty case first: a sweep over no case compares nothing, and that is a failure, not a green", () => {
    const empty = sweep([]);
    expect([empty.compared, empty.agreed, empty.disagreements.length]).toEqual([0, 0, 0]);
    expect(() => expectAgreement(empty, "no case")).toThrow(/zero compared/);
  });

  it("X-RS-1 + X-RT-1 + X-WD-1 + X-PS-1 — ruling 115: an EMPTY scoresheet (play started, nothing scored) — every cfg the family holds, both seats — disqualified and withdrew agree with the engine and neither is a match in players' stats, and retired is refused by both (ruling 113) — but in chess, whose Start is play (ruling 118), the retirement, the disqualification and (ruling 127) the withdrawal agree as a game played", () => {
    const cases: CreditCase[] = [];
    for (const [sport, data] of Object.entries(WALKOVER_CREDIT_DATA)) {
      for (const e of data.cfgs) {
        for (const reason of ["retired", "disqualified", "withdrew"] as const) {
          for (const by of ["home", "away"] as const) cases.push({ sport, cfg: { ...e.cfg }, reason, played: { home: [], away: [] }, by, variant: e.name, label: `${sport} · ${e.name} · ${reason} · empty sheet` });
        }
      }
    }
    const { items, unbuildable } = itemsOrUnbuildable(cases);
    expect(unbuildable).toEqual([]);
    // Every one is START then the forfeit: the empty play folds undecided (each item's own guard, in judge()).
    for (const i of items) expect(i.prefix.filter((e) => e.type !== "core.start"), i.label).toEqual([]);
    // Ruling 113: nobody retires from a match never played. Both sides refuse the retirement, each by its own name: the
    // reference (nothing-played) and the engine's strict fold (FORFEIT_REASON_WRONG_PHASE). Ruling 118: chess's Start
    // is play — read from the ENGINE's declaration here, and the reference's own reading is the agreement below.
    const startIsPlay = (sport: string): boolean => sportModule(sport).startIsPlay === true;
    expect(Object.keys(WALKOVER_CREDIT_DATA).filter(startIsPlay), "ruling 118 names chess").toEqual(["boardgame"]);
    const refusedHere = (x: (typeof items)[number]): boolean => x.c.reason === "retired" && !startIsPlay(x.c.sport);
    let bothRefused = 0;
    for (const i of items.filter(refusedHere)) {
      let refusal: unknown = null;
      try { walkoverCredit(i.c); } catch (e) { refusal = e instanceof CreditRefused ? e.reason : e; }
      expect(refusal, `${i.label}: the reference`).toBe("nothing-played");
      let code: unknown = null;
      try { engineAnswer(i, engineCfgOf(i.c), []); } catch (e) { code = (e as { code?: unknown }).code; }
      expect(code, `${i.label}: the engine`).toBe("FORFEIT_REASON_WRONG_PHASE");
      bothRefused++;
    }
    expect(bothRefused).toBe(40 * 2); // 44 cfg entries less chess's 4, × 2 seats
    const s = sweep(items.filter((x) => !refusedHere(x)));
    // The counts first, so a red sweep still says how much it compared.
    expect(s.compared).toBe(44 * 2 * 2 + 4 * 2); // 44 cfg entries (41 declared + 3 named extras) × 2 reasons × 2 seats, and chess's 4 retirements × 2 seats
    expect(s.sports.size).toBe(11);
    expectAgreement(s, "the empty scoresheet");
    // Ruling 115 (X-PS-1): nothing played, so neither side counts a match in players' stats — the disqualification as
    // the withdrawal. Ruling 118 (X-PS-2): in chess the Start is play, so its retirement and disqualification ARE a game
    // played; ruling 127 (amends X-PS-1): so is its withdrawal. Asserted on both answers, not only on their agreement.
    const counts = { notAMatch: 0, chessGame: 0 };
    for (const i of items.filter((x) => !refusedHere(x))) {
      const want = startIsPlay(i.c.sport);
      expect(walkoverCredit(i.c).statsMatch, `${i.label}: the reference`).toBe(want);
      const eng = engineAnswer(i, engineCfgOf(i.c), []);
      expect(typeof eng === "string" ? eng : eng.statsMatch, `${i.label}: the engine`).toBe(want);
      counts[want ? "chessGame" : "notAMatch"]++;
    }
    expect(counts).toEqual({ notAMatch: (44 - 4) * 2 * 2, chessGame: 4 * 3 * 2 }); // chess: retired, disqualified, withdrew × 2 seats
  });

  it("X-WO-1, X-RT-1, X-WD-1, X-DW-1, X-DW-4, X-PS-1, X-PS-2 and every sport's WO/RT row: all 212 enumerated cases agree with the engine — the credited metrics, the excluded keys, the table points and players' stats; a case with no scoresheet both seats", () => {
    // the family's own count (walkover-credit.test.ts): 55 base + 158 variants, less the one retirement ruling 113
    // refuses (generic's untouched win/loss tally; chess's empty sheet is its Start, which is play — ruling 118). R112
    // fix round 2 (m3): generic's win/loss tally scenario (GN-RT-1 keeps it) adds three cases with a scoresheet.
    expect(CASES.length).toBe(212);
    const { items, unbuildable } = itemsOrUnbuildable(CASES);
    expect(unbuildable, "a scoresheet the cross-check could not rebuild as events is a failing item").toEqual([]);
    const s = sweep(items);
    // The counts first, so a red sweep still says how much it compared. One comparison per case, two where a single
    // forfeit has no scoresheet (both seats): counted from the enumeration.
    const owed = CASES.reduce((n, c) => n + (c.played === undefined && c.reason !== "double_walkover" ? 2 : 1), 0);
    expect(s.compared).toBe(owed);
    expect(owed).toBe(300); // 88 sheetless single forfeits × 2 + 44 double walkovers + 80 with a scoresheet
    expect(s.sports.size).toBe(11);
    // Every reason is reached where X-RS-1 records it: a walkover and a double walkover before the start, retired and
    // disqualified after it, withdrew either side of it (PF-7).
    const reached = new Set(items.map((i) => `${i.c.reason}${i.c.played === undefined ? "" : " · started"}`));
    expect([...reached].sort()).toEqual(["disqualified · started", "double_walkover", "retired · started", "walkover", "withdrew", "withdrew · started"]);
    expectAgreement(s, "the enumerated cases");
  });

  it("the recipe: the reference answers each case the same from the engine's declared cfg (parsed, unmodified; a named extra built as its source says) as from its own data — every enumerated case", () => {
    let same = 0;
    const differ: string[] = [];
    for (const c of CASES) {
      const fromData = walkoverCredit(c);
      const fromEngine = walkoverCredit({ ...c, cfg: { ...engineCfgOf(c) } });
      if (JSON.stringify(fromEngine) === JSON.stringify(fromData)) same++;
      else differ.push(`${c.label}: data ${JSON.stringify(fromData)}, engine cfg ${JSON.stringify(fromEngine)}`);
    }
    expect(differ).toEqual([]);
    expect(same).toBe(CASES.length);
    expect(same).toBeGreaterThan(0);
  });

  it("sequence: a voided forfeit leaves nothing decided, and the forfeit recorded after it is the one credited — before the start (walkover voided, withdrew) and after it (retired voided, disqualified) — every sport", () => {
    const items: Item[] = [];
    for (const [sport, data] of Object.entries(WALKOVER_CREDIT_DATA)) {
      const e = data.cfgs[0]!;
      // Before the start: A's walkover is voided (seq 1), then H withdraws.
      const pre: CreditCase = { sport, cfg: { ...e.cfg }, reason: "withdrew", variant: e.name };
      const voidedPre = [forfeit("away", "walkover"), { type: "core.void", payload: { event_id: "1" } }];
      items.push({ label: `${sport} · ${e.name} · walkover (A) voided, then withdrew (H)`, c: pre, offender: "home", prefix: voidedPre, events: [...voidedPre, forfeit("home", "withdrew")] });
      // After the start: the side at fault's retirement is voided, then it is disqualified. Where the sheet holds no
      // play (chess's game is no unit) nobody can retire (ruling 113): the voided forfeit is a disqualification there.
      const p = data.played[0]!;
      const voidedReason = p.home.length > 0 || p.away.length > 0 ? "retired" : "disqualified";
      const by = p.by ?? "away";
      const cfg = data.cfgs.find((x) => x.name === p.cfg)!;
      const after: CreditCase = { sport, cfg: { ...cfg.cfg }, reason: "disqualified", played: { home: [...p.home], away: [...p.away] }, by, variant: p.cfg };
      const built = sheetEvents(sport, engineCfgOf(after), after.played!);
      const played = [...built.pre, START, ...built.play];
      const voidedAfter = [...played, forfeit(by, voidedReason), { type: "core.void", payload: { event_id: String(played.length + 1) } }];
      items.push({ label: `${sport} · ${p.cfg} · ${voidedReason} voided, then disqualified · ${p.name}`, c: after, offender: by, prefix: voidedAfter, events: [...voidedAfter, forfeit(by, "disqualified")] });
    }
    const s = sweep(items);
    expect(s.compared).toBe(22);
    expect(s.sports.size).toBe(11);
    expectAgreement(s, "the void sequence");
  });

  it("every rule row a comparison is reported under is one the family cites — every enumerated case", () => {
    let checked = 0;
    for (const c of CASES) {
      for (const id of rowsOf(c)) { expect(walkoverCreditFamily.rows, `${c.label}: ${id}`).toContain(id); checked++; }
    }
    expect(checked).toBeGreaterThan(CASES.length * 2);
  });

  it("tripwire: walkover-credit is the reference's only case enumerator — bracket-finish has none to fold (its consumer is the harness's judgeDrive, reference-bracket.test.ts); a new one owes a cross-check here", () => {
    const { found, called } = caseEnumerators(reference as unknown as Record<string, unknown>);
    expect(found).toEqual(["enumerateCreditCases"]);
    // not vacuous: the shape reading called at least the one zero-argument export it found
    expect(called).toBeGreaterThanOrEqual(1);
  });

  it("tripwire's own reader: an enumerator is caught by its name OR by its shape, whatever it is called — and a non-case function is not", () => {
    const synthetic: Record<string, unknown> = {
      listCases: () => [{ sport: "football" }], // shape only: a zero-argument function returning case objects
      enumerateLater: (_sport: string) => [], // name only: an enumerator that needs an input
      family: { cases: () => [{ id: 1 }], expect: (_c: unknown) => 0 }, // a family's zero-argument method
      families: [{ more: () => [{ id: 2 }] }], // inside an exported array of families
      labels: () => ["a", "b"], // strings, not cases
      none: () => [], // empty: nothing enumerated
      Refusal: class {}, // a class is never called
      DATA: [{ sport: "football" }], // data, not a function
    };
    const { found, called } = caseEnumerators(synthetic);
    expect(found).toEqual(["enumerateLater", "families[0].more", "family.cases", "listCases"]);
    expect(called, "listCases, labels, none, family.cases, families[0].more").toBe(5);
  });
});

describe("Loop R M-16: every column a sport's table declares is judged under a rule the reference states", () => {
  it("full key coverage: each sport's rule set is exactly the columns its module declares — none missing, none stale", () => {
    let columns = 0;
    const missing: string[] = [];
    const stale: string[] = [];
    for (const sport of CREDIT_SPORTS) {
      const declared = sportModule(sport).metrics.map((x) => x.key);
      const rules = CREDIT_METRIC_RULES[sport] ?? {};
      for (const k of declared) if (rules[k] === undefined) missing.push(`${sport}.${k}`);
      for (const k of Object.keys(rules)) if (!declared.includes(k)) stale.push(`${sport}.${k}`);
      columns += declared.length;
    }
    expect([missing, stale], "a column with no rule / a rule for no column").toEqual([[], []]);
    expect(Object.keys(CREDIT_METRIC_RULES).sort(), "a rule set for every credited sport").toEqual([...CREDIT_SPORTS].sort());
    // Counted from the engine's declarations (11 sports' metrics), never from the rules under test.
    expect(columns).toBe(CREDIT_SPORTS.reduce((n, sport) => n + sportModule(sport).metrics.length, 0));
    expect(columns, "columns covered").toBeGreaterThan(CREDIT_SPORTS.length * 3);
  });

  it("every enumerated item judges every declared column: the credited ones on the answer, the rest by their rule — and all three rules are reached", () => {
    const { items } = itemsOrUnbuildable(CASES);
    const judged = { credited: 0, "as-played": 0, none: 0 };
    let owed = 0;
    for (const item of items) {
      const declared = sportModule(item.c.sport).metrics.map((x) => x.key);
      owed += declared.length;
      for (const k of declared) {
        const rule = CREDIT_METRIC_RULES[item.c.sport]?.[k];
        if (rule !== undefined) judged[rule]++;
      }
    }
    expect(judged.credited + judged["as-played"] + judged.none, "every column of every item has a rule").toBe(owed);
    expect(owed, "columns over the 300 items").toBeGreaterThan(300 * 3);
    expect(judged["as-played"], "as-played columns reached").toBeGreaterThan(0);
    expect(judged.none, "none columns reached").toBeGreaterThan(0);
    // The as-played reader counts real play somewhere (a carrom board, a tennis point), not only zeros.
    const counted = items.filter((i) => i.c.played !== undefined && (i.c.sport === "tennis" || i.c.sport === "carrom"))
      .filter((i) => [playedRecord(i, i.c.sport === "tennis" ? "points_won" : "boards_won", "home"), playedRecord(i, i.c.sport === "tennis" ? "points_won" : "boards_won", "away")].some((n) => typeof n === "number" && n > 0));
    expect(counted.length, "items whose as-played record is counted from real play").toBeGreaterThan(0);
  });

  it("negative: a column with no rule, an as-played column the engine credits, a table kind that reads the forfeit differently, and a stream the as-played reader cannot count each red on that column", () => {
    // single-sport: a carrom retirement carries every rule's shape — credited games, as-played boards from real play.
    const c = CASES.find((x) => x.sport === "carrom" && x.reason === "retired");
    expect(c, "the enumeration holds a carrom retirement").toBeDefined();
    const [item] = itemsOf(c!);
    const cfg = engineCfgOf(c!);
    const eng = engineAnswer(item!, cfg, []);
    if (typeof eng === "string") throw new Error(eng);
    const real = walkoverCredit(c!);
    expect(compare(real, eng, cfg, item!), "the unmoved answer agrees").toEqual([]);
    expect(eng.winner.boards_won, "premise: boards were played").toBeGreaterThan(0);
    expect(compare(real, { ...eng, declared: [...eng.declared, "boards_drawn"] }, cfg, item!)).toEqual(["boards_drawn: the reference states no rule for a column the engine declares"]);
    expect(compare(real, { ...eng, winner: { ...eng.winner, boards_won: eng.winner.boards_won! + 1 } }, cfg, item!)).toEqual([
      `winner.boards_won (as-played): the stream records ${eng.winner.boards_won}, engine ${eng.winner.boards_won! + 1}`,
    ]);
    // A module whose swiss table reads the forfeit differently from its league: the sweep over the table kinds names it.
    const m = sportModule("carrom");
    const f = foldStream(m, cfg, H, A, item!.events);
    const league = m.standingsDelta(f.outcome!, cfg, LEAGUE, f.state);
    const skewed = { standingsDelta: (o: MatchOutcome, c: Cfg, ctx: { kind: StageKind }, st: unknown) => m.standingsDelta(o, c, ctx, st as never).map((d) => (ctx.kind === "swiss" ? { ...d, points: d.points + 1 } : d)) };
    expect(tableKindMismatches(m as never, f.outcome!, cfg, f.state, league), "the real module: every table alike").toEqual([]);
    expect(tableKindMismatches(skewed, f.outcome!, cfg, f.state, league).map((x) => x.split(":")[0])).toEqual(["standings (swiss)"]);
    const carded = { ...item!, events: [...item!.events.slice(0, -1), { type: "carrom.foul", payload: { by: H } }, item!.events.at(-1)!] };
    expect(compare(real, eng, cfg, carded).every((x) => x.includes("which this reader does not count")), "the unreadable stream").toBe(true);
    expect(compare(real, eng, cfg, carded).length).toBe(2 * 2); // boards_won and boards_lost, both sides
  });
});

describe("the cross-check's own reading of the engine is not vacuous", () => {
  it("each sport's stream builder reaches the engine: every enumerated scoresheet folds with its play applied (more events than START), except where the sheet holds no score", () => {
    let withPlay = 0;
    let bare = 0;
    for (const c of CASES) {
      if (c.played === undefined) continue;
      const scored = [...c.played.home, ...c.played.away].some((n) => n > 0);
      const { play } = sheetEvents(c.sport, engineCfgOf(c), c.played);
      if (scored) { expect(play.length, `${c.label}`).toBeGreaterThan(0); withPlay++; } else { expect(play, `${c.label}`).toEqual([]); bare++; }
    }
    expect(withPlay).toBeGreaterThan(0);
    expect(withPlay + bare).toBe(80);
  });

  it("negative: a reference answer moved off the real engine's on ONE field reds on exactly that field — a credit, a loser's credit, an exclusion, the points, players' stats; and a stream at the wrong seat reds on the outcome", () => {
    // A tennis retirement: straight sets, games excluded (TN-RT-1) — every field carries a value to move.
    const c = CASES.find((x) => x.sport === "tennis" && x.reason === "retired");
    expect(c, "the enumeration holds a tennis retirement").toBeDefined();
    const [item] = itemsOf(c!);
    const cfg = engineCfgOf(c!);
    const mismatches: string[] = [];
    const eng = engineAnswer(item!, cfg, mismatches);
    expect(mismatches).toEqual([]);
    if (typeof eng === "string") throw new Error(eng);
    const real = walkoverCredit(c!);
    expect(compare(real, eng, cfg, item!), "the unmoved answer agrees").toEqual([]);
    const moved: readonly [string, CreditAnswer, RegExp][] = [
      ["a winner's credit", { ...real, winner: { ...real.winner, sets_won: (real.winner.sets_won ?? 0) + 1 } }, /^winner\.sets_won: reference \d+, engine \d+$/],
      ["a loser's credit", { ...real, loser: { ...real.loser, games_lost: 1 } }, /^loser\.games_lost: reference 1, engine 0$/],
      ["an exclusion", { ...real, excluded: [...real.excluded, "sets_won"] }, /^excluded: the reference excludes "sets_won"/],
      ["the points", { ...real, points: "zero" }, /^points: reference "zero" = 0\/0/],
      ["players' stats", { ...real, statsMatch: !real.statsMatch }, /^statsMatch: reference false, engine true$/],
    ];
    let reds = 0;
    for (const [what, answer, why] of moved) {
      const got = compare(answer, eng, cfg, item!);
      expect(got, what).toHaveLength(1);
      expect(got[0], what).toMatch(why);
      reds++;
    }
    expect(reds).toBe(moved.length);
    // The same stream judged as if the OTHER side were at fault: the forfeit names the real one, so the outcome reds.
    const flipped = judge({ ...item!, offender: item!.offender === "home" ? "away" : "home" });
    expect(flipped.mismatches.some((m) => m.startsWith("outcome:")), JSON.stringify(flipped.mismatches)).toBe(true);
  });
});
