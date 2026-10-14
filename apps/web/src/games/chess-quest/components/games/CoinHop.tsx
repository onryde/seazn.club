"use client";

// Coin Hop — collect all 6 coins in as few moves as you can. Port of
// js/games.js coinHop (lines 197–286): piece picker chips, bishop coins stay
// on its color, pawn never promotes here, slider/stepper star pars.
import { useState } from "react";
import { applyMove, fileOf, pieceTargets, rankRow } from "../../engine";
import { emptyBoard, randSquares } from "../../lib/rand";
import { celebrate } from "../../lib/celebrate";
import { sfx } from "../../lib/sfx";
import { STAR_RULES } from "../../lib/stars";
import { useProgress } from "../../lib/progress";
import { Board, GLYPH, Highlight } from "../Board";
import { GameShell } from "../GameShell";

const NAMES: Record<string, string> = {
  R: "Rook",
  B: "Bishop",
  N: "Knight",
  Q: "Queen",
  K: "King",
  P: "Pawn",
};

/** A fresh board for `p`: the piece somewhere around the middle and six
 *  coins (a bishop's stay on its own colour). Random, so it is dealt from an
 *  event or a lazy initial state — never from render or an effect. */
function deal(p: string) {
  const position = emptyBoard();
  const at = 27 + Math.floor(Math.random() * 10); // around the middle
  position[at] = p;
  const sameColor = (i: number) => (fileOf(i) + rankRow(i)) % 2 === (fileOf(at) + rankRow(at)) % 2;
  const coins = new Set(randSquares(6, [at], p === "B" ? sameColor : null));
  const status = `Tap the ${NAMES[p].toLowerCase()}, then tap where it should go. Collect all 6 coins!`;
  return { position, pieceAt: at, coins, status };
}

export function CoinHop({ pieces = ["N"] }: { pieces?: string[] }) {
  const progress = useProgress();
  const [piece, setPiece] = useState(pieces[0]);
  // The first board is dealt in a lazy initial state (ESLint L3: it used to be
  // an empty board that a mount effect then dealt). Safe without a hydration
  // pass: the whole chess-quest tree mounts through next/dynamic({ ssr: false })
  // (player-map.tsx), so this initializer only ever runs in the browser.
  const [first] = useState(() => deal(pieces[0]));
  const [position, setPosition] = useState<string[]>(first.position);
  const [pieceAt, setPieceAt] = useState(first.pieceAt);
  const [coins, setCoins] = useState<Set<number>>(first.coins);
  const [moves, setMoves] = useState(0);
  const [sel, setSel] = useState(false);
  const [done, setDone] = useState(false);
  const [status, setStatus] = useState(first.status);
  const [highlights, setHighlights] = useState<Partial<Record<number, Highlight>>>({});
  const [pop, setPop] = useState<{ idx: number; n: number } | null>(null);
  const [shake, setShake] = useState(0);

  /** Deal a new board — from "New coins" and from picking another piece. */
  function setup(p: string) {
    const next = deal(p);
    setDone(false);
    setSel(false);
    setMoves(0);
    setHighlights({});
    setPosition(next.position);
    setPieceAt(next.pieceAt);
    setCoins(next.coins);
    setStatus(next.status);
  }

  /** Picking the piece already in play changes nothing, as before. */
  function pickPiece(p: string) {
    if (p === piece) return;
    setPiece(p);
    setup(p);
  }

  function finish(totalMoves: number) {
    setDone(true);
    const stars = STAR_RULES.coinHop(totalMoves, piece);
    progress.setGameStars("coinHop", stars);
    setStatus(`All coins collected in <strong>${totalMoves}</strong> moves! ${"★".repeat(stars)}`);
    celebrate();
  }

  function onTap(idx: number) {
    if (done) return;
    if (idx === pieceAt) {
      setSel(true);
      const hl: Partial<Record<number, Highlight>> = { [idx]: "sel" };
      for (const t of pieceTargets(position, idx)) hl[t] = "move";
      setHighlights(hl);
      return;
    }
    if (sel && pieceTargets(position, pieceAt).includes(idx)) {
      let next = applyMove(position, pieceAt, idx);
      // keep a pawn a pawn even across the last rank in this game
      if (piece === "P") {
        next = next.slice();
        next[idx] = "P";
      }
      const nMoves = moves + 1;
      setPosition(next);
      setPieceAt(idx);
      setMoves(nMoves);
      setSel(false);
      setHighlights({});
      setPop({ idx, n: nMoves });
      if (coins.has(idx)) {
        const left = new Set(coins);
        left.delete(idx);
        setCoins(left);
        sfx.coin();
        if (left.size === 0) finish(nMoves);
      } else {
        sfx.move();
      }
    } else if (sel) {
      setShake((s) => s + 1);
    }
  }

  return (
    <GameShell
      title="Coin Hop"
      score={
        <span>
          🪙 {coins.size} left &nbsp; 👣 {moves} moves
        </span>
      }
      status={status}
      // Which piece you hop with is an occasional choice, so it rides the
      // shell's picker: inline at >=768, behind the "Pieces" button in the
      // phone thumb bar below it (phone composition, 2026-09-05).
      picker={
        pieces.length > 1
          ? {
              label: "Pieces",
              children: (
                <div className="flex flex-wrap justify-center gap-2">
                  {pieces.map((p) => (
                    <button
                      key={p}
                      type="button"
                      aria-current={p === piece ? "true" : undefined}
                      onClick={() => pickPiece(p)}
                      className={`inline-flex h-11 items-center gap-1.5 rounded-full border px-4 text-sm font-medium ${
                        p === piece
                          ? "border-(color:--cq-accent) bg-(color:--cq-accent) text-white"
                          : "border-(color:--cq-accent-line) bg-white text-(color:--cq-accent-strong) hover:bg-(color:--cq-accent-wash)"
                      }`}
                    >
                      <span aria-hidden>{GLYPH[p]}</span> {NAMES[p]}
                    </button>
                  ))}
                </div>
              ),
            }
          : undefined
      }
      controls={
        <button type="button" className="btn btn-ghost" onClick={() => setup(piece)}>
          New coins
        </button>
      }
    >
      <Board
        position={position}
        labels
        coins={coins}
        highlights={highlights}
        popToken={pop}
        shakeToken={shake}
        onTap={onTap}
      />
    </GameShell>
  );
}
