// The text half of one detail entry, shared by the bar and the bug — the twins rule (§4): a composition guard added to
// one is owed to the other in the same change. A plain function returning elements rather than a component, so the
// node harness that walks the bar's and the bug's trees (bug-footer-cap.test.tsx) still sees every box inside an entry.
//
// Review a (PR #974): a crease line is PEOPLE, each drawn as a NAME box that may ellipse, the striker's MARK, and a
// FIGURES box that may not. At the 30 px floor the one `${name} ${figures}` label cut the bowler's analysis to
// "0.3-0-…" while the name stayed whole; the boxes and their CSS (globals.css, `.ovl-detail-person`) make the name the
// thing that yields. The spaces between the boxes are real text, so the entry still READS as its line ("Iyer* 0 (0) ·
// Sharma 1 (1)") to anything that reads text; in a grid or flex box a whitespace-only run draws nothing, and the gaps
// come from the stylesheet.
import { Fragment, type ReactElement } from "react";
import type { OverlayDetailLine } from "@/lib/overlay-model";
import { OverlayBallGlyphs } from "./overlay-ball-glyphs";

const hasPeople = (line: OverlayDetailLine): boolean => (line.people?.length ?? 0) > 0;

/** An entry holding figures keeps its content minimum — its figures — where a label entry's is zero (globals.css). */
export function detailEntryClass(line: OverlayDetailLine): string {
  return hasPeople(line) ? "ovl-detail-entry ovl-detail-entry--figures" : "ovl-detail-entry";
}

export function detailCopy(line: OverlayDetailLine): ReactElement {
  const people = line.people ?? [];
  return (
    <span className="ovl-detail-copy">
      {people.length > 0 ? (
        <span className="ovl-detail-people">
          {people.map((p, i) => (
            <Fragment key={`${p.name}-${i}`}>
              {i > 0 ? (
                <>
                  {" "}
                  <span className="ovl-detail-joint">·</span>{" "}
                </>
              ) : null}
              <span className="ovl-detail-person">
                {/* The striker's mark LEADS the name (confirm pass, PR #974), the pad's own on-strike treatment:
                    after it, the mark drifted toward the figures ("Fuji… * 31", the not-out "31*") and could never
                    hug an ellipsis. One box for both, so the mark sits at the name's start edge. */}
                <span className="ovl-detail-who">
                  {p.mark ? <span className="ovl-detail-mark">{p.mark}</span> : null}
                  <span className="ovl-detail-name">{p.name}</span>
                </span>{" "}
                <span className="ovl-detail-figures">{p.figures}</span>
              </span>
            </Fragment>
          ))}
        </span>
      ) : line.text ? (
        // `.ovl-detail-label` carries §4's ellipsis (globals.css): a REAL box round the text, because
        // `text-overflow` paints only on a block container whose own inline content overflows.
        <span className="ovl-detail-label">{line.text}</span>
      ) : null}
      {line.glyphs && line.glyphs.length > 0 ? <OverlayBallGlyphs glyphs={line.glyphs} /> : null}
    </span>
  );
}
