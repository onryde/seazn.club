// buildQualificationView — the ONE builder behind every standings surface
// (division page, embed, organiser console, competition hub; plan P3, spec
// 2026-09-22 §4). It derives the engine's input from what a surface already
// holds and returns null whenever a status could be wrong (R3).
//
// Conventions (W1/W2): the no-status cases come FIRST, and every one ships with
// its positive pair — a table that differs only in the guarded fact and DOES
// carry a view — so a guard that suppresses everything cannot pass. Bounds come
// from the generic module's own declaration, never a typed table, and statuses
// are cross-checked against the engine function on the input the builder
// derives. Wording is pinned as the English sentence a reader sees (plus one
// Spanish case), because `t()` returns the KEY on a miss and a key-shaped
// assertion would pass against a missing dictionary entry.
//
// Ledgers: public fixtures carry no ledger, so the builder reads goals only
// through the snapshot rows. Each what-if scene sets exactly the row metrics
// its branch needs; the fixtures around them keep who-played-whom honest.
//
// Mutation record (Task 5; 62 mutants, each red here unless noted):
//   guards — rank override, cascade[0], overall cut on a pool, kind, cut/next
//   null, Swiss rounds null/0, malformed PointsRule → sport bounds, no bounds
//   → a guessed bound, RF3 off / on Swiss too / on settled too, F1 never / F1
//   literal (any expunge) / unknown status read as active / policy across
//   stages, F2 off, F3 off / all rows / `>`, lag off / `!==` / bye uncounted /
//   void counted, anyPlayed on any settled, complete=false, pool filter off,
//   stage filter off, no rank sort, league remaining counts played.
//   remaining — Swiss counts seated (P2 test), `forfeited`→scheduled in the
//   shared status map (bye/lag/RF3/average tests), withdrawn read as active.
//   what-if — winsOnly without the table relation / from the sport not the
//   rule, loss scenario for any k, win scenario for any needs_help, m=0 as
//   "win by 0", loss m=0 as a target, loss of any sign, own-opponent check
//   off, safe before it, safe unlabelled, average with byes / walkovers /
//   no-results, "Now:" with one side missing, never "Now:", T2-C1 off (if you
//   lose / scenario / latest seat), what-if on closed rows, if-you-lose
//   labelled with the current status, rounds left over departed rows, no
//   cutNoRounds, aria from position, headline `{n}`.
//   Review fix rounds 1–2 — the one-match gate deleted / `>= 1` / `=== 2` /
//   placed after `safe`; rival read over departed rows; the round-1 seat of a
//   departed, never-folded member restored (a frozen 0 in place of fail-closed
//   F2) / restored for any departed member whatever its results.
//   Final review I1 — a departed row frozen again, in the engine
//   (`remainingOf` → 0 when inactive: M7, both I1 loss cases, Swiss) or in the
//   builder (departed remaining → 0: the same four); a departed Swiss row read
//   through the rounds formula (the Swiss I1 case).
//   Final review COPY — the cut key pluralised on the rounds left (the bug),
//   the Out headline on a fixed `other`, the rounds count joined at 0, the
//   rounds key pluralised on the cut. Final review M4a — tieDecidingKey asked
//   with winsOnly false (the wins-only scored-rule scene).
//   EQUIVALENT (unkillable, kept as the readable empty case): `qualifyCount
//   < 1` (the engine refuses cut < 1 itself) and `rows.length === 0` (F3
//   refuses it: a cut ≥ 0 active rows). The gate made `k === 1` in the loss
//   scenario redundant (k ≤ matches left), so it went. The DB-backed twin
//   (qualification-view-db.test.ts) kills F1, F2 (both directions, incl. the
//   seat restored), lag-void, Swiss-seated, pool-filter, the forfeited mapping
//   and the ledgerless reading of a real walkover on real reads too.
import { describe, expect, it } from "vitest";
import { foldMatchWithStoppage, outcomeOf, type EventEnvelope } from "@seazn/engine/core";
import { defaultLineupPair, defaultOrderOf, makeEnvelope } from "@seazn/engine/testkit";
import {
  PointsRule,
  pointsRuleBounds,
  qualificationStatus,
  type StandingsRow,
} from "@seazn/engine/competition";
import { builtinModules } from "@seazn/engine/sports";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";
import { plural, t, type TKey } from "@/lib/i18n-runtime";
import {
  EVERY_OUTCOME,
  boundsInForce,
  buildQualificationView,
  divisionAwardAddsToLedger,
  divisionPointsBounds,
  ifYouLoseSentence,
  stageQualMeta,
  type QualFixture,
  type QualificationView,
  type QualificationViewInput,
  type StageQualMeta,
} from "../qualification-view";
import { LEDGER_RULE_MSG_KEYS, tieBreakRule } from "../standings-view";

const moduleOf = (key: string) => {
  const m = builtinModules.find((x) => x.key === key);
  if (!m) throw new Error(`no module ${key}`);
  return m;
};
const GENERIC = moduleOf("generic");
const BADMINTON = moduleOf("badminton");
const ICEHOCKEY = moduleOf("icehockey");
const FOOTBALL = moduleOf("football");
const CFG = { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false };
const BOUNDS = divisionPointsBounds(GENERIC, CFG)!;
const W = BOUNDS.winFloor;
/** The generic module's own cascade: `diff` decides a tie on points. */
const CASCADE = [...defaultOrderOf(GENERIC)];
const NAMES: Record<string, string> = { A: "Ada", B: "Bo", C: "Cy", D: "Di", E: "Ed" };

type Dict = typeof en;
type Metrics = Record<string, number>;

/** A snapshot row. `goals` sets for/against and derives diff so the two cannot
 *  disagree; `extra` overrides anything (points, metrics). */
function row(
  id: string,
  rank: number,
  won: number,
  played: number,
  goals: [number, number] = [won, played - won],
  extra: Partial<StandingsRow> & { metrics?: Metrics } = {},
): StandingsRow {
  const [gf, ga] = goals;
  return {
    entrantId: id,
    rank,
    played,
    won,
    drawn: 0,
    lost: played - won,
    points: won * W,
    ...extra,
    metrics: { for: gf, against: ga, diff: gf - ga, ...(extra.metrics ?? {}) },
  };
}

let fxSeq = 0;
function fx(
  round: number,
  home: string | null,
  away: string | null,
  status: string,
  outcome: unknown,
  over: Partial<QualFixture> = {},
): QualFixture {
  return {
    id: `f${++fxSeq}`,
    stage_id: "S",
    pool_id: null,
    round_no: round,
    status,
    home_entrant_id: home,
    away_entrant_id: away,
    outcome,
    // W2c X-PT-1: these fixtures hold no ledger — nothing was played before a forfeit unless a case says so.
    played: false,
    ...over,
  };
}
const won = (round: number, winner: string, loser: string, over: Partial<QualFixture> = {}) =>
  fx(round, winner, loser, "decided", { kind: "win", winner, loser }, over);
const open = (round: number, home: string | null, away: string | null, over: Partial<QualFixture> = {}) =>
  fx(round, home, away, "scheduled", null, over);
/** A Swiss sit-out as `seatSwissRound` writes it: settled at creation. */
const bye = (round: number, id: string) => fx(round, id, null, "forfeited", { kind: "award", winner: id });
/** A real two-sided walkover (core.forfeit): an award with both seats, as W2b stores it (`reason`, `loser`). */
const walkover = (round: number, winner: string, loser: string) =>
  fx(round, winner, loser, "forfeited", { kind: "award", winner, loser, reason: "walkover" });
/** W2c X-PT-1: a withdrawal (core.forfeit `withdrew`) with its ledger's played fact. */
const withdrew = (round: number, winner: string, loser: string, played: boolean) =>
  fx(round, winner, loser, "forfeited", { kind: "award", winner, loser, reason: "withdrew" }, { played });
const voided = (f: QualFixture): QualFixture => ({ ...f, status: "cancelled", outcome: null });

interface Scene {
  kind: string;
  rows: StandingsRow[];
  fixtures: QualFixture[];
  meta?: Partial<StageQualMeta>;
  poolId?: string | null;
  statuses?: Record<string, string>;
}

const META: StageQualMeta = {
  qualifyCount: 2,
  qualifyPerGroup: false,
  nextStageName: "Finals",
  swissRounds: null,
  pointsRule: null,
  hasRankOverrides: false,
  tablePointsRule: null,
};

const LOCALES = new Map<Dict, "en" | "es" | "fr" | "nl">([
  [en, "en"],
  [es as Dict, "es"],
  [fr as Dict, "fr"],
  [nl as Dict, "nl"],
]);

/** Every key the builder asked for, across every test — the coverage test
 *  at the bottom checks each one exists (t() returns the key on a miss). */
const REQUESTED = new Set<string>();

function input(scene: Scene, over: Partial<QualificationViewInput> = {}, dict: Dict = en): QualificationViewInput {
  const ids = new Set(scene.rows.map((r) => r.entrantId));
  for (const f of scene.fixtures) {
    if (f.home_entrant_id) ids.add(f.home_entrant_id);
    if (f.away_entrant_id) ids.add(f.away_entrant_id);
  }
  const locale = LOCALES.get(dict) ?? "en";
  return {
    stage: {
      id: "S",
      kind: scene.kind,
      // An unpinned stage unless the scene says otherwise: its table is paid by its own rule (V472 `table_points_rule`
      // = the pin, else the own rule), so a scene that sets only `pointsRule` gets it for both.
      meta: {
        ...META,
        ...(scene.kind === "swiss" ? { swissRounds: 3 } : {}),
        ...scene.meta,
        tablePointsRule: scene.meta && "tablePointsRule" in scene.meta ? scene.meta.tablePointsRule : (scene.meta?.pointsRule ?? null),
      },
    },
    poolId: scene.poolId ?? null,
    rows: scene.rows,
    fixtures: scene.fixtures,
    entrantStatuses: { ...Object.fromEntries([...ids].map((id) => [id, "confirmed"])), ...scene.statuses },
    bounds: BOUNDS,
    // The generic module declares no forfeit score: an award adds no goals.
    awardAddsToLedger: divisionAwardAddsToLedger(GENERIC, CFG),
    cascade: CASCADE,
    entrantNames: NAMES,
    msg: (k: TKey, v?: Record<string, string | number>) => {
      REQUESTED.add(k);
      return t(dict, k, v);
    },
    plural: (k: string, n: number, v?: Record<string, string | number>) => {
      REQUESTED.add(`${k}.one`);
      REQUESTED.add(`${k}.other`);
      return plural(dict, k, n, locale, v);
    },
    ...over,
  };
}
const view = (scene: Scene, over: Partial<QualificationViewInput> = {}, dict: Dict = en) =>
  buildQualificationView(input(scene, over, dict));
const must = (v: QualificationView | null): QualificationView => {
  expect(v).not.toBeNull();
  return v!;
};

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

/** Swiss of four, three rounds, two played (the brief's scene): A 2W, B 1W,
 *  C 1W, D 0. Round 3's two boards are unseated shells. Engine (cut 2, one
 *  round each): A win_k1 (lose → needs_help, rival C); B needs_help (rival C);
 *  C needs_help (rival B); D needs_help (lose → OUT, rival B). */
function swiss4(): Scene {
  return {
    kind: "swiss",
    rows: [row("A", 1, 2, 2, [4, 0]), row("B", 2, 1, 2, [2, 2]), row("C", 3, 1, 2, [1, 2]), row("D", 4, 0, 2, [0, 3])],
    fixtures: [won(1, "A", "D"), won(1, "B", "C"), won(2, "A", "B"), won(2, "C", "D"), open(3, null, null), open(3, null, null)],
  };
}

/** Swiss of five, three rounds, byes in rounds 1 (C) and 2 (D): A 6, E 6,
 *  C 3, D 3, B 0. D's one real match was a 2–3 loss to E. */
function swiss5(): Scene {
  return {
    kind: "swiss",
    rows: [
      row("A", 1, 2, 2, [2, 0]),
      row("E", 2, 2, 2, [4, 2]),
      row("C", 3, 1, 2, [0, 1]),
      row("D", 4, 1, 2, [2, 3]),
      row("B", 5, 0, 2, [0, 3]),
    ],
    fixtures: [
      won(1, "A", "B"),
      won(1, "E", "D"),
      bye(1, "C"),
      won(2, "A", "C"),
      won(2, "E", "B"),
      bye(2, "D"),
      open(3, null, null),
      open(3, null, null),
      open(3, null, null),
    ],
  };
}

/** League of four, two rounds played: r1 A>D, C>B; r2 A>C, B>D; r3 A–B and
 *  C–D to play. A 6, B 3, C 3, D 0 — the swiss4 statuses, but every row's
 *  next opponent is known, and D's (C) is not its rival (B). `m` sets row
 *  metrics per what-if branch. */
function open4(m: Partial<Record<"A" | "B" | "C" | "D", [number, number]>> = {}, pending: [string, string][] = [["A", "B"], ["C", "D"]]): Scene {
  return {
    kind: "league",
    rows: [
      row("A", 1, 2, 2, m.A ?? [2, 0]),
      row("B", 2, 1, 2, m.B ?? [1, 1]),
      row("C", 3, 1, 2, m.C ?? [1, 1]),
      row("D", 4, 0, 2, m.D ?? [0, 2]),
    ],
    fixtures: [won(1, "A", "D"), won(1, "C", "B"), won(2, "A", "C"), won(2, "B", "D"), ...pending.map(([h, a]) => open(3, h, a))],
  };
}

/** Single round robin of four: r1 A>C, B>D; r2 A>D, B>C; r3 A–B, C–D.
 *  `played` rounds are decided, the rest scheduled. */
function rr4(played: 1 | 2): Scene {
  const r1 = [won(1, "A", "C"), won(1, "B", "D")];
  const r2 = played >= 2 ? [won(2, "A", "D"), won(2, "B", "C")] : [open(2, "A", "D"), open(2, "B", "C")];
  const w = (id: string) => (played === 1 ? (id === "A" || id === "B" ? 1 : 0) : id === "A" || id === "B" ? 2 : 0);
  return {
    kind: "league",
    meta: { qualifyCount: 1 },
    rows: ["A", "B", "C", "D"].map((id, i) => row(id, i + 1, w(id), played)),
    fixtures: [...r1, ...r2, open(3, "A", "B"), open(3, "C", "D")],
  };
}

/** League of four, cut 1, five rounds settled and round 6 to play: A
 *  (15) is Through, D (3) Out — both N = 1 statuses in one table. */
function settledCut1(): Scene {
  return {
    kind: "league",
    meta: { qualifyCount: 1 },
    rows: [row("A", 1, 5, 5), row("B", 2, 2, 5), row("C", 3, 2, 5), row("D", 4, 1, 5)],
    fixtures: [
      won(1, "A", "C"), won(1, "B", "D"), won(2, "A", "D"), won(2, "B", "C"), won(3, "A", "B"), won(3, "C", "D"),
      won(4, "A", "C"), won(4, "D", "B"), won(5, "A", "D"), won(5, "C", "B"), open(6, "A", "B"), open(6, "C", "D"),
    ],
  };
}

/** The reviewer's probe (fix round 1): league of four after three rounds —
 *  r1 A>B, C>D; r2 A>C, B>D; r3 A>D, B>C; r4 A–B, C–D open, and with
 *  `left` 2 also r5 A–D, B–C. A 9 (+3), B 6 (+1), C 3 (+1), D 0 (−5). */
function after3(left: 1 | 2, m: Partial<Record<"A" | "B" | "C" | "D", [number, number]>> = {}): Scene {
  return {
    kind: "league",
    rows: [
      row("A", 1, 3, 3, m.A ?? [5, 2]),
      row("B", 2, 2, 3, m.B ?? [4, 3]),
      row("C", 3, 1, 3, m.C ?? [4, 3]),
      row("D", 4, 0, 3, m.D ?? [1, 6]),
    ],
    fixtures: [
      won(1, "A", "B"), won(1, "C", "D"), won(2, "A", "C"), won(2, "B", "D"), won(3, "A", "D"), won(3, "B", "C"),
      open(4, "A", "B"), open(4, "C", "D"),
      ...(left === 2 ? [open(5, "A", "D"), open(5, "B", "C")] : []),
    ],
  };
}

// ---------------------------------------------------------------------------
describe("stageQualMeta / divisionPointsBounds", () => {
  it("maps the V414 columns and V472's table_points_rule, defaulting a null per-group flag to false; the two rules never cross", () => {
    expect(
      stageQualMeta({
        qualify_count: 4,
        qualify_per_group: null,
        next_stage_name: "Cup",
        swiss_rounds: 5,
        points_rule: undefined,
        has_rank_overrides: true,
        table_points_rule: undefined,
      }),
    ).toEqual({ qualifyCount: 4, qualifyPerGroup: false, nextStageName: "Cup", swissRounds: 5, pointsRule: null, hasRankOverrides: true, tablePointsRule: null });
    expect(
      stageQualMeta({
        qualify_count: null,
        qualify_per_group: true,
        next_stage_name: null,
        swiss_rounds: null,
        points_rule: { base: {} },
        has_rank_overrides: false,
        table_points_rule: { win: { regulation: 2 } },
      }),
    ).toEqual({ qualifyCount: null, qualifyPerGroup: true, nextStageName: null, swissRounds: null, pointsRule: { base: {} }, hasRankOverrides: false, tablePointsRule: { win: { regulation: 2 } } });
  });
  it("W2d PF-3: the per-match bounds read the rule the TABLE is paid by (a started stage's pin), never the stage's own rule", () => {
    // A pinned stage with no rule of its own: the pin's bounds, not the sport's.
    const pin = { win: { regulation: 4 }, draw: 2, loss: { regulation: 1 }, shootoutAs: "result", unit: "whole" };
    const pinBounds = pointsRuleBounds(PointsRule.parse(pin), EVERY_OUTCOME);
    expect(pinBounds, "premise: the pin's bounds are not the sport's").not.toEqual(BOUNDS);
    expect(boundsInForce({ ...META, pointsRule: null, tablePointsRule: pin }, BOUNDS)).toEqual(pinBounds);
    // An own rule the table is NOT paid by (no table rule): the sport's bounds, whatever the own rule says.
    expect(boundsInForce({ ...META, pointsRule: pin, tablePointsRule: null }, BOUNDS)).toEqual(BOUNDS);
    // An unparsable table rule gives none, never the sport's instead.
    expect(boundsInForce({ ...META, pointsRule: null, tablePointsRule: { win: "three" } }, BOUNDS)).toBeNull();
  });
  it("bounds come from the module's own declaration; no module or an unparsable cfg gives none", () => {
    expect(BOUNDS).toEqual(GENERIC.matchPointsBounds(GENERIC.configSchema.parse(CFG)));
    expect(divisionPointsBounds(null, CFG)).toBeNull();
    expect(divisionPointsBounds(undefined, CFG)).toBeNull();
    expect(divisionPointsBounds(GENERIC, { resultMode: "nonsense" })).toBeNull();
  });
  it("divisionAwardAddsToLedger: exactly the modules whose walkover CREDITS the table (the engine's forfeitCredit, ruling 108)", () => {
    // W2b Task 13 (X-WO-1): the question is the engine's own — what does a walkover credit this sport's table
    // (`forfeitCredit`, the hook `standingsDelta` reads for an award) — not "does the cfg declare an awardScore".
    // Before W2b only the goal sports' award wrote a score; now every sport's walkover credits its ledger (sets,
    // points, a chess win, a defaulter's full quota of balls) except generic's, whose walkover is the win points at
    // 0–0 (GN-WO-1). Membership pinned, not derived: a sport that starts (or stops) crediting its walkover is a
    // deliberate edit here.
    expect(ICEHOCKEY.configSchema.parse({})).toMatchObject({ awardScore: { goals: 5 } });
    const adds = builtinModules.filter((m) => divisionAwardAddsToLedger(m, {})).map((m) => m.key).sort();
    expect(adds).toEqual(["badminton", "boardgame", "carrom", "cricket", "football", "hockey", "icehockey", "tabletennis", "tennis", "volleyball"]);
    expect(adds.length).toBe(builtinModules.length - 1);
    expect(divisionAwardAddsToLedger(GENERIC, CFG)).toBe(false);
    // The case where the hook and the old awardScore reading part ways: badminton declares no forfeit score, and its
    // walkover credits the table 2–0 in sets all the same (BD-WO-1), so its walkover is an ordinary ledger match.
    expect((BADMINTON.configSchema.parse({}) as { awardScore?: unknown }).awardScore).toBeUndefined();
    expect(divisionAwardAddsToLedger(BADMINTON, {})).toBe(true);
    // No module, or a cfg that does not parse: false (the builder has no
    // bounds then either, so it shows no status at all).
    expect(divisionAwardAddsToLedger(null, {})).toBe(false);
    expect(divisionAwardAddsToLedger(undefined, {})).toBe(false);
    expect(divisionAwardAddsToLedger(ICEHOCKEY, { awardScore: { goals: "five" } })).toBe(false);
    // A module whose `init` refuses the empty seats it is asked with: false, never a thrown public page.
    const refusing = { ...ICEHOCKEY, init: () => { throw new Error("no lineup"); } } as unknown as typeof ICEHOCKEY;
    expect(divisionAwardAddsToLedger(refusing, {})).toBe(false);
  });
});

describe("no status — stated first, each with its positive pair", () => {
  it("positive: the brief's Swiss-after-two table DOES carry a view", () => {
    const v = must(view(swiss4()));
    expect(Object.keys(v.rows).sort()).toEqual(["A", "B", "C", "D"]);
  });
  it("an empty table", () => {
    expect(view({ ...swiss4(), rows: [] })).toBeNull();
  });
  it("a bracket stage kind; league/group/swiss do", () => {
    // open4 has every seat filled, so nothing but the kind check can refuse it.
    expect(view({ ...open4(), kind: "knockout" })).toBeNull();
    expect(view({ ...open4(), kind: "double_elim" })).toBeNull();
    expect(view(open4())).not.toBeNull();
  });
  it("reads only this stage's fixtures: an earlier stage's results are not this table's", () => {
    // A finished league before this one: every entrant played three there.
    const s = open4();
    const earlier = [won(1, "A", "B"), won(1, "C", "D"), won(2, "A", "C"), won(2, "B", "D"), won(3, "A", "D"), won(3, "B", "C")].map(
      (f) => ({ ...f, stage_id: "S0" }),
    );
    expect(view({ ...s, fixtures: [...earlier, ...s.fixtures] })).toEqual(view(s));
    expect(view(s)).not.toBeNull();
  });
  it("no cut declared, a zero cut, or no destination", () => {
    expect(view({ ...swiss4(), meta: { qualifyCount: null } })).toBeNull();
    expect(view({ ...swiss4(), meta: { qualifyCount: 0 } })).toBeNull();
    expect(view({ ...swiss4(), meta: { nextStageName: null } })).toBeNull();
  });
  it("no match played — a bye alone is not one; one real result is", () => {
    const shells = [bye(1, "E"), open(1, "A", "B"), open(1, "C", "D"), open(2, null, null), open(2, null, null), open(2, null, null)];
    const rows = ["A", "B", "C", "D"].map((id, i) => row(id, i + 1, 0, 0)).concat(row("E", 5, 1, 1));
    expect(view({ kind: "swiss", rows, fixtures: shells })).toBeNull();
    const one = shells.map((f, i) => (i === 1 ? won(1, "A", "B") : f));
    const played = rows.map((r) => (r.entrantId === "A" ? row("A", 1, 1, 1) : r.entrantId === "B" ? row("B", 4, 0, 1) : r));
    expect(view({ kind: "swiss", rows: played, fixtures: one })).not.toBeNull();
  });
  it("stage complete (every round settled)", () => {
    const s = swiss4();
    const done = [won(3, "A", "C"), won(3, "B", "D")];
    const rows = [row("A", 1, 3, 3, [5, 0]), row("B", 2, 2, 3, [3, 2]), row("C", 3, 1, 3, [1, 3]), row("D", 4, 0, 3, [0, 4])];
    expect(view({ ...s, rows, fixtures: [...s.fixtures.filter((f) => f.round_no < 3), ...done] })).toBeNull();
  });
  it("M1: an organiser rank override hides the status; a lots-decided tie (engine rankLocked) does NOT", () => {
    expect(view({ ...swiss4(), meta: { hasRankOverrides: true } })).toBeNull();
    const s = swiss4();
    const lots = s.rows.map((r) => (r.entrantId === "B" || r.entrantId === "C" ? { ...r, rankLocked: true, tieBreak: { key: "lots", with: ["B", "C"] } } : r));
    expect(view({ ...s, rows: lots })).not.toBeNull();
  });
  it("Review Focus 4: a cascade not led by points; led by points it shows", () => {
    expect(view(swiss4(), { cascade: ["wins", "points", "diff"] })).toBeNull();
    expect(view(swiss4(), { cascade: ["points", "wins", "diff"] })).not.toBeNull();
  });
  it("Review Focus 5: an overall cut on a pooled table shows no status; a per-group cut does", () => {
    const pooled = (perGroup: boolean) => {
      const s = open4();
      return view({
        ...s,
        kind: "group",
        poolId: "P1",
        meta: { qualifyPerGroup: perGroup },
        fixtures: s.fixtures.map((f) => ({ ...f, pool_id: "P1" })),
      });
    };
    expect(pooled(false)).toBeNull();
    expect(pooled(true)).not.toBeNull();
  });
  it("a pool's table reads only its own pool's fixtures", () => {
    // Pool P2's unsettled null-seat fixture is P2's business, not P1's.
    const s = open4();
    const mine = s.fixtures.map((f) => ({ ...f, pool_id: "P1" }));
    const other = open(3, "X", null, { pool_id: "P2" });
    expect(view({ ...s, kind: "group", poolId: "P1", meta: { qualifyPerGroup: true }, fixtures: [...mine, other] })).not.toBeNull();
    expect(view({ ...s, kind: "group", poolId: "P1", meta: { qualifyPerGroup: true }, fixtures: [...mine, { ...other, pool_id: "P1" }] })).toBeNull();
  });
  it("Review Focus 3: an unsettled null-seat league fixture suppresses; a settled one-seat bye does not", () => {
    const s = open4();
    expect(view({ ...s, fixtures: [...s.fixtures, open(4, "B", null)] })).toBeNull();
    expect(view({ ...s, fixtures: [...s.fixtures, bye(4, "B")], rows: s.rows.map((r) => (r.entrantId === "B" ? row("B", 2, 2, 3, [1, 1], { points: 2 * W }) : r)) })).not.toBeNull();
  });
  it("no bounds (unknown module / unparsable cfg) → no status", () => {
    expect(view(swiss4(), { bounds: null })).toBeNull();
  });
  it("a malformed stage PointsRule → no status (never the sport's bounds instead); a valid one shows", () => {
    expect(view({ ...swiss4(), meta: { pointsRule: { base: { win: "three" } } } })).toBeNull();
    expect(view({ ...swiss4(), meta: { pointsRule: { win: { regulation: 3 }, draw: 1, loss: { regulation: 0 }, shootoutAs: "result", unit: "whole" } } })).not.toBeNull();
  });
  it("a Swiss stage without a declared round count; with one it shows", () => {
    expect(view({ ...swiss4(), meta: { swissRounds: null } })).toBeNull();
    expect(view({ ...swiss4(), meta: { swissRounds: 0 } })).toBeNull();
    expect(view({ ...swiss4(), meta: { swissRounds: 3 } })).not.toBeNull();
  });
  it("F3: a cut that takes every ACTIVE row; one fewer shows", () => {
    expect(view({ ...swiss4(), meta: { qualifyCount: 4 } })).toBeNull();
    expect(view({ ...swiss4(), meta: { qualifyCount: 3 } })).not.toBeNull();
    // A departed row (award mode, so F1 passes) still counts as a rival but not
    // as a place: cut 3 of 3 active is no contest; cut 2 of 3 is.
    const s = rr4(2);
    const departed = { A: "withdrawn" };
    expect(view({ ...s, meta: { qualifyCount: 3 }, statuses: departed })).toBeNull();
    expect(view({ ...s, meta: { qualifyCount: 2 }, statuses: departed })).not.toBeNull();
  });
  it("F1: a departed entrant whose table withdrawal would EXPUNGE played results; award mode shows", () => {
    // After round 1, A has 1 played of 3: under 50% ⇒ expunge would void A's
    // win over C and move the table under everyone's feet.
    expect(view({ ...rr4(1), meta: { qualifyCount: 2 }, statuses: { A: "withdrawn" } })).toBeNull();
    expect(view({ ...rr4(1), meta: { qualifyCount: 2 }, statuses: { A: "disqualified" } })).toBeNull();
    // The same table with A in the field shows.
    expect(view({ ...rr4(1), meta: { qualifyCount: 2 } })).not.toBeNull();
    // After round 2, A has 2 of 3: award mode keeps the results.
    expect(view({ ...rr4(2), statuses: { A: "withdrawn" } })).not.toBeNull();
  });
  it("F1: a departed SWISS entrant never expunges (owner ruling 2026-09-24), so the fixtures that hide a league table show", () => {
    // rr4(1) as a Swiss: A has 1 played of 3, which expunges in a league (the
    // test above). The cascade never expunges a Swiss withdrawal — played
    // results stand, pending boards walk over — so the builder must agree
    // and keep the table, or it hides statuses the cascade would never void.
    const swiss = { ...rr4(1), kind: "swiss", meta: { qualifyCount: 2 } };
    expect(view({ ...swiss, statuses: { A: "withdrawn" } })).not.toBeNull();
    expect(view({ ...swiss, statuses: { A: "disqualified" } })).not.toBeNull();
    // The same fixtures as a league still hide: the exception is Swiss only.
    expect(view({ ...swiss, kind: "league", statuses: { A: "withdrawn" } })).toBeNull();
  });
  it("F1: the policy reads THIS stage's fixtures — results A banked in an earlier stage do not make it award", () => {
    // withdrawal.ts groups by stage; three earlier-stage wins would lift A to
    // 4 of 6 played if they were counted here.
    const s = rr4(1);
    const earlier = [won(1, "A", "B"), won(2, "A", "C"), won(3, "A", "D")].map((f) => ({ ...f, stage_id: "S0" }));
    expect(view({ ...s, meta: { qualifyCount: 2 }, fixtures: [...earlier, ...s.fixtures], statuses: { A: "withdrawn" } })).toBeNull();
  });
  it("F1: an expunge that already happened (every A fixture void) leaves nothing to void, so status shows", () => {
    const s = rr4(1);
    const fixtures = s.fixtures.map((f) => (f.home_entrant_id === "A" || f.away_entrant_id === "A" ? voided(f) : f));
    const rows = [row("A", 4, 0, 0), row("B", 1, 1, 1), row("C", 2, 0, 0), row("D", 3, 0, 1)];
    expect(view({ ...s, rows, fixtures, statuses: { A: "withdrawn" } })).not.toBeNull();
  });
  it("F1: an entrant whose status cannot be read → no status", () => {
    const s = swiss4();
    const statuses = input(s).entrantStatuses;
    const rest: Record<string, string> = { ...statuses };
    delete rest.D;
    expect(view(s, { entrantStatuses: rest })).toBeNull();
    expect(view(s, { entrantStatuses: statuses })).not.toBeNull();
  });
  it("F2: a member seated in the table's fixtures but missing from the snapshot → no status", () => {
    // E is seated in round 3 but the snapshot never folded E (no results yet,
    // multi-pool `entrantsOfPool`): E's carried points cannot be known.
    const s = open4();
    expect(view({ ...s, fixtures: [...s.fixtures, open(4, "A", "E")] })).toBeNull();
    expect(view({ ...s, rows: [...s.rows, row("E", 5, 0, 0)], fixtures: [...s.fixtures, open(4, "A", "E")] })).not.toBeNull();
  });
  it("F2: a DEPARTED member the snapshot never folded still hides the table; folded, it shows", () => {
    // Review fix round 2 (owner-accepted: pools fail closed until every member
    // has a result). A status-only leaver keeps its place, and its carried
    // points fold in the moment any of its fixtures gets a result — a frozen
    // guess could turn a Through false. So E absent from the snapshot → none,
    // whether its boards are still scheduled (a registrant's self-cancel moves
    // only the status) or voided without an outcome.
    const s = open4();
    const eOpen = [open(1, "E", "B"), open(4, "A", "E")];
    const eVoid = eOpen.map(voided);
    expect(view({ ...s, fixtures: [...s.fixtures, ...eOpen], statuses: { E: "withdrawn" } })).toBeNull();
    expect(view({ ...s, fixtures: [...s.fixtures, ...eVoid], statuses: { E: "withdrawn" } })).toBeNull();
    expect(view({ ...s, fixtures: [...s.fixtures, ...eVoid], statuses: { E: "disqualified" } })).toBeNull();
    // Positive pair: the organiser's expunge cascade voids E's boards as
    // `abandoned` KEEPING a no_result outcome, so the snapshot folds E (at its
    // real points, carry-over included) — E is known, and the table shows.
    const expunged = eOpen.map((f) => ({ ...f, status: "abandoned", outcome: { kind: "no_result" } }));
    const withE = (points: number) => [...s.rows, row("E", 5, 0, 0, [0, 0], { points })];
    const folded = must(view({ ...s, rows: withE(0), fixtures: [...s.fixtures, ...expunged], statuses: { E: "withdrawn" } }));
    expect(folded.rows.E).toBeUndefined();
    expect(Object.keys(folded.rows).sort()).toEqual(["A", "B", "C", "D"]);
    // …carried points included: E folded at 3 is a known rival too.
    expect(view({ ...s, rows: withE(3), fixtures: [...s.fixtures, ...expunged], statuses: { E: "withdrawn" } })).not.toBeNull();
  });
  it("I-2 (W2b D5): a DEPARTED member whose every line is an active EXPUNGE is owed no snapshot row — the table shows; back in the field, or one line not expunged, it still hides", () => {
    // Loop-F review I-2. W2b's expunge abandons with NO outcome (PF-4), so the snapshot never folds the leaver — and
    // nothing of hers is still to come. Before the fix F2 read her as unknown and the pool's qualification vanished.
    const s = open4();
    const eOpen = [open(1, "E", "B"), open(4, "A", "E")];
    const expunged = eOpen.map((f) => ({ ...f, status: "abandoned", outcome: null, expunged: true }));
    let checked = 0;
    for (const status of ["withdrawn", "disqualified"]) {
      const shown = must(view({ ...s, fixtures: [...s.fixtures, ...expunged], statuses: { E: status } }));
      expect(shown.rows.E, status).toBeUndefined();
      expect(Object.keys(shown.rows).sort(), status).toEqual(["A", "B", "C", "D"]);
      checked++;
    }
    expect(checked).toBe(2);
    // An unreadable status, or a member back IN the field (her lines expunged, yet she plays on): unknown — hidden.
    const rest = { ...input({ ...s, fixtures: [...s.fixtures, ...expunged] }).entrantStatuses };
    delete rest.E;
    expect(view({ ...s, fixtures: [...s.fixtures, ...expunged] }, { entrantStatuses: rest })).toBeNull();
    expect(view({ ...s, fixtures: [...s.fixtures, ...expunged], statuses: { E: "confirmed" } })).toBeNull();
    // One line NOT expunged (a plain recorded abandon, or still scheduled): her points can still move — hidden.
    // (A recorded abandon says so - `has_active_abandon` - or the fixture itself would be unreadable, X-AB-5.)
    const plain = [expunged[0]!, { ...expunged[1]!, expunged: false, has_active_abandon: true }];
    expect(view({ ...s, fixtures: [...s.fixtures, ...plain], statuses: { E: "withdrawn" } })).toBeNull();
    expect(view({ ...s, fixtures: [...s.fixtures, expunged[0]!, eOpen[1]!], statuses: { E: "withdrawn" } })).toBeNull();
  });
  it("snapshot lag: a row that has played FEWER matches than its settled fixtures → no status; equal or more shows", () => {
    const s = open4();
    const lag = s.rows.map((r) => (r.entrantId === "C" ? { ...r, played: 1 } : r));
    expect(view({ ...s, rows: lag })).toBeNull();
    expect(view(s)).not.toBeNull();
    // More played than this table's fixtures: carry-over "full" folds prior
    // matches into `played`, which is not lag.
    const carried = s.rows.map((r) => (r.entrantId === "C" ? { ...r, played: 5 } : r));
    expect(view({ ...s, rows: carried })).not.toBeNull();
  });
  it("snapshot lag counts a bye and a walkover as played, a void as not", () => {
    const s = swiss5();
    // D's bye is one of its 2 played: the row agrees, so it shows.
    expect(view(s)).not.toBeNull();
    const short = s.rows.map((r) => (r.entrantId === "D" ? { ...r, played: 1 } : r));
    expect(view({ ...s, rows: short })).toBeNull();
    const o = open4();
    const wo = [...o.fixtures.filter((f) => f.round_no < 3), walkover(3, "A", "B"), open(3, "C", "D")];
    const rowsWo = o.rows.map((r) => (r.entrantId === "B" ? { ...r, played: 2 } : r));
    expect(view({ ...o, fixtures: wo, rows: rowsWo })).toBeNull();
    const vd = [...o.fixtures.filter((f) => f.round_no < 3), voided(open(3, "A", "B")), open(3, "C", "D")];
    expect(view({ ...o, fixtures: vd })).not.toBeNull();
    // A match played and then voided (abandoned) can keep its outcome jsonb;
    // the fold still skips it, so it is not a match the row owes.
    const kept = [...o.fixtures.filter((f) => f.round_no < 3), { ...won(3, "A", "B"), status: "abandoned" }, open(3, "C", "D")];
    expect(view({ ...o, fixtures: kept })).not.toBeNull();
  });
});

// W2d Task 9 (carry 6; spec D11, X-TB-3): the "ranked first" gate keys on the sport's OWN first measure
// (`primaryTableKey`), not on `points` alone. Volleyball, badminton and tennis rank on matches won first (FIVB V3-1, BWF
// 16.2.1, ATP C.3-1): a table led by `wins` is a qualification table there, and its race is run in wins (a win adds 1, a
// loss 0), never in points. Every shipped sport is swept, counted.
describe("W2d T9: the table's first measure is the sport's primaryTableKey (carry 6)", () => {
  /** A Swiss of four, two of three rounds played, whose POINTS do not follow its wins (an FIVB-like 3-2 win pays 2, a
   *  2-3 loss pays 1): A 2W 4pts, B 1W 4pts, C 1W 3pts, D 0W 2pts. Read in wins it is swiss4; in points it is not. */
  const splitScene = (): Scene => ({
    ...swiss4(),
    rows: [
      row("A", 1, 2, 2, [6, 4], { points: 4 }),
      row("B", 2, 1, 2, [5, 3], { points: 4 }),
      row("C", 3, 1, 2, [4, 5], { points: 3 }),
      row("D", 4, 0, 2, [4, 6], { points: 2 }),
    ],
  });
  /** The rulebook's wins table as a points rule: a win adds 1, anything else 0 — its bounds are the engine's own. */
  const WINS_RULE_BOUNDS = pointsRuleBounds(
    PointsRule.parse({ win: { regulation: 1 }, draw: 0, loss: { regulation: 0 }, shootoutAs: "result", unit: "whole" }),
    EVERY_OUTCOME,
  );
  const engineOn = (measure: "won" | "points", perMatch: NonNullable<typeof BOUNDS>) => {
    const res = qualificationStatus({
      rows: splitScene().rows.map((r) => ({ entrantId: r.entrantId, points: r[measure], active: true })),
      remaining: new Map(["A", "B", "C", "D"].map((id) => [id, 1])),
      perMatch,
      cut: 2,
      anyPlayed: true,
      complete: false,
    })!;
    return ["A", "B", "C", "D"].map((id) => res.get(id)?.status.kind ?? null);
  };
  const statusesOf = (v: QualificationView) => ["A", "B", "C", "D"].map((id) => v.rows[id]?.status ?? null);

  it("the sports whose table ranks on matches won first are badminton, tennis and volleyball (their rulebooks), every other on points", () => {
    const wins = builtinModules.filter((m) => m.primaryTableKey === "wins").map((m) => m.key).sort();
    expect(wins).toEqual(["badminton", "tennis", "volleyball"]);
    expect(builtinModules.filter((m) => m.primaryTableKey === "points").length, "anti-vacuity: the points sports").toBeGreaterThan(0);
  });

  it("premise: the split scene reads differently in wins than in points, so a race run in the wrong measure is seen", () => {
    expect(engineOn("won", WINS_RULE_BOUNDS!)).not.toEqual(engineOn("points", BOUNDS));
  });

  it("a wins table races on the wins table's bounds (a win adds 1), never the points rule's (a generic win pays 3): two 2-0 leaders with a round to go are clear of rivals who can reach 1 — every wins sport, counted", () => {
    // Swiss of four, two of three rounds played: A and B 2-0 (they have not met), C and D 0-2.
    const clear = (): Scene => ({
      kind: "swiss",
      rows: [
        row("A", 1, 2, 2, [4, 0], { points: 6 }),
        row("B", 2, 2, 2, [4, 1], { points: 6 }),
        row("C", 3, 0, 2, [1, 4], { points: 0 }),
        row("D", 4, 0, 2, [0, 4], { points: 0 }),
      ],
      fixtures: [won(1, "A", "C"), won(1, "B", "D"), won(2, "A", "D"), won(2, "B", "C"), open(3, null, null), open(3, null, null)],
    });
    const race = (perMatch: NonNullable<typeof BOUNDS>) => {
      const res = qualificationStatus({
        rows: clear().rows.map((r) => ({ entrantId: r.entrantId, points: r.won, active: true })),
        remaining: new Map(["A", "B", "C", "D"].map((id) => [id, 1])),
        perMatch,
        cut: 2,
        anyPlayed: true,
        complete: false,
      })!;
      return ["A", "B", "C", "D"].map((id) => res.get(id)?.status.kind ?? null);
    };
    // premise: the bounds differ, and the wins race reads differently under them
    expect(BOUNDS.max, "the points rule's per-match max").toBeGreaterThan(WINS_RULE_BOUNDS!.max);
    expect(race(WINS_RULE_BOUNDS!)).not.toEqual(race(BOUNDS));
    let checked = 0;
    for (const m of builtinModules.filter((x) => x.primaryTableKey === "wins")) {
      const v = must(view(clear(), { primary: m.primaryTableKey, cascade: [m.primaryTableKey, "diff"] }));
      expect(statusesOf(v), `${m.key}: the race in wins, on the wins bounds`).toEqual(race(WINS_RULE_BOUNDS!));
      checked++;
    }
    expect(checked, "the wins sports").toBe(3);
  });

  it("every sport: led by its primary it shows (in wins: the wins race); led by a step that is neither points nor its primary it shows none", () => {
    let checked = 0;
    let byWins = 0;
    for (const m of builtinModules) {
      const primary = m.primaryTableKey;
      const other = primary === "wins" ? "points" : "wins";
      const led = view(splitScene(), { primary, cascade: [primary, "diff"] });
      expect(led, `${m.key}: led by its primary (${primary})`).not.toBeNull();
      expect(view(splitScene(), { primary, cascade: ["diff", primary] }), `${m.key}: led by diff`).toBeNull();
      if (primary === "wins") {
        // the race in wins — the engine on the rows' wins under the wins table's bounds, not on their points
        expect(statusesOf(led!), `${m.key}: the wins race`).toEqual(engineOn("won", WINS_RULE_BOUNDS!));
        // `points` first is always a points table, and races in points
        const byPoints = must(view(splitScene(), { primary, cascade: ["points", "wins"] }));
        expect(statusesOf(byPoints), `${m.key}: led by points`).toEqual(engineOn("points", BOUNDS));
        byWins++;
      } else {
        expect(statusesOf(led!), `${m.key}: the points race`).toEqual(engineOn("points", BOUNDS));
        // `wins` first is not this sport's first measure: no status
        expect(view(splitScene(), { primary, cascade: [other, "points"] }), `${m.key}: led by ${other}`).toBeNull();
      }
      checked++;
    }
    expect(checked, "every shipped sport").toBe(builtinModules.length);
    expect(byWins, "the wins sports swept").toBe(3);
  });
});

describe("statuses equal the engine's on the derived input", () => {
  it("R4: A is 'Win and in', never Through; the line sits after place 2", () => {
    const v = must(view(swiss4()));
    expect(v.table.cutIndex).toBe(2);
    expect(v.rows.A!.status).toBe("win_k");
    const engine = qualificationStatus({
      rows: swiss4().rows.map((r) => ({ entrantId: r.entrantId, points: r.points, active: true })),
      remaining: new Map(["A", "B", "C", "D"].map((id) => [id, 1])),
      perMatch: BOUNDS,
      cut: 2,
      anyPlayed: true,
      complete: false,
    })!;
    for (const id of ["A", "B", "C", "D"]) expect(v.rows[id]!.status).toBe(engine.get(id)!.status.kind);
  });
  it("P2: Swiss remaining counts SETTLED rounds, not seated ones — D keeps exactly one", () => {
    // Round 3 seated but unplayed. Counting seats would give D 0 left (Out);
    // two left would make D's loss "Needs help". One left: a loss is Out.
    const s = swiss4();
    const seated = [...s.fixtures.filter((f) => f.round_no < 3), open(3, "A", "C"), open(3, "B", "D")];
    const d = must(view({ ...s, fixtures: seated })).rows.D!;
    expect(d.status).toBe("needs_help");
    expect(d.ifYouLose).toBe("If you lose your next match, you're out.");
  });
  it("M7: a bye counts as a round played — D (bye in round 2) has exactly one round left", () => {
    // swiss5 engine outcomes by D's rounds left: 0 → Out; 1 → Needs help, a
    // loss is Out; 2 → Needs help, a loss still Needs help.
    const d = must(view(swiss5())).rows.D!;
    expect(d.status).toBe("needs_help");
    expect(d.ifYouLose).toBe("If you lose your next match, you're out.");
  });
  it("M7: a withdrawn row gets no status, and its points AND its unplayed fixture decide a rival's verdict", () => {
    // rr4 after two rounds, cut 1: A (6, withdrawn, award mode) and B (6) meet
    // in round 3, still scheduled — a status-only departure moves no fixture.
    // A is not frozen (final review I1): that fixture can still pay A, up to a
    // win, so A's best is 9 and B's one win only draws level: Needs help.
    const s = rr4(2);
    const v = must(view({ ...s, statuses: { A: "withdrawn" } }));
    expect(v.rows.A).toBeUndefined();
    expect(v.rows.B!.status).toBe("needs_help");
    // The engine on the same table: A's one unplayed fixture is what moves B —
    // the old frozen reading (A: nothing left) said Win and in.
    const bWith = (aLeft: number) =>
      qualificationStatus({
        rows: s.rows.map((r) => ({ entrantId: r.entrantId, points: r.points, active: r.entrantId !== "A" })),
        remaining: new Map([["A", aLeft], ["B", 1], ["C", 1], ["D", 1]]),
        perMatch: BOUNDS,
        cut: 1,
        anyPlayed: true,
        complete: false,
      })!.get("B")!.status.kind;
    expect(bWith(1)).toBe("needs_help");
    expect(bWith(0)).toBe("win_k");
    // …whereas the same table without A puts B through — so A is what decides.
    const withoutA = qualificationStatus({
      rows: s.rows.filter((r) => r.entrantId !== "A").map((r) => ({ entrantId: r.entrantId, points: r.points, active: true })),
      remaining: new Map([["B", 1], ["C", 1], ["D", 1]]),
      perMatch: BOUNDS,
      cut: 1,
      anyPlayed: true,
      complete: false,
    })!;
    expect(withoutA.get("B")!.status.kind).toBe("through");
  });
  it("Review Focus 2: a stage points rule overrides the sport's bounds", () => {
    // A +W win bonus lifts every rival's best case, so A's one win no longer settles it.
    const rule = { win: { regulation: W }, draw: 1, loss: { regulation: 0 }, shootoutAs: "result", unit: "whole", bonuses: [{ when: "win_margin_gte", param: 1, points: W }] };
    const ruled = must(view({ ...swiss4(), meta: { pointsRule: rule } }));
    const engine = qualificationStatus({
      rows: swiss4().rows.map((r) => ({ entrantId: r.entrantId, points: r.points, active: true })),
      remaining: new Map(["A", "B", "C", "D"].map((id) => [id, 1])),
      perMatch: pointsRuleBounds(PointsRule.parse(rule), EVERY_OUTCOME),
      cut: 2,
      anyPlayed: true,
      complete: false,
    })!;
    expect(ruled.rows.A!.status).toBe(engine.get("A")!.status.kind);
    expect(ruled.rows.A!.status).not.toBe(must(view(swiss4())).rows.A!.status);
  });
  it("orders by rank, not by the order rows arrive in", () => {
    // swiss5 reversed: in arrival order D would sit ABOVE the line and pick C
    // as its rival; by rank D is 4th and its rival is E, the 2nd.
    const s = swiss5();
    const v = must(view({ ...s, rows: [...s.rows].reverse() }));
    expect(v.rows.D!.whatIf).toContain(NAMES.E);
    expect(v.rows.D!.whatIf).not.toContain(NAMES.C);
    expect(v.rows.A!.ariaLabel).toBe("Rank 1, Win and in, show details");
  });
  it("the aria label names the rank the table prints (a shared rank stays shared)", () => {
    const s = swiss4();
    const shared = s.rows.map((r) => (r.entrantId === "C" ? { ...r, rank: 2 } : r));
    const v = must(view({ ...s, rows: shared }));
    expect(v.rows.B!.ariaLabel).toBe("Rank 2, Needs help, show details");
    expect(v.rows.C!.ariaLabel).toBe("Rank 2, Needs help, show details");
  });
});

// Final review I1 (controller ruling): a departed row is NOT frozen. A
// status-only departure — a DQ by PATCH with no cascade (usecases/entrants.ts),
// a registrant's self-cancel — leaves its fixtures scheduled, and when the
// organiser later forfeits them the departed side takes the LOSER's walkover
// points: above 0 where a loss pays, below 0 under `forfeit.loserPoints`. Its
// row still gets no status, but its remaining is its unplayed fixtures in this
// table, bounded with the full per-match [min, max]. Points below are carried
// (a "full" carry-over opening): the builder reads the snapshot, not the sums.
describe("a departed row's unplayed fixtures (final review I1)", () => {
  /** League of four, cut 1: r1 B>A, D>C; r2 B>C, A–D (`ad`); r3 B>D, A–C to
   *  play. B finished on 10; D, disqualified, on 9 — 2 of 3 played, so award
   *  mode and F1 passes. A (1) and C (2) cannot reach 10 by themselves. */
  function dqScene(ad: QualFixture, dPlayed: number, aPoints: number): Scene {
    return {
      kind: "league",
      meta: { qualifyCount: 1 },
      rows: [
        row("B", 1, 3, 3, undefined, { points: 10 }),
        row("D", 2, 1, dPlayed, undefined, { points: 9 }),
        row("C", 3, 0, 2, undefined, { points: 2 }),
        row("A", 4, 0, dPlayed === 3 ? 2 : 1, undefined, { points: aPoints }),
      ],
      fixtures: [won(1, "B", "A"), won(1, "D", "C"), won(2, "B", "C"), ad, won(3, "B", "D"), open(3, "A", "C")],
      statuses: { D: "disqualified" },
    };
  }
  /** Generic with a loss that pays 1 — read from the module, never typed. */
  const PAYS_CFG = { ...CFG, points: { w: 3, d: 1, l: 1 } };
  const PAYS = divisionPointsBounds(GENERIC, PAYS_CFG)!;

  it("a loss that PAYS: B finished on 10, D DQ'd on 9 with one unplayed → B is NOT Through", () => {
    expect(PAYS.lossCeil).toBe(1); // precondition: D's forfeit loss alone lifts it level with B
    const v = must(view(dqScene(open(2, "A", "D"), 2, 1), { bounds: PAYS }));
    expect(v.rows.D).toBeUndefined();
    expect(v.rows.B).toMatchObject({ status: "needs_help", label: "Needs help" });
  });
  it("…its pair: D with nothing unplayed (A–D already played, D's 9 final) → B Through", () => {
    const v = must(view(dqScene(won(2, "A", "D"), 3, 4), { bounds: PAYS }));
    expect(v.rows.D).toBeUndefined();
    expect(v.rows.B).toMatchObject({ status: "through", label: "Through" });
  });
  it("a departed row whose unplayed fixture was cascaded to void or to a no-result counts nothing left, as before", () => {
    // The expunge cascade voids (`cancelled`, no outcome) or abandons keeping
    // a `no_result`; either is settled, so D is final on 9 and B is Through.
    const cancelled = voided(open(2, "A", "D"));
    const abandoned = { ...open(2, "A", "D"), status: "abandoned", outcome: { kind: "no_result" } };
    for (const ad of [cancelled, abandoned]) {
      const v = must(view(dqScene(ad, 2, 1), { bounds: PAYS }));
      expect(v.rows.B!.status, ad.status).toBe("through");
    }
  });
  it("a loss that COSTS (a stage rule's forfeit.loserPoints −1): D DQ'd on 10 with two unplayed, B's best 9 → B is NOT Out", () => {
    // League of five: r1 D>A, C>B; r2 D>C, B>A; r3 B>E; D–B, D–E, A–C, A–E,
    // C–E to play. D (10, 2 of 4 played: award mode) can still be forfeited
    // twice, to 8 — below B's best (6 + 3 = 9).
    const rule = { win: { regulation: 3 }, draw: 1, loss: { regulation: 0 }, shootoutAs: "result", unit: "whole", forfeit: { winnerPoints: 3, loserPoints: -1 } };
    expect(pointsRuleBounds(PointsRule.parse(rule), EVERY_OUTCOME).min).toBe(-1); // precondition, off the rule
    const scene = (db: QualFixture, de: QualFixture, bPts: number, bPlayed: number): Scene => ({
      kind: "league",
      meta: { qualifyCount: 1, pointsRule: rule },
      rows: [
        row("D", 1, 2, bPlayed === 4 ? 4 : 2, undefined, { points: 10 }),
        row("B", 2, 2, bPlayed, undefined, { points: bPts }),
        row("C", 3, 1, 2, undefined, { points: 3 }),
        row("A", 4, 0, 2, undefined, { points: 0 }),
        row("E", 5, 0, bPlayed === 4 ? 2 : 1, undefined, { points: 0 }),
      ],
      fixtures: [
        won(1, "D", "A"), won(1, "C", "B"), won(2, "D", "C"), won(2, "B", "A"), won(3, "B", "E"),
        db, de, open(4, "A", "C"), open(5, "A", "E"), open(5, "C", "E"),
      ],
      statuses: { D: "disqualified" },
    });
    const open2 = must(view(scene(open(3, "D", "B"), open(4, "D", "E"), 6, 3)));
    expect(open2.rows.D).toBeUndefined();
    expect(open2.rows.B).toMatchObject({ status: "needs_help", label: "Needs help" });
    // Pair: D's two matches already played (B beat D, D beat E) — D final on
    // 10, B final on 9: B is Out.
    const done = must(view(scene(won(3, "B", "D"), won(4, "D", "E"), 9, 4)));
    expect(done.rows.B).toMatchObject({ status: "out", label: "Out" });
  });
  it("Swiss: a departed entrant's remaining is the boards it is seated on, never the rounds formula", () => {
    // swiss4 with B withdrawn after two rounds (award mode). Swiss pairs only
    // the field (generateStageFixturesWrite's `active` read), so B is in no
    // round-3 board: nothing left, final on 3. A (6) is then Through (only C
    // reaches 6), and C's one win clears everyone but A: Win and in.
    const s = swiss4();
    const unseated = must(view({ ...s, statuses: { B: "withdrawn" } }));
    expect(unseated.rows.B).toBeUndefined();
    expect([unseated.rows.A!.status, unseated.rows.C!.status]).toEqual(["through", "win_k"]);
    // Pair: B departed AFTER round 3 was paired, still seated against D — one
    // unplayed board, best 6: A only Wins and in, C needs help.
    const early = s.fixtures.filter((f) => f.round_no < 3);
    const seated = must(view({ ...s, fixtures: [...early, open(3, "A", "C"), open(3, "B", "D")], statuses: { B: "withdrawn" } }));
    expect([seated.rows.A!.status, seated.rows.C!.status]).toEqual(["win_k", "needs_help"]);
  });
});

describe("if you lose", () => {
  // One sentence per post-loss status (owner copy fix, 2026-09-23): the old
  // "If you lose your next match: {status}." glued a status CHIP's words into
  // a sentence ("…: Win and in.", "…: Needs help."). Each status now has its
  // own sentence, and win_k says what the engine means by it after the loss:
  // win k of the r − 1 matches left (`qualificationStatus`, `r: r - 1`).
  //
  // Swiss of four after three rounds: A 9, B 6, C 3, D 0. Rounds and cut vary
  // to put A's post-loss status on each branch; the engine's own verdict is
  // checked first so the scene cannot drift from what it claims.
  function after3Rounds(rounds: number, cut: number): Scene {
    return {
      kind: "swiss",
      meta: { swissRounds: rounds, qualifyCount: cut },
      rows: [row("A", 1, 3, 3, [6, 0]), row("B", 2, 2, 3, [4, 2]), row("C", 3, 1, 3, [2, 4]), row("D", 4, 0, 3, [0, 6])],
      fixtures: [
        won(1, "A", "D"), won(1, "B", "C"), won(2, "A", "C"), won(2, "B", "D"), won(3, "A", "B"), won(3, "C", "D"),
        open(4, null, null), open(4, null, null),
      ],
    };
  }
  function engineAfterLoss(rounds: number, cut: number) {
    const s = after3Rounds(rounds, cut);
    return qualificationStatus({
      rows: s.rows.map((r) => ({ entrantId: r.entrantId, points: r.points, active: true })),
      remaining: new Map(s.rows.map((r) => [r.entrantId, rounds - 3])),
      perMatch: BOUNDS,
      cut,
      anyPlayed: true,
      complete: false,
    })!.get("A")!.ifYouLose;
  }
  it("win_k, k = 1 with one match left after the loss: win your last one", () => {
    expect(engineAfterLoss(5, 2)).toEqual({ kind: "win_k", k: 1 });
    expect(must(view(after3Rounds(5, 2))).rows.A!.ifYouLose).toBe(
      "If you lose your next match, you can still go through by winning your last one.",
    );
  });
  it("win_k, k = 2 with two left after the loss: win both — all of your last 2", () => {
    expect(engineAfterLoss(6, 2)).toEqual({ kind: "win_k", k: 2 });
    expect(must(view(after3Rounds(6, 2))).rows.A!.ifYouLose).toBe(
      "If you lose your next match, you can still go through by winning all of your last 2.",
    );
  });
  it("win_k, k = 1 with two left after the loss: ANY one of them, never 'your last one'", () => {
    expect(engineAfterLoss(6, 3)).toEqual({ kind: "win_k", k: 1 });
    expect(must(view(after3Rounds(6, 3))).rows.A!.ifYouLose).toBe(
      "If you lose your next match, you can still go through by winning one of your last 2.",
    );
  });
  it("win_k, k = 2 with three left after the loss: 2 of your last 3", () => {
    expect(engineAfterLoss(7, 3)).toEqual({ kind: "win_k", k: 2 });
    expect(must(view(after3Rounds(7, 3))).rows.A!.ifYouLose).toBe(
      "If you lose your next match, you can still go through by winning 2 of your last 3.",
    );
  });
  it("needs_help and out each read as their own sentence", () => {
    const v = must(view(swiss4()));
    expect(v.rows.A!.ifYouLose).toBe("If you lose your next match, you'll need other results to go your way.");
    expect(v.rows.D!.ifYouLose).toBe("If you lose your next match, you're out.");
  });
  it("through has a sentence too, though the engine never returns it after a loss", () => {
    // Unreachable from the builder: a loss moves `lo` by the per-match min and
    // takes one match away, so the worst case the through test reads —
    // points + min + (r − 1)·min — is the pre-loss one, and the pre-loss
    // status was open. The sentence exists so a future engine change cannot
    // print a key. Asked through the builder's own msg/plural.
    const i = input(swiss4());
    expect(ifYouLoseSentence({ kind: "through" }, 2, i)).toBe("If you lose your next match, you're still through.");
    // …and the other kinds through the same door, pinned against the view.
    expect(ifYouLoseSentence({ kind: "out" }, 0, i)).toBe("If you lose your next match, you're out.");
    expect(ifYouLoseSentence({ kind: "win_k", k: 3 }, 3, i)).toBe(
      "If you lose your next match, you can still go through by winning all of your last 3.",
    );
  });
  it("Spanish, French and Dutch word each sentence in their own language", () => {
    const expected: [Dict, string, string][] = [
      [es as Dict, "Si pierdes tu próximo partido, aún puedes pasar ganando {count} de los {r} últimos.", "Si pierdes tu próximo partido, aún puedes pasar ganando el último."],
      [fr as Dict, "Si vous perdez votre prochain match, vous pouvez encore passer en gagnant {count} de vos {r} derniers.", "Si vous perdez votre prochain match, vous pouvez encore passer en gagnant le dernier."],
      [nl as Dict, "Als je je volgende wedstrijd verliest, kun je nog door als je er {count} van je laatste {r} wint.", "Als je je volgende wedstrijd verliest, kun je nog door als je je laatste wint."],
    ];
    for (const [dict, kOf, last] of expected) {
      expect(must(view(after3Rounds(7, 3), {}, dict)).rows.A!.ifYouLose).toBe(kOf.replace("{count}", "2").replace("{r}", "3"));
      expect(must(view(after3Rounds(5, 2), {}, dict)).rows.A!.ifYouLose).toBe(last);
    }
  });
  it("open rows carry it; through and out rows do not", () => {
    const v = must(view(swiss4()));
    expect(v.rows.A!.ifYouLose).toBe("If you lose your next match, you'll need other results to go your way.");
    const settled = must(
      view({
        kind: "league",
        meta: { qualifyCount: 1 },
        rows: [row("A", 1, 5, 5), row("B", 2, 2, 5), row("C", 3, 2, 5), row("D", 4, 1, 5)],
        fixtures: [
          won(1, "A", "C"), won(1, "B", "D"), won(2, "A", "D"), won(2, "B", "C"), won(3, "A", "B"), won(3, "C", "D"),
          won(4, "A", "C"), won(4, "D", "B"), won(5, "A", "D"), won(5, "C", "B"), open(6, "A", "B"), open(6, "C", "D"),
        ],
      }),
    );
    expect(settled.rows.A!.status).toBe("through");
    expect(settled.rows.A!.ifYouLose).toBeNull();
    expect(settled.rows.A!.whatIf).toBeNull();
    expect(settled.rows.D!.status).toBe("out");
    expect(settled.rows.D!.ifYouLose).toBeNull();
    expect(settled.rows.D!.whatIf).toBeNull();
  });
  it("a Through row gets no what-if even when a row across the line can still draw level", () => {
    // Cut 2. A 9 (A–B left), C 6 (finished), B 6 (A–B left), D 0: B can reach
    // A's 9, yet only B can, so A is through. A tie with B changes nothing.
    const v = must(
      view({
        kind: "league",
        rows: [row("A", 1, 3, 3), row("C", 2, 2, 4), row("B", 3, 2, 3), row("D", 4, 0, 4)],
        fixtures: [
          won(1, "A", "D"), won(1, "C", "B"), won(2, "A", "C"), won(2, "B", "D"),
          open(3, "A", "B"), won(3, "C", "D"), won(4, "A", "D"), won(4, "B", "C"),
        ],
      }),
    );
    expect(v.rows.A!.status).toBe("through");
    expect(v.rows.A!.whatIf).toBeNull();
    expect(v.rows.A!.whatIfAssumption).toBeNull();
  });
  it("T2-C1: dropped when the entrant's next seat is a bye (no opponent); kept against a real one", () => {
    const s = swiss4();
    const early = s.fixtures.filter((f) => f.round_no < 3);
    const half = must(view({ ...s, fixtures: [...early, open(3, "A", "C"), open(3, "D", null)] })).rows.D!;
    expect(half.status).toBe("needs_help");
    expect(half.ifYouLose).toBeNull();
    const full = must(view({ ...s, fixtures: [...early, open(3, "A", "C"), open(3, "D", "B")] })).rows.D!;
    expect(full.ifYouLose).toBe("If you lose your next match, you're out.");
  });
  it("T2-C1 reads the EARLIEST unplayed seat, whatever order the fixtures arrive in", () => {
    // Four rounds; D seated in rounds 3 and 4. Two left: a loss still Needs help.
    const s = { ...swiss4(), meta: { swissRounds: 4 } };
    const early = s.fixtures.filter((f) => f.round_no < 3);
    const byeFirst = must(view({ ...s, fixtures: [...early, open(4, "D", "B"), open(3, "D", null)] })).rows.D!;
    expect(byeFirst.ifYouLose).toBeNull();
    const byeLater = must(view({ ...s, fixtures: [...early, open(4, "D", null), open(3, "D", "B")] })).rows.D!;
    expect(byeLater.ifYouLose).toBe("If you lose your next match, you'll need other results to go your way.");
  });
  it("T2-C1: a bye next also hides the what-if's tying result — rule and values only", () => {
    // swiss4 with D −2 over 14 goals and B level: against a real opponent D
    // gets "win by 3"; with a bye next, which result ties them is unknown.
    const s = swiss4();
    const rows = s.rows.map((r) =>
      r.entrantId === "D" ? row("D", 4, 0, 2, [6, 8]) : r.entrantId === "B" ? row("B", 2, 1, 2, [1, 1]) : r,
    );
    const early = s.fixtures.filter((f) => f.round_no < 3);
    const real = must(view({ ...s, rows, fixtures: [...early, open(3, "A", "B"), open(3, "D", "C")] })).rows.D!;
    expect(real.whatIf).toBe("If you finish level on points with Bo, difference decides: win your next match by 3 or more to finish ahead.");
    const bye = must(view({ ...s, rows, fixtures: [...early, open(3, "A", "B"), open(3, "D", null)] })).rows.D!;
    expect(bye.whatIf).toBe("If you finish level on points with Bo, difference decides. Now: you -2, Bo 0.");
    expect(bye.whatIfAssumption).toBeNull();
  });
});

describe("what-if (§3.4) — a target only when the tying result is known and the rival is not the next opponent", () => {
  // The word of the ledger the rows record (`tieBreakRule`, owner copy fix
  // 2026-09-23): `row()` folds the generic module's for/against/diff, so plain
  // "difference" — the football and cricket cases below name their own.
  const RULE = "difference";
  it("win scenario (a loss is Out): win by m", () => {
    // D −2 over 14 goals, B 0: a win by 3 lands D ahead of B.
    const d = must(view(open4({ D: [6, 8], B: [1, 1] }))).rows.D!;
    expect(d.ifYouLose).toBe("If you lose your next match, you're out.");
    expect(d.whatIf).toBe(`If you finish level on points with Bo, ${RULE} decides: win your next match by 3 or more to finish ahead.`);
    expect(d.whatIfAssumption).toBe("Assumes Bo's figures stay the same and your next match is an average one.");
  });
  it("win scenario, margin 0: any win", () => {
    const d = must(view(open4({ D: [6, 8], B: [1, 4] }))).rows.D!;
    expect(d.whatIf).toBe(`If you finish level on points with Bo, ${RULE} decides: any win in your next match puts you ahead.`);
    expect(d.whatIfAssumption).toBe("Assumes Bo's figures stay the same and your next match is an average one.");
  });
  it("loss scenario (Win and in): lose by no more than m", () => {
    const a = must(view(open4({ A: [5, 3], C: [1, 1] }))).rows.A!;
    expect(a.status).toBe("win_k");
    expect(a.whatIf).toBe(`If you finish level on points with Cy, ${RULE} decides: lose your next match by no more than 1 to finish ahead.`);
    expect(a.whatIfAssumption).toBe("Assumes Cy's figures stay the same and your next match is an average one.");
  });
  it("loss scenario whose target needs a WIN (margin ≥ 0): rule and values only", () => {
    const zero = must(view(open4({ A: [5, 3], C: [2, 1] }))).rows.A!;
    expect(zero.whatIf).toBe(`If you finish level on points with Cy, ${RULE} decides. Now: you +2, Cy +1.`);
    expect(zero.whatIfAssumption).toBeNull();
    const positive = must(view(open4({ A: [5, 3], C: [3, 1] }))).rows.A!;
    expect(positive.whatIf).toBe(`If you finish level on points with Cy, ${RULE} decides. Now: you +2, Cy +2.`);
    expect(positive.whatIfAssumption).toBeNull();
  });
  it("safe: ahead even after a heavy defeat", () => {
    const a = must(view(open4({ A: [5, 3], C: [0, 3] }))).rows.A!;
    expect(a.whatIf).toBe(`If you finish level on points with Cy, you stay ahead on ${RULE} even after a heavy defeat.`);
    expect(a.whatIfAssumption).toBe("Assumes Cy's figures stay the same and your next match is an average one.");
  });
  it("the rival is the row's own next opponent: rule and values only (target and safe alike)", () => {
    const vsRival: [string, string][] = [["A", "C"], ["B", "D"]];
    const target = must(view(open4({ A: [5, 3], C: [1, 1] }, vsRival))).rows.A!;
    expect(target.whatIf).toBe(`If you finish level on points with Cy, ${RULE} decides. Now: you +2, Cy 0.`);
    expect(target.whatIfAssumption).toBeNull();
    const safe = must(view(open4({ A: [5, 3], C: [0, 3] }, vsRival))).rows.A!;
    expect(safe.whatIf).toBe(`If you finish level on points with Cy, ${RULE} decides. Now: you +2, Cy -3.`);
    expect(safe.whatIfAssumption).toBeNull();
  });
  it("undeterminable scenario (a loss still Needs help): rule and values, even with a target in reach", () => {
    // B vs C, both level on diff: the engine's target is "win by 1", but B's
    // loss is not Out, so which result ties them is unknown.
    const b = must(view(open4())).rows.B!;
    expect(b.status).toBe("needs_help");
    expect(b.ifYouLose).toBe("If you lose your next match, you'll need other results to go your way.");
    expect(b.whatIf).toBe(`If you finish level on points with Cy, ${RULE} decides. Now: you 0, Cy 0.`);
    expect(b.whatIfAssumption).toBeNull();
  });
  it("Win 2 and in is no loss scenario: rule and values", () => {
    // Two left each (r3 A–B, C–D; r4 A–D, B–C): A is win_k(2).
    const s = open4({ A: [5, 3], C: [1, 1] });
    const a = must(view({ ...s, fixtures: [...s.fixtures, open(4, "A", "D"), open(4, "B", "C")] })).rows.A!;
    expect(a.label).toBe("Win 2 and in");
    expect(a.whatIf).toBe(`If you finish level on points with Cy, ${RULE} decides. Now: you +2, Cy 0.`);
    expect(a.whatIfAssumption).toBeNull();
  });
  it("two or more left: the tying result is no single match — rule and values, never a target or safe", () => {
    // Review fix round 1 (the reviewer's probe): after three rounds A 9 (+3),
    // B 6, C 3 (+1), D 0 (−5), cut 2, rounds 4–5 to play. The one-match
    // target ("lose by no more than 1") is false with two matches left.
    const two = must(view(after3(2))).rows;
    expect(two.A!.label).toBe("Win and in");
    expect(two.A!.whatIf).toBe(`If you finish level on points with Cy, ${RULE} decides. Now: you +3, Cy +1.`);
    expect(two.A!.whatIfAssumption).toBeNull();
    // D: a loss is Out (the win scenario), still two left.
    expect(two.D!.ifYouLose).toBe("If you lose your next match, you're out.");
    expect(two.D!.whatIf).toBe(`If you finish level on points with Bo, ${RULE} decides. Now: you -5, Bo +1.`);
    expect(two.D!.whatIfAssumption).toBeNull();
    // …and the safe reading, which is one heavy defeat, not two.
    const safe = must(view(after3(2, { C: [0, 3] }))).rows.A!;
    expect(safe.whatIf).toBe(`If you finish level on points with Cy, ${RULE} decides. Now: you +3, Cy -3.`);
    expect(safe.whatIfAssumption).toBeNull();
  });
  it("…its pair: the same table with ONE left does carry the target", () => {
    const one = must(view(after3(1))).rows;
    expect(one.A!.status).toBe("through");
    expect(one.C!.ifYouLose).toBe("If you lose your next match, you're out.");
    expect(one.C!.whatIf).toBe(`If you finish level on points with Bo, ${RULE} decides: win your next match by 1 or more to finish ahead.`);
    expect(one.C!.whatIfAssumption).toBe("Assumes Bo's figures stay the same and your next match is an average one.");
  });
  it("prefers a rival still playing: a departed row across the line is skipped, and no active rival means no what-if", () => {
    // open4 with B withdrawn after 2 of 3 (award mode, so F1 passes), on 3
    // with A–B still scheduled. C's nearest across the line is B; the active
    // A (6, one left) is still reachable, so C is told about A. D can reach
    // only B.
    const s = open4();
    const v = must(view({ ...s, statuses: { B: "withdrawn" } }));
    expect(v.rows.B).toBeUndefined();
    expect(v.rows.C!.whatIf).toContain("level on points with Ada,");
    expect(v.rows.D!.whatIf).toBeNull();
    expect(v.rows.D!.whatIfAssumption).toBeNull();
    // With B in the field both are told about B.
    const inField = must(view(s));
    expect(inField.rows.C!.whatIf).toContain("level on points with Bo,");
    expect(inField.rows.D!.whatIf).toContain("level on points with Bo,");
  });
  it("a key with no per-row value: the rule alone", () => {
    const d = must(view(open4(), { cascade: ["points", "h2h_points", "diff"] })).rows.D!;
    expect(d.whatIf).toBe("If you finish level on points with Bo, head-to-head decides.");
    expect(d.whatIfAssumption).toBeNull();
  });
  it("one side without a value: the rule alone, never a half-filled 'Now:'", () => {
    const s = open4();
    const rows = s.rows.map((r) => (r.entrantId === "B" ? { ...r, metrics: {} } : r));
    const d = must(view({ ...s, rows })).rows.D!;
    expect(d.whatIf).toBe(`If you finish level on points with Bo, ${RULE} decides.`);
  });
  it("the average match excludes byes: D's one real match (5 goals) sets the size", () => {
    // swiss5: D lost 2–3 to E and had a bye; E is +2. Over 1 real match the
    // target (win by 4) fits in one average match; counting the bye as a
    // match halves the average and there would be no target.
    const d = must(view(swiss5())).rows.D!;
    expect(d.whatIf).toBe(`If you finish level on points with Ed, ${RULE} decides: win your next match by 4 or more to finish ahead.`);
  });
  it("the average match excludes walkovers too", () => {
    // D forfeited one match (walkover to B, no ledger), so D's 14 goals came
    // from ONE match. B is +5: D needs a win by 8, which fits in one average
    // match of 14 goals but not in half of one.
    const o = open4({ D: [6, 8], B: [7, 2] });
    const fixtures = [won(1, "A", "D"), won(1, "C", "B"), won(2, "A", "C"), walkover(2, "B", "D"), open(3, "A", "B"), open(3, "C", "D")];
    const d = must(view({ ...o, fixtures })).rows.D!;
    // m = 5 − (−2) + 1 = 8 ≤ 14 over one match; 16 > 14 over two.
    expect(d.whatIf).toBe(`If you finish level on points with Bo, ${RULE} decides: win your next match by 8 or more to finish ahead.`);
  });
  it("…and no-results (a decided match that paid no ledger)", () => {
    const o = open4({ D: [6, 8], B: [7, 2] });
    const noResult = fx(2, "B", "D", "decided", { kind: "no_result" });
    const fixtures = [won(1, "A", "D"), won(1, "C", "B"), won(2, "A", "C"), noResult, open(3, "A", "B"), open(3, "C", "D")];
    const d = must(view({ ...o, fixtures })).rows.D!;
    expect(d.whatIf).toBe(`If you finish level on points with Bo, ${RULE} decides: win your next match by 8 or more to finish ahead.`);
  });
  // Loop R M-13 (X-DW-4): a double walkover credits NOTHING — no score to either side, in every sport, whatever the
  // division's walkover credits (`payout` and the folds pay it nothing) — so it is a match the average leaves
  // out, as it leaves out a no-result. Swept over every sport whose engine folds a both-sides forfeit to a double
  // walkover, the outcome being the engine's own fold, never typed; `awardAddsToLedger` is each sport's own reading, so
  // a sport whose WALKOVER would count (ice hockey's 5–0) is in the sweep too. D's 14 goals then came from ONE match and
  // the win by 8 fits; counted as a match, they halve to 7 and there is no target (the right answer differs from the
  // wrong one's sentence).
  it("…and double walkovers, in every sport (X-DW-4: a match that credited nothing)", () => {
    const o = open4({ D: [6, 8], B: [7, 2] });
    const target = `If you finish level on points with Bo, ${RULE} decides: win your next match by 8 or more to finish ahead.`;
    const checked: string[] = [];
    let ledgerSports = 0;
    for (const m of builtinModules) {
      const cfg = m.configSchema.parse(Object.values(m.variants ?? {})[0] ?? {});
      const l = defaultLineupPair(m.positions);
      const events: EventEnvelope[] = [makeEnvelope(1, { type: "core.forfeit", payload: { by: "both", reason: "walkover" } })];
      let outcome: unknown;
      try {
        outcome = outcomeOf(m as never, foldMatchWithStoppage(m as never, cfg as never, l, events));
      } catch {
        continue; // a sport whose kernel refuses a both-sides forfeit has no double walkover to read
      }
      if ((outcome as { kind?: string } | null)?.kind !== "double_walkover") continue;
      const addsToLedger = divisionAwardAddsToLedger(m, cfg);
      if (addsToLedger) ledgerSports++;
      const dw = fx(2, "B", "D", "forfeited", outcome);
      const fixtures = [won(1, "A", "D"), won(1, "C", "B"), won(2, "A", "C"), dw, open(3, "A", "B"), open(3, "C", "D")];
      const d = must(view({ ...o, fixtures }, { awardAddsToLedger: addsToLedger })).rows.D!;
      expect(d.whatIf, `${m.key}: the double walkover is no match in the average`).toBe(target);
      checked.push(m.key);
    }
    expect(checked.length, `sports checked: ${checked.join(", ")}`).toBeGreaterThanOrEqual(5);
    expect(ledgerSports, "premise: at least one swept sport's walkover WOULD count toward the average").toBeGreaterThan(0);
  });
  it("an ice-hockey walkover writes its forfeit score into the ledger, so it COUNTS toward the average; a generic one does not", () => {
    // The walkover scene above, in a sport whose core.forfeit records
    // cfg.awardScore (5–0) as the match's goals (period kernel `applyForfeit`,
    // folded by `standingsDelta`). D's 14 goals then came from TWO matches — an
    // average of 7 — and a win by 8 fits in no single one: rule and values.
    const o = open4({ D: [6, 8], B: [7, 2] });
    const fixtures = [won(1, "A", "D"), won(1, "C", "B"), won(2, "A", "C"), walkover(2, "B", "D"), open(3, "A", "B"), open(3, "C", "D")];
    const ice = must(view({ ...o, fixtures }, { awardAddsToLedger: divisionAwardAddsToLedger(ICEHOCKEY, {}) })).rows.D!;
    expect(ice.whatIf).toBe(`If you finish level on points with Bo, ${RULE} decides. Now: you -2, Bo +5.`);
    expect(ice.whatIfAssumption).toBeNull();
    // Its pair, the same table in the generic module: the award adds nothing,
    // D's 14 goals are one match's, and the target stands.
    const generic = must(view({ ...o, fixtures }, { awardAddsToLedger: divisionAwardAddsToLedger(GENERIC, CFG) })).rows.D!;
    expect(generic.whatIf).toBe(`If you finish level on points with Bo, ${RULE} decides: win your next match by 8 or more to finish ahead.`);
  });
  it("X-WO-1: the qualification view and the public table show the same credited score as the table", () => {
    // A REAL hockey walkover (D did not show; B is awarded it). Three readers of one credited score:
    const HOCKEY = moduleOf("hockey");
    const cfg = HOCKEY.configSchema.parse({});
    const l = defaultLineupPair(HOCKEY.positions);
    const events: EventEnvelope[] = [makeEnvelope(1, { type: "core.forfeit", payload: { by: l.away.entrantId, reason: "walkover" } })];
    const f = foldMatchWithStoppage(HOCKEY as never, cfg as never, l, events);
    const o = outcomeOf(HOCKEY as never, f)!;
    // …the engine's declaration, which the other three must agree with (not a typed 5–0):
    const credit = HOCKEY.forfeitCredit(cfg, HOCKEY.init(cfg, l), "walkover", "away");
    const credited: [number, number] = [credit.perSide[0].gf!, credit.perSide[1].gf!];
    expect(credited[0], "premise: a walkover is not 0–0 in hockey").toBeGreaterThan(0);
    expect(credited).toEqual([5, 0]); // FIH: the brief's "hockey 5-0", confirmed against the engine
    // 1. the table: the standings delta the fold writes.
    const [home, away] = HOCKEY.standingsDelta(o, cfg, { kind: "league" } as never, f.state);
    expect([home.metrics.gf, away.metrics.gf]).toEqual(credited);
    expect([home.metrics.ga, away.metrics.ga]).toEqual([credited[1], credited[0]]);
    // 2. the public summary (the match card's and the match centre's score lines).
    expect(HOCKEY.summary(f.state).perSide.map((p) => p.line)).toEqual(credited.map(String));
    // 3. the qualification view: the walkover is a match of THAT score in the what-if's average. D's row carries the
    //    table's goals — 6–3 played plus the credited 0–5 — so D's 14 goals came from two matches, an average of 7, and
    //    a win by 8 fits in neither: the what-if states values instead of a target.
    const scored = { D: [6 + credited[1], 3 + credited[0]] as [number, number], B: [7, 2] as [number, number] };
    const o4 = open4(scored);
    const fixtures = [won(1, "A", "D"), won(1, "C", "B"), won(2, "A", "C"), walkover(2, "B", "D"), open(3, "A", "B"), open(3, "C", "D")];
    const d = must(view({ ...o4, fixtures }, { awardAddsToLedger: divisionAwardAddsToLedger(HOCKEY, {}) })).rows.D!;
    expect(d.whatIf).toBe(`If you finish level on points with Bo, ${RULE} decides. Now: you -2, Bo +5.`);
    // The pair that reads the PLAYED ledger instead (nothing was played: 0–0, so the walkover would add nothing) —
    // the view must not: it would set a target the credited score already rules out.
    const played = HOCKEY.standingsDelta(o, cfg, { kind: "league" } as never, HOCKEY.init(cfg, l));
    expect(played[0].metrics.gf, "the credit is the award's, not the empty board's").toBe(credited[0]);
    const misread = must(view({ ...o4, fixtures }, { awardAddsToLedger: false })).rows.D!;
    expect(misread.whatIf).not.toBe(d.whatIf);
  });
  it("X-WO-1 (review M-5): every sport whose walkover credits GOALS counts it in the what-if, at the engine's own credit", () => {
    // The hockey case above, swept. The what-if decides on goal difference here (RULE), so the sports it can read a
    // walkover in are those whose engine credit carries goals; every other sport's credit (sets, points, a chess win,
    // a quota) never enters a goal average — and which modules' awards reach the ledger at all is pinned for EVERY
    // sport by the divisionAwardAddsToLedger test above. The scene is chosen so the answer moves with ANY credit c > 0:
    // D played one 6–6 match and lost the walkover 0–c, so D's average match is (12 + c) / 2 goals and the margin it
    // needs is 6 + c — more than that average for every c > 0 (values, not a target), but within ONE match's 12 + c
    // goals (the misreading that ignores the credit would set a target).
    const fixtures = [won(1, "A", "D"), won(1, "C", "B"), won(2, "A", "C"), walkover(2, "B", "D"), open(3, "A", "B"), open(3, "C", "D")];
    const goalSports: string[] = [];
    let swept = 0;
    for (const m of builtinModules) {
      const cfg = m.configSchema.safeParse({}).success ? m.configSchema.parse({}) : m.configSchema.parse(Object.values(m.variants ?? {})[0]);
      const l = defaultLineupPair(m.positions);
      const credit = m.forfeitCredit(cfg as never, m.init(cfg as never, l) as never, "walkover", "away");
      swept++;
      const c = credit.perSide[0].gf ?? 0;
      if (c <= 0) continue;
      goalSports.push(m.key);
      expect(credit.perSide[1].gf, `${m.key}: the side that did not show is credited nothing`).toBe(0);
      expect(divisionAwardAddsToLedger(m, cfg), m.key).toBe(true);
      const o4 = open4({ D: [6, 6 + c], B: [7, 2] });
      const d = must(view({ ...o4, fixtures }, { awardAddsToLedger: divisionAwardAddsToLedger(m, cfg) })).rows.D!;
      expect(d.whatIf, m.key).toBe(`If you finish level on points with Bo, ${RULE} decides. Now: you -${c}, Bo +5.`);
      const misread = must(view({ ...o4, fixtures }, { awardAddsToLedger: false })).rows.D!;
      expect(misread.whatIf, `${m.key}: the pair that ignores the credit`).toBe(
        `If you finish level on points with Bo, ${RULE} decides: win your next match by ${6 + c} or more to finish ahead.`,
      );
    }
    expect(swept, "every builtin sport").toBe(builtinModules.length);
    // Membership from the engine's credit, pinned so a sport that starts (or stops) crediting goals is a visible change.
    expect(goalSports.sort()).toEqual(["football", "hockey", "icehockey"]);
  });
  it("…but a one-sided bye adds no goals even there (the adapter folds it from a fresh 0–0 state): still out of the average", () => {
    const d = must(view(swiss5(), { awardAddsToLedger: divisionAwardAddsToLedger(ICEHOCKEY, {}) })).rows.D!;
    expect(d.whatIf).toBe(`If you finish level on points with Ed, ${RULE} decides: win your next match by 4 or more to finish ahead.`);
  });

  // A stage PointsRule's `forfeit.awardScore` (V414 publishes it as
  // meta.pointsRule): `payout` writes it to for/against/diff on a
  // forfeit with NOTHING PLAYED — never a bye, never an award after play
  // (W2c X-PT-1; `ruleScoreReaches`, parity with the fold in
  // qualification-points-parity.test.ts). So under such a rule an unplayed
  // forfeit is a ledger match wherever the deciding key reads those three
  // keys — the generic module's `diff` and `for` here — without the caller
  // having to say so (the generic module's awardAddsToLedger stays false).
  // Each pair is the same scene under the same rule minus its awardScore.
  const scoredRule = (awardScore?: [number, number]) => ({
    win: { regulation: W }, draw: 1, loss: { regulation: 0 }, shootoutAs: "result", unit: "whole",
    bonuses: [],
    forfeit: { winnerPoints: W, loserPoints: 0, ...(awardScore ? { awardScore } : {}) },
  });
  it("a stage rule's forfeit score puts a walkover in the ledger even where the sport's does not", () => {
    // The walkover scene: B's 3–0 is inside B's 7–2 and D's 6–8.
    const o = open4({ D: [6, 8], B: [7, 2] });
    const fixtures = [won(1, "A", "D"), won(1, "C", "B"), won(2, "A", "C"), walkover(2, "B", "D"), open(3, "A", "B"), open(3, "C", "D")];
    const scored = must(view({ ...o, fixtures, meta: { pointsRule: scoredRule([3, 0]) } })).rows.D!;
    expect(scored.whatIf).toBe(`If you finish level on points with Bo, ${RULE} decides. Now: you -2, Bo +5.`);
    expect(scored.whatIfAssumption).toBeNull();
    const unscored = must(view({ ...o, fixtures, meta: { pointsRule: scoredRule() } })).rows.D!;
    expect(unscored.whatIf).toBe(`If you finish level on points with Bo, ${RULE} decides: win your next match by 8 or more to finish ahead.`);
    // A SET forfeit score of 0–0 is a score like any other (fix round 2): `payout` writes it over the sport's
    // credit, so the walkover is a 0–0 ledger match — the rows (which it adds nothing to) are unchanged, and the match
    // counts in the average exactly as an ordinary result between B and D would.
    const nil = must(view({ ...o, fixtures, meta: { pointsRule: scoredRule([0, 0]) } })).rows.D!;
    const asPlayed = fixtures.map((f) => (f === fixtures[3] ? won(2, "B", "D") : f));
    const ordinary = must(view({ ...o, fixtures: asPlayed, meta: { pointsRule: scoredRule([0, 0]) } })).rows.D!;
    expect(ordinary.whatIf, "premise: the ordinary match counts").toBe(`If you finish level on points with Bo, ${RULE} decides. Now: you -2, Bo +5.`);
    expect(nil.whatIf).toBe(ordinary.whatIf);
    expect(nil.whatIf, "its negative pair: the same rule without an awarded score").not.toBe(unscored.whatIf);
  });
  it("X-PT-1: a withdrawal with nothing played is rule-scored like the walkover; after play it is the real match it was (ruling 124)", () => {
    // The walkover scene with B–D a withdrawal instead. Nothing played: the rule's 3–0 replaces the credit, so it is a
    // ledger match, as the walkover is. Something played: the rule pays base points and leaves the sport's credit — and
    // the generic credit of a withdrawal after play is the RECORDED score wherever it is worse for the offender (ruling
    // 124, GN-RT-1: football's `goalCredit` at generic's 0–0), here B's lead when D withdrew. That is a real match in the
    // ledger like any other, not the walkover's nothing, so the scene reads exactly as it does with B–D an ordinary result.
    const o = open4({ D: [6, 8], B: [7, 2] });
    const scene = (bd: QualFixture) => [won(1, "A", "D"), won(1, "C", "B"), won(2, "A", "C"), bd, open(3, "A", "B"), open(3, "C", "D")];
    const scored = { pointsRule: scoredRule([3, 0]) };
    const asResult = must(view({ ...o, fixtures: scene(won(2, "B", "D")), meta: scored })).rows.D!;
    const leftOut = must(view({ ...o, fixtures: scene(walkover(2, "B", "D")), meta: { pointsRule: scoredRule() } })).rows.D!;
    expect(asResult.whatIf, "premise: counting B–D or leaving it out prints different sentences").not.toBe(leftOut.whatIf);
    const walkoverScored = must(view({ ...o, fixtures: scene(walkover(2, "B", "D")), meta: scored })).rows.D!;
    const nothingPlayed = must(view({ ...o, fixtures: scene(withdrew(2, "B", "D", false)), meta: scored })).rows.D!;
    expect(nothingPlayed.whatIf).toBe(walkoverScored.whatIf);
    const afterPlay = must(view({ ...o, fixtures: scene(withdrew(2, "B", "D", true)), meta: scored })).rows.D!;
    expect(afterPlay.whatIf).toBe(asResult.whatIf);
    expect(afterPlay.whatIf).toBe(`If you finish level on points with Bo, ${RULE} decides. Now: you -2, Bo +5.`);
  });
  it("…but never a one-sided bye: the rule pays a bye no score (X-PT-1), so it stays out of the average", () => {
    // swiss5's fixtures: r1 A–B, E–D, C bye; r2 A–C, E–B, D bye. The snapshot rows are the scene's as given (the
    // builder reads them, it does not fold them): D is 3–3 (level) over one real match and one bye; its rival E is
    // +4, so a win by 5 draws them level: it fits one 6-goal match, not an average of 3 over two. Before W2c the
    // rule's score was taken to reach the bye, which made it a second match ("Now: you 0, Ed +4.").
    const s = swiss5();
    const rows = [
      row("A", 1, 2, 2, [5, 0]),
      row("E", 2, 2, 2, [4, 0]),
      row("C", 3, 1, 2, [3, 2]),
      row("D", 4, 1, 2, [3, 3]),
      row("B", 5, 0, 2, [0, 4]),
    ];
    const target = `If you finish level on points with Ed, ${RULE} decides: win your next match by 5 or more to finish ahead.`;
    const unscored = must(view({ ...s, rows, meta: { swissRounds: 3, pointsRule: scoredRule() } })).rows.D!;
    expect(unscored.whatIf).toBe(target);
    const scored = must(view({ ...s, rows, meta: { swissRounds: 3, pointsRule: scoredRule([3, 0]) } })).rows.D!;
    expect(scored.whatIf).toBe(target);
  });
  it("…and on `for` as on `diff`: the rule's score is in the goals the average reads", () => {
    // The walkover scene, D's real match a 1–2 loss plus the walkover's 0–3:
    // D 1–5, Bo 4 scored (its 3–0 inside). With the walkover a match (2), an
    // average of 3 cannot hold the win by 4 `for` needs: rule and values. As
    // no match (1), the whole 6 goals are one match's and a win by 1 is enough.
    const o = open4({ D: [1, 5], B: [4, 2] });
    const fixtures = [won(1, "A", "D"), won(1, "C", "B"), won(2, "A", "C"), walkover(2, "B", "D"), open(3, "A", "B"), open(3, "C", "D")];
    const cascade = ["points", "for"];
    const scored = must(view({ ...o, fixtures, meta: { pointsRule: scoredRule([3, 0]) } }, { cascade })).rows.D!;
    expect(scored.whatIf).toBe("If you finish level on points with Bo, total scored decides. Now: you 1, Bo 4.");
    const unscored = must(view({ ...o, fixtures, meta: { pointsRule: scoredRule() } }, { cascade })).rows.D!;
    expect(unscored.whatIf).toBe("If you finish level on points with Bo, total scored decides: win your next match by 1 or more to finish ahead.");
  });

  // Fix round 2: the rule's score counts only where the what-if READS it.
  // `payout` writes it to `for`/`against`/`diff` alone; `metricOf`
  // reads a sport's own `gf`/`ga`/`gd` first, and a ratio key reads neither.
  // Counting an award the average cannot see only shrinks the average — so
  // each scene below prints what the same table prints with no rule at all.
  /** A snapshot row carrying exactly `metrics` (row() always adds for/against/diff). */
  const ledgerRow = (id: string, rank: number, won: number, played: number, points: number, metrics: Metrics): StandingsRow => ({
    entrantId: id,
    rank,
    played,
    won,
    drawn: 0,
    lost: played - won,
    points,
    metrics,
  });
  /** What `payout` adds for a scored forfeit. */
  const ruleAward = (mine: number, theirs: number): Metrics => ({ for: mine, against: theirs, diff: mine - theirs });

  // W2c X-PT-1: the rule pays a bye no score, so a bye's row never carries the rule's for/against/diff — the scene's
  // rows are the same with the rule or without it. (Before W2c the bye was taken to carry it and `gf` hid it.)
  it("a football bye under the rule stays out of the average (no rule pays a bye a score)", () => {
    // Swiss of five on points → diff → for: r1 A 3–0 B, C 2–0 E, D bye; r2
    // A 2–0 C, D 4–0 E, B bye. Di (6, +4 from ONE real match of 4 goals) wins
    // and is in; a loss leaves it level on points with Cy (0). m = 0 − 4 + 1 =
    // −3, inside one 4-goal match: lose by no more than 3. Counting the bye
    // halves the average to 2 and the −3 reads as `safe`.
    const FB = divisionPointsBounds(FOOTBALL, {})!;
    expect(FB.winFloor).toBe(W);
    const fixtures = [
      won(1, "A", "B"),
      won(1, "C", "E"),
      bye(1, "D"),
      won(2, "A", "C"),
      won(2, "D", "E"),
      bye(2, "B"),
      open(3, null, null),
      open(3, null, null),
      open(3, null, null),
    ];
    const goals = (gf: number, ga: number): Metrics => ({ gf, ga, gd: gf - ga });
    const rows = [
      ledgerRow("A", 1, 2, 2, 2 * W, goals(5, 0)),
      ledgerRow("D", 2, 2, 2, 2 * W, goals(4, 0)),
      ledgerRow("C", 3, 1, 2, W, goals(2, 2)),
      ledgerRow("B", 4, 1, 2, W, goals(0, 3)),
      ledgerRow("E", 5, 0, 2, 0, goals(0, 6)),
    ];
    const over = { cascade: ["points", "diff", "for"], bounds: FB, awardAddsToLedger: divisionAwardAddsToLedger(FOOTBALL, {}) };
    const target = `If you finish level on points with Cy, goal difference decides: lose your next match by no more than 3 to finish ahead.`;
    const plain = must(view({ kind: "swiss", rows, fixtures }, over)).rows.D!;
    expect(plain.whatIf).toBe(target);
    const scored = must(view({ kind: "swiss", rows, fixtures, meta: { pointsRule: scoredRule([3, 0]) } }, over)).rows.D!;
    expect(scored.whatIf).toBe(target);
  });
  it("a cricket ledger names runs: `for` reads `runs_for`, and the what-if says \"runs scored\"", () => {
    // open4's table with cricket's own ledger keys (no goals) and `for`
    // deciding: D 3 runs for, Bo 5. The rows carry no `run_diff` (cricket's
    // ledger folds one; `for` never reads it), so `runs_for` alone must name
    // the family.
    const runs = (f: number, a: number): Metrics => ({ runs_for: f, runs_against: a, balls_faced_eff: 60, balls_bowled_eff: 60 });
    const rows = [
      ledgerRow("A", 1, 2, 2, 2 * W, runs(9, 2)),
      ledgerRow("B", 2, 1, 2, W, runs(5, 5)),
      ledgerRow("C", 3, 1, 2, W, runs(4, 5)),
      ledgerRow("D", 4, 0, 2, 0, runs(3, 9)),
    ];
    const d = must(view({ ...open4(), rows }, { cascade: ["points", "for"] })).rows.D!;
    expect(d.whatIf).toMatch(/^If you finish level on points with Bo, runs scored decides[.:]/);
    // …and the same table on the generic ledger says the plain phrase (pair).
    const g = must(view(open4({ D: [3, 9], B: [5, 5] }), { cascade: ["points", "for"] })).rows.D!;
    expect(g.whatIf).toMatch(/^If you finish level on points with Bo, total scored decides[.:]/);
  });
  it("a row with no ledger names the rule from its RIVAL's ledger, not the table's first one", () => {
    // Review r1–r3 m4: the what-if passes the rival as the tie partner
    // (`tieBreakRule(w.key, …, ordered, [rival.entrantId])`). A football league
    // where Di has yet to play (three postponed matches: no ledger at all) and
    // Ada, top, won both of hers by walkover under a scored stage rule, so her
    // row records only the rule's generic `for`/`against`/`diff`. Di's rival
    // Bo also played Cy for real: `gd` is on Bo's row. The word is Bo's, "goal
    // difference"; read from the table instead it is Ada's plain "difference".
    const FB = divisionPointsBounds(FOOTBALL, {})!;
    expect(FB.winFloor).toBe(W);
    const goals = (gf: number, ga: number): Metrics => ({ gf, ga, gd: gf - ga });
    const rows = [
      ledgerRow("A", 1, 2, 2, 2 * W, { for: 6, against: 0, diff: 6 }),
      ledgerRow("B", 2, 1, 2, W, { ...ruleAward(0, 3), ...goals(2, 1) }),
      ledgerRow("C", 3, 0, 2, 0, { ...ruleAward(0, 3), ...goals(1, 2) }),
      ledgerRow("D", 4, 0, 0, 0, {}),
    ];
    const fixtures = [walkover(1, "A", "B"), open(1, "C", "D"), walkover(2, "A", "C"), open(2, "B", "D"), won(3, "B", "C"), open(3, "A", "D")];
    const over = { cascade: ["points", "diff", "for"], bounds: FB, awardAddsToLedger: divisionAwardAddsToLedger(FOOTBALL, {}) };
    const word = (family: "goals" | "plain") => t(en, LEDGER_RULE_MSG_KEYS.diff[family]);
    expect(word("goals"), "premise: the two families word the rule differently").not.toBe(word("plain"));
    // Premise: with no partner the table's first ledger (Ada's) names it plain.
    expect(tieBreakRule("diff", (k: TKey) => t(en, k), rows[3]!, rows, [])).toBe(word("plain"));
    const d = must(view({ kind: "league", rows, fixtures, meta: { pointsRule: scoredRule([3, 0]) } }, over)).rows.D!;
    expect(d.whatIf).toMatch(new RegExp(`^If you finish level on points with Bo, ${word("goals")} decides[.:]`));
  });
  it("a badminton walkover credits its sets (BD-WO-1): set ratio reads them, so the walkover is IN the average, rule or no rule", () => {
    // open4 with r1's A–D a walkover: r1 C 2–1 B; r2 A 2–0 C, B 2–1 D. Before W2b a badminton walkover credited
    // nothing, so Di's sets (1–2) were ONE real match's and a win by 2 fit it (3.5/2.5 > 1) — "win by 2". W2b
    // Task 13 (ruling 108, X-WO-1): the walkover credits the table the engine's own sets (`forfeitCredit`, read
    // here, never typed), so Di's row is 1–2 plus the credited sets, from TWO matches, and a win by 2 fits no average
    // match: the what-if falls back to the rule and values. A stage rule's goals change nothing about that.
    const BB = divisionPointsBounds(BADMINTON, {})!;
    const bw = BB.winFloor;
    const bcfg = BADMINTON.configSchema.parse({});
    const credit = BADMINTON.forfeitCredit(bcfg, BADMINTON.init(bcfg, defaultLineupPair(BADMINTON.positions)), "walkover", "away");
    const [cw, cl] = credit.perSide;
    expect(cw.sets_won, "premise: the walkover credits sets").toBeGreaterThan(0);
    // Wins only, as badminton's own bounds are — else `wins` decides, not set ratio.
    const winsOnlyRule = {
      win: { regulation: bw }, draw: 0, loss: { regulation: 0 }, shootoutAs: "result", unit: "whole",
      bonuses: [],
      forfeit: { winnerPoints: bw, loserPoints: 0, awardScore: [3, 0] as [number, number] },
    };
    const sets = (w: number, l: number): Metrics => ({ sets_won: w, sets_lost: l });
    const rows = (scored: boolean) => [
      ledgerRow("A", 1, 2, 2, 2 * bw, { ...sets(2 + cw.sets_won!, 0 + cw.sets_lost!), ...(scored ? ruleAward(3, 0) : {}) }),
      ledgerRow("B", 2, 1, 2, bw, sets(3, 3)),
      ledgerRow("C", 3, 1, 2, bw, sets(2, 3)),
      ledgerRow("D", 4, 0, 2, 0, { ...sets(1 + cl.sets_won!, 2 + cl.sets_lost!), ...(scored ? ruleAward(0, 3) : {}) }),
    ];
    const fixtures = [walkover(1, "A", "D"), won(1, "C", "B"), won(2, "A", "C"), won(2, "B", "D"), open(3, "A", "B"), open(3, "C", "D")];
    const over = { cascade: [...defaultOrderOf(BADMINTON)], bounds: BB, awardAddsToLedger: divisionAwardAddsToLedger(BADMINTON, {}) };
    const target = "If you finish level on points with Bo, set ratio decides: win your next match by 2 or more to finish ahead.";
    const plain = must(view({ kind: "league", rows: rows(false), fixtures }, over)).rows.D!;
    expect(plain.whatIf).not.toBe(target);
    // The values are the rows' own set ratios: Di's, with the credited sets, and Bo's 3–3.
    const ratio = (w: number, l: number) => (w / l).toFixed(2);
    expect(plain.whatIf).toBe(`If you finish level on points with Bo, set ratio decides. Now: you ${ratio(1 + cl.sets_won!, 2 + cl.sets_lost!)}, Bo ${ratio(3, 3)}.`);
    const scored = must(view({ kind: "league", rows: rows(true), fixtures, meta: { pointsRule: winsOnlyRule } }, over)).rows.D!;
    expect(scored.whatIf).toBe(plain.whatIf);
    // The pair: the same rows with the walkover read as no match (the pre-W2b flag) set the stale target.
    const stale = must(view({ kind: "league", rows: rows(false), fixtures }, { ...over, awardAddsToLedger: false })).rows.D!;
    expect(stale.whatIf).not.toBe(plain.whatIf);
  });
  it("winsOnly from the bounds IN FORCE: badminton skips `wins` for set ratio", () => {
    const bb = divisionPointsBounds(BADMINTON, {})!;
    expect(bb.winsOnly).toBe(true);
    const bw = bb.winFloor;
    const sets = (w: number, l: number) => ({ sets_won: w, sets_lost: l });
    const s = open4();
    const rows = [
      row("A", 1, 2, 2, [0, 0], { points: 2 * bw, metrics: sets(4, 1) }),
      row("B", 2, 1, 2, [0, 0], { points: bw, metrics: sets(2, 2) }),
      row("C", 3, 1, 2, [0, 0], { points: bw, metrics: sets(2, 3) }),
      row("D", 4, 0, 2, [0, 0], { points: 0, metrics: sets(1, 4) }),
    ];
    const cascade = [...defaultOrderOf(BADMINTON)];
    const d = must(view({ ...s, rows }, { bounds: bb, cascade })).rows.D!;
    expect(d.whatIf).toContain("set ratio decides");
    // Points that did not come from wins at one rate (carry-over) put `wins` back.
    const carried = rows.map((r) => (r.entrantId === "A" ? { ...r, points: 2 * bw + 1 } : r));
    const dc = must(view({ ...s, rows: carried }, { bounds: bb, cascade })).rows.D!;
    expect(dc.whatIf).toBe("If you finish level on points with Bo, wins decides. Now: you 0, Bo 1.");
  });
  it("winsOnly follows a stage PointsRule, not the sport", () => {
    // generic pays draws (winsOnly false); a wins-only stage rule turns it on.
    const cascade = ["points", "wins", "diff"];
    const plain = must(view(open4(), { cascade })).rows.D!;
    expect(plain.whatIf).toBe("If you finish level on points with Bo, wins decides. Now: you 0, Bo 1.");
    const winsOnly = { win: { regulation: W }, draw: 0, loss: { regulation: 0 }, shootoutAs: "result", unit: "whole", bonuses: [] };
    const ruled = must(view({ ...open4(), meta: { pointsRule: winsOnly } }, { cascade })).rows.D!;
    expect(ruled.whatIf).toContain(`${RULE} decides`);
  });
  it("…and the key the rule's walkover is weighed against: past `wins` to `diff`, so the walkover counts (final review M4a)", () => {
    // The walkover scene under a wins-only rule that scores its forfeits 3–0.
    // `wins` cannot split a points tie here, so `diff` decides — and the
    // builder must ask tieDecidingKey with the same winsOnly, or it weighs the
    // walkover against `wins`, drops it from the average, and prints the
    // unscored rule's "win by 8" (the scene above) for a scored one.
    const o = open4({ D: [6, 8], B: [7, 2] });
    const fixtures = [won(1, "A", "D"), won(1, "C", "B"), won(2, "A", "C"), walkover(2, "B", "D"), open(3, "A", "B"), open(3, "C", "D")];
    const rule = { ...scoredRule([3, 0]), win: { regulation: W }, draw: 0, loss: { regulation: 0 }, shootoutAs: "result", unit: "whole" };
    expect(pointsRuleBounds(PointsRule.parse(rule), EVERY_OUTCOME).winsOnly).toBe(true); // precondition, off the rule
    const d = must(view({ ...o, fixtures, meta: { pointsRule: rule } }, { cascade: ["points", "wins", "diff"] })).rows.D!;
    expect(d.whatIf).toBe(`If you finish level on points with Bo, ${RULE} decides. Now: you -2, Bo +5.`);
    expect(d.whatIfAssumption).toBeNull();
  });
});

describe("wording", () => {
  it("labels, headline, aria label and cut line (en)", () => {
    const v = must(view(swiss4()));
    expect(v.rows.A).toMatchObject({
      label: "Win and in",
      ariaLabel: "Rank 1, Win and in, show details",
      headline: "Win your next match and you're through to Finals.",
    });
    expect(v.rows.D).toMatchObject({ label: "Needs help", headline: "Still open: you need other results to go your way." });
    expect(v.table.label).toBe("Top 2 go through to Finals · 1 round left");
    expect(v.table.legend).toEqual({ through: "Through", open: "Still open", out: "Out", hint: "Tap a rank for details." });
  });
  it("through, out and Win k (en)", () => {
    const s = open4();
    const two = must(view({ ...s, fixtures: [...s.fixtures, open(4, "A", "D"), open(4, "B", "C")] }));
    expect(two.rows.A!.headline).toBe("Win 2 of your remaining matches and you're through to Finals.");
    expect(two.table.label).toBe("Top 2 go through to Finals · 2 rounds left");
    const settled = must(view(settledCut1()));
    expect(settled.rows.A).toMatchObject({ label: "Through", headline: "Through to Finals, whatever happens next." });
    expect(settled.rows.D).toMatchObject({ label: "Out", headline: "Can no longer finish first." });
  });

  // Final review COPY: the cut line was pluralised on the rounds left, never
  // on N, so a one-place cut read "Top 1 go through to Finals"; the Out
  // headline read "…in the top 1". Each is now its own key, pluralised on N,
  // and the rounds left another, pluralised on the rounds and joined with " · ".
  // Every case pins the WHOLE sentence at N = 1 and N = 2 — a count-plural
  // pair differs only at one, so a single N cannot tell them apart.
  it("the cut line agrees with N: one place reads naturally, two read as before (with rounds left)", () => {
    expect(must(view(rr4(2))).table.label).toBe("First place goes through to Finals · 1 round left");
    expect(must(view(rr4(1))).table.label).toBe("First place goes through to Finals · 2 rounds left");
    expect(must(view(swiss4())).table.label).toBe("Top 2 go through to Finals · 1 round left");
  });
  it("nobody still in has a match left (only departed entrants' matches are open): the cut line drops the count, at N = 1 and N = 2", () => {
    const s = rr4(2);
    const fixtures = [...s.fixtures.filter((f) => f.round_no < 3), won(3, "A", "B"), open(3, "C", "D")];
    const rows = [row("A", 1, 3, 3), row("B", 2, 2, 3), row("C", 3, 0, 2), row("D", 4, 0, 2)];
    const v = must(view({ ...s, rows, fixtures, statuses: { C: "withdrawn", D: "withdrawn" } }));
    expect(v.table.label).toBe("First place goes through to Finals");
    expect(v.rows.A!.status).toBe("through");
    // N = 2: five entrants, A, C and B finished; D and E (departed, award
    // mode) still owe each other a match.
    const five = must(
      view({
        kind: "league",
        rows: [row("A", 1, 3, 3), row("C", 2, 2, 3), row("B", 3, 1, 2), row("D", 4, 0, 2), row("E", 5, 0, 2)],
        fixtures: [
          won(1, "A", "D"), won(1, "B", "E"), won(2, "A", "B"), won(2, "C", "D"), won(3, "C", "E"), won(3, "A", "C"), open(4, "D", "E"),
        ],
        statuses: { D: "withdrawn", E: "withdrawn" },
      }),
    );
    expect(five.table.label).toBe("Top 2 go through to Finals");
  });
  it("the Out headline agrees with N: first place at N = 1, the top N from two", () => {
    expect(must(view(settledCut1())).rows.D!.headline).toBe("Can no longer finish first.");
    // after3 with one round left, cut 2: A (9) and B (6) are beyond D's best (3).
    const d = must(view(after3(1))).rows.D!;
    expect(d.status).toBe("out");
    expect(d.headline).toBe("Can no longer finish in the top 2.");
  });
  it("N = 1 reads naturally in every locale — the cut line and the Out headline", () => {
    const expected: [Dict, string, string][] = [
      [es as Dict, "El primer clasificado pasa a Finals · queda 1 ronda", "Ya no puede terminar en primer lugar."],
      [fr as Dict, "Le premier passe en Finals · 1 tour restant", "Ne peut plus finir à la première place."],
      [nl as Dict, "De nummer 1 gaat door naar Finals · nog 1 ronde", "Kan niet meer als eerste eindigen."],
    ];
    for (const [dict, cutLine, outLine] of expected) {
      expect(must(view(rr4(2), {}, dict)).table.label).toBe(cutLine);
      expect(must(view(settledCut1(), {}, dict)).rows.D!.headline).toBe(outLine);
    }
    // …and N = 2 keeps its counted form.
    expect(must(view(swiss4(), {}, fr as Dict)).table.label).toBe("Les 2 premiers passent en Finals · 1 tour restant");
    expect(must(view(swiss4(), {}, nl as Dict)).table.label).toBe("De eerste 2 gaan door naar Finals · nog 1 ronde");
    expect(must(view(after3(1), {}, es as Dict)).rows.D!.headline).toBe("Ya no puede terminar entre los 2 primeros.");
  });
  it("Spanish: the locale path resolves every string in the org's language", () => {
    const v = must(view(swiss4(), {}, es as Dict));
    expect(v.rows.A!.label).toBe("Gana y pasa");
    expect(v.rows.A!.ariaLabel).toBe("Posición 1, Gana y pasa, ver detalles");
    expect(v.table.label).toBe("Los 2 primeros pasan a Finals · queda 1 ronda");
    expect(v.rows.D!.ifYouLose).toBe("Si pierdes tu próximo partido, quedas eliminado.");
  });
});

// W2c X-AB-5 / N2 (post-merge item): a recorded abandon that decided nobody is HELD for the organiser's settle - the desk
// shows it, `POST /stages/{id}/complete` refuses around it (`completionEngineStatus`) - so the PUBLIC table must not call
// anybody's fate while it stands. The builder reads the SAME predicate (`rowAwaitsSettle`): the stored row is `abandoned`
// either way, and only the ledger (`has_active_abandon`, `expunged`) tells a plain abandon (held) from a withdrawal's
// expunge or a generator's void (closed). Expected statuses come from the ENGINE on the snapshot, run with the held match
// counted as one still to come (held) and as gone (closed) - never from the builder - and every scene proves the two
// readings DIFFER for the entrant it is about, or the test could not tell the predicate from its absence.
describe("a match held for settle is still open (X-AB-5; the public table reads completion's predicate)", () => {
  const kindsFor = (rows: readonly StandingsRow[], remaining: Record<string, number>, cut: number) => {
    const out = qualificationStatus({
      rows: rows.map((r) => ({ entrantId: r.entrantId, points: r.points, active: true })),
      remaining: new Map(Object.entries(remaining)),
      perMatch: BOUNDS,
      cut,
      anyPlayed: true,
      complete: false,
    })!;
    return Object.fromEntries(rows.map((r) => [r.entrantId, out.get(r.entrantId)!.status.kind]));
  };
  const kindsOf = (v: QualificationView) => Object.fromEntries(Object.entries(v.rows).map(([id, r]) => [id, r.status]));
  const DECIDED = ["through", "out"];
  /** A recorded abandon as the public read carries it: stored `abandoned`, no outcome, an active ledger entry. */
  const plain = (home: string, away: string, over: Partial<QualFixture> = {}) =>
    fx(3, home, away, "abandoned", null, { has_active_abandon: true, expunged: false, ...over });

  // League of four, cut 2: r1 A>D, C>B; r2 A>C, B>D; r3 C-D still to play and A-B `ab`. Before r3: A 6, B 3, C 3, D 0.
  const BEFORE = open4().rows;
  const AFTER = [row("A", 1, 3, 3, [3, 0]), row("B", 2, 1, 3, [1, 2]), row("C", 3, 1, 2, [1, 1]), row("D", 4, 0, 2, [0, 2])];
  const league = (ab: QualFixture, rows: StandingsRow[] = BEFORE): Scene => ({
    ...open4({}, [["C", "D"]]),
    rows,
    fixtures: [...open4({}, [["C", "D"]]).fixtures, ab],
  });
  const group = (ab: QualFixture, rows: StandingsRow[] = BEFORE): Scene => {
    const s = league(ab, rows);
    return { ...s, kind: "group", poolId: "P1", meta: { qualifyCount: 2, qualifyPerGroup: true }, fixtures: s.fixtures.map((f) => ({ ...f, pool_id: "P1" })) };
  };
  // The engine's two readings of the same table: the A-B match still to come (held), and gone (closed).
  const HELD = kindsFor(BEFORE, { A: 1, B: 1, C: 1, D: 1 }, 2);
  const CLOSED = kindsFor(BEFORE, { A: 0, B: 0, C: 1, D: 1 }, 2);
  const SETTLED = kindsFor(AFTER, { A: 0, B: 0, C: 1, D: 1 }, 2);

  it("premise (the differential): the engine decides A when the match is gone, and does not while it is to come", () => {
    expect(DECIDED).toContain(CLOSED.A);
    expect(DECIDED).not.toContain(HELD.A);
    expect(HELD).not.toEqual(CLOSED);
    expect(DECIDED).toContain(SETTLED.A);
  });

  for (const [name, build] of [["league", league], ["group", group]] as const) {
    it(`${name}: a PLAIN abandon keeps both seats open - nobody whose fate hangs on it is decided`, () => {
      const v = must(view(build(plain("A", "B"))));
      expect(kindsOf(v)).toEqual(HELD);
      const decided = Object.entries(v.rows).filter(([, r]) => DECIDED.includes(r.status));
      expect(Object.keys(v.rows).length, "every entrant of the table is checked").toBe(4);
      expect(decided.map(([id]) => id)).not.toContain("A");
      expect(v.rows.A!.status).not.toBe(CLOSED.A);
    });

    it(`${name}: after the settle the match is a result and A is decided`, () => {
      const v = must(view(build(won(3, "A", "B"), AFTER)));
      expect(kindsOf(v)).toEqual(SETTLED);
      expect(DECIDED).toContain(v.rows.A!.status);
    });

    it(`${name}: a withdrawal's EXPUNGE stays closed (the match left the table), as the void it always read as`, () => {
      expect(kindsOf(must(view(build(plain("A", "B", { expunged: true })))))).toEqual(CLOSED);
    });

    it(`${name}: rebase ruling D3 - the organiser's online No result IS the settle: closed, while the same abandon unmarked is held`, () => {
      expect(kindsOf(must(view(build(plain("A", "B", { no_result: true })))))).toEqual(CLOSED);
      expect(kindsOf(must(view(build(plain("A", "B", { no_result: false })))))).toEqual(HELD);
      // The table's last match: No result finishes the stage (no view), where a plain abandon still shows one.
      const LAST = [row("A", 1, 2, 2, [2, 0]), row("C", 2, 2, 3, [2, 1]), row("B", 3, 1, 2, [1, 1]), row("D", 4, 0, 3, [0, 3])];
      const lastOne = (ab: QualFixture): Scene => {
        const sc = build(ab, LAST);
        return { ...sc, fixtures: sc.fixtures.map((f) => (f.status === "scheduled" ? { ...won(3, "C", "D"), pool_id: f.pool_id } : f)) };
      };
      expect(view(lastOne(plain("A", "B", { no_result: true }))), "No result: the stage is complete").toBeNull();
      expect(view(lastOne(plain("A", "B"))), "plain: still open").not.toBeNull();
    });

    it(`${name}: a generator's void (no ledger entry) and an abandon that RECORDED a result stay closed`, () => {
      let checked = 0;
      for (const closed of [
        plain("A", "B", { has_active_abandon: false }),
        fx(3, "A", "B", "abandoned", { kind: "no_result" }, { has_active_abandon: true, expunged: false }),
        fx(3, "A", "B", "cancelled", null, { has_active_abandon: false, expunged: false }),
      ]) {
        expect(kindsOf(must(view(build(closed)))), `${closed.status} ${JSON.stringify(closed.outcome)}`).toEqual(CLOSED);
        checked++;
      }
      expect(checked).toBe(3);
    });

    it(`${name}: the held match is the table's LAST - the table is not complete and still shows; settled, expunged or void it is finished and shows none`, () => {
      // C-D is played, so A-B is the only match left: the completion check (isTableStageComplete) is what reads the status.
      const LAST = [row("A", 1, 2, 2, [2, 0]), row("C", 2, 2, 3, [2, 1]), row("B", 3, 1, 2, [1, 1]), row("D", 4, 0, 3, [0, 3])];
      const SETTLED_LAST = [row("A", 1, 3, 3, [3, 0]), row("C", 2, 2, 3, [2, 1]), row("B", 3, 1, 3, [1, 2]), row("D", 4, 0, 3, [0, 3])];
      const lastOne = (ab: QualFixture, rows: StandingsRow[]): Scene => {
        const s = build(ab, rows);
        return { ...s, fixtures: s.fixtures.map((f) => (f.status === "scheduled" ? { ...won(3, "C", "D"), pool_id: f.pool_id } : f)) };
      };
      const shown = must(view(lastOne(plain("A", "B"), LAST)));
      expect(kindsOf(shown)).toEqual(kindsFor(LAST, { A: 1, B: 1, C: 0, D: 0 }, 2));
      expect(Object.keys(shown.rows).length, "every entrant of the table is checked").toBe(4);
      let finished = 0;
      for (const done of [plain("A", "B", { expunged: true }), plain("A", "B", { has_active_abandon: false })]) {
        expect(view(lastOne(done, LAST)), `${done.expunged ? "expunged" : "void"}: the stage is complete`).toBeNull();
        finished++;
      }
      expect(view(lastOne(won(3, "A", "B"), SETTLED_LAST)), "settled: the stage is complete").toBeNull();
      expect(finished).toBe(2);
    });

    it(`${name}: the sequence - held, then voided back to scheduled, reads as the match to come it is`, () => {
      const back = fx(3, "A", "B", "scheduled", null, { has_active_abandon: false, expunged: false });
      expect(kindsOf(must(view(build(back))))).toEqual(HELD);
    });

    it(`${name}: a fixture that does not say whether its abandon is active (an older cached read) gives no status, not a guess`, () => {
      const unsure = fx(3, "A", "B", "abandoned", null);
      expect(unsure.has_active_abandon).toBeUndefined();
      expect(view(build(unsure))).toBeNull();
      // …whereas a fixture that DOES say gives a view either way, so the null is the missing fact and nothing else.
      expect(view(build({ ...unsure, has_active_abandon: false }))).not.toBeNull();
      expect(view(build({ ...unsure, has_active_abandon: true }))).not.toBeNull();
      // Unsure but already answered by what it does carry (a result, or the expunge flag) stays a view.
      expect(view(build({ ...unsure, expunged: true }))).not.toBeNull();
      expect(view(build({ ...unsure, outcome: { kind: "no_result" } }))).not.toBeNull();
    });
  }

  it("swiss: a held board is an unplayed round for both seats, not a settled one", () => {
    // swiss4's round 2 C-D board is the abandon: C and D have ONE settled round (round 1) where the closed reading gives two.
    const swiss = (over: Partial<QualFixture>): Scene => ({
      kind: "swiss",
      rows: [row("A", 1, 2, 2, [4, 0]), row("B", 2, 1, 2, [2, 2]), row("C", 3, 0, 1, [0, 1]), row("D", 4, 0, 1, [0, 3])],
      fixtures: [
        won(1, "A", "D"), won(1, "B", "C"), won(2, "A", "B"),
        fx(2, "C", "D", "abandoned", null, { has_active_abandon: true, expunged: false, ...over }),
        open(3, null, null), open(3, null, null),
      ],
    });
    const rows = swiss({}).rows;
    // 3 rounds declared: rounds with a SETTLED fixture seating the entrant are what is spent.
    const held = kindsFor(rows, { A: 1, B: 1, C: 2, D: 2 }, 2);
    const closed = kindsFor(rows, { A: 1, B: 1, C: 1, D: 1 }, 2);
    expect(held, "premise: the two readings differ").not.toEqual(closed);
    expect(kindsOf(must(view(swiss({}))))).toEqual(held);
    expect(kindsOf(must(view(swiss({ expunged: true }))))).toEqual(closed);
  });
});

describe("copy coverage", () => {
  const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  const qualKeys = Object.keys(en).filter((k) => k.startsWith("table.qual."));
  it("every table.qual key exists in es/fr/nl with the same placeholders", () => {
    expect(qualKeys.length).toBe(34);
    for (const [name, dict] of [["es", es], ["fr", fr], ["nl", nl]] as const) {
      const d = dict as Record<string, string>;
      for (const k of qualKeys) {
        expect(d[k], `${name} ${k}`).toBeTypeOf("string");
        expect(placeholders(d[k]!), `${name} ${k}`).toEqual(placeholders((en as Record<string, string>)[k]!));
      }
    }
  });
  it("every key the builder asked for exists (t() would print the key)", () => {
    // Runs last in file order; REQUESTED holds every key from the tests above.
    must(view(swiss4()));
    const missing = [...REQUESTED].filter((k) => !(k in en));
    expect(missing).toEqual([]);
    for (const k of qualKeys) expect(REQUESTED.has(k), k).toBe(true);
  });
});
