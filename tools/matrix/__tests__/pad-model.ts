// A fake pad for the replay tests: the real replay and the real adapter, a page
// that records every tap, and a ledger that a per-sport MODEL writes — what
// Step 0 saw the product write for those taps. Shared by pad-adapters.test.ts,
// pad-cricket-innings.test.ts and pad-innings-set.test.ts. Not a test file
// (vitest reads *.test.ts).
import { cricket } from "@seazn/engine/sports/cricket";
import { START_MATCH_TESTID, selectorForTapStep, type PadPage, type TapAdapterContext } from "../../bench/lib/drivers/scorer.ts";
import type { LedgerRow } from "../../bench/lib/ledger.ts";
import { foldStream } from "../lib/fold.ts";
import { CRICKET_DECLARE, CRICKET_DECLARE_TILE, CRICKET_OVER_TILE, CRICKET_SUMMARY } from "../lib/pads/cricket.ts";
import { replayEvents, type ReplayResult } from "../lib/pads/replay.ts";
import type { MatrixPadAdapter } from "../lib/pads/types.ts";
import type { StreamEvent } from "../lib/streams/types.ts";

export type RowIn = { type: string; payload: unknown };

/** A fake pad page: every tap is recorded, and the replay's hold release (its
 *  `pad-send-now` presence check, the one boundary it crosses after every
 *  event's taps) hands the taps since the last release to `commit`, which writes
 *  the rows the product would. The BrowserDriver is handed this as its page. */
export function modelPage(commit: (taps: readonly string[]) => Promise<void>): PadPage {
  let taps: string[] = [];
  const sendNow = selectorForTapStep({ kind: "releaseHold" });
  return {
    locator: (sel: string) => ({
      click: () => { taps.push(sel); return Promise.resolve(); },
      fill: (v: string) => { taps.push(`${sel}=${v}`); return Promise.resolve(); },
      waitFor: () => Promise.resolve(),
      count: async () => {
        if (sel === sendNow) {
          const held = taps;
          taps = [];
          await commit(held);
        }
        return 0;
      },
    }),
    goto: () => Promise.resolve(),
    setViewportSize: () => Promise.resolve(),
  };
}

/** Replays `events` through the real replay on a fake pad modelled on what
 *  Step 0 saw each route write: `write` answers the rows for the taps since the
 *  last release. */
export async function replayOnModel(
  adapter: MatrixPadAdapter,
  events: readonly StreamEvent[],
  ctx: TapAdapterContext,
  write: (taps: readonly string[], ledger: readonly LedgerRow[]) => RowIn[],
): Promise<{ res: ReplayResult; ledger: LedgerRow[] }> {
  const ledger: LedgerRow[] = [];
  const page = modelPage((taps) => {
    for (const r of write(taps, ledger)) ledger.push({ id: `r${ledger.length + 1}`, seq: ledger.length + 1, type: r.type, payload: r.payload });
    return Promise.resolve();
  });
  const res = await replayEvents(page, adapter, events, ctx, {
    holdMs: 3000,
    tip: () => Promise.resolve(0),
    ledger: (since: number) => Promise.resolve(ledger.filter((r) => r.seq > since)),
    sleep: () => Promise.resolve(),
  });
  return { res, ledger };
}

export const TILE = (tileId: string) => selectorForTapStep({ kind: "tile", tileId });
const START_SEL = selectorForTapStep({ kind: "testid", testid: START_MATCH_TESTID });
const NUM_SEL = selectorForTapStep({ kind: "number", value: 0 });
const CONFIRM_SEL = selectorForTapStep({ kind: "confirm" });
const numberOf = (tap: string): number | null => (tap.startsWith(`${NUM_SEL}=`) ? Number(tap.slice(NUM_SEL.length + 1)) : null);
export const asEvents = (rows: readonly (LedgerRow | RowIn)[]): StreamEvent[] => rows.map((r) => ({ type: r.type, payload: r.payload }));
export interface InningsLike { runs: number; wickets: number; legalBalls: number; closed: boolean; declared?: boolean }
export const inningsOfState = (state: unknown): InningsLike[] => (state as { innings?: InningsLike[] }).innings ?? [];

/** cricket as Step 0 saw it (2026-09-30, 320): an over sheet is the overSummary
 *  tile, then runs, wickets and balls, each a number and a confirm, and writes
 *  ONE row — this over added onto the fold's open innings (0/0/0 when none is
 *  open), `partial: true`. Once the engine has an outcome the tile is gone. Two
 *  innings a side add the `declare` tile (cricket.tsx:1506-1511, an `{event}`
 *  tile that HOLDS until the replay's release): it sends the engine's
 *  declaration while an innings is open, and nothing otherwise (closedTile). */
export function twoInningsModel(ctx: TapAdapterContext) {
  return (taps: readonly string[], ledger: readonly LedgerRow[]): RowIn[] => {
    if (taps.length === 1 && taps[0] === START_SEL) return [{ type: "core.start", payload: {} }];
    const out: RowIn[] = [];
    for (let i = 0; i < taps.length;) {
      const folded = foldStream(cricket, ctx.cfg, ctx.entrants.home, ctx.entrants.away, asEvents([...ledger, ...out]));
      const open = inningsOfState(folded.state).find((x) => !x.closed);
      if (taps[i] === TILE(CRICKET_DECLARE_TILE)) {
        if (folded.outcome !== null || open === undefined) return out;
        out.push({ type: CRICKET_DECLARE, payload: {} });
        i++;
        continue;
      }
      const c = taps.slice(i, i + 7);
      const [r, typedW, b] = [numberOf(c[1] ?? ""), numberOf(c[3] ?? ""), numberOf(c[5] ?? "")];
      if (c[0] !== TILE(CRICKET_OVER_TILE) || c[2] !== CONFIRM_SEL || c[4] !== CONFIRM_SEL || c[6] !== CONFIRM_SEL || r === null || typedW === null || b === null) return out;
      if (folded.outcome !== null) return out;
      const base = open ?? { runs: 0, wickets: 0, legalBalls: 0 };
      out.push({ type: CRICKET_SUMMARY, payload: { runs: base.runs + r, wickets: base.wickets + typedW, legalBalls: base.legalBalls + b, partial: true } });
      i += 7;
    }
    return out;
  };
}

