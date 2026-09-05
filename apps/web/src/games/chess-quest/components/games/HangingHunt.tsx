"use client";

// Piece Detective — tap the black piece that's free to take (attacked and
// undefended). Port of js/games.js hangingHunt (810–926): targeted coaching
// for wrong taps, tap-the-guard flow for defended pieces.
//
// `range` scopes a lesson to a slice of HUNTS (e.g. [0,8) for the quest's
// first "hangingHunt" lesson) so the four quest lessons that all launch this
// game don't share one global case progression. When given, progress is
// backed by the generic tactic-pack store (progress.isTacticSolved/
// setTacticSolved/tacticCount/resetTactics) keyed `hunt_${start}_${end}` —
// the same mechanism MateInOne and TacticTrainer already use per pack. When
// omitted (arcade/free-play), behavior is unchanged: the full HUNTS pool via
// the dedicated progress.isHuntSolved/setHuntSolved/huntCount/resetHunts
// fields.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  attackSquares,
  defendersOf,
  isAttacked,
  isWhitePiece,
  parseFEN,
  sqIdx,
} from "../../engine";
import { HUNTS } from "../../content/puzzles";
import { useCopy } from "../../lib/copy";
import { celebrate } from "../../lib/celebrate";
import { sfx } from "../../lib/sfx";
import { voice } from "../../lib/voice";
import { STAR_RULES } from "../../lib/stars";
import { useLater } from "../../lib/use-later";
import { useProgress } from "../../lib/progress";
import { Board, Highlight } from "../Board";
import { GameShell } from "../GameShell";
import { PuzzleDots } from "./PuzzleDots";

function firstUnsolved(total: number, isSolved: (i: number) => boolean) {
  for (let i = 0; i < total; i++) if (!isSolved(i)) return i;
  return 0;
}

export function HangingHunt({ range }: { range?: [number, number] }) {
  const progress = useProgress();
  const { isStory } = useCopy();
  const { later, clearPending } = useLater();
  // `range` arrives as a fresh array literal on every render of the lesson
  // that launched this game, so an unmemoized `HUNTS.slice(...)` handed `load`
  // a new PACK identity each time and its useCallback never actually
  // memoized. Keyed on the two NUMBERS, extracted first because a dependency
  // array may not hold a complex expression.
  const rangeStart = range?.[0];
  const rangeEnd = range?.[1];
  const PACK = useMemo(
    () =>
      rangeStart === undefined || rangeEnd === undefined
        ? HUNTS
        : HUNTS.slice(rangeStart, rangeEnd),
    [rangeStart, rangeEnd],
  );
  const packKey = range ? `hunt_${range[0]}_${range[1]}` : null;
  const gameId = packKey ?? "hangingHunt";
  const isSolved = (i: number) =>
    packKey ? progress.isTacticSolved(packKey, i) : progress.isHuntSolved(i);
  const markSolved = (i: number) =>
    packKey ? progress.setTacticSolved(packKey, i) : progress.setHuntSolved(i);
  const solvedCount = () => (packKey ? progress.tacticCount(packKey) : progress.huntCount());
  const resetSolved = () => (packKey ? progress.resetTactics(packKey) : progress.resetHunts());

  const [cur, setCur] = useState(() => firstUnsolved(PACK.length, isSolved));
  const [position, setPosition] = useState<string[]>(() => parseFEN(PACK[cur].fen).board);
  const [busy, setBusy] = useState(false);
  const [highlights, setHighlights] = useState<Partial<Record<number, Highlight>>>({});
  const [pop, setPop] = useState<{ idx: number; n: number } | null>(null);
  const [popN, setPopN] = useState(0);
  const [shake, setShake] = useState(0);
  const [coachTap, setCoachTap] = useState<((idx: number) => void) | null>(null);

  const prompt = useCallback(
    (h: (typeof HUNTS)[number]) =>
      `${isStory() ? `<em>${h.story}</em><br>` : ""}Tap the black piece that is <strong>free to take</strong> — attacked, and nobody guards it!`,
    [isStory],
  );

  const [status, setStatus] = useState(() => prompt(PACK[cur]));

  const load = useCallback(
    (i: number) => {
      clearPending();
      setCur(i);
      setPosition(parseFEN(PACK[i].fen).board);
      setHighlights({});
      setBusy(false);
      setCoachTap(null);
      setStatus(prompt(PACK[i]));
    },
    [PACK, clearPending, prompt],
  );

  useEffect(() => () => clearPending(), [clearPending]);

  function solved(i: number) {
    markSolved(i);
    const n = solvedCount();
    progress.setGameStars(gameId, STAR_RULES.packStars(n, PACK.length));
    setStatus("<strong>Found it!</strong> 🔍 Free stuff detected.");
    voice.say("Found it! Free stuff detected!");
    sfx.coin();
    setBusy(true);
    later(() => {
      if (n < PACK.length) load(firstUnsolved(PACK.length, isSolved));
      else {
        setStatus(
          "<strong>All cases closed!</strong> Official Free-Stuff Detector badge earned. ★★★",
        );
        celebrate();
      }
    }, 1300);
  }

  function onTap(idx: number) {
    if (coachTap) {
      coachTap(idx);
      return;
    }
    if (busy) return;
    const h = PACK[cur];
    if (idx === sqIdx(h.answer)) {
      setHighlights({ [idx]: "hint" });
      setPop({ idx, n: popN + 1 });
      setPopN((v) => v + 1);
      solved(cur);
      return;
    }
    const pos = position;
    const p = pos[idx];
    if (p === "" || isWhitePiece(p)) {
      setShake((s) => s + 1);
      sfx.bad();
      setStatus("Tap a <strong>black</strong> piece — we’re hunting black’s loose ones!");
    } else if (p === "k") {
      setShake((s) => s + 1);
      sfx.bad();
      setStatus("Kings can never be taken — only checkmated! Hunt for a piece.");
    } else if (!isAttacked(pos, idx, true)) {
      setShake((s) => s + 1);
      sfx.bad();
      setStatus("Is anything even <strong>attacking</strong> that one? Trace every white piece’s path…");
    } else {
      const guards = defendersOf(pos, idx);
      sfx.bad();
      setStatus("It IS attacked — but it has a bodyguard! <strong>Tap the guard.</strong>");
      setCoachTap(() => (t: number) => {
        setCoachTap(null);
        if (guards.includes(t)) {
          setHighlights({ [t]: "hint" });
          sfx.good();
          setStatus("That’s the bodyguard! Free stuff has <strong>no</strong> guards. Keep hunting!");
        } else {
          setHighlights(Object.fromEntries(guards.map((g) => [g, "hint" as Highlight])));
          setStatus("The glowing one guards it. Free stuff has no guards — keep hunting!");
        }
      });
    }
  }

  function hint() {
    const pos = position;
    const ans = sqIdx(PACK[cur].answer);
    const hl: Partial<Record<number, Highlight>> = {};
    for (let i = 0; i < 64; i++) {
      const p = pos[i];
      if (p !== "" && isWhitePiece(p) && attackSquares(pos, i).includes(ans)) hl[i] = "hint";
    }
    setHighlights(hl);
    setStatus(
      `${isStory() ? `<em>${PACK[cur].story}</em><br>` : ""}Follow the glowing piece — what can it grab for free?`,
    );
  }

  return (
    <GameShell
      title="Piece Detective"
      score={`🔍 ${solvedCount()} / ${PACK.length} cases`}
      status={status}
      subtitle={<span className="min-w-0 truncate font-bold">Case {cur + 1}</span>}
      picker={{
        label: "Cases",
        children: (
          <PuzzleDots
            count={PACK.length}
            current={cur}
            isSolved={isSolved}
            onPick={load}
            label="Case"
            variant="grid"
          />
        ),
      }}
      extra={
        <PuzzleDots
          count={PACK.length}
          current={cur}
          isSolved={isSolved}
          onPick={load}
          label="Case"
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
            Start cases over
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
