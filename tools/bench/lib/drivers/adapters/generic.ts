// The generic-sport TapAdapter (B07a task 9). Maps a pack's own authored
// `generic.*` events onto the taps a real scorer would make on the v3
// "generic" skin — never the reverse: this file never invents an event the
// pack didn't author, and a payload shape it does not recognise THROWS
// rather than guessing (`scorer.ts`'s own doc on `TapAdapter.stepsFor`; this
// task's own ruling — "an event the adapter cannot map becomes a finding,
// never a fallback").
//
// tools/bench production code cannot import `generic.tsx`: it reaches `@/`
// imports, which do not resolve outside Next's build (R39). (An import-free
// product module IS read directly — `scorer.ts` reads `organiser-only-events.ts`,
// `import.ts` reads `import-caps.ts`.) Every constant/behaviour
// below is a LOCAL restatement of
// `apps/web/src/components/v2/scorepad/v3/skins/generic.tsx`'s own, cited by
// SYMBOL (a line number goes stale with every edit above it), and pinned EQUAL
// to the real module by `__tests__/scorer-driver.test.ts` — the "restate, then
// prove equal to the source of truth" posture. The score-entry ceiling is the
// engine's `genericPadRules.maxPlausibleScore` (`@seazn/engine/pad`; generic.tsx
// declares no such constant since pad wave P4.1), which `MAX_PLAUSIBLE_SCORE`
// below restates and `scorer-driver.test.ts` holds equal to it.
//
// SCOPE (this task only — see the report for what is owed to Task 10/13):
//   - `core.start`               -> the "Start match" button (not an event
//                                   to post at all — generic.tsx has no
//                                   opinion on this; it is chassis-level).
//   - `generic.score`, SCORE mode, payload EXACTLY `{by, points:1}`
//                                -> a scorebug half tap (generic.tsx
//                                   `buildHalf`, tapType SCORE_TYPE).
//     Fix round 1, I3: mode-gated. Under win_loss, `tapTypeOf`
//     (generic.tsx) never returns SCORE_TYPE at all — a pack
//     `generic.score` event on a win_loss fixture has no corresponding tap;
//     the half instead commits `generic.result {winnerId}`. Mapping it to a
//     half tap anyway would write a TERMINAL result the pack never
//     authored — the oracle-direction breach the Global Constraint forbids.
//     `stepsForScore` therefore throws unless `resultModeOf(cfg) === "score"`.
//   - `generic.result`, win_loss mode, payload EXACTLY `{winnerId}`
//                                -> a scorebug half tap (generic.tsx
//                                   `tapTypeOf`, `buildHalf`
//                                   — THE CAUTION this task's own dispatch
//                                   carries verbatim: win_loss's half tap
//                                   commits `generic.result`, not the
//                                   settle tile).
//   - `generic.result`, score mode, EMPTY payload
//                                -> the "settle" tile, settling from the
//                                   tally (generic.tsx `SETTLE_TILE_ID`,
//                                   `buildTiles`).
//   - Task 10 fix round 1 (R59(b)) — `generic.score`, SCORE mode, with
//     `points` of 2/3/5 and/or a `person`
//                                -> release any hold, the half tap, then the
//                                   dock's amount chip, then the person chip
//                                   IF the dock offers one (generic.tsx
//                                   `buildDock`; the pad stamps a sole
//                                   on-field player itself, `soleScorer`).
//   - Task 10 fix round 1 (R59(a)) — `generic.result`, SCORE mode, exactly
//     `{p1Score, p2Score}`       -> the score-entry sheet: tile, home number
//                                   + confirm, away number + confirm
//                                   (generic.tsx `scoreEntrySheet`).
//   - Everything else — a draw (`isDraw:true`), a correction (negative
//     `points`, the correction sheet), an amount no dock chip offers, and any
//     non-generic event — THROWS. Organiser-only `core.*` events never reach
//     an adapter: `scorer.ts`'s `organiserStepsFor` maps them to the console.
import { START_MATCH_TESTID, type TapAdapter, type TapAdapterContext, type TapStep } from "../scorer.ts";

const SPORT = "generic";

/** generic.tsx `SCORE_TYPE` */
export const SCORE_TYPE = "generic.score";
/** generic.tsx `RESULT_TYPE` */
export const RESULT_TYPE = "generic.result";
/** generic.tsx `SETTLE_TILE_ID` */
export const SETTLE_TILE_ID = "settle";
/** generic.tsx `SCORE_ENTRY_TILE_ID` — the tile that opens the typed-result sheet (`scoreEntrySheet`). */
export const SCORE_ENTRY_TILE_ID = "scoreEntry";
/** generic.tsx `DOCK_AMOUNTS` — the amounts the hold-window dock offers, as chips
 *  `points:<n>` (`amountChip`). A half tap itself is worth 1 (`buildHalf`). */
export const DOCK_AMOUNTS: readonly number[] = [2, 3, 5];
/** The score-entry sheet's per-side ceiling: the engine's `genericPadRules.maxPlausibleScore` (generic.tsx `scoreEntrySheet` reads
 *  it for both number steps), restated here and pinned equal to it by `scorer-driver.test.ts`. */
export const MAX_PLAUSIBLE_SCORE = 500;

const SCORE_PAYLOAD_KEYS: readonly string[] = ["by", "points", "person"];

function asRecord(payload: unknown): Record<string, unknown> {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
}

/** A number the score-entry sheet's number step can hold: a whole number in
 *  its `min: 0` .. `max: MAX_PLAUSIBLE_SCORE` range (generic.tsx `scoreEntrySheet`). */
function isSheetScore(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_PLAUSIBLE_SCORE;
}

interface GenericCfgShape {
  resultMode?: string;
}

/** Mirrors generic.tsx's `resultModeOf` — same fail-safe default
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

/** generic.tsx `buildHalf` — score mode's half tap commits
 *  exactly `{by, points:1}` (the SOLE-SCORER auto-stamp (`soleScorer`) adds a
 *  `person` key the TAP ITSELF never carries — that key is stamped by the
 *  pad, not chosen by the scorer; `scorer.ts`'s `comparePayload` tolerates
 *  it via `tolerableExtraKeys` below, rather than this function pretending
 *  the tap payload ever carries it). Fix round 1, I3: mode-gated — see the
 *  file header. */
function stepsForScore(payload: unknown, cfg: unknown, entrants: TapAdapterContext["entrants"]): readonly TapStep[] {
  if (resultModeOf(cfg) !== "score") {
    throw new Error(
      `genericAdapter: generic.score payload ${JSON.stringify(payload)} is not tappable under win_loss mode — ` +
        "the pad's half tap commits generic.result {winnerId} there, not this event (generic.tsx `tapTypeOf`)",
    );
  }
  const p = asRecord(payload);
  const unknown = Object.keys(p).filter((key) => !SCORE_PAYLOAD_KEYS.includes(key));
  const badPerson = "person" in p && (typeof p.person !== "string" || p.person.length === 0);
  if (unknown.length > 0 || !("by" in p) || typeof p.points !== "number" || badPerson) {
    throw new Error(
      `genericAdapter: generic.score payload ${JSON.stringify(payload)} is not one the pad authors — ` +
        "it records {by, points} and optionally a non-empty person, nothing else",
    );
  }
  const side = sideOf(p.by, entrants);
  const person = typeof p.person === "string" ? p.person : undefined;
  if (p.points === 1 && person === undefined) return [{ kind: "half", side }];
  if (p.points !== 1 && !DOCK_AMOUNTS.includes(p.points)) {
    throw new Error(
      `genericAdapter: generic.score payload ${JSON.stringify(payload)} — no dock chip offers ${p.points} ` +
        `(a half tap is 1 and the dock amends it to ${DOCK_AMOUNTS.join("/")}, generic.tsx DOCK_AMOUNTS); ` +
        "a negative correction is the correction sheet, which is not mapped",
    );
  }
  // Fix round 1 (R59(b)) — the pad's own route: the half tap is HELD behind a
  // dock (pad-host.tsx `usesSoftCommit`), whose chips amend that same held
  // submission (`DockChip.mutate`, generic.tsx `amountChip`/`personChip`) rather than posting a
  // second event. Release any earlier hold first, so the chips tapped are this
  // tap's own dock and not the previous one still on screen.
  const steps: TapStep[] = [{ kind: "releaseHold" }, { kind: "half", side }];
  if (p.points !== 1) steps.push({ kind: "chip", chipId: `points:${p.points}` });
  if (person !== undefined) steps.push({ kind: "offeredChip", chipId: `person:${person}` });
  return steps;
}

/** generic.tsx `tapTypeOf`, `buildHalf`, `SETTLE_TILE_ID` and `buildTiles` — see the file header's CAUTION. */
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
  // Fix round 1 (R59(a)) — the typed result: the score-entry sheet asks HOME
  // first, then AWAY, each a number step with its own confirm, and builds
  // exactly `{p1Score: home, p2Score: away}` (generic.tsx `scoreEntrySheet`). It commits
  // immediately — `buildDock` declares no dock for a result.
  const p = asRecord(payload);
  const keys = Object.keys(p).sort();
  if (keys.length === 2 && keys[0] === "p1Score" && keys[1] === "p2Score" && isSheetScore(p.p1Score) && isSheetScore(p.p2Score)) {
    return [
      { kind: "tile", tileId: SCORE_ENTRY_TILE_ID },
      { kind: "number", value: p.p1Score },
      { kind: "confirm" },
      { kind: "number", value: p.p2Score },
      { kind: "confirm" },
    ];
  }
  throw new Error(
    `genericAdapter: score-mode generic.result payload ${JSON.stringify(payload)} is neither a settle ({}) nor a typed final score ` +
      `{p1Score, p2Score} of whole numbers 0..${MAX_PLAUSIBLE_SCORE} — the only two results this pad authors in score mode`,
  );
}

/**
 * R50(d) — THE allowlist: payload keys the generic pad adds to a committed row
 * beyond what a pack authors, by event type. Nothing else is tolerated, and
 * every entry carries its evidence:
 *   - `generic.score` → `person`: `buildHalf` stamps the side's SOLE on-field
 *     player into the half tap's own payload (generic.tsx `soleScorer`, spread
 *     into `buildHalf`'s payload as `person`). The pipeline sends that payload
 *     unchanged (pipeline.ts:157) and append-event.ts:215/:336 stores it
 *     verbatim, so the row carries a key no pack author writes.
 * No other generic event gains a key: win_loss's half commits exactly
 * `{winnerId}` (generic.tsx `buildHalf`), the settle tile exactly `{}` (`buildTiles`),
 * `core.start` `{}` (device-score-pad.tsx:306), `core.finalize` `{}`
 * (fixture-console.tsx:1105).
 */
export const GENERIC_TOLERATED_EXTRA_KEYS: ReadonlyMap<string, readonly string[]> = new Map([[SCORE_TYPE, ["person"]]]);

export const genericAdapter: TapAdapter = {
  sport: SPORT,
  stepsFor(event, ctx) {
    if (event.type === "core.start") return [{ kind: "testid", testid: START_MATCH_TESTID }];
    if (event.type === SCORE_TYPE) return stepsForScore(event.payload, ctx.cfg, ctx.entrants);
    if (event.type === RESULT_TYPE) return stepsForResult(event.payload, ctx.cfg, ctx.entrants);
    throw new Error(`genericAdapter: no tap mapping for event type "${event.type}" (owed to a later wave)`);
  },
  tolerableExtraKeys(eventType) {
    return GENERIC_TOLERATED_EXTRA_KEYS.get(eventType) ?? [];
  },
};
