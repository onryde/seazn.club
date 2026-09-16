"use client";

// The `Poster` button the design board draws beside `Share` on the match
// centre (Spectator Surface Boards §match-centre header, §poster). It links
// straight at the fixture's `poster.png` — a stable route, not a hashed asset —
// so the browser's own download does the work and no canvas, blob or client
// renderer is involved.
//
// A plain <a download>, deliberately: the file is 1080×1350 and cut on the
// server, so the phone gets a real image in its downloads to post from,
// which is the whole point of the free-tier share loop.
import { Download } from "lucide-react";
import { track, EVENTS } from "@/lib/analytics";
import { useMsg } from "@/components/i18n/dict-provider";

export function PosterButton({
  href,
  fileName,
  variant,
  className = "",
}: {
  href: string;
  /** What the saved file is called. BOTH ends say it: this attribute, and the
   *  route's own `Content-Disposition`. The route path already ends in
   *  `poster.png`, which looks like it settles the question and does not —
   *  a download arriving with no extension is a file nothing will open. */
  fileName: string;
  /** upcoming | live | result — reported so the download funnel splits by
   *  the state the spectator was actually looking at. */
  variant: string;
  className?: string;
}) {
  const msg = useMsg();
  return (
    <a
      href={href}
      download={fileName}
      data-testid="match-poster-download"
      aria-label={msg("matchPoster.downloadAria")}
      onClick={() => track(EVENTS.MATCH_POSTER_DOWNLOADED, { variant })}
      className={
        className ||
        // Same shape as ShareButton beside it, including the 44px tap floor.
        "inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-zinc-200/80 bg-surface px-3 py-1.5 text-sm font-medium text-accent-strong shadow-sm transition hover:bg-accent-soft"
      }
    >
      <Download className="h-4 w-4" strokeWidth={1.75} />
      {msg("matchPoster.download")}
    </a>
  );
}
