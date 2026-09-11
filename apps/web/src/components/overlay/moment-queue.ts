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
import type { OverlayMoment } from "@/lib/overlay-moments";

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
}

export type QueueAction =
  | { type: "enqueue"; moments: readonly OverlayMoment[]; now: number; foldMs: number; holdMs: number }
  | { type: "tick"; now: number; foldMs: number; holdMs: number };

export const INITIAL: MomentQueueState = {
  current: null,
  phase: "in",
  queue: [],
  deadline: null,
  seen: [],
  revision: 0,
};

/**
 * A moment's identity.
 *
 * `seq` AND `kind`, because ONE event can raise TWO moments: a set-winning
 * point carries both the set won and the match point it opens, on the same
 * sequence number. Keyed on `seq` alone, one of them would be silently dropped.
 */
const idOf = (moment: OverlayMoment): string => `${moment.seq}:${moment.kind}`;

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

function promote(state: MomentQueueState, now: number, foldMs: number): MomentQueueState {
  const [head, ...rest] = state.queue;
  const revision = state.revision + 1;
  if (head === undefined) return { ...INITIAL, seen: state.seen, revision };
  return {
    current: head,
    phase: "in",
    queue: rest,
    deadline: now + foldMs,
    seen: state.seen,
    revision,
  };
}

export function momentQueueReducer(
  state: MomentQueueState,
  action: QueueAction,
): MomentQueueState {
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
    const next: MomentQueueState = {
      ...state,
      queue: [...state.queue, ...fresh],
      seen: [...state.seen, ...fresh.map(idOf)],
      revision: state.revision + 1,
    };
    // A moment arriving while one is on air QUEUES. Interrupting the slab on
    // screen would cut a wicket off mid-sentence.
    return next.current === null ? promote(next, action.now, action.foldMs) : next;
  }

  // A tick before the deadline is a no-op. The timer is armed to the deadline,
  // but a React re-render can fire one early and must change nothing.
  if (state.current === null || state.deadline === null || action.now < state.deadline) {
    return state;
  }
  // EXACTLY ONE phase per tick, however late the tick is. A backgrounded OBS
  // source gets no timers at all; on return the clock has jumped minutes, and
  // collapsing three phases into one frame would flash the slab rather than
  // fold it.
  if (state.phase === "in") {
    return {
      ...state,
      phase: "hold",
      deadline: action.now + action.holdMs,
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
