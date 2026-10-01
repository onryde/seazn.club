// Ruling 46: N in-process workers against ONE server and DB. Each worker is
// opened once (its own sign-in, session and jar) and pulls the next plan
// item off a shared cursor; results are stored by plan index, so the order
// of results.json never depends on which worker was fastest.
//
// A throw from `run` is that item's: `crashed` maps it to the item's result,
// at the item's own index, and every other index is left in place. A throw
// from `open` or from `crashed` itself ABORTS the queue (the caller's way of
// saying "the environment, not this item" — a DB that stopped proving it is
// ours, a sign-in refused): no worker starts another item, the items already
// in flight finish, and runQueue rejects with the first such error. Nothing
// is left running behind the rejection, so the caller may release what the
// workers share (the DB handle, the browser) as soon as it settles.
//
// MAX_WORKERS is the local-env bound: the prod DB budget note is 60
// connections, and each worker's cases open their requests serially. The
// next wave may raise it inside a shard.
export const MAX_WORKERS = 8;

export class WorkersOutOfRange extends Error {
  readonly workers: number;
  constructor(n: number) {
    super(`workers: ${n} is outside 1..${MAX_WORKERS}`);
    this.name = "WorkersOutOfRange";
    this.workers = n;
  }
}

export async function runQueue<W, T, R>(
  items: readonly T[],
  workers: number,
  open: (n: number) => Promise<W>,
  run: (w: W, item: T, index: number) => Promise<R>,
  crashed: (item: T, index: number, error: unknown) => R,
): Promise<R[]> {
  if (!Number.isInteger(workers) || workers < 1 || workers > MAX_WORKERS) throw new WorkersOutOfRange(workers);
  const out = new Array<R>(items.length);
  // A holder, not two `let`s: both are written inside the lanes, and a `let`
  // assigned only in a closure narrows to its initial value out here.
  const q: { next: number; abort: { error: unknown } | null } = { next: 0, abort: null };
  const lane = async (n: number): Promise<void> => {
    try {
      const w = await open(n);
      while (q.abort === null && q.next < items.length) {
        const i = q.next++;
        try { out[i] = await run(w, items[i], i); } catch (e) { out[i] = crashed(items[i], i, e); }
      }
    } catch (e) {
      q.abort ??= { error: e };
    }
  };
  await Promise.all(Array.from({ length: Math.min(workers, items.length) }, (_, n) => lane(n)));
  if (q.abort !== null) throw q.abort.error;
  return out;
}

/** A lock for a resource every worker shares (found live, T11 Step 7): the
 *  case-org provision's entitlement bust flips the run's ONE owner to staff
 *  for two admin calls and back, so a second worker's demotion inside the
 *  first's window made the admin route answer 401. Tasks run one at a time,
 *  in call order; a task's rejection reaches its own caller only, and the
 *  next task still runs. One lock per run: each call makes a fresh one. */
export function oneAtATime(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const mine = tail.then(task);
    // The chain waits for this task to SETTLE, never to succeed: a rejection
    // must not stall every task queued behind it.
    tail = mine.then(() => undefined, () => undefined);
    return mine;
  };
}
