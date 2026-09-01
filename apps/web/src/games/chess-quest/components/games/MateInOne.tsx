"use client";

// Mate in 1 — solve the pack, any legal mating move accepted. Port of
// js/games.js mateInOne (431–538); completion copy uses MATE1.length (the
// original hardcoded "12" but the pack has 18).
//
// `range` scopes a lesson to a slice of MATE1 (e.g. [0,3) for the quest's
// first "mateInOne" lesson) so multiple quest lessons that all launch this
// game don't share one global puzzle progression. When given, progress is
// backed by the generic tactic-pack store (progress.isTacticSolved/
// setTacticSolved/tacticCount/resetTactics) keyed `mate1_${start}_${end}` —
// the same mechanism TacticTrainer already uses per pack. When omitted
// (arcade/free-play), behavior is unchanged: the full MATE1 pool via the
// dedicated progress.isSolved/setSolved/solvedCount/resetPuzzles fields.
import { useCallback, useEffect, useState } from "react";
import { applyMove, isMate, isWhitePiece, legalTargets, parseFEN, sqIdx } from "../../engine";
import { MATE1 } from "../../content/puzzles";
import { celebrate } from "../../lib/celebrate";
import { sfx } from "../../lib/sfx";
import { STAR_RULES } from "../../lib/stars";
import { useLater } from "../../lib/use-later";
import { voice } from "../../lib/voice";
import { useProgress } from "../../lib/progress";
import { Board, Highlight } from "../Board";
import { GameShell } from "../GameShell";
import { PuzzleDots } from "./PuzzleDots";
import { Chip, runMateMiss } from "./mate-miss-coach";

function firstUnsolved(total: number, isSolved: (i: number) => boolean) {
  for (let i = 0; i < total; i++) if (!isSolved(i)) return i;
  return 0;
}

export function MateInOne({ range }: { range?: [number, number] }) {
  const progress = useProgress();
  const { later, clearPending } = useLater();
  const PACK = range ? MATE1.slice(range[0], range[1]) : MATE1;
  const packKey = range ? `mate1_${range[0]}_${range[1]}` : null;
  const gameId = packKey ?? "mateInOne";
  const isSolved = (i: number) => (packKey ? progress.isTacticSolved(packKey, i) : progress.isSolved(i));
  const markSolved = (i: number) =>
    packKey ? progress.setTacticSolved(packKey, i) : progress.setSolved(i);
  const solvedCount = () => (packKey ? progress.tacticCount(packKey) : progress.solvedCount());
  const resetSolved = () => (packKey ? progress.resetTactics(packKey) : progress.resetPuzzles());

  const [cur, setCur] = useState(() => firstUnsolved(PACK.length, isSolved));
  const [position, setPosition] = useState<string[]>(() => parseFEN(PACK[cur].fen).board);
  const [selIdx, setSelIdx] = useState(-1);
  const [tries, setTries] = useState(0);
  const [busy, setBusy] = useState(false);
  const [highlights, setHighlights] = useState<Partial<Record<number, Highlight>>>({});
  const [pop, setPop] = useState<{ idx: number; n: number } | null>(null);
  const [popN, setPopN] = useState(0);
  const [shake, setShake] = useState(0);
  const [chips, setChips] = useState<Chip[]>([]);
  const [coachTap, setCoachTap] = useState<((idx: number) => void) | null>(null);
  const [status, setStatus] = useState(
    () => `<strong>${PACK[cur].name}</strong> — white moves and checkmates in one!`,
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
      setChips([]);
      setCoachTap(null);
      setStatus(`<strong>${PACK[i].name}</strong> — white moves and checkmates in one!`);
    },
    [PACK, clearPending],
  );

  useEffect(() => () => clearPending(), [clearPending]);

  function solved(i: number) {
    markSolved(i);
    const n = solvedCount();
    progress.setGameStars(gameId, STAR_RULES.packStars(n));
    setStatus("<strong>Checkmate!</strong> 🎉 The king has nowhere to run.");
    voice.say("Checkmate! The king has nowhere to run!");
    celebrate();
    setBusy(true);
    later(() => {
      if (n < PACK.length) load(firstUnsolved(PACK.length, isSolved));
      else
        setStatus(
          `<strong>Pack complete!</strong> All ${PACK.length} checkmates found. ★★★`,
        );
    }, 1400);
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
    if (selIdx >= 0 && legalTargets(pos, selIdx).includes(idx)) {
      const next = applyMove(pos, selIdx, idx);
      setSelIdx(-1);
      if (isMate(next, false)) {
        setPosition(next);
        setHighlights({});
        setPop({ idx, n: popN + 1 });
        setPopN((v) => v + 1);
        solved(cur);
      } else {
        const t = tries + 1;
        setTries(t);
        setPosition(next);
        setHighlights({});
        setBusy(true);
        runMateMiss({
          next,
          resetBoard: parseFEN(PACK[cur].fen).board,
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
    } else if (selIdx >= 0) {
      setShake((s) => s + 1);
    }
  }

  function hint() {
    const from = sqIdx(PACK[cur].solution.slice(0, 2));
    setHighlights({ [from]: "hint" });
    setStatus(`<strong>${PACK[cur].name}</strong> — ${PACK[cur].hint}`);
  }

  return (
    <GameShell
      title="Mate in 1"
      score={`🧩 ${solvedCount()} / ${PACK.length} solved`}
      status={status}
      chips={chips}
      extra={
        <PuzzleDots
          count={PACK.length}
          current={cur}
          isSolved={isSolved}
          onPick={load}
        />
      }
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
        orientation={parseFEN(PACK[cur].fen).whiteToMove ? "white" : "black"}
        highlights={highlights}
        popToken={pop}
        shakeToken={shake}
        onTap={onTap}
      />
    </GameShell>
  );
}
