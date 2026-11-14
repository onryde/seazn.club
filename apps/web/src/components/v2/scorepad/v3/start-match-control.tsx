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
// Quick match cricket (decision log 2026-11-13): on a quick match's remote pad only (`quickMatchToss`), a cricket Start
// asks "Who won the toss?" and then "Bat or bowl?" (`skins/cricket-start-toss.ts`, which says why at Start), and the second
// answer sends the toss and then the Start the same way. Cancel at either question puts the button back, and the next
// Start asks from the first question again. Carrom likewise asks "Who breaks first?" (whole review m6,
// `skins/carrom-start-toss.ts`). Without the flag both sports' Start is the plain one, as before.
//
// Double taps: the dock's own claim (`choiceController`) takes the first chip only, and the question stays up, its answer
// marked, until the two writes have settled, so the button cannot come back mid-sequence and start the match twice. The
// cricket questions are two docks, keyed apart, so each has its own single claim.
"use client";

import { useState } from "react";
import type { MessageKey } from "@/lib/messages";
import { ChoiceDock } from "./detail-dock";
import { carromTossEvent, carromTossOpen, carromTossQuestion } from "./skins/carrom-start-toss";
import {
  cricketTossElectedQuestion,
  cricketTossEvent,
  cricketTossOpen,
  cricketTossWonQuestion,
} from "./skins/cricket-start-toss";
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
  /** Quick match: a cricket Start (decision log 2026-11-13) and a carrom Start (whole review m6) ask the toss first, the
   *  toss the remote pad's Toss tile can never offer (it mounts after the Start). Only a quick match's remote pad sets it. */
  quickMatchToss?: boolean;
}

export interface StartWithToss {
  /** True while a toss question is on screen (and until the writes its answer started have settled). */
  asking: boolean;
  /** Which toss this Start asks: tennis's one question, cricket's two, carrom's one, or none. */
  kind: "tennis" | "cricket" | "carrom" | null;
  /** Cricket's first answer (the entrant who won the toss), null until given: the second question is then on screen. */
  wonBy: string | null;
  /** The Start button's own press. */
  press: () => void;
  choose: (chip: DockChip) => void;
  cancel: () => void;
}

/** The toss a press owes, if any: tennis's whenever its toss is open; cricket's and carrom's only on a quick match pad. */
function tossKindOf(input: StartWithTossInput): StartWithToss["kind"] {
  if (startNeedsToss(input.sportKey, input.state)) return "tennis";
  if (input.quickMatchToss !== true) return null;
  if (input.sportKey === "cricket" && cricketTossOpen(input.state)) return "cricket";
  if (input.sportKey === "carrom" && carromTossOpen(input.state)) return "carrom";
  return null;
}

export function useStartWithToss(input: StartWithTossInput): StartWithToss {
  const [asking, setAsking] = useState(false);
  const [wonBy, setWonBy] = useState<string | null>(null);
  // Whole review I-1: the kind is FROZEN at the press. The page resyncs `/state` once the toss write lands, before the
  // Start settles, and a kind read off that fold owes no toss any more: the question on screen fell through to tennis's
  // "Who serves first?", a fresh dock whose tap posted a tennis toss to a cricket match. While asking, the question is the
  // one the scorer was asked; between presses the live reading decides.
  const [asked, setAsked] = useState<StartWithToss["kind"]>(null);
  const kind = asking ? asked : tossKindOf(input);
  const done = () => {
    setAsking(false);
    setWonBy(null);
    setAsked(null);
  };
  return {
    asking,
    kind,
    wonBy,
    press: () => {
      if (kind === null) return input.onStart();
      setAsked(kind);
      setAsking(true);
    },
    choose: (chip) => {
      if (kind === "cricket" && wonBy === null) {
        // The first question's answer only: nothing is sent until the second.
        setWonBy(String(chip.mutate({}).wonBy));
        return;
      }
      const toss =
        kind === "cricket"
          ? cricketTossEvent(wonBy!, String(chip.mutate({}).elected))
          : kind === "carrom"
            ? carromTossEvent(chip)
            : tossEventFor(chip);
      void input.onTossThenStart(toss).finally(done);
    },
    cancel: done,
  };
}

export interface StartTossQuestionProps {
  home: TossSide;
  away: TossSide;
  /** The page's own `useMsg()`; the dock's loose `t` is built from it, as the pad host builds its own. */
  msg: (key: MessageKey, vars?: Record<string, string | number>) => string;
  start: StartWithToss;
}

/** The toss question — "Who serves first?", cricket's "Who won the toss?" then "Bat or bowl?", or carrom's "Who breaks
 *  first?" — shown by the page in place of its Start button while `start.asking`. */
export function StartTossQuestion({ home, away, msg, start }: StartTossQuestionProps) {
  const t = (key: string, vars?: Record<string, string | number>) => msg(key as MessageKey, vars);
  const step =
    start.kind === "cricket" ? (start.wonBy === null ? "cricket-won" : "cricket-elected") : start.kind === "carrom" ? "carrom" : "tennis";
  const spec =
    step === "cricket-won"
      ? cricketTossWonQuestion(home, away, t)
      : step === "cricket-elected"
        ? cricketTossElectedQuestion(t)
        : step === "carrom"
          ? carromTossQuestion(home, away, t)
          : startTossQuestion(home, away, t);
  return (
    <div data-testid="score-start-toss" className="w-full">
      <ChoiceDock key={step} spec={spec} t={t} onChoose={start.choose} onCancel={start.cancel} />
    </div>
  );
}
