// D16 (chess design §5.6.4, shape (b)) - the arbiter holds ONE player's meeting at a time, and moving from one to the
// other is a SERIAL chain: the SDK leave is awaited, then the server DELETE of the participant that open minted is
// awaited, and only then is the next join POSTed. React does not await an effect's cleanup, so that order cannot live in
// the panel's effect; it lives here, in a promise chain every open and close is queued on.
//
// Every step is bounded - the join POST, the SDK join, the leave and the DELETE - because the chain is module-level
// (the panel's `browserSerial`) and `apiV1` has no timeout of its own: one step that never answers would otherwise hold
// every later open for the life of the page. A step that is given up on is left running; what it later produces (a mint,
// cameras) is handed back or left at once.
//
// What this proves, and what it does not: on the happy path an arbiter holds at most ONE live participant. A DELETE that
// fails does NOT hold the next join hostage - the view is not kept waiting on a vendor error - so on that path the
// leftover (receive-only) participant stays until the sweep removes it. The claim is not made for the failure path.
import type { ArbiterCameras, JoinArbiter } from "./arbiter-camera";

export type ArbiterSide = "home" | "away";

/** The join route's answer (POST .../external-play/arbiter, `ArbiterJoinOut`). */
export type ArbiterJoinAnswer = { authToken: string; participantId: string; side: ArbiterSide; players: string[] };

type Send = (url: string, init: RequestInit) => Promise<unknown>;

/** I2: the participant one open of a board minted on the server. The panel hands it back when the pane closes - a
 *  switch, the panel going away - and when the tab goes away (`release`, on pagehide: `keepalive`, so the request
 *  outlives the page), ONCE. A mint that lands after the pane closed (the POST raced the switch) is handed back at
 *  once. A send that fails is dropped: the sweep removes whatever the browser could not. `release` and `close` return
 *  the DELETE's settlement so a switch can await the answer before it joins the next meeting. */
export function arbiterWatchRelease(fixtureId: string, send: Send) {
  let participantId: string | null = null;
  let closed = false;
  const release = (): Promise<void> => {
    if (participantId === null) return Promise.resolve();
    const url = `/api/v1/fixtures/${encodeURIComponent(fixtureId)}/external-play/arbiter/${encodeURIComponent(participantId)}`;
    participantId = null;
    return send(url, { method: "DELETE", keepalive: true }).then(
      () => undefined,
      () => undefined,
    );
  };
  return {
    minted(id: string): Promise<void> {
      participantId = id;
      return closed ? release() : Promise.resolve();
    },
    close(): Promise<void> {
      closed = true;
      return release();
    },
    release,
  };
}

export type ArbiterSerialDeps = {
  /** POST .../external-play/arbiter with the side; the route's refusals reject (an `ApiV1Error`). */
  join(fixtureId: string, side: ArbiterSide): Promise<ArbiterJoinAnswer>;
  /** The SDK join (`joinArbiter`): receive-only, the guard on. */
  connect: JoinArbiter;
  /** The DELETE of a participant (`apiV1`). */
  send: Send;
  /** A step that outlasts this is given up on, so one stuck step cannot wedge every later switch. */
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
  /** The tab is going away: hand the participant back NOW, without waiting for the chain. Idempotent. */
  release(): void;
  /** The pane is done (a switch, a retry, the panel going away): queue the leave, then the DELETE. Idempotent. */
  close(): void;
};

const DEFAULT_STEP_TIMEOUT_MS = 10_000;
const wait = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

export function makeArbiterSerial(deps: ArbiterSerialDeps) {
  const timeoutMs = deps.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const after = deps.after ?? wait;
  const TIMED_OUT: unique symbol = Symbol("timed out");
  type TimedOut = typeof TIMED_OUT;
  /** The step's answer, or TIMED_OUT when it outlasts the bound. The step itself is left running; whatever it later
   *  produces is the caller's to clean up. */
  const within = <T>(step: Promise<T>): Promise<T | TimedOut> =>
    Promise.race<T | TimedOut>([step, after(timeoutMs).then((): TimedOut => TIMED_OUT)]);

  /** Every open and every close, in the order they were asked for. A job never rejects. */
  let tail: Promise<void> = Promise.resolve();
  const enqueue = (job: () => Promise<void>): void => {
    tail = tail.then(job).catch(() => undefined);
  };

  return {
    open(fixtureId: string, side: ArbiterSide, h: ArbiterOpenHandlers): ArbiterOpen {
      let closed = false;
      let cameras: ArbiterCameras | null = null;
      const watch = arbiterWatchRelease(fixtureId, deps.send);

      enqueue(async () => {
        // Closed before its turn (an earlier open was still starting): no POST at all.
        if (closed) return;
        try {
          // The POST is bounded like every other step (review I1): the chain is the page's, so one POST that never answers
          // would hold every later open, switch and board change for as long as the page lives.
          const posting = deps.join(fixtureId, side);
          const answer = await within(posting);
          if (answer === TIMED_OUT) {
            // Whatever the POST mints later is handed back at once, never used.
            posting.then(
              (late) => {
                void watch.minted(late.participantId);
                return watch.release();
              },
              () => undefined,
            );
            throw new Error("The video connection timed out.");
          }
          // The mint is recorded the moment it lands; a pane closed meanwhile has its DELETE queued behind this job.
          void watch.minted(answer.participantId);
          if (closed) return;
          const connecting = deps.connect({ authToken: answer.authToken, players: answer.players });
          const joined = await within(connecting);
          if (joined === TIMED_OUT) {
            // The SDK never answered. Whatever it produces later is left at once, never shown.
            connecting.then((late) => void late.leave().catch(() => undefined), () => undefined);
            throw new Error("The video connection timed out.");
          }
          cameras = joined;
          if (closed) return; // the close job queued behind this one leaves
          h.onCameras(joined);
        } catch (err) {
          if (!closed) h.onError(err);
        }
      });

      return {
        release() {
          void watch.release();
        },
        close() {
          if (closed) return;
          closed = true;
          enqueue(async () => {
            const c = cameras;
            cameras = null;
            // Leave first, then the DELETE of the participant this open minted; each is awaited, each is bounded, and a
            // failure of either does not stop the chain.
            if (c !== null) await within(c.leave().catch(() => undefined));
            await within(watch.close());
          });
        },
      };
    },
  };
}
