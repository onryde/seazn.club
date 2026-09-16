"use client";
import { useEffect, useState } from "react";
import { EVENTS, track } from "@/lib/analytics";

/**
 * Pure helper (regression-tested in node env — no window/DOM needed): builds
 * the absolute share URL and the WhatsApp deep-link from an explicit origin.
 */
export function shareLinks(
  origin: string,
  path: string,
  title: string,
): { url: string; wa: string } {
  const url = `${origin}${path}`;
  const wa = `https://wa.me/?text=${encodeURIComponent(`${title} — ${url}`)}`;
  return { url, wa };
}

/**
 * Every word this row can say.
 *
 * ALL FIVE, deliberately — not a `Partial`, and not optional. A caller that can supply
 * four of these can supply the fifth, and a partial override is how one control
 * in a translated row stays in English with nothing red to say so: the `share`
 * label in particular renders only after mount on a device with
 * `navigator.share`, so a missed one is invisible to every server-rendered
 * test AND to a desktop reviewer.
 */
export interface ShareBarLabels {
  /** The native share-sheet button. Mobile only — see `canShare` below. */
  share: string;
  /** The WhatsApp link's visible text. */
  whatsapp: string;
  /** Its accessible name, which REPLACES that text for a screen reader — so it
   *  is a separate string, not a copy of it (a link list otherwise reads the
   *  same two words on every share row on the site). */
  whatsappAria: string;
  /** The copy button, before and after the click. */
  copy: string;
  copied: string;
}

// NO English defaults, deliberately. There used to be a `DEFAULT_LABELS`
// ("Copy link", "Copied ✓") for callers that passed nothing, and the org news
// post page passed nothing — so its share row was English in every locale, and
// "Copied ✓" existed in no dictionary at all. `labels` is REQUIRED now, so tsc
// refuses a caller that forgets. Public pages pass
// `shareLabels(dict)` (`components/public-site/share-labels.ts`).

/** Fan-facing share row (PLG L3): native share on mobile, WhatsApp + copy
 *  everywhere. Grassroots sport runs on WhatsApp. An optional `postShare` adds
 *  news-post context (SPEC-2): each share ALSO fires POST_SHARED{kind,channel}
 *  alongside the generic SHARE_FIRED — the component is reused, not forked. */
export function ShareBar({
  path,
  title,
  postShare,
  labels,
}: {
  path: string;
  title: string;
  postShare?: { kind: string };
  labels: ShareBarLabels;
}) {
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState(false);
  const [canShare, setCanShare] = useState(false);
  useEffect(() => {
    setOrigin(window.location.origin);
    setCanShare(typeof navigator !== "undefined" && "share" in navigator);
  }, []);
  const { url, wa } = shareLinks(origin, path, title);

  function fire(channel: string) {
    track(EVENTS.SHARE_FIRED, { channel });
    if (postShare) track(EVENTS.POST_SHARED, { channel, kind: postShare.kind });
  }

  async function native() {
    fire("native");
    try {
      await navigator.share?.({ title, url });
    } catch {
      /* dismissed */
    }
  }
  async function copy() {
    fire("copy");
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* blocked */
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {canShare && (
        <button
          type="button"
          onClick={native}
          className="btn btn-ghost min-h-11"
          data-testid="native-share"
        >
          {labels.share}
        </button>
      )}
      <a
        href={wa}
        target="_blank"
        rel="noreferrer"
        onClick={() => fire("whatsapp")}
        className="btn btn-ghost min-h-11"
        aria-label={labels.whatsappAria}
      >
        {labels.whatsapp}
      </a>
      <button type="button" onClick={copy} className="btn btn-ghost min-h-11">
        {copied ? labels.copied : labels.copy}
      </button>
    </div>
  );
}
