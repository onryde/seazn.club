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
  chaseTargetRuns,
  chaseTargetSource,
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
import { cricketDetail } from "@/lib/overlay-cricket";
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
  /** Club kit colour (`team_display.colors.home_primary`) for the slate card tiles. */
  colour?: string | null;
}

export interface OverlaySide {
  short: string;
  name: string;
  /** `_THEMES.md` §1's one size step, longest first — see `nameLadder`. The
   *  bar renders the first rung that FITS; every other theme reads `name` or
   *  `short` and ignores this. */
  ladder: readonly string[];
  big: string;
  sub?: string;
  /** The side in play: batting, or serving, or the winner once decided. */
  led: boolean;
  serving: boolean;
  /** Tile fill on the slate match card; absent → CSS fallbacks. */
  colour?: string;
}

/** One top-performer chip on the ended slate card. */
export type OverlayHighlight = {
  name: string;
  line: string;
  detail?: string;
};

/** Competition / stage segments for the slate card meta pill. */
export type OverlaySlateMeta = {
  competition?: string;
  stage?: string;
};

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
   *  for a class no table names. EVERY DECLARED CARD CLASS CARRIES A TONE
   *  (§2a, product ruling 2026-09-10, F13) — until then icehockey's
   *  `bench_minor`/`double_minor`/`major`/`misconduct`/`game_misconduct` were
   *  declared uncoloured here, so a 5-minute major rendered no chip while a
   *  2-minute minor did. See `DISCIPLINE_CLASS_TONE` below. */
  tone?: SportTone;
  /** Cricket this-over ball chips (already notated). When set, bar/bug render
   *  circular LED pills after `text` instead of flattening glyphs into the string. */
  glyphs?: readonly string[];
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
    /** The word beside the dot: "Live" while playing, a void status label
     *  once abandoned/cancelled/forfeited, the scheduled start label / "Not
     *  started" fallback — or "" for a plain decided/finalized fixture (the
     *  short result lives in `period`; "Final" was retired 2026-09-12). */
    context: string;
    /** Fix round 3, F4 — the context LINE below it (`_THEMES.md` §3's
     *  "context line Geist 21/500 ink 70%"): the period/set label while
     *  live ("H1", "Set 1"). Absent for cricket/generic (no periods or
     *  sets) and while scheduled — `overlay-bar.tsx` renders it only when
     *  set.
     *
     *  Fix round 5, I2 — §3's "Decided / void" row gives this line a value
     *  in ALL THREE end cases, and round 3 gave it one in none of them.
     *  Decided (and void-carrying-a-verdict) carry the SHORT FORM of the
     *  result sentence; void-with-no-verdict carries "the sport's own line
     *  unchanged", which round 3 actively removed — a cancelled tennis
     *  match lost its "Set 3". */
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
  /**
   * Cricket live only: bar/bug show the batting side as a single hero and
   * (in a chase) a compact strip for the closed innings + absolute target.
   * Absent when scheduled, decided/void, or non-cricket — those keep both sides.
   */
  focus?: {
    hero: 0 | 1;
    strip?: string;
  };
  /** Slate match-card meta (competition · stage). Absent segments are omitted. */
  slateMeta?: OverlaySlateMeta;
  /** Ended slate only — top batter / bowler from the overlay poll (`data.highlights`). */
  highlights?: {
    batter?: OverlayHighlight;
    bowler?: OverlayHighlight;
  };
}

/**
 * Does §3's bar carry its DETAIL BAND? One authority, three readers.
 *
 * `overlay-bar.tsx` reads it to decide whether to render the band, and
 * `overlay-stage.tsx` reads it to place the moment slot — because the slab's
 * underside has to meet the bar's TOP edge (`_THEMES.md` §5, owner-ruled
 * 2026-09-11) and the bar's height is 126 or 177 depending on this one
 * predicate ("an empty detail band is not rendered", §3).
 *
 * It was a literal inside `overlay-bar.tsx` and a hard-coded `bottom: 231px`
 * in the stylesheet — the same fact stated twice, and they disagreed. A
 * football fixture scoring before its first card, and a cricket fixture before
 * its first ball, aired the slab floating 51 px above the bar with its
 * deliberately-square bottom corners exposed.
 *
 * Truthiness, not `!== undefined`, so this is EXACTLY the predicate that was
 * inside the bar: an empty `chase` string rendered no band and must keep
 * rendering none.
 *
 * It lives HERE rather than in `theme-registry.ts` because that module imports
 * the three theme components, and the bar importing it back would close a
 * cycle. This is a fact about the MODEL and needs nothing else.
 */
export function hasDetailBand(model: OverlayModel): boolean {
  return model.detail.length > 0 || Boolean(model.chase) || Boolean(model.result);
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
  /** Slate card pill — competition / stage names from the public page. */
  slateMeta?: OverlaySlateMeta | null;
}

const EM_DASH = "—";

/** Three letters from the entrant's NAME, upper-cased. Punctuation and spaces
 *  are dropped first so "St. Ives" reads STI, not "ST.".
 *
 *  Split out of `shortCode` for `nameLadder`: the ladder's BOTTOM rung is
 *  always this derivation, while `shortCode` prefers the entrant's own short
 *  name when one exists. Folded together they made a two-rung ladder whose
 *  last two entries differed only in case. */
export function threeLetterCode(name: string): string {
  const letters = name.replace(/[^\p{L}\p{N}]/gu, "");
  return letters.length > 0 ? letters.slice(0, 3).toUpperCase() : EM_DASH;
}

/** Three letters, upper-cased — the bug's code column. */
export function shortCode(side: OverlaySideInput): string {
  const explicit = side.short?.trim();
  if (explicit) return explicit.toUpperCase();
  return threeLetterCode(side.name);
}

/**
 * `_THEMES.md` §1's ladder, longest first: the full name, the entrant's own
 * short name where the payload carries one, then the three-letter code.
 *
 * A LIST rather than a step, because the choice is a MEASUREMENT and only the
 * browser can make it — §1 forbids wrapping, truncation and an ellipsis alike,
 * so the bar renders the first rung that fits its cell (`pickNameRung`).
 *
 * Deduped by value: a side whose short name is already its name, or whose short
 * name upper-cases to its own code, gets no rung that changes nothing on air —
 * a rung that renders identically is a step the ladder appears to have and does
 * not.
 *
 * `public_entrants_v` carries no `short_name` today (W1 watch-list 6, resolved
 * to the code), so in production this is [name, code]. The middle rung is
 * reachable the day that view grows one, and is driven in both directions by
 * `overlay-model.test.ts` rather than left to be discovered then.
 */
export function nameLadder(side: OverlaySideInput): readonly string[] {
  const explicit = side.short?.trim();
  const rungs = [
    side.name,
    ...(explicit === undefined || explicit === "" ? [] : [explicit]),
    threeLetterCode(side.name),
  ];
  return rungs.filter((rung, i) => rungs.indexOf(rung) === i);
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
 * has ended. Void statuses keep their own `overlay.status.*` word
 * (Abandoned / Cancelled / Forfeited). A plain decided/finalized fixture
 * returns "" — the short result already sits in `header.period` ("CAN won"),
 * and a status word of "Final" reads as a knockout stage name on air
 * (owner, 2026-09-12). Never `resultMsg` and never `fixtureStatusLabel`.
 */
function statusLabel(msg: OverlayMsg, status: string): string {
  if (status === "cancelled") return msg("overlay.status.cancelled");
  if (status === "abandoned") return msg("overlay.status.abandoned");
  if (status === "forfeited") return msg("overlay.status.forfeited");
  return "";
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
 *  it out. Undefined while scheduled, and for a sport with neither a period
 *  nor a set breakdown (cricket, generic) — an absent line is invisible.
 *
 *  Fix round 5, I2 — the `ended` half of the old guard is GONE. §3's third
 *  end case ("void, no verdict") says the sport's own line is *unchanged*,
 *  and returning undefined for every ended fixture removed it: a cancelled
 *  tennis match at "Set 3" lost the line it had been showing a second
 *  earlier. `overlayModel` still overrides this for the two cases that DO
 *  replace the line (decided and void-carrying-a-verdict, which take the
 *  short form of the result sentence). */
function sportPeriodLine(input: OverlayModelInput): string | undefined {
  const { data, msg, sportKey } = input;
  if (data.status === "scheduled") return undefined;
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
 * React" (this file's own header). The three real tables still fix WHICH
 * CLASSES EXIST; `overlay-model.test.ts` imports them directly and holds the
 * key sets equal in both directions, so a class either table adds, drops or
 * renames reds here until this literal is updated to match.
 *
 * THE TONES ARE §2a's, AND ON ICE HOCKEY THE TWO NO LONGER AGREE (product
 * ruling 2026-09-10, F13). `ICEHOCKEY_CLASSES` declares five of its seven
 * classes uncoloured (`[]`), so before this ruling a 5-minute `major` drew no
 * chip on air while a 2-minute `minor` drew one — backwards on a broadcast,
 * where the more serious offence should be the more visible graphic.
 * `_THEMES.md` §2a's table is now the authority for what this file colours:
 * `minor`/`bench_minor`/`double_minor` → caution, `major`/`misconduct`/
 * `game_misconduct`/`match` → dismissal. The pad is `components/v2/**` and out
 * of this wave's scope, so the divergence is DECLARED here and asserted from
 * both ends in the test file rather than left to be read as drift. Football's
 * and hockey's rows are unchanged and still mirror the pad exactly.
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
  // icehockey — `_THEMES.md` §2a's TABLE, not `skins/icehockey.tsx`'s
  // `ICEHOCKEY_CLASSES`. The pad still declares five of these seven
  // UNCOLOURED (`[]`) and this file no longer follows it there: see the
  // divergence paragraph in the block comment above. Two tiers, not three —
  // the sport has no green-card equivalent, so `advisory` stays unused here
  // rather than being invented for symmetry.
  minor: ["caution"],
  bench_minor: ["caution"],
  double_minor: ["caution"],
  major: ["dismissal"],
  misconduct: ["dismissal"],
  game_misconduct: ["dismissal"],
  match: ["dismissal"],
};

/** The chip colour for one discipline entry's class, or `undefined` for a
 *  class no table names (§2a leaves no DECLARED class uncoloured — the
 *  empty-array arm survives for a table that adds one). A multi-tone class
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
  // W2 Task 3 — the crease, FIRST in the band. For cricket it is the band's
  // whole reason to exist: this sport carries no serving side, no strength and
  // no discipline list, so before W2 its `detail` was always empty and the
  // second band never rendered at all. No `tone`: these are not card chips.
  if (live) {
    for (const line of cricketDetail(input.data.cricketLive, input.msg)) lines.push(line);
  }
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
        // Review MINOR 9 — the label is dictionary copy, resolved through the
        // SAME `msg` as the sentence it sits inside. It used to be the class
        // key title-cased, so a French stream read "{side} Bench minor".
        card: disciplineLabel(entry.classKey, input.msg),
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

/**
 * `_THEMES.md` §3's cricket row (owner ruling 2026-09-10) — the chase line
 * names the METHOD when the target was revised, so a rain-revised chase does
 * not show new numbers with nothing to say why they moved.
 *
 * Three cases, and the two non-null ones are NOT interchangeable: a manually
 * agreed target announced as DLS is a false claim about how it was set, made
 * on a live broadcast. `chaseTargetSource` already refuses to answer for
 * anything but the two methods the engine names.
 *
 * Appended HERE, in the projection, rather than in a component: both shipped
 * themes and every future theme inherit it from the one model, which is the
 * same property that lets eleven sports and N themes meet in one place. The
 * separator is the mid-dot both themes already use between detail items — a
 * punctuation choice, not copy, so it is not a dictionary key.
 */
function withRevisionMarker(
  line: string,
  source: "dls" | "manual" | null,
  msg: OverlayMsg,
): string {
  if (source === null) return line;
  // `DLS` is a proper noun and stays `DLS` in every locale; `Revised`
  // translates. Both are `public.overlay.chase.*` keys, never literals.
  return `${line} · ${msg(source === "dls" ? "overlay.chase.dls" : "overlay.chase.revised")}`;
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
    const colour = input_.colour?.trim();
    return {
      short: codes[row],
      name: input_.name,
      ladder: nameLadder(input_),
      big: line.big,
      ...(line.sub === undefined ? {} : { sub: line.sub }),
      led: led !== null && led === input_.id,
      serving: serving !== null && (row === 0 ? "home" : "away") === serving,
      ...(colour ? { colour } : {}),
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
  const shootout = shootoutScoreFromDetail(data.summary?.detail);
  const result = renderDecidedOutcome(
    data.outcome,
    { [sides[0].id]: sides[0].name, [sides[1].id]: sides[1].name },
    input.decidedTemplates,
    shootout,
  );
  // Fix round 5, I2 — `_THEMES.md` §3:330-333: "the band carries `resultMsg`'s
  // full sentence, the context line carries the same sentence with the winner
  // reduced to the short name the cell already uses ('Kings won by 44 runs'
  // against 'Mumbai Kings won by 44 runs'). Both come from `resultMsg`; only
  // the winner token differs." So this is the SAME producer with the SAME
  // templates and one different name map — never a second sentence authority,
  // which would let the bar and the detail band disagree about who won.
  // `codes` is what `OverlaySide.short` already carries (an entrant's own
  // short name where the payload ever holds one, else three letters).
  const shortResult = renderDecidedOutcome(
    data.outcome,
    { [sides[0].id]: codes[0], [sides[1].id]: codes[1] },
    input.decidedTemplates,
    shootout,
  );
  // Fix round 3, F1/F3 — a void-no-verdict frame renders NO detail band at
  // all (`_THEMES.md` §3/§4): `chase`/`result` are already null by
  // construction for this branch (see `hasVerdict`'s doc comment), but a
  // discipline line recorded BEFORE the match was voided would otherwise
  // survive in `detail` and render a band the sheet says must be absent.
  const detail = voided ? [] : detailOf(input, codes, live);
  // §3's "Decided / void" row, all three cases. The first two ("decided", and
  // "void carrying a verdict" — one boolean here, see `decided`'s own doc)
  // REPLACE the line with the short form; the third leaves the sport's own
  // line alone. A decided outcome the sentence producer has nothing to say
  // about (a draw — `renderDecidedOutcome` describes wins, ties and awards
  // only) falls to no line at all rather than back to the period: "H2" under
  // an empty status cell would still read as a match in its second half.
  const period = decided ? (shortResult ?? undefined) : sportPeriodLine(input);
  const cellsResult = cellsOf(input);
  const focus = cricketLiveFocus({
    sportKey: input.sportKey,
    live,
    summary: data.summary,
    sideIds: [sides[0].id, sides[1].id],
    overlaySides,
    codes,
    msg,
  });

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
          chase: withRevisionMarker(
            balls === null
              ? msg("overlay.chase.need", { runs: need })
              : msg("overlay.chase.needBalls", { runs: need, balls }),
            chaseTargetSource(data.summary),
            msg,
          ),
        }),
    ...(result === null ? {} : { result }),
    ...(focus === undefined ? {} : { focus }),
    ...(input.slateMeta
      ? {
          slateMeta: {
            ...(input.slateMeta.competition
              ? { competition: input.slateMeta.competition }
              : {}),
            ...(input.slateMeta.stage ? { stage: input.slateMeta.stage } : {}),
          },
        }
      : {}),
    ...(data.highlights && (data.highlights.batter || data.highlights.bowler)
      ? { highlights: data.highlights }
      : {}),
  };
}

/**
 * Live cricket: one hero (the side batting) instead of two finished-innings
 * columns. In a chase, the strip carries the closed side's score and the
 * absolute target — overs stay off the strip (compact).
 */
function cricketLiveFocus(args: {
  sportKey: string;
  live: boolean;
  summary: OverlayLiveData["summary"];
  sideIds: [string, string];
  overlaySides: [OverlaySide, OverlaySide];
  codes: [string, string];
  msg: OverlayMsg;
}): OverlayModel["focus"] | undefined {
  if (!args.live || args.sportKey !== "cricket") return undefined;
  const battingId = battingEntrantId(args.summary);
  if (battingId === null) return undefined;
  const hero = (args.sideIds[0] === battingId ? 0 : args.sideIds[1] === battingId ? 1 : null) as
    | 0
    | 1
    | null;
  if (hero === null) return undefined;

  const target = chaseTargetRuns(args.summary);
  if (target === null) return { hero };

  const other = (1 - hero) as 0 | 1;
  const closedBig = args.overlaySides[other].big;
  if (!closedBig || closedBig === EM_DASH) return { hero };

  const targetLabel = withRevisionMarker(
    args.msg("overlay.cricket.target", { target }),
    chaseTargetSource(args.summary),
    args.msg,
  );
  return {
    hero,
    strip: `${args.codes[other]} ${closedBig} · ${targetLabel}`,
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

/**
 * The same digit, but never past the period's declared length: `45+`, `90+`,
 * `20+` — broadcast's own convention for "we are in added time" (F16, product
 * ruling 2026-09-10, `_THEMES.md` §3). Driven live, a fixture left `in_play`
 * displayed `1205:25` — twenty hours — because the cell ticks from the fold's
 * anchor with no relation to the period's length.
 *
 * The bound is INCLUSIVE: `45:00` is a real reading and the one the ceiling is
 * named after, so only a value strictly past it takes the `+` form.
 *
 * `nominalSeconds` undefined means "no declared length", and this stays
 * UNBOUNDED there rather than inventing a ceiling — holding the display is the
 * stage's job (`use-overlay-clock.ts`), which is the only place that knows the
 * anchor the value came from. `formatClock` remains the spelling for every
 * number this one does not cap, so the two can never disagree about a digit.
 */
export function formatClockCapped(seconds: number, nominalSeconds?: number): string {
  if (nominalSeconds !== undefined && Number.isFinite(nominalSeconds) && seconds > nominalSeconds) {
    return `${Math.floor(Math.max(0, nominalSeconds) / 60)}+`;
  }
  return formatClock(seconds);
}
