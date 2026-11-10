// S2-5 ruling 107 (plan W, Task 2): the server's time, as the pad's transport measures it, so a shared match clock reads the
// same on every scorer's device whatever its own clock says. Pure, no imports.
//
// A sample is taken from the HTTP `Date` header of an `/events` call (the append POST and `listEventsSince`): the header
// names the server's whole second, so the server's time is taken as that second plus half a second, against the request's
// local midpoint. `Date` is chosen over a `recorded_at` on the append's answer (rejected in the plan, with its reasoning):
// the header needs no change to the events route, its idempotency cache or its durable replay, and a replayed answer's
// `recorded_at` would be the original write's. Its ±0.5 s quantisation, medianed over OFFSET_WINDOW samples, sits well
// inside the design's "within a second" (§11). `/state` and `/rules` are not sampled: `/state` revalidates by ETag, and a
// revalidated fetch can hand back a stored response's headers.

/** How many recent samples the offset is the median of. */
export const OFFSET_WINDOW = 5;
/** A round trip longer than this says too little about when the server wrote its header: the sample is dropped. */
export const OFFSET_MAX_RTT_MS = 5_000;

/** The `Date` header's second, plus half of it, minus the request's local midpoint: how far the server's clock is ahead
 *  of this device's. Nothing for a missing or unparseable header, or a round trip that is negative or over the cap. */
export function offsetSampleOf(dateHeader: string | null, sentAtMs: number, receivedAtMs: number): number | undefined {
  if (dateHeader === null) return undefined;
  const serverSecond = Date.parse(dateHeader);
  if (Number.isNaN(serverSecond)) return undefined;
  const rtt = receivedAtMs - sentAtMs;
  if (rtt < 0 || rtt > OFFSET_MAX_RTT_MS) return undefined;
  return serverSecond + 500 - (sentAtMs + receivedAtMs) / 2;
}

export interface ServerOffset {
  add(sampleMs: number): void;
  /** The median of the last OFFSET_WINDOW samples (an even count: the rounded mean of the middle two); null before any. */
  offsetMs(): number | null;
}

export function createServerOffset(): ServerOffset {
  const samples: number[] = [];
  return {
    add(sampleMs) {
      samples.push(sampleMs);
      if (samples.length > OFFSET_WINDOW) samples.shift();
    },
    offsetMs() {
      if (samples.length === 0) return null;
      const sorted = [...samples].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
    },
  };
}
