"use client";
// Our thin wrapper over chessground (design §2, §3.4 step 1). chessground is
// reached ONLY through the licence loader (board-loader.ts) and only on the
// client: room-shell mounts this file with `dynamic(..., { ssr: false })`.
//
// The board never talks to Lichess. A finished drag or tap becomes a UCI
// string handed to `onMove`; the shell posts it to OUR server, which forwards
// it with the player's own token (T10). Legal destinations come from chess.js
// (BSD-2) as hints only — Lichess stays the authority, and a refused move is
// put back by the shell bumping `syncKey`. A promotion is never guessed: our
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
  useEffect(() => {
    onMoveRef.current = onMove;
    fenRef.current = fen;
  });

  const turn = sideToMove(fen);
  const check = useMemo(() => inCheck(fen), [fen]);
  const config: CgConfig = useMemo(
    () => ({
      fen,
      orientation,
      turnColor: turn,
      check: check ? turn : false,
      lastMove: lastMove ? ([lastMove[0], lastMove[1]] as CgKey[]) : undefined,
      coordinates: true,
      viewOnly: false,
      highlight: { lastMove: true, check: true },
      animation: { enabled: true, duration: 150 },
      movable: {
        free: false,
        color: movable ? orientation : undefined,
        dests: movable ? legalDests(fen) : new Map(),
        showDests: true,
      },
      premovable: { enabled: false },
      draggable: { enabled: movable, showGhost: true },
      selectable: { enabled: true },
      drawable: { enabled: false },
    }),
    [fen, orientation, turn, check, lastMove, movable],
  );

  // Construct once; destroy on unmount.
  useEffect(() => {
    let cancelled = false;
    let observer: ResizeObserver | null = null;
    void loadBoard().then(({ Chessground }) => {
      if (cancelled || !el.current) return;
      api.current = Chessground(el.current, {
        ...config,
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- constructed once; later props flow through api.set below
  }, []);

  // Every later prop change, and every syncKey bump, re-applies the position.
  useEffect(() => {
    api.current?.set(config);
  }, [config, syncKey]);

  const finishPromotion = (piece: PromotionPiece | null) => {
    const p = promo;
    setPromo(null);
    if (!p) return;
    if (piece === null) {
      // "Cancel — put the pawn back".
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
