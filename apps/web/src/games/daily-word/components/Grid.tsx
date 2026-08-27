// The 6x5 tile grid. Pure function of props -- no hooks, no state of its
// own (same posture as _shared's GameFrame) -- so index.tsx owns all the
// state and this just renders it. Submitted rows are colored via
// evaluate(); the in-progress row (if any) shows plain, uncolored letters;
// remaining rows are blank placeholders.
import { evaluate, type LetterResult } from "../engine";
import { MAX_GUESSES, WORD_LENGTH } from "../state";

const RESULT_CLASS: Record<LetterResult, string> = {
  hit: "border-green-600 bg-green-600 text-white",
  near: "border-yellow-500 bg-yellow-500 text-white",
  miss: "border-slate-500 bg-slate-500 text-white",
};

export function Grid({
  guesses,
  current,
  answer,
}: {
  guesses: string[];
  current: string;
  answer: string;
}) {
  return (
    <div className="flex flex-col gap-1.5" data-testid="daily-word-grid">
      {Array.from({ length: MAX_GUESSES }, (_, rowIdx) => {
        const submitted = rowIdx < guesses.length;
        const guess = submitted ? guesses[rowIdx] : rowIdx === guesses.length ? current : "";
        const results = submitted ? evaluate(guess, answer) : null;
        const letters = guess.toUpperCase().split("");

        return (
          <div key={rowIdx} className="flex justify-center gap-1.5" data-row={rowIdx}>
            {Array.from({ length: WORD_LENGTH }, (_, colIdx) => {
              const letter = letters[colIdx] ?? "";
              const result = results?.[colIdx];
              return (
                <div
                  key={colIdx}
                  data-tile
                  data-result={result ?? "empty"}
                  className={`flex h-12 w-12 items-center justify-center rounded border-2 text-xl font-bold uppercase ${
                    result
                      ? RESULT_CLASS[result]
                      : letter
                        ? "border-slate-500 text-slate-900"
                        : "border-slate-300 text-slate-900"
                  }`}
                >
                  {letter}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
