// The division builder's match counts, rounds and time estimate (Match Day C9, owner 2026-11-02: "a visual picker with
// shape diagrams and match counts"; the Review step's receipt of "stages, matches, rounds and a time estimate").
//
// A CLIENT estimate of the draw the server generates, read off the template's own stage graph (buildTemplateStages),
// never a per-template table: a stage's entrant count flows from the previous stage through its progression take rule,
// exactly as the server sizes a later stage. The oracle is the real draw (format-estimate.test.ts compares every drawn
// stage with previewDivisionFixtures, and americano with the engine's generateAmericano); Swiss and the double
// elimination's non-power-of-two fields are pinned to the rulebook. Pure, so the client can call it on every keystroke.
import { buildTemplateStages, type StageDraft, type TemplateKnobs } from "@/lib/format-templates";

export interface StageEstimate {
  kind: string;
  name: string;
  /** Entrants (or qualifiers) the stage is drawn for. */
  entrants: number;
  /** Matches actually played (byes excluded); null when the format has no fixed draw (ladder). */
  matches: number | null;
  /** Rounds of play, in order; null when open-ended. */
  rounds: number | null;
  /** Fewest matches any entrant of this stage is guaranteed. */
  minGames: number | null;
}

export interface FormatEstimate {
  stages: StageEstimate[];
  matches: number | null;
  rounds: number | null;
  /** Fewest matches every entrant is guaranteed (the first stage's floor). */
  minGames: number | null;
}

const log2ceil = (k: number) => (k <= 1 ? 0 : Math.ceil(Math.log2(k)));
const nextPow2 = (k: number) => 2 ** log2ceil(k);
const roundRobinRounds = (k: number) => (k < 2 ? 0 : k % 2 === 0 ? k - 1 : k);
const numberOr = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/** A pool split the way the server's snakeDistribute deals it: sizes differ by at most one. */
function poolSizes(k: number, pools: number): number[] {
  const p = Math.max(1, Math.min(pools, k));
  return Array.from({ length: p }, (_, i) => Math.floor(k / p) + (i < k % p ? 1 : 0));
}

/** Real round-one matches in a single-elimination draw of k: the padded draw's byes go to the top seeds. */
function roundOneLosers(k: number): number {
  return k < 2 ? 0 : k - nextPow2(k) / 2;
}

function stageEstimate(d: StageDraft, k: number): StageEstimate {
  const base = { kind: d.kind, name: d.name, entrants: k };
  const cfg = d.config ?? {};
  switch (d.kind) {
    case "league": {
      const legs = numberOr(cfg.legs, 1);
      return { ...base, matches: (legs * k * (k - 1)) / 2, rounds: legs * roundRobinRounds(k), minGames: legs * Math.max(0, k - 1) };
    }
    case "group": {
      const legs = numberOr(cfg.legs, 1);
      const sizes = poolSizes(k, numberOr((cfg.pools as { count?: unknown } | undefined)?.count, 2));
      return {
        ...base,
        matches: legs * sizes.reduce((sum, s) => sum + (s * (s - 1)) / 2, 0),
        rounds: legs * Math.max(0, ...sizes.map(roundRobinRounds)),
        minGames: legs * Math.max(0, Math.min(...sizes) - 1),
      };
    }
    case "knockout":
      return { ...base, matches: Math.max(0, k - 1), rounds: log2ceil(k), minGames: k < 2 ? 0 : 1 };
    case "double_elim": {
      // Winners' bracket r rounds, losers' bracket 2(r - 1), the grand final 1. A bracket reset is conditional, so it
      // is not counted.
      const r = log2ceil(k);
      return { ...base, matches: k < 2 ? 0 : 2 * k - 2, rounds: k < 2 ? 0 : 3 * r - 1, minGames: k < 2 ? 0 : 2 };
    }
    case "page_playoff":
      // The Page playoff is a fixed four: qualifier 1, eliminator, qualifier 2, final.
      return k >= 4 ? { ...base, entrants: 4, matches: 4, rounds: 3, minGames: 1 } : { ...base, matches: null, rounds: null, minGames: null };
    case "stepladder":
      return { ...base, matches: Math.max(0, k - 1), rounds: Math.max(0, k - 1), minGames: k < 2 ? 0 : 1 };
    case "swiss": {
      const rounds = numberOr(cfg.rounds, 5);
      return { ...base, matches: Math.floor(k / 2) * rounds, rounds, minGames: rounds - (k % 2) };
    }
    case "americano": {
      // Four players to a court; the engine's own fallbacks when the stage carries neither knob.
      const courts = numberOr(cfg.courtCount, Math.max(1, Math.floor(k / 4)));
      const rounds = numberOr(cfg.rounds, Math.max(3, k - 1));
      const perRound = Math.min(courts, Math.floor(k / 4));
      return { ...base, matches: rounds * perRound, rounds, minGames: k > 0 ? Math.floor((rounds * perRound * 4) / k) : 0 };
    }
    default:
      // ladder (open challenges) and any kind this estimate does not model: no fixed draw.
      return { ...base, matches: null, rounds: null, minGames: null };
  }
}

/** How many of the previous stage's entrants a progression carries forward, the way the server sizes the slots. */
function qualifiers(d: StageDraft, prev: StageEstimate, prevDraft: StageDraft): number {
  const take = d.progression?.sources.flatMap((s) => s.take) ?? [];
  let total = 0;
  for (const rule of take) {
    const r = rule as { kind: string; from?: number; to?: number; n?: number; count?: number; round?: number };
    if (r.kind === "rankRange") total += Math.max(0, numberOr(r.to, 0) - numberOr(r.from, 1) + 1);
    else if (r.kind === "topNPerGroup") {
      const pools = poolSizes(prev.entrants, numberOr((prevDraft.config.pools as { count?: unknown } | undefined)?.count, 1)).length;
      total += numberOr(r.n, 0) * pools;
    } else if (r.kind === "bestNth") total += numberOr(r.count, 0);
    else if (r.kind === "roundLosers") total += Math.min(numberOr(r.count, 0), r.round === 1 ? roundOneLosers(prev.entrants) : 0);
  }
  return Math.min(total, prev.entrants);
}

const sumOrNull = (xs: (number | null)[]) => (xs.some((x) => x === null) ? null : (xs as number[]).reduce((a, b) => a + b, 0));

/** Estimate a stage graph for `entrants` players or teams. */
export function estimateStages(drafts: StageDraft[], entrants: number): FormatEstimate {
  const n = Math.max(0, Math.floor(entrants));
  const stages: StageEstimate[] = [];
  drafts.forEach((d, i) => {
    const k = i === 0 ? n : qualifiers(d, stages[i - 1]!, drafts[i - 1]!);
    stages.push(stageEstimate(d, k));
  });
  return {
    stages,
    matches: sumOrNull(stages.map((s) => s.matches)),
    rounds: sumOrNull(stages.map((s) => s.rounds)),
    minGames: stages[0]?.minGames ?? null,
  };
}

/** Estimate a one-click template at the builder's knobs. */
export function estimateTemplate(templateKey: string, entrants: number, knobs: TemplateKnobs): FormatEstimate {
  return estimateStages(buildTemplateStages(templateKey, knobs), entrants);
}

/** Playing time in minutes on `venues` courts (tables, boards, pitches): stages run one after another, and within a
 *  stage a round cannot start before the previous one ends, so a stage takes at least its rounds and at least its
 *  matches spread over the venues. Null when there is no fixed draw or no venue or match length to plan with. */
export function estimateMinutes(est: FormatEstimate, venues: number, matchMinutes: number): number | null {
  if (!(venues >= 1) || !(matchMinutes > 0)) return null;
  let slots = 0;
  for (const s of est.stages) {
    if (s.matches === null || s.rounds === null) return null;
    slots += Math.max(s.rounds, Math.ceil(s.matches / Math.floor(venues)));
  }
  return slots * matchMinutes;
}
