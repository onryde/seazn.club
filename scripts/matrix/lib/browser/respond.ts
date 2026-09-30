// The product's own answer to what the UI did (Review Focus 4). A browser
// action never reads its result from the DOM: it clicks, waits for the
// response to the request the UI made, and reads that through the same
// envelope HttpDriver does — so the scenario sees exactly what HttpDriver
// would have seen, refusals (and their `extra`) included.
import type { Page, Response } from "playwright";
import { unwrapEnvelope } from "../driver/envelope.ts";
import { assertWaitMs } from "./budget.ts";

/** Why no answer came (M-5). Only `no-response` is "the click reached
 *  nothing": the act finished and the UI sent no matching request.
 *  `act-pending` is a budget spent while the act was still running — a control
 *  that never became actionable. `wait-failed` is the wait ending some other
 *  way — the page, context or browser went away. */
export type NoResponseReason = "no-response" | "act-pending" | "wait-failed";

export class NoProductResponse extends Error {
  readonly method: string;
  readonly path: string;
  readonly ms: number;
  readonly reason: NoResponseReason;
  constructor(method: string, path: RegExp, ms: number, reason: NoResponseReason, cause?: unknown) {
    const why = cause instanceof Error ? ` (${cause.message.split("\n")[0]})` : "";
    const want = `${method} ${path.source}`;
    const headline = reason === "no-response"
      ? `the action finished, but the UI sent no ${want} within ${ms} ms — the click reached nothing`
      : reason === "act-pending"
        ? `the ${ms} ms budget for ${want} ran out while the action was still running — the control never became actionable in time`
        : `the wait for ${want} failed before its ${ms} ms budget — the page, context or browser went away`;
    super(`browser: ${headline}${why}`);
    this.name = "NoProductResponse";
    this.method = method;
    this.path = path.source;
    this.ms = ms;
    this.reason = reason;
  }
}

/** Playwright's own budget expiry is an error NAMED "TimeoutError" (measured:
 *  class TimeoutError); a closed page, context or browser is a plain "Error". */
const isTimeout = (e: unknown): boolean => e instanceof Error && e.name === "TimeoutError";

/** Clicks through `act` and resolves on the product's OWN answer to the request
 *  the UI made: the FIRST response to `want.method` whose pathname matches
 *  `want.path`, among those that arrive once the wait is registered — which is
 *  before `act` runs, so a response the click provokes at once is never missed.
 *  A non-2xx (or a 2xx without data) throws the RefusedCall unwrapEnvelope
 *  builds; no answer within `budget` throws NoProductResponse, its `reason`
 *  saying which of the three stories it is. If `act` itself throws — before
 *  the budget or after it — ITS error is the answer: it names the control that
 *  failed, the more specific cause. Never returns undefined. */
export async function actAndAwait<T>(page: Pick<Page, "waitForResponse">, want: { method: string; path: RegExp }, act: () => Promise<void>, budget: number): Promise<{ data: T; path: string }> {
  assertWaitMs("budget", budget);
  // A copy without g/y: a stateful RegExp's lastIndex would make a second
  // call (or a second response) skip a match.
  const re = new RegExp(want.path.source, want.path.flags.replace(/[gy]/g, ""));
  const matches = (r: Response) => r.request().method() === want.method && re.test(new URL(r.url()).pathname);
  let actSettled = false;
  const waiting = page.waitForResponse(matches, { timeout: budget }).catch((e: unknown) => {
    const reason: NoResponseReason = !isTimeout(e) ? "wait-failed" : actSettled ? "no-response" : "act-pending";
    throw new NoProductResponse(want.method, want.path, budget, reason, e);
  });
  // C-1: a handler from the moment the wait exists. A budget that expires
  // while act() is still pending rejects `waiting` before anything awaits it;
  // without this that is an unhandled rejection, which crash-exit.ts turns
  // into exit 3 for the WHOLE run instead of one red case. It swallows
  // nothing: `await waiting` below still observes the rejection, and an act
  // that throws abandons the wait with its rejection already handled.
  waiting.catch(() => undefined);
  try {
    await act();
  } finally {
    actSettled = true;
  }
  const r = await waiting;
  const path = new URL(r.url()).pathname;
  const body: unknown = await r.json().catch(() => null);
  return { data: unwrapEnvelope<T>(want.method, path, r.status(), body), path };
}
