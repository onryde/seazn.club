import "server-only";
// The division builder's example preview: the same `generate()` over synthetic
// seeded entrants, no DB.

import { progressionSize, type RoundRole, type SourceShape, type TakeRule } from "@seazn/engine/competition";
import { estimatePlateField } from "@/lib/division-builder/format-estimate";
import { msg } from "@/lib/messages";
import { resolveSlotLabel } from "@/lib/slot-label";
import { roundRoleFor, roundRoleLabel } from "@/lib/round-role-label";
import { expandTake } from "../stage-seeding";
import { BRACKET_KINDS, type GenFixture, type ActiveEntrant } from "./types";
import { POOL_KEYS, generate } from "./generators";

// ---------------------------------------------------------------------------
// Example preview (division builder "Show example"). Runs the SAME `generate()`
// the real draw uses, over synthetic seeded entrants, so the shape is identical
// to what the server will produce — only the names are placeholders. No DB.
// ---------------------------------------------------------------------------

export interface PreviewMatch {
  home: string;
  away: string;
}

export interface PreviewSection {
  title: string;
  matches: PreviewMatch[];
}

export interface PreviewPhase {
  title: string;
  note?: string;
  sections: PreviewSection[];
}

export interface PreviewStageInput {
  kind: string;
  name: string;
  config: Record<string, unknown>;
  progression: unknown;
}

/** 0 → A, 25 → Z, 26 → AA … */
function alphaLabel(i: number): string {
  let s = "";
  let n = i + 1;
  while (n > 0) {
    n--;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

// F2 — delegates to the engine's `progressionSize` (TOTAL across every
// TakeRule kind, never throws) instead of re-deriving per-shape counts by
// hand. This is a READ path fed straight from a DB column — never let a
// malformed value reach `progressionSize`.
//
// F3 Task 2b (regression fix, commit 6351fd2ce): `progressionSize`
// deliberately contributes 0 for `topNPerGroup` (its own comment:
// "group-count-dependent; callers with a real shape use expandTake
// instead") — groups_ko's switch to `topNPerGroup` made every
// group-into-knockout preview collapse through the `|| 4` guard below
// regardless of the real qualifier count (4 pools x 4 qualifiers/pool
// previewed a 4-team bracket, not 16). `previewDivisionFixtures` has the
// whole stage array, so the previous stage's real pool count is knowable
// with no DB read — `previewSourceShape` derives it the same way
// stage-seeding.ts's `sourceShapeOf` does for a preset (non-DB) source.
// Only a take that actually contains `topNPerGroup` pays for this: every
// rankRange/bestNth/picks/roundLosers-only take (league_ko,
// group_stepladder, group_playoffs, ko_plate, qualifying_main) still goes
// straight through `progressionSize`, unchanged — `expandTake` would
// compute the identical total for those kinds, so there is no reason to
// risk it on the common path.
function previewSourceShape(prev: PreviewStageInput | undefined): SourceShape {
  // A non-"group" (or absent) previous stage has no pools. Matches
  // sourceShapeOf's own convention: topNPerGroup then degenerates to one
  // implicit pool (expandOne's `pools.length > 0 ? shape.poolKeys : [""]`),
  // the same "ungrouped source" fallback getStandings/seedNextStage use.
  if (!prev || prev.kind !== "group") return { poolKeys: [] };
  const cfg = (prev.config ?? {}) as { pools?: { count?: unknown } };
  const raw = cfg.pools?.count;
  // Mirrors poolCount()'s own default-to-1, but never throws on an
  // out-of-range value — this is a preview read path (malformed knob data
  // must fall back to 1 pool, not 422 a gallery render).
  const count = typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= POOL_KEYS.length ? raw : 1;
  return { poolKeys: POOL_KEYS.slice(0, count).split("") };
}

// F3 review item 3 (RESOLVED) — was `spec.sources?.[0]?.take` only: complete
// while previewDivisionFixtures never saw a multi-source progression, but
// item 1's fix makes multi-source a genuinely reachable `setup` spec
// (progression-multi-source.test.ts creates one end to end), and this preview
// undersized the downstream stage for one exactly the way commit 0ec159e52
// fixed for `topNPerGroup` — the "preview that lies" class this programme
// exists to end. Sums every source, each sized by the SAME per-source rule
// this function always applied to `sources[0]` alone (topNPerGroup needs the
// previous stage's real shape; everything else is a plain progressionSize),
// so single-source behaviour is byte-identical (a one-source sum reduces to
// the same single term). "Summing every source's count would double-count
// entrants a REAL resolve would dedupe" (the old comment here) does not apply
// to a preview: this sizes SLOTS from static take-rule counts, never real
// entrant ids, and multiple sources describe entrants from DIFFERENT earlier
// stages by construction — there is nothing to dedupe.
//
// X-PL-6: a `firstLosses` take has no count of its own (the engine sizes it from the played field), so the preview sizes it
// from the previous stage's entrants under "better seed wins" — `estimatePlateField`, the same display count the builder
// shows — and adds it to whatever else the source takes.
function qualifierCount(progression: unknown, prevStage?: PreviewStageInput, prevEntrants = 0): number {
  if (!progression || typeof progression !== "object") return 0;
  const spec = progression as { sources?: { take?: unknown }[] };
  const sources = spec.sources;
  if (!Array.isArray(sources)) return 0;
  return sources.reduce((total, source) => {
    const take = source?.take;
    if (!Array.isArray(take)) return total;
    const rules = take as TakeRule[];
    const plate = rules.some((r) => (r as { kind?: unknown } | null)?.kind === "firstLosses") ? estimatePlateField(prevEntrants) : 0;
    if (rules.some((r) => (r as { kind?: unknown } | null)?.kind === "topNPerGroup")) {
      try {
        return total + plate + expandTake(rules, previewSourceShape(prevStage)).reduce((sum, pot) => sum + pot.length, 0);
      } catch {
        // A malformed sibling rule despite the topNPerGroup check above —
        // fall through to progressionSize's own graceful degradation; this
        // read path must never throw.
      }
    }
    return total + plate + progressionSize(rules);
  }, 0);
}

/** Preview a whole stage graph. Stage 1 uses A,B,C… entrants; later (qualifier)
 *  stages use "Seed 1…q". Score-dependent formats (swiss/americano/ladder)
 *  can't be drawn before results, so they return an explanatory note. */
export function previewDivisionFixtures(
  stages: PreviewStageInput[],
  count: number,
): PreviewPhase[] {
  const n = Math.min(Math.max(2, Math.trunc(count) || 2), 64);
  const poolIds = new Map(POOL_KEYS.split("").map((k) => [k, k]));

  const counts: number[] = []; // each stage's entrant count, for a later `firstLosses` stage's field
  return stages.map((stage, stageIdx) => {
    const firstStage = stageIdx === 0;
    // `|| 4` is now genuinely unknowable only: an absent/malformed
    // progression, or a take whose rules all resolve to 0 real qualifiers.
    // A real topNPerGroup/rankRange/bestNth/picks/roundLosers/firstLosses take is sized
    // exactly by qualifierCount (shape-aware for topNPerGroup via the
    // previous array entry, progressionSize otherwise — see its comment).
    const entrantCount = firstStage
      ? n
      : Math.max(2, qualifierCount(stage.progression, stages[stageIdx - 1], counts[stageIdx - 1]) || 4);
    counts.push(entrantCount);
    const label = (i: number) => (firstStage ? alphaLabel(i) : `Seed ${i + 1}`);

    // Formats whose pairings depend on live results — no static draw exists.
    if (stage.kind === "swiss" || stage.kind === "americano" || stage.kind === "ladder") {
      const note =
        stage.kind === "ladder"
          ? "No fixed fixtures — players challenge others within range and climb over a long window."
          : stage.kind === "swiss"
            ? `Round 1 is seeded; the remaining rounds pair players on equal scores from the live standings.`
            : "Individuals rotate partners each round; pairings are drawn live from the running points.";
      return { title: stage.name, note, sections: [] };
    }

    let gen: GenFixture[];
    try {
      const entrants: ActiveEntrant[] = Array.from({ length: entrantCount }, (_, i) => ({
        id: `e${i + 1}`,
        seed: i + 1,
        swiss_first_round: null,
      }));
      gen = generate(stage.kind, stage.config, entrants, poolIds);
    } catch {
      return { title: stage.name, note: "Preview isn't available for this format.", sections: [] };
    }

    // id → label; and extKey → the SOURCE fixture's {round, seq} — numbers,
    // never a rendered fragment (P7/F1) — so feeds resolve through the
    // design's slot.winner_match/slot.loser_match pair via the SAME
    // resolveSlotLabel() every real renderer uses (A1/A2), which composes
    // "R2·1" from slot.match_ref internally. Never a hand-built template.
    // This preview has no locale in scope (it backs the marketing gallery +
    // /help/formats, always English before and after), so it resolves
    // through the client-safe English msg(). Mirrors the exact map
    // generateStageFixtures's own INSERT builds for the live path below, so
    // the two cannot drift onto different ref formats.
    const idLabel = new Map<string, string>();
    for (let i = 0; i < entrantCount; i++) idLabel.set(`e${i + 1}`, label(i));
    const refByExt = new Map(gen.map((f) => [f.extKey, { round: f.roundNo, seq: f.seqInRound }]));

    const slot = (id: string | null, from?: { extKey: string; side: "winner" | "loser" }): string => {
      if (id) return idLabel.get(id) ?? id;
      if (from) {
        const params = refByExt.get(from.extKey);
        if (!params) return resolveSlotLabel(null, msg, "schedule.tbd");
        const key = from.side === "loser" ? "slot.loser_match" : "slot.winner_match";
        return resolveSlotLabel({ key, params }, msg, "schedule.tbd");
      }
      return resolveSlotLabel(null, msg, "schedule.tbd");
    };

    // Group by pool (group stages) or by round (everything else).
    const grouped = new Map<string, GenFixture[]>();
    const byPool = gen.some((f) => f.poolId);
    for (const f of gen) {
      const key = byPool ? `pool:${f.poolId}` : `round:${f.roundNo}`;
      (grouped.get(key) ?? grouped.set(key, []).get(key)!).push(f);
    }

    // F1 Task 4: name each round by its POSITION (roundRole), never by match
    // count — a double-elim's losers bracket has repeated round sizes, so a
    // count-based namer produces several "Semi-finals" and several "Final"s
    // in one bracket (design §2.3). Ranked per LANE (laneRoundRank), not
    // across the whole stage. Non-bracket kinds (league/group round robins)
    // keep the plain "Round N" — roundRole()'s fromEnd arithmetic assumes a
    // bracket shape and is meaningless outside BRACKET_KINDS.
    const laneFixtures = gen.map((f) => ({ round_no: f.roundNo, lane: f.lane ?? null }));

    const sections: PreviewSection[] = [...grouped.entries()]
      .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
      .map(([key, fixtures]) => {
        const matches = fixtures
          .sort((a, b) => a.roundNo - b.roundNo || a.seqInRound - b.seqInRound)
          .map((f) => ({
            home: slot(f.home, f.homeFrom),
            // Task 5: a bye is known at setup and never resolves to anyone —
            // "TBD" tells an organiser to wait for something that isn't
            // coming. BracketFixtureGen.award marks the whole fixture; the
            // engine always lands the award on `home` (buildSingleElim), so
            // `away` is unconditionally the phantom slot here.
            away: f.award !== undefined ? msg("bracket.slot.bye") : slot(f.away, f.awayFrom),
          }));
        const first = fixtures[0]!;
        const title = byPool
          ? `Group ${key.slice(5)}`
          : BRACKET_KINDS.has(stage.kind)
            ? roundRoleLabel(
                msg,
                roundRoleFor(
                  laneFixtures,
                  {
                    round_no: first.roundNo,
                    lane: first.lane ?? null,
                    is_final: first.isFinal === true,
                    third_place: first.thirdPlace === true,
                    conditional: first.conditional === true,
                  },
                  stage.kind,
                  first.extKey,
                ),
              )
            : msg("bracket.round.plain", { n: first.roundNo });
        return { title, matches };
      });

    return { title: stage.name, sections };
  });
}

// The same draw previewDivisionFixtures renders, as STRUCTURE instead of English text (quick match, spec C22; plan 1
// pre-flight C2): seeds, feeders, the bye flag and the engine's typed round role, so a caller in any locale names the
// sides and the rounds itself. Same placeholder entrants (e<i> is seed i), same generate(), same refByExt and
// laneFixtures as above: there is still one bracket algorithm. A first stage only — a stage fed by an earlier one
// has no seeds of its own to place here.
export interface PreviewDrawFeed {
  /** The source fixture's {round, seq}: the same pair refByExt builds above. */
  round: number;
  seq: number;
  /** Whose seat it is: the source's winner, or its loser (a third-place match, a losers' bracket). */
  side: "winner" | "loser";
}
export interface PreviewDrawFixture {
  roundNo: number;
  seqInRound: number;
  /** The placeholder's seed (e<i> is seed i); null when the seat is fed or empty. */
  homeSeed: number | null;
  awaySeed: number | null;
  homeFrom: PreviewDrawFeed | null;
  awayFrom: PreviewDrawFeed | null;
  /** `award` is set: the flag previewDivisionFixtures reads. The holder sits at home and the away seat is empty. */
  bye: boolean;
  /** roundRoleFor(…) for BRACKET_KINDS, exactly as previewDivisionFixtures titles a round; null for a round robin. */
  role: RoundRole | null;
}

export function previewStageDraw(stage: PreviewStageInput, count: number): PreviewDrawFixture[] {
  const n = Math.min(Math.max(2, Math.trunc(count) || 2), 64);
  const poolIds = new Map(POOL_KEYS.split("").map((k) => [k, k]));
  const entrants: ActiveEntrant[] = Array.from({ length: n }, (_, i) => ({
    id: `e${i + 1}`,
    seed: i + 1,
    swiss_first_round: null,
  }));
  let gen: GenFixture[];
  try {
    gen = generate(stage.kind, stage.config, entrants, poolIds);
  } catch {
    return [];
  }

  const seedById = new Map(entrants.map((e) => [e.id, e.seed]));
  const seedOf = (id: string | null): number | null => (id ? (seedById.get(id) ?? null) : null);
  const refByExt = new Map(gen.map((f) => [f.extKey, { round: f.roundNo, seq: f.seqInRound }]));
  const feedOf = (from: GenFixture["homeFrom"]): PreviewDrawFeed | null => {
    const ref = from ? refByExt.get(from.extKey) : undefined;
    return from && ref ? { ...ref, side: from.side } : null;
  };
  const laneFixtures = gen.map((f) => ({ round_no: f.roundNo, lane: f.lane ?? null }));
  const bracket = BRACKET_KINDS.has(stage.kind);

  return gen.map((f) => ({
    roundNo: f.roundNo,
    seqInRound: f.seqInRound,
    homeSeed: seedOf(f.home),
    awaySeed: seedOf(f.away),
    homeFrom: feedOf(f.homeFrom),
    awayFrom: feedOf(f.awayFrom),
    bye: f.award !== undefined,
    role: bracket
      ? roundRoleFor(
          laneFixtures,
          {
            round_no: f.roundNo,
            lane: f.lane ?? null,
            is_final: f.isFinal === true,
            third_place: f.thirdPlace === true,
            conditional: f.conditional === true,
          },
          stage.kind,
          f.extKey,
        )
      : null,
  }));
}
