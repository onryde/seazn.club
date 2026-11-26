import "server-only";
// server/relay/low-latency.ts — the request-path reader of STREAM_PROGRAMME_LOW_LATENCY (W-LL; review of #1322, I2).
//
// config.ts `programmeLowLatencyReading` is pure and never throws: an unrecognised value reads as OFF. This is where that is SAID:
// once per distinct bad value per process, a logger warning and a Sentry error (the app's one capture helper, never a second init),
// so a typo on a Fly secret is loud once and not on every poll. Reporting can never take a request down: a failure inside it is
// swallowed, the answer is still the reading.
import { captureError } from "@/lib/sentry";
import { log } from "@/server/logger";
import { programmeLowLatencyReading } from "./config";

const reported = new Set<string>();

/** Test seam: forget what was reported (a process keeps it for its life). */
export function resetLowLatencyReports(): void {
  reported.clear();
}

/** Whether the programme input asks for LL-HLS now. Never throws. */
export function lowLatencyOn(env: Record<string, string | undefined> = process.env): boolean {
  const { on, invalid } = programmeLowLatencyReading(env);
  if (invalid !== null && !reported.has(invalid)) {
    reported.add(invalid);
    try {
      const shown = JSON.stringify(invalid.slice(0, 40));
      log.warn({ value: shown }, `STREAM_PROGRAMME_LOW_LATENCY must be "true" or "false", got ${shown}: low-latency HLS is OFF`);
      captureError(new Error(`STREAM_PROGRAMME_LOW_LATENCY is not true or false (${shown}); programme low-latency HLS is off`), { route: "relay/low-latency" });
    } catch {
      // reporting is best effort; the reading stands
    }
  }
  return on;
}
