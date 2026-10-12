"use client";
// Promotion, option B of the owner-approved canvas: a bottom sheet "Promote
// your pawn on d8" with four 72px choices (Queen pre-selected in style) and
// "Cancel — put the pawn back". chessground ships no promotion UI (design §2);
// the server refuses a suffixless promotion, so the board waits for this.
// The piece faces are chessground's own cburnett set, styled by its stylesheet
// — this file is reached only from board.tsx, inside the board's chunk.
import { PROMOTION_PIECES, type PromotionPiece } from "./promotion";
import type { Colour } from "./room-snapshot";
import type { RoomT } from "./room-copy";

const ROLE: Record<PromotionPiece, string> = { q: "queen", r: "rook", b: "bishop", n: "knight" };
const SIDE: Record<Colour, string> = { white: "white", black: "black" };

/** chessground's own `<piece>` element, so its stylesheet draws the face. Not
 *  JSX: React warns on an unknown lowercase tag (a console error on every
 *  open, found by the room e2e). Built only from the two closed tables above
 *  — a value outside them is refused, never interpolated. */
function pieceHtml(p: PromotionPiece, colour: Colour): string {
  const role = ROLE[p];
  const side = SIDE[colour];
  if (role === undefined || side === undefined) throw new Error(`promotion picker: no piece face for ${String(p)}/${String(colour)}`);
  return `<piece class="${role} ${side}"></piece>`;
}
const LABEL = {
  q: "externalPlay.room.promote.q",
  r: "externalPlay.room.promote.r",
  b: "externalPlay.room.promote.b",
  n: "externalPlay.room.promote.n",
} as const;

export function PromotionPicker({
  square,
  colour,
  onPick,
  onCancel,
  t,
}: {
  square: string;
  colour: Colour;
  onPick: (piece: PromotionPiece) => void;
  onCancel: () => void;
  t: RoomT;
}) {
  return (
    <div data-testid="room-promotion" className="fixed inset-0 z-50">
      <div aria-hidden className="absolute inset-0 bg-[rgba(27,18,48,0.45)]" onClick={onCancel} />
      <section
        role="dialog"
        aria-modal="true"
        aria-label={t("externalPlay.room.promote.title", { square })}
        className="absolute inset-x-0 bottom-0 mx-auto flex max-w-lg flex-col gap-3 rounded-t-2xl bg-white px-4 pb-5 pt-4 text-[#2e1065] shadow-[0_-8px_24px_rgba(27,18,48,0.18)]"
      >
        <span aria-hidden className="h-1 w-9 self-center rounded-sm bg-[#d8d0ee]" />
        <h2 className="m-0 text-base font-semibold">{t("externalPlay.room.promote.title", { square })}</h2>
        <div className="grid grid-cols-4 gap-2">
          {PROMOTION_PIECES.map((p) => (
            <button
              key={p}
              type="button"
              data-testid={`room-promote-${p}`}
              autoFocus={p === "q"}
              onClick={() => onPick(p)}
              className={`flex min-h-[72px] flex-col items-center justify-center gap-0.5 rounded-xl ${
                p === "q" ? "border-2 border-[#7c3aed] bg-[#f3effc]" : "border border-[#e7e3f3] bg-white"
              }`}
            >
              <span
                aria-hidden
                className="seazn-promo-piece cg-wrap h-10 w-10"
                dangerouslySetInnerHTML={{ __html: pieceHtml(p, colour) }}
              />
              <span className="text-xs font-semibold">{t(LABEL[p])}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          data-testid="room-promote-cancel"
          onClick={onCancel}
          className="min-h-11 rounded-[10px] border-0 bg-transparent text-[15px] font-semibold text-[#5b21b6]"
        >
          {t("externalPlay.room.promote.cancel")}
        </button>
      </section>
    </div>
  );
}
