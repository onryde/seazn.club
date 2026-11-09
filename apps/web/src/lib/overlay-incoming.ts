// The overlay stage's ONE incoming moment list, and the key its queue hook dispatches on.
//
// Lifted out of `components/overlay/overlay-stage.tsx` (R4 S15 fix round 1, m1). The stage calls `stageIncoming` on
// every render, and the sponsor seam test (`server/sponsors/__tests__/seam.test.ts`) calls the same function over the
// real loader's payload. So the composition the seam proves is the one that ships, not a copy of it.
//
// The order is the stage's contract:
//   1. score moments, behind the mount's tip;
//   2. the end-of-over card, newer than the mount's closed over, so OUT precedes the over card;
//   3. the toss, only while no match card is up (the card owns the warming openers);
//   4. the plan's sponsor cards, behind the mount's tip like every moment (OBS opened mid-broadcast must not replay a
//      break).
// Everything sits in ONE list because the queue's `sync` drops every id missing from it, so a second list would lose
// a queued card on the next poll (R4 S7, S6 addendum). While the URL's delay is still awaited, the list is empty.
import { momentsFor, sponsorMoments, type OverlayMoment } from "@/lib/overlay-moments";
import { endOfOverMoment } from "@/lib/overlay-end-of-over";
import { tossMoment } from "@/lib/overlay-openers";

type EooArgs = Parameters<typeof endOfOverMoment>[0];
type TossArgs = Parameters<typeof tossMoment>[0];

export interface StageIncomingInput {
  sportKey: string;
  recent: Parameters<typeof momentsFor>[1] | undefined;
  lastClosedOver: EooArgs["closed"];
  cricketToss: TossArgs["toss"];
  scoringStarted: boolean;
  sponsorPlan: Parameters<typeof sponsorMoments>[0];
  /** The highest ledger seq the page mounted with: nothing at or below it airs. */
  momentBaseline: number;
  /** The over the page mounted with: only a newer closed over airs its card. */
  closedOverBaseline: EooArgs["since"];
  msg: Parameters<typeof momentsFor>[3];
  sideShorts: Parameters<typeof momentsFor>[4];
  sideNames: TossArgs["sideNames"];
  /** A match card is up (a scene's or the slate's): no toss. */
  showMatchCard: boolean;
  /** The URL's delay has not run out yet: nothing at all. */
  awaitingDelay: boolean;
}

const EMPTY_MOMENTS: readonly OverlayMoment[] = [];

export function stageIncoming(i: StageIncomingInput): readonly OverlayMoment[] {
  if (i.awaitingDelay) return EMPTY_MOMENTS;
  const moments = momentsFor(i.sportKey, i.recent ?? [], i.momentBaseline, i.msg, i.sideShorts);
  const eoo = endOfOverMoment({ closed: i.lastClosedOver, since: i.closedOverBaseline, msg: i.msg });
  const toss = i.showMatchCard
    ? null
    : tossMoment({ toss: i.cricketToss, sideNames: i.sideNames, scoringStarted: i.scoringStarted, msg: i.msg });
  const cards = sponsorMoments(i.sponsorPlan).filter((m) => m.seq > i.momentBaseline);
  return [...moments, ...(eoo ?? []), ...(toss ? [toss] : []), ...cards];
}

/** What `use-moment-queue` keys its sync + enqueue on: the moments' IDENTITIES. `incoming` is a fresh array on every
 *  poll even when nothing changed, so a poll that brings the same ids dispatches nothing. */
export function incomingKey(incoming: readonly OverlayMoment[]): string {
  return incoming.map((m) => `${m.seq}:${m.kind}`).join(",");
}
