// The arbiter's browser side of one meeting: ONE join chain per meeting, the token kept in memory once it has worked, and
// a close that is the SDK leave only. There is no DELETE from the browser (the route is for explicit revocation, and the
// sweep removes what the browser leaves): the server keeps one participant per (organizer, meeting) for the game's life, so
// a return to a meeting reuses the token it already has and POSTs nothing.
//
// Chains are per meeting (`${fixtureId}:${side}`), so a slow join on one board never holds another. Within one meeting
// every open and close runs in the order asked for (a close then an open of the same meeting: the leave lands first).
//
// Every step is bounded - the join POST, the SDK join and the leave - because `apiV1` has no timeout of its own: one step
// that never answers would otherwise hold that meeting's chain for the life of the page. A step given up on is left
// running; what it later produces (cameras) is left at once.
//
// A token is KEPT only once a connect with it has SUCCEEDED (never a doomed reconnect with a token that never worked). Any
// failure of a connect made with a KEPT token (the TTL sweep's kick, the room ending, an expired token, a timeout) evicts
// it and re-POSTs ONCE within that open; a second failure is the pane's error and the next open starts the rule again, so a
// stuck SDK costs one POST per retry press and never one per poll. A POST's own refusal is never cached.
import type { ArbiterCameras, JoinArbiter } from "./arbiter-camera";

export type ArbiterSide = "home" | "away";

/** The join route's answer (POST .../external-play/arbiter, `ArbiterJoinOut`). */
export type ArbiterJoinAnswer = { authToken: string; participantId: string; side: ArbiterSide; players: string[]; reused: boolean };

export type ArbiterSerialDeps = {
  /** POST .../external-play/arbiter with the side; the route's refusals reject (an `ApiV1Error`). */
  join(fixtureId: string, side: ArbiterSide): Promise<ArbiterJoinAnswer>;
  /** The SDK join (`joinArbiter`): receive-only, the guard on. */
  connect: JoinArbiter;
  /** A step that outlasts this is given up on, so one stuck step cannot wedge a meeting's chain. */
  stepTimeoutMs?: number;
  /** The clock that bounds a step; a test settles it by hand. */
  after?: (ms: number) => Promise<void>;
};

export type ArbiterOpenHandlers = {
  /** The pane's cameras, once the SDK join has landed. Not called if the pane was closed first. */
  onCameras(cameras: ArbiterCameras): void;
  /** The POST's refusal, or the guard's fault. Not called if the pane was closed first. */
  onError(err: unknown): void;
};

export type ArbiterOpen = {
  /** The pane is done (a switch, a retry, the panel going away): queue the SDK leave. Idempotent. */
  close(): void;
};

const DEFAULT_STEP_TIMEOUT_MS = 10_000;
const wait = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

export function makeArbiterSerial(deps: ArbiterSerialDeps) {
  const timeoutMs = deps.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const after = deps.after ?? wait;
  const TIMED_OUT: unique symbol = Symbol("timed out");
  type TimedOut = typeof TIMED_OUT;
  const within = <T>(step: Promise<T>): Promise<T | TimedOut> =>
    Promise.race<T | TimedOut>([step, after(timeoutMs).then((): TimedOut => TIMED_OUT)]);

  /** One chain per meeting. A job never rejects. */
  const tails = new Map<string, Promise<void>>();
  const enqueue = (key: string, job: () => Promise<void>): void => {
    tails.set(key, (tails.get(key) ?? Promise.resolve()).then(job).catch(() => undefined));
  };
  /** The answers whose connect has succeeded, by meeting key. */
  const kept = new Map<string, ArbiterJoinAnswer>();

  /** A connect bounded by the step timeout; a late landing is left at once. Throws on failure or timeout. */
  async function connectWith(answer: ArbiterJoinAnswer): Promise<ArbiterCameras> {
    const connecting = deps.connect({ authToken: answer.authToken, players: answer.players });
    const joined = await within(connecting);
    if (joined === TIMED_OUT) {
      connecting.then((late) => void late.leave().catch(() => undefined), () => undefined);
      throw new Error("The video connection timed out.");
    }
    return joined;
  }

  async function post(fixtureId: string, side: ArbiterSide): Promise<ArbiterJoinAnswer> {
    const answer = await within(deps.join(fixtureId, side));
    if (answer === TIMED_OUT) throw new Error("The video connection timed out.");
    return answer;
  }

  return {
    open(fixtureId: string, side: ArbiterSide, h: ArbiterOpenHandlers): ArbiterOpen {
      const key = `${fixtureId}:${side}`;
      let closed = false;
      let cameras: ArbiterCameras | null = null;

      enqueue(key, async () => {
        if (closed) return; // closed before its turn: no POST at all
        try {
          const had = kept.get(key);
          let joined: ArbiterCameras | null = null;
          if (had !== undefined) {
            try {
              joined = await connectWith(had);
            } catch {
              kept.delete(key); // evict, then ONE re-POST within this open
            }
          }
          if (joined === null) {
            if (closed) return;
            const fresh = await post(fixtureId, side);
            if (closed) return;
            joined = await connectWith(fresh);
            kept.set(key, fresh);
          }
          cameras = joined;
          if (closed) return; // the close job queued behind this one leaves
          h.onCameras(joined);
        } catch (err) {
          if (!closed) h.onError(err);
        }
      });

      return {
        close() {
          if (closed) return;
          closed = true;
          enqueue(key, async () => {
            const c = cameras;
            cameras = null;
            if (c !== null) await within(c.leave().catch(() => undefined));
          });
        },
      };
    },
    /** Test seam: the answers kept in memory, by meeting key. */
    tokens(): ReadonlyMap<string, ArbiterJoinAnswer> {
      return kept;
    },
  };
}
