"use client";

// Mate-pack game, depth-parameterised. Port of js/games.js mateInTwo
// (540–706), generalised for Mate in 3: force checkmate in `depth` moves,
// one move at a time. Each intermediate move must force mate in exactly the
// moves remaining (isMateInNAfter); black plays its toughest defense after
// each one (bestDefense); the final move must deliver checkmate outright.
// depth=2 (the default) is unchanged behaviour — same MATE2 pack, same
// phase-1-then-phase-2 flow, same progress keys.
import { useCallback, useEffect, useState } from "react";
import {
  allLegalMoves,
  applyMove,
  bestDefense,
  hasMateInN,
  inCheck,
  isMate,
  isMateInNAfter,
  isWhitePiece,
  legalTargets,
  parseFEN,
  sqIdx,
  sqName,
} from "../../engine";
import { MATE2, MATE3, MatePuzzle } from "../../content/puzzles";
import { celebrate } from "../../lib/celebrate";
import { sfx } from "../../lib/sfx";
import { voice } from "../../lib/voice";
import { STAR_RULES } from "../../lib/stars";
import { useLater } from "../../lib/use-later";
import { useProgress } from "../../lib/progress";
import { Board, Highlight } from "../Board";
import { GameShell } from "../GameShell";
import { PuzzleDots } from "./PuzzleDots";
import { Chip, runMateMiss } from "./mate-miss-coach";

function firstUnsolved(total: number, isSolved: (i: number) => boolean) {
  for (let i = 0; i < total; i++) if (!isSolved(i)) return i;
  return 0;
}

export function MateInTwo({ depth = 2 }: { depth?: 2 | 3 }) {
  const PACK: MatePuzzle[] = depth === 3 ? MATE3 : MATE2;
  const gameId = depth === 3 ? "mateInThree" : "mateInTwo";
  const progress = useProgress();
  const { later, clearPending } = useLater();

  // depth=3's progress rides the generic tactic-pack store under its own
  // gameId key; depth=2 keeps the original dedicated MATE2 fields untouched.
  const isSolved = (i: number) =>
    depth === 3 ? progress.isTacticSolved(gameId, i) : progress.isSolved2(i);
  const markSolved = (i: number) =>
    depth === 3 ? progress.setTacticSolved(gameId, i) : progress.setSolved2(i);
  const solvedCount = () => (depth === 3 ? progress.tacticCount(gameId) : progress.solved2Count());
  const resetSolved = () => (depth === 3 ? progress.resetTactics(gameId) : progress.resetPuzzles2());

  const [cur, setCur] = useState(() => firstUnsolved(PACK.length, isSolved));
  const [position, setPosition] = useState<string[]>(() => parseFEN(PACK[cur].fen).board);
  const [selIdx, setSelIdx] = useState(-1);
  const [tries, setTries] = useState(0);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState(1); // 1..depth: which move number we're finding
  const [midBoard, setMidBoard] = useState<string[] | null>(null);
  const [highlights, setHighlights] = useState<Partial<Record<number, Highlight>>>({});
  const [pop, setPop] = useState<{ idx: number; n: number } | null>(null);
  const [popN, setPopN] = useState(0);
  const [shake, setShake] = useState(0);
  const [chips, setChips] = useState<Chip[]>([]);
  const [coachTap, setCoachTap] = useState<((idx: number) => void) | null>(null);
  const [status, setStatus] = useState(
    () =>
      `<strong>${PACK[cur].name}</strong> — white forces checkmate in <strong>${depth}</strong> moves. Find move one!`,
  );

  const load = useCallback(
    (i: number) => {
      clearPending();
      setCur(i);
      setPosition(parseFEN(PACK[i].fen).board);
      setHighlights({});
      setSelIdx(-1);
      setTries(0);
      setBusy(false);
      setPhase(1);
      setMidBoard(null);
      setChips([]);
      setCoachTap(null);
      setStatus(
        `<strong>${PACK[i].name}</strong> — white forces checkmate in <strong>${depth}</strong> moves. Find move one!`,
      );
    },
    [PACK, clearPending, depth],
  );

  useEffect(() => () => clearPending(), [clearPending]);

  function popAt(idx: number) {
    setPop({ idx, n: popN + 1 });
    setPopN((v) => v + 1);
  }

  function solved(i: number, msg: string) {
    markSolved(i);
    const n = solvedCount();
    progress.setGameStars(gameId, depth === 3 ? STAR_RULES.mateInThree(n) : STAR_RULES.packStars(n));
    setStatus(msg);
    voice.say(msg);
    celebrate();
    setBusy(true);
    later(() => {
      if (n < PACK.length) load(firstUnsolved(PACK.length, isSolved));
      else
        setStatus(
          `<strong>Pack complete!</strong> ${PACK.length === 9 ? "Nine" : "Twelve"} forced mates — real chess player thinking. ★★★`,
        );
    }, 1600);
  }

  // Black plays its toughest defense, then hands the next phase back (or,
  // if it has no reply at all, the last move was already mate).
  function blackReplies(afterWhite: string[]) {
    const remainingAfterReply = depth - phase; // moves still to force once black has moved
    setBusy(true);
    later(() => {
      const d = bestDefense(afterWhite);
      if (!d) {
        solved(cur, "<strong>Checkmate!</strong> 🎉");
        return;
      }
      const afterBlack = applyMove(afterWhite, d.from, d.to);
      setPosition(afterBlack);
      popAt(d.to);
      sfx.move();
      setMidBoard(afterBlack);
      setPhase((p) => p + 1);
      setBusy(false);
      setStatus(
        `Locked in! Black tries <strong>${sqName(d.from)}–${sqName(d.to)}</strong>… now finish it. <strong>${
          remainingAfterReply === 1 ? "Mate in one!" : `Mate in ${remainingAfterReply}!`
        }</strong>`,
      );
    }, 750);
  }

  function onTap(idx: number) {
    if (coachTap) {
      coachTap(idx);
      return;
    }
    if (busy) return;
    const pos = position;
    const p = pos[idx];
    if (p !== "" && isWhitePiece(p)) {
      setSelIdx(idx);
      const hl: Partial<Record<number, Highlight>> = { [idx]: "sel" };
      for (const t of legalTargets(pos, idx)) hl[t] = pos[t] === "" ? "move" : "cap";
      setHighlights(hl);
      return;
    }
    if (selIdx < 0 || !legalTargets(pos, selIdx).includes(idx)) {
      if (selIdx >= 0) setShake((s) => s + 1);
      return;
    }

    const next = applyMove(pos, selIdx, idx);
    const from = selIdx;
    setSelIdx(-1);
    const remaining = depth - phase + 1; // moves needed from THIS move onward

    if (remaining === 1) {
      // Final move: must deliver mate now.
      if (isMate(next, false)) {
        setPosition(next);
        setHighlights({});
        popAt(idx);
        solved(cur, "<strong>Checkmate!</strong> 🎉 A forced mate — beautifully done.");
      } else {
        const t = tries + 1;
        setTries(t);
        setPosition(next);
        setHighlights({});
        setBusy(true);
        runMateMiss({
          next,
          resetBoard: midBoard ?? parseFEN(PACK[cur].fen).board,
          extraNudge: t >= 2 ? " (The Hint button is your friend!)" : "",
          setStatus,
          setChips,
          setCoachTap: (fn) => setCoachTap(() => fn),
          setPosition,
          setHighlights,
          bumpShake: () => setShake((s) => s + 1),
          later,
          unlock: () => setBusy(false),
          bad: sfx.bad,
          good: sfx.good,
        });
      }
    } else {
      // Intermediate move: must force mate in `remaining` (or mate outright,
      // even faster than asked — a welcome bonus, never actually reachable
      // for a puzzle whose invariant already rules out a shorter mate).
      if (isMate(next, false)) {
        setPosition(next);
        setHighlights({});
        popAt(idx);
        solved(cur, "<strong>Checkmate — even faster than asked!</strong> 🎉");
      } else if (isMateInNAfter(pos, from, idx, remaining)) {
        setPosition(next);
        setHighlights({});
        popAt(idx);
        sfx.good();
        setStatus("That's the squeeze — black has no good answer…");
        blackReplies(next);
      } else {
        const t = tries + 1;
        setTries(t);
        setPosition(next);
        setHighlights({});
        setBusy(true);
        sfx.bad();
        const replies = allLegalMoves(next, false);
        let saveMove: { from: number; to: number } | null = null;
        for (const r of replies) {
          if (!hasMateInN(applyMove(next, r.from, r.to), true, remaining - 1)) {
            saveMove = r;
            break;
          }
        }
        const nudge = t >= 2 ? " (The Hint button is your friend!)" : "";
        const escapeTxt = saveMove
          ? `black plays <strong>${sqName(saveMove.from)}–${sqName(saveMove.to)}</strong> and there is no mate`
          : "black slips away";
        later(() => {
          setPosition(parseFEN(PACK[cur].fen).board);
          setShake((s) => s + 1);
          setBusy(false);
          setStatus(
            (inCheck(next, false)
              ? `It's check — but ${escapeTxt}. Find the move that leaves <strong>no way out</strong>.`
              : `Black gets a free turn: ${escapeTxt}. Move one must be a check or an unstoppable threat!`) +
              nudge,
          );
        }, 900);
      }
    }
  }

  function hint() {
    const remaining = depth - phase + 1;
    if (phase === 1) {
      setHighlights({ [sqIdx(PACK[cur].solution.slice(0, 2))]: "hint" });
      setStatus(`<strong>${PACK[cur].name}</strong> — ${PACK[cur].hint}`);
      return;
    }
    // Later phases have no authored solution for "this exact move" — find one
    // live from the current position, same style as the original final-move
    // hint (which this generalises: remaining===1 is exactly that case).
    if (!midBoard) return;
    for (const m of allLegalMoves(midBoard, true)) {
      const after = applyMove(midBoard, m.from, m.to);
      const ok = remaining === 1 ? isMate(after, false) : isMateInNAfter(midBoard, m.from, m.to, remaining);
      if (ok) {
        setHighlights({ [m.from]: "hint" });
        break;
      }
    }
  }

  return (
    <GameShell
      title={`Mate in ${depth}`}
      score={`🧩 ${solvedCount()} / ${PACK.length} solved`}
      status={status}
      chips={chips}
      extra={<PuzzleDots count={PACK.length} current={cur} isSolved={isSolved} onPick={load} />}
      controls={
        <>
          <button type="button" className="btn btn-ghost" onClick={hint}>
            Hint
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              resetSolved();
              load(0);
            }}
          >
            Start pack over
          </button>
        </>
      }
    >
      <Board
        position={position}
        labels
        orientation={parseFEN(MATE2[cur].fen).whiteToMove ? "white" : "black"}
        highlights={highlights}
        popToken={pop}
        shakeToken={shake}
        onTap={onTap}
      />
    </GameShell>
  );
}
