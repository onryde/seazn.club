// Quick match C12 (plan 1 Task 9 fix round 1; controller ruling 2026-11-08; spec §4 step 4): a control that LEAVES the
// pad, the quick match's back link, must not strand the point the guest just tapped. A v3 tap with dock chips
// soft-commits: queue.ts holds it HOLD_MS before it may send, and a navigation inside that window unloads the page with
// the tap still held. It survives in IndexedDB but reaches the server only when this pad is opened again, so the home
// the guest lands on shows the score without it.
//
// So every mounted pad registers one flush here (use-pad-pipeline.ts), and the leaving control asks for them all,
// capped: release whatever is held, drain, and resolve when the queue is empty; or give up at the cap and leave anyway,
// since a held tap is durable and a guest must never be stuck on a dead network. Nothing here runs unless such a control
// asks: no pagehide hook, no timer, no change to what an ordinary pad renders.
import { flushHeldBefore } from "./queue";
import type { QueueStore } from "./queue-store";

/** How long a leaving control waits for the pads before it goes anyway (controller ruling: about 3s). */
export const PAD_FLUSH_CAP_MS = 3_000;
/** The pause between drain passes while the queue will not empty (offline, a retryable refusal). */
const RETRY_GAP_MS = 100;

/** One pad's flush: resolves when its queue is empty, or at `deadline` (epoch ms) at the latest. */
export type PadFlush = (deadline: number) => Promise<void>;
export type PadFlushOutcome = "drained" | "timed-out";

const mounted = new Set<PadFlush>();

/** Register one mounted pad's flush. Returns its unregister, for the mount effect's cleanup. */
export function registerPadFlush(flush: PadFlush): () => void {
  mounted.add(flush);
  return () => {
    mounted.delete(flush);
  };
}

/** Ask every mounted pad to send what it holds. "drained" once all of them report an empty queue (at once when no pad
 *  is mounted, the waiting screen); "timed-out" at `capMs`, whichever comes first. Never rejects: a pad whose flush
 *  throws counts as done, because its taps are still in its durable queue. */
export async function flushMountedPads(capMs: number = PAD_FLUSH_CAP_MS): Promise<PadFlushOutcome> {
  const deadline = Date.now() + capMs;
  const all = Promise.all([...mounted].map((flush) => flush(deadline).catch(() => undefined))).then(
    () => "drained" as const,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<"timed-out">((resolve) => {
    timer = setTimeout(() => resolve("timed-out"), capMs);
  });
  try {
    return await Promise.race([all, cap]);
  } finally {
    clearTimeout(timer);
  }
}

/** One pad's flush, over its own queue and its own drain: release EVERY held tap now (`flushHeldBefore`, the same
 *  release a new tap performs, so each held entry's own `onDue` fires exactly once and its natural tick is cancelled),
 *  then drain until the queue is empty, a seq race is lost, or `deadline` passes. The drain is the pad's own
 *  (`runDrain`), so the send order, the expected-seq rules and the ack handling are the pipeline's, not a second path. */
export async function drainForNavigation(store: QueueStore, drain: () => Promise<void>, deadline: number): Promise<void> {
  await flushHeldBefore(store, Date.now());
  const passesAtStart = new Map((await store.list()).map((e) => [e.idempotencyKey, e.conflictPasses ?? 0]));
  for (;;) {
    await drain();
    const left = await store.list();
    if (left.length === 0) return;
    // A seq race lost during this flush (ruling 2026-11-08): every further pass would spend another of the queue's
    // conflict passes (pipeline.ts CONFLICT_PASS_CEILING), and the pass past it dead-letters the guest's point. Stop
    // and leave: the point waits in IndexedDB for the pad's next mount, where the ordinary drain resolves the race. Read
    // from the durable counter itself, never from an error message. An indeterminate 409 (slot unreadable) spends no
    // pass, so it re-drains until the deadline like a network failure: nothing is lost either way.
    if (left.some((e) => (e.conflictPasses ?? 0) > (passesAtStart.get(e.idempotencyKey) ?? 0))) return;
    if (Date.now() >= deadline) return;
    await new Promise<void>((resolve) => setTimeout(resolve, RETRY_GAP_MS));
  }
}
