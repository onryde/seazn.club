"use client";
// The game actions, in the owner-approved canvas states (2026-10-11):
//   before both have moved — a disabled "Draw after move 1" and "Abort game"
//     (lila: a game is abortable, and takes no draw offer, until ply 2);
//   mid-game — "Offer draw" and "Resign";
//   an incoming offer — option A: the draw card ("Ada offers a draw / Making
//     a move turns it down.", Decline + Accept draw), Resign below;
//   your own offer — a disabled "Draw offered" (never Accept/Decline), Resign,
//     and who you are waiting for.
// A game that is over renders nothing. A move cannot be taken back: Lichess's
// Board API offers no such call, and spec §6 rules it out.
//
// `onAct` takes T10's PlayAction shapes verbatim: `draw` with accept:true
// offers or accepts, accept:false declines (T10 carry 3).
import { useState } from "react";
import { ConfirmDialog } from "@/components/v2/confirm-dialog";
import type { RoomActBody } from "./room-api";
import type { Colour } from "./room-snapshot";
import { firstName, type RoomT } from "./room-copy";

/** lila's floor (chess/Game.scala `abortable`; Drawer.scala): fewer than two
 *  plies ⇒ the game can be aborted and takes no draw offer. */
export const ABORTABLE_BELOW_PLY = 2;

type Props = {
  ply: number;
  over: boolean;
  you: Colour;
  drawOfferBy: Colour | null;
  opponentName: string;
  busy: boolean;
  onAct: (action: RoomActBody) => void;
  t: RoomT;
};

const BTN = "min-h-11 rounded-[10px] text-[15px] font-semibold disabled:cursor-not-allowed";
const SECONDARY = `${BTN} border border-[#c9bdf0] bg-white text-[#2e1065]`;
const DANGER = `${BTN} border border-[#f1c4c0] bg-white text-[#b42318]`;
const PRIMARY = `${BTN} border-0 bg-[#7c3aed] text-white`;
const PARKED = "min-h-11 rounded-[10px] border border-dashed border-[#d8d0ee] bg-[#f6f3ee] text-[13px] font-semibold text-[#6b5b8a]";

type Confirming = null | "resign" | "abort";

export function RoomControls(props: Props) {
  const [confirm, setConfirm] = useState<Confirming>(null);
  return <RoomControlsView {...props} confirm={confirm} setConfirm={setConfirm} />;
}

/** The hook-free body, so a node test can walk its element tree and press
 *  its buttons (apps/web vitest has no DOM). */
export function RoomControlsView({
  ply,
  over,
  you,
  drawOfferBy,
  opponentName,
  busy,
  onAct,
  t,
  confirm,
  setConfirm,
}: Props & { confirm: Confirming; setConfirm: (c: Confirming) => void }) {
  if (over) return null;
  const early = ply < ABORTABLE_BELOW_PLY;
  const opponent = firstName(opponentName);
  const incoming = drawOfferBy !== null && drawOfferBy !== you;
  const mine = drawOfferBy === you;

  const resign = (
    <button type="button" data-testid="room-resign" className={DANGER} disabled={busy} onClick={() => setConfirm("resign")}>
      {t("externalPlay.room.resign")}
    </button>
  );

  return (
    <div className="flex min-w-0 flex-col gap-2 md:gap-3">
      {early ? (
        <div className="grid grid-cols-2 gap-2 md:grid-cols-1 md:gap-3">
          <button type="button" data-testid="room-draw" className={PARKED} disabled>
            {t("externalPlay.room.drawAfterMoveOne")}
          </button>
          <button type="button" data-testid="room-abort" className={SECONDARY} disabled={busy} onClick={() => setConfirm("abort")}>
            {t("externalPlay.room.abort")}
          </button>
        </div>
      ) : incoming ? (
        <>
          <section
            data-testid="room-draw-offer"
            aria-live="polite"
            className="flex flex-col gap-2.5 rounded-xl border border-[#c9bdf0] bg-[#f3effc] p-3"
          >
            <div className="flex flex-col gap-0.5">
              <span className="text-[15px] font-semibold">{t("externalPlay.room.drawOfferIncoming", { name: opponent })}</span>
              <span className="text-xs text-[#6b5b8a]">{t("externalPlay.room.drawOfferHint")}</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                data-testid="room-draw-decline"
                className={SECONDARY}
                disabled={busy}
                onClick={() => onAct({ kind: "draw", accept: false })}
              >
                {t("externalPlay.room.declineDraw")}
              </button>
              <button
                type="button"
                data-testid="room-draw-accept"
                className={PRIMARY}
                disabled={busy}
                onClick={() => onAct({ kind: "draw", accept: true })}
              >
                {t("externalPlay.room.acceptDraw")}
              </button>
            </div>
          </section>
          {resign}
        </>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-1 md:gap-3">
            {mine ? (
              <button type="button" data-testid="room-draw-offered" className={PARKED} disabled>
                {t("externalPlay.room.drawOffered")}
              </button>
            ) : (
              <button
                type="button"
                data-testid="room-draw"
                className={SECONDARY}
                disabled={busy}
                onClick={() => onAct({ kind: "draw", accept: true })}
              >
                {t("externalPlay.room.offerDraw")}
              </button>
            )}
            {resign}
          </div>
          {mine ? (
            <span className="text-xs text-[#6b5b8a]">{t("externalPlay.room.waitingForAnswer", { name: opponent })}</span>
          ) : null}
        </>
      )}
      <ConfirmDialog
        open={confirm !== null}
        testId={confirm === "abort" ? "room-abort-confirm" : "room-resign-confirm"}
        title={t(confirm === "abort" ? "externalPlay.room.abortConfirm.title" : "externalPlay.room.resignConfirm.title")}
        confirmLabel={t(confirm === "abort" ? "externalPlay.room.abortConfirm.confirm" : "externalPlay.room.resignConfirm.confirm")}
        cancelLabel={t("externalPlay.room.cancel")}
        confirmVariant="danger"
        busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const kind = confirm;
          setConfirm(null);
          if (kind) onAct({ kind });
        }}
      >
        {t(confirm === "abort" ? "externalPlay.room.abortConfirm.body" : "externalPlay.room.resignConfirm.body")}
      </ConfirmDialog>
    </div>
  );
}
