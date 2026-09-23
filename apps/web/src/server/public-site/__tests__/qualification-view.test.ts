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
//   EQUIVALENT (unkillable, kept as the readable empty case): `qualifyCount
//   < 1` (the engine refuses cut < 1 itself) and `rows.length === 0` (F3
//   refuses it: a cut ≥ 0 active rows). The gate made `k === 1` in the loss
//   scenario redundant (k ≤ matches left), so it went. The DB-backed twin
//   (qualification-view-db.test.ts) kills F1, F2 (both directions, incl. the
//   seat restored), lag-void, Swiss-seated, pool-filter, the forfeited mapping
//   and the ledgerless reading of a real walkover on real reads too.
import { describe, expect, it } from "vitest";
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
  buildQualificationView,
  divisionAwardAddsToLedger,
  divisionPointsBounds,
  stageQualMeta,
  type QualFixture,
  type QualificationView,
  type QualificationViewInput,
  type StageQualMeta,
} from "../qualification-view";

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
const CASCADE = [...GENERIC.defaultTiebreakers];
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
    ...over,
  };
}
const won = (round: number, winner: string, loser: string, over: Partial<QualFixture> = {}) =>
  fx(round, winner, loser, "decided", { kind: "win", winner, loser }, over);
const open = (round: number, home: string | null, away: string | null, over: Partial<QualFixture> = {}) =>
  fx(round, home, away, "scheduled", null, over);
/** A Swiss sit-out as `seatSwissRound` writes it: settled at creation. */
const bye = (round: number, id: string) => fx(round, id, null, "forfeited", { kind: "award", winner: id });
/** A real two-sided walkover (core.forfeit): an award with both seats. */
const walkover = (round: number, winner: string, loser: string) =>
  fx(round, winner, loser, "forfeited", { kind: "award", winner });
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
      meta: { ...META, ...(scene.kind === "swiss" ? { swissRounds: 3 } : {}), ...scene.meta },
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
  it("maps the V414 columns, defaulting a null per-group flag to false", () => {
    expect(
      stageQualMeta({
        qualify_count: 4,
        qualify_per_group: null,
        next_stage_name: "Cup",
        swiss_rounds: 5,
        points_rule: undefined,
        has_rank_overrides: true,
      }),
    ).toEqual({ qualifyCount: 4, qualifyPerGroup: false, nextStageName: "Cup", swissRounds: 5, pointsRule: null, hasRankOverrides: true });
    expect(
      stageQualMeta({
        qualify_count: null,
        qualify_per_group: true,
        next_stage_name: null,
        swiss_rounds: null,
        points_rule: { base: {} },
        has_rank_overrides: false,
      }),
    ).toEqual({ qualifyCount: null, qualifyPerGroup: true, nextStageName: null, swissRounds: null, pointsRule: { base: {} }, hasRankOverrides: false });
  });
  it("bounds come from the module's own declaration; no module or an unparsable cfg gives none", () => {
    expect(BOUNDS).toEqual(GENERIC.matchPointsBounds(GENERIC.configSchema.parse(CFG)));
    expect(divisionPointsBounds(null, CFG)).toBeNull();
    expect(divisionPointsBounds(undefined, CFG)).toBeNull();
    expect(divisionPointsBounds(GENERIC, { resultMode: "nonsense" })).toBeNull();
  });
  it("divisionAwardAddsToLedger: exactly the modules whose config declares a forfeit score (awardScore)", () => {
    // Premise, read off the engine: ice hockey's walkover scores cfg.awardScore.
    expect(ICEHOCKEY.configSchema.parse({})).toMatchObject({ awardScore: { goals: 5 } });
    // Membership pinned, not derived: a sport that starts (or stops) writing a
    // forfeit score into its ledger is a deliberate edit here.
    const adds = builtinModules.filter((m) => divisionAwardAddsToLedger(m, {})).map((m) => m.key).sort();
    expect(adds).toEqual(["football", "hockey", "icehockey"]);
    expect(divisionAwardAddsToLedger(GENERIC, CFG)).toBe(false);
    expect(divisionAwardAddsToLedger(BADMINTON, {})).toBe(false);
    // No module, or a cfg that does not parse: false (the builder has no
    // bounds then either, so it shows no status at all).
    expect(divisionAwardAddsToLedger(null, {})).toBe(false);
    expect(divisionAwardAddsToLedger(undefined, {})).toBe(false);
    expect(divisionAwardAddsToLedger(ICEHOCKEY, { awardScore: { goals: "five" } })).toBe(false);
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
    expect(view({ ...swiss4(), meta: { pointsRule: { base: { win: 3, draw: 1, loss: 0 } } } })).not.toBeNull();
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
    expect(d.ifYouLose).toBe("If you lose your next match: Out.");
  });
  it("M7: a bye counts as a round played — D (bye in round 2) has exactly one round left", () => {
    // swiss5 engine outcomes by D's rounds left: 0 → Out; 1 → Needs help, a
    // loss is Out; 2 → Needs help, a loss still Needs help.
    const d = must(view(swiss5())).rows.D!;
    expect(d.status).toBe("needs_help");
    expect(d.ifYouLose).toBe("If you lose your next match: Out.");
  });
  it("M7: a withdrawn row gets no status, and its frozen points DECIDE a rival's verdict", () => {
    // rr4 after two rounds, cut 1: A (6, withdrawn, award mode) and B (6, one
    // left). With A frozen at 6, B's loss could leave them level: Win and in.
    const s = rr4(2);
    const v = must(view({ ...s, statuses: { A: "withdrawn" } }));
    expect(v.rows.A).toBeUndefined();
    expect(v.rows.B!.status).toBe("win_k");
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
    const rule = { base: { win: W, draw: 1, loss: 0 }, bonuses: [{ when: "win_margin_gte", param: 1, points: W }] };
    const ruled = must(view({ ...swiss4(), meta: { pointsRule: rule } }));
    const engine = qualificationStatus({
      rows: swiss4().rows.map((r) => ({ entrantId: r.entrantId, points: r.points, active: true })),
      remaining: new Map(["A", "B", "C", "D"].map((id) => [id, 1])),
      perMatch: pointsRuleBounds(PointsRule.parse(rule)),
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

describe("if you lose", () => {
  it("open rows carry it; through and out rows do not", () => {
    const v = must(view(swiss4()));
    expect(v.rows.A!.ifYouLose).toBe("If you lose your next match: Needs help.");
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
    expect(full.ifYouLose).toBe("If you lose your next match: Out.");
  });
  it("T2-C1 reads the EARLIEST unplayed seat, whatever order the fixtures arrive in", () => {
    // Four rounds; D seated in rounds 3 and 4. Two left: a loss still Needs help.
    const s = { ...swiss4(), meta: { swissRounds: 4 } };
    const early = s.fixtures.filter((f) => f.round_no < 3);
    const byeFirst = must(view({ ...s, fixtures: [...early, open(4, "D", "B"), open(3, "D", null)] })).rows.D!;
    expect(byeFirst.ifYouLose).toBeNull();
    const byeLater = must(view({ ...s, fixtures: [...early, open(4, "D", null), open(3, "D", "B")] })).rows.D!;
    expect(byeLater.ifYouLose).toBe("If you lose your next match: Needs help.");
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
    expect(real.whatIf).toBe("If you finish level on points with Bo, goal/run difference decides: win your next match by 3 or more to finish ahead.");
    const bye = must(view({ ...s, rows, fixtures: [...early, open(3, "A", "B"), open(3, "D", null)] })).rows.D!;
    expect(bye.whatIf).toBe("If you finish level on points with Bo, goal/run difference decides. Now: you -2, Bo 0.");
    expect(bye.whatIfAssumption).toBeNull();
  });
});

describe("what-if (§3.4) — a target only when the tying result is known and the rival is not the next opponent", () => {
  const RULE = "goal/run difference";
  it("win scenario (a loss is Out): win by m", () => {
    // D −2 over 14 goals, B 0: a win by 3 lands D ahead of B.
    const d = must(view(open4({ D: [6, 8], B: [1, 1] }))).rows.D!;
    expect(d.ifYouLose).toBe("If you lose your next match: Out.");
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
    expect(b.ifYouLose).toBe("If you lose your next match: Needs help.");
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
    expect(two.D!.ifYouLose).toBe("If you lose your next match: Out.");
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
    expect(one.C!.ifYouLose).toBe("If you lose your next match: Out.");
    expect(one.C!.whatIf).toBe(`If you finish level on points with Bo, ${RULE} decides: win your next match by 1 or more to finish ahead.`);
    expect(one.C!.whatIfAssumption).toBe("Assumes Bo's figures stay the same and your next match is an average one.");
  });
  it("prefers a rival still playing: a withdrawn (frozen) row across the line is skipped, and no active rival means no what-if", () => {
    // open4 with B withdrawn after 2 of 3 (award mode, so F1 passes) and
    // frozen at 3. C's nearest across the line is B; the active A (6, one
    // left) is still reachable, so C is told about A. D can reach only B.
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
  it("…but a one-sided bye adds no goals even there (the adapter folds it from a fresh 0–0 state): still out of the average", () => {
    const d = must(view(swiss5(), { awardAddsToLedger: divisionAwardAddsToLedger(ICEHOCKEY, {}) })).rows.D!;
    expect(d.whatIf).toBe(`If you finish level on points with Ed, ${RULE} decides: win your next match by 4 or more to finish ahead.`);
  });

  // A stage PointsRule's `forfeit.awardScore` (V414 publishes it as
  // meta.pointsRule): `applyPointsRule` adds it to for/against/diff on EVERY
  // forfeit, and the adapter applies the rule to a one-sided bye's delta too
  // (engine-db/competition.ts `awardByeDelta`). So under such a rule a walkover
  // AND a bye are ledger matches wherever the deciding key reads those three
  // keys — the generic module's `diff` and `for` here — without the caller
  // having to say so (the generic module's awardAddsToLedger stays false).
  // Each pair is the same scene under the same rule minus its awardScore.
  const scoredRule = (awardScore?: [number, number]) => ({
    base: { win: W, draw: 1, loss: 0 },
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
    // A 0–0 forfeit score adds nothing, so it is no ledger match either.
    const nil = must(view({ ...o, fixtures, meta: { pointsRule: scoredRule([0, 0]) } })).rows.D!;
    expect(nil.whatIf).toBe(`If you finish level on points with Bo, ${RULE} decides: win your next match by 8 or more to finish ahead.`);
  });
  it("…and a one-sided bye too (the adapter applies the rule to the bye's delta)", () => {
    // swiss5's fixtures, goals as a 3–0 bye rule folds them: r1 A 3–0 B, E 3–0
    // D, C bye; r2 A 2–0 C, E 1–0 B, D bye. D is 3–3 (level) over one real
    // match and one bye; its rival E is +4, so a win by 5 draws them level:
    // it fits one 6-goal match, not an average of 3 over two.
    const s = swiss5();
    const rows = [
      row("A", 1, 2, 2, [5, 0]),
      row("E", 2, 2, 2, [4, 0]),
      row("C", 3, 1, 2, [3, 2]),
      row("D", 4, 1, 2, [3, 3]),
      row("B", 5, 0, 2, [0, 4]),
    ];
    const scored = must(view({ ...s, rows, meta: { swissRounds: 3, pointsRule: scoredRule([3, 0]) } })).rows.D!;
    expect(scored.whatIf).toBe(`If you finish level on points with Ed, ${RULE} decides. Now: you 0, Ed +4.`);
    expect(scored.whatIfAssumption).toBeNull();
    const unscored = must(view({ ...s, rows, meta: { swissRounds: 3, pointsRule: scoredRule() } })).rows.D!;
    expect(unscored.whatIf).toBe(`If you finish level on points with Ed, ${RULE} decides: win your next match by 5 or more to finish ahead.`);
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
    expect(scored.whatIf).toBe("If you finish level on points with Bo, goals/runs scored decides. Now: you 1, Bo 4.");
    const unscored = must(view({ ...o, fixtures, meta: { pointsRule: scoredRule() } }, { cascade })).rows.D!;
    expect(unscored.whatIf).toBe("If you finish level on points with Bo, goals/runs scored decides: win your next match by 1 or more to finish ahead.");
  });

  // Fix round 2: the rule's score counts only where the what-if READS it.
  // `applyPointsRule` writes it to `for`/`against`/`diff` alone; `metricOf`
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
  /** What `applyPointsRule` adds for a scored forfeit. */
  const ruleAward = (mine: number, theirs: number): Metrics => ({ for: mine, against: theirs, diff: mine - theirs });

  it("a football bye under the rule: `gf`/`gd` hide the rule's score, so the bye stays out of the average", () => {
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
    const rows = (scored: boolean) => [
      ledgerRow("A", 1, 2, 2, 2 * W, goals(5, 0)),
      ledgerRow("D", 2, 2, 2, 2 * W, { ...goals(4, 0), ...(scored ? ruleAward(3, 0) : {}) }),
      ledgerRow("C", 3, 1, 2, W, goals(2, 2)),
      ledgerRow("B", 4, 1, 2, W, { ...goals(0, 3), ...(scored ? ruleAward(3, 0) : {}) }),
      ledgerRow("E", 5, 0, 2, 0, goals(0, 6)),
    ];
    const over = { cascade: ["points", "diff", "for"], bounds: FB, awardAddsToLedger: divisionAwardAddsToLedger(FOOTBALL, {}) };
    const target = `If you finish level on points with Cy, ${RULE} decides: lose your next match by no more than 3 to finish ahead.`;
    const plain = must(view({ kind: "swiss", rows: rows(false), fixtures }, over)).rows.D!;
    expect(plain.whatIf).toBe(target);
    const scored = must(view({ kind: "swiss", rows: rows(true), fixtures, meta: { pointsRule: scoredRule([3, 0]) } }, over)).rows.D!;
    expect(scored.whatIf).toBe(target);
  });
  it("a badminton walkover under the rule: set ratio reads no goals, so the walkover stays out of the average", () => {
    // open4 with r1's A–D a walkover: r1 C 2–1 B; r2 A 2–0 C, B 2–1 D. Di's
    // sets (1–2) are ONE real match's; Bo is 3–3. A win by 2 fits one 3-set
    // match (3.5/2.5 > 1); counted as two matches it does not, and the what-if
    // falls back to the rule and values.
    const BB = divisionPointsBounds(BADMINTON, {})!;
    const bw = BB.winFloor;
    // Wins only, as badminton's own bounds are — else `wins` decides, not set ratio.
    const winsOnlyRule = {
      base: { win: bw, draw: 0, loss: 0 },
      bonuses: [],
      forfeit: { winnerPoints: bw, loserPoints: 0, awardScore: [3, 0] as [number, number] },
    };
    const sets = (w: number, l: number): Metrics => ({ sets_won: w, sets_lost: l });
    const rows = (scored: boolean) => [
      ledgerRow("A", 1, 2, 2, 2 * bw, { ...sets(2, 0), ...(scored ? ruleAward(3, 0) : {}) }),
      ledgerRow("B", 2, 1, 2, bw, sets(3, 3)),
      ledgerRow("C", 3, 1, 2, bw, sets(2, 3)),
      ledgerRow("D", 4, 0, 2, 0, { ...sets(1, 2), ...(scored ? ruleAward(0, 3) : {}) }),
    ];
    const fixtures = [walkover(1, "A", "D"), won(1, "C", "B"), won(2, "A", "C"), won(2, "B", "D"), open(3, "A", "B"), open(3, "C", "D")];
    const over = { cascade: [...BADMINTON.defaultTiebreakers], bounds: BB, awardAddsToLedger: divisionAwardAddsToLedger(BADMINTON, {}) };
    const target = "If you finish level on points with Bo, set ratio decides: win your next match by 2 or more to finish ahead.";
    const plain = must(view({ kind: "league", rows: rows(false), fixtures }, over)).rows.D!;
    expect(plain.whatIf).toBe(target);
    const scored = must(view({ kind: "league", rows: rows(true), fixtures, meta: { pointsRule: winsOnlyRule } }, over)).rows.D!;
    expect(scored.whatIf).toBe(target);
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
    const cascade = [...BADMINTON.defaultTiebreakers];
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
    const winsOnly = { base: { win: W, draw: 0, loss: 0 }, bonuses: [] };
    const ruled = must(view({ ...open4(), meta: { pointsRule: winsOnly } }, { cascade })).rows.D!;
    expect(ruled.whatIf).toContain(`${RULE} decides`);
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
    expect(settled.rows.A).toMatchObject({ label: "Through", headline: "Through to Finals, whatever happens next." });
    expect(settled.rows.D).toMatchObject({ label: "Out", headline: "Can no longer finish in the top 1." });
  });
  it("nobody still in has a match left (only two departed entrants' match is open): the cut line drops the count", () => {
    const s = rr4(2);
    const fixtures = [...s.fixtures.filter((f) => f.round_no < 3), won(3, "A", "B"), open(3, "C", "D")];
    const rows = [row("A", 1, 3, 3), row("B", 2, 2, 3), row("C", 3, 0, 2), row("D", 4, 0, 2)];
    const v = must(view({ ...s, rows, fixtures, statuses: { C: "withdrawn", D: "withdrawn" } }));
    expect(v.table.label).toBe("Top 1 go through to Finals");
    expect(v.rows.A!.status).toBe("through");
  });
  it("Spanish: the locale path resolves every string in the org's language", () => {
    const v = must(view(swiss4(), {}, es as Dict));
    expect(v.rows.A!.label).toBe("Gana y pasa");
    expect(v.rows.A!.ariaLabel).toBe("Posición 1, Gana y pasa, ver detalles");
    expect(v.table.label).toBe("Los 2 primeros pasan a Finals · queda 1 ronda");
    expect(v.rows.D!.ifYouLose).toBe("Si pierdes tu próximo partido: Eliminado.");
  });
});

describe("copy coverage", () => {
  const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  const qualKeys = Object.keys(en).filter((k) => k.startsWith("table.qual."));
  it("every table.qual key exists in es/fr/nl with the same placeholders", () => {
    expect(qualKeys.length).toBe(26);
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
