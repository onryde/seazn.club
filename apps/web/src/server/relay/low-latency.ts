// server/relay/low-latency.ts — the reader of STREAM_PROGRAMME_LOW_LATENCY (W-LL; review of #1322, I2 and N1).
//
// PURE: no `server-only`, no logger, no Sentry. `fakes.ts` imports the Cloudflare adapter and Playwright imports `fakes.ts`
// (e2e/helpers/stream-slot-pool.ts and the walkthroughs), so anything this file imports reaches a non-Next process, where a
// `server-only` import throws at load. relay/__tests__/low-latency.test.ts walks the import chain from fakes.ts and pins that.
//
// config.ts `programmeLowLatencyReading` never throws: an unrecognised value reads as OFF. This is where that is SAID, and the saying
// is the CALLER's: each caller passes the one way it can report (the adapter its injected `warn`, the playback signer the app logger
// and Sentry capture helper), and the reader hands it each distinct bad value ONCE per reader, so a typo on a Fly secret is loud once
// and not on every poll. Reporting can never take a request down: a failure inside it is swallowed, the answer is still the reading.
import { programmeLowLatencyReading } from "./config";

export type ReportInvalidLowLatency = (invalid: string) => void;

/** A reader that reports through `report`. One per call site; its memory of what it reported is its own. */
export function lowLatencyReader(report?: ReportInvalidLowLatency): (env?: Record<string, string | undefined>) => boolean {
  const reported = new Set<string>();
  return (env = process.env) => {
    const { on, invalid } = programmeLowLatencyReading(env);
    if (invalid !== null && !reported.has(invalid)) {
      reported.add(invalid);
      try {
        report?.(invalid);
      } catch {
        // reporting is best effort; the reading stands
      }
    }
    return on;
  };
}

/** The text every caller reports: the variable, the (shortened) value, and what happened. */
export const invalidLowLatencyMessage = (invalid: string): string =>
  `STREAM_PROGRAMME_LOW_LATENCY must be "true" or "false", got ${JSON.stringify(invalid.slice(0, 40))}: low-latency HLS is OFF`;
