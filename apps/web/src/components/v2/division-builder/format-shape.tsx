// The format picker's shape diagrams (Match Day C9, owner 2026-11-02: "a visual picker with shape diagrams and match
// counts"). One small line drawing per STAGE KIND, read off the template's own stage graph, so a template is drawn as
// what it builds (a league, then a knockout) and a new template needs no drawing of its own. Decorative: the card's
// words say the same thing, so the drawing is hidden from assistive technology.
import type { StageDraft } from "@/lib/format-templates";

const W = 44;
const H = 28;

function Glyph({ kind }: { kind: string }) {
  const dot = (x: number, y: number, k: string) => <circle key={k} cx={x} cy={y} r={2.2} className="fill-current stroke-none" />;
  switch (kind) {
    case "league": {
      // Everyone plays everyone: four entrants, every pair joined.
      const p: [number, number][] = [[10, 5], [34, 5], [34, 23], [10, 23]];
      const lines = p.flatMap((a, i) => p.slice(i + 1).map((b, j) => <line key={`${i}-${j}`} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} />));
      return <>{lines}{p.map(([x, y], i) => dot(x, y, `d${i}`))}</>;
    }
    case "group": {
      // Two pools, each a small round robin.
      const tri = (ox: number) => [[ox + 8, 5], [ox + 15, 22], [ox + 1, 22]] as [number, number][];
      return (
        <>
          {[2, 25].map((ox) => {
            const t = tri(ox);
            return (
              <g key={ox}>
                <polygon points={t.map((q) => q.join(",")).join(" ")} />
                {t.map(([x, y], i) => dot(x, y, `${ox}-${i}`))}
              </g>
            );
          })}
        </>
      );
    }
    case "knockout":
      // Four lines into two into one.
      return <path d="M4 4h10v8h10M4 12h10M4 16h10v8h10M4 24h10M24 8v12h14" />;
    case "double_elim":
      return (
        <>
          <path d="M4 3h9v6h9M4 9h9M22 6v9h18" />
          <path d="M4 19h9v6h9M4 25h9M22 22v-7" strokeDasharray="2 2" />
        </>
      );
    case "page_playoff":
      // The fixed four: 1 v 2 and 3 v 4, the loser of the first meets the winner of the second.
      return <path d="M4 4h10v7h10M4 11h10M4 17h10v7h10M4 24h10M24 11v13M24 17h8v-6h8" />;
    case "stepladder":
      return <path d="M4 25h9v-7h9v-7h9v-7h9" />;
    case "swiss":
      // Rounds of pairings, nobody out.
      return (
        <>
          {[5, 14, 23].map((y) => (
            <g key={y}>
              <line x1={8} y1={y} x2={18} y2={y} />
              <line x1={26} y1={y} x2={36} y2={y} />
              {dot(8, y, `a${y}`)}
              {dot(18, y, `b${y}`)}
              {dot(26, y, `c${y}`)}
              {dot(36, y, `e${y}`)}
            </g>
          ))}
        </>
      );
    case "americano":
      // Partners rotate: two pairs and the arrows that swap them.
      return (
        <>
          <line x1={8} y1={7} x2={8} y2={21} />
          <line x1={36} y1={7} x2={36} y2={21} />
          {dot(8, 7, "a")}
          {dot(8, 21, "b")}
          {dot(36, 7, "c")}
          {dot(36, 21, "d")}
          <path d="M14 9q8-6 16 0M30 19q-8 6-16 0" />
        </>
      );
    case "ladder":
      return <path d="M14 3v22M30 3v22M14 7h16M14 13h16M14 19h16" />;
    default:
      return <rect x={6} y={6} width={32} height={16} rx={3} />;
  }
}

/** The template's stages drawn left to right, joined by a chevron. */
export function FormatShape({ stages, className = "" }: { stages: readonly Pick<StageDraft, "kind">[]; className?: string }) {
  return (
    <span aria-hidden="true" className={`inline-flex items-center gap-1 ${className}`} data-format-shape={stages.map((s) => s.kind).join("+")}>
      {stages.map((s, i) => (
        <span key={i} className="inline-flex items-center gap-1">
          {i > 0 && (
            <svg viewBox="0 0 8 12" width={8} height={12} className="stroke-current" fill="none" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 2l4 4-4 4" />
            </svg>
          )}
          <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="stroke-current" fill="none" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
            <Glyph kind={s.kind} />
          </svg>
        </span>
      ))}
    </span>
  );
}
