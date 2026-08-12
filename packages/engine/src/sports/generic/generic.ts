// Generic fallback module ≈ v1 behaviour — spec 04 §8. Reproduces v1
// semantics (win_loss / score result modes) so existing users lose nothing on
// cutover; the migration target for all v1 tournaments (PROMPT-15). First
// real module on the contract — proves PROMPT-03.
import { z } from "zod";
import { EngineError } from "../../core/errors.ts";
import { foldMatch, type CoreEv, type EventEnvelope } from "../../core/events.ts";
import type { Rng } from "../../core/rng.ts";
import {
  EntrantId,
  type LineupPair,
  type MatchOutcome,
  type ScoreSummary,
  type StageCtx,
  type StageKind,
  type StandingsDelta,
} from "../../core/types.ts";
import type {
  ModuleEvent,
  PadAction,
  PadGate,
  PadPanel,
  PadSpec,
  SportModule,
} from "../../sport/module.ts";
import { personsForEntrant, type PlayerStatRow, type PlayerStatsFoldCtx } from "../../stats/stats.ts";

// spec 04 §8 Cfg
export const GenericCfg = z.object({
  resultMode: z.enum(["win_loss", "score"]),
  allowDraws: z.boolean(),
  // Defaults (3/1/0, no carry) are the v1 league-table values — they let a
  // partial config (variant presets, unknown-sport /start fallback) parse
  // instead of failing CONFIG_INVALID at createDivision.
  points: z
    .object({
      w: z.number().int().nonnegative(),
      d: z.number().int().nonnegative(),
      l: z.number().int().nonnegative(),
    })
    .default({ w: 3, d: 1, l: 0 }),
  // v1 stepladder progress-score carry; stored for the PROMPT-15 cutover,
  // no scoring effect inside the module.
  progressScore: z.boolean().default(false),
});
export type GenericCfg = z.infer<typeof GenericCfg>;

// spec 04 §8 Ev — single terminal event; p1 = home, p2 = away (v1 naming).
export const GenericResult = z.strictObject({
  winnerId: EntrantId.optional(),
  p1Score: z.number().int().nonnegative().optional(),
  p2Score: z.number().int().nonnegative().optional(),
  isDraw: z.boolean().optional(),
});

// W4 — one scoring action, the minimum a scorer of an UNMODELLED sport needs
// beyond a final card: a running tally they can press during play, with
// optional credit to the person who did it. Deliberately the only structure
// generic owns — no periods, no possession, no turn order (see DOMAIN.md).
// `points` may be negative to correct a mis-press; the fold refuses a tally
// below zero. Branches are told apart structurally: a result card never
// carries `by`, and the strict action branch rejects every result field.
export const GenericScore = z.strictObject({
  by: EntrantId,
  points: z
    .number()
    .int()
    .refine((points) => points !== 0, { message: "points must be non-zero" }),
  person: z.string().min(1).optional(),
});
export type GenericScore = z.infer<typeof GenericScore>;

export const GenericEvent = z.union([GenericResult, GenericScore]);
export type GenericEv = z.infer<typeof GenericEvent>;

export interface GenericState {
  phase: "pre" | "live" | "done" | "final";
  cfg: GenericCfg;
  entrants: { home: string; away: string };
  score: { home: number; away: number } | null;
  outcome: MatchOutcome | null;
  // W4 — the live tally. Absent until a generic.score event lands, so a
  // result-only stream folds to exactly the state it always did.
  running?: { home: number; away: number };
}

type Side = "home" | "away";

function opponent(side: Side): Side {
  return side === "home" ? "away" : "home";
}

function sideOf(state: GenericState, entrantId: string): Side {
  if (entrantId === state.entrants.home) return "home";
  if (entrantId === state.entrants.away) return "away";
  throw new EngineError("INVALID_EVENT", `unknown entrant "${entrantId}"`, { entrantId });
}

function invalid(message: string, data?: unknown): never {
  throw new EngineError("INVALID_EVENT", message, data);
}

// Cross-checks a generic.result payload against the config mode and returns
// the decided state pieces. spec 04 §8; consistency rules mirror v1: a card
// that contradicts itself (winnerId vs scores vs isDraw) is rejected.
function applyResult(state: GenericState, payload: z.infer<typeof GenericResult>): GenericState {
  const { resultMode, allowDraws } = state.cfg;
  const hasP1 = payload.p1Score !== undefined;
  const hasP2 = payload.p2Score !== undefined;
  if (hasP1 !== hasP2) invalid("p1Score and p2Score must be given together");
  // W4 — a result card with no scores settles from the running tally when one
  // was kept; the consistency rules below then apply to it unchanged.
  const score = hasP1
    ? { home: payload.p1Score as number, away: payload.p2Score as number }
    : (state.running ?? null);

  let winnerSide: Side | null; // null = draw
  if (resultMode === "score") {
    if (!score) invalid("score mode requires p1Score and p2Score");
    winnerSide = score.home === score.away ? null : score.home > score.away ? "home" : "away";
    if (winnerSide === null && !allowDraws) {
      invalid("draws are not allowed in this division", { score });
    }
  } else {
    // S6/#416 (W5): also reads as a draw when `isDraw` is PRESENT (even as
    // `false`) and `winnerId` is absent — the padSpec field DSL has no
    // "constant" PadField kind (a toggle is genuinely bivalent, `fc.boolean()`
    // in the conformance property test), so a "Draw" action's `isDraw` toggle
    // field could never be pinned to always fire `true`.
    //
    // Fixed post-review (CI caught it): the first cut keyed this off
    // `winnerId === undefined` ALONE, with no requirement that `isDraw` was
    // even sent. That silently swallowed a real, pre-existing validation path
    // — a payload with neither field (e.g. a score-shaped `{p1Score,
    // p2Score}` mistakenly posted against a `win_loss` division) now read as
    // an implicit draw and threw "draws are not allowed in this division"
    // instead of the clearer, actionable "win_loss mode requires winnerId or
    // isDraw" (`apps/web`'s `config-snapshot.test.ts` pinned exactly this
    // message for exactly that shape). Requiring the `isDraw` KEY to be
    // present distinguishes "a Draw action fired with a false toggle" from
    // "no draw signal was sent at all" — the only two cases this fold sees
    // and the only distinction that matters. Every payload previously
    // accepted (`winnerId` set, or `isDraw: true`) still means exactly what
    // it meant.
    const declaredDraw =
      payload.isDraw === true || (payload.isDraw !== undefined && payload.winnerId === undefined);
    if (declaredDraw && payload.winnerId !== undefined) {
      invalid("isDraw and winnerId are mutually exclusive");
    }
    if (!declaredDraw && payload.winnerId === undefined) {
      invalid("win_loss mode requires winnerId or isDraw");
    }
    if (declaredDraw && !allowDraws) invalid("draws are not allowed in this division");
    winnerSide = declaredDraw ? null : sideOf(state, payload.winnerId as string);
  }

  // Redundant fields must agree with the derived result.
  if (payload.winnerId !== undefined && winnerSide !== sideOf(state, payload.winnerId)) {
    invalid("winnerId contradicts the scores", { payload });
  }
  // Only an EXPLICIT `isDraw: true` can contradict a decisive result. The
  // reverse (`isDraw: false` while the derived result IS a draw) was already
  // unreachable before S6 in win_loss mode — mutually exclusive with
  // `winnerId` and, absent a `winnerId`, intercepted earlier by "win_loss
  // mode requires winnerId or isDraw" — and after the S6 widening above,
  // `isDraw: false` with no `winnerId` is now a DELIBERATE implicit-draw
  // shape (a padSpec toggle field that lands on `false` must still build a
  // valid draw payload), so it must not throw here either.
  if (payload.isDraw === true && winnerSide !== null) {
    invalid("isDraw contradicts the result", { payload });
  }
  if (score && winnerSide !== null && score[winnerSide] <= score[opponent(winnerSide)]) {
    invalid("winnerId contradicts the scores", { payload });
  }
  if (score && winnerSide === null && score.home !== score.away) {
    invalid("isDraw contradicts the scores", { payload });
  }

  const outcome: MatchOutcome =
    winnerSide === null
      ? { kind: "draw" }
      : {
          kind: "win",
          winner: state.entrants[winnerSide],
          loser: state.entrants[opponent(winnerSide)],
          method: "regulation",
        };
  return { ...state, phase: "done", score, outcome };
}

// W4 — one scoring action folded into the running tally. A tally that would go
// below zero is a mis-entered correction, not a score.
function applyScore(state: GenericState, payload: GenericScore): GenericState {
  if (state.phase !== "pre" && state.phase !== "live") {
    throw new EngineError("WRONG_PHASE", "match already over");
  }
  const side = sideOf(state, payload.by);
  const base = state.running ?? { home: 0, away: 0 };
  const next = base[side] + payload.points;
  if (next < 0) invalid("a scoring correction cannot take a side below zero", { next });
  return { ...state, running: { ...base, [side]: next } };
}

function sideLine(state: GenericState, side: Side): string {
  if (state.score) return String(state.score[side]);
  const outcome = state.outcome;
  // A live tally renders while the fixture is undecided; a decided fixture
  // always renders its result, never the tally.
  if (!outcome) return state.running ? String(state.running[side]) : "—";
  switch (outcome.kind) {
    case "win":
      return outcome.winner === state.entrants[side] ? "W" : "L";
    case "draw":
    case "tie":
      return "D";
    case "no_result":
      return "N/R";
    case "award":
      return outcome.winner === state.entrants[side] ? "W/O" : "L";
  }
}

function zeroMetrics(): Record<string, number> {
  return { for: 0, against: 0, diff: 0 };
}

function sideMetrics(state: GenericState, side: Side): Record<string, number> {
  if (!state.score) return zeroMetrics();
  const forScore = state.score[side];
  const against = state.score[opponent(side)];
  return { for: forScore, against, diff: forScore - against };
}

// ---------------------------------------------------------------------------
// S6/#416 (W5) — padSpec. Pure function of resolved cfg. The boundary this
// module's own DOMAIN.md draws ("generic will not model anything with
// structure") applies here too: no per-sport vocabulary, just the flat
// tally + terminal card the module actually folds.
// ---------------------------------------------------------------------------

export const GENERIC_EVENT_SCHEMAS: Readonly<Record<string, z.ZodTypeAny>> = {
  "generic.result": GenericResult,
  "generic.score": GenericScore,
};

// Sentinels for fields with no cfg knob to derive a bound from (GenericCfg
// has no score cap) — generous, not a rules number, only a property-testing
// upper bound. Mirrors cricket's UNBOUNDED_BALLS_SENTINEL / MAX_PLAUSIBLE_RUNS.
const MAX_PLAUSIBLE_SCORE = 500; // a final score.{p1,p2}Score
const MAX_TALLY_STEP = 50; // a single generic.score press

export function padSpec(cfg: GenericCfg): PadSpec {
  // --- Live: the running tally, both modes (DOMAIN.md: "all") --------------
  // `points` is `.refine(p => p !== 0)` — a single field spanning both signs
  // would let the property test roll 0 and fail; split at zero instead, the
  // same shape as carrom's credit/deduct adjustment actions.
  const addPointsAction: PadAction = {
    type: "generic.score",
    labelKey: { key: "pad.generic.action.addPoints", label: "Add points" },
    fields: [{ kind: "number", path: "points", min: 1, max: MAX_TALLY_STEP }],
    attribution: [
      { kind: "side", path: "by" },
      { kind: "person", path: "person" },
    ],
  };
  const correctPointsAction: PadAction = {
    type: "generic.score",
    labelKey: { key: "pad.generic.action.correctPoints", label: "Correct (subtract)" },
    fields: [{ kind: "number", path: "points", min: -MAX_TALLY_STEP, max: -1 }],
    attribution: [
      { kind: "side", path: "by" },
      { kind: "person", path: "person" },
    ],
  };

  // --- Live/post: the terminal result — shape depends on cfg.resultMode ---
  // cfg-only inclusion throughout (cricket's declare/followOn precedent): a
  // score-mode field set or a win_loss field set the fold would refuse on
  // EVERY cfg the other mode renders for is never built at all.
  const scoreEntryAction: PadAction = {
    type: "generic.result",
    labelKey: { key: "pad.generic.action.scoreEntry", label: "Enter final score" },
    fields: [
      { kind: "number", path: "p1Score", min: 0, max: MAX_PLAUSIBLE_SCORE },
      { kind: "number", path: "p2Score", min: 0, max: MAX_PLAUSIBLE_SCORE },
    ],
    attribution: [],
  };
  const settleFromTallyAction: PadAction = {
    type: "generic.result",
    labelKey: { key: "pad.generic.action.settleFromTally", label: "Settle from tally" },
    fields: [],
    attribution: [],
  };
  const decisiveResultAction: PadAction = {
    type: "generic.result",
    labelKey: { key: "pad.generic.action.decisive", label: "Result" },
    fields: [],
    attribution: [{ kind: "side", path: "winnerId" }],
  };
  // `isDraw` is a toggle — genuinely bivalent (`fc.boolean()`), so it cannot
  // be pinned to always fire `true`. `applyResult`'s S6 widening (this
  // file, `declaredDraw`) makes "no winnerId" alone read as a draw
  // regardless of which way the toggle lands, so this action always builds
  // a valid draw payload either way.
  const drawAction: PadAction = {
    type: "generic.result",
    labelKey: { key: "pad.generic.action.draw", label: "Draw" },
    fields: [{ kind: "toggle", path: "isDraw" }],
    attribution: [],
  };

  const resultPanels: PadPanel[] =
    cfg.resultMode === "score"
      ? [
          {
            labelKey: { key: "pad.generic.panel.score", label: "Score" },
            phase: "live",
            layout: "primary",
            actions: [scoreEntryAction],
          },
          {
            labelKey: { key: "pad.generic.panel.settle", label: "Settle from tally" },
            phase: "live",
            layout: "grid",
            actions: [settleFromTallyAction],
            // Genuinely state-dependent — DOMAIN.md: "the tally alone never
            // ends a fixture", and `{}` is refused unless `state.running` is
            // already set (`applyResult`: `score = hasP1 ? ... : (state.running
            // ?? null)`, `if (!score) invalid(...)`).
            gate: { op: "path-truthy", path: "state.running" } satisfies PadGate,
          },
        ]
      : [
          {
            labelKey: { key: "pad.generic.panel.result", label: "Result" },
            phase: "live",
            layout: "primary",
            actions: [decisiveResultAction],
          },
          // cfg-only inclusion: offering a draw action the fold refuses on
          // every cfg it would render for (`allowDraws: false`) is exactly
          // the anti-pattern cricket's declare/followOn actions avoid.
          ...(cfg.allowDraws
            ? [
                {
                  labelKey: { key: "pad.generic.panel.draw", label: "Draw" },
                  phase: "live" as const,
                  layout: "grid" as const,
                  actions: [drawAction],
                },
              ]
            : []),
        ];

  const panels: PadPanel[] = [
    {
      labelKey: { key: "pad.generic.panel.tally", label: "Tally" },
      phase: "live",
      layout: "grid",
      actions: [addPointsAction, correctPointsAction],
    },
    ...resultPanels,
  ];

  return {
    panels,
    // Modelled on generic's OWN existing (untouched) `fidelityTiers` (below):
    // tier 0 is the terminal card alone, tier 1 adds the running tally.
    // Neither entry carries an entitlement — the fallback ships free at
    // every band it currently declares.
    fidelity: {
      "generic.result": 0,
      "generic.score": 1,
    },
    fidelityEntitlements: {},
  };
}

// ---------------------------------------------------------------------------
// S8/#417 — playerStats.folded: win/draw/loss + points_for, resolved from the
// entrant roster (`PlayerStatsFoldCtx`). `GenericResult` names no explicit
// person at all (only `GenericScore.person`, which feeds the pre-existing
// `points`/`scores` metrics below) — the terminal result is entrant-only by
// design (DOMAIN.md: "the terminal result stays entrant-only") — so this is
// the ONLY attribution source for these four keys, and it needs the SETTLED
// fixture: which resultMode is live, whether a tally settled it, and the
// S6/#416 "isDraw key must be PRESENT" trap (`applyResult`, above) are
// already folded into `generic.apply()`. Re-deriving any of that here would
// be a second implementation of the same rules that can silently disagree
// with the first — reopening the exact S6 defect this fold must not regress
// — so this replays the SAME apply() the write path folds through, via
// `foldMatch`, over a SYNTHETIC two-entrant lineup (generic never reads
// `slots`), instead of hand-rolling any of it.
// ---------------------------------------------------------------------------

function foldGenericStats(events: readonly EventEnvelope[], ctx: PlayerStatsFoldCtx): PlayerStatRow[] {
  const rows = new Map<string, Record<string, number>>();
  const bump = (personId: string, key: string, by: number): void => {
    const stats = rows.get(personId) ?? {};
    stats[key] = (stats[key] ?? 0) + by;
    rows.set(personId, stats);
  };
  // Mandatory kind guard (PlayerStatsFoldCtx's own contract, applied via the
  // shared `personsForEntrant` helper, S8/#417 W6 fix 5, rather than a local
  // re-derivation): a "team" entrant credits nobody even when `personsOf`
  // hands back a full roster — but the replay below still uses the
  // entrant's real id, so a mixed team/individual fixture still resolves
  // the correct winner and still credits the individual side.
  const creditEach = (
    entrant: PlayerStatsFoldCtx["entrants"][number],
    key: string,
    by: number,
  ): void => {
    for (const personId of personsForEntrant(ctx, entrant.id)) bump(personId, key, by);
  };

  // No parse/replay guarantee is ever assumed: `ctx.cfg` is `unknown` by
  // design, and a replay can throw for reasons that have nothing to do with
  // the result (an unsettled tally, a payload the S6 fix refuses, an
  // out-of-order test fixture, …). Either way this must never throw OUT of
  // the fold (house rule: a data-derived throw inside a fold permanently
  // bricks a recorded fixture) — an unparseable cfg or a rejected replay
  // just leaves every key this fold owns uncredited for that fixture: no
  // signal in, no fabricated W/D/L for a match this couldn't settle (the
  // same coverage discipline as a partially recorded result, S2/#430).
  const cfgParsed = GenericCfg.safeParse(ctx.cfg);
  const home = ctx.entrants[0];
  const away = ctx.entrants[1];
  if (cfgParsed.success && ctx.entrants.length === 2 && home !== undefined && away !== undefined) {
    const lineups: LineupPair = {
      home: { entrantId: home.id, slots: [] },
      away: { entrantId: away.id, slots: [] },
    };
    try {
      const state = foldMatch(generic, cfgParsed.data, lineups, events);
      const outcome = state.outcome;
      // Once the fixture IS decided, every side is credited explicitly —
      // including a 0 for whoever did not win/draw — since `GenericResult`
      // has no competing explicit-person field for any of these three keys
      // to protect (unlike this wave's boardgame sibling), so there is no
      // stray-row risk in writing the zero.
      let wdl: { wHome: number; wAway: number; dEach: number; lHome: number; lAway: number } | null = null;
      if (outcome !== null && (outcome.kind === "win" || outcome.kind === "award")) {
        const winnerIsHome = outcome.winner === home.id;
        wdl = winnerIsHome
          ? { wHome: 1, wAway: 0, dEach: 0, lHome: 0, lAway: 1 }
          : { wHome: 0, wAway: 1, dEach: 0, lHome: 1, lAway: 0 };
      } else if (outcome !== null && (outcome.kind === "draw" || outcome.kind === "tie")) {
        wdl = { wHome: 0, wAway: 0, dEach: 1, lHome: 0, lAway: 0 };
      } else if (outcome !== null && outcome.kind === "no_result") {
        // Generic's OWN standingsDelta already zero-fills w/d/l for
        // no_result (`zeroMetrics()` above) — matching that here rather
        // than leaving the fold silent for this one outcome kind.
        wdl = { wHome: 0, wAway: 0, dEach: 0, lHome: 0, lAway: 0 };
      }
      // outcome === null (still live) — undetermined, no W/D/L credit yet.
      if (wdl !== null) {
        creditEach(home, "wins", wdl.wHome);
        creditEach(away, "wins", wdl.wAway);
        creditEach(home, "draws", wdl.dEach);
        creditEach(away, "draws", wdl.dEach);
        creditEach(home, "losses", wdl.lHome);
        creditEach(away, "losses", wdl.lAway);
      }
      if (state.score !== null) {
        creditEach(home, "points_for", state.score.home);
        creditEach(away, "points_for", state.score.away);
      }
    } catch {
      // Un-derivable this fixture — no rows from this branch.
    }
  }

  return [...rows.entries()].map(([personId, stats]) => ({ personId, stats }));
}

export const generic: SportModule<GenericCfg, GenericEv, GenericState> = {
  key: "generic",
  version: "1.0.0",
  configSchema: GenericCfg,
  eventSchema: GenericEvent,
  eventSchemas: GENERIC_EVENT_SCHEMAS,
  padSpec,
  // spec 04 §8 / doc 02 §3 — generic tracks entrants, not people; adapters
  // pass a single placeholder slot per side (like chess: lineup size 1).
  positions: { groups: [], lineup: { size: 1, benchMax: 0 } },
  variants: {
    // Complete configs (not leaning on the schema defaults): these rows are
    // synced into sport_variants and served as default_config to clients.
    win_loss: {
      resultMode: "win_loss",
      allowDraws: false,
      points: { w: 3, d: 1, l: 0 },
      progressScore: false,
    },
    score: {
      resultMode: "score",
      allowDraws: true,
      points: { w: 3, d: 1, l: 0 },
      progressScore: false,
    },
  },

  init(cfg, lineups: LineupPair): GenericState {
    return {
      phase: "pre",
      cfg,
      entrants: { home: lineups.home.entrantId, away: lineups.away.entrantId },
      score: null,
      outcome: null,
    };
  },

  apply(state, ev: EventEnvelope<GenericEv | CoreEv>): GenericState {
    switch (ev.type) {
      case "core.start": {
        if (state.phase !== "pre") throw new EngineError("WRONG_PHASE", "already started");
        return { ...state, phase: "live" };
      }
      case "generic.result": {
        if (state.phase !== "pre" && state.phase !== "live") {
          throw new EngineError("WRONG_PHASE", "result already recorded");
        }
        const parsed = GenericResult.safeParse(ev.payload);
        if (!parsed.success) {
          invalid("invalid generic.result payload", { issues: parsed.error.issues });
        }
        return applyResult(state, parsed.data);
      }
      case "generic.score": {
        const parsed = GenericScore.safeParse(ev.payload);
        if (!parsed.success) {
          invalid("invalid generic.score payload", { issues: parsed.error.issues });
        }
        return applyScore(state, parsed.data);
      }
      case "core.forfeit": {
        if (state.phase !== "pre" && state.phase !== "live") {
          throw new EngineError("WRONG_PHASE", "match already over");
        }
        const by = (ev.payload as { by: string }).by;
        const winner = state.entrants[opponent(sideOf(state, by))];
        return { ...state, phase: "done", outcome: { kind: "award", winner } };
      }
      case "core.abandon": {
        if (state.phase !== "pre" && state.phase !== "live") {
          throw new EngineError("WRONG_PHASE", "match already over");
        }
        return { ...state, phase: "done", outcome: { kind: "no_result" } };
      }
      case "core.finalize": {
        if (state.phase !== "done") throw new EngineError("WRONG_PHASE", "not decided");
        return { ...state, phase: "final" };
      }
      case "core.note":
      case "core.award":
        return state; // annotation only, no state effect (spec 03 §2)
      default:
        invalid(`unknown event type "${ev.type}"`);
    }
  },

  outcome: (state) => state.outcome,

  // §9.5 — defined at every prefix; before any result the headline is "—".
  summary(state): ScoreSummary {
    const home = sideLine(state, "home");
    const away = sideLine(state, "away");
    return {
      headline: `${home} — ${away}`,
      perSide: [
        { entrantId: state.entrants.home, line: home },
        { entrantId: state.entrants.away, line: away },
      ],
    };
  },

  // Pair returned [home, away]. v1 semantics: no_result shares draw points
  // without counting a draw; award pays full win/loss points on zero metrics.
  standingsDelta(outcome, cfg, _ctx: StageCtx, state): [StandingsDelta, StandingsDelta] {
    const points = cfg.points;
    const build = (
      side: Side,
      w: number,
      d: number,
      l: number,
      pts: number,
      metrics: Record<string, number>,
    ): StandingsDelta => ({
      entrantId: state.entrants[side],
      played: 1,
      won: w,
      drawn: d,
      lost: l,
      points: pts,
      metrics,
    });

    switch (outcome.kind) {
      case "win":
      case "award": {
        const winnerSide = sideOf(state, outcome.winner);
        const loserSide = opponent(winnerSide);
        const winner = build(winnerSide, 1, 0, 0, points.w, sideMetrics(state, winnerSide));
        const loser = build(loserSide, 0, 0, 1, points.l, sideMetrics(state, loserSide));
        return winnerSide === "home" ? [winner, loser] : [loser, winner];
      }
      case "draw":
      case "tie":
        return [
          build("home", 0, 1, 0, points.d, sideMetrics(state, "home")),
          build("away", 0, 1, 0, points.d, sideMetrics(state, "away")),
        ];
      case "no_result":
        return [
          build("home", 0, 0, 0, points.d, zeroMetrics()),
          build("away", 0, 0, 0, points.d, zeroMetrics()),
        ];
    }
  },

  metrics: [
    { key: "for", label: "For", direction: "desc" },
    { key: "against", label: "Against", direction: "asc" },
    { key: "diff", label: "Difference", direction: "desc" },
  ],
  defaultTiebreakers: ["points", "diff", "for", "h2h_points", "lots"],

  // Draws only where the format can absorb them — never in eliminations.
  supportsDraws(cfg, stage: StageKind) {
    return (
      cfg.allowDraws && stage !== "knockout" && stage !== "double_elim" && stage !== "stepladder"
    );
  },

  // §9.3 — decisive total w+l; shared total 2d (draw/tie/no_result — abandon
  // can produce no_result even when allowDraws is false).
  declaredPointsSets(cfg) {
    return [...new Set([cfg.points.w + cfg.points.l, cfg.points.d * 2])];
  },

  // doc 14 §2 — generic tops out at Tier 1; W4 puts the running tally there
  // (tier 0 stays "one final card, nothing else").
  fidelityTiers: [
    { tier: 0, eventTypes: ["generic.result"] },
    { tier: 1, eventTypes: ["generic.result", "generic.score"] },
  ],
  officialLabel: { scorer: "Scorer" }, // doc 13 §1

  // W4 — the only person credit the fallback offers: who performed a scoring
  // action. Anything richer means the sport deserves its own module.
  // S8/#417 — `wins`/`draws`/`losses`/`points_for` join the terminal result
  // (entrant-only, per the boundary above) to the roster (`PlayerStatsFoldCtx`)
  // — see `foldGenericStats`. `points`/`scores` are untouched: they credit
  // the ACTOR of a scoring action, a different fact from who won the match.
  playerStats: {
    metrics: [
      {
        key: "points", label: "Points", from: "generic.score", field: "person",
        agg: "sum", sumField: "points",
      },
      { key: "scores", label: "Scoring actions", from: "generic.score", field: "person", agg: "count" },
    ],
    folded: {
      keys: [
        { key: "wins", label: "Wins" },
        { key: "draws", label: "Draws" },
        { key: "losses", label: "Losses" },
        { key: "points_for", label: "Points for" },
      ],
      fold: foldGenericStats,
    },
  },

  // spec 03 §6 — valid-event generator for the conformance kit.
  arbitraryEvent(state, rng: Rng): ModuleEvent<GenericEv> | null {
    if (state.phase === "done" || state.phase === "final") return null;
    if (state.phase === "pre" && rng() < 0.3) return { type: "core.start", payload: {} };
    const roll = rng();
    if (roll < 0.08) {
      const by = rng() < 0.5 ? state.entrants.home : state.entrants.away;
      return { type: "core.forfeit", payload: { by, reason: "walkover" } };
    }
    if (roll < 0.15) return { type: "core.abandon", payload: { reason: "rain" } };
    // W4 — a scoring action on the running tally. Person ids follow the
    // testkit lineup convention; generic holds no roster.
    const tallyOne = (): ModuleEvent<GenericEv> => {
      const side: Side = rng() < 0.5 ? "home" : "away";
      return {
        type: "generic.score",
        payload: {
          by: state.entrants[side],
          points: 1 + Math.floor(rng() * 3),
          person: `${state.entrants[side]}-p1`,
        },
      };
    };
    if (roll < 0.55) return tallyOne();

    const running = state.running;
    if (running !== undefined) {
      // Settle from the tally — the result card must never contradict it.
      const level = running.home === running.away;
      if (level && !state.cfg.allowDraws) return tallyOne();
      if (state.cfg.resultMode === "score") return { type: "generic.result", payload: {} };
      if (level) return { type: "generic.result", payload: { isDraw: true } };
      const leader: Side = running.home > running.away ? "home" : "away";
      return { type: "generic.result", payload: { winnerId: state.entrants[leader] } };
    }

    if (state.cfg.resultMode === "score") {
      const p1 = Math.floor(rng() * 6);
      let p2 = Math.floor(rng() * 6);
      if (!state.cfg.allowDraws && p1 === p2) p2 += 1;
      return { type: "generic.result", payload: { p1Score: p1, p2Score: p2 } };
    }
    if (state.cfg.allowDraws && rng() < 0.25) {
      return { type: "generic.result", payload: { isDraw: true } };
    }
    const winnerId = rng() < 0.5 ? state.entrants.home : state.entrants.away;
    return { type: "generic.result", payload: { winnerId } };
  },
};
