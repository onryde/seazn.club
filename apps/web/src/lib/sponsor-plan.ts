// The sponsor planner — R4 sponsors on stream, S4 (spec 2026-10-27 §3.2). Pure: which natural break gets which sponsor
// card. The overlay read path (S5) calls it on every poll and persists `newAssignments`; the page (S6/S7) turns
// `plan.airings` into sponsor moments; the operator console plan (C2-C4) reads its types and log readers.
//
// Client-safe on purpose: it imports only the tier authority, so the hub preview and the console can run it too.
//
// Rules, in the order the walk applies them to each break of the fixture:
//   1. A FROZEN assignment wins over everything (dial, hidden, cooldown, freshness). Its sponsor never changes.
//   2. The dial (P2) — Light: every major; Normal: every major + every 3rd minor, counted over every minor of the
//      fixture, hidden ones included; Busy: every break.
//   3. Hidden graphics: a break opened while Hide graphics was on gets no card and takes no rotation position.
//   4. The 90 s cooldown thins MINOR breaks only (R4): within 90 s after the last break that has a card, or within 90 s
//      before a frozen card (a minor made eligible by a mid-match dial change must not crowd a card already given).
//   5. A NEW assignment only for a break inside the `recent` window and no older than SPONSOR_STALE_MS (R2), so a first
//      poll mid-match does not hand every past break a card.
//   6. Who: a pending Play next choice (operator, no position), else the P7 cycle at the org's next position (D14, F9).
//      Both draw on TICKED cards only. A frozen break still airs after its sponsor is unticked (spec §3.2: an untick
//      applies only to breaks not yet assigned), through `assignedCards`.
import { SPONSOR_TIER_WEIGHTS, type SponsorTier } from "@/lib/sponsor-tiers";

export type SponsorFrequency = "light" | "normal" | "busy";
export type SponsorStyle = "lower_third" | "banner";

/** Structurally the engine's `NaturalBreakDecl` (spec §3.1). Declared here, not imported, so the planner does not
 *  depend on an engine release; `size` is all the planner reads of a declaration. */
export type BreakSize = "minor" | "major";
export interface BreakDecl {
  kind: string;
  size: BreakSize;
}

/** Spec §3.2: "a 90 s cooldown between sponsor cards". */
export const SPONSOR_COOLDOWN_MS = 90_000;
/** Spec §3.2: Normal airs "every 3rd minor". */
export const NORMAL_MINOR_EVERY = 3;
/** Spec §3.2: minor → lower third, 8 s; major → banner, 15 s. */
export const SPONSOR_STYLE_BY_SIZE = {
  minor: { style: "lower_third", holdMs: 8_000 },
  major: { style: "banner", holdMs: 15_000 },
} as const satisfies Record<BreakSize, { style: SponsorStyle; holdMs: number }>;
/** Spec §3.4: a sponsor moment waiting longer than this has missed its break. R2 uses it as the freshness cut. */
export const SPONSOR_STALE_MS = 20_000;
/** Spec §3.4: each card on a scene carousel shows for 10 s. */
export const SCENE_CAROUSEL_MS = 10_000;

export interface SponsorCard {
  id: string;
  sponsorId: string;
  name: string;
  logoUrl: string | null;
  tier: SponsorTier;
  /** The sponsor's `on_stream` tick (V483), read off the row by the card source (S5) for BOTH lists. R4 S7: the scene
   *  carousel shows ticked cards only (spec §3.4), and `plan.cards` also carries unticked cards an airing still names,
   *  so the page cannot tell the two apart without it. Every card in `PlanInput.cards` must carry `true`
   *  (`SponsorPlanInputError` otherwise); an `assignedCards` entry carries whichever the row says. */
  onStream: boolean;
  /** Owner ruling R7: the code `sponsor_short_codes` minted for (sponsor, fixture), which the card prints as
   *  `seazn.club/s/<code>`. Absent ⇒ the card prints nothing link-like (a sponsor with no URL gets none). S5 mints it. */
  shortCode?: string;
}
export interface SponsorPlanAiring {
  momentId: string;
  seq: number;
  cardId: string;
  style: SponsorStyle;
  holdMs: number;
  breakKind: string;
}
/** Spec §3.2, exact. Null: rotation off for this fixture, or no card at all (none ticked, none assigned). `cards` is
 *  the ticked cards plus any unticked card an airing still references. */
export type SponsorPlan = { cards: SponsorCard[]; airings: SponsorPlanAiring[] } | null;

export interface BreakOpened extends BreakDecl {
  seq: number;
  at: string;
}

/** One `sponsor_assignments` row (V483). `sponsorId` is null once the sponsor is deleted; `sponsorName` is the
 *  snapshot taken at assign time, so the report and the airing keep the name. Rotation ⇔ a position (DB check). */
export interface SponsorAssignment {
  momentId: string;
  seq: number;
  sponsorId: string | null;
  sponsorName: string;
  position: number | null;
  source: "rotation" | "operator";
  breakKind: string;
  style: SponsorStyle;
  holdMs: number;
  operatorChoiceAt: string | null;
}

export type OperatorLogField = "scene" | "graphics_hidden" | "next_sponsor_id" | "skip_moment_id";
export interface OperatorLogEntry {
  at: string;
  field: OperatorLogField;
  value: string | boolean | null;
}

export interface PlanInput {
  /** The whole fixture, undone events excluded, ascending seq. */
  breaks: readonly BreakOpened[];
  /** The `recent` window. */
  windowSeqs: readonly number[];
  settings: { enabled: boolean; frequency: SponsorFrequency } | null;
  /** Ticked, in resolveSponsors order. One card per sponsor. The rotation and Play next draw on these only. */
  cards: readonly SponsorCard[];
  /** The current card of every sponsor this fixture's assignments name, ticked or not (a deleted sponsor has none).
   *  Airings resolve through `cards` ∪ `assignedCards`; a ticked card may appear in both lists. */
  assignedCards: readonly SponsorCard[];
  /** This fixture's persisted (frozen) assignments. */
  assigned: readonly SponsorAssignment[];
  operatorLog: readonly OperatorLogEntry[];
  /** The org's next free rotation position: max(position) + 1, gaps allowed (F9). */
  nextPosition: number;
  /** The poll's clock, epoch ms (R2's freshness cut). */
  now: number;
  /** False when the replay that produced `breaks` stopped part-way (`DerivedReplay.complete`): a break missing from it
   *  is then unproven, not undone (R3). */
  complete: boolean;
}

export interface SponsorPlanResult {
  plan: SponsorPlan;
  /** Assignments to persist (S5: under the org's rotation lock, `on conflict do nothing`). */
  newAssignments: SponsorAssignment[];
  /** Stored assignments whose break the replay no longer opens — candidates for deletion. Empty unless the replay was
   *  complete (R3). The planner cannot tell aired from unaired: S5 deletes only those with no `sponsor_airings` row. */
  undone: SponsorAssignment[];
}

/** Input that breaks the planner's contract. Thrown, never repaired: a wrong input is a bug upstream. */
export class SponsorPlanInputError extends Error {
  override name = "SponsorPlanInputError";
}

export function sponsorMomentId(seq: number, breakKind: string): string {
  return `${seq}:sponsor.${breakKind}`;
}

function timeOf(at: string, what: string): number {
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) throw new SponsorPlanInputError(`${what}: not a time: ${JSON.stringify(at)}`);
  return ms;
}

/** P7: smooth weighted round robin — one full cycle of card ids. Each step adds every card's tier weight to its score,
 *  picks the highest score (a tie goes to the earlier card) and subtracts the total from the pick. */
export function weightedCycle(cards: readonly SponsorCard[]): string[] {
  const weights = cards.map((c) => {
    const w = SPONSOR_TIER_WEIGHTS[c.tier];
    if (!Number.isInteger(w) || w <= 0) throw new SponsorPlanInputError(`card ${c.id}: tier ${String(c.tier)} has no weight`);
    return w;
  });
  const total = weights.reduce((s, w) => s + w, 0);
  const scores = weights.map(() => 0);
  const cycle: string[] = [];
  for (let step = 0; step < total; step++) {
    let pick = 0;
    for (let k = 0; k < scores.length; k++) {
      scores[k] = scores[k]! + weights[k]!;
      if (scores[k]! > scores[pick]!) pick = k;
    }
    scores[pick] = scores[pick]! - total;
    cycle.push(cards[pick]!.id);
  }
  return cycle;
}

/** The dial only (P2): no hidden, cooldown or freshness rule. Normal's "every 3rd minor" counts every minor in `breaks`. */
export function eligibleBreaks(breaks: readonly BreakOpened[], f: SponsorFrequency): BreakOpened[] {
  switch (f) {
    case "light":
      return breaks.filter((b) => b.size === "major");
    case "busy":
      return [...breaks];
    case "normal": {
      let minorsSeen = 0;
      return breaks.filter((b) => {
        if (b.size === "major") return true;
        minorsSeen++;
        return minorsSeen % NORMAL_MINOR_EVERY === 0;
      });
    }
    default:
      throw new SponsorPlanInputError(`unknown sponsor frequency ${JSON.stringify(f)}`);
  }
}

/** The latest `field` entry at or before (`strict`: strictly before) `atMs`; a tie goes to the later log row. */
function entryInForce(
  log: readonly OperatorLogEntry[],
  field: OperatorLogField,
  atMs: number,
  strict: boolean,
): OperatorLogEntry | null {
  let found: OperatorLogEntry | null = null;
  let foundMs = Number.NEGATIVE_INFINITY;
  for (const e of log) {
    if (e.field !== field) continue;
    const ms = timeOf(e.at, "operator log entry");
    const before = strict ? ms < atMs : ms <= atMs;
    if (before && ms >= foundMs) {
      found = e;
      foundMs = ms;
    }
  }
  return found;
}

/** Was Hide graphics on when a break opened at `at`? Off until the log says otherwise. */
export function graphicsHiddenAt(log: readonly OperatorLogEntry[], at: string): boolean {
  const e = entryInForce(log, "graphics_hidden", timeOf(at, "break"), false);
  if (e === null) return false;
  if (typeof e.value !== "boolean") throw new SponsorPlanInputError(`graphics_hidden at ${e.at}: not a boolean`);
  return e.value;
}

/** The Play next choice in force for a break at `at`: the latest one set strictly before it, unless cleared. Whether an
 *  earlier break already used it is the planner's question, not this reader's. */
export function playNextChoiceAt(
  log: readonly OperatorLogEntry[],
  at: string,
): { sponsorId: string; setAt: string } | null {
  const e = entryInForce(log, "next_sponsor_id", timeOf(at, "break"), true);
  if (e === null || e.value === null) return null;
  if (typeof e.value !== "string" || e.value === "") {
    throw new SponsorPlanInputError(`next_sponsor_id at ${e.at}: not a sponsor id`);
  }
  return { sponsorId: e.value, setAt: e.at };
}

function checkInput(i: PlanInput): void {
  if (!Number.isFinite(i.now)) throw new SponsorPlanInputError("now: not a clock");
  if (!Number.isInteger(i.nextPosition) || i.nextPosition < 0) {
    throw new SponsorPlanInputError(`nextPosition: ${i.nextPosition} is not a rotation position`);
  }
  const moments = new Set<string>();
  let lastSeq = Number.NEGATIVE_INFINITY;
  for (const b of i.breaks) {
    if (b.seq < lastSeq) throw new SponsorPlanInputError(`breaks: seq ${b.seq} after ${lastSeq}`);
    lastSeq = b.seq;
    const id = sponsorMomentId(b.seq, b.kind);
    if (moments.has(id)) throw new SponsorPlanInputError(`breaks: ${id} twice`);
    moments.add(id);
    if (b.size !== "minor" && b.size !== "major") throw new SponsorPlanInputError(`breaks: ${id} has size ${String(b.size)}`);
  }
  // An assignment names a sponsor, not a card: with two cards for one sponsor a re-plan could not tell which it showed.
  // Across the two lists the same card may appear in both (a ticked sponsor that is also assigned).
  const tickedCard = new Map<string, string>();
  for (const c of i.cards) {
    // R4 S7: `cards` is the ticked list, and the carousel reads `onStream` off `plan.cards` to find it again. An
    // unticked card here would air in the rotation AND on the carousel.
    if (c.onStream !== true) throw new SponsorPlanInputError(`cards: ${c.id} is not ticked (onStream ${String(c.onStream)})`);
    if (tickedCard.has(c.sponsorId)) throw new SponsorPlanInputError(`cards: sponsor ${c.sponsorId} has two cards`);
    tickedCard.set(c.sponsorId, c.id);
  }
  const assignedSponsors = new Set<string>();
  for (const c of i.assignedCards) {
    const ticked = tickedCard.get(c.sponsorId);
    if (assignedSponsors.has(c.sponsorId) || (ticked !== undefined && ticked !== c.id)) {
      throw new SponsorPlanInputError(`assignedCards: sponsor ${c.sponsorId} has two cards`);
    }
    assignedSponsors.add(c.sponsorId);
  }
}

export function planSponsors(i: PlanInput): SponsorPlanResult {
  checkInput(i);
  const live = new Set(i.breaks.map((b) => sponsorMomentId(b.seq, b.kind)));
  const undone = i.complete ? i.assigned.filter((a) => !live.has(a.momentId)) : [];
  if (i.settings === null || !i.settings.enabled || (i.cards.length === 0 && i.assignedCards.length === 0)) {
    return { plan: null, newAssignments: [], undone };
  }

  const frozen = new Map(i.assigned.map((a) => [a.momentId, a]));
  const eligible = new Set(eligibleBreaks(i.breaks, i.settings.frequency).map((b) => sponsorMomentId(b.seq, b.kind)));
  const inWindow = new Set(i.windowSeqs);
  const tickedOfSponsor = new Map(i.cards.map((c) => [c.sponsorId, c]));
  const cardById = new Map(i.cards.map((c) => [c.id, c]));
  const cycle = weightedCycle(i.cards);
  // What an airing can show: a ticked card first, else the assigned sponsor's current card.
  const shownOfSponsor = new Map([...i.assignedCards, ...i.cards].map((c) => [c.sponsorId, c]));

  // Every live stored operator row has used its choice, whatever its seq: a break that becomes assignable before it
  // (a dial change, a voided undo) must not air the same pick twice.
  const usedChoices = new Set<number>();
  const frozenCardMs: number[] = [];
  for (const b of i.breaks) {
    const stored = frozen.get(sponsorMomentId(b.seq, b.kind));
    if (stored === undefined) continue;
    frozenCardMs.push(timeOf(b.at, `break ${stored.momentId}`));
    if (stored.source === "operator" && stored.operatorChoiceAt !== null) {
      usedChoices.add(timeOf(stored.operatorChoiceAt, `assignment ${stored.momentId}`));
    }
  }

  const held = new Map<string, SponsorAssignment>(); // momentId → the assignment this plan airs it with
  const newAssignments: SponsorAssignment[] = [];
  let lastCardMs: number | null = null;
  let position = i.nextPosition;

  for (const b of i.breaks) {
    const momentId = sponsorMomentId(b.seq, b.kind);
    const atMs = timeOf(b.at, `break ${momentId}`);
    const stored = frozen.get(momentId);
    if (stored !== undefined) {
      held.set(momentId, stored);
      lastCardMs = atMs;
      continue;
    }
    if (!eligible.has(momentId)) continue;
    if (graphicsHiddenAt(i.operatorLog, b.at)) continue;
    if (b.size === "minor" && lastCardMs !== null && atMs - lastCardMs < SPONSOR_COOLDOWN_MS) continue;
    if (b.size === "minor" && frozenCardMs.some((t) => t >= atMs && t - atMs < SPONSOR_COOLDOWN_MS)) continue;
    if (!inWindow.has(b.seq) || i.now - atMs > SPONSOR_STALE_MS) continue;

    const look = SPONSOR_STYLE_BY_SIZE[b.size];
    const base = { momentId, seq: b.seq, breakKind: b.kind, style: look.style, holdMs: look.holdMs };
    const choice = playNextChoiceAt(i.operatorLog, b.at);
    const choiceMs = choice === null ? null : timeOf(choice.setAt, "next_sponsor_id");
    const chosen =
      choice !== null && choiceMs !== null && !usedChoices.has(choiceMs) ? tickedOfSponsor.get(choice.sponsorId) : undefined;
    let a: SponsorAssignment;
    if (chosen !== undefined && choice !== null && choiceMs !== null) {
      usedChoices.add(choiceMs);
      a = {
        ...base,
        sponsorId: chosen.sponsorId,
        sponsorName: chosen.name,
        position: null,
        source: "operator",
        operatorChoiceAt: choice.setAt,
      };
    } else {
      // A choice whose sponsor is no longer ticked falls through to the rotation and stays pending. With no ticked
      // card there is no rotation: the break gets nothing and gives the cooldown nothing to run from.
      if (cycle.length === 0) continue;
      const c = cardById.get(cycle[position % cycle.length]!)!;
      a = { ...base, sponsorId: c.sponsorId, sponsorName: c.name, position, source: "rotation", operatorChoiceAt: null };
      position++;
    }
    held.set(momentId, a);
    newAssignments.push(a);
    lastCardMs = atMs;
  }

  // The window's breaks that have an assignment whose sponsor still has a card (ticked or assigned). A deleted sponsor
  // (null) keeps its assignment — the break is never handed to anyone else — but has no card to show.
  const airings: SponsorPlanAiring[] = [];
  const cards = [...i.cards];
  const cardIds = new Set(cards.map((c) => c.id));
  for (const b of i.breaks) {
    if (!inWindow.has(b.seq)) continue;
    const momentId = sponsorMomentId(b.seq, b.kind);
    const a = held.get(momentId);
    const c = a?.sponsorId == null ? undefined : shownOfSponsor.get(a.sponsorId);
    if (a === undefined || c === undefined) continue;
    airings.push({ momentId, seq: b.seq, cardId: c.id, style: a.style, holdMs: a.holdMs, breakKind: b.kind });
    if (!cardIds.has(c.id)) {
      cardIds.add(c.id);
      cards.push(c);
    }
  }

  return { plan: { cards, airings }, newAssignments, undone };
}
