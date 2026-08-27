"use client";

// Shared chrome for every mini-game (replaces the original modal): title +
// score header, coach bubble with rich status and answer chips, an extra
// slot (puzzle dots / piece pickers), the board, and a controls row.
import { Rich } from "./rich";

export function GameShell({
  title,
  score,
  status,
  chips,
  extra,
  controls,
  children,
}: {
  title: string;
  score?: React.ReactNode;
  status: string;
  chips?: { label: string; onPick(): void }[];
  extra?: React.ReactNode;
  controls?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-3 px-4 py-4">
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="mk-display text-2xl font-bold text-(color:--cq-ink)">{title}</h2>
        {score ? <div className="text-sm font-medium text-slate-600">{score}</div> : null}
      </header>

      <div className="flex items-start gap-2">
        <span aria-hidden className="mt-1 text-2xl">
          ♞
        </span>
        <div className="min-h-14 flex-1 rounded-2xl rounded-tl-sm border border-(color:--cq-line-soft) bg-(color:--cq-accent-wash) px-3 py-2">
          <Rich html={status} className="text-sm text-(color:--cq-ink) [&_strong]:font-bold" />
          {chips && chips.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {chips.map((c) => (
                <button
                  key={c.label}
                  type="button"
                  onClick={c.onPick}
                  className="rounded-full border border-(color:--cq-accent-line) bg-white px-3 py-1 text-xs font-medium text-(color:--cq-accent-strong) hover:bg-(color:--cq-accent-soft)"
                >
                  {c.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {extra}

      <div className="flex justify-center">{children}</div>

      {controls ? <div className="flex flex-wrap justify-center gap-2">{controls}</div> : null}
    </div>
  );
}
