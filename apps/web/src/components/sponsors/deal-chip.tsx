"use client";

// A sponsor deal's chip (sponsor deals PR 2, Task 14; mockup screen 1): what state the deal on a sponsor's row is in.
//
// It wears the status-chip vocabulary (components/ui/status-chip-style.ts, re-exported by status-chip.tsx) - the house's one
// declaration of how lifecycle state paints - and invents no colour. It reads the style module, never status-chip.tsx itself: that
// file reads its words through lib/messages-i18n.ts (`server-only`), which a client component cannot import (`next build` fails).
// Which ChipState each deal kind borrows is a reading of the NAME first (a draft is a draft, a scheduled deal is scheduled, an
// ended one is completed) and of the mockup's hue second (awaiting approval keeps the mockup's purple ring; a live deal keeps its
// floodlit lime). The words come from lib/sponsor-deals.ts `dealChip()`, the engine's own answer to "what does this deal's chip
// say", never re-derived here.
import { useMsg } from "@/components/i18n/dict-provider";
import { CHIP_BASE, CHIP_STYLE, type ChipState } from "@/components/ui/status-chip-style";
import { dealChip, type DealChip as DealChipModel, type SponsorDeal } from "@/lib/sponsor-deals";
import type { MessageKey } from "@/lib/messages";

type Kind = DealChipModel["kind"] | "none";

/** Every kind's words. A Record, so a kind the engine grows without words does not compile. `none` is a sponsor with no deal. */
export const DEAL_CHIP_MSG: Record<Kind, MessageKey> = {
  draft: "sponsors.deal.chip.draft",
  awaiting_payment: "sponsors.deal.chip.awaitingPayment",
  paid: "sponsors.deal.chip.paid",
  scheduled: "sponsors.deal.chip.scheduled",
  awaiting_approval: "sponsors.deal.chip.awaitingApproval",
  live: "sponsors.deal.chip.live",
  ended: "sponsors.deal.chip.ended",
  none: "sponsors.deal.chip.none",
};

/** Which status-chip recipe each kind wears. Queued deals (paid and waiting, scheduled) share the "scheduled" purple wash; the
 *  words tell them apart. */
const KIND_STATE: Record<Kind, ChipState> = {
  draft: "draft",
  awaiting_payment: "in_progress",
  paid: "scheduled",
  scheduled: "scheduled",
  awaiting_approval: "registration",
  live: "live",
  ended: "completed",
  none: "archived",
};

/** "No deal" borrows the archived chip's quiet outline one step darker: archived's `text-slate-400` is ~2.6:1 on white and AA wants
 *  4.5:1 (slate-500 is 4.8:1). A swap on the shared recipe, so the status chip's own `archived` is untouched. */
const NONE_STYLE = CHIP_STYLE.archived.replace("text-slate-400", "text-slate-500");

/** A deal's chip; a sponsor with no deal (`null`) reads "No deal". */
export function DealChip({ deal }: { deal: SponsorDeal | null }) {
  const msg = useMsg();
  const model = deal === null ? null : dealChip(deal);
  const kind: Kind = model?.kind ?? "none";
  // A live deal's two variants: parked by a dispute (not live on the pages while it is), and still unpaid.
  const held = model?.onHold === true;
  const label: MessageKey = held
    ? "sponsors.deal.chip.liveOnHold"
    : model?.awaitingPayment
      ? "sponsors.deal.chip.liveAwaitingPayment"
      : DEAL_CHIP_MSG[kind];
  const state: ChipState = held ? "frozen" : KIND_STATE[kind];
  return (
    <span data-testid="deal-chip" data-chip-kind={kind} className={`${CHIP_BASE} max-w-full ${kind === "none" ? NONE_STYLE : CHIP_STYLE[state]}`}>
      {state === "live" && <span aria-hidden className="chip-pulse-dot h-1.5 w-1.5 shrink-0 rounded-full bg-lime-400" />}
      {msg(label)}
    </span>
  );
}
