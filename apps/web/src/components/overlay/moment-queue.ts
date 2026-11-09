// The moment queue (stream overlay W2 Task 4) — a PURE reducer over a clock
// the caller supplies.
//
// PURE ON PURPOSE, and the purity is what makes it testable at all: `apps/web`
// vitest is `environment: "node"`, so no test in this repo can watch a slab
// animate. Every timing rule therefore lives here, where a test can drive it
// one deadline at a time, and the hook around it is thin enough that the e2e
// can carry the rest.
//
// THE CLOCK IS AN ARGUMENT, never `Date.now()` read inside. A reducer that read
// the clock itself could only be tested by moving real time.
//
// R4 S6 (sponsors on stream, spec 2026-10-27 §3.4): sponsor cards ride this SAME
// queue, behind score moments. Three rules, and nothing else changes for a
// queue that holds no sponsor moment:
//   1. Score first. The queue is kept partitioned — every score moment ahead of
//      every sponsor moment, each part in arrival order — so a score moment
//      arriving while a card waits jumps it, and one raised by the same event
//      as the break (a cricket over's end-of-over card, a goal's slab, a
//      set-won slab) airs first whatever order the stage hands them over in.
//   2. The pre-empt guard. A fresh score moment arriving while a card is on air
//      (folding in or holding) sends the card straight to `out` and records it
//      in `cutShort`. "Never covering a score change" is this guard.
//   3. The stale cut. A card that has waited longer than `SPONSOR_STALE_MS` by
//      the time it would air has missed its break: it is dropped, and stays
//      seen. The wait is timed on THIS page's clock from when the card was
//      queued — never against the event's server timestamp, which `?delay=`
//      (up to 5 min) and an OBS machine's own clock would both skew.
//
// R4 S7 fix round 1 (ruling m4): a fourth, `holdSponsors`. While the stage
// shows a match card (a scene's — Starting soon, Reconnecting, Final — or the
// slate's), no break card airs over it: a card on air folds off early
// (`cutShort`), and queued cards WAIT rather than leave — score moments still
// air past them. When the card goes, the next promotion airs a card that has
// waited no longer than `SPONSOR_STALE_MS`; one that waited longer is dropped by
// rule 3. The scene's own sponsor path is the carousel.
import { isSponsorMomentId, type MomentPriority, type OverlayMoment } from "@/lib/overlay-moments";
import { SPONSOR_STALE_MS } from "@/lib/sponsor-plan";

/** `in` — folding on. `hold` — fully shown. `out` — folding off. The three are
 *  a CONTRACT, not an implementation detail: they reach the DOM as
 *  `data-phase`, and the e2e reads them. */
export type Phase = "in" | "hold" | "out";

export interface MomentQueueState {
  current: OverlayMoment | null;
  phase: Phase;
  queue: OverlayMoment[];
  /** When the current phase ends, on the caller's clock. `null` when idle. */
  deadline: number | null;
  /**
   * Every moment identity this queue has ever accepted.
   *
   * NOT an optimisation — it is the whole reason the slab does not fire on
   * every poll. The transport re-sends the entire `recent` window each tick, so
   * without a memory of what has been shown a six would raise a slab every 15
   * seconds for as long as it stayed in the window.
   */
  seen: string[];
  /**
   * Bumped on every state CHANGE, and never otherwise.
   *
   * The hook arms one `setTimeout` from `nextDeadline`, so the deadline is its
   * effect dependency — and a deadline can REPEAT. Under reduced motion
   * `foldMs` is 0, so `out → promote` computes `now + 0`, which equals the
   * deadline that just fired whenever the tick lands exactly on it. React sees
   * an unchanged dependency, does not re-run the effect, arms no timer, and
   * `enqueue` never touches `deadline` while `current` is set — so the slab
   * freezes and NO FURTHER MOMENT airs for the rest of the broadcast.
   *
   * A monotonic counter cannot collide, so the effect re-runs whatever the
   * clock does.
   */
  revision: number;
  /**
   * R4 S6: when each QUEUED sponsor moment was accepted, on the caller's clock,
   * by moment id — the stale cut's only input. Holds exactly the sponsor
   * moments in `queue`: every action that takes a card out of the queue takes
   * its time with it (`waitsOf`).
   */
  queuedAt: Readonly<Record<string, number>>;
  /**
   * R4 S6: the ids of sponsor moments folded off EARLY — by the pre-empt guard,
   * a `skip`, or an undo of the card's break (`sync`). History, like `seen`: it is never cleared, because S7's end
   * line is written when the card has FINISHED folding out, after it has left
   * `current`.
   */
  cutShort: string[];
  /** R4 S7 fix round 1 (ruling m4): a match card is up, so no sponsor card airs (see the header, rule 4). */
  holdSponsors: boolean;
}

export type QueueAction =
  | { type: "enqueue"; moments: readonly OverlayMoment[]; now: number; foldMs: number; holdMs: number }
  | { type: "tick"; now: number; foldMs: number; holdMs: number }
  /** Drop / fold away anything no longer in the live window (scorer undo). */
  | { type: "sync"; live: readonly OverlayMoment[]; now: number; foldMs: number; holdMs: number }
  /** R2005 (spec §4.8, D14): a scene whose `momentsFire` is false (Final) marks every new moment SEEN and queues none
   *  of them, so none can air later either — not when the scene ends, not on the next poll. */
  | { type: "discard"; moments: readonly OverlayMoment[] }
  /** Owner ruling (4), 2026-10-19 (PR #982 review round 1, item 8): Final arrives — a moment already QUEUED must not
   *  play under it. The queue is dropped; every dropped id stays SEEN (a re-sent window cannot queue it again). A scorer's
   *  undo still forgets a dropped SCORE moment's id through `sync`; a dropped SPONSOR card's id is never forgotten (R4 S6
   *  fix round 1, see `sync`), so a flushed card never airs, undo or not. The slab already on air keeps its own run. */
  | { type: "flush" }
  /** R4 S6, for the operator console's "Skip this card" (C4 dispatches it — inert until then). Folds ONLY the named
   *  sponsor moment: on air → `out` and `cutShort`; queued → removed (it stays seen, so it never airs). A score moment
   *  is never skipped. */
  | { type: "skip"; momentId: string; now: number; foldMs: number }
  /** Rule 4: the stage's match card came up (`hold: true`) or went (`false`). */
  | { type: "holdSponsors"; hold: boolean; now: number; foldMs: number };


export const INITIAL: MomentQueueState = {
  current: null,
  phase: "in",
  queue: [],
  deadline: null,
  seen: [],
  revision: 0,
  queuedAt: {},
  cutShort: [],
  holdSponsors: false,
};

/**
 * A moment's identity.
 *
 * `seq` AND `kind`, because ONE event can raise TWO moments: a set-winning
 * point carries both the set won and the match point it opens, on the same
 * sequence number. Keyed on `seq` alone, one of them would be silently dropped.
 */
export const momentIdOf = (moment: OverlayMoment): string => `${moment.seq}:${moment.kind}`;

const idOf = momentIdOf;

/**
 * The timer's only input: when the current phase ends. `null` = nothing armed.
 *
 * Just the deadline. An earlier version also checked `current === null`, which
 * is unreachable — `promote` nulls the deadline in the same breath as it clears
 * `current`, so a guard for the pair disagreeing was a branch no test could
 * reach and no mutant could kill.
 */
export function nextDeadline(state: MomentQueueState): number | null {
  return state.deadline;
}

/** R4 S6: how the queue ranks a moment. Absent = score (see `OverlayMoment.priority`). */
const priorityOf = (moment: OverlayMoment): MomentPriority => moment.priority ?? "score";

const isSponsor = (moment: OverlayMoment): boolean => priorityOf(moment) === "sponsor";

/** Rule 1: every score moment ahead of every sponsor moment, each part in its own arrival order. */
function scoreFirst(queue: readonly OverlayMoment[]): OverlayMoment[] {
  return [...queue.filter((m) => !isSponsor(m)), ...queue.filter(isSponsor)];
}

/** The waits of the cards still in `queue` — so `queuedAt` never outlives its card. */
function waitsOf(queue: readonly OverlayMoment[], from: Readonly<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of queue) {
    const at = from[idOf(m)];
    if (at !== undefined) out[idOf(m)] = at;
  }
  return out;
}

/**
 * Rule 3, the stale cut: a card that waited MORE than `SPONSOR_STALE_MS` (exactly the limit still airs).
 *
 * A queued card with no recorded wait counts as stale. `enqueue` times every card it queues, so that state is
 * unreachable through the reducer's own actions — but a card of unknown age is exactly the "shown late" case this
 * rule exists to refuse, so the guard refuses it rather than assuming it away.
 */
function isStale(moment: OverlayMoment, queuedAt: Readonly<Record<string, number>>, now: number): boolean {
  if (!isSponsor(moment)) return false;
  const at = queuedAt[idOf(moment)];
  return at === undefined || now - at > SPONSOR_STALE_MS;
}

/** Rule 2, the pre-empt guard: a fresh score moment sends a card that is folding in or holding straight to `out`. A
 *  card already folding out has run its hold; it is left to finish. */
function scoreCutsCard(state: MomentQueueState, fresh: readonly OverlayMoment[]): boolean {
  if (state.current === null || !isSponsor(state.current) || state.phase === "out") return false;
  return fresh.some((m) => !isSponsor(m));
}

/** Fold the card on air off now, early, and say so. */
function foldEarly(state: MomentQueueState, current: OverlayMoment, now: number, foldMs: number): MomentQueueState {
  return {
    ...state,
    phase: "out",
    deadline: now + foldMs,
    cutShort: [...state.cutShort, idOf(current)],
    revision: state.revision + 1,
  };
}

function promote(state: MomentQueueState, now: number, foldMs: number): MomentQueueState {
  // A stale card at the head is dropped — it stays seen, so a re-sent window cannot queue it again. The queue is
  // partitioned, so once the head is a card every moment behind it is one too.
  let queue = state.queue;
  while (queue.length > 0 && isStale(queue[0]!, state.queuedAt, now)) queue = queue.slice(1);
  const [head, ...rest] = queue;
  const revision = state.revision + 1;
  // Rule 4: a card at the head while sponsors are held — and so every moment behind it a card too — waits, idle.
  if (head === undefined || (state.holdSponsors && isSponsor(head))) {
    return {
      ...INITIAL,
      queue,
      queuedAt: waitsOf(queue, state.queuedAt),
      seen: state.seen,
      cutShort: state.cutShort,
      holdSponsors: state.holdSponsors,
      revision,
    };
  }
  return {
    current: head,
    phase: "in",
    queue: rest,
    deadline: now + foldMs,
    seen: state.seen,
    revision,
    queuedAt: waitsOf(rest, state.queuedAt),
    cutShort: state.cutShort,
    holdSponsors: state.holdSponsors,
  };
}

export function momentQueueReducer(
  state: MomentQueueState,
  action: QueueAction,
): MomentQueueState {
  if (action.type === "sync") {
    // Undo / void: the transport's live window no longer carries this id.
    // Drop it from the queue, fold the current slab off if it was struck, and
    // forget EVERY id absent from live in `seen` — including moments that
    // already rode out while idle. Otherwise an end-of-over that finished its
    // natural hold stays in `seen` after undo, and undo+recomplete cannot
    // re-air (same over number, new completion). Pair beats (`.bis`) leave
    // together because both ids drop from live at once.
    //
    // R4 S6 fix round 1: a SPONSOR id is never forgotten. The reason above does
    // not apply to it — its id keys on the break's own ledger seq, so a new
    // break is a new id — and its airing leaves `live` for reasons that are not
    // an undo: the plan lists only the recent window (8 events), and a poll can
    // carry a null plan. Forgetting it put a card that had already aired back on
    // air minutes after its break, and proof of play would count it twice.
    const live = new Set(action.live.map(idOf));
    const queue = state.queue.filter((m) => live.has(idOf(m)));
    const currentGone = state.current !== null && !live.has(idOf(state.current));
    const seen = state.seen.filter((id) => live.has(id) || isSponsorMomentId(id));
    const queueShrunk = queue.length !== state.queue.length;
    const seenShrunk = seen.length !== state.seen.length;
    if (!currentGone && !queueShrunk && !seenShrunk) return state;

    const revision = state.revision + 1;
    const queuedAt = waitsOf(queue, state.queuedAt);

    if (currentGone && state.current !== null) {
      // Already folding out — keep the out phase; just drop queue + seen.
      if (state.phase === "out") {
        return { ...state, queue, queuedAt, seen, revision };
      }
      return {
        ...state,
        queue,
        queuedAt,
        seen,
        phase: "out",
        deadline: action.now + action.foldMs,
        // Controller ruling 2026-10-31: a sponsor card struck off air by an undo of its break ran short too — the
        // sponsor report must not claim a full showing.
        cutShort: isSponsor(state.current) ? [...state.cutShort, idOf(state.current)] : state.cutShort,
        revision,
      };
    }

    return { ...state, queue, queuedAt, seen, revision };
  }

  if (action.type === "holdSponsors") {
    if (action.hold === state.holdSponsors) return state;
    const next: MomentQueueState = { ...state, holdSponsors: action.hold, revision: state.revision + 1 };
    if (action.hold) {
      // A card on air folds off now, early; one already folding out is already leaving.
      const current = next.current;
      if (current !== null && isSponsor(current) && next.phase !== "out") {
        return foldEarly(next, current, action.now, action.foldMs);
      }
      return next;
    }
    // Released while idle: the waiting card (if it is still fresh) airs now — nothing else would promote it.
    return next.current === null ? promote(next, action.now, action.foldMs) : next;
  }

  if (action.type === "flush") {
    // Nothing queued: the same state, so a re-render under Final arms no timer and re-renders nothing.
    if (state.queue.length === 0) return state;
    return { ...state, queue: [], queuedAt: {}, revision: state.revision + 1 };
  }

  if (action.type === "skip") {
    const current = state.current;
    if (current !== null && idOf(current) === action.momentId) {
      // A score moment is never skipped; a card already folding out is already leaving.
      if (!isSponsor(current) || state.phase === "out") return state;
      return foldEarly(state, current, action.now, action.foldMs);
    }
    const queue = state.queue.filter((m) => !(isSponsor(m) && idOf(m) === action.momentId));
    // Not on air, not queued (never arrived, already gone, or a score moment): nothing to fold.
    if (queue.length === state.queue.length) return state;
    return { ...state, queue, queuedAt: waitsOf(queue, state.queuedAt), revision: state.revision + 1 };
  }

  if (action.type === "discard") {
    // Seen, never queued. The batch is deduped the way `enqueue` dedupes it, and an id already seen changes nothing —
    // so a poll that re-sends the window is not a state change (no re-render, no timer).
    const seen = new Set(state.seen);
    const fresh: string[] = [];
    for (const moment of action.moments) {
      const id = idOf(moment);
      if (seen.has(id)) continue;
      seen.add(id);
      fresh.push(id);
    }
    if (fresh.length === 0) return state;
    return { ...state, seen: [...state.seen, ...fresh], revision: state.revision + 1 };
  }

  if (action.type === "enqueue") {
    // Deduped against history AND against the batch itself. Checking only
    // `seen` left a gap: two identical moments arriving in ONE array would both
    // queue, because `seen` does not grow until the batch is accepted.
    const accepted = new Set(state.seen);
    const fresh: OverlayMoment[] = [];
    for (const moment of action.moments) {
      const id = idOf(moment);
      if (accepted.has(id)) continue;
      accepted.add(id);
      fresh.push(moment);
    }
    if (fresh.length === 0) return state;
    const queuedAt = { ...state.queuedAt };
    for (const moment of fresh) if (isSponsor(moment)) queuedAt[idOf(moment)] = action.now;
    const next: MomentQueueState = {
      ...state,
      queue: scoreFirst([...state.queue, ...fresh]),
      queuedAt,
      seen: [...state.seen, ...fresh.map(idOf)],
      revision: state.revision + 1,
    };
    // A moment arriving while one is on air QUEUES. Interrupting the slab on
    // screen would cut a wicket off mid-sentence. The one exception is a
    // sponsor card, which yields to the score (rule 2).
    if (next.current === null) return promote(next, action.now, action.foldMs);
    if (scoreCutsCard(next, fresh)) return foldEarly(next, next.current, action.now, action.foldMs);
    return next;
  }

  if (action.type !== "tick") return state;

  // A tick before the deadline changes no PHASE — but it must still change the
  // state, or the slab freezes for the rest of the broadcast.
  //
  // The hook arms one timer per state and re-arms only when the state changes
  // (`use-moment-queue.ts`). Returning `state` itself means `useReducer` bails
  // out, nothing re-renders, no timer is armed — and the timer that dispatched
  // this tick is already spent. `revision` is the fix R-2 introduced for the
  // EQUAL-deadline case; a tick that lands BELOW the deadline needs it too.
  //
  // Reachable when the wall clock steps backwards between arming and firing —
  // an NTP correction on a machine that has been running OBS for hours. The
  // re-arm cannot loop: the effect schedules `max(0, deadline - now)`, which is
  // positive exactly while this branch is taken.
  if (state.current === null || state.deadline === null) return state;
  if (action.now < state.deadline) return { ...state, revision: state.revision + 1 };
  // EXACTLY ONE phase per tick, however late the tick is. A backgrounded OBS
  // source gets no timers at all; on return the clock has jumped minutes, and
  // collapsing three phases into one frame would flash the slab rather than
  // fold it.
  if (state.phase === "in") {
    const holdMs = state.current.holdMs ?? action.holdMs;
    return {
      ...state,
      phase: "hold",
      deadline: action.now + holdMs,
      revision: state.revision + 1,
    };
  }
  if (state.phase === "hold") {
    return {
      ...state,
      phase: "out",
      deadline: action.now + action.foldMs,
      revision: state.revision + 1,
    };
  }
  return promote(state, action.now, action.foldMs);
}
