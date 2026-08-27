// Shared chrome for the new (non-chess-quest) games: a title/score header,
// an optional status line, the game's own board/content, and an optional
// footer row (New game, ShareResult, …). Chess Quest keeps its own,
// richer GameShell (coach bubble, answer chips, Rich HTML status) — this
// is a deliberately simpler, generic sibling for Daily Word and 2048, so it
// stays plain Tailwind with no dependency on chess-quest's `--cq-*` tokens.
export function GameFrame({
  title,
  score,
  status,
  footer,
  children,
}: {
  title: string;
  score?: React.ReactNode;
  status?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-3 px-4 py-4">
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="mk-display text-2xl font-bold text-slate-900">{title}</h2>
        {score ? <div className="text-sm font-medium text-slate-600">{score}</div> : null}
      </header>

      {status ? (
        <div className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
          {status}
        </div>
      ) : null}

      <div className="flex justify-center">{children}</div>

      {footer ? <div className="flex flex-wrap justify-center gap-2">{footer}</div> : null}
    </div>
  );
}
