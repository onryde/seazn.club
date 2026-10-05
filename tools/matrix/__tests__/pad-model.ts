// A fake pad for the replay tests: the real replay and the real adapter, a page
// that records every tap, and a ledger that a per-sport MODEL writes — what
// Step 0 saw the product write for those taps. Shared by pad-adapters.test.ts
// and pad-cricket-innings.test.ts. Not a test file (vitest reads *.test.ts).
import { selectorForTapStep, type PadPage, type TapAdapterContext } from "../../bench/lib/drivers/scorer.ts";
import type { LedgerRow } from "../../bench/lib/ledger.ts";
import { replayEvents, type ReplayResult } from "../lib/pads/replay.ts";
import type { MatrixPadAdapter } from "../lib/pads/types.ts";
import type { StreamEvent } from "../lib/streams/types.ts";

export type RowIn = { type: string; payload: unknown };

/** Replays `events` through the real replay on a fake pad modelled on what
 *  Step 0 saw each route write. Every tap is recorded; the replay's hold
 *  release (its `pad-send-now` presence check, the one boundary it crosses
 *  after every event's taps) commits the rows `write` answers for the taps
 *  since the last release. */
export async function replayOnModel(
  adapter: MatrixPadAdapter,
  events: readonly StreamEvent[],
  ctx: TapAdapterContext,
  write: (taps: readonly string[], ledger: readonly LedgerRow[]) => RowIn[],
): Promise<{ res: ReplayResult; ledger: LedgerRow[] }> {
  const ledger: LedgerRow[] = [];
  let taps: string[] = [];
  const sendNow = selectorForTapStep({ kind: "releaseHold" });
  const page: PadPage = {
    locator: (sel: string) => ({
      click: () => { taps.push(sel); return Promise.resolve(); },
      fill: (v: string) => { taps.push(`${sel}=${v}`); return Promise.resolve(); },
      waitFor: () => Promise.resolve(),
      count: () => {
        if (sel === sendNow) {
          for (const r of write(taps, ledger)) ledger.push({ id: `r${ledger.length + 1}`, seq: ledger.length + 1, type: r.type, payload: r.payload });
          taps = [];
        }
        return Promise.resolve(0);
      },
    }),
    goto: () => Promise.resolve(),
    setViewportSize: () => Promise.resolve(),
  };
  const res = await replayEvents(page, adapter, events, ctx, {
    holdMs: 3000,
    tip: () => Promise.resolve(0),
    ledger: (since: number) => Promise.resolve(ledger.filter((r) => r.seq > since)),
    sleep: () => Promise.resolve(),
  });
  return { res, ledger };
}
