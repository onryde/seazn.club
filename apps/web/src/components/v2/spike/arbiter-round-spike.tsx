"use client";
// SPIKE (throwaway until the owner picks a variant) — the online-chess ROUND controls moved out of the division's
// Fixtures tab into a side column of the Arbiter Panel. Nothing here forks logic: the card IS `OpenRoundControl` (its own
// reducer, runner, confirm dialog, "+5 min to the round", batches, per-board invites and Resend) and the Held/Flagged queue
// IS `ExternalPlayNeedsResultQueue`; this file only decides WHERE they sit, plus the one-line replacement the Fixtures tab
// keeps. Switched by `?spike=a|b` on both pages; remove the whole directory and its call sites to drop it.
//
// SPIKE_COPY: every string below is English only (no dictionary entry on purpose); search "SPIKE_COPY" to find them.
import Link from "@/components/ui/console-link";
import { OpenRoundControl } from "@/components/v2/desk/open-round-control";
import { ExternalPlayNeedsResultQueue } from "@/components/v2/external-play-needs-result-queue";
import { useId, useState } from "react";
import type { OpenRoundView } from "@/lib/open-round";
import type { SpikeRoundData } from "./spike-helpers";

const MUTED = "text-[#6b5b8a]";
const LINK = "inline-flex min-h-11 items-center text-sm font-semibold text-[#5b21b6] underline-offset-2 hover:underline";

const plural = (n: number, one: string, other: string) => (n === 1 ? one : other);

// ── the Fixtures tab, after ───────────────────────────────────────────────

/** ONE compact line per online round. Neutral when nothing needs the organiser; red when a board of the round is Held or
 *  Flagged. Both go to the Arbiter Panel, where the controls now live. */
export function SpikeRoundLine({ round, attention, href }: { round: OpenRoundView; attention: number; href: string | null }) {
  const invited = round.pairings.filter((p) => p.invitedAt !== null).length;
  const red = attention > 0;
  const text = red
    ? `Round ${round.roundNo} — ${attention} ${plural(attention, "board needs", "boards need")} a decision`
    : round.state === "paired"
      ? `Round ${round.roundNo} — not opened`
      : `Round ${round.roundNo} — open · ${invited} of ${round.pairings.length} invited`;
  const cta = round.state === "paired" && !red ? "Open in Arbiter Panel →" : "Arbiter Panel →";
  return (
    <div
      data-testid="spike-round-line"
      data-state={red ? "attention" : round.state}
      role={red ? "alert" : undefined}
      className={`flex min-w-0 flex-wrap items-center justify-between gap-x-4 border-t px-4 py-1 ${
        red ? "border-[#f1c4c0] bg-[#fef2f2] text-[#b42318]" : "border-[#e7e3f3] text-[#2e1065]"
      }`}
    >
      <span className="min-w-0 py-2 text-sm font-semibold">{text}</span>
      {href !== null && (
        <Link href={href} className={`${LINK} ${red ? "text-[#b42318] underline" : ""}`}>
          {cta}
        </Link>
      )}
    </div>
  );
}

/** What the old queue slot keeps: a red line for Held/Flagged boards no listed round claims. */
export function SpikeUnmatchedLine({ count, href }: { count: number; href: string | null }) {
  if (count === 0) return null;
  return (
    <div
      data-testid="spike-unmatched-line"
      role="alert"
      className="mb-4 flex min-w-0 flex-wrap items-center justify-between gap-x-4 rounded-xl border border-[#f1c4c0] bg-[#fef2f2] px-4 py-1 text-[#b42318]"
    >
      <span className="min-w-0 py-2 text-sm font-semibold">{`${count} ${plural(count, "board needs", "boards need")} a decision`}</span>
      {href !== null && (
        <Link href={href} className={`${LINK} text-[#b42318] underline`}>
          Arbiter Panel →
        </Link>
      )}
    </div>
  );
}

// ── the Arbiter Panel's round card ────────────────────────────────────────

/** Round + invites + queue, the one block both variants place. Several rounds only when the division offers several
 *  (an open round still running beside the next one to open): the round on screen first. */
export function SpikeRoundCard({
  data,
  slugs,
  onScreen,
}: {
  data: SpikeRoundData;
  slugs: { org: string; comp: string; div: string };
  onScreen: { stageId: string; roundNo: number } | null;
}) {
  const isLead = (r: OpenRoundView) => onScreen !== null && r.stageId === onScreen.stageId && r.roundNo === onScreen.roundNo;
  const rounds = [...data.rounds].sort((a, b) => Number(!isLead(a)) - Number(!isLead(b)));
  const keyOf = (r: OpenRoundView) => `${r.stageId}:${r.roundNo}`;
  // ONE round at a time (owner, on the first build): the round on screen, or - with nothing opened yet - the first. Where the
  // division offers more (a round still running beside the next one to open) a switch picks which; every round stays mounted
  // (hidden) so a "+5 min" answer or an Open round notice is still there when the arbiter switches back.
  const [picked, setPicked] = useState<string | null>(null);
  const active = rounds.find((r) => keyOf(r) === picked) ?? rounds[0] ?? null;
  return (
    <div data-testid="spike-round-card" className="flex min-w-0 flex-col gap-3">
      {rounds.length > 0 ? (
        <div className="min-w-0 overflow-hidden rounded-xl border border-[#e7e3f3] bg-white [&>div>section]:border-t-0">
          {rounds.length > 1 && (
            <div role="group" aria-label="Round" data-testid="spike-round-switch" className="flex min-w-0 flex-wrap gap-2 border-b border-[#e7e3f3] bg-[#faf9ff] px-4 py-2">
              {rounds.map((r) => {
                const pressed = active !== null && keyOf(r) === keyOf(active);
                return (
                  <button
                    key={keyOf(r)}
                    type="button"
                    aria-pressed={pressed}
                    onClick={() => setPicked(keyOf(r))}
                    className={`flex min-h-11 min-w-0 cursor-pointer items-center rounded-[10px] px-3 text-left text-sm font-semibold text-[#2e1065] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#7c3aed] ${
                      pressed ? "border-2 border-[#7c3aed] bg-[#f3effc] px-[11px]" : "border border-[#e7e3f3] bg-white"
                    }`}
                  >
                    {`Round ${r.roundNo}`}
                    <span className={`ml-1.5 text-xs font-normal ${MUTED}`}>{r.state === "paired" ? "· not opened" : "· open"}</span>
                  </button>
                );
              })}
            </div>
          )}
          {rounds.map((r) => (
            <div key={keyOf(r)} data-testid="spike-round" data-active={active !== null && keyOf(r) === keyOf(active) ? "true" : undefined} className={active !== null && keyOf(r) === keyOf(active) ? "min-w-0" : "hidden"}>
              <OpenRoundControl round={r} tz={data.tz} />
            </div>
          ))}
        </div>
      ) : (
        <p className={`m-0 rounded-xl border border-[#e7e3f3] bg-white px-4 py-3 text-sm ${MUTED}`} data-testid="spike-round-none">
          {/* SPIKE_COPY */}Every round is open and past its check-in, or none is paired yet.
        </p>
      )}
      <div className="empty:hidden">
        <ExternalPlayNeedsResultQueue held={data.queue.held} flagged={data.queue.flagged} ownFlagged={data.queue.ownFlagged} slugs={slugs} stacked />
      </div>
    </div>
  );
}

/** The fold for variant B below `lg` (where the panel is one column): one row under the board picker that says where the round
 *  stands, tapped open to the whole card. At `lg` the row is not drawn and the card is just the left column's second block.
 *  (PhoneDisclosure is the house component for this but folds at `md`; here the panel's one-column range runs to `lg`.) */
export function SpikeRoundFold({ data, onScreen, children }: { data: SpikeRoundData; onScreen: { stageId: string; roundNo: number } | null; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const lead = data.rounds.find((r) => onScreen && r.stageId === onScreen.stageId && r.roundNo === onScreen.roundNo) ?? data.rounds[0] ?? null;
  const attention = data.queue.held.length + data.queue.flagged.length;
  const parts = lead === null ? ["Round"] : [`Round ${lead.roundNo}`, lead.state === "paired" ? "not opened" : `${lead.pairings.filter((p) => p.invitedAt !== null).length} of ${lead.pairings.length} invited`];
  return (
    <div data-testid="spike-round-fold" data-open={open} className="flex min-w-0 flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        aria-label={open ? "Hide round controls" : "Show round controls"}
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-11 w-full items-center justify-between gap-2 rounded-xl border border-[#e7e3f3] bg-white px-4 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#7c3aed] lg:hidden"
      >
        <span className="min-w-0 truncate text-sm font-semibold text-[#2e1065]">{parts.join(" · ")}</span>
        <span className="flex shrink-0 items-center gap-2 text-xs text-[#4a3a6b]">
          {attention > 0 && <span className="font-semibold text-[#b42318]">{`${attention} to decide`}</span>}
          <span aria-hidden="true">{open ? "▴" : "▾"}</span>
        </span>
      </button>
      <div id={bodyId} className={open ? "min-w-0" : "min-w-0 max-lg:hidden"}>
        {children}
      </div>
    </div>
  );
}
