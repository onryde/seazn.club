// v3/skins/period-shared.ts — WHAT HOCKEY AND ICE HOCKEY SHARE (R6/task C).
//
// The two sports are ONE engine kernel (`sports/period/kernel.ts`) under two
// presets, with an identical event union namespaced by the preset key. Their
// pads therefore differ in exactly three places, and this file is the argument
// that everything else is genuinely the same code rather than two files kept in
// step by hand:
//
//   1. the discipline ladder — three FIH cards against seven IIHF penalty
//      classes, which is why `PeriodSkinSpec.classes` exists;
//   2. the offence vocabulary each federation offers (`reasons`);
//   3. the copy, which is namespaced `pad.<key>.*` and needs no code at all.
//
// EVERYTHING ELSE IS READ, NOT DECLARED. `cfg` carries `goalKinds`, `assists`,
// `setPieceKinds`, `suspensions.classes`, `strength`, `overtime`, `shootout`
// and `periods` (`makePeriodConfigSchema`, kernel.ts:134-215), and the module's
// own `summary(state).detail` carries `nextAdvance`, `strength`, `shootoutNext`,
// `shootout` and hockey's `escalate` (kernel.ts:2523-2578). So the pad never
// re-derives a period label, never recomputes a power-play strength (including
// ice hockey's INVERTED overtime advantage, `overtimeStrengthOf`), and never
// keeps its own copy of a class list an organiser is free to edit. The one
// mirror this file does keep — the fidelity band per event type — is pinned to
// `module.padSpec(cfg).fidelity` by `__tests__/period-pair.test.ts`.
//
// TWO THINGS THE CHASSIS ONLY DOES FOR A SKIN THAT ASKS:
//
//   `clock()`  — declaring it is the single switch that mounts `PadClockBar`
//                and turns on `at` stamping in `pad-host.tsx`'s `send`
//                gateway (types.ts:1108-1138). Before this wave no skin
//                declared it, so R6/task A's whole seam was unreachable in the
//                product. These two are the first, and `state.asOf` +
//                `ActiveSuspension.expiresAt` come alive with it.
//   `phase()`  — the richer engine phase (`pre` | Q1..Q4/P1..P3/H1,H2 | OT |
//                SHOOTOUT | done/final/abandoned) mapped DOWN to the three-value
//                UI concept here, never by widening `PadPhase`.

import type { FidelityBand } from "@seazn/engine/sport";
import type { MessageKey } from "@/lib/messages";
import { ENUM_VOCAB } from "@/lib/scoring-vocab";
import type { SportTone } from "../sport-theme";
import type { PadClockSpec } from "../clock";
import {
  MORE_SHEET_KEY,
  type ActivityDetailContext,
  type Blocked,
  type DockChip,
  type DockSpec,
  type GuidedSheetSpec,
  type GuidedSheetStep,
  type PadHostView,
  type PadPhase,
  type ScorebugSpec,
  type SkinDefV3,
  type StripItem,
  type SwapSlot,
  type TileSpec,
} from "../types";

export type TFn = (key: string, vars?: Record<string, string | number>) => string;
export type Side = "home" | "away";

export const SIDES: readonly Side[] = ["home", "away"];

const SIDE_LABEL: Record<Side, MessageKey> = {
  home: "scorepad.attribution.home",
  away: "scorepad.attribution.away",
};

/**
 * The three genuine divergences between the two skins. Deliberately small: a
 * field here is a claim that the two federations differ, and every field that
 * could be read off `cfg` or `summary` instead was.
 */
export interface PeriodSkinSpec {
  /** The engine module key, and the `pad.<key>.*` dictionary namespace. */
  readonly key: string;
  /**
   * Every suspension class this federation words, mapped to the sport tones
   * that colour it. An EMPTY array means DECLARED BUT UNCOLOURED — the class
   * has its own copy and reads as a word.
   *
   * That distinction is R4-4's precedent, recorded when tennis's four-step
   * code-violation ladder met two colour tokens: "the ends take `caution` and
   * `dismissal`; the two middle steps read as words". Hockey's three ARE three
   * physical cards, so all three are coloured (green -> `advisory`, the FIH
   * green card and the seventh sport token this wave added). Ice hockey's seven
   * are words on a scoresheet, so only the ends of its ladder — the two-minute
   * minor and the match penalty — take one.
   *
   * A class key ABSENT altogether is one an organiser added to `cfg` that this
   * skin has never heard of: it renders its own raw key rather than a wrong
   * word, and carries no colour.
   */
  readonly classes: Readonly<Record<string, readonly SportTone[]>>;
  /**
   * The offences this federation offers, in the order its own `padSpec` enum
   * lists them (`PeriodPreset.suspensionReasons`, kernel.ts:1953-1955).
   *
   * A MIRROR of the engine, and it comes with the obligation every mirror in
   * this chassis carries (`SkinDefV3.refusedEventTypes`' own doc): the skin owes
   * a test that reads the real `padSpec` and fails when the two disagree.
   * `__tests__/period-pair.test.ts` is that test. Copy for every member already
   * ships in four locales via `ENUM_VOCAB.reason`, minted by S4/#428.
   */
  readonly reasons: readonly string[];
}

// ---------------------------------------------------------------------------
// Structural readers — `PadHostView` hands `cfg`/`state`/`summary` as `unknown`
// ---------------------------------------------------------------------------

interface GameTimeShape {
  period: string;
  elapsed: number;
}

interface SuspensionShape {
  side?: string;
  person?: string;
  classKey?: string;
  teamShort?: boolean;
  permanent?: boolean;
  startedAt?: GameTimeShape;
  expiresAt?: GameTimeShape;
  minutes?: number;
}

interface PeriodStateShape {
  phase?: string;
  entrants?: { home?: string; away?: string };
  goals?: { home?: number; away?: number };
  suspensions?: SuspensionShape[];
  asOf?: GameTimeShape;
  outcome?: { kind?: string; method?: string } | null;
}

interface SuspensionClassShape {
  minutes?: number | null;
  teamShort?: boolean;
  permanent?: boolean;
}

interface PeriodCfgShape {
  periods?: { count?: number; minutes?: number };
  overtime?: null | { kind?: string; minutes?: number; count?: number };
  shootout?: null | { attempts?: number };
  suspensions?: null | { classes?: Record<string, SuspensionClassShape> };
  goalKinds?: string[];
  assists?: boolean;
  setPieceKinds?: string[];
}

interface PeriodSummaryShape {
  detail?: {
    nextAdvance?: string | null;
    shootoutNext?: string | null;
    strength?: string | null;
    escalate?: string[];
    shootout?: { home?: number; away?: number };
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function asState(state: unknown): PeriodStateShape {
  return asRecord(state) as PeriodStateShape;
}

export function asCfg(cfg: unknown): PeriodCfgShape {
  return asRecord(cfg) as PeriodCfgShape;
}

export function asSummary(summary: unknown): PeriodSummaryShape {
  return asRecord(summary) as PeriodSummaryShape;
}

export function readPhase(state: unknown): string {
  const phase = asState(state).phase;
  return typeof phase === "string" && phase.length > 0 ? phase : "pre";
}

export function entrantOf(state: PeriodStateShape, side: Side): string {
  const id = state.entrants?.[side];
  return typeof id === "string" && id.length > 0 ? id : side;
}

function sideOfEntrant(state: PeriodStateShape, entrantId: unknown): Side | null {
  for (const side of SIDES) if (entrantOf(state, side) === entrantId) return side;
  return null;
}

/** Who is on the field/ice right now, from the squad state the HOST always
 *  resolves (`PadHostView.squads`, `state.squads` else `initSquads(lineups)`) —
 *  never from `state.squads` directly, which most folds never populate. */
export function onFieldOf(view: PadHostView, side: Side): readonly string[] {
  return view.squads[side].members.filter((m) => m.onField).map((m) => m.personId);
}

function benchOf(view: PadHostView, side: Side): readonly string[] {
  return view.squads[side].members.filter((m) => !m.onField).map((m) => m.personId);
}

// ---------------------------------------------------------------------------
// Phase — the three-value UI concept, and the shootout/overtime facts R7 needs
// ---------------------------------------------------------------------------

/**
 * The phases in which the MATCH IS OVER. Everything else the kernel can put in
 * `state.phase` comes out of `playPhases(cfg)` (kernel.ts:677-683) — `"pre"`,
 * the scoring phases, and `"SHOOTOUT"` — so classification needs no copy of
 * `periodLabels`/`otLabels` and follows a cfg that renames every marker.
 * `__tests__/period-pair.test.ts` sweeps every phase both kernels can reach and
 * fails if this set ever stops being total.
 */
const POST_PHASES: ReadonlySet<string> = new Set(["done", "final", "abandoned"]);

export const SHOOTOUT_PHASE = "SHOOTOUT";

/** A phase in which play is running — the kernel's own `isPlayPhase`, reached
 *  by elimination rather than by rebuilding its label list. */
export function isPlayPhaseToken(phase: string): boolean {
  return phase !== "pre" && phase !== SHOOTOUT_PHASE && !POST_PHASES.has(phase);
}

export function resolvePhase(view: Pick<PadHostView, "state">): PadPhase {
  const phase = readPhase(view.state);
  if (phase === "pre") return "pre";
  if (POST_PHASES.has(phase)) return "post";
  return "live";
}

/** The five phase tokens this skin words itself. Everything else is either in
 *  the shared `matchPhase.*` vocabulary (FT/HT/QT/3QT/ET_*) or a scoreboard
 *  token a scorer already reads verbatim — Q3, P2, OT, OT2. */
const OWN_PHASE_TOKENS: ReadonlySet<string> = new Set(["pre", SHOOTOUT_PHASE, "done", "final", "abandoned"]);

function vocabKey(field: string, value: string): MessageKey | null {
  for (const map of ENUM_VOCAB[field] ?? []) {
    const key = map[value];
    if (key) return key;
  }
  return null;
}

function vocabText(field: string, value: unknown, t: TFn): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const key = vocabKey(field, value);
  return key ? t(key) : value;
}

export function phaseLabel(spec: PeriodSkinSpec, phase: string, t: TFn): string {
  if (OWN_PHASE_TOKENS.has(phase)) return t(`pad.${spec.key}.phase.${phase}`);
  const shared = vocabKey("phase", phase);
  return shared !== null ? t(shared) : phase;
}

// ---------------------------------------------------------------------------
// clock() — the switch that makes R6/task A's seam reachable
// ---------------------------------------------------------------------------

/**
 * THE CLOCK DECLARATION, and the reason this wave exists.
 *
 * Present in a PLAY phase and nowhere else:
 *
 *   pre / done / final / abandoned  — there is no period to count within, and a
 *                                     stamp naming one would be a lie the fold
 *                                     would have to carry forever.
 *   SHOOTOUT                        — a shoot-out is not on the game clock. FIH
 *                                     gives each attempt its OWN eight seconds
 *                                     (`cfg.shootout.clockSeconds`) and IIHF
 *                                     none at all, so a running match clock
 *                                     here would be exactly the "phase where a
 *                                     running clock would be a lie" that
 *                                     `SkinDefV3.clock`'s own doc excludes.
 *                                     Every shoot-out payload takes `at`
 *                                     optionally and simply goes unstamped.
 *
 * `seed` is `state.asOf.elapsed` GUARDED against a stamp left over from a phase
 * the match has already left — the same staleness guard football's `readClock`
 * applies, and the reason `PadClockSpec.seed` is the skin's job rather than the
 * chassis's: only the skin knows the shape of its own state.
 */
export function buildClock(view: PadHostView): PadClockSpec | null {
  const state = asState(view.state);
  const phase = readPhase(state);
  if (!isPlayPhaseToken(phase)) return null;
  const asOf = state.asOf;
  const fresh =
    asOf !== undefined &&
    asOf.period === phase &&
    typeof asOf.elapsed === "number" &&
    Number.isFinite(asOf.elapsed) &&
    asOf.elapsed >= 0;
  return fresh ? { period: phase, seed: asOf.elapsed } : { period: phase };
}

// ---------------------------------------------------------------------------
// Event types, bands and phase gating
// ---------------------------------------------------------------------------

export interface PeriodEventTypes {
  readonly goal: string;
  readonly advance: string;
  readonly suspStart: string;
  readonly suspEnd: string;
  readonly attempt: string;
  readonly setPiece: string;
  readonly shot: string;
}

export function eventTypesOf(spec: PeriodSkinSpec): PeriodEventTypes {
  const k = spec.key;
  return {
    goal: `${k}.goal`,
    advance: `${k}.period.advance`,
    suspStart: `${k}.suspension.start`,
    suspEnd: `${k}.suspension.end`,
    attempt: `${k}.shootout.attempt`,
    setPiece: `${k}.set_piece`,
    shot: `${k}.shot`,
  };
}

/**
 * The band each type first becomes recordable at — `makePeriodModule`'s own
 * `padSpec(cfg).fidelity` (kernel.ts:2161-2169), restated because the view
 * carries `band` but not `padSpec`. Pinned against the real module by
 * `__tests__/period-pair.test.ts`, which is what keeps the restatement honest.
 */
export function bandsOf(spec: PeriodSkinSpec): Readonly<Record<string, FidelityBand>> {
  const e = eventTypesOf(spec);
  return {
    [e.goal]: 0,
    [e.advance]: 0,
    [e.attempt]: 0,
    [e.suspStart]: 1,
    [e.suspEnd]: 1,
    [e.setPiece]: 2,
    [e.shot]: 3,
  };
}

/**
 * The SWAP's band. `core.lineup.substitution` is a core event and carries no
 * `padSpec.fidelity` entry of its own, so this is a pad policy rather than an
 * engine one: it sits at 2 for the reason football's own `football.sub` does —
 * a band-0/1 record is the score and the cards, and who was on the ice at the
 * time is exactly the detail band 2 buys.
 */
export const SWAP_BAND: FidelityBand = 2;

export const SWAP_TYPE = "core.lineup.substitution";

/**
 * Whether the sport's own fold would take this type in this view, at all.
 *
 * Mirrors five reducer guards, each cited: `applyGoal`/`applySetPiece`/
 * `applyShot` require `isPlayPhase` (kernel.ts:1040, 1335, 1380);
 * `suspensionAllowed` is pre|play|SHOOTOUT (kernel.ts:1142-1146);
 * `applyShootoutAttempt` is SHOOTOUT only (kernel.ts:1287); `applyAdvance`
 * refuses when `expectedAdvance` is null (kernel.ts:1119-1122) — which is read
 * from the summary rather than recomputed. The cfg-driven refusals are here
 * too: no `suspensions.classes` means the fold refuses both suspension events,
 * an empty `setPieceKinds` means it refuses set pieces, and a null `shootout`
 * means the SHOOTOUT phase is unreachable.
 *
 * `__tests__/period-pair.test.ts` drives every one of these at the REAL
 * reducer, in every phase both kernels can reach, for both sports. A mirror
 * agrees with itself; only the fold can referee.
 */
export function phaseAllows(
  spec: PeriodSkinSpec,
  eventType: string,
  view: PadHostView,
): boolean {
  const e = eventTypesOf(spec);
  const state = asState(view.state);
  const cfg = asCfg(view.cfg);
  const phase = readPhase(state);
  const play = isPlayPhaseToken(phase);
  const hasClasses = Object.keys(cfg.suspensions?.classes ?? {}).length > 0;

  if (eventType === e.goal || eventType === e.shot) return play;
  if (eventType === e.setPiece) return play && (cfg.setPieceKinds ?? []).length > 0;
  if (eventType === e.suspStart || eventType === e.suspEnd) {
    return hasClasses && (phase === "pre" || play || phase === SHOOTOUT_PHASE);
  }
  if (eventType === e.attempt) return phase === SHOOTOUT_PHASE;
  if (eventType === e.advance) return nextAdvanceOf(view) !== null;
  return true;
}

/** The kernel's own `expectedAdvance`, read off the summary it is already
 *  published on (kernel.ts:2553) rather than recomputed from `periods.count`. */
export function nextAdvanceOf(view: PadHostView): string | null {
  const next = asSummary(view.summary).detail?.nextAdvance;
  return typeof next === "string" && next.length > 0 ? next : null;
}

export function refusedEventTypesFor(spec: PeriodSkinSpec, view: PadHostView): string[] {
  return Object.keys(bandsOf(spec)).filter((type) => !phaseAllows(spec, type, view));
}

// ---------------------------------------------------------------------------
// The penalty box — the one thing that makes these two sports their own shape
// ---------------------------------------------------------------------------

export interface BoxEntry {
  readonly index: number;
  readonly side: Side;
  readonly classKey: string;
  readonly person?: string;
  readonly permanent: boolean;
  /** Whole game seconds still to run at the fold's own `asOf`, or `null` when
   *  this suspension has no expiry to count down to. */
  readonly remaining: number | null;
}

/**
 * Who is in the box, and for how much longer.
 *
 * `ActiveSuspension.expiresAt` is derived ONCE at start from the stamped `at`
 * plus the awarded minutes (`suspensions.ts:137-153`), and release is LAZY —
 * swept at the next stamped event and at each phase whistle. The kernel says so
 * itself (kernel.ts:842-843): the engine and a ticking display legitimately
 * disagree BETWEEN events. So the countdown here is measured against
 * `state.asOf` — the last stamped moment the fold actually knows about — and it
 * re-derives on every tap, which since R6/task A is every event. The pad's own
 * live seconds sit in `pad-host.tsx`'s clock state and never reach a skin;
 * `PadClockBar` renders them one row below this strip, which is where a scorer
 * reads "now" from.
 *
 * A suspension whose expiry names a DIFFERENT phase is reported with no
 * countdown rather than a wrong one: minutes across a whistle are the kernel's
 * arithmetic (`sweepThroughPhase`), not the pad's.
 */
export function boxOf(view: PadHostView): BoxEntry[] {
  const state = asState(view.state);
  const asOf = state.asOf;
  const out: BoxEntry[] = [];
  (state.suspensions ?? []).forEach((susp, index) => {
    const side = susp.side === "home" || susp.side === "away" ? susp.side : null;
    if (side === null || typeof susp.classKey !== "string") return;
    const expires = susp.expiresAt;
    const remaining =
      susp.permanent === true ||
      expires === undefined ||
      asOf === undefined ||
      expires.period !== asOf.period ||
      typeof expires.elapsed !== "number" ||
      typeof asOf.elapsed !== "number"
        ? null
        : Math.max(0, Math.floor(expires.elapsed - asOf.elapsed));
    out.push({
      index,
      side,
      classKey: susp.classKey,
      ...(typeof susp.person === "string" ? { person: susp.person } : {}),
      permanent: susp.permanent === true,
      remaining,
    });
  });
  return out;
}

/** Releasable = the fold will actually accept an end event for it. A permanent
 *  suspension is excluded by `applySuspensionEnd`'s own `!s.permanent`
 *  predicate (kernel.ts:1254), so offering one would be offering a refusal. */
export function releasableBox(view: PadHostView): BoxEntry[] {
  return boxOf(view).filter((entry) => !entry.permanent);
}

function formatSeconds(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** The class as this federation words it, falling back to the raw cfg key —
 *  an organiser may add a class this skin has never heard of. */
export function classLabel(spec: PeriodSkinSpec, classKey: string, t: TFn): string {
  return classKey in spec.classes ? t(`pad.${spec.key}.class.${classKey}`) : classKey;
}

function personName(view: PadHostView, personId: string, t: TFn): string {
  return view.personNames[personId] ?? t("eventCopy.unknownPerson");
}

/** Hockey's `escalate` hint set — players already carrying a green card, which
 *  the kernel publishes on the summary for `preset.key === "hockey"` alone
 *  (kernel.ts:2573). Ice hockey's summary simply never carries the field, so
 *  nothing here needs to know which sport it is running in. */
export function escalatingOf(view: PadHostView): ReadonlySet<string> {
  const hints = asSummary(view.summary).detail?.escalate;
  return new Set(Array.isArray(hints) ? hints.filter((id): id is string => typeof id === "string") : []);
}

// ---------------------------------------------------------------------------
// scorebug()
// ---------------------------------------------------------------------------

export function buildScorebug(spec: PeriodSkinSpec, view: PadHostView, t: TFn): ScorebugSpec {
  const state = asState(view.state);
  const cfg = asCfg(view.cfg);
  const detail = asSummary(view.summary).detail;
  const phase = readPhase(state);

  const contextParts = [
    t(`pad.${spec.key}.context.format`, {
      count: cfg.periods?.count ?? 0,
      minutes: cfg.periods?.minutes ?? 0,
    }),
  ];
  if (cfg.overtime) contextParts.push(t(`pad.${spec.key}.context.overtime`));
  if (cfg.shootout) contextParts.push(t(`pad.${spec.key}.context.shootout`));

  // THE STRIP. Between them these items carry the two facts the chassis's own
  // duplicate headline bar (`pad-host.tsx:1216`) is the only surface for today —
  // the shoot-out tally and the overtime decision — which is what R6 committed
  // to before R7 makes that bar suppressible.
  const strip: StripItem[] = [
    {
      id: "period",
      label: t(`pad.${spec.key}.strip.period`),
      value: phaseLabel(spec, phase, t),
      tone: "led",
    },
  ];

  // THE SIGNATURE. A card in these two sports does not just go in the book, it
  // takes a player off — so the strength chip and the box's next release are
  // the pad's headline, not a footnote. `strength` comes straight off the
  // summary, which is also where ice hockey's INVERTED overtime advantage
  // already lives (`overtimeStrengthOf`: in sudden death the non-offending side
  // GAINS a skater rather than the offender losing one).
  const strength = detail?.strength;
  if (typeof strength === "string" && strength.length > 0) {
    strip.push({ id: "strength", label: t(`pad.${spec.key}.strip.strength`), value: strength, tone: "led" });
  }

  const box = boxOf(view);
  const soonest = box
    .filter((entry): entry is BoxEntry & { remaining: number } => entry.remaining !== null)
    .sort((a, b) => a.remaining - b.remaining)[0];
  if (soonest !== undefined) {
    strip.push({
      id: "box",
      label: t(`pad.${spec.key}.strip.box`),
      value: formatSeconds(soonest.remaining),
      accent: true,
    });
  } else if (box.some((entry) => entry.permanent)) {
    strip.push({
      id: "box",
      label: t(`pad.${spec.key}.strip.box`),
      value: t(`pad.${spec.key}.strip.permanent`),
      accent: true,
    });
  }

  const tally = detail?.shootout;
  if (tally !== undefined) {
    strip.push({
      id: "shootout",
      label: t(`pad.${spec.key}.strip.shootout`),
      value: `${tally.home ?? 0}–${tally.away ?? 0}`,
      tone: "led",
    });
  }

  const nextTaker = detail?.shootoutNext;
  if (phase === SHOOTOUT_PHASE && (nextTaker === "home" || nextTaker === "away")) {
    strip.push({
      id: "nextTaker",
      label: t(`pad.${spec.key}.strip.nextTaker`),
      value: t(SIDE_LABEL[nextTaker]),
      accent: true,
    });
  }

  if (state.outcome?.kind === "win" && state.outcome.method === "extra_time") {
    strip.push({ id: "ot", value: t(`pad.${spec.key}.strip.ot`), accent: true });
  }

  return {
    context: contextParts.join(" · "),
    phase: resolvePhase(view),
    halves: [
      {
        who: [{ name: t(SIDE_LABEL.home) }],
        big: String(state.goals?.home ?? 0),
        ...(tally === undefined ? {} : { sub: `(${tally.home ?? 0})` }),
      },
      {
        who: [{ name: t(SIDE_LABEL.away) }],
        big: String(state.goals?.away ?? 0),
        ...(tally === undefined ? {} : { sub: `(${tally.away ?? 0})` }),
      },
    ],
    strip,
  };
}

// ---------------------------------------------------------------------------
// tiles()
// ---------------------------------------------------------------------------

export function suspensionSheetKey(side: Side): string {
  return `suspension-${side}`;
}

export function attemptSheetKey(side: Side): string {
  return `attempt-${side}`;
}

export function swapSlotId(side: Side): string {
  return `sub-${side}`;
}

export const RELEASE_SHEET = "release";
export const SET_PIECE_SHEET = "set-piece";

export function buildTiles(spec: PeriodSkinSpec, view: PadHostView, t: TFn): TileSpec[] {
  const state = asState(view.state);
  const e = eventTypesOf(spec);
  const bands = bandsOf(spec);
  const tiles: TileSpec[] = [];

  const offerable = (type: string): boolean => {
    const declared = bands[type];
    return phaseAllows(spec, type, view) && (declared === undefined || declared <= view.band);
  };

  // GOAL — a tile, one per side, and the only primary. Everything the scorer
  // might add (who scored, assists, how, empty net) is a dock chip on the held
  // tap, so the commonest event in both sports is still a single press.
  if (offerable(e.goal)) {
    for (const side of SIDES) {
      tiles.push({
        id: `goal-${side}`,
        label: `pad.${spec.key}.action.goal`,
        sublabel: SIDE_LABEL[side],
        kind: "primary",
        span: 2,
        phases: ["live"],
        action: { event: { type: e.goal, payload: { by: entrantOf(state, side) } } },
      });
    }
  }

  // SHOOT-OUT ATTEMPT — the other primary, and it replaces the goal tiles
  // rather than joining them, because the two are never legal in the same
  // phase. Disabled on the side whose turn it is not: the kernel refuses an
  // out-of-turn attempt outright (`applyShootoutAttempt`, "attempts must
  // alternate"), and the summary already says whose it is.
  if (offerable(e.attempt)) {
    const next = asSummary(view.summary).detail?.shootoutNext;
    for (const side of SIDES) {
      tiles.push({
        id: attemptSheetKey(side),
        label: `pad.${spec.key}.action.shootoutAttempt`,
        sublabel: SIDE_LABEL[side],
        kind: "primary",
        span: 2,
        phases: ["live"],
        ...(next === "home" || next === "away" ? (next === side ? {} : { disabled: true }) : {}),
        action: { sheet: attemptSheetKey(side) },
      });
    }
  }

  // THE WHISTLE. One tap, no sheet: `expectedAdvance` leaves nothing to choose,
  // and the tile says which marker it is about to record rather than making the
  // scorer open a picker to find out.
  const next = nextAdvanceOf(view);
  if (next !== null && offerable(e.advance)) {
    tiles.push({
      id: "advance",
      label: `pad.${spec.key}.action.advance`,
      sublabelText: phaseLabel(spec, next, t),
      kind: "standard",
      span: 2,
      phases: ["live"],
      action: { event: { type: e.advance, payload: { to: next } } },
    });
  }

  if (offerable(e.suspStart)) {
    for (const side of SIDES) {
      tiles.push({
        id: suspensionSheetKey(side),
        label: `pad.${spec.key}.action.suspensionStart`,
        sublabel: SIDE_LABEL[side],
        kind: "standard",
        span: 2,
        phases: ["live"],
        action: { sheet: suspensionSheetKey(side) },
      });
    }
  }

  // RELEASE — present only while somebody is actually releasable. A permanent
  // card is not, and neither is an empty box; a tile that is always there and
  // always refused is the thing this chassis exists to stop drawing.
  if (offerable(e.suspEnd) && releasableBox(view).length > 0) {
    tiles.push({
      id: RELEASE_SHEET,
      label: `pad.${spec.key}.action.suspensionEnd`,
      kind: "standard",
      span: 2,
      phases: ["live"],
      action: { sheet: RELEASE_SHEET },
    });
  }

  if (view.band >= SWAP_BAND && isPlayPhaseToken(readPhase(state))) {
    for (const side of SIDES) {
      tiles.push({
        id: swapSlotId(side),
        label: `pad.${spec.key}.action.sub`,
        sublabel: SIDE_LABEL[side],
        kind: "standard",
        span: 2,
        phases: ["live"],
        action: { swap: swapSlotId(side) },
      });
    }
  }

  if (offerable(e.setPiece)) {
    tiles.push({
      id: SET_PIECE_SHEET,
      label: `pad.${spec.key}.action.setPiece`,
      kind: "minor",
      span: 2,
      phases: ["live"],
      action: { sheet: SET_PIECE_SHEET },
    });
  }

  // Shots stay in the generic More sheet, exactly as football's do: a band-3
  // stream of them does not deserve two of the board's four columns, and the
  // chassis already renders the engine's own action form for the type.
  tiles.push({
    id: "more",
    label: "scorepad.skin.more",
    kind: "minor",
    span: 4,
    phases: ["live"],
    action: { sheet: MORE_SHEET_KEY },
  });

  return tiles;
}

// ---------------------------------------------------------------------------
// sheets()
// ---------------------------------------------------------------------------

function classOptions(spec: PeriodSkinSpec, view: PadHostView, t: TFn) {
  const classes = asCfg(view.cfg).suspensions?.classes ?? {};
  return Object.keys(classes).map((classKey) => {
    const tone = spec.classes[classKey];
    return {
      id: classKey,
      label: classLabel(spec, classKey, t),
      ...(tone !== undefined && tone.length > 0 ? { tone } : {}),
    };
  });
}

function suspensionSheet(spec: PeriodSkinSpec, view: PadHostView, side: Side, t: TFn): GuidedSheetSpec {
  const e = eventTypesOf(spec);
  const by = entrantOf(asState(view.state), side);
  const steps: GuidedSheetStep[] = [
    {
      id: "class",
      kind: "choice",
      title: `pad.${spec.key}.sheet.suspension.class.title`,
      options: classOptions(spec, view, t),
    },
    {
      id: "reason",
      kind: "choice",
      title: `pad.${spec.key}.sheet.suspension.reason.title`,
      options: spec.reasons.map((reason) => ({ id: reason, label: vocabKey("reason", reason) ?? reason })),
      // The offence is band-2 detail; below that the sheet is one tap and the
      // step never renders (`GuidedSheetStep.when` skips without asking).
      when: () => view.band >= 2,
    },
  ];
  return {
    event: e.suspStart,
    steps,
    buildPayload: (answers) => ({
      by,
      class: answers.class,
      ...(answers.reason ? { reason: answers.reason } : {}),
    }),
  };
}

/**
 * RELEASE. One step over the box itself, so the scorer picks the suspension
 * rather than re-describing it: the option id carries the entry's index and the
 * payload is rebuilt from that entry's own side/person/class.
 *
 * `person`/`class` are sent only when the entry actually carries them, because
 * `applySuspensionEnd` matches on whichever of them is present (kernel.ts:1251-
 * 1257) — sending an undefined-but-present key would narrow the match to
 * nothing.
 */
function releaseSheet(spec: PeriodSkinSpec, view: PadHostView, t: TFn): GuidedSheetSpec {
  const e = eventTypesOf(spec);
  const state = asState(view.state);
  const entries = releasableBox(view);
  return {
    event: e.suspEnd,
    steps: [
      {
        id: "target",
        kind: "choice",
        title: `pad.${spec.key}.sheet.release.target.title`,
        options: entries.map((entry) => ({
          id: String(entry.index),
          label: [
            t(SIDE_LABEL[entry.side]),
            classLabel(spec, entry.classKey, t),
            entry.person === undefined ? undefined : personName(view, entry.person, t),
          ]
            .filter((part): part is string => part !== undefined)
            .join(" · "),
        })),
      },
    ],
    buildPayload: (answers) => {
      const entry = entries.find((row) => String(row.index) === answers.target);
      if (entry === undefined) return { by: entrantOf(state, "home") };
      return {
        by: entrantOf(state, entry.side),
        ...(entry.person === undefined ? {} : { person: entry.person }),
        class: entry.classKey,
      };
    },
  };
}

function attemptSheet(spec: PeriodSkinSpec, view: PadHostView, side: Side): GuidedSheetSpec {
  const e = eventTypesOf(spec);
  const by = entrantOf(asState(view.state), side);
  return {
    event: e.attempt,
    steps: [
      {
        id: "outcome",
        kind: "choice",
        title: `pad.${spec.key}.sheet.shootout.outcome.title`,
        options: [
          { id: "scored", label: vocabKey("outcome", "scored") ?? "scored" },
          { id: "missed", label: vocabKey("outcome", "missed") ?? "missed" },
        ],
      },
    ],
    buildPayload: (answers) => ({ by, scored: answers.outcome === "scored" }),
  };
}

const SET_PIECE_OUTCOMES: readonly string[] = ["scored", "saved", "missed", "post"];

function setPieceSheet(spec: PeriodSkinSpec, view: PadHostView, t: TFn): GuidedSheetSpec {
  const e = eventTypesOf(spec);
  const state = asState(view.state);
  const kinds = asCfg(view.cfg).setPieceKinds ?? [];
  return {
    event: e.setPiece,
    steps: [
      {
        id: "by",
        kind: "choice",
        title: `pad.${spec.key}.sheet.setPiece.by.title`,
        options: SIDES.map((side) => ({ id: entrantOf(state, side), label: SIDE_LABEL[side] })),
      },
      {
        id: "kind",
        kind: "choice",
        title: `pad.${spec.key}.sheet.setPiece.kind.title`,
        options: kinds.map((kind) => ({ id: kind, label: t(`pad.${spec.key}.setPiece.${kind}`) })),
        // Ice hockey declares exactly one (`ps`), so asking would be asking
        // nothing — `when` skips the step and `buildPayload` fills it in.
        when: () => kinds.length > 1,
      },
      {
        id: "outcome",
        kind: "choice",
        title: `pad.${spec.key}.sheet.setPiece.outcome.title`,
        options: SET_PIECE_OUTCOMES.map((outcome) => ({ id: outcome, label: vocabKey("outcome", outcome) ?? outcome })),
      },
    ],
    buildPayload: (answers) => ({
      by: answers.by,
      kind: answers.kind ?? kinds[0],
      ...(answers.outcome ? { outcome: answers.outcome } : {}),
    }),
  };
}

export function buildSheets(spec: PeriodSkinSpec, view: PadHostView, t: TFn): Record<string, GuidedSheetSpec> {
  const sheets: Record<string, GuidedSheetSpec> = {};
  for (const side of SIDES) {
    sheets[suspensionSheetKey(side)] = suspensionSheet(spec, view, side, t);
    sheets[attemptSheetKey(side)] = attemptSheet(spec, view, side);
  }
  sheets[RELEASE_SHEET] = releaseSheet(spec, view, t);
  sheets[SET_PIECE_SHEET] = setPieceSheet(spec, view, t);
  return sheets;
}

// ---------------------------------------------------------------------------
// swap()
// ---------------------------------------------------------------------------

/**
 * ROLLING SUBSTITUTION — presence, not enforcement.
 *
 * Both presets declare `reentry: "unlimited"` with `reentryPositionLock: false`
 * (hockey.ts:185-189, icehockey.ts:214-218), which is the engine already saying
 * a player may go off and come back as often as the coach likes. There is no
 * cap to report and no re-entry rule to refuse against, so `policyOk` is true
 * and `blocked` is empty: every candidate offered here is one the fold takes.
 *
 * The event is `core.lineup.substitution`, not a sport-level one — the period
 * kernel has no substitution event of its own and adopts the core fold's squad
 * state through `onLineup` (kernel.ts:2450).
 */
export function buildSwap(spec: PeriodSkinSpec, view: PadHostView): SwapSlot[] {
  const state = asState(view.state);
  if (!isPlayPhaseToken(readPhase(state)) || view.band < SWAP_BAND) return [];
  return SIDES.map((side) => {
    const members = view.squads[side].members;
    const onField = onFieldOf(view, side);
    const blocked: Record<string, string> = {};
    return {
      id: swapSlotId(side),
      offLabel: `pad.${spec.key}.swap.off`,
      onLabel: `pad.${spec.key}.swap.on`,
      side,
      eventType: SWAP_TYPE,
      policyOk: true,
      offCandidates: onField,
      candidates: benchOf(view, side),
      blocked: blocked as Blocked,
      buildEvent: (off: string, on: string) => {
        const offMember = members.find((m) => m.personId === off);
        const onMember = members.find((m) => m.personId === on);
        // The VACATED position leads, exactly as volleyball's libero exchange
        // learned to send it: the incoming player takes the slot the outgoing
        // one was holding, which is what a rolling change actually is.
        const positionKey = offMember?.positionKey ?? onMember?.lastPositionKey;
        return {
          type: SWAP_TYPE,
          payload: {
            side: entrantOf(state, side),
            off,
            on: {
              personId: on,
              slot: "starting" as const,
              orderNo: onMember?.orderNo ?? 1,
              ...(positionKey === undefined ? {} : { positionKey }),
              ...(onMember?.roles === undefined ? {} : { roles: onMember.roles }),
            },
          },
        };
      },
    };
  });
}

// ---------------------------------------------------------------------------
// dock()
// ---------------------------------------------------------------------------

function personChip(spec: PeriodSkinSpec, id: string, field: string, personId: string, labelText: string): DockChip {
  return {
    id,
    label: `pad.${spec.key}.dock.person`,
    labelText,
    mutate: (payload) => ({ ...payload, [field]: personId }),
  };
}

/** Append to a string array field, capped — `PeriodGoal.assists` is
 *  `z.array(PersonId).max(2)`, so a third chip would take the whole event down
 *  with it rather than being ignored. */
function assistChip(spec: PeriodSkinSpec, id: string, personId: string, labelText: string): DockChip {
  return {
    id,
    label: `pad.${spec.key}.dock.person`,
    labelText,
    mutate: (payload) => {
      const current = Array.isArray(payload.assists) ? (payload.assists as string[]) : [];
      if (current.includes(personId) || current.length >= 2) return payload;
      return { ...payload, assists: [...current, personId] };
    },
  };
}

export function buildDock(
  spec: PeriodSkinSpec,
  eventType: string,
  view: PadHostView,
  t: TFn,
  payload?: Record<string, unknown>,
): DockSpec | null {
  const e = eventTypesOf(spec);
  const state = asState(view.state);
  const cfg = asCfg(view.cfg);
  const side = sideOfEntrant(state, payload?.by);

  if (eventType === e.goal) {
    const chips: DockChip[] = [];
    // HOW it was scored, from the cfg's own list. `fg` is the default and needs
    // no chip; `og` is the own-goal FLAG below, because it does not describe the
    // shot, it moves the goal to the other side (`applyGoal` credits the
    // opponent for it).
    for (const kind of cfg.goalKinds ?? []) {
      if (kind === "fg" || kind === "og") continue;
      chips.push({
        id: `kind:${kind}`,
        label: `pad.${spec.key}.kind.${kind}`,
        mutate: (p) => ({ ...p, kind }),
      });
    }
    chips.push({
      id: "ownGoal",
      label: `pad.${spec.key}.dock.ownGoal`,
      kind: "flag",
      mutate: (p) => ({ ...p, kind: "og" }),
    });
    chips.push({
      id: "emptyNet",
      label: `pad.${spec.key}.action.goal.field.emptyNet`,
      kind: "flag",
      mutate: (p) => ({ ...p, emptyNet: true }),
    });

    if (side !== null && view.band >= 2) {
      const scorer = typeof payload?.person === "string" ? payload.person : undefined;
      const ownGoal = payload?.kind === "og";
      if (scorer === undefined) {
        for (const id of onFieldOf(view, side)) {
          chips.push(personChip(spec, `person:${id}`, "person", id, personName(view, id, t)));
        }
      } else if (!ownGoal && cfg.assists === true) {
        // ASSISTS ONLY WHERE THE SPORT HAS THEM. `cfg.assists` is false for
        // hockey and `applyGoal` refuses a non-empty `assists` outright when it
        // is; an own goal cannot carry them in either sport.
        for (const id of onFieldOf(view, side)) {
          if (id === scorer) continue;
          chips.push(assistChip(spec, `assist:${id}`, id, t(`pad.${spec.key}.dock.assist`, { name: personName(view, id, t) })));
        }
      }
    }
    const titled =
      typeof payload?.person === "string" && payload.kind !== "og" && cfg.assists === true
        ? `pad.${spec.key}.dock.goal.assist.title`
        : `pad.${spec.key}.dock.goal.title`;
    return { title: t(titled), chips };
  }

  if (eventType === e.suspStart) {
    if (side === null) return { title: t(`pad.${spec.key}.dock.suspension.title`), chips: [] };
    const escalating = escalatingOf(view);
    const offender = typeof payload?.person === "string" ? payload.person : undefined;
    const chips = onFieldOf(view, side).map((id) =>
      personChip(spec, `person:${id}`, "person", id, personName(view, id, t)),
    );
    // The FIH escalation hint, reusing the sentence S13 already shipped in four
    // locales (`pad.pp.escalation`) rather than minting a second one. It fires
    // exactly where the v2 period skin fired it — once the offender is named and
    // that offender is already carrying a green card — and it can only ever
    // appear for hockey, because ice hockey's summary carries no `escalate`.
    const title =
      offender !== undefined && escalating.has(offender)
        ? t("pad.pp.escalation")
        : t(`pad.${spec.key}.dock.suspension.title`);
    return { title, chips };
  }

  if (eventType === e.attempt) {
    if (side === null || view.band < 2) return null;
    const chips = onFieldOf(view, side).map((id) =>
      personChip(spec, `person:${id}`, "person", id, personName(view, id, t)),
    );
    return { title: t(`pad.${spec.key}.dock.shootout.title`), chips };
  }

  if (eventType === e.setPiece) {
    if (side === null || view.band < 2) return null;
    const chips = onFieldOf(view, side).map((id) =>
      personChip(spec, `person:${id}`, "person", id, personName(view, id, t)),
    );
    return { title: t(`pad.${spec.key}.dock.setPiece.title`), chips };
  }

  return null;
}

// ---------------------------------------------------------------------------
// activityDetail()
// ---------------------------------------------------------------------------

function join(parts: (string | undefined)[]): string | undefined {
  const kept = parts.filter((part): part is string => part !== undefined && part.length > 0);
  return kept.length > 0 ? kept.join(" · ") : undefined;
}

export function buildActivityDetail(spec: PeriodSkinSpec, ctx: ActivityDetailContext): string | undefined {
  const { t, eventType, payload, personNames } = ctx;
  const e = eventTypesOf(spec);
  const state = asState(ctx.state);
  const named = (id: unknown): string | undefined =>
    typeof id === "string" && id.length > 0 ? (personNames?.[id] ?? t("eventCopy.unknownPerson")) : undefined;

  if (eventType === e.goal) {
    const assists = Array.isArray(payload.assists) ? (payload.assists as unknown[]) : [];
    return join([
      named(payload.person),
      assists.length === 0
        ? undefined
        : t(`pad.${spec.key}.ribbon.goal.assist`, {
            name: assists.map((id) => named(id) ?? "").filter(Boolean).join(", "),
          }),
      typeof payload.kind === "string" && payload.kind !== "fg"
        ? payload.kind === "og"
          ? t(`pad.${spec.key}.dock.ownGoal`)
          : t(`pad.${spec.key}.kind.${payload.kind}`)
        : undefined,
      payload.emptyNet === true ? t(`pad.${spec.key}.action.goal.field.emptyNet`) : undefined,
    ]);
  }
  if (eventType === e.suspStart || eventType === e.suspEnd) {
    return join([
      typeof payload.class === "string" ? classLabel(spec, payload.class, t) : undefined,
      named(payload.person),
      vocabText("reason", payload.reason, t),
    ]);
  }
  if (eventType === e.advance) {
    return typeof payload.to === "string" ? phaseLabel(spec, payload.to, t) : undefined;
  }
  if (eventType === e.attempt) {
    const kickSide = sideOfEntrant(state, payload.by);
    return join([
      kickSide === null ? undefined : t(SIDE_LABEL[kickSide]),
      t(payload.scored === true ? "outcome.scored" : "outcome.missed"),
      named(payload.person),
    ]);
  }
  if (eventType === e.setPiece) {
    return join([
      typeof payload.kind === "string" ? t(`pad.${spec.key}.setPiece.${payload.kind}`) : undefined,
      vocabText("outcome", payload.outcome, t),
      named(payload.person),
    ]);
  }
  if (eventType === e.shot) {
    return join([vocabText("outcome", payload.outcome, t), named(payload.person)]);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The skin itself
// ---------------------------------------------------------------------------

/**
 * Both R6 skins, from one spec. A FACTORY of a factory: `V3_SKINS` holds
 * `(t) => SkinDefV3` and never a resolved skin, because module-eval time has no
 * live locale.
 */
export function makePeriodSkin(spec: PeriodSkinSpec): (t: TFn) => SkinDefV3<PadHostView> {
  return (t: TFn) => ({
    key: spec.key,
    // "T" — every tile here is a hold-then-refine tap, and the goal dock is the
    // whole reason: a scorer records the goal in one press and names the scorer
    // (and, in ice hockey, up to two assists) while the ribbon is still up.
    tapModel: "T",
    phase: resolvePhase,
    scorebug: (view) => buildScorebug(spec, view, t),
    tiles: (view) => buildTiles(spec, view, t),
    dock: (eventType, view, payload) => buildDock(spec, eventType, view, t, payload),
    sheets: (view) => buildSheets(spec, view, t),
    swap: (view) => buildSwap(spec, view),
    refusedEventTypes: (view) => refusedEventTypesFor(spec, view),
    activityDetail: (ctx) => buildActivityDetail(spec, ctx),
    clock: buildClock,
  });
}
