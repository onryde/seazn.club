"use client";

// The Online Chess receipt (spec 2026-11-23-online-chess-credits-design.md §8.4-§8.6; plan Task 12): what a payment, an upgrade or a move down
// will do, itemised in the `AiQuoteCard` shape (a receipt: rows, a right-hand amount column in tabular figures, one rule, a total), with the
// ONE button that does it.
//
// Three modes, one component: `pay` the stored size (the amber line, a checkout return), `payAndOpen` the same at the moment the organiser presses
// Open round 1 (decision 15: the size they CHOSE is preselected, the others listed with price and consequence), `change` a paid size (the chip,
// the select).
//
// WHAT IS ON SCREEN IS WHAT IS CONFIRMED. The state machine (`lib/online-receipt-state.ts`) keeps a quote only for the size and camera choice it
// was read for, so a new pick shows "Checking the price…" and never the old total; the button sends exactly the figure shown; a 409 redraws with the
// server's fresh quote and says so, and takes nothing until the organiser confirms the figure they now see; a short balance turns the
// button into Buy credits. Every figure is the server's (`quote.owed`, `take`, `back`) or the leaf's; this file prices nothing.
//
// A MODAL, not `useConfirm`: the confirm root sits outside the org's dictionary provider (English only, a static label), and this receipt carries a
// size list, a checkbox and a credits chooser, which the confirm body does not.
import { useEffect, useReducer, useRef, type ReactNode } from "react";
import { useLocaleOrDefault, useMsg, useMsgPlural } from "@/components/i18n/dict-provider";
import { Modal } from "@/components/modal";
import { includedRounds, type OnlineSize } from "@/lib/online-chess-package";
import { onlinePackageRefusalText, isOnlinePackageRefusalCode } from "@/lib/online-package-refusal";
import {
  confirmOf, expiryText, payFailureOf, receiptSizeRows, refusalCopyOf, smallestCoveringPack,
  type PayBody, type ReceiptMode, type ReceiptQuote, type ReceiptSizeRow,
} from "@/lib/online-receipt";
import {
  initialReceipt, pressBody, readOwed, receiptReducer, shownQuote, wantedOf, type ReceiptChoice,
} from "@/lib/online-receipt-state";
import type { StreamPackSize } from "@/lib/stream-credit-packs";
import type { ViewerPlan } from "@/lib/viewer-plan";

export interface ReceiptFacts {
  planCap: number | null;
  held: number;
  rounds: number;
  /** The division is priced with the Fair-play camera. */
  cameras: boolean;
  /** The paid package, when there is one. */
  paid: { size: OnlineSize; camerasPaid: boolean } | null;
  /** The size the row stores: the one an unpaid receipt calls "your choice". */
  storedSize: OnlineSize;
  viewerPlan: ViewerPlan;
}

export interface OnlineReceiptProps {
  mode: ReceiptMode;
  facts: ReceiptFacts;
  /** The size the receipt opens on; null opens a `change` receipt on its size list. */
  size: OnlineSize | null;
  /** A quote already in hand for `size` (the 402 an unpaid Open round answers): drawn at once, without a read. */
  quote: ReceiptQuote | null;
  /** The warning of an Open round press that nobody can be invited yet (no player has linked Lichess). Whoever reads the boards says so; nothing
   *  here reads them. (The other Open-round warning, that a bigger size promotes the waiting list into a round they miss, needs no input: it is
   *  said whenever the pay moves the size up, whether or not anyone waits.) */
  warnings?: { noInvitable?: boolean };
  /** The words of a refusal the ROUND itself named (Match Day: 409 changed, 402 frozen, 403 off), by the code the open answered with; null for a code it does
   *  not name. Drawn in place of the payment sentence (spec §8.5). The division page has no round in play and passes nothing. */
  failureWords?: (code: string) => string | null;
  /** Open with the camera box ticked (`change` over a package paid without cameras; ignored elsewhere): the return from buying credits for the camera. The
   *  caller names the paid size in `size`. */
  addCameras?: boolean;
  /** Reads the quote for a choice (`GET /divisions/{id}/online-package`). */
  readQuote: (choice: ReceiptChoice) => Promise<ReceiptQuote>;
  /** Does what the receipt shows. Throws what the pay door threw (`payFailureOf` reads it); resolving closes the receipt. */
  onConfirm: (body: PayBody) => Promise<void>;
  /** The credits chooser of a short balance, drawn in place of the receipt: the smallest covering pack is preselected by the caller. */
  renderBuy?: (a: { pack: StreamPackSize; size: OnlineSize; addCameras: boolean }) => ReactNode;
  onClose: () => void;
}

const ROW = "grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-0.5 py-1";

export function OnlineReceipt(props: OnlineReceiptProps): ReactNode {
  const { mode, facts, readQuote, onConfirm, renderBuy, onClose } = props;
  const msg = useMsg();
  const plural = useMsgPlural();
  const locale = useLocaleOrDefault();
  const [state, dispatch] = useReducer(receiptReducer, undefined, () =>
    initialReceipt({ mode, size: props.size, quote: props.quote, paidSize: facts.paid?.size ?? null, addCameras: props.addCameras === true && facts.paid !== null && !facts.paid.camerasPaid }),
  );
  /** A ref, so a second tap landing on one render's handler - before the first has re-rendered `submitting` - is refused too. */
  const pressing = useRef(false);
  /** The latest `readQuote`, read through a ref so a caller's fresh function every render cannot re-run the read below (it would fetch for ever:
   *  each answer re-renders, each render hands a new function). Refreshed after every committed render, as `Modal` does for its `onClose`. */
  const readRef = useRef(readQuote);
  useEffect(() => {
    readRef.current = readQuote;
  });

  // The quote this receipt owes the choice it shows: read it, once per choice. An answer for a choice that is no longer wanted is dropped by the
  // reducer; the flag here only stops a late answer from touching a closed receipt.
  const owedRead = readOwed(state);
  const readSize = owedRead?.size;
  const readCameras = owedRead?.addCameras;
  useEffect(() => {
    if (readSize === undefined || readCameras === undefined) return;
    const choice: ReceiptChoice = { size: readSize, addCameras: readCameras };
    let live = true;
    readRef.current(choice).then(
      (quote) => live && dispatch({ type: "read", choice, quote }),
      () => live && dispatch({ type: "readFailed", choice }),
    );
    return () => {
      live = false;
    };
  }, [readSize, readCameras]);

  const quote = shownQuote(state);
  const confirm = confirmOf(quote);
  const want = wantedOf(state);
  const readFailed = want !== null && quote === null && owedRead === null;
  const submitting = state.submitting;

  async function press(): Promise<void> {
    if (pressing.current) return;
    const body = pressBody(state);
    if (body === null) return;
    pressing.current = true;
    dispatch({ type: "submit" });
    try {
      await onConfirm(body);
      dispatch({ type: "settled", failure: null });
      onClose();
    } catch (err) {
      dispatch({ type: "settled", failure: payFailureOf(err) });
    } finally {
      pressing.current = false;
    }
  }

  const confirmText = ((): string => {
    switch (confirm.kind) {
      case "pay":
        return mode === "payAndOpen"
          ? plural("onlineChess.receipt.confirm.payOpen", confirm.credits, { count: confirm.credits })
          : plural("onlineChess.payLine.pay", confirm.credits, { count: confirm.credits });
      case "buy":
        return msg("onlineChess.receipt.confirm.buy");
      case "moveDown":
        return confirm.back > 0 ? plural("onlineChess.receipt.confirm.moveDown", confirm.back, { count: confirm.back }) : msg("onlineChess.receipt.confirm.moveDown.none");
      case "change":
        return msg("onlineChess.receipt.confirm.change");
      case "none":
        return confirm.why === "loading" && want !== null && !readFailed ? msg("onlineChess.receipt.confirm.checking") : msg("onlineChess.receipt.confirm.choose");
    }
  })();

  const title = ((): string => {
    if (mode === "pay") return msg("onlineChess.receipt.title.pay");
    if (mode === "payAndOpen") return msg("onlineChess.receipt.title.payAndOpen");
    // The camera of a paid package is a payment AT the paid size, not a move to it (R6): "Move up to 64 players" over a 64 package would be wrong.
    if (quote !== null && quote.refusal === null && facts.paid !== null && quote.size === facts.paid.size) return msg("onlineChess.receipt.title.cameras");
    if (quote !== null && quote.refusal === null && quote.owed < 0) return msg("onlineChess.receipt.title.down", { size: quote.size });
    if (quote !== null && quote.refusal === null && quote.owed > 0) return msg("onlineChess.receipt.title.up", { size: quote.size });
    return msg("onlineChess.receipt.title.change");
  })();

  const listed = mode === "payAndOpen" || mode === "change";
  const rows = listed
    ? receiptSizeRows({
        mode,
        reference: mode === "change" ? (facts.paid?.size ?? facts.storedSize) : facts.storedSize,
        planCap: facts.planCap,
        held: facts.held,
        rounds: facts.rounds,
        cameras: facts.cameras || state.addCameras,
        paid: facts.paid,
      })
    : [];
  const canAddCameras = mode === "change" && facts.paid !== null && !facts.paid.camerasPaid;

  // ---- the credits chooser of a short balance -------------------------------------------------------------------------------------------
  if (state.view === "buy" && confirm.kind === "buy" && renderBuy !== undefined) {
    return (
      <Modal
        title={msg("onlineChess.receipt.confirm.buy")}
        onClose={onClose}
        closeLabel={msg("stream.credits.close")}
        footer={
          <button type="button" className="btn btn-ghost min-h-11" onClick={() => dispatch({ type: "back" })} data-testid="online-receipt-back">
            {msg("onlineChess.receipt.buy.back")}
          </button>
        }
      >
        <div className="space-y-3" data-testid="online-receipt" data-mode={mode} data-view="buy">
          <p className="text-slate-700">{plural("onlineChess.receipt.buy.line", confirm.shortBy, { count: confirm.shortBy })}</p>
          {renderBuy({ pack: confirm.pack, size: state.size ?? facts.storedSize, addCameras: state.addCameras })}
        </div>
      </Modal>
    );
  }

  const failureText = ((): string | null => {
    if (state.failed === null) return null;
    if (isOnlinePackageRefusalCode(state.failed)) return onlinePackageRefusalText({ code: state.failed }, (key, vars) => msg(key as never, vars)) ?? msg("onlineChess.receipt.err.generic");
    // No answer at all (offline, a proxy page, a dropped connection: `payFailureOf` reads it as UNKNOWN): the press may have reached the server, so "nothing
    // was taken" is not ours to say - say we could not confirm, and where to look. Every other code is an ANSWER, and an answered "no" took nothing.
    if (state.failed === "UNKNOWN") return msg("onlineChess.receipt.err.unknown");
    return props.failureWords?.(state.failed) ?? msg("onlineChess.receipt.err.generic");
  })();

  return (
    <Modal
      title={title}
      onClose={submitting ? () => {} : onClose}
      closeLabel={msg("stream.credits.close")}
      footer={
        <>
          <button type="button" className="btn btn-ghost min-h-11" onClick={onClose} disabled={submitting} data-testid="online-receipt-cancel">
            {msg("confirm.cancel")}
          </button>
          <button
            type="button"
            className="btn btn-primary min-h-11"
            disabled={submitting || (confirm.kind === "none")}
            data-testid="online-receipt-confirm"
            data-confirm={confirm.kind}
            onClick={() => (confirm.kind === "buy" ? dispatch({ type: "buy" }) : void press())}
          >
            {confirmText}
          </button>
        </>
      }
    >
      <div className="space-y-3" data-testid="online-receipt" data-mode={mode} data-size={want === null ? "none" : String(want.size)} data-confirm={confirm.kind} data-view="receipt">
        {listed && rows.length > 0 && (
          <fieldset className="grid gap-1.5 border-0 p-0" data-testid="online-receipt-sizes">
            <legend className="mb-1 text-xs font-medium text-slate-700">{msg("onlineChess.receipt.size.legend")}</legend>
            {rows.map((row) => (
              <SizeRow
                key={row.size}
                row={row}
                mode={mode}
                checked={state.size === row.size}
                disabled={submitting}
                held={facts.held}
                rounds={facts.rounds}
                viewerPlan={facts.viewerPlan}
                onPick={() => dispatch({ type: "pick", size: row.size })}
              />
            ))}
          </fieldset>
        )}

        {canAddCameras && (
          <label className="flex min-h-11 items-center gap-2 text-sm text-slate-800">
            <input
              type="checkbox"
              checked={state.addCameras}
              disabled={submitting}
              onChange={(e) => dispatch({ type: "cameras", on: e.target.checked })}
              className="h-4 w-4"
              data-testid="online-receipt-cameras"
            />
            {msg("onlineChess.receipt.cameras.add")}
          </label>
        )}

        {quote !== null && quote.refusal === null && confirm.kind !== "none" && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2" data-testid="online-receipt-rows">
            <div className={ROW}>
              <span className="font-medium text-slate-900">{msg("onlineChess.receipt.row.name")}</span>
              <span />
            </div>
            <p className="pb-1 text-xs text-slate-700">{msg("onlineChess.receipt.row.size", { size: quote.size, rounds: includedRounds(quote.size) })}</p>
            {quote.cameras && (
              <div className={ROW} data-testid="online-receipt-row-cameras">
                <span>{msg("onlineChess.receipt.row.cameras")}</span>
                <span className="text-right text-slate-800">{msg("onlineChess.receipt.row.cameras.on")}</span>
              </div>
            )}
            <div className="my-1 border-t border-slate-200" />
            {(confirm.kind === "pay" || confirm.kind === "buy") && (
              <>
                {confirm.kind === "pay" && quote.take !== null && quote.take.monthly > 0 && (
                  <div className={ROW} data-testid="online-receipt-row-monthly">
                    <span>
                      {msg("onlineChess.receipt.row.monthly")}{" "}
                      <span className="text-xs text-slate-600">{msg("onlineChess.receipt.row.expires", { date: expiryText(quote.monthlyExpiresOn, locale) })}</span>
                    </span>
                    <span className="text-right tabular-nums text-slate-800">{quote.take.monthly}</span>
                  </div>
                )}
                {confirm.kind === "pay" && quote.take !== null && quote.take.pack > 0 && (
                  <div className={ROW} data-testid="online-receipt-row-bought">
                    <span>{msg("onlineChess.receipt.row.bought")}</span>
                    <span className="text-right tabular-nums text-slate-800">{quote.take.pack}</span>
                  </div>
                )}
                <div className={`${ROW} font-semibold text-purple-800`} data-testid="online-receipt-row-total">
                  <span>{msg("onlineChess.receipt.row.total")}</span>
                  <span className="text-right tabular-nums">{plural("onlineChess.receipt.credits", quote.owed, { count: quote.owed })}</span>
                </div>
              </>
            )}
            {confirm.kind === "moveDown" && quote.back !== null && (
              <>
                <div className={ROW} data-testid="online-receipt-row-back-bought">
                  <span>{msg("onlineChess.receipt.row.backBought")}</span>
                  <span className="text-right tabular-nums text-slate-800">{quote.back.pack}</span>
                </div>
                <div className={ROW} data-testid="online-receipt-row-back-monthly">
                  <span>
                    {msg("onlineChess.receipt.row.backMonthly")}{" "}
                    <span className="text-xs text-slate-600">{msg("onlineChess.receipt.row.expires", { date: expiryText(quote.monthlyExpiresOn, locale) })}</span>
                  </span>
                  <span className="text-right tabular-nums text-slate-800">{quote.back.monthly}</span>
                </div>
                <div className={ROW} data-testid="online-receipt-row-not-returned">
                  <span>{msg("onlineChess.receipt.row.notReturned")}</span>
                  <span className="text-right tabular-nums text-slate-800">{quote.back.forfeited}</span>
                </div>
                {quote.back.forfeited > 0 && (
                  <p className="pb-1 text-xs text-amber-800" data-testid="online-receipt-not-returned-why">
                    {plural("onlineChess.receipt.notReturned.why", quote.back.forfeited, { count: quote.back.forfeited })}
                  </p>
                )}
              </>
            )}
            {confirm.kind === "change" && <p className="py-1 text-slate-800">{msg("onlineChess.receipt.line.noMoney")}</p>}
          </div>
        )}

        {/* The state of the read, in words: never a blank receipt. */}
        <div role="status" aria-live="polite" className="space-y-2">
          {state.changed && (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-amber-900" data-testid="online-receipt-changed">
              {msg("onlineChess.receipt.changed")}
            </p>
          )}
          {want !== null && quote === null && !readFailed && <p className="text-slate-600" data-testid="online-receipt-checking">{msg("onlineChess.receipt.checking")}</p>}
          {readFailed && <p className="text-red-700" data-testid="online-receipt-unclear">{msg("onlineChess.receipt.unclear")}</p>}
          {quote !== null && confirm.kind === "none" && confirm.why === "inconsistent" && (
            <p className="text-red-700" data-testid="online-receipt-unclear">{msg("onlineChess.receipt.unclear")}</p>
          )}
          {quote !== null && quote.refusal !== null && (
            <p className="text-amber-800" data-testid="online-receipt-refused" data-refusal={quote.refusal}>
              {(() => {
                const r = refusalCopyOf({ ...quote, refusal: quote.refusal });
                return msg(r.key, r.vars);
              })()}
            </p>
          )}
          {confirm.kind === "buy" && (
            <p className="text-slate-800" data-testid="online-receipt-short" data-pack={smallestCoveringPack(confirm.shortBy)}>
              {plural("onlineChess.receipt.short", confirm.shortBy, { owed: confirm.owed, balance: confirm.balance, count: confirm.shortBy })}
            </p>
          )}
          {failureText !== null && <p className="text-red-700" data-testid="online-receipt-error" data-code={state.failed ?? undefined}>{failureText}</p>}
        </div>

        {mode === "payAndOpen" && props.warnings?.noInvitable === true && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="online-receipt-no-invitable">{msg("onlineChess.receipt.noInvitable")}</p>
        )}
        {mode === "payAndOpen" && quote !== null && quote.refusal === null && quote.size > facts.storedSize && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="online-receipt-late-entrants">{msg("onlineChess.receipt.lateEntrants")}</p>
        )}

        {/* The facts that are always true, said once. */}
        <div className="space-y-0.5 text-xs text-slate-600">
          {confirm.kind !== "moveDown" && <p>{msg("onlineChess.receipt.line.included")}</p>}
          <p>{mode === "payAndOpen" ? msg("onlineChess.receipt.line.fixed") : msg("onlineChess.receipt.line.moveUp")}</p>
        </div>
      </div>
    </Modal>
  );
}

/** One size in the receipt's list: a radio, its size and rounds, what it costs (a price on an unpaid row, a difference on a paid one) and the
 *  reason it is greyed or what choosing it means (a smaller size that fits shows where late entry would stop). */
function SizeRow(p: {
  row: ReceiptSizeRow;
  mode: ReceiptMode;
  checked: boolean;
  disabled: boolean;
  held: number;
  rounds: number;
  viewerPlan: ViewerPlan;
  onPick: () => void;
}): ReactNode {
  const msg = useMsg();
  const plural = useMsgPlural();
  const { row } = p;
  const off = row.disabled !== null;
  const right =
    p.mode === "change" && row.diff !== null
      ? row.diff === 0
        ? msg("onlineChess.size.note.paid")
        : row.diff > 0
          ? plural("onlineChess.size.note.pay", row.diff, { count: row.diff })
          : plural("onlineChess.size.note.back", -row.diff, { count: -row.diff })
      : plural("onlineChess.receipt.size.price", row.price, { count: row.price });
  const why = ((): string | null => {
    if (row.disabled === "held") return msg("onlineChess.size.note.held", { held: p.held });
    if (row.disabled === "plan") return msg("onlineChess.size.note.plan", { plan: msg(`onlineChess.size.plan.${p.viewerPlan}` as Parameters<typeof msg>[0]) });
    if (row.disabled === "rounds") return msg("onlineChess.size.note.rounds", { rounds: p.rounds });
    if (row.consequence !== null) {
      return row.consequence.held > 0
        ? plural("onlineChess.receipt.size.consequence", row.consequence.held, { held: row.consequence.held, size: row.consequence.size })
        : msg("onlineChess.receipt.size.consequence.none", { size: row.consequence.size });
    }
    return null;
  })();
  return (
    <label
      className={`flex min-h-11 min-w-0 cursor-pointer items-start gap-2 rounded-md border px-3 py-2 ${p.checked ? "border-purple-500 bg-purple-50" : "border-slate-200 bg-white"} ${off ? "cursor-not-allowed opacity-60" : ""}`}
    >
      <input
        type="radio"
        name="online-receipt-size"
        value={row.size}
        checked={p.checked}
        disabled={off || p.disabled}
        onChange={p.onPick}
        className="mt-1 h-4 w-4 shrink-0"
        data-testid={`online-receipt-size-${row.size}`}
      />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3">
          <span className="min-w-0 font-medium text-slate-900 [overflow-wrap:anywhere]">{msg("onlineChess.size.option", { size: row.size, rounds: row.rounds })}</span>
          <span className="shrink-0 text-xs tabular-nums text-slate-700">{right}</span>
        </span>
        {row.reference && p.mode === "payAndOpen" && <span className="block text-xs text-purple-700">{msg("onlineChess.receipt.size.yours")}</span>}
        {why !== null && <span className="block text-xs text-slate-600 [overflow-wrap:anywhere]" data-testid={`online-receipt-size-${row.size}-why`}>{why}</span>}
      </span>
    </label>
  );
}
