// The product's own answer to what the UI did (Review Focus 4). A browser
// action never reads its result from the DOM: it clicks, waits for the
// response to the request the UI made, and reads that through the same
// envelope HttpDriver does — so the scenario sees exactly what HttpDriver
// would have seen, refusals (and their `extra`) included.
import type { Page, Response } from "playwright";
import { unwrapEnvelope } from "../driver/envelope.ts";
import { assertWaitMs } from "./budget.ts";

export class NoProductResponse extends Error {
  readonly method: string;
  readonly path: string;
  readonly ms: number;
  constructor(method: string, path: RegExp, ms: number, cause?: unknown) {
    const why = cause instanceof Error ? ` (${cause.message.split("\n")[0]})` : "";
    super(`browser: the UI sent no ${method} ${path.source} within ${ms} ms — the click reached nothing${why}`);
    this.name = "NoProductResponse";
    this.method = method;
    this.path = path.source;
    this.ms = ms;
  }
}

/** Clicks through `act` and resolves on the product's OWN answer to the request
 *  the UI made: the FIRST response to `want.method` whose pathname matches
 *  `want.path`, among those that arrive once the wait is registered — which is
 *  before `act` runs, so a response the click provokes at once is never missed.
 *  A non-2xx (or a 2xx without data) throws the RefusedCall unwrapEnvelope
 *  builds; no answer within `budget` throws NoProductResponse. Never returns
 *  undefined. */
export async function actAndAwait<T>(page: Pick<Page, "waitForResponse">, want: { method: string; path: RegExp }, act: () => Promise<void>, budget: number): Promise<{ data: T; path: string }> {
  assertWaitMs("budget", budget);
  // A copy without g/y: a stateful RegExp's lastIndex would make a second
  // call (or a second response) skip a match.
  const re = new RegExp(want.path.source, want.path.flags.replace(/[gy]/g, ""));
  const matches = (r: Response) => r.request().method() === want.method && re.test(new URL(r.url()).pathname);
  const waiting = page.waitForResponse(matches, { timeout: budget }).catch((e: unknown) => { throw new NoProductResponse(want.method, want.path, budget, e); });
  try {
    await act();
  } catch (e) {
    // The act's own failure is the answer; the abandoned wait still rejects
    // at its timeout, and must not surface as an unhandled rejection.
    waiting.catch(() => undefined);
    throw e;
  }
  const r = await waiting;
  const path = new URL(r.url()).pathname;
  const body: unknown = await r.json().catch(() => null);
  return { data: unwrapEnvelope<T>(want.method, path, r.status(), body), path };
}
