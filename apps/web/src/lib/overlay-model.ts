// The stream overlay's ONE projection (spec §2, R3). Pure: no React, no
// `@/server/**` (the stage that calls it is a client component — a client
// component importing @/server is a BUILD failure), no engine import. Every
// derivation is imported from `@/lib/public-site`, never re-derived (R5).
//
// All eleven sports render through this. Board game, carrom and generic come
// out with `cells: []` and `detail: []` — a designed state, not an error.
import {
  battingEntrantId,
  chaseBalls,
  chaseNeed,
  disciplineLabel,
  disciplineList,
  matchStrength,
  periodBreakdown,
  servingSide,
  setBreakdown,
} from "@/lib/public-site";
import {
  renderDecidedOutcome,
  shootoutScoreFromDetail,
  type DecidedOutcomeTemplates,
} from "@/lib/scoring-vocab";
import type { OverlayLiveData } from "@/components/public-site/live-score-data";
import type { SportTone } from "@/components/v2/scorepad/v3/sport-theme";

/**
 * A dictionary lookup over the `public` namespace. Deliberately NOT
 * `scoring-vocab.ts`'s `MsgFn`, whose key type is `keyof typeof ui.json`
 * (`lib/messages.ts:12`) and would reject every `overlay.*` key. A real
 * `MsgFn` is assignable to this.
 */
export type OverlayMsg = (key: string, vars?: Record<string, string | number>) => string;

export interface OverlaySideInput {
  id: string;
  name: string;
  /** The entrant's own short name where one ever reaches the public payload.
   *  None does today — `public_entrants_v` carries `display_name` and a
   *  `team_display` blob with no `short_name` — so this is always absent and
   *  `shortCode` falls to three letters. */
  short?: string | null;
}

export interface OverlaySide {
  short: string;
  name: string;
  big: string;
  sub?: string;
  /** The side in play: batting, or serving, or the winner once decided. */
  led: boolean;
  serving: boolean;
}

export interface OverlayCell {
  key: string;
  value: string;
}

/**
 * Fix round 4 (visual-pass-task5.md R1/R2/R3) — `cellsOf()` has always
 * returned TWO different kinds of thing under `OverlayModel.cells`: a
 * set/game breakdown (tennis/badminton/tabletennis/volleyball — `_THEMES.md`
 * §3/§4's "sets as cells" / "games as cells" rows, WITH a between-cells LED
 * cell) and a period breakdown (football/hockey/icehockey's own periods,
 * folded in here because `cellsOf` used to be the only place that
 * distinguished them). §3/§4 give the football family NO cell group and NO
 * between-cells LED at all — the team cell is `score / meta none` plus a
 * separate clock cell. Round 3 rendered `model.cells` for every sport
 * (R1/R3) and gated the between-cells LED on `!model.header.clock` (R2),
 * which is wrong whenever a football fold carries no clock — the exact state
 * that defeated it live. The kind was always known inside `cellsOf` and was
 * being thrown away; this field is that kind, made explicit so a renderer
 * gates the cell group AND the between-cells LED on it directly, never on
 * the incidental presence of a clock. `cells` itself is UNCHANGED — still
 * populated for `"periods"` — so every existing model-level assertion about
 * `model.cells` (`overlay-model.test.ts`'s football case) keeps holding; only
 * the renderers' gate moves off `cells.length`/`header.clock` and onto this.
 */
export type OverlayCellsKind = "sets" | "periods" | "none";

/**
 * One line of the bar's detail band / the bug's footer (review round 1,
 * CRITICAL+IMPORTANT findings against T1's card-chip closure). Was a bare
 * `string`; `tone` is additive so the serve sentence and the `matchStrength`
 * line (neither a card) carry none.
 */
export interface OverlayDetailLine {
  text: string;
  /** `_THEMES.md` §3/§4's 13.5×18 radius-3 card chip colour, present only for
   *  a discipline-card line. Absent (no chip) for every other detail line, and
   *  for a discipline entry whose class is DECLARED UNCOLOURED by the pad's own
   *  table (icehockey's `bench_minor`/`double_minor`/`major`/`misconduct`/
   *  `game_misconduct` — see `DISCIPLINE_CLASS_TONE` below). */
  tone?: SportTone;
}

export interface OverlayModel {
  live: boolean;
  /** The "decided" LED/result treatment applies — covers BOTH a plain
   *  decided/finalized fixture AND a void status carrying a real verdict
   *  (a forfeit, a DLS or leader-awarded abandon). `_THEMES.md` §3/§4's
   *  first two "Decided / void" rows share this one boolean; only the
   *  status WORD in `header.context` distinguishes them. */
  decided: boolean;
  /** Fix round 3, F1/F3 — `_THEMES.md` §3/§4's THIRD case: the fixture has
   *  ended with no verdict at all (a null outcome, a `no_result` kind, or
   *  `cancelled`, which never carries one). Both sides drop to 50% ink, no
   *  side carries the LED, and the detail band does not render — mutually
   *  exclusive with `decided`. */
  voided: boolean;
  header: {
    /** The word beside the dot: "Live" while playing, the decided/void
     *  status label once ended, or the scheduled start label / "Not
     *  started" fallback. Always present. */
    context: string;
    /** Fix round 3, F4 — the context LINE below it (`_THEMES.md` §3's
     *  "context line Geist 21/500 ink 70%"): the period/set label while
     *  live ("H1", "Set 1"). Absent for cricket/generic (no periods or
     *  sets) and for every non-live state — `overlay-bar.tsx` renders it
     *  only when set. */
    period?: string;
    clock?: string;
  };
  sides: [OverlaySide, OverlaySide];
  /** Which kind of breakdown `cells` holds — see `OverlayCellsKind`'s own
   *  comment. A renderer must gate the cell group AND the between-cells LED
   *  on this, never on `cells.length` alone or on `header.clock`. */
  cellsKind: OverlayCellsKind;
  cells: OverlayCell[];
  detail: OverlayDetailLine[];
  chase?: string;
  result?: string;
}

/**
 * W2's slot (R4). A TYPE ONLY in W1 — nothing constructs one, the stage
 * renders an empty `ovl-moment-slot`, and W2 re-declares the same four fields
 * plus `seq` in `lib/overlay-moments.ts`. Named here so W1's components can
 * leave room for it without importing a module that does not exist yet.
 */
export interface OverlayMoment {
  kind: string;
  headline: string;
  line?: string;
  /** Typed against the pad's own tone vocabulary (`SPORT_TONES`,
   *  sport-theme.ts:87 = advisory | caution | dismissal — design §3.4) plus
   *  `"led"` for the boundary/goal/set-point slab (_THEMES.md §5), so W2's
   *  slab widens additively and hockey's green card is reachable (review
   *  2026-09-08 finding 60). Never a hand-written union. */
  tone: SportTone | "led";
}

export interface OverlayModelInput {
  sportKey: string;
  /** The overlay endpoint's payload (Task 0, design §3.2) — the public
   *  summary plus `cricket.innings[]` for the chase denominator. */
  data: OverlayLiveData;
  sides: [OverlaySideInput, OverlaySideInput];
  /** The kick-off, already formatted by the server in the venue zone and the
   *  reader's locale. Null when the fixture carries no time. */
  startLabel: string | null;
  /** The football family's clock, already ticking and formatted by the STAGE
   *  (`useOverlayClock` → `formatClock`). Null when there is nothing to show.
   *  The model never reads a stamp and never derives a number. */
  clockLabel: string | null;
  msg: OverlayMsg;
  /** The decided sentence's templates — `fixture.decidedBy.*`, the `ui`
   *  namespace — resolved server-side exactly as `LiveScoreBody` receives them. */
  decidedTemplates: DecidedOutcomeTemplates;
}

const EM_DASH = "—";

/** Three letters, upper-cased — the bug's code column. Punctuation and spaces
 *  are dropped first so "St. Ives" reads STI, not "ST.". */
export function shortCode(side: OverlaySideInput): string {
  const explicit = side.short?.trim();
  if (explicit) return explicit.toUpperCase();
  const letters = side.name.replace(/[^\p{L}\p{N}]/gu, "");
  return letters.length > 0 ? letters.slice(0, 3).toUpperCase() : EM_DASH;
}

/** Kernel side lines are "<value> <meta>" — "142/6 (20)", "3". The value is
 *  the big numeral; anything after the first space is the meta column. */
export function splitLine(line: string): { big: string; sub?: string } {
  const at = line.indexOf(" ");
  if (at < 0) return { big: line };
  const sub = line.slice(at + 1).trim();
  return sub ? { big: line.slice(0, at), sub } : { big: line.slice(0, at) };
}

/**
 * Fix round 3, F1/F2 — the console's own "cancelled | abandoned | forfeited"
 * (`VOID_STATUSES`, `components/v2/stages-panel.tsx`), held as a LOCAL
 * literal rather than an import: `stages-panel.tsx` is a "use client"
 * competition-desk panel, and dragging its dependencies into the overlay's
 * OBS bundle is the exact cost `use-overlay-clock.ts`'s `NO_CLOCK_STATUSES`
 * already declines to pay (same reasoning, same shape). Exported so
 * `overlay-model.test.ts` can prove this equal to the real export — the
 * same shape `use-overlay-clock.test.ts` uses for its own local copy.
 */
export const OVERLAY_VOID_STATUSES = new Set(["cancelled", "abandoned", "forfeited"]);

/** Every status `_THEMES.md` §3/§4's "Decided / void" row treats as the
 *  match having ended — `decided`/`finalized` plus the three void statuses.
 *  Deliberately NOT `scheduled`: that state has its own header branch. */
const ENDED_STATUSES = new Set(["decided", "finalized", ...OVERLAY_VOID_STATUSES]);

/**
 * Fix round 3, F1 — the two-conjunct predicate `_THEMES.md` §3 pins verbatim
 * from `V355__division_results_abandoned_outcome.sql`: `outcome is not null
 * and outcome->>'kind' <> 'no_result'`. A win, an award, a draw and a tie are
 * all real verdicts (the migration's own words); only `no_result` — a
 * cricket abandon's own outcome shape — is not. Do NOT simplify to
 * `outcome != null` alone: `renderDecidedOutcome`/`resultMsg` both return
 * null for a `no_result` kind anyway, so keying on non-null alone would show
 * a decided frame (LED, "Final") around an empty result sentence.
 */
function hasVerdict(outcome: OverlayLiveData["outcome"]): boolean {
  return outcome != null && typeof outcome.kind === "string" && outcome.kind !== "no_result";
}

/**
 * Fix round 3, F1/F2/F7 — the word that replaces the live dot once a fixture
 * has ended, whichever of `_THEMES.md` §3's three end cases applies: "Final"
 * for a plain decided/finalized fixture (still `overlay.header.ended` — see
 * F7's own note: the key is used nowhere else, so its VALUE moves from
 * "Ended" to "Final" in the dictionaries rather than minting a second key),
 * else the void status's own new `overlay.status.*` word. Never `resultMsg`
 * and never `fixtureStatusLabel` — both explicitly ruled out by §3's i18n
 * note; these are new keys, deriving their SET from `VOID_STATUSES` above,
 * not a second hand-typed list.
 */
function statusLabel(msg: OverlayMsg, status: string): string {
  if (status === "cancelled") return msg("overlay.status.cancelled");
  if (status === "abandoned") return msg("overlay.status.abandoned");
  if (status === "forfeited") return msg("overlay.status.forfeited");
  return msg("overlay.header.ended");
}

function headerContext(input: OverlayModelInput, ended: boolean): string {
  const { data, msg, startLabel } = input;
  if (ended) return statusLabel(msg, data.status);
  if (data.status === "scheduled") return startLabel ?? msg("overlay.header.notStarted");
  return msg("overlay.header.live");
}

/** Fix round 3, F4 — the context LINE under "Live" (`_THEMES.md` §3's own
 *  second line), split out of the old `headerContext` so the status word
 *  above it can always say "Live" rather than a period/set label crowding
 *  it out. Undefined once ended (P8's already-correct decided render shows
 *  no second line) or scheduled, and for a sport with neither a period nor
 *  a set breakdown (cricket, generic) — an absent line is invisible, not a
 *  gap the sheet asks this fix round to close. */
function headerPeriod(input: OverlayModelInput, ended: boolean): string | undefined {
  const { data, msg, sportKey } = input;
  if (ended || data.status === "scheduled") return undefined;
  const periods = periodBreakdown(data.summary);
  if (periods && periods.length > 0) return periods[periods.length - 1]!.phase;
  const breakdown = setBreakdown(data.summary, sportKey);
  if (breakdown) {
    const n = breakdown.sets.length;
    // RE-PIN (2026-09-09): the brief compared against "Game" (capitalized);
    // `SetBreakdown.unit` (public-site.ts) is the lowercase `"game" | "set"`
    // literal union — tsc caught the always-false comparison (TS2367, no
    // overlap between the literal types) before this shipped as a badminton/
    // tabletennis header that could never say "Game".
    return breakdown.unit === "game" ? msg("overlay.header.game", { n }) : msg("overlay.header.set", { n });
  }
  return undefined;
}

function cellsOf(input: OverlayModelInput): { kind: OverlayCellsKind; cells: OverlayCell[] } {
  const breakdown = setBreakdown(input.data.summary, input.sportKey);
  if (breakdown) {
    return {
      kind: "sets",
      cells: breakdown.sets.map((s, i) => ({ key: String(i + 1), value: `${s.home}–${s.away}` })),
    };
  }
  const periods = periodBreakdown(input.data.summary);
  if (periods) {
    return { kind: "periods", cells: periods.map((p) => ({ key: p.phase, value: `${p.home}–${p.away}` })) };
  }
  return { kind: "none", cells: [] };
}

/**
 * classKey → chip tone, for the three sports `_THEMES.md` §3's content table
 * scopes card chips to (football, hockey, icehockey — `disciplineList()`
 * returns null for every other sport BY CONSTRUCTION: only the period kernel
 * populates `summary().detail.discipline`, `packages/engine/src/sports/
 * period/kernel.ts:2524`, `cardLog: state.cardLog`).
 *
 * FOOTBALL'S THREE ENTRIES BELOW ARE CURRENTLY UNREACHABLE (review round 2
 * finding). Football is NOT a period-kernel sport —
 * `packages/engine/src/sports/football/football.ts:509`, in football's own
 * words: "The period kernel's `cardLog` is the same idea; football simply
 * had none." Its `summary().detail` (`football.ts`, the `summary()` method's
 * return) carries only `periods`, optionally `shootout`, optionally
 * `abandoned` — never `discipline` — so `disciplineList()` is always `null`
 * for football and `detailOf()`'s card branch never runs for it: no card
 * LINE, let alone a coloured chip, regardless of how many `football.card`
 * events the match ledger holds (`overlay-model.test.ts` folds one through
 * the real engine and asserts exactly this). `_THEMES.md` §3/§4 describe
 * football's card chips as live in W1 (not W2, unlike cricket's row) — the
 * design sheet assumed engine data that does not exist, and `packages/engine`
 * is out of scope for this whole programme, so wiring the real capability is
 * not a fix available here. `yellow`/`red`/`second_yellow` stay in this
 * table anyway: they cost nothing (an unreachable key is not a wrong one),
 * they are hockey's own keys too (see below — no collision, same tones), and
 * they are forward-compatible dead code if the engine ever adds this rather
 * than a mapping this file would have to invent from scratch on that day.
 *
 * A DELIBERATE LITERAL, not an import of the pad's own tables
 * (`skins/football.tsx`'s `CARD_TONES`, `skins/hockey.tsx`'s
 * `HOCKEY_CLASSES`, `skins/icehockey.tsx`'s `ICEHOCKEY_CLASSES`) — same
 * reasoning as `overlay-tokens.ts`'s `OVERLAY_SPORT_KEYS`: those files are
 * `"use client"` pad skins, and `overlay-model.ts` is deliberately "no
 * React" (this file's own header). The three real tables are the authority;
 * `overlay-model.test.ts` imports them directly and asserts this literal
 * equal to their union in both directions, so a class either table adds or
 * recolours reds here until this literal is updated to match.
 *
 * Safe to merge into ONE flat map keyed on classKey alone (rather than
 * `(sportKey, classKey)`): football's `{yellow, red, second_yellow}` and
 * hockey's `{green, yellow, red}` overlap only on `yellow`/`red`, and both
 * sports map them to the SAME tone. icehockey's key vocabulary
 * (`minor`/`bench_minor`/…) shares no name with either. A future sport whose
 * own class vocabulary collides with an existing key under a DIFFERENT tone
 * would need this keyed by sport too — the mirror test below is what would
 * catch that collision (it fails the moment the union stops being a
 * function).
 */
export const DISCIPLINE_CLASS_TONE: Readonly<Record<string, readonly SportTone[]>> = {
  // football (skins/football.tsx CARD_TONES) — UNREACHABLE today, see above.
  yellow: ["caution"],
  red: ["dismissal"],
  second_yellow: ["caution", "dismissal"],
  // hockey (skins/hockey.tsx HOCKEY_CLASSES) — adds green; yellow/red already above
  green: ["advisory"],
  // icehockey (skins/icehockey.tsx ICEHOCKEY_CLASSES) — five of seven are
  // DECLARED UNCOLOURED (empty array), not merely absent from this table.
  minor: ["caution"],
  bench_minor: [],
  double_minor: [],
  major: [],
  misconduct: [],
  game_misconduct: [],
  match: ["dismissal"],
};

/** The chip colour for one discipline entry's class, or `undefined` for an
 *  uncoloured class (icehockey's five) or an unknown one. A multi-tone class
 *  (football's `second_yellow`: `["caution","dismissal"]`) takes the LAST
 *  tone — the pad's own rule for the same entry ("draws one swatch per
 *  entry… takes the OUTCOME (the last) for the option's wash",
 *  `skins/football.tsx`). */
export function disciplineTone(classKey: string): SportTone | undefined {
  const tones = DISCIPLINE_CLASS_TONE[classKey];
  return tones && tones.length > 0 ? tones[tones.length - 1] : undefined;
}

/**
 * The bar's second band in W1: the serve line, the strength chip and the
 * discipline list — every one of them already on the aggregate summary.
 *
 * NO PERSON NAME is rendered here. `disciplineList` entries carry an optional
 * `person`, but a name on air needs the consent resolver (R17) and that is
 * W2's work; the class and the side are what W1 shows.
 */
function detailOf(input: OverlayModelInput, codes: [string, string], live: boolean): OverlayDetailLine[] {
  const lines: OverlayDetailLine[] = [];
  const serving = servingSide(input.data.summary);
  if (live && serving) {
    lines.push({ text: input.msg("overlay.detail.serving", { side: serving === "home" ? codes[0] : codes[1] }) });
  }
  const strength = live ? matchStrength(input.data.summary) : null;
  if (strength) lines.push({ text: strength });
  for (const entry of disciplineList(input.data.summary) ?? []) {
    lines.push({
      text: input.msg("overlay.detail.card", {
        side: entry.side === "home" ? codes[0] : codes[1],
        card: disciplineLabel(entry.classKey),
      }),
      tone: disciplineTone(entry.classKey),
    });
  }
  return lines;
}

/** Which entrant carries the LED bar: the winner once decided (or void with
 *  a verdict), else the side batting, else the side serving, else nobody.
 *  Fix round 3, F1/F3 — `ended` guards the fall-through: without it, a
 *  match that ended with NO verdict (`voided`) could still show a stale LED
 *  on whichever side a frozen `summary` happened to record as batting or
 *  serving at the moment of abandonment, contradicting §3's "no LED
 *  anywhere" for that case. */
function ledEntrantId(input: OverlayModelInput, decided: boolean, ended: boolean): string | null {
  if (decided) return input.data.outcome?.winner ?? null;
  if (ended) return null;
  const batting = battingEntrantId(input.data.summary);
  if (batting) return batting;
  const serving = servingSide(input.data.summary);
  if (serving) return serving === "home" ? input.sides[0].id : input.sides[1].id;
  return null;
}

export function overlayModel(input: OverlayModelInput): OverlayModel {
  const { data, msg, sides } = input;
  // Fix round 3, F1 — the OLD predicate here was `data.status === "decided"
  // || data.status === "finalized"`, exactly the trap `_THEMES.md` §3 names:
  // a match that ended via `core.abandon`/`core.forfeit` never carries
  // status "decided", so it fell through to the LIVE branch below and
  // rendered "Live" on air. `ended` first decides WHETHER the match is over
  // (status alone — the fold's own authority, `fixtureStatusFromFold`);
  // `verdict` then decides WHICH of the three end cases applies, off the
  // OUTCOME column, never the status.
  const ended = ENDED_STATUSES.has(data.status);
  const verdict = hasVerdict(data.outcome);
  const decided = ended && verdict;
  const voided = ended && !verdict;
  const live = data.status === "in_play";
  const codes: [string, string] = [shortCode(sides[0]), shortCode(sides[1])];
  const led = ledEntrantId(input, decided, ended);
  const serving = servingSide(data.summary);
  // Kernel perSide order is [home, away]; a payload with anything else is a
  // payload this projection cannot place, so it falls to the em-dash state
  // rather than guessing which line belongs to which row.
  const perSide = data.summary?.perSide;
  const usable = Array.isArray(perSide) && perSide.length === 2 ? perSide : null;

  const overlaySides = ([0, 1] as const).map((row): OverlaySide => {
    const input_ = sides[row];
    const line = usable ? splitLine(usable[row]!.line) : { big: EM_DASH };
    return {
      short: codes[row],
      name: input_.name,
      big: line.big,
      ...(line.sub === undefined ? {} : { sub: line.sub }),
      led: led !== null && led === input_.id,
      serving: serving !== null && (row === 0 ? "home" : "away") === serving,
    };
  }) as [OverlaySide, OverlaySide];

  // Fix round 3, F1 — gated on `ended` (was `decided`): a void-no-verdict
  // frame has no chase and no clock either, not only a plain-decided one.
  const need = ended ? null : chaseNeed(data.summary);
  // Owner answer 12: both halves of `_THEMES.md` §3's line when the format
  // declares a quota, the runs-only key when it does not. Two keys rather than
  // one with an empty `{balls}` — a dangling "off" is worse than a short line.
  const balls = need === null ? null : chaseBalls(data.cricket);
  // The clock is the STAGE's timer (use-overlay-clock.ts), formatted before it
  // reaches this pure model; decided frames show none (amended 2026-09-07).
  const clock = ended ? null : input.clockLabel;
  const result = renderDecidedOutcome(
    data.outcome,
    { [sides[0].id]: sides[0].name, [sides[1].id]: sides[1].name },
    input.decidedTemplates,
    shootoutScoreFromDetail(data.summary?.detail),
  );
  // Fix round 3, F1/F3 — a void-no-verdict frame renders NO detail band at
  // all (`_THEMES.md` §3/§4): `chase`/`result` are already null by
  // construction for this branch (see `hasVerdict`'s doc comment), but a
  // discipline line recorded BEFORE the match was voided would otherwise
  // survive in `detail` and render a band the sheet says must be absent.
  const detail = voided ? [] : detailOf(input, codes, live);
  const period = headerPeriod(input, ended);
  const cellsResult = cellsOf(input);

  return {
    live,
    decided,
    voided,
    header: {
      context: headerContext(input, ended),
      ...(period === undefined ? {} : { period }),
      ...(clock === null ? {} : { clock }),
    },
    sides: overlaySides,
    cellsKind: cellsResult.kind,
    cells: cellsResult.cells,
    detail,
    ...(need === null
      ? {}
      : {
          chase:
            balls === null
              ? msg("overlay.chase.need", { runs: need })
              : msg("overlay.chase.needBalls", { runs: need, balls }),
        }),
    ...(result === null ? {} : { result }),
  };
}

/**
 * The start time a pre-match overlay prints, in the VENUE's zone.
 *
 * Owner answer 12 (2026-09-06) closed deviation 4: this used to be an
 * `Intl.DateTimeFormat` literal inlined in the overlay page with
 * `timeZone: "UTC"`, which is simply the wrong time for an Indian or Dutch club
 * audience. `tz` comes from `getPublicFixture(...).venueTz` — the VENUE lane
 * (`resolveVenueTz`, "one zone per fixture"), never the viewer's cookie and
 * never the organiser's personal zone: a London club can run an event in
 * Malaga, and the stream is watched in neither.
 *
 * Lives here rather than in the page so the format has one home and a test;
 * `overlayModel` itself still takes the finished string and stays pure
 * (deviation 3). An unusable zone degrades to UTC rather than throwing — a
 * `RangeError` here would 500 the overlay mid-broadcast.
 */
export function overlayStartLabel(iso: string | null, locale: string, tz: string): string | null {
  if (!iso) return null;
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return null;
  const options: Intl.DateTimeFormatOptions = {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  };
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone: tz }).format(when);
  } catch {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(when);
  }
}

/**
 * `mm:ss` for the football family's clock cell. Minutes are unbounded
 * ("90:00", "104:12" in extra time) because a period clock never wraps to
 * hours on air. The STAGE owns the number (use-overlay-clock.ts, the one 1 Hz
 * timer); this only spells it.
 *
 * RE-PIN (2026-09-09): `@seazn/engine/core` DOES export `formatElapsed`
 * (`core/time.ts:156`, re-exported via `core/index.ts`'s `export * from
 * "./time.ts"`) — but its own doc comment says "only seconds are zero-padded"
 * (`formatElapsed(0) === "0:00"`, `formatElapsed(65) === "1:05"`), while this
 * overlay cell zero-pads minutes too (`formatClock(0) === "00:00"`, asserted
 * in `__tests__/public-site-overlay-derive.test.ts`). Delegating would fail
 * that case, so the two stay separate on purpose: `formatElapsed` is a
 * scoresheet reading, this is a broadcast clock digit that must not jitter
 * width between "9:59" and "10:00".
 */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}
