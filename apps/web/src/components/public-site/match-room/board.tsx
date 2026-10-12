"use client";
// Our thin wrapper over chessground (design §2, §3.4 step 1). chessground is
// reached ONLY through the licence loader (board-loader.ts) and only on the
// client: room-shell mounts this file with `dynamic(..., { ssr: false })`.
//
// The board never talks to Lichess. A finished drag or tap becomes a UCI
// string handed to `onMove`; the shell posts it to OUR server, which forwards
// it with the player's own token (T10). Legal destinations come from chess.js
// (BSD-2) as hints only — Lichess stays the authority, and a refused move is
// put back by the shell bumping `syncKey` (a move in flight is left where the
// player put it). A promotion is never guessed: our
// own promotion module decides when the picker opens, and the move is sent
// only with the piece chosen (the server refuses a suffixless promotion).
import "./board-theme.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { Chess } from "chess.js";
import { loadBoard, type BoardModule } from "./board-loader";
import { needsPromotion, type PromotionPiece } from "./promotion";
import { PromotionPicker } from "./promotion-picker";
import type { Colour } from "./room-snapshot";
import type { RoomT } from "./room-copy";

type CgApi = ReturnType<BoardModule["Chessground"]>;
type CgConfig = NonNullable<Parameters<BoardModule["Chessground"]>[1]>;
type CgKey = NonNullable<CgConfig["lastMove"]>[number];

export type BoardProps = {
  fen: string;
  orientation: Colour;
  lastMove: [string, string] | null;
  /** May the viewer move now: their turn, the game live, nothing pending. */
  movable: boolean;
  /** Bumped by the shell to put the board back on `fen` (a refused move). */
  syncKey: number;
  onMove: (uci: string) => void;
  label: string;
  t: RoomT;
};

/** chess.js's legal moves as chessground's destination map. */
export function legalDests(fen: string): Map<CgKey, CgKey[]> {
  const dests = new Map<CgKey, CgKey[]>();
  let game: Chess;
  try {
    game = new Chess(fen);
  } catch {
    return dests;
  }
  for (const m of game.moves({ verbose: true })) {
    const from = m.from as CgKey;
    const list = dests.get(from) ?? [];
    if (!list.includes(m.to as CgKey)) list.push(m.to as CgKey);
    dests.set(from, list);
  }
  return dests;
}

function sideToMove(fen: string): Colour {
  return fen.split(" ")[1] === "b" ? "black" : "white";
}

function inCheck(fen: string): boolean {
  try {
    return new Chess(fen).inCheck();
  } catch {
    return false;
  }
}

export default function Board({ fen, orientation, lastMove, movable, syncKey, onMove, label, t }: BoardProps) {
  const el = useRef<HTMLDivElement>(null);
  const api = useRef<CgApi | null>(null);
  const [promo, setPromo] = useState<null | { from: string; to: string }>(null);
  const onMoveRef = useRef(onMove);
  const fenRef = useRef(fen);

  const turn = sideToMove(fen);
  const check = useMemo(() => inCheck(fen), [fen]);
  // Two halves, applied apart. The POSITION puts pieces on squares: it is
  // re-applied only when the ledger's position changes or the shell bumps
  // `syncKey`. INTERACTION is who may move and where: it changes on its own
  // around every move sent (`movable` is false while the act is pending), and
  // must not drag the position with it — re-applying the position then would
  // snap the player's moved piece back for the whole round trip to Lichess
  // and bring it forward again on the next read (found by the room e2e).
  // A last move arrives as a fresh tuple on every read: keyed by value.
  const lastMoveKey = lastMove ? `${lastMove[0]}${lastMove[1]}` : "";
  const position: CgConfig = useMemo(
    () => ({
      fen,
      orientation,
      turnColor: turn,
      check: check ? turn : false,
      lastMove: lastMoveKey ? ([lastMoveKey.slice(0, 2), lastMoveKey.slice(2, 4)] as CgKey[]) : undefined,
    }),
    [fen, orientation, turn, check, lastMoveKey],
  );
  const interaction: CgConfig = useMemo(
    () => ({
      movable: {
        free: false,
        color: movable ? orientation : undefined,
        dests: movable ? legalDests(fen) : new Map(),
        showDests: true,
      },
      draggable: { enabled: movable, showGhost: true },
    }),
    [fen, orientation, movable],
  );
  const config: CgConfig = useMemo(
    () => ({
      ...position,
      ...interaction,
      coordinates: true,
      viewOnly: false,
      highlight: { lastMove: true, check: true },
      animation: { enabled: true, duration: 150 },
      premovable: { enabled: false },
      selectable: { enabled: true },
      drawable: { enabled: false },
    }),
    [position, interaction],
  );
  // The latest props, for the board built after the loader resolves: a
  // snapshot that lands while chessground is still loading must not be lost
  // to the first render's closure (the effect below runs before the board
  // exists, so it cannot re-apply it).
  const configRef = useRef(config);
  useEffect(() => {
    onMoveRef.current = onMove;
    fenRef.current = fen;
    configRef.current = config;
  });

  // Construct once; destroy on unmount.
  useEffect(() => {
    let cancelled = false;
    let observer: ResizeObserver | null = null;
    void loadBoard().then(({ Chessground }) => {
      if (cancelled || !el.current) return;
      api.current = Chessground(el.current, {
        ...configRef.current,
        events: {
          move: (orig, dest) => {
            if (needsPromotion(fenRef.current, orig, dest)) {
              setPromo({ from: orig, to: dest });
              return;
            }
            onMoveRef.current(`${orig}${dest}`);
          },
        },
      });
      // The canvas sizes the coordinates to the square: 20% of it, 9–14px.
      const sizeCoords = () => {
        const w = el.current?.getBoundingClientRect().width ?? 0;
        el.current?.parentElement?.style.setProperty(
          "--seazn-coord-px",
          `${Math.min(14, Math.max(9, Math.round((w / 8) * 0.2)))}px`,
        );
      };
      sizeCoords();
      observer = new ResizeObserver(() => {
        sizeCoords();
        api.current?.redrawAll();
      });
      observer.observe(el.current);
    });
    return () => {
      cancelled = true;
      observer?.disconnect();
      api.current?.destroy();
      api.current = null;
    };
    // Constructed once, from refs; later props flow through api.set below.
  }, []);

  // A new position, or a syncKey bump (a refused or failed move), puts the
  // pieces back on the ledger's squares. Declared before the interaction
  // effect, so a refusal resets the pieces before the dests are recomputed.
  useEffect(() => {
    api.current?.set(position);
  }, [position, syncKey]);

  // Who may move, and where — never the pieces.
  useEffect(() => {
    api.current?.set(interaction);
  }, [interaction]);

  const finishPromotion = (piece: PromotionPiece | null) => {
    const p = promo;
    setPromo(null);
    if (!p) return;
    if (piece === null) {
      // "Cancel — put the pawn back", and give the move back: chessground
      // cleared the destinations and passed the turn when the pawn moved, and
      // nothing was sent, so no prop changes to restore them.
      api.current?.set(config);
      return;
    }
    onMoveRef.current(`${p.from}${p.to}${piece}`);
  };

  return (
    <>
      <div
        data-testid="room-board-surface"
        data-fen={fen}
        role="img"
        aria-label={label}
        className="seazn-board relative aspect-square w-full"
      >
        <div ref={el} className="cg-wrap absolute inset-0" />
      </div>
      {promo ? (
        <PromotionPicker
          square={promo.to}
          colour={orientation}
          onPick={(p) => finishPromotion(p)}
          onCancel={() => finishPromotion(null)}
          t={t}
        />
      ) : null}
    </>
  );
}
