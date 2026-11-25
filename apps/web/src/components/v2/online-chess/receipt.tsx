"use client";

// The Online Chess receipt (spec 2026-11-23-online-chess-credits-design.md §8.4-§8.6; plan Task 12): what a payment, an upgrade or a move down
// will do, itemised in the `AiQuoteCard` shape (a receipt: rows, a right-hand amount column in tabular figures, one rule, a total), with the
// ONE button that does it.
//
// Three modes, one component: `pay` the stored size (the amber line, a checkout return), `payAndOpen` the same at the moment the organiser presses
// Open round 1 (decision 15: the size they CHOSE is preselected, the others listed with price and consequence), `change` a paid size (the chip,
// the select).
//
// EVERY receipt asks "Fair-play camera: Yes / No" (Task 15, owner 2026-11-25), opening at the division's camera setting (`pay`, `payAndOpen`) or the
// paid package's (`change`): the total follows the answer, and paying writes it to the division's "Camera during online play" setting in the same
// transaction. Once a round has opened the server refuses any change (`frozen`): the answer is then shown and cannot be picked, like the size.
//
// WHAT IS ON SCREEN IS WHAT IS CONFIRMED. The state machine (`lib/online-receipt-state.ts`) keeps a quote only for the size and camera choice it
// was read for, so a new pick shows "Checking the price…" and never the old total; the button sends exactly the figure shown; a 409 redraws with the
// server's fresh quote and says so, and takes nothing until the organiser confirms the figure they now see; a short balance turns the
// button into Buy credits. Every figure is the server's (`quote.owed`, `take`, `back`) or the leaf's; this file prices nothing.
//
// A MODAL, not `useConfirm`: the confirm root sits outside the org's dictionary provider (English only, a static label), and this receipt carries a
// size list, a camera choice and a credits chooser, which the confirm body does not.
import { useEffect, useReducer, useRef, type ReactNode } from "react";
import { Video, VideoOff } from "lucide-react";
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
  /** The division's camera setting says the Fair-play camera is on (P9): what EVERY receipt's camera answer opens at (fix I2). */
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
  /** The camera answer to open at instead of the default (the division's setting, in every mode): the answer a checkout return carried back from
   *  buying credits. */
  cameras?: boolean;
  /** Reads the quote for a choice (`GET /divisions/{id}/online-package`). */
  readQuote: (choice: ReceiptChoice) => Promise<ReceiptQuote>;
  /** Does what the receipt shows. Throws what the pay door threw (`payFailureOf` reads it); resolving closes the receipt. */
  onConfirm: (body: PayBody) => Promise<void>;
  /** The credits chooser of a short balance, drawn in place of the receipt: the smallest covering pack is preselected by the caller. */
  renderBuy?: (a: { pack: StreamPackSize; size: OnlineSize; cameras: boolean }) => ReactNode;
  onClose: () => void;
}

const ROW = "grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-0.5 py-1";

export function OnlineReceipt(props: OnlineReceiptProps): ReactNode {
  const { mode, facts, readQuote, onConfirm, renderBuy, onClose } = props;
  const msg = useMsg();
  const plural = useMsgPlural();
  const locale = useLocaleOrDefault();
  const [state, dispatch] = useReducer(receiptReducer, undefined, () =>
    initialReceipt({
      mode,
      size: props.size,
      quote: props.quote,
      paid: facts.paid,
      // Every mode opens at the division's SETTING, a change included (fix I2): a change opened at what was paid re-charged a camera turned
      // off in Division settings, and re-wrote Required, on a confirm that only meant to resize. A change still quotes against what was paid (R6).
      cameras: props.cameras ?? facts.cameras,
      // The setting itself, so a change at the paid size knows an answer the setting does not say is still a change (fix round 3).
      setting: facts.cameras,
    }),
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
  const readCameras = owedRead?.cameras;
  useEffect(() => {
    if (readSize === undefined || readCameras === undefined) return;
    const choice: ReceiptChoice = { size: readSize, cameras: readCameras };
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

  // A `change` whose size is the paid one: only the camera answer moves (R6).
  const cameraOnly = mode === "change" && quote !== null && quote.refusal === null && facts.paid !== null && quote.size === facts.paid.size;

  const confirmText = ((): string => {
    switch (confirm.kind) {
      case "pay":
        return mode === "payAndOpen"
          ? plural("onlineChess.receipt.confirm.payOpen", confirm.credits, { count: confirm.credits })
          : plural("onlineChess.payLine.pay", confirm.credits, { count: confirm.credits });
      case "buy":
        return msg("onlineChess.receipt.confirm.buy");
      case "moveDown":
        // The camera turned off at the paid size is not a move to another size: its own words (the same credits back).
        if (cameraOnly) {
          return confirm.back > 0 ? plural("onlineChess.receipt.confirm.camerasOff", confirm.back, { count: confirm.back }) : msg("onlineChess.receipt.confirm.camerasOff.none");
        }
        return confirm.back > 0 ? plural("onlineChess.receipt.confirm.moveDown", confirm.back, { count: confirm.back }) : msg("onlineChess.receipt.confirm.moveDown.none");
      case "change":
        // 0 owed at the paid size is the paid answer written back over a setting that says the other (fix round 3): its own words.
        if (cameraOnly && quote !== null) return quote.cameras ? msg("onlineChess.receipt.confirm.camerasOn") : msg("onlineChess.receipt.confirm.camerasOff.none");
        return msg("onlineChess.receipt.confirm.change");
      case "none":
        return confirm.why === "loading" && want !== null && !readFailed ? msg("onlineChess.receipt.confirm.checking") : msg("onlineChess.receipt.confirm.choose");
    }
  })();

  const title = ((): string => {
    if (mode === "pay") return msg("onlineChess.receipt.title.pay");
    if (mode === "payAndOpen") return msg("onlineChess.receipt.title.payAndOpen");
    // The camera of a paid package is changed AT the paid size, not by a move to it (R6): "Move up to 64 players" over a 64 package would be wrong.
    if (cameraOnly && quote !== null) return quote.cameras ? msg("onlineChess.receipt.title.cameras") : msg("onlineChess.receipt.title.camerasOff");
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
        cameras: state.cameras,
        paid: facts.paid,
      })
    : [];
  // From round 1 the camera is fixed, like the size (spec 8.7): the server's `frozen` refusal shows the answer and takes no pick.
  const cameraFixed = state.quote !== null && state.quote.refusal === "frozen";

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
          {renderBuy({ pack: confirm.pack, size: want?.size ?? facts.storedSize, cameras: state.cameras })}
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
        <CameraChoice
          on={state.cameras}
          // Only while the Yes can be confirmed (fix round 3 m1): a note over a "Choose a size" button promised a write that no press makes.
          turnsOn={state.cameras && !facts.cameras && want !== null}
          disabled={submitting || cameraFixed}
          onPick={(on) => dispatch({ type: "cameras", on })}
        />

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

        {quote !== null && quote.refusal === null && confirm.kind !== "none" && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2" data-testid="online-receipt-rows">
            <div className={ROW}>
              <span className="font-medium text-slate-900">{msg("onlineChess.receipt.row.name")}</span>
              <span />
            </div>
            <p className="pb-1 text-xs text-slate-700">{msg("onlineChess.receipt.row.size", { size: quote.size, rounds: includedRounds(quote.size) })}</p>
            <div className={ROW} data-testid="online-receipt-row-cameras" data-cameras={quote.cameras ? "on" : "off"}>
              <span>{msg("onlineChess.receipt.row.cameras")}</span>
              <span className="text-right text-slate-800">{quote.cameras ? msg("onlineChess.receipt.row.cameras.on") : msg("onlineChess.receipt.row.cameras.off")}</span>
            </div>
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

/** The receipt's Fair-play camera answer: Yes or No, as a two-segment control in the house's segmented shape (`VisibilitySegmented`): a fieldset over two
 *  native radios of one name, each WRAPPED by its segment (visually hidden, still focusable: a click on the segment picks it, arrow keys walk the pair).
 *  Phone: the legend above, the two segments full width; from `sm`: the legend left, the segments right, on one line. `turnsOn`: the answer is Yes over a
 *  setting that is off, so paying writes Required (P19) - said below the pair, before the confirm (fix m4), and named by the fieldset; a division already
 *  on keeps the setting it has (it may be Optional), so nothing is said for it. The caller passes it only while the Yes is confirmable (fix round 3). */
function CameraChoice(p: { on: boolean; turnsOn: boolean; disabled: boolean; onPick: (on: boolean) => void }): ReactNode {
  const msg = useMsg();
  // A fixed id: the receipt is one dialog, mounted once per page.
  const noteId = "online-receipt-cameras-note";
  const options = [
    { on: true, label: msg("onlineChess.receipt.cameras.yes"), Icon: Video, testid: "online-receipt-cameras-yes" },
    { on: false, label: msg("onlineChess.receipt.cameras.no"), Icon: VideoOff, testid: "online-receipt-cameras-no" },
  ] as const;
  return (
    // min-w-0 + min-inline-size 0: a fieldset's UA default is min-content, which bursts a narrow sheet instead of shrinking.
    <fieldset
      className="grid min-w-0 gap-1.5 border-0 p-0 [min-inline-size:0] sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-3"
      data-testid="online-receipt-cameras"
      data-cameras={p.on ? "yes" : "no"}
      disabled={p.disabled}
      aria-describedby={p.turnsOn ? noteId : undefined}
    >
      <legend className="float-left mb-1 text-xs font-medium text-slate-700 sm:mb-0 sm:text-sm sm:font-normal sm:text-slate-800">
        {msg("onlineChess.receipt.row.cameras")}
      </legend>
      <div className="grid grid-cols-2 gap-0.5 rounded-xl border border-purple-200 bg-purple-50 p-[3px] sm:w-44">
        {options.map((o) => {
          const active = o.on === p.on;
          return (
            <label
              key={String(o.on)}
              className={`relative flex min-h-11 min-w-0 items-center justify-center gap-1.5 rounded-[7px] px-2 text-sm font-medium transition has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-purple-600 ${
                active ? "bg-purple-600 text-white shadow-sm" : p.disabled ? "text-slate-500" : "text-slate-700 hover:bg-white hover:text-purple-700"
              } ${p.disabled ? "cursor-not-allowed opacity-70" : "cursor-pointer"}`}
            >
              <input
                type="radio"
                name="online-receipt-cameras"
                value={o.on ? "yes" : "no"}
                checked={active}
                disabled={p.disabled}
                onChange={() => p.onPick(o.on)}
                className="sr-only"
                data-testid={o.testid}
              />
              <o.Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0 truncate">{o.label}</span>
            </label>
          );
        })}
      </div>
      {p.turnsOn && (
        <p id={noteId} className="text-xs text-slate-600 sm:col-span-2" data-testid="online-receipt-cameras-note">
          {msg("onlineChess.receipt.cameras.yesNote")}
        </p>
      )}
    </fieldset>
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
        ? // The paid size is not in a change receipt's list, so a row that nets nothing is ANOTHER size at the same price (No over a paid
          // camera makes one: 128 without it costs what 64 with it did) - never "paid".
          msg("onlineChess.receipt.size.even")
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
          <span className="shrink-0 text-xs tabular-nums text-slate-700" data-testid={`online-receipt-size-${row.size}-note`}>{right}</span>
        </span>
        {row.reference && p.mode === "payAndOpen" && <span className="block text-xs text-purple-700">{msg("onlineChess.receipt.size.yours")}</span>}
        {why !== null && <span className="block text-xs text-slate-600 [overflow-wrap:anywhere]" data-testid={`online-receipt-size-${row.size}-why`}>{why}</span>}
      </span>
    </label>
  );
}
