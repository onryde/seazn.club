// The desk's round-1 Swiss pairing menu — every derivation behind the split
// button on the stage rail (`components/v2/desk/stage-rail.tsx`), as pure
// functions. Spec: docs/superpowers/specs/2026-09-22-swiss-round-one-pairing-design.md
// ("UI — option A, split button").
//
// Pure on purpose: apps/web vitest is node-only, so no unit test can click the
// button. Anything left inline in a handler — which mode is checked, what the
// hint says, what the press sends — would be untested on exactly the path an
// organiser uses. The rail renders these; the tests pin them.
//
// Client-safe: imports only the client-safe leaves (`swiss-pairing.ts` is
// guarded against the whole scheduling barrel by its own test).
import {
  effectiveSwissPairing,
  roundOnePairs,
  storedSwissPairing,
  SWISS_PAIRINGS,
  type SwissPairingMode,
} from "@/lib/swiss-pairing";
import { nextUnseatedSwissRound } from "@/lib/swiss-shell";
import { swissActiveFieldSize } from "@/lib/swiss-legend";
import { swissRoundField, type EntrantSwissFirstRounds } from "@/lib/swiss-late-entry";

/** What the split button's menu needs; `null` when there is no menu. */
export type SwissPairingMenu = {
  /** The round waiting to be paired — `nextUnseatedSwissRound`. */
  round: number;
  /** Round 1 only (spec ruling 3): later rounds show the mode read-only. */
  choosable: boolean;
  /** What Pair next uses with no pick — `effectiveSwissPairing`. */
  defaultPairing: SwissPairingMode;
  /** The stage's own `config.pairing`, which every later round follows. */
  stored: SwissPairingMode;
  /** The field `swissGen` pairs (R2): registered/confirmed entrants, and only
   *  the qualifiers still in it on a stage carrying `config.qualified`. */
  fieldSize: number;
  /** R1 — whether the hint may print seed NUMBERS. */
  seedsNumbered: boolean;
  /** X-SW-22 (W3 T8) — round 1 seats an unseeded entrant by the stage's seeded random draw (`swissFieldDrawn`); false
   *  in every later round. */
  unseededDrawn: boolean;
  /** Review m1 — a drawn round 1 whose field also holds a seeded entrant: the seeds go first, then the draw. False
   *  whenever `unseededDrawn` is. */
  seededAheadOfDraw: boolean;
};

/** The keys this module reads — the whole surface in one place, typed as a
 *  union so `useMsg()` and the tests' real catalog both satisfy it. */
export type SwissPairingMessageKey =
  | "schedule.pairing.pair"
  | "schedule.pairing.hintFoldGeneric"
  | "schedule.pairing.hintAdjacentGeneric"
  | "schedule.pairing.hintFoldDrawn"
  | "schedule.pairing.hintAdjacentDrawn"
  | "schedule.pairing.hintFoldSeededDrawn"
  | "schedule.pairing.hintAdjacentSeededDrawn"
  | "schedule.pairing.fold"
  | "schedule.pairing.adjacent"
  | "schedule.pairing.default"
  | "schedule.pairing.drawnAtRandom";
export type SwissPairingT = (key: SwissPairingMessageKey, vars?: Record<string, string | number>) => string;

/** How many pairs the hint names before it trails off. */
export const SWISS_PAIRING_HINT_PAIRS = 3;

type EntrantSeeds = Readonly<Record<string, number | null | undefined>>;
/** W3 T9 (T8 review m8): each entrant's stored first Swiss round and the stage it belongs to (V484/V485), by id. The
 *  type lives beside the field helper both desk readers use (`swissRoundField`, lib/swiss-late-entry.ts). */
export type { EntrantSwissFirstRounds };

/**
 * R1 — may the hint print seed numbers? `roundOnePairs` returns seed
 * POSITIONS 1..N, in the order `swissGen` ranks the field. Printing position k
 * as "seed k" is true only when the entrant at position k carries seed k, for
 * every k — otherwise the hint would name a wrong seed, which is worse than
 * naming none.
 *
 * The order mirrors `generateStageFixturesWrite` (usecases/stages.ts):
 *  - a stage carrying `config.qualified` draws the qualifiers still in the
 *    field, IN QUALIFICATION ORDER, and ranks them by that position — so the
 *    check is positional, and the same seeds in another order fail it;
 *  - every other stage draws the active field ordered `seed nulls last, ...`,
 *    so when the seeds are exactly {1..N}, one each, position k IS seed k, and
 *    when they are not, no tie-break makes them so.
 */
export function swissFieldSeedsNumbered(
  config: Record<string, unknown>,
  activeEntrantIds: readonly string[] | undefined,
  entrantSeeds: EntrantSeeds | undefined,
): boolean {
  if (!activeEntrantIds || !entrantSeeds) return false;
  const seedOf = (id: string): number | null => entrantSeeds[id] ?? null;
  const qualified = Array.isArray(config.qualified) ? (config.qualified as unknown[]) : null;
  let seeds: Array<number | null>;
  if (qualified) {
    const active = new Set(activeEntrantIds);
    seeds = qualified.filter((id): id is string => typeof id === "string" && active.has(id)).map(seedOf);
  } else {
    seeds = activeEntrantIds
      .map(seedOf)
      .sort((a, b) => (a ?? Number.MAX_SAFE_INTEGER) - (b ?? Number.MAX_SAFE_INTEGER));
  }
  // Below two there is nothing to pair, and `every` over an empty list is
  // vacuously true — state the empty case rather than inherit it.
  if (seeds.length < 2) return false;
  return seeds.every((seed, k) => seed === k + 1);
}

/**
 * X-SW-22 (W3 T8) — does round 1 draw an unseeded entrant? Mirrors `swissGen` (usecases/stages.ts): round 1 orders an
 * unseeded entrant by the stage's seeded random draw (`lib/swiss-draw.ts`) whenever the field it pairs holds one. A stage
 * carrying `config.qualified` ranks its qualifiers by qualification order, so it is never drawn. A missing seed reads as
 * unseeded, as in `swissFieldSeedsNumbered`.
 */
export function swissFieldDrawn(
  config: Record<string, unknown>,
  activeEntrantIds: readonly string[] | undefined,
  entrantSeeds: EntrantSeeds | undefined,
): boolean {
  if (!activeEntrantIds || !entrantSeeds) return false;
  if (Array.isArray(config.qualified)) return false;
  // Below two the Pair is refused (STAGE_NOT_READY): there is no round 1 to draw — stated, not inherited from `some`.
  if (activeEntrantIds.length < 2) return false;
  return activeEntrantIds.some((id) => (entrantSeeds[id] ?? null) === null);
}

/**
 * The menu for one stage, or `null` when there is none: not Swiss, no shells
 * yet (the first Generate mints them — the server refuses a pick there), or
 * R3 — no round waiting to be paired.
 */
export function swissPairingMenuFor(args: {
  kind: string;
  config: Record<string, unknown>;
  fixtures: Parameters<typeof nextUnseatedSwissRound>[0];
  activeEntrantIds: readonly string[] | undefined;
  entrantSeeds: EntrantSeeds | undefined;
  /** W3 T9 (T8 review m8): the stage this menu is for and each entrant's stored first round. The round's field is the
   *  server's — `swissFieldForRound` (usecases/stages.ts) over the same two predicates (`swissFirstRoundIn`,
   *  `inSwissRoundField`) — so a late player whose first round is still ahead neither draws round 1 here nor counts in
   *  it. Absent: everyone plays from round 1, as before any late entry. */
  stageId?: string;
  entrantFirstRounds?: EntrantSwissFirstRounds;
}): SwissPairingMenu | null {
  if (args.kind !== "swiss" || args.fixtures.length === 0) return null;
  const round = nextUnseatedSwissRound(args.fixtures);
  if (round === null) return null;
  const stored = storedSwissPairing(args.config);
  const field =
    args.activeEntrantIds === undefined
      ? undefined
      : swissRoundField(args.activeEntrantIds, round, args.stageId, args.entrantFirstRounds);
  const unseededDrawn = round === 1 && swissFieldDrawn(args.config, field, args.entrantSeeds);
  return {
    round,
    choosable: round === 1,
    defaultPairing: effectiveSwissPairing({ stored, round }),
    stored,
    // An unknown roster (a caller that passed none) is 0 here, and the hint
    // below goes generic rather than print numbers for a field it cannot see.
    fieldSize: swissActiveFieldSize(args.config, field ?? []),
    seedsNumbered: swissFieldSeedsNumbered(args.config, field, args.entrantSeeds),
    unseededDrawn,
    seededAheadOfDraw: unseededDrawn && (field ?? []).some((id) => (args.entrantSeeds?.[id] ?? null) !== null),
  };
}

/** X-SW-22 — the round-1 line under the options when the field is drawn: "Unseeded entrants are drawn at random."
 *  `null` otherwise, and never in a read-only later round. */
export function swissPairingDrawNote(
  menu: Pick<SwissPairingMenu, "choosable" | "unseededDrawn">,
  t: SwissPairingT,
): string | null {
  return menu.choosable && menu.unseededDrawn ? t("schedule.pairing.drawnAtRandom") : null;
}

/** The hint under one option: "1v6, 2v7, 3v8…" when R1 allows numbers,
 *  otherwise the generic line for that mode — "by seed" only when round 1 is not drawn (review m1): a wholly unseeded
 *  field's halves are the draw's, and a partly seeded one puts its seeds first, then the draw. */
export function swissPairingHint(
  mode: SwissPairingMode,
  menu: Pick<SwissPairingMenu, "fieldSize" | "seedsNumbered" | "unseededDrawn" | "seededAheadOfDraw">,
  t: SwissPairingT,
): string {
  const pairs = menu.seedsNumbered ? roundOnePairs(menu.fieldSize, mode) : [];
  if (pairs.length === 0) {
    const fold = mode === "fold";
    if (!menu.unseededDrawn) return t(fold ? "schedule.pairing.hintFoldGeneric" : "schedule.pairing.hintAdjacentGeneric");
    if (menu.seededAheadOfDraw) {
      return t(fold ? "schedule.pairing.hintFoldSeededDrawn" : "schedule.pairing.hintAdjacentSeededDrawn");
    }
    return t(fold ? "schedule.pairing.hintFoldDrawn" : "schedule.pairing.hintAdjacentDrawn");
  }
  const shown = pairs
    .slice(0, SWISS_PAIRING_HINT_PAIRS)
    .map(([a, b]) => t("schedule.pairing.pair", { a, b }))
    .join(", ");
  return pairs.length > SWISS_PAIRING_HINT_PAIRS ? `${shown}…` : shown;
}

/** "Top vs bottom (default)" / "Neighbours". */
export function swissPairingOptionLabel(
  mode: SwissPairingMode,
  defaultPairing: SwissPairingMode,
  t: SwissPairingT,
): string {
  const name = t(mode === "fold" ? "schedule.pairing.fold" : "schedule.pairing.adjacent");
  return mode === defaultPairing ? `${name} (${t("schedule.pairing.default")})` : name;
}

/**
 * What Pair next sends. `{ pairing }` only when the organiser picked the
 * NON-default mode in round 1 (spec: "sends `{ pairing }` only if it differs
 * from the default"); picking the default sends nothing, so the server's own
 * rule decides. Never outside round 1 — the server 422s an override there.
 */
export function swissPairingOverride(
  pick: SwissPairingMode | null,
  menu: SwissPairingMenu | null,
): { pairing: SwissPairingMode } | undefined {
  if (!menu || !menu.choosable || pick === null || pick === menu.defaultPairing) return undefined;
  return { pairing: pick };
}

/**
 * Radiogroup keyboard (WAI-ARIA radio pattern, same shape as
 * `ai-quote-card.tsx`'s `rungForKey`): arrows move AND select, wrapping; Home/
 * End jump to the ends; any other key is left to the browser, so Tab still
 * leaves the group.
 */
export function swissPairingForKey(key: string, current: SwissPairingMode): SwissPairingMode | null {
  const i = SWISS_PAIRINGS.indexOf(current);
  const n = SWISS_PAIRINGS.length;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return SWISS_PAIRINGS[(i + 1) % n];
    case "ArrowLeft":
    case "ArrowUp":
      return SWISS_PAIRINGS[(i - 1 + n) % n];
    case "Home":
      return SWISS_PAIRINGS[0];
    case "End":
      return SWISS_PAIRINGS[n - 1];
    default:
      return null;
  }
}
