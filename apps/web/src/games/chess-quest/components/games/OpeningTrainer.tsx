"use client";

// Opening Trainer — play a named opening move by move. The trainer auto-plays
// the book replies; you play your side's moves until the line is complete.
// Repetition builds the opening into muscle memory ("play it fifty times").
import { useCallback, useEffect, useState } from "react";
import { applyMove, isWhitePiece, legalTargets, parseFEN, sqIdx } from "../../engine";
import { OPENINGS } from "../../content/openings";
import { celebrate } from "../../lib/celebrate";
import { sfx } from "../../lib/sfx";
import { STAR_RULES } from "../../lib/stars";
import { useLater } from "../../lib/use-later";
import { useProgress } from "../../lib/progress";
import { voice } from "../../lib/voice";
import { Board, Highlight } from "../Board";
import { GameShell } from "../GameShell";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export function OpeningTrainer({ opening }: { opening: string }) {
  const op = OPENINGS[opening] ?? OPENINGS.italian;
  const progress = useProgress();
  const { later, clearPending } = useLater();

  const learnerPly = useCallback(
    (i: number) => (i % 2 === 0) === (op.learnerSide === "white"),
    [op.learnerSide],
  );

  const promptFor = useCallback(
    (i: number) => {
      if (i >= op.line.length) return `<strong>${op.name}</strong> — line complete!`;
      return learnerPly(i)
        ? `Your move: play <strong>${op.line[i].san}</strong>. Tap the glowing piece, then its square.`
        : `<strong>${op.name}</strong> — watch the reply…`;
    },
    [op, learnerPly],
  );

  const [position, setPosition] = useState<string[]>(() => parseFEN(START).board);
  const [ply, setPly] = useState(0);
  const [selIdx, setSelIdx] = useState(-1);
  const [mistakes, setMistakes] = useState(0);
  const [done, setDone] = useState(false);
  const [pop, setPop] = useState<{ idx: number; n: number } | null>(null);
  const [shake, setShake] = useState(0);

  // ESLint L3: the board's glow and the status line used to be set from an
  // effect driven by `ply`. They are now DERIVED from the ply, with only what
  // the learner's own taps add held in state, each tagged with the ply it was
  // made on — so moving to the next ply drops them in the same render:
  //  - `marks`: the selection glow (or a mistake's hint) on THIS ply;
  //  - `note`: a mistake message on this ply, or the finish line at the end.
  // Otherwise: the learner's ply glows its book from-square and prompts the
  // move; the opponent's ply glows nothing and says "watch the reply…".
  const [marks, setMarks] = useState<{ ply: number; hl: Partial<Record<number, Highlight>> } | null>(null);
  const [note, setNote] = useState<{ ply: number; text: string } | null>(null);
  const learnerTurn = ply < op.line.length && learnerPly(ply);
  const highlights: Partial<Record<number, Highlight>> = done
    ? {}
    : marks?.ply === ply
      ? marks.hl
      : learnerTurn
        ? { [sqIdx(op.line[ply].from)]: "hint" }
        : {};
  const status = note?.ply === ply ? note.text : promptFor(ply);

  const learnerMovesTotal = op.line.filter((_, i) => learnerPly(i)).length;

  // "Play again" / "Restart" — each launch is a fresh mount, so this only runs
  // from the button.
  const reset = useCallback(() => {
    clearPending();
    setPosition(parseFEN(START).board);
    setPly(0);
    setSelIdx(-1);
    setMistakes(0);
    setDone(false);
    setMarks(null);
    setNote(null);
  }, [clearPending]);

  useEffect(() => () => clearPending(), [clearPending]);

  /** The line is complete. Called from whatever completed it — the learner's
   *  own move or the opponent's reply — so lines ending on either finish. */
  const finish = useCallback(() => {
    setDone(true);
    const stars = STAR_RULES.openingTrainer(mistakes);
    progress.setGameStars("openingTrainer", stars);
    setNote({
      ply: op.line.length,
      text: `<strong>${op.name}</strong> — you played the whole line! ${"★".repeat(stars)}`,
    });
    voice.say(`${op.name}. You played the whole line!`);
    celebrate();
  }, [mistakes, op.line.length, op.name, progress]);

  // The opponent's ply: play the book reply after a beat. Every state change
  // happens in the timer's callback; the cleanup cancels a pending reply, so a
  // re-run (or a Restart, or leaving the game) can never play it twice.
  useEffect(() => {
    if (done || ply >= op.line.length || learnerPly(ply)) return;
    const mv = op.line[ply];
    later(() => {
      setPosition((pos) => applyMove(pos, sqIdx(mv.from), sqIdx(mv.to)));
      setPop((prev) => ({ idx: sqIdx(mv.to), n: (prev?.n ?? 0) + 1 }));
      sfx.move();
      setPly(ply + 1);
      if (ply + 1 >= op.line.length) finish();
    }, 550);
    return clearPending;
  }, [ply, done, op.line, learnerPly, later, clearPending, finish]);

  function onLearnerMove(from: number, to: number) {
    const mv = op.line[ply];
    if (from === sqIdx(mv.from) && to === sqIdx(mv.to)) {
      setPosition(applyMove(position, from, to));
      setPop((prev) => ({ idx: to, n: (prev?.n ?? 0) + 1 }));
      sfx.move();
      setSelIdx(-1);
      setPly(ply + 1);
      if (ply + 1 >= op.line.length) finish();
    } else {
      setSelIdx(-1);
      setMistakes((x) => x + 1);
      setShake((s) => s + 1);
      sfx.bad();
      setNote({
        ply,
        text: `Not the book move — the ${op.name} plays <strong>${mv.san}</strong> here. Follow the glowing piece.`,
      });
      setMarks({ ply, hl: { [sqIdx(mv.from)]: "hint" } });
    }
  }

  function onTap(idx: number) {
    if (done || !learnerTurn) return;
    const pos = position;
    const p = pos[idx];
    const mine = p !== "" && isWhitePiece(p) === (op.learnerSide === "white");
    if (mine) {
      setSelIdx(idx);
      const hl: Partial<Record<number, Highlight>> = { [idx]: "sel" };
      for (const t of legalTargets(pos, idx)) hl[t] = pos[t] === "" ? "move" : "cap";
      hl[sqIdx(op.line[ply].from)] = "hint";
      setMarks({ ply, hl });
      return;
    }
    if (selIdx >= 0 && legalTargets(pos, selIdx).includes(idx)) {
      onLearnerMove(selIdx, idx);
    } else if (selIdx >= 0) {
      setShake((s) => s + 1);
    }
  }

  const doneLearnerMoves = op.line.slice(0, ply).filter((_, i) => learnerPly(i)).length;

  return (
    <GameShell
      title={`Opening Trainer — ${op.name}`}
      score={`move ${doneLearnerMoves}/${learnerMovesTotal}`}
      status={status}
      extra={<p className="text-center text-xs italic text-slate-500">{op.idea}</p>}
      controls={
        <button type="button" className="btn btn-ghost" onClick={reset}>
          {done ? "Play again" : "Restart"}
        </button>
      }
    >
      <Board
        position={position}
        labels
        // Every line here starts from the same fixed START FEN (always "w"),
        // so parseFEN(START).whiteToMove is always true — it can't tell us
        // which side the LEARNER plays (op.learnerSide; only the Scandinavian
        // is "black"). Orienting to START's colour would leave the board
        // white-side-up even when training a black opening, defeating the
        // point of orientation, so this one game orients off op.learnerSide
        // instead of a parsed FEN.
        orientation={op.learnerSide}
        highlights={highlights}
        popToken={pop}
        shakeToken={shake}
        onTap={onTap}
      />
    </GameShell>
  );
}
