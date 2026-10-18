// Match openers — toss center card eligibility (design 2026-09-12 Feature A2).
// Pure / client-safe. Hold ms is the single source; moment-timing re-exports it.
import type { OverlayCricketToss } from "@/lib/overlay-cricket";
import type { OverlayMoment } from "@/lib/overlay-moments";
import type { OverlayMsg } from "@/lib/overlay-model";
import { EVENT_KEY } from "@/lib/scoring-vocab";
import type { OverlayToss } from "@/lib/overlay-toss";

/** Toss opener card — denser copy than a SIX slab (design 2026-09-12). */
export const OVERLAY_TOSS_HOLD_MS = 8_000;

/**
 * A2: toss decided, no scoring yet. Identity is stable (`toss:0`) so reconnect
 * while still pre-scoring shows once; after scoringStarted the builder returns
 * null and the queue never sees it again.
 */
export function tossMoment(args: {
  toss: OverlayCricketToss | null | undefined;
  sideNames: readonly [string, string];
  scoringStarted: boolean;
  msg: OverlayMsg;
  seq?: number;
}): OverlayMoment | null {
  if (args.scoringStarted) return null;
  if (!args.toss) return null;
  const team = args.sideNames[args.toss.wonBySide] ?? "";
  if (team === "") return null;
  const choice = args.msg(
    args.toss.elected === "bat" ? "overlay.toss.bat" : "overlay.toss.bowl",
  );
  return {
    seq: args.seq ?? 0,
    kind: "toss",
    graphic: "toss",
    holdMs: OVERLAY_TOSS_HOLD_MS,
    tone: "led",
    headline: args.msg("overlay.toss.wonAndElected", { team, choice }),
  };
}

/**
 * Does this sport have a toss at all — does its engine module declare a `<sport>.toss` event? Read off `EVENT_KEY`,
 * this app's vocabulary of the engine's declared event types (client-safe, so the overlay bundle never imports the
 * engine registry); `overlay-openers-end-of-over.test.ts` sweeps this answer against every overlay sport's own
 * `eventSchemas`. Review d (PR #974, from #782):
 * the warming card promised "Toss pending" on every sport — football, badminton, tennis — that will never have one.
 */
export function declaresToss(sportKey: string): boolean {
  return sportKey !== "" && Object.hasOwn(EVENT_KEY, `${sportKey}.toss`);
}

/** The warming card's line: the toss (pending, or that sport's own result once known — A1 enrichment while the match
 *  card owns the canvas) for a sport that has one; the start alone for every other sport. R2005 change 11: the toss is
 *  a PER-SPORT union — cricket's won-and-elected, carrom's breaks-first — so each sport says what its toss recorded. */
export function warmingLine(args: {
  sportKey: string;
  toss: OverlayToss | null | undefined;
  sideNames: readonly [string, string];
  startContext: string;
  msg: OverlayMsg;
}): string {
  if (!declaresToss(args.sportKey)) return args.startContext;
  const pending = () => args.msg("overlay.slate.warmingLineTossPending", { start: args.startContext });
  const toss = args.toss;
  if (!toss) return pending();
  if (toss.sport === "carrom") {
    const team = args.sideNames[toss.toss.firstBreakSide] ?? "";
    return team === "" ? pending() : args.msg("overlay.toss.breaksFirst", { team });
  }
  const team = args.sideNames[toss.toss.wonBySide] ?? "";
  if (team === "") return pending();
  const choice = args.msg(
    toss.toss.elected === "bat" ? "overlay.toss.bat" : "overlay.toss.bowl",
  );
  return args.msg("overlay.toss.wonAndElected", { team, choice });
}
