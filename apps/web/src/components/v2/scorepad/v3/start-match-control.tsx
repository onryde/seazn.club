// S2-7 (TN-TS-1, engine 8.0.0) — "Start match" with the tennis toss, shared by the console (`fixture-console.tsx`) and
// the remote pad (`device-score-pad.tsx`). Each page keeps its OWN Start button (its markup and test ids are the page's);
// this hook decides what a press does, and `StartTossQuestion` is what the page shows instead of the button while the
// question is open.
//
// For every sport but tennis a press is the plain Start it always was. For tennis it first asks "Who serves first?" —
// the tennis skin's required question (`startTossQuestion`), in the pad's own `ChoiceDock` — and the answer sends the
// toss and then the Start (`runTossThenStart`, through `onTossThenStart`). A match whose toss is already held
// (`startNeedsToss`) only starts. Cancel puts the button back and sends nothing.
//
// Double taps: the dock's own claim (`choiceController`) takes the first chip only, and the question stays up, its answer
// marked, until the two writes have settled, so the button cannot come back mid-sequence and start the match twice.
"use client";

import { useState } from "react";
import type { MessageKey } from "@/lib/messages";
import { ChoiceDock } from "./detail-dock";
import { startNeedsToss, startTossQuestion, tossEventFor, type TossSide } from "./skins/tennis";
import type { DockChip } from "./types";

export interface StartWithTossInput {
  sportKey: string;
  /** The server's stored fold (`/state`'s `state`): null until the ledger holds an event. */
  state: unknown;
  /** The plain Start, as before. */
  onStart: () => void;
  /** The toss, then the Start; resolves once both writes have settled, whatever their answer. */
  onTossThenStart: (toss: { type: string; payload: Record<string, unknown> }) => Promise<unknown>;
}

export interface StartWithToss {
  /** True while "Who serves first?" is on screen (and until the writes its answer started have settled). */
  asking: boolean;
  /** The Start button's own press. */
  press: () => void;
  choose: (chip: DockChip) => void;
  cancel: () => void;
}

export function useStartWithToss(input: StartWithTossInput): StartWithToss {
  const [asking, setAsking] = useState(false);
  const needsToss = startNeedsToss(input.sportKey, input.state);
  return {
    asking,
    press: () => (needsToss ? setAsking(true) : input.onStart()),
    choose: (chip) => {
      void input.onTossThenStart(tossEventFor(chip)).finally(() => setAsking(false));
    },
    cancel: () => setAsking(false),
  };
}

export interface StartTossQuestionProps {
  home: TossSide;
  away: TossSide;
  /** The page's own `useMsg()`; the dock's loose `t` is built from it, as the pad host builds its own. */
  msg: (key: MessageKey, vars?: Record<string, string | number>) => string;
  start: StartWithToss;
}

/** "Who serves first?" — shown by the page in place of its Start button while `start.asking`. */
export function StartTossQuestion({ home, away, msg, start }: StartTossQuestionProps) {
  const t = (key: string, vars?: Record<string, string | number>) => msg(key as MessageKey, vars);
  return (
    <div data-testid="score-start-toss" className="w-full">
      <ChoiceDock spec={startTossQuestion(home, away, t)} t={t} onChoose={start.choose} onCancel={start.cancel} />
    </div>
  );
}
