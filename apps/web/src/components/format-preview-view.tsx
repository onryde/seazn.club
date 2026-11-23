// Renders the engine's format preview (previewDivisionFixtures output) —
// "here is exactly what you get" (v3/06 §4). Shared by the /help/formats/<family>
// pages and the picker's How-this-works panel.
//
// `level` is the heading level of each phase title, and it is the CALLER's to say:
// the two consumers sit at different depths (the help page's "What you get" is an h2,
// so its titles are h3; the panel's "Live example" is an h3, so its titles are h4),
// and a title that skips a level fails axe's `heading-order`. Required, so a third
// consumer has to choose one instead of inheriting a level that is wrong for it.
import type { PreviewPhase } from "@/server/usecases/stages";

export function FormatPreviewView({ phases, level }: { phases: PreviewPhase[]; level: 3 | 4 }) {
  const Title = level === 3 ? "h3" : "h4";
  return (
    <div className="space-y-5">
      {phases.map((phase, i) => (
        <section key={i} className="rounded-2xl border border-purple-100 bg-purple-50/30 p-4">
          <Title className="font-display text-sm font-semibold uppercase tracking-[0.14em] text-purple-800">
            {phase.title}
          </Title>
          {phase.note ? (
            <p className="mt-1.5 text-sm italic text-slate-600">{phase.note}</p>
          ) : null}
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            {phase.sections.map((section) => (
              <div key={section.title}>
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500">
                  {section.title}
                </p>
                <ul className="space-y-1">
                  {section.matches.map((m, j) => (
                    <li
                      key={j}
                      className="flex items-center gap-2 rounded-lg bg-white px-3 py-1.5 text-sm text-slate-700 shadow-sm"
                    >
                      <span className="min-w-0 flex-1 truncate text-right font-medium">
                        {m.home}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] uppercase text-purple-600">
                        vs
                      </span>
                      <span className="min-w-0 flex-1 truncate font-medium">{m.away}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
