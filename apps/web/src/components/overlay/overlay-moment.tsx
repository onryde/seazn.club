// The moment slab (stream overlay W2, `_THEMES.md` §5).
//
// Presentational and nothing else: it is handed a moment and a phase and paints
// them. The queue decides WHEN; the allowlist decided WHETHER; this decides
// only what it looks like.
//
// Every colour comes from the sport's own tokens — `--sport-led`,
// `--sport-caution`, `--sport-dismissal` and the derived dismissal ink — so a
// twelfth sport's palette carries the slab with it and no hex appears here.
import type { OverlayMoment } from "@/lib/overlay-moments";
import type { Phase } from "./moment-queue";

export function OverlayMomentSlab(props: {
  moment: OverlayMoment;
  phase: Phase;
  placement: "bar" | "bug";
}): React.ReactElement {
  const { moment, phase, placement } = props;
  return (
    <div
      data-testid="overlay-moment"
      data-kind={moment.kind}
      data-tone={moment.tone}
      data-phase={phase}
      data-seq={moment.seq}
      className={`ovl-slab ovl-slab--${placement} ovl-slab--${phase}`}
    >
      {/* A two-word headline ("MATCH POINT") drops a step and wraps, per §5.
          Measured by WORD COUNT rather than character length: "MATCH POINT"
          and "SECOND YELLOW" both need the smaller step, and they differ by
          two characters. */}
      <span
        className="ovl-slab__headline"
        data-long={moment.headline.trim().includes(" ") ? "" : undefined}
      >
        {moment.headline}
      </span>
      {moment.line === undefined ? null : <span className="ovl-slab__line">{moment.line}</span>}
    </div>
  );
}
