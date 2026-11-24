"use client";
// The Streaming page's Seazn Hosted card (Phase 4 Task 33b; mock "Option B", owner-approved 2026-11-23, layout only — the build is the
// house look: the lime accent and the purple-100 cards). It says what Seazn Hosted is (a line, three chips, the credit line) and carries
// the org's switch (Task 33, V553 `offered`): on, matches can pick Seazn; off, they cannot.
//
// The card reads the switch ITSELF (`offered`, from `seaznOfferOf` on the page), never the destinations list: the list leaves Seazn out
// while the switch is off (`seaznWhere`), so a card built from it would vanish with the one control that turns it back on.
//
// Off gates NEW streams only (owner Q2): a stream already live keeps going, and replays already made stay up on their match pages — the
// off line says so. Turning it off or on is the route's write (`PUT /api/v1/orgs/{id}/seazn-hosted`, owner / admin: `requireOrgAuth`
// "write", T33 review m7), never a second door here. A member who cannot edit sees the card and its state in words, with no switch.
//
// The switch shows the choice at once and is rolled back to what it showed before if the PUT is refused, with the refusal in the card.
// A ref refuses a second tap while the PUT is in flight (a double tap lands on the SAME render, before `busy` can disable the button).
// Every refusal is the page's own sentence by its machine code — the server's `message` is English API prose and is never rendered
// (stream-destinations-panel.tsx's rule).
import { useId, useRef, useState } from "react";
import { History, LockOpen, Play, type LucideIcon } from "lucide-react";
import { apiV1 } from "@/lib/client-v1";
import { useMsg } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";
import { wireOf } from "./youtube-connect-panel";
import { STREAM_KIND_BRAND } from "./stream-platform-mark";

type Msg = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** The admin seat an over-quota org has frozen (auth.ts `requireOrgAuth`): a 402 PAYMENT_REQUIRED whose `feature_key` is this. */
const FROZEN_SEAT_FEATURE = "members.max";

/** A refused switch as the page's own sentence, by the route's machine code. Anything else is the retry line. */
export function seaznSwitchErrorText(msg: Msg, err: unknown): string {
  const w = wireOf(err);
  switch (w?.code) {
    case "FORBIDDEN":
      return msg("streamDest.error.forbidden");
    case "UNAUTHENTICATED":
      return msg("streamDest.error.signedOut");
    case "PAYMENT_REQUIRED":
      return w.extra.feature_key === FROZEN_SEAT_FEATURE ? msg("streamDest.error.seatFrozen") : msg("streamDest.error.generic");
    default:
      return msg("streamDest.error.generic");
  }
}

/** The three chips, in the mock's order: what an organiser gets without reading the sentence. */
const CHIPS: readonly { key: MessageKey; Icon: LucideIcon }[] = [
  { key: "streaming.seazn.chip.noAccount", Icon: LockOpen },
  { key: "streaming.seazn.chip.matchPage", Icon: Play },
  { key: "streaming.seazn.chip.replay", Icon: History },
];

/** What the organiser chose, shown while the PUT is in flight and after it saved, until the page reads back something other than the
 *  value it was chosen against (`base`): then the server is the truth again (another admin's change shows on the next read). */
type Choice = { base: boolean; value: boolean; saved: boolean };

export function SeaznDestinationCard({ orgId, offered, canEdit }: {
  orgId: string;
  /** The org's switch as the page read it (`seaznOfferOf`). */
  offered: boolean;
  /** Owner or admin — the route's write gate. Anyone else sees the card read-only. */
  canEdit: boolean;
}) {
  const msg = useMsg();
  const [choice, setChoice] = useState<Choice | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const nameId = useId();
  const lineId = useId();
  if (choice !== null && choice.saved && offered !== choice.base) setChoice(null);
  const on = choice !== null ? choice.value : offered;
  // The brand, not copy (owner 2026-11-23): ONE authority for every surface that names this destination (T33c review m3).
  const name = STREAM_KIND_BRAND.seazn;

  const turn = async () => {
    if (!canEdit || inFlight.current) return;
    inFlight.current = true;
    const before = choice;
    const next = !on;
    setBusy(true);
    setError(null);
    setChoice({ base: offered, value: next, saved: false });
    try {
      await apiV1(`/api/v1/orgs/${orgId}/seazn-hosted`, { method: "PUT", json: { offered: next } });
      setChoice({ base: offered, value: next, saved: true });
    } catch (err) {
      // Back to what the switch showed before this tap — the last SAVED choice, not the page's first read.
      setChoice(before);
      setError(seaznSwitchErrorText(msg, err));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const stateWord = msg(on ? "streaming.seazn.state.on" : "streaming.seazn.state.off");

  return (
    <section
      data-testid="seazn-card"
      data-state={on ? "on" : "off"}
      aria-labelledby={nameId}
      className={`relative grid grid-cols-[2.5rem_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-3 overflow-hidden rounded-2xl border-[1.5px] p-4 pl-5 before:absolute before:inset-y-0 before:left-0 before:w-1.5 before:content-[''] md:grid-cols-[2.75rem_minmax(0,1fr)_auto] md:gap-x-4 md:p-5 md:pl-6 ${
        on ? "border-[var(--mk-lime)] bg-white shadow-sm before:bg-[var(--mk-lime)]" : "border-slate-200 bg-slate-50 before:bg-slate-300"
      }`}
    >
      {/* The house tile: night with a lime base when on, muted when off. Decorative — the name sits beside it. */}
      <span
        aria-hidden="true"
        className={`grid h-10 w-10 place-items-center rounded-[10px] text-lg font-extrabold text-white md:h-11 md:w-11 ${
          on ? "bg-[var(--mk-night)] shadow-[inset_0_-3px_0_var(--mk-lime)]" : "bg-slate-400"
        }`}
      >
        S
      </span>
      <div className="flex min-h-10 min-w-0 flex-wrap items-center gap-x-2 gap-y-1 md:min-h-11">
        <h2 id={nameId} className={`text-base font-semibold ${on ? "text-slate-900" : "text-slate-600"}`}>{name}</h2>
        {/* Kept when off, as the nudge to turn it back on (mock B, screen 4). */}
        <span data-testid="seazn-card-tag" className="rounded-full bg-lime-50 px-2 py-0.5 text-[11px] font-semibold text-lime-800 ring-1 ring-inset ring-lime-200">
          {msg("streaming.seazn.recommended")}
        </span>
      </div>
      <div className="flex flex-col items-end gap-0.5 md:row-span-2">
        {canEdit && (
          <button
            type="button"
            role="switch"
            data-testid="seazn-card-switch"
            aria-checked={on}
            aria-label={msg("streaming.seazn.switch", { name })}
            aria-describedby={lineId}
            aria-busy={busy}
            disabled={busy}
            onClick={() => void turn()}
            className="inline-flex min-h-11 min-w-11 items-center justify-end rounded-lg disabled:cursor-wait"
          >
            <span
              aria-hidden="true"
              className={`relative inline-block h-[26px] w-[46px] shrink-0 rounded-full transition-colors motion-reduce:transition-none ${
                on ? "bg-[var(--mk-lime)]" : "bg-slate-300"
              }`}
            >
              <span
                className={`absolute left-[3px] top-[3px] h-5 w-5 rounded-full shadow transition-transform motion-reduce:transition-none ${
                  on ? "translate-x-5 bg-[var(--mk-night)]" : "bg-white"
                }`}
              />
            </span>
          </button>
        )}
        {/* The state in words: beside the switch it repeats aria-checked (hidden from assistive tech); for a member who cannot edit it is
            the only statement of the state, so it is read. */}
        <span
          data-testid="seazn-card-state"
          aria-hidden={canEdit || undefined}
          className={`text-xs font-semibold ${on ? "text-lime-800" : "text-slate-500"} ${
            canEdit ? "" : `mt-1.5 rounded-full px-2 py-0.5 ring-1 ring-inset ${on ? "bg-lime-50 ring-lime-200" : "bg-white ring-slate-200"}`
          }`}
        >
          {stateWord}
        </span>
      </div>
      {/* Phones: the body spans the card under the tile, the name and the switch; from md it sits in the name's column. */}
      <div className="col-span-3 min-w-0 md:col-span-1 md:col-start-2">
        <p className={`max-w-prose text-sm ${on ? "text-slate-600" : "text-slate-500"}`}>{msg("streaming.seazn.why")}</p>
        <ul data-testid="seazn-card-chips" className="mt-2.5 flex flex-col items-start gap-1.5 md:flex-row md:flex-wrap">
          {CHIPS.map(({ key, Icon }) => (
            <li
              key={key}
              data-testid="seazn-card-chip"
              className={`inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${
                on ? "bg-purple-50 text-purple-700 ring-purple-100" : "bg-white text-slate-500 ring-slate-200"
              }`}
            >
              <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
              {msg(key)}
            </li>
          ))}
        </ul>
        {/* The off line REPLACES the credit line. It is longer (a boxed note of two to five lines against the credit line's one), so the
            card GROWS when it is turned off — after the tap, so no layout shift is counted; the owner sees it at sign-off (review m1). */}
        {on ? (
          <p id={lineId} data-testid="seazn-card-cost" className="mt-2.5 text-xs text-slate-500">{msg("streaming.seazn.cost")}</p>
        ) : (
          <p id={lineId} data-testid="seazn-card-off" className="mt-2.5 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-[13px] text-slate-600">
            {msg("streaming.seazn.off", { name })}
          </p>
        )}
        {error !== null && (
          <p data-testid="seazn-card-error" role="alert" className="mt-2.5 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
