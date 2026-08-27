// On-screen QWERTY keyboard. Pure function of props (statuses + onKey) --
// no hooks, no window listeners of its own; index.tsx wires the physical
// keydown listener separately and both paths call the same handleKey
// reducer, so a tap and a keypress behave identically.
//
// Mobile-narrow layout: GameFrame (a file this game must not modify --
// see _shared/game-frame.tsx) wraps every child in `px-4` (16px each
// side), which alone would leave only 288px at a 320px viewport -- too
// tight for three full QWERTY rows of 28px keys. `-mx-4` below cancels
// exactly that padding for the keyboard specifically, reclaiming the full
// viewport width (see design doc, Tests (W4): "Daily Word keyboard three
// rows fit at 320 with 28 px keys").
import type { LetterResult } from "../engine";

type KeyLabel = "ENTER" | "BACKSPACE" | string;

const ROWS: KeyLabel[][] = [
  ["Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P"],
  ["A", "S", "D", "F", "G", "H", "J", "K", "L"],
  ["ENTER", "Z", "X", "C", "V", "B", "N", "M", "BACKSPACE"],
];

const STATUS_CLASS: Record<LetterResult, string> = {
  hit: "bg-green-600 text-white",
  near: "bg-yellow-500 text-white",
  miss: "bg-slate-500 text-white",
};

export function Keyboard({
  statuses,
  onKey,
}: {
  statuses: Partial<Record<string, LetterResult>>;
  onKey(key: string): void;
}) {
  return (
    <div className="-mx-4 flex flex-col gap-1 px-1" data-testid="daily-word-keyboard">
      {ROWS.map((row, rowIdx) => (
        <div key={rowIdx} className="flex justify-center gap-0.5">
          {row.map((key) => {
            const isWide = key === "ENTER" || key === "BACKSPACE";
            const status = key.length === 1 ? statuses[key] : undefined;
            return (
              <button
                key={key}
                type="button"
                data-key={key}
                aria-label={key === "BACKSPACE" ? "Backspace" : key === "ENTER" ? "Enter" : key}
                onClick={() => onKey(key)}
                className={`flex h-10 items-center justify-center rounded text-xs font-semibold uppercase ${
                  isWide ? "w-11 px-1" : "w-7"
                } ${status ? STATUS_CLASS[status] : "bg-slate-200 text-slate-900"}`}
              >
                {key === "BACKSPACE" ? "⌫" : key === "ENTER" ? "Enter" : key}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
