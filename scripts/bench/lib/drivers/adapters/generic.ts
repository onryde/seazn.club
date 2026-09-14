// The generic-sport TapAdapter (B07a task 9). Maps a pack's own authored
// `generic.*` events onto the taps a real scorer would make on the v3
// "generic" skin — never the reverse: this file never invents an event the
// pack didn't author, and a payload shape it does not recognise THROWS
// rather than guessing (`scorer.ts`'s own doc on `TapAdapter.stepsFor`; this
// task's own ruling — "an event the adapter cannot map becomes a finding,
// never a fallback").
//
// scripts/bench never imports apps/web in PRODUCTION code (Global
// Constraint, R39 — see `scorer.ts`'s header). Every constant/behaviour
// below is a LOCAL restatement of
// `apps/web/src/components/v2/scorepad/v3/skins/generic.tsx`'s own, cited by
// file:line, and pinned EQUAL to the real module by
// `__tests__/scorer-driver.test.ts` — the same "restate, then prove equal to
// the source of truth" posture generic.tsx itself takes for
// `MAX_PLAUSIBLE_SCORE`/`MAX_TALLY_STEP`.
//
// SCOPE (this task only — see the report for what is owed to Task 10/13):
//   - `core.start`               -> the "Start match" button (not an event
//                                   to post at all — generic.tsx has no
//                                   opinion on this; it is chassis-level).
//   - `generic.score`, score mode, payload EXACTLY `{by, points:1}`
//                                -> a scorebug half tap (generic.tsx:310-341
//                                   `buildHalf`, tapType SCORE_TYPE).
//   - `generic.result`, win_loss mode, payload EXACTLY `{winnerId}`
//                                -> a scorebug half tap (generic.tsx:35,
//                                   296-305 `tapTypeOf`, 310-341 `buildHalf`
//                                   — THE CAUTION this task's own dispatch
//                                   carries verbatim: win_loss's half tap
//                                   commits `generic.result`, not the
//                                   settle tile).
//   - `generic.result`, score mode, EMPTY payload
//                                -> the "settle" tile, settling from the
//                                   tally (generic.tsx:414 `SETTLE_TILE_ID`,
//                                   :470-483 `buildTiles`).
//   - Everything else — a dock-chip amendment (`points !== 1` or a `person`
//     key on `generic.score`), a draw (`isDraw:true`), a typed final score
//     (`generic.result` with `p1Score`/`p2Score`, the score-entry GUIDED
//     SHEET), and any non-generic `core.*`/other event — THROWS. None of
//     these are exercised by this task's own test packs; they are real gaps
//     a later wave (Task 10/13, which does the live browser run) must close
//     before running this adapter against a pack that uses them. Recorded
//     as a deviation in the task report, not silently patched over.
import { START_MATCH_TESTID, type TapAdapter, type TapAdapterContext, type TapStep } from "../scorer.ts";

const SPORT = "generic";

/** generic.tsx:86 */
export const SCORE_TYPE = "generic.score";
/** generic.tsx:85 */
export const RESULT_TYPE = "generic.result";
/** generic.tsx:414 */
export const SETTLE_TILE_ID = "settle";

interface GenericCfgShape {
  resultMode?: string;
}

/** Mirrors generic.tsx:168-170's `resultModeOf` — same fail-safe default
 *  ("score" whenever the cfg never carried a `resultMode`, or carried
 *  anything other than the literal `"win_loss"`), for the same reason: a
 *  wrong guess of "score" only ever offers a foldable, non-terminal tap,
 *  while a wrong guess of "win_loss" would offer a one-tap-decides-the-match
 *  affordance the fold might refuse outright. */
export function resultModeOf(cfg: unknown): "score" | "win_loss" {
  const c = cfg !== null && typeof cfg === "object" ? (cfg as GenericCfgShape) : {};
  return c.resultMode === "win_loss" ? "win_loss" : "score";
}

function sideOf(resolvedId: unknown, entrants: TapAdapterContext["entrants"]): "home" | "away" {
  if (resolvedId === entrants.home) return "home";
  if (resolvedId === entrants.away) return "away";
  throw new Error(
    `genericAdapter: resolved entrant "${String(resolvedId)}" matches neither home ("${entrants.home}") nor away ("${entrants.away}")`,
  );
}

function isEmptyPayload(payload: unknown): boolean {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload) && Object.keys(payload).length === 0;
}

/** generic.tsx:310-341 (`buildHalf`) — score mode's half tap commits
 *  exactly `{by, points:1}` (the SOLE-SCORER auto-stamp at :324-328 adds a
 *  `person` key the TAP ITSELF never carries — that key is stamped by the
 *  pad, not chosen by the scorer, so a pack event that carries it is not a
 *  plain half tap and is out of this task's scope; see the file header). */
function stepsForScore(payload: unknown, entrants: TapAdapterContext["entrants"]): readonly TapStep[] {
  const p = (payload ?? {}) as Record<string, unknown>;
  const keys = Object.keys(p);
  if (keys.length !== 2 || !("by" in p) || p.points !== 1) {
    throw new Error(
      `genericAdapter: generic.score payload ${JSON.stringify(payload)} is not a plain one-point half tap — ` +
        "dock-chip amendments and corrections are not mapped by this task (owed to a later wave)",
    );
  }
  return [{ kind: "half", side: sideOf(p.by, entrants) }];
}

/** generic.tsx:35, :296-305 (`tapTypeOf`), :310-341 (`buildHalf`), :414-483
 *  (`SETTLE_TILE_ID`/`buildTiles`) — see the file header's CAUTION. */
function stepsForResult(payload: unknown, cfg: unknown, entrants: TapAdapterContext["entrants"]): readonly TapStep[] {
  const mode = resultModeOf(cfg);
  if (mode === "win_loss") {
    const p = (payload ?? {}) as Record<string, unknown>;
    const keys = Object.keys(p);
    if (keys.length !== 1 || !("winnerId" in p)) {
      throw new Error(
        `genericAdapter: win_loss generic.result payload ${JSON.stringify(payload)} is not a plain winnerId half tap — ` +
          "a draw (isDraw:true) is not mapped by this task (owed to a later wave)",
      );
    }
    return [{ kind: "half", side: sideOf(p.winnerId, entrants) }];
  }
  if (isEmptyPayload(payload)) {
    return [{ kind: "tile", tileId: SETTLE_TILE_ID }];
  }
  throw new Error(
    `genericAdapter: score-mode generic.result payload ${JSON.stringify(payload)} is a typed final score — ` +
      "the score-entry guided sheet is not mapped by this task (owed to a later wave)",
  );
}

export const genericAdapter: TapAdapter = {
  sport: SPORT,
  stepsFor(event, ctx) {
    if (event.type === "core.start") return [{ kind: "testid", testid: START_MATCH_TESTID }];
    if (event.type === SCORE_TYPE) return stepsForScore(event.payload, ctx.entrants);
    if (event.type === RESULT_TYPE) return stepsForResult(event.payload, ctx.cfg, ctx.entrants);
    throw new Error(`genericAdapter: no tap mapping for event type "${event.type}" (owed to a later wave)`);
  },
};
