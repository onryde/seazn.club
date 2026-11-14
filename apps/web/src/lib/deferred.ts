import "server-only";
import { after } from "next/server";
import { log } from "@/server/logger";

/** Inline-fallback tails still running, tracked under vitest only (`flushDeferred`). `run` never rejects, so neither does a tail. */
const pending = new Set<Promise<void>>();

/**
 * Register non-critical tail work. Registration itself never delays the
 * caller: in a Next request scope, `after()` receives the real work promise
 * and awaits it in its after-window (so it genuinely finishes before the
 * window closes, even on error/redirect/notFound); outside a request scope
 * (vitest, scripts) it falls back to inline fire-and-forget. Either way the
 * work's own errors are swallowed, not thrown — same contract as
 * fire*Revalidate's try/catch.
 */
export function deferred(fn: () => Promise<unknown> | unknown): void {
  const run = async () => {
    try {
      await fn();
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "deferred: a tail task failed");
    }
  };
  try {
    after(run);
  } catch {
    const tail = run(); // outside a request scope
    if (process.env.VITEST) pending.add(tail);
  }
}

/**
 * Tests only (refuses outside vitest): waits for every inline-fallback tail started so far AND every tail those start, until none is
 * left, and answers how many settled. For a test that reads what a tail wrote straight after the call that queued it (registration
 * redesign B1 T5: the register route queues the cart mail through `deferred`, and the mail's own first attempt is a nested one). A
 * tail handed to a request scope's `after()` belongs to that request and is not tracked.
 */
export async function flushDeferred(): Promise<number> {
  if (!process.env.VITEST) throw new Error("flushDeferred is for tests only");
  let settled = 0;
  while (pending.size > 0) {
    const batch = [...pending];
    await Promise.all(batch);
    for (const tail of batch) pending.delete(tail);
    settled += batch.length;
  }
  return settled;
}
