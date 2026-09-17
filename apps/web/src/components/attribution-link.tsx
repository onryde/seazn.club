"use client";
import { EVENTS, track } from "@/lib/analytics";

const START = "https://seazn.club/start";

/** Free-tier attribution turned into an acquisition CTA (PLG L1). Renders the
 *  brand line + a tracked "Run your own free →" link back to /start.
 *
 *  `label` is REQUIRED and has no English default, like `ShareBar`'s labels:
 *  this link sat in the footer of every /shared page as English in all four
 *  locales, because the component owned its words. The caller passes
 *  `layout.attribution` in the page's language; the arrow is a glyph and stays
 *  out of the dictionary. */
export function AttributionLink({ surface, label }: { surface: "badge" | "embed"; label: string }) {
  const href = `${START}?utm_source=${surface}&utm_medium=attribution&utm_campaign=plg`;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={() => track(EVENTS.ATTRIBUTION_CLICKED, { surface })}
      className="font-medium underline hover:opacity-80"
    >
      {`${label} →`}
    </a>
  );
}
